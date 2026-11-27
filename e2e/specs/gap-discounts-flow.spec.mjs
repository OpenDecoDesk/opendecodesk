// Discount codes (migrations/0115) end to end, in a real browser: the owner on the Discount codes page, a customer at
// a shop's checkout, and the order on the Orders page.
//   - the owner makes a percent code anyone can use and an amount code for one person (pat@example.com) through the
//     New code window; the list shows them; the checkout's "Discount code" box appears only once the shop has a code
//     that works;
//   - a customer applies the percent code: the cart shows the code, a Discount line and the lower total; the order
//     (pay later, by check) is placed with it, and the Orders page shows "Code …", the discount and the balance;
//   - the code for one person: refused for another email with the generic sentence (never the address), asks for an
//     email first, works for pat@example.com, then says it has already been used;
//   - a code with one use runs out (and the box goes when no code is left); an expired code is refused;
//   - voiding an order gives its use back: Used drops, the code's window says "Given back", and the code works again;
//   - a 100% code places an order with nothing to pay;
//   - bulk codes for three emails: the result lists each email's code, an invalid address is skipped, and Download
//     CSV saves the list;
//   - a used code's window locks the fields that can't change, and its expiry and note still save.
//
// Every test makes its own shop (codes are made for that shop only, so no other spec's checkout ever shows the box)
// and its own codes, with this run's tag in every code, so the tests are independent of each other and of the files
// running beside this one. No install-wide setting is changed.
import { test, expect, ADMIN, openAdmin, toast, uniq, shopUrl, waitIdle, user } from "../fixtures.mjs";
import { makeShop } from "../lib/data.mjs";
import fs from "node:fs";

const TAG = uniq("dc").split(" ")[1].toUpperCase().replace(/[^A-Z0-9]/g, "");
// A code of this run: letters/digits only, at most 32.
const codeOf = (name) => (name + TAG).slice(0, 32);
const PAT = "pat@example.com";
const PRODUCTS = [{ name: "Sample Tee", price: 20 }];
const GENERIC = "This code isn't valid. If it was sent to you, check the email address is the one it was sent to.";

// ---- helpers ---------------------------------------------------------------------------------------------
const actionOf = (req) => { try { return JSON.parse(req.postData() || "{}").action; } catch (e) { return ""; } };
const answerOf = (page, action) => page.waitForResponse(r => r.url().endsWith("/api/orders") && actionOf(r.request()) === action);
const cellsOf = async (row) => (await row.locator("td").allTextContents()).map(s => s.trim().replace(/\s+/g, " "));

// A code made through the owner's API (the tests that are about making codes do it through the page).
const apiCode = async (api, shop, input) => (await api("saveDiscountCode", { code: { kind: "percent", percent: 10, maxUses: 50, orgId: shop.orgId, ...input } })).code;
const codeById = async (api, id) => (await api("getDiscountCode", { id })).code;

// The Discount codes page, searched for this run's codes; a code's row.
const codesPage = async (page, q = TAG) => {
  await openAdmin(page, "discounts");
  await expect(page.locator("#dcPage")).toBeVisible();
  await expect(page).toHaveTitle(/Discount codes/);
  const listed = answerOf(page, "listDiscountCodes");
  await page.locator("#dcQ").fill(q);
  await listed;
  await waitIdle(page);
};
const codeRow = (page, code) => page.locator("#dcBody tbody tr", { has: page.locator("a.dc-code", { hasText: new RegExp("^" + code + "$") }) });
const openCode = async (page, code) => {
  const got = answerOf(page, "getDiscountCode");
  await codeRow(page, code).locator("a.dc-code").click();
  await got;
  const dlg = page.getByRole("dialog", { name: "Discount code " + code });
  await expect(dlg).toBeVisible();
  return dlg;
};

