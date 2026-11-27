// Gift cards and codes on the customer's side (phase 6, migrations/0120), through the real handlers:
//   * functions/api/orders.js "checkGiftCard": the answer for a good card, one answer for an unknown, voided or
//     mistyped number (never whose a card is), an empty card's own sentence, its rate-limit bucket (giftcard_check, 10
//     a minute), the Gift cards and Storefront switches and the Gift card payment method, the admin host, and a
//     database a migration behind;
//   * the storefront order with giftCards: up to 3, each spent after the order is saved, in order, up to its amount and
//     what is still owed; a refused card reported without failing the order; cards that cover everything leave it paid
//     (no card step); a card together with a code in one-code mode; a repeat of the same order;
//   * "buyGiftCard": selling online off, card payments off, the amount (a button or within min–max), the names and
//     addresses, one order per requestId, the order's shape (one untaxed "__giftcard__" line, the gift in its
//     configJson, the buyer as the customer) and Stripe Checkout started for it like a card order;
//   * functions/api/stripe-webhook.js: the card made once the payment is in (sourceOrderId), the email to the recipient,
//     the buyer's "was sent" note and the owner's gift_card notice; a replay makes no card and sends nothing; an unpaid
//     or voided order makes none; a failure to make it is retried, a failed email is recorded;
//   * functions/api/invoice.js "applyCode" / "applyGiftCard": only that invoice's order, only while it owes, its rules,
//     rate limits and refusals;
//   * functions/api/catalog.js: discountRules, giftCardPay and giftCards (in dollars), read fresh.
// Real SQL (sql.js) under the real db.js, email.js, orders.js, invoice.js, checkout.js, stripe-webhook.js and catalog.js.
// Invented shops, people and codes only; gift card numbers are made by the code.
const fs = require("fs");
const nodeCrypto = require("crypto");
const { ok } = require("./testlib/check");
const { createD1 } = require("./testlib/d1-shim.js");
const { adminAs } = require("./testlib/roles");
const { MAIL_ENV, MAIL_OK, captureMail } = require("./testlib/mail-mock");
const { ADMIN_ORIGIN, ROOT, shopOrigin } = require("./testlib/hosts.js");

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");

// Two of db.js's functions get a wrapper the test can make throw; each calls the real one.
const dbSrc = strip(read("functions/_lib/db.js")
  .replace("export async function applyOrderDiscountCode(", "async function applyOrderDiscountCode_real393_(")
  .replace("export async function redeemGiftCard(", "async function redeemGiftCard_real393_(")) + `
async function applyOrderDiscountCode(...a) { if (globalThis.__throw393 === "code") throw new Error("code check broke (test)"); return applyOrderDiscountCode_real393_(...a); }
async function redeemGiftCard(...a) { if (globalThis.__throw393 === "card") throw new Error("card spend broke (test)"); return redeemGiftCard_real393_(...a); }
`;
// The mail provider is a fake fetch (below); everything else in email.js is real.
const libs = strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  strip(read("functions/_lib/quoteToken.js")) + "\n" + strip(read("functions/_lib/boxSize.js")) + "\n";
globalThis.__f393 = {};
globalThis.__rl393 = [];
const rlStub = "const rateLimited = async (env, bucket, req, limit) => { globalThis.__rl393.push(bucket + '/' + limit); return { blocked: globalThis.__rlBlock393 === bucket, retryAfter: 30 }; };\n" +
  "const rateLimitResponse = (s) => jsonResponse({ status: 'error', message: 'Too many tries — wait ' + s + ' seconds.' }, 429);\n";
const A = new Function(libs +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" + adminAs() + "\n" + rlStub +
  "const verifyTurnstile = async () => globalThis.__bot393 ? { ok: false, message: 'Please confirm you are not a robot.' } : { ok: true };\n" +
  "const invalidateCatalogVersionCache = () => {};\n" +
  "const getCatalogData = async () => ({ subdomainMap: { acme: 'acme', beta: 'beta' }, orgs: {}, features: globalThis.__f393 });\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/_lib/email.js")) + "\n" + strip(read("functions/_lib/digital.js")) + "\n" +
  "const ordersApi = (function(){\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost; })();\n" +
  "const invoiceApi = (function(){\n" + strip(read("functions/api/invoice.js")) + "\nreturn { onRequestGet, onRequestPost }; })();\n" +
  "const checkoutApi = (function(){\n" + strip(read("functions/api/checkout.js")) + "\nreturn onRequestPost; })();\n" +
  "const webhookApi = (function(){\n" + strip(read("functions/api/stripe-webhook.js")) + "\nreturn onRequestPost; })();\n" +
  "return { ordersApi, invoiceApi, checkoutApi, webhookApi, issueGiftCard, adjustGiftCard, voidGiftCard, getOrderById, saveDiscountCode, setSalesTaxSettings, localToday, " +
  "setDiscountRules, setGiftCardSettings, getOrderInvoiceByOrder, voidOrder, setFeatures };")();

// The catalog: the real catalogCache.js and catalog.js on the same kind of database (the Cache API is a Map).
const C = new Function(libs + strip(read("functions/_lib/db.js")) + "\n" + strip(read("functions/_lib/catalogCache.js")) + "\n" +
  "const catalogApi = (function(){\n" + strip(read("functions/api/catalog.js")) + "\nreturn { onRequestGet }; })();\n" +
  "return { catalogGet: catalogApi.onRequestGet, createProduct, publishShop, setFeatures, setDiscountRules, setGiftCardSettings, _resetCatalogCacheState };")();
function freshCacheApi() {
  const store = new Map();
  global.caches = { default: {
    async match(key) { const hit = store.get(typeof key === "string" ? key : key.url); return hit ? hit.clone() : undefined; },
    async put(key, response) { store.set(typeof key === "string" ? key : key.url, response); },
  } };
  C._resetCatalogCacheState();
}

// The fake outside world: the mail provider (it can be made to fail) and Stripe (Checkout pages).
const mail = [], stripeCalls = [];
global.fetch = async (url, init) => {
  if (captureMail(url, init, mail)) return globalThis.__mailDown393 ? { ok: false, status: 500, json: async () => ({ success: false, errors: [{ message: "down (test)" }] }) } : MAIL_OK;
  if (/api\.stripe\.com/.test(String(url))) {
    stripeCalls.push(Object.fromEntries(new URLSearchParams(String((init && init.body) || ""))));
    return { ok: true, status: 200, json: async () => ({ url: "https://checkout.stripe.test/s/" + stripeCalls.length, id: "cs_" + stripeCalls.length, status: "open" }) };
  }
  throw new Error("unexpected fetch " + url);
};

