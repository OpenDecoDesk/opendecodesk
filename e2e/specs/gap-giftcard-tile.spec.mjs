// Phase 8 addendum, in a real browser: the shop's "Gift card" tile, and Global settings → Gift cards' "Customers can buy
// gift cards on the shop" tick, which needs card payments set up and switched on.
//   - Without card payments (this install has no Stripe key: e2e/README.md), getGiftCardSettings says cardReady false;
//     the page shows the tick disabled and unticked with its note (also when a stored "on" comes back), Save sends
//     sellOnline false while the amounts still save, and the server refuses selling online with its own action and with
//     Save (also with Card switched off in the same Save). Switching the Global Card box off and on again changes
//     nothing without Stripe.
//   - With card payments ready (getGiftCardSettings answered cardReady true in the browser): the tick works, with the
//     other note; ticked and saved, the real server still refuses (no Stripe key here) and nothing is stored. An older
//     server that sends no cardReady leaves the tick working.
//   - The shop, with the catalog's gift card fields stubbed in the customer's browser (as gap-giftcards-flow does, no
//     Stripe here): the tile is first (in the one Products section, or its own "Gift cards" section ahead of category
//     sections), shows the price range, opens the buy form by a click anywhere on it and from the keyboard (Enter and
//     Space on its button), is not a product and never goes in the cart; the header button stays. Selling off, the real
//     catalog (no Stripe) and a shop preview show no tile.
//
// This spec changes install-wide settings (the gift card settings and the Global Card payment box), so it is in ALONE
// in playwright.config.mjs and puts every setting back. Every test makes its own shops with unique names.
import { test, expect, openAdmin, uniq, shopUrl, waitIdle } from "../fixtures.mjs";
import { makeShop } from "../lib/data.mjs";

const NOT_READY_NOTE = "Card payments must be set up and switched on to sell gift cards on a shop: add your Stripe keys (see Setup) and tick Card under Payment methods. A shop also needs Card switched on in its own payment methods.";
const READY_NOTE = "Only shops that take card payments show gift cards.";
const NEEDS_CARD = "Set up card payments before selling gift cards on a shop.";

const actionOf = (req) => { try { return JSON.parse(req.postData() || "{}").action; } catch (e) { return ""; } };
const answerOf = (page, action) => page.waitForResponse(r => r.url().endsWith("/api/orders") && actionOf(r.request()) === action);

// Global settings → Save, through the page: returns { status, sent (the settings the page sent), body }.
async function saveThroughPage(page) {
  const saved = answerOf(page, "saveGlobalSettingsAll");
  await page.getByRole("button", { name: "Save global settings" }).click();
  const res = await saved;
  return { status: res.status(), sent: JSON.parse(res.request().postData()).settings, body: await res.json() };
}

// getGiftCardSettings answered in this page with `patch` laid over the real answer (`null` values remove a field).
async function stubGiftSettings(page, patch) {
  await page.route("**/api/orders", async (route) => {
    if (actionOf(route.request()) !== "getGiftCardSettings") return route.fallback();
    const res = await route.fetch();
    const j = await res.json();
    for (const [k, v] of Object.entries(patch)) { if (v === null) delete j.giftCards[k]; else j.giftCards[k] = v; }
    await route.fulfill({ response: res, json: j });
  });
}

// The shop's catalog in this customer's browser, with gift cards sold on it (`giftCards`) as a Stripe install would
// send it, and `extra` laid over the top of the answer (e.g. { preview: true }).
async function stubCatalog(page, giftCards, extra = {}) {
  await page.unroute("**/api/catalog**").catch(() => {});
  await page.route("**/api/catalog**", async (route) => {
    const res = await route.fetch();
    const j = await res.json();
    if (j && j.catalog) {
      j.catalog.enabledPayments = [...new Set([...(j.catalog.enabledPayments || []), "Card"])];
      j.catalog.giftCards = giftCards;
      Object.assign(j, extra);
    }
    await route.fulfill({ response: res, json: j });
  });
}

const restore = async (api, before, payBefore) => {
  await api("updateGlobalSettings", { globalSettings: { enabledPayments: payBefore } });
  await api("updateGiftCardSettings", { sellOnline: false, amounts: before.amounts, minCents: before.minCents, maxCents: before.maxCents });
};

