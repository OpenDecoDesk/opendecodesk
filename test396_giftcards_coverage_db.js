const fs = require("fs");
const { ok } = require("./testlib/check");
const { createD1 } = require("./testlib/d1-shim.js");

// The phase 6 lines of functions/_lib/db.js that no other test ran (more than one discount code, free-shipping codes,
// codes on quotes and on orders that exist, gift cards as a payment, Reorder), each driven and checked:
//   - an orders table from before migrations/0052 (no tax mode, no rush fee, no shipping discount): a gift card still pays
//     an order off, and the paid refresh falls back to the old statement when the table can't be read
//   - recalcOrderTotals on an order that isn't there; the no-blank and digital column checks passing on an unknown error
//   - a quote's totals with only a free-shipping code; quote codes stored as something other than a list; a gap in the
//     codes typed on a quote; a quote save that fails
//   - planDiscountCodes with no codes and with six; claimDiscountCodes with no list, a refused second code (the first is
//     given back) and a code id that isn't one; giving back uses whose read comes back empty or without a code
//   - the code readers by order; an order's codes read with missing figures; a code claimed by another order between the
//     check and the claim; unknown errors in the order-code actions, the shipping-discount sync and the live-code check
//   - insertOrder with a discount of nothing and no note
//   - voiding gift-card payments and refunds with no reason, of nothing, and with no refund link
//   - the books (Money summary, Money in and out) passing on an unknown error, and reading no payment rows
//   - gift card reads with missing fields, a repeat of a sold-online card that's been spent, an emptied card, and the
//     Gift cards settings refusals
//   - orderForReorder_: no order id, lines with missing fields, a plain product with the customer's own design, a customer
//     with no name, and a customers table that isn't there or fails
// Invented data only (Example Club, pat@example.com). Every date the checks read is set by the test.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/^import "[^"\n]+";\n/gm, "").replace(/export (async function|function|const)/g, "$1");
const NAMES = `{ refreshPaidStatus, redeemGiftCard, issueGiftCard, insertOrder, recalcOrderTotals, markItemsBlankOrdered, getPaidUnrunOrders,
  estimateTotals_, estimateCodesOf_, estimateCodeRows_, setEstimateDiscountCodes, setDiscountRules, saveDiscountCode, planDiscountCodes,
  claimDiscountCode, claimDiscountCodes, releaseDiscountCodeUse, discountCodeListByOrder_, discountCodesByOrder_, orderCodeState_,
  applyOrderDiscountCode, removeOrderDiscountCode, syncShippingDiscount_, orderHasLiveCode_, voidPayment, giftCardVoidRefusal,
  getMoneySummary, getMoneyInOutByMonth, getGiftCard, listGiftCards, giftCardLedger, refundToGiftCard, voidGiftCard, giftCardTotals,
  buildGiftCardSettings, orderForReorder_, getOrderCheckoutState }`;
const lib = new Function(strip(read("functions/_lib/db.js")) + "\nreturn " + NAMES + ";")();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };
process.on("unhandledRejection", (e) => { console.error(e); ok("nothing in the test was left to fail unseen", false); });

// A database that fails the statements matching `re` with `message`, and answers the rest as usual.
function failing(db, re, message) {
  const boom = () => { const s = { bind: () => s, run: async () => { throw new Error(message); }, all: async () => { throw new Error(message); }, first: async () => { throw new Error(message); } }; return s; };
  return new Proxy(db, { get(t, k) { if (k === "prepare") return (sql) => (re.test(sql) ? boom() : t.prepare(sql)); const v = t[k]; return typeof v === "function" ? v.bind(t) : v; } });
}
// A database that runs the statements matching `re` as usual and hands `fix(method, answer, sql)` to the caller instead
// (a row with a missing field, an answer with no results list).
function shaped(db, re, fix) {
  const wrap = (sql, st) => ({ _sql: st._sql, _params: st._params, bind: (...p) => wrap(sql, db.prepare(sql).bind(...p)),
    first: async (c) => fix("first", await st.first(c), sql), all: async () => fix("all", await st.all(), sql), run: async () => fix("run", await st.run(), sql) });
  return new Proxy(db, { get(t, k) { if (k === "prepare") return (sql) => (re.test(sql) ? wrap(sql, t.prepare(sql)) : t.prepare(sql)); const v = t[k]; return typeof v === "function" ? v.bind(t) : v; } });
}
// A database whose batches answer what `fix(results)` makes of the real answers.
function batchShaped(db, fix) {
  return new Proxy(db, { get(t, k) { if (k === "batch") return async (stmts) => fix(await t.batch(stmts)); const v = t[k]; return typeof v === "function" ? v.bind(t) : v; } });
}
// A database that runs `before` once, just before the first statement matching `re` runs (another writer getting in).
function beforeRun(db, re, before) {
  let done = false;
  const wrap = (sql, st) => ({ _sql: st._sql, _params: st._params, bind: (...p) => wrap(sql, db.prepare(sql).bind(...p)),
    first: (c) => st.first(c), all: () => st.all(), run: async () => { if (!done) { done = true; await before(); } return st.run(); } });
  return new Proxy(db, { get(t, k) { if (k === "prepare") return (sql) => (re.test(sql) ? wrap(sql, t.prepare(sql)) : t.prepare(sql)); const v = t[k]; return typeof v === "function" ? v.bind(t) : v; } });
}
const noResults = (m, r) => (m === "all" ? { ...r, results: undefined } : r);
const migrationFiles = fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort();
async function freshDb() {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of migrationFiles) d1.execFile(read("migrations/" + f));
  d1._raw.exec("INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('club','club','Example Club','t','t');");
  return d1;
}
const T = (d) => "2026-10-" + String(d).padStart(2, "0") + "T12:00:00.000Z";
const BOOM = "D1_ERROR: the network connection was lost";

