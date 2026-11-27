// Email campaigns (migrations/0117): marketing emails to customers, from the Discount codes page's Email campaigns tab.
//   - who asked for no marketing email (marketing_optouts) — the box at checkout and on a Local sale, the unsubscribe
//     link, a reply the owner records, or a tick on the customer;
//   - who a campaign goes to (campaignAudience): shops, the last order's date, how many orders, plus typed addresses;
//   - the campaigns themselves (draft → scheduled → sending → sent, or canceled), and their discount: none, one shared
//     code, or a single-use code made for each person (db.js createDiscountCodesForEmails);
//   - sending (runCampaignQueue): a few at a time, each recipient row taken by one conditional UPDATE before its email
//     goes, so two runners never send the same one and a crash never sends one twice. The web's hourly cron, the
//     desktop program's timer and the admin page (while it is open) all run it.
// The email itself is made by public/campaign-render.js (OddCampaignRender), the same code the editor's preview uses.
import "../../public/campaign-render.js";
import { normalizeCustomerEmail_, getDiscountCode, createDiscountCodesForEmails, resolveTimeZone, recordSystemIssue, getBusinessProfile } from "./db.js";
import { sendCampaignEmail, emailCanSend } from "./email.js";
import { unsubscribeToken } from "./http.js";

const R = () => globalThis.OddCampaignRender;
export const AUDIENCE_MAX = 5000;          // the most addresses one campaign goes to
export const QUEUE_BATCH = 20;             // emails one run of the queue sends (the page asks again while it's open)
const OPTOUT_SOURCES = ["checkout", "unsubscribe", "reply", "admin"];
const noCampaignsYet_ = (e) => /no such table: (marketing_optouts|email_campaigns|email_campaign_recipients)/i.test(String(e && e.message));
export const CAMPAIGNS_NOT_READY = "Email campaigns need the latest database update. Apply the migrations, then try again.";

// ---- Who asked for no marketing email ---------------------------------------------------------------------------
// optIn false: the address goes on the list (a later, stronger reason — an unsubscribe — replaces a checkout's).
// optIn true: taken off — by a checkout only when a checkout put it there (never undoing an unsubscribe), by the owner
// ("admin") whatever put it there. { ok, changed } | { ok: false, notReady }.
export async function setMarketingChoice(db, email, optIn, source, now = new Date().toISOString()) {
  const e = normalizeCustomerEmail_(email);
  if (!e || !OPTOUT_SOURCES.includes(source)) return { ok: false };
  try {
    if (!optIn) {
      const r = await db.prepare(`INSERT INTO marketing_optouts (email, optedOutAt, source) VALUES (?, ?, ?)
                                  ON CONFLICT(email) DO UPDATE SET source = excluded.source, optedOutAt = excluded.optedOutAt
                                  WHERE marketing_optouts.source = 'checkout' AND excluded.source <> 'checkout'`).bind(e, now, source).run();
      return { ok: true, changed: Number(r && r.meta && r.meta.changes) > 0 };
    }
    const r = source === "admin"
      ? await db.prepare("DELETE FROM marketing_optouts WHERE email = ?").bind(e).run()
      : await db.prepare("DELETE FROM marketing_optouts WHERE email = ? AND source = 'checkout'").bind(e).run();
    return { ok: true, changed: Number(r && r.meta && r.meta.changes) > 0 };
  } catch (err) { if (noCampaignsYet_(err)) return { ok: false, notReady: true }; throw err; }
}
// { optedOut, source, at } for one address (optedOut false when it isn't on the list, or before 0117).
export async function getMarketingChoice(db, email) {
  const e = normalizeCustomerEmail_(email);
  if (!e) return { optedOut: false };
  try {
    const row = await db.prepare("SELECT optedOutAt, source FROM marketing_optouts WHERE email = ?").bind(e).first();
    return row ? { optedOut: true, source: row.source, at: row.optedOutAt } : { optedOut: false };
  } catch (err) { if (noCampaignsYet_(err)) return { optedOut: false }; throw err; }
}

