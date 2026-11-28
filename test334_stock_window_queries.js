const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { ADMIN_ORIGIN } = require("./testlib/hosts.js");

// The Stock window (db.js getFinishedStock) in a handful of queries (2026-11, review round 2). It used to look up the
// blank behind every color × size one query at a time (stockLink_, two for a flat product) and read every reservation
// in the install, and the getReadyToShip action worked out the shop's set-aside pieces twice. Now the product's blank
// links are read once and looked up in memory (a flat product's "OSFA" link first, then ''), only those blanks'
// reservations are read, and the set-aside pieces are read once and handed to both. Same answer; the number of
// queries no longer grows with the product's colors × sizes.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { createBlank, createProduct, setBlankLink, insertOrder, getFinishedStock, getBlankReservations, stockLink_, stockVariantKey };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" + require("./testlib/roles").adminAs() + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: { acme: 'acme' }, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

// Every query (prepare) made through it.
function counting(d1) {
  const log = [];
  return { log, db: { prepare: (sql) => { log.push(sql); return d1.prepare(sql); }, batch: (l) => d1.batch(l) } };
}

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('acme','acme','Acme','t','t',1), ('elm','elm','Elm','t','t',1);
    INSERT INTO graphics (id, orgId, name, kind, inkColorsJson, visible, createdAt, updatedAt) VALUES (11,'acme','Crest','embroidery','[]',1,'t','t');`);
  const COLORS = ["Navy", "Black", "White", "Red", "Royal", "Kelly", "Gold", "Maroon", "Grey", "Orange", "Purple", "Pink"];
  const SIZES = ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL"];
  const polo = (await lib.createBlank(d1, { name: "Sample polo", productType: "shirt",
    colors: COLORS.map((color, ci) => ({ color, images: [], sizes: SIZES.map((size, si) => ({ size, purchasePrice: 3 + si, quantity: (ci + si) % 6 })) })) })).id;
  const capBlank = (await lib.createBlank(d1, { name: "Sample cap", productType: "cap", colors: [{ color: "Red", images: [], sizes: [{ size: "OSFA", purchasePrice: 4, quantity: 9 }, { size: "", purchasePrice: 2, quantity: 1 }] }] })).id;
  // A configurable polo in 12 colors × 8 sizes (two pairs not linked), and a small one in 2 × 2.
  const configurable = async (productId, colors, sizes) => {
    await lib.createProduct(d1, "acme", { productId, type: "shirt", name: productId, pricingMode: "sized", sizePricing: Object.fromEntries(sizes.map(s => [s, 30])), visible: true, configurable: true, garmentColors: colors });
    d1._raw.exec(`UPDATE products SET locationsJson = '[{"key":"lc","label":"Left chest","graphicIds":[11]}]' WHERE productId='${productId}'`);
    for (const c of colors) for (const s of sizes) if (!(c === "Red" && s === "M") && !(c === "Pink" && s === "4XL")) await lib.setBlankLink(d1, "acme", productId, c, s, polo, c, s);
  };
  await configurable("polo", COLORS, SIZES);
  await configurable("small", ["Navy", "Black"], ["M", "L"]);
  // Flat products: linked under "OSFA", under '' only, and under both ("OSFA" wins).
  for (const [id, links] of [["cap", ["OSFA"]], ["patch", [""]], ["both", ["OSFA", ""]]]) {
    await lib.createProduct(d1, "acme", { productId: id, type: "cap", name: id, pricingMode: "flat", flatPrice: 15, visible: true });
    for (const sz of links) await lib.setBlankLink(d1, "acme", id, "", sz, capBlank, "Red", sz);
  }
  // A plain sized tee on the same blank, with a size added later that only its stock rows know.
  await lib.createProduct(d1, "acme", { productId: "tee", type: "shirt", name: "tee", pricingMode: "sized", sizePricing: { S: 20, M: 20 }, visible: true });
  for (const s of ["S", "M"]) await lib.setBlankLink(d1, "acme", "tee", "", s, polo, "Navy", s);
  // Finished stock: combinations of the polo, the tee (with an XL row), the cap.
  const navyCrest = lib.stockVariantKey("Navy", [{ location: "lc", graphicId: 11 }]), redCrest = lib.stockVariantKey("Red", [{ location: "lc", graphicId: 11 }]);
  d1._raw.exec(`INSERT INTO ready_to_ship (orgId, productId, size, variant, variantLabel, quantity, updatedAt, avgCostCents) VALUES
    ('acme','polo','M','${navyCrest}','Navy · Left chest: Crest',5,'t',700), ('acme','polo','L','${navyCrest}','Navy · Left chest: Crest',2,'t',710),
    ('acme','polo','M','${redCrest}','Red · Left chest: Crest',1,'t',720),
    ('acme','tee','S','','',4,'t',500), ('acme','tee','XL','','',1,'t',510), ('acme','cap','','','',3,'t',600);`);
  // Orders: Elm's and Acme's lines with their blanks in (reserved), and Acme's lines filled from stock (set aside).
  const order = async (orderId, orgId, productId, size, qty, cfg, extra) => {
    await lib.insertOrder(d1, { orderId, orgId, customerName: "Pat Example", contact: "pat@example.test", placedAt: "2026-11-01T15:00:00.000Z" },
      [{ productId, name: productId, type: "shirt", size, qty, unitPrice: 20 }]);
    d1._raw.run(`UPDATE order_items SET configJson = ? ${extra || ""} WHERE orderId = ?`, [cfg ? JSON.stringify(cfg) : "", orderId]);
  };
  await order("A-1", "acme", "polo", "M", 2, { garmentColor: "Navy" });
  await order("A-2", "acme", "tee", "S", 1, null);
  d1._raw.exec(`UPDATE orders SET blankReceivedAt = '2026-11-02T00:00:00Z' WHERE orderId IN ('A-1','A-2')`);
  await order("S-1", "acme", "polo", "M", 2, { garmentColor: "Navy" }, `, fromStock = 1, stockVariant = '${navyCrest.replace(/'/g, "''")}'`);
  await order("S-2", "acme", "cap", "OSFA", 1, null, ", fromStock = 1, stockVariant = ''");

  // The answer as it was worked out before: stockLink_ one pair at a time, against every reservation in the install.
  const reservedAll = await lib.getBlankReservations(d1);
  const blankBefore = async (p, size, color) => {
    const link = await lib.stockLink_(d1, "acme", p.productId, p.flat ? "flat" : "sized", size, color);
    return link ? { blankId: Number(link.blankId), name: link.blankName || "", color: link.blankColor || "", size: link.blankSize || "", avgCost: link.avg / 100,
      free: Math.max(0, Number(link.quantity) - (reservedAll[[link.blankId, link.blankColor || "", link.blankSize || ""].join("|")] || 0)) } : null;
  };
  const sameBlank = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  console.log("=== The same answer ===");
  const fs1 = await lib.getFinishedStock(d1, "acme", "polo");
  let linksOk = Object.keys(fs1.links).join() === COLORS.join();
  for (const c of COLORS) for (const s of SIZES) linksOk = linksOk && sameBlank(fs1.links[c][s], await blankBefore(fs1, s, c));
  ok("the polo's blank behind each of its 96 color × size pairs, with its free count, as looked up one by one", linksOk);
  ok("…the two pairs with no link have none, and a reservation counts (Navy M: on hand less Acme's 2 in)", fs1.links.Red.M === null && fs1.links.Pink["4XL"] === null &&
    fs1.links.Navy.M.free === Math.max(0, (0 + 2) % 6 - 2) && reservedAll[`${polo}|Navy|M`] === 2);
  const combos = fs1.combinations;
  let comboOk = combos.length === 2;
  for (const c of combos) for (const r of c.sizes) comboOk = comboOk && sameBlank(r.blank, await blankBefore(fs1, r.size, c.color));
  ok("each combination in stock: its sizes, on hand, set aside (by order) and the blank behind it", comboOk &&
    combos.find(c => c.variant === navyCrest).sizes.find(r => r.size === "M").setAside === 2 && combos.find(c => c.variant === navyCrest).sizes.find(r => r.size === "M").setAsideOrders.join() === "S-1" &&
    combos.find(c => c.variant === redCrest).sizes[0].blank === null);
  const tee = await lib.getFinishedStock(d1, "acme", "tee");
  ok("a plain product: each size (one known only from its stock) and its blank", tee.sizes.map(r => r.size).join() === "S,M,XL" &&
    sameBlank(tee.sizes[0].blank, await blankBefore(tee, "S", "")) && tee.sizes[0].blank.free === 1 - 1 && tee.sizes[2].blank === null && tee.sizes[0].onHand === 4);
  const flat = {};
  for (const id of ["cap", "patch", "both"]) flat[id] = (await lib.getFinishedStock(d1, "acme", id)).sizes[0].blank;
  ok("a flat product's link: under \"OSFA\", else under '', and \"OSFA\" first when it has both", flat.cap.size === "OSFA" && flat.patch.size === "" && flat.both.size === "OSFA" &&
    sameBlank(flat.cap, await blankBefore({ productId: "cap", flat: true }, "", "")) && sameBlank(flat.patch, await blankBefore({ productId: "patch", flat: true }, "", "")) &&
    sameBlank(flat.both, await blankBefore({ productId: "both", flat: true }, "", "")));

  console.log("\n=== A handful of queries, whatever the size of the product ===");
  const big = counting(d1), small = counting(d1);
  await lib.getFinishedStock(big.db, "acme", "polo");
  await lib.getFinishedStock(small.db, "acme", "small");
  ok(`12 colors × 8 sizes takes the same queries as 2 × 2 (${big.log.length})`, big.log.length === small.log.length && big.log.length <= 10 || (console.log("   ", big.log.length, small.log.length), false));
  ok("…the links read once, for this product", big.log.filter(q => /FROM product_blank_links l/.test(q)).length === 1);
  ok("…and only those blanks' reservations (not every link in the install)", big.log.some(q => /FROM product_blank_links WHERE blankId IN \(SELECT value FROM json_each/.test(q)) &&
    !big.log.some(q => /FROM product_blank_links\s*$/.test(q.trim())));

  console.log("\n=== The Stock window's request ===");
  const call = async (db, body) => { const res = await api({ env: { DB: db }, waitUntil: (p) => Promise.resolve(p).catch(() => {}),
      request: { url: ADMIN_ORIGIN + "/api/orders", json: async () => Object.assign({ key: "x", org: "acme" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) }; };
  const c = counting(d1);
  const r = await call(c.db, { action: "getReadyToShip", productId: "polo" });
  const setAsideReads = c.log.filter(q => /WHERE oi\.fromStock = 1 AND oi\.cancelDate IS NULL/.test(q)).length;
  ok("the shop's available counts and the polo's window, with the set-aside pieces read once for both", r.status === 200 && setAsideReads === 1 &&
    r.body.stock.find(x => x.productId === "polo" && x.variant === navyCrest && x.size === "M").quantity === 3 &&
    JSON.stringify(r.body.finished) === JSON.stringify(fs1) || (console.log("   set-aside reads:", setAsideReads), false));

  console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error(e); console.log("test334 crashed: false"); process.exit(1); });
