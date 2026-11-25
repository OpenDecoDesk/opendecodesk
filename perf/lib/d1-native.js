// A D1-shaped binding (the surface testlib/d1-shim.js gives the tests) on Node's own SQLite
// (node:sqlite) and a real database file, that times every statement. perf/profile.js runs the
// app's handler code on it to see which queries an operation spends its time in, and how SQLite
// plans them (EXPLAIN QUERY PLAN).
//
//   const D = openNativeD1(file);   D.d1 → the binding;  D.reset();  D.report() → per-statement totals
//
// It also counts round trips, the cost local SQLite hides: on Cloudflare every first/all/run and every batch is one
// request from the Worker to D1, so an operation's D1 time is at least trips × that request's latency.
const { DatabaseSync } = require("node:sqlite");
const { performance } = require("perf_hooks");

function openNativeD1(file) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON");
  const cache = new Map();
  let stats = new Map();
  let trips = 0;   // D1 round trips: each first/all/run, each batch, each exec
  const norm = (sql) => sql.replace(/\s+/g, " ").trim();

  function stmt(sql) {
    let s = cache.get(sql);
    if (!s) { s = db.prepare(sql); cache.set(sql, s); }
    return s;
  }
  function params(list, sql) {
    return list.map((p, i) => {
      if (p === undefined) throw new Error("D1_TYPE_ERROR: Type 'undefined' not supported for value at index " + i + " in: " + sql.slice(0, 80));
      return typeof p === "boolean" ? (p ? 1 : 0) : p;
    });
  }
  function timed(sql, list, fn) {
    const t = performance.now();
    try { return fn(); }
    finally {
      const ms = performance.now() - t;
      const k = norm(sql);
      const e = stats.get(k) || { sql: k, calls: 0, ms: 0, params: list };
      e.calls++; e.ms += ms; stats.set(k, e);
    }
  }
  const plain = (r) => r ? Object.assign({}, r) : r;
  let lastMeta = { changes: 0, last_row_id: 0 };
  function exec(sql, list, kind) {
    const p = params(list, sql);
    return timed(sql, p, () => {
      const s = stmt(sql);
      if (kind === "run") { const r = s.run(...p); lastMeta = { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) }; return null; }
      return s.all(...p).map(plain);
    });
  }
  function bound(sql, list) {
    return {
      _sql: sql, _params: list,
      async first(col) { trips++; const r = exec(sql, list, "all")[0]; return r === undefined ? null : (col ? r[col] : r); },
      async all() { trips++; return { results: exec(sql, list, "all"), success: true, meta: { ...lastMeta } }; },
      async run() { trips++; exec(sql, list, "run"); return { success: true, meta: { ...lastMeta } }; },
    };
  }
  const d1 = {
    prepare(sql) { return Object.assign(bound(sql, []), { bind: (...list) => bound(sql, list) }); },
    async batch(stmts) {
      trips++;   // the whole batch is one request
      db.exec("SAVEPOINT d1_batch");
      try {
        const out = [];
        for (const s of stmts) { const res = exec(s._sql, s._params, /^\s*(select|with|pragma)/i.test(s._sql) ? "all" : "run"); out.push({ success: true, results: res || [], meta: { ...lastMeta } }); }
        db.exec("RELEASE d1_batch");
        return out;
      } catch (e) { db.exec("ROLLBACK TO d1_batch"); db.exec("RELEASE d1_batch"); throw e; }
    },
    async exec(sql) { trips++; timed(sql, [], () => db.exec(sql)); return { count: 1 }; },
  };

  // The query plan of one statement, with the parameters it was last run with.
  function plan(sql, list) {
    try { return db.prepare("EXPLAIN QUERY PLAN " + sql).all(...params(list || [], sql)).map(r => r.detail); }
    catch (e) { return ["(no plan: " + e.message + ")"]; }
  }
  // A full scan of a table (not of an index, not a one-row lookup).
  const scans = (lines) => lines.filter(l => /^SCAN /.test(l) && !/USING (COVERING )?INDEX|USING INTEGER PRIMARY KEY|CONSTANT ROW|VIRTUAL TABLE/i.test(l));

  return {
    d1, db,
    reset() { stats = new Map(); trips = 0; },
    trips: () => trips,
    report(top = 12) {
      const all = [...stats.values()].sort((a, b) => b.ms - a.ms);
      const totalMs = all.reduce((n, s) => n + s.ms, 0);
      const statements = all.reduce((n, s) => n + s.calls, 0);
      return {
        totalMs, statements, distinct: all.length, trips,
        top: all.slice(0, top).map(s => { const p = /^\s*(select|with|update|delete)/i.test(s.sql) ? plan(s.sql, s.params) : []; return { sql: s.sql, calls: s.calls, ms: s.ms, plan: p, scans: scans(p) }; }),
      };
    },
    close() { db.close(); },
  };
}

module.exports = { openNativeD1 };