// ---- Who a campaign goes to ---------------------------------------------------------------------------------------
// criteria (as the page sends it, cleaned here):
//   orgIds   []                       only customers with an order in one of these shops (and the next two count only
//                                      those shops' orders); [] = every shop
//   last     { mode: "any" | "olderThan" | "within" | "before", n, unit: "days" | "months", date }
//   orders   { mode: "any" | "atLeast" | "atMost" | "exactly", n }
//   extra    "a@b.com, c@d.com"       typed addresses, added whoever they are
//   onlyTyped true                     only the typed addresses (the rules above are ignored)
// Orders that count: not test orders, not voided. Customers: live ones (not archived, not merged away) with an email.
// Addresses on the opt-out list are always left out (and counted).
export function cleanAudience(c) {
  const src = c && typeof c === "object" ? c : {};
  const orgIds = [...new Set((Array.isArray(src.orgIds) ? src.orgIds : []).map(x => String(x || "").slice(0, 100)).filter(Boolean))].slice(0, 200);
  const l = src.last && typeof src.last === "object" ? src.last : {};
  const lastMode = ["olderThan", "within", "before"].includes(l.mode) ? l.mode : "any";
  const n = Math.round(Number(l.n));
  const last = lastMode === "any" ? { mode: "any" }
    : lastMode === "before" ? { mode: "before", date: /^\d{4}-\d{2}-\d{2}$/.test(String(l.date || "")) ? String(l.date) : "" }
    : { mode: lastMode, n: Number.isFinite(n) && n >= 1 && n <= 3650 ? n : 0, unit: l.unit === "months" ? "months" : "days" };
  const o = src.orders && typeof src.orders === "object" ? src.orders : {};
  const ordersMode = ["atLeast", "atMost", "exactly"].includes(o.mode) ? o.mode : "any";
  const on = Math.round(Number(o.n));
  const orders = ordersMode === "any" ? { mode: "any" } : { mode: ordersMode, n: Number.isFinite(on) && on >= 0 && on <= 100000 ? on : 0 };
  const extra = String(src.extra == null ? "" : src.extra).slice(0, 100000);
  return { orgIds, last, orders, extra, onlyTyped: src.onlyTyped === true };
}
export function audienceError(a) {
  if (a.onlyTyped) return splitEmails(a.extra).emails.length ? "" : "Type at least one address, or untick “Only these addresses”.";
  if ((a.last.mode === "olderThan" || a.last.mode === "within") && !a.last.n) return "Enter how many days or months ago the last order was.";
  if (a.last.mode === "before" && !a.last.date) return "Pick the date the last order was before.";
  return "";
}
// Midnight at the start of a local day, as an ISO instant (placedAt is stored in UTC).
function zonedMidnightIso_(day, timeZone) {
  const guess = new Date(day + "T00:00:00Z");
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(guess);
    const g = (t) => Number((parts.find(p => p.type === t) || {}).value);
    const asLocal = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"));
    return new Date(guess.getTime() - (asLocal - guess.getTime())).toISOString();
  } catch (e) { return guess.toISOString(); }
}
function cutoffIso_(last, now, timeZone) {
  if (last.mode === "before") return zonedMidnightIso_(last.date, timeZone);
  const d = new Date(now.getTime());
  if (last.unit === "months") d.setUTCMonth(d.getUTCMonth() - last.n); else d.setUTCDate(d.getUTCDate() - last.n);
  return d.toISOString();
}
export function splitEmails(text) {
  const out = [], bad = [], seen = new Set();
  for (const raw of String(text == null ? "" : text).split(/[\s,;]+/)) {
    const s = raw.trim().replace(/^<|>$/g, "");
    if (!s) continue;
    const e = normalizeCustomerEmail_(s);
    if (!e) { bad.push(s.slice(0, 200)); continue; }
    if (!seen.has(e)) { seen.add(e); out.push(e); }
  }
  return { emails: out, bad };
}

