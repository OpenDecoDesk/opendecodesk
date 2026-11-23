// Admin → Orders: a shop's orders list, its order windows, fulfillment stages, payments, editing, Local sale,
// bulk actions, filters (the Orders page has no search box: shop, date range and the Include boxes are its filters),
// invoice PDF, void, the no-Shippo state — and what the Production and Read only roles may do there.
// Every test makes its own shop (makeShop) and its own orders on that shop's page (placeOrder), and only
// ever looks at that shop's orders: other specs place orders on the same install at the same time.
import { test, expect, openAdmin, toast, uniq, user, ADMIN, apiContext, callApi } from "../fixtures.mjs";
import { makeShop, placeOrder } from "../lib/data.mjs";

// ---- helpers ---------------------------------------------------------------------------------------------
// Opens the shop's Orders page — a real page load, even when the browser is already at that address (going to
// the same address with only a #hash would not reload, and would show the page's own copy of the orders).
const ordersPage = async (page, shop) => {
  const target = ADMIN + "/#orders/" + shop.orgId;
  if (page.url() === target) await page.goto("about:blank");
  await openAdmin(page, "orders/" + shop.orgId);
  await expect(page.getByRole("combobox", { name: "Shop" })).toHaveValue(shop.orgId);
};
// The order's "Paid" status cell reads Paid / Unpaid (the column has no data attribute; matched by its text).
const PAID = /\bPaid\b/;
// An order's first table row (an order with several lines spans several rows; the order cells sit on the first).
const orderRow = (page, orderId) => page.locator(`tr[data-order="${orderId}"]`).first();
const actionCell = (page, orderId) => orderRow(page, orderId).locator("td[data-action-td]");
// The "— Stage —" list in the order's Action cell.
const stageSelect = (page, orderId) => actionCell(page, orderId).locator("select");
const stageCell = (page, orderId, field) => orderRow(page, orderId).locator(`td[data-stage-td="${field}"]`);
// The app's own confirm window (askConfirm_/askWhen_): its OK-side button.
const confirmOk = async (page) => {
  const ok = page.locator(".confirm-modal #cmOk");
  await expect(ok).toBeVisible();
  await ok.click();
  await expect(page.locator(".confirm-modal")).toHaveCount(0);
};
const shopWithOrder = async (api, page, { customer, items, ...shopOpts } = {}) => {
  const shop = await makeShop(api, { prefix: "ord", products: [{ name: "Sample Tee", price: 20 }, { name: "Sample Cap", price: 15, type: "cap", idPrefix: "cap" }], ...shopOpts });
  const order = await placeOrder(page, shop, { customer: customer || uniq("Casey Customer"), items });
  return { shop, order };
};
const markPaidThroughPage = async (page, orderId) => {
  await actionCell(page, orderId).getByRole("button", { name: "Mark as paid" }).click();
  await confirmOk(page);
  await expect(orderRow(page, orderId)).toContainText(PAID);
  await expect(actionCell(page, orderId).getByRole("button", { name: "Mark as paid" })).toHaveCount(0);
};

// ---- the list and the order windows -----------------------------------------------------------------------
test("a storefront order appears in its shop's list, unpaid, with customer, lines and total", async ({ page, api }) => {
  const customer = uniq("Casey Customer");
  const { shop, order } = await shopWithOrder(api, page, { customer, items: [{ name: "Sample Tee", qty: 2 }, { name: "Sample Cap", qty: 1 }] });
  expect(order.total).toBe("55.00");
  await ordersPage(page, shop);
  const rows = page.locator(`tr[data-order="${order.orderId}"]`);
  await expect(rows).toHaveCount(2);                         // one row per line
  const first = orderRow(page, order.orderId);
  await expect(first).toContainText(customer);
  await expect(first).toContainText("Unpaid");
  await expect(first.locator("td[data-balance-td]")).toHaveText("$55.00");
  await expect(page.locator(`tr[data-order="${order.orderId}"]`, { hasText: "Sample Tee" })).toContainText("$40.00");
  await expect(page.locator(`tr[data-order="${order.orderId}"]`, { hasText: "Sample Cap" })).toContainText("$15.00");
  // The page's totals for this shop.
  await expect(page.locator("#app")).toContainText("1 outstanding");
  // Unpaid: no stage list yet, Mark as paid instead.
  await expect(stageSelect(page, order.orderId)).toHaveCount(0);
  await expect(actionCell(page, order.orderId).getByRole("button", { name: "Mark as paid" })).toBeVisible();
});

