// Reports → QuickBooks export (phase 8): public/admin-quickbooks.js (loaded on demand by admin.js ensureQuickBooksPage_),
// functions/api/orders.js getQuickBooksSettings / updateQuickBooksSettings / getQuickBooksExport, db.js
// getQuickBooksSettings / buildQuickBooksSettings / getQuickBooksData, functions/_lib/quickbooks.js. What's checked:
//
// - The account mapping: the defaults shown (every account box, a row per bank account and expense category, Sales go
//   in as, Customer name), names changed and saved through the page (one audit entry, what the server keeps), a reload
//   shows them kept; the page's own refusal of an empty name or a tab, the server's refusal shown on the page, and the
//   server's own refusals (a tab, over 100 characters, a bad choice).
// - The export for two fixed business days (America/Chicago) with sales at the day edges, cash and check payments, a
//   refund, a Net 30 order, expenses from a checking account and a credit card, a vendor refund and a cash deposit:
//   the summary strip (counts and totals, parts left out), the QuickBooks Online files (names, columns, rows, amounts,
//   per bank account, Net 30 orders in their own invoice file) and the QuickBooks Desktop .iif (headers, CRLF, every
//   transaction balanced, the mapped accounts, invoices with Customer name = Shop, payments, a refund, CHECK / CREDIT
//   CARD / DEPOSIT, the cash deposit). The summary is asked without writing the audit log; a download writes one entry.
// - The format choice is remembered for everyone; the presets; the parts ticks; a bad range; an empty range; a load
//   error, a summary error, a download error; a slower, older summary never replacing a newer one; "Save again"; the
//   page that couldn't load; a server that answers the settings without the app's accounts (the page asks the lists).
// - The server's refusals of bad dates, ranges over three years, formats and parts.
// - Roles: Back office reads the page and downloads, with the mapping read-only and the server refusing a change;
//   Manager changes it; Production has no menu item and the server refuses it.
// - Bookkeeping switched off in Global settings: no menu item, the page says it is off, the server refuses the actions.
//
// It changes install-wide settings (the business time zone, the sale-date basis, Net 30 among the payment methods, the
// QuickBooks mapping, the Bookkeeping switch), so it is in ALONE in playwright.config.mjs and puts every one back in afterAll.
import fs from "node:fs";
import { test, expect, openAdmin, leaveAdmin, toast, uniq, slug, ADMIN, apiContext, callApi, navTo } from "../fixtures.mjs";
import { makeShop } from "../lib/data.mjs";

test.describe.configure({ mode: "serial" });

const FROM = "2023-05-10", TO = "2023-05-11";   // two business days in Chicago (CDT, UTC−5)
const TZ = "America/Chicago";
const TAG = slug("qb").slice(2, 10);
const CHECK_NO = "CK" + TAG.toUpperCase();   // a check number of this run (the payment's DOCNUM in the .iif)
const D = {};   // the data every test reads: made in the first test
const saved = {};   // the settings as they were, put back in afterAll

// ---- helpers ---------------------------------------------------------------------------------------------
const qb = (page) => page.locator("#qbPage");
const actionOf = (req) => { try { return JSON.parse(req.postData() || "{}"); } catch (e) { return {}; } };
const answerOf = (page, action, pred = () => true) => page.waitForResponse(r => r.url().endsWith("/api/orders") && r.request().method() === "POST"
  && actionOf(r.request()).action === action && pred(actionOf(r.request())));
const summaryAnswer = (page) => answerOf(page, "getQuickBooksExport", b => b.summaryOnly === true);
const exportAnswer = (page) => answerOf(page, "getQuickBooksExport", b => !b.summaryOnly);
const fmtMoney = (page, cents) => page.evaluate((c) => adminMoney_(c / 100), cents);
const amt = (cents) => (cents < 0 ? "-" : "") + Math.floor(Math.abs(cents) / 100) + "." + String(Math.abs(cents) % 100).padStart(2, "0");
const usDate = (ymd) => ymd.slice(5, 7) + "/" + ymd.slice(8, 10) + "/" + ymd.slice(0, 4);
const docnum = (id) => { const s = String(id).replace(/\s+/g, ""); return s.length > 11 ? s.slice(-11) : s; };
const auditCount = async (api, action) => ((await api("getAuditLog", { filter: action, limit: 500 })).entries || []).filter(e => e.action === action).length;
const tryApi = (ctx, action, body) => callApi(ctx, action, body, { allowError: true, withStatus: true });
async function asApi(role, workerIndex, fn) {
  const ctx = await apiContext(role, workerIndex);
  try { return await fn((action, body) => tryApi(ctx, action, body)); } finally { await ctx.dispose(); }
}
const summaryOf = async (api, from = FROM, to = TO) => (await api("getQuickBooksExport", { dateFrom: from, dateTo: to, summaryOnly: true })).summary;

