#!/usr/bin/env node
// Where the time goes: runs the slow operations from a scale test's kept database through the
// app's REAL handler code (functions/api/orders.js and functions/_lib/db.js, joined the way the
// tests join them), on Node's own SQLite with every statement timed, and shows for each operation
// the statements it spent its time in, how often each ran, and SQLite's plan for them.
//
//   npm run perf -- --keep-data                                  (prints the data folder)
//   npm run perf:profile -- --data <that folder>                 profile.json + the report again
//   npm run perf:profile -- --data <folder> --ops open-orders,production-queue
//
// It works on a copy of the database, so the kept data is left as it was.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { openNativeD1 } = require("./lib/d1-native.js");
const { READS, WRITES, makeContext } = require("./lib/ops.js");
const { OWNER } = require("./lib/server.js");
const { makeAuth } = require("../testlib/auth-harness.js");
const { writeReport } = require("./lib/report.js");
const { migrate, readSources } = require("../desktop/migrate.js");

const ROOT = path.join(__dirname, "..");
const DEFAULT_OPS = ["open-orders", "production-queue", "transfer-queue", "blanks-to-order", "orders-30d", "orders-all-shops-30d",
  "revenue-year", "sales-tax-year", "accountant-export-year", "orders-full-history", "bulk-stage-20"];

function parseArgs(argv) {
  const a = { data: null, ops: DEFAULT_OPS, results: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === "--data") { a.data = path.resolve(v); i++; }
    else if (k === "--ops") { a.ops = v.split(","); i++; }
    else if (k === "--results") { a.results = path.resolve(v); i++; }
    else throw new Error("Unknown option " + k);
  }
  if (!a.data) throw new Error("--data <the folder npm run perf -- --keep-data printed> is required");
  // The run's report: perf/results/<the data folder's name>/.
  if (!a.results) a.results = path.join(ROOT, "perf", "results", path.basename(a.data), "results.json");
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { sqlitePath } = require("./lib/server.js");
  const src = sqlitePath(args.data);
  const secrets = JSON.parse(fs.readFileSync(path.join(args.data, "desktop.json"), "utf8")).secrets;
  if (!secrets || !secrets.PROXY_ADMIN_PASSPHRASE) throw new Error("No readable secrets in " + args.data + "/desktop.json");
  const state = JSON.parse(fs.readFileSync(path.join(args.data, "perf-state.json"), "utf8"));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "odd-profile-"));
  const file = path.join(tmp, "db.sqlite");
  for (const ext of ["", "-wal", "-shm"]) if (fs.existsSync(src + ext)) fs.copyFileSync(src + ext, file + ext);
  const D = openNativeD1(file);
  // Migrations added since the data was kept (a new index, say) go onto the copy, so the profile
  // shows the code and schema as they are now, the way the program would update the database.
  const { applied } = await migrate(D.d1, readSources(ROOT));
  if (applied.length) console.log("Applied to the copy: " + applied.join(", "));
  const orders = D.db.prepare("SELECT count(*) AS n FROM orders").get().n;
  const sqlite = D.db.prepare("SELECT sqlite_version() AS v").get().v;
  console.log(`Profiling ${orders.toLocaleString()} orders (SQLite ${sqlite}) on a copy in ${tmp}`);

  // Signed in as the owner, through the real sign-in code.
  const A = await makeAuth({ d1: D.d1, passphrase: secrets.PROXY_ADMIN_PASSPHRASE });
  const s = await A.signIn(OWNER.email, OWNER.pass);
  if (s.status !== 200 || !s.cookie) throw new Error("Sign-in on the copy failed: " + s.status + " " + JSON.stringify(s.body));

  const ctx = makeContext(D.db, state.shops.map(x => x.orgId));
  // Bulk changes act on paid, unstarted orders the history already has.
  const fresh = D.db.prepare(`SELECT orderId, orgId FROM orders WHERE paid = 1 AND voidedAt IS NULL AND completedAt IS NULL
    AND digitizingCompleteAt IS NULL AND isTest = 0 ORDER BY placedAt DESC LIMIT 200`).all().map(r => ({ ...r }));
  // Too few of those: the most recent orders of any kind make up the 100 (an order that can't take
  // the stage is still loaded in full first, which is the cost being looked at).
  if (fresh.length < 100) fresh.push(...D.db.prepare("SELECT orderId, orgId FROM orders WHERE isTest = 0 ORDER BY placedAt DESC LIMIT ?").all(100 - fresh.length).map(r => ({ ...r })));
  ctx.pool = { bulk: fresh, stage: fresh.slice(100), info: fresh.slice(100), pay: [] };

  const out = { orders, sqlite, at: new Date().toISOString(), ops: [] };
  for (const name of args.ops) {
    const op = [...READS, ...WRITES].find(o => o.name === name);
    if (!op) { console.log("  (no operation " + name + ")"); continue; }
    // Once to warm SQLite's cache (not for a write: it would use up its orders), then the timed run.
    if (op.cls !== "bulk" && op.cls !== "write") await A.orders(op.body(ctx, 0), s.cookie);
    D.reset();
    const t = Date.now();
    const r = await A.orders(op.body(ctx, 0), s.cookie);
    const wall = Date.now() - t;
    const rep = D.report();
    const err = r.status !== 200 ? (r.body && (r.body.message || r.body.threw)) || "HTTP " + r.status : null;
    out.ops.push({ name, title: op.title, wallMs: wall, error: err, ...rep });
    console.log(`\n${op.title}: ${wall} ms, ${rep.statements} statements (${rep.distinct} different), ${rep.totalMs.toFixed(0)} ms in SQLite${err ? "  ERROR " + err : ""}`);
    for (const st of rep.top.slice(0, 6)) {
      console.log(`  ${st.ms.toFixed(0).padStart(7)} ms  ×${String(st.calls).padEnd(5)} ${st.sql.slice(0, 110)}`);
      for (const sc of st.scans) console.log("            SCAN: " + sc);
    }
  }
  D.close();
  fs.rmSync(tmp, { recursive: true, force: true });

  const dir = path.dirname(args.results);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify(out, null, 1));
  if (fs.existsSync(args.results)) {
    writeReport(JSON.parse(fs.readFileSync(args.results, "utf8")), path.join(dir, "report.html"), { profile: { ...out, ops: out.ops.map(o => ({ ...o, totalMs: o.totalMs })) } });
    console.log("\nReport (with the profile): " + path.relative(ROOT, path.join(dir, "report.html")));
  } else console.log("\nNo results.json at " + args.results + "; profile saved to " + path.join(dir, "profile.json"));
}

main().catch((e) => { console.error(e); process.exit(1); });
