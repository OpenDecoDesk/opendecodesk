const fs = require("fs");
const { storefrontPage } = require("./testlib/storefront-page");
const { createD1 } = require("./testlib/d1-shim.js");
const { JSDOM, ResourceLoader } = require("jsdom");

// Versioned list cache (2026-11, migrations/0102). The admin's reference lists — blanks, threads, hoops,
// locations, machines and shops — are kept on the server (isolate memory + Cache API) and in the page, each under
// a version number in list_cache_versions that triggers raise on every change to a table behind the list.
//   - a read that sends the version it holds (cacheVersion) gets only "unchanged" while it is current
//   - any change (an action, stock used up, a raw SQL write) moves the version; the next read gets the new list
//   - after a change, the new list is stored straight away (write-through), so another isolate finds it ready
//   - costs are still taken out per request for a role without costs.view; stockOnly and listOrgs keep their shape
//   - the full getBlanks still works out reservations and low stock every time
//   - the page keeps its copies, sends their versions, takes lists from changes' answers, shares one request
//     between callers, hands out copies, and forgets everything when the session ends
// Real SQL (sql.js) + real db.js, permissions.js, orders.js and admin.js (jsdom). Invented data only.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + "\nreturn { createBlank };")();
const loadApi = () => new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  strip(read("functions/_lib/permissions.js")) + "\n" +
  "let __user = null, __can = () => true; const requireAdmin = async () => null; const adminActor = () => 'owner@test';\n" +
  "const adminUser = () => __user; const adminCan = (req, fn, lvl) => __can(fn, lvl);\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {} });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) +
  "\nreturn { post: onRequestPost, setUser: (u, can) => { __user = u; __can = can || (() => true); }, resetMemory: _resetListCacheMemory };")();
let failed = 0;
const ok = (label, cond) => { if (!cond) failed++; console.log(label + ": " + !!cond); };
const wait = async (fn, n = 400) => { for (let i = 0; i < n && !fn(); i++) await new Promise(x => setTimeout(x, 10)); return fn(); };

// The Cache API, as test28 stands it in.
const store = new Map();
global.caches = { default: {
  async match(key) { const hit = store.get(typeof key === "string" ? key : key.url); return hit ? hit.clone() : undefined; },
  async put(key, response) { store.set(typeof key === "string" ? key : key.url, response); },
} };

async function migratedDb(upTo = "9999") {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006" && f < upTo).sort()) d1.execFile(read("migrations/" + f));
  return d1;
}
// Counts the SQL run against `d1` whose text matches a pattern.
function countQueries(d1) {
  const seen = [];
  const prepare = d1.prepare.bind(d1);
  d1.prepare = (sql) => { seen.push(sql); return prepare(sql); };
  return (re) => seen.filter(s => re.test(s)).length;
}

