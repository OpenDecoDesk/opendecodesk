// Local sale with several items (review #106): a counter sale of a tee and a cap is one order with two lines, one
// payment and one confirmation, not two orders. The window starts with one item (its fields keep their ids:
// #lsProduct, #lsQty, …) and "+ Add another item" adds more, each with its own fields and a × to take it off again;
// the price box shows the running total. Record sale sends every item in one createLocalSale.
//
// Each test makes its own shop with the owner's API; the sale is recorded through the owner's admin page.
import { test, expect, ADMIN, openAdmin, toast, uniq } from "../fixtures.mjs";
import { makeShop } from "../lib/data.mjs";

const PRODUCTS = [{ name: "Sample Tee", price: 20 }, { name: "Sample Cap", price: 18 }];

const openLocalSale = async (page, shop) => {
  if (page.url() === ADMIN + "/#orders/" + shop.orgId) await page.goto("about:blank");
  await openAdmin(page, "orders/" + shop.orgId);
  await expect(page.getByRole("combobox", { name: "Shop" })).toHaveValue(shop.orgId);
  await page.getByRole("button", { name: "+ Local sale" }).click();
  const form = page.locator("#localSaleForm");
  await expect(form).toBeVisible();
  return form;
};

test("Local sale: two items make one order with two lines and one payment", async ({ page, api }) => {
  const shop = await makeShop(api, { prefix: "lsl", products: PRODUCTS });
  const customer = uniq("Jordan Twoitems");
  const form = await openLocalSale(page, shop);
  const items = form.locator(".ls-line");
  await expect(items).toHaveCount(1);
  // One item: no item numbers and no × yet.
  await expect(form.getByRole("button", { name: /^Remove item/ })).toHaveCount(0);

  await form.locator("#lsProduct").selectOption({ label: "Sample Tee" });
  await form.locator("#lsQty").fill("2");
  await expect(form.locator("#lsPricePreview")).toHaveText("$20.00 × 2 = $40.00");

  await form.getByRole("button", { name: "+ Add another item" }).click();
  await expect(items).toHaveCount(2);
  const second = items.nth(1);
  await expect(second).toContainText("Item 2");
  await expect(second.getByLabel("Product")).toBeFocused();
  await second.getByLabel("Product").selectOption({ label: "Sample Cap" });
  await expect(form.locator("#lsPricePreview")).toHaveText("Total for 2 items: $58.00");

  // A third, taken off again with its ×.
  await form.getByRole("button", { name: "+ Add another item" }).click();
  await expect(items).toHaveCount(3);
  await form.getByRole("button", { name: "Remove item 3" }).click();
  await expect(items).toHaveCount(2);
  await expect(form.locator("#lsPricePreview")).toHaveText("Total for 2 items: $58.00");

  await form.locator("#lsPayment").selectOption("Cash");
  await form.locator("summary", { hasText: "Customer info" }).click();
  await form.locator("#lsName").fill(customer);
  await form.locator("#lsPaid").check();
  const sent = page.waitForRequest(req => req.url().endsWith("/api/orders") && /"action":"createLocalSale"/.test(req.postData() || ""));
  await form.getByRole("button", { name: "Record sale" }).click();
  const body = JSON.parse((await sent).postData());
  expect(body.items.map(i => [i.name, i.qty])).toEqual([["Sample Tee", 2], ["Sample Cap", 1]]);
  await expect(toast(page)).toContainText("Local sale recorded — ");

  // One order, both lines on it, paid once for the whole $58.
  const mine = (await api("getOrders", { org: shop.orgId })).orders.filter(o => o.customerName === customer);
  expect(mine).toHaveLength(1);
  const order = mine[0];
  expect(order.items.filter(i => !i.cancelDate).map(i => [i.name, i.qty]).sort()).toEqual([["Sample Cap", 1], ["Sample Tee", 2]]);
  expect(order.total).toBe(58);
  expect(order.paid).toBeTruthy();
  expect((order.payments || []).filter(p => !p.voidedAt)).toHaveLength(1);
  // …and in the list, one order with both items on it.
  const rows = page.locator(`tr[data-order="${order.orderId}"]`);
  await expect(rows.filter({ hasText: "Sample Tee" })).toHaveCount(1);
  await expect(rows.filter({ hasText: "Sample Cap" })).toHaveCount(1);
  // Every row with this customer is that one order's (no second order for the cap).
  const theirs = page.locator("tr[data-order]", { hasText: customer });
  await expect(theirs.first()).toBeVisible();
  expect([...new Set(await theirs.evaluateAll(trs => trs.map(tr => tr.dataset.order)))]).toEqual([order.orderId]);
});

test("Local sale: an item that can't be read names its number, and nothing is recorded", async ({ page, api }) => {
  const shop = await makeShop(api, { prefix: "lsl", products: PRODUCTS });
  const form = await openLocalSale(page, shop);
  await form.locator("#lsProduct").selectOption({ label: "Sample Tee" });
  await form.getByRole("button", { name: "+ Add another item" }).click();
  // The second item is a custom one with no description.
  await form.locator(".ls-line").nth(1).getByLabel("Product").selectOption({ label: "— Custom item —" });
  await form.locator("#lsPayment").selectOption("Cash");
  let asked = false;
  page.on("request", (req) => { if (/"action":"createLocalSale"/.test(req.postData() || "")) asked = true; });
  await form.getByRole("button", { name: "Record sale" }).click();
  await expect(form.locator("#lsErr")).toHaveText("Item 2: Enter a description for the custom item.");
  await expect(form.locator(".ls-line").nth(1).getByLabel("Description")).toBeFocused();
  expect(asked).toBe(false);
  await form.getByRole("button", { name: "Cancel" }).click();
  await expect(form).toHaveCount(0);
});