// The shop's page in a customer's own browser, with `qty` tees in the cart and the name and email typed.
const checkout = async (as, shop, { qty = 1, email = "", name = uniq("Casey Customer") } = {}) => {
  const cp = await as(null);
  await cp.goto(shopUrl(shop.subdomain) + "/");
  await expect(cp.getByRole("heading", { level: 1, name: shop.name })).toBeVisible();
  const card = cp.locator("main").getByRole("heading", { level: 3, name: "Sample Tee", exact: true }).locator("xpath=ancestor::*[.//button[normalize-space()='Add to cart']][1]");
  if (qty !== 1) await card.getByRole("spinbutton").fill(String(qty));
  await card.getByRole("button", { name: "Add to cart" }).click();
  await cp.getByLabel("Your name").fill(name);
  if (email) await cp.getByLabel("Email address").fill(email);
  await cp.getByLabel("Payment method").selectOption({ label: "Check" });
  return cp;
};
const box = (cp) => ({
  input: cp.locator("#discountCodeInput"), on: cp.locator("#discountOn"), msg: cp.locator("#discountMsg"),
  line: cp.locator(".ticket-discount-line"), total: cp.locator(".ticket-total .t-amount"),
});
// Types the code and presses Apply; waits for the server's answer and returns it.
const apply = async (cp, code) => {
  await box(cp).input.fill(code);
  const ans = answerOf(cp, "checkDiscountCode");
  await cp.getByRole("button", { name: "Apply" }).click();
  const r = await ans;
  return { status: r.status(), body: await r.json(), sent: JSON.parse(r.request().postData()) };
};
// Place order; returns the order's answer and what the confirmation says ({ orderId, total }).
const placeIt = async (cp) => {
  const saved = cp.waitForResponse(r => r.url().endsWith("/api/orders") && r.request().method() === "POST" && !actionOf(r.request()));
  await cp.getByRole("button", { name: "Place order" }).click();
  const res = await saved;
  const body = await res.json();
  const sent = JSON.parse(res.request().postData());
  await expect(cp.getByRole("heading", { level: 2, name: /^Order received/ })).toBeVisible();
  const m = /^\s*(\S+)\s*·\s*\$([\d,.]+)/.exec(await cp.locator(".confirmation .order-number").textContent());
  return { orderId: m[1], total: m[2], body, sent };
};

// The shop's Orders page and one order's cells.
const ordersPage = async (page, shop) => {
  await openAdmin(page, "orders/" + shop.orgId);
  await expect(page.getByRole("combobox", { name: "Shop" })).toHaveValue(shop.orgId);
};
const orderRow = (page, orderId) => page.locator(`tr[data-order="${orderId}"]`).first();

