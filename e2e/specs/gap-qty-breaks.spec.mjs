// Quantity breaks (migrations/0109) in a real browser: from N pieces of one product in an order, every piece of it
// costs $X less (the deepest break reached).
//
// - The product form's "Quantity breaks" section (admin.js qtyBreaksSectionHtml_ / initQtyBreaks_ / readQtyBreaks_):
//   + Add a break and Remove, up to six rows, each mistake named before anything is sent, the breaks saved sorted and
//   shown again; a deepest break that takes the price under a blank's MAP refused by the server (code belowMap); a
//   product from a server older than breaks (no qtyBreaks list) has no section and its save sends none.
// - The server's own refusals of a bad list (db.js normalizeQtyBreaks_, through createProduct / updateProduct).
// - The shop page: no break table while the breaks are only a draft; after Publish the card's "Quantity pricing"
//   table, and the cart's prices dropping at the break and coming back below it (pieces counted per product, every
//   size together, never with another product), the "was" price, the savings line and the next-break hint; the order
//   placed at those prices and its lines and balance on the Orders page.
// - Local sale: 5,000 pieces on one line with the deepest break (the preview, its note, the recorded order), a typed
//   6,000 recorded as 5,000, and a break reached by two lines together, one of them at a typed price.
// - The product form's costs panel and its Price analysis window: the deepest break's price and what it leaves.
//
// Every test makes its own shop and products with unique names; nothing install-wide is changed.
import { test, expect, openAdmin, toast, uniq, shopUrl } from "../fixtures.mjs";
import { makeShop } from "../lib/data.mjs";

// A sized tee: S and M $20, L $22.
const TEE = (name, extra = {}) => ({ name, price: 0, idPrefix: "tee", extra: { pricingMode: "sized", sizePricing: { S: 20, M: 20, L: 22 }, ...extra } });
const BREAKS = [{ minQty: 6, off: 2 }, { minQty: 12, off: 3.5 }];

const editProduct = (page, shop, productId) => openAdmin(page, "catalog/orgs/" + shop.orgId + "/products/" + productId + "/edit");
const productOf = async (api, shop, productId) => (await api("listProducts", { org: shop.orgId })).products.find(p => p.productId === productId);
// The product form's break rows: the n-th (1-based) row's boxes and its Remove button, by their labels.
const breakMin = (page, n) => page.getByRole("spinbutton", { name: `Break ${n}: from how many pieces` });
const breakOff = (page, n) => page.getByRole("spinbutton", { name: `Break ${n}: dollars off each piece` });
const saveButton = (page) => page.getByRole("button", { name: "Save changes" }).first();
// The shop page's card of a product, and the cart's line of one size.
const card = (page, name) => page.locator("main").getByRole("heading", { level: 3, name, exact: true })
  .locator("xpath=ancestor::*[.//button[contains(@class,'add-btn')]][1]");
const cartLine = (page, name, size) => page.locator(".cart-line").filter({ hasText: size ? name + " · size " + size : name });
const cartTotal = (page) => page.locator("main .t-amount");
// A cart line's amount (the cell also holds its × remove button).
const money = (amount) => new RegExp("^\\$" + amount.replace(".", "\\.") + "\\s*×?$");
// The shop's Orders page, as a fresh load.
const ordersPage = async (page, shop) => {
  await openAdmin(page, "orders/" + shop.orgId);
  await expect(page.getByRole("combobox", { name: "Shop" })).toHaveValue(shop.orgId);
};
const orderRows = (page, orderId) => page.locator(`tr[data-order="${orderId}"]`);

