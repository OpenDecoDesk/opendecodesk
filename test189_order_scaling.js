const fs = require("fs");
const { storefrontPage } = require("./testlib/storefront-page");
const { createD1 } = require("./testlib/d1-shim.js");
const { JSDOM, ResourceLoader } = require("jsdom");

// What keeps the order screens and reports fast as the history grows (the scale test, perf/README.md):
//   - loadOrders_ searches the orders once and reads the child tables by that id list (json_each), with
//     the old repeated-subquery form for a very long list; both give the same orders
//   - idx_orders_open (migrations/0087) is what Open orders and the queues search
//   - one order's brand check reads only its own products' blank links
//   - one read of the inventory history values it at several moments
//   - getOrders returns at most the newest ORDERS_LIST_MAX orders of a shop, and getOrdersAllShops the newest
//     ORDERS_LIST_MAX across every shop together (not that many per shop), with `more`, and the Orders page says
//     some were left out
// Real SQL (sql.js) + real db.js, orders.js and admin.js (jsdom).

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const EXPORTS = "\nreturn { insertOrder, getOpenOrders, getOrdersByOrg, getOrderById, brandContext_, getInventoryValuation, getInventoryValuations, getAccountantExport };";
const lib = new Function(dbSrc + EXPORTS)();
// The same code with a 3-order id list limit, so the fallback (repeat the search as a subquery) runs on a small database.
if (!dbSrc.includes("const ORDER_ID_LIST_MAX = 5000;")) throw new Error("ORDER_ID_LIST_MAX not found in db.js");
const libSmall = new Function(dbSrc.replace("const ORDER_ID_LIST_MAX = 5000;", "const ORDER_ID_LIST_MAX = 3;") + EXPORTS)();
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
let failed = 0;
const ok = (label, cond) => { if (!cond) failed++; console.log(label + ": " + !!cond); };

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('prime','prime','Example League','t','t'), ('rec','rec','REC','t','t');`);
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`
    INSERT INTO products (productId, orgId, type, name, pricingMode, createdAt, updatedAt) VALUES
      ('jacket','prime','shirt','Work Jacket','flat','t','t'), ('tee','prime','shirt','Tee','flat','t','t'), ('cap','rec','hat','Cap','flat','t','t');
    INSERT INTO blanks (id, name, brand, sku, color, createdAt, updatedAt) VALUES (1,'Carhartt jacket','Carhartt','CT104','Brown','t','t'), (2,'Plain tee','Gildan','G500','White','t','t');
    INSERT INTO product_blank_links (orgId, productId, productSize, blankId, blankSize) VALUES
      ('prime','jacket','L',1,'L'), ('prime','jacket','XL',1,'XL'), ('prime','tee','L',2,'L'), ('rec','cap','',2,'');`);

  const add = (orderId, orgId, days, items) => lib.insertOrder(d1, { orderId, orgId, customerName: "Cust " + orderId,
    contact: orderId.toLowerCase() + "@example.com", paymentMethod: "Venmo", placedAt: daysAgo(days) },
    items || [{ productId: "tee", name: "Tee", type: "shirt", size: "L", qty: 2, unitPrice: 12 }]);
  for (let i = 0; i < 6; i++) await add("P" + i, "prime", 10 - i);
  for (let i = 0; i < 3; i++) await add("R" + i, "rec", 8.5 - i, [{ productId: "cap", name: "Cap", type: "hat", size: "", qty: 1, unitPrice: 15 }]);
  await add("BIG", "prime", 2, [{ productId: "jacket", name: "Work Jacket", type: "shirt", size: "L", qty: 120, unitPrice: 40 }]);
  d1._raw.run("INSERT INTO order_payments (orderId, amountCents, receivedAt, method) VALUES ('P1', 2400, ?, 'venmo')", [daysAgo(1)]);
  d1._raw.run("UPDATE orders SET completedAt=?, deliveredAt=? WHERE orderId IN ('P0','R0')", [daysAgo(1), daysAgo(1)]);

  console.log("=== loadOrders_: the orders once, then their child rows by id list ===");
  const strip_ = (list) => JSON.stringify(list.map(o => ({ ...o })));
  const viaList = await lib.getOrdersByOrg(d1, "prime"), viaSub = await libSmall.getOrdersByOrg(d1, "prime");
  ok("a shop's orders load with their lines and payments", viaList.length === 7 && viaList.every(o => o.items.length === 1) && viaList.find(o => o.orderId === "P1").payments.length === 1);
  ok("past the id-list limit, the repeated-search form gives exactly the same orders", strip_(viaList) === strip_(viaSub));
  const open = await lib.getOpenOrders(d1), openSub = await libSmall.getOpenOrders(d1);
  ok("open orders: every shop, completed ones left out, oldest first", open.map(o => o.orderId).join(",") === "P1,P2,R1,P3,R2,P4,P5,BIG");
  ok("…the same through the repeated-search form", strip_(open) === strip_(openSub));
  ok("a limit returns the newest that many", (await lib.getOrdersByOrg(d1, "prime", {}, { limit: 2 })).map(o => o.orderId).join(",") === "BIG,P5");
  let threw = false; try { await libSmall.getOrdersByOrg(d1, "prime", {}, { limit: 5 }); } catch (e) { threw = /limit above/.test(e.message); }
  ok("a limit above the id-list limit is refused, not silently cut", threw);
  ok("the big order's brand check is still found through the list", viaList.find(o => o.orderId === "BIG").brandReview[0].pieces === 120);

  console.log("\n=== idx_orders_open (migrations/0087) ===");
  const plan = (sql) => d1._raw.exec("EXPLAIN QUERY PLAN " + sql)[0].values.map(r => r[r.length - 1]).join(" ; ");
  ok("open orders are found through idx_orders_open", /idx_orders_open/.test(plan(`SELECT o.orderId FROM orders o WHERE o.completedAt IS NULL AND o.voidedAt IS NULL AND o.isTest = 0 ORDER BY placedAt ASC`)));
  ok("…and so is the production queue's search",
    /idx_orders_open/.test(plan(`SELECT o.orderId FROM orders o WHERE (o.paid = 1 OR o.paidForWork = 1) AND o.isTest = 0 AND o.voidedAt IS NULL AND o.manufacturedAt IS NULL AND o.completedAt IS NULL AND o.shippedAt IS NULL`)));
  ok("a period of manufactured orders is found through idx_orders_manufactured",
    /idx_orders_manufactured/.test(plan(`SELECT o.orderId FROM orders o WHERE o.manufacturedAt >= '2026-01-01' AND o.manufacturedAt <= '2026-12-31' AND +o.isTest = 0`)));

  console.log("\n=== The brand check reads only the order's own blank links ===");
  const bigItems = d1._raw.exec("SELECT * FROM order_items WHERE orderId = 'BIG'")[0];
  const lines = bigItems.values.map(v => Object.fromEntries(bigItems.columns.map((c, i) => [c, v[i]])));
  const scoped = await lib.brandContext_(d1, lines), whole = await lib.brandContext_(d1);
  ok("scoped to the order's products: only the jacket's 2 links, not all 4", scoped.linkAt.size === 2 && whole.linkAt.size === 4);
  ok("no lines, no links read", (await lib.brandContext_(d1, [])).linkAt.size === 0);
  const big = await lib.getOrderById(d1, "BIG");
  ok("one order still gets its brand check (120 Carhartt CT104, not approved)", big.brandReview.length === 1 && big.brandReview[0].style === "CT104" && big.brandReview[0].approved === false);

  console.log("\n=== Inventory valued at several moments from one read ===");
  const mv = (qty, cost, kind, at) => d1._raw.run(`INSERT INTO inventory_movements (blankId, blankName, color, size, qtyDelta, unitCostCents, kind, occurredAt, createdAt)
    VALUES (2, 'Plain tee', 'White', 'L', ?, ?, ?, ?, ?)`, [qty, cost, kind, at, at]);
  mv(10, 500, "purchase", "2026-03-01T10:00:00.000Z"); mv(-4, 500, "consume", "2026-03-05T10:00:00.000Z"); mv(6, 800, "purchase", "2026-03-09T10:00:00.000Z");
  const moments = ["2026-12-31T23:59:59.999Z", "2026-03-04T23:59:59.999Z", "2026-02-01T00:00:00.000Z", "2026-03-08T23:59:59.999Z"];
  const many = await lib.getInventoryValuations(d1, moments);
  ok("one result per moment, in the order asked", many.map(v => v.asOf).join() === moments.join());
  ok("end: 12 at the running average 650¢ = $78", many[0].units === 12 && many[0].value === 78 && many[0].rows[0].avgCost === 6.5);
  ok("after the first purchase: 10 at $5 = $50", many[1].units === 10 && many[1].value === 50);
  ok("before any movement: nothing", many[2].units === 0 && many[2].rows.length === 0);
  ok("after the consume: 6 at $5 = $30", many[3].units === 6 && many[3].value === 30);
  const single = await Promise.all(moments.map(m => lib.getInventoryValuation(d1, m)));
  ok("each matches valuing that moment on its own", JSON.stringify(single) === JSON.stringify(many));
  const exp = await lib.getAccountantExport(d1, "2026-03-05T00:00:00.000Z", "2026-03-31T23:59:59.999Z");
  const forSale = exp.inventoryGroups.find(g => g.group === "Blanks for sale");
  ok("the accountant export's beginning and ending inventory come from the one read ($50 → $78)", forSale.beginning === 50 && forSale.ending === 78);

  console.log("\n=== getOrders: at most the newest ORDERS_LIST_MAX per shop ===");
  const ordersSrc = strip(read("functions/api/orders.js"));
  if (!ordersSrc.includes("const ORDERS_LIST_MAX = 2000;")) throw new Error("ORDERS_LIST_MAX not found in orders.js");
  const api = new Function(
    strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
    "const requireAdmin = async (env, host) => host.kind === 'admin' ? null : jsonResponse({ status: 'error', message: 'Admin only' }, 403); const adminActor = () => 'test';\n" +
    "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
    "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
    "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
    dbSrc + "\n" + strip(read("functions/_lib/email.js")) + "\n" + strip(read("functions/_lib/deliveryCheck.js")) + "\n" +
    ordersSrc.replace("const ORDERS_LIST_MAX = 2000;", "const ORDERS_LIST_MAX = 4;") + "\nreturn onRequestPost;")();
  const call = async (body) => {
    const x = await api({ env: { DB: d1 }, waitUntil: () => {}, request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: x.status, body: JSON.parse(await x.text()) };
  };
  let r = await call({ action: "getOrders", org: "prime", dateFrom: "", dateTo: "" });
  ok("dates cleared, 7 orders, a cap of 4: the newest 4, and more is true", r.status === 200 && r.body.orders.map(o => o.orderId).join(",") === "BIG,P5,P4,P3" && r.body.more === true && r.body.max === 4);
  r = await call({ action: "getOrders", org: "rec", dateFrom: "", dateTo: "" });
  ok("under the cap: every order, and more is false", r.body.orders.length === 3 && r.body.more === false);
  r = await call({ action: "getOrdersAllShops", dateFrom: "", dateTo: "" });
  const shop = (id) => r.body.shops.find(s => s.orgId === id);
  ok("All shops: one cap over every shop together — the newest 4 of all (BIG, P5, P4 and REC's R2), and more is true",
    shop("prime").orders.map(o => o.orderId).join(",") === "BIG,P5,P4" && shop("rec").orders.map(o => o.orderId).join(",") === "R2" && r.body.more === true && r.body.max === 4);
  r = await call({ action: "getOrdersAllShops", dateFrom: daysAgo(4).slice(0, 10), dateTo: "" });
  ok("…under the cap: every order in the window, and more is false", r.body.more === false && shop("prime").orders.some(o => o.orderId === "BIG"));

  console.log("\n=== Design verifications: only for the orders the page shows ===");
  const verif = (token, orderId, days, status) => d1._raw.run(`INSERT INTO design_verifications (token, orgId, orderId, customerEmail, message, imagesJson, status, sentAt)
    VALUES (?, 'prime', ?, 'cust@example.com', 'A long proof message', '["https://images.example.com/uploads/verify/p.png"]', ?, ?)`, [token, orderId, status, daysAgo(days)]);
  verif("v-p3-old", "P3", 6, "pending"); verif("v-p3-new", "P3", 5, "revision"); verif("v-p1", "P1", 8, "approved");
  r = await call({ action: "listDesignVerifications", org: "prime", dateFrom: "", dateTo: "" });
  const vs = r.body.verifications;
  ok("the latest per order, for the newest-4 orders only (P1 is past the cap)", r.status === 200 && vs.length === 1 && vs[0].orderId === "P3" && vs[0].token === "v-p3-new" && vs[0].status === "revision");
  ok("…without the proof's pictures and message (the list shows status and dates)", !("imagesJson" in vs[0]) && !("message" in vs[0]) && !!vs[0].sentAt && "respondedAt" in vs[0]);
  r = await call({ action: "getOrdersAllShops", dateFrom: "", dateTo: "" });
  ok("All shops reads the proofs of the orders it loaded only (P3 is past the overall cap)", shop("prime").verifications.length === 0 && shop("rec").verifications.length === 0);
  r = await call({ action: "getOrdersAllShops", dateFrom: daysAgo(7.4).slice(0, 10), dateTo: daysAgo(6.8).slice(0, 10) });
  ok("…and the same latest proof as the shop's own list when P3 is loaded", shop("prime").orders.some(o => o.orderId === "P3") &&
    JSON.stringify(shop("prime").verifications) === JSON.stringify(vs));
  const from = daysAgo(3).slice(0, 10);
  r = await call({ action: "listDesignVerifications", org: "prime", dateFrom: from, dateTo: "" });
  ok("a date window that leaves P3 out leaves its verification out too", r.body.verifications.length === 0);
  ok("the Orders page sends its dates with the request", /action:"listDesignVerifications", org:org\.orgId, key:adminKey,\s*dateFrom:/.test(read("public/admin.js")));
  ok("the lookup by shop and order is indexed (migrations/0097)", /idx_verif_org_order_sent|idx_verif_order/.test(plan(`SELECT token FROM design_verifications v WHERE v.orgId = 'prime' AND v.orderId IN (SELECT o.orderId FROM orders o WHERE o.orgId = 'prime' ORDER BY o.placedAt DESC LIMIT 5)`)));

  console.log("\n=== The Orders page says when orders were left out (jsdom) ===");
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const dom = new JSDOM(storefrontPage(), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win){ win.fetch = async (u, init) => { const b = init && typeof init.body === "string" ? JSON.parse(init.body) : {}; const x = await call(b);
      return { ok: x.status < 400, status: x.status, json: async () => x.body, text: async () => JSON.stringify(x.body) }; }; } });
  const w = dom.window;
  await new Promise(x => setTimeout(x, 150));
  await w.loadAdminScript();
  w.eval('adminKey = "cookie"; adminOrgs = [{ orgId: "prime", name: "Example League" }, { orgId: "rec", name: "REC" }]; window._ordersFilter = { from: "", to: "" };');
  const rows = await w.fetchOrders("prime");
  ok("fetchOrders keeps the cut count for the shop", rows.length === 4 && w._ordersMore.prime === 4);
  ok("…and the note says so, asking for narrower dates", /newest 4 orders were loaded/.test(w.ordersMoreNote_(["prime"])) && /Narrow the date range/.test(w.ordersMoreNote_(["prime"])));
  await w.fetchOrders("rec");
  ok("no note for a shop that wasn't cut", w.ordersMoreNote_(["rec"]) === "");
  w.close();

  if (failed) { console.log("\n" + failed + " check(s) failed"); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
