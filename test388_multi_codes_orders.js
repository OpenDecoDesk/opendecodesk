// More than one discount code on an order, and free shipping from a code (phase 6, migrations/0120), through the real
// db.js and the real handler of functions/api/orders.js (the sign-in gate stood in for; who may is permissions.js's):
//   * claimDiscountCode on (order, code): two codes on one order when the shop allows several, the one-code rule kept
//     inside the claim's own statement, the same code again, a given-back use taken back, and each refusal;
//   * claimDiscountCodes all or none (a refused second code gives the first back, but never a use the order already had);
//   * releaseDiscountCodeUse giving back every use ({ codes, code }); the order readers' discountCodes / discountCode;
//   * insertOrder's order.discount.shippingCents → orders.shippingDiscountCents, and every figure built on it: orderAmounts,
//     the order as read (shippingDiscount / shippingCharged), the paid flag the payment batch sets, the stored total, the
//     card checkout's balance, sales tax (shipping is never taxed), the revenue and sales-tax rows; updateOrderShipping
//     keeping free shipping free; a database from before 0120 reading 0;
//   * the storefront order and createLocalSale with discountCodes: up to 5, one code only unless the shop allows more, a
//     list that isn't one, the same code twice refused (never silently dropped), and an order that can't be written giving
//     every one of its uses back — but not the uses another copy of the same order was written with.
// Real SQL (sql.js) under the real db.js, quoteToken.js, orders.js and checkout.js. Invented shops, people and codes only.
const fs = require("fs");
const { ok } = require("./testlib/check");
const { createD1 } = require("./testlib/d1-shim.js");
const { adminAs } = require("./testlib/roles");
const { ADMIN_ORIGIN, shopOrigin } = require("./testlib/hosts.js");

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
// Two of db.js's functions get a wrapper the test can steer (a pause or a failure before the insert; a count of give-backs).
const dbSrc = strip(read("functions/_lib/db.js")
  .replace("export async function insertOrder(", "async function insertOrder_real388_(")
  .replace("export async function releaseDiscountCodeUse(", "async function releaseDiscountCodeUse_real388_(")) + `
async function insertOrder(db, order, ...rest) { const h = (globalThis.__ins388 || []).shift(); if (h) await h(order); return insertOrder_real388_(db, order, ...rest); }
async function releaseDiscountCodeUse(db, ...a) { globalThis.__released388 = (globalThis.__released388 || 0) + 1; return releaseDiscountCodeUse_real388_(db, ...a); }
`;
const hostSrc = strip(read("functions/_lib/hostConfig.js")), httpSrc = strip(read("functions/_lib/http.js"));
const emailSrc = strip(read("functions/_lib/email.js")).replace(/async function send_\(/, "async function send_unused_(") +
  "\nasync function send_(env, m) { return true; }\n";
const { selectBox } = new Function(strip(read("functions/_lib/boxSize.js")) + "\nreturn { selectBox };")();
globalThis.__f388 = {};
const catalogStub = "const getCatalogData = async () => ({ subdomainMap: { acme: 'acme' }, orgs: {}, features: globalThis.__f388 });\n";
const rlStub = "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n";
const S = new Function("selectBox", hostSrc + "\n" + httpSrc + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" + strip(read("functions/_lib/quoteToken.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'olive@example.com';\n" + adminAs() + "\n" + rlStub +
  "const verifyTurnstile = async () => ({ ok: true });\nconst invalidateCatalogVersionCache = () => {};\n" + catalogStub +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + emailSrc + "\n" + strip(read("functions/_lib/digital.js")) + "\n" + strip(read("functions/api/orders.js")) +
  `\nreturn { post: onRequestPost, getOrderById, getOrdersByOrg, saveDiscountCode, setDiscountCodeActive, setDiscountRules, claimDiscountCode, claimDiscountCodes,
    releaseDiscountCodeUse: releaseDiscountCodeUse_real388_, discountCodeListByOrder_, discountCodesByOrder_, insertOrder: insertOrder_real388_, orderAmounts,
    updateOrderShipping, refreshPaidStatus, addOrderPayment, getOrderCheckoutState, getRevenueData, getSalesTaxReport, getSalesTaxReturn, getAccountantExport,
    setSalesTaxSettings, setOrgDeliveryOptions, getOrgById, voidOrder, paidRefreshSql_ };`)(selectBox);
const CO = new Function(hostSrc + "\n" + httpSrc + "\n" + rlStub + catalogStub + dbSrc + "\n" + strip(read("functions/_lib/digital.js")) + "\n" +
  strip(read("functions/api/checkout.js")) + "\nreturn onRequestPost;")();

const ENV = { SIGNING_SECRET: "s".repeat(40), STRIPE_SECRET_KEY: "sk_test_example", DESIGNS: {} };
const stripeCalls = [];
global.fetch = async (url, init) => {
  if (/api\.stripe\.com/.test(String(url))) {
    stripeCalls.push(Object.fromEntries(new URLSearchParams(String(init && init.body || ""))));
    return { ok: true, status: 200, json: async () => ({ url: "https://checkout.stripe.test/s/" + stripeCalls.length, id: "cs_" + stripeCalls.length }) };
  }
  return { ok: true, status: 200, json: async () => ({}) };
};
const migrations = fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort();
const newDb = async (before) => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of migrations) if (!before || f < before) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready, shippingEnabled) VALUES ('acme','acme','Example Club','t','t',1,0);`);
  return d1;
};
const harness = (d1) => {
  const call = async (url, body) => {
    const waits = [];
    const res = await S.post({ env: { DB: d1, ...ENV }, waitUntil: (p) => waits.push(Promise.resolve(p).catch(() => {})),
      request: { url, json: async () => body, headers: { get: () => null } } });
    await Promise.all(waits);
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const admin = (body) => call(ADMIN_ORIGIN + "/api/orders", { key: "x", org: "acme", ...body });
  let n = 0;
  const shop = async (items, extra = {}) => { const orderId = extra.orderId || "WEB-" + (++n);
    return { orderId, ...(await call(shopOrigin("acme") + "/api/orders",
      { orderId, orgId: "acme", customerName: "Pat Example", contact: "pat@example.com", paymentMethod: "Check", items, ...extra })) }; };
  let m = 0;
  const sale = (items, extra = {}) => admin({ action: "createLocalSale", requestId: "ls" + (++m) + "abcdefgh", items, paymentMethod: "Cash",
    customerName: "Lee Sample", contact: "lee@example.com", ...extra });
  const pay = async (orderId, checkoutToken) => {
    const res = await CO({ env: { DB: d1, ...ENV }, waitUntil: () => {},
      request: { url: shopOrigin("acme") + "/api/checkout", json: async () => ({ orderId, orgId: "acme", checkoutToken }), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  return { call, admin, shop, sale, pay };
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const tick = () => new Promise((r) => setTimeout(r, 5));
const INVALID = "This code isn't valid.";
const ONE_CODE = "Only one discount code can be used on an order.";
const SAME_CODE = "That code is already applied.";
const FIVE_MAX = "At most 5 discount codes can be used on an order.";
const ANY = "0000-01-01", EVER = "9999-12-31";

(async () => {
  const d1 = await newDb();
  const { admin, shop, sale, pay } = harness(d1);
  const q1 = (sql, ...p) => d1.q(sql, ...p)[0] || null;
  const usesOf = (orderId) => d1.q("SELECT u.*, c.code FROM discount_code_uses u JOIN discount_codes c ON c.id = u.codeId WHERE u.orderId = ? ORDER BY u.id", orderId);
  const liveOf = (orderId) => usesOf(orderId).filter(u => u.releasedAt === null).map(u => u.code);
  const make = async (input) => { const r = await S.saveDiscountCode(d1, input, { actor: "test" }); if (!r.code) throw new Error("couldn't make " + JSON.stringify(input) + " " + JSON.stringify(r)); return r.code; };
  let r, o, got;

  const p10 = await make({ code: "TEN", kind: "percent", percent: 10, maxUses: 1000 });
  const p15 = await make({ code: "FIFTEEN", kind: "percent", percent: 15, maxUses: 1000 });
  const amt5 = await make({ code: "FIVEOFF", kind: "amount", amount: 5, maxUses: 1000 });
  const ship = await make({ code: "SHIPFREE", kind: "shipping", maxUses: 1000 });
  const once = await make({ code: "ONLYONCE", kind: "amount", amount: 3, maxUses: 1 });
  const twice = await make({ code: "TWOUSES", kind: "amount", amount: 2, maxUses: 2 });
  const offNow = await make({ code: "SWITCHEDOFF", kind: "percent", percent: 5, maxUses: 10 });
  await S.setDiscountCodeActive(d1, offNow.id, false);
  const each = await make({ code: "ONEEACH", kind: "amount", amount: 1, maxUses: 10, oncePerEmail: true });
  const patOnly = await make({ code: "PATS", kind: "amount", amount: 1, maxUses: 10, email: "pat@example.com" });
  const now = "2026-06-01T12:00:00.000Z";

  console.log("=== claimDiscountCode: one use per code per order ===");
  await S.setDiscountRules(d1, { multiple: true });
  r = await S.claimDiscountCode(d1, { codeId: p10.id, orderId: "CL-1", email: " Pat@Example.com ", amountCents: 250, now });
  const r2 = await S.claimDiscountCode(d1, { codeId: amt5.id, orderId: "CL-1", email: "pat@example.com", amountCents: 500, now });
  ok("with more than one code allowed, two different codes are both claimed for one order", r.ok === true && r2.ok === true && !r.already && !r2.already);
  ok("…two live uses, one per code, in the order taken, with the email lower-case and each amount", same(liveOf("CL-1"), ["TEN", "FIVEOFF"]) &&
    usesOf("CL-1").every(u => u.email === "pat@example.com") && usesOf("CL-1")[0].amountCents === 250 && usesOf("CL-1")[1].amountCents === 500);
  r = await S.claimDiscountCode(d1, { codeId: p10.id, orderId: "CL-1", email: "pat@example.com", amountCents: 999, now });
  ok("the same code for the same order again answers ok (already) and writes no second row", r.ok === true && r.already === true && usesOf("CL-1").length === 2 && usesOf("CL-1")[0].amountCents === 250);
  await S.setDiscountRules(d1, { multiple: false });
  r = await S.claimDiscountCode(d1, { codeId: p15.id, orderId: "CL-1", email: "pat@example.com", amountCents: 100, now });
  ok("one code per order (the default rule): another code on an order that has a live code is refused inside the claim", r.ok === false && r.reason === "This order already has a discount code." && usesOf("CL-1").length === 2);
  r = await S.claimDiscountCode(d1, { codeId: p10.id, orderId: "CL-1", email: "pat@example.com", amountCents: 100, now });
  ok("…while the order's own code again still answers ok", r.ok === true && r.already === true);
  r = await S.claimDiscountCode(d1, { codeId: p15.id, orderId: "CL-2", email: "pat@example.com", amountCents: 100, now });
  ok("…and a first code on another order is claimed", r.ok === true && same(liveOf("CL-2"), ["FIFTEEN"]));
  // The rule is read inside the statement: a use slipped in between the reads (another request) still stops a second code.
  d1._raw.exec(`INSERT INTO discount_code_uses (codeId, orderId, email, amountCents, usedAt) VALUES (${amt5.id}, 'CL-3', 'pat@example.com', 1, 't')`);
  r = await S.claimDiscountCode(d1, { codeId: p10.id, orderId: "CL-3", email: "pat@example.com", amountCents: 100, now });
  ok("an order that already holds a different code's use takes no second one while one code is the rule", r.ok === false && same(liveOf("CL-3"), ["FIVEOFF"]));

  console.log("\n=== claimDiscountCode: a given-back use is taken back ===");
  r = await S.claimDiscountCode(d1, { codeId: once.id, orderId: "CL-4", email: "lee@example.com", amountCents: 300, now });
  const firstRow = usesOf("CL-4")[0];
  await S.releaseDiscountCodeUse(d1, "CL-4", now);
  ok("a single-use code's use, given back, is released (kept, not deleted)", r.ok === true && usesOf("CL-4").length === 1 && usesOf("CL-4")[0].releasedAt === now);
  r = await S.claimDiscountCode(d1, { codeId: once.id, orderId: "CL-4", email: "pat@example.com", amountCents: 280, now: "2026-06-02T00:00:00.000Z" });
  const back = usesOf("CL-4");
  ok("the same order claiming it again takes the same row back: live, with the new email, amount and time", r.ok === true && !r.already && back.length === 1 &&
    back[0].id === firstRow.id && back[0].releasedAt === null && back[0].email === "pat@example.com" && back[0].amountCents === 280 && back[0].usedAt === "2026-06-02T00:00:00.000Z");
  r = await S.claimDiscountCode(d1, { codeId: once.id, orderId: "CL-5", email: "pat@example.com", amountCents: 300, now });
  ok("…so the single use is that order's again: another order is refused (“already been used”)", r.ok === false && r.reason === "This code has already been used." && usesOf("CL-5").length === 0);

  console.log("\n=== claimDiscountCode: each refusal ===");
  await S.claimDiscountCode(d1, { codeId: twice.id, orderId: "CL-6", email: "", amountCents: 1, now });
  await S.claimDiscountCode(d1, { codeId: twice.id, orderId: "CL-7", email: "", amountCents: 1, now });
  r = await S.claimDiscountCode(d1, { codeId: twice.id, orderId: "CL-8", email: "", amountCents: 1, now });
  ok("a code with two uses, both taken: “This code has reached its limit.”", r.ok === false && r.reason === "This code has reached its limit.");
  r = await S.claimDiscountCode(d1, { codeId: offNow.id, orderId: "CL-8", email: "", now });
  ok("a code that is switched off: “This code isn't valid.”", r.ok === false && r.reason === INVALID);
  await S.claimDiscountCode(d1, { codeId: each.id, orderId: "CL-9", email: "pat@example.com", now });
  r = await S.claimDiscountCode(d1, { codeId: each.id, orderId: "CL-10", email: "PAT@example.com", now });
  ok("a once-per-email code a second time for the same email: “You've already used this code.”", r.ok === false && r.reason === "You've already used this code.");
  r = await S.claimDiscountCode(d1, { codeId: patOnly.id, orderId: "CL-11", email: "lee@example.com", now });
  ok("one person's code for someone else is refused", r.ok === false && /^This code isn't valid\./.test(r.reason) && usesOf("CL-11").length === 0);
  r = await S.claimDiscountCode(d1, { codeId: 99999, orderId: "CL-11", email: "", now });
  ok("a code that isn't there: “This code isn't valid.”", r.ok === false && /^This code isn't valid\./.test(r.reason));
  const bad = [await S.claimDiscountCode(d1, { codeId: "x", orderId: "CL-11" }), await S.claimDiscountCode(d1, { codeId: 0, orderId: "CL-11" }),
    await S.claimDiscountCode(d1, { codeId: p10.id, orderId: "" }), await S.claimDiscountCode(d1, { codeId: p10.id, orderId: null }), await S.claimDiscountCode(d1)];
  ok("a code id that isn't a whole number above 0, or no order id, is refused before the database is asked", bad.every(x => x.ok === false && x.reason === INVALID) && usesOf("").length === 0);

  console.log("\n=== claimDiscountCodes: all or none ===");
  await S.setDiscountRules(d1, { multiple: true });
  const lastOne = await make({ code: "LASTONE", kind: "amount", amount: 4, maxUses: 1 });
  await S.claimDiscountCode(d1, { codeId: lastOne.id, orderId: "CL-20", email: "", now });
  r = await S.claimDiscountCodes(d1, { orderId: "CL-21", email: "pat@example.com", uses: [{ codeId: p10.id, amountCents: 100 }, { codeId: lastOne.id, amountCents: 400 }], now });
  ok("a refused second code refuses the lot, saying why and which code", r.ok === false && r.reason === "This code has already been used." && r.codeId === lastOne.id);
  ok("…and the first code's use, taken by this call, is given back", usesOf("CL-21").length === 1 && usesOf("CL-21")[0].code === "TEN" && usesOf("CL-21")[0].releasedAt !== null);
  await S.claimDiscountCode(d1, { codeId: p15.id, orderId: "CL-22", email: "pat@example.com", amountCents: 7, now });
  r = await S.claimDiscountCodes(d1, { orderId: "CL-22", email: "pat@example.com", uses: [{ codeId: p15.id, amountCents: 7 }, { codeId: p10.id, amountCents: 5 }, { codeId: lastOne.id, amountCents: 1 }], now });
  ok("a use the order already had before the call is left alone when a later code is refused (only this call's are given back)",
    r.ok === false && same(liveOf("CL-22"), ["FIFTEEN"]) && usesOf("CL-22").find(u => u.code === "TEN").releasedAt !== null);
  r = await S.claimDiscountCodes(d1, { orderId: "CL-23", email: "pat@example.com", uses: [{ codeId: p10.id, amountCents: 100 }, { codeId: ship.id, amountCents: 500 }], now });
  ok("every code free: all are claimed, each with its own amount", r.ok === true && same(liveOf("CL-23"), ["TEN", "SHIPFREE"]) && usesOf("CL-23")[1].amountCents === 500);
  r = await S.claimDiscountCodes(d1, { orderId: "CL-24", email: "", uses: [{ codeId: "nope" }], now });
  ok("a code id that isn't a number is refused with no code id named", r.ok === false && r.codeId === null);
  ok("no uses at all (or not a list) is nothing to claim: ok", (await S.claimDiscountCodes(d1, { orderId: "CL-25", uses: [] })).ok === true && (await S.claimDiscountCodes(d1, { orderId: "CL-25" })).ok === true);

  console.log("\n=== releaseDiscountCodeUse: every use the order holds ===");
  r = await S.releaseDiscountCodeUse(d1, "CL-23", now);
  ok("an order with two codes gives both back: { ok, codes: [TEN, SHIPFREE], code: \"TEN, SHIPFREE\" }", r.ok === true && same(r.codes, ["TEN", "SHIPFREE"]) && r.code === "TEN, SHIPFREE");
  ok("…both rows kept, both released", usesOf("CL-23").length === 2 && usesOf("CL-23").every(u => u.releasedAt === now));
  r = await S.releaseDiscountCodeUse(d1, "CL-23", now);
  ok("asked again there is nothing left to give back: codes [] and code \"\"", r.ok === true && same(r.codes, []) && r.code === "");
  ok("no order id gives back nothing", same(await S.releaseDiscountCodeUse(d1, "", now), { ok: true, codes: [], code: "" }) && same(await S.releaseDiscountCodeUse(d1, null), { ok: true, codes: [], code: "" }));

  console.log("\n=== The order readers: discountCodes and discountCode ===");
  await S.claimDiscountCodes(d1, { orderId: "CL-23", email: "", uses: [{ codeId: ship.id }, { codeId: p10.id }], now });
  ok("discountCodeListByOrder_ lists each order's live codes in the order their rows were first taken (a use taken back keeps its place); a released use isn't listed",
    same({ ...(await S.discountCodeListByOrder_(d1, "SELECT value FROM json_each(?)", [JSON.stringify(["CL-1", "CL-21", "CL-23"])])) },
      { "CL-1": ["TEN", "FIVEOFF"], "CL-23": ["TEN", "SHIPFREE"] }));
  ok("discountCodesByOrder_ gives the same joined with \", \"",
    same({ ...(await S.discountCodesByOrder_(d1, "SELECT value FROM json_each(?)", [JSON.stringify(["CL-1", "CL-2"])])) }, { "CL-1": "TEN, FIVEOFF", "CL-2": "FIFTEEN" }));
  // Real orders, read back by both loaders.
  await S.insertOrder(d1, { orderId: "RD-1", orgId: "acme", customerName: "Pat Example", contact: "pat@example.com", shippingCost: 0, placedAt: "2026-05-01T10:00:00.000Z" },
    [{ productId: "", name: "Club Tee", type: "other", qty: 1, unitPrice: 20, taxable: false }]);
  await S.insertOrder(d1, { orderId: "RD-2", orgId: "acme", customerName: "Lee Sample", contact: "lee@example.com", shippingCost: 0, placedAt: "2026-05-01T11:00:00.000Z" },
    [{ productId: "", name: "Club Tee", type: "other", qty: 1, unitPrice: 20, taxable: false }]);
  await S.claimDiscountCodes(d1, { orderId: "RD-1", email: "pat@example.com", uses: [{ codeId: amt5.id }, { codeId: p15.id }], now });
  got = await S.getOrderById(d1, "RD-1");
  ok("an order read by id carries discountCodes (a list, in the order taken) and discountCode (joined)", same(got.discountCodes, ["FIVEOFF", "FIFTEEN"]) && got.discountCode === "FIVEOFF, FIFTEEN");
  const list = await S.getOrdersByOrg(d1, "acme");
  const l1 = list.find(x => x.orderId === "RD-1"), l2 = list.find(x => x.orderId === "RD-2");
  ok("…and so does the shop's order list; an order with no code has [] and \"\"", same(l1.discountCodes, ["FIVEOFF", "FIFTEEN"]) && l1.discountCode === "FIVEOFF, FIFTEEN" &&
    same(l2.discountCodes, []) && l2.discountCode === "");

  console.log("\n=== insertOrder: free shipping from a code ===");
  await S.setSalesTaxSettings(d1, { rateBps: 600, jurisdiction: "OH", taxMode: "exclusive" });
  const tee = (qty, price, taxable = true) => ({ productId: "", name: "Club Tee", type: "other", qty, unitPrice: price, taxable });
  const placed = await S.insertOrder(d1, { orderId: "SH-1", orgId: "acme", customerName: "Pat Example", contact: "pat@example.com", shippingCost: 8,
    placedAt: "2026-05-02T10:00:00.000Z", discount: { cents: 1000, note: "Codes TEN, SHIPFREE", shippingCents: 800 } }, [tee(4, 25)]);
  let row = q1("SELECT * FROM orders WHERE orderId = 'SH-1'");
  ok("order.discount.shippingCents is stored as orders.shippingDiscountCents (800), the shipping rate kept as it is (800)", row.shippingDiscountCents === 800 && row.shippingCostCents === 800);
  ok("the stored total has the free shipping taken off: $100.00 goods + $0.00 shipping + $6.00 tax = 10600 cents (before the goods discount, as always)",
    row.totalCents === 10600 && row.subtotalCents === 10000);
  ok("insertOrder answers the shipping discount and what's owed: $100 − $10 + tax $5.40 (6% of $90) = $95.40, shipping not taxed",
    placed.shippingDiscount === 8 && placed.discount === 10 && placed.salesTax === 5.4 && placed.total === 95.4 && placed.shippingCost === 8);
  const capped = await S.insertOrder(d1, { orderId: "SH-2", orgId: "acme", customerName: "Pat Example", contact: "pat@example.com", shippingCost: 5,
    placedAt: "2026-05-02T11:00:00.000Z", discount: { cents: 0, note: "Code SHIPFREE", shippingCents: 9999 } }, [tee(1, 10)]);
  row = q1("SELECT * FROM orders WHERE orderId = 'SH-2'");
  ok("a shipping discount above the shipping is cut to the shipping (500), and a code that takes only shipping writes no goods discount",
    row.shippingDiscountCents === 500 && row.discountCents === 0 && row.discountNote === "" && capped.shippingDiscount === 5 && capped.discount === 0 && capped.total === 10.6);
  await S.insertOrder(d1, { orderId: "SH-3", orgId: "acme", customerName: "Pat Example", contact: "pat@example.com", shippingCost: 5,
    placedAt: "2026-05-02T12:00:00.000Z", discount: { cents: 100, note: "Code X" } }, [tee(1, 10)]);
  await S.insertOrder(d1, { orderId: "SH-4", orgId: "acme", customerName: "Pat Example", contact: "pat@example.com", shippingCost: 5, placedAt: "2026-05-02T13:00:00.000Z" }, [tee(1, 10)]);
  ok("no shippingCents (or no discount at all) leaves shippingDiscountCents 0 and the shipping in the total",
    q1("SELECT shippingDiscountCents AS s, totalCents AS t FROM orders WHERE orderId = 'SH-3'").s === 0 && q1("SELECT totalCents AS t FROM orders WHERE orderId = 'SH-3'").t === 1560 &&
    q1("SELECT shippingDiscountCents AS s FROM orders WHERE orderId = 'SH-4'").s === 0);
  const neg = await S.insertOrder(d1, { orderId: "SH-5", orgId: "acme", customerName: "Pat Example", contact: "pat@example.com", shippingCost: 5,
    placedAt: "2026-05-02T14:00:00.000Z", discount: { cents: 0, shippingCents: -300 } }, [tee(1, 10)]);
  ok("a negative shipping discount counts as none", q1("SELECT shippingDiscountCents AS s FROM orders WHERE orderId = 'SH-5'").s === 0 && neg.total === 15.6 && !("shippingDiscount" in neg));

  console.log("\n=== orderAmounts with a shipping discount ===");
  const base = { itemsCents: 10000, itemsTaxCents: 600, shippingCents: 800, discountCents: 1000, discountTaxCents: 60, taxMode: "exclusive", rushCents: 0, rushTaxCents: 0 };
  let a = S.orderAmounts({ ...base, shippingDiscountCents: 800 });
  ok("shipping charged = shipping − its discount (0), and what's owed leaves it out: 10000 − 1000 + 540 = 9540", a.shippingCents === 0 && a.owedCents === 9540 && a.workOwedCents === 9540);
  ok("…the tax is the goods' alone (540), the same with or without the shipping discount", a.taxCents === 540 && S.orderAmounts({ ...base, shippingDiscountCents: 0 }).taxCents === 540);
  a = S.orderAmounts({ ...base, shippingDiscountCents: 300 });
  ok("part of the shipping off: 500 charged, owed 10040", a.shippingCents === 500 && a.owedCents === 10040);
  ok("a discount above the shipping never makes it negative; a negative one counts as none; one left out counts as none",
    S.orderAmounts({ ...base, shippingDiscountCents: 5000 }).shippingCents === 0 && S.orderAmounts({ ...base, shippingDiscountCents: -200 }).shippingCents === 800 &&
    S.orderAmounts(base).shippingCents === 800);
  ok("every line cancelled: nothing charged for shipping either way", S.orderAmounts({ ...base, itemsCents: 0, itemsTaxCents: 0, discountCents: 0, discountTaxCents: 0, shippingDiscountCents: 300 }).shippingCents === 0);

  console.log("\n=== The order as read, the paid flag, the card checkout ===");
  got = await S.getOrderById(d1, "SH-1");
  ok("the order reads its shipping rate ($8.00), the shipping discount ($8.00) and shipping charged ($0.00)", got.shippingCost === 8 && got.shippingDiscount === 8 && got.shippingCharged === 0);
  ok("…its total and balance are after both discounts ($95.40) and the tax is on the goods only ($5.40)", got.effectiveTotal === 95.4 && got.balanceDue === 95.4 && got.salesTax === 5.4);
  got = await S.getOrderById(d1, "SH-4");
  ok("an order without one reads shippingDiscount 0 and shippingCharged = the shipping", got.shippingDiscount === 0 && got.shippingCharged === 5 && got.effectiveTotal === 15.6);
  let st = await S.getOrderCheckoutState(d1, "SH-1");
  ok("the card checkout's balance is after the free shipping ($95.40), the tax on top $5.40", st.total === 95.4 && st.taxAdded === 5.4);
  await S.addOrderPayment(d1, "SH-1", 95.4, "Paid in full", "", { method: "cash" });
  ok("a payment of exactly what's owed after the free shipping marks it paid in the payment's own batch", q1("SELECT paid FROM orders WHERE orderId = 'SH-1'").paid === 1);
  ok("…and refreshPaidStatus agrees (owed 9540, received 9540)", same(await S.refreshPaidStatus(d1, "SH-1"), { paid: true, paidForWork: true, owedCents: 9540, receivedCents: 9540, paymentsCents: 9540 }));
  await S.addOrderPayment(d1, "SH-2", 10.59, "Nearly", "", { method: "cash" });
  ok("a cent short of what's owed after free shipping ($10.60) leaves it unpaid", q1("SELECT paid FROM orders WHERE orderId = 'SH-2'").paid === 0);
  await S.addOrderPayment(d1, "SH-2", 0.01, "The cent", "", { method: "cash" });
  ok("…the last cent makes it paid (the $5.00 shipping is not owed)", q1("SELECT paid FROM orders WHERE orderId = 'SH-2'").paid === 1);
  ok("the paid-flag statement subtracts the shipping discount only when told the column is there",
    /shippingDiscountCents/.test(S.paidRefreshSql_("taxMode", true)) && !/shippingDiscountCents/.test(S.paidRefreshSql_("taxMode", false)) &&
    !/shippingDiscountCents/.test(S.paidRefreshSql_("'inclusive'", true)));

  console.log("\n=== Sales tax and revenue rows ===");
  const rev = await S.getRevenueData(d1, ANY, EVER, { basis: "placed" });
  const rv = (id) => rev.find(x => x.orderId === id);
  ok("the revenue row's shipping is what was charged ($0.00 with free shipping, $5.00 without) and its total is after it",
    rv("SH-1").shippingCost === 0 && rv("SH-1").shippingCents === 0 && rv("SH-1").effectiveTotal === 95.4 && rv("SH-4").shippingCost === 5 && rv("SH-4").effectiveTotal === 15.6);
  ok("…the tax and net sales don't move with the shipping discount", rv("SH-1").salesTax === 5.4 && rv("SH-1").netSalesCents === 9000);
  const taxRep = await S.getSalesTaxReport(d1, "2026-05-02T00:00:00.000Z", "2026-05-02T23:59:59.999Z");
  const taxRet = await S.getSalesTaxReturn(d1, "2026-05-02T00:00:00.000Z", "2026-05-02T23:59:59.999Z");
  const sum = (rows, k) => rows.reduce((s, x) => s + (Number(x[k]) || 0), 0);
  // Shipping charged on that day: SH-1 0 + SH-2 0 + SH-3 5 + SH-4 5 + SH-5 5 = $15.00.
  ok("the sales-tax report counts shipping as charged ($15.00 over the day's five orders, not $31.00)", Math.round(sum(taxRep, "shipping") * 100) === 1500);
  ok("the sales-tax return's shipping is the same $15.00", Math.round(sum(taxRet.months, "shipping") * 100) === 1500);

  console.log("\n=== updateOrderShipping: free shipping stays free ===");
  // SH-2's free shipping was written with the order; the use of the free-shipping code is claimed for it as checkout does.
  await S.claimDiscountCodes(d1, { orderId: "SH-2", email: "pat@example.com", uses: [{ codeId: ship.id, amountCents: 500 }], now });
  await S.updateOrderShipping(d1, "SH-2", { shippingCost: 12, shippingMethod: "UPS Ground" });
  row = q1("SELECT shippingCostCents, shippingDiscountCents, paid FROM orders WHERE orderId = 'SH-2'");
  ok("re-quoted shipping on an order with a live free-shipping code: the discount follows it (1200 off 1200)", row.shippingCostCents === 1200 && row.shippingDiscountCents === 1200);
  ok("…so it is still paid, with nothing more to pay", row.paid === 1 && (await S.getOrderById(d1, "SH-2")).balanceDue === 0);
  await S.updateOrderShipping(d1, "SH-2", { shippingCost: 3, shippingMethod: "UPS Ground" });
  ok("…and down again (300 off 300)", q1("SELECT shippingDiscountCents AS s FROM orders WHERE orderId = 'SH-2'").s === 300);
  await S.updateOrderShipping(d1, "SH-4", { shippingCost: 9, shippingMethod: "UPS Ground" });
  ok("an order with no code keeps no shipping discount, and owes the new shipping", q1("SELECT shippingDiscountCents AS s FROM orders WHERE orderId = 'SH-4'").s === 0 &&
    (await S.getOrderById(d1, "SH-4")).effectiveTotal === 19.6);
  // RD-1 holds codes (FIVEOFF, FIFTEEN) but neither makes shipping free.
  await S.updateOrderShipping(d1, "RD-1", { shippingCost: 4, shippingMethod: "UPS Ground" });
  ok("an order whose codes don't make shipping free is charged the new shipping", q1("SELECT shippingDiscountCents AS s FROM orders WHERE orderId = 'RD-1'").s === 0 && (await S.getOrderById(d1, "RD-1")).shippingCharged === 4);
  // A percent code that also makes shipping free counts as a free-shipping code.
  const tenShip = await make({ code: "TENSHIP", kind: "percent", percent: 10, freeShipping: true, maxUses: 10 });
  await S.claimDiscountCodes(d1, { orderId: "SH-4", email: "pat@example.com", uses: [{ codeId: tenShip.id }], now });
  await S.updateOrderShipping(d1, "SH-4", { shippingCost: 7, shippingMethod: "UPS Ground" });
  ok("an order that holds a code with free shipping as well: the next shipping change makes it free", q1("SELECT shippingDiscountCents AS s FROM orders WHERE orderId = 'SH-4'").s === 700 &&
    (await S.getOrderById(d1, "SH-4")).effectiveTotal === 10.6);
  const shBefore = q1("SELECT shippingDiscountCents AS s FROM orders WHERE orderId = 'SH-1'").s;
  await S.releaseDiscountCodeUse(d1, "SH-4");
  await S.updateOrderShipping(d1, "SH-4", { shippingCost: 7, shippingMethod: "UPS Ground" });
  ok("(another order's shipping discount is never touched)", q1("SELECT shippingDiscountCents AS s FROM orders WHERE orderId = 'SH-1'").s === shBefore);

  console.log("\n=== The storefront order with several codes ===");
  await S.setSalesTaxSettings(d1, { rateBps: 0, jurisdiction: "OH", taxMode: "inclusive" });
  r = await admin({ action: "createProduct", productId: "mug", type: "other", name: "Club Mug", pricingMode: "flat", flatPrice: 10, visible: true, weightOz: 10, noDesignNeeded: true });
  await S.setOrgDeliveryOptions(d1, "acme", [{ type: "pickup", label: "Local pickup" }, { id: "chand001", type: "custom", label: "Hand delivery", fee: 6 }]);
  const handId = ((await S.getOrgById(d1, "acme")).deliveryOptions.find(x => x.type === "custom") || {}).id;
  ok("a mug product and a $6.00 hand-delivery option are set up", r.status === 200 && !!handId);
  const mugs = [{ productId: "mug", qty: 10 }];   // $100.00
  await S.setDiscountRules(d1, { multiple: true });
  o = await shop(mugs, { discountCodes: ["ten", " FIFTEEN ", "fiveoff", "shipfree"], deliveryOptionId: handId });
  got = await S.getOrderById(d1, o.orderId);
  ok("several codes allowed: the order is taken with percents added up (25% of $100), then $5 off, and the $6 shipping free",
    o.status === 200 && o.body.discount === 30 && same(o.body.discountCodes, ["TEN", "FIFTEEN", "FIVEOFF", "SHIPFREE"]) && o.body.discountCode === "TEN, FIFTEEN, FIVEOFF, SHIPFREE" &&
    o.body.shippingDiscount === 6 && o.body.total === 70 && o.body.owed === 70);
  row = q1("SELECT discountCents, discountNote, shippingCostCents, shippingDiscountCents FROM orders WHERE orderId = ?", o.orderId);
  ok("…stored as one discount with the note \"Codes TEN, FIFTEEN, FIVEOFF, SHIPFREE\" and the shipping discount 600",
    row.discountCents === 3000 && row.discountNote === "Codes TEN, FIFTEEN, FIVEOFF, SHIPFREE" && row.shippingCostCents === 600 && row.shippingDiscountCents === 600);
  ok("…one live use per code, each with its share (1000, 1500, 500 and the 600 of shipping)",
    same(usesOf(o.orderId).map(u => [u.code, u.amountCents, u.releasedAt]), [["TEN", 1000, null], ["FIFTEEN", 1500, null], ["FIVEOFF", 500, null], ["SHIPFREE", 600, null]]));
  ok("…and it reads back with all four codes, the shipping charged $0.00 and $70.00 to pay", same(got.discountCodes, ["TEN", "FIFTEEN", "FIVEOFF", "SHIPFREE"]) && got.shippingCharged === 0 && got.balanceDue === 70);
  stripeCalls.length = 0;
  r = await pay(o.orderId, o.body.checkoutToken);
  ok("paying by card charges what's owed after the codes and the free shipping ($70.00)", r.status === 200 && stripeCalls.length === 1 && stripeCalls[0]["line_items[0][price_data][unit_amount]"] === "7000");
  o = await shop(mugs, { discountCodes: ["TEN", "FIFTEEN"], discountCode: "FIVEOFF" });
  ok("the list and the single discountCode are taken together (list first)", o.status === 200 && same(o.body.discountCodes, ["TEN", "FIFTEEN", "FIVEOFF"]) && o.body.discount === 30 && !("shippingDiscount" in o.body));
  const before = q1("SELECT count(*) AS n FROM orders").n;
  r = await shop(mugs, { discountCodes: ["TEN", "FIFTEEN", "FIVEOFF", "SHIPFREE", "ONEEACH", "PATS"] });
  ok("six codes are refused: “At most 5 discount codes can be used on an order.”", r.status === 400 && r.body.message === FIVE_MAX);
  r = await shop(mugs, { discountCodes: ["TEN", "FIFTEEN", "FIVEOFF", "SHIPFREE", "ONEEACH"], discountCode: "PATS" });
  ok("…counting the single discountCode with the list", r.status === 400 && r.body.message === FIVE_MAX);
  r = await shop(mugs, { discountCodes: "TEN" });
  ok("discountCodes that isn't a list: “This code isn't valid.”", r.status === 400 && r.body.message === INVALID);
  r = await shop(mugs, { discountCodes: ["TEN", 5] });
  const r3 = await shop(mugs, { discountCodes: ["X".repeat(65)] });
  ok("a code that isn't text, or is longer than 64 characters, is refused the same way", r.status === 400 && r.body.message === INVALID && r3.status === 400 && r3.body.message === INVALID);
  r = await shop(mugs, { discountCodes: ["TEN", "ten"] });
  const r4 = await shop(mugs, { discountCodes: ["FIFTEEN"], discountCode: " fifteen " });
  ok("the same code twice (any case or spacing) is refused: “That code is already applied.”", r.status === 400 && r.body.message === SAME_CODE && r4.status === 400 && r4.body.message === SAME_CODE);
  ok("…and none of the refused orders was made or took a use", q1("SELECT count(*) AS n FROM orders").n === before && usesOf(r.orderId).length === 0 && usesOf(r4.orderId).length === 0);
  o = await shop(mugs, { discountCodes: ["", null, "TEN"], discountCode: "" });
  ok("empty entries in the list are skipped", o.status === 200 && same(o.body.discountCodes, ["TEN"]) && o.body.discount === 10);

  await S.setDiscountRules(d1, { multiple: false });
  r = await shop(mugs, { discountCodes: ["TEN", "FIFTEEN"] });
  ok("one code per order (the shop's rule): two codes are refused: “Only one discount code can be used on an order.”", r.status === 400 && r.body.message === ONE_CODE && usesOf(r.orderId).length === 0);
  r = await shop(mugs, { discountCodes: ["TEN", "TEN"], discountCode: "TEN" });
  ok("…and the same code twice is refused as already applied", r.status === 400 && r.body.message === SAME_CODE && usesOf(r.orderId).length === 0);
  o = await shop(mugs, { discountCodes: ["SHIPFREE"], deliveryOptionId: handId });
  ok("one free-shipping code alone: the goods at full price, the shipping free, the code on the order",
    o.status === 200 && o.body.discount === 0 && o.body.shippingDiscount === 6 && o.body.owed === 100 && same(o.body.discountCodes, ["SHIPFREE"]) &&
    q1("SELECT discountCents AS d FROM orders WHERE orderId = ?", o.orderId).d === 0 && same((await S.getOrderById(d1, o.orderId)).discountCodes, ["SHIPFREE"]));

  console.log("\n=== The storefront: an order that can't be written gives back every use ===");
  await S.setDiscountRules(d1, { multiple: true });
  globalThis.__released388 = 0;
  globalThis.__ins388 = [async () => { throw new Error("the database fell over (test)"); }];
  let threw = null;
  try { await shop(mugs, { orderId: "WEB-FAIL1", discountCodes: ["ONLYONCE", "TEN"] }); } catch (e) { threw = e; }
  // ONLYONCE's single use is held by CL-4; make a fresh single-use code for this.
  ok("(a single-use code already used is refused before anything is written)", !threw && liveOf("WEB-FAIL1").length === 0);
  const solo = await make({ code: "SOLO", kind: "amount", amount: 2, maxUses: 1 });
  globalThis.__ins388 = [async () => { throw new Error("the database fell over (test)"); }];
  threw = null;
  try { await shop(mugs, { orderId: "WEB-FAIL2", discountCodes: ["SOLO", "TEN", "SHIPFREE"], deliveryOptionId: handId }); } catch (e) { threw = e; }
  ok("an order with three codes whose insert fails isn't made", !!threw && /fell over/.test(threw.message) && !q1("SELECT 1 AS x FROM orders WHERE orderId = 'WEB-FAIL2'"));
  ok("…and all three uses it claimed are given back in one go", globalThis.__released388 === 1 && usesOf("WEB-FAIL2").length === 3 && liveOf("WEB-FAIL2").length === 0);
  o = await shop(mugs, { orderId: "WEB-FAIL2", discountCodes: ["SOLO", "TEN", "SHIPFREE"], deliveryOptionId: handId });
  ok("the customer trying again gets all three (the given-back uses taken back, one row per code)", o.status === 200 && same(liveOf("WEB-FAIL2"), ["SOLO", "TEN", "SHIPFREE"]) &&
    usesOf("WEB-FAIL2").length === 3 && solo.id > 0);

  console.log("\n=== The storefront: the same order sent twice at once ===");
  // Copy A (free shipping only) claims and is held at its insert; copy B finds A's use, writes the order; A meets it.
  let releaseA; const heldA = new Promise((res) => { releaseA = res; }); let reachedA = false;
  globalThis.__released388 = 0;
  globalThis.__ins388 = [async () => { reachedA = true; await heldA; }];
  const twin = { orderId: "WEB-TWIN1", discountCodes: ["SHIPFREE"], deliveryOptionId: handId };
  const pA = shop(mugs, twin);
  while (!reachedA) await tick();
  const oB = await shop(mugs, twin);
  releaseA();
  const oA = await pA;
  ok("copy B writes the order with free shipping; copy A is answered as its repeat", oB.status === 200 && oB.body.shippingDiscount === 6 && oA.status === 200 && oA.body.duplicate === true);
  ok("…and the written order keeps its free-shipping code's use (no goods discount, but a shipping one): nothing is given back",
    globalThis.__released388 === 0 && same(liveOf("WEB-TWIN1"), ["SHIPFREE"]) && (await S.getOrderById(d1, "WEB-TWIN1")).discountCode === "SHIPFREE");
  // Copy A with two codes is held; an order under the same id with no code is written first: A gives back both uses.
  let releaseC; const heldC = new Promise((res) => { releaseC = res; }); let reachedC = false;
  globalThis.__ins388 = [async () => { reachedC = true; await heldC; }];
  const pC = shop(mugs, { orderId: "WEB-TWIN2", discountCodes: ["TEN", "FIFTEEN"] });
  while (!reachedC) await tick();
  const oD = await shop(mugs, { orderId: "WEB-TWIN2" });
  releaseC();
  const oC = await pC;
  ok("the same order id written first without codes: the coded copy is answered as its repeat, and both its uses are given back",
    oD.status === 200 && oC.status === 200 && oC.body.duplicate === true && !("discountCode" in oC.body) && globalThis.__released388 === 1 &&
    usesOf("WEB-TWIN2").length === 2 && liveOf("WEB-TWIN2").length === 0);
  globalThis.__ins388 = [];

  console.log("\n=== A Local sale with several codes ===");
  const tees = [{ productId: "__custom__", name: "Club Tee", type: "other", size: "", customUnitPrice: 25, qty: 4, taxable: false }];   // $100
  const addr = { name: "Lee Sample", line1: "1 Main St", city: "Columbus", state: "OH", zip: "43215" };
  r = await sale(tees, { discountCodes: ["TEN", "FIFTEEN", "FIVEOFF", "SHIPFREE"], shippingAddress: addr, shippingCost: 8, shippingMethod: "UPS Ground" });
  got = r.body.orderId ? await S.getOrderById(d1, r.body.orderId) : null;
  ok("several codes allowed: the sale is recorded with 25% + $5 off and the $8.00 shipping free", r.status === 200 && !!got && got.discountAmount === 30 &&
    got.shippingDiscount === 8 && got.shippingCharged === 0 && got.effectiveTotal === 70 && same(got.discountCodes, ["TEN", "FIFTEEN", "FIVEOFF", "SHIPFREE"]));
  ok("…with the note \"Codes TEN, FIFTEEN, FIVEOFF, SHIPFREE\" and a use per code", got.discountNote === "Codes TEN, FIFTEEN, FIVEOFF, SHIPFREE" && liveOf(got.orderId).length === 4);
  const audit = q1("SELECT detail FROM audit_log WHERE orderId = ? AND action = 'order.created_local_sale'", got.orderId);
  const det = audit ? JSON.parse(audit.detail) : {};
  ok("…and its audit row names the codes, the discount and the shipping discount", det.discountCode === "TEN, FIFTEEN, FIVEOFF, SHIPFREE" && same(det.discountCodes, ["TEN", "FIFTEEN", "FIVEOFF", "SHIPFREE"]) &&
    det.discount === 30 && det.shippingDiscount === 8);
  r = await sale(tees, { discountCodes: ["TEN"], paid: true });
  got = await S.getOrderById(d1, r.body.orderId);
  ok("one code, Paid ticked: settled for what's owed after it ($90.00), no shipping discount in the audit", r.status === 200 && got.paid === true && got.amountReceived === 90 &&
    !("shippingDiscount" in JSON.parse(q1("SELECT detail FROM audit_log WHERE orderId = ? AND action = 'order.created_local_sale'", r.body.orderId).detail)));
  r = await sale(tees, { discountCodes: ["TEN", "FIFTEEN", "FIVEOFF", "SHIPFREE", "ONEEACH", "PATS"] });
  ok("six codes on a Local sale: “At most 5 discount codes can be used on an order.”", r.status === 400 && r.body.message === FIVE_MAX);
  r = await sale(tees, { discountCodes: { code: "TEN" } });
  ok("discountCodes that isn't a list: “This code isn't valid.”", r.status === 400 && r.body.message === INVALID);
  r = await sale(tees, { discountCodes: ["TEN", "FIFTEEN"], discountCode: "ten" });
  ok("the same code twice in multiple mode: “That code is already applied.”", r.status === 400 && r.body.message === SAME_CODE);
  r = await sale(tees, { discountCodes: ["TEN", "LASTONE"] });
  ok("a code with no use left refuses the sale with its reason, and the other code's use is given back",
    r.status === 400 && r.body.message === "This code has already been used." && d1.q("SELECT 1 FROM discount_code_uses WHERE orderId LIKE 'ACME-LS-LS%' AND releasedAt IS NULL AND codeId = ?", lastOne.id).length === 0);

  await S.setDiscountRules(d1, { multiple: false });
  const salesBefore = q1("SELECT count(*) AS n FROM orders").n;
  r = await sale(tees, { discountCodes: ["TEN", "FIFTEEN"] });
  ok("one code per order: two codes on a Local sale are refused: “Only one discount code can be used on an order.”", r.status === 400 && r.body.message === ONE_CODE);
  r = await sale(tees, { discountCode: "TEN", discountCodes: ["TEN", "TEN"] });
  ok("one code per order: \"TEN\" with the list [\"TEN\", \"TEN\"] is refused as already applied, not silently cut to one", r.status === 400 && r.body.message === SAME_CODE);
  r = await sale(tees, { discountCode: "TEN", discountCodes: ["ten"] });
  ok("…and so is the same code as discountCode and in the list in another case", r.status === 400 && r.body.message === SAME_CODE);
  ok("…none of these sales was recorded", q1("SELECT count(*) AS n FROM orders").n === salesBefore);
  r = await sale(tees, { discountCode: "TEN" });
  got = await S.getOrderById(d1, r.body.orderId);
  ok("one code alone is still taken (note \"Code TEN\")", r.status === 200 && got.discountNote === "Code TEN" && got.discountAmount === 10 && same(got.discountCodes, ["TEN"]));

  console.log("\n=== The Discount codes switch off ===");
  globalThis.__f388 = { discounts: false };
  const offBefore = q1("SELECT count(*) AS n FROM orders").n;
  r = await shop(mugs, { discountCodes: ["TEN"] });
  ok("the storefront refuses an order with codes: “Discount codes aren't available right now.”", r.status === 400 && r.body.message === "Discount codes aren't available right now.");
  r = await sale(tees, { discountCodes: ["TEN"] });
  ok("a Local sale with codes is refused as the switched-off feature's", r.status === 403 && r.body.feature === "discounts");
  ok("…neither order is made", q1("SELECT count(*) AS n FROM orders").n === offBefore);
  globalThis.__f388 = {};

  console.log("\n=== A Local sale that can't be written gives back every use ===");
  await S.setDiscountRules(d1, { multiple: true });
  globalThis.__released388 = 0;
  globalThis.__ins388 = [async () => { throw new Error("the database fell over (test)"); }];
  threw = null;
  const failId = "failsale1abcdefgh";
  try { await admin({ action: "createLocalSale", requestId: failId, items: tees, paymentMethod: "Cash", contact: "lee@example.com", discountCodes: ["TEN", "FIFTEEN"] }); } catch (e) { threw = e; }
  const failOrder = "ACME-LS-" + failId.toUpperCase();
  ok("the sale whose insert fails isn't made, and both its uses are given back", !!threw && !q1("SELECT 1 AS x FROM orders WHERE orderId = ?", failOrder) &&
    globalThis.__released388 === 1 && usesOf(failOrder).length === 2 && liveOf(failOrder).length === 0);
  // The same Save sent twice at once: copy A is held at its insert, copy B writes the sale; A meets it and is the repeat.
  let releaseE; const heldE = new Promise((res) => { releaseE = res; }); let reachedE = false;
  globalThis.__released388 = 0;
  globalThis.__ins388 = [async () => { reachedE = true; await heldE; }];
  const twinSale = { action: "createLocalSale", requestId: "twinsale1abcdefg", items: tees, paymentMethod: "Cash", contact: "lee@example.com", discountCodes: ["TEN", "FIVEOFF"] };
  const pE = admin(twinSale);
  while (!reachedE) await tick();
  const oF = await admin(twinSale);
  releaseE();
  const oE = await pE;
  const twinOrder = "ACME-LS-TWINSALE1ABCDEFG";
  ok("the same Save twice at once: one sale is made, the other answered as its repeat, and the sale keeps both codes",
    oF.status === 200 && oE.status === 200 && (oE.body.repeated === true || oF.body.repeated === true) && globalThis.__released388 === 0 &&
    same(liveOf(twinOrder), ["TEN", "FIVEOFF"]) && same((await S.getOrderById(d1, twinOrder)).discountCodes, ["TEN", "FIVEOFF"]));
  globalThis.__ins388 = [];

  console.log("\n=== A database from before 0120 ===");
  const old = await newDb("0120");
  await S.insertOrder(old, { orderId: "OLD-1", orgId: "acme", customerName: "Pat Example", contact: "pat@example.com", shippingCost: 5, placedAt: "2026-05-03T10:00:00.000Z",
    discount: { cents: 100, note: "Code OLD" } }, [tee(1, 10)]);
  got = await S.getOrderById(old, "OLD-1");
  ok("an order still writes (no shipping discount column named) and reads shippingDiscount 0, shipping charged $5.00", !!got && got.shippingDiscount === 0 && got.shippingCharged === 5 &&
    got.effectiveTotal === 14);
  st = await S.getOrderCheckoutState(old, "OLD-1");
  ok("the card checkout's balance reads the shipping as charged in full ($14.00)", st.total === 14);
  await S.addOrderPayment(old, "OLD-1", 14, "Paid", "", { method: "cash" });
  ok("a payment of what's owed marks it paid (the paid-flag statement without the column)", q1o(old, "SELECT paid FROM orders WHERE orderId = 'OLD-1'").paid === 1 &&
    (await S.refreshPaidStatus(old, "OLD-1")).owedCents === 1400);
  const oldRev = await S.getRevenueData(old, ANY, EVER, { basis: "placed" });
  ok("revenue and the sales-tax report read shipping as charged in full", oldRev[0].shippingCost === 5 && oldRev[0].effectiveTotal === 14 &&
    Math.round(((await S.getSalesTaxReport(old, ANY, EVER))[0] || {}).shipping * 100) === 500);
  await S.updateOrderShipping(old, "OLD-1", { shippingCost: 7, shippingMethod: "UPS Ground" });
  ok("a shipping change works there too (nothing to make free) and owes the new shipping", (await S.getOrderById(old, "OLD-1")).effectiveTotal === 16);
  const oldList = await S.getOrdersByOrg(old, "acme");
  ok("the order list reads it with no codes", oldList.length === 1 && same(oldList[0].discountCodes, []) && oldList[0].discountCode === "");
  old._raw.exec(`INSERT INTO discount_codes (code, kind, percentBps, amountCents, orgId, email, maxUses, oncePerEmail, active, note, createdAt, createdBy) VALUES ('OLDTEN','percent',1000,NULL,NULL,'',10,0,1,'','t','t')`);
  // A code made before 0120 (no minimum, no free shipping columns yet): the claim's (order, code) index isn't there either.
  const oh = harness(old);
  const oldTee = [{ productId: "__custom__", name: "Club Tee", type: "other", size: "", customUnitPrice: 25, qty: 4, taxable: false }];
  let oldThrew = null, oldSale = null;
  try { oldSale = await oh.admin({ action: "createLocalSale", requestId: "oldsale1abcdefgh", items: oldTee, paymentMethod: "Cash", discountCode: "OLDTEN" }); } catch (e) { oldThrew = e; }
  ok("a Local sale with a code on a database a migration behind is refused with a reason, not a crash, and makes no order",
    !oldThrew && !!oldSale && oldSale.status === 400 && oldSale.body.message === INVALID && !q1o(old, "SELECT 1 AS x FROM orders WHERE orderId = 'ACME-LS-OLDSALE1ABCDEFGH'"));
  ok("…claimDiscountCode there answers not ready, and takes no use", (await S.claimDiscountCode(old, { codeId: 1, orderId: "OLD-2", email: "" })).notReady === true &&
    q1o(old, "SELECT count(*) AS n FROM discount_code_uses").n === 0);
  oldSale = await oh.admin({ action: "createLocalSale", requestId: "oldsale2abcdefgh", items: oldTee, paymentMethod: "Cash" });
  ok("…and a sale without a code is recorded as ever", oldSale.status === 200 && !!q1o(old, "SELECT 1 AS x FROM orders WHERE orderId = 'ACME-LS-OLDSALE2ABCDEFGH'"));
  const older = await newDb("0115");
  ok("before discount codes at all: releasing answers nothing given back, and the readers list nothing",
    same(await S.releaseDiscountCodeUse(older, "X-1"), { ok: true, codes: [], code: "" }) && same({ ...(await S.discountCodeListByOrder_(older, "?", ["X-1"])) }, {}) &&
    (await S.claimDiscountCode(older, { codeId: 1, orderId: "X-1" })).notReady === true);
})().catch((e) => { console.log("test388 crashed", e && e.stack || e); process.exit(1); });

function q1o(db, sql, ...p) { return db.q(sql, ...p)[0] || null; }
