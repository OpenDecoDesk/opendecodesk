// Phase 6 (several discount codes, minimum-order and free-shipping codes, codes on quotes and the order page, gift cards
// as a payment, Reorder): the fallbacks, refusals and error paths of functions/api/orders.js and functions/api/catalog.js
// that the other phase 6 tests never reach —
//   * the helpers behind a cart's codes and cards (resolveDiscountCodes_, claimResolvedCodes_, codeCheckAnswer_,
//     codeOthersOf_, giftCardSettingsInput_, redeemOrderGiftCards_, giftCardsOf_, estimateGoodsCents_) given odd answers;
//   * a quote made into an order (convertEstimateToOrder_) with no codes list, no email, a lost race, free shipping and
//     an order that can't be written; sendEstimate and saveEstimate when the quote's reader leaves the codes out;
//   * the admin actions: the Revenue report's balance, addPayment's "waive the rest", voidPayment / setDiscount refused
//     by the database, the Local sale's code and card paths, codes on an order, Reorder, every Gift cards action, the
//     two settings and their Global settings sections;
//   * the customer's side: checkDiscountCode / checkGiftCard / buyGiftCard / a storefront order with a code and cards
//     when the database answers oddly or fails; the catalog's checkout rules with nothing to read.
// The database's answers are steered by wrapping db.js / email.js functions (each wrapper calls the real one unless a
// check sets a stand-in) and by a DB whose prepare() can be given a statement. Real SQL (sql.js) everywhere else.
// Invented shops, people and codes only. No check depends on today's date or this machine's time zone.
const fs = require("fs");
const { ok } = require("./testlib/check");
const { createD1 } = require("./testlib/d1-shim.js");
const roles = require("./testlib/roles");
const { MAIL_ENV, MAIL_OK, captureMail } = require("./testlib/mail-mock");
const { ADMIN_ORIGIN, shopOrigin } = require("./testlib/hosts.js");

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/^import "[^"\n]+";\n/gm, "").replace(/export (async function|function|const)/g, "$1");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Every named function gets a wrapper: globalThis.__H397[name](real, ...args) when a check sets one, else the real one.
globalThis.__H397 = {};
const hookify = (src, names) => {
  let out = src, tail = "";
  for (const n of names) {
    const re = new RegExp("export (async )?function " + n + "\\(");
    if (!re.test(out)) throw new Error("no function " + n + " to wrap");
    out = out.replace(re, (m, a) => (a || "") + "function " + n + "__r397(");
    tail += `\nfunction ${n}(...a) { const h = globalThis.__H397[${JSON.stringify(n)}]; return h ? h(${n}__r397, ...a) : ${n}__r397(...a); }`;
  }
  return strip(out) + tail + "\n";
};
const DB_HOOKS = ["planDiscountCodes", "checkDiscountCode", "claimDiscountCodes", "checkGiftCard", "redeemGiftCard", "insertOrder", "releaseDiscountCodeUse",
  "getEstimate", "getGlobalSettings", "getRevenueData", "voidPayment", "setOrderDiscount", "priceItem", "getOrderById", "removeOrderDiscountCode",
  "orderForReorder_", "getGiftCard", "getBusinessProfile", "listGiftCards", "revealGiftCardCode", "issueGiftCard", "adjustGiftCard", "voidGiftCard",
  "getOrderPaymentById", "refundToGiftCard", "setDiscountRules", "setGiftCardSettings", "bumpCatalogVersion", "buildDiscountRules", "buildGiftCardSettings",
  "getGiftCardSettings"];
const EMAIL_HOOKS = ["emailCanSend", "sendGiftCardEmail", "sendOrderReceivedEmail"];

// Who is signed in: globalThis.__who397, a built-in role. adminActor answers __actor397 when a check sets it.
const LEVELS = {};
for (const k of Object.keys(roles.DEFAULT_ROLES)) LEVELS[k] = roles.effectivePermissions(roles.DEFAULT_ROLES[k]);
const authSrc = `
const __LV397 = ${JSON.stringify(LEVELS)};
const __rank397 = (l) => l === "full" ? 3 : l === "edit" ? 2 : l === "read" ? 1 : 0;
const adminUser = () => { const k = globalThis.__who397; return k && __LV397[k] ? { id: 1, email: k + "@example.test", name: k, role: k, roleInfo: { key: k }, pending: null, bootstrap: false } : null; };
const adminLevel = (request, fn) => { const u = adminUser(); return u ? (__LV397[u.role][fn] || "none") : "none"; };
const adminCan = (request, fn, level) => __rank397(adminLevel(request, fn)) >= __rank397(level || "read");
const requireAdmin = async (env, host, key, request, msg, need) => {
  const u = adminUser();
  if (!u) return jsonResponse({ status: "error", message: "Unauthorized" }, 401);
  const okay = need === "*" || (Array.isArray(need) ? need.some(([fn, l]) => adminCan(request, fn, l)) : u.role === "admin");
  return okay ? null : jsonResponse({ status: "error", code: "forbidden", message: "Your role can't do this. Ask an admin." }, 403);
};
const adminActor = () => globalThis.__actor397 !== undefined ? globalThis.__actor397 : (globalThis.__who397 || "nobody") + "@example.test";
`;
globalThis.__f397 = {};
const libs = strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  strip(read("functions/_lib/quoteToken.js")) + "\n" + strip(read("functions/_lib/boxSize.js")) + "\n";
const S = new Function(libs + authSrc + "\n" + strip(read("functions/_lib/permissions.js")) + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyTurnstile = async () => ({ ok: true });\nconst invalidateCatalogVersionCache = () => {};\n" +
  "const getCatalogData = async () => ({ subdomainMap: { acme: 'acme' }, orgs: {}, features: globalThis.__f397 });\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  hookify(read("functions/_lib/db.js"), DB_HOOKS) + strip(read("functions/_lib/vendorCredentials.js")) + "\n" + strip(read("functions/_lib/smtp.js")) + "\n" +
  hookify(read("functions/_lib/email.js"), EMAIL_HOOKS) + strip(read("functions/_lib/digital.js")) + "\n" + strip(read("functions/_lib/campaigns.js")) + "\n" +
  strip(read("functions/api/orders.js")) +
  `\nreturn { post: onRequestPost, convertEstimateToOrder_, resolveDiscountCodes_, claimResolvedCodes_, codeCheckAnswer_, codeOthersOf_, giftCardSettingsInput_,
    redeemOrderGiftCards_, giftCardsOf_, estimateGoodsCents_, saveDiscountCode, setDiscountRules: setDiscountRules__r397, issueGiftCard: issueGiftCard__r397,
    insertOrder: insertOrder__r397, getOrderById: getOrderById__r397, createProduct, publishShop, setGiftCardSettings: setGiftCardSettings__r397 };`)();

// The catalog: the real catalogCache.js (its two readers wrapped) and catalog.js.
const C = new Function(libs + strip(read("functions/_lib/db.js")) + "\n" + hookify(read("functions/_lib/catalogCache.js"), ["getCatalogData", "getCatalogShop"]) +
  "const catalogApi = (function(){\n" + strip(read("functions/api/catalog.js")) + "\nreturn { onRequestGet }; })();\n" +
  "return { catalogGet: catalogApi.onRequestGet, publishShop, setFeatures, _resetCatalogCacheState };")();

