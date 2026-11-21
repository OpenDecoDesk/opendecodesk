// Tools → Orphaned images (2026-10): files in the public image store (the IMAGES R2 bucket) that nothing in the
// database points to any more — a photo replaced or removed from a product / blank / org / graphic, a duplicate
// taken off a blank, an upload whose form was never saved, a design-verification image whose record is gone.
// "Points to" is checked generically: every text column of every table is searched for image addresses, so a new
// table that stores them is covered without a change here (order lines' snapshots count — an order still shows its
// picture). A "-thumb" copy belongs to its main image. Files uploaded in the last 24 hours are never called orphaned
// (a form may still be open with them). Deleting re-checks every key on the server first.
// The addresses found are kept as a set of keys (each value's image keys pulled out as it's read, a page of rows at a
// time), so the work grows with the number of files and references, not their product.
const GRACE_MS = 24 * 60 * 60 * 1000;
const ROWS_PER_READ = 2000;
const DELETE_MAX = 1000;

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

// Every image key the database's text points to, as a Set.
async function referencedKeys_(db) {
  const keys = new Set();
  const { results: tables } = await db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' AND name NOT LIKE '_cf_%'").all();
  for (const t of tables || []) {
    const name = String(t.name);
    if (!/^[A-Za-z0-9_]+$/.test(name)) continue;
    const { results: cols } = await db.prepare(`SELECT name, type FROM pragma_table_info('${name}')`).all();
    const textCols = (cols || []).filter(c => !c.type || /TEXT|CHAR|CLOB|JSON/i.test(String(c.type))).map(c => String(c.name)).filter(c => /^[A-Za-z0-9_]+$/.test(c));
    for (const c of textCols) {
      const match = `("${c}" LIKE '%uploads/%' OR "${c}" LIKE '%verify/%' OR "${c}" LIKE '%images.%')`;
      // A page of matching rows at a time (by rowid), so one big column is never held whole.
      let after = null, paged = true;
      for (;;) {
        let rows;
        try {
          ({ results: rows } = await db.prepare(`SELECT rowid AS rid, "${c}" AS v FROM "${name}" WHERE ${match}${after == null ? "" : " AND rowid > ?"} ORDER BY rowid LIMIT ${ROWS_PER_READ}`)
            .bind(...(after == null ? [] : [after])).all());
        } catch (e) {
          if (after != null) throw e;
          paged = false;   // a table without rowids: read it in one go
          ({ results: rows } = await db.prepare(`SELECT "${c}" AS v FROM "${name}" WHERE ${match}`).all());
        }
        for (const r of rows || []) if (r.v) addKeys_(keys, r.v);
        if (!paged || !rows || rows.length < ROWS_PER_READ) break;
        after = rows[rows.length - 1].rid;
      }
    }
  }
  return keys;
}

const mainKeyOf_ = (key) => String(key).replace(/-thumb(\.[A-Za-z0-9]+)$/, "$1");
const publicBase_ = (env) => { const raw = String(env.R2_PUBLIC_BASE || "").replace(/\/+$/, ""); return raw && !/^https?:\/\//i.test(raw) ? "https://" + raw : raw; };

// Lists every object in the bucket and returns the unreferenced ones: {orphans: [{key, url, size, uploaded, thumbOf}],
// scanned, recent, totalBytes}. thumbOf = the main key when this is a "-thumb" copy.
export async function findOrphanImages(env, db, { now = Date.now() } = {}) {
  if (!env.IMAGES) throw Object.assign(new Error("Image storage isn't set up on this site."), { userFacing: true });
  const refs = await referencedKeys_(db);
  const base = publicBase_(env);
  const orphans = [];
  let scanned = 0, recent = 0, cursor;
  do {
    const page = await env.IMAGES.list({ cursor, limit: 1000 });
    for (const o of page.objects || []) {
      scanned++;
      const uploaded = o.uploaded ? new Date(o.uploaded).getTime() : 0;
      if (uploaded && now - uploaded < GRACE_MS) { recent++; continue; }
      const main = mainKeyOf_(o.key);
      if (refs.has(main)) continue;
      orphans.push({ key: o.key, url: base ? base + "/" + o.key : "", size: Number(o.size) || 0, uploaded: o.uploaded ? new Date(o.uploaded).toISOString() : "", thumbOf: main !== o.key ? main : "" });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  orphans.sort((a, b) => String(a.key).localeCompare(String(b.key)));
  return { orphans, scanned, recent, totalBytes: orphans.reduce((s, o) => s + o.size, 0) };
}

// Deletes the given keys — each only if it is STILL unreferenced and older than the grace period (re-checked here,
// so a stale list can't delete an image that's back in use). At most DELETE_MAX a request; any past that are
// listed as kept, to delete next time. Returns {deleted: [keys], kept: [{key, why}]}.
export async function deleteOrphanImages(env, db, keys, { now = Date.now() } = {}) {
  if (!env.IMAGES) throw Object.assign(new Error("Image storage isn't set up on this site."), { userFacing: true });
  const all = [...new Set((Array.isArray(keys) ? keys : []).map(String))].filter(k => k && !k.includes("..") && !k.startsWith("/"));
  const want = all.slice(0, DELETE_MAX);
  const refs = await referencedKeys_(db);
  const toDelete = [], kept = [];
  for (const key of want) {
    if (refs.has(mainKeyOf_(key))) { kept.push({ key, why: "in use again" }); continue; }
    const head = await env.IMAGES.head(key).catch(() => null);
    if (!head) { kept.push({ key, why: "already gone" }); continue; }
    const uploaded = head.uploaded ? new Date(head.uploaded).getTime() : 0;
    if (uploaded && now - uploaded < GRACE_MS) { kept.push({ key, why: "uploaded in the last 24 hours" }); continue; }
    toDelete.push(key);
  }
  // R2 deletes up to 1,000 keys in one call.
  if (toDelete.length) await env.IMAGES.delete(toDelete);
  for (const key of all.slice(DELETE_MAX)) kept.push({ key, why: `more than ${DELETE_MAX.toLocaleString("en-US")} at once — delete the rest next` });
  return { deleted: toDelete, kept };
}
