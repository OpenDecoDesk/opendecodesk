// The operations timed at each step: the admin's own requests (the same bodies public/admin.js
// sends to /api/orders), grouped by what a person waits for.
//
//   cls          interactive | write | bulk | report | history
//   limitMs      the p95 an operation should stay under…
//   judgeUpTo    …at steps up to this many orders (beyond it the result is shown, not judged)
//   windowed     the answer covers a fixed window (last 30 days, open orders), so it should stay
//                about as fast while the history behind it grows
//   body(ctx, i) the request for call i (writes use a different order on each call)
//
// ctx (scale.js): { shops, today, d30, y1, m1, recentOrderId, oldOrderId, pool: { stage, pay, info }, doneIds }
const CLASSES = {
  interactive: { label: "Screens people wait on", limitMs: 1000, judgeUpTo: 25000 },
  write: { label: "Single changes", limitMs: 1000, judgeUpTo: 25000 },
  bulk: { label: "Bulk changes", limitMs: 10000, judgeUpTo: 25000 },
  report: { label: "Reports and exports", limitMs: 5000, judgeUpTo: 100000 },
  history: { label: "Whole history (no limit)", limitMs: null, judgeUpTo: 0 },
};

const take = (list, i, n = 1) => {
  const out = list.slice(i * n, i * n + n);
  if (out.length < n) throw new Error("work pool too small (" + list.length + " for call " + i + " × " + n + ")");
  return out;
};

const READS = [
  { name: "orders-30d", cls: "interactive", windowed: true, title: "Orders list, last 30 days (one shop)",
    body: (c) => ({ action: "getOrders", org: c.shops[0], dateFrom: c.d30, dateTo: c.today }) },
  { name: "orders-all-shops-30d", cls: "interactive", windowed: true, title: "Orders list, all shops, last 30 days",
    body: (c) => ({ action: "getOrdersAllShops", dateFrom: c.d30, dateTo: c.today }) },
  { name: "open-orders", cls: "interactive", windowed: true, title: "Open orders (admin home)",
    body: () => ({ action: "getOpenOrders" }) },
  { name: "production-queue", cls: "interactive", windowed: true, title: "Production queue",
    body: () => ({ action: "getProductionQueue" }) },
  { name: "blanks-to-order", cls: "interactive", windowed: true, title: "Blanks to order",
    body: () => ({ action: "getBlanksToOrder" }) },
  { name: "transfer-queue", cls: "interactive", windowed: true, title: "Transfer queue",
    body: () => ({ action: "getTransferQueue" }) },
  { name: "order-pdf-recent", cls: "interactive", windowed: true, title: "Order PDF, a recent order",
    body: (c) => ({ action: "getOrderPdf", org: c.recentOrg, orderId: c.recentOrderId }) },
  { name: "order-pdf-old", cls: "interactive", windowed: true, title: "Order PDF, an old order",
    body: (c) => ({ action: "getOrderPdf", org: c.oldOrg, orderId: c.oldOrderId }) },
  { name: "invoice-document", cls: "interactive", windowed: true, title: "Invoice document (desktop)",
    body: (c) => ({ action: "getInvoiceDocument", org: c.recentOrg, orderId: c.recentOrderId }) },
  { name: "audit-log-search", cls: "interactive", title: "Audit log, searched",
    body: () => ({ action: "getAuditLog", filter: "stage", limit: 200 }) },
  { name: "revenue-month", cls: "report", windowed: true, title: "Revenue report, one month (accrual)",
    body: (c) => ({ action: "getRevenueReport", dateFrom: c.d30, dateTo: c.today, basis: "accrual" }) },
  { name: "revenue-year", cls: "report", title: "Revenue report, one year (accrual)",
    body: (c) => ({ action: "getRevenueReport", dateFrom: c.y1, dateTo: c.today, basis: "accrual" }) },
  { name: "revenue-year-cash", cls: "report", title: "Revenue report, one year (cash)",
    body: (c) => ({ action: "getRevenueReport", dateFrom: c.y1, dateTo: c.today, basis: "cash" }) },
  { name: "sales-tax-year", cls: "report", title: "Sales tax report, one year",
    body: (c) => ({ action: "getSalesTaxReport", dateFrom: c.y1, dateTo: c.today }) },
  { name: "accountant-export-year", cls: "report", title: "Accountant export, one year",
    body: (c) => ({ action: "getAccountantExport", dateFrom: c.y1, dateTo: c.today }) },
  { name: "orders-full-history", cls: "history", title: "Orders list, whole history (one shop, dates cleared)",
    body: (c) => ({ action: "getOrders", org: c.shops[0], dateFrom: "", dateTo: "" }) },
  { name: "revenue-all-time", cls: "history", title: "Revenue report, all time",
    body: (c) => ({ action: "getRevenueReport", dateFrom: "1990-01-01", dateTo: c.today, basis: "accrual" }) },
];

