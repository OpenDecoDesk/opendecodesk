/**
 * QuickBooks exports (Reports → QuickBooks export): pure builders, no database and no imports. The admin API reads
 * getQuickBooksData (db.js) for a date range and hands it here; what comes back is file text to download.
 *
 *  - QuickBooks Online (CSV): sales as an invoice / sales receipt import (one row per line, shipping, rush, discount,
 *    gift card and sales tax as lines of their own), and payments, expenses and deposits as bank-upload files — the
 *    3-column Date, Description, Amount format — one file per bank account.
 *  - QuickBooks Desktop (IIF): one tab-separated file with every chosen part as balanced transactions (CASH SALE or
 *    INVOICE, PAYMENT, GENERAL JOURNAL, CHECK / DEPOSIT, CREDIT CARD / CCARD REFUND, DEPOSIT). Every transaction sums
 *    to exactly 0: iifBalanced checks the built text and buildIif refuses (throws) rather than hand out a file that
 *    doesn't.
 *
 * Money arrives in whole cents and is written as plain decimals ("1234.50", "-5.00"). Dates are written MM/DD/YYYY.
 * Account names are the owner's mapping (settings.accounts / bankAccounts / expenseAccounts) with defaults.
 *
 * How the parts post (Desktop):
 *  - Sales: INVOICE (salesAs "invoices", and always for a Net 30 order) debits Accounts Receivable; CASH SALE debits
 *    Undeposited Funds. Lines credit Sales (QNTY negative, PRICE the rate), Shipping Income, Rush income, Sales Tax
 *    Payable and Gift Cards Outstanding (a gift card sold is a liability, never a sale); the discount debits Discounts
 *    Given. The transaction's amount is the sum of its parts, so it always balances.
 *  - Payments: money received on an invoiced order is a PAYMENT from Accounts Receivable to Undeposited Funds (a cash
 *    sale already put its money in Undeposited Funds, so a payment on one posts nothing more). Money recorded straight
 *    into a bank account (a check) posts to that account instead of Undeposited Funds, since no deposit moves it. A gift card spent on an
 *    order moves Gift Cards Outstanding to Accounts Receivable / Undeposited Funds (GENERAL JOURNAL). A refund (a
 *    negative amount) takes the money back out of Undeposited Funds (or puts it back on the gift card) against Sales.
 *    A card processor's fee (Stripe, whose payouts are already net) moves from Undeposited Funds to Merchant Fees here;
 *    Venmo and cash fees go with the cash-out deposit that took them.
 *  - Expenses: CHECK from the mapped bank account (a vendor refund: DEPOSIT back into it), or CREDIT CARD / CCARD
 *    REFUND on a credit card account, to the mapped expense account. Paid personally: a GENERAL JOURNAL from Owner's
 *    Equity (accounts.ownerEquity when the settings carry one).
 *  - Deposits: DEPOSIT into the bank account; Undeposited Funds gives up what was paid out plus the fees, and the fees
 *    go to Merchant Fees.
 */

export const QB_PARTS = ["sales", "payments", "expenses", "deposits"];
export const QB_FORMATS = ["online", "desktop"];

export const QB_DEFAULT_ACCOUNTS = {
  sales: "Sales", shippingIncome: "Shipping Income", rushIncome: "Sales", discounts: "Discounts Given",
  salesTaxPayable: "Sales Tax Payable", giftCardLiability: "Gift Cards Outstanding", undepositedFunds: "Undeposited Funds",
  cardFees: "Merchant Fees", postage: "Postage and Delivery", ar: "Accounts Receivable",
};
const OWNER_EQUITY_DEFAULT_ = "Owner's Equity";

// ---- small helpers -------------------------------------------------------------------------------------------------

