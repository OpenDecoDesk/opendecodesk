const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// A guarded write (UPDATE / INSERT … SELECT … WHERE <stock still as read>) took its row when D1's meta.changes is
// above 0 — NOT exactly 1: D1 also counts the rows the statement's triggers change (migrations/0102's list-cache
// versions on blank_sizes, 0103's month-end snapshot clean-up on the three movement tables). Checking "exactly 1"
// made Make for stock answer 409 after it had made the pieces, and a stock count answer "the stock changed" after
// it had saved, once a month-end snapshot existed (db.js tookRow_). The test D1 (testlib/d1-shim.js) counts the
// triggers' rows the same way, so a check like that fails here too.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const lib = new Function(strip(read("functions/_lib/db.js")) +
  `\nreturn { createBlank, receiveBlanks, createTransfer, receiveTransferSheet, setBlankCount, setTransferCount };`)();

let passed = 0, failed = 0;
const ok = (label, cond) => { cond ? passed++ : failed++; console.log(label + ": " + !!cond); };

(async () => {
  console.log("=== The test D1 counts trigger rows, as D1 does ===");
  {
    const d1 = await createD1();
    d1._raw.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, q INTEGER); CREATE TABLE v (name TEXT PRIMARY KEY, n INTEGER); INSERT INTO t VALUES (1, 5); INSERT INTO v VALUES ('x', 0);");
    const plain = await d1.prepare("UPDATE t SET q = q - 1 WHERE id = 1 AND q >= 1").run();
    d1._raw.exec("CREATE TRIGGER tr AFTER UPDATE ON t BEGIN UPDATE v SET n = n + 1 WHERE name = 'x'; END;");
    const withTrigger = await d1.prepare("UPDATE t SET q = q - 1 WHERE id = 1 AND q >= 1").run();
    const lost = await d1.prepare("UPDATE t SET q = q - 1 WHERE id = 1 AND q >= 100").run();
    const [inBatch] = await d1.batch([d1.prepare("UPDATE t SET q = q - 1 WHERE id = 1 AND q >= 1")]);
    ok("one row, no trigger: 1", plain.meta.changes === 1);
    ok("one row and its trigger's row: 2 (what D1 answers)", withTrigger.meta.changes === 2);
    ok("in a batch too: 2", inBatch.meta.changes === 2);
    ok("a guarded write that lost the race changes nothing and fires no trigger: 0", lost.meta.changes === 0);
  }

  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  // A month-end snapshot (migrations/0103) for October: a count dated in October deletes it through the trigger.
  const snapshot = () => d1._raw.run("INSERT OR REPLACE INTO inventory_period_snapshots (month, kind, key, qty, avgCents, name, label) VALUES ('2026-10', 'blank', '#complete', 0, 0, '', '')");
  const snapshots = () => d1.q("SELECT COUNT(*) n FROM inventory_period_snapshots")[0].n;

  console.log("\n=== Count stock with a month-end snapshot in place ===");
  const b = (await lib.createBlank(d1, { name: "Count Tee", productType: "tee", colors: [{ color: "Black", images: [], sizes: [{ size: "M", purchasePrice: 0, quantity: 0 }] }] })).id;
  await lib.receiveBlanks(d1, { blankId: b, lines: [{ color: "Black", size: "M", qty: 10, unitCost: 4 }], receivedAt: "2026-09-01T12:00:00.000Z" });
  snapshot();
  let err = null;
  try { await lib.setBlankCount(d1, { blankId: b, color: "Black", size: "M", counted: 7, onHand: 10, at: "2026-10-15T15:00:00.000Z" }); } catch (e) { err = e; }
  ok("a blank count dated in a snapshot's month is taken, not refused as 'the stock changed'", !err);
  ok("…the stock is 7", d1.q("SELECT quantity q FROM blank_sizes WHERE blankId=? AND size='M'", b)[0].q === 7);
  ok("…and the stale snapshot is gone", snapshots() === 0);
  err = null;
  try { await lib.setBlankCount(d1, { blankId: b, color: "Black", size: "M", counted: 5, onHand: 10 }); } catch (e) { err = e; }
  ok("a count made from an old reading is still refused", !!err && /stock changed/i.test(err.message) &&
    d1.q("SELECT quantity q FROM blank_sizes WHERE blankId=? AND size='M'", b)[0].q === 7);

  const t = await lib.createTransfer(d1, { name: "Count chest" });
  await lib.receiveTransferSheet(d1, { rows: [{ transferId: t, count: 20, pctOfSheet: 100 }], totalCents: 4000, receivedAt: "2026-09-02" });
  snapshot();
  err = null;
  try { await lib.setTransferCount(d1, { transferId: t, counted: 16, onHand: 20, at: "2026-10-20T10:00:00.000Z" }); } catch (e) { err = e; }
  ok("a transfer count dated in a snapshot's month is taken", !err && d1.q("SELECT quantity q FROM transfers WHERE id=?", t)[0].q === 16);
  ok("…and the stale snapshot is gone", snapshots() === 0);

  console.log("\n=== No exact-one checks left ===");
  const src = read("functions/_lib/db.js");
  ok("db.js compares no meta.changes to exactly 1 (tookRow_ instead)", !/meta\.changes\)?\s*[!=]==\s*1\b/.test(src) && /function tookRow_\(/.test(src));

  console.log(`\n${failed ? "FAILURES" : "ALL PASS"} — ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})().catch(e => { console.error(e); console.log("crashed: false"); process.exitCode = 1; });
