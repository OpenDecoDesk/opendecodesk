// Reports → Unpaid POs and Home's Unpaid POs block (migrations/0121; functions/_lib/db.js getUnpaidPoReport and
// getDashboard's unpaidPos part, functions/api/orders.js getUnpaidPoReport and acceptOrderPo, public/admin-receivables.js,
// public/admin.js homeUnpaidPos_ and the New tile). What's checked:
//
// - Home, after Refresh: the Unpaid POs block's four cards (orders still owed, owed, late, POs to check) and the New tile's
//   "· N POs to check" move by exactly the orders this spec made; the link opens the report.
// - The report as of a fixed day (2025-06-30), narrowed to this spec's own shop: the totals, the seven groups (No PO yet,
//   PO to check, Not yet due — due that very day included —, 1–30, 31–60, 61–90 and over 90 days late) with their counts
//   and money, the per-customer table (orders, owed, late), every row (PO, status, invoiced, due date and the order's own
//   Net N, days late, owed with "of $total" after a part payment), an order placed after the day left out until the day
//   moves, Today, a group's button narrowing the rows (and again, or Show every group, undoing it), a customer's button and
//   the Customer filter, the order and customer links, escaping, and the basis line for each terms start.
// - Accept PO inline: Back leaves it, an error answer is shown and the button comes back, Accept moves the row out of
//   PO to check (one audit entry, the order cleared for work).
// - Export CSV: the file's name, header and rows, for one group and for all; disabled when nothing is shown.
// - A payment that clears the balance drops the order off; the empty and switched-off messages; a load error; a slower,
//   older answer never replacing a newer one; the server's refusals of bad days, customers and shops.
// - Roles: Manager reads and accepts; Back office reads, accepts (orders.terms edit) and gets the Home counts without the
//   money; Read only reads without Accept PO and the server refuses it; Production has no menu item, no Home block and the
//   server refuses the report.
//
// Global settings → Payment methods (Net 30) and Net 30 terms are install-wide, so this spec is in ALONE
// (playwright.config.mjs) and puts both back in afterAll. Dates are fixed: orders are placed on given days (Local sales
// with placedAt) and the report is read "as of" a given day, so neither the machine's date nor its zone matters. Home's
// "late" uses the real today: every order here is placed in 2025, so all but the one invoiced today are late by then.
import fs from "node:fs";
import { test, expect, openAdmin, leaveAdmin, toast, uniq, slug, ADMIN, shopUrl, apiContext, callApi, freshIp } from "../fixtures.mjs";
import { makeShop } from "../lib/data.mjs";
import { request as playwrightRequest } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const AS_OF = "2025-06-30";
const D = {};   // the data every test reads: made in the first test
let savedPayments = null, savedTerms = null;

// ---- helpers ---------------------------------------------------------------------------------------------
const report = (page) => page.locator("#arPage");
const rowOf = (page, orderId) => report(page).locator("tr[data-ar-row]").filter({ has: page.locator(`[data-ar-open], .mono`).filter({ hasText: new RegExp("^" + orderId + "$") }) });
const groupBtn = (page, key) => report(page).locator(`#arGroups [data-ar-group="${key}"]`);
const answerOf = (page, action) => page.waitForResponse(r => r.url().endsWith("/api/orders") && r.request().method() === "POST" && (() => { try { return JSON.parse(r.request().postData() || "{}").action === action; } catch (e) { return false; } })());
const money = (n) => "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cellsOf = async (row) => (await row.locator(":scope > td").allInnerTexts()).map(t => t.replace(/\s+/g, " ").trim());
const confirmOk = async (page) => {
  const ok = page.locator(".confirm-modal #cmOk");
  await expect(ok).toBeVisible();
  await ok.click();
  await expect(page.locator(".confirm-modal")).toHaveCount(0);
};

// A Net 30 Local sale of the shop's tee (qty × $20), placed on `placedAt` (a day), with a staff PO (accepted at once) or none.
async function sale(api, shop, { qty = 1, placedAt, po, days, customerId, customerName }) {
  const r = await api("createLocalSale", { org: shop.orgId, items: [{ productId: shop.products[0].productId, size: "", qty }], paymentMethod: "",
    customerName: customerName || "Net 30 customer", ...(customerId ? { customerId } : {}), placedAt, net30: true,
    ...(po ? { poNumber: po } : {}), ...(days ? { termsDays: days } : {}) });
  expect(r.warning).toBeUndefined();
  return r.orderId;
}
// The customer types a PO on the invoice page's box (POST /api/invoice setInvoicePo), so it is "PO to check".
async function customerTypesPo(api, shop, orderId, poNumber, testInfo) {
  const sent = await api("sendInvoice", { orderId, org: shop.orgId, email: "pat@example.com", allowDelivery: false });
  const token = new URL(sent.url).searchParams.get("invoice");
  const ctx = await playwrightRequest.newContext({ baseURL: shopUrl(shop.subdomain), extraHTTPHeaders: { "CF-Connecting-IP": freshIp(testInfo.workerIndex) } });
  try {
    const res = await ctx.post("/api/invoice", { data: { token, action: "setInvoicePo", poNumber } });
    expect(res.status()).toBe(200);
  } finally { await ctx.dispose(); }
  return token;
}
// A user of `role`'s own API (signed-in cookie from the setup project), answers kept with their status.
async function asApi(role, workerIndex, fn) {
  const ctx = await apiContext(role, workerIndex);
  try { return await fn((action, body) => callApi(ctx, action, body, { allowError: true, withStatus: true })); }
  finally { await ctx.dispose(); }
}
// Opens the report as of `asOf`, narrowed to `orgId` (both optional), and waits for its answer.
async function openReport(page, { asOf = AS_OF, orgId } = {}) {
  await openAdmin(page, "unpaidpos");
  await expect(page.locator("#arPage")).toBeVisible();
  await expect(page).toHaveTitle(/Unpaid POs/);
  await expect(report(page).locator("#arBody")).not.toContainText("Loading…");
  if (asOf) await setAsOf(page, asOf);
  if (orgId) {
    const ans = answerOf(page, "getUnpaidPoReport");
    await report(page).getByLabel("Shop").selectOption(orgId);
    const body = JSON.parse((await ans).request().postData());
    expect(body).toMatchObject({ orgId, asOf: asOf || body.asOf });
    expect(body.customerId).toBeUndefined();
  }
}
async function setAsOf(page, day) {
  const ans = answerOf(page, "getUnpaidPoReport");
  await report(page).getByLabel("As of").fill(day);
  expect(JSON.parse((await ans).request().postData()).asOf).toBe(day);
  await expect(report(page).locator("#arBasis")).toContainText("As of " + (await page.evaluate((d) => adminDate_(d), day)) + ".");
}
const dashboard = async (api, today) => api("getDashboard", { today, fresh: true, blocks: ["orders", "unpaidpos"] });

