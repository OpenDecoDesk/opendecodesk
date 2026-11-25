// Fundraising for group shops (migrations/0110) end to end, in a real browser, as the owner:
//   - the shop's Edit page: the Fundraiser section (none / percent / per piece, the amount, "Supports", "Show on the
//     shop"), its live preview and its checks; Save sends setOrgFundraiser only when the fundraiser changed, and a
//     refusal from the server keeps the form open with the reason; the fundraiser is live at once (no Publish);
//   - the storefront's line under the shop's heading ("10% of every purchase supports …", "$2.00 of every item …"),
//     gone once "Show on the shop" is off;
//   - a storefront order and a local sale with a custom line (which raises nothing), marked paid; the order's
//     "Raises $x for Example Boosters" in the Orders list and in 💰 Payments;
//   - Reports → Fundraising: the empty states, the date checks and presets, a paid order that hasn't shipped isn't
//     counted (the install's sale date is "when it ships or is delivered"), the shop's row (orders, pieces, sales,
//     raised, paid out, still owed) with its total, the per-order rows, Export CSV, and opening an order from it;
//   - Record payout…: its checks, a refusal from the server, a payout from an account — paid out and still owed move,
//     the payout is listed under the report and on Finance → Expenses, and the audit log names both changes;
//   - switching the shop to $2 per piece: earlier orders keep what they raised, a new order raises per piece, and a
//     cancelled line and a refunded one lower what it raised.
//
// Every test makes or reuses this file's own shop, accounts and orders (unique names), and the report is always
// filtered to that shop, so other specs running beside this one never change what is checked. Dates come from the
// page itself (the business's today), so nothing depends on this computer's clock or time zone. No install-wide
// setting is changed: Bookkeeping is on and the sale date is "shipped" on a fresh install.
import { test, expect, ADMIN, openAdmin, toast, uniq, shopUrl, waitIdle } from "../fixtures.mjs";
import { makeShop, placeOrder } from "../lib/data.mjs";
import fs from "node:fs";

test.describe.configure({ mode: "serial" });

const LABEL = "Example Boosters";
// "No blank needed", so an order can go from paid to delivered without a vendor's blank order.
const PRODUCTS = [{ name: "Sample Tee", price: 20, extra: { noBlankNeeded: true } }, { name: "Sample Cap", price: 15, type: "cap", idPrefix: "cap", extra: { noBlankNeeded: true } }];
const tag = uniq("fr").split(" ")[1];
const NOTE = "Check 1042 " + tag;

// Shared by the serial tests below.
let shop, accountA, accountB, webOrder, localOrder, laterOrder;

// ---- helpers ---------------------------------------------------------------------------------------------
const actionOf = (req) => { try { return JSON.parse(req.postData() || "{}").action; } catch (e) { return ""; } };
const answerOf = (page, action) => page.waitForResponse(r => r.url().endsWith("/api/orders") && actionOf(r.request()) === action);
// Every POST /api/orders the page sends from now on, as { action, body }.
const watchRequests = (page) => {
  const sent = [];
  page.on("request", (req) => {
    if (req.method() !== "POST" || !/\/api\/orders$/.test(req.url())) return;
    try { const b = JSON.parse(req.postData() || "{}"); sent.push({ action: b.action, body: b }); } catch (e) { /* not JSON */ }
  });
  return sent;
};
// "Raises $5.50 for …": the amount. (Which group it names isn't checked here: on a fresh load of the Orders page the
// page doesn't know the shop's label yet and writes "the shop's fundraiser" — reported, not asserted.)
const raises = (amount) => new RegExp("^Raises \\$" + amount.replace(".", "\\.") + " for ");
// A row's cells as written (textContent, not innerText: buttons are styled in capitals), a <br> read as a space.
const cellsOf = async (row) => (await row.locator("td").evaluateAll(tds => tds.map(td => {
  const c = td.cloneNode(true); c.querySelectorAll("br").forEach(b => b.replaceWith(" ")); return c.textContent;
}))).map(s => s.trim().replace(/\s+/g, " "));
const orgOf = async (api, orgId) => (await api("listOrgsAdmin")).orgs.find(o => o.orgId === orgId);
// A paid order's steps up to delivered, sent as the Orders page's stage list sends them (the steps are orders.spec's
// subject). Delivered is when the install's sale date ("when it ships or is delivered") counts it.
const deliver = async (api, orderId) => {
  await api("setFulfillmentStage", { org: shop.orgId, orderId, stage: "digitizingComplete" });
  await api("setFulfillmentStage", { org: shop.orgId, orderId, stage: "designApproved" }, { allowError: true });
  for (const stage of ["manufactured", "qaPacked", "delivered"]) await api("setFulfillmentStage", { org: shop.orgId, orderId, stage });
};
const orderOf = async (api, orderId) => (await api("getOrders", { org: shop.orgId })).orders.find(o => o.orderId === orderId);

