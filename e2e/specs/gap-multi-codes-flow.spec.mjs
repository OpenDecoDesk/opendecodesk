// More than one discount code on an order (migrations/0120) end to end, in a real browser:
//   - Global settings → Discount codes: "More than one discount code can be used on an order" ticked and saved through
//     the page; the shop's catalog says so without a Publish;
//   - the Discount codes page's New code window makes a "Free shipping only" code and an amount code with a minimum
//     order (its own check of the minimum, then the list shows each label);
//   - a customer's checkout: a 10% and a 15% code add up to 25%, an amount code comes off what is left, the free-shipping
//     code takes the delivery fee off; the same code twice is refused; × on one code asks again about the rest; the
//     order carries every code ("Codes …"), its shipping discount and the server's totals, on the confirmation and the
//     Orders page;
//   - a minimum-order code is refused below its minimum, works above it, and comes off (with the reason) when the cart
//     drops below it again;
//   - back to one code (through the page): the checkout box takes one code and Remove; the server refuses a second code
//     on a check and on an order;
//   - the order page (Payments): Add code changes the totals, a second code is refused while one is allowed, a manual
//     discount is refused while a code is on (and a code while a manual discount is on), × takes it off again; Production
//     is refused by the server;
//   - a quote: a code added in the quote editor (a wrong one refused), sent, seen by the customer with the discount, and
//     accepted: the order carries the code; a code switched off after it was put on a quote stops the send;
//   - the customer invoice page takes a code (a wrong one is refused, the box goes once no more can be added), and a
//     second one when more than one is allowed.
//
// It changes Global settings → Discount codes for the whole install, so it runs alone (ALONE in
// e2e/playwright.config.mjs), and puts the rule back as it found it at the end of every test. Every test makes its own
// shop (each code is for that shop only), customers, orders and codes, with this run's tag in every code.
import { test, expect, openAdmin, toast, uniq, slug, shopUrl, waitIdle, confirmDialog, apiContext, callApi } from "../fixtures.mjs";
import { makeShop, placeOrder } from "../lib/data.mjs";

const TAG = uniq("mc").split(" ")[1].toUpperCase().replace(/[^A-Z0-9]/g, "");
const codeOf = (name) => (name + TAG).slice(0, 32);
const PRODUCTS = [{ name: "Sample Tee", price: 20 }];
const FAR = "2099-12-31";
const ONE_CODE = "Only one discount code can be used on an order.";
const GENERIC = "This code isn't valid. If it was sent to you, check the email address is the one it was sent to.";

// ---- helpers ---------------------------------------------------------------------------------------------
const actionOf = (req) => { try { return JSON.parse(req.postData() || "{}").action; } catch (e) { return ""; } };
const answerOf = (page, action) => page.waitForResponse(r => r.url().endsWith("/api/orders") && actionOf(r.request()) === action);
const cellsOf = async (row) => (await row.locator("td").allTextContents()).map(s => s.trim().replace(/\s+/g, " "));

const apiCode = async (api, shop, input) => (await api("saveDiscountCode", { code: { kind: "percent", percent: 10, maxUses: 50, orgId: shop.orgId, ...input } })).code;
const rules = async (api) => (await api("getDiscountRules")).discountRules;
const setMultiple = (api, multiple) => api("updateDiscountRules", { multiple });

// Runs `fn` and puts the install's rule back as it was, whatever happens.
async function keepingRule(api, fn) {
  const before = await rules(api);
  try { await fn(before); }
  finally { await setMultiple(api, before.multiple); }
}

// Global settings → Discount codes, through the page: tick or untick, save, and the server has it.
async function ruleThroughPage(page, api, multiple) {
  await openAdmin(page, "settings");
  const box = page.locator("#gDiscMultiple");
  await expect(box).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Discount codes" })).toBeVisible();
  await expect(page.getByText("Off: one code per order. On: percent codes add up (10% and 15% make 25%")).toBeVisible();
  await expect(box).toBeChecked({ checked: !multiple });
  if (multiple) await box.check(); else await box.uncheck();
  const saved = page.waitForResponse(r => r.url().endsWith("/api/orders") && actionOf(r.request()) === "saveGlobalSettingsAll");
  await page.getByRole("button", { name: "Save global settings" }).click();
  const sent = JSON.parse((await saved).request().postData());
  expect(sent.settings.discountRules).toEqual({ multiple });
  await expect(toast(page)).toContainText("Global settings saved.");
  expect(await rules(api)).toEqual({ multiple });
}