// Opens the page and waits until the mapping and the summary are drawn.
async function openQb(page) {
  const sum = summaryAnswer(page);
  await openAdmin(page, "quickbooks");
  await expect(qb(page)).toBeVisible();
  await expect(page).toHaveTitle(/QuickBooks export/);
  await sum;
  await expect(qb(page).locator('#qbMap [data-qb-acc="sales"]')).toBeVisible();
  await expect(qb(page).locator("#qbSummary")).not.toContainText("Loading…");
}
// Types a range in the From / To boxes (From first set to the earliest day, so the range never reads backwards on the
// way); waits for the summary of each change and checks the last one asked.
async function setRange(page, from, to) {
  for (const [label, v] of [["From", "2020-01-01"], ["To", to], ["From", from]]) {
    const box = qb(page).getByLabel(label, { exact: true });
    if ((await box.inputValue()) === v) continue;
    const ans = summaryAnswer(page);
    await box.fill(v);
    await ans;
  }
  const ans = summaryAnswer(page);
  await qb(page).getByLabel("To", { exact: true }).dispatchEvent("change");
  const body = actionOf((await ans).request());
  expect(body).toMatchObject({ dateFrom: from, dateTo: to, summaryOnly: true, parts: ["sales", "payments", "expenses", "deposits"] });
}
// Clicks Download and collects every file the browser saves: [{ name, text }] in the order they came, and the answer.
async function download(page) {
  const got = [];
  const onDl = async (d) => { got.push({ name: d.suggestedFilename(), path: d.path() }); };
  page.on("download", onDl);
  const ans = exportAnswer(page);
  await qb(page).getByRole("button", { name: "Download", exact: true }).click();
  const res = await ans;
  const answer = await res.json();
  expect(answer.status).toBe("ok");
  // The toast comes as the answer is drawn (before the last of several files is saved, one every 400 ms).
  if (answer.files.length) await expect(toast(page)).toContainText(answer.files.length === 1 ? "QuickBooks file saved." : answer.files.length + " QuickBooks files saved.");
  await expect.poll(() => got.length, { timeout: answer.files.length * 500 + 10_000 }).toBe(answer.files.length);
  page.off("download", onDl);
  const files = [];
  for (const g of got) files.push({ name: g.name, text: fs.readFileSync(await g.path, "utf8") });
  return { files, answer, body: actionOf(res.request()) };
}
// Splits a CSV the way the export writes it (cells quoted only when they must be).
function parseCsv(text) {
  expect(text.endsWith("\r\n")).toBe(true);
  expect(text.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);   // CRLF only
  return text.slice(0, -2).split("\r\n").map(line => {
    const out = []; let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch;
    }
    out.push(cur);
    return out;
  });
}
// The .iif read back: { header: [3 lines], trns: [{ trns: {col: value}, spl: [{…}] }] }; every block must sum to 0.
function parseIif(text) {
  expect(text.endsWith("\r\n")).toBe(true);
  expect(text.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  const lines = text.slice(0, -2).split("\r\n");
  const header = lines.slice(0, 3);
  const tCols = lines[0].split("\t"), sCols = lines[1].split("\t");
  const blocks = []; let cur = null;
  const obj = (cols, f) => Object.fromEntries(cols.map((c, i) => [c, f[i] == null ? "" : f[i]]));
  for (const ln of lines.slice(3)) {
    const f = ln.split("\t");
    if (f[0] === "TRNS") { expect(cur, "a TRNS inside another").toBeNull(); expect(f).toHaveLength(tCols.length); cur = { trns: obj(tCols, f), spl: [] }; }
    else if (f[0] === "SPL") { expect(cur, "a SPL outside a TRNS").not.toBeNull(); expect(f).toHaveLength(sCols.length); cur.spl.push(obj(sCols, f)); }
    else if (ln === "ENDTRNS") { expect(cur).not.toBeNull(); blocks.push(cur); cur = null; }
    else throw new Error("an IIF line that isn't TRNS, SPL or ENDTRNS: " + JSON.stringify(ln));
  }
  expect(cur, "a TRNS never ended").toBeNull();
  const cents = (v) => { expect(v).toMatch(/^-?\d+\.\d{2}$/); return Math.round(Number(v) * 100); };
  for (const b of blocks) {
    const sum = cents(b.trns.AMOUNT) + b.spl.reduce((s, x) => s + cents(x.AMOUNT), 0);
    expect(sum, "transaction " + b.trns.TRNSTYPE + " " + b.trns.DOCNUM + " balances").toBe(0);
    for (const x of b.spl) { expect(x.TRNSTYPE).toBe(b.trns.TRNSTYPE); expect(x.DATE).toBe(b.trns.DATE); expect(x.DOCNUM).toBe(b.trns.DOCNUM); }
  }
  return { header, blocks };
}
const brief = (b) => [b.trns.TRNSTYPE, b.trns.DATE, b.trns.ACCNT, b.trns.NAME, b.trns.AMOUNT, ...b.spl.map(s => s.ACCNT + " " + s.AMOUNT)].join(" | ");

test.afterAll(async () => {
  const ctx = await apiContext("owner");
  try {
    if ((await callApi(ctx, "getFeatures")).features.bookkeeping === false) await callApi(ctx, "updateFeatures", { features: { bookkeeping: true } });
    // The names this run gave its own account and category go too (an app name is never stored).
    if (saved.quickbooks) await callApi(ctx, "updateQuickBooksSettings", { settings: { ...saved.quickbooks,
      bankAccounts: { ...saved.quickbooks.bankAccounts, ...(D.checking ? { [D.checking.id]: D.checking.name } : {}) },
      expenseAccounts: { ...saved.quickbooks.expenseAccounts, ...(D.cat ? { [D.cat.id]: D.cat.name } : {}) } } });
    if (saved.locale) await callApi(ctx, "updateLocaleSettings", { locale: saved.locale });
    if (saved.saleDate) await callApi(ctx, "updateAccountingSettings", { saleDate: saved.saleDate });
    if (saved.payments) await callApi(ctx, "saveGlobalSettingsAll", { settings: { payments: saved.payments } });
  } finally { await ctx.dispose(); }
});

// ---- The data, and the account mapping ---------------------------------------------------------------------------
test("The account mapping: defaults shown, names changed and saved through the page, kept after a reload", async ({ page, api }) => {
  test.setTimeout(120_000);
  saved.quickbooks = (await api("getQuickBooksSettings")).settings;
  saved.locale = (await api("getLocaleSettings")).locale;
  saved.saleDate = (await api("getAccountingSettings")).accounting.saleDate;
  saved.payments = ((await api("getGlobalSettings")).globalSettings || {}).enabledPayments || {};
  expect((await api("getFeatures")).features.bookkeeping).not.toBe(false);
  // Fixed: Chicago business days, sales counted on the day they were placed, the mapping at its defaults.
  await api("updateLocaleSettings", { locale: { timeZone: TZ, country: saved.locale.country } });
  await api("updateAccountingSettings", { saleDate: "placed" });
  await api("saveGlobalSettingsAll", { settings: { payments: { ...saved.payments, net30: true } } });
  await api("updateQuickBooksSettings", { settings: { format: "online", salesAs: "receipts", customerName: "customer",
    accounts: { sales: "Sales", shippingIncome: "Shipping Income", rushIncome: "Sales", discounts: "Discounts Given", salesTaxPayable: "Sales Tax Payable",
      giftCardLiability: "Gift Cards Outstanding", undepositedFunds: "Undeposited Funds", cardFees: "Merchant Fees", postage: "Postage and Delivery", ar: "Accounts Receivable" } } });
  D.before = await summaryOf(api);

  // Accounts and a category of this run's own.
  const acct = async (name, type) => (await api("saveAccount", { account: { name, type, openingDate: "2023-01-01", openingBalance: 0 } })).accounts.find(a => a.name === name).id;
  D.checking = { name: "Example Checking " + TAG }; D.checking.id = await acct(D.checking.name, "checking");
  D.cash = { name: "Example Cash Box " + TAG }; D.cash.id = await acct(D.cash.name, "cash");
  D.card = { name: "Example Card " + TAG }; D.card.id = await acct(D.card.name, "credit_card");
  D.cat = { name: "Example Supplies " + TAG };
  D.cat.id = (await api("saveExpenseCategory", { category: { name: D.cat.name, deductionType: "deductible", scheduleCLine: "22" } })).id;

  // A shop and its sales, at the edges of the two days (Chicago midnight is 05:00 UTC in May).
  const shop = D.shop = await makeShop(api, { prefix: "qbx", payments: { card: false, venmo: true, zelle: true, check: true, cash: true, other: true, net30: true }, products: [{ name: uniq("Sample Tee"), price: 20 }] });
  D.product = shop.products[0].name;
  const sale = async (at, qty, customerName, extra = {}) => (await api("createLocalSale", { org: shop.orgId, items: [{ productId: shop.products[0].productId, size: "", qty }],
    paymentMethod: "", customerName, placedAt: at, ...extra })).orderId;
  D.c1 = "Pat Example " + TAG; D.c2 = "Example School District " + TAG; D.c4 = "Example Club Boosters " + TAG;
  D.s0 = await sale("2023-05-10T04:59:59.000Z", 1, "Before " + TAG);            // 23:59:59 on the 9th in Chicago: left out
  D.s1 = await sale("2023-05-10T05:00:00.000Z", 2, D.c1);                         // the first moment of the 10th: $40
  D.s2 = await sale("2023-05-12T04:59:59.000Z", 3, D.c2);                         // the last moment of the 11th: $60
  D.s3 = await sale("2023-05-12T05:00:00.000Z", 1, "After " + TAG);              // the 12th: left out
  D.s4 = await sale("2023-05-11T15:00:00.000Z", 1, D.c4, { net30: true, poNumber: "PO-7001" });   // Net 30: $20
  D.s4due = (await api("getOrders", { org: shop.orgId })).orders.find(o => o.orderId === D.s4).termsDueDate;
  expect(D.s4due).toMatch(/^\d{4}-\d{2}-\d{2}$/);

  // Payments, by when they were received.
  const pay = async (orderId, amount, method, at, accountId, reference = "") => {
    const r = await api("addPayment", { org: shop.orgId, orderId, amount, method, at, accountId, reference });
    return r.payments[r.payments.length - 1].id;
  };
  D.p0 = await pay(D.s0, 20, "cash", "2023-05-10T04:59:00.000Z", D.cash.id);       // the 9th: left out
  D.p1 = await pay(D.s1, 40, "cash", "2023-05-10T05:00:00.000Z", D.cash.id);
  D.p2 = await pay(D.s2, 60, "check", "2023-05-11T20:00:00.000Z", D.checking.id, CHECK_NO);
  const ref = await api("recordRefund", { org: shop.orgId, orderId: D.s2, amount: 10, method: "check", at: "2023-05-11T21:00:00.000Z", accountId: D.checking.id, note: "Refund" });
  D.p3 = ref.payments.find(p => Number(p.amount) < 0).id;
  D.p4 = await pay(D.s4, 20, "check", "2023-05-11T22:00:00.000Z", D.checking.id);
  // Expenses and a vendor refund (by the day of the expense), and the cash taken to the bank.
  const exp = async (date, description, amount, accountId, refund = false) => (await api("saveExpense", { expense: { date, description, amount, categoryId: D.cat.id, accountId, refund } })).expense.id;
  D.e1 = await exp("2023-05-10", "Example thread restock " + TAG, 25.5, D.checking.id);
  D.e2 = await exp("2023-05-11", "Example needles " + TAG, 12, D.card.id);
  D.e3 = await exp("2023-05-11", "Example thread returned " + TAG, 5, D.checking.id, true);
  D.e4 = await exp("2023-05-12", "Example stabilizer " + TAG, 7, D.checking.id);   // the 12th: left out
  D.dep = (await api("saveMoneyEntry", { kind: "transfer", entry: { date: "2023-05-11", amount: 40, fromAccountId: D.cash.id, toAccountId: D.checking.id, note: "Example cash deposit " + TAG } })).entry.id;
  // What the server holds now: this run's money added to whatever was already in these days.
  const after = await summaryOf(api);
  expect(after).toEqual({
    sales: { count: D.before.sales.count + 3, totalCents: D.before.sales.totalCents + 12000 },
    payments: { count: D.before.payments.count + 4, totalCents: D.before.payments.totalCents + 11000 },
    expenses: { count: D.before.expenses.count + 3, totalCents: D.before.expenses.totalCents + 3250 },
    deposits: { count: D.before.deposits.count + 1, totalCents: D.before.deposits.totalCents + 4000 },
  });
  D.after = after;

  // The page, from the Reports menu.
  await openAdmin(page, "home");
  const firstSum = summaryAnswer(page);
  await navTo(page, "Reports", "QuickBooks export");
  await expect(page).toHaveURL(/#quickbooks$/);
  await firstSum;
  await expect(qb(page).locator('#qbMap [data-qb-acc="sales"]')).toBeVisible();
  await expect(page).toHaveTitle(/QuickBooks export/);
  const map = qb(page).locator("#qbMap");
  const labels = [["sales", "Sales", "Sales"], ["shippingIncome", "Shipping income", "Shipping Income"], ["rushIncome", "Rush income", "Sales"],
    ["discounts", "Discounts", "Discounts Given"], ["salesTaxPayable", "Sales tax payable", "Sales Tax Payable"], ["giftCardLiability", "Gift card liability", "Gift Cards Outstanding"],
    ["undepositedFunds", "Undeposited funds", "Undeposited Funds"], ["cardFees", "Card fees", "Merchant Fees"], ["postage", "Postage", "Postage and Delivery"], ["ar", "Accounts receivable", "Accounts Receivable"]];
  await expect(map.locator("[data-qb-acc]")).toHaveCount(10);
  expect(await map.locator("[data-qb-acc]").evaluateAll(els => els.map(e => e.getAttribute("data-qb-acc")))).toEqual(labels.map(l => l[0]));
  for (const [key, label, value] of labels) {
    await expect(map.getByLabel(label, { exact: true })).toHaveValue(value);
    await expect(map.locator(`[data-qb-acc="${key}"]`)).toHaveAttribute("placeholder", value);
    await expect(map.locator(`[data-qb-acc="${key}"]`)).toBeEnabled();
  }
  // A row per bank account and per expense category, each at the app's own name.
  await expect(map.locator(`[data-qb-bank="${D.checking.id}"]`)).toHaveValue(D.checking.name);
  await expect(map.getByLabel(D.cash.name, { exact: true })).toHaveValue(D.cash.name);
  await expect(map.getByLabel(D.card.name, { exact: true })).toHaveValue(D.card.name);
  await expect(map.getByLabel(D.cat.name, { exact: true })).toHaveValue(D.cat.name);
  await expect(map.getByRole("radio", { name: "Sales receipts" })).toBeChecked();
  await expect(map.getByRole("radio", { name: "Customer" , exact: true })).toBeChecked();
  await expect(map).toContainText("Net 30 orders always go in as invoices.");
  await expect(qb(page)).toContainText("Type each name exactly as it is in your QuickBooks chart of accounts");
  await expect(qb(page)).not.toContainText("changing it needs Edit on QuickBooks export");
  await expect(qb(page).getByRole("radio", { name: /QuickBooks Online/ })).toBeChecked();
  await expect(qb(page).locator("#qbHowTo")).toContainText("QuickBooks Online: sales — Settings ▸ Import data ▸ Invoices");
  await expect(qb(page)).toContainText("Make a backup of your company file first.");

  // The page's own checks: an empty box, a tab.
  const saveBtn = map.getByRole("button", { name: "Save mapping" });
  let sent = 0;
  const count = (r) => { if (r.url().endsWith("/api/orders") && actionOf(r).action === "updateQuickBooksSettings") sent++; };
  page.on("request", count);
  await map.getByLabel("Sales", { exact: true }).fill("   ");
  await saveBtn.click();
  await expect(map.locator("#qbMapErr")).toHaveText("Give Sales a name of 1 to 100 characters, on one line.");
  await map.getByLabel("Card fees", { exact: true }).fill("Merchant\tFees");
  await saveBtn.click();
  await expect(map.locator("#qbMapErr")).toHaveText("Give 2 boxes a name of 1 to 100 characters, on one line.");
  await map.getByLabel("Card fees", { exact: true }).fill("Merchant Fees");
  // The server's refusal, shown under the boxes.
  await map.getByLabel("Sales", { exact: true }).fill("Embroidery Sales");
  await page.route("**/api/orders", async (route) => {
    if (actionOf(route.request()).action !== "updateQuickBooksSettings") return route.continue();
    await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ status: "error", message: "Sales: a QuickBooks name can be at most 100 characters." }) });
  });
  await saveBtn.click();
  await expect(map.locator("#qbMapErr")).toHaveText("Couldn't save: Sales: a QuickBooks name can be at most 100 characters.");
  await expect(saveBtn).toBeEnabled();
  await page.unroute("**/api/orders");
  page.off("request", count);
  expect(sent).toBe(1);   // only the one the route answered
  expect((await api("getQuickBooksSettings")).settings.accounts.sales).toBe("Sales");

  // Saved: the names, a bank account and a category under their QuickBooks names.
  const audits = await auditCount(api, "settings.quickbooks");
  await map.getByLabel("Undeposited funds", { exact: true }).fill("  Undeposited Funds:Example  ");
  await map.locator(`[data-qb-bank="${D.checking.id}"]`).fill("Business Checking " + TAG);
  await map.getByLabel(D.cat.name, { exact: true }).fill("Supplies:Thread " + TAG);
  const ans = answerOf(page, "updateQuickBooksSettings");
  const resum = summaryAnswer(page);
  await saveBtn.click();
  const body = actionOf((await ans).request());
  expect(body.settings).toMatchObject({ format: "online", salesAs: "receipts", customerName: "customer" });
  expect(body.settings.accounts).toMatchObject({ sales: "Embroidery Sales", undepositedFunds: "Undeposited Funds:Example", cardFees: "Merchant Fees" });
  expect(body.settings.bankAccounts[String(D.checking.id)]).toBe("Business Checking " + TAG);
  expect(body.settings.expenseAccounts[String(D.cat.id)]).toBe("Supplies:Thread " + TAG);
  await resum;   // the summary is asked again after a save
  await expect(toast(page)).toContainText("QuickBooks account mapping saved.");
  await expect(map.locator("#qbMapErr")).toHaveText("");
  const kept = (await api("getQuickBooksSettings")).settings;
  expect(kept.accounts).toMatchObject({ sales: "Embroidery Sales", undepositedFunds: "Undeposited Funds:Example", ar: "Accounts Receivable" });
  expect(kept.bankAccounts[String(D.checking.id)]).toBe("Business Checking " + TAG);
  expect(kept.bankAccounts[String(D.cash.id)]).toBe(D.cash.name);
  expect(kept.expenseAccounts[String(D.cat.id)]).toBe("Supplies:Thread " + TAG);
  expect(await auditCount(api, "settings.quickbooks")).toBe(audits + 1);

  // A reload shows them kept.
  await leaveAdmin(page);
  await openQb(page);
  await expect(map.getByLabel("Sales", { exact: true })).toHaveValue("Embroidery Sales");
  await expect(map.getByLabel("Undeposited funds", { exact: true })).toHaveValue("Undeposited Funds:Example");
  await expect(map.locator(`[data-qb-bank="${D.checking.id}"]`)).toHaveValue("Business Checking " + TAG);
  await expect(map.getByLabel(D.cat.name, { exact: true })).toHaveValue("Supplies:Thread " + TAG);
  await expect(map.getByLabel(D.cash.name, { exact: true })).toHaveValue(D.cash.name);
});