test("the product form adds and removes breaks, names each mistake before sending anything, and saves them sorted", async ({ page, api }) => {
  const tee = uniq("Sample Tee");
  const shop = await makeShop(api, { prefix: "qbform", products: [TEE(tee)] });
  const pid = shop.products[0].productId;
  let saves = 0;
  page.on("request", r => { if (r.method() === "POST" && r.url().endsWith("/api/orders") && /"action":"updateProduct"/.test(r.postData() || "")) saves++; });
  await editProduct(page, shop, pid);
  const section = page.locator("#qtyBreaksSection");
  await expect(section).toContainText("Quantity breaks");
  await expect(section).toContainText("Up to 6.");
  await expect(section).toContainText("No quantity breaks: every piece is the same price however many are ordered.");
  const add = section.getByRole("button", { name: "+ Add a break" });
  const err = page.locator("#prodFormError");

  // A new row takes the focus.
  await add.click();
  await expect(breakMin(page, 1)).toBeFocused();
  await expect(section).not.toContainText("No quantity breaks");

  // Fewer than 2 pieces.
  await breakMin(page, 1).fill("1");
  await breakOff(page, 1).fill("2");
  await saveButton(page).click();
  await expect(err).toHaveText("A quantity break starts at a whole number of pieces from 2 to 100000.");
  await expect(breakMin(page, 1)).toBeFocused();
  // Not a whole number.
  await breakMin(page, 1).fill("6.5");
  await saveButton(page).click();
  await expect(err).toHaveText("A quantity break starts at a whole number of pieces from 2 to 100000.");
  // No amount off.
  await breakMin(page, 1).fill("6");
  await breakOff(page, 1).fill("");
  await saveButton(page).click();
  await expect(err).toHaveText("Enter the dollars off each piece for the break from 6 pieces (more than $0, in cents at most).");
  await expect(breakOff(page, 1)).toBeFocused();
  // Part of a cent.
  await breakOff(page, 1).fill("2.005");
  await saveButton(page).click();
  await expect(err).toHaveText("Enter the dollars off each piece for the break from 6 pieces (more than $0, in cents at most).");
  // As much as the lowest price (S and M, $20).
  await breakOff(page, 1).fill("20");
  await saveButton(page).click();
  await expect(err).toHaveText("The break from 6 pieces takes off $20.00 — it must be less than the product's lowest price ($20.00).");
  await expect(breakOff(page, 1)).toBeFocused();
  await breakOff(page, 1).fill("2");

  // Two breaks at the same number.
  await add.click();
  await expect(breakMin(page, 2)).toBeFocused();
  await breakMin(page, 2).fill("6");
  await breakOff(page, 2).fill("3");
  await saveButton(page).click();
  await expect(err).toHaveText("Two quantity breaks start at 6 pieces — give each its own number.");
  await expect(breakMin(page, 2)).toBeFocused();
  // A bigger break that takes less off.
  await breakMin(page, 2).fill("12");
  await breakOff(page, 2).fill("1.50");
  await saveButton(page).click();
  await expect(err).toHaveText("A bigger break must take more off: from 12 pieces should be more than $2.00 off.");
  await expect(breakOff(page, 2)).toBeFocused();
  expect(saves, "nothing was sent while the breaks had a mistake").toBe(0);

  // Up to six rows: the add button goes at six and comes back after a Remove, which keeps what was typed in the others.
  for (let n = 3; n <= 6; n++) await add.click();
  await expect(section.locator(".qty-break-row")).toHaveCount(6);
  await expect(add).toBeHidden();
  await section.getByRole("button", { name: "Remove break 6" }).click();
  await expect(section.locator(".qty-break-row")).toHaveCount(5);
  await expect(add).toBeVisible();
  await expect(breakMin(page, 5)).toBeFocused();
  await expect(breakMin(page, 2)).toHaveValue("12");
  // Remove the first row: the second moves up with its values.
  await section.getByRole("button", { name: "Remove break 1" }).click();
  await expect(breakMin(page, 1)).toHaveValue("12");
  await expect(breakOff(page, 1)).toHaveValue("1.50");
  await expect(breakMin(page, 1)).toBeFocused();

  // Typed out of order (12 first), with three empty rows left: saved sorted, the empty rows dropped.
  await breakOff(page, 1).fill("3.50");
  await breakMin(page, 2).fill("6");
  await breakOff(page, 2).fill("2");
  const sent = page.waitForRequest(r => r.url().endsWith("/api/orders") && /"action":"updateProduct"/.test(r.postData() || ""));
  await saveButton(page).click();
  expect(JSON.parse((await sent).postData()).qtyBreaks).toEqual(BREAKS);
  await expect(toast(page)).toContainText("Saved.");
  expect((await productOf(api, shop, pid)).qtyBreaks).toEqual(BREAKS);

  // Shown again in order on the form; taking every row off saves none.
  await editProduct(page, shop, pid);
  await expect(section.locator(".qty-break-row")).toHaveCount(2);
  await expect(breakMin(page, 1)).toHaveValue("6");
  await expect(breakOff(page, 1)).toHaveValue("2");
  await expect(breakMin(page, 2)).toHaveValue("12");
  await expect(breakOff(page, 2)).toHaveValue("3.5");
  await section.getByRole("button", { name: "Remove break 2" }).click();
  await section.getByRole("button", { name: "Remove break 1" }).click();
  await expect(section).toContainText("No quantity breaks");
  await expect(add).toBeFocused();
  const cleared = page.waitForRequest(r => r.url().endsWith("/api/orders") && /"action":"updateProduct"/.test(r.postData() || ""));
  await saveButton(page).click();
  expect(JSON.parse((await cleared).postData()).qtyBreaks).toEqual([]);
  await expect(toast(page)).toContainText("Saved.");
  expect((await productOf(api, shop, pid)).qtyBreaks).toEqual([]);
});