test.afterAll(async () => {
  const ctx = await apiContext("owner");
  try {
    if (savedPayments) await callApi(ctx, "saveGlobalSettingsAll", { settings: { payments: savedPayments } });
    if (savedTerms) await callApi(ctx, "updateTermsSettings", { terms: savedTerms });
  } finally { await ctx.dispose(); }
});

// ---- The data, and Home ---------------------------------------------------------------------------------------
test("Home's Unpaid POs block and the New tile's POs to check follow the Net 30 orders made, after Refresh", async ({ page, api }, testInfo) => {
  savedPayments = ((await api("getGlobalSettings")).globalSettings || {}).enabledPayments || {};
  savedTerms = (await api("getTermsSettings")).terms;
  await api("saveGlobalSettingsAll", { settings: { payments: { ...savedPayments, net30: true } } });
  await api("updateTermsSettings", { terms: { defaultDays: 30, startsAt: "invoice" } });

  await openAdmin(page, "home");
  const today = await page.evaluate(() => localToday_());
  const before = await dashboard(api, today);
  expect(before.unpaidPos).toBeTruthy();

  const shop = D.shop = await makeShop(api, { prefix: "upo", products: [{ name: "Sample Tee", price: 20 }] });
  const tag = Date.now().toString(36).slice(-5);
  D.custA = { name: uniq("Pat Example"), company: "Example School District " + tag };
  D.custA.id = (await api("saveCustomer", { name: D.custA.name, company: D.custA.company, email: "pat." + tag + "@example.com" })).id;
  // A name with markup in it: shown as written, never as markup.
  D.custB = { name: "Example Club <b>Boosters</b> " + tag };
  D.custB.id = (await api("saveCustomer", { name: D.custB.name, email: "club." + tag + "@example.com" })).id;
  D.walkIn = uniq("Lane Walkin");
  const A = { customerId: D.custA.id }, B = { customerId: D.custB.id };
  const o = D.o = {};
  o.nopo = await sale(api, shop, { ...A, qty: 1, placedAt: "2025-06-01" });                                   // No PO yet, $20
  o.check = await sale(api, shop, { ...B, qty: 2, placedAt: "2025-06-02" });                                  // PO to check, $40
  o.notdue = await sale(api, shop, { ...A, qty: 3, placedAt: "2025-06-15", po: "PO-1003" });                  // due 07-15, $60
  o.today = await sale(api, shop, { ...A, qty: 1, placedAt: "2025-05-31", po: "PO-1004" });                   // due 06-30: not late, $20
  o.late11 = await sale(api, shop, { ...B, qty: 4, placedAt: "2025-05-20", po: "PO-1005" });                  // due 06-19: 11 late, $80
  o.net45 = await sale(api, shop, { ...A, qty: 1, placedAt: "2025-05-01", po: "PO-1006", days: 45 });         // due 06-15: 15 late, $20
  o.late41 = await sale(api, shop, { customerName: D.walkIn, qty: 5, placedAt: "2025-04-20", po: "PO-1007" }); // due 05-20: 41 late, $100
  o.late75 = await sale(api, shop, { ...B, qty: 2, placedAt: "2025-04-01", po: "PO-1008", days: 15 });        // due 04-16: 75 late, $40
  o.late110 = await sale(api, shop, { ...A, qty: 6, placedAt: "2025-02-10", po: "PO-1009" });                 // due 03-12: 110 late, $120
  o.future = await sale(api, shop, { ...A, qty: 1, placedAt: "2025-07-05", po: "PO-1010" });                  // after the day: left out
  o.payoff = await sale(api, shop, { ...B, qty: 1, placedAt: "2025-05-10", po: "PO-1011" });                  // due 06-09: 21 late, $20
  // A part payment: $70 of $100 still owed.
  await api("addPayment", { org: shop.orgId, orderId: o.late41, amount: 30, method: "cash" });
  // The customer types a plain number on the invoice page: shown as "PO 4471".
  D.token = await customerTypesPo(api, shop, o.check, "4471", testInfo);
  const checked = (await api("getOrders", { org: shop.orgId })).orders.find(x => x.orderId === o.check);
  expect(checked).toMatchObject({ net30: true, poNumber: "4471", poStatus: "PO to check" });
  D.invoicedAt = checked.invoicedAt;
  expect(D.invoicedAt).toBeTruthy();

  // Eleven orders owed, $510 in all; every one is late by today but the one invoiced today; one PO to check.
  const want = { count: before.unpaidPos.count + 11, owed: before.unpaidPos.owedCents / 100 + 510, late: before.unpaidPos.lateCents / 100 + 470,
    toCheck: before.unpaidPos.toCheck + 1 };
  const after = await dashboard(api, today);
  expect(after.unpaidPos).toEqual({ count: want.count, owedCents: Math.round(want.owed * 100), lateCents: Math.round(want.late * 100), toCheck: want.toCheck });
  expect(after.poToCheck).toBe(before.poToCheck + 1);
  expect(after.poNeeded).toBe(before.poNeeded + 1);

  // The page as it was loaded may show the hour-old figures: Refresh works them out again.
  await leaveAdmin(page);
  await openAdmin(page, "home");
  const refreshed = answerOf(page, "getDashboard");
  await page.getByRole("button", { name: "↻ Refresh data" }).click();
  const sent = JSON.parse((await refreshed).request().postData());
  expect(sent).toMatchObject({ fresh: true, today });
  expect(sent.blocks).toContain("unpaidpos");
  const block = page.locator('[data-home-block="unpaidpos"]');
  await expect(block.getByRole("heading", { name: "Unpaid POs" })).toBeVisible();
  const cards = block.locator(".home-po-card");
  await expect(cards).toHaveCount(4);
  await expect(cards.nth(0)).toHaveText(new RegExp("^\\s*Unpaid POs\\s*" + want.count + "\\s*Net 30 orders still owed\\s*$"));
  await expect(cards.nth(1)).toContainText("Owed" + money(want.owed) + "On Net 30 terms, all shops", { useInnerText: false });
  await expect(cards.nth(2)).toContainText("Late" + money(want.late) + "Past the due date", { useInnerText: false });
  await expect(cards.nth(2)).toHaveClass(/home-card-warn/);
  await expect(cards.nth(3)).toContainText("POs to check" + want.toCheck + "Typed by customers — accept each one", { useInnerText: false });
  await expect(cards.nth(3)).toHaveClass(/home-card-warn/);
  await expect(page.locator('#homeStages .home-tile[data-stage="new"] .home-hint'))
    .toHaveText("Waiting for payment · " + want.toCheck + " PO" + (want.toCheck === 1 ? "" : "s") + " to check");
  // The link opens the report.
  await block.getByRole("link", { name: "Unpaid POs report →" }).click();
  await expect(page).toHaveURL(/#unpaidpos$/);
  await expect(page.locator("#arPage")).toBeVisible();
  await expect(page).toHaveTitle(/Unpaid POs/);
  await expect(page).toHaveTitle(/Unpaid POs/);
});

// ---- The report -------------------------------------------------------------------------------------------------
test("The report as of a day: totals, the seven groups, by customer, and every row", async ({ page }) => {
  const o = D.o;
  await openReport(page, { orgId: D.shop.orgId });
  const totals = report(page).locator("#arTotals .gc-total");
  await expect(totals).toHaveCount(3);
  await expect(totals.nth(0)).toHaveText(money(510 - 20) + "Owed on Net 30" + "10 orders", { useInnerText: false });
  await expect(totals.nth(1)).toHaveText(money(350) + "Late" + "Past the due date", { useInnerText: false });
  await expect(totals.nth(1)).toHaveClass(/ar-total-warn/);
  await expect(totals.nth(2)).toHaveText("1" + "POs to check" + "Typed by the customer — accept each one", { useInnerText: false });

  const groups = [["nopo", "No PO yet", 1, 20], ["tocheck", "PO to check", 1, 40], ["notdue", "Not yet due", 2, 80], ["1-30", "1–30 days late", 3, 120],
    ["31-60", "31–60 days late", 1, 70], ["61-90", "61–90 days late", 1, 40], ["90+", "Over 90 days late", 1, 120]];
  await expect(report(page).locator("#arGroups [data-ar-group]")).toHaveCount(7);
  for (const [key, label, n, owed] of groups) {
    const b = groupBtn(page, key);
    await expect(b).toHaveText(label + n + money(owed), { useInnerText: false });
    await expect(b).toHaveAttribute("aria-pressed", "false");
    await expect(b).not.toHaveClass(/ar-group-zero/);
  }

  // By customer: most owed first.
  const custRows = report(page).locator("table.ar-customers tbody tr");
  await expect(custRows).toHaveCount(3);
  expect(await cellsOf(custRows.nth(0))).toEqual([D.custA.name, "5", money(240), money(140)]);
  expect(await cellsOf(custRows.nth(1))).toEqual([D.custB.name, "4", money(180), money(140)]);
  expect(await cellsOf(custRows.nth(2))).toEqual([D.walkIn, "1", money(70), money(70)]);
  await expect(custRows.nth(1).locator("b")).toHaveCount(0);   // the markup in the name is text

  // The rows: by group, the latest first within one.
  const rows = report(page).locator("table.ar-rows tbody tr");
  await expect(report(page).locator(".cust-h-row h3")).toHaveText("Orders (10)");
  const ids = await rows.locator("td:first-child [data-ar-open]").allInnerTexts();
  expect(ids).toEqual([o.nopo, o.check, o.today, o.notdue, o.payoff, o.net45, o.late11, o.late41, o.late75, o.late110]);
  await expect(rowOf(page, o.future)).toHaveCount(0);
  const day = (iso) => page.evaluate((v) => adminDate_(adminDay_(v)), iso);
  const date = (ymd) => page.evaluate((v) => adminDate_(v), ymd);
  const sub = async (placed) => D.shop.name + " · placed " + await day((await rowPlacedAt(page, placed)));
  // Order, customer (company under it), PO, status, invoiced, due (Net N), days late, owed, Accept PO.
  expect(await cellsOf(rowOf(page, o.nopo))).toEqual([o.nopo + " " + await sub(o.nopo), D.custA.name + " " + D.custA.company, "—", "PO needed",
    "Not sent", await date("2025-07-01") + " Net 30", "—", money(20), ""]);
  expect((await cellsOf(rowOf(page, o.check))).slice(0, 8)).toEqual([o.check + " " + await sub(o.check), D.custB.name, "PO 4471", "PO to check",
    await day(D.invoicedAt), await date(await page.evaluate(([v]) => addDays_(adminDay_(v), 30), [D.invoicedAt])) + " Net 30", "—", money(40)]);
  await expect(rowOf(page, o.check).locator("td").nth(8).getByRole("button", { name: "Accept PO" })).toBeVisible();
  expect(await cellsOf(rowOf(page, o.notdue))).toEqual([o.notdue + " " + await sub(o.notdue), D.custA.name + " " + D.custA.company, "PO-1003", "PO accepted",
    "Not sent", await date("2025-07-15") + " Net 30", "—", money(60), ""]);
  expect((await cellsOf(rowOf(page, o.today))).slice(2, 8)).toEqual(["PO-1004", "PO accepted", "Not sent", await date("2025-06-30") + " Net 30", "—", money(20)]);
  expect((await cellsOf(rowOf(page, o.net45))).slice(2, 8)).toEqual(["PO-1006", "Late", "Not sent", await date("2025-06-15") + " Net 45", "15", money(20)]);
  expect((await cellsOf(rowOf(page, o.late11))).slice(2, 8)).toEqual(["PO-1005", "Late", "Not sent", await date("2025-06-19") + " Net 30", "11", money(80)]);
  expect(await cellsOf(rowOf(page, o.late41))).toEqual([o.late41 + " " + await sub(o.late41), D.walkIn, "PO-1007", "Late", "Not sent",
    await date("2025-05-20") + " Net 30", "41", money(70) + " of " + money(100), ""]);
  expect((await cellsOf(rowOf(page, o.late75))).slice(5, 8)).toEqual([await date("2025-04-16") + " Net 15", "75", money(40)]);
  expect((await cellsOf(rowOf(page, o.late110))).slice(5, 8)).toEqual([await date("2025-03-12") + " Net 30", "110", money(120)]);
  await expect(rowOf(page, o.late110).locator("td.ar-late")).toHaveCount(1);
  await expect(rowOf(page, o.today).locator("td.ar-late")).toHaveCount(0);
  await expect(report(page).locator("[data-ar-accept]")).toHaveCount(1);
  await expect(report(page).locator("#arCsv")).toBeEnabled();
  await expect(report(page).locator("#arBasis")).toContainText("Due dates count from the day the invoice was first sent (the order date when no invoice was sent), plus the order's terms");
  await expect(report(page).locator("#arBasis").getByRole("link", { name: "Global settings → Net 30 terms" })).toHaveAttribute("href", "#settings");

  // A later day takes in the order placed after the first one, and moves the others on.
  await setAsOf(page, "2025-07-31");
  await expect(report(page).locator(".cust-h-row h3")).toHaveText("Orders (11)");
  await expect(rowOf(page, D.o.future)).toHaveCount(1);
  await expect(groupBtn(page, "notdue")).toHaveText("Not yet due" + "1" + money(20), { useInnerText: false });   // only the new one
  expect((await cellsOf(rowOf(page, o.nopo))).slice(5, 7)).toEqual([await date("2025-07-01") + " Net 30", "30"]);
  // Today: the business's today in the box and the question.
  const ans = answerOf(page, "getUnpaidPoReport");
  await report(page).getByRole("button", { name: "Today", exact: true }).click();
  const today = await page.evaluate(() => localToday_());
  expect(JSON.parse((await ans).request().postData()).asOf).toBe(today);
  await expect(report(page).getByLabel("As of")).toHaveValue(today);
});
// The placedAt of one of the spec's orders (as the server keeps it).
async function rowPlacedAt(page, orderId) {
  return page.evaluate(async ([org, id]) => (await adminApi_({ action: "getOrders", org })).orders.find(x => x.orderId === id).placedAt, [D.shop.orgId, orderId]);
}

test("A group's button narrows the rows; a customer's button and the Customer filter narrow to one; the links open the order and the customer", async ({ page }) => {
  const o = D.o;
  await openReport(page, { orgId: D.shop.orgId });
  const rows = report(page).locator("table.ar-rows tbody tr");
  await groupBtn(page, "1-30").click();
  await expect(groupBtn(page, "1-30")).toHaveAttribute("aria-pressed", "true");
  await expect(groupBtn(page, "1-30")).toHaveClass(/\bon\b/);
  await expect(report(page).locator(".cust-h-row h3")).toHaveText("Orders — 1–30 days late (3)");
  await expect(rows).toHaveCount(3);
  // Accept PO is only on a PO to check row: none of these.
  await expect(report(page).locator("[data-ar-accept]")).toHaveCount(0);
  // Pressing it again shows every group.
  await groupBtn(page, "1-30").click();
  await expect(groupBtn(page, "1-30")).toHaveAttribute("aria-pressed", "false");
  await expect(rows).toHaveCount(10);
  // …and so does Show every group.
  await groupBtn(page, "90+").click();
  await expect(rows).toHaveCount(1);
  await report(page).getByRole("button", { name: "Show every group" }).click();
  await expect(rows).toHaveCount(10);
  await expect(report(page).getByRole("button", { name: "Show every group" })).toHaveCount(0);

  // A customer's name in the table narrows the report to them (the server is asked for just that customer).
  let ans = answerOf(page, "getUnpaidPoReport");
  await report(page).locator("table.ar-customers").getByRole("button", { name: D.custB.name }).click();
  expect(JSON.parse((await ans).request().postData())).toMatchObject({ customerId: D.custB.id, orgId: D.shop.orgId });
  await expect(report(page).getByLabel("Customer")).toHaveValue(String(D.custB.id));
  await expect(report(page).locator("table.ar-customers")).toHaveCount(0);   // one customer, chosen: no table
  await expect(rows).toHaveCount(4);
  await expect(report(page).locator("#arTotals .gc-total").nth(0)).toContainText(money(180));
  // The Customer list still holds everyone owing (from the answer for every customer).
  await expect(report(page).getByLabel("Customer").locator("option")).toHaveText(["All customers", D.custA.name, D.custB.name]);   // the walk-in has no record to pick
  // Back to all customers, then one picked from the list.
  ans = answerOf(page, "getUnpaidPoReport");
  await report(page).getByLabel("Customer").selectOption("");
  expect(JSON.parse((await ans).request().postData()).customerId).toBeUndefined();
  await expect(rows).toHaveCount(10);
  ans = answerOf(page, "getUnpaidPoReport");
  await report(page).getByLabel("Customer").selectOption(String(D.custA.id));
  await ans;
  await expect(rows).toHaveCount(5);

  // The customer's name opens their page.
  await rowOf(page, o.notdue).getByRole("link", { name: D.custA.name }).click();
  await expect(page).toHaveURL(new RegExp("#customers/" + D.custA.id + "$"));
  // An order number opens the order in its shop's orders.
  await openReport(page, { orgId: D.shop.orgId });
  await rowOf(page, o.late75).getByRole("button", { name: o.late75 }).click();
  await expect(page).toHaveURL(new RegExp("#orders/" + D.shop.orgId));
  await expect(page.locator(`tr[data-order="${o.late75}"]`).first()).toBeVisible();
});

test("Accept PO inline: Back leaves it, a refusal is shown, and Accept moves the order out of PO to check", async ({ page, api }) => {
  const o = D.o;
  await openReport(page, { orgId: D.shop.orgId });
  const btn = rowOf(page, o.check).getByRole("button", { name: "Accept PO" });
  // Back: nothing is sent.
  let asked = 0;
  const count = (r) => { try { if (JSON.parse(r.postData() || "{}").action === "acceptOrderPo") asked++; } catch (e) {} };
  page.on("request", count);
  await btn.click();
  const dlg = page.locator(".confirm-modal");
  await expect(dlg).toContainText("Accept PO 4471 for order " + o.check + "?");
  await expect(dlg).toContainText("The money stays owed until it's paid, and the order stays on this report until then.");
  await expect(dlg.locator("#cmOk")).toHaveText("Accept PO");
  await dlg.locator("#cmCancel").click();
  await expect(dlg).toHaveCount(0);
  expect(asked).toBe(0);

  // A refusal: the server's words in a toast, and the button can be pressed again.
  await page.route("**/api/orders", async (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    if (body.action !== "acceptOrderPo") return route.continue();
    await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ status: "error", message: "There's no PO number to accept yet." }) });
  });
  await btn.click();
  await confirmOk(page);
  await expect(toast(page)).toContainText("Couldn't accept the PO: There's no PO number to accept yet.");
  await expect(btn).toBeEnabled();
  await page.unroute("**/api/orders");
  expect((await api("getOrders", { org: D.shop.orgId })).orders.find(x => x.orderId === o.check).poStatus).toBe("PO to check");

  // Accept: sent with the order and its shop; the report is asked again and the row has moved.
  const sent = answerOf(page, "acceptOrderPo");
  const reload = answerOf(page, "getUnpaidPoReport");
  await btn.click();
  await confirmOk(page);
  expect(JSON.parse((await sent).request().postData())).toMatchObject({ orderId: o.check, org: D.shop.orgId });
  await reload;
  page.off("request", count);
  await expect(toast(page)).toContainText("PO 4471 accepted for order " + o.check + ".");
  await expect(groupBtn(page, "tocheck")).toHaveText("PO to check" + "0" + money(0), { useInnerText: false });
  await expect(groupBtn(page, "tocheck")).toHaveClass(/ar-group-zero/);
  await expect(groupBtn(page, "notdue")).toHaveText("Not yet due" + "3" + money(120), { useInnerText: false });
  expect((await cellsOf(rowOf(page, o.check))).slice(2, 4)).toEqual(["PO 4471", "PO accepted"]);
  await expect(report(page).locator("[data-ar-accept]")).toHaveCount(0);
  const totals = report(page).locator("#arTotals .gc-total");
  await expect(totals.nth(2)).toHaveText("0" + "POs to check" + "None waiting", { useInnerText: false });
  await expect(totals.nth(2)).not.toHaveClass(/ar-total-warn/);
  const order = (await api("getOrders", { org: D.shop.orgId })).orders.find(x => x.orderId === o.check);
  expect(order).toMatchObject({ poStatus: "accepted", paid: false });
  expect(order.poAcceptedAt).toBeTruthy();
  const { entries } = await api("getAuditLog", { orderId: o.check, filter: "order.po_accepted", limit: 20 });
  expect(entries.filter(e => e.action === "order.po_accepted")).toHaveLength(1);
  // Accepting it again changes nothing (no second audit entry).
  const again = await api("acceptOrderPo", { orderId: o.check, org: D.shop.orgId });
  expect(again.poStatus).toBe("accepted");
  expect((await api("getAuditLog", { orderId: o.check, filter: "order.po_accepted", limit: 20 })).entries.filter(e => e.action === "order.po_accepted")).toHaveLength(1);
});

