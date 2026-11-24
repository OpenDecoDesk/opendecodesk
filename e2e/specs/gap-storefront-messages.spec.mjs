// Storefront messages and focus (review #52, #57). Three things a customer meets on a shop's page:
//   - /api/catalog failing for a passing reason (a 5xx) is not "no shop here": the page says it couldn't load
//     and offers Try again (public/storefront.js resolveCurrentOrg → renderLoadError), which reloads and, once
//     the catalog answers, draws the shop. Only a 404 gets the "link may be mistyped" page (storefront.spec).
//   - The order panel is redrawn whole on every quantity or delivery change; keepFocus_ puts keyboard focus back
//     on the control that had it, so Space can be pressed again on the same "+" and the arrow keys keep working
//     in the delivery choice.
//   - With no email provider (this install has none), the confirmation tells the customer to keep the order
//     number instead of promising an emailed copy (storefront.spec checks only that the promise is gone).
//
// Each test makes its own shop with the owner's API; everything tested is done through the shop's page.
import { test, expect, shopUrl, uniq } from "../fixtures.mjs";
import { makeShop, placeOrder } from "../lib/data.mjs";

const PRODUCTS = [{ name: "Sample Tee", price: 20 }];

test("a catalog that fails to load says so and offers Try again, which then draws the shop", async ({ as, api }) => {
  const shop = await makeShop(api, { prefix: "loaderr", products: PRODUCTS });
  const page = await as(null);
  const catalog = "**/api/catalog*";
  await page.route(catalog, (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ status: "error", message: "Service unavailable" }) }));
  await page.goto(shopUrl(shop.subdomain) + "/");
  const err = page.getByRole("alert");
  await expect(err.getByRole("heading", { level: 2, name: "We couldn't load this page" })).toBeVisible();
  await expect(err).toContainText("Check your connection, then try again.");
  // Not the "no shop at this address" page, which a 404 gets.
  await expect(page.getByRole("heading", { name: "Looking for your organization's order page?" })).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: shop.name })).toHaveCount(0);
  // The catalog answers again: Try again reloads the page and the shop is there.
  await page.unroute(catalog);
  await err.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { level: 1, name: shop.name })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "We couldn't load this page" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add to cart" })).toBeVisible();
});

test("the cart keeps keyboard focus across its redraws: Space twice on One more, then ArrowDown in Delivery", async ({ as, api }) => {
  const shop = await makeShop(api, { prefix: "focus", products: PRODUCTS });
  const page = await as(null);
  await page.goto(shopUrl(shop.subdomain) + "/");
  await expect(page.getByRole("heading", { level: 1, name: shop.name })).toBeVisible();
  await page.getByRole("button", { name: "Add to cart" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Your order (1 item)" })).toBeVisible();

  const more = page.getByRole("button", { name: "One more Sample Tee" });
  await more.focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("heading", { level: 2, name: "Your order (2 items)" })).toBeVisible();
  // The panel was redrawn; focus is on the new "One more" button, so Space works again.
  await expect(more).toBeFocused();
  await page.keyboard.press("Space");
  await expect(page.getByRole("heading", { level: 2, name: "Your order (3 items)" })).toBeVisible();
  await expect(more).toBeFocused();
  await expect(page.locator("main .t-amount")).toHaveText("$60.00");

  // The delivery choice: ArrowDown moves to Local delivery, the panel redraws with its fee, and focus stays there.
  const pickup = page.getByRole("radio", { name: /^Local pickup/ });
  const delivery = page.getByRole("radio", { name: /^Local delivery/ });
  await pickup.focus();
  await page.keyboard.press("ArrowDown");
  await expect(delivery).toBeChecked();
  await expect(page.locator("main .t-amount")).toHaveText("$65.00");
  await expect(delivery).toBeFocused();
  // …so ArrowUp goes back the same way.
  await page.keyboard.press("ArrowUp");
  await expect(pickup).toBeChecked();
  await expect(page.locator("main .t-amount")).toHaveText("$60.00");
  await expect(pickup).toBeFocused();
});

test("with no email set up, the confirmation tells the customer to keep the order number", async ({ as, api }) => {
  // This install has no email provider (no RESEND_API_KEY / CF_EMAIL_API_TOKEN / mailbox), so the server's answer
  // says emailOn: false.
  const shop = await makeShop(api, { prefix: "noemail", products: PRODUCTS });
  const page = await as(null);
  const order = await placeOrder(page, shop, { payment: "Check", customer: uniq("Casey Keepnumber"), email: "keepnumber@example.test" });
  const conf = page.locator(".confirmation");
  await expect(conf.locator(".order-number")).toContainText(order.orderId);
  await expect(conf).toContainText("Keep your order number for any question about this order.");
  await expect(conf).not.toContainText("emailed to");
});
