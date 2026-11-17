// The bulk cloner: copies the template orders (templates.js — made by the app itself) thousands of
// times straight into the SQLite file, with every row that hangs off an order (lines, payments,
// stock movements, audit entries, …) copied with it.
//
// Each copy gets a new order ID, its own customer, and every date moved by the same amount, so
// the order keeps its shape (paid a day after it was placed, shipped a week later) at a new date.
// Columns come from the schema itself (PRAGMA table_xinfo), so a migration that adds a column or
// an order-linked table is picked up with no change here; test188 checks that on every npm test.
//
// The database is reached through a tiny adapter — { all(sql, params), run(sql, params) → lastId,
// exec(sql) } — made by fromNodeSqlite (the desktop's file, perf/scale.js) or fromSqlJs (tests).
const { rng, pick } = require("./names.js");

const DAY = 86400000;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function fromNodeSqlite(db) {
  const cache = new Map();
  const st = (sql) => { let s = cache.get(sql); if (!s) { s = db.prepare(sql); cache.set(sql, s); } return s; };
  return {
    all: (sql, params = []) => st(sql).all(...params),
    run: (sql, params = []) => Number(st(sql).run(...params).lastInsertRowid),
    exec: (sql) => db.exec(sql),
  };
}

function fromSqlJs(raw) {
  const rows = (sql, params) => {
    const s = raw.prepare(sql);
    try { s.bind(params); const out = []; while (s.step()) out.push(s.getAsObject()); return out; } finally { s.free(); }
  };
  return {
    all: (sql, params = []) => rows(sql, params),
    run: (sql, params = []) => { raw.run(sql, params); return rows("SELECT last_insert_rowid() AS id", [])[0].id; },
    exec: (sql) => raw.exec(sql),
  };
}

// What the schema says about each table the cloner writes: insertable columns (generated ones
// left out), whether the key is a rowid the database hands out, and unique columns to keep unique.
function describe(A) {
  const tables = A.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'").map(r => r.name);
  const info = {};
  for (const t of tables) {
    const cols = A.all(`PRAGMA table_xinfo("${t}")`);
    const has = (c) => cols.some(x => x.name === c);
    if (t !== "orders" && !has("orderId") && !has("itemId")) continue;
    const pk = cols.filter(c => c.pk > 0);
    const rowidKey = pk.length === 1 && /^INTEGER$/i.test(pk[0].type) ? pk[0].name : null;
    // One column per unique index is enough to keep a copy apart from its template: the index's last
    // column that the copy doesn't already change and that points at no other table. In
    // (orgId, source, externalOrderId) that is externalOrderId; tagging orgId would break its foreign key.
    const fkCols = new Set(A.all(`PRAGMA foreign_key_list("${t}")`).map(r => r.from));
    const unique = new Set();
    for (const ix of A.all(`PRAGMA index_list("${t}")`)) {
      if (!ix.unique) continue;
      const ic = A.all(`PRAGMA index_info("${ix.name}")`).map(r => r.name);
      if (ic.some(c => c === "orderId" || c === "itemId" || c === rowidKey)) continue;   // new for every copy already
      const own = ic.filter(c => c && !fkCols.has(c));
      if (own.length) unique.add(own[own.length - 1]);
    }
    for (const c of pk) if (c.name !== rowidKey && c.name !== "orderId" && c.name !== "itemId") unique.add(c.name);
    info[t] = {
      cols: cols.filter(c => !c.hidden && c.name !== rowidKey).map(c => c.name),
      rowidKey, unique: [...unique], hasOrderId: has("orderId"), hasItemId: has("itemId"),
    };
  }
  return info;
}

// Everything that belongs to the template orders, read once.
function loadTemplates(A, info, templateIds) {
  const byId = new Map();
  for (const orderId of templateIds) {
    const order = A.all("SELECT * FROM orders WHERE orderId = ?", [orderId])[0];
    if (!order) throw new Error("Template order " + orderId + " is missing");
    const items = A.all("SELECT * FROM order_items WHERE orderId = ? ORDER BY id", [orderId]);
    const itemIds = items.map(i => i.id);
    const children = {};
    for (const [t, d] of Object.entries(info)) {
      if (t === "orders" || t === "order_items") continue;
      let rows = [];
      if (d.hasOrderId) rows = A.all(`SELECT * FROM "${t}" WHERE orderId = ?`, [orderId]);
      else if (d.hasItemId && itemIds.length) rows = A.all(`SELECT * FROM "${t}" WHERE itemId IN (${itemIds.map(() => "?").join(",")})`, itemIds);
      if (rows.length) children[t] = rows;
    }
    byId.set(orderId, { order, items, children });
  }
  return byId;
}

// A date moved with its order. Two kinds of time are in a template: ones the template set on
// purpose (placed 40 days ago, shipped a day later) and ones the app stamped while it was being
// built (insertedAt, audit entries) — those are moved to just after the copy was placed, as if it
// had been entered on time.
const shift = (v, delta, live) => {
  if (typeof v !== "string") return v;
  if (ISO_TIME.test(v)) {
    const t = Date.parse(v);
    if (Number.isNaN(t)) return v;
    if (live && t >= live.from) return new Date(live.placed + (t - live.base)).toISOString();
    return new Date(t + delta).toISOString();
  }
  if (ISO_DATE.test(v)) { const t = Date.parse(v + "T12:00:00Z"); return new Date(t + delta).toISOString().slice(0, 10); }
  return v;
};

function insertRow(A, table, d, row) {
  const vals = d.cols.map(c => row[c] === undefined ? null : row[c]);
  return A.run(`INSERT INTO "${table}" (${d.cols.map(c => `"${c}"`).join(",")}) VALUES (${d.cols.map(() => "?").join(",")})`, vals);
}

