// Orders priced from the published catalog (review #52, r#38): a price change saved on the product form is a draft
// until Publish, and it is the PUBLISHED price a storefront order costs, never the draft one. catalog.spec checks
// the price the shop page shows; this file checks what the order itself costs: the customer's confirmation total
// and the line the owner sees on the Orders page, before Publish and after it.
//
// The server prices every storefront line from the shop's published catalog (functions/api/orders.js, priceLookups
// / getPublishedOrg in the storefront order action); the browser's own prices are never trusted.
//
// The test makes its own shop and only reads that shop's orders: other specs use the same install at once.
import { test, expect, openAdmin, toast, uniq } from "../fixtures.mjs";
import { makeShop, placeOrder } from "../lib/data.mjs";

// The shop's Orders page, as a real page load.
const ordersPage = async (page, shop) => {
  await openAdmin(page, "orders/" + shop.orgId);
  await expect(page.getByRole("combobox", { name: "Shop" })).toHaveValue(shop.orgId);
};
// An order's rows on the Orders page (one per line; this file's orders have one line each).
const orderRows = (page, orderId) => page.locator(`tr[data-order="${orderId}"]`);

test("a storefront order costs the published price until Publish, and the new price after", async ({ page, api, as }) => {
  const scarf = uniq("Sample Scarf");
  const shop = await makeShop(api, { prefix: "pubprice", products: [{ name: scarf, price: 18, idPrefix: "scarf" }] });
  const productId = shop.products[0].productId;

  // The owner changes the price to $22 on the product form and saves it: a draft (as in catalog.spec's
  // "a price change stays a draft…").
  await openAdmin(page, "catalog/orgs/" + shop.orgId + "/products/" + productId + "/edit");
  await page.locator("#prodFormFlatPrice").fill("22");
  await page.getByRole("button", { name: "Save changes" }).first().click();
  const check = page.getByRole("dialog", { name: "Price check — " + scarf });
  await expect(check.getByRole("row", { name: /^One price \$22\.00/ })).toBeVisible();
  await check.getByRole("button", { name: "Back to products" }).click();
  await expect(toast(page)).toContainText("Saved.");
  await expect(page.locator("main tr", { hasText: scarf })).toContainText("$22.00 flat");

  // Before Publish: a customer's order is priced at the published $18.
  const before = await placeOrder(await as(null), shop, { customer: uniq("Casey Draftprice") });
  expect(before.total).toBe("18.00");
  await ordersPage(page, shop);
  await expect(orderRows(page, before.orderId)).toHaveCount(1);
  await expect(orderRows(page, before.orderId)).toContainText(scarf);
  await expect(orderRows(page, before.orderId)).toContainText("$18.00");
  await expect(orderRows(page, before.orderId)).not.toContainText("$22.00");

  // Publish, from Manage catalog's row for the shop.
  await openAdmin(page, "catalog");
  const row = page.locator("main tr", { hasText: shop.orgId });
  await expect(row).toContainText("Unpublished changes");
  await row.getByRole("button", { name: "Publish" }).click();
  await expect(page.locator("main tr", { hasText: shop.orgId })).toContainText("✓ Published");

  // After Publish: a new order costs $22, and the earlier order keeps the $18 it was placed at.
  const after = await placeOrder(await as(null), shop, { customer: uniq("Casey Newprice") });
  expect(after.total).toBe("22.00");
  await ordersPage(page, shop);
  await expect(orderRows(page, after.orderId)).toHaveCount(1);
  await expect(orderRows(page, after.orderId)).toContainText("$22.00");
  await expect(orderRows(page, before.orderId)).toContainText("$18.00");
  await expect(orderRows(page, before.orderId)).not.toContainText("$22.00");
});
