// What things cost stays with the "Money, costs and margins" permission (costs.view). A role without it gets the
// screens it may open with every cost left out by the server, and the page shows "—" where the amount would be:
// transfers and their history, a product's finished stock and its history, the products list, the order lists
// (each line's cost of goods, each payment's processor fee, the order's fees), cached blanks, Home's money, and
// the details of the audit log's money entries. Whoever edits on a screen still sees its costs there (Back office
// edits transfers and blanks), and so does the owner. Each answer is compared with the owner's for the same data.
//
// Everything here is this file's own: a role made for it ("Costs hidden …") with one user, a shop with three
// orders, a transfer, a blank and an expense (deleted again at the end). Nothing install-wide is changed.
import crypto from "node:crypto";
import { request as playwrightRequest } from "@playwright/test";
import { test, expect, ADMIN, openAdmin, uniq, slug, freshIp, apiContext, callApi, serveImages, watchCsp, waitIdle, signInThroughPage } from "../fixtures.mjs";
import { makeShop, placeOrder } from "../lib/data.mjs";

// ---- helpers ---------------------------------------------------------------------------------------------
const strongPassword = () => "Cost-" + crypto.randomBytes(15).toString("base64url");
// A request context that is a browser of its own: its own address, the admin's Origin, optionally a saved state.
const client = (storageState, workerIndex = 0) => playwrightRequest.newContext({ baseURL: ADMIN, storageState,
  extraHTTPHeaders: { Origin: ADMIN, "CF-Connecting-IP": freshIp(workerIndex) } });

// A user of `role` made by the owner, with the temporary password replaced as at a first sign-in. Returns
// { id, email, password }.
async function makeUser(owner, role, workerIndex) {
  const tag = slug("cv");
  const email = tag + "@example.test";
  const made = await callApi(owner, "create", { name: "Cora Costless " + tag.slice(-4), email, role }, { path: "/api/admin-users" });
  const c = await client(undefined, workerIndex);
  let r = await c.post("/api/admin-session", { data: { email, key: made.temporaryPassword } });
  expect((await r.json()).pending).toBe("password");
  const password = strongPassword();
  r = await c.post("/api/admin-password", { data: { action: "change", current: made.temporaryPassword, next: password } });
  expect((await r.json()).status).toBe("ok");
  await c.dispose();
  return { id: made.user.id, email, password };
}