test("Home's New tile lists the order, and its order number opens it from the keyboard", async ({ page, api }) => {
  const { shop, order } = await shopWithOrder(api, page);
  await openAdmin(page, "home/new");
  const open = page.getByRole("button", { name: "Open order " + order.orderId });
  await expect(open).toBeVisible();
  await open.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("combobox", { name: "Shop" })).toHaveValue(shop.orgId);
  await expect(orderRow(page, order.orderId)).toBeVisible();
});

// ---- fulfillment stages ----------------------------------------------------------------------------------
test("an order walks every fulfillment step to completed", async ({ page, api }) => {
  const vendor = uniq("Test Blank Co");
  await api("saveVendor", { vendor: { name: vendor, forBlanks: true } });
  const { shop, order } = await shopWithOrder(api, page);
  const id = order.orderId;
  await ordersPage(page, shop);
  await markPaidThroughPage(page, id);

  const pick = async (label) => {
    await expect(stageSelect(page, id).locator("option", { hasText: new RegExp("^" + label + "$") })).toHaveCount(1);
    await stageSelect(page, id).selectOption({ label });
  };
  // Blank ordered: the vendor is required.
  await pick("blank ordered");
  const form = page.locator("#blankOrderForm");
  await expect(form).toBeVisible();
  await form.getByRole("button", { name: "Mark blank ordered" }).click();
  await expect(page.locator("#blankOrderFormErr")).toHaveText("Pick the vendor (Manage… adds one).");
  await form.locator("#blankVendorSelect").selectOption({ label: vendor });
  await form.locator("#blankVendorOrderId").fill("PO-E2E-1");
  await form.getByRole("button", { name: "Mark blank ordered" }).click();
  await expect(form).toHaveCount(0);
  await expect(stageCell(page, id, "blankOrderedAt")).toContainText(vendor);
  await expect(stageCell(page, id, "blankOrderedAt")).toContainText("PO-E2E-1");

  await pick("blank received");
  await page.locator("#brConfirm").click();
  await expect(page.locator("#brConfirm")).toHaveCount(0);
  await expect(stageCell(page, id, "blankReceivedAt")).toContainText(/\d/);

  for (const [label, field] of [["digitizing complete", "digitizingCompleteAt"], ["manufactured", "manufacturedAt"], ["QA and packed", "qaPackedAt"]]) {
    await pick(label);
    await confirmOk(page);
    await expect(stageCell(page, id, field)).toContainText(/\d/);
  }
  // Shipped: the tracking window (the number is optional; no carrier is set up here).
  await pick("shipped");
  await page.locator(".tracking-input").fill("TRACK-E2E-123");
  await page.getByRole("button", { name: "Mark shipped" }).click();
  await expect(stageCell(page, id, "shippedAt")).toContainText(/\d/);
  await expect(orderRow(page, id).locator("td[data-tracking-td]")).toContainText("TRACK-E2E-123");
  // Delivered → the page offers to complete it (paid in full).
  await pick("delivered");
  await confirmOk(page);
  await expect(page.locator(".confirm-modal")).toContainText("as completed?");
  await confirmOk(page);
  // Completed orders leave the list unless "Include completed" is ticked.
  await expect(orderRow(page, id)).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Include completed" }).check();
  await expect(orderRow(page, id).locator("td[data-completed-td]")).toContainText(/\d/);
  await expect(actionCell(page, id)).toContainText(/Completed \d/);
  await expect(actionCell(page, id).getByRole("button", { name: "Reopen" })).toBeVisible();
});