// =========================================================================================================
test("Without card payments: the sell-online tick is disabled and unticked with its note, Save sends it off while the amounts save, and the server refuses selling online; Card off and on again changes nothing without Stripe", async ({ page, api }) => {
  test.setTimeout(120_000);
  const before = (await api("getGiftCardSettings")).giftCards;
  const payBefore = (await api("getGlobalSettings")).globalSettings.enabledPayments;
  expect(before.cardReady).toBe(false);
  try {
    // ---- the server: reading says cardReady false; selling online is refused, on its own and with Save -------------
    let r = await api("updateGiftCardSettings", { sellOnline: true, amounts: [2500, 5000], minCents: 1000, maxCents: 20000 }, { allowError: true, withStatus: true });
    expect(r.status).toBe(400);
    expect(r.data).toEqual({ status: "error", message: NEEDS_CARD });
    // A bad amount is still refused for its own reason first.
    r = await api("updateGiftCardSettings", { sellOnline: true, amounts: [], minCents: 1000, maxCents: 20000 }, { allowError: true, withStatus: true });
    expect(r.status).toBe(400);
    expect(r.data.message).not.toBe(NEEDS_CARD);
    r = await api("saveGlobalSettingsAll", { settings: { giftCards: { sellOnline: true, amounts: [2500], minCents: 1000, maxCents: 20000 } } }, { allowError: true, withStatus: true });
    expect(r.status).toBe(400);
    expect(r.data).toMatchObject({ status: "error", section: "Gift cards", message: NEEDS_CARD });
    // With the Card box switched off in the same Save: refused, and the Card box is not saved either (all or nothing).
    r = await api("saveGlobalSettingsAll", { settings: { payments: { ...payBefore, card: false }, giftCards: { sellOnline: true, amounts: [2500], minCents: 1000, maxCents: 20000 } } }, { allowError: true, withStatus: true });
    expect(r.status).toBe(400);
    expect(r.data).toMatchObject({ section: "Gift cards", message: NEEDS_CARD });
    expect((await api("getGlobalSettings")).globalSettings.enabledPayments.card).toBe(payBefore.card);
    // Selling off is accepted, and reading never fails.
    const off = await api("updateGiftCardSettings", { sellOnline: false, amounts: before.amounts, minCents: before.minCents, maxCents: before.maxCents });
    expect(off.status).toBe("ok");
    expect((await api("getGiftCardSettings")).giftCards).toMatchObject({ sellOnline: false, cardReady: false });

    // ---- the page: the tick disabled and unticked, with the note right under it ---------------------------------
    await openAdmin(page, "settings");
    await expect(page.getByRole("heading", { name: "Gift cards" })).toBeVisible();
    const sell = page.locator("#gGiftSell");
    await expect(sell).toBeDisabled();
    await expect(sell).not.toBeChecked();
    await expect(sell).toHaveAttribute("aria-describedby", "gGiftSellNote");
    await expect(page.locator("#gGiftSellNote")).toHaveText(NOT_READY_NOTE);
    await expect(page.getByText(READY_NOTE)).toHaveCount(0);
    await expect(page.getByRole("checkbox", { name: /Customers can buy gift cards on the shop/ })).toHaveAccessibleDescription(NOT_READY_NOTE);
    // The amount boxes stay editable, and Save sends selling off with them.
    await expect(page.locator("#gGiftAmounts")).toBeEditable();
    await expect(page.locator("#gGiftMin")).toBeEditable();
    await page.locator("#gGiftAmounts").fill("60, 30");
    await page.locator("#gGiftMin").fill("15");
    await page.locator("#gGiftMax").fill("150");
    let s = await saveThroughPage(page);
    expect(s.status).toBe(200);
    expect(s.sent.giftCards).toEqual({ sellOnline: false, amounts: [3000, 6000], minCents: 1500, maxCents: 15000 });
    expect((await api("getGiftCardSettings")).giftCards).toEqual({ sellOnline: false, amounts: [3000, 6000], minCents: 1500, maxCents: 15000, cardReady: false });
    await expect(page.locator("#gGiftAmounts")).toHaveValue("30, 60");
    await expect(page.locator("#gGiftSell")).toBeDisabled();

    // A stored "on" from before (here: the answer says so) is shown unticked and disabled, and Save sends it off.
    await stubGiftSettings(page, { sellOnline: true, cardReady: false });
    await openAdmin(page, "settings");
    await expect(page.locator("#gGiftSell")).toBeDisabled();
    await expect(page.locator("#gGiftSell")).not.toBeChecked();
    await expect(page.locator("#gGiftSellNote")).toHaveText(NOT_READY_NOTE);
    s = await saveThroughPage(page);
    expect(s.status).toBe(200);
    expect(s.sent.giftCards.sellOnline).toBe(false);
    await page.unroute("**/api/orders");

    // ---- the Global Card box switched off, then on again: still no Stripe, so still not ready --------------------
    await openAdmin(page, "settings");
    const card = page.locator("#gPayCard");
    if (!(await card.isChecked())) { await card.check(); expect((await saveThroughPage(page)).status).toBe(200); }
    await card.uncheck();
    s = await saveThroughPage(page);
    expect(s.status).toBe(200);
    expect(s.sent.payments.card).toBe(false);
    expect(s.sent.giftCards.sellOnline).toBe(false);
    await openAdmin(page, "settings");
    await expect(page.locator("#gPayCard")).not.toBeChecked();
    await expect(page.locator("#gGiftSell")).toBeDisabled();
    await expect(page.locator("#gGiftSellNote")).toHaveText(NOT_READY_NOTE);
    expect((await api("getGiftCardSettings")).giftCards.cardReady).toBe(false);
    await page.locator("#gPayCard").check();
    s = await saveThroughPage(page);
    expect(s.status).toBe(200);
    expect(s.sent.payments.card).toBe(true);
    await openAdmin(page, "settings");
    await expect(page.locator("#gPayCard")).toBeChecked();
    await expect(page.locator("#gGiftSell")).toBeDisabled();
    expect((await api("getGiftCardSettings")).giftCards.cardReady).toBe(false);
  } finally {
    await page.unroute("**/api/orders").catch(() => {});
    await restore(api, before, payBefore);
  }
  expect((await api("getGiftCardSettings")).giftCards).toEqual(before);
  expect((await api("getGlobalSettings")).globalSettings.enabledPayments).toEqual(payBefore);
});

