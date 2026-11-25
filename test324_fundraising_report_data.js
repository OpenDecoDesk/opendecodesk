// Fundraising for group shops (migrations/0110): the report and the payouts, db.js called directly.
//   getFundraisingReport     which shops are listed (a fundraiser now, or raised / paid out in the range, else not), the
//                            orgId filter, orders / pieces / sales / raised per shop and in total, the per-order rows,
//                            only paid orders that aren't voided or test orders, cancelled lines out, refunds, each
//                            sale-date basis (and the default), whole inclusive days, owed over all time up to dateTo
//                            (owedAsOf) and never clamped, bad or reversed dates refused, a database before 0110
//   recordFundraiserPayout   every refusal, the expense written through saveExpense (category, shop, description,
//                            vendor, account), and that it shows wherever expenses show (listExpenses, the accountant export)
//   listFundraiserPayouts    the filters, newest first, the shop's and the account's names, deleted payouts left out
// Real SQL (sql.js) + the real db.js, with db.js's clock set here (Date is replaced inside db.js only) and the time zone
// pinned, so nothing depends on today's date or on this machine. Invented shops, groups and customers only.
process.env.TZ = "America/Los_Angeles";
const fs = require("fs");
const { ok } = require("./testlib/check");
const { createD1 } = require("./testlib/d1-shim.js");

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");

let NOW = Date.parse("2027-06-15T12:00:00.000Z");
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(NOW); }
  static now() { return NOW; }
}
const at = (iso) => { NOW = RealDate.parse(iso); };

const lib = new Function("Date", strip(read("functions/_lib/db.js")) +
  "\nreturn { getFundraisingReport, recordFundraiserPayout, listFundraiserPayouts, setOrgFundraiser, setAccountingSettings," +
  " saveAccount, saveExpense, deleteExpense, listExpenses, getAccountantExport, FUNDRAISER_PAYOUT_KEY };")(FakeDate);

