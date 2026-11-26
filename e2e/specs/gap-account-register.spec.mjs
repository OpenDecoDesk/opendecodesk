// Reconcile: importing a statement CSV and Create… on its lines — the account register's forms (coverage gap: admin.js
// rcImportPreview_, rcCreateModal_, rcDepositForm_, rcRefundForm_ — never opened by an end-to-end test before).
//
// - The statement CSV through the page: one signed amount column with US dates and an unreadable row, and a bank's
//   separate withdrawal / deposit columns; the column choices it works out, the preview, the import, the same file
//   again (nothing twice), and a line matched automatically to the purchase already in the books.
// - A deposit mapped to the orders' cash payments it covers: one payment whole and part of another, then the rest
//   of that one with a short deposit whose difference is recorded as an expense. The "covers" checks the user sees
//   (more than a payment has left, nothing ticked, short of the deposit), the line moving to Matched, the book
//   balance going up, and the server's list of payments still waiting to be deposited.
// - A refund of an expense, linked to the purchase it refunds (and the tax-year warning for an older purchase); a
//   second refund that would be more than what's left of that purchase is refused, and one with no category can't
//   be sent.
// - A card charge recorded as a blank purchase: it must add up to the line, and the blanks go into stock.
// - Other kinds (owner money, a transfer, a business expense that needs a category), and a closed month: Create… on
//   a line dated in it is refused until the month is reopened.
//
// Each test makes its own accounts (opening 2020-01-01), shop, orders, blank and statement lines, with unique names,
// so only its own rows are read — except the deposit form's payment list, which is every shop's: only this file's
// payments are ever sent. The lines are dated in last year's August (the refund form lists purchases of the last two
// years) and October 2020 (the closed-month test). Closing a month is install-wide: no other spec dates anything in
// October 2020; this file closes only that month and reopens it in `finally` and again after the last test.
import { test, expect, toast, uniq, slug, apiContext, callApi, waitIdle } from "../fixtures.mjs";
import { makeShop, placeOrder } from "../lib/data.mjs";
import { freshAdmin } from "../lib/money.mjs";

test.describe.configure({ mode: "serial" });

const MONTH = (new Date().getFullYear() - 1) + "-08";
const day = (d) => MONTH + "-" + String(d).padStart(2, "0");
const CLOSED_MONTH = "2020-10";

test.afterAll(async () => {
  const ctx = await apiContext("owner");
  try {
    const { periods } = await callApi(ctx, "listClosedPeriods");
    if (periods.some((p) => p.month === CLOSED_MONTH)) await callApi(ctx, "reopenPeriod", { month: CLOSED_MONTH });
  } finally { await ctx.dispose(); }
});

// A new account; returns its id.
async function makeAccount(api, name, type, openingBalance = 0) {
  const { accounts } = await api("saveAccount", { account: { name, type, openingBalance, openingDate: "2020-01-01" } });
  const a = accounts.find((x) => x.name === name);
  expect(a, "the account " + name).toBeTruthy();
  return a.id;
}
// Imports statement lines into an account the way Reconcile's Import does; returns each line's id by description.
async function importLines(api, accountId, month, lines) {
  const r = await api("importStatement", { accountId, lines });
  expect(r.inserted).toBe(lines.length);
  const rec = await api("getReconciliation", { accountId, month });
  return Object.fromEntries(lines.map((l) => [l.description, rec.lines.find((x) => x.description === l.description)]));
}
// The Reconcile page on one account and month.
async function openReconcile(page, accountName, month) {
  await freshAdmin(page, "reconcile");
  await page.locator("#rcAccount").selectOption({ label: accountName });
  await expect(page.locator("#rcBody")).toContainText("Import statement CSV — " + accountName);
  await waitIdle(page);
  await page.locator("#rcMonth").fill(month);
  await waitForBody(page, month);
  await waitIdle(page);   // (each change reloads the body: nothing may be drawn over what the test does next)
}
const waitForBody = async (page, month) => {
  const body = page.locator("#rcBody");
  await expect(body.getByRole("heading", { name: /^On the statement, not in the books — \d+$/ })).toBeVisible();
  if (month) await expect(body).toContainText(new RegExp("ending balance \\(" + month + "-\\d\\d\\)|owed on the statement \\(" + month));
};
const unmatchedHeading = (page) => page.locator("#rcBody").getByRole("heading", { name: /^On the statement, not in the books — / });
const lineRow = (page, description) => page.locator("#rcBody tr", { hasText: description });
const bookBalance = (page) => page.locator("#rcBody").getByText(/^Book balance:/);
// Picks an invented statement CSV in the page's Import box.
const importCsv = (page, name, text) => page.locator("#rcFile").setInputFiles({ name, mimeType: "text/csv", buffer: Buffer.from(text) });
// Opens Create… on a statement line; returns the dialog.
async function createFor(page, description) {
  await lineRow(page, description).getByRole("button", { name: "Create…" }).click();
  const dlg = page.getByRole("dialog", { name: "Record this statement line" });
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText(description);
  return dlg;
}

