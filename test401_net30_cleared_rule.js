process.env.TZ = "UTC";
const fs = require("fs");
const { ok } = require("./testlib/check");
const { createD1 } = require("./testlib/d1-shim.js");

// Phase 7, the one Net 30 rule (migrations/0121): an order on Net 30 counts as paid for the WORK once its PO is accepted,
// while the money stays owed.
//   net30Cleared / workCleared (db.js)        each field of the rule, alone and together
//   NET30_CLEARED_SQL_ / workClearedSql_ /    the SQL forms give the same answer as the JS for a table of orders
//   paidOrNet30Sql_                           (paid, paid for the work, pay on delivery, Net 30 with no PO, a PO typed but
//                                             not accepted, an accepted PO, a blank PO, a PO of spaces, an accepted PO
//                                             on an order not on Net 30), with any alias
//   before migrations/0121                    the SQL leaves Net 30 out and every queue and gate still works; the
//                                             column is picked up as soon as it exists
//   the queues and gates                      getOpenOrderStages (Home's step and poStatus), homeOrderStage,
//                                             getBlanksToOrder, getPaidUnrunOrders, the Run order (embroidery, DTF and the
//                                             other printed cards), stagePrereqError, whyNotCompletable_ and
//                                             setOrdersCompleted, grantOrderDownloads, the Fundraising report
//   the money                                 accepting a PO marks nothing paid: the order's balance, the Revenue
//                                             report's received and Home's money in count real payments only
// Real SQL (sql.js) and the real db.js. Invented data only; every date is fixed (the time zone is UTC here).
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const lib = new Function(strip(read("functions/_lib/db.js")) + `\nreturn { net30Cleared, workCleared, NET30_CLEARED_SQL_, workClearedSql_, paidOrNet30Sql_,
  homeOrderStage, orderPoStatus_, whyNotCompletable_, setOrdersCompleted, grantOrderDownloads, getOpenOrderStages, getPaidUnrunOrders,
  getBlanksToOrder, getRunQueue, getFundraisingReport, setOrgFundraiser, insertOrder, createProduct, createBlank, setBlankLink, getOrderById,
  stagePrereqError, settleOrderBalance, addProductFile, acceptOrderPo, setOrderTerms, getRevenueData, getMoneyInOutByMonth, getUnpaidPoReport };`)();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const MIGRATIONS = fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort();
