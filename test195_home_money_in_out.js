const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// Home's "Money in and out" (2026-11, db.js getMoneyInOutByMonth): cash by month, by the day the money moved.
// Sales tax collected is money in (its own part), sales tax paid to the state is money out — expenses in the
// built-in category from migrations/0090. Owner money counts, each way. Real SQL (sql.js) + real db.js.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const lib = new Function(strip(read("functions/_lib/db.js")) + "\nreturn { insertOrder, getMoneyInOutByMonth, setFeatures, deleteExpenseCategory, listExpenseCategories, getDashboard };")();

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('prime','prime','Example League','t','t');`);
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const run = (sql, p = []) => d1._raw.run(sql, p);
  const one = (sql, p = []) => { const r = d1._raw.exec(sql, p); return r.length ? r[0].values[0][0] : null; };

  console.log("=== The built-in category (migrations/0090) ===");
  const taxCat = one("SELECT id FROM expense_categories WHERE systemKey = 'sales_tax_paid'");
  console.log("a 'Sales tax paid to the state' category is there, not deductible:", !!taxCat
    && one("SELECT name FROM expense_categories WHERE id = ?", [taxCat]) === "Sales tax paid to the state"
    && one("SELECT deductionType FROM expense_categories WHERE id = ?", [taxCat]) === "none");
  console.log("it can't be deleted, even unused:", (await lib.deleteExpenseCategory(d1, taxCat)) === false && !!one("SELECT id FROM expense_categories WHERE id = ?", [taxCat]));
  console.log("the category list says which one it is:", (await lib.listExpenseCategories(d1)).filter(c => c.systemKey).map(c => c.id).join() === String(taxCat));
  run("UPDATE expense_categories SET name = 'State sales tax' WHERE id = ?", [taxCat]);   // renamed: still found by its key
  const otherCat = one("SELECT id FROM expense_categories WHERE systemKey IS NULL AND capital = 0 ORDER BY id LIMIT 1");

  // Orders: one line each. A ($107 with $7 tax inside, inclusive); B ($100 + $7 tax on top + $10 shipping = $117); a test order.
  const order = async (orderId, extra = {}) => lib.insertOrder(d1, Object.assign({ orderId, orgId: "prime", customerName: "C", contact: orderId + "@x.com",
    paymentMethod: "Venmo", placedAt: "2026-01-10T12:00:00.000Z" }, extra), [{ productId: "", name: "Polo", type: "shirt", size: "L", qty: 1, unitPrice: 1 }]);
  await order("A"); await order("B"); await order("T1", { isTest: true }); await order("V1");
  run("UPDATE order_items SET lineTotalCents = 10700, taxCents = 700, taxable = 1 WHERE orderId IN ('A', 'T1', 'V1')");
  run("UPDATE order_items SET lineTotalCents = 10000, taxCents = 700, taxable = 1 WHERE orderId = 'B'");
  run("UPDATE orders SET taxMode = 'exclusive', shippingCostCents = 1000 WHERE orderId = 'B'");
  run("UPDATE orders SET voidedAt = '2026-02-02T00:00:00.000Z' WHERE orderId = 'V1'");
  const pay = (orderId, cents, at, extra = "") => run(`INSERT INTO order_payments (orderId, amountCents, receivedAt, method, kind, feeCents, shippingCents${extra ? ", voidedAt" : ""}) VALUES (?, ?, ?, 'card', ?, ?, ?${extra ? ", ?" : ""})`,
    [orderId, cents, at, cents < 0 ? "refund" : "payment", cents > 0 ? 300 : 0, 0, ...(extra ? [extra] : [])]);
  pay("A", 10700, "2026-02-05T15:00:00.000Z");
  pay("B", 11700, "2026-03-09T15:00:00.000Z");
  pay("B", -1070, "2026-04-01T15:00:00.000Z");                    // a tenth of the goods back, with their tax
  pay("A", 5000, "2026-03-01T15:00:00.000Z", "2026-03-02T00:00:00.000Z");   // voided: left out
  pay("T1", 10700, "2026-02-05T15:00:00.000Z");                   // test order: left out
  pay("V1", 10700, "2026-02-05T15:00:00.000Z");                   // voided order: left out
  pay("A", 999, "2025-12-31T15:00:00.000Z");                      // last year: left out

  run("INSERT INTO accounts (name, type, createdAt, updatedAt) VALUES ('Test bank', 'checking', 't', 't'), ('Test cash', 'checking', 't', 't')");
  const bank = one("SELECT id FROM accounts WHERE name = 'Test bank'"), cash = one("SELECT id FROM accounts WHERE name = 'Test cash'");
  run("INSERT INTO other_income (incomeDate, description, type, amountCents, accountId, createdAt, updatedAt) VALUES ('2026-01-20', 'Repair', 'service', 5000, ?, 't', 't')", [bank]);
  run("INSERT INTO owner_transactions (txDate, kind, amountCents, accountId, createdAt, updatedAt) VALUES ('2026-01-02', 'contribution', 200000, ?, 't', 't'), ('2026-06-30', 'draw', 50000, ?, 't', 't')", [bank, bank]);
  run("INSERT INTO account_transfers (transferDate, fromAccountId, toAccountId, amountCents, createdAt, updatedAt) VALUES ('2026-06-15', ?, ?, 9900, 't', 't')", [cash, bank]);
  run("INSERT INTO inventory_movements (blankId, qtyDelta, unitCostCents, kind, occurredAt, createdAt) VALUES (1, 10, 350, 'purchase', '2026-05-04T12:00:00.000Z', 't'), (1, 3, 350, 'consume', '2026-05-05T12:00:00.000Z', 't')");
  run("INSERT INTO inventory_movements (blankId, qtyDelta, unitCostCents, kind, occurredAt, createdAt, voidedAt) VALUES (1, 4, 350, 'purchase', '2026-05-06T12:00:00.000Z', 't', 't')");
  run("INSERT INTO transfer_movements (transferId, qtyDelta, unitCostCents, kind, occurredAt, createdAt) VALUES (1, 2, 1250, 'purchase', '2026-07-08T12:00:00.000Z', 't')");
  run("INSERT INTO expenses (expenseDate, description, categoryId, amountCents, createdAt, updatedAt) VALUES ('2026-08-12', 'Thread', ?, 12000, 't', 't'), ('2026-08-13', 'Thread back', ?, -2000, 't', 't'), ('2026-12-20', 'Sales tax for the year', ?, 1330, 't', 't'), ('2025-08-12', 'Old', ?, 7000, 't', 't')",
    [otherCat, otherCat, taxCat, otherCat]);

  console.log("\n=== Month by month (getMoneyInOutByMonth) ===");
  const io = await lib.getMoneyInOutByMonth(d1, { yearFrom: "2026-01-01", to: "2026-12-31" });
  const mo = (n) => io.months[n - 1];
  console.log("a month for each, January to the end:", io.months.length === 12 && mo(1).month === "2026-01" && mo(12).month === "2026-12");
  console.log("January in: other income and the owner's money put in:", mo(1).in.otherIncome === 50 && mo(1).in.contributions === 2000 && mo(1).totalIn === 2050);
  console.log("February in: A's payment, its $7 tax apart (test, voided-order and last year's payments left out):", mo(2).in.payments === 100 && mo(2).in.taxCollected === 7 && mo(2).totalIn === 107);
  console.log("March in: B's payment with tax on top and shipping — $7 tax, $110 the rest (the voided payment left out):", mo(3).in.payments === 110 && mo(3).in.taxCollected === 7);
  console.log("card fees on those payments are money out the month paid:", mo(2).out.cardFees === 3 && mo(3).out.cardFees === 3);
  console.log("April: the refund takes back its share of the tax ($0.70 of $10.70):", mo(4).in.taxCollected === -0.7 && mo(4).in.payments === -10 && mo(4).totalIn === -10.7);
  console.log("May out: blanks bought (10 × $3.50), not when used, a voided receive left out:", mo(5).out.blanks === 35 && mo(5).totalOut === 35);
  console.log("June out: the owner's draw; a transfer between accounts isn't in or out:", mo(6).out.draws === 500 && mo(6).totalOut === 500 && mo(6).totalIn === 0);
  console.log("July out: transfer sheets bought:", mo(7).out.transfers === 25);
  console.log("August out: expenses less a refund (last year's left out):", mo(8).out.expenses === 100 && mo(8).totalOut === 100);
  console.log("December out: sales tax paid to the state, found by the category's key though renamed:", mo(12).out.taxPaid === 13.3 && mo(12).out.expenses === 0);
  console.log("only December has tax going out:", io.months.filter(m => m.out.taxPaid).length === 1);
  console.log("totals for the year, with tax collected and paid named:", io.totalIn === 50 + 2000 + 107 + 117 - 10.7 && io.taxCollected === 13.3 && io.taxPaid === 13.3
    && io.contributions === 2000 && io.draws === 500 && io.totalOut === 3 + 3 + 35 + 500 + 25 + 100 + 13.3);

  const nov = await lib.getMoneyInOutByMonth(d1, { yearFrom: "2026-01-01", to: "2026-11-18" });
  console.log("partway through the year: January to this month only:", nov.months.length === 11 && nov.taxPaid === 0);

  console.log("\n=== Bookkeeping off ===");
  await lib.setFeatures(d1, { bookkeeping: false });
  const off = await lib.getMoneyInOutByMonth(d1, { yearFrom: "2026-01-01", to: "2026-12-31" });
  console.log("other income, expenses, owner money and tax paid are left out; payments, card fees and stock bought stay:", off.bookkeeping === false
    && off.months[0].totalIn === 0 && off.months[1].totalIn === 107 && off.months[4].out.blanks === 35 && off.months[5].totalOut === 0
    && off.months[7].totalOut === 0 && off.taxPaid === 0 && off.months[1].out.cardFees === 3);
  await lib.setFeatures(d1, { bookkeeping: true });

  console.log("\n=== Part of Home's answer (getDashboard) ===");
  const dash = await lib.getDashboard(d1, { today: "2026-12-31", fresh: true });
  console.log("getDashboard carries the year's months:", dash.inOut && dash.inOut.months.length === 12 && dash.inOut.taxPaid === 13.3);
})().catch(e => { console.log("test195 crashed:", false); console.error(e); process.exit(1); });