// ---- QuickBooks Online -------------------------------------------------------------------------------------------
test("QuickBooks Online: the summary of two business days, and the files downloaded (sales receipts, Net 30 invoices, a bank file per account)", async ({ page, api }) => {
  test.setTimeout(120_000);
  const audits = await auditCount(api, "report.quickbooks_export");
  await openQb(page);
  await setRange(page, FROM, TO);
  // The summary: what the parts hold (counts and totals); asking for it wrote nothing in the audit log.
  const cells = qb(page).locator("#qbSummary .gc-total");
  await expect(cells).toHaveCount(4);
  const A = D.after;
  const plural = (n, one) => n + " " + one + (n === 1 ? "" : "s");
  await expect(cells.nth(0)).toHaveText(await fmtMoney(page, A.sales.totalCents) + "Sales" + plural(A.sales.count, "order"), { useInnerText: false });
  await expect(cells.nth(1)).toHaveText(await fmtMoney(page, A.payments.totalCents) + "Payments" + plural(A.payments.count, "payment"), { useInnerText: false });
  await expect(cells.nth(2)).toHaveText(await fmtMoney(page, A.expenses.totalCents) + "Expenses" + plural(A.expenses.count, "expense"), { useInnerText: false });
  await expect(cells.nth(3)).toHaveText(await fmtMoney(page, A.deposits.totalCents) + "Deposits" + plural(A.deposits.count, "deposit"), { useInnerText: false });
  await expect(qb(page).locator("#qbDownloadNote")).toHaveText("");
  expect(await auditCount(api, "report.quickbooks_export")).toBe(audits);

  const { files, answer, body } = await download(page);
  expect(body).toMatchObject({ dateFrom: FROM, dateTo: TO, format: "online", parts: ["sales", "payments", "expenses", "deposits"] });
  expect(body.summaryOnly).toBeUndefined();
  expect(answer.summary).toEqual(A);
  expect(files.map(f => f.name)).toEqual(answer.files.map(f => f.filename));
  await expect(qb(page).locator("#qbFiles")).toContainText(`Saved ${answer.files.length} files (your browser may ask to allow several downloads):`);
  await expect(qb(page).locator("#qbFiles li")).toHaveCount(answer.files.length);
  expect(await auditCount(api, "report.quickbooks_export")).toBe(audits + 1);
  const entry = (await api("getAuditLog", { filter: "report.quickbooks_export", limit: 5 })).entries[0];
  expect(JSON.stringify(entry)).toContain(FROM);
  const range = `${FROM}-to-${TO}`;
  const file = (name) => { const f = files.find(x => x.name === name); expect(f, name + " was saved").toBeTruthy(); return parseCsv(f.text); };
  const mine = (rows, ids) => rows.filter(r => ids.some(id => r.join(",").includes(id)));

  // Sales receipts: one row per line; the order on the first moment of the 10th and the one on the last of the 11th, not
  // those just outside.
  const receipts = file(`odd-qbo-sales-${range}.csv`);
  expect(receipts[0]).toEqual(["SalesReceiptNo", "Customer", "SalesReceiptDate", "DepositTo", "Memo", "Item(Product/Service)", "ItemDescription", "ItemQuantity", "ItemRate", "ItemAmount", "Taxable"]);
  expect(receipts.every(r => r.length === 11)).toBe(true);
  const rows = mine(receipts.slice(1), [D.s0, D.s1, D.s2, D.s3, D.s4]);
  const tx = rows[0][10];
  expect(["Y", "N"]).toContain(tx);
  expect(rows).toEqual([
    [D.s1, D.c1, "05/10/2023", "Undeposited Funds:Example", D.shop.name, "Embroidery Sales", D.product, "2", "20.00", "40.00", tx],
    [D.s2, D.c2, "05/11/2023", "Undeposited Funds:Example", D.shop.name, "Embroidery Sales", D.product, "3", "20.00", "60.00", tx],
  ]);
  // Net 30: its own invoice file, with the due date and the PO.
  const invoices = file(`odd-qbo-invoices-${range}.csv`);
  expect(invoices[0]).toEqual(["InvoiceNo", "Customer", "InvoiceDate", "DueDate", "Terms", "Memo", "Item(Product/Service)", "ItemDescription", "ItemQuantity", "ItemRate", "ItemAmount", "Taxable"]);
  expect(mine(invoices.slice(1), [D.s4])).toEqual([[D.s4, D.c4, "05/11/2023", usDate(D.s4due), "Net 30", "PO PO-7001 - " + D.shop.name, "Embroidery Sales", D.product, "1", "20.00", "20.00", tx]]);

  // Bank files: Date, Description, Amount, one file per account under its QuickBooks name.
  const checkingSlug = ("business-checking-" + TAG).toLowerCase();
  const cashSlug = ("example-cash-box-" + TAG).toLowerCase();
  const bank = (name) => { const r = file(name); expect(r[0]).toEqual(["Date", "Description", "Amount"]); expect(r.every(x => x.length === 3)).toBe(true); return r.slice(1); };
  expect(bank(`odd-qbo-payments-${cashSlug}-${range}.csv`)).toEqual([["05/10/2023", `Payment - order ${D.s1} - ${D.c1} - cash`, "40.00"]]);
  expect(bank(`odd-qbo-payments-${checkingSlug}-${range}.csv`)).toEqual([
    ["05/11/2023", `Payment - order ${D.s2} - ${D.c2} - check - ${CHECK_NO}`, "60.00"],
    ["05/11/2023", `Refund - order ${D.s2} - ${D.c2} - check`, "-10.00"],
    ["05/11/2023", `Payment - order ${D.s4} - ${D.c4} - check`, "20.00"],
  ]);
  const cat = "Supplies:Thread " + TAG;
  expect(bank(`odd-qbo-expenses-${checkingSlug}-${range}.csv`)).toEqual([
    ["05/10/2023", `Example thread restock ${TAG} - ${cat} - Example thread restock ${TAG}`, "-25.50"],
    ["05/11/2023", `Example thread returned ${TAG} - ${cat} - Example thread returned ${TAG}`, "5.00"],
  ]);
  expect(bank(`odd-qbo-expenses-${("example-card-" + TAG).toLowerCase()}-${range}.csv`)).toEqual([["05/11/2023", `Example needles ${TAG} - ${cat} - Example needles ${TAG}`, "-12.00"]]);
  expect(bank(`odd-qbo-deposits-${checkingSlug}-${range}.csv`)).toEqual([["05/11/2023", `Deposit - Example cash deposit ${TAG}`, "40.00"]]);
  // Nothing of the days just outside, in any file.
  const all = files.map(f => f.text).join("\n");
  for (const out of [D.s0, D.s3, "Before " + TAG, "After " + TAG, "Example stabilizer " + TAG]) expect(all).not.toContain(out);

  // Save again: the same file once more.
  const again = page.waitForEvent("download");
  await qb(page).locator("#qbFiles li").first().getByRole("button", { name: "Save again" }).click();
  const d = await again;
  expect(d.suggestedFilename()).toBe(answer.files[0].filename);
  expect(fs.readFileSync(await d.path(), "utf8")).toBe(answer.files[0].text);
});

