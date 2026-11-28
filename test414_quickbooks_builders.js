process.env.TZ = "UTC";
const fs = require("fs");
const { ok } = require("./testlib/check");

// The QuickBooks builders (functions/_lib/quickbooks.js), pure functions fed plain rows the way getQuickBooksData
// hands them over:
//   QB_PARTS / QB_FORMATS / QB_DEFAULT_ACCOUNTS, qbAmount_, qbDate_, qbFilename_;
//   buildQboCsv (QuickBooks Online): sales as sales receipts or invoices (Net 30 orders always on invoices, in their own
//   file when sales go in as receipts), the gift card / shipping / rush / discount / sales tax lines, the column names,
//   MM/DD/YYYY dates, plain decimal amounts, quoting, the formula guard that leaves number cells alone, mapped names;
//   payments, expenses (vendor refunds, paid personally, postage) and deposits as 3-column bank files, one per account;
//   buildIif (QuickBooks Desktop): CASH SALE vs INVOICE, PAYMENT, gift card redemptions and refunds, card fees,
//   checks paid straight into the bank, CHECK / DEPOSIT / CREDIT CARD / CCARD REFUND / paid personally, DEPOSIT with
//   fees, the header blocks, CRLF, names cleaned of tabs and line breaks, the parts chosen, every transaction balanced;
//   iifBalanced finding each kind of crooked transaction, and buildIif refusing a file that doesn't balance.
// No database and no clock: every date is a fixed string. Invented shops, people and numbers only.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const src = read("functions/_lib/quickbooks.js").replace(/export (async function|function|const)/g, "$1");
const QB = new Function(src + "\nreturn { QB_PARTS, QB_FORMATS, QB_DEFAULT_ACCOUNTS, qbAmount_, qbDate_, qbFilename_, buildQboCsv, buildIif, iifBalanced };")();
const { QB_PARTS, QB_FORMATS, QB_DEFAULT_ACCOUNTS, qbAmount_, qbDate_, qbFilename_, buildQboCsv, buildIif, iifBalanced } = QB;

// ---- small readers for the files ------------------------------------------------------------------------------------
function parseCsv(text) {
  const rows = []; let row = [], cell = "", q = false, i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 2; continue; }
      if (ch === '"') { q = false; i++; continue; }
      cell += ch; i++; continue;
    }
    if (ch === '"') { q = true; i++; continue; }
    if (ch === ",") { row.push(cell); cell = ""; i++; continue; }
    if (ch === "\r" && text[i + 1] === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; i += 2; continue; }
    cell += ch; i++;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
const asObjects = (csv) => { const r = parseCsv(csv); return r.slice(1).map(x => Object.fromEntries(r[0].map((h, i) => [h, x[i]]))); };
const lines = (csv) => csv.split("\r\n");
function parseIif(iif) {
  const ls = iif.split("\r\n").filter(Boolean);
  const trnsCols = ls[0].split("\t"), splCols = ls[1].split("\t");
  const list = []; let cur = null;
  for (const ln of ls.slice(3)) {
    const f = ln.split("\t");
    if (f[0] === "TRNS") { cur = { trns: Object.fromEntries(trnsCols.map((c, i) => [c, f[i]])), spl: [] }; list.push(cur); }
    else if (f[0] === "SPL") cur.spl.push(Object.fromEntries(splCols.map((c, i) => [c, f[i]])));
  }
  return list;
}
const byDoc = (list, doc) => list.filter(t => t.trns.DOCNUM === doc);
const one = (list, doc) => { const l = byDoc(list, doc); return l.length === 1 ? l[0] : null; };
const sumCents = (t) => Math.round(Number(t.trns.AMOUNT) * 100) + t.spl.reduce((s, x) => s + Math.round(Number(x.AMOUNT) * 100), 0);
const throws = (fn) => { try { fn(); return null; } catch (e) { return e; } };

// ---- the invented data ----------------------------------------------------------------------------------------------
const ACCOUNTS = [
  { id: 1, name: "Business Checking", type: "checking" },
  { id: 2, name: "Stripe", type: "stripe" },
  { id: 3, name: "Venmo", type: "venmo" },
  { id: 4, name: "Cash drawer", type: "cash" },
  { id: 5, name: "Business Card", type: "credit_card" },
];
const CATEGORIES = [{ id: 7, name: "Blanks" }, { id: 8, name: "Supplies" }];
const SALE_A = { orderId: "ODD-1001", date: "2026-01-05", customer: "Pat Example", shop: "Example Club", poNumber: "PO-77",
  lines: [{ name: "Polo (navy)", qty: 2, rateCents: 2500, amountCents: 5000, taxable: true }],
  discountCents: -500, shippingCents: 800, rushCents: 1000, taxCents: 450, giftCardCents: 0, net30: false, dueDate: null };
const SALE_B = { orderId: "ODD-1002", date: "2026-01-05", customer: "Example School District", shop: "",
  lines: [{ name: "=HYPERLINK(\"x\")", qty: 1, rateCents: 1000, amountCents: 1000, taxable: false }],
  discountCents: 0, shippingCents: 0, rushCents: 0, taxCents: 0, giftCardCents: 0, net30: true, dueDate: "2026-02-04" };
const SALE_C = { orderId: "ODD-1003", date: "2026-01-31", customer: "", shop: "", lines: [],
  discountCents: 0, shippingCents: 0, rushCents: 0, taxCents: 0, giftCardCents: 5000, net30: false };