// The shop's page in a customer's own browser: `qty` tees in the cart, name, email and Check.
async function checkout(as, shop, { qty = 1, email = "casey@example.test", delivery = null } = {}) {
  const cp = await as(null);
  await cp.goto(shopUrl(shop.subdomain) + "/");
  await expect(cp.getByRole("heading", { level: 1, name: shop.name })).toBeVisible();
  const card = cp.locator("main").getByRole("heading", { level: 3, name: "Sample Tee", exact: true }).locator("xpath=ancestor::*[.//button[normalize-space()='Add to cart']][1]");
  if (qty !== 1) await card.getByRole("spinbutton").fill(String(qty));
  await card.getByRole("button", { name: "Add to cart" }).click();
  if (delivery) await cp.getByRole("radio", { name: new RegExp("^" + delivery) }).check();
  await cp.getByLabel("Your name").fill(uniq("Casey Customer"));
  await cp.getByLabel("Email address").fill(email);
  await cp.getByLabel("Payment method").selectOption({ label: "Check" });
  return cp;
}
const box = (cp) => ({
  input: cp.locator("#discountCodeInput"), on: cp.locator("#discountOn"), msg: cp.locator("#discountMsg"),
  chips: cp.locator("#discountOn li.discount-chip"), chipText: async () => (await cp.locator("#discountOn li.discount-chip").allTextContents()).map(t => t.replace(/\s+/g, " ").trim()), add: cp.getByRole("button", { name: "Add another code" }),
  line: cp.locator(".ticket-discount-line").filter({ hasText: /^Discount/ }), free: cp.locator(".ticket-freeship-line"),
  total: cp.locator(".ticket-total .t-amount"),
});
// Types the code and presses Apply; returns the server's answer and what the page sent.
async function apply(cp, code) {
  await box(cp).input.fill(code);
  const ans = answerOf(cp, "checkDiscountCode");
  await cp.getByRole("button", { name: "Apply", exact: true }).click();
  const r = await ans;
  return { status: r.status(), body: await r.json(), sent: JSON.parse(r.request().postData()) };
}
async function placeIt(cp) {
  const saved = cp.waitForResponse(r => r.url().endsWith("/api/orders") && r.request().method() === "POST" && !actionOf(r.request()));
  await cp.getByRole("button", { name: "Place order" }).click();
  const res = await saved;
  const body = await res.json();
  const sent = JSON.parse(res.request().postData());
  await expect(cp.getByRole("heading", { level: 2, name: /^Order received/ })).toBeVisible();
  const m = /^\s*(\S+)\s*·\s*\$([\d,.]+)/.exec(await cp.locator(".confirmation .order-number").textContent());
  return { orderId: m[1], total: m[2], body, sent };
}
// A storefront request, as the shop's own page sends it.
const shopPost = async (request, shop, data) => {
  const res = await request.post(shopUrl(shop.subdomain) + "/api/orders", { headers: { Origin: shopUrl(shop.subdomain) }, data });
  return { status: res.status(), data: await res.json() };
};
const lineOf = (shop, qty = 1) => [{ productId: shop.products[0].productId, name: shop.products[0].name, size: "OSFA", qty }];
const orderIn = async (api, shop, orderId) => (await api("getOrders", { org: shop.orgId })).orders.find(o => o.orderId === orderId);
const orderRow = (page, orderId) => page.locator(`tr[data-order="${orderId}"]`).first();

// The order's 💰 Payments window on its shop's Orders page.
async function paymentsWindow(page, shop, orderId) {
  await openAdmin(page, "orders/" + shop.orgId);
  await expect(page.getByRole("combobox", { name: "Shop" })).toHaveValue(shop.orgId);
  await orderRow(page, orderId).locator("td[data-action-td]").getByRole("button", { name: "💰 Payments" }).click();
  const pm = page.locator("#pmContent");
  await expect(pm).toBeVisible();
  return pm;
}

