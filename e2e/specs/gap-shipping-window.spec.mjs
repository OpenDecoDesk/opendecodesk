// Admin → Orders → a paid order's Set shipping / Edit shipping: the Shipping information window (admin.js
// showShippingModal) and what saving it does (setShippingInfo → orders.js setShippingInfo, setShippingPaidAmount,
// createShippingPaymentLink). No e2e test opened this window before.
// The local install has no Shippo key and no Stripe key, as a new install starts. So the window is tested for what it
// does without them: the address, weight and box save; Get rates checks what it needs and then says plainly that
// carrier shipping isn't set up; a shipping charge already on the order is shown, quoted in the email to the customer
// and kept by a save; Save & email payment link saves the shipping and says the link failed. The charge itself can
// only be changed from a carrier's rates (or the custom amount offered beside them), so without a carrier it is set
// up through the owner's API here, as an order placed with a shipping fee would carry it.
// Roles: Production has Edit on Shipping and nothing on Payments (functions/_lib/permissions.js) — the window hides
// Shipping paid and Get rates, keeps the charge, and the server refuses a ship-to state that would move the sales tax.
// Every test makes its own shop and order (unique names); nothing install-wide changes. Sales tax isn't switched on
// here: it is one install-wide rate that settings.spec checks is 0, so a ship-to state can't be shown moving the tax
// without disturbing the specs beside this one (the shops here are tax-exempt, as makeShop makes them).
import { test, expect, openAdmin, toast, uniq, ADMIN, apiContext, callApi } from "../fixtures.mjs";
import { makeShop, placeOrder } from "../lib/data.mjs";

// ---- helpers ---------------------------------------------------------------------------------------------
const ordersPage = async (page, shop) => {
  const target = ADMIN + "/#orders/" + shop.orgId;
  if (page.url() === target) await page.goto("about:blank");
  await openAdmin(page, "orders/" + shop.orgId);
  await expect(page.getByRole("combobox", { name: "Shop" })).toHaveValue(shop.orgId);
};
const orderRow = (page, orderId) => page.locator(`tr[data-order="${orderId}"]`).first();
const actionCell = (page, orderId) => orderRow(page, orderId).locator("td[data-action-td]");
const trackingCell = (page, orderId) => orderRow(page, orderId).locator("td[data-tracking-td]");
const shipWindow = (page) => page.getByRole("dialog", { name: "Shipping information" });
const requestId = () => uniq("pay").replace(/\W/g, "");

// A shop with a Tee ($20) and a Cap ($15), and one order placed on its page with one of each ($35), by a customer
// with an email address (so the window offers the email to the customer). `paid`: marked paid through the owner's API.
const shopWithOrder = async (api, page, { paid = true, before = null } = {}) => {
  const shop = await makeShop(api, { prefix: "shipw", products: [{ name: "Sample Tee", price: 20 }, { name: "Sample Cap", price: 15, type: "cap", idPrefix: "cap" }] });
  const customer = uniq("Casey Customer");
  const order = await placeOrder(page, shop, { customer, email: "casey@example.test", items: [{ name: "Sample Tee", qty: 1 }, { name: "Sample Cap", qty: 1 }] });
  if (before) await before(shop, order);
  if (paid) await api("markPaidManual", { org: shop.orgId, orderId: order.orderId, requestId: requestId() });
  return { shop, order, customer };
};
const fullOrder = async (api, shop, orderId) => (await api("getOrders", { org: shop.orgId })).orders.find(x => x.orderId === orderId);
const addr = (over = {}) => ({ name: "Casey Customer", line1: "1 Example Way", line2: "", city: "Sampletown", state: "CA", zip: "90001", country: "US", ...over });

// Every POST /api/orders the page sends while `fn` runs, by action.
const actionsDuring = async (page, fn) => {
  const sent = [];
  const on = (req) => { if (req.method() === "POST" && req.url().endsWith("/api/orders")) { try { sent.push(JSON.parse(req.postData() || "{}").action); } catch (e) {} } };
  page.on("request", on);
  try { await fn(); } finally { page.off("request", on); }
  return sent;
};

