// Phase 6 coverage gaps on the customer's side and in two admin screens: the branches the other phase 6 tests never ran.
//   1. functions/api/invoice.js: what the invoice page offers when a setting can't be read (the Features, the discount
//      rule, the code-box query, Global settings), payment switches stored as null, an order read without its list of
//      codes or its payments, the answers when the code check or the card spend says no without words (or with its own
//      message), the audit row with no address and no waitUntil, and an audit write that fails.
//   2. functions/api/stripe-webhook.js issueSoldGiftCard_: a gift card line with no price, a price under $1, no gift
//      details or unreadable ones, the order row missing, an older issueGiftCard answer without `created`, the Business
//      profile unreadable, each email or the owner's notice failing, and a database without the line's table.
//   3. public/admin-quotes.js: the totals as the server may send them (per-code lists by other names, amounts by other
//      names, free shipping, tax in the prices), the code box's rule answer in other shapes or failing, a quote with no
//      codes list, no lines, no customer, a code answer without the code, a save answer without the codes, typing above
//      the lines before Apply, Save on a draft and on a sent quote, and typing in the code box not marking the form changed.
//   4. public/admin-customers.js: a customer's test and completed orders are tagged.
// Real SQL (sql.js) under the real db.js, email.js, orders.js, invoice.js and stripe-webhook.js; the admin page in jsdom
// with the real handler behind fetch (a reply can be scripted). A few db.js and email.js functions get a wrapper the test
// can swap for one call (each calls the real one otherwise). Invented shops, people and codes only; the business's time
// zone is UTC and nothing depends on today's date beyond "not in the past".
const fs = require("fs");
const nodeCrypto = require("crypto");
const { ok } = require("./testlib/check");
const { createD1 } = require("./testlib/d1-shim.js");
const roles = require("./testlib/roles");
const { MAIL_ENV, MAIL_OK, captureMail } = require("./testlib/mail-mock");
const { ADMIN_ORIGIN, shopOrigin } = require("./testlib/hosts.js");

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Wrapped functions: globalThis.__o398[name] = (real, ...args) => ... replaces one for as long as it is set.
const wrap = (src, names) => {
  let out = src;
  for (const n of names) {
    const from = "export async function " + n + "(";
    if (!out.includes(from)) throw new Error("no " + n);
    out = out.replace(from, "async function " + n + "_real398_(");
  }
  return strip(out) + "\n" + names.map(n => `async function ${n}(...a) { const o = globalThis.__o398[${JSON.stringify(n)}]; return o ? o(${n}_real398_, ...a) : ${n}_real398_(...a); }`).join("\n") + "\n";
};
globalThis.__o398 = {};
const dbSrc = wrap(read("functions/_lib/db.js"), ["getFeatures", "getDiscountRules", "getGlobalSettings", "getOrderById", "applyOrderDiscountCode", "redeemGiftCard",
  "insertAuditLog", "issueGiftCard", "getBusinessProfile"]);
const emailSrc = wrap(read("functions/_lib/email.js"), ["sendGiftCardEmail", "sendGiftCardSentReceipt", "queueGiftCardSoldNotice"]);
const libs = strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  strip(read("functions/_lib/quoteToken.js")) + "\n" + strip(read("functions/_lib/boxSize.js")) + "\n";
const A = new Function(libs +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" + roles.adminAs() + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {};\n" +
  "const getCatalogData = async () => ({ subdomainMap: { acme: 'acme' }, orgs: {}, features: {} });\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + emailSrc + "\n" + strip(read("functions/_lib/digital.js")) + "\n" +
  "const ordersApi = (function(){\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost; })();\n" +
  "const invoiceApi = (function(){\n" + strip(read("functions/api/invoice.js")) + "\nreturn { onRequestGet, onRequestPost }; })();\n" +
  "const webhookApi = (function(){\n" + strip(read("functions/api/stripe-webhook.js")) + "\nreturn onRequestPost; })();\n" +
  "return { ordersApi, invoiceApi, webhookApi, issueGiftCard, saveDiscountCode, setDiscountRules, setGiftCardSettings, setLocaleSettings, getOrderInvoiceByOrder, localToday };")();

