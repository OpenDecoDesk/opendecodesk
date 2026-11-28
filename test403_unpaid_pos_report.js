process.env.TZ = "UTC";
const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { ok } = require("./testlib/check");
const roles = require("./testlib/roles");

// The Unpaid POs report (migrations/0121) and what Home makes of it. Real db.js / orders.js / permissions.js on sql.js.
//   db.js getUnpaidPoReport: every Net 30 order (not void, not a test, placed by the as-of day) with money still owed —
//   the order's own owed / received math, gift card lines included — in the groups No PO yet, PO to check, Not yet due,
//   1–30, 31–60, 61–90 and over 90 days late (calendar days on the business's calendar; due today isn't late), under
//   each "terms start" (invoice, order date, order completed), with its rows, per-customer totals and totals, narrowed
//   by shop or customer. Before migrations/0121 it answers an empty report.
//   The getUnpaidPoReport action: Unpaid POs report (reports.receivables) — Admin and Manager full, Back office read,
//   Production none; a bad as-of date, shop or customer is refused; the answer says whether Net 30 is on.
//   Home (getDashboard): the Unpaid POs part (cache version 3; HOME_BLOCKS has unpaidpos after totals; cleanUserPrefs
//   keeps it), counts only — {count, toCheck} — for a role that doesn't see the money, and the Orders part's POs to
//   check and POs needed.
// "Now" is fixed (2026-12-15 18:00 UTC) inside the code under test, and the business is in America/Chicago, so nothing
// depends on the machine's date or zone. Invented shops, people and PO numbers only.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const NOW = Date.parse("2026-12-15T18:00:00.000Z");
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(NOW); }
  static now() { return NOW; }
}
globalThis.__FixedDate403 = FixedDate;
const dbSrc = strip(read("functions/_lib/db.js"));
const apiSrc = strip(read("functions/api/orders.js"));
// A fresh copy of the code (its own module state: the business time zone it last resolved).
const glue = () => new Function("const Date = globalThis.__FixedDate403;\n" +
  strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  read("functions/_lib/permissions.js").replace(/export (async function|function|const)/g, "$1") + "\n" +
  "const requireAdmin = async (env, host, key, request, msg, need) => { const r = request.headers.get('x-role') || 'admin'; return roleAllows(DEFAULT_ROLES[r] || null, need === 'staff' ? '*' : need) ? null : new Response(JSON.stringify({ status: 'error', code: 'forbidden' }), { status: 403 }); };\n" +
  "const adminActor = () => 'owner@example.test'; " + roles.adminAs({ roleFrom: "request.headers.get('x-role') || 'admin'" }) + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {}, features: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + apiSrc +
  "\nreturn { post: onRequestPost, getUnpaidPoReport, UNPAID_PO_GROUPS, getDashboard, HOME_BLOCKS, cleanUserPrefs, setTerms, getTerms, getOrderById, getOpenOrderStages, toCents, resolveTimeZone };")();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const migrations = fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort();
