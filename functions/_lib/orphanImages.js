// Settings → Orphaned images (2026-10): files in the public image store (the IMAGES R2 bucket) that nothing in the
// database points to any more — a photo replaced or removed from a product / blank / org / graphic, a duplicate
// taken off a blank, an upload whose form was never saved, a design-verification image whose record is gone.
// "Points to" is checked generically: every text column of every table is searched for image addresses, so a new
// table that stores them is covered without a change here (order lines' snapshots count — an order still shows its
// picture). Tables that only hold history don't count (HISTORY_TABLES below). A "-thumb" copy belongs to its main
// image. Files uploaded in the last 24 hours are never called orphaned (a form may still be open with them).
// The addresses found are kept as a set of keys (each value's image keys pulled out as it's read, a page of rows at a
// time), so the work grows with the number of files and references, not their product.
//
// The scan runs in steps the screen drives (2026-11, review round 2). Cloudflare caps the database queries one
// request may run — 50 on the Free plan — and the scan used to run one per text column of every table (700 on a new
// install). Now each table is read with ONE statement covering all its text columns, a page of rows at a time, and a
// request runs at most STEP_QUERIES queries: scanOrphanImages reads tables until its share is used, keeps the image
// keys it found (orphan_scan_keys, kind 'ref') and where it stopped (orphan_scans — migrations/0106), and answers
// with a scanId for the next request. When every table is read, the bucket is listed a page of 1,000 files a request,
// each page checked against the kept keys; the unreferenced files go back to the screen page by page and are kept too
// (kind 'orphan'). A scan's rows are its own, so two people can scan at once. They go when the scan ends with nothing
// orphaned, when the page starts its next scan (it names the one it's done with), and — whoever starts a scan —
// once they're a day old.
//
// Deleting checks again, as it always did — but no longer by running a whole scan inside the delete request. Remove
// selected first has the references read again in steps ({scanId, recheck: true}; the scan's list of orphans is
// kept), then deleteOrphanImages takes only keys that scan listed as orphaned and that the references just read
// (within RECHECK_MS) don't point to. So a file something points to is never deleted, and the 24-hour rule holds:
// only files the listing saw as older are on the scan's list.
const GRACE_MS = 24 * 60 * 60 * 1000;
const ROWS_PER_READ = 2000;
const DELETE_MAX = 1000;
// One request's share of a scan: at most this many database queries, and no new read once this long has gone by.
const STEP_QUERIES = 25;
const STEP_MS = 5000;
// Keys written to the scratch table in one statement (one bound value: a JSON list read with json_each).
const KEYS_PER_WRITE = 5000;
// A delete needs references read this recently, from a scan started within the day.
const RECHECK_MS = 10 * 60 * 1000;
const SCAN_KEEP_MS = 24 * 60 * 60 * 1000;

// Tables whose text never counts as "in use" (review round 2): they only record that an image WAS used — the audit
// entry of a product's photo being replaced names the old photo for ever, so it was never called orphaned. A value is
// the rows that do still count. The scan's own scratch tables are left out the same way.
const HISTORY_TABLES = {
  audit_log: null,
  vendor_api_log: null,
  stripe_events: null,
  owner_notices: '"sentAt" IS NULL',   // a notice not emailed yet still needs its pictures; a sent one is history
  orphan_scans: null,
  orphan_scan_keys: null,
};

