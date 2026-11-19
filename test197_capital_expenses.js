const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// Capital purchases apart from running costs (migrations/0092). A category marked capital — equipment, tools — is
// still an expense in the books and deducted as its deduction type says, but Home keeps it out of operating profit:
// one "Capital purchases" slice in the pies, its own part of the Money out bars, and the shop rate spreads it over a
// life instead of counting it as a running cost. Real SQL (sql.js) + real db.js.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const lib = new Function(strip(read("functions/_lib/db.js")) + "\nreturn { getDashboardMoney, getMoneyInOutByMonth, computeShopRate, listExpenseCategories, saveExpenseCategory, getExpenseSummary, setFeatures };")();

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const run = (sql, p = []) => d1._raw.run(sql, p);
  const one = (sql, p = []) => { const r = d1._raw.exec(sql, p); return r.length ? r[0].values[0][0] : null; };

  console.log("=== Migration 0092 ===");
  const cats = await lib.listExpenseCategories(d1);
  const by = (n) => cats.find(c => c.name === n);
  console.log("Equipment & machines (Depreciation) is capital:", by("Equipment & machines").capital === true && one("SELECT capital FROM expense_categories WHERE name = 'Equipment & machines'") === 1);
  console.log("Small equipment & tools is added: deducted now, line 22, capital:", by("Small equipment & tools") && by("Small equipment & tools").deductionType === "deductible"
    && by("Small equipment & tools").scheduleCLine === "22" && by("Small equipment & tools").capital === true);
  console.log("every other category is a running cost:", cats.filter(c => c.capital).map(c => c.name).sort().join() === "Equipment & machines,Small equipment & tools");

  console.log("\n=== Saving a category (db.js) ===");
  const id = await lib.saveExpenseCategory(d1, 0, { name: "Gear", deductionType: "depreciation", scheduleCLine: "13", deductiblePct: 100, capital: false });
  console.log("Depreciation is saved as capital whatever is asked:", one("SELECT capital FROM expense_categories WHERE id = ?", [id]) === 1);
  await lib.saveExpenseCategory(d1, id, { name: "Gear", deductionType: "deductible", scheduleCLine: "22", deductiblePct: 100, capital: false });
  console.log("…and a Deductible one can be a running cost:", one("SELECT capital FROM expense_categories WHERE id = ?", [id]) === 0);
  run("DELETE FROM expense_categories WHERE id = ?", [id]);

  // This year: $100 thread (running), a $900 machine (small equipment, deducted now), a $5,000 machine (depreciated),
  // $50 sales tax paid to the state, and $2,000 other income. All in March.
  const cid = (n) => one("SELECT id FROM expense_categories WHERE name = ?", [n]);
  const supplies = cid("Supplies (thread, stabilizer, needles)"), small = cid("Small equipment & tools"), big = cid("Equipment & machines");
  const taxCat = one("SELECT id FROM expense_categories WHERE systemKey = 'sales_tax_paid'");
  run(`INSERT INTO expenses (expenseDate, description, categoryId, amountCents, createdAt, updatedAt) VALUES
    ('2026-03-02', 'Thread', ?, 10000, 't', 't'), ('2026-03-03', 'Heat press', ?, 90000, 't', 't'),
    ('2026-03-04', 'Embroidery machine', ?, 500000, 't', 't'), ('2026-03-05', 'Sales tax', ?, 5000, 't', 't')`, [supplies, small, big, taxCat]);
  run("INSERT INTO accounts (name, type, createdAt, updatedAt) VALUES ('Test bank', 'checking', 't', 't')");
  run("INSERT INTO other_income (incomeDate, description, type, amountCents, accountId, createdAt, updatedAt) VALUES ('2026-03-10', 'Repair', 'service', 200000, 1, 't', 't')");

  console.log("\n=== Home's totals and pies (getDashboardMoney) ===");
  const m = await lib.getDashboardMoney(d1, { yearFrom: "2026-01-01", monthFrom: "2026-03-01", to: "2026-03-31" });
  const y = m.year;
  console.log("Expenses still counts everything:", y.expenses === 100 + 900 + 5000 + 50);
  console.log("capital purchases: both machines, whichever way they're deducted:", y.capital === 5900);
  console.log("sales tax paid is named (revenue is already less tax):", y.taxPaid === 50);
  console.log("running costs leave out capital and sales tax paid:", y.operatingExpenses === 100);
  console.log("operating profit = revenue − running costs:", y.revenue === 2000 && y.operatingProfit === 1900);
  const slices = y.byType.map(s => s.name + " " + s.amount).join(", ");
  console.log("pie: running-cost categories, then one Capital purchases slice last:", y.byType[y.byType.length - 1].key === "capital"
    && !y.byType.some(s => s.id === small || s.id === big) && /^Supplies .* 100, Sales tax paid to the state 50, Capital purchases 5900$/.test(slices));
  const cap = y.byType.find(s => s.key === "capital");
  console.log("the capital slice names its categories, largest first:", cap.parts.map(p => p.name + " " + p.amount).join() === "Equipment & machines 5000,Small equipment & tools 900");
  console.log("the slices still add up to Expenses:", y.byType.reduce((t, s) => t + s.amount, 0) === y.expenses);
  console.log("the month agrees:", m.month.capital === 5900 && m.month.operatingProfit === 1900);

  // A capital refund larger than what was bought in the period: no slice, named instead.
  run("INSERT INTO expenses (expenseDate, description, categoryId, amountCents, createdAt, updatedAt) VALUES ('2026-04-02', 'Press returned', ?, -90000, 'r', 'r')", [small]);
  const apr = await lib.getDashboardMoney(d1, { yearFrom: "2026-04-01", monthFrom: "2026-04-01", to: "2026-04-30" });
  console.log("more capital refunded than bought: no slice, named, and operating profit untouched:", !apr.year.byType.some(s => s.key === "capital")
    && apr.year.refundedTypes.includes("capital purchases") && apr.year.capital === -900 && apr.year.operatingProfit === 0);
  run("DELETE FROM expenses WHERE createdAt = 'r'");

  console.log("\n=== Money in and out (getMoneyInOutByMonth) ===");
  const io = await lib.getMoneyInOutByMonth(d1, { yearFrom: "2026-01-01", to: "2026-03-31" });
  const mar = io.months[2];
  console.log("March out: running expenses, capital purchases and sales tax paid, each on its own:", mar.out.expenses === 100 && mar.out.capital === 5900 && mar.out.taxPaid === 50
    && mar.totalOut === 6050);
  console.log("the year's capital purchases are given:", io.capital === 5900);

  console.log("\n=== Tax side unchanged (getExpenseSummary) ===");
  const sum = await lib.getExpenseSummary(d1, "2026-01-01", "2026-12-31");
  console.log("the small machine is deducted now; only the big one is depreciated:", sum.totals.deductible === 1000 && sum.totals.capital === 5000);

  console.log("\n=== Shop rate (computeShopRate) ===");
  const sr = await lib.computeShopRate(d1, { period: "2026", hoursPerWeek: 40, weeksPerYear: 50 }, { today: new Date("2026-06-01T12:00:00Z") });
  console.log("the small machine is equipment spread over a life, not a running cost:", sr.equipment.map(e => e.description).sort().join() === "Embroidery machine,Heat press"
    && !sr.running.some(c => c.categoryId === small) && sr.equipment.find(e => e.description === "Heat press").perYearCents === 18000);

  console.log("\n=== Bookkeeping off ===");
  await lib.setFeatures(d1, { bookkeeping: false });
  const off = await lib.getDashboardMoney(d1, { yearFrom: "2026-01-01", monthFrom: "2026-03-01", to: "2026-03-31" });
  console.log("no recorded expenses, so no capital or tax paid:", off.year.capital === 0 && off.year.taxPaid === 0 && off.year.operatingExpenses === 0);
})().catch(e => { console.log("test197 crashed:", false); console.error(e); process.exit(1); });