const SALE_EMPTY = { orderId: "ODD-1004", date: "2026-01-20", customer: "Sam Example", lines: [] };
const PAYMENTS = [
  { id: 11, orderId: "ODD-1001", date: "2026-01-06", method: "card", accountId: 2, amountCents: 7000, feeCents: 233, reference: "ch_1" },
  { id: 12, orderId: "ODD-1002", date: "2026-01-20", method: "check", accountId: 1, amountCents: 1000, feeCents: 0, reference: "Check 501" },
  { id: 13, orderId: "ODD-1001", date: "2026-01-06", method: "gift card", accountId: null, amountCents: 500, giftCard: true },
  { id: 14, orderId: "ODD-1001", date: "2026-01-09", method: "card", accountId: 2, amountCents: -1000, feeCents: 0, reference: "re_1" },
  { id: 15, orderId: "ODD-0999", date: "2026-01-07", method: "venmo", accountId: 3, amountCents: 2000, feeCents: 50, customer: "Example Parent", shop: "Example Booster Club", net30: true },
  { id: 16, orderId: "ODD-1003", date: "2026-01-31", method: "cash", accountId: null, amountCents: 5000 },
  { id: 17, orderId: "ODD-1001", date: "2026-01-08", method: "check", accountId: 1, amountCents: 300 },
  { id: 18, orderId: "ODD-1001", date: "2026-01-10", method: "gift card", accountId: null, amountCents: -200, giftCard: true },
  { id: 19, orderId: "ODD-1001", date: "2026-01-11", method: "cash", accountId: 4, amountCents: 400, feeCents: 10 },
  { id: 20, orderId: "ODD-1001", date: "2026-01-11", method: "card", accountId: 2, amountCents: 0 },
];
const EXPENSES = [
  { id: 21, date: "2026-01-12", payee: "Example Blanks Co", categoryId: 7, categoryName: "Blanks", accountId: 1, amountCents: 12000, memo: "Polos", paidPersonally: false },
  { id: 22, date: "2026-01-13", payee: "Example Supply", categoryId: 8, categoryName: "Supplies", accountId: 1, amountCents: -2000, memo: "", paidPersonally: false },
  { id: 23, date: "2026-01-14", payee: "", categoryId: 9, categoryName: "", accountId: 1, amountCents: 900, memo: "", paidPersonally: true },
  { id: 24, date: "2026-01-15", payee: "Example Thread", categoryId: 7, accountId: 5, amountCents: 3000, memo: "", paidPersonally: false },
  { id: 25, date: "2026-01-16", payee: "Example Thread", categoryId: 7, accountId: 5, amountCents: -1000, memo: "", paidPersonally: false },
  { id: 26, date: "2026-01-17", payee: "=SUM(A1)", categoryId: 8, accountId: null, amountCents: 400, memo: "", paidPersonally: false },
  { id: 27, date: "2026-01-18", payee: "Example Nothing", categoryId: 8, accountId: 1, amountCents: 0, memo: "" },
];
const POSTAGE = [
  { id: 31, date: "2026-01-07", orderId: "ODD-1001", accountId: 1, amountCents: 845, memo: "USPS" },
  { id: 32, date: "2026-01-08", orderId: null, accountId: null, amountCents: 300, memo: "" },
];
const DEPOSITS = [
  { id: 41, date: "2026-01-08", accountId: 1, amountCents: 6767, feeCents: 233, paymentIds: [11], note: "Stripe payout" },
  { id: 42, date: "2026-01-09", accountId: 1, amountCents: 1950, feeCents: 50, paymentIds: [15, 16], memo: "Venmo cash-out" },
  { id: 43, date: "2026-01-10", accountId: null, amountCents: 100, feeCents: 0, paymentIds: [] },
  { id: 44, date: "2026-01-10", accountId: 1, amountCents: 0, feeCents: 0, paymentIds: [] },
  { id: 45, date: "2026-01-11", accountId: 1, amountCents: 0, feeCents: 100, paymentIds: [] },
];
const data = (settings, more) => Object.assign({
  dateFrom: "2026-01-01", dateTo: "2026-01-31",
  sales: [SALE_A, SALE_B, SALE_C, SALE_EMPTY], payments: PAYMENTS, expenses: EXPENSES, postage: POSTAGE, deposits: DEPOSITS,
  accounts: ACCOUNTS, categories: CATEGORIES,
  settings: Object.assign({ bankAccounts: { "1": "Checking (QB)" }, expenseAccounts: { "7": "Cost of Goods Sold:Blanks" } }, settings || {}),
}, more || {});