test("the server refuses a bad list of breaks with a plain message and keeps the product as it was", async ({ api }) => {
  const tee = uniq("Sample Tee");
  const shop = await makeShop(api, { prefix: "qbsrv", publish: false, products: [TEE(tee, { qtyBreaks: BREAKS })] });
  const pid = shop.products[0].productId;
  // createProduct took the breaks it was given.
  expect((await productOf(api, shop, pid)).qtyBreaks).toEqual(BREAKS);
  // updateProduct takes the whole product, as the form sends it.
  const saved = await productOf(api, shop, pid);
  const update = (qtyBreaks, more = {}) => api("updateProduct", { ...saved, org: shop.orgId, productId: pid, qtyBreaks, ...more }, { allowError: true, withStatus: true });
  const refusals = [
    ["not a list", { minQty: 6, off: 2 }, "Quantity breaks must be a list."],
    ["seven breaks", [2, 3, 4, 5, 6, 7, 8].map((n, i) => ({ minQty: n, off: i + 1 })), "Up to 6 quantity breaks."],
    ["one piece", [{ minQty: 1, off: 2 }], "A quantity break starts at a whole number of pieces from 2 to 100,000."],
    ["over 100,000 pieces", [{ minQty: 100001, off: 2 }], "A quantity break starts at a whole number of pieces from 2 to 100,000."],
    ["no amount off", [{ minQty: 6, off: "" }], "The break from 6 pieces needs an amount off each piece, more than $0."],
    ["nothing off", [{ minQty: 6, off: 0 }], "The break from 6 pieces needs an amount off each piece, more than $0."],
    ["the same number twice", [{ minQty: 6, off: 2 }, { minQty: 6, off: 3 }], "Two quantity breaks start at 6 pieces."],
    ["less off for more pieces", [{ minQty: 12, off: 1 }, { minQty: 6, off: 2 }], "The break from 12 pieces must take more off than the break from 6."],
    ["the same off for more pieces", [{ minQty: 6, off: 2 }, { minQty: 12, off: 2 }], "The break from 12 pieces must take more off than the break from 6."],
    ["the whole lowest price", [{ minQty: 6, off: 20 }], "The break from 6 pieces takes $20.00 off — it must be less than the lowest price, $20.00."],
  ];
  for (const [what, list, message] of refusals) {
    const r = await update(list);
    expect(r.status, what).toBe(400);
    expect(r.data.message, what).toBe(message);
  }
  // With new prices in the same save, the lowest of those is the one checked: $15 off is refused under a $15 S.
  const r = await update([{ minQty: 6, off: 15 }], { sizePricing: { S: 15, M: 20, L: 22 } });
  expect(r.status).toBe(400);
  expect(r.data.message).toBe("The break from 6 pieces takes $15.00 off — it must be less than the lowest price, $15.00.");
  // A new product with a bad list isn't made.
  const bad = await api("createProduct", { org: shop.orgId, productId: pid + "x", type: "shirt", name: uniq("Sample Cap"), pricingMode: "flat", flatPrice: 10,
    visible: true, images: [], qtyBreaks: [{ minQty: 6, off: 10 }] }, { allowError: true, withStatus: true });
  expect(bad.status).toBe(400);
  expect(bad.data.message).toBe("The break from 6 pieces takes $10.00 off — it must be less than the lowest price, $10.00.");
  expect((await api("listProducts", { org: shop.orgId })).products.map(p => p.productId)).toEqual([pid]);
  const after = await productOf(api, shop, pid);
  expect(after.qtyBreaks).toEqual(BREAKS);
  expect(after.sizePricing).toEqual({ S: 20, M: 20, L: 22 });
});

