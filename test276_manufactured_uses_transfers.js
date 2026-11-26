const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { adminAs } = require("./testlib/roles");
const { ADMIN_ORIGIN } = require("./testlib/hosts.js");

// Marking a whole order Manufactured uses its transfers (2026-11). A line takes its transfers out of stock, and adds
// their cost to its cost of goods, when it is fully made — but only Run Order's last piece did that
// (markItemPieceManufactured). The Orders screen's Manufactured stage, one order or many (setFulfillmentStage →
// consumeBlanksForOrder), used the blanks and finished stock only, leaving transfer stock overstated and the line's
// cost short until someone ran "Use transfers for past orders". Now a line that call finishes uses its transfers
// too — once, never for a line filled from finished stock, and never for a line that was already fully made.
// Real migrations, db.js, permissions.js and orders.js on sql.js. Invented data only.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { insertOrder, getOrderById, setOrderPaid, createProduct, createBlank, setBlankLink, receiveBlanks, createTransfer,
  receiveTransferSheet, listTransfers, createGraphic, setFulfillmentStage, markItemPieceManufactured, cancelLineItem, consumeBlanksForOrder };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  strip(read("functions/_lib/permissions.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" + adminAs() + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: { acme: 'acme' }, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();

let failed = 0;
const ok = (label, cond) => { if (!cond) failed++; console.log(label + ": " + !!cond); };
const near = (a, b) => Math.abs(a - b) < 0.005;

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('acme','acme','Example Club','t','t',1);`);

  // Two transfers on hand: Lockup 100 at $2.00 each, Sleeve 100 at $1.00. A configurable raglan (Navy / L) linked to
  // a blank with 100 on hand at $5, and a plain cap with no blank and no transfer.
  const tA = await lib.createTransfer(d1, { name: "Lockup" }), tB = await lib.createTransfer(d1, { name: "Sleeve" });
  await lib.receiveTransferSheet(d1, { rows: [{ transferId: tA, count: 100, pctOfSheet: 100 }], totalCents: 20000, receivedAt: "2026-07-01" });
  await lib.receiveTransferSheet(d1, { rows: [{ transferId: tB, count: 100, pctOfSheet: 100 }], totalCents: 10000, receivedAt: "2026-07-01" });
  await lib.createProduct(d1, "acme", { productId: "rag", type: "shirt", name: "Raglan", pricingMode: "flat", flatPrice: 18, visible: true,
    configurable: true, garmentColors: ["Navy"], locations: [{ key: "front", label: "Front", graphicIds: [] }, { key: "sleeve", label: "Sleeve", graphicIds: [] }], reorderQr: "none" });
  await lib.createProduct(d1, "acme", { productId: "cap", type: "cap", name: "Club Cap", pricingMode: "flat", flatPrice: 25, visible: true, noDesignNeeded: true });
  const blankId = (await lib.createBlank(d1, { name: "Example raglan blank", productType: "shirt", colors: [{ color: "Navy", images: [], sizes: [{ size: "L", purchasePrice: 0, quantity: 0 }] }] })).id;
  await lib.setBlankLink(d1, "acme", "rag", "Navy", "L", blankId, "Navy", "L");
  await lib.receiveBlanks(d1, { blankId, lines: [{ color: "Navy", size: "L", qty: 100, unitCost: 5 }], receivedAt: "2026-07-01T12:00:00.000Z" });
  const gA = await lib.createGraphic(d1, "acme", { name: "Lockup", kind: "transfer", transferId: tA, tier: "medium" });
  const gB = await lib.createGraphic(d1, "acme", { name: "Sleeve", kind: "transfer", transferId: tB, tier: "small" });
  const loc = (key, graphicId, transferId, name) => ({ location: key, label: key, graphicId, kind: "transfer", transferId, graphicName: name, ink: "", tier: "medium", addOnCents: 200 });
  const front = { garmentColor: "Navy", size: "L", locations: [loc("front", gA, tA, "Lockup")] };
  const both = { garmentColor: "Navy", size: "L", locations: [loc("front", gA, tA, "Lockup"), loc("sleeve", gB, tB, "Sleeve")] };
  const raglan = (qty, config) => ({ productId: "rag", name: "Raglan", type: "shirt", size: "L", qty, unitPrice: 20, config });
  const cap = (qty) => ({ productId: "cap", name: "Club Cap", type: "cap", size: "OSFA", qty, unitPrice: 25 });
  // An order ready to be made: paid, design approved, blank received (the stage's prerequisites).
  const order = async (id, items) => {
    await lib.insertOrder(d1, { orderId: id, orgId: "acme", customerName: "Pat Example", contact: "pat@example.test", placedAt: "2026-07-05T00:00:00.000Z" }, items);
    await lib.setOrderPaid(d1, id, null, "paid");
    d1._raw.run("UPDATE orders SET blankOrderedAt = ?, blankReceivedAt = ?, digitizingCompleteAt = ?, designApprovedAt = ? WHERE orderId = ?",
      ["2026-07-06T00:00:00.000Z", "2026-07-07T00:00:00.000Z", "2026-07-07T00:00:00.000Z", "2026-07-08T00:00:00.000Z", id]);
    return (await lib.getOrderById(d1, id)).items;
  };
  const onHand = async (id) => (await lib.listTransfers(d1)).find(t => t.id === id).quantity;
  const uses = (orderId) => d1.q("SELECT transferId, qtyDelta, unitCostCents, itemId FROM transfer_movements WHERE orderId = ? AND kind = 'consume' AND voidedAt IS NULL ORDER BY id", orderId);
  const line = async (orderId, n = 0) => (await lib.getOrderById(d1, orderId)).items[n];
  const madeQty = (orderId) => d1.q("SELECT manufacturedQty m FROM order_items WHERE orderId = ? ORDER BY id LIMIT 1", orderId)[0].m;

  console.log("=== Manufactured for the whole order (setFulfillmentStage) ===");
  await order("M1", [raglan(2, front), cap(1)]);
  await lib.setFulfillmentStage(d1, "M1", "manufactured");
  ok("the transfer leaves stock, one per garment (100 → 98)", await onHand(tA) === 98);
  let it = await line("M1");
  ok("the line's cost of goods is its blanks plus its transfers (2 × $5 + 2 × $2 = $14)", near(it.cogs, 14) && it.cogsSource === "consumed");
  ok("one use is recorded for the line, at the transfer's average cost", (u => u.length === 1 && u[0].qtyDelta === -2 && u[0].unitCostCents === 200 && u[0].itemId === it.id)(uses("M1")));
  ok("the order is made", !!(await lib.getOrderById(d1, "M1")).manufacturedAt);
  await lib.setFulfillmentStage(d1, "M1", "manufactured");
  await lib.consumeBlanksForOrder(d1, "M1");
  ok("marking it Manufactured again changes nothing more", await onHand(tA) === 98 && uses("M1").length === 1 && near((await line("M1")).cogs, 14));

  console.log("\n=== Every transfer on the line, and only this order's lines ===");
  await order("M2", [raglan(3, both)]);
  await lib.setFulfillmentStage(d1, "M2", "manufactured", { at: "2026-07-09T15:00:00.000Z" });
  ok("both transfers are used (Lockup 98 → 95, Sleeve 100 → 97)", await onHand(tA) === 95 && await onHand(tB) === 97);
  ok("cost of goods: 3 × $5 + 3 × $2 + 3 × $1 = $24", near((await line("M2")).cogs, 24));
  ok("the uses are dated when it was made", d1.q("SELECT occurredAt FROM transfer_movements WHERE orderId = 'M2' AND kind = 'consume'").every(r => r.occurredAt === "2026-07-09T15:00:00.000Z"));

  console.log("\n=== Lines the call doesn't finish are left alone ===");
  let items = await order("M3", [raglan(2, front)]);
  await lib.markItemPieceManufactured(d1, "M3", items[0].id);
  ok("one of two pieces made on Run Order: no transfer used yet", await onHand(tA) === 95 && uses("M3").length === 0);
  await lib.setFulfillmentStage(d1, "M3", "manufactured");
  ok("…Manufactured finishes the line and uses its transfers once (95 → 93)", await onHand(tA) === 93 && uses("M3").length === 1 && near((await line("M3")).cogs, 14));
  items = await order("M4", [raglan(1, front)]);
  await lib.markItemPieceManufactured(d1, "M4", items[0].id);
  ok("a line finished on Run Order used its transfer there (93 → 92)", await onHand(tA) === 92 && uses("M4").length === 1);
  await lib.setFulfillmentStage(d1, "M4", "manufactured");
  ok("…and Manufactured doesn't use it a second time", await onHand(tA) === 92 && uses("M4").length === 1 && near((await line("M4")).cogs, 7));
  items = await order("M5", [raglan(2, front)]);
  d1._raw.run("UPDATE order_items SET manufacturedQty = qty WHERE id = ?", [items[0].id]);
  await lib.setFulfillmentStage(d1, "M5", "manufactured");
  ok("a line that was already fully made before is not touched (that's what Use transfers for past orders is for)", await onHand(tA) === 92 && uses("M5").length === 0);
  items = await order("M6", [raglan(2, front), raglan(1, front)]);
  await lib.cancelLineItem(d1, items[1].id);
  await lib.setFulfillmentStage(d1, "M6", "manufactured");
  ok("a cancelled line uses nothing (only the 2 on the active line: 92 → 90)", await onHand(tA) === 90 && uses("M6").length === 1 && uses("M6")[0].itemId === items[0].id);
  items = await order("M7", [raglan(2, front)]);
  d1._raw.run("UPDATE order_items SET fromStock = 1, stockVariant = '' WHERE id = ?", [items[0].id]);
  await lib.setFulfillmentStage(d1, "M7", "manufactured");
  ok("a line filled from finished stock uses no transfer (it was used when the stock was made)", await onHand(tA) === 90 && uses("M7").length === 0 && madeQty("M7") === 2);

  console.log("\n=== A line with no transfer costs no extra reads ===");
  await order("M8", [cap(2)]);
  const seen = [], prepare = d1.prepare.bind(d1);
  d1.prepare = (sql) => { seen.push(String(sql)); return prepare(sql); };
  await lib.setFulfillmentStage(d1, "M8", "manufactured");
  d1.prepare = prepare;
  ok("the line is made", madeQty("M8") === 2);
  ok("…without asking for its transfers", !seen.some(s => /transfer_movements|FROM transfers/.test(s)) && !seen.some(s => /SELECT \* FROM order_items WHERE id=\?/.test(s)));

  console.log("\n=== The Orders screen's stage actions ===");
  const call = async (body) => { const res = await api({ env: { DB: d1 }, waitUntil: (p) => Promise.resolve(p).catch(() => {}),
    request: { url: ADMIN_ORIGIN + "/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) }; };
  await order("A1", [raglan(2, front)]);
  let r = await call({ action: "setFulfillmentStage", org: "acme", orderId: "A1", stage: "manufactured" });
  ok("one order's Manufactured: its transfers leave stock (90 → 88) and reach its cost ($14)", r.status === 200 && await onHand(tA) === 88 && near((await line("A1")).cogs, 14));
  await order("A2", [raglan(1, front)]); await order("A3", [raglan(4, both)]);
  r = await call({ action: "bulkSetFulfillmentStage", org: "acme", orderIds: ["A2", "A3"], stage: "manufactured" });
  ok("several orders at once: each line's transfers are used (Lockup 88 → 83, Sleeve 97 → 93)", r.status === 200 && r.body.updated === 2 && await onHand(tA) === 83 && await onHand(tB) === 93);
  ok("…with their cost on each line ($7 and 4 × $8 = $32)", near((await line("A2")).cogs, 7) && near((await line("A3")).cogs, 32));
  r = await call({ action: "bulkSetFulfillmentStage", org: "acme", orderIds: ["A1", "A2", "A3"], stage: "manufactured" });
  ok("the same action again uses nothing more", await onHand(tA) === 83 && await onHand(tB) === 93 && uses("A3").length === 2 && near((await line("A3")).cogs, 32));
  ok("the movement history adds up to the stock on hand", [tA, tB].every(id =>
    d1.q("SELECT COALESCE(SUM(qtyDelta), 0) s FROM transfer_movements WHERE transferId = ? AND voidedAt IS NULL", id)[0].s === d1.q("SELECT quantity q FROM transfers WHERE id = ?", id)[0].q));

  if (failed) { console.error(failed + " check(s) failed"); process.exit(1); }
})().catch((e) => { console.error("Error:", e); process.exit(1); });
