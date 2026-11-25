#!/usr/bin/env node
// Scale test of the desktop program: grows the order history step by step (1k → 250k orders by
// default) and times the admin's order operations at each step, against the real desktop server
// (desktop/server.js: Miniflare → workerd → SQLite on this computer). Nothing touches Cloudflare.
//
//   npm run perf                                  the full ladder (about 20–40 minutes)
//   npm run perf -- --max 5000 --runs 2           a quick smoke run
//   npm run perf -- --tiers 1000,10000 --only open-orders,orders-30d
//   npm run perf -- --keep-data                   keep the database (for npm run perf:profile)
//   npm run perf -- --data-root <folder>          where the databases go (default ~/Library/Caches/opendecodesk-perf
//                                                 on a Mac, else the temp folder; never a synced folder)
//   npm run perf -- --compare perf/results/<run>/results.json
//
// Each step: copy orders in (perf/lib/clone.js) → check the data → start the server (timed) →
// grow the catalog → time every read → copy the database aside (= a File → Back up, timed) →
// add a work pool and time every write → put the database back. Results go to
// perf/results/<run>/ (results.json and report.html), written again after every step.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");
const { DatabaseSync } = require("node:sqlite");
const { openServer, sqlitePath } = require("./lib/server.js");
const { buildTemplates, growCatalog } = require("./lib/templates.js");
const { cloneOrders, fromNodeSqlite } = require("./lib/clone.js");
const { READS, WRITES, CLASSES, poolNeeds, rowsOf, makeContext, callOp } = require("./lib/ops.js");
const { timeOp, memorySampler, folderBytes } = require("./lib/measure.js");
const { writeReport, summaryTable, compareTable } = require("./lib/report.js");

const ROOT = path.join(__dirname, "..");
const DAY = 86400000;

function parseArgs(argv) {
  const a = { dataRoot: null, max: 250000, tiers: null, runs: 5, only: null, keepData: false, compare: null, perDay: 25, timeoutS: 120, slowSkipS: 60 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === "--max") { a.max = Number(v); i++; }
    else if (k === "--tiers") { a.tiers = v.split(",").map(Number); i++; }
    else if (k === "--runs") { a.runs = Number(v); i++; }
    else if (k === "--only") { a.only = v.split(","); i++; }
    else if (k === "--keep-data") a.keepData = true;
    else if (k === "--data-root") { a.dataRoot = path.resolve(v); i++; }
    else if (k === "--compare") { a.compare = v; i++; }
    else if (k === "--per-day") { a.perDay = Number(v); i++; }
    else if (k === "--timeout") { a.timeoutS = Number(v); i++; }
    else if (k === "--help" || k === "-h") { console.log(fs.readFileSync(__filename, "utf8").split("\n").slice(1, 18).join("\n")); process.exit(0); }
    else throw new Error("Unknown option " + k);
  }
  a.tiers = (a.tiers || [1000, 5000, 25000, 100000, 250000, 500000, 1000000]).filter(t => t <= a.max).sort((x, y) => x - y);
  if (!a.tiers.length) throw new Error("No steps at or under --max " + a.max);
  return a;
}

const log = (...m) => console.log("[" + new Date().toISOString().slice(11, 19) + "]", ...m);
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
const commit = () => { try { return execSync("git rev-parse --short HEAD", { cwd: ROOT }).toString().trim(); } catch (e) { return "unknown"; } };

function openDb(dataDir) {
  const db = new DatabaseSync(sqlitePath(dataDir));
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function rowCounts(db) {
  const out = {};
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all()) {
    const n = db.prepare(`SELECT count(*) AS n FROM "${name}"`).get().n;
    if (n) out[name] = n;
  }
  return out;
}

