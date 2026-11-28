// Net 30 terms and customer-supplied garments (phase 7, migrations/0121): the fallbacks and refusals of
// functions/api/orders.js, invoice.js and catalog.js that the other phase 7 tests (test400–test407) never reach.
//   * The helpers: net30CustomerFor_ with no email, termsSettingsInput_ given a list, net30AllowedFor_ when Global
//     settings read as nothing or can't be read, a garment count with no size.
//   * termsCall_: db.js throwing a userFacing refusal, a database before the update, any other failure, and a
//     { notReady } answer.
//   * setOrderTerms / acceptOrderPo: no staff name (accepted by nobody in particular), db.js refusing, and the order
//     gone by the time the answer is read (no order, no payment state).
//   * getOrders / getOrdersAllShops: the pay-on-delivery and Net 30 rules unreadable, more orders than a page holds,
//     Global settings unreadable, a shop with no name.
//   * getUnpaidPoReport: db.js refusing, an answer without its date, Global settings unreadable.
//   * Local sale and quote Convert on Net 30: no staff name, the terms refused after the order is made (the warning),
//     a quote with no number, a quote line with choices, a quote with a discount code; a Local sale with a gift card.
//   * listCustomers / getCustomer with the terms unreadable; saveCustomer (Allow Net 30 sent as 1 by Back office, the
//     customer unreadable after a save); a quote line whose product's tax setting can't be read.
//   * The garment actions: a line on an order with no lines, the waiver not text, check-ins answered in other shapes,
//     the order gone, a line with no name, an Undo of a count of 0, db.js refusing an Undo, the switch missing.
//   * updateTermsSettings / saveGlobalSettingsAll terms refused by db.js; updateFeatures with no switches;
//     resendDownloads for an order not paid or cleared; a storefront order with no payment method.
//   * The invoice page's PO status worked out when the order has none; /api/catalog's net30Offered.
// Real SQL (sql.js) under the real db.js, email.js, digital.js, orders.js, invoice.js and catalog.js. A db.js
// function is replaced only for one call, to make it fail or answer oddly. Invented shops, people, codes and PO
// numbers. The business time zone is set (America/Denver) and no check depends on today's date.
const fs = require("fs");
const { ok } = require("./testlib/check");
const { createD1 } = require("./testlib/d1-shim.js");
const roles = require("./testlib/roles");
const { MAIL_ENV, MAIL_OK, captureMail } = require("./testlib/mail-mock");
const { ADMIN_ORIGIN, shopOrigin } = require("./testlib/hosts.js");

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/^import "[^"\n]+";\n/gm, "").replace(/export (async function|function|const)/g, "$1");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Wrapped db.js functions: globalThis.__o409[name] = (real, ...args) => … stands in for one while it is set.
const wrap = (src, names) => {
  let out = src;
  for (const n of names) {
    const from = "export async function " + n + "(";
    if (!out.includes(from)) throw new Error("no " + n);
    out = out.replace(from, "async function " + n + "_real409_(");
  }
  return strip(out) + "\n" + names.map(n => `async function ${n}(...a) { const o = globalThis.__o409[${JSON.stringify(n)}]; return o ? o(${n}_real409_, ...a) : ${n}_real409_(...a); }`).join("\n") + "\n";
};
globalThis.__o409 = {};
globalThis.__f409 = { ownGarments: true };
globalThis.__role409 = "admin";
globalThis.__actor409 = "kim@example.com";
const WRAPPED = ["getTerms", "getGlobalSettings", "getOrderById", "setOrderTerms", "acceptOrderPo", "getUnpaidPoReport", "getPayOnDeliveryRule", "getOrdersByOrg",
  "listGarmentCheckins", "checkInGarments", "undoGarmentCheckin", "getFeatures", "setTerms", "buildTermsSettings", "getEstimate", "getOrgById", "saveCustomer"];
const libs = strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  strip(read("functions/_lib/quoteToken.js")) + "\n" + strip(read("functions/_lib/boxSize.js")) + "\n";
const A = new Function(libs +
  "const requireAdmin = async () => null; const adminActor = () => globalThis.__actor409;\n" + roles.adminAs({ roleFrom: "globalThis.__role409" }) + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyTurnstile = async () => ({ ok: true });\nconst invalidateCatalogVersionCache = () => {};\n" +
  "const getCatalogData = async () => ({ subdomainMap: { acme: 'acme', beta: 'beta' }, orgs: {}, features: globalThis.__f409 });\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  wrap(read("functions/_lib/db.js"), WRAPPED) + "\n" + strip(read("functions/_lib/email.js")) + "\n" + strip(read("functions/_lib/digital.js")) + "\n" +
  "const ordersApi = (function(){\n" + strip(read("functions/api/orders.js")) +
  "\nreturn { post: onRequestPost, convertEstimateToOrder_, net30CustomerFor_, termsSettingsInput_, net30AllowedFor_, garmentCountsOf_, paidState_ }; })();\n" +
  "const invoiceApi = (function(){\n" + strip(read("functions/api/invoice.js")) + "\nreturn { onRequestGet, onRequestPost }; })();\n" +
  "return { ordersApi, invoiceApi, getOrderById, getOrderInvoiceByOrder, setLocaleSettings, resolveTimeZone, setTerms, getTerms, publishShop, net30Cleared };")();
const O = A.ordersApi;