test("a deepest break under a blank's MAP shows in the costs panel and the save is refused", async ({ page, api }) => {
  const cap = uniq("Sample Cap"), blank = uniq("Map Blank");
  const blankId = (await api("createBlank", { name: blank, productType: "cap", vendor: "", brand: uniq("Test Map Co"), sku: "", notes: "", color: "Navy",
    colors: [{ color: "Navy", images: [], sizes: [{ size: "M", quantity: 5, vendorPrice: 4, mapPrice: 18 }] }] })).id;
  const shop = await makeShop(api, { prefix: "qbmap", products: [{ name: cap, price: 20, idPrefix: "cap", type: "cap" }] });
  const pid = shop.products[0].productId;
  await api("saveBlankLinks", { org: shop.orgId, productId: pid, remove: [], set: [{ productColor: "", productSize: "OSFA", blankId, blankColor: "Navy", blankSize: "M" }] });

  await editProduct(page, shop, pid);
  const panel = page.locator("#pricingTable");
  await expect(panel).not.toContainText("Working out costs");
  await expect(panel.locator(".pricing-table, table").first()).toBeVisible();
  await expect(panel).not.toContainText("below the MAP");
  await page.locator("#qtyBreaksSection").getByRole("button", { name: "+ Add a break" }).click();
  await breakMin(page, 1).fill("6");
  await breakOff(page, 1).fill("3");
  // The panel follows the typed break: $17.00 at 6+ pieces is under the $18.00 MAP.
  const why = `The price at the 6+ pieces break, $17.00, is below the MAP of $18.00 (${blank} Navy M)`;
  await expect(panel.locator(".pricing-problems")).toContainText(why);
  await expect(panel.locator(".pricing-break")).toContainText("At the deepest quantity break (from 6 pieces): $17.00 a piece");
  await saveButton(page).click();
  await expect(page.locator("#prodFormError")).toHaveText(`Below the vendor's minimum advertised price (MAP): ${why}. Raise the price to at least the MAP.`);
  expect((await productOf(api, shop, pid)).qtyBreaks).toEqual([]);
  // The server says the same to a request without the page.
  const r = await api("updateProduct", { ...(await productOf(api, shop, pid)), org: shop.orgId, productId: pid, qtyBreaks: [{ minQty: 6, off: 3 }] }, { allowError: true, withStatus: true });
  expect(r.status).toBe(400);
  expect(r.data.code).toBe("belowMap");
  // $2 off leaves $18.00, the MAP itself: saved.
  await breakOff(page, 1).fill("2");
  await expect(panel.locator(".pricing-break")).toContainText("(from 6 pieces): $18.00 a piece");
  await expect(panel).not.toContainText("below the MAP");
  await saveButton(page).click();
  await expect(toast(page)).toContainText("Saved.");
  expect((await productOf(api, shop, pid)).qtyBreaks).toEqual([{ minQty: 6, off: 2 }]);
});

test("a product the server sends without a breaks list has no breaks section, and its save sends none", async ({ page, api }) => {
  const tee = uniq("Sample Tee");
  const shop = await makeShop(api, { prefix: "qbold", publish: false, products: [TEE(tee, { qtyBreaks: BREAKS })] });
  const pid = shop.products[0].productId;
  // A server older than migrations/0109: listProducts' products carry no qtyBreaks.
  await page.route("**/api/orders", async (route) => {
    const req = route.request();
    if (!/"action":"listProducts"/.test(req.postData() || "")) return route.continue();
    const res = await route.fetch();
    const data = await res.json();
    for (const p of data.products || []) delete p.qtyBreaks;
    await route.fulfill({ response: res, json: data });
  });
  await editProduct(page, shop, pid);
  await expect(page.locator("#prodFormName")).toHaveValue(tee);
  await expect(page.locator("#qtyBreaksSection")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "+ Add a break" })).toHaveCount(0);
  const sent = page.waitForRequest(r => r.url().endsWith("/api/orders") && /"action":"updateProduct"/.test(r.postData() || ""));
  await saveButton(page).click();
  expect(JSON.parse((await sent).postData())).not.toHaveProperty("qtyBreaks");
  await expect(toast(page)).toContainText("Saved.");
  // The breaks the form never showed are still there.
  expect((await productOf(api, shop, pid)).qtyBreaks).toEqual(BREAKS);
});

