// Orders rows redrawn in place (review #62, fa3f6f0): an action on one order changes that order's rows and nothing
// else. The page asks the server for that order alone (getOrdersByIds, public/admin.js refreshOrderRows_ →
// replaceOrderRows_), or uses what it already knows (a money action's reply, a void), and never reloads the whole list
// (getOrders). What it promises around that:
//   - a discount that settles an order shows it Paid at once (the reply carries the paid state, orders.js paidState_);
//   - the ticked orders stay ticked and the bulk bar keeps its count; the totals under the list follow;
//   - getOrdersByIds answers only the named shop's orders, and at most 100 ids (orders.js ORDERS_BY_IDS_MAX);
//   - a stage step, Edit items, cancelling a line and a Local sale each ask for that one order, and a Local sale's
//     new order goes in at its place (the newest, first); on All shops the same holds.
//
// Every /api/orders POST the page sends is recorded (page.on("request")) and the actions read from its body. Every
// test makes its own shops and orders and only looks at those: other specs use the same install at the same time.
import crypto from "node:crypto";
import { test, expect, openAdmin, toast, uniq, user, ADMIN, waitIdle } from "../fixtures.mjs";
import { makeShop } from "../lib/data.mjs";

// ---- helpers ---------------------------------------------------------------------------------------------
// The shop's Orders page, as a real page load.
const ordersPage = async (page, shop) => {
  if (page.url().startsWith(ADMIN)) await page.goto("about:blank");
  await openAdmin(page, "orders/" + shop.orgId);
  await expect(page.getByRole("combobox", { name: "Shop" })).toHaveValue(shop.orgId);
};
const orderRow = (page, orderId) => page.locator(`tr[data-order="${orderId}"]`).first();
const actionCell = (page, orderId) => orderRow(page, orderId).locator("td[data-action-td]");
const stageSelect = (page, orderId) => actionCell(page, orderId).locator("select");
const stageCell = (page, orderId, field) => orderRow(page, orderId).locator(`td[data-stage-td="${field}"]`);
const tickBox = (page, orderId) => page.getByRole("checkbox", { name: "Select order " + orderId });
const confirmOk = async (page) => {
  const ok = page.locator(".confirm-modal #cmOk");
  await expect(ok).toBeVisible();
  await ok.click();
  await expect(page.locator(".confirm-modal")).toHaveCount(0);
};

// A key the way the admin page makes one (newRequestId_).
const requestId = () => crypto.randomUUID().replace(/-/g, "");
// An unpaid order on the shop, made quickly through the owner's API (a Local sale left unpaid). `items` by
// product index: [[0, 1], [1, 1]] = one of the first product and one of the second.
const unpaidOrder = async (api, shop, { items = [[0, 1]], customer } = {}) => (await api("createLocalSale", {
  org: shop.orgId, requestId: requestId(), paymentMethod: "Check", customerName: customer || uniq("Uma Unpaid"),
  items: items.map(([i, qty]) => ({ productId: shop.products[i].productId, qty })),
})).orderId;
const twoProductShop = (api, prefix) => makeShop(api, { prefix, products: [{ name: "Sample Tee", price: 20 }, { name: "Sample Cap", price: 15, type: "cap", idPrefix: "cap" }] });

// Every /api/orders POST the page sends from now on: { action, org, orderIds }.
const recordOrders = (page) => {
  const sent = [];
  page.on("request", (req) => {
    if (req.method() !== "POST" || !/\/api\/orders(\?|$)/.test(req.url())) return;
    try { const b = JSON.parse(req.postData() || "{}"); sent.push({ action: b.action, org: b.org, orderIds: b.orderIds }); } catch (e) { /* not JSON */ }
  });
  return sent;
};
const actionsOf = (sent) => sent.map(s => s.action);
// After an action: its getOrdersByIds asked for this one order of this shop, and nothing reloaded the list.
const askedForOnly = async (page, sent, shop, orderId) => {
  await expect.poll(() => actionsOf(sent)).toContain("getOrdersByIds");
  await waitIdle(page);
  const byIds = sent.filter(s => s.action === "getOrdersByIds");
  expect(byIds, "getOrdersByIds requests").toEqual([{ action: "getOrdersByIds", org: shop.orgId, orderIds: [orderId] }]);
  expect(actionsOf(sent)).not.toContain("getOrders");
  expect(actionsOf(sent)).not.toContain("getOrdersAllShops");
};
// A mark on an order's first row element: a row drawn again would lose it.
const markRow = (page, orderId) => orderRow(page, orderId).evaluate((el) => { el.dataset.e2eKept = "1"; });
const expectRowKept = (page, orderId) => expect(orderRow(page, orderId)).toHaveAttribute("data-e2e-kept", "1");

