const fs = require("fs");
const { makePlatformDb, platformGlobals, brokenDb } = require("./testlib/platform-db");
Object.assign(global, platformGlobals());

// Loads the REAL functions/_lib/catalogCache.js (every other test file mocks
// getCatalogData() entirely — this is the one place its actual
// implementation, including the fallback, is exercised).
// The catalog version and per-environment cache namespace live in D1
// (global_settings), exercised here against a real SQLite database. The
// meta entry's query itself (getPublicCatalogMeta) is stripped and replaced
// with a global mock so the test can control what D1 "returns". (Each shop's
// entry, getCatalogShop, is checked on a real database in
// test244_catalog_per_shop.js.)
let src = fs.readFileSync(__dirname + "/functions/_lib/catalogCache.js", "utf8")
  .replace(/import \{[\s\S]*?\} from ["'][^"']+["'];\n?/g, "")
  .replace(/export async function/g, "async function")
  .replace(/export function/g, "function");
eval(src);

function makeCachesMock(){
  const store = new Map();
  global.caches = {
    default: {
      async match(key){
        const k = typeof key === "string" ? key : key.url;
        const hit = store.get(k);
        return hit ? hit.clone() : undefined;
      },
      async put(key, response){
        const k = typeof key === "string" ? key : key.url;
        store.set(k, response);
      }
    }
  };
  return store;
}

