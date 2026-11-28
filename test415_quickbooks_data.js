process.env.TZ = "UTC";   // nothing here should read the machine's zone; pinned anyway
const fs = require("fs");
const { ok } = require("./testlib/check");
const { createD1 } = require("./testlib/d1-shim.js");

// The QuickBooks export's settings and data (phase 8, functions/_lib/db.js), on real SQL (sql.js), then through the
// real functions/_lib/quickbooks.js end to end:
//   - getQuickBooksSettings: the defaults and the full map (every app account and expense category named), and what a
//     saved value that is bad in any way reads as
//   - buildQuickBooksSettings / setQuickBooksSettings: a merge (what is passed replaces, the rest is kept), an empty name
//     back to the default, 100 characters at most, tabs and line breaks refused (nothing written), unknown ids dropped,
//     only names that differ from the app's own stored (so renaming an account in the app carries over)
//   - getQuickBooksData for business days (America/Chicago, sales at the very edges of the range): sales (gift-card-only
//     orders too, giftCardCents, Net 30 with its due date and PO, totals that are what the customer owes), payments
//     (refunds negative, fees, gift card redemptions), expenses (by date, deleted ones left out, vendor refunds
//     negative), postage, deposits (Stripe payouts both ways, cash-outs with their fees and payments, bank-to-bank left
//     out), the sale date basis, the business range, a bad range's { error }, and each fallback for an older database
//   - the same data through buildQuickBooksExport, Online and Desktop, under every "sales go in as" × "customer name":
//     every IIF transaction balances, and the books come out right.
// Invented data only (Example Club, Example School District, pat@example.com). The dates are fixed in the data; the
// business is in America/Chicago; nothing reads the machine's date or zone.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/^import "[^"\n]+";\n/gm, "").replace(/export (async function|function|const)/g, "$1");
const NAMES = `{ getQuickBooksSettings, buildQuickBooksSettings, setQuickBooksSettings, getQuickBooksData, QB_ACCOUNT_KEYS, QB_ACCOUNT_DEFAULTS,
  businessRange_, setAccountingSettings }`;
// A fresh copy of db.js: its own module state (no time zone resolved yet, like a new worker).
const dbLib = () => new Function(strip(read("functions/_lib/db.js")) + "\nreturn " + NAMES + ";")();
const L = dbLib();
const QB = new Function(strip(read("functions/_lib/quickbooks.js")) + "\nreturn { buildQuickBooksExport, buildIif, buildQboCsv, iifBalanced, qbSummary };")();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };
process.on("unhandledRejection", (e) => { console.error(e); ok("nothing in the test was left to fail unseen", false); });
let finished = false;
process.on("exit", () => { if (!finished) { console.log("the test ran to its end: false"); process.exitCode = 1; } });