(async () => {
  const d1 = await migratedDb();
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Example Club','t','t');`);
  await lib.createBlank(d1, { name: "Plain cap", brand: "Generic", color: "Navy", productType: "cap" }, [{ size: "OSFA", quantity: 7, purchasePrice: 3.5 }]);
  let api = loadApi();
  const pending = [];
  const call = async (body, a = api) => {
    const full = Object.assign({ key: "x" }, body);
    const request = { url: "https://admin.example.com/api/orders", json: async () => full, clone: () => ({ json: async () => full }), headers: { get: () => null } };
    const res = await a.post({ env: { DB: d1 }, waitUntil: (p) => pending.push(Promise.resolve(p)), request });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const settle = async () => { await Promise.all(pending.splice(0)); };
  const version = (name) => d1.q("SELECT version FROM list_cache_versions WHERE name = ?", name)[0].version;

  console.log("=== The version table ===");
  ok("one row per list, plus the database's own Cache API namespace", ["blanks", "threads", "hoops", "locations", "machines", "orgs", "_ns"].every(n => d1.q("SELECT 1 FROM list_cache_versions WHERE name = ?", n).length === 1));
  ok("schema.sql (fresh installs) has the same table and the same 42 triggers", await (async () => {
    const f = await createD1(); f._raw.exec(read("schema.sql"));
    return f.q("SELECT count(*) n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'lcv_%'")[0].n === 42 && f.q("SELECT count(*) n FROM list_cache_versions")[0].n === 7;
  })());

  console.log("\n=== Each list: a version, then 'unchanged' while it is current ===");
  const lists = [["listHoops", "hoops"], ["listThreads", "threads"], ["listLocations", "locations"], ["listMachines", "machines"], ["listOrgs", "orgs"], ["listOrgsAdmin", "orgs"], ["getBlanks", "blanks"]];
  for (const [action, key] of lists) {
    const first = await call({ action });
    const again = await call({ action, cacheVersion: first.body.version });
    ok(action + ": the list and its version, then only 'unchanged' for that version", first.status === 200 && Array.isArray(first.body[key]) && typeof first.body.version === "number" &&
      again.status === 200 && again.body.unchanged === true && again.body.version === first.body.version && !(key in again.body));
  }
  const stock = await call({ action: "getBlanks", stockOnly: true });
  ok("getBlanks stockOnly keeps its shape: each blank's id and its sizes' stock", JSON.stringify(Object.keys(stock.body.blanks[0])) === '["id","sizes"]' && stock.body.blanks[0].sizes[0].quantity === 7);
  ok("…and is 'unchanged' too when its version is current", (await call({ action: "getBlanks", stockOnly: true, cacheVersion: stock.body.version })).body.unchanged === true);
  const orgsShort = await call({ action: "listOrgs" });
  ok("listOrgs keeps its short shape (orgId, name, subdomain); listOrgsAdmin has the whole shop", JSON.stringify(Object.keys(orgsShort.body.orgs[0])) === '["orgId","name","subdomain"]' &&
    "deliveryOptions" in (await call({ action: "listOrgsAdmin" })).body.orgs[0]);
  const fullUnchanged = await call({ action: "getBlanks", cacheVersion: version("blanks") });
  ok("the full getBlanks still works out reservations, price checks, product uses and low stock when the list is unchanged",
    fullUnchanged.body.unchanged === true && ["reserved", "needsPriceCheck", "products", "lowStock"].every(k => k in fullUnchanged.body) && !("blanks" in fullUnchanged.body));
  ok("a wrong or old version gets the list", Array.isArray((await call({ action: "listHoops", cacheVersion: -5 })).body.hoops));

  console.log("\n=== Changes move the version ===");
  const moved = async (name, fn) => { const v = version(name); await fn(); await settle(); return version(name) > v; };
  ok("saving a hoop moves hoops", await moved("hoops", () => call({ action: "saveHoop", hoop: { name: "4in Round", widthMm: 100, heightMm: 100 } })));
  ok("saving a thread moves threads", await moved("threads", () => call({ action: "saveThread", thread: { brand: "Example", type: "Poly", weight: "40", code: "1001", name: "Red", colorHex: "cc2222" } })));
  ok("saving a location moves locations", await moved("locations", () => call({ action: "saveLocation", location: { name: "Left chest" } })));
  ok("saving a machine moves machines", await moved("machines", () => call({ action: "saveMachine", machine: { name: "Machine 1", needleCount: 12 } })));
  const machineId = d1.q("SELECT id FROM machines")[0].id, hoopId = d1.q("SELECT id FROM hoops")[0].id;
  ok("putting a hoop on a machine (Run Order) moves machines", await moved("machines", () => call({ action: "setMachineHoop", machineId, hoopId })));
  ok("stock used up outside any list action (raw SQL, as the Manufactured step does) moves blanks", await moved("blanks", async () => d1.q("UPDATE blank_sizes SET quantity = quantity - 1")));
  ok("a new shop written straight to the table moves orgs", await moved("orgs", async () => d1.q("INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('rec','rec','Rec League','t','t')")));
  ok("…and a change to one list leaves the others alone", await (async () => { const h = version("hoops"); d1.q("UPDATE threads SET name = 'Crimson'"); return version("hoops") === h; })());
  const hoopsNow = await call({ action: "listHoops", cacheVersion: 1 });
  ok("the next read with the old version gets the new list and version", hoopsNow.body.hoops.length === 1 && hoopsNow.body.hoops[0].name === "4in Round" && hoopsNow.body.version === version("hoops"));
  const blanksNow = await call({ action: "getBlanks", stockOnly: true, cacheVersion: stock.body.version });
  ok("…blank stock after it was used up shows 6, not the cached 7", blanksNow.body.blanks[0].sizes[0].quantity === 6);

  console.log("\n=== Write-through ===");
  store.clear();
  await call({ action: "saveHoop", hoop: { name: "Cap frame", widthMm: 130, heightMm: 60, isCapFrame: true } });
  await settle();
  const hv = version("hoops");
  ok("after a change the new hoops list is already in the Cache API under its new version", [...store.keys()].some(k => k.endsWith("/hoops/v" + hv)));
  ok("…and only the lists that changed were stored", ![...store.keys()].some(k => /\/(blanks|threads|machines|locations|orgs)\//.test(k)));
  const api2 = loadApi();   // another isolate: nothing in its memory
  const counted = countQueries(d1);
  const fromOther = await call({ action: "listHoops" }, api2);
  ok("another isolate answers from the Cache API without reading the hoops table", fromOther.body.hoops.length === 2 && fromOther.body.version === hv && counted(/FROM hoops/) === 0);
  const readOnly = pending.length;
  await call({ action: "listMachines" });
  ok("a read action schedules no refresh", pending.length === readOnly);
  const disc = await call({ action: "recordMachineDiscovery", discovered: [] });
  ok("a change's answer that carries a list says its version (cacheVersions)", Array.isArray(disc.body.machines) && disc.body.cacheVersions && disc.body.cacheVersions.machines === version("machines"));
  await settle();

  console.log("\n=== Costs are still per person ===");
  api.setUser({ role: "production", roleInfo: {} }, () => false);
  const noCost = await call({ action: "getBlanks" });
  ok("a role without costs.view or Blanks gets cached blanks without costs", noCost.body.blanks[0].sizes.every(z => !("purchasePrice" in z) && !("vendorPrice" in z)));
  api.setUser(null);
  ok("…and the cached copy itself still has them for those who may see them", (await call({ action: "getBlanks" })).body.blanks[0].sizes[0].purchasePrice === 3.5);

  console.log("\n=== A database not yet migrated ===");
  const old = await migratedDb("0102");
  const oldRes = await api.post({ env: { DB: old }, waitUntil: () => {}, request: { url: "https://admin.example.com/api/orders", json: async () => ({ key: "x", action: "listHoops", cacheVersion: 3 }), headers: { get: () => null } } });
  const oldBody = JSON.parse(await oldRes.text());
  ok("without the version table the list comes straight from D1, with no version, as before", oldRes.status === 200 && Array.isArray(oldBody.hoops) && !("version" in oldBody) && !oldBody.unchanged);

  console.log("\n=== The page's copies ===");
  const adminJs = read("public/admin.js");
  const sent = [];
  class L extends ResourceLoader { fetch(url, o) { if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const dom = new JSDOM(storefrontPage(), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win) { win.fetch = async (u, init) => {
      if (!String(u).includes("/api/orders")) return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
      const b = init && typeof init.body === "string" ? JSON.parse(init.body) : {}; sent.push(b); const x = await call(b); await settle();
      return { ok: x.status < 400, status: x.status, json: async () => x.body, text: async () => JSON.stringify(x.body) }; }; } });
  const w = dom.window, d = w.document;
  w.CSS = { escape: (x) => String(x).replace(/[^a-zA-Z0-9_-]/g, "\\$&") };
  await new Promise(x => setTimeout(x, 150));
  await w.loadAdminScript();
  w.eval('adminKey = "cookie"; adminOrgs = [{ orgId: "acme", name: "Example Club" }];');

  sent.length = 0;
  const h1 = await w.hoopApi_({ action: "listHoops" });
  const h2 = await w.hoopApi_({ action: "listHoops" });
  ok("the first ask sends no version; the second sends the version it got", !("cacheVersion" in sent[0]) && sent[1].cacheVersion === h1.version);
  ok("…the second answer is the copy, in the usual shape (no 'unchanged')", h2.hoops.length === 2 && h2.hoops[0].name === h1.hoops[0].name && !("unchanged" in h2));
  h2.hoops.length = 0; h2.hoops.push({ name: "changed by a screen" });
  ok("changing a list a screen got doesn't change the copy", (await w.hoopApi_({ action: "listHoops" })).hoops.length === 2);
  sent.length = 0;
  const [a1, a2] = await Promise.all([w.hoopApi_({ action: "listThreads" }), w.threadApi_({ action: "listThreads" })]);
  ok("two screens asking at once share one request, and each gets its own copy", sent.filter(b => b.action === "listThreads").length === 1 && a1.threads.length === 1 && a2.threads.length === 1 && a1.threads !== a2.threads);
  await w.machineApi_({ action: "recordMachineDiscovery", discovered: [] });
  sent.length = 0;
  const m1 = await w.machineApi_({ action: "listMachines" });
  ok("a change's answer that carries a list becomes the copy (the next read is 'unchanged')", sent[0].cacheVersion === version("machines") && m1.machines.length === 1 && m1.machines[0].name === "Machine 1");
  sent.length = 0;
  await w.hoopApi_({ action: "saveHoop", hoop: { name: "Oval", widthMm: 90, heightMm: 120 } });
  const h3 = await w.hoopApi_({ action: "listHoops" });
  ok("after a hoop is saved, the next read gets the new list", h3.hoops.length === 3 && typeof h3.version === "number" && h3.version === version("hoops"));
  // A screen opening while a save goes on (Manage… → New): its read started BEFORE the save must not answer the
  // read made AFTER the save (found by test162: the new location was missing from the picker).
  sent.length = 0;
  const early = w.hoopApi_({ action: "listHoops" });
  await w.hoopApi_({ action: "saveHoop", hoop: { name: "Square", widthMm: 150, heightMm: 150 } });
  const after = await w.hoopApi_({ action: "listHoops" });
  await early;
  ok("a read made after a save doesn't share a read that started before it", after.hoops.some(h => h.name === "Square") && sent.filter(b => b.action === "listHoops").length === 2);

  console.log("\n=== A screen that asks with its own request (the Orders list's blank stock) ===");
  const app = d.getElementById("app");
  sent.length = 0;
  await w.renderAdminOrders(app, { orgId: "acme", name: "Example Club" });
  await wait(() => d.getElementById("ordSummaryBar") || d.querySelector("#adminPanel .admin-empty"));
  await w.renderAdminOrders(app, { orgId: "acme", name: "Example Club" });
  await wait(() => sent.filter(b => b.action === "getBlanks").length === 2);
  const stockAsks = sent.filter(b => b.action === "getBlanks");
  ok("the Orders list asks for stock only, then sends the version of the stock it holds", stockAsks.length === 2 && stockAsks.every(b => b.stockOnly === true) && !("cacheVersion" in stockAsks[0]) && stockAsks[1].cacheVersion === version("blanks"));

  console.log("\n=== Session ends ===");
  w.eval("clearAdminAuth()");
  w.eval('adminKey = "cookie";');
  sent.length = 0;
  await w.hoopApi_({ action: "listHoops" });
  ok("signing out (or a session ending) forgets every copy: the next ask sends no version", sent.length === 1 && !("cacheVersion" in sent[0]));

  dom.window.close();
  if (failed) console.log("\nFAILED:", failed);
})().catch(e => { console.log("crashed: false"); console.error(e); process.exit(1); });
