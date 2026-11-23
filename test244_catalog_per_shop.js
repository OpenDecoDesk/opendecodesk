const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { shopOrigin, ADMIN_ORIGIN } = require("./testlib/hosts.js");

// The storefront catalog is cached in parts (functions/_lib/catalogCache.js): a small META entry (getCatalogData — the
// shop addresses and the settings, what host classification and the feature switches read) and one entry PER SHOP
// (getCatalogShop), built from that shop alone when it's first asked for. So a shop page reads only its own shop, the
// work doesn't grow with the number of shops, and the many callers that only classify the host never build a shop.
// Everything here runs the REAL db.js, catalogCache.js and catalog.js on a real SQLite database; only the Cache API is
// a stand-in.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const L = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/db.js")) + "\n" +
  strip(read("functions/_lib/catalogCache.js")) + "\n" + strip(read("functions/api/catalog.js")) + `\nreturn { createProduct, createTransfer, createGraphic, setTierPrices,
  publishShop, bumpCatalogVersion, getPublicCatalogData, getPublicCatalogMeta, getPublicCatalogShop, getCatalogData, getCatalogShop,
  invalidateCatalogVersionCache, _resetCatalogCacheState, _catalogShopsInMemory, classifyHost, catalogGet: onRequestGet };`)();
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

// A stand-in for the Cache API (caches.default), counting its reads.
const cacheApi = { matches: 0 };
function freshCacheApi() {
  const store = new Map();
  cacheApi.matches = 0;
  global.caches = { default: {
    async match(key) { cacheApi.matches++; const hit = store.get(typeof key === "string" ? key : key.url); return hit ? hit.clone() : undefined; },
    async put(key, response) { store.set(typeof key === "string" ? key : key.url, response); },
  } };
  L._resetCatalogCacheState();
  return store;
}

// The database as the cache sees it, logging every query: its SQL, what was bound and the rows it returned. `down`
// fails every query but the cache's version read, as a D1 outage for the catalog's reads would.
function spying(d1) {
  const s = { log: [], down: false };
  const wrap = (st, e) => ({
    _sql: st._sql, _params: st._params,
    bind: (...args) => { e.args = args; return wrap(st.bind(...args), e); },
    first: async (col) => { if (s.down && !/cacheNs/.test(e.sql)) throw new Error("D1 down"); const r = await st.first(col); e.rows = r == null ? [] : [r]; return r; },
    all: async () => { if (s.down && !/cacheNs/.test(e.sql)) throw new Error("D1 down"); const r = await st.all(); e.rows = r.results || []; return r; },
    run: async () => { if (s.down && !/cacheNs/.test(e.sql)) throw new Error("D1 down"); return st.run(); },
  });
  s.db = { prepare: (sql) => { const e = { sql, args: [], rows: [] }; s.log.push(e); return wrap(d1.prepare(sql), e); }, batch: (list) => d1.batch(list) };
  s.since = (n) => s.log.slice(n);
  // The catalog's own queries: all but the cache's version read.
  s.catalogQueries = (from = 0) => s.since(from).filter(e => !/cacheNs/.test(e.sql));
  return s;
}