test("the shop shows the break table after Publish, and the cart's prices drop at the break and come back below it", async ({ page, api, as }) => {
  const tee = uniq("Sample Tee"), cap = uniq("Sample Cap");
  const shop = await makeShop(api, { prefix: "qbshop", products: [TEE(tee), { name: cap, price: 15, idPrefix: "cap", type: "cap" }] });
  const pid = shop.products[0].productId;

  // The breaks typed on the product form and saved: a draft until Publish.
  await editProduct(page, shop, pid);
  const section = page.locator("#qtyBreaksSection");
  await section.getByRole("button", { name: "+ Add a break" }).click();
  await breakMin(page, 1).fill("6");
  await breakOff(page, 1).fill("2");
  await section.getByRole("button", { name: "+ Add a break" }).click();
  await breakMin(page, 2).fill("12");
  await breakOff(page, 2).fill("3.50");
  await saveButton(page).click();
  await expect(toast(page)).toContainText("Saved.");

  const shopper = await as(null);
  await shopper.goto(shopUrl(shop.subdomain) + "/");
  await expect(card(shopper, tee)).toBeVisible();
  await expect(shopper.locator("table.qty-breaks")).toHaveCount(0);

  // Publish, from Manage catalog's row for the shop.
  await openAdmin(page, "catalog");
  const row = page.locator("main tr", { hasText: shop.orgId });
  await expect(row).toContainText("Unpublished changes");
  await row.getByRole("button", { name: "Publish" }).click();
  await expect(page.locator("main tr", { hasText: shop.orgId })).toContainText("✓ Published");

  // The tee's card has the table; the cap, without breaks, has none.
  await shopper.goto(shopUrl(shop.subdomain) + "/");
  const table = card(shopper, tee).getByRole("table", { name: "Quantity pricing" });
  await expect(table.getByRole("row")).toHaveText(["6+ pieces$2.00 off each", "12+ pieces$3.50 off each"]);
  await expect(card(shopper, tee).locator(".qty-breaks-note")).toHaveText("Counts every size of this item in your order.");
  await expect(card(shopper, cap).locator("table.qty-breaks")).toHaveCount(0);

  const add = async (name, size, qty) => {
    const c = card(shopper, name);
    if (size) await shopper.getByLabel("Size for " + name).selectOption(size);
    await c.getByRole("spinbutton", { name: "Quantity for " + name }).fill(String(qty));
    await c.getByRole("button", { name: "Add to cart" }).click();
  };
  const S = cartLine(shopper, tee, "S"), M = cartLine(shopper, tee, "M"), L = cartLine(shopper, tee, "L");
  const savings = shopper.locator(".cart-savings"), hints = shopper.locator(".qty-break-next");

  // 3 S: no break yet; the hint names how many more reach the first.
  await add(tee, "S", 3);
  await expect(S).toContainText("× $20.00 each");
  await expect(S.locator(".l-price")).toHaveText(money("60.00"));
  await expect(S.locator(".qty-break-next")).toHaveText(`Add 3 more ${tee} for $2.00 off each.`);
  await expect(cartTotal(shopper)).toHaveText("$60.00");
  // + 2 M: 5 pieces, and the hint moves to the product's last line only.
  await add(tee, "M", 2);
  await expect(cartTotal(shopper)).toHaveText("$100.00");
  await expect(hints).toHaveCount(1);
  await expect(M.locator(".qty-break-next")).toHaveText(`Add 1 more ${tee} for $2.00 off each.`);
  // + 1 cap: six pieces in the cart, but only five tees — another product never counts toward the tee's break.
  await add(cap, null, 1);
  await expect(cartTotal(shopper)).toHaveText("$115.00");
  await expect(savings).toHaveCount(0);
  await expect(shopper.locator(".qty-break-on")).toHaveCount(0);
  await expect(cartLine(shopper, cap).locator(".qty-break-next")).toHaveCount(0);
  // + 1 L: six tees. Every tee line is $2.00 less, L's $22 too; the cap isn't.
  await add(tee, "L", 1);
  await expect(S).toContainText("× $18.00 each (was $20.00)");
  await expect(S.locator(".qty-break-on")).toHaveText("Quantity price: 6+ pieces, $2.00 off each");
  await expect(S.locator(".l-price")).toHaveText(money("54.00"));
  await expect(M.locator(".l-price")).toHaveText(money("36.00"));
  await expect(L).toContainText("× $20.00 each (was $22.00)");
  await expect(L.locator(".l-price")).toHaveText(money("20.00"));
  await expect(cartLine(shopper, cap)).toContainText("× $15.00 each");
  await expect(cartLine(shopper, cap).locator(".cart-was")).toHaveCount(0);
  await expect(savings).toHaveText("Quantity savings: $12.00 (already taken off the prices above)");
  await expect(L.locator(".qty-break-next")).toHaveText(`Add 6 more ${tee} for $3.50 off each.`);
  await expect(hints).toHaveCount(1);
  await expect(cartTotal(shopper)).toHaveText("$125.00");
  // One fewer M: five tees, back to the list prices.
  await M.getByRole("button", { name: "One fewer " + tee }).click();
  await expect(cartTotal(shopper)).toHaveText("$117.00");
  await expect(S).toContainText("× $20.00 each");
  await expect(shopper.locator(".cart-was")).toHaveCount(0);
  await expect(shopper.locator(".qty-break-on")).toHaveCount(0);
  await expect(savings).toHaveCount(0);
  await expect(L.locator(".qty-break-next")).toHaveText(`Add 1 more ${tee} for $2.00 off each.`);
  // One more M again: six.
  await M.getByRole("button", { name: "One more " + tee }).click();
  await expect(cartTotal(shopper)).toHaveText("$125.00");
  // Six more S: twelve tees, the deeper break ($3.50), and no further break to hint at.
  for (let i = 0; i < 6; i++) await S.getByRole("button", { name: "One more " + tee }).click();
  await expect(S.locator("[aria-label='Quantity']")).toHaveText("9");
  await expect(S).toContainText("× $16.50 each (was $20.00)");
  await expect(S.locator(".qty-break-on")).toHaveText("Quantity price: 12+ pieces, $3.50 off each");
  await expect(S.locator(".l-price")).toHaveText(money("148.50"));
  await expect(M.locator(".l-price")).toHaveText(money("33.00"));
  await expect(L.locator(".l-price")).toHaveText(money("18.50"));
  await expect(savings).toHaveText("Quantity savings: $42.00 (already taken off the prices above)");
  await expect(hints).toHaveCount(0);
  await expect(shopper.getByRole("heading", { level: 2, name: "Your order (13 items)" })).toBeVisible();
  await expect(cartTotal(shopper)).toHaveText("$215.00");

  // The order costs what the cart showed.
  await shopper.getByLabel("Your name").fill(uniq("Casey Bulkbuyer"));
  await shopper.getByLabel("Email address").fill("casey@example.test");
  await shopper.getByLabel("Payment method").selectOption({ label: "Venmo" });
  await shopper.getByRole("button", { name: "Place order" }).click();
  await expect(shopper.getByRole("heading", { level: 2, name: /^Order received/ })).toBeVisible();
  const m = /^\s*(\S+)\s*·\s*\$([\d,.]+)/.exec(await shopper.locator(".confirmation .order-number").textContent());
  const orderId = m[1];
  expect(m[2]).toBe("215.00");

  // The Orders page: each line at its break price, and the balance the whole $215.
  await ordersPage(page, shop);
  const rows = orderRows(page, orderId);
  await expect(rows).toHaveCount(4);
  const lineOf = (size, name = tee) => rows.filter({ has: page.locator("td", { hasText: new RegExp("^" + size + "$") }) }).filter({ hasText: name });
  await expect(lineOf("S")).toContainText("$148.50");
  await expect(lineOf("M")).toContainText("$33.00");
  await expect(lineOf("L")).toContainText("$18.50");
  await expect(rows.filter({ hasText: cap })).toContainText("$15.00");
  await expect(rows.first().locator("[data-balance-td]")).toHaveText("$215.00");
  const order = (await api("getOrders", { org: shop.orgId })).orders.find(o => o.orderId === orderId);
  expect(order.total).toBe(215);
  expect(order.items.filter(i => i.name === tee).map(i => [i.size, i.qty, i.unitPrice]).sort()).toEqual([["L", 1, 18.5], ["M", 2, 16.5], ["S", 9, 16.5]]);
  expect(order.items.filter(i => i.name === cap).map(i => [i.qty, i.unitPrice])).toEqual([[1, 15]]);
});