// =========================================================================================================
test("More than one code, through Global settings: 10% and 15% add up to 25%, an amount code comes off what is left, a free-shipping code takes the delivery fee off, and the order carries them all", async ({ page, api, as }) => {
  test.setTimeout(180_000);
  const shop = await makeShop(api, { prefix: "mcflow", products: PRODUCTS });
  const p10 = codeOf("A10"), p15 = codeOf("B15"), a5 = codeOf("C5"), fs = codeOf("FS"), mn = codeOf("MIN");
  await apiCode(api, shop, { code: p10, percent: 10 });
  await apiCode(api, shop, { code: p15, percent: 15 });
  await apiCode(api, shop, { code: a5, kind: "amount", amount: 5, percent: null });

  await keepingRule(api, async (before) => {
    if (before.multiple) await setMultiple(api, false);

    // ---- the codes page: a "Free shipping only" code and an amount code with a minimum order ---------------------
    await openAdmin(page, "discounts");
    await expect(page.locator("#dcPage")).toBeVisible();
    await page.getByRole("button", { name: "+ New code" }).click();
    let dlg = page.getByRole("dialog", { name: "New discount code" });
    await dlg.locator("#dcCode").fill(fs);
    await expect(dlg.locator("#dcValueWrap")).toBeVisible();
    await expect(dlg.locator("#dcShipWrap")).toBeVisible();
    await dlg.locator("#dcKind").selectOption("shipping");
    // Free shipping only: no percent or amount, and no "Also free shipping" tick.
    await expect(dlg.locator("#dcValueWrap")).toBeHidden();
    await expect(dlg.locator("#dcShipWrap")).toBeHidden();
    await expect(dlg.locator("#dcMaxWrap")).toBeHidden();
    await dlg.locator("#dcOrg").selectOption(shop.orgId);
    await dlg.locator("#dcMax").fill("50");
    let saved = answerOf(page, "saveDiscountCode");
    await dlg.getByRole("button", { name: "Create code" }).click();
    expect(JSON.parse((await saved).request().postData()).code).toMatchObject({ code: fs, kind: "shipping", percent: null, amount: null, freeShipping: true, minOrder: null, orgId: shop.orgId });
    await expect(toast(page)).toContainText("Code " + fs + " created.");
    await expect(dlg).toHaveCount(0);

    await page.getByRole("button", { name: "+ New code" }).click();
    dlg = page.getByRole("dialog", { name: "New discount code" });
    await dlg.locator("#dcCode").fill(mn);
    await dlg.locator("#dcKind").selectOption("amount");
    await dlg.locator("#dcValue").fill("8");
    await dlg.locator("#dcOrg").selectOption(shop.orgId);
    await dlg.locator("#dcMax").fill("50");
    // The page's own check of the minimum.
    await dlg.locator("#dcMinOrder").fill("200000");
    await dlg.getByRole("button", { name: "Create code" }).click();
    await expect(dlg.locator("#dcErr")).toHaveText("Enter a minimum order from $0.01 to $100,000, or leave it blank.");
    await dlg.locator("#dcMinOrder").fill("50");
    saved = answerOf(page, "saveDiscountCode");
    await dlg.getByRole("button", { name: "Create code" }).click();
    expect(JSON.parse((await saved).request().postData()).code).toMatchObject({ code: mn, kind: "amount", amount: 8, minOrder: 50, freeShipping: false });
    await expect(toast(page)).toContainText("Code " + mn + " created.");
    const listed = answerOf(page, "listDiscountCodes");
    await page.locator("#dcQ").fill(TAG);
    await listed;
    await waitIdle(page);
    const row = (c) => page.locator("#dcBody tbody tr", { has: page.locator("a.dc-code", { hasText: new RegExp("^" + c + "$") }) });
    expect((await cellsOf(row(fs)))[1]).toBe("Free shipping");
    expect((await cellsOf(row(mn)))[1]).toBe("$8.00 off, on orders of $50.00 or more");

    // ---- one code at a time (as the install starts): the catalog says so ------------------------------------------
    const catalog = async (p) => (await p.evaluate(async () => (await (await fetch("/api/catalog", { cache: "no-store" })).json()))).catalog;
    let cp = await checkout(as, shop, { qty: 5, delivery: "Local delivery" });
    expect((await catalog(cp)).discountRules).toEqual({ multiple: false });

    // ---- Global settings: more than one, through the page; no Publish needed -----------------------------------
    await ruleThroughPage(page, api, true);
    cp = await checkout(as, shop, { qty: 5, delivery: "Local delivery" });
    expect((await catalog(cp)).discountRules).toEqual({ multiple: true });
    const b = box(cp);
    await expect(cp.locator("label[for=discountCodeInput]")).toHaveText("Discount code");
    await expect(b.total).toHaveText("$105.00");   // 5 × $20 and the $5 delivery

    // 10%: $10 off the $100.
    let r = await apply(cp, p10.toLowerCase());
    expect(r.sent.others).toEqual([]);
    expect(r.body).toEqual({ status: "ok", code: p10, label: "10% off", discount: 10, freeShipping: false,
      combined: { discount: 10, freeShipping: false, codes: [{ code: p10, discount: 10, freeShipping: false }] } });
    await expect.poll(b.chipText).toEqual([p10 + " — 10% off ×"]);
    await expect(b.input).toHaveCount(0);
    await expect(cp.locator("#discountListLabel")).toHaveText("Discount codes");
    await expect(b.line).toHaveText(`Discount (${p10})−$10.00`);
    await expect(b.total).toHaveText("$95.00");
    // The same code again is refused on the page itself.
    await b.add.click();
    await expect(cp.locator("label[for=discountCodeInput]")).toHaveText("Another discount code");
    await expect(b.input).toBeFocused();
    await b.input.fill(p10);
    await cp.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(b.msg).toHaveText("That code is already applied.");
    // …and by the server.
    expect(await shopPost(cp.request, shop, { action: "checkDiscountCode", orgId: shop.orgId, code: p10, others: [p10], items: lineOf(shop, 5) }))
      .toEqual({ status: 400, data: { status: "error", message: "That code is already applied." } });

    // 15% with it: they add up to 25%, $25 off.
    r = await apply(cp, p15);
    expect(r.sent.others).toEqual([p10]);
    expect(r.body).toEqual({ status: "ok", code: p15, label: "15% off", discount: 15, freeShipping: false,
      combined: { discount: 25, freeShipping: false, codes: [{ code: p10, discount: 10, freeShipping: false }, { code: p15, discount: 15, freeShipping: false }] } });
    await expect.poll(b.chipText).toEqual([p10 + " — 10% off ×", p15 + " — 15% off ×"]);
    await expect(b.line).toHaveText(`Discount (${p10}, ${p15})−$25.00`);
    await expect(b.total).toHaveText("$80.00");

    // $5 off what is left.
    await b.add.click();
    r = await apply(cp, a5);
    expect(r.sent.others).toEqual([p10, p15]);
    expect(r.body.combined).toEqual({ discount: 30, freeShipping: false, codes: [
      { code: p10, discount: 10, freeShipping: false }, { code: p15, discount: 15, freeShipping: false }, { code: a5, discount: 5, freeShipping: false }] });
    await expect(b.line).toHaveText(`Discount (${p10}, ${p15}, ${a5})−$30.00`);
    await expect(b.total).toHaveText("$75.00");

    // × on the 10%: the rest are asked about again at once, and come to $20.
    const again = cp.waitForResponse(r2 => r2.url().endsWith("/api/orders") && actionOf(r2.request()) === "checkDiscountCode" && JSON.parse(r2.request().postData()).code === a5);
    await cp.getByRole("button", { name: "Remove code " + p10 }).click();
    expect(JSON.parse((await again).request().postData()).others).toEqual([p15]);
    await expect.poll(b.chipText).toEqual([p15 + " — 15% off ×", a5 + " — $5.00 off ×"]);
    await expect(b.line).toHaveText(`Discount (${p15}, ${a5})−$20.00`);
    await expect(b.total).toHaveText("$85.00");
    // Back on.
    await b.add.click();
    expect((await apply(cp, p10)).body.combined.discount).toBe(30);
    await expect(b.total).toHaveText("$75.00");

    // The free-shipping code: nothing off the goods, the $5 delivery off.
    await b.add.click();
    r = await apply(cp, fs);
    expect(r.body).toMatchObject({ status: "ok", code: fs, label: "Free shipping", discount: 0, freeShipping: true });
    expect(r.body.combined).toMatchObject({ discount: 30, freeShipping: true });
    await expect(b.chips).toHaveCount(4);
    expect((await b.chipText())[3]).toBe(fs + " — Free shipping ×");
    await expect(b.line).toHaveText(`Discount (${p15}, ${a5}, ${p10})−$30.00`);
    await expect(b.free).toHaveText(`Free shipping (${fs})$0.00`);
    await expect(b.total).toHaveText("$70.00");

    // ---- the order -------------------------------------------------------------------------------------------
    const order = await placeIt(cp);
    expect(order.sent.discountCodes).toEqual([p15, a5, p10, fs]);
    expect(order.sent.discountCode).toBeUndefined();
    expect(order.sent.discount).toBe(30);
    expect(order.body).toMatchObject({ status: "ok", discount: 30, discountCodes: [p15, a5, p10, fs], discountCode: [p15, a5, p10, fs].join(", "),
      shippingDiscount: 5, total: 70, owed: 70 });
    expect(order.total).toBe("70.00");
    await expect(cp.locator(".conf-items")).toContainText(`Discount (${p15}, ${a5}, ${p10}, ${fs})−$30.00`);
    await expect(cp.locator(".conf-items")).toContainText(`Free shipping (${fs})Free`);
    await expect(cp.locator(".conf-items .row.total")).toHaveText("Total$70.00");

    const o = await orderIn(api, shop, order.orderId);
    expect(o).toMatchObject({ discountAmount: 30, discountNote: `Codes ${p15}, ${a5}, ${p10}, ${fs}`, discountCodes: [p15, a5, p10, fs],
      shippingCost: 5, shippingDiscount: 5, shippingCharged: 0, effectiveTotal: 70, balanceDue: 70 });
    // The Orders page and its Payments window.
    const pm = await paymentsWindow(page, shop, order.orderId);
    await expect(orderRow(page, order.orderId).locator("td[data-discount-td]")).toHaveText(`−$30.00Codes ${p15}, ${a5}, ${p10}, ${fs}`);
    await expect(pm).toContainText(`Free shipping (${p15}, ${a5}, ${p10}, ${fs})−$5.00`);
    await expect(pm).toContainText(/Amount due\s*\$70\.00/);
    await expect(pm.locator(".pm-code-chip")).toHaveCount(4);
    await page.locator("#pmCloseBottom").click();
    // Each code's use, with its share.
    const uses = async (code) => { const c = (await api("listDiscountCodes", { q: code })).codes.find(x => x.code === code); return (await api("getDiscountCode", { id: c.id })).code; };
    const u10 = await uses(p10);
    expect(u10.uses.map(u => [u.orderId, u.amount])).toEqual([[order.orderId, 10]]);
    expect((await uses(fs)).uses.map(u => [u.orderId, u.amount])).toEqual([[order.orderId, 5]]);

    // ---- a minimum order ----------------------------------------------------------------------------------------
    cp = await checkout(as, shop, { qty: 2 });
    r = await apply(cp, mn);
    expect(r).toMatchObject({ status: 400, body: { status: "error", message: "This code needs an order of at least $50.00." } });
    await expect(box(cp).msg).toHaveText("This code needs an order of at least $50.00.");
    await expect(box(cp).total).toHaveText("$40.00");
    // Three tees ($60): it works.
    await cp.getByRole("button", { name: "One more Sample Tee" }).click();
    await expect(box(cp).total).toHaveText("$60.00");
    r = await apply(cp, mn);
    expect(r.body).toMatchObject({ status: "ok", code: mn, label: "$8.00 off, on orders of $50.00 or more", discount: 8 });
    await expect(box(cp).total).toHaveText("$52.00");
    // Back to two: asked again, it no longer applies, and says why.
    const asked = cp.waitForResponse(r2 => r2.url().endsWith("/api/orders") && actionOf(r2.request()) === "checkDiscountCode");
    await cp.getByRole("button", { name: "One fewer Sample Tee" }).click();
    expect(JSON.parse((await asked).request().postData())).toMatchObject({ code: mn, others: [] });
    await expect(box(cp).msg).toHaveText(`${mn} no longer applies: This code needs an order of at least $50.00.`);
    await expect(box(cp).chips).toHaveCount(0);
    await expect(box(cp).total).toHaveText("$40.00");
  });
});

