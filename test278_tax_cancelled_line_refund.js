const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// A cancelled line is left out of tax collected, so the money refunded for it carries no tax to take off again
// (2026-11). The sales tax return used to take it off twice: once by dropping the line, once more by backing tax out
// of its refund — two taxable $53 lines at 6%, one cancelled and refunded, came to $0 due where the other line's $3
// is still owed (and a cancelled non-taxable line took tax off that was never in it). Now an order's refunds cover
// its cancelled lines' money first, oldest refund first, and only what goes back beyond that backs tax out
// (db.js getSalesTaxRefunds, which the return, the by-state report's refund figures and the accountant export all
// read). Real SQL (sql.js), real db.js. Invented data only.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const lib = new Function(strip(read("functions/_lib/db.js")) + `\nreturn { insertOrder, addOrderPayment, cancelLineItemWithReason, setOrderDiscount,
  getSalesTaxRefunds, getSalesTaxReturn, getSalesTaxReport };`)();

let failed = 0;
const ok = (label, cond) => { if (!cond) failed++; console.log(label + ": " + !!cond); };
const cents = (x) => Math.round(Number(x) * 100);

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Example Club','t','t');`);
  d1._raw.exec(`INSERT OR REPLACE INTO global_settings (key, value) VALUES ('salesTax', '{"rateBps":600,"taxShipping":false,"jurisdiction":"OH"}')`);

  // One order per case, each in its own month of 2025, so a month's figures are that case's alone.
  const day = (month, d) => `2025-${month}-${String(d).padStart(2, "0")}T12:00:00.000Z`;
  const span = (from, to = from) => [`2025-${from}-01T00:00:00.000Z`, `2025-${to}-31T23:59:59.999Z`];
  // lines: [price, taxable]. Paid in full on the day it's placed.
  const order = async (id, month, lines, extra = {}) => {
    await lib.insertOrder(d1, { orderId: id, orgId: "acme", customerName: "Pat Example", contact: "pat@example.test", placedAt: day(month, 5),
      shippingAddress: { name: "Pat Example", line1: "1 Main St", city: "Springfield", state: "OH", zip: "45503" }, ...extra },
      lines.map(([price, taxable], n) => ({ productId: "", name: "Line " + (n + 1), type: "shirt", size: "L", qty: 1, unitPrice: price, taxable })));
    return d1.q("SELECT id FROM order_items WHERE orderId = ? ORDER BY id", id).map(r => r.id);
  };
  const cancel = (itemId, at) => lib.cancelLineItemWithReason(d1, itemId, "Customer changed their mind", at);
  const refund = (id, amount, at, shipping = 0) => lib.addOrderPayment(d1, id, -amount, "Refund", "", { method: "venmo", kind: "refund", receivedAt: at,
    ...(shipping ? { shippingCents: cents(shipping) } : {}) });
  const due = async (from, to) => (await lib.getSalesTaxReturn(d1, ...span(from, to))).total;
  const back = async (from, to) => (await lib.getSalesTaxRefunds(d1, ...span(from, to))).reduce((t, r) => ({ refunded: t.refunded + cents(r.refunded), tax: t.tax + cents(r.taxRefunded), n: t.n + r.refunds }), { refunded: 0, tax: 0, n: 0 });

  console.log("=== A line cancelled and refunded in the month it was sold ===");
  let ids = await order("A", "01", [[53, true], [53, true]]);
  await cancel(ids[0], day("01", 10)); await refund("A", 53, day("01", 10));
  let t = await due("01");
  ok("two taxable $53 lines at 6%, one cancelled and refunded $53: tax collected $3, none taken off again, $3 due", cents(t.taxCollected) === 300 && cents(t.taxRefunded) === 0 && cents(t.totalDue) === 300);
  let b = await back("01");
  ok("…the refund is still reported ($53, one refund), with no tax in it", b.refunded === 5300 && b.n === 1 && b.tax === 0);

  console.log("\n=== The cancelled line wasn't taxable ===");
  ids = await order("B", "02", [[53, true], [20, false]]);
  await cancel(ids[1], day("02", 10)); await refund("B", 20, day("02", 10));
  t = await due("02");
  ok("its $20 refund takes no tax off the taxable line that stays: $3 due", cents(t.taxCollected) === 300 && cents(t.taxRefunded) === 0 && cents(t.totalDue) === 300);

  console.log("\n=== Cancelled and refunded in a later month ===");
  ids = await order("C", "03", [[53, true], [53, true]]);
  await cancel(ids[0], day("04", 10)); await refund("C", 53, day("04", 10));
  const both = await lib.getSalesTaxReturn(d1, ...span("03", "04"));
  const mar = both.months.find(m => m.month === "2025-03"), apr = both.months.find(m => m.month === "2025-04");
  ok("the sale month collects the remaining line's $3; the refund month takes nothing off", !!mar && !!apr && cents(mar.taxCollected) === 300 && cents(apr.taxRefunded) === 0 && cents(both.total.totalDue) === 300);
  b = await back("04");
  ok("…asked for the refund month alone: $53 refunded, no tax", b.refunded === 5300 && b.tax === 0);

  console.log("\n=== A refund bigger than the cancelled lines ===");
  ids = await order("D", "05", [[53, true], [53, true]]);
  await cancel(ids[0], day("05", 10)); await refund("D", 63, day("05", 10));
  t = await due("05");
  ok("$63 back on a cancelled $53 line: only the $10 beyond it backs tax out ($0.57), $2.43 due", cents(t.taxRefunded) === 57 && cents(t.totalDue) === 243);

  console.log("\n=== Several refunds use the cancelled money up in order ===");
  ids = await order("E", "06", [[53, true], [53, true]]);
  await cancel(ids[0], day("06", 10)); await refund("E", 30, day("06", 10)); await refund("E", 33, day("07", 10));
  b = await back("06");
  ok("the first refund ($30) is all the cancelled line's money: no tax", b.refunded === 3000 && b.tax === 0);
  b = await back("07");
  ok("the next month's $33: $23 finishes the cancelled line, $10 backs out $0.57 — though only that month was asked for", b.refunded === 3300 && b.n === 1 && b.tax === 57);
  b = await back("06", "07");
  ok("…and both months together say the same", b.refunded === 6300 && b.n === 2 && b.tax === 57);
  const lost = await lib.addOrderPayment(d1, "E", -30, "Entered twice", "", { method: "venmo", kind: "refund", receivedAt: day("06", 9) });
  d1._raw.run("UPDATE order_payments SET voidedAt = 't' WHERE id = ?", [lost]);
  ok("a voided refund uses none of it up", (await back("06", "07")).tax === 57);

  console.log("\n=== A whole order refunded, nothing cancelled (as before) ===");
  await order("F", "08", [[53, true]]);
  await refund("F", 53, day("08", 10));
  t = await due("08");
  ok("the $53 refund backs out its $3: collected $3, refunded $3, $0 due", cents(t.taxCollected) === 300 && cents(t.taxRefunded) === 300 && cents(t.totalDue) === 0);
  await order("F2", "08", [[53, true], [20, false]]);
  await refund("F2", 7.3, day("08", 12));
  ok("a partial refund still goes by the order's taxable share ($5.30 of $7.30 → $0.30)", (await back("08")).tax === 300 + 30);

  console.log("\n=== The refund's shipping part ===");
  ids = await order("G", "09", [[53, true], [53, true]], { shippingCost: 8 });
  await cancel(ids[0], day("09", 10)); await refund("G", 71, day("09", 10), 8);
  t = await due("09");
  ok("$71 back, $8 of it shipping: the $63 of goods covers the cancelled $53, and $10 backs out $0.57", cents(t.taxRefunded) === 57 && cents(t.totalDue) === 243);

  console.log("\n=== Tax added on top ===");
  ids = await order("H", "10", [[50, true], [50, true]], { taxMode: "exclusive" });
  await cancel(ids[0], day("10", 10)); await refund("H", 53, day("10", 10));
  t = await due("10");
  ok("a $50 line plus its $3 tax cancelled and refunded $53: the other line's $3 is still due", cents(t.taxCollected) === 300 && cents(t.taxRefunded) === 0 && cents(t.totalDue) === 300);
  await refund("H", 10.6, day("10", 12));
  ok("…and $10.60 more backs out its $0.60", cents((await due("10")).taxRefunded) === 60);

  console.log("\n=== Every line cancelled ===");
  ids = await order("I", "11", [[53, true]], { shippingCost: 8 });
  await cancel(ids[0], day("11", 10)); await refund("I", 61, day("11", 10));
  t = await due("11");
  ok("the order has no tax left in collected, and its $61 refund (the line and the shipping) takes none off: $0 due, not less", cents(t.taxCollected) === 0 && cents(t.taxRefunded) === 0 && cents(t.totalDue) === 0);
  ok("…the refund is still reported", (await back("11")).refunded === 6100);

  console.log("\n=== A discount stays on the lines that are left ===");
  ids = await order("J", "12", [[50, true], [50, true]]);
  await lib.setOrderDiscount(d1, "J", 20, "Team discount");
  await cancel(ids[0], day("12", 10)); await lib.setOrderDiscount(d1, "J", 20, "Team discount"); await refund("J", 50, day("12", 10));
  t = await due("12");
  ok("$20 off two $50 lines, one cancelled and refunded $50: tax on the $30 kept ($1.70) is due", cents(t.taxCollected) === 170 && cents(t.taxRefunded) === 0 && cents(t.totalDue) === 170);
  ids = await order("K", "12", [[50, true], [50, true]]);
  await lib.setOrderDiscount(d1, "K", 70, "Sponsor");
  await cancel(ids[0], day("12", 11)); await lib.setOrderDiscount(d1, "K", 70, "Sponsor"); await refund("K", 30, day("12", 11));
  t = await due("12");
  ok("a discount bigger than what's left ($70 off, $50 left): the $30 paid goes back with no tax, nothing below $0", cents(t.taxRefunded) === 0 && cents(t.totalDue) === 170);
  await refund("K", 5, day("12", 12));
  ok("…and a further $5 does back tax out ($0.28)", cents((await due("12")).taxRefunded) === 28);

  console.log("\n=== The reports agree ===");
  const year = ["2025-01-01T00:00:00.000Z", "2025-12-31T23:59:59.999Z"];
  const ret = (await lib.getSalesTaxReturn(d1, ...year)).total;
  const refunds = await lib.getSalesTaxRefunds(d1, ...year);
  ok("the return's refunded tax is the refunds list's, to the cent", cents(ret.taxRefunded) === refunds.reduce((s, r) => s + cents(r.taxRefunded), 0) && cents(ret.taxRefunded) > 0);
  const rep = await lib.getSalesTaxReport(d1, ...year);
  ok("the by-state report and the return collect the same tax", rep.reduce((s, r) => s + cents(r.taxCollected), 0) === cents(ret.taxCollected));
  ok("an order with no refund in the period isn't walked", (await lib.getSalesTaxRefunds(d1, "2024-01-01T00:00:00.000Z", "2024-12-31T23:59:59.999Z")).length === 0);

  if (failed) { console.error(failed + " check(s) failed"); process.exit(1); }
})().catch((e) => { console.error("Error:", e); process.exit(1); });
