const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { adminAs } = require("./testlib/roles.js");

// The balance due counts the money given back for cancelled lines (2026-11, review round 2). An order paid $100 in
// full, with a $40 line cancelled and refunded and a $40 replacement added, used to read Paid with $0 due, so card
// checkout refused it and the replacement was never charged. What counts as received is now the payments less the
// refunds and lost disputes, but never more than the cancelled lines' refund credit (each cancelled line's
// refundCents, at most its total with its tax when tax is added on top), so a goodwill refund, or one on a line still
// on the order, never puts a balance back. One rule in SQL (db.js balanceReceivedSql_, used by paidRefreshSql_,
// refreshPaidStatus, getOrderCheckoutState and getCustomer) and its JS twin (balanceReceivedCents_, parseOrder_).
// Migration 0114 re-works the stored flags with the same statement. Real SQL (sql.js), real db.js and orders.js, the
// admin role from testlib/roles.js. Invented data only.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + "\nreturn { insertOrder, getOrderById, addOrderPayment, refreshPaidStatus, paidRefreshSql_, getOrderCheckoutState, addOrderItem, " +
  "recalcOrderTotals, getCustomer, settleOrderBalanceOnce, setLineItemRefund, cancelLineItemWithReason };")();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" + adminAs() + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false;\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn { post: onRequestPost };")();

let passed = 0, failed = 0;
const ok = (label, cond) => { cond ? passed++ : failed++; console.log(label + ": " + !!cond); };

async function migratedDb() {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  return d1;
}