// =========================================================================================================
test("the owner makes a percent code and a code for one person on the page; the checkout box appears; a customer's order with the percent code shows it on the Orders page", async ({ page, api, as }) => {
  test.setTimeout(120_000);
  const shop = await makeShop(api, { prefix: "dcflow", products: PRODUCTS });
  // Both start with F and this run's tag, so the list can be searched for exactly these two.
  const pct = "F" + TAG + "10", amt = "F" + TAG + "PAT", mine = "F" + TAG;

  // No code yet for this shop: the catalog says so and the checkout has no box.
  let cp = await checkout(as, shop, { qty: 2 });
  await expect(cp.locator(".ticket-total")).toBeVisible();
  await expect(box(cp).input).toHaveCount(0);
  // The catalog says so (a yes/no only), and says yes once a code works here (below).
  const catalogText = (p) => p.evaluate(async () => (await (await fetch("/api/catalog", { cache: "no-store" })).text()));
  expect(await catalogText(cp)).toContain('"discountCodes":false');

  // ---- the percent code, anyone, 50 uses, this shop ------------------------------------------------------------
  await codesPage(page, mine);
  await expect(page.locator("#dcBody")).toHaveText("No code matches.");
  await page.getByRole("button", { name: "+ New code" }).click();
  let dlg = page.getByRole("dialog", { name: "New discount code" });
  await expect(dlg).toBeVisible();
  // Lower case is shown upper case as typed.
  await dlg.locator("#dcCode").fill(pct.toLowerCase());
  await expect(dlg.locator("#dcCode")).toHaveValue(pct);
  await dlg.locator("#dcKind").selectOption("percent");
  await dlg.locator("#dcValue").fill("10");
  await dlg.locator("#dcOrg").selectOption(shop.orgId);
  await expect(dlg.getByRole("radio", { name: "Anyone" })).toBeChecked();
  await expect(dlg.locator("#dcEmail")).toBeHidden();
  // The page's own check: the uses are needed.
  await dlg.getByRole("button", { name: "Create code" }).click();
  await expect(dlg.locator("#dcErr")).toHaveText("Enter how many times it can be used in all, from 1 to 100,000.");
  await dlg.locator("#dcMax").fill("50");
  let saved = answerOf(page, "saveDiscountCode");
  await dlg.getByRole("button", { name: "Create code" }).click();
  expect(JSON.parse((await saved).request().postData()).code).toMatchObject({ code: pct, kind: "percent", percent: 10, amount: null, orgId: shop.orgId, email: "", maxUses: 50, oncePerEmail: false, expiresOn: "" });
  await expect(toast(page)).toContainText("Code " + pct + " created.");
  await expect(dlg).toHaveCount(0);

  // ---- the amount code for one person ------------------------------------------------------------------------
  await page.getByRole("button", { name: "+ New code" }).click();
  dlg = page.getByRole("dialog", { name: "New discount code" });
  await dlg.locator("#dcCode").fill(amt);
  await dlg.locator("#dcKind").selectOption("amount");
  await expect(dlg.locator("#dcValueLabel")).toHaveText("Amount ($)");
  await dlg.locator("#dcValue").fill("5");
  await dlg.locator("#dcOrg").selectOption(shop.orgId);
  await dlg.getByRole("radio", { name: "One person (single use)" }).check();
  await expect(dlg.locator("#dcEmail")).toBeVisible();
  await expect(dlg.locator("#dcMax")).toBeHidden();
  await dlg.getByRole("button", { name: "Create code" }).click();
  await expect(dlg.locator("#dcErr")).toHaveText("Enter the email address of the person it's for.");
  await dlg.locator("#dcEmail").fill("  PAT@Example.com ");
  saved = answerOf(page, "saveDiscountCode");
  await dlg.getByRole("button", { name: "Create code" }).click();
  expect(JSON.parse((await saved).request().postData()).code).toMatchObject({ code: amt, kind: "amount", amount: 5, percent: null, email: PAT, maxUses: 1, oncePerEmail: false });
  await expect(toast(page)).toContainText("Code " + amt + " created.");

  // The list (reloaded after each save) shows both.
  await expect(codeRow(page, pct)).toHaveCount(1);
  expect(await cellsOf(codeRow(page, pct))).toEqual([pct, "10% off", shop.name, "Anyone", "0 of 50", "Never", "Active"]);
  expect(await cellsOf(codeRow(page, amt))).toEqual([amt, "$5.00 off", shop.name, PAT, "0 of 1", "Never", "Active"]);
  await expect(page.locator("#dcCount")).toHaveText("2 codes");

  // ---- the checkout: the box is there now (no Publish needed) -------------------------------------------------
  cp = await checkout(as, shop, { qty: 2, email: "casey@example.test" });
  const b = box(cp);
  await expect(b.input).toBeVisible();
  const cat = await catalogText(cp);
  expect(cat).toContain('"discountCodes":true');
  expect(cat).not.toContain(pct);
  expect(cat).not.toContain(PAT);
  await expect(cp.getByText("Discount code", { exact: true })).toBeVisible();
  await expect(b.total).toHaveText("$40.00");
  await expect(b.line).toHaveCount(0);
  // Pressing Apply with nothing typed says so, without asking the server.
  await cp.getByRole("button", { name: "Apply" }).click();
  await expect(b.msg).toHaveText("Enter a discount code.");
  // The code in lower case: the server's answer, the code shown, the Discount line and the lower total.
  const r = await apply(cp, pct.toLowerCase());
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ status: "ok", code: pct, label: "10% off", discount: 4, freeShipping: false, combined: { discount: 4, freeShipping: false, codes: [{ code: pct, discount: 4, freeShipping: false }] } });
  expect(r.sent).toMatchObject({ action: "checkDiscountCode", orgId: shop.orgId, code: pct.toLowerCase(), email: "casey@example.test" });
  expect(r.sent.items).toHaveLength(1);
  await expect(b.on).toHaveText(pct + " — 10% off");
  await expect(b.msg).toBeHidden();
  await expect(b.input).toHaveAttribute("readonly", "");
  await expect(b.line).toHaveText(`Discount (${pct})−$4.00`);
  await expect(b.total).toHaveText("$36.00");
  // Remove takes it off (the box empties, the total goes back up); applied again, it's back.
  await cp.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(b.line).toHaveCount(0);
  await expect(b.on).toBeHidden();
  await expect(b.input).toHaveValue("");
  await expect(b.input).not.toHaveAttribute("readonly", "");
  await expect(b.total).toHaveText("$40.00");
  expect((await apply(cp, pct)).body).toMatchObject({ status: "ok", discount: 4 });
  await expect(b.total).toHaveText("$36.00");

  // ---- the order, pay later (check) ----------------------------------------------------------------------------
  const order = await placeIt(cp);
  expect(order.sent).toMatchObject({ discountCode: pct, discount: 4 });
  expect(order.body).toMatchObject({ status: "ok", discount: 4, discountCode: pct, total: 36, owed: 36 });
  expect(order.total).toBe("36.00");
  await expect(cp.locator(".conf-items")).toContainText(`Discount (${pct})−$4.00`);
  await expect(cp.locator(".conf-items .row.total")).toHaveText("Total$36.00");
  await expect(cp.locator(".confirmation")).toContainText("Please pay using the details below");

  // ---- the Orders page: "Code …", the discount and the balance ------------------------------------------------
  await ordersPage(page, shop);
  const row = orderRow(page, order.orderId);
  await expect(row.locator("td[data-discount-td]")).toHaveText(`−$4.00Code ${pct}`);
  await expect(row.locator("td[data-balance-td]")).toHaveText("$36.00");
  const o = (await api("getOrders", { org: shop.orgId })).orders.find(x => x.orderId === order.orderId);
  expect(o).toMatchObject({ discountAmount: 4, discountNote: "Code " + pct, discountCode: pct, balanceDue: 36 });
  // 💰 Payments says it too.
  await row.locator("td[data-action-td]").getByRole("button", { name: "💰 Payments" }).click();
  await expect(page.locator("#pmContent")).toContainText(`Discount (Code ${pct})−$4.00`);
  await expect(page.locator("#pmContent")).toContainText(/Amount due\s*\$36\.00/);
  await page.locator("#pmCloseBottom").click();

  // ---- back on the codes page: one use, and the code's window lists the order ----------------------------------
  await codesPage(page, mine);
  expect(await cellsOf(codeRow(page, pct))).toEqual([pct, "10% off", shop.name, "Anyone", "1 of 50", "Never", "Active"]);
  dlg = await openCode(page, pct);
  await expect(dlg.locator("h4")).toHaveText("Orders (1)");
  const use = dlg.locator("table.dc-uses tbody tr");
  await expect(use).toHaveCount(1);
  const useCells = await cellsOf(use);
  expect(useCells.slice(0, 4)).toEqual([order.orderId, o.customerName, "casey@example.test", "$4.00"]);
  expect(useCells[5]).toBe("");
});

