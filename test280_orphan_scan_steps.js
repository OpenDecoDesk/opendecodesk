const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { ADMIN_ORIGIN } = require("./testlib/hosts");

// Settings → Orphaned images, within Cloudflare's query allowance (2026-11, review round 2). D1 caps the queries one
// Worker request may run — 50 on the Free plan, 1,000 on Workers Paid — and the scan ran one for every text column of
// every table: about 700 on a new install, more with every 2,000 rows that mention an image. Now:
//   - every table's columns are read in ONE query and each table is searched with ONE statement over all its text
//     columns (a page of rows at a time), so a whole scan of a new install is under 100 queries;
//   - the scan runs in steps the page drives: a request runs at most 25 queries and answers with a scanId to carry on
//     with; what it found waits in orphan_scan_keys (migrations/0106) between steps; the bucket is listed a page a
//     request and each page checked against those keys;
//   - deleting no longer runs a second whole scan in its own request, nor one head() call per file: the page has the
//     references read again in steps, and the delete takes only files that scan listed and nothing points to now;
//   - tables that only hold history (the audit log, the vendor API log, Stripe events, owner notices already sent)
//     don't count as "in use", so a photo replaced on a product IS reported; an order line's snapshot still counts.
// The real schema.sql, db.js, orders.js and orphanImages.js on sql.js with a stand-in R2 bucket. Invented data only.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { createProduct, insertOrder };`)();
const orphanSrc = strip(read("functions/_lib/orphanImages.js"));
const orphan = new Function(orphanSrc + "\nreturn { scanOrphanImages, deleteOrphanImages, STEP_QUERIES };")();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" + strip(read("functions/_lib/fileUpload.js")) + "\n" + strip(read("functions/_lib/vendorImages.js")) + "\n" + orphanSrc + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'owner@example.test'; " + require("./testlib/roles").adminAs() + "\n" + strip(read("functions/_lib/permissions.js")) + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const BASE = "https://images.example.test";

