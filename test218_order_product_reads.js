const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { ADMIN_ORIGIN, shopOrigin } = require("./testlib/hosts.js");

// Placing an order and saving a product read only the products they need. A storefront order reads its cart's products
// (for the parcel's weight and the box) once, not the shop's whole catalog two or three times; insertOrder reads only the
// order's products for their taxable flags and stock, and checks order_items' columns once per database, not per order;
// the admin's product save reads that one product for the audit's before / after. What is charged and recorded doesn't
// change. Real migrations, db.js and orders.js on sql.js.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js")), hostSrc = strip(read("functions/_lib/hostConfig.js")), httpSrc = strip(read("functions/_lib/http.js"));
const lib = new Function(dbSrc + `\nreturn { createProduct, getOrderById, getProductsByOrg, getProductsByIds, insertOrder, setBlankLink };`)();
const api = new Function(hostSrc + "\n" + httpSrc + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test'; const adminUser = () => null; const copyVendorImage = async () => ({ ok: false });\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: { pine: 'pine' }, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('pine','pine','Pine Club','t','t',1);
    INSERT OR REPLACE INTO global_settings (key, value) VALUES ('salesTax', '{"rateBps":600,"jurisdiction":"OH","taxMode":"exclusive"}');`);
  await lib.createProduct(d1, "pine", { productId: "cap", type: "cap", name: "Club Cap", pricingMode: "flat", flatPrice: 25, visible: true, noDesignNeeded: true, weightOz: 4 });
  await lib.createProduct(d1, "pine", { productId: "tee", type: "shirt", name: "Club Tee", pricingMode: "sized", sizePricing: { M: 20, L: 22 }, visible: true, taxable: false, noDesignNeeded: true });
  for (let i = 1; i <= 30; i++) await lib.createProduct(d1, "pine", { productId: "other" + i, type: "shirt", name: "Other " + i, pricingMode: "flat", flatPrice: 9, visible: true, noDesignNeeded: true });
  // The tee's weight comes from its linked blank (migrations/0077).
  d1._raw.exec(`INSERT INTO blanks (id, name, createdAt, updatedAt) VALUES (1, 'Plain Tee Blank', 't', 't');
    INSERT INTO blank_sizes (blankId, color, size, quantity, weightOz) VALUES (1, 'White', 'M', 0, 6), (1, 'White', 'L', 0, 7);`);
  await lib.setBlankLink(d1, "pine", "tee", "", "M", 1, "White", "M");
  await lib.setBlankLink(d1, "pine", "tee", "", "L", 1, "White", "L");

  const sqls = [];
  const DB = { prepare: (sql) => { sqls.push(sql); return d1.prepare(sql); }, batch: (s) => d1.batch(s) };
  const post = async (url, body) => { const res = await api({ env: { DB }, waitUntil: (p) => Promise.resolve(p).catch(() => {}),
    request: { url, json: async () => body, headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) }; };
  const shop = (body) => post(shopOrigin("pine") + "/api/orders", Object.assign({ orgId: "pine", customerName: "Sam Example", contact: "sam@example.com", paymentMethod: "Venmo", deliveryOptionId: "pickup" }, body));
  const wholeCatalog = (q) => /FROM products WHERE orgId\s*=\s*\?( AND visible\s*=\s*1)?( ORDER BY [^)]*)?$/i.test(q.trim()) && /SELECT \*/.test(q);
  const allDesigns = (q) => /FROM product_designs WHERE orgId=\? ORDER BY/.test(q);

  console.log("=== getProductsByIds: the named products, as getProductsByOrg has them ===");
  const all = await lib.getProductsByOrg(d1, "pine", false);
  const some = await lib.getProductsByIds(d1, "pine", ["tee", "cap", "tee", "nope"]);
  ok("the same products, designs and blank weights, unknown ids left out", JSON.stringify(some) === JSON.stringify(all.filter(p => ["tee", "cap"].includes(p.productId))));
  ok("…the tee's weight from its blank", some.find(p => p.productId === "tee").blankWeightBySize.L === 7);
  ok("no ids: nothing, and nothing read", (await lib.getProductsByIds(d1, "pine", [])).length === 0);

  console.log("\n=== A storefront order reads only its cart's products ===");
  sqls.length = 0;
  let r = await shop({ orderId: "PINE-1", items: [{ productId: "cap", size: "OSFA", qty: 2 }, { productId: "tee", size: "L", qty: 1 }] });
  ok("the order is placed", r.status === 200 && r.body.status === "ok");
  ok("…the whole catalog is never read (products or designs)", !sqls.some(wholeCatalog) && !sqls.some(allDesigns));
  ok("…the cart's products are read once for the parcel", sqls.filter(q => /FROM products WHERE orgId=\? AND productId IN \(SELECT value FROM json_each/.test(q) && /ORDER BY sortOrder/.test(q)).length === 1);
  const o = await lib.getOrderById(d1, "PINE-1");
  ok("…charged as before: $50 + $22, tax only on the taxable cap (6% of $50 = $3)", o.subtotal === 72 && o.salesTax === 3 && o.total === 75);
  ok("…weighed from the catalog: 2 × 4 oz caps + a 7 oz tee", o.totalWeightOz === 15);

  console.log("\n=== insertOrder reads only the order's products, and checks its columns once ===");
  sqls.length = 0;
  await lib.insertOrder(DB, { orderId: "PINE-2", orgId: "pine", customerName: "Sam Example", contact: "sam@example.com", placedAt: new Date().toISOString() },
    [{ productId: "tee", name: "Club Tee", type: "shirt", size: "M", qty: 1, unitPrice: 20 }, { productId: "__custom__", name: "Hemming", type: "", size: "", qty: 1, unitPrice: 5, taxable: true }]);
  await lib.insertOrder(DB, { orderId: "PINE-3", orgId: "pine", customerName: "Sam Example", contact: "sam@example.com", placedAt: new Date().toISOString() },
    [{ productId: "cap", name: "Club Cap", type: "cap", size: "OSFA", qty: 1, unitPrice: 25 }]);
  ok("no whole-catalog read", !sqls.some(wholeCatalog));
  ok("order_items' columns checked once for two orders", sqls.filter(q => /PRAGMA table_info\(order_items\)/.test(q)).length <= 1);
  const two = await lib.getOrderById(d1, "PINE-2"), three = await lib.getOrderById(d1, "PINE-3");
  ok("…taxable flags still from the catalog: the tee untaxed, the custom line and the cap taxed (6% of $5; 6% of $25)", two.salesTax === 0.3 && three.salesTax === 1.5);

  console.log("\n=== Saving a product reads that product, not the catalog ===");
  sqls.length = 0;
  r = await post(ADMIN_ORIGIN + "/api/orders", { key: "x", action: "updateProduct", org: "pine", productId: "cap", type: "cap", name: "Club Cap", pricingMode: "flat", flatPrice: 26, visible: true, images: [], noDesignNeeded: true, weightOz: 4 });
  ok("the save goes through", r.status === 200 && r.body.status === "ok");
  ok("…without reading the whole catalog for the audit", !sqls.some(wholeCatalog));
  const audit = d1.q("SELECT detail FROM audit_log WHERE action LIKE 'product.%' ORDER BY id DESC LIMIT 1")[0];
  ok("…and the audit still records the change", audit && /"flatPrice":\{"from":25,"to":26\}/.test(audit.detail));

  console.log(`\n${pass} passed, ${fail} failed`);
})().catch(e => { console.error(e); console.log("test crashed:", false); process.exit(1); });