const int_ = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : 0; };
// Whole cents as a plain decimal: 123450 → "1234.50", -500 → "-5.00".
export function qbAmount_(cents) {
  const c = int_(cents);
  const a = Math.abs(c);
  return (c < 0 ? "-" : "") + Math.floor(a / 100) + "." + String(a % 100).padStart(2, "0");
}
// "2026-01-31" (or an ISO time) → "01/31/2026"; anything else → "".
export function qbDate_(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v == null ? "" : v));
  return m ? `${m[2]}/${m[3]}/${m[1]}` : "";
}
// A name for either format: control characters, tabs and line breaks become one space, trimmed.
const clean_ = (v) => String(v == null ? "" : v).replace(/[\u0000-\u001F\u007F\u2028\u2029]+/g, " ").replace(/\s{2,}/g, " ").trim();
// Between the parts of a memo or description: plain ASCII (QuickBooks Desktop reads an IIF file as Windows text).
const SEP_ = " - ";
// A file name part: letters, digits and "-" only.
const slug_ = (v) => String(v == null ? "" : v).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "account";
const ymd_ = (v) => { const m = /^\d{4}-\d{2}-\d{2}/.exec(String(v == null ? "" : v)); return m ? m[0] : ""; };

// odd-qbo-sales-2026-01-01-to-2026-01-31.csv / odd-quickbooks-2026-01-01-to-2026-01-31.iif. `extra` (a bank
// account's name) goes after the part for the per-account bank files: odd-qbo-payments-business-checking-….csv.
export function qbFilename_(format, part, from, to, extra) {
  const range = `${ymd_(from) || "start"}-to-${ymd_(to) || "end"}`;
  if (format === "desktop") return `odd-quickbooks-${range}.iif`;
  return `odd-qbo-${slug_(part)}${extra ? "-" + slug_(extra) : ""}-${range}.csv`;
}

// The settings with every default filled in (whatever getQuickBooksSettings sent, or nothing).
function settingsOf_(data) {
  const s = (data && data.settings) || {};
  const accounts = Object.assign({}, QB_DEFAULT_ACCOUNTS);
  for (const [k, v] of Object.entries(s.accounts || {})) if (clean_(v)) accounts[k] = clean_(v);
  return {
    format: s.format === "desktop" ? "desktop" : "online",
    accounts,
    bankAccounts: s.bankAccounts || {},
    expenseAccounts: s.expenseAccounts || {},
    salesAs: s.salesAs === "invoices" ? "invoices" : "receipts",
    customerName: s.customerName === "shop" ? "shop" : "customer",
  };
}

function context_(data) {
  const d = data || {};
  const s = settingsOf_(d);
  const appAccounts = new Map((d.accounts || []).map(a => [String(a.id), a]));
  const categories = new Map((d.categories || []).map(c => [String(c.id), c]));
  const sales = Array.isArray(d.sales) ? d.sales : [];
  const saleById = new Map(sales.map(x => [String(x.orderId), x]));
  const bankName = (id) => {
    if (id == null || id === "") return "";
    const mapped = clean_(s.bankAccounts[String(id)]);
    if (mapped) return mapped;
    const a = appAccounts.get(String(id));
    return clean_(a && a.name) || "Account " + id;
  };
  const bankType = (id) => { const a = appAccounts.get(String(id)); return (a && a.type) || ""; };
  const expenseName = (x) => clean_(s.expenseAccounts[String(x.categoryId)])
    || clean_(x.categoryName) || clean_((categories.get(String(x.categoryId)) || {}).name) || "Uncategorized Expense";
  const nameOf = (sale) => {
    const c = clean_(sale && sale.customer), sh = clean_(sale && sale.shop);
    return (s.customerName === "shop" ? (sh || c) : (c || sh)) || "Customer";
  };
  const isInvoice = (sale) => s.salesAs === "invoices" || !!(sale && sale.net30);
  return { d, s, sales, saleById, bankName, bankType, expenseName, nameOf, isInvoice, from: d.dateFrom, to: d.dateTo };
}

