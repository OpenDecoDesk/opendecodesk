// Payment on delivery (migrations/0105; functions/_lib/db.js payOnDeliveryRule, functions/api/orders.js setPayOnDelivery
// and createLocalSale, public/admin.js adminActionCell / setPayOnDelivery_ / showLocalSaleModal). What's checked:
//
// - Off until Global settings → Payment methods allows it: no button on an unpaid row, no box in the Local sale window,
//   and the server refuses both ways in.
// - Global settings shows its two boxes as saved, and Save sends them in the payments section. Shop settings has the
//   same two; a shop that unticks Payment on delivery gets no button (and the server refuses) while the global
//   setting allows it.
// - On an unpaid row: Pay on delivery asks, then the row reads "Unpaid · on delivery", the stage list appears, and
//   every step goes ahead to delivered. Delivered doesn't complete it: a balance is still due. Mark as paid, then
//   Mark completed. One audit entry. "Not pay on delivery" puts the order back to waiting for payment.
// - Its own permission: Manager has it by default; Back office and Production don't (no button, and the server
//   refuses them with 403).
// - Only for local sales: no button on the row (the server refuses too), but the Local sale window has the box;
//   Paid and Pay on delivery together are refused; a sale recorded with it is unpaid with its steps open.
//
// Global settings → Payment methods is install-wide. Each test that needs it on turns it on through the owner's
// API (saveGlobalSettingsAll with the payments section only) and puts the saved value back in a `finally`. Other
// specs never save that section for real (their page Saves are refused or answered by a stub), and payment on
// delivery adds a button only to unpaid rows of owner and manager, which no other spec counts.
import { test, expect, openAdmin, leaveAdmin, toast, uniq, ADMIN, apiContext, callApi } from "../fixtures.mjs";
import { makeShop, placeOrder } from "../lib/data.mjs";

// ---- helpers ---------------------------------------------------------------------------------------------
const globalPayments = async (api) => ((await api("getGlobalSettings")).globalSettings || {}).enabledPayments || {};
// Runs fn with Payment on delivery allowed globally (and, with { localOnly: true }, only for local sales), then puts
// Global settings → Payment methods back as it was.
async function withGlobalPod(api, { localOnly = false } = {}, fn) {
  const before = await globalPayments(api);
  await api("saveGlobalSettingsAll", { settings: { payments: { ...before, onDelivery: true, onDeliveryLocalOnly: localOnly } } });
  try { return await fn(); }
  finally { await api("saveGlobalSettingsAll", { settings: { payments: before } }); }
}
const PAYMENTS = { card: false, venmo: true, zelle: true, check: true, cash: true, other: true };

const ordersPage = async (page, shop) => {
  if (page.url().startsWith(ADMIN)) await leaveAdmin(page);
  await openAdmin(page, "orders/" + shop.orgId);
  await expect(page.getByRole("combobox", { name: "Shop" })).toHaveValue(shop.orgId);
};
const orderRow = (page, orderId) => page.locator(`tr[data-order="${orderId}"]`).first();
const actionCell = (page, orderId) => orderRow(page, orderId).locator("td[data-action-td]");
const paidCell = (page, orderId) => orderRow(page, orderId).locator("td[data-paid-td]");
const stageSelect = (page, orderId) => actionCell(page, orderId).locator("select");
const stageCell = (page, orderId, field) => orderRow(page, orderId).locator(`td[data-stage-td="${field}"]`);
// exact: "Pay on delivery" is also part of "Not pay on delivery".
const podOn = (page, orderId) => actionCell(page, orderId).getByRole("button", { name: "Pay on delivery", exact: true });
const podOff = (page, orderId) => actionCell(page, orderId).getByRole("button", { name: "Not pay on delivery", exact: true });
const markPaid = (page, orderId) => actionCell(page, orderId).getByRole("button", { name: "Mark as paid", exact: true });
const confirmOk = async (page) => {
  const ok = page.locator(".confirm-modal #cmOk");
  await expect(ok).toBeVisible();
  await ok.click();
  await expect(page.locator(".confirm-modal")).toHaveCount(0);
};
const shopWithOrder = async (api, page, shopOpts = {}) => {
  const shop = await makeShop(api, { prefix: "pod", products: [{ name: "Sample Tee", price: 20 }], ...shopOpts });
  const order = await placeOrder(page, shop, { customer: uniq("Casey Customer") });
  return { shop, order };
};
const orderOf = async (api, shop, orderId) => (await api("getOrders", { org: shop.orgId })).orders.find(o => o.orderId === orderId);
const setPod = (api, shop, orderId, on) => api("setPayOnDelivery", { org: shop.orgId, orderId, on }, { allowError: true, withStatus: true });
const openLocalSale = async (page, shop) => {
  await ordersPage(page, shop);
  await page.getByRole("button", { name: "+ Local sale" }).click();
  const form = page.locator("#localSaleForm");
  await expect(form).toBeVisible();
  return form;
};
// A user of `role`'s own API (signed-in cookie from the setup project).
async function asApi(role, workerIndex, fn) {
  const ctx = await apiContext(role, workerIndex);
  try { return await fn((action, body) => callApi(ctx, action, body, { allowError: true, withStatus: true })); }
  finally { await ctx.dispose(); }
}

