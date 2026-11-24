// Orders from Home, and the Orders filters that need no reload (review #23, #62, #64; report rows 52.41, 52.39).
//
// - Home's step lists (#home/<step>) show open orders of any age, oldest first, while the Orders page shows only its
//   date range (the last 30 days at first). "Open order …" on an older order widens the range back to the day it was
//   placed (public/admin.js openOrderFromDashboard_), so the order is there when its shop's Orders open. orders.spec's
//   "Home's New tile…" covers only today's order, which the default range already holds.
// - Include completed and Include cancelled only filter the orders the page has already loaded (ordersSetInclude →
//   redrawOrdersView_): ticking them redraws the list from those, without asking the server for the list again
//   (getOrders). orders.spec's "filters…" checks which rows show, not that nothing was reloaded.
//
// Every test makes its own shop and orders (Local sales through the owner's API, as Record sale sends them) and only
// ever looks at those: other specs use the same install at the same time.
import { test, expect, openAdmin, uniq, ADMIN } from "../fixtures.mjs";
import { makeShop } from "../lib/data.mjs";

// ---- helpers ---------------------------------------------------------------------------------------------
// The shop's Orders page, as a real page load.
const ordersPage = async (page, shop) => {
  if (page.url().startsWith(ADMIN)) await page.goto("about:blank");
  await openAdmin(page, "orders/" + shop.orgId);
  await expect(page.getByRole("combobox", { name: "Shop" })).toHaveValue(shop.orgId);
};
// An order's first table row (the order cells sit on the first of its line rows).
const orderRow = (page, orderId) => page.locator(`tr[data-order="${orderId}"]`).first();
// A calendar day n days from today, YYYY-MM-DD (UTC; the e2e install's time zone stays UTC).
const dayInDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
// A Local sale of the shop's first product, on `placedAt` (YYYY-MM-DD, or now), recorded through the owner's API.
const localSale = async (api, shop, { placedAt, paid = false, delivered = false, customer } = {}) => {
  const r = await api("createLocalSale", { org: shop.orgId, customerName: customer || uniq("Casey Customer"), paymentMethod: "Cash",
    ...(placedAt ? { placedAt } : {}), paid, delivered, items: [{ productId: shop.products[0].productId, qty: 1 }] });
  expect(r.orderId).toBeTruthy();
  return r.orderId;
};
const readOrder = async (api, orgId, orderId) => (await api("getOrders", { org: orgId })).orders.find(o => o.orderId === orderId);
// Every POST /api/orders the page sends from now on, by action.
const recordActions = (page) => {
  const actions = [];
  page.on("request", (req) => {
    if (req.method() !== "POST" || !/\/api\/orders(\?|$)/.test(req.url())) return;
    try { actions.push(JSON.parse(req.postData() || "{}").action); } catch (e) { /* not JSON */ }
  });
  return actions;
};

// ---- Home → an old order ---------------------------------------------------------------------------------
test("Home's New list: Open order on a 45-day-old order opens its shop's Orders with the range widened to that day", async ({ page, api }) => {
  const shop = await makeShop(api, { prefix: "homeold", products: [{ name: "Sample Tee", price: 20 }], publish: false });
  const placed = dayInDays(-45);
  const orderId = await localSale(api, shop, { placedAt: placed });   // unpaid: waiting on the New step
  const order = await readOrder(api, shop.orgId, orderId);
  expect(order, "order " + orderId).toBeTruthy();

  // The Orders page on its own (last 30 days) doesn't list it.
  await ordersPage(page, shop);
  await expect(page.locator("#ordFilterFrom")).toHaveValue(dayInDays(-30));
  await expect(orderRow(page, orderId)).toHaveCount(0);

  // Home → New: the order is listed; its order number opens it.
  await openAdmin(page, "home/new");
  const open = page.getByRole("button", { name: "Open order " + orderId });
  await expect(open).toBeVisible();
  await open.click();
  await expect(page.getByRole("combobox", { name: "Shop" })).toHaveValue(shop.orgId);
  await expect(orderRow(page, orderId)).toBeVisible();
  // The From date now reaches back to the day it was placed (or before); To still reaches today.
  const from = await page.locator("#ordFilterFrom").inputValue();
  expect(from <= placed, `From ${from} is on or before ${placed}`).toBe(true);
  expect(await page.locator("#ordFilterTo").inputValue() >= dayInDays(0)).toBe(true);
  // No "isn't in this list" message.
  await expect(page.getByText(/isn't in this list/)).toHaveCount(0);
});

// ---- the include boxes filter what's loaded ----------------------------------------------------------------
test("Include cancelled and Include completed show and hide orders without loading the list again", async ({ page, api }) => {
  // A cap that needs no blank, so a Local sale paid and handed over can be completed at once.
  const shop = await makeShop(api, { prefix: "incl", publish: false,
    products: [{ name: "Sample Cap", price: 15, type: "cap", idPrefix: "cap", extra: { noBlankNeeded: true } }] });
  const open = await localSale(api, shop);
  const cancelled = await localSale(api, shop);
  const completed = await localSale(api, shop, { paid: true, delivered: true });
  // Cancel the second order's only line: the whole order counts as cancelled.
  const line = (await readOrder(api, shop.orgId, cancelled)).items[0];
  await api("cancelLineItem", { org: shop.orgId, sheetRow: Number(line.sheetRow), reason: "e2e: cancelled" });
  const done = await api("setOrderCompleted", { org: shop.orgId, orderIds: [completed], completed: true });
  expect(done.updated, JSON.stringify(done)).toBe(1);

  await ordersPage(page, shop);
  const cancelledBox = page.getByRole("checkbox", { name: "Include cancelled" });
  const completedBox = page.getByRole("checkbox", { name: "Include completed" });
  await expect(cancelledBox).not.toBeChecked();
  await expect(completedBox).not.toBeChecked();
  await expect(orderRow(page, open)).toBeVisible();
  await expect(orderRow(page, cancelled)).toHaveCount(0);
  await expect(orderRow(page, completed)).toHaveCount(0);

  const actions = recordActions(page);
  await cancelledBox.check();
  await expect(orderRow(page, cancelled)).toBeVisible();
  await expect(orderRow(page, completed)).toHaveCount(0);
  await completedBox.check();
  await expect(orderRow(page, completed)).toBeVisible();
  await expect(orderRow(page, cancelled)).toBeVisible();
  await expect(orderRow(page, open)).toBeVisible();
  await cancelledBox.uncheck();
  await expect(orderRow(page, cancelled)).toHaveCount(0);
  await expect(orderRow(page, completed)).toBeVisible();
  await completedBox.uncheck();
  await expect(orderRow(page, completed)).toHaveCount(0);
  await expect(orderRow(page, open)).toBeVisible();
  // None of that asked the server for the list.
  expect(actions, "requests sent while ticking the boxes").not.toContain("getOrders");
  expect(actions).not.toContain("getOrdersAllShops");

  // Refresh does load the list again, so the recording above would have caught a reload.
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect.poll(() => actions).toContain("getOrders");
  await expect(orderRow(page, open)).toBeVisible();
});
