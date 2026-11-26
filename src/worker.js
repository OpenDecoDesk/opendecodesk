/**
 * Cloudflare Worker entry point.
 * ========================================================================
 * public/ is served as static assets; the API handlers live one per file in functions/api/*.js,
 * each exporting onRequestGet / onRequestPost / … (the Cloudflare Pages Functions convention).
 * This small router calls them, and a `scheduled` handler runs the daily roll-up.
 *
 *   - `[assets]` (wrangler.toml) serves public/ directly and only invokes this Worker for
 *     /api/* (run_worker_first), so page views cost no Worker invocation.
 *   - fetch(): /api/<name> → functions/api/<name>.js, calling onRequest<Method>(context) with the
 *     context shape Pages Functions use ({request, env, params, waitUntil, next, data}).
 *   - scheduled(): the daily roll-up, at the configured local hour (functions/_lib/schedule.js), and an
 *     hour before it the daily housekeeping: Stripe fees still to fill in, old vendor web-service logs,
 *     customers' design uploads no order used (functions/api/customer-design.js), and receipts and
 *     design / order / digital files whose form was never saved (functions/_lib/unsavedUploads.js).
 */

import * as adminTwoFa from "../functions/api/admin-2fa.js";
import * as adminPassword from "../functions/api/admin-password.js";
import * as adminSession from "../functions/api/admin-session.js";
import * as adminUsers from "../functions/api/admin-users.js";
import * as agent from "../functions/api/agent.js";
import * as catalog from "../functions/api/catalog.js";
import * as checkout from "../functions/api/checkout.js";
import * as customerDesign from "../functions/api/customer-design.js";
import { cleanUpVendorApiLog } from "../functions/_lib/vendorLog.js";
import { cleanUpUnsavedUploads } from "../functions/_lib/unsavedUploads.js";
import * as dailyDigest from "../functions/api/daily-digest.js";
import * as design from "../functions/api/design.js";
import * as download from "../functions/api/download.js";
import * as estimate from "../functions/api/estimate.js";
import * as imageProxy from "../functions/api/image-proxy.js";
import * as invoice from "../functions/api/invoice.js";
import * as orders from "../functions/api/orders.js";
import * as receipt from "../functions/api/receipt.js";
import * as shipping from "../functions/api/shipping.js";
import * as shippoLabel from "../functions/api/shippo-label.js";
import * as stripeWebhook from "../functions/api/stripe-webhook.js";
import * as uploadVerify from "../functions/api/upload-verify.js";
import * as upload from "../functions/api/upload.js";
import * as verify from "../functions/api/verify.js";
import { recordSystemIssue, resolveTimeZone, getDigestRun, ensureSigningSecret } from "../functions/_lib/db.js";
import { getSettingRaw, setSettingRaw, dropStoredSigningSecret } from "../functions/_lib/db.js";
import { localHour, localDay, digestHour, housekeepingHour, scheduledJobDue, scheduledAttempt } from "../functions/_lib/schedule.js";
import { pendingMigrations } from "../functions/_lib/migrationCheck.js";
import { jsonResponse } from "../functions/_lib/http.js";
import { isDesktopEdition, desktopSuppliersOn, desktopEmailOn } from "../functions/_lib/hostConfig.js";
import { ensureDesktopReady } from "../functions/_lib/desktop.js";
import { fillMissingCardFees } from "../functions/_lib/stripeFees.js";
import { checkShippedDeliveries, checkBlankShipments } from "../functions/_lib/deliveryCheck.js";
import { checkSupplierShipments } from "../functions/_lib/supplierOrders.js";

// The send-agent relay's mailbox is a Durable Object (one globally consistent instance); the class must be
// exported from the Worker entry for the AGENT_MAILBOX binding in wrangler.toml.
export { AgentMailbox } from "../functions/_lib/agentMailbox.js";