(async () => {
  console.log("=== Happy path: fetches from D1 and caches in the Cache API ===");
  {
    const store = makeCachesMock(); _resetCatalogCacheState();
    const DB = await makePlatformDb();
    global.getPublicCatalogMeta = async () => ({subdomainMap:{x:"org-x"}});
    const data = await getCatalogData({ DB });
    console.log("Returns the fetched data:", data.subdomainMap.x === "org-x");
    console.log("Stored a versioned entry and a last-known-good entry:", store.size === 2);
    console.log("A cache namespace was created in D1 on first use:", /^[0-9a-f]{16}$/.test(DB.q("SELECT value FROM global_settings WHERE key='cacheNs'")[0].value));
  }

  console.log("\n=== Cache API hit: a cached versioned response is served without calling D1 again ===");
  {
    makeCachesMock(); _resetCatalogCacheState();
    const DB = await makePlatformDb();
    let d1Calls = 0;
    global.getPublicCatalogMeta = async () => { d1Calls++; return {subdomainMap:{x:"org-x"}}; };
    const env = { DB };
    await getCatalogData(env);
    await getCatalogData(env);
    console.log("D1 queried only once (second call served from Cache API):", d1Calls === 1);
  }

  console.log("\n=== Publishing a new version computes a fresh cache key (old entry becomes unreachable) ===");
  {
    makeCachesMock(); _resetCatalogCacheState();
    const DB = await makePlatformDb();
    let d1Calls = 0;
    global.getPublicCatalogMeta = async () => { d1Calls++; return {subdomainMap:{x:"org-x-v"+d1Calls}}; };
    const env = { DB };
    const first = await getCatalogData(env);
    const v = await bumpCatalogVersion(DB); // what the real publish action does
    invalidateCatalogVersionCache();
    const second = await getCatalogData(env);
    console.log("First fetch got v1 data:", first.subdomainMap.x === "org-x-v1");
    console.log("Publish bumps the version in D1 (1):", v === 1);
    console.log("Version bump triggers a real second D1 query, not a stale hit:", second.subdomainMap.x === "org-x-v2");
    console.log("D1 called twice (once per version):", d1Calls === 2);
    console.log("A second Publish counts up (2), atomically:", (await bumpCatalogVersion(DB)) === 2);
  }

  console.log("\n=== The version is held in memory for 30 s (one state read per isolate, not per request) ===");
  {
    makeCachesMock(); _resetCatalogCacheState();
    const DB = await makePlatformDb();
    global.getPublicCatalogMeta = async () => ({subdomainMap:{x:"org-x"}});
    let stateReads = 0;
    const counting = { prepare: (sql) => { if(/cacheNs/.test(sql) && /SELECT/.test(sql)) stateReads++; return DB.prepare(sql); } };
    const env = { DB: counting };
    await getCatalogData(env); await getCatalogData(env); await getCatalogData(env);
    console.log("Three requests -> one state lookup (plus none after creation):", stateReads <= 2);
  }

  console.log("\n=== D1 down, but the Cache API stale-fallback entry is still there ===");
  {
    makeCachesMock(); _resetCatalogCacheState();
    const DB = await makePlatformDb();
    let succeed = true;
    global.getPublicCatalogMeta = async () => {
      if(succeed) return {subdomainMap:{x:"org-x"}};
      throw new Error("D1 down");
    };
    const env = { DB };
    await getCatalogData(env); // seeds the Cache API
    await bumpCatalogVersion(DB); // force a cache miss on the next call
    invalidateCatalogVersionCache();
    succeed = false;
    const data = await getCatalogData(env);
    console.log("Served from the Cache API stale-fallback despite D1 being down:", data.subdomainMap.x === "org-x");
  }

  console.log("\n=== D1 down AND no Cache API entry -> nothing to fall back to, throws ===");
  {
    makeCachesMock(); _resetCatalogCacheState();
    const DB = await makePlatformDb();
    global.getPublicCatalogMeta = async () => { throw new Error("D1 unreachable"); };
    let threw = false;
    try{ await getCatalogData({ DB }); }catch(e){ threw = true; }
    console.log("Throws when there's truly nothing to fall back to:", threw);
  }

  console.log("\n=== State table unreadable (broken DB) but the catalog query works: request still succeeds ===");
  {
    makeCachesMock(); _resetCatalogCacheState();
    global.getPublicCatalogMeta = async () => ({subdomainMap:{x:"org-x"}});
    const data = await getCatalogData({ DB: brokenDb("D1 down") });
    console.log("Still served (uses a one-off namespace, never another env's cache):", data.subdomainMap.x === "org-x");
  }

  console.log("\n=== Missing DB binding -> throws immediately (misconfigured server) ===");
  {
    makeCachesMock(); _resetCatalogCacheState();
    global.getPublicCatalogMeta = async () => ({subdomainMap:{}});
    let threw = false;
    try{ await getCatalogData({}); }catch(e){ threw = true; }
    console.log("Throws with missing DB binding:", threw);
  }

  console.log("\n=== Cache keys are namespaced per environment (two environments can share one zone's Cache API) ===");
  {
    const store = makeCachesMock();
    const prodDb = await makePlatformDb(), stageDb = await makePlatformDb();
    await setSettingRaw(prodDb, "catalogVersion", "7"); await setSettingRaw(stageDb, "catalogVersion", "7"); // SAME version number
    _resetCatalogCacheState();
    global.getPublicCatalogMeta = async () => ({ subdomainMap: { prod: "org-prod" } });
    await getCatalogData({ DB: prodDb });
    _resetCatalogCacheState();
    global.getPublicCatalogMeta = async () => ({ subdomainMap: { teststaging: "org-stage" } });
    const stageData = await getCatalogData({ DB: stageDb });
    console.log("A second environment with the same version number gets ITS OWN catalog, not the first's:", !!stageData.subdomainMap.teststaging && !stageData.subdomainMap.prod);
    const prodNs = prodDb.q("SELECT value FROM global_settings WHERE key='cacheNs'")[0].value;
    const stageNs = stageDb.q("SELECT value FROM global_settings WHERE key='cacheNs'")[0].value;
    console.log("Each environment stored its own namespace id:", !!prodNs && !!stageNs && prodNs !== stageNs);
    const keys = [...store.keys()];
    console.log("No shared, un-namespaced keys left in the cache:", keys.every(k => k.includes(prodNs) || k.includes(stageNs)));
    // D1 outage in the second environment: its fallback must be its own last-good, never the first's.
    _resetCatalogCacheState();
    global.getPublicCatalogMeta = async () => { throw new Error("D1 down"); };
    await setSettingRaw(stageDb, "catalogVersion", "8"); // force a cache miss
    const fb = await getCatalogData({ DB: stageDb });
    console.log("An outage there falls back to its own last-good copy:", !!fb.subdomainMap.teststaging && !fb.subdomainMap.prod);
    _resetCatalogCacheState();
  }

  console.log("\n=== The parsed catalog is kept in memory for the Cache API's 5 minutes, from when it was built ===");
  {
    const store = makeCachesMock(); _resetCatalogCacheState();
    const DB = await makePlatformDb();
    let d1Calls = 0, matches = 0;
    const match = global.caches.default.match;
    global.caches.default.match = async (k) => { matches++; return match(k); };
    global.getPublicCatalogMeta = async () => { d1Calls++; return { subdomainMap: { x: "org-x-" + d1Calls } }; };
    const env = { DB };
    const first = await getCatalogData(env);
    const m0 = matches;
    const second = await getCatalogData(env), third = await getCatalogData(env);
    console.log("Later requests in the isolate get the same parsed catalog, with no Cache API read or rebuild:", second === first && third === first && matches === m0 && d1Calls === 1);
    console.log("The stored copy says when it was built:", Number([...store.values()][0].headers.get("X-Catalog-Built-At")) > 0);
    // 5 minutes after it was built, memory no longer answers (the Cache API copy has expired by then too).
    const realNow = Date.now;
    Date.now = () => realNow() + 301 * 1000;
    store.clear();
    const later = await getCatalogData(env);
    Date.now = realNow;
    console.log("…not past 5 minutes, then it is rebuilt:", later.subdomainMap.x === "org-x-2" && d1Calls === 2);
    // A Publish (new version) never gets the old catalog from memory.
    await bumpCatalogVersion(DB); invalidateCatalogVersionCache();
    const published = await getCatalogData(env);
    console.log("A Publish's new version is read afresh, not taken from memory:", published.subdomainMap.x === "org-x-3" && d1Calls === 3);
    // A new isolate reading the Cache API copy keeps it in memory too (it has the built-at time).
    _resetCatalogCacheState(); matches = 0;
    const fromCache = await getCatalogData(env), again = await getCatalogData(env);
    console.log("A copy read from the Cache API is kept in memory after one read:", fromCache.subdomainMap.x === "org-x-3" && again === fromCache && matches === 1 && d1Calls === 3);
    global.caches.default.match = match;
  }

  console.log("\n=== A Cache API copy without a built-at time (stored before this) isn't kept in memory ===");
  {
    const store = makeCachesMock(); _resetCatalogCacheState();
    const DB = await makePlatformDb();
    global.getPublicCatalogMeta = async () => ({ subdomainMap: { x: "org-x" } });
    await getCatalogData({ DB });
    for (const [k, r] of [...store.entries()]) store.set(k, new Response(await r.clone().text(), { headers: { "Content-Type": "application/json" } }));
    _resetCatalogCacheState();
    let matches = 0; const match = global.caches.default.match;
    global.caches.default.match = async (k) => { matches++; return match(k); };
    const a = await getCatalogData({ DB }), b = await getCatalogData({ DB });
    console.log("Each request reads it from the Cache API (its age is unknown):", a.subdomainMap.x === "org-x" && b.subdomainMap.x === "org-x" && matches === 2);
    global.caches.default.match = match;
  }

  console.log("\n=== The last-known-good fallback isn't kept in memory: the next request tries D1 again ===");
  {
    makeCachesMock(); _resetCatalogCacheState();
    const DB = await makePlatformDb();
    let up = true, calls = 0;
    global.getPublicCatalogMeta = async () => { calls++; if(!up) throw new Error("D1 down"); return { subdomainMap: { x: "org-x-" + calls } }; };
    const env = { DB };
    await getCatalogData(env);
    await bumpCatalogVersion(DB); invalidateCatalogVersionCache();
    up = false;
    const fb = await getCatalogData(env);
    up = true;
    const next = await getCatalogData(env);
    console.log("The outage gets the fallback, and the next request the rebuilt catalog:", fb.subdomainMap.x === "org-x-1" && next.subdomainMap.x === "org-x-3");
    _resetCatalogCacheState();
  }

  // A fresh build is stored twice in the Cache API (its versioned key and its last-known-good copy). Both are
  // stored at once; with the request's waitUntil the answer doesn't wait for them (code review #102).
  console.log("\n=== Storing a fresh build: both copies at once, and after the answer with waitUntil ===");
  {
    const store = makeCachesMock(); _resetCatalogCacheState();
    const realPut = global.caches.default.put;
    let inFlight = 0, most = 0, release = null, gate = new Promise(r => { release = r; }), failPut = false;
    global.caches.default.put = async (key, response) => {
      inFlight++; most = Math.max(most, inFlight);
      await gate; inFlight--;
      if (failPut) throw new Error("cache full");
      return realPut(key, response);
    };
    const DB = await makePlatformDb();
    global.getPublicCatalogMeta = async () => ({ subdomainMap: { x: "org-x" } });
    global.getPublicCatalogShop = async (db, id) => ({ orgId: id, products: [] });
    // Without waitUntil the call waits for both copies — stored side by side, not one after the other.
    let done = false;
    const p = getCatalogData({ DB }).then(d => { done = true; return d; });
    for (let i = 0; i < 20 && most < 2; i++) await new Promise(r => setTimeout(r, 5));
    console.log("without waitUntil: both copies are stored at once:", most === 2 && !done);
    release(); await p;
    console.log("…and the answer comes once they are:", done && store.size === 2);
    // With waitUntil: the answer is back while the copies are still being stored.
    _resetCatalogCacheState(); store.clear(); most = 0;
    gate = new Promise(r => { release = r; });
    await bumpCatalogVersion(DB); invalidateCatalogVersionCache();
    const waits = [];
    const meta = await getCatalogData({ DB }, { waitUntil: (pr) => waits.push(pr) });
    console.log("with waitUntil: the answer doesn't wait for the Cache API:", meta.subdomainMap.x === "org-x" && store.size === 0 && waits.length === 1 && most === 2);
    release(); await Promise.all(waits);
    console.log("…both copies are stored after it, through waitUntil:", store.size === 2);
    const shop = await getCatalogShop({ DB }, "acme", { waitUntil: (pr) => waits.push(pr) });
    console.log("a shop's entry the same way:", shop && shop.orgId === "acme" && waits.length === 2);
    await Promise.all(waits);
    console.log("…stored after the answer:", store.size === 4);
    // A copy that can't be stored: with waitUntil the answer is still the fresh build, and nothing rejects.
    _resetCatalogCacheState(); store.clear(); failPut = true;
    await bumpCatalogVersion(DB); invalidateCatalogVersionCache();
    const w2 = [];
    const again = await getCatalogData({ DB }, { waitUntil: (pr) => w2.push(pr) });
    let rejected = false; await Promise.all(w2).catch(() => { rejected = true; });
    console.log("a copy that can't be stored doesn't fail the answer (waitUntil gets a promise that never rejects):", again.subdomainMap.x === "org-x" && !rejected);
    global.caches.default.put = realPut; failPut = false;
    _resetCatalogCacheState();
  }

  // The admin's versioned lists (db.js readCachedList_): a rebuilt list is stored after the answer with waitUntil.
  console.log("\n=== The admin's lists (readCachedList_): stored after the answer with waitUntil ===");
  {
    const { createD1 } = require("./testlib/d1-shim.js");
    const strip = (s) => s.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
    const lib = new Function(strip(fs.readFileSync(__dirname + "/functions/_lib/db.js", "utf8")) + "\nreturn { readCachedList_, _resetListCacheMemory };")();
    const d1 = await createD1();
    d1._raw.exec(fs.readFileSync(__dirname + "/testlib/schema-pre-0006.sql", "utf8"));
    for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(fs.readFileSync(__dirname + "/migrations/" + f, "utf8"));
    const store = makeCachesMock();
    const realPut = global.caches.default.put;
    let release, gate = new Promise(r => { release = r; });
    global.caches.default.put = async (k, r) => { await gate; return realPut(k, r); };
    const waits = [];
    const got = await lib.readCachedList_(d1, "threads", undefined, { waitUntil: (pr) => waits.push(pr) });
    console.log("the list comes back before it is stored:", got.version !== null && Array.isArray(got.data) && store.size === 0 && waits.length === 1);
    release(); await Promise.all(waits);
    console.log("…and is stored through waitUntil:", store.size === 1);
    lib._resetListCacheMemory(); store.clear();
    gate = new Promise(r => { release = r; });
    let done = false;
    const p = lib.readCachedList_(d1, "threads").then(() => { done = true; });
    await new Promise(r => setTimeout(r, 20));
    console.log("without waitUntil it waits for the store, as before:", !done);
    release(); await p;
    console.log("…then answers:", done && store.size === 1);
    global.caches.default.put = realPut;
  }

  console.log("\n=== The API handlers pass their waitUntil ===");
  {
    const src = (f) => fs.readFileSync(__dirname + "/functions/api/" + f, "utf8");
    const calls = (f, re) => (src(f).match(re) || []).length;
    const meta = /getCatalogData\(env, \{ waitUntil(: context\.waitUntil\?\.bind\(context\))? \}\)/g;
    const counts = { "catalog.js": 1, "checkout.js": 1, "shipping.js": 2, "orders.js": 1, "customer-design.js": 1, "admin-users.js": 1, "admin-password.js": 1, "admin-2fa.js": 1, "shippo-label.js": 1 };
    const missing = Object.entries(counts).filter(([f, n]) => calls(f, meta) !== n || calls(f, /await getCatalogData\(env\)/g) !== 0).map(([f]) => f);
    console.log("every request handler's catalog read passes it:", missing.length === 0);
    if (missing.length) console.log("  not passed in:", missing.join(" "));
    console.log("…and the storefront's shop read and the admin's lists too:", /getCatalogShop\(env, orgId, \{ waitUntil: context\.waitUntil\?\.bind\(context\) \}\)/.test(src("catalog.js")) &&
      /readCachedList_\(env\.DB, name, undefined, \{ waitUntil: context\.waitUntil\?\.bind\(context\) \}\)/.test(src("orders.js")));
  }
})();