test("a code for one person: refused for another email with the generic sentence, asks for an email first, works for pat@example.com, then says it's been used", async ({ api, as }) => {
  test.setTimeout(120_000);
  const shop = await makeShop(api, { prefix: "dcone", products: PRODUCTS });
  const code = codeOf("PAT");
  await apiCode(api, shop, { code, kind: "amount", amount: 5, email: PAT });

  // No email typed yet.
  let cp = await checkout(as, shop);
  const b = box(cp);
  let r = await apply(cp, code);
  expect(r.status).toBe(400);
  expect(r.body.message).toBe("Enter your email address first — this code is for one person.");
  await expect(b.msg).toHaveText("Enter your email address first — this code is for one person.");
  await expect(b.on).toBeHidden();
  // Typing an email clears a refusal about the email.
  await cp.getByLabel("Email address").fill("sam@example.com");
  await expect(b.msg).toBeHidden();
  // Another email: the generic sentence — the same as for a code that doesn't exist, and never the address.
  r = await apply(cp, code);
  expect(r.status).toBe(400);
  expect(r.body).toEqual({ status: "error", message: GENERIC });
  await expect(b.msg).toHaveText(GENERIC);
  expect(JSON.stringify(r.body)).not.toContain("pat");
  r = await apply(cp, codeOf("NOSUCH"));
  expect(r.body).toEqual({ status: "error", message: GENERIC });
  // A code typed but not applied isn't sent with the order.
  await b.input.fill(code);
  await cp.getByRole("button", { name: "Place order" }).click();
  await expect(cp.locator("#checkoutMsg")).toHaveText("Press Apply to use your discount code, or clear the box to order without it.");
  await expect(cp.getByRole("heading", { level: 2, name: /^Order received/ })).toHaveCount(0);

  // pat@example.com (typed in another case): $5 off the $20 tee.
  await cp.getByLabel("Email address").fill("Pat@Example.com");
  r = await apply(cp, code);
  expect(r.body).toEqual({ status: "ok", code, label: "$5.00 off", discount: 5, freeShipping: false, combined: { discount: 5, freeShipping: false, codes: [{ code: code, discount: 5, freeShipping: false }] } });
  await expect(b.on).toHaveText(code + " — $5.00 off");
  await expect(b.line).toHaveText(`Discount (${code})−$5.00`);
  await expect(b.total).toHaveText("$15.00");
  const order = await placeIt(cp);
  expect(order.total).toBe("15.00");
  expect(order.body).toMatchObject({ discount: 5, discountCode: code, owed: 15 });

  // Used: the next try, even with the right email, is told so.
  cp = await checkout(as, shop, { email: PAT });
  await expect(box(cp).input).toHaveCount(0);   // its only code is used up: no box
  await apiCode(api, shop, { code: codeOf("SPAREA"), maxUses: 5 });   // another code brings the box back
  cp = await checkout(as, shop, { email: PAT });
  r = await apply(cp, code);
  expect(r.body).toEqual({ status: "error", message: "This code has already been used." });
  await expect(box(cp).msg).toHaveText("This code has already been used.");
  await expect(box(cp).total).toHaveText("$20.00");
});