test("Local sale: 5,000 pieces on one line take the deepest break, and the order is recorded at it", async ({ page, api }) => {
  const tee = uniq("Sample Tee");
  const shop = await makeShop(api, { prefix: "qbls", products: [TEE(tee, { qtyBreaks: BREAKS })] });
  const pid = shop.products[0].productId;
  const customer = uniq("Jordan Bulkorder");
  await ordersPage(page, shop);
  await page.getByRole("button", { name: "+ Local sale" }).click();
  const form = page.locator("#localSaleForm");
  await expect(form).toBeVisible();
  await form.locator("#lsProduct").selectOption(pid);
  await form.locator("#lsSize").selectOption("S");
  const preview = form.locator("#lsPricePreview"), note = form.locator("#lsBreakNote");
  // Below the first break: the list price, no note.
  await form.locator("#lsQty").fill("5");
  await expect(preview).toHaveText("$20.00 × 5 = $100.00");
  await expect(note).toBeHidden();
  // At the first break.
  await form.locator("#lsQty").fill("6");
  await expect(preview).toHaveText("$18.00 (was $20.00, 6+ pieces) × 6 = $108.00");
  await expect(note).toBeVisible();
  // 5,000: the deepest.
  await form.locator("#lsQty").fill("5000");
  await expect(preview).toHaveText("$16.50 (was $20.00, 12+ pieces) × 5000 = $82500.00");
  await expect(note).toHaveText("Quantity breaks count every piece of a product in this sale. They're worked out again from the shop's published prices when the sale is recorded.");
  // More than 5,000 is worked out as 5,000 (the box itself allows no more than 5,000).
  await form.locator("#lsQty").fill("6000");
  await expect(preview).toHaveText("$16.50 (was $20.00, 12+ pieces) × 5000 = $82500.00");
  // Back under the break: the note goes.
  await form.locator("#lsQty").fill("2");
  await expect(preview).toHaveText("$20.00 × 2 = $40.00");
  await expect(note).toBeHidden();
  await form.locator("#lsQty").fill("5000");

  await form.locator("#lsPayment").selectOption("Cash");
  await form.locator("summary", { hasText: "Customer info" }).click();
  await form.locator("#lsName").fill(customer);
  const sent = page.waitForRequest(r => r.url().endsWith("/api/orders") && /"action":"createLocalSale"/.test(r.postData() || ""));
  await form.getByRole("button", { name: "Record sale" }).click();
  const body = JSON.parse((await sent).postData());
  expect(body.items.map(i => [i.productId, i.size, i.qty])).toEqual([[pid, "S", 5000]]);
  await expect(toast(page)).toContainText("Local sale recorded — ");

  const order = (await api("getOrders", { org: shop.orgId })).orders.find(o => o.customerName === customer);
  expect(order.total).toBe(82500);
  expect(order.items.map(i => [i.size, i.qty, i.unitPrice, i.lineTotal])).toEqual([["S", 5000, 16.5, 82500]]);
  await ordersPage(page, shop);
  const rows = orderRows(page, order.orderId);
  await expect(rows).toHaveCount(1);
  await expect(rows.locator("td").filter({ hasText: /^5000$/ })).toHaveCount(1);
  await expect(rows).toContainText("$82500.00");
});