// ---- Deposits ------------------------------------------------------------------------------------------------
const D = {};

test("a deposit covers one cash payment whole and part of another; the line is matched and the book balance goes up", async ({ page, api }) => {
  test.setTimeout(120_000);
  const tag = slug("dep");
  D.checking = uniq("Test Checking");
  D.cashBox = uniq("Test Cash Box");
  D.checkingId = await makeAccount(api, D.checking, "checking", 100);
  D.cashBoxId = await makeAccount(api, D.cashBox, "cash");
  // Two $20 orders, each paid $20 cash into the cash box early in the month.
  D.shop = await makeShop(api, { prefix: "rcdep" });
  D.orderA = await placeOrder(page, D.shop, { customer: uniq("Dana Deposit") });
  D.orderB = await placeOrder(page, D.shop, { customer: uniq("Dana Deposit") });
  for (const [o, d] of [[D.orderA, 3], [D.orderB, 4]]) {
    await api("addPayment", { org: D.shop.orgId, orderId: o.orderId, amount: 20, method: "cash", accountId: D.cashBoxId, date: day(d), requestId: slug("pay") });
  }
  D.dep1 = "BRANCH CASH DEPOSIT " + tag + "a";
  D.dep2 = "BRANCH CASH DEPOSIT " + tag + "b";

  // The statement comes in through the page's CSV import: US dates, one signed amount column, a row it can't read.
  await openReconcile(page, D.checking, MONTH);
  await expect(page.locator("#rcBody")).toContainText("No statement lines for this month yet — import the CSV above.");
  const [y, mo] = MONTH.split("-");
  const csv = ["Date,Description,Amount", `${mo}/10/${y},${D.dep1},"$30.00"`, `${mo}/20/${y},${D.dep2},9.50`, "not a date,UNREADABLE ROW,1.00", ""].join("\r\n");
  await importCsv(page, "statement.csv", csv);
  const map = page.locator("#rcMap");
  await expect(map.locator("[data-k=mode]")).toHaveValue("one");
  await expect(map.locator("[data-k=desc]")).toHaveValue("1");
  await expect(map).toContainText(`2 lines (2 in ${MONTH}), 1 unreadable (rows 3).`);
  await expect(map.locator("table tr").first()).toContainText(`${day(10)}${D.dep1}$30.00`);
  await map.getByRole("button", { name: "Import 2 lines" }).click();
  await expect(toast(page)).toContainText("Imported 2 new lines; 0 matched automatically.");
  await expect(unmatchedHeading(page)).toHaveText("On the statement, not in the books — 2");
  await expect(bookBalance(page)).toContainText("$100.00");
  // The same file again: nothing is imported twice.
  await importCsv(page, "statement.csv", csv);
  await page.locator("#rcMap").getByRole("button", { name: "Import 2 lines" }).click();
  await expect(toast(page)).toContainText("Imported 0 new lines (2 already imported); 0 matched automatically.");
  await expect(unmatchedHeading(page)).toHaveText("On the statement, not in the books — 2");

  const dlg = await createFor(page, D.dep1);
  // "DEPOSIT" in the bank's wording starts it as a deposit, with its explanation.
  await expect(dlg.getByLabel("It's a")).toHaveValue("deposit");
  await expect(dlg).toContainText("A deposit that pays off orders");
  const ok = dlg.getByRole("button", { name: "Create & match" });
  const sum = dlg.locator("#vmSum");
  const rowOf = (o) => dlg.locator("tr[data-method]", { hasText: o.orderId });
  await expect(rowOf(D.orderA)).toContainText("CASH");
  await expect(rowOf(D.orderA)).toContainText("in " + D.cashBox);
  await expect(rowOf(D.orderB)).toContainText("$20.00");
  await expect(sum).toHaveText("Nothing ticked yet.");
  await expect(ok).toBeDisabled();

  // Order A: covers its whole $20 — $10 short of the $30 deposit.
  await rowOf(D.orderA).getByRole("checkbox").check();
  const covA = rowOf(D.orderA).getByRole("spinbutton");
  await expect(covA).toHaveValue("20.00");
  await expect(sum).toHaveText("1 payment cover $20.00 — $10.00 short of the deposit; tick more or raise an amount.");
  await expect(ok).toBeDisabled();
  // Order B: starts at what the deposit still needs, $10 of its $20.
  await rowOf(D.orderB).getByRole("checkbox").check();
  const covB = rowOf(D.orderB).getByRole("spinbutton");
  await expect(covB).toHaveValue("10.00");
  await expect(sum).toHaveText("2 payments cover $30.00 − deposit $30.00 = matches exactly ✓");
  await expect(ok).toBeEnabled();

  // More than the payment has left, or nothing: refused on the form.
  for (const v of ["25", "0"]) {
    await covB.fill(v);
    await expect(sum).toHaveText("Each ticked payment needs an amount from $0.01 up to what it has left.");
    await expect(ok).toBeDisabled();
  }
  await covB.fill("10");
  await expect(sum).toHaveText("2 payments cover $30.00 − deposit $30.00 = matches exactly ✓");
  // The Show filter only hides rows: ticks and amounts stay.
  await dlg.getByLabel("Show").selectOption("check");
  await expect(rowOf(D.orderA)).toBeHidden();
  await dlg.getByLabel("Show").selectOption("");
  await expect(rowOf(D.orderA).getByRole("checkbox")).toBeChecked();
  await expect(covB).toHaveValue("10");

  const sent = page.waitForRequest((r) => r.url().endsWith("/api/orders") && /"action":"createFromStatementLine"/.test(r.postData() || ""));
  await ok.click();
  const body = JSON.parse((await sent).postData());
  expect(body).toMatchObject({ kind: "deposit", feeCategoryId: expect.any(Number) });
  expect(body.allocations).toHaveLength(2);
  await expect(dlg).toHaveCount(0);
  await expect(unmatchedHeading(page)).toHaveText("On the statement, not in the books — 1");
  await expect(page.locator("#rcBody summary", { hasText: "Matched —" })).toHaveText("Matched — 1");
  await expect(bookBalance(page)).toContainText("$130.00");
  await page.locator("#rcBody summary", { hasText: "Matched —" }).click();
  await expect(lineRow(page, D.dep1)).toContainText("Transfer in $30.00");

  // On the server: A is fully deposited (off the list), B has $10 left.
  const { payments } = await api("listCashoutPayments", { accountId: D.checkingId });
  expect(payments.find((p) => p.orderId === D.orderA.orderId)).toBeUndefined();
  expect(payments.find((p) => p.orderId === D.orderB.orderId)).toMatchObject({ amount: 20, cashedOut: 10, remaining: 10, direct: false });
});