const MIGRATIONS = fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort();
async function makeDb(before) {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of MIGRATIONS) if (!before || f < before) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES
    ('club','club','Example Club','t','t'), ('band','band','Example Band','t','t'), ('league','league','Example League','t','t'),
    ('choir','choir','Example Choir','t','t'), ('chess','chess','Example Chess','t','t'), ('robo','robo','Example Robotics','t','t'),
    ('plain','plain','Sample Works','t','t'), ('broken','broken','Sample Broken','t','t');`);
  return d1;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const NOT_READY = "Fundraising needs the latest database update. Apply the migrations, then try again.";

// An order straight into the tables, so every column the report reads is exactly as written here.
let lineSeq = 0;
function addOrder(d1, o, lines) {
  d1.q(`INSERT INTO orders (orderId, orgId, customerName, contact, paid, placedAt, shippedAt, deliveredAt, completedAt, voidedAt, isTest, taxMode)
    VALUES (?, ?, ?, 'pat@example.com', ?, ?, ?, ?, ?, ?, ?, ?)`, o.id, o.org, o.customer || "Pat Example", o.paid === 0 ? 0 : 1,
    o.placedAt, o.shippedAt || null, o.deliveredAt || null, o.completedAt || null, o.voidedAt || null, o.isTest ? 1 : 0, o.taxMode || "inclusive");
  for (const l of lines) {
    lineSeq++;
    d1.q(`INSERT INTO order_items (orderId, orgId, productId, name, type, qty, unitPriceCents, lineTotalCents, taxCents, taxRateBps,
      cancelDate, refundCents, fundraiserCents) VALUES (?, ?, ?, ?, 'shirt', ?, ?, ?, ?, ?, ?, ?, ?)`,
      o.id, o.org, l.productId === undefined ? "p" + lineSeq : l.productId, "Item " + lineSeq, l.qty || 1,
      Math.round((l.total || 0) / (l.qty || 1)), l.total || 0, l.tax || 0, l.tax ? 1000 : 0,
      l.cancelDate || null, l.refund === undefined ? null : l.refund, l.raise || 0);
  }
}
function payout(d1, org, date, cents, { deleted = false, accountId = null } = {}) {
  d1.q(`INSERT INTO expenses (expenseDate, description, categoryId, amountCents, createdAt, updatedAt, deletedAt, accountId, fundraiserOrgId)
    VALUES (?, 'Fundraiser payout', (SELECT id FROM expense_categories WHERE systemKey = 'fundraiser_payout'), ?, 't', 't', ?, ?, ?)`,
    date, cents, deleted ? "2027-03-21T00:00:00.000Z" : null, accountId, org);
}

// The fixture every report section reads. The range under test is March 2027.
async function reportDb() {
  const d1 = await makeDb();
  await lib.setOrgFundraiser(d1, "club", { mode: "percent", percent: 10, label: "Example Boosters", showOnShop: true });
  await lib.setOrgFundraiser(d1, "band", { mode: "perPiece", amount: 2, label: "Example Band Parents" });
  await lib.setOrgFundraiser(d1, "robo", { mode: "percent", percent: 5, label: "Example Robotics Team" });
  d1.q("UPDATE orgs SET fundraiserJson = ? WHERE orgId = 'broken'", '{"mode":"percent","percentBps":"lots","label":"Example"}');
  // Example Club
  addOrder(d1, { id: "C1", org: "club", placedAt: "2027-02-25T10:00:00.000Z", shippedAt: "2027-03-01T00:00:00.000Z", customer: "Pat Example" }, [
    { qty: 2, total: 2200, tax: 200, raise: 200 },                         // inclusive: goods 2000
    { productId: "__custom__", qty: 1, total: 500, raise: 0 },             // a custom line: sales, no pieces
  ]);
  addOrder(d1, { id: "C2", org: "club", placedAt: "2027-03-10T10:00:00.000Z", shippedAt: "2027-03-31T23:59:59.999Z", taxMode: "exclusive", customer: "Sam Example" }, [
    { qty: 3, total: 3000, tax: 300, raise: 300, refund: 1000 },           // exclusive: goods 3000, a third refunded
    { qty: 5, total: 5000, raise: 500, cancelDate: "2027-03-12T00:00:00.000Z" },   // cancelled: nothing
    { productId: "", qty: 1, total: 100 },                                  // no product: sales, no pieces
  ]);
  addOrder(d1, { id: "C9", org: "club", placedAt: "2027-03-11T10:00:00.000Z", deliveredAt: "2027-03-12T09:00:00.000Z", customer: "Lee Example" }, [
    { productId: "__custom__", qty: 1, total: 700 },                        // raised nothing, still an order
  ]);
  addOrder(d1, { id: "C3", org: "club", paid: 0, placedAt: "2027-03-03T10:00:00.000Z", shippedAt: "2027-03-04T10:00:00.000Z" }, [{ qty: 1, total: 9000, raise: 900 }]);
  addOrder(d1, { id: "C4", org: "club", voidedAt: "2027-03-06T00:00:00.000Z", placedAt: "2027-03-03T10:00:00.000Z", shippedAt: "2027-03-04T10:00:00.000Z" }, [{ qty: 1, total: 9000, raise: 900 }]);
  addOrder(d1, { id: "C5", org: "club", isTest: true, placedAt: "2027-03-03T10:00:00.000Z", shippedAt: "2027-03-04T10:00:00.000Z" }, [{ qty: 1, total: 9000, raise: 900 }]);
  addOrder(d1, { id: "C6", org: "club", placedAt: "2027-03-20T10:00:00.000Z", shippedAt: "2027-04-01T00:00:00.000Z" }, [{ qty: 1, total: 3000, raise: 300 }]);
  addOrder(d1, { id: "C7", org: "club", placedAt: "2027-02-20T10:00:00.000Z", completedAt: "2027-02-28T23:59:59.999Z" }, [{ qty: 1, total: 10000, raise: 1000 }]);
  addOrder(d1, { id: "C8", org: "club", placedAt: "2027-03-15T10:00:00.000Z" }, [{ qty: 4, total: 4000, raise: 400 }]);   // paid, not shipped
  payout(d1, "club", "2027-02-15", 500);
  payout(d1, "club", "2027-03-15", 100);
  payout(d1, "club", "2027-03-20", 700, { deleted: true });
  payout(d1, "club", "2027-04-02", 5000);
  // Example Band: one line refunded more than its total, one whole
  addOrder(d1, { id: "B1", org: "band", placedAt: "2027-03-02T10:00:00.000Z", shippedAt: "2027-03-05T10:00:00.000Z", customer: "Kim Example" }, [
    { qty: 4, total: 4000, raise: 800, refund: 8000 },
    { qty: 1, total: 1000, raise: 200 },
  ]);
  payout(d1, "band", "2027-03-06", 1000);
  // Example League: its fundraiser has ended, but it raised money in March
  addOrder(d1, { id: "E1", org: "league", placedAt: "2027-03-06T10:00:00.000Z", shippedAt: "2027-03-07T10:00:00.000Z", customer: "Ali Example" }, [{ qty: 2, total: 1500, raise: 150 }]);
  // Example Choir: no fundraiser, a payout in March; Example Chess: no fundraiser, a payout in February only
  payout(d1, "choir", "2027-03-09", 300);
  payout(d1, "chess", "2027-02-01", 400);
  // Sample Works: no fundraiser, a paid order that raised nothing; Sample Broken: a damaged setup, an order, nothing raised
  addOrder(d1, { id: "P1", org: "plain", placedAt: "2027-03-02T10:00:00.000Z", shippedAt: "2027-03-08T10:00:00.000Z" }, [{ qty: 1, total: 1000 }]);
  addOrder(d1, { id: "X1", org: "broken", placedAt: "2027-03-02T10:00:00.000Z", shippedAt: "2027-03-08T10:00:00.000Z" }, [{ qty: 1, total: 1000 }]);
  // An ordinary expense is never a payout
  d1.q(`INSERT INTO expenses (expenseDate, description, categoryId, amountCents, createdAt, updatedAt) VALUES ('2027-03-10', 'Thread', 1, 2500, 't', 't')`);
  return d1;
}
const shopOf = (r, id) => r.shops.find(s => s.orgId === id);
const fig = (s) => s && [s.orders, s.pieces, s.sales, s.raised, s.paidOut, s.owed];

(async () => {
  // =====================================================================================================
  console.log("=== The Fundraising report: which shops are listed ===");
  const d1 = await reportDb();
  const R = await lib.getFundraisingReport(d1, { dateFrom: "2027-03-01", dateTo: "2027-03-31" });
  ok("the answer has shops, orders, totals, the dates and owedAsOf", same(Object.keys(R).sort(), ["dateFrom", "dateTo", "orders", "owedAsOf", "shops", "totals"]));
  ok("the answer repeats the range it was asked for", R.dateFrom === "2027-03-01" && R.dateTo === "2027-03-31");
  ok("owed is stated as of the end date (owedAsOf = dateTo)", R.owedAsOf === "2027-03-31");
  ok("a shop with a fundraiser now is listed", !!shopOf(R, "club") && !!shopOf(R, "band"));
  ok("a shop with a fundraiser now is listed even with nothing sold, all zeros", same(fig(shopOf(R, "robo")), [0, 0, 0, 0, 0, 0]));
  ok("a shop whose fundraiser ended is listed when it raised money in the range", !!shopOf(R, "league"));
  ok("a shop without a fundraiser is listed when it paid out to a group in the range", !!shopOf(R, "choir"));
  ok("a shop without a fundraiser whose only payout is before the range is not listed", !shopOf(R, "chess"));
  ok("a shop without a fundraiser that raised nothing is not listed, though it has paid orders", !shopOf(R, "plain"));
  ok("a shop with a damaged fundraiser setup counts as having none", !shopOf(R, "broken"));
  ok("the orders of a shop that isn't listed are not in the per-order rows", !R.orders.some(o => o.orgId === "plain" || o.orgId === "broken"));
  ok("shops are sorted by name", same(R.shops.map(s => s.name), ["Example Band", "Example Choir", "Example Club", "Example League", "Example Robotics"]));
  ok("each shop row has orgId, name, label, mode, orders, pieces, sales, raised, paidOut and owed",
    same(Object.keys(shopOf(R, "club")).sort(), ["label", "mode", "name", "orders", "orgId", "owed", "paidOut", "pieces", "raised", "sales"]));
  ok("a shop's label and mode are its fundraiser's now", shopOf(R, "club").label === "Example Boosters" && shopOf(R, "club").mode === "percent"
    && shopOf(R, "band").label === "Example Band Parents" && shopOf(R, "band").mode === "perPiece");
  ok("a shop with no fundraiser now has label \"\" and mode null", shopOf(R, "league").label === "" && shopOf(R, "league").mode === null
    && shopOf(R, "choir").label === "" && shopOf(R, "choir").mode === null);

  console.log("=== The Fundraising report: what each shop sold and raised ===");
  const club = shopOf(R, "club");
  ok("orders: every paid order sold in the range, including one that raised nothing (3 for Example Club)", club.orders === 3);
  ok("an unpaid order, a voided order and a test order are left out", !R.orders.some(o => ["C3", "C4", "C5"].includes(o.orderId)));
  ok("pieces: the catalog lines' quantities, not custom lines, lines without a product or cancelled lines (5)", club.pieces === 5);
  ok("sales: the goods before tax (backed out when inclusive, as stored when exclusive), less the refunded share, cancelled lines out ($53.00)", club.sales === 53);
  ok("raised: the lines' amounts, less the refunded share, cancelled lines out ($4.00)", club.raised === 4);
  ok("paidOut: only the live payouts dated in the range ($1.00)", club.paidOut === 1);
  ok("owed: all raised up to the end date less all paid out up to it, not just the range ($14.00 − $6.00 = $8.00)", club.owed === 8);
  const band = shopOf(R, "band");
  ok("a line refunded more than its total raises nothing and sells nothing — never below 0", band.raised === 2 && band.sales === 10);
  ok("owed below 0 (paid out more than raised) is shown as it is, not clamped ($2.00 − $10.00)", band.owed === -8);
  ok("a shop with a payout and no orders: no orders, the payout paid out, owed below 0", same(fig(shopOf(R, "choir")), [0, 0, 0, 0, 3, -3]));
  ok("a shop whose fundraiser ended: its order, pieces, sales and raised", same(fig(shopOf(R, "league")), [1, 2, 15, 1.5, 0, 1.5]));
  ok("the totals are the listed shops' figures added up", same(R.totals, { orders: 5, pieces: 12, sales: 78, raised: 7.5, paidOut: 14, owed: -1.5 }));

  console.log("=== The Fundraising report: the per-order rows ===");
  ok("every counted order is a row, the first and last instants of the range included", same(R.orders.map(o => o.orderId).sort(), ["B1", "C1", "C2", "C9", "E1"]));
  ok("a shop's orders are in sale-date order", same(R.orders.filter(o => o.orgId === "club").map(o => o.orderId), ["C1", "C9", "C2"]));
  ok("the rows are in sale-date order across shops, not shop by shop (Club 3/1, Band 3/5, League 3/7, Club 3/12, Club 3/31)",
    same(R.orders.map(o => o.orderId), ["C1", "B1", "E1", "C9", "C2"]));
  { // Two shops only, their sales taking turns.
    const two = await makeDb();
    await lib.setOrgFundraiser(two, "club", { mode: "percent", percent: 10, label: "Example Boosters" });
    await lib.setOrgFundraiser(two, "band", { mode: "perPiece", amount: 1, label: "Example Band Parents" });
    addOrder(two, { id: "T-B2", org: "band", placedAt: "2027-03-01T10:00:00.000Z", shippedAt: "2027-03-04T10:00:00.000Z" }, [{ qty: 1, total: 1000, raise: 100 }]);
    addOrder(two, { id: "T-C1", org: "club", placedAt: "2027-03-01T10:00:00.000Z", shippedAt: "2027-03-02T10:00:00.000Z" }, [{ qty: 1, total: 1000, raise: 100 }]);
    addOrder(two, { id: "T-C3", org: "club", placedAt: "2027-03-01T10:00:00.000Z", shippedAt: "2027-03-06T10:00:00.000Z" }, [{ qty: 1, total: 1000, raise: 100 }]);
    addOrder(two, { id: "T-B4", org: "band", placedAt: "2027-03-01T10:00:00.000Z", shippedAt: "2027-03-08T10:00:00.000Z" }, [{ qty: 1, total: 1000, raise: 100 }]);
    const tr = await lib.getFundraisingReport(two, { dateFrom: "2027-03-01", dateTo: "2027-03-31" });
    ok("two shops whose sales take turns: Example Club, Example Band, Example Club, Example Band, by sale date",
      same(tr.orders.map(o => o.orderId), ["T-C1", "T-B2", "T-C3", "T-B4"]));
  }
  const c2 = R.orders.find(o => o.orderId === "C2");
  ok("each order row has orderId, orgId, placedAt, customerName, pieces, sales and raised",
    same(Object.keys(c2).sort(), ["customerName", "orderId", "orgId", "pieces", "placedAt", "raised", "sales"]));
  ok("an order row carries the order's shop, placedAt and customer's name", c2.orgId === "club" && c2.placedAt === "2027-03-10T10:00:00.000Z" && c2.customerName === "Sam Example");
  ok("an order row's pieces, sales and raised are that order's own (3, $21.00, $2.00)", c2.pieces === 3 && c2.sales === 21 && c2.raised === 2);
  ok("an order that raised nothing is a row with raised 0", same(R.orders.find(o => o.orderId === "C9"), { orderId: "C9", orgId: "club", placedAt: "2027-03-11T10:00:00.000Z", customerName: "Lee Example", pieces: 0, sales: 7, raised: 0 }));
  ok("the order rows add up to the totals", R.orders.reduce((n, o) => n + o.pieces, 0) === R.totals.pieces
    && Math.round(R.orders.reduce((n, o) => n + o.raised * 100, 0)) === Math.round(R.totals.raised * 100));

  console.log("=== The Fundraising report: whole days at both ends ===");
  const one = await lib.getFundraisingReport(d1, { dateFrom: "2027-03-31", dateTo: "2027-03-31" });
  ok("a one-day range counts an order sold at its last millisecond", same(one.orders.map(o => o.orderId), ["C2"]));
  const first = await lib.getFundraisingReport(d1, { dateFrom: "2027-03-01", dateTo: "2027-03-01" });
  ok("a one-day range counts an order sold at its first instant", same(first.orders.map(o => o.orderId), ["C1"]));
  const feb = await lib.getFundraisingReport(d1, { dateFrom: "2027-02-01", dateTo: "2027-02-28" });
  ok("an order completed at the last millisecond of February counts in February (completedAt is a sale date)", same(feb.orders.map(o => o.orderId), ["C7"]));
  ok("in February a payout-only shop with that month's payout is listed", !!shopOf(feb, "chess") && shopOf(feb, "chess").paidOut === 4);
  ok("February's owed for Example Club: $10.00 raised less $5.00 paid out", shopOf(feb, "club").owed === 5 && shopOf(feb, "club").paidOut === 5);
  const apr = await lib.getFundraisingReport(d1, { dateFrom: "2027-04-01", dateTo: "2027-04-30" });
  ok("April's owed counts all raised and paid out up to April 30, before April too ($17.00 − $56.00)", shopOf(apr, "club").owed === -39 && shopOf(apr, "club").raised === 3 && shopOf(apr, "club").paidOut === 50);
  ok("a deleted payout is never counted, as paid out or toward owed", shopOf(R, "club").paidOut === 1 && shopOf(apr, "club").owed === -39);

  console.log("=== The Fundraising report: the sale-date basis ===");
  ok("by default (no accounting setting) the basis is the shipped date: a paid order not yet shipped is not counted", !R.orders.some(o => o.orderId === "C8"));
  const placed = await lib.getFundraisingReport(d1, { dateFrom: "2027-03-01", dateTo: "2027-03-31", basis: "placed" });
  ok("by the placed date, the orders placed in March count, those placed before don't",
    same(placed.orders.filter(o => o.orgId === "club").map(o => o.orderId), ["C2", "C9", "C8", "C6"]));
  ok("by the placed date, owed counts every order placed up to the end date ($2 + $10 + $4 + $3 + $2 − $6)", shopOf(placed, "club").owed === 15);
  await lib.setAccountingSettings(d1, { saleDate: "placed" });
  const viaSetting = await lib.getFundraisingReport(d1, { dateFrom: "2027-03-01", dateTo: "2027-03-31" });
  ok("without a basis given, the shop's accounting setting is used (placed)", same(viaSetting.orders.map(o => o.orderId), placed.orders.map(o => o.orderId)));
  const shippedOverride = await lib.getFundraisingReport(d1, { dateFrom: "2027-03-01", dateTo: "2027-03-31", basis: "shipped" });
  ok("a basis given overrides the setting", same(shippedOverride.orders.map(o => o.orderId), R.orders.map(o => o.orderId)));
  const odd = await lib.getFundraisingReport(d1, { dateFrom: "2027-03-01", dateTo: "2027-03-31", basis: "whenever" });
  ok("an unknown basis is read as the shipped date", same(odd.orders.map(o => o.orderId), R.orders.map(o => o.orderId)));
  await lib.setAccountingSettings(d1, { saleDate: "shipped" });

  console.log("=== The Fundraising report: one shop ===");
  const onlyClub = await lib.getFundraisingReport(d1, { dateFrom: "2027-03-01", dateTo: "2027-03-31", orgId: "club" });
  ok("with orgId, only that shop is listed", same(onlyClub.shops.map(s => s.orgId), ["club"]));
  ok("with orgId, only that shop's orders are rows", onlyClub.orders.length === 3 && onlyClub.orders.every(o => o.orgId === "club"));
  ok("with orgId, the shop's figures are the same as in the full report", same(onlyClub.shops[0], club));
  ok("with orgId, the totals are that shop's", same(fig(onlyClub.totals), fig(club)));
  const onlyPlain = await lib.getFundraisingReport(d1, { dateFrom: "2027-03-01", dateTo: "2027-03-31", orgId: "plain" });
  ok("a shop with no fundraiser and nothing raised or paid out gives an empty report", onlyPlain.shops.length === 0 && onlyPlain.orders.length === 0 && onlyPlain.totals.orders === 0);
  const onlyNone = await lib.getFundraisingReport(d1, { dateFrom: "2027-03-01", dateTo: "2027-03-31", orgId: "no-such-shop" });
  ok("an unknown shop gives an empty report, not an error", !onlyNone.error && onlyNone.shops.length === 0 && same(onlyNone.totals, { orders: 0, pieces: 0, sales: 0, raised: 0, paidOut: 0, owed: 0 }));

  console.log("=== The Fundraising report: dates it refuses ===");
  const FORMAT = "Choose the dates as YYYY-MM-DD.";
  ok("a start date that isn't YYYY-MM-DD is refused", (await lib.getFundraisingReport(d1, { dateFrom: "2027-3-1", dateTo: "2027-03-31" })).error === FORMAT);
  ok("an end date that isn't YYYY-MM-DD is refused", (await lib.getFundraisingReport(d1, { dateFrom: "2027-03-01", dateTo: "2027-03-31T00:00" })).error === FORMAT);
  ok("missing dates are refused", (await lib.getFundraisingReport(d1, {})).error === FORMAT && (await lib.getFundraisingReport(d1)).error === FORMAT);
  ok("an empty date is refused", (await lib.getFundraisingReport(d1, { dateFrom: "", dateTo: "2027-03-31" })).error === FORMAT);
  const rev = await lib.getFundraisingReport(d1, { dateFrom: "2027-04-01", dateTo: "2027-03-31" });
  ok("a start date after the end date is refused", rev.error === "The start date is after the end date." && !rev.shops);

  // =====================================================================================================
  console.log("=== Before migrations/0110 ===");
  const old = await makeDb("0110");
  old.q(`INSERT INTO orders (orderId, orgId, customerName, contact, paid, placedAt, shippedAt) VALUES ('OLD1', 'club', 'Pat Example', 'pat@example.com', 1, '2027-03-02T10:00:00.000Z', '2027-03-05T10:00:00.000Z')`);
  const oldR = await lib.getFundraisingReport(old, { dateFrom: "2027-03-01", dateTo: "2027-03-31" }).catch(e => ({ thrown: e.message }));
  ok("on a database before 0110 the report is empty: no shops, no orders, zero totals, owedAsOf still set",
    same(oldR, { shops: [], orders: [], totals: { orders: 0, pieces: 0, sales: 0, raised: 0, paidOut: 0, owed: 0 }, dateFrom: "2027-03-01", dateTo: "2027-03-31", owedAsOf: "2027-03-31" }));
  ok("on a database before 0110 bad dates are still refused", (await lib.getFundraisingReport(old, { dateFrom: "x", dateTo: "2027-03-31" })).error === FORMAT);
  ok("on a database before 0110 the payouts list is empty", same(await lib.listFundraiserPayouts(old, {}), []));
  const oldAcct = await lib.saveAccount(old, 0, { name: "Example Checking", type: "checking", openingBalance: 0, openingDate: "2027-01-01", active: true });
  ok("on a database before 0110 a payout is refused with the update message",
    (await lib.recordFundraiserPayout(old, { orgId: "club", amount: 5, date: "2027-03-01", accountId: oldAcct })).error === NOT_READY);
  ok("…and no expense is written", old.q("SELECT count(*) AS n FROM expenses")[0].n === 0);
  // A database part-way: the shop's column is there but not the expense's (the report and the payout still answer sensibly).
  const half = await makeDb();
  half._raw.exec("DROP INDEX idx_expenses_fundraiser; ALTER TABLE expenses DROP COLUMN fundraiserOrgId;");
  const halfR = await lib.getFundraisingReport(half, { dateFrom: "2027-03-01", dateTo: "2027-03-31" }).catch(e => ({ thrown: e.message }));
  ok("without expenses.fundraiserOrgId the report is empty, not an error", Array.isArray(halfR.shops) && halfR.shops.length === 0 && !halfR.thrown);
  ok("without expenses.fundraiserOrgId the payouts list is empty", same(await lib.listFundraiserPayouts(half, {}), []));
  await lib.setOrgFundraiser(half, "club", { mode: "percent", percent: 10, label: "Example Boosters" });
  const halfAcct = await lib.saveAccount(half, 0, { name: "Example Checking", type: "checking", openingBalance: 0, openingDate: "2027-01-01", active: true });
  const halfN = half.q("SELECT count(*) AS n FROM expenses")[0].n;
  const halfPay = await lib.recordFundraiserPayout(half, { orgId: "club", amount: 5, date: "2027-03-01", accountId: halfAcct, today: "2027-06-15" }).catch(e => ({ thrown: e.message }));
  ok("without expenses.fundraiserOrgId a payout is refused as not ready ({ error: the update message, notReady: true }), not thrown",
    same(halfPay, { error: NOT_READY, notReady: true }));
  ok("…and no expense is written on that database", half.q("SELECT count(*) AS n FROM expenses")[0].n === halfN);

  // =====================================================================================================
  console.log("=== Recording a payout: what it refuses ===");
  const p = await makeDb();
  await lib.setOrgFundraiser(p, "club", { mode: "percent", percent: 10, label: "Example Boosters" });
  const acct = await lib.saveAccount(p, 0, { name: "Example Checking", type: "checking", openingBalance: 0, openingDate: "2027-01-01", active: true });
  const closed = await lib.saveAccount(p, 0, { name: "Example Old Savings", type: "other", openingBalance: 0, openingDate: "2027-01-01", active: false });
  const base = { orgId: "club", amount: 25, date: "2027-03-15", accountId: acct, today: "2027-06-15" };
  const refuse = async (over) => (await lib.recordFundraiserPayout(p, { ...base, ...over })).error || "";
  const count = () => p.q("SELECT count(*) AS n FROM expenses")[0].n;
  const n0 = count();
  const DATE = "Choose the date it was paid.";
  ok("no date is refused", await refuse({ date: undefined }) === DATE);
  ok("a date that isn't YYYY-MM-DD is refused", await refuse({ date: "03/15/2027" }) === DATE && await refuse({ date: "2027-03-15T00:00:00Z" }) === DATE);
  ok("a date after today is refused", await refuse({ date: "2027-06-16" }) === "The date can't be in the future.");
  const AMT = "The amount must be more than $0 and at most $1,000,000.";
  ok("no amount (missing, null or empty) is refused", await refuse({ amount: undefined }) === AMT && await refuse({ amount: null }) === AMT && await refuse({ amount: "" }) === AMT);
  ok("an amount that isn't a number is refused", await refuse({ amount: "lots" }) === AMT && await refuse({ amount: Infinity }) === AMT);
  ok("an amount of 0 or below is refused", await refuse({ amount: 0 }) === AMT && await refuse({ amount: -5 }) === AMT);
  ok("an amount over $1,000,000 is refused", await refuse({ amount: 1000000.01 }) === AMT);
  ok("an amount with part of a cent is refused", await refuse({ amount: 10.005 }) === "The amount must be in whole cents.");
  ok("a note over 200 characters is refused", await refuse({ note: "x".repeat(201) }) === "The note can be at most 200 characters.");
  ok("a shop that doesn't exist is refused", await refuse({ orgId: "no-such-shop" }) === "That shop wasn't found.");
  ok("no shop is refused", await refuse({ orgId: undefined }) === "That shop wasn't found." && await refuse({ orgId: null }) === "That shop wasn't found.");
  const ACCT = "Choose the account it was paid from.";
  ok("no account is refused (there's no paid-personally payout)", await refuse({ accountId: undefined }) === ACCT && await refuse({ accountId: 0 }) === ACCT);
  ok("an account that doesn't exist is refused", await refuse({ accountId: 99999 }) === ACCT);
  ok("an inactive account is refused", await refuse({ accountId: closed }) === ACCT);
  ok("the date is checked first, then the amount", await refuse({ date: "nope", amount: -1 }) === DATE && await refuse({ amount: -1, orgId: "no-such-shop" }) === AMT);
  ok("nothing refused wrote an expense", count() === n0);
  p.q("UPDATE expense_categories SET systemKey = NULL WHERE systemKey = 'fundraiser_payout'");
  ok("without the built-in category a payout is refused with the update message", await refuse({}) === NOT_READY && count() === n0);
  p.q("UPDATE expense_categories SET systemKey = 'fundraiser_payout' WHERE name = 'Fundraiser payouts'");

  console.log("=== Recording a payout: the boundaries it accepts ===");
  ok("exactly $1,000,000 is accepted", Number.isInteger((await lib.recordFundraiserPayout(p, { ...base, amount: 1000000 })).id));
  ok("a note of exactly 200 characters (after trimming) is accepted", Number.isInteger((await lib.recordFundraiserPayout(p, { ...base, note: "  " + "n".repeat(200) + "  " })).id));
  ok("a date of today is accepted", Number.isInteger((await lib.recordFundraiserPayout(p, { ...base, date: "2027-06-15" })).id));
  ok("an amount given as text is accepted", Number.isInteger((await lib.recordFundraiserPayout(p, { ...base, amount: "12.50" })).id));
  at("2027-06-16T00:30:00.000Z");   // the 15th in this machine's (pinned) zone, the 16th in UTC
  const noToday = { orgId: "club", amount: 1, accountId: acct };
  ok("without `today`, today is the UTC day: the UTC date is accepted though it's still yesterday here", Number.isInteger((await lib.recordFundraiserPayout(p, { ...noToday, date: "2027-06-16" })).id));
  ok("without `today`, the day after the UTC day is refused", (await lib.recordFundraiserPayout(p, { ...noToday, date: "2027-06-17" })).error === "The date can't be in the future.");
  ok("a `today` that isn't YYYY-MM-DD is ignored for the UTC day", (await lib.recordFundraiserPayout(p, { ...noToday, date: "2027-06-17", today: "soon" })).error === "The date can't be in the future.");
  at("2027-06-15T12:00:00.000Z");

  console.log("=== Recording a payout: the expense it writes ===");
  const fresh = await makeDb();
  await lib.setOrgFundraiser(fresh, "club", { mode: "percent", percent: 10, label: "Example Boosters" });
  const fAcct = await lib.saveAccount(fresh, 0, { name: "Example Checking", type: "checking", openingBalance: 0, openingDate: "2027-01-01", active: true });
  const fAcct2 = await lib.saveAccount(fresh, 0, { name: "Example Cash Box", type: "cash", openingBalance: 0, openingDate: "2027-01-01", active: true });
  const cat = fresh.q("SELECT id, name, scheduleCLine, deductionType, deductiblePct FROM expense_categories WHERE systemKey = 'fundraiser_payout'")[0];
  const r1 = await lib.recordFundraiserPayout(fresh, { orgId: "club", amount: 40.25, date: "2027-03-15", accountId: fAcct, note: "  Check 1001  ", actor: "test", today: "2027-06-15" });
  ok("a payout answers with the new expense's id", same(Object.keys(r1), ["id"]) && Number.isInteger(r1.id) && r1.id > 0);
  const row = fresh.q("SELECT * FROM expenses WHERE id = ?", r1.id)[0];
  ok("it is an expense in the built-in category (systemKey fundraiser_payout)", row.categoryId === cat.id && lib.FUNDRAISER_PAYOUT_KEY === "fundraiser_payout");
  ok("it is tied to the shop (fundraiserOrgId)", row.fundraiserOrgId === "club");
  ok("its date and amount (in cents) are as given", row.expenseDate === "2027-03-15" && row.amountCents === 4025);
  ok("its description names the group the fundraiser supports, then the note, trimmed", row.description === "Fundraiser payout — Example Boosters — Check 1001");
  ok("its vendor is the group the fundraiser supports", row.vendor === "Example Boosters");
  ok("it was paid from the account given, not personally", row.accountId === fAcct && row.paidPersonally === 0);
  ok("it is fully business use and marked as charged no use tax", row.businessUsePct === 100 && row.vendorChargedTax === 1);
  ok("it isn't deleted, a refund or from a recurring rule", row.deletedAt === null && row.refundOfId === null && row.recurringId === null);
  const r2 = await lib.recordFundraiserPayout(fresh, { orgId: "club", amount: 10, date: "2027-03-20", accountId: fAcct2, today: "2027-06-15" });
  ok("without a note, the description is the group's name alone", fresh.q("SELECT description FROM expenses WHERE id = ?", r2.id)[0].description === "Fundraiser payout — Example Boosters");
  const r2b = await lib.recordFundraiserPayout(fresh, { orgId: "club", amount: 10, date: "2027-03-20", accountId: fAcct2, note: "   ", today: "2027-06-15" });
  ok("a note of spaces only counts as no note", fresh.q("SELECT description FROM expenses WHERE id = ?", r2b.id)[0].description === "Fundraiser payout — Example Boosters");
  const r3 = await lib.recordFundraiserPayout(fresh, { orgId: "choir", amount: 3, date: "2027-04-02", accountId: fAcct, note: "Spring", today: "2027-06-15" });
  const row3 = fresh.q("SELECT * FROM expenses WHERE id = ?", r3.id)[0];
  ok("for a shop without a fundraiser (one since ended), the description and vendor use the shop's name",
    row3.description === "Fundraiser payout — Example Choir — Spring" && row3.vendor === "Example Choir" && row3.fundraiserOrgId === "choir");
  await lib.setOrgFundraiser(fresh, "club", null);
  const r4 = await lib.recordFundraiserPayout(fresh, { orgId: "club", amount: 2, date: "2027-04-03", accountId: fAcct, today: "2027-06-15" });
  ok("once a shop's fundraiser is ended, its next payout names the shop", fresh.q("SELECT vendor FROM expenses WHERE id = ?", r4.id)[0].vendor === "Example Club");
  ok("an earlier payout keeps the group's name it was written with", fresh.q("SELECT vendor FROM expenses WHERE id = ?", r1.id)[0].vendor === "Example Boosters");
  await lib.setOrgFundraiser(fresh, "club", { mode: "percent", percent: 10, label: "Example Boosters" });

  console.log("=== A payout shows wherever expenses show ===");
  const listed = (await lib.listExpenses(fresh, "2027-03-01", "2027-03-31")).find(x => x.id === r1.id);
  ok("it is in the Expenses list for its date", !!listed);
  ok("…in the built-in category, by name, with that category's Schedule C line (Other expenses, 27a)",
    listed.category === cat.name && cat.name === "Fundraiser payouts" && listed.scheduleCLine === "27a" && listed.categoryId === cat.id);
  ok("…fully deductible, as the category says", listed.deductible === 40.25 && listed.deductionType === "deductible" && listed.deductiblePct === 100);
  ok("…with its amount, account and shop", listed.amount === 40.25 && listed.accountId === fAcct && listed.paidPersonally === false && listed.fundraiserOrgId === "club");
  const ex = await lib.getAccountantExport(fresh, "2027-03-01T00:00:00.000Z", "2027-03-31T23:59:59.999Z");
  const exRow = ex.expenses.find(x => x.description === "Fundraiser payout — Example Boosters — Check 1001");
  ok("it is in the accountant export's expenses", !!exRow);
  ok("…as an expense in its category, on Schedule C line 27a (Other expenses)",
    exRow.type === "Expense" && exRow.category === "Fundraiser payouts" && exRow.scheduleCLine === "27a" && exRow.scheduleCLabel === "Other expenses");
  ok("…paid from its account, by name, not deleted", exRow.paidFrom === "Example Checking" && exRow.status === "" && exRow.amount === 40.25 && exRow.date === "2027-03-15");
  ok("…and it counts in the month's deductible expenses (the two March payouts, $40.25 + $10 + $10)",
    (ex.summary.find(m => m.month === "2027-03") || {}).expensesDeductible === 60.25);

  console.log("=== A deleted payout ===");
  const repR = await lib.getFundraisingReport(fresh, { dateFrom: "2027-03-01", dateTo: "2027-03-31" });
  ok("the report counts the payouts as paid out ($60.25) and against owed", shopOf(repR, "club").paidOut === 60.25 && shopOf(repR, "club").owed === -60.25);
  await lib.deleteExpense(fresh, r2.id);
  const repR2 = await lib.getFundraisingReport(fresh, { dateFrom: "2027-03-01", dateTo: "2027-03-31" });
  ok("a deleted payout drops out of the report's paid out and owed", shopOf(repR2, "club").paidOut === 50.25 && shopOf(repR2, "club").owed === -50.25);
  const afterDelete = await lib.listFundraiserPayouts(fresh, {});
  ok("a deleted payout drops out of the payouts list", afterDelete.length === 4 && !afterDelete.some(x => x.id === r2.id));
  ok("a deleted payout drops out of the Expenses list", !(await lib.listExpenses(fresh, "2027-03-01", "2027-03-31")).some(x => x.id === r2.id));
  const ex2 = await lib.getAccountantExport(fresh, "2027-03-01T00:00:00.000Z", "2027-03-31T23:59:59.999Z");
  ok("a deleted payout stays in the accountant export, marked deleted, and isn't counted in the month",
    ex2.expenses.filter(x => x.status === "deleted").length === 1 && ex2.summary.find(m => m.month === "2027-03").expensesDeductible === 50.25);

  // =====================================================================================================
  console.log("=== The list of payouts ===");
  fresh.q(`INSERT INTO expenses (expenseDate, description, categoryId, amountCents, createdAt, updatedAt) VALUES ('2027-03-18', 'Thread', 1, 900, 't', 't')`);
  const r5 = await lib.recordFundraiserPayout(fresh, { orgId: "club", amount: 7, date: "2027-03-15", accountId: fAcct2, today: "2027-06-15" });
  const all = await lib.listFundraiserPayouts(fresh, {});
  ok("it answers a list", Array.isArray(all));
  ok("it lists the live payouts only — not ordinary expenses, not deleted payouts",
    same(all.map(x => x.id).sort((a, b) => a - b), [r1.id, r2b.id, r3.id, r4.id, r5.id].sort((a, b) => a - b)));
  ok("newest first, and the later-recorded first on the same day", same(all.map(x => x.id), [r4.id, r3.id, r2b.id, r5.id, r1.id]));
  const l1 = all.find(x => x.id === r1.id);
  ok("each payout has the expense's fields", l1.date === "2027-03-15" && l1.amount === 40.25 && l1.description === "Fundraiser payout — Example Boosters — Check 1001"
    && l1.category === "Fundraiser payouts" && l1.vendor === "Example Boosters" && l1.accountId === fAcct && l1.deletedAt === "");
  ok("each payout names its shop (orgId, orgName) and its account (accountName)", l1.orgId === "club" && l1.orgName === "Example Club" && l1.accountName === "Example Checking"
    && all.find(x => x.id === r5.id).accountName === "Example Cash Box" && all.find(x => x.id === r3.id).orgName === "Example Choir");
  ok("there is no separate note field: the note is inside the description", !("note" in l1));
  ok("listing with no filters given at all works the same", same((await lib.listFundraiserPayouts(fresh)).map(x => x.id), all.map(x => x.id)));
  ok("filtered by shop", same((await lib.listFundraiserPayouts(fresh, { orgId: "choir" })).map(x => x.id), [r3.id]));
  ok("filtered from a date, inclusive", same((await lib.listFundraiserPayouts(fresh, { dateFrom: "2027-04-02" })).map(x => x.id), [r4.id, r3.id]));
  ok("filtered to a date, inclusive", same((await lib.listFundraiserPayouts(fresh, { dateTo: "2027-03-15" })).map(x => x.id), [r5.id, r1.id]));
  ok("filtered by shop and range together", same((await lib.listFundraiserPayouts(fresh, { orgId: "club", dateFrom: "2027-03-16", dateTo: "2027-04-30" })).map(x => x.id), [r4.id, r2b.id]));
  ok("a date that isn't YYYY-MM-DD is not used as a filter", same((await lib.listFundraiserPayouts(fresh, { dateFrom: "March", dateTo: "later" })).map(x => x.id), all.map(x => x.id)));
  ok("an unknown shop lists nothing", same(await lib.listFundraiserPayouts(fresh, { orgId: "no-such-shop" }), []));
  fresh.q(`INSERT INTO expenses (expenseDate, description, categoryId, amountCents, createdAt, updatedAt, fundraiserOrgId)
    VALUES ('2027-05-01', 'Fundraiser payout', (SELECT id FROM expense_categories WHERE systemKey = 'fundraiser_payout'), 100, 't', 't', 'robo')`);
  const noAcct = (await lib.listFundraiserPayouts(fresh, { orgId: "robo" }))[0];
  ok("a payout with no account recorded lists an empty account name", !!noAcct && noAcct.accountName === "" && noAcct.accountId === null && noAcct.orgName === "Example Robotics");
})().catch(e => { console.error(e); process.exit(1); });
