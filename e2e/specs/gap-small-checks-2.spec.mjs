// Small checks, part 2 (coverage review 2026-11-23, P33): three fixes the suite had no browser test for.
//
// - Global settings with Shipping on (review #57, 57.3): a new install starts with Shipping on, and Save global
//   settings saves the rest without a Shippo key. What is typed in the ship-from address is still checked: a ZIP
//   that isn't one is refused, by the page before it sends anything and by the server (saveGlobalSettingsAll,
//   updateFeatures, updateShipFromAddress) for a request that gets past the page, and nothing is saved.
// - Admin money (review #60, 60.8): amounts are written with thousands separators and a true minus sign
//   (public/admin.js adminMoney_). An expense of 1234.56 and its refund show so in the Audit log.
// - Orders on a phone (review #58, 58.13): at 390×844 the Orders page draws one card per order, and Mark as paid
//   asks the server for that order alone (getOrdersByIds) and redraws its card only; the list isn't reloaded.
//
// The first test touches install-wide settings: it reads them first and puts back anything that changed in a
// finally (nothing should change). The others make their own expense, shop and orders and read only those.
import crypto from "node:crypto";
import { test, expect, toast, uniq } from "../fixtures.mjs";
import { makeShop } from "../lib/data.mjs";
import { freshAdmin } from "../lib/money.mjs";

const BAD_ZIP = "ABCDE";
const bodyOf = (req) => { try { return JSON.parse(req.postData() || "null"); } catch (e) { return null; } };
// Every POST /api/orders the page sends from now on, as { action, orderIds }.
const recordActions = (page) => {
  const actions = [];
  page.on("request", (req) => {
    if (req.method() !== "POST" || !/\/api\/orders(\?|$)/.test(req.url())) return;
    const b = bodyOf(req);
    if (b) actions.push({ action: b.action, orderIds: b.orderIds });
  });
  return actions;
};

// ---- 57.3: an invalid ship-from ZIP with Shipping on -----------------------------------------------------------
test("Global settings with Shipping on: a ship-from ZIP that isn't one is refused, by the page and the server, and nothing is saved", async ({ page, api }) => {
  const { business: bizBefore } = await api("getBusinessProfile");
  const { shipFrom: shipBefore } = await api("getShipFromAddress");
  const { features: featBefore } = await api("getFeatures");
  const { locale } = await api("getLocaleSettings");
  // The ZIP rule is the US one, and this check is about Shipping staying on.
  expect(locale.country).toBe("US");
  expect(featBefore.shipping).toBe(true);
  const newName = uniq("Example Zip Co");
  try {
    // Through the page: the business name changed and a bad ZIP typed. The page refuses before it sends anything.
    await freshAdmin(page, "settings");
    const actions = recordActions(page);
    await expect(page.locator("#gFeatRow-shipping .gFeature")).toBeChecked();
    await page.locator("#gBizName").fill(newName);
    await page.locator("#gShipZip").fill(BAD_ZIP);
    await page.getByRole("button", { name: "Save global settings" }).click();
    const err = page.locator("#globalSettingsError");
    await expect(err).toContainText("Nothing was saved.");
    await expect(err).toContainText("Shipping needs a 5-digit ZIP (or ZIP+4)");
    await expect(toast(page)).toContainText("Shipping needs a 5-digit ZIP (or ZIP+4)");
    // The ZIP box is outlined, and the page stays on Global settings with what was typed.
    await expect(page.locator("#gShipZip")).toHaveCSS("outline-style", "solid");
    await expect(page.locator("#gBizName")).toHaveValue(newName);
    expect(actions.map(a => a.action)).not.toContain("saveGlobalSettingsAll");

    // The server holds the same line for a request that gets past the page: the same save, all sections at once.
    const shipFrom = { name: "Example Zip Co", street1: "1 Test Street", city: "Testville", state: "PA", zip: BAD_ZIP, phone: "555-0100", email: "ship@example.test" };
    const all = await api("saveGlobalSettingsAll", { settings: { features: { ...featBefore }, shipFrom, business: { ...bizBefore, name: newName } } }, { allowError: true, withStatus: true });
    expect(all.status).toBe(400);
    expect(all.data).toMatchObject({ status: "error", section: "Features", message: "Ship-from address: ZIP must be 5 digits (or ZIP+4)" });
    // Features alone, with the address…
    const feat = await api("updateFeatures", { features: { shipping: true }, shipFrom }, { allowError: true, withStatus: true });
    expect(feat.status).toBe(400);
    expect(feat.data).toMatchObject({ status: "error", message: "Ship-from address: ZIP must be 5 digits (or ZIP+4)" });
    // …and the address on its own.
    const addr = await api("updateShipFromAddress", { shipFrom }, { allowError: true, withStatus: true });
    expect(addr.status).toBe(400);
    expect(addr.data).toMatchObject({ status: "error", message: "ZIP must be 5 digits (or ZIP+4)" });

    // Nothing was saved: not the name, not the address, not a switch.
    expect((await api("getBusinessProfile")).business).toEqual(bizBefore);
    expect((await api("getShipFromAddress")).shipFrom).toEqual(shipBefore);
    expect((await api("getFeatures")).features).toEqual(featBefore);
    await freshAdmin(page, "settings");
    await expect(page.locator("#gBizName")).toHaveValue(bizBefore.name || "");
    await expect(page.locator("#gShipZip")).toHaveValue(shipBefore.zip || "");
  } finally {
    // Only if something got through after all.
    if (JSON.stringify((await api("getBusinessProfile")).business) !== JSON.stringify(bizBefore)) await api("updateBusinessProfile", { business: bizBefore });
    if (JSON.stringify((await api("getShipFromAddress")).shipFrom) !== JSON.stringify(shipBefore)) await api("updateShipFromAddress", { shipFrom: shipBefore });
    if (JSON.stringify((await api("getFeatures")).features) !== JSON.stringify(featBefore)) await api("updateFeatures", { features: featBefore });
  }
});

