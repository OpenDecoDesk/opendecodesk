// Unsaved uploads (review #24): files put in the private buckets whose form was never saved, so nothing in the
// database points to them — a receipt picked on an expense that was then cancelled, a design or machine file uploaded
// on a version that was never saved, an order attachment or a digital product's file whose dialog was closed. Each
// upload handler stores the file first and the record that names it afterwards; when the second step never happens
// the file stays in storage forever. cleanUpUnsavedUploads (the daily housekeeping, src/worker.js) deletes them:
//
//   RECEIPTS  receipts/                           (receipt.js; vendor-logs/ is the vendor log's own, cleaned there)
//   DESIGNS   designs/, order-files/, digital/    (design.js, customer-design.js)
//
// "Points to" is every column named …Key in every table (receiptKey on expenses, payments, stock and transfer
// movements, money entries, shipping labels and brand approvals; fileKey on order files, customer uploads, product
// files and download grants; designFileKey / machineFileKey on design versions and order designs; and any column a
// later migration adds by the same naming), read from the database itself so a new one is covered without a change
// here. A customer's design upload waiting for its order is named by customer_design_uploads, so it stays until its
// own clean-up (customer-design.js) deletes the row and the file together.
//
// Never touched: anything uploaded in the last UNSAVED_UPLOADS_KEEP_HOURS (a form may still be open with it), and
// anything at all when no …Key column can be found. At most UNSAVED_UPLOADS_DELETE_MAX deletions a run, and listing
// stops when the run has used its time (UNSAVED_UPLOADS_BUDGET_MS) or looked at UNSAVED_UPLOADS_MAX_PAGES pages of
// 1,000 files (each page is one storage call and one database query, and the housekeeping tick shares Cloudflare's
// per-run request allowance — 50 on the Free plan — with its other jobs); where it stopped is kept (global_settings
// 'unsavedUploadsCleanup', the last key looked at per prefix) and the next run carries on from there, starting
// again at the top once a prefix has been gone through. A bucket that isn't bound is skipped without a word. A
// failed deletion is returned in `errors` (the housekeeping records it as a system issue) and that bucket's place is
// left where it was, so the next run looks at those files again.
// No imports: tests load this file as plain source.

export const UNSAVED_UPLOADS_KEEP_HOURS = 48;
export const UNSAVED_UPLOADS_DELETE_MAX = 1000;
export const UNSAVED_UPLOADS_BUDGET_MS = 20000;
export const UNSAVED_UPLOADS_MAX_PAGES = 8;
export const UNSAVED_UPLOAD_PLACES = [
  { binding: "RECEIPTS", prefixes: ["receipts/"] },
  { binding: "DESIGNS", prefixes: ["designs/", "order-files/", "digital/"] },
];
const RESUME_KEY_ = "unsavedUploadsCleanup";
const LIST_PAGE_ = 1000;
const KEY_COLUMN_RE_ = /^[a-z][A-Za-z0-9]*Key$/;
const NAME_RE_ = /^[A-Za-z0-9_]+$/;

// Every [table, column] whose column is named …Key: one query, else (a database that won't join pragma_table_info)
// one per table.
export async function uploadKeyColumns(db) {
  const keep = (rows) => (rows || []).filter(r => NAME_RE_.test(String(r.t)) && KEY_COLUMN_RE_.test(String(r.c)) && NAME_RE_.test(String(r.c))).map(r => [String(r.t), String(r.c)]);
  const tables = "m.type = 'table' AND m.name NOT LIKE 'sqlite_%' AND m.name NOT LIKE 'd1_%' AND m.name NOT LIKE '_cf_%'";
  try {
    const { results } = await db.prepare(`SELECT m.name AS t, p.name AS c FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE ${tables}`).all();
    return keep(results);
  } catch (e) {
    const { results: ts } = await db.prepare(`SELECT m.name AS t FROM sqlite_master m WHERE ${tables}`).all();
    const out = [];
    for (const { t } of ts || []) {
      if (!NAME_RE_.test(String(t))) continue;
      const { results: cols } = await db.prepare(`SELECT '${t}' AS t, name AS c FROM pragma_table_info('${t}')`).all();
      out.push(...keep(cols));
    }
    return out;
  }
}

// Which of `keys` some …Key column holds: one query for a page of keys, each column read once.
async function referencedAmong_(db, columns, keys) {
  if (!keys.length) return new Set();
  const named = columns.map(([t, c]) => `SELECT "${c}" FROM "${t}" WHERE "${c}" IS NOT NULL`).join(" UNION ALL ");
  const { results } = await db.prepare(`SELECT value AS k FROM json_each(?) WHERE value IN (${named})`).bind(JSON.stringify(keys)).all();
  return new Set((results || []).map(r => String(r.k)));
}