// Every key at any depth of an answer.
const keysDeep = (v, out = new Set()) => {
  if (Array.isArray(v)) v.forEach(x => keysDeep(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.add(k); keysDeep(x, out); }
  return out;
};
const costKeys = (v, re) => [...keysDeep(v)].filter(k => re.test(k));
// The cost fields of each kind of answer (orders.js COST_FIELDS_).
const PRODUCT_COSTS = /^(transferCost|suppliesCost)(Cents)?$/;
const STOCK_COSTS = /^(cost|avgCost|value|unitCost)(Cents)?$/;
const PURCHASE_COSTS = /^(purchasePrice.*|unitCost|unitCostCents|cost|costCents)$/;
const BLANK_COSTS = /^(purchasePrice|vendorPrice|vendorPriceAt)$/;

// An order list without costs (orders.js orderCostsFor_): no processorFees on the order, no cogs / cogsSource on a
// line, no fee on a payment. Prices, payments and postage stay.
function expectOrdersWithoutCosts(orders, label) {
  expect(orders.length, label + ": some orders").toBeGreaterThan(0);
  for (const o of orders) {
    expect(o, label + " " + o.orderId).not.toHaveProperty("processorFees");
    for (const it of o.items || []) { expect(it, label + " line").not.toHaveProperty("cogs"); expect(it, label + " line").not.toHaveProperty("cogsSource"); }
    for (const p of o.payments || []) expect(p, label + " payment").not.toHaveProperty("fee");
  }
}
// …and the owner's, with them.
function expectOrdersWithCosts(orders, label) {
  expect(orders.length, label + ": some orders").toBeGreaterThan(0);
  for (const o of orders) {
    expect(o, label + " " + o.orderId).toHaveProperty("processorFees");
    for (const it of o.items || []) expect(it, label + " line").toHaveProperty("cogs");
    for (const p of o.payments || []) expect(p, label + " payment").toHaveProperty("fee");
  }
}

// A browser of the made user's, watched by the Content-Security-Policy check like every other context.
async function browserAs(browser, state, workerIndex, opened) {
  const context = await browser.newContext({ storageState: state, extraHTTPHeaders: { "CF-Connecting-IP": freshIp(workerIndex) } });
  await serveImages(context);
  opened.push({ context, refused: await watchCsp(context) });
  return context.newPage();
}
async function closeBrowsers(opened) {
  for (const c of opened) await c.context.close();
  expect(opened.flatMap(c => c.refused), "what the Content-Security-Policy refused on the made user's pages").toEqual([]);
}

// The page parts this file reads.
const transferRow = (page, name) => page.getByRole("row", { name: new RegExp("^" + name) });
const ordersPage = async (page, shop) => {
  await openAdmin(page, "orders/" + shop.orgId);
  await expect(page.getByRole("combobox", { name: "Shop" })).toHaveValue(shop.orgId);
};
const orderRow = (page, orderId) => page.locator(`tr[data-order="${orderId}"]`).first();
async function openTransferHistory(page, name) {
  await openAdmin(page, "transfers");
  await transferRow(page, name).getByRole("button", { name: "History" }).click();
  const dlg = page.getByRole("dialog", { name: "History — " + name });
  await expect(dlg).toBeVisible();
  return dlg;
}
async function openFinishedStock(page, shop, product) {
  await openAdmin(page, "catalog/orgs/" + shop.orgId + "/products");
  await page.getByTitle("Finished stock: pieces already decorated for this shop").first().click();
  const dlg = page.getByRole("dialog", { name: "Finished stock — " + product.name });
  await expect(dlg.locator("#fsBody tbody tr")).toHaveCount(1);
  await expect(dlg.locator("#fsHistory")).not.toContainText("Loading…");
  return dlg;
}
async function searchAudit(page, { orderId, action }) {
  await openAdmin(page, "audit");
  await page.locator("#afLimit").selectOption("200");
  if (orderId) await page.locator("#afOrder").fill(orderId);
  await page.locator("#afAction").fill(action);
  await page.getByRole("button", { name: "Search" }).click();
  await waitIdle(page);
  return page.locator("#auditResults");
}

// ---- the data: made once for this file ---------------------------------------------------------------------
// A role that may only LOOK at transfers, blank stock, products, orders and the audit log, without costs.view.
const ROLE_FNS = { "home.counts": "read", "inventory.transfers": "read", "inventory.blanks": "read", "catalog.products": "read",
  "reports.audit": "read", "orders.details": "read" };
const today = () => new Date().toLocaleDateString("en-CA");   // the local day, YYYY-MM-DD

const D = {};   // shop, product, orders, transfer, blank, expense, the made role and its user

test.beforeAll(async ({ browser }, testInfo) => {
  testInfo.setTimeout(180_000);
  const owner = await apiContext("owner", testInfo.workerIndex);
  const api = (action, body, opts) => callApi(owner, action, body, opts);
  try {
    // The role and its user.
    D.roleName = "Costs hidden " + slug("r").slice(-6);
    const saved = await api("saveRole", { name: D.roleName, rank: 10, permissions: { fns: ROLE_FNS } }, { path: "/api/admin-users" });
    D.roleKey = saved.role.key;
    D.user = await makeUser(owner, D.roleKey, testInfo.workerIndex);

    // A shop whose product has a transfer and a supplies cost.
    D.shop = await makeShop(api, { prefix: "costs", products: [{ name: uniq("Sample Cost Tee"), price: 20, extra: { transferCost: 1.5, suppliesCost: 0.75 } }] });
    D.product = D.shop.products[0];

    // A transfer: one whole sheet of 10 for $25 → $2.50 each.
    D.transferName = uniq("Example Club Crest Transfer");
    D.transferId = (await api("saveTransfer", { transfer: { name: D.transferName } })).id;
    await api("receiveTransferSheet", { rows: [{ transferId: D.transferId, count: 10, pctOfSheet: 100 }], total: 25, receivedAt: today(),
      vendor: "", vendorRef: "", paidPersonally: true });

    // A blank at $4.50 linked to the product, and two pieces made for stock from it: finished stock at $4.50 each.
    D.blankName = uniq("Sample Cost Blank");
    D.blankId = (await api("createBlank", { name: D.blankName, brand: "Test Blank Co", productType: "Tee",
      colors: [{ color: "Navy", sizes: [{ size: "M", quantity: 5, purchasePrice: 4.5, vendorPrice: 4.5 }] }] })).id;
    await api("setBlankLink", { org: D.shop.orgId, productId: D.product.productId, productColor: "", productSize: "", blankId: D.blankId, blankColor: "Navy", blankSize: "M" });
    await api("makeForStock", { org: D.shop.orgId, productId: D.product.productId, size: "", qty: 2 });
    const made = await api("getReadyToShip", { org: D.shop.orgId, productId: D.product.productId });
    expect(made.finished.sizes[0]).toMatchObject({ onHand: 2, avgCost: 4.5 });

    // Three orders placed on the shop's page: A marked paid, B paid $20 cash through Payments, C left unpaid.
    // A signed-out browser (not the owner's saved one): the shop's customer, then the made user.
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, extraHTTPHeaders: { "CF-Connecting-IP": freshIp(testInfo.workerIndex) } });
    await serveImages(context);
    const refused = await watchCsp(context);
    const page = await context.newPage();
    // (Each order sets aside one of the finished pieces; their average cost and value don't change.)
    D.orderA = await placeOrder(page, D.shop, { customer: uniq("Casey Customer") });
    D.orderB = await placeOrder(page, D.shop, { customer: uniq("Casey Customer") });
    D.orderC = await placeOrder(page, D.shop, { customer: uniq("Casey Customer") });
    // The made user signs in through the page once; their browsers and API client below reuse that session.
    await page.goto(ADMIN + "/");
    await signInThroughPage(page, D.user);
    await expect(page.getByRole("navigation", { name: "Admin" })).toBeVisible();
    D.user.state = await context.storageState();
    await context.close();
    expect(refused, "what the Content-Security-Policy refused on the shop's and the made user's pages").toEqual([]);
    await api("markPaidManual", { org: D.shop.orgId, orderId: D.orderA.orderId, requestId: slug("pay") });
    await api("addPayment", { org: D.shop.orgId, orderId: D.orderB.orderId, amount: 20, method: "cash", note: "", requestId: slug("pay") });

    // An expense (Expenses → Save expense's request), for the audit log's expense entry. Deleted in afterAll.
    const { categories } = await api("listExpenseCategories");
    const { accounts } = await api("listAccounts");
    D.expenseDesc = uniq("Thread cones from Test Thread Co");
    D.expenseId = (await api("saveExpense", { expense: { date: today(), description: D.expenseDesc, categoryId: categories.find(c => c.name === "Office expense").id,
      amount: 1.23, vendor: "", businessUsePct: 100, vendorChargedTax: true, accountId: accounts.find(a => a.name === "Business checking").id } })).expense.id;
  } finally {
    await owner.dispose();
  }
});

