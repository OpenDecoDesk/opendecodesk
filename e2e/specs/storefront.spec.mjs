// The shop page a customer sees at <shop>.localhost: browsing, the cart, checking out without a card
// (check, Venmo, Zelle) with pickup or a delivery fee, the confirmation; a shop that isn't open and an address
// with no shop; the invoice page a customer opens from the admin's Send invoice link; and the design approval
// page. The shop and its products are made with the owner's API; everything tested is done through the pages.
import { test, expect, shopUrl, openAdmin, toast, pngBytes, apiContext, callApi } from "../fixtures.mjs";
import { makeShop, placeOrder } from "../lib/data.mjs";

test.describe.configure({ mode: "serial" });

let shop;

test.beforeAll(async ({ browser }, testInfo) => {
  // The owner's API (the `api` fixture is per test).
  const ctx = await apiContext("owner", testInfo.workerIndex);
  shop = await makeShop((a, b, o) => callApi(ctx, a, b, o), {
    prefix: "store",
    products: [
      { name: "Sample Tee", price: 20 },
      { name: "Sample Cap", price: 15, type: "cap", idPrefix: "cap" },
      { name: "Sample Hoodie", price: 0, idPrefix: "hood", extra: { pricingMode: "sized", sizePricing: { S: 30, M: 30, XL: 34 } } },
    ],
  });
  await ctx.dispose();
});

// A product's card on the shop page (the block holding its heading and its Add to cart button).
const card = (page, name) => page.locator("main").getByRole("heading", { level: 3, name, exact: true })
  .locator("xpath=ancestor::*[.//button[contains(@class,'add-btn')]][1]");
const cartTotal = (page) => page.locator("main .t-amount");
const placeButton = (page) => page.getByRole("button", { name: "Place order" });
// The order's first row on the admin's Orders page (the one with its select box and action buttons).
const orderRow = (page, orderId) => page.locator("tr", { has: page.getByRole("checkbox", { name: "Select order " + orderId }) });
// The shop's Orders page, loaded afresh (going to the same #address again would not reload it).
async function openOrders(admin) {
  await admin.goto("about:blank");
  await openAdmin(admin, "orders/" + shop.orgId);
}