// ---- payments --------------------------------------------------------------------------------------------
test("Payments: a partial Venmo payment, the rest by Zelle, then a cash refund", async ({ page, api }) => {
  const { shop, order } = await shopWithOrder(api, page, { items: [{ name: "Sample Tee", qty: 2 }] });
  const id = order.orderId;
  await ordersPage(page, shop);
  await actionCell(page, id).getByRole("button", { name: "💰 Payments" }).click();
  const pm = page.locator("#pmContent");
  await expect(pm).toContainText("Amount due");
  await expect(pm).toContainText("$40.00");
  await expect(pm.locator("#pmMethod option")).toHaveText(["Card", "Venmo", "Zelle", "Check", "Cash", "Other"]);

  // Nothing typed: refused in the window.
  await pm.locator("#pmSavePayment").click();
  await expect(pm.locator("#pmError")).toHaveText("Enter a valid amount.");

  await pm.locator("#pmAmount").fill("15");
  await pm.locator("#pmMethod").selectOption("venmo");
  await pm.locator("#pmReference").fill("VEN-E2E-1");
  await pm.locator("#pmSavePayment").click();
  // Less than the balance: the page asks what the rest is.
  await page.locator("#balPartial").click();
  await expect(toast(page)).toContainText("Payment recorded.");
  await expect(pm).toContainText("Payment history");
  await expect(pm).toContainText("Venmo · VEN-E2E-1");
  await expect(pm).toContainText(/Balance due\s*\$25\.00/);
  await expect(orderRow(page, id).locator("td[data-balance-td]")).toHaveText("$25.00");

  await pm.locator("#pmAmount").fill("25");
  await pm.locator("#pmMethod").selectOption("zelle");
  await pm.locator("#pmSavePayment").click();
  await expect(pm).toContainText("Zelle");
  await expect(pm).toContainText(/Balance due\s*Settled ✓/);

  // Card isn't offered for a refund (it is refunded in Stripe); the other methods are.
  await expect(pm.locator("#pmRefundMethod option")).toHaveText(["Venmo", "Zelle", "Check", "Cash", "Other"]);
  // A refund (orders.payments full): confirmed first, then a negative line in the history.
  await pm.locator("#pmSaveRefund").click();
  await expect(pm.locator("#pmError")).toHaveText("Enter the refund amount.");
  await pm.locator("#pmRefundAmount").fill("5");
  await pm.locator("#pmRefundMethod").selectOption("cash");
  await pm.locator("#pmRefundNote").fill("Returned one sample");
  await pm.locator("#pmSaveRefund").click();
  await confirmOk(page);
  await expect(page.locator("#pmContent")).toContainText("−$5.00");
  await expect(page.locator("#pmContent")).toContainText(/Refunded\s*−\$5\.00/);
  await expect(page.locator("#pmContent")).toContainText(/Net kept\s*\$35\.00/);
  await page.locator("#pmCloseBottom").click();
  await expect(page.locator("#pmContent")).toHaveCount(0);

  // After a page load the order is paid and the payments are still there.
  await ordersPage(page, shop);
  await expect(orderRow(page, id)).toContainText(PAID);
  await expect(actionCell(page, id).getByRole("button", { name: "Mark as paid" })).toHaveCount(0);
  await actionCell(page, id).getByRole("button", { name: "💰 Payments" }).click();
  await expect(page.locator("#pmContent")).toContainText("VEN-E2E-1");
  await expect(page.locator("#pmContent")).toContainText("Returned one sample");
});