// { count, people: [{ email, name }] (at most `limit`, all of them when limit is 0), fromCustomers, typed, optedOut,
//   bad (typed text that isn't an address), tooMany } | { error } | { notReady }.
export async function campaignAudience(db, criteria, { now = new Date(), timeZone = "UTC", limit = 0 } = {}) {
  const a = cleanAudience(criteria);
  const err = audienceError(a);
  if (err) return { error: err };
  const binds = [];
  let ordersWhere = "COALESCE(o.isTest, 0) = 0 AND o.voidedAt IS NULL AND o.customerId IS NOT NULL";
  if (a.orgIds.length) { ordersWhere += ` AND o.orgId IN (${a.orgIds.map(() => "?").join(",")})`; binds.push(...a.orgIds); }
  const where = ["c.email <> ''", "c.mergedIntoId IS NULL", "c.archivedAt IS NULL"];
  const needOrders = a.orgIds.length || a.last.mode !== "any" || (a.orders.mode !== "any" && !(a.orders.mode === "atMost" || (a.orders.mode === "exactly" && a.orders.n === 0)));
  if (needOrders) where.push("s.n IS NOT NULL");
  if (a.last.mode !== "any") {
    where.push(a.last.mode === "within" ? "s.last >= ?" : "s.last < ?");
    binds.push(cutoffIso_(a.last, now, timeZone));
  }
  if (a.orders.mode === "atLeast") { where.push("COALESCE(s.n, 0) >= ?"); binds.push(a.orders.n); }
  else if (a.orders.mode === "atMost") { where.push("COALESCE(s.n, 0) <= ?"); binds.push(a.orders.n); }
  else if (a.orders.mode === "exactly") { where.push("COALESCE(s.n, 0) = ?"); binds.push(a.orders.n); }
  const sql = `WITH s AS (SELECT o.customerId AS customerId, count(*) AS n, max(o.placedAt) AS last FROM orders o WHERE ${ordersWhere} GROUP BY o.customerId)
    SELECT c.email AS email, c.name AS name, c.company AS company,
           EXISTS (SELECT 1 FROM marketing_optouts m WHERE m.email = c.email) AS out_
      FROM customers c LEFT JOIN s ON s.customerId = c.id
     WHERE ${where.join(" AND ")}
     ORDER BY c.email`;
  let rows;
  try { rows = a.onlyTyped ? [] : (await db.prepare(sql).bind(...binds).all()).results || []; }
  catch (e) { if (noCampaignsYet_(e) || /no such table: customers/i.test(String(e && e.message))) return { notReady: true, error: CAMPAIGNS_NOT_READY }; throw e; }
  const byEmail = new Map();
  let optedOut = 0;
  const outInRows = new Set();
  for (const r of rows) {
    if (Number(r.out_)) { optedOut++; outInRows.add(r.email); continue; }
    byEmail.set(r.email, { email: r.email, name: String(r.name || r.company || "") });
  }
  const fromCustomers = byEmail.size;
  const typed = splitEmails(a.extra);
  let typedAdded = 0;
  if (typed.emails.length) {
    const outSet = new Set(), names = new Map();
    for (let i = 0; i < typed.emails.length; i += 90) {
      const chunk = typed.emails.slice(i, i + 90), qs = chunk.map(() => "?").join(",");
      for (const r of (await db.prepare(`SELECT email FROM marketing_optouts WHERE email IN (${qs})`).bind(...chunk).all()).results || []) outSet.add(r.email);
      for (const r of (await db.prepare(`SELECT email, name, company FROM customers WHERE mergedIntoId IS NULL AND email IN (${qs})`).bind(...chunk).all()).results || []) {
        names.set(r.email, String(r.name || r.company || ""));
      }
    }
    for (const e of typed.emails) {
      if (byEmail.has(e) || outInRows.has(e)) continue;   // already in (or already left out) by the criteria
      if (outSet.has(e)) { optedOut++; continue; }
      byEmail.set(e, { email: e, name: names.get(e) || "" });
      typedAdded++;
    }
  }
  const people = [...byEmail.values()];
  return { count: people.length, people: limit ? people.slice(0, limit) : people, fromCustomers, typed: typedAdded, optedOut,
    bad: typed.bad.slice(0, 20), tooMany: people.length > AUDIENCE_MAX };
}

// ---- The campaigns ------------------------------------------------------------------------------------------------
const tryJson_ = (s, d) => { try { const v = JSON.parse(s); return v && typeof v === "object" ? v : d; } catch (e) { return d; } };
// discount: { mode: "none" } | { mode: "shared", codeId } | { mode: "unique", kind, percent | amount, maxDiscount,
// orgId, expiresOn, prefix } — the unique codes' settings, made when the campaign starts.
export function cleanDiscount(d) {
  const src = d && typeof d === "object" ? d : {};
  if (src.mode === "shared") { const id = Number(src.codeId); return Number.isSafeInteger(id) && id > 0 ? { mode: "shared", codeId: id } : { mode: "none" }; }
  if (src.mode !== "unique") return { mode: "none" };
  const kind = src.kind === "amount" ? "amount" : "percent";
  const num = (v) => v === "" || v == null ? null : Number(v);
  return { mode: "unique", kind,
    percent: kind === "percent" ? num(src.percent) : null, amount: kind === "amount" ? num(src.amount) : null,
    maxDiscount: kind === "percent" ? num(src.maxDiscount) : null,
    orgId: src.orgId ? String(src.orgId).slice(0, 100) : null,
    expiresOn: /^\d{4}-\d{2}-\d{2}$/.test(String(src.expiresOn || "")) ? String(src.expiresOn) : null,
    prefix: String(src.prefix || "").toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 12) };
}
function parseCampaign_(row, counts) {
  const c = counts || {};
  return { id: Number(row.id), name: row.name || "", subject: row.subject || "", preheader: row.preheader || "", theme: row.theme || "plain",
    design: tryJson_(row.designJson, { blocks: [] }), audience: cleanAudience(tryJson_(row.audienceJson, {})), discount: cleanDiscount(tryJson_(row.discountJson, {})),
    status: row.status, scheduledAt: row.scheduledAt || null, startedAt: row.startedAt || null, sentAt: row.sentAt || null,
    createdAt: row.createdAt, createdBy: row.createdBy || "", updatedAt: row.updatedAt,
    counts: { queued: Number(c.queued) || 0, sending: Number(c.sending) || 0, sent: Number(c.sent) || 0, failed: Number(c.failed) || 0, skipped: Number(c.skipped) || 0,
      total: (Number(c.queued) || 0) + (Number(c.sending) || 0) + (Number(c.sent) || 0) + (Number(c.failed) || 0) + (Number(c.skipped) || 0) } };
}
async function countsFor_(db, ids) {
  const out = {};
  if (!ids.length) return out;
  const { results } = await db.prepare(`SELECT campaignId, status, count(*) AS n FROM email_campaign_recipients WHERE campaignId IN (${ids.map(() => "?").join(",")}) GROUP BY campaignId, status`).bind(...ids).all();
  for (const r of results || []) (out[r.campaignId] = out[r.campaignId] || {})[r.status] = Number(r.n) || 0;
  return out;
}
// How many uses this campaign's codes have had: its shared code's uses since it started, or its own codes' uses.
async function codesUsed_(db, c) {
  try {
    if (c.discount.mode === "unique" && c.startedAt) {
      const r = await db.prepare(`SELECT count(*) AS n FROM discount_code_uses u JOIN discount_codes d ON d.id = u.codeId
        JOIN email_campaign_recipients r ON r.code = d.code AND r.campaignId = ? WHERE u.releasedAt IS NULL`).bind(c.id).first();
      return Number(r && r.n) || 0;
    }
    if (c.discount.mode === "shared" && c.startedAt) {
      const r = await db.prepare("SELECT count(*) AS n FROM discount_code_uses WHERE codeId = ? AND releasedAt IS NULL AND usedAt >= ?").bind(c.discount.codeId, c.startedAt).first();
      return Number(r && r.n) || 0;
    }
  } catch (e) { /* no discount tables: none */ }
  return 0;
}

