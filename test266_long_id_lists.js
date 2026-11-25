const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// Long id lists (review #79). D1 refuses a statement with more than 100 bound parameters, so every list that can grow
// with what the owner picks or with history goes in as ONE JSON array (`IN (SELECT value FROM json_each(?))`), not a
// placeholder per id. The test D1 (testlib/d1-shim.js) now refuses more than 100 too, as D1 does, for every test.
// Each place is driven here with more than 100 ids:
//   - a blank shipment covering 150 lines (add, then edit it down to 120), and the handlers' 5000-line cap
//   - a weekly recurring expense backdated about 2½ years (130+ due dates at once)
//   - the pricing check after 150 blanks' costs change
//   - a transfer sheet of 125 rows: read back, its receipt's paying-account check, and an edit
//   - the supplier orders list with 150 orders (each with its shipments), and the blanks of a supplier order
// Real SQL (sql.js) + real db.js and orders.js. Invented data only.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { addBlankShipment, updateBlankShipment, saveRecurringExpense, recordDueRecurringExpenses, pricingBelowTargetForBlanks,
  createTransfer, getTransferSheet, getReceiptRecords, receiptAccountBlockers, listSupplierOrders, getBlanksForSupplierOrder, createBlank, localToday };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'owner@example.test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendOrderNotificationEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false;\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();

