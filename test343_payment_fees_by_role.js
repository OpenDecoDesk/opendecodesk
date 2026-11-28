const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { adminAs, DEFAULT_ROLES, effectivePermissions } = require("./testlib/roles.js");

// Card fees stay out of the payment actions' replies for a role without costs.view (2026-11, review round 2). The
// order lists already leave out each payment's processor fee for such a role (orders.js orderCostsFor_), but adding a
// payment, recording a refund, voiding one, changing its date or account, or setting a refund's shipping part sent the
// order's payments back as they are, Stripe's fee included, and the redrawn Payments table showed it. Every such
// reply now goes through paymentsFor_, the same rule. The built-in Back office role (orders.payments edit, costs.view
// none) against the owner. Real SQL (sql.js), real db.js, orders.js and permissions.js (testlib/roles.js adminAs).
// Invented data only.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const ordersSrc = read("functions/api/orders.js");
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" + adminAs({ roleFrom: "globalThis.__role" }) + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false;\n" +
  dbSrc + "\n" + strip(ordersSrc) + "\nreturn { post: onRequestPost, insertOrder, addOrderPayment };")();

let passed = 0, failed = 0;
const ok = (label, cond) => { cond ? passed++ : failed++; console.log(label + ": " + !!cond); };

(async () => {
  const staff = effectivePermissions(DEFAULT_ROLES.staff);
  ok("(Back office may record payments but has no costs.view)", ["edit", "full"].includes(staff["orders.payments"]) && staff["costs.view"] === "none");
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const pending = [];
  const call = async (role, body) => {
    globalThis.__role = role;
    const full = Object.assign({ key: "x", org: "acme" }, body);
    const res = await api.post({ env: { DB: d1 }, waitUntil: (p) => pending.push(Promise.resolve(p).catch(() => {})),
      request: { url: "https://admin.example.com/api/orders", json: async () => full, clone: () => ({ json: async () => full }), headers: { get: () => null } } });
    while (pending.length) await pending.shift();
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const t = new Date().toISOString();
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Example Club','${t}','${t}');`);
  await api.insertOrder(d1, { orderId: "F-1", orgId: "acme", customerName: "Pat Example", contact: "pat@example.test", paymentMethod: "Card", placedAt: t,
    subtotal: 60, shippingCost: 0, total: 60 }, [{ productId: "", name: "Tee", type: "shirt", size: "L", qty: 3, unitPrice: 20 }]);
  await api.addOrderPayment(d1, "F-1", 40, "Stripe", "pi_f1", { method: "card", feeCents: 146 });
  // No `fee` on any payment, and the payments are all there.
  const noFees = (r) => r.status === 200 && Array.isArray(r.body.payments) && r.body.payments.length > 0 && r.body.payments.every(p => !("fee" in p));

  console.log("=== Back office: no fees in any payment reply ===");
  let r = await call("staff", { action: "addPayment", orderId: "F-1", amount: 5, method: "venmo", requestId: "staff-pay-0001" });
  ok("addPayment on a card-paid order: no fee key on any payment", noFees(r) && r.body.payments.some(p => p.method === "card"));
  r = await call("staff", { action: "addPayment", orderId: "F-1", amount: 5, method: "venmo", requestId: "staff-pay-0001" });
  ok("…nor in its duplicate reply", noFees(r) && r.body.duplicate === true);
  r = await call("staff", { action: "recordRefund", orderId: "F-1", amount: 2, method: "venmo", requestId: "staff-ref-0001" });
  ok("recordRefund", noFees(r));
  const refundId = r.body.payments.find(p => p.kind === "refund").id;
  r = await call("staff", { action: "recordRefund", orderId: "F-1", amount: 2, method: "venmo", requestId: "staff-ref-0001" });
  ok("…nor in its duplicate reply", noFees(r) && r.body.duplicate === true);
  r = await call("staff", { action: "setRefundShipping", paymentId: refundId, shippingAmount: 1 });
  ok("setRefundShipping", noFees(r));
  const venmoId = d1.q("SELECT id FROM order_payments WHERE orderId='F-1' AND method='venmo' AND kind='payment'")[0].id;
  r = await call("staff", { action: "setPaymentDate", paymentId: venmoId, date: t.slice(0, 10) });
  ok("setPaymentDate", noFees(r));
  r = await call("staff", { action: "voidPayment", paymentId: refundId, reason: "Entered by mistake" });
  ok("voidPayment", noFees(r));

  console.log("\n=== The owner still sees them ===");
  r = await call("admin", { action: "addPayment", orderId: "F-1", amount: 1, method: "cash", requestId: "owner-pay-0001" });
  ok("addPayment: the card payment's fee is there", r.status === 200 && r.body.payments.find(p => p.method === "card").fee === 1.46);
  r = await call("admin", { action: "recordRefund", orderId: "F-1", amount: 1, method: "cash", requestId: "owner-ref-0001" });
  ok("recordRefund: the same", r.status === 200 && r.body.payments.find(p => p.method === "card").fee === 1.46);

  console.log("\n=== Every payments reply goes through the filter ===");
  const raw = ordersSrc.match(/payments: (updated|same|existing|order|o)(\s*\?\s*\1)?\.payments\b/g) || [];
  // The one left is the void-order audit snapshot (not a reply), kept whole for the audit log.
  ok("no reply sends an order's payments unfiltered", raw.length === 1 && /items: existing\.items, payments: existing\.payments \};\n\s*const auditErr = await auditStrict\(\{ orgId, orderId, action: "order\.voided"/.test(ordersSrc));
  ok("paymentsFor_ drops the fee unless the role has costs.view, as orderCostsFor_ does", /const paymentsFor_ = \(payments\) => !Array\.isArray\(payments\) \|\| seesPricing_\(\) \? payments : payments\.map\(\(\{ fee, \.\.\.p \}\) => p\);/.test(ordersSrc) &&
    /rest\.payments = paymentsFor_\(o\.payments\);/.test(ordersSrc));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch(e => { console.error(e); console.log("test343 crashed: " + false); process.exit(1); });