// =========================================================================================================
test("Back to one code through Global settings: the checkout box takes one code, and the server refuses a second on a check and on an order", async ({ page, api, as }) => {
  test.setTimeout(120_000);
  const shop = await makeShop(api, { prefix: "mcone", products: PRODUCTS });
  const p10 = codeOf("D10"), p15 = codeOf("E15");
  await apiCode(api, shop, { code: p10, percent: 10 });
  await apiCode(api, shop, { code: p15, percent: 15 });
  await keepingRule(api, async (before) => {
    if (!before.multiple) await setMultiple(api, true);
    await ruleThroughPage(page, api, false);

    const cp = await checkout(as, shop, { qty: 2 });
    const b = box(cp);
    const r = await apply(cp, p10);
    expect(r.body.combined.discount).toBe(4);
    // One code: the box shows it, read-only, with Remove — no "Add another code".
    await expect(b.input).toHaveValue(p10);
    await expect(b.input).toHaveAttribute("readonly", "");
    await expect(b.on).toHaveText(p10 + " — 10% off");
    await expect(b.add).toHaveCount(0);
    await expect(cp.getByRole("button", { name: "Remove", exact: true })).toBeVisible();
    await expect(b.total).toHaveText("$36.00");

    // The server: a second code is refused on a check…
    expect(await shopPost(cp.request, shop, { action: "checkDiscountCode", orgId: shop.orgId, code: p15, others: [p10], items: lineOf(shop, 2) }))
      .toEqual({ status: 400, data: { status: "error", message: ONE_CODE } });
    // …and on an order (nothing is placed, no use is taken).
    const orderId = "MC-" + slug("o").toUpperCase().slice(0, 20);
    const placed = await shopPost(cp.request, shop, { orderId, orgId: shop.orgId, customerName: "Pat Example", contact: "pat@example.com", paymentMethod: "Check",
      items: lineOf(shop, 2), discountCodes: [p10, p15] });
    expect(placed).toEqual({ status: 400, data: { status: "error", message: ONE_CODE } });
    expect(await orderIn(api, shop, orderId)).toBeUndefined();
    const c15 = (await api("listDiscountCodes", { q: p15 })).codes.find(x => x.code === p15);
    expect(c15.used).toBe(0);

    // The one code still makes an order.
    const order = await placeIt(cp);
    expect(order.sent).toMatchObject({ discountCode: p10, discount: 4 });
    expect(order.sent.discountCodes).toBeUndefined();
    expect(order.body).toMatchObject({ discount: 4, discountCodes: [p10], total: 36 });
  });
});

