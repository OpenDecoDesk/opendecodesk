const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { ok } = require("./testlib/check");
const roles = require("./testlib/roles");
const { MAIL_ENV, MAIL_OK, captureMail } = require("./testlib/mail-mock");

// Phase 6: discount codes on an order that already exists and on quotes.
//   1. The order page: applyOrderDiscountCode / removeOrderDiscountCode in db.js and as admin actions — the discount, its
//      note ("Code A" / "Codes A, B"), its tax share and free shipping worked out again from ALL the order's live codes,
//      the stored total, paid status refreshed; every refusal (void, completed, fully refunded, a manual discount, one code
//      only, the same code twice, the code's own rules); who may (orders.payments Edit); the Discount codes switch; a
//      closed month; the audit rows; and a database from before migrations/0120.
//   2. A manual discount while a code is on (setDiscount / setOrderDiscount refuse).
//   3. Quotes: setEstimateDiscountCodes, the totals with codes (getEstimate and the Quotes list), saveEstimate's
//      discountCodes, sendEstimate checking them again (a refused code stops the send with its reason),
//      convertEstimateToOrder_ claiming them (staff's Convert and the customer's Accept through functions/api/estimate.js),
//      the customer's view of the quote (discountCodes, discount, discounts, shippingOff) and the quote email's lines.
//   4. The quote editor's Discount codes box (public/admin-quotes.js) in the real admin page (jsdom).
// Real SQL (sql.js) under the real db.js, orders.js, estimate.js and email.js. Invented shops, people and codes only.
// Dates are fixed far from today (codes expire in 2000 or 2099; orders are dated 2025 and 2026), the business's time
// zone is set to UTC here, and nothing depends on this machine's.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const mail = [];
global.fetch = async (url, init) => { if (captureMail(url, init, mail)) return MAIL_OK; throw new Error("unexpected fetch " + url); };
const logged = [];
const realError = console.error;
const quietly = async (fn) => { console.error = (...a) => logged.push(a.map(String).join(" ")); try { return await fn(); } finally { console.error = realError; } };

const M = new Function(
  strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  strip(read("functions/_lib/db.js")) + "\n" + strip(read("functions/_lib/email.js")) + "\n" + strip(read("functions/_lib/quoteToken.js")) + "\n" +
  strip(read("functions/_lib/boxSize.js")) + "\n" + strip(read("functions/_lib/permissions.js")) + "\n" +
  "const requireAdmin = async (env, host, key, request, msg, need) => roleAllows(DEFAULT_ROLES[globalThis.__role389] || null, need) ? null : jsonResponse({ status: 'error', message: 'Your role can\\'t do that here.' }, 403);\n" +
  "const adminActor = () => 'olive@example.test';\n" + roles.adminAs({ roleFrom: "globalThis.__role389" }) + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: { club: 'club', band: 'band' }, orgs: {}, features: globalThis.__feat389 || {} });\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({});\n" +
  "const ordersMod = (function(){\n" + strip(read("functions/api/orders.js")) + "\nreturn { onRequestPost, convertEstimateToOrder_ }; })();\n" +
  "const convertEstimateToOrder_ = (...a) => ordersMod.convertEstimateToOrder_(...a);\n" +
  "const estimateApi = (function(){\n" + strip(read("functions/_lib/rateLimit.js")) + "\n" + strip(read("functions/api/estimate.js")) + "\nreturn { onRequestGet, onRequestPost }; })();\n" +
  "return { ordersApi: ordersMod.onRequestPost, convertEstimateToOrder_: ordersMod.convertEstimateToOrder_, estimateApi, createProduct, setSalesTaxSettings, setLocaleSettings, setDiscountRules, " +
  "getEstimate, getOrderById, insertOrder, addOrderPayment, voidOrder, applyOrderDiscountCode, removeOrderDiscountCode, setOrderDiscount, setEstimateDiscountCodes, listEstimates, " +
  "buildEstimateEmail, estimateDiscountView };")();

const freshDb = async (upTo) => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006" && (!upTo || f < upTo)).sort()) d1.execFile(read("migrations/" + f));
  return d1;
};
const NOT_READY = "Discount codes need the latest database update. Apply the migrations, then try again.";
const INVALID_EMAIL = "This code isn't valid. If it was sent to you, check the email address is the one it was sent to.";
const ONE_CODE = "Only one discount code can be used on an order.";
const NO_CODE_NOW = "This order can't take a code now.";
const HAS_CODE = "This order has a discount code; take the code off first.";
const OFF = "Discount codes is turned off. Turn it on under Settings → Global settings → Features.";
const pause = (ms) => new Promise(r => setTimeout(r, ms));
const wait = async (cond, n = 400) => { for (let i = 0; i < n && !cond(); i++) await pause(10); return !!cond(); };
process.on("unhandledRejection", (e) => { console.error(e); ok("nothing in the test was left to fail unseen", false); });