// ---- QuickBooks Desktop ------------------------------------------------------------------------------------------
test("QuickBooks Desktop: invoices under the shop's name, the format remembered, one balanced .iif with every part", async ({ page, api }) => {
  test.setTimeout(120_000);
  await openQb(page);
  const map = qb(page).locator("#qbMap");
  // Sales go in as invoices, under the shop's name.
  await map.getByRole("radio", { name: "Invoices" }).check();
  await map.getByRole("radio", { name: "Shop", exact: true }).check();
  const ans = answerOf(page, "updateQuickBooksSettings");
  await map.getByRole("button", { name: "Save mapping" }).click();
  expect(actionOf((await ans).request()).settings).toMatchObject({ salesAs: "invoices", customerName: "shop" });
  await expect(toast(page)).toContainText("QuickBooks account mapping saved.");
  // The format: saved quietly for next time (and for everyone).
  const fmt = answerOf(page, "updateQuickBooksSettings");
  await qb(page).getByRole("radio", { name: /QuickBooks Desktop/ }).check();
  expect(actionOf((await fmt).request()).settings).toMatchObject({ format: "desktop", salesAs: "invoices", customerName: "shop", accounts: { sales: "Embroidery Sales" } });
  await expect(qb(page).locator("#qbHowTo")).toContainText("QuickBooks Desktop: File ▸ Utilities ▸ Import ▸ IIF Files");
  expect((await api("getQuickBooksSettings")).settings).toMatchObject({ format: "desktop", salesAs: "invoices", customerName: "shop" });
  // A reload finds Desktop chosen, and Invoices and Shop.
  await leaveAdmin(page);
  await openQb(page);
  await expect(qb(page).getByRole("radio", { name: /QuickBooks Desktop/ })).toBeChecked();
  await expect(map.getByRole("radio", { name: "Invoices" })).toBeChecked();
  await expect(map.getByRole("radio", { name: "Shop", exact: true })).toBeChecked();
  // Choosing the one already saved asks nothing.
  let sent = 0;
  const count = (r) => { if (r.url().endsWith("/api/orders") && actionOf(r).action === "updateQuickBooksSettings") sent++; };
  page.on("request", count);
  await setRange(page, FROM, TO);
  const { files, answer, body } = await download(page);
  page.off("request", count);
  expect(sent).toBe(0);
  expect(body).toMatchObject({ format: "desktop", dateFrom: FROM, dateTo: TO });
  expect(files.map(f => f.name)).toEqual([`odd-quickbooks-${FROM}-to-${TO}.iif`]);
  expect(answer.files[0].mime).toBe("application/octet-stream");
  await expect(qb(page).locator("#qbFiles")).toContainText("Saved:");

  const { header, blocks } = parseIif(files[0].text);
  expect(header).toEqual([
    "!TRNS\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM\tMEMO\tCLEAR\tDUEDATE\tTERMS",
    "!SPL\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM\tMEMO\tCLEAR\tQNTY\tPRICE",
    "!ENDTRNS",
  ]);
  const by = (doc) => blocks.filter(b => b.trns.DOCNUM === doc);
  const one = (doc) => { const l = by(doc); expect(l, "one transaction " + doc).toHaveLength(1); return l[0]; };
  const shop = D.shop.name, bankName = "Business Checking " + TAG;
  // Sales: an INVOICE each (Accounts Receivable), crediting the mapped Sales account, under the shop's name.
  const inv1 = one(docnum(D.s1));
  expect(inv1.trns).toMatchObject({ TRNSTYPE: "INVOICE", DATE: "05/10/2023", ACCNT: "Accounts Receivable", NAME: shop, AMOUNT: "40.00", MEMO: "Order " + D.s1, CLEAR: "N", TERMS: "Due on receipt", DUEDATE: "" });
  expect(inv1.spl).toEqual([{ "!SPL": "SPL", TRNSTYPE: "INVOICE", DATE: "05/10/2023", ACCNT: "Embroidery Sales", NAME: shop, AMOUNT: "-40.00", DOCNUM: docnum(D.s1), MEMO: D.product, CLEAR: "N", QNTY: "-2", PRICE: "20.00" }]);
  expect(brief(one(docnum(D.s2)))).toBe(["INVOICE", "05/11/2023", "Accounts Receivable", shop, "60.00", "Embroidery Sales -60.00"].join(" | "));
  const inv4 = one(docnum(D.s4));
  expect(inv4.trns).toMatchObject({ TRNSTYPE: "INVOICE", DATE: "05/11/2023", AMOUNT: "20.00", MEMO: "Order " + D.s4 + " - PO PO-7001", TERMS: "Net 30", DUEDATE: usDate(D.s4due) });
  expect(by(docnum(D.s0))).toHaveLength(0);
  expect(by(docnum(D.s3))).toHaveLength(0);
  // Payments: cash waits in Undeposited Funds; a check went straight to the bank; the refund came out of it.
  expect(brief(one("PAY" + D.p1))).toBe(["PAYMENT", "05/10/2023", "Undeposited Funds:Example", shop, "40.00", "Accounts Receivable -40.00"].join(" | "));
  expect(brief(one(CHECK_NO))).toBe(["PAYMENT", "05/11/2023", bankName, shop, "60.00", "Accounts Receivable -60.00"].join(" | "));
  expect(one(CHECK_NO).trns.MEMO).toBe(`Payment - order ${D.s2} - check - ${CHECK_NO}`);
  expect(brief(one("PAY" + D.p3))).toBe(["GENERAL JOURNAL", "05/11/2023", bankName, shop, "-10.00", "Embroidery Sales 10.00"].join(" | "));
  expect(brief(one("PAY" + D.p4))).toBe(["PAYMENT", "05/11/2023", bankName, shop, "20.00", "Accounts Receivable -20.00"].join(" | "));
  expect(by("PAY" + D.p0)).toHaveLength(0);
  // Expenses: a CHECK from the bank, a CREDIT CARD charge, the vendor refund back into the bank.
  const cat = "Supplies:Thread " + TAG;
  expect(brief(one("EXP" + D.e1))).toBe(["CHECK", "05/10/2023", bankName, "Example thread restock " + TAG, "-25.50", cat + " 25.50"].join(" | "));
  expect(brief(one("EXP" + D.e2))).toBe(["CREDIT CARD", "05/11/2023", D.card.name, "Example needles " + TAG, "-12.00", cat + " 12.00"].join(" | "));
  expect(brief(one("EXP" + D.e3))).toBe(["DEPOSIT", "05/11/2023", bankName, "Example thread returned " + TAG, "5.00", cat + " -5.00"].join(" | "));
  expect(by("EXP" + D.e4)).toHaveLength(0);
  // The cash taken to the bank: out of Undeposited Funds.
  const dep = one("DEP" + D.dep);
  expect(brief(dep)).toBe(["DEPOSIT", "05/11/2023", bankName, "", "40.00", "Undeposited Funds:Example -40.00"].join(" | "));
  expect(dep.trns.MEMO).toBe("Deposit - Example cash deposit " + TAG);

  // Only some parts: the file holds only those.
  await qb(page).locator('[data-qb-part="sales"]').uncheck();
  await qb(page).locator('[data-qb-part="payments"]').uncheck();
  const cells = qb(page).locator("#qbSummary .gc-total");
  await expect(cells.nth(0)).toContainText("Not exported");
  await expect(cells.nth(0)).toHaveAttribute("style", /opacity/);
  await expect(cells.nth(2)).not.toHaveAttribute("style", /opacity/);
  const part = await download(page);
  expect(part.body.parts).toEqual(["expenses", "deposits"]);
  const p = parseIif(part.files[0].text);
  expect(p.blocks.some(b => b.trns.TRNSTYPE === "INVOICE" || b.trns.TRNSTYPE === "PAYMENT")).toBe(false);
  expect(p.blocks.filter(b => ["EXP" + D.e1, "DEP" + D.dep].includes(b.trns.DOCNUM))).toHaveLength(2);
});