// ---- Off until Global settings allows it --------------------------------------------------------------------
test("Pay on delivery is off until Global settings allows it: no button, no Local sale box, and the server refuses", async ({ page, api }) => {
  expect((await globalPayments(api)).onDelivery, "Global settings → Payment on delivery starts off").not.toBe(true);
  const { shop, order } = await shopWithOrder(api, page);
  await ordersPage(page, shop);
  await expect(markPaid(page, order.orderId)).toBeVisible();
  await expect(podOn(page, order.orderId)).toHaveCount(0);
  await expect(paidCell(page, order.orderId)).toHaveText("Unpaid");

  const form = await openLocalSale(page, shop);
  await expect(form.locator("#lsPaid")).toBeVisible();
  await expect(form.locator("#lsPod")).toHaveCount(0);
  await form.locator(".admin-pass-cancel").click();

  let r = await setPod(api, shop, order.orderId, true);
  expect(r.status).toBe(409);
  expect(r.data.message).toBe("Payment on delivery isn't allowed for this shop (Global settings and Shop settings → Payment methods).");
  r = await api("createLocalSale", { org: shop.orgId, items: [{ productId: shop.products[0].productId, size: "", qty: 1 }], paymentMethod: "cash",
    customerName: uniq("Lane Localsale"), payOnDelivery: true }, { allowError: true, withStatus: true });
  expect(r.status).toBe(409);
  expect(r.data.message).toMatch(/^Payment on delivery isn't allowed for this shop/);
  expect((await orderOf(api, shop, order.orderId)).payOnDelivery).toBe(false);
});

// ---- The settings pages -------------------------------------------------------------------------------------
test("Global settings shows the two Payment on delivery boxes as saved, and Save sends them with the payment methods", async ({ page, api }) => {
  await withGlobalPod(api, {}, async () => {
    await openAdmin(page, "settings");
    const pod = page.locator("#gPayOnDelivery"), local = page.locator("#gPayOnDeliveryLocal");
    await expect(page.getByLabel("Payment on delivery", { exact: true })).toBeChecked();
    await expect(pod).toBeChecked();
    await expect(local).not.toBeChecked();
    await local.check();
    // The save is answered here with what the page sent: a real page Save writes every section, which other specs
    // change for a moment at the same time.
    let sent = null;
    await page.route("**/api/orders", async (route) => {
      const body = JSON.parse(route.request().postData() || "{}");
      if (body.action !== "saveGlobalSettingsAll") return route.continue();
      sent = body;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "ok", settings: {}, belowTarget: [] }) });
    });
    await page.getByRole("button", { name: "Save global settings" }).click();
    await expect(toast(page)).toContainText("Global settings saved.");
    expect(sent.settings.payments).toMatchObject({ onDelivery: true, onDeliveryLocalOnly: true });
    await page.unroute("**/api/orders");
    await leaveAdmin(page);
  });
});