test("Export CSV downloads the rows shown: one group, then all", async ({ page }) => {
  const o = D.o;
  await openReport(page, { orgId: D.shop.orgId });
  await groupBtn(page, "1-30").click();
  let dl = page.waitForEvent("download");
  await report(page).getByRole("button", { name: "Export CSV" }).click();
  let file = await dl;
  expect(file.suggestedFilename()).toBe(`unpaid-pos-${AS_OF}-${D.shop.orgId}.csv`);
  let csv = fs.readFileSync(await file.path(), "utf8").split("\r\n").filter(Boolean);
  expect(csv[0]).toBe("Order #,Shop,Customer,Company,PO number,PO status,Group,Placed,Invoiced,Completed,Terms (days),Due,Days late,Total,Received,Owed");
  const placed = async (id) => page.evaluate((v) => adminDay_(v), await rowPlacedAt(page, id));
  expect(csv.slice(1)).toEqual([
    `${o.payoff},${D.shop.name},${D.custB.name},,PO-1011,accepted,1–30 days late,${await placed(o.payoff)},,,30,2025-06-09,21,20,0,20`,
    `${o.net45},${D.shop.name},${D.custA.name},${D.custA.company},PO-1006,accepted,1–30 days late,${await placed(o.net45)},,,45,2025-06-15,15,20,0,20`,
    `${o.late11},${D.shop.name},${D.custB.name},,PO-1005,accepted,1–30 days late,${await placed(o.late11)},,,30,2025-06-19,11,80,0,80`,
  ]);
  // Every group: all ten, the part-paid one with what was received.
  await groupBtn(page, "1-30").click();
  dl = page.waitForEvent("download");
  await report(page).getByRole("button", { name: "Export CSV" }).click();
  file = await dl;
  csv = fs.readFileSync(await file.path(), "utf8").split("\r\n").filter(Boolean);
  expect(csv).toHaveLength(11);
  expect(csv.find(l => l.startsWith(o.late41 + ","))).toBe(`${o.late41},${D.shop.name},${D.walkIn},,PO-1007,accepted,31–60 days late,${await placed(o.late41)},,,30,2025-05-20,41,100,30,70`);
  expect(csv.find(l => l.startsWith(o.nopo + ","))).toBe(`${o.nopo},${D.shop.name},${D.custA.name},${D.custA.company},,PO needed,No PO yet,${await placed(o.nopo)},,,30,2025-07-01,0,20,0,20`);
  expect(csv.find(l => l.startsWith(o.check + ","))).toMatch(new RegExp("^" + o.check + ",.*,4471,accepted,Not yet due,"));
});

