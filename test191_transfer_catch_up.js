const fs = require("fs");
const { may, lowest } = require("./testlib/roles");   // the built-in roles (functions/_lib/permissions.js)
const { createD1 } = require("./testlib/d1-shim.js");

// Use transfers for past orders (Inventory & COGS). A made line whose transfers never left stock — its saved
// options name them but it was made some other way ("order"), or it was placed before its product carried a
// transfer and saved no options ("product") — gets a consume dated when the order was made, at the transfer's
// average cost then, and later uses whose cost moves because of it are re-costed. Real SQL + real db.js + real orders.js.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { createTransfer, createGraphic, transfersInHand_, consumeLineTransfersOnce_ };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendOrderNotificationEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false;\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();

let failed = 0;
const admin_ = () => { const a = read("public/admin.js"); const i = a.indexOf("async function showTransferCatchUp_("); return a.slice(i, a.indexOf("\nconst WRITEOFF_REASONS_", i)); };
const ok = (label, cond) => { console.log(label + ": " + !!cond); if (!cond) failed++; };

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('ac','ac','AC','t','t');
    INSERT INTO products (productId, orgId, type, name, pricingMode, flatPrice, sizePricing, createdAt, updatedAt) VALUES
      ('cap','ac','cap','Cap','flat',20,'{}','t','t'), ('emb','ac','cap','Embroidered cap','flat',20,'{}','t','t');`);
  // Orders: [orderId, product, line count]; their made date, test flag and saved options are set after the migrations.
  const orderSpec = [["O1", "cap", 2], ["O2", "cap", 1], ["O3", "cap", 1], ["O4", "emb", 1], ["O5", "cap", 1], ["O6", "cap", 1], ["O7", "cap", 1]];
  for (const [id, prod, n] of orderSpec) {
    d1._raw.run(`INSERT INTO orders (orderId, orgId, customerName, contact, paymentMethod, paid, subtotal, total, placedAt) VALUES (?, 'ac', ?, 'c@x', 'Card', 1, 20, 20, '2026-10-01T00:00:00Z')`, [id, "Cust " + id]);
    for (let i = 0; i < n; i++) d1._raw.run(`INSERT INTO order_items (orderId, orgId, productId, name, type, qty, unitPrice, lineTotal, cancelDate) VALUES (?, 'ac', ?, 'Cap', 'cap', 1, 20, 20, '')`, [id, prod]);
  }
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const call = async (body) => {
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => p.then(() => {}, () => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  await call({ action: "saveVendor", vendor: { name: "DTF Co", forTransfers: true } });
  const QR = await lib.createTransfer(d1, { name: "Shop QR" });
  d1._raw.run("UPDATE orgs SET reorderQrTransferId = ? WHERE orgId = 'ac'", [QR]);
  d1._raw.run("UPDATE products SET reorderQr = 'none' WHERE productId = 'emb'");
  const qrCfg = JSON.stringify({ garmentColor: "", size: "OSFA", plain: true, locations: [{ location: "reorderqr", kind: "transfer", transferId: QR, auto: true }] });
  // [orderId, configJson, made date, isTest]
  const orders = [["O1", "", "2026-10-14T15:00:00Z", 0], ["O2", qrCfg, "2026-10-16T15:00:00Z", 0], ["O3", JSON.stringify({ locations: [] }), "2026-10-16T15:00:00Z", 0],
    ["O4", "", "2026-10-16T15:00:00Z", 0], ["O5", qrCfg, "2026-10-25T15:00:00Z", 0], ["O6", "", "2026-10-16T15:00:00Z", 1], ["O7", "", null, 0]];
  for (const [id, cfg, made, test] of orders) {
    d1._raw.run("UPDATE orders SET manufacturedAt = ?, isTest = ? WHERE orderId = ?", [made, test, id]);
    d1._raw.run("UPDATE order_items SET configJson = ?, cogsCents = 300, cogsSource = 'consumed' WHERE orderId = ?", [cfg, id]);
  }
  const item = (orderId, n = 0) => d1.q("SELECT id FROM order_items WHERE orderId = ? ORDER BY id", orderId)[n].id;
  const cogs = (id) => d1.q("SELECT cogsCents FROM order_items WHERE id = ?", id)[0].cogsCents;
  const t = () => d1.q("SELECT quantity, purchasePriceCents FROM transfers WHERE id = ?", QR)[0];

  // Two sheets: 10 at $1.00 on Oct 1, 10 at $2.00 on Oct 20. O5 used one on Oct 25 at the average then ($1.50).
  let r = await call({ action: "receiveTransferSheet", receivedAt: "2026-10-01", vendor: "DTF Co", vendorRef: "A", total: 10, rows: [{ transferId: QR, count: 10, pctOfSheet: 100 }] });
  ok("first sheet received", r.status === 200);
  r = await call({ action: "receiveTransferSheet", receivedAt: "2026-10-20", vendor: "DTF Co", vendorRef: "B", total: 20, rows: [{ transferId: QR, count: 10, pctOfSheet: 100 }] });
  ok("second sheet received", r.status === 200);
  d1._raw.run(`INSERT INTO transfer_movements (transferId, transferName, qtyDelta, unitCostCents, kind, orderId, itemId, note, occurredAt, createdAt) VALUES (?, 'Shop QR', -1, 150, 'consume', 'O5', ?, 'Used', '2026-10-25T15:00:00Z', 't')`, [QR, item("O5")]);
  d1._raw.run("UPDATE transfers SET quantity = 19, purchasePriceCents = 150 WHERE id = ?", [QR]);
  d1._raw.run("UPDATE order_items SET cogsCents = 450 WHERE id = ?", [item("O5")]);

  console.log("=== Preview ===");
  r = await call({ action: "previewTransferCatchUp" });
  const lines = r.body.lines || [];
  const byItem = (id) => lines.find(l => l.itemId === id);
  ok("preview lists O1's two lines (from the product) and O2's line (from its options)", r.status === 200 && lines.length === 3 &&
    byItem(item("O1")).source === "product" && byItem(item("O1", 1)).source === "product" && byItem(item("O2")).source === "order");
  ok("not listed: options with no transfer, a product with its QR off, a line that already used it, a test order, an unmade order",
    !["O3", "O4", "O5", "O6", "O7"].some(o => lines.some(l => l.orderId === o)));
  ok("each is priced at the average on the day it was made ($1.00)", lines.every(l => l.uses.length === 1 && l.uses[0].unitCostCents === 100 && l.cost === 1));
  ok("the later use (O5) would be re-costed", r.body.recostLines === 1);
  ok("the preview wrote nothing", d1.q("SELECT count(*) n FROM transfer_movements WHERE kind = 'consume'")[0].n === 1 && t().quantity === 19);

  console.log("\n=== Apply two of the three ===");
  // A second apply that planned at the same moment (a double click, another tab) — applied after the first below.
  const plans = new Function(dbSrc + `\nreturn { planTransferCatchUp, applyTransferCatchUp };`)();
  const samePlanElsewhere = await plans.planTransferCatchUp(d1, [item("O1"), item("O2")]);
  r = await call({ action: "applyTransferCatchUp", itemIds: [item("O1"), item("O2")] });
  ok("applied 2 lines, 2 transfers, $2.00", r.status === 200 && r.body.applied === 2 && r.body.totalUnits === 2 && r.body.total === 2);
  const mv = d1.q("SELECT itemId, qtyDelta, unitCostCents, occurredAt, note FROM transfer_movements WHERE kind = 'consume' AND note LIKE '%catch-up%' ORDER BY itemId");
  ok("a consume per line, dated when its order was made, at $1.00", mv.length === 2 && mv[0].occurredAt === "2026-10-14T15:00:00Z" && mv[1].occurredAt === "2026-10-16T15:00:00Z" && mv.every(m => m.qtyDelta === -1 && m.unitCostCents === 100));
  ok("each line's cost of goods went up by $1.00", cogs(item("O1")) === 400 && cogs(item("O2")) === 400 && cogs(item("O1", 1)) === 300);
  // On hand when the second sheet came in: 10 − 2 = 8, so its average is (8×100 + 10×200) / 18 = 156.
  ok("the transfer's stock and average follow (17 at $1.56)", t().quantity === 17 && t().purchasePriceCents === 156);
  ok("O5's later use re-costed $1.50 → $1.56, and its line's cost with it", d1.q("SELECT unitCostCents FROM transfer_movements WHERE itemId = ? AND kind = 'consume'", item("O5"))[0].unitCostCents === 156 && cogs(item("O5")) === 456);
  ok("audit row written", d1.q("SELECT count(*) n FROM audit_log WHERE action = 'transfer.catch_up'")[0].n === 1);
  r = await call({ action: "applyTransferCatchUp", itemIds: [item("O1"), item("O2")] });
  ok("applying the same lines again does nothing", r.status === 400 && t().quantity === 17);
  const late = await plans.applyTransferCatchUp(d1, samePlanElsewhere);
  ok("the same plan applied a second time (planned before the first wrote) adds no use, no cost and no re-cost",
    late.applied === 0 && d1.q("SELECT count(*) n FROM transfer_movements WHERE kind = 'consume' AND note LIKE '%catch-up%'")[0].n === 2 &&
    cogs(item("O1")) === 400 && cogs(item("O2")) === 400 && cogs(item("O5")) === 456);
  ok("…and the stock is worked out from the history, not set from the old plan (still 17 at $1.56)", t().quantity === 17 && t().purchasePriceCents === 156);
  r = await call({ action: "previewTransferCatchUp" });
  ok("only O1's second line is left", r.status === 200 && r.body.lines.length === 1 && r.body.lines[0].itemId === item("O1", 1));

  console.log("\n=== Void an order's use (Transfers → History) ===");
  const o5use = d1.q("SELECT id FROM transfer_movements WHERE itemId = ? AND kind = 'consume'", item("O5"))[0].id;
  r = await call({ action: "voidTransferMovement", movementId: o5use, reason: "Made without a QR" });
  ok("an order's use can be voided", r.status === 200 && d1.q("SELECT voidedAt FROM transfer_movements WHERE id = ?", o5use)[0].voidedAt);
  ok("the transfer goes back into stock (18) and its cost comes off the line ($4.56 → $3.00)", t().quantity === 18 && cogs(item("O5")) === 300);
  ok("the audit row names the order", d1.q("SELECT orderId FROM audit_log WHERE action = 'transfer.movement_voided' ORDER BY id DESC LIMIT 1")[0].orderId === "O5");
  r = await call({ action: "restoreTransferMovement", movementId: o5use });
  ok("it can't be restored from History (record it again with the past-orders tool)", r.status === 409 && /Use transfers for past orders/.test(r.body.message));
  r = await call({ action: "previewTransferCatchUp" });
  const o5 = (r.body.lines || []).find(l => l.orderId === "O5");
  ok("the line shows up again in Use transfers for past orders, with why it was voided", o5 && o5.voidedUse === "Made without a QR" && o5.source === "order");
  d1._raw.run(`INSERT INTO transfer_movements (transferId, transferName, qtyDelta, unitCostCents, kind, orderId, itemId, reason, note, occurredAt, createdAt) VALUES (?, 'Shop QR', -1, 156, 'consume', 'O2', ?, 'finished', 'Made for stock', '2026-10-26T00:00:00Z', 't')`, [QR, item("O2")]);
  const fin = d1.q("SELECT max(id) i FROM transfer_movements")[0].i;
  r = await call({ action: "voidTransferMovement", movementId: fin, reason: "x" });
  ok("a use that made finished stock can't be voided here", r.status === 400 && /finished stock/.test(r.body.message));
  d1._raw.run("DELETE FROM transfer_movements WHERE id = ?", [fin]);
  ok("History offers Void on an order's use", /m\.kind === "consume" && m\.itemId && m\.reason !== "finished"/.test(read("public/admin.js")));

  console.log("\n=== Printed transfers the product has now but the order didn't save ===");
  // A tee placed when it carried only the shop QR; its front and back prints were set up on the product afterwards.
  const FRONT = await lib.createTransfer(d1, { name: "Front print" }), BACK = await lib.createTransfer(d1, { name: "Back print" });
  const gF = await lib.createGraphic(d1, "ac", { name: "Front", kind: "transfer", transferId: FRONT });
  const gB = await lib.createGraphic(d1, "ac", { name: "Back", kind: "transfer", transferId: BACK });
  d1._raw.run(`INSERT INTO products (productId, orgId, type, name, createdAt, updatedAt, fixedTransfersJson) VALUES ('tee','ac','tee','Tee','t','t',?)`,
    [JSON.stringify([{ locationId: 1, graphicId: gF, ink: "" }, { locationId: 2, graphicId: gB, ink: "" }])]);
  d1._raw.run(`INSERT INTO orders (orderId, orgId, customerName, contact, paymentMethod, paid, subtotalCents, totalCents, placedAt, manufacturedAt) VALUES ('O8', 'ac', 'Cust O8', 'c@x', 'Card', 1, 6000, 6000, '2026-11-01T00:00:00Z', '2026-11-05T15:00:00Z')`);
  d1._raw.run(`INSERT INTO order_items (orderId, orgId, productId, name, type, qty, unitPriceCents, lineTotalCents, cancelDate, configJson, cogsCents, cogsSource) VALUES ('O8', 'ac', 'tee', 'Tee', 'tee', 3, 2000, 6000, '', ?, 900, 'consumed')`, [qrCfg]);
  r = await call({ action: "receiveTransferSheet", receivedAt: "2026-11-01", vendor: "DTF Co", vendorRef: "C", total: 20, rows: [{ transferId: FRONT, count: 10, pctOfSheet: 50 }, { transferId: BACK, count: 10, pctOfSheet: 50 }] });
  ok("front and back sheet received", r.status === 200);
  r = await call({ action: "previewTransferCatchUp" });
  const o8 = (r.body.lines || []).find(l => l.orderId === "O8");
  ok("the line offers its saved QR and the product's front and back, those two marked added", o8 && o8.source === "order" && o8.uses.length === 3 &&
    o8.uses.map(u => [u.transferId, u.added].join()).join("|") === [QR + ",false", FRONT + ",true", BACK + ",true"].join("|") && o8.uses.every(u => u.qty === 3));
  ok("each use carries its own shortfall (none here)", o8.uses.find(u => u.transferId === FRONT).shortBy === 0 && o8.uses.find(u => u.transferId === QR).shortBy === 0);
  const qrBefore = t().quantity;
  r = await call({ action: "applyTransferCatchUp", uses: { [item("O8")]: [FRONT, BACK] } });
  ok("applying only the ticked front and back", r.status === 200 && r.body.applied === 1 && r.body.totalUnits === 6 && r.body.total === 6);
  const used = d1.q("SELECT transferId, qtyDelta, unitCostCents, occurredAt FROM transfer_movements WHERE itemId = ? AND kind = 'consume' ORDER BY transferId", item("O8"));
  ok("took 3 fronts and 3 backs at $1.00 dated when it was made, and no QR", used.length === 2 && used.every(m => m.qtyDelta === -3 && m.unitCostCents === 100 && m.occurredAt === "2026-11-05T15:00:00Z") &&
    used.map(m => m.transferId).join() === [FRONT, BACK].join() && t().quantity === qrBefore);
  ok("stock and the line's cost follow", d1.q("SELECT quantity FROM transfers WHERE id IN (?, ?)", FRONT, BACK).every(x => x.quantity === 7) && cogs(item("O8")) === 1500);
  ok("the audit names the added transfers", /"added":true/.test(d1.q("SELECT detail FROM audit_log WHERE action = 'transfer.catch_up' ORDER BY id DESC LIMIT 1")[0].detail));
  r = await call({ action: "previewTransferCatchUp" });
  ok("the line is done", !(r.body.lines || []).some(l => l.orderId === "O8"));
  r = await call({ action: "applyTransferCatchUp", uses: { [item("O1", 1)]: ["x"] } });
  ok("a pick with no transfer is refused", r.status === 400);
  r = await call({ action: "applyTransferCatchUp", uses: { [item("O1", 1)]: [FRONT] } });
  ok("a pick of a transfer the line doesn't use applies nothing", r.status === 400 && /no longer qualify/.test(r.body.message));
  const win = admin_();
  ok("the window ticks each transfer, starts added ones unticked, and sends the ticked ones", /data-tcu-use=/.test(win) && /data-tcu-tid=/.test(win) && /!u\.added \|\|/.test(win) && /action: "applyTransferCatchUp", uses \}/.test(win));

  console.log("\n=== Update from catalog first: add the prints, drop the QR it was made without ===");
  d1._raw.run(`INSERT INTO orders (orderId, orgId, customerName, contact, paymentMethod, paid, subtotalCents, totalCents, placedAt, manufacturedAt, completedAt) VALUES ('O9', 'ac', 'Cust O9', 'c@x', 'Card', 1, 4000, 4000, '2026-11-01T00:00:00Z', '2026-11-06T15:00:00Z', '2026-11-07T00:00:00Z')`);
  d1._raw.run(`INSERT INTO order_items (orderId, orgId, productId, name, type, qty, unitPriceCents, lineTotalCents, cancelDate, configJson, manufacturedQty, cogsCents, cogsSource) VALUES ('O9', 'ac', 'tee', 'Tee', 'tee', 2, 2000, 4000, '', ?, 2, 600, 'consumed')`, [qrCfg]);
  r = await call({ action: "refreshOrderFromCatalog", orderId: "O9", org: "ac", preview: true });
  const o9 = r.body.lines && r.body.lines[0];
  ok("a completed order's made line offers the two prints (ticked) and removing its QR (unticked)", r.status === 200 && o9 && o9.made === true && o9.usedStock === false &&
    o9.options.map(o => o.key + "=" + o.on).join() === "fixed:fixed1=true,fixed:fixed2=true,drop:qr=false");
  r = await call({ action: "refreshOrderFromCatalog", orderId: "O9", org: "ac", pick: { [item("O9")]: ["fixed:fixed1", "fixed:fixed2", "drop:qr"] } });
  const o9cfg = JSON.parse(d1.q("SELECT configJson FROM order_items WHERE id = ?", item("O9"))[0].configJson);
  ok("applied: the line now names the front and back prints and no QR", r.status === 200 && r.body.lines.length === 1 &&
    o9cfg.locations.map(l => l.transferId).join() === [FRONT, BACK].join() && o9cfg.locations.every(l => l.fixed) && !o9cfg.locations.some(l => l.auto));
  r = await call({ action: "previewTransferCatchUp" });
  const o9cu = (r.body.lines || []).find(l => l.orderId === "O9");
  ok("Use transfers for past orders then offers just those, from the order (ticked)", o9cu && o9cu.source === "order" && o9cu.uses.map(u => u.transferId).join() === [FRONT, BACK].join() && o9cu.uses.every(u => !u.added));
  r = await call({ action: "applyTransferCatchUp", itemIds: [item("O9")] });
  ok("and applying takes 2 fronts and 2 backs", r.status === 200 && r.body.totalUnits === 4 && d1.q("SELECT quantity FROM transfers WHERE id IN (?, ?)", FRONT, BACK).every(x => x.quantity === 5));
  r = await call({ action: "refreshOrderFromCatalog", orderId: "O9", org: "ac", preview: true });
  ok("afterwards the line says it already took its transfers out of stock, and every change starts off (even the catalog's QR)", r.body.lines.length === 0 &&
    r.body.optional.length === 1 && r.body.optional[0].usedStock === true && r.body.optional[0].options.some(o => o.key === "qr") && r.body.optional[0].options.every(o => !o.on));
  r = await call({ action: "refreshOrderFromCatalog", orderId: "O9", org: "ac" });
  ok("so an update without ticks leaves it alone", r.status === 200 && r.body.lines.length === 0 && !JSON.parse(d1.q("SELECT configJson FROM order_items WHERE id = ?", item("O9"))[0].configJson).locations.some(l => l.auto));

  console.log("\n=== Closed month, roles ===");
  d1._raw.run("INSERT INTO closed_periods (month, closedAt, closedBy) VALUES ('2026-10','t','test')");
  r = await call({ action: "previewTransferCatchUp" });
  ok("a line in a closed month shows locked", r.body.lines.length === 2 && r.body.lines.every(l => l.locked === true));
  r = await call({ action: "applyTransferCatchUp", itemIds: [item("O1", 1)] });
  ok("and can't be applied", r.status === 409 && /closed/.test(r.body.message) && t().quantity === 18);
  const src = read("functions/api/orders.js");
  const catalog = src.match(/const CATALOG_ADMIN_ACTIONS = new Set\(\[[\s\S]*?\]\);/)[0];
  ok("allowed for the same roles as Use blanks for past orders", ["production", "staff", "manager", "admin"].every(r => may(r, "applyTransferCatchUp") === may(r, "applyBlankCatchUp")) && may("staff", "applyTransferCatchUp") && /"applyTransferCatchUp"/.test(catalog) && may("staff", "previewTransferCatchUp"));
  const admin = read("public/admin.js");
  ok("the Inventory & COGS page has the button", /id="cogsTransferCatchUp"[^>]*>Use transfers for past orders…/.test(admin) && /action: "applyTransferCatchUp"/.test(admin));

  console.log("\n=== A voided use no longer counts as used ===");
  const inHand = await lib.transfersInHand_(d1, [{ r: { itemId: item("O5"), qty: 1 }, transfers: [{ transferId: QR }] }]);
  ok("Run Transfer Sheets doesn't call O5's transfers used — they come from stock again", inHand.get(item("O5")).source === "stock");
  await lib.consumeLineTransfersOnce_(d1, "O5", item("O5"));
  ok("making the line again takes its transfer (the voided use doesn't block it)",
    d1.q("SELECT count(*) n FROM transfer_movements WHERE itemId = ? AND kind = 'consume' AND voidedAt IS NULL", item("O5"))[0].n === 1 && t().quantity === 17);
  await lib.consumeLineTransfersOnce_(d1, "O5", item("O5"));
  ok("and only once", t().quantity === 17);

  console.log(failed ? `\n${failed} FAILED` : "\nAll passed");
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