// ---- (a) a discount that settles the order ------------------------------------------------------------------
test("a discount that settles a part-paid order shows it Paid at once, without Mark as paid, and reloads nothing", async ({ page, api }) => {
  const shop = await makeShop(api, { prefix: "ipdisc", products: [{ name: "Sample Tee", price: 20 }] });
  const id = await unpaidOrder(api, shop);
  const other = await unpaidOrder(api, shop);
  await ordersPage(page, shop);
  await expect(orderRow(page, id).locator("td[data-balance-td]")).toHaveText("$20.00");
  await expect(orderRow(page, id).locator("td[data-paid-td]")).toHaveText("Unpaid");
  const sent = recordOrders(page);
  await markRow(page, other);

  // $16 by cash: less than the balance, kept as a partial payment.
  await actionCell(page, id).getByRole("button", { name: "💰 Payments" }).click();
  const pm = page.locator("#pmContent");
  await pm.locator("#pmAmount").fill("16");
  await pm.locator("#pmMethod").selectOption("cash");
  await pm.locator("#pmSavePayment").click();
  await page.locator("#balPartial").click();
  await expect(toast(page)).toContainText("Payment recorded.");
  await expect(page.locator("#pmContent")).toContainText(/Balance due\s*\$4\.00/);
  await expect(orderRow(page, id).locator("td[data-balance-td]")).toHaveText("$4.00");
  await expect(orderRow(page, id).locator("td[data-paid-td]")).toHaveText("Unpaid");

  // A $4 discount settles it: the row says Paid within a few seconds, with the window still open.
  await page.locator("#pmContent #pmDiscountAmount").fill("4");
  await page.locator("#pmContent #pmDiscountNote").fill("Loyal customer");
  await page.locator("#pmContent #pmSaveDiscount").click();
  await expect(toast(page)).toContainText("Discount applied.");
  await expect(page.locator("#pmContent")).toContainText(/Balance due\s*Settled ✓/);
  await expect(orderRow(page, id).locator("td[data-paid-td]")).toHaveText("Paid", { timeout: 3000 });
  await expect(orderRow(page, id).locator("td[data-balance-td]")).toHaveText("Settled");
  await page.locator("#pmCloseBottom").click();
  await expect(page.locator("#pmContent")).toHaveCount(0);
  await expect(actionCell(page, id).getByRole("button", { name: "Mark as paid" })).toHaveCount(0);
  await expect(stageSelect(page, id)).toBeVisible();
  // The other order wasn't touched; the list wasn't reloaded.
  await waitIdle(page);
  expect(actionsOf(sent)).toEqual(expect.arrayContaining(["addPayment", "setDiscount"]));
  expect(actionsOf(sent)).not.toContain("getOrders");
  await expectRowKept(page, other);
  await expect(orderRow(page, other).locator("td[data-paid-td]")).toHaveText("Unpaid");
  // The server agrees, and a fresh load shows the same.
  const saved = (await api("getOrders", { org: shop.orgId })).orders.find(o => o.orderId === id);
  expect(saved.paid).toBe(true);
  await ordersPage(page, shop);
  await expect(orderRow(page, id).locator("td[data-paid-td]")).toHaveText("Paid");
  await expect(actionCell(page, id).getByRole("button", { name: "Mark as paid" })).toHaveCount(0);
});