test("the shop page lists its categories and products with prices, and offers no card payment", async ({ as }) => {
  const page = await as(null);
  await page.goto(shopUrl(shop.subdomain) + "/");
  await expect(page.getByRole("heading", { level: 1, name: shop.name })).toBeVisible();
  const jump = page.getByRole("navigation", { name: "Jump to category" });
  await expect(jump.getByRole("link", { name: "Shirts" })).toHaveAttribute("href", "#cat-shirt");
  await expect(jump.getByRole("link", { name: "Caps" })).toHaveAttribute("href", "#cat-cap");
  const shirts = page.getByRole("region", { name: "Shirts" }), caps = page.getByRole("region", { name: "Caps" });
  await expect(shirts.getByRole("heading", { level: 3, name: "Sample Tee" })).toBeVisible();
  await expect(shirts.getByRole("heading", { level: 3, name: "Sample Hoodie" })).toBeVisible();
  await expect(shirts.getByRole("heading", { level: 3, name: "Sample Cap" })).toHaveCount(0);
  await expect(caps.getByRole("heading", { level: 3, name: "Sample Cap" })).toBeVisible();
  await expect(card(page, "Sample Tee")).toContainText("$20.00");
  await expect(card(page, "Sample Cap")).toContainText("$15.00");
  // A product priced by size: "from" the lowest price, with a size list.
  await expect(card(page, "Sample Hoodie")).toContainText("from $30.00");
  await expect(page.getByLabel("Size for Sample Hoodie").locator("option")).toHaveText(["S", "M", "XL"]);
  // Jumping to a category.
  await jump.getByRole("link", { name: "Caps" }).click();
  await expect(page).toHaveURL(/#cat-cap$/);
  await expect(caps).toBeInViewport();
  // Card payments need Stripe, which this install doesn't have: only the other methods are offered.
  await expect(page.getByLabel("Payment method").locator("option")).toHaveText(["How will you pay?", "Venmo", "Zelle", "Check"]);
  await expect(page.locator("main")).toContainText("Nothing added yet.");
  await expect(placeButton(page)).toBeDisabled();
});

test("the cart adds, counts and removes items and keeps the total", async ({ as }) => {
  const page = await as(null);
  await page.goto(shopUrl(shop.subdomain) + "/");
  // Two tees from the card's quantity box.
  await card(page, "Sample Tee").getByRole("spinbutton", { name: "Quantity for Sample Tee" }).fill("2");
  await card(page, "Sample Tee").getByRole("button", { name: "Add to cart" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Added Sample Tee to cart." })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Your order (2 items)" })).toBeVisible();
  await expect(cartTotal(page)).toHaveText("$40.00");
  await expect(placeButton(page)).toBeEnabled();
  // + and − in the cart.
  await page.getByRole("button", { name: "One more Sample Tee" }).click();
  await expect(cartTotal(page)).toHaveText("$60.00");
  await page.getByRole("button", { name: "One fewer Sample Tee" }).click();
  await page.getByRole("button", { name: "One fewer Sample Tee" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Your order (1 item)" })).toBeVisible();
  await expect(cartTotal(page)).toHaveText("$20.00");
  // A sized product: the XL price.
  await page.getByLabel("Size for Sample Hoodie").selectOption("XL");
  await card(page, "Sample Hoodie").getByRole("button", { name: "Add to cart" }).click();
  await expect(cartTotal(page)).toHaveText("$54.00");
  await expect(page.locator("main")).toContainText("Sample Hoodie");
  // Remove both lines.
  await page.getByRole("button", { name: "Remove Sample Tee" }).click();
  await expect(cartTotal(page)).toHaveText("$34.00");
  await page.getByRole("button", { name: /^Remove Sample Hoodie/ }).click();
  await expect(page.locator("main")).toContainText("Nothing added yet.");
  await expect(cartTotal(page)).toHaveText("$0.00");
  await expect(placeButton(page)).toBeDisabled();
});

test("the cart survives a reload of the page", async ({ as }) => {
  const page = await as(null);
  await page.goto(shopUrl(shop.subdomain) + "/");
  await card(page, "Sample Cap").getByRole("button", { name: "Add to cart" }).click();
  await expect(cartTotal(page)).toHaveText("$15.00");
  await page.reload();
  await expect(page.getByRole("heading", { level: 2, name: "Your order (1 item)" })).toBeVisible();
  await expect(cartTotal(page)).toHaveText("$15.00");
});

test("Place order asks for a name, a valid email and a payment method before sending anything", async ({ as }) => {
  const page = await as(null);
  let posted = 0;
  page.on("request", r => { if (r.method() === "POST" && r.url().endsWith("/api/orders")) posted++; });
  await page.goto(shopUrl(shop.subdomain) + "/");
  await card(page, "Sample Tee").getByRole("button", { name: "Add to cart" }).click();
  const msg = page.locator("#checkoutMsg");
  await placeButton(page).click();
  await expect(msg).toHaveText("Please add your name.");
  await expect(page.getByLabel("Your name")).toBeFocused();
  await page.getByLabel("Your name").fill("Casey Customer");
  await page.getByLabel("Email address").fill("not-an-email");
  await placeButton(page).click();
  await expect(msg).toHaveText(/^Please add a valid email address/);
  await page.getByLabel("Email address").fill("casey@example.test");
  await placeButton(page).click();
  await expect(msg).toHaveText("Please choose how you'll pay.");
  await expect(page.getByRole("heading", { level: 2, name: /^Order received/ })).toHaveCount(0);
  expect(posted).toBe(0);
});

test("choosing local delivery adds its fee to the total; pickup is free", async ({ as }) => {
  const page = await as(null);
  await page.goto(shopUrl(shop.subdomain) + "/");
  await card(page, "Sample Tee").getByRole("button", { name: "Add to cart" }).click();
  await expect(page.getByRole("radio", { name: "Local pickup — Free" })).toBeChecked();
  await expect(cartTotal(page)).toHaveText("$20.00");
  await page.getByRole("radio", { name: "Local delivery — $5.00" }).check();
  await expect(cartTotal(page)).toHaveText("$25.00");
  await page.getByRole("radio", { name: "Local pickup — Free" }).check();
  await expect(cartTotal(page)).toHaveText("$20.00");
});

test("paying by check with local delivery: the confirmation shows the order, the fee and how to pay", async ({ as, page: admin }) => {
  const page = await as(null);
  const order = await placeOrder(page, shop, { items: [{ name: "Sample Tee", qty: 2 }], payment: "Check", delivery: "Local delivery", customer: "Casey Check" });
  expect(order.total).toBe("45.00");
  expect(order.orderId).toMatch(/^STOR-[A-Z0-9]+-[A-Z0-9]+$/);
  const conf = page.locator(".confirmation");
  await expect(conf.getByRole("heading", { level: 2 })).toHaveText("Order received, Casey.");
  await expect(conf).toContainText("Sample Tee × 2");
  await expect(conf).toContainText("Local delivery");
  await expect(conf).toContainText("$5.00");
  await expect(conf.locator(".row.total")).toContainText("$45.00");
  await expect(conf).toContainText("Check payment");
  // The memo line names the order.
  await expect(conf.locator("strong", { hasText: order.orderId })).toBeVisible();
  // Back to the shop: the cart is empty again.
  await conf.getByRole("button", { name: "← Back to " + shop.name }).click();
  await expect(page.getByRole("heading", { level: 1, name: shop.name })).toBeVisible();
  await expect(page.locator("main")).toContainText("Nothing added yet.");
  // The owner sees the new order on the shop's Orders page, unpaid, by check.
  await openOrders(admin);
  const row = orderRow(admin, order.orderId);
  await expect(row).toContainText("Casey Check");
  await expect(row).toContainText("Check");
  await expect(row).toContainText("$45.00");
});

test("paying by Venmo or Zelle: the confirmation names the method", async ({ as }) => {
  for (const method of ["Venmo", "Zelle"]) {
    const page = await as(null);
    const order = await placeOrder(page, shop, { items: [{ name: "Sample Cap", qty: 1 }], payment: method, customer: "Casey " + method });
    expect(order.total).toBe("15.00");
    const conf = page.locator(".confirmation");
    await expect(conf).toContainText("Sample Cap × 1");
    await expect(conf).toContainText("Local pickup");
    await expect(conf).toContainText(method);
    await expect(conf).toContainText(order.orderId);
  }
});

// KNOWN BUG (reported): the confirmation always says "A copy of your order was emailed to …"
// (public/index.html, the confirmation page), even on an install with no email provider, where Global settings →
// Setup status says no email is sent at all. The customer is told to expect an email that never comes.
test("the confirmation doesn't promise an email the install can't send", async ({ as }) => {
  test.fail(true, "Known bug: the order confirmation says a copy was emailed even though no email provider is set up");
  // This install has no email provider (no RESEND_API_KEY / CF_EMAIL_API_TOKEN / mailbox).
  const page = await as(null);
  await placeOrder(page, shop, { payment: "Check", customer: "Casey Mailless", email: "mailless@example.test" });
  await expect(page.locator(".confirmation")).not.toContainText("was emailed to mailless@example.test", { timeout: 2000 });
});

test("a shop that isn't open says so and refuses orders", async ({ as, api }) => {
  const closed = await makeShop(api, { prefix: "soon", ready: false, products: [{ name: "Sample Tee", price: 20 }] });
  const page = await as(null);
  await page.goto(shopUrl(closed.subdomain) + "/");
  await expect(page.getByRole("heading", { level: 1, name: closed.name })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Catalog coming soon" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add to cart" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Place order" })).toHaveCount(0);
  // An order sent to it anyway (as a script would) is refused by the server.
  const res = await page.request.post(shopUrl(closed.subdomain) + "/api/orders", {
    headers: { Origin: shopUrl(closed.subdomain) },
    data: { orderId: "SOON-E2E-" + Date.now().toString(36).toUpperCase(), orgId: closed.orgId, customerName: "Casey Customer", contact: "casey@example.test",
      paymentMethod: "Check", items: [{ productId: closed.products[0].productId, name: "Sample Tee", size: "OSFA", qty: 1 }] },
  });
  expect(res.status()).toBe(403);
  expect((await res.json()).message).toBe("This shop is not currently accepting orders.");
});

test("an address with no shop shows the 'looking for your order page' page", async ({ as }) => {
  const page = await as(null);
  await page.goto(shopUrl("no-such-shop-" + Date.now().toString(36)) + "/");
  await expect(page.getByRole("heading", { level: 2, name: "Looking for your organization's order page?" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add to cart" })).toHaveCount(0);
});

test("invoice: the owner sends it from Orders, the customer opens the link, chooses delivery and sees what's owed", async ({ as, page: admin }) => {
  const customer = await as(null);
  const order = await placeOrder(customer, shop, { items: [{ name: "Sample Tee", qty: 1 }], payment: "Check", customer: "Ivy Invoice", email: "ivy@example.test" });
  expect(order.total).toBe("20.00");

  await openOrders(admin);
  await orderRow(admin, order.orderId).getByRole("button", { name: "Send invoice…" }).click();
  const modal = admin.locator(".admin-modal");
  await expect(modal.getByRole("heading", { name: "Send invoice" })).toBeVisible();
  await expect(modal.locator("#siEmail")).toHaveValue("ivy@example.test");
  await expect(modal.locator("#siDelivery")).toBeChecked();
  await modal.locator("#siMessage").fill("Thanks for your order from Example Club.");
  await modal.getByRole("button", { name: "Send invoice" }).click();
  // No email provider here: the window says so and gives the link to pass on.
  await expect(modal.locator("#siDone")).toContainText("The email couldn't be sent");
  const link = await modal.getByRole("textbox", { name: "Invoice link" }).inputValue();
  // The link is on the shop's own address (https://<shop>.<root domain>/?invoice=…); here that address answers
  // on the local port.
  expect(link).toMatch(new RegExp("^https://" + shop.subdomain + "\\.localhost/\\?invoice=[a-f0-9]{16,}$"));
  const token = new URL(link).searchParams.get("invoice");
  await modal.getByRole("button", { name: "Close", exact: true }).last().click();

  await customer.goto(shopUrl(shop.subdomain) + "/?invoice=" + token);
  const inv = customer.locator(".inv");
  await expect(inv.getByRole("heading", { level: 1, name: shop.name })).toBeVisible();
  await expect(inv).toContainText("Invoice for order " + order.orderId);
  await expect(inv).toContainText("Ivy Invoice");
  await expect(inv).toContainText("Thanks for your order from Example Club.");
  await expect(inv.locator("table.inv-items")).toContainText("Sample Tee");
  await expect(inv.locator("table.inv-items")).toContainText("$20.00");
  // Delivery is the customer's choice; until it's made, nothing names an amount to pay.
  const delivery = inv.getByRole("radiogroup", { name: "Delivery" });
  await expect(delivery.getByRole("radio")).toHaveCount(2);
  await delivery.getByRole("radio", { name: /Local delivery/ }).check();
  await inv.getByRole("button", { name: "Save my choice" }).click();
  await expect(inv).toContainText("Saved: Local delivery");
  await expect(inv.locator("table.inv-totals")).toContainText("$5.00");
  await expect(inv.locator("table.inv-totals")).toContainText("$25.00");
  // How to pay: by check (named on the order); no card button, since card payments aren't set up.
  await expect(inv.locator(".inv-pay")).toContainText("Check");
  await expect(inv.getByRole("button", { name: /by card/i })).toHaveCount(0);

  // The owner's Orders page: the invoice was opened and a delivery chosen; the order's total now has the fee.
  await openOrders(admin);
  const row = orderRow(admin, order.orderId);
  await expect(row.locator(".invoice-status")).toContainText("· opened");
  await expect(row.locator(".invoice-status")).not.toContainText("not opened");
  await expect(row.locator(".invoice-status")).toContainText("delivery chosen");
  await expect(row).toContainText("$25.00");
});

test("a broken invoice link says it isn't valid", async ({ as }) => {
  const page = await as(null);
  await page.goto(shopUrl(shop.subdomain) + "/?invoice=0123456789abcdef0123456789abcdef");
  await expect(page.locator(".inv .inv-err")).toBeVisible();
  await expect(page.locator(".inv")).not.toContainText("Invoice for order");
});

test("design approval: the owner sends a proof, the customer approves one order and asks for changes on another", async ({ as, page: admin, api }) => {
  const customer = await as(null);
  const a = await placeOrder(customer, shop, { payment: "Check", customer: "Dana Design", email: "dana@example.test" });
  const b = await placeOrder(customer, shop, { payment: "Zelle", customer: "Drew Design", email: "drew@example.test" });

  // Orders → select both → ✉ Send verification: a message and a proof picture (uploaded here).
  await openOrders(admin);
  await admin.getByRole("checkbox", { name: "Select order " + a.orderId }).check();
  await admin.getByRole("checkbox", { name: "Select order " + b.orderId }).check();
  await admin.getByRole("button", { name: "✉ Send verification" }).click();
  const modal = admin.locator(".admin-modal");
  await expect(modal.getByRole("heading", { name: "Send design verification" })).toBeVisible();
  await modal.locator("#dvMessage").fill("Here is the stitched logo for your Sample Tee. Please approve or ask for changes.");
  // Send without a picture: refused.
  await modal.locator("#dvSend").click();
  await expect(modal.locator("#dvError")).toHaveText("At least one design image is required.");
  await modal.locator("input[type=file][data-target=dvImg1]").setInputFiles({ name: "proof.png", mimeType: "image/png", buffer: pngBytes(48, 48, [200, 40, 40]) });
  await expect(modal.locator("#dvImg1Status")).toHaveText("✓");
  await expect(modal.locator("#dvImg1")).toHaveValue(/^https:\/\/images\.example\.test\/uploads\/verify\/[a-f0-9]+\.png$/);
  await modal.locator("#dvSend").click();
  // No email provider: the requests are recorded, the toast says the emails couldn't go.
  await expect(toast(admin)).toContainText("Verification email sent to 0 orders");
  await expect(toast(admin)).toContainText("email failed");

  // The link the email would carry is https://<shop>.<root>/?verify=<token>; the token is on the owner's
  // verification list (the data the Orders page loads).
  const list = await api("listDesignVerifications", { org: shop.orgId });
  const tokenOf = (id) => list.verifications.find(v => v.orderId === id).token;

  // Order A: approve.
  await customer.goto(shopUrl(shop.subdomain) + "/?verify=" + tokenOf(a.orderId));
  const dv = customer.locator(".dv");
  await expect(dv).toContainText("Design verification for order " + a.orderId);
  await expect(dv).toContainText("Here is the stitched logo for your Sample Tee.");
  const img = dv.getByRole("img", { name: "Design image" });
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate(e => e.complete && e.naturalWidth)).toBe(48);
  // Submit without choosing: refused.
  await expect(dv.locator("#dvSubmit")).toBeHidden();
  await dv.getByRole("button", { name: "✓ Approve design" }).click();
  await expect(dv.getByRole("button", { name: "✓ Approve design" })).toHaveAttribute("aria-pressed", "true");
  await dv.getByRole("button", { name: "Submit response" }).click();
  await expect(dv.getByRole("status")).toContainText("Design approved!");
  // Opening the link again shows the answer, not the form. (The page takes the token out of the address bar,
  // so this is the link itself again, not a reload.)
  await customer.goto(shopUrl(shop.subdomain) + "/?verify=" + tokenOf(a.orderId));
  await expect(customer.locator(".dv-banner")).toContainText("✓ You approved this design");
  await expect(customer.getByRole("button", { name: "Submit response" })).toHaveCount(0);

  // Order B: request changes — a note is required.
  await customer.goto(shopUrl(shop.subdomain) + "/?verify=" + tokenOf(b.orderId));
  await dv.getByRole("button", { name: "✏ Request changes" }).click();
  await dv.getByRole("button", { name: "Submit response" }).click();
  await expect(dv.locator("#dvError")).toHaveText("Please describe the changes needed.");
  await customer.getByLabel(/Describe the changes needed/).fill("Please make the logo a little larger.");
  await dv.getByRole("button", { name: "Submit response" }).click();
  await expect(dv.getByRole("status")).toContainText("Revision request sent");

  // The owner's Orders page shows both answers.
  await openOrders(admin);
  await expect(orderRow(admin, a.orderId)).toContainText("✓ Approved");
  await expect(orderRow(admin, b.orderId)).toContainText("⚠ Changes");
});

test("a broken design approval link says it's invalid", async ({ as }) => {
  const page = await as(null);
  await page.goto(shopUrl(shop.subdomain) + "/?verify=00000000000000000000000000000000");
  await expect(page.locator(".dv-msg.err")).toHaveText("This verification link is invalid or has expired.");
});