test("A payment that clears the balance drops the order off the report", async ({ page, api }) => {
  const o = D.o;
  await openReport(page, { orgId: D.shop.orgId });
  await expect(rowOf(page, o.payoff)).toHaveCount(1);
  await api("addPayment", { org: D.shop.orgId, orderId: o.payoff, amount: 20, method: "check" });
  const paid = (await api("getOrders", { org: D.shop.orgId })).orders.find(x => x.orderId === o.payoff);
  expect(paid.paid).toBe(true);
  await openReport(page, { orgId: D.shop.orgId });
  await expect(rowOf(page, o.payoff)).toHaveCount(0);
  await expect(report(page).locator(".cust-h-row h3")).toHaveText("Orders (9)");
  await expect(groupBtn(page, "1-30")).toHaveText("1–30 days late" + "2" + money(100), { useInnerText: false });
  await expect(report(page).locator("#arTotals .gc-total").nth(0)).toHaveText(money(470) + "Owed on Net 30" + "9 orders", { useInnerText: false });
  const custRows = report(page).locator("table.ar-customers tbody tr");
  expect(await cellsOf(custRows.nth(1))).toEqual([D.custB.name, "3", money(160), money(120)]);
  // A part payment leaves it on, with what's left.
  await api("addPayment", { org: D.shop.orgId, orderId: o.late110, amount: 100, method: "check" });
  await openReport(page, { orgId: D.shop.orgId });
  expect((await cellsOf(rowOf(page, o.late110))).slice(7, 8)).toEqual([money(20) + " of " + money(120)]);
  await expect(groupBtn(page, "90+")).toHaveText("Over 90 days late" + "1" + money(20), { useInnerText: false });
});