// ---- opening, cancelling, the address checks -------------------------------------------------------------
test("Set shipping opens with the customer's name and the order's box; Cancel, ✕ and Escape save nothing", async ({ page, api }) => {
  const { shop, order, customer } = await shopWithOrder(api, page);
  const id = order.orderId;
  await ordersPage(page, shop);
  // A paid order with no address yet: Set shipping, and no Ship button (nothing to ship to).
  await expect(trackingCell(page, id)).toHaveText("—");
  const setBtn = actionCell(page, id).getByRole("button", { name: "Set shipping" });
  await expect(setBtn).toBeVisible();

  const sent = await actionsDuring(page, async () => {
    await setBtn.click();
    const dlg = shipWindow(page);
    await expect(dlg).toBeVisible();
    // The recipient starts as the customer; the address is empty and the cursor is in its first line.
    await expect(dlg.getByLabel("Recipient name")).toHaveValue(customer);
    await expect(dlg.getByLabel(/^Address line 1/)).toHaveValue("");
    await expect(dlg.getByLabel(/^Address line 1/)).toBeFocused();
    await expect(dlg.getByLabel(/^ZIP/)).toHaveAttribute("placeholder", "12345");
    // The weight starts from the order's own estimate (a tee and a cap: 16 oz).
    await expect(dlg.getByLabel("Weight (oz)")).toHaveValue("16");
    // One tee and one cap fit the smallest box with room for them (Small: 2 shirts, 3 caps).
    await expect(dlg.getByLabel("Box size")).toHaveValue("small");
    await expect(dlg.locator("#shipBoxCustom")).toBeHidden();
    // Custom shows the box's own dimensions and packing cost.
    await dlg.getByLabel("Box size").selectOption("custom");
    await expect(dlg.getByLabel("Length (in)")).toBeVisible();
    await expect(dlg.getByLabel("Packing cost ($)")).toBeVisible();
    // The email to the customer (the order has an email address) quotes no fee yet.
    await expect(dlg).toContainText("To: casey@example.test");
    await expect(dlg).toContainText("Subject: Shipping payment for order " + id);
    await expect(dlg.locator("#shipEmailBody")).toHaveValue(new RegExp("Your order " + id + " is ready to ship! Please pay the shipping fee of \\[shipping fee\\]"));
    await expect(dlg.locator("#shipEmailBodyPreview")).toContainText("Pay Shipping →");
    // Nothing to send a payment link for: no charge picked.
    await expect(dlg.getByRole("button", { name: /Save & email payment link/ })).toBeHidden();

    // Typed, then Cancel: gone, nothing saved.
    await dlg.getByLabel(/^Address line 1/).fill("9 Never Saved Rd");
    await dlg.getByRole("button", { name: "Cancel" }).click();
    await expect(dlg).toHaveCount(0);
    // ✕ and Escape close it the same way.
    await setBtn.click();
    await expect(shipWindow(page)).toBeVisible();
    await expect(shipWindow(page).getByLabel(/^Address line 1/)).toHaveValue("");
    await shipWindow(page).getByRole("button", { name: "Close" }).click();
    await expect(shipWindow(page)).toHaveCount(0);
    await setBtn.click();
    await expect(shipWindow(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(shipWindow(page)).toHaveCount(0);
  });
  expect(sent.filter(a => a === "setShippingInfo" || a === "setShippingPaidAmount")).toEqual([]);
  await expect(actionCell(page, id).getByRole("button", { name: "Set shipping" })).toBeVisible();
  const o = await fullOrder(api, shop, id);
  expect(o.shippingAddress && o.shippingAddress.line1 ? o.shippingAddress.line1 : "").toBe("");
});

test("Set shipping refuses to save without address line 1, city and ZIP, and keeps the window open", async ({ page, api }) => {
  const { shop, order } = await shopWithOrder(api, page);
  const id = order.orderId;
  await ordersPage(page, shop);
  await actionCell(page, id).getByRole("button", { name: "Set shipping" }).click();
  const dlg = shipWindow(page);
  const err = dlg.locator("#shipError");
  const sent = await actionsDuring(page, async () => {
    // Nothing typed.
    await dlg.getByRole("button", { name: "Save", exact: true }).click();
    await expect(err).toHaveText("Address line 1, city, and ZIP are required.");
    // A street and a city but no ZIP: still refused.
    await dlg.getByLabel(/^Address line 1/).fill("1 Example Way");
    await dlg.getByLabel(/^City/).fill("Sampletown");
    await dlg.getByRole("button", { name: "Save", exact: true }).click();
    await expect(err).toHaveText("Address line 1, city, and ZIP are required.");
    // Only spaces in the city count as no city.
    await dlg.getByLabel(/^City/).fill("   ");
    await dlg.getByLabel(/^ZIP/).fill("90001");
    await dlg.getByRole("button", { name: "Save", exact: true }).click();
    await expect(err).toHaveText("Address line 1, city, and ZIP are required.");
    await expect(dlg).toBeVisible();
  });
  expect(sent).not.toContain("setShippingInfo");
  // What was typed is still there to fix.
  await expect(dlg.getByLabel(/^Address line 1/)).toHaveValue("1 Example Way");
  await expect(dlg.getByLabel(/^ZIP/)).toHaveValue("90001");
  await dlg.getByRole("button", { name: "Cancel" }).click();
});

test("Set shipping saves the recipient, address, weight and box; the row offers Ship and Edit shipping, what's owed is unchanged", async ({ page, api }) => {
  const { shop, order } = await shopWithOrder(api, page);
  const id = order.orderId;
  const before = await fullOrder(api, shop, id);
  await ordersPage(page, shop);
  await actionCell(page, id).getByRole("button", { name: "Set shipping" }).click();
  const dlg = shipWindow(page);
  await dlg.getByLabel("Recipient name").fill("Robin Recipient");
  await dlg.getByLabel(/^Address line 1/).fill("12 Example Street");
  await dlg.getByLabel("Address line 2").fill("Suite 4");
  await dlg.getByLabel(/^City/).fill("Sampletown");
  // The state is typed in lower case; the window sends it in capitals.
  await dlg.getByLabel(/^State/).fill("ca");
  await dlg.getByLabel(/^ZIP/).fill("90001");
  const sent = await actionsDuring(page, async () => {
    await dlg.getByRole("button", { name: "Save", exact: true }).click();
    await expect(toast(page)).toContainText("Shipping information saved.");
  });
  await expect(dlg).toHaveCount(0);
  // Only the shipping was sent (nothing typed in Shipping paid, no payment link).
  expect(sent).toEqual(["setShippingInfo"]);
  // The row is redrawn in place: a Ship button (labels are bought from there), and Edit shipping.
  await expect(trackingCell(page, id).getByRole("button", { name: "Ship" })).toBeVisible();
  await expect(actionCell(page, id).getByRole("button", { name: "Edit shipping" })).toBeVisible();
  await expect(actionCell(page, id).getByRole("button", { name: "Set shipping" })).toHaveCount(0);

  // Saved on the order: the address (in capitals, stamped US), the estimated weight, the Small box's size, no charge.
  const o = await fullOrder(api, shop, id);
  expect(o.shippingAddress).toMatchObject({ name: "Robin Recipient", line1: "12 Example Street", line2: "Suite 4", city: "Sampletown", state: "CA", zip: "90001", country: "US" });
  expect(o.totalWeightOz).toBe(16);
  expect([o.parcelLength, o.parcelWidth, o.parcelHeight]).toEqual([12, 9, 2]);
  expect(o.shippingCost).toBe(0);
  expect(o.shippingMethod).toBe("");
  expect(o.effectiveTotal).toBe(35);
  expect(o.balanceDue).toBe(0);
  expect(o.salesTax).toBe(before.salesTax);

  // A fresh load shows the same: still settled, no shipping charge, and the window opens on what was saved.
  await ordersPage(page, shop);
  await expect(orderRow(page, id).locator("td[data-balance-td]")).toHaveText("Settled");
  await actionCell(page, id).getByRole("button", { name: "Edit shipping" }).click();
  await expect(dlg.getByLabel("Recipient name")).toHaveValue("Robin Recipient");
  await expect(dlg.getByLabel(/^Address line 1/)).toHaveValue("12 Example Street");
  await expect(dlg.getByLabel("Address line 2")).toHaveValue("Suite 4");
  await expect(dlg.getByLabel(/^State/)).toHaveValue("CA");
  await expect(dlg.getByLabel(/^ZIP/)).toHaveValue("90001");
  await expect(dlg.getByLabel("Box size")).toHaveValue("small");
  // No charge yet, so no "Current rate".
  await expect(dlg).not.toContainText("Current rate:");
  await dlg.getByRole("button", { name: "Cancel" }).click();
});

test("An address the server refuses (a ZIP in another state) closes the window with the reason; nothing is saved", async ({ page, api }) => {
  const { shop, order } = await shopWithOrder(api, page);
  const id = order.orderId;
  await ordersPage(page, shop);
  await actionCell(page, id).getByRole("button", { name: "Set shipping" }).click();
  const dlg = shipWindow(page);
  await dlg.getByLabel(/^Address line 1/).fill("1 Example Way");
  await dlg.getByLabel(/^City/).fill("Sampletown");
  await dlg.getByLabel(/^State/).fill("NY");
  await dlg.getByLabel(/^ZIP/).fill("90001");
  await dlg.getByRole("button", { name: "Save", exact: true }).click();
  await expect(toast(page)).toContainText("Error: ZIP code 90001 is in CA, but the state says NY. Please check the address.");
  await expect(dlg).toHaveCount(0);
  await expect(actionCell(page, id).getByRole("button", { name: "Set shipping" })).toBeVisible();
  await expect(trackingCell(page, id)).toHaveText("—");
  const o = await fullOrder(api, shop, id);
  expect(o.shippingAddress && o.shippingAddress.line1 ? o.shippingAddress.line1 : "").toBe("");

  // A ZIP that isn't 5 digits: refused the same way.
  await actionCell(page, id).getByRole("button", { name: "Set shipping" }).click();
  await dlg.getByLabel(/^Address line 1/).fill("1 Example Way");
  await dlg.getByLabel(/^City/).fill("Sampletown");
  await dlg.getByLabel(/^ZIP/).fill("9000");
  await dlg.getByRole("button", { name: "Save", exact: true }).click();
  await expect(toast(page)).toContainText("Error: ZIP code must be 5 digits (or ZIP+4).");
  expect(((await fullOrder(api, shop, id)).shippingAddress || {}).line1 || "").toBe("");
});

// ---- Get rates without a carrier ---------------------------------------------------------------------------
test("Get rates checks the ZIP, weight and box first, then says carrier shipping isn't set up; Save waits for rates", async ({ page, api }) => {
  const { shop, order } = await shopWithOrder(api, page);
  const id = order.orderId;
  await ordersPage(page, shop);
  await actionCell(page, id).getByRole("button", { name: "Set shipping" }).click();
  const dlg = shipWindow(page);
  const err = dlg.locator("#shipError");
  const getRates = dlg.getByRole("button", { name: "Get rates" });
  const save = dlg.getByRole("button", { name: "Save", exact: true });
  const hint = dlg.locator("#shipDirtyHint");
  await expect(save).toBeEnabled();
  await expect(hint).toBeHidden();

  // Rates are for a 5-digit ZIP …
  await dlg.getByLabel(/^ZIP/).fill("9001");
  await getRates.click();
  await expect(err).toHaveText("Enter a valid 5-digit ZIP first.");
  // … and a weight.
  // … and a weight (the order's estimate is cleared here).
  await dlg.getByLabel(/^ZIP/).fill("90001");
  await dlg.getByLabel("Weight (oz)").fill("");
  await getRates.click();
  await expect(err).toHaveText("Enter the package weight (oz) first.");
  // A weight changes the rate, so Save waits for Get rates, and says so.
  await dlg.getByLabel("Weight (oz)").fill("14");
  await expect(save).toBeDisabled();
  await expect(hint).toBeVisible();
  await expect(hint).toHaveText('Click "Get rates" after changing weight or box.');
  // A custom box needs all three dimensions.
  await dlg.getByLabel("Box size").selectOption("custom");
  await dlg.getByLabel("Length (in)").fill("10");
  await dlg.getByLabel("Width (in)").fill("8");
  await getRates.click();
  await expect(err).toHaveText("Enter all three dimensions for the custom box size.");
  await dlg.getByLabel("Height (in)").fill("3");

  // Everything is there: the request goes out, and the answer is that no carrier is set up (no Shippo key).
  const asked = page.waitForRequest(r => r.url().endsWith("/api/shipping") && r.method() === "POST");
  await getRates.click();
  const req = await asked;
  expect(JSON.parse(req.postData())).toMatchObject({ zip: "90001", items: [{ weightOz: 14, qty: 1 }], parcel: { preset: "custom", length: "10", width: "8", height: "3" } });
  await expect(dlg.locator("#shipRatesSection")).toHaveText("Shipping not configured.");
  await expect(err).toHaveText("");
  await expect(getRates).toBeEnabled();
  await expect(getRates).toHaveText("Get rates");
  // No rates, so no rate to pick and no custom amount beside them; Save still waits.
  await expect(dlg.locator('input[name="shipRate"]')).toHaveCount(0);
  await expect(dlg.locator("#shipCustomCost")).toHaveCount(0);
  await expect(save).toBeDisabled();
  await dlg.getByRole("button", { name: "Cancel" }).click();
  await expect(dlg).toHaveCount(0);
});

// BUG: without a carrier the owner can never save a weight or box change. Typing a weight (or picking a box) disables
// Save until Get rates succeeds (admin.js setRateDirty / updateSaveButtons, ~3940), and Get rates can't succeed with no
// Shippo key (or outside the US, where fetchRates refuses before asking) — while Production, who has no Get rates,
// saves the same change (the wait only applies with orders.payments). Cancel is the owner's only way out.
test("Without a carrier, the owner can still save a package weight and a box size", async ({ page, api }) => {
  test.fail(true, "BUG: Save stays disabled after a weight/box change until Get rates succeeds, which it never does without Shippo (admin.js ~3940)");
  const { shop, order } = await shopWithOrder(api, page, { before: (s, o) => api("setShippingInfo", { org: s.orgId, orderId: o.orderId, totalWeightOz: 0, shippingCost: 0, shippingMethod: "", shippingAddress: addr() }) });
  const id = order.orderId;
  await ordersPage(page, shop);
  await actionCell(page, id).getByRole("button", { name: "Edit shipping" }).click();
  const dlg = shipWindow(page);
  await dlg.getByLabel("Weight (oz)").fill("14");
  await dlg.getByLabel("Box size").selectOption("medium");
  await dlg.getByRole("button", { name: "Get rates" }).click();
  await expect(dlg.locator("#shipRatesSection")).toHaveText("Shipping not configured.");
  await dlg.getByRole("button", { name: "Save", exact: true }).click({ timeout: 3000 });
  await expect(toast(page)).toContainText("Shipping information saved.");
  const o = await fullOrder(api, shop, id);
  expect(o.totalWeightOz).toBe(14);
  expect([o.parcelLength, o.parcelWidth, o.parcelHeight]).toEqual([12, 9, 4]);
});

// ---- a charge already on the order ------------------------------------------------------------------------
test("A shipping charge on the order shows as the current rate, is quoted in the email, and a save keeps it; Shipping paid is recorded", async ({ page, api }) => {
  // The order's shipping charge, $7.50 flat rate, set before it is paid ($35 + $7.50 = $42.50, paid in full).
  const { shop, order } = await shopWithOrder(api, page, { before: (s, o) => api("setShippingInfo", { org: s.orgId, orderId: o.orderId, totalWeightOz: 10,
    shippingCost: 7.5, shippingMethod: "Flat rate", parcelLength: 12, parcelWidth: 9, parcelHeight: 4, shippingAddress: addr() }) });
  const id = order.orderId;
  const before = await fullOrder(api, shop, id);
  // What the order comes to includes the charge (the stored `total` is the one at placing, see parseOrder_).
  expect(before.effectiveTotal).toBe(42.5);
  expect(before.balanceDue).toBe(0);
  await ordersPage(page, shop);
  // The list's Shipping column: method and cost; the order is settled.
  await expect(orderRow(page, id)).toContainText("Flat rate $7.50");
  await expect(orderRow(page, id).locator("td[data-balance-td]")).toHaveText("Settled");

  await actionCell(page, id).getByRole("button", { name: "Edit shipping" }).click();
  const dlg = shipWindow(page);
  await expect(dlg).toContainText("Current rate: Flat rate — $7.50 · Medium box (12×9×4 in)");
  await expect(dlg).toContainText("Saving keeps this cost unless you pick a new rate or enter a custom amount.");
  await expect(dlg.getByLabel("Box size")).toHaveValue("medium");
  await expect(dlg.getByLabel("Weight (oz)")).toHaveValue("10");
  // The email quotes the charge on the order.
  await expect(dlg.locator("#shipEmailBody")).toHaveValue(new RegExp("Please pay the shipping fee of \\$7\\.50 \\(Flat rate\\) using the secure link below\\."));
  // Shipping paid: what's already been paid toward it. Typing it changes what the email asks for.
  await dlg.getByLabel("Shipping paid ($)").fill("5");
  await expect(dlg.locator("#shipEmailBody")).toHaveValue(/The total shipping \(Flat rate\) is \$7\.50\. You have already paid \$5\.00 toward shipping, so the remaining balance is \$2\.50\./);
  await expect(dlg.locator("#shipEmailBodyPreview")).toContainText("the remaining balance is $2.50");
  await expect(dlg.getByRole("button", { name: "Save & email payment link ($2.50)" })).toBeVisible();
  // A text written by hand isn't replaced any more.
  await dlg.locator("#shipEmailBody").fill("Hi, a short note written by hand.");
  await expect(dlg.locator("#shipEmailBodyPreview")).toContainText("a short note written by hand");
  await dlg.getByLabel("Shipping paid ($)").fill("7.5");
  await expect(dlg.locator("#shipEmailBody")).toHaveValue("Hi, a short note written by hand.");
  // Paid in full: nothing to send a link for.
  await expect(dlg.getByRole("button", { name: /Save & email payment link/ })).toBeHidden();

  // A new second line; Save.
  await dlg.getByLabel("Address line 2").fill("Back door");
  const sent = await actionsDuring(page, async () => {
    await dlg.getByRole("button", { name: "Save", exact: true }).click();
    await expect(toast(page)).toContainText("Shipping information saved.");
  });
  expect(sent).toEqual(["setShippingInfo", "setShippingPaidAmount"]);
  const o = await fullOrder(api, shop, id);
  expect(o.shippingAddress).toMatchObject({ line1: "1 Example Way", line2: "Back door", state: "CA", zip: "90001" });
  // The charge and its method are kept exactly; the box and weight are as they were.
  expect(o.shippingCost).toBe(7.5);
  expect(o.shippingMethod).toBe("Flat rate");
  expect(o.totalWeightOz).toBe(10);
  expect([o.parcelLength, o.parcelWidth, o.parcelHeight]).toEqual([12, 9, 4]);
  expect(o.shippingPaidAmount).toBe(7.5);
  expect(o.effectiveTotal).toBe(42.5);
  expect(o.balanceDue).toBe(0);
  // The list after a fresh load: the same charge, still settled.
  await ordersPage(page, shop);
  await expect(orderRow(page, id)).toContainText("Flat rate $7.50");
  await expect(orderRow(page, id).locator("td[data-balance-td]")).toHaveText("Settled");
  // The window opens with the shipping paid saved.
  await actionCell(page, id).getByRole("button", { name: "Edit shipping" }).click();
  await expect(dlg.getByLabel("Shipping paid ($)")).toHaveValue("7.50");
  await dlg.getByRole("button", { name: "Cancel" }).click();
});

test("Save & email payment link without card payments set up saves the shipping and says the link failed", async ({ page, api }) => {
  const { shop, order } = await shopWithOrder(api, page, { before: (s, o) => api("setShippingInfo", { org: s.orgId, orderId: o.orderId, totalWeightOz: 10,
    shippingCost: 6, shippingMethod: "Flat rate", shippingAddress: addr() }) });
  const id = order.orderId;
  await ordersPage(page, shop);
  await actionCell(page, id).getByRole("button", { name: "Edit shipping" }).click();
  const dlg = shipWindow(page);
  // The charge on the order can be sent as a payment link.
  const send = dlg.getByRole("button", { name: /^Save & email payment link/ });
  await expect(send).toBeVisible();
  await dlg.getByLabel(/^Address line 1/).fill("5 Example Way");
  const sent = await actionsDuring(page, async () => {
    await send.click();
    await expect(toast(page)).toContainText("Shipping saved, but payment link failed: Stripe not configured");
  });
  expect(sent).toEqual(["setShippingInfo", "createShippingPaymentLink"]);
  await expect(dlg).toHaveCount(0);
  const o = await fullOrder(api, shop, id);
  expect(o.shippingAddress.line1).toBe("5 Example Way");
  expect(o.shippingCost).toBe(6);
  expect(o.shippingPaidAmount).toBe(0);
});

// ---- roles ---------------------------------------------------------------------------------------------------
test("Production edits the address in the window without Shipping paid or Get rates; the charge is kept, a new state is refused", async ({ page, api, as }) => {
  const { shop, order } = await shopWithOrder(api, page, { before: (s, o) => api("setShippingInfo", { org: s.orgId, orderId: o.orderId, totalWeightOz: 8,
    shippingCost: 7.5, shippingMethod: "Flat rate", shippingAddress: addr() }) });
  const id = order.orderId;
  const before = await fullOrder(api, shop, id);

  const prod = await as("production");
  await ordersPage(prod, shop);
  await actionCell(prod, id).getByRole("button", { name: "Edit shipping" }).click();
  const dlg = shipWindow(prod);
  await expect(dlg).toBeVisible();
  // What the customer pays is Payments': no Shipping paid, no Get rates, no payment link.
  await expect(dlg.getByLabel("Shipping paid ($)")).toBeHidden();
  await expect(dlg.getByRole("button", { name: "Get rates" })).toBeHidden();
  await expect(dlg.getByRole("button", { name: /Save & email payment link/ })).toBeHidden();
  await expect(dlg).toContainText("Current rate: Flat rate — $7.50");
  // A weight change doesn't wait for rates here (there's no Get rates to click).
  await dlg.getByLabel("Weight (oz)").fill("11");
  await expect(dlg.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  await expect(dlg.locator("#shipDirtyHint")).toBeHidden();
  await dlg.getByLabel(/^Address line 1/).fill("2 Example Way");
  const sent = await actionsDuring(prod, async () => {
    await dlg.getByRole("button", { name: "Save", exact: true }).click();
    await expect(toast(prod)).toContainText("Shipping information saved.");
  });
  expect(sent).toEqual(["setShippingInfo"]);
  let o = await fullOrder(api, shop, id);
  expect(o.shippingAddress.line1).toBe("2 Example Way");
  expect(o.totalWeightOz).toBe(11);
  expect(o.shippingCost).toBe(7.5);
  expect(o.shippingMethod).toBe("Flat rate");

  // A different state moves the sales tax: refused, with the reason, and nothing changes.
  await actionCell(prod, id).getByRole("button", { name: "Edit shipping" }).click();
  await dlg.getByLabel(/^Address line 1/).fill("4 Example Way");
  await dlg.getByLabel(/^City/).fill("Sampleville");
  await dlg.getByLabel(/^State/).fill("NY");
  await dlg.getByLabel(/^ZIP/).fill("10001");
  await dlg.getByRole("button", { name: "Save", exact: true }).click();
  await expect(toast(prod)).toContainText("Error: A different state changes the order's sales tax, so only someone who handles payments can change it.");
  o = await fullOrder(api, shop, id);
  expect(o.shippingAddress).toMatchObject({ line1: "2 Example Way", state: "CA", zip: "90001" });
  expect(o.effectiveTotal).toBe(before.effectiveTotal);
  expect(o.balanceDue).toBe(before.balanceDue);

  // Read only: no Set / Edit shipping at all, and the server refuses the save.
  const viewer = await as("viewer");
  await ordersPage(viewer, shop);
  await expect(orderRow(viewer, id)).toBeVisible();
  await expect(actionCell(viewer, id).getByRole("button", { name: /^(Set|Edit) shipping$/ })).toHaveCount(0);
  const ctx = await apiContext("viewer");
  try {
    const r = await callApi(ctx, "setShippingInfo", { org: shop.orgId, orderId: id, totalWeightOz: 8, shippingCost: 7.5, shippingMethod: "Flat rate", shippingAddress: addr({ line1: "6 Example Way" }) },
      { allowError: true, withStatus: true });
    expect(r.status).toBe(403);
  } finally { await ctx.dispose(); }
  expect((await fullOrder(api, shop, id)).shippingAddress.line1).toBe("2 Example Way");
});