// =========================================================================================================
test("The order page: Add code changes the totals, a second code is refused while one is allowed, a manual discount and a code don't mix, × takes it off; Production is refused", async ({ page, api, as }, testInfo) => {
  test.setTimeout(150_000);
  const shop = await makeShop(api, { prefix: "mcord", products: PRODUCTS });
  const p10 = codeOf("F10"), p15 = codeOf("G15");
  await apiCode(api, shop, { code: p10, percent: 10 });
  await apiCode(api, shop, { code: p15, percent: 15 });
  const customer = await as(null);
  const placed = await placeOrder(customer, shop, { items: [{ name: "Sample Tee", qty: 2 }], email: "pat@example.com", customer: "Pat Example" });
  expect(placed.total).toBe("40.00");
  const orderId = placed.orderId;

  await keepingRule(api, async (before) => {
    if (before.multiple) await setMultiple(api, false);
    let pm = await paymentsWindow(page, shop, orderId);
    await expect(pm.locator(".pm-codes")).toContainText("Discount codes");
    await expect(pm.locator("label[for=pmCodeInput]")).toHaveText("Add code");
    await expect(pm.locator(".pm-code-chip")).toHaveCount(0);
    await expect(pm).toContainText(/Amount due\s*\$40\.00/);
    // Nothing typed: the page says so.
    await page.locator("#pmCodeApply").click();
    await expect(page.locator("#pmError")).toHaveText("Enter a code first.");
    // A wrong code: the server's sentence.
    await page.locator("#pmCodeInput").fill(codeOf("NOPE"));
    let ans = answerOf(page, "applyOrderDiscountCode");
    await page.locator("#pmCodeApply").click();
    expect((await ans).status()).toBe(400);
    await expect(page.locator("#pmError")).toHaveText(GENERIC);

    // The 10% code, typed in lower case and taken with Enter.
    await page.locator("#pmCodeInput").fill(p10.toLowerCase());
    ans = answerOf(page, "applyOrderDiscountCode");
    await page.locator("#pmCodeInput").press("Enter");
    let res = await ans;
    expect(JSON.parse(res.request().postData())).toMatchObject({ orderId, code: p10 });
    expect(await res.json()).toMatchObject({ status: "ok", discountAmount: 4, discountNote: "Code " + p10, discountCodes: [p10], effectiveTotal: 36, balanceDue: 36 });
    await expect(toast(page)).toContainText("Code " + p10 + " added.");
    pm = page.locator("#pmContent");
    await expect(pm).toContainText(`Discount (Code ${p10})−$4.00`);
    await expect(pm).toContainText(/Amount due\s*\$36\.00/);
    await expect(pm.locator(".pm-code-chip")).toHaveText([p10 + "×"]);
    await expect(pm.locator("label[for=pmCodeInput]")).toHaveText("Add another code");
    await expect(pm.locator(".pm-code-note")).toHaveText("This order has a discount code; take the code off before setting a discount by hand.");
    await expect(orderRow(page, orderId).locator("td[data-discount-td]")).toHaveText(`−$4.00Code ${p10}`);

    // One code at a time: the second is refused.
    await page.locator("#pmCodeInput").fill(p15);
    ans = answerOf(page, "applyOrderDiscountCode");
    await page.locator("#pmCodeApply").click();
    expect((await ans).status()).toBe(400);
    await expect(page.locator("#pmError")).toHaveText(ONE_CODE);
    // The same code again.
    expect(await api("applyOrderDiscountCode", { orderId, code: p10 }, { allowError: true, withStatus: true }))
      .toMatchObject({ status: 400, data: { message: "That code is already applied." } });
    // A discount by hand while a code is on: the fields are shut, and the server refuses it.
    for (const sel of ["#pmDiscountAmount", "#pmDiscountNote", "#pmSaveDiscount"]) await expect(page.locator(sel)).toBeDisabled();
    expect(await api("setDiscount", { orderId, amount: 3, note: "By hand" }, { allowError: true, withStatus: true }))
      .toMatchObject({ status: 409, data: { message: "This order has a discount code; take the code off first." } });

    // More than one allowed: the 15% goes on too, 25% in all.
    await setMultiple(api, true);
    res = await (async () => { const a = answerOf(page, "applyOrderDiscountCode"); await page.locator("#pmCodeInput").fill(p15); await page.locator("#pmCodeApply").click(); return a; })();
    expect(await res.json()).toMatchObject({ discountAmount: 10, discountNote: `Codes ${p10}, ${p15}`, discountCodes: [p10, p15], balanceDue: 30 });
    await expect(page.locator("#pmContent")).toContainText(`Discount (Codes ${p10}, ${p15})−$10.00`);
    await expect(page.locator("#pmContent")).toContainText(/Amount due\s*\$30\.00/);

    // × asks first; Take it off brings the total back up.
    await page.locator("#pmContent").getByRole("button", { name: "Take code " + p10 + " off" }).click();
    await expect(page.getByRole("dialog").last()).toContainText(`Take code ${p10} off ${orderId}?`);
    ans = answerOf(page, "removeOrderDiscountCode");
    await confirmDialog(page, "Take it off");
    expect(await (await ans).json()).toMatchObject({ discountAmount: 6, discountCodes: [p15], balanceDue: 34 });
    await expect(toast(page)).toContainText("Code " + p10 + " taken off.");
    await expect(page.locator("#pmContent")).toContainText(`Discount (Code ${p15})−$6.00`);
    await page.locator("#pmContent").getByRole("button", { name: "Take code " + p15 + " off" }).click();
    ans = answerOf(page, "removeOrderDiscountCode");
    await confirmDialog(page, "Take it off");
    expect(await (await ans).json()).toMatchObject({ discountAmount: 0, discountCodes: [], balanceDue: 40 });
    await expect(page.locator("#pmContent")).toContainText(/Amount due\s*\$40\.00/);
    await expect(page.locator("#pmContent")).not.toContainText("Discount (");
    await expect(page.locator(".pm-code-note")).toHaveCount(0);
    // A code that isn't on the order can't be taken off.
    expect(await api("removeOrderDiscountCode", { orderId, code: p10 }, { allowError: true, withStatus: true }))
      .toMatchObject({ status: 404, data: { message: "That code isn't on this order." } });
    // Both codes' uses are given back.
    for (const c of [p10, p15]) expect((await api("listDiscountCodes", { q: c })).codes.find(x => x.code === c).used).toBe(0);

    // A discount by hand now: then a code is refused.
    await api("setDiscount", { orderId, amount: 3, note: "Example member" });
    expect(await api("applyOrderDiscountCode", { orderId, code: p10 }, { allowError: true, withStatus: true }))
      .toMatchObject({ status: 400, data: { message: "This order has a discount; take it off first." } });
    await api("setDiscount", { orderId, amount: 0, note: "" });

    // Production can't put a code on (the server says no), and the order is unchanged.
    const prod = await apiContext("production", testInfo.workerIndex);
    try {
      const refused = await callApi(prod, "applyOrderDiscountCode", { orderId, code: p10 }, { allowError: true, withStatus: true });
      expect(refused).toMatchObject({ status: 403, data: { status: "error", message: "Your role can't do this. Ask an admin." } });
    } finally { await prod.dispose(); }
    expect(await orderIn(api, shop, orderId)).toMatchObject({ discountAmount: 0, balanceDue: 40 });
  });
});