test.afterAll(async ({}, testInfo) => {
  if (!D.expenseId) return;
  const owner = await apiContext("owner", testInfo.workerIndex);
  await callApi(owner, "deleteExpense", { expenseId: D.expenseId }, { allowError: true });
  await owner.dispose();
});

// ---- a custom role without costs.view ------------------------------------------------------------------------
test("a role without costs.view sees transfers, finished stock and the audit log without what things cost", async ({ page, browser }, testInfo) => {
  const opened = [];
  const theirs = await browserAs(browser, D.user.state, testInfo.workerIndex, opened);
  try {
    // Transfers: the owner's row says $2.50 each; theirs says — , with none of the buttons that change stock.
    await openAdmin(page, "transfers");
    await expect(transferRow(page, D.transferName)).toContainText(D.transferName + " 10 $2.50");
    await openAdmin(theirs, "transfers");
    const row = transferRow(theirs, D.transferName);
    await expect(row).toContainText(D.transferName + " 10 —");
    await expect(row).not.toContainText("$");
    for (const name of ["+ New transfer", "Receive sheet", "Count stock…"]) await expect(theirs.getByRole("button", { name })).toBeHidden();
    // …and its History: the purchase's unit cost is $2.50 for the owner, — for them.
    const ownerHist = await openTransferHistory(page, D.transferName);
    await expect(ownerHist.getByRole("row", { name: /purchase 10 \$2\.50/ })).toBeVisible();
    const hist = await openTransferHistory(theirs, D.transferName);
    await expect(hist.getByRole("row", { name: /purchase 10 —/ })).toBeVisible();
    await expect(hist.locator("tbody")).not.toContainText("$");

    // A product's finished stock: average cost, value, the blank's cost and the history's unit cost are amounts for
    // the owner, — for them, and they get no Correct count (that is Full on Blanks).
    const ownerStock = await openFinishedStock(page, D.shop, D.product);
    const ownerRow = ownerStock.locator("#fsBody tbody tr");
    await expect(ownerRow).toContainText("$4.50");
    await expect(ownerStock.locator("#fsHistory")).toContainText("$4.50");
    await expect(ownerStock.getByRole("button", { name: "Correct count" })).toBeVisible();
    const stock = await openFinishedStock(theirs, D.shop, D.product);
    const stockRow = stock.locator("#fsBody tbody tr");
    await expect(stockRow).not.toContainText("$");
    // Avg cost and Value are the 5th and 6th cells (Size, On hand, Set aside, Available, Avg cost, Value, Made from).
    await expect(stockRow.locator("td").nth(4)).toHaveText("—");
    await expect(stockRow.locator("td").nth(5)).toHaveText("—");
    await expect(stockRow.locator("td").nth(6)).toContainText("— each");
    await expect(stock.locator("#fsHistory")).toContainText("—");
    await expect(stock.locator("#fsHistory")).not.toContainText("$");
    await expect(stock.getByRole("button", { name: "Correct count" })).toBeHidden();

    // The audit log: the payment on order B is listed for them too, without its amount.
    const ownerAudit = await searchAudit(page, { orderId: D.orderB.orderId, action: "payment.added" });
    await expect(ownerAudit.locator("tbody tr", { hasText: "Payment added" })).toContainText("$20.00");
    const audit = await searchAudit(theirs, { orderId: D.orderB.orderId, action: "payment.added" });
    const payRow = audit.locator("tbody tr", { hasText: "Payment added" });
    await expect(payRow).toHaveCount(1);
    await expect(payRow).toContainText(D.orderB.orderId);
    await expect(payRow).not.toContainText("$");
  } finally {
    await closeBrowsers(opened);
  }
});

