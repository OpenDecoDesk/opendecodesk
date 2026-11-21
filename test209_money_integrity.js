const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// Payments, refunds and money integrity — real SQL (sql.js), real db.js, real orders.js admin API.
//   • the Stripe card page open for an order (migrations/0210): read, reused, closed; voiding closes it
// (Stripe itself is a fake fetch below; test19 covers checkout.js and the webhook with mocks.)

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { insertOrder, getOrderById, addShippingPayment, addOrderPayment, saveCheckoutSession, getCheckoutSession, checkoutSessionState, expireCheckoutSession };`)();
const emailMocks = "const sendOrderReceivedEmail = async () => false, sendOrderNotificationEmail = async () => false, sendPaymentConfirmedEmail = async () => { globalThis.__confirmEmails = (globalThis.__confirmEmails || 0) + 1; return false; }, sendCancellationEmail = async () => { globalThis.__cancelEmails = (globalThis.__cancelEmails || 0) + 1; return false; }, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false;\n";
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: { club: 'club' }, orgs: {} });\n" +
  emailMocks + dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
const hookStubs = "const sendStripePaymentNotification = async () => true, sendRefundNotification = async () => true, sendPaymentProblemNotification = async () => true, " +
  "sendDisputeNotification = async (env, orderId, orgId, status) => { (globalThis.__disputeNotices = globalThis.__disputeNotices || []).push(orderId + ':' + status); return true; }; const deliverOrderDownloads = undefined;\n";
const webhook = new Function(strip(read("functions/_lib/http.js")) + "\n" + hookStubs + dbSrc + "\n" + strip(read("functions/api/stripe-webhook.js")) + "\nreturn onRequestPost;")();
const crypto = require("crypto");
const WHSEC = "whsec_t";
const signed = (ev) => { const body = JSON.stringify(ev), t = Math.floor(Date.now() / 1000);
  return { text: async () => body, headers: { get: (h) => h === "stripe-signature" ? `t=${t},v1=${crypto.createHmac("sha256", WHSEC).update(t + "." + body).digest("hex")}` : null } }; };

let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

// A fake Stripe: Checkout Sessions by id, with the calls made to it.
const stripe = { sessions: {}, refunds: {}, calls: [], down: false };
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (!u.includes("api.stripe.com")) return realFetch(url, opts);
  stripe.calls.push((opts.method || "GET") + " " + u.replace("https://api.stripe.com/v1/", ""));
  if (stripe.down) throw new Error("timeout");
  const rm = u.match(/refunds\?limit=100&charge=([^&]+)/);
  if (rm) return { ok: true, json: async () => ({ data: stripe.refunds[decodeURIComponent(rm[1])] || [] }) };
  const m =u.match(/checkout\/sessions\/([^/?]+)(\/expire)?$/);
  const s = m && stripe.sessions[decodeURIComponent(m[1])];
  if (!s) return { ok: false, status: 404, json: async () => ({ error: { code: "resource_missing" } }) };
  if (m[2]) {
    if (s.status !== "open") return { ok: false, status: 400, json: async () => ({ error: { message: "Only open sessions can be expired." } }) };
    s.status = "expired";
  }
  return { ok: true, json: async () => ({ ...s }) };
};

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("schema.sql"));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('club','club','Club','t','t',1);`);
  const mk = (orderId, price = 20, extra = {}) => lib.insertOrder(d1, Object.assign({ orderId, orgId: "club", customerName: "Pat Example", contact: "pat@example.com",
    paymentMethod: "Venmo", placedAt: new Date().toISOString(), subtotal: price, shippingCost: 0, total: price }, extra),
    [{ productId: "", name: "Tee", type: "shirt", size: "L", qty: 1, unitPrice: price }]);
  const env = { DB: d1, STRIPE_SECRET_KEY: "sk_test_x" };
  const call = async (body) => {
    const res = await api({ env, waitUntil: (p) => p.then(() => {}, () => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x", org: "club" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const inHour = () => new Date(Date.now() + 3600e3).toISOString();

  console.log("=== The card page open for an order (migrations/0210) ===");
  await mk("CS-1");
  ok("no page yet → none (and Stripe isn't asked)", (await lib.checkoutSessionState(env, "CS-1")).state === "none" && stripe.calls.length === 0);
  stripe.sessions.cs_a = { id: "cs_a", status: "open", url: "https://checkout.stripe.com/a", amount_total: 2000, success_url: "https://club.example.com/ok" };
  await lib.saveCheckoutSession(d1, "CS-1", "cs_a", 2000, inHour());
  let st = await lib.checkoutSessionState(env, "CS-1");
  ok("an open page is read back with its link, amount and return page", st.state === "open" && st.url === "https://checkout.stripe.com/a" && st.amountCents === 2000 && st.successUrl === "https://club.example.com/ok");
  stripe.sessions.cs_b = { id: "cs_b", status: "open", url: "https://checkout.stripe.com/b", amount_total: 2500 };
  await lib.saveCheckoutSession(d1, "CS-1", "cs_b", 2500, inHour());
  ok("saving a newer page replaces the one remembered (one row per order)", (await lib.getCheckoutSession(d1, "CS-1")).sessionId === "cs_b" && d1.q("SELECT count(*) n FROM checkout_sessions WHERE orderId='CS-1'")[0].n === 1);
  ok("closing it expires it at Stripe", await lib.expireCheckoutSession(env, "CS-1") === "closed" && stripe.sessions.cs_b.status === "expired" && stripe.calls.includes("POST checkout/sessions/cs_b/expire"));
  ok("…after which it reads as closed", (await lib.checkoutSessionState(env, "CS-1")).state === "closed");
  ok("closing an already-closed page is fine", await lib.expireCheckoutSession(env, "CS-1") === "closed");
  stripe.sessions.cs_c = { id: "cs_c", status: "complete", amount_total: 2500 };
  await lib.saveCheckoutSession(d1, "CS-1", "cs_c", 2500, inHour());
  ok("a page already paid reads as paid, and can't be closed", (await lib.checkoutSessionState(env, "CS-1")).state === "paid" && await lib.expireCheckoutSession(env, "CS-1") === "paid");
  stripe.down = true; const n0 = stripe.calls.length;
  ok("Stripe unreachable → unknown (never guessed as closed)", (await lib.checkoutSessionState(env, "CS-1")).state === "unknown" && await lib.expireCheckoutSession(env, "CS-1") === "unknown" && stripe.calls.length > n0);
  stripe.down = false;
  await lib.saveCheckoutSession(d1, "CS-1", "cs_c", 2500, new Date(Date.now() - 1000).toISOString());
  const n1 = stripe.calls.length;
  ok("a page past its closing time counts as none, without asking Stripe", (await lib.checkoutSessionState(env, "CS-1")).state === "none" && stripe.calls.length === n1);

  console.log("\n=== Voiding an order closes its card page ===");
  await mk("CS-2");
  stripe.sessions.cs_v = { id: "cs_v", status: "open", url: "https://checkout.stripe.com/v", amount_total: 2000 };
  await lib.saveCheckoutSession(d1, "CS-2", "cs_v", 2000, inHour());
  let r = await call({ action: "voidOrder", orderId: "CS-2", reason: "Duplicate" });
  ok("the void goes through and the open page is expired, so a cancelled order can't be paid", r.status === 200 && stripe.sessions.cs_v.status === "expired" && !!(await lib.getOrderById(d1, "CS-2")).voidedAt);
  await mk("CS-3");
  stripe.sessions.cs_p = { id: "cs_p", status: "complete", amount_total: 2000 };
  await lib.saveCheckoutSession(d1, "CS-3", "cs_p", 2000, inHour());
  r = await call({ action: "voidOrder", orderId: "CS-3", reason: "Duplicate" });
  ok("a page paid moments ago (payment not in yet) stops the void with a plain reason", r.status === 409 && /just paid/.test(r.body.message) && !(await lib.getOrderById(d1, "CS-3")).voidedAt);
  await mk("CS-4");
  r = await call({ action: "voidOrder", orderId: "CS-4", reason: "Duplicate" });
  ok("an order with no card page voids as before", r.status === 200);

  console.log("\n=== A Stripe refund of a shipping payment ===");
  const hook = (ev) => webhook({ request: signed(ev), env: { DB: d1, STRIPE_WEBHOOK_SECRET: WHSEC, STRIPE_SECRET_KEY: "sk_test_x" } });
  const shipPaid = (id) => d1.q("SELECT shippingPaidCents c FROM orders WHERE orderId=?", id)[0].c;
  const refundRows = (id) => d1.q("SELECT amountCents, shippingCents, externalRef FROM order_payments WHERE orderId=? AND kind IN ('refund','dispute') ORDER BY id", id);
  await mk("SH-1");
  await lib.addShippingPayment(d1, "SH-1", 8, "Shipping — Stripe", "pi_ship", 0);
  ok("(the shipping payment counts toward shipping paid)", shipPaid("SH-1") === 800);
  const refundEvent = (id, charge, pi) => ({ id, type: "charge.refunded", created: Math.floor(Date.now() / 1000),
    data: { object: { id: charge, payment_intent: pi, amount_refunded: 300, metadata: { orderId: "SH-1", orgId: "club" } } } });
  stripe.refunds.ch_ship = [{ id: "re_s1", amount: 300, status: "succeeded", created: Math.floor(Date.now() / 1000) }];
  // The refund row and the shipping-paid change are one transaction: if it fails, Stripe's retry does both.
  const realBatch = d1.batch.bind(d1); let failNext = true;
  d1.batch = async (stmts) => { if (failNext && stmts.length >= 3) { failNext = false; throw new Error("D1 unavailable"); } return realBatch(stmts); };
  let w = await hook(refundEvent("evt_rs1", "ch_ship", "pi_ship"));
  d1.batch = realBatch;
  ok("a failed write leaves neither the refund row nor the shipping change (500 → Stripe retries)", w.status === 500 && refundRows("SH-1").length === 0 && shipPaid("SH-1") === 800);
  w = await hook(refundEvent("evt_rs1", "ch_ship", "pi_ship"));
  let rows = refundRows("SH-1");
  ok("the retry records the refund as shipping (no sales tax backed out of it)", w.status === 200 && rows.length === 1 && rows[0].amountCents === -300 && rows[0].shippingCents === 300);
  ok("…and takes it off what's been paid toward shipping", shipPaid("SH-1") === 500);
  w = await hook(refundEvent("evt_rs2", "ch_ship", "pi_ship"));
  ok("a redelivery under a new event id changes nothing", w.status === 200 && refundRows("SH-1").length === 1 && shipPaid("SH-1") === 500);
  await lib.addOrderPayment(d1, "SH-1", 20, "Stripe", "pi_goods", { method: "card" });
  stripe.refunds.ch_goods = [{ id: "re_g1", amount: 1000, status: "succeeded", created: Math.floor(Date.now() / 1000) }];
  await hook(refundEvent("evt_rg1", "ch_goods", "pi_goods"));
  rows = refundRows("SH-1");
  ok("a refund of the goods payment stays all goods and leaves shipping paid alone", rows.length === 2 && rows[1].shippingCents === 0 && shipPaid("SH-1") === 500);
  await mk("SH-2");
  await lib.addShippingPayment(d1, "SH-2", 6, "Shipping — Stripe", "pi_ship2", 0);
  await hook({ id: "evt_dl1", type: "charge.dispute.closed", created: Math.floor(Date.now() / 1000),
    data: { object: { id: "dp_s1", payment_intent: "pi_ship2", amount: 600, status: "lost", reason: "fraudulent", metadata: { orderId: "SH-2", orgId: "club" } } } });
  rows = refundRows("SH-2");
  ok("a lost dispute of a shipping payment is shipping too", rows.length === 1 && rows[0].shippingCents === 600 && shipPaid("SH-2") === 0);

  console.log("\n=== Dispute events out of order or repeated (migrations/0211) ===");
  const disputeStatus = (id) => d1.q("SELECT disputeStatus s FROM orders WHERE orderId=?", id)[0].s;
  const notices = () => (globalThis.__disputeNotices || []).slice();
  const dispute = (id, type, dp, order, status) => hook({ id, type, created: Math.floor(Date.now() / 1000),
    data: { object: { id: dp, payment_intent: "pi_none", amount: 2000, status, reason: "fraudulent", metadata: { orderId: order, orgId: "club" } } } });
  await mk("DP-1");
  globalThis.__disputeNotices = [];
  await dispute("evt_d1", "charge.dispute.created", "dp_1", "DP-1", "needs_response");
  ok("a new dispute → needs a response, and the owner is told", disputeStatus("DP-1") === "warning_needs_response" && notices().join() === "DP-1:warning_needs_response");
  await dispute("evt_d1b", "charge.dispute.created", "dp_1", "DP-1", "needs_response");
  ok("the same dispute's opening event again (new event id) → no second urgent notice", notices().length === 1);
  await dispute("evt_d2", "charge.dispute.closed", "dp_1", "DP-1", "won");
  ok("closed as won → won, and the owner is told", disputeStatus("DP-1") === "won" && notices().slice(-1)[0] === "DP-1:won");
  w = await dispute("evt_d1c", "charge.dispute.created", "dp_1", "DP-1", "needs_response");
  ok("a late opening event after it was won doesn't put it back to 'needs response', nor resend the notice", w.status === 200 && disputeStatus("DP-1") === "won" && notices().length === 2);
  await dispute("evt_d2b", "charge.dispute.closed", "dp_1", "DP-1", "won");
  ok("the closing event again → no second notice", notices().length === 2);
  await mk("DP-2");
  await dispute("evt_d3", "charge.dispute.closed", "dp_2", "DP-2", "lost");
  await dispute("evt_d4", "charge.dispute.created", "dp_2", "DP-2", "needs_response");
  ok("closed (lost) delivered before created: stays lost, money taken back once", disputeStatus("DP-2") === "lost" && refundRows("DP-2").length === 1 && notices().filter(n => n.startsWith("DP-2")).join() === "DP-2:lost");
  await dispute("evt_d5", "charge.dispute.created", "dp_3", "DP-2", "needs_response");
  ok("a second, different dispute on the same order is still flagged", disputeStatus("DP-2") === "warning_needs_response" && notices().slice(-1)[0] === "DP-2:warning_needs_response");

  console.log("\n=== Manual payments are booked once per Save (migrations/0212) ===");
  const pays = (id) => d1.q("SELECT amountCents, kind, requestKey FROM order_payments WHERE orderId=? AND voidedAt IS NULL ORDER BY id", id);
  const auditCount = (action, id) => d1.q("SELECT count(*) n FROM audit_log WHERE action=? AND orderId=?", action, id)[0].n;
  await mk("MP-1", 120);
  r = await call({ action: "addPayment", orderId: "MP-1", amount: 120, method: "cash", requestId: "req-pay-0001" });
  let r2 = await call({ action: "addPayment", orderId: "MP-1", amount: 120, method: "cash", requestId: "req-pay-0001" });
  ok("the same Save sent twice (a double click, a retry) records $120 once", r.status === 200 && r2.status === 200 && r2.body.duplicate === true && pays("MP-1").length === 1 && pays("MP-1")[0].requestKey === "payment:req-pay-0001");
  ok("…and the second answer carries the order as it stands (settled)", r2.body.balanceDue === 0 && r2.body.payments.length === 1);
  r = await call({ action: "addPayment", orderId: "MP-1", amount: 5, method: "cash", requestId: "req-pay-0002" });
  ok("a new Save (a new key) is a new payment", r.status === 200 && !r.body.duplicate && pays("MP-1").length === 2);
  r = await call({ action: "addPayment", orderId: "MP-1", amount: 1, method: "cash" });
  ok("a request without a key still records (older pages)", r.status === 200 && pays("MP-1").length === 3);
  r = await call({ action: "recordRefund", orderId: "MP-1", amount: 6, method: "cash", requestId: "req-ref-0001" });
  r2 = await call({ action: "recordRefund", orderId: "MP-1", amount: 6, method: "cash", requestId: "req-ref-0001" });
  ok("a refund sent twice is recorded and audited once", r.status === 200 && r2.body.duplicate === true && pays("MP-1").filter(p => p.kind === "refund").length === 1 && auditCount("payment.refunded", "MP-1") === 1);
  r = await call({ action: "addPayment", orderId: "MP-1", amount: 1, method: "cash", requestId: "bad key!" });
  ok("a malformed key is ignored, not trusted", r.status === 200 && pays("MP-1").filter(p => p.requestKey === null).length === 2);

  console.log("\n=== Mark as paid twice books the balance once ===");
  await mk("MP-2", 80);
  globalThis.__confirmEmails = 0;
  r = await call({ action: "markPaidManual", orderId: "MP-2", requestId: "req-mark-0001" });
  r2 = await call({ action: "markPaidManual", orderId: "MP-2", requestId: "req-mark-0002" });
  ok("two Mark as paid (two admins, two tabs) → one $80 payment", r.status === 200 && r2.status === 200 && pays("MP-2").length === 1 && pays("MP-2")[0].amountCents === 8000);
  ok("…one confirmation email, and the second says it was already paid", globalThis.__confirmEmails === 1 && r2.body.alreadyPaid === true && r2.body.amountRecorded === 0);
  ok("…one 'marked paid' audit entry", auditCount("order.marked_paid", "MP-2") === 1);
  await mk("MP-3", 50);
  ok("the balance is booked only while the payments still add up to what was read (a card payment landing in between wins)",
    await lib.addOrderPayment(d1, "MP-3", 50, "Marked paid", "", { method: "cash", expectReceivedCents: 1000 }) === 0 && pays("MP-3").length === 0 &&
    await lib.addOrderPayment(d1, "MP-3", 50, "Marked paid", "", { method: "cash", expectReceivedCents: 0 }) > 0 && pays("MP-3").length === 1);

  console.log("\n=== 'Apply the rest as a discount' and closed months ===");
  await mk("CL-1", 100, { placedAt: "2025-03-10T12:00:00.000Z" });
  d1._raw.run("INSERT INTO closed_periods (month, closedAt, closedBy) VALUES ('2025-03', '2025-04-20T00:00:00Z', 'test')");
  r = await call({ action: "addPayment", orderId: "CL-1", amount: 60, method: "cash", discountRemainder: true, discountNote: "Agreed price" });
  ok("a payment that waives the rest as a discount on an order from a closed month is refused (409), nothing recorded",
    r.status === 409 && /closed/.test(r.body.message) && pays("CL-1").length === 0 && (await lib.getOrderById(d1, "CL-1")).discountAmount === 0);
  r = await call({ action: "addPayment", orderId: "CL-1", amount: 60, method: "cash" });
  ok("a plain late payment on it is still taken (it belongs to this month)", r.status === 200 && pays("CL-1").length === 1);
  await mk("CL-2", 100);
  r = await call({ action: "addPayment", orderId: "CL-2", amount: 70, method: "cash", discountRemainder: true, discountNote: "Agreed price" });
  const payAudit = JSON.parse(d1.q("SELECT detail FROM audit_log WHERE action='payment.added' AND orderId='CL-2'")[0].detail);
  ok("in an open month it goes through, and the audit entry shows the discount before and after",
    r.status === 200 && r.body.discountAmount === 30 && payAudit.discountFrom === 0 && payAudit.discountTo === 30 && /Agreed price/.test(payAudit.discountNote));

  console.log("\n=== Cancelling a line that's already cancelled ===");
  await lib.insertOrder(d1, { orderId: "CN-1", orgId: "club", customerName: "Pat Example", contact: "pat@example.com", paymentMethod: "Venmo",
    placedAt: "2026-11-01T10:00:00.000Z", subtotal: 30, shippingCost: 0, total: 30 },
    [{ productId: "", name: "Tee", type: "shirt", size: "L", qty: 1, unitPrice: 20 }, { productId: "", name: "Cap", type: "cap", size: "", qty: 1, unitPrice: 10 }]);
  const [lineA, lineB] = d1.q("SELECT id FROM order_items WHERE orderId='CN-1' ORDER BY id").map(x => x.id);
  globalThis.__cancelEmails = 0;
  r = await call({ action: "cancelLineItem", sheetRow: lineA, reason: "Out of stock", at: "2026-11-02T15:00:00.000Z" });
  const firstCancel = d1.q("SELECT cancelDate, cancelReason FROM order_items WHERE id=?", lineA)[0];
  r2 = await call({ action: "cancelLineItem", sheetRow: lineA, reason: "Changed mind" });
  const afterSecond = d1.q("SELECT cancelDate, cancelReason FROM order_items WHERE id=?", lineA)[0];
  ok("the second cancel of the same line answers 'already cancelled'", r.status === 200 && r2.status === 200 && r2.body.alreadyCancelled === true);
  ok("…keeps the first date and reason (the cancellation doesn't move months)", afterSecond.cancelDate === firstCancel.cancelDate && afterSecond.cancelReason === "Out of stock");
  ok("…and sends no second email or audit entry", globalThis.__cancelEmails === 1 && auditCount("item.cancelled", "CN-1") === 1);
  r = await call({ action: "bulkCancelLineItems", sheetRows: [lineA, lineB], reason: "Shop closed" });
  ok("a bulk cancel skips the line already cancelled: one email for the other line only",
    r.status === 200 && r.body.results.find(x => x.itemId === lineA).alreadyCancelled === true && !r.body.results.find(x => x.itemId === lineB).alreadyCancelled &&
    globalThis.__cancelEmails === 2 && d1.q("SELECT cancelReason FROM order_items WHERE id=?", lineA)[0].cancelReason === "Out of stock");

  console.log("\n=== A cancelled line's Record refund goes into the books ===");
  const mk2 = (orderId, method) => lib.insertOrder(d1, { orderId, orgId: "club", customerName: "Pat Example", contact: "pat@example.com", paymentMethod: method,
    placedAt: "2026-11-01T10:00:00.000Z", subtotal: 30, shippingCost: 0, total: 30 },
    [{ productId: "", name: "Tee", type: "shirt", size: "L", qty: 1, unitPrice: 20 }, { productId: "", name: "Cap", type: "cap", size: "", qty: 1, unitPrice: 10 }]);
  const lineOf = (orderId, name) => d1.q("SELECT id FROM order_items WHERE orderId=? AND name=?", orderId, name)[0].id;
  const lineRefund = (id) => d1.q("SELECT refundCents, refundDate FROM order_items WHERE id=?", id)[0];
  await mk2("LR-1", "Venmo");
  await call({ action: "addPayment", orderId: "LR-1", amount: 30, method: "venmo" });
  await call({ action: "cancelLineItem", sheetRow: lineOf("LR-1", "Cap"), reason: "Out of stock" });
  r = await call({ action: "setLineItemRefund", sheetRow: lineOf("LR-1", "Cap"), refundAmount: 10, method: "venmo", at: "2026-11-03T12:00:00.000Z" });
  let lr = await lib.getOrderById(d1, "LR-1");
  ok("Venmo: a refund entry goes into the payments, dated when it was refunded", r.status === 200 && r.body.ledger === true &&
    lr.payments.some(p => p.kind === "refund" && p.amount === -10 && p.method === "venmo" && /Cap/.test(p.note) && p.receivedAt.startsWith("2026-11-03")));
  ok("…so Payments shows it: $10 refunded, $20 kept, nothing due", lr.refundedAmount === 10 && lr.netReceived === 20 && lr.balanceDue === 0);
  ok("…and the line shows the refund too", lineRefund(lineOf("LR-1", "Cap")).refundCents === 1000);
  ok("…audited as a refund", auditCount("payment.refunded", "LR-1") === 1);
  r = await call({ action: "setLineItemRefund", sheetRow: lineOf("LR-1", "Cap"), refundAmount: 10, method: "venmo" });
  ok("the same line's refund sent again isn't booked twice", r.status === 200 && pays("LR-1").filter(p => p.kind === "refund").length === 1);
  await mk2("LR-2", "Card");
  await lib.addOrderPayment(d1, "LR-2", 30, "Stripe", "pi_lr2", { method: "card" });
  await call({ action: "cancelLineItem", sheetRow: lineOf("LR-2", "Cap"), reason: "Out of stock" });
  r = await call({ action: "setLineItemRefund", sheetRow: lineOf("LR-2", "Cap"), refundAmount: 10, method: "card" });
  ok("Card: only noted on the line — the Stripe refund arrives through the webhook, so it isn't counted twice",
    r.status === 200 && r.body.ledger === false && pays("LR-2").filter(p => p.kind === "refund").length === 0 && lineRefund(lineOf("LR-2", "Cap")).refundCents === 1000);
  await mk2("LR-3", "Cash");
  await call({ action: "addPayment", orderId: "LR-3", amount: 5, method: "cash" });
  await call({ action: "cancelLineItem", sheetRow: lineOf("LR-3", "Cap"), reason: "Out of stock" });
  r = await call({ action: "setLineItemRefund", sheetRow: lineOf("LR-3", "Cap"), refundAmount: 10, method: "cash" });
  ok("more than was kept on the order is refused, and the line isn't marked", r.status === 400 && /\$5\.00/.test(r.body.message) && lineRefund(lineOf("LR-3", "Cap")).refundDate === null);
  r = await call({ action: "setLineItemRefund", sheetRow: lineOf("LR-3", "Cap"), refundAmount: 5, method: "bitcoin" });
  ok("an unknown way of paying is refused", r.status === 400);
  const adminSrc = read("public/admin.js");
  ok("the line's dialog asks how it was refunded and says what it does for card", /id="lrMethod"/.test(adminSrc) && /Note refund on line/.test(adminSrc) && /method: got\.method/.test(adminSrc));

  console.log("\n=== The admin's money forms ===");
  const admin = read("public/admin.js");
  ok("Save payment, Record refund and Apply discount stay disabled ('Saving…') until the answer arrives",
    /whileSaving_\(ov\.querySelector\("#pmSavePayment"\)/.test(admin) && /whileSaving_\(refundBtn,/.test(admin) && /whileSaving_\(ov\.querySelector\("#pmSaveDiscount"\)/.test(admin));
  ok("payment and refund send the dialog's key; Mark as paid sends one and ignores a second click while it's on its way",
    /action:"addPayment", key:adminKey, orderId, amount, requestId: payRequestId/.test(admin) && /requestId: refundRequestId/.test(admin) && /markPaidInFlight_\.has\(orderId\)/.test(admin) && /action: "markPaidManual"[^\n]*requestId: newRequestId_\(\)/.test(admin));
  ok("more received than owed shows as a credit, not 'Settled'", /Credit \(paid more than owed\)/.test(admin));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
