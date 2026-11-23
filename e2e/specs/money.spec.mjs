// Money and reports: Home, Accounts & money, Expenses, the Revenue / Sales tax / Inventory & COGS reports,
// closing and reopening a month, and the accountant's export.
//
// Other specs place orders and record money at the same time on the same install, so nothing here reads an
// install-wide total as an exact number: each check is on this spec's own shop, account, order or expense,
// or is a difference that only grows.
import fs from "node:fs";
import { test, expect, openAdmin, waitIdle, toast, uniq, user } from "../fixtures.mjs";
import { makeShop, placeOrder } from "../lib/data.mjs";
import { freshAdmin } from "../lib/money.mjs";

test.describe.configure({ mode: "serial" });

const money = (text) => Number(String(text).replace(/[^0-9.\-]/g, "")) || 0;
const thisYear = new Date().getFullYear();
// The month this spec closes and reopens: last year's March. No other spec dates anything there, and closing
// the current month would refuse every other spec's payments.
const CLOSE_MONTH = (thisYear - 1) + "-03";

let shop, order, accountA, accountB, expenseDesc;

test("Home shows a new order under New, and under Paid once it is paid", async ({ page, api }) => {
  shop = await makeShop(api, { prefix: "money" });
  order = await placeOrder(page, shop);
  expect(order.total).toBe("20.00");

  await freshAdmin(page, "home");
  await expect(page.getByRole("heading", { name: "Dashboard", level: 2 })).toBeVisible();
  // The step cards link to each step's list.
  await page.getByRole("link", { name: /^New \d+ Waiting for payment/ }).click();
  await expect(page).toHaveURL(/#home\/new$/);
  await expect(page.getByRole("button", { name: "Open order " + order.orderId })).toBeVisible();

  // Paid (the order screens are another spec's subject; here the payment is recorded the way that screen does).
  await api("markPaidManual", { org: shop.orgId, orderId: order.orderId });
  await freshAdmin(page, "home");
  await page.getByRole("link", { name: /^Paid \d+ Blanks not ordered yet/ }).click();
  await expect(page).toHaveURL(/#home\/paid$/);
  const row = page.getByRole("row", { name: new RegExp(order.orderId) });
  await expect(row).toContainText("Paid");
  await expect(row).toContainText(shop.name);
  await freshAdmin(page, "home/new");
  await expect(page.getByRole("button", { name: "Open order " + order.orderId })).toHaveCount(0);
  // Clicking the order opens it in its shop's orders list.
  await freshAdmin(page, "home/paid");
  await page.getByRole("button", { name: "Open order " + order.orderId }).click();
  await expect(page).toHaveURL(new RegExp("#orders/" + shop.orgId));
  await expect(page.locator("#app")).toContainText(order.orderId);
});

test("Accounts & money: add two accounts, other income into one, and a transfer between them", async ({ page }) => {
  accountA = uniq("Test Savings");
  accountB = uniq("Test Till");
  await freshAdmin(page, "money");
  const newRow = page.locator("tr[data-acc=new]");
  for (const name of [accountA, accountB]) {
    await newRow.locator("[data-f=name]").fill(name);
    await newRow.locator("[data-f=type]").selectOption("cash");
    await newRow.getByRole("button", { name: "Add" }).click();
    await expect(toast(page)).toContainText("Account saved.");
    await expect(page.locator("tr[data-acc] [data-f=name]").and(page.locator(`[value="${name}"]`))).toHaveCount(1);
  }

  const income = page.locator(".mn-form[data-kind=income]");
  const incomeDesc = uniq("Digitizing for Example Club");
  await income.locator("[data-f=description]").fill(incomeDesc);
  await income.locator("[data-f=type]").selectOption({ label: "Services (Schedule C line 1)" });
  await income.locator("[data-f=amount]").fill("12.34");
  await income.locator("[data-f=accountId]").selectOption({ label: accountA });
  await income.getByRole("button", { name: "Add" }).click();
  await expect(toast(page)).toContainText("Saved.");
  await expect(page.getByRole("row", { name: new RegExp(incomeDesc) })).toContainText("$12.34");

  const transfer = page.locator(".mn-form[data-kind=transfer]");
  await transfer.locator("[data-f=fromAccountId]").selectOption({ label: accountA });
  await transfer.locator("[data-f=toAccountId]").selectOption({ label: accountB });
  await transfer.locator("[data-f=amount]").fill("5");
  await transfer.locator("[data-f=note]").fill("Float for the till");
  await transfer.getByRole("button", { name: "Add" }).click();
  await expect(toast(page)).toContainText("Saved.");

  // Balance today follows everything recorded since the opening date.
  const balance = (name) => page.locator("tr[data-acc]").filter({ has: page.locator(`[data-f=name][value="${name}"]`) }).locator("td").nth(4);
  await expect(balance(accountA)).toHaveText("$7.34");
  await expect(balance(accountB)).toHaveText("$5.00");
});

test("Expenses: add one; it is listed, takes money from its account, and Home's expenses grow by it", async ({ page }) => {
  // Home's month-to-date expenses before (other specs only ever add to it).
  await freshAdmin(page, "home");
  const expCard = page.locator(".home-card", { hasText: "Expenses · month to date" }).locator(".home-val");
  await expect(expCard).toBeVisible();
  const before = money(await expCard.textContent());

  expenseDesc = uniq("Stabilizer rolls from Test Supply Co");
  await freshAdmin(page, "expenses");
  await page.locator("#expDesc").fill(expenseDesc);
  await page.locator("#expCat").selectOption({ label: "Office expense" });
  await page.locator("#expAmount").fill("40");
  await page.locator("#expPaidFrom").selectOption({ label: accountA });
  await page.locator("#expSave").click();
  await expect(page.locator("#expFormErr")).toHaveText("");
  const row = page.locator("#expList tr", { hasText: expenseDesc });
  await expect(row).toContainText("$40.00");
  await expect(row).toContainText("Office expense");

  await freshAdmin(page, "money");
  const balance = page.locator("tr[data-acc]").filter({ has: page.locator(`[data-f=name][value="${accountA}"]`) }).locator("td").nth(4);
  await expect(balance).toHaveText("−$32.66");   // the page writes a true minus sign

  await freshAdmin(page, "home");
  await page.getByRole("button", { name: "↻ Refresh data" }).click();
  await waitIdle(page);
  await expect.poll(async () => money(await expCard.textContent())).toBeGreaterThanOrEqual(before + 40);
});

test("Revenue report: on a cash basis this spec's shop shows the payment received", async ({ page }) => {
  await freshAdmin(page, "revenue");
  await page.getByRole("button", { name: String(thisYear) }).click();
  await expect(page.locator("#revFrom")).toHaveValue(thisYear + "-01-01");
  await page.locator("#revBasis").selectOption("cash");
  await page.getByRole("button", { name: "Generate" }).click();
  const row = page.locator("#revResults tr", { hasText: shop.name });
  await expect(row).toContainText("$20.00");
  // A range with nothing in it (last year): the shop has no row with money.
  await page.locator("#revFrom").fill((thisYear - 1) + "-01-01");
  await page.locator("#revTo").fill((thisYear - 1) + "-12-31");
  await page.getByRole("button", { name: "Generate" }).click();
  await expect(page.locator("#revResults")).not.toContainText("$20.00", { timeout: 10_000 });
});

test("Sales tax report: quarter buttons set the range, and this year's exempt sales include this spec's order", async ({ page }) => {
  await freshAdmin(page, "salestax");
  await page.getByRole("button", { name: "Q1 " + thisYear }).click();
  await expect(page.locator("#taxFrom")).toHaveValue(thisYear + "-01-01");
  await expect(page.locator("#taxTo")).toHaveValue(thisYear + "-03-31");
  await page.getByRole("button", { name: String(thisYear), exact: true }).click();
  await page.getByRole("button", { name: "Generate" }).click();
  // The return's table (by month): the one with an Exempt shops column.
  const table = page.locator("#taxResults table").filter({ has: page.getByRole("columnheader", { name: "Exempt shops" }) });
  await expect(table).toBeVisible();
  // makeShop shops are tax-exempt: this spec's $20 order is in the Exempt shops column of the Total row.
  const total = table.getByRole("row").filter({ has: page.getByRole("cell", { name: "Total", exact: true }) }).last();
  const cells = (await total.getByRole("cell").allTextContents()).map(s => s.trim());
  const headers = (await table.getByRole("columnheader").allTextContents()).map(s => s.trim());
  expect(money(cells[headers.indexOf("Exempt shops")])).toBeGreaterThanOrEqual(20);
  expect(money(cells[headers.indexOf("Gross sales")])).toBeGreaterThanOrEqual(money(cells[headers.indexOf("Exempt shops")]));
});

test("Inventory & COGS report shows inventory by group, a roll-forward and its own check that it adds up", async ({ page }) => {
  await freshAdmin(page, "cogs");
  await page.getByRole("button", { name: String(thisYear - 1), exact: true }).click();
  await expect(page.locator("#cogsFrom")).toHaveValue((thisYear - 1) + "-01-01");
  await page.getByRole("button", { name: String(thisYear), exact: true }).click();
  await page.getByRole("button", { name: "Generate" }).click();
  const results = page.locator("#cogsResults");
  await expect(results.getByRole("heading", { name: "Inventory by group" })).toBeVisible();
  await expect(results.getByRole("heading", { name: /Roll-forward/ })).toBeVisible();
  for (const label of ["Beginning inventory", "+ Purchases", "− Cost of goods sold", "Ending inventory"]) {
    await expect(results.getByRole("row", { name: new RegExp("^" + label.replace(/[+]/g, "\\+")) }).first()).toBeVisible();
  }
  // The page checks the roll-forward itself and says so. Other specs receive, count and write off stock on the
  // same install at the same time, so whether it adds up is theirs to make true; this checks the check is shown
  // (the gap can be either sign: "Doesn't add up by −$0.40").
  await expect(results).toContainText(/Adds up\.|Doesn't add up by −?\$[\d.,]+/);
});

test("Periods & export: close last year's March, see it listed with who closed it, and reopen it", async ({ page, api }) => {
  // A run stopped half-way could have left it closed.
  const { periods } = await api("listClosedPeriods");
  if (periods.some(p => p.month === CLOSE_MONTH)) await api("reopenPeriod", { month: CLOSE_MONTH });

  await freshAdmin(page, "books");
  const monthLabel = new Date(CLOSE_MONTH + "-15T12:00:00Z").toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  await page.locator("#closeMonth").fill(CLOSE_MONTH);
  await page.locator("#closeMonthBtn").click();
  await expect(page.getByRole("dialog")).toContainText("Close " + monthLabel + "?");
  await page.locator("#cmOk").click();
  await expect(toast(page)).toContainText(monthLabel + " closed.");
  const row = page.locator("#periodsList tr", { hasText: monthLabel });
  await expect(row).toContainText("by " + user("owner").email);

  // A payment dated in a closed month is refused.
  const refused = await api("addPayment", { org: shop.orgId, orderId: order.orderId, amount: 1, method: "cash", date: CLOSE_MONTH + "-10" }, { allowError: true, withStatus: true });
  expect(refused.data.status).toBe("error");
  expect(refused.data.message).toMatch(/closed/i);

  await row.getByRole("button", { name: "Reopen" }).click();
  await page.locator("#cmOk").click();
  await expect(toast(page)).toContainText("Month reopened.");
  await expect(page.locator("#periodsList")).not.toContainText(monthLabel);
});

test("Periods & export: the accountant's Expenses CSV downloads with this spec's expense", async ({ page }) => {
  await freshAdmin(page, "books");
  await page.getByRole("button", { name: String(thisYear), exact: true }).click();
  await expect(page.locator("#expFrom")).toHaveValue(thisYear + "-01-01");
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Expenses", exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe(`odd-expenses-${thisYear}-01-01-to-${thisYear}-12-31.csv`);
  const csv = fs.readFileSync(await download.path(), "utf8");
  const lines = csv.trim().split(/\r?\n/);
  expect(lines[0]).toContain("Description");
  expect(lines[0]).toContain("Schedule C line");
  const mine = lines.find(l => l.includes(expenseDesc));
  expect(mine).toBeTruthy();
  // Neither the header nor this row has a quoted comma in it, so a plain split reads them.
  const head = lines[0].split(","), cols = mine.split(",");
  const col = (name) => cols[head.indexOf(name)];
  expect(Number(col("Amount"))).toBe(40);
  expect(col("Category")).toBe("Office expense");
  expect(col("Paid from")).toBe(accountA);
  await expect(page.locator("#expStatus")).toHaveText(/^Downloaded \d+ rows?\.$/);

  // The monthly summary too: a header row and one row per month.
  const downloading2 = page.waitForEvent("download");
  await page.getByRole("button", { name: "Monthly summary" }).click();
  const summary = fs.readFileSync(await (await downloading2).path(), "utf8").trim().split(/\r?\n/);
  expect(summary[0].split(",")[0]).toBe("Month");
  expect(summary.length).toBeGreaterThan(1);
});