test("a role without costs.view gets products, stock, transfers, orders, Home and audit details from the API without costs", async ({}, testInfo) => {
  const owner = await apiContext("owner", testInfo.workerIndex);
  const theirs = await client(D.user.state, testInfo.workerIndex);
  try {
    const both = async (action, body = {}) => [await callApi(owner, action, body), await callApi(theirs, action, body)];

    // Products: the transfer and supplies cost.
    const [op, tp] = await both("listProducts", { org: D.shop.orgId });
    const mine = (list) => list.find(p => p.productId === D.product.productId);
    expect(mine(op.products)).toMatchObject({ transferCost: 1.5, suppliesCost: 0.75 });
    expect(mine(tp.products).name).toBe(D.product.name);
    expect(costKeys(tp.products, PRODUCT_COSTS)).toEqual([]);

    // Transfers and their history: the purchase price and unit cost (the count stays).
    const [ot, tt] = await both("listTransfers");
    const t = (list) => list.find(x => x.id === D.transferId);
    expect(t(ot.transfers)).toMatchObject({ quantity: 10, purchasePrice: 2.5 });
    expect(t(tt.transfers).quantity).toBe(10);
    expect(costKeys(tt.transfers, PURCHASE_COSTS)).toEqual([]);
    const [om, tm] = await both("getTransferMovements", { transferId: D.transferId });
    expect(om.movements.find(m => m.kind === "purchase")).toMatchObject({ qtyDelta: 10, unitCost: 2.5 });
    expect(tm.movements.find(m => m.kind === "purchase").qtyDelta).toBe(10);
    expect(costKeys(tm.movements, PURCHASE_COSTS)).toEqual([]);

    // Blank stock (the older inventory list): the purchase price.
    const [, ti] = await both("getInventory");
    expect(costKeys(ti.items, PURCHASE_COSTS)).toEqual([]);

    // Finished stock and its history: average cost, value and unit cost — the blank's average cost too.
    const [or, tr] = await both("getReadyToShip", { org: D.shop.orgId, productId: D.product.productId });
    expect(or.finished.sizes[0].avgCost).toBe(4.5);
    expect(or.finished.sizes[0].blank.avgCost).toBe(4.5);
    expect(costKeys(or.finished, STOCK_COSTS).sort()).toEqual(["avgCost", "value"]);
    expect(tr.finished.sizes[0].onHand).toBe(or.finished.sizes[0].onHand);
    expect(costKeys(tr.finished, STOCK_COSTS)).toEqual([]);
    const [of, tf] = await both("getFinishedGoodsMovements", { org: D.shop.orgId, productId: D.product.productId });
    expect(of.movements.find(m => m.kind === "make")).toMatchObject({ qtyDelta: 2, unitCost: 4.5 });
    expect(tf.movements.find(m => m.kind === "make").qtyDelta).toBe(2);
    expect(costKeys(tf.movements, STOCK_COSTS)).toEqual([]);

    // The shop's orders, and the same orders asked for by id (as the Orders page does after an action): no cost of
    // goods, processor fees or payment fees. Prices and payments are there.
    const ids = [D.orderA.orderId, D.orderB.orderId, D.orderC.orderId];
    const [oo, to] = await both("getOrders", { org: D.shop.orgId });
    expectOrdersWithCosts(oo.orders, "owner getOrders");
    expectOrdersWithoutCosts(to.orders, "getOrders");
    expect(to.orders.map(o => o.orderId).sort()).toEqual([...ids].sort());
    const paidB = to.orders.find(o => o.orderId === D.orderB.orderId);
    expect(paidB.payments.map(p => p.amount)).toEqual([20]);
    expect(paidB.total).toBe(20);
    const [ob, tb] = await both("getOrdersByIds", { org: D.shop.orgId, orderIds: ids });
    expectOrdersWithCosts(ob.orders, "owner getOrdersByIds");
    expectOrdersWithoutCosts(tb.orders, "getOrdersByIds");
    expect(tb.orders).toHaveLength(3);

    // Home: the order counts only, none of the business's money.
    const [od, td] = await both("getDashboard", { today: today() });
    expect(Object.keys(od).length).toBeGreaterThan(Object.keys(td).length);
    for (const k of Object.keys(td)) expect(["status", "stages", "open", "onTheWay", "blocks", "cachedAt", "cached"]).toContain(k);

    // The audit log keeps the money entries' rows, not their details: the payment on order B, and the expense.
    const [oa, ta] = await both("getAuditLog", { orderId: D.orderB.orderId, filter: "payment.added", limit: 50 });
    expect(oa.entries).toHaveLength(1);
    expect(oa.entries[0].detail).toMatchObject({ amount: 20, method: "cash" });
    expect(ta.entries).toHaveLength(1);
    expect(ta.entries[0]).toMatchObject({ id: oa.entries[0].id, action: "payment.added", orderId: D.orderB.orderId, detail: null });
    const [oe, te] = await both("getAuditLog", { filter: "expense.created", limit: 200 });
    const exp = oe.entries.find(e => e.detail && e.detail.description === D.expenseDesc);
    expect(exp.detail.amount).toBe(1.23);
    const theirExp = te.entries.find(e => e.id === exp.id);
    expect(theirExp).toMatchObject({ action: "expense.created", detail: null });
    // An entry that isn't money keeps its detail: the transfer this file made.
    const [, tx] = await both("getAuditLog", { filter: "transfer.created", limit: 200 });
    expect(tx.entries.some(e => e.detail && e.detail.name === D.transferName)).toBe(true);
    // What stock cost keeps its row, not its detail (2026-11-24): the transfer sheet received and the pieces made for stock.
    const [orc, trc] = await both("getAuditLog", { filter: "transfer.received", limit: 200 });
    const rec = orc.entries.find(e => e.detail && (e.detail.rows || []).some(r => Number(r.transferId) === D.transferId));
    expect(rec.detail.total).toBe(25);
    expect(trc.entries.find(e => e.id === rec.id)).toMatchObject({ action: "transfer.received", detail: null });
    const [omk, tmk] = await both("getAuditLog", { filter: "inventory.made_for_stock", limit: 200 });
    const made = omk.entries.find(e => e.detail && e.detail.productId === D.product.productId);
    expect(typeof made.detail.unitCost).toBe("number");
    expect(tmk.entries.find(e => e.id === made.id)).toMatchObject({ action: "inventory.made_for_stock", detail: null });
  } finally {
    await owner.dispose();
    await theirs.dispose();
  }
});

