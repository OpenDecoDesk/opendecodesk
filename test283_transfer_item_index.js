const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// The transfers an order line used are looked up by the line (2026-11, review round 2). transfer_movements grows with
// every finished line and every sheet bought, and had no index on itemId — the one NAMED idx_transfer_movements_item
// is on (transferId, occurredAt) — so the Transfers queue, finishing a configurable line, the catch-up plan and the
// order refresh each read the whole table, once per line for the correlated ones. migrations/0106 adds
// idx_transfer_movements_itemId (only rows that have a line: purchases, counts and write-offs don't). This checks the
// database's own plan (EXPLAIN QUERY PLAN) for each of those lookups, as db.js writes them.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const INDEX = "idx_transfer_movements_itemId";

// The lookups, each with the piece of db.js it stands for (so a change there is noticed here).
const LOOKUPS = [
  { what: "the line's live uses, counted when a line is finished or a movement restored (consumeLineTransfersOnce_, the void / restore guard)",
    inDb: [`SELECT COUNT(*) n FROM transfer_movements WHERE itemId=? AND kind='consume' AND voidedAt IS NULL`, `(SELECT COUNT(*) FROM transfer_movements WHERE itemId = ? AND kind = 'consume' AND voidedAt IS NULL)`],
    sql: `SELECT COUNT(*) n FROM transfer_movements WHERE itemId=? AND kind='consume' AND voidedAt IS NULL`, binds: [1] },
  { what: "the Transfers queue: which of these lines already used their transfers (transfersInHand_)",
    inDb: ["SELECT DISTINCT itemId FROM transfer_movements WHERE kind='consume' AND voidedAt IS NULL AND itemId IN ("],
    sql: `SELECT DISTINCT itemId FROM transfer_movements WHERE kind='consume' AND voidedAt IS NULL AND itemId IN (?,?,?)`, binds: [1, 2, 3] },
  { what: "refreshing an order's lines from the catalog: has each line used stock (refreshOrderLinesFromCatalog)",
    inDb: ["EXISTS (SELECT 1 FROM transfer_movements m WHERE m.itemId = i.id AND m.kind = 'consume' AND m.voidedAt IS NULL) AS usedStock"],
    sql: `SELECT i.id, EXISTS (SELECT 1 FROM transfer_movements m WHERE m.itemId = i.id AND m.kind = 'consume' AND m.voidedAt IS NULL) AS usedStock FROM order_items i WHERE i.orderId = ?`, binds: ["O1"] },
  { what: "the catch-up plan: made lines with no live use, and the reason a use was voided (planTransferCatchUp)",
    inDb: ["(SELECT m.voidReason FROM transfer_movements m WHERE m.itemId = i.id AND m.kind = 'consume' AND m.voidedAt IS NOT NULL ORDER BY m.id DESC LIMIT 1) AS voidedUse",
      "AND NOT EXISTS (SELECT 1 FROM transfer_movements m WHERE m.itemId = i.id AND m.kind = 'consume' AND m.voidedAt IS NULL)"],
    sql: `SELECT i.id, (SELECT m.voidReason FROM transfer_movements m WHERE m.itemId = i.id AND m.kind = 'consume' AND m.voidedAt IS NOT NULL ORDER BY m.id DESC LIMIT 1) AS voidedUse
          FROM order_items i WHERE i.orderId = ? AND NOT EXISTS (SELECT 1 FROM transfer_movements m WHERE m.itemId = i.id AND m.kind = 'consume' AND m.voidedAt IS NULL)`, binds: ["O1"] },
];

(async () => {
  const dbJs = read("functions/_lib/db.js");
  // The steps of the plan that read transfer_movements (the table's own name, or the alias m).
  const stepsOn = (d1, sql, binds) => d1.q("EXPLAIN QUERY PLAN " + sql, ...binds).map(r => String(r.detail)).filter(t => /\b(transfer_movements|m)\b/.test(t.replace(/USING .*/, "")) && /^(SEARCH|SCAN)/.test(t));
  const usesIndex = (steps) => steps.length > 0 && steps.every(t => t.startsWith("SEARCH") && t.includes(`USING INDEX ${INDEX} (itemId=?)`));

  for (const [label, build] of [["a database brought up to date by the migrations", (d1) => { d1._raw.exec(read("testlib/schema-pre-0006.sql")); for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f)); }],
    ["a new install (schema.sql)", (d1) => d1._raw.exec(read("schema.sql"))]]) {
    console.log(`=== ${label} ===`);
    const d1 = await createD1();
    build(d1);
    const idx = d1.q("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?", INDEX)[0];
    ok("has the index on transfer_movements(itemId), for rows that have a line", !!idx && /ON transfer_movements\s*\(itemId\)\s+WHERE itemId IS NOT NULL/i.test(idx.sql));
    for (const q of LOOKUPS) {
      const steps = stepsOn(d1, q.sql, q.binds);
      ok(`${q.what}: found through the index`, usesIndex(steps) || (console.log("   plan:", steps), false));
    }
    // Without it — the database as it was — the same lookups walk the table (or build a throwaway index each time).
    d1._raw.exec(`DROP INDEX ${INDEX}`);
    const before = LOOKUPS.map(q => stepsOn(d1, q.sql, q.binds));
    ok("without the index none of them could: each read the whole table, or built its own index every time", before.every(steps => steps.length > 0 && steps.every(t => !t.includes(INDEX) && (/^SCAN/.test(t) || /AUTOMATIC/.test(t)))));
  }

  console.log("=== The code and the files ===");
  ok("db.js still writes each of those lookups the way it's checked here", LOOKUPS.every(q => q.inDb.every(piece => dbJs.includes(piece))) || (console.log(LOOKUPS.flatMap(q => q.inDb.filter(p => !dbJs.includes(p)))), false));
  const mig = read("migrations/0106_orphan_scan_transfer_item_index.sql"), schema = read("schema.sql");
  const line = /CREATE INDEX IF NOT EXISTS idx_transfer_movements_itemId\s+ON transfer_movements\(itemId\) WHERE itemId IS NOT NULL;/;
  ok("migration 0106 and schema.sql both create it", line.test(mig) && line.test(schema));
  ok("the older index keeps its name and says what it's really on", /idx_transfer_movements_item\s+ON transfer_movements\(transferId, occurredAt\)/.test(schema) && /despite its name, the index above is by transfer/.test(schema));

  console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error(e); console.log("test283 crashed: false"); process.exit(1); });
