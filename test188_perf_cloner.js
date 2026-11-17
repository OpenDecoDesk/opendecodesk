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
})().catch((e) => { console.error(e); console.log("test188 crashed: false"); process.exit(1); });
