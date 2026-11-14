import { addOwnerNotice, recordSystemIssue, getBusinessProfile, resolveTimeZone, getLocaleSettings, getGlobalSettings, getOrgById, getEmailSettings, getEmailMailbox, splitTaxInclusive } from "./db.js";
import { pdfDocument, pdfWrap, pdfTextWidth, pdfBase64 } from "./pdf.js";
import { smtpSend } from "./smtp.js";
import { decryptVendorCredentials } from "./vendorCredentials.js";

/**
 * Transactional email, sent through Cloudflare Email Service. Sends from EMAIL_FROM (default
 * orders@<root domain>) under the business's name, with reply-to the owner's inbox, and BCCs a
 * receipts inbox when one is set (EMAIL_BCC, or Business profile → Receipts inbox) so there's a copy
 * of everything sent. Who the business is comes from the Business profile setting (db.js).
 * An install on the free Workers plan (no Cloudflare email) can send through Resend instead: set
 * RESEND_API_KEY and that provider is used for everything (sendViaResend_). Or it can send through the
 * owner's own mailbox (SMTP — Global settings → Email → "Your own mailbox": sendViaSmtp_, smtp.js),
 * which then is used for everything instead of the hosted services. The desktop program
 * sends through the owner's own mailbox instead (SMTP, its MAILER binding: sendViaMailer_), once
 * email is set up there; until then it sends nothing (desktopEmail_). Cloudflare sending uses the `EMAIL` send_email binding if one is configured, otherwise the REST API
 * with CF_EMAIL_API_TOKEN (encrypted; a token with Email Sending permission only) + CF_ACCOUNT_ID.
 *
 * There is no second transport: a send that fails (not configured, API error, network, or the
 * customer's address permanently bouncing) returns false and is recorded as an `email_failed`
 * system issue, which the 6 AM roll-up and the Communications page report.
 *
 * All functions return true on success, false on failure — never throw.
 * Templates say who they are from / to with placeholders (OWNER_, BUSINESS_, SITE_ below); send_ —
 * the one place every email goes through — fills them in from the Business profile.
 */

// Placeholders, filled in by send_ (fillTemplate_): the owner's inbox, the business name, the site.
const ORDER_NOTIFICATION_EMAIL = "%%OWNER_EMAIL%%";
const BUSINESS_ = "%%BUSINESS%%";
const SITE_ = "%%SITE%%";
// The install's root domain and admin address (ROOT_DOMAIN / ADMIN_SUBDOMAIN — the same rule as
// hostConfig.js, repeated here so this file has no import beyond db.js).
const siteRoot_ = (env) => String((env && env.ROOT_DOMAIN) || "example.com").trim().toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
// The desktop program (EDITION=desktop, hostConfig.js) has no site and no admin address anyone else
// can open: its emails name neither, and carry no links back to it.
const isDesktop_ = (env) => String((env && env.EDITION) || "").trim().toLowerCase() === "desktop";
const adminSiteUrl_ = (env) => isDesktop_(env) ? "" : "https://" + (String((env && env.ADMIN_SUBDOMAIN) || "admin").split(",")[0].trim() || "admin") + "." + siteRoot_(env);
// The desktop program sends only once email is set up there (Global settings → Email: the owner's
// mailbox, the MAILER binding). "off" until then: nothing is sent, and nothing is recorded as a
// failure — no email is the desktop's normal state, not a problem.
const desktopEmail_ = (env) => !isDesktop_(env) ? "" : (env.MAILER && typeof env.MAILER.fetch === "function" ? "on" : "off");
// A cloud install's own mailbox (db.js getEmailMailbox), when Global settings → Email says to send
// through it; null when it sends through a hosted service. Once chosen it is used even while
// incomplete: a send then fails and says why, rather than quietly going out another way.
async function webMailbox_(env) {
  if (isDesktop_(env) || typeof getEmailMailbox !== "function") return null;
  try { const m = await getEmailMailbox(env && env.DB); return m && m.via === "mailbox" ? m : null; }
  catch (e) { return null; }
}

// Who this install is, for one message: the saved Business profile with its fallbacks.
//   owner inbox: the profile's, else OWNER_EMAIL, else owner@<root domain>
//   receipts BCC: EMAIL_BCC, else the profile's (none by default)
async function mailIdentity_(env) {
  let p = {};
  try { p = (await getBusinessProfile(env && env.DB)) || {}; } catch (e) { p = {}; }
  const site = isDesktop_(env) ? "" : siteRoot_(env);
  return { name: p.name || "Our shop", site, profile: p, env,
    owner: p.ownerEmail || String((env && env.OWNER_EMAIL) || "").trim() || (site ? "owner@" + site : String((env && env.EMAIL_FROM) || "").trim()),
    bcc: String((env && env.EMAIL_BCC) || "").trim() || p.receiptsEmail || "" };
}
function fillTemplate_(msg, id) {
  // No site (the desktop program): "Business — site" footers end at the business's name.
  const noSite = (v) => id.site ? v : v.split(" — %%SITE%%").join("").split(", %%SITE%%").join("");
  // Customer emails end with who you are (%%FOOTER_HTML%% / %%FOOTER_TEXT%%): businessBlock_ from the Business profile.
  const biz = businessBlock_(id.profile || { name: id.name }, id.env);
  const footer = (v) => String(v).split("%%FOOTER_HTML%%").join(biz.html).split("%%FOOTER_TEXT%%").join(biz.text);
  const fill = (v, html) => v == null ? v : footer(noSite(String(v))).split("%%OWNER_EMAIL%%").join(id.owner).split("%%BUSINESS%%").join(html ? escHtml(id.name) : id.name).split("%%SITE%%").join(id.site);
  return { ...msg, to: fill(msg.to), subject: fill(msg.subject), html: fill(msg.html, true), text: fill(msg.text) };
}

// Owner notices don't email immediately: they're queued for the 6 AM daily
// roll-up (see sendDailyDigestEmail). Only if queueing fails (no DB binding,
// table not migrated, D1 error) is the notice emailed right away instead, so
// nothing is ever lost.
async function queueOwnerNotice_(env, notice, fallbackEmail) {
  if (env && env.DB) {
    try { await addOwnerNotice(env.DB, notice); return true; }
    catch (e) { console.error("Could not queue owner notice — emailing it now instead:", e); }
  }
  return send_(env, fallbackEmail);
}

async function send_(env, msg) {
  if (!msg || !msg.to) return false;
  if (desktopEmail_(env) === "off") return false;
  const id = await mailIdentity_(env);
  msg = fillTemplate_(msg, id);
  if (!String(msg.to).includes("@")) return false;
  // A non-production install can mark every subject (EMAIL_SUBJECT_TAG, e.g. "[TEST]") so its emails
  // can't be mistaken for the real site's when both send to the same inboxes. Unset by default.
  const tag = env && env.EMAIL_SUBJECT_TAG ? String(env.EMAIL_SUBJECT_TAG).trim().slice(0, 30) : "";
  if (tag && !String(msg.subject || "").startsWith(tag)) msg = { ...msg, subject: `${tag} ${msg.subject || ""}`.trim() };
  // One provider per install: the owner's mailbox in the desktop program; on a cloud install the
  // owner's mailbox when Global settings → Email says so, else Resend when RESEND_API_KEY is set,
  // otherwise Cloudflare Email Service. Never two — a failed send is a failure, not a reason to try
  // somewhere else.
  const mailbox = await webMailbox_(env);
  const via = desktopEmail_(env) === "on" ? "mailbox" : mailbox ? "smtp" : env && env.RESEND_API_KEY ? "resend" : "cloudflare";
  const r = via === "mailbox" ? await sendViaMailer_(env, msg, id) : via === "smtp" ? await sendViaSmtp_(env, msg, id, null, mailbox)
    : via === "resend" ? await sendViaResend_(env, msg, id) : await sendViaCloudflare_(env, msg, id);
  if (r === true) return true;
  if (r !== "bounced") console.error({ mailbox: "Mailbox (SMTP)", smtp: "Your mailbox (SMTP)", resend: "Resend", cloudflare: "Cloudflare Email Service" }[via] + " send failed for:", msg.subject);
  await recordSystemIssue(env && env.DB, "email_failed", msg.subject);
  return false;
}

// The desktop program's mailbox (desktop/mailer.js, over its MAILER binding): the program sends from
// the mailbox's own address (EMAIL_FROM) under the business's name. Returns true or false; `report`
// as for Resend, with the mail server's answer.
async function sendViaMailer_(env, { to, subject, html, text, attachments, pdf }, id, report) {
  const bcc = id.bcc && id.bcc.toLowerCase() !== String(to).trim().toLowerCase() ? [id.bcc] : [];
  try {
    const res = await env.MAILER.fetch("https://mailer.desktop.invalid/send", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to, fromName: id.name, replyTo: id.owner, bcc, subject, html: html || undefined, text: text || "(no plain-text body)",
        ...((attachments || []).length ? { attachments } : {}), ...(pdf ? { pdf } : {}) }),
    });
    const data = await res.json().catch(() => ({}));
    if (report) Object.assign(report, { httpStatus: res.status, providerMessage: String(data.message || "").slice(0, 500) });
    if (!res.ok || !data.ok) { console.error("Mailbox send failed:", String(data.message || res.status).slice(0, 300)); return false; }
    return true;
  } catch (e) {
    console.error("Mailbox send error:", e);
    if (report) report.providerMessage = "Couldn't reach the program's mail sender: " + String((e && e.message) || e).slice(0, 300);
    return false;
  }
}

// A cloud install's own mailbox (smtp.js): sent from the mailbox's own address under the business's
// name, reply-to the owner, BCC the receipts inbox. The password is decrypted here, only to sign in.
// Returns true or false; `report` as for Resend, with the mail server's answer.
async function sendViaSmtp_(env, { to, subject, html, text, attachments }, id, report, mailbox) {
  const m = mailbox || await webMailbox_(env);
  const fail = (why) => { console.error("Mailbox (SMTP) send failed:", why.slice(0, 300)); if (report) report.providerMessage = why.slice(0, 500); return false; };
  if (!m) return fail("No mailbox is set up.");
  let password = "";
  try { password = (m.password && (await decryptVendorCredentials(env, m.password) || {}).password) || ""; }
  catch (e) { return fail(String((e && e.message) || e).replace(/vendor login/g, "mailbox password")); }
  if (!password) return fail("The mailbox's password isn't saved. Enter it under Global settings → Email.");
  const bcc = id.bcc && id.bcc.toLowerCase() !== String(to).trim().toLowerCase() ? [id.bcc] : [];
  const r = await smtpSend(m, password, { to, fromName: id.name, replyTo: id.owner, bcc, subject, html, text, attachments: mailAttachments_(attachments) },
    { connect: env && env.__SMTP_CONNECT_FOR_TESTS });
  if (report) report.providerMessage = String(r.message || "").slice(0, 500);
  if (!r.ok) { console.error("Mailbox (SMTP) send failed:", String(r.message).slice(0, 300)); return false; }
  return true;
}

// Resend (https://resend.com) — an alternative for an install that can't use Cloudflare's email
// (it needs the paid Workers plan). Set RESEND_API_KEY and verify the sending domain with Resend;
// the sender is still EMAIL_FROM. Returns true (accepted) or false. Unlike Cloudflare's API, Resend
// reports a bounce later (by webhook), so a permanently bouncing address isn't detected here.
// `report` (optional, the test send on the Communications page): filled with what the provider said.
async function sendViaResend_(env, { to, subject, html, text, attachments }, id, report) {
  const from = String(env.EMAIL_FROM || ("orders@" + siteRoot_(env))).trim();
  const bcc = id.bcc && id.bcc.toLowerCase() !== String(to).trim().toLowerCase() ? [id.bcc] : [];
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${String(env.RESEND_API_KEY).trim()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `${String(id.name).replace(/[<>"\r\n]/g, "")} <${from}>`, to: [to], reply_to: id.owner,
        ...(bcc.length ? { bcc } : {}), subject, html: html || undefined, text: text || "(no plain-text body)",
        ...(mailAttachments_(attachments).length ? { attachments: mailAttachments_(attachments).map(x => ({ filename: x.filename, content: x.contentBase64, content_type: x.contentType })) } : {}),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (report) Object.assign(report, { httpStatus: res.status, providerId: data.id || "",
      providerMessage: String(data.message || data.error || (data.name ? data.name : "") || "").slice(0, 500), providerName: data.name || "" });
    if (!res.ok || !data.id) {
      console.error(`Resend HTTP ${res.status}:`, JSON.stringify(data).slice(0, 500));
      return false;
    }
    return true;
  } catch (e) {
    console.error("Resend error:", e);
    if (report) report.providerMessage = "Couldn't reach Resend: " + String((e && e.message) || e).slice(0, 300);
    return false;
  }
}