// =========================================================================================================
test("A quote with a code: added in the quote editor, sent, seen by the customer with the discount, accepted, and the order carries the code; a code switched off since stops the send", async ({ page, api, as }) => {
  test.setTimeout(150_000);
  const shop = await makeShop(api, { prefix: "mcquo", products: PRODUCTS });
  const p10 = codeOf("H10"), p15 = codeOf("J15");
  await apiCode(api, shop, { code: p10, percent: 10 });
  await apiCode(api, shop, { code: p15, percent: 15 });
  const email = slug("quote") + "@example.com";
  const cust = await api("saveCustomer", { name: uniq("Pat Example"), company: "", email, phone: "555-0142", address: null, notes: "",
    taxExempt: false, taxExemptCertificate: "", taxExemptExpires: "" });
  const made = await api("createEstimate", { org: shop.orgId, customerId: cust.id, title: "Team shirts " + TAG, expiresOn: FAR });
  await api("saveEstimate", { id: made.id, items: [{ kind: "product", productId: shop.products[0].productId, size: "OSFA", qty: 3 }] });

  await keepingRule(api, async (before) => {
    if (before.multiple) await setMultiple(api, false);
    await openAdmin(page, "quotes/" + made.id);
    await expect(page.locator("#qtPage h2.cust-name")).toBeVisible();
    const codes = page.locator("#qtCodes");
    await expect(codes.locator("h3")).toHaveText("Discount codes");
    await expect(codes).toContainText("No discount code on this quote.");
    await expect(codes.locator("label[for=qtCode]")).toHaveText("Discount code");
    await expect(page.locator("#qtTotals tr.qt-sum-total td")).toHaveText("$60.00");
    // Nothing typed, then a wrong code.
    await page.locator("#qtCodeAdd").click();
    await expect(page.locator("#qtCodeMsg")).toHaveText("Enter a code first.");
    await page.locator("#qtCode").fill(codeOf("NOPE"));
    let chk = answerOf(page, "checkLocalSaleCode");
    await page.locator("#qtCodeAdd").click();
    await chk;
    await expect(page.locator("#qtCodeMsg")).toHaveText(GENERIC);
    // The 10% code: checked against the quote's $60 of goods and its customer, then saved with the quote.
    await page.locator("#qtCode").fill(p10.toLowerCase());
    chk = answerOf(page, "checkLocalSaleCode");
    const saved = answerOf(page, "saveEstimate");
    await page.locator("#qtCode").press("Enter");
    expect(JSON.parse((await chk).request().postData())).toMatchObject({ org: shop.orgId, code: p10, subtotal: 60, others: [], contact: email });
    const sv = await saved;
    expect(JSON.parse(sv.request().postData()).discountCodes).toEqual([p10]);
    expect((await sv.json()).estimate.discountCodes).toEqual([p10]);
    await expect(toast(page)).toContainText("Code " + p10 + " added.");
    await expect(codes.locator(".cust-tag")).toHaveText([p10]);
    await expect(page.locator("#qtTotals tr.qt-sum-disc")).toHaveText(`Discount (${p10})−$6.00`);
    await expect(page.locator("#qtTotals tr.qt-sum-total td")).toHaveText("$54.00");
    // One code at a time: no field for a second, and the reason.
    await expect(page.locator("#qtCode")).toHaveCount(0);
    await expect(codes).toContainText("Only one discount code can be used at a time (Global settings → Discount codes). Take this one off to use another.");
    // Two codes at once are refused by the server while one is allowed.
    expect(await api("saveEstimate", { id: made.id, discountCodes: [p10, p15] }, { allowError: true, withStatus: true }))
      .toMatchObject({ status: 400, data: { message: ONE_CODE } });

    // ---- sent, through the page; the customer sees the discount and accepts --------------------------------------
    await page.locator("#qtSend").click();
    const dlg = page.getByRole("dialog", { name: "Send " + made.number });
    const sent = answerOf(page, "sendEstimate");
    await dlg.locator("#qtSendGo").click();
    const sentBody = await (await sent).json();
    expect(sentBody.status).toBe("ok");
    await dlg.locator("#qtSendGo").click();
    const token = /\?estimate=([0-9a-f]{32})$/.exec(sentBody.link)[1];

    const cp = await as(null);
    await cp.goto(shopUrl(shop.subdomain) + "/?estimate=" + token);
    await expect(cp.getByRole("heading", { level: 1, name: shop.name })).toBeVisible();
    await expect(cp.locator(".inv-totals")).toContainText(`Discount (${p10})−$6.00`);
    await expect(cp.locator(".inv-totals tr.inv-total")).toContainText("$54.00");
    const view = await cp.evaluate(async (t) => (await (await fetch("/api/estimate?token=" + t)).json()), token);
    expect(view.estimate || view).toMatchObject({ discountCodes: [p10], discount: 6 });
    await cp.locator("#estAccept").click();
    await expect(cp.locator("#estConfirmText")).toContainText("$54.00");
    const accepted = cp.waitForResponse(r => r.url().endsWith("/api/estimate") && r.request().method() === "POST");
    await cp.locator("#estAcceptYes").click();
    const acc = await (await accepted).json();
    expect(acc).toMatchObject({ status: "ok", action: "accept" });
    const o = await orderIn(api, shop, acc.orderId);
    expect(o).toMatchObject({ discountAmount: 6, discountNote: "Code " + p10, discountCodes: [p10], effectiveTotal: 54 });
    const use = await api("getDiscountCode", { id: (await api("listDiscountCodes", { q: p10 })).codes.find(x => x.code === p10).id });
    expect(use.code.uses.map(u => [u.orderId, u.amount])).toEqual([[acc.orderId, 6]]);

    // ---- a second quote, with more than one code allowed: two codes, each with its share; × takes one off ---------
    await setMultiple(api, true);
    const q2 = await api("createEstimate", { org: shop.orgId, customerId: cust.id, title: "Caps " + TAG, expiresOn: FAR });
    await api("saveEstimate", { id: q2.id, items: [{ kind: "product", productId: shop.products[0].productId, size: "OSFA", qty: 2 }] });
    await openAdmin(page, "quotes/" + q2.id);
    await expect(page.locator("#qtPage h2.cust-name")).toBeVisible();
    for (const c of [p10, p15]) {
      await page.locator("#qtCode").fill(c);
      const s2 = answerOf(page, "saveEstimate");
      await page.locator("#qtCodeAdd").click();
      expect((await (await s2).json()).status).toBe("ok");
      await expect(toast(page)).toContainText("Code " + c + " added.");
    }
    await expect(codes.locator(".cust-tag")).toHaveText([p10, p15]);
    await expect(codes.locator("label[for=qtCode]")).toHaveText("Add another code");
    // The same code twice: the page says so without asking.
    await page.locator("#qtCode").fill(p15.toLowerCase());
    await page.locator("#qtCodeAdd").click();
    await expect(page.locator("#qtCodeMsg")).toHaveText("That code is already on this quote.");
    // 10% and 15% of the $40: $10 in all (the editor's totals show a line per code, as the email and customer page do).
    await expect(page.locator("#qtTotals tr.qt-sum-disc")).toHaveText([`Discount (${p10})−$4.00`, `Discount (${p15})−$6.00`]);
    const q2Totals = (await api("getEstimate", { id: q2.id })).totals;
    expect(q2Totals).toMatchObject({ discount: 10, total: 30 });
    expect(q2Totals.discountCodes.map(x => [x.code, x.discount])).toEqual([[p10, 4], [p15, 6]]);
    await expect(page.locator("#qtTotals tr.qt-sum-total td")).toHaveText("$30.00");
    const off = answerOf(page, "saveEstimate");
    await codes.getByRole("button", { name: "Take off code " + p10 }).click();
    expect(JSON.parse((await off).request().postData()).discountCodes).toEqual([p15]);
    await expect(codes.locator(".cust-tag")).toHaveText([p15]);
    await expect(page.locator("#qtTotals tr.qt-sum-disc")).toHaveText([`Discount (${p15})−$6.00`]);
    await expect(page.locator("#qtTotals tr.qt-sum-total td")).toHaveText("$34.00");

    // ---- its code is switched off after it was put on, so the send is refused ------------------------------------
    const c15 = (await api("listDiscountCodes", { q: p15 })).codes.find(x => x.code === p15);
    await api("setDiscountCodeActive", { id: c15.id, active: false });
    expect(await api("sendEstimate", { id: q2.id, email }, { allowError: true, withStatus: true }))
      .toMatchObject({ status: 409, data: { message: "This code isn't valid." } });
    expect((await api("getEstimate", { id: q2.id })).estimate.status).toBe("draft");
  });
});

