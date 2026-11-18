const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// Bookkeeping (2026-11): an order's revenue and its cost count on the same "sale date" (Global settings →
// Bookkeeping, global_settings 'accounting'). Default: when it ships, is delivered / picked up, or — with
// nothing to ship — is completed. Option: when it's placed. The sales tax report stays on the order date.
// Real SQL (sql.js) + real db.js and orders.js.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { insertOrder, getRevenueData, getCogsReport, getTransferCogs, getOrderCostsNotYetSold,
  getDashboardMoney, getAccountingSettings, getSaleDateBasis, getSalesTaxReport, saleDateSql_ };`)();
const T = (day) => day + "T12:00:00.000Z";
const from = (d) => d + "T00:00:00.000Z", to = (d) => d + "T23:59:59.999Z";

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('prime','prime','Example League','t','t');`);
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));

  // One blank at $10 (10 bought Sep 1) and one transfer at $0.50.
  d1._raw.run("INSERT INTO blanks (id, name, createdAt, updatedAt) VALUES (1, 'Polo', 't', 't')");
  d1._raw.run("INSERT INTO transfers (id, name, createdAt, updatedAt) VALUES (1, 'Logo', 't', 't')");
  const mv = (kind, qty, cents, day, orderId = null, reason = "") => d1._raw.run(
    "INSERT INTO inventory_movements (blankId, size, qtyDelta, unitCostCents, kind, reason, orderId, occurredAt, createdAt) VALUES (1, 'L', ?, ?, ?, ?, ?, ?, 't')",
    [qty, cents, kind, reason, orderId, T(day)]);
  const tmv = (kind, qty, cents, day, orderId = null) => d1._raw.run(
    "INSERT INTO transfer_movements (transferId, qtyDelta, unitCostCents, kind, orderId, occurredAt, createdAt) VALUES (1, ?, ?, ?, ?, ?, 't')",
    [qty, cents, kind, orderId, T(day)]);
  mv("purchase", 10, 1000, "2026-09-01");
  tmv("purchase", 10, 50, "2026-09-01");

  // Each order: one $30 item, no tax, no shipping.
  const add = (orderId, placed, dates = {}) => lib.insertOrder(d1, { orderId, orgId: "prime", customerName: "C " + orderId, contact: orderId.toLowerCase() + "@x.com",
    paymentMethod: "Venmo", placedAt: T(placed) }, [{ productId: "", name: "Polo", type: "shirt", size: "L", qty: 1, unitPrice: 30 }])
    .then(() => { for (const [k, v] of Object.entries(dates)) d1._raw.run(`UPDATE orders SET ${k} = ? WHERE orderId = ?`, [T(v), orderId]); });
  // A: placed Sep 20, made Oct 5 (a blank and a transfer), shipped Nov 3: sold in one month, made in another.
  await add("A", "2026-09-20", { manufacturedAt: "2026-10-05", shippedAt: "2026-11-03" }); mv("consume", -1, 1000, "2026-10-05", "A"); tmv("consume", -1, 50, "2026-10-05", "A");
  // B: placed, made and shipped in October.
  await add("B", "2026-10-10", { manufacturedAt: "2026-10-12", shippedAt: "2026-10-14" }); mv("consume", -1, 1000, "2026-10-12", "B");
  // C: placed and made in October, not shipped yet.
  await add("C", "2026-10-20", { manufacturedAt: "2026-10-25" }); mv("consume", -1, 1000, "2026-10-25", "C");
  // D: a pickup — never shipped, delivered (picked up) Nov 4.
  await add("D", "2026-11-01", { manufacturedAt: "2026-11-02", deliveredAt: "2026-11-04" }); mv("consume", -1, 1000, "2026-11-02", "D");
  // E: downloads only — nothing to make or ship, completed Nov 5.
  await add("E", "2026-11-05", { completedAt: "2026-11-05" });
  // A test write-off in October: an expense, never COGS, on its own date under either setting.
  mv("writeoff", -1, 1000, "2026-10-30", null, "testing");

  const money = async (basis, a, b) => {
    const [rev, cogs, t] = await Promise.all([lib.getRevenueData(d1, from(a), to(b), { basis }), lib.getCogsReport(d1, from(a), to(b), { basis }), lib.getTransferCogs(d1, from(a), to(b), { basis })]);
    const sum = (rows, k) => Math.round(rows.reduce((n, r) => n + (Number(r[k]) || 0) * 100, 0));
    return { orders: rev.map(r => r.orderId).sort().join(""), revenue: rev.reduce((n, r) => n + r.netSalesCents, 0), cogs: sum(cogs.rows, "cogs"),
      transfers: sum(t, "cogs"), writeoffs: sum(cogs.rows, "writeoffs"), basis: cogs.basis };
  };

  console.log("=== Setting ===");
  console.log("with nothing saved, a sale counts when it ships or is delivered:", (await lib.getSaleDateBasis(d1)) === "shipped");
  console.log("the shipped date is the one the index covers:", lib.saleDateSql_("shipped") === "COALESCE(o.shippedAt, o.deliveredAt, o.completedAt)"
    && /COALESCE\(shippedAt, deliveredAt, completedAt\)/.test(read("migrations/0088_sale_date_index.sql")));
  const plan = (sql) => d1._raw.exec("EXPLAIN QUERY PLAN " + sql).map(r => r.values.map(v => v.join(" ")).join("\n")).join("\n");
  console.log("a period's sales are found through idx_orders_sale_date:",
    /idx_orders_sale_date/.test(plan(`SELECT o.orderId FROM orders o WHERE COALESCE(o.shippedAt, o.deliveredAt, o.completedAt) >= '2026-10-01' AND COALESCE(o.shippedAt, o.deliveredAt, o.completedAt) <= '2026-10-31'`)));

  console.log("\n=== Shipped or delivered (default) ===");
  let oct = await money("shipped", "2026-10-01", "2026-10-31"), nov = await money("shipped", "2026-11-01", "2026-11-30"), sep = await money("shipped", "2026-09-01", "2026-09-30");
  console.log("October: only B shipped — its $30 and its $10 blank:", oct.orders === "B" && oct.revenue === 3000 && oct.cogs === 1000 && oct.transfers === 0 && oct.basis === "shipped");
  console.log("…A and C were made in October but haven't sold, so their blanks aren't October cost:", oct.cogs === 1000);
  console.log("November: A (shipped), D (picked up) and E (downloads, completed):", nov.orders === "ADE" && nov.revenue === 9000);
  console.log("…with A's and D's blanks and A's transfer:", nov.cogs === 2000 && nov.transfers === 50);
  console.log("September: nothing sold, nothing counted:", sep.orders === "" && sep.revenue === 0 && sep.cogs === 0);
  console.log("the write-off stays on its own date, as a write-off:", oct.writeoffs === 1000 && nov.writeoffs === 0);
  let nysSep = await lib.getOrderCostsNotYetSold(d1, to("2026-09-30"), { basis: "shipped" });
  let nysOct = await lib.getOrderCostsNotYetSold(d1, to("2026-10-31"), { basis: "shipped" });
  let nysNov = await lib.getOrderCostsNotYetSold(d1, to("2026-11-30"), { basis: "shipped" });
  console.log("made, not yet shipped: none at the end of September, A and C at the end of October, C at the end of November:",
    nysSep.blanksCents === 0 && nysOct.blanksCents === 2000 && nysNov.blanksCents === 1000 && nysOct.transfersCents === 50 && nysNov.transfersCents === 0);

  console.log("\n=== Order placed ===");
  oct = await money("placed", "2026-10-01", "2026-10-31"); nov = await money("placed", "2026-11-01", "2026-11-30"); sep = await money("placed", "2026-09-01", "2026-09-30");
  console.log("September: A was placed — its sale and its cost, though it was made in October:", sep.orders === "A" && sep.revenue === 3000 && sep.cogs === 1000 && sep.transfers === 50);
  console.log("October: B and C:", oct.orders === "BC" && oct.revenue === 6000 && oct.cogs === 2000 && oct.basis === "placed");
  console.log("November: D and E:", nov.orders === "DE" && nov.revenue === 6000 && nov.cogs === 1000);
  nysSep = await lib.getOrderCostsNotYetSold(d1, to("2026-09-30"), { basis: "placed" });
  console.log("at the end of September A counts as sold before it was made (a negative amount):", nysSep.blanksCents === -1000);

  console.log("\n=== The sales tax report stays on the order date ===");
  const tax = await lib.getSalesTaxReport(d1, from("2026-10-01"), to("2026-10-31"));
  console.log("October's taxable sales are B and C (placed in October), whatever the setting:", tax.reduce((n, r) => n + Math.round(r.netSales * 100), 0) === 6000);

  console.log("\n=== API (orders.js) ===");
  const api = new Function(
    strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
    "const requireAdmin = async (env, host) => host.kind === 'admin' ? null : jsonResponse({ status: 'error', message: 'Admin only' }, 403); const adminActor = () => 'test';\n" +
    "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
    "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
    "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
    dbSrc + "\n" + strip(read("functions/_lib/email.js")) + "\n" + strip(read("functions/_lib/deliveryCheck.js")) + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
  const call = async (body) => {
    const x = await api({ env: { DB: d1 }, waitUntil: () => {}, request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: x.status, body: JSON.parse(await x.text()) };
  };
  let r = await call({ action: "getAccountingSettings" });
  console.log("getAccountingSettings: shipped until changed:", r.status === 200 && r.body.accounting.saleDate === "shipped");
  r = await call({ action: "getInventoryReport", dateFrom: "2026-10-01", dateTo: "2026-10-31" });
  console.log("Inventory & COGS (shipped): October COGS is B's blank, and A's and C's show as made, not yet shipped:",
    r.status === 200 && r.body.saleDate === "shipped" && r.body.totals.cogs === 10 && r.body.notYetSold.beginning === 0 && r.body.notYetSold.ending === 20);
  console.log("…and the roll-forward still adds up to $0.00:", r.body.rollForward && Math.abs(r.body.rollForward.check) < 0.005);
  console.log("…transfer stock shows A's transfer as not yet sold:", r.body.transfers.notYetSold.ending === 0.5);
  r = await call({ action: "getRevenueReport", dateFrom: "2026-11-01", dateTo: "2026-11-30" });
  console.log("Revenue report (shipped): November's three orders, and it says which date it used:", r.status === 200 && r.body.total.orderCount === 3 && r.body.saleDate === "shipped");

  d1._raw.run("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('dashboardCache', '{}')");
  r = await call({ action: "updateAccountingSettings", saleDate: "sometime" });
  console.log("a choice other than shipped / placed is refused:", r.status === 400);
  r = await call({ action: "updateAccountingSettings", saleDate: "placed" });
  const cacheLeft = d1._raw.exec("SELECT COUNT(*) FROM global_settings WHERE key = 'dashboardCache'")[0].values[0][0];
  console.log("saving 'placed' is kept, and Home's saved figures are cleared so they follow at once:", r.status === 200 && r.body.accounting.saleDate === "placed"
    && (await lib.getSaleDateBasis(d1)) === "placed" && cacheLeft === 0);
  r = await call({ action: "getInventoryReport", dateFrom: "2026-10-01", dateTo: "2026-10-31" });
  console.log("Inventory & COGS (placed): October COGS is B's and C's blanks, and the roll-forward adds up:",
    r.body.saleDate === "placed" && r.body.totals.cogs === 20 && r.body.notYetSold.beginning === -10 && r.body.notYetSold.ending === 0 && Math.abs(r.body.rollForward.check) < 0.005);
  r = await call({ action: "getRevenueReport", dateFrom: "2026-10-01", dateTo: "2026-10-31" });
  console.log("Revenue report (placed): October's two orders:", r.body.total.orderCount === 2 && r.body.saleDate === "placed");
  const m = await lib.getDashboardMoney(d1, { yearFrom: "2026-01-01", monthFrom: "2026-11-01", to: "2026-11-30" });
  console.log("Home's money follows the setting and says which it used:", m.saleDate === "placed" && m.month.productRevenue === 60 && m.month.cogs === 10);
  const audit = d1._raw.exec("SELECT COUNT(*) FROM audit_log WHERE action = 'settings.accounting_set'");
  console.log("the change is in the audit log:", audit.length && audit[0].values[0][0] === 1);

  const src = read("functions/api/orders.js");
  const list = (name) => (src.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`)) || [])[1] || "";
  console.log("only an admin can read or change it:", /"updateAccountingSettings"/.test(list("ADMIN_ONLY_ACTIONS")) && /"getAccountingSettings"/.test(list("ADMIN_ONLY_ACTIONS")));
  console.log("…and it isn't behind a feature switch — Home and the reports use it whatever is switched on:", !/"getAccountingSettings"/.test((src.match(/const FEATURE_ACTIONS = \{([\s\S]*?)\n\};/) || [])[1] || "x"));
})().catch(e => { console.log("test193 crashed:", false); console.error(e); process.exit(1); });