// ---- (b) ticks and totals -----------------------------------------------------------------------------------
test("Mark as paid on a ticked order keeps both ticks and the bulk bar's count, and asks for that order only", async ({ page, api }) => {
  const shop = await makeShop(api, { prefix: "iptick", products: [{ name: "Sample Tee", price: 20 }] });
  const a = await unpaidOrder(api, shop);
  const b = await unpaidOrder(api, shop);
  await ordersPage(page, shop);
  await tickBox(page, a).check();
  await tickBox(page, b).check();
  await expect(page.locator("#bulkBarCount")).toHaveText("2 orders selected");
  const sent = recordOrders(page);
  await markRow(page, b);

  await actionCell(page, a).getByRole("button", { name: "Mark as paid" }).click();
  await confirmOk(page);
  await expect(orderRow(page, a).locator("td[data-paid-td]")).toHaveText("Paid");
  await expect(actionCell(page, a).getByRole("button", { name: "Mark as paid" })).toHaveCount(0);
  await askedForOnly(page, sent, shop, a);
  expect(actionsOf(sent)).toContain("markPaidManual");
  // The redrawn order is still ticked, the other one too, and the bar still counts both.
  await expect(tickBox(page, a)).toBeChecked();
  await expect(tickBox(page, b)).toBeChecked();
  await expect(page.locator("#bulkBar")).toBeVisible();
  await expect(page.locator("#bulkBarCount")).toHaveText("2 orders selected");
  await expect(page.getByRole("checkbox", { name: "Select all orders" })).toBeChecked();
  await expectRowKept(page, b);
  // A bulk action still acts on both: due date for the two ticked orders.
  const due = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
  await page.locator("#bulkBar").getByRole("button", { name: "⏱ Set due date" }).click();
  await page.locator("#bulkDueInput").fill(due);
  await page.locator("#bulkDueInput").locator("xpath=ancestor::form").getByRole("button", { name: "Save" }).click();
  const shown = new Date(due + "T00:00:00").toLocaleDateString("en-US");
  for (const id of [a, b]) await expect(orderRow(page, id).locator("td[data-due-td]")).toContainText(shown);
});

test("voiding one of two outstanding orders updates the outstanding count and the summary without reloading the list", async ({ page, api }) => {
  const shop = await makeShop(api, { prefix: "ipvoid", products: [{ name: "Sample Tee", price: 20 }] });
  const keep = await unpaidOrder(api, shop);
  const gone = await unpaidOrder(api, shop);
  await ordersPage(page, shop);
  const breakdown = page.locator("#ordBreakdownSection");
  const summary = page.locator("#ordSummaryBar");
  await expect(breakdown).toContainText(/Balance due\s*2 outstanding\s*\$40\.00/);
  await expect(summary).toContainText(/2\s*orders/);
  await expect(summary).toContainText(/\$40\.00\s*balance due/);
  const sent = recordOrders(page);
  await markRow(page, keep);

  await actionCell(page, gone).getByRole("button", { name: "Void…" }).click();
  await page.locator("#delReason").fill("Entered twice by the e2e suite");
  await page.locator("#delConfirm").click();
  const who = page.getByRole("dialog", { name: "Confirm it's you to void " + gone });
  const owner = user("owner");
  await who.getByLabel("Email").fill(owner.email);
  await who.getByLabel("Password").fill(owner.password);
  await who.getByRole("button", { name: "Submit" }).click();
  await expect(toast(page)).toContainText("Order " + gone + " voided");
  await expect(orderRow(page, gone)).toHaveCount(0);
  await expect(breakdown).toContainText(/Balance due\s*1 outstanding\s*\$20\.00/);
  await expect(summary).toContainText(/1\s*order\b/);
  await expect(summary).toContainText(/\$20\.00\s*balance due/);
  await waitIdle(page);
  expect(actionsOf(sent)).toContain("voidOrder");
  expect(actionsOf(sent)).not.toContain("getOrders");
  await expectRowKept(page, keep);
  // Include cancelled brings the voided order back from the page's own list, marked VOID.
  await page.getByRole("checkbox", { name: "Include cancelled" }).check();
  await expect(orderRow(page, gone)).toContainText("VOID");
});