test("a deposit short of what it covers records the difference as an expense, and a payment fully deposited leaves the list", async ({ page, api }) => {
  expect(D.dep2, "the first deposit test ran").toBeTruthy();
  await openReconcile(page, D.checking, MONTH);
  const dlg = await createFor(page, D.dep2);
  const ok = dlg.getByRole("button", { name: "Create & match" });
  const sum = dlg.locator("#vmSum");
  const rowOf = (o) => dlg.locator("tr[data-method]", { hasText: o.orderId });
  await expect(rowOf(D.orderB)).toContainText("$10.00 left of $20.00");
  await expect(rowOf(D.orderB)).toContainText("$10.00 already deposited");
  await expect(rowOf(D.orderA)).toHaveCount(0);

  await rowOf(D.orderB).getByRole("checkbox").check();
  const cov = rowOf(D.orderB).getByRole("spinbutton");
  await expect(cov).toHaveValue("9.50");
  await expect(sum).toHaveText("1 payment cover $9.50 − deposit $9.50 = matches exactly ✓");
  await expect(dlg.locator("#vmFeeRow")).toBeHidden();
  // Over what's left (10.01 of 10.00): refused.
  await cov.fill("10.01");
  await expect(sum).toHaveText("Each ticked payment needs an amount from $0.01 up to what it has left.");
  await expect(ok).toBeDisabled();
  // Less than the deposit: short.
  await cov.fill("9");
  await expect(sum).toContainText("$0.50 short of the deposit");
  await expect(ok).toBeDisabled();
  // The whole $10 for a $9.50 deposit: the $0.50 is recorded as an expense, in a category the user picks.
  await cov.fill("10");
  await expect(sum).toHaveText("1 payment cover $10.00 − deposit $9.50 = difference $0.50 (5.0%)");
  await expect(dlg.locator("#vmFeeRow")).toBeVisible();
  await expect(dlg.getByText("Record the difference (fees, cash kept, short deposit) as")).toBeVisible();
  await expect(ok).toBeEnabled();
  // "Tick oldest first" redoes the ticks until the deposit is covered. (The list is every shop's payments waiting to
  // be deposited, and other specs' may be older: whatever it ticks is unticked again, and only B is sent.)
  await dlg.getByLabel("Show").selectOption("cash");
  await dlg.getByRole("button", { name: "Tick oldest first until it covers the deposit" }).click();
  await expect(sum).toContainText(/cover \$[\d.,]+ − deposit \$9\.50 = /);
  await dlg.getByLabel("Show").selectOption("");
  for (const box of await dlg.locator("tr[data-method] input[type=checkbox]:checked").all()) await box.uncheck();
  await expect(sum).toHaveText("Nothing ticked yet.");
  await rowOf(D.orderB).getByRole("checkbox").check();
  await cov.fill("10");
  await expect(sum).toHaveText("1 payment cover $10.00 − deposit $9.50 = difference $0.50 (5.0%)");
  await ok.click();
  await expect(dlg).toHaveCount(0);
  await expect(unmatchedHeading(page)).toHaveText("On the statement, not in the books — 0");
  await expect(page.locator("#rcBody")).toContainText("Everything on this statement is matched. ✓");
  await expect(bookBalance(page)).toContainText("$139.50");

  const { payments } = await api("listCashoutPayments", { accountId: D.checkingId });
  expect(payments.find((p) => p.orderId === D.orderB.orderId)).toBeUndefined();
  // The $0.50 left the cash box as an expense: the cash box's $40 is now $0.
  const { expenses } = await api("listExpenses", { dateFrom: day(1), dateTo: day(28) });
  const short = expenses.filter((e) => e.accountId === D.cashBoxId);
  expect(short).toHaveLength(1);
  expect(short[0]).toMatchObject({ amount: 0.5, date: day(20) });
  expect(short[0].description).toContain(D.orderB.orderId);
  const cash = await api("getReconciliation", { accountId: D.cashBoxId, month: MONTH });
  expect(cash.bookBalance).toBe(0);
});