const mail = [];
globalThis.fetch = async (url, init) => {
  if (captureMail(url, init, mail)) return MAIL_OK;
  if (/api\.stripe\.com/.test(String(url))) return { ok: true, status: 200, json: async () => ({ url: "https://checkout.stripe.test/s/1", id: "cs_1" }) };
  return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
};
// What the code logs on purpose is kept here, not printed.
const logged = [];
console.error = (...a) => { logged.push(a.map(x => (x && x.message) || String(x)).join(" ")); };
const H = globalThis.__H397;
// Sets stand-ins for one call, and always takes them away again.
const withHooks = async (hooks, fn) => { Object.assign(H, hooks); try { return await fn(); } finally { for (const k of Object.keys(hooks)) delete H[k]; } };
// A statement that answers what a check says.
const stmt = (first, all) => { const s = { bind: () => s, first: async () => (typeof first === "function" ? first() : first), all: async () => (typeof all === "function" ? all() : all), run: async () => ({}) }; return s; };

(async () => {
  const migrations = fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort();
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of migrations) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready, shippingEnabled) VALUES ('acme','acme','Example Club','t','t',1,0);
    INSERT INTO customers (id, name, email, phone, company, createdAt, updatedAt) VALUES (1, 'Pat Example', 'pat@example.com', '555-0100', 'Example Club', 't', 't');`);
  // The DB the code sees: the real one, unless globalThis.__sql397(sql) hands back a statement (or throws).
  const DB = Object.create(d1);
  DB.prepare = (sql) => { const h = globalThis.__sql397; const x = h ? h(sql) : null; return x || d1.prepare(sql); };
  const withSql = async (h, fn) => { globalThis.__sql397 = h; try { return await fn(); } finally { globalThis.__sql397 = null; } };
  const ENV = { SIGNING_SECRET: "s".repeat(40), STRIPE_SECRET_KEY: "sk_test_example", DESIGNS: {}, ...MAIL_ENV };
  const call = async (url, body, { noWait = false } = {}) => {
    const waits = [];
    const ctx = { env: { DB, ...ENV }, request: { url, json: async () => body, headers: { get: () => null } } };
    if (!noWait) ctx.waitUntil = (p) => waits.push(Promise.resolve(p).catch(() => {}));
    const res = await S.post(ctx);
    await Promise.all(waits);
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const admin = (body) => call(ADMIN_ORIGIN + "/api/orders", { key: "x", org: "acme", ...body });
  const shopPost = (body, opts) => call(shopOrigin("acme") + "/api/orders", body, opts);
  globalThis.__who397 = "admin";
  const q1 = (sql, ...p) => d1.q(sql, ...p)[0] || null;
  const refused = (r, status, message) => r.status === status && r.body.status === "error" && (message === undefined || r.body.message === message);
  const lastAudit = (action) => { const r = q1("SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC", action); return r ? { ...r, d: JSON.parse(r.detail || "{}") } : null; };
  const makeCode = async (input) => { const r = await S.saveDiscountCode(DB, input, { actor: "test" }); if (!r.code) throw new Error("code " + JSON.stringify(r)); return r.code; };
  const card = async (dollars, extra = {}) => { const r = await S.issueGiftCard(DB, { amountCents: Math.round(dollars * 100), recipientName: "Sam Example", recipientEmail: "sam@example.com", by: "test", ...extra });
    if (!r.code) throw new Error("card " + JSON.stringify(r)); return r; };
  let n = 0;
  const tee = (price = 25, qty = 4) => [{ productId: "__custom__", name: "Club Tee", type: "other", size: "", customUnitPrice: price, qty, taxable: false }];
  const sale = (extra) => admin({ action: "createLocalSale", requestId: "req397sale" + (++n), items: tee(), paymentMethod: "Cash", ...extra });
  const newOrder = async (orderId, dollars = 20, extra = {}) => {
    await S.insertOrder(DB, { orderId, orgId: "acme", customerName: "Pat Example", contact: "pat@example.com", phone: "", paymentMethod: "", subtotal: dollars, shippingCost: 0, total: dollars,
      shippingMethod: "", shippingAddress: null, totalWeightOz: 0, placedAt: "2026-03-10T15:00:00.000Z", ...extra },
      [{ productId: "__custom__", name: "Club cap", type: "other", size: "", qty: 1, unitPrice: dollars, personalized: false, persName: "", personalizationFee: 0, taxable: false }]);
    return orderId;
  };
  const SAVE10 = await makeCode({ code: "SAVE10", kind: "percent", percent: 10, maxUses: 1000 });
  await makeCode({ code: "BIGMIN", kind: "amount", amount: 5, maxUses: 1000, minOrder: 1000 });
  let r;

  console.log("=== The helpers, given odd answers ===");
  {
    ok("estimateGoodsCents_: no list is no goods, and a line whose total isn't a number counts $0", S.estimateGoodsCents_(null) === 0 &&
      S.estimateGoodsCents_([{ kind: "custom", lineTotal: "lots" }, { kind: "custom", lineTotal: 2.5 }, { kind: "fee", lineTotal: 40 }]) === 250);
    r = await withHooks({ planDiscountCodes: async () => ({ ok: false }) }, () => S.resolveDiscountCodes_(DB, { codes: ["X"], orgId: "acme", email: "", goodsCents: 100 }));
    ok("resolveDiscountCodes_: a refusal that names no code and gives no reason is \"This code isn't valid.\" (no second look)", same(r, { error: "This code isn't valid." }));
    r = await withHooks({ planDiscountCodes: async () => null }, () => S.resolveDiscountCodes_(DB, { codes: ["X"], orgId: "acme", email: "", goodsCents: 100 }));
    ok("…and no answer at all is the same sentence", same(r, { error: "This code isn't valid." }));
    let probed = 0;
    r = await withHooks({ planDiscountCodes: async () => ({ ok: false, code: "SAVE10", reason: "This code has expired." }),
      checkDiscountCode: async () => { probed++; throw new Error("database busy (test)"); } },
      () => S.resolveDiscountCodes_(DB, { codes: ["SAVE10"], orgId: "acme", email: "", goodsCents: 100 }));
    ok("…a refused code whose second look fails keeps the refusal's own reason (not \"not ready\")", probed === 1 && same(r, { error: "This code has expired." }));

    const plan = await S.resolveDiscountCodes_(DB, { codes: ["SAVE10"], orgId: "acme", email: "lee@example.com", goodsCents: 2000 });
    r = await withSql((sql) => /SELECT codeId FROM discount_code_uses/.test(sql) ? stmt(null, {}) : null, () => S.claimResolvedCodes_(DB, "ACME-7001", "lee@example.com", plan));
    ok("claimResolvedCodes_: a read of the held uses that brings back no rows holds nothing, and the code is claimed for the order", r.ok === true && r.already === false &&
      q1("SELECT count(*) AS n FROM discount_code_uses WHERE orderId = 'ACME-7001' AND releasedAt IS NULL").n === 1);
    r = await withSql((sql) => { if (/SELECT codeId FROM discount_code_uses/.test(sql)) throw new Error("no such table: discount_code_uses (test)"); return null; },
      () => S.claimResolvedCodes_(DB, "ACME-7001", "lee@example.com", plan));
    ok("…and a read that fails (no discount tables yet) also holds nothing: the code again is ok, but not taken as this order's own already", r.ok === true && r.already === false &&
      q1("SELECT count(*) AS n FROM discount_code_uses WHERE orderId = 'ACME-7001'").n === 1);

    r = S.codeCheckAnswer_({});
    ok("codeCheckAnswer_: an answer with no code and nothing combined says nothing taken off and no combined total",
      same(r, { status: "ok", freeShipping: false, discount: 0, combined: null }));
    r = S.codeCheckAnswer_({ code: { id: 3, code: "TEAM5", label: "$5 off", kind: "amount" }, discount: 5, combined: { goodsOffCents: 700 } });
    ok("…a combined total with no per-code list: this code's own discount, and the together figure with no codes", r.discount === 5 && same(r.combined, { discount: 7, freeShipping: false, codes: [] }));
    r = S.codeCheckAnswer_({ code: { id: 3, code: "TEAM5" }, discount: "n/a" });
    ok("…a discount that isn't a number shows $0", r.discount === 0 && r.combined === null);

    ok("codeOthersOf_: not a list, more than allowed, or a code that isn't text answers null; blanks are dropped",
      S.codeOthersOf_("SAVE10") === null && S.codeOthersOf_(new Array(10).fill("A")) === null && S.codeOthersOf_([5]) === null && S.codeOthersOf_(["A".repeat(65)]) === null &&
      same(S.codeOthersOf_([" A ", "  "]), ["A"]) && same(S.codeOthersOf_(""), []));
    ok("giftCardSettingsInput_: no settings at all ask whether cards are sold online", same(S.giftCardSettingsInput_(null), { error: "Say whether gift cards are sold online." }));

    const gc = await card(30);
    r = await withHooks({ checkGiftCard: async () => null }, () => S.redeemOrderGiftCards_(DB, { orderId: "ACME-7001", cards: [{ code: gc.code, amountCents: 500 }], by: "test" }));
    ok("redeemOrderGiftCards_: a card check with no answer is \"That gift card number isn't right.\"", same(r, [{ ok: false, taken: 0, reason: "That gift card number isn't right." }]));
    r = await withHooks({ redeemGiftCard: async () => ({ ok: true }) }, () => S.redeemOrderGiftCards_(DB, { orderId: "ACME-7001", cards: [{ code: gc.code, amountCents: 500 }], by: "test" }));
    ok("…a spend that says ok but no figures reports $0 taken and $0 left (never NaN)", same(r, [{ ok: true, last4: gc.last4, taken: 0, balance: 0 }]));
    r = await withHooks({ redeemGiftCard: async () => ({ ok: false, error: "Card store locked (test)" }) }, () => S.redeemOrderGiftCards_(DB, { orderId: "ACME-7001", cards: [{ code: gc.code, amountCents: 500 }], by: "test" }));
    const r2 = await withHooks({ redeemGiftCard: async () => null }, () => S.redeemOrderGiftCards_(DB, { orderId: "ACME-7001", cards: [{ code: gc.code, amountCents: 500 }], by: "test" }));
    ok("…a refusal given as an error is its reason; no answer is \"That gift card can't be used now.\"",
      same(r, [{ ok: false, last4: gc.last4, taken: 0, reason: "Card store locked (test)" }]) && same(r2, [{ ok: false, last4: gc.last4, taken: 0, reason: "That gift card can't be used now." }]));
    r = S.giftCardsOf_({ giftCards: [{ code: "--" }, { code: " -- " }, { code: gc.code.toLowerCase(), amount: "" }] });
    ok("giftCardsOf_: a number that is only dashes is kept (to be refused by the check) and counted once; no amount is as much as it can",
      same(r.cards.map(c => c.code), ["--", gc.code.toLowerCase()]) && r.cards[1].amountCents === 100000000);
  }

  console.log("\n=== A quote made into an order ===");
  {
    const quote = (estimate, extra = {}) => async () => ({ estimate: { id: 901, orgId: "acme", status: "accepted", ...estimate },
      items: [{ kind: "custom", name: "Club banner", qty: 1, unitPrice: 20, lineTotal: 20, taxable: false }], customer: {}, totals: { subtotal: 20, total: 20 }, ...extra });
    const env = { DB, ...ENV };
    r = await withHooks({ getEstimate: quote({ number: "", customerId: 0 }) }, () => S.convertEstimateToOrder_(env, 901, { actor: "olive@example.com" }));
    let a = lastAudit("estimate.converted");
    ok("a quote with no codes list, no number and no customer: an order ACME-Q901 with no code", r.orderId === "ACME-Q901" && !r.error &&
      q1("SELECT discountCents FROM orders WHERE orderId = 'ACME-Q901'").discountCents === 0);
    ok("…its audit row has an empty number and no customer", a && a.orderId === "ACME-Q901" && a.d.number === "" && a.d.customerId === null && !("discountCodes" in a.d));

    r = await withHooks({ getEstimate: quote({ id: 902, number: "Q-902", discountCodes: ["SAVE10"] }, { totals: {} }) }, () => S.convertEstimateToOrder_(env, 902, {}));
    ok("a quote with a code, a customer with no email and no subtotal in its totals: the order is made and the code claimed for it",
      r.orderId === "ACME-Q902" && q1("SELECT count(*) AS n FROM discount_code_uses WHERE orderId = 'ACME-Q902' AND releasedAt IS NULL").n === 1 &&
      q1("SELECT email FROM discount_code_uses WHERE orderId = 'ACME-Q902'").email === "");

    r = await withHooks({ getEstimate: quote({ id: 903, number: "Q-903", discountCodes: ["SAVE10"] }), claimDiscountCodes: async () => null }, () => S.convertEstimateToOrder_(env, 903, {}));
    ok("a claim with no answer stops it: 409 \"A discount code on this quote has reached its limit.\" and no order",
      r.status === 409 && r.error === "A discount code on this quote has reached its limit." && !q1("SELECT 1 FROM orders WHERE orderId = 'ACME-Q903'"));
    r = await withHooks({ getEstimate: quote({ id: 904, number: "Q-904", discountCodes: ["SAVE10"] }),
      claimDiscountCodes: async () => { await newOrder("ACME-Q904"); return { ok: false, reason: "This code has reached its limit." }; } },
      () => S.convertEstimateToOrder_(env, 904, {}));
    ok("a claim lost to another conversion of the same quote that has just made the order: that order is the answer (repeated)", r.orderId === "ACME-Q904" && r.repeated === true && !r.error);

    let written = null;
    r = await withHooks({ getEstimate: quote({ id: 905, number: "Q-905", discountCodes: ["SAVE10"] }),
      planDiscountCodes: async (real, ...x) => ({ ...(await real(...x)), shippingOffCents: 700 }),
      insertOrder: async (real, db, o, ...x) => { written = JSON.parse(JSON.stringify(o.discount || null)); return real(db, o, ...x); } }, () => S.convertEstimateToOrder_(env, 905, {}));
    ok("codes that take shipping off: the order is written with the shipping discount beside the goods discount", r.orderId === "ACME-Q905" &&
      same(written, { cents: 200, note: "Code SAVE10", shippingCents: 700 }));

    logged.length = 0;
    let threw = null;
    try {
      await withHooks({ getEstimate: quote({ id: 906, number: "Q-906", discountCodes: ["SAVE10"] }), insertOrder: async () => { throw new Error("disk full (test)"); },
        releaseDiscountCodeUse: async () => { throw new Error("still full (test)"); } }, () => S.convertEstimateToOrder_(env, 906, {}));
    } catch (e) { threw = e; }
    ok("an order that can't be written, whose code can't be given back either: the write's error, and the give-back failure logged",
      threw && threw.message === "disk full (test)" && logged.some(l => /Giving back a quote's discount codes failed for ACME-Q906/.test(l)));
  }

  console.log("\n=== Can gift cards be spent? (the Gift card payment method) ===");
  {
    const gc = await card(15);
    r = await withHooks({ getGlobalSettings: async () => null }, () => shopPost({ action: "checkGiftCard", code: gc.code }));
    const rEmpty = await withHooks({ getGlobalSettings: async () => ({}) }, () => shopPost({ action: "checkGiftCard", code: gc.code }));
    ok("no global settings, or settings with no payment methods: gift cards are on", r.status === 200 && r.body.ok === true && rEmpty.status === 200 && rEmpty.body.balance === 15);
    r = await withHooks({ getGlobalSettings: async () => { throw new Error("settings unreadable (test)"); } }, () => shopPost({ action: "checkGiftCard", code: gc.code }));
    ok("settings that can't be read: the feature switch is the answer, so the card is checked", r.status === 200 && r.body.ok === true && r.body.balance === 15);
    r = await withHooks({ checkGiftCard: async () => null }, () => shopPost({ action: "checkGiftCard", code: gc.code }));
    ok("a check with no answer: ok false, \"That gift card number isn't right.\"", r.status === 200 && r.body.ok === false && r.body.reason === "That gift card number isn't right.");
  }

  console.log("\n=== The Revenue report's balance ===");
  {
    d1.q("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('accounting', ?)", JSON.stringify({ saleDate: "placed" }));
    await newOrder("ACME-8001", 30, { placedAt: "2026-04-10T15:00:00.000Z" });
    await admin({ action: "addPayment", orderId: "ACME-8001", amount: 10, method: "cash" });
    r = await admin({ action: "getRevenueReport", dateFrom: "2026-04-01", dateTo: "2026-04-30" });
    const acme = r.status === 200 && r.body.orgs.find(o => o.orgId === "acme");
    ok("an order of $30.00 with $10.00 received: the shop's balance is $20.00", acme && acme.balance === 20 && acme.received === 10);
    r = await withHooks({ getRevenueData: async (real, ...x) => [...(await real(...x)), { orgId: "acme", itemSubtotal: 5, received: 0 }] },
      () => admin({ action: "getRevenueReport", dateFrom: "2026-04-01", dateTo: "2026-04-30" }));
    const acme2 = r.status === 200 && r.body.orgs.find(o => o.orgId === "acme");
    ok("…a row with no amount owed adds nothing to it", acme2 && acme2.balance === 20 && acme2.orderCount === 2);
  }

  console.log("\n=== Payments and discounts refused by the database ===");
  {
    const coded = await sale({ discountCodes: ["SAVE10"], paymentMethod: "Check" });
    const codedId = coded.body.orderId;
    r = await admin({ action: "addPayment", orderId: codedId, amount: 1, method: "cash", discountRemainder: true });
    ok("\"waive the rest\" on an order with a code: 409 and no payment", refused(r, 409, "This order has a discount code; take the code off first.") &&
      q1("SELECT count(*) AS n FROM order_payments WHERE orderId = ?", codedId).n === 0);
    await newOrder("ACME-8002", 30);
    r = await admin({ action: "addPayment", orderId: "ACME-8002", amount: 25, method: "cash", discountRemainder: true });
    ok("…on an order with no code it is taken: $25.00 paid and the rest waived", r.status === 200 && q1("SELECT discountCents FROM orders WHERE orderId = 'ACME-8002'").discountCents === 500);
    const pid = q1("SELECT id FROM order_payments WHERE orderId = 'ACME-8002'").id;
    r = await withHooks({ voidPayment: async () => ({ error: "That entry is locked (test)." }) }, () => admin({ action: "voidPayment", orderId: "ACME-8002", paymentId: pid }));
    ok("voidPayment refused by the database: 409 with its reason, and the payment stands", refused(r, 409, "That entry is locked (test).") &&
      q1("SELECT voidedAt FROM order_payments WHERE id = ?", pid).voidedAt === null);
    await newOrder("ACME-8003", 30);
    r = await withHooks({ setOrderDiscount: async () => ({ error: "That order is locked (test)." }) }, () => admin({ action: "setDiscount", orderId: "ACME-8003", amount: 5 }));
    ok("setDiscount refused by the database: 409 with its reason", refused(r, 409, "That order is locked (test).") && q1("SELECT discountCents FROM orders WHERE orderId = 'ACME-8003'").discountCents === 0);
  }

  console.log("\n=== Checking a code (the Local sale window and the storefront) ===");
  {
    const lsc = (extra) => admin({ action: "checkLocalSaleCode", code: "SAVE10", subtotal: 100, ...extra });
    ok("Local sale: others that aren't a list of codes: 400 \"Those codes aren't valid.\"", refused(await lsc({ others: "TEAM5" }), 400, "Those codes aren't valid."));
    r = await lsc({ shipping: "" });
    const r5 = await lsc({ shipping: 5 });
    ok("…no shipping (blank) and a $5.00 charge are both checked: 10% of $100.00 is $10.00", r.status === 200 && r.body.ok === true && r.body.discount === 10 && r5.status === 200 && r5.body.discount === 10);
    ok("…a shipping charge below $0 or over $10,000: 400", refused(await lsc({ shipping: -1 }), 400, "The shipping charge must be between $0 and $10,000.") &&
      refused(await lsc({ shipping: 10001 }), 400, "The shipping charge must be between $0 and $10,000."));
    r = await admin({ action: "createProduct", productId: "mug", type: "other", name: "Club Mug", pricingMode: "flat", flatPrice: 10, visible: true, weightOz: 10, noDesignNeeded: true });
    ok("(the shop's $10.00 mug)", r.status === 200);
    const sfc = (extra) => shopPost({ action: "checkDiscountCode", orgId: "acme", code: "SAVE10", email: "pat@example.com", items: [{ productId: "mug", qty: 2 }], ...extra });
    ok("storefront: others that aren't a list of codes: 400 \"Those codes aren't valid.\"", refused(await sfc({ others: [7] }), 400, "Those codes aren't valid."));
    r = await sfc({ shipping: "" });
    const s5 = await sfc({ shipping: 5 });
    ok("…no shipping (blank) and $5.00: 10% of the $20.00 cart is $2.00", r.status === 200 && r.body.discount === 2 && s5.status === 200 && s5.body.discount === 2);
    ok("…a shipping charge that isn't one: 400 \"The shipping charge isn't valid.\"", refused(await sfc({ shipping: "lots" }), 400, "The shipping charge isn't valid."));
  }

  console.log("\n=== A Local sale's codes and cards ===");
  {
    r = await withHooks({ priceItem: async (real, ...x) => ({ ...(await real(...x)), name: "", type: "" }) },
      () => sale({ items: [{ productId: "mug", qty: 1, customUnitPrice: 8, name: "Typed mug" }] }));
    const line = r.status === 200 && q1("SELECT name, type FROM order_items WHERE orderId = ?", r.body.orderId);
    ok("a catalog line whose catalog has no name or type keeps the name typed, and no type", line && line.name === "Typed mug" && line.type === "");
    r = await withHooks({ planDiscountCodes: async () => ({ ok: false, code: "SAVE10", reason: "x" }), checkDiscountCode: async () => ({ ok: false, notReady: true }) },
      () => sale({ discountCodes: ["SAVE10"] }));
    ok("codes on a database from before discount codes: 503 \"Discount codes need the latest database update…\"", refused(r, 503, "Discount codes need the latest database update. Apply the migrations, then try again."));
    const before = q1("SELECT count(*) AS n FROM orders").n;
    r = await withHooks({ claimDiscountCodes: async () => null }, () => sale({ discountCodes: ["SAVE10"] }));
    ok("a claim with no answer: 400 \"This code has reached its limit.\" and no sale", refused(r, 400, "This code has reached its limit.") && q1("SELECT count(*) AS n FROM orders").n === before);
    const rid = "req397race1";
    r = await withHooks({ claimDiscountCodes: async (real, db, args) => { await newOrder(args.orderId, 100); return { ok: false, reason: "This code has reached its limit." }; } },
      () => admin({ action: "createLocalSale", requestId: rid, items: tee(), paymentMethod: "Cash", discountCodes: ["SAVE10"] }));
    ok("a claim lost to the same sale sent twice at once, whose order is now there: answered as that sale (repeated)", r.status === 200 && r.body.repeated === true && !!r.body.orderId);
    const gc = await card(50);
    globalThis.__actor397 = "";
    try { r = await sale({ giftCards: [{ code: gc.code, amount: 30 }] }); } finally { delete globalThis.__actor397; }
    ok("a card spent on a sale by someone with no name on record: taken, and the card's ledger row names nobody",
      r.status === 200 && r.body.giftCards[0].ok === true && r.body.giftCards[0].taken === 30 && q1("SELECT by FROM gift_card_ledger WHERE cardId = ? AND kind = 'redeem'", gc.id).by === "");
  }

  console.log("\n=== Quotes: saving and sending when the reader leaves the codes out ===");
  {
    const c = await admin({ action: "createEstimate", customerId: 1, title: "Example quote", expiresOn: "2099-12-31" });
    const id = c.body.id;
    r = await admin({ action: "saveEstimate", id, items: [{ kind: "custom", name: "Club banner", qty: 1, unitPrice: 0, taxable: false }] });
    ok("(a quote with one $0.00 line)", r.status === 200);
    const noCodes = { getEstimate: async (real, ...x) => { const g = await real(...x); if (g && g.estimate) delete g.estimate.discountCodes; return g; } };
    r = await withHooks(noCodes, () => admin({ action: "saveEstimate", id, discountCodes: ["SAVE10"] }));
    ok("a code saved on a quote whose reader gives no codes list: taken as a change, and saved", r.status === 200 && q1("SELECT discountCodes FROM estimates WHERE id = ?", id).discountCodes === '["SAVE10"]');
    r = await withHooks({ getEstimate: async (real, ...x) => { const g = await real(...x); if (g) { g.totals = undefined; } return g; } }, () => admin({ action: "sendEstimate", id }));
    ok("sending it with no totals to read: the code is checked against $0.00 of goods and the quote goes", r.status === 200 && r.body.status === "ok");
    d1._raw.run("UPDATE estimates SET discountCodes = '[\"BIGMIN\"]' WHERE id = ?", [id]);
    r = await withHooks(noCodes, () => admin({ action: "sendEstimate", id }));
    ok("…and with no codes list on it, nothing is checked (a code it couldn't meet doesn't stop it)", r.status === 200 && r.body.status === "ok");
    r = await admin({ action: "sendEstimate", id });
    ok("…while read as it is, that code stops the send with its reason", refused(r, 409) && /at least \$1,?000\.00/.test(r.body.message));
  }

  console.log("\n=== Codes on an order, and Reorder ===");
  {
    await newOrder("ACME-8100", 40); await newOrder("ACME-8101", 40); await newOrder("ACME-8102", 40);
    const dropCodes = (o) => { if (o) delete o.discountCodes; return o; };
    r = await withHooks({ getOrderById: async (real, ...x) => dropCodes(await real(...x)) }, () => admin({ action: "applyOrderDiscountCode", orderId: "ACME-8100", code: "SAVE10" }));
    const a = lastAudit("order.discount_code_applied");
    ok("a code applied while the order reader gives no codes list: applied, the answer's list is empty and the audit row's too",
      r.status === 200 && r.body.discountAmount === 4 && same(r.body.discountCodes, []) && a && same(a.d.codes, []));
    r = await withHooks({ getOrderById: async (real, ...x) => { const o = await real(...x); if (o) { const c = o.shippingDiscount; delete o.shippingDiscount; o.shippingDiscountCents = Math.round((c || 0) * 100) + 250; } return o; } },
      () => admin({ action: "applyOrderDiscountCode", orderId: "ACME-8101", code: "SAVE10" }));
    ok("an order read with its shipping discount in cents only: the answer gives it in dollars", r.status === 200 && r.body.shippingDiscount === 2.5);
    r = await withHooks({ getOrderById: async (real, ...x) => { const o = await real(...x); if (o) delete o.shippingDiscount; return o; } },
      () => admin({ action: "applyOrderDiscountCode", orderId: "ACME-8102", code: "SAVE10" }));
    ok("…and with no shipping discount at all, none in the answer", r.status === 200 && !("shippingDiscount" in r.body));
    r = await withHooks({ removeOrderDiscountCode: async () => ({ ok: false, error: "The order can't take a code now (test)." }) },
      () => admin({ action: "removeOrderDiscountCode", orderId: "ACME-8100", code: "SAVE10" }));
    ok("taking it off refused with an error: its sentence, 409 when it says the order can't take a code now", refused(r, 409, "The order can't take a code now (test)."));
    r = await withHooks({ removeOrderDiscountCode: async () => null }, () => admin({ action: "removeOrderDiscountCode", orderId: "ACME-8100", code: "SAVE10" }));
    ok("…no answer: 400 \"Couldn't change the codes on this order. Try again.\"", refused(r, 400, "Couldn't change the codes on this order. Try again."));
    d1._raw.exec("CREATE TRIGGER no_audit_397 BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit log unavailable'); END;");
    try { r = await admin({ action: "removeOrderDiscountCode", orderId: "ACME-8100", code: "SAVE10" }); } finally { d1._raw.exec("DROP TRIGGER no_audit_397;"); }
    ok("taking it off while the audit log can't be written: 503 and the code stays", refused(r, 503) && q1("SELECT discountCents FROM orders WHERE orderId = 'ACME-8100'").discountCents === 400);
    globalThis.__actor397 = "";
    try {
      r = await withHooks({ getOrderById: async (real, ...x) => { const o = await real(...x); if (o) { delete o.discountCodes; o.discountCode = "SAVE10"; } return o; } },
        () => admin({ action: "removeOrderDiscountCode", orderId: "ACME-8100", code: "save10" }));
    } finally { delete globalThis.__actor397; }
    ok("an order read with only its joined code (no list) and no one named: the code is found and taken off", r.status === 200 && r.body.discountAmount === 0 &&
      q1("SELECT discountCents FROM orders WHERE orderId = 'ACME-8100'").discountCents === 0);
    r = await withHooks({ orderForReorder_: async () => ({ orgId: "acme", error: "That order can't be read now (test)." }) }, () => admin({ action: "getOrderForReorder", orderId: "ACME-8100" }));
    ok("Reorder when the order can't be copied: 409 with the reason", refused(r, 409, "That order can't be read now (test)."));
  }

  console.log("\n=== The Gift cards page ===");
  {
    const gc = await card(40, { recipientEmail: "sam@example.com" });
    r = await withHooks({ listGiftCards: async () => [{ id: 1 }, { id: 2 }] }, () => admin({ action: "listGiftCards" }));
    ok("a list read that answers a plain array: those cards, and their count as the total", r.status === 200 && r.body.cards.length === 2 && r.body.total === 2);
    r = await withHooks({ listGiftCards: async () => ({}) }, () => admin({ action: "listGiftCards" }));
    ok("…one that answers nothing usable: no cards, total 0", r.status === 200 && same(r.body.cards, []) && r.body.total === 0);
    r = await withHooks({ revealGiftCardCode: async () => ({ code: gc.code }) }, () => admin({ action: "revealGiftCardCode", id: gc.id }));
    ok("Show, with the number read back as an object: the number in groups", r.status === 200 && r.body.code === gc.code.replace(/(.{4})(?=.)/g, "$1-"));
    r = await withHooks({ revealGiftCardCode: async () => null }, () => admin({ action: "revealGiftCardCode", id: gc.id }));
    ok("…with no number to read: 404 \"Gift card not found\"", refused(r, 404, "Gift card not found"));
    r = await withHooks({ revealGiftCardCode: async () => "--" }, () => admin({ action: "revealGiftCardCode", id: gc.id }));
    ok("…a stored number that isn't one is shown as it is", r.status === 200 && r.body.code === "--");

    r = await withHooks({ issueGiftCard: async () => null }, () => admin({ action: "issueGiftCard", amountCents: 1000 }));
    ok("Issue with no answer from the database: 400 \"Couldn't make the gift card. Try again.\"", refused(r, 400, "Couldn't make the gift card. Try again."));
    r = await withHooks({ issueGiftCard: async (real, ...x) => { const m = await real(...x); delete m.code; return m; } }, () => admin({ action: "issueGiftCard", amountCents: 1000 }));
    ok("Issue whose number doesn't come back: the card, and an empty number (never \"undefined\")", r.status === 200 && r.body.card && r.body.code === "");
    globalThis.__actor397 = "";
    try { r = await admin({ action: "issueGiftCard", amountCents: 1200, recipientEmail: "lee@example.com", sendEmail: true }); } finally { delete globalThis.__actor397; }
    ok("Issue by someone with no name on record: made, by nobody", r.status === 200 && q1("SELECT createdBy FROM gift_cards WHERE id = ?", r.body.card.id).createdBy === "");
    mail.length = 0;
    r = await withHooks({ getBusinessProfile: () => Promise.reject(new Error("profile unreadable (test)")) },
      () => admin({ action: "issueGiftCard", amountCents: 1300, recipientEmail: "lee@example.com", sendEmail: true }));
    ok("…with the Business profile unreadable: still emailed", r.status === 200 && r.body.emailSent === true && mail.length === 1);
    logged.length = 0;
    r = await withHooks({ sendGiftCardEmail: async () => { throw new Error("mail broke (test)"); } },
      () => admin({ action: "issueGiftCard", amountCents: 1400, recipientEmail: "lee@example.com", sendEmail: true }));
    ok("…with the email failing outright: the card is made, emailSent false, and the failure logged", r.status === 200 && r.body.emailSent === false && logged.some(l => /Emailing a gift card failed for card/.test(l)));

    // A card sold online names its shop in the email.
    await newOrder("ACME-GC-EXAMPLE1", 25);
    const sold = await card(25, { sourceOrderId: "ACME-GC-EXAMPLE1", recipientEmail: "kim@example.com" });
    mail.length = 0;
    r = await admin({ action: "resendGiftCard", id: sold.id });
    ok("Resend of a card sold online: sent, and the email names the shop that sold it", r.status === 200 && r.body.emailSent === true && mail.length === 1 && /Example Club/.test(JSON.stringify(mail[0])));
    mail.length = 0;
    r = await withSql((sql) => /SELECT g\.name FROM orders o JOIN orgs g/.test(sql) ? stmt(() => Promise.reject(new Error("read failed (test)"))) : null,
      () => admin({ action: "resendGiftCard", id: sold.id }));
    ok("…with the shop's name unreadable: still sent", r.status === 200 && r.body.emailSent === true && mail.length === 1);
    r = await withHooks({ revealGiftCardCode: async () => ({ code: sold.code }) }, () => admin({ action: "resendGiftCard", id: sold.id }));
    ok("…with the number read back as an object: sent", r.status === 200 && r.body.emailSent === true);
    r = await withHooks({ revealGiftCardCode: async () => "" }, () => admin({ action: "resendGiftCard", id: sold.id }));
    ok("…with no number to read: 404 \"Gift card not found\"", refused(r, 404, "Gift card not found"));

    ok("Adjust with no note: 400 \"Say why the balance is changing.\"", refused(await admin({ action: "adjustGiftCard", id: gc.id, deltaCents: 500 }), 400, "Say why the balance is changing."));
    r = await withHooks({ adjustGiftCard: async () => ({ ok: false, reason: "The card changed (test)." }) }, () => admin({ action: "adjustGiftCard", id: gc.id, deltaCents: 500, note: "Goodwill" }));
    ok("Adjust refused by the database: 409 with its reason", refused(r, 409, "The card changed (test)."));
    r = await withHooks({ adjustGiftCard: async () => ({ ok: false, error: "Card store locked (test)" }) }, () => admin({ action: "adjustGiftCard", id: gc.id, deltaCents: 500, note: "Goodwill" }));
    const rAdjNone = await withHooks({ adjustGiftCard: async () => null }, () => admin({ action: "adjustGiftCard", id: gc.id, deltaCents: 500, note: "Goodwill" }));
    ok("…refused with an error: its reason; no answer: \"Couldn't change the balance. Try again.\"", refused(r, 409, "Card store locked (test)") &&
      refused(rAdjNone, 409, "Couldn't change the balance. Try again.") && q1("SELECT balanceCents FROM gift_cards WHERE id = ?", gc.id).balanceCents === 4000);
    let reads = 0;
    r = await withHooks({ getGiftCard: async (real, ...x) => (++reads === 2 ? null : real(...x)) }, () => admin({ action: "adjustGiftCard", id: gc.id, deltaCents: 500, note: "Goodwill" }));
    ok("Adjust whose card can't be read back afterwards: ok with nothing more, and the balance moved", r.status === 200 && same(r.body, { status: "ok" }) &&
      q1("SELECT balanceCents FROM gift_cards WHERE id = ?", gc.id).balanceCents === 4500);
    ok("Void with no note: 400 \"Say why the card is being voided.\"", refused(await admin({ action: "voidGiftCard", id: gc.id }), 400, "Say why the card is being voided."));
    r = await withHooks({ voidGiftCard: async () => ({ ok: false, reason: "The card changed (test)." }) }, () => admin({ action: "voidGiftCard", id: gc.id, note: "Lost" }));
    const rVoidErr = await withHooks({ voidGiftCard: async () => ({ error: "Card store locked (test)" }) }, () => admin({ action: "voidGiftCard", id: gc.id, note: "Lost" }));
    ok("Void refused by the database: 409 with its reason, given as a reason or as an error", refused(r, 409, "The card changed (test).") && refused(rVoidErr, 409, "Card store locked (test)"));
    r = await withHooks({ voidGiftCard: async () => null }, () => admin({ action: "voidGiftCard", id: gc.id, note: "Lost" }));
    ok("Void with no answer: 409 \"Couldn't void the card. Try again.\" and the card stays active", refused(r, 409, "Couldn't void the card. Try again.") &&
      q1("SELECT status FROM gift_cards WHERE id = ?", gc.id).status === "active");

    r = await admin({ action: "giftCardTotals", dateFrom: "0000-01-01", dateTo: "2099-12-31" });
    ok("Totals from the first day there is: answered (no lower limit), not a server error", r.status === 200 && r.body.status === "ok" && r.body.totals.sold > 0);

    // Spending a card on an order (the payment form).
    await newOrder("ACME-8200", 30);
    const spend = (extra) => admin({ action: "redeemGiftCard", orderId: "ACME-8200", code: gc.code, ...extra });
    r = await withHooks({ checkGiftCard: async () => null }, () => spend({}));
    ok("redeemGiftCard with no answer from the card check: 400 \"That gift card number isn't right.\"", refused(r, 400, "That gift card number isn't right."));
    r = await withHooks({ redeemGiftCard: async () => ({ ok: false, error: "Card store locked (test)" }) }, () => spend({}));
    const rNone = await withHooks({ redeemGiftCard: async () => null }, () => spend({}));
    ok("…a spend refused with an error is its reason; no answer is \"That gift card can't be used now.\"", refused(r, 400, "Card store locked (test)") &&
      refused(rNone, 400, "That gift card can't be used now."));
    r = await withHooks({ redeemGiftCard: async (real, ...x) => { await real(...x); return { ok: false, reason: "This gift card doesn't have enough left." }; } },
      () => spend({ amount: 5, requestId: "req397spend1" }));
    ok("…a refusal for a Save the first try already booked: answered as that payment (duplicate), one payment", r.status === 200 && r.body.duplicate === true &&
      q1("SELECT count(*) AS n FROM order_payments WHERE orderId = 'ACME-8200' AND voidedAt IS NULL").n === 1);
    r = await withHooks({ redeemGiftCard: async (real, ...x) => { const t = await real(...x); delete t.takenCents; delete t.balanceCents; return t; } }, () => spend({ amount: 5 }));
    const pa = lastAudit("payment.added");
    ok("…a spend whose figures don't come back: answered $0 taken and $0 left (never NaN), audited at $0", r.status === 200 && r.body.taken === 0 && r.body.cardBalance === 0 && pa.d.amount === 0);

    // Putting money back on a card.
    const gp = q1("SELECT id FROM order_payments WHERE orderId = 'ACME-8200' AND giftCardId IS NOT NULL AND voidedAt IS NULL");
    r = await withHooks({ getOrderPaymentById: async (real, ...x) => ({ ...(await real(...x)), orderId: "ACME-0404" }) }, () => admin({ action: "refundToGiftCard", paymentId: gp.id, amount: 1 }));
    ok("refundToGiftCard for a payment whose order is gone: 404 \"Order not found\"", refused(r, 404, "Order not found"));
    r = await withHooks({ refundToGiftCard: async () => ({ ok: false, error: "Card store locked (test)" }) }, () => admin({ action: "refundToGiftCard", paymentId: gp.id, amount: 1 }));
    const rNo = await withHooks({ refundToGiftCard: async () => null }, () => admin({ action: "refundToGiftCard", paymentId: gp.id, amount: 1 }));
    ok("…refused with an error: 409 and its reason; no answer: \"Couldn't put the money back on the card. Try again.\"", refused(r, 409, "Card store locked (test)") &&
      refused(rNo, 409, "Couldn't put the money back on the card. Try again."));
  }

  console.log("\n=== The two settings, and their Global settings sections ===");
  {
    const userFacing = (m) => Object.assign(new Error(m), { userFacing: true });
    r = await withHooks({ setDiscountRules: async () => { throw userFacing("Not now (test)."); } }, () => admin({ action: "updateDiscountRules", multiple: true }));
    ok("updateDiscountRules refused by the database with a sentence: 400 with it", refused(r, 400, "Not now (test)."));
    let threw = null;
    try { await withHooks({ setDiscountRules: async () => { throw new Error("disk full (test)"); } }, () => admin({ action: "updateDiscountRules", multiple: true })); } catch (e) { threw = e; }
    ok("…any other failure is the server's error (not a quiet ok)", threw && threw.message === "disk full (test)");
    logged.length = 0;
    r = await withHooks({ bumpCatalogVersion: async () => { throw new Error("version table locked (test)"); } }, () => admin({ action: "updateDiscountRules", multiple: true }));
    ok("…saved even when the catalog's version can't move, which is logged", r.status === 200 && r.body.discountRules.multiple === true && logged.some(l => /catalog version bump failed/.test(l)));
    const GC = { sellOnline: true, amounts: [2500, 5000], minCents: 500, maxCents: 50000 };
    r = await withHooks({ setGiftCardSettings: async () => { throw userFacing("Not now (test)."); } }, () => admin({ action: "updateGiftCardSettings", ...GC }));
    ok("updateGiftCardSettings refused by the database with a sentence: 400 with it", refused(r, 400, "Not now (test)."));
    threw = null;
    try { await withHooks({ setGiftCardSettings: async () => { throw new Error("disk full (test)"); } }, () => admin({ action: "updateGiftCardSettings", ...GC })); } catch (e) { threw = e; }
    ok("…any other failure is the server's error", threw && threw.message === "disk full (test)");
    logged.length = 0;
    r = await withHooks({ bumpCatalogVersion: async () => { throw new Error("version table locked (test)"); } }, () => admin({ action: "updateGiftCardSettings", ...GC }));
    ok("…saved even when the catalog's version can't move, which is logged", r.status === 200 && r.body.giftCards.sellOnline === true && logged.some(l => /catalog version bump failed/.test(l)));
    r = await withHooks({ buildDiscountRules: async () => { throw userFacing("Rules locked (test)."); } }, () => admin({ action: "saveGlobalSettingsAll", settings: { discountRules: { multiple: false } } }));
    ok("Global settings → Save, the Discount codes section refused by its build: 400 naming the section, nothing saved", refused(r, 400, "Rules locked (test).") && !!r.body.section &&
      JSON.parse(q1("SELECT value FROM global_settings WHERE key = 'discountRules'").value).multiple === true);
    r = await withHooks({ buildGiftCardSettings: async () => { throw userFacing("Cards locked (test)."); } }, () => admin({ action: "saveGlobalSettingsAll", settings: { giftCards: { ...GC, sellOnline: false } } }));
    ok("…the Gift cards section refused by its build: 400 naming the section, nothing saved", refused(r, 400, "Cards locked (test).") && !!r.body.section &&
      JSON.parse(q1("SELECT value FROM global_settings WHERE key = 'giftCards'").value).sellOnline === true);
  }

  console.log("\n=== Buying a gift card online ===");
  {
    const buy = (body, opts) => shopPost({ action: "buyGiftCard", amountCents: 5000, recipientName: "Sam Example", recipientEmail: "sam@example.com",
      buyerName: "Pat Example", buyerEmail: "pat@example.com", message: "Happy birthday!", ...body }, opts);
    r = await withHooks({ getGlobalSettings: async () => ({}) }, () => buy({ requestId: "req397buy01" }));
    ok("global settings with no payment methods: card payments stay on and the order is made", r.status === 200 && r.body.giftCard === true && r.body.orderId === "ACME-GC-REQ397BUY01");
    r = await withHooks({ getGlobalSettings: async () => { throw new Error("settings unreadable (test)"); } }, () => buy({ requestId: "req397buy02" }));
    ok("…settings that can't be read: the same", r.status === 200 && r.body.orderId === "ACME-GC-REQ397BUY02");
    const odd = { getGiftCardSettings: async () => ({ sellOnline: true, amounts: null, minCents: 500, maxCents: 50000 }) };
    r = await withHooks(odd, () => buy({ requestId: "req397buy03", amountCents: 1234 }));
    const rLow = await withHooks(odd, () => buy({ requestId: "req397buy04", amountCents: 100 }));
    ok("settings with no amount buttons: an amount within $5 to $500 is sold, one below is refused", r.status === 200 && r.body.total === 12.34 &&
      refused(rLow, 400, "Pick an amount from $5 to $500."));
    ok("no recipient name (null): 400 \"Enter who the gift card is for.\"", refused(await buy({ requestId: "req397buy05", recipientName: null }), 400, "Enter who the gift card is for."));
    r = await buy({ requestId: "req397buy06", message: null });
    const line = r.status === 200 && q1("SELECT configJson FROM order_items WHERE orderId = ?", r.body.orderId);
    ok("no message (null): sold, with an empty message on the card", line && JSON.parse(line.configJson).giftCard.message === "");
    r = await withHooks({ emailCanSend: async () => { throw new Error("mail settings unreadable (test)"); } }, () => buy({ requestId: "req397buy07" }));
    ok("whether email can go can't be read: sold, and the page still promises the email", r.status === 200 && r.body.emailOn === true);
    r = await withSql((sql) => /SELECT orgId, contact, voidedAt FROM orders WHERE orderId/.test(sql) ? stmt({ orgId: "acme", contact: null, voidedAt: null }) : null,
      () => buy({ requestId: "req397buy08" }));
    ok("an order already under that number with no email on it: 409 \"This order has already been received.\"", refused(r, 409, "This order has already been received."));
    let threw = null;
    try { await withHooks({ insertOrder: async () => { throw new Error("disk full (test)"); } }, () => buy({ requestId: "req397buy09" })); } catch (e) { threw = e; }
    ok("an order that can't be written for another reason: the server's error, no order", threw && threw.message === "disk full (test)" && !q1("SELECT 1 FROM orders WHERE orderId = 'ACME-GC-REQ397BUY09'"));
    r = await withHooks({ getOrderById: async (real, db, id, ...x) => { if (/-GC-REQ397BUY10/.test(id)) throw new Error("read failed (test)"); return real(db, id, ...x); } },
      () => buy({ requestId: "req397buy10" }));
    ok("the order can't be read back for its email: sold, and no \"order received\" email is stamped", r.status === 200 &&
      q1("SELECT receivedEmailAt FROM orders WHERE orderId = 'ACME-GC-REQ397BUY10'").receivedEmailAt === null);
    logged.length = 0;
    r = await withHooks({ sendOrderReceivedEmail: async () => { throw new Error("mail broke (test)"); } }, () => buy({ requestId: "req397buy11" }));
    ok("the \"order received\" email failing outright: sold, and the failure logged", r.status === 200 && logged.some(l => /Order-received email failed for ACME-GC-REQ397BUY11/.test(l)));
    // A shop whose id has no letters or digits (the order number starts ORD-GC-), bought from the local address.
    d1._raw.exec("INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready, shippingEnabled) VALUES ('__','under','Example League','t','t',1,0);");
    r = await call("http://localhost:8788/api/orders", { action: "buyGiftCard", orgId: "__", amountCents: 5000, recipientName: "Sam Example", recipientEmail: "sam@example.com",
      buyerName: "Pat Example", buyerEmail: "pat@example.com", requestId: "req397buy13" });
    ok("a shop whose id has no letters or digits: its gift card order is ORD-GC-…", r.status === 200 && r.body.orderId === "ORD-GC-REQ397BUY13" && r.body.orgId === "__");
    mail.length = 0;
    r = await buy({ requestId: "req397buy12" }, { noWait: true });
    ok("a host with nothing to wait on: the \"order received\" email is sent before the answer", r.status === 200 && mail.length === 1 &&
      !!q1("SELECT receivedEmailAt FROM orders WHERE orderId = 'ACME-GC-REQ397BUY12'").receivedEmailAt);
  }

  console.log("\n=== A storefront order with codes and cards, when the database answers oddly ===");
  {
    const MUG = (qty) => [{ productId: "mug", qty }];
    let k = 0;
    const order = (extra = {}) => { const orderId = extra.orderId || "WEB-397-" + (++k);
      return shopPost({ orderId, orgId: "acme", customerName: "Pat Example", contact: "pat@example.com", paymentMethod: "Check", items: MUG(2), ...extra }).then(x => ({ orderId, ...x })); };
    const first = await order({ discountCode: "SAVE10" });
    r = await withHooks({ getOrderById: async (real, ...x) => { const o = await real(...x); if (o) delete o.discountCodes; return o; } }, () => order({ orderId: first.orderId, discountCode: "SAVE10" }));
    ok("the same order again, read with no codes list: the repeat's answer has the code and an empty list", r.status === 200 && r.body.duplicate === true &&
      r.body.discountCode === "SAVE10" && same(r.body.discountCodes, []));

    r = await withHooks({ insertOrder: async () => { throw new Error("UNIQUE constraint failed: orders.orderId"); } },
      () => withSql((sql) => /SELECT shippingDiscountCents FROM orders WHERE orderId/.test(sql) ? stmt(() => Promise.reject(new Error("no such column (test)"))) : null,
        () => order({ orderId: "WEB-397-RACE", discountCode: "SAVE10" })));
    ok("a write refused as a repeat when no order is there (and the shipping discount can't be read): 409, and the code's use is given back",
      refused(r, 409, "This order has already been received.") &&
      q1("SELECT count(*) AS n FROM discount_code_uses WHERE orderId = 'WEB-397-RACE' AND releasedAt IS NULL").n === 0);

    r = await withHooks({ insertOrder: async (real, ...x) => { await real(...x); return {}; } }, () => order({ discountCode: "SAVE10" }));
    ok("an order written with no figures coming back: the answer works them out (10% of $20.00 off: $2.00, $18.00 to pay)",
      r.status === 200 && r.body.discount === 2 && r.body.total === 18 && r.body.owed === 18 && same(r.body.discountCodes, ["SAVE10"]));

    const gc = await card(10);
    let armed = false;
    r = await withHooks({
      redeemGiftCard: async (real, ...x) => { const t = await real(...x); armed = true; return t; },
      getOrderById: async (real, ...x) => { if (armed) { armed = false; throw new Error("read failed (test)"); } return real(...x); },
    }, () => order({ giftCards: [{ code: gc.code }] }));
    ok("a card spent but the order can't be read back: the card's result, with no owed or paid figures made up", r.status === 200 && r.body.giftCards[0].ok === true &&
      r.body.giftCards[0].taken === 10 && !("owed" in r.body) && !("paid" in r.body));
  }

  console.log("\n=== The catalog's checkout rules ===");
  {
    await S.publishShop(d1, "acme");
    const store = new Map();
    global.caches = { default: { async match(key) { const h = store.get(typeof key === "string" ? key : key.url); return h ? h.clone() : undefined; },
      async put(key, res) { store.set(typeof key === "string" ? key : key.url, res); } } };
    const cat = async (db = d1) => { C._resetCatalogCacheState(); store.clear();
      const res = await C.catalogGet({ request: { url: shopOrigin("acme") + "/api/catalog", headers: { get: () => null } }, env: { DB: db, STRIPE_SECRET_KEY: "sk_test_example" } });
      return JSON.parse(await res.text()).catalog || {}; };
    let k = await cat();
    ok("(the shop as published: several codes allowed, cards spendable)", k.discountRules && k.discountRules.multiple === true && k.giftCardPay === true);
    const noRows = Object.create(d1);
    noRows.prepare = (sql) => /key IN \('discountRules', 'giftCards'\)/.test(sql) ? stmt(null, {}) : d1.prepare(sql);
    k = await cat(noRows);
    ok("a rules read that brings back no rows: one code at a time and nothing sold online", k.discountRules.multiple === false && k.giftCards.sellOnline === false);
    k = await withHooks({ getCatalogData: async (real, ...x) => { const c = await real(...x); delete c.globalSettings; return c; },
      getCatalogShop: async (real, ...x) => { const o = await real(...x); if (o) delete o.enabledPayments; return o; } }, () => cat());
    ok("no global settings and a shop with no payment methods: gift cards can be spent", k.giftCardPay === true);
    k = await withHooks({ getCatalogData: async (real, ...x) => { const c = await real(...x); c.globalSettings = {}; return c; } }, () => cat());
    ok("…global settings with no payment methods: the same", k.giftCardPay === true);
  }
})().catch((e) => { console.error = (...a) => process.stderr.write(a.join(" ") + "\n"); console.error(e && e.stack || e); process.exitCode = 1; });
