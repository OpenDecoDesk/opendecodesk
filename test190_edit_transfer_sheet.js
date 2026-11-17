const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// Editing a received transfer sheet (Accounts & money → Edit sheet…, Transfers → History → Open sheet). A sheet's
// rows set each transfer's per-item price, which feeds its average cost and from there every order line that used
// it. An edit voids the old purchase movements, writes the corrected ones under the same receiptGroup, updates the
// written-off expense and personal draw, and re-costs the uses already recorded — except in a closed month and
// except finished stock. Preview writes nothing. A bank-statement match follows the sheet when its money is unchanged.
// Real SQL + real db.js + real orders.js admin API.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { createTransfer, getTransferSheet, consumeTransfersForItem_, listStockPurchases, replayTransferCosts, receiveTransferSheet, getTransferMovements };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendOrderNotificationEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false;\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();

let failed = 0;
const ok = (label, cond) => { console.log(label + ": " + !!cond); if (!cond) failed++; };

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('pp','pp','PP','t','t');
    INSERT INTO orders (orderId, orgId, customerName, contact, paymentMethod, paid, subtotal, total, placedAt) VALUES
      ('O1','pp','Ann','a@x','Check',1,50,50,'2026-09-12T00:00:00Z'), ('O2','pp','Bob','b@x','Card',1,40,40,'2026-10-02T00:00:00Z');
    INSERT INTO order_items (orderId, orgId, productId, name, type, qty, unitPrice, lineTotal, cancelDate) VALUES
      ('O1','pp','p','Tee','tee',4,50,50,''), ('O2','pp','p','Tee','tee',1,40,40,'');`);
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const call = async (body) => {
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => p.then(() => {}, () => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  for (const name of ["DTF Co", "Old"]) await call({ action: "saveVendor", vendor: { name, forTransfers: true } });
  const A = await lib.createTransfer(d1, { name: "Crest" }), B = await lib.createTransfer(d1, { name: "QR" });
  const supplies = d1.q("SELECT id FROM expense_categories WHERE name LIKE 'Supplies%' LIMIT 1")[0].id;
  const acct = d1.q("SELECT id FROM accounts WHERE active=1 ORDER BY id LIMIT 1")[0].id;
  const [item1, item2] = d1.q("SELECT id FROM order_items ORDER BY id").map(r => r.id);
  const t = (id) => d1.q("SELECT quantity, purchasePriceCents FROM transfers WHERE id = ?", id)[0];
  const cogs = (id) => d1.q("SELECT cogsCents FROM order_items WHERE id = ?", id)[0].cogsCents;
  const purchases = () => d1.q("SELECT id, transferId, qtyDelta, unitCostCents, pctOfSheet, receiptGroup, voidedAt, voidReason FROM transfer_movements WHERE kind = 'purchase' ORDER BY id");
  const live = () => purchases().filter(m => !m.voidedAt);
  const audits = () => d1.q("SELECT count(*) n FROM audit_log WHERE action = 'transfer.sheet_edited'")[0].n;

  console.log("=== replayTransferCosts on its own ===");
  const rp = lib.replayTransferCosts([
    { id: 3, qtyDelta: -2, unitCostCents: 400, kind: "consume", itemId: 9, orderId: "X", occurredAt: "2026-01-05T10:00:00Z" },
    { id: 1, qtyDelta: 10, unitCostCents: 300, kind: "purchase", occurredAt: "2026-01-01" },
    { id: 4, qtyDelta: -1, unitCostCents: 400, kind: "consume", reason: "finished", occurredAt: "2026-01-06T10:00:00Z" },
    { id: 5, qtyDelta: -1, unitCostCents: 400, kind: "consume", itemId: 8, orderId: "Y", occurredAt: "2026-02-06T10:00:00Z" },
    { id: 6, qtyDelta: -1, unitCostCents: 400, kind: "writeoff", occurredAt: "2026-01-07T10:00:00Z" },
  ], new Set(["2026-02"]));
  ok("replays in time order: qty and average from the purchases", rp.qty === 5 && rp.avg === 300);
  ok("an order use and a write-off at the wrong cost are re-costed", rp.changes.length === 2 && rp.changes[0].movementId === 3 && rp.changes[0].newUnit === 300 && rp.changes[0].qty === 2 && rp.changes[1].kind === "writeoff");
  ok("finished stock and a closed month are left alone and counted", rp.skippedFinished === 1 && rp.skippedClosed === 1);

  console.log("\n=== Receive a sheet, use some of it ===");
  let r = await call({ action: "receiveTransferSheet", receivedAt: "2026-09-10", vendor: "DTF Co", vendorRef: "S1", total: 100, accountId: acct,
    rows: [{ transferId: A, count: 10, pctOfSheet: 60 }, { transferId: B, count: 20, pctOfSheet: 40 }] });
  ok("received: Crest $6.00 each, QR $2.00 each", r.status === 200 && t(A).purchasePriceCents === 600 && t(B).purchasePriceCents === 200);
  const seed = r.body.ids[0], group = live()[0].receiptGroup;
  await lib.consumeTransfersForItem_(d1, { id: item1, orderId: "O1", qty: 4 }, [A], "2026-09-15T12:00:00.000Z");
  await lib.consumeTransfersForItem_(d1, { id: item2, orderId: "O2", qty: 1 }, [A], "2026-10-05T12:00:00.000Z");
  d1._raw.run("INSERT INTO transfer_movements (transferId, transferName, qtyDelta, unitCostCents, kind, note, occurredAt, createdAt, reason) VALUES (?, 'Crest', -1, 600, 'consume', 'Made for stock', '2026-09-16T12:00:00.000Z', 't', 'finished')", [A]);
  d1._raw.run("INSERT INTO closed_periods (month, closedAt, closedBy) VALUES ('2026-10','t','test')");
  ok("the order lines were costed at $6.00 a transfer", cogs(item1) === 2400 && cogs(item2) === 600);

  console.log("\n=== Read it back ===");
  r = await call({ action: "getTransferSheet", movementId: seed });
  const s = r.body.sheet;
  ok("the sheet comes back as its form: rows, counts, % of sheet, per-item price, total", r.status === 200 && s.total === 100 && s.rows.length === 2 &&
    s.rows[0].transferId === A && s.rows[0].count === 10 && s.rows[0].pctOfSheet === 60 && s.rows[0].perItem === 6 && s.rows[1].count === 20 && s.rows[1].pctOfSheet === 40 &&
    s.vendor === "DTF Co" && s.vendorRef === "S1" && s.accountId === acct && s.writeoff === null && s.personal === null && !s.matched);
  ok("any of the sheet's movements finds it", (await call({ action: "getTransferSheet", movementId: live()[1].id })).body.sheet.total === 100);

  console.log("\n=== Edit: the same rules as receiving ===");
  const edit = (over) => call({ action: "editTransferSheet", movementId: seed, receivedAt: "2026-09-10", vendor: "DTF Co", vendorRef: "S1", total: 100, accountId: acct, ...over });
  r = await edit({ rows: [{ transferId: A, count: 10, pctOfSheet: 50 }, { transferId: B, count: 20, pctOfSheet: 40 }] });
  ok("rows that don't add up to 100% are refused, nothing changed", r.status === 400 && /Only 90%/.test(r.body.message) && live().length === 2 && audits() === 0);

  console.log("\n=== Preview changes nothing ===");
  const before = JSON.stringify([purchases(), t(A), t(B), cogs(item1)]);
  r = await edit({ preview: true, rows: [{ transferId: A, count: 10, pctOfSheet: 50 }, { transferId: B, count: 20, pctOfSheet: 50 }] });
  const p = r.body.preview;
  ok("preview: per-item price before → after for each row", r.status === 200 && p.rows[0].perItemBefore === 6 && p.rows[0].perItem === 5 && p.rows[1].perItemBefore === 2 && p.rows[1].perItem === 2.5);
  ok("preview: one order line re-costed, $4.00 less cost of goods", p.linesRecosted === 1 && p.cogsChange === -4 && p.orders.join() === "O1");
  ok("preview: the closed-month use and the finished-stock use are left alone", p.skippedClosed === 1 && p.skippedFinished === 1);
  ok("preview: the sheet's money is unchanged", p.moneyChanged === false && p.stockBefore === 100 && p.stockAfter === 100);
  ok("preview wrote nothing (no movements, costs or audit)", JSON.stringify([purchases(), t(A), t(B), cogs(item1)]) === before && audits() === 0);

  console.log("\n=== Save ===");
  r = await edit({ rows: [{ transferId: A, count: 10, pctOfSheet: 50 }, { transferId: B, count: 20, pctOfSheet: 50 }] });
  ok("saved", r.status === 200 && r.body.result.linesRecosted === 1);
  const voided = purchases().filter(m => m.voidedAt);
  ok("the old purchases are voided as 'Sheet edited', the new ones keep the sheet's group", voided.length === 2 && voided.every(m => m.voidReason === "Sheet edited") &&
    live().length === 2 && live().every(m => m.receiptGroup === group));
  ok("Crest is now $5.00 each and QR $2.50", t(A).purchasePriceCents === 500 && t(B).purchasePriceCents === 250);
  ok("stock counts are unchanged (10 − 4 − 1 − 1 = 4 Crest, 20 QR)", t(A).quantity === 4 && t(B).quantity === 20);
  ok("the open-month order line now costs $5.00 a transfer", cogs(item1) === 2000 && d1.q("SELECT unitCostCents u FROM transfer_movements WHERE itemId = ? AND kind = 'consume'", item1)[0].u === 500);
  ok("the closed-month order line is untouched", cogs(item2) === 600 && d1.q("SELECT unitCostCents u FROM transfer_movements WHERE itemId = ? AND kind = 'consume'", item2)[0].u === 600);
  ok("the finished-stock use is untouched", d1.q("SELECT unitCostCents u FROM transfer_movements WHERE reason = 'finished'")[0].u === 600);
  ok("the edit is in the audit log", audits() === 1);
  r = await call({ action: "restoreTransferMovement", movementId: voided[0].id });
  ok("an entry replaced by the edit can't be restored (it would count the sheet twice)", r.status === 409 && /replaced when its sheet was edited/.test(r.body.message) && t(A).purchasePriceCents === 500);
  const sp = (await lib.listStockPurchases(d1, "2026-01-01", "2026-12-31")).find(x => x.vendorRef === "S1");
  ok("Accounts & money shows one sheet with the new per-item prices", sp && sp.items.join("|") === "Crest ×10 @ $5.00|QR ×20 @ $2.50" && sp.total === 100);
  const hist = await lib.getTransferMovements(d1, A);
  ok("Transfers history carries the sheet's group and each use's order line", hist.some(m => m.kind === "purchase" && m.receiptGroup === group && m.pctOfSheet === 50) && hist.some(m => m.itemId === item1 && m.orderId === "O1"));

  console.log("\n=== Written-off and personal parts ===");
  const seed2 = () => live().find(m => m.receiptGroup === group).id;
  r = await call({ action: "editTransferSheet", movementId: seed2(), receivedAt: "2026-09-10", vendor: "DTF Co", vendorRef: "S1", total: 100, accountId: acct,
    rows: [{ transferId: A, count: 10, pctOfSheet: 40 }, { transferId: B, count: 20, pctOfSheet: 40 }],
    writeoff: { pct: 10, description: "misprints", categoryId: supplies }, personal: { pct: 10, description: "my shirts" } });
  const exp = () => d1.q("SELECT * FROM expenses WHERE receiptGroup = ? ORDER BY id", group);
  const drw = () => d1.q("SELECT * FROM owner_transactions WHERE receiptGroup = ? ORDER BY id", group);
  ok("adding a written-off part creates its expense in the sheet's group", r.status === 200 && exp().length === 1 && exp()[0].amountCents === 1000 && !exp()[0].deletedAt &&
    exp()[0].description === "Transfer sheet written off — misprints (DTF Co #S1)");
  ok("adding a personal part creates its owner draw", drw().length === 1 && drw()[0].amountCents === 1000 && drw()[0].kind === "draw");
  const back = (await call({ action: "getTransferSheet", movementId: seed2() })).body.sheet;
  ok("read back: written off 10% 'misprints', personal 10% 'my shirts', rows 40% + 40%", back.writeoff.pct === 10 && back.writeoff.description === "misprints" && back.writeoff.categoryId === supplies &&
    back.personal.pct === 10 && back.personal.description === "my shirts" && back.rows.map(x => x.pctOfSheet).join() === "40,40" && back.total === 100);
  r = await call({ action: "editTransferSheet", movementId: seed2(), receivedAt: "2026-09-10", vendor: "DTF Co", vendorRef: "S1", total: 100, accountId: acct,
    rows: [{ transferId: A, count: 10, pctOfSheet: 50 }, { transferId: B, count: 20, pctOfSheet: 40 }], personal: { pct: 10, description: "my shirts" } });
  ok("taking the written-off part away deletes its expense; the draw stays", r.status === 200 && exp().every(e => e.deletedAt) && drw().length === 1 && !drw()[0].deletedAt && drw()[0].amountCents === 1000);

  console.log("\n=== Bank-statement match ===");
  r = await call({ action: "receiveTransferSheet", receivedAt: "2026-09-20", vendor: "DTF Co", vendorRef: "S2", total: 50, accountId: acct, rows: [{ transferId: B, count: 5, pctOfSheet: 100 }] });
  const s2 = r.body.ids[0], g2 = live().find(m => m.id === s2).receiptGroup;
  d1._raw.run("INSERT INTO statement_lines (accountId, lineDate, description, amountCents, fingerprint, importBatch, importedAt) VALUES (?, '2026-09-21', 'DTF CO', -5000, 'fp1', 'b', 't')", [acct]);
  const lineId = d1.q("SELECT id FROM statement_lines")[0].id;
  d1._raw.run("INSERT INTO statement_matches (lineId, src, srcId, matchedAt, auto) VALUES (?, 'transfer_sheet', ?, 't', 0)", [lineId, s2]);
  ok("the sheet says it's matched", (await call({ action: "getTransferSheet", movementId: s2 })).body.sheet.matched === true);
  r = await call({ action: "editTransferSheet", movementId: s2, receivedAt: "2026-09-20", vendor: "DTF Co", vendorRef: "S2", total: 50, accountId: acct, rows: [{ transferId: B, count: 8, pctOfSheet: 100 }] });
  const newIds = live().filter(m => m.receiptGroup === g2).map(m => m.id);
  const matches = d1.q("SELECT srcId FROM statement_matches WHERE src = 'transfer_sheet' AND lineId = ?", lineId).map(m => m.srcId);
  ok("same total: the count can change, and the match moves to the new movements", r.status === 200 && newIds.length && matches.length === newIds.length && matches.every(id => newIds.includes(id)) && !matches.includes(s2));
  r = await call({ action: "editTransferSheet", movementId: newIds[0], receivedAt: "2026-09-20", vendor: "DTF Co", vendorRef: "S2", total: 60, accountId: acct, rows: [{ transferId: B, count: 8, pctOfSheet: 100 }] });
  ok("a different total is refused while matched", r.status === 400 && /matched to a bank-statement line/.test(r.body.message) && live().filter(m => m.receiptGroup === g2).length === newIds.length);

  console.log("\n=== An older sheet with no group and no % stored ===");
  await lib.receiveTransferSheet(d1, { rows: [{ transferId: A, count: 4, pctOfSheet: 100 }], totalCents: 2000, vendor: "Old", vendorRef: "L1", receivedAt: "2026-08-01", accountId: acct });
  d1._raw.run("UPDATE transfer_movements SET pctOfSheet = NULL WHERE vendorRef = 'L1'");
  const legacy = d1.q("SELECT id FROM transfer_movements WHERE vendorRef = 'L1'")[0].id;
  const ls = (await call({ action: "getTransferSheet", movementId: legacy })).body.sheet;
  ok("found by matching; its % comes from its cost", ls.receiptGroup === "" && ls.rows.length === 1 && ls.rows[0].pctOfSheet === 100 && ls.total === 20);
  r = await call({ action: "editTransferSheet", movementId: legacy, receivedAt: "2026-08-01", vendor: "Old", vendorRef: "L1", total: 20, accountId: acct, rows: [{ transferId: A, count: 5, pctOfSheet: 100 }] });
  ok("editing it gives it a group from now on", r.status === 200 && r.body.result.receiptGroup && live().filter(m => m.receiptGroup === r.body.result.receiptGroup).length === 1);

  console.log("\n=== Closed month, role ===");
  d1._raw.run("INSERT INTO closed_periods (month, closedAt, closedBy) VALUES ('2026-08','t','test')");
  const lg = live().find(m => m.receiptGroup === r.body.result.receiptGroup).id;
  r = await call({ action: "editTransferSheet", movementId: lg, receivedAt: "2026-08-01", vendor: "Old", vendorRef: "L1", total: 20, accountId: acct, rows: [{ transferId: A, count: 6, pctOfSheet: 100 }] });
  ok("a sheet in a closed month can't be edited", r.status === 409 && /closed/.test(r.body.message));
  const src = read("functions/api/orders.js");
  const mgr = src.match(/const MANAGER_ACTIONS = \[[\s\S]*?\];/)[0], staff = src.match(/const STAFF_ACTIONS = \[[\s\S]*?\];/)[0];
  ok("editing needs the manager role; reading a sheet is staff", /"editTransferSheet"/.test(mgr) && !/"editTransferSheet"/.test(staff) && /"getTransferSheet"/.test(staff));

  // The account that paid for the sheets opens in the account viewer. transfer_movements has no size or color column, and
  // grouping a sheet's rows into one receipt line used to ask for size, which failed with a 500.
  console.log("\n=== Account viewer for the paying account ===");
  r = await call({ action: "getAccountRegister", accountId: acct, dateFrom: "2026-01-01", dateTo: "2026-12-31" });
  const sheetRow = r.status === 200 && r.body.rows.find(x => x.category === "Transfers (stock)" && x.parts && x.parts.length > 1);
  ok("the paying account's register opens, with a sheet as one line", r.status === 200 && sheetRow && /^Transfer sheets — DTF Co #S1/.test(sheetRow.description));
  r = await call({ action: "getReconciliation", accountId: acct, month: "2026-09" });
  ok("reconciling that account's month works too", r.status === 200);

  console.log(failed ? `\n${failed} FAILED` : "\nAll passed");
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
