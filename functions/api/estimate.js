/**
 * Public quote endpoint — no admin sign-in; the token in the emailed link is the credential.
 * ========================================================================
 * File location: functions/api/estimate.js  →  https://<shop>.<domain>/api/estimate
 *
 * (A "quote" to the people using it; "estimate" in code, because a quote there is already a signed
 * shipping rate — functions/_lib/quoteToken.js.)
 *
 * Staff build a quote for a customer in the admin (Quotes) and email it: /?estimate=<token> on the
 * shop's own address. That page calls this endpoint:
 *
 *   GET  /api/estimate?token=…                         → the quote as the customer sees it
 *   POST /api/estimate {token, action:"accept"}        → accepted: it becomes an order (orders.js
 *                                                         convertEstimateToOrder_, the same path as a
 *                                                         local sale, at the prices quoted) and its
 *                                                         invoice is emailed when the site can send email
 *   POST /api/estimate {token, action:"changes", note} → the customer asks for changes (status "changes")
 *
 * ---- WHAT IT SHOWS ----
 * One quote: the shop's name, its number, title and note to the customer, the lines (with the list price
 * when a quantity break took something off), the one-time fees, the totals with the tax taken when it was
 * sent, the expiry date and what the customer can still do. Never the internal note, costs, who made it,
 * or anything about another quote. Nothing is priced here: the prices were frozen when it was sent.
 *
 * ---- WHAT THE CUSTOMER CAN DO ----
 * Accept a quote that is sent and not expired (the business's calendar day after its last day), cancelled,
 * accepted or converted. Not while it's waiting on changes they asked for: staff may be revising it, so
 * what they'd accept could differ from what they saw — they accept the revised one when it's sent again.
 * Ask for changes while it is sent or already waiting on changes (a second message replaces the first).
 * Behind the Quotes feature switch: off, every request gets the same short answer.
 */

import { getEstimate, getEstimateByToken, markEstimateViewed, respondToEstimate, getOrgById, getSalesTaxSettings,
  insertAuditLog, recordSystemIssue, localToday } from "../_lib/db.js";
import { sendEstimateResponseNotification, estimateLinesView, emailCanSend } from "../_lib/email.js";
import { convertEstimateToOrder_ } from "./orders.js";
import { rateLimited, rateLimitResponse } from "../_lib/rateLimit.js";
import { jsonResponse, featureIsOff } from "../_lib/http.js";

// The same shape as an invoice's token (order_invoices.token): checked before the database is asked.
const ESTIMATE_TOKEN_RE_ = /^[a-z0-9]{16,64}$/;
const ESTIMATE_NOTE_MAX_ = 2000;
const ESTIMATE_OFF_MSG_ = "Quotes aren't available.";
const ESTIMATE_INVALID_MSG_ = "This quote link isn't valid.";