// ---- Empty, off, other starts, errors -----------------------------------------------------------------------------
test("Empty and switched-off messages, and the basis line for each terms start", async ({ page, api }) => {
  // A day before any order: nothing owed anywhere; every group at zero; nothing to export.
  await openReport(page, { asOf: "2000-01-01" });
  await expect(report(page).locator(".ar-empty")).toHaveText("No Net 30 order has money owed. Everything on terms is paid.");
  await expect(report(page).locator("#arGroups .ar-group-zero")).toHaveCount(7);
  await expect(report(page).locator("#arCsv")).toBeDisabled();
  await expect(report(page).locator("#arTotals .gc-total").nth(1)).toHaveText(money(0) + "Late" + "Nothing past its due date", { useInnerText: false });
  // A shop with nothing on terms.
  const empty = await makeShop(api, { prefix: "upoe", products: [{ name: "Sample Tee", price: 20 }] });
  await openReport(page, { orgId: empty.orgId });
  await expect(report(page).locator(".ar-empty")).toHaveText("No unpaid Net 30 order for this shop or customer.");
  // Net 30 switched off: the page says so and where to turn it on.
  await api("saveGlobalSettingsAll", { settings: { payments: { ...savedPayments, net30: false } } });
  try {
    await openReport(page, { orgId: empty.orgId });
    await expect(report(page).locator(".ar-empty")).toContainText("Net 30 is switched off, and no order is on Net 30 terms. Turn it on under Global settings → Payment methods (“Net 30 (with a PO)”).");
    await expect(report(page).locator(".ar-empty").getByRole("link", { name: "Global settings → Payment methods" })).toHaveAttribute("href", "#settings");
    // …while orders already on terms are still listed.
    await openReport(page, { orgId: D.shop.orgId });
    await expect(report(page).locator(".cust-h-row h3")).toHaveText("Orders (9)");
  } finally {
    await api("saveGlobalSettingsAll", { settings: { payments: { ...savedPayments, net30: true } } });
  }

  // Terms start when the order is completed: nothing here is completed, so nothing is due yet.
  await api("updateTermsSettings", { terms: { defaultDays: 30, startsAt: "completed" } });
  try {
    await openReport(page, { orgId: D.shop.orgId });
    await expect(report(page).locator("#arBasis")).toContainText("Due dates count from the day the order was completed — shipped or picked up (not due until then), plus");
    expect((await cellsOf(rowOf(page, D.o.late110))).slice(5, 7)).toEqual(["When completed Net 30", "—"]);
    await expect(groupBtn(page, "notdue")).toHaveText("Not yet due" + "8" + money(350), { useInnerText: false });
    await expect(report(page).locator("#arTotals .gc-total").nth(1)).toHaveText(money(0) + "Late" + "Nothing past its due date", { useInnerText: false });
    // From the order date: the invoiced one counts from when it was placed.
    await api("updateTermsSettings", { terms: { defaultDays: 30, startsAt: "order" } });
    await openReport(page, { orgId: D.shop.orgId });
    await expect(report(page).locator("#arBasis")).toContainText("Due dates count from the order date, plus");
    expect((await cellsOf(rowOf(page, D.o.check))).slice(5, 6)).toEqual([await page.evaluate(() => adminDate_("2025-07-02")) + " Net 30"]);
  } finally {
    await api("updateTermsSettings", { terms: { defaultDays: 30, startsAt: "invoice" } });
  }
});

