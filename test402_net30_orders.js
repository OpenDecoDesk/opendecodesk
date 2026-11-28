// Net 30 with a PO on orders (migrations/0121, phase 7):
//   * db.js: orderPoStatus_ and net30DueDate_ (each start: the invoice, the order date, the order completed; the order's
//     own days or the usual; the business's calendar across midnight), insertOrder's Net 30 (days, the customer's days,
//     a PO typed by staff or by the customer), setOrderTerms and acceptOrderPo (every refusal and their answers, a
//     database before 0121), markInvoiced_ through sendOrderInvoice (the first send only), and the order readers.
//   * functions/api/orders.js through the real handler: setOrderTerms and acceptOrderPo (who may, each refusal, the
//     audit rows, downloads going out when a PO clears a digital order), getTermsSettings / updateTermsSettings, the
//     Local sale and quote Convert on Net 30, Global settings' Net 30 terms section and the Net 30 payment tick, and the
//     garment waiver saved with the Features switches.
// Real SQL (sql.js) under the real db.js, email.js, digital.js and orders.js. Invented shops, people and PO numbers.
// Every date is fixed and the business time zone is set: nothing depends on today or this machine's zone.
const fs = require("fs");
const { ok } = require("./testlib/check");
const { createD1 } = require("./testlib/d1-shim.js");
const roles = require("./testlib/roles");
const { MAIL_ENV, MAIL_OK, captureMail } = require("./testlib/mail-mock");
const { ADMIN_ORIGIN } = require("./testlib/hosts.js");

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/^import "[^"\n]+";\n/gm, "").replace(/export (async function|function|const)/g, "$1");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ordersJs = read("functions/api/orders.js");

// Who is signed in: globalThis.__who402 — a built-in role, "clerk" (order details at Edit only: may make a Local sale,
// not set Net 30), "quoter" (that and Quotes at Edit: may convert a quote, not on Net 30), or null (nobody).
const LEVELS = {};
for (const k of Object.keys(roles.DEFAULT_ROLES)) LEVELS[k] = roles.effectivePermissions(roles.DEFAULT_ROLES[k]);
LEVELS.clerk = { "orders.details": "edit" };
LEVELS.quoter = { "orders.details": "edit", "quotes.estimates": "edit", "customers.records": "read" };
const authSrc = `
const __LV402 = ${JSON.stringify(LEVELS)};
const __rank402 = (l) => l === "full" ? 3 : l === "edit" ? 2 : l === "read" ? 1 : 0;
const adminUser = () => { const k = globalThis.__who402; return k && __LV402[k] ? { id: 1, email: k + "@example.test", name: k, role: k, roleInfo: { key: k }, pending: null, bootstrap: false } : null; };
const adminLevel = (request, fn) => { const u = adminUser(); return u ? (__LV402[u.role][fn] || "none") : "none"; };
const adminCan = (request, fn, level) => __rank402(adminLevel(request, fn)) >= __rank402(level || "read");
const requireAdmin = async (env, host, key, request, msg, need) => {
  const u = adminUser();
  if (!u) return jsonResponse({ status: "error", message: "Unauthorized" }, 401);
  const okay = need === "*" || (Array.isArray(need) ? need.some(([fn, l]) => adminCan(request, fn, l)) : u.role === "admin");
  return okay ? null : jsonResponse({ status: "error", code: "forbidden", message: "Your role can't do this. Ask an admin." }, 403);
};
const adminActor = () => (globalThis.__who402 || "nobody") + "@example.test";
`;
globalThis.__f = {};
const glue = () => new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  strip(read("functions/_lib/quoteToken.js")) + "\n" + authSrc + "\n" + strip(read("functions/_lib/permissions.js")) + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyTurnstile = async () => ({ ok: true });\nconst invalidateCatalogVersionCache = () => {};\n" +
  "const getCatalogData = async () => ({ subdomainMap: { club: 'club', district: 'district' }, orgs: {}, features: globalThis.__f });\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  strip(read("functions/_lib/db.js")) + "\n" + strip(read("functions/_lib/vendorCredentials.js")) + "\n" + strip(read("functions/_lib/smtp.js")) + "\n" +
  strip(read("functions/_lib/email.js")) + "\n" + strip(read("functions/_lib/digital.js")) + "\n" + strip(read("functions/_lib/campaigns.js")) + "\n" +
  strip(read("functions/api/orders.js")) + `\nreturn { post: onRequestPost, insertOrder, setOrderTerms, acceptOrderPo, markInvoiced_, sendOrderInvoice, orderPoStatus_,
    net30DueDate_, getOrderById, resolveTimeZone, setLocaleSettings, setTerms, getTerms, net30Cleared, workCleared, TERMS_DEFAULT, TERMS_STARTS,
    getFeatures, OWN_GARMENTS_WAIVER_DEFAULT };`)();
const S = glue();

const mail = [];
globalThis.fetch = async (url, init) => {
  if (captureMail(url, init, mail)) return MAIL_OK;
  return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
};
// What the code logs on purpose (a refused audit write, terms that couldn't be saved) is kept here, not printed.
const logged = [];
const origErr = console.error;
console.error = (...a) => { logged.push(a.map(String).join(" ")); };

const migrations = fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort();
// A database as it was before migrations/0121 (no Net 30 columns).
const pre0121 = async () => {
  const old = await createD1();
  old._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of migrations.filter(f => f < "0121")) old.execFile(read("migrations/" + f));
  return old;
};