// ---- The page's controls and messages ----------------------------------------------------------------------------
test("Presets, the parts ticks, a bad range, an empty range, and the load, summary and download errors", async ({ page, api }) => {
  test.setTimeout(120_000);
  await openQb(page);
  const today = await page.evaluate(() => localToday_());
  const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7));
  const presets = [["This month", today.slice(0, 7) + "-01", today],
    ["Last month", await page.evaluate((t) => addMonths_(t.slice(0, 7), -1) + "-01", today), await page.evaluate((t) => addDays_(t.slice(0, 7) + "-01", -1), today)],
    ["This quarter", `${y}-${String(Math.floor((m - 1) / 3) * 3 + 1).padStart(2, "0")}-01`, today],
    ["Last year", `${y - 1}-01-01`, `${y - 1}-12-31`]];
  for (const [label, from, to] of presets) {
    const ans = summaryAnswer(page);
    await qb(page).getByRole("button", { name: label, exact: true }).click();
    expect(actionOf((await ans).request())).toMatchObject({ dateFrom: from, dateTo: to });
    await expect(qb(page).getByLabel("From", { exact: true })).toHaveValue(from);
    await expect(qb(page).getByLabel("To", { exact: true })).toHaveValue(to);
  }
  // From after To: said on the page, nothing asked, no Download.
  let asked = 0;
  const count = (r) => { if (r.url().endsWith("/api/orders") && actionOf(r).action === "getQuickBooksExport") asked++; };
  page.on("request", count);
  await qb(page).getByLabel("From", { exact: true }).fill("2023-06-01");
  await qb(page).getByLabel("To", { exact: true }).fill("2023-05-01");
  await expect(qb(page).locator("#qbSummary [role=alert]")).toHaveText("The From date is after the To date.");
  await expect(qb(page).getByRole("button", { name: "Download", exact: true })).toBeDisabled();
  page.off("request", count);
  expect(asked).toBe(1);   // only the From change, before the To was wrong

  // An empty range: zeros, "Nothing in these dates", and a Download that says so.
  await setRange(page, "2020-01-02", "2020-01-02");
  const zero = await summaryOf(api, "2020-01-02", "2020-01-02");
  test.skip(Object.values(zero).some(x => x.count), "another spec left data on 2020-01-02");
  await expect(qb(page).locator("#qbDownloadNote")).toHaveText("Nothing in these dates for the ticked parts.");
  await expect(qb(page).locator("#qbSummary .gc-total").nth(0)).toContainText("0 orders");
  await expect(qb(page).locator("#qbSummary .gc-total").nth(3)).toContainText("0 deposits");
  // QuickBooks Desktop (saved by the test before): a .iif with the headers only.
  await expect(qb(page).getByRole("radio", { name: /QuickBooks Desktop/ })).toBeChecked();
  let empty = await download(page);
  expect(empty.files).toHaveLength(1);
  expect(parseIif(empty.files[0].text).blocks).toEqual([]);
  // QuickBooks Online (chosen again, and saved): no file at all, and the page says so.
  const fmt = answerOf(page, "updateQuickBooksSettings");
  await qb(page).getByRole("radio", { name: /QuickBooks Online/ }).check();
  expect(actionOf((await fmt).request()).settings.format).toBe("online");
  await expect(qb(page).locator("#qbFiles")).toBeEmpty();
  empty = await download(page);
  expect(empty.files).toEqual([]);
  await expect(qb(page).locator("#qbFiles")).toHaveText("Nothing to export in these dates.");

  // The parts: one ticked is counted, none ticked can't be downloaded.
  for (const p of ["sales", "payments", "expenses", "deposits"]) await qb(page).locator(`[data-qb-part="${p}"]`).uncheck();
  await expect(qb(page).locator("#qbDownloadNote")).toHaveText("Tick at least one part.");
  await expect(qb(page).getByRole("button", { name: "Download", exact: true })).toBeDisabled();
  await expect(qb(page).locator("#qbSummary .gc-total-note")).toHaveText(["Not exported", "Not exported", "Not exported", "Not exported"]);
  await qb(page).locator('[data-qb-part="deposits"]').check();
  await expect(qb(page).locator("#qbSummary .gc-total-note")).toHaveText(["Not exported", "Not exported", "Not exported", "0 deposits"]);
  await expect(qb(page).getByRole("button", { name: "Download", exact: true })).toBeEnabled();

  // A summary the server refuses: its words.
  await page.route("**/api/orders", async (route) => {
    const b = actionOf(route.request());
    if (b.action !== "getQuickBooksExport") return route.continue();
    await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ status: "error", message: b.summaryOnly ? "Pick at most three years." : "The QuickBooks file doesn't balance (X1). Nothing was exported." }) });
  });
  await qb(page).getByLabel("To", { exact: true }).fill("2020-01-03");
  await expect(qb(page).locator("#qbSummary [role=alert]")).toHaveText("Pick at most three years.");
  await page.unroute("**/api/orders");
  // A download the server refuses: a toast, the button back.
  await setRange(page, FROM, TO);
  await page.route("**/api/orders", async (route) => {
    const b = actionOf(route.request());
    if (b.action !== "getQuickBooksExport" || b.summaryOnly) return route.continue();
    await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ status: "error", message: "The QuickBooks file doesn't balance (X1). Nothing was exported." }) });
  });
  await qb(page).getByRole("button", { name: "Download", exact: true }).click();
  await expect(toast(page)).toContainText("Couldn't build the export: The QuickBooks file doesn't balance (X1). Nothing was exported.");
  await expect(qb(page).getByRole("button", { name: "Download", exact: true })).toBeEnabled();
  await expect(qb(page).locator("#qbDownloadNote")).toHaveText("");
  await page.unroute("**/api/orders");

  // A slower, older summary never replaces a newer one.
  let release; const held = new Promise(r => { release = r; });
  await page.route("**/api/orders", async (route) => {
    const b = actionOf(route.request());
    if (b.action === "getQuickBooksExport" && b.summaryOnly && b.dateFrom === "2020-01-02") { await held; }
    return route.continue();
  });
  await qb(page).locator('[data-qb-part="sales"]').check();
  await qb(page).getByLabel("From", { exact: true }).fill("2020-01-02");   // 2020-01-02..TO: held back
  await qb(page).getByLabel("From", { exact: true }).fill(FROM);           // FROM..TO: answered at once
  const fresh = await fmtMoney(page, D.after.sales.totalCents);
  await expect(qb(page).locator("#qbSummary .gc-total").nth(0)).toContainText(fresh);
  await expect(qb(page).locator("#qbSummary .gc-total").nth(0)).toContainText(D.after.sales.count + " order");
  const stale = page.waitForResponse(r => r.url().endsWith("/api/orders") && actionOf(r.request()).dateFrom === "2020-01-02");
  release();
  await stale;
  await page.waitForTimeout(300);
  await expect(qb(page).locator("#qbSummary .gc-total").nth(0)).toContainText(fresh);
  await page.unroute("**/api/orders");

  // The settings the page couldn't load: the server's words where the mapping goes.
  await leaveAdmin(page);
  await page.route("**/api/orders", async (route) => {
    if (actionOf(route.request()).action !== "getQuickBooksSettings") return route.continue();
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ status: "error", message: "Couldn't read the settings." }) });
  });
  await page.goto(ADMIN + "/#quickbooks");
  await expect(qb(page).locator("#qbMap [role=alert]")).toHaveText("Couldn't read the settings.");
  await expect(qb(page).locator("#qbSummary .gc-total")).toHaveCount(4);
  await page.unroute("**/api/orders");

  // A server that sends the settings without the app's accounts and categories: the page asks for the lists itself.
  await leaveAdmin(page);
  await page.route("**/api/orders", async (route) => {
    if (actionOf(route.request()).action !== "getQuickBooksSettings") return route.continue();
    const res = await route.fetch();
    const j = await res.json();
    delete j.accounts; delete j.categories;
    await route.fulfill({ response: res, body: JSON.stringify(j) });
  });
  const lists = Promise.all([answerOf(page, "listAccounts"), answerOf(page, "listExpenseCategories")]);
  await page.goto(ADMIN + "/#quickbooks");
  await lists;
  await expect(qb(page).locator(`[data-qb-bank="${D.checking.id}"]`)).toHaveValue("Business Checking " + TAG);
  await expect(qb(page).locator(`[data-qb-cat="${D.cat.id}"]`)).toHaveValue("Supplies:Thread " + TAG);
  await page.unroute("**/api/orders");

  // The page's own file that couldn't load.
  await leaveAdmin(page);
  await page.route("**/admin-quickbooks.js*", (route) => route.abort());
  await page.goto(ADMIN + "/#quickbooks");
  await expect(page.locator("#app")).toContainText("Couldn't load the QuickBooks export page. Check your connection and reload the page.");
  await expect(page).toHaveTitle(/QuickBooks export/);
  await expect(qb(page)).toHaveCount(0);
  await page.unroute("**/admin-quickbooks.js*");
});