// { campaigns, total } newest first; status "" = all.
export async function listCampaigns(db, { status = "", limit = 50, offset = 0 } = {}) {
  const lim = Math.min(200, Math.max(1, Math.floor(Number(limit)) || 50)), off = Math.max(0, Math.floor(Number(offset)) || 0);
  const ok = ["draft", "scheduled", "sending", "sent", "canceled"].includes(status);
  try {
    const w = ok ? " WHERE status = ?" : "";
    const b = ok ? [status] : [];
    const [{ results }, tot] = await Promise.all([
      db.prepare(`SELECT * FROM email_campaigns${w} ORDER BY updatedAt DESC, id DESC LIMIT ? OFFSET ?`).bind(...b, lim, off).all(),
      db.prepare(`SELECT count(*) AS n FROM email_campaigns${w}`).bind(...b).first(),
    ]);
    const rows = results || [];
    const counts = await countsFor_(db, rows.map(r => r.id));
    const list = rows.map(r => parseCampaign_(r, counts[r.id]));
    for (const c of list) { c.codesUsed = await codesUsed_(db, c); delete c.design; }
    return { campaigns: list, total: Number(tot && tot.n) || 0 };
  } catch (e) { if (noCampaignsYet_(e)) return { campaigns: [], total: 0, notReady: true }; throw e; }
}
export async function getCampaign(db, id) {
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n < 1) return null;
  try {
    const row = await db.prepare("SELECT * FROM email_campaigns WHERE id = ?").bind(n).first();
    if (!row) return null;
    const c = parseCampaign_(row, (await countsFor_(db, [n]))[n]);
    c.codesUsed = await codesUsed_(db, c);
    return c;
  } catch (e) { if (noCampaignsYet_(e)) return null; throw e; }
}