test("A failed load shows its error; a slower, older answer never replaces a newer one", async ({ page }) => {
  // The first ask (today) is held back until the second (the fixed day) has been drawn.
  let release;
  const held = new Promise(r => { release = r; });
  let first = true;
  await page.route("**/api/orders", async (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    if (body.action !== "getUnpaidPoReport") return route.continue();
    if (first && body.asOf !== AS_OF) { first = false; await held; return route.continue(); }
    return route.continue();
  });
  await page.goto(ADMIN + "/#unpaidpos");
  await expect(report(page).locator("#arBody")).toContainText("Loading…");
  await report(page).getByLabel("Shop").selectOption(D.shop.orgId);   // a second ask, answered at once
  await report(page).getByLabel("As of").fill(AS_OF);                  // and a third
  await expect(report(page).locator(".cust-h-row h3")).toHaveText("Orders (9)");
  const stale = page.waitForResponse(r => r.url().endsWith("/api/orders") && JSON.parse(r.request().postData() || "{}").action === "getUnpaidPoReport" && JSON.parse(r.request().postData()).asOf !== AS_OF);
  release();
  await stale;
  await page.waitForTimeout(300);
  await expect(report(page).locator(".cust-h-row h3")).toHaveText("Orders (9)");
  await expect(report(page).getByLabel("As of")).toHaveValue(AS_OF);
  await page.unroute("**/api/orders");

  // An error answer: the server's words, the totals and groups emptied.
  await openReport(page, { orgId: D.shop.orgId });
  await page.route("**/api/orders", async (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    if (body.action !== "getUnpaidPoReport") return route.continue();
    await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ status: "error", message: "Invalid date — expected YYYY-MM-DD" }) });
  });
  await report(page).getByLabel("As of").fill("2025-06-29");
  await expect(report(page).locator("#arBody [role=alert]")).toHaveText("Invalid date — expected YYYY-MM-DD");
  await expect(report(page).locator("#arTotals")).toBeEmpty();
  await expect(report(page).locator("#arGroups")).toBeEmpty();
  await expect(report(page).locator("#arCsv")).toBeDisabled();
  await page.unroute("**/api/orders");
});

