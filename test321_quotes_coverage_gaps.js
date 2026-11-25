const fs = require("fs");
const { ok } = require("./testlib/check");
const { createD1 } = require("./testlib/d1-shim.js");
const { MAIL_ENV, MAIL_OK, captureMail } = require("./testlib/mail-mock");
const { ADMIN_ORIGIN } = require("./testlib/hosts.js");

// Quotes and quantity breaks (migrations/0109): the branches the other quote tests (312–320) never took — a database a
// migration behind, a database error that isn't "no such table", records missing what they usually have (a customer
// with no name, a shop with no name, subdomain or accent, a fee with no kind), a quote that can't be loaded again
// mid-request, an order made twice at once, and the invoice email that fails. Real SQL (sql.js) under the real db.js,
// orders.js, email.js and estimate.js. Invented data only.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");

const mail = [];
global.fetch = async (url, init) => {
  if (captureMail(url, init, mail)) return MAIL_OK;
  throw new Error("unexpected fetch " + url);
};

const M = new Function(
  strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  strip(read("functions/_lib/db.js")) + "\n" + strip(read("functions/_lib/email.js")) + "\n" + strip(read("functions/_lib/quoteToken.js")) + "\n" +
  strip(read("functions/_lib/boxSize.js")) + "\n" + strip(read("functions/_lib/permissions.js")) + "\n" + strip(read("functions/_lib/digital.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => globalThis.__actor321 === undefined ? 'olive@example.test' : globalThis.__actor321;\n" +
  require("./testlib/roles").adminAs() + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: { club: 'club' }, orgs: {}, features: {} });\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({});\n" +
  "const ordersMod = (function(){\n" + strip(read("functions/api/orders.js")) + "\nreturn { onRequestPost, convertEstimateToOrder_ }; })();\n" +
  "const convertEstimateToOrder_ = (...a) => globalThis.__convert321 ? globalThis.__convert321(...a) : ordersMod.convertEstimateToOrder_(...a);\n" +
  "const estimateApi = (function(){\n" + strip(read("functions/api/estimate.js")) + "\nreturn { onRequestGet, onRequestPost }; })();\n" +
  "return { ordersApi: ordersMod.onRequestPost, convert: ordersMod.convertEstimateToOrder_, estimateApi, getEstimate, getOrderById, getOrdersForOrg: typeof getOrders === 'function' ? getOrders : null, " +
  "setLocaleSettings, createProduct, updateProduct, createBlank, setBlankLink, analyzePricing, mergeCustomers, listEstimates, createEstimate, setEstimateFields, " +
  "saveEstimateItems, estimateLinesView };")();