// Copies one template order as a new order placed at `placedAt`. Returns the new order ID.
function cloneOne(A, info, tpl, { placedAt, seq, r, isTest, liveFrom }) {
  const delta = Date.parse(placedAt) - Date.parse(tpl.order.placedAt);
  const live = { from: liveFrom, placed: Date.parse(placedAt), base: Date.parse(tpl.order.insertedAt) };
  const prefix = String(tpl.order.orderId).split("-")[0];
  const orderId = prefix + "-" + Date.parse(placedAt).toString(36).toUpperCase() + "-" + (seq >>> 0).toString(16).toUpperCase().padStart(8, "0");
  const tag = "-c" + seq.toString(36);
  const fresh = (d, row) => {
    const out = {};
    for (const c of d.cols) out[c] = shift(row[c], delta, live);
    // Unique text (a payment's reference, an invoice token) gets this copy's tag; an empty one stays
    // empty (the unique indexes skip '').
    for (const c of d.unique) if (typeof out[c] === "string" && out[c] !== "") out[c] = out[c].slice(0, 48) + tag;
    if (d.hasOrderId) out.orderId = orderId;
    return out;
  };

  const o = fresh(info.orders, tpl.order);
  o.customerName = pick(r, "name");
  o.contact = pick(r, "email");
  if (isTest) o.isTest = 1;
  insertRow(A, "orders", info.orders, o);

  const itemMap = new Map();
  for (const it of tpl.items) itemMap.set(it.id, insertRow(A, "order_items", info.order_items, fresh(info.order_items, it)));

  for (const [t, rows] of Object.entries(tpl.children)) {
    const d = info[t];
    for (const row of rows) {
      const out = fresh(d, row);
      if (d.hasItemId && row.itemId !== null && row.itemId !== undefined) {
        if (!itemMap.has(row.itemId)) continue;   // a line of another order (shouldn't happen)
        out.itemId = itemMap.get(row.itemId);
      }
      insertRow(A, t, d, out);
    }
  }
  return orderId;
}

// Which template to copy for an order of this age. Orders still being worked on are recent;
// older ones are finished (completed, refunded or voided), as in a real shop's history.
function makePicker(templates) {
  const by = (kinds) => templates.filter(t => kinds.includes(t.kind));
  // A template's stages run up to 9 days after it was placed, so a copy placed less than that ago
  // only comes from templates with fewer stages (no stage date may land in the future).
  const recent = by(["paidNew", "unpaid", "partPaid"]);
  const working = by(["paidNew", "partPaid", "inProduction"]);
  const middle = by(["inProduction", "shipped", "complete", "partPaid"]);
  const odd = by(["refunded", "voided"]);
  const finished = by(["complete"]);
  return (ageDays, r) => {
    let pool = ageDays < 4 ? recent : ageDays < 10 ? working : ageDays < 21 ? middle : (r() < 0.04 && odd.length ? odd : finished);
    // A template set without some kind (a small test's): the nearest pool that has one.
    if (!pool.length) pool = [recent, working, middle, finished, templates].find(p => p.length);
    return pool[Math.floor(r() * pool.length)];
  };
}

// Adds `count` orders, continuing backwards in time from where the last call stopped: orders arrive
// at `perDay`, the newest `startAgeDays` ago. `state` carries the position between calls
// ({ next: number of clones made so far }).
//   only      copy only templates of these kinds, placed `ageRange` days ago (a work pool)
// Returns { added, oldest, ms, samples: [{ orderId, templateId, placedAt }] } (every 997th copy).
function cloneOrders(A, { templates, count, perDay = 25, startAgeDays = 0, state = { next: 0 }, seed = 11, now = Date.now(), testShare = 0.01,
  only = null, ageRange = null }) {
  const t0 = Date.now();
  const info = describe(A);
  const tpls = loadTemplates(A, info, templates.map(t => t.orderId));
  const pool = only ? templates.filter(t => only.includes(t.kind)) : null;
  if (pool && !pool.length) throw new Error("No templates of kind " + only.join("/"));
  const pickTpl = pool ? (age, r) => pool[Math.floor(r() * pool.length)] : makePicker(templates);
  // Times at or after the first template was entered were stamped by the app while building them.
  const liveFrom = Math.min(...[...tpls.values()].map(t => Date.parse(t.order.insertedAt))) - 60000;
  const r = rng(seed + state.next);
  let oldest = null;
  const samples = [], made = [];
  A.exec("BEGIN");
  try {
    for (let k = 0; k < count; k++) {
      const n = state.next++;
      const ageDays = ageRange ? ageRange[0] + r() * (ageRange[1] - ageRange[0]) : startAgeDays + n / perDay + r() / perDay;
      const t = pickTpl(ageDays, r);
      const placedAt = new Date(now - ageDays * DAY).toISOString();
      const orderId = cloneOne(A, info, tpls.get(t.orderId), { placedAt, seq: n + 1, r, liveFrom, isTest: !only && t.kind === "complete" && r() < testShare });
      if (only) made.push({ orderId, orgId: tpls.get(t.orderId).order.orgId, kind: t.kind });
      if (k % 997 === 0) samples.push({ orderId, templateId: t.orderId, placedAt });
      oldest = placedAt;
    }
    A.exec("COMMIT");
  } catch (e) { A.exec("ROLLBACK"); throw e; }
  return { added: count, oldest, ms: Date.now() - t0, samples, made };
}

module.exports = { cloneOrders, describe, fromNodeSqlite, fromSqlJs };