// A new campaign (no id) or a change to a draft or scheduled one (a scheduled one goes back to draft unless it is
// scheduled again). { campaign } | { error } | { notReady }.
export async function saveCampaign(db, input, { actor = "", now = new Date().toISOString() } = {}) {
  const p = input && typeof input === "object" ? input : {};
  const Rr = R();
  const themeKey = Rr.THEMES[p.theme] ? p.theme : "plain";
  const design = Rr.normalizeDesign(p.design);
  const designJson = JSON.stringify(design);
  if (designJson.length > 400000) return { error: "This email is too big. Take out some blocks or shorten the HTML." };
  const fields = {
    name: String(p.name == null ? "" : p.name).trim().slice(0, 120),
    subject: String(p.subject == null ? "" : p.subject).replace(/[\r\n]+/g, " ").trim().slice(0, 200),
    preheader: String(p.preheader == null ? "" : p.preheader).replace(/[\r\n]+/g, " ").trim().slice(0, 200),
    theme: themeKey, designJson,
    audienceJson: JSON.stringify(cleanAudience(p.audience)),
    discountJson: JSON.stringify(cleanDiscount(p.discount)),
  };
  const id = p.id == null || p.id === "" ? 0 : Number(p.id);
  try {
    if (!id) {
      const r = await db.prepare(`INSERT INTO email_campaigns (name, subject, preheader, theme, designJson, audienceJson, discountJson, status, createdAt, createdBy, updatedAt)
                                  VALUES (?,?,?,?,?,?,?, 'draft', ?, ?, ?)`)
        .bind(fields.name, fields.subject, fields.preheader, fields.theme, fields.designJson, fields.audienceJson, fields.discountJson, now, String(actor || "").slice(0, 200), now).run();
      return { campaign: await getCampaign(db, r.meta.last_row_id) };
    }
    if (!Number.isSafeInteger(id) || id < 1) return { error: "Campaign not found." };
    const r = await db.prepare(`UPDATE email_campaigns SET name=?, subject=?, preheader=?, theme=?, designJson=?, audienceJson=?, discountJson=?, updatedAt=?,
                                       status = 'draft', scheduledAt = NULL
                                 WHERE id = ? AND status IN ('draft','scheduled')`)
      .bind(fields.name, fields.subject, fields.preheader, fields.theme, fields.designJson, fields.audienceJson, fields.discountJson, now, id).run();
    if (!(Number(r && r.meta && r.meta.changes) > 0)) {
      const c = await getCampaign(db, id);
      return { error: c ? "This campaign has been sent or is sending, so it can't change. Copy it to make a new one." : "Campaign not found." };
    }
    return { campaign: await getCampaign(db, id) };
  } catch (e) { if (noCampaignsYet_(e)) return { error: CAMPAIGNS_NOT_READY, notReady: true }; throw e; }
}

// Only a campaign that never started (a draft, or canceled before it began) can be deleted.
export async function deleteCampaign(db, id) {
  const n = Number(id);
  try {
    const r = await db.prepare("DELETE FROM email_campaigns WHERE id = ? AND startedAt IS NULL AND status IN ('draft','canceled','scheduled')").bind(n).run();
    if (Number(r && r.meta && r.meta.changes) > 0) return { ok: true };
    return { error: (await getCampaign(db, n)) ? "This campaign has started sending, so it's kept for the record." : "Campaign not found." };
  } catch (e) { if (noCampaignsYet_(e)) return { error: CAMPAIGNS_NOT_READY, notReady: true }; throw e; }
}
export async function copyCampaign(db, id, { actor = "", now = new Date().toISOString() } = {}) {
  const c = await getCampaign(db, id);
  if (!c) return { error: "Campaign not found." };
  return saveCampaign(db, { name: (c.name || "Campaign") + " (copy)", subject: c.subject, preheader: c.preheader, theme: c.theme, design: c.design,
    audience: c.audience, discount: c.discount }, { actor, now });
}

// What a campaign needs before it can be scheduled or sent: "" when it's ready.
export function campaignNotReady(c) {
  if (!c.subject) return "Give the email a subject.";
  const d = c.design || {};
  if (!(d.html && String(d.html).trim()) && !(Array.isArray(d.blocks) && d.blocks.length)) return "The email is empty. Add some blocks.";
  if (c.discount.mode === "unique") {
    if (c.discount.kind === "percent" && !(c.discount.percent > 0 && c.discount.percent <= 100)) return "Enter the percent off for the codes.";
    if (c.discount.kind === "amount" && !(c.discount.amount > 0)) return "Enter the amount off for the codes.";
  }
  return audienceError(c.audience);
}

