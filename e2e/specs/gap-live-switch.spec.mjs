// The Live / Coming soon switch at the server (bug 5 of e2e/README.md, fixed in 343e242).
//
// The switch (the shop bar's role="switch", setOrgReady) changes the shop's published copy as well as its draft
// (functions/_lib/db.js setOrgReady), so "Show coming soon" stops orders at once and "Go live" opens the shop at
// once, neither needing Publish — and a shop that had nothing else changed still reads as published. Order placing
// reads the published copy (functions/api/orders.js, getPublishedOrg) and refuses a closed shop with 403 "This shop
// is not currently accepting orders."
//
// One shop of this file's own, made with the owner's API; the switch is used on the admin page and the orders are
// placed on the shop's own page, by a shopper with a browser (and client address) of their own. Nothing
// install-wide is changed.
import { test, expect, shopUrl, openAdmin, toast, confirmDialog, uniq } from "../fixtures.mjs";
import { makeShop, placeOrder } from "../lib/data.mjs";

test.describe.configure({ mode: "serial" });

const REFUSED = "This shop is not currently accepting orders.";
let shop;

// The shop bar on the shop's Products page, loaded afresh (so it shows what the server says now).
async function shopBar(page) {
  await openAdmin(page, "catalog/orgs/" + shop.orgId + "/products");
  return page.getByRole("navigation", { name: "Shop" });
}
// A product's card on the shop page (the block holding its heading and its Add to cart button).
const card = (page, name) => page.locator("main").getByRole("heading", { level: 3, name, exact: true })
  .locator("xpath=ancestor::*[.//button[normalize-space()='Add to cart']][1]");
// The owner's word on the shop: never published, published and current, or changed since.
const publishState = async (api) => (await api("getPublishState")).publishState[shop.orgId];

test("Show coming soon: an order already in the cart is refused by the server, and nothing waits to publish", async ({ page, api, as }) => {
  shop = await makeShop(api, { prefix: "live", products: [{ name: uniq("Sample Tee"), price: 20 }] });
  expect((await publishState(api)).state).toBe("current");

  // A shopper opens the shop while it is live and gets as far as Place order.
  const shopper = await as(null);
  await shopper.goto(shopUrl(shop.subdomain) + "/");
  await expect(shopper.getByRole("heading", { level: 1, name: shop.name })).toBeVisible();
  await card(shopper, shop.products[0].name).getByRole("button", { name: "Add to cart" }).click();
  await shopper.getByLabel("Your name").fill("Casey Latecomer");
  await shopper.getByLabel("Email address").fill("latecomer@example.test");
  await shopper.getByLabel("Payment method").selectOption({ label: "Check" });

  // Meanwhile the owner puts the shop on Coming soon (and does not publish).
  let bar = await shopBar(page);
  await bar.getByRole("switch").click();
  await confirmDialog(page, "Show coming soon");
  await expect(toast(page)).toContainText("now shows “Coming soon”");
  await expect(bar.getByRole("switch")).toHaveText("Coming soon");

  // The shopper's page still shows the products it loaded; the order it sends is refused by the server.
  const [res] = await Promise.all([
    shopper.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/orders"),
    shopper.getByRole("button", { name: "Place order" }).click(),
  ]);
  expect(res.status()).toBe(403);
  expect((await res.json()).message).toBe(REFUSED);
  await expect(shopper.locator("#checkoutMsg")).toContainText("your order could not be submitted (" + REFUSED + ")");
  await expect(shopper.getByRole("heading", { level: 2, name: /^Order received/ })).toHaveCount(0);
  expect((await api("getOrders", { org: shop.orgId })).orders).toEqual([]);

  // The switch changed the published copy too: the shop has nothing to publish, and the bar (read afresh) says so.
  expect((await publishState(api)).state).toBe("current");
  bar = await shopBar(page);
  await expect(bar.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  await expect(bar.getByRole("button", { name: "✓ Published" })).toBeDisabled();

  // A fresh load of the shop page shows Coming soon, without anyone pressing Publish.
  await shopper.reload();
  await expect(shopper.getByRole("heading", { level: 2, name: "Catalog coming soon" })).toBeVisible();
  await expect(shopper.getByRole("button", { name: "Place order" })).toHaveCount(0);
});

test("Go live, without Publish: the shopper's reload shows the products and the order goes through", async ({ page, api, as }) => {
  const shopper = await as(null);
  await shopper.goto(shopUrl(shop.subdomain) + "/");
  await expect(shopper.getByRole("heading", { level: 2, name: "Catalog coming soon" })).toBeVisible();

  const bar = await shopBar(page);
  await bar.getByRole("switch").click();
  await confirmDialog(page, "Go live");
  await expect(toast(page)).toContainText("is open for orders.");
  await expect(bar.getByRole("switch")).toHaveText("Live");
  await expect(bar.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  expect((await publishState(api)).state).toBe("current");

  await shopper.reload();
  await expect(shopper.getByRole("heading", { level: 3, name: shop.products[0].name, exact: true })).toBeVisible();
  await expect(shopper.getByRole("button", { name: "Place order" })).toBeVisible();
  await expect(shopper.getByRole("heading", { level: 2, name: "Catalog coming soon" })).toHaveCount(0);
  // …and the server takes the order now.
  const { orderId } = await placeOrder(shopper, shop, { customer: "Casey Ontime", email: "ontime@example.test" });
  const orders = (await api("getOrders", { org: shop.orgId })).orders;
  expect(orders.map(o => o.orderId)).toEqual([orderId]);

  const after = await shopBar(page);
  await expect(after.getByRole("button", { name: "✓ Published" })).toBeDisabled();
});