(async () => {
  const P = S.orderPoStatus_, D = S.net30DueDate_;
  const T = (startsAt, defaultDays = 30) => ({ startsAt, defaultDays });
  const N = (o) => ({ net30: true, ...o });

  console.log("=== The PO's status (db.js orderPoStatus_) ===");
  ok("not on Net 30 (or no order at all): no status", P({ net30: false, poNumber: "PO-1001", poAcceptedAt: "t" }) === "" && P(null) === "" && P(undefined) === "");
  ok("on Net 30 with no PO, or only spaces: PO needed", P(N({})) === "PO needed" && P(N({ poNumber: "   " })) === "PO needed" && P(N({ poNumber: null })) === "PO needed");
  ok("a PO nobody has accepted (the customer typed it): PO to check", P(N({ poNumber: "PO-1001", poTypedAt: "2026-03-01T10:00:00Z" })) === "PO to check");
  ok("a PO that was accepted: accepted", P(N({ poNumber: "PO-1001", poAcceptedAt: "2026-03-01T10:00:00Z" })) === "accepted");

  console.log("\n=== When a Net 30 order is due (db.js net30DueDate_) ===");
  const UTC = "UTC", LA = "America/Los_Angeles";
  const o = { placedAt: "2026-03-02T15:00:00.000Z", invoicedAt: "2026-03-10T15:00:00.000Z" };
  ok("not on Net 30, or no order: no due date", D({ ...o, net30: false }, T("order"), null, UTC) === "" && D(null, T("order"), null, UTC) === "");
  ok("days start at the invoice: the first invoice's day plus the days", D(N(o), T("invoice"), null, UTC) === "2026-04-09");
  ok("…and from the order date when no invoice was sent", D(N({ placedAt: o.placedAt }), T("invoice"), null, UTC) === "2026-04-01");
  ok("days start at the order date: the order date, even with an invoice sent", D(N(o), T("order"), null, UTC) === "2026-04-01");
  ok("days start when the order is completed: a completion time given wins", D(N({ ...o, shippedAt: "2026-03-20T15:00:00Z" }), T("completed"), "2026-03-05T15:00:00Z", UTC) === "2026-04-04");
  ok("…else when it was shipped", D(N({ ...o, shippedAt: "2026-03-20T15:00:00Z", deliveredAt: "2026-03-25T15:00:00Z", completedAt: "2026-03-28T15:00:00Z" }), T("completed"), null, UTC) === "2026-04-19");
  ok("…else when it was delivered or picked up", D(N({ ...o, deliveredAt: "2026-03-25T15:00:00Z", completedAt: "2026-03-28T15:00:00Z" }), T("completed"), null, UTC) === "2026-04-24");
  ok("…else when it was marked completed", D(N({ ...o, completedAt: "2026-03-28T15:00:00Z" }), T("completed"), null, UTC) === "2026-04-27");
  ok("…and not known yet (no due date) while it isn't completed", D(N(o), T("completed"), null, UTC) === "" && D(N(o), T("completed"), "", UTC) === "");
  ok("the order's own days win over the usual", D(N({ ...o, termsDays: 45 }), T("order", 30), null, UTC) === "2026-04-16");
  ok("the usual days apply when the order has none", D(N({ ...o, termsDays: null }), T("order", 60), null, UTC) === "2026-05-01");
  ok("an order's days that aren't 1–365 whole days count as none", D(N({ ...o, termsDays: 0 }), T("order", 10), null, UTC) === "2026-03-12" &&
    D(N({ ...o, termsDays: 400 }), T("order", 10), null, UTC) === "2026-03-12" && D(N({ ...o, termsDays: 1.5 }), T("order", 10), null, UTC) === "2026-03-12");
  ok("no terms setting, or one that isn't valid: 30 days from the invoice", D(N(o), null, null, UTC) === "2026-04-09" && D(N(o), { startsAt: "later", defaultDays: "x" }, null, UTC) === "2026-04-09");
  ok("the days count across month ends and a leap day", D(N({ placedAt: "2028-02-01T15:00:00Z" }), T("order", 30), null, UTC) === "2028-03-02");
  const late = N({ placedAt: "2026-03-01T05:00:00.000Z" });   // 9 pm on Feb 28 in Los Angeles
  ok("on the business's calendar: an order at 9 pm on Feb 28 in Los Angeles counts from Feb 28", D(late, T("order"), null, LA) === "2026-03-30");
  ok("…while the same moment in UTC is Mar 1", D(late, T("order"), null, UTC) === "2026-03-31");
  ok("a date-only stamp (noon UTC) is its own day in every zone", D(N({ placedAt: "2026-03-01T12:00:00.000Z" }), T("order"), null, "Pacific/Kiritimati") === "2026-03-31" &&
    D(N({ placedAt: "2026-03-01T12:00:00Z" }), T("order"), null, "Pacific/Pago_Pago") === "2026-03-31");
  ok("…and so is a bare date", D(N({ placedAt: "2026-03-01" }), T("order"), null, "Pacific/Kiritimati") === "2026-03-31");
  ok("a time that can't be read, or none: no due date", D(N({ placedAt: "not a date" }), T("order"), null, UTC) === "" && D(N({}), T("order"), null, UTC) === "");
  {
    const zd = await createD1();
    zd._raw.exec(read("schema.sql"));
    await S.setLocaleSettings(zd, { timeZone: LA });
    await S.resolveTimeZone({ DB: zd });
    ok("with no zone given, the business's zone as last resolved (Los Angeles here)", D(late, T("order")) === "2026-03-30");
    await S.setLocaleSettings(zd, { timeZone: "" });
    await S.resolveTimeZone({ DB: zd });
    ok("…and UTC when none is set", D(late, T("order")) === "2026-03-31");
  }

  // The shop, its people and the money switches.
  const d1 = await createD1();
  d1._raw.exec(read("schema.sql"));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('club','club','Example Club','t','t',1), ('district','district','Example School District','t','t',1);
    INSERT INTO customers (id, name, email, phone, company, createdAt, updatedAt, allowNet30, termsDays) VALUES
      (1, 'Pat Example', 'pat@example.com', '555-0100', 'Example School District', 't', 't', 1, 60),
      (2, 'Sam Example', 'sam@example.com', '555-0101', 'Example Club', 't', 't', 1, NULL);`);
  await S.setLocaleSettings(d1, { timeZone: LA });
  await S.resolveTimeZone({ DB: d1 });
  const q1 = (sql, ...p) => d1.q(sql, ...p)[0] || null;
  const row = (id) => q1("SELECT * FROM orders WHERE orderId = ?", id);
  const tee = [{ productId: "__custom__", name: "Club Tee", type: "other", size: "", qty: 4, unitPrice: 25, taxable: false }];   // $100
  let seq = 0;
  const place = (order, opts) => S.insertOrder(d1, { orderId: "N-" + (++seq), orgId: "club", customerName: "Example Club", contact: "", paymentMethod: "",
    subtotal: 100, shippingCost: 0, total: 100, shippingMethod: "", shippingAddress: null, totalWeightOz: 0, placedAt: "2026-03-02T15:00:00.000Z", ...order }, tee, opts || {})
    .then(() => "N-" + seq);
  const throws = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

  console.log("\n=== insertOrder on Net 30 ===");
  {
    let id = await place({});
    ok("an order not on Net 30 stays off it, with no PO or days", row(id).net30 === 0 && row(id).poNumber === "" && row(id).termsDays === null && row(id).poAcceptedAt === null);
    id = await place({ poNumber: "PO-1001", termsDays: 45 });
    ok("…and a PO or days sent without Net 30 are ignored", row(id).net30 === 0 && row(id).poNumber === "" && row(id).termsDays === null);
    id = await place({ net30: true });
    ok("Net 30 with no days and no customer: on Net 30, the usual days (none stored), no PO", row(id).net30 === 1 && row(id).termsDays === null && row(id).poNumber === "" && row(id).poAcceptedAt === null && row(id).poTypedAt === null);
    id = await place({ net30: true, termsDays: 45 });
    ok("days given are kept", row(id).termsDays === 45);
    id = await place({ net30: true, termsDays: "" });
    ok("blank days are the usual", row(id).termsDays === null);
    id = await place({ net30: true, contact: "pat@example.com" });
    ok("no days given: the customer's own days (Pat has 60)", row(id).customerId === 1 && row(id).termsDays === 60);
    id = await place({ net30: true, contact: "pat@example.com", termsDays: 15 });
    ok("…but days given win over the customer's", row(id).termsDays === 15);
    id = await place({ net30: true, contact: "sam@example.com" });
    ok("a customer without days of their own: the usual (none stored)", row(id).customerId === 2 && row(id).termsDays === null);
    id = await place({ net30: true }, { customerId: 1 });
    ok("a customer picked for the order counts too", row(id).customerId === 1 && row(id).termsDays === 60);
    for (const bad of [0, 366, 1.5, "abc"]) {
      const e = await throws(() => place({ net30: true, termsDays: bad }));
      if (!(e && e.userFacing && e.message === "The terms' days must be a whole number from 1 to 365.")) ok("days of " + JSON.stringify(bad) + " are refused", false);
    }
    ok("days that aren't 1 to 365 whole days are refused (a message for the person) and nothing is saved", !q1("SELECT 1 AS x FROM orders WHERE orderId = ?", "N-" + seq));
    id = await place({ net30: true, poNumber: "  PO-1001  ", poAcceptedBy: "lee@example.test" });
    ok("a PO typed by staff is trimmed and accepted at once, when the order was placed, by them", row(id).poNumber === "PO-1001" &&
      row(id).poAcceptedAt === "2026-03-02T15:00:00.000Z" && row(id).poAcceptedBy === "lee@example.test" && row(id).poTypedAt === null);
    id = await place({ net30: true, poNumber: "PO-1002" });
    ok("…with no name given, accepted by nobody in particular", row(id).poAcceptedAt === "2026-03-02T15:00:00.000Z" && row(id).poAcceptedBy === "");
    id = await place({ net30: true, poNumber: "PO-1003", poTypedByCustomer: true });
    ok("a PO the customer typed is only noted (when typed) and waits to be accepted", row(id).poNumber === "PO-1003" && row(id).poTypedAt === "2026-03-02T15:00:00.000Z" && row(id).poAcceptedAt === null);
    id = await place({ net30: true, poNumber: "   " });
    ok("a PO of only spaces is no PO", row(id).poNumber === "" && row(id).poAcceptedAt === null);
    id = await place({ net30: true, poNumber: "P".repeat(60) });
    ok("a PO of 60 characters is kept", row(id).poNumber.length === 60);
    const before = seq;
    const e = await throws(() => place({ net30: true, poNumber: "P".repeat(61) }));
    ok("one of 61 is refused: “A PO number can be at most 60 characters.”, and no order", !!e && e.userFacing === true && e.message === "A PO number can be at most 60 characters." && !row("N-" + (before + 1)));
    const t0 = Date.now();
    id = await place({ net30: true, poNumber: "PO-1004", placedAt: undefined });
    const at = Date.parse(row(id).poAcceptedAt);
    ok("an order with no time given is accepted now", at >= t0 - 1000 && at <= Date.now() + 1000);
  }

  console.log("\n=== setOrderTerms (db.js) ===");
  const NOW = "2026-03-05T18:00:00.000Z", LATER = "2026-03-06T18:00:00.000Z";
  const set = (id, v) => S.setOrderTerms(d1, id, { now: NOW, ...v });
  {
    let r = await S.setOrderTerms(d1, "NOPE-1", { net30: true });
    ok("an order that isn't there: “That order wasn't found.”", same(r, { error: "That order wasn't found." }));
    r = await S.setOrderTerms(d1, undefined, { net30: true });
    ok("…nor is one with no id", same(r, { error: "That order wasn't found." }));
    const v = await place({});
    d1._raw.exec(`UPDATE orders SET voidedAt = '2026-03-03T00:00:00Z' WHERE orderId = '${v}'`);
    r = await set(v, { net30: true });
    ok("a voided order: “This order is voided.” and it stays off Net 30", same(r, { error: "This order is voided." }) && row(v).net30 === 0);

    const a = await place({ contact: "pat@example.com" });
    r = await set(a, { net30: true });
    ok("on Net 30: the customer's own days are filled in (Pat: 60)", r.ok === true && row(a).net30 === 1 && row(a).termsDays === 60);
    ok("…the answer has the terms before and after, and it isn't cleared for work (no PO)", r.before.net30 === false && r.before.termsDays === null && r.after.net30 === true &&
      r.after.termsDays === 60 && r.cleared === false && r.wasCleared === false);
    d1._raw.exec(`UPDATE orders SET termsDays = NULL WHERE orderId = '${a}'`);
    r = await set(a, { net30: true });
    ok("an order already on Net 30 isn't given the customer's days again", r.ok && row(a).termsDays === null);
    const b = await place({ contact: "pat@example.com" });
    r = await set(b, { net30: true, termsDays: 20 });
    ok("days given win over the customer's", row(b).termsDays === 20 && r.after.termsDays === 20);
    const c = await place({ contact: "sam@example.com" });
    await set(c, { net30: true });
    ok("a customer with no days of their own: the usual (none stored)", row(c).net30 === 1 && row(c).termsDays === null);
    const nc = await place({});
    await set(nc, { net30: true });
    ok("an order with no customer: the usual", row(nc).net30 === 1 && row(nc).termsDays === null);

    r = await set(b, { termsDays: null });
    ok("days set to null are cleared (the usual)", r.ok && row(b).termsDays === null && row(b).net30 === 1);
    await set(b, { termsDays: 20 });
    r = await set(b, { termsDays: "" });
    ok("…and so are blank days", r.ok && row(b).termsDays === null);
    for (const bad of [0, 366, 2.5, "x"]) {
      r = await set(b, { termsDays: bad });
      if (!same(r, { error: "The terms' days must be a whole number from 1 to 365." })) ok("days of " + JSON.stringify(bad) + " are refused", false);
    }
    r = await set(b, { termsDays: "45" });
    ok("days that aren't 1–365 whole days are refused; days written as text are read as a number", r.ok && row(b).termsDays === 45);
    r = await set(b, { termsDays: 400, poNumber: "PO-2000" });
    ok("a refusal changes nothing (not even the PO sent with it)", !!r.error && row(b).poNumber === "" && row(b).termsDays === 45);

    r = await set(b, { poNumber: "  PO-2001  ", by: "lee@example.test" });
    ok("a PO typed by staff is trimmed and accepted at once, now, by them", row(b).poNumber === "PO-2001" && row(b).poAcceptedAt === NOW && row(b).poAcceptedBy === "lee@example.test" && row(b).poTypedAt === null);
    ok("…and the answer says it is now cleared for work and wasn't before", r.cleared === true && r.wasCleared === false && r.after.poAcceptedAt === NOW);
    r = await S.setOrderTerms(d1, b, { poNumber: "PO-2001", by: "kim@example.test", now: LATER });
    ok("the same PO sent again keeps its first acceptance", row(b).poAcceptedAt === NOW && row(b).poAcceptedBy === "lee@example.test" && r.cleared && r.wasCleared);
    r = await S.setOrderTerms(d1, b, { poNumber: "PO-2002", by: "kim@example.test", now: LATER });
    ok("a different PO from staff is accepted again, by them", row(b).poNumber === "PO-2002" && row(b).poAcceptedAt === LATER && row(b).poAcceptedBy === "kim@example.test");
    await set(b, { poNumber: "PO-2003", by: "x".repeat(300) });
    ok("who accepted it is kept to 200 characters", row(b).poAcceptedBy.length === 200);
    r = await set(b, { poNumber: "P".repeat(61) });
    ok("a PO over 60 characters: “A PO number can be at most 60 characters.”", same(r, { error: "A PO number can be at most 60 characters." }) && row(b).poNumber === "PO-2003");
    r = await set(b, { poNumber: "PO-2004", typedByCustomer: true });
    ok("the customer can't change a PO once it's accepted: “Your PO number has already been accepted.”", same(r, { error: "Your PO number has already been accepted." }) && row(b).poNumber === "PO-2003");
    r = await set(b, { poNumber: "" });
    ok("clearing the PO clears its acceptance", r.ok && row(b).poNumber === "" && row(b).poAcceptedAt === null && row(b).poAcceptedBy === "" && row(b).poTypedAt === null && r.cleared === false && r.wasCleared === true);
    await set(b, { poNumber: "PO-2005" });
    r = await set(b, { poNumber: null });
    ok("…as does a PO of null", r.ok && row(b).poNumber === "" && row(b).poAcceptedAt === null);
    await set(b, { poNumber: "PO-2005" });
    await set(b, { poNumber: "   " });
    ok("…and one of only spaces", row(b).poNumber === "" && row(b).poAcceptedAt === null);

    r = await set(b, { poNumber: " PO-3001 ", typedByCustomer: true });
    ok("a PO the customer typed is noted (when) and not accepted", r.ok && row(b).poNumber === "PO-3001" && row(b).poTypedAt === NOW && row(b).poAcceptedAt === null && r.cleared === false);
    r = await S.setOrderTerms(d1, b, { poNumber: "PO-3002", typedByCustomer: true, now: LATER });
    ok("…the customer may replace their own PO while it isn't accepted", r.ok && row(b).poNumber === "PO-3002" && row(b).poTypedAt === LATER);
    r = await set(b, { accept: true, typedByCustomer: true });
    ok("the customer can't accept their own PO", r.ok && row(b).poAcceptedAt === null);
    r = await set(b, { poNumber: "PO-3002", by: "lee@example.test" });
    ok("staff sending the customer's PO back accept it, and the note of it being typed goes", row(b).poAcceptedAt === NOW && row(b).poAcceptedBy === "lee@example.test" && row(b).poTypedAt === null);
    r = await set(b, { poNumber: "PO-3003", typedByCustomer: true });
    ok("…and once staff have accepted it, the customer can't replace it", !!r.error && row(b).poNumber === "PO-3002");
    await set(b, { poNumber: "" });
    await set(b, { poNumber: "PO-3003", typedByCustomer: true });
    r = await S.setOrderTerms(d1, b, { accept: true, by: "kim@example.test", now: LATER });
    ok("accept: the PO on the order is accepted, by them", r.ok && row(b).poAcceptedAt === LATER && row(b).poAcceptedBy === "kim@example.test" && r.cleared === true && r.wasCleared === false);
    r = await set(b, { accept: true, by: "lee@example.test" });
    ok("…accepting again keeps the first acceptance", r.ok && row(b).poAcceptedAt === LATER && row(b).poAcceptedBy === "kim@example.test");
    r = await set(c, { accept: true });
    ok("accept with no PO: “There's no PO number to accept yet.”", same(r, { error: "There's no PO number to accept yet." }));
    r = await set(b, { net30: false });
    ok("off Net 30: no longer cleared for work (what else it had is the caller's to clear)", r.ok && row(b).net30 === 0 && r.cleared === false && r.wasCleared === true && row(b).poNumber === "PO-3003");
    r = await set(b, {});
    ok("nothing asked: nothing changes and the answer's before and after are the same", r.ok && same(r.before, r.after));
  }

  console.log("\n=== acceptOrderPo (db.js) ===");
  {
    let r = await S.acceptOrderPo(d1, "NOPE-1", "lee@example.test");
    ok("an order that isn't there: “That order wasn't found.”", same(r, { error: "That order wasn't found." }));
    const v = await place({ net30: true, poNumber: "PO-4000", poTypedByCustomer: true });
    d1._raw.exec(`UPDATE orders SET voidedAt = '2026-03-03T00:00:00Z' WHERE orderId = '${v}'`);
    r = await S.acceptOrderPo(d1, v, "lee@example.test");
    ok("a voided order: “This order is voided.”", same(r, { error: "This order is voided." }) && row(v).poAcceptedAt === null);
    const off = await place({});
    ok("an order not on Net 30: “This order isn't on Net 30.”", same(await S.acceptOrderPo(d1, off), { error: "This order isn't on Net 30." }));
    const nopo = await place({ net30: true });
    ok("no PO: “There's no PO number to accept yet.”", same(await S.acceptOrderPo(d1, nopo), { error: "There's no PO number to accept yet." }));
    const t = await place({ net30: true, poNumber: "PO-4001", poTypedByCustomer: true });
    r = await S.acceptOrderPo(d1, t, "kim@example.test", NOW);
    ok("a typed PO is accepted, now, by them", r.ok === true && !r.already && row(t).poAcceptedAt === NOW && row(t).poAcceptedBy === "kim@example.test");
    ok("…the answer: cleared now, not before, with the terms before and after", r.cleared === true && r.wasCleared === false && r.before.poAcceptedAt === null && r.after.poAcceptedAt === NOW &&
      r.after.poAcceptedBy === "kim@example.test" && r.after.poNumber === "PO-4001");
    r = await S.acceptOrderPo(d1, t, "lee@example.test", LATER);
    ok("accepting it again changes nothing and says so (already)", r.ok === true && r.already === true && r.cleared && r.wasCleared && row(t).poAcceptedAt === NOW && row(t).poAcceptedBy === "kim@example.test");
    const long = await place({ net30: true, poNumber: "PO-4002", poTypedByCustomer: true });
    await S.acceptOrderPo(d1, long, "y".repeat(300), NOW);
    ok("who accepted it is kept to 200 characters", row(long).poAcceptedBy.length === 200);
    const dflt = await place({ net30: true, poNumber: "PO-4003", poTypedByCustomer: true });
    r = await S.acceptOrderPo(d1, dflt);
    ok("with no name or time given: accepted now, by nobody in particular", r.ok && !!row(dflt).poAcceptedAt && row(dflt).poAcceptedBy === "");
  }

  console.log("\n=== Before migrations/0121 ===");
  {
    const old = await pre0121();
    old._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('club','club','Example Club','t','t',1);
      INSERT INTO orders (orderId, orgId, customerName, contact, placedAt) VALUES ('OLD-1','club','Example Club','','2026-03-02T15:00:00Z');`);
    const NR = "Net 30 isn't ready yet: the database needs its latest update (migrations/0121).";
    ok("setOrderTerms says the database needs its update", same(await S.setOrderTerms(old, "OLD-1", { net30: true }), { error: NR }));
    ok("acceptOrderPo says so too", same(await S.acceptOrderPo(old, "OLD-1"), { error: NR }));
    let e = await throws(() => S.markInvoiced_(old, "OLD-1", NOW));
    ok("marking an invoice sent does nothing (no column to write) and doesn't fail", e === null);
    const inv = await throws(() => S.sendOrderInvoice(old, { orderId: "OLD-1", orgId: "club", sentTo: "pat@example.com", message: "" }));
    ok("…so sending an invoice still works", inv === null && old.q("SELECT sendCount FROM order_invoices WHERE orderId = 'OLD-1'")[0].sendCount === 1);
    const o2 = await S.getOrderById(old, "OLD-1");
    ok("an order reads as not on Net 30, with no PO status or due date", o2.net30 === false && o2.poStatus === "" && o2.termsDueDate === "" && o2.termsDays === null && o2.invoicedAt === "");
    const broken = await createD1();
    e = await throws(() => S.setOrderTerms(broken, "OLD-1", { net30: true }));
    ok("another database failure (no orders table at all) isn't hidden", !!e && /no such table/.test(e.message));
    e = await throws(() => S.acceptOrderPo(broken, "OLD-1"));
    ok("…in acceptOrderPo", !!e && /no such table/.test(e.message));
    e = await throws(() => S.markInvoiced_(broken, "OLD-1"));
    ok("…or in marking an invoice sent", !!e && /no such table/.test(e.message));
  }

  console.log("\n=== The first invoice starts the days (markInvoiced_, sendOrderInvoice) ===");
  {
    const id = await place({ net30: true, contact: "sam@example.com" });
    await S.markInvoiced_(d1, id, "2026-03-04T10:00:00.000Z");
    ok("marking an invoice sent sets when", row(id).invoicedAt === "2026-03-04T10:00:00.000Z");
    await S.markInvoiced_(d1, id, "2026-03-09T10:00:00.000Z");
    ok("…once: a later one doesn't move it", row(id).invoicedAt === "2026-03-04T10:00:00.000Z");
    const id2 = await place({ net30: true, contact: "sam@example.com" });
    const first = await S.sendOrderInvoice(d1, { orderId: id2, orgId: "club", sentTo: "sam@example.com", message: "" });
    ok("the first invoice sent is when the days start", !!first.sentAt && row(id2).invoicedAt === first.sentAt);
    await new Promise(r => setTimeout(r, 5));
    const again = await S.sendOrderInvoice(d1, { orderId: id2, orgId: "club", sentTo: "sam@example.com", message: "Reminder" });
    ok("a resend counts and is dated, but doesn't move the start", again.sendCount === 2 && again.sentAt !== first.sentAt && row(id2).invoicedAt === first.sentAt);
    const t0 = Date.now();
    const id3 = await place({});
    await S.markInvoiced_(d1, id3);
    ok("with no time given: now", Math.abs(Date.parse(row(id3).invoicedAt) - t0) < 5000);
  }

  console.log("\n=== The order readers ===");
  const ENV = { SIGNING_SECRET: "s".repeat(40), ...MAIL_ENV };
  const call = async (body) => {
    const waits = [];
    const res = await S.post({ env: { DB: d1, ...ENV }, waitUntil: (p) => waits.push(Promise.resolve(p).catch(() => {})),
      request: { url: ADMIN_ORIGIN + "/api/orders", json: async () => ({ key: "x", ...body }), headers: { get: () => null } } });
    await Promise.all(waits);
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const as = async (who, body) => { const was = globalThis.__who402; globalThis.__who402 = who; try { return await call(body); } finally { globalThis.__who402 = was; } };
  globalThis.__who402 = "admin";
  {
    const id = await place({ net30: true, poNumber: "PO-5001", poTypedByCustomer: true, termsDays: 20, placedAt: "2026-03-01T05:00:00.000Z" });
    let o = await S.getOrderById(d1, id);
    ok("getOrderById: on Net 30, its PO (typed, waiting) and its own days", o.net30 === true && o.poNumber === "PO-5001" && o.poTypedAt === "2026-03-01T05:00:00.000Z" &&
      o.poAcceptedAt === "" && o.poAcceptedBy === "" && o.termsDays === 20 && o.invoicedAt === "");
    ok("…its PO status: PO to check", o.poStatus === "PO to check");
    ok("…due 20 days from the order (no invoice yet), on the business's calendar (Feb 28 in Los Angeles)", o.termsDueDate === "2026-03-20");
    await S.markInvoiced_(d1, id, "2026-03-04T20:00:00.000Z");
    o = await S.getOrderById(d1, id);
    ok("…once invoiced, from the invoice", o.invoicedAt === "2026-03-04T20:00:00.000Z" && o.termsDueDate === "2026-03-24");
    await S.setTerms(d1, { startsAt: "completed" });
    o = await S.getOrderById(d1, id);
    ok("with the saved terms: “when completed” — no due date while it isn't", o.termsDueDate === "");
    d1._raw.exec(`UPDATE orders SET shippedAt = '2026-03-10T20:00:00.000Z' WHERE orderId = '${id}'`);
    o = await S.getOrderById(d1, id);
    ok("…and 20 days from when it shipped once it has", o.termsDueDate === "2026-03-30");
    await S.setTerms(d1, { startsAt: "order", defaultDays: 45 });
    const plain = await place({ net30: true, poNumber: "PO-5002", placedAt: "2026-03-02T15:00:00.000Z" });
    o = await S.getOrderById(d1, plain);
    ok("an order with no days of its own: the saved usual days (45 from the order date), and an accepted PO", o.termsDays === null && o.termsDueDate === "2026-04-16" && o.poStatus === "accepted" && o.poAcceptedAt === "2026-03-02T15:00:00.000Z");
    const notN = await place({});
    o = await S.getOrderById(d1, notN);
    ok("an order not on Net 30: no PO status and no due date", o.net30 === false && o.poStatus === "" && o.termsDueDate === "" && o.poNumber === "");
    const r = await call({ action: "getOrders", org: "club" });
    const L = (oid) => r.body.orders.find(x => x.orderId === oid) || {};
    ok("the Orders list gives the same: PO status and due date with the saved terms", r.status === 200 && L(id).poStatus === "PO to check" && L(id).termsDueDate === "2026-03-20" &&
      L(plain).termsDueDate === "2026-04-16" && L(plain).poStatus === "accepted" && L(notN).poStatus === "" && L(notN).termsDueDate === "");
    ok("…and its days, PO and when it was invoiced", L(id).termsDays === 20 && L(id).poNumber === "PO-5001" && L(id).invoicedAt === "2026-03-04T20:00:00.000Z" && L(id).net30 === true);
    await S.setTerms(d1, { startsAt: "invoice", defaultDays: 30 });
  }

  console.log("\n=== Who may (functions/_lib/permissions.js) ===");
  {
    const perm = (a) => roles.ACTION_PERM[a];
    const lvl = (role) => roles.effectivePermissions(roles.DEFAULT_ROLES[role])["orders.terms"];
    const fn = roles.PERMISSION_AREAS.flatMap(a => a.items).flatMap(i => i.fns || []).find(f => f[0] === "orders.terms");
    ok("its own function on the Roles screen: “Net 30 terms and PO numbers”", !!fn && fn[1] === "Net 30 terms and PO numbers");
    ok("built-in defaults: Admin and Manager full, Back office edit, Production none", ["admin", "manager", "staff", "production"].map(lvl).join() === "full,full,edit,none");
    ok("setting terms and accepting a PO need it at Edit", same(perm("setOrderTerms"), [["orders.terms", "edit"]]) && same(perm("acceptOrderPo"), [["orders.terms", "edit"]]));
    ok("reading the terms settings: Global settings, or Net 30, the Unpaid POs report or customer records",
      same(perm("getTermsSettings"), [["settings.global", "read"], ["orders.terms", "read"], ["reports.receivables", "read"], ["customers.records", "read"]]));
    ok("changing them is Global settings at Edit", same(perm("updateTermsSettings"), [["settings.global", "edit"]]));
    const noMonth = [...ordersJs.match(/const NO_MONTH_ACTIONS = new Set\(\[([\s\S]*?)\]\);/)[1].matchAll(/"(\w+)"/g)].map(m => m[1]);
    ok("no month's numbers change (no closed-month check): setOrderTerms, acceptOrderPo, updateTermsSettings", ["setOrderTerms", "acceptOrderPo", "updateTermsSettings"].every(a => noMonth.includes(a)));
    ok("Global settings has a Net 30 terms section saved by updateTermsSettings", /terms: \{ action: "updateTermsSettings", label: "Net 30 terms" \}/.test(ordersJs));
  }

  const setPayments = (p) => d1._raw.exec(`INSERT OR REPLACE INTO global_settings (key, value) VALUES ('enabledPayments', '${JSON.stringify(p)}')`);
  const setShopPayments = (org, p) => d1._raw.exec(`UPDATE orgs SET enabledPayments = ${p ? `'${JSON.stringify(p)}'` : "'{}'"} WHERE orgId = '${org}'`);
  const lastAudit = (action) => { const r = q1("SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC", action); return r ? { ...r, d: JSON.parse(r.detail || "{}") } : null; };
  const auditCount = (action) => q1("SELECT count(*) AS n FROM audit_log WHERE action = ?", action).n;
  const breakAudit = () => d1._raw.exec("CREATE TRIGGER no_audit_402 BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit log unavailable'); END;");
  const fixAudit = () => d1._raw.exec("DROP TRIGGER no_audit_402;");
  const OFF = "Net 30 isn't switched on for this shop (Global settings and Shop settings → Payment methods).";

  console.log("\n=== setOrderTerms (the action) ===");
  {
    const A = await place({ contact: "pat@example.com" });
    ok("Orders says Net 30 isn't allowed until it's ticked in Global settings", (await call({ action: "getOrders", org: "club" })).body.net30.allowed === false);
    let r = await call({ action: "setOrderTerms", orderId: A, net30: true });
    ok("Net 30 not ticked in Global settings: 409 “Net 30 isn't switched on for this shop…” and the order stays off it", r.status === 409 && r.body.message === OFF && row(A).net30 === 0);
    r = await call({ action: "saveGlobalSettingsAll", settings: { payments: { card: true, check: true, net30: true } } });
    ok("Global settings → Payment methods saves the Net 30 tick", r.status === 200 && JSON.parse(q1("SELECT value FROM global_settings WHERE key = 'enabledPayments'").value).net30 === true);
    ok("…and Orders says the shop may use it, with the usual days", (await call({ action: "getOrders", org: "club" })).body.net30.allowed === true && (await call({ action: "getOrders", org: "club" })).body.net30.defaultDays === 30);
    setShopPayments("club", { net30: false });
    r = await call({ action: "setOrderTerms", orderId: A, net30: true });
    ok("a shop that switched Net 30 off for itself: 409", r.status === 409 && r.body.message === OFF && row(A).net30 === 0);
    setShopPayments("club", null);

    for (const [who, want] of [[null, 401], ["production", 403]]) {
      r = await as(who, { action: "setOrderTerms", orderId: A, net30: true });
      ok((who || "nobody signed in") + ": " + want + " and nothing changes", r.status === want && row(A).net30 === 0);
    }
    r = await call({ action: "setOrderTerms", orderId: "bad id!", net30: true });
    ok("an order id that isn't one: 400 “Invalid order ID”", r.status === 400 && r.body.message === "Invalid order ID");
    r = await call({ action: "setOrderTerms", net30: true });
    ok("…or none", r.status === 400 && r.body.message === "Invalid order ID");
    r = await call({ action: "setOrderTerms", orderId: A, net30: "yes" });
    ok("Net 30 that isn't true or false: 400", r.status === 400 && r.body.message === "Say whether the order is on Net 30 (true or false).");
    for (const bad of [0, 366, 1.5, "abc", true]) {
      r = await call({ action: "setOrderTerms", orderId: A, net30: true, termsDays: bad });
      if (!(r.status === 400 && r.body.message === "Terms are a whole number of days from 1 to 365 (leave it blank for the usual).")) ok("days of " + JSON.stringify(bad) + " are refused", false);
    }
    ok("days that aren't 1 to 365 whole days: 400, and nothing changes", row(A).net30 === 0);
    r = await call({ action: "setOrderTerms", orderId: A, net30: true, poNumber: 1001 });
    ok("a PO number that isn't text: 400 “That PO number isn't valid.”", r.status === 400 && r.body.message === "That PO number isn't valid.");
    r = await call({ action: "setOrderTerms", orderId: A, net30: true, poNumber: "P".repeat(61) });
    ok("one over 60 characters: 400 “A PO number is at most 60 characters.”", r.status === 400 && r.body.message === "A PO number is at most 60 characters." && row(A).net30 === 0);
    r = await call({ action: "setOrderTerms", orderId: "CLUB-NOPE", net30: true });
    ok("an order that isn't there: 404", r.status === 404 && r.body.message === "Order not found");
    r = await call({ action: "setOrderTerms", orderId: A, net30: true, org: "district" });
    ok("an order of another shop than the one named: 404", r.status === 404 && row(A).net30 === 0);
    r = await call({ action: "setOrderTerms", orderId: A, net30: false, poNumber: "PO-6000" });
    ok("a PO without Net 30: 400 “Tick Net 30 to give the order a PO number or terms.”", r.status === 400 && r.body.message === "Tick Net 30 to give the order a PO number or terms.");
    r = await call({ action: "setOrderTerms", orderId: A, termsDays: 45 });
    ok("…nor days (an order not on Net 30, Net 30 left out)", r.status === 400 && r.body.message === "Tick Net 30 to give the order a PO number or terms." && row(A).termsDays === null);

    const n0 = auditCount("order.terms_set");
    r = await as("staff", { action: "setOrderTerms", orderId: A, net30: true });
    ok("Back office puts the order on Net 30: 200, with the customer's days and PO needed", r.status === 200 && r.body.net30 === true && r.body.poStatus === "PO needed" && r.body.poNumber === "" &&
      r.body.net30Cleared === false && r.body.paid === false && r.body.orderId === A && row(A).net30 === 1 && row(A).termsDays === 60);
    ok("…the answer carries the order, with its due date", !!r.body.order && r.body.order.orderId === A && r.body.order.poStatus === "PO needed" && r.body.order.termsDueDate === "2026-05-01");
    let a = lastAudit("order.terms_set");
    ok("…audited: order.terms_set from and to, with what changed", auditCount("order.terms_set") === n0 + 1 && a.orderId === A && a.orgId === "club" && a.d.from.net30 === false && a.d.to.net30 === true &&
      same(Object.keys(a.d.changes), ["net30"]) && a.d.changes.net30.from === false && a.d.changes.net30.to === true);
    r = await call({ action: "setOrderTerms", orderId: A, net30: true, termsDays: 60, poNumber: "" });
    ok("sending the terms back unchanged: 200 and no audit row", r.status === 200 && auditCount("order.terms_set") === n0 + 1 && row(A).termsDays === 60);
    r = await call({ action: "setOrderTerms", orderId: A, poNumber: " PO-6001\u0007 " });
    ok("a PO typed by staff (control characters taken out, trimmed) counts at once: cleared for work, still owed", r.status === 200 && row(A).poNumber === "PO-6001" &&
      row(A).poAcceptedBy === "admin@example.test" && !!row(A).poAcceptedAt && r.body.poStatus === "accepted" && r.body.net30Cleared === true && r.body.paid === false);
    a = lastAudit("order.terms_set");
    ok("…audited with the PO's change only", same(Object.keys(a.d.changes), ["poNumber"]) && a.d.changes.poNumber.from === "" && a.d.changes.poNumber.to === "PO-6001");
    r = await call({ action: "setOrderTerms", orderId: A, termsDays: 90 });
    ok("days changed: kept, and the PO stays accepted", r.status === 200 && row(A).termsDays === 90 && row(A).poNumber === "PO-6001" && r.body.net30Cleared === true);
    r = await call({ action: "setOrderTerms", orderId: A, termsDays: null });
    ok("days cleared: the usual (none stored)", r.status === 200 && row(A).termsDays === null);
    r = await call({ action: "setOrderTerms", orderId: A, net30: false });
    ok("taken off Net 30: its PO and days go with it", r.status === 200 && row(A).net30 === 0 && row(A).poNumber === "" && row(A).poAcceptedAt === null && row(A).termsDays === null &&
      r.body.net30 === false && r.body.poStatus === "" && r.body.net30Cleared === false);
    a = lastAudit("order.terms_set");
    ok("…audited with Net 30 and the PO changed", a.d.changes.net30.to === false && a.d.changes.poNumber.from === "PO-6001" && a.d.changes.poNumber.to === "" && a.d.to.termsDays === null);

    // A PO the customer typed: sending the whole Terms form back doesn't accept it; Accept PO does.
    const B = await place({ net30: true, poNumber: "PO-6100", poTypedByCustomer: true });
    const nB = auditCount("order.terms_set");
    r = await call({ action: "setOrderTerms", orderId: B, net30: true, termsDays: null, poNumber: "PO-6100" });
    ok("a customer's PO sent back unchanged in the form isn't accepted by it", r.status === 200 && row(B).poAcceptedAt === null && r.body.poStatus === "PO to check" && auditCount("order.terms_set") === nB);
    setPayments({ card: true });
    r = await call({ action: "setOrderTerms", orderId: B, termsDays: 15 });
    ok("an order already on Net 30 can be changed with Net 30 switched off since", r.status === 200 && row(B).termsDays === 15);
    r = await call({ action: "setOrderTerms", orderId: B, net30: false });
    ok("…and taken off it", r.status === 200 && row(B).net30 === 0 && row(B).poNumber === "");
    setPayments({ card: true, net30: true });

    const Pd = await place({});
    d1._raw.exec(`UPDATE orders SET paid = 1, paidAt = '2026-03-03T00:00:00Z' WHERE orderId = '${Pd}'`);
    r = await call({ action: "setOrderTerms", orderId: Pd, net30: true });
    ok("an order paid in full can't be put on Net 30: 409 “This order is already paid in full.”", r.status === 409 && r.body.message === "This order is already paid in full." && row(Pd).net30 === 0);
    const V = await place({});
    d1._raw.exec(`UPDATE orders SET voidedAt = '2026-03-03T00:00:00Z' WHERE orderId = '${V}'`);
    r = await call({ action: "setOrderTerms", orderId: V, net30: true });
    ok("a voided order: 409 “This order is voided.”", r.status === 409 && r.body.message === "This order is voided." && row(V).net30 === 0);

    const C = await place({});
    breakAudit();
    r = await call({ action: "setOrderTerms", orderId: C, net30: true, poNumber: "PO-6200" });
    fixAudit();
    ok("the audit log can't be written: refused, and the order isn't put on Net 30", r.status >= 500 && row(C).net30 === 0 && row(C).poNumber === "");
  }

  console.log("\n=== acceptOrderPo (the action) ===");
  {
    const A = await place({ net30: true, poNumber: "PO-7001", poTypedByCustomer: true, placedAt: "2026-03-02T16:00:00.000Z" });
    for (const [who, want] of [[null, 401], ["production", 403]]) {
      const r = await as(who, { action: "acceptOrderPo", orderId: A });
      ok((who || "nobody signed in") + ": " + want + " and the PO still waits", r.status === want && row(A).poAcceptedAt === null);
    }
    let r = await call({ action: "acceptOrderPo", orderId: "" });
    ok("no order id: 400", r.status === 400 && r.body.message === "Invalid order ID");
    r = await call({ action: "acceptOrderPo", orderId: "CLUB-NOPE" });
    ok("an order that isn't there: 404", r.status === 404);
    r = await call({ action: "acceptOrderPo", orderId: A, org: "district" });
    ok("another shop's order: 404", r.status === 404 && row(A).poAcceptedAt === null);
    const V = await place({ net30: true, poNumber: "PO-7002", poTypedByCustomer: true });
    d1._raw.exec(`UPDATE orders SET voidedAt = '2026-03-03T00:00:00Z' WHERE orderId = '${V}'`);
    r = await call({ action: "acceptOrderPo", orderId: V });
    ok("a voided order: 409 “This order is voided.”", r.status === 409 && r.body.message === "This order is voided.");
    r = await call({ action: "acceptOrderPo", orderId: await place({}) });
    ok("an order not on Net 30: 409 “This order isn't on Net 30.”", r.status === 409 && r.body.message === "This order isn't on Net 30.");
    r = await call({ action: "acceptOrderPo", orderId: await place({ net30: true }) });
    ok("no PO yet: 409 “There's no PO number to accept yet.”", r.status === 409 && r.body.message === "There's no PO number to accept yet.");
    breakAudit();
    r = await call({ action: "acceptOrderPo", orderId: A });
    fixAudit();
    ok("the audit log can't be written: refused, and the PO still waits", r.status >= 500 && row(A).poAcceptedAt === null);
    const n0 = auditCount("order.po_accepted");
    r = await as("staff", { action: "acceptOrderPo", orderId: A });
    ok("Back office accepts it: 200, cleared for work and still owed", r.status === 200 && r.body.poStatus === "accepted" && r.body.net30Cleared === true && r.body.paid === false &&
      row(A).poAcceptedBy === "staff@example.test" && !!row(A).poAcceptedAt && r.body.order.poStatus === "accepted");
    const a = lastAudit("order.po_accepted");
    ok("…audited: order.po_accepted with the PO and when the customer typed it", auditCount("order.po_accepted") === n0 + 1 && a.orderId === A && a.d.poNumber === "PO-7001" && a.d.typedAt === "2026-03-02T16:00:00.000Z");
    const at = row(A).poAcceptedAt;
    r = await call({ action: "acceptOrderPo", orderId: A });
    ok("accepting it again: 200, nothing changes and no second audit row", r.status === 200 && row(A).poAcceptedAt === at && row(A).poAcceptedBy === "staff@example.test" && auditCount("order.po_accepted") === n0 + 1);
    const B = await place({ net30: true, poNumber: "PO-7003", poTypedByCustomer: true });
    d1._raw.exec(`UPDATE orders SET poTypedAt = NULL WHERE orderId = '${B}'`);
    await call({ action: "acceptOrderPo", orderId: B });
    ok("a PO with no note of when it was typed is audited with none", lastAudit("order.po_accepted").d.typedAt === null && !!row(B).poAcceptedAt);
  }

  console.log("\n=== A digital order's files go out once its PO is accepted ===");
  {
    await call({ action: "createProduct", org: "club", productId: "pattern", type: "other", name: "Club Pattern", pricingMode: "flat", flatPrice: 20, visible: true, weightOz: 0, noDesignNeeded: true });
    d1._raw.exec(`UPDATE products SET digital = 1, noBlankNeeded = 1, noDesignNeeded = 1 WHERE productId = 'pattern';
      INSERT INTO product_files (orgId, productId, fileKey, fileName, fileExt, bytes, sortOrder, createdAt) VALUES ('club', 'pattern', 'files/pattern.pdf', 'pattern.pdf', 'pdf', 1000, 0, 't');`);
    const grants = (oid) => q1("SELECT count(*) AS n FROM download_grants WHERE orderId = ?", oid).n;
    const digital = async (n, extra) => {
      const r = await call({ action: "createLocalSale", org: "club", requestId: "req402dig" + n, items: [{ productId: "pattern", size: "", qty: 1 }], paymentMethod: "", contact: "sam@example.com", placedAt: "2026-03-02", ...extra });
      if (r.status !== 200) throw new Error("digital sale: " + JSON.stringify(r.body));
      return r.body.orderId;
    };
    const D1 = await digital(1);
    let r = await call({ action: "setOrderTerms", orderId: D1, net30: true });
    ok("on Net 30 with no PO: no files yet", r.status === 200 && grants(D1) === 0);
    mail.length = 0;
    r = await call({ action: "setOrderTerms", orderId: D1, poNumber: "PO-8001" });
    ok("staff give it a PO: cleared for work, so its file is granted and emailed while it is still owed", r.status === 200 && r.body.net30Cleared === true && grants(D1) === 1 && !row(D1).paid &&
      mail.some(m => m.to === "sam@example.com" || (Array.isArray(m.to) && m.to.includes("sam@example.com"))));
    const D2 = await digital(2);
    await call({ action: "setOrderTerms", orderId: D2, net30: true });
    d1._raw.exec(`UPDATE orders SET poNumber = 'PO-8002', poTypedAt = '2026-03-03T00:00:00Z' WHERE orderId = '${D2}'`);
    ok("a PO the customer typed: still no files", grants(D2) === 0);
    r = await call({ action: "acceptOrderPo", orderId: D2 });
    ok("…until staff accept it", r.status === 200 && grants(D2) === 1);
    const D3 = await digital(3, { net30: true, poNumber: "PO-8003" });
    ok("(a Local sale on Net 30 with a PO is cleared for work at once)", S.net30Cleared(row(D3)) && S.workCleared(row(D3)) && !row(D3).paid);
  }

  console.log("\n=== Global settings → Net 30 terms ===");
  {
    let r = await call({ action: "getTermsSettings" });
    ok("getTermsSettings: 30 days from the invoice until changed", r.status === 200 && same(r.body.terms, { defaultDays: 30, startsAt: "invoice" }));
    const who = {};
    for (const k of [null, "production", "staff", "manager", "admin"]) who[k] = (await as(k, { action: "getTermsSettings" })).status;
    ok("…read by every built-in role (Production through its customer records), not by nobody (401)", who.staff === 200 && who.manager === 200 && who.admin === 200 && who.production === 200 && who.null === 401);
    ok("…and a role with none of Global settings, Net 30, the report or customer records can't (403)", (await as("quoter", { action: "getTermsSettings" })).status === 200 && (await as("clerk", { action: "getTermsSettings" })).status === 403);
    r = await as("manager", { action: "updateTermsSettings", terms: { defaultDays: 45, startsAt: "order" } });
    ok("a Manager (Global settings at Read) can't change them (403)", r.status === 403 && (await as("staff", { action: "updateTermsSettings", terms: { defaultDays: 45, startsAt: "order" } })).status === 403 && r.status === 403 && same((await call({ action: "getTermsSettings" })).body.terms, { defaultDays: 30, startsAt: "invoice" }));
    for (const bad of [0, 366, 2.5, "abc", null, true]) {
      r = await call({ action: "updateTermsSettings", terms: { defaultDays: bad, startsAt: "order" } });
      if (!(r.status === 400 && r.body.message === "The usual terms are a whole number of days from 1 to 365.")) ok("usual days of " + JSON.stringify(bad) + " are refused", false);
    }
    ok("usual days that aren't 1 to 365 whole days: 400", same((await call({ action: "getTermsSettings" })).body.terms, { defaultDays: 30, startsAt: "invoice" }));
    r = await call({ action: "updateTermsSettings", terms: { defaultDays: 45, startsAt: "shipped" } });
    ok("a start that isn't the invoice, the order or completion: 400", r.status === 400 && r.body.message === "Choose when the days start: the invoice, the order date or the order completed.");
    r = await call({ action: "updateTermsSettings", terms: { defaultDays: 45 } });
    ok("…nor one left out", r.status === 400);
    const n0 = auditCount("settings.terms_set");
    r = await as("admin", { action: "updateTermsSettings", terms: { defaultDays: " 45 ", startsAt: "order" } });
    ok("the Admin saves them (days typed as text are read as a number)", r.status === 200 && same(r.body.terms, { defaultDays: 45, startsAt: "order" }) &&
      same(JSON.parse(q1("SELECT value FROM global_settings WHERE key = 'terms'").value), { defaultDays: 45, startsAt: "order" }));
    const a = lastAudit("settings.terms_set");
    ok("…audited: settings.terms_set from and to", auditCount("settings.terms_set") === n0 + 1 && same(a.d.from, { defaultDays: 30, startsAt: "invoice" }) && same(a.d.to, { defaultDays: 45, startsAt: "order" }));
    r = await call({ action: "updateTermsSettings", defaultDays: 60, startsAt: "completed" });
    ok("the same fields sent flat are taken too", r.status === 200 && same(r.body.terms, { defaultDays: 60, startsAt: "completed" }));
    const o = await place({ net30: true, placedAt: "2026-03-02T15:00:00.000Z" });
    ok("an order's due date follows the saved terms when read (completed: none yet)", (await S.getOrderById(d1, o)).termsDueDate === "");
    r = await call({ action: "saveGlobalSettingsAll", settings: { terms: { defaultDays: 10, startsAt: "order" } } });
    ok("Save all saves the Net 30 terms section", r.status === 200 && same((await S.getTerms(d1)), { defaultDays: 10, startsAt: "order" }) && (await S.getOrderById(d1, o)).termsDueDate === "2026-03-12");
    ok("…audited as settings.terms_set", same(lastAudit("settings.terms_set").d.from, { defaultDays: 60, startsAt: "completed" }) && same(lastAudit("settings.terms_set").d.to, { defaultDays: 10, startsAt: "order" }));
    const n1 = auditCount("settings.terms_set");
    r = await call({ action: "saveGlobalSettingsAll", settings: { terms: { defaultDays: 0, startsAt: "order" }, payments: { card: true, net30: false } } });
    ok("…a bad section refuses the whole save, naming it, and nothing is written", r.status === 400 && r.body.section === "Net 30 terms" && r.body.message === "The usual terms are a whole number of days from 1 to 365." &&
      JSON.parse(q1("SELECT value FROM global_settings WHERE key = 'enabledPayments'").value).net30 === true && auditCount("settings.terms_set") === n1);
    r = await call({ action: "saveGlobalSettingsAll", settings: { terms: { defaultDays: 10, startsAt: "whenever" } } });
    ok("…and so does a bad start", r.status === 400 && r.body.section === "Net 30 terms");
    r = await as("manager", { action: "saveGlobalSettingsAll", settings: { terms: { defaultDays: 20, startsAt: "order" } } });
    ok("…a Manager can't save it (403)", r.status === 403 && (await S.getTerms(d1)).defaultDays === 10);
    await call({ action: "updateTermsSettings", terms: { defaultDays: 30, startsAt: "invoice" } });
  }

  console.log("\n=== Local sale on Net 30 ===");
  {
    let k = 0;
    const sale = (extra, who = "admin") => as(who, { action: "createLocalSale", org: "club", requestId: "req402sale" + (++k), items: [{ productId: "__custom__", name: "Club Tee", type: "other", size: "", customUnitPrice: 25, qty: 4, taxable: false }],
      paymentMethod: "", placedAt: "2026-03-02", ...extra });
    const count = () => q1("SELECT count(*) AS n FROM orders").n;
    const n = count();
    let r = await sale({ net30: true, poNumber: "PO-9000" }, "clerk");
    ok("a role that may make a sale but not set Net 30: 403 “Your role can't set Net 30 terms.”", r.status === 403 && /can't set Net 30 terms/.test(r.body.message) && count() === n);
    r = await sale({ poNumber: "PO-9000" }, "clerk");
    ok("…a PO without Net 30 from that role is still refused as a mistake (400), not a permission", r.status === 400);
    r = await sale({ net30: true, paid: true });
    ok("Net 30 and Paid: 400 “Choose one of Paid, Pay on delivery or Net 30.”", r.status === 400 && r.body.message === "Choose one of Paid, Pay on delivery or Net 30.");
    d1._raw.exec(`INSERT OR REPLACE INTO global_settings (key, value) VALUES ('enabledPayments', '{"card":true,"net30":true,"onDelivery":true}')`);
    r = await sale({ net30: true, payOnDelivery: true });
    ok("Net 30 and Pay on delivery: 400 too", r.status === 400 && r.body.message === "Choose one of Paid, Pay on delivery or Net 30.");
    r = await sale({ net30: true, termsDays: 0 });
    ok("days that aren't 1–365: 400", r.status === 400 && r.body.message === "Terms are a whole number of days from 1 to 365 (leave it blank for the usual).");
    r = await sale({ net30: true, poNumber: 12 });
    ok("a PO that isn't text: 400", r.status === 400 && r.body.message === "That PO number isn't valid.");
    r = await sale({ net30: true, poNumber: "P".repeat(61) });
    ok("a PO over 60 characters: 400", r.status === 400 && r.body.message === "A PO number is at most 60 characters.");
    r = await sale({ poNumber: "PO-9000" });
    ok("a PO without Net 30: 400 “Tick Net 30 to give the sale a PO number or terms.”", r.status === 400 && r.body.message === "Tick Net 30 to give the sale a PO number or terms.");
    r = await sale({ termsDays: 45 });
    ok("…nor days", r.status === 400 && r.body.message === "Tick Net 30 to give the sale a PO number or terms.");
    r = await sale({ net30: "yes", poNumber: "PO-9000" });
    ok("Net 30 has to be true itself (not just something)", r.status === 400 && r.body.message === "Tick Net 30 to give the sale a PO number or terms.");
    setPayments({ card: true });
    r = await sale({ net30: true });
    ok("Net 30 not ticked in Global settings: 409, and no sale", r.status === 409 && r.body.message === OFF && count() === n);
    setPayments({ card: true, net30: true });
    setShopPayments("district", { net30: false });
    r = await as("admin", { action: "createLocalSale", org: "district", requestId: "req402d1", items: [{ productId: "__custom__", name: "Banner", type: "other", size: "", customUnitPrice: 40, qty: 1 }], net30: true });
    ok("a shop that switched it off: 409", r.status === 409 && r.body.message === OFF);
    ok("nothing was made by any refusal", count() === n);

    r = await sale({ net30: true, poNumber: " PO-9001 ", termsDays: 45 }, "staff");
    let o = row(r.body.orderId);
    ok("Back office records a sale on Net 30 with a PO and days: the PO counts at once (cleared for work, still owed)", r.status === 200 && !r.body.warning && o.net30 === 1 && o.poNumber === "PO-9001" &&
      o.poAcceptedBy === "staff@example.test" && !!o.poAcceptedAt && o.termsDays === 45 && !o.paid && S.net30Cleared(o));
    let a = lastAudit("order.created_local_sale");
    ok("…audited with Net 30, its PO and days", a.orderId === r.body.orderId && a.d.net30 === true && a.d.poNumber === "PO-9001" && a.d.termsDays === 45 && !a.d.termsNotSaved);
    r = await sale({ net30: true, customerId: 1 });
    o = row(r.body.orderId);
    ok("a sale on Net 30 for a customer with their own days, none typed: theirs (60), PO needed", r.status === 200 && o.net30 === 1 && o.termsDays === 60 && o.poNumber === "" && !S.net30Cleared(o));
    a = lastAudit("order.created_local_sale");
    ok("…audited with Net 30 alone", a.d.net30 === true && !("poNumber" in a.d) && !("termsDays" in a.d));
    r = await sale({});
    a = lastAudit("order.created_local_sale");
    ok("a sale not on Net 30 says nothing about it", r.status === 200 && row(r.body.orderId).net30 === 0 && !("net30" in a.d));
    d1._raw.exec("CREATE TRIGGER no_net30_402 BEFORE UPDATE OF net30 ON orders WHEN NEW.net30 = 1 BEGIN SELECT RAISE(ABORT, 'terms unavailable'); END;");
    const logs = logged.length;
    r = await sale({ net30: true, poNumber: "PO-9002" });
    d1._raw.exec("DROP TRIGGER no_net30_402;");
    o = row(r.body.orderId);
    ok("the terms can't be saved: the sale stands, with a warning to set them on the order", r.status === 200 && !!o && o.net30 === 0 &&
      r.body.warning === "The sale was saved, but its Net 30 terms weren't. Set them on the order (Terms).");
    ok("…logged, and audited as not saved", logged.slice(logs).some(l => /Net 30 terms weren't saved on local sale/.test(l)) && lastAudit("order.created_local_sale").d.termsNotSaved === true);
  }

  console.log("\n=== A quote converted on Net 30 ===");
  {
    const LINES = [{ kind: "custom", name: "Club banner", qty: 1, unitPrice: 40, taxable: true }, { kind: "product", productId: "pattern", name: "Club Pattern", qty: 2, unitPrice: 20 }];
    const newQuote = async () => {
      const c = await call({ action: "createEstimate", org: "club", customerId: 1, title: "Example quote", expiresOn: "2099-12-31" });
      const s = await call({ action: "saveEstimate", id: c.body.id, items: LINES });
      if (s.status !== 200) throw new Error("seed quote: " + JSON.stringify(s.body));
      return c.body.id;
    };
    const orderOf = (id) => (q1("SELECT orderId FROM estimates WHERE id = ?", id) || {}).orderId || null;
    const q = await newQuote();
    let r = await as("quoter", { action: "convertEstimate", id: q, net30: true });
    ok("a role that may convert quotes but not set Net 30: 403 “Your role can't set Net 30 terms.”, and no order", r.status === 403 && /can't set Net 30 terms/.test(r.body.message) && !orderOf(q));
    r = await call({ action: "convertEstimate", id: q, net30: true, termsDays: 400 });
    ok("days that aren't 1–365: 400", r.status === 400 && r.body.message === "Terms are a whole number of days from 1 to 365 (leave it blank for the usual).");
    r = await call({ action: "convertEstimate", id: q, net30: true, poNumber: ["PO-1"] });
    ok("a PO that isn't text: 400", r.status === 400 && r.body.message === "That PO number isn't valid.");
    r = await call({ action: "convertEstimate", id: q, poNumber: "PO-9100" });
    ok("a PO without Net 30: 400 “Tick Net 30 to give the order a PO number or terms.”", r.status === 400 && r.body.message === "Tick Net 30 to give the order a PO number or terms.");
    r = await call({ action: "convertEstimate", id: q, termsDays: 20 });
    ok("…nor days", r.status === 400 && r.body.message === "Tick Net 30 to give the order a PO number or terms." && !orderOf(q));
    setPayments({ card: true });
    r = await call({ action: "convertEstimate", id: q, net30: true, poNumber: "PO-9100" });
    ok("Net 30 not ticked in Global settings: 409, and the quote isn't converted", r.status === 409 && r.body.message === OFF && !orderOf(q));
    setPayments({ card: true, net30: true });
    r = await as("staff", { action: "convertEstimate", id: q, net30: true, poNumber: " PO-9100 ", termsDays: "20" });
    const o = row(r.body.orderId);
    ok("Back office converts it on Net 30: the order carries the PO (accepted at once, by them) and the days", r.status === 200 && !r.body.warning && orderOf(q) === r.body.orderId &&
      o.net30 === 1 && o.poNumber === "PO-9100" && o.poAcceptedBy === "staff@example.test" && !!o.poAcceptedAt && o.termsDays === 20 && !o.paid);
    const a = lastAudit("estimate.converted");
    ok("…audited on estimate.converted with Net 30, the PO and days", a.orderId === r.body.orderId && a.d.net30 === true && a.d.poNumber === "PO-9100" && a.d.termsDays === 20 && !a.d.termsNotSaved);
    r = await call({ action: "convertEstimate", id: q, net30: true, poNumber: "PO-OTHER" });
    ok("converting it again answers the same order and changes nothing", r.status === 200 && r.body.repeated === true && row(o.orderId).poNumber === "PO-9100");
    const q2 = await newQuote();
    r = await call({ action: "convertEstimate", id: q2, net30: true });
    const o2 = row(r.body.orderId);
    ok("on Net 30 with no PO or days: the customer's own days (60), PO needed", r.status === 200 && o2.net30 === 1 && o2.termsDays === 60 && o2.poNumber === "" && o2.poAcceptedAt === null);
    const a2 = lastAudit("estimate.converted");
    ok("…audited with Net 30 alone", a2.d.net30 === true && !("poNumber" in a2.d) && !("termsDays" in a2.d));
    const q3 = await newQuote();
    r = await call({ action: "convertEstimate", id: q3 });
    ok("converted without Net 30: an order not on it, and the audit says nothing of it", r.status === 200 && row(r.body.orderId).net30 === 0 && !("net30" in lastAudit("estimate.converted").d));
    const q4 = await newQuote();
    d1._raw.exec("CREATE TRIGGER no_net30_402 BEFORE UPDATE OF net30 ON orders WHEN NEW.net30 = 1 BEGIN SELECT RAISE(ABORT, 'terms unavailable'); END;");
    const logs = logged.length;
    r = await call({ action: "convertEstimate", id: q4, net30: true, poNumber: "PO-9101" });
    d1._raw.exec("DROP TRIGGER no_net30_402;");
    ok("the terms can't be saved: the order is still made, with a warning to set them on it", r.status === 200 && orderOf(q4) === r.body.orderId && row(r.body.orderId).net30 === 0 &&
      r.body.warning === "The order was made, but its Net 30 terms weren't. Set them on the order (Terms).");
    ok("…logged, and audited as not saved", logged.slice(logs).some(l => /Net 30 terms weren't saved on the order made from quote/.test(l)) && lastAudit("estimate.converted").d.termsNotSaved === true);
  }

  console.log("\n=== The garment waiver, saved with the Features switches ===");
  {
    const W = () => S.getFeatures(d1).then(f => f.ownGarmentsWaiver);
    ok("until it's changed: the usual sentence", (await W()) === S.OWN_GARMENTS_WAIVER_DEFAULT);
    let r = await call({ action: "updateFeatures", features: { ownGarmentsWaiver: 12 } });
    ok("a waiver that isn't text: 400 “The garment waiver is text of at most 1,000 characters.”", r.status === 400 && r.body.message === "The garment waiver is text of at most 1,000 characters.");
    r = await call({ action: "updateFeatures", features: { ownGarmentsWaiver: "x".repeat(1001) } });
    ok("…nor one over 1,000 characters", r.status === 400 && r.body.message === "The garment waiver is text of at most 1,000 characters." && (await W()) === S.OWN_GARMENTS_WAIVER_DEFAULT);
    const n0 = auditCount("settings.features_set");
    r = await call({ action: "updateFeatures", features: { ownGarmentsWaiver: "  Garments are decorated at the owner's risk.\r\nThank you.\r  " } });
    ok("a waiver is saved trimmed, with its line breaks made plain", r.status === 200 && (await W()) === "Garments are decorated at the owner's risk.\nThank you." && r.body.features.ownGarmentsWaiver === "Garments are decorated at the owner's risk.\nThank you.");
    let a = lastAudit("settings.features_set");
    ok("…and the change is audited in settings.features_set", auditCount("settings.features_set") === n0 + 1 && a.d.changes.ownGarmentsWaiver.from === S.OWN_GARMENTS_WAIVER_DEFAULT &&
      a.d.changes.ownGarmentsWaiver.to === "Garments are decorated at the owner's risk.\nThank you.");
    r = await call({ action: "updateFeatures", features: { ownGarmentsWaiver: "Garments are decorated at the owner's risk.\nThank you.", ownGarments: true } });
    a = lastAudit("settings.features_set");
    ok("the same waiver with a switch: only the switch is in the changes", r.status === 200 && same(Object.keys(a.d.changes), ["ownGarments"]) && (await S.getFeatures(d1)).ownGarments === true);
    r = await call({ action: "updateFeatures", features: { ownGarments: false } });
    ok("a save that leaves the waiver out keeps it", r.status === 200 && (await W()) === "Garments are decorated at the owner's risk.\nThank you.");
    r = await call({ action: "updateFeatures", features: { ownGarmentsWaiver: "" } });
    ok("an empty waiver is kept empty (no waiver line on the slip)", r.status === 200 && (await W()) === "");
    r = await call({ action: "saveGlobalSettingsAll", settings: { features: { ownGarmentsWaiver: "Example waiver." } } });
    ok("Save all saves it in the Features section", r.status === 200 && (await W()) === "Example waiver." && lastAudit("settings.features_set").d.changes.ownGarmentsWaiver.to === "Example waiver.");
    r = await call({ action: "saveGlobalSettingsAll", settings: { features: { ownGarmentsWaiver: false } } });
    ok("…and refuses a bad one, naming the section", r.status === 400 && r.body.section === "Features" && (await W()) === "Example waiver.");
    const sent = { ownGarmentsWaiver: "Kept as sent." };
    await call({ action: "updateFeatures", features: sent });
    ok("(what was sent isn't changed by the save)", same(sent, { ownGarmentsWaiver: "Kept as sent." }));
  }

  console.log("\n=== The actions before migrations/0121 ===");
  {
    const old = await pre0121();
    old._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('club','club','Example Club','t','t',1);
      INSERT INTO orders (orderId, orgId, customerName, contact, placedAt, totalCents) VALUES ('CLUB-OLD1','club','Example Club','','2026-03-02T15:00:00Z', 10000);
      INSERT OR REPLACE INTO global_settings (key, value) VALUES ('enabledPayments', '{"card":true,"net30":true}');`);
    const callOld = async (body) => {
      const res = await S.post({ env: { DB: old, ...ENV }, waitUntil: () => {}, request: { url: ADMIN_ORIGIN + "/api/orders", json: async () => ({ key: "x", ...body }), headers: { get: () => null } } });
      return { status: res.status, body: JSON.parse(await res.text()) };
    };
    let r = await callOld({ action: "setOrderTerms", orderId: "CLUB-OLD1", net30: true });
    ok("setOrderTerms says the database needs its update, and changes nothing", r.status === 409 && /migrations\/0121/.test(r.body.message));
    r = await callOld({ action: "acceptOrderPo", orderId: "CLUB-OLD1" });
    ok("acceptOrderPo: the order isn't on Net 30 (there is no Net 30 yet)", r.status === 409 && r.body.message === "This order isn't on Net 30.");
  }
})().catch((e) => { origErr(e); process.exitCode = 1; });