// The shop's Edit page and its Fundraiser box.
const editShop = async (page) => {
  await openAdmin(page, "catalog/orgs/" + shop.orgId + "/edit");
  await expect(page.getByRole("heading", { name: "Shop settings", level: 2 })).toBeVisible();
};
const fr = (page) => ({
  mode: page.locator("#orgFrMode"), fields: page.locator("#orgFrFields"), amountLabel: page.locator("#orgFrAmountLabel"),
  amount: page.locator("#orgFrAmount"), label: page.locator("#orgFrLabel"), show: page.locator("#orgFrShow"),
  preview: page.locator("#orgFrPreview"), err: page.locator("#orgFormError"),
});
const saveShop = (page) => page.getByRole("button", { name: "Save changes" }).click();

// The shop's own page, in a customer's browser of its own; returns the fundraiser line's locator.
const storefrontLine = async (as) => {
  const cp = await as(null);
  await cp.goto(shopUrl(shop.subdomain) + "/");
  await expect(cp.getByRole("heading", { level: 1, name: shop.name })).toBeVisible();
  return cp.locator(".org-hero p.fundraiser-line");
};

// The shop's Orders page and one order's rows.
const ordersPage = async (page) => {
  if (page.url() === ADMIN + "/#orders/" + shop.orgId) await page.goto("about:blank");
  await openAdmin(page, "orders/" + shop.orgId);
  await expect(page.getByRole("combobox", { name: "Shop" })).toHaveValue(shop.orgId);
};
const orderRow = (page, orderId) => page.locator(`tr[data-order="${orderId}"]`).first();
const actionCell = (page, orderId) => orderRow(page, orderId).locator("td[data-action-td]");
const pillOf = (page, orderId) => orderRow(page, orderId).locator(".fundraiser-pill");
const confirmOk = async (page) => {
  const ok = page.locator(".confirm-modal #cmOk");
  await expect(ok).toBeVisible();
  await ok.click();
  await expect(page.locator(".confirm-modal")).toHaveCount(0);
};

// Reports → Fundraising, filtered to this file's shop. Waits for the report's answer each time.
const report = {
  open: async (page) => {
    const first = answerOf(page, "getFundraisingReport");
    await openAdmin(page, "fundraising");
    await first;
    // Reached from Reports in the menu (after the Sales tax report), with the page's own title.
    const nav = page.getByRole("navigation", { name: "Admin" });
    await nav.getByRole("button", { name: "Reports ▾" }).click();
    const items = await nav.getByRole("button").allTextContents();
    expect(items.slice(items.indexOf("Sales tax report"), items.indexOf("Sales tax report") + 2)).toEqual(["Sales tax report", "Fundraising"]);
    await page.keyboard.press("Escape");
    await expect(page).toHaveTitle(/Fundraising/);
    const mine = answerOf(page, "getFundraisingReport");
    await page.locator("#frOrg").selectOption(shop.orgId);
    const body = await (await mine).json();
    expect(body.status).toBe("ok");
    expect(body.orgId).toBe(shop.orgId);
    await report.drawn(page);
    return body;
  },
  generate: async (page) => {
    const done = answerOf(page, "getFundraisingReport");
    await page.locator("#frFilters").getByRole("button", { name: "Generate" }).click();
    const body = await (await done).json();
    expect(body.status).toBe("ok");
    await report.drawn(page);
    return body;
  },
  // The answer is drawn once the payouts list is in too ("Loading…" until then).
  drawn: async (page) => { await expect(page.locator("#frResults #frShops")).toBeVisible(); await expect(page.locator("#frResults #frPayouts")).toBeVisible(); },
  shopRow: (page) => page.locator("#frShops tbody tr"),
  total: (page) => page.locator("#frShops tfoot tr"),
  orderRows: (page) => page.locator("#frOrders tbody tr"),
  orderRow: (page, orderId) => page.locator("#frOrders tbody tr", { hasText: orderId }),
  payoutRows: (page) => page.locator("#frPayouts tbody tr"),
};
const today = (page) => page.evaluate(() => localToday_());
const shownDate = (page, ymd) => page.evaluate((d) => adminDate_(d), ymd);