test("The server refuses a bad day, customer or shop", async ({ api }) => {
  let r = await api("getUnpaidPoReport", { asOf: "30/06/2025" }, { allowError: true, withStatus: true });
  expect(r).toEqual({ status: 400, data: { status: "error", message: "Invalid date — expected YYYY-MM-DD" } });
  r = await api("getUnpaidPoReport", { asOf: AS_OF, customerId: "x" }, { allowError: true, withStatus: true });
  expect(r).toEqual({ status: 400, data: { status: "error", message: "That customer isn't valid. Pick one from the list." } });
  r = await api("getUnpaidPoReport", { asOf: AS_OF, orgId: slug("nosuchshop") }, { allowError: true, withStatus: true });
  expect(r.status).toBeGreaterThanOrEqual(400);
  expect(r.data.status).toBe("error");
  // `org` works like `orgId`, and the answer says what it was narrowed to.
  const ok = await api("getUnpaidPoReport", { asOf: AS_OF, org: D.shop.orgId, customerId: D.custA.id });
  expect(ok).toMatchObject({ status: "ok", asOf: AS_OF, orgId: D.shop.orgId, customerId: D.custA.id, net30On: true, startsAt: "invoice", defaultDays: 30 });
  expect(ok.rows.map(x => x.orderId).sort()).toEqual([D.o.nopo, D.o.notdue, D.o.today, D.o.net45, D.o.late110].sort());
  expect(ok.totals).toEqual({ count: 5, owedCents: 14000, lateCents: 4000, toCheck: 0 });
});