// ---- 60.8: thousands in the Audit log --------------------------------------------------------------------------
test("Audit log: an expense of 1234.56 shows as $1,234.56, and its refund as −$1,234.56", async ({ page, api }) => {
  const desc = uniq("Embroidery machine service from Test Repair Co");
  const today = new Date().toISOString().slice(0, 10);
  const { categories } = await api("listExpenseCategories");
  const office = categories.find(c => c.name === "Office expense");
  const { accounts } = await api("listAccounts");
  const accountId = accounts.find(a => a.name === "Business checking").id;
  // The requests Expenses → Save expense sends (that page is money.spec's subject): the purchase, then its refund.
  const { expense } = await api("saveExpense", { expense: { date: today, description: desc, categoryId: office.id, amount: 1234.56,
    vendor: "", businessUsePct: 100, vendorChargedTax: true, accountId } });
  await api("saveExpense", { expense: { date: today, description: desc + " (refund)", categoryId: office.id, amount: 1234.56, refund: true, refundOfId: expense.id,
    vendor: "", businessUsePct: 100, vendorChargedTax: true, accountId } });
  // The server writes audit entries after answering: wait until both are there.
  await expect.poll(async () => (await api("getAuditLog", { filter: "expense.created", limit: 200 })).entries
    .filter(e => String((e.detail || {}).description || "").startsWith(desc)).length, { timeout: 10_000 }).toBe(2);

  await freshAdmin(page, "audit");
  const results = page.locator("#auditResults");
  await page.locator("#afLimit").selectOption("200");
  await page.locator("#afAction").fill("expense.created");
  await page.getByRole("button", { name: "Search" }).click();
  const purchase = results.locator("tbody tr").filter({ hasText: desc + " · " });
  const refund = results.locator("tbody tr", { hasText: desc + " (refund)" });
  await expect(purchase).toHaveCount(1);
  await expect(purchase).toContainText(desc + " · $1,234.56 · Office expense");
  await expect(refund).toHaveCount(1);
  await expect(refund).toContainText(desc + " (refund) · −$1,234.56 · Office expense");   // a true minus sign
});

// ---- 58.13: Mark as paid on a phone ----------------------------------------------------------------------------
const requestId = () => crypto.randomUUID().replace(/-/g, "");
// An unpaid $20 order (a Local sale left unpaid, through the owner's API).
const unpaidOrder = async (api, shop, customer) => (await api("createLocalSale", { org: shop.orgId, requestId: requestId(),
  items: [{ productId: shop.products[0].productId, qty: 1 }], paymentMethod: "Check", customerName: customer })).orderId;

test("Orders on a phone (390×844): Mark as paid redraws that order's card only, without reloading the list", async ({ page, api }) => {
  const shop = await makeShop(api, { prefix: "phone", products: [{ name: "Sample Tee", price: 20 }] });
  const id = await unpaidOrder(api, shop, uniq("Pia Phonecard"));
  const otherId = await unpaidOrder(api, shop, uniq("Oli Othercard"));
  await page.setViewportSize({ width: 390, height: 844 });
  await freshAdmin(page, "orders/" + shop.orgId);
  await expect(page.getByRole("combobox", { name: "Shop" })).toHaveValue(shop.orgId);

  // Cards, not the table.
  const card = (orderId) => page.locator(`.order-card[data-order-card="${orderId}"]`);
  const paidState = (orderId) => card(orderId).locator(".oc-amt");
  await expect(card(id)).toHaveCount(1);
  await expect(card(otherId)).toHaveCount(1);
  await expect(page.locator(".orders-table-wrap")).toHaveCount(0);
  await expect(paidState(id)).toContainText("Unpaid");
  await expect(paidState(otherId)).toContainText("Unpaid");

  // A mark on both cards' elements and on the list around them: whatever is drawn again loses it.
  await card(id).evaluate((el) => { el.dataset.e2eKept = "1"; });
  await card(otherId).evaluate((el) => { el.dataset.e2eKept = "1"; });
  await page.locator(".order-cards").evaluate((el) => { el.dataset.e2eKept = "1"; });
  const actions = recordActions(page);

  await card(id).locator(".oc-actions").getByRole("button", { name: "Mark as paid" }).click();
  await expect(page.locator(".confirm-modal")).toContainText("Mark order " + id + " as paid?");
  await page.locator(".confirm-modal #cmOk").click();

  // The order's card is drawn again, paid, with no Mark as paid; the other card and the list are the same elements.
  await expect(paidState(id)).toContainText(/\bPaid\b/);
  await expect(card(id)).toHaveCount(1);
  await expect(card(id)).not.toHaveAttribute("data-e2e-kept", "1");
  await expect(card(id).getByRole("button", { name: "Mark as paid" })).toHaveCount(0);
  await expect(card(otherId)).toHaveAttribute("data-e2e-kept", "1");
  await expect(paidState(otherId)).toContainText("Unpaid");
  await expect(page.locator(".order-cards")).toHaveAttribute("data-e2e-kept", "1");
  await expect(page.locator(".orders-table-wrap")).toHaveCount(0);

  // What the page asked for: the payment, then that one order — never the whole list.
  await expect.poll(() => actions.map(a => a.action)).toContain("getOrdersByIds");
  expect(actions.map(a => a.action)).toContain("markPaidManual");
  expect(actions.map(a => a.action)).not.toContain("getOrders");
  expect(actions.filter(a => a.action === "getOrdersByIds").map(a => a.orderIds)).toEqual([[id]]);
});
