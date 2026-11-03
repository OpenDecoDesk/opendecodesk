const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { ADMIN_ORIGIN } = require("./testlib/hosts.js");

// Finished stock per combination (migrations/0080): a product with color and graphic choices is stocked per
// garment color + graphic (and ink) at each spot + size. Make for stock / Correct count take the combination (checked
// as an order's picks are), an order line is filled only from its exact combination's stock, pulled when made and put
// back on a cancel, and the shop page builds the same key from its picks (index.html's stockVariantKey_ ==
// db.js's stockVariantKey). A product with no choices keeps the '' combination — and a plain line carrying only
// automatic parts (printed transfers, the reorder QR) can now be filled from stock too. Real migrations, db.js and
// orders.js on sql.js.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js")), hostSrc = strip(read("functions/_lib/hostConfig.js")), httpSrc = strip(read("functions/_lib/http.js"));
const lib = new Function(dbSrc + `\nreturn { createBlank, receiveBlanks, createProduct, setBlankLink, insertOrder, priceItem, settleOrderBalance, getOrderById,
  getReadyToShipByOrg, getFinishedStock, setFulfillmentStage, cancelLineItem, getFinishedGoodsValuation, stockVariantKey, getProductionQueue };`)();
const api = new Function(hostSrc + "\n" + httpSrc + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test'; const adminUser = () => null;\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: { acme: 'acme' }, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const migrations = fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort();

(async () => {
  console.log("=== The migration ===");
  {
    const old = await createD1();
    old._raw.exec(read("testlib/schema-pre-0006.sql"));
    for (const f of migrations.filter(f => f < "0080")) old.execFile(read("migrations/" + f));
    old._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('acme','acme','Acme','t','t',1);
      INSERT INTO ready_to_ship (orgId, productId, size, quantity, updatedAt, avgCostCents) VALUES ('acme','tee','M',5,'t',412);
      INSERT INTO finished_goods_movements (orgId, productId, size, qtyDelta, unitCostCents, kind, occurredAt, createdAt) VALUES ('acme','tee','M',5,412,'opening','t','t');`);
    old.execFile(read("migrations/0080_stock_combinations.sql"));
    const row = old.q("SELECT * FROM ready_to_ship")[0];
    ok("existing stock keeps its count and cost, as the no-choices ('') combination", row.quantity === 5 && row.avgCostCents === 412 && row.variant === "" && row.variantLabel === "");
    ok("…movements and order lines get the column too", old.q("SELECT variant FROM finished_goods_movements")[0].variant === "" &&
      old.q("PRAGMA table_info(order_items)").some(c => c.name === "stockVariant"));
    old._raw.exec(`INSERT INTO ready_to_ship (orgId, productId, size, variant, quantity, updatedAt) VALUES ('acme','tee','M','["Navy",[]]',1,'t')`);
    let dup = false; try { old._raw.exec(`INSERT INTO ready_to_ship (orgId, productId, size, variant, quantity, updatedAt) VALUES ('acme','tee','M','',1,'t')`); } catch (e) { dup = true; }
    ok("one row per shop + product + size + combination", dup && old.q("SELECT count(*) n FROM ready_to_ship")[0].n === 2);
  }

  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of migrations) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('acme','acme','Acme','t','t',1);
    INSERT INTO graphics (id, orgId, name, kind, inkColorsJson, visible, createdAt, updatedAt) VALUES
      (11,'acme','Crest','embroidery','[]',1,'t','t'), (12,'acme','Script','embroidery','["Gold","Silver"]',1,'t','t'), (13,'acme','Other','embroidery','[]',1,'t','t');`);
  const call = async (body) => { const res = await api({ env: { DB: d1 }, waitUntil: (p) => Promise.resolve(p).catch(() => {}),
      request: { url: ADMIN_ORIGIN + "/api/orders", json: async () => Object.assign({ key: "x", org: "acme" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) }; };
  const blankQty = (color, size) => Number(d1.q(`SELECT quantity FROM blank_sizes WHERE blankId=${polo} AND color='${color}' AND size='${size}'`)[0].quantity);

  const polo = (await lib.createBlank(d1, { name: "Sample polo", productType: "shirt", colors: ["Navy", "Black"].map(color => ({ color, images: [], sizes: ["M", "L"].map(size => ({ size, purchasePrice: 0, quantity: 0 })) })) })).id;
  await lib.receiveBlanks(d1, { blankId: polo, lines: [{ color: "Navy", size: "M", qty: 10, unitCost: 5 }, { color: "Black", size: "M", qty: 10, unitCost: 6 }], vendor: "Vendor", receivedAt: "2026-10-01T12:00:00.000Z" });
  await lib.createProduct(d1, "acme", { productId: "polo", type: "shirt", name: "Club Polo", pricingMode: "sized", sizePricing: { M: 30, L: 30 }, visible: true, configurable: true, garmentColors: ["Navy", "Black"] });
  d1._raw.exec(`UPDATE products SET locationsJson = '[{"key":"lc","label":"Left chest","graphicIds":[11,12]},{"key":"back","label":"Back","graphicIds":[11]}]' WHERE productId='polo'`);
  for (const c of ["Navy", "Black"]) await lib.setBlankLink(d1, "acme", "polo", c, "M", polo, c, "M");

  console.log("\n=== The combination key ===");
  const K = lib.stockVariantKey;
  ok("color + picks in location order, ink kept; nothing picked and no color = ''", K("Navy", [{ location: "lc", graphicId: 12, ink: "Gold" }, { location: "back", graphicId: 11 }]) === '["Navy",[["back",11,""],["lc",12,"Gold"]]]' &&
    K("", []) === "" && K("Navy", [{ location: "lc", graphicId: null }]) === '["Navy",[]]');
  // The shop page builds the same string from its picks (a graphic with inks and none picked = its first ink).
  const html = read("public/index.html");
  const fnSrc = html.slice(html.indexOf("function stockVariantKey_("), html.indexOf("// The stock badge for a product in a color + size"));
  const badgeSrc = html.slice(html.indexOf("function readyBadgeHtml_("), html.indexOf("function renderConfigurableProduct("));
  const shop = new Function(fnSrc + badgeSrc + "\nreturn { stockVariantKey_, readyBadgeHtml_ };")();
  const gCrest = { id: 11, inkColors: [] }, gScript = { id: 12, inkColors: ["Gold", "Silver"] };
  ok("the shop page's key equals the server's for the same picks", shop.stockVariantKey_("Navy", [{ location: "lc", graphic: gScript, ink: "" }, { location: "back", graphic: gCrest, ink: "" }]) ===
    K("Navy", [{ location: "lc", graphicId: 12, ink: "Gold" }, { location: "back", graphicId: 11, ink: "" }]));
  ok("…and the customer's own design is never from stock", shop.stockVariantKey_("Navy", [{ location: "lc", custom: true, graphic: { id: "custom" } }]) === null);

  console.log("\n=== Make for stock / Correct count ===");
  let r = await call({ action: "makeForStock", productId: "polo", size: "M", qty: 4, color: "Navy", picks: [{ location: "lc", graphicId: 11 }] });
  const navyCrest = K("Navy", [{ location: "lc", graphicId: 11 }]);
  ok("4 Navy M polos with the Crest on the left chest made for stock", r.status === 200 && r.body.variant === navyCrest && r.body.variantLabel === "Navy · Left chest: Crest" && r.body.unitCost === 5);
  ok("…the Navy M blanks went down by 4, the Black ones didn't", blankQty("Navy", "M") === 6 && blankQty("Black", "M") === 10);
  ok("…stored under that combination, with its label", d1.q(`SELECT quantity, variantLabel FROM ready_to_ship WHERE productId='polo'`).map(x => x.quantity + "|" + x.variantLabel).join() === "4|Navy · Left chest: Crest");
  r = await call({ action: "makeForStock", productId: "polo", size: "M", qty: 2, color: "Black", picks: [{ location: "lc", graphicId: 12 }] });
  ok("a graphic with inks and none picked is stocked as its first ink (as an order would be)", r.status === 200 && r.body.variantLabel === "Black · Left chest: Script (Gold)" && blankQty("Black", "M") === 8);
  const blackScript = r.body.variant;
  r = await call({ action: "makeForStock", productId: "polo", size: "M", qty: 1, color: "Navy", picks: [{ location: "lc", graphicId: 13 }] });
  ok("a graphic this spot doesn't offer is refused", r.status === 409 && /isn't available/.test(r.body.message));
  r = await call({ action: "makeForStock", productId: "polo", size: "M", qty: 1, color: "Red", picks: [{ location: "lc", graphicId: 11 }] });
  ok("…and a color the product doesn't offer", r.status === 409 && /color/.test(r.body.message));
  r = await call({ action: "makeForStock", productId: "polo", size: "M", qty: 1, color: "Navy", picks: [] });
  ok("…and a blank garment (no graphic picked)", r.status === 409 && /Pick at least one graphic/.test(r.body.message));
  r = await call({ action: "makeForStock", productId: "polo", size: "L", qty: 1, color: "Navy", picks: [{ location: "lc", graphicId: 11 }] });
  ok("…and a color + size not linked to a blank", r.status === 409 && /isn't linked to a blank/.test(r.body.message));
  r = await call({ action: "makeForStock", productId: "polo", size: "M", qty: 1, color: "Navy", picks: "lc" });
  ok("…and picks that aren't a list", r.status === 400);
  r = await call({ action: "setReadyToShipQty", productId: "polo", size: "M", quantity: 5, variant: navyCrest });
  ok("Correct count on a combination already in stock, by its key", r.status === 200 && r.body.delta === 1 && d1.q(`SELECT quantity FROM ready_to_ship WHERE variant='${navyCrest}'`)[0].quantity === 5);
  r = await call({ action: "setReadyToShipQty", productId: "polo", size: "L", quantity: 3, color: "Navy", picks: [{ location: "lc", graphicId: 11 }, { location: "back", graphicId: 11 }] });
  ok("…or a count for a new combination (no blank needed for a count)", r.status === 200 && r.body.delta === 3);
  r = await call({ action: "setReadyToShipQty", productId: "polo", size: "M", quantity: 1, variant: '["Navy",[["lc",99,""]]]' });
  ok("a key that isn't in stock is refused", r.status === 409);
  const fs1 = await lib.getFinishedStock(d1, "acme", "polo");
  ok("the Stock window lists each combination with its sizes", fs1.configurable && fs1.combinations.length === 3 &&
    fs1.combinations.find(c => c.variant === navyCrest).sizes[0].onHand === 5 && fs1.combinations.find(c => c.variant === navyCrest).sizes[0].blank.free === 6);
  ok("…and what can be picked, with the blank behind each color + size", fs1.options.colors.join() === "Navy,Black" && fs1.options.locations[0].graphics.map(g => g.name).join() === "Crest,Script" &&
    fs1.options.locations[0].graphics[1].inkColors.join() === "Gold,Silver" && fs1.links.Black.M.free === 8 && fs1.links.Navy.L === null);
  const shopStock = await lib.getReadyToShipByOrg(d1, "acme");
  ok("the shop's stock answer carries each combination", shopStock.find(x => x.variant === navyCrest).quantity === 5 && shopStock.length === 3);
  const p = { stockVariants: { [navyCrest]: { M: 5 } }, blankStock: { Navy: { L: 2 } } };
  ok("the shop page's badge: N in stock for the picked combination, nothing for another one", /5 in stock/.test(shop.readyBadgeHtml_(p, "Navy", "M", navyCrest)) &&
    !/in stock/.test(shop.readyBadgeHtml_(p, "Navy", "M", K("Navy", [{ location: "lc", graphicId: 12, ink: "Gold" }]))) && /Ships faster/.test(shop.readyBadgeHtml_(p, "Navy", "L", navyCrest)));

  console.log("\n=== Orders ===");
  const place = async (orderId, size, qty, color, locations, extra = {}) => {
    const priced = await lib.priceItem(d1, "acme", "polo", size, qty, false, { garmentColor: color, locations });
    await lib.insertOrder(d1, { orderId, orgId: "acme", customerName: "Alex Sample", contact: "", paymentMethod: "Card", placedAt: new Date().toISOString() },
      [{ productId: "polo", name: priced.name, type: "shirt", size, qty, unitPrice: priced.unitPrice, config: priced.config, ...extra }], { fillFromStock: true });
    return d1.q(`SELECT id, fromStock, stockVariant FROM order_items WHERE orderId='${orderId}'`)[0];
  };
  let line = await place("A-1", "M", 2, "Navy", [{ location: "lc", graphicId: 11 }]);
  ok("an order for a combination in stock is filled from it", line.fromStock === 1 && line.stockVariant === navyCrest);
  ok("…its pieces are set aside (5 on hand, 3 left to sell)", (await lib.getReadyToShipByOrg(d1, "acme")).find(x => x.variant === navyCrest).quantity === 3);
  ok("…and it isn't on Run Order", !(await lib.getProductionQueue(d1)).some(j => j.orderId === "A-1"));
  line = await place("A-2", "M", 1, "Navy", [{ location: "lc", graphicId: 12, ink: "Silver" }]);
  ok("another graphic or ink on the same color isn't filled from that stock", line.fromStock === 0 && line.stockVariant === "");
  line = await place("A-3", "M", 1, "Navy", [{ location: "lc", graphicId: 11 }, { location: "back", graphicId: 11 }]);
  ok("…nor the same graphic plus one more spot", line.fromStock === 0);
  line = await place("A-4", "M", 4, "Navy", [{ location: "lc", graphicId: 11 }]);
  ok("…nor more than is still available (3)", line.fromStock === 0);
  line = await place("A-5", "M", 2, "Black", [{ location: "lc", graphicId: 12, ink: "Gold" }]);
  ok("an ink picked explicitly matches the stock made with the default ink", line.fromStock === 1 && line.stockVariant === blackScript);
  line = await place("A-6", "M", 1, "Navy", [{ location: "lc", graphicId: 11 }], { personalized: true, persName: "ALEX" });
  ok("a personalized line never comes from stock", line.fromStock === 0);

  await lib.settleOrderBalance(d1, "A-1", "test");
  await lib.setFulfillmentStage(d1, "A-1", "manufactured");
  ok("making the order pulls its 2 pieces out of that combination's stock", d1.q(`SELECT quantity FROM ready_to_ship WHERE variant='${navyCrest}'`)[0].quantity === 3 &&
    d1.q(`SELECT kind, variant, variantLabel, qtyDelta FROM finished_goods_movements WHERE orderId='A-1'`).map(m => [m.kind, m.variant === navyCrest, m.variantLabel, m.qtyDelta].join("|")).join() === "sell|true|Navy · Left chest: Crest|-2");
  ok("…at its average cost, as the line's cost of goods", d1.q(`SELECT cogsCents FROM order_items WHERE orderId='A-1'`)[0].cogsCents === 1000);
  await lib.cancelLineItem(d1, d1.q(`SELECT id FROM order_items WHERE orderId='A-1'`)[0].id);
  ok("cancelling the line puts them back into the same combination", d1.q(`SELECT quantity FROM ready_to_ship WHERE variant='${navyCrest}'`)[0].quantity === 5 &&
    d1.q(`SELECT variant FROM finished_goods_movements WHERE orderId='A-1' AND kind='return'`)[0].variant === navyCrest);
  const val = await lib.getFinishedGoodsValuation(d1, "2999-01-01");
  ok("the inventory valuation keeps combinations apart and names them", val.rows.some(x => x.name === "Club Polo · Navy · Left chest: Crest" && x.qty === 5) &&
    val.rows.some(x => /Black · Left chest: Script \(Gold\)/.test(x.name)));

  r = await call({ action: "getFinishedGoodsMovements", productId: "polo" });
  const made = r.body.movements.find(m => m.kind === "make" && m.variant === navyCrest);
  r = await call({ action: "voidFinishedGoodsMovement", movementId: made.id, reason: "Typed by mistake" });
  ok("voiding a make takes it out of that combination only (5 − 4 = 1), and its blanks go back", r.status === 200 &&
    d1.q(`SELECT quantity FROM ready_to_ship WHERE variant='${navyCrest}'`)[0].quantity === 1 && blankQty("Navy", "M") === 10 &&
    d1.q(`SELECT quantity FROM ready_to_ship WHERE variant='${blackScript}'`)[0].quantity === 2);

  console.log("\n=== A product with no choices ===");
  await lib.createProduct(d1, "acme", { productId: "tee", type: "shirt", name: "Plain Tee", pricingMode: "sized", sizePricing: { M: 20 }, visible: true });
  await lib.setBlankLink(d1, "acme", "tee", "", "M", polo, "Black", "M");
  r = await call({ action: "makeForStock", productId: "tee", size: "M", qty: 2 });
  ok("still stocked per size, under the '' combination", r.status === 200 && d1.q("SELECT variant FROM ready_to_ship WHERE productId='tee'")[0].variant === "");
  await lib.insertOrder(d1, { orderId: "B-1", orgId: "acme", customerName: "Alex Sample", contact: "", paymentMethod: "Card", placedAt: new Date().toISOString() },
    [{ productId: "tee", name: "Plain Tee", type: "shirt", size: "M", qty: 1, unitPrice: 20, config: { garmentColor: "", size: "M", plain: true,
      locations: [{ location: "reorderqr", kind: "transfer", transferId: 1, graphicName: "QR", auto: true, addOnCents: 0 }] } }], { fillFromStock: true });
  ok("a plain line carrying only the reorder QR is filled from stock too", d1.q("SELECT fromStock, stockVariant FROM order_items WHERE orderId='B-1'").map(x => x.fromStock + "|" + x.stockVariant).join() === "1|");

  console.log("\n=== Transfers used making stock (migrations/0081) ===");
  // A reorder QR transfer on every product of the shop ($0.40, 10 on hand) and a printed back print to pick ($2.50, 1 on hand).
  d1._raw.exec(`INSERT INTO transfers (id, name, quantity, purchasePriceCents, createdAt, updatedAt) VALUES (1, 'Reorder QR', 10, 40, 't', 't'), (2, 'Back print', 1, 250, 't', 't');
    INSERT INTO transfer_movements (transferId, transferName, qtyDelta, unitCostCents, kind, occurredAt, createdAt) VALUES (1, 'Reorder QR', 10, 40, 'purchase', '2026-10-01', 't'), (2, 'Back print', 1, 250, 'purchase', '2026-10-01', 't');
    UPDATE orgs SET reorderQrTransferId = 1 WHERE orgId = 'acme';
    INSERT INTO graphics (id, orgId, name, kind, transferId, inkColorsJson, visible, createdAt, updatedAt) VALUES (14,'acme','Back print','transfer',2,'[]',1,'t','t');
    UPDATE products SET locationsJson = '[{"key":"lc","label":"Left chest","graphicIds":[11,12]},{"key":"back","label":"Back","graphicIds":[11,14]}]' WHERE productId='polo';`);
  const tq = (id) => d1.q(`SELECT quantity FROM transfers WHERE id=${id}`)[0].quantity;
  const blackBefore = blankQty("Black", "M");
  r = await call({ action: "makeForStock", productId: "polo", size: "M", qty: 2, color: "Black", picks: [{ location: "lc", graphicId: 11 }, { location: "back", graphicId: 14 }] });
  ok("making 2 pieces with a picked transfer graphic + the reorder QR uses 2 of each from transfer stock", r.status === 200 && tq(1) === 8 && tq(2) === -1 && blankQty("Black", "M") === blackBefore - 2);
  ok("…each piece costs its blank + its transfers ($6.00 + $0.40 + $2.50)", r.body.unitCost === 8.9 &&
    d1.q(`SELECT avgCostCents FROM ready_to_ship WHERE variant='${r.body.variant}'`)[0].avgCostCents === 890);
  ok("…and says which transfer is now short (1 back print on hand, 2 used)", r.body.transfers.find(t => t.name === "Back print").short === 1 && r.body.transfers.find(t => t.name === "Reorder QR").short === 0);
  const tmv = d1.q("SELECT transferId, qtyDelta, kind, reason, finishedMovementId FROM transfer_movements WHERE kind <> 'purchase' ORDER BY id");
  const makeRow = d1.q("SELECT id FROM finished_goods_movements WHERE kind='make' ORDER BY id DESC LIMIT 1")[0].id;
  ok("…recorded as 'consume' moved into finished stock, tied to the make", tmv.length === 2 && tmv.every(m => m.kind === "consume" && m.reason === "finished" && m.finishedMovementId === makeRow));
  const comboWithQr = r.body.variant;
  ok("the reorder QR isn't part of the combination (it's on every piece)", comboWithQr === K("Black", [{ location: "lc", graphicId: 11 }, { location: "back", graphicId: 14 }]));
  r = await call({ action: "getInventoryReport", dateFrom: "2020-01-01", dateTo: "2999-12-31" });
  ok("the report: those transfers aren't cost of goods — they went into finished stock", r.body.transfers.totals.cogs === 0 && r.body.transfers.totals.toFinished === 5.8 && r.body.transfers.totals.purchases === 6.5);
  ok("…and the roll-forward still adds up", r.status === 200 && Math.abs(r.body.rollForward.check) < 0.05 && r.body.totals.transfersToFinished === 5.8);
  r = await call({ action: "voidFinishedGoodsMovement", movementId: makeRow, reason: "Typed by mistake" });
  ok("voiding that make puts the transfers (and the blanks) back", r.status === 200 && tq(1) === 10 && tq(2) === 1 && blankQty("Black", "M") === blackBefore &&
    d1.q("SELECT count(*) n FROM transfer_movements WHERE voidedAt IS NULL AND kind = 'consume'")[0].n === 0);
  r = await call({ action: "makeForStock", productId: "tee", size: "M", qty: 3 });
  ok("a product with no choices uses its reorder QR too", r.status === 200 && tq(1) === 7 && r.body.unitCost === 6.4);
  d1._raw.exec(`UPDATE products SET reorderQr = 'none' WHERE productId = 'tee'`);
  r = await call({ action: "makeForStock", productId: "tee", size: "M", qty: 1 });
  ok("…and nothing when it's set to no QR", r.status === 200 && tq(1) === 7 && r.body.transfers.length === 0 && r.body.unitCost === 6);
  r = await call({ action: "makeForStock", productId: "polo", size: "M", qty: 1, variant: navyCrest });
  ok("Make for stock on a combination already in stock re-checks it and uses its QR", r.status === 200 && tq(1) === 6);
  d1._raw.exec(`UPDATE products SET locationsJson = '[{"key":"lc","label":"Left chest","graphicIds":[12]}]' WHERE productId='polo'`);
  r = await call({ action: "makeForStock", productId: "polo", size: "M", qty: 1, variant: navyCrest });
  ok("…refused once the product no longer offers it", r.status === 409);
  r = await call({ action: "setReadyToShipQty", productId: "polo", size: "M", quantity: 0, variant: navyCrest });
  ok("…but its count can still be corrected", r.status === 200 && d1.q(`SELECT quantity FROM ready_to_ship WHERE variant='${navyCrest}'`)[0].quantity === 0);

  console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.log("crashed: false"); process.exit(1); });