// =========================================================================================================
test("the shop's Fundraiser box: preview, checks, Save sends it only when it changed, a refusal keeps the form; the storefront shows the line at once", async ({ page, api, as }) => {
  test.setTimeout(120_000);
  shop = await makeShop(api, { prefix: "frf", products: PRODUCTS });

  // Before anything is set, the report for this shop has no row and says how to start one.
  await report.open(page);
  await expect(report.shopRow(page)).toHaveCount(1);
  await expect(report.shopRow(page)).toHaveText("No shop has a fundraiser, and none raised or paid out anything in this range. Set one up on a shop's Edit page (Manage catalog → the shop → Edit).");
  await expect(report.total(page)).toHaveCount(0);
  await expect(page.locator("#frResults h3").first()).toHaveText("Orders (0)");
  await expect(report.orderRows(page)).toHaveText(["No paid order raised anything in this range."]);
  await expect(page.locator("#frResults").getByRole("button", { name: "Export CSV" })).toHaveCount(0);
  await expect(report.payoutRows(page)).toHaveText(["No payouts in this range."]);
  await expect(page.locator("#frResults h3").nth(1)).toHaveText("Payouts to the group (0)");

  // ---- the box, as a shop without a fundraiser has it -----------------------------------------------------
  await editShop(page);
  const f = fr(page);
  await expect(page.locator("#orgFormFundraiser").locator("xpath=preceding-sibling::div[1]")).toHaveText(
    "Part of each sale goes back to the group this shop raises money for (Reports → Fundraising adds it up). Inside your prices: customers pay the same. Changes apply to new orders.");
  await expect(f.mode).toHaveValue("");
  expect(await f.mode.locator("option").allTextContents()).toEqual(["Has no fundraiser", "Gives a percent of each item's price", "Gives a set amount per piece"]);
  await expect(f.fields).toBeHidden();

  // Percent: its own label and limit; the preview follows what is typed.
  await f.mode.selectOption("percent");
  await expect(f.fields).toBeVisible();
  await expect(f.amountLabel).toHaveText("Percent of each item's price (0.01–50)");
  await expect(f.amount).toHaveAttribute("max", "50");
  await expect(f.preview).toHaveText("");
  await f.amount.fill("60");
  await f.label.fill(LABEL);
  await expect(f.preview).toHaveText("");                       // 60% can't be saved: nothing to preview
  await saveShop(page);
  await expect(f.err).toHaveText("The fundraiser's percent must be from 0.01 to 50.");
  await f.amount.fill("10");
  await expect(f.preview).toHaveText("Not shown on the shop: 10% of every purchase supports " + LABEL + ".");
  await f.show.check();
  await expect(f.preview).toHaveText("The shop shows: “10% of every purchase supports " + LABEL + ".”");
  await f.label.fill("   ");
  await expect(f.preview).toHaveText("");
  await saveShop(page);
  await expect(f.err).toHaveText("Say who the fundraiser supports (e.g. Example Boosters).");

  // Per piece: the other label and limit, and its own checks.
  await f.mode.selectOption("perPiece");
  await expect(f.amountLabel).toHaveText("Amount per piece ($0.01–$1,000)");
  await expect(f.amount).toHaveAttribute("max", "1000");
  await f.amount.fill("2000");
  await f.label.fill(LABEL);
  await saveShop(page);
  await expect(f.err).toHaveText("The fundraiser's amount per piece must be from $0.01 to $1,000.");
  await f.amount.fill("2");
  await f.label.fill("");
  await saveShop(page);
  await expect(f.err).toHaveText("Say who the fundraiser supports (e.g. Example Boosters).");
  await f.amount.fill("");
  await saveShop(page);
  await expect(f.err).toHaveText("The fundraiser's amount per piece must be from $0.01 to $1,000.");
  // Back to none hides the fields again.
  await f.mode.selectOption("");
  await expect(f.fields).toBeHidden();

  // ---- the server refuses: the rest of the shop is saved, the form stays with the reason ----------------------
  // (The page checks the same rules first, so the request is changed on its way to reach the server's own check.)
  await f.mode.selectOption("percent");
  await f.amount.fill("10");
  await f.label.fill(LABEL);
  await f.show.check();
  await page.route("**/api/orders", async (route) => {
    const b = JSON.parse(route.request().postData() || "{}");
    if (b.action !== "setOrgFundraiser") return route.continue();
    await route.continue({ postData: JSON.stringify({ ...b, fundraiser: { ...b.fundraiser, label: "" } }) });
  });
  const refused = answerOf(page, "setOrgFundraiser");
  await saveShop(page);
  expect((await refused).status()).toBe(400);
  await expect(f.err).toHaveText("The shop's settings were saved, but not its fundraiser: Enter who the fundraiser supports (for example, the team or club's name).");
  await expect(page).toHaveURL(new RegExp("#catalog/orgs/" + shop.orgId + "/edit$"));
  await page.unroute("**/api/orders");
  expect((await orgOf(api, shop.orgId)).fundraiser).toBeNull();
  // …and when the server can't be reached.
  await page.route("**/api/orders", (route) => actionOf(route.request()) === "setOrgFundraiser" ? route.abort() : route.continue());
  await saveShop(page);
  await expect(f.err).toHaveText("The shop's settings were saved, but not its fundraiser: the server couldn't be reached.");
  await page.unroute("**/api/orders");

  // ---- saved: 10%, shown on the shop --------------------------------------------------------------------
  const sent = watchRequests(page);
  const saved = answerOf(page, "setOrgFundraiser");
  await saveShop(page);
  const answer = await (await saved).json();
  expect(answer).toEqual({ status: "ok", fundraiser: { mode: "percent", percent: 10, label: LABEL, showOnShop: true } });
  await expect(page).toHaveURL(/#catalog$/);
  expect(sent.find(s => s.action === "setOrgFundraiser").body).toMatchObject({ org: shop.orgId, fundraiser: { mode: "percent", percent: 10, label: LABEL, showOnShop: true } });
  expect((await orgOf(api, shop.orgId)).fundraiser).toEqual({ mode: "percent", percent: 10, label: LABEL, showOnShop: true });

  // The form opens with it, and Save with nothing changed in it doesn't send it again.
  await editShop(page);
  await expect(f.mode).toHaveValue("percent");
  await expect(f.amount).toHaveValue("10");
  await expect(f.label).toHaveValue(LABEL);
  await expect(f.show).toBeChecked();
  await expect(f.preview).toHaveText("The shop shows: “10% of every purchase supports " + LABEL + ".”");
  const again = watchRequests(page);
  const upd = answerOf(page, "updateOrg");
  await saveShop(page);
  await upd;
  await expect(page).toHaveURL(/#catalog$/);
  await waitIdle(page);
  expect(again.map(s => s.action)).toContain("updateOrg");
  expect(again.map(s => s.action)).not.toContain("setOrgFundraiser");

  // ---- the storefront: the line under the shop's heading, with no Publish --------------------------------
  const line = await storefrontLine(as);
  await expect(line).toHaveText("10% of every purchase supports " + LABEL);
  // The catalog sends only the sentence, never the setup.
  const cat = await line.page().evaluate(async () => (await (await fetch("/api/catalog", { cache: "no-store" })).text()));
  expect(cat).toContain('"fundraiser":{"text":"10% of every purchase supports ' + LABEL + '"}');
  expect(cat).not.toContain("percentBps");
  expect(cat).not.toContain('"showOnShop"');
});

test("a storefront order and a local sale with a custom line, marked paid: each says what it raises, and the custom line raises nothing", async ({ page, api, as }) => {
  test.setTimeout(120_000);
  // ---- the storefront order: 2 tees and a cap, $55 → 10% raises $5.50 -------------------------------------
  const cp = await as(null);
  const customer = uniq("Casey Customer");
  webOrder = await placeOrder(cp, shop, { customer, items: [{ name: "Sample Tee", qty: 2 }, { name: "Sample Cap", qty: 1 }] });
  expect(webOrder.total).toBe("55.00");                 // inside the price: the customer pays the same
  webOrder.customer = customer;
  const placed = await orderOf(api, webOrder.orderId);
  expect(placed.items.map(i => [i.name, i.fundraiserCents]).sort()).toEqual([["Sample Cap", 150], ["Sample Tee", 400]]);
  expect(placed.fundraiserRaised).toBe(5.5);

  await ordersPage(page);
  await expect(pillOf(page, webOrder.orderId)).toHaveText(raises("5.50"));
  await expect(pillOf(page, webOrder.orderId)).toHaveAttribute("title", "Inside the order's price: what it raises for the shop's fundraiser (Reports → Fundraising)");
  // Mark as paid, through the page.
  await actionCell(page, webOrder.orderId).getByRole("button", { name: "Mark as paid" }).click();
  await confirmOk(page);
  await expect(actionCell(page, webOrder.orderId).getByRole("button", { name: "Mark as paid" })).toHaveCount(0);
  await expect(pillOf(page, webOrder.orderId)).toHaveText(raises("5.50"));
  // 💰 Payments says it too, inside the price.
  await actionCell(page, webOrder.orderId).getByRole("button", { name: "💰 Payments" }).click();
  const pmLine = page.locator("#pmContent tr.pm-fundraiser");
  await expect(pmLine).toHaveText(/^Raises \$5\.50 for .+ \(inside the price\)$/);
  await expect(pmLine.locator("td")).toHaveAttribute("title", "Inside the price: the customer pays the same");
  await expect(page.locator("#pmContent")).toContainText(/Amount due\s*\$55\.00/);
  await page.locator("#pmCloseBottom").click();

  // ---- the local sale: a tee ($20 → $2.00) and a custom line ($30, raises nothing), paid and delivered -----
  await page.getByRole("button", { name: "+ Local sale" }).click();
  const form = page.locator("#localSaleForm");
  await expect(form).toBeVisible();
  await form.locator("#lsProduct").selectOption({ label: "Sample Tee" });
  await form.getByRole("button", { name: "+ Add another item" }).click();
  const second = form.locator(".ls-line").nth(1);
  await second.getByLabel("Product").selectOption({ label: "— Custom item —" });
  await second.getByLabel("Description").fill("Banner setup " + tag);
  await second.getByLabel("Price per unit ($)").fill("30");
  await form.locator("#lsPayment").selectOption("Cash");
  await form.locator("summary", { hasText: "Customer info" }).click();
  const localCustomer = uniq("Jordan Counter");
  await form.locator("#lsName").fill(localCustomer);
  await form.locator("#lsPaid").check();
  await form.locator("#lsDelivered").check();
  const made = answerOf(page, "createLocalSale");
  await form.getByRole("button", { name: "Record sale" }).click();
  const sale = await (await made).json();
  expect(sale.status).toBe("ok");
  await expect(toast(page)).toContainText("Local sale recorded — ");
  localOrder = { orderId: sale.orderId, customer: localCustomer };
  const local = await orderOf(api, localOrder.orderId);
  expect(local.paid).toBeTruthy();
  expect(local.items.map(i => [i.name, i.fundraiserCents]).sort()).toEqual([["Banner setup " + tag, 0], ["Sample Tee", 200]]);
  expect(local.fundraiserRaised).toBe(2);
  await ordersPage(page);
  await expect(pillOf(page, localOrder.orderId)).toHaveText(raises("2.00"));
  // Once the page knows the shop's fundraiser (Manage catalog loads it), the order names the group it raises for.
  await openAdmin(page, "catalog");
  await page.goto(ADMIN + "/#orders/" + shop.orgId);
  await expect(page.getByRole("combobox", { name: "Shop" })).toHaveValue(shop.orgId);
  await expect(pillOf(page, webOrder.orderId)).toHaveText("Raises $5.50 for " + LABEL);
  await expect(pillOf(page, localOrder.orderId)).toHaveText("Raises $2.00 for " + LABEL);
  await actionCell(page, webOrder.orderId).getByRole("button", { name: "💰 Payments" }).click();
  await expect(page.locator("#pmContent tr.pm-fundraiser")).toHaveText("Raises $5.50 for " + LABEL + " (inside the price)");
  await page.locator("#pmCloseBottom").click();
});

test("Reports → Fundraising: date checks and presets, only paid orders once they ship count, the shop's row and the orders, Export CSV, opening an order", async ({ page, api }) => {
  test.setTimeout(120_000);
  const body = await report.open(page);
  const y = await page.evaluate(() => adminYear_());
  const to = await page.evaluate(() => reportToDay_());
  await expect(page.locator("#frFrom")).toHaveValue(y + "-01-01");
  await expect(page.locator("#frTo")).toHaveValue(to);
  expect(body.saleDate).toBe("shipped");
  await expect(page.locator("#frResults > div").first()).toHaveText(
    `${await shownDate(page, y + "-01-01")} – ${await shownDate(page, to)} · orders counted when they ship or are delivered. Still owed is everything raised less everything paid out up to ${await shownDate(page, to)}, not only in this range.`);

  // The storefront order is paid but hasn't shipped: under "when it ships" it isn't counted yet. The local sale was
  // delivered, so it is.
  await expect(report.orderRows(page)).toHaveCount(1);
  expect(await cellsOf(report.orderRow(page, localOrder.orderId))).toEqual([
    await shownDate(page, (await orderOf(api, localOrder.orderId)).placedAt), localOrder.orderId, shop.name, localOrder.customer, "1", "$50.00", "$2.00"]);
  expect(await cellsOf(report.shopRow(page))).toEqual([shop.name + " Supports " + LABEL + " · a percent of each sale", "1", "1", "$50.00", "$2.00", "—", "$2.00", "Record payout…"]);

  // Delivered: now it counts.
  await deliver(api, webOrder.orderId);
  await report.generate(page);
  await expect(report.orderRows(page)).toHaveCount(2);
  expect(await cellsOf(report.shopRow(page))).toEqual([shop.name + " Supports " + LABEL + " · a percent of each sale", "2", "4", "$105.00", "$7.50", "—", "$7.50", "Record payout…"]);
  expect(await cellsOf(report.total(page))).toEqual(["Total", "2", "4", "$105.00", "$7.50", "$0.00", "$7.50", ""]);
  await expect(page.locator("#frResults h3").first()).toHaveText("Orders (2)");
  expect(await cellsOf(report.orderRow(page, webOrder.orderId))).toEqual([
    await shownDate(page, (await orderOf(api, webOrder.orderId)).placedAt), webOrder.orderId, shop.name, webOrder.customer, "3", "$55.00", "$5.50"]);
  // Header tips on the columns that need one.
  const heads = page.locator("#frShops thead th");
  await expect(heads.nth(3)).toHaveAttribute("title", "What these orders' items sold for, before tax");
  await expect(heads.nth(5)).toHaveAttribute("title", "Payouts dated in this range");
  await expect(heads.nth(6)).toHaveAttribute("title", "Raised less paid out, up to the To date");

  // ---- the date checks, on the page ------------------------------------------------------------------------
  await page.locator("#frFrom").fill("");
  await page.locator("#frFilters").getByRole("button", { name: "Generate" }).click();
  await expect(page.locator("#frResults")).toHaveText("Choose both dates.");
  await page.locator("#frFrom").fill(to);
  await page.locator("#frTo").fill((Number(to.slice(0, 4)) - 1) + to.slice(4));
  await page.locator("#frFilters").getByRole("button", { name: "Generate" }).click();
  await expect(page.locator("#frResults")).toHaveText("The From date is after the To date.");

  // ---- the presets: a quarter, last year (nothing then, still owed as of its end), this year ---------------
  expect(await page.locator("#frFilters button[data-admin-action=fundraisingShowRange_]").allTextContents()).toEqual(
    [`Q1 ${y}`, `Q2 ${y}`, `Q3 ${y}`, `Q4 ${y}`, String(y), String(y - 1)]);
  let wait = answerOf(page, "getFundraisingReport");
  await page.getByRole("button", { name: `Q3 ${y}`, exact: true }).click();
  let a = await (await wait).json();
  expect([a.dateFrom, a.dateTo, a.orgId]).toEqual([y + "-07-01", y + "-09-30", shop.orgId]);
  await expect(page.locator("#frFrom")).toHaveValue(y + "-07-01");
  await expect(page.locator("#frTo")).toHaveValue(y + "-09-30");
  wait = answerOf(page, "getFundraisingReport");
  await page.getByRole("button", { name: String(y - 1), exact: true }).click();
  a = await (await wait).json();
  await report.drawn(page);
  expect([a.dateFrom, a.dateTo]).toEqual([(y - 1) + "-01-01", (y - 1) + "-12-31"]);
  // Last year: the shop has a fundraiser now, so it's listed, with nothing raised and nothing owed yet.
  expect(await cellsOf(report.shopRow(page))).toEqual([shop.name + " Supports " + LABEL + " · a percent of each sale", "—", "—", "—", "—", "—", "—", "Record payout…"]);
  await expect(report.orderRows(page)).toHaveText(["No paid order raised anything in this range."]);
  wait = answerOf(page, "getFundraisingReport");
  await page.getByRole("button", { name: String(y), exact: true }).click();
  a = await (await wait).json();
  await report.drawn(page);
  expect([a.dateFrom, a.dateTo]).toEqual([y + "-01-01", y + "-12-31"]);
  await expect(report.orderRows(page)).toHaveCount(2);

  // ---- Export CSV: the rows on the screen -------------------------------------------------------------------
  const dl = page.waitForEvent("download");
  await page.locator("#frResults").getByRole("button", { name: "Export CSV" }).click();
  const file = await dl;
  expect(file.suggestedFilename()).toBe(`fundraising-${shop.orgId}-${y}-01-01-to-${y}-12-31.csv`);
  const csv = fs.readFileSync(await file.path(), "utf8").split("\r\n").filter(Boolean);
  const day = (iso) => page.evaluate((v) => adminDay_(v), iso);
  expect(csv[0]).toBe("Date,Order #,Shop,Supports,Customer,Pieces,Sales,Raised");
  expect(csv.slice(1).sort()).toEqual([
    `${await day((await orderOf(api, webOrder.orderId)).placedAt)},${webOrder.orderId},${shop.name},${LABEL},${webOrder.customer},3,55,5.5`,
    `${await day((await orderOf(api, localOrder.orderId)).placedAt)},${localOrder.orderId},${shop.name},${LABEL},${localOrder.customer},1,50,2`,
  ].sort());

  // ---- an order number opens the order in its shop's orders -------------------------------------------------
  await report.orderRow(page, webOrder.orderId).getByRole("button", { name: webOrder.orderId }).click();
  await expect(page).toHaveURL(new RegExp("#orders/" + shop.orgId));
  await expect(pillOf(page, webOrder.orderId)).toHaveText(raises("5.50"));
});

test("Record payout…: its checks, a refusal from the server, then a payout from an account — paid out and owed move, and it is listed here, on Expenses and in the audit log", async ({ page, api }) => {
  test.setTimeout(120_000);
  accountA = uniq("Booster Checking");
  accountB = uniq("Booster Till");
  // Two accounts of this file's own, so the window always asks which one (with only one it is picked for you).
  for (const name of [accountA, accountB]) await api("saveAccount", { account: { name, type: "checking", openingBalance: 100, openingDate: "2020-01-01" } });
  await report.open(page);
  const todayYmd = await today(page);

  await report.shopRow(page).getByRole("button", { name: "Record payout…" }).click();
  const dlg = page.getByRole("dialog", { name: "Record payout — " + shop.name });
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText(`Money you paid to ${LABEL} from this shop's fundraiser. It is recorded as an expense in Fundraiser payouts; still owed up to ${await shownDate(page, await page.locator("#frTo").inputValue())}: $7.50.`);
  // The amount starts at what is owed, the date at today, the account unchosen.
  await expect(dlg.locator("#frpAmount")).toHaveValue("7.50");
  await expect(dlg.locator("#frpDate")).toHaveValue(todayYmd);
  await expect(dlg.locator("#frpAccount")).toHaveValue("");
  await expect(dlg.locator("#frpAccount option").first()).toHaveText("Choose…");
  const err = dlg.locator("#frpErr");
  // The page's own checks: nothing is sent.
  const sent = watchRequests(page);
  await dlg.locator("#frpAmount").fill("");
  await dlg.getByRole("button", { name: "Save payout" }).click();
  await expect(err).toHaveText("Enter the amount paid.");
  await dlg.locator("#frpAmount").fill("5");
  await dlg.locator("#frpDate").fill("");
  await dlg.getByRole("button", { name: "Save payout" }).click();
  await expect(err).toHaveText("Enter the date it was paid.");
  await dlg.locator("#frpDate").fill(todayYmd);
  await dlg.getByRole("button", { name: "Save payout" }).click();
  await expect(err).toHaveText("Choose the account it was paid from.");
  expect(sent.filter(s => s.action === "recordFundraiserPayout")).toHaveLength(0);
  // The server's: a day still to come.
  await dlg.locator("#frpAccount").selectOption({ label: accountA });
  await dlg.locator("#frpDate").fill("2099-01-15");
  let ans = answerOf(page, "recordFundraiserPayout");
  await dlg.getByRole("button", { name: "Save payout" }).click();
  expect((await ans).status()).toBe(400);
  await expect(err).toHaveText("The date can't be in the future");
  await expect(dlg.getByRole("button", { name: "Save payout" })).toBeEnabled();
  // Cancel closes it with nothing recorded.
  await dlg.getByRole("button", { name: "Cancel" }).click();
  await expect(dlg).toHaveCount(0);
  expect((await api("listFundraiserPayouts", { org: shop.orgId })).payouts).toEqual([]);

  // ---- $5.00 of the $7.50, from account A, with a note ----------------------------------------------------
  await report.shopRow(page).getByRole("button", { name: "Record payout…" }).click();
  await expect(dlg).toBeVisible();
  await dlg.locator("#frpAmount").fill("5");
  await dlg.locator("#frpAccount").selectOption({ label: accountA });
  await dlg.locator("#frpNote").fill(NOTE);
  ans = answerOf(page, "recordFundraiserPayout");
  const reloaded = answerOf(page, "getFundraisingReport");
  await dlg.getByRole("button", { name: "Save payout" }).click();
  const rec = await ans;
  expect(JSON.parse(rec.request().postData())).toMatchObject({ org: shop.orgId, amount: 5, date: todayYmd, note: NOTE });
  expect((await rec.json()).status).toBe("ok");
  await expect(dlg).toHaveCount(0);
  await expect(toast(page)).toContainText("Payout of $5.00 recorded for " + LABEL + ".");
  await reloaded;
  await report.drawn(page);
  // Paid out $5.00, still owed $2.50.
  expect((await cellsOf(report.shopRow(page))).slice(1)).toEqual(["2", "4", "$105.00", "$7.50", "$5.00", "$2.50", "Record payout…"]);
  expect(await cellsOf(report.total(page))).toEqual(["Total", "2", "4", "$105.00", "$7.50", "$5.00", "$2.50", ""]);
  await expect(page.locator("#frResults h3").nth(1)).toHaveText("Payouts to the group (1)");
  expect(await cellsOf(report.payoutRows(page))).toEqual([await shownDate(page, todayYmd), shop.name, "$5.00", accountA, `Fundraiser payout — ${LABEL} — ${NOTE}`]);
  await expect(page.locator("#frResults")).toContainText("Each payout is an expense in the Fundraiser payouts category — change or void one under Finance → Expenses.");
  await expect(page.locator("#frResults").getByRole("link", { name: "Finance → Expenses" })).toHaveAttribute("href", "#expenses");

  // A range after today: nothing sold or paid out in it, yet still owed is everything raised less everything paid out
  // up to its end — the $2.50 left, not the $7.50 raised.
  const later = [await page.evaluate(() => localToday_(1)), await page.evaluate(() => localToday_(30))];
  await page.locator("#frFrom").fill(later[0]);
  await page.locator("#frTo").fill(later[1]);
  await report.generate(page);
  expect((await cellsOf(report.shopRow(page))).slice(1)).toEqual(["—", "—", "—", "—", "—", "$2.50", "Record payout…"]);
  await expect(report.payoutRows(page)).toHaveText(["No payouts in this range."]);
  await expect(page.locator("#frResults > div").first()).toContainText(`Still owed is everything raised less everything paid out up to ${await shownDate(page, later[1])}, not only in this range.`);
  await page.locator("#frFrom").fill(await page.evaluate(() => adminYear_() + "-01-01"));
  await page.locator("#frTo").fill(await page.evaluate(() => reportToDay_()));
  await report.generate(page);

  // The next payout window remembers the account, and starts at what is still owed.
  await report.shopRow(page).getByRole("button", { name: "Record payout…" }).click();
  await expect(dlg.locator("#frpAmount")).toHaveValue("2.50");
  await expect(dlg.locator("#frpAccount option:checked")).toHaveText(accountA);
  await dlg.getByRole("button", { name: "Cancel" }).click();
  await expect(dlg).toHaveCount(0);

  // ---- Finance → Expenses lists it, in the built-in category, from account A ------------------------------
  await openAdmin(page, "expenses");
  const exp = page.locator("#expList tr", { hasText: NOTE });
  await expect(exp).toHaveCount(1);
  await expect(exp).toContainText(`Fundraiser payout — ${LABEL} — ${NOTE}`);
  await expect(exp).toContainText("Fundraiser payouts");
  await expect(exp).toContainText("$5.00");

  // ---- the audit log names both changes, on this shop ----------------------------------------------------
  await openAdmin(page, "audit");
  await page.locator("#afOrg").selectOption(shop.orgId);
  await page.locator("#afAction").fill("org.fundraiser_set");
  await page.getByRole("button", { name: "Search" }).click();
  const set = page.locator("#auditResults tr", { hasText: "Fundraiser set" });
  await expect(set).toHaveCount(1);
  await expect(set).toContainText("none → 10% of every purchase supports " + LABEL);
  await page.locator("#afAction").fill("fundraiser.payout_recorded");
  await page.getByRole("button", { name: "Search" }).click();
  const paid = page.locator("#auditResults tr", { hasText: "Fundraiser payout recorded" });
  await expect(paid).toHaveCount(1);
  await expect(paid).toContainText(`$5.00 to ${LABEL} · ${await shownDate(page, todayYmd)} — ${NOTE}`);
});

test("switching to $2 per piece: shown, then not shown on the shop; earlier orders keep what they raised, a new one raises per piece, and a cancelled or refunded line lowers it", async ({ page, api, as }) => {
  test.setTimeout(150_000);
  // ---- $2 per piece, shown on the shop -------------------------------------------------------------------
  await editShop(page);
  const f = fr(page);
  await f.mode.selectOption("perPiece");
  await f.amount.fill("2");
  await expect(f.preview).toHaveText("The shop shows: “$2.00 of every item supports " + LABEL + ".”");
  let saved = answerOf(page, "setOrgFundraiser");
  await saveShop(page);
  expect(await (await saved).json()).toEqual({ status: "ok", fundraiser: { mode: "perPiece", amount: 2, label: LABEL, showOnShop: true } });
  await expect(page).toHaveURL(/#catalog$/);
  await expect(await storefrontLine(as)).toHaveText("$2.00 of every item supports " + LABEL);

  // ---- …then not shown: the line goes, the fundraiser stays ------------------------------------------------
  await editShop(page);
  await expect(f.mode).toHaveValue("perPiece");
  await expect(f.amount).toHaveValue("2.00");
  await f.show.uncheck();
  await expect(f.preview).toHaveText("Not shown on the shop: $2.00 of every item supports " + LABEL + ".");
  saved = answerOf(page, "setOrgFundraiser");
  await saveShop(page);
  expect(await (await saved).json()).toEqual({ status: "ok", fundraiser: { mode: "perPiece", amount: 2, label: LABEL, showOnShop: false } });
  await expect(page).toHaveURL(/#catalog$/);
  const line = await storefrontLine(as);
  await expect(line).toHaveCount(0);
  const cat = await line.page().evaluate(async () => (await (await fetch("/api/catalog", { cache: "no-store" })).text()));
  expect(cat).not.toContain("supports " + LABEL);

  // ---- the earlier orders keep what they raised ------------------------------------------------------------
  await ordersPage(page);
  await expect(pillOf(page, webOrder.orderId)).toHaveText(raises("5.50"));
  await expect(pillOf(page, localOrder.orderId)).toHaveText(raises("2.00"));

  // ---- a new order: 2 tees and a cap = 3 pieces × $2 = $6.00 ------------------------------------------------
  const cp = await as(null);
  laterOrder = await placeOrder(cp, shop, { customer: uniq("Riley Later"), items: [{ name: "Sample Tee", qty: 2 }, { name: "Sample Cap", qty: 1 }] });
  expect(laterOrder.total).toBe("55.00");
  await ordersPage(page);
  await expect(pillOf(page, laterOrder.orderId)).toHaveText(raises("6.00"));
  await actionCell(page, laterOrder.orderId).getByRole("button", { name: "Mark as paid" }).click();
  await confirmOk(page);
  await expect(actionCell(page, laterOrder.orderId).getByRole("button", { name: "Mark as paid" })).toHaveCount(0);
  await deliver(api, laterOrder.orderId);

  await report.open(page);
  expect(await cellsOf(report.shopRow(page))).toEqual([shop.name + " Supports " + LABEL + " · an amount per piece", "3", "7", "$160.00", "$13.50", "$5.00", "$8.50", "Record payout…"]);
  expect((await cellsOf(report.orderRow(page, laterOrder.orderId))).slice(4)).toEqual(["3", "$55.00", "$6.00"]);
  expect((await cellsOf(report.orderRow(page, webOrder.orderId))).slice(4)).toEqual(["3", "$55.00", "$5.50"]);
  expect((await cellsOf(report.orderRow(page, localOrder.orderId))).slice(4)).toEqual(["1", "$50.00", "$2.00"]);

  // ---- the cap is cancelled: its $2.00 goes; $10 of the $40 tee line is refunded: a quarter of its $4.00 goes --
  const o = await orderOf(api, laterOrder.orderId);
  const cap = o.items.find(i => i.name === "Sample Cap"), tee = o.items.find(i => i.name === "Sample Tee");
  await api("cancelLineItem", { org: shop.orgId, sheetRow: cap.sheetRow, reason: "Out of stock" });
  await ordersPage(page);
  await expect(pillOf(page, laterOrder.orderId)).toHaveText(raises("4.00"));
  await api("setLineItemRefund", { org: shop.orgId, sheetRow: tee.sheetRow, refundAmount: 10, method: "cash" });
  await ordersPage(page);
  await expect(pillOf(page, laterOrder.orderId)).toHaveText(raises("3.00"));
  expect((await orderOf(api, laterOrder.orderId)).paid).toBeTruthy();

  await report.open(page);
  expect((await cellsOf(report.orderRow(page, laterOrder.orderId))).slice(4)).toEqual(["2", "$30.00", "$3.00"]);
  expect(await cellsOf(report.shopRow(page))).toEqual([shop.name + " Supports " + LABEL + " · an amount per piece", "3", "6", "$135.00", "$10.50", "$5.00", "$5.50", "Record payout…"]);
  expect(await cellsOf(report.total(page))).toEqual(["Total", "3", "6", "$135.00", "$10.50", "$5.00", "$5.50", ""]);
});