test("The server refuses bad dates, a range over three years, a bad format or part, and a bad name", async ({ api }) => {
  const call = (action, body) => api(action, body, { allowError: true, withStatus: true });
  const err = (status, message) => ({ status, data: { status: "error", message } });
  expect(await call("getQuickBooksExport", { dateFrom: "05/10/2023", dateTo: TO })).toEqual(err(400, "Invalid date range — expected YYYY-MM-DD"));
  expect(await call("getQuickBooksExport", { dateFrom: TO, dateTo: FROM })).toEqual(err(400, "The start date is after the end date."));
  expect(await call("getQuickBooksExport", { dateFrom: "2023-01-01", dateTo: "2026-01-01" })).toEqual(err(400, "Pick at most three years."));
  expect((await call("getQuickBooksExport", { dateFrom: "2023-01-01", dateTo: "2025-12-31", summaryOnly: true })).status).toBe(200);
  expect(await call("getQuickBooksExport", { dateFrom: FROM, dateTo: TO, format: "xero" })).toEqual(err(400, "Choose QuickBooks Online or QuickBooks Desktop."));
  for (const parts of [[], ["sales", "taxes"], "sales"]) {
    expect(await call("getQuickBooksExport", { dateFrom: FROM, dateTo: TO, parts })).toEqual(err(400, "Pick what to export: sales, payments, expenses or deposits."));
  }
  // Parts in any order come back in the usual one; no format = the saved one.
  const ok = await api("getQuickBooksExport", { dateFrom: FROM, dateTo: TO, parts: ["deposits", "sales", "deposits"], summaryOnly: true });
  expect(ok).toMatchObject({ parts: ["sales", "deposits"], format: (await api("getQuickBooksSettings")).settings.format });
  expect(ok.files).toBeUndefined();
  // The mapping.
  expect(await call("updateQuickBooksSettings", { settings: { accounts: { sales: "Embroidery\tSales" } } })).toEqual(err(400, "Sales: QuickBooks names can't have tabs or line breaks."));
  expect(await call("updateQuickBooksSettings", { settings: { accounts: { ar: "A".repeat(101) } } })).toEqual(err(400, "Accounts receivable: a QuickBooks name can be at most 100 characters."));
  expect(await call("updateQuickBooksSettings", { settings: { format: "xero" } })).toEqual(err(400, "Pick QuickBooks Online or QuickBooks Desktop."));
  expect(await call("updateQuickBooksSettings", { settings: { salesAs: "bills" } })).toEqual(err(400, "Sales go in as sales receipts or invoices."));
  expect(await call("updateQuickBooksSettings", { settings: { customerName: "email" } })).toEqual(err(400, "Name the customer by the customer or by the shop."));
  expect(await call("updateQuickBooksSettings", { settings: { bankAccounts: { [D.checking.id]: "Line\nbreak" } } })).toEqual(err(400, D.checking.name + ": QuickBooks names can't have tabs or line breaks."));
  // An unknown account id is dropped; an empty name goes back to the default.
  const r = await api("updateQuickBooksSettings", { settings: { accounts: { postage: "  " }, bankAccounts: { "99999999": "Nowhere" } } });
  expect(r.settings.accounts.postage).toBe("Postage and Delivery");
  expect(r.settings.bankAccounts["99999999"]).toBeUndefined();
  expect(r.settings.accounts.sales).toBe("Embroidery Sales");
});