// ---- Refunds -------------------------------------------------------------------------------------------------
test("a refund is linked to the purchase it refunds; one over what's left of it is refused, one with no category can't be sent", async ({ page, api }) => {
  const tag = slug("toner");   // a word only these lines and this purchase share: the form's best guess
  const account = uniq("Test Refund Checking");
  const accountId = await makeAccount(api, account, "checking", 50);
  const { categories } = await api("listExpenseCategories");
  const office = categories.find((c) => c.name === "Office expense");
  const purchase = "Printer toner " + tag;
  const { expense } = await api("saveExpense", { expense: { date: day(5), description: purchase, categoryId: office.id, amount: 25, vendor: "",
    businessUsePct: 100, vendorChargedTax: true, accountId } });
  // An older purchase, paid personally, in the year before: offered too, with the tax-year warning. (Listed only
  // while it's within the form's last two years — every day but the year's last two.)
  const oldDate = (Number(MONTH.slice(0, 4)) - 1) + "-12-31";
  const oldListed = Date.parse(oldDate) > Date.now() - 728 * 86400000;
  const { expense: oldExpense } = await api("saveExpense", { expense: { date: oldDate, description: "Printer toner " + tag + " older", categoryId: office.id, amount: 30,
    vendor: "", businessUsePct: 100, vendorChargedTax: true, paidPersonally: true } });
  const r1 = "RETURN " + tag + " STORE 1", r2 = "RETURN " + tag + " STORE 2";

  // This bank's CSV has withdrawals and deposits in their own columns, ISO dates: the import works that out. The
  // purchase's own line is matched to it as it comes in.
  await openReconcile(page, account, MONTH);
  await importCsv(page, "bank.csv", ["Posted,Payee,Withdrawal,Deposit", `${day(5)},PRINTER TONER ${tag},25.00,`, `${day(15)},${r1},,7.00`, `${day(25)},${r2},,20.00`].join("\n"));
  const map = page.locator("#rcMap");
  await expect(map.locator("[data-k=mode]")).toHaveValue("split");
  await expect(map.locator("[data-k=debit]")).toHaveValue("2");
  await expect(map.locator("[data-k=credit]")).toHaveValue("3");
  await expect(map.locator("table tr").first()).toContainText("−$25.00");
  await map.getByRole("button", { name: "Import 3 lines" }).click();
  await expect(toast(page)).toContainText("Imported 3 new lines; 1 matched automatically.");
  await expect(unmatchedHeading(page)).toHaveText("On the statement, not in the books — 2");
  await expect(page.locator("#rcBody summary", { hasText: "Matched —" })).toHaveText("Matched — 1");
  await expect(bookBalance(page)).toContainText("$25.00");   // 50 opening − 25 purchase

  let dlg = await createFor(page, r1);
  // "RETURN" starts it as a refund; the purchase that shares the bank's words (and is listed) is picked, with its category.
  await expect(dlg.getByLabel("It's a")).toHaveValue("expense_refund");
  await expect(dlg).toContainText("It's recorded as a negative expense in the original category");
  const orig = dlg.locator("#rfOrig");
  await expect(orig).toHaveValue(String(expense.id));
  await expect(dlg.locator("#rfCat")).toHaveValue(String(office.id));
  await expect(dlg.locator("#rfNote")).toHaveText(`Original: ${day(5)}, $25.00.`);
  await dlg.getByRole("button", { name: "Create & match" }).click();
  await expect(dlg).toHaveCount(0);
  await expect(unmatchedHeading(page)).toHaveText("On the statement, not in the books — 1");
  await expect(bookBalance(page)).toContainText("$32.00");

  dlg = await createFor(page, r2);
  const ok = dlg.getByRole("button", { name: "Create & match" });
  await expect(orig).toHaveValue(String(expense.id));
  // $7 of the $25 is already refunded: a $20 refund is more than the $18 left — said on the form…
  await expect(dlg.locator("#rfNote")).toHaveText(`Original: ${day(5)}, $25.00 ($7.00 already refunded). This refund is more than what's left ($18.00).`);
  // No purchase and no category: can't be sent.
  await orig.selectOption("");
  await expect(dlg.locator("#rfNote")).toHaveText("");
  await dlg.locator("#rfCat").selectOption("");
  await expect(ok).toBeDisabled();
  // The older purchase was in the tax year before: the form says a refund of it is normally other income.
  if (oldListed) {
    await orig.selectOption(String(oldExpense.id));
    await expect(dlg.locator("#rfNote")).toContainText(`Original: ${oldDate}, $30.00. That purchase was in ${oldDate.slice(0, 4)}. A refund in a later tax year is normally reported as other income`);
  }
  await orig.selectOption(String(expense.id));
  await expect(dlg.locator("#rfCat")).toHaveValue(String(office.id));
  await expect(ok).toBeEnabled();
  // …and refused by the server, which records nothing.
  await ok.click();
  await expect(dlg).toHaveCount(0);
  const refusal = "That purchase was $25.00 and $7.00 is already refunded — a $20.00 refund is more than what's left";
  await expect(page.locator("#rcErr")).toHaveText(refusal);
  await expect(toast(page)).toContainText(refusal);
  await expect(unmatchedHeading(page)).toHaveText("On the statement, not in the books — 1");
  await expect(bookBalance(page)).toContainText("$32.00");

  const { expenses } = await api("listExpenses", { dateFrom: day(1), dateTo: day(28) });
  const refunds = expenses.filter((e) => e.refundOfId === expense.id);
  expect(refunds).toHaveLength(1);
  expect(refunds[0]).toMatchObject({ amount: -7, categoryId: office.id, isRefund: true, date: day(15) });
});

