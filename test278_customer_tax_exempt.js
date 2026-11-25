// A customer's tax exemption, end to end (migrations/0105).
//   * An order is untaxed for its customer only when someone signed in PICKED that customer (createLocalSale's
//     customerId → insertOrder opts.customerId). An order that merely carries an exempt customer's email (the
//     storefront, a local sale with the email typed, an import) is linked to them for the history and taxed as usual.
//   * The exemption's expiry: exempt on the expiry day, taxed the day after, the day being the order's calendar day
//     in the Region time zone (else the zone last resolved, else UTC). No expiry = no end.
//   * The shop's exemption OR the customer's; both tax modes; unticking later rewrites nothing; the sales tax report.
//   * saveCustomer (the handler): a change to any exemption field is Full's, is written to the audit log BEFORE the
//     save (no audit row, no save), and is told apart from a save that only sends the stored values back.
// Real SQL (sql.js), the real db.js and orders.js. Invented shops and customers only. Every order here is dated
// by the test, and the machine's own time zone is set to one that no check uses.
process.env.TZ = "Asia/Kolkata";

const fs = require("fs");
const { ok } = require("./testlib/check");
const { createD1 } = require("./testlib/d1-shim.js");
const { adminAs, may } = require("./testlib/roles");

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { insertOrder, getOrderById, setSalesTaxSettings, setLocaleSettings, setOrgTaxExemption, createProduct,
  importOrdersCsv, getSalesTaxReport, mergeCustomers };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" + adminAs({ roleFrom: "globalThis.__role" }) + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  strip(read("functions/_lib/quoteToken.js")) + "\nconst verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: { acme: 'acme' }, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false;\n" +
  dbSrc + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const section = (t) => console.log("\n=== " + t + " ===");

async function newDb(upTo) {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006" && (!upTo || f < upTo)).sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, ready, createdAt, updatedAt) VALUES ('acme','acme','Example Club',1,'t','t'), ('league','league','Example League',1,'t','t');`);
  return d1;
}

