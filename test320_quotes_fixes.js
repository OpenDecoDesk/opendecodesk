const fs = require("fs");
const { ok } = require("./testlib/check");
const { createD1 } = require("./testlib/d1-shim.js");
const { MAIL_ENV, MAIL_OK, captureMail } = require("./testlib/mail-mock");
const { ADMIN_ORIGIN, shopOrigin } = require("./testlib/hosts.js");

// Quotes and quantity breaks (migrations/0109): the fixes made after phase 2's tests found these.
//   1. The order a sent quote becomes carries the quote's FROZEN tax (its rate and mode, the exemptions as they were
//      when it was sent), so it and its invoice come to exactly the total the customer accepted — staff's Convert to
//      order and the customer's Accept alike (orders.js convertEstimateToOrder_, db.js insertOrder's taxRateBps).
//   2. A product's price can't go to or under one of its quantity breaks, even when the save doesn't send the breaks
//      (updateProduct checks the breaks the product has against the new prices); so no piece is sold for $0.
//   3. On a database before 0109, createProduct with breaks logs no product.qty_breaks_changed (nothing was saved).
//   4. The quote email greets the customer by the name on file.
//   5. GET /api/estimate says expired only for a quote that is still open (draft, sent, changes), as db.js does.
//   6. A refused Accept or Ask for changes answers with the quote as it is now, so the page can stop offering them.
//   8. saveEstimate: a hand-set price already on the quote doesn't need the payments permission to be sent back
//      unchanged; only a new or changed one does.
// (7 and 9, on the admin Quotes page, are checked in test318.) Real SQL (sql.js) under the real db.js, orders.js,
// email.js and estimate.js. Invented data only.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");

const mail = [];
global.fetch = async (url, init) => {
  if (captureMail(url, init, mail)) return MAIL_OK;
  throw new Error("unexpected fetch " + url);
};

// Who is signed in: the admin, unless globalThis.__perms320 gives a custom role's levels ({ fn: level }).
const signIn = `const rank320_ = (l) => l === "full" ? 3 : l === "edit" ? 2 : l === "read" ? 1 : 0;
const adminUser = () => ({ id: 1, email: "olive@example.test", name: "Olive", role: globalThis.__perms320 ? "custom" : "admin", pending: null, bootstrap: false });
const adminLevel = (request, fn) => globalThis.__perms320 ? (globalThis.__perms320[fn] || "none") : "full";
const adminCan = (request, fn, level) => rank320_(adminLevel(request, fn)) >= rank320_(level || "read");`;