// Writes act on the work pool scale.js clones in just for them (and throws away afterwards).
const WRITES = [
  { name: "create-local-sale", cls: "write", title: "New local sale (5 lines)",
    body: (c) => ({ action: "createLocalSale", org: c.shops[0], customerName: "Walk-in Sample", paymentMethod: "cash", paid: true,
      items: c.saleItems }) },
  { name: "add-payment", cls: "write", title: "Record a payment",
    body: (c, i) => ({ action: "addPayment", orderId: take(c.pool.pay, i)[0], amount: 1, method: "cash" }) },
  { name: "set-stage", cls: "write", title: "Mark one order's stage",
    body: (c, i) => { const [o] = take(c.pool.stage, i); return { action: "setFulfillmentStage", org: o.orgId, orderId: o.orderId, stage: "digitizingComplete" }; } },
  { name: "update-customer", cls: "write", title: "Edit customer info",
    body: (c, i) => { const [o] = take(c.pool.info, i); return { action: "updateCustomerInfo", org: o.orgId, orderIds: [o.orderId], contact: "updated" + i + "@example.com" }; } },
  { name: "bulk-stage-20", cls: "bulk", title: "Bulk mark stage, 20 orders (the most one request takes)",
    body: (c, i) => ({ action: "bulkSetFulfillmentStage", orderIds: take(c.pool.bulk, i, 20).map(o => o.orderId), stage: "digitizingComplete" }) },
  // The same 100 finished orders (the most one request takes), reopened and completed again in turn: both directions are real work.
  { name: "complete-100", cls: "bulk", title: "Mark 100 orders completed / reopened",
    body: (c, i) => ({ action: "setOrderCompleted", orderIds: c.doneIds.slice(0, 100), completed: i % 2 === 1 }) },
];

// What the operations act on, read from the database (a node:sqlite handle): the shops, the date
// windows, a recent and an old order to open, and up to 500 finished orders.
function makeContext(db, shops, now = Date.now()) {
  const DAY = 86400000;
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const recent = one("SELECT orderId, orgId FROM orders WHERE orgId = ? AND voidedAt IS NULL AND isTest = 0 AND completedAt IS NOT NULL ORDER BY placedAt DESC LIMIT 1", shops[0]);
  const old = one("SELECT orderId, orgId FROM orders WHERE orgId = ? AND voidedAt IS NULL AND isTest = 0 AND completedAt IS NOT NULL ORDER BY placedAt ASC LIMIT 1", shops[0]);
  return {
    shops, today: new Date(now).toISOString().slice(0, 10),
    d30: new Date(now - 30 * DAY).toISOString().slice(0, 10), y1: new Date(now - 365 * DAY).toISOString().slice(0, 10),
    recentOrderId: recent.orderId, recentOrg: recent.orgId, oldOrderId: old.orderId, oldOrg: old.orgId,
    doneIds: db.prepare("SELECT orderId FROM orders WHERE completedAt IS NOT NULL AND voidedAt IS NULL AND isTest = 0 ORDER BY placedAt DESC LIMIT 500").all().map(r => r.orderId),
    saleItems: [{ productId: "tee-0", size: "M", qty: 2 }, { productId: "hood-1", size: "L", qty: 1 }, { productId: "cap-2", size: "", qty: 3 },
      { productId: "patch-3", size: "", qty: 5 }, { productId: "tee-4", size: "S", qty: 1 }],
  };
}

// How many orders the work pool needs, for `calls` calls of each write (warm-up included).
const poolNeeds = (calls) => ({ pay: calls, stage: calls, info: calls, bulk: calls * 20 });

// The size of an answer: its orders (all shops' together, for getOrdersAllShops), else the longest
// list in it (lines, report rows), one level deep.
function rowsOf(body) {
  if (!body || typeof body !== "object") return 0;
  if (Array.isArray(body.orders)) return body.orders.length;
  const shops = Object.values(body).find(v => Array.isArray(v) && v.length && v.every(x => x && Array.isArray(x.orders)));
  if (shops) return shops.reduce((n, x) => n + x.orders.length, 0);
  let best = 0;
  for (const v of Object.values(body)) {
    if (Array.isArray(v)) best = Math.max(best, v.length);
    else if (v && typeof v === "object") for (const w of Object.values(v)) if (Array.isArray(w)) best = Math.max(best, w.length);
  }
  return best;
}

module.exports = { CLASSES, READS, WRITES, poolNeeds, rowsOf, makeContext };