(async () => {
  // ---- constants and small helpers --------------------------------------------------------------------------------
  ok("the parts are sales, payments, expenses and deposits, in that order", JSON.stringify(QB_PARTS) === '["sales","payments","expenses","deposits"]');
  ok("the formats are online and desktop", JSON.stringify(QB_FORMATS) === '["online","desktop"]');
  ok("the default accounts are QuickBooks' usual names, rush going to Sales",
    QB_DEFAULT_ACCOUNTS.sales === "Sales" && QB_DEFAULT_ACCOUNTS.rushIncome === "Sales" && QB_DEFAULT_ACCOUNTS.undepositedFunds === "Undeposited Funds"
    && QB_DEFAULT_ACCOUNTS.giftCardLiability === "Gift Cards Outstanding" && QB_DEFAULT_ACCOUNTS.ar === "Accounts Receivable" && QB_DEFAULT_ACCOUNTS.cardFees === "Merchant Fees");
  ok("an amount is a plain decimal with two places", qbAmount_(123450) === "1234.50" && qbAmount_(5) === "0.05" && qbAmount_(0) === "0.00");
  ok("a negative amount starts with a minus and nothing else", qbAmount_(-500) === "-5.00" && qbAmount_(-5) === "-0.05");
  ok("an amount that is not a number is written as zero, a fraction of a cent rounded", qbAmount_("abc") === "0.00" && qbAmount_(undefined) === "0.00" && qbAmount_(12.6) === "0.13");
  ok("a date is written month, day and year", qbDate_("2026-01-31") === "01/31/2026" && qbDate_("2026-03-01T05:59:59.000Z") === "03/01/2026");
  ok("anything that isn't a date is written blank", qbDate_(null) === "" && qbDate_("1/2/2026") === "" && qbDate_(undefined) === "");
  ok("the Desktop file is named for the range", qbFilename_("desktop", "", "2026-01-01", "2026-01-31") === "odd-quickbooks-2026-01-01-to-2026-01-31.iif");
  ok("an Online file is named for its part and the range", qbFilename_("online", "sales", "2026-01-01", "2026-01-31") === "odd-qbo-sales-2026-01-01-to-2026-01-31.csv");
  ok("a bank file carries the account's name after the part, as letters, digits and dashes",
    qbFilename_("online", "payments", "2026-01-01", "2026-01-31", "Business Checking (QB)!") === "odd-qbo-payments-business-checking-qb-2026-01-01-to-2026-01-31.csv");
  ok("a name with no letters or digits becomes account, a long one is cut to 40 characters",
    qbFilename_("online", "payments", "2026-01-01", "2026-01-31", "***") === "odd-qbo-payments-account-2026-01-01-to-2026-01-31.csv"
    && qbFilename_("online", "x".repeat(60), "2026-01-01", "2026-01-31") === "odd-qbo-" + "x".repeat(40) + "-2026-01-01-to-2026-01-31.csv");
  ok("a missing range reads start and end, a time is cut to its day",
    qbFilename_("desktop", "", null, "bad") === "odd-quickbooks-start-to-end.iif"
    && qbFilename_("desktop", "", "2026-01-01T06:00:00Z", "2026-01-31") === "odd-quickbooks-2026-01-01-to-2026-01-31.iif");

  // ---- QuickBooks Online: sales ------------------------------------------------------------------------------------
  ok("an unknown part is refused", /Unknown QuickBooks part: refunds/.test((throws(() => buildQboCsv(data(), "refunds")) || {}).message || ""));
  const rs = buildQboCsv(data(), "sales");
  ok("as receipts, the main file is the sales file and the Net 30 orders go in a second, invoice file",
    rs.filename === "odd-qbo-sales-2026-01-01-to-2026-01-31.csv" && rs.files.length === 2 && rs.files[0].filename === rs.filename && rs.files[0].csv === rs.csv
    && rs.files[1].filename === "odd-qbo-invoices-2026-01-01-to-2026-01-31.csv");
  ok("a sales receipt file has the receipt's columns",
    lines(rs.csv)[0] === "SalesReceiptNo,Customer,SalesReceiptDate,DepositTo,Memo,Item(Product/Service),ItemDescription,ItemQuantity,ItemRate,ItemAmount,Taxable");
  ok("an invoice file has the invoice import's columns",
    lines(rs.files[1].csv)[0] === "InvoiceNo,Customer,InvoiceDate,DueDate,Terms,Memo,Item(Product/Service),ItemDescription,ItemQuantity,ItemRate,ItemAmount,Taxable");
  ok("every line ends in CR LF, the last one too", rs.csv.endsWith("\r\n") && !/[^\r]\n/.test(rs.csv) && !/[^\r]\n/.test(rs.files[1].csv));
  const rA = asObjects(rs.csv).filter(r => r.SalesReceiptNo === "ODD-1001");
  ok("an order is one row per line, then shipping, rush, discount and sales tax as lines of their own",
    JSON.stringify(rA.map(r => r["Item(Product/Service)"])) === '["Sales","Shipping","Rush","Discount","Sales tax"]');
  ok("each row repeats the receipt's number, customer, date, deposit-to account and memo",
    rA.every(r => r.Customer === "Pat Example" && r.SalesReceiptDate === "01/05/2026" && r.DepositTo === "Undeposited Funds" && r.Memo === "PO PO-77 - Example Club"));
  ok("a goods line has its name, quantity, rate, amount and taxable flag",
    rA[0].ItemDescription === "Polo (navy)" && rA[0].ItemQuantity === "2" && rA[0].ItemRate === "25.00" && rA[0].ItemAmount === "50.00" && rA[0].Taxable === "Y");
  ok("shipping, rush and sales tax name their QuickBooks account and are not taxable",
    rA[1].ItemDescription === "Shipping (Shipping Income)" && rA[1].ItemAmount === "8.00" && rA[1].Taxable === "N"
    && rA[2].ItemDescription === "Rush (Sales)" && rA[2].ItemAmount === "10.00"
    && rA[4].ItemDescription === "Sales tax (Sales Tax Payable)" && rA[4].ItemAmount === "4.50" && rA[4].Taxable === "N");
  ok("the discount is a negative line whatever sign it arrives with", rA[3].ItemDescription === "Discount (Discounts Given)" && rA[3].ItemRate === "-5.00" && rA[3].ItemAmount === "-5.00"
    && asObjects(buildQboCsv(data(null, { sales: [Object.assign({}, SALE_A, { discountCents: 500 })] }), "sales").csv)[3].ItemAmount === "-5.00");
  ok("a negative amount cell is written bare, with no apostrophe or quotes", lines(rs.csv).some(l => l.endsWith(",1,-5.00,-5.00,N")));
  const rC = asObjects(rs.csv).filter(r => r.SalesReceiptNo === "ODD-1003");
  ok("a gift card sold is its own Gift card line naming the liability account, and a nameless order is for Customer",
    rC.length === 1 && rC[0]["Item(Product/Service)"] === "Gift card" && rC[0].ItemDescription === "Gift card sold (Gift Cards Outstanding)"
    && rC[0].ItemAmount === "50.00" && rC[0].Customer === "Customer" && rC[0].Memo === "");
  ok("an order with nothing on it adds no row", !asObjects(rs.csv).some(r => r.SalesReceiptNo === "ODD-1004"));
  const iB = asObjects(rs.files[1].csv);
  ok("the Net 30 order is on the invoice file only, with its due date and Net 30 terms",
    !asObjects(rs.csv).some(r => r.SalesReceiptNo === "ODD-1002") && iB.length === 1 && iB[0].InvoiceNo === "ODD-1002"
    && iB[0].DueDate === "02/04/2026" && iB[0].Terms === "Net 30" && iB[0].Customer === "Example School District" && iB[0].Taxable === "N");
  ok("text a spreadsheet would read as a formula gets a leading apostrophe and is quoted around its quotes",
    lines(rs.files[1].csv)[1].includes(`"'=HYPERLINK(""x"")"`) && iB[0].ItemDescription === `'=HYPERLINK("x")`);
  const guard = (name) => asObjects(buildQboCsv(data(null, { sales: [Object.assign({}, SALE_A, { customer: name })] }), "sales").csv)[0].Customer;
  ok("a leading plus, minus, at sign or full-width equals is guarded too",
    guard("+Pat") === "'+Pat" && guard("-Pat") === "'-Pat" && guard("@Pat") === "'@Pat" && guard("＝Pat") === "'＝Pat" && guard("Pat-Example") === "Pat-Example");
  const commaCsv = buildQboCsv(data(null, { sales: [Object.assign({}, SALE_A, { customer: "Example Club, Inc." })] }), "sales").csv;
  ok("a cell with a comma is quoted, a plain one isn't", lines(commaCsv)[1].startsWith('ODD-1001,"Example Club, Inc.",01/05/2026,Undeposited Funds,'));
  const tabCsv = buildQboCsv(data(null, { sales: [Object.assign({}, SALE_A, { customer: "Pat\tExample\r\nJr" })] }), "sales").csv;
  ok("tabs and line breaks in a name become one space", asObjects(tabCsv)[0].Customer === "Pat Example Jr" && lines(tabCsv).length === 7);

  const inv = buildQboCsv(data({ salesAs: "invoices" }), "sales");
  const invRows = asObjects(inv.csv);
  ok("as invoices, every order is in the one sales file under the invoice columns",
    inv.files.length === 1 && inv.files[0].filename === "odd-qbo-sales-2026-01-01-to-2026-01-31.csv" && lines(inv.csv)[0].startsWith("InvoiceNo,Customer,InvoiceDate,DueDate,Terms,")
    && JSON.stringify([...new Set(invRows.map(r => r.InvoiceNo))]) === '["ODD-1001","ODD-1002","ODD-1003"]');
  ok("an invoice not on terms is due on receipt, on its own date",
    invRows.filter(r => r.InvoiceNo === "ODD-1001").every(r => r.Terms === "Due on receipt" && r.DueDate === "01/05/2026"));
  ok("a Net 30 invoice with no due date leaves the due date blank",
    asObjects(buildQboCsv(data({ salesAs: "invoices" }, { sales: [Object.assign({}, SALE_B, { dueDate: null })] }), "sales").csv)[0].DueDate === "");
  const allTermed = buildQboCsv(data(null, { sales: [SALE_B] }), "sales");
  ok("when every order is Net 30, only the invoice file is sent", allTermed.files.length === 1 && allTermed.files[0].filename.startsWith("odd-qbo-invoices-")
    && lines(allTermed.csv).length === 2 && allTermed.csv.startsWith("SalesReceiptNo,"));
  const none = buildQboCsv(data(null, { sales: [] }), "sales");
  ok("with no sales there is no file to send", none.files.length === 0);
  ok("data with no sales list at all is no sales", buildQboCsv({ dateFrom: "2026-01-01", dateTo: "2026-01-31" }, "sales").files.length === 0
    && buildQboCsv(null, "payments").files.length === 0);

  const shopMode = asObjects(buildQboCsv(data({ customerName: "shop" }), "sales").csv);
  ok("with the shop as the customer, the shop is the customer and the person goes in the memo",
    shopMode[0].Customer === "Example Club" && shopMode[0].Memo === "PO PO-77 - Pat Example");
  ok("with the shop as the customer, an order with no shop falls back to the person",
    asObjects(buildQboCsv(data({ customerName: "shop", salesAs: "invoices" }), "sales").csv).find(r => r.InvoiceNo === "ODD-1002").Customer === "Example School District");
  const mapped = { sales: "Embroidery Sales", undepositedFunds: "Payments to Deposit", shippingIncome: "Freight Income", rushIncome: "Rush Fees",
    discounts: "Promotions", salesTaxPayable: "State Tax", giftCardLiability: "Gift Card Liability", ar: "Receivables", cardFees: "Card Fees",
    postage: "Shipping Expense", ownerEquity: "Owner Draw" };
  const mRows = asObjects(buildQboCsv(data({ accounts: Object.assign({}, mapped, { shippingIncome: "  " }) }), "sales").csv);
  ok("mapped names go in the item, deposit-to and descriptions",
    mRows[0]["Item(Product/Service)"] === "Embroidery Sales" && mRows[0].DepositTo === "Payments to Deposit"
    && mRows[2].ItemDescription === "Rush (Rush Fees)" && mRows[3].ItemDescription === "Discount (Promotions)" && mRows[4].ItemDescription === "Sales tax (State Tax)"
    && mRows.find(r => r["Item(Product/Service)"] === "Gift card").ItemDescription === "Gift card sold (Gift Card Liability)");
  ok("a blank mapping keeps the default name", mRows[1].ItemDescription === "Shipping (Shipping Income)");

  // ---- QuickBooks Online: payments, expenses, deposits -------------------------------------------------------------
  const pay = buildQboCsv(data(), "payments");
  ok("payments come as one bank file per account, by name, with no sales file",
    pay.filename === undefined && JSON.stringify(pay.files.map(f => f.account)) === '["Cash drawer","Checking (QB)","Stripe","Undeposited Funds","Venmo"]'
    && pay.files[1].filename === "odd-qbo-payments-checking-qb-2026-01-01-to-2026-01-31.csv");
  ok("a bank file has the three columns Date, Description, Amount", pay.files.every(f => lines(f.csv)[0] === "Date,Description,Amount" && f.csv.endsWith("\r\n")));
  const stripe = asObjects(pay.files.find(f => f.account === "Stripe").csv);
  ok("a card payment and its fee are two rows, the fee negative",
    stripe[0].Date === "01/06/2026" && stripe[0].Description === "Payment - order ODD-1001 - Pat Example - card - ch_1" && stripe[0].Amount === "70.00"
    && stripe[1].Description === "Card fee - order ODD-1001 - ch_1" && stripe[1].Amount === "-2.33");
  ok("a refund is a negative Refund row, after the earlier payment", stripe[2].Description === "Refund - order ODD-1001 - Pat Example - card - re_1" && stripe[2].Amount === "-10.00" && stripe.length === 3);
  ok("a payment of nothing is left out", !stripe.some(r => r.Date === "01/11/2026"));
  ok("a gift card spent is in no bank file", !pay.files.some(f => f.csv.includes("gift card")));
  const chk = asObjects(pay.files.find(f => f.account === "Checking (QB)").csv);
  ok("rows within a file are in date order, using the mapped bank name",
    JSON.stringify(chk.map(r => r.Date)) === '["01/08/2026","01/20/2026"]' && chk[1].Description === "Payment - order ODD-1002 - Example School District - check - Check 501");
  ok("a payment with no account goes to the Undeposited Funds file", asObjects(pay.files.find(f => f.account === "Undeposited Funds").csv)[0].Description === "Payment - order ODD-1003 - Customer - cash");
  ok("a payment on an order not in the export names its own customer",
    asObjects(pay.files.find(f => f.account === "Venmo").csv)[0].Description === "Payment - order ODD-0999 - Example Parent - venmo");
  const unknownAcct = buildQboCsv(data(null, { payments: [{ id: 1, orderId: "ODD-0998", date: "2026-01-02", accountId: 9, amountCents: 100, shop: "Example Club" }] }), "payments");
  ok("an account the app doesn't list is named by its number; a payment with no customer names its shop",
    unknownAcct.files[0].account === "Account 9" && asObjects(unknownAcct.files[0].csv)[0].Description === "Payment - order ODD-0998 - Example Club");
  ok("a long description is cut to 200 characters",
    asObjects(buildQboCsv(data(null, { payments: [{ id: 1, orderId: "ODD-0998", date: "2026-01-02", accountId: 1, amountCents: 100, reference: "R".repeat(300) }] }), "payments").files[0].csv)[0].Description.length === 200);

  const exp = buildQboCsv(data(), "expenses");
  ok("expenses come one file per account, paid personally and no account as files of their own",
    JSON.stringify(exp.files.map(f => f.account)) === '["Business Card","Checking (QB)","No account","Paid personally"]'
    && exp.files[0].filename === "odd-qbo-expenses-business-card-2026-01-01-to-2026-01-31.csv");
  const eChk = asObjects(exp.files.find(f => f.account === "Checking (QB)").csv);
  ok("an expense is money out, described by payee, mapped expense account and memo",
    eChk.some(r => r.Date === "01/12/2026" && r.Description === "Example Blanks Co - Cost of Goods Sold:Blanks - Polos" && r.Amount === "-120.00")
    && JSON.stringify(eChk.map(r => r.Date)) === '["01/07/2026","01/12/2026","01/13/2026"]');
  ok("postage is money out, naming the order, its memo and the postage account",
    eChk.some(r => r.Date === "01/07/2026" && r.Description === "Postage - order ODD-1001 - USPS - Postage and Delivery" && r.Amount === "-8.45"));
  ok("a vendor refund is money in, named by the category when nothing is mapped",
    eChk.some(r => r.Description === "Example Supply - Supplies" && r.Amount === "20.00"));
  ok("an expense of nothing is left out", !eChk.some(r => r.Description.startsWith("Example Nothing")));
  ok("paid personally, with no payee and no category, reads Expense and Uncategorized Expense",
    asObjects(exp.files.find(f => f.account === "Paid personally").csv)[0].Description === "Expense - Uncategorized Expense");
  const noAcct = asObjects(exp.files.find(f => f.account === "No account").csv);
  ok("an expense or postage with no account goes to No account, a formula-looking payee guarded, its amount bare",
    noAcct.some(r => r.Description === "'=SUM(A1) - Supplies" && r.Amount === "-4.00") && noAcct.some(r => r.Description === "Postage - Postage and Delivery" && r.Amount === "-3.00")
    && lines(exp.files.find(f => f.account === "No account").csv).some(l => l.endsWith(",-4.00")));
  const card = asObjects(exp.files.find(f => f.account === "Business Card").csv);
  ok("a card charge and a card refund are out and in on the card's file", card.length === 2 && card[0].Amount === "-30.00" && card[1].Amount === "10.00");
  ok("a category named only in the category list gives its name",
    asObjects(buildQboCsv(data(null, { expenses: [{ id: 1, date: "2026-01-02", payee: "Example Vendor", categoryId: 8, accountId: 1, amountCents: 100 }], postage: [] }), "expenses").files[0].csv)[0].Description === "Example Vendor - Supplies");

  const dep = buildQboCsv(data(), "deposits");
  ok("deposits come one file per bank account, a deposit of nothing left out",
    JSON.stringify(dep.files.map(f => f.account)) === '["Checking (QB)","No account"]' && asObjects(dep.files[0].csv).length === 2);
  const dRows = asObjects(dep.files[0].csv);
  ok("a deposit names its fees with the fee account, how many payments and its note",
    dRows[0].Description === "Deposit - fees 2.33 (Merchant Fees) - 1 payment - Stripe payout" && dRows[0].Amount === "67.67" && dRows[0].Date === "01/08/2026");
  ok("more than one payment is plural and a memo is read when there is no note", dRows[1].Description === "Deposit - fees 0.50 (Merchant Fees) - 2 payments - Venmo cash-out");
  ok("a deposit with only a fee is a zero row and left out; one with no account is in No account",
    !dRows.some(r => r.Date === "01/11/2026") && asObjects(dep.files[1].csv)[0].Description === "Deposit" && asObjects(dep.files[1].csv)[0].Amount === "1.00");
  ok("a mapped fee account is named in the deposit",
    asObjects(buildQboCsv(data({ accounts: mapped }), "deposits").files[0].csv)[0].Description === "Deposit - fees 2.33 (Card Fees) - 1 payment - Stripe payout");

  // ---- QuickBooks Desktop: the file --------------------------------------------------------------------------------
  const full = buildIif(data());
  const all = parseIif(full.iif);
  ok("the Desktop file is named for the range", full.filename === "odd-quickbooks-2026-01-01-to-2026-01-31.iif");
  ok("the file starts with the TRNS, SPL and ENDTRNS header blocks",
    full.iif.startsWith("!TRNS\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM\tMEMO\tCLEAR\tDUEDATE\tTERMS\r\n!SPL\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM\tMEMO\tCLEAR\tQNTY\tPRICE\r\n!ENDTRNS\r\n"));
  ok("every line ends in CR LF and there is no bare line feed", full.iif.endsWith("\r\n") && !/[^\r]\n/.test(full.iif));
  ok("every transaction ends with ENDTRNS", full.iif.split("\r\n").filter(l => l.startsWith("TRNS\t")).length === full.iif.split("\r\n").filter(l => l === "ENDTRNS").length);
  ok("every transaction in the whole file sums to exactly zero", all.length > 15 && all.every(t => sumCents(t) === 0));
  ok("the file passes the balance check", iifBalanced(full.iif).ok === true && iifBalanced(full.iif).bad.length === 0);
  ok("every row is marked not cleared", all.every(t => t.trns.CLEAR === "N" && t.spl.every(s => s.CLEAR === "N")));

  // sales
  const cA = one(all, "ODD-1001");
  ok("a receipt order is a CASH SALE debiting Undeposited Funds with the order's total",
    cA && cA.trns.TRNSTYPE === "CASH SALE" && cA.trns.ACCNT === "Undeposited Funds" && cA.trns.AMOUNT === "67.50" && cA.trns.DATE === "01/05/2026"
    && cA.trns.NAME === "Pat Example" && cA.trns.MEMO === "Order ODD-1001 - PO PO-77" && cA.trns.DUEDATE === "" && cA.trns.TERMS === "");
  ok("a goods line credits Sales, quantity negative and the rate as price, its name as memo",
    cA.spl[0].ACCNT === "Sales" && cA.spl[0].AMOUNT === "-50.00" && cA.spl[0].QNTY === "-2" && cA.spl[0].PRICE === "25.00" && cA.spl[0].MEMO === "Polo (navy)");
  ok("shipping, rush and tax are credits, the discount a debit, a zero gift card line left out",
    JSON.stringify(cA.spl.slice(1).map(s => [s.ACCNT, s.AMOUNT, s.MEMO])) === '[["Shipping Income","-8.00","Shipping"],["Sales","-10.00","Rush"],["Discounts Given","5.00","Discount"],["Sales Tax Payable","-4.50","Sales tax"]]');
  const iBx = one(all, "ODD-1002");
  ok("a Net 30 order is always an INVOICE debiting Accounts Receivable, with its due date and terms",
    iBx && iBx.trns.TRNSTYPE === "INVOICE" && iBx.trns.ACCNT === "Accounts Receivable" && iBx.trns.DUEDATE === "02/04/2026" && iBx.trns.TERMS === "Net 30" && iBx.trns.AMOUNT === "10.00");
  ok("a name or memo keeps its text but a double quote becomes an apostrophe", iBx.spl[0].MEMO === "=HYPERLINK('x')");
  const gC = one(all, "ODD-1003");
  ok("a gift card sold credits Gift Cards Outstanding, never Sales",
    gC && gC.trns.TRNSTYPE === "CASH SALE" && gC.trns.NAME === "Customer" && gC.spl.length === 1 && gC.spl[0].ACCNT === "Gift Cards Outstanding" && gC.spl[0].AMOUNT === "-50.00" && gC.spl[0].MEMO === "Gift card sold");
  ok("an order with nothing on it posts nothing", byDoc(all, "ODD-1004").length === 0);
  const invAll = parseIif(buildIif(data({ salesAs: "invoices" }), ["sales"]).iif);
  ok("as invoices, every order is an INVOICE due on receipt unless on terms",
    invAll.length === 3 && invAll.every(t => t.trns.TRNSTYPE === "INVOICE" && t.trns.ACCNT === "Accounts Receivable")
    && one(invAll, "ODD-1001").trns.TERMS === "Due on receipt" && one(invAll, "ODD-1001").trns.DUEDATE === "");
  const odd = parseIif(buildIif(data({ customerName: "shop" }, { sales: [Object.assign({}, SALE_A, { orderId: "ODD-2026-000123456", shop: "Example\tBooster\r\nClub \"East\"",
    lines: [{ name: "Patch", qty: 0, rateCents: 0, amountCents: 700 }, { name: "Free sample", qty: 1, rateCents: 0, amountCents: 0 }] })] }), ["sales"]).iif);
  ok("a long order number keeps its last 11 characters as the number, the full one in the memo",
    odd.length === 1 && odd[0].trns.DOCNUM === "6-000123456" && odd[0].trns.MEMO.startsWith("Order ODD-2026-000123456"));
  ok("tabs and line breaks in a name become spaces and a double quote an apostrophe, so the row isn't split",
    odd[0].trns.NAME === "Example Booster Club 'East'" && odd[0].spl.every(s => s.NAME === "Example Booster Club 'East'"));
  ok("a line with no quantity leaves QNTY blank, a line of nothing is left out", odd[0].spl[0].QNTY === "" && odd[0].spl[0].AMOUNT === "-7.00" && !odd[0].spl.some(s => s.MEMO === "Free sample"));
  ok("an order with no PO has just the order in its memo", parseIif(buildIif(data(null, { sales: [SALE_C] }), ["sales"]).iif)[0].trns.MEMO === "Order ODD-1003");

  // payments
  const fee = one(all, "FEE11");
  ok("a Stripe fee moves from Undeposited Funds to Merchant Fees as a GENERAL JOURNAL",
    fee && fee.trns.TRNSTYPE === "GENERAL JOURNAL" && fee.trns.ACCNT === "Merchant Fees" && fee.trns.AMOUNT === "2.33" && fee.spl[0].ACCNT === "Undeposited Funds" && fee.spl[0].AMOUNT === "-2.33"
    && fee.trns.MEMO === "Card fee - order ODD-1001 - ch_1");
  ok("a card payment on a cash sale posts nothing more than its fee", byDoc(all, "ch_1").length === 0);
  const pB = one(all, "Check501");
  ok("a check on a Net 30 order is a PAYMENT into the bank it was recorded in, from Accounts Receivable",
    pB && pB.trns.TRNSTYPE === "PAYMENT" && pB.trns.ACCNT === "Checking (QB)" && pB.trns.AMOUNT === "10.00" && pB.trns.NAME === "Example School District"
    && pB.spl[0].ACCNT === "Accounts Receivable" && pB.spl[0].AMOUNT === "-10.00" && pB.trns.MEMO === "Payment - order ODD-1002 - check - Check 501");
  const gift = one(all, "PAY13");
  ok("a gift card spent on a cash sale moves Gift Cards Outstanding to Undeposited Funds",
    gift && gift.trns.TRNSTYPE === "GENERAL JOURNAL" && gift.trns.ACCNT === "Gift Cards Outstanding" && gift.trns.AMOUNT === "5.00"
    && gift.spl[0].ACCNT === "Undeposited Funds" && gift.spl[0].AMOUNT === "-5.00" && gift.trns.MEMO === "Gift card - order ODD-1001 - gift card");
  const refund = one(all, "re_1");
  ok("a card refund takes the money out of Undeposited Funds against Sales",
    refund && refund.trns.TRNSTYPE === "GENERAL JOURNAL" && refund.trns.ACCNT === "Undeposited Funds" && refund.trns.AMOUNT === "-10.00"
    && refund.spl[0].ACCNT === "Sales" && refund.spl[0].AMOUNT === "10.00" && refund.trns.MEMO.startsWith("Refund - "));
  const pV = one(all, "PAY15");
  ok("a payment on a Net 30 order sold before the range still clears Accounts Receivable, for its own customer",
    pV && pV.trns.TRNSTYPE === "PAYMENT" && pV.trns.ACCNT === "Undeposited Funds" && pV.trns.NAME === "Example Parent" && pV.spl[0].ACCNT === "Accounts Receivable");
  ok("a Venmo or cash fee waits for its cash-out deposit", byDoc(all, "FEE15").length === 0 && byDoc(all, "FEE19").length === 0);
  ok("a cash payment on a cash sale with no account posts nothing", byDoc(all, "PAY16").length === 0 && byDoc(all, "PAY19").length === 0);
  const direct = one(all, "PAY17");
  ok("a check on a cash sale recorded straight into the bank is a DEPOSIT out of Undeposited Funds",
    direct && direct.trns.TRNSTYPE === "DEPOSIT" && direct.trns.ACCNT === "Checking (QB)" && direct.trns.AMOUNT === "3.00" && direct.trns.NAME === ""
    && direct.spl[0].ACCNT === "Undeposited Funds" && direct.spl[0].AMOUNT === "-3.00" && direct.spl[0].NAME === "Pat Example");
  const gRef = one(all, "PAY18");
  ok("a gift card refund puts the money back on the card against Sales",
    gRef && gRef.trns.ACCNT === "Gift Cards Outstanding" && gRef.trns.AMOUNT === "-2.00" && gRef.spl[0].ACCNT === "Sales" && gRef.spl[0].AMOUNT === "2.00");
  ok("a payment of nothing posts nothing", byDoc(all, "PAY20").length === 0);
  const invPay = parseIif(buildIif(data({ salesAs: "invoices" }), ["payments"]).iif);
  ok("with sales as invoices, a card payment is a PAYMENT into Undeposited Funds and a gift card clears Accounts Receivable",
    one(invPay, "ch_1").trns.TRNSTYPE === "PAYMENT" && one(invPay, "ch_1").trns.ACCNT === "Undeposited Funds" && one(invPay, "PAY13").spl[0].ACCNT === "Accounts Receivable"
    && one(invPay, "PAY17").trns.TRNSTYPE === "PAYMENT" && one(invPay, "PAY17").trns.ACCNT === "Checking (QB)");
  const outside = parseIif(buildIif(data({ salesAs: "invoices", customerName: "shop" }, { sales: [], payments: [{ id: 51, orderId: "ODD-0990", date: "2026-01-03", accountId: 2, amountCents: 900, customer: "Pat Example", shop: "Example Club" }] }), ["payments"]).iif);
  ok("an order not in the export follows the settings, and with the shop as the customer names its shop",
    outside.length === 1 && outside[0].trns.TRNSTYPE === "PAYMENT" && outside[0].trns.NAME === "Example Club");
  const outsideCash = parseIif(buildIif(data(null, { sales: [], payments: [{ id: 52, orderId: "ODD-0990", date: "2026-01-03", accountId: 2, amountCents: 900 }] }), ["payments"]).iif);
  ok("an order not in the export and not on terms is a cash sale, so its card payment posts nothing", outsideCash.length === 0);
  const nameless = parseIif(buildIif(data(null, { sales: [], payments: [{ id: 53, orderId: "ODD-0990", date: "2026-01-03", accountId: 1, amountCents: 900 }] }), ["payments"]).iif);
  ok("a payment with no customer or shop is for Customer", nameless.length === 1 && nameless[0].spl[0].NAME === "Customer");
  const chkFee = parseIif(buildIif(data(null, { payments: [{ id: 54, orderId: "ODD-1002", date: "2026-01-03", accountId: 1, amountCents: 900, feeCents: 30 }] }), ["payments"]).iif);
  ok("a fee on money paid straight into the bank comes out of that bank", one(chkFee, "FEE54").spl[0].ACCNT === "Checking (QB)" && chkFee.every(t => sumCents(t) === 0));

  // expenses
  const x1 = one(all, "EXP21");
  ok("an expense from a bank account is a CHECK to the mapped expense account",
    x1 && x1.trns.TRNSTYPE === "CHECK" && x1.trns.ACCNT === "Checking (QB)" && x1.trns.NAME === "Example Blanks Co" && x1.trns.AMOUNT === "-120.00"
    && x1.spl[0].ACCNT === "Cost of Goods Sold:Blanks" && x1.spl[0].AMOUNT === "120.00" && x1.trns.MEMO === "Polos");
  const x2 = one(all, "EXP22");
  ok("a vendor refund into a bank account is a DEPOSIT back from the expense account",
    x2 && x2.trns.TRNSTYPE === "DEPOSIT" && x2.trns.AMOUNT === "20.00" && x2.spl[0].ACCNT === "Supplies" && x2.spl[0].AMOUNT === "-20.00");
  const x3 = one(all, "EXP23");
  ok("an expense paid personally is a GENERAL JOURNAL from Owner's Equity, from Vendor when there is no payee",
    x3 && x3.trns.TRNSTYPE === "GENERAL JOURNAL" && x3.trns.ACCNT === "Owner's Equity" && x3.trns.NAME === "Vendor" && x3.trns.AMOUNT === "-9.00"
    && x3.spl[0].ACCNT === "Uncategorized Expense" && x3.trns.MEMO === "Paid personally");
  ok("a card charge is CREDIT CARD and a card refund CCARD REFUND, on the card account",
    one(all, "EXP24").trns.TRNSTYPE === "CREDIT CARD" && one(all, "EXP24").trns.ACCNT === "Business Card" && one(all, "EXP24").trns.AMOUNT === "-30.00"
    && one(all, "EXP25").trns.TRNSTYPE === "CCARD REFUND" && one(all, "EXP25").trns.AMOUNT === "10.00");
  ok("an expense with no account is treated as paid personally", one(all, "EXP26").trns.TRNSTYPE === "GENERAL JOURNAL" && one(all, "EXP26").trns.ACCNT === "Owner's Equity"
    && one(all, "EXP26").trns.MEMO === "Paid personally" && one(all, "EXP26").trns.NAME === "=SUM(A1)");
  ok("an expense of nothing posts nothing", byDoc(all, "EXP27").length === 0);
  const l1 = one(all, "EXPL31");
  ok("postage is a CHECK from Postage to the postage account, naming the order",
    l1 && l1.trns.TRNSTYPE === "CHECK" && l1.trns.NAME === "Postage" && l1.spl[0].ACCNT === "Postage and Delivery" && l1.spl[0].AMOUNT === "8.45" && l1.trns.MEMO === "Postage - order ODD-1001 - USPS");
  ok("postage with no account comes from Owner's Equity", one(all, "EXPL32").trns.ACCNT === "Owner's Equity" && one(all, "EXPL32").trns.MEMO === "Postage");

  // deposits
  const d1 = one(all, "DEP41");
  ok("a deposit moves what was paid out plus the fees out of Undeposited Funds, the fees to Merchant Fees",
    d1 && d1.trns.TRNSTYPE === "DEPOSIT" && d1.trns.ACCNT === "Checking (QB)" && d1.trns.AMOUNT === "67.67" && d1.trns.MEMO === "Deposit - 1 payment - Stripe payout"
    && d1.spl[0].ACCNT === "Undeposited Funds" && d1.spl[0].AMOUNT === "-70.00" && d1.spl[1].ACCNT === "Merchant Fees" && d1.spl[1].AMOUNT === "2.33" && d1.spl[1].MEMO === "Card fees");
  ok("a deposit's memo is read when there is no note", one(all, "DEP42").trns.MEMO === "Deposit - 2 payments - Venmo cash-out");
  ok("a deposit with no fee has no fee line, and one with no account lands in Undeposited Funds",
    one(all, "DEP43").spl.length === 1 && one(all, "DEP43").trns.ACCNT === "Undeposited Funds" && one(all, "DEP43").trns.MEMO === "Deposit");
  ok("a deposit of nothing posts nothing, one of only fees still moves them", byDoc(all, "DEP44").length === 0
    && one(all, "DEP45").trns.AMOUNT === "0.00" && one(all, "DEP45").spl[1].AMOUNT === "1.00");

  // mapped names in the Desktop file
  const mAll = parseIif(buildIif(data({ accounts: mapped })).iif);
  ok("mapped names are used throughout the Desktop file",
    one(mAll, "ODD-1001").trns.ACCNT === "Payments to Deposit" && one(mAll, "ODD-1001").spl[0].ACCNT === "Embroidery Sales"
    && one(mAll, "ODD-1001").spl.map(s => s.ACCNT).join("|") === "Embroidery Sales|Freight Income|Rush Fees|Promotions|State Tax"
    && one(mAll, "ODD-1002").trns.ACCNT === "Receivables" && one(mAll, "ODD-1003").spl[0].ACCNT === "Gift Card Liability"
    && one(mAll, "FEE11").trns.ACCNT === "Card Fees" && one(mAll, "EXPL31").spl[0].ACCNT === "Shipping Expense" && one(mAll, "EXP23").trns.ACCNT === "Owner Draw");

  // parts chosen
  const types = (iif) => [...new Set(parseIif(iif).map(t => t.trns.TRNSTYPE))].sort().join("|");
  ok("only the parts asked for are in the file",
    types(buildIif(data(), ["sales"]).iif) === "CASH SALE|INVOICE" && types(buildIif(data(), ["deposits"]).iif) === "DEPOSIT"
    && types(buildIif(data(), ["expenses"]).iif) === "CCARD REFUND|CHECK|CREDIT CARD|DEPOSIT|GENERAL JOURNAL");
  const two = parseIif(buildIif(data(), ["payments", "sales"]).iif);
  ok("parts come in the usual order whatever order they're asked in", two[0].trns.DOCNUM === "ODD-1001" && two.some(t => t.trns.TRNSTYPE === "PAYMENT") && !two.some(t => /^(EXP|DEP)/.test(t.trns.DOCNUM)));
  ok("no parts, an empty list or anything not a list means every part",
    buildIif(data(), []).iif === full.iif && buildIif(data(), "sales").iif === full.iif);
  ok("unknown parts are dropped, leaving just the headers", buildIif(data(), ["bogus"]).iif.split("\r\n").filter(Boolean).length === 3);
  const empty = buildIif({});
  ok("a range with nothing in it is just the headers, named start to end", empty.filename === "odd-quickbooks-start-to-end.iif" && empty.iif.split("\r\n").filter(Boolean).length === 3);
  for (const combo of [{}, { salesAs: "invoices" }, { customerName: "shop" }, { salesAs: "invoices", customerName: "shop" }]) {
    const t = parseIif(buildIif(data(combo)).iif);
    ok("every transaction balances with sales as " + (combo.salesAs || "receipts") + " and the " + (combo.customerName || "customer") + " as the name",
      t.length > 15 && t.every(x => sumCents(x) === 0));
  }

  // ---- iifBalanced and the refusal ---------------------------------------------------------------------------------
  const H = "!TRNS\tTRNSTYPE\tAMOUNT\tDOCNUM\r\n!SPL\tTRNSTYPE\tAMOUNT\tDOCNUM\r\n!ENDTRNS\r\n";
  const crooked = iifBalanced(H + "TRNS\tCHECK\t-10.00\tA1\r\nSPL\tCHECK\t9.99\tA1\r\nENDTRNS\r\nTRNS\tCHECK\t-10.00\tA2\r\nSPL\tCHECK\t10.00\tA2\r\nENDTRNS\r\n");
  ok("the balance check finds a transaction off by a cent, by its number, and passes the next", crooked.ok === false && JSON.stringify(crooked.bad) === '["A1"]');
  ok("a transaction with no number is named by its line", JSON.stringify(iifBalanced(H + "TRNS\tCHECK\t-1.00\t\r\nENDTRNS\r\n").bad) === '["line 4"]');
  ok("a split line with no transaction is crooked", JSON.stringify(iifBalanced(H + "SPL\tCHECK\t1.00\tB1\r\n").bad) === '["line 4"]');
  ok("a transaction that never ends before the next one is crooked even when it sums to zero",
    JSON.stringify(iifBalanced(H + "TRNS\tCHECK\t-1.00\tC1\r\nSPL\tCHECK\t1.00\tC1\r\nTRNS\tCHECK\t-1.00\tC2\r\nSPL\tCHECK\t1.00\tC2\r\nENDTRNS\r\n").bad) === '["C1"]');
  ok("a transaction that never ends at the end of the file is crooked", JSON.stringify(iifBalanced(H + "TRNS\tCHECK\t0.00\tD1\r\n").bad) === '["D1"]');
  ok("an amount that isn't a plain decimal is crooked",
    iifBalanced(H + "TRNS\tCHECK\t1e2\tE1\r\nSPL\tCHECK\t-100.00\tE1\r\nENDTRNS\r\n").bad[0] === "E1"
    && iifBalanced(H + "TRNS\tCHECK\t1.001\tE2\r\nSPL\tCHECK\t-1.00\tE2\r\nENDTRNS\r\n").bad[0] === "E2");
  ok("a blank amount counts as zero", iifBalanced(H + "TRNS\tCHECK\t\tF1\r\nSPL\tCHECK\t\tF1\r\nENDTRNS\r\n").ok === true);
  ok("a transaction without the header that names its amount column is crooked",
    iifBalanced("TRNS\tCHECK\t0.00\tG1\r\nENDTRNS\r\n").ok === false
    && iifBalanced("!TRNS\tTRNSTYPE\tAMOUNT\tDOCNUM\r\n!SPL\tTRNSTYPE\tDOCNUM\r\nTRNS\tCHECK\t0.00\tG2\r\nSPL\tCHECK\tG2\r\nENDTRNS\r\n").bad[0] === "G2");
  ok("plain line feeds are read too, and nothing at all is balanced",
    iifBalanced(H.replace(/\r/g, "") + "TRNS\tCHECK\t-1.00\tH1\nSPL\tCHECK\t1.00\tH1\nENDTRNS\n").ok === true && iifBalanced(null).ok === true && iifBalanced("").bad.length === 0);
  // An amount too large to write as a plain decimal can't be read back, so the file can't be shown to balance.
  const err = throws(() => buildIif(data(null, { sales: [], payments: [], deposits: [], postage: [],
    expenses: [{ id: 99, date: "2026-01-02", payee: "Example Vendor", categoryId: 7, accountId: 1, amountCents: 1e24 }] }), ["expenses"]));
  ok("the builder refuses a file that doesn't balance, naming the transaction",
    !!err && err.message === "The QuickBooks file doesn't balance (EXP99). Nothing was exported.");
  ok("the same expense written normally is built", !throws(() => buildIif(data(null, { expenses: [{ id: 99, date: "2026-01-02", payee: "Example Vendor", categoryId: 7, accountId: 1, amountCents: 100 }] }), ["expenses"])));
})().catch(e => { console.log("crashed", e && e.stack); process.exitCode = 1; });
