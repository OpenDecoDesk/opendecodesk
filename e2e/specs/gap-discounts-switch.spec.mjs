// Discount codes (migrations/0115): the Discount codes switch under Settings → Global settings → Features, and the
// checkout's code box. Off hides the menu item and the page, the server refuses every code action, and the storefront
// shows no code box and refuses an order sent with a code; on again, all back, and a code works at checkout. The box
// shows only at a shop where some code could work now (catalog.js DISCOUNT_BOX_SQL_), read fresh on every request:
// saving a code brings it without a Publish, switching it off takes it away.
// It switches Discount codes off for the whole install, and switches off every-shop codes other specs left on for a
// while, so it runs alone, after every other spec (ALONE in e2e/playwright.config.mjs).
import { test, expect, shopUrl, openAdmin, toast, callApi, apiContext, slug, uniq } from "../fixtures.mjs";
import { makeShop } from "../lib/data.mjs";

// ---- helpers ---------------------------------------------------------------------------------------------
const NO_ROLE = "Your role can't do this. Ask an admin.";
const FEATURE_OFF = "Discount codes is turned off. Turn it on under Settings → Global settings → Features.";
const SHOP_OFF = "Discount codes aren't available right now.";
const FAR = "2099-12-31";
const ACTIONS = ["listDiscountCodes", "getDiscountCode", "saveDiscountCode", "createDiscountCodes", "setDiscountCodeActive", "deleteDiscountCode"];

const nav = (page) => page.getByRole("navigation", { name: "Admin" });
const navBtn = (page) => nav(page).locator('.admin-nav-row > button[data-h="discounts"]');
const topButtons = (page) => nav(page).locator(".admin-nav-row > button[data-h]").evaluateAll(els => els.map(e => e.dataset.h));
const tryApi = (ctx, action, body) => callApi(ctx, action, body, { allowError: true, withStatus: true });
const newCode = (prefix) => slug(prefix).toUpperCase().slice(0, 24);
const anEmail = () => slug("ds") + "@example.com";
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

async function makeCode(api, shop, fields = {}) {
  return (await api("saveDiscountCode", { code: { code: newCode("ds"), kind: "percent", percent: 10, orgId: shop ? shop.orgId : null, maxUses: 50,
    expiresOn: FAR, note: "Made by the switch spec", ...fields } })).code;
}
const bodies = (shop, c) => ({
  listDiscountCodes: {},
  getDiscountCode: { id: c.id },
  saveDiscountCode: { code: { id: c.id, code: c.code, kind: "percent", percent: 50, orgId: shop.orgId, maxUses: 50, expiresOn: FAR, note: "Changed while off" } },
  createDiscountCodes: { emails: [anEmail()], kind: "percent", percent: 5, org: shop.orgId, expiresOn: FAR, note: "Never made" },
  setDiscountCodeActive: { id: c.id, active: false },
  deleteDiscountCode: { id: c.id },
});

// The shop's part of its catalog answer, as its page asks for it.
const catalogOf = async (request, shop) => {
  const res = await request.get(shopUrl(shop.subdomain) + "/api/catalog", { headers: { "Cache-Control": "no-store" } });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.orgId).toBe(shop.orgId);
  return body.catalog;
};
// The storefront's Apply, sent as the page sends it.
async function checkCode(request, shop, code, email = "") {
  const res = await request.post(shopUrl(shop.subdomain) + "/api/orders", { headers: { Origin: shopUrl(shop.subdomain) },
    data: { action: "checkDiscountCode", orgId: shop.orgId, code, email, items: [{ productId: shop.products[0].productId, size: "OSFA", qty: 1 }] } });
  return { status: res.status(), data: await res.json() };
}
// An order placed at the shop's own address, with `code`.
async function orderWithCode(request, shop, code, email) {
  const orderId = "DS-" + slug("o").toUpperCase().slice(0, 20);
  const res = await request.post(shopUrl(shop.subdomain) + "/api/orders", { headers: { Origin: shopUrl(shop.subdomain) },
    data: { orderId, orgId: shop.orgId, customerName: "Pat Example", contact: email, paymentMethod: "Check",
      items: [{ productId: shop.products[0].productId, name: shop.products[0].name, size: "OSFA", qty: 1 }], discountCode: code } });
  return { orderId, status: res.status(), data: await res.json() };
}
const orderIn = async (api, shop, orderId) => (await api("getOrders", { org: shop.orgId })).orders.find(o => o.orderId === orderId);

