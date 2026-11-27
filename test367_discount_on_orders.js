// Discount codes on orders (migrations/0115), db.js called directly:
//   insertOrder's order.discount   written in the order's own insert, stored exactly as setOrderDiscount would store
//                                  the same discount on the same order (discountCents, discountNote, discountTaxCents,
//                                  the lines' tax, the rush fee's tax, the stored totals) — prices including tax and
//                                  tax added on top, taxable and untaxed lines, shipping, a rush fee, an exempt shop,
//                                  shipping out of state, a percent and an amount; what it answers (discount, salesTax,
//                                  total = what's owed); a discount above the goods held to the goods; none / 0 / junk
//   a 100% code                    owes $0 (or only the shipping), and refreshPaidStatus with nothing owed
//   the order readers              discountCode on getOrderById, getOrdersByOrg, getOpenOrders, getOrdersByIds only for
//                                  a use that counts (not a released one, not a manual discount); parseOrder_'s ""
//   voidOrder / deleteOrder        give the use back (releasedAt, the code usable again) and name the code
//   the reports                    Revenue (getRevenueData), Sales tax (getSalesTaxReport, getSalesTaxReturn) and
//                                  Fundraising (getFundraisingReport) the same for a code's discount as a manual one
//   a database before 0115         the readers, voidOrder and deleteOrder still work and name no code
// Real SQL (sql.js) + the real db.js, db.js's clock fixed here. Invented shops, people and codes only.
process.env.TZ = "America/Los_Angeles";
const fs = require("fs");
const { ok } = require("./testlib/check");
const { createD1 } = require("./testlib/d1-shim.js");

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");

let NOW = Date.parse("2027-03-15T12:00:00.000Z");
const RealDate = Date;
class FakeDate extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(NOW); }
  static now() { return NOW; }
}

const lib = new Function("Date", strip(read("functions/_lib/db.js")) +
  "\nreturn { insertOrder, setOrderDiscount, getOrderById, getOrdersByOrg, getOpenOrders, getOrdersByIds, parseOrder_, refreshPaidStatus," +
  " addOrderPayment, voidOrder, deleteOrder, saveDiscountCode, claimDiscountCode, getDiscountCode, checkDiscountCode, discountForCode_," +
  " getRevenueData, getSalesTaxReport, getSalesTaxReturn, getFundraisingReport, setOrgFundraiser, cancelLineItem };")(FakeDate);