(async () => {
  const d1 = await freshDb();
  const q = (sql, ...p) => d1.q(sql, ...p);
  const q1 = (sql, ...p) => q(sql, ...p)[0] || null;
  async function order(db, id, dollars, extra = {}) {
    await lib.insertOrder(db, { orderId: id, orgId: "club", customerName: "Pat Example", contact: "pat@example.com", placedAt: T(1), ...extra },
      [{ productId: "__custom__", name: "Club Tee", type: "other", size: "", qty: 1, unitPrice: dollars, taxable: false }]);
    return id;
  }
  const issue = (db, cents, extra = {}) => lib.issueGiftCard(db, { amountCents: cents, recipientName: "Sam Example", recipientEmail: "sam@example.com", by: "olive@example.com", now: T(2), ...extra });
  const bal = (db, id) => db.q("SELECT balanceCents b FROM gift_cards WHERE id=?", id)[0].b;
  const make = async (input) => { const r = await lib.saveDiscountCode(d1, input, { actor: "test" }); if (!r.code) throw new Error("couldn't make " + JSON.stringify(r)); return r.code; };

  console.log("=== An orders table from before the tax mode, rush fee and shipping discount ===");
  {
    const old = await freshDb();
    old._raw.exec(`INSERT INTO orders (orderId, orgId, customerName, contact, placedAt, subtotalCents, totalCents) VALUES ('L1','club','Pat Example','pat@example.com','${T(1)}',2000,2000);
      INSERT INTO order_items (orderId, orgId, productId, name, type, qty, unitPriceCents, lineTotalCents, taxable) VALUES ('L1','club','__custom__','Club Tee','other',1,2000,2000,0);`);
    for (const c of ["taxMode", "rushFeeCents", "rushFeeTaxCents", "rushFeePending", "paidForWork", "shippingDiscountCents"]) old._raw.exec("ALTER TABLE orders DROP COLUMN " + c);
    const st = await lib.getOrderCheckoutState(old, "L1");
    ok("the order still reads as owing its $20 (every order inclusive, no rush fee, no shipping discount)", !!st && st.total === 20 && st.paid === false);
    const card = await issue(old, 5000);
    const r = await lib.redeemGiftCard(old, { code: card.code, orderId: "L1", now: T(3), requestKey: "old-1" });
    ok("a gift card pays it off", r.ok === true && r.takenCents === 2000 && bal(old, card.id) === 3000);
    const o = old.q("SELECT paid, paidAt FROM orders WHERE orderId='L1'")[0];
    ok("and the paid refresh in the same batch (the old statement, with no paidForWork) marks it paid", o.paid === 1 && o.paidAt === T(3));
    old._raw.exec("UPDATE orders SET paid = 0, paidAt = NULL WHERE orderId = 'L1'");
    await lib.refreshPaidStatus(old, "L1");
    ok("refreshPaidStatus on that table works it out again from the payment", old.q("SELECT paid FROM orders WHERE orderId='L1'")[0].paid === 1);
  }

  console.log("\n=== The paid refresh when the orders table can't be read ===");
  {
    const pf = await freshDb();
    await order(pf, "P1", 20);
    const card = await issue(pf, 5000);
    const r = await lib.redeemGiftCard(failing(pf, /PRAGMA table_info\(orders\)/, BOOM), { code: card.code, orderId: "P1", now: T(3) });
    const o = pf.q("SELECT paid, paidForWork FROM orders WHERE orderId='P1'")[0];
    ok("the card still pays the order and the order is marked paid", r.ok === true && r.takenCents === 2000 && o.paid === 1);
    ok("by the old statement, which leaves paidForWork alone", o.paidForWork === 0);
    await lib.refreshPaidStatus(pf, "P1");
    ok("(the full refresh would have set it)", pf.q("SELECT paidForWork FROM orders WHERE orderId='P1'")[0].paidForWork === 1);
  }

  console.log("\n=== Order totals and the column checks ===");
  {
    ok("recalcOrderTotals on an order that isn't there comes to nothing", same(await lib.recalcOrderTotals(d1, "NO-SUCH"), { subtotal: 0, total: 0 }));
    ok("and makes no order", q1("SELECT count(*) n FROM orders WHERE orderId='NO-SUCH'").n === 0);
    const e1 = await rejects(lib.markItemsBlankOrdered(failing(d1, /SELECT noBlankNeeded FROM products LIMIT 0/, BOOM), [1]));
    ok("an unknown error checking for the no-blank column is passed on, not taken for an old database", !!e1 && e1.message === BOOM);
    ok("while a missing column is an old database (nothing to mark)", same(await lib.markItemsBlankOrdered(failing(d1, /SELECT noBlankNeeded FROM products LIMIT 0/, "no such column: noBlankNeeded"), [999]), []));
    const e2 = await rejects(lib.getPaidUnrunOrders(failing(d1, /SELECT digital FROM products LIMIT 0/, BOOM)));
    ok("an unknown error checking for the digital column is passed on too", !!e2 && e2.message === BOOM);
  }

  // Codes for the rest of the test.
  const ten = await make({ code: "TEN", kind: "percent", percent: 10, maxUses: 1000 });
  const fifteen = await make({ code: "FIFTEEN", kind: "percent", percent: 15, maxUses: 1000 });
  const shipFree = await make({ code: "SHIPFREE", kind: "shipping", maxUses: 1000 });
  const last = await make({ code: "LASTONE", kind: "amount", amount: 3, maxUses: 1 });
  const codeRow = (code) => q1("SELECT * FROM discount_codes WHERE code = ?", code);

  console.log("\n=== Codes on a quote ===");
  {
    const t = lib.estimateTotals_([{ lineTotalCents: 2000, taxable: 1 }], "exclusive", 800, [codeRow("SHIPFREE")]);
    ok("a quote with only a free-shipping code takes nothing off the goods or their tax", t.discount === 0 && t.tax === 1.6 && t.total === 21.6 && t.subtotal === 20);
    ok("and says shipping is free, with the code's share as nothing", t.freeShipping === true && same(t.discountCodes.map(c => [c.code, c.discount, c.freeShipping]), [["SHIPFREE", 0, true]]));
    const z = lib.estimateTotals_([], "exclusive", 800, [codeRow("TEN")]);
    ok("a quote with no lines and a percent code comes to nothing, with no tax taken off", z.discount === 0 && z.tax === 0 && z.total === 0);

    ok("codes stored as an object are no codes", same(lib.estimateCodesOf_({ discountCodes: '{"code":"TEN"}' }), []));
    ok("codes stored as one string are no codes", same(lib.estimateCodesOf_({ discountCodes: '"TEN"' }), []));
    ok("a stored list keeps its codes as text, blanks left out", same(lib.estimateCodesOf_({ discountCodes: '["TEN","",5]' }), ["TEN", "5"]));
    ok("a quote with no codes field has none", same(lib.estimateCodesOf_({}), []) && same(lib.estimateCodesOf_(null), []));

    ok("the codes' rows come back in the order typed", same((await lib.estimateCodeRows_(d1, ["FIFTEEN", "TEN"])).map(r => r.code), ["FIFTEEN", "TEN"]));
    ok("a read that comes back with no results list is no rows", same(await lib.estimateCodeRows_(shaped(d1, /FROM discount_codes WHERE code IN/, noResults), ["TEN"]), []));
    const e = await rejects(lib.estimateCodeRows_(failing(d1, /FROM discount_codes WHERE code IN/, BOOM), ["TEN"]));
    ok("an unknown error reading them is passed on", !!e && e.message === BOOM);

    q("INSERT INTO customers (name, email, createdAt, updatedAt) VALUES ('Pat Example', 'pat@example.com', 't', 't')");
    const cust = q1("SELECT id FROM customers WHERE email='pat@example.com'").id;
    q("INSERT INTO estimates (number, orgId, customerId, status, createdAt, updatedAt) VALUES (1, 'club', ?, 'draft', 't', 't')", cust);
    const est = q1("SELECT id FROM estimates WHERE number = 1").id;
    const r = await lib.setEstimateDiscountCodes(d1, est, [null, "  ", "ten"]);
    ok("empty entries typed on a quote (nothing, spaces) are skipped, not called a bad code", r.ok === true && same(r.codes, ["TEN"]));
    ok("and the quote keeps the one code", q1("SELECT discountCodes FROM estimates WHERE id=?", est).discountCodes === '["TEN"]');
    const e2 = await rejects(lib.setEstimateDiscountCodes(failing(d1, /UPDATE estimates SET discountCodes/, BOOM), est, ["FIFTEEN"]));
    ok("an unknown error saving them is passed on", !!e2 && e2.message === BOOM);
    ok("and the quote keeps what it had", q1("SELECT discountCodes FROM estimates WHERE id=?", est).discountCodes === '["TEN"]');
  }

  console.log("\n=== Planning and claiming several codes ===");
  {
    const none = await lib.planDiscountCodes(d1, { codes: [], goodsCents: 2000, shippingCents: 500, orgId: "club" });
    ok("no codes plan to nothing off", none.ok === true && same(none.uses, []) && none.note === "" && none.goodsOffCents === 0 && none.shippingOffCents === 0);
    ok("with the cart left as it is", none.combined.goodsOffCents === 0 && none.combined.shippingOffCents === 0);
    const six = await lib.planDiscountCodes(d1, { codes: ["AAA1", "AAA2", "AAA3", "AAA4", "AAA5", "AAA6"], goodsCents: 2000, orgId: "club" });
    ok("six codes are refused", six.ok === false && six.reason === "At most 5 discount codes can be used on an order.");

    await lib.setDiscountRules(d1, { multiple: true });
    await order(d1, "C1", 20);
    ok("a list of uses that isn't a list claims nothing", same(await lib.claimDiscountCodes(d1, { orderId: "C1", uses: "TEN" }), { ok: true })
      && q1("SELECT count(*) n FROM discount_code_uses WHERE orderId='C1'").n === 0);
    await order(d1, "C0", 20);
    ok("(another order takes the last use of LASTONE)", (await lib.claimDiscountCode(d1, { codeId: last.id, orderId: "C0", email: "lee@example.com", amountCents: 300 })).ok === true);
    const r = await lib.claimDiscountCodes(d1, { orderId: "C1", email: "pat@example.com", uses: [{ codeId: ten.id, amountCents: 200 }, { codeId: last.id, amountCents: 300 }] });
    ok("a refused second code refuses the lot, naming it", r.ok === false && r.reason === "This code has already been used." && r.codeId === last.id);
    ok("and the first code's use is given back", q1("SELECT count(*) n FROM discount_code_uses WHERE orderId='C1' AND releasedAt IS NULL").n === 0
      && q1("SELECT releasedAt FROM discount_code_uses WHERE orderId='C1' AND codeId=?", ten.id).releasedAt !== null);
    await order(d1, "C3", 20);
    const noRelease = failing(d1, /UPDATE discount_code_uses SET releasedAt = \? WHERE orderId = \? AND codeId = \?/, BOOM);
    const r3 = await lib.claimDiscountCodes(noRelease, { orderId: "C3", email: "pat@example.com", uses: [{ codeId: ten.id }, { codeId: last.id }] });
    ok("when giving the first code back fails, the refusal is still the answer (not the failure)", r3.ok === false && r3.reason === "This code has already been used." && r3.codeId === last.id);
    ok("(the first code's use is still there to be given back with the order)", q1("SELECT count(*) n FROM discount_code_uses WHERE orderId='C3' AND releasedAt IS NULL").n === 1);
    const bad = await lib.claimDiscountCodes(d1, { orderId: "C1", uses: [{ codeId: "not a number" }] });
    ok("a use with no proper code id is refused with no code id", bad.ok === false && bad.reason === "This code isn't valid." && bad.codeId === null);
  }

  console.log("\n=== Giving back uses, and reading them by order ===");
  {
    await order(d1, "C2", 40);
    await lib.claimDiscountCodes(d1, { orderId: "C2", email: "pat@example.com", uses: [{ codeId: ten.id }, { codeId: fifteen.id }] });
    const sub = "SELECT ?";
    ok("the codes by order, joined", same(Object.assign({}, await lib.discountCodesByOrder_(d1, sub, ["C2"])), { C2: "TEN, FIFTEEN" }));
    ok("and as a list", same(Object.assign({}, await lib.discountCodeListByOrder_(d1, sub, ["C2"])), { C2: ["TEN", "FIFTEEN"] }));
    ok("a read with no results list is no codes", same(Object.assign({}, await lib.discountCodeListByOrder_(shaped(d1, /SELECT u\.orderId, c\.code/, noResults), sub, ["C2"])), {}));
    const noCode = shaped(d1, /SELECT u\.orderId, c\.code/, (m, r) => ({ ...r, results: r.results.map(x => ({ ...x, code: null })) }));
    ok("a use whose code comes back empty is listed as an empty code", same(Object.assign({}, await lib.discountCodeListByOrder_(noCode, sub, ["C2"])), { C2: ["", ""] }));

    const st = await lib.orderCodeState_(shaped(shaped(d1, /AS goodsCents/, (m, r) => (r ? { ...r, goodsCents: null } : r)), /AS used_ FROM discount_code_uses/, noResults), "C2");
    ok("an order's code state read with no goods figure and no rows is nothing off nothing", !!st && st.goodsCents === 0 && same(st.rows, []) && st.order.orderId === "C2");

    const r0 = await lib.releaseDiscountCodeUse(shaped(d1, /SELECT u\.id, c\.code FROM discount_code_uses/, noResults), "C2");
    ok("giving back an order's uses when the read has no results list gives back nothing", same(r0, { ok: true, codes: [], code: "" })
      && q1("SELECT count(*) n FROM discount_code_uses WHERE orderId='C2' AND releasedAt IS NULL").n === 2);
    const half = shaped(d1, /SELECT u\.id, c\.code FROM discount_code_uses/, (m, r) => ({ ...r, results: r.results.map((x, i) => (i === 0 ? { ...x, code: null } : x)) }));
    const r1 = await lib.releaseDiscountCodeUse(half, "C2");
    ok("a use whose code comes back empty is given back but not named", same(r1, { ok: true, codes: ["FIFTEEN"], code: "FIFTEEN" })
      && q1("SELECT count(*) n FROM discount_code_uses WHERE orderId='C2' AND releasedAt IS NULL").n === 0);
  }

  console.log("\n=== Codes on an order that exists ===");
  {
    await setDiscountRulesOff();
    await order(d1, "A1", 20);
    await order(d1, "A2", 20);
    const fresh = await make({ code: "FINALONE", kind: "amount", amount: 3, maxUses: 1 });
    const raced = beforeRun(d1, /INSERT INTO discount_code_uses/, () => lib.claimDiscountCode(d1, { codeId: fresh.id, orderId: "A2", email: "lee@example.com", amountCents: 300 }));
    const r = await lib.applyOrderDiscountCode(raced, { orderId: "A1", code: "FINALONE" });
    ok("a code whose last use goes to another order between the check and the claim is refused with why", r.ok === false && r.reason === "This code has already been used." && r.error === r.reason && !r.notReady);
    ok("and the order is left without it", q1("SELECT discountCents, discountNote FROM orders WHERE orderId='A1'").discountCents === 0
      && q1("SELECT count(*) n FROM discount_code_uses WHERE orderId='A1'").n === 0);
    const e1 = await rejects(lib.applyOrderDiscountCode(failing(d1, /AS goodsCents/, BOOM), { orderId: "A1", code: "TEN" }));
    ok("an unknown error adding a code is passed on", !!e1 && e1.message === BOOM);
    ok("adding a code works on that order otherwise", (await lib.applyOrderDiscountCode(d1, { orderId: "A1", code: "TEN" })).ok === true);
    const e2 = await rejects(lib.removeOrderDiscountCode(failing(d1, /AS goodsCents/, BOOM), { orderId: "A1", code: "TEN" }));
    ok("an unknown error taking a code off is passed on", !!e2 && e2.message === BOOM);
    ok("and the code stays on", q1("SELECT discountNote FROM orders WHERE orderId='A1'").discountNote === "Code TEN");

    const SYNC = /UPDATE orders SET shippingDiscountCents = CASE/;
    ok("syncing free shipping on a database without the column does nothing", (await rejects(lib.syncShippingDiscount_(failing(d1, SYNC, "no such column: shippingDiscountCents"), "A1"))) === null);
    const e3 = await rejects(lib.syncShippingDiscount_(failing(d1, SYNC, BOOM), "A1"));
    ok("an unknown error syncing it is passed on", !!e3 && e3.message === BOOM);
    const LIVE = /SELECT 1 AS x FROM discount_code_uses WHERE orderId = \? AND releasedAt IS NULL LIMIT 1/;
    ok("an order has a live code", (await lib.orderHasLiveCode_(d1, "A1")) === true);
    ok("before discount codes there is no live code", (await lib.orderHasLiveCode_(failing(d1, LIVE, "no such table: discount_code_uses"), "A1")) === false);
    const e4 = await rejects(lib.orderHasLiveCode_(failing(d1, LIVE, BOOM), "A1"));
    ok("an unknown error checking is passed on", !!e4 && e4.message === BOOM);

    await order(d1, "N1", 20, { discount: { cents: 0 } });
    const n1 = q1("SELECT discountCents, discountNote FROM orders WHERE orderId='N1'");
    ok("an order written with a discount of nothing and no note has no discount and no note", n1.discountCents === 0 && n1.discountNote === "");
  }
  async function setDiscountRulesOff() { await lib.setDiscountRules(d1, { multiple: false }); }

  console.log("\n=== Voiding gift-card payments and refunds ===");
  {
    await order(d1, "V1", 20);
    const c1 = await issue(d1, 5000);
    const p1 = await lib.redeemGiftCard(d1, { code: c1.code, orderId: "V1", now: T(3) });
    await lib.voidPayment(d1, p1.paymentId);
    ok("a gift-card payment voided with no reason gives the card its money back", bal(d1, c1.id) === 5000);
    ok("and is voided with an empty reason", q1("SELECT voidedAt, voidReason FROM order_payments WHERE id=?", p1.paymentId).voidReason === "");

    await order(d1, "V2", 20);
    const c2 = await issue(d1, 5000);
    const p2 = await lib.redeemGiftCard(d1, { code: c2.code, orderId: "V2", now: T(3) });
    const rf = await lib.refundToGiftCard(d1, { paymentId: p2.paymentId, amountCents: 500, now: T(4) });
    ok("(a $5 refund to the card)", rf.ok === true && bal(d1, c2.id) === 3500);
    await lib.voidPayment(d1, rf.refundPaymentId);
    ok("voiding that refund with no reason takes the $5 back off the card", bal(d1, c2.id) === 3000);
    ok("and voids it with an empty reason", q1("SELECT voidReason, voidedAt FROM order_payments WHERE id=?", rf.refundPaymentId).voidReason === ""
      && q1("SELECT voidedAt FROM order_payments WHERE id=?", rf.refundPaymentId).voidedAt !== null);

    // A payment row read back without its amount (a figure that can't be read) moves nothing on the card.
    const noAmount = shaped(d1, /amountCents, kind, voidedAt, externalRef FROM order_payments WHERE id=\?/, (m, r) => (r ? { ...r, amountCents: null } : r));
    const rfB = await lib.refundToGiftCard(d1, { paymentId: p2.paymentId, amountCents: 200, now: T(4) });
    ok("(a $2 refund to the card)", rfB.ok === true && bal(d1, c2.id) === 3200);
    ok("a gift-card refund read without its amount is never refused a void", (await lib.giftCardVoidRefusal(noAmount, rfB.refundPaymentId)) === "");
    await lib.voidPayment(noAmount, rfB.refundPaymentId, "Typed twice");
    ok("and voiding it takes nothing off the card", bal(d1, c2.id) === 3200 && q1("SELECT voidReason FROM order_payments WHERE id=?", rfB.refundPaymentId).voidReason === "Typed twice");
    await lib.voidPayment(noAmount, p2.paymentId, "Typed twice");
    ok("voiding a gift-card payment read without its amount puts nothing on the card", bal(d1, c2.id) === 3200
      && q1("SELECT voidedAt FROM order_payments WHERE id=?", p2.paymentId).voidedAt !== null && q1("SELECT count(*) n FROM gift_card_ledger WHERE paymentId=? AND note='Payment voided'", p2.paymentId).n === 0);

    q(`INSERT INTO order_payments (orderId, amountCents, receivedAt, method, kind, giftCardId) VALUES ('V2', -100, ?, 'other', 'refund', ?)`, T(5), c2.id);
    const unlinked = q1("SELECT MAX(id) id FROM order_payments WHERE kind='refund' AND externalRef=''").id;
    ok("a gift-card refund with no link to its payment is never refused a void", (await lib.giftCardVoidRefusal(d1, unlinked)) === "");
    await lib.voidPayment(d1, unlinked, "Not ours");
    ok("and voiding it leaves the card alone", bal(d1, c2.id) === 3200 && q1("SELECT voidedAt FROM order_payments WHERE id=?", unlinked).voidedAt !== null);
  }

  console.log("\n=== The books ===");
  {
    q(`INSERT INTO order_payments (orderId, amountCents, receivedAt, method, kind) VALUES ('C1', 2000, ?, 'cash', 'payment')`, T(6));
    const YEAR = { yearFrom: "2026-01-01", to: "2026-12-31" };
    const inOct = (io) => io.months.find(m => m.month === "2026-10");
    const real = await lib.getMoneyInOutByMonth(d1, YEAR);
    ok("Money in and out counts October's cash payment", inOct(real).in.payments > 0);
    const empty = await lib.getMoneyInOutByMonth(shaped(d1, /AS refundShippingCents/, noResults), YEAR);
    ok("a payments read with no results list is no payments", inOct(empty).in.payments === 0 && inOct(empty).in.taxCollected === 0);
    const e1 = await rejects(lib.getMoneyInOutByMonth(failing(d1, /AS refundShippingCents/, BOOM), YEAR));
    ok("an unknown error reading the payments is passed on, not retried as an old database", !!e1 && e1.message === BOOM);
    const e2 = await rejects(lib.getMoneySummary(failing(d1, /giftCardId IS NULL\) AS n/, BOOM), "2026-01-01", "2026-12-31"));
    ok("an unknown error counting payments with no account is passed on in the Money summary", !!e2 && e2.message === BOOM);
  }

  console.log("\n=== Gift card reads with missing fields ===");
  {
    const c = await issue(d1, 2500, { note: "Raffle prize" });
    const blank = shaped(d1, /SELECT \* FROM gift_cards WHERE id = \?/, (m, r) => (r ? { ...r, last4: null, initialCents: null, createdAt: null, createdBy: null } : r));
    const g = await lib.getGiftCard(blank, { id: c.id });
    ok("a card read with no last 4 shows an empty mask", g.last4 === "" && g.codeMasked === "••••-••••-••••-");
    ok("with no first amount as 0, and no maker or date as empty", g.initialCents === 0 && g.createdAt === "" && g.createdBy === "" && g.balanceCents === 2500);

    const all = await lib.listGiftCards(d1, { q: null });
    ok("a search of nothing (null) lists every card", all.total === q1("SELECT count(*) n FROM gift_cards").n && all.cards.length === all.total);
    const none = await lib.listGiftCards(shaped(d1, /SELECT g\.\* FROM gift_cards g/, noResults), {});
    ok("a list read with no results list is no cards, still with the count", same(none.cards, []) && none.total === all.total);

    ok("a ledger read with no results list is no history", same(await lib.giftCardLedger(shaped(d1, /FROM gift_card_ledger WHERE cardId/, noResults), c.id), []));
    const holes = shaped(d1, /FROM gift_card_ledger WHERE cardId/, (m, r) => ({ ...r, results: r.results.map(x => ({ ...x, deltaCents: null, orderId: null, note: null, at: null, by: null })) }));
    const led = await lib.giftCardLedger(holes, c.id);
    ok("a ledger row with missing fields reads as 0 and empty text", led.length === 1 && led[0].deltaCents === 0 && led[0].orderId === "" && led[0].note === "" && led[0].at === "" && led[0].by === "");
    const tot = await lib.giftCardTotals(shaped(d1, /FROM gift_card_ledger WHERE at >= \?/, noResults), {});
    ok("totals with no ledger results are nothing sold, spent, changed or given back, with what is held still counted",
      tot.sold === 0 && tot.redeemed === 0 && tot.adjusted === 0 && tot.refunded === 0 && tot.outstanding > 0);
  }

  console.log("\n=== Spent cards ===");
  {
    await order(d1, "S1", 20);
    const sold = await issue(d1, 1000, { sourceOrderId: "GC-1" });
    const r = await lib.redeemGiftCard(d1, { code: sold.code, orderId: "S1", now: T(3), requestKey: "spend-1" });
    ok("spending all of a card leaves it at 0", r.ok === true && r.takenCents === 1000 && r.balanceCents === 0);
    const again = await issue(d1, 1000, { sourceOrderId: "GC-1" });
    ok("the order that sold it asking again gets the same card, at 0, not a new one", again.created === false && again.id === sold.id && again.balanceCents === 0);

    await order(d1, "S2", 20);
    const c = await issue(d1, 5000);
    const r1 = await lib.redeemGiftCard(d1, { code: c.code, orderId: "S2", now: T(3), requestKey: "dup-1" });
    const odd = shaped(shaped(d1, /SELECT \* FROM gift_cards WHERE code = \?/, (m, x) => (x ? { ...x, balanceCents: undefined } : x)),
      /SELECT id, amountCents, giftCardId FROM order_payments WHERE requestKey/, (m, x) => (x ? { ...x, amountCents: null } : x));
    const r2 = await lib.redeemGiftCard(odd, { code: c.code, orderId: "S2", now: T(3), requestKey: "dup-1" });
    ok("a repeat whose payment and card come back without amounts answers 0, not a number it can't read", r2.ok === true && r2.duplicate === true && r2.takenCents === 0 && r2.balanceCents === 0 && r2.paymentId === r1.paymentId);
    ok("and books nothing twice", q1("SELECT count(*) n FROM order_payments WHERE requestKey='dup-1'").n === 1 && bal(d1, c.id) === 3000);

    await order(d1, "S3", 20);
    const c3 = await issue(d1, 5000);
    const lost = batchShaped(shaped(d1, /SELECT balanceCents FROM gift_cards WHERE id = \?/, () => null), (out) => out.map(x => ({ ...x, meta: { ...x.meta, last_row_id: 0 } })));
    const r3 = await lib.redeemGiftCard(lost, { code: c3.code, orderId: "S3", now: T(3) });
    ok("a spend whose card and row id can't be read back answers 0 for both", r3.ok === true && r3.takenCents === 2000 && r3.balanceCents === 0 && r3.paymentId === 0);
    const r4 = await lib.refundToGiftCard(lost, { paymentId: q1("SELECT id FROM order_payments WHERE orderId='S3' AND giftCardId=?", c3.id).id, amountCents: 500, now: T(4) });
    ok("a refund to a card whose balance and row id can't be read back answers 0 for both", r4.ok === true && r4.refundedCents === 500 && r4.balanceCents === 0 && r4.refundPaymentId === 0);
    ok("(the card did get the $5 back)", bal(d1, c3.id) === 3500);

    const v = await lib.voidGiftCard(d1, { id: sold.id, note: "Spent, closing it" });
    ok("voiding an empty card voids nothing", v.ok === true && v.voidedCents === 0 && q1("SELECT status FROM gift_cards WHERE id=?", sold.id).status === "void");
  }

  console.log("\n=== Gift cards settings ===");
  {
    const cur = (await lib.buildGiftCardSettings(d1, null)).value;
    ok("no settings sent keeps them as they are", same(cur, { sellOnline: false, amounts: [2500, 5000, 10000], minCents: 500, maxCents: 50000 }));
    const msg = async (v) => { const e = await rejects(lib.buildGiftCardSettings(d1, v)); return e && e.userFacing ? e.message : null; };
    ok("sell online must be yes or no", (await msg({ sellOnline: "yes" })) === "Say whether gift cards are sold online");
    ok("the buttons need 1 to 6 amounts", (await msg({ amounts: [] })) === "Give 1 to 6 amounts for the gift card buttons"
      && (await msg({ amounts: [500, 600, 700, 800, 900, 1000, 1100] })) === "Give 1 to 6 amounts for the gift card buttons" && (await msg({ amounts: "2500" })) === "Give 1 to 6 amounts for the gift card buttons");
    ok("each amount is $1 to $10,000 in whole cents", (await msg({ amounts: [50] })) === "Each gift card amount must be between $1 and $10,000"
      && (await msg({ amounts: [2500, 1000001] })) === "Each gift card amount must be between $1 and $10,000" && (await msg({ amounts: [250.5] })) === "Each gift card amount must be between $1 and $10,000");
    ok("the smallest and largest are $1 to $10,000", (await msg({ minCents: 50 })) === "The smallest and largest gift card amount must be between $1 and $10,000"
      && (await msg({ maxCents: 2000000 })) === "The smallest and largest gift card amount must be between $1 and $10,000");
    ok("the smallest can't be more than the largest", (await msg({ minCents: 6000, maxCents: 5000 })) === "The smallest gift card amount can't be more than the largest");
    ok("a good change is taken, repeats dropped", same((await lib.buildGiftCardSettings(d1, { amounts: [1000, 1000, 2000] })).value.amounts, [1000, 2000]));
  }

  console.log("\n=== Reorder ===");
  {
    ok("no order id is no order", (await lib.orderForReorder_(d1, null)) === null);
    q("INSERT INTO customers (name, email, createdAt, updatedAt) VALUES ('', 'robin@example.com', 't', 't')");
    const nameless = q1("SELECT id FROM customers WHERE email='robin@example.com'").id;
    q("INSERT INTO orders (orderId, orgId, customerName, contact, placedAt, customerId) VALUES ('R1', 'club', '', 'robin@example.com', ?, ?)", T(1), nameless);
    const item = (productId, name, type, qty, unit, configJson) => q(`INSERT INTO order_items (orderId, orgId, productId, name, type, qty, unitPriceCents, lineTotalCents, configJson)
      VALUES ('R1', 'club', ?, ?, ?, ?, ?, ?, ?)`, productId, name, type, qty, unit, unit * Math.max(qty, 1), configJson);
    item("tee", "Club Tee", "shirt", 2, 1500, JSON.stringify({ plain: true, locations: [{ name: "Front", custom: true }] }));
    item("cap", "", "", 1, 0, JSON.stringify({ color: "Navy", locations: [{ name: "Front" }] }));
    item("", "", "other", 1, 700, "");
    item("bag", "Tote", "bag", 1, 900, JSON.stringify({ plain: true }));
    // (The cap's quantity comes back missing: the table never holds one below 1.)
    const r = await lib.orderForReorder_(shaped(d1, /SELECT \* FROM order_items WHERE orderId = \?/, (m, x) => ({ ...x, results: x.results.map(l => (l.productId === "cap" ? { ...l, qty: null } : l)) })), "R1");
    const [tee, cap, custom, bag] = r.lines;
    ok("every line comes back", r.lines.length === 4 && r.reorderOf === "R1");
    ok("a plain product with the customer's own design is a plain line marked so, with no choices", tee.config === null && tee.customDesign === true && tee.qty === 2 && tee.priceThen === 15);
    ok("a plain product without its own design is not marked", bag.config === null && bag.customDesign === false);
    ok("a product with choices keeps them", same(cap.config, { color: "Navy", locations: [{ name: "Front" }] }) && cap.customDesign === false);
    ok("a line with no quantity is one, with no name or type as empty and no price as $0", cap.qty === 1 && cap.name === "" && cap.type === "" && cap.priceThen === 0);
    ok("a line with no product is a custom line, even with no name", custom.productId === "__custom__" && custom.name === "" && custom.customUnitPrice === 7 && custom.config === null);
    ok("a customer and order with no name give no name", same(r.customer, { name: "", email: "robin@example.com", phone: "", company: "" }) && r.customerId === nameless);

    const none = await lib.orderForReorder_(shaped(d1, /SELECT \* FROM order_items WHERE orderId = \?/, noResults), "R1");
    ok("a lines read with no results list is an order with no lines", !!none && same(none.lines, []));
    const CUST = /SELECT \* FROM customers WHERE id = \?/;
    const pre = await lib.orderForReorder_(failing(d1, CUST, "no such table: customers"), "R1");
    ok("before the customers table, the customer is the order's own name and email", !!pre && same(pre.customer, { name: "", email: "robin@example.com", phone: "", company: "" }));
    const e = await rejects(lib.orderForReorder_(failing(d1, CUST, BOOM), "R1"));
    ok("an unknown error reading the customer is passed on", !!e && e.message === BOOM);
  }
})();
