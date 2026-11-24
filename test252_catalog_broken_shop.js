const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { shopOrigin } = require("./testlib/hosts.js");

// A shop whose published copy can't be read fails alone (review #6, 14e446a; coverage report 59.7). The storefront
// catalog is cached per shop (functions/_lib/catalogCache.js): the meta entry (shop addresses and settings) and one
// entry per shop. When one shop's published snapshot is broken (a part missing, or a part that isn't JSON), only that
// shop's page answers "Catalog temporarily unavailable" (503); every other shop's page, the meta entry and host
// classification go on as before. A shop already built in this colo keeps being served from its last-known-good
// copy when a later build of it fails. Real db.js, catalogCache.js and catalog.js on sql.js; the Cache API is a
// stand-in. Invented shops only.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const L = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/db.js")) + "\n" +
  strip(read("functions/_lib/catalogCache.js")) + "\n" + strip(read("functions/api/catalog.js")) + `\nreturn { createProduct, publishShop, bumpCatalogVersion,
  getCatalogData, getCatalogShop, invalidateCatalogVersionCache, _resetCatalogCacheState, classifyHost, catalogGet: onRequestGet };`)();
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

function freshCacheApi() {
  const store = new Map();
  global.caches = { default: {
    async match(key) { const hit = store.get(typeof key === "string" ? key : key.url); return hit ? hit.clone() : undefined; },
    async put(key, response) { store.set(typeof key === "string" ? key : key.url, response); },
  } };
  L._resetCatalogCacheState();
  return store;
}
const page = async (env, sub) => {
  const res = await L.catalogGet({ request: { url: shopOrigin(sub) + "/api/catalog" }, env });
  return { status: res.status, body: JSON.parse(await res.text()) };
};
const names = (p) => ((p.body.catalog && p.body.catalog.products) || []).map(x => x.name).sort().join(",");
const builds = async (env, id) => { try { await L.getCatalogShop(env, id); return null; } catch (e) { return e; } };

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  for (const [id, name] of [["maple", "Maple Club"], ["birch", "Birch League"], ["cedar", "Cedar Band"]]) {
    d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('${id}','${id}','${name}','t','t',1);`);
    await L.createProduct(d1, id, { productId: "tee", type: "shirt", name: name + " tee", pricingMode: "flat", flatPrice: 20, visible: true, noDesignNeeded: true, reorderQr: "none" });
    await L.createProduct(d1, id, { productId: "cap", type: "cap", name: name + " cap", pricingMode: "flat", flatPrice: 15, visible: true, noDesignNeeded: true, reorderQr: "none" });
    await L.publishShop(d1, id);
  }
  const env = { DB: d1 };
  const parts = (id) => d1.q("SELECT part, json FROM catalog_snapshot_parts WHERE orgId=? ORDER BY part", id);
  ok("(each shop is published with its products in parts)", ["maple", "birch", "cedar"].every(id => parts(id).length >= 1));

  console.log("=== One shop's snapshot is missing its parts ===");
  freshCacheApi();
  const savedBirch = parts("birch");
  d1.q("DELETE FROM catalog_snapshot_parts WHERE orgId='birch'");
  let birch = await page(env, "birch");
  ok("that shop's page says the catalog is unavailable for now (503), with nothing of the shop in it",
    birch.status === 503 && birch.body.status === "error" && /temporarily unavailable/.test(birch.body.message) && !birch.body.catalog && !/Birch/.test(JSON.stringify(birch.body)));
  const maple = await page(env, "maple"), cedar = await page(env, "cedar");
  ok("…the other shops' pages answer as usual, each with its own products", maple.status === 200 && maple.body.status === "ok" && names(maple) === "Maple Club cap,Maple Club tee" &&
    cedar.status === 200 && names(cedar) === "Cedar Band cap,Cedar Band tee");
  const meta = await L.getCatalogData(env);
  ok("…the meta entry still has every shop's address, the broken one's included (its head is readable)",
    meta.status === "ok" && meta.subdomainMap.maple === "maple" && meta.subdomainMap.birch === "birch" && meta.subdomainMap.cedar === "cedar");
  const host = L.classifyHost(new URL(shopOrigin("birch")).hostname, meta.subdomainMap, {});
  ok("…so the broken shop's address is still that shop (not an unknown host, not another shop)", host.kind === "locked" && host.orgId === "birch");
  let threw = await builds(env, "birch");
  ok("…getCatalogShop throws for it, saying its published catalog is incomplete — never null (\"no such shop\") or its draft",
    !!threw && /published catalog of birch is incomplete/.test(threw.message));
  ok("…and the failure isn't cached: the next request builds again (and fails again while it's broken)", !!(await builds(env, "birch")));

  console.log("\n=== A part that isn't a list of products ===");
  freshCacheApi();
  for (const r of savedBirch) d1.q("INSERT INTO catalog_snapshot_parts (orgId, part, json) VALUES ('birch', ?, ?)", r.part, r.json);
  // (The column only takes valid JSON — migrations/0101's CHECK — so the broken part is JSON that isn't a list.)
  d1.q("UPDATE catalog_snapshot_parts SET json='{\"productId\":\"tee\"}' WHERE orgId='cedar' AND part=0");
  const cedarBad = await page(env, "cedar");
  birch = await page(env, "birch");
  ok("a shop with an unreadable part: its page is the 503", cedarBad.status === 503 && /temporarily unavailable/.test(cedarBad.body.message));
  ok("…the shop put right again answers with its products, and the third shop is untouched",
    birch.status === 200 && names(birch) === "Birch League cap,Birch League tee" && (await page(env, "maple")).status === 200);
  threw = await builds(env, "cedar");
  ok("…its error says it can't be read — publish the shop again", !!threw && /published catalog of cedar can't be read/.test(threw.message));

  console.log("\n=== Broken after a Publish: the last good copy is served ===");
  // Built and cached while good; then a new catalog version (every key misses) with the shop's parts gone.
  freshCacheApi();
  await L.publishShop(d1, "cedar");
  const before = await page(env, "cedar");
  ok("(cedar republished: its page answers)", before.status === 200 && names(before) === "Cedar Band cap,Cedar Band tee");
  await L.bumpCatalogVersion(d1);
  L.invalidateCatalogVersionCache();
  d1.q("DELETE FROM catalog_snapshot_parts WHERE orgId='cedar'");
  const after = await page(env, "cedar");
  ok("a shop built here before keeps its last-known-good copy when its new build fails", after.status === 200 && names(after) === names(before));
  const mapleNow = await page(env, "maple");
  ok("…and the others are built fresh for the new version", mapleNow.status === 200 && names(mapleNow) === "Maple Club cap,Maple Club tee");

  console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch((e) => { console.error(e); console.log("test252 crashed: false"); process.exit(1); });
