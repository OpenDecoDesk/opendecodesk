process.env.TZ = "UTC";
// Net 30 and customer-supplied garments (migrations/0121, phase 7) — the db.js corners the other phase 7 tests don't
// reach: a value that is missing or not a date, a database error that isn't "before the migration" (it must not be
// taken for an older database), a database part-way through its updates (before 0060, before 0121, a column renamed
// away), and answers read back with fields left empty.
//   * the due-date helpers with a day that isn't one;
//   * setOrderTerms / insertOrder when the customer's own days can't be read, Accept PO with nobody named, Accept PO and
//     markInvoiced_ with no order id;
//   * the Unpaid POs report: a shop no longer in the list, an order with no placed time, a database whose Net 30 columns
//     are only part there, a database answer with no results list;
//   * the "no blank needed" SQL and the blank-use / mark-made reads before migrations/0060, and with the garment
//     columns but not the finished-stock one; the order's blank roll-up before migrations/0121;
//   * quote lines that aren't the customer's own, one of them not taxed;
//   * garment check-ins: rows read back with empty fields or a condition outside the three, a count left blank, a
//     check-in with no time given, no line named, the check-in table gone, and database errors passed on.
// Real SQL (sql.js) under the real db.js. "Now" is fixed (2026-11-20 15:00 UTC) inside the code under test.
// Invented shops and people only.
const fs = require("fs");
const { ok } = require("./testlib/check");
const { createD1 } = require("./testlib/d1-shim.js");

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/^import "[^"\n]+";\n/gm, "").replace(/export (async function|function|const)/g, "$1");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const NOW_ISO = "2026-11-20T15:00:00.000Z";
const NOW = Date.parse(NOW_ISO);
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(NOW); }
  static now() { return NOW; }
}
globalThis.__FixedDate408 = FixedDate;
const lib = new Function("const Date = globalThis.__FixedDate408;\n" + strip(read("functions/_lib/db.js")) + `\nreturn { insertOrder, getOrderById,
  setOrderTerms, acceptOrderPo, markInvoiced_, getUnpaidPoReport, net30DueDate_, addDaysYmd_, daysBetweenYmd_, hasNet30Column_, hasOwnGarmentColumn_,
  noBlankLine_, noBlankLineSql_, consumeBlanksForOrder, markItemPieceManufactured, setOrderDates, setFeatures, createEstimate, saveEstimateItems,
  checkInGarments, listGarmentCheckins, garmentCheckinsByItem_ };`)();