// Review #22's rule is "a role that can only LOOK at a screen gets it without costs", and the owner's decision
// (2026-11-23) is that Read on Blanks is stock and details only. The Blanks list (getBlanks, orders.js blankCostsFor_)
// used to keep the purchase and vendor price for any role with Blanks at Read; now only costs.view or Edit on Blanks
// gets them, and the Blanks page shows this role no money at all.
test("a role that only looks at Blanks gets them without costs, and the Blanks page shows it no money", async ({ browser }, testInfo) => {
  const theirs = await client(D.user.state, testInfo.workerIndex);
  const opened = [];
  try {
    const b = (await callApi(theirs, "getBlanks")).blanks.find(x => x.id === D.blankId);
    expect(b.name).toBe(D.blankName);
    expect(costKeys(b, BLANK_COSTS)).toEqual([]);
    const page = await browserAs(browser, D.user.state, testInfo.workerIndex, opened);
    await openAdmin(page, "inventory");
    await page.getByRole("searchbox", { name: /Search name, vendor/ }).fill(D.blankName);
    await expect(page.getByRole("row", { name: new RegExp(D.blankName) })).not.toContainText("$");
    // Read only: none of the toolbar's controls that lead to a change (2026-11-24: Import, Connected vendor and More too).
    for (const name of ["+ New blank", "Receive order", "Count stock…", "Import", "Connected vendor", "More"])
      await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "History", exact: true }).first()).toBeVisible();
  } finally {
    await theirs.dispose();
    await closeBrowsers(opened);
  }
});

