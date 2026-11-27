// migrations/0113: owner_notices.kind gains 'picked_up' (carrier pickups queued for the roll-up, test350). SQLite
// can't alter a CHECK, so the table is rebuilt, as 0016 and 0058 did. Checked here: every row (sent or not) keeps its
// id and fields, the unsent-notices index is back, new ids carry on after the old ones, the new kind is accepted and
// an unknown one still refused; a fresh install (schema.sql) and the migration list agree.
const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const refused = (fn) => { try { fn(); return false; } catch (e) { return /CHECK constraint failed/i.test(String(e && e.message)); } };

(async () => {
  const files = fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort();
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of files.filter(f => f < "0113")) d1.execFile(read("migrations/" + f));
  ok("before 0113 a 'picked_up' notice is refused", refused(() => d1._raw.run("INSERT INTO owner_notices (kind, summary, createdAt) VALUES ('picked_up', 'x', 't')")));
  const rows = [
    ["payment", "O1", "club", "Paid $20", "", "[]", 0, "2026-11-01T10:00:00Z", "2026-11-02T06:00:00Z"],
    ["dispute", "O2", "club", "Dispute filed", "Respond by Dec 1", "[]", 1, "2026-11-03T10:00:00Z", null],
    ["invoice", "O3", "club", "Delivery chosen", "", "[\"https://example.test/a.png\"]", 0, "2026-11-04T10:00:00Z", null],
  ];
  for (const r of rows) d1._raw.run("INSERT INTO owner_notices (kind, orderId, orgId, summary, detail, imageUrls, urgent, createdAt, sentAt) VALUES (?,?,?,?,?,?,?,?,?)", r);
  d1._raw.run("DELETE FROM owner_notices WHERE kind = 'payment'");   // a gap: the next id must not reuse it
  d1._raw.run("INSERT INTO owner_notices (kind, orderId, orgId, summary, detail, imageUrls, urgent, createdAt, sentAt) VALUES (?,?,?,?,?,?,?,?,?)", rows[0]);
  const before = d1.q("SELECT * FROM owner_notices ORDER BY id");
  const maxBefore = Math.max(...before.map(r => r.id));

  d1.execFile(read("migrations/0113_picked_up_notices.sql"));
  const after = d1.q("SELECT * FROM owner_notices ORDER BY id");
  ok("every row is kept, with its id, kind, text, images, urgency and sent time", JSON.stringify(after) === JSON.stringify(before) && after.length === 3);
  ok("the unsent-notices index is back", d1.q("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_owner_notices_unsent' AND tbl_name = 'owner_notices'").length === 1);
  ok("no copy of the old table is left", d1.q("SELECT name FROM sqlite_master WHERE name = 'owner_notices_old'").length === 0);
  d1._raw.run("INSERT INTO owner_notices (kind, orderId, orgId, summary, urgent, createdAt) VALUES ('picked_up', 'O4', 'club', 'Cust — USPS 9400 picked up Nov 5', 1, 't')");
  const added = d1.q("SELECT id, kind, urgent FROM owner_notices WHERE kind = 'picked_up'");
  ok("a 'picked_up' notice is accepted, and its id comes after every earlier one", added.length === 1 && added[0].id > maxBefore && added[0].urgent === 1);
  ok("an unknown kind is still refused", refused(() => d1._raw.run("INSERT INTO owner_notices (kind, summary, createdAt) VALUES ('nonsense', 'x', 't')")));
  for (const f of files.filter(f => f > "0113")) d1.execFile(read("migrations/" + f));

  console.log("\n=== A fresh install and the migration list ===");
  const fresh = await createD1();
  fresh._raw.exec(read("schema.sql"));
  fresh._raw.run("INSERT INTO owner_notices (kind, summary, createdAt) VALUES ('picked_up', 'x', 't')");
  ok("schema.sql allows 'picked_up' and refuses an unknown kind", fresh.q("SELECT COUNT(*) AS n FROM owner_notices")[0].n === 1
    && refused(() => fresh._raw.run("INSERT INTO owner_notices (kind, summary, createdAt) VALUES ('nonsense', 'x', 't')")));
  const def = (sql) => (/CREATE TABLE (?:IF NOT EXISTS )?owner_notices \(([\s\S]*?)\n\);/.exec(sql) || [])[1].replace(/\s+/g, " ").trim();
  ok("…with the same table definition as the newest migration that rebuilt it (0119, which added quote, gift_card and po)", def(read("schema.sql")) === def(read("migrations/0119_quote_notices.sql")));
  const { MIGRATIONS } = await import("./functions/_lib/migrationList.js");
  ok("the Worker's migration list has it", MIGRATIONS.includes("0113_picked_up_notices.sql"));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); console.log("test351 crashed: false"); process.exit(1); });
