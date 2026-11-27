// Gift cards in the books and reports (phase 6, migrations/0120), db.js called directly against real SQL (sql.js):
//   insertOrder            a gift card line (productId "__giftcard__") is never taxed and raises nothing for a fundraiser,
//                          even when the caller or a catalog row with that id says taxable
//   Revenue                gift card lines left out of the goods; a gift-card-only order is not listed; an order with no
//                          lines at all is not mistaken for one
//   Sales tax              the report, the return, tax-exempt sales (the tax packet) and the refund-tax math leave the gift
//                          card lines and gift-card-only orders out (a refund of a gift card bought online takes no tax off)
//   Fundraising            pieces, sales and raised leave a gift card line out; a gift-card-only order is not counted
//   Accountant export      no sales line for a gift card; its ledger row says giftCard; card money in counts as receipts,
//                          a gift card spent does not; the refunds summary leaves a gift card refund out
//   COGS and Home money    no "missing cost" for a gift card line; Home's product revenue and order count leave them out
//   Production             a gift card line is like a downloads-only line: no blank to order, nothing to run, not on the
//                          paid-not-run list; a gift-card-only order goes from paid straight to completed
//   Payments               a gift-card payment is not a deposit, not in Money in / out, in no account's balance, and not
//                          a "payment with no account"
//   giftCardTotals         outstanding is what active cards still hold
//   Before migrations/0120 the reports still answer (no giftCardId column, no gift_cards table), and before the
//                          product "No blank" / "digital" columns a gift card line still counts as both
// A mixed order (a gift card and shirts) is counted right in every one of them. Invented data only; db.js's clock is
// set here and the time zone pinned, so nothing depends on today's date or this machine.
process.env.TZ = "UTC";
const fs = require("fs");
const { ok } = require("./testlib/check");
const { createD1 } = require("./testlib/d1-shim.js");

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
let NOW = Date.parse("2027-03-20T12:00:00.000Z");
const RealDate = Date;
class FakeDate extends RealDate { constructor(...a) { if (a.length) super(...a); else super(NOW); } static now() { return NOW; } }
const lib = new Function("Date", strip(read("functions/_lib/db.js")) + `\nreturn { insertOrder, createProduct, setSalesTaxSettings, setOrgFundraiser,
  setAccountingSettings, issueGiftCard, redeemGiftCard, voidGiftCard, addOrderPayment, getRevenueData, getSalesTaxReport, getSalesTaxReturn,
  getTaxPacketExtras, getSalesTaxRefunds, getAccountantExport, getMoneySummary, getMoneyInOutByMonth, getDashboardMoney, getCogsReport,
  getDepositPayments, giftCardTotals, getPaidUnrunOrders, getBlanksToOrder, getProductionQueue, getOpenOrderStages, setOrdersCompleted,
  getOrderById, getFundraisingReport, GIFT_CARD_PRODUCT_ID };`)(FakeDate);
process.on("unhandledRejection", (e) => { console.error(e); ok("nothing in the test was left to fail unseen", false); });