// The keys a stored value points to: a bare key ("uploads/…", "verify/…", how uploads are named) and the path of
// any web address in it (an image's public address is the store's base + "/" + its key).
const BARE_KEY_RE = /(?:^|[^A-Za-z0-9_-])((?:uploads|verify)\/[^\s"'<>?#\\)\],]+)/g;
const URL_PATH_RE = /https?:\/\/[^\/\s"'<>\\]+\/([^\s"'<>?#\\)\],]+)/g;
// Each match is added as found, cut at the first character a key never has (so "a.jpg&quot;" in stored HTML is
// still a.jpg), and without trailing punctuation ("…/a.jpg." at the end of a sentence).
function addKeys_(set, value) {
  const s = String(value);
  const add = (t) => {
    if (!t) return;
    set.add(t);
    const plain = (/^[A-Za-z0-9._\/-]+/.exec(t) || [""])[0];
    for (const v of [plain, t.replace(/[.,;:!\/-]+$/, ""), plain.replace(/[.,;:!\/-]+$/, "")]) if (v) set.add(v);
  };
  for (const m of s.matchAll(BARE_KEY_RE)) add(m[1]);
  for (const m of s.matchAll(URL_PATH_RE)) add(m[1]);
}

const NAME_RE = /^[A-Za-z0-9_]+$/;
const isTextType_ = (type) => !type || /TEXT|CHAR|CLOB|JSON/i.test(String(type));
const orphanError_ = (message) => Object.assign(new Error(message), { userFacing: true });

// The tables to search and each one's text columns: [{ t, c: [columns] }], by table name. One query for every
// table's columns; a database that won't join pragma_table_info gives the names only (c: null) and each table's
// columns are read when the scan reaches it (tableColumns_).
async function scanPlan_(db) {
  const tables = "m.type = 'table' AND m.name NOT LIKE 'sqlite_%' AND m.name NOT LIKE 'd1_%' AND m.name NOT LIKE '_cf_%'";
  const wanted = (t) => NAME_RE.test(t) && !(t in HISTORY_TABLES && HISTORY_TABLES[t] === null);
  try {
    const { results } = await db.prepare(`SELECT m.name AS t, p.name AS c, p.type AS type FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE ${tables} ORDER BY m.name, p.cid`).all();
    const by = new Map();
    for (const r of results || []) {
      const t = String(r.t), c = String(r.c);
      if (!wanted(t)) continue;
      if (!by.has(t)) by.set(t, []);
      if (isTextType_(r.type) && NAME_RE.test(c)) by.get(t).push(c);
    }
    return [...by].filter(([, c]) => c.length).map(([t, c]) => ({ t, c }));
  } catch (e) {
    const { results } = await db.prepare(`SELECT m.name AS t FROM sqlite_master m WHERE ${tables} ORDER BY m.name`).all();
    return (results || []).map(r => String(r.t)).filter(wanted).map(t => ({ t, c: null }));
  }
}
async function tableColumns_(db, t) {
  const { results } = await db.prepare(`SELECT name, type FROM pragma_table_info('${t}')`).all();
  return (results || []).filter(c => isTextType_(c.type)).map(c => String(c.name)).filter(c => NAME_RE.test(c));
}
// One page of a table's rows that mention an image, all its text columns in one statement: { rows, last, queries } —
// `last` is the rowid to read on from, null when the table is done (or has no rowids and was read in one go).
async function readTablePage_(db, t, cols, after) {
  const match = cols.map(c => `("${c}" LIKE '%uploads/%' OR "${c}" LIKE '%verify/%' OR "${c}" LIKE '%images.%')`).join(" OR ");
  const where = `(${match})${HISTORY_TABLES[t] ? ` AND (${HISTORY_TABLES[t]})` : ""}`;
  const list = cols.map(c => `"${c}"`).join(", ");
  let rows;
  try {
    ({ results: rows } = await db.prepare(`SELECT rowid AS _rid, ${list} FROM "${t}" WHERE ${where}${after == null ? "" : " AND rowid > ?"} ORDER BY rowid LIMIT ${ROWS_PER_READ}`)
      .bind(...(after == null ? [] : [after])).all());
  } catch (e) {
    if (after != null) throw e;
    ({ results: rows } = await db.prepare(`SELECT ${list} FROM "${t}" WHERE ${where}`).all());   // a table without rowids: read it in one go
    return { rows: rows || [], last: null, queries: 2 };
  }
  rows = rows || [];
  return { rows, last: rows.length < ROWS_PER_READ ? null : rows[rows.length - 1]._rid, queries: 1 };
}

const mainKeyOf_ = (key) => String(key).replace(/-thumb(\.[A-Za-z0-9]+)$/, "$1");
const publicBase_ = (env) => { const raw = String(env.R2_PUBLIC_BASE || "").replace(/\/+$/, ""); return raw && !/^https?:\/\//i.test(raw) ? "https://" + raw : raw; };
const newScanId_ = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, "0")).join("");
const parseState_ = (text) => { try { const v = JSON.parse(text); return v && typeof v === "object" ? v : null; } catch (e) { return null; } };

// One step of a scan. No scanId starts a new one ({ replaces } names the scan the page is done with: its rows are
// cleared, with any scan's kept past a day); { scanId } carries on; { scanId, recheck: true } reads the references
// again for that scan, keeping its list of orphans (Remove selected does this before deleting). Returns { scanId, done, phase: "tables" | "files" | "done", table, tables, orphans:
// [{key, url, size, uploaded, thumbOf}] this step found (thumbOf = the main key when this is a "-thumb" copy),
// scanned, recent, totalBytes } — the last three for the whole scan so far; the screen adds the orphans up.
export async function scanOrphanImages(env, db, { scanId = "", recheck = false, replaces = "", now = Date.now(), clock = Date.now } = {}) {
  if (!env.IMAGES) throw orphanError_("Image storage isn't set up on this site.");
  const began = clock();
  let used = 0, st, startedAt;   // used: the database queries this request has run
  const save = () => db.prepare("INSERT INTO orphan_scans (scanId, startedAt, state) VALUES (?, ?, ?) ON CONFLICT(scanId) DO UPDATE SET state = excluded.state")
    .bind(scanId, startedAt, JSON.stringify(st)).run();
  if (!scanId) {
    scanId = newScanId_();
    startedAt = new Date(now).toISOString();
    await db.prepare("DELETE FROM orphan_scans WHERE startedAt < ? OR scanId = ?").bind(new Date(now - SCAN_KEEP_MS).toISOString(), String(replaces || "")).run();
    await db.prepare("DELETE FROM orphan_scan_keys WHERE scanId NOT IN (SELECT scanId FROM orphan_scans)").run();
    st = { phase: "tables", plan: await scanPlan_(db), t: 0, after: null, r2: null, scanned: 0, recent: 0, found: 0, totalBytes: 0, refsAt: null, recheck: false };
    // The scan is on record before it keeps its first key, so the clean-up above, run for someone else's scan,
    // never takes this one's keys.
    await save();
    used += 4;
  } else {
    scanId = String(scanId);
    const row = await db.prepare("SELECT startedAt, state FROM orphan_scans WHERE scanId = ?").bind(scanId).first();
    used++;
    st = row ? parseState_(row.state) : null;
    if (!st) throw orphanError_("This scan is no longer kept — scan the image store again.");
    startedAt = row.startedAt;
    if (recheck) {
      await db.prepare("DELETE FROM orphan_scan_keys WHERE scanId = ? AND kind = 'ref'").bind(scanId).run();
      st = { ...st, phase: "tables", plan: await scanPlan_(db), t: 0, after: null, refsAt: null, recheck: true };
      used += 2;
    }
  }

  // The tables: one statement a page of rows; the keys found are written together at the end of the step (or every
  // KEYS_PER_WRITE). A read starts only while there's room for it (two tries for a table without rowids, one more
  // where the columns must be read first) and for what the step still has to do after: write the keys, keep its place.
  const found = new Set();
  const flush = async () => {
    const list = [...found];
    found.clear();
    for (let i = 0; i < list.length; i += KEYS_PER_WRITE) {
      await db.prepare("INSERT OR IGNORE INTO orphan_scan_keys (scanId, kind, key) SELECT ?, 'ref', value FROM json_each(?)").bind(scanId, JSON.stringify(list.slice(i, i + KEYS_PER_WRITE))).run();
      used++;
    }
  };
  while (st.phase === "tables" && st.t < st.plan.length && used + (st.plan[st.t].c ? 4 : 5) <= STEP_QUERIES && clock() - began < STEP_MS) {
    const tbl = st.plan[st.t];
    if (!tbl.c) { tbl.c = await tableColumns_(db, tbl.t); used++; }
    if (!tbl.c.length) { st.t++; st.after = null; continue; }
    const page = await readTablePage_(db, tbl.t, tbl.c, st.after);
    used += page.queries;
    for (const r of page.rows) for (const c of tbl.c) if (r[c]) addKeys_(found, r[c]);
    if (page.last == null) { st.t++; st.after = null; } else st.after = page.last;
    if (found.size >= KEYS_PER_WRITE) await flush();
  }
  await flush();
  const tables = st.plan ? st.plan.length : st.tables || 0;
  if (st.phase === "tables" && st.t >= st.plan.length) {
    st = { ...st, phase: st.recheck ? "done" : "files", refsAt: new Date(now).toISOString(), tables, plan: null };
  }

  // The bucket: one page of the listing a request, checked against the kept keys.
  const orphans = [];
  if (st.phase === "files" && used + 4 <= STEP_QUERIES) {
    const base = publicBase_(env);
    const page = await env.IMAGES.list({ cursor: st.r2 || undefined, limit: 1000 });
    const old = [];
    for (const o of page.objects || []) {
      st.scanned++;
      const uploaded = o.uploaded ? new Date(o.uploaded).getTime() : 0;
      if (uploaded && now - uploaded < GRACE_MS) { st.recent++; continue; }
      old.push(o);
    }
    const inUse = new Set();
    if (old.length) {
      const { results } = await db.prepare("SELECT key FROM orphan_scan_keys WHERE scanId = ? AND kind = 'ref' AND key IN (SELECT value FROM json_each(?))")
        .bind(scanId, JSON.stringify([...new Set(old.map(o => mainKeyOf_(o.key)))])).all();
      used++;
      for (const r of results || []) inUse.add(String(r.key));
    }
    for (const o of old) {
      const main = mainKeyOf_(o.key);
      if (inUse.has(main)) continue;
      orphans.push({ key: o.key, url: base ? base + "/" + o.key : "", size: Number(o.size) || 0, uploaded: o.uploaded ? new Date(o.uploaded).toISOString() : "", thumbOf: main !== o.key ? main : "" });
    }
    if (orphans.length) {
      await db.prepare("INSERT OR IGNORE INTO orphan_scan_keys (scanId, kind, key) SELECT ?, 'orphan', value FROM json_each(?)").bind(scanId, JSON.stringify(orphans.map(o => o.key))).run();
      used++;
      st.found += orphans.length;
      st.totalBytes += orphans.reduce((n, o) => n + o.size, 0);
    }
    st.r2 = page.truncated ? page.cursor : null;
    if (!st.r2) st.phase = "done";
  }
  if (st.phase === "done" && !st.found) {
    // Nothing orphaned: there is nothing a delete could take from this scan, so nothing of it is kept.
    await db.prepare("DELETE FROM orphan_scan_keys WHERE scanId = ?").bind(scanId).run();
    await db.prepare("DELETE FROM orphan_scans WHERE scanId = ?").bind(scanId).run();
  } else await save();
  return { scanId, done: st.phase === "done", phase: st.phase, table: st.phase === "tables" ? st.t : tables, tables, orphans,
    scanned: st.scanned, recent: st.recent, totalBytes: st.totalBytes };
}

// Deletes the given keys — each only if the scan (scanId) listed it as orphaned (so it exists and is past the grace
// period) and the references read again since don't point to it, so a stale list can't delete an image that's back
// in use. The scan's references must have been read in the last RECHECK_MS: the screen has them read again first
// (scanOrphanImages with recheck). At most DELETE_MAX a request; any past that are listed as kept, to delete next
// time. Returns {deleted: [keys], kept: [{key, why}]}.
export async function deleteOrphanImages(env, db, keys, { scanId = "", now = Date.now() } = {}) {
  if (!env.IMAGES) throw orphanError_("Image storage isn't set up on this site.");
  const all = [...new Set((Array.isArray(keys) ? keys : []).map(String))].filter(k => k && !k.includes("..") && !k.startsWith("/"));
  const want = all.slice(0, DELETE_MAX);
  const row = scanId ? await db.prepare("SELECT startedAt, state FROM orphan_scans WHERE scanId = ?").bind(String(scanId)).first() : null;
  const st = row ? parseState_(row.state) : null;
  const age = (iso) => now - new Date(iso || 0).getTime();
  if (!st || st.phase !== "done" || !st.refsAt || !(age(st.refsAt) <= RECHECK_MS) || !(age(row.startedAt) <= SCAN_KEEP_MS))
    throw orphanError_("This list is out of date — scan the image store again, then remove the files.");
  const refs = new Set(), listed = new Set();
  if (want.length) {
    const { results } = await db.prepare("SELECT kind, key FROM orphan_scan_keys WHERE scanId = ? AND key IN (SELECT value FROM json_each(?))")
      .bind(String(scanId), JSON.stringify([...new Set(want.concat(want.map(mainKeyOf_)))])).all();
    for (const r of results || []) (r.kind === "ref" ? refs : listed).add(String(r.key));
  }
  const toDelete = [], kept = [];
  for (const key of want) {
    if (refs.has(mainKeyOf_(key))) { kept.push({ key, why: "in use again" }); continue; }
    if (!listed.has(key)) { kept.push({ key, why: "not on the scan's list" }); continue; }
    toDelete.push(key);
  }
  // R2 deletes up to 1,000 keys in one call.
  if (toDelete.length) {
    await env.IMAGES.delete(toDelete);
    await db.prepare("DELETE FROM orphan_scan_keys WHERE scanId = ? AND kind = 'orphan' AND key IN (SELECT value FROM json_each(?))").bind(String(scanId), JSON.stringify(toDelete)).run();
  }
  for (const key of all.slice(DELETE_MAX)) kept.push({ key, why: `more than ${DELETE_MAX.toLocaleString("en-US")} at once — delete the rest next` });
  return { deleted: toDelete, kept };
}
