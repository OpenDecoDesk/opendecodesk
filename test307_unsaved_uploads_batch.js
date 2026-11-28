// The unsaved-uploads clean-up asks which files are named with one small query per …Key column, sent as one batch
// per page of files (review round 2). It used to build ONE statement joining a SELECT for every …Key column in the
// database with UNION ALL — about twenty today, one more with each migration that adds such a column — and D1 limits
// how many SELECTs one statement may combine, so one day the clean-up would have been refused outright. Now:
// `SELECT "c" AS k FROM "t" WHERE "c" <> '' AND "c" IN (SELECT value FROM json_each(?))` per column, all in one
// db.batch per page, the answers put together here. No new indexes. Same answers as before.
// Real SQL (sql.js), the real migrations and unsavedUploads.js; storage answered here; invented keys.
const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

function bucket() {
  const objects = new Map();
  const b = { objects, lists: 0, pagesWithFiles: 0,
    put(key, uploaded) { objects.set(key, { key, uploaded: new Date(uploaded), size: 10 }); },
    async list({ prefix = "", limit = 1000, startAfter = "" } = {}) {
      b.lists++;
      const all = [...objects.keys()].filter(k => k.startsWith(prefix) && (!startAfter || k > startAfter)).sort();
      const page = all.slice(0, Math.min(limit, 1000));
      if (page.length) b.pagesWithFiles++;
      return { objects: page.map(k => ({ ...objects.get(k) })), truncated: all.length > page.length };
    },
    async delete(keys) { for (const k of keys) objects.delete(k); } };
  return b;
}

(async () => {
  const lib = await import("./functions/_lib/unsavedUploads.js");
  const NOW = Date.parse("2026-11-20T12:00:00Z"), OLD = NOW - 45 * 86400000;
  const hex = (n) => n.toString(16).padStart(32, "0");
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.run("PRAGMA foreign_keys = OFF");
  const cols = await lib.uploadKeyColumns(d1);

  // Every …Key column names some old files (and one row in each holds '' — never a file).
  const R = bucket(), D = bucket();
  const FILL = { kind: "adjust", deductionType: "none", fileExt: "png", type: "other", "owner_transactions.kind": "draw", fromAccountId: 1, toAccountId: 2 };
  let n = 1, rows = 0;
  const addRow = (t, c, key) => {
    const info = d1._raw.exec(`SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info('${t}')`)[0].values;
    const vals = {};
    for (const [name, type, notnull, dflt, pk] of info) {
      if (name === c || pk || !notnull || dflt !== null) continue;
      vals[name] = (t + "." + name) in FILL ? FILL[t + "." + name] : name in FILL ? FILL[name] : /Date$/.test(name) ? "2026-01-15" : /INT/i.test(type) ? n : /REAL|NUM/i.test(type) ? 1 : "x" + n;
    }
    vals[c] = key;
    const names = Object.keys(vals);
    try { d1._raw.run(`INSERT INTO "${t}" (${names.map(x => `"${x}"`).join(",")}) VALUES (${names.map(() => "?").join(",")})`, names.map(x => vals[x])); rows++; return true; }
    catch (e) { return false; }
  };
  for (const [t, c] of cols) {
    const receipt = /receipt/i.test(c) || t === "brand_approvals";
    for (let j = 0; j < 3; j++) {
      const key = receipt ? `receipts/2026/${hex(n)}.pdf` : `designs/${n % 7}/${hex(n)}.dst`;
      if (addRow(t, c, key)) (receipt ? R : D).put(key, OLD);
      n++;
    }
    addRow(t, c, "");
  }
  // 2,300 old design files nothing names (three pages of designs/ with the named ones), and a few receipts.
  for (let i = 0; i < 2300; i++) D.put(`designs/${i % 7}/${hex(100000 + i)}.dst`, OLD);
  for (let i = 0; i < 5; i++) R.put(`receipts/2025/${hex(200000 + i)}.jpg`, OLD);

  // What the old single UNION ALL query says is named, for comparing the answers.
  const oldNamed = new Set();
  const allKeys = [...R.objects.keys(), ...D.objects.keys()];
  const named = cols.map(([t, c]) => `SELECT "${c}" FROM "${t}" WHERE "${c}" IS NOT NULL`).join(" UNION ALL ");
  for (let i = 0; i < allKeys.length; i += 1000) {
    for (const r of d1.q(`SELECT value AS k FROM json_each(?) WHERE value IN (${named})`, JSON.stringify(allKeys.slice(i, i + 1000)))) oldNamed.add(r.k);
  }
  const expectDeleted = allKeys.filter(k => !oldNamed.has(k)).sort();

  // The database as the clean-up sees it: every statement and batch counted.
  const sqls = [], batches = [];
  const db = {
    prepare: (sql) => { sqls.push(sql); return d1.prepare(sql); },
    batch: async (stmts) => { batches.push(stmts.map(s => s._sql)); return d1.batch(stmts); },
  };
  const before = new Set(allKeys);
  // A run deletes at most 1,000 files, so this takes a few runs; they carry on from where the last one stopped.
  const out = { deleted: 0, referenced: 0, errors: [], finished: false, runs: 0 };
  while (!out.finished && out.runs < 6) {
    const r = await lib.cleanUpUnsavedUploads({ DB: db, RECEIPTS: R, DESIGNS: D }, { now: NOW, maxPages: 20 });
    out.runs++; out.deleted += r.deleted; out.referenced += r.referenced; out.errors.push(...r.errors); out.finished = r.finished;
  }
  const deleted = [...before].filter(k => !R.objects.has(k) && !D.objects.has(k)).sort();

  console.log("=== The queries ===");
  ok("(there are many …Key columns, each naming files)", cols.length >= 15 && oldNamed.size === cols.length * 3);
  ok("no statement joins the columns with UNION", sqls.length > 0 && batches.flat().concat(sqls).every(s => !/UNION/i.test(s)));
  const pages = R.pagesWithFiles + D.pagesWithFiles;
  ok("one batch per page of files looked at, nothing else read per page", batches.length === pages && pages >= 4 &&
    sqls.filter(s => /json_each/.test(s)).length === batches.flat().length);
  ok("each batch holds one lookup per …Key column, of the agreed form",
    batches.every(b => b.length === cols.length && b.every(s => /^SELECT "[A-Za-z0-9_]+" AS k FROM "[A-Za-z0-9_]+" WHERE "[A-Za-z0-9_]+" <> '' AND "[A-Za-z0-9_]+" IN \(SELECT value FROM json_each\(\?\)\)$/.test(s))));

  console.log("\n=== The same answers ===");
  ok("exactly the files the old query found unnamed are deleted", JSON.stringify(deleted) === JSON.stringify(expectDeleted) && deleted.length === 2305 && out.deleted === 2305);
  ok("every named file is kept, in every column", [...oldNamed].every(k => R.objects.has(k) || D.objects.has(k)) && out.referenced >= oldNamed.size);
  ok("finished in three runs (1,000 deletions each at most), no errors", out.finished === true && out.runs === 3 && out.errors.length === 0);
  const src = read("functions/_lib/unsavedUploads.js");
  ok("(no index is made for it)", !/CREATE INDEX/i.test(src) && !fs.readdirSync(__dirname + "/migrations").some(f => f >= "0108" && /CREATE INDEX/.test(read("migrations/" + f)) && /Key/.test(read("migrations/" + f))));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