test("Shop settings: a shop that unticks Payment on delivery gets no button while Global settings allows it", async ({ page, api }) => {
  await withGlobalPod(api, {}, async () => {
    const { shop, order } = await shopWithOrder(api, page);
    // Allowed globally and (by default) by the shop: the button is there.
    await ordersPage(page, shop);
    await expect(podOn(page, order.orderId)).toBeVisible();

    await openAdmin(page, "catalog/orgs/" + shop.orgId + "/edit");
    await expect(page.getByRole("heading", { name: "Shop settings", level: 2 })).toBeVisible();
    await expect(page.locator("#orgFormPayOnDelivery")).toBeChecked();
    await expect(page.locator("#orgFormPayOnDeliveryLocal")).not.toBeChecked();
    await page.locator("#orgFormPayOnDelivery").uncheck();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page).toHaveURL(/#catalog$/);
    const saved = (await api("listOrgsAdmin")).orgs.find(o => o.orgId === shop.orgId);
    expect(saved.enabledPayments).toMatchObject({ onDelivery: false, onDeliveryLocalOnly: false, zelle: true, check: true });

    // Saving is enough (no Publish): the row has no button, and the server refuses.
    await ordersPage(page, shop);
    await expect(markPaid(page, order.orderId)).toBeVisible();
    await expect(podOn(page, order.orderId)).toHaveCount(0);
    const r = await setPod(api, shop, order.orderId, true);
    expect(r.status).toBe(409);
    expect(r.data.message).toMatch(/^Payment on delivery isn't allowed for this shop/);
  });
});

// ---- On an order ------------------------------------------------------------------------------------------
test("Pay on delivery on an unpaid order: every step goes ahead to delivered, and it's completed once paid", async ({ page, api }) => {
  await withGlobalPod(api, {}, async () => {
    const vendor = uniq("Test Blank Co");
    await api("saveVendor", { vendor: { name: vendor, forBlanks: true } });
    const { shop, order } = await shopWithOrder(api, page);
    const id = order.orderId;
    await ordersPage(page, shop);
    // Unpaid: no stage list.
    await expect(stageSelect(page, id)).toHaveCount(0);

    await podOn(page, id).click();
    await expect(page.locator(".confirm-modal")).toContainText("Set order " + id + " to pay on delivery?");
    await confirmOk(page);
    await expect(toast(page)).toContainText("Order " + id + " is pay on delivery.");
    await expect(paidCell(page, id)).toHaveText("Unpaid · on delivery");
    await expect(actionCell(page, id)).toContainText("Pay on delivery");
    await expect(podOff(page, id)).toBeVisible();
    await expect(podOn(page, id)).toHaveCount(0);
    await expect(markPaid(page, id)).toBeVisible();
    await expect(stageSelect(page, id)).toBeVisible();

    const pick = async (label) => {
      await expect(stageSelect(page, id).locator("option", { hasText: new RegExp("^" + label + "$") })).toHaveCount(1);
      await stageSelect(page, id).selectOption({ label });
    };
    await pick("blank ordered");
    const form = page.locator("#blankOrderForm");
    await form.locator("#blankVendorSelect").selectOption({ label: vendor });
    await form.getByRole("button", { name: "Mark blank ordered" }).click();
    await expect(form).toHaveCount(0);
    await expect(stageCell(page, id, "blankOrderedAt")).toContainText(vendor);
    await pick("blank received");
    await page.locator("#brConfirm").click();
    await expect(stageCell(page, id, "blankReceivedAt")).toContainText(/\d/);
    for (const [label, field] of [["digitizing complete", "digitizingCompleteAt"], ["manufactured", "manufacturedAt"], ["QA and packed", "qaPackedAt"]]) {
      await pick(label);
      await confirmOk(page);
      await expect(stageCell(page, id, field)).toContainText(/\d/);
    }
    await pick("shipped");
    await page.locator(".tracking-input").fill("TRACK-E2E-POD");
    await page.getByRole("button", { name: "Mark shipped" }).click();
    await expect(stageCell(page, id, "shippedAt")).toContainText(/\d/);
    // Delivered: not completed, a balance is still due.
    await pick("delivered");
    await confirmOk(page);
    await expect(toast(page)).toContainText("1 delivered order can't be completed yet — a balance is still due.");
    await expect(stageCell(page, id, "deliveredAt")).toContainText(/\d/);
    await expect(actionCell(page, id).getByRole("button", { name: "Mark completed" })).toHaveCount(0);
    let o = await orderOf(api, shop, id);
    expect(o.payOnDelivery).toBe(true);
    expect(o.paid).toBe(false);
    expect(o.completedAt || "").toBe("");

    // Paid on delivery: Mark as paid, then Mark completed.
    await markPaid(page, id).click();
    await confirmOk(page);
    await expect(paidCell(page, id)).toHaveText("Paid");
    await expect(podOff(page, id)).toHaveCount(0);
    await actionCell(page, id).getByRole("button", { name: "Mark completed" }).click();
    await confirmOk(page);
    await expect.poll(async () => (await orderOf(api, shop, id)).completedAt || "").not.toBe("");

    // One audit entry for the change.
    const { entries } = await api("getAuditLog", { orderId: id, filter: "order.pay_on_delivery_set", limit: 20 });
    const mine = entries.filter(e => e.action === "order.pay_on_delivery_set");
    expect(mine).toHaveLength(1);
    expect(JSON.stringify(mine[0].detail)).toContain('"to":true');
  });
});

test("Not pay on delivery puts the order back to waiting for payment", async ({ page, api }) => {
  await withGlobalPod(api, {}, async () => {
    const { shop, order } = await shopWithOrder(api, page);
    const id = order.orderId;
    expect((await setPod(api, shop, id, true)).status).toBe(200);
    await ordersPage(page, shop);
    await expect(paidCell(page, id)).toHaveText("Unpaid · on delivery");
    await expect(stageSelect(page, id)).toBeVisible();

    await podOff(page, id).click();
    await expect(page.locator(".confirm-modal")).toContainText("Take pay on delivery off order " + id + "?");
    await confirmOk(page);
    await expect(toast(page)).toContainText("Order " + id + " waits for payment again.");
    await expect(paidCell(page, id)).toHaveText("Unpaid");
    await expect(stageSelect(page, id)).toHaveCount(0);
    await expect(podOn(page, id)).toBeVisible();
    await expect(podOff(page, id)).toHaveCount(0);
    expect((await orderOf(api, shop, id)).payOnDelivery).toBe(false);
  });
});

// ---- Who may set it -----------------------------------------------------------------------------------------
test("Set orders to pay on delivery: Manager has it; Back office and Production see no button and the server refuses them", async ({ api, as }, testInfo) => {
  await withGlobalPod(api, {}, async () => {
    const shop = await makeShop(api, { prefix: "podr", products: [{ name: "Sample Tee", price: 20 }] });
    const customer = await as(null);
    const a = await placeOrder(customer, shop, { customer: uniq("Casey Customer") });
    const b = await placeOrder(customer, shop, { customer: uniq("Casey Customer") });

    // Back office: Mark as paid, but no Pay on delivery; the server says why.
    const staff = await as("staff");
    await ordersPage(staff, shop);
    await expect(markPaid(staff, a.orderId)).toBeVisible();
    await expect(podOn(staff, a.orderId)).toHaveCount(0);
    for (const role of ["staff", "production"]) {
      const r = await asApi(role, testInfo.workerIndex, (call) => call("setPayOnDelivery", { org: shop.orgId, orderId: a.orderId, on: true }));
      expect(r.status, role).toBe(403);
    }
    const r = await asApi("staff", testInfo.workerIndex, (call) => call("createLocalSale", { org: shop.orgId,
      items: [{ productId: shop.products[0].productId, size: "", qty: 1 }], paymentMethod: "cash", customerName: uniq("Lane Localsale"), payOnDelivery: true }));
    expect(r.status).toBe(403);
    expect(r.data.message).toBe("Your role can't set orders to pay on delivery. Ask an admin.");
    const lsForm = await openLocalSale(staff, shop);
    await expect(lsForm.locator("#lsPod")).toHaveCount(0);
    await lsForm.locator(".admin-pass-cancel").click();

    // Manager: sets it through the page.
    const manager = await as("manager");
    await ordersPage(manager, shop);
    await podOn(manager, b.orderId).click();
    await confirmOk(manager);
    await expect(paidCell(manager, b.orderId)).toHaveText("Unpaid · on delivery");
    await expect(podOff(manager, b.orderId)).toBeVisible();

    // Back office sees it marked, with the stage list, but can't take it off.
    await ordersPage(staff, shop);
    await expect(paidCell(staff, b.orderId)).toHaveText("Unpaid · on delivery");
    await expect(stageSelect(staff, b.orderId)).toBeVisible();
    await expect(podOff(staff, b.orderId)).toHaveCount(0);
    const off = await asApi("staff", testInfo.workerIndex, (call) => call("setPayOnDelivery", { org: shop.orgId, orderId: b.orderId, on: false }));
    expect(off.status).toBe(403);
    expect((await orderOf(api, shop, b.orderId)).payOnDelivery).toBe(true);
  });
});

// ---- Only for local sales -----------------------------------------------------------------------------------
test("Only for local sales: no button on the row, but the Local sale window records an unpaid sale with its steps open", async ({ page, api }) => {
  await withGlobalPod(api, { localOnly: true }, async () => {
    const { shop, order } = await shopWithOrder(api, page, { payments: PAYMENTS });
    await ordersPage(page, shop);
    await expect(markPaid(page, order.orderId)).toBeVisible();
    await expect(podOn(page, order.orderId)).toHaveCount(0);
    const r = await setPod(api, shop, order.orderId, true);
    expect(r.status).toBe(409);
    expect(r.data.message).toMatch(/^This shop allows payment on delivery only for local sales/);

    const form = await openLocalSale(page, shop);
    const customer = uniq("Lee Walkin");
    await form.locator("#lsProduct").selectOption({ label: "Sample Tee" });
    await form.locator("#lsQty").fill("1");
    await form.locator("#lsPayment").selectOption("Cash");
    await form.locator("summary", { hasText: "Customer info" }).click();
    await form.locator("#lsName").fill(customer);
    // Both boxes: refused in the window.
    await form.locator("#lsPaid").check();
    await form.locator("#lsPod").check();
    await form.getByRole("button", { name: "Record sale" }).click();
    await expect(form.locator("#lsErr")).toHaveText("Tick Paid or Pay on delivery, not both.");
    await form.locator("#lsPaid").uncheck();
    const sent = page.waitForRequest(req => req.url().endsWith("/api/orders") && /"action":"createLocalSale"/.test(req.postData() || ""));
    await form.getByRole("button", { name: "Record sale" }).click();
    const body = JSON.parse((await sent).postData());
    expect(body.payOnDelivery).toBe(true);
    expect(body.paid).toBe(false);
    await expect(toast(page)).toContainText("Local sale recorded — ");

    const row = page.locator("tr[data-order]", { hasText: customer }).first();
    await expect(row.locator("td[data-paid-td]")).toHaveText("Unpaid · on delivery");
    await expect(row.locator("td[data-action-td] select")).toBeVisible();
    await expect(row.locator("td[data-action-td]").getByRole("button", { name: "Not pay on delivery", exact: true })).toBeVisible();
    const made = (await api("getOrders", { org: shop.orgId })).orders.find(o => o.customerName === customer);
    expect(made.payOnDelivery).toBe(true);
    expect(made.paid).toBe(false);
  });
});
