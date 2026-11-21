// A paid order's downloads (digital products, migrations/0086) — on the shop's own address, no sign-in: the link is the
// key. /api/download?o=<orderId>&t=<token> (http.js downloadToken: an HMAC of the order id and its salt).
//
//   GET ?o&t        the order's download page: each file, its size and what's left of its limits. Before the order is
//                   paid (a card payment Stripe hasn't confirmed yet) it says so and checks again by itself. Opening it
//                   also makes sure the files are granted and emailed (digital.js deliverOrderDownloads), in case a
//                   webhook was missed.
//   GET ?o&t&f=<id> one file: counted (db.js recordDownload, atomically), then served from the private DESIGNS bucket
//                   as an attachment. Refused once revoked, expired or used up. A HEAD isn't counted, nor is a resumed
//                   download (a Range that doesn't start at 0, from a network that counted one of this file in the
//                   last day); any other Range is counted like a full download.
// Nothing here is cached or indexed. Rate-limited per network, like checkout.

import { verifyDownloadToken, featureIsOff } from "../_lib/http.js";
import { listDownloadGrants, grantBlocked, recordDownload, getOrderById, getOrgById } from "../_lib/db.js";
import { deliverOrderDownloads } from "../_lib/digital.js";
import { rateLimited } from "../_lib/rateLimit.js";

const ORDER_ID_RE = /^[A-Za-z0-9\-]{1,64}$/;
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const size = (b) => b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round((b || 0) / 1024)) + " KB";
const day = (iso) => new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
const HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };

