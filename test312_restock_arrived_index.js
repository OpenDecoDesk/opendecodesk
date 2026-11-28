const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// Has restock on order arrived? (2026-11, review round 2.) The Blanks and Blanks to Order screens ask, for the restock
// ordered in the last 45 days, whether a purchase of that blank / color / size was recorded after the order
// (db.js restockOnOrder_): purchases still in force recorded since then. inventory_movements gets a row for every made
// line, and nothing indexed createdAt, so that read went through the whole table every time. migrations/0109 adds a
// partial index of the purchases still in force by createdAt; the question asked, and so the answer, is unchanged.
// This checks the database's own plan (EXPLAIN QUERY PLAN) for the read as db.js writes it, and the answer.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const INDEX = "idx_movements_purchase_created";
const SQL = "SELECT blankId, color, size, MAX(createdAt) AS last FROM inventory_movements WHERE kind='purchase' AND voidedAt IS NULL AND createdAt >= ? GROUP BY blankId, color, size";

(async () => {
  const dbJs = read("functions/_lib/db.js");
  const steps = (d1) => d1.q("EXPLAIN QUERY PLAN " + SQL, "2026-10-01T00:00:00.000Z").map(r => String(r.detail)).filter(t => /^(SEARCH|SCAN)/.test(t));
  const migrated = async () => { const d1 = await createD1(); d1._raw.exec(read("testlib/schema-pre-0006.sql"));
    for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f)); return d1; };
  for (const [label, build] of [["a database brought up to date by the migrations", migrated], ["a new install (schema.sql)", async () => { const d1 = await createD1(); d1._raw.exec(read("schema.sql")); return d1; }]]) {
    console.log(`=== ${label} ===`);
    const d1 = await build();
    const idx = d1.q("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?", INDEX)[0];
    ok("has the index of purchases still in force, by when they were recorded", !!idx && /ON inventory_movements\s*\(createdAt\)\s+WHERE kind = 'purchase' AND voidedAt IS NULL/i.test(idx.sql));
    const s = steps(d1);
    ok("the 'arrived?' read searches it for the last 45 days", s.length === 1 && s[0].includes(`SEARCH inventory_movements USING INDEX ${INDEX} (createdAt>?)`) || (console.log("   plan:", s), false));
    d1._raw.exec(`DROP INDEX ${INDEX}`);
    const before = steps(d1);
    ok("without it — the database as it was — the read goes through the whole table", before.length === 1 && /^SCAN inventory_movements/.test(before[0]));
  }

  console.log("\n=== The answer is unchanged ===");
  const lib = new Function(strip(dbJs) + "\nreturn { restockOnOrder_ };")();
  const d1 = await migrated();
  const now = Date.parse("2026-11-20T12:00:00.000Z"), day = 86400000, iso = (ms) => new Date(ms).toISOString();
  d1._raw.run("INSERT INTO blank_restock_orders (vendor, reference, linesJson, createdAt, createdBy) VALUES ('Example Supply','R1',?,?,'test')",
    [JSON.stringify([{ blankId: 1, color: "Navy", size: "M", qty: 6 }, { blankId: 1, color: "Navy", size: "L", qty: 4 }, { blankId: 2, color: "", size: "OSFA", qty: 3 }, { blankId: 3, color: "", size: "S", qty: 2 }]), iso(now - 10 * day)]);
  const mv = (blankId, color, size, kind, createdAt, voided = null) => d1._raw.run(`INSERT INTO inventory_movements (blankId, color, size, qtyDelta, unitCostCents, kind, occurredAt, createdAt, voidedAt)
    VALUES (?,?,?,?,?,?,?,?,?)`, [blankId, color, size, kind === "consume" ? -1 : 5, 300, kind, createdAt, createdAt, voided]);
  mv(1, "Navy", "M", "purchase", iso(now - 2 * day));                // arrived after the order
  mv(1, "Navy", "L", "purchase", iso(now - 20 * day));               // bought before the order: still on order
  mv(2, "", "OSFA", "purchase", iso(now - 1 * day), iso(now));       // arrived, but that receipt was voided: still on order
  mv(3, "", "S", "consume", iso(now - 1 * day));                     // used, not bought: still on order
  const onOrder = await lib.restockOnOrder_(d1, now);
  ok("arrived after the order: no longer on order; bought before it, voided or not a purchase: still on order",
    JSON.stringify([...onOrder].sort()) === JSON.stringify([["1\u0001Navy\u0001L", 4], ["2\u0001\u0001OSFA", 3], ["3\u0001\u0001S", 2]]) || (console.log("   ", [...onOrder]), false));

  console.log("\n=== The code and the files ===");
  ok("db.js still asks it the way it's checked here", dbJs.includes(`"${SQL}"`));
  const line = /CREATE INDEX IF NOT EXISTS idx_movements_purchase_created ON inventory_movements\(createdAt\) WHERE kind = 'purchase' AND voidedAt IS NULL;/;
  ok("migration 0109 and schema.sql both create it", line.test(read("migrations/0109_growth_indexes.sql")) && line.test(read("schema.sql")));

  console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error(e); console.log("test312 crashed: false"); process.exit(1); });