// Cloudflare Email Service. Returns true (sent), "bounced" (the recipient's address permanently
// bounced), or false (not configured / failed).
// Attachments as every provider gets them: [{ filename, contentType, contentBase64 }] — a PDF receipt, a
// design proof's pictures. Anything malformed is dropped rather than failing the email.
function mailAttachments_(list) {
  return (Array.isArray(list) ? list : []).filter(a => a && a.filename && a.contentBase64 && a.contentType)
    .map(a => ({ filename: String(a.filename).replace(/[^A-Za-z0-9 ._-]/g, "_").slice(0, 80), contentType: String(a.contentType), contentBase64: String(a.contentBase64), ...(a.cid ? { cid: String(a.cid) } : {}) }));
}
const b64ToBytes_ = (b64) => { const bin = atob(b64); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
async function sendViaCloudflare_(env, { to, subject, html, text, attachments }, id, report) {
  const from = String(env.EMAIL_FROM || ("orders@" + siteRoot_(env))).trim();
  const fromName = id.name;
  const bccAddr = id.bcc;
  // Mail already addressed TO the receipts inbox doesn't need a second, BCC'd copy.
  const bcc = bccAddr && bccAddr.toLowerCase() !== String(to).trim().toLowerCase() ? [bccAddr] : [];
  try {
    if (env.EMAIL && typeof env.EMAIL.send === "function") {
      const att = mailAttachments_(attachments);
      await env.EMAIL.send({
        to, from: { email: from, name: fromName }, replyTo: id.owner,
        ...(bcc.length ? { bcc } : {}), subject, html: html || undefined, text: text || "(no plain-text body)",
        ...(att.length ? { attachments: att.map(x => ({ content: b64ToBytes_(x.contentBase64).buffer, filename: x.filename, type: x.contentType,
          disposition: x.cid ? "inline" : "attachment", ...(x.cid ? { contentId: x.cid } : {}) })) } : {}),
      });
      return true;
    }
    if (!env.CF_EMAIL_API_TOKEN || !env.CF_ACCOUNT_ID) {
      console.error("Email is not configured: set an EMAIL binding, or CF_EMAIL_API_TOKEN + CF_ACCOUNT_ID");
      if (report) report.providerMessage = "No email provider is set up (no RESEND_API_KEY, no EMAIL binding, no CF_EMAIL_API_TOKEN + CF_ACCOUNT_ID).";
      return false;
    }
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CF_ACCOUNT_ID)}/email/sending/send`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${env.CF_EMAIL_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        to, from: { address: from, name: fromName }, reply_to: id.owner,
        ...(bcc.length ? { bcc } : {}), subject, html: html || undefined, text: text || "(no plain-text body)",
        ...(mailAttachments_(attachments).length ? { attachments: mailAttachments_(attachments).map(x => ({ content: x.contentBase64, filename: x.filename, type: x.contentType,
          disposition: x.cid ? "inline" : "attachment", ...(x.cid ? { content_id: x.cid } : {}) })) } : {}),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (report) Object.assign(report, { httpStatus: res.status,
      providerMessage: ((data.errors || []).map(e => (e.code ? e.code + ": " : "") + (e.message || "")).join("; ") || "").slice(0, 500) });
    if (!res.ok || !data.success) {
      console.error(`Cloudflare email HTTP ${res.status}:`, JSON.stringify(data.errors || data).slice(0, 500));
      return false;
    }
    const bounced = ((data.result && data.result.permanent_bounces) || []).map((a) => String(a).toLowerCase());
    if (bounced.includes(String(to).trim().toLowerCase())) {
      console.error("Cloudflare email: recipient permanently bounced:", to);
      return "bounced";
    }
    return true;
  } catch (e) {
    console.error("Cloudflare email error:", e);
    if (report) report.providerMessage = "Couldn't send through Cloudflare: " + String((e && e.message) || e).slice(0, 300);
    return false;
  }
}

// ---- The test send (Tools → Communications → Send a test email) ---------------------------------
// One short message to `to`, through exactly the path every other email takes, and a report of what
// happened that someone can act on: which provider, from which address, what it answered, and — for
// the usual mistakes — what to do. Never records an email_failed issue (it's a deliberate test).
// Secrets are never returned: a key is described (set or not, its length, whether it looks right).
export async function sendTestEmail(env, to) {
  const id = await mailIdentity_(env);
  const desktop = desktopEmail_(env);
  const mailbox = await webMailbox_(env);
  const from = mailbox && mailbox.from ? mailbox.from : String((env && env.EMAIL_FROM) || ("orders@" + siteRoot_(env))).trim();
  const key = !desktop && !mailbox && env && env.RESEND_API_KEY != null ? String(env.RESEND_API_KEY) : "";
  const provider = desktop === "on" ? "mailbox" : desktop === "off" ? "none" : mailbox ? "smtp" : key ? "resend" : (env && env.EMAIL && typeof env.EMAIL.send === "function") ? "cloudflare-binding"
    : (env && env.CF_EMAIL_API_TOKEN && env.CF_ACCOUNT_ID) ? "cloudflare-api" : "none";
  const report = { provider, from, fromDomain: from.split("@")[1] || "", to: String(to || ""), replyTo: id.owner, bcc: id.bcc || "",
    businessName: id.name, rootDomain: siteRoot_(env), subjectTag: env && env.EMAIL_SUBJECT_TAG ? String(env.EMAIL_SUBJECT_TAG).trim() : "",
    key: key ? { length: key.trim().length, looksLikeResend: /^re_[A-Za-z0-9_]+$/.test(key.trim()), spaceInside: /\s/.test(key.trim()), paddedEnds: key !== key.trim() } : null,
    httpStatus: null, providerMessage: "", providerId: "", ok: false, hints: [] };
  const hint = (t) => report.hints.push(t);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(report.to)) { hint("Enter an email address to send the test to."); return report; }
  if (report.fromDomain === "example.com" && !desktop && !mailbox) hint("ROOT_DOMAIN isn't set, so emails would come from an example.com address. Set ROOT_DOMAIN (or EMAIL_FROM) to your own domain.");
  if (key && report.key.spaceInside) hint("RESEND_API_KEY has a space or line break in the middle — copy it again (wrangler secret put RESEND_API_KEY) and redeploy.");
  else if (key && report.key.paddedEnds) hint("RESEND_API_KEY was saved with a space or line break at the end. Emails now ignore it, but it's worth setting the key again cleanly.");
  else if (key && !report.key.looksLikeResend) hint("RESEND_API_KEY doesn't look like a Resend key (they start with re_). Check you pasted the API key itself.");
  if (provider === "none") { hint(desktop ? "Email isn't set up. Add your mailbox under Global settings → Email." : "No email provider is set up. Set RESEND_API_KEY (a secret), or Cloudflare Email Service — see docs/email.md."); return report; }
  const tag = report.subjectTag;
  const where = desktop ? "the OpenDecoDesk program" : report.rootDomain;
  const msg = { to: report.to, subject: (tag ? tag + " " : "") + "Test email from " + id.name,
    html: `<div style="font-family:sans-serif"><p>This is a test email from <strong>${escHtml(id.name)}</strong> (${escHtml(where)}), sent from Tools → Communications.</p><p>If you can read this, email is working.</p></div>`,
    text: `This is a test email from ${id.name} (${where}), sent from Tools → Communications.\n\nIf you can read this, email is working.` };
  const r = provider === "mailbox" ? await sendViaMailer_(env, msg, id, report) : provider === "smtp" ? await sendViaSmtp_(env, msg, id, report, mailbox) : provider === "resend" ? await sendViaResend_(env, msg, id, report) : await sendViaCloudflare_(env, msg, id, report);
  report.ok = r === true;
  if (r === "bounced") hint("That address permanently bounced — try another one.");
  if (!report.ok && provider === "resend") {
    const m = report.providerMessage.toLowerCase(), st = report.httpStatus;
    if (st === 401 || (st === 403 && /api key/.test(m))) hint("Resend refused the API key. Make a new key in Resend (API Keys, with sending access), set it again with wrangler secret put RESEND_API_KEY, and redeploy.");
    if (/domain/.test(m) && /verif|not.*(found|added)/.test(m)) hint(`Resend hasn't verified the domain you send from (${report.fromDomain}). In Resend → Domains add ${report.fromDomain}, put its DNS records in Cloudflare DNS, and wait until it shows Verified. Or set EMAIL_FROM to an address on a domain that is verified.`);
    if (/only send testing emails to your own email/.test(m)) hint("Resend is in testing mode: without a verified domain it only sends to your own Resend account's address. Verify your domain in Resend → Domains.");
    if (st === 422 && /from/.test(m)) hint(`Resend didn't accept the From address (${report.from}). Set EMAIL_FROM to a plain address on your verified domain, like orders@${report.rootDomain}.`);
    if (st === 429) hint("Resend's rate limit — wait a minute and try again.");
    if (!report.hints.length || report.hints.every(h => /ROOT_DOMAIN/.test(h))) hint("See Resend's message above; the Logs page in your Resend account shows the same attempt.");
  }
  if (!report.ok && (provider === "mailbox" || provider === "smtp")) hint("See the mail server's answer above. Global settings → Email has the mailbox's settings.");
  if (report.ok) hint(provider === "mailbox" || provider === "smtp" ? "Your mail server accepted it. If it doesn't arrive, check spam; it is also in the mailbox's Sent folder with Gmail, iCloud and most others." : provider === "resend"
    ? "Resend accepted it. If it doesn't arrive, check spam, and the Logs page in your Resend account for this email's id (above)."
    : "Accepted for sending. If it doesn't arrive, check spam.");
  return report;
}