(async () => {
  const d1 = await newDb();
  await lib.createProduct(d1, "acme", { productId: "polo", type: "cap", name: "Polo", pricingMode: "flat", flatPrice: 16, visible: true });
  await lib.setSalesTaxSettings(d1, { rateBps: 600, jurisdiction: "OH", taxMode: "inclusive" });

  // The database the handler is given: the real one, with a record of the statements run (to see what came first)
  // and a switch that makes writing to the audit log fail.
  const seen = [];
  let auditBroken = false;
  const wrap = (st) => {
    const note = () => { seen.push(st._sql); if (auditBroken && /INSERT INTO audit_log/.test(st._sql)) throw new Error("the audit log can't be written"); };
    return { _sql: st._sql, _params: st._params,
      first: async (...a) => { note(); return st.first(...a); }, all: async (...a) => { note(); return st.all(...a); }, run: async (...a) => { note(); return st.run(...a); } };
  };
  const dbOf = (real) => ({
    prepare: (sql) => { const p = real.prepare(sql); return Object.assign(wrap(p), { bind: (...v) => wrap(p.bind(...v)) }); },
    batch: (stmts) => { stmts.forEach(s => seen.push(s._sql)); return real.batch(stmts); },
  });
  const db = dbOf(d1);
  let envExtra = {};
  const callOn = async (database, body, url = "https://admin.example.com/api/orders") => {
    const waits = [];
    const res = await api({ env: { DB: database, SIGNING_SECRET: "s".repeat(40), ...envExtra }, waitUntil: (p) => waits.push(p && p.then ? p.then(() => {}, () => {}) : null),
      request: { url, json: async () => Object.assign({ key: "x" }, body), clone: () => ({ json: async () => Object.assign({ key: "x" }, body) }), headers: { get: () => null } } });
    await Promise.all(waits);
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const call = (body, url) => callOn(db, body, url);
  // The same, with the errors the handler logs kept off the page (a refused audit write is logged on purpose).
  const quietly = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };
  const as = async (role, fn) => { const was = globalThis.__role; globalThis.__role = role; try { return await fn(); } finally { globalThis.__role = was; } };
  globalThis.__role = "admin";

  const save = (fields) => call({ action: "saveCustomer", ...fields });
  const cust = (id) => d1.q("SELECT * FROM customers WHERE id = ?", id)[0];
  const exemptionOf = (id) => { const c = cust(id); return [c.taxExempt, c.taxExemptCertificate, c.taxExemptExpires]; };
  const auditId = () => d1.q("SELECT COALESCE(MAX(id), 0) AS n FROM audit_log")[0].n;
  const auditSince = (mark, action) => d1.q("SELECT action, orderId, detail FROM audit_log WHERE id > ? ORDER BY id", mark)
    .filter(a => !action || a.action === action).map(a => ({ action: a.action, orderId: a.orderId, detail: JSON.parse(a.detail || "{}") }));

  // A $100.00 custom line, taxable, sold over the counter in the shop that isn't exempt.
  const PATCH = { productId: "__custom__", name: "Stitched patch", type: "custom", size: "", qty: 1, customUnitPrice: 100 };
  const sale = (extra = {}) => call({ action: "createLocalSale", org: "acme", customerName: "Walk-in", contact: "", paymentMethod: "Cash",
    items: [PATCH], placedAt: "2025-03-10T15:00:00.000Z", ...extra });
  const order = (id) => d1.q("SELECT * FROM orders WHERE orderId = ?", id)[0];
  const lines = (id) => d1.q("SELECT * FROM order_items WHERE orderId = ? ORDER BY id", id);
  const orderCount = () => d1.q("SELECT count(*) AS n FROM orders")[0].n;
  // What an order's tax came to: [exempt?, the rate kept on the order, each line's rate, each line's tax in cents, total in cents].
  const taxOf = (id) => { const o = order(id), l = lines(id); return o ? [o.taxExempt, o.taxRateBps, l.map(x => x.taxRateBps), l.map(x => x.taxCents), o.totalCents] : null; };
  const UNTAXED = [1, 600, [0], [0], 10000], TAXED_INCLUSIVE = [0, 600, [600], [566], 10000];

  let r = await save({ name: "Pat Example", company: "Example Club", email: "pat@example.com", phone: "555-0100", taxExempt: true, taxExemptCertificate: "EX-0001" });
  const PAT = r.body.id;
  r = await save({ name: "Sam Sample", email: "sam@example.com" });
  const SAM = r.body.id;
  ok("the test's two customers exist: one exempt with no expiry, one not exempt", PAT > 0 && SAM > 0 && eq(exemptionOf(PAT), [1, "EX-0001", null]) && eq(exemptionOf(SAM), [0, "", null]));

  section("Only a PICKED customer's exemption counts");
  let mark = auditId();
  r = await sale({ customerId: PAT, customerName: "Pat Example", contact: "pat@example.com", placedAt: "2025-01-10T15:00:00.000Z" });
  const PICKED = r.body.orderId;
  ok("a local sale with the exempt customer picked is saved, linked to them", r.status === 200 && !!PICKED && order(PICKED).customerId === PAT);
  ok("…and is not taxed: the order is marked exempt, its line has no rate and no tax, and it still comes to $100.00", eq(taxOf(PICKED), UNTAXED));
  ok("…with today's rate (6%) still kept on the order itself", order(PICKED).taxRateBps === 600);
  ok("the sale's audit entry names the customer who was picked", auditSince(mark, "order.created_local_sale").length === 1 && auditSince(mark, "order.created_local_sale")[0].detail.customerId === PAT);

  mark = auditId();
  r = await sale({ customerName: "Pat Example", contact: "pat@example.com", placedAt: "2025-01-11T15:00:00.000Z" });
  const TYPED = r.body.orderId;
  ok("a local sale with only that customer's email typed is linked to them for the history", r.status === 200 && order(TYPED).customerId === PAT);
  ok("…but is taxed as usual: $5.66 of its $100.00 is sales tax", eq(taxOf(TYPED), TAXED_INCLUSIVE));
  ok("…and its audit entry names no picked customer", auditSince(mark, "order.created_local_sale").length === 1 && !("customerId" in auditSince(mark, "order.created_local_sale")[0].detail));
  r = await sale({ customerName: "Pat Example", contact: "  PAT@Example.COM ", placedAt: "2025-02-01T15:00:00.000Z" });
  ok("the same email typed in capitals: still linked, still taxed", order(r.body.orderId).customerId === PAT && eq(taxOf(r.body.orderId), TAXED_INCLUSIVE));

  r = await sale({ customerId: SAM, customerName: "Sam Sample", contact: "sam@example.com", placedAt: "2025-02-02T15:00:00.000Z" });
  ok("picking a customer who isn't exempt links the sale and taxes it", order(r.body.orderId).customerId === SAM && eq(taxOf(r.body.orderId), TAXED_INCLUSIVE));
  r = await sale({ customerId: PAT, customerName: "Sam Sample", contact: "sam@example.com", placedAt: "2025-02-03T15:00:00.000Z" });
  ok("the picked customer wins over the email typed: the sale is the exempt customer's, untaxed", order(r.body.orderId).customerId === PAT && eq(taxOf(r.body.orderId), UNTAXED));
  r = await sale({ customerId: String(PAT), placedAt: "2025-02-03T16:00:00.000Z" });
  ok("the id may arrive as text (a form sends it so): the same untaxed sale", r.status === 200 && order(r.body.orderId).customerId === PAT && eq(taxOf(r.body.orderId), UNTAXED));
  r = await sale({ customerId: PAT, customerName: "Pat Example", contact: "555-0100", placedAt: "2025-02-03T17:00:00.000Z" });
  ok("a picked customer needs no email on the sale: with a phone number as the contact it is still theirs and untaxed", order(r.body.orderId).customerId === PAT && eq(taxOf(r.body.orderId), UNTAXED));

  r = await call({ orderId: "WEB-1", orgId: "acme", customerName: "Pat Example", contact: "pat@example.com", paymentMethod: "Venmo", items: [{ productId: "polo", qty: 2 }], customerId: PAT },
    "https://acme.example.com/api/orders");
  ok("a storefront order with the exempt customer's email — even one that sends their id along — is linked to them", r.status === 200 && order("WEB-1").customerId === PAT);
  ok("…and taxed: 2 × $16.00 with $1.81 of sales tax inside", eq(taxOf("WEB-1"), [0, 600, [600], [181], 3200]));

  const imported = await lib.importOrdersCsv(d1, "acme", [
    { order: "A-1", row: 2, lines: [{ order: "A-1", date: "2025-02-08", customer: "Pat Example", email: "pat@example.com", sku: "", item: "Mug", size: "", qty: "1", price: "10.00", personalization: "", shipping: "0", paid: "yes", shipped: "" }] },
    { order: "A-2", row: 3, lines: [{ order: "A-2", date: "2025-02-08", customer: "Sam Sample", email: "sam@example.com", sku: "", item: "Mug", size: "", qty: "1", price: "10.00", personalization: "", shipping: "0", paid: "yes", shipped: "" }] },
  ]);
  const impPat = d1.q("SELECT * FROM orders WHERE externalOrderId = 'A-1'")[0], impSam = d1.q("SELECT * FROM orders WHERE externalOrderId = 'A-2'")[0];
  ok("an imported order with the exempt customer's email is linked to them", imported.created === 2 && !!impPat && impPat.customerId === PAT && impSam.customerId === SAM);
  ok("…and is handled exactly as the import of a customer who isn't exempt (the other store charged the tax, so none is added to either)",
    eq([impPat.taxExempt, impPat.taxRateBps, impPat.totalCents], [impSam.taxExempt, impSam.taxRateBps, impSam.totalCents]) && impSam.taxExempt === 1);

  section("A customer id that can't be used");
  r = await sale({ customerId: 99999, customerName: "Pat Example", contact: "pat@example.com", placedAt: "2025-02-04T15:00:00.000Z" });
  ok("an id that is no customer's is ignored: the sale is saved, linked by its email, and taxed", r.status === 200 && order(r.body.orderId).customerId === PAT && eq(taxOf(r.body.orderId), TAXED_INCLUSIVE));
  r = await sale({ customerId: 99999, placedAt: "2025-02-04T16:00:00.000Z" });
  ok("…and with no email on the sale it has no customer at all, and is taxed", r.status === 200 && order(r.body.orderId).customerId === null && eq(taxOf(r.body.orderId), TAXED_INCLUSIVE));
  // An exempt duplicate, merged into a customer who isn't exempt: its row keeps its tick, and must count for nothing.
  r = await save({ name: "Dee Duplicate", email: "dee@example.com", taxExempt: true, taxExemptCertificate: "EX-0002" });
  const DUP = r.body.id;
  r = await save({ name: "Dee Kept", phone: "555-0101" });
  const KEPT = r.body.id;
  r = await call({ action: "mergeCustomers", fromId: DUP, intoId: KEPT });
  ok("(an exempt duplicate is merged into a customer who isn't exempt; the kept one is not made exempt)", r.status === 200 && cust(DUP).mergedIntoId === KEPT && cust(DUP).taxExempt === 1 && cust(KEPT).taxExempt === 0);
  r = await sale({ customerId: DUP, customerName: "Dee Duplicate", contact: "dee@example.com", placedAt: "2025-02-05T15:00:00.000Z" });
  ok("picking the merged-away duplicate is ignored: the sale goes to the customer that was kept, by its email, and is taxed", r.status === 200 && order(r.body.orderId).customerId === KEPT && eq(taxOf(r.body.orderId), TAXED_INCLUSIVE));
  r = await call({ action: "setCustomerArchived", id: PAT, archived: true });
  r = await sale({ customerId: PAT, placedAt: "2025-02-06T15:00:00.000Z" });
  ok("an archived customer is still a customer: picked, their sale is theirs and untaxed", r.status === 200 && order(r.body.orderId).customerId === PAT && eq(taxOf(r.body.orderId), UNTAXED));
  await call({ action: "setCustomerArchived", id: PAT, archived: false });

  let before = orderCount(), refused = [];
  for (const bad of ["abc", 0, -3, 1.5, "2.5", true, [PAT], { id: PAT }]) {
    r = await sale({ customerId: bad });
    refused.push(r.status === 400 && r.body.message === "That customer isn't valid. Pick one from the list.");
  }
  ok("a customer id that isn't a whole number above zero (text, 0, −3, 1.5, true, a list, an object) is refused, each with the same sentence", refused.length === 8 && refused.every(Boolean));
  ok("…and no sale is made", orderCount() === before);
  r = await as("", () => sale({ customerId: PAT }));
  ok("a request nobody signed in to can't pick a customer for a sale (403, in plain words)", r.status === 403 && r.body.message === "Your role can't pick a customer for a sale. Ask an admin." && orderCount() === before);
  r = await as("production", () => sale({ customerId: PAT, placedAt: "2025-02-07T15:00:00.000Z" }));
  ok("a role that can only read Customers may pick one, and the exemption applies", r.status === 200 && eq(taxOf(r.body.orderId), UNTAXED));

  section("insertOrder itself");
  const item = (price = 100, extra = {}) => ({ productId: "", name: "Stitched patch", type: "custom", size: "", qty: 1, unitPrice: price, ...extra });
  const place = (orderId, extra = {}, opts = {}, items = [item()]) => lib.insertOrder(d1, { orderId, orgId: "acme", customerName: "Pat Example", contact: "pat@example.com", placedAt: "2025-04-01T12:00:00.000Z", ...extra }, items, opts);
  let res = await place("IO-PICK", {}, { customerId: PAT });
  ok("opts.customerId of an exempt customer: no tax, and the answer says so ($0.00 tax, $100.00 total)", eq(taxOf("IO-PICK"), UNTAXED) && res.salesTax === 0 && res.total === 100);
  res = await place("IO-EMAIL");
  ok("no opts.customerId: found by email, linked, taxed ($5.66)", order("IO-EMAIL").customerId === PAT && eq(taxOf("IO-EMAIL"), TAXED_INCLUSIVE) && res.salesTax === 5.66);
  res = await place("IO-SAM", {}, { customerId: SAM });
  ok("opts.customerId of a customer who isn't exempt: linked to them (not to the email's customer), taxed", order("IO-SAM").customerId === SAM && eq(taxOf("IO-SAM"), TAXED_INCLUSIVE));
  await place("IO-FLAG", { contact: "sam@example.com" }, { taxExempt: true });
  ok("opts.taxExempt (an import) still makes an order untaxed without any exempt customer", order("IO-FLAG").customerId === SAM && eq(taxOf("IO-FLAG"), UNTAXED));
  await place("IO-TEST", { isTest: true }, { customerId: PAT });
  ok("a test order with the exempt customer picked is theirs and untaxed like any other", order("IO-TEST").customerId === PAT && order("IO-TEST").isTest === 1 && eq(taxOf("IO-TEST"), UNTAXED));

  section("Both tax modes: the totals and the tax kept on the order and its lines");
  const two = [{ ...PATCH, qty: 3, customUnitPrice: 15.09 }, { ...PATCH, name: "Gift card", customUnitPrice: 20, taxable: false }];
  r = await sale({ customerId: PAT, items: two, placedAt: "2025-03-01T15:00:00.000Z" });
  let o = await lib.getOrderById(d1, r.body.orderId);
  ok("tax included in prices, exempt customer picked: 3 × $15.09 + $20.00 comes to $65.27 with no tax in it",
    eq(taxOf(r.body.orderId), [1, 600, [0, 0], [0, 0], 6527]) && o.taxMode === "inclusive" && o.taxExempt === true && o.salesTax === 0 && o.effectiveTotal === 65.27 && o.netSales === 65.27);
  r = await sale({ contact: "pat@example.com", items: two, placedAt: "2025-03-01T16:00:00.000Z" });
  o = await lib.getOrderById(d1, r.body.orderId);
  ok("tax included, the same goods for the same customer by email only: still $65.27, of which $2.56 is tax on the taxable line",
    eq(taxOf(r.body.orderId), [0, 600, [600, 0], [256, 0], 6527]) && o.taxExempt === false && o.salesTax === 2.56 && o.effectiveTotal === 65.27 && o.netSales === 62.71);

  await lib.setSalesTaxSettings(d1, { rateBps: 600, jurisdiction: "OH", taxMode: "exclusive" });
  r = await sale({ customerId: PAT, items: two, paid: true, placedAt: "2025-03-02T15:00:00.000Z" });
  o = await lib.getOrderById(d1, r.body.orderId);
  ok("tax added to prices, exempt customer picked: nothing is added — $65.27, no tax on any line",
    eq(taxOf(r.body.orderId), [1, 600, [0, 0], [0, 0], 6527]) && order(r.body.orderId).taxMode === "exclusive" && o.salesTax === 0 && o.effectiveTotal === 65.27);
  ok("…and marking that sale paid records exactly $65.27 received, nothing left owing", o.paid === true && o.amountReceived === 65.27 && o.balanceDue === 0);
  r = await sale({ contact: "pat@example.com", items: two, paid: true, placedAt: "2025-03-02T16:00:00.000Z" });
  o = await lib.getOrderById(d1, r.body.orderId);
  ok("tax added, by email only: $2.72 is added for the taxable line — $67.99",
    eq(taxOf(r.body.orderId), [0, 600, [600, 0], [272, 0], 6799]) && o.salesTax === 2.72 && o.effectiveTotal === 67.99 && o.amountReceived === 67.99);
  res = await place("IO-EXCL", {}, { customerId: PAT });
  ok("insertOrder's answer in that mode: exempt → $0.00 tax, $100.00 total", res.taxMode === "exclusive" && res.salesTax === 0 && res.total === 100 && eq(taxOf("IO-EXCL"), UNTAXED));
  res = await place("IO-EXCL-TAXED");
  ok("…and by email only → $6.00 tax, $106.00 total", res.salesTax === 6 && res.total === 106 && eq(taxOf("IO-EXCL-TAXED"), [0, 600, [600], [600], 10600]));
  await lib.setSalesTaxSettings(d1, { rateBps: 600, jurisdiction: "OH", taxMode: "inclusive" });

  section("The shop's exemption or the customer's");
  await lib.setOrgTaxExemption(d1, "league", { taxExempt: true, certificate: "EX-0009", expires: "" });
  r = await sale({ org: "league" });
  ok("an exempt shop, no customer: untaxed (as before customers existed)", r.status === 200 && order(r.body.orderId).customerId === null && eq(taxOf(r.body.orderId), UNTAXED));
  r = await sale({ org: "league", customerId: SAM });
  ok("an exempt shop, a picked customer who isn't exempt: untaxed", order(r.body.orderId).customerId === SAM && eq(taxOf(r.body.orderId), UNTAXED));
  r = await sale({ org: "league", customerId: PAT });
  ok("an exempt shop and an exempt customer: untaxed", eq(taxOf(r.body.orderId), UNTAXED));
  r = await sale({ org: "acme", customerId: PAT });
  ok("a shop that isn't exempt, an exempt customer picked: untaxed", eq(taxOf(r.body.orderId), UNTAXED));
  r = await sale({ org: "acme", customerId: SAM });
  ok("neither exempt: taxed", eq(taxOf(r.body.orderId), TAXED_INCLUSIVE));

  section("The certificate's expiry date");
  r = await save({ name: "Lee Limited", email: "lee@example.com", taxExempt: true, taxExemptCertificate: "EX-0003", taxExemptExpires: "2025-06-15" });
  const LEE = r.body.id;
  const leeAt = async (placedAt) => { const s = await sale({ customerId: LEE, placedAt }); return s.status === 200 && order(s.body.orderId).customerId === LEE ? taxOf(s.body.orderId) : null; };
  ok("with no Region time zone saved the day is UTC's: a sale the day before the expiry is untaxed", eq(await leeAt("2025-06-14T12:00:00.000Z"), UNTAXED));
  ok("…at 23:59 UTC on the expiry day it is still untaxed", eq(await leeAt("2025-06-15T23:59:00.000Z"), UNTAXED));
  ok("…at 00:01 UTC the next day it is taxed (and still linked to the customer)", eq(await leeAt("2025-06-16T00:01:00.000Z"), TAXED_INCLUSIVE));
  ok("…and long after, taxed", eq(await leeAt("2025-09-01T12:00:00.000Z"), TAXED_INCLUSIVE));
  ok("a sale dated with a bare date counts as that day: the expiry day untaxed, the next day taxed", eq(await leeAt("2025-06-15"), UNTAXED) && eq(await leeAt("2025-06-16"), TAXED_INCLUSIVE));

  await lib.setLocaleSettings(d1, { timeZone: "America/Chicago" });   // five hours behind UTC in June
  ok("Region set to America/Chicago: 04:59 UTC on the 16th is 23:59 on the 15th there — untaxed", eq(await leeAt("2025-06-16T04:59:00.000Z"), UNTAXED));
  ok("…and 05:01 UTC is 00:01 on the 16th there — taxed", eq(await leeAt("2025-06-16T05:01:00.000Z"), TAXED_INCLUSIVE));
  await lib.setLocaleSettings(d1, { timeZone: "Pacific/Auckland" });  // twelve hours ahead of UTC in June
  ok("Region set to Pacific/Auckland: 11:59 UTC on the 15th is 23:59 on the 15th there — untaxed", eq(await leeAt("2025-06-15T11:59:00.000Z"), UNTAXED));
  ok("…and 12:01 UTC on the 15th is already the 16th there — taxed, though it is still the expiry day in UTC", eq(await leeAt("2025-06-15T12:01:00.000Z"), TAXED_INCLUSIVE));
  await lib.setLocaleSettings(d1, { timeZone: "" });
  envExtra = { TIMEZONE: "Pacific/Auckland" };
  ok("no Region zone saved, the install's TIMEZONE variable set to Pacific/Auckland: that zone's day is used (12:01 UTC on the 15th is taxed)",
    eq(await leeAt("2025-06-15T12:01:00.000Z"), TAXED_INCLUSIVE) && eq(await leeAt("2025-06-15T11:59:00.000Z"), UNTAXED));
  await lib.setLocaleSettings(d1, { timeZone: "America/Chicago" });
  ok("the Region zone, once saved, wins over that variable (04:59 UTC on the 16th is untaxed)", eq(await leeAt("2025-06-16T04:59:00.000Z"), UNTAXED) && eq(await leeAt("2025-06-16T05:01:00.000Z"), TAXED_INCLUSIVE));
  envExtra = {};
  await place("IO-LEE-ON", { placedAt: "2025-06-16T04:59:00.000Z" }, { customerId: LEE });
  await place("IO-LEE-AFTER", { placedAt: "2025-06-16T05:01:00.000Z" }, { customerId: LEE });
  ok("insertOrder reads the Region zone itself: the same two moments, untaxed then taxed", eq(taxOf("IO-LEE-ON"), UNTAXED) && eq(taxOf("IO-LEE-AFTER"), TAXED_INCLUSIVE));
  await lib.setLocaleSettings(d1, { timeZone: "" });
  await place("IO-LEE-UTC-ON", { placedAt: "2025-06-15T23:59:00.000Z" }, { customerId: LEE });
  await place("IO-LEE-UTC-AFTER", { placedAt: "2025-06-16T00:01:00.000Z" }, { customerId: LEE });
  ok("…and with no zone anywhere it uses UTC's day", eq(taxOf("IO-LEE-UTC-ON"), UNTAXED) && eq(taxOf("IO-LEE-UTC-AFTER"), TAXED_INCLUSIVE));

  r = await sale({ customerId: PAT, placedAt: "2025-06-16T05:01:00.000Z" });
  ok("an exemption with no expiry date has no end: untaxed on that same later day", eq(taxOf(r.body.orderId), UNTAXED));
  r = await save({ id: LEE, taxExemptExpires: "" });
  ok("clearing the expiry date stores none", r.status === 200 && cust(LEE).taxExemptExpires === null && cust(LEE).taxExempt === 1);
  ok("…and the customer's sales after the old date are untaxed again", eq(await leeAt("2025-09-02T12:00:00.000Z"), UNTAXED));
  // An order with no date of its own is placed now: only dates that are past or to come whatever today is.
  await save({ id: LEE, taxExemptExpires: "2020-01-01" });
  await place("IO-NODATE-PAST", { placedAt: undefined }, { customerId: LEE });
  ok("an order with no date of its own counts as placed now: a certificate that ran out in 2020 no longer covers it", eq(taxOf("IO-NODATE-PAST"), TAXED_INCLUSIVE));
  await save({ id: LEE, taxExemptExpires: "2999-12-31" });
  await place("IO-NODATE-FUTURE", { placedAt: undefined }, { customerId: LEE });
  ok("…and one good until 2999 does", eq(taxOf("IO-NODATE-FUTURE"), UNTAXED));
  d1._raw.run("UPDATE customers SET taxExempt = 0 WHERE id = ?", [LEE]);
  ok("an expiry date in the future means nothing when the exempt box isn't ticked: taxed", eq(await leeAt("2025-06-14T12:00:00.000Z"), TAXED_INCLUSIVE));

  section("Unticking the exemption later leaves old orders alone");
  const snapshot = () => JSON.stringify([order(PICKED), lines(PICKED), order(TYPED), lines(TYPED)]);
  const was = snapshot();
  r = await save({ id: PAT, taxExempt: false });
  ok("the exemption is unticked", r.status === 200 && cust(PAT).taxExempt === 0);
  ok("the order placed while they were exempt is unchanged: still exempt, still no tax", snapshot() === was && eq(taxOf(PICKED), UNTAXED));
  o = await lib.getOrderById(d1, PICKED);
  ok("…and reads back so: exempt, $0.00 tax, $100.00", o.taxExempt === true && o.salesTax === 0 && o.effectiveTotal === 100 && o.customerId === PAT);
  r = await sale({ customerId: PAT, placedAt: "2025-03-20T15:00:00.000Z" });
  ok("a new sale with the customer picked is now taxed", eq(taxOf(r.body.orderId), TAXED_INCLUSIVE));
  const taxedLater = r.body.orderId, wasTaxed = JSON.stringify([order(taxedLater), lines(taxedLater)]);
  r = await save({ id: PAT, taxExempt: true });
  ok("ticking it again doesn't untax the sale made in between", cust(PAT).taxExempt === 1 && JSON.stringify([order(taxedLater), lines(taxedLater)]) === wasTaxed);
  r = await sale({ customerId: PAT, placedAt: "2025-03-21T15:00:00.000Z" });
  ok("…and the next picked sale is untaxed again", eq(taxOf(r.body.orderId), UNTAXED));

  section("The sales tax report");
  // January 2025 holds exactly two orders: PICKED (the exempt customer picked) and TYPED (their email only).
  r = await call({ action: "getSalesTaxReport", dateFrom: "2025-01-01", dateTo: "2025-01-31" });
  const exemptRows = r.body.rows.filter(x => x.exempt), taxedRows = r.body.rows.filter(x => !x.exempt);
  ok("the picked customer's order is counted as an exempt sale: 1 order, $100.00, no tax collected",
    r.status === 200 && exemptRows.length === 1 && exemptRows[0].month === "2025-01" && exemptRows[0].orders === 1 && exemptRows[0].grossSales === 100 && exemptRows[0].netSales === 100 && exemptRows[0].taxCollected === 0);
  ok("the order with only their email is counted as a taxed sale: 1 order, $5.66 collected on $94.34",
    taxedRows.length === 1 && taxedRows[0].orders === 1 && taxedRows[0].taxCollected === 5.66 && taxedRows[0].netSales === 94.34);
  ok("the month's totals: 2 orders, $100.00 of exempt sales, $5.66 of tax", r.body.totals.orders === 2 && r.body.totals.exemptSales === 100 && r.body.totals.taxCollected === 5.66);
  const direct = await lib.getSalesTaxReport(d1, "2025-01-01T00:00:00.000Z", "2025-01-31T23:59:59.999Z");
  ok("db.js's own report says the same", eq(direct.map(x => [x.month, x.exempt, x.orders, x.taxCollected]), [["2025-01", false, 1, 5.66], ["2025-01", true, 1, 0]]));

  // ================================================================================================================
  section("saveCustomer: who may change an exemption");
  ok("the role tables: Back office may save a customer, Production may not, and only Manager and Admin have Customers at Full",
    may("staff", "saveCustomer") && !may("production", "saveCustomer") && may("manager", "mergeCustomers") && !may("staff", "mergeCustomers"));
  const count = () => d1.q("SELECT count(*) AS n FROM customers")[0].n;
  const NO_EXEMPTION = "Your role can't change a customer's tax exemption. Ask an admin.";

  before = count(); mark = auditId();
  r = await as("staff", () => save({ name: "Kit Counter", email: "kit@example.com", phone: "555-0102" }));
  const KIT = r.body.id;
  ok("Back office adds a customer with no exemption", r.status === 200 && r.body.created === true && count() === before + 1 && eq(exemptionOf(KIT), [0, "", null]));
  ok("…which writes customer.created and no exemption entry", auditSince(mark, "customer.created").length === 1 && auditSince(mark, "customer.exemption_changed").length === 0);
  r = await as("staff", () => save({ name: "Blank Exemption", taxExempt: false, taxExemptCertificate: "", taxExemptExpires: "" }));
  ok("Back office adds one sending the exemption fields blank (as the page does): not an exemption change", r.status === 200 && auditSince(mark, "customer.exemption_changed").length === 0 && eq(exemptionOf(r.body.id), [0, "", null]));
  r = await as("staff", () => save({ name: "Blank Exemption Two", taxExempt: null, taxExemptCertificate: null, taxExemptExpires: null }));
  ok("…or sending them empty (null)", r.status === 200 && auditSince(mark, "customer.exemption_changed").length === 0 && eq(exemptionOf(r.body.id), [0, "", null]));

  before = count(); mark = auditId();
  const tries = [];
  for (const f of [{ taxExempt: true }, { taxExempt: 1 }, { taxExemptCertificate: "EX-0004" }, { taxExemptExpires: "2030-01-01" }]) {
    r = await as("staff", () => save({ name: "Not Allowed", email: "no@example.com", ...f }));
    tries.push(r.status === 403 && r.body.message === NO_EXEMPTION && r.body.code === "forbidden");
  }
  ok("Back office can't ADD a customer with an exemption — ticked, or only a certificate, or only an expiry date (403 each)", tries.length === 4 && tries.every(Boolean));
  ok("…no customer is added and nothing is written to the audit log", count() === before && auditSince(mark).length === 0);

  // An exempt customer for Back office to edit.
  r = await save({ name: "Robin Record", company: "Example Guild", email: "robin@example.com", taxExempt: true, taxExemptCertificate: "EX-0005", taxExemptExpires: "2030-01-01" });
  const ROBIN = r.body.id;
  mark = auditId();
  r = await as("staff", () => save({ id: ROBIN, name: "Robin Record", company: "Example Guild", email: "robin@example.com", phone: "555-0103", notes: "Prefers pickup",
    taxExempt: true, taxExemptCertificate: "EX-0005", taxExemptExpires: "2030-01-01" }));
  ok("a Back office save that sends the stored exemption back with other changes is fine", r.status === 200 && r.body.created === false && cust(ROBIN).phone === "555-0103" && cust(ROBIN).notes === "Prefers pickup");
  ok("…the exemption is as it was", eq(exemptionOf(ROBIN), [1, "EX-0005", "2030-01-01"]));
  let ups = auditSince(mark, "customer.updated");
  ok("…and the log has one customer.updated naming the phone and the notes, and no exemption entry",
    ups.length === 1 && ups[0].detail.customerId === ROBIN && eq(Object.keys(ups[0].detail.changes).sort(), ["notes", "phone"]) &&
    eq(ups[0].detail.changes.phone, { from: "", to: "555-0103" }) && auditSince(mark, "customer.exemption_changed").length === 0);
  mark = auditId();
  r = await as("staff", () => save({ id: ROBIN, taxExempt: 1, taxExemptCertificate: "  EX-0005  ", taxExemptExpires: " 2030-01-01 " }));
  ok("the stored values sent as 1 for the tick and with spaces around the text are still the stored values", r.status === 200 && eq(exemptionOf(ROBIN), [1, "EX-0005", "2030-01-01"]) && auditSince(mark).length === 0);
  r = await as("staff", () => save({ id: ROBIN, phone: "555-0104" }));
  ok("a Back office save that leaves the exemption fields out keeps the exemption", r.status === 200 && cust(ROBIN).phone === "555-0104" && eq(exemptionOf(ROBIN), [1, "EX-0005", "2030-01-01"]));

  const robinWas = JSON.stringify(cust(ROBIN));
  mark = auditId(); tries.length = 0;
  for (const f of [{ taxExempt: false }, { taxExemptCertificate: "EX-9999" }, { taxExemptCertificate: "" }, { taxExemptExpires: "2031-01-01" }, { taxExemptExpires: "" }, { taxExemptExpires: null }]) {
    r = await as("staff", () => save({ id: ROBIN, name: "Renamed By Staff", phone: "555-0199", taxExempt: true, taxExemptCertificate: "EX-0005", taxExemptExpires: "2030-01-01", ...f }));
    tries.push(r.status === 403 && r.body.message === NO_EXEMPTION);
  }
  ok("a Back office save that changes the tick, the certificate or the expiry date (to another value, or to nothing) is refused (403 each)", tries.length === 6 && tries.every(Boolean));
  ok("…and nothing of it is saved — not the name or the phone sent with it either — and nothing is logged", JSON.stringify(cust(ROBIN)) === robinWas && auditSince(mark).length === 0);
  for (const role of ["production", ""]) {
    r = await as(role, () => save({ id: ROBIN, taxExempt: false }));
    tries.push(r.status === 403 && JSON.stringify(cust(ROBIN)) === robinWas);
  }
  ok("the same for a role that can only read Customers, and for a request nobody signed in to", tries.length === 8 && tries.slice(6).every(Boolean));

  r = await save({ name: "Morgan Managed", email: "morgan@example.com" });
  const MORGAN = r.body.id;
  mark = auditId();
  r = await as("manager", () => save({ id: MORGAN, taxExempt: true, taxExemptCertificate: "EX-0006", taxExemptExpires: "2031-03-31" }));
  ok("a Manager (Customers at Full) changes an exemption", r.status === 200 && eq(exemptionOf(MORGAN), [1, "EX-0006", "2031-03-31"]));
  let ex = auditSince(mark, "customer.exemption_changed");
  ok("…and the log has customer.exemption_changed with each field's old and new value, the customer's id and name",
    ex.length === 1 && ex[0].detail.customerId === MORGAN && ex[0].detail.name === "Morgan Managed" && ex[0].orderId === null &&
    eq(ex[0].detail.changes, { taxExempt: { from: false, to: true }, taxExemptCertificate: { from: "", to: "EX-0006" }, taxExemptExpires: { from: null, to: "2031-03-31" } }));
  ok("…and no customer.updated, because nothing else changed", auditSince(mark, "customer.updated").length === 0 && auditSince(mark).length === 1);

  mark = auditId();
  r = await save({ id: MORGAN, taxExemptCertificate: "EX-0007" });
  ex = auditSince(mark, "customer.exemption_changed");
  ok("changing the certificate alone logs only the certificate", r.status === 200 && ex.length === 1 && eq(ex[0].detail.changes, { taxExemptCertificate: { from: "EX-0006", to: "EX-0007" } }) && eq(exemptionOf(MORGAN), [1, "EX-0007", "2031-03-31"]));
  mark = auditId();
  r = await save({ id: MORGAN, taxExemptExpires: null });
  ex = auditSince(mark, "customer.exemption_changed");
  ok("clearing the expiry alone logs only the expiry, to none", r.status === 200 && ex.length === 1 && eq(ex[0].detail.changes, { taxExemptExpires: { from: "2031-03-31", to: null } }) && eq(exemptionOf(MORGAN), [1, "EX-0007", null]));
  mark = auditId();
  r = await save({ id: MORGAN, name: "Morgan Renamed", taxExempt: false });
  ex = auditSince(mark, "customer.exemption_changed"); ups = auditSince(mark, "customer.updated");
  ok("a save that changes the name and the tick writes both entries, the exemption's first", r.status === 200 && cust(MORGAN).name === "Morgan Renamed" && cust(MORGAN).taxExempt === 0 &&
    eq(auditSince(mark).map(a => a.action), ["customer.exemption_changed", "customer.updated"]) && eq(ex[0].detail.changes, { taxExempt: { from: true, to: false } }));
  ok("…and customer.updated names the name only, never the exemption fields", eq(ups[0].detail.changes, { name: { from: "Morgan Managed", to: "Morgan Renamed" } }));
  ok("…while the exemption entry carries the name as it will be", ex[0].detail.name === "Morgan Renamed");
  mark = auditId();
  r = await save({ id: MORGAN, name: "Morgan Renamed", taxExempt: false, taxExemptCertificate: "EX-0007", taxExemptExpires: "" });
  ok("an Admin's save that changes nothing at all logs nothing", r.status === 200 && auditSince(mark).length === 0);
  r = await save({ id: MORGAN, taxExemptCertificate: "C".repeat(250) });
  ok("a certificate number is kept to 200 characters", r.status === 200 && cust(MORGAN).taxExemptCertificate === "C".repeat(200));

  section("saveCustomer: adding a customer with an exemption");
  mark = auditId();
  r = await save({ name: "Avery Added", company: "Example Society", email: "avery@example.com", taxExempt: true, taxExemptCertificate: "EX-0008", taxExemptExpires: "2032-02-29" });
  const AVERY = r.body.id;
  ok("an Admin adds a customer already exempt, with a certificate and a leap-day expiry", r.status === 200 && r.body.created === true && eq(exemptionOf(AVERY), [1, "EX-0008", "2032-02-29"]));
  ex = auditSince(mark, "customer.exemption_changed");
  ok("the exemption entry is written before the customer has an id: no id, the name and company, every field from blank",
    ex.length === 1 && ex[0].detail.customerId === null && ex[0].detail.name === "Avery Added" && ex[0].detail.company === "Example Society" &&
    eq(ex[0].detail.changes, { taxExempt: { from: false, to: true }, taxExemptCertificate: { from: "", to: "EX-0008" }, taxExemptExpires: { from: null, to: "2032-02-29" } }));
  const made = auditSince(mark, "customer.created");
  ok("…then customer.created, with the new id and saying they are exempt", eq(auditSince(mark).map(a => a.action), ["customer.exemption_changed", "customer.created"]) && made[0].detail.customerId === AVERY && made[0].detail.taxExempt === true);
  mark = auditId();
  r = await save({ name: "Plain Added" });
  ok("customer.created for a customer who isn't exempt doesn't mention an exemption", r.status === 200 && auditSince(mark).length === 1 && !("taxExempt" in auditSince(mark, "customer.created")[0].detail));
  r = await sale({ customerId: AVERY, placedAt: "2025-03-22T15:00:00.000Z" });
  ok("a sale with the newly added exempt customer picked is untaxed", eq(taxOf(r.body.orderId), UNTAXED));

  section("saveCustomer: the tick counts only as true or 1");
  mark = auditId(); tries.length = 0;
  for (const v of ["true", "1", "yes", "on", 2, -1, {}, [1]]) {
    r = await save({ name: "Odd Tick", taxExempt: v });
    tries.push(r.status === 200 && cust(r.body.id).taxExempt === 0);
  }
  ok('added with the tick sent as "true", "1", "yes", "on", 2, −1, an object or a list: not exempt', tries.length === 8 && tries.every(Boolean));
  ok("…and none of those is logged as an exemption change", auditSince(mark, "customer.exemption_changed").length === 0 && auditSince(mark, "customer.created").length === 8);
  r = await save({ name: "Tick One", taxExempt: 1 });
  ok("added with the tick sent as 1: exempt", r.status === 200 && cust(r.body.id).taxExempt === 1);
  r = await save({ name: "Tick True", taxExempt: true });
  ok("added with the tick sent as true: exempt", r.status === 200 && cust(r.body.id).taxExempt === 1);

  section("saveCustomer: the expiry must be a real calendar date");
  const BAD_DATE = "The exemption's expiry date isn't a valid date.";
  before = count(); mark = auditId(); tries.length = 0;
  for (const d of ["2027-02-31", "2027-02-29", "2027-04-31", "2027-13-01", "2027-00-10", "2027-01-00", "2027-1-5", "01/05/2027", "next year", "2027-01-05T00:00:00Z"]) {
    r = await save({ name: "Bad Date", taxExempt: true, taxExemptExpires: d });
    tries.push(r.status === 400 && r.body.message === BAD_DATE);
  }
  ok("2027-02-31, 2027-02-29 (no leap day that year), 2027-04-31, month 13, month 0, day 0, 2027-1-5, 01/05/2027, words and a date with a time are each refused with a plain sentence", tries.length === 10 && tries.every(Boolean));
  ok("…no customer is added and nothing is logged", count() === before && auditSince(mark).length === 0);
  const averyWas = JSON.stringify(cust(AVERY));
  r = await save({ id: AVERY, name: "Avery Changed", taxExemptExpires: "2027-02-31" });
  ok("the same on a change: refused, and the name sent with it isn't saved", r.status === 400 && r.body.message === BAD_DATE && JSON.stringify(cust(AVERY)) === averyWas && auditSince(mark).length === 0);
  r = await as("staff", () => save({ id: AVERY, taxExemptExpires: "2027-02-31" }));
  ok("Back office is told the date is wrong, too (the date is checked first)", r.status === 400 && r.body.message === BAD_DATE);
  r = await save({ id: AVERY, taxExemptExpires: "2028-02-29" });
  ok("a real leap day is accepted", r.status === 200 && cust(AVERY).taxExemptExpires === "2028-02-29");
  r = await save({ id: AVERY, taxExemptExpires: "2027-12-31" });
  ok("…and the last day of a year", r.status === 200 && cust(AVERY).taxExemptExpires === "2027-12-31");

  section("saveCustomer: the audit entry comes first, or nothing is saved");
  r = await save({ name: "Quinn Queued", email: "quinn@example.com" });
  const QUINN = r.body.id;
  seen.length = 0;
  r = await save({ id: QUINN, taxExempt: true, taxExemptCertificate: "EX-0010" });
  const auditAt = seen.findIndex(s => /INSERT INTO audit_log/.test(s)), writeAt = seen.findIndex(s => /UPDATE customers SET/.test(s));
  ok("customer.exemption_changed is written to the audit log before the customer's row is changed", r.status === 200 && auditAt >= 0 && writeAt > auditAt);
  seen.length = 0;
  r = await save({ name: "Ordered Add", taxExempt: true });
  ok("…and before a new customer's row is added", r.status === 200 && seen.findIndex(s => /INSERT INTO audit_log/.test(s)) >= 0 && seen.findIndex(s => /INSERT INTO customers/.test(s)) > seen.findIndex(s => /INSERT INTO audit_log/.test(s)));

  const quinnWas = JSON.stringify(cust(QUINN));
  before = count(); mark = auditId();
  auditBroken = true;
  r = await quietly(() => save({ id: QUINN, name: "Quinn Changed", taxExempt: false }));
  ok("when the audit log can't be written, a change of exemption answers 503 and says nothing was changed", r.status === 503 && r.body.status === "error" && /nothing was changed/.test(r.body.message));
  ok("…and nothing was: the customer's row is the same, name and all", JSON.stringify(cust(QUINN)) === quinnWas);
  r = await quietly(() => save({ name: "Never Added", taxExempt: true, taxExemptCertificate: "EX-0011" }));
  ok("…and adding a customer with an exemption answers 503 and adds nobody", r.status === 503 && count() === before);
  r = await quietly(() => save({ id: QUINN, phone: "555-0105" }));
  ok("a save that doesn't touch the exemption isn't held up by the audit log: it is saved", r.status === 200 && cust(QUINN).phone === "555-0105" && cust(QUINN).taxExempt === 1);
  auditBroken = false;
  ok("(nothing reached the audit log while it couldn't be written)", auditSince(mark).length === 0);
  r = await save({ id: QUINN, taxExempt: false });
  ok("once the log can be written again the same change goes through", r.status === 200 && cust(QUINN).taxExempt === 0 && auditSince(mark, "customer.exemption_changed").length === 1);

  section("saveCustomer: an exemption change the save then refuses");
  const quinnNow = JSON.stringify(cust(QUINN));
  mark = auditId();
  r = await save({ id: QUINN, email: "robin@example.com", taxExempt: true });
  ok("a change of exemption sent with another customer's email is refused (400) with the reason", r.status === 400 && r.body.message === "Another customer already has that email.");
  ok("…nothing is saved", JSON.stringify(cust(QUINN)) === quinnNow);
  let log = auditSince(mark);
  ok("…and the log, which already said the exemption changed, says straight after that it did not, and why",
    eq(log.map(a => a.action), ["customer.exemption_changed", "customer.exemption_not_changed"]) && log[1].detail.customerId === QUINN &&
    log[1].detail.name === "Quinn Queued" && log[1].detail.reason === "Another customer already has that email.");
  before = count(); mark = auditId();
  r = await save({ name: "Bad Email", email: "not an email", taxExempt: true, taxExemptCertificate: "EX-0012" });
  log = auditSince(mark);
  ok("the same when adding: an exempt customer with a bad email isn't added, and both entries are written (no id yet)", r.status === 400 && r.body.message === "That doesn't look like an email address." && count() === before &&
    eq(log.map(a => a.action), ["customer.exemption_changed", "customer.exemption_not_changed"]) && log[1].detail.customerId === null && log[1].detail.reason === "That doesn't look like an email address.");
  mark = auditId();
  r = await save({ id: QUINN, email: "robin@example.com" });
  ok("a refused save that didn't touch the exemption writes neither entry", r.status === 400 && auditSince(mark).length === 0);
  mark = auditId();
  r = await save({ name: "", company: "  ", taxExempt: true });
  ok("a save with no name or company is refused before anything is logged, exemption or not", r.status === 400 && r.body.message === "Enter a name or a company." && auditSince(mark).length === 0);

  section("saveCustomer: a customer that can't be changed");
  mark = auditId();
  r = await save({ id: 99999, name: "Nobody", taxExempt: true });
  ok("an id that is no customer's: 404, nothing logged", r.status === 404 && r.body.message === "Customer not found" && auditSince(mark).length === 0);
  r = await save({ id: DUP, taxExempt: false });
  ok("a customer merged into another: refused (400), its row and the log untouched", r.status === 400 && /merged into another/.test(r.body.message) && cust(DUP).taxExempt === 1 && auditSince(mark).length === 0);

  section("Before the customers table exists (migrations/0105 not yet run)");
  const old = await newDb("0105");
  await lib.setSalesTaxSettings(old, { rateBps: 600, jurisdiction: "OH", taxMode: "inclusive" });
  const oldTax = (id) => { const x = old.q("SELECT taxExempt, totalCents FROM orders WHERE orderId = ?", id)[0], l = old.q("SELECT taxCents FROM order_items WHERE orderId = ?", id); return x ? [x.taxExempt, l.map(y => y.taxCents), x.totalCents] : null; };
  ok("(that database has no customers table and no orders.customerId)", old.q("SELECT count(*) AS n FROM sqlite_master WHERE name = 'customers'")[0].n === 0 && !old.q("PRAGMA table_info(orders)").some(c => c.name === "customerId"));
  res = await lib.insertOrder(old, { orderId: "OLD-1", orgId: "acme", customerName: "Pat Example", contact: "pat@example.com", placedAt: "2025-04-01T12:00:00.000Z" }, [item()], { customerId: 1 });
  ok("insertOrder with a picked customer still takes the order, taxed as usual", eq(oldTax("OLD-1"), [0, [566], 10000]) && res.salesTax === 5.66);
  r = await callOn(dbOf(old), { action: "createLocalSale", org: "acme", customerName: "Pat Example", contact: "pat@example.com", items: [PATCH], placedAt: "2025-03-10T15:00:00.000Z", customerId: 1 });
  ok("a local sale that names a customer is saved, taxed as usual", r.status === 200 && eq(oldTax(r.body.orderId), [0, [566], 10000]));
  await lib.setOrgTaxExemption(old, "league", { taxExempt: true, certificate: "EX-0009", expires: "" });
  r = await callOn(dbOf(old), { action: "createLocalSale", org: "league", items: [PATCH], placedAt: "2025-03-10T15:00:00.000Z", customerId: 1 });
  ok("…and the shop's own exemption still works there", r.status === 200 && eq(oldTax(r.body.orderId), [1, [0], 10000]));
  r = await callOn(dbOf(old), { action: "saveCustomer", name: "Too Early", taxExempt: true });
  ok("saving a customer there answers 503 in plain words, not a database error", r.status === 503 && /Customers aren't ready yet/.test(r.body.message));

  const { passed, failed } = require("./testlib/check").counts();
  console.log(`\n${passed} checks passed, ${failed} failed.`);
})().catch((e) => { console.error(e); process.exit(1); });