const fresh = async (upTo) => {
  const d = await createD1();
  d._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of migrations.filter(f => !upTo || f < upTo)) d.execFile(read("migrations/" + f));
  d._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('club','club','Example Club','t','t',1);
    INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('school','school','Example School District','t','t',1);
    INSERT INTO global_settings (key, value) VALUES ('locale', '{"timeZone":"America/Chicago","country":"US"}');`);
  return d;
};
const callOn = (L, d1) => async (body, role = "admin") => {
  const res = await L.post({ env: { DB: d1 }, waitUntil: (p) => Promise.resolve(p).catch(() => {}),
    request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: (h) => h.toLowerCase() === "x-role" ? role : null } } });
  return { status: res.status, body: JSON.parse(await res.text()) };
};
// Days on the calendar: "2026-12-15" less n days.
const minus = (ymd, n) => new RealDate(RealDate.parse(ymd + "T00:00:00Z") - n * 864e5).toISOString().slice(0, 10);
const noonCt = (ymd) => ymd + "T18:00:00.000Z";   // noon in Chicago: the same day there and in UTC
const q = (s) => s == null ? "NULL" : "'" + String(s).replace(/'/g, "''") + "'";
// One order, written straight to the tables so every date and figure is exactly what the test says.
const seed = (d1, o) => {
  d1._raw.exec(`INSERT INTO orders (orderId, orgId, customerId, customerName, contact, placedAt, net30, poNumber, poAcceptedAt, poTypedAt, termsDays, invoicedAt,
      shippedAt, deliveredAt, completedAt, voidedAt, isTest, paid, shippingCostCents, discountCents, taxMode)
    VALUES (${q(o.id)}, ${q(o.org || "club")}, ${o.cust == null ? "NULL" : o.cust}, ${q(o.name != null ? o.name : "Walk-in Buyer")}, 'buyer@example.com', ${q(o.placedAt)},
      ${o.net30 === false ? 0 : 1}, ${q(o.po || "")}, ${q(o.accepted ? "2026-01-01T00:00:00.000Z" : null)}, ${q(o.typed ? "2026-01-01T00:00:00.000Z" : null)},
      ${o.termsDays == null ? "NULL" : o.termsDays}, ${q(o.invoicedAt)}, ${q(o.shippedAt)}, ${q(o.deliveredAt)}, ${q(o.completedAt)}, ${q(o.voidedAt)},
      ${o.isTest ? 1 : 0}, ${o.paid ? 1 : 0}, ${o.shipping || 0}, ${o.discount || 0}, ${q(o.taxMode || "inclusive")})`);
  for (const [productId, cents, tax, cancelled] of o.items || [["tee", 10000]]) {
    d1._raw.exec(`INSERT INTO order_items (orderId, orgId, productId, name, type, qty, lineTotalCents, taxCents, cancelDate)
      VALUES (${q(o.id)}, ${q(o.org || "club")}, ${q(productId)}, 'Example line', 'shirt', 1, ${cents}, ${tax || 0}, ${q(cancelled ? "2026-11-01" : null)})`);
  }
  for (const cents of o.payments || []) {
    d1._raw.exec(`INSERT INTO order_payments (orderId, amountCents, receivedAt, kind, method) VALUES (${q(o.id)}, ${cents}, '2026-11-01T12:00:00.000Z', 'payment', 'check')`);
  }
};
const setTermsRow = (d1, t) => d1._raw.exec(`INSERT OR REPLACE INTO global_settings (key, value) VALUES ('terms', '${JSON.stringify(t)}')`);
const AS_OF = "2026-12-15";
const CT = "America/Chicago";
const keysOf = (o) => Object.keys(o || {}).sort().join(",");
process.on("unhandledRejection", (e) => { console.error(e); ok("nothing in the test was left to fail unseen", false); });
let finished = false;
process.on("exit", () => { if (!finished) { console.log("the test ran to its end: false"); process.exitCode = 1; } });

(async () => {
  // ---- First, in fresh copies of the code: the business's calendar is used even when nothing has asked for it yet ----
  // An invoice sent at 9 pm in Chicago on Nov 15 (03:00 UTC on Nov 16) is due Dec 15 there, so on Dec 16 it's 1 day late.
  console.log("=== The business's calendar, on the first request ===");
  {
    const L = glue(), d1 = await fresh();
    setTermsRow(d1, { defaultDays: 30, startsAt: "invoice" });
    seed(d1, { id: "TZ-1", placedAt: "2026-11-10T18:00:00.000Z", po: "PO-1001", accepted: true, invoicedAt: "2026-11-16T03:00:00.000Z", items: [["tee", 4200]] });
    const r = await callOn(L, d1)({ action: "getUnpaidPoReport", asOf: "2026-12-16" });
    ok("the report, asked with an as-of day before anything else, dates the invoice on the business's calendar (due Dec 15)",
      r.status === 200 && r.body.rows.length === 1 && r.body.rows[0].dueDate === "2026-12-15" && r.body.rows[0].daysLate === 1 && r.body.rows[0].group === "1-30");
    ok("…and counts its money as late", r.body.totals && r.body.totals.lateCents === 4200);
  }
  {
    const L = glue(), d1 = await fresh();
    setTermsRow(d1, { defaultDays: 30, startsAt: "invoice" });
    seed(d1, { id: "TZ-2", placedAt: "2026-11-10T18:00:00.000Z", po: "PO-1001", accepted: true, invoicedAt: "2026-11-16T03:00:00.000Z", items: [["tee", 4200]] });
    const r = await callOn(L, d1)({ action: "getDashboard", today: "2026-12-16", blocks: ["unpaidpos"] });
    ok("Home's Unpaid POs block, asked before anything else, also counts that order 1 day late",
      r.status === 200 && r.body.unpaidPos && r.body.unpaidPos.count === 1 && r.body.unpaidPos.lateCents === 4200);
  }

  const L = glue();
  const d1 = await fresh();
  d1._raw.exec(`INSERT INTO customers (id, name, company, email, createdAt, updatedAt) VALUES (1, 'Pat Example', 'Example School District', 'pat@example.com', 't', 't');
    INSERT INTO customers (id, name, company, email, createdAt, updatedAt) VALUES (2, 'Sam Sample', '', 'sam@example.com', 't', 't');
    INSERT INTO customers (id, name, company, email, createdAt, updatedAt) VALUES (3, '', 'Example Booster Club', 'boosters@example.com', 't', 't');`);
  const call = callOn(L, d1);
  const rep = (opts = {}) => L.getUnpaidPoReport(d1, Object.assign({ asOf: AS_OF, tz: CT }, opts));
  const row = (r, id) => r.rows.find(x => x.orderId === id);
  const grp = (r, key) => r.groups.find(g => g.key === key);

  console.log("\n=== The groups ===");
  ok("seven groups, in order, each with its label",
    same(L.UNPAID_PO_GROUPS.map(g => g.key + "=" + g.label), ["nopo=No PO yet", "tocheck=PO to check", "notdue=Not yet due", "1-30=1–30 days late",
      "31-60=31–60 days late", "61-90=61–90 days late", "90+=Over 90 days late"]));
  {
    const r = await rep();
    ok("an empty shop: every group is there with nothing in it", r.groups.length === 7 && r.groups.every(g => g.count === 0 && g.owedCents === 0 && g.label) &&
      same(r.groups.map(g => g.key), L.UNPAID_PO_GROUPS.map(g => g.key)));
    ok("…no rows, no customers, and totals of nothing", r.rows.length === 0 && r.customers.length === 0 && same(r.totals, { count: 0, owedCents: 0, lateCents: 0, toCheck: 0 }));
    ok("…as of the day asked, with the terms in use (30 days from the invoice by default)", r.asOf === AS_OF && r.startsAt === "invoice" && r.defaultDays === 30);
  }

  // Under "the order date": due = placed + 30 days. Days late on Dec 15 by how long ago each was placed.
  setTermsRow(d1, { defaultDays: 30, startsAt: "order" });
  const placedLate = (late, days = 30) => noonCt(minus(AS_OF, late + days));
  seed(d1, { id: "A-NOPO", cust: 2, placedAt: placedLate(70), items: [["tee", 1100]] });
  seed(d1, { id: "A-CHECK", cust: 2, placedAt: placedLate(-25), po: "PO-1002", typed: true, items: [["tee", 1200]] });
  seed(d1, { id: "A-CHECKLATE", cust: 2, placedAt: placedLate(5), po: "PO-1003", typed: true, items: [["tee", 1300]] });
  seed(d1, { id: "N-SOON", cust: 1, placedAt: placedLate(-20), po: "PO-2001", accepted: true, items: [["tee", 2100]] });
  seed(d1, { id: "N-TODAY", cust: 1, placedAt: placedLate(0), po: "PO-2002", accepted: true, items: [["tee", 2200]] });
  const lates = [1, 30, 31, 60, 61, 90, 91];
  for (const n of lates) seed(d1, { id: "L-" + String(n).padStart(2, "0"), cust: 1, placedAt: placedLate(n), po: "PO-3" + n, accepted: true, items: [["tee", 3000 + n]] });
  {
    const r = await rep();
    ok("No PO yet: a Net 30 order with no PO number, however late it is", row(r, "A-NOPO").group === "nopo" && row(r, "A-NOPO").poStatus === "PO needed" && row(r, "A-NOPO").daysLate === 70);
    ok("PO to check: the customer typed a PO that nobody has accepted — not yet due…", row(r, "A-CHECK").group === "tocheck" && row(r, "A-CHECK").poStatus === "PO to check");
    ok("…and already late (it still waits to be checked first)", row(r, "A-CHECKLATE").group === "tocheck" && row(r, "A-CHECKLATE").daysLate === 5);
    ok("Not yet due: an accepted PO due in 20 days", row(r, "N-SOON").group === "notdue" && row(r, "N-SOON").daysLate === 0 && row(r, "N-SOON").dueDate === minus(AS_OF, -20));
    ok("due today is not late", row(r, "N-TODAY").group === "notdue" && row(r, "N-TODAY").dueDate === AS_OF && row(r, "N-TODAY").daysLate === 0);
    const want = { 1: "1-30", 30: "1-30", 31: "31-60", 60: "31-60", 61: "61-90", 90: "61-90", 91: "90+" };
    for (const n of lates) {
      const x = row(r, "L-" + String(n).padStart(2, "0"));
      ok(`${n} day${n === 1 ? "" : "s"} late is in ${L.UNPAID_PO_GROUPS.find(g => g.key === want[n]).label}`, x && x.daysLate === n && x.group === want[n] && x.poStatus === "accepted");
    }
    ok("each group counts its orders", same(r.groups.map(g => g.count), [1, 2, 2, 2, 2, 2, 1]));
    ok("…and adds up what they owe", grp(r, "nopo").owedCents === 1100 && grp(r, "tocheck").owedCents === 2500 && grp(r, "notdue").owedCents === 4300 &&
      grp(r, "1-30").owedCents === 3001 + 3030 && grp(r, "31-60").owedCents === 3031 + 3060 && grp(r, "61-90").owedCents === 3061 + 3090 && grp(r, "90+").owedCents === 3091);
    ok("rows come group by group, the latest first within a group, the soonest due first among those not late",
      same(r.rows.map(x => x.orderId), ["A-NOPO", "A-CHECKLATE", "A-CHECK", "N-TODAY", "N-SOON", "L-30", "L-01", "L-60", "L-31", "L-90", "L-61", "L-91"]));
    const all = 1100 + 2500 + 4300 + lates.reduce((s, n) => s + 3000 + n, 0);
    const late = 1100 + 1300 + lates.reduce((s, n) => s + 3000 + n, 0);
    ok("totals: how many orders, what they owe, what's owed late (whatever the PO's state) and POs to check",
      same(r.totals, { count: 12, owedCents: all, lateCents: late, toCheck: 2 }));
    const x = row(r, "L-31");
    ok("a row says which order, shop, customer, PO and its state, dates, days, and money in cents",
      keysOf(x) === "company,completedAt,customerId,customerName,daysLate,dueDate,group,invoicedAt,orderId,orgId,orgName,owedCents,placedAt,poNumber,poStatus,receivedCents,termsDays,totalCents" &&
      x.orgId === "club" && x.orgName === "Example Club" && x.customerId === 1 && x.customerName === "Pat Example" && x.company === "Example School District" &&
      x.poNumber === "PO-331" && x.placedAt === placedLate(31) && x.invoicedAt === "" && x.completedAt === "" && x.termsDays === 30 &&
      x.owedCents === 3031 && x.receivedCents === 0 && x.totalCents === 3031);
    ok("the report is as of the day and terms it used", r.asOf === AS_OF && r.startsAt === "order" && r.defaultDays === 30);

    console.log("\n=== By customer ===");
    const c1 = r.customers.find(c => c.customerId === 1), c2 = r.customers.find(c => c.customerId === 2);
    ok("one line per customer, the most owed first", r.customers.length === 2 && r.customers[0] === c1 && r.customers[1] === c2);
    ok("a customer's line: name, company, how many orders, what they owe and what's late",
      keysOf(c1) === "company,count,customerId,lateCents,name,owedCents" && c1.name === "Pat Example" && c1.company === "Example School District" && c1.count === 9 &&
      c1.owedCents === 4300 + lates.reduce((s, n) => s + 3000 + n, 0) && c1.lateCents === lates.reduce((s, n) => s + 3000 + n, 0));
    ok("…late money counts orders without a PO and with one to check too", c2.count === 3 && c2.owedCents === 3600 && c2.lateCents === 2400 && c2.name === "Sam Sample");
  }

  console.log("\n=== Which orders are on it ===");
  seed(d1, { id: "X-CARD", net30: false, cust: 1, placedAt: placedLate(10), items: [["tee", 5000]] });
  seed(d1, { id: "X-VOID", cust: 1, placedAt: placedLate(10), po: "PO-9001", accepted: true, voidedAt: "2026-12-01T12:00:00.000Z" });
  seed(d1, { id: "X-TEST", cust: 1, placedAt: placedLate(10), po: "PO-9002", accepted: true, isTest: true });
  seed(d1, { id: "X-PAID", cust: 1, placedAt: placedLate(10), po: "PO-9003", accepted: true, items: [["tee", 5000]], payments: [3000, 2000], paid: true });
  seed(d1, { id: "X-OVER", cust: 1, placedAt: placedLate(10), po: "PO-9004", accepted: true, items: [["tee", 5000]], payments: [6000] });
  seed(d1, { id: "X-TOMORROW", cust: 1, placedAt: noonCt(minus(AS_OF, -1)), po: "PO-9005", accepted: true });
  seed(d1, { id: "Y-TONIGHT", cust: 1, placedAt: AS_OF + "T23:30:00.000Z", po: "PO-9006", accepted: true, items: [["tee", 700]] });
  seed(d1, { id: "Y-PART", cust: 1, placedAt: placedLate(10), po: "PO-9007", accepted: true, items: [["tee", 5000]], payments: [1500] });
  // What the order comes to: goods 5,000 + a gift card line 2,500 + tax added 400 + shipping 800 − discount 300; a
  // cancelled line doesn't count. 1,000 received.
  seed(d1, { id: "Y-MONEY", cust: 3, name: "", placedAt: placedLate(10), po: "PO-9008", accepted: true, taxMode: "exclusive", shipping: 800, discount: 300,
    items: [["tee", 5000, 400], ["__giftcard__", 2500, 0], ["cap", 999, 0, true]], payments: [1000] });
  {
    const r = await rep();
    const ids = r.rows.map(x => x.orderId);
    ok("an order not on Net 30 is not on it", !ids.includes("X-CARD"));
    ok("a voided order is not on it", !ids.includes("X-VOID"));
    ok("a test order is not on it", !ids.includes("X-TEST"));
    ok("an order paid in full is not on it", !ids.includes("X-PAID"));
    ok("an order paid more than it comes to is not on it", !ids.includes("X-OVER"));
    ok("an order placed after the as-of day is not on it", !ids.includes("X-TOMORROW"));
    ok("…but one placed late on the as-of day is", ids.includes("Y-TONIGHT"));
    const p = row(r, "Y-PART");
    ok("a part-paid order owes the rest, and says what was received of what total", p && p.owedCents === 3500 && p.receivedCents === 1500 && p.totalCents === 5000);
    const m = row(r, "Y-MONEY");
    ok("what's owed is the order's own math: goods, gift card lines, tax added, shipping, less the discount and what was received",
      m && m.totalCents === 8400 && m.receivedCents === 1000 && m.owedCents === 7400);
    const o = await L.getOrderById(d1, "Y-MONEY");
    ok("…the same as the order's own balance due", o && L.toCents(o.balanceDue) === m.owedCents);
    const c3 = r.customers.find(c => c.customerId === 3);
    ok("a customer with a company and no name is listed by the company", c3 && c3.name === "Example Booster Club" && c3.count === 1 && m.customerName === "" && m.company === "Example Booster Club");
    const earlier = await rep({ asOf: minus(AS_OF, 40) });
    ok("an earlier as-of day leaves out what was placed after it, and counts days late from then",
      !earlier.rows.some(x => x.orderId === "N-SOON" || x.orderId === "Y-TONIGHT") && row(earlier, "L-91").daysLate === 51 && row(earlier, "L-91").group === "31-60" &&
      row(earlier, "L-30").group === "notdue" && earlier.asOf === minus(AS_OF, 40));
  }
  d1._raw.exec("DELETE FROM order_items WHERE orderId LIKE 'X-%' OR orderId LIKE 'Y-%'; DELETE FROM order_payments; DELETE FROM orders WHERE orderId LIKE 'X-%' OR orderId LIKE 'Y-%'");

  console.log("\n=== Customers without a record ===");
  seed(d1, { id: "W-1", name: "Walk-in Buyer", placedAt: placedLate(3), po: "PO-4001", accepted: true, items: [["tee", 500]] });
  seed(d1, { id: "W-2", name: "walk-in buyer", placedAt: placedLate(-3), po: "PO-4002", accepted: true, items: [["tee", 600]] });
  {
    const r = await rep();
    const w = r.customers.filter(c => /walk-in/i.test(c.name));
    ok("orders with no customer record are put together by name, whatever its case", w.length === 1 && w[0].count === 2 && w[0].owedCents === 1100 && w[0].lateCents === 500 && w[0].customerId === null);
    ok("…and the row has no customer id but the order's name", row(r, "W-1").customerId === null && row(r, "W-1").customerName === "Walk-in Buyer");
  }
  d1._raw.exec("DELETE FROM order_items WHERE orderId LIKE 'W-%'; DELETE FROM orders WHERE orderId LIKE 'W-%'");

  console.log("\n=== Narrowed by shop or customer ===");
  seed(d1, { id: "S-1", org: "school", cust: 2, placedAt: placedLate(45), po: "PO-5001", accepted: true, items: [["tee", 8000]] });
  {
    const all = await rep();
    const school = await rep({ orgId: "school" });
    ok("one shop: only its orders", school.rows.length === 1 && school.rows[0].orderId === "S-1" && school.rows[0].orgName === "Example School District");
    ok("…with its own groups, customers and totals", grp(school, "31-60").count === 1 && school.customers.length === 1 && same(school.totals, { count: 1, owedCents: 8000, lateCents: 8000, toCheck: 0 }));
    ok("no shop named: every shop", all.rows.some(x => x.orgId === "school") && all.rows.some(x => x.orgId === "club"));
    const c2 = await rep({ customerId: 2 });
    ok("one customer: only their orders, in every shop", same(c2.rows.map(x => x.orderId).sort(), ["A-CHECK", "A-CHECKLATE", "A-NOPO", "S-1"]) && c2.customers.length === 1);
    ok("a customer id as text works the same", same((await rep({ customerId: "2" })).rows.map(x => x.orderId), c2.rows.map(x => x.orderId)));
    ok("shop and customer together", same((await rep({ customerId: 2, orgId: "club" })).rows.map(x => x.orderId).sort(), ["A-CHECK", "A-CHECKLATE", "A-NOPO"]));
    ok("a customer id that isn't one matches nothing", (await rep({ customerId: "abc" })).rows.length === 0 && (await rep({ customerId: -4 })).rows.length === 0);
    ok("a blank customer id narrows nothing", (await rep({ customerId: "" })).rows.length === all.rows.length && (await rep({ customerId: null })).rows.length === all.rows.length);
    ok("a shop with no Net 30 orders: an empty report", (await rep({ orgId: "nowhere" })).rows.length === 0);
  }
  d1._raw.exec("DELETE FROM order_items WHERE orderId = 'S-1'; DELETE FROM orders WHERE orderId = 'S-1'");

  console.log("\n=== When the days start ===");
  seed(d1, { id: "T-INV", cust: 1, placedAt: noonCt("2026-10-01"), invoicedAt: noonCt("2026-10-20"), po: "PO-6001", accepted: true, items: [["tee", 900]] });
  seed(d1, { id: "T-NOINV", cust: 1, placedAt: noonCt("2026-10-01"), po: "PO-6002", accepted: true, items: [["tee", 900]] });
  seed(d1, { id: "T-OWN", cust: 1, placedAt: noonCt("2026-11-20"), invoicedAt: noonCt("2026-11-25"), termsDays: 10, po: "PO-6003", accepted: true, items: [["tee", 900]] });
  seed(d1, { id: "T-SHIP", cust: 1, placedAt: noonCt("2026-10-01"), shippedAt: noonCt("2026-10-10"), completedAt: noonCt("2026-10-30"), po: "PO-6004", accepted: true, items: [["tee", 900]] });
  seed(d1, { id: "T-HAND", cust: 1, placedAt: noonCt("2026-10-01"), deliveredAt: noonCt("2026-10-12"), po: "PO-6005", accepted: true, items: [["tee", 900]] });
  seed(d1, { id: "T-DONE", cust: 1, placedAt: noonCt("2026-10-01"), completedAt: noonCt("2026-10-14"), po: "PO-6006", accepted: true, items: [["tee", 900]] });
  seed(d1, { id: "T-OPEN", cust: 1, placedAt: noonCt("2026-08-01"), po: "PO-6007", accepted: true, items: [["tee", 900]] });
  {
    setTermsRow(d1, { defaultDays: 30, startsAt: "order" });
    let r = await rep();
    ok("from the order date: the invoice doesn't matter", row(r, "T-INV").dueDate === "2026-10-31" && row(r, "T-INV").invoicedAt === noonCt("2026-10-20"));
    ok("…an order's own days count instead of the default", row(r, "T-OWN").dueDate === "2026-11-30" && row(r, "T-OWN").termsDays === 10);
    ok("…and the default shows on the others", row(r, "T-INV").termsDays === 30);
    ok("…an order not completed is still due from its order date", row(r, "T-OPEN").dueDate === "2026-08-31" && row(r, "T-OPEN").group === "90+");

    setTermsRow(d1, { defaultDays: 30, startsAt: "invoice" });
    r = await rep();
    ok("from the invoice: due 30 days after it was first sent", r.startsAt === "invoice" && row(r, "T-INV").dueDate === "2026-11-19" && row(r, "T-INV").daysLate === 26 && row(r, "T-INV").group === "1-30");
    ok("…and from the order date when no invoice was sent", row(r, "T-NOINV").dueDate === "2026-10-31" && row(r, "T-NOINV").group === "31-60");
    ok("…an order's own days from its invoice", row(r, "T-OWN").dueDate === "2026-12-05" && row(r, "T-OWN").daysLate === 10);

    setTermsRow(d1, { defaultDays: 30, startsAt: "completed" });
    r = await rep();
    ok("from completion: shipped counts as completed", r.startsAt === "completed" && row(r, "T-SHIP").dueDate === "2026-11-09" && row(r, "T-SHIP").group === "31-60");
    ok("…handed over (delivered or picked up) counts", row(r, "T-HAND").dueDate === "2026-11-11" && row(r, "T-HAND").completedAt === noonCt("2026-10-12"));
    ok("…completed counts", row(r, "T-DONE").dueDate === "2026-11-13" && row(r, "T-DONE").completedAt === noonCt("2026-10-14"));
    ok("…a row's completed date is when it was completed, else shipped", row(r, "T-SHIP").completedAt === noonCt("2026-10-30"));
    const open = row(r, "T-OPEN");
    ok("…an order not completed yet is Not yet due, with no due date, however old", open.group === "notdue" && open.dueDate === "" && open.daysLate === 0);
    ok("…and it isn't counted late", r.totals.lateCents === r.rows.filter(x => x.daysLate > 0 && x.orderId !== "T-OPEN").reduce((s, x) => s + x.owedCents, 0));
    ok("…while a PO-less order not completed is still No PO yet", row(r, "A-NOPO").group === "nopo" && row(r, "A-NOPO").dueDate === "" && row(r, "A-NOPO").daysLate === 0);

    setTermsRow(d1, { defaultDays: 45, startsAt: "order" });
    r = await rep();
    ok("a new default number of days moves every order without its own", r.defaultDays === 45 && row(r, "T-INV").dueDate === "2026-11-15" && row(r, "T-INV").termsDays === 45 &&
      row(r, "T-OWN").dueDate === "2026-11-30");
    setTermsRow(d1, { defaultDays: 900, startsAt: "whenever" });
    r = await rep();
    ok("terms saved out of range read as 30 days from the invoice", r.defaultDays === 30 && r.startsAt === "invoice");
    setTermsRow(d1, { defaultDays: 30, startsAt: "order" });
  }
  d1._raw.exec("DELETE FROM order_items WHERE orderId LIKE 'T-%'; DELETE FROM orders WHERE orderId LIKE 'T-%'");

  console.log("\n=== The business's calendar ===");
  {
    seed(d1, { id: "Z-1", cust: 1, placedAt: "2026-11-15T03:00:00.000Z", po: "PO-7001", accepted: true, items: [["tee", 100]] });
    const ct = await rep({ tz: CT }), utc = await rep({ tz: "UTC" });
    ok("an order placed at 9 pm in Chicago on Nov 14 is due Dec 14 there: 1 day late", row(ct, "Z-1").dueDate === "2026-12-14" && row(ct, "Z-1").daysLate === 1);
    ok("…where on UTC's calendar it would be due today", row(utc, "Z-1").dueDate === "2026-12-15" && row(utc, "Z-1").daysLate === 0);
    d1._raw.exec("DELETE FROM order_items WHERE orderId = 'Z-1'; DELETE FROM orders WHERE orderId = 'Z-1'");
    seed(d1, { id: "Z-2", cust: 1, placedAt: "2026-11-14T12:00:00.000Z", po: "PO-7002", accepted: true, items: [["tee", 100]] });
    ok("a date-only stamp (noon UTC) is its own day in any zone", row(await rep({ tz: "Pacific/Kiritimati" }), "Z-2").dueDate === "2026-12-14" &&
      row(await rep({ tz: "Pacific/Pago_Pago" }), "Z-2").dueDate === "2026-12-14");
    d1._raw.exec("DELETE FROM order_items WHERE orderId = 'Z-2'; DELETE FROM orders WHERE orderId = 'Z-2'");
    ok("no as-of day: today on the business's calendar", (await L.getUnpaidPoReport(d1, { tz: CT })).asOf === "2026-12-15" &&
      (await L.getUnpaidPoReport(d1, { tz: "Pacific/Kiritimati" })).asOf === "2026-12-16");
    ok("an as-of day that isn't a date is today too", (await L.getUnpaidPoReport(d1, { asOf: "12/01/2026", tz: CT })).asOf === "2026-12-15");
    ok("no zone given: the one last resolved", (await L.resolveTimeZone({ DB: d1 })) === CT && (await L.getUnpaidPoReport(d1, {})).asOf === "2026-12-15");
  }

  console.log("\n=== Before migrations/0121 ===");
  const old = await fresh("0121");
  old._raw.exec(`INSERT INTO orders (orderId, orgId, customerName, contact, placedAt) VALUES ('OLD-1','club','Pat Example','pat@example.com','2026-10-01T12:00:00Z');`);
  {
    const r = await L.getUnpaidPoReport(old, { asOf: AS_OF, tz: CT });
    ok("the report is empty, in the same shape, with the default terms", r.asOf === AS_OF && r.startsAt === "invoice" && r.defaultDays === 30 && r.rows.length === 0 &&
      r.customers.length === 0 && r.groups.length === 7 && r.groups.every(g => g.count === 0 && g.owedCents === 0) && same(r.totals, { count: 0, owedCents: 0, lateCents: 0, toCheck: 0 }));
    const a = await callOn(L, old)({ action: "getUnpaidPoReport", asOf: AS_OF });
    ok("…and the page gets it, not an error", a.status === 200 && a.body.status === "ok" && a.body.rows.length === 0 && a.body.net30On === false);
    const dsh = await L.getDashboard(old, { today: AS_OF, blocks: ["orders", "unpaidpos"] });
    ok("Home counts nothing owed and no POs", same(dsh.unpaidPos, { count: 0, owedCents: 0, lateCents: 0, toCheck: 0 }) && dsh.poToCheck === 0 && dsh.poNeeded === 0);
  }

  console.log("\n=== The report on the admin page (getUnpaidPoReport) ===");
  {
    const P = roles.effectivePermissions;
    ok("its own function on the Roles screen, the Unpaid POs page", roles.PERMISSION_AREAS.flatMap(m => m.items).some(i => i.hash === "unpaidpos" && i.fns.some(([f]) => f === "reports.receivables")));
    ok("Admin and Manager have it in full, Back office can read it, Production has none",
      P(roles.DEFAULT_ROLES.admin)["reports.receivables"] === "full" && P(roles.DEFAULT_ROLES.manager)["reports.receivables"] === "full" &&
      P(roles.DEFAULT_ROLES.staff)["reports.receivables"] === "read" && P(roles.DEFAULT_ROLES.production)["reports.receivables"] === "none");
    ok("reading it is enough for the report", roles.may("staff", "getUnpaidPoReport") && roles.lowest("getUnpaidPoReport") === "staff");
    const full = await rep();
    for (const role of ["admin", "manager", "staff"]) {
      const r = await call({ action: "getUnpaidPoReport", asOf: AS_OF }, role);
      ok(`${{ admin: "Admin", manager: "Manager", staff: "Back office" }[role]} gets the report`, r.status === 200 && r.body.status === "ok" && same(r.body.rows, full.rows) && same(r.body.totals, full.totals));
    }
    let r = await call({ action: "getUnpaidPoReport", asOf: AS_OF }, "production");
    ok("Production is refused", r.status === 403 && !r.body.rows);
    r = await call({ action: "getUnpaidPoReport", asOf: AS_OF }, "nobody");
    ok("nobody signed in is refused", r.status === 403);
    r = await call({ action: "getUnpaidPoReport", asOf: AS_OF });
    ok("the answer has the report, the terms, the groups and customers, and what it was narrowed by",
      same(r.body.groups, full.groups) && same(r.body.customers, full.customers) && r.body.asOf === AS_OF && r.body.startsAt === "order" && r.body.defaultDays === 30 &&
      r.body.orgId === null && r.body.customerId === null);
    ok("…and that Net 30 isn't ticked in Global settings, so the page can say why", r.body.net30On === false);
    d1._raw.exec(`INSERT OR REPLACE INTO global_settings (key, value) VALUES ('enabledPayments', '{"card":true,"net30":true}')`);
    ok("ticked, it says so", (await call({ action: "getUnpaidPoReport", asOf: AS_OF })).body.net30On === true);
    d1._raw.exec(`INSERT OR REPLACE INTO global_settings (key, value) VALUES ('enabledPayments', '{"card":true,"net30":"yes"}')`);
    ok("only a real tick counts", (await call({ action: "getUnpaidPoReport", asOf: AS_OF })).body.net30On === false);
    r = await call({ action: "getUnpaidPoReport" });
    ok("no as-of day: the business's today", r.status === 200 && r.body.asOf === "2026-12-15");
    r = await call({ action: "getUnpaidPoReport", asOf: "" });
    ok("…a blank one too", r.status === 200 && r.body.asOf === "2026-12-15");
    r = await call({ action: "getUnpaidPoReport", asOf: " " + minus(AS_OF, 40) + " " });
    ok("an as-of day with spaces around it is read", r.status === 200 && r.body.asOf === minus(AS_OF, 40) && !r.body.rows.some(x => x.orderId === "N-SOON"));
    for (const bad of ["2026-02-30", "12/15/2026", "yesterday", "2026-13-01"]) {
      r = await call({ action: "getUnpaidPoReport", asOf: bad });
      ok(`an as-of day of "${bad}" is refused`, r.status === 400 && r.body.message === "Invalid date — expected YYYY-MM-DD");
    }
    seed(d1, { id: "S-2", org: "school", cust: 2, placedAt: placedLate(2), po: "PO-5002", accepted: true, items: [["tee", 400]] });
    r = await call({ action: "getUnpaidPoReport", asOf: AS_OF, org: "school" });
    ok("a shop by `org`: only its orders, and it says which", r.status === 200 && same(r.body.rows.map(x => x.orderId), ["S-2"]) && r.body.orgId === "school");
    r = await call({ action: "getUnpaidPoReport", asOf: AS_OF, orgId: "school", org: "club" });
    ok("…`orgId` wins over `org`", r.status === 200 && same(r.body.rows.map(x => x.orderId), ["S-2"]) && r.body.orgId === "school");
    r = await call({ action: "getUnpaidPoReport", asOf: AS_OF, orgId: "", org: "school" });
    ok("…a blank `orgId` falls back to `org`", r.body.orgId === "school");
    r = await call({ action: "getUnpaidPoReport", asOf: AS_OF, org: "nowhere" });
    ok("a shop that doesn't exist is refused", r.status === 404 && r.body.message === "Unknown shop");
    r = await call({ action: "getUnpaidPoReport", asOf: AS_OF, org: 42 });
    ok("a shop that isn't a name is refused", r.status === 400 && r.body.message === "That shop isn't valid.");
    r = await call({ action: "getUnpaidPoReport", asOf: AS_OF, org: "x".repeat(101) });
    ok("…as is one too long", r.status === 400 && r.body.message === "That shop isn't valid.");
    r = await call({ action: "getUnpaidPoReport", asOf: AS_OF, customerId: 2 });
    ok("one customer: their orders, and it says which", r.status === 200 && same(r.body.rows.map(x => x.orderId).sort(), ["A-CHECK", "A-CHECKLATE", "A-NOPO", "S-2"]) && r.body.customerId === 2);
    r = await call({ action: "getUnpaidPoReport", asOf: AS_OF, customerId: "2", org: "club" });
    ok("…a customer id as text, with a shop", r.status === 200 && same(r.body.rows.map(x => x.orderId).sort(), ["A-CHECK", "A-CHECKLATE", "A-NOPO"]) && r.body.customerId === 2 && r.body.orgId === "club");
    for (const bad of ["abc", 0, -3, 1.5]) {
      r = await call({ action: "getUnpaidPoReport", asOf: AS_OF, customerId: bad });
      ok(`a customer id of ${JSON.stringify(bad)} is refused`, r.status === 400 && r.body.message === "That customer isn't valid. Pick one from the list.");
    }
    r = await call({ action: "getUnpaidPoReport", asOf: AS_OF, customerId: "" });
    ok("a blank customer id narrows nothing", r.status === 200 && r.body.customerId === null && r.body.rows.length === full.rows.length + 1);
    d1._raw.exec("DELETE FROM order_items WHERE orderId = 'S-2'; DELETE FROM orders WHERE orderId = 'S-2'");
  }

  console.log("\n=== Home: the blocks ===");
  ok("Home's blocks, top to bottom: Orders, Business totals, Unpaid POs, Money in and out, the pies, Product sales",
    same(L.HOME_BLOCKS, ["orders", "totals", "unpaidpos", "inout", "pies", "sales"]));
  ok("a user can hide the Unpaid POs block (kept in Home's order, unknown blocks dropped)",
    same(L.cleanUserPrefs({ home: { hidden: ["unpaidpos", "nonsense", "orders"] } }), { home: { hidden: ["orders", "unpaidpos"] } }));
  ok("…and show it again", same(L.cleanUserPrefs({ home: { hidden: [] } }), { home: { hidden: [] } }));

  // Home on its own shop: one of each kind of open order.
  const d2 = await fresh();
  const call2 = callOn(L, d2);
  setTermsRow(d2, { defaultDays: 30, startsAt: "order" });
  seed(d2, { id: "H-NEED", placedAt: placedLate(5), items: [["tee", 1000]] });
  seed(d2, { id: "H-NEED2", placedAt: placedLate(-5), items: [["tee", 1000]] });
  seed(d2, { id: "H-CHECK", placedAt: placedLate(-10), po: "PO-8001", typed: true, items: [["tee", 2000]] });
  seed(d2, { id: "H-OK", placedAt: placedLate(40), po: "PO-8002", accepted: true, items: [["tee", 3000]] });
  seed(d2, { id: "H-DONE", placedAt: placedLate(-1), completedAt: noonCt(minus(AS_OF, 1)), items: [["tee", 4000]] });
  seed(d2, { id: "H-CARD", net30: false, placedAt: placedLate(5), items: [["tee", 5000]] });
  seed(d2, { id: "H-PAID", placedAt: placedLate(5), po: "PO-8003", typed: true, paid: true, items: [["tee", 6000]], payments: [6000] });
  const homeTotals = (await L.getUnpaidPoReport(d2, { asOf: AS_OF, tz: CT })).totals;
  ok("(the shop: five Net 30 orders owe money — two without a PO, one to check, one accepted and late, one completed without a PO)",
    same(homeTotals, { count: 5, owedCents: 11000, lateCents: 1000 + 3000, toCheck: 1 }));

  console.log("\n=== Home: the figures (getDashboard) ===");
  {
    let d = await L.getDashboard(d2, { today: AS_OF });
    ok("the Unpaid POs part is the report's totals as of today", same(d.unpaidPos, homeTotals) && d.blocks.includes("unpaidpos"));
    ok("the Orders part counts the POs to check and the POs needed among new orders", d.poToCheck === 1 && d.poNeeded === 2);
    const stages = await L.getOpenOrderStages(d2);
    const st = (id) => stages.find(s => s.orderId === id);
    ok("…an open order waiting on its PO is new and says why", st("H-NEED").stage === "new" && st("H-NEED").poStatus === "PO needed" && st("H-CHECK").poStatus === "PO to check");
    ok("…one with its PO accepted has moved on and says nothing of POs", st("H-OK").stage !== "new" && !("poStatus" in st("H-OK")));
    ok("…a paid order with a PO to check isn't new, so it isn't counted", st("H-PAID").stage !== "new" && !("poStatus" in st("H-PAID")));
    ok("…neither is an order not on Net 30, nor a completed one", !("poStatus" in st("H-CARD")) && st("H-CARD").stage === "new" && !st("H-DONE"));
    ok("the figures are kept: asked again, the same and from the cache", (d = await L.getDashboard(d2, { today: AS_OF })).cached === true && same(d.unpaidPos, homeTotals));
    const cache = JSON.parse(d2.q("SELECT value FROM global_settings WHERE key='dashboardCache'")[0].value);
    ok("…kept as version 3, the Unpaid POs part with them", cache.v === 3 && same(cache.parts.unpaidPos.data, { unpaidPos: homeTotals }) && cache.parts.orders.data.poToCheck === 1);
    const plant = (v) => d2._raw.exec(`INSERT OR REPLACE INTO global_settings (key, value) VALUES ('dashboardCache', '${JSON.stringify({ v, today: AS_OF,
      parts: { unpaidPos: { at: NOW - 1000, data: { unpaidPos: { count: 77, owedCents: 1, lateCents: 1, toCheck: 7 } } } } })}')`);
    plant(2);
    d = await L.getDashboard(d2, { today: AS_OF, now: NOW, blocks: ["unpaidpos"] });
    ok("an hour-old answer kept in the old shape (version 2) isn't handed back", d.cached === false && same(d.unpaidPos, homeTotals));
    plant(3);
    d = await L.getDashboard(d2, { today: AS_OF, now: NOW, blocks: ["unpaidpos"] });
    ok("one kept as version 3 is", d.cached === true && d.unpaidPos.count === 77);
    ok("…unless Home asks for fresh figures", same((await L.getDashboard(d2, { today: AS_OF, now: NOW, blocks: ["unpaidpos"], fresh: true })).unpaidPos, homeTotals));
    plant(3);
    await L.setTerms(d2, { defaultDays: 30 });
    ok("changing the Net 30 terms drops the kept figures", d2.q("SELECT count(*) AS n FROM global_settings WHERE key='dashboardCache'")[0].n === 0);
    d = await L.getDashboard(d2, { today: AS_OF, blocks: ["unpaidpos"] });
    ok("only the Unpaid POs block shown: only its part is worked out", same(d.unpaidPos, homeTotals) && d.stages === undefined && same(d.blocks, ["unpaidpos"]));
    d = await L.getDashboard(d2, { today: AS_OF, blocks: ["orders", "totals"], fresh: true });
    ok("the block hidden: no Unpaid POs part", !("unpaidPos" in d) && d.poToCheck === 1 && !d.blocks.includes("unpaidpos"));
    d = await L.getDashboard(d2, { today: minus(AS_OF, 5), blocks: ["unpaidpos"] });
    ok("a different day: worked out as of that day", d.cached === false && d.unpaidPos.count === 5 && d.unpaidPos.lateCents === 3000);
  }

  console.log("\n=== Home: who sees what (getDashboard on the admin page) ===");
  {
    let r = await call2({ action: "getDashboard", today: AS_OF, fresh: true });
    ok("Admin gets the Unpaid POs figures with the money", r.status === 200 && same(r.body.unpaidPos, homeTotals) && r.body.poToCheck === 1 && r.body.poNeeded === 2);
    r = await call2({ action: "getDashboard", today: AS_OF }, "manager");
    ok("Manager too", r.status === 200 && same(r.body.unpaidPos, homeTotals) && r.body.poToCheck === 1 && r.body.poNeeded === 2);
    for (const role of ["staff", "production"]) {
      const who = role === "staff" ? "Back office" : "Production";
      r = await call2({ action: "getDashboard", today: AS_OF }, role);
      ok(`${who} (no costs) gets only how many are owed and how many POs to check`, r.status === 200 && same(r.body.unpaidPos, { count: 5, toCheck: 1 }));
      ok(`…and the order counts, without the POs to check or needed`, keysOf(r.body) === "blocks,cached,cachedAt,onTheWay,open,stages,status,unpaidPos" && r.body.open === 6 &&
        r.body.stages.new === 4 && same(r.body.blocks, ["orders", "unpaidpos"]));
      r = await call2({ action: "getDashboard", today: AS_OF, blocks: ["orders", "totals"] }, role);
      ok(`${who} with the Unpaid POs block hidden: no Unpaid POs part`, r.status === 200 && !("unpaidPos" in r.body) && same(r.body.blocks, ["orders"]));
      r = await call2({ action: "getDashboard", today: AS_OF, blocks: ["unpaidpos"] }, role);
      ok(`${who} with only that block: only its counts`, r.status === 200 && same(r.body.unpaidPos, { count: 5, toCheck: 1 }) && same(r.body.blocks, ["unpaidpos"]) && r.body.stages === undefined);
    }
    r = await call2({ action: "getDashboard", today: AS_OF }, "nobody");
    ok("nobody signed in is refused", r.status === 403 && !r.body.unpaidPos);
  }

  finished = true;
})().catch((e) => { console.error(e); ok("the test ran without an error", false); finished = true; });