test("Local sale: two lines of a product reach its break together, a line at a typed price counts but keeps its price", async ({ page, api }) => {
  const tee = uniq("Sample Tee");
  const shop = await makeShop(api, { prefix: "qbls2", products: [TEE(tee, { qtyBreaks: BREAKS })] });
  const pid = shop.products[0].productId;
  const customer = uniq("Jordan Twosizes");
  await ordersPage(page, shop);
  await page.getByRole("button", { name: "+ Local sale" }).click();
  const form = page.locator("#localSaleForm");
  const items = form.locator(".ls-line");
  await form.locator("#lsProduct").selectOption(pid);
  await form.locator("#lsSize").selectOption("S");
  await form.locator("#lsQty").fill("4");
  await expect(form.locator("#lsPricePreview")).toHaveText("$20.00 × 4 = $80.00");
  await form.getByRole("button", { name: "+ Add another item" }).click();
  const second = items.nth(1);
  await second.locator('[data-f="product"]').selectOption(pid);
  await second.locator('[data-f="size"]').selectOption("M");
  await second.locator('[data-f="qty"]').fill("2");
  // 6 tees across the two lines: both at the 6+ price.
  await expect(items.nth(0).locator('[data-f="linePrice"]')).toHaveText("$18.00 (was $20.00, 6+ pieces) × 4 = $72.00");
  await expect(second.locator('[data-f="linePrice"]')).toHaveText("$18.00 (was $20.00, 6+ pieces) × 2 = $36.00");
  await expect(form.locator("#lsPricePreview")).toHaveText("Total for 2 items: $108.00");
  await expect(form.locator("#lsBreakNote")).toBeVisible();
  // The second line at a typed $10: it still counts toward the six, but keeps its own price.
  await second.locator('[data-f="override"]').check();
  await second.locator('[data-f="customPrice"]').fill("10");
  await expect(second.locator('[data-f="linePrice"]')).toHaveText("$10.00 (custom) × 2 = $20.00");
  await expect(items.nth(0).locator('[data-f="linePrice"]')).toHaveText("$18.00 (was $20.00, 6+ pieces) × 4 = $72.00");
  await expect(form.locator("#lsPricePreview")).toHaveText("Total for 2 items: $92.00");

  await form.locator("#lsPayment").selectOption("Cash");
  await form.locator("summary", { hasText: "Customer info" }).click();
  await form.locator("#lsName").fill(customer);
  await form.getByRole("button", { name: "Record sale" }).click();
  await expect(toast(page)).toContainText("Local sale recorded — ");
  const order = (await api("getOrders", { org: shop.orgId })).orders.find(o => o.customerName === customer);
  expect(order.total).toBe(92);
  expect(order.items.map(i => [i.size, i.qty, i.unitPrice]).sort()).toEqual([["M", 2, 10], ["S", 4, 18]]);
});

