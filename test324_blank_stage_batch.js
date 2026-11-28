const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// Blank ordered / shipped / received (db.js setFulfillmentStage) used to update an order's lines one awaited UPDATE
// at a time: a 30-line order was 30-odd round trips per step, and a failure part-way left some lines stamped and
// others not. Now each step sends its lines' updates as one batch (the markItemsBlankOrdered pattern), then rolls
// the order up as before: the same handful of round trips for 3 lines or 30, all lines or none, results unchanged.
// Real SQL (sql.js) and real db.js; the test database's prepare/batch are wrapped to count round trips.
// Invented data only.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const lib = new Function(strip(read("functions/_lib/db.js")) + "\nreturn { insertOrder, getOrderById, setFulfillmentStage };")();

let passed = 0, failed = 0;
const ok = (label, cond) => { cond ? passed++ : failed++; console.log(label + ": " + !!cond); };

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Example Club','t','t');`);

  const trips = { n: 0 };
  const prepare = d1.prepare.bind(d1), batch = d1.batch.bind(d1);
  const counted = (b) => Object.assign(b, { first: ((f) => (...a) => { trips.n++; return f(...a); })(b.first),
    run: ((f) => (...a) => { trips.n++; return f(...a); })(b.run), all: ((f) => (...a) => { trips.n++; return f(...a); })(b.all) });
  d1.prepare = (sql) => { const s = counted(prepare(sql)), bind = s.bind; return Object.assign(s, { bind: (...ps) => counted(bind(...ps)) }); };
  d1.batch = async (stmts) => { trips.n++; return batch(stmts); };

  const mk = (orderId, lines) => lib.insertOrder(d1, { orderId, orgId: "acme", customerName: "Pat Example", contact: "pat@example.test", placedAt: "2026-10-01T00:00:00Z" },
    Array.from({ length: lines }, (_, i) => ({ productId: "p" + i, name: "Tee " + i, type: "shirt", size: "L", qty: 1, unitPrice: 20 })));
  const items = (orderId) => d1.q("SELECT id, blankOrderedAt, blankVendor, blankVendorOrderId, blankEstDelivery, blankShippedAt, blankReceivedAt, blankCondition, blankConditionNote, cancelDate FROM order_items WHERE orderId=? ORDER BY id", orderId);
  const stage = async (orderId, s, extras) => { await lib.getOrderById(d1, orderId); trips.n = 0; await lib.setFulfillmentStage(d1, orderId, s, extras); return trips.n; };
  await mk("B3", 3); await mk("B30", 30);
  // One cancelled line on the big order: never stamped.
  const cancelled = items("B30")[29].id;
  d1._raw.exec(`UPDATE order_items SET cancelDate='2026-10-02T00:00:00Z' WHERE id=${cancelled}`);

  console.log("=== Round trips don't grow with the lines ===");
  const at = "2026-10-03T15:00:00.000Z";
  const o3 = await stage("B3", "blankOrdered", { vendor: "Example Supply", vendorOrderId: "PO-1", estimatedDelivery: "2026-10-09", at });
  const o30 = await stage("B30", "blankOrdered", { vendor: "Example Supply", vendorOrderId: "PO-2", estimatedDelivery: "2026-10-09", at });
  ok("blank ordered: as many round trips for 30 lines as for 3", o30 === o3);
  ok("…and only a handful", o30 <= 6);
  const s3 = await stage("B3", "blankShipped", { at: "2026-10-04T15:00:00.000Z" });
  const s30 = await stage("B30", "blankShipped", { at: "2026-10-04T15:00:00.000Z" });
  ok("blank shipped: the same for 30 lines as for 3, and a handful", s30 === s3 && s30 <= 6);
  const conds = items("B30").slice(0, 2).map((x, i) => ({ itemId: x.id, condition: i ? "Other" : "Good", note: i ? "Stain on sleeve" : "" }));
  const r3 = await stage("B3", "blankReceived", { at: "2026-10-05T15:00:00.000Z" });
  const r30 = await stage("B30", "blankReceived", { at: "2026-10-05T15:00:00.000Z", itemConditions: conds });
  ok("blank received: the same for 30 lines as for 3, and a handful", r30 === r3 && r30 <= 6);

  console.log("\n=== The results are what they were ===");
  const big = items("B30"), live = big.filter(x => !x.cancelDate);
  ok("every active line is stamped ordered, with the vendor order", live.length === 29 && live.every(x => x.blankOrderedAt === at && x.blankVendor === "Example Supply" &&
    x.blankVendorOrderId === "PO-2" && x.blankEstDelivery === "2026-10-09"));
  ok("…shipped and received", live.every(x => x.blankShippedAt === "2026-10-04T15:00:00.000Z" && x.blankReceivedAt === "2026-10-05T15:00:00.000Z"));
  ok("each line's own condition and note; the rest Good", big[0].blankCondition === "Good" && big[1].blankCondition === "Other" && big[1].blankConditionNote === "Stain on sleeve" &&
    live.slice(2).every(x => x.blankCondition === "Good" && x.blankConditionNote === ""));
  ok("the cancelled line is left alone", !big[29].blankOrderedAt && !big[29].blankShippedAt && !big[29].blankReceivedAt);
  const ord = d1.q("SELECT blankOrderedAt, blankReceivedAt, blankVendor, blankCondition FROM orders WHERE orderId='B30'")[0];
  ok("the order rolls up: ordered, received, condition Other", ord.blankOrderedAt === at && ord.blankReceivedAt === "2026-10-05T15:00:00.000Z" &&
    ord.blankVendor === "Example Supply" && ord.blankCondition === "Other");
  await lib.setFulfillmentStage(d1, "B30", "blankOrdered", { vendor: "Other Supply", vendorOrderId: "PO-9", at: "2026-10-06T15:00:00.000Z" });
  ok("ordering again keeps the first time (and takes the new vendor order), as before", items("B30")[0].blankOrderedAt === at && items("B30")[0].blankVendorOrderId === "PO-9");

  console.log("\n=== Chosen lines only, and all of them or none ===");
  await mk("B5", 5);
  const five = items("B5");
  await lib.setFulfillmentStage(d1, "B5", "blankOrdered", { itemIds: [five[1].id, five[3].id], vendor: "Example Supply", at });
  ok("only the chosen lines are stamped; the order isn't ordered yet", items("B5").filter(x => x.blankOrderedAt).map(x => x.id).join() === [five[1].id, five[3].id].join() &&
    !d1.q("SELECT blankOrderedAt FROM orders WHERE orderId='B5'")[0].blankOrderedAt);
  // A line the database refuses (a trigger stands in for a write failing on the fourth line).
  d1._raw.exec(`CREATE TRIGGER t302_refuse BEFORE UPDATE OF blankShippedAt ON order_items WHEN NEW.id = ${five[3].id} BEGIN SELECT RAISE(ABORT, 'refused'); END;`);
  let threw = false;
  try { await lib.setFulfillmentStage(d1, "B5", "blankShipped", { at }); } catch (e) { threw = /refused/.test(e.message); }
  ok("a line that fails fails the step, and no line is marked shipped", threw && items("B5").every(x => !x.blankShippedAt));
  d1._raw.exec("DROP TRIGGER t302_refuse");

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