// ---- Roles --------------------------------------------------------------------------------------------------------
test("Manager reads the report and accepts a PO", async ({ api, as }, testInfo) => {
  const id = await sale(api, D.shop, { customerId: D.custB.id, qty: 1, placedAt: "2025-06-20" });
  await customerTypesPo(api, D.shop, id, "PO-2001", testInfo);
  const page = await as("manager");
  await page.goto(ADMIN + "/#home");
  await expect(page.locator('[data-home-block="unpaidpos"] .home-po-card')).toHaveCount(4);
  await openReport(page, { orgId: D.shop.orgId });
  await rowOf(page, id).getByRole("button", { name: "Accept PO" }).click();
  await confirmOk(page);
  await expect(toast(page)).toContainText("PO-2001 accepted for order " + id + ".");
  expect((await api("getOrders", { org: D.shop.orgId })).orders.find(x => x.orderId === id).poStatus).toBe("accepted");
});

test("Back office reads the report and may accept; its Home has the counts without the money", async ({ api, as }, testInfo) => {
  const id = await sale(api, D.shop, { customerId: D.custA.id, qty: 1, placedAt: "2025-06-21" });
  await customerTypesPo(api, D.shop, id, "PO-2002", testInfo);
  const page = await as("staff");
  await page.goto(ADMIN + "/#home");
  const block = page.locator('[data-home-block="unpaidpos"]');
  await expect(block.locator(".home-po-card")).toHaveCount(2);
  await expect(block.locator(".home-po-card").nth(0)).toContainText("Unpaid POs");
  await expect(block.locator(".home-po-card").nth(1)).toContainText("POs to check");
  await expect(block).not.toContainText("Owed");
  const d = await asApi("staff", testInfo.workerIndex, (call) => call("getDashboard", { today: AS_OF, fresh: true }));
  expect(d.status).toBe(200);
  expect(Object.keys(d.data.unpaidPos).sort()).toEqual(["count", "toCheck"]);
  await openReport(page, { orgId: D.shop.orgId });
  await expect(report(page).locator("table.ar-rows thead th")).toHaveCount(9);
  await rowOf(page, id).getByRole("button", { name: "Accept PO" }).click();
  await confirmOk(page);
  await expect(toast(page)).toContainText("PO-2002 accepted for order " + id + ".");
});

test("Read only reads the report without Accept PO, and the server refuses it", async ({ api, as }, testInfo) => {
  const id = await sale(api, D.shop, { customerId: D.custA.id, qty: 1, placedAt: "2025-06-22" });
  await customerTypesPo(api, D.shop, id, "PO-2003", testInfo);
  const page = await as("viewer");
  await openReport(page, { orgId: D.shop.orgId });
  await expect(rowOf(page, id)).toHaveCount(1);
  expect((await cellsOf(rowOf(page, id))).slice(2, 4)).toEqual(["PO-2003", "PO to check"]);
  await expect(report(page).locator("table.ar-rows thead th")).toHaveCount(8);
  await expect(report(page).getByRole("button", { name: "Accept PO" })).toHaveCount(0);
  const r = await asApi("viewer", testInfo.workerIndex, (call) => call("acceptOrderPo", { orderId: id, org: D.shop.orgId }));
  expect(r.status).toBe(403);
  expect(r.data.status).toBe("error");
  const rep = await asApi("viewer", testInfo.workerIndex, (call) => call("getUnpaidPoReport", { asOf: AS_OF, orgId: D.shop.orgId }));
  expect(rep.status).toBe(200);
  expect((await api("getOrders", { org: D.shop.orgId })).orders.find(x => x.orderId === id).poStatus).toBe("PO to check");
});

test("Production has no Unpaid POs menu item or Home block, and the server refuses the report", async ({ as }, testInfo) => {
  const page = await as("production");
  await page.goto(ADMIN + "/#home");
  const nav = page.getByRole("navigation", { name: "Admin" });
  await expect(nav).toBeVisible();
  await expect(page.locator('#homeStages .home-tile[data-stage="new"]')).toBeVisible();
  await expect(nav.getByRole("button", { name: "Unpaid POs", exact: true })).toHaveCount(0);
  await expect(page.locator('[data-home-block="unpaidpos"]')).toHaveCount(0);
  for (const [action, body] of [["getUnpaidPoReport", { asOf: AS_OF }], ["acceptOrderPo", { orderId: D.o.nopo, org: D.shop.orgId }]]) {
    const r = await asApi("production", testInfo.workerIndex, (call) => call(action, body));
    expect(r.status, action).toBe(403);
    expect(r.data.status).toBe("error");
  }
  // Going to the address itself shows no report.
  await page.goto(ADMIN + "/#unpaidpos");
  await expect(nav).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page.locator("#arPage")).toHaveCount(0);
});