(async () => {
  const d1 = await migratedDb();
  const pending = [];
  const call = async (body) => {
    const full = Object.assign({ key: "x", org: "acme" }, body);
    const res = await api.post({ env: { DB: d1 }, waitUntil: (p) => pending.push(Promise.resolve(p).catch(() => {})),
      request: { url: "https://admin.example.com/api/orders", json: async () => full, clone: () => ({ json: async () => full }), headers: { get: () => null } } });
    while (pending.length) await pending.shift();
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const t = "2026-11-02T10:00:00.000Z";
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Example Club','${t}','${t}');`);
  d1._raw.exec(`INSERT INTO customers (id, name, email, createdAt, updatedAt) VALUES (1, 'Pat Example', 'pat@example.test', '${t}', '${t}');`);
  const mk = (orderId, lines, extra = {}) => lib.insertOrder(d1, Object.assign({ orderId, orgId: "acme", customerName: "Pat Example", contact: "pat@example.test",
    paymentMethod: "Venmo", placedAt: t, subtotal: 0, shippingCost: 0, total: 0 }, extra), lines.map(([name, unitPrice]) => ({ productId: "", name, type: "shirt", size: "L", qty: 1, unitPrice })));
  const lineOf = (orderId, name) => d1.q("SELECT id FROM order_items WHERE orderId=? AND name=?", orderId, name)[0].id;
  const flag = (id) => d1.q("SELECT paid, paidForWork FROM orders WHERE orderId=?", id)[0];
  const replace = async (orderId, name, price) => { await lib.addOrderItem(d1, orderId, "acme", { name, type: "shirt", size: "L", qty: 1, unitPrice: price }); await lib.recalcOrderTotals(d1, orderId); };

  console.log("=== $100 paid, a $40 line cancelled and refunded, a $40 replacement added ===");
  await mk("B-1", [["Tee", 60], ["Hoodie", 40]]);
  d1._raw.run("UPDATE orders SET customerId = 1 WHERE orderId = 'B-1'");
  await call({ action: "addPayment", orderId: "B-1", amount: 100, method: "venmo" });
  ok("(paid in full)", flag("B-1").paid === 1);
  await call({ action: "cancelLineItem", sheetRow: lineOf("B-1", "Hoodie"), reason: "Out of stock" });
  let r = await call({ action: "setLineItemRefund", sheetRow: lineOf("B-1", "Hoodie"), refundAmount: 40, method: "venmo" });
  let o = await lib.getOrderById(d1, "B-1");
  ok("after the refund: $60 owed, $60 kept, nothing due, still paid", r.status === 200 && o.effectiveTotal === 60 && o.netReceived === 60 && o.balanceDue === 0 && flag("B-1").paid === 1);
  await replace("B-1", "Hoodie (other color)", 40);
  o = await lib.getOrderById(d1, "B-1");
  ok("with the replacement added, $40 is due (the order shows it)", o.effectiveTotal === 100 && o.amountReceived === 100 && o.refundedAmount === 40 && o.balanceDue === 40);
  ok("…the order is no longer marked paid", flag("B-1").paid === 0 && o.paid === false);
  const st = await lib.getOrderCheckoutState(d1, "B-1");
  ok("…card checkout charges the $40 (not 'already paid')", st.total === 40 && st.paid === false);
  ok("…checkout.js charges what getOrderCheckoutState says is due", /const state = await getOrderCheckoutState\(env\.DB, String\(orderId\)\);/.test(read("functions/api/checkout.js")));
  const cust = await lib.getCustomer(d1, 1);
  const co = cust.orders.find(x => x.orderId === "B-1");
  ok("…the customer's page shows $40 due on it and in the total", co.balanceDue === 40 && co.paidAmount === 100 && cust.totals.balanceDue === 40);
  const rp = await lib.refreshPaidStatus(d1, "B-1");
  ok("refreshPaidStatus: received for the balance $60, the payments alone $100 (what expectReceivedCents compares)", rp.receivedCents === 6000 && rp.paymentsCents === 10000 && rp.owedCents === 10000);
  const settled = await lib.settleOrderBalanceOnce(d1, "B-1", "Marked paid");
  o = await lib.getOrderById(d1, "B-1");
  ok("Mark as paid books the $40, and the order is paid with nothing due", settled.recorded === 40 && settled.tookRow && o.balanceDue === 0 && flag("B-1").paid === 1 && o.amountReceived === 140);

  console.log("\n=== A goodwill refund never reopens a balance ===");
  await mk("G-1", [["Tee", 60], ["Hoodie", 40]]);
  await call({ action: "addPayment", orderId: "G-1", amount: 100, method: "venmo" });
  r = await call({ action: "recordRefund", orderId: "G-1", amount: 10, method: "venmo", requestId: "goodwill-1" });
  o = await lib.getOrderById(d1, "G-1");
  ok("$10 back with nothing cancelled: still $0 due and paid", r.status === 200 && o.balanceDue === 0 && o.netReceived === 90 && flag("G-1").paid === 1 && (await lib.getOrderCheckoutState(d1, "G-1")).total === 0);
  await mk("G-2", [["Tee", 60], ["Hoodie", 40]]);
  await call({ action: "addPayment", orderId: "G-2", amount: 100, method: "venmo" });
  await call({ action: "setLineItemRefund", sheetRow: lineOf("G-2", "Hoodie"), refundAmount: 15, method: "cash" });
  o = await lib.getOrderById(d1, "G-2");
  ok("a refund on a line still on the order: still $0 due and paid", o.refundedAmount === 15 && o.balanceDue === 0 && flag("G-2").paid === 1);

  console.log("\n=== Only up to the cancelled lines' refund credit ===");
  await mk("C-1", [["Tee", 60], ["Hoodie", 40]]);
  await call({ action: "addPayment", orderId: "C-1", amount: 100, method: "venmo" });
  await call({ action: "cancelLineItem", sheetRow: lineOf("C-1", "Hoodie"), reason: "Out of stock" });
  await call({ action: "setLineItemRefund", sheetRow: lineOf("C-1", "Hoodie"), refundAmount: 40, method: "venmo" });
  await call({ action: "recordRefund", orderId: "C-1", amount: 10, method: "venmo", requestId: "goodwill-2" });
  await replace("C-1", "Hoodie (other color)", 40);
  o = await lib.getOrderById(d1, "C-1");
  ok("$40 for the cancelled line + $10 goodwill, then $40 added: $40 due, not $50", o.refundedAmount === 50 && o.balanceDue === 40);
  await mk("C-2", [["Tee", 60], ["Hoodie", 40]]);
  await call({ action: "addPayment", orderId: "C-2", amount: 100, method: "venmo" });
  await call({ action: "cancelLineItem", sheetRow: lineOf("C-2", "Hoodie"), reason: "Out of stock" });
  await lib.setLineItemRefund(d1, lineOf("C-2", "Hoodie"), 55);   // more than the line (shipping too), as typed on the line
  await call({ action: "recordRefund", orderId: "C-2", amount: 55, method: "venmo", requestId: "line-plus-shipping" });
  await replace("C-2", "Hoodie (other color)", 40);
  o = await lib.getOrderById(d1, "C-2");
  ok("a line's refund counts for no more than the line itself ($40 of a $55 refund)", o.balanceDue === 40 && (await lib.getOrderCheckoutState(d1, "C-2")).total === 40);

  console.log("\n=== A card refund counts once its webhook row is in ===");
  await mk("K-1", [["Tee", 60], ["Hoodie", 40]], { paymentMethod: "Card" });
  await lib.addOrderPayment(d1, "K-1", 100, "Stripe", "pi_k1", { method: "card" });
  await call({ action: "cancelLineItem", sheetRow: lineOf("K-1", "Hoodie"), reason: "Out of stock" });
  await call({ action: "setLineItemRefund", sheetRow: lineOf("K-1", "Hoodie"), refundAmount: 40, method: "card" });
  await replace("K-1", "Hoodie (other color)", 40);
  o = await lib.getOrderById(d1, "K-1");
  ok("noted on the line, Stripe's refund not in yet: nothing due (the $100 is all still held)", o.balanceDue === 0 && flag("K-1").paid === 1);
  await lib.addOrderPayment(d1, "K-1", -40, "Stripe refund", "re_k1", { method: "card", kind: "refund" });
  o = await lib.getOrderById(d1, "K-1");
  ok("the webhook's refund row in: $40 due, and the flag follows in the same batch", o.balanceDue === 40 && flag("K-1").paid === 0);

  console.log("\n=== Tax added on top: the line's credit includes its tax ===");
  await mk("X-1", [["Tee", 60], ["Hoodie", 40]]);
  d1._raw.run("UPDATE orders SET taxMode='exclusive' WHERE orderId='X-1'");
  d1._raw.run("UPDATE order_items SET taxCents = lineTotalCents / 10 WHERE orderId='X-1'");
  await lib.refreshPaidStatus(d1, "X-1");
  await call({ action: "addPayment", orderId: "X-1", amount: 110, method: "venmo" });
  ok("(paid $110 with the 10% on top)", flag("X-1").paid === 1);
  await call({ action: "cancelLineItem", sheetRow: lineOf("X-1", "Hoodie"), reason: "Out of stock" });
  await call({ action: "setLineItemRefund", sheetRow: lineOf("X-1", "Hoodie"), refundAmount: 44, method: "venmo" });
  o = await lib.getOrderById(d1, "X-1");
  ok("$44 back for the $40 line and its $4 tax: nothing due", o.balanceDue === 0 && flag("X-1").paid === 1);
  await lib.addOrderItem(d1, "X-1", "acme", { name: "Cap", type: "cap", size: "", qty: 1, unitPrice: 40 });
  await lib.recalcOrderTotals(d1, "X-1");
  d1._raw.run("UPDATE order_items SET taxCents = lineTotalCents / 10 WHERE orderId='X-1'");   // (the test's own 10%, as set above)
  await lib.refreshPaidStatus(d1, "X-1");
  o = await lib.getOrderById(d1, "X-1");
  ok("a $40 + $4 tax replacement: $44 due, the same in the order, checkout and the flag", o.balanceDue === 44 && (await lib.getOrderCheckoutState(d1, "X-1")).total === 44 && flag("X-1").paid === 0);

  console.log("\n=== The SQL and the JS agree, order by order ===");
  let seed = 4242; const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  let mismatches = 0, cases = 0, sawDue = 0, sawCredit = 0;
  for (let i = 0; i < 120; i++) {
    const id = "Q-" + i;
    await mk(id, Array.from({ length: 1 + rnd(3) }, (_, k) => ["L" + k, [5, 12.5, 20, 40][rnd(4)]]), { shippingCost: [0, 0, 4.5][rnd(3)] });
    if (rnd(3) === 0) { d1._raw.run("UPDATE orders SET taxMode='exclusive' WHERE orderId=?", [id]); d1._raw.run("UPDATE order_items SET taxCents = ? WHERE orderId=?", [[0, 60, 125][rnd(3)], id]); }
    if (rnd(4) === 0) d1._raw.run("UPDATE orders SET discountCents=? WHERE orderId=?", [[100, 500][rnd(2)], id]);
    const owed = (await lib.refreshPaidStatus(d1, id)).owedCents;
    const pay = owed - [0, 0, 1, 300][rnd(4)];
    if (pay > 0) d1._raw.run("INSERT INTO order_payments (orderId, amountCents, receivedAt, note, kind) VALUES (?, ?, ?, 'x', 'payment')", [id, pay, t]);
    for (let p = 0, n = rnd(3); p < n; p++)
      d1._raw.run("INSERT INTO order_payments (orderId, amountCents, receivedAt, note, kind, voidedAt) VALUES (?, ?, ?, 'x', ?, ?)", [id, -[100, 500, 2000, 4500][rnd(4)], t, rnd(4) === 0 ? "dispute" : "refund", rnd(6) === 0 ? t : null]);
    for (const it of d1.q("SELECT id FROM order_items WHERE orderId=?", id)) {
      if (rnd(3) === 0) d1._raw.run("UPDATE order_items SET cancelDate=? WHERE id=?", [t, it.id]);
      if (rnd(2) === 0) d1._raw.run("UPDATE order_items SET refundCents=? WHERE id=?", [[300, 1250, 2000, 6000][rnd(4)], it.id]);
    }
    if (rnd(3) === 0) await lib.addOrderItem(d1, id, "acme", { name: "Added", type: "shirt", size: "L", qty: 1, unitPrice: [10, 40][rnd(2)] });
    d1._raw.run("UPDATE orders SET paid=?, paidAt=NULL WHERE orderId=?", [rnd(2), id]);
    await d1.prepare(lib.paidRefreshSql_("taxMode")).bind("NOW", id).run();
    const viaSql = flag(id);
    const js = await lib.refreshPaidStatus(d1, id);
    const ord = await lib.getOrderById(d1, id), chk = await lib.getOrderCheckoutState(d1, id);
    const dueJs = Math.round(ord.balanceDue * 100), dueSql = Math.round(chk.total * 100), dueState = Math.max(0, js.owedCents - js.receivedCents);
    cases++;
    const sameFlag = js.owedCents === 0 || Number(viaSql.paid) === (dueState === 0 ? 1 : 0);
    if (dueJs !== dueSql || dueSql !== dueState || !sameFlag) { mismatches++; if (mismatches < 4) console.log("  mismatch", id, dueJs, dueSql, dueState, JSON.stringify(viaSql)); }
    if (dueJs > 0) sawDue++;
    if (ord.items.some(x => x.cancelDate && x.refundAmount > 0) && ord.refundedAmount > 0) sawCredit++;
  }
  ok(`parseOrder_'s balance, the checkout amount, refreshPaidStatus and the one-statement flag agree in all ${cases} cases`, mismatches === 0 && sawDue > 10 && sawCredit > 10);

  console.log("\n=== Migration 0114 re-works the stored flags with the same statement ===");
  const mig = read("migrations/0114_line_refund_balance.sql");
  const stmt = mig.split("\n").filter(l => !/^--/.test(l)).join("\n").trim();
  const parts = lib.paidRefreshSql_("taxMode").split("?");
  ok("its UPDATE is paidRefreshSql_'s, for the orders with a cancelled, refunded line", stmt === parts[0] + "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')" +
    parts[1].replace(/WHERE orderId = $/, "WHERE orderId IN (SELECT orderId FROM order_items WHERE cancelDate IS NOT NULL AND refundCents > 0)") + ";");
  ok("it changes no table (schema.sql needs nothing)", !/\b(CREATE|ALTER|DROP)\b/i.test(stmt));
  // Orders as an older version left them: B-1's flag as the old rule had it, and two that never had a cancelled refund.
  const d2 = await migratedDb();
  d2._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Example Club','${t}','${t}');`);
  const mk2 = (orderId, lines) => lib.insertOrder(d2, { orderId, orgId: "acme", customerName: "Pat Example", contact: "pat@example.test", paymentMethod: "Venmo", placedAt: t,
    subtotal: 0, shippingCost: 0, total: 0 }, lines.map(([name, unitPrice]) => ({ productId: "", name, type: "shirt", size: "L", qty: 1, unitPrice })));
  await mk2("M-1", [["Tee", 60], ["Hoodie", 40], ["Hoodie 2", 40]]);
  await mk2("M-2", [["Tee", 60], ["Hoodie", 40]]);
  await mk2("M-3", [["Tee", 60]]);
  d2._raw.exec(`INSERT INTO order_payments (orderId, amountCents, receivedAt, note, kind) VALUES ('M-1', 10000, '${t}', 'x', 'payment'), ('M-1', -4000, '${t}', 'x', 'refund'),
    ('M-2', 10000, '${t}', 'x', 'payment'), ('M-2', -1000, '${t}', 'x', 'refund'), ('M-3', 3000, '${t}', 'x', 'payment');
    UPDATE order_items SET cancelDate='${t}', refundCents=4000 WHERE orderId='M-1' AND name='Hoodie';
    UPDATE order_items SET refundCents=1000 WHERE orderId='M-2' AND name='Hoodie';
    UPDATE orders SET paid=1, paidForWork=1, paidAt='${t}' WHERE orderId IN ('M-1', 'M-2');
    UPDATE orders SET paid=1, paidForWork=1, paidAt='${t}' WHERE orderId='M-3';`);
  d2.execFile(mig);
  const f2 = (id) => d2.q("SELECT paid, paidForWork, paidAt FROM orders WHERE orderId=?", id)[0];
  ok("an order paid in full, a line cancelled and refunded, one added since: unpaid after the migration", f2("M-1").paid === 0 && f2("M-1").paidForWork === 0 && f2("M-1").paidAt === null);
  ok("a refund on a line still on the order: left paid", f2("M-2").paid === 1 && f2("M-2").paidAt === t);
  ok("an order with no cancelled, refunded line isn't touched (even one whose flag is off)", f2("M-3").paid === 1);
  d2.execFile(mig);
  ok("running it again changes nothing", f2("M-1").paid === 0 && f2("M-2").paid === 1);
  ok("it's in the list the Worker ships", read("functions/_lib/migrationList.js").includes('"0114_line_refund_balance.sql"'));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch(e => { console.error(e); console.log("test341 crashed: " + false); process.exit(1); });