test("the costs panel and Price analysis show the deepest break's price and what it leaves, red when it loses money", async ({ page, api }) => {
  const scarf = uniq("Sample Scarf");
  // $100, no blank, not taxable, no supplies: the costs are only the card fee, so $95 at the break leaves well over any target.
  const shop = await makeShop(api, { prefix: "qbcost", publish: false, products: [{ name: scarf, price: 100, idPrefix: "scarf",
    extra: { noBlankNeeded: true, taxable: false, suppliesCost: 0, qtyBreaks: [{ minQty: 6, off: 2 }, { minQty: 12, off: 5 }] } }] });
  const pid = shop.products[0].productId;
  await editProduct(page, shop, pid);
  const line = page.locator("#pricingTable .pricing-break");
  await expect(line).toContainText("At the deepest quantity break (from 12 pieces): $95.00 a piece, leaving $");
  await expect(line).toContainText("after costs.");
  const margin = line.locator("b").nth(1);
  await expect(margin).not.toContainText("⚠");
  await expect(margin).toHaveCSS("color", "rgb(22, 101, 52)");
  // Analysed from what's typed: a deeper break (24 pieces, $8) before it is saved.
  await page.locator("#qtyBreaksSection").getByRole("button", { name: "+ Add a break" }).click();
  await breakMin(page, 3).fill("24");
  await breakOff(page, 3).fill("8");
  await expect(line).toContainText("At the deepest quantity break (from 24 pieces): $92.00 a piece");
  // A half-typed row doesn't count.
  await page.locator("#qtyBreaksSection").getByRole("button", { name: "+ Add a break" }).click();
  await breakMin(page, 4).fill("48");
  await expect(line).toContainText("(from 24 pieces)");
  // A $120 transfer cost: the break loses money, in red with a ⚠.
  await page.locator("#prodFormTransferCost").fill("120");
  await expect(margin).toContainText("⚠ −$");
  await expect(margin).toHaveCSS("color", "rgb(176, 58, 46)");

  // Price analysis, from the same typed figures.
  await page.locator("#prodPriceAnalysisBtn").click();
  const dlg = page.locator(".admin-modal").filter({ hasText: "Price analysis — " + scarf });
  await expect(dlg.locator(".pricing-break")).toContainText("At the deepest quantity break (from 24 pieces): $92.00 a piece, leaving ⚠ −$");
  await dlg.getByRole("button", { name: "Done" }).click();
  await expect(dlg).toHaveCount(0);

  // Every break taken off: no break line.
  await page.locator("#prodFormTransferCost").fill("");
  for (let n = 4; n >= 1; n--) await page.locator("#qtyBreaksSection").getByRole("button", { name: `Remove break ${n}` }).click();
  await expect(page.locator("#pricingTable table")).toBeVisible();
  await expect(line).toHaveCount(0);
  // The saved product (still with its two breaks) in the shop's Price analysis.
  await page.evaluate(() => { window._prodFormDirty = false; });
  const saved = await api("analyzePricing", { org: shop.orgId, productId: pid });
  expect(saved.products[0].deepestBreak).toMatchObject({ minQty: 12, off: 5, unitPrice: 95 });
});