async function freshDb(before) {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of MIGRATIONS) if (!before || f < before) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('club','club','Example Club','t','t');`);
  return d1;
}
const ACC = "2026-10-02T15:00:00.000Z";

(async () => {
  const { net30Cleared: C, workCleared: W } = lib;
  console.log("=== net30Cleared: Net 30, a PO, and staff's acceptance, all three ===");
  const full = { net30: 1, poNumber: "PO-1001", poAcceptedAt: ACC };
  ok("Net 30 with a PO that staff accepted counts", C(full) === true);
  ok("…not without Net 30 (0, false or missing)", C({ ...full, net30: 0 }) === false && C({ ...full, net30: false }) === false && C({ poNumber: "PO-1001", poAcceptedAt: ACC }) === false);
  ok("…not without a PO (blank, missing or null)", C({ ...full, poNumber: "" }) === false && C({ net30: 1, poAcceptedAt: ACC }) === false && C({ ...full, poNumber: null }) === false);
  ok("…not with a PO of spaces only", C({ ...full, poNumber: "   " }) === false);
  ok("…a PO with spaces around it still counts", C({ ...full, poNumber: "  PO-1001 " }) === true);
  ok("…not while the PO waits to be accepted (no poAcceptedAt, or null)", C({ net30: 1, poNumber: "PO-1001" }) === false && C({ ...full, poAcceptedAt: null }) === false &&
    C({ ...full, poAcceptedAt: "" }) === false);
  ok("…a PO typed by the customer is not enough on its own", C({ net30: 1, poNumber: "PO-1001", poTypedAt: ACC }) === false);
  ok("…the answer is always a boolean, and no order is no", C(null) === false && C(undefined) === false && C({}) === false);
  ok("…being paid has nothing to do with it", C({ paid: 1 }) === false && C({ ...full, paid: 0 }) === true);

  console.log("\n=== workCleared: any one of paid, paid for the work, pay on delivery, or Net 30 cleared ===");
  ok("paid", W({ paid: 1 }) === true);
  ok("paid for everything but a rush fee", W({ paidForWork: 1 }) === true);
  ok("set to pay on delivery", W({ payOnDelivery: 1 }) === true);
  ok("Net 30 with an accepted PO", W(full) === true);
  ok("Net 30 with no PO, or a PO still to check, is not cleared", W({ net30: 1 }) === false && W({ net30: 1, poNumber: "PO-1001", poTypedAt: ACC }) === false);
  ok("nothing at all is not cleared, and no order is no", W({}) === false && W(null) === false && W(undefined) === false);

  console.log("\n=== The SQL forms agree with the JS, order by order ===");
  const d1 = await freshDb();
  const q = (sql, ...p) => d1.q(sql, ...p);
  const TABLE = [
    ["T-PAID", { paid: 1 }, "paid in full"],
    ["T-PFW", { paidForWork: 1 }, "paid for everything but a rush fee"],
    ["T-POD", { payOnDelivery: 1 }, "pay on delivery"],
    ["T-NONE", {}, "unpaid, nothing else"],
    ["T-N30", { net30: 1 }, "Net 30 with no PO"],
    ["T-TYPED", { net30: 1, poNumber: "PO-1001", poTypedAt: ACC }, "Net 30 with a PO typed by the customer, not accepted"],
    ["T-ACC", { net30: 1, poNumber: "PO-1002", poAcceptedAt: ACC, poAcceptedBy: "pat@example.com" }, "Net 30 with an accepted PO"],
    ["T-ACCPAID", { net30: 1, poNumber: "PO-1003", poAcceptedAt: ACC, paid: 1 }, "Net 30 with an accepted PO, paid too"],
    ["T-OFF", { net30: 0, poNumber: "PO-1004", poAcceptedAt: ACC }, "an accepted PO on an order not on Net 30"],
    ["T-BLANK", { net30: 1, poNumber: "", poAcceptedAt: ACC }, "Net 30, acceptance stamped but the PO blank"],
    ["T-SPACES", { net30: 1, poNumber: "   ", poTypedAt: ACC }, "Net 30 with a PO of spaces, not accepted"],
    ["T-TYPEDPAID", { net30: 1, poNumber: "PO-1005", poTypedAt: ACC, paid: 1 }, "Net 30 with a PO to check, paid in full"],
  ];
  for (const [id, cols] of TABLE) {
    q("INSERT INTO orders (orderId, orgId, customerName, contact, placedAt) VALUES (?, 'club', 'Pat Example', 'pat@example.com', '2026-10-01T15:00:00.000Z')", id);
    for (const [k, v] of Object.entries(cols)) q(`UPDATE orders SET ${k} = ? WHERE orderId = ?`, v, id);
  }
  const wSql = await lib.workClearedSql_(d1), pSql = await lib.paidOrNet30Sql_(d1);
  const rows = q(`SELECT o.*, ${lib.NET30_CLEARED_SQL_("o")} AS sqlN30, ${wSql()} AS sqlWork, ${pSql()} AS sqlPaid,
    ${lib.NET30_CLEARED_SQL_()} AS sqlN30Default FROM orders o ORDER BY o.orderId`);
  const byId = Object.fromEntries(rows.map(r => [r.orderId, r]));
  const expect = { // [net30Cleared, workCleared, paid-or-net30]
    "T-PAID": [0, 1, 1], "T-PFW": [0, 1, 0], "T-POD": [0, 1, 0], "T-NONE": [0, 0, 0], "T-N30": [0, 0, 0], "T-TYPED": [0, 0, 0],
    "T-ACC": [1, 1, 1], "T-ACCPAID": [1, 1, 1], "T-OFF": [0, 0, 0], "T-BLANK": [0, 0, 0], "T-SPACES": [0, 0, 0], "T-TYPEDPAID": [0, 1, 1] };
  for (const [id, , words] of TABLE) {
    const r = byId[id], [n, w, p] = expect[id];
    ok(`${words}: the JS says ${n ? "Net 30 cleared" : "not Net 30 cleared"}, ${w ? "work cleared" : "work not cleared"}, ${p ? "counts as paid" : "doesn't count as paid"}`,
      lib.net30Cleared(r) === !!n && lib.workCleared(r) === !!w && (!!Number(r.paid) || lib.net30Cleared(r)) === !!p);
    ok(`${words}: NET30_CLEARED_SQL_, workClearedSql_ and paidOrNet30Sql_ say the same`,
      r.sqlN30 === n && r.sqlN30Default === n && r.sqlWork === w && r.sqlPaid === p);
  }
  ok("the SQL forms take another table alias", (() => {
    const r = q(`SELECT ${lib.NET30_CLEARED_SQL_("x")} AS a, ${wSql("x")} AS b, ${pSql("x")} AS c FROM orders x WHERE x.orderId = 'T-ACC'`)[0];
    return r.a === 1 && r.b === 1 && r.c === 1;
  })());
  ok("workClearedSql_ names Net 30 only through NET30_CLEARED_SQL_ (the one rule)", wSql("a").includes(lib.NET30_CLEARED_SQL_("a")) && pSql("a").includes(lib.NET30_CLEARED_SQL_("a")));

  console.log("\n=== Before migrations/0121 ===");
  {
    const old = await freshDb("0121");
    const oq = (sql, ...p) => old.q(sql, ...p);
    const ow = await lib.workClearedSql_(old), op = await lib.paidOrNet30Sql_(old);
    ok("workClearedSql_ leaves Net 30 out (still paid, paid for the work, pay on delivery)", ow() === "(o.paid = 1 OR o.paidForWork = 1 OR o.payOnDelivery = 1)");
    ok("paidOrNet30Sql_ is paid alone", op() === "o.paid = 1" && op("x") === "x.paid = 1");
    await lib.createProduct(old, "club", { productId: "cap", type: "cap", name: "Example Cap", pricingMode: "flat", flatPrice: 20, visible: true, noDesignNeeded: true, noBlankNeeded: true });
    await lib.insertOrder(old, { orderId: "OLD-1", orgId: "club", customerName: "Pat Example", contact: "pat@example.com", placedAt: "2026-10-01T15:00:00.000Z" },
      [{ productId: "cap", name: "Example Cap", type: "cap", size: "OSFA", qty: 1, unitPrice: 20 }]);
    await lib.insertOrder(old, { orderId: "OLD-2", orgId: "club", customerName: "Sam Example", contact: "sam@example.com", placedAt: "2026-10-02T15:00:00.000Z" },
      [{ productId: "cap", name: "Example Cap", type: "cap", size: "OSFA", qty: 1, unitPrice: 20 }]);
    oq("UPDATE orders SET paid = 1 WHERE orderId = 'OLD-1'");
    const st = await lib.getOpenOrderStages(old);
    ok("Home's steps still work: the paid one is past new, the unpaid one is new with no PO status",
      st.find(s => s.orderId === "OLD-1").stage !== "new" && same(Object.keys(st.find(s => s.orderId === "OLD-2")).sort(), ["orderId", "orgId", "placedAt", "stage"]) &&
      st.find(s => s.orderId === "OLD-2").stage === "new");
    const un = await lib.getPaidUnrunOrders(old);
    ok("the run backlog still works (the paid order only)", un.map(o => o.orderId).join() === "OLD-1");
    const bto = await lib.getBlanksToOrder(old);
    ok("blanks to order still works", Array.isArray(bto.suppliers) && bto.unpaidOrders === 0);
    const rq = await lib.getRunQueue(old);
    ok("the Run order still works", Array.isArray(rq.embroidery) && Array.isArray(rq.transfers.ready) && Array.isArray(rq.other.ready));
    oq("UPDATE orders SET deliveredAt = '2026-10-05T15:00:00.000Z' WHERE orderId IN ('OLD-1', 'OLD-2')");
    const g = await lib.grantOrderDownloads(old, "OLD-2");
    ok("downloads: an unpaid order is still not paid", g.paid === false && g.created === 0);
    ok("downloads: a paid order still is", (await lib.grantOrderDownloads(old, "OLD-1")).paid === true);
    const sc = await lib.setOrdersCompleted(old, ["OLD-1", "OLD-2"], true, "2026-10-06T15:00:00.000Z");
    ok("completing: the paid order completes, the unpaid one still owes", same(sc.updated.map(u => u.orderId), ["OLD-1"]) &&
      same(sc.skipped, [{ orderId: "OLD-2", reason: "a balance is still due" }]));
    const fr = await lib.getFundraisingReport(old, { dateFrom: "2026-10-01", dateTo: "2026-10-31", basis: "placed" });
    ok("the Fundraising report still works", Array.isArray(fr.shops) && !fr.error);
    const rep = await lib.getUnpaidPoReport(old, { asOf: "2026-10-31", tz: "UTC" });
    ok("the Unpaid POs report is empty", rep.rows.length === 0 && rep.totals.count === 0);
    old.execFile(read("migrations/0121_terms_and_own_garments.sql"));
    ok("once the migration runs, the next query counts Net 30 (a missing column isn't remembered)",
      (await lib.workClearedSql_(old))().includes("net30 = 1") && (await lib.paidOrNet30Sql_(old))().includes("poAcceptedAt IS NOT NULL"));
  }

  console.log("\n=== Home's step and the PO status (homeOrderStage, orderPoStatus_) ===");
  const H = lib.homeOrderStage;
  ok("Net 30 with no PO is new", H({ net30: true, poNumber: "" }) === "new");
  ok("Net 30 with a PO to check is new", H({ net30: true, poNumber: "PO-1001", poTypedAt: ACC }) === "new");
  ok("Net 30 with an accepted PO goes on like a paid order (blanks to order next)", H({ net30: true, poNumber: "PO-1001", poAcceptedAt: ACC }) === "paid");
  ok("…and on to the run once its blanks are in", H({ net30: true, poNumber: "PO-1001", poAcceptedAt: ACC, blankOrderedAt: ACC, blankReceivedAt: ACC }) === "run");
  ok("the PO status: '' when not Net 30, PO needed, PO to check, accepted",
    lib.orderPoStatus_({ net30: false, poNumber: "PO-1" }) === "" && lib.orderPoStatus_(null) === "" && lib.orderPoStatus_({ net30: true }) === "PO needed" &&
    lib.orderPoStatus_({ net30: true, poNumber: "  " }) === "PO needed" && lib.orderPoStatus_({ net30: true, poNumber: "PO-1" }) === "PO to check" &&
    lib.orderPoStatus_({ net30: true, poNumber: "PO-1", poAcceptedAt: ACC }) === "accepted");

  console.log("\n=== Completing: whyNotCompletable_ ===");
  const base = { activeItems: 1, deliveredAt: "2026-10-05T15:00:00.000Z" };
  ok("an accepted Net 30 order can be completed while money is owed", lib.whyNotCompletable_({ ...base, paid: 0, ...full }) === "");
  ok("…a PO to check can't", lib.whyNotCompletable_({ ...base, paid: 0, net30: 1, poNumber: "PO-1001", poTypedAt: ACC }) === "a balance is still due");
  ok("…Net 30 with no PO can't", lib.whyNotCompletable_({ ...base, paid: 0, net30: 1 }) === "a balance is still due");
  ok("pay on delivery still waits for the payment", lib.whyNotCompletable_({ ...base, paid: 0, payOnDelivery: 1 }) === "a balance is still due");
  ok("paid for the work but owing a rush fee still waits", lib.whyNotCompletable_({ ...base, paid: 0, paidForWork: 1 }) === "a balance is still due");
  ok("an accepted Net 30 order not delivered yet can't", lib.whyNotCompletable_({ activeItems: 1, paid: 0, ...full }) === "not delivered yet");
  ok("…nor a voided one", lib.whyNotCompletable_({ ...base, ...full, voidedAt: ACC }) === "the order is voided");

  console.log("\n=== The queues, from the real SQL ===");
  await lib.createProduct(d1, "club", { productId: "tee", type: "shirt", name: "Example Tee", pricingMode: "flat", flatPrice: 20, visible: true, noDesignNeeded: true });
  await lib.createProduct(d1, "club", { productId: "cap", type: "cap", name: "Example Cap", pricingMode: "flat", flatPrice: 20, visible: true, noDesignNeeded: true, noBlankNeeded: true });
  const blankId = (await lib.createBlank(d1, { name: "Example Tee Blank", brand: "Sample", color: "Navy", productType: "shirt" })).id;
  await lib.setBlankLink(d1, "club", "tee", "Navy", "L", blankId, "Navy", "L");
  const loc = (decoration, label) => ({ location: label.toLowerCase(), label, kind: decoration === "embroidery" ? "embroidery" : "transfer", decoration, graphicName: "Crest " + label, ink: "Red" });
  const QORDERS = {
    "Q-PAID": { paid: 1 }, "Q-NONE": {}, "Q-N30": { net30: 1 }, "Q-TYPED": { net30: 1, poNumber: "PO-2001", poTypedAt: ACC },
    "Q-ACC": { net30: 1, poNumber: "PO-2002", poAcceptedAt: ACC }, "Q-OFF": { net30: 0, poNumber: "PO-2003", poAcceptedAt: ACC },
    "Q-TYPEDPAID": { net30: 1, poNumber: "PO-2004", poTypedAt: ACC, paid: 1 },
  };
  let n = 0;
  for (const [id, cols] of Object.entries(QORDERS)) {
    n++;
    await lib.insertOrder(d1, { orderId: id, orgId: "club", customerName: "Cust " + id, contact: "pat@example.com", placedAt: `2026-10-${String(10 + n)}T15:00:00.000Z` },
      [{ productId: "tee", name: "Example Tee", type: "shirt", size: "L", qty: 2, unitPrice: 20,
        config: { garmentColor: "Navy", locations: [loc("dtf", "Back"), loc("screenprint", "Sleeve")] } },
       { productId: "cap", name: "Example Cap", type: "cap", size: "OSFA", qty: 1, unitPrice: 20 }]);
    for (const [k, v] of Object.entries(cols)) q(`UPDATE orders SET ${k} = ? WHERE orderId = ?`, v, id);
  }
  const CLEARED = ["Q-ACC", "Q-PAID", "Q-TYPEDPAID"], NOT = ["Q-N30", "Q-NONE", "Q-OFF", "Q-TYPED"];
  const only = (list) => [...new Set(list)].filter(id => id.startsWith("Q-")).sort();

  const stages = await lib.getOpenOrderStages(d1);
  const st = (id) => stages.find(s => s.orderId === id);
  ok("Home: an accepted Net 30 order moves past new (blanks to order) with no PO status", st("Q-ACC").stage === "paid" && !("poStatus" in st("Q-ACC")));
  ok("Home: Net 30 with no PO is new, poStatus 'PO needed'", st("Q-N30").stage === "new" && st("Q-N30").poStatus === "PO needed");
  ok("Home: a PO the customer typed is new, poStatus 'PO to check'", st("Q-TYPED").stage === "new" && st("Q-TYPED").poStatus === "PO to check");
  ok("Home: a PO to check on an order already paid isn't flagged (poStatus only while new)", st("Q-TYPEDPAID").stage === "paid" && !("poStatus" in st("Q-TYPEDPAID")));
  ok("Home: an unpaid order not on Net 30 is new with no PO status, even with an accepted PO on it", st("Q-OFF").stage === "new" && !("poStatus" in st("Q-OFF")) &&
    st("Q-NONE").stage === "new" && !("poStatus" in st("Q-NONE")));

  const bto = await lib.getBlanksToOrder(d1);
  const ordersOf = (b) => b.suppliers.flatMap(s => s.rows).flatMap(r => r.orders);
  const toOrder = only(ordersOf(bto));
  ok("blanks to order: the cleared orders' blanks are to order (an accepted PO counts as paid)", same(toOrder, CLEARED));
  ok("…the others are counted as unpaid, a PO to check among them", bto.unpaidOrders === NOT.length && bto.unpaidPieces === NOT.length * 2);
  ok("…asked to include unpaid ones, every order is there", same(only(ordersOf(await lib.getBlanksToOrder(d1, { includeUnpaid: true }))), [...CLEARED, ...NOT].sort()));

  ok("the blanks step: an accepted Net 30 order may order its blanks", lib.stagePrereqError(await lib.getOrderById(d1, "Q-ACC"), "blankOrdered") === "");
  ok("…a PO to check may not yet", /isn't paid/.test(lib.stagePrereqError(await lib.getOrderById(d1, "Q-TYPED"), "blankOrdered")));

  const unrun = await lib.getPaidUnrunOrders(d1);
  ok("the run backlog (getPaidUnrunOrders) lists the cleared orders and no other", same(only(unrun.map(o => o.orderId)), CLEARED));

  q("UPDATE orders SET blankOrderedAt = ?, blankReceivedAt = ?, designApprovedAt = ? WHERE orderId LIKE 'Q-%'", ACC, ACC, ACC);
  const rq = await lib.getRunQueue(d1);
  ok("the Run order's embroidery (getProductionQueue) has the cleared orders' lines and no other", same(only(rq.embroidery.map(j => j.orderId)), CLEARED));
  ok("the DTF transfer cards (getTransferQueue) are the cleared orders'", same(only(rq.transfers.ready.concat(rq.transfers.waiting).map(c => c.orderId)), CLEARED));
  ok("the other printed cards (screen print) are the cleared orders'", same(only(rq.other.ready.concat(rq.other.waiting).map(c => c.orderId)), CLEARED) && rq.counts.screenprint === CLEARED.length);

  console.log("\n=== Accepting the PO clears the order everywhere at once ===");
  const acc = await lib.acceptOrderPo(d1, "Q-TYPED", "pat@example.com", "2026-10-20T15:00:00.000Z");
  ok("Accept PO says the order is now cleared, and wasn't", acc.ok === true && acc.cleared === true && acc.wasCleared === false);
  ok("…and every queue now has it", (await lib.getPaidUnrunOrders(d1)).some(o => o.orderId === "Q-TYPED") &&
    (await lib.getRunQueue(d1)).embroidery.some(j => j.orderId === "Q-TYPED") && (await lib.getOpenOrderStages(d1)).find(s => s.orderId === "Q-TYPED").stage !== "new");
  const o = await lib.getOrderById(d1, "Q-TYPED");
  ok("…but it isn't marked paid: the whole balance is still owed", o.paid === false && Number(o.balanceDue) > 0 && q("SELECT paid FROM orders WHERE orderId='Q-TYPED'")[0].paid === 0);
  ok("…the order reads as accepted", o.poStatus === "accepted" && o.net30 === true);
  const off = await lib.setOrderTerms(d1, "Q-TYPED", { poNumber: "", by: "pat@example.com" });
  ok("clearing the PO takes it out of the queues again", off.cleared === false && off.wasCleared === true && !(await lib.getPaidUnrunOrders(d1)).some(o => o.orderId === "Q-TYPED"));

  console.log("\n=== Completing: setOrdersCompleted ===");
  q("UPDATE orders SET deliveredAt = '2026-10-25T15:00:00.000Z' WHERE orderId IN ('Q-ACC', 'Q-N30', 'Q-OFF', 'Q-TYPED')");
  q("UPDATE orders SET payOnDelivery = 1 WHERE orderId = 'Q-OFF'");
  const sc = await lib.setOrdersCompleted(d1, ["Q-ACC", "Q-N30", "Q-OFF", "Q-TYPED"], true, "2026-10-26T15:00:00.000Z");
  ok("a delivered Net 30 order with an accepted PO is completed while money is owed", same(sc.updated, [{ orderId: "Q-ACC", orgId: "club" }]) &&
    q("SELECT completedAt FROM orders WHERE orderId='Q-ACC'")[0].completedAt === "2026-10-26T15:00:00.000Z");
  ok("…no PO, a cleared PO, and pay on delivery unpaid are refused as owing", same(sc.skipped.map(s => s.orderId + " " + s.reason),
    ["Q-N30 a balance is still due", "Q-OFF a balance is still due", "Q-TYPED a balance is still due"]));
  const rep = await lib.getUnpaidPoReport(d1, { asOf: "2026-10-31", tz: "UTC" });
  ok("the completed order stays on the Unpaid POs report until it's paid", rep.rows.some(r => r.orderId === "Q-ACC" && r.owedCents > 0));

  console.log("\n=== Downloads: grantOrderDownloads ===");
  await lib.createProduct(d1, "club", { productId: "art", type: "other", name: "Example Design Files", pricingMode: "flat", flatPrice: 12, visible: true, digital: true });
  await lib.addProductFile(d1, "club", "art", { fileKey: "digital/club/art/" + "a".repeat(32) + ".dst", fileName: "art.dst", fileExt: "dst", bytes: 12 });
  const dig = async (id, cols) => {
    await lib.insertOrder(d1, { orderId: id, orgId: "club", customerName: "Pat Example", contact: "pat@example.com", placedAt: "2026-10-03T15:00:00.000Z" },
      [{ productId: "art", name: "Example Design Files", type: "other", qty: 1, unitPrice: 12 }]);
    for (const [k, v] of Object.entries(cols)) q(`UPDATE orders SET ${k} = ? WHERE orderId = ?`, v, id);
  };
  await dig("D-ACC", { net30: 1, poNumber: "PO-3001", poAcceptedAt: ACC });
  await dig("D-TYPED", { net30: 1, poNumber: "PO-3002", poTypedAt: ACC });
  await dig("D-VOID", { net30: 1, poNumber: "PO-3003", poAcceptedAt: ACC, voidedAt: ACC });
  await dig("D-OFF", { net30: 0, poNumber: "PO-3004", poAcceptedAt: ACC });
  const now = new Date("2026-10-04T15:00:00.000Z");
  let g = await lib.grantOrderDownloads(d1, "D-ACC", { now });
  ok("an accepted Net 30 order gets its files while the invoice is owed", g.paid === true && g.created === 1 && g.grants.length === 1);
  g = await lib.grantOrderDownloads(d1, "D-TYPED", { now });
  ok("a PO still to check gets nothing yet", g.paid === false && g.created === 0 && g.grants.length === 0);
  g = await lib.grantOrderDownloads(d1, "D-OFF", { now });
  ok("an accepted PO on an order not on Net 30 gets nothing", g.paid === false && g.created === 0);
  g = await lib.grantOrderDownloads(d1, "D-VOID", { now });
  ok("a voided order gets nothing, accepted PO or not", g.paid === false && g.created === 0);
  ok("an order that isn't there gets nothing", (await lib.grantOrderDownloads(d1, "D-NOPE", { now })).paid === false);
  await lib.acceptOrderPo(d1, "D-TYPED", "pat@example.com", "2026-10-04T16:00:00.000Z");
  g = await lib.grantOrderDownloads(d1, "D-TYPED", { now });
  ok("…once its PO is accepted, the files go out", g.paid === true && g.created === 1);
  ok("…and the order is still unpaid on the record", q("SELECT paid FROM orders WHERE orderId='D-TYPED'")[0].paid === 0);

  console.log("\n=== The Fundraising report's paid orders (paidOrNet30Sql_) ===");
  const f1 = await freshDb();
  const fq = (sql, ...p) => f1.q(sql, ...p);
  await lib.setOrgFundraiser(f1, "club", { mode: "percent", percent: 10, label: "Example Boosters" });
  const FR = {
    "F-PAID": { paid: 1 }, "F-ACC": { net30: 1, poNumber: "PO-4001", poAcceptedAt: ACC }, "F-TYPED": { net30: 1, poNumber: "PO-4002", poTypedAt: ACC },
    "F-N30": { net30: 1 }, "F-OFF": { net30: 0, poNumber: "PO-4003", poAcceptedAt: ACC }, "F-POD": { payOnDelivery: 1 }, "F-PFW": { paidForWork: 1 },
  };
  for (const [id, cols] of Object.entries(FR)) {
    fq("INSERT INTO orders (orderId, orgId, customerName, contact, placedAt, taxMode) VALUES (?, 'club', 'Pat Example', 'pat@example.com', '2026-10-10T15:00:00.000Z', 'exclusive')", id);
    fq(`INSERT INTO order_items (orderId, orgId, productId, name, type, qty, unitPriceCents, lineTotalCents, taxCents, taxRateBps, fundraiserCents)
      VALUES (?, 'club', 'tee', 'Example Tee', 'shirt', 1, 2000, 2000, 0, 0, 200)`, id);
    for (const [k, v] of Object.entries(cols)) fq(`UPDATE orders SET ${k} = ? WHERE orderId = ?`, v, id);
  }
  const fr = await lib.getFundraisingReport(f1, { dateFrom: "2026-10-01", dateTo: "2026-10-31", basis: "placed" });
  ok("the report's orders are the paid one and the accepted Net 30 one", same(fr.orders.map(x => x.orderId).sort(), ["F-ACC", "F-PAID"]));
  ok("…a PO to check, no PO, a PO without Net 30, pay on delivery and paid-for-the-work don't count", !fr.orders.some(x => ["F-TYPED", "F-N30", "F-OFF", "F-POD", "F-PFW"].includes(x.orderId)));
  const club = fr.shops.find(s => s.orgId === "club");
  ok("the shop raised its share of both, and owes it (raised to date counts the accepted PO too)", club.raised === 4 && club.owed === 4 && club.orders === 2);

  console.log("\n=== The money: real payments only ===");
  const m1 = await freshDb();
  await lib.createProduct(m1, "club", { productId: "cap", type: "cap", name: "Example Cap", pricingMode: "flat", flatPrice: 20, visible: true, noDesignNeeded: true, noBlankNeeded: true });
  for (const id of ["M-PAID", "M-ACC"])
    await lib.insertOrder(m1, { orderId: id, orgId: "club", customerName: "Pat Example", contact: "pat@example.com", placedAt: "2026-10-10T15:00:00.000Z" },
      [{ productId: "cap", name: "Example Cap", type: "cap", size: "OSFA", qty: 1, unitPrice: 20 }]);
  await lib.settleOrderBalance(m1, "M-PAID", "Cash", "2026-10-10T16:00:00.000Z");
  const set = await lib.setOrderTerms(m1, "M-ACC", { net30: true, poNumber: "PO-5001", by: "pat@example.com", now: "2026-10-10T16:00:00.000Z" });
  ok("a PO staff type is accepted at once: the order is cleared", set.ok === true && set.cleared === true);
  ok("…its paid flag doesn't move", m1.q("SELECT paid FROM orders WHERE orderId='M-ACC'")[0].paid === 0);
  const rev = await lib.getRevenueData(m1, "2026-10-01T00:00:00.000Z", "2026-10-31T23:59:59.999Z", { basis: "placed" });
  const rr = Object.fromEntries(rev.map(r => [r.orderId, r]));
  ok("the Revenue report's received: the paid order's payment, nothing for the Net 30 one", rr["M-PAID"].received > 0 && rr["M-ACC"].received === 0);
  const io = await lib.getMoneyInOutByMonth(m1, { yearFrom: "2026-01-01", to: "2026-12-31" });
  const inOct = io.months.find(x => x.month === "2026-10");
  ok("Home's money in for the month is the paid order's payment alone", !!inOct && inOct.in.payments > 0 && Math.abs(inOct.in.payments - rr["M-PAID"].received) < 0.001);
})().catch((e) => { console.log("threw " + (e && e.stack || e)); process.exitCode = 1; });