// A sale's parts in cents, the total always their own sum (so a file never disagrees with itself).
function saleParts_(sale) {
  const lines = (Array.isArray(sale.lines) ? sale.lines : []).map(l => ({
    name: clean_(l.name) || "Item", qty: Number(l.qty) || 0, rateCents: int_(l.rateCents), amountCents: int_(l.amountCents),
    taxable: !!l.taxable,
  }));
  const goods = lines.reduce((t, l) => t + l.amountCents, 0);
  const discount = Math.abs(int_(sale.discountCents));
  const shipping = int_(sale.shippingCents), rush = int_(sale.rushCents), tax = int_(sale.taxCents), gift = int_(sale.giftCardCents);
  return { lines, goods, discount, shipping, rush, tax, gift, total: goods - discount + shipping + rush + tax + gift };
}

// ---- QuickBooks Online (CSV) --------------------------------------------------------------------------------------

// One CSV cell. Text that a spreadsheet would read as a formula (= + - @, or a leading tab / CR) gets a leading
// apostrophe; numbers (amounts, quantities, rates) are written as they are so they stay numbers.
function csvCell_(v) {
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (v && typeof v === "object" && v.num != null) return String(v.num);
  let s = String(v == null ? "" : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]+/g, " ");
  if (/^[\t\r\n]|^\s*[=+\-@＝＋－＠]/.test(s)) s = "'" + s;
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const num_ = (cents) => ({ num: qbAmount_(cents) });   // an amount cell: never guarded, never quoted
const csv_ = (header, rows) => [header.map(csvCell_).join(",")].concat(rows.map(r => r.map(csvCell_).join(","))).join("\r\n") + "\r\n";

// `inv`: the invoice file (salesAs "invoices", or the Net 30 orders when sales go in as receipts) or the receipt file.
function qboSalesCsv_(cx, inv, sales) {
  // The invoice import's columns (QuickBooks Online ▸ Settings ▸ Import data ▸ Invoices); a sales receipt file has the
  // same line columns under the receipt's own names.
  const header = inv
    ? ["InvoiceNo", "Customer", "InvoiceDate", "DueDate", "Terms", "Memo", "Item(Product/Service)", "ItemDescription", "ItemQuantity", "ItemRate", "ItemAmount", "Taxable"]
    : ["SalesReceiptNo", "Customer", "SalesReceiptDate", "DepositTo", "Memo", "Item(Product/Service)", "ItemDescription", "ItemQuantity", "ItemRate", "ItemAmount", "Taxable"];
  const A = cx.s.accounts;
  const rows = [];
  for (const sale of sales) {
    const p = saleParts_(sale);
    const no = clean_(sale.orderId), who = cx.nameOf(sale), date = qbDate_(sale.date);
    const net30 = !!sale.net30;
    const memo = clean_([sale.poNumber ? "PO " + clean_(sale.poNumber) : "", cx.s.customerName === "shop" ? clean_(sale.customer) : clean_(sale.shop)].filter(Boolean).join(SEP_));
    const head = inv
      ? [no, who, date, qbDate_(sale.dueDate) || (net30 ? "" : date), net30 ? "Net 30" : "Due on receipt", memo]
      : [no, who, date, A.undepositedFunds, memo];
    const line = (item, desc, qty, rateCents, amountCents, taxable) =>
      rows.push(head.concat([item, desc, { num: String(qty) }, num_(rateCents), num_(amountCents), taxable ? "Y" : "N"]));
    for (const l of p.lines) line(A.sales, l.name, l.qty, l.rateCents, l.amountCents, l.taxable);
    if (p.gift) line("Gift card", "Gift card sold (" + A.giftCardLiability + ")", 1, p.gift, p.gift, false);
    if (p.shipping) line("Shipping", "Shipping (" + A.shippingIncome + ")", 1, p.shipping, p.shipping, false);
    if (p.rush) line("Rush", "Rush (" + A.rushIncome + ")", 1, p.rush, p.rush, false);
    if (p.discount) line("Discount", "Discount (" + A.discounts + ")", 1, -p.discount, -p.discount, false);
    if (p.tax) line("Sales tax", "Sales tax (" + A.salesTaxPayable + ")", 1, p.tax, p.tax, false);
  }
  return csv_(header, rows);
}