// =========================================================================================================
test("With card payments ready: the tick works with the other note; ticked and saved, this Stripe-less server still refuses and nothing is stored; an older answer without cardReady leaves the tick working", async ({ page, api }) => {
  const before = (await api("getGiftCardSettings")).giftCards;
  const payBefore = (await api("getGlobalSettings")).globalSettings.enabledPayments;
  try {
    await stubGiftSettings(page, { cardReady: true });
    await openAdmin(page, "settings");
    const sell = page.locator("#gGiftSell");
    await expect(sell).toBeEnabled();
    await expect(sell).not.toBeChecked();
    await expect(sell).not.toHaveAttribute("aria-describedby", /./);
    await expect(page.locator("#gGiftSellNote")).toHaveText(READY_NOTE);
    await expect(page.getByText(NOT_READY_NOTE)).toHaveCount(0);
    await sell.check();
    const s = await saveThroughPage(page);
    expect(s.sent.giftCards.sellOnline).toBe(true);
    expect(s.status).toBe(400);
    expect(s.body).toMatchObject({ status: "error", section: "Gift cards", message: NEEDS_CARD });
    await expect(page.locator("#globalSettingsError")).toContainText(NEEDS_CARD);
    expect((await api("getGiftCardSettings")).giftCards.sellOnline).toBe(false);
    await page.unroute("**/api/orders");

    // A stored "on" with card payments ready shows ticked; an answer without cardReady (an older server) works as before.
    await stubGiftSettings(page, { sellOnline: true, cardReady: null });
    await openAdmin(page, "settings");
    await expect(page.locator("#gGiftSell")).toBeEnabled();
    await expect(page.locator("#gGiftSell")).toBeChecked();
    await expect(page.locator("#gGiftSellNote")).toHaveText(READY_NOTE);
    await page.locator("#gGiftSell").uncheck();
    const off = await saveThroughPage(page);
    expect(off.status).toBe(200);
    expect(off.sent.giftCards.sellOnline).toBe(false);
  } finally {
    await page.unroute("**/api/orders").catch(() => {});
    await restore(api, before, payBefore);
  }
  expect((await api("getGiftCardSettings")).giftCards).toEqual(before);
});

