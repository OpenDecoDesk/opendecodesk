/**
 * Unsubscribing from marketing email (email campaigns, migrations/0117) — no sign-in.
 * GET  /api/unsubscribe?e=EMAIL&t=TOKEN  → a small page with one button (a link opened by a mail scanner changes nothing)
 * POST /api/unsubscribe  (form: e, t)     → the address goes on the no-marketing list; the page says so
 * A mail program's one-click unsubscribe (List-Unsubscribe-Post) is a POST too, and gets the same answer.
 * The token is an HMAC of the address (http.js unsubscribeToken): only a link from one of our emails works, and it only
 * ever turns marketing email off for that one address. Order emails (receipts, invoices, shipping) keep coming.
 */
import { getBusinessProfile } from "../_lib/db.js";
import { verifyUnsubscribeToken } from "../_lib/http.js";
import { setMarketingChoice } from "../_lib/campaigns.js";

const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function page(title, body, status = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title></head>
<body style="margin:0;background:#F6F3EC;font-family:Helvetica,Arial,sans-serif;color:#232323;">
<div style="max-width:440px;margin:60px auto;padding:28px;background:#fff;border:1px solid #DED8C8;border-radius:4px;">
<h1 style="font-family:Georgia,serif;font-weight:400;font-size:24px;margin:0 0 12px;">${esc(title)}</h1>${body}</div></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" } });
}
const BAD = () => page("This link doesn't work", `<p style="line-height:1.5;">The unsubscribe link is incomplete or changed. Reply to the email you got and ask to stop, and we'll take you off the list.</p>`, 400);
async function businessName_(env) { try { return ((await getBusinessProfile(env.DB)) || {}).name || "us"; } catch (e) { return "us"; } }

export async function onRequestGet({ request, env }) {
  const u = new URL(request.url);
  const email = String(u.searchParams.get("e") || "").trim().toLowerCase(), token = String(u.searchParams.get("t") || "");
  if (!env.DB || !email || !(await verifyUnsubscribeToken(env, email, token))) return BAD();
  const name = await businessName_(env);
  return page("Unsubscribe", `<p style="line-height:1.5;">Stop shop news and discounts from ${esc(name)} to <b>${esc(email)}</b>? You'll still get emails about your own orders.</p>
<form method="post" action="/api/unsubscribe"><input type="hidden" name="e" value="${esc(email)}"><input type="hidden" name="t" value="${esc(token)}">
<button type="submit" style="font-size:14px;padding:10px 22px;background:#1E7A4C;color:#fff;border:0;border-radius:2px;cursor:pointer;">Unsubscribe</button></form>`);
}

export async function onRequestPost({ request, env }) {
  let email = "", token = "";
  try {
    const u = new URL(request.url);
    const form = await request.formData().catch(() => null);
    email = String((form && form.get("e")) || u.searchParams.get("e") || "").trim().toLowerCase();
    token = String((form && form.get("t")) || u.searchParams.get("t") || "");
  } catch (e) { return BAD(); }
  if (!env.DB || !email || !(await verifyUnsubscribeToken(env, email, token))) return BAD();
  const r = await setMarketingChoice(env.DB, email, false, "unsubscribe");
  if (!r.ok) return page("Something went wrong", `<p style="line-height:1.5;">We couldn't record that just now. Try again in a minute, or reply to the email and ask to stop.</p>`, 503);
  const name = await businessName_(env);
  return page("You're unsubscribed", `<p style="line-height:1.5;"><b>${esc(email)}</b> won't get shop news and discounts from ${esc(name)} any more. You'll still get emails about your own orders.</p>`);
}