// ---- (c) getOrdersByIds: one shop's orders, at most 100 ----------------------------------------------------
test("getOrdersByIds answers only the named shop's orders, and refuses more than 100 ids", async ({ api }) => {
  const shopA = await makeShop(api, { prefix: "ipsca", products: [{ name: "Sample Tee", price: 20 }] });
  const shopB = await makeShop(api, { prefix: "ipscb", products: [{ name: "Sample Tee", price: 20 }] });
  const idA = await unpaidOrder(api, shopA);
  const idB = await unpaidOrder(api, shopB);

  // Shop A's order asked for under shop B: nothing.
  const crossed = await api("getOrdersByIds", { org: shopB.orgId, orderIds: [idA] });
  expect(crossed.status).toBe("ok");
  expect(crossed.orders).toEqual([]);
  // Both ids under shop B: only B's order.
  const mixed = await api("getOrdersByIds", { org: shopB.orgId, orderIds: [idA, idB] });
  expect(mixed.orders.map(o => o.orderId)).toEqual([idB]);
  // Under its own shop: the order, in full.
  const own = await api("getOrdersByIds", { org: shopA.orgId, orderIds: [idA] });
  expect(own.orders.map(o => o.orderId)).toEqual([idA]);
  expect(own.orders[0].items.length).toBe(1);
  expect(own.max).toBe(100);

  // 100 ids is allowed (the unknown ones are left out); 101 is refused with the limit named.
  const ids = (n) => [idA, ...Array.from({ length: n - 1 }, (_, i) => "E2E-NONE-" + String(i).padStart(3, "0"))];
  const hundred = await api("getOrdersByIds", { org: shopA.orgId, orderIds: ids(100) });
  expect(hundred.orders.map(o => o.orderId)).toEqual([idA]);
  const tooMany = await api("getOrdersByIds", { org: shopA.orgId, orderIds: ids(101) }, { allowError: true, withStatus: true });
  expect(tooMany.status).toBe(400);
  expect(tooMany.data.message).toMatch(/max 100/);
  // The same id twice counts once.
  const repeated = await api("getOrdersByIds", { org: shopA.orgId, orderIds: [...ids(100), idA] });
  expect(repeated.orders.map(o => o.orderId)).toEqual([idA]);
  // No shop, or no ids: refused.
  expect((await api("getOrdersByIds", { orderIds: [idA] }, { allowError: true, withStatus: true })).status).toBe(404);
  expect((await api("getOrdersByIds", { org: shopA.orgId, orderIds: [] }, { allowError: true, withStatus: true })).status).toBe(400);
});

// ---- (d) one request per action ----------------------------------------------------------------------------
test("stage steps redraw only that order: a blank step asks for it alone, a later step reads nothing, and no step reloads the list", async ({ page, api }) => {
  const vendor = uniq("Test Blank Co");
  await api("saveVendor", { vendor: { name: vendor, forBlanks: true } });
  const shop = await makeShop(api, { prefix: "ipstep", products: [{ name: "Sample Tee", price: 20 }] });
  const id = await unpaidOrder(api, shop);
  const other = await unpaidOrder(api, shop);
  await api("markPaidManual", { org: shop.orgId, orderId: id, requestId: requestId() });
  await ordersPage(page, shop);
  const sent = recordOrders(page);
  await markRow(page, other);

  // Blank ordered: per line and rolled up, so the order is read back — that order alone.
  await stageSelect(page, id).selectOption({ label: "blank ordered" });
  const form = page.locator("#blankOrderForm");
  await form.locator("#blankVendorSelect").selectOption({ label: vendor });
  await form.getByRole("button", { name: "Mark blank ordered" }).click();
  await expect(form).toHaveCount(0);
  await expect(stageCell(page, id, "blankOrderedAt")).toContainText(vendor);
  await askedForOnly(page, sent, shop, id);
  expect(actionsOf(sent).filter(a => a === "setFulfillmentStage").length).toBe(1);
  await expectRowKept(page, other);

  // Blank received: the same.
  sent.length = 0;
  await stageSelect(page, id).selectOption({ label: "blank received" });
  await page.locator("#brConfirm").click();
  await expect(page.locator("#brConfirm")).toHaveCount(0);
  await expect(stageCell(page, id, "blankReceivedAt")).toContainText(/\d/);
  await askedForOnly(page, sent, shop, id);
  await expectRowKept(page, other);

  // Digitizing complete: the reply's time is drawn into the row as it is; the step is the only request.
  sent.length = 0;
  await stageSelect(page, id).selectOption({ label: "digitizing complete" });
  await confirmOk(page);
  await expect(stageCell(page, id, "digitizingCompleteAt")).toContainText(/\d/);
  await waitIdle(page);
  expect(actionsOf(sent)).toEqual(["setFulfillmentStage"]);
  await expectRowKept(page, other);
});