const ENV = { SIGNING_SECRET: "s".repeat(40), STRIPE_SECRET_KEY: "sk_test_example", DESIGNS: {}, ...MAIL_ENV };
const WHSEC = "whsec_example";
const migrations = fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort();
const newDb = async (before) => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of migrations) if (!before || f < before) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready, shippingEnabled) VALUES
    ('acme','acme','Example Club','t','t',1,1), ('beta','beta','Sample League','t','t',1,1);`);
  return d1;
};
const keys = (o) => Object.keys(o || {}).sort().join(",");
const BAD = "That gift card number isn't right.";
const EMPTY = "This gift card has no balance left.";
const OFF = "Gift cards aren't available right now.";
const quietly = async (fn) => { const err = console.error, logged = []; console.error = (...a) => logged.push(a.map(String).join(" ")); try { return { v: await fn(), logged }; } finally { console.error = err; } };

const harness = (d1, env = {}) => {
  const E = { DB: d1, ...ENV, ...env };
  const call = async (fn, url, body, extra = {}) => {
    const waits = [];
    const res = await fn({ env: E, waitUntil: (p) => waits.push(Promise.resolve(p).catch(() => {})),
      request: { url, json: async () => body, headers: { get: (h) => (h === "CF-Connecting-IP" ? "203.0.113.7" : null) } }, ...extra });
    await Promise.all(waits);
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const admin = (body) => call(A.ordersApi, ADMIN_ORIGIN + "/api/orders", { key: "x", org: "acme", ...body });
  const post = (body, origin = shopOrigin("acme")) => call(A.ordersApi, origin + "/api/orders", body);
  const check = (code, origin) => post({ action: "checkGiftCard", code }, origin);
  let n = 0;
  const shop = async (items, extra = {}, origin = shopOrigin("acme")) => { const orderId = extra.orderId || "WEB-" + (++n);
    return { orderId, ...(await post({ orderId, orgId: "acme", customerName: "Pat Example", contact: "pat@example.com", paymentMethod: "Check", items, ...extra }, origin)) }; };
  const buy = (body, origin = shopOrigin("acme")) => post({ action: "buyGiftCard", amountCents: 5000, recipientName: "Sam Example", recipientEmail: "sam@example.com",
    buyerName: "Pat Example", buyerEmail: "pat@example.com", message: "Happy birthday!", ...body }, origin);
  const pay = (orderId, checkoutToken) => call(A.checkoutApi, shopOrigin("acme") + "/api/checkout", { orderId, orgId: "acme", checkoutToken });
  const inv = (body) => call(A.invoiceApi.onRequestPost, shopOrigin("acme") + "/api/invoice", body);
  const invGet = async (token) => { const res = await A.invoiceApi.onRequestGet({ env: E, request: { url: shopOrigin("acme") + "/api/invoice?token=" + token, headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) }; };
  // A Stripe event, signed as Stripe signs it.
  const hook = async (event) => {
    const body = JSON.stringify(event), t = Math.floor(Date.now() / 1000);
    const sig = nodeCrypto.createHmac("sha256", WHSEC).update(t + "." + body).digest("hex");
    const res = await A.webhookApi({ env: { DB: d1, STRIPE_WEBHOOK_SECRET: WHSEC, SIGNING_SECRET: ENV.SIGNING_SECRET, ...MAIL_ENV, ...env },
      request: { text: async () => body, headers: { get: (h) => (h === "stripe-signature" ? `t=${t},v1=${sig}` : null) } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  return { E, admin, post, check, shop, buy, pay, inv, invGet, hook };
};

(async () => {
  const d1 = await newDb();
  const H = harness(d1);
  const { admin, check, shop, buy, pay, inv, invGet, hook } = H;
  const q = (sql, ...p) => d1.q(sql, ...p);
  const q1 = (sql, ...p) => d1.q(sql, ...p)[0] || null;
  const card = async (dollars, extra = {}) => { const r = await A.issueGiftCard(d1, { amountCents: Math.round(dollars * 100), recipientName: "Lee Example", recipientEmail: "lee@example.com", by: "test", ...extra });
    if (!r.code) throw new Error("couldn't issue " + JSON.stringify(r)); return r; };
  const balance = (id) => q1("SELECT balanceCents FROM gift_cards WHERE id = ?", id).balanceCents;
  const orderCount = () => q1("SELECT count(*) AS n FROM orders").n;
  let r;

  r = await admin({ action: "createProduct", productId: "mug", type: "other", name: "Club Mug", pricingMode: "flat", flatPrice: 10, visible: true, weightOz: 10, noDesignNeeded: true });
  ok("the shop's product is made: a $10.00 mug", r.status === 200);
  const MUG = (qty) => [{ productId: "mug", qty }];

  d1.q("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('business', ?)", JSON.stringify({ name: "Example Embroidery" }));
  const setGlobalPayments = (v) => d1.q("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('enabledPayments', ?)", JSON.stringify(v));
  const setShopPayments = (orgId, v) => d1.q("UPDATE orgs SET enabledPayments = ? WHERE orgId = ?", JSON.stringify(v), orgId);
  const ALL_ON = { card: true, venmo: true, zelle: true, check: true };

  // =================================================================================================================
  console.log("\n=== checkGiftCard: what a customer is told about a number ===");
  // =================================================================================================================
  const good = await card(40);
  globalThis.__rl393 = [];
  r = await check(good.code);
  ok("a good card answers ok, its last four characters and its balance in dollars", r.status === 200 && r.body.status === "ok" && r.body.ok === true &&
    r.body.last4 === good.code.slice(-4) && r.body.balance === 40);
  ok("…and nothing else: never the full number, the names, the emails or the history", keys(r.body) === "balance,last4,ok,status" && !/Lee|@|issue/.test(JSON.stringify(r.body)));
  ok("…the check is counted in its own rate-limit bucket, giftcard_check, at 10 a minute", globalThis.__rl393.join(" ") === "giftcard_check/10");
  const grouped = good.code.toLowerCase().replace(/(.{4})(?=.)/g, "$1- ");
  r = await check("  " + grouped + " ");
  ok("the number typed in lower case, in groups with dashes and spaces, is the same card", r.status === 200 && r.body.ok === true && r.body.balance === 40);
  const voided = await card(30);
  await A.voidGiftCard(d1, { id: voided.id, note: "lost (test)", by: "test" });
  const unknown = "ABCDEFGHJKLMNPQR" === good.code ? "BCDEFGHJKLMNPQRS" : "ABCDEFGHJKLMNPQR";
  const rUnknown = await check(unknown), rVoid = await check(voided.code), rShort = await check("1234"), rLong = await check("A".repeat(65));
  ok("a number nobody has answers 200 with ok false and \"That gift card number isn't right.\" as reason and message",
    rUnknown.status === 200 && rUnknown.body.status === "ok" && rUnknown.body.ok === false && rUnknown.body.reason === BAD && rUnknown.body.message === BAD);
  ok("…a voided card, a mistyped number and one longer than 64 characters get exactly the same answer, so nothing is learned about which exist",
    [rVoid, rShort, rLong].every(x => x.status === 200 && JSON.stringify(x.body) === JSON.stringify(rUnknown.body)));
  const spent = await card(5);
  await A.adjustGiftCard(d1, { id: spent.id, deltaCents: -500, note: "used up (test)", by: "test" });
  r = await check(spent.code);
  ok("a card with nothing left says \"This gift card has no balance left.\"", r.status === 200 && r.body.ok === false && r.body.reason === EMPTY && r.body.message === EMPTY);
  const r1 = await check(""), r2 = await check("   "), r3 = await check(12345678);
  ok("no number, a blank one or one that isn't text: 400 \"Enter the gift card number.\"",
    [r1, r2, r3].every(x => x.status === 400 && x.body.status === "error" && x.body.message === "Enter the gift card number."));
  r = await check(good.code, ADMIN_ORIGIN);
  ok("the admin's own pages may check a card (the order's Payments window): it answers on the admin host too", r.status === 200 && r.body.ok === true && r.body.balance === 40);
  r = await check(good.code, "https://nobody." + ROOT);
  ok("an unknown shop address is unrecognized (404)", r.status === 404);
  globalThis.__rlBlock393 = "giftcard_check";
  r = await check(good.code);
  globalThis.__rlBlock393 = "";
  ok("too many checks from one address: the rate limiter's answer (429) and no balance", r.status === 429 && r.body.status === "error" && !("balance" in r.body));
  globalThis.__f393 = { giftCards: false };
  const rOff = await check(good.code), rOffAdmin = await check(good.code, ADMIN_ORIGIN);
  ok("the Gift cards feature switched off: 400 \"Gift cards aren't available right now.\", on a shop and on the admin host",
    rOff.status === 400 && rOff.body.message === OFF && rOffAdmin.status === 400 && rOffAdmin.body.message === OFF);
  globalThis.__f393 = { storefront: false };
  const rNoShop = await check(good.code), rNoShopAdmin = await check(good.code, ADMIN_ORIGIN);
  ok("the Storefront switched off: refused the same way on a shop's address, while the admin host still checks cards",
    rNoShop.status === 400 && rNoShop.body.message === OFF && rNoShopAdmin.status === 200 && rNoShopAdmin.body.ok === true);
  globalThis.__f393 = {};
  setGlobalPayments({ ...ALL_ON, giftCard: false });
  r = await check(good.code);
  setGlobalPayments({ ...ALL_ON, giftCard: true });
  const rBack = await check(good.code);
  ok("the Gift card payment method switched off in Global settings: refused the same way; on again, it answers", r.status === 400 && r.body.message === OFF && rBack.status === 200 && rBack.body.ok === true);
  ok("…and checking never spends anything", balance(good.id) === 4000 && q1("SELECT count(*) AS n FROM gift_card_ledger WHERE cardId = ? AND kind <> 'issue'", good.id).n === 0);
  {
    const old = await newDb("0120");
    const Hold = harness(old);
    r = await Hold.check(good.code);
    ok("a database a migration behind (no gift card tables yet): the same \"isn't right\" answer, not an error", r.status === 200 && r.body.ok === false && r.body.reason === BAD);
  }

  // =================================================================================================================
  console.log("\n=== A storefront order paid in part or in full by gift cards ===");
  // =================================================================================================================
  const c15 = await card(15);
  let o = await shop(MUG(2), { giftCards: [{ code: c15.code }] });
  ok("a $15.00 card on a $20.00 order: the order is placed, the card reported as used ($15.00 taken, $0.00 left) and $5.00 still owed",
    o.status === 200 && o.body.status === "ok" && JSON.stringify(o.body.giftCards) === JSON.stringify([{ ok: true, last4: c15.last4, taken: 15, balance: 0 }]) &&
    o.body.owed === 5 && o.body.paid === false && o.body.total === 20);
  let pay1 = q1("SELECT * FROM order_payments WHERE orderId = ?", o.orderId);
  ok("…booked as a payment (never a discount): method other, the card's id, \"Gift card ••" + c15.last4 + "\", \"Paid by gift card\", no bank account",
    pay1 && pay1.amountCents === 1500 && pay1.method === "other" && pay1.giftCardId === c15.id && pay1.reference === "Gift card ••" + c15.last4 &&
    pay1.note === "Paid by gift card" && pay1.accountId === null && pay1.kind === "payment" && q1("SELECT discountCents FROM orders WHERE orderId = ?", o.orderId).discountCents === 0);
  ok("…the card's ledger has the spend against this order and its balance is $0.00",
    balance(c15.id) === 0 && JSON.stringify(q("SELECT kind, deltaCents, orderId, paymentId FROM gift_card_ledger WHERE cardId = ? ORDER BY id", c15.id)) ===
      JSON.stringify([{ kind: "issue", deltaCents: 1500, orderId: "", paymentId: null }, { kind: "redeem", deltaCents: -1500, orderId: o.orderId, paymentId: pay1.id }]));
  ok("…and the order isn't paid yet: the rest goes by the method the customer chose", q1("SELECT paid, paymentMethod FROM orders WHERE orderId = ?", o.orderId).paid === 0);

  const c100 = await card(100);
  o = await shop(MUG(2), { paymentMethod: "Card", giftCards: [{ code: c100.code }] });
  ok("a $100.00 card on a $20.00 card order takes only the $20.00 owed, keeps $80.00, and the order is paid (owed 0)",
    o.status === 200 && o.body.giftCards[0].taken === 20 && o.body.giftCards[0].balance === 80 && o.body.owed === 0 && o.body.paid === true && balance(c100.id) === 8000 &&
    q1("SELECT paid FROM orders WHERE orderId = ?", o.orderId).paid === 1);
  const stripeBefore = stripeCalls.length;
  r = await pay(o.orderId, o.body.checkoutToken);
  ok("…so there is no card step: Checkout refuses it as already paid and Stripe is never asked", r.status === 409 && r.body.message === "This order is already paid." && stripeCalls.length === stripeBefore);
  r = await shop(MUG(2), { orderId: o.orderId, paymentMethod: "Card", giftCards: [{ code: c100.code }] });
  ok("the same order sent again answers as a repeat with owed 0 and paid, and spends nothing more",
    r.status === 200 && r.body.duplicate === true && r.body.owed === 0 && r.body.paid === true && balance(c100.id) === 8000 &&
    q1("SELECT count(*) AS n FROM order_payments WHERE orderId = ?", o.orderId).n === 1);

  const a5 = await card(5), b10 = await card(10), c50 = await card(50);
  o = await shop(MUG(2), { giftCards: [{ code: a5.code }, { code: b10.code }, { code: c50.code }] });
  ok("three cards are spent in the order given, each up to what is still owed: $5.00, $10.00, then $5.00 of the $50.00",
    o.status === 200 && o.body.giftCards.map(g => g.taken).join(",") === "5,10,5" && o.body.giftCards[2].balance === 45 && o.body.owed === 0 && o.body.paid === true);
  const n0 = orderCount();
  r = await shop(MUG(1), { giftCards: [{ code: a5.code }, { code: b10.code }, { code: c50.code }, { code: c100.code }] });
  const rNotList = await shop(MUG(1), { giftCards: { code: c50.code } });
  ok("a fourth card, or giftCards that isn't a list: 400 \"At most 3 gift cards can be used on an order.\" and no order is made",
    r.status === 400 && r.body.message === "At most 3 gift cards can be used on an order." && rNotList.status === 400 && rNotList.body.message === r.body.message && orderCount() === n0);
  const badShapes = await Promise.all([[null], [{}], [{ code: "" }], [{ code: 1234 }], [{ code: "A".repeat(65) }]].map(g => shop(MUG(1), { giftCards: g })));
  ok("an entry with no number, a blank one, one that isn't text or longer than 64 characters: 400 \"That gift card number isn't right.\"",
    badShapes.every(x => x.status === 400 && x.body.message === BAD) && orderCount() === n0);
  const badAmounts = await Promise.all([-1, "lots", 1000001].map(a => shop(MUG(1), { giftCards: [{ code: c50.code, amount: a }] })));
  ok("an amount below zero, not a number or over $1,000,000: 400 \"That gift card amount isn't valid.\"",
    badAmounts.every(x => x.status === 400 && x.body.message === "That gift card amount isn't valid.") && orderCount() === n0);
  o = await shop(MUG(2), { giftCards: [{ code: c50.code, amount: 7.5 }] });
  ok("an amount says how much of the card to use: $7.50 of it, and $12.50 still owed", o.status === 200 && o.body.giftCards[0].taken === 7.5 && o.body.owed === 12.5 && balance(c50.id) === 3750);
  o = await shop(MUG(2), { giftCards: [{ code: c50.code, amount: "" }, { code: c50.code.toLowerCase() }] });
  ok("the same card typed twice is spent once, and an empty amount means as much as it can",
    o.status === 200 && o.body.giftCards.length === 1 && o.body.giftCards[0].taken === 20 && balance(c50.id) === 1750);

  const live = await card(20);
  o = await shop(MUG(2), { giftCards: [{ code: unknown }, { code: voided.code }, { code: spent.code }, ].slice(0, 3) });
  ok("refused cards (a number nobody has, a voided card, an empty card) don't fail the order: it is placed and each is reported with its reason",
    o.status === 200 && o.body.giftCards.length === 3 && o.body.giftCards.every(g => g.ok === false && g.taken === 0) &&
    o.body.giftCards.map(g => g.reason).join("|") === [BAD, BAD, EMPTY].join("|") && o.body.owed === 20 && o.body.paid === false &&
    q1("SELECT count(*) AS n FROM order_payments WHERE orderId = ?", o.orderId).n === 0);
  ok("…and a refused card's answer never says whose it is or its balance", !o.body.giftCards.some(g => "balance" in g || "last4" in g));
  o = await shop(MUG(1), { giftCards: [{ code: live.code }, { code: c100.code }] });
  ok("a second card once the first has paid it all is reported as not used (\"Nothing is owed on this order.\") with its last four, and keeps its balance",
    o.status === 200 && o.body.giftCards[0].ok === true && o.body.giftCards[0].taken === 10 && o.body.giftCards[1].ok === false &&
    o.body.giftCards[1].reason === "Nothing is owed on this order." && o.body.giftCards[1].last4 === c100.last4 && balance(c100.id) === 8000);

  const save10 = await A.saveDiscountCode(d1, { code: "SAVE10", kind: "percent", percent: 10, maxUses: 100 }, { actor: "test" });
  await A.saveDiscountCode(d1, { code: "FIVE", kind: "amount", amount: 5, maxUses: 100 }, { actor: "test" });
  ok("the discount codes for the next checks are made, and the shop takes one code per order (the default)", !!(save10 && save10.code) && (await (async () => {
    const x = await H.post({ action: "checkDiscountCode", code: "FIVE", others: ["SAVE10"], items: MUG(3) }); return x.status === 400 && x.body.message === "Only one discount code can be used on an order."; })()));
  const c10 = await card(10);
  o = await shop(MUG(3), { discountCode: "SAVE10", giftCards: [{ code: c10.code }] });
  ok("one code and a gift card together in one-code mode: 10% off $30.00 is $27.00, the card pays $10.00 of it, $17.00 still owed",
    o.status === 200 && o.body.discount === 3 && o.body.discountCode === "SAVE10" && JSON.stringify(o.body.discountCodes) === '["SAVE10"]' &&
    o.body.total === 27 && o.body.giftCards[0].taken === 10 && o.body.owed === 17 && o.body.paid === false);
  r = await shop(MUG(3), { orderId: o.orderId, discountCode: "SAVE10", giftCards: [{ code: c10.code }] });
  ok("…sent again, the repeat answers the same code, total and $17.00 owed, and spends the card no more",
    r.status === 200 && r.body.duplicate === true && r.body.discountCode === "SAVE10" && r.body.total === 27 && r.body.owed === 17 && balance(c10.id) === 0 &&
    q1("SELECT count(*) AS n FROM order_payments WHERE orderId = ?", o.orderId).n === 1);
  const c10b = await card(10);
  const n1 = orderCount();
  r = await shop(MUG(3), { discountCodes: ["SAVE10", "FIVE"], giftCards: [{ code: c10b.code }] });
  ok("…a second code is still refused in one-code mode, and then the card isn't touched and no order is made",
    r.status === 400 && r.body.message === "Only one discount code can be used on an order." && balance(c10b.id) === 1000 && orderCount() === n1);

  await A.setSalesTaxSettings(d1, { rateBps: 600, jurisdiction: "OH", taxMode: "exclusive" });
  const c30 = await card(30);
  o = await shop(MUG(2), { giftCards: [{ code: c30.code }] });
  ok("with sales tax added on top, the card pays the tax too: $20.00 + $1.20 tax = $21.20 taken, paid",
    o.status === 200 && o.body.taxMode === "exclusive" && o.body.total === 21.2 && o.body.giftCards[0].taken === 21.2 && o.body.owed === 0 && o.body.paid === true && balance(c30.id) === 880);
  await A.setSalesTaxSettings(d1, { rateBps: 0, jurisdiction: "", taxMode: "inclusive" });

  const cOff = await card(10);
  globalThis.__f393 = { giftCards: false };
  r = await shop(MUG(1), { giftCards: [{ code: cOff.code }] });
  const rNoCards = await shop(MUG(1));
  globalThis.__f393 = {};
  ok("the Gift cards feature off: an order with a card is refused (400 \"Gift cards aren't available right now.\"), one without goes through",
    r.status === 400 && r.body.message === OFF && rNoCards.status === 200 && balance(cOff.id) === 1000);
  setShopPayments("acme", { ...ALL_ON, giftCard: false });
  r = await shop(MUG(1), { giftCards: [{ code: cOff.code }] });
  setShopPayments("acme", ALL_ON);
  setGlobalPayments({ ...ALL_ON, giftCard: false });
  const rGlobalOff = await shop(MUG(1), { giftCards: [{ code: cOff.code }] });
  setGlobalPayments({ ...ALL_ON, giftCard: true });
  ok("the Gift card payment method off for the shop, or for every shop: refused the same way, nothing spent",
    r.status === 400 && r.body.message === OFF && rGlobalOff.status === 400 && rGlobalOff.body.message === OFF && balance(cOff.id) === 1000);
  {
    const old = await newDb("0120");
    const Hold = harness(old);
    await Hold.admin({ action: "createProduct", productId: "mug", type: "other", name: "Club Mug", pricingMode: "flat", flatPrice: 10, visible: true, weightOz: 10, noDesignNeeded: true });
    r = await Hold.shop(MUG(1), { giftCards: [{ code: cOff.code }] });
    ok("a database a migration behind: the order is still placed and the card is reported as not right", r.status === 200 && r.body.giftCards[0].ok === false && r.body.giftCards[0].reason === BAD && r.body.owed === 10);
  }
  {
    const cThrow = await card(10);
    globalThis.__throw393 = "card";
    const x = await quietly(() => shop(MUG(1), { giftCards: [{ code: cThrow.code }] }));
    globalThis.__throw393 = "";
    ok("a card that fails while being spent is reported as \"That gift card can't be used right now.\" and the order still stands",
      x.v.status === 200 && x.v.body.giftCards[0].ok === false && x.v.body.giftCards[0].reason === "That gift card can't be used right now." && balance(cThrow.id) === 1000 &&
      x.logged.some(l => /Spending a gift card failed/.test(l)));
  }

  // =================================================================================================================
  console.log("\n=== buyGiftCard: a customer buys a gift card online ===");
  // =================================================================================================================
  const NOT_SOLD = "Gift cards aren't sold online right now.";
  const CARDS_OFF = "Gift cards are bought by card, and card payments aren't available right now.";
  r = await buy({});
  ok("selling online is off by default: 400 \"Gift cards aren't sold online right now.\"", r.status === 400 && r.body.message === NOT_SOLD);
  await A.setGiftCardSettings(d1, { sellOnline: true });
  globalThis.__f393 = { giftCards: false };
  r = await buy({});
  globalThis.__f393 = {};
  ok("selling on but the Gift cards feature off: refused the same way", r.status === 400 && r.body.message === NOT_SOLD);
  setGlobalPayments({ ...ALL_ON, giftCard: false });
  r = await buy({});
  setGlobalPayments(ALL_ON);
  ok("…and with the Gift card payment method off", r.status === 400 && r.body.message === NOT_SOLD);
  r = await harness(d1, { STRIPE_SECRET_KEY: "" }).buy({});
  ok("Stripe not set up: 400 \"Gift cards are bought by card, and card payments aren't available right now.\"", r.status === 400 && r.body.message === CARDS_OFF);
  setShopPayments("acme", { ...ALL_ON, card: false });
  r = await buy({});
  setShopPayments("acme", ALL_ON);
  setGlobalPayments({ ...ALL_ON, card: false });
  const rGlobalCardOff = await buy({});
  setGlobalPayments(ALL_ON);
  ok("…card payments off for this shop, or for every shop: refused the same way", r.status === 400 && r.body.message === CARDS_OFF && rGlobalCardOff.status === 400 && rGlobalCardOff.body.message === CARDS_OFF);
  globalThis.__f393 = { storefront: false };
  r = await buy({});
  globalThis.__f393 = {};
  ok("the Storefront switched off: 403, feature storefront", r.status === 403 && r.body.feature === "storefront");
  r = await buy({}, ADMIN_ORIGIN);
  const rRoot = await buy({ orgId: "acme" }, "https://" + ROOT);
  ok("not from the admin host (403 \"Not available here.\") nor the bare domain (403)", r.status === 403 && r.body.message === "Not available here." &&
    rRoot.status === 403 && rRoot.body.message === "Orders are placed from a shop's own page.");
  r = await buy({}, "http://localhost:8788");
  ok("on localhost (development) a request without a shop is \"Unknown org\"", r.status === 400 && r.body.message === "Unknown org");
  d1._raw.exec("UPDATE orgs SET ready = 0 WHERE orgId = 'beta'");
  r = await buy({}, shopOrigin("beta"));
  d1._raw.exec("UPDATE orgs SET ready = 1 WHERE orgId = 'beta'");
  ok("a shop that isn't open for orders: 403", r.status === 403 && r.body.message === "This shop is not currently accepting orders.");
  globalThis.__rl393 = [];
  globalThis.__rlBlock393 = "order_submit";
  r = await buy({});
  globalThis.__rlBlock393 = "";
  ok("it shares the order bucket (order_submit, 20 a minute): blocked, the rate limiter's 429", r.status === 429 && globalThis.__rl393.join(" ") === "order_submit/20");
  globalThis.__bot393 = true;
  r = await buy({});
  globalThis.__bot393 = false;
  ok("a failed robot check: 403 with its message", r.status === 403 && r.body.message === "Please confirm you are not a robot.");

  const pick = "Pick an amount from $5 to $500.";
  const amountRefusals = await Promise.all([400, 60000, 2550.5, "lots", null].map(a => buy({ amountCents: a })));
  ok("an amount below the $5 minimum, above the $500 maximum, not whole cents or not a number: 400 \"Pick an amount from $5 to $500.\"",
    amountRefusals.every(x => x.status === 400 && x.body.message === pick));
  await A.setGiftCardSettings(d1, { amounts: [2500, 100000], minCents: 500, maxCents: 50000 });
  const rButton = await buy({ amountCents: 100000 }), rCustom = await buy({ amountCents: 1234 });
  ok("one of the amount buttons is taken even above the maximum ($1,000), and any amount within the range ($12.34)",
    rButton.status === 200 && rButton.body.total === 1000 && rCustom.status === 200 && rCustom.body.total === 12.34);
  await A.setGiftCardSettings(d1, { amounts: [2500, 5000, 10000], minCents: 2000, maxCents: 25000 });
  r = await buy({ amountCents: 1000 });
  ok("…the sentence follows the settings (\"Pick an amount from $20 to $250.\")", r.status === 400 && r.body.message === "Pick an amount from $20 to $250.");
  await A.setGiftCardSettings(d1, { minCents: 500, maxCents: 50000 });
  const people = await Promise.all([{ recipientName: "  " }, { recipientEmail: "sam" }, { buyerName: "" }, { buyerEmail: "pat@example" }].map(b => buy(b)));
  ok("who it's for, their email, your name and your email are each needed, with their own sentence",
    people.map(x => x.status + " " + x.body.message).join(" | ") ===
      ["400 Enter who the gift card is for.", "400 Enter the email address to send the gift card to.", "400 Enter your name.", "400 Enter your email address."].join(" | "));

  mail.length = 0;
  const n2 = orderCount();
  const bought = await buy({ requestId: "GC-K7Q2M9-ABC12", recipientName: "  Sam   Example ", message: "x".repeat(400) });
  ok("a good request answers the order, its shop, a checkout token, the total in dollars, giftCard true and emailOn",
    bought.status === 200 && bought.body.status === "ok" && bought.body.orderId === "ACME-GC-GCK7Q2M9ABC12" && bought.body.orgId === "acme" &&
    /^\d+\.[a-f0-9]{64}$/.test(bought.body.checkoutToken) && bought.body.total === 50 && bought.body.giftCard === true && bought.body.emailOn === true && orderCount() === n2 + 1);
  const gOrder = q1("SELECT * FROM orders WHERE orderId = ?", bought.body.orderId);
  ok("the order is the buyer's: their name and email, paid by Card, Digital delivery, $50.00, not paid yet",
    gOrder.orgId === "acme" && gOrder.customerName === "Pat Example" && gOrder.contact === "pat@example.com" && gOrder.paymentMethod === "Card" &&
    gOrder.shippingMethod === "Digital delivery" && gOrder.totalCents === 5000 && gOrder.paid === 0);
  const gLines = q("SELECT * FROM order_items WHERE orderId = ?", bought.body.orderId);
  ok("…with one line: productId __giftcard__, \"Gift card for Sam Example\", type giftcard, qty 1 at $50.00, never taxed",
    gLines.length === 1 && gLines[0].productId === "__giftcard__" && gLines[0].name === "Gift card for Sam Example" && gLines[0].type === "giftcard" &&
    gLines[0].qty === 1 && gLines[0].unitPriceCents === 5000 && gLines[0].lineTotalCents === 5000 && gLines[0].taxable === 0 && gLines[0].taxCents === 0);
  const gCfg = JSON.parse(gLines[0].configJson || "{}");
  ok("…and the gift kept in the line's configJson: who it's for, their email and the message (cut to 300 characters)",
    gCfg.giftCard && gCfg.giftCard.recipientName === "Sam Example" && gCfg.giftCard.recipientEmail === "sam@example.com" && gCfg.giftCard.message === "x".repeat(300));
  ok("no gift card exists yet: it is made only once the payment is in", q1("SELECT count(*) AS n FROM gift_cards WHERE sourceOrderId = ?", bought.body.orderId).n === 0);
  ok("the buyer gets the order-received email, and nothing goes to the recipient yet",
    mail.some(m => m.to === "pat@example.com") && !mail.some(m => m.to === "sam@example.com"));
  r = await buy({ requestId: "GC-K7Q2M9-ABC12" });
  ok("the same requestId again (a double click) answers the same order as a repeat, and makes no second one",
    r.status === 200 && r.body.duplicate === true && r.body.orderId === bought.body.orderId && orderCount() === n2 + 1);
  r = await buy({ requestId: "GC-K7Q2M9-ABC12", buyerEmail: "alex@example.com" });
  ok("…from someone else: 409 \"This order has already been received.\"", r.status === 409 && r.body.message === "This order has already been received.");
  {
    const n3 = orderCount();
    const [x, y] = await Promise.all([buy({ requestId: "GC-TWOCLICKS-01" }), buy({ requestId: "GC-TWOCLICKS-01" })]);
    ok("two clicks at once with one requestId: both answer the same order, and only one is made",
      x.status === 200 && y.status === 200 && x.body.orderId === y.body.orderId && (x.body.duplicate === true || y.body.duplicate === true) && orderCount() === n3 + 1);
  }
  const rA = await buy({}), rB = await buy({ requestId: "short" });
  ok("without a usable requestId each request is its own order", rA.status === 200 && rB.status === 200 && /^ACME-GC-[A-Z0-9]+$/.test(rA.body.orderId) && rA.body.orderId !== rB.body.orderId);
  r = await buy({ orgId: "beta" }, "http://localhost:8788");
  ok("on localhost the request's shop is used (Sample League)", r.status === 200 && r.body.orgId === "beta" && /^BETA-GC-/.test(r.body.orderId));
  await A.setSalesTaxSettings(d1, { rateBps: 600, jurisdiction: "OH", taxMode: "exclusive" });
  r = await buy({ amountCents: 2500 });
  const taxed = q1("SELECT o.totalCents, (SELECT COALESCE(SUM(i.taxCents), 0) FROM order_items i WHERE i.orderId = o.orderId) AS salesTaxCents FROM orders o WHERE o.orderId = ?", r.body.orderId);
  await A.setSalesTaxSettings(d1, { rateBps: 0, jurisdiction: "", taxMode: "inclusive" });
  ok("with sales tax added on top, a gift card is still its face value: $25.00 and no tax", r.status === 200 && r.body.total === 25 && taxed.totalCents === 2500 && taxed.salesTaxCents === 0);

  // =================================================================================================================
  console.log("\n=== Paying for it: Checkout, then the Stripe webhook makes the card ===");
  // =================================================================================================================
  stripeCalls.length = 0;
  r = await pay(bought.body.orderId, bought.body.checkoutToken);
  const page = stripeCalls[0] || {};
  ok("Checkout starts a Stripe page for it like any card order: $50.00 for this order",
    r.status === 200 && /^https:\/\/checkout\.stripe\.test\//.test(r.body.url) && page["line_items[0][price_data][unit_amount]"] === "5000" &&
    page["metadata[orderId]"] === bought.body.orderId && page["metadata[orgId]"] === "acme");
  ok("…named a gift card, and the thank-you page is told it was one (&giftcard=1)",
    page["line_items[0][price_data][product_data][name]"] === "Gift card — acme" && /^Gift card, order ACME-GC-GCK7Q2M9ABC12 for Pat Example/.test(page["line_items[0][price_data][product_data][description]"]) &&
    /[?&]giftcard=1$/.test(page.success_url));
  {
    const plain = await shop(MUG(1));
    stripeCalls.length = 0;
    await pay(plain.orderId, plain.body.checkoutToken);
    ok("…while an ordinary order's page is an \"Order\" with no giftcard mark", stripeCalls[0]["line_items[0][price_data][product_data][name]"] === "Order — acme" && !/giftcard/.test(stripeCalls[0].success_url));
  }
  const paidEvent = (id, orderId, cents, pi = "pi_" + id) => ({ id, type: "checkout.session.completed", created: Math.floor(Date.now() / 1000),
    data: { object: { id: "cs_" + id, payment_intent: pi, payment_status: "paid", amount_total: cents, metadata: { orderId, orgId: "acme" } } } });
  mail.length = 0;
  r = await hook(paidEvent("evt_gc1", bought.body.orderId, 5000));
  const made = q("SELECT * FROM gift_cards WHERE sourceOrderId = ?", bought.body.orderId);
  ok("the payment is in: the webhook answers 200, the order is paid and one card is made for it (sourceOrderId)",
    r.status === 200 && q1("SELECT paid FROM orders WHERE orderId = ?", bought.body.orderId).paid === 1 && made.length === 1);
  const gc = made[0] || {};
  ok("…$50.00 on it, for Sam Example at sam@example.com, from Pat Example, with the message, made by stripe",
    gc.initialCents === 5000 && gc.balanceCents === 5000 && gc.recipientName === "Sam Example" && gc.recipientEmail === "sam@example.com" &&
    gc.buyerName === "Pat Example" && gc.buyerEmail === "pat@example.com" && gc.message === "x".repeat(300) && gc.status === "active" && gc.createdBy === "stripe" &&
    /^[A-HJ-NP-Z2-9]{16}$/.test(gc.code) && gc.last4 === gc.code.slice(-4));
  ok("…its ledger starts with one 'issue' row \"Sold online\" for that order",
    JSON.stringify(q("SELECT kind, deltaCents, orderId, note FROM gift_card_ledger WHERE cardId = ?", gc.id)) === JSON.stringify([{ kind: "issue", deltaCents: 5000, orderId: bought.body.orderId, note: "Sold online" }]));
  const toSam = mail.filter(m => m.to === "sam@example.com"), toPat = mail.filter(m => m.to === "pat@example.com");
  const number = String(gc.code || "").replace(/(.{4})(?=.)/g, "$1-");
  ok("the recipient gets \"You've got a gift card from Pat Example\" with the amount, the number grouped, the message, and that it never expires",
    toSam.length === 1 && toSam[0].subject === "You've got a gift card from Pat Example" && toSam[0].body.includes("$50.00") && toSam[0].body.includes(number) &&
    toSam[0].htmlBody.includes(number) && toSam[0].body.includes("x".repeat(300)) && /never expires/.test(toSam[0].body) && /Example Embroidery/.test(toSam[0].body));
  ok("the buyer gets \"Your gift card was sent\" naming who it went to, and never the number",
    toPat.some(m => m.subject === "Your gift card was sent" && /emailed to Sam Example \(sam@example\.com\)/.test(m.body)) && !toPat.some(m => m.body.includes(gc.code) || m.body.includes(number)));
  ok("the owner's morning roll-up gets a gift_card notice: \"Gift card $50.00 for Sam Example — order " + bought.body.orderId + "\"",
    JSON.stringify(q("SELECT kind, orgId, summary FROM owner_notices WHERE orderId = ? AND kind = 'gift_card'", bought.body.orderId)) ===
      JSON.stringify([{ kind: "gift_card", orgId: "acme", summary: "Gift card $50.00 for Sam Example — order " + bought.body.orderId }]));
  mail.length = 0;
  r = await hook(paidEvent("evt_gc1", bought.body.orderId, 5000));
  ok("the same event delivered again: answered as a duplicate, no second card, nothing sent", r.status === 200 && r.body.duplicate === true &&
    q1("SELECT count(*) AS n FROM gift_cards WHERE sourceOrderId = ?", bought.body.orderId).n === 1 && mail.length === 0);
  r = (await quietly(() => hook(paidEvent("evt_gc1b", bought.body.orderId, 5000, "pi_evt_gc1")))).v;
  ok("a different event for the same payment (a replay after the event log was lost): no second card, no email, no second notice",
    r.status === 200 && q1("SELECT count(*) AS n FROM gift_cards WHERE sourceOrderId = ?", bought.body.orderId).n === 1 && mail.length === 0 &&
    q1("SELECT count(*) AS n FROM owner_notices WHERE orderId = ? AND kind = 'gift_card'", bought.body.orderId).n === 1 &&
    q1("SELECT count(*) AS n FROM order_payments WHERE orderId = ?", bought.body.orderId).n === 1);
  {
    const plain = await shop(MUG(2), { paymentMethod: "Card" });
    const before = q1("SELECT count(*) AS n FROM gift_cards").n;
    r = await hook(paidEvent("evt_plain", plain.orderId, 2000));
    ok("an ordinary order paid by card makes no gift card", r.status === 200 && q1("SELECT paid FROM orders WHERE orderId = ?", plain.orderId).paid === 1 && q1("SELECT count(*) AS n FROM gift_cards").n === before);
  }
  {
    const short = await buy({ requestId: "GC-SHORTPAY-0001", amountCents: 2500 });
    r = (await quietly(() => hook(paidEvent("evt_short1", short.body.orderId, 1000)))).v;
    ok("a payment short of the price leaves the order unpaid and makes no card yet", r.status === 200 && q1("SELECT count(*) AS n FROM gift_cards WHERE sourceOrderId = ?", short.body.orderId).n === 0);
    mail.length = 0;
    r = await hook(paidEvent("evt_short2", short.body.orderId, 1500));
    ok("…the rest paid later: then the $25.00 card is made and emailed", r.status === 200 &&
      q1("SELECT initialCents FROM gift_cards WHERE sourceOrderId = ?", short.body.orderId).initialCents === 2500 && mail.some(m => m.to === "sam@example.com"));
  }
  {
    const gone = await buy({ requestId: "GC-VOIDED-00001" });
    await A.voidOrder(d1, gone.body.orderId, "customer changed their mind (test)");
    mail.length = 0;
    r = await quietly(() => hook(paidEvent("evt_void", gone.body.orderId, 5000)));
    ok("a payment for a gift card order that was voided makes no card and emails no recipient",
      r.v.status === 200 && q1("SELECT count(*) AS n FROM gift_cards WHERE sourceOrderId = ?", gone.body.orderId).n === 0 && !mail.some(m => m.to === "sam@example.com"));
  }
  {
    const broken = await buy({ requestId: "GC-BROKEN-00001" });
    d1.q("UPDATE order_items SET configJson = ? WHERE orderId = ?", JSON.stringify({ giftCard: { recipientName: "Sam Example", recipientEmail: "not an email" } }), broken.body.orderId);
    mail.length = 0;
    r = await quietly(() => hook(paidEvent("evt_broken", broken.body.orderId, 5000)));
    ok("a card that can't be made: 500 so Stripe retries, recorded as webhook_failed, no card and no email",
      r.v.status === 500 && q1("SELECT count(*) AS n FROM gift_cards WHERE sourceOrderId = ?", broken.body.orderId).n === 0 && mail.length === 0 &&
      q("SELECT sample FROM system_issues WHERE kind = 'webhook_failed'").some(x => x.sample.includes(broken.body.orderId)));
    d1.q("UPDATE order_items SET configJson = ? WHERE orderId = ?", JSON.stringify({ giftCard: { recipientName: "Sam Example", recipientEmail: "sam@example.com" } }), broken.body.orderId);
    r = (await quietly(() => hook(paidEvent("evt_broken", broken.body.orderId, 5000)))).v;
    ok("…Stripe's retry heals it: the payment isn't booked twice, and the card is made and emailed",
      r.status === 200 && q1("SELECT count(*) AS n FROM order_payments WHERE orderId = ?", broken.body.orderId).n === 1 &&
      q1("SELECT count(*) AS n FROM gift_cards WHERE sourceOrderId = ?", broken.body.orderId).n === 1 && mail.filter(m => m.to === "sam@example.com").length === 1);
  }
  {
    const noMail = await buy({ requestId: "GC-MAILDOWN-0001" });
    globalThis.__mailDown393 = true;
    r = await quietly(() => hook(paidEvent("evt_maildown", noMail.body.orderId, 5000)));
    globalThis.__mailDown393 = false;
    ok("the recipient's email failing: the card still stands, the payment is in (200) and gift_card_email_failed is recorded for the morning",
      r.v.status === 200 && q1("SELECT count(*) AS n FROM gift_cards WHERE sourceOrderId = ?", noMail.body.orderId).n === 1 &&
      q("SELECT sample FROM system_issues WHERE kind = 'gift_card_email_failed'").some(x => x.sample.includes(noMail.body.orderId) && /Resend/.test(x.sample)) &&
      q1("SELECT count(*) AS n FROM owner_notices WHERE orderId = ? AND kind = 'gift_card'", noMail.body.orderId).n === 1);
  }
  {
    const old = await newDb("0120");
    const Hold = harness(old);
    await Hold.admin({ action: "createProduct", productId: "mug", type: "other", name: "Club Mug", pricingMode: "flat", flatPrice: 10, visible: true, weightOz: 10, noDesignNeeded: true });
    const plain = await Hold.shop(MUG(1), { paymentMethod: "Card" });
    r = await Hold.hook(paidEvent("evt_old", plain.orderId, 1000));
    ok("a database a migration behind: an ordinary card payment is still recorded (200, paid)", r.status === 200 && old.q("SELECT paid FROM orders WHERE orderId = ?", plain.orderId)[0].paid === 1);
  }

  // =================================================================================================================
  console.log("\n=== The invoice page: a code and a gift card before paying ===");
  // =================================================================================================================
  const invoiceFor = async (qty = 3, extra = {}) => {
    const x = await shop(MUG(qty), { paymentMethod: "Check", ...extra });
    const s = await admin({ action: "sendInvoice", orderId: x.orderId });
    if (s.status !== 200) throw new Error("sendInvoice " + JSON.stringify(s));
    return { orderId: x.orderId, token: (await A.getOrderInvoiceByOrder(d1, x.orderId)).token };
  };
  let I = await invoiceFor();
  r = await invGet(I.token);
  ok("an invoice that owes shows what can be added (a code: a usable one exists; a gift card; one code at a time) and no codes or card payments yet",
    r.status === 200 && JSON.stringify(r.body.invoice.addOns) === JSON.stringify({ code: true, giftCard: true, multiple: false }) &&
    JSON.stringify(r.body.invoice.discountCodes) === "[]" && JSON.stringify(r.body.invoice.giftCardPaid) === "[]" && r.body.invoice.shippingDiscount === 0);
  globalThis.__rl393 = [];
  r = await inv({ token: I.token, action: "applyCode", code: " save10 " });
  ok("a code typed on it: the fresh invoice with 10% off $30.00 ($3.00), the code listed, $27.00 due",
    r.status === 200 && r.body.status === "ok" && r.body.invoice.discount === 3 && JSON.stringify(r.body.invoice.discountCodes) === '["SAVE10"]' &&
    r.body.invoice.discountNote === "Code SAVE10" && r.body.invoice.balanceDue === 27 && r.body.invoice.total === 27);
  ok("…counted in its own rate-limit bucket, invoice_code at 10, after the page's own", globalThis.__rl393.join(" ") === "invoice/30 invoice_code/10");
  ok("…the code's use is booked for this order and the change is audited as order.invoice_code_applied by customer-invoice",
    q1("SELECT count(*) AS n FROM discount_code_uses WHERE orderId = ? AND releasedAt IS NULL", I.orderId).n === 1 &&
    JSON.stringify(q("SELECT detail, actor, ip FROM audit_log WHERE orderId = ? AND action = 'order.invoice_code_applied'", I.orderId)) ===
      JSON.stringify([{ detail: '{"code":"SAVE10"}', actor: "customer-invoice", ip: "203.0.113.7" }]));
  ok("…and with one code on it (one-code mode) the box is gone", r.body.invoice.addOns.code === false && r.body.invoice.addOns.giftCard === true);
  r = await inv({ token: I.token, action: "applyCode", code: "FIVE" });
  ok("a second code then: 409 \"A discount code can't be added to this order now.\"", r.status === 409 && r.body.message === "A discount code can't be added to this order now.");
  const g12 = await card(12);
  globalThis.__rl393 = [];
  r = await inv({ token: I.token, action: "applyGiftCard", code: g12.code.toLowerCase().replace(/(.{4})(?=.)/g, "$1 ") });
  ok("a gift card typed on it (any case, with spaces) pays $12.00 of the $27.00: listed as \"Gift card ••" + g12.last4 + "\", $15.00 still due",
    r.status === 200 && JSON.stringify(r.body.invoice.giftCardPaid) === JSON.stringify([{ label: "Gift card ••" + g12.last4, amount: 12 }]) &&
    r.body.invoice.balanceDue === 15 && r.body.invoice.paid === false && balance(g12.id) === 0);
  ok("…counted in its own bucket, invoice_giftcard at 10", globalThis.__rl393.join(" ") === "invoice/30 invoice_giftcard/10");
  ok("…audited as order.invoice_gift_card_used with only the last four and the cents taken",
    JSON.stringify(q("SELECT detail, actor FROM audit_log WHERE orderId = ? AND action = 'order.invoice_gift_card_used'", I.orderId)) ===
      JSON.stringify([{ detail: JSON.stringify({ card: "••" + g12.last4, takenCents: 1200 }), actor: "customer-invoice" }]) &&
    !q("SELECT detail FROM audit_log WHERE orderId = ?", I.orderId).some(x => x.detail.includes(g12.code)));
  const g50 = await card(50);
  const other = await invoiceFor(1);
  r = await inv({ token: I.token, action: "applyGiftCard", code: g50.code, orderId: other.orderId });
  ok("a $50.00 card takes only the $15.00 still due on THIS invoice's order (an orderId in the request is ignored), and it is paid",
    r.status === 200 && r.body.invoice.orderId === I.orderId && r.body.invoice.balanceDue === 0 && r.body.invoice.paid === true && balance(g50.id) === 3500 &&
    q1("SELECT count(*) AS n FROM order_payments WHERE orderId = ?", other.orderId).n === 0);
  ok("…paid, nothing more can be added", JSON.stringify(r.body.invoice.addOns) === JSON.stringify({ code: false, giftCard: false, multiple: false }));
  const rPaidCard = await inv({ token: I.token, action: "applyGiftCard", code: g50.code });
  ok("…a gift card on a paid invoice: 409 \"A gift card can't be used on this order now.\" and the card keeps its balance",
    rPaidCard.status === 409 && rPaidCard.body.message === "A gift card can't be used on this order now." && balance(g50.id) === 3500);

  I = await invoiceFor(1);
  const cardRefusals = await Promise.all(["", "   ", 1234, "ABCD-EFGH"].map(c => inv({ token: I.token, action: "applyGiftCard", code: c })));
  ok("no gift card number: 400 \"Enter your gift card number.\"; one that isn't 16 characters: 400 \"That gift card number isn't right.\"",
    cardRefusals.map(x => x.status + " " + x.body.message).join(" | ") ===
      ["400 Enter your gift card number.", "400 Enter your gift card number.", "400 Enter your gift card number.", "400 " + BAD].join(" | "));
  const rU = await inv({ token: I.token, action: "applyGiftCard", code: unknown }), rV = await inv({ token: I.token, action: "applyGiftCard", code: voided.code });
  const rE = await inv({ token: I.token, action: "applyGiftCard", code: spent.code });
  ok("a number nobody has and a voided card: the same 400 \"That gift card number isn't right.\"; an empty card: \"This gift card has no balance left.\"",
    rU.status === 400 && rU.body.message === BAD && rV.status === 400 && rV.body.message === BAD && rE.status === 400 && rE.body.message === EMPTY);
  const gOff = await card(5);
  await A.setFeatures(d1, { giftCards: false });
  const rFeatOff = await inv({ token: I.token, action: "applyGiftCard", code: gOff.code });
  const vOff = (await invGet(I.token)).body.invoice.addOns.giftCard;
  await A.setFeatures(d1, { giftCards: true });
  setGlobalPayments({ ...ALL_ON, giftCard: false });
  const rMethodOff = await inv({ token: I.token, action: "applyGiftCard", code: gOff.code });
  setGlobalPayments(ALL_ON);
  setShopPayments("acme", { ...ALL_ON, giftCard: false });
  const rShopOff = await inv({ token: I.token, action: "applyGiftCard", code: gOff.code });
  setShopPayments("acme", ALL_ON);
  ok("the Gift cards feature off, the method off for every shop or for this shop: 409 and the box isn't offered",
    [rFeatOff, rMethodOff, rShopOff].every(x => x.status === 409 && x.body.message === "A gift card can't be used on this order now.") && vOff === false && balance(gOff.id) === 500);
  const today = await A.localToday(ENV);
  d1.q("INSERT INTO closed_periods (month, closedAt, closedBy) VALUES (?, 't', 'test')", today.slice(0, 7));
  r = await inv({ token: I.token, action: "applyGiftCard", code: gOff.code });
  d1.q("DELETE FROM closed_periods");
  ok("this month closed in the books: 409 \"This order can no longer be changed online — contact us.\"", r.status === 409 && r.body.message === "This order can no longer be changed online — contact us." && balance(gOff.id) === 500);
  globalThis.__throw393 = "card";
  const rThrowCard = await quietly(() => inv({ token: I.token, action: "applyGiftCard", code: gOff.code }));
  globalThis.__throw393 = "code";
  const rThrowCode = await quietly(() => inv({ token: I.token, action: "applyCode", code: "SAVE10" }));
  globalThis.__throw393 = "";
  ok("a failure while spending the card or checking the code: 500 with a sentence to try again, logged",
    rThrowCard.v.status === 500 && rThrowCard.v.body.message === "We couldn't use that gift card just now. Please try again." &&
    rThrowCode.v.status === 500 && rThrowCode.v.body.message === "We couldn't check that code just now. Please try again." &&
    rThrowCard.logged.some(l => /gift card on an invoice failed/.test(l)) && rThrowCode.logged.some(l => /discount code on an invoice failed/.test(l)));
  globalThis.__rlBlock393 = "invoice_giftcard";
  const rRlCard = await inv({ token: I.token, action: "applyGiftCard", code: gOff.code });
  globalThis.__rlBlock393 = "invoice_code";
  const rRlCode = await inv({ token: I.token, action: "applyCode", code: "SAVE10" });
  globalThis.__rlBlock393 = "";
  ok("too many tries from one address: 429 for cards and for codes, each in its own bucket, nothing applied",
    rRlCard.status === 429 && rRlCode.status === 429 && balance(gOff.id) === 500 && q1("SELECT count(*) AS n FROM discount_code_uses WHERE orderId = ?", I.orderId).n === 0);

  const codeRefusals = await Promise.all(["", "  ", 42, "A".repeat(65)].map(c => inv({ token: I.token, action: "applyCode", code: c })));
  ok("no code: 400 \"Enter a discount code.\"; longer than 64 characters: 400 \"This code isn't valid.\"",
    codeRefusals.map(x => x.status + " " + x.body.message).join(" | ") ===
      ["400 Enter a discount code.", "400 Enter a discount code.", "400 Enter a discount code.", "400 This code isn't valid."].join(" | "));
  await A.saveDiscountCode(d1, { code: "BIG50", kind: "amount", amount: 5, minOrder: 50, maxUses: 100 }, { actor: "test" });
  const rNope = await inv({ token: I.token, action: "applyCode", code: "NOPE" }), rMin = await inv({ token: I.token, action: "applyCode", code: "BIG50" });
  ok("a code the shop doesn't have, or one needing a bigger order: 400 with the code check's own sentence",
    rNope.status === 400 && rNope.body.message === "This code isn't valid. If it was sent to you, check the email address is the one it was sent to." && rMin.status === 400 && rMin.body.message === "This code needs an order of at least $50.00.");
  await A.setFeatures(d1, { discounts: false });
  r = await inv({ token: I.token, action: "applyCode", code: "SAVE10" });
  const vNoDisc = (await invGet(I.token)).body.invoice.addOns.code;
  await A.setFeatures(d1, { discounts: true });
  ok("the Discount codes feature off: 409 and no code box", r.status === 409 && r.body.message === "A discount code can't be added to this order now." && vNoDisc === false);
  d1.q("UPDATE orders SET placedAt = '2020-01-15T12:00:00.000Z' WHERE orderId = ?", I.orderId);
  d1.q("INSERT INTO closed_periods (month, closedAt, closedBy) VALUES ('2020-01', 't', 'test')");
  r = await inv({ token: I.token, action: "applyCode", code: "SAVE10" });
  const rCardOldMonth = await inv({ token: I.token, action: "applyGiftCard", code: gOff.code });
  d1.q("DELETE FROM closed_periods");
  ok("a code on an order whose month is closed: 409; a gift card is a payment today, so it still works", r.status === 409 && r.body.message === "This order can no longer be changed online — contact us." &&
    rCardOldMonth.status === 200 && rCardOldMonth.body.invoice.giftCardPaid.length === 1 && balance(gOff.id) === 0);

  I = await invoiceFor(2);
  r = await admin({ action: "setDiscount", orderId: I.orderId, amount: 2, note: "Club friend" });
  const vManual = (await invGet(I.token)).body.invoice.addOns;
  const rManual = await inv({ token: I.token, action: "applyCode", code: "SAVE10" });
  ok("an order the shop gave a discount by hand: no code box, and a code is refused (409); a gift card is still offered",
    r.status === 200 && vManual.code === false && vManual.giftCard === true && rManual.status === 409);
  d1.q("UPDATE discount_codes SET active = 0");
  I = await invoiceFor(2);
  const vNoCodes = (await invGet(I.token)).body.invoice.addOns;
  r = await inv({ token: I.token, action: "applyCode", code: "SAVE10" });
  d1.q("UPDATE discount_codes SET active = 1");
  ok("no code that could work at the shop: no code box and 409", vNoCodes.code === false && r.status === 409);
  await A.setDiscountRules(d1, { multiple: true });
  I = await invoiceFor(3);
  await inv({ token: I.token, action: "applyCode", code: "SAVE10" });
  r = await inv({ token: I.token, action: "applyCode", code: "FIVE" });
  ok("when Global settings allows more than one code: the box stays (multiple true) and a second code works: 10% then $5.00 off $30.00 = $22.00",
    r.status === 200 && JSON.stringify(r.body.invoice.discountCodes) === '["SAVE10","FIVE"]' && r.body.invoice.discount === 8 && r.body.invoice.balanceDue === 22 &&
    r.body.invoice.discountNote === "Codes SAVE10, FIVE" && r.body.invoice.addOns.multiple === true && r.body.invoice.addOns.code === true);
  r = await inv({ token: I.token, action: "applyCode", code: "save10" });
  ok("…the same code twice: 400 \"That code is already applied.\"", r.status === 400 && r.body.message === "That code is already applied.");
  await A.setDiscountRules(d1, { multiple: false });
  r = await inv({ token: "0".repeat(32), action: "applyGiftCard", code: g50.code });
  const rBadTok = await inv({ token: "not a token", action: "applyCode", code: "SAVE10" });
  ok("a token nobody has: 404 \"This invoice link isn't valid.\", and nothing is spent", r.status === 404 && r.body.message === "This invoice link isn't valid." && rBadTok.status === 404 && balance(g50.id) === 3500);
  I = await invoiceFor(1);
  await A.voidOrder(d1, I.orderId, "test");
  r = await inv({ token: I.token, action: "applyGiftCard", code: g50.code });
  ok("a voided order's invoice: 410 and nothing is spent", r.status === 410 && balance(g50.id) === 3500);

  {
    const P = await invoiceFor(1);
    const gp = await card(40);
    const [x1, x2] = await Promise.all([inv({ token: P.token, action: "applyGiftCard", code: gp.code }), inv({ token: P.token, action: "applyGiftCard", code: gp.code })]);
    ok("the same card sent twice at once (a double click) pays once: $10.00 taken, one payment, the other told to try again",
      [x1, x2].filter(x => x.status === 200).length === 1 && [x1, x2].some(x => x.status === 400 && x.body.message === "That order just changed. Try again.") && balance(gp.id) === 3000 && q1("SELECT count(*) AS n FROM order_payments WHERE orderId = ?", P.orderId).n === 1);
    const pid = q1("SELECT id FROM order_payments WHERE orderId = ? AND giftCardId IS NOT NULL", P.orderId).id;
    const v = await admin({ action: "voidPayment", orderId: P.orderId, paymentId: pid, reason: "Typed on the wrong order (test)" });
    ok("staff void that payment: the $10.00 goes back on the card and the invoice owes $10.00 again", v.status === 200 && balance(gp.id) === 4000 && v.body.balanceDue === 10);
    const x3 = await inv({ token: P.token, action: "applyGiftCard", code: gp.code });
    ok("the customer types the same card again: it really pays this time ($10.00 taken, nothing still due), not a \"done already\" that pays nothing",
      x3.status === 200 && x3.body.invoice.balanceDue === 0 && x3.body.invoice.paid === true && balance(gp.id) === 3000 &&
      q1("SELECT count(*) AS n FROM order_payments WHERE orderId = ? AND voidedAt IS NULL", P.orderId).n === 1);
  }
  // =================================================================================================================
  console.log("\n=== The catalog: the rules the checkout needs ===");
  // =================================================================================================================
  await C.setGiftCardSettings(d1, { sellOnline: false, amounts: [2500, 5000, 10000], minCents: 500, maxCents: 50000 });
  await C.setDiscountRules(d1, { multiple: false });
  await C.setFeatures(d1, { giftCards: true, discounts: true });
  await C.publishShop(d1, "acme");
  const cat = async ({ env = { STRIPE_SECRET_KEY: "sk_test_example" }, db = d1, fresh = true } = {}) => {
    if (fresh) freshCacheApi();
    const res = await C.catalogGet({ request: { url: shopOrigin("acme") + "/api/catalog", headers: { get: () => null } }, env: { DB: db, ...env } });
    const b = JSON.parse(await res.text());
    return b.catalog || {};
  };
  let k = await cat();
  ok("by default: one code at a time, gift cards can be spent here, none sold online (no amounts), the $5 to $500 limits in dollars",
    JSON.stringify(k.discountRules) === '{"multiple":false}' && k.giftCardPay === true &&
    JSON.stringify(k.giftCards) === JSON.stringify({ sellOnline: false, amounts: [], min: 5, max: 500 }));
  await C.setGiftCardSettings(d1, { sellOnline: true, amounts: [2500, 7550], minCents: 1000, maxCents: 20000 });
  await C.setDiscountRules(d1, { multiple: true });
  k = await cat({ fresh: false });
  ok("selling on and more than one code allowed: shown at once, without a Publish, amounts and limits in dollars",
    JSON.stringify(k.discountRules) === '{"multiple":true}' && JSON.stringify(k.giftCards) === JSON.stringify({ sellOnline: true, amounts: [25, 75.5], min: 10, max: 200 }));
  k = await cat({ env: {} });
  ok("…but not sold online where the shop can't take cards (no Stripe): sellOnline false and no amounts, while cards can still be spent",
    k.giftCards.sellOnline === false && JSON.stringify(k.giftCards.amounts) === "[]" && k.giftCardPay === true);
  await C.setFeatures(d1, { giftCards: false });
  k = await cat();
  ok("the Gift cards feature off: not spendable and not sold", k.giftCardPay === false && k.giftCards.sellOnline === false && k.discountRules.multiple === true);
  await C.setFeatures(d1, { giftCards: true, discounts: false });
  k = await cat();
  ok("the Discount codes feature off: never more than one code", k.discountRules.multiple === false && k.giftCardPay === true);
  await C.setFeatures(d1, { discounts: true });
  setGlobalPayments({ ...ALL_ON, giftCard: false });
  k = await cat();
  setGlobalPayments(ALL_ON);
  ok("the Gift card payment method off for every shop: not spendable at checkout", k.giftCardPay === false);
  setShopPayments("acme", { ...ALL_ON, giftCard: false });
  await C.publishShop(d1, "acme");
  k = await cat();
  setShopPayments("acme", ALL_ON);
  await C.publishShop(d1, "acme");
  ok("…or for this shop", k.giftCardPay === false);
  d1.q("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('giftCards', ?)", JSON.stringify({ sellOnline: true, amounts: "lots", minCents: 50, maxCents: 10 }));
  k = await cat();
  ok("settings saved oddly fall back field by field: the $25 / $50 / $100 buttons, a $5 minimum and a $500 maximum",
    JSON.stringify(k.giftCards) === JSON.stringify({ sellOnline: true, amounts: [25, 50, 100], min: 5, max: 500 }));
  d1.q("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('giftCards', 'not json'), ('discountRules', 'not json')");
  k = await cat();
  ok("…and rows that aren't JSON: one code, nothing sold online", k.discountRules.multiple === false && k.giftCards.sellOnline === false);
  {
    // A database whose read of the rules fails: the safe defaults, and the failure logged (not an error page).
    const failing = Object.create(d1);
    failing.prepare = (sql) => { if (/key IN \('discountRules', 'giftCards'\)/.test(sql)) throw new Error("disk I/O error (test)"); return d1.prepare(sql); };
    await C.setDiscountRules(d1, { multiple: true });
    const x = await quietly(() => cat({ db: failing }));
    ok("the rules can't be read: one code and nothing sold online, logged as \"checkout rules read failed\"",
      x.v.discountRules && x.v.discountRules.multiple === false && x.v.giftCards.sellOnline === false && x.logged.some(l => /checkout rules read failed/.test(l)));
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