// The shop's page with its one product, once, in the cart (the page keeps a cart across visits: emptied first): the
// checkout is drawn.
async function openCart(page, shop) {
  await page.goto(shopUrl(shop.subdomain) + "/");
  await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch (e) {} });
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: shop.name })).toBeVisible();
  const card = page.locator("main").getByRole("heading", { level: 3, name: shop.products[0].name, exact: true }).locator("xpath=ancestor::*[.//button[normalize-space()='Add to cart']][1]");
  await card.getByRole("button", { name: "Add to cart" }).click();
  await expect(page.getByRole("button", { name: "Place order" })).toBeVisible();
}
const codeBox = (page) => page.locator("#discountCodeInput");

// Every-shop codes other specs left switched on would show the box at every shop: switched off for this file's
// checks, then on again. Returns their ids.
async function everyShopCodesOff(api) {
  const ids = [];
  for (let offset = 0; ; offset += 200) {
    const { codes, total } = await api("listDiscountCodes", { status: "active", limit: 200, offset });
    for (const c of codes) if (!c.orgId) ids.push(c.id);
    if (offset + 200 >= total) break;
  }
  for (const id of ids) await api("setDiscountCodeActive", { id, active: false });
  return ids;
}

// ---- The switch ----------------------------------------------------------------------------------------------
test("Discount codes switched off in Global settings: no menu item or page, the server refuses the actions, the checkout has no code box and refuses a code; on again, all back", async ({ page, api, as }, testInfo) => {
  test.setTimeout(150_000);
  const shop = await makeShop(api, { prefix: "dsw", products: [{ name: "Sample Tee", price: 20 }] });
  const c = await makeCode(api, shop);
  expect((await api("getFeatures")).features.discounts).not.toBe(false);

  const box = page.locator("#gFeatRow-discounts .gFeature");
  const saveSettings = async () => {
    await page.getByRole("button", { name: "Save global settings" }).click();
    await expect(toast(page)).toContainText("Global settings saved.");
  };
  const cust = await as(null);
  // On: the shop's checkout has the box.
  expect((await catalogOf(cust.request, shop)).discountCodes).toBe(true);
  await openCart(cust, shop);
  await expect(codeBox(cust)).toBeVisible();

  let switchedOff = false;
  try {
    // -- Off, through the page.
    await openAdmin(page, "settings");
    await expect(page.locator("#gFeatRow-discounts")).toContainText("Discount codes");
    await expect(box).toBeChecked();
    await expect(navBtn(page)).toBeVisible();
    await box.uncheck();
    switchedOff = true;
    await saveSettings();
    expect((await api("getFeatures")).features.discounts).toBe(false);
    await expect(navBtn(page)).toHaveCount(0);

    // The page says it's off.
    await openAdmin(page, "discounts");
    await expect(page.locator("#featureOffPanel")).toContainText("Discount codes is turned off.");
    await expect(page.locator("#featureOffPanel")).toHaveAttribute("data-feature", "discounts");
    await expect(page).toHaveTitle(/Discount codes is turned off/);
    await expect(page.locator("#dcPage")).toHaveCount(0);
    // Back office (Read) loses the menu item too.
    const sp = await as("staff");
    await openAdmin(sp, "home");
    expect(await topButtons(sp)).toContain("quotes");
    await expect(navBtn(sp)).toHaveCount(0);

    // The server: every action, for a role that may use it, is refused as switched off; a role that may not hears only that.
    const b = bodies(shop, c);
    for (const a of ACTIONS) {
      const r = await api(a, b[a], { allowError: true, withStatus: true });
      expect(r.status, a + " with Discount codes off").toBe(403);
      expect(r.data, a).toMatchObject({ status: "error", feature: "discounts", message: FEATURE_OFF });
    }
    const prod = await apiContext("production", testInfo.workerIndex);
    try {
      const r = await tryApi(prod, "listDiscountCodes", {});
      expect(r.status).toBe(403);
      expect(r.data.message).toBe(NO_ROLE);
    } finally {
      await prod.dispose();
    }

    // The checkout: no box (the catalog says no), Apply's request and an order sent with a code are refused, and no
    // order is made.
    expect((await catalogOf(cust.request, shop)).discountCodes).toBe(false);
    await openCart(cust, shop);
    await expect(cust.getByLabel("Email address")).toBeVisible();
    await expect(codeBox(cust)).toHaveCount(0);
    await expect(cust.locator(".discount-section")).toHaveCount(0);
    let r = await checkCode(cust.request, shop, c.code);
    expect(r.status).toBe(400);
    expect(r.data).toEqual({ status: "error", message: SHOP_OFF });
    const offOrder = await orderWithCode(cust.request, shop, c.code, anEmail());
    expect(offOrder.status).toBe(400);
    expect(offOrder.data).toEqual({ status: "error", message: SHOP_OFF });
    expect(await orderIn(api, shop, offOrder.orderId), "no order made with the code refused").toBeUndefined();
    // An order without a code still goes through.
    const plain = await orderWithCode(cust.request, shop, "", anEmail());
    expect(plain.status, JSON.stringify(plain.data)).toBe(200);
    expect((await orderIn(api, shop, plain.orderId)).discountAmount || 0).toBe(0);

    // -- On again, through the page.
    await openAdmin(page, "settings");
    await expect(box).not.toBeChecked();
    await box.check();
    await saveSettings();
    expect((await api("getFeatures")).features.discounts).toBe(true);
    switchedOff = false;
    await expect(navBtn(page)).toBeVisible();
    await navBtn(page).click();
    await expect(page).toHaveTitle(/ — Marketing \(Admin\)$/);
    await page.locator("#dcQ").fill(c.code);
    const row = page.locator("#dcBody tr[data-dc-row]", { hasText: c.code });
    await expect(row).toHaveCount(1);
    await expect(row.locator("td").nth(4)).toHaveText("0 of 50");
    await expect(row.locator("td").nth(6)).toHaveText("Active");
    // Nothing changed while it was off.
    expect((await api("getDiscountCode", { id: c.id })).code).toMatchObject({ percent: 10, active: true, note: "Made by the switch spec", used: 0 });

    // The checkout: the box, Apply, the discount in the cart, and the order with it.
    expect((await catalogOf(cust.request, shop)).discountCodes).toBe(true);
    r = await checkCode(cust.request, shop, c.code.toLowerCase());
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ status: "ok", code: c.code, label: "10% off", discount: 2, freeShipping: false, combined: { discount: 2, freeShipping: false, codes: [{ code: c.code, discount: 2, freeShipping: false }] } });
    await openCart(cust, shop);
    const email = anEmail();
    await cust.getByLabel("Your name").fill(uniq("Pat Example"));
    await cust.getByLabel("Email address").fill(email);
    await codeBox(cust).fill(c.code.toLowerCase());
    await cust.locator('[data-action="discount-apply"]').click();
    await expect(cust.locator("#discountOn")).toHaveText(c.code + " — 10% off");
    await expect(cust.locator(".ticket-discount-line")).toContainText("Discount (" + c.code + ")");
    await expect(cust.locator(".ticket-discount-line")).toContainText("−$2.00");
    await expect(cust.locator('[data-action="discount-remove"]')).toBeVisible();
    await cust.getByLabel("Payment method").selectOption({ label: "Check" });
    const sent = cust.waitForRequest(q => q.url().endsWith("/api/orders") && (q.postDataJSON() || {}).discountCode !== undefined);
    await cust.getByRole("button", { name: "Place order" }).click();
    expect((await sent).postDataJSON()).toMatchObject({ discountCode: c.code, contact: email });
    await expect(cust.getByRole("heading", { level: 2, name: /^Order received/ })).toBeVisible();
    await expect(cust.locator(".confirmation")).toContainText("Discount (" + c.code + ")");
    await expect(cust.locator(".confirmation .row.total")).toContainText("$18.00");
    const line = await cust.locator(".confirmation .order-number").textContent();
    const orderId = /^\s*(\S+)/.exec(line)[1];
    expect(await orderIn(api, shop, orderId)).toMatchObject({ discountAmount: 2, discountCode: c.code, discountNote: "Code " + c.code });
    expect((await api("getDiscountCode", { id: c.id })).code).toMatchObject({ used: 1 });
  } finally {
    if (switchedOff || (await api("getFeatures")).features.discounts === false) await api("updateFeatures", { features: { discounts: true } });
  }
});

