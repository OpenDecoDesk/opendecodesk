process.env.TZ = "UTC";   // nothing here should read the machine's zone; pinned anyway
const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { ok } = require("./testlib/check");

// The phase 8 reports' quiet fallbacks in functions/_lib/db.js (real db.js on sql.js): what the sales report, profit
// per job, the gift card liability and the QuickBooks data answer when a value is missing, zero or blank, when a row
// names a shop / customer / product that isn't on file, when an order has no lines at all, when the database hands
// back no rows list (a database that answers oddly), and that a failure which is not "no such table / column" is never
// hidden. Rows the schema won't take (a blank account name, a missing amount) come from a database that rewrites what
// one statement answers.
// Invented data only (Example Club, Example School District, pat@example.com). The business is in America/Chicago;
// "today" is fixed; nothing reads the machine's date or zone.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/^import "[^"\n]+";\n/gm, "").replace(/export (async function|function|const)/g, "$1");
const NOW = Date.parse("2026-12-15T18:00:00.000Z");
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(NOW); }
  static now() { return NOW; }
}
globalThis.__FixedDate419 = FixedDate;
const L = new Function("const Date = globalThis.__FixedDate419;\n" + strip(read("functions/_lib/db.js")) +
  "\nreturn { getSalesReport, getOrderProfit, getProfitReport, getGiftCardLiability, getQuickBooksData, getQuickBooksSettings };")();

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };
process.on("unhandledRejection", (e) => { console.error(e); ok("nothing in the test was left to fail unseen", false); });
let finished = false;
process.on("exit", () => { if (!finished) { console.log("the test ran to its end: false"); process.exitCode = 1; } });