// Schedule (at: an ISO time in the future) or send now (at: null): checks it, then a scheduled one waits; one sent
// now is started at once (startCampaign_). { campaign } | { error }.
export async function scheduleCampaign(env, id, at, { now = new Date() } = {}) {
  const db = env.DB;
  const c = await getCampaign(db, id);
  if (!c) return { error: "Campaign not found." };
  if (!["draft", "scheduled"].includes(c.status)) return { error: "This campaign has already been sent." };
  const notReady = campaignNotReady(c);
  if (notReady) return { error: notReady };
  if (c.discount.mode === "shared") {
    const code = await getDiscountCode(db, c.discount.codeId);
    if (!code) return { error: "The campaign's discount code wasn't found. Pick another." };
    if (code.status !== "active") return { error: `The code ${code.code} isn't usable now (${code.status === "off" ? "switched off" : code.status === "expired" ? "expired" : "used up"}). Pick another.` };
  }
  if (at) {
    const when = new Date(at);
    if (isNaN(when) || when.getTime() < now.getTime() + 60000) return { error: "Pick a time at least a minute from now." };
    if (when.getTime() > now.getTime() + 366 * 86400000) return { error: "Pick a time within the next year." };
    await db.prepare("UPDATE email_campaigns SET status = 'scheduled', scheduledAt = ?, updatedAt = ? WHERE id = ? AND status IN ('draft','scheduled')")
      .bind(when.toISOString(), now.toISOString(), c.id).run();
    return { campaign: await getCampaign(db, c.id) };
  }
  const started = await startCampaign_(env, c, now);
  if (started.error) return started;
  return { campaign: await getCampaign(db, c.id) };
}
export async function cancelCampaign(db, id, now = new Date().toISOString()) {
  const n = Number(id);
  try {
    const r = await db.prepare("UPDATE email_campaigns SET status = 'canceled', updatedAt = ? WHERE id = ? AND status IN ('scheduled','sending')").bind(now, n).run();
    if (!(Number(r && r.meta && r.meta.changes) > 0)) return { error: (await getCampaign(db, n)) ? "Only a scheduled campaign, or one still sending, can be canceled." : "Campaign not found." };
    // The emails not sent yet aren't: marked skipped, so the counts say so.
    await db.prepare("UPDATE email_campaign_recipients SET status = 'skipped', error = 'Canceled' WHERE campaignId = ? AND status = 'queued'").bind(n).run();
    return { ok: true, campaign: await getCampaign(db, n) };
  } catch (e) { if (noCampaignsYet_(e)) return { error: CAMPAIGNS_NOT_READY, notReady: true }; throw e; }
}

// Starting: the audience as it is now becomes the recipient list (and each person's own code, for unique codes),
// then the campaign is 'sending'. One conditional UPDATE claims the start, so two runners can't both build the list.
async function startCampaign_(env, c, now) {
  const db = env.DB;
  const timeZone = await resolveTimeZone(env).catch(() => "UTC");
  const aud = await campaignAudience(db, c.audience, { now, timeZone });
  if (aud.error) return { error: aud.error };
  if (!aud.count) return { error: "No one matches who this campaign is for (after leaving out anyone who unsubscribed)." };
  if (aud.tooMany) return { error: `That's ${aud.count.toLocaleString("en-US")} people; one campaign goes to at most ${AUDIENCE_MAX.toLocaleString("en-US")}. Narrow who gets it.` };
  const claim = await db.prepare("UPDATE email_campaigns SET status = 'sending', startedAt = ?, updatedAt = ? WHERE id = ? AND status IN ('draft','scheduled') AND startedAt IS NULL")
    .bind(now.toISOString(), now.toISOString(), c.id).run();
  if (!(Number(claim && claim.meta && claim.meta.changes) > 0)) return { error: "This campaign has already started." };
  const codes = new Map();
  if (c.discount.mode === "unique") {
    const emails = aud.people.map(p => p.email);
    for (let i = 0; i < emails.length; i += 500) {
      const r = await createDiscountCodesForEmails(db, { emails: emails.slice(i, i + 500), prefix: c.discount.prefix, kind: c.discount.kind, percent: c.discount.percent,
        amount: c.discount.amount, maxDiscount: c.discount.maxDiscount, orgId: c.discount.orgId, expiresOn: c.discount.expiresOn,
        note: ("Campaign: " + (c.name || c.subject)).slice(0, 200) }, { actor: c.createdBy, now: now.toISOString() });
      if (r && r.error) {
        await db.prepare("UPDATE email_campaigns SET status = 'draft', startedAt = NULL WHERE id = ?").bind(c.id).run();
        return { error: "Couldn't make the codes: " + r.error };
      }
      for (const m of (r && r.codes) || []) codes.set(m.email, m.code);
    }
  }
  const people = aud.people;
  for (let i = 0; i < people.length; i += 50) {
    await db.batch(people.slice(i, i + 50).map(p => db.prepare("INSERT OR IGNORE INTO email_campaign_recipients (campaignId, email, name, code, status) VALUES (?,?,?,?, 'queued')")
      .bind(c.id, p.email, p.name.slice(0, 200), codes.get(p.email) || "")));
  }
  return { ok: true, count: people.length };
}

