const fs = require("fs");
const { storefrontPage } = require("./testlib/storefront-page");
const { autoConfirm } = require("./testlib/confirm.js");
const { createD1 } = require("./testlib/d1-shim.js");
const { JSDOM, ResourceLoader } = require("jsdom");

// Bulk order changes at scale (2026-11). D1 caps the queries one Worker request may run, so:
//   - bulkSetFulfillmentStage reads every picked order in one go (not a full read per order) and takes at most
//     20 orders a request; setOrderCompleted, bulkSetDueDate and updateCustomerInfo take at most 100
//   - setOrderCompleted reads the orders in one query and changes them in batches
//   - the Orders page sends a bigger selection in groups of that size, one after another; when a group fails it
//     stops and says how many orders were done and that the rest were not changed
// Real SQL (sql.js) + real db.js, orders.js and admin.js (jsdom). Invented shops and customers only.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + "\nreturn { insertOrder };")();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'owner@test'; " + require("./testlib/roles").adminAs() + "\n" + strip(read("functions/_lib/permissions.js")) + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
let failed = 0;
const ok = (label, cond) => { if (!cond) failed++; console.log(label + ": " + !!cond); };
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Example Club','t','t');`);

  // Counts the database calls a request makes: each first/all/run, each statement of a batch, and (apart) the
  // audit rows written after the response.
  const counted = { q: 0, audit: 0 };
  const wrap = (st) => {
    const isAudit = /INSERT INTO audit_log/.test(st._sql || "");
    const tally = () => { if (isAudit) counted.audit++; else counted.q++; };
    return { _sql: st._sql, _params: st._params,
      first: (...a) => { tally(); return st.first(...a); }, all: (...a) => { tally(); return st.all(...a); }, run: (...a) => { tally(); return st.run(...a); } };
  };
  const db = {
    prepare: (sql) => { const p = d1.prepare(sql); return Object.assign(wrap(p), { bind: (...v) => wrap(p.bind(...v)) }); },
    batch: (stmts) => { stmts.forEach(s => { if (/INSERT INTO audit_log/.test(s._sql)) counted.audit++; else counted.q++; }); return d1.batch(stmts); },
  };
  const call = async (body) => {
    const waits = [];
    const res = await api({ env: { DB: db }, waitUntil: (p) => waits.push(p && p.then ? p.then(() => {}, () => {}) : null),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x", org: "acme" }, body), headers: { get: () => null } } });
    await Promise.all(waits);
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const measure = async (body) => { counted.q = 0; counted.audit = 0; const r = await call(body); return { ...r, q: counted.q, audit: counted.audit }; };

  // 130 orders, each two lines, made and QA'd and packed — ready to be marked delivered, and paid.
  const ids = [];
  for (let i = 0; i < 130; i++) {
    const id = "B" + String(i).padStart(3, "0");
    ids.push(id);
    await lib.insertOrder(d1, { orderId: id, orgId: "acme", customerName: "Customer " + i, contact: "c" + i + "@example.com", placedAt: daysAgo(5) },
      [{ productId: "cap", name: "Cap", type: "cap", size: "OSFA", qty: 1, unitPrice: 20 }, { productId: "tee", name: "Tee", type: "shirt", size: "M", qty: 1, unitPrice: 15 }]);
  }
  d1._raw.run(`UPDATE orders SET paid = 1, blankOrderedAt = ?, blankReceivedAt = ?, digitizingCompleteAt = ?, designApprovedAt = ?, manufacturedAt = ?, qaPackedAt = ?`,
    [daysAgo(4), daysAgo(4), daysAgo(4), daysAgo(4), daysAgo(3), daysAgo(2)]);
  const delivered = () => d1.q("SELECT count(*) n FROM orders WHERE deliveredAt IS NOT NULL")[0].n;

  console.log("=== Step changes: at most 20 orders a request, read in one go ===");
  let r = await measure({ action: "bulkSetFulfillmentStage", orderIds: ids.slice(0, 21), stage: "delivered" });
  ok("21 orders in one request are refused, saying the most it takes, and nothing changes", r.status === 400 && /max 20/.test(r.body.message) && delivered() === 0);
  r = await measure({ action: "bulkSetFulfillmentStage", orderIds: ids.slice(0, 20), stage: "delivered" });
  ok("20 orders are all marked delivered", r.status === 200 && r.body.updated === 20 && r.body.skipped === 0 && delivered() === 20);
  ok(`…in a few dozen database calls (${r.q}), not a full order read per order (that was 10+ each)`, r.q < 60);
  r = await measure({ action: "bulkSetFulfillmentStage", orderIds: [ids[0], "NOPE-1"], stage: "delivered" });
  ok("an order that doesn't exist is skipped with a reason; the rest still go through", r.status === 200 && r.body.skipped === 1 && r.body.errors.some(e => /^NOPE-1:/.test(e)));
  const one = await measure({ action: "bulkSetFulfillmentStage", orderIds: ids.slice(20, 21), stage: "delivered" });
  const twenty = await measure({ action: "bulkSetFulfillmentStage", orderIds: ids.slice(21, 41), stage: "delivered" });
  ok(`the calls grow by about one an order: 1 order ${one.q}, 20 orders ${twenty.q}`, twenty.q - one.q <= 2 * 19 && delivered() === 41);

  console.log("\n=== Complete, due date, customer info: at most 100 a request ===");
  r = await measure({ action: "setOrderCompleted", orderIds: ids.slice(0, 101) });
  ok("101 orders to complete are refused (max 100), none completed", r.status === 400 && /max 100/.test(r.body.message) && d1.q("SELECT count(*) n FROM orders WHERE completedAt IS NOT NULL")[0].n === 0);
  r = await measure({ action: "setOrderCompleted", orderIds: ids.slice(0, 41).concat(ids.slice(41, 45)) });
  ok("the 41 delivered orders are completed, the 4 not delivered are skipped saying why", r.status === 200 && r.body.updated === 41 && r.body.skipped.length === 4 &&
    r.body.skipped.every(x => /not delivered/.test(x.reason)) && d1.q("SELECT count(*) n FROM orders WHERE completedAt IS NOT NULL")[0].n === 41);
  ok(`…read in one query and changed in batches (41 updates and ${r.q - 41} other call(s)), with an audit entry each`, r.q - 41 <= 5 && r.audit === 41);
  r = await measure({ action: "setOrderCompleted", orderIds: ids.slice(0, 2), completed: false });
  ok("reopening still works, one query to read them", r.body.updated === 2 && d1.q("SELECT count(*) n FROM orders WHERE completedAt IS NOT NULL")[0].n === 39);
  r = await measure({ action: "bulkSetDueDate", orderIds: ids.slice(0, 101), dueDate: "2030-01-15" });
  ok("101 due dates are refused (max 100)", r.status === 400 && /max 100/.test(r.body.message) && d1.q("SELECT count(*) n FROM orders WHERE dueDate IS NOT NULL")[0].n === 0);
  r = await measure({ action: "bulkSetDueDate", orderIds: ids.slice(0, 100), dueDate: "2030-01-15" });
  ok(`100 due dates are set, the old ones read in one query (${r.q} calls), each audited`, r.status === 200 && r.body.updated === 100 && r.q <= 105 && r.audit === 100 &&
    d1.q("SELECT count(*) n FROM orders WHERE dueDate = '2030-01-15'")[0].n === 100);
  r = await measure({ action: "updateCustomerInfo", orderIds: ids.slice(0, 101), customerName: "Renamed" });
  ok("101 orders' customer info is refused (max 100)", r.status === 400 && /max 100/.test(r.body.message) && d1.q("SELECT count(*) n FROM orders WHERE customerName = 'Renamed'")[0].n === 0);

  console.log("\n=== The Orders page sends a big selection in groups (jsdom) ===");
  const adminJs = read("public/admin.js");
  const sent = [];
  let failAt = 0;   // the group (1-based) the server refuses; 0 = none
  class L extends ResourceLoader { fetch(url, o) { if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const dom = new JSDOM(storefrontPage(), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win) { win.fetch = async (u, init) => {
      const b = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
      if (Array.isArray(b.orderIds)) {
        sent.push(b);
        if (failAt && sent.length === failAt) return { ok: false, status: 500, json: async () => ({ status: "error", message: "Server error" }) };
        const n = b.orderIds.length;
        const body = b.action === "setOrderCompleted" ? { status: "ok", updated: n, skipped: [] } : b.action === "bulkSetFulfillmentStage" ? { status: "ok", updated: n, skipped: 0, errors: [] } : { status: "ok", updated: n };
        return { ok: true, status: 200, json: async () => body };
      }
      return { ok: true, status: 200, json: async () => ({ status: "ok", orders: [] }) };
    }; } });
  const w = dom.window;
  await new Promise(x => setTimeout(x, 150));
  await w.loadAdminScript();
  w.eval('adminKey = "cookie"; adminOrgs = [];');
  const toasts = []; w.showToast = (m, bad) => toasts.push({ m, bad: !!bad });
  autoConfirm(w, () => true);
  // 45 ticked orders on the page.
  const box = w.document.createElement("div");
  box.innerHTML = ids.slice(0, 45).map(id => `<input type="checkbox" class="order-select" data-org="acme" data-order="${id}" checked>`).join("");
  w.document.body.appendChild(box);

  await w.bulkSetFulfillmentStage("acme", "qaPacked");
  ok("45 picked orders go as three requests of 20, 20 and 5, in order", sent.map(b => b.orderIds.length).join(",") === "20,20,5" &&
    sent.every(b => b.action === "bulkSetFulfillmentStage" && b.stage === "qaPacked") && sent.flatMap(b => b.orderIds).join(",") === ids.slice(0, 45).join(","));
  ok("…and the message adds them up", /^Updated 45\./.test(toasts.slice(-1)[0].m) && !toasts.slice(-1)[0].bad);

  sent.length = 0; failAt = 2;
  await w.bulkSetFulfillmentStage("acme", "qaPacked");
  const t = toasts.slice(-1)[0];
  ok("the second group failing stops there: no third request", sent.length === 2);
  ok("…and the message says how far it got and that the rest weren't changed", t.bad && /Updated 20/.test(t.m) && /stopped after 20 of 45 orders/.test(t.m) && /other 25 were not changed/.test(t.m));

  sent.length = 0; failAt = 1;
  await w.bulkSetFulfillmentStage("acme", "qaPacked");
  ok("the first group failing reads as before: the update failed", sent.length === 1 && /^Bulk update failed: Server error/.test(toasts.slice(-1)[0].m));

  sent.length = 0; failAt = 0;
  await w.completeOrders("acme", ids.slice(0, 130), true);
  ok("completing 130 orders sends 100, then 30", sent.map(b => b.orderIds.length).join(",") === "100,30" && sent.every(b => b.action === "setOrderCompleted" && b.completed === true));
  ok("…and says 130 were completed", /^Completed 130 orders\./.test(toasts.slice(-1)[0].m));

  sent.length = 0; failAt = 2;
  await w.completeOrders("acme", ids.slice(0, 130), true);
  ok("completing stopped partway says so", /Completed 100 orders\./.test(toasts.slice(-1)[0].m) && /stopped after 100 of 130/.test(toasts.slice(-1)[0].m) && toasts.slice(-1)[0].bad);
  w.__confirmObserver.disconnect(); w.close();

  if (failed) { console.log("\n" + failed + " check(s) failed"); process.exit(1); }
})().catch((e) => { console.error(e); console.log("test221 crashed: false"); process.exit(1); });