export const ROUTES = {
  "admin-2fa": adminTwoFa,
  "admin-password": adminPassword,
  "admin-session": adminSession,
  "admin-users": adminUsers,
  "agent": agent,
  "catalog": catalog,
  "checkout": checkout,
  "customer-design": customerDesign,
  "daily-digest": dailyDigest,
  "design": design,
  "download": download,
  "estimate": estimate,
  "image-proxy": imageProxy,
  "invoice": invoice,
  "orders": orders,
  "receipt": receipt,
  "shipping": shipping,
  "shippo-label": shippoLabel,
  "stripe-webhook": stripeWebhook,
  "upload-verify": uploadVerify,
  "upload": upload,
  "verify": verify,
};

const text = (body, status, extra = {}) =>
  new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...extra } });

// The handler for a method is named onRequestGet, onRequestPost, …; HEAD is served by the GET handler.
function handlerFor(mod, method) {
  const m = method === "HEAD" ? "Get" : method.charAt(0) + method.slice(1).toLowerCase();
  return mod["onRequest" + m] || mod.onRequest || null;
}

// A site with no SIGNING_SECRET of its own (a Deploy-button install, until its domain step saves the value as a
// Worker secret — functions/_lib/cloudflareSetup.js) signs with one it made and keeps in the database
// (ensureSigningSecret), read once per isolate. Every handler then sees env.SIGNING_SECRET as if it were set, with
// SIGNING_SECRET_FROM_DB saying where it came from (Setup status warns about it; the domain step copies it to the
// Worker). If the database can't be read, the env is passed on as it is. Once the Worker has the secret and it is
// the stored copy's value, the copy is deleted (tried once per isolate), so a copy of the database can't sign links.
let madeSigningSecret = null, storedCopyChecked = false;
export async function withSigningSecret(env) {
  if (!env || !env.DB) return env;
  if (env.SIGNING_SECRET) {
    if (!storedCopyChecked) {
      storedCopyChecked = true;
      try { await dropStoredSigningSecret(env.DB, env.SIGNING_SECRET); }
      catch (e) { console.error("Could not remove the stored copy of the signing secret:", e); }
    }
    return env;
  }
  try {
    if (!madeSigningSecret) madeSigningSecret = await ensureSigningSecret(env.DB);
    return madeSigningSecret ? { ...env, SIGNING_SECRET: madeSigningSecret, SIGNING_SECRET_FROM_DB: true } : env;
  } catch (e) { console.error("Could not read or make the signing secret:", e); return env; }
}

// The desktop edition's start-up step (functions/_lib/desktop.js), once per process: every request
// waits for the same promise, and a failure is retried by the next request.
let desktopReady_ = null;
function desktopReady(env) {
  if (!desktopReady_) desktopReady_ = ensureDesktopReady(env).catch((e) => { desktopReady_ = null; throw e; });
  return desktopReady_;
}

export async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  if (isDesktopEdition(env) && env.DB) {
    try { await desktopReady(env); }
    catch (e) { console.error("Desktop start-up step failed:", e); return text("The database isn't ready. Close the program and open it again.", 503); }
  }
  const match = /^\/api\/([a-z0-9-]+)\/?$/.exec(url.pathname);
  const mod = match && Object.prototype.hasOwnProperty.call(ROUTES, match[1]) ? ROUTES[match[1]] : null;
  if (!mod) {
    // Not an API route. Static files are served by the assets layer before this Worker is called;
    // anything that still reaches us (an unknown /api/ path) is a 404.
    return text("Not found", 404);
  }
  const handler = handlerFor(mod, request.method);
  if (!handler) return text("Method not allowed", 405);
  env = await withSigningSecret(env);
  try {
    return await handler({
      request,
      env,
      params: {},
      data: {},
      waitUntil: (p) => ctx.waitUntil(p),
      passThroughOnException: () => ctx.passThroughOnException(),
      next: (req) => (env.ASSETS ? env.ASSETS.fetch(req || request) : text("Not found", 404)),
    });
  } catch (e) {
    // A handler that throws (a bug, a database that refused a statement no one caught) would otherwise give
    // the runtime's bare 500 page, which the admin's and the shop's pages can't read, and leave the error only
    // in the Worker's log. The caller gets a plain JSON error (never the stack), and the error goes into the
    // next roll-up's system problems (recorded after the answer, so a database that is down can't hold it up).
    const route = match[1];
    console.error("/api/" + route + " failed:", e);
    const message = String((e && e.message) || e || "unknown error");
    const record = recordSystemIssue(env && env.DB, "api_error", route + ": " + message);
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(record);
    else await record;
    const res = jsonResponse({ status: "error", message: "Something went wrong — it has been logged." }, 500);
    res.headers.set("Cache-Control", "no-store");
    return res;
  }
}