// ---- Preview (Global settings → Customer emails) ----------------------------------------------------------
// A built message with its placeholders filled in exactly as send_ would — the subject, the HTML and the text
// a customer would get — without sending it. Attachments are described (name, size), not returned.
export async function previewMessage(env, msg) {
  const id = await mailIdentity_(env);
  const m = fillTemplate_(msg, id);
  const tag = env && env.EMAIL_SUBJECT_TAG ? String(env.EMAIL_SUBJECT_TAG).trim().slice(0, 30) : "";
  return { subject: tag && !String(m.subject || "").startsWith(tag) ? `${tag} ${m.subject || ""}`.trim() : m.subject, html: m.html, text: m.text,
    attachments: mailAttachments_(m.attachments).map(a => ({ filename: a.filename, bytes: Math.floor(a.contentBase64.length * 3 / 4) })) };
}
// The same message sent to the owner's inbox, marked as a sample.
export async function sendSampleMessage(env, msg) {
  return send_(env, { ...msg, to: ORDER_NOTIFICATION_EMAIL, subject: "[Sample] " + (msg.subject || "") });
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmt$(n) {
  return "$" + Number(n).toFixed(2);
}

// Raw Shippo status (stored on a blank shipment) → a readable label for the roll-up.
function blankStatusLabel_(s) {
  return { TRANSIT: "In transit", DELIVERED: "Delivered", RETURNED: "Returned to sender",
    FAILURE: "Carrier issue", UNKNOWN: "Unknown", PRE_TRANSIT: "Pre-transit" }[String(s || "").toUpperCase()] || s || "";
}
// The carrier's own wording (e.g. UPS "Loaded on Delivery Vehicle") preferred over the coarse
// normalized status, so the roll-up isn't vaguely "In transit" when the carrier knows more.
function blankStatusText_(shipment) {
  const detail = String((shipment && shipment.statusDetail) || "").trim();
  const label = blankStatusLabel_(shipment && shipment.status);
  if (detail && label && detail.toLowerCase() !== label.toLowerCase()) return detail;
  return detail || label;
}

// A configurable line's picks as plain text — "Navy · Front: Lockup (White) · Back: Capital".
// The invisible reorder-QR application and any auto-added entries are left out. Mirrors
// cfgSummary_ in admin.js so receipts read the same as the admin order view. Returns "".
function configSummary_(it) {
  const c = it && it.config;
  if (!c || !Array.isArray(c.locations)) return "";
  const parts = c.locations
    .filter((l) => !l.auto && !l.fixed && l.location !== "reorderqr")
    .map((l) => `${l.label || l.location}: ${l.graphicName}${l.ink ? " (" + l.ink + ")" : ""}`);
  return [c.garmentColor, ...parts].filter(Boolean).join(" · ");
}

// What to print after a line's name: a configurable line's picks, plus the personalization (typed name or
// preset word) when there is one — both can apply to the same line.
export function lineDetailText(it) { return lineDetail_(it); }   // for the invoice page
function lineDetail_(it) {
  const cfg = configSummary_(it);
  const pers = it && it.personalized ? `“${it.persName || ""}”` : "";
  return [cfg, pers].filter(Boolean).join(" · ");
}

const RUSH_FOLLOW_TEXT_ = "to follow — we'll send it separately";
// The delivery line's label. A shop's own option ("Delivery at practice" — migrations/0045) has a
// method name but no ship-to address, and reads as itself; a carrier reads "Shipping (USPS Priority)".
// (No address alone isn't proof — an old or hand-built order can carry "USPS Ground Advantage" without
// one — so a method that starts with a carrier's name is always shipping.)
const CARRIER_NAME_RE_ = /^(usps|ups|fedex|dhl|ontrac|lasership|carrier)\b/i;
function deliveryIsCustom_(order) {
  return !!(order && order.shippingMethod && !order.shippingAddress && !order.manualShipping && !CARRIER_NAME_RE_.test(String(order.shippingMethod).trim()));
}
function deliveryLabel_(order) {
  if (deliveryIsCustom_(order)) return String(order.shippingMethod);
  return `Shipping${order.shippingMethod ? " (" + order.shippingMethod + ")" : ""}`;
}
// "⚡ RUSH · needed by 2026-11-20 · pay by 2026-11-16 · fee to follow" — how the roll-up marks a rush order.
function rushTag_(o) {
  return ["⚡ RUSH", o.dueDate ? "needed by " + o.dueDate : "", o.rushPayBy ? "pay by " + o.rushPayBy : "", o.rushFeePending ? "fee to follow" : (Number(o.rushFee) > 0 ? "fee " + fmt$(o.rushFee) : "")].filter(Boolean).join(" · ");
}
// "Monday, November 16, 2026" from YYYY-MM-DD (a calendar day — no time zone shift).
function longDate_(day) {
  const d = new Date(String(day) + "T12:00:00Z");
  return isNaN(d) ? String(day || "") : d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}
// A rush order's payment deadline (migrations/0083): the date full payment must be received by to keep the rush
// date, and plainly that without it the date can't be guaranteed. Null when there's no pay-by date, or nothing is
// left to pay (a rush fee still to follow is still to pay). {html, text}.
function rushPayByNotice_(order) {
  if (!order || !order.rushRequested || !order.rushPayBy) return null;
  if (order.balanceDue != null && !(Number(order.balanceDue) > 0) && !order.rushFeePending) return null;
  const pay = longDate_(order.rushPayBy), need = order.dueDate ? longDate_(order.dueDate) : "";
  const lead = need ? `This is a rush order with a rush delivery date of ${need}.` : "This is a rush order.";
  const ask = `To keep ${need ? "that date" : "the rush"}, we must receive full payment by ${pay}` +
    (order.rushFeePending ? " — including the rush fee, which we'll send you separately." : ".") + " A mailed check has to arrive by then.";
  const warn = `If we have not received full payment by ${pay}, we cannot guarantee the rush delivery date${need ? " of " + need : ""}.`;
  return {
    html: `<div style="background:#fff7ed;border:2px solid #ea580c;border-radius:6px;padding:12px 16px;margin:16px 0;font-size:15px;line-height:1.45">
      <div style="font-size:16px;font-weight:bold;color:#9a3412;margin-bottom:4px">⚡ Rush order — full payment due by ${escHtml(pay)}</div>
      <div>${escHtml(lead)} ${escHtml(ask)}</div>
      <div style="margin-top:6px;font-weight:bold;color:#9a3412">${escHtml(warn)}</div>
    </div>`,
    text: `RUSH ORDER — FULL PAYMENT DUE BY ${pay.toUpperCase()}\n${lead} ${ask}\n${warn}\n`,
  };
}
// ---- What an order comes to, line by line — one model for the HTML email, the plain-text email and the PDF ----
// Prices are shown BEFORE tax and the sales tax is its own line above the Total, whichever way the shop
// prices: with tax included in the price (the default) each line's tax is backed out of it — the tax
// recorded on the line, or for an order not saved yet splitTaxInclusive (db.js, the one formula) at the
// order's rate — and the discount and rush fee are shown without the tax inside them; with tax added on
// top the line totals already are before tax. The Total is always what the customer pays (the order's
// effectiveTotal), and Subtotal + shipping + rush − discount + tax adds up to it to the cent.
// Only when a line's tax can't be known (an old caller that sends neither) are prices shown as charged,
// with "Includes sales tax" under the Total.
const rcCents_ = (v) => Math.round((Number(v) || 0) * 100);
const fmtCents_ = (c) => fmt$((Number(c) || 0) / 100);
function receiptLines_(order) {
  const items = (order.items || []).filter(it => !it.cancelDate);
  const exclusive = order.taxMode === "exclusive";
  const rateBps = Math.round((Number(order.taxRate) || 0) * 100);
  const lineTax = (it) => {
    if (it.tax != null && it.tax !== "" && !isNaN(Number(it.tax))) return rcCents_(it.tax);
    if (exclusive || order.taxExempt || !rateBps || it.taxable === false) return 0;
    return typeof splitTaxInclusive === "function" ? splitTaxInclusive(rcCents_(it.lineTotal), rateBps).taxCents : null;
  };
  const taxes = items.map(lineTax);
  const known = taxes.every(t => t != null);
  const beforeTax = exclusive || known;
  const lines = items.map((it, i) => {
    const qty = Math.max(1, Number(it.qty) || 1);
    const amountCents = rcCents_(it.lineTotal) - (!exclusive && known ? taxes[i] : 0);
    return { name: String(it.name || ""), detail: lineDetail_(it), size: String(it.size || ""), qty, amountCents, unitCents: Math.round(amountCents / qty) };
  });
  const lineTaxCents = known ? taxes.reduce((t, x) => t + x, 0) : 0;
  const subtotalCents = lines.reduce((t, l) => t + l.amountCents, 0);
  const shippingCents = rcCents_(order.shippingCost);
  const rushOn = !!order.rushRequested, rushPending = !!(rushOn && order.rushFeePending);
  const rushCents = rushOn ? rcCents_(order.rushFee) : 0;
  const rushTaxCents = rushOn ? rcCents_(order.rushFeeTax) : 0;
  const discountCents = rcCents_(order.discountAmount);
  const discountTaxCents = order.discountTax != null && order.discountTax !== "" ? rcCents_(order.discountTax)
    : (!exclusive && known && order.salesTax != null ? Math.max(0, Math.min(discountCents, lineTaxCents + rushTaxCents - rcCents_(order.salesTax))) : 0);
  const taxCents = order.salesTax != null && order.salesTax !== "" ? rcCents_(order.salesTax) : Math.max(0, lineTaxCents - discountTaxCents + rushTaxCents);
  const rushShown = beforeTax && !exclusive ? rushCents - rushTaxCents : rushCents;
  const discountShown = beforeTax && !exclusive ? discountCents - discountTaxCents : discountCents;
  const tbd = !!(order.manualShipping || order.shippingPending);
  const totalCents = order.effectiveTotal != null && order.effectiveTotal !== "" ? rcCents_(order.effectiveTotal)
    : order.total != null && order.total !== "" ? rcCents_(order.total)
    : subtotalCents + shippingCents + rushShown - discountShown + (beforeTax ? taxCents : 0);
  const rows = [{ label: "Subtotal", value: fmtCents_(subtotalCents) }];
  if (tbd) rows.push({ label: "Shipping", value: "TBD", muted: true });
  else if (shippingCents > 0) rows.push({ label: deliveryLabel_(order), value: fmtCents_(shippingCents) });
  else if (deliveryIsCustom_(order)) rows.push({ label: deliveryLabel_(order), value: "Free" });
  if (rushPending) rows.push({ label: "Rush fee", value: RUSH_FOLLOW_TEXT_, muted: true });
  else if (rushCents > 0) rows.push({ label: "Rush fee", value: fmtCents_(rushShown) });
  if (discountCents > 0) rows.push({ label: "Discount" + (order.discountNote ? " (" + order.discountNote + ")" : ""), value: "−" + fmtCents_(discountShown), green: true });
  const taxLabel = "Sales tax" + (order.taxRate ? ` (${order.taxRate}%)` : "");
  if (order.taxExempt) rows.push({ label: "Sales tax", value: "Tax-exempt", muted: true });
  else if (beforeTax && taxCents > 0) rows.push({ label: taxLabel, value: fmtCents_(taxCents) });
  if (!tbd) rows.push({ label: "Total", value: fmtCents_(totalCents), strong: true, rule: true });
  const note = !beforeTax && !order.taxExempt && taxCents > 0 ? { label: "Includes " + taxLabel.toLowerCase(), value: fmtCents_(taxCents) } : null;
  if (note) rows.push({ ...note, muted: true, small: true });
  // A unit price that had to be rounded (2 for $47.17 → $23.59 each) is said so, so it doesn't look like a sum that's off.
  const roundedUnits = lines.some(l => l.unitCents * l.qty !== l.amountCents);
  return { lines, rows, totalCents, tbd, beforeTax, roundedUnits, // "Before tax" is only worth saying when there is tax on the order.
    note: [beforeTax && taxCents > 0 ? "Prices are shown before sales tax." : "", roundedUnits ? "Unit prices are rounded to the cent; the amounts are exact." : ""].filter(Boolean).join(" ") };
}
// Paid so far / balance due under the totals (the invoice and the payment-received email).
function paymentRows_(order) {
  const received = rcCents_(order.amountReceived), due = Math.max(0, rcCents_(order.balanceDue));
  if (!(received > 0)) return [];
  return [{ label: "Paid", value: "−" + fmtCents_(received), green: true }, { label: due > 0 ? "Balance due" : "Balance due", value: fmtCents_(due), strong: true }];
}
function itemsTableHtml_(r) {
  const td = "padding:6px 8px;border-bottom:1px solid #eee;vertical-align:top";
  return `<table style="width:100%;border-collapse:collapse;font-size:14px">
    <thead><tr style="background:#f5f5f5">
      <th style="padding:6px 8px;text-align:left">Item</th>
      <th style="padding:6px 8px;text-align:center">Size</th>
      <th style="padding:6px 8px;text-align:center">Qty</th>
      <th style="padding:6px 8px;text-align:right">Unit price</th>
      <th style="padding:6px 8px;text-align:right">Amount</th>
    </tr></thead>
    <tbody>${r.lines.map(l => `<tr>
      <td style="${td}">${escHtml(l.name)}${l.detail ? `<div style="font-size:12px;color:#666">${escHtml(l.detail)}</div>` : ""}</td>
      <td style="${td};text-align:center">${escHtml(l.size || "One Size")}</td>
      <td style="${td};text-align:center">${l.qty}</td>
      <td style="${td};text-align:right">${fmtCents_(l.unitCents)}</td>
      <td style="${td};text-align:right">${fmtCents_(l.amountCents)}</td></tr>`).join("")}</tbody>
  </table>${r.note ? `<p style="font-size:12px;color:#666;margin:4px 0 0">${escHtml(r.note)}</p>` : ""}`;
}
function totalsHtml_(rows) {
  return `<table style="width:100%;font-size:14px;margin-top:8px">${rows.map(x => {
    const st = (x.rule ? "border-top:1px solid #ddd;padding-top:4px;" : "") + (x.muted ? "color:#666;" : "") + (x.green ? "color:#166534;" : "") + (x.small ? "font-size:13px;" : "");
    const v = (t) => x.strong ? `<strong>${t}</strong>` : t;
    return `<tr><td style="${st}">${v(escHtml(x.label))}</td><td style="text-align:right;${st}">${v(escHtml(x.value))}</td></tr>`;
  }).join("")}</table>`;
}
function itemsText_(r) {
  return r.lines.map(l => `  ${l.qty} × ${l.name}${l.size ? " (" + l.size + ")" : ""}${l.detail ? " — " + l.detail : ""}  ${fmtCents_(l.unitCents)} each  ${fmtCents_(l.amountCents)}`).join("\n") +
    (r.note ? "\n  (" + r.note.replace(/\.$/, "") + ")" : "");
}
function totalsText_(r, rows) {
  return rows.map(x => x.label === "Shipping" && x.value === "TBD"
    ? "Shipping: TBD — a follow-up email will include the shipping cost, total, and payment options."
    : `${x.label}: ${x.value}`).join("\n");
}
// The shapes the other emails (invoice, shipped) and the invoice page / document use.
function itemsTable(items, order) { return itemsTableHtml_(receiptLines_({ ...(order || {}), items })); }
function receiptTotalsHtml_(order) { return totalsHtml_(receiptLines_(order).rows); }
function receiptTotalsText_(order) { const r = receiptLines_(order); return totalsText_(r, r.rows); }

// ---- Who you are, at the bottom of every customer email and on the PDF ----------------------------------
// From the Business profile: name (and legal name), mailing address, phone, contact email, website, the
// footer line. A field left blank is left out. A website not set is the site itself (not on the desktop).
async function businessProfile_(env) {
  try { return (typeof getBusinessProfile === "function" ? await getBusinessProfile(env && env.DB) : null) || {}; } catch (e) { return {}; }
}
function businessLines_(p, env) {
  const site = p.website || (!isDesktop_(env) && siteRoot_(env) !== "example.com" ? "https://" + siteRoot_(env) : "");
  return {
    name: p.name || "Our shop", legal: p.legalName && p.legalName !== p.name ? p.legalName : "",
    details: [p.mailingAddress, p.phone, p.supportEmail, site.replace(/^https?:\/\//, "")].filter(x => String(x || "").trim()),
    site, footer: p.footer || "",
  };
}
function businessBlock_(p, env) {
  const b = businessLines_(p, env);
  const html = `<hr style="border:none;border-top:1px solid #ddd;margin:20px 0 10px"/>
    <div style="font-size:12px;color:#666;line-height:1.5">
      <strong style="color:#333">${escHtml(b.name)}</strong>${b.legal ? ` · ${escHtml(b.legal)}` : ""}<br>
      ${b.details.map(d => escHtml(d).replace(/\s*\r?\n\s*/g, ", ")).join(" · ")}${b.footer ? `<br>${escHtml(b.footer)}` : ""}
    </div>`;
  const text = [b.name + (b.legal ? " · " + b.legal : ""), ...b.details, b.footer].filter(Boolean).join("\n");
  return { html, text };
}

// ---- How to pay -------------------------------------------------------------------------------------------
// The method the customer chose first, with everything they need (a check: who it's payable to, where to
// mail it, the order number on the memo line), then the other ways the shop takes, then the shop's own note.
// Only ways switched on — site-wide (Global settings) and for the shop — and set up in the Business profile
// (a Venmo name, a Zelle address, a mailing address) are listed. `payUrl`: a page where the order can be
// paid by card (the invoice page).
const PAY_METHODS_ = ["check", "venmo", "zelle", "card"];
const methodKey_ = (m) => { const s = String(m || "").toLowerCase(); return PAY_METHODS_.find(k => s.includes(k)) || ""; };
async function paymentsAllowed_(env, order) {
  let g = null, o = null;
  try { if (typeof getGlobalSettings === "function") g = (await getGlobalSettings(env && env.DB)).enabledPayments; } catch (e) { g = null; }
  try { if (typeof getOrgById === "function" && order && order.orgId) { const org = await getOrgById(env.DB, order.orgId); o = org && org.enabledPayments; } } catch (e) { o = null; }
  return (k) => (!g || g[k] !== false) && (!o || o[k] !== false);
}
async function howToPay_(env, order, { inEmail = true, payUrl = "", profile = null } = {}) {
  const p = profile || await businessProfile_(env);
  const allowed = await paymentsAllowed_(env, order);
  const due = Number(order.balanceDue != null ? order.balanceDue : order.effectiveTotal != null ? order.effectiveTotal : order.total) || 0;
  const amt = due > 0 ? fmt$(due) : "the amount due";
  const payee = p.legalName || p.name || "us";
  const chosen = methodKey_(order.paymentMethod);
  const memo = `Please write order number ${order.orderId} on the memo line.`;
  const way = {
    check: () => p.mailingAddress
      ? { title: "Check", text: `Make a check for ${amt} payable to “${payee}” and mail it to ${String(p.mailingAddress).replace(/\s*\n\s*/g, ", ")}. ${memo}` }
      : chosen === "check" ? { title: "Check", text: `Make a check for ${amt} payable to “${payee}”. ${memo} We'll send you the address to mail it to.` } : null,
    venmo: () => p.venmo ? { title: "Venmo", text: `Send ${amt} to @${p.venmo} on Venmo, with order ${order.orderId} in the note.`,
      href: `https://venmo.com/u/${encodeURIComponent(p.venmo)}?txn=pay&amount=${due.toFixed(2)}&note=${encodeURIComponent("Order " + order.orderId)}`, link: "Pay with Venmo" } : null,
    zelle: () => p.zelle ? { title: "Zelle", text: `Send ${amt} by Zelle to ${p.zelle}, with order ${order.orderId} in the memo.` } : null,
    card: () => payUrl ? { title: "Card", text: `Pay ${amt} by card online.`, href: payUrl, link: "Pay by card" }
      : chosen === "card" ? { title: "Card", text: inEmail ? "If your card payment didn't go through, reply to this email and we'll send you a link to pay." : "Contact us for a link to pay by card." } : null,
  };
  const first = chosen && allowed(chosen) ? way[chosen]() : (chosen ? way[chosen]() : null);
  const others = PAY_METHODS_.filter(k => k !== chosen && allowed(k)).map(k => way[k]()).filter(Boolean);
  const close = inEmail ? "Questions? Reply to this email." : p.supportEmail ? `Questions? Email ${p.supportEmail}.` : "";
  const lineHtml = (w) => `<strong>${escHtml(w.title)}:</strong> ${escHtml(w.text)}${w.href ? ` <a href="${escHtml(w.href)}">${escHtml(w.link)} &rarr;</a>` : ""}`;
  const html = `<div style="margin:20px 0;padding:12px 16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;font-size:14px;line-height:1.5">
      <div style="font-size:16px;font-weight:bold;margin-bottom:6px">How to pay${due > 0 ? " " + escHtml(fmt$(due)) : ""}</div>
      ${first ? `<div style="margin-bottom:8px">${lineHtml(first)}</div>` : ""}
      ${others.length ? `<div style="color:#555;margin:6px 0 2px">${first ? "Other ways to pay:" : "Ways to pay:"}</div><ul style="margin:0;padding-left:20px">${others.map(w => `<li>${lineHtml(w)}</li>`).join("")}</ul>` : ""}
      ${p.paymentNote ? `<div style="margin-top:8px">${escHtml(p.paymentNote)}</div>` : ""}
      ${close ? `<div style="margin-top:8px;font-size:13px;color:#555">${escHtml(close)}</div>` : ""}
    </div>`;
  const textLines = [`How to pay${due > 0 ? " " + fmt$(due) : ""}:`];
  if (first) textLines.push(`  ${first.title}: ${first.text}${first.href ? "\n    " + first.href : ""}`);
  if (others.length) { textLines.push(first ? "Other ways to pay:" : "Ways to pay:"); for (const w of others) textLines.push(`  ${w.title}: ${w.text}${w.href ? "\n    " + w.href : ""}`); }
  if (p.paymentNote) textLines.push(p.paymentNote);
  if (close) textLines.push(close);
  return { html, text: textLines.join("\n"), first, others, note: p.paymentNote || "", close, any: !!(first || others.length) };
}

// ---- The PDF of an order: an invoice while something is owed, a receipt once it's paid -------------------
// Drawn with pdf.js (no browser — works on the free plan). Returned as an email attachment
// { filename, contentType, contentBase64 }. Null when PDFs are switched off (Global settings → Customer
// emails) or can't be made here; a failure is logged and the email goes without it.
async function orderPdfAttachment_(env, order, opts = {}) {
  try {
    if (typeof pdfDocument !== "function") return null;
    if (!opts.force && typeof getEmailSettings === "function") {
      try { if ((await getEmailSettings(env && env.DB)).attachPdf === false) return null; } catch (e) { /* default: on */ }
    }
    const doc = await orderPdf(env, order, opts);
    return { filename: doc.filename, contentType: "application/pdf", contentBase64: pdfBase64(doc.bytes) };
  } catch (e) {
    console.error("Couldn't make the PDF for order", order && order.orderId, e);
    return null;
  }
}
// For the admin's Download PDF and the sample PDF: { filename, contentBase64 }.
export async function orderPdfFile(env, order, opts = {}) {
  const doc = await orderPdf(env, order, opts);
  return { filename: doc.filename, contentBase64: pdfBase64(doc.bytes) };
}
// { filename, bytes } — `kind` "invoice" | "receipt" (default: receipt when nothing is owed).
export async function orderPdf(env, order, { kind = "", orgName = "", message = "", payUrl = "" } = {}) {
  const p = await businessProfile_(env);
  let country = "US";
  try { if (typeof getLocaleSettings === "function") country = ((await getLocaleSettings(env && env.DB)) || {}).country === "OTHER" ? "OTHER" : "US"; } catch (e) { country = "US"; }
  const tz = await timeZone_(env);
  const day = (d) => { const t = new Date(d || Date.now()); return isNaN(t) ? "" : t.toLocaleDateString("en-US", { timeZone: tz, month: "long", day: "numeric", year: "numeric" }); };
  const r = receiptLines_(order);
  const due = Math.max(0, Number(order.balanceDue != null ? order.balanceDue : r.totalCents / 100) || 0);
  const isReceipt = kind ? kind === "receipt" : !(due > 0);
  const title = isReceipt ? "RECEIPT" : "INVOICE";
  const b = businessLines_(p, env);
  const pay = !isReceipt && due > 0 ? await howToPay_(env, order, { inEmail: false, payUrl, profile: p }) : null;
  const doc = pdfDocument({ pageSize: country === "US" ? "Letter" : "A4", title: `${isReceipt ? "Receipt" : "Invoice"} ${order.orderId}` });
  const M = 50, W = doc.width, R = W - M, BLUE = "#1f5f8b", GREY = "#5a6573";
  let y = 60;
  const ensure = (h, header) => { if (y + h > doc.height - 70) { doc.newPage(); y = 60; if (header) header(); } };
  // Header: who you are (left), INVOICE / RECEIPT and its details (right).
  const meta = [[isReceipt ? "Receipt no." : "Invoice no.", order.orderId], ["Date", day()], ...(order.placedAt ? [["Order date", day(order.placedAt)]] : []),
    ...(orgName ? [["Shop", orgName]] : []), ...(order.paymentMethod ? [["Payment", String(order.paymentMethod)]] : [])];
  // The details' values are as wide as the widest one (up to 200pt; longer ones wrap), with their labels
  // just left of them — a long order number or shop name used to run over its label.
  const valueW = Math.min(200, Math.max(110, ...meta.map(([, v]) => pdfTextWidth(String(v), 10))));
  const labelR = R - valueW - 10, labelW = Math.max(...meta.map(([k]) => pdfTextWidth(k, 10)));
  const leftW = Math.max(150, Math.min(270, labelR - labelW - 16 - M));
  doc.text(M, y, b.name, { size: 17, bold: true });
  let ly = y + 16;
  if (b.legal) for (const l of pdfWrap(b.legal, leftW, 10)) { doc.text(M, ly, l, { size: 10, color: GREY }); ly += 13; }
  for (const d of b.details) for (const l of pdfWrap(d, leftW, 10)) { doc.text(M, ly, l, { size: 10 }); ly += 13; }
  doc.text(R, y + 4, title, { size: 24, bold: true, color: BLUE, align: "right" });
  let my = y + 24;
  for (const [k, v] of meta) {
    doc.text(labelR, my, k, { size: 10, color: GREY, align: "right" });
    for (const l of pdfWrap(String(v), valueW, 10)) { doc.text(R, my, l, { size: 10, align: "right" }); my += 13; }
  }
  y = Math.max(ly, my) + 8;
  doc.line(M, y, R, y, { color: BLUE, width: 2 });
  y += 22;
  // Bill to / Ship to.
  const name = String(order.customerName || "").trim();
  const bill = [name && name !== "Local Sale" ? name : "", String(order.contact || "").includes("@") ? order.contact : ""].filter(Boolean);
  const a = order.shippingAddress && order.shippingAddress.line1 ? order.shippingAddress : null;
  const ship = a ? [a.name, a.line1, a.line2, [a.city, a.state].filter(Boolean).join(", ") + (a.zip ? " " + a.zip : "")].filter(s => String(s || "").trim()) : [];
  if (bill.length || ship.length) {
    let by = y;
    if (bill.length) { doc.text(M, by, "BILL TO", { size: 9, bold: true, color: GREY }); by += 13; for (const s of bill) for (const l of pdfWrap(s, 240, 10)) { doc.text(M, by, l, { size: 10 }); by += 13; } }
    let sy = y;
    if (ship.length) { doc.text(M + 260, sy, "SHIP TO", { size: 9, bold: true, color: GREY }); sy += 13; for (const s of ship) for (const l of pdfWrap(s, R - M - 260, 10)) { doc.text(M + 260, sy, l, { size: 10 }); sy += 13; } }
    y = Math.max(by, sy) + 12;
  }
  // The items: Item · Size · Qty · Unit price · Amount.
  const cx = { size: R - 190, qty: R - 140, unit: R - 75, amount: R };
  const header = () => {
    doc.rect(M, y - 12, R - M, 18, { fill: "#eef2f6" });
    doc.text(M + 6, y, "Item", { size: 9, bold: true }); doc.text(cx.size, y, "Size", { size: 9, bold: true, align: "center" });
    doc.text(cx.qty, y, "Qty", { size: 9, bold: true, align: "center" }); doc.text(cx.unit, y, "Unit price", { size: 9, bold: true, align: "right" });
    doc.text(cx.amount - 4, y, "Amount", { size: 9, bold: true, align: "right" });
    y += 18;
  };
  header();
  for (const l of r.lines) {
    const nameLines = pdfWrap(l.name, cx.size - M - 40, 10), detailLines = l.detail ? pdfWrap(l.detail, cx.size - M - 40, 8.5) : [];
    ensure(nameLines.length * 12 + detailLines.length * 10 + 8, header);
    const top = y;
    nameLines.forEach((t, i) => doc.text(M + 6, top + i * 12, t, { size: 10 }));
    detailLines.forEach((t, i) => doc.text(M + 6, top + nameLines.length * 12 + i * 10, t, { size: 8.5, color: GREY }));
    doc.text(cx.size, top, l.size || "One Size", { size: 10, align: "center" });
    doc.text(cx.qty, top, String(l.qty), { size: 10, align: "center" });
    doc.text(cx.unit, top, fmtCents_(l.unitCents), { size: 10, align: "right" });
    doc.text(cx.amount - 4, top, fmtCents_(l.amountCents), { size: 10, align: "right" });
    y = top + nameLines.length * 12 + detailLines.length * 10 + 4;
    doc.line(M, y, R, y, { color: "#e1ddd3", width: 0.5 });
    y += 14;
  }
  if (r.note) { for (const ln of pdfWrap(r.note, R - M - 12, 8.5)) { doc.text(M + 6, y - 4, ln, { size: 8.5, color: GREY }); y += 11; } }
  // The money lines, then paid / balance due.
  const rows = [...r.rows, ...paymentRows_(order)];
  ensure(rows.length * 15 + 40);
  for (const x of rows) {
    if (x.rule) { doc.line(R - 230, y - 10, R, y - 10, { color: "#999999", width: 0.75 }); y += 2; }
    const opt = { size: x.small ? 9 : 10.5, bold: !!x.strong, color: x.muted ? GREY : x.green ? "#166534" : "" };
    doc.text(R - 230, y, x.label, opt); doc.text(R - 4, y, x.value, { ...opt, align: "right" });
    y += x.strong ? 18 : 15;
  }
  y += 6;
  if (isReceipt) {
    ensure(34);
    doc.rect(M, y, R - M, 26, { stroke: "#15803d", width: 1.5 });
    doc.text(W / 2, y + 17, due > 0 ? `Payment received — balance due ${fmt$(due)}` : "Paid in full — thank you", { size: 12, bold: true, color: "#15803d", align: "center" });
    y += 42;
  } else if (due > 0 && !r.tbd) {
    ensure(34);
    doc.rect(M, y, R - M, 26, { stroke: BLUE, width: 1.5 });
    doc.text(M + 12, y + 17, "Balance due", { size: 12, bold: true }); doc.text(R - 12, y + 17, fmt$(due), { size: 12, bold: true, align: "right" });
    y += 42;
  }
  if (message) { for (const l of pdfWrap(message, R - M, 10)) { ensure(14); doc.text(M, y, l, { size: 10 }); y += 13; } y += 8; }
  if (pay && pay.any) {
    ensure(40);
    doc.text(M, y, `How to pay${due > 0 ? " " + fmt$(due) : ""}`, { size: 12, bold: true }); y += 16;
    const put = (t, opt = {}) => { for (const l of pdfWrap(t, R - M - 12, 10, opt.bold)) { ensure(14); doc.text(M + (opt.indent || 0), y, l, { size: 10, ...opt }); y += 13; } };
    if (pay.first) put(`${pay.first.title}: ${pay.first.text}${pay.first.href && pay.first.title === "Venmo" ? " " + pay.first.href : ""}`);
    if (pay.others.length) { y += 3; put(pay.first ? "Other ways to pay:" : "Ways to pay:", { color: GREY }); for (const w of pay.others) put(`• ${w.title}: ${w.text}`, { indent: 8 }); }
    if (pay.note) { y += 3; put(pay.note); }
    if (pay.close) { y += 3; put(pay.close, { color: GREY }); }
  }
  // Footer on the last page.
  const foot = [b.footer, [b.name, ...b.details].join(" · ")].filter(Boolean);
  let fy = doc.height - 40 - (foot.length - 1) * 11;
  doc.line(M, fy - 14, R, fy - 14, { color: "#e1ddd3", width: 0.5 });
  for (const f of foot) for (const l of pdfWrap(f, R - M, 8.5)) { doc.text(W / 2, fy, l, { size: 8.5, color: GREY, align: "center" }); fy += 11; }
  return { filename: `${isReceipt ? "Receipt" : "Invoice"} ${order.orderId}.pdf`, bytes: doc.bytes() };
}

// ---- The two emails every order gets -------------------------------------------------------------------
// Each says the same thing in its subject and its heading, so the customer can tell them apart in the inbox:
//   "Order received — ORD-1 · $54.06 due"   when the order is placed (or "… · paid" / no amount while
//                                             the shipping cost is still to come)
//   "Payment received — ORD-1 · paid in full" when the payment is recorded (Mark as paid, or Resend on a
//                                             paid order) — "· $12.00 still due" if part was paid.
// The items are priced before tax with the tax above the Total (receiptLines_); what's owed comes with how
// to pay it (howToPay_); every email ends with who you are (businessBlock_). A PDF of the invoice / receipt
// is attached unless that's switched off (Global settings → Customer emails).
// build…Email returns the message without sending it — Global settings' preview shows exactly that.
function orderReceivedSubject_(order) {
  const r = receiptLines_(order), due = order.balanceDue != null ? rcCents_(order.balanceDue) : r.totalCents;
  if (r.tbd) return `Order received — ${order.orderId}`;
  return due > 0 ? `Order received — ${order.orderId} · ${fmtCents_(due)} due` : `Order received and paid — ${order.orderId}`;
}
export async function buildOrderReceivedEmail(env, order, { pdf = true } = {}) {
  const subject = orderReceivedSubject_(order);
  const p = await businessProfile_(env);
  const rushNotice = rushPayByNotice_(order);
  const r = receiptLines_(order);
  const due = order.balanceDue != null ? Number(order.balanceDue) || 0 : r.totalCents / 100;
  const pay = !r.tbd && due > 0 ? await howToPay_(env, order, { profile: p }) : null;
  const attachment = pdf && !r.tbd ? await orderPdfAttachment_(env, order, { kind: due > 0 ? "invoice" : "receipt" }) : null;
  const biz = businessBlock_(p, env);
  const manualShippingNote = r.tbd
    ? `<p style="background:#fef9c3;border:1px solid #fde047;border-radius:4px;padding:10px 14px;font-size:14px;margin-top:12px;">
        <strong>Shipping quote pending:</strong> Your order requires a custom shipping quote.
        We'll follow up with a separate email that includes the shipping cost, updated total, and payment options.
       </p>`
    : "";
  const paidNow = due <= 0 && !r.tbd;
  const attachedLine = paidNow ? " Your receipt is attached as a PDF." : " Your invoice is attached as a PDF.";
  const html = `<div style="font-family:sans-serif;max-width:600px;margin:auto">
    <h2 style="color:#1d4ed8">Order received${paidNow ? " — paid" : ""}</h2>
    <p>Hi ${escHtml(order.customerName)}, thank you — we received your order${paidNow ? " and your payment" : due > 0 && !r.tbd ? " and will start on it once it's paid" : ""}.${attachment ? attachedLine : ""}</p>
    ${rushNotice ? rushNotice.html : ""}
    <p><strong>Order number:</strong> ${escHtml(order.orderId)}${order.paymentMethod ? ` &nbsp;·&nbsp; <strong>Payment:</strong> ${escHtml(order.paymentMethod)}` : ""}</p>
    ${itemsTableHtml_(r)}
    ${totalsHtml_(r.rows)}
    ${manualShippingNote}
    ${pay && pay.any ? pay.html : ""}
    ${biz.html}
  </div>`;
  const text = `Order received${paidNow ? " — paid" : ""} — ${order.orderId}\n\nHi ${order.customerName},\nThank you — we received your order${paidNow ? " and your payment" : ""}.${attachment ? attachedLine : ""}\n${rushNotice ? "\n" + rushNotice.text + "\n" : ""}` +
    `\nOrder number: ${order.orderId}${order.paymentMethod ? "\nPayment: " + order.paymentMethod : ""}\n\n${itemsText_(r)}\n\n${totalsText_(r, r.rows)}\n` +
    (pay && pay.any ? "\n" + pay.text + "\n" : "") + `\n${biz.text}`;
  return { to: order.contact, subject, html, text, ...(attachment ? { attachments: [attachment] } : {}) };
}
export async function sendOrderReceivedEmail(env, order) {
  return send_(env, await buildOrderReceivedEmail(env, order));
}

// The install's one time zone — Global settings → Region, else the TIMEZONE variable, else UTC
// (resolveTimeZone in db.js). Every date and time an email prints is in it.
async function timeZone_(env) {
  try { return await resolveTimeZone(env); } catch (e) { return "UTC"; }
}

// The "nothing new" note the SCHEDULED roll-up sends on a quiet morning — an email goes out every
// day so that silence can't mean "it didn't run". Short on purpose: when it checked, since when
// nothing is new, and what is still being watched (packages on the way, labels not yet picked up,
// blanks on order). Lists no orders and moves no progress markers.
// "Machine 1: Oil the rotary hook (5.2 h of run time since it was last done)" — machine maintenance that's due
// (migrations/0071), for the roll-up and the quiet-morning email.
function maintenanceText_(tasks) {
  return (tasks || []).map(t => {
    const parts = [];
    if (t.everySeconds) parts.push(`${Math.round((Number(t.usedSeconds) || 0) / 360) / 10} h of run time`);
    if (t.everyStitches) parts.push(`${(Number(t.usedStitches) || 0).toLocaleString("en-US")} stitches`);
    return `${t.machineName || "Machine"}: ${t.name}${parts.length ? ` (${parts.join(", ")} since it was last done)` : ""}`;
  });
}

// Recurring expenses recorded automatically (migrations/0085): "Nov 5 · Design software — $29.99 (Monthly, Business card)".
function recurringText_(list) {
  return (list || []).map(x => {
    const d = /^\d{4}-\d{2}-\d{2}$/.test(String(x.date || "")) ? new Date(x.date + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : String(x.date || "");
    return `${d} · ${x.description} — $${Number(x.amount || 0).toFixed(2)} (${[x.frequency, x.paidFrom].filter(Boolean).join(", ")})`;
  });
}

export async function sendDigestHeartbeatEmail(env, { lastSentAt = "", inTransit = [], awaitingPickup = [], awaitingBlanks = [], maintenanceDue = [], rushToSet = [], recurringRecorded = [], adminUrl = adminSiteUrl_(env) } = {}) {
  const tz = await timeZone_(env);   // Region setting, else TIMEZONE, else UTC
  const when = (iso) => new Date(iso).toLocaleString("en-US", { timeZone: tz, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  const watching = [
    inTransit.length ? n(inTransit.length, "package in transit", "packages in transit") : "",
    awaitingPickup.length ? n(awaitingPickup.length, "label waiting for the carrier", "labels waiting for the carrier") : "",
    awaitingBlanks.length ? n(awaitingBlanks.length, "blank order not yet received", "blank orders not yet received") : "",
    (rushToSet || []).length ? n(rushToSet.length, "rush fee still to set", "rush fees still to set") : "",
  ].filter(Boolean);
  const since = lastSentAt ? `since the last roll-up on ${when(lastSentAt)}` : "yet";
  const lines = [
    `The morning check ran at ${when(new Date().toISOString())} and found nothing new ${since}: no new orders, payments, refunds, deliveries or problems.`,
    watching.length ? `Still being watched: ${watching.join(", ")}.` : "",
    maintenanceDue.length ? `Machine maintenance due: ${maintenanceText_(maintenanceDue).join("; ")}.` : "",
    (recurringRecorded || []).length ? `Recurring expenses recorded: ${recurringText_(recurringRecorded).join("; ")}.` : "",
    adminUrl ? `Details: ${adminUrl}/#comms` : "Details: Tools → Communications in the program.",
  ].filter(Boolean);
  const html = `<div style="font-family:system-ui,sans-serif;font-size:14px;color:#222;line-height:1.5;">` +
    lines.slice(0, -1).map(l => `<p style="margin:0 0 8px;">${escHtml(l)}</p>`).join("") +
    (adminUrl ? `<p style="margin:0;"><a href="${escHtml(adminUrl)}/#comms">Open Communications</a></p>` : `<p style="margin:0;">${escHtml(lines[lines.length - 1])}</p>`) + `</div>`;
  return send_(env, { to: ORDER_NOTIFICATION_EMAIL, subject: "Daily roll-up — nothing new", html, text: lines.join("\n\n") });
}

// Sent to owner once a day (about 6 AM local time, from the Worker's scheduled handler —
// see src/worker.js): every order placed since the last roll-up plus
// every queued owner notice (Stripe payments/refunds/disputes, design
// responses) — in place of one email each. Not sent when there's nothing new (the scheduled run then
// sends sendDigestHeartbeatEmail instead, so a quiet morning still proves the roll-up ran).
// pickedUp = orders the tracking check just marked shipped (carrier's first scan); awaitingPickup =
// orders with a label the carrier hasn't scanned yet (listed for the record, never a reason to send).
export async function sendDailyDigestEmail(env, { orders = [], notices = [], orgNames = {}, security = null, inTransit = [], pickedUp = [], awaitingPickup = [], issues = [], awaitingBlanks = [], priceReminder = null, belowTarget = [], maintenanceDue = [], rushToSet = [], recurringRecorded = [], adminUrl = adminSiteUrl_(env) }) {
  issues = issues || [];
  recurringRecorded = recurringRecorded || [];
  rushToSet = rushToSet || [];
  belowTarget = belowTarget || [];
  const pr = priceReminder && ((priceReminder.blanks || []).length || (priceReminder.products || []).length) ? priceReminder : null;
  awaitingBlanks = awaitingBlanks || [];
  const blanksOverdue = awaitingBlanks.filter(x => x.overdue);
  if (!orders.length && !notices.length && !(security && security.count) && !pickedUp.length && !issues.length && !blanksOverdue.length && !pr && !belowTarget.length) return false;
  const orgName = (id) => orgNames[id] || id || "";
  const tz = await timeZone_(env);   // Region setting, else TIMEZONE, else UTC
  const when = (iso) => new Date(iso).toLocaleString("en-US", { timeZone: tz, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const total = orders.reduce((s, o) => s + Math.round(Number(o.total) * 100), 0) / 100;
  const byOrg = {};
  for (const o of orders) {
    const g = (byOrg[o.orgId] = byOrg[o.orgId] || { name: orgName(o.orgId), orders: [], total: 0 });
    g.orders.push(o); g.total += Math.round(Number(o.total) * 100);
  }
  const groups = Object.values(byOrg).sort((a, b) => a.name.localeCompare(b.name));
  const urgent = notices.filter(x => x.urgent);
  const delivered = notices.filter(x => x.kind === "delivered" && !x.urgent);
  const activity = notices.filter(x => !x.urgent && x.kind !== "delivered");
  const n = orders.length;
  const plural = (k, word) => `${k} ${word}${k === 1 ? "" : "s"}`;
  const kindCount = (kind, word) => { const k = notices.filter(x => x.kind === kind).length; return k ? plural(k, word) : ""; };
  const sec = security && security.count ? security : null;
  const issueCount = issues.reduce((s, x) => s + (Number(x.count) || 0), 0);
  const subjectParts = [
    issueCount ? `⚠️ ${plural(issueCount, "problem")}` : "",
    blanksOverdue.length ? `⚠️ ${plural(blanksOverdue.length, "blank order")} overdue` : "",
    sec ? `🔒 ${plural(sec.count, "failed admin sign-in")}` : "",
    urgent.length ? `⚠️ ${plural(urgent.length, "dispute")} filed` : "",
    n ? `${plural(n, "new order")} (${fmt$(total)})` : "",
    kindCount("payment", "payment"), kindCount("refund", "refund"),
    (k => k ? plural(k, "dispute update") : "")(activity.filter(x => x.kind === "dispute").length),
    kindCount("design", "design response"),
    delivered.length ? `${delivered.length} ${delivered.length === 1 ? "delivery" : "deliveries"}` : "",
    pickedUp.length ? `${pickedUp.length} picked up by carrier` : "",
    inTransit.length ? `${inTransit.length} in transit` : "",
    pr ? "💲 blank prices to check" : "",
    belowTarget.length ? `📉 ${plural(belowTarget.length, "product")} below price target` : "",
  ].filter(Boolean);
  const subject = `Daily roll-up — ${subjectParts.join(", ")}`;

  const itemLine = (it) => `${it.qty}× ${it.name}${it.size ? ` (${it.size})` : ""}${lineDetail_(it) ? ` [${lineDetail_(it)}]` : ""}${it.cancelDate ? " — cancelled" : ""}`;
  const orderHtml = (o) => `
    <tr style="border-top:1px solid #e5e7eb">
      <td style="padding:6px 8px;vertical-align:top;white-space:nowrap">${escHtml(o.orderId)}<br><span style="color:#666;font-size:12px">${escHtml(when(o.placedAt))}</span></td>
      <td style="padding:6px 8px;vertical-align:top">${escHtml(o.customerName)}<br><span style="color:#666;font-size:12px">${escHtml(o.contact || "")}</span>${o.rushRequested ? `<br><span style="color:#b45309;font-size:12px;font-weight:600">${escHtml(rushTag_(o))}</span>` : ""}</td>
      <td style="padding:6px 8px;vertical-align:top;font-size:13px">${(o.items || []).map(it => escHtml(itemLine(it))).join("<br>")}</td>
      <td style="padding:6px 8px;vertical-align:top;white-space:nowrap">${escHtml(o.paymentMethod || "")}<br><span style="font-size:12px;color:${o.paid ? "#15803d" : "#b45309"}">${o.paid ? "Paid" : "Unpaid"}</span></td>
      <td style="padding:6px 8px;vertical-align:top;text-align:right;white-space:nowrap">${fmt$(o.total)}</td>
    </tr>`;
  const KIND = { payment: "Payment", refund: "Refund", dispute: "Dispute", design: "Design", delivered: "Delivered", invoice: "Invoice" };
  const noticeHtml = (x) => `
    <tr style="border-top:1px solid #e5e7eb">
      <td style="padding:6px 8px;vertical-align:top;white-space:nowrap;color:#666;font-size:12px">${escHtml(when(x.createdAt))}</td>
      <td style="padding:6px 8px;vertical-align:top;white-space:nowrap">${escHtml(KIND[x.kind] || x.kind)}</td>
      <td style="padding:6px 8px;vertical-align:top;white-space:nowrap">${escHtml(x.orderId)}<br><span style="color:#666;font-size:12px">${escHtml(orgName(x.orgId))}</span></td>
      <td style="padding:6px 8px;vertical-align:top">${escHtml(x.summary)}${x.detail ? `<br><span style="color:#555;font-size:13px">${escHtml(x.detail).replace(/\n/g, "<br>")}</span>` : ""}${(x.imageUrls || []).length ? "<br>" + x.imageUrls.map((u, i) => `<a href="${escHtml(u)}" style="font-size:12px">image ${i + 1}</a>`).join(" · ") : ""}</td>
    </tr>`;
  const noticeTable = (rows) => `<table style="width:100%;border-collapse:collapse;font-size:14px">
      <thead><tr style="background:#f5f5f5;text-align:left"><th style="padding:4px 8px">When</th><th style="padding:4px 8px">Type</th><th style="padding:4px 8px">Order</th><th style="padding:4px 8px">Details</th></tr></thead>
      <tbody>${rows.map(noticeHtml).join("")}</tbody></table>`;

  const html = `<div style="font-family:sans-serif;max-width:760px;margin:auto">
    <h2 style="margin:0 0 4px">Daily roll-up</h2>
    <p style="color:#555;margin:0 0 16px">Everything since the last roll-up.${adminUrl ? ` <a href="${escHtml(adminUrl)}">Open the admin panel</a>` : ""}</p>
    ${sec ? `<div style="border:2px solid #b45309;border-radius:6px;padding:10px 12px;margin-bottom:18px;background:#fffbeb">
      <h3 style="margin:0 0 6px;color:#92400e;font-size:16px">🔒 ${plural(sec.count, "failed admin sign-in")}</h3>
      <p style="margin:0;font-size:14px">${Number(sec.passphrase || 0)} wrong password, ${Number(sec.code || 0)} wrong 2FA code, between ${escHtml(when(sec.first))} and ${escHtml(when(sec.last))}, from ${escHtml((sec.ips || []).join(", ") || "unknown IPs")}.
      ${Number(sec.code || 0) > 0 ? "<br><strong>A wrong 2FA code means the password was right — change it if that wasn't you.</strong>" : ""}</p></div>` : ""}
    ${issues.length ? `<div style="border:2px solid #b45309;border-radius:6px;padding:10px 12px;margin-bottom:18px;background:#fffbeb">
      <h3 style="margin:0 0 6px;color:#92400e;font-size:16px">⚠️ Problems since the last roll-up</h3>
      <ul style="margin:0;padding-left:18px;font-size:14px">${issues.map(x => `<li><strong>${escHtml(x.label)}: ${Number(x.count)}</strong>
        <span style="color:#666;font-size:12px">(${escHtml(when(x.first))}${x.count > 1 ? " – " + escHtml(when(x.last)) : ""})</span>
        ${(x.samples || []).length ? `<br><span style="color:#555;font-size:12px">e.g. ${x.samples.map(escHtml).join(" · ")}</span>` : ""}</li>`).join("")}</ul>
      <p style="margin:6px 0 0;font-size:12px;color:#555">Details are in ${isDesktop_(env) ? "the program's log (Help → Open the log)" : "the Cloudflare logs"} for those times.</p></div>` : ""}
    ${urgent.length ? `<div style="border:2px solid #b91c1c;border-radius:6px;padding:10px 12px;margin-bottom:18px;background:#fef2f2">
      <h3 style="margin:0 0 6px;color:#b91c1c;font-size:16px">⚠️ Needs attention</h3>${noticeTable(urgent)}</div>` : ""}
    ${n ? `<h3 style="margin:0 0 4px;font-size:17px">${plural(n, "new order")} — ${fmt$(total)}</h3>` + groups.map(g => `
      <h4 style="margin:14px 0 6px;font-size:15px">${escHtml(g.name)} — ${plural(g.orders.length, "order")}, ${fmt$(g.total / 100)}</h4>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead><tr style="background:#f5f5f5;text-align:left"><th style="padding:4px 8px">Order</th><th style="padding:4px 8px">Customer</th><th style="padding:4px 8px">Items</th><th style="padding:4px 8px">Payment</th><th style="padding:4px 8px;text-align:right">Total</th></tr></thead>
        <tbody>${g.orders.map(orderHtml).join("")}</tbody>
      </table>`).join("") : ""}
    ${delivered.length ? `<h3 style="margin:22px 0 6px;font-size:17px">📦 Delivered — ${delivered.length}</h3>
      <p style="margin:0 0 6px;color:#555;font-size:13px">Tracking shows these arrived; they're marked delivered. Mark them completed on the orders screen once paid in full.</p>${noticeTable(delivered)}` : ""}
    ${pickedUp.length ? `<h3 style="margin:22px 0 6px;font-size:17px">📮 Picked up by the carrier — ${pickedUp.length}</h3>
      <p style="margin:0 0 6px;color:#555;font-size:13px">Tracking shows the carrier has these, so they're now marked shipped (dated by the first scan) and each customer was emailed their tracking.</p>
      ${shipmentTable_(pickedUp, orgName, (x) => `Shipped ${escHtml(x.shippedAtLabel || "")}${x.customerEmailed === false ? `<br><span style="color:#b45309;font-size:12px">customer email not sent</span>` : ""}`)}` : ""}
    ${inTransit.length ? `<h3 style="margin:22px 0 6px;font-size:17px">🚚 In transit — ${inTransit.length}</h3>
      <p style="margin:0 0 6px;color:#555;font-size:13px">Shipped but not yet delivered. Status as of this morning's check.</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead><tr style="background:#f5f5f5;text-align:left"><th style="padding:4px 8px">Order</th><th style="padding:4px 8px">Customer</th><th style="padding:4px 8px">Tracking</th><th style="padding:4px 8px">Status</th></tr></thead>
        <tbody>${inTransit.map(x => `
          <tr style="border-top:1px solid #e5e7eb">
            <td style="padding:6px 8px;vertical-align:top;white-space:nowrap">${escHtml(x.orderId)}<br><span style="color:#666;font-size:12px">${escHtml(orgName(x.orgId))}</span></td>
            <td style="padding:6px 8px;vertical-align:top">${escHtml(x.customerName)}</td>
            <td style="padding:6px 8px;vertical-align:top;white-space:nowrap;font-size:13px">${escHtml(x.carrier)} ${escHtml(x.tracking)}</td>
            <td style="padding:6px 8px;vertical-align:top;font-size:13px">${escHtml(x.status)}${x.statusDate ? `<br><span style="color:#666;font-size:12px">${escHtml(x.statusDate)}</span>` : ""}${x.statusDetail ? `<br><span style="color:#888;font-size:12px">${escHtml(x.statusDetail)}</span>` : ""}</td>
          </tr>`).join("")}
        </tbody>
      </table>` : ""}
    ${awaitingPickup.length ? `<h3 style="margin:22px 0 6px;font-size:17px">🏷 Label created, not shipped yet — ${awaitingPickup.length}</h3>
      <p style="margin:0 0 6px;color:#555;font-size:13px">These have a label, but the carrier hasn't scanned them yet. They'll be marked shipped automatically once tracking shows a scan.</p>
      ${shipmentTable_(awaitingPickup, orgName, (x) => `Label ${escHtml(x.labelAtLabel || "")}`)}` : ""}
    ${awaitingBlanks.length ? `<h3 style="margin:22px 0 6px;font-size:17px">🧵 Blanks ordered, not yet received — ${awaitingBlanks.length}</h3>
      <p style="margin:0 0 6px;color:#555;font-size:13px">Ordered from a vendor but not marked received. Overdue ones (past the expected date) are flagged — chase the vendor so an order can't be lost.</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead><tr style="background:#f5f5f5;text-align:left"><th style="padding:4px 8px">Order</th><th style="padding:4px 8px">Vendor</th><th style="padding:4px 8px">Ordered</th><th style="padding:4px 8px">Status</th></tr></thead>
        <tbody>${awaitingBlanks.map(x => `<tr style="border-top:1px solid #e5e7eb">
          <td style="padding:6px 8px;vertical-align:top;white-space:nowrap">${escHtml(x.orderId)}<br><span style="color:#666;font-size:12px">${escHtml(x.customerName || "")} · ${escHtml(orgName(x.orgId))}</span></td>
          <td style="padding:6px 8px;vertical-align:top">${escHtml([x.blankVendor, x.blankVendorOrderId && "#" + x.blankVendorOrderId].filter(Boolean).join(" "))}</td>
          <td style="padding:6px 8px;vertical-align:top;white-space:nowrap;color:#666">${escHtml(x.orderedDate || "")}</td>
          <td style="padding:6px 8px;vertical-align:top;${x.overdue ? "color:#b03a2e;font-weight:600" : "color:#555"}">${escHtml(x.statusLabel || "")}${(x.shipments || []).map(s => `<div style="font-size:12px;color:#555;margin-top:2px;font-weight:400">📦 ${escHtml(s.carrier || "")} ${(u => u ? `<a href="${escHtml(u)}">${escHtml(s.trackingNumber)}</a>` : escHtml(s.trackingNumber))(trackingUrl(s.carrier, s.trackingNumber))}${s.status ? ` — ${escHtml(blankStatusText_(s))}` : ""}${s.statusDate ? " (" + escHtml(when(s.statusDate)) + ")" : ""}</div>`).join("")}</td>
        </tr>`).join("")}</tbody></table>` : ""}
    ${activity.length ? `<h3 style="margin:22px 0 6px;font-size:17px">Payments, refunds &amp; customer responses</h3>${noticeTable(activity)}` : ""}
    ${pr ? priceReminderHtml_(pr, orgName, tz) : ""}
    ${belowTarget.length ? `<h3 style="margin:22px 0 6px;font-size:17px">📉 Products now below your price targets — ${belowTarget.length}</h3>
    <p style="margin:0 0 6px;color:#555;font-size:13px">A blank's cost, a fee or a target changed since the last roll-up. The product's Pricing panel shows what each item costs and leaves.</p>
    <ul style="margin:0;padding-left:18px;font-size:14px">${belowTarget.map(p => `<li><strong>${escHtml(p.name)}</strong> <span style="color:#666">(${escHtml(orgName(p.orgId))})</span><br><span style="font-size:13px;color:#555">${(p.problems || []).map(escHtml).join("<br>")}</span></li>`).join("")}</ul>` : ""}
    ${rushToSet.length ? `<h3 style="margin:22px 0 6px;font-size:17px">⚡ Rush fees to set — ${rushToSet.length}</h3>
    <p style="margin:0 0 6px;color:#555;font-size:13px">These rush orders were placed with the fee to follow. Set it on the order (Orders → Rush…) and send the customer an invoice.</p>
    <ul style="margin:0;padding-left:18px;font-size:14px">${rushToSet.map(x => `<li>${escHtml(x.orderId)} — ${escHtml(x.customerName)} <span style="color:#666">(${escHtml(orgName(x.orgId))})</span>${x.dueDate ? ` · needed by ${escHtml(x.dueDate)}` : ""}</li>`).join("")}</ul>` : ""}
    ${maintenanceDue.length ? `<h3 style="margin:22px 0 6px;font-size:17px">🔧 Machine maintenance due — ${maintenanceDue.length}</h3>
    <ul style="margin:0;padding-left:18px;font-size:14px">${maintenanceText_(maintenanceDue).map(x => `<li>${escHtml(x)}</li>`).join("")}</ul>
    ${adminUrl ? `<p style="margin:6px 0 0;font-size:13px"><a href="${escHtml(adminUrl)}/#maintenance">Machine maintenance</a></p>` : ""}` : ""}
    ${recurringRecorded.length ? `<h3 style="margin:22px 0 6px;font-size:17px">🔁 Recurring expenses recorded — ${recurringRecorded.length}</h3>
    <ul style="margin:0;padding-left:18px;font-size:14px">${recurringText_(recurringRecorded).map(x => `<li>${escHtml(x)}</li>`).join("")}</ul>
    ${adminUrl ? `<p style="margin:6px 0 0;font-size:13px"><a href="${escHtml(adminUrl)}/#expenses">Expenses</a></p>` : ""}` : ""}
    <hr/><p style="font-size:12px;color:#666">%%BUSINESS%% — daily roll-up</p>
  </div>`;
  const noticeText = (x) => `  ${when(x.createdAt)}  ${KIND[x.kind] || x.kind}  ${x.orderId} (${orgName(x.orgId)})  ${x.summary}${x.detail ? " — " + x.detail : ""}`;
  const text = [
    issues.length ? "PROBLEMS SINCE THE LAST ROLL-UP\n" + issues.map(x => `  ${x.label}: ${x.count}${(x.samples || []).length ? " — e.g. " + x.samples.join(" · ") : ""}`).join("\n") : "",
    sec ? `SECURITY: ${plural(sec.count, "failed admin sign-in")} (${Number(sec.passphrase || 0)} wrong password, ${Number(sec.code || 0)} wrong 2FA code) from ${(sec.ips || []).join(", ") || "unknown IPs"}` +
      (Number(sec.code || 0) > 0 ? " — a wrong 2FA code means the passphrase was right; change it if that wasn't you." : "") : "",
    urgent.length ? "NEEDS ATTENTION\n" + urgent.map(noticeText).join("\n") : "",
    n ? `${plural(n, "new order")} — ${fmt$(total)}\n\n` + groups.map(g =>
      `${g.name} — ${plural(g.orders.length, "order")}, ${fmt$(g.total / 100)}\n` + g.orders.map(o =>
        `  ${o.orderId}  ${o.customerName} <${o.contact || ""}>  ${o.paymentMethod || ""} ${o.paid ? "(paid)" : "(unpaid)"}  ${fmt$(o.total)}${o.rushRequested ? "  " + rushTag_(o) : ""}\n` +
        (o.items || []).map(it => "    " + itemLine(it)).join("\n")).join("\n")).join("\n\n") : "",
    delivered.length ? `DELIVERED — ${delivered.length}\n` + delivered.map(noticeText).join("\n") : "",
    pickedUp.length ? `PICKED UP BY THE CARRIER (now marked shipped) — ${pickedUp.length}\n` + pickedUp.map(x =>
      `  ${x.orderId} (${orgName(x.orgId)})  ${x.customerName}  ${x.carrier} ${x.tracking}  shipped ${x.shippedAtLabel || ""}${x.customerEmailed === false ? "  (customer email not sent)" : ""}`).join("\n") : "",
    awaitingPickup.length ? `LABEL CREATED, NOT SHIPPED YET — ${awaitingPickup.length}\n` + awaitingPickup.map(x =>
      `  ${x.orderId} (${orgName(x.orgId)})  ${x.customerName}  ${x.carrier} ${x.tracking}  label ${x.labelAtLabel || ""}`).join("\n") : "",
    inTransit.length ? `IN TRANSIT — ${inTransit.length}\n` + inTransit.map(x =>
      `  ${x.orderId} (${orgName(x.orgId)})  ${x.customerName}  ${x.carrier} ${x.tracking}  ${x.status}${x.statusDate ? " — " + x.statusDate : ""}${x.statusDetail ? " — " + x.statusDetail : ""}`).join("\n") : "",
    awaitingBlanks.length ? `BLANKS ORDERED, NOT YET RECEIVED — ${awaitingBlanks.length}\n` + awaitingBlanks.map(x =>
      ((main) => main + (x.shipments || []).map(s => `\n      📦 ${s.carrier || ""} ${s.trackingNumber}${s.status ? " — " + blankStatusText_(s) : ""} ${trackingUrl(s.carrier, s.trackingNumber)}`).join(""))(
      `  ${x.orderId} (${orgName(x.orgId)})  ${x.customerName || ""}  ${[x.blankVendor, x.blankVendorOrderId && "#" + x.blankVendorOrderId].filter(Boolean).join(" ")}  ordered ${x.orderedDate || "?"}  — ${x.statusLabel || ""}`)).join("\n") : "",
    activity.length ? "Payments, refunds & customer responses\n" + activity.map(noticeText).join("\n") : "",
    pr ? priceReminderText_(pr, orgName, tz) : "",
    belowTarget.length ? `PRODUCTS NOW BELOW YOUR PRICE TARGETS — ${belowTarget.length}\n` + belowTarget.map(p => `  ${p.name} (${orgName(p.orgId)})\n` + (p.problems || []).map(x => "    " + x).join("\n")).join("\n") : "",
    rushToSet.length ? `RUSH FEES TO SET — ${rushToSet.length}\n` + rushToSet.map(x => `  ${x.orderId} (${orgName(x.orgId)})  ${x.customerName}${x.dueDate ? "  needed by " + x.dueDate : ""}`).join("\n") : "",
    maintenanceDue.length ? `MACHINE MAINTENANCE DUE — ${maintenanceDue.length}\n` + maintenanceText_(maintenanceDue).map(x => "  " + x).join("\n") : "",
    recurringRecorded.length ? `RECURRING EXPENSES RECORDED — ${recurringRecorded.length}\n` + recurringText_(recurringRecorded).map(x => "  " + x).join("\n") : "",
    adminUrl,
  ].filter(Boolean).join("\n\n");
  return send_(env, { to: ORDER_NOTIFICATION_EMAIL, subject, html, text });
}

// The 30-day vendor-price reminder (migrations/0062): blanks for sale on visible products whose vendor
// prices haven't been checked in 30 days, then products priced on blank prices that have changed.
const money_ = (v) => v == null ? "not entered" : fmt$(v);
const priceChecked_ = (b, tz) => b.checkedAt ? "last checked " + new Date(b.checkedAt).toLocaleDateString("en-US", { timeZone: tz || "UTC", month: "short", day: "numeric", year: "numeric" }) : "never checked";
const priceChange_ = (c) => `${c.blankName}${c.color ? " " + c.color : ""}${c.size ? " " + c.size : ""}: ${money_(c.from)} → ${money_(c.to)}`;
function priceReminderHtml_(pr, orgName, tz) {
  const blanks = pr.blanks || [], products = pr.products || [];
  return `<h3 style="margin:22px 0 6px;font-size:17px">💲 Blank prices to check (every 30 days)</h3>
    ${blanks.length ? `<p style="margin:0 0 6px;color:#555;font-size:13px">These blanks are used by products on sale. Check each one's prices with the vendor and enter any change on the blank (Blanks → Edit), or click “Prices are current” there.</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <thead><tr style="background:#f5f5f5;text-align:left"><th style="padding:4px 8px">Blank</th><th style="padding:4px 8px">Prices</th><th style="padding:4px 8px">Used by</th></tr></thead>
      <tbody>${blanks.map(b => `<tr style="border-top:1px solid #e5e7eb">
        <td style="padding:6px 8px;vertical-align:top">${escHtml(b.name)}${b.vendor ? `<br><span style="color:#666;font-size:12px">${escHtml(b.vendor)}</span>` : ""}</td>
        <td style="padding:6px 8px;vertical-align:top;font-size:13px;color:#555">${escHtml(priceChecked_(b, tz))}<br>${Number(b.sizesWithPrice) || 0} of ${Number(b.sizes) || 0} sizes have a vendor price</td>
        <td style="padding:6px 8px;vertical-align:top;font-size:13px">${(b.products || []).slice(0, 8).map(p => escHtml(p.name) + ` <span style="color:#666">(${escHtml(orgName(p.orgId))})</span>`).join("<br>")}${(b.products || []).length > 8 ? `<br>+${b.products.length - 8} more` : ""}</td>
      </tr>`).join("")}</tbody></table>` : ""}
    ${products.length ? `<h4 style="margin:14px 0 6px;font-size:15px">Products to re-price — ${products.length}</h4>
    <p style="margin:0 0 6px;color:#555;font-size:13px">Their prices were set when these blanks cost something else. Update the product's prices, or open it and click “Prices still OK”.</p>
    <ul style="margin:0;padding-left:18px;font-size:14px">${products.map(p => `<li><strong>${escHtml(p.name)}</strong> <span style="color:#666">(${escHtml(orgName(p.orgId))})</span><br><span style="font-size:13px;color:#555">${p.changes.map(c => escHtml(priceChange_(c))).join("<br>")}</span></li>`).join("")}</ul>` : ""}`;
}
function priceReminderText_(pr, orgName, tz) {
  const blanks = pr.blanks || [], products = pr.products || [];
  return [
    blanks.length ? `BLANK PRICES TO CHECK (every 30 days) — ${blanks.length}\n` + blanks.map(b =>
      `  ${b.name}${b.vendor ? " (" + b.vendor + ")" : ""} — ${priceChecked_(b, tz)}, ${Number(b.sizesWithPrice) || 0} of ${Number(b.sizes) || 0} sizes priced — used by ${(b.products || []).map(p => p.name + " (" + orgName(p.orgId) + ")").join(", ")}`).join("\n") : "",
    products.length ? `PRODUCTS TO RE-PRICE — ${products.length}\n` + products.map(p =>
      `  ${p.name} (${orgName(p.orgId)})\n` + p.changes.map(c => "    " + priceChange_(c)).join("\n")).join("\n") : "",
  ].filter(Boolean).join("\n\n");
}

// Order / customer / tracking / status table shared by the roll-up's shipment sections.
function shipmentTable_(rows, orgName, statusHtml) {
  return `<table style="width:100%;border-collapse:collapse;font-size:14px">
    <thead><tr style="background:#f5f5f5;text-align:left"><th style="padding:4px 8px">Order</th><th style="padding:4px 8px">Customer</th><th style="padding:4px 8px">Tracking</th><th style="padding:4px 8px">Status</th></tr></thead>
    <tbody>${rows.map(x => `
      <tr style="border-top:1px solid #e5e7eb">
        <td style="padding:6px 8px;vertical-align:top;white-space:nowrap">${escHtml(x.orderId)}<br><span style="color:#666;font-size:12px">${escHtml(orgName(x.orgId))}</span></td>
        <td style="padding:6px 8px;vertical-align:top">${escHtml(x.customerName)}</td>
        <td style="padding:6px 8px;vertical-align:top;white-space:nowrap;font-size:13px">${escHtml(x.carrier)} ${escHtml(x.tracking)}</td>
        <td style="padding:6px 8px;vertical-align:top;font-size:13px">${statusHtml(x)}</td>
      </tr>`).join("")}</tbody></table>`;
}

// "Includes $X.XX sales tax (6%)" under the total: with tax-inclusive prices the
// tax is shown as part of the total, never added to it (tax added on top gets a
// "Sales tax (6%)" row above the Total instead — receiptTotalsHtml_). Omitted when
// the order carries no tax figures or is tax-exempt.
// Sent to the customer when their payment is recorded (Mark as paid, or Resend on a paid order).
function paymentReceivedSubject_(order) {
  const due = Math.max(0, rcCents_(order.balanceDue));
  return `Payment received — ${order.orderId} · ${due > 0 ? fmtCents_(due) + " still due" : "paid in full"}`;
}
export async function buildPaymentReceivedEmail(env, order, paidAt, { pdf = true } = {}) {
  const subject = paymentReceivedSubject_(order);
  const p = await businessProfile_(env);
  const paidDate = paidAt ? new Date(paidAt).toLocaleDateString("en-US", { timeZone: await timeZone_(env), month: "long", day: "numeric", year: "numeric" }) : "";
  const r = receiptLines_(order);
  const due = Math.max(0, Number(order.balanceDue) || 0);
  const received = Number(order.amountReceived) || 0;
  const attachment = pdf ? await orderPdfAttachment_(env, order, { kind: "receipt" }) : null;
  const pay = due > 0 ? await howToPay_(env, order, { profile: p }) : null;
  const biz = businessBlock_(p, env);
  const what = `We received your payment${received > 0 ? " of " + fmt$(received) : ""}${order.paymentMethod ? " by " + order.paymentMethod : ""}${paidDate ? " on " + paidDate : ""}.`;
  const status = due > 0 ? `${fmt$(due)} is still due.` : "Your order is paid in full. Thank you!";
  const rows = [...r.rows, ...paymentRows_(order)];
  const html = `<div style="font-family:sans-serif;max-width:600px;margin:auto">
    <h2 style="color:#15803d">Payment received</h2>
    <p>Hi ${escHtml(order.customerName)}, ${escHtml(what)} ${escHtml(status)}${attachment ? " Your receipt is attached as a PDF." : ""}</p>
    <p><strong>Order number:</strong> ${escHtml(order.orderId)}</p>
    ${itemsTableHtml_(r)}
    ${totalsHtml_(rows)}
    ${pay && pay.any ? pay.html : ""}
    ${biz.html}
  </div>`;
  const text = `Payment received — ${order.orderId}\n\nHi ${order.customerName},\n${what} ${status}\n\nOrder number: ${order.orderId}\n\n${itemsText_(r)}\n\n${totalsText_(r, rows)}\n` +
    (pay && pay.any ? "\n" + pay.text + "\n" : "") + `\n${biz.text}`;
  return { to: order.contact, subject, html, text, ...(attachment ? { attachments: [attachment] } : {}) };
}
export async function sendPaymentConfirmedEmail(env, order, paidAt) {
  return send_(env, await buildPaymentReceivedEmail(env, order, paidAt));
}

// The carrier's public tracking page for a tracking number. carrier is a label carrier / shipping
// method / Shippo token ("USPS Ground Advantage", "ups", "dhl_express"…); unknown → USPS.
export function trackingUrl(carrier, tracking) {
  const t = String(carrier || "").toLowerCase(), n = encodeURIComponent(String(tracking || "").trim());
  if (!n) return "";
  if (/\bups\b/.test(t) && !/usps/.test(t)) return "https://www.ups.com/track?tracknum=" + n;
  if (/fedex/.test(t)) return "https://www.fedex.com/fedextrack/?trknbr=" + n;
  if (/dhl/.test(t)) return "https://www.dhl.com/us-en/home/tracking/tracking-express.html?tracking-id=" + n;
  return "https://tools.usps.com/go/TrackConfirmAction?tLabels=" + n;
}

// Sent to the customer ONCE, when an order first becomes shipped — the daily tracking check saw the
// carrier's first scan, or the admin marked it shipped. Never when a label is merely bought.
// shipment = { carrier, tracking, shippedAt }. Returns true/false like every send here.
export async function sendShippedEmail(env, order, shipment = {}) {
  if (!order || !order.contact || !String(order.contact).includes("@")) return false;
  return send_(env, buildShippedEmail(env, order, shipment));
}
export function buildShippedEmail(env, order, shipment = {}) {
  const tracking = String(shipment.tracking || "").trim();
  const carrierName = String(shipment.carrier || "").trim();
  const url = trackingUrl(carrierName || order.shippingMethod, tracking);
  const subject = `Your order has shipped — ${order.orderId}`;
  const active = (order.items || []).filter(it => !it.cancelDate);
  const html = `<div style="font-family:sans-serif;max-width:600px;margin:auto">
    <h2 style="color:#15803d">Your order is on its way</h2>
    <p>Hi ${escHtml(order.customerName)}, your order has been handed to the carrier.</p>
    <p><strong>Order ID:</strong> ${escHtml(order.orderId)}</p>
    ${tracking ? `<p><strong>Tracking${carrierName ? ` (${escHtml(carrierName)})` : ""}:</strong> ${url ? `<a href="${escHtml(url)}">${escHtml(tracking)}</a>` : escHtml(tracking)}</p>` : ""}
    ${itemsTable(active, order)}
    <p style="font-size:13px;color:#555">Questions? Reply to this email.</p>
    %%FOOTER_HTML%%
  </div>`;
  const text = `Your order has shipped — ${order.orderId}\n\nHi ${order.customerName},\nYour order has been handed to the carrier.` +
    (tracking ? `\nTracking${carrierName ? ` (${carrierName})` : ""}: ${tracking}${url ? `\n${url}` : ""}` : "") +
    `\n\nQuestions? Reply to this email.\n\n%%FOOTER_TEXT%%`;
  return { to: order.contact, subject, html, text };
}

// Sent to owner when Stripe auto-confirms a payment (webhook path).
export async function sendStripePaymentNotification(env, orderId, orgId, amountPaid) {
  const subject = `Payment confirmed (Stripe) — ${orgId} — ${orderId}`;
  const text = `Stripe confirmed payment of ${fmt$(amountPaid || 0)} for order ${orderId} (org: ${orgId}).`;
  return queueOwnerNotice_(env, { kind: "payment", orderId, orgId, summary: `Stripe payment ${fmt$(amountPaid || 0)}` },
    { to: ORDER_NOTIFICATION_EMAIL, subject, html: `<p>${escHtml(text)}</p>`, text });
}

// Sent to owner when a refund is processed by Stripe.
export async function sendRefundNotification(env, orderId, orgId, amountRefunded) {
  const subject = `Refund processed — ${orgId} — ${orderId}`;
  const text = `Stripe refund of ${fmt$(amountRefunded || 0)} processed for order ${orderId} (org: ${orgId}).`;
  return queueOwnerNotice_(env, { kind: "refund", orderId, orgId, summary: `Stripe refund ${fmt$(amountRefunded || 0)}` },
    { to: ORDER_NOTIFICATION_EMAIL, subject, html: `<p>${escHtml(text)}</p>`, text });
}

// Sent to owner urgently when a dispute is filed.
export async function sendDisputeNotification(env, orderId, orgId, status, reason, amount) {
  const isNew = status === "warning_needs_response";
  const subject = isNew
    ? `⚠️ DISPUTE FILED — ${orgId} — ${orderId}`
    : `Dispute ${status} — ${orgId} — ${orderId}`;
  const text = isNew
    ? `URGENT: A chargeback has been filed for order ${orderId} (org: ${orgId}). Reason: ${reason}. Amount: ${fmt$(amount || 0)}. You typically have 7–21 days to respond.`
    : `Dispute for order ${orderId} (org: ${orgId}) closed with status: ${status}. Amount: ${fmt$(amount || 0)}.`;
  return queueOwnerNotice_(env, { kind: "dispute", orderId, orgId, urgent: isNew,
      summary: isNew ? `DISPUTE FILED — ${fmt$(amount || 0)}` : `Dispute ${status} — ${fmt$(amount || 0)}`,
      detail: isNew ? `Reason: ${reason || "not given"}. Respond in the Stripe Dashboard — you typically have 7–21 days.` : "" },
    { to: ORDER_NOTIFICATION_EMAIL, subject, html: `<p>${escHtml(text)}</p>`, text });
}

// Sent to customer when a line item is cancelled.
export async function sendCancellationEmail(env, order, cancelledItems, reason, lateCancel) {
  const subject = `Order update — ${order.orderId}`;
  const itemList = cancelledItems.map((it) => `  • ${it.name} (${it.size || "One Size"})`).join("\n");
  const lateCancelNote = lateCancel ? "\n\nNote: Blank garments had already been ordered for this item. Please contact us regarding any restocking fees." : "";
  const text = `Hi ${order.customerName},\n\nThe following item(s) in order ${order.orderId} have been cancelled:\n${itemList}\nReason: ${reason}${lateCancelNote}\n\n%%FOOTER_TEXT%%`;
  const html = `<div style="font-family:sans-serif;max-width:600px;margin:auto">
    <h2>Order Update — Item Cancelled</h2>
    <p>Hi ${escHtml(order.customerName)},</p>
    <p>The following item(s) in order <strong>${escHtml(order.orderId)}</strong> have been cancelled:</p>
    <ul>${cancelledItems.map((it) => `<li>${escHtml(it.name)} (${escHtml(it.size || "One Size")})</li>`).join("")}</ul>
    <p><strong>Reason:</strong> ${escHtml(reason)}</p>
    ${lateCancel ? "<p><em>Note: Blank garments had already been ordered. Please contact us regarding any restocking fees.</em></p>" : ""}
    %%FOOTER_HTML%%
  </div>`;
  return send_(env, { to: order.contact, subject, html, text });
}

// Sent to customer with a link to review and approve/request changes on their design.
// With no verifyUrl (the desktop program: no page to open), the customer replies to the email instead,
// and `attachments` ({ filename, contentType, contentBase64, cid }) are the proof pictures, shown in
// the email by their cid.
export async function sendDesignVerificationEmail(env, { customerName, customerEmail, orderId, orgName, message, imageUrls, verifyUrl, attachments }) {
  const subject = `Design verification — ${orderId}`;
  const img = (src) => `<div style="margin:12px 0"><img src="${escHtml(src)}" alt="Design image" style="max-width:100%;border:1px solid #e5e7eb;border-radius:4px"></div>`;
  const imagesHtml = (attachments || []).map(a => img("cid:" + a.cid)).join("") + (imageUrls || []).filter(Boolean).map(img).join("");
  if (!verifyUrl) {
    const reply = "Please reply to this email: say “approved” if it's right, or tell us what you'd like changed.";
    const html = `<div style="font-family:sans-serif;max-width:600px;margin:auto">
    <h2 style="color:#1d4ed8">Design Verification — ${escHtml(orderId)}</h2>
    <p>Hi ${escHtml(customerName)},</p>
    <p>${escHtml(message).replace(/\n/g, "<br>")}</p>
    ${imagesHtml}
    <p style="background:#f0fdf4;border-left:3px solid #15803d;padding:10px 14px">${escHtml(reply)}</p>
    <p style="font-size:13px;color:#555">We won't start on your order until you've approved the design.</p>
    %%FOOTER_HTML%%
  </div>`;
    const text = `Design Verification — ${orderId}\n\nHi ${customerName},\n\n${message}\n\n` +
      ((attachments || []).length ? `The design is attached (${attachments.map(a => a.filename).join(", ")}).\n\n` : "") +
      ((imageUrls || []).length ? imageUrls.join("\n") + "\n\n" : "") + `${reply}\n\n%%FOOTER_TEXT%%`;
    return send_(env, { to: customerEmail, subject, html, text, attachments: attachments || [] });
  }
  const html = `<div style="font-family:sans-serif;max-width:600px;margin:auto">
    <h2 style="color:#1d4ed8">Design Verification — ${escHtml(orderId)}</h2>
    <p>Hi ${escHtml(customerName)},</p>
    <p>${escHtml(message).replace(/\n/g, "<br>")}</p>
    ${imagesHtml}
    <div style="margin:24px 0;text-align:center">
      <a href="${escHtml(verifyUrl)}" style="display:inline-block;background:#15803d;color:#fff;font-size:16px;font-weight:bold;padding:14px 32px;border-radius:6px;text-decoration:none">Review &amp; Respond →</a>
    </div>
    <p style="font-size:13px;color:#555">Use the button above to approve the design or request changes. If the button doesn't work, copy this link: ${escHtml(verifyUrl)}</p>
    %%FOOTER_HTML%%
  </div>`;
  const text = `Design Verification — ${orderId}\n\nHi ${customerName},\n\n${message}\n\nReview and respond here: ${verifyUrl}\n\n%%FOOTER_TEXT%%`;
  return send_(env, { to: customerEmail, subject, html, text });
}

// Sent to customer with a Stripe link to pay for shipping separately.
export async function sendShippingPaymentEmail(env, { customerName, customerEmail, orderId, shippingCost, shippingMethod, paymentUrl, customBody }) {
  const subject = `Shipping payment for order ${orderId}`;
  const methodLabel = shippingMethod ? ` (${shippingMethod})` : "";
  const bodyText = customBody || `Hi ${customerName},\n\nYour order ${orderId} is ready to ship! Please pay the shipping fee of $${Number(shippingCost).toFixed(2)}${methodLabel} using the secure link below.`;
  const bodyHtml = escHtml(bodyText).replace(/\n/g, "<br>");
  const html = `<div style="font-family:sans-serif;max-width:600px;margin:auto">
    <h2 style="color:#1d4ed8">Shipping Payment</h2>
    <p>${bodyHtml}</p>
    <div style="margin:24px 0;text-align:center">
      <a href="${escHtml(paymentUrl)}" style="display:inline-block;background:#1d4ed8;color:#fff;font-size:16px;font-weight:bold;padding:14px 32px;border-radius:6px;text-decoration:none">Pay Shipping &rarr;</a>
    </div>
    <p style="font-size:13px;color:#555">If the button doesn't work, copy this link: ${escHtml(paymentUrl)}</p>
    %%FOOTER_HTML%%
  </div>`;
  const text = `Shipping Payment for Order ${orderId}\n\n${bodyText}\n\n${paymentUrl}\n\n%%FOOTER_TEXT%%`;
  return send_(env, { to: customerEmail, subject, html, text });
}

// Sent to the customer with a link to their invoice page (/?invoice=<token>), where they choose how
// they'll get the order and pay what's owed. `order` is the saved order (so the totals are the ones on
// the books); `message` is the shop's optional note.
export async function sendInvoiceEmail(env, args) {
  return send_(env, await buildInvoiceEmail(env, args));
}
export async function buildInvoiceEmail(env, { order, orgName, invoiceUrl, message, allowDelivery }) {
  // A rush order's payment deadline (migrations/0083) goes in the subject and at the top, before anything else.
  const rushNotice = rushPayByNotice_(order);
  const subject = rushNotice
    ? `Invoice for your rush order — ${order.orderId} — full payment due by ${new Date(order.rushPayBy + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`
    : `Invoice — ${order.orderId}${Number(order.balanceDue) > 0 ? " · " + fmt$(order.balanceDue) + " due" : ""}`;
  const name = String(order.customerName || "").trim();
  const hello = name && name !== "Local Sale" ? `Hi ${name},` : "Hello,";
  // No invoice page to link to (the desktop program: it isn't on the web): the email is the invoice,
  // with how to pay from the Business profile.
  const pay = invoiceUrl ? null : await howToPay_(env, order);
  const lead = !invoiceUrl ? "Here is your invoice." : allowDelivery
    ? "Your invoice is ready. Use the button below to choose how you'd like to get your order and to pay online."
    : "Your invoice is ready. Use the button below to see the details and pay online.";
  const note = String(message || "").trim();
  const items = (order.items || []).filter(it => !it.cancelDate);
  const due = Number(order.balanceDue) || 0;
  // …and a PDF of it, which the desktop program makes (desktop/mailer.js) and attaches.
  const pdf = invoiceUrl ? null : await invoiceDocument(env, order, { orgName, message: note });
  // On the web install the PDF is drawn here (orderPdf) and attached; it says how to pay, with the invoice page.
  const attachment = pdf ? null : await orderPdfAttachment_(env, order, { kind: "invoice", orgName, message: note, payUrl: invoiceUrl });
  const attached = !!(pdf || attachment);
  const html = `<div style="font-family:sans-serif;max-width:600px;margin:auto">
    <h2 style="color:#1d4ed8">Invoice${orgName ? " — " + escHtml(orgName) : ""}</h2>
    <p>${escHtml(hello)} ${escHtml(lead)}${attached ? " It's also attached as a PDF." : ""}</p>
    ${rushNotice ? rushNotice.html : ""}
    ${note ? `<p style="background:#f8fafc;border-left:3px solid #1d4ed8;padding:10px 14px;white-space:pre-wrap">${escHtml(note)}</p>` : ""}
    <p><strong>Order ID:</strong> ${escHtml(order.orderId)}</p>
    ${itemsTable(items, order)}
    ${receiptTotalsHtml_(order)}
    ${Number(order.amountReceived) > 0 ? `<p style="font-size:14px">Paid so far: ${fmt$(order.amountReceived)} &nbsp;·&nbsp; <strong>Balance due: ${fmt$(due)}</strong></p>` : ""}
    ${invoiceUrl ? `<div style="margin:24px 0;text-align:center">
      <a href="${escHtml(invoiceUrl)}" style="display:inline-block;background:#1d4ed8;color:#fff;font-size:16px;font-weight:bold;padding:14px 32px;border-radius:6px;text-decoration:none">View &amp; pay invoice &rarr;</a>
    </div>
    ${rushNotice ? `<p style="font-size:14px;color:#9a3412;font-weight:bold;text-align:center">Reminder: full payment is due by ${escHtml(longDate_(order.rushPayBy))} to keep the rush delivery date.</p>` : ""}
    <p style="font-size:13px;color:#555">If the button doesn't work, copy this link: ${escHtml(invoiceUrl)}</p>` : pay.html}
    %%FOOTER_HTML%%
  </div>`;
  const text = `Invoice for order ${order.orderId}\n\n${hello} ${lead}${attached ? " It's also attached as a PDF." : ""}\n${rushNotice ? "\n" + rushNotice.text : ""}${note ? "\n" + note + "\n" : ""}\n${itemsText_(receiptLines_({ ...order, items }))}\n\n${receiptTotalsText_(order)}\n` +
    (Number(order.amountReceived) > 0 ? `Paid so far: ${fmt$(order.amountReceived)} · Balance due: ${fmt$(due)}\n` : "") +
    (invoiceUrl ? `\nView and pay: ${invoiceUrl}\n\n%%FOOTER_TEXT%%` : `\n${pay.text}\n\n%%FOOTER_TEXT%%`);
  return { to: order.contact, subject, html, text, ...(pdf ? { pdf } : {}), ...(attachment ? { attachments: [attachment] } : {}) };
}

// An order's invoice as a printable page, for the desktop program to make into a PDF (attached to
// the invoice email, or saved from the admin — orders.js getInvoiceDocument). Self-contained: its own
// styles, system fonts, nothing loaded from anywhere. Who it's from comes from the Business profile;
// the paper is Letter in the US and A4 elsewhere (Global settings → Region).
// Returns { filename, html, pageSize }.
export async function invoiceDocument(env, order, { orgName = "", message = "" } = {}) {
  let p = {}, country = "US";
  try { p = (await getBusinessProfile(env && env.DB)) || {}; } catch (e) { p = {}; }
  try { country = ((await getLocaleSettings(env && env.DB)) || {}).country === "OTHER" ? "OTHER" : "US"; } catch (e) { country = "US"; }
  const tz = await timeZone_(env);
  const day = (d) => { const t = new Date(d || Date.now()); return isNaN(t) ? "" : t.toLocaleDateString("en-US", { timeZone: tz, month: "long", day: "numeric", year: "numeric" }); };
  const items = (order.items || []).filter(it => !it.cancelDate);
  const due = Math.max(0, Number(order.balanceDue) || 0), received = Number(order.amountReceived) || 0;
  const pay = due > 0 ? await howToPay_(env, order, { inEmail: false }) : null;
  const lines = (v) => escHtml(String(v || "").trim()).replace(/\s*\n\s*/g, "<br>");
  const name = String(order.customerName || "").trim();
  const customer = name && name !== "Local Sale" ? name : "";
  const contact = String(order.contact || "").includes("@") ? String(order.contact) : "";
  const a = order.shippingAddress && order.shippingAddress.line1 ? order.shippingAddress : null;
  const shipTo = a ? [a.name, a.line1, a.line2, [a.city, a.state].filter(Boolean).join(", ") + (a.zip ? " " + a.zip : "")].filter(s => String(s || "").trim()) : [];
  const business = p.name || "Our shop";
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Invoice ${escHtml(order.orderId)}</title>
<style>
  body{font-family:-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;color:#1c2430;font-size:13px;line-height:1.45;margin:0}
  .head{display:flex;justify-content:space-between;gap:24px;border-bottom:3px solid #1f5f8b;padding-bottom:14px;margin-bottom:18px}
  .biz{font-size:20px;font-weight:700;margin:0 0 4px}
  .muted{color:#5a6573}
  .title{font-size:28px;font-weight:700;letter-spacing:.06em;color:#1f5f8b;margin:0;text-align:right}
  .meta td{padding:1px 0 1px 14px;text-align:right}
  .parties{display:flex;gap:40px;margin-bottom:18px}
  .label{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#5a6573;margin:0 0 4px}
  .due{margin:18px 0 0;padding:12px 14px;border:2px solid #1f5f8b;border-radius:6px;display:flex;justify-content:space-between;font-size:16px}
  .paid{margin:18px 0 0;padding:12px 14px;border:2px solid #15803d;border-radius:6px;color:#15803d;font-size:16px;font-weight:700;text-align:center}
  .note{margin:16px 0 0;padding:10px 14px;background:#f7f6f2;border-left:3px solid #1f5f8b;white-space:pre-wrap}
  .foot{margin-top:28px;padding-top:10px;border-top:1px solid #e1ddd3;font-size:11px;color:#5a6573}
  table{page-break-inside:auto} tr{page-break-inside:avoid}
</style></head><body>
  <div class="head">
    <div>
      <p class="biz">${escHtml(business)}</p>
      ${p.legalName && p.legalName !== business ? `<div class="muted">${escHtml(p.legalName)}</div>` : ""}
      ${p.mailingAddress ? `<div>${lines(p.mailingAddress)}</div>` : ""}
      ${p.supportEmail ? `<div>${escHtml(p.supportEmail)}</div>` : ""}
    </div>
    <div>
      <p class="title">INVOICE</p>
      <table class="meta"><tr><td class="muted">Invoice no.</td><td>${escHtml(order.orderId)}</td></tr>
        <tr><td class="muted">Date</td><td>${escHtml(day())}</td></tr>
        ${order.placedAt ? `<tr><td class="muted">Order date</td><td>${escHtml(day(order.placedAt))}</td></tr>` : ""}
        ${orgName ? `<tr><td class="muted">Shop</td><td>${escHtml(orgName)}</td></tr>` : ""}</table>
    </div>
  </div>
  <div class="parties">
    ${customer || contact ? `<div><p class="label">Bill to</p>${customer ? `<div>${escHtml(customer)}</div>` : ""}${contact ? `<div>${escHtml(contact)}</div>` : ""}</div>` : ""}
    ${shipTo.length ? `<div><p class="label">Ship to</p>${shipTo.map(s => `<div>${escHtml(s)}</div>`).join("")}</div>` : ""}
  </div>
  ${itemsTable(items, order)}
  ${receiptTotalsHtml_(order)}
  ${received > 0 ? `<table style="width:100%;font-size:14px;margin-top:4px"><tr><td>Paid so far</td><td style="text-align:right">−${fmt$(received)}</td></tr></table>` : ""}
  ${due > 0 ? `<div class="due"><strong>Balance due</strong><strong>${fmt$(due)}</strong></div>` : `<div class="paid">Paid in full — thank you</div>`}
  ${message ? `<div class="note">${escHtml(message)}</div>` : ""}
  ${pay ? pay.html : ""}
  <div class="foot">${[p.footer, business + (p.supportEmail ? " · " + p.supportEmail : "")].filter(Boolean).map(escHtml).join("<br>")}</div>
</body></html>`;
  return { filename: `Invoice ${order.orderId}.pdf`, html, pageSize: country === "US" ? "Letter" : "A4" };
}

// Queued for the owner's 6 AM roll-up when a customer chooses how they'll get their order on its
// invoice page (emailed at once only if it can't be queued).
export async function sendInvoiceDeliveryNotification(env, { orderId, orgId, customerName, choice, detail }) {
  const summary = `${customerName || "The customer"} chose ${choice} on their invoice`;
  const text = `${summary}\nOrder: ${orderId} (${orgId})${detail ? "\n" + detail : ""}`;
  return queueOwnerNotice_(env, { kind: "invoice", orderId, orgId, summary, detail: detail || "" },
    { to: ORDER_NOTIFICATION_EMAIL, subject: `Invoice — delivery chosen — ${orgId} — ${orderId}`,
      html: `<div style="font-family:sans-serif"><p>${escHtml(summary)}</p><p>Order ${escHtml(orderId)} (${escHtml(orgId)})</p>${detail ? `<p>${escHtml(detail)}</p>` : ""}</div>`, text });
}

// Sent to admin when a customer responds to a design verification.
export async function sendDesignVerificationResponseNotification(env, { orderId, orgId, customerName, action, note, imageUrls }) {
  const label = action === "approved" ? "✓ APPROVED" : "⚠ REVISION REQUESTED";
  const subject = `Design ${action === "approved" ? "approved" : "revision requested"} — ${orgId} — ${orderId}`;
  const imagesHtml = (imageUrls || []).filter(Boolean).map(
    u => `<div style="margin:8px 0"><img src="${escHtml(u)}" alt="Customer image" style="max-width:400px;border:1px solid #e5e7eb"></div>`
  ).join("");
  const noteHtml = note ? `<p><strong>Customer note:</strong> ${escHtml(note).replace(/\n/g, "<br>")}</p>${imagesHtml}` : "";
  const text = `${label}\nOrder: ${orderId} (${orgId})\nCustomer: ${customerName}${note ? `\nNote: ${note}` : ""}`;
  const html = `<div style="font-family:sans-serif;max-width:600px;margin:auto">
    <h2>${escHtml(label)}</h2>
    <p><strong>Order:</strong> ${escHtml(orderId)} (${escHtml(orgId)})</p>
    <p><strong>Customer:</strong> ${escHtml(customerName)}</p>
    ${noteHtml}
    <hr/><p style="font-size:12px;color:#666">%%BUSINESS%% admin notification</p>
  </div>`;
  return queueOwnerNotice_(env, { kind: "design", orderId, orgId,
      summary: `Design ${action === "approved" ? "approved" : "revision requested"} by ${customerName}`,
      detail: note || "", imageUrls },
    { to: ORDER_NOTIFICATION_EMAIL, subject, html, text });
}