// =========================================================================================================
test("The invoice page takes a code: a wrong one is refused, the right one lowers what is owed, and a second one when more than one is allowed", async ({ page, api, as }) => {
  test.setTimeout(150_000);
  const shop = await makeShop(api, { prefix: "mcinv", products: PRODUCTS });
  const p10 = codeOf("K10"), p15 = codeOf("L15");
  await apiCode(api, shop, { code: p10, percent: 10 });
  await apiCode(api, shop, { code: p15, percent: 15 });
  const customer = await as(null);
  const placed = await placeOrder(customer, shop, { items: [{ name: "Sample Tee", qty: 2 }], email: "pat@example.com", customer: "Pat Example" });
  const orderId = placed.orderId;
  const sent = await api("sendInvoice", { orderId, org: shop.orgId, allowDelivery: false });
  const token = new URL(sent.url).searchParams.get("invoice");

  await keepingRule(api, async (before) => {
    if (before.multiple) await setMultiple(api, false);
    await customer.goto(shopUrl(shop.subdomain) + "/?invoice=" + token);
    const inv = customer.locator(".inv");
    await expect(inv).toContainText("Invoice for order " + orderId);
    await expect(inv.locator("label[for=invCode]")).toHaveText("Have a discount code?");
    await expect(inv.locator("tr.inv-due")).toHaveText("Balance due$40.00");
    // Nothing typed.
    await inv.locator("#invCodeBtn").click();
    await expect(inv.locator("#invCodeMsg")).toHaveText("Enter a discount code.");
    // A wrong code: the server's sentence, nothing changes.
    const post = () => customer.waitForResponse(r => r.url().endsWith("/api/invoice") && r.request().method() === "POST");
    await inv.locator("#invCode").fill(codeOf("NOPE"));
    let ans = post();
    await inv.locator("#invCodeBtn").click();
    expect((await ans).status()).toBe(400);
    await expect(inv.locator("#invCodeMsg")).toHaveText(GENERIC);
    await expect(inv.locator("tr.inv-due")).toHaveText("Balance due$40.00");
    // The right one (with Enter): $4 off, what is owed drops, and the box goes (one code per order).
    await inv.locator("#invCode").fill(p10.toLowerCase());
    ans = post();
    await inv.locator("#invCode").press("Enter");
    const res = await ans;
    expect(JSON.parse(res.request().postData())).toEqual({ token, action: "applyCode", code: p10.toLowerCase() });
    const body = await res.json();
    expect(body.invoice).toMatchObject({ discount: 4, discountCodes: [p10], total: 36, balanceDue: 36, addOns: { code: false, multiple: false } });
    await expect(inv.locator(".inv-totals")).toContainText(`Discount (Code ${p10})−$4.00`);
    await expect(inv.locator("tr.inv-total")).toHaveText("Total$36.00");
    await expect(inv.locator("tr.inv-due")).toHaveText("Balance due$36.00");
    await expect(inv.locator("#invCode")).toHaveCount(0);
    // The server refuses another one now.
    const more = await customer.evaluate(async (b) => { const r = await fetch("/api/invoice", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); return { status: r.status, data: await r.json() }; },
      { token, action: "applyCode", code: p15 });
    expect(more).toEqual({ status: 409, data: { status: "error", message: "A discount code can't be added to this order now." } });

    // More than one allowed: the box is back, for another code.
    await setMultiple(api, true);
    await customer.reload();
    await expect(inv.locator("label[for=invCode]")).toHaveText("Another discount code");
    await inv.locator("#invCode").fill(p15);
    ans = post();
    await inv.locator("#invCodeBtn").click();
    expect((await (await ans).json()).invoice).toMatchObject({ discount: 10, discountCodes: [p10, p15], balanceDue: 30, addOns: { code: true, multiple: true } });
    await expect(inv.locator(".inv-totals")).toContainText(`Discount (Codes ${p10}, ${p15})−$10.00`);
    await expect(inv.locator("tr.inv-due")).toHaveText("Balance due$30.00");

    // The order says so.
    expect(await orderIn(api, shop, orderId)).toMatchObject({ discountAmount: 10, discountCodes: [p10, p15], balanceDue: 30 });
  });
});