// The same rule for what a blank or transfer was bought at (review round 2): a received blank's history carried its
// vendor receipt and a note naming the landed cost ("Received (landed cost incl. $2.50 shipping & other costs)"), and
// /api/receipt opened that invoice for Read on Blanks. Now this role sees the movement as "Received", with no Receipt
// button, and gets no link; a transfer sheet and Use transfers for past orders come without their money too.
test("a role that only looks at Blanks or Transfers gets no receipt, landed cost or sheet money", async ({ browser }, testInfo) => {
  const owner = await apiContext("owner", testInfo.workerIndex);
  const theirs = await client(D.user.state, testInfo.workerIndex);
  const opened = [];
  try {
    const api = (action, body, opts) => callApi(owner, action, body, opts);
    // The owner attaches the vendor's invoice to a blank order with $2.50 of shipping (Blanks → Receive order).
    const PDF = Buffer.from("%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n", "latin1");
    const res = await owner.post("/api/receipt?name=" + encodeURIComponent("blank-invoice.pdf"), { headers: { "Content-Type": "application/pdf" }, data: PDF });
    const up = await res.json();
    expect(res.ok(), JSON.stringify(up)).toBe(true);
    const blankName = uniq("Sample Receipt Blank");
    const blankId = (await api("createBlank", { name: blankName, brand: "Test Blank Co", productType: "Tee",
      colors: [{ color: "Navy", sizes: [{ size: "M", quantity: 0, purchasePrice: 0 }] }] })).id;
    await api("receiveBlankOrder", { requestId: slug("receive"), receivedAt: today(), paidPersonally: true, vendorRef: "INV-RCPT-1", extraCost: 2.5,
      receiptKey: up.key, receiptName: "blank-invoice.pdf", groups: [{ blankId, lines: [{ color: "Navy", size: "M", qty: 4, unitCost: 5 }] }] });
    const ownerMove = (await api("getBlankMovements", { blankId })).movements.find(m => m.vendorRef === "INV-RCPT-1");
    expect(ownerMove).toMatchObject({ receiptKey: up.key, note: "Received (landed cost incl. $2.50 shipping & other costs)" });

    // Their answer: the movements (landed cost can split a size in two, a cent apart) and their count, without the
    // receipt or the landed cost.
    const theirMoves = (await callApi(theirs, "getBlankMovements", { blankId })).movements.filter(m => m.vendorRef === "INV-RCPT-1");
    expect(theirMoves.reduce((n, m) => n + m.qtyDelta, 0)).toBe(4);
    for (const m of theirMoves) expect(m.note).toBe("Received");
    expect(costKeys(theirMoves, /^(receiptKey|receiptName|unitCost)$/)).toEqual([]);
    // …and the receipt itself is refused to them.
    const link = await theirs.post("/api/receipt", { data: { key: up.key } });
    expect(link.status(), "Read on Blanks alone gets no receipt link").toBe(403);

    // The page: Blanks → History shows "Received", no Receipt button and no dollar amount.
    const page = await browserAs(browser, D.user.state, testInfo.workerIndex, opened);
    await openAdmin(page, "inventory");
    await page.getByRole("searchbox", { name: /Search name, vendor/ }).fill(blankName);
    await page.getByRole("row", { name: new RegExp(blankName) }).getByRole("button", { name: "History" }).click();
    const hist = page.getByRole("dialog", { name: "Stock history — " + blankName });
    const row = hist.getByRole("row", { name: /Navy · M Received \+\d/ }).first();
    await expect(row).toBeVisible();
    await expect(row).toContainText("INV-RCPT-1");
    await expect(hist.getByRole("button", { name: /Receipt/ })).toHaveCount(0);
    await expect(hist.locator("#histBody")).not.toContainText("$");
    await expect(hist.locator("#histBody")).not.toContainText("landed cost");

    // A transfer sheet (Open sheet reads it) and Use transfers for past orders: the owner's have their amounts, theirs don't.
    const purchase = (await api("getTransferMovements", { transferId: D.transferId })).movements.find(m => m.kind === "purchase");
    const ownerSheet = (await api("getTransferSheet", { movementId: purchase.id })).sheet;
    expect(ownerSheet).toMatchObject({ total: 25 });
    expect(ownerSheet.rows[0]).toMatchObject({ count: 10, amount: 25, perItem: 2.5 });
    const theirSheet = (await callApi(theirs, "getTransferSheet", { movementId: purchase.id })).sheet;
    expect(theirSheet.rows[0]).toMatchObject({ transferId: D.transferId, count: 10, pctOfSheet: 100 });
    expect(costKeys(theirSheet, /^(total|totalCents|stockCents|amount|perItem|cents|receiptKey|receiptName)$/)).toEqual([]);
    const ownerCatchUp = await api("previewTransferCatchUp");
    expect(ownerCatchUp).toHaveProperty("total");
    expect(ownerCatchUp).toHaveProperty("recostTotal");
    const theirCatchUp = await callApi(theirs, "previewTransferCatchUp");
    expect(theirCatchUp.totalUnits).toBe(ownerCatchUp.totalUnits);
    expect(costKeys(theirCatchUp, /^(unitCost|cost|total|recostTotal)(Cents)?$/)).toEqual([]);
  } finally {
    await owner.dispose();
    await theirs.dispose();
    await closeBrowsers(opened);
  }
});