test("a code with one use runs out; an expired code is refused", async ({ page, api, as }) => {
  test.setTimeout(120_000);
  const shop = await makeShop(api, { prefix: "dcout", products: PRODUCTS });
  const once = codeOf("ONCE"), old = codeOf("OLD");
  await apiCode(api, shop, { code: once, kind: "amount", amount: 3, maxUses: 1 });

  let cp = await checkout(as, shop, { email: "first@example.com" });
  let r = await apply(cp, once);
  expect(r.body).toMatchObject({ status: "ok", discount: 3 });
  const order = await placeIt(cp);
  expect(order.total).toBe("17.00");

  // Its one use is gone: no code left for the shop, so no box.
  cp = await checkout(as, shop, { email: "second@example.com" });
  await expect(cp.locator(".ticket-total")).toBeVisible();
  await expect(box(cp).input).toHaveCount(0);
  await codesPage(page);
  expect(await cellsOf(codeRow(page, once))).toEqual([once, "$3.00 off", shop.name, "Anyone", "1 of 1", "Never", "Used up"]);

  // An expired code (its last day long past) and a spare one, so the box shows: each refused code says why.
  await apiCode(api, shop, { code: old, expiresOn: "2020-01-31" });
  await apiCode(api, shop, { code: codeOf("SPAREB"), maxUses: 5 });
  cp = await checkout(as, shop, { email: "second@example.com" });
  r = await apply(cp, once);
  expect(r.body).toEqual({ status: "error", message: "This code has already been used." });
  r = await apply(cp, old);
  expect(r.body).toEqual({ status: "error", message: "This code has expired." });
  await expect(box(cp).msg).toHaveText("This code has expired.");
  await expect(box(cp).line).toHaveCount(0);
  await expect(box(cp).total).toHaveText("$20.00");
  await codesPage(page);
  expect(await cellsOf(codeRow(page, old))).toEqual([old, "10% off", shop.name, "Anyone", "0 of 50", await page.evaluate(() => adminDate_("2020-01-31")), "Expired"]);

  // A code of 2 uses: after both, the limit sentence.
  const two = codeOf("TWO");
  await apiCode(api, shop, { code: two, maxUses: 2 });
  for (const email of ["a@example.com", "b@example.com"]) {
    cp = await checkout(as, shop, { email });
    expect((await apply(cp, two)).body.status).toBe("ok");
    await placeIt(cp);
  }
  cp = await checkout(as, shop, { email: "c@example.com" });
  expect((await apply(cp, two)).body).toEqual({ status: "error", message: "This code has reached its limit." });
});

