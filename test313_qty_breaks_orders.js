// Quantity breaks (migrations/0109, phase 2) through the real handlers of functions/api/orders.js:
//   * the storefront order (the public order action): the pieces of one product are counted across its sizes, another
//     product's pieces are apart, 11 pieces miss a 12+ break and 12 meet it, only the deepest break counts, a signed
//     shipping quote's order is priced the same way, and a line of more than 50 is still refused;
//   * createLocalSale: the break across the sale's lines, a custom unit price kept (its pieces still count), a
//     __custom__ line apart, up to 100 lines and 5,000 pieces a line (101 lines refused, more pieces held at 5,000);
//   * Edit items (editOrder): the pieces counted as the order will be after the edit (changed quantities, lines taken
//     off, lines added, lines cancelled before), only the changed and added lines priced again;
//   * createProduct / updateProduct with qtyBreaks: every refusal and its sentence, the deepest break held to the
//     vendor's MAP (code belowMap), the product.qty_breaks_changed audit row with from / to, who may, and a database
//     a migration behind.
// Real SQL (sql.js) under the real db.js, quoteToken.js and orders.js. Invented shops, people and products only.
const fs = require("fs");
const { ok } = require("./testlib/check");
const { createD1 } = require("./testlib/d1-shim.js");
const { adminAs } = require("./testlib/roles");
const { ADMIN_ORIGIN, shopOrigin } = require("./testlib/hosts.js");
const auth = require("./testlib/auth-harness");

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js")), hostSrc = strip(read("functions/_lib/hostConfig.js")), httpSrc = strip(read("functions/_lib/http.js"));
// Mail is never sent from here: the one function that would is swapped for one that says it did.
const emailSrc = strip(read("functions/_lib/email.js")).replace(/async function send_\(/, "async function send_unused_(") +
  "\nasync function send_(env, m) { return true; }\n";
const { selectBox } = new Function(strip(read("functions/_lib/boxSize.js")) + "\nreturn { selectBox };")();
globalThis.__role313 = "admin";
const S = new Function("selectBox", hostSrc + "\n" + httpSrc + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" + strip(read("functions/_lib/quoteToken.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" + adminAs({ roleFrom: "globalThis.__role313" }) + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: { acme: 'acme' }, orgs: {}, features: {} });\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + emailSrc + "\n" + strip(read("functions/_lib/digital.js")) + "\n" + strip(read("functions/api/orders.js")) +
  `\nreturn { post: onRequestPost, signQuote, canonicalItems, getOrderById, createBlank, setBlankLink };`)(selectBox);

const ENV = { SIGNING_SECRET: "s".repeat(40) };
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
    const res = await S.post({ env: { DB: d1, ...ENV }, waitUntil: (p) => waits.push(Promise.resolve(p).catch(() => {})),
      request: { url, json: async () => body, headers: { get: () => null } } });
    await Promise.all(waits);
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const admin = (body) => call(ADMIN_ORIGIN + "/api/orders", { key: "x", org: "acme", ...body });
  let n = 0;
  const shop = async (items, extra = {}) => { const orderId = "WEB-" + (++n);
    return { orderId, ...(await call(shopOrigin("acme") + "/api/orders",
      { orderId, orgId: "acme", customerName: "Pat Example", contact: "pat@example.com", paymentMethod: "Check", items, ...extra })) }; };
  return { call, admin, shop };
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const QTY_MESSAGE = "Each item's quantity must be a whole number from 1 to 50.";

(async () => {
  const d1 = await newDb();
  const { admin, shop } = harness(d1);
  const q1 = (sql, ...p) => d1.q(sql, ...p)[0] || null;
  const orderCount = () => q1("SELECT count(*) AS n FROM orders").n;
  const lines = async (orderId) => ((await S.getOrderById(d1, orderId)) || { items: [] }).items;
  // A line's unit price, by its size (or product) — "size:unitPrice" for every line, in order.
  const prices = async (orderId) => (await lines(orderId)).map(i => (i.size || i.productId) + ":" + i.unitPrice).join(" ");
  const breakAudits = (productId) => d1.q("SELECT detail FROM audit_log WHERE action = 'product.qty_breaks_changed' ORDER BY id").map(r => JSON.parse(r.detail)).filter(d => d.productId === productId);
  const storedBreaks = (productId) => (q1("SELECT qtyBreaksJson FROM products WHERE orgId = 'acme' AND productId = ?", productId) || {}).qtyBreaksJson;
  let r, o;

  // The products, made with the real createProduct action.
  r = await admin({ action: "createProduct", productId: "tee", type: "shirt", name: "Club Tee", pricingMode: "sized", sizePricing: { S: 20, M: 20, L: 22 }, visible: true, weightOz: 6,
    noDesignNeeded: true, personalizationPrice: 5, qtyBreaks: [{ minQty: 24, off: 3.5 }, { minQty: 12, off: 2 }] });
  const r2 = await admin({ action: "createProduct", productId: "cap", type: "cap", name: "Club Cap", pricingMode: "flat", flatPrice: 15, visible: true, weightOz: 3, noDesignNeeded: true, qtyBreaks: [{ minQty: 12, off: 1 }] });
  const r3 = await admin({ action: "createProduct", productId: "mug", type: "other", name: "Club Mug", pricingMode: "flat", flatPrice: 10, visible: true, weightOz: 10, noDesignNeeded: true });
  ok("the shop's products are made: a tee with breaks at 12+ ($2 off) and 24+ ($3.50 off), a cap with one at 12+ ($1 off), a mug with none",
    r.status === 200 && r2.status === 200 && r3.status === 200);

  console.log("\n=== A storefront order ===");
  o = await shop([{ productId: "tee", size: "S", qty: 6 }, { productId: "tee", size: "M", qty: 6 }]);
  ok("6 S and 6 M of the tee are 12 pieces of one product: both lines get the 12+ break ($20.00 → $18.00)", o.status === 200 && await prices(o.orderId) === "S:18 M:18");
  ok("…and the order's subtotal is at the break price (12 × $18.00)", (await S.getOrderById(d1, o.orderId)).subtotal === 216);
  o = await shop([{ productId: "tee", size: "S", qty: 6 }, { productId: "tee", size: "M", qty: 5 }]);
  ok("6 S and 5 M are 11 pieces: one short of the 12+ break, full price", o.status === 200 && await prices(o.orderId) === "S:20 M:20");
  o = await shop([{ productId: "tee", size: "S", qty: 11 }]);
  ok("11 pieces on one line: full price", o.status === 200 && await prices(o.orderId) === "S:20");
  o = await shop([{ productId: "tee", size: "S", qty: 12 }]);
  ok("12 pieces on one line: the 12+ break", o.status === 200 && await prices(o.orderId) === "S:18");
  o = await shop([{ productId: "tee", size: "S", qty: 5 }, { productId: "tee", size: "M", qty: 5 }, { productId: "tee", size: "L", qty: 2 }]);
  ok("the break comes off each size's own price: S and M $18.00, L $22.00 → $20.00", o.status === 200 && await prices(o.orderId) === "S:18 M:18 L:20");
  o = await shop([{ productId: "tee", size: "S", qty: 10 }, { productId: "tee", size: "M", qty: 14 }]);
  ok("24 pieces take only the deepest break that applies ($3.50 off, not $2.00 + $3.50)", o.status === 200 && await prices(o.orderId) === "S:16.5 M:16.5");
  o = await shop([{ productId: "tee", size: "S", qty: 10 }, { productId: "cap", qty: 2 }]);
  ok("another product's pieces are counted apart: 10 tees and 2 caps are 12 pieces but neither gets a break", o.status === 200 && await prices(o.orderId) === "S:20 cap:15");
  o = await shop([{ productId: "cap", qty: 12 }, { productId: "tee", size: "S", qty: 1 }]);
  ok("…12 caps get the cap's own break ($15.00 → $14.00) and the one tee stays at full price", o.status === 200 && await prices(o.orderId) === "cap:14 S:20");
  o = await shop([{ productId: "mug", qty: 30 }]);
  ok("a product with no breaks keeps its price however many are ordered", o.status === 200 && await prices(o.orderId) === "mug:10");
  o = await shop([{ productId: "tee", size: "S", qty: 12, personalized: true, persName: "Example" }]);
  const pers = (await lines(o.orderId))[0] || {};
  ok("the break comes off the product's price only: personalization keeps its $5.00", o.status === 200 && pers.unitPrice === 18 && pers.personalizationFee === 5);
  const shipItems = [{ productId: "tee", size: "S", qty: 6 }, { productId: "tee", size: "M", qty: 6 }];
  const quote = await S.signQuote(ENV, { orgId: "acme", zip: "43000", items: S.canonicalItems(shipItems), amountCents: 500, method: "Ground" });
  o = await shop(shipItems, { shippingQuoteToken: quote, shippingAddress: { name: "Pat Example", line1: "1 Example St", line2: "", city: "Anytown", state: "OH", zip: "43000", phone: "555-0100" } });
  const shipped = await S.getOrderById(d1, o.orderId);
  ok("an order shipped on a signed shipping quote is priced with the break too: 12 × $18.00 plus the quoted $5.00", o.status === 200 && await prices(o.orderId) === "S:18 M:18" &&
    shipped.subtotal === 216 && shipped.total === 221);
  o = await shop([{ productId: "tee", size: "S", qty: 50 }]);
  ok("50 of a line is the most a shopper may order, and it is at the deepest break", o.status === 200 && await prices(o.orderId) === "S:16.5");
  let before = orderCount();
  o = await shop([{ productId: "tee", size: "S", qty: 51 }]);
  ok("51 of a line is still refused on the storefront, with the quantity sentence, and no order is made", o.status === 400 && o.body.message === QTY_MESSAGE && orderCount() === before);
  o = await shop([{ productId: "tee", size: "S", qty: 30 }, { productId: "tee", size: "M", qty: 30 }]);
  ok("…while two lines of 30 are fine (the limit is a line's, not the product's) and get the deepest break", o.status === 200 && await prices(o.orderId) === "S:16.5 M:16.5");

  console.log("\n=== A local sale ===");
  const sale = async (items, extra = {}) => { const res = await admin({ action: "createLocalSale", items, ...extra }); return { ...res, orderId: res.body.orderId }; };
  o = await sale([{ productId: "tee", size: "S", qty: 6 }, { productId: "tee", size: "M", qty: 6 }]);
  ok("6 S and 6 M on a local sale are 12 pieces: both lines get the 12+ break", o.status === 200 && await prices(o.orderId) === "S:18 M:18");
  o = await sale([{ productId: "tee", size: "S", qty: 6 }, { productId: "tee", size: "M", qty: 5 }]);
  ok("…11 pieces: full price", o.status === 200 && await prices(o.orderId) === "S:20 M:20");
  o = await sale([{ productId: "tee", size: "S", qty: 8, customUnitPrice: 10 }, { productId: "tee", size: "M", qty: 4 }]);
  ok("a line at a typed unit price keeps that price (no break off it), and its pieces still count toward the other lines' break",
    o.status === 200 && await prices(o.orderId) === "S:10 M:18");
  o = await sale([{ productId: "__custom__", name: "Club banner", type: "custom", qty: 12, customUnitPrice: 5 }, { productId: "tee", size: "S", qty: 1 }]);
  ok("a custom line keeps its own price and its pieces don't count toward any product's break", o.status === 200 && await prices(o.orderId) === "__custom__:5 S:20");
  o = await sale([{ productId: "tee", size: "S", qty: 10 }, { productId: "cap", qty: 2 }]);
  ok("another product's pieces are counted apart on a local sale too", o.status === 200 && await prices(o.orderId) === "S:20 cap:15");
  const hundred = Array.from({ length: 100 }, () => ({ productId: "tee", size: "S", qty: 1 }));
  o = await sale(hundred);
  const ls100 = await lines(o.orderId);
  ok("a local sale takes 100 lines (it used to stop at 20), and their 100 pieces get the deepest break", o.status === 200 && ls100.length === 100 && ls100.every(i => i.unitPrice === 16.5));
  before = orderCount();
  o = await sale(hundred.concat([{ productId: "tee", size: "S", qty: 1 }]));
  ok("101 lines are refused: \"A sale can have at most 100 lines.\", and no order is made", o.status === 400 && o.body.message === "A sale can have at most 100 lines." && orderCount() === before);
  o = await sale([]);
  const o2 = await sale(undefined);
  ok("a sale with no lines, or no list of lines, is refused as \"Invalid items\"", o.status === 400 && o.body.message === "Invalid items" && o2.status === 400 && o2.body.message === "Invalid items" && orderCount() === before);
  o = await sale([{ productId: "cap", qty: 5000 }]);
  ok("a line of 5,000 pieces is taken as it is, at the cap's break", o.status === 200 && (await lines(o.orderId))[0].qty === 5000 && await prices(o.orderId) === "cap:14");
  o = await sale([{ productId: "cap", qty: 5001 }]);
  ok("a line of more than 5,000 is held at 5,000", o.status === 200 && (await lines(o.orderId))[0].qty === 5000);
  o = await sale([{ productId: "mug", qty: 51 }]);
  ok("51 of a line is no longer cut to 50 on a local sale", o.status === 200 && (await lines(o.orderId))[0].qty === 51);
  o = await sale([{ productId: "mug", qty: 0 }, { productId: "mug", qty: "lots" }]);
  ok("a quantity of 0 or one that isn't a number is one piece", o.status === 200 && (await lines(o.orderId)).every(i => i.qty === 1));
  o = await sale([{ productId: "tee", size: "S", qty: 5001 }, { productId: "tee", size: "M", qty: 1, customUnitPrice: 0 }]);
  ok("…and the pieces held at 5,000 are what the break counts", o.status === 200 && await prices(o.orderId) === "S:16.5 M:0");

  console.log("\n=== Edit items ===");
  const edit = (orderId, change) => admin({ action: "editOrder", orderId, ...change });
  const row = async (orderId, size) => (await lines(orderId)).find(i => (i.size || i.productId) === size && !i.cancelDate);
  o = await sale([{ productId: "tee", size: "S", qty: 6 }, { productId: "tee", size: "M", qty: 4 }, { productId: "cap", qty: 1 }]);
  const e1 = o.orderId;
  ok("the order to edit: 6 S and 4 M of the tee and a cap, all at full price", await prices(e1) === "S:20 M:20 cap:15");
  r = await edit(e1, { updates: [{ itemId: (await row(e1, "M")).sheetRow, productId: "tee", size: "M", qty: 6 }] });
  ok("raising M from 4 to 6 makes the order 12 tees: the changed line is priced at the break ($18.00)", r.status === 200 && (await row(e1, "M")).unitPrice === 18);
  ok("…but the S line nobody touched keeps the $20.00 it was sold at, and the cap its $15.00", (await row(e1, "S")).unitPrice === 20 && (await row(e1, "cap")).unitPrice === 15);
  ok("…and the order's subtotal follows (6 × $20 + 6 × $18 + $15)", (await S.getOrderById(d1, e1)).subtotal === 243);
  r = await edit(e1, { additions: [{ productId: "tee", size: "L", qty: 12 }] });
  ok("adding 12 L makes 24 tees: the added line is priced at the deepest break ($22.00 → $18.50)", r.status === 200 && (await row(e1, "L")).unitPrice === 18.5);
  ok("…and the lines already on it keep their prices", (await row(e1, "S")).unitPrice === 20 && (await row(e1, "M")).unitPrice === 18);
  r = await edit(e1, { updates: [{ itemId: (await row(e1, "S")).sheetRow, productId: "tee", size: "S", qty: 6 }] });
  ok("a line sent in an edit is priced again with the order's pieces, even at the same quantity (S: $20.00 → $16.50)", r.status === 200 && (await row(e1, "S")).unitPrice === 16.5);
  o = await sale([{ productId: "tee", size: "S", qty: 6 }, { productId: "tee", size: "M", qty: 6 }]);
  const e2 = o.orderId;
  r = await edit(e2, { removals: [{ itemId: (await row(e2, "M")).sheetRow }], additions: [{ productId: "tee", size: "L", qty: 1 }] });
  ok("a line taken off in the same edit doesn't count: 6 S + 1 L added is 7 pieces, so the L is at full price ($22.00)", r.status === 200 && (await row(e2, "L")).unitPrice === 22);
  ok("…and the S line keeps the break price it was sold at", (await row(e2, "S")).unitPrice === 18);
  o = await sale([{ productId: "tee", size: "S", qty: 6 }, { productId: "tee", size: "M", qty: 6 }]);
  const e3 = o.orderId;
  r = await edit(e3, { updates: [{ itemId: (await row(e3, "S")).sheetRow, productId: "tee", size: "S", qty: 2 }] });
  ok("lowering S from 6 to 2 counts the new quantity: 8 pieces, so the changed S line is at full price", r.status === 200 && (await row(e3, "S")).unitPrice === 20);
  ok("…and the M line nobody touched keeps its break price", (await row(e3, "M")).unitPrice === 18);
  o = await sale([{ productId: "tee", size: "S", qty: 6 }, { productId: "tee", size: "M", qty: 6 }]);
  const e4 = o.orderId;
  r = await edit(e4, { removals: [{ itemId: (await row(e4, "M")).sheetRow }] });
  r = await edit(e4, { additions: [{ productId: "tee", size: "L", qty: 5 }] });
  ok("a line cancelled in an earlier edit doesn't count either: 6 S + 5 L is 11, so the L is at full price", r.status === 200 && (await row(e4, "L")).unitPrice === 22);
  o = await sale([{ productId: "tee", size: "S", qty: 11 }, { productId: "cap", qty: 1 }]);
  const e5 = o.orderId;
  r = await edit(e5, { updates: [{ itemId: (await row(e5, "cap")).sheetRow, productId: "cap", qty: 12 }] });
  ok("another product's pieces don't count: 12 caps reach the cap's break and the 11 tees stay at full price", r.status === 200 && (await row(e5, "cap")).unitPrice === 14 && (await row(e5, "S")).unitPrice === 20);
  r = await edit(e5, { additions: [{ productId: "tee", size: "M", qty: 1 }] });
  ok("…and one more tee added makes 12 tees: the added line gets the break", r.status === 200 && (await row(e5, "M")).unitPrice === 18 && (await row(e5, "S")).unitPrice === 20);

  console.log("\n=== Saving a product's breaks: createProduct ===");
  const listed = async (productId) => ((await admin({ action: "listProducts" })).body.products || []).find(p => p.productId === productId) || null;
  ok("the breaks are stored in order, in cents", storedBreaks("tee") === '[{"minQty":12,"offCents":200},{"minQty":24,"offCents":350}]');
  ok("…the product list gives them back in dollars", same((await listed("tee")).qtyBreaks, [{ minQty: 12, off: 2 }, { minQty: 24, off: 3.5 }]));
  ok("…and the audit log has product.qty_breaks_changed from none to them", same(breakAudits("tee"), [{ productId: "tee", from: [], to: [{ minQty: 12, off: 2 }, { minQty: 24, off: 3.5 }] }]));
  ok("a product made without breaks has none, and no qty_breaks_changed row", storedBreaks("mug") === "[]" && same((await listed("mug")).qtyBreaks, []) && breakAudits("mug").length === 0);
  r = await admin({ action: "createProduct", productId: "pin", type: "other", name: "Club Pin", pricingMode: "flat", flatPrice: 4, visible: true, noDesignNeeded: true, qtyBreaks: [] });
  ok("a product made with an empty list of breaks has none, and no qty_breaks_changed row", r.status === 200 && storedBreaks("pin") === "[]" && breakAudits("pin").length === 0);
  const base = { action: "createProduct", productId: "bag", type: "other", name: "Club Bag", pricingMode: "flat", flatPrice: 15, visible: true, noDesignNeeded: true };
  const refusals = [
    ["breaks that aren't a list", "lots", "Quantity breaks must be a list."],
    ["more than 6 breaks", [2, 3, 4, 5, 6, 7, 8].map((m, i) => ({ minQty: m, off: i + 1 })), "Up to 6 quantity breaks."],
    ["a break from 1 piece", [{ minQty: 1, off: 1 }], "A quantity break starts at a whole number of pieces from 2 to 100,000."],
    ["a break from 2.5 pieces", [{ minQty: 2.5, off: 1 }], "A quantity break starts at a whole number of pieces from 2 to 100,000."],
    ["a break from 100,001 pieces", [{ minQty: 100001, off: 1 }], "A quantity break starts at a whole number of pieces from 2 to 100,000."],
    ["a break with no number of pieces", [{ off: 1 }], "A quantity break starts at a whole number of pieces from 2 to 100,000."],
    ["a break of $0 off", [{ minQty: 12, off: 0 }], "The break from 12 pieces needs an amount off each piece, more than $0."],
    ["a break with the amount left blank", [{ minQty: 12, off: "" }], "The break from 12 pieces needs an amount off each piece, more than $0."],
    ["a break with no amount", [{ minQty: 12 }], "The break from 12 pieces needs an amount off each piece, more than $0."],
    ["a break of a negative amount", [{ minQty: 12, off: -1 }], "The break from 12 pieces needs an amount off each piece, more than $0."],
    ["a break of an amount that isn't a number", [{ minQty: 12, off: "two" }], "The break from 12 pieces needs an amount off each piece, more than $0."],
    ["two breaks from the same number of pieces", [{ minQty: 12, off: 1 }, { minQty: 12, off: 2 }], "Two quantity breaks start at 12 pieces."],
    ["a deeper break taking the same off", [{ minQty: 24, off: 2 }, { minQty: 12, off: 2 }], "The break from 24 pieces must take more off than the break from 12."],
    ["a deeper break taking less off", [{ minQty: 12, off: 3 }, { minQty: 24, off: 2 }], "The break from 24 pieces must take more off than the break from 12."],
    ["a break taking the whole price off", [{ minQty: 12, off: 15 }], "The break from 12 pieces takes $15.00 off — it must be less than the lowest price, $15.00."],
    ["a break taking more than the price off", [{ minQty: 12, off: 20 }], "The break from 12 pieces takes $20.00 off — it must be less than the lowest price, $15.00."],
  ];
  for (const [what, qtyBreaks, message] of refusals) {
    const before = d1.q("SELECT count(*) AS n FROM audit_log")[0].n;
    r = await admin({ ...base, qtyBreaks });
    ok(`${what} is refused: "${message}", and nothing is saved or logged`, r.status === 400 && r.body.status === "error" && r.body.message === message &&
      !q1("SELECT 1 AS x FROM products WHERE productId = 'bag'") && d1.q("SELECT count(*) AS n FROM audit_log")[0].n === before);
  }
  r = await admin({ ...base, pricingMode: "sized", flatPrice: undefined, sizePricing: { S: 20, M: 9 }, qtyBreaks: [{ minQty: 12, off: 9 }] });
  ok("a sized product's breaks are held under its cheapest size", r.status === 400 && r.body.message === "The break from 12 pieces takes $9.00 off — it must be less than the lowest price, $9.00.");
  r = await admin({ ...base, pricingMode: "sized", flatPrice: undefined, sizePricing: { S: 20 }, configurable: true, garmentColors: ["White", "Gold"],
    colorGroups: [{ label: "Gold", colors: ["Gold"], sizePricing: { S: 8 } }], qtyBreaks: [{ minQty: 12, off: 8 }] });
  ok("…and under a color price group's prices too", r.status === 400 && r.body.message === "The break from 12 pieces takes $8.00 off — it must be less than the lowest price, $8.00.");
  r = await admin({ ...base, qtyBreaks: [{ minQty: 2, off: 1 }, { minQty: 3, off: 2 }, { minQty: 4, off: 3 }, { minQty: 5, off: 4 }, { minQty: 6, off: 5 }, { minQty: 100000, off: 14.99 }] });
  ok("6 breaks, from 2 pieces to 100,000, the deepest a cent under the price, are taken", r.status === 200 && (await listed("bag")).qtyBreaks.length === 6 &&
    same((await listed("bag")).qtyBreaks[5], { minQty: 100000, off: 14.99 }));
  r = await admin({ ...base, productId: "bag2", qtyBreaks: [{ minQty: "12", off: "1.50" }] });
  ok("numbers sent as text are read as numbers", r.status === 200 && same((await listed("bag2")).qtyBreaks, [{ minQty: 12, off: 1.5 }]));

  console.log("\n=== Changing a product's breaks: updateProduct ===");
  // An update sends the whole product, as the product form does.
  const teeBody = { productId: "tee", type: "shirt", name: "Club Tee", pricingMode: "sized", sizePricing: { S: 20, M: 20, L: 22 }, visible: true, weightOz: 6, noDesignNeeded: true, personalizationPrice: 5 };
  const update = (fields) => admin({ action: "updateProduct", ...teeBody, ...fields });
  r = await update({ qtyBreaks: [{ minQty: 12, off: 2 }, { minQty: 36, off: 4 }] });
  ok("new breaks are saved", r.status === 200 && storedBreaks("tee") === '[{"minQty":12,"offCents":200},{"minQty":36,"offCents":400}]');
  ok("…and logged as product.qty_breaks_changed with what they were and what they are", same(breakAudits("tee").slice(-1)[0],
    { productId: "tee", from: [{ minQty: 12, off: 2 }, { minQty: 24, off: 3.5 }], to: [{ minQty: 12, off: 2 }, { minQty: 36, off: 4 }] }));
  let n0 = breakAudits("tee").length;
  r = await update({ qtyBreaks: [{ minQty: 36, off: 4 }, { minQty: 12, off: 2 }] });
  ok("the same breaks sent again (in another order) change nothing and log nothing", r.status === 200 && breakAudits("tee").length === n0 && storedBreaks("tee") === '[{"minQty":12,"offCents":200},{"minQty":36,"offCents":400}]');
  r = await update({ name: "Club Tee Classic" });
  ok("a save that doesn't send breaks keeps the ones the product has, and logs no break change", r.status === 200 && (await listed("tee")).name === "Club Tee Classic" &&
    storedBreaks("tee") === '[{"minQty":12,"offCents":200},{"minQty":36,"offCents":400}]' && breakAudits("tee").length === n0);
  r = await update({ sizePricing: undefined, qtyBreaks: [{ minQty: 12, off: 20 }] });
  ok("breaks sent without prices are held under the prices the product has ($20.00)", r.status === 400 && r.body.message === "The break from 12 pieces takes $20.00 off — it must be less than the lowest price, $20.00." &&
    breakAudits("tee").length === n0);
  r = await update({ sizePricing: { S: 4, M: 20, L: 22 }, qtyBreaks: [{ minQty: 12, off: 2 }, { minQty: 36, off: 4 }] });
  ok("breaks sent with new prices are held under the new prices", r.status === 400 && r.body.message === "The break from 36 pieces takes $4.00 off — it must be less than the lowest price, $4.00.");
  ok("…and the refused save changes neither the prices nor the breaks", (await listed("tee")).sizePricing.S === 20 && storedBreaks("tee") === '[{"minQty":12,"offCents":200},{"minQty":36,"offCents":400}]');
  r = await update({ qtyBreaks: "lots" });
  ok("an update's breaks are checked as a new product's are", r.status === 400 && r.body.message === "Quantity breaks must be a list.");
  r = await update({ qtyBreaks: [] });
  ok("an empty list clears the breaks, logged from what they were to none", r.status === 200 && storedBreaks("tee") === "[]" &&
    same(breakAudits("tee").slice(-1)[0], { productId: "tee", from: [{ minQty: 12, off: 2 }, { minQty: 36, off: 4 }], to: [] }));
  o = await shop([{ productId: "tee", size: "S", qty: 12 }]);
  ok("…and the storefront prices the cleared product at full price", o.status === 200 && await prices(o.orderId) === "S:20");
  r = await update({ qtyBreaks: [{ minQty: 6, off: 1 }] });
  o = await shop([{ productId: "tee", size: "S", qty: 6 }]);
  ok("a changed break is what the next order is priced with", r.status === 200 && o.status === 200 && await prices(o.orderId) === "S:19");

  console.log("\n=== The vendor's MAP at the deepest break ===");
  const blank = await S.createBlank(d1, { name: "Example Blank Polo", productType: "shirt" }, [{ size: "S", quantity: 0 }]);
  d1._raw.run("UPDATE blank_sizes SET mapPriceCents = 1800 WHERE blankId = ?", [blank.id]);
  const polo = { productId: "polo", type: "shirt", name: "Club Polo", pricingMode: "sized", sizePricing: { S: 20 }, visible: true, noDesignNeeded: true };
  r = await admin({ action: "createProduct", ...polo });
  await S.setBlankLink(d1, "acme", "polo", "", "S", blank.id, "", "S");
  ok("the polo ($20.00) is linked to a blank whose MAP is $18.00", r.status === 200 && (q1("SELECT count(*) AS n FROM product_blank_links WHERE productId = 'polo'") || {}).n === 1);
  n0 = breakAudits("polo").length;
  r = await admin({ action: "createProduct", ...polo, qtyBreaks: [{ minQty: 12, off: 3 }] });
  ok("createProduct (the product saved again under its id) refuses a break that takes the price under MAP, with code belowMap, naming the break",
    r.status === 400 && r.body.code === "belowMap" && r.body.message === "Below the vendor's minimum advertised price (MAP): S at the 12+ pieces break, $17.00, is below the MAP of $18.00 (Example Blank Polo S). Raise the price to at least the MAP.");
  ok("…and saves and logs nothing", storedBreaks("polo") === "[]" && breakAudits("polo").length === n0);
  r = await admin({ action: "createProduct", ...polo, qtyBreaks: [{ minQty: 12, off: 2 }] });
  ok("a break that leaves the price exactly at MAP is fine", r.status === 200 && storedBreaks("polo") === '[{"minQty":12,"offCents":200}]' && breakAudits("polo").length === n0 + 1);
  r = await admin({ action: "updateProduct", ...polo, qtyBreaks: [{ minQty: 12, off: 2 }, { minQty: 24, off: 2.5 }] });
  ok("updateProduct holds the DEEPEST break to MAP", r.status === 400 && r.body.code === "belowMap" && /S at the 24\+ pieces break, \$17\.50, is below the MAP of \$18\.00/.test(r.body.message) &&
    storedBreaks("polo") === '[{"minQty":12,"offCents":200}]');
  r = await admin({ action: "updateProduct", ...polo, sizePricing: { S: 19.5 } });
  ok("a new price that takes the product's own break under MAP is refused, though no breaks were sent", r.status === 400 && r.body.code === "belowMap" &&
    /S at the 12\+ pieces break, \$17\.50, is below the MAP of \$18\.00/.test(r.body.message) && (await listed("polo")).sizePricing.S === 20);
  r = await admin({ action: "updateProduct", ...polo, sizePricing: { S: 21 }, qtyBreaks: [{ minQty: 12, off: 3 }] });
  ok("a higher price and a deeper break that still meet MAP are saved, and logged", r.status === 200 && (await listed("polo")).sizePricing.S === 21 &&
    same(breakAudits("polo").slice(-1)[0], { productId: "polo", from: [{ minQty: 12, off: 2 }], to: [{ minQty: 12, off: 3 }] }));
  r = await admin({ action: "createProduct", productId: "tote", type: "other", name: "Club Tote", pricingMode: "flat", flatPrice: 5, visible: true, noDesignNeeded: true, qtyBreaks: [{ minQty: 12, off: 4 }] });
  ok("a new product with no blanks linked has no MAP to meet", r.status === 200 && storedBreaks("tote") === '[{"minQty":12,"offCents":400}]');

  console.log("\n=== Who may save breaks (the real sign-in, adminAuth.js) ===");
  {
    const A = await auth.makeAuth();
    const post = new Function("__hits", auth.prelude(false, false) + auth.strip(auth.read("functions/_lib/catalogValidation.js")) + "\n" + auth.strip(auth.read("functions/_lib/quoteToken.js")) + "\n" +
      "const invalidateCatalogVersionCache = () => {}; const selectBox = () => null;\n" +
      auth.strip(auth.read("functions/_lib/setupStatus.js")) + "\n" + auth.strip(auth.read("functions/_lib/vendorCredentials.js")) + "\n" + auth.strip(auth.read("functions/_lib/smtp.js")) + "\n" +
      auth.strip(auth.read("functions/_lib/email.js")) + "\n" + auth.strip(auth.read("functions/api/orders.js")) + "\nreturn onRequestPost;")(A.hits);
    const call = async (body, cookie) => {
      const waits = [];
      const res = await post({ request: auth.request("/api/orders", body, { cookie }), env: A.env, waitUntil: (p) => waits.push(Promise.resolve(p).catch(() => {})) });
      await Promise.all(waits);
      return auth.answer(res);
    };
    A.d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('acme','acme','Example Club','t','t',1);`);
    const owner = await A.firstAdmin("Olive Owner", "olive@example.com");
    const staff = await A.addUser(owner, "staff", "Sam Staff", "sam@example.com");
    const prod = await A.addUser(owner, "production", "Pat Production", "pp@example.com");
    const cap = { org: "acme", productId: "cap", type: "cap", name: "Club Cap", pricingMode: "flat", flatPrice: 15, visible: true, noDesignNeeded: true };
    const stored = () => (A.d1.q("SELECT qtyBreaksJson FROM products WHERE productId = 'cap'")[0] || {}).qtyBreaksJson;
    const logged = () => A.d1.q("SELECT count(*) AS n FROM audit_log WHERE action = 'product.qty_breaks_changed'")[0].n;
    r = await call({ action: "createProduct", ...cap, qtyBreaks: [{ minQty: 12, off: 1 }] }, prod);
    ok("Production (no catalog edit) can't make a product with breaks: 403, nothing saved or logged", r.status === 403 && stored() === undefined && logged() === 0);
    r = await call({ action: "createProduct", ...cap, qtyBreaks: [{ minQty: 12, off: 1 }] }, staff);
    ok("Back office (catalog edit) can, and it is logged", r.status === 200 && stored() === '[{"minQty":12,"offCents":100}]' && logged() === 1);
    r = await call({ action: "updateProduct", ...cap, qtyBreaks: [{ minQty: 12, off: 2 }] }, prod);
    ok("Production can't change a product's breaks either", r.status === 403 && stored() === '[{"minQty":12,"offCents":100}]' && logged() === 1);
    r = await call({ action: "updateProduct", ...cap, qtyBreaks: [{ minQty: 12, off: 2 }] }, staff);
    ok("…and Back office can", r.status === 200 && stored() === '[{"minQty":12,"offCents":200}]' && logged() === 2);
    r = await call({ action: "updateProduct", ...cap, qtyBreaks: [{ minQty: 12, off: 3 }] }, "");
    ok("nobody signed in can't (401)", r.status === 401 && stored() === '[{"minQty":12,"offCents":200}]' && logged() === 2);
  }

  console.log("\n=== A database a migration behind (before 0109) ===");
  {
    const old = await newDb("0109");
    const h = harness(old);
    const oldBreaks = () => old.q("SELECT detail FROM audit_log WHERE action = 'product.qty_breaks_changed'").filter(x => JSON.parse(x.detail).productId === "tee");
    r = await h.admin({ action: "createProduct", productId: "tee", type: "shirt", name: "Club Tee", pricingMode: "sized", sizePricing: { S: 20, M: 20 }, visible: true, weightOz: 6, noDesignNeeded: true });
    ok("a product is still made", r.status === 200);
    r = await h.admin({ action: "createProduct", productId: "cap", type: "cap", name: "Club Cap", pricingMode: "flat", flatPrice: 15, visible: true, noDesignNeeded: true, qtyBreaks: [{ minQty: 12, off: 1 }] });
    const capOld = ((await h.admin({ action: "listProducts" })).body.products || []).find(p => p.productId === "cap") || {};
    ok("…one sent with breaks too: it is made, without them", r.status === 200 && same(capOld.qtyBreaks, []));
    r = await h.admin({ action: "updateProduct", productId: "tee", type: "shirt", name: "Club Tee", pricingMode: "sized", sizePricing: { S: 20, M: 20 }, visible: true, weightOz: 6, noDesignNeeded: true,
      qtyBreaks: [{ minQty: 12, off: 2 }] });
    ok("breaks sent to it are left out without an error, and no change is logged (there is nowhere to keep them)", r.status === 200 && oldBreaks().length === 0);
    const listedOld = ((await h.admin({ action: "listProducts" })).body.products || [])[0] || {};
    ok("…the product list says it has none", same(listedOld.qtyBreaks, []));
    o = await h.shop([{ productId: "tee", size: "S", qty: 6 }, { productId: "tee", size: "M", qty: 6 }]);
    const oldPrices = async (orderId) => ((await S.getOrderById(old, orderId)) || { items: [] }).items.map(i => i.size + ":" + i.unitPrice).join(" ");
    ok("a storefront order is taken at full price", o.status === 200 && await oldPrices(o.orderId) === "S:20 M:20");
    o = await h.admin({ action: "createLocalSale", items: [{ productId: "tee", size: "S", qty: 12 }] });
    ok("a local sale too", o.status === 200 && await oldPrices(o.body.orderId) === "S:20");
    r = await h.admin({ action: "editOrder", orderId: o.body.orderId, additions: [{ productId: "tee", size: "M", qty: 12 }] });
    ok("and Edit items too", r.status === 200 && await oldPrices(o.body.orderId) === "S:20 M:20");
  }
})().catch(e => { console.error(e); console.log("test313 crashed: false"); process.exit(1); });