async function readResume_(db) {
  try {
    const row = await db.prepare("SELECT value FROM global_settings WHERE key = ?").bind(RESUME_KEY_).first();
    const v = row ? JSON.parse(row.value) : null;
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch (e) { return {}; }
}

// Returns { deleted, scanned, recent, referenced, skipped: [bindings], errors: [messages], finished }. `finished` is
// false when the run stopped for its time or its deletion cap before going through everything.
export async function cleanUpUnsavedUploads(env, { now = Date.now(), clock = Date.now, limit = UNSAVED_UPLOADS_DELETE_MAX, budgetMs = UNSAVED_UPLOADS_BUDGET_MS, maxPages = UNSAVED_UPLOADS_MAX_PAGES } = {}) {
  const out = { deleted: 0, scanned: 0, recent: 0, referenced: 0, skipped: [], errors: [], finished: true };
  const usable = (b) => !!b && typeof b.list === "function" && typeof b.delete === "function";
  const places = UNSAVED_UPLOAD_PLACES.filter(p => { if (usable(env && env[p.binding])) return true; out.skipped.push(p.binding); return false; });
  if (!places.length || !env.DB) return out;
  const started = clock();
  const cap = Math.max(0, Math.min(UNSAVED_UPLOADS_DELETE_MAX, Number(limit) || 0));
  const cutoff = now - UNSAVED_UPLOADS_KEEP_HOURS * 3600 * 1000;
  const columns = await uploadKeyColumns(env.DB);
  // Without the columns that name uploads, every file would look unsaved: delete nothing.
  if (!columns.length) throw new Error("No …Key columns found in the database; nothing was deleted.");
  const resume = await readResume_(env.DB), was = { ...resume };
  let chosen = 0, stopped = false, pages = 0;
  for (const place of places) {
    const bucket = env[place.binding], doomed = [];
    for (const prefix of place.prefixes) {
      const at = place.binding + ":" + prefix;
      let after = typeof resume[at] === "string" && resume[at].startsWith(prefix) ? resume[at] : "";
      for (;;) {
        if (chosen >= cap) { stopped = true; break; }
        if (clock() - started >= budgetMs || pages >= maxPages) { stopped = true; break; }
        pages++;
        const page = await bucket.list({ prefix, limit: LIST_PAGE_, ...(after ? { startAfter: after } : {}) });
        const objects = (page && page.objects) || [];
        const old = objects.filter(o => { const up = o.uploaded ? new Date(o.uploaded).getTime() : 0; return up && up < cutoff; });
        const inUse = await referencedAmong_(env.DB, columns, old.map(o => o.key));
        let last = after;
        for (const o of objects) {
          const up = o.uploaded ? new Date(o.uploaded).getTime() : 0;
          if (!(up && up < cutoff)) { out.recent++; out.scanned++; last = o.key; continue; }
          if (inUse.has(o.key)) { out.referenced++; out.scanned++; last = o.key; continue; }
          if (chosen >= cap) break;   // the rest of this page waits for the next run
          doomed.push(o.key); chosen++; out.scanned++; last = o.key;
        }
        after = last;
        if (chosen >= cap && objects.length && last !== objects[objects.length - 1].key) { stopped = true; break; }
        if (!page || !page.truncated) { after = ""; break; }   // the whole prefix gone through: start at the top next time
      }
      resume[at] = after;
      if (stopped) break;
    }
    // R2 deletes up to 1,000 keys in one call.
    for (let i = 0; i < doomed.length; i += 1000) {
      const keys = doomed.slice(i, i + 1000);
      try { await bucket.delete(keys); out.deleted += keys.length; }
      catch (e) {
        out.errors.push(`${place.binding}: deleting ${keys.length} file${keys.length === 1 ? "" : "s"} failed — ${String((e && e.message) || e).slice(0, 120)}`);
        for (const prefix of place.prefixes) { const at = place.binding + ":" + prefix; if (at in was) resume[at] = was[at]; else delete resume[at]; }
        break;
      }
    }
    if (stopped) break;
  }
  out.finished = !stopped;
  try { await env.DB.prepare("INSERT OR REPLACE INTO global_settings (key, value) VALUES (?, ?)").bind(RESUME_KEY_, JSON.stringify(resume)).run(); }
  catch (e) { out.errors.push("Couldn't keep where the clean-up stopped: " + String((e && e.message) || e).slice(0, 120)); }
  return out;
}
