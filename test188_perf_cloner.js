// The scale test's order cloner (perf/lib/clone.js): orders made by the real admin API, copied
// into the database, must come back from the real getOrders exactly like the order they were
// copied from — and a migration that adds a column or an order-linked table must not break it.
// Real SQL (sql.js), the real sign-in and the real /api/orders handler (testlib/auth-harness.js).
// `npm run perf` relies on this; when it fails, fix perf/lib/clone.js before a scale run.
const { makeAuth } = require("./testlib/auth-harness.js");
const { cloneOrders, describe, fromSqlJs } = require("./perf/lib/clone.js");

const ok = (d, c) => { console.log(d + ":", !!c); };
const DAY = 86400000;
const agoIso = (n) => new Date(Date.now() - n * DAY).toISOString();

(async () => {
  const A = await makeAuth();
  const cookie = await A.firstAdmin("Pat Example", "owner@example.com", "a long test password");
  const call = async (body) => {
    const r = await A.orders(body, cookie);
    if (r.status !== 200 || (r.body && r.body.status === "error")) throw new Error(body.action + ": " + JSON.stringify(r.body));
    return r.body;
  };
  const raw = A.d1._raw;
  const q = (sql, ...p) => A.d1.q(sql, ...p);

  console.log("=== Templates through the real API ===");
  await call({ action: "createOrg", orgId: "acme", subdomain: "acme", name: "Acme Sample Shop", ready: true, deliveryOptions: [{ type: "pickup" }] });
  await call({ action: "createProduct", org: "acme", productId: "tee", type: "shirt", name: "Club Tee", pricingMode: "sized", sizePricing: { M: 20, L: 22 }, images: [], features: [], visible: true });
  await call({ action: "createProduct", org: "acme", productId: "cap", type: "cap", name: "Club Cap", pricingMode: "flat", flatPrice: 15, noBlankNeeded: true, images: [], features: [], visible: true });
  const made = [];
  const sale = async (kind, days, items, paid) => {
    const r = await call({ action: "createLocalSale", org: "acme", items, customerName: "Alex Sample", contact: "alex@example.com", paymentMethod: "card", placedAt: agoIso(days), paid });
    made.push({ orderId: r.orderId, orgId: "acme", kind });
    return r.orderId;
  };
  const done = await sale("complete", 40, [{ productId: "tee", size: "M", qty: 2 }, { productId: "cap", size: "", qty: 1 }], true);
  await call({ action: "setFulfillmentStage", org: "acme", orderId: done, stage: "digitizingComplete", at: agoIso(39) });
  await sale("paidNew", 41, [{ productId: "cap", size: "", qty: 3 }], true);
  const owing = await sale("unpaid", 42, [{ productId: "tee", size: "L", qty: 1 }], false);
  await call({ action: "addPayment", orderId: owing, amount: 5, method: "cash" });
  ok("three template orders were made by createLocalSale", q("SELECT count(*) n FROM orders")[0].n === 3);

  console.log("=== What the cloner copies ===");
  const AD = fromSqlJs(raw);
  const info = describe(AD);
  const withOrderId = q("SELECT name FROM sqlite_master WHERE type='table'").map(r => r.name)
    .filter(t => q(`PRAGMA table_info("${t}")`).some(c => c.name === "orderId"));
  ok("every table with an orderId column is copied with its order", withOrderId.every(t => info[t]));
  ok("generated columns (shipState) are left for SQLite to fill", !info.orders.cols.includes("shipState"));
  ok("order lines get new ids from SQLite (their key is not copied)", info.order_items.rowidKey === "id" && !info.order_items.cols.includes("id"));
  // A migration adding a column: picked up with no change to the cloner.
  raw.run("ALTER TABLE orders ADD COLUMN perfProbe TEXT");
  raw.run("UPDATE orders SET perfProbe = 'kept' WHERE orderId = ?", [done]);
  // An order imported from another store: unique per (orgId, source, externalOrderId). Copies must keep
  // their shop and store and get their own store order number, not a changed orgId.
  raw.run("UPDATE orders SET source = 'etsy', externalOrderId = '3141592653' WHERE orderId = ?", [owing]);
  ok("of a unique index over several columns, only the store order number is made unique", info.orders.unique.includes("externalOrderId")
    && !info.orders.unique.includes("orgId") && !info.orders.unique.includes("source"));

  console.log("=== Copies ===");
  const state = { next: 0 };
  const c = cloneOrders(AD, { templates: made, count: 90, perDay: 3, startAgeDays: 0, state });
  ok("90 orders were added", q("SELECT count(*) n FROM orders")[0].n === 93 && c.added === 90);
  ok("no copy breaks a foreign key", q("PRAGMA foreign_key_check").length === 0);
  const imported = q("SELECT orgId, source, externalOrderId FROM orders WHERE externalOrderId IS NOT NULL");
  ok("copies of an imported order keep their shop and store, each with its own order number", imported.length > 1
    && imported.every(o => o.orgId === "acme" && o.source === "etsy")
    && new Set(imported.map(o => o.externalOrderId)).size === imported.length);
  ok("every copy has a new, valid, unique order ID", q("SELECT count(DISTINCT orderId) n FROM orders")[0].n === 93
    && q("SELECT orderId FROM orders").every(r => /^[A-Za-z0-9\-]{1,64}$/.test(r.orderId)));
  ok("history runs backwards at the rate asked (90 orders at 3 a day ≈ 30 days)",
    Math.abs((Date.now() - Date.parse(c.oldest)) / DAY - 30) < 1.5);
  const dateCols = q("PRAGMA table_info(orders)").map(r => r.name).filter(n => /At$/.test(n));
  const latest = Math.max(...q(`SELECT ${dateCols.map(n => `max(coalesce(${n}, ''))`).join(" || '|' || ")} AS v FROM orders`)[0].v.split("|").filter(Boolean).map(Date.parse));
  ok("no copied date lands in the future", latest <= Date.now() + 60000);
  ok("a column added by a migration is copied too", q("SELECT count(*) n FROM orders WHERE perfProbe = 'kept'")[0].n > 1);
  ok("copies get invented customers at example.com", q("SELECT count(*) n FROM orders WHERE contact NOT LIKE '%@example.com'")[0].n === 0);
  ok("each copy keeps its template's lines", q(`SELECT count(*) n FROM orders o WHERE (SELECT count(*) FROM order_items i WHERE i.orderId = o.orderId) = 0`)[0].n === 0);
  ok("payments are copied with their orders", q("SELECT count(*) n FROM order_payments")[0].n > 30);

  console.log("=== Read back through the real getOrders ===");
  const list = (await call({ action: "getOrders", org: "acme", dateFrom: "", dateTo: "" })).orders;
  ok("getOrders returns every copy", list.length === 93);
  const byId = Object.fromEntries(list.map(o => [o.orderId, o]));
  const s = c.samples[0];
  const copy = byId[s.orderId], tpl = byId[s.templateId];
  ok("a copy has its template's total, lines and paid state", copy && tpl && copy.total === tpl.total
    && copy.items.length === tpl.items.length && copy.paid === tpl.paid);
  ok("a copy's stage dates keep their distance from its order date", list.filter(o => o.digitizingCompleteAt)
    .every(o => Math.abs(Date.parse(o.digitizingCompleteAt) - Date.parse(o.placedAt) - DAY) < 5 * 60000));

  console.log("=== Work pool ===");
  const pool = cloneOrders(AD, { templates: made, count: 5, only: ["paidNew"], ageRange: [0.2, 3], state: { next: 1000 } });
  ok("a work pool copies only the kind asked for, placed in the last few days", pool.made.length === 5 && pool.made.every(o => o.kind === "paidNew")
    && q(`SELECT count(*) n FROM orders WHERE orderId IN (${pool.made.map(() => "?").join(",")}) AND placedAt > ?`, ...pool.made.map(o => o.orderId), agoIso(3.1))[0].n === 5);
  const stage = await A.orders({ action: "setFulfillmentStage", org: "acme", orderId: pool.made[0].orderId, stage: "digitizingComplete" }, cookie);
  ok("the real handler accepts a stage change on a pool order", stage.status === 200 && stage.body.status !== "error");

  console.log("=== The Orders page is timed as the page loads it (perf/lib/ops.js) ===");
  // renderAdminOrders (public/admin.js) sends getOrders and three companion requests at once; the page is drawn when
  // the last answers. The scale test times them together, by the wall clock, and each companion on its own.
  const { READS, callOp, rowsOf } = require("./perf/lib/ops.js");
  const { timeOp } = require("./perf/lib/measure.js");
  const pageOp = READS.find(o => o.name === "orders-page");
  const ctx = { shops: ["acme"], today: agoIso(0).slice(0, 10), d30: agoIso(30).slice(0, 10) };
  const sent = pageOp ? pageOp.bodies(ctx, 0) : [];
  ok("the orders-page operation sends getOrders with getBlanks (stock only), getBlankLinks and listDesignVerifications",
    sent.map(b => b.action).join() === "getOrders,getBlanks,getBlankLinks,listDesignVerifications" && sent[1].stockOnly === true && sent.every(b => b.action === "getBlanks" || b.org === "acme"));
  const adminSrc = require("fs").readFileSync(__dirname + "/public/admin.js", "utf8");
  const render = adminSrc.slice(adminSrc.indexOf("const blanksAsked = listCacheAsk_({action:\"getBlanks\", stockOnly:true"), adminSrc.indexOf("]).then(([orders, verifData, blankLinksData, blanksData])"));
  ok("…which are the ones renderAdminOrders sends alongside the list", render.length > 100 && /fetchOrders\(org\.orgId\)/.test(render) &&
    /action:"listDesignVerifications"/.test(render) && /action:"getBlankLinks"/.test(render) && /JSON\.stringify\(blanksAsked\)/.test(render));
  ok("…and each companion is timed on its own too", ["blanks-stock", "blank-links", "design-verifications"].every(n => { const o = READS.find(x => x.name === n); return o && o.body && sent.some(b => JSON.stringify(b) === JSON.stringify(o.body(ctx, 0))); }));
  const sentHere = [];
  const timed = await timeOp((i) => callOp(pageOp, ctx, i, (b) => { sentHere.push(b.action); return A.orders(b, cookie).then(r => ({ ...r, ms: 0, bytes: JSON.stringify(r.body).length })); }), { runs: 2, warmup: 1, rowsOf });
  ok("all four go through the real handler, and the time is the wall clock around them (not 0, the parts' own)", !timed.error && timed.n === 2 && timed.median > 0 &&
    sentHere.length === 12 && timed.rows === (await call(sent[0])).orders.length && timed.rows > 0 && timed.bytes > 0);
  // Requests sent at once overlap: three that each take ~60 ms take ~60 ms together, not 180.
  const later = (ms, r) => new Promise(res => setTimeout(() => res(r), ms));
  const answerOk = { status: 200, ms: 60, bytes: 10, body: { status: "ok", orders: [1, 2] } };
  const par = await timeOp(() => Promise.all([later(60, answerOk), later(60, answerOk), later(60, answerOk)]), { runs: 1, warmup: 0, rowsOf });
  ok("requests sent at once are timed together by the wall clock", !par.error && par.median >= 55 && par.median < 150 && par.bytes === 30 && par.rows === 2);
  const bad = await timeOp(() => Promise.all([later(1, answerOk), later(1, { status: 403, ms: 1, bytes: 5, body: { status: "error", message: "Your role can't do this." } })]), { runs: 1, warmup: 0, rowsOf });
  ok("…and one of them failing fails the operation, with its message", /HTTP 403: Your role can't do this/.test(String(bad.error)));

  console.log("=== D1 round trips (perf/lib/d1-native.js) ===");
  const { openNativeD1 } = require("./perf/lib/d1-native.js");
  const os = require("os"), fs = require("fs"), path = require("path");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "odd-trips-"));
  try {
    const D = openNativeD1(path.join(tmp, "t.sqlite"));
    await D.d1.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    D.reset();
    await D.d1.prepare("INSERT INTO t (v) VALUES (?)").bind("a").run();
    await D.d1.prepare("SELECT * FROM t").all();
    await D.d1.prepare("SELECT v FROM t WHERE id = ?").bind(1).first("v");
    await D.d1.batch([1, 2, 3].map(n => D.d1.prepare("INSERT INTO t (v) VALUES (?)").bind("b" + n)));
    const rep = D.report();
    ok("each first/all/run is one round trip and a batch of three is one more (4), though it ran 6 statements", D.trips() === 4 && rep.trips === 4 && rep.statements === 6);
    D.reset();
    ok("…and reset() starts the count again", D.trips() === 0);
    D.close();
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  const { modeledD1 } = require("./perf/lib/report.js");
  ok("the report shows modeled D1 time = trips × PERF_D1_RTT_MS, and for requests sent at once the longest of them",
    /12 D1 round trips · modeled D1 time = 12 × 10 ms = 120 ms/.test(modeledD1({ trips: 12, parts: 1, tripsLongest: 12 }, 10)) &&
    /20 D1 round trips · modeled D1 time = 9 \(the longest of the 4 requests sent at once\) × 25 ms = 225 ms/.test(modeledD1({ trips: 20, parts: 4, tripsLongest: 9 }, 25)) &&
    /PERF_D1_RTT_MS/.test(fs.readFileSync(__dirname + "/perf/profile.js", "utf8")) && /PERF_D1_RTT_MS/.test(fs.readFileSync(__dirname + "/perf/README.md", "utf8")));
})().catch((e) => { console.error(e); console.log("test188 crashed: false"); process.exit(1); });