// D1 counts the rows a statement's triggers change in meta.changes too: the blank_sizes UPDATE reads 2 (its row and
// the list-cache trigger's, lcv_blank_sizes_upd). Make for stock once took that as a lost race and answered 409
// "Those blanks were just used by something else" after making the pieces (a retry made them twice). It must say ok.
test("Make for stock answers ok when it made the pieces", async ({ api }) => {
  const shop = await makeShop(api, { prefix: "costmk", products: [{ name: uniq("Sample Stock Tee"), price: 20 }] });
  const product = shop.products[0];
  const blankId = (await api("createBlank", { name: uniq("Sample Stock Blank"), brand: "Test Blank Co", productType: "Tee",
    colors: [{ color: "Navy", sizes: [{ size: "M", quantity: 3, purchasePrice: 4, vendorPrice: 4 }] }] })).id;
  await api("setBlankLink", { org: shop.orgId, productId: product.productId, productColor: "", productSize: "", blankId, blankColor: "Navy", blankSize: "M" });
  const r = await api("makeForStock", { org: shop.orgId, productId: product.productId, size: "", qty: 1 }, { allowError: true, withStatus: true });
  // It was made: one piece in finished stock, one blank fewer.
  expect((await api("getReadyToShip", { org: shop.orgId, productId: product.productId })).finished.sizes[0].onHand).toBe(1);
  expect((await api("getBlanks")).blanks.find(b => b.id === blankId).colors[0].sizes[0].quantity).toBe(2);
  // …and the answer should say so.
  expect(r.status, JSON.stringify(r.data)).toBe(200);
});