// ---- Sending ------------------------------------------------------------------------------------------------------
const firstName_ = (name) => String(name || "").trim().split(/\s+/)[0] || "";
const cmpLongDate_ = (day) => { try { return new Date(day + "T12:00:00Z").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }); } catch (e) { return day; } };
const cmpDesktop_ = (env) => String((env && env.EDITION) || "").trim().toLowerCase() === "desktop";
function siteBase_(env) {
  const root = String((env && env.ROOT_DOMAIN) || "").trim().toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  return cmpDesktop_(env) || !root ? "" : "https://" + root;
}
// The banner's picture: on the web a link to the site's copy; in the desktop program (no site anyone can open) the
// picture itself, attached to the email and shown from it (cid:). Read once per run.
async function bannerArt_(env, themeKey, cache) {
  if (cache.has(themeKey)) return cache.get(themeKey);
  let art = null;
  if (cmpDesktop_(env)) {
    try {
      if (env.ASSETS && typeof env.ASSETS.fetch === "function") {
        const res = await env.ASSETS.fetch(new Request("http://localhost/email-art/" + themeKey + ".png"));
        if (res.ok) {
          const bytes = new Uint8Array(await res.arrayBuffer());
          let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
          art = { url: "cid:art-" + themeKey, attachment: { filename: themeKey + ".png", contentType: "image/png", contentBase64: btoa(bin), cid: "art-" + themeKey } };
        }
      }
    } catch (e) { art = null; }
  } else {
    const base = siteBase_(env);
    art = base ? { url: base + "/email-art/" + themeKey + ".png" } : null;
  }
  cache.set(themeKey, art);
  return art;
}
// The footer every campaign email ends with: the business block (email.js fills %%FOOTER_*%%) and how to stop them.
async function footerFor_(env, email) {
  const R0 = R();
  if (cmpDesktop_(env)) {
    return { html: "%%FOOTER_HTML%%<br>You're getting this because you're a customer. Don't want these emails? Reply with UNSUBSCRIBE.",
      text: "%%FOOTER_TEXT%%\nYou're getting this because you're a customer. Don't want these emails? Reply with UNSUBSCRIBE.", listUnsubscribe: "" };
  }
  const token = await unsubscribeToken(env, email).catch(() => "");
  const base = siteBase_(env);
  const link = token && base ? `${base}/api/unsubscribe?e=${encodeURIComponent(email)}&t=${token}` : "";
  return { html: "%%FOOTER_HTML%%<br>You're getting this because you're a customer. " + (link ? `<a href="${R0.esc(link)}" style="color:#6b6558;">Unsubscribe</a>` : "Reply with UNSUBSCRIBE to stop these emails."),
    text: "%%FOOTER_TEXT%%\nYou're getting this because you're a customer. " + (link ? "Unsubscribe: " + link : "Reply with UNSUBSCRIBE to stop these emails."),
    listUnsubscribe: link ? `<${link}>` : "" };
}
// One email for one person: { to, subject, html, text, attachments, listUnsubscribe }.
export async function buildCampaignEmail(env, c, person, { artCache = new Map(), shared = null, business = "" } = {}) {
  const Rr = R();
  const art = await bannerArt_(env, c.theme, artCache);
  const footer = await footerFor_(env, person.email);
  const code = person.code || (shared ? shared.code : "");
  const codeInfo = shared || (person.codeInfo || null);
  const vars = { name: person.name || "", firstName: firstName_(person.name), code, business, shop: business,
    codeLabel: code && codeInfo ? codeInfo.label : "", expires: code && codeInfo && codeInfo.expiresOn ? cmpLongDate_(codeInfo.expiresOn) : "" };
  const out = Rr.render({ theme: c.theme, design: c.design, vars, preheader: c.preheader, subject: c.subject,
    shopUrl: siteBase_(env), assetBase: siteBase_(env), artUrl: () => art ? art.url : "", footerHtml: footer.html, footerText: footer.text });
  return { to: person.email, subject: Rr.merge(c.subject, vars, false), html: out.html, text: out.text,
    attachments: art && art.attachment && /cid:art-/.test(out.html) ? [art.attachment] : [], listUnsubscribe: footer.listUnsubscribe };
}

// A test send of a campaign (as it is now, saved or not) to one address — the owner's, usually.
export async function sendCampaignTest(env, c, to) {
  const email = normalizeCustomerEmail_(to);
  if (!email) return { error: "Enter the address to send the test to." };
  if (!(await emailCanSend(env))) return { error: "Email isn't set up yet." };
  const business = ((await getBusinessProfile(env.DB).catch(() => null)) || {}).name || "";
  let shared = null;
  if (c.discount && c.discount.mode === "shared") { const code = await getDiscountCode(env.DB, c.discount.codeId).catch(() => null); if (code) shared = code; }
  const sample = c.discount && c.discount.mode === "unique" ? { code: "SAMPLE-CODE", codeInfo: { label: sampleLabel_(c.discount), expiresOn: c.discount.expiresOn } } : {};
  const msg = await buildCampaignEmail(env, c, { email, name: "", ...sample }, { shared, business });
  const ok = await sendCampaignEmail(env, { ...msg, subject: "[Test] " + msg.subject });
  return ok ? { ok: true, sentTo: email } : { error: "The test couldn't be sent. Check the email settings (Global settings → Email)." };
}
function sampleLabel_(d) {
  if (d.kind === "amount") return "$" + Number(d.amount || 0).toFixed(2) + " off";
  return String(Number(d.percent || 0)) + "% off" + (d.maxDiscount ? ", up to $" + Number(d.maxDiscount).toFixed(2) : "");
}

