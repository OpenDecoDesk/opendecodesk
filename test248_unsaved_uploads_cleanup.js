const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// The housekeeping step cleanUpUnsavedUploads (review #24, functions/_lib/unsavedUploads.js): receipts (RECEIPTS
// under receipts/) and design / order / digital files (DESIGNS under designs/, order-files/, digital/) uploaded more
// than 48 hours ago that no …Key column in the database names are deleted — at most 1,000 a run, within a time
// limit, carrying on where the last run stopped. Anything named anywhere is kept, as is anything newer, anything
// under another prefix, and everything when the columns can't be found. A missing bucket is skipped quietly; a
// failed deletion is recorded as a system issue by the housekeeping. Real SQL (sql.js) on the migrated schema, an
// in-memory stand-in for R2. Invented data only.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
let failed = 0, passed = 0;
const ok = (label, cond) => { cond ? passed++ : failed++; console.log(label + ": " + !!cond); };

async function migratedDb() {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  return d1;
}

// An R2 bucket as the clean-up uses it: list({ prefix, limit, startAfter }) in key order, delete(keys).
function bucket(name) {
  const objects = new Map();
  const b = {
    name, objects, lists: 0, deletes: [], failDelete: false,
    put(key, uploaded) { objects.set(key, { key, uploaded: new Date(uploaded), size: 10 }); },
    async list({ prefix = "", limit = 1000, startAfter = "" } = {}) {
      b.lists++;
      const all = [...objects.keys()].filter(k => k.startsWith(prefix) && (!startAfter || k > startAfter)).sort();
      const page = all.slice(0, Math.min(limit, 1000));
      return { objects: page.map(k => ({ ...objects.get(k) })), truncated: all.length > page.length, cursor: all.length > page.length ? "c" : undefined };
    },
    async delete(keys) {
      if (b.failDelete) throw new Error("R2 is having a bad day");
      const list = Array.isArray(keys) ? keys : [keys];
      if (list.length > 1000) throw new Error("more than 1000 keys in one call");
      b.deletes.push(list.length);
      for (const k of list) objects.delete(k);
    },
  };
  return b;
}

