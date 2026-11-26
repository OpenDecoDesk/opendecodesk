const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { adminAs } = require("./testlib/roles.js");

// Two refunds saved at once can't both take the same money (2026-11, review round 2). Record refund, a line's
// Record refund and Edit items each checked the money the order still holds (Net kept) and THEN inserted the refund,
// so two admins (or two tabs, each with its own request key) refunding at the same moment both passed the check and
// the order was refunded more than it ever took in. The ceiling is now part of the insert itself (db.js
// addOrderPayment's withinKept): the refund row goes in only while the order's live rows add up to at least the
// refund. The one refused answers 409 "Another refund was recorded first; reload the order to see it.", told apart
// from a repeat of the same Save, and is never audited. The requests here really run at the same time (Promise.all
// against the test database). Real SQL (sql.js), real db.js and orders.js, the admin role from testlib/roles.js.
// Invented data only.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const ordersSrc = read("functions/api/orders.js");
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" + adminAs() + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false;\n" +
  dbSrc + "\n" + strip(ordersSrc) + "\nreturn { post: onRequestPost, insertOrder, addOrderPayment, getOrderById, cancelLineItemWithReason };")();

let passed = 0, failed = 0;
const ok = (label, cond) => { cond ? passed++ : failed++; console.log(label + ": " + !!cond); };
const TAKEN = "Another refund was recorded first; reload the order to see it.";

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const pending = [];
  const call = async (body) => {
    const full = Object.assign({ key: "x", org: "acme" }, body);
    const res = await api.post({ env: { DB: d1 }, waitUntil: (p) => pending.push(Promise.resolve(p).catch(() => {})),
      request: { url: "https://admin.example.com/api/orders", json: async () => full, clone: () => ({ json: async () => full }), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const both = async (a, b) => { const out = await Promise.all([call(a), call(b)]); while (pending.length) await pending.shift(); return out; };
  const t = new Date().toISOString();
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Example Club','${t}','${t}');`);
  const mk = async (orderId) => {
    await api.insertOrder(d1, { orderId, orgId: "acme", customerName: "Pat Example", contact: "pat@example.test", paymentMethod: "Venmo", placedAt: t,
      subtotal: 100, shippingCost: 0, total: 100 }, [{ productId: "", name: "Tee", type: "shirt", size: "L", qty: 1, unitPrice: 50 }, { productId: "", name: "Cap", type: "cap", size: "", qty: 1, unitPrice: 50 }]);
    await api.addOrderPayment(d1, orderId, 100, "Paid", "", { method: "venmo" });
  };
  const refunds = (id) => d1.q("SELECT amountCents, requestKey FROM order_payments WHERE orderId=? AND kind='refund' AND voidedAt IS NULL", id);
  const kept = (id) => d1.q("SELECT COALESCE(SUM(amountCents), 0) n FROM order_payments WHERE orderId=? AND voidedAt IS NULL", id)[0].n;
  const audits = (id) => d1.q("SELECT COUNT(*) n FROM audit_log WHERE action='payment.refunded' AND orderId=?", id)[0].n;
  const lineOf = (orderId, name) => d1.q("SELECT id FROM order_items WHERE orderId=? AND name=?", orderId, name)[0].id;
  const oneEach = (rs) => rs.filter(r => r.status === 200 && r.body.status === "ok").length === 1 && rs.filter(r => r.status === 409 && r.body.message === TAKEN).length === 1;

  console.log("=== Record refund, twice at the same moment ===");
  await mk("R-1");
  let rs = await both({ action: "recordRefund", orderId: "R-1", amount: 100, method: "venmo", requestId: "tab-one-0001" },
    { action: "recordRefund", orderId: "R-1", amount: 100, method: "venmo", requestId: "tab-two-0002" });
  ok("two Saves (two tabs) each refunding the $100: one is recorded, the other refused with 409", oneEach(rs));
  ok("…one refund row, and the order never holds less than nothing", refunds("R-1").length === 1 && kept("R-1") === 0);
  ok("…audited once, for the refund that went in", audits("R-1") === 1);
  await mk("R-2");
  rs = await both({ action: "recordRefund", orderId: "R-2", amount: 60, method: "venmo", requestId: "tab-one-0003" },
    { action: "recordRefund", orderId: "R-2", amount: 60, method: "cash", requestId: "tab-two-0004" });
  ok("$60 and $60 out of $100: one goes in, the other is refused", oneEach(rs) && refunds("R-2").length === 1 && kept("R-2") === 4000);
  await mk("R-3");
  rs = await both({ action: "recordRefund", orderId: "R-3", amount: 40, method: "venmo", requestId: "tab-one-0005" },
    { action: "recordRefund", orderId: "R-3", amount: 60, method: "venmo", requestId: "tab-two-0006" });
  ok("$40 and $60 out of $100: both fit, both go in", rs.every(r => r.status === 200 && !r.body.duplicate) && refunds("R-3").length === 2 && kept("R-3") === 0 && audits("R-3") === 2);
  await mk("R-4");
  rs = await both({ action: "recordRefund", orderId: "R-4", amount: 100, method: "venmo", requestId: "same-save-0007" },
    { action: "recordRefund", orderId: "R-4", amount: 100, method: "venmo", requestId: "same-save-0007" });
  ok("the same Save sent twice at once (a double click): one refund, the other is its duplicate, not a 409",
    rs.every(r => r.status === 200) && rs.filter(r => r.body.duplicate === true).length === 1 && refunds("R-4").length === 1 && audits("R-4") === 1);
  const r5 = await call({ action: "recordRefund", orderId: "R-4", amount: 5, method: "venmo", requestId: "later-save-0008" });
  ok("a later refund once the money is all given back is refused before anything is written (400, as before)", r5.status === 400 && /can't exceed/.test(r5.body.message) && refunds("R-4").length === 1);

  console.log("\n=== A cancelled line's Record refund, and both kinds together ===");
  await mk("L-1");
  await api.cancelLineItemWithReason(d1, lineOf("L-1", "Tee"), "Out of stock");
  await api.cancelLineItemWithReason(d1, lineOf("L-1", "Cap"), "Out of stock");
  rs = await both({ action: "setLineItemRefund", sheetRow: lineOf("L-1", "Tee"), refundAmount: 60, method: "venmo" },
    { action: "setLineItemRefund", sheetRow: lineOf("L-1", "Cap"), refundAmount: 60, method: "cash" });
  ok("two lines' refunds of $60 each out of $100 at once: one is recorded, the other refused with 409", oneEach(rs) && refunds("L-1").length === 1 && kept("L-1") === 4000);
  const lineRows = d1.q("SELECT refundCents FROM order_items WHERE orderId='L-1' ORDER BY id").map(r => r.refundCents);
  ok("…and only that line is marked refunded", lineRows.filter(c => c === 6000).length === 1 && lineRows.filter(c => c == null).length === 1);
  ok("…audited once", audits("L-1") === 1);
  await mk("L-2");
  await api.cancelLineItemWithReason(d1, lineOf("L-2", "Cap"), "Out of stock");
  rs = await both({ action: "setLineItemRefund", sheetRow: lineOf("L-2", "Cap"), refundAmount: 70, method: "venmo" },
    { action: "recordRefund", orderId: "L-2", amount: 70, method: "venmo", requestId: "tab-two-0009" });
  ok("a line's refund and a Record refund at once: one goes in, the other is refused", oneEach(rs) && refunds("L-2").length === 1 && kept("L-2") === 3000);

  console.log("\n=== Edit items, taking a line off with a refund ===");
  await mk("E-1");
  rs = await both({ action: "editOrder", orderId: "E-1", removals: [{ itemId: lineOf("E-1", "Cap"), reason: "Changed mind", refundAmount: 70, refundMethod: "cash" }] },
    { action: "recordRefund", orderId: "E-1", amount: 70, method: "venmo", requestId: "tab-two-0010" });
  ok("an edit's refund and a Record refund at once: one goes in, the other is refused with 409 (not a crash)", oneEach(rs) && refunds("E-1").length === 1 && kept("E-1") === 3000);
  ok("…here the edit is the one refused, and says so itself", rs[0].status === 409 && rs[0].body.message === TAKEN &&
    d1.q("SELECT COUNT(*) n FROM audit_log WHERE action='order.edited' AND orderId='E-1' AND detail LIKE '%incomplete%'")[0].n === 1);

  console.log("\n=== In the insert itself ===");
  await mk("D-1");
  let id = await api.addOrderPayment(d1, "D-1", -101, "Refund", "", { method: "venmo", kind: "refund", withinKept: true });
  ok("addOrderPayment with withinKept inserts nothing past what the order holds", id === 0 && refunds("D-1").length === 0);
  id = await api.addOrderPayment(d1, "D-1", -100, "Refund", "", { method: "venmo", kind: "refund", withinKept: true });
  ok("…and up to it, it does", id > 0 && kept("D-1") === 0);
  id = await api.addOrderPayment(d1, "D-1", -30, "Stripe refund", "re_d1", { method: "card", kind: "refund" });
  ok("a refund Stripe already made (the webhook, no withinKept) is still recorded", id > 0);
  const rec = ordersSrc.slice(ordersSrc.indexOf('if (body.action === "recordRefund")'), ordersSrc.indexOf('if (body.action === "setRefundShipping")'));
  const line = ordersSrc.slice(ordersSrc.indexOf("const recordLineRefund_ ="), ordersSrc.indexOf("const refundTaken_ ="));
  ok("Record refund and the line's refund insert with withinKept, and audit only after the insert", [rec, line].every(s => /withinKept: true/.test(s) &&
    s.indexOf("addOrderPayment(") > 0 && s.indexOf('action: "payment.refunded"') > s.indexOf("addOrderPayment(") && !/auditStrict\(/.test(s)));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch(e => { console.error(e); console.log("test342 crashed: " + false); process.exit(1); });