const MIGRATIONS = fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort();
async function makeDb(before) {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of MIGRATIONS) if (!before || f < before) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES
      ('club','club','Example Club','t','t'), ('band','band','Example Band','t','t');
    INSERT INTO products (productId, orgId, type, name, pricingMode, flatPriceCents, createdAt, updatedAt, taxable) VALUES
      ('tee','club','shirt','Club Tee','flat',2000,'t','t',1), ('cap','club','cap','Club Cap','flat',1500,'t','t',0),
      ('tee','band','shirt','Band Tee','flat',2000,'t','t',1), ('cap','band','cap','Band Cap','flat',1500,'t','t',0);`);
  return d1;
}
const setTax = (d1, rateBps, taxMode, jurisdiction = "") =>
  d1._raw.run("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('salesTax', ?)", [JSON.stringify({ rateBps, taxShipping: false, jurisdiction, taxMode })]);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const one = (d1, sql, ...p) => d1.q(sql, ...p)[0] || null;

// The cart every case uses unless it says otherwise: 3 taxed tees ($60), a taxed tee with $5 personalization ($25)
// and 2 untaxed caps ($30) — $115.00 of goods, $85.00 of it taxed.
const TEE3 = { productId: "tee", name: "Club Tee", type: "shirt", size: "M", qty: 3, unitPrice: 20 };
const TEE_PERS = { productId: "tee", name: "Club Tee", type: "shirt", size: "L", qty: 1, unitPrice: 20, personalizationFee: 5, personalized: true, persName: "Example" };
const CAP2 = { productId: "cap", name: "Club Cap", type: "cap", size: "", qty: 2, unitPrice: 15 };
const CART = [TEE3, TEE_PERS, CAP2];
const order = (orderId, extra = {}) => ({ orderId, orgId: "club", customerName: "Pat Example", contact: "pat@example.com", paymentMethod: "Check",
  shippingCost: 8, shippingMethod: "USPS", placedAt: "2027-03-10T18:00:00.000Z", ...extra });
const RUSH = { rushRequested: true, rushFee: 12, rushFeeTaxable: true };

// What an order stores and reads back that a discount touches.
async function stored(d1, id) {
  const row = one(d1, `SELECT discountCents, discountNote, discountTaxCents, rushFeeCents, rushFeeTaxCents, subtotalCents, totalCents, taxMode, taxRateBps, taxExempt
                         FROM orders WHERE orderId = ?`, id);
  const lines = d1.q("SELECT taxRateBps, taxCents, taxable, lineTotalCents FROM order_items WHERE orderId = ? ORDER BY id", id);
  const o = await lib.getOrderById(d1, id);
  return { row, lines, read: { discountAmount: o.discountAmount, discountNote: o.discountNote, discountTax: o.discountTax, salesTax: o.salesTax,
    netSales: o.netSales, effectiveTotal: o.effectiveTotal, balanceDue: o.balanceDue, rushFeeTax: o.rushFeeTax } };
}
// Inserts the order twice — with order.discount, and without it then setOrderDiscount the same amount — and gives
// both as stored, plus what insertOrder answered for the code's order.
let pairN = 0;
async function pair(d1, extra, items, cents, note = "Code SAVE10") {
  const n = ++pairN, codeId = "CODE-" + n, manId = "MAN-" + n;
  const answer = await lib.insertOrder(d1, order(codeId, { ...extra, discount: { cents, note } }), items, {});
  await lib.insertOrder(d1, order(manId, extra), items, {});
  await lib.setOrderDiscount(d1, manId, cents / 100, note);
  return { answer, code: await stored(d1, codeId), manual: await stored(d1, manId), codeId, manId };
}

(async () => {
  let d1 = await makeDb(), p;

  console.log("\n=== Prices include tax (10%) ===");
  setTax(d1, 1000, "inclusive");
  p = await pair(d1, RUSH, CART, 1150);
  ok("a 10% code on $115.00 of goods ($11.50) is stored as $11.50 with the note \"Code SAVE10\", in the order's own insert",
    p.code.row.discountCents === 1150 && p.code.row.discountNote === "Code SAVE10");
  ok("…its tax share is the tax inside the taxed part of it ($11.50 × 85/115 = $8.50 → $0.77), as recomputeOrderTax_ works it out",
    p.code.row.discountTaxCents === 77);
  ok("…every column a discount touches is what setOrderDiscount stores for the same order (discount, note, its tax, the lines' and rush fee's tax, the totals)",
    same(p.code.row, p.manual.row) && same(p.code.lines, p.manual.lines));
  ok("…and the order reads back the same as the manual one (discount, tax, net sales, total, balance)", same(p.code.read, p.manual.read));
  ok("insertOrder answers discount $11.50, sales tax $8.04 (lines $7.72 − $0.77 + the rush fee's $1.09) and total $123.50 owed ($115 + $8 + $12 − $11.50)",
    p.answer.discount === 11.5 && p.answer.salesTax === 8.04 && p.answer.total === 123.5 && p.answer.taxMode === "inclusive" && p.answer.subtotal === 115 && p.answer.shippingCost === 8);
  ok("…the total it answers is what getOrderById says is owed and due", p.answer.total === p.code.read.effectiveTotal && p.answer.total === p.code.read.balanceDue);
  ok("…the stored totalCents is still the total before any discount ($135.00), as for a manual discount", p.code.row.totalCents === 13500);

  p = await pair(d1, {}, CART, 2500, "Code TAKE25");
  ok("an amount code ($25 off, no rush fee) is stored as setOrderDiscount stores it", same(p.code.row, p.manual.row) && same(p.code.lines, p.manual.lines) && same(p.code.read, p.manual.read));
  ok("…and owes $98.00 ($115 + $8 − $25)", p.answer.total === 98 && p.answer.discount === 25 && p.code.row.discountNote === "Code TAKE25");

  p = await pair(d1, RUSH, [CAP2], 300);
  ok("a code on untaxed goods only takes no tax off (discountTaxCents 0), as setOrderDiscount", p.code.row.discountTaxCents === 0 && same(p.code.row, p.manual.row) && same(p.code.read, p.manual.read));
  ok("…owes $47.00 ($30 + $8 + $12 − $3)", p.answer.total === 47);

  p = await pair(d1, {}, [TEE3], 600);
  ok("a code on taxed goods only takes the tax inside all of it ($6.00 → $0.55)", p.code.row.discountTaxCents === 55 && same(p.code.row, p.manual.row) && same(p.code.read, p.manual.read));

  console.log("\n=== Tax added on top (10%) ===");
  setTax(d1, 1000, "exclusive");
  p = await pair(d1, RUSH, CART, 1150);
  ok("the same 10% code with tax on top: the taxed part's tax ($8.50 × 10% = $0.85) is its tax share", p.code.row.discountTaxCents === 85 && p.code.row.taxMode === "exclusive");
  ok("…every column is what setOrderDiscount stores for the same order", same(p.code.row, p.manual.row) && same(p.code.lines, p.manual.lines));
  ok("…and it reads back the same", same(p.code.read, p.manual.read));
  ok("insertOrder answers sales tax $8.85 ($8.50 − $0.85 + the rush fee's $1.20) and total $132.35 owed ($115 + $8 + $12 − $11.50 + $8.85)",
    p.answer.discount === 11.5 && p.answer.salesTax === 8.85 && p.answer.total === 132.35 && p.answer.taxMode === "exclusive");
  ok("…the total it answers is what getOrderById says is owed", p.answer.total === p.code.read.effectiveTotal && p.answer.total === p.code.read.balanceDue);
  ok("…the stored totalCents is the total before the discount, tax on top included ($144.70)", p.code.row.totalCents === 14470);

  p = await pair(d1, {}, [CAP2, TEE_PERS], 333, "Code ODD");
  ok("an odd amount on a mixed cart with tax on top is stored as setOrderDiscount stores it", same(p.code.row, p.manual.row) && same(p.code.lines, p.manual.lines) && same(p.code.read, p.manual.read));

  console.log("\n=== No tax taken: an exempt shop, shipping out of state ===");
  d1._raw.exec("UPDATE orgs SET taxExempt = 1 WHERE orgId = 'club'");
  p = await pair(d1, RUSH, CART, 1150);
  ok("in a tax-exempt shop the code's discount carries no tax, as setOrderDiscount", p.code.row.taxExempt === 1 && p.code.row.discountTaxCents === 0 && same(p.code.row, p.manual.row) && same(p.code.read, p.manual.read));
  d1._raw.exec("UPDATE orgs SET taxExempt = 0 WHERE orgId = 'club'");
  setTax(d1, 1000, "exclusive", "WA");
  p = await pair(d1, { shippingAddress: { name: "Pat Example", line1: "1 Example St", city: "Exampleton", state: "OR", zip: "" } }, CART, 1150);
  ok("shipped out of the home state: no tax on the lines or the discount, as setOrderDiscount", p.code.row.discountTaxCents === 0 && p.code.lines.every(l => l.taxCents === 0) && same(p.code.row, p.manual.row) && same(p.code.read, p.manual.read));
  setTax(d1, 1000, "exclusive");

  console.log("\n=== What insertOrder does with odd discounts ===");
  let r = await lib.insertOrder(d1, order("BIG-1", { discount: { cents: 50000, note: "Code BIG" } }), [TEE3], {});
  let row = one(d1, "SELECT discountCents, discountTaxCents FROM orders WHERE orderId = 'BIG-1'");
  ok("a discount above the goods is held to the goods ($60.00), and its tax share is all the goods' tax ($6.00)", row.discountCents === 6000 && row.discountTaxCents === 600);
  ok("…what's owed is just the shipping ($8.00)", r.discount === 60 && r.total === 8 && r.salesTax === 0);
  r = await lib.insertOrder(d1, order("RND-1", { discount: { cents: 99.6, note: "Code RND" } }), [TEE3], {});
  ok("a discount in fractions of a cent is rounded to the cent ($1.00)", one(d1, "SELECT discountCents FROM orders WHERE orderId = 'RND-1'").discountCents === 100 && r.discount === 1);
  const LONG = "x".repeat(400);
  await lib.insertOrder(d1, order("LONG-1", { discount: { cents: 100, note: LONG } }), [TEE3], {});
  await lib.insertOrder(d1, order("NONOTE-1", { discount: { cents: 100 } }), [TEE3], {});
  ok("the note is kept to 300 characters, and a missing note is stored as \"\"",
    one(d1, "SELECT discountNote FROM orders WHERE orderId = 'LONG-1'").discountNote.length === 300 && one(d1, "SELECT discountNote FROM orders WHERE orderId = 'NONOTE-1'").discountNote === "");
  for (const [id, discount] of [["NONE-1", undefined], ["ZERO-1", { cents: 0, note: "Code ZERO" }], ["NEG-1", { cents: -500, note: "Code NEG" }], ["JUNK-1", { cents: "lots", note: "Code JUNK" }]]) {
    r = await lib.insertOrder(d1, order(id, discount ? { discount } : {}), [TEE3], {});
    row = one(d1, "SELECT discountCents, discountNote, discountTaxCents, totalCents FROM orders WHERE orderId = ?", id);
    // A code that took nothing off the goods (a free-shipping code) was still used: its note stays, as applying it later writes it.
    ok(`no discount (${discount ? JSON.stringify(discount.cents) : "none given"}) stores none and answers discount 0 and the full total ($74.00)${discount ? ", keeping the code's note" : ""}`,
      row.discountCents === 0 && row.discountNote === (discount ? discount.note : "") && row.discountTaxCents === 0 && r.discount === 0 && r.total === 74 && row.totalCents === 7400);
  }

  console.log("\n=== A 100% code ===");
  for (const mode of ["inclusive", "exclusive"]) {
    setTax(d1, 1000, mode);
    const id = "FREE-" + mode;
    r = await lib.insertOrder(d1, order(id, { shippingCost: 0, shippingMethod: "Pickup", discount: { cents: lib.discountForCode_({ kind: "percent", percentBps: 10000 }, 11500), note: "Code FREE" } }), CART, {});
    const o = await lib.getOrderById(d1, id);
    ok(`${mode}: a 100% code picked up owes $0 — insertOrder answers total 0 and the order reads effectiveTotal and balance $0`,
      r.total === 0 && r.discount === 115 && r.salesTax === 0 && o.effectiveTotal === 0 && o.balanceDue === 0);
    const st = await lib.refreshPaidStatus(d1, id);
    ok(`${mode}: …refreshPaidStatus says nothing is owed and leaves it unpaid until someone marks it (owed 0, paid false)`,
      st.owedCents === 0 && st.paid === false && st.paidForWork === false && one(d1, "SELECT paid FROM orders WHERE orderId = ?", id).paid === 0);
    d1.q("UPDATE orders SET paid = 1, paidForWork = 0 WHERE orderId = ?", id);
    const st2 = await lib.refreshPaidStatus(d1, id);
    ok(`${mode}: …marked paid, it stays paid with no payment, and paid for the work follows it`,
      st2.paid === true && st2.paidForWork === true && one(d1, "SELECT paid, paidForWork FROM orders WHERE orderId = ?", id).paidForWork === 1);
  }
  // Two $10.01 lines at 8.25% on top: each line's tax rounds up ($0.83 + $0.83 = $1.66) while the tax on $20.02 as one
  // amount rounds down ($1.65) — a 100% discount's tax share must be the lines' $1.66, or a cent of tax is owed on nothing.
  setTax(d1, 825, "exclusive");
  const ODD = [{ productId: "tee", name: "Club Tee", type: "shirt", size: "M", qty: 1, unitPrice: 10.01 }, { productId: "tee", name: "Club Tee", type: "shirt", size: "L", qty: 1, unitPrice: 10.01 }];
  for (const mode of ["exclusive", "inclusive"]) {
    setTax(d1, 825, mode);
    p = await pair(d1, { shippingCost: 0, shippingMethod: "Pickup" }, ODD, 2002, "Code FREE");
    ok(`${mode}, lines whose tax rounds apart: a 100% code takes all the lines' tax off with it (${mode === "exclusive" ? "$1.66" : "$1.52"}) and owes $0`,
      p.code.row.discountTaxCents === p.code.lines.reduce((s, l) => s + l.taxCents, 0) && p.code.row.discountTaxCents === (mode === "exclusive" ? 166 : 152) &&
      p.answer.total === 0 && p.answer.salesTax === 0 && p.code.read.effectiveTotal === 0 && p.code.read.salesTax === 0);
    ok(`${mode}: …and the same discount typed by hand stores the same and owes $0 too`, same(p.code.row, p.manual.row) && same(p.code.read, p.manual.read) && p.manual.read.balanceDue === 0);
  }
  // A cancelled line is no longer goods: the whole of what's left taken off takes only the lines still on the order's tax.
  setTax(d1, 1000, "exclusive");
  await lib.insertOrder(d1, order("CXL-1"), [TEE3, TEE_PERS], {});
  const cxlLines = d1.q("SELECT id, taxCents FROM order_items WHERE orderId = 'CXL-1' ORDER BY id");
  await lib.cancelLineItem(d1, cxlLines[1].id);
  await lib.setOrderDiscount(d1, "CXL-1", 60, "Code FREE");
  const cxl = await lib.getOrderById(d1, "CXL-1");
  ok("a line cancelled, then all the rest ($60.00) taken off: the discount's tax is the $6.00 on the lines left, not the cancelled line's $2.50 too",
    cxlLines[0].taxCents === 600 && cxlLines[1].taxCents === 250 && one(d1, "SELECT discountTaxCents FROM orders WHERE orderId = 'CXL-1'").discountTaxCents === 600 &&
    cxl.discountAmount === 60 && cxl.salesTax === 0 && cxl.balanceDue === 8);
  setTax(d1, 1000, "exclusive");
  r = await lib.insertOrder(d1, order("FREE-SHIP", { discount: { cents: 11500, note: "Code FREE" } }), CART, {});
  ok("a 100% code on a shipped order still owes the shipping ($8.00)", r.total === 8);
  let st = await lib.refreshPaidStatus(d1, "FREE-SHIP");
  ok("…refreshPaidStatus: $8.00 owed, not paid", st.owedCents === 800 && st.paid === false);
  await lib.addOrderPayment(d1, "FREE-SHIP", 8, "Check");
  st = await lib.refreshPaidStatus(d1, "FREE-SHIP");
  ok("…a payment of the $8.00 makes it paid", st.paid === true && one(d1, "SELECT paid FROM orders WHERE orderId = 'FREE-SHIP'").paid === 1);

  console.log("\n=== Which orders say a code ===");
  d1 = await makeDb();
  setTax(d1, 1000, "inclusive");
  const mk = await lib.saveDiscountCode(d1, { code: "SAVE10", kind: "percent", percent: 10, maxUses: 5 }, { actor: "test", now: "2027-03-01T00:00:00.000Z" });
  const mk2 = await lib.saveDiscountCode(d1, { code: "ONLYPAT", kind: "amount", amount: 5, email: "pat@example.com" }, { actor: "test", now: "2027-03-01T00:00:00.000Z" });
  ok("two codes are made: SAVE10 (10%, 5 uses) and ONLYPAT ($5, Pat's alone)", !!(mk.code && mk.code.code === "SAVE10" && mk2.code && mk2.code.email === "pat@example.com"));
  const save10 = mk.code.id, onlyPat = mk2.code.id;
  const place = async (id, codeId, cents, note, extra = {}) => {
    if (codeId) {
      const c = await lib.claimDiscountCode(d1, { codeId, orderId: id, email: "pat@example.com", amountCents: cents, now: "2027-03-10T18:00:00.000Z" });
      if (!c.ok) throw new Error("claim refused for " + id);
    }
    return lib.insertOrder(d1, order(id, { ...(cents ? { discount: { cents, note } } : {}), ...extra }), CART, {});
  };
  await place("R-CODE", save10, 1150, "Code SAVE10");
  await place("R-PAT", onlyPat, 500, "Code ONLYPAT");
  await place("R-GONE", save10, 1150, "Code SAVE10");
  d1.q("UPDATE discount_code_uses SET releasedAt = '2027-03-11T00:00:00.000Z' WHERE orderId = 'R-GONE'");
  await place("R-MAN", null, 0);
  await lib.setOrderDiscount(d1, "R-MAN", 5, "Thanks");
  await place("R-PLAIN", null, 0);
  const want = { "R-CODE": "SAVE10", "R-PAT": "ONLYPAT", "R-GONE": "", "R-MAN": "", "R-PLAIN": "" };
  const codesOf = (list) => Object.fromEntries(list.filter(o => o.orderId in want).map(o => [o.orderId, o.discountCode]).sort());
  const wantSorted = Object.fromEntries(Object.entries(want).sort());
  const byId = {};
  for (const id of Object.keys(want)) byId[id] = (await lib.getOrderById(d1, id)).discountCode;
  ok("getOrderById names the code only for a use that counts (SAVE10, ONLYPAT); \"\" for a released use, a manual discount and none",
    same(Object.fromEntries(Object.entries(byId).sort()), wantSorted));
  ok("…a manual discount stays a discount without a code ($5.00, \"Thanks\")", (await lib.getOrderById(d1, "R-MAN")).discountAmount === 5 && (await lib.getOrderById(d1, "R-MAN")).discountNote === "Thanks");
  ok("the Orders page's list (getOrdersByOrg) gives each order the same discountCode", same(codesOf(await lib.getOrdersByOrg(d1, "club")), wantSorted));
  ok("…and the shops-together list (getOrdersByOrg with a list of shops)", same(codesOf(await lib.getOrdersByOrg(d1, ["club", "band"])), wantSorted));
  ok("…the open orders (getOpenOrders)", same(codesOf(await lib.getOpenOrders(d1)), wantSorted));
  ok("…and the orders an action redraws (getOrdersByIds)", same(codesOf(await lib.getOrdersByIds(d1, Object.keys(want))), wantSorted));
  ok("parseOrder_ alone gives discountCode \"\" (the loaders fill it in)",
    lib.parseOrder_({ orderId: "P", orgId: "club", discountCents: 100, totalCents: 0 }, [], [], []).discountCode === "");
  ok("getDiscountCode counts SAVE10's live use only (1 of 5)", (await lib.getDiscountCode(d1, save10, "2027-03-15")).used === 1);

  console.log("\n=== A void or a delete gives the use back ===");
  r = await lib.voidOrder(d1, "R-CODE", "Never paid");
  ok("voidOrder of an order that used SAVE10 answers { discountCode: \"SAVE10\" }", same(r, { discountCode: "SAVE10" }));
  let use = one(d1, "SELECT releasedAt FROM discount_code_uses WHERE orderId = 'R-CODE'");
  ok("…its use is kept, marked released at the time of the void", !!use && use.releasedAt === "2027-03-15T12:00:00.000Z");
  ok("…the order no longer names the code, and SAVE10 is back to 0 uses",
    (await lib.getOrderById(d1, "R-CODE")).discountCode === "" && (await lib.getDiscountCode(d1, save10, "2027-03-15")).used === 0);
  ok("…the order keeps its discount on record ($11.50, \"Code SAVE10\")", (await lib.getOrderById(d1, "R-CODE")).discountAmount === 11.5);
  ok("voiding it again gives nothing back (discountCode \"\")", same(await lib.voidOrder(d1, "R-CODE", "again"), { discountCode: "" }));
  ok("voiding an order with no code answers discountCode \"\"", same(await lib.voidOrder(d1, "R-PLAIN", "Mistake"), { discountCode: "" }));
  let chk = await lib.checkDiscountCode(d1, { code: "ONLYPAT", orgId: "club", email: "pat@example.com", subtotal: 115, today: "2027-03-15" });
  ok("Pat's single-use code is used while R-PAT stands", chk.ok === false && chk.reason === "This code has already been used.");
  r = await lib.deleteOrder(d1, "R-PAT");
  ok("deleteOrder of the order that used it answers { discountCode: \"ONLYPAT\" } and the order is gone",
    same(r, { discountCode: "ONLYPAT" }) && !one(d1, "SELECT 1 AS x FROM orders WHERE orderId = 'R-PAT'"));
  use = one(d1, "SELECT orderId, releasedAt FROM discount_code_uses WHERE codeId = ?", onlyPat);
  ok("…its use is kept for the record, with the order's id, marked released", !!use && use.orderId === "R-PAT" && use.releasedAt === "2027-03-15T12:00:00.000Z");
  chk = await lib.checkDiscountCode(d1, { code: "ONLYPAT", orgId: "club", email: "pat@example.com", subtotal: 115, today: "2027-03-15" });
  ok("…and Pat can use the code again ($5.00 off)", chk.ok === true && chk.discount === 5);
  ok("deleting an order with no code answers discountCode \"\"", same(await lib.deleteOrder(d1, "R-MAN"), { discountCode: "" }));

  console.log("\n=== A database before 0115 ===");
  const old = await makeDb("0115");
  setTax(old, 1000, "exclusive");
  r = await lib.insertOrder(old, order("OLD-1", { discount: { cents: 1150, note: "Code SAVE10" } }), CART, {});
  ok("insertOrder still takes an order with a discount (the discount columns are older than 0115)", r.discount === 11.5 && r.total === 119.15);
  ok("…getOrderById reads it with discountCode \"\"", (await lib.getOrderById(old, "OLD-1")).discountCode === "");
  ok("…the Orders list too", (await lib.getOrdersByOrg(old, "club"))[0].discountCode === "");
  ok("voidOrder still voids and names no code", same(await lib.voidOrder(old, "OLD-1", "Mistake"), { discountCode: "" }) && !!one(old, "SELECT voidedAt FROM orders WHERE orderId = 'OLD-1'").voidedAt);
  ok("deleteOrder still deletes and names no code", same(await lib.deleteOrder(old, "OLD-1"), { discountCode: "" }) && !one(old, "SELECT 1 AS x FROM orders WHERE orderId = 'OLD-1'"));

  console.log("\n=== The reports: a code's discount is a discount ===");
  // Three databases with the same March orders: discounts by code, the same discounts typed by hand, and none.
  async function reportDb(how) {
    const db = await makeDb();
    await lib.setOrgFundraiser(db, "club", { mode: "percent", percent: 10, label: "Example Boosters" });
    await lib.setOrgFundraiser(db, "band", { mode: "perPiece", amount: 2, label: "Example Band Parents" });
    const c = (await lib.saveDiscountCode(db, { code: "SAVE10", kind: "percent", percent: 10, maxUses: 50 }, { now: "2027-03-01T00:00:00.000Z" })).code;
    const rows = [
      { id: "M1", mode: "inclusive", org: "club", cents: 1150, extra: RUSH, at: "2027-03-05T18:00:00.000Z" },
      { id: "M2", mode: "exclusive", org: "club", cents: 2500, extra: {}, at: "2027-03-12T18:00:00.000Z" },
      { id: "M3", mode: "exclusive", org: "band", cents: 11500, extra: RUSH, at: "2027-03-20T18:00:00.000Z" },
      { id: "M4", mode: "inclusive", org: "band", cents: 0, extra: {}, at: "2027-03-22T18:00:00.000Z" },
    ];
    for (const o of rows) {
      setTax(db, 825, o.mode);
      const ord = { ...order(o.id, { ...o.extra, placedAt: o.at }), orgId: o.org };
      if (how === "code" && o.cents) {
        await lib.claimDiscountCode(db, { codeId: c.id, orderId: o.id, email: "pat@example.com", amountCents: o.cents, now: o.at });
        ord.discount = { cents: o.cents, note: "Code SAVE10" };
      }
      await lib.insertOrder(db, ord, CART.map(it => ({ ...it, name: o.org === "club" ? it.name : it.name.replace("Club", "Band") })), {});
      if (how === "manual" && o.cents) await lib.setOrderDiscount(db, o.id, o.cents / 100, "Code SAVE10");
      const owed = (await lib.getOrderById(db, o.id)).balanceDue;
      await lib.addOrderPayment(db, o.id, owed, "Check", "", { receivedAt: o.at, method: "check" });
    }
    return db;
  }
  const dbs = { code: await reportDb("code"), manual: await reportDb("manual"), none: await reportDb("none") };
  const FROM = "2027-03-01T00:00:00.000Z", TO = "2027-03-31T23:59:59.999Z";
  const reports = {};
  for (const [k, db] of Object.entries(dbs)) {
    reports[k] = {
      revenue: (await lib.getRevenueData(db, FROM, TO, { basis: "placed" })).sort((a, b) => a.orderId < b.orderId ? -1 : 1),
      salesTax: await lib.getSalesTaxReport(db, FROM, TO),
      taxReturn: await lib.getSalesTaxReturn(db, FROM, TO),
      fundraising: await lib.getFundraisingReport(db, { dateFrom: "2027-03-01", dateTo: "2027-03-31", basis: "placed" }),
      paid: db.q("SELECT orderId, paid FROM orders ORDER BY orderId").map(x => x.orderId + ":" + x.paid).join(" "),
    };
  }
  ok("every March order is paid in each database (the payment is what each order owes)", reports.code.paid === "M1:1 M2:1 M3:1 M4:1" && reports.manual.paid === reports.code.paid);
  ok("the Revenue report's rows are the same for discounts by code as for the same discounts typed by hand", same(reports.code.revenue, reports.manual.revenue));
  const rev = Object.fromEntries(reports.code.revenue.map(x => [x.orderId, x]));
  ok("…and they show the discounts ($11.50, $25.00, $115.00 and none) and what's owed after them",
    rev.M1.discountAmount === 11.5 && rev.M2.discountAmount === 25 && rev.M3.discountAmount === 115 && rev.M4.discountAmount === 0 &&
    rev.M1.effectiveTotal === 123.5 && rev.M1.received === 123.5);
  const revNone = Object.fromEntries(reports.none.revenue.map(x => [x.orderId, x]));
  ok("…a code lowers net sales below the same order with no discount (the comparison isn't empty)",
    rev.M1.netSalesCents < revNone.M1.netSalesCents && rev.M2.netSalesCents < revNone.M2.netSalesCents && rev.M4.netSalesCents === revNone.M4.netSalesCents);
  ok("the Sales tax report is the same for a code's discount as a manual one", same(reports.code.salesTax, reports.manual.salesTax));
  const sum = (rows, f) => Math.round(rows.reduce((s, x) => s + x[f] * 100, 0));
  ok("…and the discounts lower the tax collected and the gross sales (against no discounts)",
    sum(reports.code.salesTax, "taxCollected") < sum(reports.none.salesTax, "taxCollected") && sum(reports.code.salesTax, "grossSales") < sum(reports.none.salesTax, "grossSales"));
  ok("the sales tax return's figures are the same for a code's discount as a manual one", same(reports.code.taxReturn, reports.manual.taxReturn));
  ok("the Fundraising report is the same for a code's discount as a manual one", same(reports.code.fundraising, reports.manual.fundraising));
  ok("…both shops are listed with every paid order (4), and a discount doesn't change what's raised (the same as no discounts)",
    reports.code.fundraising.totals.orders === 4 && reports.code.fundraising.shops.length === 2 && reports.code.fundraising.totals.raised > 0 &&
    reports.code.fundraising.totals.raised === reports.none.fundraising.totals.raised);

  console.log("\n=== The order readers when the code lookup fails for another reason ===");
  {
    const db = await makeDb();
    await lib.insertOrder(db, order("ERR-1"), [TEE3], {});
    const realPrepare = db.prepare;
    db.prepare = function (sql) {
      if (/FROM discount_code_uses u JOIN discount_codes c ON c\.id = u\.codeId\s+WHERE u\.orderId IN/.test(sql)) throw new Error("D1_ERROR: disk I/O error");
      return realPrepare.apply(this, arguments);
    };
    let threw = "";
    try { await lib.getOrderById(db, "ERR-1"); } catch (e) { threw = String(e && e.message); } finally { db.prepare = realPrepare; }
    ok("a failure that isn't a missing table is passed on, not read as \"no code\"", /disk I\/O/.test(threw));
    ok("(control) the same order reads with no code once the database answers", (await lib.getOrderById(db, "ERR-1")).discountCode === "");
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
