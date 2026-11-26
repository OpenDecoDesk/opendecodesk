const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { adminAs } = require("./testlib/roles");
const { ADMIN_ORIGIN } = require("./testlib/hosts.js");

// Voiding a transfer movement, restoring one and voiding a make of finished stock work the transfer's count out from
// its history inside the write (2026-11, review round 2). They used to read the history, replay it in JS and write
// that count back — and the void and the recount were separate writes. A use recorded in between (Run Order finishing
// a line) was overwritten, leaving the count too high, and a failure between the two writes left the entry voided with
// the old count. Now each is one batch, the count is SUM(qtyDelta) of the live movements, and the average cost is
// written only while the history is as read: otherwise nothing is written and the owner is asked to try again
// (the make of finished stock simply works it out again). Real migrations, db.js and orders.js on sql.js.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { createTransfer, receiveTransferSheet, writeOffTransfers, voidTransferMovement, restoreTransferMovement, voidFinishedGoodsMovement };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  strip(read("functions/_lib/permissions.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" + adminAs() + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();

let failed = 0;
const ok = (label, cond) => { if (!cond) failed++; console.log(label + ": " + !!cond); };
const STALE = "Stock changed while you were editing; try again.";

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('acme','acme','Example Club','t','t',1);
    INSERT INTO orders (orderId, orgId, customerName, contact, paymentMethod, paid, subtotalCents, totalCents, placedAt) VALUES ('U1','acme','Pat Example','pat@example.test','Card',1,4000,4000,'2026-09-08T00:00:00Z');
    INSERT INTO order_items (orderId, orgId, productId, name, type, qty, unitPriceCents, lineTotalCents, cancelDate, cogsCents, cogsSource) VALUES ('U1','acme','tee','Tee','tee',2,2000,4000,'',600,'consumed');`);
  const call = async (body) => {
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => Promise.resolve(p).catch(() => {}),
      request: { url: ADMIN_ORIGIN + "/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };

  // Lockup: 10 at $2.00 on Sep 1, 10 at $4.00 on Sep 5 (20 at $3.00); order U1 used 2 on Sep 8; 1 written off on Sep 9.
  const A = await lib.createTransfer(d1, { name: "Lockup" });
  await lib.receiveTransferSheet(d1, { rows: [{ transferId: A, count: 10, pctOfSheet: 100 }], totalCents: 2000, receivedAt: "2026-09-01" });
  await lib.receiveTransferSheet(d1, { rows: [{ transferId: A, count: 10, pctOfSheet: 100 }], totalCents: 4000, receivedAt: "2026-09-05" });
  const item = d1.q("SELECT id FROM order_items WHERE orderId = 'U1'")[0].id;
  d1._raw.run("INSERT INTO transfer_movements (transferId, transferName, qtyDelta, unitCostCents, kind, orderId, itemId, note, occurredAt, createdAt) VALUES (?, 'Lockup', -2, 300, 'consume', 'U1', ?, 'Used', '2026-09-08T00:00:00Z', 't')", [A, item]);
  d1._raw.run("UPDATE transfers SET quantity = quantity - 2 WHERE id = ?", [A]);
  await lib.writeOffTransfers(d1, { transferId: A, qty: 1, note: "Misprint", occurredAt: "2026-09-09" });
  const mvId = (where) => d1.q(`SELECT id FROM transfer_movements WHERE transferId = ? AND ${where} ORDER BY id`, A)[0].id;
  const sheet2 = mvId("kind = 'purchase' AND occurredAt LIKE '2026-09-05%'"), use = mvId("kind = 'consume'"), writeoff = mvId("kind = 'writeoff'");
  const t = () => d1.q("SELECT quantity q, purchasePriceCents c FROM transfers WHERE id = ?", A)[0];
  const sum = () => d1.q("SELECT COALESCE(SUM(qtyDelta), 0) s FROM transfer_movements WHERE transferId = ? AND voidedAt IS NULL", A)[0].s;
  const isVoided = (id) => !!d1.q("SELECT voidedAt FROM transfer_movements WHERE id = ?", id)[0].voidedAt;
  ok("set up: 17 on hand at $3.00, matching the history", t().q === 17 && t().c === 300 && sum() === 17);

  // Every write: each batch (its SQL) and each statement run on its own. `meanwhile` runs once, just before the first
  // write that sets a transfer's count — Run Order using one Lockup at that moment. `breakOn` makes that write fail.
  const log = { batches: [], runs: [] };
  let meanwhile = null, breakOn = null;
  const setsCount = (s) => /UPDATE transfers SET quantity/.test(s);
  const before = (sqls) => {
    if (breakOn && sqls.some(s => breakOn.test(s))) { breakOn = null; throw new Error("D1_ERROR: the network dropped (test)"); }
    if (meanwhile && sqls.some(setsCount)) { const f = meanwhile; meanwhile = null; f(); }
  };
  const batch = d1.batch.bind(d1), prepare = d1.prepare.bind(d1);
  d1.batch = async (stmts) => { const sqls = stmts.map(s => s._sql); log.batches.push(sqls); before(sqls); return batch(stmts); };
  const wrap = (st, sql) => Object.assign({}, st, { run: async () => { log.runs.push(sql); before([sql]); return st.run(); }, bind: (...a) => wrap(st.bind(...a), sql) });
  d1.prepare = (sql) => wrap(prepare(sql), String(sql));
  const watch = () => { log.batches = []; log.runs = []; };
  const runOrderUsesOne = () => {
    d1._raw.run("INSERT INTO transfer_movements (transferId, transferName, qtyDelta, unitCostCents, kind, orderId, itemId, note, occurredAt, createdAt) VALUES (?, 'Lockup', -1, (SELECT purchasePriceCents FROM transfers WHERE id = ?), 'consume', 'U2', NULL, 'Used', '2026-09-20T00:00:00Z', 't')", [A, A]);
    d1._raw.run("UPDATE transfers SET quantity = quantity - 1 WHERE id = ?", [A]);
  };
  const writesStock = (s) => /transfer_movements|UPDATE transfers|cogsCents/.test(s) && !/^\s*SELECT/i.test(s);
  const tryIt = async (fn) => { try { return { value: await fn() }; } catch (e) { return { error: e }; } };

  console.log("=== Voiding a sheet while Run Order uses one ===");
  meanwhile = runOrderUsesOne;
  watch();
  let r = await tryIt(() => lib.voidTransferMovement(d1, sheet2, "Wrong sheet"));
  ok("the void is refused: Stock changed while you were editing; try again", r.error && r.error.userFacing && r.error.message === STALE);
  ok("…nothing written: the sheet still counts, and the count keeps the use (16 at $3.00)", !isVoided(sheet2) && t().q === 16 && t().c === 300 && sum() === 16);
  watch();
  r = await tryIt(() => lib.voidTransferMovement(d1, sheet2, "Wrong sheet"));
  ok("trying again voids it", r.value && r.value.id === sheet2 && isVoided(sheet2));
  ok("…in ONE batch, the void last, and nothing written on its own", log.batches.filter(b => b.some(writesStock)).length === 1 && !log.runs.some(writesStock) &&
    /SET voidedAt/.test(log.batches.find(b => b.some(writesStock)).at(-1)));
  ok("…the count from the history (6) and the average from the first sheet ($2.00)", t().q === 6 && t().c === 200 && sum() === 6);

  console.log("\n=== Restoring it while Run Order uses one ===");
  meanwhile = runOrderUsesOne;
  r = await tryIt(() => lib.restoreTransferMovement(d1, sheet2));
  ok("the restore is refused the same way, and writes nothing", r.error && r.error.message === STALE && isVoided(sheet2) && t().q === 5 && sum() === 5 && t().c === 200);
  watch();
  r = await tryIt(() => lib.restoreTransferMovement(d1, sheet2));
  ok("trying again restores it: 15 at $3.00, from the history", r.value && !isVoided(sheet2) && t().q === 15 && t().c === 300 && sum() === 15);
  ok("…in ONE batch, nothing written on its own", log.batches.filter(b => b.some(writesStock)).length === 1 && !log.runs.some(writesStock));

  console.log("\n=== A failure between the void and the count ===");
  breakOn = /UPDATE transfers SET quantity/;
  r = await tryIt(() => lib.voidTransferMovement(d1, writeoff, "Not a misprint"));
  ok("the write fails", r.error && /network dropped/.test(r.error.message));
  ok("…and leaves nothing half done: the write-off still counts, and so does the count", !isVoided(writeoff) && t().q === 15 && sum() === 15);
  r = await tryIt(() => lib.voidTransferMovement(d1, writeoff, "Not a misprint"));
  ok("trying again does both (16)", r.value && isVoided(writeoff) && t().q === 16 && sum() === 16);

  console.log("\n=== Voiding an order's use while Run Order uses one ===");
  meanwhile = runOrderUsesOne;
  r = await tryIt(() => lib.voidTransferMovement(d1, use, "Made without it"));
  const cogs = () => d1.q("SELECT cogsCents FROM order_items WHERE id = ?", item)[0].cogsCents;
  ok("refused, nothing written: the use, the line's cost and the count stay", r.error && r.error.message === STALE && !isVoided(use) && cogs() === 600 && t().q === 15 && sum() === 15);
  r = await tryIt(() => lib.voidTransferMovement(d1, use, "Made without it"));
  ok("trying again: the use is voided, its cost comes off the line, the count is the history (17)", r.value && isVoided(use) && cogs() === 0 && t().q === 17 && sum() === 17);

  console.log("\n=== Through the admin API ===");
  const sheet1 = mvId("kind = 'purchase' AND occurredAt LIKE '2026-09-01%'");
  meanwhile = runOrderUsesOne;
  let res = await call({ action: "voidTransferMovement", movementId: sheet1, reason: "Wrong sheet" });
  ok("a refused void answers 409 with the message the screen shows", res.status === 409 && res.body.message === STALE && !isVoided(sheet1) && t().q === sum());
  meanwhile = runOrderUsesOne;
  res = await call({ action: "restoreTransferMovement", movementId: writeoff });
  ok("…and so does a refused restore", res.status === 409 && res.body.message === STALE && isVoided(writeoff) && t().q === sum());

  console.log("\n=== Voiding a make of finished stock while Run Order uses one ===");
  d1._raw.exec(`INSERT INTO ready_to_ship (orgId, productId, size, variant, quantity, avgCostCents, updatedAt) VALUES ('acme','tee','M','',2,900,'t');
    INSERT INTO finished_goods_movements (orgId, productId, productName, color, size, variant, qtyDelta, unitCostCents, kind, occurredAt, createdAt) VALUES ('acme','tee','Tee','','M','',2,900,'make','2026-09-21T00:00:00Z','t');`);
  const make = d1.q("SELECT id FROM finished_goods_movements WHERE kind = 'make'")[0].id;
  d1._raw.run("INSERT INTO transfer_movements (transferId, transferName, qtyDelta, unitCostCents, kind, reason, finishedMovementId, note, occurredAt, createdAt) VALUES (?, 'Lockup', -2, 300, 'consume', 'finished', ?, 'Made for stock', '2026-09-21T00:00:00Z', 't')", [A, make]);
  d1._raw.run("UPDATE transfers SET quantity = quantity - 2 WHERE id = ?", [A]);
  const onHand = t().q;
  meanwhile = runOrderUsesOne;
  watch();
  r = await tryIt(() => lib.voidFinishedGoodsMovement(d1, make, "Typed by mistake"));
  ok("the make is voided (the transfers' part is worked out again after the use landed)", r.value && d1.q("SELECT voidedAt FROM finished_goods_movements WHERE id = ?", make)[0].voidedAt &&
    d1.q("SELECT count(*) n FROM transfer_movements WHERE finishedMovementId = ? AND voidedAt IS NULL", make)[0].n === 0);
  ok("…its 2 transfers are back, and the use that landed meanwhile still counts", t().q === onHand + 2 - 1 && t().q === sum());
  ok("…each try is one batch with the transfers' void last; nothing written on its own", log.batches.filter(b => b.some(s => /UPDATE transfers SET quantity/.test(s))).length === 2 &&
    log.batches.filter(b => b.some(s => /UPDATE transfers SET quantity/.test(s))).every(b => /finishedMovementId=\? AND voidedAt IS NULL/.test(b.at(-1))) && !log.runs.some(s => /transfer_movements|UPDATE transfers/.test(s) && !/^\s*SELECT/i.test(s)));

  console.log(failed ? `\n${failed} FAILED` : "\nAll passed");
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); console.log("test346 crashed: false"); process.exit(1); });