const mail = [];
global.fetch = async (url, init) => {
  if (captureMail(url, init, mail)) return MAIL_OK;
  throw new Error("unexpected fetch " + url);
};
const logged = [];
const quietly = async (fn) => { const err = console.error; console.error = (...a) => logged.push(a.map(String).join(" ")); try { return await fn(); } finally { console.error = err; } };
const ENV = { SIGNING_SECRET: "s".repeat(40), STRIPE_SECRET_KEY: "sk_test_example", DESIGNS: {}, ...MAIL_ENV };
const WHSEC = "whsec_example";
const pause = (ms) => new Promise(r => setTimeout(r, ms));
const wait = async (cond, n = 400) => { for (let i = 0; i < n && !cond(); i++) await pause(10); return !!cond(); };
process.on("unhandledRejection", (e) => { console.error(e); ok("nothing in the test was left to fail unseen", false); });

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready, shippingEnabled) VALUES ('acme','acme','Example Club','t','t',1,1);`);
  await A.setLocaleSettings(d1, { timeZone: "UTC" });
  const q = (sql, ...p) => d1.q(sql, ...p);
  const q1 = (sql, ...p) => d1.q(sql, ...p)[0] || null;
  // The database the handlers see: SQL matching a hook answers the hook's way (a missing row, or an error).
  let sqlHook = null;
  const DB = new Proxy(d1, { get(t, k) {
    if (k === "prepare") return (sql) => {
      if (sqlHook && sqlHook.match.test(sql)) { const h = sqlHook; const st = { bind: () => st, first: async () => h.first(), all: async () => ({ results: [] }), run: async () => h.first() }; return st; }
      return t.prepare(sql);
    };
    const v = t[k]; return typeof v === "function" ? v.bind(t) : v;
  } });
  const E = { DB, ...ENV };
  const call = async (fn, url, body, { ip = "203.0.113.7", waitUntil = true } = {}) => {
    const waits = [];
    const ctx = { env: E, request: { url, json: async () => body, headers: { get: (h) => (h === "CF-Connecting-IP" ? ip : null) } } };
    if (waitUntil) ctx.waitUntil = (p) => waits.push(Promise.resolve(p).catch(() => {}));
    const res = await fn(ctx);
    await Promise.all(waits);
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const admin = (body) => call(A.ordersApi, ADMIN_ORIGIN + "/api/orders", { key: "x", org: "acme", ...body });
  const post = (body) => call(A.ordersApi, shopOrigin("acme") + "/api/orders", body);
  const inv = (body, opts) => call(A.invoiceApi.onRequestPost, shopOrigin("acme") + "/api/invoice", body, opts);
  const invGet = async (token) => { const res = await A.invoiceApi.onRequestGet({ env: E, request: { url: shopOrigin("acme") + "/api/invoice?token=" + token, headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) }; };
  const using = async (over, fn) => { Object.assign(globalThis.__o398, over); try { return await fn(); } finally { for (const k of Object.keys(over)) delete globalThis.__o398[k]; } };
  const boom = () => { throw new Error("unreadable (test)"); };

  let r = await admin({ action: "createProduct", productId: "mug", type: "other", name: "Club Mug", pricingMode: "flat", flatPrice: 10, visible: true, weightOz: 10, noDesignNeeded: true });
  if (r.status !== 200) throw new Error("createProduct " + JSON.stringify(r));
  d1.q("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('business', ?)", JSON.stringify({ name: "Example Embroidery" }));
  await A.saveDiscountCode(d1, { code: "SAVE10", kind: "percent", percent: 10, maxUses: 100 }, { actor: "test" });
  let n = 0;
  const invoiceFor = async (qty = 3) => {
    const orderId = "WEB-" + (++n);
    const x = await post({ orderId, orgId: "acme", customerName: "Pat Example", contact: "pat@example.com", paymentMethod: "Check", items: [{ productId: "mug", qty }] });
    if (x.status !== 200) throw new Error("order " + JSON.stringify(x));
    const s = await admin({ action: "sendInvoice", orderId });
    if (s.status !== 200) throw new Error("sendInvoice " + JSON.stringify(s));
    return { orderId, token: (await A.getOrderInvoiceByOrder(d1, orderId)).token };
  };
  const card = async (dollars) => { const c = await A.issueGiftCard(d1, { amountCents: dollars * 100, recipientName: "Lee Example", recipientEmail: "lee@example.com", by: "test" });
    if (!c.code) throw new Error("card " + JSON.stringify(c)); return c; };
  const balance = (id) => q1("SELECT balanceCents FROM gift_cards WHERE id = ?", id).balanceCents;

  // =================================================================================================================
  console.log("=== The invoice page when a setting can't be read ===");
  // =================================================================================================================
  let I = await invoiceFor();
  r = await using({ getFeatures: boom }, () => invGet(I.token));
  ok("the Features unreadable: the invoice still opens and offers a code and a gift card (as if every feature were on)",
    r.status === 200 && same(r.body.invoice.addOns, { code: true, giftCard: true, multiple: false }));
  await A.setDiscountRules(d1, { multiple: true });
  const rMulti = await invGet(I.token);
  r = await using({ getDiscountRules: boom }, () => invGet(I.token));
  await A.setDiscountRules(d1, { multiple: false });
  ok("the discount rule unreadable while the shop allows several codes: one code at a time is assumed (multiple false), the box still offered",
    rMulti.body.invoice.addOns.multiple === true && r.status === 200 && same(r.body.invoice.addOns, { code: true, giftCard: true, multiple: false }));
  sqlHook = { match: /discount_code_uses u WHERE u\.codeId = d\.id/, first: boom };
  r = await invGet(I.token);
  sqlHook = null;
  ok("the usable-code query failing: no code box, the gift card still offered", r.status === 200 && same(r.body.invoice.addOns, { code: false, giftCard: true, multiple: false }));
  const shopPay = q1("SELECT enabledPayments FROM orgs WHERE orgId = 'acme'").enabledPayments;
  d1.q("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('enabledPayments', 'null')");
  d1.q("UPDATE orgs SET enabledPayments = 'null' WHERE orgId = 'acme'");
  r = await invGet(I.token);
  d1.q("DELETE FROM global_settings WHERE key = 'enabledPayments'");
  d1.q("UPDATE orgs SET enabledPayments = ? WHERE orgId = 'acme'", shopPay);
  ok("payment switches stored as null (globally and for the shop): nothing is switched off, so a gift card is offered",
    r.status === 200 && r.body.invoice.addOns.giftCard === true && r.body.invoice.payments.includes("Check"));

  // =================================================================================================================
  console.log("\n=== An order read without its list of codes or its payments ===");
  // =================================================================================================================
  r = await inv({ token: I.token, action: "applyCode", code: "SAVE10" });
  ok("(SAVE10 goes on the invoice's order: $3.00 off)", r.status === 200 && r.body.invoice.discount === 3);
  const noList = (real, ...a) => real(...a).then(o => { if (o) delete o.discountCodes; return o; });
  r = await using({ getOrderById: noList }, () => invGet(I.token));
  ok("an order with its one code only as discountCode (no list): the invoice lists [SAVE10] and offers no second code",
    r.status === 200 && same(r.body.invoice.discountCodes, ["SAVE10"]) && r.body.invoice.addOns.code === false);
  r = await using({ getOrderById: (real, ...a) => real(...a).then(o => { if (o) { delete o.discountCodes; o.discountCode = ""; } return o; }) }, () => invGet(I.token));
  ok("…and with neither: no codes listed, and since the $3.00 off then reads as a discount typed by staff, no code box",
    r.status === 200 && same(r.body.invoice.discountCodes, []) && r.body.invoice.addOns.code === false);
  const g5 = await card(5);
  r = await inv({ token: I.token, action: "applyGiftCard", code: g5.code });
  ok("(a $5.00 card pays part of it)", r.status === 200 && r.body.invoice.giftCardPaid.length === 1 && r.body.invoice.balanceDue === 22);
  r = await using({ getOrderById: (real, ...a) => real(...a).then(o => { if (o) delete o.payments; return o; }) }, () => invGet(I.token));
  ok("an order read without its payments list: no gift card payments are listed, and the page still opens", r.status === 200 && same(r.body.invoice.giftCardPaid, []));

  // =================================================================================================================
  console.log("\n=== Adding a code or a card: settings unreadable, refusals in other words, the audit row ===");
  // =================================================================================================================
  I = await invoiceFor();
  r = await using({ getGlobalSettings: boom }, () => inv({ token: I.token, action: "applyCode", code: "SAVE10" }));
  ok("Global settings unreadable: a code is still taken (nothing switched off), $3.00 off", r.status === 200 && r.body.invoice.discount === 3 && same(r.body.invoice.discountCodes, ["SAVE10"]));
  const g4 = await card(4);
  r = await using({ getGlobalSettings: boom }, () => inv({ token: I.token, action: "applyGiftCard", code: g4.code }));
  ok("…and a gift card is still taken: $4.00 paid by it", r.status === 200 && r.body.invoice.giftCardPaid.length === 1 && balance(g4.id) === 0);
  I = await invoiceFor();
  r = await using({ applyOrderDiscountCode: async () => ({ ok: false, message: "Example code message." }) }, () => inv({ token: I.token, action: "applyCode", code: "SAVE10" }));
  const rNull = await using({ applyOrderDiscountCode: async () => null }, () => inv({ token: I.token, action: "applyCode", code: "SAVE10" }));
  ok("a code check that says no with a message (not a reason): 400 with that message; with no answer at all: 400 \"This code isn't valid.\"",
    r.status === 400 && r.body.message === "Example code message." && rNull.status === 400 && rNull.body.message === "This code isn't valid.");
  const g6 = await card(6);
  r = await using({ redeemGiftCard: async () => ({ ok: false, message: "Example card message." }) }, () => inv({ token: I.token, action: "applyGiftCard", code: g6.code }));
  const rCardNull = await using({ redeemGiftCard: async () => null }, () => inv({ token: I.token, action: "applyGiftCard", code: g6.code }));
  ok("a card spend that says no with a message: 400 with it; with no answer: 400 \"That gift card number isn't right.\"; the card untouched",
    r.status === 400 && r.body.message === "Example card message." && rCardNull.status === 400 && rCardNull.body.message === "That gift card number isn't right." && balance(g6.id) === 600);
  const ipsGiven = [];
  const seeIp = { insertAuditLog: (real, db, e) => { ipsGiven.push(e && e.ip); return real(db, e); } };
  r = await using(seeIp, () => inv({ token: I.token, action: "applyCode", code: "save10" }, { ip: null, waitUntil: false }));
  ok("a code from a request with no address and no waitUntil: applied, and its audit row is written before the answer, with no ip (null, not blank)",
    r.status === 200 && ipsGiven.length === 1 && ipsGiven[0] === null && same(q("SELECT detail, ip FROM audit_log WHERE orderId = ? AND action = 'order.invoice_code_applied'", I.orderId), [{ detail: '{"code":"SAVE10"}', ip: null }]));
  let keyAsked = "";
  ipsGiven.length = 0;
  r = await using({ ...seeIp, redeemGiftCard: async (real, db, p) => { keyAsked = p.requestKey; return { ok: true }; },
    getOrderById: (real, ...a) => real(...a).then(o => { if (o) delete o.payments; return o; }) },
  () => inv({ token: I.token, action: "applyGiftCard", code: g6.code }, { ip: null, waitUntil: false }));
  ok("a card on an order read without its payments: the spend is keyed with 0 payment rows (…:2700:0)", r.status === 200 && keyAsked === "invgc:" + I.orderId + ":" + g6.last4 + ":2700:0");
  ok("…a spend answer without the cents taken is audited as 0 cents, with no ip (null), before the answer",
    ipsGiven.length === 1 && ipsGiven[0] === null && same(q("SELECT detail, ip FROM audit_log WHERE orderId = ? AND action = 'order.invoice_gift_card_used'", I.orderId), [{ detail: JSON.stringify({ card: "••" + g6.last4, takenCents: 0 }), ip: null }]));
  I = await invoiceFor();
  const g7 = await card(7);
  logged.length = 0;
  const failAudit = { insertAuditLog: async () => { throw new Error("audit down (test)"); } };
  const rC = await quietly(() => using(failAudit, () => inv({ token: I.token, action: "applyCode", code: "SAVE10" })));
  const rG = await quietly(() => using(failAudit, () => inv({ token: I.token, action: "applyGiftCard", code: g7.code })));
  ok("an audit row that can't be written: the code and the card still go on (200, $3.00 off, $7.00 paid by card)",
    rC.status === 200 && rC.body.invoice.discount === 3 && rG.status === 200 && balance(g7.id) === 0 && rG.body.invoice.balanceDue === 20);
  ok("…and each failure is logged", logged.some(l => l.startsWith("Invoice code applied, but recording it failed: " + I.orderId)) &&
    logged.some(l => l.startsWith("Invoice gift card used, but recording it failed: " + I.orderId)));

  // =================================================================================================================
  console.log("\n=== The Stripe webhook making a gift card sold online ===");
  // =================================================================================================================
  await A.setGiftCardSettings(d1, { sellOnline: true });
  const hook = async (event) => {
    const body = JSON.stringify(event), t = Math.floor(Date.now() / 1000);
    const sig = nodeCrypto.createHmac("sha256", WHSEC).update(t + "." + body).digest("hex");
    const res = await A.webhookApi({ env: { DB, STRIPE_WEBHOOK_SECRET: WHSEC, SIGNING_SECRET: ENV.SIGNING_SECRET, ...MAIL_ENV },
      request: { text: async () => body, headers: { get: (h) => (h === "stripe-signature" ? `t=${t},v1=${sig}` : null) } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  let ev = 0, req = 0;
  const paid = (orderId, cents = 5000) => { ev++; return hook({ id: "evt_398_" + ev, type: "checkout.session.completed", created: Math.floor(Date.now() / 1000),
    data: { object: { id: "cs_398_" + ev, payment_intent: "pi_398_" + ev, payment_status: "paid", amount_total: cents, metadata: { orderId, orgId: "acme" } } } }); };
  const buy = async () => { const x = await post({ action: "buyGiftCard", amountCents: 5000, recipientName: "Sam Example", recipientEmail: "sam@example.com",
    buyerName: "Pat Example", buyerEmail: "pat@example.com", message: "Happy birthday!", requestId: "GC-398-" + String(++req).padStart(8, "0") });
    if (x.status !== 200) throw new Error("buy " + JSON.stringify(x)); return x.body.orderId; };
  const cardsFor = (orderId) => q("SELECT recipientName, recipientEmail, buyerName, buyerEmail, message, initialCents FROM gift_cards WHERE sourceOrderId = ?", orderId);
  const issues = (orderId) => q("SELECT kind FROM system_issues WHERE sample LIKE ?", "%" + orderId + "%").map(x => x.kind);
  const notices = (orderId) => q("SELECT summary FROM owner_notices WHERE orderId = ? AND kind = 'gift_card'", orderId).map(x => x.summary);
  const paidFlag = (orderId) => q1("SELECT paid FROM orders WHERE orderId = ?", orderId).paid;

  const lineSql = /productId = '__giftcard__' LIMIT 1/;
  let o = await buy();
  sqlHook = { match: lineSql, first: async () => ({ lineTotalCents: null, configJson: "{}" }) };
  r = await paid(o);
  sqlHook = null;
  ok("a gift card line read with no price: the payment is recorded (paid) but no card is made", r.status === 200 && paidFlag(o) === 1 && cardsFor(o).length === 0);
  o = await buy();
  sqlHook = { match: lineSql, first: async () => ({ lineTotalCents: 50, configJson: "{}" }) };
  r = await paid(o);
  sqlHook = null;
  ok("…a line of $0.50, under the $1.00 a card starts at: no card either", r.status === 200 && paidFlag(o) === 1 && cardsFor(o).length === 0);

  o = await buy();
  d1.q("UPDATE order_items SET configJson = 'not json' WHERE orderId = ? AND productId = '__giftcard__'", o);
  mail.length = 0;
  r = await paid(o);
  ok("gift details that can't be read: the $50.00 card is still made, with no recipient, from the buyer",
    r.status === 200 && same(cardsFor(o), [{ recipientName: "", recipientEmail: "", buyerName: "Pat Example", buyerEmail: "pat@example.com", message: "", initialCents: 5000 }]));
  ok("…nobody to email it to: recorded as gift_card_email_failed, and the owner's notice names no one", same(issues(o), ["gift_card_email_failed"]) && same(notices(o), ["Gift card $50.00 — order " + o]));
  o = await buy();
  d1.q("UPDATE order_items SET configJson = '' WHERE orderId = ? AND productId = '__giftcard__'", o);
  r = await paid(o);
  ok("no gift details at all (an empty configJson): the same, a card with no recipient", r.status === 200 && cardsFor(o).length === 1 && cardsFor(o)[0].recipientEmail === "" && same(issues(o), ["gift_card_email_failed"]));
  o = await buy();
  d1.q("UPDATE order_items SET configJson = '{\"other\":1}' WHERE orderId = ? AND productId = '__giftcard__'", o);
  r = await paid(o);
  ok("details without a giftCard part: the same", r.status === 200 && cardsFor(o).length === 1 && cardsFor(o)[0].recipientName === "");

  o = await buy();
  mail.length = 0;
  sqlHook = { match: /COALESCE\(g\.name, ''\) AS shopName/, first: async () => null };
  r = await paid(o);
  sqlHook = null;
  ok("the order's own row not found for the names: the card is made for Sam Example with no buyer named", r.status === 200 &&
    same(cardsFor(o), [{ recipientName: "Sam Example", recipientEmail: "sam@example.com", buyerName: "", buyerEmail: "", message: "Happy birthday!", initialCents: 5000 }]));
  ok("…Sam still gets it, and no \"was sent\" note goes to a buyer with no address", mail.filter(m => m.to === "sam@example.com").length === 1 &&
    !mail.some(m => m.subject === "Your gift card was sent") && same(issues(o), []));

  o = await buy();
  mail.length = 0;
  const oldAnswer = { issueGiftCard: (real, ...a) => real(...a).then(x => { if (x) delete x.created; return x; }) };
  r = await using(oldAnswer, () => paid(o));
  const firstMail = mail.length;
  mail.length = 0;
  const r2 = await quietly(() => using(oldAnswer, () => paid(o)));
  ok("an issueGiftCard answer without `created`: the first delivery made the card (no card before), so it is emailed once",
    r.status === 200 && cardsFor(o).length === 1 && firstMail === 2 && same(notices(o), ["Gift card $50.00 for Sam Example — order " + o]));
  ok("…a later paying event finds the card already there: nothing sent again, no second notice", r2.status === 200 && mail.length === 0 && notices(o).length === 1);

  o = await buy();
  mail.length = 0;
  r = await using({ getBusinessProfile: boom }, () => paid(o));
  ok("the Business profile unreadable: the card is still emailed, named by the shop it came from (Example Club)",
    r.status === 200 && mail.some(m => m.to === "sam@example.com" && /gift card for Example Club/.test(m.body)) && same(issues(o), []));

  o = await buy();
  logged.length = 0;
  r = await quietly(() => using({ sendGiftCardEmail: async () => { throw new Error("mail down (test)"); } }, () => paid(o)));
  ok("the recipient's email throwing: 200, the card stands, recorded as gift_card_email_failed, logged, the owner still told",
    r.status === 200 && cardsFor(o).length === 1 && same(issues(o), ["gift_card_email_failed"]) && logged.some(l => l.startsWith("Emailing the gift card failed for " + o)) && notices(o).length === 1);
  o = await buy();
  logged.length = 0; mail.length = 0;
  r = await quietly(() => using({ sendGiftCardSentReceipt: async () => { throw new Error("mail down (test)"); } }, () => paid(o)));
  ok("the buyer's \"was sent\" note failing: logged only; Sam got the card, nothing recorded as failed",
    r.status === 200 && mail.some(m => m.to === "sam@example.com") && same(issues(o), []) && logged.some(l => l.startsWith("Gift card sent-receipt failed for " + o)));
  o = await buy();
  logged.length = 0;
  r = await quietly(() => using({ queueGiftCardSoldNotice: async () => { throw new Error("queue down (test)"); } }, () => paid(o)));
  ok("the owner's notice failing: logged, the payment and the card stand (200)", r.status === 200 && cardsFor(o).length === 1 && notices(o).length === 0 &&
    logged.some(l => l.startsWith("Gift card sold notice failed for " + o)));

  o = await buy();
  sqlHook = { match: lineSql, first: async () => { throw new Error("D1_ERROR: no such column: configJson"); } };
  r = await quietly(() => paid(o));
  sqlHook = null;
  ok("a database without the gift card line's columns: the payment is recorded (200, paid) and no card is looked for", r.status === 200 && paidFlag(o) === 1 && cardsFor(o).length === 0);
  o = await buy();
  sqlHook = { match: lineSql, first: async () => { throw new Error("database locked (test)"); } };
  r = await quietly(() => paid(o));
  sqlHook = null;
  ok("…any other failure reading it: 500 so Stripe retries, no card yet", r.status === 500 && cardsFor(o).length === 0);
  r = await quietly(() => paid(o));
  ok("…and the retry makes it", r.status === 200 && cardsFor(o).length === 1);

  await partTwo(d1, admin);
})().catch((e) => { console.error(e); ok("the test ran to the end", false); });

// =================================================================================================================
// The quote editor and the customer page in the real admin page (jsdom), the real handler behind fetch.
// =================================================================================================================
async function partTwo(d1, admin) {
  const { JSDOM, ResourceLoader, VirtualConsole } = require("jsdom");
  const { storefrontPage } = require("./testlib/storefront-page");
  const adminJs = read("public/admin.js"), custJs = read("public/admin-customers.js"), quotesJs = read("public/admin-quotes.js");
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
  const P = { sent: [], toasts: [], queue: [] };
  // A scripted reply for the next request of an action: { body, status } or { reject }, after `hold` (a promise) if given.
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
  const pageErrors = [];
  vc.on("jsdomError", (e) => { if (!/Not implemented|Could not load script/.test(e.message)) pageErrors.push(e.message); });
  const dom = new JSDOM(storefrontPage(), { runScripts: "dangerously", resources: new Loader(), virtualConsole: vc, url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win) {
      win.CSS = win.CSS || { escape: (s) => String(s).replace(/["\\]/g, "\\$&") };
      win.fetch = async (url, init) => {
        const u = String(url), b = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
        if (!u.includes("/api/orders")) return reply(404, { status: "error", message: "not here" });
        P.sent.push(b);
        const i = P.queue.findIndex(s => s.action === b.action);
        const s = i >= 0 ? P.queue.splice(i, 1)[0] : null;
        if (s && s.hold) await s.hold;
        if (s && s.reject) throw s.reject;
        if (s && s.body !== undefined) return reply(s.status || 200, s.body);
        const x = await admin(b);
        return reply(x.status, x.body);
      };
    } });
  const w = dom.window, d = w.document;
  await pause(150);
  await w.loadAdminScript();
  w.showToast = (m, isErr) => P.toasts.push({ m: String(m), err: !!isErr });
  w.eval('adminKey = "cookie"; setAdminTimeZone_("UTC"); adminOrgs = ' + JSON.stringify([{ orgId: "acme", name: "Example Club" }]) + ';');
  w.eval(roles.asRole("admin", { name: "Tester", email: "tester@example.test" }));
  const q = (sel) => d.querySelector(sel), qa = (sel) => [...d.querySelectorAll(sel)];
  const of = (a) => P.sent.filter(b => b.action === a);
  const reset = () => { P.sent.length = 0; P.toasts.length = 0; };
  const text = (el) => el ? el.textContent.replace(/\s+/g, " ").trim() : "";
  const open = async (id) => { const old = d.getElementById("qtPage"); if (w.location.hash.replace(/^#\/?/, "") === "quotes/" + id) w.adminRoute(); else w.location.hash = "#quotes/" + id;
    await wait(() => d.getElementById("qtPage") && d.getElementById("qtPage") !== old && !!q("#qtForm")); await pause(60); };
  const sumRows = () => qa("#qtTotals tr").map(tr => [...tr.children].map(text).join(" "));
  const msg = () => text(q("#qtCodeMsg"));
  const box = () => text(q("#qtCodes"));

  // (Pat Example is a customer already: the orders above made the record.)
  const pat = d1.q("SELECT id FROM customers WHERE email = 'pat@example.com'")[0].id;
  const LINES = [{ kind: "custom", name: "Club banner", qty: 1, unitPrice: 40, taxable: true }, { kind: "custom", name: "Example service", qty: 1, unitPrice: 10, taxable: false }];
  const newQuote = async () => {
    const c = await admin({ action: "createEstimate", org: "acme", customerId: pat, title: "Example quote", expiresOn: "2099-12-31" });
    if (c.status !== 200) throw new Error("createEstimate " + pat + " " + JSON.stringify(c.body));
    const s = await admin({ action: "saveEstimate", id: c.body.id, items: LINES });
    if (s.status !== 200) throw new Error("seed quote: " + JSON.stringify(s.body));
    return c.body.id;
  };
  const qid = await newQuote();
  const real = (await admin({ action: "getEstimate", id: qid })).body;
  if (!real.estimate || !Array.isArray(real.items)) throw new Error("getEstimate " + JSON.stringify(real));
  const as = (f) => { const x = JSON.parse(JSON.stringify(real)); f(x); return x; };
  const est = (x, f) => { f(x.estimate); return x; };

  console.log("\n=== The quote editor: totals as the server may send them ===");
  P.script("getEstimate", { body: as(x => { delete x.estimate.discountCodes; x.totals = { taxMode: "inclusive", subtotal: 50, total: 50, tax: 3.7 }; }) });
  await open(qid);
  ok("tax in the prices and no discount: no Subtotal or Sales tax line, the Total and \"Includes sales tax\"", same(sumRows(), ["Total $50.00", "Includes sales tax $3.70"]));
  ok("…a quote answered without a codes list has none: \"No discount code on this quote.\"", /No discount code on this quote\./.test(box()) && !q(".qt-code-list"));
  P.script("getEstimate", { body: as(x => { x.totals = { taxMode: "inclusive", subtotal: 50, total: 41, tax: 3, discounts: [{ code: "TEAM5", amount: 3 }, { goodsOff: 2 }, { code: "ZERO", amount: 0 }], shippingOff: 4 }; }) });
  await open(qid);
  ok("per-code shares sent as \"discounts\" with amount / goodsOff, and shippingOff: a line per code (a code-less one as \"Discount ()\"), Free shipping, and with a discount the Subtotal shows",
    same(sumRows(), ["Subtotal $50.00", "Discount (TEAM5) −$3.00", "Discount () −$2.00", "Free shipping −$4.00", "Total $41.00", "Includes sales tax $3.00"]));
  P.script("getEstimate", { body: as(x => { x.estimate.discountCodes = ["SAVE10"]; x.totals = { taxMode: "exclusive", subtotal: 50, total: 48.6, tax: 3.6, perCode: [{ code: "SAVE10", discount: 5 }], shippingDiscount: 0 }; }) });
  await open(qid);
  ok("one share sent as \"perCode\" and no total discount: the discount is the shares added up, \"Discount (SAVE10) −$5.00\"",
    same(sumRows(), ["Subtotal $50.00", "Discount (SAVE10) −$5.00", "Sales tax $3.60", "Total $48.60"]));

  console.log("\n=== The quote editor: the shop's code rule in other shapes ===");
  P.script("getEstimate", { body: as(x => { x.estimate.discountCodes = ["SAVE10"]; }) });
  P.script("getDiscountRules", { body: { status: "ok", rules: { multiple: true } } });
  await open(qid);
  ok("a rule answered as { rules: { multiple: true } }: \"Add another code\" is offered", text(q("label[for=qtCode]")) === "Add another code");
  P.script("getEstimate", { body: as(x => { x.estimate.discountCodes = ["SAVE10"]; }) });
  P.script("getDiscountRules", { body: { status: "ok", multiple: true } });
  await open(qid);
  ok("…answered as { multiple: true } itself: the same", text(q("label[for=qtCode]")) === "Add another code");
  P.script("getEstimate", { body: as(x => { x.estimate.discountCodes = ["SAVE10"]; }) });
  P.script("getDiscountRules", { reject: new Error("rule unreadable (test)") });
  await open(qid);
  ok("…a rule that can't be read: one code at a time, so no field and the note why", !q("#qtCode") && /Only one discount code can be used at a time/.test(box()));
  let release;
  P.script("getDiscountRules", { hold: new Promise(res => { release = res; }) });
  pageErrors.length = 0;
  await open(qid);
  q("#qtCodes").remove();
  release();
  await pause(80);
  ok("the rule answering after the box has gone: nothing is drawn and nothing breaks", !q("#qtCodes") && !q("#qtCode") && !!q("#qtForm") && pageErrors.length === 0);

  console.log("\n=== The quote editor: Apply in unusual states ===");
  await open(qid);
  reset();
  q("#qtCode").remove();
  q("#qtCodeAdd").click(); await pause(40);
  ok("Apply with its field gone: nothing is asked", P.sent.length === 0);
  P.script("getEstimate", { body: as(x => { delete x.items; }) });
  await open(qid);
  reset();
  q("#qtCode").value = "SAVE10";
  q("#qtCodeAdd").click(); await pause(40);
  ok("a quote answered without its lines: \"Add the items first.\" and nothing asked", msg() === "Add the items first." && P.sent.length === 0);
  P.script("getEstimate", { body: as(x => { delete x.customer; x.estimate.customerId = null; x.items.forEach(it => { delete it.lineTotal; }); }) });
  await open(qid);
  reset();
  P.script("checkLocalSaleCode", { body: { status: "ok", ok: true } });
  P.script("saveEstimate", { body: as(x => { delete x.estimate.discountCodes; }) });
  q("#qtCode").value = "team5";
  q("#qtCodeAdd").click();
  await wait(() => of("saveEstimate").length === 1); await pause(60);
  const chk = of("checkLocalSaleCode")[0] || {};
  ok("a quote with no customer and lines without totals: the check is for $0 of goods with no address or customer id",
    chk.code === "TEAM5" && chk.subtotal === 0 && !("contact" in chk) && !("customerId" in chk));
  ok("…an answer without the code itself uses what was typed, and a save answer without a codes list keeps it: TEAM5 listed, toast",
    same(of("saveEstimate")[0].discountCodes, ["TEAM5"]) && text(q(".qt-code-list")) === "TEAM5 ×" && P.toasts.some(t => t.m === "Code TEAM5 added."));

  console.log("\n=== The quote editor: what is typed above the lines, Save ===");
  await open(qid);
  reset();
  q("#qtExpires").value = "2000-01-01";
  q("#qtExpires").dispatchEvent(new w.Event("input", { bubbles: true }));
  q("#qtCode").value = "SAVE10";
  q("#qtCodeAdd").click(); await pause(60);
  ok("a past last day typed, then Apply: it is saved first and refused, \"The last day to accept can't be in the past.\", the code not checked",
    msg() === "The last day to accept can't be in the past." && of("checkLocalSaleCode").length === 0 && of("saveEstimate").length === 0);
  q("#qtExpires").value = "2099-12-31";
  q("#qtTitle").value = "Example quote, revised";
  q("#qtTitle").dispatchEvent(new w.Event("input", { bubbles: true }));
  reset();
  P.script("checkLocalSaleCode", { body: { status: "ok", ok: false, reason: "Example refusal." } });
  P.script("saveEstimate", { body: as(x => { delete x.items; x.estimate.title = "Example quote, revised"; }) });
  q("#qtCodeAdd").click();
  await wait(() => of("checkLocalSaleCode").length === 1); await pause(60);
  ok("…a new title typed, then Apply: the quote is saved with it (no codes sent) before the code is checked",
    P.sent.map(b => b.action).join(",") === "saveEstimate,checkLocalSaleCode" && of("saveEstimate")[0].title === "Example quote, revised" && !("discountCodes" in of("saveEstimate")[0]) &&
    msg() === "Example refusal.");
  ok("…and that save answered without its lines: the code is checked against $0 of goods", of("checkLocalSaleCode")[0].subtotal === 0);
  await open(qid);
  reset();
  q("#qtTitle").value = "Example quote";
  q("#qtSave").click();
  await wait(() => of("saveEstimate").length === 1); await pause(60);
  ok("Save on a draft sends the lines with it and nothing else extra, and says \"Quote saved.\"",
    Array.isArray(of("saveEstimate")[0].items) && !("discountCodes" in of("saveEstimate")[0]) && of("saveEstimate")[0].title === "Example quote" && P.toasts.some(t => t.m === "Quote saved.") &&
    text(q("#qtSaved")) === "Saved.");
  q("#qtCode").value = "x";
  q("#qtCode").dispatchEvent(new w.Event("input", { bubbles: true }));
  const keptSaved = text(q("#qtSaved"));
  q("#qtInternal").value = "Call first";
  q("#qtInternal").dispatchEvent(new w.Event("input", { bubbles: true }));
  ok("typing in the code field leaves \"Saved.\" (it isn't the quote's own fields); typing in the internal note clears it", keptSaved === "Saved." && text(q("#qtSaved")) === "");
  const sentQ = await newQuote();
  const s = await admin({ action: "sendEstimate", id: sentQ });
  if (s.status !== 200) throw new Error("sendEstimate " + JSON.stringify(s.body));
  await open(sentQ);
  reset();
  q("#qtInternal").value = "Sent on Monday";
  q("#qtSave").click();
  await wait(() => of("saveEstimate").length === 1); await pause(60);
  ok("Save on a sent quote sends its internal note alone, no lines", same(Object.keys(of("saveEstimate")[0]).filter(k => k !== "key").sort(), ["action", "id", "internalNote"]) &&
    of("saveEstimate")[0].internalNote === "Sent on Monday" && P.toasts.some(t => t.m === "Quote saved."));

  console.log("\n=== The customer page: test and completed orders ===");
  P.script("getCustomer", { body: { status: "ok", customer: { id: pat, name: "Pat Example", email: "pat@example.com" }, totals: { totalSpent: 20, balanceDue: 0 },
    orders: [{ orderId: "ACME-T1", orgId: "acme", placedAt: "2026-03-10T15:00:00.000Z", total: 10, paidAmount: 10, balanceDue: 0, isTest: true },
      { orderId: "ACME-C1", orgId: "acme", placedAt: "2026-03-11T15:00:00.000Z", total: 10, paidAmount: 10, balanceDue: 0, completed: true }] } });
  w.location.hash = "#customers/" + pat;
  await wait(() => qa("#custPage tbody tr").length >= 2); await pause(40);
  const rows = qa("#custPage table tbody tr").filter(tr => /ACME-/.test(tr.textContent)).map(tr => [...tr.querySelectorAll(".cust-tag")].map(text).join(","));
  ok("a test order is tagged Test and a completed one Completed", same(rows, ["Test", "Completed"]));
  ok("(no page errors along the way)", pageErrors.length === 0);
  w.close();
}