// The desktop program's roll-up is due when it is the roll-up's hour or later, in the business's time
// zone, and no scheduled roll-up has run yet on this local day (the program may be closed at the hour
// itself, so "on or after", not "at").
async function desktopRollUpDue_(env, when) {
  const tz = await resolveTimeZone(env);
  if (localHour(when, tz) < digestHour(env)) return false;
  const last = await getDigestRun(env.DB).catch(() => null);
  if (!last || last.trigger !== "scheduled" || !last.at) return true;
  const day = (d) => { try { return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d); } catch (e) { return d.toISOString().slice(0, 10); } };
  return day(new Date(last.at)) !== day(when);
}

// The daily housekeeping (the tick an hour before the roll-up's — functions/_lib/schedule.js). Each job is
// on its own: one failing never stops the others. A failed clean-up is recorded, so the roll-up an hour
// later reports it.
async function runHousekeeping_(env, { firstTry = true } = {}) {
  const out = {};
  // Safety net: fill in Stripe fees the webhook couldn't read yet (see functions/_lib/stripeFees.js). Stripe refusing
  // (a revoked or restricted key) is one problem for the roll-up, however many payments it stopped, and only on the
  // day's first try: a retry an hour later would only meet the same refused key again.
  try {
    const f = await fillMissingCardFees(env);
    out.cardFees = f;
    if (f.filled) console.log("Filled Stripe fees on", f.filled, "of", f.checked, "card payments");
    const refused = f.errors || [];
    if (refused.length) {
      console.error("Stripe refused card fee lookups:", refused.join(" | "));
      if (firstTry) await recordSystemIssue(env.DB, "card_fees_failed", refused[0] + (refused.length > 1 ? ` (and ${refused.length - 1} more)` : ""));
    }
  } catch (e) { console.error("Filling missing Stripe fees failed:", e); out.cardFees = { error: String(e && e.message) }; await recordSystemIssue(env.DB, "card_fees_failed", "Card fees: " + (e && e.message)); }
  // Vendor web-service logs (vendorLog.js) older than 30 days: their payloads and rows go.
  try {
    const v = await cleanUpVendorApiLog(env);
    out.vendorLog = v;
    if (v.deleted) console.log("Deleted", v.deleted, "vendor API log entr" + (v.deleted === 1 ? "y" : "ies"), "older than 30 days");
  } catch (e) { console.error("Cleaning up the vendor API log failed:", e); out.vendorLog = { error: String(e && e.message) }; await recordSystemIssue(env.DB, "cleanup_failed", "Vendor API log: " + (e && e.message)); }
  // Customers' design uploads that never made it onto an order are deleted after 48 hours (a capped number a run).
  try {
    const c = await customerDesign.cleanUpCustomerDesigns(env);
    out.customerDesigns = c;
    if (c.deleted) console.log("Deleted", c.deleted, "customer design upload(s) no order used");
  } catch (e) { console.error("Cleaning up customer design uploads failed:", e); out.customerDesigns = { error: String(e && e.message) }; await recordSystemIssue(env.DB, "cleanup_failed", "Customer design uploads: " + (e && e.message)); }
  // Receipts and design / order / digital files uploaded more than 30 days ago that nothing in the database names
  // (their form was never saved): at most 1,000 a run, within a time limit; a missing bucket is skipped.
  try {
    const u = await cleanUpUnsavedUploads(env);
    out.unsavedUploads = u;
    if (u.deleted) console.log("Deleted", u.deleted, "upload(s) whose form was never saved");
    for (const m of u.errors || []) { console.error("Cleaning up unsaved uploads:", m); await recordSystemIssue(env.DB, "cleanup_failed", "Unsaved uploads: " + m); }
  } catch (e) { console.error("Cleaning up unsaved uploads failed:", e); out.unsavedUploads = { error: String(e && e.message) }; await recordSystemIssue(env.DB, "cleanup_failed", "Unsaved uploads: " + (e && e.message)); }
  return out;
}

