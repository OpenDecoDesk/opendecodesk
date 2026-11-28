process.env.TZ = "UTC";
const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { ok } = require("./testlib/check");
const roles = require("./testlib/roles");
const { shopOrigin } = require("./testlib/hosts.js");

// The Gift card liability report (phase 8) and the gift card "sell online" tick that needs card payments (phase 8
// addendum). Real db.js / orders.js / permissions.js / catalog.js on sql.js.
//   db.js getGiftCardLiability: the gift card ledger month by month on the business's calendar (America/Chicago here),
//   with the ledger written by the real issueGiftCard (sold on an order / given free), redeemGiftCard, refundToGiftCard,
//   adjustGiftCard (both signs) and voidGiftCard at times on the edges of business days and months; opening and closing
//   chained month to month, empty months listed, totals, what active cards hold now, a bad date range and a database
//   from before the gift card tables.
//   The getGiftCardLiability action: dates checked (YYYY-MM-DD, in order, at most three years), who may (the Gift cards
//   permission at Read), the Gift cards switch.
//   orders.js getGiftCardSettings cardReady, updateGiftCardSettings and Global settings → Save refusing "sell online"
//   while card payments aren't set up and switched on, and the shop's catalog never selling cards online then.
// "Now" is fixed (2026-06-10 15:00 UTC) inside the code under test. Invented shops, people and orders only.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/^import "[^"\n]+";\n/gm, "").replace(/export (async function|function|const)/g, "$1");
const NOW = Date.parse("2026-06-10T15:00:00.000Z");
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(NOW); }
  static now() { return NOW; }
}
globalThis.__FixedDate413 = FixedDate;
globalThis.__f413 = {};
const libs = strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  strip(read("functions/_lib/quoteToken.js")) + "\n" + strip(read("functions/_lib/boxSize.js")) + "\n";
const L = new Function("const Date = globalThis.__FixedDate413;\n" + libs +
  read("functions/_lib/permissions.js").replace(/export (async function|function|const)/g, "$1") + "\n" +
  "const requireAdmin = async (env, host, key, request, msg, need) => { const r = request.headers.get('x-role') || 'admin'; return roleAllows(DEFAULT_ROLES[r] || null, need === 'staff' ? '*' : need) ? null : new Response(JSON.stringify({ status: 'error', code: 'forbidden' }), { status: 403 }); };\n" +
  "const adminActor = () => 'owner@example.test'; " + roles.adminAs({ roleFrom: "request.headers.get('x-role') || 'admin'" }) + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: { club: 'club' }, orgs: {}, features: globalThis.__f413 });\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  strip(read("functions/_lib/db.js")) + "\n" + strip(read("functions/_lib/email.js")) + "\n" + strip(read("functions/_lib/digital.js")) + "\n" +
  strip(read("functions/api/orders.js")) +
  "\nreturn { post: onRequestPost, getGiftCardLiability, issueGiftCard, redeemGiftCard, refundToGiftCard, adjustGiftCard, voidGiftCard, businessRange_, businessMonth_ };")();
// The shop's catalog: the real catalogCache.js and catalog.js (the Cache API is a Map, emptied before each read).
const C = new Function(libs + strip(read("functions/_lib/db.js")) + "\n" + strip(read("functions/_lib/catalogCache.js")) + "\n" +
  "const catalogApi = (function(){\n" + strip(read("functions/api/catalog.js")) + "\nreturn { onRequestGet }; })();\n" +
  "return { catalogGet: catalogApi.onRequestGet, publishShop, setFeatures, setGiftCardSettings, _resetCatalogCacheState };")();