let failed = 0;
const ok = (label, cond) => { console.log(label + ": " + !!cond); if (!cond) failed++; };
const noThrow = async (fn) => { try { return { value: await fn() }; } catch (e) { console.error("  threw:", e && e.message); return { error: e }; } };
const range = (n, from = 1) => Array.from({ length: n }, (_, i) => from + i);

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  // Orders written in the oldest schema (its dollar columns), before the migrations, as test190 does.
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Example Club','t','t');
    INSERT INTO orders (orderId, orgId, customerName, contact, paymentMethod, paid, subtotal, total, placedAt) VALUES
      ('BIG1','acme','Ann','ann@example.test','Check',1,150,150,'2026-09-12T00:00:00Z'), ('BIG2','acme','Bob','bob@example.test','Check',1,150,150,'2026-09-12T00:00:00Z');
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 150)
      INSERT INTO order_items (orderId, orgId, productId, name, type, qty, unitPrice, lineTotal, cancelDate)
      SELECT CASE WHEN i <= 75 THEN 'BIG1' ELSE 'BIG2' END, 'acme', 'tee', 'Tee ' || i, 'shirt', 1, 1, 1, '' FROM n;`);
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const call = async (body) => {
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => p.then(() => {}, () => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const q = (sql, ...p) => d1.q(sql, ...p);

  console.log("=== The test D1 refuses more than 100 bound parameters, as D1 does ===");
  const many = await noThrow(() => d1.prepare(`SELECT 1 WHERE 1 IN (${range(101).map(() => "?").join(",")})`).bind(...range(101)).all());
  ok("101 parameters: refused", !!many.error && /too many SQL variables/.test(many.error.message));
  ok("100 parameters: fine", !(await noThrow(() => d1.prepare(`SELECT 1 WHERE 1 IN (${range(100).map(() => "?").join(",")})`).bind(...range(100)).all())).error);

  console.log("\n=== A blank shipment covering 150 lines ===");
  const lineIds = q("SELECT id FROM order_items ORDER BY id").map(r => r.id);
  const add = await noThrow(() => lib.addBlankShipment(d1, { carrier: "usps", trackingNumber: "9400TEST1", vendor: "", shippedAt: "2026-09-20", itemIds: lineIds }));
  const sid = add.value;
  ok("added: one shipment covering all 150 lines, across two orders", !add.error && q("SELECT count(*) n FROM blank_shipment_items WHERE shipmentId = ?", sid)[0].n === 150);
  ok("…every line stamped shipped on its date", q("SELECT count(*) n FROM order_items WHERE blankShippedAt = '2026-09-20'")[0].n === 150);
  const keep = lineIds.slice(0, 120);
  const upd = await noThrow(() => lib.updateBlankShipment(d1, sid, { carrier: "usps", trackingNumber: "9400TEST1", shippedAt: "2026-09-20", itemIds: keep }));
  ok("edited down to 120 lines: the shipment covers exactly those", !upd.error && q("SELECT count(*) n FROM blank_shipment_items WHERE shipmentId = ?", sid)[0].n === 120);
  ok("…the 30 dropped lines (covered by no other shipment) lose their shipped stamp", q("SELECT count(*) n FROM order_items WHERE blankShippedAt IS NULL")[0].n === 30 &&
    q("SELECT count(*) n FROM order_items WHERE blankShippedAt IS NULL AND id IN (SELECT value FROM json_each(?))", JSON.stringify(lineIds.slice(120)))[0].n === 30);
  const sid2 = (await noThrow(() => lib.addBlankShipment(d1, { carrier: "ups", trackingNumber: "1ZTEST2", shippedAt: "2026-09-22", itemIds: [lineIds[0], lineIds[149]] }))).value;
  await noThrow(() => lib.updateBlankShipment(d1, sid, { carrier: "usps", trackingNumber: "9400TEST1", shippedAt: "2026-09-20", itemIds: lineIds.slice(1, 120) }));
  ok("…a line dropped from one shipment but still on another keeps its stamp", q("SELECT blankShippedAt b FROM order_items WHERE id = ?", lineIds[0])[0].b === "2026-09-20" && sid2 > sid);
  let r = await call({ action: "addBlankShipment", carrier: "usps", trackingNumber: "9400TEST3", itemIds: lineIds });
  ok("through the API: 150 lines take one request", r.status === 200 && q("SELECT count(*) n FROM blank_shipment_items WHERE shipmentId = ?", r.body.shipmentId)[0].n === 150);
  r = await call({ action: "addBlankShipment", carrier: "usps", trackingNumber: "9400TEST4", itemIds: range(5001) });
  const r2 = await call({ action: "updateBlankShipment", id: sid, carrier: "usps", trackingNumber: "9400TEST1", itemIds: range(5001) });
  ok("more than 5000 lines in one shipment are refused (add and edit), with a reason", r.status === 400 && /5000/.test(r.body.message) && r2.status === 400 && /5000/.test(r2.body.message));

  console.log("\n=== A weekly recurring expense backdated about 2½ years ===");
  const today = await lib.localToday({ DB: d1 });
  const start = new Date(Date.parse(today + "T00:00:00Z") - 910 * 86400000).toISOString().slice(0, 10);
  const ruleId = await lib.saveRecurringExpense(d1, null, { description: "Weekly cleaning", categoryId: 2, amount: 5, vendor: "", paidPersonally: true, frequency: "weekly", startDate: start });
  const rec = await noThrow(() => lib.recordDueRecurringExpenses(d1, today));
  const n = q("SELECT count(*) n FROM expenses WHERE recurringId = ?", ruleId)[0].n;
  ok("130+ due dates are recorded and each one is reported back (the read-back took one parameter per date)", !rec.error && n >= 130 && rec.value.recorded.length === n);

  console.log("\n=== The pricing check after 150 blanks' costs change ===");
  const blankIds = [];
  for (let i = 0; i < 3; i++) blankIds.push((await lib.createBlank(d1, { name: "Cap " + i, brand: "Generic", color: "Navy", productType: "cap" }, [{ size: "OSFA", quantity: 1, purchasePrice: 3 }])).id);
  const below = await noThrow(() => lib.pricingBelowTargetForBlanks(d1, blankIds.concat(range(150, 1000))));
  ok("150 blank ids: answered (it used to throw, and its callers hid that as 'nothing below target')", !below.error && Array.isArray(below.value));

  console.log("\n=== A transfer sheet of 125 rows ===");
  await call({ action: "saveVendor", vendor: { name: "Sheet Co", forTransfers: true } });
  const acct = q("SELECT id FROM accounts WHERE active=1 ORDER BY id LIMIT 1")[0].id;
  const transfers = [];
  for (let i = 0; i < 125; i++) transfers.push(await lib.createTransfer(d1, { name: "Design " + i }));
  r = await call({ action: "receiveTransferSheet", receivedAt: "2026-09-10", vendor: "Sheet Co", vendorRef: "BIG", total: 125, accountId: acct,
    rows: transfers.map(t => ({ transferId: t, count: 1, pctOfSheet: 0.8 })) });
  ok("received: 125 purchase movements", r.status === 200 && q("SELECT count(*) n FROM transfer_movements WHERE kind = 'purchase' AND voidedAt IS NULL")[0].n === 125);
  const seed = r.body.ids && r.body.ids[0];
  r = await call({ action: "getTransferSheet", movementId: seed });
  ok("read back as its form: 125 rows", r.status === 200 && r.body.sheet && r.body.sheet.rows.length === 125 && r.body.sheet.movementIds.length === 125);
  const recs = await lib.getReceiptRecords(d1, "transfers", seed);
  const blk = await noThrow(() => lib.receiptAccountBlockers(d1, recs, { accountId: acct, paidPersonally: false }));
  ok("its receipt's paying-account check (bank matches of 125 rows) answers", !blk.error && Array.isArray(blk.value) && blk.value.length === 0);
  r = await call({ action: "previewReceiptAccountChange", kind: "transfers", movementId: seed, paidPersonally: true });
  ok("…and so does the screen's preview", r.status === 200);
  r = await call({ action: "editTransferSheet", movementId: seed, receivedAt: "2026-09-10", vendor: "Sheet Co", vendorRef: "BIG-2", total: 125, accountId: acct,
    rows: transfers.map(t => ({ transferId: t, count: 1, pctOfSheet: 0.8 })) });
  ok("edited: the 125 old movements voided and 125 new ones written", r.status === 200 && q("SELECT count(*) n FROM transfer_movements WHERE kind = 'purchase' AND voidReason = 'Sheet edited'")[0].n === 125 &&
    q("SELECT count(*) n FROM transfer_movements WHERE kind = 'purchase' AND voidedAt IS NULL")[0].n === 125);

  console.log("\n=== Supplier orders ===");
  d1._raw.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 150)
    INSERT INTO supplier_orders (connectionId, vendor, environment, poNumber, status, createdAt) SELECT 1, 'Example Supply', 'test', 'PO-' || i, 'placed', printf('2026-09-%02dT00:00:00Z', 1 + i % 28) FROM n;
    INSERT INTO blank_shipments (carrier, trackingNumber, vendor, shippedAt, createdAt, updatedAt, supplierPoNumber) VALUES ('ups', '1ZPO7', 'Example Supply', '2026-09-30', 't', 't', 'PO-7');`);
  const so = await noThrow(() => lib.listSupplierOrders(d1, { limit: 200 }));
  ok("150 orders listed, each with its shipments (the shipments query used to fail quietly past 100 orders)", !so.error && so.value.length === 150 &&
    so.value.find(o => o.poNumber === "PO-7").shipments.length === 1 && so.value.filter(o => o.shipments.length).length === 1);
  const bfs = await noThrow(() => lib.getBlanksForSupplierOrder(d1, blankIds.concat(range(150, 1000))));
  ok("the blanks of a supplier order: at most 100 (an order's line limit), and found", !bfs.error && bfs.value.size === 3 && blankIds.every(id => bfs.value.get(id).sizes.size === 1));

  if (failed) console.log("\nFAILED:", failed);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log("crashed: false"); console.error(e); process.exit(1); });
