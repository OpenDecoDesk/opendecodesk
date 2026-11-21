const fs = require("fs");
const path = require("path");
const { createD1 } = require("./testlib/d1-shim.js");

// Code deployed without its migrations (a bare `wrangler deploy`, or a migration that failed partway) used
// to show $0 and empty lists with no error anywhere, because many readers treat a missing table as "nothing
// yet". functions/_lib/migrationCheck.js compares the migrations this code ships (migrationList.js, written
// by scripts/migration-list.mjs) with the database's d1_migrations table:
//   - Global settings → Setup status marks the Database line not ready and says which updates are missing
//     (a required item, so the admin opens there after signing in);
//   - the morning roll-up's tick records it as a problem, so the roll-up email reports it.
const read = (p) => fs.readFileSync(path.join(__dirname, p), "utf8");
const ok = (d, c) => console.log(d + ":", !!c);

(async () => {
  const list = await import("./scripts/migration-list.mjs");
  const check = await import("./functions/_lib/migrationCheck.js");
  const status = await import("./functions/_lib/setupStatus.js");
  const { MIGRATIONS } = await import("./functions/_lib/migrationList.js");

  console.log("=== The list the Worker ships ===");
  const names = list.migrationNames(__dirname);
  ok("functions/_lib/migrationList.js lists every file in migrations/, in order (if not: node scripts/migration-list.mjs)",
    JSON.stringify(MIGRATIONS) === JSON.stringify(names) && read("functions/_lib/migrationList.js") === list.migrationListSource(names));
  ok("…and the desktop program reads the same names", JSON.stringify(require("./desktop/migrate.js").readSources(__dirname).migrations.map(m => m.name)) === JSON.stringify(names));

  console.log("\n=== Comparing it with the database ===");
  const db = await createD1();
  const EXPECT = ["0001_a.sql", "0002_b.sql", "0003_c.sql", "0004_d.sql"];
  ok("no d1_migrations table: it can't tell (null), rather than guessing", (await check.pendingMigrations(db, EXPECT)) === null);
  ok("no database: null", (await check.pendingMigrations(null, EXPECT)) === null);
  db._raw.exec("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)");
  db._raw.exec("INSERT INTO d1_migrations (name) VALUES ('0001_a.sql'), ('0003_c.sql'), ('0099_someone_elses.sql')");
  const pending = await check.pendingMigrations(db, EXPECT);
  ok("the ones not applied, in order (one skipped in the middle too); extra ones the database has don't matter", JSON.stringify(pending) === JSON.stringify(["0002_b.sql", "0004_d.sql"]));
  db._raw.exec("INSERT INTO d1_migrations (name) VALUES ('0002_b.sql'), ('0004_d.sql')");
  ok("all applied: nothing pending", (await check.pendingMigrations(db, EXPECT)).length === 0);
  const note = check.pendingMigrationsNote(["0002_b.sql", "0004_d.sql", "0005_e.sql", "0006_f.sql", "0007_g.sql"]);
  ok("the note says how many, names the first few, what goes wrong, and how to fix it",
    /^5 database updates haven't been applied \(0002_b\.sql, 0004_d\.sql, 0005_e\.sql, and 2 more\)/.test(note) && /\$0 or empty lists/.test(note) && /npm run db:migrate/.test(note)
    && /^1 database update hasn't/.test(check.pendingMigrationsNote(["0002_b.sql"])) && check.pendingMigrationsNote([]) === "");

  console.log("\n=== Setup status ===");
  const env = { DB: { prepare() {} }, ROOT_DOMAIN: "myshop.example", SIGNING_SECRET: "s" };
  const dbLine = (e, migrations) => status.setupStatus(e, { migrations }).find(i => i.key === "database");
  const missing = { pending: ["0099_x.sql"], note: check.pendingMigrationsNote(["0099_x.sql"]) };
  ok("updates missing: the Database line is not ready, and says which", dbLine(env, missing).ready === false && /0099_x\.sql/.test(dbLine(env, missing).note) && dbLine(env, missing).level === "required");
  ok("…which counts as a required thing to set up (so the admin opens Global settings after signing in)",
    status.setupSummary(status.setupStatus(env, { migrations: missing })).required > status.setupSummary(status.setupStatus(env, { migrations: { pending: [] } })).required);
  ok("up to date, or it can't tell: the Database line is as before", dbLine(env, { pending: [] }).ready === true && dbLine(env, null).ready === true && dbLine(env, null).note === "");
  ok("the desktop program's list says so too", dbLine({ ...env, EDITION: "desktop" }, missing).ready === false && dbLine({ ...env, EDITION: "desktop" }, { pending: [] }).ready === true);
  const orders = read("functions/api/orders.js");
  ok("getSetupStatus reads it from the database and passes it on", /const pending = await safe\(\(\) => pendingMigrations\(env\.DB\), null\);/.test(orders)
    && /setupStatus\(env, \{[^}]*migrations \}\)/.test(orders) && /from "\.\.\/_lib\/migrationCheck\.js"/.test(orders));

  console.log("\n=== The morning roll-up ===");
  const w = await import("./src/worker.js");
  const { makePlatformDb } = require("./testlib/platform-db");
  const pdb = await makePlatformDb();
  pdb._raw.exec("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)");
  for (const n of MIGRATIONS.slice(0, -2)) pdb._raw.run("INSERT INTO d1_migrations (name) VALUES (?)", [n]);
  const origError = console.error; console.error = () => {};
  try { await w.handleScheduled({ scheduledTime: Date.parse("2026-07-15T06:00:00Z") }, { DB: pdb }); } finally { console.error = origError; }
  const rows = pdb.q("SELECT kind, sample FROM system_issues WHERE kind = 'migrations_pending'");
  ok("the roll-up's tick records the missing updates as a problem, for that morning's email",
    rows.length === 1 && rows[0].sample === "2 not applied, starting with " + MIGRATIONS[MIGRATIONS.length - 2]);
  ok("…with a plain label in the email", /migrations_pending: "Database updates this version needs that haven't been applied/.test(read("functions/_lib/db.js")));
  for (const n of MIGRATIONS.slice(-2)) pdb._raw.run("INSERT INTO d1_migrations (name) VALUES (?)", [n]);
  pdb._raw.exec("DELETE FROM system_issues");
  console.error = () => {};
  try { await w.handleScheduled({ scheduledTime: Date.parse("2026-07-16T06:00:00Z") }, { DB: pdb }); } finally { console.error = origError; }
  ok("…and nothing once they're applied", pdb.q("SELECT count(*) AS n FROM system_issues WHERE kind = 'migrations_pending'")[0].n === 0);
})().catch((e) => { console.log("test225 crashed:", false); console.error(e); process.exit(1); });