// ---- A blank purchase ----------------------------------------------------------------------------------------------
test("a card charge recorded as a blank purchase must add up to the line, and its blanks go into stock", async ({ page, api }) => {
  const tag = slug("blk");
  const account = uniq("Test Blanks Card");
  const accountId = await makeAccount(api, account, "checking", 80);
  const blankName = uniq("Sample Register Tee");
  const blankId = (await api("createBlank", { name: blankName, brand: "Test Blank Co", productType: "Tee",
    colors: [{ color: "Navy", sizes: [{ size: "M", quantity: 0, purchasePrice: 3, vendorPrice: 3 }, { size: "L", quantity: 0, purchasePrice: 3, vendorPrice: 3 }] }] })).id;
  const charge = "BLANKS ORDER " + tag;
  await importLines(api, accountId, MONTH, [{ date: day(12), description: charge, amount: -21 }]);

  await openReconcile(page, account, MONTH);
  const dlg = await createFor(page, charge);
  await dlg.getByLabel("It's a").selectOption("blanks");
  const ok = dlg.getByRole("button", { name: "Create & match" });
  await expect(dlg.getByLabel("Description")).toBeHidden();
  await expect(ok).toBeDisabled();
  await dlg.locator(".rcc-blank").selectOption({ label: blankName });
  const m = dlg.locator(".rcc-sizes tr", { hasText: "Navy · M" });
  // 5 of size M: its cost fills in from the vendor price, $15.00 — short of the $21.00 charge.
  await m.locator(".rcc-qty").fill("5");
  await expect(m.locator(".rcc-cost")).toHaveValue("15.00");
  await expect(dlg.locator("#rccTotal")).toHaveText("Blanks $15.00 = $15.00 of $21.00");
  await expect(ok).toBeDisabled();
  // $6.00 of shipping makes up the rest.
  await dlg.getByLabel("Shipping & other costs").fill("6");
  await expect(dlg.locator("#rccTotal")).toHaveText("Blanks $15.00 + shipping & other $6.00 = $21.00 of $21.00 ✓");
  await expect(ok).toBeEnabled();
  await ok.click();
  await expect(dlg).toHaveCount(0);
  await expect(page.locator("#rcBody")).toContainText("Everything on this statement is matched. ✓");
  await expect(bookBalance(page)).toContainText("$59.00");

  // Five in stock at their landed cost: ($15 + $6) / 5 = $4.20 each.
  const blank = (await api("getBlanks")).blanks.find((b) => b.id === blankId);
  const m2 = blank.colors[0].sizes.find((z) => z.size === "M");
  expect(m2).toMatchObject({ quantity: 5, purchasePrice: 4.2 });
});