test("Mark as paid books the balance once, and a discount lowers what is due", async ({ page, api }) => {
  const { shop, order } = await shopWithOrder(api, page);
  const id = order.orderId;
  await ordersPage(page, shop);
  // A discount first: $20 order, $4 off.
  await actionCell(page, id).getByRole("button", { name: "💰 Payments" }).click();
  const pm = page.locator("#pmContent");
  await pm.locator("#pmDiscountAmount").fill("4");
  await pm.locator("#pmDiscountNote").fill("Member discount");
  await pm.locator("#pmSaveDiscount").click();
  await expect(page.locator("#pmContent")).toContainText(/Discount \(Member discount\)/);
  await expect(page.locator("#pmContent")).toContainText(/Amount due\s*\$16\.00/);
  await page.locator("#pmCloseBottom").click();
  await expect(orderRow(page, id).locator("td[data-balance-td]")).toHaveText("$16.00");
  // Mark as paid: the confirm window asks when; then the stage list appears.
  await markPaidThroughPage(page, id);
  await expect(stageSelect(page, id)).toBeVisible();
  await actionCell(page, id).getByRole("button", { name: "💰 Payments" }).click();
  await expect(page.locator("#pmContent")).toContainText(/Received\s*\$16\.00/);
  await expect(page.locator("#pmContent")).toContainText(/Balance due\s*Settled ✓/);
  await expect(page.locator("#pmContent")).toContainText("Marked paid manually (Check)");
});

// Fixed bug: Payments → Save that paid the order in full left the row saying "Unpaid", with "Mark as paid"
// and no stage list, until the page is loaded again (the window's row update copies the new balance but not the
// server's paid flag: public/admin.js showPaymentsModal → updateOrderTableRow).
test("paying the whole balance in the Payments window shows the order as paid at once", async ({ page, api }) => {
  const { shop, order } = await shopWithOrder(api, page);
  const id = order.orderId;
  await ordersPage(page, shop);
  await actionCell(page, id).getByRole("button", { name: "💰 Payments" }).click();
  const pm = page.locator("#pmContent");
  await pm.locator("#pmAmount").fill("20");
  await pm.locator("#pmMethod").selectOption("cash");
  await pm.locator("#pmSavePayment").click();
  await expect(toast(page)).toContainText("Payment recorded.");
  await expect(pm).toContainText(/Balance due\s*Settled ✓/);
  await page.locator("#pmCloseBottom").click();
  await expect(orderRow(page, id).locator("td[data-balance-td]")).toContainText("Settled");
  await expect(orderRow(page, id)).toContainText(PAID, { timeout: 3000 });
  await expect(actionCell(page, id).getByRole("button", { name: "Mark as paid" })).toHaveCount(0, { timeout: 2000 });
});

// ---- editing an order ------------------------------------------------------------------------------------
test("Edit items: a bigger quantity and an added line change the total and the balance", async ({ page, api }) => {
  const { shop, order } = await shopWithOrder(api, page);
  const id = order.orderId;
  await ordersPage(page, shop);
  await actionCell(page, id).getByRole("button", { name: "Edit items" }).click();
  const rows = page.locator("#editOrderRows tr");
  await expect(rows).toHaveCount(1);
  await rows.first().locator("input[data-field=qty]").fill("3");
  // The quantity is taken on "change" (leaving the box), which redraws the rows; leave it first so the next
  // click lands where it was aimed.
  await rows.first().locator("input[data-field=qty]").press("Tab");
  await expect(page.locator("#editOrderNewTotal")).toHaveText("$60.00");
  await page.locator("#editOrderAddRow").click();
  await expect(rows).toHaveCount(2);
  await rows.nth(1).locator("select[data-field=productId]").selectOption({ label: "Sample Cap" });
  await expect(page.locator("#editOrderNewTotal")).toHaveText("$75.00");
  await page.locator("#editOrderSave").click();
  await expect(page.locator("#editOrderSave")).toHaveCount(0);
  await expect(page.locator(`tr[data-order="${id}"]`)).toHaveCount(2);
  await expect(page.locator(`tr[data-order="${id}"]`, { hasText: "Sample Tee" })).toContainText("$60.00");
  await expect(page.locator(`tr[data-order="${id}"]`, { hasText: "Sample Cap" })).toContainText("$15.00");
  await expect(orderRow(page, id).locator("td[data-balance-td]")).toHaveText("$75.00");
});