const M = new Function(
  strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  strip(read("functions/_lib/db.js")) + "\n" + strip(read("functions/_lib/email.js")) + "\n" + strip(read("functions/_lib/quoteToken.js")) + "\n" +
  strip(read("functions/_lib/boxSize.js")) + "\n" + strip(read("functions/_lib/permissions.js")) + "\n" + strip(read("functions/_lib/digital.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'olive@example.test';\n" + signIn + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: { club: 'club' }, orgs: {}, features: {} });\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({});\n" +
  "const ordersMod = (function(){\n" + strip(read("functions/api/orders.js")) + "\nreturn { onRequestPost, convertEstimateToOrder_ }; })();\n" +
  "const convertEstimateToOrder_ = ordersMod.convertEstimateToOrder_;\n" +
  "const estimateApi = (function(){\n" + strip(read("functions/api/estimate.js")) + "\nreturn { onRequestGet, onRequestPost }; })();\n" +
  "return { ordersApi: ordersMod.onRequestPost, estimateApi, getEstimate, getOrderById, setLocaleSettings };")();

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const plain = (html) => String(html || "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const migrations = fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort();
const newDb = async (before) => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of migrations) if (!before || f < before) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, accent, createdAt, updatedAt, ready, shippingEnabled) VALUES ('club','club','Example Club','#1E7A4C','t','t',1,1);`);
  return d1;
};

(async () => {
  const d1 = await newDb();
  const env = { DB: d1, SIGNING_SECRET: "s".repeat(40), ...MAIL_ENV };
  await M.setLocaleSettings(d1, { timeZone: "America/Chicago" });
  const setTax = (rateBps, taxMode) => d1._raw.run("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('salesTax', ?)", [JSON.stringify({ rateBps, taxShipping: false, jurisdiction: "", taxMode })]);
  setTax(725, "exclusive");

  const callIn = (e) => async (url, body) => {
    const waits = [];
    const res = await M.ordersApi({ env: e, waitUntil: (p) => waits.push(Promise.resolve(p).catch(() => {})),
      request: { url, json: async () => body, headers: { get: () => null } } });
    await Promise.all(waits);
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const call = callIn(env);
  const admin = (body) => call(ADMIN_ORIGIN + "/api/orders", Object.assign({ key: "x" }, body));
  let webN = 0;
  const shopOrder = (items) => { const orderId = "WEB-320-" + (++webN);
    return call(shopOrigin("club") + "/api/orders", { orderId, orgId: "club", customerName: "Pat Example", contact: "pat@example.com", paymentMethod: "Check", items }).then(r => ({ orderId, ...r })); };
  let ipN = 0;
  const estCtx = (request, e) => { const waits = []; return { c: { env: e || env, request, waitUntil: (p) => waits.push(Promise.resolve(p)) }, waits }; };
  const hdrs = () => { const ip = "198.51.100." + (++ipN); return { get: (k) => (/cf-connecting-ip/i.test(k) ? ip : null) }; };
  const get = async (token) => {
    const { c, waits } = estCtx({ url: "https://club.example.com/api/estimate?token=" + encodeURIComponent(token), headers: hdrs() });
    const res = await M.estimateApi.onRequestGet(c); await Promise.all(waits);
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const post = async (body, e) => {
    const { c, waits } = estCtx({ url: "https://club.example.com/api/estimate", headers: hdrs(), json: async () => body }, e);
    const res = await M.estimateApi.onRequestPost(c); await Promise.all(waits);
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const tokenOf = (link) => (/[?&]estimate=([a-z0-9]+)$/.exec(String(link || "")) || [])[1] || "";
  const orderRow = (orderId) => d1.q("SELECT * FROM orders WHERE orderId = ?", orderId)[0] || {};
  const estRow = (id) => d1.q("SELECT * FROM estimates WHERE id = ?", id)[0] || {};
  const audits = (action) => d1.q("SELECT * FROM audit_log WHERE action = ? ORDER BY id", action);

  const pat = (await admin({ action: "saveCustomer", name: "Pat Example", company: "", email: "pat@example.com", phone: "555-0101" })).body.id;
  const boosters = (await admin({ action: "saveCustomer", name: "", company: "Example Boosters", email: "boosters@example.com", phone: "555-0102" })).body.id;
  const kim = (await admin({ action: "saveCustomer", name: "Kim Example", email: "kim@example.com", phone: "555-0103", taxExempt: true, taxExemptCertificate: "EX-1" })).body.id;
  const lee = (await admin({ action: "saveCustomer", name: "Lee Example", email: "lee@example.com", phone: "555-0104" })).body.id;
  let r = await admin({ action: "createProduct", org: "club", productId: "tee", type: "shirt", name: "Club Tee", pricingMode: "sized", sizePricing: { S: 20, M: 20, L: 22 },
    visible: true, weightOz: 6, noDesignNeeded: true, qtyBreaks: [{ minQty: 6, off: 1 }] });
  ok("the test's own data: four customers (one tax-exempt) and a $20 tee with $1 off from 6 pieces, tax 7.25% added on top",
    r.status === 200 && [pat, boosters, kim, lee].every(Number.isInteger) && d1.q("SELECT qtyBreaksJson FROM products WHERE productId='tee'")[0].qtyBreaksJson === '[{"minQty":6,"offCents":100}]');

  // A quote made, filled and sent the way the Quotes page does it.
  const quote = async ({ customerId = pat, items, send = true, expiresOn = "2099-12-31" } = {}) => {
    const c = await admin({ action: "createEstimate", org: "club", customerId, title: "Team order", expiresOn });
    await admin({ action: "saveEstimate", id: c.body.id, items: items || [{ kind: "custom", name: "Club banner", qty: 3, unitPrice: 20, taxable: true }] });
    const s = send ? await admin({ action: "sendEstimate", id: c.body.id }) : null;
    return { id: c.body.id, number: c.body.number, token: s ? tokenOf(s.body.link) : "", send: s };
  };

  // ============================================================================================================
  console.log("=== 1. The order made from a sent quote carries the quote's tax ===");
  {
    const q = await quote();
    const frozen = (await M.getEstimate(d1, q.id)).totals;
    ok("the quote was sent at 7.25% added on top: $60.00 + $4.35 = $64.35", same(frozen, { subtotal: 60, tax: 4.35, total: 64.35, taxMode: "exclusive", taxRateBps: 725 }));
    setTax(0, "exclusive");
    r = await admin({ action: "convertEstimate", id: q.id });
    const o = await M.getOrderById(d1, r.body.orderId);
    ok("the rate is none now, but Convert to order makes the order at the quote's 7.25%: tax $4.35, total $64.35",
      r.status === 200 && orderRow(r.body.orderId).taxRateBps === 725 && orderRow(r.body.orderId).totalCents === 6435 && o.salesTax === 4.35 && o.total === 64.35);
    ok("…the order and what is owed on it (its invoice) are exactly the quote's total", o.balanceDue === frozen.total && o.effectiveTotal === frozen.total && orderRow(r.body.orderId).taxExempt === 0);
    ok("…each line taxed at that rate", d1.q("SELECT taxRateBps, taxCents FROM order_items WHERE orderId = ?", r.body.orderId).every(l => l.taxRateBps === 725 && l.taxCents === 435));

    // The customer's Accept goes through the same path: a higher rate today doesn't change the quote's total either.
    setTax(725, "inclusive");
    const q2 = await quote();
    setTax(1000, "exclusive");
    r = await post({ token: q2.token, action: "accept" });
    const o2 = await M.getOrderById(d1, r.body.orderId);
    ok("a quote sent at 7.25% in the prices, accepted when the rate is 10% on top: the order is $60.00 with $4.06 tax inside, as quoted",
      r.status === 200 && !!r.body.orderId && o2.taxMode === "inclusive" && o2.taxRate === 7.25 && o2.salesTax === 4.06 && o2.total === 60 && o2.balanceDue === 60);

    // Exemptions as they were when it was sent.
    const qk = await quote({ customerId: kim });
    ok("an exempt customer's quote is sent with no tax", (await M.getEstimate(d1, qk.id)).totals.taxRateBps === 0);
    await admin({ action: "saveCustomer", id: kim, name: "Kim Example", email: "kim@example.com", phone: "555-0103", taxExempt: false });
    r = await admin({ action: "convertEstimate", id: qk.id });
    ok("…their exemption lapsing before it is accepted doesn't add tax: the order is the quote's $60.00, no tax",
      r.status === 200 && orderRow(r.body.orderId).totalCents === 6000 && d1.q("SELECT sum(taxCents) t FROM order_items WHERE orderId = ?", r.body.orderId)[0].t === 0);
    const ql = await quote({ customerId: lee });
    await admin({ action: "saveCustomer", id: lee, name: "Lee Example", email: "lee@example.com", phone: "555-0104", taxExempt: true, taxExemptCertificate: "EX-2" });
    r = await admin({ action: "convertEstimate", id: ql.id });
    ok("…and a customer made exempt after it was sent still pays the tax they were quoted (10%: $6.00), on an order not marked exempt",
      r.status === 200 && orderRow(r.body.orderId).totalCents === 6600 && orderRow(r.body.orderId).taxExempt === 0 && orderRow(r.body.orderId).taxRateBps === 1000);
    const qk2 = await quote({ customerId: lee });
    r = await admin({ action: "convertEstimate", id: qk2.id });
    ok("an exempt customer's sent quote makes an order marked exempt, with no tax (the sales-tax report files it with exempt sales)",
      r.status === 200 && orderRow(r.body.orderId).taxExempt === 1 && orderRow(r.body.orderId).taxRateBps === 0 && orderRow(r.body.orderId).totalCents === 6000);

    // A quote still being worked on shows today's tax, and its order follows it.
    const qd = await quote({ send: false });
    setTax(500, "exclusive");
    r = await admin({ action: "convertEstimate", id: qd.id });
    ok("a draft never sent is taxed as it shows, by today's settings (5% on top: $63.00)", r.status === 200 && orderRow(r.body.orderId).taxRateBps === 500 && orderRow(r.body.orderId).totalCents === 6300);
    const qc = await quote();
    d1._raw.run("UPDATE estimates SET status = 'changes', customerNote = 'More please' WHERE id = ?", [qc.id]);
    setTax(800, "exclusive");
    r = await admin({ action: "convertEstimate", id: qc.id });
    ok("…and so is a quote sent back for changes (8% on top: $64.80)", r.status === 200 && orderRow(r.body.orderId).taxRateBps === 800 && orderRow(r.body.orderId).totalCents === 6480);
    setTax(725, "exclusive");
  }

  // ============================================================================================================
  console.log("=== 2. A price can't go under a quantity break, even when the breaks aren't sent ===");
  {
    const tee = { org: "club", productId: "tee", type: "shirt", name: "Club Tee", pricingMode: "sized", visible: true, weightOz: 6, noDesignNeeded: true };
    const priceOfS = () => JSON.parse(d1.q("SELECT sizePricingCents FROM products WHERE productId='tee'")[0].sizePricingCents).S;
    r = await admin({ action: "updateProduct", ...tee, sizePricing: { S: 0.5, M: 20, L: 22 } });
    ok("updateProduct without qtyBreaks, S down to $0.50 under the $1 break: refused (400) with the reason, the price kept",
      r.status === 400 && r.body.message === "The break from 6 pieces takes $1.00 off — it must be less than the lowest price, $0.50. Lower the quantity breaks first, or keep the price." && priceOfS() === 2000);
    r = await admin({ action: "updateProduct", ...tee, sizePricing: { S: 1, M: 20, L: 22 } });
    ok("…a price equal to the break is refused too (it would make the piece $0)", r.status === 400 && priceOfS() === 2000);
    r = await admin({ action: "updateProduct", ...tee, pricingMode: "flat", flatPrice: 0.75, sizePricing: undefined });
    ok("…and so is a flat price under it", r.status === 400 && d1.q("SELECT pricingMode FROM products WHERE productId='tee'")[0].pricingMode === "sized");
    const o = await shopOrder([{ productId: "tee", size: "S", qty: 6 }]);
    ok("so a storefront order of 6 S is $19.00 each, never $0", o.status === 200 && (await M.getOrderById(d1, o.orderId)).items[0].unitPrice === 19);
    r = await admin({ action: "updateProduct", ...tee, sizePricing: { S: 1.01, M: 20, L: 22 } });
    ok("a price still above the break saves without sending the breaks, and keeps them", r.status === 200 && priceOfS() === 101 &&
      d1.q("SELECT qtyBreaksJson FROM products WHERE productId='tee'")[0].qtyBreaksJson === '[{"minQty":6,"offCents":100}]');
    r = await admin({ action: "updateProduct", ...tee, sizePricing: { S: 0.5, M: 20, L: 22 }, qtyBreaks: [] });
    ok("lowering the price together with taking the breaks off is fine", r.status === 200 && priceOfS() === 50);
    r = await admin({ action: "updateProduct", ...tee, sizePricing: { S: 0.4, M: 20, L: 22 } });
    ok("…and a product with no breaks takes any price", r.status === 200 && priceOfS() === 40);
    r = await admin({ action: "updateProduct", ...tee, sizePricing: { S: 20, M: 20, L: 22 }, qtyBreaks: [{ minQty: 6, off: 1 }] });
    r = await admin({ action: "createProduct", org: "club", productId: "mug", type: "other", name: "Club Mug", pricingMode: "flat", flatPrice: 2, visible: true, noDesignNeeded: true, qtyBreaks: [{ minQty: 12, off: 2 }] });
    ok("createProduct with a price at its own break is refused", r.status === 400 && /must be less than the lowest price, \$2\.00/.test(r.body.message) && !d1.q("SELECT 1 FROM products WHERE productId='mug'").length);
  }

  // ============================================================================================================
  console.log("=== 3. Before 0109, creating a product with breaks logs no change to them ===");
  {
    const old = await newDb("0109");
    const oldAdmin = (body) => callIn({ DB: old, SIGNING_SECRET: "s".repeat(40) })(ADMIN_ORIGIN + "/api/orders", Object.assign({ key: "x" }, body));
    r = await oldAdmin({ action: "createProduct", org: "club", productId: "cap", type: "cap", name: "Club Cap", pricingMode: "flat", flatPrice: 15, visible: true, noDesignNeeded: true, qtyBreaks: [{ minQty: 12, off: 1 }] });
    ok("the product is made, and no product.qty_breaks_changed is logged (nothing was saved)",
      r.status === 200 && old.q("SELECT count(*) n FROM audit_log WHERE action = 'product.qty_breaks_changed'")[0].n === 0 && old.q("SELECT count(*) n FROM audit_log WHERE action = 'product.created'")[0].n === 1);
    r = await admin({ action: "createProduct", org: "club", productId: "cap", type: "cap", name: "Club Cap", pricingMode: "flat", flatPrice: 15, visible: true, noDesignNeeded: true, qtyBreaks: [{ minQty: 12, off: 1 }] });
    const a = audits("product.qty_breaks_changed").map(x => JSON.parse(x.detail)).filter(x => x.productId === "cap");
    ok("…while on an up-to-date database the breaks saved are logged, from none", r.status === 200 && a.length === 1 && same(a[0], { productId: "cap", from: [], to: [{ minQty: 12, off: 1 }] }));
  }

  // ============================================================================================================
  console.log("=== 4. The quote email greets the customer by name ===");
  {
    mail.length = 0;
    await quote();
    const m = mail[mail.length - 1] || {};
    ok("a customer on file as Pat Example: \"Hi Pat Example,\"", /Hi Pat Example,/.test(plain(m.htmlBody)) && !/Hello,/.test(plain(m.htmlBody)) && /Hi Pat Example,/.test(m.body));
    await quote({ customerId: boosters });
    const b = mail[mail.length - 1] || {};
    ok("a customer on file by company alone: \"Hi Example Boosters,\"", /Hi Example Boosters,/.test(plain(b.htmlBody)) && /Hi Example Boosters,/.test(b.body));
  }

  // ============================================================================================================
  console.log("=== 5. GET /api/estimate: only an open quote can be expired ===");
  {
    const q = await quote();
    await post({ token: q.token, action: "accept" });
    d1._raw.run("UPDATE estimates SET expiresOn = '2000-01-01' WHERE id = ?", [q.id]);
    r = await get(q.token);
    ok("an accepted quote past its last day: expired false, as getEstimate says", r.status === 200 && r.body.estimate.status === "converted" && r.body.estimate.expired === false &&
      (await M.getEstimate(d1, q.id)).estimate.expired === false);
    const c = await quote();
    await admin({ action: "cancelEstimate", id: c.id });
    d1._raw.run("UPDATE estimates SET expiresOn = '2000-01-01' WHERE id = ?", [c.id]);
    r = await get(c.token);
    ok("…a cancelled one too", r.body.estimate.status === "cancelled" && r.body.estimate.expired === false);
    const s = await quote();
    d1._raw.run("UPDATE estimates SET expiresOn = '2000-01-01' WHERE id = ?", [s.id]);
    r = await get(s.token);
    ok("…while a sent one past its last day is expired", r.body.estimate.status === "sent" && r.body.estimate.expired === true && r.body.estimate.canAccept === false);
  }

  // ============================================================================================================
  console.log("=== 6. A refused answer sends the quote as it is now ===");
  {
    const q = await quote();
    d1._raw.run("UPDATE estimates SET expiresOn = '2000-01-15' WHERE id = ?", [q.id]);
    r = await post({ token: q.token, action: "accept" });
    ok("Accept on a quote that expired while the page was open: 410, with the quote: expired, no Accept, no Ask for changes",
      r.status === 410 && !!r.body.estimate && r.body.estimate.expired === true && r.body.estimate.canAccept === false && r.body.estimate.canAskChanges === false && r.body.estimate.number === q.number);
    const c = await quote();
    await admin({ action: "cancelEstimate", id: c.id });
    r = await post({ token: c.token, action: "changes", note: "Navy please" });
    ok("Ask for changes on a quote cancelled in another tab: 409, with the quote as cancelled", r.status === 409 && !!r.body.estimate && r.body.estimate.status === "cancelled" && r.body.estimate.canAskChanges === false);
    const a = await quote();
    await post({ token: a.token, action: "accept" });
    r = await post({ token: a.token, action: "accept" });
    ok("a second Accept: 409, with the quote and its order", r.status === 409 && !!r.body.estimate && r.body.estimate.status === "converted" && !!r.body.estimate.orderId && r.body.estimate.canAccept === false);
    // Cancelled between the check and the save: the database says no, and the answer still has the quote as it is now.
    const R = await quote();
    const raceDb = Object.create(d1);
    raceDb.prepare = (sql) => {
      if (/^UPDATE estimates SET status = 'accepted'/.test(sql)) d1._raw.exec(`UPDATE estimates SET status = 'cancelled', cancelledAt = 't' WHERE id = ${R.id}`);
      return d1.prepare(sql);
    };
    r = await post({ token: R.token, action: "accept" }, { ...env, DB: raceDb });
    ok("…and one cancelled between the check and the save: 409, with the quote as cancelled", r.status === 409 && !!r.body.estimate && r.body.estimate.status === "cancelled" && r.body.estimate.canAccept === false);
  }

  // ============================================================================================================
  console.log("=== 8. A hand-set price already on the quote needs no payments permission to keep ===");
  {
    const c = await admin({ action: "createEstimate", org: "club", customerId: pat, title: "Hand priced" });
    const id = c.body.id;
    r = await admin({ action: "saveEstimate", id, items: [{ kind: "product", productId: "tee", size: "S", qty: 4, customUnitPrice: 9.5 }, { kind: "custom", name: "Banner", qty: 1, unitPrice: 30, taxable: true }] });
    ok("the admin sets a price by hand", r.status === 200 && r.body.items[0].customPrice === true && r.body.items[0].unitPrice === 9.5);
    // A role with Edit on Quotes and Read on payments.
    globalThis.__perms320 = { "quotes.estimates": "edit", "orders.payments": "read", "customers.records": "read" };
    r = await admin({ action: "saveEstimate", id, items: [{ kind: "product", productId: "tee", size: "S", qty: 10, customUnitPrice: 9.5 }, { kind: "custom", name: "Banner", qty: 1, unitPrice: 30, taxable: true }] });
    ok("that role changes the line's quantity, sending the hand price back unchanged: saved", r.status === 200 && r.body.items[0].qty === 10 && r.body.items[0].unitPrice === 9.5);
    r = await admin({ action: "saveEstimate", id, items: [{ kind: "product", productId: "tee", size: "M", qty: 10, customUnitPrice: 9.5 }] });
    ok("…removes another line and changes the size, keeping the price: saved", r.status === 200 && r.body.items.length === 1 && r.body.items[0].size === "M" && r.body.items[0].unitPrice === 9.5);
    r = await admin({ action: "saveEstimate", id, items: [{ kind: "product", productId: "tee", size: "M", qty: 10, customUnitPrice: 8 }] });
    ok("…but changing the hand price is refused (403)", r.status === 403 && r.body.message === "Your role can't set a custom price. Ask an admin." && (await M.getEstimate(d1, id)).items[0].unitPrice === 9.5);
    r = await admin({ action: "saveEstimate", id, items: [{ kind: "product", productId: "tee", size: "M", qty: 10, customUnitPrice: 9.5 }, { kind: "product", productId: "tee", size: "L", qty: 2, customUnitPrice: 9.5 }] });
    ok("…and so is a second line at the same hand price (each price on the quote covers one line)", r.status === 403 && (await M.getEstimate(d1, id)).items.length === 1);
    r = await admin({ action: "saveEstimate", id, items: [{ kind: "product", productId: "cap", size: "OSFA", qty: 10, customUnitPrice: 9.5 }] });
    ok("…and the same price on another product", r.status === 403);
    r = await admin({ action: "saveEstimate", id, items: [{ kind: "product", productId: "tee", size: "M", qty: 10 }] });
    ok("…while letting the catalog price it is fine", r.status === 200 && r.body.items[0].customPrice === false && r.body.items[0].unitPrice === 19);
    globalThis.__perms320 = null;
  }
})().catch(e => { console.error(e); console.log("test320 crashed: false"); process.exit(1); });
