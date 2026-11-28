const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { adminAs } = require("./testlib/roles.js");

// Orders → Import orders (orders.js importOrders, db.js importOrdersCsv). Once an imported order is made, its later
// steps (the discount, the payment, handing over its stock, marking it shipped) are separate writes. One of them
// failing used to stop the whole import with the order half done — and importing again skips it as already
// imported — and the audit entry was only written after a clean finish, without waiting for it. Now (owner's
// decision: keep the partial order and flag it) a failed step is reported by order number and step and the import
// goes on, and the audit entry, awaited, names every order made, also when the import stops part-way.
// Real SQL (sql.js), real db.js and orders.js; a database step is made to fail by a wrapper on the test database.
// Invented data only.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" + adminAs() + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false;\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn { post: onRequestPost };")();

let passed = 0, failed = 0;
const ok = (label, cond) => { cond ? passed++ : failed++; console.log(label + ": " + !!cond); };

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const t = "2026-10-01T12:00:00.000Z";
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Example Club','${t}','${t}');`);

  // A write that fails on purpose: any statement whose SQL matches fault.sql and that's bound to an order id
  // matching fault.id throws, whether it's run on its own or in a batch.
  const fault = { sql: null, id: null };
  const hit = (sql, params) => !!fault.sql && fault.sql.test(sql) && (params || []).some(p => typeof p === "string" && fault.id.test(p));
  const prepare = d1.prepare.bind(d1), batch = d1.batch.bind(d1);
  const boom = async () => { throw new Error("D1_ERROR: injected failure"); };
  d1.prepare = (sql) => {
    const s = prepare(sql), bind = s.bind;
    return Object.assign(s, { bind: (...ps) => { const b = bind(...ps); return hit(sql, ps) ? Object.assign({}, b, { first: boom, run: boom, all: boom }) : b; } });
  };
  d1.batch = async (stmts) => { if (stmts.some(s => hit(s._sql, s._params))) return boom(); return batch(stmts); };

  const pending = [];
  const call = async (body) => {
    const full = Object.assign({ key: "x" }, body);
    // A request that throws comes back as {threw} (the Worker would answer 500), so every check still prints.
    try {
      const res = await api.post({ env: { DB: d1 }, waitUntil: (p) => pending.push(Promise.resolve(p).catch(() => {})),
        request: { url: "https://admin.example.com/api/orders", json: async () => full, clone: () => ({ json: async () => full }), headers: { get: () => null } } });
      return { status: res.status, body: JSON.parse(await res.text()) };
    } catch (e) { return { status: 0, body: {}, threw: e }; }
  };
  const unit = (order, row, extra) => ({ order, row, lines: [Object.assign({ order, date: "2026-10-05", customer: "Pat Example", email: "pat@example.test",
    item: "Club tee", size: "L", qty: "2", price: "20", shipping: "5", paid: "yes", shipped: "2026-10-07", discount: "3" }, extra || {})] });
  const audits = () => d1.q("SELECT detail FROM audit_log WHERE action='orders.imported' ORDER BY id").map(r => JSON.parse(r.detail));
  const order = (no) => d1.q("SELECT orderId, paid, shippedAt, discountCents FROM orders WHERE externalOrderId=?", no)[0] || {};

  console.log("=== One order's payment fails: kept and named, the rest import fully ===");
  fault.sql = /INSERT (OR IGNORE )?INTO order_payments/i; fault.id = /-1002-/;
  let r = await call({ action: "importOrders", org: "acme", rows: [unit("1001", 2), unit("1002", 3), unit("1003", 4)] });
  ok("the import finishes (no error for the whole request)", r.status === 200 && r.body.status === "ok");
  ok("all three orders are made", r.body.created === 3 && ["1001", "1002", "1003"].every(n => !!order(n).orderId));
  ok("the orders either side are paid and shipped", ["1001", "1003"].every(n => order(n).paid === 1 && !!order(n).shippedAt));
  const two = (r.body.results || []).find(x => x.orderNo === "1002") || { problems: [] };
  ok("the result names the order and the step that failed", two.unfinished === "payment" && two.orderId === order("1002").orderId &&
    two.problems.some(p => /1002/.test(p) && /payment/.test(p)));
  ok("…its discount went in, and the steps after the payment weren't run", order("1002").discountCents === 300 && order("1002").paid === 0 && !order("1002").shippedAt);
  let a = audits(); const a0 = a[0] || {};
  ok("one audit entry names all three orders, written before the reply", a.length === 1 && a0.created === 3 && (a0.orderIds || []).length === 3 &&
    ["1001", "1002", "1003"].every(n => a0.orderIds.includes(order(n).orderId)));
  ok("…and says which one wasn't finished", (a0.unfinished || []).length === 1 && a0.unfinished[0].orderId === order("1002").orderId && a0.unfinished[0].step === "payment");

  console.log("\n=== Marking shipped fails for one order ===");
  fault.sql = /UPDATE orders SET shippedAt/i; fault.id = /-2002-/;
  r = await call({ action: "importOrders", org: "acme", rows: [unit("2001", 2), unit("2002", 3, { discount: "" })] });
  const s2 = (r.body.results || []).find(x => x.orderNo === "2002") || { problems: [] };
  ok("named as stopped at the shipped stage; it's paid; the other order is shipped", r.status === 200 && s2.unfinished === "shipped stage" &&
    order("2002").paid === 1 && !order("2002").shippedAt && !!order("2001").shippedAt);

  console.log("\n=== The import stops part-way: the orders already made are still audited ===");
  fault.sql = /INSERT INTO orders\b/i; fault.id = /-3003-/;
  r = await call({ action: "importOrders", org: "acme", rows: [unit("3001", 2), unit("3002", 3), unit("3003", 4), unit("3004", 5)] });
  const threw = r.threw;
  ok("the request fails at the order that couldn't be made", !!threw && /injected/.test(threw.message) && !order("3003").orderId && !order("3004").orderId);
  a = audits();
  const last = a[a.length - 1] || {};
  ok("an audit entry names the two orders made before it stopped", a.length === 3 && last.created === 2 && last.stoppedPartWay === true &&
    (last.orderIds || []).length === 2 && last.orderIds.includes(order("3001").orderId) && last.orderIds.includes(order("3002").orderId));

  console.log("\n=== Importing the same file again ===");
  fault.sql = null;
  r = await call({ action: "importOrders", org: "acme", rows: [unit("1001", 2), unit("1002", 3)] });
  ok("orders already in are skipped, and no audit entry is written for nothing", r.status === 200 && r.body.created === 0 && r.body.skipped === 2 && audits().length === 3);

  while (pending.length) await pending.shift();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
