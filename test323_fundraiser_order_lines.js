// Fundraising for group shops (migrations/0110, phase 3): what each order line raises, through the real handlers of
// functions/api/orders.js and db.js:
//   * the storefront order (insertOrder): no fundraiser, a percent one and a per-piece one; tax included in the price
//     (backed out first) or added on top; a product that isn't taxed; personalization counted in the price for a
//     percent and not for a per-piece amount; a line filled from stock; a damaged setup raising nothing;
//   * createLocalSale: catalog lines raise, a custom line raises nothing, a typed price caps a per-piece amount, a line
//     filled from stock raises;
//   * a converted quote (convertEstimateToOrder_): its product lines raise, its custom and fee lines don't;
//   * an imported order (importOrders → importOrdersCsv → insertOrder): its catalog lines raise, untaxed;
//   * Edit items (editOrder → updateOrderItem / addOrderItem → storeLineFundraiser_): only changed and added lines are
//     worked out again, by the shop's fundraiser now and the order's tax; untouched lines keep their snapshot; a custom
//     line or one with no product raises nothing (checked on addOrderItem / updateOrderItem, as Edit items refuses one);
//   * changing the shop's fundraiser afterwards (setOrgFundraiser) leaves existing lines alone;
//   * the line shape (fundraiserCents, fundraiser) and the order shape (fundraiserRaised: cancelled lines out, refunds
//     in proportion, never below 0, the same as FUNDRAISER_RAISED_SQL_) in getOrderById, getOrders and getOrdersByIds;
//   * a database without 0110 still taking every kind of order and edit.
// Real SQL (sql.js) under the real db.js, quoteToken.js and orders.js. Invented shops, people and products only.
const fs = require("fs");
const { ok } = require("./testlib/check");
const { createD1 } = require("./testlib/d1-shim.js");
const { adminAs } = require("./testlib/roles");
const { ADMIN_ORIGIN, shopOrigin } = require("./testlib/hosts.js");

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js")), hostSrc = strip(read("functions/_lib/hostConfig.js")), httpSrc = strip(read("functions/_lib/http.js"));
// Mail is never sent from here: the one function that would is swapped for one that says it did.
const emailSrc = strip(read("functions/_lib/email.js")).replace(/async function send_\(/, "async function send_unused_(") +
  "\nasync function send_(env, m) { return true; }\n";
const { selectBox } = new Function(strip(read("functions/_lib/boxSize.js")) + "\nreturn { selectBox };")();
const S = new Function("selectBox", hostSrc + "\n" + httpSrc + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" + strip(read("functions/_lib/quoteToken.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" + adminAs() + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: { acme: 'acme' }, orgs: {}, features: {} });\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + emailSrc + "\n" + strip(read("functions/_lib/digital.js")) + "\n" + strip(read("functions/api/orders.js")) +
  `\nreturn { post: onRequestPost, getOrderById, getOrdersByIds, addOrderItem, updateOrderItem, FUNDRAISER_RAISED_SQL_ };`)(selectBox);

const migrations = fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort();
const newDb = async (before) => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of migrations) if (!before || f < before) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready, shippingEnabled) VALUES ('acme','acme','Example Club','t','t',1,1);`);
  return d1;
};
const harness = (d1) => {
  const call = async (url, body) => {
    const waits = [];
    const res = await S.post({ env: { DB: d1, SIGNING_SECRET: "s".repeat(40) }, waitUntil: (p) => waits.push(Promise.resolve(p).catch(() => {})),
      request: { url, json: async () => body, headers: { get: () => null } } });
    await Promise.all(waits);
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const admin = (body) => call(ADMIN_ORIGIN + "/api/orders", { key: "x", org: "acme", ...body });
  let n = 0;
  const shop = async (items, extra = {}) => { const orderId = "WEB-" + (++n);
    return { orderId, ...(await call(shopOrigin("acme") + "/api/orders",
      { orderId, orgId: "acme", customerName: "Pat Example", contact: "pat@example.com", paymentMethod: "Check", items, ...extra })) }; };
  const sale = async (items, extra = {}) => { const r = await admin({ action: "createLocalSale", items, ...extra }); return { ...r, orderId: r.body.orderId }; };
  return { call, admin, shop, sale };
};
const setTax = (d1, rateBps, taxMode) => d1._raw.run("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('salesTax', ?)", [JSON.stringify({ rateBps, taxShipping: false, jurisdiction: "", taxMode })]);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const quietly = async (fn) => { const err = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = err; } };

(async () => {
  const d1 = await newDb();
  const { admin, shop, sale } = harness(d1);
  const q1 = (sql, ...p) => d1.q(sql, ...p)[0] || null;
  const order = (orderId) => S.getOrderById(d1, orderId);
  // Each line's stored fundraiserCents, in line order ("productId:cents").
  const raisedRows = (orderId) => d1.q("SELECT productId, fundraiserCents FROM order_items WHERE orderId = ? ORDER BY id", orderId).map(r => r.productId + ":" + r.fundraiserCents).join(" ");
  const setFundraiser = (fundraiser) => admin({ action: "setOrgFundraiser", org: "acme", fundraiser });
  const PERCENT10 = { mode: "percent", percent: 10, label: "Example Boosters", showOnShop: true };
  let r, o;

  // The shop's products, made with the real createProduct action: a taxable tee with $5 personalization, a cap that
  // isn't taxed, and a mug the shop keeps in finished stock.
  r = await admin({ action: "createProduct", productId: "tee", type: "shirt", name: "Club Tee", pricingMode: "flat", flatPrice: 20, visible: true, weightOz: 6, noDesignNeeded: true, personalizationPrice: 5 });
  const r2 = await admin({ action: "createProduct", productId: "cap", type: "cap", name: "Club Cap", pricingMode: "flat", flatPrice: 15, visible: true, weightOz: 3, noDesignNeeded: true });
  const r3 = await admin({ action: "createProduct", productId: "mug", type: "other", name: "Club Mug", pricingMode: "flat", flatPrice: 10, visible: true, weightOz: 10, noDesignNeeded: true });
  d1._raw.exec("UPDATE products SET taxable = 0 WHERE productId = 'cap'; UPDATE products SET taxable = 1 WHERE productId IN ('tee','mug');");
  d1._raw.exec("INSERT INTO ready_to_ship (orgId, productId, size, quantity, updatedAt) VALUES ('acme','mug','',100,'t')");
  setTax(d1, 1000, "inclusive");
  ok("the shop's products are made: a $20 tee (taxed, $5 personalization), a $15 cap (not taxed), a $10 mug in stock; tax 10%, included in prices",
    r.status === 200 && r2.status === 200 && r3.status === 200 && q1("SELECT taxable FROM products WHERE productId='cap'").taxable === 0);

  console.log("\n=== A shop with no fundraiser ===");
  o = await shop([{ productId: "tee", size: "M", qty: 3 }, { productId: "cap", qty: 2 }]);
  let got = await order(o.orderId);
  ok("a storefront order in a shop with no fundraiser is taken, and every line raises 0 (the column's default)", o.status === 200 && raisedRows(o.orderId) === "tee:0 cap:0");
  ok("…the lines read back fundraiserCents 0 and fundraiser $0, and the order fundraiserRaised $0",
    got.items.every(i => i.fundraiserCents === 0 && i.fundraiser === 0) && got.fundraiserRaised === 0);

  console.log("\n=== A percent fundraiser, tax included in the price ===");
  r = await setFundraiser(PERCENT10);
  ok("the shop is given a 10% fundraiser for Example Boosters (setOrgFundraiser)", r.status === 200 && r.body.status === "ok" && same(r.body.fundraiser, PERCENT10));
  o = await shop([{ productId: "tee", size: "M", qty: 3 }]);
  ok("3 tees at $20 with 10% tax included: the tax is backed out first ($60 → $54.55) and 10% of that, rounded half up, is $5.46",
    o.status === 200 && raisedRows(o.orderId) === "tee:546");
  got = await order(o.orderId);
  ok("…the line reads back fundraiserCents 546 and fundraiser $5.46, and the order fundraiserRaised $5.46",
    got.items[0].fundraiserCents === 546 && got.items[0].fundraiser === 5.46 && got.fundraiserRaised === 5.46);
  ok("…and the customer pays the same: the fundraiser is inside the price ($60.00 total)", got.total === 60 && got.subtotal === 60);
  o = await shop([{ productId: "tee", size: "M", qty: 1 }, { productId: "tee", size: "L", qty: 1, personalized: true, persName: "Example" }]);
  ok("personalization is part of the price a percent is taken of: a plain tee raises $1.82, a personalized one ($25) $2.27",
    o.status === 200 && raisedRows(o.orderId) === "tee:182 tee:227");
  o = await shop([{ productId: "cap", qty: 2 }]);
  ok("a product that isn't taxed has no tax to back out: 2 caps at $15 raise 10% of $30.00, $3.00", o.status === 200 && raisedRows(o.orderId) === "cap:300");
  got = await order(o.orderId);
  ok("…the order adds its lines up: fundraiserRaised $3.00", got.fundraiserRaised === 3);
  o = await shop([{ productId: "mug", qty: 4 }]);
  ok("a storefront line filled from finished stock raises like any other: 4 mugs ($40, tax included) raise $3.64",
    o.status === 200 && q1("SELECT fromStock FROM order_items WHERE orderId = ?", o.orderId).fromStock === 1 && raisedRows(o.orderId) === "mug:364");
  d1._raw.exec("UPDATE orgs SET taxExempt = 1 WHERE orgId = 'acme'");
  o = await shop([{ productId: "tee", size: "M", qty: 3 }]);
  ok("in a tax-exempt shop no tax is backed out: 3 tees raise 10% of the whole $60.00, $6.00", o.status === 200 && raisedRows(o.orderId) === "tee:600");
  d1._raw.exec("UPDATE orgs SET taxExempt = 0 WHERE orgId = 'acme'");

  console.log("\n=== A percent fundraiser, tax added on top ===");
  setTax(d1, 1000, "exclusive");
  o = await shop([{ productId: "tee", size: "M", qty: 3 }, { productId: "cap", qty: 1 }]);
  got = await order(o.orderId);
  ok("with tax added on top the price is already before tax: 3 tees raise 10% of $60.00, $6.00, and a cap $1.50",
    o.status === 200 && raisedRows(o.orderId) === "tee:600 cap:150");
  ok("…the tax the customer pays on top ($6.00) raises nothing: the order's total is $81.00 and it raises $7.50", got.total === 81 && got.fundraiserRaised === 7.5);
  const exclusiveOrder = o.orderId;
  setTax(d1, 1000, "inclusive");

  console.log("\n=== A per-piece fundraiser ===");
  r = await setFundraiser({ mode: "perPiece", amount: 2, label: "Example Boosters" });
  ok("the shop's fundraiser is changed to $2.00 a piece", r.status === 200 && same(r.body.fundraiser, { mode: "perPiece", amount: 2, label: "Example Boosters", showOnShop: false }));
  o = await shop([{ productId: "tee", size: "M", qty: 3 }, { productId: "cap", qty: 2 }]);
  ok("$2.00 a piece: 3 tees raise $6.00 and 2 caps $4.00, whatever the price or the tax", o.status === 200 && raisedRows(o.orderId) === "tee:600 cap:400");
  o = await shop([{ productId: "tee", size: "M", qty: 2, personalized: true, persName: "Example" }]);
  ok("personalization doesn't add to a per-piece amount: 2 personalized tees raise $4.00", o.status === 200 && raisedRows(o.orderId) === "tee:400");
  r = await setFundraiser({ mode: "perPiece", amount: 25, label: "Example Boosters" });
  o = await shop([{ productId: "tee", size: "M", qty: 2 }]);
  ok("a per-piece amount is never more than the line brought in before tax: $25 a piece on 2 tees ($40, $36.36 before tax) raises $36.36",
    r.status === 200 && o.status === 200 && raisedRows(o.orderId) === "tee:3636");

  console.log("\n=== A damaged fundraiser setup ===");
  d1._raw.run("UPDATE orgs SET fundraiserJson = ? WHERE orgId = 'acme'", [JSON.stringify({ mode: "percent", percentBps: 9999, label: "Example Boosters" })]);
  o = await shop([{ productId: "tee", size: "M", qty: 3 }]);
  ok("a stored setup that isn't valid (a 99.99% fundraiser) raises nothing rather than something wrong", o.status === 200 && raisedRows(o.orderId) === "tee:0");
  d1._raw.run("UPDATE orgs SET fundraiserJson = ? WHERE orgId = 'acme'", ["{not json"]);
  o = await shop([{ productId: "tee", size: "M", qty: 3 }]);
  ok("…nor does one that can't be read, and the order is still taken", o.status === 200 && raisedRows(o.orderId) === "tee:0");

  console.log("\n=== A local sale ===");
  r = await setFundraiser(PERCENT10);
  o = await sale([{ productId: "tee", size: "M", qty: 3 }, { productId: "__custom__", name: "Club banner", type: "custom", qty: 2, customUnitPrice: 30 },
    { productId: "mug", qty: 2 }]);
  ok("a local sale's catalog lines raise ($5.46 for 3 tees), a custom line ($60 banner) raises nothing, and a mug line filled from stock raises $1.82",
    r.status === 200 && o.status === 200 && raisedRows(o.orderId) === "tee:546 __custom__:0 mug:182" &&
    q1("SELECT fromStock FROM order_items WHERE orderId = ? AND productId = 'mug'", o.orderId).fromStock === 1);
  got = await order(o.orderId);
  ok("…the sale's fundraiserRaised is its lines' $7.28", got.fundraiserRaised === 7.28);
  o = await sale([{ productId: "tee", size: "M", qty: 2, customUnitPrice: 11 }, { productId: "cap", qty: 1, customUnitPrice: 0 }]);
  ok("a catalog line at a typed price raises on that price (2 × $11 with tax included → $2.00), and a free one raises nothing",
    o.status === 200 && raisedRows(o.orderId) === "tee:200 cap:0");
  await setFundraiser({ mode: "perPiece", amount: 2, label: "Example Boosters" });
  o = await sale([{ productId: "cap", qty: 3, customUnitPrice: 1 }]);
  ok("$2.00 a piece on 3 caps typed in at $1.00 (untaxed) is held to the $3.00 they brought in", o.status === 200 && raisedRows(o.orderId) === "cap:300");

  console.log("\n=== A converted quote ===");
  await setFundraiser(PERCENT10);
  d1._raw.run("INSERT INTO customers (name, email, phone, createdAt, updatedAt) VALUES ('Lee Example', 'lee@example.com', '555-0123', 't', 't')");
  const pat = q1("SELECT MAX(id) AS m FROM customers").m;
  const est = await admin({ action: "createEstimate", org: "acme", customerId: pat, title: "Club order" });
  const estId = est.body.id;
  r = await admin({ action: "saveEstimate", id: estId, items: [
    { kind: "product", productId: "tee", qty: 3 },
    { kind: "custom", name: "Sample patch", qty: 2, unitPrice: 7.5 },
    { kind: "fee", feeKind: "setup", name: "Club crest", amount: 25 },
    { kind: "product", productId: "cap", qty: 2 },
  ] });
  ok("a quote for the shop is made and priced: 3 tees, a custom line, a setup fee and 2 caps", est.status === 200 && r.status === 200 && (r.body.items || []).length === 4);
  r = await admin({ action: "convertEstimate", id: estId });
  ok("converted to an order, its product lines raise (3 tees $5.46, 2 caps $3.00) and its custom and fee lines raise nothing",
    r.status === 200 && raisedRows(r.body.orderId) === "tee:546 __custom__:0 __custom__:0 cap:300");
  got = await order(r.body.orderId);
  ok("…and the order made from it raises $8.46", got.fundraiserRaised === 8.46);

  console.log("\n=== An imported order ===");
  const unit = (orderNo, lines) => ({ order: orderNo, row: 2, lines: lines.map(l => ({ order: orderNo, date: "2026-06-10", customer: "Max Example", email: "", size: "", qty: "1", price: "20.00",
    personalization: "", shipping: "0", paid: "", shipped: "", ...l })) });
  r = await admin({ action: "importOrders", org: "acme", rows: [unit("IMP-1", [{ sku: "tee", item: "Club Tee", qty: "3" }, { sku: "", item: "Example Sticker", qty: "2", price: "5.00" }])] });
  const imported = r.body.results && r.body.results[0] && r.body.results[0].orderId;
  ok("an imported order goes through insertOrder: its catalog line raises on the whole price, since another store charged the tax (3 × $20 → $6.00), and its custom line nothing",
    r.status === 200 && !!imported && raisedRows(imported) === "tee:600 __custom__:0");

  console.log("\n=== Changing the fundraiser leaves orders already placed alone ===");
  o = await sale([{ productId: "tee", size: "M", qty: 3 }, { productId: "cap", qty: 3 }, { productId: "mug", qty: 1, customUnitPrice: 11 }]);
  const E = o.orderId;
  ok("the order to edit, placed at 10%: 3 tees raise $5.46, 3 caps $4.50, a mug at $11 $1.00", o.status === 200 && raisedRows(E) === "tee:546 cap:450 mug:100");
  r = await setFundraiser({ mode: "percent", percent: 20, label: "Example Boosters" });
  ok("the shop's fundraiser goes up to 20%, and the order's lines still raise what they did", r.status === 200 && raisedRows(E) === "tee:546 cap:450 mug:100");
  r = await setFundraiser(null);
  got = await order(E);
  ok("…and ending it leaves them too: the order still raises $10.96", r.status === 200 && raisedRows(E) === "tee:546 cap:450 mug:100" && got.fundraiserRaised === 10.96);
  await setFundraiser({ mode: "percent", percent: 20, label: "Example Boosters" });

  console.log("\n=== Edit items ===");
  const edit = (orderId, change) => admin({ action: "editOrder", orderId, ...change });
  const line = async (orderId, productId) => (await order(orderId)).items.find(i => i.productId === productId && !i.cancelDate);
  r = await edit(E, { updates: [{ itemId: (await line(E, "cap")).sheetRow, productId: "cap", qty: 4 }] });
  ok("a changed line is worked out again by the shop's fundraiser now: 4 caps at 20% of $60.00 raise $12.00", r.status === 200 && (await line(E, "cap")).fundraiserCents === 1200);
  ok("…the lines nobody touched keep what they raised at 10%", (await line(E, "tee")).fundraiserCents === 546 && (await line(E, "mug")).fundraiserCents === 100);
  r = await edit(E, { additions: [{ productId: "tee", size: "L", qty: 3 }] });
  let added = (await order(E)).items.filter(i => i.productId === "tee");
  ok("an added line raises by the fundraiser now, at the tax rate it was given: 3 tees with 10% tax included raise 20% of $54.55, $10.91",
    r.status === 200 && added.length === 2 && added[1].fundraiserCents === 1091 && added[1].taxRate === 10);
  ok("…and the tee line already on the order still raises $5.46", added[0].fundraiserCents === 546);
  r = await setFundraiser(null);
  r = await edit(E, { updates: [{ itemId: (await line(E, "mug")).sheetRow, productId: "mug", qty: 1 }] });
  ok("with the fundraiser ended, a line sent in an edit is worked out again to nothing (the mug, priced again at $10, raises $0)",
    r.status === 200 && (await line(E, "mug")).fundraiserCents === 0);
  ok("…while the changed cap, the added tee and the untouched tee keep theirs", (await line(E, "cap")).fundraiserCents === 1200 && added[1].fundraiserCents === 1091 &&
    (await order(E)).items.find(i => i.sheetRow === added[0].sheetRow).fundraiserCents === 546);
  await setFundraiser(PERCENT10);
  // Edit items refuses a custom line ("Product not available"), so the custom-line rule is checked on db.js's own
  // line writers, which a custom line from elsewhere (a local sale, a quote) goes through.
  const capId = (await line(E, "cap")).sheetRow;
  const customId = await S.addOrderItem(d1, E, "acme", { productId: "__custom__", name: "Club banner", type: "custom", qty: 2, unitPrice: 30, taxable: false });
  const blankId = await S.addOrderItem(d1, E, "acme", { productId: "", name: "Rush setup", type: "", qty: 1, unitPrice: 25, taxable: false });
  const capAddId = await S.addOrderItem(d1, E, "acme", { productId: "cap", name: "Club Cap", type: "cap", qty: 1, unitPrice: 15 });
  const storedOf = (id) => q1("SELECT fundraiserCents FROM order_items WHERE id = ?", Number(id)).fundraiserCents;
  ok("addOrderItem: a catalog line added raises by the shop's fundraiser (a $15 cap at 10%, $1.50), a custom line ($60) and a line with no product ($25) nothing",
    storedOf(capAddId) === 150 && storedOf(customId) === 0 && storedOf(blankId) === 0);
  await S.updateOrderItem(d1, capId, { productId: "__custom__", name: "Club banner", type: "custom", qty: 2, unitPrice: 30, taxable: false });
  ok("updateOrderItem: a catalog line that raised $12.00 changed into a custom one ($60) raises nothing", storedOf(capId) === 0 && q1("SELECT lineTotalCents FROM order_items WHERE id = ?", capId).lineTotalCents === 6000);
  // The order placed with tax added on top is edited after the shop moves back to tax included: the order keeps its mode.
  r = await edit(exclusiveOrder, { additions: [{ productId: "tee", size: "L", qty: 3 }] });
  const exAdded = (await order(exclusiveOrder)).items.filter(i => i.productId === "tee");
  ok("a line added to an order placed with tax added on top raises on its whole price (10% of $60.00, $6.00), by the order's tax mode, not the shop's now",
    r.status === 200 && exAdded.length === 2 && exAdded[1].fundraiserCents === 600);

  console.log("\n=== What an order raises: cancelled lines, refunds ===");
  o = await sale([{ productId: "tee", size: "M", qty: 3 }, { productId: "cap", qty: 2 }, { productId: "mug", qty: 1 }]);
  const R = o.orderId;
  ok("the order: 3 tees raise $5.46, 2 caps $3.00, a mug $0.91 — $9.37 in all", o.status === 200 && raisedRows(R) === "tee:546 cap:300 mug:91" && (await order(R)).fundraiserRaised === 9.37);
  const ids = Object.fromEntries((await order(R)).items.map(i => [i.productId, i.sheetRow]));
  r = await admin({ action: "cancelLineItem", sheetRow: ids.mug, reason: "Changed mind" });
  got = await order(R);
  ok("a cancelled line raises nothing: the order raises $8.46, though the line keeps its $0.91", r.status === 200 && got.fundraiserRaised === 8.46 &&
    got.items.find(i => i.productId === "mug").fundraiserCents === 91);
  r = await admin({ action: "setLineItemRefund", sheetRow: ids.tee, refundAmount: 30 });
  got = await order(R);
  ok("a line half refunded ($30 of $60) raises half: $5.46 − $2.73 → the order raises $5.73", r.status === 200 && got.fundraiserRaised === 5.73 &&
    got.items.find(i => i.productId === "tee").fundraiserCents === 546);
  r = await admin({ action: "setLineItemRefund", sheetRow: ids.cap, refundAmount: 40 });
  got = await order(R);
  ok("a refund of more than the line came to raises nothing, never less than nothing: the order raises $2.73", r.status === 200 && got.fundraiserRaised === 2.73);
  // The proportion's rounding: 5¢ raised on a $10.00 line with $1.00 back is 0.5¢ off, rounded up to 1¢.
  d1._raw.exec(`UPDATE order_items SET fundraiserCents = 5, lineTotalCents = 1000, refundCents = 100 WHERE id = ${ids.tee}`);
  got = await order(R);
  ok("the refunded share is rounded half up to the cent: 5¢ raised less 0.5¢ is 4¢", got.fundraiserRaised === 0.04);
  d1._raw.exec(`UPDATE order_items SET lineTotalCents = 0, refundCents = 0 WHERE id = ${ids.tee}`);
  got = await order(R);
  ok("a line that came to nothing raises nothing, whatever it stored", got.fundraiserRaised === 0);
  const sqlRaised = (orderId) => q1(`SELECT COALESCE(SUM(${S.FUNDRAISER_RAISED_SQL_("oi")}), 0) AS c FROM order_items oi WHERE oi.orderId = ? AND oi.cancelDate IS NULL`, orderId).c;
  const matched = [];
  for (const [fc, total, refund] of [[546, 6000, 3000], [5, 1000, 100], [300, 3000, 4000], [91, 1000, 0], [777, 0, 0], [1091, 6000, 1]]) {
    d1._raw.exec(`UPDATE order_items SET fundraiserCents = ${fc}, lineTotalCents = ${total}, refundCents = ${refund} WHERE id = ${ids.tee}`);
    matched.push(Math.round((await order(R)).fundraiserRaised * 100) === sqlRaised(R));
  }
  ok("the order's fundraiserRaised is the same to the cent as FUNDRAISER_RAISED_SQL_ (the report's sum) — halves, over-refunds, nothing refunded, a $0 line",
    matched.length === 6 && matched.every(Boolean));
  d1._raw.exec(`UPDATE order_items SET fundraiserCents = 546, lineTotalCents = 6000, refundCents = NULL WHERE id = ${ids.tee}`);
  ok("…and with no refund at all (refundCents NULL) a line raises all it stored", Math.round((await order(R)).fundraiserRaised * 100) === 546 && sqlRaised(R) === 546);

  console.log("\n=== The order lists ===");
  r = await admin({ action: "getOrders" });
  const listed = (r.body.orders || []).find(x => x.orderId === R);
  ok("getOrders carries each order's fundraiserRaised and each line's fundraiserCents and fundraiser", r.status === 200 && listed && listed.fundraiserRaised === 5.46 &&
    same(listed.items.map(i => [i.productId, i.fundraiserCents, i.fundraiser]), [["tee", 546, 5.46], ["cap", 300, 3], ["mug", 91, 0.91]]));
  r = await admin({ action: "getOrdersByIds", orderIds: [R, E] });
  const byId = Object.fromEntries((r.body.orders || []).map(x => [x.orderId, x]));
  ok("getOrdersByIds carries them too, for each order asked for", r.status === 200 && byId[R] && byId[R].fundraiserRaised === 5.46 && byId[E] &&
    byId[E].fundraiserRaised === (await order(E)).fundraiserRaised && byId[E].items.some(i => i.fundraiserCents === 1091));
  const direct = await S.getOrdersByIds(d1, [R]);
  ok("…as db.js's getOrdersByIds gives them", direct.length === 1 && direct[0].fundraiserRaised === 5.46);

  console.log("\n=== A database without migrations/0110 ===");
  const old = await newDb("0110");
  const H = harness(old);
  ok("the database is from before 0110: no fundraiserCents on order lines, no fundraiserJson on shops",
    !old.q("PRAGMA table_info(order_items)").some(c => c.name === "fundraiserCents") && !old.q("PRAGMA table_info(orgs)").some(c => c.name === "fundraiserJson"));
  await H.admin({ action: "createProduct", productId: "tee", type: "shirt", name: "Club Tee", pricingMode: "flat", flatPrice: 20, visible: true, weightOz: 6, noDesignNeeded: true });
  old._raw.exec("INSERT INTO ready_to_ship (orgId, productId, size, quantity, updatedAt) VALUES ('acme','tee','',100,'t')");
  o = await H.shop([{ productId: "tee", size: "M", qty: 3 }]);
  got = await S.getOrderById(old, o.orderId);
  ok("a storefront order is still taken, and reads back raising nothing (fundraiserCents 0, fundraiser $0, fundraiserRaised $0)",
    o.status === 200 && got && got.items[0].fundraiserCents === 0 && got.items[0].fundraiser === 0 && got.fundraiserRaised === 0);
  o = await H.sale([{ productId: "tee", size: "M", qty: 2 }, { productId: "__custom__", name: "Club banner", type: "custom", qty: 1, customUnitPrice: 30 }]);
  ok("a local sale is still taken", o.status === 200 && (await S.getOrderById(old, o.orderId)).items.length === 2);
  const oldLines = (await S.getOrderById(old, o.orderId)).items;
  r = await H.admin({ action: "editOrder", orderId: o.orderId, updates: [{ itemId: oldLines[0].sheetRow, productId: "tee", size: "M", qty: 4 }], additions: [{ productId: "tee", size: "L", qty: 1 }] });
  got = await S.getOrderById(old, o.orderId);
  ok("Edit items still changes and adds lines", r.status === 200 && got.items.length === 3 && got.items[0].qty === 4 && got.items.every(i => i.fundraiserCents === 0) && got.fundraiserRaised === 0);
  r = await H.admin({ action: "importOrders", org: "acme", rows: [unit("OLD-1", [{ sku: "tee", item: "Club Tee" }])] });
  ok("an imported order is still taken", r.status === 200 && r.body.created === 1);
  old._raw.run("INSERT INTO customers (name, email, createdAt, updatedAt) VALUES ('Lee Example', 'lee@example.com', 't', 't')");
  const oldEst = await H.admin({ action: "createEstimate", org: "acme", customerId: old.q("SELECT MAX(id) AS m FROM customers")[0].m });
  const oldEstId = oldEst.body.id;
  await H.admin({ action: "saveEstimate", id: oldEstId, items: [{ kind: "product", productId: "tee", qty: 2 }, { kind: "fee", feeKind: "setup", name: "Club crest", amount: 25 }] });
  r = await H.admin({ action: "convertEstimate", id: oldEstId });
  ok("a quote still converts to an order", r.status === 200 && (await S.getOrderById(old, r.body.orderId)).items.length === 2);
  r = await H.admin({ action: "getOrders" });
  ok("and getOrders lists them all with fundraiserRaised $0", r.status === 200 && r.body.orders.length === 4 && r.body.orders.every(x => x.fundraiserRaised === 0));
})().catch((e) => { console.error(e); process.exit(1); });