// Bank-upload files: rows grouped by the account's QuickBooks name, one 3-column file per account.
function bankFiles_(cx, part, items) {
  const by = new Map();
  for (const it of items) {
    if (!it.cents) continue;
    if (!by.has(it.account)) by.set(it.account, []);
    by.get(it.account).push(it);
  }
  return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([account, list]) => ({
    filename: qbFilename_("online", part, cx.from, cx.to, account),
    account,
    csv: csv_(["Date", "Description", "Amount"], list.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .map(it => [qbDate_(it.date), clean_(it.description).slice(0, 200), num_(it.cents)])),
  }));
}

function qboPaymentItems_(cx) {
  const items = [];
  for (const p of cx.d.payments || []) {
    if (p.giftCard) continue;   // a gift card spent is no money in any bank
    const account = cx.bankName(p.accountId) || cx.s.accounts.undepositedFunds;
    const amt = int_(p.amountCents);
    const sale = cx.saleById.get(String(p.orderId));
    const who = sale ? cx.nameOf(sale) : clean_(p.customer || p.shop);
    const what = amt < 0 ? "Refund" : "Payment";
    items.push({ account, date: p.date, cents: amt,
      description: [what, "order " + clean_(p.orderId), who, clean_(p.method), clean_(p.reference)].filter(Boolean).join(SEP_) });
    const fee = int_(p.feeCents);
    if (fee) items.push({ account, date: p.date, cents: -fee, description: ["Card fee", "order " + clean_(p.orderId), clean_(p.reference)].filter(Boolean).join(SEP_) });
  }
  return items;
}
function qboExpenseItems_(cx) {
  const items = [];
  for (const x of cx.d.expenses || []) {
    const account = x.paidPersonally ? "Paid personally" : (cx.bankName(x.accountId) || "No account");
    const amt = int_(x.amountCents);
    items.push({ account, date: x.date, cents: -amt,
      description: [clean_(x.payee) || "Expense", cx.expenseName(x), clean_(x.memo)].filter(Boolean).join(SEP_) });
  }
  for (const x of cx.d.postage || []) {
    const account = cx.bankName(x.accountId) || "No account";
    items.push({ account, date: x.date, cents: -int_(x.amountCents),
      description: ["Postage", x.orderId ? "order " + clean_(x.orderId) : "", clean_(x.memo), cx.s.accounts.postage].filter(Boolean).join(SEP_) });
  }
  return items;
}
function qboDepositItems_(cx) {
  return (cx.d.deposits || []).map(x => ({
    account: cx.bankName(x.accountId) || "No account", date: x.date, cents: int_(x.amountCents),
    description: ["Deposit", x.feeCents ? "fees " + qbAmount_(x.feeCents) + " (" + cx.s.accounts.cardFees + ")" : "",
      (x.paymentIds || []).length ? (x.paymentIds.length + " payment" + (x.paymentIds.length === 1 ? "" : "s")) : "", clean_(x.memo || x.note)].filter(Boolean).join(SEP_),
  }));
}

// part "sales" → { filename, csv, files: [{ filename, csv }] }; payments / expenses / deposits → { files: [...] }
// (one file per bank account; no file when there is nothing to send).
export function buildQboCsv(data, part) {
  if (!QB_PARTS.includes(part)) throw new Error("Unknown QuickBooks part: " + part);
  const cx = context_(data);
  if (part === "sales") {
    // Sales receipts can't be on terms: with sales going in as receipts, Net 30 orders go in a second, invoice file
    // (odd-qbo-invoices-….csv). `filename` / `csv` are the main file; `files` every file that has rows.
    const asInvoices = cx.s.salesAs === "invoices";
    const main = asInvoices ? cx.sales : cx.sales.filter(x => !x.net30);
    const termed = asInvoices ? [] : cx.sales.filter(x => x.net30);
    const filename = qbFilename_("online", "sales", cx.from, cx.to);
    const csv = qboSalesCsv_(cx, asInvoices, main);
    const files = main.length ? [{ filename, csv }] : [];
    if (termed.length) files.push({ filename: qbFilename_("online", "invoices", cx.from, cx.to), csv: qboSalesCsv_(cx, true, termed) });
    return { filename, csv, files };
  }
  const items = part === "payments" ? qboPaymentItems_(cx) : part === "expenses" ? qboExpenseItems_(cx) : qboDepositItems_(cx);
  return { files: bankFiles_(cx, part, items) };
}

