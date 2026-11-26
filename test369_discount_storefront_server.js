// Discount codes (migrations/0115, phase 4) on the customer's side, through the real handlers of functions/api/orders.js
// and functions/api/checkout.js:
//   * the public "checkDiscountCode" action (the storefront's Apply): the shop is the one whose address it is (the
//     request's orgId is ignored there), refused on the admin host and the bare domain (localhost keeps the request's
//     shop, for development), its own rate-limit bucket "discount_check" (30 a minute), the Storefront and Discount
//     codes switches, the cart priced on the server with quantity breaks (the client's prices and subtotal are never
//     read), an answer that never says who a code is for or how many uses it has, and every refusal and its sentence;
//   * an order sent with body.discountCode: the server checks the code again and books it (orders.discountCents /
//     discountNote, the use with the order id), the answer's discount / discountCode / total / owed with tax inside the
//     prices and with tax added on top, a repeat of the same order answered the same without a second use, two orders
//     racing for a code's last use, the use given back when the order can't be written (but not a use another copy of
//     the same order holds), and a database a migration behind;
//   * /api/checkout charging the balance after the discount.
// Real SQL (sql.js) under the real db.js, quoteToken.js, orders.js and checkout.js. Invented shops, people and codes only.
const fs = require("fs");
const { ok } = require("./testlib/check");
const { createD1 } = require("./testlib/d1-shim.js");
const { adminAs } = require("./testlib/roles");
const { ADMIN_ORIGIN, ROOT, shopOrigin } = require("./testlib/hosts.js");

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
// Four of db.js's functions get a wrapper the test can steer (a pause, a failure); each calls the real one.
const dbSrc = strip(read("functions/_lib/db.js")
  .replace("export async function insertOrder(", "async function insertOrder_real333_(")
  .replace("export async function checkDiscountCode(", "async function checkDiscountCode_real333_(")
  .replace("export async function releaseDiscountCodeUse(", "async function releaseDiscountCodeUse_real333_(")
  .replace("export async function priceItem(", "async function priceItem_real333_(")) + `
async function insertOrder(db, order, ...rest) { const h = (globalThis.__ins333 || []).shift(); if (h) await h(order); return insertOrder_real333_(db, order, ...rest); }
async function checkDiscountCode(db, args) { const r = await checkDiscountCode_real333_(db, args); if (globalThis.__afterCheck333) await globalThis.__afterCheck333(r); return r; }
async function releaseDiscountCodeUse(db, ...a) { globalThis.__released333 = (globalThis.__released333 || 0) + 1; if (globalThis.__releaseFail333) throw new Error("release failed (test)"); return releaseDiscountCodeUse_real333_(db, ...a); }
async function priceItem(...a) { if (globalThis.__priceFail333) throw new Error("pricing broke (test)"); return priceItem_real333_(...a); }
`;
const hostSrc = strip(read("functions/_lib/hostConfig.js")), httpSrc = strip(read("functions/_lib/http.js"));
// Mail is never sent from here: the one function that would is swapped for one that says it did.
const emailSrc = strip(read("functions/_lib/email.js")).replace(/async function send_\(/, "async function send_unused_(") +
  "\nasync function send_(env, m) { return true; }\n";
const { selectBox } = new Function(strip(read("functions/_lib/boxSize.js")) + "\nreturn { selectBox };")();
// The switches arrive with the cached catalog; the rate limiter records each bucket asked for and can refuse one.
globalThis.__f333 = {};
globalThis.__rl333 = [];
const catalogStub = "const getCatalogData = async () => ({ subdomainMap: { acme: 'acme', beta: 'beta' }, orgs: {}, features: globalThis.__f333 });\n";
const rlStub = "const rateLimited = async (env, bucket, req, limit) => { globalThis.__rl333.push(bucket + '/' + limit); return { blocked: globalThis.__rlBlock333 === bucket, retryAfter: 30 }; };\n" +
  "const rateLimitResponse = (s) => jsonResponse({ status: 'error', message: 'Too many tries — wait ' + s + ' seconds.' }, 429);\n";
const S = new Function("selectBox", hostSrc + "\n" + httpSrc + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" + strip(read("functions/_lib/quoteToken.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" + adminAs() + "\n" + rlStub +
  "const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {};\n" + catalogStub +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + emailSrc + "\n" + strip(read("functions/_lib/digital.js")) + "\n" + strip(read("functions/api/orders.js")) +
  `\nreturn { post: onRequestPost, getOrderById, saveDiscountCode, setDiscountCodeActive, setSalesTaxSettings, localToday, voidOrder };`)(selectBox);
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
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready, shippingEnabled) VALUES
    ('acme','acme','Example Club','t','t',1,1), ('beta','beta','Sample League','t','t',1,1);`);
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
  const check = (body, origin = shopOrigin("acme")) => call(origin + "/api/orders", { action: "checkDiscountCode", ...body });
  let n = 0;
  const shop = async (items, extra = {}, origin = shopOrigin("acme")) => { const orderId = extra.orderId || "WEB-" + (++n);
    return { orderId, ...(await call(origin + "/api/orders",
      { orderId, orgId: "acme", customerName: "Pat Example", contact: "pat@example.com", paymentMethod: "Check", items, ...extra })) }; };
  const pay = async (orderId, checkoutToken) => {
    const res = await CO({ env: { DB: d1, ...ENV }, waitUntil: () => {},
      request: { url: shopOrigin("acme") + "/api/checkout", json: async () => ({ orderId, orgId: "acme", checkoutToken }), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  return { call, admin, check, shop, pay };
};
const keys = (o) => Object.keys(o || {}).sort().join(",");
const INVALID = "This code isn't valid.";
const INVALID_EMAIL = INVALID + " If it was sent to you, check the email address is the one it was sent to.";
const OFF_MSG = "Discount codes aren't available right now.";
const QTY_MESSAGE = "Each item's quantity must be a whole number from 1 to 50.";
// A gate two requests both have to reach before either goes on.
const barrier = (count) => { let waiting = [], arrived = 0;
  return () => new Promise((res) => { waiting.push(res); if (++arrived >= count) { waiting.forEach(r => r()); waiting = []; } }); };
const tick = () => new Promise((r) => setTimeout(r, 5));

(async () => {
  const d1 = await newDb();
  const { admin, check, shop, pay } = harness(d1);
  const q1 = (sql, ...p) => d1.q(sql, ...p)[0] || null;
  const orderCount = () => q1("SELECT count(*) AS n FROM orders").n;
  const liveUses = (code) => q1("SELECT count(*) AS n FROM discount_code_uses u JOIN discount_codes c ON c.id = u.codeId WHERE c.code = ? AND u.releasedAt IS NULL", code).n;
  const useOf = (orderId) => q1("SELECT u.*, c.code FROM discount_code_uses u JOIN discount_codes c ON c.id = u.codeId WHERE u.orderId = ?", orderId);
  const make = async (input) => { const r = await S.saveDiscountCode(d1, input, { actor: "test" }); if (!r.code) throw new Error("couldn't make " + JSON.stringify(input) + " " + JSON.stringify(r)); return r.code; };
  let r, o;

  // The products, made with the real createProduct action: a tee with a 12+ break ($20.00 → $18.00), a mug, and a
  // tee that needs the customer's own design.
  r = await admin({ action: "createProduct", productId: "tee", type: "shirt", name: "Club Tee", pricingMode: "sized", sizePricing: { S: 20, M: 20 }, visible: true, weightOz: 6,
    noDesignNeeded: true, personalizationPrice: 5, qtyBreaks: [{ minQty: 12, off: 2 }] });
  const r2 = await admin({ action: "createProduct", productId: "mug", type: "other", name: "Club Mug", pricingMode: "flat", flatPrice: 10, visible: true, weightOz: 10, noDesignNeeded: true });
  const r3 = await admin({ action: "createProduct", productId: "logo", type: "shirt", name: "Your Logo Tee", pricingMode: "flat", flatPrice: 25, visible: true, weightOz: 6, customDesign: "transfer" });
  const r4 = await admin({ action: "createProduct", org: "beta", productId: "mug", type: "other", name: "League Mug", pricingMode: "flat", flatPrice: 10, visible: true, weightOz: 10, noDesignNeeded: true });
  ok("the shops' products are made: a tee with a 12+ break, a mug, a tee that needs the customer's design, and a mug in the second shop",
    r.status === 200 && r2.status === 200 && r3.status === 200 && r4.status === 200);
  const today = await S.localToday(ENV);
  const save10 = await make({ code: "SAVE10", kind: "percent", percent: 10, maxUses: 1000 });
  const five = await make({ code: "FIVE", kind: "amount", amount: 5, maxUses: 1000 });
  await make({ code: "BIGOFF", kind: "amount", amount: 500, maxUses: 1000 });
  await make({ code: "PATONLY", kind: "amount", amount: 5, email: "pat@example.com" });
  const offCode = await make({ code: "OFFNOW", kind: "percent", percent: 10, maxUses: 10 });
  await S.setDiscountCodeActive(d1, offCode.id, false);
  await make({ code: "BETAONLY", kind: "percent", percent: 10, maxUses: 10, orgId: "beta" });
  await make({ code: "ACMEONLY", kind: "percent", percent: 20, maxUses: 10, orgId: "acme" });
  await make({ code: "OLDCODE", kind: "percent", percent: 10, maxUses: 10, expiresOn: "2020-01-31" });
  await make({ code: "LASTDAY", kind: "percent", percent: 10, maxUses: 10, expiresOn: today });
  await make({ code: "ONCEEACH", kind: "percent", percent: 10, maxUses: 10, oncePerEmail: true });
  const TWELVE = [{ productId: "tee", size: "S", qty: 6 }, { productId: "tee", size: "M", qty: 6 }];

  console.log("\n=== checkDiscountCode: the cart priced on the server ===");
  globalThis.__rl333 = [];
  r = await check({ code: "save10", email: "", items: TWELVE });
  ok("a good code answers ok with the code as stored, its label and what it takes off: 10% of 12 tees at the 12+ break (12 × $18.00 = $216.00) is $21.60",
    r.status === 200 && r.body.status === "ok" && r.body.code === "SAVE10" && r.body.label === "10% off" && r.body.discount === 21.6);
  ok("…the answer is exactly status, code, label and discount: never who a code is for, how many uses it has or has had",
    keys(r.body) === "code,discount,label,status" && !/maxUses|used|uses|email|@/.test(JSON.stringify(r.body)));
  ok("…and the check is counted in its own rate-limit bucket, discount_check, at 30", globalThis.__rl333.join(" ") === "discount_check/30");
  ok("…and nothing is claimed or written by a check", q1("SELECT count(*) AS n FROM discount_code_uses").n === 0 && orderCount() === 0);
  r = await check({ code: " SAVE10 ", items: [{ productId: "tee", size: "S", qty: 6, unitPrice: 0.01, lineTotal: 0.06 }, { productId: "tee", size: "M", qty: 5, unitPrice: 0.01 }], subtotal: 1, total: 1 });
  ok("the client's prices and subtotal are never read: 11 tees miss the break, so 10% of 11 × $20.00 = $22.00", r.status === 200 && r.body.discount === 22);
  r = await check({ code: "FIVE", items: [{ productId: "tee", size: "S", qty: 1, personalized: true, persName: "Example" }] });
  ok("an amount off is the amount ($5.00 off a $25.00 personalized tee)", r.status === 200 && r.body.discount === 5 && r.body.label === "$5.00 off");
  r = await check({ code: "BIGOFF", items: [{ productId: "mug", qty: 1 }] });
  ok("an amount off is no more than the goods ($500.00 off one $10.00 mug takes $10.00)", r.status === 200 && r.body.discount === 10);
  r = await check({ code: "SAVE10", items: [{ productId: "tee", size: "S", qty: 1, personalized: true, persName: "Example" }] });
  ok("a percent comes off the personalization too (10% of $20.00 + $5.00 = $2.50)", r.status === 200 && r.body.discount === 2.5);

  console.log("\n=== checkDiscountCode: the shop is the address's ===");
  r = await check({ code: "ACMEONLY", orgId: "beta", items: [{ productId: "mug", qty: 1 }] });
  ok("on a shop's address the shop is that shop's, whatever orgId the request names: Example Club's own code works there", r.status === 200 && r.body.discount === 2);
  r = await check({ code: "BETAONLY", orgId: "beta", items: [{ productId: "mug", qty: 1 }] });
  ok("…and another shop's code is refused there as not valid", r.status === 400 && r.body.status === "error" && r.body.message === INVALID);
  r = await check({ code: "BETAONLY", items: [{ productId: "mug", qty: 1 }] }, shopOrigin("beta"));
  ok("…while on the second shop's address its own code works", r.status === 200 && r.body.code === "BETAONLY");
  r = await check({ code: "SAVE10", orgId: "acme", items: TWELVE }, ADMIN_ORIGIN);
  ok("on the admin host it is refused (403, \"Not available here.\")", r.status === 403 && r.body.message === "Not available here.");
  r = await check({ code: "SAVE10", orgId: "acme", items: TWELVE }, "https://" + ROOT);
  ok("on the bare domain it is refused: the shop isn't taken from the request (403)", r.status === 403 && r.body.message === "Orders are placed from a shop's own page.");
  r = await check({ code: "SAVE10", orgId: "acme", items: TWELVE }, "https://www." + ROOT);
  const rUnknown = await check({ code: "SAVE10", orgId: "acme", items: TWELVE }, "https://nobody." + ROOT);
  ok("…on www. too, and an unknown shop address is unrecognized (404)", r.status === 403 && rUnknown.status === 404);
  r = await check({ code: "SAVE10", orgId: "beta", items: [{ productId: "mug", qty: 2 }] }, "http://localhost:8788");
  const rLocal = await check({ code: "SAVE10", items: [{ productId: "mug", qty: 2 }] }, "http://127.0.0.1:8788");
  ok("on localhost (development) the request's shop is used, and with none it's \"Unknown org\"", r.status === 200 && r.body.discount === 2 && rLocal.status === 400 && rLocal.body.message === "Unknown org");
  d1._raw.exec("UPDATE orgs SET ready = 0 WHERE orgId = 'beta'");
  r = await check({ code: "SAVE10", items: [{ productId: "mug", qty: 1 }] }, shopOrigin("beta"));
  ok("a shop that isn't open for orders is refused (403)", r.status === 403 && r.body.message === "This shop is not currently accepting orders.");
  d1._raw.exec("UPDATE orgs SET ready = 1 WHERE orgId = 'beta'");

  console.log("\n=== checkDiscountCode: the switches and the rate limit ===");
  globalThis.__f333 = { discounts: false };
  r = await check({ code: "SAVE10", items: TWELVE });
  ok("Discount codes switched off: refused with \"Discount codes aren't available right now.\"", r.status === 400 && r.body.message === OFF_MSG);
  globalThis.__f333 = { storefront: false };
  r = await check({ code: "SAVE10", items: TWELVE });
  ok("Storefront switched off: refused the same way", r.status === 400 && r.body.message === OFF_MSG);
  globalThis.__f333 = { storefront: true, discounts: true };
  r = await check({ code: "SAVE10", items: TWELVE });
  ok("both on (explicitly): it works", r.status === 200 && r.body.discount === 21.6);
  globalThis.__rlBlock333 = "discount_check";
  r = await check({ code: "SAVE10", items: TWELVE });
  const rOrderStill = await shop([{ productId: "mug", qty: 1 }]);
  globalThis.__rlBlock333 = "";
  ok("too many checks from one address: the rate limiter's answer (429), and the check goes no further", r.status === 429 && r.body.status === "error");
  ok("…a bucket of its own: orders from the same address still go through", rOrderStill.status === 200);

  console.log("\n=== checkDiscountCode: every refusal ===");
  const mugs = [{ productId: "mug", qty: 1 }];
  const msg = async (body) => { const x = await check(body); return x.status + " " + x.body.message; };
  ok("no code, a blank one or one that isn't text: \"Enter a discount code.\"",
    await msg({ items: mugs }) === "400 Enter a discount code." && await msg({ code: "   ", items: mugs }) === "400 Enter a discount code." && await msg({ code: 10, items: mugs }) === "400 Enter a discount code.");
  ok("a code longer than 64 characters: not valid", await msg({ code: "A".repeat(65), items: mugs }) === "400 " + INVALID);
  ok("no cart, an empty one, or more than 20 lines: \"Add something to your cart first.\"",
    await msg({ code: "SAVE10" }) === "400 Add something to your cart first." && await msg({ code: "SAVE10", items: [] }) === "400 Add something to your cart first." &&
    await msg({ code: "SAVE10", items: Array.from({ length: 21 }, () => ({ productId: "mug", qty: 1 })) }) === "400 Add something to your cart first.");
  ok("a line that isn't an object or a quantity outside 1–50: the quantity sentence",
    await msg({ code: "SAVE10", items: [null] }) === "400 " + QTY_MESSAGE && await msg({ code: "SAVE10", items: [[]] }) === "400 " + QTY_MESSAGE &&
    await msg({ code: "SAVE10", items: [{ productId: "mug", qty: 51 }] }) === "400 " + QTY_MESSAGE && await msg({ code: "SAVE10", items: [{ productId: "mug", qty: 0 }] }) === "400 " + QTY_MESSAGE);
  ok("a product that isn't named by text: \"Invalid items\"", await msg({ code: "SAVE10", items: [{ productId: 7, qty: 1 }] }) === "400 Invalid items" && await msg({ code: "SAVE10", items: [{ qty: 1 }] }) === "400 Invalid items");
  ok("a product the shop doesn't sell: the pricing's own sentence", await msg({ code: "SAVE10", items: [{ productId: "ghost", qty: 1 }] }) === "400 Product not available: ghost");
  ok("a product that needs the customer's design, sent without one: \"Upload your design to order …\"",
    await msg({ code: "SAVE10", items: [{ productId: "logo", qty: 1 }] }) === "400 Upload your design to order Your Logo Tee.");
  ok("an upload id that isn't one: the design sentence", await msg({ code: "SAVE10", items: [{ productId: "logo", qty: 1, customUploadId: "../x" }] }) === "400 We couldn't find your uploaded design — please upload it again.");
  const errs = []; const realErr = console.error; console.error = (...a) => errs.push(a.join(" "));
  globalThis.__priceFail333 = true;
  r = await check({ code: "SAVE10", items: mugs });
  globalThis.__priceFail333 = false; console.error = realErr;
  ok("pricing that breaks inside: a plain sentence for the customer, the error's own text only in the log",
    r.status === 400 && r.body.message === "We couldn't price your cart — please refresh the page and try again." && !/pricing broke/.test(JSON.stringify(r.body)) &&
    errs.some(e => /Pricing a cart for a discount code failed/.test(e) && /pricing broke/.test(e)));
  ok("an unknown code: not valid, with the email sentence (the same as a code for someone else)", await msg({ code: "NOSUCH", items: mugs }) === "400 " + INVALID_EMAIL);
  ok("a code that couldn't be one (spaces inside): the same sentence", await msg({ code: "SAVE 10", items: mugs }) === "400 " + INVALID_EMAIL);
  ok("a code switched off: not valid", await msg({ code: "OFFNOW", items: mugs }) === "400 " + INVALID);
  ok("a code past its expiry: \"This code has expired.\"", await msg({ code: "OLDCODE", items: mugs }) === "400 This code has expired.");
  r = await check({ code: "LASTDAY", items: mugs });
  ok("…while one that expires today (the business's own day) still works", r.status === 200 && r.body.code === "LASTDAY");
  ok("one person's code with no email typed yet: \"Enter your email address first — this code is for one person.\"",
    await msg({ code: "PATONLY", items: mugs }) === "400 Enter your email address first — this code is for one person." &&
    await msg({ code: "PATONLY", email: "   ", items: mugs }) === "400 Enter your email address first — this code is for one person.");
  r = await check({ code: "PATONLY", email: "sam@example.com", items: mugs });
  ok("…with another email: the same sentence as an unknown code, and the code's own address appears nowhere in the answer",
    r.status === 400 && r.body.message === INVALID_EMAIL && !/pat@/.test(JSON.stringify(r.body)) && keys(r.body) === "message,status");
  r = await check({ code: "PATONLY", email: " Pat@Example.COM ", items: mugs });
  ok("…with its own email (any case, spaces around): it works, and still says nothing of who it is for",
    r.status === 200 && r.body.discount === 5 && keys(r.body) === "code,discount,label,status" && !/pat@/i.test(JSON.stringify(r.body)));
  r = await check({ code: "PATONLY", email: "x".repeat(300) + "@example.com", items: mugs });
  ok("an email longer than an address can be counts as none typed: not this person's code (\"Enter your email address first …\")", r.status === 400 && r.body.message === "Enter your email address first — this code is for one person.");

  console.log("\n=== An order with a code: tax inside the prices ===");
  await S.setSalesTaxSettings(d1, { rateBps: 600, jurisdiction: "OH", taxMode: "inclusive" });
  o = await shop(TWELVE, { discountCode: " save10 ", paymentMethod: "Card", subtotal: 1, total: 1 });
  let got = await S.getOrderById(d1, o.orderId);
  ok("the order is taken (200) and the answer carries the discount, the code, the total after it and what's owed: $216.00 − $21.60 = $194.40",
    o.status === 200 && o.body.status === "ok" && o.body.discount === 21.6 && o.body.discountCode === "SAVE10" && o.body.total === 194.4 && o.body.owed === 194.4);
  ok("…with tax inside the prices the answer names no tax mode", !("taxMode" in o.body) && !("salesTax" in o.body) && typeof o.body.checkoutToken === "string");
  const row = q1("SELECT discountCents, discountNote, discountTaxCents, subtotalCents FROM orders WHERE orderId = ?", o.orderId);
  ok("the order stores the discount like a manual one: 2160 cents, note \"Code SAVE10\", its tax share, on the server's subtotal",
    row.discountCents === 2160 && row.discountNote === "Code SAVE10" && row.discountTaxCents === 122 && row.subtotalCents === 21600);
  ok("…and reads back with its code, the discount and a balance of $194.40", got.discountCode === "SAVE10" && got.discountAmount === 21.6 && got.balanceDue === 194.4 && got.effectiveTotal === 194.4);
  let use = useOf(o.orderId);
  ok("one use is recorded for the order, with the email (lower-case), the amount and no release", !!use && use.code === "SAVE10" && use.email === "pat@example.com" && use.amountCents === 2160 && use.releasedAt === null);
  const firstAnswer = o.body;
  r = await shop(TWELVE, { orderId: o.orderId, discountCode: "SAVE10", paymentMethod: "Card" });
  ok("the same order sent again (a lost answer) is answered as a repeat with the same discount, code, total and owed",
    r.status === 200 && r.body.duplicate === true && r.body.discount === firstAnswer.discount && r.body.discountCode === "SAVE10" &&
    r.body.total === firstAnswer.total && r.body.owed === firstAnswer.owed && typeof r.body.checkoutToken === "string");
  ok("…and takes no second use", liveUses("SAVE10") === 1 && q1("SELECT count(*) AS n FROM discount_code_uses WHERE orderId = ?", o.orderId).n === 1);
  r = await shop(TWELVE, { orderId: o.orderId, paymentMethod: "Card" });
  ok("…even sent again without the code, the repeat answers with the code the order has", r.status === 200 && r.body.duplicate === true && r.body.discountCode === "SAVE10" && r.body.owed === 194.4);
  stripeCalls.length = 0;
  r = await pay(o.orderId, firstAnswer.checkoutToken);
  ok("paying by card charges what's owed after the discount ($194.40, 19440 cents)",
    r.status === 200 && stripeCalls.length === 1 && stripeCalls[0]["line_items[0][price_data][unit_amount]"] === "19440");
  o = await shop([{ productId: "mug", qty: 1 }]);
  ok("an order without a code answers no discount fields and records no use",
    o.status === 200 && !("discount" in o.body) && !("discountCode" in o.body) && !("owed" in o.body) && !useOf(o.orderId) && (await S.getOrderById(d1, o.orderId)).discountCode === "");
  o = await shop([{ productId: "mug", qty: 1 }], { discountCode: "   " });
  const o2 = await shop([{ productId: "mug", qty: 1 }], { discountCode: "" });
  const o3 = await shop([{ productId: "mug", qty: 1 }], { discountCode: null });
  ok("a blank code (spaces, empty, null) is no code: the order is taken at full price", o.status === 200 && o2.status === 200 && o3.status === 200 &&
    !("discount" in o.body) && !useOf(o.orderId) && q1("SELECT discountCents FROM orders WHERE orderId = ?", o.orderId).discountCents === 0);
  o = await shop([{ productId: "mug", qty: 1 }], { discountCode: "BIGOFF" });
  ok("a code worth more than the goods takes them to $0.00: discount $10.00, owed $0.00", o.status === 200 && o.body.discount === 10 && o.body.owed === 0 && o.body.total === 0);
  const errs0 = []; console.error = (...a) => errs0.push(a.join(" "));
  r = await pay(o.orderId, o.body.checkoutToken);
  console.error = realErr;
  ok("…and there's nothing to charge by card (refused, no Stripe call)", r.status === 400 && r.body.message === "Could not verify order total." && stripeCalls.length === 1);

  console.log("\n=== An order with a code: tax added on top ===");
  await S.setSalesTaxSettings(d1, { rateBps: 600, jurisdiction: "OH", taxMode: "exclusive" });
  o = await shop(TWELVE, { discountCode: "SAVE10", paymentMethod: "Card" });
  got = await S.getOrderById(d1, o.orderId);
  ok("with tax on top: discount $21.60, the tax after it $11.66 ($12.96 less $1.30 on the discount), and total = owed = $206.06",
    o.status === 200 && o.body.taxMode === "exclusive" && o.body.discount === 21.6 && o.body.discountCode === "SAVE10" && o.body.salesTax === 11.66 && o.body.total === 206.06 && o.body.owed === 206.06);
  ok("…the figures the order reads back with", got.balanceDue === 206.06 && got.effectiveTotal === 206.06 && got.salesTax === 11.66 && got.discountCode === "SAVE10");
  const exFirst = o.body;
  r = await shop(TWELVE, { orderId: o.orderId, discountCode: "SAVE10", paymentMethod: "Card" });
  ok("the repeat answers the same tax mode, sales tax, discount, code, total and owed", r.status === 200 && r.body.duplicate === true && r.body.taxMode === "exclusive" &&
    r.body.salesTax === exFirst.salesTax && r.body.discount === exFirst.discount && r.body.discountCode === exFirst.discountCode && r.body.total === exFirst.total && r.body.owed === exFirst.owed);
  stripeCalls.length = 0;
  r = await pay(o.orderId, exFirst.checkoutToken);
  ok("paying by card charges $206.06 (20606 cents), and says how much of it is tax", r.status === 200 && stripeCalls.length === 1 &&
    stripeCalls[0]["line_items[0][price_data][unit_amount]"] === "20606" && /includes \$11\.66 sales tax/.test(stripeCalls[0]["line_items[0][price_data][product_data][description]"] || JSON.stringify(stripeCalls[0])));
  o = await shop([{ productId: "mug", qty: 1 }]);
  ok("…an order without a code with tax on top answers its tax and total and no discount fields", o.status === 200 && o.body.taxMode === "exclusive" && o.body.total === 10.6 && !("discount" in o.body) && !("owed" in o.body));
  await S.setSalesTaxSettings(d1, { rateBps: 600, jurisdiction: "OH", taxMode: "inclusive" });

  console.log("\n=== An order refused for its code ===");
  const refused = async (extra, items = [{ productId: "mug", qty: 1 }]) => { const before = orderCount(), uses = q1("SELECT count(*) AS n FROM discount_code_uses").n;
    const x = await shop(items, extra); return { ...x, none: orderCount() === before && q1("SELECT count(*) AS n FROM discount_code_uses").n === uses }; };
  r = await refused({ discountCode: 10 });
  ok("a code that isn't text: \"This code isn't valid.\", no order, no use", r.status === 400 && r.body.message === INVALID && r.none);
  r = await refused({ discountCode: "A".repeat(65) });
  ok("a code longer than 64: the same", r.status === 400 && r.body.message === INVALID && r.none);
  r = await refused({ discountCode: "NOSUCH" });
  ok("an unknown code: the check's own reason, no order", r.status === 400 && r.body.message === INVALID_EMAIL && r.none);
  r = await refused({ discountCode: "OLDCODE" });
  ok("an expired code: \"This code has expired.\", no order", r.status === 400 && r.body.message === "This code has expired." && r.none);
  r = await refused({ discountCode: "OFFNOW" });
  ok("a code switched off: not valid, no order", r.status === 400 && r.body.message === INVALID && r.none);
  r = await refused({ discountCode: "BETAONLY", orgId: "beta" });
  ok("another shop's code (the request naming that shop changes nothing on this shop's address): not valid", r.status === 400 && r.body.message === INVALID && r.none);
  r = await refused({ discountCode: "PATONLY", contact: "sam@example.com" });
  ok("one person's code on an order with another email: the not-valid sentence that names no address", r.status === 400 && r.body.message === INVALID_EMAIL && !/pat@/.test(JSON.stringify(r.body)) && r.none);
  globalThis.__f333 = { discounts: false };
  r = await refused({ discountCode: "SAVE10" });
  const rNoCode = await shop([{ productId: "mug", qty: 1 }]);
  globalThis.__f333 = {};
  ok("Discount codes switched off: an order sending a code is refused with \"Discount codes aren't available right now.\"", r.status === 400 && r.body.message === OFF_MSG && r.none);
  ok("…while an order without one is taken as before", rNoCode.status === 200);
  r = await refused({ discountCode: "SAVE10" }, [{ productId: "mug", qty: 1 }]);
  ok("(the same code with the switch back on is taken)", r.status === 200 && r.body.discountCode === "SAVE10");

  console.log("\n=== One person's code, once ===");
  o = await shop([{ productId: "mug", qty: 2 }], { discountCode: "PATONLY", contact: " Pat@Example.com " });
  ok("one person's code on an order with their email (any case, spaces around) is taken: $5.00 off $20.00", o.status === 200 && o.body.discount === 5 && o.body.owed === 15);
  ok("…its use is recorded with the address as compared (trimmed, lower-case)", useOf(o.orderId).email === "pat@example.com");
  r = await refused({ discountCode: "PATONLY" });
  ok("…a second order with it: \"This code has already been used.\", no order", r.status === 400 && r.body.message === "This code has already been used." && r.none);
  r = await check({ code: "PATONLY", email: "pat@example.com", items: mugs });
  ok("…and the storefront's check says the same", r.status === 400 && r.body.message === "This code has already been used.");
  o = await shop([{ productId: "mug", qty: 1 }], { discountCode: "ONCEEACH" });
  r = await refused({ discountCode: "ONCEEACH", contact: "PAT@example.com" });
  const oOther = await shop([{ productId: "mug", qty: 1 }], { discountCode: "ONCEEACH", contact: "sam@example.com" });
  ok("a once-per-email code: the same email again is refused (\"You've already used this code.\"), another email is taken",
    o.status === 200 && r.status === 400 && r.body.message === "You've already used this code." && r.none && oOther.status === 200);

  console.log("\n=== Two orders racing for a code's last use ===");
  await make({ code: "LASTONE", kind: "amount", amount: 3, maxUses: 2 });
  o = await shop([{ productId: "mug", qty: 1 }], { discountCode: "LASTONE" });
  ok("the code has one use left", o.status === 200 && liveUses("LASTONE") === 1);
  // Both orders pass the check (one use left for each) before either claims it.
  const gate = barrier(2);
  globalThis.__afterCheck333 = async (res) => { if (res && res.ok && res.code.code === "LASTONE") await gate(); };
  const before = orderCount();
  const [ra, rb] = await Promise.all([
    shop([{ productId: "mug", qty: 1 }], { discountCode: "LASTONE", contact: "sam@example.com" }),
    shop([{ productId: "mug", qty: 1 }], { discountCode: "LASTONE", contact: "lee@example.com" }),
  ]);
  globalThis.__afterCheck333 = null;
  const wins = [ra, rb].filter(x => x.status === 200), losses = [ra, rb].filter(x => x.status === 400);
  ok("both passed the check, but only one order gets the last use: one taken, one refused with \"This code has reached its limit.\"",
    wins.length === 1 && losses.length === 1 && losses[0].body.message === "This code has reached its limit." && wins[0].body.discountCode === "LASTONE");
  ok("…one order made, and the code's uses are exactly its 2", orderCount() === before + 1 && liveUses("LASTONE") === 2 && !useOf(losses[0].orderId));
  await make({ code: "SOLO", kind: "percent", percent: 50, maxUses: 1 });
  const gate2 = barrier(2);
  globalThis.__afterCheck333 = async (res) => { if (res && res.ok && res.code.code === "SOLO") await gate2(); };
  const [sa, sb] = await Promise.all([shop(mugs, { discountCode: "SOLO", contact: "sam@example.com" }), shop(mugs, { discountCode: "SOLO", contact: "lee@example.com" })]);
  globalThis.__afterCheck333 = null;
  ok("a single-use code raced for: one order has it, the other hears \"This code has already been used.\"",
    [sa, sb].filter(x => x.status === 200).length === 1 && [sa, sb].some(x => x.status === 400 && x.body.message === "This code has already been used.") && liveUses("SOLO") === 1);

  console.log("\n=== The use given back when the order can't be written ===");
  await make({ code: "ONEUSE", kind: "amount", amount: 4, maxUses: 1 });
  globalThis.__released333 = 0;
  globalThis.__ins333 = [async () => { throw new Error("the database fell over (test)"); }];
  let threw = null;
  try { await shop(mugs, { orderId: "WEB-FAIL1", discountCode: "ONEUSE" }); } catch (e) { threw = e; }
  ok("an order whose insert fails isn't made (the error goes on to the error page)", !!threw && /fell over/.test(threw.message) && !(await S.getOrderById(d1, "WEB-FAIL1")));
  use = useOf("WEB-FAIL1");
  ok("…and the use it claimed is given back (released, not deleted), so the single-use code is free again",
    globalThis.__released333 === 1 && !!use && use.releasedAt !== null && liveUses("ONEUSE") === 0);
  o = await shop(mugs, { orderId: "WEB-FAIL1", discountCode: "ONEUSE" });
  ok("the customer trying the same order again gets the code: the given-back use is taken back for that order", o.status === 200 && o.body.discountCode === "ONEUSE" &&
    useOf("WEB-FAIL1").releasedAt === null && liveUses("ONEUSE") === 1 && q1("SELECT count(*) AS n FROM discount_code_uses WHERE orderId = 'WEB-FAIL1'").n === 1);
  await make({ code: "ONEMORE", kind: "amount", amount: 4, maxUses: 1 });
  globalThis.__ins333 = [async () => { throw new Error("the database fell over again (test)"); }];
  globalThis.__releaseFail333 = true;
  const errs2 = []; console.error = (...a) => errs2.push(a.join(" "));
  threw = null;
  try { await shop(mugs, { orderId: "WEB-FAIL2", discountCode: "ONEMORE" }); } catch (e) { threw = e; }
  console.error = realErr; globalThis.__releaseFail333 = false;
  ok("if giving the use back fails too, that's logged and the insert's own error still goes on", !!threw && /fell over again/.test(threw.message) &&
    errs2.some(e => /Giving back a discount code's use failed for WEB-FAIL2/.test(e)));
  globalThis.__released333 = 0;
  globalThis.__ins333 = [];
  o = await shop(mugs, { orderId: "WEB-NOCODE-FAIL" });
  ok("(an order without a code gives nothing back)", o.status === 200 && globalThis.__released333 === 0);

  console.log("\n=== The same order sent twice at once ===");
  // Copy A claims the use and is held just before its insert; copy B (same order id) finds A's use, and its insert fails.
  await make({ code: "TWICE", kind: "amount", amount: 2, maxUses: 5 });
  let releaseA; const heldA = new Promise((res) => { releaseA = res; });
  let reachedA = false;
  globalThis.__released333 = 0;
  globalThis.__ins333 = [async () => { reachedA = true; await heldA; }, async () => { throw new Error("copy B's insert failed (test)"); }];
  const twin = { orderId: "WEB-TWIN1", discountCode: "TWICE" };
  const pA = shop(mugs, twin);
  while (!reachedA) await tick();
  threw = null;
  try { await shop(mugs, twin); } catch (e) { threw = e; }
  ok("copy B's insert fails while copy A still holds the order's use: B doesn't give it back (it isn't B's)",
    !!threw && globalThis.__released333 === 0 && useOf("WEB-TWIN1").releasedAt === null);
  releaseA();
  o = await pA;
  ok("…and copy A's order is made with the code, its use still live", o.status === 200 && o.body.discountCode === "TWICE" && useOf("WEB-TWIN1").releasedAt === null &&
    (await S.getOrderById(d1, "WEB-TWIN1")).discountCode === "TWICE" && liveUses("TWICE") === 1);
  // Copy A claims first and is held; copy B (finding A's use) writes the order; A's insert then meets B's order.
  let releaseC; const heldC = new Promise((res) => { releaseC = res; });
  let reachedC = false;
  globalThis.__ins333 = [async () => { reachedC = true; await heldC; }];
  const twin2 = { orderId: "WEB-TWIN2", discountCode: "TWICE" };
  const pC = shop(mugs, twin2);
  while (!reachedC) await tick();
  const oB = await shop(mugs, twin2);
  releaseC();
  const oC = await pC;
  ok("copy B writes the order with the code; copy A, meeting it, is answered as its repeat with the same discount and owed",
    oB.status === 200 && oB.body.discountCode === "TWICE" && oC.status === 200 && oC.body.duplicate === true && oC.body.discountCode === "TWICE" &&
    oC.body.discount === oB.body.discount && oC.body.owed === oB.body.owed);
  ok("…and the order keeps its use: copy A doesn't give back the use the written order was booked with",
    !!useOf("WEB-TWIN2") && useOf("WEB-TWIN2").releasedAt === null && (await S.getOrderById(d1, "WEB-TWIN2")).discountCode === "TWICE" && liveUses("TWICE") === 2);
  // Copy A (with the code) claims and is held; another order under the same id without a code is written first.
  let releaseE; const heldE = new Promise((res) => { releaseE = res; });
  let reachedE = false;
  globalThis.__ins333 = [async () => { reachedE = true; await heldE; }];
  const pE = shop(mugs, { orderId: "WEB-TWIN3", discountCode: "TWICE" });
  while (!reachedE) await tick();
  const oF = await shop(mugs, { orderId: "WEB-TWIN3" });
  releaseE();
  const oE = await pE;
  ok("an order under the same id written without the code first: the coded copy is answered as its repeat, and its claimed use is given back",
    oF.status === 200 && !("discountCode" in oF.body) && oE.status === 200 && oE.body.duplicate === true && !("discountCode" in oE.body) &&
    useOf("WEB-TWIN3").releasedAt !== null && liveUses("TWICE") === 2);
  // Copy A is held at its insert again; copy B writes the order; then the read of B's discount fails, so A can't tell
  // whether the written order has the code: it gives its claimed use back, and is still answered as the repeat.
  let releaseG; const heldG = new Promise((res) => { releaseG = res; });
  let reachedG = false;
  globalThis.__released333 = 0;
  globalThis.__ins333 = [async () => { reachedG = true; await heldG; }];
  const twin4 = { orderId: "WEB-TWIN4", discountCode: "TWICE" };
  const pG = shop(mugs, twin4);
  while (!reachedG) await tick();
  const oH = await shop(mugs, twin4);
  const realPrepare = d1.prepare;
  let discountReads = 0;
  d1.prepare = function (sql) {
    if (/^SELECT discountCents FROM orders WHERE orderId = \?/.test(sql)) { discountReads++; throw new Error("D1_ERROR: read failed (test)"); }
    return realPrepare.apply(this, arguments);
  };
  releaseG();
  let oG;
  try { oG = await pG; } finally { d1.prepare = realPrepare; }
  ok("the written order's discount can't be read: copy A can't tell the use is the order's, so it gives it back, and is still answered as its repeat",
    oH.status === 200 && oH.body.discountCode === "TWICE" && oG.status === 200 && oG.body.duplicate === true &&
    discountReads === 1 && globalThis.__released333 === 1 && useOf("WEB-TWIN4").releasedAt !== null);
  globalThis.__ins333 = [];
  // Copy B has passed the code check when copy A — the same order, sent with another code — is written; B's claim then
  // finds the order holding A's code, and B is answered as the repeat of A, not refused.
  let racedIn = null;
  globalThis.__afterCheck333 = async (res) => {
    if (!(res && res.ok && res.code.code === "SAVE10")) return;
    globalThis.__afterCheck333 = null;
    racedIn = await shop(mugs, { orderId: "WEB-TWIN5", discountCode: "FIVE" });
  };
  const save10Uses = liveUses("SAVE10");
  const oJ = await shop(mugs, { orderId: "WEB-TWIN5", discountCode: "SAVE10" });
  globalThis.__afterCheck333 = null;
  ok("an order whose code claim finds the same order already written with another code is answered as its repeat (FIVE, its discount and owed)",
    !!racedIn && racedIn.status === 200 && racedIn.body.discountCode === "FIVE" && oJ.status === 200 && oJ.body.duplicate === true &&
    oJ.body.discountCode === "FIVE" && oJ.body.owed === racedIn.body.owed && useOf("WEB-TWIN5").code === "FIVE" && liveUses("SAVE10") === save10Uses);

  console.log("\n=== A voided order gives its use back ===");
  o = await shop(mugs, { discountCode: "FIVE" });
  const fiveBefore = liveUses("FIVE");
  r = await admin({ action: "voidOrder", orderId: o.orderId, reason: "Customer changed their mind" });
  ok("voiding an order with a code gives the use back", r.status === 200 && liveUses("FIVE") === fiveBefore - 1 && useOf(o.orderId).releasedAt !== null);
  r = await shop(mugs, { orderId: o.orderId, discountCode: "FIVE" });
  ok("…and the voided order's id can't be reused as a repeat of it", r.status === 409);

  console.log("\n=== A database without 0115 yet ===");
  const old = await newDb("0115");
  const H2 = harness(old);
  await H2.admin({ action: "createProduct", productId: "mug", type: "other", name: "Club Mug", pricingMode: "flat", flatPrice: 10, visible: true, weightOz: 10, noDesignNeeded: true });
  r = await H2.check({ code: "SAVE10", items: mugs });
  ok("the storefront's check: \"Discount codes aren't available right now.\" (no tables, no crash)", r.status === 400 && r.body.message === OFF_MSG);
  const oldBefore = old.q("SELECT count(*) AS n FROM orders")[0].n;
  r = await H2.shop(mugs, { discountCode: "SAVE10" });
  ok("an order sending a code: refused the same way, and no order is made", r.status === 400 && r.body.message === OFF_MSG && old.q("SELECT count(*) AS n FROM orders")[0].n === oldBefore);
  r = await H2.shop(mugs);
  ok("…an order without one is taken as before", r.status === 200 && !("discount" in r.body));
})().catch((e) => { console.log("test369 crashed", e && e.stack || e); process.exit(1); });
