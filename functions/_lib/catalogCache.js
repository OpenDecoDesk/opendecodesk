/**
 * Shared catalog-data cache. The storefront catalog lives in D1 and is cached
 * at the edge, so a new org or a price change made through the admin panel
 * goes live without a code push or redeploy.
 *
 * ---- TWO KINDS OF ENTRY ----
 * The catalog is cached in parts, so a request pays only for what it reads:
 *  - getCatalogData(env) answers the META entry: the shop addresses
 *    (subdomainMap, each shop's PUBLISHED subdomain), the global settings
 *    (with sales tax and the rush fee), the business shown to visitors, the
 *    region, the features and the sections. Small, and no shop's products in
 *    it — what host classification and the feature switches need, which is
 *    what nearly every API call reads.
 *  - getCatalogShop(env, orgId) answers ONE shop's entry, built from that
 *    shop's rows alone when it's first asked for: its name, settings and
 *    visible products, exactly as the whole-install build
 *    (getPublicCatalogData) gives it. Only the storefront's catalog request
 *    (functions/api/catalog.js) asks for one. null = no such shop, cached like
 *    a shop so asking again costs nothing.
 * So a rebuild costs one shop's work, not every shop's, and parsing the meta
 * entry never touches anyone's products.
 *
 * ---- HOW INVALIDATION WORKS ----
 * Every key embeds the current catalog version, read from D1
 * (global_settings.catalogVersion, e.g. .../catalog-data/<ns>/v7/meta and
 * .../catalog-data/<ns>/v7/shop/<orgId>). Clicking "Publish" in the admin
 * panel bumps that version, so every request after that computes NEW keys —
 * the meta entry and every shop's — and the old entries just become
 * unreachable rather than needing an explicit purge. Changes to the live
 * tables don't bump it: an entry is kept CACHE_TTL_SECONDS (5 minutes) at most.
 *
 * ---- NAMESPACE ----
 * Two environments on the same Cloudflare zone share the Cache API, so keys
 * also carry a random per-database id (global_settings.cacheNs, created on
 * first use). Each environment has its own D1, hence its own namespace.
 *
 * ---- RESILIENCE ----
 * Each entry (the meta one and each shop's) also keeps a last-known-good copy
 * for this colo (Cache API, .../<ns>/last-known-good/meta and
 * .../last-known-good/shop/<orgId>). On a D1 read failure that copy is served.
 * Only throws if there is nothing to fall back to yet — for a shop, if this
 * shop was never built here.
 *
 * ---- IN MEMORY ----
 * The entries this isolate last read are also kept parsed in memory, under the
 * same versioned keys, for the same CACHE_TTL_SECONDS counted from when each
 * was built: the meta entry, and the SHOP_MEMORY_MAX shops most recently asked
 * for (the one asked for longest ago is dropped first). A request in a warm
 * isolate then needs no Cache API read and no JSON parse — and on a
 * workers.dev address, where the Cache API keeps nothing, no rebuild from D1.
 * (A rebuild in progress isn't shared with other requests: Workers can't
 * safely await one request's I/O from another.) The objects are shared by
 * every request the isolate serves, so callers only read them, never change
 * them.
 */

import { getPublicCatalogMeta, getPublicCatalogShop, getCatalogCacheState } from "./db.js";

const CACHE_TTL_SECONDS = 300;
const CACHE_BASE = "https://catalog-cache.internal/catalog-data/";
// How many shops one isolate keeps parsed in memory at once.
const SHOP_MEMORY_MAX = 20;

// Module-level memory cache for {version, ns}. The version only changes when
// an admin clicks Publish, so holding it for 30 seconds keeps this to about
// one D1 read per isolate per half-minute. A 30s stale window is fine — the
// Cache API's own 5-minute TTL is the actual freshness bound after a Publish.
let _state = { v: null, ns: null, at: 0 };
const MEM_STATE_TTL_MS = 30_000;

async function getCacheState_(env){
  if(!env.DB) return { version: "0", ns: "no-db" };
  const now = Date.now();
  if(_state.v !== null && now - _state.at < MEM_STATE_TTL_MS){
    return { version: _state.v, ns: _state.ns };
  }
  try{
    const { version, ns } = await getCatalogCacheState(env.DB);
    _state = { v: version, ns, at: now };
    return { version, ns };
  }catch{
    if(_state.v !== null) return { version: _state.v, ns: _state.ns };
    // D1 unavailable and nothing remembered: a one-off random namespace, so this request can
    // never read another environment's cache (it just misses and goes to D1). Not memoized.
    return { version: "0", ns: "db-unavailable-" + crypto.randomUUID() };
  }
}

// Called by the publish action so the new version is visible immediately
// within this Worker instance without waiting for the TTL.
export function invalidateCatalogVersionCache(){
  _state = { v: null, ns: _state.ns, at: 0 };
}