// A stand-in R2 bucket: list (pages of `per`), delete (one key or a list); head() is counted — nothing should call it.
function bucket(objects, per = 1000) {
  const store = new Map(objects.map(o => [o.key, o]));
  const b = { _store: store, lists: 0, heads: 0, deletes: 0,
    list: async ({ cursor, limit }) => { b.lists++; const all = [...store.values()].sort((x, y) => (x.key < y.key ? -1 : 1)); const start = Number(cursor || 0), n = Math.min(limit || 1000, per);
      return { objects: all.slice(start, start + n), truncated: start + n < all.length, cursor: String(start + n) }; },
    head: async (k) => { b.heads++; return store.get(k) || null; },
    delete: async (k) => { b.deletes++; for (const x of [].concat(k)) store.delete(x); } };
  return b;
}
// Counts the database queries: each first / all / run, and each statement of a batch.
function counting(d1, { refuseJoin = false } = {}) {
  const c = { q: 0, sql: [] };
  const wrap = (st, sql) => ({ _sql: st._sql, _params: st._params,
    first: (...a) => { c.q++; c.sql.push(sql); return st.first(...a); }, all: (...a) => { c.q++; c.sql.push(sql); return st.all(...a); }, run: (...a) => { c.q++; c.sql.push(sql); return st.run(...a); } });
  const db = {
    prepare: (sql) => {
      // A database that won't join pragma_table_info to sqlite_master: the statement fails when it's run.
      if (refuseJoin && /JOIN pragma_table_info/.test(sql)) return { all: async () => { c.q++; throw new Error("no such table-valued function"); }, bind() { return this; } };
      const p = d1.prepare(sql); return Object.assign(wrap(p, sql), { bind: (...v) => wrap(p.bind(...v), sql) });
    },
    batch: (stmts) => { c.q += stmts.length; return d1.batch(stmts); },
  };
  return { db, c };
}
// The whole scan, step after step as the page asks: the orphans added up, and each step's query count.
async function fullScan(mod, env, db, c, now, first = {}) {
  const out = { orphans: [], steps: [], progress: [] };
  let d = null;
  for (;;) {
    const before = c.q;
    d = await mod.scanOrphanImages(env, db, d ? { scanId: d.scanId, now } : { ...first, now });
    out.steps.push(c.q - before);
    out.progress.push(d.phase + ":" + d.table + "/" + d.tables);
    out.orphans.push(...d.orphans);
    if (d.done) return Object.assign(out, { scanId: d.scanId, scanned: d.scanned, recent: d.recent, totalBytes: d.totalBytes, total: out.steps.reduce((a, b) => a + b, 0) });
    if (out.steps.length > 500) throw new Error("the scan never finished");
  }
}

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("schema.sql"));   // a new install's database, exactly
  const tableCount = d1.q("SELECT count(*) n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")[0].n;
  const textCols = d1.q("SELECT count(*) n FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' AND (p.type = '' OR p.type LIKE '%TEXT%' OR p.type LIKE '%CHAR%')")[0].n;
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('acme','acme','Example Club','t','t',1);`);
  const now = Date.parse("2026-11-20T12:00:00Z"), old = "2026-10-01T00:00:00Z", fresh = "2026-11-20T06:00:00Z";
  const obj = (key, uploaded = old, size = 1000) => ({ key, uploaded: new Date(uploaded), size });
  const call = async (body, env) => {
    const waits = [];
    const res = await api({ env: Object.assign({ DB: d1 }, env), waitUntil: (p) => waits.push(Promise.resolve(p).catch(() => {})),
      request: { url: ADMIN_ORIGIN + "/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    await Promise.all(waits);
    return { status: res.status, body: JSON.parse(await res.text()) };
  };

  console.log("=== A whole scan of a new install's schema ===");
  await lib.createProduct(d1, "acme", { productId: "tee", type: "shirt", name: "Tee", pricingMode: "flat", flatPrice: 20, visible: true, images: [`${BASE}/uploads/acme/tee-front.jpg`] });
  await lib.insertOrder(d1, { orderId: "O1", orgId: "acme", customerName: "C", contact: "c@example.test", placedAt: "2026-11-01T00:00:00Z" }, [{ productId: "tee", name: "Tee", type: "shirt", size: "", qty: 1, unitPrice: 20 }]);
  d1._raw.run("UPDATE order_items SET configJson=? WHERE orderId='O1'", [JSON.stringify({ locations: [{ imageUrl: `${BASE}/uploads/acme/line-art.png` }] })]);
  const env = { IMAGES: bucket([obj("uploads/acme/tee-front.jpg"), obj("uploads/acme/tee-front-thumb.jpg"), obj("uploads/acme/line-art.png"),
    obj("uploads/acme/gone.jpg", old, 4000), obj("uploads/acme/gone-thumb.jpg", old, 500), obj("uploads/acme/new.jpg", fresh), obj("verify/abc.png", old, 2000)]), R2_PUBLIC_BASE: BASE };
  let { db, c } = counting(d1);
  let s = await fullScan(orphan, env, db, c, now);
  const keysOf = (x) => x.orphans.map(o => o.key).sort().join();
  ok("it finds the files nothing points to, the -thumb with its main image, and leaves the ones in use and the day's uploads",
    keysOf(s) === "uploads/acme/gone-thumb.jpg,uploads/acme/gone.jpg,verify/abc.png" && s.scanned === 7 && s.recent === 1 && s.totalBytes === 6500 &&
    s.orphans.find(o => o.key === "uploads/acme/gone-thumb.jpg").thumbOf === "uploads/acme/gone.jpg" && s.orphans.find(o => o.key === "verify/abc.png").url === `${BASE}/verify/abc.png`);
  ok(`the schema has ${tableCount} tables and ${textCols} text columns (one query each, before: ${tableCount + textCols + 1} or more)`, tableCount > 80 && textCols > 600);
  ok(`the whole scan takes ${s.total} queries — about one a table and a handful a request, fewer than 100`, s.total > 0 && s.total < 100 && s.total < tableCount + 12);
  ok(`…in ${s.steps.length} requests, none over its share of ${orphan.STEP_QUERIES} (${s.steps.join(", ")})`, s.steps.length > 1 && orphan.STEP_QUERIES === 25 && Math.max(...s.steps) <= 25);
  ok("…every table's columns come from ONE query, and no table is read once per column",
    c.sql.filter(q => /pragma_table_info/.test(q)).length === 1 && c.sql.filter(q => /FROM "products" WHERE/.test(q)).length === 1 && /"imagesJson" LIKE[^;]*"name" LIKE|"name" LIKE[^;]*"imagesJson" LIKE/.test(c.sql.find(q => /FROM "products" WHERE/.test(q))));
  const tablesSeen = s.progress.filter(p => p.startsWith("tables:")).map(p => Number(p.split(":")[1].split("/")[0]));
  ok("…each answer says how far it is (table n of m), always further along", tablesSeen.length >= 2 && tablesSeen.every((n, i) => i === 0 || n > tablesSeen[i - 1]) && /^tables:\d+\/\d{2,3}$/.test(s.progress[0]) && s.progress[s.progress.length - 1].startsWith("done:"));
  ok("…the scan's own scratch tables and the history tables are never searched", !c.sql.some(q => /FROM "(orphan_scans|orphan_scan_keys|audit_log|vendor_api_log|stripe_events)" WHERE/.test(q)) && c.sql.some(q => /FROM "owner_notices" WHERE .*"sentAt" IS NULL/.test(q)));

  console.log("\n=== History doesn't keep a file ===");
  // The product's photo is replaced through the admin: the audit entry of the change names the old photo.
  let r = await call({ action: "updateProduct", org: "acme", productId: "tee", type: "shirt", name: "Tee", pricingMode: "flat", flatPrice: 20, visible: true, images: [`${BASE}/uploads/acme/tee-new.jpg`], features: [] }, env);
  const auditRow = d1.q("SELECT detail FROM audit_log WHERE action = 'product.updated' ORDER BY id DESC LIMIT 1")[0];
  ok("replacing a product's photo is audited with the old address", r.status === 200 && !!auditRow && /tee-front\.jpg/.test(auditRow.detail));
  env.IMAGES._store.set("uploads/acme/tee-new.jpg", obj("uploads/acme/tee-new.jpg"));
  d1._raw.run("INSERT INTO owner_notices (kind, summary, imageUrls, createdAt, sentAt) VALUES ('design', 'sent', ?, 't', '2026-11-02T00:00:00Z')", [JSON.stringify([`${BASE}/uploads/acme/notice-sent.png`])]);
  d1._raw.run("INSERT INTO owner_notices (kind, summary, imageUrls, createdAt, sentAt) VALUES ('design', 'waiting', ?, 't', NULL)", [JSON.stringify([`${BASE}/uploads/acme/notice-waiting.png`])]);
  d1._raw.run("INSERT INTO stripe_events (eventId, type, orderId, processedAt) VALUES ('evt_1', 'uploads/acme/in-event.png', 'O1', 't')");
  d1._raw.run("INSERT INTO vendor_api_log (connectionId, at, url) VALUES (1, 't', ?)", [`${BASE}/uploads/acme/in-vendor-log.png`]);
  for (const k of ["notice-sent.png", "notice-waiting.png", "in-event.png", "in-vendor-log.png"]) env.IMAGES._store.set("uploads/acme/" + k, obj("uploads/acme/" + k));
  ({ db, c } = counting(d1));
  s = await fullScan(orphan, env, db, c, now);
  const found = new Set(s.orphans.map(o => o.key));
  ok("the replaced photo (and its thumbnail) is orphaned, though the audit log still names it", found.has("uploads/acme/tee-front.jpg") && found.has("uploads/acme/tee-front-thumb.jpg") && !found.has("uploads/acme/tee-new.jpg"));
  ok("…so is a file only a sent owner notice, a Stripe event or the vendor API log mentions", found.has("uploads/acme/notice-sent.png") && found.has("uploads/acme/in-event.png") && found.has("uploads/acme/in-vendor-log.png"));
  ok("…but a notice not sent yet keeps its picture, and an order line's snapshot still counts", !found.has("uploads/acme/notice-waiting.png") && !found.has("uploads/acme/line-art.png"));

  console.log("\n=== Deleting: checked again, in a handful of queries ===");
  // Since the list was drawn, one orphan was put back on the product.
  d1._raw.run("UPDATE products SET imagesJson=? WHERE productId='tee'", [JSON.stringify([`${BASE}/uploads/acme/tee-new.jpg`, `${BASE}/uploads/acme/gone.jpg`])]);
  const pick = ["uploads/acme/gone.jpg", "uploads/acme/gone-thumb.jpg", "verify/abc.png", "uploads/acme/tee-front.jpg", "uploads/acme/new.jpg", "uploads/acme/never-there.jpg"];
  let stale = null;
  try { await orphan.deleteOrphanImages(env, db, pick, { scanId: s.scanId, now: now + 11 * 60 * 1000 }); } catch (e) { stale = e; }
  ok("a list whose references were read more than a few minutes ago is refused whole", !!stale && stale.userFacing === true && /out of date/.test(stale.message) && env.IMAGES._store.has("verify/abc.png"));
  let none = null;
  try { await orphan.deleteOrphanImages(env, db, pick, { now }); } catch (e) { none = e; }
  ok("…and so is a delete that names no scan", !!none && none.userFacing === true && env.IMAGES._store.has("verify/abc.png"));
  // Remove selected: the references are read again (in steps), the scan's list of orphans kept.
  const listsBefore = env.IMAGES.lists;
  const again = await fullScan(orphan, env, db, c, now, { scanId: s.scanId, recheck: true });
  ok(`reading the references again takes ${again.steps.length} requests, none over its share (${again.steps.join(", ")}), and lists no files`, again.steps.length > 1 && Math.max(...again.steps) <= 25 && env.IMAGES.lists === listsBefore && again.orphans.length === 0);
  ok("…the list of orphans is still there, and isn't itself taken for a reference", d1.q("SELECT count(*) n FROM orphan_scan_keys WHERE kind = 'orphan' AND scanId = ?", s.scanId)[0].n === s.orphans.length &&
    d1.q("SELECT count(*) n FROM orphan_scan_keys r WHERE r.kind = 'ref' AND r.key = 'verify/abc.png' AND scanId = ?", s.scanId)[0].n === 0);
  const before = c.q;
  env.IMAGES.heads = 0; env.IMAGES.deletes = 0;
  const del = await orphan.deleteOrphanImages(env, db, pick, { scanId: s.scanId, now });
  ok("the file put back in use is kept, with its thumbnail", del.kept.filter(k => k.why === "in use again").map(k => k.key).sort().join() === "uploads/acme/gone-thumb.jpg,uploads/acme/gone.jpg" && env.IMAGES._store.has("uploads/acme/gone.jpg") && env.IMAGES._store.has("uploads/acme/gone-thumb.jpg"));
  ok("…a file from the last 24 hours and one the scan never listed are kept", del.kept.filter(k => k.why === "not on the scan's list").map(k => k.key).sort().join() === "uploads/acme/never-there.jpg,uploads/acme/new.jpg" && env.IMAGES._store.has("uploads/acme/new.jpg"));
  ok("…the orphans are deleted", del.deleted.slice().sort().join() === "uploads/acme/tee-front.jpg,verify/abc.png" && !env.IMAGES._store.has("verify/abc.png") && !env.IMAGES._store.has("uploads/acme/tee-front.jpg"));
  ok(`…in ${c.q - before} queries, one storage call and no look at each file in turn`, c.q - before <= 4 && env.IMAGES.deletes === 1 && env.IMAGES.heads === 0);

  console.log("\n=== A big install: more rows, more files, the same share a request ===");
  {
    // 2 rows a read and 3 files a listing page stand in for 2,000 and 1,000; 40 settings and 30 order lines name images.
    const small = new Function(orphanSrc.replace("const ROWS_PER_READ = 2000;", "const ROWS_PER_READ = 2;") + "\nreturn { scanOrphanImages, deleteOrphanImages };")();
    const files = [];
    for (let i = 0; i < 40; i++) { d1._raw.run("INSERT INTO global_settings (key, value) VALUES (?, ?)", ["pic" + i, `{"img":"${BASE}/uploads/acme/set${i}.jpg"}`]); files.push(obj(`uploads/acme/set${i}.jpg`)); }
    for (let i = 0; i < 30; i++) {
      await lib.insertOrder(d1, { orderId: "B" + i, orgId: "acme", customerName: "C", contact: "c@example.test", placedAt: "2026-11-01T00:00:00Z" }, [{ productId: "tee", name: "Tee", type: "shirt", size: "", qty: 1, unitPrice: 20 }]);
      d1._raw.run("UPDATE order_items SET configJson=? WHERE orderId=?", [JSON.stringify({ locations: [{ imageUrl: `${BASE}/uploads/acme/line${i}.png` }] }), "B" + i]);
      files.push(obj(`uploads/acme/line${i}.png`));
    }
    for (let i = 0; i < 25; i++) files.push(obj(`uploads/acme/stray${i}.jpg`));
    const big = { IMAGES: bucket(files, 3), R2_PUBLIC_BASE: BASE };
    ({ db, c } = counting(d1));
    const b = await fullScan(small, big, db, c, now);
    ok(`95 files and 70 rows that name one: ${b.steps.length} requests, none over its share (the most: ${Math.max(...b.steps)})`, b.steps.length > 30 && Math.max(...b.steps) <= 25);
    ok("…exactly the 25 strays are orphaned, whichever step read their table or listed their page", b.orphans.length === 25 && b.orphans.every(o => /stray\d+\.jpg$/.test(o.key)) && b.scanned === 95);
    ok("…and one listing page a request", big.IMAGES.lists === Math.ceil(95 / 3) && b.progress.filter(p => p.startsWith("files:")).length >= 30);
  }

  console.log("\n=== What a scan keeps, and for how long ===");
  {
    const small = new Function(orphanSrc.replace("const ROWS_PER_READ = 2000;", "const ROWS_PER_READ = 2;") + "\nreturn { scanOrphanImages, deleteOrphanImages };")();
    const store = { IMAGES: bucket([obj("uploads/acme/set1.jpg"), obj("uploads/acme/stray-a.jpg"), obj("uploads/acme/stray-b.jpg")], 2), R2_PUBLIC_BASE: BASE };
    const rowsOf = (id) => d1.q("SELECT count(*) n FROM orphan_scan_keys WHERE scanId = ?", id)[0].n + d1.q("SELECT count(*) n FROM orphan_scans WHERE scanId = ?", id)[0].n;
    // Two scans at once (two people, or two tabs), a step each in turn: each keeps its own rows.
    let x = await small.scanOrphanImages(store, db, { now }), y = await small.scanOrphanImages(store, db, { now });
    const xs = [...x.orphans], ys = [...y.orphans];
    for (let i = 0; i < 300 && (!x.done || !y.done); i++) {
      if (!x.done) { x = await small.scanOrphanImages(store, db, { scanId: x.scanId, now }); xs.push(...x.orphans); }
      if (!y.done) { y = await small.scanOrphanImages(store, db, { scanId: y.scanId, now }); ys.push(...y.orphans); }
    }
    const strays = "uploads/acme/stray-a.jpg,uploads/acme/stray-b.jpg";
    ok("two scans at once don't disturb each other: both end with the same list", x.done && y.done && x.scanId !== y.scanId && xs.map(o => o.key).sort().join() === strays && ys.map(o => o.key).sort().join() === strays &&
      rowsOf(x.scanId) > 2 && rowsOf(y.scanId) > 2);
    // The page's next scan names the one it's done with: that one's rows go, the other person's stay.
    const z = await small.scanOrphanImages(store, db, { replaces: x.scanId, now });
    ok("the page's next scan clears the one it replaces, and only that one", rowsOf(x.scanId) === 0 && rowsOf(y.scanId) > 2 && rowsOf(z.scanId) >= 1);
    let gone = null, goneDel = null;
    try { await small.scanOrphanImages(store, db, { scanId: x.scanId, now }); } catch (e) { gone = e; }
    try { await small.deleteOrphanImages(store, db, ["uploads/acme/stray-a.jpg"], { scanId: x.scanId, now }); } catch (e) { goneDel = e; }
    ok("…a cleared scan can't be carried on, nor deleted from", !!gone && gone.userFacing === true && /no longer kept — scan the image store again/.test(gone.message) && !!goneDel && goneDel.userFacing === true && store.IMAGES._store.has("uploads/acme/stray-a.jpg"));
    // A day on, whoever starts a scan clears what was left behind.
    const later = await small.scanOrphanImages(store, db, { now: now + 25 * 3600 * 1000 });
    ok("scans kept past a day go when anyone starts one", rowsOf(y.scanId) === 0 && rowsOf(z.scanId) === 0 && d1.q("SELECT scanId FROM orphan_scans").map(r => r.scanId).join() === later.scanId &&
      d1.q("SELECT count(*) n FROM orphan_scan_keys WHERE scanId <> ?", later.scanId)[0].n === 0);
    // Nothing orphaned: nothing to delete from, so nothing is kept.
    const tidy = { IMAGES: bucket([obj("uploads/acme/set1.jpg"), obj("uploads/acme/set2.jpg"), obj("uploads/acme/today.jpg", fresh)]), R2_PUBLIC_BASE: BASE };
    ({ db, c } = counting(d1));
    const t = await fullScan(orphan, tidy, db, c, now);
    ok(`a scan that finds nothing orphaned keeps nothing of itself (and still fits: ${t.total} queries, the most a request ${Math.max(...t.steps)})`, t.orphans.length === 0 && t.scanned === 3 && t.recent === 1 && rowsOf(t.scanId) === 0 && t.total < 100 && Math.max(...t.steps) <= 25);
  }

  console.log("\n=== A database that won't give every table's columns at once ===");
  {
    ({ db, c } = counting(d1, { refuseJoin: true }));
    const f = await fullScan(orphan, env, db, c, now);
    ok(`the columns are read table by table as the scan reaches each — still no request over its share (the most: ${Math.max(...f.steps)})`, Math.max(...f.steps) <= 25 && c.sql.filter(q => /pragma_table_info\('/.test(q)).length > 70);
    ok("…with the same answer", f.orphans.some(o => o.key === "uploads/acme/notice-sent.png") && !f.orphans.some(o => o.key === "uploads/acme/gone.jpg") && !f.orphans.some(o => o.key === "uploads/acme/line-art.png"));
  }

  console.log("\n=== The admin actions ===");
  r = await call({ action: "findOrphanImages" }, env);
  ok("findOrphanImages answers with one step: a scanId, how far it is, not done yet", r.status === 200 && /^[0-9a-f]{24}$/.test(r.body.scanId) && r.body.done === false && r.body.phase === "tables" && r.body.table > 0 && r.body.tables > 70 && Array.isArray(r.body.orphans));
  let guard = 0;
  while (!r.body.done && guard++ < 50) r = await call({ action: "findOrphanImages", scanId: r.body.scanId }, env);
  ok("…and asked again with the scanId, carries on to the end", r.status === 200 && r.body.done === true && r.body.scanned === env.IMAGES._store.size);
  const src = read("functions/_lib/orphanImages.js");
  ok("the source: no head() per file, no per-column statement, the history tables listed beside the scan", !/\.head\(/.test(src) && /const HISTORY_TABLES = \{[^}]*audit_log[^}]*vendor_api_log[^}]*stripe_events[^}]*owner_notices[^}]*orphan_scan_keys/.test(src));
  const migration = read("migrations/0106_orphan_scan_transfer_item_index.sql");
  ok("migration 0106 and schema.sql both make the scratch tables", /CREATE TABLE IF NOT EXISTS orphan_scans/.test(migration) && /CREATE TABLE IF NOT EXISTS orphan_scan_keys/.test(migration) &&
    /CREATE TABLE IF NOT EXISTS orphan_scans/.test(read("schema.sql")) && /CREATE TABLE IF NOT EXISTS orphan_scan_keys/.test(read("schema.sql")));

  console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.error(e); console.log("test280 crashed: false"); process.exit(1); });
