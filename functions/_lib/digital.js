// Digital products (migrations/0086): delivering a paid order's files.
//
// deliverOrderDownloads(env, orderId) is called wherever an order may just have become paid — the Stripe webhook, Mark
// paid, Add payment — and from the download page itself. It grants the files (db.js grantOrderDownloads: once per line
// and file, with the limits as they are now) and, the first time, emails the order's download link with the files
// attached when they fit (sendDownloadsEmail). Safe to call any number of times.
//
// downloadLink(env, order) is the order's page, /api/download?o=<orderId>&t=<token> on the shop's own address.

import { grantOrderDownloads, orderDigitalLines, orderDownloadSalt, getDigitalSettings, getDownloadsEmailedAt, setDownloadsEmailedAt, getOrderById, getOrgById } from "./db.js";
import { downloadToken } from "./http.js";
import { rootDomain } from "./hostConfig.js";
import { sendDownloadsEmail } from "./email.js";

// The shop's own address (as invoices use), else `fallbackOrigin` (the request's).
async function shopOrigin_(env, orgId, fallbackOrigin) {
  try {
    const org = await getOrgById(env.DB, orgId);
    if (org && org.subdomain) return `https://${org.subdomain}.${rootDomain(env)}`;
  } catch (e) { /* fall back */ }
  return fallbackOrigin || `https://${rootDomain(env)}`;
}

export async function downloadLink(env, orderId, orgId, { fresh = false, origin = "" } = {}) {
  const salt = await orderDownloadSalt(env.DB, orderId, { fresh });
  const token = await downloadToken(env, orderId, salt);
  if (!token) return "";
  return `${await shopOrigin_(env, orgId, origin)}/api/download?o=${encodeURIComponent(orderId)}&t=${token}`;
}

const b64_ = (buf) => { const u = new Uint8Array(buf); let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
const ATTACH_TYPES_ = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg" };

// The files to attach, or { tooBig } when they don't all fit (all or none: a customer shouldn't get half of them by
// email). Each file once, however many lines carry it.
async function attachmentsFor_(env, grants, capBytes) {
  const seen = new Map();
  for (const g of grants) if (!g.revokedAt && !seen.has(g.fileKey)) seen.set(g.fileKey, g);
  const files = [...seen.values()];
  const total = files.reduce((n, g) => n + (g.bytes || 0), 0);
  if (!files.length) return { attachments: [] };
  if (total > capBytes || files.length > 5) return { attachments: [], tooBig: true };
  if (!env.DESIGNS || typeof env.DESIGNS.get !== "function") return { attachments: [] };
  const attachments = [];
  for (const g of files) {
    const obj = await env.DESIGNS.get(g.fileKey).catch(() => null);
    if (!obj) return { attachments: [] };   // a missing file: the link still works for the rest
    const buf = await obj.arrayBuffer();
    if (buf.byteLength > capBytes) return { attachments: [], tooBig: true };
    attachments.push({ filename: g.fileName || ("file." + (g.fileExt || "bin")), contentType: ATTACH_TYPES_[g.fileExt] || "application/octet-stream", contentBase64: b64_(buf) });
  }
  return { attachments };
}

// { status: "none" | "unpaid" | "granted" | "emailed" | "notEmailed", link, grants }. `resend`: email again with a
// new link (the old one stops working), whatever was sent before.
export async function deliverOrderDownloads(env, orderId, { resend = false, origin = "", now = new Date() } = {}) {
  const lines = await orderDigitalLines(env.DB, orderId);
  if (!lines.length) return { status: "none", grants: [] };
  const g = await grantOrderDownloads(env.DB, orderId, { now });
  if (!g.paid) return { status: "unpaid", grants: g.grants };
  const live = g.grants.filter(x => !x.revokedAt);
  if (!live.length) return { status: "none", grants: g.grants };
  const global = await getDigitalSettings(env.DB);
  const wantsEmail = lines.some(l => ({ ...global, ...l.digitalDelivery }).email !== false);
  if (!resend && (!wantsEmail || await getDownloadsEmailedAt(env.DB, orderId))) return { status: "granted", grants: g.grants };
  const order = await getOrderById(env.DB, orderId);
  if (!order || !order.contact || !String(order.contact).includes("@")) return { status: "notEmailed", grants: g.grants };
  const link = await downloadLink(env, orderId, order.orgId, { fresh: resend, origin });
  // Attach only when every line allows it, within the smallest cap any line sets.
  const attachOk = lines.every(l => ({ ...global, ...l.digitalDelivery }).attach !== false);
  const capMb = Math.min(...lines.map(l => Number(({ ...global, ...l.digitalDelivery }).attachMb) || global.attachMb));
  const att = attachOk ? await attachmentsFor_(env, live, capMb * 1048576) : { attachments: [] };
  const sent = await sendDownloadsEmail(env, order, { link, grants: live, attachments: att.attachments, tooBig: !!att.tooBig });
  if (sent) await setDownloadsEmailedAt(env.DB, orderId, now.toISOString());
  return { status: sent ? "emailed" : "notEmailed", link, grants: g.grants, attached: att.attachments.length, tooBig: !!att.tooBig };
}