// ---- Roles -------------------------------------------------------------------------------------------------------
test("Back office reads the page and downloads, the mapping read-only; Manager may change it; Production has nothing", async ({ api, as }, testInfo) => {
  test.setTimeout(120_000);
  const page = await as("staff");
  await openQb(page);
  const map = qb(page).locator("#qbMap");
  await expect(qb(page)).toContainText("You can see the mapping; changing it needs Edit on QuickBooks export.");
  await expect(map.getByLabel("Sales", { exact: true })).toHaveValue("Embroidery Sales");
  await expect(map.getByLabel("Sales", { exact: true })).toBeDisabled();
  await expect(map.locator(`[data-qb-bank="${D.checking.id}"]`)).toBeDisabled();
  await expect(map.getByRole("radio", { name: "Invoices" })).toBeDisabled();
  await expect(map.getByRole("button", { name: "Save mapping" })).toHaveCount(0);
  // Choosing a format is for this download only: nothing saved.
  let sent = 0;
  const count = (r) => { if (r.url().endsWith("/api/orders") && actionOf(r).action === "updateQuickBooksSettings") sent++; };
  page.on("request", count);
  const before = (await api("getQuickBooksSettings")).settings.format;
  const other = before === "desktop" ? /QuickBooks Online/ : /QuickBooks Desktop/;
  await qb(page).getByRole("radio", { name: other }).check();
  await setRange(page, FROM, TO);
  const { files, body } = await download(page);
  page.off("request", count);
  expect(sent).toBe(0);
  expect(body.format).toBe(before === "desktop" ? "online" : "desktop");
  expect(files.length).toBeGreaterThan(0);
  expect((await api("getQuickBooksSettings")).settings.format).toBe(before);
  const staff = await asApi("staff", testInfo.workerIndex, async (call) => ({
    read: await call("getQuickBooksSettings", {}),
    write: await call("updateQuickBooksSettings", { settings: { salesAs: "receipts" } }),
  }));
  expect(staff.read.status).toBe(200);
  expect(staff.read.data.accounts.some(a => a.id === D.checking.id)).toBe(true);
  expect(staff.write.status).toBe(403);
  expect(staff.write.data.status).toBe("error");
  expect((await api("getQuickBooksSettings")).settings.salesAs).toBe("invoices");

  // Manager: the Save button, and the server takes a change.
  const mp = await as("manager");
  await openQb(mp);
  await expect(qb(mp).locator("#qbMap").getByRole("button", { name: "Save mapping" })).toBeVisible();
  await expect(qb(mp).locator("#qbMap").getByLabel("Sales", { exact: true })).toBeEnabled();
  const mgr = await asApi("manager", testInfo.workerIndex, (call) => call("updateQuickBooksSettings", { settings: { accounts: { postage: "Postage " + TAG } } }));
  expect(mgr.status).toBe(200);
  expect(mgr.data.settings.accounts.postage).toBe("Postage " + TAG);

  // Production: no menu item, and the server refuses all three.
  const pp = await as("production");
  await openAdmin(pp, "home");
  await expect(pp.getByRole("navigation", { name: "Admin" }).locator('button[data-h="quickbooks"]')).toHaveCount(0);
  const prod = await asApi("production", testInfo.workerIndex, async (call) => [
    await call("getQuickBooksSettings", {}), await call("updateQuickBooksSettings", { settings: { salesAs: "receipts" } }),
    await call("getQuickBooksExport", { dateFrom: FROM, dateTo: TO, summaryOnly: true })]);
  for (const r of prod) { expect(r.status).toBe(403); expect(r.data.status).toBe("error"); }
});