// Parsed entries this isolate read, by cache key: { data, builtAt (ms) }. A Map keeps
// insertion order, so the first key is the one used longest ago; reading an entry moves it
// to the end. Past `max` entries the oldest is dropped.
function memorySlots_(max){
  const map = new Map();
  return {
    get(key){
      const hit = map.get(key);
      if(!hit) return null;
      if(Date.now() - hit.builtAt >= CACHE_TTL_SECONDS * 1000){ map.delete(key); return null; }
      map.delete(key); map.set(key, hit);
      return hit;
    },
    set(key, data, builtAt){
      map.delete(key); map.set(key, { data, builtAt });
      while(map.size > max) map.delete(map.keys().next().value);
    },
    clear(){ map.clear(); },
    get size(){ return map.size; },
  };
}
const _meta = memorySlots_(1);
const _shops = memorySlots_(SHOP_MEMORY_MAX);
const BUILT_AT_HEADER = "X-Catalog-Built-At";
function remember_(mem, key, data, builtAt){
  if(builtAt > 0 && Date.now() - builtAt < CACHE_TTL_SECONDS * 1000) mem.set(key, data, builtAt);
}

// Test hook: forgets the version and every entry kept in memory.
export function _resetCatalogCacheState(){ _state = { v: null, ns: null, at: 0 }; _meta.clear(); _shops.clear(); }
// Test hook: how many shops this isolate keeps in memory now.
export function _catalogShopsInMemory(){ return _shops.size; }

function versionedCacheKey(ns, version, part){
  return CACHE_BASE + ns + "/v" + encodeURIComponent(version) + "/" + part;
}
function staleFallbackKey(ns, part){
  return CACHE_BASE + ns + "/last-known-good/" + part;
}
const shopPart_ = (orgId) => "shop/" + encodeURIComponent(orgId);

async function fetchMetaFromD1_(env){
  if(!env.DB){
    throw new Error("Server misconfigured — D1 binding (DB) not set.");
  }
  const data = await getPublicCatalogMeta(env.DB);
  if(!data || !data.subdomainMap){
    throw new Error("D1 catalog query: response missing subdomainMap");
  }
  return data;
}
async function fetchShopFromD1_(env, orgId){
  if(!env.DB){
    throw new Error("Server misconfigured — D1 binding (DB) not set.");
  }
  // null (no such shop) is an answer, cached like a shop.
  const data = await getPublicCatalogShop(env.DB, orgId);
  if(data !== null && (typeof data !== "object" || !Array.isArray(data.products))){
    throw new Error("D1 catalog query: shop " + orgId + " came back without its products");
  }
  return data;
}

// The meta entry: the shop addresses and the settings, no shop's products (see the top of this file).
// `waitUntil` (optional, the request's context.waitUntil): a fresh build is stored in the Cache API after the
// answer instead of before it.
export async function getCatalogData(env, { waitUntil } = {}){
  const { version, ns } = await getCacheState_(env);
  return layered_(versionedCacheKey(ns, version, "meta"), staleFallbackKey(ns, "meta"), _meta, () => fetchMetaFromD1_(env), waitUntil);
}

// One shop's entry, as published: the same object the whole-install build gives for it. null = no such shop.
export async function getCatalogShop(env, orgId, { waitUntil } = {}){
  if(orgId == null || orgId === "") return null;
  const id = String(orgId);
  const { version, ns } = await getCacheState_(env);
  return layered_(versionedCacheKey(ns, version, shopPart_(id)), staleFallbackKey(ns, shopPart_(id)), _shops, () => fetchShopFromD1_(env, id), waitUntil);
}

// One entry through the layers: this isolate's memory, then the Cache API, then a build from D1 —
// stored in the Cache API under its versioned key and as its last-known-good copy, and kept in
// memory. If the build fails, the last-known-good copy is served (or the error thrown when
// there is none). The two copies are stored at once; with `waitUntil` the request doesn't wait for
// them (a copy that fails to store only costs another isolate a rebuild).
async function layered_(key, staleKey, mem, build, waitUntil){
  const hit = mem.get(key);
  if(hit) return hit.data;

  const cache = caches.default;
  const cached = await cache.match(key);
  if(cached){
    const data = await cached.json();
    // An entry stored without the built-at header isn't kept in memory (its age is unknown).
    remember_(mem, key, data, Number(cached.headers.get(BUILT_AT_HEADER)) || 0);
    return data;
  }
  try{
    const data = await build();
    const builtAt = Date.now();
    const response = new Response(JSON.stringify(data), {
      headers: { "Content-Type": "application/json", "Cache-Control": "max-age=" + CACHE_TTL_SECONDS, [BUILT_AT_HEADER]: String(builtAt) }
    });
    const puts = [cache.put(key, response.clone()), cache.put(staleKey, response.clone())];
    if(typeof waitUntil === "function") waitUntil(Promise.all(puts).catch(() => {}));
    else await Promise.all(puts);
    remember_(mem, key, data, builtAt);
    return data;
  }catch(err){
    // (The fallback copy isn't kept in memory: the next request tries D1 again.)
    const stale = await cache.match(staleKey);
    if(stale){
      return await stale.json();
    }
    throw err;
  }
}