// "Monday, December 15, 2026" from YYYY-MM-DD (a calendar day — no time zone shift).
function estimateDay_(day) {
  const d = new Date(String(day) + "T12:00:00Z");
  return isNaN(d) ? String(day || "") : d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

// Expired once the business's own calendar day is past its last day (expiresOn is that last day, inclusive) — and
// only while the quote is still open, as db.js counts it (parseEstimate_): an accepted, converted or cancelled quote
// stays what it is.
async function estimateIsExpired_(env, est) {
  if (!est.expiresOn || !["draft", "sent", "changes"].includes(est.status)) return false;
  return (await localToday(env)) > String(est.expiresOn).slice(0, 10);
}

// Why the customer can't do `action` with this quote now ("" = they can), as a sentence for them.
function estimateRefusal_(est, expired, action) {
  if (est.status === "cancelled") return "This quote was cancelled — contact us if you'd still like to go ahead.";
  if (est.status === "accepted" || est.status === "converted") {
    return "This quote has already been accepted" + (est.orderId ? ` — your order is ${est.orderId}.` : ".");
  }
  if (expired) return `This quote expired on ${estimateDay_(est.expiresOn)} — contact us for a new one.`;
  if (action === "accept" && est.status === "changes") return "You've asked for changes to this quote — we'll send you the revised quote to accept.";
  if (est.status !== "sent" && est.status !== "changes") return "This quote can't be answered online — contact us.";
  return "";
}

// Loads the quote, its lines and its shop by token, or answers why it can't be shown. A quote that was never
// sent has no token, so a draft can't be reached; one that was sent and later cancelled, expired or accepted
// still shows, with its status, so the page can say so.
async function loadEstimate_(env, token) {
  const invalid = { error: jsonResponse({ status: "error", message: ESTIMATE_INVALID_MSG_ }, 404) };
  if (!ESTIMATE_TOKEN_RE_.test(token)) return invalid;
  const row = await getEstimateByToken(env.DB, token);
  const found = row && (row.estimate || row);
  if (!found || found.id == null || found.status === "draft") return invalid;
  const full = await getEstimate(env.DB, found.id);
  if (!full || !full.estimate) return invalid;
  const org = await getOrgById(env.DB, full.estimate.orgId);
  if (!org) return invalid;
  return { full, org, expired: await estimateIsExpired_(env, full.estimate) };
}

// The page's whole picture of the quote.
async function estimateView_(env, got) {
  const { full, org, expired } = got;
  const est = full.estimate, totals = full.totals || {}, customer = full.customer || {};
  const { lines, fees } = estimateLinesView(full.items);
  const tax = await getSalesTaxSettings(env.DB).catch(() => ({}));
  const canAccept = !estimateRefusal_(est, expired, "accept");
  const canAskChanges = !estimateRefusal_(est, expired, "changes");
  return {
    number: est.number || "", title: est.title || "", message: est.message || "",
    orgId: est.orgId, orgName: org.name || est.orgId, orgAccent: org.accent || "#1d4ed8",
    customerName: customer.name || customer.company || "",
    status: est.status, expired, expiresOn: est.expiresOn || "", canAccept, canAskChanges,
    sentAt: est.sentAt || "", respondedAt: est.respondedAt || "", acceptedAt: est.acceptedAt || "",
    // Their own message back to them while it waits on changes; the order once it's one.
    customerNote: est.status === "changes" ? est.customerNote || "" : "",
    orderId: est.status === "accepted" || est.status === "converted" ? est.orderId || "" : "",
    lines, fees,
    subtotal: Number(totals.subtotal) || 0, tax: Number(totals.tax) || 0, total: Number(totals.total) || 0,
    taxMode: totals.taxMode === "exclusive" ? "exclusive" : "inclusive", taxRate: (Number(totals.taxRateBps) || 0) / 100,
    taxJurisdiction: tax.jurisdiction || "",
  };
}

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!env.DB) return jsonResponse({ status: "error", message: "Server misconfigured" }, 500);
  const rl = await rateLimited(env, "estimate", request, 60);
  if (rl.blocked) return rateLimitResponse(rl.retryAfter);
  if (await featureIsOff(env, "quotes")) return jsonResponse({ status: "error", feature: "quotes", message: ESTIMATE_OFF_MSG_ }, 403);
  const token = String(new URL(request.url).searchParams.get("token") || "").trim();
  const got = await loadEstimate_(env, token);
  if (got.error) return got.error;
  if (!got.full.estimate.viewedAt) await markEstimateViewed(env.DB, token).catch(() => {});
  return jsonResponse({ status: "ok", estimate: await estimateView_(env, got) });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.DB) return jsonResponse({ status: "error", message: "Server misconfigured" }, 500);
  const rl = await rateLimited(env, "estimate", request, 30);
  if (rl.blocked) return rateLimitResponse(rl.retryAfter);
  if (await featureIsOff(env, "quotes")) return jsonResponse({ status: "error", feature: "quotes", message: ESTIMATE_OFF_MSG_ }, 403);
  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ status: "error", message: "Invalid JSON" }, 400); }
  const token = String((body && body.token) || "").trim();
  const got = await loadEstimate_(env, token);
  if (got.error) return got.error;
  const action = body.action;
  if (action !== "accept" && action !== "changes") return jsonResponse({ status: "error", message: "Unknown action" }, 400);
  const accept = action === "accept";

  // Refused rather than cut short: the shop should read what the customer wrote, all of it.
  const note = String(body.note == null ? "" : body.note).trim();
  if (note.length > ESTIMATE_NOTE_MAX_) return jsonResponse({ status: "error", message: "Please keep your message under 2,000 characters." }, 400);
  if (!accept && !note) return jsonResponse({ status: "error", message: "Please tell us what you'd like changed." }, 400);

  // A refusal sends the quote as it is now, too: it may have expired, been withdrawn or accepted since the page was
  // drawn, and the page redraws from it so it stops offering what can't be done.
  const est = got.full.estimate;
  const why = estimateRefusal_(est, got.expired, action);
  if (why) return jsonResponse({ status: "error", message: why, estimate: await estimateView_(env, got) }, got.expired ? 410 : 409);

  // db.js has the last word (another tab may have answered a moment ago): its refusal is said in the
  // customer's words from the quote as it is now, never as the database's own text.
  const r = await respondToEstimate(env.DB, token, { accept, note });
  if (!r || r.error || !r.ok) {
    const now = await loadEstimate_(env, token);
    const msg = (!now.error && estimateRefusal_(now.full.estimate, now.expired, action)) || "This quote can't be answered online right now — contact us.";
    return jsonResponse({ status: "error", message: msg, estimate: now.error ? null : await estimateView_(env, now) }, 409);
  }

  // Accepted: the order, through the one path staff's "Convert to order" uses too (idempotent, so a retry
  // answers the same order). Its invoice is emailed when the site can send email. If making the order fails,
  // the acceptance still stands: the owner is told and staff convert it from the Quotes page.
  let orderId = "", invoiceSent = false;
  if (accept) {
    try {
      const sendInvoice = await emailCanSend(env).catch(() => false);
      const fresh = await getEstimate(env.DB, est.id);
      // The shop's own address for the invoice link when it has no subdomain of its own (a custom domain).
      const c = await convertEstimateToOrder_(env, (fresh && fresh.estimate) || est, { actor: "customer-quote", sendInvoice,
        ip: request.headers.get("CF-Connecting-IP") || null, origin: new URL(request.url).origin });
      if (c && c.orderId && !c.error) {
        orderId = String(c.orderId);
        invoiceSent = !!c.invoiceSent;
      } else {
        console.error("Quote accepted, but making its order was refused:", est.number, c && c.error);
        await recordSystemIssue(env.DB, "api_error", `estimate: quote ${est.number} accepted, but its order couldn't be made — ${(c && c.error) || "no order"}`);
      }
    } catch (e) {
      console.error("Quote accepted, but making its order failed:", est.number, e);
      await recordSystemIssue(env.DB, "api_error", `estimate: quote ${est.number} accepted, but its order couldn't be made — ${(e && e.message) || e}`);
    }
  }

  // On the record: the customer answered, through their quote link, from where; and the owner hears of it.
  const customerName = (got.full.customer && (got.full.customer.name || got.full.customer.company)) || "";
  const record = Promise.all([
    insertAuditLog(env.DB, { orgId: est.orgId, orderId: orderId || null, action: accept ? "estimate.accepted" : "estimate.changes_requested",
      detail: { estimate: est.number, orderId: orderId || undefined, note: note || undefined }, actor: "customer-quote", ip: request.headers.get("CF-Connecting-IP") || null }),
    sendEstimateResponseNotification(env, { estimate: est, accepted: accept, note, orderId, customerName }),
  ]).catch((e) => console.error("Quote answer saved, but recording it failed:", est.number, e));
  if (typeof context.waitUntil === "function") context.waitUntil(record); else await record;

  const now = await loadEstimate_(env, token);
  return jsonResponse({ status: "ok", action, orderId, invoiceSent, estimate: now.error ? null : await estimateView_(env, now) });
}