test("voiding an order gives its use back: Used drops, the window says Given back, and the code works again", async ({ page, api, as }) => {
  test.setTimeout(120_000);
  const shop = await makeShop(api, { prefix: "dcvoid", products: PRODUCTS });
  const code = codeOf("VOID");
  const made = await apiCode(api, shop, { code, kind: "percent", percent: 25, maxUses: 1 });
  await apiCode(api, shop, { code: codeOf("SPAREC"), maxUses: 5 });

  let cp = await checkout(as, shop, { email: "first@example.com" });
  expect((await apply(cp, code)).body).toMatchObject({ status: "ok", discount: 5 });
  const order = await placeIt(cp);
  expect(order.total).toBe("15.00");
  cp = await checkout(as, shop, { email: "second@example.com" });
  expect((await apply(cp, code)).body.message).toBe("This code has already been used.");
  expect((await codeById(api, made.id)).used).toBe(1);

  // Void it on the Orders page (the owner confirms it's them).
  await ordersPage(page, shop);
  await orderRow(page, order.orderId).locator("td[data-action-td]").getByRole("button", { name: "Void…" }).click();
  await page.locator("#delReason").fill("Example void " + TAG);
  await page.locator("#delConfirm").click();
  const who = page.getByRole("dialog", { name: "Confirm it's you to void " + order.orderId });
  const owner = user("owner");
  await who.getByLabel("Email").fill(owner.email);
  await who.getByLabel("Password").fill(owner.password);
  const voided = answerOf(page, "voidOrder");
  await who.getByRole("button", { name: "Submit" }).click();
  expect((await (await voided).json()).status).toBe("ok");
  await expect(toast(page)).toContainText("Order " + order.orderId + " voided");

  // The use is given back.
  await codesPage(page);
  expect(await cellsOf(codeRow(page, code))).toEqual([code, "25% off", shop.name, "Anyone", "0 of 1", "Never", "Active"]);
  const dlg = await openCode(page, code);
  const use = dlg.locator("table.dc-uses tbody tr");
  await expect(use).toHaveCount(1);
  await expect(use.locator("td").nth(0)).toHaveText(order.orderId);
  await expect(use.locator("td").last()).toHaveText("Given back");
  await expect(use).toHaveClass(/cust-row-archived/);
  await page.keyboard.press("Escape");
  await expect(dlg).toHaveCount(0);

  // And the code works again.
  cp = await checkout(as, shop, { email: "second@example.com" });
  expect((await apply(cp, code)).body).toMatchObject({ status: "ok", discount: 5 });
  const again = await placeIt(cp);
  expect(again.total).toBe("15.00");
  expect((await codeById(api, made.id)).used).toBe(1);
});

test("a 100% code places an order with nothing to pay", async ({ page, api, as }) => {
  test.setTimeout(90_000);
  const shop = await makeShop(api, { prefix: "dcfree", products: PRODUCTS });
  const code = codeOf("FREE");
  await apiCode(api, shop, { code, kind: "percent", percent: 100, maxUses: 3 });
  const cp = await checkout(as, shop, { qty: 2, email: "free@example.com" });
  expect((await apply(cp, code)).body).toEqual({ status: "ok", code, label: "100% off", discount: 40, freeShipping: false, combined: { discount: 40, freeShipping: false, codes: [{ code: code, discount: 40, freeShipping: false }] } });
  await expect(box(cp).line).toHaveText(`Discount (${code})−$40.00`);
  await expect(box(cp).total).toHaveText("$0.00");
  const order = await placeIt(cp);
  expect(order.body).toMatchObject({ discount: 40, total: 0, owed: 0 });
  expect(order.total).toBe("0.00");
  await expect(cp.locator(".confirmation")).toContainText("Your order is in. Your discount covers it — there's nothing to pay.");
  await expect(cp.locator(".confirmation")).not.toContainText("Please pay using the details below");
  await expect(cp.locator(".conf-items")).toContainText(`Discount (${code})−$40.00`);

  await ordersPage(page, shop);
  const row = orderRow(page, order.orderId);
  await expect(row.locator("td[data-discount-td]")).toHaveText(`−$40.00Code ${code}`);
  await expect(row.locator("td[data-balance-td]")).not.toHaveText(/\$/);
  const o = (await api("getOrders", { org: shop.orgId })).orders.find(x => x.orderId === order.orderId);
  expect(o).toMatchObject({ discountAmount: 40, balanceDue: 0, discountCode: code });
});