test("Edit items and cancelling a line each ask for that order alone and leave the other orders' rows as they were", async ({ page, api }) => {
  const shop = await twoProductShop(api, "ipedit");
  const id = await unpaidOrder(api, shop, { items: [[0, 1], [1, 1]] });
  const other = await unpaidOrder(api, shop);
  await ordersPage(page, shop);
  await expect(orderRow(page, id).locator("td[data-balance-td]")).toHaveText("$35.00");
  const sent = recordOrders(page);
  await markRow(page, other);

  // Edit items: two Tees instead of one.
  await actionCell(page, id).getByRole("button", { name: "Edit items" }).click();
  const tee = page.locator("#editOrderRows tr", { has: page.locator("select[data-field=productId] option:checked", { hasText: "Sample Tee" }) });
  await tee.locator("input[data-field=qty]").fill("2");
  await tee.locator("input[data-field=qty]").press("Tab");
  await expect(page.locator("#editOrderNewTotal")).toHaveText("$55.00");
  await page.locator("#editOrderSave").click();
  await expect(page.locator("#editOrderSave")).toHaveCount(0);
  await expect(orderRow(page, id).locator("td[data-balance-td]")).toHaveText("$55.00");
  await askedForOnly(page, sent, shop, id);
  expect(actionsOf(sent)).toContain("editOrder");
  await expectRowKept(page, other);

  // Cancel the Cap line.
  sent.length = 0;
  await page.locator(`tr[data-order="${id}"]`, { hasText: "Sample Cap" }).getByRole("button", { name: "Cancel", exact: true }).click();
  await page.locator(".confirm-modal #cmOk").click();
  await expect(toast(page)).toContainText("Item canceled.");
  await expect(orderRow(page, id).locator("td[data-balance-td]")).toHaveText("$40.00");
  await askedForOnly(page, sent, shop, id);
  expect(actionsOf(sent)).toContain("cancelLineItem");
  await expectRowKept(page, other);
});

test("Local sale: the new order is asked for alone and drawn as the first row, above the orders already listed", async ({ page, api }) => {
  const shop = await makeShop(api, { prefix: "ipls", products: [{ name: "Sample Tee", price: 20 }] });
  const older = [await unpaidOrder(api, shop), await unpaidOrder(api, shop)];
  await ordersPage(page, shop);
  await expect(page.locator("tr[data-order]").first()).toHaveAttribute("data-order", older[1]);
  const sent = recordOrders(page);
  for (const id of older) await markRow(page, id);

  const customer = uniq("Lee Walkin");
  await page.getByRole("button", { name: "+ Local sale" }).click();
  const form = page.locator("#localSaleForm");
  await form.locator("#lsProduct").selectOption({ label: "Sample Tee" });
  await form.locator("#lsQty").fill("1");
  await form.locator("#lsPayment").selectOption("Cash");
  await form.locator("summary", { hasText: "Customer info" }).click();
  await form.locator("#lsName").fill(customer);
  await form.locator("#lsPaid").check();
  await form.getByRole("button", { name: "Record sale" }).click();
  await expect(toast(page)).toContainText("Local sale recorded — ");
  const newId = (await toast(page).textContent()).match(/Local sale recorded — (\S+)/)[1];
  await expect(page.locator("tr[data-order]").first()).toHaveAttribute("data-order", newId);
  await expect(orderRow(page, newId)).toContainText(customer);
  await expect(orderRow(page, newId).locator("td[data-paid-td]")).toHaveText("Paid");
  await askedForOnly(page, sent, shop, newId);
  expect(actionsOf(sent).filter(a => a === "createLocalSale").length).toBe(1);
  for (const id of older) await expectRowKept(page, id);
  // The rows below are the older orders, in their order; the totals count three.
  const ids = await page.locator("tr[data-order]").evaluateAll(els => [...new Set(els.map(e => e.dataset.order))]);
  expect(ids).toEqual([newId, older[1], older[0]]);
  await expect(page.locator("#ordSummaryBar")).toContainText(/3\s*orders/);
});

test("on All shops, Mark as paid asks for that one order of its shop and reloads nothing", async ({ page, api }) => {
  const shop = await makeShop(api, { prefix: "ipall", products: [{ name: "Sample Tee", price: 20 }] });
  const id = await unpaidOrder(api, shop);
  const other = await unpaidOrder(api, shop);
  if (page.url().startsWith(ADMIN)) await page.goto("about:blank");
  await openAdmin(page, "orders/all");
  await expect(page.getByRole("combobox", { name: "Shop" })).toHaveValue("");   // "" is All shops
  await expect(orderRow(page, id)).toBeVisible();
  const sent = recordOrders(page);
  await markRow(page, other);

  await actionCell(page, id).getByRole("button", { name: "Mark as paid" }).click();
  await confirmOk(page);
  await expect(orderRow(page, id).locator("td[data-paid-td]")).toHaveText("Paid");
  await expect(actionCell(page, id).getByRole("button", { name: "Mark as paid" })).toHaveCount(0);
  await askedForOnly(page, sent, shop, id);
  await expectRowKept(page, other);
  await expect(page).toHaveURL(/#orders\/all$/);
});