const clientQtyBreaks = new Function(strip(read("functions/api/catalog.js")) + "\nreturn clientQtyBreaks_;")();

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const migrations = fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort();
const newDb = async (before) => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of migrations) if (!before || f < before) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, accent, createdAt, updatedAt, ready, shippingEnabled) VALUES ('club','club','Example Club','#1E7A4C','t','t',1,1);`);
  return d1;
};
// A database whose prepare() throws `message` for SQL matching `re` (while `when()` says so).
const failing = (d1, re, message, when = () => true) => {
  const db = Object.create(d1);
  db.prepare = (sql) => { if (re.test(sql) && when()) throw new Error(message); return d1.prepare(sql); };
  return db;
};
// Errors the product logs on purpose are kept, not printed.
const logged = [];
const realError = console.error;
const quietly = async (fn) => { console.error = (...a) => logged.push(a.map(String).join(" ")); try { return await fn(); } finally { console.error = realError; } };
const rejects = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

(async () => {
  const d1 = await newDb();
  const env = { DB: d1, SIGNING_SECRET: "s".repeat(40), ...MAIL_ENV };
  await M.setLocaleSettings(d1, { timeZone: "America/Chicago" });
  d1._raw.run("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('salesTax', ?)", [JSON.stringify({ rateBps: 600, taxShipping: false, jurisdiction: "", taxMode: "exclusive" })]);
  const callWith = async (e, body) => {
    const waits = [];
    const res = await M.ordersApi({ env: e, waitUntil: (p) => waits.push(Promise.resolve(p).catch(() => {})),
      request: { url: ADMIN_ORIGIN + "/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    await Promise.all(waits);
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const admin = (body) => callWith(env, body);
  const hdrs = (ip) => ({ get: (k) => (/cf-connecting-ip/i.test(k) ? ip : null) });
  const get = async (token, e) => {
    const res = await M.estimateApi.onRequestGet({ env: e || env, request: { url: "https://club.example.com/api/estimate?token=" + token, headers: hdrs("198.51.100.1") } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const post = async (body, e, ip = "198.51.100.2") => {
    const res = await M.estimateApi.onRequestPost({ env: e || env, request: { url: "https://club.example.com/api/estimate", headers: hdrs(ip), json: async () => body } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const tokenOf = (link) => (/[?&]estimate=([a-z0-9]+)$/.exec(String(link || "")) || [])[1] || "";
  const orderRow = (orderId) => d1.q("SELECT * FROM orders WHERE orderId = ?", orderId)[0] || null;
  const rawCustomer = (name, company, email) => { d1._raw.run("INSERT INTO customers (name, company, email, createdAt, updatedAt) VALUES (?, ?, ?, 't', 't')", [name, company, email]);
    return d1.q("SELECT max(id) AS id FROM customers")[0].id; };

  const pat = (await admin({ action: "saveCustomer", name: "Pat Example", email: "pat@example.com", phone: "555-0101" })).body.id;
  const nameless = rawCustomer("", "", "nameless@example.com");
  await admin({ action: "createProduct", org: "club", productId: "tee", type: "shirt", name: "Club Tee", pricingMode: "sized", sizePricing: { S: 20, M: 22 },
    visible: true, noDesignNeeded: true, qtyBreaks: [{ minQty: 12, off: 2 }] });
  ok("the test's own data: a shop, a customer, one with neither a name nor a company (as an old record can be), a tee with a break",
    Number.isInteger(pat) && Number.isInteger(nameless) && d1.q("SELECT count(*) n FROM products")[0].n === 1);
  const quote = async ({ customerId = pat, items, send = true, org = "club" } = {}) => {
    const c = await admin({ action: "createEstimate", org, customerId, title: "Team order", expiresOn: "2099-12-31" });
    await admin({ action: "saveEstimate", id: c.body.id, items: items || [{ kind: "custom", name: "Club banner", qty: 2, unitPrice: 25, taxable: true }] });
    const s = send ? await admin({ action: "sendEstimate", id: c.body.id }) : null;
    return { id: c.body.id, number: c.body.number, token: s ? tokenOf(s.body.link) : "", send: s };
  };
  let r;

  // ============================================================================================================
  console.log("=== A database before 0109 ===");
  {
    const old = await newDb("0109");
    const oldEnv = { DB: old, SIGNING_SECRET: "s".repeat(40) };
    const a = (await callWith(oldEnv, { action: "saveCustomer", name: "Lee Example", email: "lee@example.com", phone: "555-0102" })).body.id;
    const b = (await callWith(oldEnv, { action: "saveCustomer", name: "Lee Example", email: "lee2@example.com", phone: "555-0103" })).body.id;
    r = await M.mergeCustomers(old, { fromId: b, intoId: a });
    ok("merging customers works without the quotes table (no quotes to move)", r && !r.error && old.q("SELECT mergedIntoId FROM customers WHERE id = ?", b)[0].mergedIntoId === a);
    const sale = await callWith(oldEnv, { action: "createLocalSale", org: "club", customerName: "Lee Example", contact: "lee@example.com", paymentMethod: "Check",
      items: [{ productId: "__custom__", name: "Banner", type: "custom", qty: 1, customUnitPrice: 10, taxable: true }] });
    const o = await M.getOrderById(old, sale.body.orderId);
    ok("an order reads back with no quote (estimate null), and the shop's order list too", sale.status === 200 && o && o.estimate === null &&
      ((await callWith(oldEnv, { action: "getOrders", org: "club" })).body.orders || []).some(x => x.orderId === sale.body.orderId && x.estimate === null));
  }

  console.log("=== A database error that isn't a missing table is not swallowed ===");
  {
    const a = (await admin({ action: "saveCustomer", name: "Kit Example", email: "kit@example.com" })).body.id;
    const b = (await admin({ action: "saveCustomer", name: "Kit Example", email: "kit2@example.com" })).body.id;
    const q = await quote({ customerId: b, send: false });
    r = await M.mergeCustomers(d1, { fromId: b, intoId: a });
    ok("merging customers moves the duplicate's quotes", r && !r.error && d1.q("SELECT customerId FROM estimates WHERE id = ?", q.id)[0].customerId === a);
    let e = await rejects(() => M.mergeCustomers(failing(d1, /^SELECT 1 FROM estimates/, "disk I/O error"), { fromId: a, intoId: pat }));
    ok("…a broken quotes table stops a merge, rather than leaving the quotes behind", !!e && /disk I\/O/.test(e.message) && d1.q("SELECT mergedIntoId FROM customers WHERE id = ?", a)[0].mergedIntoId === null);
    e = await rejects(() => M.listEstimates(failing(d1, /FROM estimates e/, "disk I/O error"), {}));
    ok("listEstimates passes on other errors", !!e && /disk I\/O/.test(e.message));
    r = await M.listEstimates(failing(d1, /FROM estimates e/, "no such table: customers"), {});
    ok("…and answers an empty list before the customers table exists", same(r, { estimates: [], total: 0 }));
    r = await M.listEstimates(d1, { q: null });
    ok("a search of null is no search", r.total >= 1);
    e = await rejects(() => M.createEstimate(failing(d1, /FROM customers/, "disk I/O error"), { orgId: "club", customerId: pat }));
    ok("createEstimate passes on other errors reading the customer", !!e && /disk I\/O/.test(e.message));
    const runFails = Object.create(d1);
    runFails.prepare = (sql) => /^UPDATE products SET qtyBreaksJson/.test(sql) ? { bind: () => ({ run: async () => { throw new Error("disk I/O error"); } }) } : d1.prepare(sql);
    e = await rejects(() => M.updateProduct(runFails, "club",
      { productId: "tee", type: "shirt", name: "Club Tee", pricingMode: "sized", sizePricing: { S: 20, M: 22 }, visible: true, qtyBreaks: [{ minQty: 12, off: 2 }] }));
    ok("saving breaks passes on an error that isn't a missing column", !!e && /disk I\/O/.test(e.message));
    const sale = await admin({ action: "createLocalSale", org: "club", customerName: "Pat Example", contact: "pat@example.com", paymentMethod: "Check",
      items: [{ productId: "__custom__", name: "Banner", type: "custom", qty: 1, customUnitPrice: 10, taxable: true }] });
    const o = await quietly(() => M.getOrderById(failing(d1, /FROM estimates WHERE orderId = \?/, "disk I/O error"), sale.body.orderId));
    ok("an order still reads back when its quote can't be looked up (estimate null)", !!o && o.estimate === null);
    e = await rejects(() => callWith({ ...env, DB: failing(d1, /FROM estimates WHERE orderId IN/, "disk I/O error") }, { action: "getOrders", org: "club" }));
    ok("the orders list passes on an error reading which orders came from quotes", !!e && /disk I\/O/.test(e.message));
    e = await rejects(() => callWith({ ...env, DB: failing(d1, /FROM estimates e/, "disk I/O error") }, { action: "listEstimates" }));
    ok("a quote action passes on an error that isn't a missing table (not \"the database is still being updated\")", !!e && /disk I\/O/.test(e.message));
  }

  // ============================================================================================================
  console.log("=== db.js quote functions given less than usual ===");
  {
    const q = await quote({ send: false });
    r = await M.setEstimateFields(d1, q.id, null);
    ok("setEstimateFields with no fields (null) changes nothing", r && r.ok === true && r.after.title === r.before.title && r.after.expiresOn === r.before.expiresOn);
    r = await M.saveEstimateItems(d1, q.id, [{ kind: "product", productId: null, name: "Tee", qty: 1, unitPrice: 5 }]);
    ok("a product line with no product: \"Line 1 needs a product.\"", r.error === "Line 1 needs a product.");
    r = await M.saveEstimateItems(d1, q.id, [{ kind: "product", productId: "tee", name: "Club Tee", size: "S", qty: 1, unitPrice: 20, personalized: true, persName: null }]);
    ok("a personalized line with no name saves an empty name", r.ok === true && d1.q("SELECT persName, personalized FROM estimate_items WHERE estimateId = ?", q.id)[0].persName === "");
    const v = M.estimateLinesView([{ kind: "custom", qty: 1, unitPrice: 5, lineTotal: 5, taxable: true }]);
    ok("the email's line view gives a line with no name an empty name", v.lines[0].name === "" && v.lines[0].kind === "custom");
    ok("the catalog sends no breaks for a product without a list (an entry cached before 0109)", same(clientQtyBreaks(undefined), []) && same(clientQtyBreaks(null), []));
  }

  // ============================================================================================================
  console.log("=== A sale for a customer whose exemption has a last day ===");
  {
    const ex = (await admin({ action: "saveCustomer", name: "Max Example", email: "max@example.com", taxExempt: true, taxExemptCertificate: "EX-9", taxExemptExpires: "2099-12-31" })).body.id;
    const sale = await admin({ action: "createLocalSale", org: "club", customerId: ex, customerName: "Max Example", contact: "max@example.com", paymentMethod: "Check",
      items: [{ productId: "__custom__", name: "Banner", type: "custom", qty: 1, customUnitPrice: 10, taxable: true }] });
    ok("…is exempt while the certificate is good: no tax", sale.status === 200 && orderRow(sale.body.orderId).taxExempt === 1 && orderRow(sale.body.orderId).totalCents === 1000);
  }

  // ============================================================================================================
  console.log("=== Pricing analysis: a flat, untaxed product under its MAP ===");
  {
    const blankId = (await M.createBlank(d1, { name: "Example Cap Blank", productType: "cap",
      colors: [{ color: "White", images: [], sizes: [{ size: "OSFA", purchasePrice: 0, quantity: 0 }] }] })).id;
    d1._raw.run("UPDATE blank_sizes SET vendorPriceCents = 900, mapPriceCents = 1800 WHERE blankId = ?", [blankId]);
    await M.createProduct(d1, "club", { productId: "cap", type: "cap", name: "Club Cap", pricingMode: "flat", flatPrice: 15, visible: true, noDesignNeeded: true, taxable: false,
      qtyBreaks: [{ minQty: 24, off: 1 }] });
    await M.setBlankLink(d1, "club", "cap", "", "", blankId, "White", "OSFA");
    const a = (await M.analyzePricing(d1, { orgId: "club", productId: "cap" })).products[0];
    ok("its sentence starts with \"The price\", and an untaxed product carries no tax at the price or the break",
      same(a.mapProblems.slice(0, 1), ["The price $15.00 is below the MAP of $18.00 (Example Cap Blank White OSFA)"]) && a.rows[0].tax === 0);
  }

  // ============================================================================================================
  console.log("=== convertEstimateToOrder_ given less than usual ===");
  {
    r = await M.convert(env, 0);
    ok("an id that isn't one: 404 \"That quote wasn't found.\"", same(r, { error: "That quote wasn't found.", status: 404 }));
    const q = await quote();
    r = await M.convert(env, { estimate: { id: q.id } });
    ok("getEstimate's own answer is taken as the quote, and no actor is recorded as none",
      !!r.orderId && r.repeated === false && JSON.parse(d1.q("SELECT detail, actor FROM audit_log WHERE action = 'estimate.converted' ORDER BY id DESC LIMIT 1")[0].detail).estimateId === q.id &&
      d1.q("SELECT actor FROM audit_log WHERE action = 'estimate.converted' ORDER BY id DESC LIMIT 1")[0].actor === null);

    // A shop whose id has no letters or numbers, a number with none either, a customer with no name, a fee with no kind.
    d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('--', 'dashes', '', 't', 't', 1);`);
    const odd = (await M.createEstimate(d1, { orgId: "--", customerId: nameless, createdBy: "" })).id;
    await M.saveEstimateItems(d1, odd, [{ kind: "custom", name: "x", qty: 2, unitPrice: 5, taxable: true }, { kind: "fee", feeKind: "setup", amount: 15, taxable: false }]);
    d1._raw.run("UPDATE estimate_items SET name = '' WHERE estimateId = ? AND kind = 'custom'", [odd]);
    d1._raw.run("UPDATE estimate_items SET feeKind = '' WHERE estimateId = ? AND kind = 'fee'", [odd]);
    d1._raw.run("UPDATE estimates SET number = '--' WHERE id = ?", [odd]);
    r = await M.convert(env, odd, { sendInvoice: true });
    const o = orderRow(r.orderId);
    ok("the order's number falls back to ORD-Q<id>; a nameless customer is \"Customer\"", r.orderId === "ORD-Q" + odd && !!o && o.customerName === "Customer");
    ok("…a custom line with no description is \"Custom item\", a fee with no kind is \"Fee\"",
      same(d1.q("SELECT name FROM order_items WHERE orderId = ? ORDER BY id", r.orderId).map(x => x.name), ["Custom item", "Fee"]));

    // Two at once: one makes the order, the other answers it.
    const twice = await quote();
    const [x, y] = await Promise.all([M.convert(env, twice.id), M.convert(env, twice.id)]);
    ok("converting twice at the same moment makes one order, and both answer it", x.orderId === y.orderId && [x.repeated, y.repeated].includes(true) &&
      d1.q("SELECT count(*) n FROM orders WHERE orderId = ?", x.orderId)[0].n === 1);

    // Cancelled between the order being made and the quote being marked: the order stands, and that is logged.
    const late = await quote();
    const lateDb = Object.create(d1);
    lateDb.prepare = (sql) => { if (/^UPDATE estimates SET status = 'converted'/.test(sql)) d1._raw.run("UPDATE estimates SET status = 'cancelled' WHERE id = ?", [late.id]); return d1.prepare(sql); };
    r = await quietly(() => M.convert({ ...env, DB: lateDb }, late.id));
    ok("a quote cancelled as its order was made: the order stands and the failure is logged", !!orderRow(r.orderId) && logged.some(l => /wasn't marked converted/.test(l)));

    // The audit row can't be written: the order is still made.
    const noAudit = await quote();
    r = await quietly(() => M.convert({ ...env, DB: failing(d1, /^INSERT INTO audit_log/, "disk I/O error") }, noAudit.id));
    ok("an audit row that can't be written doesn't undo the order", !!orderRow(r.orderId) && logged.some(l => /AUDIT WRITE FAILED: estimate\.converted/.test(l)));

    // The invoice: on a shop with no subdomain the link starts with the request's origin, or is left out with none.
    d1._raw.run("UPDATE orgs SET subdomain = '' WHERE orgId = 'club'");
    mail.length = 0;
    const inv1 = await quote();
    r = await M.convert(env, inv1.id, { sendInvoice: true, origin: "https://shop.example.com", actor: "olive@example.test", ip: "198.51.100.7" });
    ok("an invoice for a shop with no subdomain links from the origin it was asked from", r.invoiceSent === true && mail.some(m => /https:\/\/shop\.example\.com\/\?invoice=/.test(m.htmlBody)));
    const inv2 = await quote();
    r = await M.convert(env, inv2.id, { sendInvoice: true });
    const sentRow = d1.q("SELECT actor, ip FROM audit_log WHERE action = 'order.invoice_sent' ORDER BY id DESC LIMIT 1")[0];
    ok("…and with no origin either, it goes without a link; no actor or address is recorded as none", r.invoiceSent === true && sentRow.actor === null && sentRow.ip === null);
    d1._raw.run("UPDATE orgs SET subdomain = 'club' WHERE orgId = 'club'");
    const inv3 = await quote();
    r = await quietly(() => M.convert({ ...env, DB: failing(d1, /^INSERT INTO audit_log/, "disk I/O error", () => true) }, inv3.id, { sendInvoice: true }));
    ok("an invoice audit row that can't be written is logged, and the invoice still counts as sent", r.invoiceSent === true && logged.some(l => /AUDIT WRITE FAILED: order\.invoice_sent/.test(l)));
    const inv4 = await quote();
    r = await quietly(() => M.convert({ ...env, DB: failing(d1, /order_invoices/, "disk I/O error") }, inv4.id, { sendInvoice: true }));
    ok("an invoice that can't be made: the order stands, not sent, and it is logged", !!orderRow(r.orderId) && r.invoiceSent === false && logged.some(l => /The invoice for the order made from quote/.test(l)));
    const inv5 = await quote();
    r = await M.convert({ ...env, EDITION: "desktop" }, inv5.id, { sendInvoice: true });
    ok("the desktop edition without its email switched on sends no invoice", !!orderRow(r.orderId) && r.invoiceSent === false);
  }

  // ============================================================================================================
  console.log("=== The quote actions given less than usual ===");
  {
    const q = await quote({ send: false });
    r = await admin({ action: "saveEstimate", id: q.id, title: null, internalNote: null });
    ok("saveEstimate takes a null title or note as empty", r.status === 200 && r.body.estimate.title === "" && r.body.estimate.internalNote === "");
    globalThis.__actor321 = "";
    r = await admin({ action: "createEstimate", org: "club", customerId: pat });
    globalThis.__actor321 = undefined;
    ok("a quote made with no one named as its maker records none", r.status === 200 && d1.q("SELECT createdBy FROM estimates WHERE id = ?", r.body.id)[0].createdBy === "");
    const breaking = failing(d1, /FROM products WHERE orgId=\? AND productId=\?|FROM published/i, "disk I/O error");
    r = await quietly(() => callWith({ ...env, DB: breaking }, { action: "saveEstimate", id: q.id, items: [{ kind: "product", productId: "tee", size: "S", qty: 1 }] }));
    ok("a line that can't be priced for a reason the shop didn't cause: \"Line 1: couldn't price it. Try again.\"", r.status === 400 && r.body.message === "Line 1: couldn't price it. Try again.");

    // Send: a nameless customer, a shop with no name, a message of null.
    d1._raw.run("UPDATE orgs SET name = '' WHERE orgId = 'club'");
    const n = await quote({ customerId: nameless, send: false });
    mail.length = 0;
    r = await admin({ action: "sendEstimate", id: n.id, message: null });
    ok("sending with a message of null: no note; a customer with no name is greeted \"Hello,\"; a shop with no name is left out of the subject",
      r.status === 200 && d1.q("SELECT message FROM estimates WHERE id = ?", n.id)[0].message === "" && /Hello,/.test(mail[0].body) && /^Quote Q-\d+ · \$/.test(mail[0].subject));
    d1._raw.run("UPDATE orgs SET name = 'Example Club' WHERE orgId = 'club'");
    const conv = await quote();
    d1._raw.run("UPDATE estimates SET status = 'converted', orderId = NULL WHERE id = ?", [conv.id]);
    r = await admin({ action: "cancelEstimate", id: conv.id });
    ok("cancelling a quote marked converted with no order named: \"This quote is already an order.\"", r.status === 409 && /already an order/.test(r.body.message));
  }

  // ============================================================================================================
  console.log("=== /api/estimate given less than usual ===");
  {
    r = await M.estimateApi.onRequestGet({ env: {}, request: { url: "https://club.example.com/api/estimate?token=x", headers: hdrs("198.51.100.9") } });
    const r2 = await M.estimateApi.onRequestPost({ env: {}, request: { url: "https://club.example.com/api/estimate", headers: hdrs("198.51.100.9"), json: async () => ({}) } });
    ok("with no database, GET and POST answer 500 \"Server misconfigured\"", r.status === 500 && r2.status === 500 && JSON.parse(await r2.text()).message === "Server misconfigured");

    // A shop with no name or accent, a nameless customer, a quote with no expiry.
    d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, accent, createdAt, updatedAt, ready) VALUES ('plain', 'plain', '', '', 't', 't', 1);`);
    const p = await quote({ org: "plain", customerId: nameless });
    d1._raw.run("UPDATE estimates SET expiresOn = NULL WHERE id = ?", [p.id]);
    r = await get(p.token, { ...env, DB: failing(d1, /^UPDATE estimates SET viewedAt/, "disk I/O error") });
    ok("GET: a shop with no name shows its id; no customer name, no expiry; a failed \"viewed\" mark doesn't stop it",
      r.status === 200 && r.body.estimate.orgName === "plain" && r.body.estimate.customerName === "" && r.body.estimate.expiresOn === "");
    r = await get(p.token, { ...env, DB: failing(d1, /key='salesTax'/, "disk I/O error") });
    ok("…and when the tax settings can't be read, the quote still shows, with no jurisdiction", r.status === 200 && r.body.estimate.taxJurisdiction === "" && r.body.estimate.total === 53);
    d1._raw.run("UPDATE estimates SET status = 'changes', customerNote = '' WHERE id = ?", [p.id]);
    r = await get(p.token);
    ok("a quote waiting on changes with no note shows an empty note", r.body.estimate.status === "changes" && r.body.estimate.customerNote === "");

    // A last day that isn't a real date is said as it is stored.
    const bad = await quote();
    d1._raw.run("UPDATE estimates SET expiresOn = '1999-13-45' WHERE id = ?", [bad.id]);
    r = await post({ token: bad.token, action: "accept" });
    ok("an expiry date that isn't a real date: the refusal says it as stored", r.status === 410 && r.body.message === "This quote expired on 1999-13-45 — contact us for a new one.");

    // The quote can't be read back by id after its token was found.
    const lost = await quote();
    const lostDb = Object.create(d1);
    let lookups = 0;
    lostDb.prepare = (sql) => { if (/^SELECT \* FROM estimates WHERE id = \?/.test(sql)) { lookups++; return { bind: () => ({ first: async () => null }) }; } return d1.prepare(sql); };
    r = await get(lost.token, { ...env, DB: lostDb });
    ok("a quote found by its link but not by its id: 404 \"This quote link isn't valid.\"", r.status === 404 && r.body.message === "This quote link isn't valid." && lookups === 1);

    // Accepted, then the quote (or its shop) can't be read again: the answer has no quote, the order is still made.
    const acc = await quote();
    let accepted = false;
    const accDb = Object.create(d1);
    accDb.prepare = (sql) => {
      if (/^UPDATE estimates SET status = 'accepted'/.test(sql)) accepted = true;
      if (accepted && /^SELECT \* FROM orgs WHERE orgId/.test(sql)) return { bind: () => ({ first: async () => null }) };
      if (accepted && /^SELECT \* FROM estimates WHERE id = \?/.test(sql) && !globalThis.__inConvert321) return { bind: () => ({ first: async () => null }) };
      return d1.prepare(sql);
    };
    globalThis.__convert321 = async (...a) => { globalThis.__inConvert321 = true; try { return await M.convert(...a); } finally { globalThis.__inConvert321 = false; } };
    const res = await M.estimateApi.onRequestPost({ env: { ...env, DB: accDb }, request: { url: "https://club.example.com/api/estimate", headers: hdrs(null), json: async () => ({ token: acc.token, action: "accept" }) } });
    r = { status: res.status, body: JSON.parse(await res.text()) };
    globalThis.__convert321 = null;
    ok("accepted when the quote can't be read again: ok, its order made from the quote as loaded, no quote in the answer, no address recorded",
      r.status === 200 && !!r.body.orderId && r.body.estimate === null && d1.q("SELECT ip FROM audit_log WHERE action = 'estimate.accepted' ORDER BY id DESC LIMIT 1")[0].ip === null);

    // Refused by the database, and the quote can't be read again either.
    const raced = await quote();
    let flipped = false;
    const raceDb = Object.create(d1);
    raceDb.prepare = (sql) => {
      if (/^UPDATE estimates SET status = 'accepted'/.test(sql)) { flipped = true; d1._raw.run("UPDATE estimates SET status = 'cancelled' WHERE id = ?", [raced.id]); }
      if (flipped && /^SELECT \* FROM orgs WHERE orgId/.test(sql)) return { bind: () => ({ first: async () => null }) };
      return d1.prepare(sql);
    };
    r = await post({ token: raced.token, action: "accept" }, { ...env, DB: raceDb });
    ok("refused by the database when the quote can't be read again: 409, the general sentence, no quote", r.status === 409 && r.body.estimate === null &&
      r.body.message === "This quote can't be answered online right now — contact us.");

    // Making the order throws something that isn't an Error: the acceptance stands and the owner is told.
    const thrown = await quote();
    globalThis.__convert321 = async () => { throw "the order book is full"; };
    r = await quietly(() => post({ token: thrown.token, action: "accept" }));
    globalThis.__convert321 = null;
    ok("an order that fails with a bare reason: the acceptance stands, and the system issue quotes the reason",
      r.status === 200 && r.body.orderId === "" && d1.q("SELECT sample FROM system_issues ORDER BY id DESC LIMIT 1")[0].sample.endsWith("— the order book is full"));
  }
})().catch(e => { console.error(e); console.log("test321 crashed: false"); process.exit(1); });