const logged = [];
console.error = (...a) => { logged.push(a.map(String).join(" ")); };
const migrationFiles = fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort();
async function freshDb(before) {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of migrationFiles) if (!before || f < before) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('club','club','Example Club','t','t',1);
    INSERT INTO global_settings (key, value) VALUES ('locale', '{"timeZone":"America/Chicago","country":"US"}');`);
  return d1;
}
const qs = (s) => s == null ? "NULL" : "'" + String(s).replace(/'/g, "''") + "'";
// One order with one line, written straight to the tables.
const seed = (d1, o) => {
  const cols = Object.keys(o.cols || {});
  d1._raw.exec(`INSERT INTO orders (orderId, orgId, customerName, contact, placedAt${cols.map(c => ", " + c).join("")})
    VALUES (${qs(o.id)}, ${qs(o.org || "club")}, 'Pat Example', 'pat@example.com', ${qs(o.placedAt == null ? "2026-11-02T18:00:00.000Z" : o.placedAt)}${cols.map(c => ", " + (typeof o.cols[c] === "number" ? o.cols[c] : qs(o.cols[c]))).join("")})`);
  const icols = Object.keys(o.item || {});
  d1._raw.exec(`INSERT INTO order_items (orderId, orgId, productId, name, type, size, qty, lineTotalCents${icols.map(c => ", " + c).join("")})
    VALUES (${qs(o.id)}, ${qs(o.org || "club")}, 'tee', 'Club Tee', 'shirt', 'L', ${o.qty || 1}, ${o.cents == null ? 4200 : o.cents}${icols.map(c => ", " + (typeof o.item[c] === "number" ? o.item[c] : qs(o.item[c]))).join("")})`);
  return Number(d1.q("SELECT id FROM order_items WHERE orderId = ? ORDER BY id DESC", o.id)[0].id);
};
const rejectsWith = async (fn, msg) => { try { await fn(); return false; } catch (e) { return String(e && e.message) === msg; } };
// A database that answers every query with an error that isn't about a missing column.
const LOCKED = "database is locked";
const lockedDb = () => {
  const fail = async () => { throw new Error(LOCKED); };
  const stmt = { bind: () => stmt, all: fail, first: fail, run: fail };
  return { prepare: () => stmt, batch: fail };
};
// The real database, but the queries `match` picks answer with `answer` (a statement's all()), or the batch fails.
const wrapDb = (d1, { match, answer, batchError } = {}) => ({
  prepare(sql) {
    const real = d1.prepare(sql);
    if (!match || !match.test(sql)) return real;
    const stmt = { bind: (...a) => { real.bind(...a); return stmt; }, all: async () => answer, first: () => real.first(), run: () => real.run() };
    return stmt;
  },
  batch: batchError ? async () => { throw new Error(batchError); } : (s) => d1.batch(s),
});
const GARMENTS_NOT_READY = "Customer-supplied garments aren't ready yet: the database needs its latest update (migrations/0121).";

(async () => {
  console.log("=== The due-date helpers, with a day that isn't one ===");
  ok("adding days to something that isn't a day gives no day", lib.addDaysYmd_("not a day", 30) === "" && lib.addDaysYmd_("2026-11-02", 30) === "2026-12-02");
  ok("days between two days, when either isn't a day, is none", lib.daysBetweenYmd_("", "2026-11-20") === 0 && lib.daysBetweenYmd_("2026-11-20", "soon") === 0 &&
    lib.daysBetweenYmd_("2026-11-10", "2026-11-20") === 10);
  ok("a Net 30 order placed on a day that doesn't exist (month 13) has no due date",
    lib.net30DueDate_({ net30: true, placedAt: "2026-13-45" }, { defaultDays: 30, startsAt: "order" }, null, "America/Chicago") === "" &&
    lib.net30DueDate_({ net30: true, placedAt: "2026-11-02" }, { defaultDays: 30, startsAt: "order" }, null, "America/Chicago") === "2026-12-02");

  console.log("\n=== A database error that isn't a missing column is passed on, not taken for an older database ===");
  ok("the Net 30 column check passes the error on", await rejectsWith(() => lib.hasNet30Column_(lockedDb()), LOCKED));
  ok("the garment column check passes the error on", await rejectsWith(() => lib.hasOwnGarmentColumn_(lockedDb()), LOCKED));
  ok("reading an order's check-ins passes the error on", await rejectsWith(() => lib.garmentCheckinsByItem_(lockedDb(), "OWN-1"), LOCKED));
  ok("listing an order's check-ins passes the error on", await rejectsWith(() => lib.listGarmentCheckins(lockedDb(), "OWN-1"), LOCKED));
  ok("checking garments in passes the error on (finding the line)", await rejectsWith(() => lib.checkInGarments(lockedDb(), { orderId: "OWN-1", itemId: 1, counts: [] }), LOCKED));

  const d1 = await freshDb();
  const q = (sql, ...p) => d1.q(sql, ...p);
  const q1 = (sql, ...p) => q(sql, ...p)[0] || null;

  console.log("\n=== Terms: Accept PO with nobody named, and no order id ===");
  seed(d1, { id: "NT-1", cols: { net30: 1, poNumber: "PO-1001", poTypedAt: "2026-11-03T15:00:00.000Z" } });
  let r = await lib.setOrderTerms(d1, "NT-1", { accept: true, by: null, now: "2026-11-04T15:00:00.000Z" });
  ok("setOrderTerms accepting the customer's PO with nobody named: accepted now, by no one", r.ok === true && r.cleared === true &&
    r.after.poAcceptedAt === "2026-11-04T15:00:00.000Z" && r.after.poAcceptedBy === "" &&
    same(q1("SELECT poAcceptedAt, poAcceptedBy FROM orders WHERE orderId = 'NT-1'"), { poAcceptedAt: "2026-11-04T15:00:00.000Z", poAcceptedBy: "" }));
  ok("Accept PO with no order id: the order wasn't found", same(await lib.acceptOrderPo(d1, undefined), { error: "That order wasn't found." }));
  await lib.markInvoiced_(d1, null);
  ok("marking no order invoiced changes nothing", q1("SELECT COUNT(*) AS n FROM orders WHERE invoicedAt IS NOT NULL").n === 0);

  console.log("\n=== The Unpaid POs report: a shop that's gone, an order with no placed time ===");
  // A shop whose row is no longer there (written with the key check off, as an order left behind would be).
  d1._raw.exec("PRAGMA foreign_keys = OFF");
  seed(d1, { id: "GONE-1", org: "oldshop", cols: { net30: 1, poNumber: "PO-1002", poAcceptedAt: "2026-11-02T18:00:00.000Z" }, cents: 5000 });
  d1._raw.exec("PRAGMA foreign_keys = ON");
  seed(d1, { id: "NOTIME-1", placedAt: "", cols: { net30: 1 }, cents: 3000 });
  let rep = await lib.getUnpaidPoReport(d1, { asOf: "2026-11-20", tz: "America/Chicago" });
  const gone = rep.rows.find(x => x.orderId === "GONE-1"), noTime = rep.rows.find(x => x.orderId === "NOTIME-1");
  ok("an order of a shop no longer in the list shows the shop's id for its name", !!gone && gone.orgName === "oldshop" && gone.owedCents === 5000 && gone.completedAt === "");
  ok("an order with no placed time is listed with none (and no due date yet: it has no PO)", !!noTime && noTime.placedAt === "" && noTime.dueDate === "" && noTime.group === "nopo");
  rep = await lib.getUnpaidPoReport(wrapDb(d1, { match: /receivedCents/, answer: {} }), { asOf: "2026-11-20", tz: "America/Chicago" });
  ok("a database answer with no results list is an empty report", rep.rows.length === 0 && rep.totals.count === 0 && rep.asOf === "2026-11-20");

  console.log("\n=== Quote lines that aren't the customer's own, one not taxed ===");
  d1._raw.exec("INSERT INTO customers (id, name, email, createdAt, updatedAt) VALUES (1, 'Pat Example', 'pat@example.com', 't', 't')");
  const est = await lib.createEstimate(d1, { orgId: "club", customerId: 1, title: "Example Club tees" });
  r = await lib.saveEstimateItems(d1, est.id, [{ kind: "custom", name: "Patch", qty: 2, unitPrice: 4 }, { kind: "custom", name: "Digitizing", qty: 1, unitPrice: 10, taxable: false }]);
  ok("custom lines saved without the mark are not the customer's own, and the one marked not taxed is saved untaxed", !r.error &&
    same(q("SELECT name, customerOwned, taxable FROM estimate_items WHERE estimateId = ? ORDER BY id", est.id), [{ name: "Patch", customerOwned: 0, taxable: 1 }, { name: "Digitizing", customerOwned: 0, taxable: 0 }]));

  console.log("\n=== Garment check-ins: empty fields, a blank count, no time given, no line named ===");
  await lib.setFeatures(d1, { ownGarments: true });
  const own = seed(d1, { id: "OWN-1", qty: 2, item: { customerOwned: 1 } });
  ok("checking in with no order or line named: the line isn't on this order",
    same(await lib.checkInGarments(d1, { counts: [{ size: "L", expectedQty: 1, receivedQty: 1 }] }), { error: "That line isn't on this order." }));
  r = await lib.checkInGarments(d1, { orderId: "OWN-1", itemId: own, counts: [{ size: "L", expectedQty: "", receivedQty: null }], by: "pat@example.com", at: "2026-11-05T15:00:00.000Z" });
  ok("a count left blank is 0 of 0 (as expected, so no note needed), and nothing is in yet", r.ok === true && r.received === 0 && r.ownReceivedAt === "" &&
    r.checkins.length === 1 && r.checkins[0].expectedQty === 0 && r.checkins[0].receivedQty === 0 && r.checkins[0].condition === "good");
  r = await lib.checkInGarments(d1, { orderId: "OWN-1", itemId: own, counts: [{ size: "L", expectedQty: 2, receivedQty: 2 }] });
  ok("a check-in with no time given is dated now, and the line is in from now", r.ok === true && r.ownReceivedAt === NOW_ISO && r.checkins[0].at === NOW_ISO &&
    q1("SELECT ownReceivedAt FROM order_items WHERE id = ?", own).ownReceivedAt === NOW_ISO && r.checkins[0].by === "");
  d1._raw.exec("PRAGMA ignore_check_constraints = 1");
  d1._raw.exec(`INSERT INTO garment_checkins (orderId, itemId, size, expectedQty, receivedQty, condition, note, at, by) VALUES ('OWN-1', ${own}, '', 0, 0, 'lost', '', '', '')`);
  d1._raw.exec("PRAGMA ignore_check_constraints = 0");
  const odd = (await lib.listGarmentCheckins(d1, "OWN-1")).slice(-1)[0];
  ok("a row read back with empty fields and a condition outside the three: blanks, zeros and 'other'",
    same(odd && { size: odd.size, expectedQty: odd.expectedQty, receivedQty: odd.receivedQty, condition: odd.condition, note: odd.note, at: odd.at, by: odd.by, voidedAt: odd.voidedAt },
      { size: "", expectedQty: 0, receivedQty: 0, condition: "other", note: "", at: "", by: "", voidedAt: "" }));
  ok("listing the check-ins of no order is an empty list", same(await lib.listGarmentCheckins(d1, null), []));
  ok("reading the live check-ins of no order is an empty map", (await lib.garmentCheckinsByItem_(d1, undefined)).size === 0);

  console.log("\n=== Garment check-ins: database answers with no results list, and errors ===");
  const noList = wrapDb(d1, { match: /FROM garment_checkins/, answer: {} });
  ok("listing check-ins when the database answers with no results list: an empty list", same(await lib.listGarmentCheckins(noList, "OWN-1"), []));
  r = await lib.checkInGarments(noList, { orderId: "OWN-1", itemId: own, counts: [{ size: "L", expectedQty: 2, receivedQty: 2 }], at: "2026-11-06T15:00:00.000Z" });
  ok("a check-in whose rows can't be read back still succeeds, with no rows to show", r.ok === true && same(r.checkins, []) && same(r.before, []) && r.received === 2);
  const before = q1("SELECT COUNT(*) AS n FROM garment_checkins").n;
  ok("a check-in whose write fails with another error passes it on, and nothing is written",
    await rejectsWith(() => lib.checkInGarments(wrapDb(d1, { batchError: LOCKED }), { orderId: "OWN-1", itemId: own, counts: [{ size: "L", expectedQty: 2, receivedQty: 2 }] }), LOCKED) &&
    q1("SELECT COUNT(*) AS n FROM garment_checkins").n === before);

  console.log("\n=== Garment check-ins: the check-in table gone ===");
  {
    const g = await freshDb();
    await lib.setFeatures(g, { ownGarments: true });
    const line = seed(g, { id: "OWN-2", item: { customerOwned: 1 } });
    g._raw.exec("DROP TABLE garment_checkins");
    ok("reading an order's check-ins without the table: an empty map", (await lib.garmentCheckinsByItem_(g, "OWN-2")).size === 0);
    ok("checking garments in without the table: the database needs its update, and the line isn't in",
      same(await lib.checkInGarments(g, { orderId: "OWN-2", itemId: line, counts: [{ size: "L", expectedQty: 1, receivedQty: 1 }] }), { error: GARMENTS_NOT_READY }) &&
      g.q("SELECT ownReceivedAt FROM order_items WHERE id = ?", line)[0].ownReceivedAt === null);
  }

  console.log("\n=== The customer's own days can't be read (a database part-way through its update) ===");
  {
    const c = await freshDb();
    c._raw.exec(`INSERT INTO customers (id, name, email, createdAt, updatedAt) VALUES (1, 'Pat Example', 'pat@example.com', 't', 't');
      ALTER TABLE customers RENAME COLUMN termsDays TO termsDaysOld;`);
    seed(c, { id: "CU-1", cols: { customerId: 1 } });
    r = await lib.setOrderTerms(c, "CU-1", { net30: true, by: "pat@example.com" });
    ok("setOrderTerms turning Net 30 on: still on, with the default days", r.ok === true && r.after.net30 === true && r.after.termsDays === null &&
      same(c.q("SELECT net30, termsDays FROM orders WHERE orderId = 'CU-1'"), [{ net30: 1, termsDays: null }]));
    await lib.insertOrder(c, { orderId: "CU-2", orgId: "club", customerName: "Pat Example", contact: "pat@example.com", placedAt: "2026-11-02T18:00:00.000Z", net30: true, poNumber: "PO-1001", poAcceptedBy: "pat@example.com" },
      [{ productId: "__custom__", name: "Logo", type: "other", size: "L", qty: 1, unitPrice: 5 }]);
    ok("a Net 30 order placed for that customer: on Net 30 with the default days and its PO accepted",
      same(c.q("SELECT net30, termsDays, poNumber, customerId FROM orders WHERE orderId = 'CU-2'"), [{ net30: 1, termsDays: null, poNumber: "PO-1001", customerId: 1 }]));
  }

  console.log("\n=== The Unpaid POs report with the Net 30 columns only part there ===");
  {
    const p = await freshDb();
    seed(p, { id: "PART-1", cols: { net30: 1, poNumber: "PO-1001", poAcceptedAt: "2026-11-02T18:00:00.000Z" } });
    p._raw.exec("ALTER TABLE orders RENAME COLUMN invoicedAt TO invoicedAtOld");
    rep = await lib.getUnpaidPoReport(p, { asOf: "2026-11-20", tz: "America/Chicago" });
    ok("an empty report, as before the update, for the as-of day asked", rep.rows.length === 0 && rep.asOf === "2026-11-20" && rep.groups.length === 7 && rep.totals.owedCents === 0);
  }

  console.log("\n=== The order's blank roll-up before migrations/0121 ===");
  {
    const o = await freshDb("0121");
    seed(o, { id: "OLD-1" });
    await lib.setOrderDates(o, "OLD-1", { blankOrderedAt: "2026-11-03T15:00:00.000Z", blankReceivedAt: "2026-11-04T15:00:00.000Z" });
    ok("receiving the blanks there marks the order's blanks in (no garment lines to wait on)",
      same(o.q("SELECT blankOrderedAt, blankReceivedAt FROM orders WHERE orderId = 'OLD-1'"), [{ blankOrderedAt: "2026-11-03T15:00:00.000Z", blankReceivedAt: "2026-11-04T15:00:00.000Z" }]));
  }

  console.log("\n=== Before migrations/0060 (no finished stock yet) ===");
  {
    const o = await freshDb("0060");
    ok("the 'no blank needed' SQL is the plain one (no finished stock, no customer's garments)", (await lib.noBlankLine_(o)) === lib.noBlankLineSql_);
    seed(o, { id: "OLD-2", qty: 2 });
    const line = Number(o.q("SELECT id FROM order_items WHERE orderId = 'OLD-2'")[0].id);
    await lib.markItemPieceManufactured(o, "OLD-2", line, "2026-11-05T15:00:00.000Z");
    ok("one piece is marked made there", Number(o.q("SELECT manufacturedQty FROM order_items WHERE id = ?", line)[0].manufacturedQty) === 1);
    await lib.consumeBlanksForOrder(o, "OLD-2", "2026-11-06T15:00:00.000Z");
    ok("…and the rest of the order is made there", Number(o.q("SELECT manufacturedQty FROM order_items WHERE id = ?", line)[0].manufacturedQty) === 2);
  }
  {
    const o = await freshDb("0060");
    o._raw.exec("ALTER TABLE order_items ADD COLUMN customerOwned INTEGER NOT NULL DEFAULT 0; ALTER TABLE order_items ADD COLUMN ownReceivedAt TEXT;");
    const sql = (await lib.noBlankLine_(o))("oi");
    ok("with the garment columns but not the finished-stock one: the SQL counts the customer's garments, not finished stock",
      sql.includes("COALESCE(oi.customerOwned, 0) = 1") && !sql.includes("fromStock") && sql.startsWith("(" + lib.noBlankLineSql_("oi")));
  }

  ok("nothing was logged as an unexpected failure", !logged.some(l => /TypeError|ReferenceError|SyntaxError/.test(l)));
})().catch((e) => { console.log("crashed — " + (e && e.stack || e)); process.exitCode = 1; });