const migrations = fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort();
const fresh = async () => {
  const d = await createD1();
  d._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of migrations) d.execFile(read("migrations/" + f));
  // Rows are written straight to the tables, some naming a shop or customer that isn't on file.
  d._raw.exec(`PRAGMA foreign_keys = OFF;
    INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('club','club','Example Club','t','t');
    INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('school','school','Example School District','t','t');
    INSERT INTO global_settings (key, value) VALUES ('locale', '{"timeZone":"America/Chicago","country":"US"}');
    INSERT INTO customers (id, name, company, email, createdAt, updatedAt) VALUES (1, 'Pat Example', 'Example School District', 'pat@example.com', 't', 't');`);
  return d;
};
const q = (v) => v == null ? "NULL" : typeof v === "number" ? String(v) : "'" + String(v).replace(/'/g, "''") + "'";
const ins = (d1, table, row) => d1._raw.exec(`INSERT INTO ${table} (${Object.keys(row).join(", ")}) VALUES (${Object.values(row).map(q).join(", ")});`);
const T = "2026-11-10T18:00:00.000Z";
let itemSeq = 1000;
const order = (d1, id, o = {}, lines = []) => {
  ins(d1, "orders", Object.assign({ orderId: id, orgId: "club", customerName: "Walk-in Buyer", contact: "buyer@example.com", placedAt: T, shippedAt: T, taxMode: "inclusive" }, o));
  for (const l of lines) ins(d1, "order_items", Object.assign({ id: ++itemSeq, orderId: id, orgId: o.orgId || "club", productId: "tee", name: "Example line", type: "shirt",
    qty: 1, lineTotalCents: 0, taxCents: 0, manufacturedQty: l.qty == null ? 1 : l.qty }, l));
};
const product = (d1, p) => ins(d1, "products", Object.assign({ orgId: "club", type: "shirt", createdAt: "t", updatedAt: "t" }, p));
const setting = (d1, key, v) => d1._raw.exec(`INSERT OR REPLACE INTO global_settings (key, value) VALUES (${q(key)}, ${q(JSON.stringify(v))})`);
// A database that answers the statements matching a rule its own way: `error` fails them, `all` / `first` rewrite
// what they answer (the real answer in, any answer out). Every other statement as usual.
function tamper(db, rules) {
  const wrap = (stmt, r) => {
    const w = {
      bind: (...a) => { stmt = stmt.bind(...a); return w; },
      all: async () => { if (r.error) throw new Error(r.error); const res = await stmt.all(); return r.all ? r.all(res) : res; },
      first: async (c) => { if (r.error) throw new Error(r.error); const res = await stmt.first(c); return r.first ? r.first(res) : res; },
      run: async () => { if (r.error) throw new Error(r.error); return stmt.run(); },
    };
    return w;
  };
  return new Proxy(db, { get(t, k) {
    if (k === "prepare") return (sql) => { const r = rules.find(x => x.re.test(sql)); return r ? wrap(t.prepare(sql), r) : t.prepare(sql); };
    const v = t[k]; return typeof v === "function" ? v.bind(t) : v;
  } });
}
const noRows = () => ({ success: true });   // a database answer with no rows list at all
// The schema wants qty > 0: the lines of `ids` read back with no qty, as a line from an older or hand-edited database.
const noQty = (...ids) => ({ re: /SELECT \* FROM order_items WHERE orderId IN/, all: (r) => ({ ...r, results: r.results.map(x => ids.includes(x.orderId) ? { ...x, qty: null } : x) }) });
const ZERO = { blanksCents: 0, transfersCents: 0, decorationCents: 0, suppliesCents: 0, digitizingCents: 0, cardFeesCents: 0, postageCents: 0, laborCents: 0 };
const N_TRANSFER = "Transfer cost estimated for lines not yet made";
const N_MISSING = "Some lines have no blank cost to go on";

(async () => {
  // =============================================================================================================
  console.log("=== Sales report: names not on file, blank names, no lines, nothing qty ===");
  {
    const d1 = await fresh();
    d1._raw.exec("INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('blank','blank','','t','t');");
    product(d1, { orgId: "gone", productId: "ghost", name: "", decorationType: "dtf", fixedTransfersJson: "null" });
    order(d1, "S-1");                                                                                   // no lines at all
    order(d1, "S-2", { customerId: 99, customerName: "" }, [{ lineTotalCents: 500, name: "Example Cap", productId: "__custom__" }]);
    order(d1, "S-3", { orgId: "gone", customerId: 1 }, [{ productId: "ghost", name: "", lineTotalCents: 700 }]);
    order(d1, "S-4", { orgId: "blank", customerId: 1 }, [{ productId: "__custom__", name: "Example Patch", lineTotalCents: 300 }]);
    const R = { dateFrom: "2026-11-01", dateTo: "2026-11-30" };

    const byCust = await L.getSalesReport(tamper(d1, [noQty("S-2")]), { ...R, by: "customer" });
    ok("an order with no lines at all is in no row and not in the order count", byCust.totals.orders === 3 && !byCust.rows.some(r => r.orders > 2));
    const c99 = byCust.rows.find(r => r.key === "c:99");
    ok("a customer id with no record and no name typed on the order is \"Customer 99\"", !!c99 && c99.label === "Customer 99" && c99.customerId === 99);
    ok("a line with no qty counts no pieces but still its money", !!c99 && c99.qty === 0 && c99.grossCents === 500 && byCust.totals.qty === 2);

    const byShop = await L.getSalesReport(d1, { ...R, by: "shop" });
    const label = (rep, key) => (rep.rows.find(r => r.key === key) || {}).label;
    ok("a shop that isn't on file goes by its id", label(byShop, "s:gone") === "gone");
    ok("a shop whose name is blank goes by its id", label(byShop, "s:blank") === "blank");
    ok("a shop on file goes by its name", label(byShop, "s:club") === "Example Club");

    const byProd = await L.getSalesReport(d1, { ...R, by: "product" });
    const ghost = byProd.rows.find(r => r.key.startsWith("p:gone"));
    ok("a product with no name on a line with no name goes by its product id", !!ghost && ghost.label === "ghost" && ghost.grossCents === 700);
    ok("…and its shop, not on file, by the shop id", !!ghost && ghost.shop === "gone");

    const byDec = await L.getSalesReport(d1, { ...R, by: "decoration" });
    ok("a product whose fixed transfers were saved as null still reads (its own decoration type counts)",
      label(byDec, "d:dtf") === "DTF transfer" && byDec.rows.find(r => r.key === "d:dtf").grossCents === 700);

    // A database that hands back no rows list.
    const noOrders = await L.getSalesReport(tamper(d1, [{ re: /AS saleAt/, all: noRows }]), R);
    ok("no rows list for the orders: an empty report", same(noOrders.rows, []) && noOrders.totals.orders === 0);
    const noItems = await L.getSalesReport(tamper(d1, [{ re: /FROM order_items WHERE orderId IN/, all: noRows }]), R);
    ok("no rows list for the lines: no order has a live line, so no rows", same(noItems.rows, []) && noItems.totals.orders === 0);
    const noOrgs = await L.getSalesReport(tamper(d1, [{ re: /SELECT orgId, name FROM orgs/, all: noRows }]), { ...R, by: "shop" });
    ok("no rows list for the shops: every shop goes by its id", label(noOrgs, "s:club") === "club" && label(noOrgs, "s:gone") === "gone");

    // Failures that aren't "no such table / column" are not hidden.
    const e1 = await rejects(L.getSalesReport(tamper(d1, [{ re: /FROM customers WHERE id IN/, error: "database is locked" }]), R));
    ok("a customers read that fails for another reason fails the report", !!e1 && /database is locked/.test(e1.message));
    const noCust = await L.getSalesReport(tamper(d1, [{ re: /FROM customers WHERE id IN/, error: "no such table: customers" }]), R);
    ok("…while no customers table at all means no names (the name typed on the order, else Customer <id>)",
      label(noCust, "c:1") === "Walk-in Buyer" && label(noCust, "c:99") === "Customer 99");
    const e2 = await rejects(L.getSalesReport(tamper(d1, [{ re: /product_designs/, error: "database is locked" }]), { ...R, by: "product" }));
    ok("a products read that fails for another reason fails the report", !!e2 && /database is locked/.test(e2.message));
    const noDesigns = await L.getSalesReport(tamper(d1, [{ re: /product_designs/, error: "no such table: product_designs" }]), { ...R, by: "product" });
    ok("…while no product designs table falls back to the products alone", !!noDesigns.rows.find(r => r.key.startsWith("p:gone")));
  }

  // =============================================================================================================
  console.log("\n=== Profit per job: qty 0, zero costs, transfers, no lines, the margin sort ===");
  {
    const d1 = await fresh();
    product(d1, { productId: "sup", name: "Example Supplies Tee", suppliesCostCents: 100 });
    product(d1, { productId: "stk", name: "Example Stock Tee", suppliesCostCents: 0 });
    product(d1, { productId: "trn", name: "Example Transfer Tee", suppliesCostCents: 0 });
    ins(d1, "ready_to_ship", { orgId: "club", productId: "stk", size: "M", quantity: 3, updatedAt: "t", avgCostCents: 0 });
    ins(d1, "transfers", { id: 5, name: "Example Free Transfer", purchasePriceCents: 0, createdAt: "t", updatedAt: "t" });
    ins(d1, "transfers", { id: 6, name: "Example Crest Transfer", purchasePriceCents: 250, createdAt: "t", updatedAt: "t" });
    order(d1, "P-1", {}, [{ productId: "sup", qty: 1, manufacturedQty: 0, lineTotalCents: 1000 }]);
    order(d1, "P-2", {}, [{ productId: "stk", size: "M", fromStock: 1, qty: 1, manufacturedQty: 0, lineTotalCents: 2000 }]);
    order(d1, "P-3", {}, [{ productId: "trn", qty: 2, manufacturedQty: 0, lineTotalCents: 3000,
      configJson: JSON.stringify({ locations: [{ location: "Front", kind: "transfer", transferId: 5 }, { location: "Back", kind: "transfer", transferId: 6 }] }) }]);
    ins(d1, "transfer_movements", { transferId: 5, qtyDelta: -1, unitCostCents: 0, kind: "consume", orderId: "P-3", itemId: null, occurredAt: T, createdAt: T });
    order(d1, "P-4", {}, [{ productId: "__custom__", name: "Example Custom", customerOwned: 1, lineTotalCents: 400 }]);
    ins(d1, "inventory_movements", { blankId: 1, color: "Navy", size: "L", qtyDelta: -1, unitCostCents: 0, kind: "consume", orderId: "P-4", occurredAt: T, createdAt: T });
    order(d1, "P-7", { shippedAt: "2026-11-09T18:00:00.000Z" }, [{ productId: "__custom__", name: "Example Custom", customerOwned: 1, lineTotalCents: 900 }]);
    ins(d1, "inventory_movements", { blankId: 1, color: "Navy", size: "L", qtyDelta: -1, unitCostCents: 150, kind: "consume", orderId: "P-7", occurredAt: T, createdAt: T });
    order(d1, "P-5", { shippedAt: "2026-11-11T18:00:00.000Z" });
    order(d1, "P-6", { shippedAt: "2026-11-12T18:00:00.000Z" });

    const p1 = await L.getOrderProfit(tamper(d1, [noQty("P-1")]), "P-1");
    ok("a line with no qty is costed as one piece (supplies for one)", p1.costs.suppliesCents === 100 && p1.revenueCents === 1000);
    ok("…and, not made and with no blank to go on, says so", p1.notes.includes(N_MISSING));
    const p2 = await L.getOrderProfit(d1, "P-2");
    ok("a line from stock whose stock has no average cost: no blank cost, and the note says there is none to go on",
      p2.costs.blanksCents === 0 && p2.notes.includes(N_MISSING) && !p2.estimated);
    const p3 = await L.getOrderProfit(d1, "P-3");
    ok("a transfer that costs nothing adds nothing to the estimate; the other's cost counts for every piece (2 × 250)",
      p3.costs.transfersCents === 500 && p3.notes.includes(N_TRANSFER) && p3.estimated);
    const p4 = await L.getOrderProfit(d1, "P-4");
    ok("blanks consumed at no cost: blanks cost 0", p4.costs.blanksCents === 0 && p4.profitCents === 400);
    const p5 = await L.getOrderProfit(d1, "P-5");
    ok("an order with no lines: no revenue, no costs, no margin", p5.revenueCents === 0 && p5.costCents === 0 && p5.marginPct === null && same(p5.costs, ZERO));

    const rep = await L.getProfitReport(d1, { dateFrom: "2026-11-01", dateTo: "2026-11-30", sort: "margin" });
    ok("sorted by margin, the orders with no margin come last, newest first between them",
      same(rep.rows.slice(-2).map(r => r.orderId), ["P-6", "P-5"]) && rep.rows.slice(0, -2).every(r => r.marginPct !== null));

    // A database that answers oddly.
    const noTr = await L.getOrderProfit(tamper(d1, [{ re: /SELECT id, purchasePriceCents FROM transfers/, all: noRows }]), "P-3");
    ok("no rows list for the transfers: no transfer cost to estimate from", noTr.costs.transfersCents === 0 && !noTr.notes.includes(N_TRANSFER));
    const failTr = await L.getOrderProfit(tamper(d1, [{ re: /SELECT id, purchasePriceCents FROM transfers/, error: "database is locked" }]), "P-3");
    ok("…and the same when the transfers can't be read", failTr.costs.transfersCents === 0);
    const nullCost = await L.getOrderProfit(tamper(d1, [{ re: /FROM inventory_movements/, all: (r) => ({ ...r, results: r.results.map(x => ({ ...x, c: null })) }) }]), "P-4");
    ok("a blank cost the database answers as nothing counts as 0", nullCost.costs.blanksCents === 0 && nullCost.costCents === 0);
    const nullTr = await L.getOrderProfit(tamper(d1, [{ re: /FROM transfer_movements/, all: (r) => ({ ...r, results: r.results.map(x => ({ ...x, c: null })) }) }]), "P-3");
    ok("a transfer cost the database answers as nothing counts as 0 (the estimate still applies)", nullTr.costs.transfersCents === 500);
    const e1 = await rejects(L.getOrderProfit(tamper(d1, [{ re: /FROM inventory_movements/, error: "database is locked" }]), "P-4"));
    ok("a blanks read that fails for another reason fails the profit", !!e1 && /database is locked/.test(e1.message));
    const oldDb = await L.getOrderProfit(tamper(d1, [{ re: /FROM inventory_movements\s+WHERE orderId IN \(SELECT value FROM json_each\(\?\)\) AND kind = 'consume' AND voidedAt IS NULL AND COALESCE\(reason/, error: "no such column: reason" }]), "P-7");
    ok("…while a database before the reason column reads the blanks without it", oldDb.costs.blanksCents === 150 && oldDb.profitCents === 750);
    const e2 = await rejects(L.getOrderProfit(tamper(d1, [{ re: /FROM digitizing_jobs/, error: "database is locked" }]), "P-4"));
    ok("an optional table that fails for another reason fails the profit too", !!e2 && /database is locked/.test(e2.message));
    const noDig = await L.getOrderProfit(tamper(d1, [{ re: /FROM digitizing_jobs/, error: "no such table: digitizing_jobs" }]), "P-4");
    ok("…while no such table means no digitizing cost", noDig.costs.digitizingCents === 0);
    const noPay = await L.getOrderProfit(tamper(d1, [{ re: /FROM order_payments WHERE orderId IN/, all: noRows }]), "P-4");
    ok("no rows list for the payments: no card fees and no refunds", noPay.costs.cardFeesCents === 0 && noPay.revenueCents === 400);
  }

  // =============================================================================================================
  console.log("\n=== Gift card liability: nothing answered, and rows outside the months ===");
  {
    const d1 = await fresh();
    const R = { dateFrom: "2026-01-01", dateTo: "2026-03-31" };
    const empty = await L.getGiftCardLiability(tamper(d1, [
      { re: /FROM gift_card_ledger WHERE at </, first: () => null },
      { re: /FROM gift_cards WHERE status/, first: () => null },
      { re: /FROM gift_card_ledger l LEFT JOIN/, all: noRows }]), R);
    ok("a database that answers no opening, no balance and no rows list: three months of zeros",
      empty.months.length === 3 && empty.totals.openingCents === 0 && empty.totals.closingCents === 0 && empty.outstandingNowCents === 0
      && empty.months.every(m => m.openingCents === 0 && m.closingCents === 0 && m.soldCents === 0));
    const odd = await L.getGiftCardLiability(tamper(d1, [{ re: /FROM gift_card_ledger l LEFT JOIN/, all: (r) => ({ ...r, results: [
      { at: "2025-11-15T18:00:00.000Z", kind: "issue", deltaCents: 500, sold: 0 },
      { at: "2026-02-10T18:00:00.000Z", kind: "adjust", deltaCents: null, sold: 0 },
      { at: "2026-06-01T18:00:00.000Z", kind: "redeem", deltaCents: -200, sold: 0 }] }) }]), R);
    const m = (k) => odd.months.find(x => x.month === k);
    ok("a row before the first month counts in the first month", m("2026-01").issuedCents === 500 && m("2026-01").closingCents === 500);
    ok("a row after the last month counts in the last month", m("2026-03").redeemedCents === 200 && m("2026-03").closingCents === 300);
    ok("a row with no amount moves nothing", m("2026-02").adjustedCents === 0 && m("2026-02").closingCents === 500 && odd.totals.closingCents === 300);
  }

  // =============================================================================================================
  console.log("\n=== QuickBooks data: blank values, no lines, nothing answered ===");
  {
    const d1 = await fresh();
    setting(d1, "accounting", { saleDate: "placed" });
    setting(d1, "terms", { startsAt: "completed", defaultDays: 30 });
    order(d1, "Q-1", { placedAt: "2026-01-10T18:00:00.000Z", shippedAt: null, customerId: 1, net30: 1, poNumber: "" },
      [{ qty: 1, lineTotalCents: 1200, name: "Example Polo", size: "L" }]);
    order(d1, "Q-2", { placedAt: "2026-01-11T18:00:00.000Z", shippedAt: null });
    ins(d1, "order_payments", { id: 1, orderId: "Q-1", amountCents: 500, receivedAt: "2026-01-12T18:00:00.000Z", method: "card", kind: "payment", accountId: null, feeCents: 0 });
    ins(d1, "shipping_labels", { id: 1, orderId: "Q-1", shippoTransactionId: "tx_example_1", carrier: "", service: "", amountCents: 0, trackingNumber: "",
      purchasedAt: "2026-01-12T18:00:00.000Z", accountId: null });
    ins(d1, "expenses", { id: 1, expenseDate: "2026-01-13", description: "Example thread", vendor: "", categoryId: 999, amountCents: 100, accountId: null, paidPersonally: 0, createdAt: "t", updatedAt: "t" });
    ins(d1, "account_transfers", { id: 1, transferDate: "2026-01-14", fromAccountId: 3, toAccountId: 1, amountCents: 500, note: "", externalRef: "", createdAt: "t", updatedAt: "t" });
    ins(d1, "payment_cashouts", { paymentId: 1, transferId: 1, amountCents: 500, createdAt: "t" });
    const R = { dateFrom: "2026-01-01", dateTo: "2026-01-31" };

    // The schema wants a known method and an expense description: the payment and the expense read back with none.
    const data = await L.getQuickBooksData(tamper(d1, [noQty("Q-1"),
      { re: /FROM order_payments p JOIN orders o/, all: (r) => ({ ...r, results: r.results.map(x => ({ ...x, method: "" })) }) },
      { re: /FROM expenses e LEFT JOIN/, all: (r) => ({ ...r, results: r.results.map(x => ({ ...x, description: "", amountCents: 0 })) }) }]), R);
    const s1 = data.sales.find(s => s.orderId === "Q-1"), s2 = data.sales.find(s => s.orderId === "Q-2");
    ok("a line with no qty goes to QuickBooks as one piece at the line's amount",
      !!s1 && same(s1.lines, [{ name: "Example Polo L", qty: 1, rateCents: 1200, amountCents: 1200, taxable: true }]));
    ok("a Net 30 order not finished yet has no due date and, with no PO, an empty PO number",
      !!s1 && s1.net30 === true && s1.dueDate === "" && s1.poNumber === "");
    ok("an order with no lines at all is a sale with no lines and nothing owed", !!s2 && same(s2.lines, []) && s2.totalCents === 0 && s2.date === "2026-01-11");
    const p = data.payments[0];
    ok("a payment with no method is \"other\", with no account and no fee", data.payments.length === 1 && p.method === "other" && p.accountId === null && p.feeCents === 0 && p.kind === "payment");
    ok("a label with no carrier, service or tracking number has an empty memo, no account and no amount",
      same(data.postage, [{ id: 1, date: "2026-01-12", accountId: null, amountCents: 0, orderId: "Q-1", memo: "" }]));
    ok("an expense with no vendor or description, in a category that isn't on file, has an empty payee, category name and memo",
      same(data.expenses, [{ id: 1, date: "2026-01-13", payee: "", categoryId: 999, categoryName: "", accountId: null, amountCents: 0, memo: "", paidPersonally: false }]));
    ok("a Venmo cash-out with no note or reference: empty ones, its payment linked, no fee",
      same(data.deposits, [{ id: 1, date: "2026-01-14", accountId: 1, fromAccountId: 3, amountCents: 500, feeCents: 0, paymentIds: [1], kind: "cashout", note: "", reference: "" }]));

    // Rows the schema won't take, answered by a database that rewrites them.
    const odd = await L.getQuickBooksData(tamper(d1, [
      { re: /FROM order_payments p JOIN orders o/, all: (r) => ({ ...r, results: r.results.map(x => ({ ...x, receivedAt: null, amountCents: null, kind: null })) }) },
      { re: /FROM shipping_labels l JOIN orders o/, all: (r) => ({ ...r, results: r.results.map(x => ({ ...x, amountCents: null })) }) },
      { re: /FROM expenses e LEFT JOIN/, all: (r) => ({ ...r, results: r.results.map(x => ({ ...x, amountCents: null })) }) },
      { re: /SELECT id, name, type FROM accounts/, all: (r) => ({ ...r, results: r.results.map(x => x.id === 2 ? { ...x, name: null, type: null } : x) }) },
      { re: /SELECT id, name FROM expense_categories/, all: (r) => ({ ...r, results: r.results.map(x => x.id === 2 ? { ...x, name: null } : x) }) },
      { re: /FROM account_transfers/, all: (r) => ({ ...r, results: r.results.map(x => ({ ...x, amountCents: null, note: null, externalRef: null })) }) },
      { re: /FROM payment_cashouts c JOIN/, all: (r) => ({ ...r, results: r.results.map(x => ({ ...x, amountCents: null, payCents: null, feeCents: null })) }) }]), R);
    ok("a payment with no time, amount or kind: no date, 0, and a payment", odd.payments[0].date === "" && odd.payments[0].amountCents === 0 && odd.payments[0].kind === "payment");
    ok("a label and an expense with no amount: 0", odd.postage[0].amountCents === 0 && odd.expenses[0].amountCents === 0);
    const a2 = odd.accounts.find(a => a.id === 2);
    ok("an app account with no name or type reads as blank ones, and QuickBooks calls it \"Account 2\"",
      !!a2 && a2.name === "" && a2.type === "" && odd.settings.bankAccounts["2"] === "Account 2");
    ok("an expense category with no name: QuickBooks calls it \"Category 2\"", odd.settings.expenseAccounts["2"] === "Category 2"
      && odd.categories.find(c => c.id === 2).name === "");
    ok("a cash-out with no amount, note or reference, linking a payment with no amounts: 0, empty, no fee",
      same(odd.deposits, [{ id: 1, date: "2026-01-14", accountId: 1, fromAccountId: 3, amountCents: 0, feeCents: 0, paymentIds: [1], kind: "cashout", note: "", reference: "" }]));

    const none = await L.getQuickBooksData(tamper(d1, [
      { re: /FROM order_payments p JOIN orders o/, all: noRows }, { re: /FROM shipping_labels l JOIN orders o/, all: noRows },
      { re: /FROM expenses e LEFT JOIN/, all: noRows }, { re: /SELECT id, name, type FROM accounts/, all: noRows },
      { re: /SELECT id, name FROM expense_categories/, all: noRows }]), R);
    ok("a database that answers no rows lists: no payments, postage, expenses, accounts or categories (the sales still there)",
      same(none.payments, []) && same(none.postage, []) && same(none.expenses, []) && same(none.accounts, []) && same(none.categories, [])
      && same(none.settings.bankAccounts, {}) && none.sales.length === 2);
    ok("…and with no accounts to tell a holding account by, the transfer is still a cash-out by the payment it covers", same(none.deposits, [{ id: 1, date: "2026-01-14", accountId: 1, fromAccountId: 3,
      amountCents: 500, feeCents: 0, paymentIds: [1], kind: "cashout", note: "", reference: "" }]));
  }

  finished = true;
})();