// =========================================================================================================
test("The shop's Gift card tile: first in the one Products section, the price range, opened by a click and from the keyboard, never in the cart; the header button stays; off, without Stripe or in preview there is none", async ({ api, as }) => {
  test.setTimeout(120_000);
  const shop = await makeShop(api, { prefix: "gctile", name: uniq("Example Club"), products: [{ name: "Club Tee", price: 20 }, { name: "Club Polo", price: 30 }] });
  const cp = await as(null);
  await stubCatalog(cp, { sellOnline: true, amounts: [25, 50, 100], min: 10, max: 200 });
  await cp.goto(shopUrl(shop.subdomain) + "/");
  await expect(cp.getByRole("heading", { level: 1, name: shop.name })).toBeVisible();

  // ---- the tile: first in the Products section, ahead of the products --------------------------------------------
  const tile = cp.locator(".gift-tile");
  await expect(tile).toHaveCount(1);
  const section = cp.locator(".cat-section");
  await expect(section).toHaveCount(1);
  await expect(section.locator(".cat-heading")).toHaveText("Products");
  await expect(cp.locator(".gift-tile-section")).toHaveCount(0);
  const order = await section.evaluate((s) => [...s.querySelectorAll(".gift-tile, .product")].map(e => e.classList.contains("gift-tile") ? "tile" : e.querySelector("h3").textContent.trim()));
  expect(order[0]).toBe("tile");
  expect(order.slice(1).sort()).toEqual(["Club Polo", "Club Tee"]);
  await expect(tile.getByRole("heading", { level: 3 })).toHaveText("Gift card");
  await expect(tile.locator(".product-price")).toHaveText("$10 – $200");
  await expect(tile.locator(".product-desc")).toHaveText("Emailed to the person you choose.");
  await expect(tile.locator("svg.gift-tile-pic")).toHaveAttribute("aria-hidden", "true");
  // Not a product: no product counted for it, no Add to cart, no product id.
  await expect(cp.locator(".product")).toHaveCount(2);
  await expect(tile.getByRole("button", { name: "Add to cart" })).toHaveCount(0);
  await expect(tile.locator("[data-pid]")).toHaveCount(0);
  // The header button is still there.
  await expect(cp.getByRole("button", { name: "Gift cards", exact: true })).toBeVisible();
  await expect(cp.locator(".cart-empty")).toHaveText("Nothing added yet.");

  // ---- a click anywhere on the tile (its picture) opens the buy form -------------------------------------------------
  const formHeading = cp.getByRole("heading", { level: 2, name: "Gift cards" });
  await tile.locator("svg.gift-tile-pic").click();
  await expect(formHeading).toBeVisible();
  await expect(cp).toHaveTitle(shop.name + " — Gift cards");
  await expect(cp.locator(".gb-amount")).toHaveText(["$25", "$50", "$100"]);
  const back = cp.getByRole("button", { name: "← Back to " + shop.name });
  await back.click();
  await expect(tile).toBeVisible();
  // …and its name.
  await tile.getByRole("heading", { level: 3, name: "Gift card" }).click();
  await expect(formHeading).toBeVisible();
  await back.click();

  // ---- from the keyboard: Tab from the header button reaches the tile's button; Enter and Space open the form --------
  const tileBtn = tile.getByRole("button", { name: "Buy a gift card" });
  for (const key of ["Enter", "Space"]) {
    await cp.getByRole("button", { name: "Gift cards", exact: true }).focus();
    await cp.keyboard.press("Tab");
    await expect(tileBtn).toBeFocused();
    await cp.keyboard.press(key);
    await expect(formHeading).toBeVisible();
    await back.click();
    await expect(tile).toBeVisible();
  }

  // ---- never in the cart: nothing added by it, and a real product goes in alone --------------------------------------
  await expect(cp.locator(".cart-empty")).toHaveText("Nothing added yet.");
  await expect(cp.locator("#cartBar")).toBeHidden();
  expect(await cp.evaluate((k) => { const v = sessionStorage.getItem(k); return v ? JSON.parse(v).length : 0; }, "cart:" + shop.orgId)).toBe(0);
  await cp.locator(".product", { hasText: "Club Tee" }).getByRole("button", { name: "Add to cart" }).click();
  await expect(cp.locator(".cart-empty")).toHaveCount(0);
  const cart = await cp.evaluate((k) => JSON.parse(sessionStorage.getItem(k) || "[]"), "cart:" + shop.orgId);
  expect(cart.length).toBe(1);
  expect(JSON.stringify(cart)).not.toMatch(/gift/i);
  await expect(cp.locator("#ticketPanel")).toContainText("Club Tee");
  await expect(cp.locator("#ticketPanel")).not.toContainText("Gift card");
  // The tile still opens the form with a cart, and the cart is unchanged after.
  await tileBtn.click();
  await expect(formHeading).toBeVisible();
  await back.click();
  expect((await cp.evaluate((k) => JSON.parse(sessionStorage.getItem(k) || "[]"), "cart:" + shop.orgId)).length).toBe(1);

  // ---- selling off ("unticked"): no tile and no header button ----------------------------------------------------------
  await stubCatalog(cp, { sellOnline: false, amounts: [], min: 10, max: 200 });
  await cp.goto(shopUrl(shop.subdomain) + "/");
  await expect(cp.locator(".product")).toHaveCount(2);
  await expect(cp.locator(".gift-tile")).toHaveCount(0);
  await expect(cp.getByRole("button", { name: "Gift cards", exact: true })).toHaveCount(0);
  await expect(cp.locator(".cat-section .cat-heading")).toHaveText(["Products"]);

  // ---- the real catalog (no Stripe on this install): none either -------------------------------------------------------
  await cp.unroute("**/api/catalog**");
  await cp.goto(shopUrl(shop.subdomain) + "/");
  await expect(cp.locator(".product")).toHaveCount(2);
  await expect(cp.locator(".gift-tile")).toHaveCount(0);

  // ---- a shop preview never shows it --------------------------------------------------------------------------------------
  await stubCatalog(cp, { sellOnline: true, amounts: [25, 50, 100], min: 10, max: 200 }, { preview: true });
  await cp.goto(shopUrl(shop.subdomain) + "/");
  await expect(cp.locator(".preview-bar")).toBeVisible();
  await expect(cp.locator(".product")).toHaveCount(2);
  await expect(cp.locator(".gift-tile")).toHaveCount(0);
  await expect(cp.getByRole("button", { name: "Gift cards", exact: true })).toHaveCount(0);
});