const mail = [];
global.fetch = async (url, init) => {
  if (captureMail(url, init, mail)) return MAIL_OK;
  throw new Error("unexpected fetch " + url);
};
// What the code logs on purpose (terms that weren't saved, a refused audit row) is kept here, not printed.
const logged = [];
console.error = (...a) => { logged.push(a.map(x => x && x.stack ? x.message : String(x)).join(" ")); };
const ENV = { SIGNING_SECRET: "s".repeat(40), STRIPE_SECRET_KEY: "sk_test_example", DESIGNS: {}, ...MAIL_ENV };
const using = async (over, fn) => { Object.assign(globalThis.__o409, over); try { return await fn(); } finally { for (const k of Object.keys(over)) delete globalThis.__o409[k]; } };
const as = async (who, actor, fn) => {
  const r0 = globalThis.__role409, a0 = globalThis.__actor409;
  globalThis.__role409 = who; globalThis.__actor409 = actor;
  try { return await fn(); } finally { globalThis.__role409 = r0; globalThis.__actor409 = a0; }
};
const userFacing = (m) => Object.assign(new Error(m), { userFacing: true });
process.on("unhandledRejection", (e) => { console.log("unhandled rejection " + (e && e.message)); ok("nothing in the test was left to fail unseen", false); });

const migrations = fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort();

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of migrations) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready, shippingEnabled) VALUES
    ('acme','acme','Example Club','t','t',1,1), ('beta','beta','','t','t',1,1);`);
  // A database that answers one query differently on purpose: globalThis.__dbHook409 = (sql) => a statement to use
  // instead, or null for the real one. FAIL is a statement whose every read fails.
  globalThis.__dbHook409 = null;
  const FAIL = { bind: () => FAIL, first: async () => { throw new Error("D1 read failed (test)"); }, all: async () => { throw new Error("D1 read failed (test)"); }, run: async () => { throw new Error("D1 write failed (test)"); } };
  const db = Object.create(d1);
  db.prepare = (sql) => (globalThis.__dbHook409 && globalThis.__dbHook409(sql)) || d1.prepare(sql);
  const E = { DB: db, ...ENV };
  const call = async (fn, url, body) => {
    const waits = [];
    const res = await fn({ env: E, waitUntil: (p) => waits.push(Promise.resolve(p).catch(() => {})),
      request: { url, json: async () => body, headers: { get: (h) => (h === "CF-Connecting-IP" ? "203.0.113.7" : null) } } });
    await Promise.all(waits);
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const admin = (body) => call(O.post, ADMIN_ORIGIN + "/api/orders", { key: "x", org: "acme", ...body });
  const q = (sql, ...p) => d1.q(sql, ...p);
  const q1 = (sql, ...p) => d1.q(sql, ...p)[0] || null;
  const row = (id) => q1("SELECT * FROM orders WHERE orderId = ?", id);
  const audits = (action, orderId) => q("SELECT detail FROM audit_log WHERE action = ?" + (orderId ? " AND orderId = ?" : "") + " ORDER BY id", ...(orderId ? [action, orderId] : [action])).map(r => JSON.parse(r.detail || "{}"));
  const throwsFrom = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
  let r;

  await A.setLocaleSettings(d1, { timeZone: "America/Denver" });
  await A.resolveTimeZone({ DB: d1 });
  await A.setTerms(d1, { defaultDays: 45, startsAt: "invoice" });
  q("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('business', ?)", JSON.stringify({ name: "Example Embroidery" }));
  q("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('enabledPayments', ?)", JSON.stringify({ card: true, check: true, net30: true }));
  r = await admin({ action: "createProduct", productId: "mug", type: "other", name: "Club Mug", pricingMode: "flat", flatPrice: 10, visible: true, weightOz: 10, noDesignNeeded: true });
  if (r.status !== 200) throw new Error("createProduct " + JSON.stringify(r));
  await A.publishShop(d1, "acme");
  q(`INSERT INTO customers (id, name, company, email, createdAt, updatedAt, allowNet30, termsDays) VALUES
    (1, 'Pat Example', 'Example School District', 'pat@example.com', 't', 't', 1, 60),
    (2, 'Sam Example', 'Example Club', 'sam@example.com', 't', 't', 0, NULL);`);
  let k = 0;
  const sale = (extra = {}) => admin({ action: "createLocalSale", requestId: "req409-" + (++k), items: [{ productId: "__custom__", name: "Club Tee", type: "other", size: "", customUnitPrice: 25, qty: 4, taxable: false }],
    paymentMethod: "", contact: "pat@example.com", customerName: "Example School District", placedAt: "2026-03-02", ...extra });

  // =================================================================================================================
  console.log("=== The helpers ===");
  // =================================================================================================================
  ok("net30CustomerFor_: a customer allowed Net 30 is found by their email, whatever its case and spaces", same(await O.net30CustomerFor_(d1, "  PAT@example.com "), { id: 1, termsDays: 60 }));
  ok("…no email at all (null or left out): nobody, without asking the database", (await O.net30CustomerFor_(null, null)) === null && (await O.net30CustomerFor_(null, undefined)) === null);
  ok("termsSettingsInput_: a list, null or text instead of the terms is no terms (the days refused)",
    [[], null, "30"].every(v => O.termsSettingsInput_(v).error === "The usual terms are a whole number of days from 1 to 365."));
  ok("…while the same days and start as an object are taken", same(O.termsSettingsInput_({ defaultDays: "20", startsAt: "order" }), { value: { defaultDays: 20, startsAt: "order" } }));
  ok("net30AllowedFor_: Net 30 ticked in Global settings and not switched off for the shop: yes", (await O.net30AllowedFor_(db, { enabledPayments: {} })) === true);
  r = await using({ getGlobalSettings: async () => null }, () => O.net30AllowedFor_(db, null));
  ok("…Global settings that read as nothing: no", r === false);
  r = await using({ getGlobalSettings: async () => ({ theme: "x" }) }, () => O.net30AllowedFor_(db, null));
  ok("…Global settings with no payment methods: no", r === false);
  r = await using({ getGlobalSettings: async () => { throw new Error("settings unreadable (test)"); } }, () => O.net30AllowedFor_(db, null));
  ok("…Global settings that can't be read: no", r === false);
  r = O.garmentCountsOf_([{ expectedQty: 2, receivedQty: 2 }, { size: null, expectedQty: 1, receivedQty: 1 }, { size: "  XL ", expectedQty: 1, receivedQty: 1 }]);
  ok("garmentCountsOf_: a count with no size (left out or null) has the size \"\"; a size is trimmed", !r.error && same(r.counts.map(c => c.size), ["", "", "XL"]));
  ok("paidState_: no order, no payment state", same(O.paidState_(null), {}) && same(O.paidState_(undefined), {}));

  // =================================================================================================================
  console.log("\n=== setOrderTerms and acceptOrderPo ===");
  // =================================================================================================================
  r = await sale();
  const S1 = r.body.orderId;
  ok("a Local sale to set terms on is made", r.status === 200 && !!S1 && row(S1).net30 === 0);
  r = await using({ getGlobalSettings: async () => null }, () => admin({ action: "setOrderTerms", orderId: S1, net30: true }));
  ok("Net 30 on while Global settings read as nothing: refused (409, Net 30 isn't switched on) and not set",
    r.status === 409 && /Net 30 isn't switched on for this shop/.test(r.body.message) && row(S1).net30 === 0);
  r = await using({ getGlobalSettings: async () => { throw new Error("settings unreadable (test)"); } }, () => admin({ action: "setOrderTerms", orderId: S1, net30: true }));
  ok("…or can't be read: the same refusal", r.status === 409 && /Net 30 isn't switched on/.test(r.body.message) && row(S1).net30 === 0);

  r = await as("admin", "", () => admin({ action: "setOrderTerms", orderId: S1, net30: true, poNumber: "PO-1001" }));
  ok("Net 30 with a PO typed by staff who have no name: set, and the PO accepted by nobody in particular (\"\")",
    r.status === 200 && row(S1).net30 === 1 && row(S1).poNumber === "PO-1001" && !!row(S1).poAcceptedAt && row(S1).poAcceptedBy === "");
  ok("…the answer: the order and its payment state, cleared for work", r.body.order && r.body.order.orderId === S1 && r.body.net30 === true && r.body.net30Cleared === true && r.body.poStatus === "accepted");

  // The order gone by the time the answer reads it (deleted at the same moment): the change stands, the answer has no order.
  const gone = () => { let after = false; return {
    getOrderById: async (real, ...a) => after ? null : real(...a),
    setOrderTerms: async (real, ...a) => { const x = await real(...a); after = true; return x; },
    acceptOrderPo: async (real, ...a) => { const x = await real(...a); after = true; return x; },
    listGarmentCheckins: async (real, ...a) => { after = true; return real(...a); } }; };
  r = await using(gone(), () => admin({ action: "setOrderTerms", orderId: S1, net30: true, termsDays: 20 }));
  ok("setOrderTerms with the order unreadable after the change: ok, order null, and no payment state in the answer",
    r.status === 200 && r.body.order === null && !("paid" in r.body) && !("net30" in r.body) && row(S1).termsDays === 20);

  r = await using({ setOrderTerms: async () => ({ error: "Terms locked (test).", status: 423 }) }, () => admin({ action: "setOrderTerms", orderId: S1, termsDays: 10 }));
  ok("db.js refusing the terms with its own status: that status and its message", r.status === 423 && r.body.message === "Terms locked (test)." && row(S1).termsDays === 20);
  r = await using({ setOrderTerms: async () => ({ error: "Terms refused (test)." }) }, () => admin({ action: "setOrderTerms", orderId: S1, termsDays: 10 }));
  ok("…without a status: 409", r.status === 409 && r.body.message === "Terms refused (test).");

  // acceptOrderPo: a PO the customer typed (set straight on the row, as the checkout leaves it).
  const typedPo = async (po) => { const s = (await sale()).body.orderId; q("UPDATE orders SET net30 = 1, poNumber = ?, poTypedAt = '2026-03-02T16:00:00Z' WHERE orderId = ?", po, s); return s; };
  const T1 = await typedPo("PO-1002");
  r = await using({ acceptOrderPo: async () => ({ error: "Net 30 isn't ready yet (test).", notReady: true }) }, () => admin({ action: "acceptOrderPo", orderId: T1 }));
  ok("Accept PO with db.js saying the database isn't ready: 503 with its message, and not accepted",
    r.status === 503 && r.body.message === "Net 30 isn't ready yet (test)." && row(T1).poAcceptedAt === null);
  r = await using({ acceptOrderPo: async () => { throw new Error("no such column: poAcceptedAt"); } }, () => admin({ action: "acceptOrderPo", orderId: T1 }));
  ok("…a database before the update (no such column): 503, the latest database update is needed", r.status === 503 && /need the latest database update/.test(r.body.message));
  r = await using({ acceptOrderPo: async () => { throw userFacing("That PO can't be accepted (test)."); } }, () => admin({ action: "acceptOrderPo", orderId: T1 }));
  ok("…a userFacing refusal: 400 with its message", r.status === 400 && r.body.message === "That PO can't be accepted (test).");
  const boom = await throwsFrom(() => using({ acceptOrderPo: async () => { throw new Error("disk on fire (test)"); } }, () => admin({ action: "acceptOrderPo", orderId: T1 })));
  ok("…any other failure isn't hidden as a refusal: it is thrown on", !!boom && boom.message === "disk on fire (test)" && row(T1).poAcceptedAt === null);
  r = await as("admin", null, () => using(gone(), () => admin({ action: "acceptOrderPo", orderId: T1 })));
  ok("Accept PO by staff with no name, the order unreadable after: ok, order null, no payment state; accepted by nobody in particular",
    r.status === 200 && r.body.order === null && !("paid" in r.body) && !!row(T1).poAcceptedAt && row(T1).poAcceptedBy === "");
  ok("…its audit row names the PO and when the customer typed it", same(audits("order.po_accepted", T1).pop(), { poNumber: "PO-1002", typedAt: "2026-03-02T16:00:00Z" }));

  // =================================================================================================================
  console.log("\n=== The Orders page's lists ===");
  // =================================================================================================================
  r = await admin({ action: "getOrders" });
  ok("getOrders: the shop's pay-on-delivery rule and its Net 30 rule with the usual 45 days", r.status === 200 && r.body.payOnDelivery && r.body.payOnDelivery.allowed === false &&
    same(r.body.net30, { allowed: true, defaultDays: 45 }) && r.body.more === false);
  r = await using({ getPayOnDeliveryRule: async () => { throw new Error("rule unreadable (test)"); }, getOrgById: async () => { throw new Error("shop unreadable (test)"); } }, () => admin({ action: "getOrders" }));
  ok("…both rules unreadable: the list still comes, with pay on delivery not allowed and Net 30 not allowed (30 days)",
    r.status === 200 && same(r.body.payOnDelivery, { allowed: false, localSaleOnly: false }) && same(r.body.net30, { allowed: false, defaultDays: 30 }) && r.body.orders.length > 0);
  const one = (await A.getOrderById(d1, S1));
  r = await using({ getOrdersByOrg: async () => Array.from({ length: 2001 }, (_, i) => ({ ...one, orderId: "MANY-" + i })) }, () => admin({ action: "getOrders" }));
  ok("…more orders than a page holds (2,001): the first 2,000, and more says so", r.status === 200 && r.body.orders.length === 2000 && r.body.more === true && r.body.max === 2000 &&
    r.body.orders[1999].orderId === "MANY-1999");
  q("INSERT INTO orders (orderId, orgId, customerName, contact, placedAt) VALUES ('BETA-1', 'beta', 'Example Club', '', '2026-03-03T15:00:00Z')");
  r = await admin({ action: "getOrdersAllShops" });
  const shopOf = (b, id) => (b.shops || []).find(s => s.orgId === id);
  ok("getOrdersAllShops: a shop with no name is named by its id", r.status === 200 && shopOf(r.body, "beta") && shopOf(r.body, "beta").name === "beta" && shopOf(r.body, "acme").name === "Example Club");
  ok("…each shop's Net 30 rule with the usual days", same(shopOf(r.body, "acme").net30, { allowed: true, defaultDays: 45 }));
  r = await using({ getGlobalSettings: async () => null }, () => admin({ action: "getOrdersAllShops" }));
  ok("…Global settings that read as nothing: Net 30 not allowed anywhere", r.status === 200 && r.body.shops.every(s => s.net30.allowed === false));
  r = await using({ getGlobalSettings: async () => { throw new Error("settings unreadable (test)"); } }, () => admin({ action: "getOrdersAllShops" }));
  ok("…or can't be read: not allowed anywhere, with the usual 30 days", r.status === 200 && r.body.shops.length >= 2 && r.body.shops.every(s => same(s.net30, { allowed: false, defaultDays: 30 })));

  // =================================================================================================================
  console.log("\n=== The Unpaid POs report ===");
  // =================================================================================================================
  r = await admin({ action: "getUnpaidPoReport", asOf: "2026-04-30", org: "" });
  ok("the report as asked: its date, Net 30 on", r.status === 200 && r.body.asOf === "2026-04-30" && r.body.net30On === true && Array.isArray(r.body.rows));
  r = await using({ getUnpaidPoReport: async () => ({ error: "The report can't be made (test).", status: 422 }) }, () => admin({ action: "getUnpaidPoReport", asOf: "2026-04-30", org: "" }));
  ok("db.js refusing the report: its status and message", r.status === 422 && r.body.message === "The report can't be made (test).");
  r = await using({ getUnpaidPoReport: async () => ({ rows: [], groups: [], totals: {} }), getGlobalSettings: async () => null },
    () => admin({ action: "getUnpaidPoReport", asOf: "2026-04-30", org: "" }));
  ok("an answer without its date: the date asked for; Global settings that read as nothing: Net 30 off", r.status === 200 && r.body.asOf === "2026-04-30" && r.body.net30On === false);
  r = await using({ getGlobalSettings: async (real, ...a) => { if (globalThis.__gsFail409) throw new Error("settings unreadable (test)"); return real(...a); },
    getUnpaidPoReport: async (real, ...a) => { const x = await real(...a); globalThis.__gsFail409 = true; return x; } },
  () => admin({ action: "getUnpaidPoReport", asOf: "2026-04-30", org: "" }));
  globalThis.__gsFail409 = false;
  ok("…Global settings unreadable after the report is made: the report, with Net 30 off", r.status === 200 && r.body.net30On === false && Array.isArray(r.body.rows));

  // =================================================================================================================
  console.log("\n=== A Local sale on Net 30 ===");
  // =================================================================================================================
  r = await as("admin", "", () => sale({ net30: true, poNumber: "PO-1003" }));
  ok("a Local sale on Net 30 with a PO, by staff with no name: on Net 30, the PO accepted by nobody in particular",
    r.status === 200 && !r.body.warning && row(r.body.orderId).net30 === 1 && row(r.body.orderId).poNumber === "PO-1003" && !!row(r.body.orderId).poAcceptedAt && row(r.body.orderId).poAcceptedBy === "");
  r = await using({ setOrderTerms: async () => ({ error: "Terms refused (test)." }) }, () => sale({ net30: true, poNumber: "PO-1004", termsDays: 15 }));
  const W1 = r.body.orderId;
  ok("db.js refusing the sale's terms: the sale stands, not on Net 30, and the answer warns to set them on the order",
    r.status === 200 && !!W1 && row(W1).net30 === 0 && r.body.warning === "The sale was saved, but its Net 30 terms weren't. Set them on the order (Terms).");
  ok("…the audit row says the terms weren't saved", (() => { const d = audits("order.created_local_sale", W1).pop(); return d && d.net30 === true && d.termsNotSaved === true && d.poNumber === "PO-1004" && d.termsDays === 15; })());
  ok("…and the failure is logged", logged.some(l => l.includes("Net 30 terms weren't saved on local sale " + W1) && l.includes("Terms refused (test).")));
  r = await sale({ giftCards: [{ code: "GC-NOPE-0000" }] });
  ok("a Local sale with a gift card that isn't one: the sale is made and the answer lists the card's result (not used)",
    r.status === 200 && Array.isArray(r.body.giftCards) && r.body.giftCards.length === 1 && r.body.giftCards[0].ok === false && !!row(r.body.orderId));

  // =================================================================================================================
  console.log("\n=== A quote converted on Net 30 ===");
  // =================================================================================================================
  const quote = async (items) => {
    const c = await admin({ action: "createEstimate", org: "acme", customerId: 1, title: "Club order" });
    if (c.status !== 200) throw new Error("createEstimate " + JSON.stringify(c));
    const s = await admin({ action: "saveEstimate", id: c.body.id, items: items || [{ kind: "product", productId: "mug", qty: 2 }] });
    if (s.status !== 200) throw new Error("saveEstimate " + JSON.stringify(s));
    return { id: c.body.id, number: c.body.number, save: s };
  };
  const Q1 = await quote();
  r = await as("admin", "", () => using({ getEstimate: async (real, ...a) => { const g = await real(...a); if (g && g.items && g.items[0]) g.items[0].config = { color: "Navy" }; return g; } },
    () => admin({ action: "convertEstimate", id: Q1.id, net30: true, poNumber: "PO-1005" })));
  const C1 = r.body.orderId;
  ok("a quote converted on Net 30 with a PO by staff with no name: the order is on Net 30, the PO accepted by nobody in particular",
    r.status === 200 && !r.body.warning && row(C1).net30 === 1 && row(C1).poNumber === "PO-1005" && !!row(C1).poAcceptedAt && row(C1).poAcceptedBy === "");
  ok("…a quote line with choices keeps them on the order's line", (() => { const it = q1("SELECT * FROM order_items WHERE orderId = ?", C1); return !!it && /Navy/.test(String(it.configJson || it.config || "")); })());

  const Q2 = await quote();
  r = await using({ getEstimate: async (real, ...a) => { const g = await real(...a); if (g && g.estimate) g.estimate = { ...g.estimate, number: "" }; return g; },
    setOrderTerms: async () => ({ error: "Terms refused (test)." }) }, () => admin({ action: "convertEstimate", id: Q2.id, net30: true, termsDays: 20 }));
  const C2 = r.body.orderId;
  ok("a quote with no number, its terms refused by db.js: the order is made (named by the quote's id), not on Net 30, and the answer warns",
    r.status === 200 && C2 === "ACME-Q" + Q2.id && row(C2).net30 === 0 && r.body.warning === "The order was made, but its Net 30 terms weren't. Set them on the order (Terms).");
  ok("…the failure is logged with the quote's id, and the audit row says the terms weren't saved",
    logged.some(l => l.includes("Net 30 terms weren't saved on the order made from quote " + Q2.id + " ")) &&
    (() => { const d = audits("estimate.converted", C2).pop(); return d && d.net30 === true && d.termsNotSaved === true && d.termsDays === 20; })());

  q("INSERT INTO discount_codes (code, kind, percentBps, maxUses, active, createdAt) VALUES ('SAVE10', 'percent', 1000, 5, 1, 't')");
  const Q3 = await quote();
  r = await admin({ action: "saveEstimate", id: Q3.id, discountCodes: ["SAVE10"] });
  ok("a quote given the code SAVE10", r.status === 200);
  r = await admin({ action: "convertEstimate", id: Q3.id });
  ok("…converted: the audit row names the code and what it took off", r.status === 200 &&
    (() => { const d = audits("estimate.converted", r.body.orderId).pop(); return d && same(d.discountCodes, ["SAVE10"]) && d.discount === 2; })());

  // =================================================================================================================
  console.log("\n=== Customers ===");
  // =================================================================================================================
  r = await admin({ action: "listCustomers" });
  ok("listCustomers: the usual Net 30 days (45) for the \"Net N\" tag", r.status === 200 && r.body.defaultDays === 45);
  r = await using({ getTerms: async () => { throw new Error("terms unreadable (test)"); } }, () => admin({ action: "listCustomers" }));
  ok("…the terms unreadable: still the list, with 30 days", r.status === 200 && r.body.defaultDays === 30 && r.body.customers.length >= 2);
  r = await using({ getTerms: async () => { throw new Error("terms unreadable (test)"); } }, () => admin({ action: "getCustomer", id: 1 }));
  ok("getCustomer with the terms unreadable: the customer, with 30 days", r.status === 200 && r.body.defaultDays === 30 && r.body.customer.email === "pat@example.com");
  r = await as("staff", "lee@example.com", () => admin({ action: "saveCustomer", id: 1, phone: "555-0100", allowNet30: 1, termsDays: 60 }));
  ok("Back office saving a customer allowed Net 30 with Allow Net 30 sent as 1 and the same days: saved (nothing about the terms changed)",
    r.status === 200 && q1("SELECT phone, allowNet30, termsDays FROM customers WHERE id = 1").phone === "555-0100" && q1("SELECT allowNet30 FROM customers WHERE id = 1").allowNet30 === 1);
  r = await as("staff", "lee@example.com", () => admin({ action: "saveCustomer", id: 2, allowNet30: 1 }));
  ok("…but Allow Net 30 sent as 1 for a customer without it: refused (Customers full)", r.status === 403 && /Net 30 terms/.test(r.body.message) && q1("SELECT allowNet30 FROM customers WHERE id = 2").allowNet30 === 0);
  // Reading the customer back after db.js saved them fails (the database went away at that moment).
  const unreadable = { saveCustomer: async (real, ...a) => { const x = await real(...a); globalThis.__dbHook409 = (sql) => sql === "SELECT * FROM customers WHERE id = ?" ? FAIL : null; return x; } };
  r = await using(unreadable, () => admin({ action: "saveCustomer", name: "Lee Example", email: "lee@example.com", address: { line1: "1 Example Way", city: "Denver", state: "CO", zip: "80202" } }));
  globalThis.__dbHook409 = null;
  const r2 = await using(unreadable, () => admin({ action: "saveCustomer", name: "Kim Example", email: "kim@example.com" }));
  globalThis.__dbHook409 = null;
  ok("a new customer saved while reading them back fails: saved all the same", r.status === 200 && r2.status === 200 && !!q1("SELECT id FROM customers WHERE email = 'lee@example.com'") && !!q1("SELECT id FROM customers WHERE email = 'kim@example.com'"));
  ok("…the audit rows are made from what was sent (with an address and without)", (() => { const a = audits("customer.created"); const lee = a.find(d => d.email === "lee@example.com"), kim = a.find(d => d.email === "kim@example.com");
    return lee && lee.name === "Lee Example" && kim && kim.name === "Kim Example"; })());

  // =================================================================================================================
  console.log("\n=== A quote line's tax ===");
  // =================================================================================================================
  q("UPDATE products SET taxable = 0 WHERE productId = 'mug'");
  const Q4 = await quote();
  const taxOf = (s) => ((s.body.items || s.body.estimate && s.body.estimate.items || [])[0] || {}).taxable;
  ok("a quote's product line is taxed by the product's own setting (not taxable)", taxOf(Q4.save) === false);
  globalThis.__dbHook409 = (sql) => /SELECT productId, taxable FROM products/.test(sql) ? { bind: () => ({ all: async () => ({ results: [] }) }) } : null;
  r = await admin({ action: "saveEstimate", id: Q4.id, items: [{ kind: "product", productId: "mug", qty: 3 }] });
  globalThis.__dbHook409 = null;
  ok("…a product whose setting isn't found: taxable, as a new product is", r.status === 200 && taxOf(r) === true);
  q("UPDATE products SET taxable = 1 WHERE productId = 'mug'");

  // =================================================================================================================
  console.log("\n=== Customer-supplied garments ===");
  // =================================================================================================================
  r = await admin({ action: "updateFeatures", features: { ownGarments: true } });
  ok("Customer-supplied garments switched on", r.status === 200);
  r = await sale({ items: [{ productId: "__custom__", name: "Club Tee", type: "other", size: "", customUnitPrice: 25, qty: 3, taxable: false, customerOwned: true }] });
  const G1 = r.body.orderId;
  const lineOf = async (orderId) => (await A.getOrderById(d1, orderId)).items[0];
  const item1 = (await lineOf(G1)).sheetRow;
  ok("a Local sale with the customer's own garments is made", r.status === 200 && (await lineOf(G1)).customerOwned === true);
  q("UPDATE order_items SET name = '' WHERE orderId = ?", G1);
  r = await as("admin", "", () => admin({ action: "checkInGarments", orderId: G1, itemId: item1, counts: [{ expectedQty: 3, receivedQty: 0, note: "Nothing came yet" }] }));
  ok("a count with no size, for a line with no name, by staff with no name: checked in with size \"\" and by \"\"",
    r.status === 200 && r.body.checkins.length === 1 && r.body.checkins[0].size === "" && r.body.checkins[0].by === "" && r.body.itemId === item1);
  ok("…its audit row names the line as \"\"", (() => { const d = audits("order.garments_checked_in", G1).pop(); return d && d.name === "" && d.received === 0 && d.expected === 3; })());
  ok("…none received, so the line isn't in", !(await lineOf(G1)).ownReceivedAt);
  r = await as("admin", null, () => admin({ action: "undoGarmentCheckin", orderId: G1, itemId: item1 }));
  ok("Undo of that count (rows, none received) by staff with no name: done, and the rows voided", r.status === 200 && r.body.checkins.every(c => !!c.voidedAt));
  ok("…its audit row: the line as \"\", not in before (null), and the count it took back", (() => { const d = audits("order.garments_checkin_undone", G1).pop();
    return d && d.name === "" && d.before.ownReceivedAt === null && same(d.before.counts, [{ size: "", expected: 3, received: 0, condition: "good" }]); })());

  r = await admin({ action: "checkInGarments", orderId: G1, itemId: item1, counts: [{ size: "M", expectedQty: 3, receivedQty: 3 }] });
  ok("three garments checked in: the line is in", r.status === 200 && !!(await lineOf(G1)).ownReceivedAt);
  const noRows = { getOrderById: async (real, ...a) => { const o = await real(...a); if (o && o.items) o.items = o.items.map(i => { const c = { ...i }; delete c.checkins; return c; }); return o; } };
  r = await using({ ...noRows, undoGarmentCheckin: async () => ({ error: "That line can't be undone now (test).", status: 409 }) }, () => admin({ action: "undoGarmentCheckin", orderId: G1, itemId: item1 }));
  ok("db.js refusing an Undo: 409 with its message, and the line still in", r.status === 409 && r.body.message === "That line can't be undone now (test)." && !!(await lineOf(G1)).ownReceivedAt);
  ok("…the Undo audited first saw the line in, with no rows read (counts [])", (() => { const d = audits("order.garments_checkin_undone", G1).pop(); return d && !!d.before.ownReceivedAt && same(d.before.counts, []); })());

  r = await using({ getOrderById: async (real, ...a) => { const o = await real(...a); if (o) delete o.items; return o; } }, () => admin({ action: "checkInGarments", orderId: G1, itemId: item1, counts: [{ size: "M", expectedQty: 3, receivedQty: 3 }] }));
  ok("an order read with no lines: the line isn't on it (400)", r.status === 400 && /That line isn't on this order/.test(r.body.message));
  r = await using({ getFeatures: async (real, ...a) => ({ ...(await real(...a)), ownGarmentsWaiver: 5 }), listGarmentCheckins: async () => ({ checkins: [{ id: 99, size: "L" }] }) },
    () => admin({ action: "listGarmentCheckins", orderId: G1 }));
  ok("a waiver that isn't text: no waiver line; check-ins answered as { checkins }: those", r.status === 200 && r.body.waiver === "" && same(r.body.checkins, [{ id: 99, size: "L" }]));
  r = await using({ listGarmentCheckins: async () => null }, () => admin({ action: "listGarmentCheckins", orderId: G1 }));
  ok("…check-ins answered as nothing: none", r.status === 200 && same(r.body.checkins, []) && typeof r.body.waiver === "string" && r.body.waiver.length > 0);
  r = await using((() => { let n = 0; return { getOrderById: async (real, ...a) => (n++ === 0 ? real(...a) : null) }; })(), () => admin({ action: "listGarmentCheckins", orderId: G1 }));
  ok("…the order unreadable once the check-ins are read: order null", r.status === 200 && r.body.order === null && r.body.checkins.length >= 1);

  r = await using({ checkInGarments: async () => { throw userFacing("Those garments can't be counted (test)."); } }, () => admin({ action: "checkInGarments", orderId: G1, itemId: item1, counts: [{ size: "M", expectedQty: 3, receivedQty: 3 }] }));
  ok("db.js throwing a userFacing refusal of a check-in: 400 with its message", r.status === 400 && r.body.message === "Those garments can't be counted (test).");
  r = await using({ checkInGarments: async () => { throw new Error("no such table: garment_checkins"); } }, () => admin({ action: "checkInGarments", orderId: G1, itemId: item1, counts: [{ size: "M", expectedQty: 3, receivedQty: 3 }] }));
  ok("…a database before the update: 503, the latest database update is needed", r.status === 503 && r.body.message === "Net 30 and customer-supplied garments need the latest database update. Apply the migrations, then try again.");

  globalThis.__f409 = undefined;
  r = await admin({ action: "listGarmentCheckins", orderId: G1 });
  ok("a catalog with no feature switches at all: Customer-supplied garments is off (403, its switch named)", r.status === 403 && r.body.feature === "ownGarments");
  globalThis.__f409 = { ownGarments: true };

  // =================================================================================================================
  console.log("\n=== Settings ===");
  // =================================================================================================================
  r = await admin({ action: "updateTermsSettings", terms: [] });
  ok("updateTermsSettings with a list for the terms: refused (400), the usual 45 days kept", r.status === 400 && /whole number of days/.test(r.body.message) && (await A.getTerms(d1)).defaultDays === 45);
  r = await using({ setTerms: async () => { throw userFacing("Terms can't be saved now (test)."); } }, () => admin({ action: "updateTermsSettings", terms: { defaultDays: 20, startsAt: "order" } }));
  ok("…db.js refusing them (userFacing): 400 with its message, nothing saved", r.status === 400 && r.body.message === "Terms can't be saved now (test)." && (await A.getTerms(d1)).defaultDays === 45);
  const e1 = await throwsFrom(() => using({ setTerms: async () => { throw new Error("disk on fire (test)"); } }, () => admin({ action: "updateTermsSettings", terms: { defaultDays: 20, startsAt: "order" } })));
  ok("…any other failure is thrown on, not answered as a refusal", !!e1 && e1.message === "disk on fire (test)" && (await A.getTerms(d1)).defaultDays === 45);
  r = await using({ buildTermsSettings: async () => { throw userFacing("Those terms can't be used (test)."); } }, () => admin({ action: "saveGlobalSettingsAll", settings: { terms: { defaultDays: 20, startsAt: "order" } } }));
  ok("Save all with Net 30 terms db.js refuses: refused with its message, nothing saved", r.status === 400 && r.body.message.includes("Those terms can't be used (test).") && (await A.getTerms(d1)).defaultDays === 45);
  const featBefore = q1("SELECT value FROM global_settings WHERE key = 'features'");
  const featAudits = audits("settings.features_set").length;
  r = await admin({ action: "updateFeatures" });
  ok("updateFeatures with no switches sent: ok, every switch as it was (garments still on), nothing stored or audited",
    r.status === 200 && r.body.features.ownGarments === true && r.body.features.storefront === true &&
    same(q1("SELECT value FROM global_settings WHERE key = 'features'"), featBefore) && audits("settings.features_set").length === featAudits);

  // =================================================================================================================
  console.log("\n=== Resending an order's downloads ===");
  // =================================================================================================================
  const U1 = (await sale({ contact: "" })).body.orderId;
  r = await admin({ action: "resendDownloads", orderId: U1 });
  ok("an order neither paid nor cleared on Net 30: refused, the files go out once it is paid", r.status === 400 && r.body.message === "The order isn't paid yet — the files go out once it is.");
  await admin({ action: "setOrderTerms", orderId: U1, net30: true, poNumber: "PO-1006" });
  ok("…put on Net 30 with an accepted PO it is cleared", A.net30Cleared(await A.getOrderById(d1, U1)) === true);
  r = await admin({ action: "resendDownloads", orderId: U1 });
  ok("…so it passes that check, and stops only for having no email address", r.status === 400 && r.body.message === "No email address on this order.");

  // =================================================================================================================
  console.log("\n=== A storefront order with no payment method ===");
  // =================================================================================================================
  r = await call(O.post, shopOrigin("acme") + "/api/orders", { orderId: "WEB-409", orgId: "acme", customerName: "Pat Example", contact: "pat@example.com", items: [{ productId: "mug", qty: 1 }] });
  ok("placed with no payment method: an ordinary order, not on Net 30", r.status === 200 && row("WEB-409") && row("WEB-409").net30 === 0 && !("net30" in r.body));

  // =================================================================================================================
  console.log("\n=== The invoice page's PO status ===");
  // =================================================================================================================
  const I1 = (await sale({ net30: true, poNumber: "PO-1007" })).body.orderId;
  r = await admin({ action: "sendInvoice", orderId: I1 });
  const token = (await A.getOrderInvoiceByOrder(d1, I1)).token;
  const invGet = async () => { const res = await A.invoiceApi.onRequestGet({ env: E, request: { url: shopOrigin("acme") + "/api/invoice?token=" + token, headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) }; };
  r = await using({ getOrderById: async (real, ...a) => { const o = await real(...a); return o ? { ...o, poStatus: "" } : o; } }, invGet);
  ok("an order read without its PO status, its PO accepted: the invoice says accepted", r.status === 200 && r.body.invoice.terms && r.body.invoice.terms.poStatus === "accepted" && r.body.invoice.terms.poNumber === "PO-1007");
  r = await using({ getOrderById: async (real, ...a) => { const o = await real(...a); return o ? { ...o, poStatus: "", poAcceptedAt: null } : o; } }, invGet);
  ok("…not accepted: PO to check", r.status === 200 && r.body.invoice.terms.poStatus === "PO to check");

  // =================================================================================================================
  console.log("\n=== The storefront catalog's net30Offered (functions/api/catalog.js) ===");
  // =================================================================================================================
  {
    // The real db.js, catalogCache.js and catalog.js (as test244), with a stand-in for the Cache API.
    const store = new Map();
    global.caches = { default: { async match(key) { const hit = store.get(typeof key === "string" ? key : key.url); return hit ? hit.clone() : undefined; },
      async put(key, response) { store.set(typeof key === "string" ? key : key.url, response); } } };
    const L = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/db.js")) + "\n" +
      strip(read("functions/_lib/catalogCache.js")) + "\n" + strip(read("functions/api/catalog.js")) +
      "\nreturn { net30OfferedAtCheckout_, catalogGet: onRequestGet, createProduct, publishShop, setGlobalSettings, _resetCatalogCacheState, _resetShopStock, bumpCatalogVersion };")();
    const c1 = await createD1();
    c1._raw.exec(read("testlib/schema-pre-0006.sql"));
    for (const f of migrations) c1.execFile(read("migrations/" + f));
    c1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('acme','acme','Example Club','t','t',1);`);
    await L.createProduct(c1, "acme", { productId: "mug", type: "other", name: "Club Mug", pricingMode: "flat", flatPrice: 10, visible: true, noDesignNeeded: true, reorderQr: "none" });
    const offered = async (globalPayments, shopPayments) => {
      if (globalPayments === null) c1.q("DELETE FROM global_settings WHERE key = 'enabledPayments'");
      else c1.q("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('enabledPayments', ?)", JSON.stringify(globalPayments));
      c1.q("UPDATE orgs SET enabledPayments = ? WHERE orgId = 'acme'", shopPayments === undefined ? "" : JSON.stringify(shopPayments));
      await L.publishShop(c1, "acme");
      await L.bumpCatalogVersion(c1);
      store.clear(); L._resetCatalogCacheState(); L._resetShopStock();
      const res = await L.catalogGet({ request: { url: shopOrigin("acme") + "/api/catalog" }, env: { DB: c1 } });
      const b = JSON.parse(await res.text());
      return res.status === 200 && b.catalog ? b.catalog.net30Offered : "no catalog";
    };
    ok("Net 30 ticked in Global settings, the shop leaving it alone: net30Offered true", (await offered({ card: true, net30: true }, { card: true })) === true);
    ok("…the shop with no payment methods of its own saved: true", (await offered({ card: true, net30: true }, undefined)) === true);
    ok("…the shop switching it off for itself: false", (await offered({ card: true, net30: true }, { card: true, net30: false })) === false);
    ok("…Global settings with no payment methods saved: false (Net 30 is off until ticked)", (await offered(null, { card: true })) === false);
    ok("…not ticked in Global settings (or ticked as anything but true): false", (await offered({ card: true }, { card: true, net30: true })) === false &&
      (await offered({ card: true, net30: "true" }, { card: true })) === false);
    const N = L.net30OfferedAtCheckout_;
    ok("net30OfferedAtCheckout_: no settings or no shop read (null, or without payment methods): only Global settings' own true offers it",
      N(null, null) === false && N(null, { enabledPayments: { net30: true } }) === true && N({ name: "Example Club" }, { theme: "x" }) === false &&
      N({ enabledPayments: null }, { enabledPayments: { net30: true } }) === true && N({ enabledPayments: { net30: false } }, { enabledPayments: { net30: true } }) === false);
    ok("…and 'Net 30' is never one of the shop's payment methods", await (async () => { await offered({ card: true, net30: true }, { card: true });
      const res = await L.catalogGet({ request: { url: shopOrigin("acme") + "/api/catalog" }, env: { DB: c1 } });
      const b = JSON.parse(await res.text()); return Array.isArray(b.catalog.enabledPayments) && !b.catalog.enabledPayments.some(m => /net/i.test(m)); })());
  }
}
)().catch((e) => { console.log("the test stopped " + (e && e.stack)); process.exitCode = 1; });