// ---- the built-in roles ----------------------------------------------------------------------------------------
test("Production gets blanks and orders without costs; the owner gets them with", async ({}, testInfo) => {
  const owner = await apiContext("owner", testInfo.workerIndex);
  const prod = await apiContext("production", testInfo.workerIndex);
  try {
    // Blanks (Run Order and the blanks step read them): no purchase or vendor price without Blanks or costs.view.
    const blankOf = async (ctx) => (await callApi(ctx, "getBlanks")).blanks.find(x => x.id === D.blankId);
    const ob = await blankOf(owner), pb = await blankOf(prod);
    expect(costKeys(ob, BLANK_COSTS)).toEqual(expect.arrayContaining(["purchasePrice", "vendorPrice"]));
    expect(pb.name).toBe(D.blankName);
    expect(pb.colors[0].sizes[0].quantity).toBe(ob.colors[0].sizes[0].quantity);
    expect(costKeys(pb, BLANK_COSTS)).toEqual([]);

    // The shop's orders, and Home's open orders.
    expectOrdersWithCosts((await callApi(owner, "getOrders", { org: D.shop.orgId })).orders, "owner getOrders");
    expectOrdersWithoutCosts((await callApi(prod, "getOrders", { org: D.shop.orgId })).orders, "production getOrders");
    expectOrdersWithCosts((await callApi(owner, "getOpenOrders")).orders, "owner getOpenOrders");
    expectOrdersWithoutCosts((await callApi(prod, "getOpenOrders")).orders, "production getOpenOrders");
  } finally {
    await owner.dispose();
    await prod.dispose();
  }
});

test("Back office gets every shop's orders without costs, but still sees transfer, blank and product costs it edits", async ({ as }, testInfo) => {
  const owner = await apiContext("owner", testInfo.workerIndex);
  const staff = await apiContext("staff", testInfo.workerIndex);
  try {
    // All shops: none of the orders carries a cost of goods, a processor fee or a payment fee — this shop's included.
    const all = await callApi(staff, "getOrdersAllShops");
    const orders = all.shops.flatMap(s => s.orders);
    expect(orders.map(o => o.orderId)).toEqual(expect.arrayContaining([D.orderA.orderId, D.orderB.orderId]));
    expectOrdersWithoutCosts(orders, "staff getOrdersAllShops");
    expectOrdersWithCosts((await callApi(owner, "getOrdersAllShops")).shops.find(s => s.orgId === D.shop.orgId).orders, "owner getOrdersAllShops");
    // The order an edit of its dates answers with (Edit dates; nothing changed here) is without them too.
    const dated = await callApi(staff, "setOrderDates", { orderId: D.orderB.orderId, dates: {} });
    expectOrdersWithoutCosts([dated.order], "staff setOrderDates");
    expect(dated.order.payments.map(p => p.amount)).toEqual([20]);

    // Back office edits transfers, blanks and products, so their costs stay.
    expect((await callApi(staff, "listTransfers")).transfers.find(x => x.id === D.transferId).purchasePrice).toBe(2.5);
    expect((await callApi(staff, "getTransferMovements", { transferId: D.transferId })).movements.find(m => m.kind === "purchase").unitCost).toBe(2.5);
    expect((await callApi(staff, "getBlanks")).blanks.find(x => x.id === D.blankId).colors[0].sizes[0].purchasePrice).toBe(4.5);
    expect((await callApi(staff, "listProducts", { org: D.shop.orgId })).products.find(p => p.productId === D.product.productId).transferCost).toBe(1.5);

    // In the page: the Transfers row shows $2.50 as for the owner.
    const sp = await as("staff");
    await openAdmin(sp, "transfers");
    await expect(transferRow(sp, D.transferName)).toContainText(D.transferName + " 10 $2.50");

    // Mark as paid on order C redraws that order from getOrdersByIds, whose answer has no costs.
    await ordersPage(sp, D.shop);
    const cell = orderRow(sp, D.orderC.orderId).locator("td[data-action-td]");
    await cell.getByRole("button", { name: "Mark as paid" }).click();
    const answer = sp.waitForResponse(r => r.url().endsWith("/api/orders") && /"action":"getOrdersByIds"/.test(r.request().postData() || ""));
    const ok = sp.locator(".confirm-modal #cmOk");
    await expect(ok).toBeVisible();
    await ok.click();
    const body = await (await answer).json();
    expect(body.orders.map(o => o.orderId)).toEqual([D.orderC.orderId]);
    expectOrdersWithoutCosts(body.orders, "staff getOrdersByIds after Mark as paid");
    expect(body.orders[0].payments.length).toBeGreaterThan(0);
    await expect(orderRow(sp, D.orderC.orderId)).toContainText(/\bPaid\b/);
    // The owner's answer for the same order has them.
    expectOrdersWithCosts((await callApi(owner, "getOrdersByIds", { org: D.shop.orgId, orderIds: [D.orderC.orderId] })).orders, "owner getOrdersByIds");
  } finally {
    await owner.dispose();
    await staff.dispose();
  }
});
