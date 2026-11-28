const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// A line's transfers are used in the same batch as its last piece (2026-11, review round 2). Run Order's last piece
// (markItemPieceManufactured) and the Orders screen's Manufactured (consumeBlanksForOrder) claimed the piece in one
// batch, then used the line's transfers as separate steps — one batch per transfer and one more write for the cost.
// A failure in between left the line made with none, or only some, of its transfers used, and a retry found it made
// and stopped. Now the uses, the stock and the cost go in the claim's batch on the same condition: all or nothing.
// "Already used" is counted per transfer, both there and in Use transfers for past orders, so a line that used only
// some of its transfers is offered the rest. Real migrations and db.js on sql.js. Invented data only.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const lib = new Function(strip(read("functions/_lib/db.js")) + `\nreturn { insertOrder, getOrderById, setOrderPaid, createProduct, createBlank, setBlankLink, receiveBlanks, createTransfer,
  receiveTransferSheet, createGraphic, markItemPieceManufactured, consumeBlanksForOrder, planTransferCatchUp, applyTransferCatchUp };`)();

let failed = 0;
const ok = (label, cond) => { if (!cond) failed++; console.log(label + ": " + !!cond); };

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('acme','acme','Example Club','t','t',1);`);

  // Two transfers: Lockup 100 at $2.00, Sleeve 100 at $1.00. A configurable raglan linked to a blank (100 at $5).
  const tA = await lib.createTransfer(d1, { name: "Lockup" }), tB = await lib.createTransfer(d1, { name: "Sleeve" });
  await lib.receiveTransferSheet(d1, { rows: [{ transferId: tA, count: 100, pctOfSheet: 100 }], totalCents: 20000, receivedAt: "2026-07-01" });
  await lib.receiveTransferSheet(d1, { rows: [{ transferId: tB, count: 100, pctOfSheet: 100 }], totalCents: 10000, receivedAt: "2026-07-01" });
  await lib.createProduct(d1, "acme", { productId: "rag", type: "shirt", name: "Raglan", pricingMode: "flat", flatPrice: 18, visible: true,
    configurable: true, garmentColors: ["Navy"], locations: [{ key: "front", label: "Front", graphicIds: [] }, { key: "sleeve", label: "Sleeve", graphicIds: [] }], reorderQr: "none" });
  const blankId = (await lib.createBlank(d1, { name: "Example raglan blank", productType: "shirt", colors: [{ color: "Navy", images: [], sizes: [{ size: "L", purchasePrice: 0, quantity: 0 }] }] })).id;
  await lib.setBlankLink(d1, "acme", "rag", "Navy", "L", blankId, "Navy", "L");
  await lib.receiveBlanks(d1, { blankId, lines: [{ color: "Navy", size: "L", qty: 100, unitCost: 5 }], receivedAt: "2026-07-01T12:00:00.000Z" });
  const gA = await lib.createGraphic(d1, "acme", { name: "Lockup", kind: "transfer", transferId: tA, tier: "medium" });
  const gB = await lib.createGraphic(d1, "acme", { name: "Sleeve", kind: "transfer", transferId: tB, tier: "small" });
  const loc = (key, graphicId, transferId, name) => ({ location: key, label: key, graphicId, kind: "transfer", transferId, graphicName: name, ink: "", tier: "medium", addOnCents: 200 });
  const both = { garmentColor: "Navy", size: "L", locations: [loc("front", gA, tA, "Lockup"), loc("sleeve", gB, tB, "Sleeve")] };
  const raglan = (qty) => ({ productId: "rag", name: "Raglan", type: "shirt", size: "L", qty, unitPrice: 20, config: both });
  const order = async (id, qty) => {
    await lib.insertOrder(d1, { orderId: id, orgId: "acme", customerName: "Pat Example", contact: "pat@example.test", placedAt: "2026-07-05T00:00:00.000Z" }, [raglan(qty)]);
    await lib.setOrderPaid(d1, id, null, "paid");
    return (await lib.getOrderById(d1, id)).items[0].id;
  };
  const q = (id) => d1.q("SELECT quantity FROM transfers WHERE id = ?", id)[0].quantity;
  const sum = (id) => d1.q("SELECT COALESCE(SUM(qtyDelta), 0) s FROM transfer_movements WHERE transferId = ? AND voidedAt IS NULL", id)[0].s;
  const uses = (itemId) => d1.q("SELECT transferId, qtyDelta, unitCostCents FROM transfer_movements WHERE itemId = ? AND kind = 'consume' AND voidedAt IS NULL ORDER BY transferId", itemId);
  const line = (itemId) => d1.q("SELECT manufacturedQty, cogsCents FROM order_items WHERE id = ?", itemId)[0];
  const adds = () => [tA, tB].every(id => q(id) === sum(id));

  // Every write the database is asked for: each batch (its statements' SQL) and each single statement run on its own.
  const log = { batches: [], runs: [] };
  let breakOn = null;   // a test of a failure: the next batch whose SQL matches this throws
  const batch = d1.batch.bind(d1), prepare = d1.prepare.bind(d1);
  d1.batch = async (stmts) => {
    const sqls = stmts.map(s => s._sql);
    log.batches.push(sqls);
    if (breakOn && sqls.some(s => breakOn.test(s))) { breakOn = null; throw new Error("D1_ERROR: the network dropped (test)"); }
    return batch(stmts);
  };
  const wrap = (st, sql) => Object.assign({}, st, { run: async () => { log.runs.push(sql); return st.run(); }, bind: (...a) => wrap(st.bind(...a), sql) });
  d1.prepare = (sql) => wrap(prepare(sql), String(sql));
  const watch = async (fn) => { log.batches = []; log.runs = []; return fn(); };
  const touchesTransfers = (s) => /transfer_movements|UPDATE transfers|cogsCents/.test(s);

  console.log("=== Run Order: the last piece uses the line's transfers in its own batch ===");
  let item = await order("R1", 2);
  await watch(() => lib.markItemPieceManufactured(d1, "R1", item));
  ok("the first of two pieces uses no transfer", uses(item).length === 0 && q(tA) === 100);
  await watch(() => lib.markItemPieceManufactured(d1, "R1", item));
  const withUse = log.batches.filter(b => b.some(s => /INSERT INTO transfer_movements/.test(s)));
  ok("the last piece: ONE batch writes both uses, both stocks, the cost and the claim", withUse.length === 1 &&
    withUse[0].filter(s => /INSERT INTO transfer_movements/.test(s)).length === 2 && withUse[0].some(s => /UPDATE transfers SET quantity/.test(s)) &&
    /SET manufacturedQty/.test(withUse[0].at(-1)));
  ok("…and nothing about transfers or cost is written outside it", !log.runs.some(touchesTransfers) && log.batches.filter(b => b.some(touchesTransfers)).length === 1);
  ok("both transfers used, one per garment, at their average cost", JSON.stringify(uses(item)) === JSON.stringify([{ transferId: tA, qtyDelta: -2, unitCostCents: 200 }, { transferId: tB, qtyDelta: -2, unitCostCents: 100 }]));
  ok("stock 98 and 98, the line's cost 2 × $5 + 2 × $2 + 2 × $1 = $16, the history adds up", q(tA) === 98 && q(tB) === 98 && line(item).cogsCents === 1600 && adds());

  console.log("\n=== A failure in that batch leaves nothing half done, and a retry does it all ===");
  item = await order("R2", 2);
  await lib.markItemPieceManufactured(d1, "R2", item);
  breakOn = /INSERT INTO transfer_movements/;
  let threw = false;
  try { await lib.markItemPieceManufactured(d1, "R2", item); } catch (e) { threw = /network dropped/.test(e.message); }
  ok("the write fails", threw);
  ok("…and the line is still one piece made, with no use, no stock taken and no transfer cost", line(item).manufacturedQty === 1 && uses(item).length === 0 &&
    q(tA) === 98 && q(tB) === 98 && line(item).cogsCents === 500);
  const again = await lib.markItemPieceManufactured(d1, "R2", item);
  ok("the retry makes the last piece", again.pieceMarked === true && line(item).manufacturedQty === 2);
  ok("…and uses both transfers and adds their cost, once", uses(item).length === 2 && q(tA) === 96 && q(tB) === 96 && line(item).cogsCents === 1600 && adds());
  const done = await lib.markItemPieceManufactured(d1, "R2", item);
  ok("a third click finds it complete and uses nothing more", done.alreadyComplete === true && uses(item).length === 2 && q(tA) === 96);

  console.log("\n=== The Orders screen's Manufactured: the same, line by line ===");
  item = await order("R3", 3);
  breakOn = /INSERT INTO transfer_movements/;
  threw = false;
  try { await lib.consumeBlanksForOrder(d1, "R3"); } catch (e) { threw = /network dropped/.test(e.message); }
  ok("a failed write leaves the line unmade and its transfers in stock", threw && line(item).manufacturedQty === 0 && uses(item).length === 0 && q(tA) === 96 && line(item).cogsCents == null);
  await watch(() => lib.consumeBlanksForOrder(d1, "R3"));
  ok("the retry makes it, in one batch with its transfers", line(item).manufacturedQty === 3 && uses(item).length === 2 && q(tA) === 93 && q(tB) === 93 &&
    log.batches.filter(b => b.some(touchesTransfers)).length === 1 && !log.runs.some(touchesTransfers) && line(item).cogsCents === 2400 && adds());

  console.log("\n=== Already used is counted per transfer ===");
  // The Lockup was already taken for this line (say, by Use transfers for past orders before the line was made):
  // finishing it uses only the Sleeve. It used to see "a use exists" and skip both.
  item = await order("R4", 1);
  d1._raw.run("INSERT INTO transfer_movements (transferId, transferName, qtyDelta, unitCostCents, kind, orderId, itemId, note, occurredAt, createdAt) VALUES (?, 'Lockup', -1, 200, 'consume', 'R4', ?, 'Used', '2026-07-06T00:00:00Z', 't')", [tA, item]);
  d1._raw.run("UPDATE transfers SET quantity = quantity - 1 WHERE id = ?", [tA]);
  d1._raw.run("UPDATE order_items SET cogsCents = 200, cogsSource = 'consumed' WHERE id = ?", [item]);
  await lib.markItemPieceManufactured(d1, "R4", item);
  ok("the line takes only the transfer it hadn't used (Sleeve 93 → 92, Lockup stays 92)", uses(item).length === 2 && q(tA) === 92 && q(tB) === 92 && adds());
  ok("…and its cost adds the blank and that transfer ($2 + $5 + $1 = $8)", line(item).cogsCents === 800);

  console.log("\n=== Use transfers for past orders: a partly used line ===");
  // Made before this change: the claim and the Lockup's use landed, then the Sleeve's write failed.
  item = await order("R5", 2);
  d1._raw.run("UPDATE orders SET manufacturedAt = '2026-07-10T15:00:00.000Z' WHERE orderId = 'R5'");
  d1._raw.run("UPDATE order_items SET manufacturedQty = 2, cogsCents = 1400, cogsSource = 'consumed' WHERE id = ?", [item]);
  d1._raw.run("INSERT INTO transfer_movements (transferId, transferName, qtyDelta, unitCostCents, kind, orderId, itemId, note, occurredAt, createdAt) VALUES (?, 'Lockup', -2, 200, 'consume', 'R5', ?, 'Used', '2026-07-10T15:00:00.000Z', 't')", [tA, item]);
  d1._raw.run("UPDATE transfers SET quantity = quantity - 2 WHERE id = ?", [tA]);
  const all = await lib.planTransferCatchUp(d1);
  const r5 = all.lines.find(l => l.itemId === item);
  ok("the line is listed, for just the transfer it didn't use", r5 && r5.uses.length === 1 && r5.uses[0].transferId === tB && r5.uses[0].qty === 2 && r5.usedBefore === 1);
  ok("lines that used all their transfers are not", !all.lines.some(l => l.orderId !== "R5"));
  const plan = await lib.planTransferCatchUp(d1, [item]);
  ok("the apply plans it exactly as the preview did", JSON.stringify(plan.lines) === JSON.stringify([r5]));
  const applied = await lib.applyTransferCatchUp(d1, plan);
  ok("applying uses the Sleeve and adds its cost ($14 + 2 × $1 = $16)", applied.applied === 1 && uses(item).length === 2 && line(item).cogsCents === 1600 && q(tB) === 90 && adds());
  const twice = await lib.applyTransferCatchUp(d1, plan);
  ok("the same plan applied again (a double click) changes nothing", twice.applied === 0 && uses(item).length === 2 && line(item).cogsCents === 1600 && q(tB) === 90);
  ok("the line is done", !(await lib.planTransferCatchUp(d1)).lines.some(l => l.itemId === item));

  console.log(failed ? `\n${failed} FAILED` : "\nAll passed");
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); console.log("test345 crashed: false"); process.exit(1); });