function freshCacheApi() {
  const store = new Map();
  global.caches = { default: {
    async match(key) { const hit = store.get(typeof key === "string" ? key : key.url); return hit ? hit.clone() : undefined; },
    async put(key, response) { store.set(typeof key === "string" ? key : key.url, response); },
  } };
  C._resetCatalogCacheState();
}
global.fetch = async (url) => { throw new Error("unexpected fetch " + url); };

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const migrations = fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort();
const fresh = async (upTo) => {
  const d = await createD1();
  d._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of migrations.filter(f => !upTo || f < upTo)) d.execFile(read("migrations/" + f));
  d._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('club','club','Example Club','t','t',1);
    INSERT INTO global_settings (key, value) VALUES ('locale', '{"timeZone":"America/Chicago","country":"US"}');`);
  return d;
};
const callOn = (d1, env = {}) => async (body, role = "admin") => {
  const res = await L.post({ env: { DB: d1, SIGNING_SECRET: "s".repeat(40), ...env }, waitUntil: (p) => Promise.resolve(p).catch(() => {}),
    request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: (h) => h.toLowerCase() === "x-role" ? role : null } } });
  return { status: res.status, body: JSON.parse(await res.text()) };
};

// An order owing $100, written straight to the tables (a gift card pays part of it).
const order = (d1, id) => d1._raw.exec(`INSERT INTO orders (orderId, orgId, customerName, contact, placedAt, paid, taxMode)
  VALUES ('${id}', 'club', 'Pat Example', 'pat@example.com', '2026-01-02T18:00:00.000Z', 0, 'inclusive');
  INSERT INTO order_items (orderId, orgId, productId, name, type, qty, lineTotalCents, taxCents) VALUES ('${id}', 'club', 'tee', 'Club Tee', 'shirt', 1, 10000, 0);`);
const KEYS = ["openingCents", "soldCents", "issuedCents", "redeemedCents", "refundedCents", "adjustedCents", "voidedCents", "closingCents"];
const row = (m) => KEYS.map(k => m[k]);

(async () => {
  const d1 = await fresh();
  const q1 = (sql, ...p) => d1.q(sql, ...p)[0] || null;
  const must = (r) => { if (!r || r.error || r.ok === false) throw new Error("setup: " + JSON.stringify(r)); return r; };

  console.log("=== The ledger the report reads, written by the real gift card functions (business zone America/Chicago) ===");
  // Before the range: P given free on 31 Dec 23:30 in Chicago (already 1 Jan in UTC).
  const P = must(await L.issueGiftCard(d1, { amountCents: 1000, note: "Raffle prize", now: "2026-01-01T05:30:00.000Z" }));
  // January: $3 of P spent at 00:30 on 1 Jan in Chicago; S sold on an order at 23:30 on 31 Jan in Chicago (1 Feb in UTC).
  order(d1, "WEB-4131");
  must(await L.redeemGiftCard(d1, { cardId: P.id, orderId: "WEB-4131", amountCents: 300, now: "2026-01-01T06:30:00.000Z" }));
  const S = must(await L.issueGiftCard(d1, { amountCents: 5000, sourceOrderId: "WEB-4130", buyerEmail: "pat@example.com", now: "2026-02-01T05:30:00.000Z" }));
  // February: nothing. March: $20 of S spent and $5 of it put back; I given at 23:30 on 31 Mar in Chicago (1 Apr in UTC);
  // V given on 10 Mar.
  order(d1, "WEB-4132");
  const spend = must(await L.redeemGiftCard(d1, { cardId: S.id, orderId: "WEB-4132", amountCents: 2000, now: "2026-03-15T17:00:00.000Z" }));
  must(await L.refundToGiftCard(d1, { paymentId: spend.paymentId, amountCents: 500, now: "2026-03-20T17:00:00.000Z" }));
  const I = must(await L.issueGiftCard(d1, { amountCents: 2500, now: "2026-04-01T04:30:00.000Z" }));
  const V = must(await L.issueGiftCard(d1, { amountCents: 2000, now: "2026-03-10T17:00:00.000Z" }));
  // April: I adjusted up $4 and down $1.50; V voided ($20 gone); Q sold at 23:30 on 30 Apr in Chicago (1 May in UTC).
  must(await L.adjustGiftCard(d1, { id: I.id, deltaCents: 400, note: "Make good", now: "2026-04-05T17:00:00.000Z" }));
  must(await L.adjustGiftCard(d1, { id: I.id, deltaCents: -150, note: "Typo", now: "2026-04-06T17:00:00.000Z" }));
  must(await L.voidGiftCard(d1, { id: V.id, note: "Lost", now: "2026-04-07T17:00:00.000Z" }));
  must(await L.issueGiftCard(d1, { amountCents: 1500, sourceOrderId: "WEB-4133", now: "2026-05-01T04:30:00.000Z" }));
  // After the range: M sold at 00:30 on 1 May in Chicago.
  must(await L.issueGiftCard(d1, { amountCents: 1500, sourceOrderId: "WEB-4134", now: "2026-05-01T05:30:00.000Z" }));
  const kinds = d1.q("SELECT kind, deltaCents FROM gift_card_ledger ORDER BY id").map(r => r.kind + " " + r.deltaCents).join(", ");
  ok("the ledger holds an issue, a redeem (negative), a refund (positive), an adjust of each sign and a void (negative)",
    kinds === "issue 1000, redeem -300, issue 5000, redeem -2000, refund 500, issue 2500, issue 2000, adjust 400, adjust -150, void -2000, issue 1500, issue 1500");
  ok("cards sold on an order carry their order number and those given free don't", q1("SELECT sourceOrderId FROM gift_cards WHERE id = ?", S.id).sourceOrderId === "WEB-4130" && q1("SELECT sourceOrderId FROM gift_cards WHERE id = ?", P.id).sourceOrderId === "");

  console.log("\n=== getGiftCardLiability: January to April 2026 ===");
  const R = await L.getGiftCardLiability(d1, { dateFrom: "2026-01-01", dateTo: "2026-04-30" });
  ok("the answer gives back the dates asked for", R.dateFrom === "2026-01-01" && R.dateTo === "2026-04-30");
  ok("every month in the range is listed in order, February too though nothing happened in it", same(R.months.map(m => m.month), ["2026-01", "2026-02", "2026-03", "2026-04"]));
  ok("each month has exactly opening, sold, issued, redeemed, refunded, adjusted, voided and closing",
    R.months.every(m => same(Object.keys(m), ["month", ...KEYS])));
  ok("opening: $10 on cards before 1 January in Chicago (a card given at 23:30 on 31 December there, already January in UTC)", R.months[0].openingCents === 1000 && R.totals.openingCents === 1000);
  ok("January: $50 sold (on an order, at 23:30 on 31 January in Chicago though 1 February in UTC) and $3 spent at 00:30 on 1 January in Chicago, closing $57",
    same(row(R.months[0]), [1000, 5000, 0, 300, 0, 0, 0, 5700]));
  ok("February: nothing happened, so it opens and closes on January's $57 with every column 0", same(row(R.months[1]), [5700, 0, 0, 0, 0, 0, 0, 5700]));
  ok("March: $45 given free (one at 23:30 on 31 March in Chicago, 1 April in UTC), $20 spent shown as a positive amount, $5 put back, closing $87",
    same(row(R.months[2]), [5700, 0, 4500, 2000, 500, 0, 0, 8700]));
  ok("April: $15 sold at 23:30 on 30 April in Chicago (the last moment of the range), $2.50 adjusted (up $4, down $1.50), $20 voided shown as a positive amount, closing $84.50",
    same(row(R.months[3]), [8700, 1500, 0, 0, 0, 250, 2000, 8450]));
  ok("each month opens on the month before's closing", R.months.every((m, i) => i === 0 || m.openingCents === R.months[i - 1].closingCents));
  ok("each closing is its opening plus sold, issued, refunded and adjusted, less redeemed and voided",
    R.months.every(m => m.closingCents === m.openingCents + m.soldCents + m.issuedCents + m.refundedCents + m.adjustedCents - m.redeemedCents - m.voidedCents));
  ok("totals: the first opening, the sum of each column, the last closing (a card sold after the range, at 00:30 on 1 May in Chicago, left out)",
    same(R.totals, { openingCents: 1000, soldCents: 6500, issuedCents: 4500, redeemedCents: 2300, refundedCents: 500, adjustedCents: 250, voidedCents: 2000, closingCents: 8450 }));
  const active = q1("SELECT SUM(balanceCents) AS n FROM gift_cards WHERE status = 'active'").n;
  ok("on cards right now: what the active cards hold ($99.50, the card sold in May included, the voided one not)", R.outstandingNowCents === 9950 && active === 9950);

  console.log("\n=== Closing as of today, a range across the year's end, a range starting mid-month ===");
  const T = await L.getGiftCardLiability(d1, { dateFrom: "2026-01-01", dateTo: "2026-06-10" });
  ok("a range ending today: January to June, its last closing equals what the active cards hold now", same(T.months.map(m => m.month), ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"])
    && T.months[5].closingCents === T.outstandingNowCents && T.totals.closingCents === active);
  ok("…May holds the $15 card sold at 00:30 on 1 May in Chicago, June is empty", T.months[4].soldCents === 1500 && T.months[4].closingCents === 9950 && same(row(T.months[5]), [9950, 0, 0, 0, 0, 0, 0, 9950]));
  const Y = await L.getGiftCardLiability(d1, { dateFrom: "2025-11-15", dateTo: "2026-01-31" });
  ok("a range across the year's end lists November, December and January", same(Y.months.map(m => m.month), ["2025-11", "2025-12", "2026-01"]));
  ok("…December holds the card given at 23:30 on 31 December in Chicago, January doesn't", Y.months[1].issuedCents === 1000 && Y.months[0].closingCents === 0 && Y.months[2].issuedCents === 0 && Y.months[2].openingCents === 1000);
  ok("…and January's $50 sale at 23:30 on 31 January in Chicago is inside a range ending 31 January", Y.months[2].soldCents === 5000 && Y.totals.closingCents === 5700);
  const M = await L.getGiftCardLiability(d1, { dateFrom: "2026-01-02", dateTo: "2026-01-31" });
  ok("a range starting on 2 January: opening counts everything before that day (the $3 spent on 1 January too), January shows only what came after",
    M.months.length === 1 && M.months[0].openingCents === 700 && M.months[0].redeemedCents === 0 && M.months[0].soldCents === 5000 && M.months[0].closingCents === 5700);
  const before = await L.getGiftCardLiability(d1, { dateFrom: "2025-06-01", dateTo: "2025-07-31" });
  ok("months before any card: listed, all 0, while what cards hold now is still given", same(before.months.map(row), [[0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0]]) && before.outstandingNowCents === 9950);

  d1._raw.exec(`INSERT INTO gift_cards (code, last4, initialCents, balanceCents, status, createdAt) VALUES ('X413', 'X413', 700, 700, 'void', '2026-02-02T18:00:00.000Z')`);
  ok("a voided card still showing a balance is not money on cards: only active cards count", (await L.getGiftCardLiability(d1, { dateFrom: "2026-01-01", dateTo: "2026-01-31" })).outstandingNowCents === 9950);
  d1._raw.exec(`DELETE FROM gift_cards WHERE code = 'X413'`);

  {
    // The first and last millisecond of March in Chicago (CST at the start, CDT at the end).
    const e = await fresh();
    for (const [cents, at] of [[100, "2026-03-01T05:59:59.999Z"], [200, "2026-03-01T06:00:00.000Z"], [400, "2026-04-01T04:59:59.999Z"], [800, "2026-04-01T05:00:00.000Z"]]) must(await L.issueGiftCard(e, { amountCents: cents, now: at }));
    const E = await L.getGiftCardLiability(e, { dateFrom: "2026-03-01", dateTo: "2026-03-31" });
    ok("the business day's edges to the millisecond: the last moment of 28 February opens March, midnight starting 1 March and 23:59:59.999 on 31 March are in it, midnight starting 1 April is not",
      E.months[0].openingCents === 100 && E.months[0].issuedCents === 600 && E.months[0].closingCents === 700 && E.outstandingNowCents === 1500);
  }

  console.log("\n=== getGiftCardLiability: dates it refuses, an older database, a failing one ===");
  ok("a day not written YYYY-MM-DD: “Choose the dates as YYYY-MM-DD.”", (await L.getGiftCardLiability(d1, { dateFrom: "2026-1-1", dateTo: "2026-04-30" })).error === "Choose the dates as YYYY-MM-DD."
    && (await L.getGiftCardLiability(d1, { dateFrom: "2026-01-01" })).error === "Choose the dates as YYYY-MM-DD." && (await L.getGiftCardLiability(d1)).error === "Choose the dates as YYYY-MM-DD.");
  ok("the start after the end: “The start date is after the end date.”", (await L.getGiftCardLiability(d1, { dateFrom: "2026-05-01", dateTo: "2026-04-30" })).error === "The start date is after the end date.");
  const old = await fresh("0120");
  const O = await L.getGiftCardLiability(old, { dateFrom: "2026-01-01", dateTo: "2026-02-28" });
  ok("a database from before the gift card tables: the months listed with every amount 0 and nothing on cards (no error)",
    !O.error && same(O.months.map(m => m.month), ["2026-01", "2026-02"]) && O.months.every(m => KEYS.every(k => m[k] === 0)) && O.totals.closingCents === 0 && O.outstandingNowCents === 0);
  const failing = Object.create(d1);
  failing.prepare = (sql) => { if (/gift_card_ledger/.test(sql)) throw new Error("disk I/O error (test)"); return d1.prepare(sql); };
  let threw = "";
  try { await L.getGiftCardLiability(failing, { dateFrom: "2026-01-01", dateTo: "2026-01-31" }); } catch (e) { threw = e.message; }
  ok("any other database failure is not hidden as an empty report: it is thrown", threw === "disk I/O error (test)");

  console.log("\n=== The getGiftCardLiability action ===");
  const api = callOn(d1);
  let r = await api({ action: "getGiftCardLiability", dateFrom: "2026-01-01", dateTo: "2026-04-30" });
  ok("Admin: 200 with the dates, the months, the totals and what cards hold now", r.status === 200 && r.body.status === "ok" && r.body.dateFrom === "2026-01-01" && r.body.dateTo === "2026-04-30"
    && same(r.body.months, R.months) && same(r.body.totals, R.totals) && r.body.outstandingNowCents === 9950);
  r = await api({ action: "getGiftCardLiability", dateFrom: " 2026-01-01 ", dateTo: "2026-01-31 " });
  ok("spaces around the dates are trimmed", r.status === 200 && r.body.dateFrom === "2026-01-01" && r.body.months.length === 1);
  const codes = [];
  for (const who of ["admin", "manager", "staff", "production", "nobody"]) codes.push((await api({ action: "getGiftCardLiability", dateFrom: "2026-01-01", dateTo: "2026-01-31" }, who)).status);
  ok("who may read it (the Gift cards permission at Read): Admin, Manager and Back office yes, Production and nobody 403", same(codes, [200, 200, 200, 403, 403]));
  for (const [b, msg] of [
    [{ dateFrom: "2026-01-01" }, "Invalid date range — expected YYYY-MM-DD"],
    [{ dateFrom: "01/01/2026", dateTo: "2026-01-31" }, "Invalid date range — expected YYYY-MM-DD"],
    [{ dateFrom: "2026-02-01", dateTo: "2026-01-31" }, "The start date is after the end date."],
    [{ dateFrom: "2024-01-01", dateTo: "2027-01-01" }, "Pick at most three years."],
    [{ dateFrom: "2023-06-15", dateTo: "2026-06-15" }, "Pick at most three years."],
  ]) {
    const x = await api({ action: "getGiftCardLiability", ...b });
    ok("dates " + JSON.stringify(b).replace(/[{}"]/g, "") + " are refused with 400 “" + msg + "”", x.status === 400 && x.body.status === "error" && x.body.message === msg);
  }
  r = await api({ action: "getGiftCardLiability", dateFrom: "2024-01-01", dateTo: "2026-12-31" });
  ok("three whole years (2024-01-01 to 2026-12-31) are allowed, 36 months listed", r.status === 200 && r.body.months.length === 36 && r.body.months[35].month === "2026-12");
  r = await callOn(old)({ action: "getGiftCardLiability", dateFrom: "2026-01-01", dateTo: "2026-01-31" });
  ok("on a database from before the gift card tables the action answers 200 with zeros", r.status === 200 && r.body.totals.closingCents === 0);
  globalThis.__f413 = { giftCards: false };
  r = await api({ action: "getGiftCardLiability", dateFrom: "2026-01-01", dateTo: "2026-01-31" });
  const off = r;
  r = await api({ action: "getGiftCardLiability", dateFrom: "2026-01-01", dateTo: "2026-01-31" }, "production");
  globalThis.__f413 = {};
  ok("the Gift cards switch off: 403 naming the giftCards feature, and no months", off.status === 403 && off.body.feature === "giftCards" && !off.body.months);
  ok("…though a role without the permission still hears 403 for its role first", r.status === 403 && r.body.code === "forbidden" && !r.body.feature);
  threw = "";
  try { await callOn(failing)({ action: "getGiftCardLiability", dateFrom: "2026-01-01", dateTo: "2026-01-31" }); } catch (e) { threw = e.message; }
  ok("a database failure while reading: the action fails (the platform's error page), never a report of zeros", threw === "disk I/O error (test)");

  console.log("\n=== Global settings → Gift cards: cardReady (Stripe set up AND the Global Card method on) ===");
  const g = await fresh();
  const q1g = (sql, ...p) => g.q(sql, ...p)[0] || null;
  const setPay = (v) => g.q("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('enabledPayments', ?)", JSON.stringify(v));
  const storedPay = () => JSON.parse((q1g("SELECT value FROM global_settings WHERE key = 'enabledPayments'") || { value: "null" }).value);
  const storedGc = () => JSON.parse((q1g("SELECT value FROM global_settings WHERE key = 'giftCards'") || { value: "{}" }).value);
  const noKey = callOn(g), withKey = callOn(g, { STRIPE_SECRET_KEY: "sk_test_x" });
  const ready = async (call) => { const x = await call({ action: "getGiftCardSettings" }); return x.status === 200 ? x.body.giftCards.cardReady : "status " + x.status; };
  ok("no Stripe key: not ready", (await ready(noKey)) === false);
  ok("no Stripe key with Card ticked: still not ready", (setPay({ card: true, check: true }), await ready(noKey)) === false);
  ok("an empty Stripe key: not ready", (await ready(callOn(g, { STRIPE_SECRET_KEY: "" }))) === false);
  g.q("DELETE FROM global_settings WHERE key = 'enabledPayments'");
  ok("a Stripe key and Payment methods never saved (Card on by default): ready", (await ready(withKey)) === true);
  ok("a Stripe key and Card ticked: ready", (setPay({ card: true, check: true }), await ready(withKey)) === true);
  ok("a Stripe key and Card left out of the saved boxes (on unless switched off, as the shop's checkout reads it): ready", (setPay({ check: true }), await ready(withKey)) === true);
  ok("a Stripe key but Card switched off under Payment methods: not ready", (setPay({ card: false, check: true }), await ready(withKey)) === false);
  const unreadable = Object.create(g);
  unreadable.prepare = (sql) => { if (/key='enabledPayments'/.test(sql)) throw new Error("disk I/O error (test)"); return g.prepare(sql); };
  setPay({ card: true });
  r = await callOn(unreadable, { STRIPE_SECRET_KEY: "sk_test_x" })({ action: "getGiftCardSettings" });
  ok("the Payment methods can't be read: the settings still answer 200, with cardReady false", r.status === 200 && r.body.giftCards.cardReady === false && same(r.body.giftCards.amounts, [2500, 5000, 10000]));
  setPay({ card: false });
  g.q("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('giftCards', ?)", JSON.stringify({ sellOnline: true, amounts: [2500], minCents: 500, maxCents: 50000 }));
  r = await withKey({ action: "getGiftCardSettings" });
  ok("a “sell online” saved before card payments were switched off is still read back as saved, with cardReady false", r.status === 200 && r.body.giftCards.sellOnline === true && r.body.giftCards.cardReady === false);
  g.q("DELETE FROM global_settings WHERE key = 'giftCards'");

  console.log("\n=== updateGiftCardSettings: selling online is refused until card payments are ready ===");
  const NEEDS = "Set up card payments before selling gift cards on a shop.";
  const sell = { sellOnline: true, amounts: [2500, 5000], minCents: 500, maxCents: 50000 };
  const auditN = () => q1g("SELECT count(*) AS n FROM audit_log").n;
  let a0 = auditN();
  setPay({ card: true, check: true });
  r = await noKey({ action: "updateGiftCardSettings", ...sell });
  ok("no Stripe key: 400 “" + NEEDS + "”, nothing saved and nothing audited", r.status === 400 && r.body.message === NEEDS && storedGc().sellOnline === undefined && auditN() === a0);
  setPay({ card: false, check: true });
  r = await withKey({ action: "updateGiftCardSettings", ...sell });
  ok("a Stripe key but Card switched off: the same 400, nothing saved", r.status === 400 && r.body.message === NEEDS && storedGc().sellOnline === undefined);
  r = await withKey({ action: "updateGiftCardSettings", ...sell, amounts: [] });
  ok("a bad amount is reported before the card check", r.status === 400 && r.body.message === "Give 1 to 6 amounts for the buttons.");
  r = await withKey({ action: "updateGiftCardSettings", ...sell, sellOnline: false, amounts: [1500] });
  ok("not selling online is saved while card payments aren't ready (the amounts can still be changed)", r.status === 200 && r.body.giftCards.sellOnline === false && same(storedGc().amounts, [1500]));
  setPay({ card: true, check: true });
  a0 = auditN();
  r = await withKey({ action: "updateGiftCardSettings", ...sell });
  ok("a Stripe key and Card on: selling online is saved and audited", r.status === 200 && r.body.giftCards.sellOnline === true && storedGc().sellOnline === true && auditN() === a0 + 1);
  await withKey({ action: "updateGiftCardSettings", ...sell, sellOnline: false });

  console.log("\n=== Global settings → Save (saveGlobalSettingsAll): checked against the Payment methods as this Save leaves them ===");
  const save = (call, settings) => call({ action: "saveGlobalSettingsAll", settings });
  setPay({ card: true, check: true });
  r = await save(withKey, { payments: { card: false, check: true }, giftCards: sell });
  ok("Card switched off in the same Save as the tick: 400 “" + NEEDS + "” naming Gift cards", r.status === 400 && r.body.section === "Gift cards" && r.body.message === NEEDS);
  ok("…and nothing is saved: Card is still on and gift cards are still not sold online", storedPay().card === true && storedGc().sellOnline === false);
  setPay({ card: false, check: true });
  r = await save(withKey, { giftCards: sell });
  ok("the tick alone while Card is off: refused the same way, nothing saved", r.status === 400 && r.body.section === "Gift cards" && r.body.message === NEEDS && storedGc().sellOnline === false);
  r = await save(withKey, { payments: { check: true }, giftCards: { ...sell, amounts: [3000] } });
  ok("Payment methods saved without a Card box and the tick in one Save: Card counts as on, both saved", r.status === 200 && storedPay().card === undefined && storedGc().sellOnline === true && same(storedGc().amounts, [3000]));
  setPay({ card: false, check: true });
  await withKey({ action: "updateGiftCardSettings", ...sell, sellOnline: false });
  r = await save(withKey, { payments: { card: true, check: true }, giftCards: sell });
  ok("Card switched back on in the same Save as the tick: both saved", r.status === 200 && r.body.sections.includes("Gift cards") && storedPay().card === true && storedGc().sellOnline === true);
  await withKey({ action: "updateGiftCardSettings", ...sell, sellOnline: false });
  r = await save(noKey, { payments: { card: true, check: true }, giftCards: sell });
  ok("no Stripe key, even with Card ticked in the same Save: refused, nothing saved", r.status === 400 && r.body.message === NEEDS && storedGc().sellOnline === false);
  setPay({ card: false, check: true });
  r = await save(noKey, { payments: { card: false, check: true }, giftCards: { ...sell, sellOnline: false, amounts: [4000] } });
  ok("not selling online is saved in a Save while card payments aren't ready", r.status === 200 && storedGc().sellOnline === false && same(storedGc().amounts, [4000]));

  console.log("\n=== The shop's catalog: gift cards are sold online only where card payments are ready ===");
  await C.setFeatures(g, { giftCards: true });
  await C.publishShop(g, "club");
  const cat = async (env) => {
    freshCacheApi();
    const res = await C.catalogGet({ request: { url: shopOrigin("club") + "/api/catalog", headers: { get: () => null } }, env: { DB: g, ...env } });
    return (JSON.parse(await res.text()).catalog || {}).giftCards || {};
  };
  const KEY = { STRIPE_SECRET_KEY: "sk_test_x" };
  setPay({ card: false, check: true });
  await save(withKey, { giftCards: sell });
  ok("after the refused Save the shop sells no gift cards online (no amount buttons)", same(await cat(KEY), { sellOnline: false, amounts: [], min: 5, max: 500 }));
  await C.setGiftCardSettings(g, sell);
  ok("a “sell online” stored from before, with Card switched off: the shop still sells none", (await cat(KEY)).sellOnline === false);
  ok("…nor with Card on but no Stripe key", (setPay({ card: true, check: true }), (await cat({})).sellOnline === false));
  ok("…and with both ready the shop sells them, $25 and $50", same(await cat(KEY), { sellOnline: true, amounts: [25, 50], min: 5, max: 500 }));
})().catch((e) => { console.error(e); process.exitCode = 1; });