test("bulk codes for three emails: each email's code is listed, a bad address is skipped, and Download CSV saves them", async ({ page, api }) => {
  test.setTimeout(90_000);
  const shop = await makeShop(api, { prefix: "dcbulk", products: PRODUCTS });
  const low = TAG.toLowerCase();
  const emails = [`ann-${low}@example.com`, `ben-${low}@example.com`, `cy-${low}@example.com`];
  const prefix = ("B" + TAG).slice(0, 10) + "-";
  await codesPage(page);
  await page.getByRole("button", { name: "Codes for a list of emails…" }).click();
  const dlg = page.getByRole("dialog", { name: "Codes for a list of emails" });
  await expect(dlg).toBeVisible();
  // One per line, commas, a repeat in another case and a bad one: four different addresses.
  await dlg.locator("#dcEmails").fill(`${emails[0]}\n${emails[1]}, ${emails[2]}\n${emails[0].toUpperCase()}\nnot-an-email`);
  await expect(dlg.locator("#dcEmailCount")).toHaveText("4 addresses");
  await dlg.locator("#dcPrefix").fill(prefix.toLowerCase());
  await expect(dlg.locator("#dcPrefix")).toHaveValue(prefix);
  await dlg.locator("#dcKind").selectOption("amount");
  await dlg.locator("#dcValue").fill("7.50");
  await dlg.locator("#dcOrg").selectOption(shop.orgId);
  await dlg.locator("#dcNote").fill("Bulk " + TAG);
  const made = answerOf(page, "createDiscountCodes");
  await dlg.getByRole("button", { name: "Make codes" }).click();
  const res = await made;
  expect(JSON.parse(res.request().postData())).toMatchObject({ emails: [...emails, "not-an-email"], prefix, kind: "amount", amount: 7.5, org: shop.orgId });
  const body = await res.json();
  expect(body.codes.map(c => c.email).sort()).toEqual(emails);
  expect(body.skipped.map(s => s.email)).toEqual(["not-an-email"]);

  const done = dlg.locator("#dcBulkDone");
  await expect(done).toBeVisible();
  await expect(done.locator("#dcBulkSaid")).toHaveText("3 codes made. 1 address was skipped (below). Each works once, for its own email address.");
  const rows = done.locator(".dc-bulk-list").first().locator("tbody tr");
  await expect(rows).toHaveCount(3);
  const shown = [];
  for (let i = 0; i < 3; i++) shown.push(await cellsOf(rows.nth(i)));
  expect(shown.map(s => s[0]).sort()).toEqual(emails);
  for (const [, c] of shown) expect(c).toMatch(new RegExp("^" + prefix + "[A-HJ-NP-Z2-9]{8}$"));
  expect(new Set(shown.map(s => s[1])).size).toBe(3);
  await expect(done.locator(".dc-bulk-list").nth(1).locator("tbody tr td").first()).toHaveText("not-an-email");

  // Download CSV: email,code for each, as shown.
  const dl = page.waitForEvent("download");
  await done.getByRole("button", { name: "Download CSV" }).click();
  const file = await dl;
  expect(file.suggestedFilename()).toBe(`discount-codes-${await page.evaluate(() => localToday_())}.csv`);
  const csv = fs.readFileSync(await file.path(), "utf8").split("\r\n").filter(Boolean);
  expect(csv[0]).toBe("email,code");
  expect(csv.slice(1).sort()).toEqual(shown.map(([e, c]) => e + "," + c).sort());
  await done.getByRole("button", { name: "Done" }).click();
  await expect(dlg).toHaveCount(0);

  // The list has them, each for its own address, one use.
  await codesPage(page, prefix);
  await expect(page.locator("#dcBody tbody tr")).toHaveCount(3);
  for (const [e, c] of shown) expect(await cellsOf(codeRow(page, c))).toEqual([c, "$7.50 off", shop.name, e, "0 of 1", "Never", "Active"]);
});