const migrations = fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort();
async function fresh(upTo = "9999", zone = "America/Chicago") {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of migrations) if (f < upTo) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('club','club','Example Club','t','t');
    INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('school','school','Example School District','t','t');`);
  if (zone) d1._raw.exec(`INSERT INTO global_settings (key, value) VALUES ('locale', '{"timeZone":"${zone}","country":"US"}')`);
  return d1;
}
const rows = (d1, sql) => { const r = d1._raw.exec(sql)[0]; return r ? r.values.map(v => Object.fromEntries(r.columns.map((c, i) => [c, v[i]]))) : []; };
const savedRaw = (d1) => { const r = rows(d1, "SELECT value FROM global_settings WHERE key = 'quickbooks'")[0]; return r ? JSON.parse(r.value) : null; };
const q = (s) => s == null ? "NULL" : typeof s === "number" ? String(s) : "'" + String(s).replace(/'/g, "''") + "'";
// A database that fails the statements matching `re` with `message`, and answers the rest as usual.
function failing(db, re, message) {
  const boom = () => { const s = { bind: () => s, run: async () => { throw new Error(message); }, all: async () => { throw new Error(message); }, first: async () => { throw new Error(message); } }; return s; };
  return new Proxy(db, { get(t, k) { if (k === "prepare") return (sql) => (re.test(sql) ? boom() : t.prepare(sql)); const v = t[k]; return typeof v === "function" ? v.bind(t) : v; } });
}
// One order and its lines, written straight to the tables so every date and figure is exactly what the test says.
function order(d1, o) {
  const cols = { orderId: o.id, orgId: o.org || "club", customerId: o.cust == null ? null : o.cust, customerName: o.name == null ? "" : o.name,
    contact: o.contact == null ? "" : o.contact, placedAt: o.placedAt || "2025-12-20T18:00:00.000Z", shippedAt: o.shippedAt || null,
    deliveredAt: o.deliveredAt || null, completedAt: o.completedAt || null, voidedAt: o.voidedAt || null, isTest: o.isTest ? 1 : 0,
    shippingCostCents: o.shipping || 0, discountCents: o.discount || 0, discountTaxCents: o.discountTax || 0,
    rushFeeCents: o.rush || 0, rushFeeTaxCents: o.rushTax || 0, taxMode: o.taxMode || "inclusive" };
  if (o.shipDisc) cols.shippingDiscountCents = o.shipDisc;
  if (o.net30 !== undefined) Object.assign(cols, { net30: o.net30 ? 1 : 0, poNumber: o.po || "", poAcceptedAt: o.po ? "2026-01-10T18:00:00.000Z" : null, invoicedAt: o.invoicedAt || null });
  d1._raw.exec(`INSERT INTO orders (${Object.keys(cols).join(", ")}) VALUES (${Object.values(cols).map(q).join(", ")})`);
  for (const l of o.lines || []) {
    d1._raw.exec(`INSERT INTO order_items (orderId, orgId, productId, name, type, size, qty, lineTotalCents, taxCents, taxable, cancelDate)
      VALUES (${q(o.id)}, ${q(o.org || "club")}, ${q(l.product || "tee")}, ${q(l.name == null ? "Example Tee" : l.name)}, 'shirt', ${q(l.size || "")}, ${l.qty == null ? 1 : l.qty},
      ${l.cents}, ${l.tax || 0}, ${l.taxable === false ? 0 : 1}, ${q(l.cancelled ? "2026-01-02" : null)})`);
  }
}
const GIFT = "__giftcard__";
const payment = (d1, p) => d1._raw.exec(`INSERT INTO order_payments (id, orderId, amountCents, receivedAt, method, kind, accountId, feeCents, reference, voidedAt${p.giftCardId ? ", giftCardId" : ""})
  VALUES (${p.id}, ${q(p.order)}, ${p.cents}, ${q(p.at)}, ${q(p.method == null ? "card" : p.method)}, ${q(p.kind || "payment")}, ${p.account == null ? "NULL" : p.account}, ${p.fee || 0},
  ${q(p.reference || "")}, ${q(p.voidedAt || null)}${p.giftCardId ? ", " + p.giftCardId : ""})`);

(async () => {
  // =============================================================================================================
  console.log("=== The QuickBooks settings: the defaults and the full map ===");
  const APP_BANKS = { 1: "Business checking", 2: "Credit card", 3: "Venmo", 4: "Cash on hand", 5: "Stripe balance" };
  {
    const d1 = await fresh();
    const s = await L.getQuickBooksSettings(d1);
    ok("the account keys are the ten the contract names, in order",
      same(L.QB_ACCOUNT_KEYS, ["sales", "shippingIncome", "rushIncome", "discounts", "salesTaxPayable", "giftCardLiability", "undepositedFunds", "cardFees", "postage", "ar"]));
    ok("with nothing saved: QuickBooks Online, sales go in as sales receipts, named by the customer", s.format === "online" && s.salesAs === "receipts" && s.customerName === "customer");
    ok("…and each QuickBooks account has its default name (rush income goes to Sales)", same(s.accounts, { sales: "Sales", shippingIncome: "Shipping Income", rushIncome: "Sales",
      discounts: "Discounts Given", salesTaxPayable: "Sales Tax Payable", giftCardLiability: "Gift Cards Outstanding", undepositedFunds: "Undeposited Funds",
      cardFees: "Merchant Fees", postage: "Postage and Delivery", ar: "Accounts Receivable" }));
    ok("…the same as QB_ACCOUNT_DEFAULTS, which can't be changed", same(s.accounts, L.QB_ACCOUNT_DEFAULTS) && Object.isFrozen(L.QB_ACCOUNT_DEFAULTS));
    ok("every app account is in the map, under its own name", same(s.bankAccounts, APP_BANKS));
    const cats = rows(d1, "SELECT id, name FROM expense_categories");
    ok("every expense category is in the map, under its own name", cats.length > 10 && same(Object.keys(s.expenseAccounts).sort(), cats.map(c => String(c.id)).sort())
      && cats.every(c => s.expenseAccounts[String(c.id)] === c.name));
    ok("the map has exactly format, accounts, bankAccounts, expenseAccounts, salesAs and customerName",
      same(Object.keys(s).sort(), ["accounts", "bankAccounts", "customerName", "expenseAccounts", "format", "salesAs"]));
    ok("reading writes nothing", savedRaw(d1) === null);

    // A saved value bad in every way it can be.
    d1._raw.exec(`UPDATE accounts SET name = 'Old' || char(9) || 'checking' || char(10) WHERE id = 1; UPDATE accounts SET name = char(9) WHERE id = 2;
      UPDATE accounts SET name = '${"V".repeat(120)}' WHERE id = 3; UPDATE expense_categories SET name = char(10) WHERE id = 4;`);
    d1._raw.exec(`INSERT INTO global_settings (key, value) VALUES ('quickbooks', '${JSON.stringify({ format: "excel", salesAs: "bills", customerName: "nickname",
      accounts: { sales: "  Income  ", cardFees: "Bank\tfees", ar: "", postage: "P".repeat(101), discounts: 7, shippingIncome: "S".repeat(100) },
      bankAccounts: { 4: "  Petty cash  ", 5: "   " }, expenseAccounts: { 2: "Supplies", 999: "Nowhere" } })}')`);
    const b = await L.getQuickBooksSettings(d1);
    ok("a saved format, sales-as and customer name that aren't on the lists read as the defaults", b.format === "online" && b.salesAs === "receipts" && b.customerName === "customer");
    ok("a saved account name is trimmed", b.accounts.sales === "Income");
    ok("a saved name with a tab, an empty one, one over 100 characters or one that isn't text reads as the default",
      b.accounts.cardFees === "Merchant Fees" && b.accounts.ar === "Accounts Receivable" && b.accounts.postage === "Postage and Delivery" && b.accounts.discounts === "Discounts Given");
    ok("…while exactly 100 characters is kept", b.accounts.shippingIncome === "S".repeat(100));
    ok("a saved bank name is trimmed; a blank one falls back to the app account's name", b.bankAccounts["4"] === "Petty cash" && b.bankAccounts["5"] === "Stripe balance");
    ok("an app account's own name with a tab or line break reads with spaces, trimmed", b.bankAccounts["1"] === "Old checking");
    ok("an app account whose name is only a tab reads as \"Account <id>\"; one with a long name is cut to 100 characters",
      b.bankAccounts["2"] === "Account 2" && b.bankAccounts["3"] === "V".repeat(100));
    ok("a saved category name is used; a category whose name is only a line break reads as \"Category <id>\"; a saved id that isn't a category is not in the map",
      b.expenseAccounts["2"] === "Supplies" && b.expenseAccounts["4"] === "Category 4" && !("999" in b.expenseAccounts));
    d1._raw.exec("UPDATE global_settings SET value = 'not json' WHERE key = 'quickbooks'");
    ok("a saved value that isn't JSON reads as the defaults", same((await L.getQuickBooksSettings(d1)).accounts, L.QB_ACCOUNT_DEFAULTS));
    d1._raw.exec("UPDATE global_settings SET value = '{\"accounts\":\"Sales\",\"bankAccounts\":7,\"expenseAccounts\":null,\"format\":\"desktop\"}' WHERE key = 'quickbooks'");
    const c = await L.getQuickBooksSettings(d1);
    ok("saved name lists that aren't lists read as no names saved (and a saved Desktop format is kept)",
      c.format === "desktop" && same(c.accounts, L.QB_ACCOUNT_DEFAULTS) && c.bankAccounts["4"] === "Cash on hand" && c.expenseAccounts["2"] === "Supplies (thread, stabilizer, needles)");
  }
  {
    const d1 = await fresh();
    const s = await L.getQuickBooksSettings(failing(d1, /FROM accounts|FROM expense_categories/, "no such table: accounts"));
    ok("a database that can't list its accounts or categories still answers the settings, with none of either",
      same(s.bankAccounts, {}) && same(s.expenseAccounts, {}) && same(s.accounts, L.QB_ACCOUNT_DEFAULTS));
    const s2 = await L.getQuickBooksSettings(failing(d1, /global_settings/, "no such table: global_settings"));
    ok("a database that can't read its settings answers the defaults", s2.format === "online" && same(s2.bankAccounts, APP_BANKS));
  }

  // =============================================================================================================
  console.log("\n=== Saving the QuickBooks settings ===");
  {
    const d1 = await fresh();
    const b = await L.buildQuickBooksSettings(d1, { format: "desktop" });
    ok("the build step hands back the cleaned value and one statement, and writes nothing yet",
      b.value.format === "desktop" && Array.isArray(b.stmts) && b.stmts.length === 1 && savedRaw(d1) === null);
    await b.stmts[0].run();
    ok("…and its statement stores it under global_settings \"quickbooks\"", savedRaw(d1).format === "desktop");

    const v1 = await L.setQuickBooksSettings(d1, { format: "online", salesAs: "invoices", customerName: "shop",
      accounts: { sales: "  Embroidery Sales ", ar: "", cardFees: null, bogus: "Ignored" },
      bankAccounts: { 1: "Checking 1234", 2: "Credit card", 3: "  ", 999: "No such account" },
      expenseAccounts: { 2: "Supplies Expense", 6: "Office expense", 12345: "No such category" } });
    const raw1 = savedRaw(d1);
    ok("setQuickBooksSettings answers the full map, the same as reading it back", same(v1, await L.getQuickBooksSettings(d1)));
    ok("the format, sales-as and customer name are saved", v1.format === "online" && v1.salesAs === "invoices" && v1.customerName === "shop");
    ok("an account name is trimmed; an empty or missing one (null) goes back to the default",
      v1.accounts.sales === "Embroidery Sales" && v1.accounts.ar === "Accounts Receivable" && v1.accounts.cardFees === "Merchant Fees");
    ok("an account key that isn't one of the ten is dropped", !("bogus" in v1.accounts) && !("bogus" in raw1.accounts));
    ok("a bank account renamed for QuickBooks is saved; one given the app's own name, or a blank name, reads as the app's name",
      v1.bankAccounts["1"] === "Checking 1234" && v1.bankAccounts["2"] === "Credit card" && v1.bankAccounts["3"] === "Venmo");
    ok("only names that differ from the app's own are stored, and ids that aren't accounts or categories are dropped",
      same(raw1.bankAccounts, { 1: "Checking 1234" }) && same(raw1.expenseAccounts, { 2: "Supplies Expense" }));
    ok("what is stored is format, accounts (all ten), salesAs, customerName, bankAccounts and expenseAccounts",
      same(Object.keys(raw1), ["format", "accounts", "salesAs", "customerName", "bankAccounts", "expenseAccounts"]) && same(Object.keys(raw1.accounts), L.QB_ACCOUNT_KEYS));

    const v2 = await L.setQuickBooksSettings(d1, { format: "desktop" });
    ok("saving only the format keeps everything else saved (a merge)", v2.format === "desktop" && v2.salesAs === "invoices" && v2.customerName === "shop"
      && v2.accounts.sales === "Embroidery Sales" && v2.bankAccounts["1"] === "Checking 1234" && v2.expenseAccounts["2"] === "Supplies Expense");
    const v3 = await L.setQuickBooksSettings(d1, { accounts: { postage: "Shipping Supplies" }, bankAccounts: { 4: "Petty Cash" } });
    ok("saving one account name keeps the others; saving one bank name keeps the other saved ones",
      v3.accounts.sales === "Embroidery Sales" && v3.accounts.postage === "Shipping Supplies" && same(savedRaw(d1).bankAccounts, { 1: "Checking 1234", 4: "Petty Cash" }));
    const v4 = await L.setQuickBooksSettings(d1, { bankAccounts: { 1: "" }, expenseAccounts: { 2: 42 } });
    ok("a bank name saved empty goes back to the app's name (and is no longer stored); a name sent as a number is kept as text",
      v4.bankAccounts["1"] === "Business checking" && same(savedRaw(d1).bankAccounts, { 4: "Petty Cash" }) && v4.expenseAccounts["2"] === "42");

    // Renames in the app carry over.
    d1._raw.exec("UPDATE accounts SET name = 'Venmo Business' WHERE id = 3; UPDATE accounts SET name = 'Cash drawer' WHERE id = 4;");
    const v5 = await L.getQuickBooksSettings(d1);
    ok("renaming an app account carries over to an account with no QuickBooks name of its own", v5.bankAccounts["3"] === "Venmo Business");
    ok("…while an account with its own QuickBooks name keeps it", v5.bankAccounts["4"] === "Petty Cash");
    d1._raw.exec("INSERT INTO accounts (id, name, type, createdAt, updatedAt) VALUES (6, 'Savings', 'other', 't', 't')");
    ok("a new app account is in the map at once, under its own name", (await L.getQuickBooksSettings(d1)).bankAccounts["6"] === "Savings");
    await L.setQuickBooksSettings(d1, { bankAccounts: { 4: "Cash drawer" } });
    ok("giving an account the app's (new) name stores nothing for it", same(savedRaw(d1).bankAccounts, {}));
    const keep = await L.setQuickBooksSettings(d1, null);
    ok("saving nothing (no settings sent) changes nothing", keep.format === "desktop" && keep.accounts.sales === "Embroidery Sales");
    await L.setQuickBooksSettings(d1, "desktop");
    ok("…nor does a value that isn't a list", savedRaw(d1).accounts.sales === "Embroidery Sales");

    // Refusals: a message the page can show, and nothing written.
    const before = JSON.stringify(savedRaw(d1));
    const refusal = async (v, msg, desc) => {
      const e = await rejects(L.setQuickBooksSettings(d1, v));
      ok(desc, !!e && e.userFacing === true && e.message === msg && JSON.stringify(savedRaw(d1)) === before);
    };
    await refusal({ format: "excel" }, "Pick QuickBooks Online or QuickBooks Desktop.", "a format other than Online or Desktop is refused: \"Pick QuickBooks Online or QuickBooks Desktop.\"");
    await refusal({ format: null }, "Pick QuickBooks Online or QuickBooks Desktop.", "…a format sent empty too");
    await refusal({ salesAs: "bills" }, "Sales go in as sales receipts or invoices.", "sales going in as anything but receipts or invoices is refused");
    await refusal({ customerName: "email" }, "Name the customer by the customer or by the shop.", "a customer name other than customer or shop is refused");
    await refusal({ accounts: "Sales" }, "Send the QuickBooks account names as a list.", "account names that aren't a list are refused");
    await refusal({ accounts: null }, "Send the QuickBooks account names as a list.", "…null too");
    await refusal({ bankAccounts: "Checking" }, "Send the QuickBooks account names as a list.", "bank account names that aren't a list are refused");
    await refusal({ expenseAccounts: null }, "Send the QuickBooks account names as a list.", "expense account names sent as null are refused");
    await refusal({ accounts: { cardFees: "Merchant\tFees" } }, "Card fees: QuickBooks names can't have tabs or line breaks.",
      "an account name with a tab is refused, naming the box: \"Card fees: QuickBooks names can't have tabs or line breaks.\"");
    await refusal({ accounts: { ar: "Accounts\nReceivable" } }, "Accounts receivable: QuickBooks names can't have tabs or line breaks.", "…a line break too");
    await refusal({ accounts: { giftCardLiability: "Gift\rCards" } }, "Gift card liability: QuickBooks names can't have tabs or line breaks.", "…a carriage return too");
    await refusal({ accounts: { sales: "S".repeat(101) } }, "Sales: a QuickBooks name can be at most 100 characters.", "an account name over 100 characters is refused");
    await refusal({ accounts: { sales: "S".repeat(101) + "\t" } }, "Sales: QuickBooks names can't have tabs or line breaks.", "…a tab is the first thing said");
    await refusal({ bankAccounts: { 1: "Checking\t1234" } }, "Business checking: QuickBooks names can't have tabs or line breaks.",
      "a bank name with a tab is refused, naming the app account");
    await refusal({ expenseAccounts: { 3: "X".repeat(101) } }, "Software & subscriptions: a QuickBooks name can be at most 100 characters.",
      "a category name over 100 characters is refused, naming the category");
    d1._raw.exec("UPDATE accounts SET name = char(9) WHERE id = 2; UPDATE accounts SET name = ' Old' || char(9) || 'card' || char(10) WHERE id = 5;");
    await refusal({ bankAccounts: { 2: "Card\t9" } }, "Account 2: QuickBooks names can't have tabs or line breaks.",
      "a bank name refused for an app account whose name is only a tab names it \"Account <id>\", not by the tab");
    await refusal({ bankAccounts: { 5: "Y".repeat(101) } }, "Old card: a QuickBooks name can be at most 100 characters.",
      "…an app account name with a tab or line break is named with spaces, trimmed");
    const ok100 = await L.setQuickBooksSettings(d1, { accounts: { sales: "  " + "S".repeat(100) + "  " } });
    ok("a name of exactly 100 characters, once trimmed, is taken", ok100.accounts.sales === "S".repeat(100));
  }

  // =============================================================================================================
  console.log("\n=== The data for the export: a January in Chicago ===");
  const d1 = await fresh();
  d1._raw.exec(`INSERT INTO global_settings (key, value) VALUES ('terms', '{"defaultDays":30,"startsAt":"invoice"}');
    INSERT INTO customers (id, name, company, email, createdAt, updatedAt) VALUES (1, 'Pat Example', 'Example School District', 'pat@example.com', 't', 't');
    INSERT INTO customers (id, name, company, email, createdAt, updatedAt) VALUES (2, '', 'Example Booster Club', 'boosters@example.com', 't', 't');
    INSERT INTO customers (id, name, company, email, createdAt, updatedAt) VALUES (3, '', '', 'sam@example.com', 't', 't');
    INSERT INTO customers (id, name, company, email, createdAt, updatedAt) VALUES (4, '', '', '', 't', 't');
    INSERT INTO gift_cards (id, code, last4, initialCents, balanceCents, createdAt) VALUES (1, 'EXAMPLECODE1', 'ODE1', 5000, 3000, 't');`);
  // Chicago is UTC−6 in January: Jan 1 starts at 06:00 UTC and Jan 31 ends at 05:59:59.999 UTC on Feb 1.
  order(d1, { id: "OD-1001", cust: 1, name: "Typed Name", shippedAt: "2026-01-01T06:00:00.000Z", shipping: 800, shipDisc: 100, discount: 451, rush: 500,
    lines: [{ name: "Example Tee", size: "L", qty: 3, cents: 3001 }, { name: "Example Cap", qty: 1, cents: 1500, taxable: false },
      { name: "Cancelled Hoodie", cents: 999, cancelled: true }, { product: GIFT, name: "Gift card", cents: 2500, taxable: false },
      { product: GIFT, name: "Gift card", cents: 700, taxable: false, cancelled: true }] });
  order(d1, { id: "OD-1000", cust: 1, shippedAt: "2026-01-01T05:59:59.999Z", lines: [{ cents: 1111 }] });            // Dec 31 in Chicago
  order(d1, { id: "OD-1002", cust: 2, org: "school", shippedAt: "2026-02-01T05:59:59.999Z", taxMode: "exclusive", discount: 1000, discountTax: 83, rush: 2000, rushTax: 165,
    lines: [{ name: "Example Polo", qty: 4, cents: 10000, tax: 825 }] });                                                  // Jan 31, 11:59 pm
  order(d1, { id: "OD-1003", cust: 1, placedAt: "2026-01-20T18:00:00.000Z", shippedAt: "2026-02-01T06:00:00.000Z", lines: [{ cents: 2222 }] });   // Feb 1
  order(d1, { id: "OD-1004", name: "Walk-in Buyer", contact: "walkin@example.com", completedAt: "2026-01-10T18:00:00.000Z", shipping: 800,
    lines: [{ product: GIFT, name: "Gift card", cents: 5000, taxable: false }] });                                       // gift cards only
  order(d1, { id: "OD-1005", cust: 1, shippedAt: "2026-01-12T18:00:00.000Z", voidedAt: "2026-01-13T18:00:00.000Z", lines: [{ cents: 3333 }] });
  order(d1, { id: "OD-1006", cust: 1, shippedAt: "2026-01-12T18:00:00.000Z", isTest: true, lines: [{ cents: 4444 }] });
  order(d1, { id: "OD-1007", cust: 3, org: "school", net30: true, po: "PO-1001", invoicedAt: "2026-01-16T03:00:00.000Z", shippedAt: "2026-01-20T18:00:00.000Z",
    lines: [{ name: "Example Jacket", qty: 2, cents: 5350, tax: 350 }] });                                                // invoiced Jan 15, 9 pm Chicago
  order(d1, { id: "OD-1008", cust: 4, name: "Typed Name", deliveredAt: "2026-01-14T18:00:00.000Z", lines: [{ name: "", qty: 2, cents: 600 }] });
  d1._raw.exec("PRAGMA foreign_keys = OFF");   // its shop and customer records are gone
  order(d1, { id: "OD-1009", org: "gone", cust: 99, name: "", contact: "buyer@example.com", shippedAt: "2026-01-15T18:00:00.000Z", lines: [{ cents: 700 }] });
  d1._raw.exec("PRAGMA foreign_keys = ON");
  order(d1, { id: "OD-1010", cust: 1, shippedAt: "2026-01-16T18:00:00.000Z", lines: [{ cents: 900, cancelled: true }] });   // every line cancelled
  // Payments.
  payment(d1, { id: 1, order: "OD-1001", cents: 7750, at: "2026-01-01T06:00:00.000Z", account: 5, fee: 255, reference: "ch_example_1" });
  payment(d1, { id: 2, order: "OD-1001", cents: -1000, kind: "refund", at: "2026-02-01T05:59:59.999Z", account: 5, reference: "re_example_1" });
  payment(d1, { id: 3, order: "OD-1001", cents: 1234, at: "2026-01-01T05:59:59.999Z", account: 5 });   // Dec 31
  payment(d1, { id: 4, order: "OD-1001", cents: 1234, at: "2026-02-01T06:00:00.000Z", account: 5 });   // Feb 1
  payment(d1, { id: 5, order: "OD-1007", cents: 5350, at: "2026-01-25T18:00:00.000Z", method: "check", account: 1, reference: "1001" });
  payment(d1, { id: 6, order: "OD-1002", cents: 2000, at: "2026-01-31T18:00:00.000Z", method: "other", giftCardId: 1 });
  payment(d1, { id: 7, order: "OD-1002", cents: 9907, at: "2026-01-31T19:00:00.000Z", method: "venmo", account: 3, fee: 200 });
  payment(d1, { id: 8, order: "OD-1002", cents: 500, at: "2026-01-20T18:00:00.000Z", account: 3, voidedAt: "2026-01-21T18:00:00.000Z" });
  payment(d1, { id: 9, order: "OD-1005", cents: 3333, at: "2026-01-12T18:00:00.000Z", account: 1 });
  payment(d1, { id: 10, order: "OD-1006", cents: 4444, at: "2026-01-12T18:00:00.000Z", account: 1 });
  payment(d1, { id: 11, order: "OD-1009", cents: 700, at: "2026-01-15T18:00:00.000Z", method: "zelle", account: null });
  payment(d1, { id: 12, order: "OD-1008", cents: 600, at: "2026-01-14T18:00:00.000Z", method: "cash", account: 4, fee: 60 });
  order(d1, { id: "OD-0999", cust: 1, net30: true, po: "PO-0999", invoicedAt: "2025-12-01T18:00:00.000Z", shippedAt: "2025-12-02T18:00:00.000Z", lines: [{ cents: 4000 }] });
  payment(d1, { id: 13, order: "OD-0999", cents: 4000, at: "2026-01-05T18:00:00.000Z", method: "card", account: 5, fee: 120 });   // an order sold in December
  // Expenses.
  d1._raw.exec(`INSERT INTO expenses (id, expenseDate, description, categoryId, amountCents, vendor, accountId, paidPersonally, createdAt, updatedAt, deletedAt) VALUES
    (1, '2026-01-01', 'Thread order', 2, 4500, 'Example Supply Co', 1, 0, 't', 't', NULL),
    (2, '2026-01-31', 'Office paper', 6, 1200, '', 2, 0, 't', 't', NULL),
    (3, '2026-01-15', 'Thread returned', 2, -500, 'Example Supply Co', 1, 0, 't', 't', NULL),
    (4, '2026-01-10', 'Entered twice', 2, 4500, 'Example Supply Co', 1, 0, 't', 't', '2026-01-11T00:00:00.000Z'),
    (5, '2025-12-31', 'Last year', 2, 100, 'Example Supply Co', 1, 0, 't', 't', NULL),
    (6, '2026-02-01', 'Next month', 2, 100, 'Example Supply Co', 1, 0, 't', 't', NULL),
    (7, '2026-01-20', 'Design software', 3, 999, 'Example Software', NULL, 1, 't', 't', NULL);`);
  // Postage: labels bought (the evening of Jan 1 in Chicago is Jan 2 in UTC).
  d1._raw.exec(`INSERT INTO shipping_labels (id, orderId, shippoTransactionId, carrier, service, amountCents, trackingNumber, purchasedAt, voidedAt, accountId) VALUES
    (1, 'OD-1001', 'tx1', 'USPS', 'Ground Advantage', 850, '9400EXAMPLE1', '2026-01-02T00:00:00.000Z', NULL, 2),
    (2, 'OD-1001', 'tx2', 'USPS', 'Priority', 1200, '9400EXAMPLE2', '2026-01-03T18:00:00.000Z', '2026-01-04T18:00:00.000Z', 2),
    (3, 'OD-1006', 'tx3', 'USPS', 'Priority', 1300, '', '2026-01-03T18:00:00.000Z', NULL, 2),
    (4, 'OD-1005', 'tx4', 'USPS', 'Priority', 1400, '', '2026-01-03T18:00:00.000Z', NULL, 2),
    (5, 'OD-1002', 'tx5', '', '', 640, '', '2026-02-01T05:00:00.000Z', NULL, NULL),
    (6, 'OD-1002', 'tx6', 'UPS', '', 700, '', '2026-02-01T06:00:00.000Z', NULL, 2);`);
  // Money moved between accounts.
  d1._raw.exec(`INSERT INTO account_transfers (id, transferDate, fromAccountId, toAccountId, amountCents, note, externalRef, createdAt, updatedAt, deletedAt) VALUES
    (1, '2026-01-05', 5, 1, 7000, 'Stripe payout', 'po_example_1', 't', 't', NULL),
    (2, '2026-01-06', 1, 5, 300, 'Negative payout', 'po_example_2', 't', 't', NULL),
    (3, '2026-01-07', 1, 5, 400, 'Topped up by hand', '', 't', 't', NULL),
    (4, '2026-01-31', 3, 1, 9707, 'Venmo cash-out', '', 't', 't', NULL),
    (5, '2026-01-08', 4, 1, 2500, 'Cash to the bank', '', 't', 't', NULL),
    (6, '2026-01-09', 1, 2, 5000, 'Paid the card', '', 't', 't', NULL),
    (7, '2026-01-10', 5, 3, 100, 'Holding to holding', '', 't', 't', NULL),
    (8, '2026-01-11', 5, 1, 9999, 'Deleted payout', 'po_example_3', 't', 't', '2026-01-12T00:00:00.000Z'),
    (9, '2026-02-01', 5, 1, 8888, 'Next month', 'po_example_4', 't', 't', NULL),
    (10, '2026-01-15', 4, 1, 300, 'Cash, part of one sale', '', 't', 't', NULL),
    (11, '2026-01-16', 1, 2, 1000, 'Linked, though bank to bank', '', 't', 't', NULL),
    (12, '2025-12-31', 5, 1, 7777, 'Last year', 'po_example_5', 't', 't', NULL);
    INSERT INTO payment_cashouts (paymentId, transferId, amountCents, createdAt) VALUES (7, 4, 9907, 't'), (12, 10, 300, 't'), (11, 10, 700, 't'), (5, 11, 1000, 't');`);

  const data = await L.getQuickBooksData(d1, { dateFrom: "2026-01-01", dateTo: "2026-01-31" });
  const sale = (id) => data.sales.find(x => x.orderId === id);
  ok("the answer carries dateFrom, dateTo, basis, sales, payments, expenses, postage, deposits, accounts, categories and settings",
    same(Object.keys(data), ["dateFrom", "dateTo", "basis", "sales", "payments", "expenses", "postage", "deposits", "accounts", "categories", "settings"])
    && data.dateFrom === "2026-01-01" && data.dateTo === "2026-01-31");
  ok("…the sale date basis is the install's (shipped, by default)", data.basis === "shipped");
  ok("…accounts are the app accounts (id, name, type) and categories the expense categories (id, name)",
    same(data.accounts.map(a => [a.id, a.name, a.type]), [[1, "Business checking", "checking"], [2, "Credit card", "credit_card"], [3, "Venmo", "venmo"], [4, "Cash on hand", "cash"], [5, "Stripe balance", "stripe"]])
    && data.categories.length > 10 && same(Object.keys(data.categories[0]), ["id", "name"]));
  ok("…and settings is the QuickBooks settings map", same(data.settings, await L.getQuickBooksSettings(d1)));

  console.log("\n--- Sales ---");
  ok("the orders sold in the business's January, by sale date then order number (not void, not test; gift-card-only and all-cancelled ones in)",
    same(data.sales.map(x => x.orderId), ["OD-1001", "OD-1004", "OD-1008", "OD-1009", "OD-1010", "OD-1007", "OD-1002"]));
  ok("a sale at 00:00 on Jan 1 in Chicago is in and dated 2026-01-01; one a millisecond earlier (Dec 31 there) is not",
    sale("OD-1001").date === "2026-01-01" && !sale("OD-1000"));
  ok("a sale at 11:59:59.999 pm on Jan 31 in Chicago (Feb 1 in UTC) is in and dated 2026-01-31; one a millisecond later is not",
    sale("OD-1002").date === "2026-01-31" && !sale("OD-1003"));
  ok("an order's sale date falls back to delivered, then completed, when it never shipped",
    sale("OD-1008").date === "2026-01-14" && sale("OD-1004").date === "2026-01-10");
  {
    const a = sale("OD-1001");
    ok("a row has orderId, date, customer, shop, orgId, lines, discountCents, shippingCents, rushCents, taxCents, giftCardCents, totalCents, net30, dueDate and poNumber",
      same(Object.keys(a), ["orderId", "date", "customer", "shop", "orgId", "lines", "discountCents", "shippingCents", "rushCents", "taxCents", "giftCardCents", "totalCents", "net30", "dueDate", "poNumber"]));
    ok("the customer is the customer record's name (not the name typed on the order), the shop its name", a.customer === "Pat Example" && a.shop === "Example Club" && a.orgId === "club");
    ok("lines are the live goods, gift cards and cancelled lines left out: name with size, quantity, rate, amount, taxable",
      same(a.lines, [{ name: "Example Tee L", qty: 3, rateCents: 1000, amountCents: 3001, taxable: true }, { name: "Example Cap", qty: 1, rateCents: 1500, amountCents: 1500, taxable: false }]));
    ok("the discount, shipping less its discount, and rush", a.discountCents === 451 && a.shippingCents === 700 && a.rushCents === 500 && a.taxCents === 0);
    ok("giftCardCents is the live gift card lines (a cancelled gift card left out)", a.giftCardCents === 2500);
    ok("totalCents = lines − discount + shipping + rush + tax + gift cards = what the customer owes (77.50)", a.totalCents === 3001 + 1500 - 451 + 700 + 500 + 2500 && a.totalCents === 7750);
    ok("a cash order: not Net 30, no due date, no PO", a.net30 === false && a.dueDate === "" && a.poNumber === "");
  }
  {
    const c = sale("OD-1002");
    ok("prices plus tax (exclusive): the line is its total, the discount whole, the rush whole, and the tax the goods' (less the discount's) plus the rush's",
      c.lines[0].amountCents === 10000 && c.lines[0].rateCents === 2500 && c.discountCents === 1000 && c.rushCents === 2000 && c.taxCents === 825 - 83 + 165);
    ok("…so the total is 119.07, what the customer owes", c.totalCents === 10000 - 1000 + 2000 + 907 && c.totalCents === 11907);
    ok("a customer with no name goes by the company", c.customer === "Example Booster Club" && c.shop === "Example School District");
  }
  {
    const h = sale("OD-1007");
    ok("prices including tax: the line is net of its tax, and the tax is its own figure; the total is still what was charged",
      h.lines[0].amountCents === 5000 && h.lines[0].rateCents === 2500 && h.taxCents === 350 && h.totalCents === 5350);
    ok("a Net 30 order carries net30, its PO and its due date: invoiced 9 pm Jan 15 in Chicago, due 30 days on, Feb 14",
      h.net30 === true && h.poNumber === "PO-1001" && h.dueDate === "2026-02-14");
    ok("a customer with neither name nor company goes by the email", h.customer === "sam@example.com");
  }
  {
    const g = sale("OD-1004");
    ok("a gift-card-only order is in the sales, with no lines, no shipping, and its card as giftCardCents (it goes to the liability)",
      same(g.lines, []) && g.giftCardCents === 5000 && g.shippingCents === 0 && g.totalCents === 5000 && g.customer === "Walk-in Buyer");
    const n = sale("OD-1008");
    ok("a customer record with nothing in it reads \"Customer <id>\"; a line with no name reads \"Item\"",
      n.customer === "Customer 4" && same(n.lines, [{ name: "Item", qty: 2, rateCents: 300, amountCents: 600, taxable: true }]));
    const j = sale("OD-1009");
    ok("an order whose customer id has no record and no typed name goes by its contact; a shop with no record by its id",
      j.customer === "buyer@example.com" && j.shop === "gone");
    const z = sale("OD-1010");
    ok("an order with every line cancelled is a row worth nothing", same(z.lines, []) && z.totalCents === 0 && z.giftCardCents === 0);
  }
  ok("the sales add up: Σ totalCents = Σ(lines − discount + shipping + rush + tax + gift cards) for every row",
    data.sales.every(x => x.totalCents === x.lines.reduce((t, l) => t + l.amountCents, 0) - x.discountCents + x.shippingCents + x.rushCents + x.taxCents + x.giftCardCents));

  console.log("\n--- Payments ---");
  const pay = (id) => data.payments.find(x => x.id === id);
  ok("live payments by when they were received, in the business's days (void, test-order and voided payments left out)",
    same(data.payments.map(x => x.id), [1, 13, 12, 11, 8, 5, 6, 7, 2].filter(i => i !== 8)));
  ok("a payment at 00:00 on Jan 1 in Chicago is in, one a millisecond earlier or one at 00:00 on Feb 1 is not", !!pay(1) && !pay(3) && !pay(4) && pay(1).date === "2026-01-01");
  ok("a row: id, orderId, date, method, accountId, amountCents, feeCents, kind, giftCard, reference, customer, shop and net30",
    same(Object.keys(pay(1)), ["id", "orderId", "date", "method", "accountId", "amountCents", "feeCents", "kind", "giftCard", "reference", "customer", "shop", "net30"]));
  ok("a card payment carries its fee, account and reference", pay(1).amountCents === 7750 && pay(1).feeCents === 255 && pay(1).accountId === 5 && pay(1).reference === "ch_example_1" && pay(1).method === "card");
  ok("a refund at 11:59 pm on Jan 31 in Chicago is in, negative, dated 2026-01-31", pay(2).amountCents === -1000 && pay(2).kind === "refund" && pay(2).date === "2026-01-31");
  ok("a gift card spent on an order is marked giftCard; money is not", pay(6).giftCard === true && pay(6).amountCents === 2000 && pay(7).giftCard === false);
  ok("a payment on a Net 30 order is marked net30, with the customer and the shop",
    pay(5).net30 === true && pay(5).customer === "sam@example.com" && pay(5).shop === "Example School District" && pay(1).net30 === false);
  ok("…and so is one on a Net 30 order sold before the range", pay(13).net30 === true && !sale("OD-0999"));
  ok("a payment with no account: account null; the customer and shop as the sales name them",
    pay(11).method === "zelle" && pay(11).accountId === null && pay(11).customer === "buyer@example.com" && pay(11).shop === "gone");

  console.log("\n--- Expenses and postage ---");
  const exp = (id) => data.expenses.find(x => x.id === id);
  ok("live expenses dated in the range, by date (deleted ones, and ones dated Dec 31 or Feb 1, left out)", same(data.expenses.map(x => x.id), [1, 3, 7, 2]));
  ok("a row: id, date, payee, categoryId, categoryName, accountId, amountCents, memo, paidPersonally",
    same(exp(1), { id: 1, date: "2026-01-01", payee: "Example Supply Co", categoryId: 2, categoryName: "Supplies (thread, stabilizer, needles)", accountId: 1, amountCents: 4500, memo: "Thread order", paidPersonally: false }));
  ok("a vendor refund is negative", exp(3).amountCents === -500);
  ok("with no vendor, the payee is the description", exp(2).payee === "Office paper" && exp(2).memo === "Office paper");
  ok("one paid personally is marked so, with no account", exp(7).paidPersonally === true && exp(7).accountId === null);
  ok("postage: live labels bought in the business's January (voided, test-order and void-order labels left out), by when bought",
    same(data.postage.map(x => x.id), [1, 5]));
  ok("a label row: id, date (the evening of Jan 1 in Chicago), accountId, amountCents, orderId and a memo of carrier, service and tracking",
    same(data.postage[0], { id: 1, date: "2026-01-01", accountId: 2, amountCents: 850, orderId: "OD-1001", memo: "USPS Ground Advantage 9400EXAMPLE1" }));
  ok("a label with no account and no carrier details: account null, memo empty, dated Jan 31", data.postage[1].accountId === null && data.postage[1].memo === "" && data.postage[1].date === "2026-01-31");

  console.log("\n--- Deposits ---");
  const dep = (id) => data.deposits.find(x => x.id === id);
  ok("deposits are the payouts and cash-outs dated in the range (deleted, bank-to-bank and holding-to-holding moves left out)",
    same(data.deposits.map(x => x.id), [1, 2, 5, 10, 11, 4]));
  ok("a Stripe payout into checking: kind, account, from, amount, no fee, no payments, its note and reference",
    same(dep(1), { id: 1, date: "2026-01-05", accountId: 1, fromAccountId: 5, amountCents: 7000, feeCents: 0, paymentIds: [], kind: "stripe_payout", note: "Stripe payout", reference: "po_example_1" }));
  ok("a negative Stripe payout (checking to Stripe, with Stripe's reference) is a payout the other way: checking's, from Stripe, negative",
    dep(2).kind === "stripe_payout" && dep(2).accountId === 1 && dep(2).fromAccountId === 5 && dep(2).amountCents === -300);
  ok("money moved by hand into Stripe (no reference) is not a deposit", !dep(3));
  ok("a Venmo cash-out carries the payments it covers and their fees", dep(4).kind === "cashout" && dep(4).accountId === 1 && dep(4).fromAccountId === 3
    && dep(4).amountCents === 9707 && dep(4).feeCents === 200 && same(dep(4).paymentIds, [7]));
  ok("a cash-out of cash with no payments linked: a cash-out, no fee", dep(5).kind === "cashout" && dep(5).feeCents === 0 && same(dep(5).paymentIds, []));
  ok("a cash-out of part of a payment takes that part of its fee (300 of 600 with 60 fee: 30)", dep(10).feeCents === 30 && same(dep(10).paymentIds, [12, 11]));
  ok("a move between banks with payments linked to it is a cash-out of them", dep(11).kind === "cashout" && dep(11).feeCents === 0 && same(dep(11).paymentIds, [5]));

  console.log("\n--- The range ---");
  ok("businessRange_: from the start of Jan 1 to the end of Jan 31 in Chicago, in UTC",
    same(await L.businessRange_(d1, "2026-01-01", "2026-01-31"), { fromIso: "2026-01-01T06:00:00.000Z", toIso: "2026-02-01T05:59:59.999Z", tz: "America/Chicago" }));
  ok("…in summer, Chicago is UTC−5", same(await L.businessRange_(d1, "2026-07-01", "2026-07-31"), { fromIso: "2026-07-01T05:00:00.000Z", toIso: "2026-08-01T04:59:59.999Z", tz: "America/Chicago" }));
  ok("…and days that aren't dates fall back to the plain UTC day bounds", (await L.businessRange_(d1, "", "")).fromIso === "T00:00:00.000Z");
  {
    const one = await L.getQuickBooksData(d1, { dateFrom: "2026-01-31", dateTo: "2026-01-31" });
    ok("a one-day range (Jan 31) has that day's sales and money only",
      same(one.sales.map(x => x.orderId), ["OD-1002"]) && same(one.payments.map(x => x.id), [6, 7, 2]) && same(one.expenses.map(x => x.id), [2]) && same(one.deposits.map(x => x.id), [4]));
  }
  const bad = async (from, to, msg, desc) => ok(desc, same(await L.getQuickBooksData(d1, { dateFrom: from, dateTo: to }), { error: msg }));
  await bad("2026-1-1", "2026-01-31", "Choose the dates as YYYY-MM-DD.", "a start date not written YYYY-MM-DD answers { error: \"Choose the dates as YYYY-MM-DD.\" }");
  await bad("2026-01-01", "", "Choose the dates as YYYY-MM-DD.", "…an end date missing too");
  await bad("2026-02-01", "2026-01-31", "The start date is after the end date.", "a start after the end answers { error: \"The start date is after the end date.\" }");
  ok("…and so does asking with nothing at all", !!(await L.getQuickBooksData(d1)).error);
  {
    await L.setAccountingSettings(d1, { saleDate: "placed" });
    const placed = await L.getQuickBooksData(d1, { dateFrom: "2026-01-01", dateTo: "2026-01-31" });
    ok("on the \"placed\" basis the sales are the orders placed in January, dated by when they were placed (payments still by when received)",
      placed.basis === "placed" && same(placed.sales.map(x => x.orderId), ["OD-1003"]) && placed.sales[0].date === "2026-01-20" && placed.payments.length === data.payments.length);
    await L.setAccountingSettings(d1, { saleDate: "shipped" });
  }
  {
    const utc = await fresh("9999", null);
    order(utc, { id: "OD-2000", shippedAt: "2026-01-01T05:59:59.999Z", lines: [{ cents: 100 }] });
    order(utc, { id: "OD-2001", shippedAt: "2026-02-01T05:59:59.999Z", lines: [{ cents: 100 }] });
    const u = await dbLib().getQuickBooksData(utc, { dateFrom: "2026-01-01", dateTo: "2026-01-31" });
    ok("a business with no zone saved works in UTC days: the early-morning Jan 1 sale is in, the Feb 1 one is out",
      same(u.sales.map(x => x.orderId), ["OD-2000"]) && u.sales[0].date === "2026-01-01");
  }
  {
    // A new worker: nothing has resolved the business's time zone yet. The due date is still on its calendar.
    const L2 = dbLib();
    const h = (await L2.getQuickBooksData(d1, { dateFrom: "2026-01-01", dateTo: "2026-01-31" })).sales.find(x => x.orderId === "OD-1007");
    ok("in a fresh worker (no time zone resolved yet) a Net 30 order is still due on the business's calendar (Feb 14, not Feb 15)", h.dueDate === "2026-02-14");
  }

  console.log("\n--- Older databases, and failures ---");
  {
    const d = await fresh("0120");   // before gift cards (0120) and Net 30 (0121)
    order(d, { id: "OD-3000", shippedAt: "2026-01-10T18:00:00.000Z", lines: [{ cents: 2500 }] });
    payment(d, { id: 1, order: "OD-3000", cents: 2500, at: "2026-01-10T18:00:00.000Z", account: 1 });
    const o = await dbLib().getQuickBooksData(d, { dateFrom: "2026-01-01", dateTo: "2026-01-31" });
    ok("a database from before gift cards and Net 30 (migrations/0120, 0121) still answers: the sale, not Net 30, no due date, no PO",
      o.sales.length === 1 && o.sales[0].net30 === false && o.sales[0].dueDate === "" && o.sales[0].poNumber === "" && o.sales[0].totalCents === 2500);
    ok("…and its payment, not from a gift card, not Net 30", o.payments.length === 1 && o.payments[0].giftCard === false && o.payments[0].net30 === false && o.payments[0].amountCents === 2500);
  }
  {
    const L3 = dbLib();
    const noCards = await L3.getQuickBooksData(failing(d1, /p\.giftCardId/, "no such column: p.giftCardId"), { dateFrom: "2026-01-01", dateTo: "2026-01-31" });
    ok("payments without the gift card column: every payment still listed, none marked giftCard",
      noCards.payments.length === data.payments.length && noCards.payments.every(x => x.giftCard === false));
    const e1 = await rejects(L3.getQuickBooksData(failing(d1, /FROM order_payments p JOIN/, "disk I/O error"), { dateFrom: "2026-01-01", dateTo: "2026-01-31" }));
    ok("any other failure reading payments is not hidden", !!e1 && /disk I\/O/.test(e1.message));
    const noLabels = await L3.getQuickBooksData(failing(d1, /FROM shipping_labels/, "no such column: l.accountId"), { dateFrom: "2026-01-01", dateTo: "2026-01-31" });
    ok("without the labels' columns: no postage, everything else as before", same(noLabels.postage, []) && noLabels.sales.length === data.sales.length && noLabels.expenses.length === data.expenses.length);
    const e2 = await rejects(L3.getQuickBooksData(failing(d1, /FROM shipping_labels/, "disk I/O error"), { dateFrom: "2026-01-01", dateTo: "2026-01-31" }));
    ok("…but any other failure reading labels is not hidden", !!e2 && /disk I\/O/.test(e2.message));
    const noTransfers = await L3.getQuickBooksData(failing(d1, /FROM account_transfers/, "no such table: account_transfers"), { dateFrom: "2026-01-01", dateTo: "2026-01-31" });
    ok("without account transfers: no deposits, everything else as before", same(noTransfers.deposits, []) && noTransfers.payments.length === data.payments.length);
    const e3 = await rejects(L3.getQuickBooksData(failing(d1, /FROM account_transfers/, "no such column: externalRef"), { dateFrom: "2026-01-01", dateTo: "2026-01-31" }));
    ok("…but a missing column there, or any other failure, is not hidden", !!e3 && /externalRef/.test(e3.message));
    const noLinks = await L3.getQuickBooksData(failing(d1, /FROM payment_cashouts/, "no such table: payment_cashouts"), { dateFrom: "2026-01-01", dateTo: "2026-01-31" });
    const v = noLinks.deposits.find(x => x.id === 4);
    ok("without payment links: the Venmo cash-out is still a cash-out, with no payments and no fee; a bank-to-bank move is left out",
      !!v && v.kind === "cashout" && v.feeCents === 0 && same(v.paymentIds, []) && !noLinks.deposits.find(x => x.id === 11));
    const noCust = await L3.getQuickBooksData(failing(d1, /FROM customers WHERE id IN/, "no such table: customers"), { dateFrom: "2026-01-01", dateTo: "2026-01-31" });
    ok("without customer records: each sale and payment goes by the name typed on the order, then its contact",
      noCust.sales.find(x => x.orderId === "OD-1001").customer === "Typed Name" && noCust.sales.find(x => x.orderId === "OD-1007").customer === "" && noCust.payments.find(x => x.id === 11).customer === "buyer@example.com");
  }

  // =============================================================================================================
  console.log("\n=== Through quickbooks.js, end to end ===");
  const centsOf = (s) => Math.round(Number(s) * 100);
  // Σ per account over an IIF (debits positive).
  const ledger = (iif) => {
    const out = {}; let cols = null;
    for (const ln of iif.split("\r\n")) {
      const f = ln.split("\t");
      if (f[0] === "!TRNS") cols = f;
      if ((f[0] === "TRNS" || f[0] === "SPL") && cols) out[f[cols.indexOf("ACCNT")]] = (out[f[cols.indexOf("ACCNT")]] || 0) + centsOf(f[cols.indexOf("AMOUNT")]);
    }
    return out;
  };
  for (const salesAs of ["receipts", "invoices"]) for (const customerName of ["customer", "shop"]) {
    await L.setQuickBooksSettings(d1, { salesAs, customerName, accounts: { sales: "Embroidery Sales" }, bankAccounts: { 1: "Checking 1234" } });
    const dd = await L.getQuickBooksData(d1, { dateFrom: "2026-01-01", dateTo: "2026-01-31" });
    const desk = QB.buildQuickBooksExport(dd, "desktop");
    const iif = desk.files[0].text;
    const chk = QB.iifBalanced(iif);
    console.log(`\n--- sales as ${salesAs}, named by the ${customerName} ---`);
    ok("Desktop: one IIF file, odd-quickbooks-2026-01-01-to-2026-01-31.iif, every transaction balanced to the cent",
      desk.files.length === 1 && desk.files[0].filename === "odd-quickbooks-2026-01-01-to-2026-01-31.iif" && chk.ok && same(chk.bad, []));
    ok("…with CRLF line ends only", !/[^\r]\n/.test(iif) && iif.endsWith("\r\n"));
    const lg = ledger(iif);
    ok("…the whole file nets to zero", Object.values(lg).reduce((t, x) => t + x, 0) === 0);
    ok("…Gift Cards Outstanding ends 55.00 in credit: 25.00 and 50.00 sold, 20.00 spent", lg["Gift Cards Outstanding"] === -(2500 + 5000) + 2000);
    ok("…the mapped names are used (Embroidery Sales, Checking 1234), and rush income, left at its default, goes to Sales (5.00 + 20.00)", "Embroidery Sales" in lg && "Checking 1234" in lg && !("Business checking" in lg) && lg["Sales"] === -(500 + 2000));
    ok("…Merchant Fees takes the Stripe fees on the payments (2.55, 1.20) and the Venmo and cash fees with their cash-outs (2.00, 0.30)", lg["Merchant Fees"] === 255 + 120 + 200 + 30);
    ok("…Postage and Delivery takes the labels (8.50, 6.40)", lg["Postage and Delivery"] === 850 + 640);
    const netSales = dd.sales.reduce((t, x) => t + x.lines.reduce((a, l) => a + l.amountCents, 0), 0) - 1000;
    ok("…Embroidery Sales is credited the goods less the refund", lg["Embroidery Sales"] === -netSales);
    ok("…Sales Tax Payable is credited the tax", lg["Sales Tax Payable"] === -dd.sales.reduce((t, x) => t + x.taxCents, 0));
    const h = iif.split("\r\n").find(l => /^TRNS\tINVOICE\t/.test(l) && l.includes("OD-1007"));
    ok("…the Net 30 order is an INVOICE to Accounts Receivable, due 02/14/2026, Net 30",
      !!h && h.split("\t")[3] === "Accounts Receivable" && h.split("\t")[9] === "02/14/2026" && h.split("\t")[10] === "Net 30");
    const g = iif.split("\r\n").find(l => /^TRNS\t/.test(l) && l.includes("OD-1004"));
    ok("…the gift-card-only order is a sale of 50.00 named for " + (customerName === "shop" ? "its shop" : "its buyer"),
      !!g && g.split("\t")[5] === "50.00" && g.split("\t")[4] === (customerName === "shop" ? "Example Club" : "Walk-in Buyer"));
    const a1 = iif.split("\r\n").filter(l => l.startsWith("TRNS\t") && l.includes("Order OD-1001"));
    ok("…a cash order is " + (salesAs === "invoices" ? "an INVOICE to Accounts Receivable too" : "a CASH SALE to Undeposited Funds"),
      a1.length === 1 && a1[0].split("\t")[1] === (salesAs === "invoices" ? "INVOICE" : "CASH SALE") && a1[0].split("\t")[3] === (salesAs === "invoices" ? "Accounts Receivable" : "Undeposited Funds"));
    // Undeposited Funds, worked out by hand: what the sales put in, what the payments move, what the deposits take out.
    const paymentsMove = -255 - 120 + 4000 - 2000 - 1000;   // fees, OD-0999's Net 30 payment, the gift card spent off it, the refund
    const depositsTake = -7000 + 300 - 2500 - (300 + 30) - 1000 - (9707 + 200);
    if (salesAs === "receipts") {
      ok("…Undeposited Funds: the cash sales (259.57) + the payments' moves + the deposits' takings = 61.45",
        lg["Undeposited Funds"] === (7750 + 5000 + 600 + 700 + 11907) + paymentsMove + depositsTake && lg["Undeposited Funds"] === 6145);
      ok("…and the December Net 30 order's payment clears 40.00 of Accounts Receivable", lg["Accounts Receivable"] === -4000);
    } else {
      ok("…Undeposited Funds: every payment on an invoice (not the check, which went to the bank; not the gift card) less fees, refund and deposits = 11.45",
        lg["Undeposited Funds"] === (7750 - 255) + (4000 - 120) + 600 + 700 + 9907 - 1000 + depositsTake && lg["Undeposited Funds"] === 1145);
      ok("…and Accounts Receivable is left with the unpaid gift card order (50.00) less the December order paid (40.00)", lg["Accounts Receivable"] === 5000 - 4000);
    }
    ok("…the check on the Net 30 order reaches Checking 1234 (with the deposits into it, less the expenses paid from it; the linked move lands on the credit card)",
      lg["Checking 1234"] === 5350 + 7000 - 300 + 2500 + 300 + 9707 - 4500 + 500 && lg["Credit card"] === -850 - 1200 + 1000);
    const parts = QB.buildQuickBooksExport(dd, "desktop", ["sales"]);
    ok("…one part alone (sales) also balances", QB.iifBalanced(parts.files[0].text).ok && !parts.files[0].text.includes("\tDEPOSIT\t"));
    const online = QB.buildQuickBooksExport(dd, "online");
    const names = online.files.map(f => f.filename);
    ok("Online: a sales file" + (salesAs === "receipts" ? ", the Net 30 orders as an invoices file," : "") + " and bank files per part and account",
      names.includes("odd-qbo-sales-2026-01-01-to-2026-01-31.csv") && (salesAs === "receipts") === names.includes("odd-qbo-invoices-2026-01-01-to-2026-01-31.csv")
      && names.some(n => /^odd-qbo-payments-/.test(n)) && names.some(n => /^odd-qbo-expenses-checking-1234-/.test(n)) && names.some(n => /^odd-qbo-deposits-checking-1234-/.test(n)));
    const csvAll = online.files.map(f => f.text).join("");
    ok("…the gift cards sold are \"Gift card\" lines and the Net 30 order is due 02/14/2026", /,Gift card,/.test(csvAll) && csvAll.includes("02/14/2026"));
    ok("…every file has a header and at least one row, all of one width", online.files.every(f => { const ln = f.text.trim().split("\r\n"); const w = (s) => s.replace(/"[^"]*"/g, "").split(",").length; return ln.length > 1 && ln.every(l => w(l) === w(ln[0])); }));
    const sum = desk.summary;
    ok("the summary counts each part: 7 sales worth Σ totalCents, 8 payments, 4 expenses + 2 labels, 6 deposits",
      sum.sales.count === 7 && sum.sales.totalCents === dd.sales.reduce((t, x) => t + x.totalCents, 0) && sum.payments.count === 8
      && sum.expenses.count === 6 && sum.expenses.totalCents === 4500 - 500 + 999 + 1200 + 850 + 640 && sum.deposits.count === 6 && sum.deposits.totalCents === 7000 - 300 + 2500 + 300 + 1000 + 9707);
  }
  ok("an IIF with a transaction that doesn't balance is caught by iifBalanced, naming it",
    same(QB.iifBalanced("!TRNS\tTRNSTYPE\tAMOUNT\tDOCNUM\r\n!SPL\tTRNSTYPE\tAMOUNT\tDOCNUM\r\nTRNS\tCHECK\t10.00\tX1\r\nSPL\tCHECK\t-9.99\tX1\r\nENDTRNS\r\n"), { ok: false, bad: ["X1"] }));

  finished = true;
})();
