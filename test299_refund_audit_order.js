const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { adminAs } = require("./testlib/roles.js");

// 💰 Payments → Record refund (orders.js recordRefund) writes its audit entry only once the refund will be recorded:
// the date and the paid-from account are checked first, as addPayment does, so a refund refused for a date in the
// future or an account that's been closed leaves no "payment.refunded" row behind for money that never moved.
// Real SQL (sql.js), real db.js and orders.js, the admin role from testlib/roles.js. Invented data only.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" + adminAs() + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false;\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn { post: onRequestPost, insertOrder, addOrderPayment };")();

let passed = 0, failed = 0;
const ok = (label, cond) => { cond ? passed++ : failed++; console.log(label + ": " + !!cond); };

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const pending = [];
  const call = async (body) => {
    const full = Object.assign({ key: "x" }, body);
    const res = await api.post({ env: { DB: d1 }, waitUntil: (p) => pending.push(Promise.resolve(p).catch(() => {})),
      request: { url: "https://admin.example.com/api/orders", json: async () => full, clone: () => ({ json: async () => full }), headers: { get: () => null } } });
    while (pending.length) await pending.shift();
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const t = new Date().toISOString();
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Example Club','${t}','${t}');`);
  await api.insertOrder(d1, { orderId: "R1", orgId: "acme", customerName: "Pat Example", contact: "pat@example.test", paymentMethod: "Venmo",
    placedAt: t, subtotal: 40, shippingCost: 0, total: 40 }, [{ productId: "", name: "Tee", type: "shirt", size: "L", qty: 2, unitPrice: 20 }]);
  await api.addOrderPayment(d1, "R1", 40, "Paid", "", { method: "venmo" });
  d1._raw.exec("UPDATE accounts SET active = 0 WHERE id = 3");
  const audits = () => d1.q("SELECT COUNT(*) n FROM audit_log WHERE action='payment.refunded' AND orderId='R1'")[0].n;
  const refunds = () => d1.q("SELECT COUNT(*) n FROM order_payments WHERE orderId='R1' AND kind='refund'")[0].n;
  const future = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);

  console.log("=== A refused refund leaves no audit row ===");
  let r = await call({ action: "recordRefund", orderId: "R1", amount: 5, method: "venmo", date: future, requestId: "refund-future-1" });
  ok("a date in the future is refused", r.status === 400 && /future/.test(r.body.message));
  ok("…and nothing is audited or recorded for it", audits() === 0 && refunds() === 0);
  r = await call({ action: "recordRefund", orderId: "R1", amount: 5, method: "venmo", date: "2026-13-45" });
  ok("a date that isn't a date is refused, with no audit row", r.status === 400 && audits() === 0);
  r = await call({ action: "recordRefund", orderId: "R1", amount: 5, method: "venmo", accountId: 3, requestId: "refund-closed-1" });
  ok("an account that's no longer active is refused", r.status === 400 && /active account/.test(r.body.message));
  ok("…and nothing is audited or recorded for it", audits() === 0 && refunds() === 0);
  r = await call({ action: "recordRefund", orderId: "R1", amount: 5, method: "venmo", accountId: 999 });
  ok("an account that doesn't exist is refused, with no audit row", r.status === 400 && audits() === 0);

  console.log("\n=== A refund that's recorded is audited once ===");
  r = await call({ action: "recordRefund", orderId: "R1", amount: 5, method: "venmo", accountId: 1, requestId: "refund-good-1" });
  ok("a refund from an active account with no date is recorded", r.status === 200 && refunds() === 1);
  ok("…and audited once", audits() === 1);
  r = await call({ action: "recordRefund", orderId: "R1", amount: 5, method: "venmo", accountId: 1, requestId: "refund-good-1" });
  ok("the same Save again is a duplicate: no second refund, no second audit row", r.status === 200 && r.body.duplicate === true && refunds() === 1 && audits() === 1);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