(async () => {
  globalThis.__role389 = "admin";
  globalThis.__feat389 = {};
  const d1 = await freshDb();
  const env = { DB: d1, ...MAIL_ENV };
  await M.setLocaleSettings(d1, { timeZone: "UTC" });
  await M.setSalesTaxSettings(d1, { rateBps: 800, jurisdiction: "Example County", taxMode: "exclusive" });
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('club','club','Example Club','t','t',1), ('band','band','Example Band','t','t',1);`);
  await M.createProduct(d1, "club", { productId: "cap", type: "cap", name: "Club cap", pricingMode: "flat", flatPrice: 20, visible: true, noDesignNeeded: true });

  const callWith = async (e, body) => {
    const waits = [];
    const res = await M.ordersApi({ env: e, waitUntil: (p) => waits.push(Promise.resolve(p).catch(() => {})),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    await Promise.all(waits);
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const call = (body) => callWith(env, body);
  const as = async (role, body) => { const was = globalThis.__role389; globalThis.__role389 = role; try { return await call(body); } finally { globalThis.__role389 = was; } };
  const refused = (r, status, message) => r.status === status && r.body.status === "error" && r.body.message === message;
  const audits = (action) => d1.q("SELECT * FROM audit_log WHERE action = ? ORDER BY id", action).map(a => ({ ...a, detail: JSON.parse(a.detail || "null") }));
  const lastAudit = (action) => { const a = audits(action); return a[a.length - 1] || null; };
  const orderRow = (id) => d1.q("SELECT * FROM orders WHERE orderId = ?", id)[0];
  const uses = (id) => d1.q("SELECT u.*, c.code FROM discount_code_uses u JOIN discount_codes c ON c.id = u.codeId WHERE u.orderId = ? ORDER BY u.id", id);
  const live = (id) => uses(id).filter(u => u.releasedAt == null).map(u => u.code);
  let codeN = 0;
  const addCode = (code, f = {}) => {
    const percent = f.amountCents == null;
    d1._raw.run(`INSERT INTO discount_codes (code, kind, percentBps, amountCents, orgId, email, maxUses, oncePerEmail, expiresOn, active, note, createdAt, createdBy, maxDiscountCents, minOrderCents, freeShipping, goodsOff)
      VALUES (?,?,?,?,?,?,?,?,?,?,'',?,'test',?,?,?,?)`, [code, percent ? "percent" : "amount", percent ? (f.percentBps || 1000) : null, percent ? null : f.amountCents, f.orgId || null, f.email || "",
      f.maxUses || 50, f.oncePerEmail ? 1 : 0, f.expiresOn || null, f.active === false ? 0 : 1, "2026-01-0" + (1 + (codeN++ % 9)) + "T00:00:00Z", f.maxDiscountCents || null, f.minOrderCents || null,
      f.freeShipping ? 1 : 0, f.goodsOff === false ? 0 : 1]);
    return d1.q("SELECT id FROM discount_codes WHERE code = ?", code)[0].id;
  };
  addCode("SAVE10");                                                  // 10% off
  addCode("TEAM5", { amountCents: 500 });                             // $5 off
  addCode("SHIPFREE", { percentBps: 10000, freeShipping: true, goodsOff: false });   // free shipping only
  addCode("BIG50", { minOrderCents: 10000 });                         // 10%, on $100 or more
  addCode("BANDONLY", { orgId: "band" });
  addCode("PATONLY", { email: "pat@example.com", amountCents: 300 });
  addCode("LEEONLY", { email: "lee@example.com" });
  addCode("OLDCODE", { expiresOn: "2000-01-31" });
  addCode("OFFCODE", { active: false });
  addCode("ONCE", { maxUses: 1 });
  addCode("FULL100", { percentBps: 10000 });

  const placeOrder = (orderId, { qty = 2, unit = 20, shipping = 6, contact = "pat@example.com", placedAt = "2026-03-10T15:00:00.000Z", org = "club" } = {}) =>
    M.insertOrder(d1, { orderId, orgId: org, customerName: "Pat Example", contact, phone: "555-0100", paymentMethod: "", subtotal: qty * unit, shippingCost: shipping, total: qty * unit + shipping,
      shippingMethod: shipping ? "standard" : "", shippingAddress: null, totalWeightOz: 0, placedAt },
      [{ productId: "cap", name: "Club cap", type: "cap", size: "", qty, unitPrice: unit, personalized: false, persName: "", personalizationFee: 0 }]);
  const apply = (orderId, code, extra) => call(Object.assign({ action: "applyOrderDiscountCode", orderId, code }, extra || {}));
  const remove = (orderId, code, extra) => call(Object.assign({ action: "removeOrderDiscountCode", orderId, code }, extra || {}));

  // =================================================================================================================
  // 1. Codes on an order that already exists
  // =================================================================================================================
  console.log("=== The order page's Add code: one code, worked out on the order ===");
  await placeOrder("CLUB-1001");   // two caps at $20 ($40 of goods), $6 shipping, 8% sales tax added on top: $49.20
  {
    const before = orderRow("CLUB-1001");
    ok("(the order starts with no discount: $40.00 of goods, $6.00 shipping, $3.20 tax, a stored total of $49.20)", before.discountCents === 0 && before.totalCents === 4920 && before.shippingCostCents === 600);
    const r = await apply("CLUB-1001", " save10 ");
    ok("Add code SAVE10 (typed in lower case with spaces) is taken: 200 and status ok", r.status === 200 && r.body.status === "ok" && r.body.orderId === "CLUB-1001");
    ok("…the answer has the discount ($4.00), the note “Code SAVE10”, the code alone and as a list, and no free shipping", r.body.discountAmount === 4 && r.body.discountNote === "Code SAVE10" &&
      r.body.discountCode === "SAVE10" && same(r.body.discountCodes, ["SAVE10"]) && r.body.shippingDiscount === 0);
    ok("…what is owed now: $40 − $4 + tax on $36 ($2.88) + $6 shipping = $44.88, all of it still due, the tax $2.88", r.body.effectiveTotal === 44.88 && r.body.balanceDue === 44.88 && r.body.salesTax === 2.88);
    ok("…and the whole order, as the order window reads it, with the same figures", r.body.order && r.body.order.orderId === "CLUB-1001" && r.body.order.discountAmount === 4 && r.body.order.effectiveTotal === 44.88 && same(r.body.order.discountCodes, ["SAVE10"]));
    ok("…and unpaid (paid, paid for work, paid at, pay on delivery)", r.body.paid === false && r.body.paidForWork === false && r.body.paidAt === null && r.body.payOnDelivery === false);
    const row = orderRow("CLUB-1001");
    ok("the order is stored with the discount, its note and the tax inside it (32¢), and no shipping taken off", row.discountCents === 400 && row.discountNote === "Code SAVE10" && row.discountTaxCents === 32 && row.shippingDiscountCents === 0);
    ok("one use of SAVE10 is taken for the order, for the pat@example.com address, worth $4.00", same(uses("CLUB-1001").map(u => [u.code, u.email, u.amountCents, u.releasedAt]), [["SAVE10", "pat@example.com", 400, null]]));
    const a = lastAudit("order.discount_code_applied");
    ok("the audit log has order.discount_code_applied for the order: the code typed, the discount from $0 to $4, the note and the codes", !!a && a.orderId === "CLUB-1001" && a.orgId === "club" &&
      same(a.detail, { code: "save10", discount: { from: 0, to: 4 }, note: "Code SAVE10", codes: ["SAVE10"] }));
  }

  console.log("\n=== One code at a time (the default rule) ===");
  {
    const n = audits("order.discount_code_applied").length;
    let r = await apply("CLUB-1001", "SAVE10");
    ok("the same code again: “That code is already applied.” (400)", refused(r, 400, "That code is already applied."));
    r = await apply("CLUB-1001", "TEAM5");
    ok("a second code while the shop takes one per order: “Only one discount code can be used on an order.” (400)", refused(r, 400, ONE_CODE));
    ok("…nothing changed: still only SAVE10, $4.00 off, and no audit row for either", same(live("CLUB-1001"), ["SAVE10"]) && orderRow("CLUB-1001").discountCents === 400 && audits("order.discount_code_applied").length === n);
  }

  console.log("\n=== More than one code (Global settings → Discount codes allows it) ===");
  await M.setDiscountRules(d1, { multiple: true });
  {
    let r = await apply("CLUB-1001", "TEAM5");
    ok("TEAM5 is added after SAVE10: $4.00 + $5.00 = $9.00 off, the note “Codes SAVE10, TEAM5”", r.status === 200 && r.body.discountAmount === 9 && r.body.discountNote === "Codes SAVE10, TEAM5" &&
      r.body.discountCode === "SAVE10, TEAM5" && same(r.body.discountCodes, ["SAVE10", "TEAM5"]));
    ok("…the tax inside the discount is worked out from the whole $9.00 (72¢)", orderRow("CLUB-1001").discountTaxCents === 72);
    ok("…each use carries its own share: SAVE10 $4.00, TEAM5 $5.00", same(uses("CLUB-1001").map(u => [u.code, u.amountCents]), [["SAVE10", 400], ["TEAM5", 500]]));
    r = await apply("CLUB-1001", "shipfree");
    ok("a free-shipping code takes the $6.00 shipping off and nothing off the goods: still $9.00, shipping discount $6.00", r.status === 200 && r.body.discountAmount === 9 && r.body.shippingDiscount === 6 &&
      r.body.discountNote === "Codes SAVE10, TEAM5, SHIPFREE");
    ok("…what is owed: $40 − $9 + $2.48 tax + $0 shipping = $33.48", r.body.effectiveTotal === 33.48 && r.body.order.shippingCharged === 0);
    const row = orderRow("CLUB-1001");
    ok("…stored: shipping discount 600¢ and a total with the shipping taken off ($40 + $3.20 tax = 4320¢)", row.shippingDiscountCents === 600 && row.totalCents === 4320);
    ok("…and the free-shipping code's use is worth the $6.00 it took", uses("CLUB-1001").find(u => u.code === "SHIPFREE").amountCents === 600);
  }

  console.log("\n=== Taking a code off (the code's ×) ===");
  {
    const before = await M.getOrderById(d1, "CLUB-1001");
    const r = await remove("CLUB-1001", "team5");
    ok("removing TEAM5 (typed in lower case) answers 200 with the rest worked out again: $4.00 off, “Codes SAVE10, SHIPFREE”", r.status === 200 && r.body.discountAmount === 4 &&
      r.body.discountNote === "Codes SAVE10, SHIPFREE" && same(r.body.discountCodes, ["SAVE10", "SHIPFREE"]) && r.body.shippingDiscount === 6);
    const u = uses("CLUB-1001").find(x => x.code === "TEAM5");
    ok("…TEAM5's use is given back (kept, marked released), so it no longer counts", !!u && u.releasedAt != null && same(live("CLUB-1001"), ["SAVE10", "SHIPFREE"]));
    const a = lastAudit("order.discount_code_removed");
    ok("the audit log has order.discount_code_removed with the code and what the order's discount was before", !!a && a.orderId === "CLUB-1001" &&
      same(a.detail, { code: "team5", from: { amount: before.discountAmount, note: "Codes SAVE10, TEAM5, SHIPFREE", codes: ["SAVE10", "TEAM5", "SHIPFREE"] } }));
    let x = await remove("CLUB-1001", "TEAM5");
    ok("removing a code that isn't on the order (any more): “That code isn't on this order.” (404)", refused(x, 404, "That code isn't on this order."));
    x = await remove("CLUB-1001", "SHIPFREE");
    ok("removing the free-shipping code puts the shipping back: shipping discount $0, owed $44.88 again", x.status === 200 && x.body.shippingDiscount === 0 && x.body.effectiveTotal === 44.88 && orderRow("CLUB-1001").totalCents === 4920);
    x = await remove("CLUB-1001", "SAVE10");
    ok("removing the last code leaves no discount at all: $0, an empty note, no codes", x.status === 200 && x.body.discountAmount === 0 && x.body.discountNote === "" && x.body.discountCode === "" &&
      same(x.body.discountCodes, []) && orderRow("CLUB-1001").discountTaxCents === 0);
    const again = await apply("CLUB-1001", "SAVE10");
    ok("a code given back can be put on the same order again (its released use is taken back)", again.status === 200 && same(live("CLUB-1001"), ["SAVE10"]) && uses("CLUB-1001").filter(u => u.code === "SAVE10").length === 1);
    await remove("CLUB-1001", "SAVE10");
  }

  console.log("\n=== Percent codes add up; amounts come off what is left ===");
  {
    await placeOrder("CLUB-1002", { qty: 1, unit: 30, shipping: 0 });
    addCode("SAVE15", { percentBps: 1500 });
    await apply("CLUB-1002", "TEAM5");
    const r = await apply("CLUB-1002", "SAVE15");
    // $30: 15% = $4.50 first, then $5.00 off what is left.
    ok("TEAM5 then SAVE15 on $30 of goods: 15% ($4.50) and $5.00 = $9.50, whatever order they were typed in", r.body.discountAmount === 9.5 &&
      same(uses("CLUB-1002").map(u => [u.code, u.amountCents]), [["TEAM5", 500], ["SAVE15", 450]]) && r.body.discountNote === "Codes TEAM5, SAVE15");
    const f = await apply("CLUB-1002", "FULL100");
    ok("a 100% code with them takes all the goods, never more: $30.00 off, and all the tax goes with it", f.body.discountAmount === 30 && f.body.effectiveTotal === 0 && orderRow("CLUB-1002").discountTaxCents === 240);
  }

  console.log("\n=== A code's own rules, checked against the order ===");
  await placeOrder("CLUB-1003");
  {
    const cases = [
      ["BIG50", "This code needs an order of at least $100.00.", "a code with a $100 minimum on $40 of goods"],
      ["BANDONLY", "This code isn't valid.", "a code for another shop"],
      ["LEEONLY", INVALID_EMAIL, "a code for another customer's email address"],
      ["OLDCODE", "This code has expired.", "a code that expired (in 2000)"],
      ["OFFCODE", "This code isn't valid.", "a code that is switched off"],
      ["NOSUCH", INVALID_EMAIL, "a code that doesn't exist"],
      ["!!", INVALID_EMAIL, "something that isn't a code at all"],
    ];
    for (const [code, msg, what] of cases) {
      const r = await apply("CLUB-1003", code);
      ok(what + ": “" + msg + "” (400), nothing taken", refused(r, 400, msg) && live("CLUB-1003").length === 0 && orderRow("CLUB-1003").discountCents === 0);
    }
    const p = await apply("CLUB-1003", "PATONLY");
    ok("a code for the order's own customer (pat@example.com) is taken: $3.00 off", p.status === 200 && p.body.discountAmount === 3);
    await remove("CLUB-1003", "PATONLY");
    await placeOrder("CLUB-1004", { contact: "lee@example.com" });
    ok("(ONCE is taken by one order)", (await apply("CLUB-1004", "ONCE")).status === 200);
    const r = await apply("CLUB-1003", "ONCE");
    ok("a code with its one use taken by another order: “This code has already been used.” (400)", refused(r, 400, "This code has already been used."));
    await placeOrder("CLUB-1005", { qty: 6 });   // $120 of goods
    ok("the $100-minimum code on $120 of goods is taken: $12.00 off", (await apply("CLUB-1005", "BIG50")).body.discountAmount === 12);
  }

  console.log("\n=== The request itself ===");
  {
    const n = d1.q("SELECT count(*) n FROM audit_log")[0].n;
    ok("no order id: “Invalid order ID” (400)", refused(await call({ action: "applyOrderDiscountCode", code: "SAVE10" }), 400, "Invalid order ID"));
    ok("an order id with characters an order id never has: “Invalid order ID” (400)", refused(await apply("CLUB 1003!", "SAVE10"), 400, "Invalid order ID"));
    ok("no code: “Enter a code.” (400)", refused(await call({ action: "applyOrderDiscountCode", orderId: "CLUB-1003" }), 400, "Enter a code."));
    ok("a code that is only spaces: “Enter a code.” (400)", refused(await apply("CLUB-1003", "   "), 400, "Enter a code."));
    ok("a code that isn't text: “Enter a code.” (400)", refused(await apply("CLUB-1003", 10), 400, "Enter a code."));
    ok("a code longer than 64 characters: “Enter a code.” (400)", refused(await apply("CLUB-1003", "A".repeat(65)), 400, "Enter a code."));
    ok("an order that doesn't exist: “Order not found” (404)", refused(await apply("CLUB-9999", "SAVE10"), 404, "Order not found"));
    ok("an order of another shop than the one the page names: “Order not found” (404)", refused(await apply("CLUB-1003", "SAVE10", { org: "band" }), 404, "Order not found"));
    ok("the same for taking a code off: no code, and an unknown order", refused(await call({ action: "removeOrderDiscountCode", orderId: "CLUB-1003" }), 400, "Enter a code.") &&
      refused(await remove("CLUB-9999", "SAVE10"), 404, "Order not found"));
    ok("none of these wrote to the audit log", d1.q("SELECT count(*) n FROM audit_log")[0].n === n);
    ok("the shop the page names, when it is the order's, is fine", (await apply("CLUB-1003", "SAVE10", { org: "club" })).status === 200);
    await remove("CLUB-1003", "SAVE10");
  }

  console.log("\n=== Orders that can't take a code now ===");
  {
    await placeOrder("CLUB-1010");
    await apply("CLUB-1010", "SAVE10");
    await M.voidOrder(d1, "CLUB-1010", "Example void");
    d1._raw.run("UPDATE discount_code_uses SET releasedAt = NULL WHERE orderId = 'CLUB-1010'");   // (as if the void hadn't given it back yet)
    let r = await apply("CLUB-1010", "TEAM5");
    ok("a void order: “This order can't take a code now.” (409)", refused(r, 409, NO_CODE_NOW));
    r = await remove("CLUB-1010", "SAVE10");
    ok("…nor have one taken off (409), its code left as it was", refused(r, 409, NO_CODE_NOW) && same(live("CLUB-1010"), ["SAVE10"]));
    await placeOrder("CLUB-1011");
    d1._raw.run("UPDATE orders SET completedAt = '2026-03-20T00:00:00Z' WHERE orderId = 'CLUB-1011'");
    ok("a completed order: the same (409)", refused(await apply("CLUB-1011", "SAVE10"), 409, NO_CODE_NOW));
    await placeOrder("CLUB-1012");
    d1._raw.run("UPDATE orders SET refundedAt = '2026-03-20T00:00:00Z' WHERE orderId = 'CLUB-1012'");
    ok("a fully refunded order: the same (409)", refused(await apply("CLUB-1012", "SAVE10"), 409, NO_CODE_NOW) && live("CLUB-1012").length === 0);
    const db1 = await M.applyOrderDiscountCode(d1, { orderId: "CLUB-1011", code: "SAVE10" });
    ok("db.js answers the refusal as { ok: false, reason, error }", db1.ok === false && db1.reason === NO_CODE_NOW && db1.error === NO_CODE_NOW);
    const nf = await M.applyOrderDiscountCode(d1, { orderId: "CLUB-404", code: "SAVE10" }), nf2 = await M.removeOrderDiscountCode(d1, { orderId: "CLUB-404", code: "SAVE10" });
    ok("db.js: an order that doesn't exist is “That order wasn't found.” both ways", nf.ok === false && nf.reason === "That order wasn't found." && nf2.reason === "That order wasn't found.");
    const nc = await M.removeOrderDiscountCode(d1, { orderId: "CLUB-1003", code: "" });
    ok("db.js: taking off no code at all is “That code isn't on this order.”", nc.ok === false && nc.reason === "That code isn't on this order.");
  }

  console.log("\n=== A manual discount and codes don't mix ===");
  {
    await placeOrder("CLUB-1020");
    let r = await call({ action: "setDiscount", orderId: "CLUB-1020", amount: 5, note: "Example courtesy" });
    ok("(a $5 manual discount is set on an order with no code)", r.status === 200 && r.body.discountAmount === 5);
    r = await apply("CLUB-1020", "SAVE10");
    ok("a code on an order with a manual discount: “This order has a discount; take it off first.” (400), the discount left as typed", refused(r, 400, "This order has a discount; take it off first.") &&
      orderRow("CLUB-1020").discountCents === 500 && orderRow("CLUB-1020").discountNote === "Example courtesy" && live("CLUB-1020").length === 0);
    await call({ action: "setDiscount", orderId: "CLUB-1020", amount: 0, note: "" });
    r = await apply("CLUB-1020", "SAVE10");
    ok("with the manual discount set back to $0 the code is taken", r.status === 200 && r.body.discountAmount === 4);
    const n = audits("order.discount_set").length;
    r = await call({ action: "setDiscount", orderId: "CLUB-1020", amount: 10, note: "Typed" });
    ok("setDiscount on an order with a code: “" + HAS_CODE + "” (409), and no audit row", refused(r, 409, HAS_CODE) && audits("order.discount_set").length === n);
    ok("…the code's discount is left as it was", orderRow("CLUB-1020").discountCents === 400 && orderRow("CLUB-1020").discountNote === "Code SAVE10");
    const db = await M.setOrderDiscount(d1, "CLUB-1020", 10, "Typed");
    ok("db.js setOrderDiscount refuses too, with the same sentence, and changes nothing", same(db, { error: HAS_CODE }) && orderRow("CLUB-1020").discountCents === 400);
    await remove("CLUB-1020", "SAVE10");
    const ok2 = await M.setOrderDiscount(d1, "CLUB-1020", 2.5, "Typed");
    ok("with the code taken off, setOrderDiscount sets a typed discount again ({ ok: true })", same(ok2, { ok: true }) && orderRow("CLUB-1020").discountCents === 250);
  }

  console.log("\n=== Paid status follows the code ===");
  {
    await placeOrder("CLUB-1030", { shipping: 0 });   // $40 + $3.20 tax = $43.20; with SAVE10, $38.88
    await M.addOrderPayment(d1, "CLUB-1030", 38.88, "Example cash", "", { method: "cash", receivedAt: "2026-03-11T15:00:00.000Z" });
    ok("(paid $38.88 of $43.20: not paid yet)", !orderRow("CLUB-1030").paid);
    let r = await apply("CLUB-1030", "SAVE10");
    ok("adding SAVE10 brings what is owed down to what was paid: the answer and the order say paid, nothing due", r.body.paid === true && r.body.balanceDue === 0 && !!orderRow("CLUB-1030").paid && !!orderRow("CLUB-1030").paidAt);
    r = await remove("CLUB-1030", "SAVE10");
    ok("taking it off again: not paid, $4.32 due", r.body.paid === false && r.body.balanceDue === 4.32 && !orderRow("CLUB-1030").paid);
  }

  console.log("\n=== Who may, the switch, and a closed month ===");
  {
    await placeOrder("CLUB-1040");
    const perm = roles.ACTION_PERM;
    ok("both actions need orders.payments at Edit, as setDiscount does", same(perm.applyOrderDiscountCode, [["orders.payments", "edit"]]) && same(perm.removeOrderDiscountCode, perm.setDiscount));
    let r = await as("production", { action: "applyOrderDiscountCode", orderId: "CLUB-1040", code: "SAVE10" });
    ok("Production can't add a code (403), nothing taken", r.status === 403 && live("CLUB-1040").length === 0);
    r = await as("staff", { action: "applyOrderDiscountCode", orderId: "CLUB-1040", code: "SAVE10" });
    ok("Back office (orders.payments Edit) can", r.status === 200 && same(live("CLUB-1040"), ["SAVE10"]));
    r = await as("production", { action: "removeOrderDiscountCode", orderId: "CLUB-1040", code: "SAVE10" });
    ok("Production can't take it off either (403)", r.status === 403 && same(live("CLUB-1040"), ["SAVE10"]));
    r = await as("manager", { action: "removeOrderDiscountCode", orderId: "CLUB-1040", code: "SAVE10" });
    ok("Manager can take it off", r.status === 200 && live("CLUB-1040").length === 0);
    globalThis.__feat389 = { discounts: false };
    r = await apply("CLUB-1040", "SAVE10");
    const r2 = await remove("CLUB-1040", "SAVE10");
    ok("with Discount codes switched off both answer 403 “" + OFF + "” naming the feature", r.status === 403 && r.body.feature === "discounts" && r.body.message === OFF && r2.status === 403 && r2.body.feature === "discounts");
    r = await as("production", { action: "applyOrderDiscountCode", orderId: "CLUB-1040", code: "SAVE10" });
    ok("…and someone who may not use them still hears only that they may not (403, no feature named)", r.status === 403 && r.body.feature === undefined);
    globalThis.__feat389 = {};
    await placeOrder("CLUB-0901", { placedAt: "2025-02-10T15:00:00.000Z" });
    await apply("CLUB-0901", "TEAM5");
    d1._raw.run("INSERT INTO closed_periods (month, closedAt, closedBy) VALUES ('2025-02', '2025-03-05T00:00:00Z', 'test')");
    r = await apply("CLUB-0901", "SAVE10");
    ok("an order placed in a closed month (February 2025) takes no code: 409, saying the month is closed", r.status === 409 && /^February 2025 is closed/.test(r.body.message) && same(live("CLUB-0901"), ["TEAM5"]));
    r = await remove("CLUB-0901", "TEAM5");
    ok("…and keeps the one it has (409)", r.status === 409 && /^February 2025 is closed/.test(r.body.message) && same(live("CLUB-0901"), ["TEAM5"]));
    ok("the period guard knows both actions by the order's month", /\["setDiscount", "applyOrderDiscountCode", "removeOrderDiscountCode",/.test(read("functions/api/orders.js")));
  }

  console.log("\n=== The stored total follows free shipping with tax in the prices too ===");
  {
    await M.setSalesTaxSettings(d1, { rateBps: 800, jurisdiction: "Example County", taxMode: "inclusive" });
    await placeOrder("CLUB-1050");   // $40 with tax inside, $6 shipping: 4600¢
    ok("(an order with tax in the prices: stored total 4600¢)", orderRow("CLUB-1050").totalCents === 4600 && orderRow("CLUB-1050").taxMode === "inclusive");
    const r = await apply("CLUB-1050", "SHIPFREE");
    ok("free shipping on it: owed $40.00, and the stored total is $40.00 too (the shipping discount taken off, as with tax on top)", r.body.effectiveTotal === 40 && orderRow("CLUB-1050").totalCents === 4000);
    await remove("CLUB-1050", "SHIPFREE");
    ok("taking it off puts the stored total back to 4600¢", orderRow("CLUB-1050").totalCents === 4600);
    await M.setSalesTaxSettings(d1, { rateBps: 800, jurisdiction: "Example County", taxMode: "exclusive" });
  }

  console.log("\n=== A database from before migrations/0120 (one code per order, no shipping discount) ===");
  {
    const old = await freshDb("0120");
    const oenv = { DB: old, ...MAIL_ENV };
    old._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('club','club','Example Club','t','t',1);`);
    await M.createProduct(old, "club", { productId: "cap", type: "cap", name: "Club cap", pricingMode: "flat", flatPrice: 20, visible: true, noDesignNeeded: true });
    await M.insertOrder(old, { orderId: "CLUB-2001", orgId: "club", customerName: "Pat Example", contact: "pat@example.com", phone: "555-0100", paymentMethod: "", subtotal: 40, shippingCost: 0, total: 40,
      shippingMethod: "", shippingAddress: null, totalWeightOz: 0, placedAt: "2026-03-10T15:00:00.000Z" }, [{ productId: "cap", name: "Club cap", type: "cap", size: "", qty: 2, unitPrice: 20, personalized: false, persName: "", personalizationFee: 0 }]);
    old._raw.run("INSERT INTO discount_codes (code, kind, percentBps, maxUses, createdAt) VALUES ('SAVE10','percent',1000,5,'t')");
    const r = await callWith(oenv, { action: "applyOrderDiscountCode", orderId: "CLUB-2001", code: "SAVE10" });
    ok("Add code answers 503 “" + NOT_READY + "” instead of failing", refused(r, 503, NOT_READY));
    ok("…and the order is left as it was, with no use of the code", old.q("SELECT discountCents FROM orders")[0].discountCents === 0 && old.q("SELECT count(*) n FROM discount_code_uses")[0].n === 0);
    // A code put on the order before the update (one code, 0115's way).
    old._raw.run("INSERT INTO discount_code_uses (codeId, orderId, email, amountCents, usedAt) VALUES (1, 'CLUB-2001', 'pat@example.com', 400, 't')");
    old._raw.run("UPDATE orders SET discountCents = 400, discountNote = 'Code SAVE10' WHERE orderId = 'CLUB-2001'");
    const x = await callWith(oenv, { action: "removeOrderDiscountCode", orderId: "CLUB-2001", code: "SAVE10" });
    ok("taking that code off answers 503 with the same sentence instead of failing", refused(x, 503, NOT_READY));
    ok("…and gives nothing back: the code's use and the order's discount stay as they were", old.q("SELECT releasedAt FROM discount_code_uses")[0].releasedAt === null &&
      old.q("SELECT discountCents FROM orders")[0].discountCents === 400);
    const none = await freshDb("0115");
    none._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('club','club','Example Club','t','t',1);`);
    await M.createProduct(none, "club", { productId: "cap", type: "cap", name: "Club cap", pricingMode: "flat", flatPrice: 20, visible: true, noDesignNeeded: true });
    await M.insertOrder(none, { orderId: "CLUB-2002", orgId: "club", customerName: "Pat Example", contact: "pat@example.com", phone: "", paymentMethod: "", subtotal: 20, shippingCost: 0, total: 20,
      shippingMethod: "", shippingAddress: null, totalWeightOz: 0, placedAt: "2026-03-10T15:00:00.000Z" }, [{ productId: "cap", name: "Club cap", type: "cap", size: "", qty: 1, unitPrice: 20, personalized: false, persName: "", personalizationFee: 0 }]);
    ok("(an order on a database from before discount codes)", !!none.q("SELECT 1 FROM orders WHERE orderId = 'CLUB-2002'")[0]);
    const d = await M.applyOrderDiscountCode(none, { orderId: "CLUB-2002", code: "SAVE10" }), e = await M.removeOrderDiscountCode(none, { orderId: "CLUB-2002", code: "SAVE10" });
    ok("before discount codes at all (0115): db.js answers “not ready”, flagged notReady, both ways", d.ok === false && d.reason === NOT_READY && d.notReady === true && e.reason === NOT_READY && e.notReady === true);
  }

  // =================================================================================================================
  // 3. Quotes
  // =================================================================================================================
  await M.setDiscountRules(d1, { multiple: false });
  // Pat's customer record was made with the first order (an order's email makes one).
  const PAT = d1.q("SELECT id FROM customers WHERE email = 'pat@example.com'")[0].id;
  const LINES = [{ kind: "custom", name: "Club banner", qty: 1, unitPrice: 40, taxable: true }, { kind: "custom", name: "Example service", qty: 1, unitPrice: 10, taxable: false }];
  const newQuote = async (extra) => {
    const c = await call({ action: "createEstimate", org: "club", customerId: PAT, title: "Example quote", expiresOn: "2099-12-31" });
    const s = await call(Object.assign({ action: "saveEstimate", id: c.body.id, items: LINES }, extra || {}));
    if (s.status !== 200) throw new Error("seed quote: " + JSON.stringify(s.body));
    return c.body.id;
  };
  const estRow = (id) => d1.q("SELECT * FROM estimates WHERE id = ?", id)[0];

  console.log("\n=== setEstimateDiscountCodes (db.js) ===");
  {
    const id = await newQuote();
    let r = await M.setEstimateDiscountCodes(d1, id, [" save10 "]);
    ok("a code is saved on a draft, normalized (SAVE10), with the quote before and after", r.ok === true && same(r.codes, ["SAVE10"]) && same(r.before.discountCodes, []) && same(r.after.discountCodes, ["SAVE10"]) &&
      estRow(id).discountCodes === '["SAVE10"]');
    r = await M.setEstimateDiscountCodes(d1, id, "TEAM5");
    ok("one code given as text (not a list) is saved as a list of one", r.ok === true && same(r.codes, ["TEAM5"]));
    r = await M.setEstimateDiscountCodes(d1, id, null);
    ok("null (or \"\") takes every code off", r.ok === true && same(r.codes, []) && estRow(id).discountCodes === "[]" && (await M.setEstimateDiscountCodes(d1, id, "")).ok === true);
    r = await M.setEstimateDiscountCodes(d1, id, ["SAVE10", "TEAM5"]);
    ok("two codes while the shop takes one: “" + ONE_CODE + "”, nothing saved", r.error === ONE_CODE && estRow(id).discountCodes === "[]");
    const fmt = "A discount code is 3 to 32 letters, digits, - or _, and each code can be on a quote once.";
    ok("a code that isn't one (“ab”): “" + fmt + "”", (await M.setEstimateDiscountCodes(d1, id, ["ab"])).error === fmt);
    ok("the same code twice (in any case): the same sentence", (await M.setEstimateDiscountCodes(d1, id, ["SAVE10", "save10"])).error === fmt);
    await M.setDiscountRules(d1, { multiple: true });
    r = await M.setEstimateDiscountCodes(d1, id, ["SAVE10", "TEAM5"]);
    ok("with more than one allowed, two codes are saved in the order typed", r.ok === true && same(r.codes, ["SAVE10", "TEAM5"]));
    ok("six codes: “At most 5 discount codes can be used on a quote.”", (await M.setEstimateDiscountCodes(d1, id, ["AAA1", "AAA2", "AAA3", "AAA4", "AAA5", "AAA6"])).error === "At most 5 discount codes can be used on a quote.");
    await M.setDiscountRules(d1, { multiple: false });
    ok("a quote that doesn't exist: “That quote wasn't found.”", (await M.setEstimateDiscountCodes(d1, 99999, ["SAVE10"])).error === "That quote wasn't found.");
    d1._raw.run("UPDATE estimates SET status = 'sent', sentAt = '2026-03-01T00:00:00Z' WHERE id = ?", [id]);
    ok("a sent quote can't have its codes changed: “This quote has been sent. …”", /^This quote has been sent\./.test((await M.setEstimateDiscountCodes(d1, id, [])).error || "") && estRow(id).discountCodes === '["SAVE10","TEAM5"]');
  }

  console.log("\n=== A quote's totals with codes ===");
  {
    const id = await newQuote();
    let g = await M.getEstimate(d1, id);
    ok("without codes the totals have no discount fields: $50 of goods, $3.20 tax on the $40 taxable, $53.20", g.totals.subtotal === 50 && g.totals.tax === 3.2 && g.totals.total === 53.2 &&
      g.totals.discount === undefined && g.totals.discountCodes === undefined && g.totals.freeShipping === undefined && same(g.estimate.discountCodes, []));
    await M.setEstimateDiscountCodes(d1, id, ["SAVE10"]);
    g = await M.getEstimate(d1, id);
    ok("with SAVE10: $5.00 off the $50, the tax share of it (32¢) off the tax: tax $2.88, total $47.88", g.totals.subtotal === 50 && g.totals.discount === 5 && g.totals.tax === 2.88 && g.totals.total === 47.88);
    ok("…each code listed with what it took, whether it makes shipping free, and its label", same(g.totals.discountCodes, [{ code: "SAVE10", discount: 5, freeShipping: false, label: "10% off" }]) && g.totals.freeShipping === false);
    ok("…and the quote itself carries its codes", same(g.estimate.discountCodes, ["SAVE10"]));
    await M.setDiscountRules(d1, { multiple: true });
    await M.setEstimateDiscountCodes(d1, id, ["TEAM5", "SAVE10", "SHIPFREE"]);
    g = await M.getEstimate(d1, id);
    ok("TEAM5, SAVE10 and SHIPFREE: 10% first ($5.00), then $5.00: $10.00 off, tax $2.56, total $42.56", g.totals.discount === 10 && g.totals.tax === 2.56 && g.totals.total === 42.56);
    ok("…listed in the order typed, the free-shipping code taking nothing off the goods and saying it makes shipping free", same(g.totals.discountCodes.map(c => [c.code, c.discount, c.freeShipping]), [["TEAM5", 5, false], ["SAVE10", 5, false], ["SHIPFREE", 0, true]]) && g.totals.freeShipping === true);
    const list = await M.listEstimates(d1, { orgId: "club" });
    ok("the Quotes list shows the same total for it ($42.56)", list.estimates.find(e => e.id === id).total === 42.56);
    await M.setEstimateDiscountCodes(d1, id, ["FULL100"]);
    g = await M.getEstimate(d1, id);
    ok("a 100% code: all $50 off and all the tax with it: total $0", g.totals.discount === 50 && g.totals.tax === 0 && g.totals.total === 0);
    await M.setEstimateDiscountCodes(d1, id, ["GONECODE", "SAVE10"]);
    g = await M.getEstimate(d1, id);
    ok("a code that no longer exists is left out of the totals (the quote still lists it)", g.totals.discount === 5 && same(g.totals.discountCodes.map(c => c.code), ["SAVE10"]) && same(g.estimate.discountCodes, ["GONECODE", "SAVE10"]));
    await M.setSalesTaxSettings(d1, { rateBps: 800, jurisdiction: "Example County", taxMode: "inclusive" });
    await M.setEstimateDiscountCodes(d1, id, ["SAVE10"]);
    g = await M.getEstimate(d1, id);
    // Tax inside $40: 2.96; the discount's share: tax inside $4.00 = 30¢.
    ok("with tax in the prices: total $45.00 ($50 − $5), the tax in it $2.66 (2.96 less the 30¢ inside the discount)", g.totals.total === 45 && g.totals.discount === 5 && g.totals.tax === 2.66);
    await M.setSalesTaxSettings(d1, { rateBps: 800, jurisdiction: "Example County", taxMode: "exclusive" });
    await M.setDiscountRules(d1, { multiple: false });
  }

  console.log("\n=== saveEstimate with discountCodes ===");
  {
    const id = await newQuote();
    let r = await call({ action: "saveEstimate", id, discountCodes: ["save10"] });
    ok("saveEstimate saves the codes and answers the quote with them on: $47.88", r.status === 200 && same(r.body.estimate.discountCodes, ["SAVE10"]) && r.body.totals.total === 47.88 && r.body.totals.discount === 5);
    const a = lastAudit("estimate.saved");
    ok("the save is audited with the codes from and to", !!a && same(a.detail.changes.discountCodes, { from: [], to: ["SAVE10"] }));
    const n = audits("estimate.saved").length;
    r = await call({ action: "saveEstimate", id, discountCodes: ["SAVE10"] });
    ok("saving the same codes again changes nothing and logs nothing", r.status === 200 && audits("estimate.saved").length === n);
    r = await call({ action: "saveEstimate", id, discountCode: "TEAM5" });
    ok("one code sent as discountCode is a list of one: TEAM5 replaces SAVE10", r.status === 200 && same(r.body.estimate.discountCodes, ["TEAM5"]));
    r = await call({ action: "saveEstimate", id, discountCodes: "SAVE10" });
    ok("discountCodes that isn't a list: “This code isn't valid.” (400)", refused(r, 400, "This code isn't valid."));
    r = await call({ action: "saveEstimate", id, discountCodes: ["AAA1", "AAA2", "AAA3", "AAA4", "AAA5", "AAA6"] });
    ok("six codes: “At most 5 discount codes can be used on an order.” (400)", refused(r, 400, "At most 5 discount codes can be used on an order."));
    r = await call({ action: "saveEstimate", id, discountCodes: ["SAVE10", "TEAM5"] });
    ok("two codes while the shop takes one: “" + ONE_CODE + "” (400), the quote keeps TEAM5", refused(r, 400, ONE_CODE) && estRow(id).discountCodes === '["TEAM5"]');
    r = await call({ action: "saveEstimate", id, discountCodes: ["ab"] });
    ok("a code that isn't one: refused (409) with what a code is", r.status === 409 && /^A discount code is 3 to 32 letters/.test(r.body.message));
    globalThis.__feat389 = { discounts: false };
    r = await call({ action: "saveEstimate", id, discountCodes: ["SAVE10"] });
    ok("with Discount codes switched off, a code can't be put on a quote (403, feature discounts)", r.status === 403 && r.body.feature === "discounts" && estRow(id).discountCodes === '["TEAM5"]');
    r = await call({ action: "saveEstimate", id, discountCodes: [] });
    ok("…but every code can still be taken off (200)", r.status === 200 && same(r.body.estimate.discountCodes, []));
    globalThis.__feat389 = {};
    await call({ action: "saveEstimate", id, discountCodes: ["SAVE10"] });
    await call({ action: "sendEstimate", id });
    r = await call({ action: "saveEstimate", id, discountCodes: [] });
    ok("a sent quote can't have its codes changed: 409 “This quote was sent: …”", r.status === 409 && /^This quote was sent: its lines can't change/.test(r.body.message) && estRow(id).discountCodes === '["SAVE10"]');
    r = await call({ action: "saveEstimate", id, discountCodes: ["save10"], internalNote: "Example note" });
    ok("…but saving its internal note with the same codes sent along (in any case) is fine", r.status === 200 && r.body.estimate.internalNote === "Example note");
  }

  console.log("\n=== sendEstimate checks the codes again ===");
  {
    const id = await newQuote({ discountCodes: ["ONCE2"] });
    addCode("ONCE2", { maxUses: 1 });
    const t = await newQuote();
    d1._raw.run("UPDATE estimates SET discountCodes = '[\"ONCE2\"]' WHERE id = ?", [id]);
    mail.length = 0;
    let r = await call({ action: "sendEstimate", id });
    ok("a quote with a good code is sent (200), the email showing the discount", r.status === 200 && r.body.emailSent === true && mail.length === 1 && /Discount \(ONCE2\)/.test(mail[0].body));
    // ONCE2's one use is taken by an order meanwhile.
    await placeOrder("CLUB-1100");
    await apply("CLUB-1100", "ONCE2");
    mail.length = 0;
    const before = estRow(id).sendCount;
    r = await call({ action: "sendEstimate", id });
    ok("sent again after its code was used up: 409 “This code has already been used.”, no email, not counted as sent", refused(r, 409, "This code has already been used.") && mail.length === 0 && estRow(id).sendCount === before);
    d1._raw.run("UPDATE estimates SET discountCodes = '[\"OLDCODE\"]' WHERE id = ?", [t]);
    r = await call({ action: "sendEstimate", id: t });
    ok("a draft with an expired code isn't sent: 409 “This code has expired.”, still a draft", refused(r, 409, "This code has expired.") && estRow(t).status === "draft" && mail.length === 0);
    d1._raw.run("UPDATE estimates SET discountCodes = '[\"LEEONLY\"]' WHERE id = ?", [t]);
    r = await call({ action: "sendEstimate", id: t, email: "lee@example.com" });
    ok("the code is checked against the address it is sent to: LEEONLY sent to lee@example.com goes", r.status === 200 && r.body.sentTo === "lee@example.com");
    // A fee line isn't goods: a $100-minimum code on $50 of goods and a $60 setup fee is checked against the $50, as the
    // quote editor checks it before it is put on.
    const feeLines = LINES.concat([{ kind: "fee", feeKind: "setup", name: "Setup", amount: 60, taxable: false }]);
    const withFee = await newQuote({ items: feeLines });
    d1._raw.run("UPDATE estimates SET discountCodes = '[\"BIG50\"]' WHERE id = ?", [withFee]);
    mail.length = 0;
    ok("(the quote's subtotal with the fee is $110)", (await M.getEstimate(d1, withFee)).totals.subtotal === 110);
    r = await call({ action: "sendEstimate", id: withFee });
    ok("a $100-minimum code on $50 of goods plus a $60 setup fee isn't sent: 409 “This code needs an order of at least $100.00.” (the fee isn't goods)",
      refused(r, 409, "This code needs an order of at least $100.00.") && mail.length === 0 && estRow(withFee).status === "draft");
    const cv = await call({ action: "convertEstimate", id: withFee });
    ok("…and isn't made into an order either: the same 409, no order", refused(cv, 409, "This code needs an order of at least $100.00.") && !estRow(withFee).orderId);
  }

  console.log("\n=== A quote becoming an order claims its codes ===");
  {
    await M.setDiscountRules(d1, { multiple: true });
    const id = await newQuote({ discountCodes: ["SAVE10", "TEAM5"] });
    await call({ action: "sendEstimate", id });
    const r = await call({ action: "convertEstimate", id });
    const oid = r.body.orderId;
    ok("Convert to order makes the order (200)", r.status === 200 && !!oid);
    const o = await M.getOrderById(d1, oid);
    ok("the order has the quote's codes and their discount: $10.00, “Codes SAVE10, TEAM5”", o.discountAmount === 10 && o.discountNote === "Codes SAVE10, TEAM5" && same(o.discountCodes, ["SAVE10", "TEAM5"]));
    ok("…and comes to the quote's total ($42.56)", o.effectiveTotal === 42.56 && (await M.getEstimate(d1, id)).totals.total === 42.56);
    ok("one use of each code is taken for the order, with its share", same(uses(oid).map(u => [u.code, u.amountCents, u.email]), [["SAVE10", 500, "pat@example.com"], ["TEAM5", 500, "pat@example.com"]]));
    const a = lastAudit("estimate.converted");
    ok("the conversion's audit row names the codes and the discount", !!a && same(a.detail.discountCodes, ["SAVE10", "TEAM5"]) && a.detail.discount === 10);
    const again = await call({ action: "convertEstimate", id });
    ok("converting again answers the same order and takes no more uses", again.body.orderId === oid && again.body.repeated === true && uses(oid).length === 2);

    const stale = await newQuote({ discountCodes: ["SAVE10"] });
    d1._raw.run("UPDATE estimates SET discountCodes = '[\"OLDCODE\"]' WHERE id = ?", [stale]);
    const s = await call({ action: "convertEstimate", id: stale });
    ok("a quote whose code has expired isn't made into an order: 409 “This code has expired.”, no order, no use", refused(s, 409, "This code has expired.") && !estRow(stale).orderId &&
      d1.q("SELECT count(*) n FROM orders WHERE orderId LIKE 'CLUB-Q%' AND orderId = ?", "CLUB-" + estRow(stale).number.replace(/[^A-Za-z0-9]/g, ""))[0].n === 0);
    ok("a quote without codes still converts with no discount", (await M.getOrderById(d1, (await call({ action: "convertEstimate", id: await newQuote() })).body.orderId)).discountAmount === 0);

    // A use refused at the last moment (another order took the last one between the check and the claim).
    const race = await newQuote({ discountCodes: ["SAVE10"] });
    const noClaim = Object.assign({}, d1, { prepare: (sql) => {
      const st = d1.prepare(sql);
      if (!/^INSERT INTO discount_code_uses/.test(sql.trim())) return st;
      return Object.assign({}, st, { bind: (...p) => Object.assign({}, st.bind(...p), { run: async () => ({ success: true, meta: { changes: 0 } }) }) });
    } });
    const c1 = await M.convertEstimateToOrder_({ DB: noClaim, ...MAIL_ENV }, race);
    ok("the claim refused at the last moment: { error: “This code has reached its limit.”, status 409 }, no order made", c1.error === "This code has reached its limit." && c1.status === 409 && !c1.orderId && !estRow(race).orderId);
    // The order's insert failing after the codes were claimed: the uses are given back.
    const boom = await newQuote({ discountCodes: ["TEAM5"] });
    const failing = Object.assign({}, d1, { batch: async (stmts) => { if (stmts.some(s => /^INSERT INTO orders/.test(String(s._sql).trim()))) throw new Error("Example write failure"); return d1.batch(stmts); } });
    let threw = null;
    try { await M.convertEstimateToOrder_({ DB: failing, ...MAIL_ENV }, boom); } catch (e) { threw = e; }
    const boomOrder = "CLUB-" + estRow(boom).number.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    ok("the order's write failing after the codes were claimed: the failure goes up, and the code's use is given back", !!threw && threw.message === "Example write failure" &&
      uses(boomOrder).length === 1 && uses(boomOrder)[0].releasedAt != null);
    ok("…so trying again later makes the order with the code (its released use taken back)", (await M.convertEstimateToOrder_(env, boom)).orderId === boomOrder && same(live(boomOrder), ["TEAM5"]));
    await M.setDiscountRules(d1, { multiple: false });
  }

  console.log("\n=== The customer's quote page (functions/api/estimate.js) ===");
  {
    await M.setDiscountRules(d1, { multiple: true });
    const ipN = { n: 0 };
    const hdr = () => { const ip = "198.51.100." + (++ipN.n); return { get: (k) => (/cf-connecting-ip/i.test(k) ? ip : null) }; };
    const get = async (token) => { const res = await M.estimateApi.onRequestGet({ env, request: { url: "https://club.example.com/api/estimate?token=" + token, headers: hdr() } }); return { status: res.status, body: JSON.parse(await res.text()) }; };
    const post = async (body) => { const waits = []; const res = await M.estimateApi.onRequestPost({ env, waitUntil: (p) => waits.push(Promise.resolve(p)),
      request: { url: "https://club.example.com/api/estimate", headers: hdr(), json: async () => body } }); await Promise.all(waits); return { status: res.status, body: JSON.parse(await res.text()) }; };
    const id = await newQuote({ discountCodes: ["SAVE10", "TEAM5"] });
    const sent = await call({ action: "sendEstimate", id });
    const token = /estimate=([a-z0-9]+)$/.exec(sent.body.link)[1];
    let v = await get(token);
    ok("the customer's view lists the codes, the discount in all ($10.00) and each code's share", v.status === 200 && same(v.body.estimate.discountCodes, ["SAVE10", "TEAM5"]) && v.body.estimate.discount === 10 &&
      same(v.body.estimate.discounts, [{ code: "SAVE10", amount: 5 }, { code: "TEAM5", amount: 5 }]));
    ok("…no shipping taken off (a quote has no shipping), and the lower total and tax", v.body.estimate.shippingOff === 0 && v.body.estimate.total === 42.56 && v.body.estimate.tax === 2.56 && v.body.estimate.subtotal === 50);
    const plainId = await newQuote();
    const plainTok = /estimate=([a-z0-9]+)$/.exec((await call({ action: "sendEstimate", id: plainId })).body.link)[1];
    v = await get(plainTok);
    ok("a quote without codes shows an empty list, no discount and none per code", same(v.body.estimate.discountCodes, []) && v.body.estimate.discount === 0 && same(v.body.estimate.discounts, []) && v.body.estimate.shippingOff === 0);
    const acc = await post({ token, action: "accept" });
    ok("the customer accepts: the order is made with the codes' $10.00 discount", acc.status === 200 && !!acc.body.orderId && (await M.getOrderById(d1, acc.body.orderId)).discountAmount === 10 &&
      same(live(acc.body.orderId), ["SAVE10", "TEAM5"]));
    // A code that ran out between the send and the customer's Accept.
    addCode("ONCE3", { maxUses: 1 });
    const lateId = await newQuote({ discountCodes: ["ONCE3"] });
    const lateTok = /estimate=([a-z0-9]+)$/.exec((await call({ action: "sendEstimate", id: lateId })).body.link)[1];
    await placeOrder("CLUB-1101");
    await apply("CLUB-1101", "ONCE3");
    const issuesBefore = d1.q("SELECT COALESCE(SUM(n), 0) n FROM system_issues")[0].n;
    const late = await quietly(() => post({ token: lateTok, action: "accept" }));
    ok("accepted after its code was used up: the acceptance stands (200) but no order is made yet", late.status === 200 && late.body.orderId === "" && estRow(lateId).status === "accepted" && !estRow(lateId).orderId);
    ok("…and the owner is told why (a system issue naming the code's reason)", d1.q("SELECT COALESCE(SUM(n), 0) n FROM system_issues")[0].n === issuesBefore + 1 &&
      /couldn't be made — This code has already been used\./.test(d1.q("SELECT sample FROM system_issues ORDER BY at DESC, id DESC LIMIT 1")[0].sample));
    await M.setDiscountRules(d1, { multiple: false });
  }

  console.log("\n=== The quote email's lines ===");
  {
    const est = { number: "Q-00077", sentTo: "pat@example.com", discountCodes: ["SAVE10"] };
    const items = [{ kind: "custom", name: "Club banner", qty: 1, unitPrice: 40, lineTotal: 40, taxable: true }];
    let m = M.buildEstimateEmail({ estimate: est, items, totals: { subtotal: 40, tax: 2.88, total: 38.88, taxMode: "exclusive", taxRateBps: 800, discount: 4,
      discountCodes: [{ code: "SAVE10", discount: 4, freeShipping: false }] }, orgName: "Example Club", link: "https://club.example.com/?estimate=abc" });
    ok("one code: a line “Discount (SAVE10)” for −$4.00 under the Subtotal, then the tax and the lower Total", /Subtotal[^\n]*\$40\.00[\s\S]*Discount \(SAVE10\)[^\n]*−\$4\.00[\s\S]*Sales tax \(8%\)[^\n]*\$2\.88[\s\S]*Total[^\n]*\$38\.88/.test(m.text) &&
      /Discount \(SAVE10\)/.test(m.html) && /−\$4\.00/.test(m.html));
    ok("…and the subject has the lower total", /· \$38\.88$/.test(m.subject));
    m = M.buildEstimateEmail({ estimate: { ...est, discountCodes: ["SAVE10", "TEAM5"] }, items, totals: { subtotal: 40, tax: 2.4, total: 32.4, taxMode: "exclusive", taxRateBps: 800, discount: 9,
      discountCodes: [{ code: "SAVE10", discount: 4 }, { code: "TEAM5", discount: 5 }] }, orgName: "Example Club" });
    ok("two codes: a line for each (“Discount (SAVE10)” −$4.00, “Discount (TEAM5)” −$5.00)", /Discount \(SAVE10\)[^\n]*−\$4\.00/.test(m.text) && /Discount \(TEAM5\)[^\n]*−\$5\.00/.test(m.text) && !/Discount \(SAVE10, TEAM5\)/.test(m.text));
    m = M.buildEstimateEmail({ estimate: { ...est, discountCodes: [] }, items, totals: { subtotal: 40, tax: 0, total: 30, taxMode: "inclusive", discount: 4, shippingOff: 6 }, orgName: "Example Club" });
    ok("a discount with no code named is “Discount”, and shipping taken off is a “Free shipping” line", m.text.split("\n").includes("Discount: −$4.00") && m.text.split("\n").includes("Free shipping: −$6.00"));
    m = M.buildEstimateEmail({ estimate: { ...est, discountCodes: [] }, items, totals: { subtotal: 40, tax: 3.2, total: 43.2, taxMode: "exclusive", taxRateBps: 800 }, orgName: "Example Club" });
    ok("no codes: no Discount and no Free shipping line", !/Discount|Free shipping/.test(m.text) && !/Discount|Free shipping/.test(m.html));
    const dv = M.estimateDiscountView({ discountAmount: 3, shippingDiscount: 2, perCode: [{ code: "A1B", goodsOff: 3 }] }, null);
    ok("the view reads other spellings too (discountAmount, shippingDiscount, perCode with goodsOff)", dv.discount === 3 && dv.shippingOff === 2 && same(dv.per, [{ code: "A1B", amount: 3 }]) && same(dv.codes, []));
    const dv2 = M.estimateDiscountView({ discounts: [{ code: "X1Y", amount: 2 }, { code: "Z1Z", amount: 0 }], discountCodes: ["X1Y"] });
    ok("…a discounts list (codes with nothing taken left out), and the codes from the totals when none are given", same(dv2.per, [{ code: "X1Y", amount: 2 }]) && dv2.discount === 2 && same(dv2.codes, ["X1Y"]));
    const dv3 = M.estimateDiscountView(null, undefined);
    ok("…and nothing at all: no codes, $0", same(dv3, { codes: [], discount: 0, per: [], shippingOff: 0 }));
  }

  console.log("\n=== Quotes on a database from before migrations/0120 ===");
  {
    const old = await freshDb("0120");
    const oenv = { DB: old, ...MAIL_ENV };
    old._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('club','club','Example Club','t','t',1);`);
    const cid = (await callWith(oenv, { action: "saveCustomer", name: "Pat Example", email: "pat@example.com", phone: "555-0100" })).body.id;
    const qid = (await callWith(oenv, { action: "createEstimate", org: "club", customerId: cid, expiresOn: "2099-12-31" })).body.id;
    const sv = await callWith(oenv, { action: "saveEstimate", id: qid, items: LINES });
    ok("a quote still saves and reads, with an empty list of codes and no discount", sv.status === 200 && same(sv.body.estimate.discountCodes, []) && sv.body.totals.discount === undefined);
    const r = await callWith(oenv, { action: "saveEstimate", id: qid, discountCodes: ["SAVE10"] });
    ok("putting a code on it answers 409 “" + NOT_READY + "”", refused(r, 409, NOT_READY));
    ok("db.js says the same", (await M.setEstimateDiscountCodes(old, qid, ["SAVE10"])).error === NOT_READY);
    const none = await freshDb("0115");
    none._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('club','club','Example Club','t','t',1);`);
    const nenv = { DB: none, ...MAIL_ENV };
    const cid2 = (await callWith(nenv, { action: "saveCustomer", name: "Pat Example", email: "pat@example.com", phone: "555-0100" })).body.id;
    const qid2 = (await callWith(nenv, { action: "createEstimate", org: "club", customerId: cid2, expiresOn: "2099-12-31" })).body.id;
    await callWith(nenv, { action: "saveEstimate", id: qid2, items: LINES });
    none._raw.exec("ALTER TABLE estimates ADD COLUMN discountCodes TEXT NOT NULL DEFAULT '[]'");
    none._raw.run("UPDATE estimates SET discountCodes = '[\"SAVE10\"]' WHERE id = ?", [qid2]);
    const g = await M.getEstimate(none, qid2);
    ok("with no discount code tables at all, a quote's codes add nothing to its totals ($50, no discount)", g.totals.total === 50 && g.totals.subtotal === 50 && g.totals.discount === undefined && same(g.estimate.discountCodes, ["SAVE10"]));
    const s = await callWith(nenv, { action: "sendEstimate", id: qid2 });
    ok("sending it answers 503 “" + NOT_READY + "”", refused(s, 503, NOT_READY));
    const c = await M.convertEstimateToOrder_(nenv, qid2);
    ok("converting it answers { error: not ready, status 503 }", c.error === NOT_READY && c.status === 503);
  }

  // =================================================================================================================
  // 4. The quote editor's Discount codes box (public/admin-quotes.js)
  // =================================================================================================================
  {
    const { JSDOM, ResourceLoader, VirtualConsole } = require("jsdom");
    const { storefrontPage } = require("./testlib/storefront-page");
    const adminJs = read("public/admin.js"), custJs = read("public/admin-customers.js"), quotesJs = read("public/admin-quotes.js");
    const reply = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
    const boot = async (role) => {
      const P = { sent: [], toasts: [], queue: [] };
      P.script = (action, spec) => P.queue.push(Object.assign({ action }, spec));
      class Loader extends ResourceLoader {
        fetch(url) {
          if (/\/admin-quotes\.js(\?|$)/.test(url)) return Promise.resolve(Buffer.from(quotesJs));
          if (/\/admin-customers\.js(\?|$)/.test(url)) return Promise.resolve(Buffer.from(custJs));
          if (/\/admin\.js(\?|$)/.test(url)) return Promise.resolve(Buffer.from(adminJs));
          return Promise.resolve(Buffer.from(""));
        }
      }
      const vc = new VirtualConsole();
      vc.sendTo(console, { omitJSDOMErrors: true });
      vc.on("jsdomError", (e) => { if (!/Not implemented|Could not load script/.test(e.message)) console.error(e); });
      const dom = new JSDOM(storefrontPage(), { runScripts: "dangerously", resources: new Loader(), virtualConsole: vc, url: "https://admin.example.com/", pretendToBeVisual: true,
        beforeParse(win) {
          win.CSS = win.CSS || { escape: (s) => String(s).replace(/["\\]/g, "\\$&") };
          win.fetch = async (url, init) => {
            const u = String(url), b = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
            if (!u.includes("/api/orders")) return reply(404, { status: "error", message: "not here" });
            P.sent.push(b);
            const i = P.queue.findIndex(s => s.action === b.action);
            const s = i >= 0 ? P.queue.splice(i, 1)[0] : null;
            if (s && s.reject) throw s.reject;
            if (s && s.body !== undefined) return reply(s.status || 200, s.body);
            const x = await as(role, b);
            return reply(x.status, x.body);
          };
        } });
      const w = dom.window, d = w.document;
      await pause(150);
      await w.loadAdminScript();
      w.showToast = (m, isErr) => P.toasts.push({ m: String(m), err: !!isErr });
      w.eval('adminKey = "cookie"; setAdminTimeZone_("UTC"); adminOrgs = ' + JSON.stringify([{ orgId: "club", name: "Example Club" }]) + ';');
      w.eval(roles.asRole(role, { name: "Tester", email: "tester@example.test" }));
      Object.assign(P, { w, d, q: (s) => d.querySelector(s), qa: (s) => [...d.querySelectorAll(s)], of: (a) => P.sent.filter(b => b.action === a), reset: () => { P.sent.length = 0; P.toasts.length = 0; } });
      const page = () => d.getElementById("qtPage");
      P.open = async (id) => { const old = page(); if (w.location.hash.replace(/^#\/?/, "") === "quotes/" + id) w.adminRoute(); else w.location.hash = "#quotes/" + id;
        await wait(() => page() && page() !== old && !!d.querySelector("#qtForm")); await pause(40); };
      return P;
    };
    const text = (el) => el ? el.textContent.replace(/\s+/g, " ").trim() : "";

    console.log("\n=== The quote editor: one code at a time ===");
    await M.setDiscountRules(d1, { multiple: false });
    const P = await boot("admin");
    const { q, qa, of, w } = P;
    const qid = await newQuote();
    await P.open(qid);
    const box = () => q("#qtCodes");
    const msg = () => text(q("#qtCodeMsg"));
    const typeCode = (v) => { q("#qtCode").value = v; };
    const pressApply = async () => { const n = P.sent.length; q("#qtCodeAdd").click(); await wait(() => P.sent.length > n); await pause(60); };
    ok("a draft has a Discount codes box: no code yet, a “Discount code” field and Apply", /^Discount codes No discount code on this quote\./.test(text(box())) && text(q("label[for=qtCode]")) === "Discount code" && !!q("#qtCodeAdd"));
    ok("the box asked for the shop's rule (getDiscountRules)", of("getDiscountRules").length === 1);
    typeCode("");
    q("#qtCodeAdd").click(); await pause(20);
    ok("Apply with nothing typed: “Enter a code first.” and nothing asked", msg() === "Enter a code first." && of("checkLocalSaleCode").length === 0);
    typeCode("big50");
    await pressApply();
    ok("a code the server refuses shows its reason (“This code needs an order of at least $100.00.”) and saves nothing", msg() === "This code needs an order of at least $100.00." && of("saveEstimate").length === 0);
    const chk = of("checkLocalSaleCode")[0];
    ok("…the check was for this quote's shop, its goods ($50), its customer and the codes already on it", chk.org === "club" && chk.code === "BIG50" && chk.subtotal === 50 && chk.contact === "pat@example.com" && chk.customerId === PAT && same(chk.others, []));
    P.reset();
    typeCode("save10");
    await pressApply();
    ok("SAVE10 is checked, then saved with the quote's lines (saveEstimate discountCodes [SAVE10])", of("saveEstimate").length === 1 && same(of("saveEstimate")[0].discountCodes, ["SAVE10"]) && Array.isArray(of("saveEstimate")[0].items) &&
      estRow(qid).discountCodes === '["SAVE10"]');
    ok("…a toast says “Code SAVE10 added.” and the box lists it with a ×", P.toasts.some(t => t.m === "Code SAVE10 added." && !t.err) && text(q(".qt-code-list")) .startsWith("SAVE10") &&
      q("[data-qt-code-remove='0']").getAttribute("aria-label") === "Take off code SAVE10");
    ok("…and with one code on and one allowed, no field to add another, but a note saying why", !q("#qtCode") && /Only one discount code can be used at a time/.test(text(box())));
    const sumRows = () => qa("#qtTotals tr").map(tr => [...tr.children].map(text).join(" "));
    ok("the totals show the Subtotal, “Discount (SAVE10) −$5.00”, the tax and the lower Total ($47.88)", same(sumRows(), ["Subtotal $50.00", "Discount (SAVE10) −$5.00", "Sales tax $2.88", "Total $47.88"]));
    P.reset();
    q("[data-qt-code-remove='0']").click();
    await wait(() => of("saveEstimate").length === 1); await pause(60);
    ok("the × takes it off (saveEstimate discountCodes []), and the totals lose the discount line", same(of("saveEstimate")[0].discountCodes, []) && estRow(qid).discountCodes === "[]" &&
      same(sumRows(), ["Subtotal $50.00", "Sales tax $3.20", "Total $53.20"]) && !!q("#qtCode"));
    P.reset();
    typeCode("team5");
    q("#qtCode").dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await wait(() => of("saveEstimate").length === 1); await pause(60);
    ok("Enter in the code field applies the code (not the whole form)", same(of("saveEstimate")[0].discountCodes, ["TEAM5"]) && estRow(qid).discountCodes === '["TEAM5"]');

    console.log("\n=== The quote editor: several codes when the shop allows them ===");
    await M.setDiscountRules(d1, { multiple: true });
    await P.open(qid);
    ok("with more than one allowed, a quote with TEAM5 offers “Add another code”", text(q("label[for=qtCode]")) === "Add another code" && !/Only one discount code/.test(text(box())));
    typeCode("TEAM5");
    P.reset();
    q("#qtCodeAdd").click(); await pause(30);
    ok("the same code again: “That code is already on this quote.” and nothing asked", msg() === "That code is already on this quote." && P.sent.length === 0);
    typeCode("save10");
    await pressApply();
    ok("SAVE10 is checked with TEAM5 as the code already on it, then both are saved", same(of("checkLocalSaleCode")[0].others, ["TEAM5"]) && same(of("saveEstimate")[0].discountCodes, ["TEAM5", "SAVE10"]));
    ok("…the totals show a line per code, as the email and the customer's page do: “Discount (TEAM5) −$5.00”, “Discount (SAVE10) −$5.00”, Total $42.56",
      same(sumRows(), ["Subtotal $50.00", "Discount (TEAM5) −$5.00", "Discount (SAVE10) −$5.00", "Sales tax $2.56", "Total $42.56"]));
    P.reset();
    q("[data-qt-code-remove='0']").click();
    await wait(() => of("saveEstimate").length === 1); await pause(60);
    ok("the first code's × takes off TEAM5 only", same(of("saveEstimate")[0].discountCodes, ["SAVE10"]) && estRow(qid).discountCodes === '["SAVE10"]');

    console.log("\n=== The quote editor: Back office, a quote with no goods, a save refused, a sent quote, the switch ===");
    const S = await boot("staff");
    const qid2 = await newQuote({ discountCodes: ["TEAM5"] });
    await S.open(qid2);
    ok("Back office (Quotes Edit, no Global settings) is told the shop's rule too and is offered “Add another code”", S.of("getDiscountRules").length === 1 && text(S.q("label[for=qtCode]")) === "Add another code");
    const empty = (await call({ action: "createEstimate", org: "club", customerId: PAT, expiresOn: "2099-12-31" })).body.id;
    await P.open(empty);
    P.reset();
    typeCode("SAVE10");
    q("#qtCodeAdd").click(); await pause(30);
    ok("a quote with no lines: “Add the items first.” and nothing asked", msg() === "Add the items first." && P.sent.length === 0);
    await P.open(qid);
    P.reset();
    P.script("saveEstimate", { status: 400, body: { status: "error", message: "Example refusal." } });
    typeCode("TEAM5");
    await pressApply();
    await pause(40);
    ok("a save the server refuses: its message under the box, no toast, the codes as they were", msg() === "Example refusal." && !P.toasts.some(t => /added/.test(t.m)) && text(q(".qt-code-list")) === "SAVE10 ×");
    P.reset();
    P.script("checkLocalSaleCode", { reject: new Error("") });
    typeCode("TEAM5");
    q("#qtCodeAdd").click(); await pause(60);
    ok("a check that fails with no words: “Couldn't check the code.”, Apply usable again", msg() === "Couldn't check the code." && q("#qtCodeAdd").disabled === false);
    P.reset();
    P.script("checkLocalSaleCode", { body: { status: "ok" } });
    typeCode("TEAM5");
    q("#qtCodeAdd").click(); await pause(60);
    ok("an answer that says neither yes nor why: “This code isn't valid.”", msg() === "This code isn't valid." && of("saveEstimate").length === 0);
    await call({ action: "sendEstimate", id: qid });
    await P.open(qid);
    ok("a sent quote lists its code without a × and with no field to add one", text(box()) === "Discount codes SAVE10" && !q("[data-qt-code-remove]") && !q("#qtCode"));
    // (a quote that can't be edited and has no code shows no box: a cancelled one)
    await call({ action: "cancelEstimate", id: empty });
    await P.open(empty);
    ok("a cancelled quote without codes has no Discount codes box at all", text(box()) === "");
    w.eval("siteFeatures.discounts = false;");
    await P.open(qid2);
    ok("with Discount codes switched off the box isn't drawn", text(box()) === "");
    w.eval("siteFeatures.discounts = true;");
    await M.setDiscountRules(d1, { multiple: false });
  }
})();