// ---- QuickBooks Desktop (IIF) -------------------------------------------------------------------------------------

const TRNS_COLS_ = ["TRNSTYPE", "DATE", "ACCNT", "NAME", "AMOUNT", "DOCNUM", "MEMO", "CLEAR", "DUEDATE", "TERMS"];
const SPL_COLS_ = ["TRNSTYPE", "DATE", "ACCNT", "NAME", "AMOUNT", "DOCNUM", "MEMO", "CLEAR", "QNTY", "PRICE"];
// IIF has no quoting: a tab or line break would split the row, and a double quote can be read as one.
const iifText_ = (v) => clean_(v).replace(/"/g, "'");
// QuickBooks Desktop keeps 11 characters of a reference number; a longer order number keeps its end (the full one is
// in the memo).
const docnum_ = (v) => { const s = iifText_(v).replace(/\s+/g, ""); return s.length > 11 ? s.slice(-11) : s; };

// One transaction: { type, date, docnum, memo, dueDate, terms, trns: { accnt, name, amount }, spl: [{ accnt, name,
// amount, memo, qnty, price }] } — amounts in cents, debit positive. Zero split lines are left out.
function iifTrns_(t) {
  const date = qbDate_(t.date);
  const docnum = docnum_(t.docnum);
  const row = (kind, cols, vals) => [kind].concat(cols.map(c => vals[c] == null ? "" : String(vals[c]))).join("\t");
  const out = [row("TRNS", TRNS_COLS_, { TRNSTYPE: t.type, DATE: date, ACCNT: iifText_(t.trns.accnt), NAME: iifText_(t.trns.name),
    AMOUNT: qbAmount_(t.trns.amount), DOCNUM: docnum, MEMO: iifText_(t.memo), CLEAR: "N", DUEDATE: qbDate_(t.dueDate), TERMS: iifText_(t.terms) })];
  for (const s of t.spl) {
    if (!int_(s.amount)) continue;
    out.push(row("SPL", SPL_COLS_, { TRNSTYPE: t.type, DATE: date, ACCNT: iifText_(s.accnt), NAME: iifText_(s.name),
      AMOUNT: qbAmount_(s.amount), DOCNUM: docnum, MEMO: iifText_(s.memo != null ? s.memo : t.memo), CLEAR: "N",
      QNTY: s.qnty != null ? String(s.qnty) : "", PRICE: s.price != null ? qbAmount_(s.price) : "" }));
  }
  out.push("ENDTRNS");
  return out;
}

function iifSales_(cx) {
  const A = cx.s.accounts, list = [];
  for (const sale of cx.sales) {
    const p = saleParts_(sale), who = cx.nameOf(sale), inv = cx.isInvoice(sale);
    const memo = ["Order " + clean_(sale.orderId), sale.poNumber ? "PO " + clean_(sale.poNumber) : ""].filter(Boolean).join(SEP_);
    const spl = p.lines.map(l => ({ accnt: A.sales, name: who, amount: -l.amountCents, memo: l.name,
      qnty: l.qty ? -l.qty : null, price: l.rateCents }));
    spl.push({ accnt: A.giftCardLiability, name: who, amount: -p.gift, memo: "Gift card sold" });
    spl.push({ accnt: A.shippingIncome, name: who, amount: -p.shipping, memo: "Shipping" });
    spl.push({ accnt: A.rushIncome, name: who, amount: -p.rush, memo: "Rush" });
    spl.push({ accnt: A.discounts, name: who, amount: p.discount, memo: "Discount" });
    spl.push({ accnt: A.salesTaxPayable, name: who, amount: -p.tax, memo: "Sales tax" });
    if (!spl.some(s => int_(s.amount))) continue;   // nothing to post (an empty order)
    list.push({ type: inv ? "INVOICE" : "CASH SALE", date: sale.date, docnum: sale.orderId, memo,
      dueDate: inv ? (sale.dueDate || "") : "", terms: inv ? (sale.net30 ? "Net 30" : "Due on receipt") : "",
      trns: { accnt: inv ? A.ar : A.undepositedFunds, name: who, amount: p.total }, spl });
  }
  return list;
}

function iifPayments_(cx) {
  const A = cx.s.accounts, list = [];
  for (const p of cx.d.payments || []) {
    const amt = int_(p.amountCents);
    if (!amt) continue;
    const sale = cx.saleById.get(String(p.orderId));
    // An order not in this export: its own flags when the row carries them, else the settings.
    const inv = sale ? cx.isInvoice(sale) : (cx.s.salesAs === "invoices" || !!p.net30);
    const who = sale ? cx.nameOf(sale) : (clean_(cx.s.customerName === "shop" ? (p.shop || p.customer) : (p.customer || p.shop)) || "Customer");
    const memo = [p.giftCard ? "Gift card" : (amt < 0 ? "Refund" : "Payment"), "order " + clean_(p.orderId), clean_(p.method), clean_(p.reference)].filter(Boolean).join(SEP_);
    const docnum = p.reference && !p.giftCard ? p.reference : "PAY" + p.id;
    const owedAcct = inv ? A.ar : A.undepositedFunds;
    // Money recorded straight into a bank account (a check deposited, a transfer): no payout or cash-out deposit ever
    // moves it out of Undeposited Funds, so it posts to that account itself. Stripe, Venmo and cash wait in
    // Undeposited Funds for their deposit (iifDeposits_).
    const type = cx.bankType(p.accountId);
    const direct = !p.giftCard && p.accountId != null && p.accountId !== "" && !!type && !/^(stripe|venmo|cash)$/.test(type);
    const moneyAcct = direct ? cx.bankName(p.accountId) : A.undepositedFunds;
    if (amt > 0 && p.giftCard) {
      // A card's balance spent on the order: the liability goes down, and the order is settled by it.
      list.push({ type: "GENERAL JOURNAL", date: p.date, docnum, memo,
        trns: { accnt: A.giftCardLiability, name: who, amount: amt }, spl: [{ accnt: owedAcct, name: who, amount: -amt }] });
    } else if (amt > 0) {
      // A card processor's fee (Stripe): its payout is already net and links no payments, so the fee leaves
      // Undeposited Funds here. Venmo / cash fees go with the cash-out deposit that took them (iifDeposits_).
      const fee = int_(p.feeCents), feeHere = fee > 0 && !/^(venmo|cash)$/.test(type);
      if (feeHere) list.push({ type: "GENERAL JOURNAL", date: p.date, docnum: "FEE" + p.id, memo: ["Card fee", "order " + clean_(p.orderId), clean_(p.reference)].filter(Boolean).join(SEP_),
        trns: { accnt: A.cardFees, name: "", amount: fee }, spl: [{ accnt: moneyAcct, name: "", amount: -fee }] });
      if (inv) {
        list.push({ type: "PAYMENT", date: p.date, docnum, memo,
          trns: { accnt: moneyAcct, name: who, amount: amt }, spl: [{ accnt: A.ar, name: who, amount: -amt }] });
      } else if (direct) {
        // A cash sale put the money in Undeposited Funds; this one went straight to the bank.
        list.push({ type: "DEPOSIT", date: p.date, docnum, memo,
          trns: { accnt: moneyAcct, name: "", amount: amt }, spl: [{ accnt: A.undepositedFunds, name: who, amount: -amt }] });
      }
      // (Otherwise a cash sale already put this money in Undeposited Funds.)
    } else {
      // A refund: the money goes back out (or back on the card) and comes off Sales.
      list.push({ type: "GENERAL JOURNAL", date: p.date, docnum, memo,
        trns: { accnt: p.giftCard ? A.giftCardLiability : moneyAcct, name: who, amount: amt },
        spl: [{ accnt: A.sales, name: who, amount: -amt }] });
    }
  }
  return list;
}

function iifExpenses_(cx) {
  const A = cx.s.accounts, list = [];
  const owner = A.ownerEquity || OWNER_EQUITY_DEFAULT_;
  const one = (x, expenseAcct, memoParts) => {
    const amt = int_(x.amountCents);
    if (!amt) return;
    const payee = clean_(x.payee) || "Vendor";
    const memo = memoParts.filter(Boolean).join(SEP_);
    const docnum = "EXP" + x.id;
    if (x.paidPersonally || x.accountId == null || x.accountId === "") {
      list.push({ type: "GENERAL JOURNAL", date: x.date, docnum, memo: memo || "Paid personally",
        trns: { accnt: owner, name: payee, amount: -amt }, spl: [{ accnt: expenseAcct, name: payee, amount: amt }] });
      return;
    }
    const card = cx.bankType(x.accountId) === "credit_card";
    const type = card ? (amt > 0 ? "CREDIT CARD" : "CCARD REFUND") : (amt > 0 ? "CHECK" : "DEPOSIT");
    list.push({ type, date: x.date, docnum, memo,
      trns: { accnt: cx.bankName(x.accountId), name: payee, amount: -amt }, spl: [{ accnt: expenseAcct, name: payee, amount: amt }] });
  };
  for (const x of cx.d.expenses || []) one(x, cx.expenseName(x), [clean_(x.memo), x.paidPersonally ? "Paid personally" : ""]);
  for (const x of cx.d.postage || []) one(Object.assign({ payee: "Postage" }, x, { id: "L" + x.id }), A.postage, ["Postage", x.orderId ? "order " + clean_(x.orderId) : "", clean_(x.memo)]);
  return list;
}

function iifDeposits_(cx) {
  const A = cx.s.accounts, list = [];
  for (const x of cx.d.deposits || []) {
    const amt = int_(x.amountCents), fee = int_(x.feeCents);
    if (!amt && !fee) continue;
    const n = (x.paymentIds || []).length;
    list.push({ type: "DEPOSIT", date: x.date, docnum: "DEP" + x.id,
      memo: ["Deposit", n ? n + " payment" + (n === 1 ? "" : "s") : "", clean_(x.memo || x.note)].filter(Boolean).join(SEP_),
      trns: { accnt: cx.bankName(x.accountId) || A.undepositedFunds, name: "", amount: amt },
      spl: [{ accnt: A.undepositedFunds, name: "", amount: -(amt + fee) }, { accnt: A.cardFees, name: "", amount: fee, memo: "Card fees" }] });
  }
  return list;
}

// { filename, iif }: the chosen parts (default all) in one file, CRLF line ends. Throws when a transaction doesn't
// balance — a file QuickBooks would take in crooked is never handed out.
export function buildIif(data, parts) {
  const want = (Array.isArray(parts) && parts.length ? parts : QB_PARTS).filter(p => QB_PARTS.includes(p));
  const cx = context_(data);
  const rows = ["!TRNS\t" + TRNS_COLS_.join("\t"), "!SPL\t" + SPL_COLS_.join("\t"), "!ENDTRNS"];
  const build = { sales: iifSales_, payments: iifPayments_, expenses: iifExpenses_, deposits: iifDeposits_ };
  for (const part of QB_PARTS) {
    if (!want.includes(part)) continue;
    for (const t of build[part](cx)) rows.push(...iifTrns_(t));
  }
  const iif = rows.join("\r\n") + "\r\n";
  const check = iifBalanced(iif);
  if (!check.ok) throw new Error("The QuickBooks file doesn't balance (" + check.bad.join(", ") + "). Nothing was exported.");
  return { filename: qbFilename_("desktop", "", cx.from, cx.to), iif };
}

// Reads an IIF file back: every TRNS with its SPL lines up to ENDTRNS must sum to exactly 0 (in cents).
// → { ok, bad: [docnum (or "line N" when it has none)] }.
export function iifBalanced(iif) {
  const lines = String(iif == null ? "" : iif).split(/\r?\n/);
  let trnsCols = null, splCols = null, cur = null;
  const bad = [];
  const cents = (v) => { const s = String(v == null ? "" : v).trim(); if (!s) return 0; if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return NaN; return Math.round(Number(s) * 100); };
  const close = () => { if (cur && (!Number.isFinite(cur.sum) || cur.sum !== 0 || cur.bad)) bad.push(cur.docnum || "line " + cur.line); cur = null; };
  lines.forEach((ln, i) => {
    if (!ln) return;
    const f = ln.split("\t");
    const kind = f[0];
    if (kind === "!TRNS") { trnsCols = f; return; }
    if (kind === "!SPL") { splCols = f; return; }
    if (kind === "TRNS") {
      if (cur) { cur.bad = true; close(); }   // the previous one never ended
      const ai = trnsCols ? trnsCols.indexOf("AMOUNT") : -1, di = trnsCols ? trnsCols.indexOf("DOCNUM") : -1;
      cur = { docnum: di >= 0 ? f[di] : "", line: i + 1, sum: ai >= 0 ? cents(f[ai]) : NaN, bad: ai < 0 };
      return;
    }
    if (kind === "SPL") {
      if (!cur) { bad.push("line " + (i + 1)); return; }
      const ai = splCols ? splCols.indexOf("AMOUNT") : -1;
      if (ai < 0) cur.bad = true; else cur.sum += cents(f[ai]);
      return;
    }
    if (kind === "ENDTRNS") { if (cur) close(); return; }
  });
  if (cur) { cur.bad = true; close(); }
  return { ok: bad.length === 0, bad };
}

// What an export holds, per part: { sales: { count, totalCents }, payments, expenses, deposits }. Sales total = what the
// orders came to (gift cards sold and tax included); payments = money received less refunded (gift cards included);
// expenses = spent less vendor refunds; deposits = what reached the banks.
export function qbSummary(data) {
  const d = data || {};
  const sum = (list, f) => (list || []).reduce((t, x) => t + f(x), 0);
  const sales = Array.isArray(d.sales) ? d.sales : [];
  return {
    sales: { count: sales.length, totalCents: sum(sales, x => saleParts_(x).total) },
    payments: { count: (d.payments || []).length, totalCents: sum(d.payments, x => int_(x.amountCents)) },
    expenses: { count: (d.expenses || []).length + (d.postage || []).length, totalCents: sum(d.expenses, x => int_(x.amountCents)) + sum(d.postage, x => int_(x.amountCents)) },
    deposits: { count: (d.deposits || []).length, totalCents: sum(d.deposits, x => int_(x.amountCents)) },
  };
}

// The whole export the admin API answers: files for the chosen parts in the chosen format, and the summary.
// → { files: [{ filename, mime, text }], summary }.
export function buildQuickBooksExport(data, format, parts) {
  const want = (Array.isArray(parts) && parts.length ? parts : QB_PARTS).filter(p => QB_PARTS.includes(p));
  const files = [];
  if (format === "desktop") {
    if (want.length) { const f = buildIif(data, want); files.push({ filename: f.filename, mime: "application/octet-stream", text: f.iif }); }
  } else {
    for (const part of want) for (const f of buildQboCsv(data, part).files) files.push({ filename: f.filename, mime: "text/csv", text: f.csv });
  }
  return { files, summary: qbSummary(data) };
}