// ---- Bookkeeping switched off -------------------------------------------------------------------------------------
test("Bookkeeping switched off in Global settings: no QuickBooks export in the menu, the page says it's off, the server refuses", async ({ page, api }) => {
  test.setTimeout(120_000);
  await openAdmin(page, "settings");
  const box = page.locator("#gFeatRow-bookkeeping .gFeature");
  await expect(box).toBeChecked();
  const nav = page.getByRole("navigation", { name: "Admin" });
  await expect(nav.locator('button[data-h="quickbooks"]')).not.toHaveCount(0);
  try {
    await box.uncheck();
    await page.getByRole("button", { name: "Save global settings" }).click();
    await expect(toast(page)).toContainText("Global settings saved.");
    expect((await api("getFeatures")).features.bookkeeping).toBe(false);
    await openAdmin(page, "quickbooks");
    await expect(page.locator("#featureOffPanel")).toHaveAttribute("data-feature", "bookkeeping");
    await expect(page.locator("#featureOffPanel")).toContainText("Bookkeeping is turned off.");
    await expect(page).toHaveTitle(/Bookkeeping is turned off/);
    await expect(qb(page)).toHaveCount(0);
    await expect(nav.locator('button[data-h="quickbooks"]')).toHaveCount(0);
    for (const [action, body] of [["getQuickBooksSettings", {}], ["updateQuickBooksSettings", { settings: { salesAs: "receipts" } }],
      ["getQuickBooksExport", { dateFrom: FROM, dateTo: TO }]]) {
      const r = await api(action, body, { allowError: true, withStatus: true });
      expect(r.status, action).toBe(403);
      expect(r.data, action).toMatchObject({ status: "error", feature: "bookkeeping" });
    }
  } finally {
    if ((await api("getFeatures")).features.bookkeeping === false) await api("updateFeatures", { features: { bookkeeping: true } });
  }
  // On again: the page is back with the mapping as it was.
  await openQb(page);
  await expect(qb(page).locator("#qbMap").getByLabel("Sales", { exact: true })).toHaveValue("Embroidery Sales");
});