// A copied order must come back from the real getOrders with its template's shape and totals.
async function shapeCheck(S, samples) {
  const out = [];
  const near = (iso) => [new Date(Date.parse(iso) - DAY).toISOString().slice(0, 10), new Date(Date.parse(iso) + DAY).toISOString().slice(0, 10)];
  const find = async (orgId, orderId, at) => {
    const [dateFrom, dateTo] = near(at);
    const r = await S.orders({ action: "getOrders", org: orgId, dateFrom, dateTo });
    return ((r.body && r.body.orders) || []).find(o => o.orderId === orderId) || null;
  };
  for (const s of samples.slice(0, 3)) {
    const orgId = s.orgId;
    const c = await find(orgId, s.orderId, s.placedAt);
    const t = await find(orgId, s.templateId, s.templatePlacedAt);
    const same = !!(c && t && c.total === t.total && (c.items || []).length === (t.items || []).length && !!c.paid === !!t.paid
      && !!c.completedAt === !!t.completedAt && !!c.voidedAt === !!t.voidedAt);
    out.push({ orderId: s.orderId, templateId: s.templateId, ok: same, found: !!c });
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const run = stamp() + "-" + commit();
  // The database lives outside the repo: ~/Documents may be synced (iCloud), and a synced SQLite
  // file gets "database is locked" errors and gigabytes uploaded.
  const dataDir = path.join(args.dataRoot || (process.platform === "darwin" ? path.join(os.homedir(), "Library", "Caches", "opendecodesk-perf") : path.join(os.tmpdir(), "opendecodesk-perf")), run);
  const outDir = path.join(ROOT, "perf", "results", run);
  fs.mkdirSync(outDir, { recursive: true });
  const ops = [...READS, ...WRITES].filter(o => !args.only || args.only.includes(o.name));
  const results = {
    meta: { run, startedAt: new Date().toISOString(), commit: commit(), node: process.version, platform: os.platform() + " " + os.release(),
      cpu: (os.cpus()[0] || {}).model, cpus: os.cpus().length, memGB: Math.round(os.totalmem() / 1073741824), args },
    classes: CLASSES,
    ops: ops.map(o => ({ name: o.name, title: o.title, cls: o.cls, windowed: !!o.windowed })),
    templates: null, tiers: [],
  };
  const save = () => {
    fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 1));
    writeReport(results, path.join(outDir, "report.html"));
  };
  log("Run " + run + "  steps: " + args.tiers.join(", ") + "  data: " + dataDir);

  // Templates: made by the app itself.
  let S = await openServer(dataDir, { timeoutMs: args.timeoutS * 1000 });
  const T = await buildTemplates(S);
  await S.stop();
  const db0 = openDb(dataDir);
  const tplPlaced = new Map(db0.prepare("SELECT orderId, placedAt, orgId FROM orders").all().map(r => [r.orderId, r]));
  db0.close();
  results.templates = { orders: T.templates.length, kinds: T.templates.reduce((m, t) => (m[t.kind] = (m[t.kind] || 0) + 1, m), {}), refusedSteps: T.problems.length };
  fs.writeFileSync(path.join(dataDir, "perf-state.json"), JSON.stringify({ templates: T.templates, shops: T.shops, blankIds: T.blankIds }, null, 1));
  log("Templates: " + T.templates.length + " orders made through the API");

  const state = { next: 0 };
  const catalogSize = Object.fromEntries(T.shops.map(s => [s.orgId, 20]));
  const skip = new Set();
  let have = T.templates.length;

  for (const target of args.tiers) {
    const tier = { orders: target, ops: {} };
    results.tiers.push(tier);

    // 1. Copy orders in, with the server stopped, and check the result.
    let db = openDb(dataDir);
    const A = fromNodeSqlite(db);
    const add = Math.max(0, target - have);
    const c = cloneOrders(A, { templates: T.templates, count: add, perDay: args.perDay, state });
    have += add;
    tier.cloneMs = c.ms;
    const t1 = Date.now();
    tier.checks = { foreignKeyProblems: db.prepare("PRAGMA foreign_key_check").all().length, quickCheck: db.prepare("PRAGMA quick_check").get().quick_check, checkMs: 0 };
    tier.checks.checkMs = Date.now() - t1;
    tier.rowCounts = rowCounts(db);
    const samples = c.samples.map(s => ({ ...s, orgId: tplPlaced.get(s.templateId).orgId, templatePlacedAt: tplPlaced.get(s.templateId).placedAt }));
    // What the timed operations act on.
    const shops = T.shops.map(s => s.orgId);
    const ctx = makeContext(db, shops);
    db.close();
    log(`Step ${target.toLocaleString()}: copied ${add.toLocaleString()} orders in ${(c.ms / 1000).toFixed(1)} s; checks ${tier.checks.quickCheck}, ${tier.checks.foreignKeyProblems} key problems (${(tier.checks.checkMs / 1000).toFixed(1)} s)`);

    // 2. Start the server (timed, as the program opens), grow the catalog, time the reads.
    S = await openServer(dataDir, { timeoutMs: args.timeoutS * 1000 });
    tier.startMs = Math.round(S.startMs);
    const wantProducts = Math.min(700, 20 + Math.floor(target / 400));
    for (const s of shops) { await growCatalog(S, s, T.blankIds, catalogSize[s], wantProducts); catalogSize[s] = Math.max(catalogSize[s], wantProducts); }
    tier.productsPerShop = wantProducts;
    tier.checks.shape = await shapeCheck(S, samples);
    const mem = memorySampler().start();
    for (const op of READS.filter(o => ops.includes(o))) {
      if (skip.has(op.name)) { tier.ops[op.name] = { skipped: true }; continue; }
      const r = await timeOp((i) => callOp(op, ctx, i, (b) => S.orders(b)), { runs: args.runs, rowsOf });
      tier.ops[op.name] = r;
      log(`  ${op.name.padEnd(24)} ${r.error ? "ERROR " + r.error : (r.median.toFixed(0) + " ms median, " + r.p95.toFixed(0) + " ms p95, " + r.rows + " rows, " + (r.bytes / 1024).toFixed(0) + " KB")}`);
      if (r.error || r.median > args.slowSkipS * 1000) skip.add(op.name);
    }
    tier.memoryReads = mem.stop();
    await S.stop();

    // 3. Copy the database aside: that is what File → Back up does (timed); it also lets the writes
    //    below be thrown away, so every step starts from the same history.
    const stateDir = path.join(dataDir, "state");
    const snap = path.join(dataDir, "snapshot");
    fs.rmSync(snap, { recursive: true, force: true });
    const tb = Date.now();
    fs.cpSync(stateDir, snap, { recursive: true });
    tier.backupMs = Date.now() - tb;
    tier.dbBytes = fs.statSync(sqlitePath(dataDir)).size;
    tier.walBytes = fs.existsSync(sqlitePath(dataDir) + "-wal") ? fs.statSync(sqlitePath(dataDir) + "-wal").size : 0;
    tier.stateBytes = folderBytes(stateDir);

    // 4. The work pool (recent orders the writes act on), then the writes.
    const writes = WRITES.filter(o => ops.includes(o) && !skip.has(o.name));
    if (writes.length) {
      const need = poolNeeds(1 + args.runs);
      db = openDb(dataDir);
      const PA = fromNodeSqlite(db);
      const poolState = { next: 50000000 + target };
      const paid = cloneOrders(PA, { templates: T.templates, count: need.stage + need.info + need.bulk, only: ["paidNew"], ageRange: [0.2, 3], state: poolState }).made;
      const unpaid = cloneOrders(PA, { templates: T.templates, count: need.pay, only: ["unpaid"], ageRange: [0.2, 3], state: poolState }).made;
      db.close();
      ctx.pool = { pay: unpaid.map(o => o.orderId), stage: paid.slice(0, need.stage), info: paid.slice(need.stage, need.stage + need.info), bulk: paid.slice(need.stage + need.info) };
      S = await openServer(dataDir, { timeoutMs: args.timeoutS * 1000 });
      const memW = memorySampler().start();
      for (const op of writes) {
        const r = await timeOp((i) => callOp(op, ctx, i, (b) => S.orders(b)), { runs: args.runs, rowsOf });
        tier.ops[op.name] = r;
        log(`  ${op.name.padEnd(24)} ${r.error ? "ERROR " + r.error : (r.median.toFixed(0) + " ms median, " + r.p95.toFixed(0) + " ms p95")}`);
        if (r.error || r.median > args.slowSkipS * 1000) skip.add(op.name);
      }
      tier.memoryWrites = memW.stop();
      await S.stop();
    }
    for (const op of WRITES.filter(o => ops.includes(o) && skip.has(o.name) && !tier.ops[o.name])) tier.ops[op.name] = { skipped: true };

    // 5. Back to the history as it was before the writes.
    fs.rmSync(path.join(stateDir, "d1"), { recursive: true, force: true });
    fs.cpSync(path.join(snap, "d1"), path.join(stateDir, "d1"), { recursive: true });
    fs.rmSync(snap, { recursive: true, force: true });
    save();
    log(`Step ${target.toLocaleString()} done: database ${(tier.dbBytes / 1048576).toFixed(0)} MB, start ${tier.startMs} ms, backup copy ${tier.backupMs} ms`);
  }

  results.meta.finishedAt = new Date().toISOString();
  save();
  console.log("\n" + summaryTable(results));
  if (args.compare) console.log("\n" + compareTable(results, JSON.parse(fs.readFileSync(args.compare, "utf8"))));
  console.log("\nReport: " + path.relative(ROOT, path.join(outDir, "report.html")));
  if (args.keepData) console.log("Data kept: " + dataDir + "\n  npm run perf:profile -- --data " + dataDir);
  else fs.rmSync(dataDir, { recursive: true, force: true });
}

main().catch((e) => { console.error(e); process.exit(1); });