// ---- Other kinds, and a closed month ------------------------------------------------------------------------------
test("in a closed month Create… is refused until the month is reopened; an expense needs a category; owner money and a transfer are recorded", async ({ page, api }) => {
  test.setTimeout(120_000);
  const tag = slug("cm");
  const account = uniq("Test Old Checking");
  const savings = uniq("Test Old Savings");
  const accountId = await makeAccount(api, account, "checking", 200);
  const savingsId = await makeAccount(api, savings, "other");
  const fee = "MONTHLY SERVICE FEE " + tag, owner = "OWNER TOP UP " + tag, move = "ONLINE MOVE IN " + tag;
  const ids = await importLines(api, accountId, CLOSED_MONTH, [
    { date: CLOSED_MONTH + "-05", description: fee, amount: -15 },
    { date: CLOSED_MONTH + "-12", description: owner, amount: 40 },
    { date: CLOSED_MONTH + "-19", description: move, amount: 12 },
  ]);
  const { categories } = await api("listExpenseCategories");
  try {
    await api("closePeriod", { month: CLOSED_MONTH });
    await openReconcile(page, account, CLOSED_MONTH);
    await expect(unmatchedHeading(page)).toHaveText("On the statement, not in the books — 3");
    await expect(bookBalance(page)).toContainText("$200.00");

    // Money out: the kinds offered are the outgoing ones.
    let dlg = await createFor(page, fee);
    const kind = dlg.getByLabel("It's a");
    await expect(kind.locator("option")).toHaveText(["Business expense", "Blank purchase (inventory, R&D, personal)", "Owner took money out", "Transfer to another account"]);
    await expect(kind).toHaveValue("expense");
    await expect(dlg.locator("#rccNote")).toContainText(`Dated ${CLOSED_MONTH}-05, $15.00, in ${account}`);
    // No category: nothing is sent and the window stays open.
    let asked = 0;
    const count = (r) => { if (/"action":"createFromStatementLine"/.test(r.postData() || "")) asked++; };
    page.on("request", count);
    await dlg.getByRole("button", { name: "Create & match" }).click();
    await page.waitForTimeout(300);
    expect(asked).toBe(0);
    await expect(dlg).toBeVisible();
    page.off("request", count);
    await dlg.getByLabel("Category").selectOption({ label: "Office expense" });
    await dlg.getByLabel("Description").fill("Bank service fee " + tag);
    await dlg.getByRole("button", { name: "Create & match" }).click();
    await expect(dlg).toHaveCount(0);
    // October 2020 is closed: refused, nothing recorded.
    const closed = "October 2020 is closed (already filed). Reopen it under Periods & Export to change it.";
    await expect(page.locator("#rcErr")).toHaveText(closed);
    await expect(toast(page)).toContainText(closed);
    expect((await api("getReconciliation", { accountId, month: CLOSED_MONTH })).lines.map((l) => l.status)).toEqual(["unmatched", "unmatched", "unmatched"]);

    // Reopened, the same Create… goes through.
    await api("reopenPeriod", { month: CLOSED_MONTH });
    await openReconcile(page, account, CLOSED_MONTH);
    dlg = await createFor(page, fee);
    await dlg.getByLabel("Category").selectOption({ label: "Office expense" });
    await dlg.getByLabel("Description").fill("Bank service fee " + tag);
    await dlg.getByRole("button", { name: "Create & match" }).click();
    await expect(dlg).toHaveCount(0);
    await expect(unmatchedHeading(page)).toHaveText("On the statement, not in the books — 2");
    await expect(bookBalance(page)).toContainText("$185.00");

    // Money in: owner put money in.
    dlg = await createFor(page, owner);
    await expect(dlg.getByLabel("It's a").locator("option")).toHaveCount(5);
    await dlg.getByLabel("It's a").selectOption("owner");
    await expect(dlg).toContainText("You put your own money into the business.");
    await dlg.getByRole("button", { name: "Create & match" }).click();
    await expect(unmatchedHeading(page)).toHaveText("On the statement, not in the books — 1");
    await expect(bookBalance(page)).toContainText("$225.00");

    // A transfer from the savings account.
    dlg = await createFor(page, move);
    await dlg.getByLabel("It's a").selectOption("transfer");
    await dlg.getByLabel("From account").selectOption({ label: savings });
    await dlg.getByRole("button", { name: "Create & match" }).click();
    await expect(unmatchedHeading(page)).toHaveText("On the statement, not in the books — 0");
    await expect(bookBalance(page)).toContainText("$237.00");

    // What the server saved: each line matched to its own entry.
    const rec = await api("getReconciliation", { accountId, month: CLOSED_MONTH });
    const byId = Object.fromEntries(rec.lines.map((l) => [l.id, l]));
    expect(byId[ids[fee].id].matched.map((m) => m.label)).toEqual(["Bank service fee " + tag]);
    expect(byId[ids[owner].id].matched.map((m) => m.label)).toEqual(["Owner contribution"]);
    expect(byId[ids[move].id].matched.map((m) => [m.label, m.amount])).toEqual([["Transfer in", 12]]);
    expect((await api("getReconciliation", { accountId: savingsId, month: CLOSED_MONTH })).bookBalance).toBe(-12);
  } finally {
    const { periods } = await api("listClosedPeriods");
    if (periods.some((p) => p.month === CLOSED_MONTH)) await api("reopenPeriod", { month: CLOSED_MONTH });
  }
});