// =========================================================================================================
test("A shop with category sections: the Gift card tile is its own Gift cards section ahead of them; cents and a single amount in the price line", async ({ api, as }) => {
  const shop = await makeShop(api, { prefix: "gccats", name: uniq("Example School District"),
    products: [{ name: "District Tee", price: 18 }, { name: "District Cap", price: 22, type: "cap", idPrefix: "cap" }] });
  const cp = await as(null);
  await stubCatalog(cp, { sellOnline: true, amounts: [25, 50], min: 12.5, max: 75.25 });
  await cp.goto(shopUrl(shop.subdomain) + "/");
  await expect(cp.getByRole("heading", { level: 1, name: shop.name })).toBeVisible();
  await expect(cp.locator(".cat-section .cat-heading")).toHaveText(["Gift cards", "Shirts", "Caps"]);
  const giftSection = cp.getByRole("region", { name: "Gift cards" });
  await expect(giftSection).toHaveClass(/gift-tile-section/);
  await expect(giftSection.locator(".gift-tile")).toHaveCount(1);
  await expect(cp.locator(".gift-tile")).toHaveCount(1);
  await expect(giftSection.locator(".product")).toHaveCount(0);
  await expect(cp.locator(".product")).toHaveCount(2);
  await expect(giftSection.locator(".product-price")).toHaveText("$12.50 – $75.25");
  // The category links still jump to the categories only.
  await expect(cp.locator(".cat-nav-link")).toHaveText(["Shirts", "Caps"]);
  await giftSection.getByRole("button", { name: "Buy a gift card" }).click();
  await expect(cp.getByRole("heading", { level: 2, name: "Gift cards" })).toBeVisible();
  await expect(cp.getByText("Or another amount ($12.50 to $75.25)")).toBeVisible();

  // One amount and the same custom limits: one price, no range.
  await stubCatalog(cp, { sellOnline: true, amounts: [25], min: 25, max: 25 });
  await cp.goto(shopUrl(shop.subdomain) + "/");
  await expect(cp.locator(".gift-tile .product-price")).toHaveText("$25");
  await waitIdle(cp, 100);
});