// One run of the queue: starts scheduled campaigns that are due, then sends up to `limit` queued emails (oldest
// campaign first). { started, sent, failed, finished, campaigns } — never throws for one bad email.
export async function runCampaignQueue(env, { limit = QUEUE_BATCH, now = new Date(), campaignId = null } = {}) {
  const db = env && env.DB;
  const out = { started: 0, sent: 0, failed: 0, finished: 0 };
  if (!db) return out;
  if (!(await emailCanSend(env).catch(() => false))) return { ...out, noEmail: true };
  let due;
  try { due = (await db.prepare("SELECT id FROM email_campaigns WHERE status = 'scheduled' AND scheduledAt <= ? ORDER BY scheduledAt LIMIT 5").bind(now.toISOString()).all()).results || []; }
  catch (e) { if (noCampaignsYet_(e)) return out; throw e; }
  for (const d of due) {
    const c = await getCampaign(db, d.id);
    if (!c) continue;
    const r = await startCampaign_(env, c, now);
    if (r.ok) out.started++;
    else {
      // Couldn't start (no one matches any more, a code gone): back to a draft, and the owner hears about it.
      await db.prepare("UPDATE email_campaigns SET status = 'draft', scheduledAt = NULL, updatedAt = ? WHERE id = ? AND status = 'scheduled'").bind(now.toISOString(), c.id).run();
      await recordSystemIssue(db, "campaign_failed", (c.name || c.subject || "Campaign") + ": " + r.error).catch(() => {});
    }
  }
  const sending = (await db.prepare(`SELECT id FROM email_campaigns WHERE status = 'sending'${campaignId ? " AND id = ?" : ""} ORDER BY startedAt, id LIMIT 5`)
    .bind(...(campaignId ? [Number(campaignId)] : [])).all()).results || [];
  const business = ((await getBusinessProfile(db).catch(() => null)) || {}).name || "";
  const artCache = new Map();
  let left = Math.max(1, Math.min(100, Math.floor(Number(limit)) || QUEUE_BATCH));
  for (const s of sending) {
    if (left <= 0) break;
    const c = await getCampaign(db, s.id);
    if (!c || c.status !== "sending") continue;
    let shared = null;
    if (c.discount.mode === "shared") shared = await getDiscountCode(db, c.discount.codeId).catch(() => null);
    const codeInfo = c.discount.mode === "unique" ? { label: sampleLabel_(c.discount), expiresOn: c.discount.expiresOn } : null;
    const { results } = await db.prepare("SELECT id, email, name, code FROM email_campaign_recipients WHERE campaignId = ? AND status = 'queued' ORDER BY id LIMIT ?").bind(c.id, left).all();
    for (const r of results || []) {
      // Taken by this run, or by another one already: only the run that changed it sends it.
      const take = await db.prepare("UPDATE email_campaign_recipients SET status = 'sending' WHERE id = ? AND status = 'queued'").bind(r.id).run();
      if (!(Number(take && take.meta && take.meta.changes) > 0)) continue;
      left--;
      // Unsubscribed since the campaign started: skipped.
      const out_ = await db.prepare("SELECT 1 AS x FROM marketing_optouts WHERE email = ?").bind(r.email).first();
      if (out_) { await db.prepare("UPDATE email_campaign_recipients SET status = 'skipped', error = 'Unsubscribed' WHERE id = ?").bind(r.id).run(); continue; }
      let ok = false, why = "";
      try {
        const msg = await buildCampaignEmail(env, c, { email: r.email, name: r.name, code: r.code, codeInfo }, { artCache, shared, business });
        ok = await sendCampaignEmail(env, msg);
        if (!ok) why = "The email service didn't accept it.";
      } catch (e) { why = String((e && e.message) || e).slice(0, 200); }
      await db.prepare("UPDATE email_campaign_recipients SET status = ?, sentAt = ?, error = ? WHERE id = ?").bind(ok ? "sent" : "failed", new Date().toISOString(), ok ? "" : why, r.id).run();
      if (ok) out.sent++; else out.failed++;
      if (left <= 0) break;
    }
    const rest = await db.prepare("SELECT count(*) AS n FROM email_campaign_recipients WHERE campaignId = ? AND status = 'queued'").bind(c.id).first();
    if (!(Number(rest && rest.n) > 0)) {
      const done = await db.prepare("UPDATE email_campaigns SET status = 'sent', sentAt = ?, updatedAt = ? WHERE id = ? AND status = 'sending'").bind(new Date().toISOString(), new Date().toISOString(), c.id).run();
      if (Number(done && done.meta && done.meta.changes) > 0) out.finished++;
    }
  }
  return out;
}