// The page's one script (the file list only), allowed by a nonce: a Download button greys out at once ("Downloading…") and
// the page reloads a moment later, so what's left is shown as soon as the download has started — the file itself comes
// as an attachment, which leaves the page as it was. Without it a used-up button stayed live, and every click looked like
// another download. The buttons have no `download` attribute: a refusal ("All downloads used") is a page the browser
// then shows, instead of saving it as the file.
const RELOAD_SCRIPT = `document.querySelectorAll("a.btn").forEach(function(a){a.addEventListener("click",function(e){
if(a.dataset.busy){e.preventDefault();return}a.dataset.busy="1";a.textContent="Downloading\u2026";a.style.opacity=".6";a.style.cursor="default";
setTimeout(function(){location.reload()},2500)})});`;
function page(title, body, { status = 200, refresh = 0, script = "" } = {}) {
  const nonce = script ? Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("") : "";
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ""}<title>${esc(title)}</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#111;background:#fafafa}
h1{font-size:22px}table{border-collapse:collapse;width:100%;background:#fff;border:1px solid #e5e7eb;border-radius:8px}
td,th{padding:10px;border-bottom:1px solid #eee;text-align:left;font-size:14px}a.btn{background:#15803d;color:#fff;padding:7px 14px;border-radius:6px;text-decoration:none;white-space:nowrap}
.muted{color:#666;font-size:13px}.off{color:#b03a2e;font-size:13px}</style></head><body>${body}${script ? `<script nonce="${nonce}">${script}</script>` : ""}</body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline';${script ? ` script-src 'nonce-${nonce}';` : ""} base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, ...HEADERS } });
}
const notFound = () => page("Link not found", `<h1>This download link doesn't work</h1><p>Check you used the whole link from your email. If it still doesn't work, reply to that email and the shop will send a new one.</p>`, { status: 404 });

// How long after a counted download the same network may resume it (a Range past byte 0) without counting again.
const RESUME_WINDOW_MS = 24 * 60 * 60 * 1000;
function networkOf_(request) {
  const ip = String((request.headers && request.headers.get && request.headers.get("CF-Connecting-IP")) || "");
  if (ip.includes(".")) return ip.split(".").slice(0, 3).join(".") + ".0/24";
  if (ip.includes(":")) return ip.split(":").slice(0, 4).join(":") + "::/64";
  return "";
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const orderId = url.searchParams.get("o") || "", token = url.searchParams.get("t") || "", fileId = url.searchParams.get("f");
  if (!ORDER_ID_RE.test(orderId) || !/^[0-9a-f]{64}$/.test(token)) return notFound();
  const rl = await rateLimited(env, "download", request, 60);
  if (rl.blocked) return page("Too many requests", `<h1>Too many requests</h1><p>Wait a minute and try again.</p>`, { status: 429 });
  if (await featureIsOff(env, "digital")) return page("Not available", `<h1>Downloads aren't available right now</h1><p>Reply to your order email and the shop will help.</p>`, { status: 403 });
  const row = await env.DB.prepare("SELECT orderId, orgId, downloadSalt, paid, voidedAt FROM orders WHERE orderId = ?").bind(orderId).first().catch(() => null);
  if (!row || !row.downloadSalt || !(await verifyDownloadToken(env, orderId, row.downloadSalt, token))) return notFound();
  const org = await getOrgById(env.DB, row.orgId).catch(() => null);
  const shop = (org && org.name) || "the shop";

  if (fileId == null) {
    // The page. Granting (and the email, the first time) happens here too: Stripe's webhook may not have arrived yet.
    const d = row.voidedAt ? { status: "none", grants: [] } : await deliverOrderDownloads(env, orderId, { origin: url.origin }).catch((e) => { console.error("Download delivery failed for", orderId, e); return { status: "error", grants: [] }; });
    if (row.voidedAt) return page("Order cancelled", `<h1>This order was cancelled</h1><p>Its downloads aren't available. Reply to your order email with any questions.</p>`, { status: 410 });
    if (d.status === "unpaid") return page("Waiting for payment", `<h1>Almost there</h1><p>Your files will be here as soon as your payment for order <b>${esc(orderId)}</b> is confirmed. This page checks again every few seconds.</p><p class="muted">Paying by Venmo, Zelle or check? The link works once ${esc(shop)} records your payment, and it's emailed to you then.</p>`, { refresh: 5 });
    const grants = (d.grants && d.grants.length ? d.grants : await listDownloadGrants(env.DB, orderId)).filter(g => g.fileKey);
    if (!grants.length) return page("No files", `<h1>No files on this order</h1><p>Reply to your order email and ${esc(shop)} will help.</p>`);
    const base = `${url.pathname}?o=${encodeURIComponent(orderId)}&t=${token}`;
    const why = { revoked: "No longer available", expired: "This link has expired", used: "All downloads used" };
    const rows = grants.map(g => {
      const blocked = grantBlocked(g);
      const left = [g.maxDownloads != null ? `${Math.max(0, g.maxDownloads - g.downloads)} of ${g.maxDownloads} downloads left` : "", g.expiresAt ? `until ${day(g.expiresAt)}` : ""].filter(Boolean).join(", ");
      return `<tr><td><b>${esc(g.fileName || "File")}</b><div class="muted">${esc(size(g.bytes))}${left ? " · " + esc(left) : ""}</div></td>
        <td style="text-align:right">${blocked ? `<span class="off">${esc(why[blocked])}</span>` : `<a class="btn" href="${esc(base + "&f=" + g.id)}">Download</a>`}</td></tr>`;
    }).join("");
    return page(`Your downloads — ${orderId}`, `<h1>Your downloads</h1><p>Order <b>${esc(orderId)}</b> from ${esc(shop)}.</p><table>${rows}</table>
      <p class="muted">Save the files somewhere safe. If a link runs out, reply to your order email and ${esc(shop)} can send a new one.</p>`, { script: RELOAD_SCRIPT });
  }

  // One file.
  const grants = await listDownloadGrants(env.DB, orderId);
  const g = grants.find(x => String(x.id) === String(fileId));
  if (!g || !row.paid || row.voidedAt) return notFound();
  const blocked = grantBlocked(g);
  if (blocked) return page("Not available", `<h1>${blocked === "expired" ? "This link has expired" : blocked === "used" ? "All downloads used" : "No longer available"}</h1><p>Reply to your order email and ${esc(shop)} can send a new link.</p>`, { status: 410 });
  if (!env.DESIGNS || typeof env.DESIGNS.get !== "function") return page("Not available", `<h1>The file can't be reached right now</h1><p>Try again later.</p>`, { status: 503 });
  const range = request.headers && request.headers.get && request.headers.get("Range");
  const head = request.method === "HEAD";
  // A Range that doesn't start at 0 is free only as a resume: this network counted a download of this file in the
  // last day. Otherwise it is counted like any other, so asking for "the rest" can't get around the limit.
  let resumed = false;
  if (range && !head && !/^bytes=0-/.test(range)) {
    const since = new Date(Date.now() - RESUME_WINDOW_MS).toISOString();
    const recent = await env.DB.prepare("SELECT 1 AS hit FROM download_log WHERE grantId = ? AND network = ? AND at > ? LIMIT 1")
      .bind(Number(g.id), networkOf_(request), since).first().catch(() => null);
    resumed = !!recent;
  }
  const obj = await env.DESIGNS.get(g.fileKey, range && !head ? { range: request.headers } : undefined).catch(() => null);
  if (!obj) return page("Not available", `<h1>This file is missing</h1><p>Reply to your order email and ${esc(shop)} will sort it out.</p>`, { status: 404 });
  if (!head && !resumed) {
    const ok = await recordDownload(env.DB, g.id, { network: networkOf_(request), userAgent: (request.headers && request.headers.get && request.headers.get("User-Agent")) || "" });
    if (!ok) return page("Not available", `<h1>All downloads used</h1><p>Reply to your order email and ${esc(shop)} can send a new link.</p>`, { status: 410 });
  }
  const name = String(g.fileName || ("file." + (g.fileExt || "bin"))).replace(/["\r\n\\]/g, "_");
  const headers = { ...HEADERS, "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${name}"`, "Accept-Ranges": "bytes" };
  if (obj.size != null) headers["Content-Length"] = String(obj.range && obj.range.length != null ? obj.range.length : obj.size);
  return new Response(head ? null : obj.body, { status: range && obj.range ? 206 : 200, headers });
}