// The scheduled jobs' records of the day ({day, attempts, ok} — functions/_lib/schedule.js), in global_settings.
// Not the roll-up's own last-run record (dailyDigestRun): a roll-up sent by hand overwrites that one.
const DIGEST_SCHEDULE_KEY = "dailyDigestScheduled";
const HOUSEKEEPING_SCHEDULE_KEY = "housekeepingScheduled";
async function scheduledEntry_(env, key) {
  try { const v = await getSettingRaw(env.DB, key); return v ? JSON.parse(v) : null; }
  catch (e) { return null; }
}
async function saveScheduledEntry_(env, key, entry) {
  try { await setSettingRaw(env.DB, key, JSON.stringify(entry)); }
  catch (e) { console.error("Could not save the scheduled run's record", key, e); }
}

// The scheduled roll-up. The cron wakes the Worker every hour (UTC); the tick that lands on the
// configured local hour runs it, so it goes out once a day at the same local time all year (and the
// tick an hour before runs the housekeeping above); a failed run is tried again on the next ticks. The
// time zone is the install's one zone: Global settings → Region, else TIMEZONE, else UTC.
export async function handleScheduled(event, env) {
  env = await withSigningSecret(env);
  // The desktop program has no cron: desktop/main.js calls this while it is open (a minute after it
  // opens, then every two hours). Of the jobs below only these apply there (no Stripe, no customer
  // uploads): carrier tracking with a Shippo key (both check functions also skip themselves while
  // Shipping is switched off), suppliers' shipment notices once supplier connections are turned on,
  // and — with email set up — the morning roll-up, at the first run on or after its hour each day.
  if (isDesktopEdition(env)) {
    const suppliers = desktopSuppliersOn(env);
    if (!env.SHIPPO_API_KEY && !suppliers && !desktopEmailOn(env)) return { ran: false, reason: "desktop edition, nothing online turned on" };
    const out = { ran: true, desktop: true };
    if (desktopEmailOn(env) && await desktopRollUpDue_(env, new Date(event && event.scheduledTime ? event.scheduledTime : Date.now()))) {
      // The roll-up checks tracking and suppliers' shipment notices itself, before it writes.
      try {
        const res = await dailyDigest.runDailyDigest(env, "scheduled");
        out.rollUp = await res.clone().json().catch(() => ({}));
        if (!res.ok) await recordSystemIssue(env.DB, "digest_failed", out.rollUp.message || ("HTTP " + res.status));
      } catch (e) {
        console.error("Daily roll-up crashed:", e);
        await recordSystemIssue(env.DB, "digest_failed", e && e.message);
        out.rollUp = { error: String(e && e.message) };
      }
      return out;
    }
    if (env.SHIPPO_API_KEY) {
      try { out.deliveries = await checkShippedDeliveries(env); }
      catch (e) { console.error("Tracking check failed:", e); out.deliveries = { error: String(e && e.message) }; }
      try { out.blankShipments = await checkBlankShipments(env); }
      catch (e) { console.error("Blank shipment check failed:", e); out.blankShipments = { error: String(e && e.message) }; }
    }
    if (suppliers) {
      try { out.supplierShipments = await checkSupplierShipments(env, { limit: 10 }); }
      catch (e) { console.error("Supplier shipment check failed:", e); out.supplierShipments = { error: String(e && e.message) }; }
      // The vendor web-service log (vendorLog.js) is only written with supplier connections on; entries older than
      // 30 days go here, as in the daily run below (this is the desktop program's only scheduled run).
      try { out.vendorLog = await cleanUpVendorApiLog(env); }
      catch (e) { console.error("Cleaning up the vendor API log failed:", e); out.vendorLog = { error: String(e && e.message) }; await recordSystemIssue(env.DB, "cleanup_failed", "Vendor API log: " + (e && e.message)); }
    }
    return out;
  }
  const when = new Date(event && event.scheduledTime ? event.scheduledTime : Date.now());
  const timeZone = await resolveTimeZone(env);
  // Each job runs at its hour or, if that try failed or its tick never came, at a later tick the same day, up
  // to 3 tries (functions/_lib/schedule.js scheduledJobDue). The record is the scheduled runs' own: a roll-up
  // sent by hand (Communications) neither counts as a try nor stops one. Never both jobs on one tick: the
  // roll-up first; a housekeeping still due goes on the next tick.
  const hour = localHour(when, timeZone), day = localDay(when, timeZone);
  const rollUpEntry = await scheduledEntry_(env, DIGEST_SCHEDULE_KEY);
  if (!scheduledJobDue(rollUpEntry, { hour, jobHour: digestHour(env), day })) {
    // An hour before the roll-up: the housekeeping, on its own tick, so its requests (up to 20 to Stripe, the
    // clean-ups' storage and database calls) never come out of the roll-up's per-run allowance.
    const hkEntry = await scheduledEntry_(env, HOUSEKEEPING_SCHEDULE_KEY);
    if (!scheduledJobDue(hkEntry, { hour, jobHour: housekeepingHour(env), day })) return { ran: false, reason: "not the digest hour" };
    const attempt = scheduledAttempt(hkEntry, day);
    await saveScheduledEntry_(env, HOUSEKEEPING_SCHEDULE_KEY, attempt);
    const housekeeping = await runHousekeeping_(env, { firstTry: attempt.attempts === 1 });
    const failed = Object.values(housekeeping).some(r => r && (r.error || (Array.isArray(r.errors) && r.errors.length)));
    await saveScheduledEntry_(env, HOUSEKEEPING_SCHEDULE_KEY, { ...attempt, ok: !failed });
    return { ran: true, housekeeping };
  }
  const attempt = scheduledAttempt(rollUpEntry, day);
  await saveScheduledEntry_(env, DIGEST_SCHEDULE_KEY, attempt);
  // Done as soon as the email is out (runDailyDigest's onSent), before the roll-up saves its progress: if
  // saving that fails, a retry would send the same email again.
  const markDone = () => saveScheduledEntry_(env, DIGEST_SCHEDULE_KEY, { ...attempt, ok: true });
  // Database updates this code needs that the database hasn't had (code deployed without its migrations, or one
  // that failed partway — functions/_lib/migrationCheck.js): reported in this roll-up, every day until applied
  // (once a day: a retry's roll-up still has the first try's report to send).
  if (attempt.attempts === 1) try {
    const pending = await pendingMigrations(env.DB);
    if (pending && pending.length) await recordSystemIssue(env.DB, "migrations_pending", pending.length + " not applied, starting with " + pending[0]);
  } catch (e) { console.error("Checking for database updates failed (continuing with the roll-up):", e); }
  try {
    const res = await dailyDigest.runDailyDigest(env, "scheduled", { onSent: markDone });
    const body = await res.clone().json().catch(() => ({}));
    if (!res.ok) {
      console.error("Daily roll-up did not complete:", res.status, JSON.stringify(body).slice(0, 300));
      await recordSystemIssue(env.DB, "digest_failed", (body && body.message) || ("HTTP " + res.status));
      return { ran: true, ok: false, body };
    }
    await markDone();
    return { ran: true, ok: true, body };
  } catch (e) {
    console.error("Daily roll-up crashed:", e);
    await recordSystemIssue(env.DB, "digest_failed", e && e.message);
    return { ran: true, ok: false, error: String(e && e.message) };
  }
}

export default {
  fetch: (request, env, ctx) => handleRequest(request, env, ctx),
  scheduled: (event, env, ctx) => { ctx.waitUntil(handleScheduled(event, env)); },
};