const freshDb = async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  return d1;
};
// The names only shop n's own data holds: the shop's, and its products', graphics' and designs'.
const marks = (n) => ["Shop ", "Tee ", "Raglan ", "Cap ", "Hidden ", "Crest ", "Logo "].map(w => w + n + '"');
// Did any query return a row with shop n's own data in it? (A snapshot's json is a string inside the row, so its
// quotes come out escaped; they're unescaped before looking.)
const touched = (entries, n) => { const text = JSON.stringify(entries.map(e => e.rows)).replace(/\\"/g, '"'); return marks(n).some(m => text.includes(m)); };

// One shop with a bit of everything the catalog shows (as test219_catalog_build.js).
async function addShop(d1, n) {
  const orgId = "s" + n;
  d1._raw.exec(`INSERT OR IGNORE INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('${orgId}','${orgId}','Shop ${n}','t','t',1);`);
  const t = await L.createTransfer(d1, { name: "Sheet " + n });
  const g = await L.createGraphic(d1, orgId, { name: "Crest " + n, kind: "transfer", transferId: t, tier: "medium", inkColors: ["White"] });
  await L.setTierPrices(d1, orgId, { small: 1, medium: 2 + n, large: 5 });
  await L.createProduct(d1, orgId, { productId: "tee", type: "shirt", name: "Tee " + n, pricingMode: "sized", sizePricing: { M: 20, L: 22 }, visible: true, noDesignNeeded: true, reorderQr: "none" });
  await L.createProduct(d1, orgId, { productId: "rag", type: "shirt", name: "Raglan " + n, pricingMode: "flat", flatPrice: 18, visible: true, noDesignNeeded: true,
    configurable: true, garmentColors: ["Navy", "Grey"], reorderQr: "none", locations: [{ key: "front", label: "Front", graphicIds: [g, 1] }] });
  await L.createProduct(d1, orgId, { productId: "cap", type: "cap", name: "Cap " + n, pricingMode: "flat", flatPrice: 15, visible: true, reorderQr: "none" });
  await L.createProduct(d1, orgId, { productId: "hidden", type: "cap", name: "Hidden " + n, pricingMode: "flat", flatPrice: 15, visible: false, reorderQr: "none" });
  d1._raw.exec(`
    UPDATE products SET garmentColorsJson='["Navy","Grey"]', fixedTransfersJson='[{"locationId":1,"graphicId":${g},"ink":"White"}]', sortOrder=2 WHERE orgId='${orgId}' AND productId='tee';
    UPDATE products SET mockupGraphicsJson='[{"locationId":2,"graphicId":1}]', sortOrder=1 WHERE orgId='${orgId}' AND productId='cap';
    INSERT INTO designs (orgId, name, createdAt, updatedAt) VALUES ('${orgId}', 'Logo ${n}', 't', 't');
    INSERT INTO product_designs (orgId, productId, designId, placement, sortOrder, createdAt) VALUES ('${orgId}', 'cap', last_insert_rowid(), 'Front', 0, 't');
    INSERT INTO product_blank_links (orgId, productId, productColor, productSize, blankId, blankColor, blankSize) VALUES
      ('${orgId}', 'tee', 'Navy', 'M', 1, 'Navy', 'M'), ('${orgId}', 'tee', 'Navy', 'L', 1, 'Navy', 'L'), ('${orgId}', 'rag', 'Navy', 'L', 2, 'Navy', 'L');
    INSERT INTO product_graphic_images (orgId, productId, locationId, graphicId, garmentColor, imageUrl, createdAt, updatedAt) VALUES
      ('${orgId}', 'rag', 1, ${g}, 'Navy', '/img/rag-${n}.png', 't', 't'), ('${orgId}', 'cap', 2, 1, '', '/img/cap-${n}.png', 't', 't');`);
}
// An install with `shops` shops (s0, s1, …), the ones in `publish` published.
async function build(shops, publish) {
  const d1 = await freshDb();
  d1._raw.exec(`DELETE FROM locations; INSERT INTO locations (id, name, createdAt, updatedAt) VALUES (1, 'Front', 't', 't'), (2, 'Left chest', 't', 't');
    INSERT INTO blanks (id, name, createdAt, updatedAt) VALUES (1, 'Plain Tee', 't', 't'), (2, 'Plain Raglan', 't', 't');
    INSERT INTO blank_colors (blankId, color, imagesJson, createdAt, updatedAt) VALUES (1, 'Navy', '["/img/tee-navy.png"]', 't', 't'), (1, 'Grey', '["/img/tee-grey.png"]', 't', 't'),
      (2, 'Navy', '[{"url":"/img/rag-navy.png","locationId":1}]', 't', 't'), (2, 'Grey', '["/img/rag-grey.png"]', 't', 't');
    INSERT INTO blank_sizes (blankId, color, size, quantity, weightOz) VALUES (1, 'Navy', 'M', 0, 5), (1, 'Navy', 'L', 0, 6), (2, 'Navy', 'L', 0, 7);`);
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('s0','s0','Shop 0','t','t',1);`);
  const t = await L.createTransfer(d1, { name: "Global sheet" });
  await L.createGraphic(d1, "s0", { name: "Shared mark", kind: "transfer", transferId: t, tier: "small", isGlobal: true });
  d1._raw.exec(`UPDATE graphics SET isGlobal=1, orgId='s0' WHERE id=1`);
  for (let i = 0; i < shops; i++) await addShop(d1, i);
  for (const i of publish) await L.publishShop(d1, "s" + i);
  return d1;
}
// A snapshot as published before migrations/0101: every product in the one value, no parts.
function toOldSnapshot(d1, orgId) {
  const head = JSON.parse(d1.q("SELECT json FROM catalog_snapshots WHERE orgId=?", orgId)[0].json);
  const products = d1.q("SELECT json FROM catalog_snapshot_parts WHERE orgId=? ORDER BY part", orgId).flatMap(r => JSON.parse(r.json));
  d1.q("UPDATE catalog_snapshots SET json=? WHERE orgId=?", JSON.stringify({ org: head.org, products }), orgId);
  d1.q("DELETE FROM catalog_snapshot_parts WHERE orgId=?", orgId);
}
const shopPage = async (env, origin) => {
  const res = await L.catalogGet({ request: { url: origin + "/api/catalog" }, env });
  return { status: res.status, body: JSON.parse(await res.text()) };
};
const strictJson = (o) => JSON.stringify(o);

(async () => {
  // s0, s2 and s3 published (s3 the old way, products in one value); s1 never published, so served live.
  const d1 = await build(4, [0, 2, 3]);
  toOldSnapshot(d1, "s3");
  // Draft edits after Publish stay out of what shoppers see — the address included; a never-published shop is live.
  d1._raw.exec(`UPDATE orgs SET subdomain='renamed0' WHERE orgId='s0'; UPDATE orgs SET subdomain='renamed1' WHERE orgId='s1';
    UPDATE products SET name='Draft name' WHERE orgId='s2' AND productId='tee';`);
  const whole = await L.getPublicCatalogData(d1);

  console.log("=== The meta entry: the shop addresses and the settings, and no shop's products ===");
  {
    freshCacheApi();
    const s = spying(d1), env = { DB: s.db };
    const meta = await L.getCatalogData(env);
    const { orgs, ...rest } = whole;
    ok("the same as the whole-install build, without the shops", strictJson(meta) === strictJson(rest) && !("orgs" in meta));
    ok("…each shop at its PUBLISHED address (the snapshot's), a never-published one at its live address",
      meta.subdomainMap.s0 === "s0" && !("renamed0" in meta.subdomainMap) && meta.subdomainMap.renamed1 === "s1" && meta.subdomainMap.s2 === "s2" && meta.subdomainMap.s3 === "s3");
    ok("…no query returned any shop's own data — not even the old-style snapshot that still holds its products",
      [0, 1, 2, 3].every(n => !touched(s.log, n)));
    ok("…and nothing read the products, the snapshot parts or a snapshot's whole value",
      !s.log.some(e => /FROM products\b|catalog_snapshot_parts|SELECT \* FROM catalog_snapshots|SELECT json\b/.test(e.sql)));
    const n = s.log.length;
    const host = L.classifyHost(new URL(shopOrigin("s2")).hostname, (await L.getCatalogData(env)).subdomainMap, {});
    ok("host classification (what most API calls do) is answered from memory and builds no shop", host.kind === "locked" && host.orgId === "s2" && s.log.length === n);
    const admin = await shopPage(env, ADMIN_ORIGIN);
    ok("…and the admin host's catalog answer reads no shop either", admin.body.status === "admin" && s.catalogQueries(n).length === 0);
  }

  console.log("\n=== Each shop's entry is the shop the whole-install build makes ===");
  {
    freshCacheApi();
    const s = spying(d1), env = { DB: s.db };
    for (const id of ["s0", "s1", "s2", "s3"]) {
      const one = await L.getCatalogShop(env, id);
      ok(`${id}: the same JSON as getPublicCatalogData gives for it`, strictJson(one) === strictJson(whole.orgs[id]));
    }
    ok("…the published shop keeps its published product name; the never-published one is live",
      whole.orgs.s2.products.find(p => p.productId === "tee").name === "Tee 2" && whole.orgs.s1.subdomain === "renamed1");
    L._resetCatalogCacheState();   // another isolate: read back from the Cache API
    const again = await L.getCatalogShop(env, "s3");
    ok("…and the same again when read back from the Cache API", strictJson(again) === strictJson(whole.orgs.s3));
    ok("getPublicCatalogShop: an unknown shop is null", (await L.getPublicCatalogShop(d1, "nope")) === null && (await L.getPublicCatalogShop(d1, "")) === null);
  }

  console.log("\n=== A shop page builds only its own shop ===");
  {
    freshCacheApi();
    const s = spying(d1), env = { DB: s.db };
    const page = await shopPage(env, shopOrigin("s2"));
    ok("the shop page is answered", page.status === 200 && page.body.status === "ok" && page.body.orgId === "s2" && page.body.catalog.products.length === 3);
    ok("…its own data was read", touched(s.log, 2));
    ok("…and no other shop's (no row of theirs came back)", [0, 1, 3].every(n => !touched(s.log, n)));
    ok("…and no query named another shop", s.log.every(e => (e.args || []).every(a => typeof a !== "string" || !/^s\d$/.test(a) || a === "s2")));
    const n = s.log.length;
    const again = await shopPage(env, shopOrigin("s2"));
    ok("the next request in the isolate builds nothing (only the fresh stock reads)", again.body.orgId === "s2" &&
      !s.since(n).some(e => /catalog_snapshots|SELECT \* FROM (orgs|products)\b|json_extract/.test(e.sql)) && !touched(s.since(n), 2));
    const k = s.log.length;
    const closed = await shopPage(env, shopOrigin("nope"));
    ok("an address that isn't a shop is refused without building anything", closed.status === 404 && s.catalogQueries(k).length === 0);
  }

  console.log("\n=== The work for one shop doesn't grow with the number of shops ===");
  {
    const count = async (shops, publish) => {
      const db = await build(shops, publish);
      freshCacheApi();
      const s = spying(db), env = { DB: s.db };
      await L.getCatalogData(env);   // the meta entry: the same few queries for any number of shops
      const n = s.log.length;
      const page = await shopPage(env, shopOrigin("s1"));
      return { queries: s.since(n).length, metaQueries: n, page, others: [0, ...Array.from({ length: shops - 2 }, (_, i) => i + 2)].some(k => touched(s.since(n), k)) };
    };
    const few = await count(2, [0]), many = await count(8, [0, 2, 3, 4]);
    ok("a shop page on 2 shops and on 8 shops takes the same number of queries", few.queries === many.queries && few.page.body.orgId === "s1" && many.page.body.orgId === "s1");
    ok("…and so does the meta entry", few.metaQueries === many.metaQueries);
    ok("…and with 8 shops, no other shop's rows came back", !many.others && !few.others);
  }

  console.log("\n=== Publish: the meta entry and every shop's miss; until then they're served from memory ===");
  {
    freshCacheApi();
    const s = spying(d1), env = { DB: s.db };
    const meta1 = await L.getCatalogData(env), shop1 = await L.getCatalogShop(env, "s0");
    const n = s.log.length;
    const meta2 = await L.getCatalogData(env), shop2 = await L.getCatalogShop(env, "s0");
    ok("asked again: the same objects, no query, no Cache API read", meta2 === meta1 && shop2 === shop1 && s.catalogQueries(n).length === 0);
    d1._raw.exec(`UPDATE products SET name='Tee 0 new' WHERE orgId='s0' AND productId='tee'`);
    await L.publishShop(d1, "s0");
    await L.bumpCatalogVersion(d1); L.invalidateCatalogVersionCache();
    const m = s.log.length;
    const meta3 = await L.getCatalogData(env), shop3 = await L.getCatalogShop(env, "s0");
    const q = s.catalogQueries(m);
    ok("after Publish both are built afresh", meta3 !== meta1 && shop3 !== shop1 && q.some(e => /json_extract/.test(e.sql)) && q.some(e => /catalog_snapshots WHERE orgId/.test(e.sql) && e.args[0] === "s0"));
    ok("…and the shop shows what was published", shop3.products.find(p => p.productId === "tee").name === "Tee 0 new" && shop1.products.find(p => p.productId === "tee").name === "Tee 0");
  }

  console.log("\n=== D1 down: each entry's last-known-good copy ===");
  {
    freshCacheApi();
    const s = spying(d1), env = { DB: s.db };
    const meta = await L.getCatalogData(env), shop = await L.getCatalogShop(env, "s1");
    await L.bumpCatalogVersion(d1); L.invalidateCatalogVersionCache();   // new keys: nothing cached under them yet
    s.down = true;
    const metaFb = await L.getCatalogData(env), shopFb = await L.getCatalogShop(env, "s1");
    ok("the meta entry falls back to its last good copy", strictJson(metaFb) === strictJson(meta));
    ok("…and a shop built before to its own", strictJson(shopFb) === strictJson(shop) && shopFb.orgId === "s1");
    let threw = false;
    try { await L.getCatalogShop(env, "s2"); } catch (e) { threw = true; }
    ok("a shop never built here has nothing to fall back to: it throws", threw);
    const page = await shopPage(env, shopOrigin("s2"));
    ok("…and its page says the catalog is unavailable for now (503)", page.status === 503 && page.body.status === "error");
    const served = await shopPage(env, shopOrigin("renamed1"));
    ok("…while the shop that was built is still served", served.status === 200 && served.body.orgId === "s1");
    s.down = false;
    const next = await L.getCatalogShop(env, "s1");
    ok("the fallback isn't kept: the next request builds from D1 again", next !== shopFb && strictJson(next) === strictJson(shop));
  }

  console.log("\n=== An unknown shop: null, and cheap to ask again ===");
  {
    freshCacheApi();
    const s = spying(d1), env = { DB: s.db };
    ok("null for a shop that doesn't exist (and for no shop at all)", (await L.getCatalogShop(env, "nope")) === null && (await L.getCatalogShop(env, "")) === null);
    const n = s.log.length;
    ok("…asked again, nothing is read", (await L.getCatalogShop(env, "nope")) === null && s.log.length === n);
    L._resetCatalogCacheState();
    const m = s.log.length;
    ok("…and another isolate takes the answer from the Cache API, not D1", (await L.getCatalogShop(env, "nope")) === null && s.catalogQueries(m).length === 0);
  }

  console.log("\n=== Memory keeps a bounded number of shops, the most recently used ===");
  {
    freshCacheApi();
    const s = spying(d1), env = { DB: s.db };
    const ids = ["s0", "s1", "s2", "s3", ...Array.from({ length: 21 }, (_, i) => "x" + i)];
    for (const id of ids) await L.getCatalogShop(env, id);
    ok(`after ${ids.length} shops, 20 are kept in memory`, L._catalogShopsInMemory() === 20);
    let m = cacheApi.matches, q = s.catalogQueries().length;
    await L.getCatalogShop(env, ids[ids.length - 1]);
    ok("…the last one asked for is answered from memory", cacheApi.matches === m && s.catalogQueries().length === q);
    m = cacheApi.matches;
    const first = await L.getCatalogShop(env, "s0");
    ok("…the first one was dropped: read back from the Cache API, not rebuilt", cacheApi.matches === m + 1 && s.catalogQueries().length === q && first.orgId === "s0");
    ok("…and the count stays at 20", L._catalogShopsInMemory() === 20);
    L._resetCatalogCacheState();
    ok("the test reset forgets them all", L._catalogShopsInMemory() === 0);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
})().catch(e => { console.error(e); console.log("test crashed:", false); process.exit(1); });