// ---- The box follows the shop's codes, without a Publish -------------------------------------------------------------
test("A shop with no usable code has no code box; saving a code for it brings the box without a Publish, switching it off takes it away", async ({ api, as }) => {
  test.setTimeout(120_000);
  const shop = await makeShop(api, { prefix: "dsb", products: [{ name: "Sample Tee", price: 20 }] });
  const other = await makeShop(api, { prefix: "dso", products: [{ name: "Sample Tee", price: 20 }] });
  const restore = await everyShopCodesOff(api);
  const made = [];
  try {
    const cust = await as(null);
    const noBox = async (what) => {
      expect((await catalogOf(cust.request, shop)).discountCodes, what).toBe(false);
      await openCart(cust, shop);
      await expect(cust.getByLabel("Email address")).toBeVisible();
      await expect(codeBox(cust), what).toHaveCount(0);
    };
    const hasBox = async (what) => {
      expect((await catalogOf(cust.request, shop)).discountCodes, what).toBe(true);
      await openCart(cust, shop);
      await expect(codeBox(cust), what).toBeVisible();
      await expect(cust.locator('[data-action="discount-apply"]')).toHaveText("Apply");
    };

    await noBox("no code at all");
    // Codes that can't work here now: switched off, past their last day (well before yesterday), another shop's, used up.
    made.push((await makeCode(api, shop, { active: false })).id);
    made.push((await makeCode(api, shop, { expiresOn: daysAgo(3) })).id);
    made.push((await makeCode(api, other)).id);
    made.push((await makeCode(api, null, { active: false })).id);
    const once = await makeCode(api, shop, { maxUses: 1 });
    const placed = await orderWithCode(cust.request, shop, once.code, anEmail());
    expect(placed.status, JSON.stringify(placed.data)).toBe(200);
    expect((await api("getDiscountCode", { id: once.id })).code.status).toBe("usedUp");
    await noBox("only codes that can't work here");

    // A code for this shop, saved: the box at once, with no Publish.
    const mine = await makeCode(api, shop);
    made.push(mine.id);
    await hasBox("a code for this shop");
    // Switched off: gone again.
    await api("setDiscountCodeActive", { id: mine.id, active: false });
    await noBox("this shop's code switched off");
    // An every-shop code brings it too.
    const every = await makeCode(api, null);
    made.push(every.id);
    await hasBox("a code for every shop");
    await api("setDiscountCodeActive", { id: every.id, active: false });
    // The used-up code given more uses works again.
    await api("saveDiscountCode", { code: { id: once.id, code: once.code, kind: "percent", percent: 10, orgId: shop.orgId, maxUses: 2, expiresOn: FAR } });
    await hasBox("the used-up code with another use");
  } finally {
    for (const id of made) await api("deleteDiscountCode", { id }, { allowError: true });
    for (const id of restore) await api("setDiscountCodeActive", { id, active: true }, { allowError: true });
  }
});