const MIGRATIONS = fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort();
async function makeDb(before) {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of MIGRATIONS) if (!before || f < before) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES
    ('club','club','Example Club','t','t'), ('school','school','Example School','t','t');`);
  d1._raw.exec("UPDATE orgs SET taxExempt = 1 WHERE orgId = 'school'");
  return d1;
}
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;
const MAR = ["2027-03-01T00:00:00.000Z", "2027-03-31T23:59:59.999Z"];
const APR = ["2027-04-01T00:00:00.000Z", "2027-04-30T23:59:59.999Z"];
const gift = (amount, who = "Sam Example") => ({ productId: "__giftcard__", name: "Gift card for " + who, type: "giftcard", size: "", qty: 1, unitPrice: amount, taxable: true });
const tee = (qty, price = 20, productId = "tee") => ({ productId, name: "Club Tee", type: "shirt", size: "L", qty, unitPrice: price });
const customer = { customerName: "Pat Example", contact: "pat@example.com" };
// A database whose statements matching `re` fail with `message` (as a database without that column would).
function failing(db, re, message) {
  const boom = () => { const s = { bind: () => s, run: async () => { throw new Error(message); }, all: async () => { throw new Error(message); }, first: async () => { throw new Error(message); } }; return s; };
  return new Proxy(db, { get(t, k) { if (k === "prepare") return (sql) => (re.test(sql) ? boom() : t.prepare(sql)); const v = t[k]; return typeof v === "function" ? v.bind(t) : v; } });
}

(async () => {
  const d1 = await makeDb();
  const q = (sql, ...p) => d1.q(sql, ...p);
  await lib.setSalesTaxSettings(d1, { rateBps: 1000, jurisdiction: "", taxMode: "exclusive" });
  await lib.setAccountingSettings(d1, { saleDate: "placed" });
  await lib.setOrgFundraiser(d1, "club", { mode: "percent", percent: 10, label: "Example Boosters" });
  await lib.createProduct(d1, "club", { productId: "tee", type: "shirt", name: "Club Tee", pricingMode: "flat", flatPrice: 20, visible: true, taxable: true });
  await lib.createProduct(d1, "club", { productId: "patch", type: "shirt", name: "Club Patch Tee", pricingMode: "flat", flatPrice: 20, visible: true, taxable: true, noDesignNeeded: true, noBlankNeeded: true });
  await lib.createProduct(d1, "school", { productId: "tee", type: "shirt", name: "School Tee", pricingMode: "flat", flatPrice: 30, visible: true, taxable: true });
  const at = (iso) => ({ receivedAt: iso });

  console.log("=== A gift card line is never taxed and raises nothing ===");
  {
    await lib.insertOrder(d1, { orderId: "G1", orgId: "club", ...customer, placedAt: "2027-03-05T10:00:00.000Z" }, [gift(50)]);
    await lib.insertOrder(d1, { orderId: "M1", orgId: "club", ...customer, placedAt: "2027-03-06T10:00:00.000Z" }, [gift(50), tee(2)]);
    const line = (id, pid) => q("SELECT taxable, taxCents, fundraiserCents, lineTotalCents FROM order_items WHERE orderId = ? AND productId = ?", id, pid)[0];
    const g = line("G1", "__giftcard__"), mg = line("M1", "__giftcard__"), mt = line("M1", "tee");
    ok("a gift card bought on its own is stored untaxed, though the line says taxable and the shop adds 10% tax", g.taxable === 0 && g.taxCents === 0 && g.lineTotalCents === 5000);
    ok("a gift card beside shirts is untaxed too", mg.taxable === 0 && mg.taxCents === 0);
    ok("while the shirts on the same order are taxed at the shop's rate", mt.taxable === 1 && mt.taxCents === 400);
    ok("a gift card raises nothing for the shop's fundraiser, while the shirts raise their 10%", g.fundraiserCents === 0 && mg.fundraiserCents === 0 && mt.fundraiserCents === 400);
    ok("the mixed order comes to the gift card, the shirts and the shirts' tax", q("SELECT totalCents FROM orders WHERE orderId = 'M1'")[0].totalCents === 9400);
    // Even a catalog row that happens to have the gift card's id and says taxable doesn't make the line taxed.
    q("INSERT INTO products (orgId, productId, type, name, pricingMode, taxable, createdAt, updatedAt) VALUES ('club', '__giftcard__', 'giftcard', 'Gift card', 'flat', 1, 't', 't')");
    await lib.insertOrder(d1, { orderId: "G9", orgId: "club", ...customer, placedAt: "2027-02-01T10:00:00.000Z" }, [gift(10)]);
    ok("a catalog row named like the gift card saying taxable still leaves the line untaxed", line("G9", "__giftcard__").taxCents === 0 && line("G9", "__giftcard__").taxable === 0);
    q("DELETE FROM order_items WHERE orderId = 'G9'"); q("DELETE FROM orders WHERE orderId = 'G9'"); q("DELETE FROM products WHERE productId = '__giftcard__'");
    ok("the shared product id is __giftcard__", lib.GIFT_CARD_PRODUCT_ID === "__giftcard__");
  }

  // The March books: G1 (a $50 gift card bought by card), M1 (a $50 gift card and two shirts, paid part by that card,
  // the rest by card), G2 (a $25 gift card never paid), E1 (a tax-exempt school: a $20 gift card and a $30 shirt), E2
  // (the school: a $40 gift card on its own), N1 (an order with no lines at all).
  await lib.addOrderPayment(d1, "G1", 50, "", "", { method: "card", ...at("2027-03-05T10:05:00.000Z") });
  const card = await lib.issueGiftCard(d1, { amountCents: 5000, recipientName: "Sam Example", sourceOrderId: "G1", now: "2027-03-05T10:06:00.000Z" });
  const spent = await lib.redeemGiftCard(d1, { code: card.code, orderId: "M1", amountCents: 3000, now: "2027-03-07T10:00:00.000Z" });
  await lib.addOrderPayment(d1, "M1", 64, "", "", { method: "card", ...at("2027-03-07T10:01:00.000Z") });
  await lib.insertOrder(d1, { orderId: "G2", orgId: "club", ...customer, placedAt: "2027-03-08T10:00:00.000Z" }, [gift(25)]);
  await lib.insertOrder(d1, { orderId: "E1", orgId: "school", ...customer, placedAt: "2027-03-09T10:00:00.000Z" }, [gift(20), tee(1, 30)]);
  await lib.insertOrder(d1, { orderId: "E2", orgId: "school", ...customer, placedAt: "2027-03-09T11:00:00.000Z" }, [gift(40)]);
  q("INSERT INTO orders (orderId, orgId, customerName, contact, placedAt, taxMode) VALUES ('N1', 'club', 'Lee Example', 'lee@example.com', '2027-03-10T10:00:00.000Z', 'exclusive')");
  const giftPay = q("SELECT * FROM order_payments WHERE giftCardId IS NOT NULL")[0];
  ok("(setup) the gift card took $30 of the mixed order, which the card payment then settled", spent.ok && spent.takenCents === 3000 && q("SELECT paid FROM orders WHERE orderId = 'M1'")[0].paid === 1);

  console.log("\n=== Revenue ===");
  {
    const rows = await lib.getRevenueData(d1, ...MAR, { basis: "placed" });
    const by = Object.fromEntries(rows.map(r => [r.orderId, r]));
    ok("a gift card bought on its own is not a sale: the order isn't in Revenue", !by.G1);
    ok("nor is an unpaid gift-card-only order, nor a tax-exempt one", !by.G2 && !by.E2);
    ok("an order with no lines at all is still listed (it isn't taken for a gift card order)", !!by.N1 && by.N1.itemSubtotal === 0);
    ok("the mixed order's goods are only its shirts ($40)", !!by.M1 && near(by.M1.itemSubtotal, 40) && by.M1.netSalesCents === 4000);
    ok("and its tax only theirs ($4), its total for Revenue $44", near(by.M1.salesTax, 4) && near(by.M1.effectiveTotal, 44));
    ok("the exempt school's mixed order counts its $30 shirt and no tax", !!by.E1 && near(by.E1.itemSubtotal, 30) && near(by.E1.salesTax, 0));
    ok("exactly three March orders are in Revenue", rows.length === 3);
  }

  console.log("\n=== The sales tax report and return ===");
  {
    const rep = await lib.getSalesTaxReport(d1, ...MAR);
    const taxed = rep.find(r => !r.exempt), exempt = rep.find(r => r.exempt);
    ok("the taxable row counts the mixed order's shirts only: $44 gross, $4 tax, $40 net", !!taxed && near(taxed.grossSales, 44) && near(taxed.taxCollected, 4) && near(taxed.netSales, 40));
    ok("and counts two orders there, the mixed one and the empty one (the gift-card-only ones are left out)", !!taxed && taxed.orders === 2);
    ok("the exempt row is the school's $30 shirt, one order", !!exempt && near(exempt.netSales, 30) && exempt.orders === 1);
    const ret = (await lib.getSalesTaxReturn(d1, ...MAR)).total;
    ok("the return's gross sales are $70 of goods (no gift cards)", near(ret.grossSales, 70));
    ok("taxable sales $40 and exempt sales $30", near(ret.taxableSales, 40) && near(ret.exemptSales, 30));
    ok("no gift card shows up as a non-taxable sale", near(ret.nonTaxableSales, 0));
    ok("the tax due is the $4 the shirts carried", near(ret.taxCollected, 4) && near(ret.totalDue, 4));
    ok("two orders are on the return", ret.orders === 2);
    const extras = await lib.getTaxPacketExtras(d1, ...MAR);
    const school = extras.exempt.find(x => x.orgId === "school");
    ok("tax-exempt sales by shop: the school sold $30 on one order (its gift cards left out)", !!school && near(school.sales, 30) && school.orders === 1);
  }

  console.log("\n=== Refunds and their tax ===");
  {
    // April: R1 is a $10 gift card and two $20 shirts (tax on top, $54), paid by card, then $22 given back; G3 is a $30
    // gift card bought by card and refunded in full.
    await lib.insertOrder(d1, { orderId: "R1", orgId: "club", ...customer, placedAt: "2027-04-02T10:00:00.000Z" }, [gift(10), tee(2)]);
    await lib.addOrderPayment(d1, "R1", 54, "", "", { method: "card", ...at("2027-04-02T10:01:00.000Z") });
    await lib.addOrderPayment(d1, "R1", -22, "Returned one", "", { method: "card", kind: "refund", ...at("2027-04-05T10:00:00.000Z") });
    await lib.insertOrder(d1, { orderId: "G3", orgId: "club", ...customer, placedAt: "2027-04-03T10:00:00.000Z" }, [gift(30)]);
    await lib.addOrderPayment(d1, "G3", 30, "", "", { method: "card", ...at("2027-04-03T10:01:00.000Z") });
    await lib.addOrderPayment(d1, "G3", -30, "Changed their mind", "", { method: "card", kind: "refund", ...at("2027-04-06T10:00:00.000Z") });
    const refunds = await lib.getSalesTaxRefunds(d1, ...APR);
    const apr = refunds.find(r => r.month === "2027-04");
    ok("a gift card bought online and refunded is not a refunded sale: April has one refund, $22", !!apr && apr.refunds === 1 && near(apr.refunded, 22));
    ok("the $22 back on the mixed order was all taxable goods: $2 of tax comes off (the gift card isn't part of the goods)", !!apr && near(apr.taxRefunded, 2));
    const ret = (await lib.getSalesTaxReturn(d1, ...APR)).total;
    ok("April's return: $4 collected, $2 refunded, $2 due", near(ret.taxCollected, 4) && near(ret.taxRefunded, 2) && near(ret.totalDue, 2));
    const ex = await lib.getAccountantExport(d1, ...APR);
    const m = ex.summary.find(s => s.month === "2027-04");
    ok("the accountant export's April refunds are the $22 only, with $2 of tax", !!m && near(m.refunds, 22) && near(m.taxRefunded, 2));
    ok("while every dollar the cards took in April is card receipts ($54 and $30)", !!m && near(m.cardReceipts, 84));
  }

  console.log("\n=== Fundraising ===");
  {
    // May, written straight into the tables so a gift card line carries a fundraiser figure the report must still skip.
    const add = (id, lines) => {
      q("INSERT INTO orders (orderId, orgId, customerName, contact, paid, placedAt, taxMode) VALUES (?, 'club', 'Pat Example', 'pat@example.com', 1, ?, 'exclusive')", id, "2027-05-04T10:00:00.000Z");
      for (const l of lines) q(`INSERT INTO order_items (orderId, orgId, productId, name, type, qty, unitPriceCents, lineTotalCents, taxCents, taxRateBps, fundraiserCents)
        VALUES (?, 'club', ?, 'Item', 'shirt', ?, ?, ?, 0, 0, ?)`, id, l.pid, l.qty, l.cents / l.qty, l.cents, l.raise);
    };
    add("F1", [{ pid: "__giftcard__", qty: 1, cents: 5000, raise: 500 }, { pid: "tee", qty: 2, cents: 4000, raise: 400 }]);
    add("F2", [{ pid: "__giftcard__", qty: 1, cents: 2500, raise: 250 }]);
    const r = await lib.getFundraisingReport(d1, { dateFrom: "2027-05-01", dateTo: "2027-05-31", basis: "placed" });
    const club = r.shops.find(s => s.orgId === "club");
    ok("a gift-card-only order isn't one of the shop's fundraising orders", r.orders.length === 1 && r.orders[0].orderId === "F1");
    ok("the mixed order's pieces are its 2 shirts, not the gift card", r.orders[0].pieces === 2);
    ok("its sales are the $40 of shirts", near(r.orders[0].sales, 40));
    ok("and it raised the shirts' $4 only", near(r.orders[0].raised, 4));
    ok("the shop's totals agree: one order, 2 pieces, $40 sales, $4 raised", !!club && club.orders === 1 && club.pieces === 2 && near(club.sales, 40) && near(club.raised, 4));
  }

  console.log("\n=== The accountant export ===");
  {
    const ex = await lib.getAccountantExport(d1, ...MAR);
    ok("no sales line is a gift card", ex.sales.length > 0 && ex.sales.every(s => s.productId !== "__giftcard__"));
    ok("the mixed order has its one shirt line, $40 net, $4 tax", ex.sales.filter(s => s.orderId === "M1").length === 1 && near(ex.sales.find(s => s.orderId === "M1").net, 40));
    const gl = ex.ledger.find(p => p.reference === "Gift card ••" + card.last4);
    ok("the gift card spent on the mixed order is in the ledger, marked as a gift card", !!gl && gl.giftCard === true && near(gl.amount, 30) && gl.orderId === "M1");
    ok("the card payments are not marked as gift cards", ex.ledger.filter(p => p.method === "card").length === 2 && ex.ledger.filter(p => p.method === "card").every(p => !("giftCard" in p)));
    const m = ex.summary.find(s => s.month === "2027-03");
    ok("card receipts are the money that came in: $50 for the gift card and $64 on the mixed order", !!m && near(m.cardReceipts, 114));
    ok("the $30 gift card spend is not money received", !!m && near(m.otherReceipts, 0));
    ok("gross sales and tax are the shirts' ($74 with tax, $4 tax, $70 net)", !!m && near(m.grossSales, 74) && near(m.taxCollected, 4) && near(m.netSales, 70));
    ok("the exempt sales are the school's $30 shirt", !!m && near(m.exemptSales, 30));
  }

  console.log("\n=== Cost of goods and Home's money ===");
  {
    q("UPDATE orders SET manufacturedAt = '2027-03-11T10:00:00.000Z' WHERE orderId = 'M1'");
    const cogs = await lib.getCogsReport(d1, ...MAR, { basis: "placed" });
    const m1 = cogs.missingCost.filter(x => x.orderId === "M1");
    ok("a made mixed order lists its shirts as missing a cost, never the gift card", m1.length === 1 && m1[0].name === "Club Tee");
    q("UPDATE orders SET manufacturedAt = NULL WHERE orderId = 'M1'");
    const home = await lib.getDashboardMoney(d1, { yearFrom: "2027-01-01", monthFrom: "2027-03-01", to: "2027-03-31", basis: "placed", byCategory: false });
    ok("Home's product revenue for March is the $70 of goods, no gift cards", near(home.month.productRevenue, 70));
    ok("and its order count leaves the gift-card-only orders out", home.month.orders === 3);
  }

  console.log("\n=== Payments by gift card: not money that moved ===");
  {
    const dep = await lib.getDepositPayments(d1);
    ok("the card payments for the gift card and the mixed order are waiting to be deposited", ["G1", "M1"].every(id => dep.some(p => p.orderId === id && p.method === "card")));
    ok("the gift card payment never is", !dep.some(p => p.id === Number(giftPay.id)));
    ok("(the gift card payment has no account, is method other, and is not a deposit)", giftPay.accountId === null && giftPay.method === "other");
    q("UPDATE order_payments SET depositOpen = 1 WHERE id = ?", giftPay.id);
    ok("even marked open for deposit it isn't listed", !(await lib.getDepositPayments(d1)).some(p => p.id === Number(giftPay.id)));
    const io = await lib.getMoneyInOutByMonth(d1, { yearFrom: "2027-01-01", to: "2027-03-31" });
    const mar = io.months.find(x => x.month === "2027-03");
    ok("Money in for March is the $114 the cards took (with the tax inside it split out), not the gift card spend", !!mar && near(mar.in.payments + mar.in.taxCollected, 114));
    const sum = await lib.getMoneySummary(d1, ...MAR);
    ok("a gift card payment is not a payment with no account", sum.unassigned === 0);
    const stripe = sum.balances.find(b => b.type === "stripe");
    ok("the Stripe balance holds only the card money ($114)", !!stripe && near(stripe.balance, 114));
    q("INSERT INTO order_payments (orderId, amountCents, note, receivedAt, method, kind, accountId) VALUES ('N1', 500, 'Typed in', '2027-03-10T11:00:00.000Z', 'cash', 'payment', NULL)");
    ok("while a cash payment with no account still is one", (await lib.getMoneySummary(d1, ...MAR)).unassigned === 1);
    q("DELETE FROM order_payments WHERE orderId = 'N1'");
  }

  console.log("\n=== What gift cards still hold ===");
  {
    let t = await lib.giftCardTotals(d1, {});
    ok("outstanding is the $20 left on the card after $30 was spent", near(t.outstanding, 20) && near(t.sold, 50) && near(t.redeemed, 30));
    const other = await lib.issueGiftCard(d1, { amountCents: 2500, recipientName: "Lee Example", by: "Staff", now: "2027-03-15T10:00:00.000Z" });
    t = await lib.giftCardTotals(d1, {});
    ok("a new $25 card adds to what's outstanding", near(t.outstanding, 45) && near(t.sold, 75));
    t = await lib.giftCardTotals(d1, { dateFrom: "2027-03-10T00:00:00.000Z", dateTo: "2027-03-31T23:59:59.999Z" });
    ok("sold counts the cards made in the range, outstanding is still every active card now", near(t.sold, 25) && near(t.redeemed, 0) && near(t.outstanding, 45));
    await lib.voidGiftCard(d1, { id: other.id, note: "Issued by mistake", now: "2027-03-16T10:00:00.000Z" });
    t = await lib.giftCardTotals(d1, {});
    ok("a voided card holds nothing", near(t.outstanding, 20) && near(t.adjusted, -25));
  }

  console.log("\n=== Production: a gift card is nothing to make ===");
  {
    // P1: the "No blank, no design" tee and a gift card, paid.
    await lib.insertOrder(d1, { orderId: "P1", orgId: "club", ...customer, placedAt: "2027-03-12T10:00:00.000Z" }, [gift(15), tee(1, 20, "patch")]);
    q("UPDATE orders SET paid = 1, digitizingCompleteAt = '2027-03-12T11:00:00.000Z' WHERE orderId = 'P1'");
    const g1 = await lib.getOrderById(d1, "G1"), m1 = await lib.getOrderById(d1, "M1");
    ok("a gift card line reads as digital and needing no blank", g1.items[0].digital === true && g1.items[0].noBlank === true);
    ok("a gift-card-only order is downloads-only and needs no blanks", g1.digitalOnly === true && g1.needsBlanks === false);
    ok("a mixed order is not downloads-only and still needs blanks for its shirts", m1.digitalOnly === false && m1.needsBlanks === true && m1.hasDigital === true);
    const stages = Object.fromEntries((await lib.getOpenOrderStages(d1)).map(s => [s.orderId, s.stage]));
    ok("on Home, a paid gift-card-only order waits only to be closed out (Ship), an unpaid one is New", stages.G1 === "ship" && stages.G2 === "new");
    ok("a paid mixed order waits for its blanks", stages.M1 === "paid");
    const unrun = await lib.getPaidUnrunOrders(d1);
    ok("Paid, not yet run leaves out a paid gift-card-only order", !unrun.some(o => o.orderId === "G1"));
    const um1 = unrun.find(o => o.orderId === "M1");
    ok("and lists the mixed order with only its shirts", !!um1 && um1.items.length === 1 && um1.items[0].name === "Club Tee");
    const blanks = await lib.getBlanksToOrder(d1, { includeUnpaid: true });
    ok("no gift card is a blank to order", !blanks.unlinked.some(l => /^Gift card/.test(l.name)) && blanks.unlinked.some(l => l.orderId === "M1"));
    const queue = await lib.getProductionQueue(d1);
    ok("the Run order has the paid no-blank shirt but never the gift card beside it", queue.some(j => j.orderId === "P1") && queue.filter(j => j.orderId === "P1").length === 1 && !queue.some(j => j.orderId === "G1"));
    const done = await lib.setOrdersCompleted(d1, ["G1", "G2", "M1"], true, "2027-03-20T12:00:00.000Z");
    ok("a paid gift-card-only order completes without being delivered", done.updated.some(u => u.orderId === "G1"));
    ok("an unpaid one can't: a balance is still due", done.skipped.some(s => s.orderId === "G2" && s.reason === "a balance is still due"));
    ok("a mixed order still has to be delivered first", done.skipped.some(s => s.orderId === "M1" && s.reason === "not delivered yet"));
  }

  console.log("\n=== Before the product No blank and digital columns ===");
  {
    const old = failing(failing(d1, /SELECT noBlankNeeded FROM products LIMIT 0/, "no such column: noBlankNeeded"), /SELECT digital FROM products LIMIT 0/, "no such column: digital");
    const stages = Object.fromEntries((await lib.getOpenOrderStages(old)).map(s => [s.orderId, s.stage]));
    ok("a gift-card-only order is still nothing to make (it waits for payment, then only to be closed out)", stages.G2 === "new" && stages.E2 === "new");
    q("UPDATE orders SET paid = 1 WHERE orderId = 'E2'");
    const again = Object.fromEntries((await lib.getOpenOrderStages(old)).map(s => [s.orderId, s.stage]));
    ok("paid, it goes straight to Ship with no blanks or run", again.E2 === "ship");
    ok("while a mixed order still waits for blanks", again.M1 === "paid");
    const e2 = await lib.getOrderById(old, "E2");
    ok("its gift card line still reads as digital and needing no blank", e2.items[0].digital === true && e2.items[0].noBlank === true);
    q("UPDATE orders SET paid = 0 WHERE orderId = 'E2'");
  }

  console.log("\n=== A database from before migrations/0120 ===");
  {
    const pre = await makeDb("0120");
    pre.q("INSERT INTO orders (orderId, orgId, customerName, contact, placedAt, taxMode, paid) VALUES ('O1', 'club', 'Pat Example', 'pat@example.com', '2027-03-05T10:00:00.000Z', 'exclusive', 1)");
    pre.q("INSERT INTO order_items (orderId, orgId, productId, name, type, qty, unitPriceCents, lineTotalCents, taxCents, taxRateBps, taxable) VALUES ('O1', 'club', 'tee', 'Club Tee', 'shirt', 1, 2000, 2000, 200, 1000, 1)");
    pre.q("INSERT INTO order_payments (orderId, amountCents, note, receivedAt, method, kind, accountId) VALUES ('O1', 2200, '', '2027-03-05T10:01:00.000Z', 'cash', 'payment', NULL)");
    const ex = await lib.getAccountantExport(pre, ...MAR);
    ok("the accountant export still answers: one sale line, the payment in the ledger with no gift card mark", ex.sales.length === 1 && ex.ledger.length === 1 && !("giftCard" in ex.ledger[0]));
    ok("and the payment counts as money received", near(ex.summary.find(s => s.month === "2027-03").otherReceipts, 22));
    ok("a payment with no account is still flagged", (await lib.getMoneySummary(pre, ...MAR)).unassigned === 1);
    const io = await lib.getMoneyInOutByMonth(pre, { yearFrom: "2027-01-01", to: "2027-03-31" });
    const mar = io.months.find(x => x.month === "2027-03");
    ok("Money in still counts the payment", !!mar && near(mar.in.payments + mar.in.taxCollected, 22));
    const t = await lib.giftCardTotals(pre, {});
    ok("gift card totals are all zero", t.sold === 0 && t.redeemed === 0 && t.adjusted === 0 && t.refunded === 0 && t.outstanding === 0);
    const broken = failing(pre, /FROM order_payments p JOIN orders o/, "disk full");
    let err = null; try { await lib.getAccountantExport(broken, ...MAR); } catch (e) { err = e; }
    ok("any other database error in the ledger is passed on, not taken for an old database", !!err && err.message === "disk full");
    err = null; try { await lib.giftCardTotals(failing(d1, /FROM gift_card_ledger/, "disk full"), {}); } catch (e) { err = e; }
    ok("and so is one reading gift card totals", !!err && err.message === "disk full");
  }
})().catch((e) => { console.error(e); ok("the test ran to the end", false); });