test("cancelling one line takes it off the balance; the order keeps its other line", async ({ page, api }) => {
  const { shop, order } = await shopWithOrder(api, page, { items: [{ name: "Sample Tee", qty: 1 }, { name: "Sample Cap", qty: 1 }] });
  const id = order.orderId;
  await ordersPage(page, shop);
  await expect(orderRow(page, id).locator("td[data-balance-td]")).toHaveText("$35.00");
  const capRow = page.locator(`tr[data-order="${id}"]`, { hasText: "Sample Cap" });
  await capRow.getByRole("button", { name: "Cancel", exact: true }).click();
  const dlg = page.locator(".confirm-modal");
  await expect(dlg).toContainText("Cancel this item?");
  await expect(dlg).toContainText("Sample Cap ($15.00)");
  // "Keep it" leaves it alone.
  await dlg.locator("#cmCancel").click();
  await expect(dlg).toHaveCount(0);
  await expect(orderRow(page, id).locator("td[data-balance-td]")).toHaveText("$35.00");
  await capRow.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.locator(".confirm-modal #cmReason").fill("Customer changed their mind");
  await page.locator(".confirm-modal #cmOk").click();
  await expect(toast(page)).toContainText("Item canceled.");
  await expect(orderRow(page, id).locator("td[data-balance-td]")).toHaveText("$20.00");
  // The cancelled line no longer offers Cancel.
  await expect(page.locator(`tr[data-order="${id}"]`, { hasText: "Sample Cap" }).getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
});

// ---- Local sale ------------------------------------------------------------------------------------------
const openLocalSale = async (page, shop) => {
  await ordersPage(page, shop);
  await page.getByRole("button", { name: "+ Local sale" }).click();
  const form = page.locator("#localSaleForm");
  await expect(form).toBeVisible();
  return form;
};
const fillLocalSale = async (form, { product = "Sample Tee", qty = 2, payment = "Cash", customer, paid = true } = {}) => {
  await form.locator("#lsProduct").selectOption({ label: product });
  await form.locator("#lsQty").fill(String(qty));
  await form.locator("#lsPayment").selectOption(payment);
  if (customer) {
    await form.locator("summary", { hasText: "Customer info" }).click();
    await form.locator("#lsName").fill(customer);
  }
  if (paid) await form.locator("#lsPaid").check();
};

test("Local sale: an in-person cash sale is recorded as a paid order", async ({ page, api }) => {
  const shop = await makeShop(api, { prefix: "ls", products: [{ name: "Sample Tee", price: 20 }] });
  const customer = uniq("Lee Walkin");
  const form = await openLocalSale(page, shop);
  // Nothing chosen: the window says what's missing and records nothing.
  await form.getByRole("button", { name: "Record sale" }).click();
  await expect(form.locator("#lsErr")).toBeVisible();
  await fillLocalSale(form, { customer });
  await expect(form.locator("#lsPricePreview")).toContainText("$40.00");
  await form.getByRole("button", { name: "Record sale" }).click();
  await expect(toast(page)).toContainText("Local sale recorded — ");
  const row = page.locator("tr[data-order]", { hasText: customer });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(PAID);
  await expect(row).toContainText("Cash");
  await expect(row).toContainText("$40.00");
});

test("Local sale: a double click on Record sale makes exactly one order", async ({ page, api }) => {
  const shop = await makeShop(api, { prefix: "ls2", products: [{ name: "Sample Tee", price: 20 }] });
  const form = await openLocalSale(page, shop);
  await fillLocalSale(form, { customer: uniq("Dee Doubleclick"), qty: 1 });
  await form.getByRole("button", { name: "Record sale" }).dblclick();
  await expect(toast(page)).toContainText("Local sale recorded — ");
  await expect(page.locator("tr[data-order]")).toHaveCount(1);
  // A second "+ Local sale" window can't be opened on top of the first either: double-clicking the button opens one.
  await page.getByRole("button", { name: "+ Local sale" }).dblclick();
  await expect(page.locator("#localSaleForm")).toHaveCount(1);
  await page.locator("#localSaleForm .admin-pass-cancel").click();
  await expect(page.locator("#localSaleForm")).toHaveCount(0);
  // The server agrees: one order on this shop.
  const orders = (await api("getOrders", { org: shop.orgId })).orders;
  expect(orders.length).toBe(1);
  await page.reload();
  await expect(page.locator("tr[data-order]")).toHaveCount(1);
});

// ---- bulk actions and filters ----------------------------------------------------------------------------
// Two orders on a fresh shop, both marked paid through the owner's API (the page's Mark as paid is tested above).
const shopWithTwoPaidOrders = async (api, page) => {
  const shop = await makeShop(api, { prefix: "blk", products: [{ name: "Sample Tee", price: 20 }] });
  const a = await placeOrder(page, shop, { customer: uniq("Ari Bulk") });
  const b = await placeOrder(page, shop, { customer: uniq("Bo Bulk") });
  for (const o of [a, b]) await api("markPaidManual", { org: shop.orgId, orderId: o.orderId, requestId: uniq("pay").replace(/\W/g, "") });
  return { shop, ids: [a.orderId, b.orderId] };
};
const isoInDays = (n) => { const d = new Date(Date.now() + n * 86400000); return d.toISOString().slice(0, 10); };

test("bulk: select orders, set their due date and move them to Digitizing complete together", async ({ page, api }) => {
  const { shop, ids } = await shopWithTwoPaidOrders(api, page);
  await ordersPage(page, shop);
  const bar = page.locator("#bulkBar");
  await page.getByRole("checkbox", { name: "Select order " + ids[0] }).check();
  await expect(page.locator("#bulkBarCount")).toHaveText("1 order selected");
  await page.getByRole("checkbox", { name: "Select all orders" }).check();
  await expect(page.locator("#bulkBarCount")).toHaveText("2 orders selected");

  // Due date for both.
  const due = isoInDays(14);
  await bar.getByRole("button", { name: "⏱ Set due date" }).click();
  await page.locator("#bulkDueInput").fill(due);
  await page.locator("#bulkDueInput").locator("xpath=ancestor::form").getByRole("button", { name: "Save" }).click();
  const shown = new Date(due + "T00:00:00").toLocaleDateString("en-US");
  for (const id of ids) await expect(orderRow(page, id).locator("td[data-due-td]")).toContainText(shown);

  // A stage for both: one confirm window for the lot.
  for (const id of ids) {
    const box = page.getByRole("checkbox", { name: "Select order " + id });
    if (!(await box.isChecked())) await box.check();
  }
  await bar.getByRole("button", { name: "→ Digitizing complete" }).click();
  await expect(page.locator(".confirm-modal")).toContainText("Mark 2 orders as");
  await confirmOk(page);
  for (const id of ids) await expect(stageCell(page, id, "digitizingCompleteAt")).toContainText(/\d/);
  // Clear empties the selection.
  await page.getByRole("checkbox", { name: "Select all orders" }).check();
  await bar.getByRole("button", { name: "Clear" }).click();
  await expect(page.locator(".order-select:checked")).toHaveCount(0);
});

test("filters: the date range, Include cancelled and All shops decide which orders show", async ({ page, api }) => {
  const shop = await makeShop(api, { prefix: "flt", products: [{ name: "Sample Tee", price: 20 }] });
  const keep = await placeOrder(page, shop, { customer: uniq("Kim Kept") });
  const gone = await placeOrder(page, shop, { customer: uniq("Gil Gone") });
  // Cancel the second order's only line: the whole order counts as cancelled.
  await ordersPage(page, shop);
  await page.locator(`tr[data-order="${gone.orderId}"]`).getByRole("button", { name: "Cancel", exact: true }).click();
  await page.locator(".confirm-modal #cmOk").click();
  await expect(toast(page)).toContainText("Item canceled.");
  await expect(orderRow(page, gone.orderId)).toHaveCount(0);
  await expect(orderRow(page, keep.orderId)).toBeVisible();
  await page.getByRole("checkbox", { name: "Include cancelled" }).check();
  await expect(orderRow(page, gone.orderId)).toBeVisible();
  await page.getByRole("checkbox", { name: "Include cancelled" }).uncheck();
  await expect(orderRow(page, gone.orderId)).toHaveCount(0);

  // A date range that starts tomorrow leaves nothing of today's.
  await page.getByRole("textbox", { name: "From" }).fill(isoInDays(2));
  await page.getByRole("textbox", { name: "To" }).fill(isoInDays(3));
  await page.getByRole("textbox", { name: "To" }).dispatchEvent("change");
  await expect(orderRow(page, keep.orderId)).toHaveCount(0);
  await page.getByRole("textbox", { name: "From" }).fill(isoInDays(-3));
  await page.getByRole("textbox", { name: "From" }).dispatchEvent("change");
  await page.getByRole("textbox", { name: "To" }).fill(isoInDays(1));
  await page.getByRole("textbox", { name: "To" }).dispatchEvent("change");
  await expect(orderRow(page, keep.orderId)).toBeVisible();

  // All shops: the same order, among every shop's.
  await page.getByRole("combobox", { name: "Shop" }).selectOption({ label: "All shops" });
  await expect(page).toHaveURL(/#orders\/all$/);
  await expect(page.locator(`[data-order="${keep.orderId}"]`).first()).toBeVisible();
});

// ---- what other roles may do here ------------------------------------------------------------------------
// The buttons a role can't use are not drawn, or drawn hidden (data-need → data-perm-off, display:none) — either way
// getByRole doesn't find them, as it skips hidden elements. The server refuses the action anyway.
const visibleButton = (scope, name) => scope.getByRole("button", { name, exact: true });

test("Production sees a shop's orders but no payment, edit or void buttons, and the server refuses its payments", async ({ page, api, as }, testInfo) => {
  const { shop, order } = await shopWithOrder(api, page);
  const id = order.orderId;
  const prod = await as("production");
  await ordersPage(prod, shop);
  await expect(orderRow(prod, id)).toBeVisible();
  const cell = actionCell(prod, id);
  await expect(cell).toContainText("Not paid");
  for (const name of ["Mark as paid", "Edit items", "💰 Payments", "Void…", "+ Rush…"]) await expect(visibleButton(cell, name)).toHaveCount(0);
  await expect(visibleButton(prod.locator("#app"), "+ Local sale")).toHaveCount(0);
  await expect(visibleButton(orderRow(prod, id), "Cancel")).toHaveCount(0);
  // …while the owner, on the same order, has them all.
  await ordersPage(page, shop);
  for (const name of ["Mark as paid", "Edit items", "💰 Payments", "Void…"]) await expect(visibleButton(actionCell(page, id), name)).toHaveCount(1);

  const ctx = await apiContext("production", testInfo.workerIndex);
  const refused = await callApi(ctx, "addPayment", { orderId: id, amount: 20, method: "cash", note: "", requestId: "prodtry1" }, { allowError: true, withStatus: true });
  expect(refused.status).toBe(403);
  const refused2 = await callApi(ctx, "markPaidManual", { org: shop.orgId, orderId: id, requestId: "prodtry2" }, { allowError: true, withStatus: true });
  expect(refused2.status).toBe(403);
  await ctx.dispose();
  // Still unpaid for the owner.
  await ordersPage(page, shop);
  await expect(orderRow(page, id).locator("td[data-balance-td]")).toHaveText("$20.00");
});

test("Read only sees orders and their payments but can't change anything", async ({ page, api, as }, testInfo) => {
  const { shop, order } = await shopWithOrder(api, page);
  const id = order.orderId;
  const viewer = await as("viewer");
  await ordersPage(viewer, shop);
  await expect(orderRow(viewer, id)).toBeVisible();
  const cell = actionCell(viewer, id);
  for (const name of ["Mark as paid", "Edit items", "Void…", "+ Rush…"]) await expect(visibleButton(cell, name)).toHaveCount(0);
  await expect(visibleButton(viewer.locator("#app"), "+ Local sale")).toHaveCount(0);
  await expect(visibleButton(viewer.locator("#app"), "Create test transaction")).toHaveCount(0);
  // The payments window opens to look at.
  await expect(visibleButton(cell, "💰 Payments")).toHaveCount(1);

  const ctx = await apiContext("viewer", testInfo.workerIndex);
  const tries = [
    ["addPayment", { orderId: id, amount: 20, method: "cash", note: "", requestId: "viewtry1" }],
    ["cancelLineItem", { org: shop.orgId, sheetRow: 1, reason: "" }],
    ["createLocalSale", { org: shop.orgId, requestId: "viewtry2", productId: shop.products[0].productId, qty: 1, paymentMethod: "Cash" }],
  ];
  for (const [action, body] of tries) {
    const r = await callApi(ctx, action, body, { allowError: true, withStatus: true });
    expect(r.status, action).toBe(403);
  }
  // Reading is allowed.
  const list = await callApi(ctx, "getOrders", { org: shop.orgId });
  expect(list.orders.map(o => o.orderId)).toContain(id);
  await ctx.dispose();
});

// ---- invoice PDF and void ------------------------------------------------------------------------------
test("Invoice PDF downloads a PDF of the order", async ({ page, api }) => {
  const { shop, order } = await shopWithOrder(api, page);
  await ordersPage(page, shop);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    actionCell(page, order.orderId).getByRole("button", { name: "Invoice PDF" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.pdf$/i);
  const file = await download.path();
  const head = (await import("node:fs")).readFileSync(file).subarray(0, 5).toString("latin1");
  expect(head).toBe("%PDF-");
  await expect(toast(page)).toContainText("Downloaded ");
});

test("Void… needs a reason and the user's own password again, then keeps the order on record as void", async ({ page, api }) => {
  const { shop, order } = await shopWithOrder(api, page);
  const id = order.orderId;
  await ordersPage(page, shop);
  await actionCell(page, id).getByRole("button", { name: "Void…" }).click();
  await expect(page.getByText("⚠ Void this order?")).toBeVisible();
  await page.locator("#delReason").fill("Duplicate order from the e2e suite");
  await page.locator("#delConfirm").click();
  const who = page.getByRole("dialog", { name: "Confirm it's you to void " + id });
  await expect(who).toBeVisible();
  const owner = user("owner");
  // A wrong password is refused in the same window, which asks again.
  await who.getByLabel("Email").fill(owner.email);
  await who.getByLabel("Password").fill("not-my-password-at-all");
  await who.getByRole("button", { name: "Submit" }).click();
  await expect(page.getByRole("dialog", { name: "Confirm it's you to void " + id }).getByRole("alert")).toContainText("don't match");
  const again = page.getByRole("dialog", { name: "Confirm it's you to void " + id });
  await again.getByLabel("Email").fill(owner.email);
  await again.getByLabel("Password").fill(owner.password);
  await again.getByRole("button", { name: "Submit" }).click();
  await expect(toast(page)).toContainText("Order " + id + " voided");
  // Still signed in, and the order is gone from the open list.
  await expect(page.getByRole("navigation", { name: "Admin" })).toBeVisible();
  await expect(orderRow(page, id)).toHaveCount(0);
});

// ---- carrier labels without Shippo -----------------------------------------------------------------------
test("Ship on a paid order with an address says plainly that carrier shipping isn't set up (no Shippo key)", async ({ page, api }) => {
  const { shop, order } = await shopWithOrder(api, page);
  const id = order.orderId;
  await api("markPaidManual", { org: shop.orgId, orderId: id, requestId: uniq("pay").replace(/\W/g, "") });
  await api("setShippingInfo", { org: shop.orgId, orderId: id, totalWeightOz: 8, shippingCost: 0, shippingMethod: "",
    shippingAddress: { name: "Casey Customer", line1: "1 Example Way", line2: "", city: "Sampletown", state: "CA", zip: "90001", country: "US" } });
  await ordersPage(page, shop);
  const ship = orderRow(page, id).locator("td[data-tracking-td]").getByRole("button", { name: "Ship" });
  await expect(ship).toBeVisible();
  await ship.click();
  await expect(toast(page)).toContainText("Could not fetch rates: Shipping not configured");
  // Nothing was bought: the button is back, and no tracking number appeared.
  await expect(orderRow(page, id).locator("td[data-tracking-td]").getByRole("button", { name: "Ship" })).toBeEnabled();
  await expect(stageCell(page, id, "shippedAt")).toHaveText("—");
});