(async () => {
  const lib = await import("./functions/_lib/unsavedUploads.js");
  const NOW = Date.parse("2026-11-20T12:00:00Z");
  const OLD = NOW - 72 * 3600 * 1000, NEW = NOW - 2 * 3600 * 1000, EDGE = NOW - 47 * 3600 * 1000;
  const hex = (n) => n.toString(16).padStart(32, "0");

  console.log("=== Every column that names an upload is found ===");
  const d1 = await migratedDb();
  const cols = await lib.uploadKeyColumns(d1);
  const has = (t, c) => cols.some(([a, b]) => a === t && b === c);
  const EXPECTED = [["expenses", "receiptKey"], ["order_payments", "receiptKey"], ["inventory_movements", "receiptKey"], ["transfer_movements", "receiptKey"],
    ["other_income", "receiptKey"], ["owner_transactions", "receiptKey"], ["account_transfers", "receiptKey"], ["shipping_labels", "receiptKey"], ["brand_approvals", "fileKey"],
    ["order_item_files", "fileKey"], ["customer_design_uploads", "fileKey"], ["design_versions", "designFileKey"], ["design_versions", "machineFileKey"],
    ["order_item_designs", "designFileKey"], ["order_item_designs", "machineFileKey"], ["product_files", "fileKey"], ["download_grants", "fileKey"]];
  const missing = EXPECTED.filter(([t, c]) => !has(t, c));
  if (missing.length) console.log("   missing:", missing.map(x => x.join(".")).join(", "));
  ok("receipt keys on expenses, payments, stock and transfer movements, money entries, labels and brand approvals; design, machine, order, customer, product and download file keys", missing.length === 0);
  ok("…and only …Key columns (no plain `key` settings column)", cols.every(([, c]) => /^[a-z][A-Za-z0-9]*Key$/.test(c)) && !has("global_settings", "key"));
  // A database that won't join pragma_table_info: the same columns, one table at a time.
  const picky = { prepare: (sql) => { if (/JOIN pragma_table_info/.test(sql)) throw new Error("not authorized"); return d1.prepare(sql); } };
  const cols2 = await lib.uploadKeyColumns(picky);
  ok("…found the same way without the one-query form", JSON.stringify(cols2.map(x => x.join(".")).sort()) === JSON.stringify(cols.map(x => x.join(".")).sort()));

  // Every …Key column names one old file: a row in its table (required columns filled with stand-ins, foreign keys off
  // for the purpose), each pointing to a file in the bucket and prefix that column's uploads go to.
  d1._raw.run("PRAGMA foreign_keys = OFF");
  const R = bucket("RECEIPTS"), D = bucket("DESIGNS");
  const named = [];
  let n = 1;
  // Values the tables' CHECKs accept.
  const FILL = { kind: "adjust", deductionType: "none", fileExt: "png", type: "other", "owner_transactions.kind": "draw", fromAccountId: 1, toAccountId: 2 };
  for (const [t, c] of cols) {
    const info = d1._raw.exec(`SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info('${t}')`)[0].values;
    const vals = {};
    for (const [name, type, notnull, dflt, pk] of info) {
      if (name === c || pk || !notnull || dflt !== null) continue;
      vals[name] = (t + "." + name) in FILL ? FILL[t + "." + name] : name in FILL ? FILL[name] : /Date$/.test(name) ? "2026-01-15" : /INT/i.test(type) ? n : /REAL|NUM/i.test(type) ? 1 : "x" + n;
    }
    const receipt = /receipt/i.test(c) || t === "brand_approvals";
    const key = receipt ? `receipts/2026/${hex(n)}.pdf` : t === "product_files" || t === "download_grants" ? `digital/acme/tee/${hex(n)}.dst`
      : t === "design_versions" ? `designs/7/${hex(n)}.dst` : t === "customer_design_uploads" ? `order-files/pending/${hex(n)}.png` : `order-files/9/${hex(n)}.dst`;
    vals[c] = key;
    const names = Object.keys(vals);
    try { d1._raw.run(`INSERT INTO "${t}" (${names.map(x => `"${x}"`).join(",")}) VALUES (${names.map(() => "?").join(",")})`, names.map(x => vals[x])); }
    catch (e) { console.log("   couldn't add a row to", t, e.message); continue; }
    (receipt ? R : D).put(key, OLD);
    named.push(key);
    n++;
  }
  ok("(a row naming an old file was added for every column)", named.length === cols.length);

  // The files nothing names: old (deleted), new and just under 48 hours (kept), and files under other prefixes (kept).
  const unsavedOld = [`receipts/2025/${hex(901)}.jpg`, `designs/12/${hex(902)}.dst`, `order-files/44/${hex(903)}.pdf`, `digital/acme/hat/${hex(904)}.zip`, `order-files/pending/${hex(905)}.png`];
  unsavedOld.forEach(k => (k.startsWith("receipts/") ? R : D).put(k, OLD));
  const fresh = [`receipts/2026/${hex(911)}.png`, `designs/12/${hex(912)}.dst`, `digital/acme/hat/${hex(913)}.zip`];
  fresh.forEach(k => (k.startsWith("receipts/") ? R : D).put(k, NEW));
  D.put(`designs/12/${hex(914)}.dst`, EDGE);
  const elsewhere = [`vendor-logs/2026/${hex(921)}.json`, `other/${hex(922)}.bin`];
  R.put(elsewhere[0], OLD); D.put(elsewhere[1], OLD);
  const env = { DB: d1, RECEIPTS: R, DESIGNS: D };

  console.log("\n=== One run ===");
  const r1 = await lib.cleanUpUnsavedUploads(env, { now: NOW });
  const there = (k) => R.objects.has(k) || D.objects.has(k);
  ok("every file a …Key column names is kept, in every table", named.every(there));
  ok("old files nothing names are deleted, in both buckets and under every prefix", unsavedOld.every(k => !there(k)) && r1.deleted === unsavedOld.length);
  ok("…including a customer upload whose row is gone (one with its row waits for its own clean-up)", !there(unsavedOld[4]) && there(named.find(k => k.startsWith("order-files/pending/"))));
  ok("files uploaded in the last 48 hours are kept", fresh.every(there) && there(`designs/12/${hex(914)}.dst`) && r1.recent === 4);
  ok("files under other prefixes (the vendor log's own) are never looked at", elsewhere.every(there));
  ok("the run says what it did: finished, nothing skipped, no errors", r1.finished === true && r1.skipped.length === 0 && r1.errors.length === 0 && r1.referenced === named.length);
  ok("one deletion call per bucket", R.deletes.join() === "1" && D.deletes.join() === "4");
  const r1b = await lib.cleanUpUnsavedUploads(env, { now: NOW });
  ok("a second run finds nothing more to delete", r1b.deleted === 0 && named.every(there) && fresh.every(there));
  ok("…and a file comes due once it is 48 hours old", (await lib.cleanUpUnsavedUploads(env, { now: NOW + 47 * 3600 * 1000 })).deleted === 4 && !fresh.some(there));

  console.log("\n=== At most 1,000 a run, carrying on next time ===");
  {
    const D2 = bucket("DESIGNS");
    for (let i = 0; i < 1205; i++) D2.put(`designs/50/${hex(5000 + i)}.dst`, OLD);
    D2.put(`order-files/60/${hex(9000)}.pdf`, OLD);
    const env2 = { DB: d1, DESIGNS: D2 };
    const a = await lib.cleanUpUnsavedUploads(env2, { now: NOW });
    ok("1,205 old unsaved files: the first run deletes 1,000 and says it isn't finished", a.deleted === 1000 && D2.objects.size === 206 && a.finished === false && D2.deletes.every(x => x <= 1000));
    ok("…the oldest-named first, and the cap can't be raised past 1,000", !D2.objects.has(`designs/50/${hex(5000)}.dst`) && D2.objects.has(`designs/50/${hex(5000 + 1204)}.dst`) &&
      (await lib.cleanUpUnsavedUploads({ DB: d1, DESIGNS: bucket("DESIGNS") }, { now: NOW, limit: 5000 })).deleted === 0);
    const b = await lib.cleanUpUnsavedUploads(env2, { now: NOW });
    ok("the next run carries on where it stopped and finishes, the other prefixes included", b.deleted === 206 && D2.objects.size === 0 && b.finished === true);
    const D3 = bucket("DESIGNS");
    for (let i = 0; i < 7; i++) D3.put(`designs/70/${hex(7000 + i)}.dst`, OLD);
    const env3 = { DB: d1, DESIGNS: D3 };
    const c1 = await lib.cleanUpUnsavedUploads(env3, { now: NOW, limit: 3 }), c2 = await lib.cleanUpUnsavedUploads(env3, { now: NOW, limit: 3 }), c3 = await lib.cleanUpUnsavedUploads(env3, { now: NOW, limit: 3 });
    ok("a smaller cap: 3, 3, then the last one, none looked at twice or skipped", c1.deleted === 3 && c2.deleted === 3 && c3.deleted === 1 && D3.objects.size === 0 && c3.finished === true);
  }

  console.log("\n=== Within a time limit ===");
  {
    const D4 = bucket("DESIGNS");
    for (let i = 0; i < 2500; i++) D4.put(`designs/80/${hex(10000 + i)}.dst`, NEW);
    D4.put(`order-files/81/${hex(20000)}.pdf`, OLD);
    let t = 0;
    const clock = () => (t += 7000);   // each look at the clock: seven seconds later
    const a = await lib.cleanUpUnsavedUploads({ DB: d1, DESIGNS: D4 }, { now: NOW, clock, budgetMs: 20000 });
    ok("listing stops when the run's time is up, and says it isn't finished", a.finished === false && D4.lists === 2 && a.scanned === 2000);
    t = 0; D4.lists = 0;
    const b = await lib.cleanUpUnsavedUploads({ DB: d1, DESIGNS: D4 }, { now: NOW, clock, budgetMs: 20000 });
    ok("…the next run starts where it stopped (not at the top again) and reaches the file left over", D4.lists === 2 && b.scanned === 500 + 1 && b.deleted === 1 && !D4.objects.has(`order-files/81/${hex(20000)}.pdf`));
    const D5 = bucket("DESIGNS");
    for (let i = 0; i < 9500; i++) D5.put(`designs/82/${hex(40000 + i)}.dst`, NEW);
    const c = await lib.cleanUpUnsavedUploads({ DB: d1, DESIGNS: D5 }, { now: NOW });
    ok("…and after 8 pages of 1,000 files however fast it goes (each page is a storage call and a query)", D5.lists === lib.UNSAVED_UPLOADS_MAX_PAGES && lib.UNSAVED_UPLOADS_MAX_PAGES === 8 && c.scanned === 8000 && c.finished === false);
  }

  console.log("\n=== Missing buckets and failures ===");
  {
    const touched = { n: 0 };
    const noDb = { prepare: () => { touched.n++; throw new Error("should not be asked"); } };
    const none = await lib.cleanUpUnsavedUploads({ DB: noDb }, { now: NOW });
    ok("no buckets bound: both skipped quietly, without touching the database", none.skipped.join() === "RECEIPTS,DESIGNS" && none.deleted === 0 && none.errors.length === 0 && touched.n === 0);
    const D5 = bucket("DESIGNS"); D5.put(`designs/90/${hex(30000)}.dst`, OLD);
    const one = await lib.cleanUpUnsavedUploads({ DB: d1, DESIGNS: D5 }, { now: NOW });
    ok("only DESIGNS bound: RECEIPTS is skipped, DESIGNS cleaned", one.skipped.join() === "RECEIPTS" && one.deleted === 1);
    const empty = await createD1();
    const D6 = bucket("DESIGNS"); D6.put(`designs/91/${hex(30001)}.dst`, OLD);
    let threw = null;
    try { await lib.cleanUpUnsavedUploads({ DB: empty, DESIGNS: D6 }, { now: NOW }); } catch (e) { threw = e; }
    ok("a database without the columns that name uploads: nothing is deleted, and the run fails loudly", !!threw && D6.objects.size === 1 && D6.deletes.length === 0);
    const D7 = bucket("DESIGNS"); D7.put(`designs/92/${hex(30002)}.dst`, OLD); D7.failDelete = true;
    const R7 = bucket("RECEIPTS"); R7.put(`receipts/2025/${hex(30003)}.pdf`, OLD);
    const f = await lib.cleanUpUnsavedUploads({ DB: d1, RECEIPTS: R7, DESIGNS: D7 }, { now: NOW });
    ok("a failed deletion is reported (the other bucket still cleaned), and its files are looked at again next run", f.errors.length === 1 && /DESIGNS: deleting 1 file failed — R2 is having a bad day/.test(f.errors[0]) &&
      f.deleted === 1 && R7.objects.size === 0 && D7.objects.size === 1);
    D7.failDelete = false;
    ok("…and deleted once storage answers again", (await lib.cleanUpUnsavedUploads({ DB: d1, RECEIPTS: R7, DESIGNS: D7 }, { now: NOW })).deleted === 1 && D7.objects.size === 0);

    // The housekeeping records each failure as a system issue, as it does for its other clean-ups.
    const w = await import("./src/worker.js");
    const D8 = bucket("DESIGNS"); D8.put(`designs/93/${hex(30004)}.dst`, OLD); D8.failDelete = true;
    const hk = await w.handleScheduled({ scheduledTime: Date.parse("2026-07-15T05:00:00Z") }, { DB: d1, DESIGNS: D8 });
    const issues = d1._raw.exec("SELECT sample FROM system_issues WHERE kind = 'cleanup_failed'")[0];
    ok("the housekeeping tick runs it, and records the failure as a clean-up that didn't complete", !!hk.housekeeping && hk.housekeeping.unsavedUploads && hk.housekeeping.unsavedUploads.errors.length === 1 &&
      !!issues && issues.values.some(([s]) => /^Unsaved uploads: DESIGNS: deleting 1 file failed/.test(s)));
    const src = read("src/worker.js");
    const hkFn = src.slice(src.indexOf("async function runHousekeeping_("), src.indexOf("export async function handleScheduled("));
    ok("…in the housekeeping, not the roll-up's tick, with a crash recorded the same way", /cleanUpUnsavedUploads\(env\)/.test(hkFn) && /recordSystemIssue\(env\.DB, "cleanup_failed", "Unsaved uploads: " \+ \(e && e\.message\)\)/.test(hkFn) &&
      !/cleanUpUnsavedUploads/.test(src.slice(src.indexOf("const when = new Date(event"))));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); console.log("test crashed: false"); process.exit(1); });