test("a used code's window locks its fixed fields; its uses, expiry and note still save", async ({ page, api, as }) => {
  test.setTimeout(90_000);
  const shop = await makeShop(api, { prefix: "dclock", products: PRODUCTS });
  const used = codeOf("USED"), fresh = codeOf("FRESH");
  const made = await apiCode(api, shop, { code: used, percent: 15, maxUses: 10, oncePerEmail: true });
  await apiCode(api, shop, { code: fresh, maxUses: 10 });
  const cp = await checkout(as, shop, { email: "lock@example.com" });
  expect((await apply(cp, used)).body).toMatchObject({ status: "ok", discount: 3 });
  await placeIt(cp);

  await codesPage(page);
  expect(await cellsOf(codeRow(page, used))).toEqual([used, "15% off", shop.name, "Anyone, once per email", "1 of 10", "Never", "Active"]);
  // An unused code: everything open, Delete offered.
  let dlg = await openCode(page, fresh);
  await expect(dlg.locator(".dc-locked")).toHaveCount(0);
  for (const sel of ["#dcCode", "#dcKind", "#dcValue", "#dcOrg", "#dcOnce"]) await expect(dlg.locator(sel)).toBeEnabled();
  await expect(dlg.getByRole("button", { name: "Delete" })).toBeVisible();
  await expect(dlg.getByRole("button", { name: "Make one" })).toBeVisible();
  await dlg.getByRole("button", { name: "Cancel" }).click();
  await expect(dlg).toHaveCount(0);

  // The used one: locked, with the reason; no Delete, no Make one.
  dlg = await openCode(page, used);
  await expect(dlg.locator(".dc-locked")).toHaveText("This code has been used, so only its expiry, uses, note and on/off can change. To offer a different discount, make a new code.");
  await expect(dlg.locator(".dc-sub")).toContainText("15% off · used 1 of 10");
  for (const sel of ["#dcCode", "#dcKind", "#dcValue", "#dcOrg", "#dcEmail", "#dcOnce"]) await expect(dlg.locator(sel)).toBeDisabled();
  for (const r of await dlg.getByRole("radio").all()) await expect(r).toBeDisabled();
  for (const sel of ["#dcMax", "#dcExpires", "#dcNote", "#dcActive"]) await expect(dlg.locator(sel)).toBeEnabled();
  await expect(dlg.locator("#dcMax")).toHaveAttribute("min", "1");
  await expect(dlg.getByRole("button", { name: "Delete" })).toHaveCount(0);
  await expect(dlg.getByRole("button", { name: "Make one" })).toHaveCount(0);

  // Its uses, expiry and note save.
  await dlg.locator("#dcMax").fill("20");
  await dlg.locator("#dcExpires").fill("2099-12-31");
  await dlg.locator("#dcNote").fill("Spring " + TAG);
  const saved = answerOf(page, "saveDiscountCode");
  await dlg.getByRole("button", { name: "Save" }).click();
  const res = await saved;
  expect(res.status()).toBe(200);
  expect(JSON.parse(res.request().postData()).code).toMatchObject({ id: made.id, code: used, kind: "percent", percent: 15, maxUses: 20, oncePerEmail: true, expiresOn: "2099-12-31", note: "Spring " + TAG });
  await expect(toast(page)).toContainText("Code " + used + " saved.");
  await expect(dlg).toHaveCount(0);
  expect(await codeById(api, made.id)).toMatchObject({ maxUses: 20, expiresOn: "2099-12-31", note: "Spring " + TAG, percent: 15, used: 1 });
  expect(await cellsOf(codeRow(page, used))).toEqual([used, "15% off", shop.name, "Anyone, once per email", "1 of 20", await page.evaluate(() => adminDate_("2099-12-31")), "Active"]);

  // The server refuses a change to a fixed field just the same (the page can't send one).
  const refused = await api("saveDiscountCode", { code: { id: made.id, kind: "percent", percent: 50, maxUses: 20, orgId: shop.orgId } }, { allowError: true, withStatus: true });
  expect(refused.status).toBe(400);
  expect(refused.data.message).toBe("This code has been used — you can change its expiry, uses, note or switch it off.");
});
