const fs = require("fs");
const { ok } = require("./testlib/check");
const { createD1 } = require("./testlib/d1-shim.js");
const { shopOrigin, ADMIN_ORIGIN, ROOT } = require("./testlib/hosts.js");
const roles = require("./testlib/roles");

// Decoration types (phase 5, migrations/0118), the Global settings side:
//   functions/_lib/db.js        getDecorationTypes / setDecorationTypes / getDecorationPricing / setDecorationPricing /
//                               buildDecorationSettings: what is refused and its sentence, what is stored, the fallbacks
//                               (nothing saved, rubbish saved, no table, no database), the catalog version going up
//   functions/api/orders.js     getDecorationSettings (who may read it, costs left out without costs.view),
//                               updateDecorationSettings (permission, every refusal, saved values, a role without
//                               costs.view keeping the stored costs, the audit rows, nothing saved when the database
//                               or the audit log fails), the decoration section of saveGlobalSettingsAll (saved with
//                               the others, all or nothing), priceDecoration (the answer and who may ask)
//   functions/api/catalog.js    the public catalog carrying decorationTypes: whole install, meta part, each shop's
//                               answer; the value changes without a Publish
//   functions/_lib/permissions.js, orders.js's lists  the permission wiring
// Real SQL (sql.js) under the real db.js, catalogCache.js, catalog.js and orders.js; the sign-in gate is the one
// test361 uses (built-in and made-up roles). Invented data only; nothing here depends on today's date.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
global.fetch = async (url) => { throw new Error("unexpected fetch " + url); };

const L = new Function(
  strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  strip(read("functions/_lib/permissions.js")) + "\n" +
  strip(read("functions/_lib/db.js")) + "\n" + strip(read("functions/_lib/email.js")) + "\n" + strip(read("functions/_lib/quoteToken.js")) + "\n" +
  strip(read("functions/_lib/boxSize.js")) + "\n" + strip(read("functions/_lib/catalogCache.js")) + "\n" +
  "const __as = { role: null };\n" +
  "const requireAdmin = async (env, host, key, request, msg, need) => __as.role && roleAllows(__as.role, need) ? null : new Response(JSON.stringify({ status: 'error', code: 'forbidden', message: 'Your role can\\'t do this. Ask an admin.' }), { status: 403 });\n" +
  "const adminActor = () => 'pat@example.com';\n" +
  "const adminUser = () => __as.role ? { id: 7, role: __as.role.key, roleInfo: __as.role } : null;\n" +
  "const adminCan = (request, fn, level) => !!__as.role && permRank(effectiveLevel(__as.role, fn)) >= permRank(level || 'read');\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyTurnstile = async () => ({ ok: true });\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  "const ordersApi = (function(){\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost; })();\n" +
  "const catalogApi = (function(){\n" + strip(read("functions/api/catalog.js")) + "\nreturn { onRequestGet }; })();\n" +
  "return { as: __as, ordersApi, catalogGet: catalogApi.onRequestGet, DEFAULT_ROLES, normalizePermissions, DECORATION_TYPES, DECORATION_KEYS,\n" +
  "  DEFAULT_DECORATIONS, getDecorationTypes, setDecorationTypes, getDecorationPricing, setDecorationPricing, buildDecorationSettings,\n" +
  "  writeSettingBuilds, getPublicCatalogData, getPublicCatalogMeta, createProduct, publishShop, bumpCatalogVersion, invalidateCatalogVersionCache,\n" +
  "  _resetCatalogCacheState };")();

let cacheStore = new Map();
function freshCacheApi() {
  cacheStore = new Map();
  global.caches = { default: {
    async match(key) { const hit = cacheStore.get(typeof key === "string" ? key : key.url); return hit ? hit.clone() : undefined; },
    async put(key, response) { cacheStore.set(typeof key === "string" ? key : key.url, response); },
  } };
  L._resetCatalogCacheState();
}
freshCacheApi();

async function freshDb() {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  return d1;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const say = (line) => console.log("\n" + line);
const role = (key, fns) => ({ key, name: key, rank: 10, locked: false, builtIn: false, permissions: L.normalizePermissions({ fns }) });
const ROLES = {
  admin: L.DEFAULT_ROLES.admin, manager: L.DEFAULT_ROLES.manager, staff: L.DEFAULT_ROLES.staff, production: L.DEFAULT_ROLES.production,
  nobody: role("nobody", {}),
  editNoCosts: role("editNoCosts", { "settings.global": "edit" }),
  editWithCosts: role("editWithCosts", { "settings.global": "edit", "costs.view": "read" }),
  readGlobal: role("readGlobal", { "settings.global": "read" }),
  catalogRead: role("catalogRead", { "catalog.products": "read" }),
  ordersRead: role("ordersRead", { "orders.details": "read" }),
  auditNoCosts: role("auditNoCosts", { "reports.audit": "read" }),
  auditCosts: role("auditCosts", { "reports.audit": "read", "costs.view": "read" }),
};
const ALL_TYPES = ["embroidery", "dtf", "screenprint", "vinyl", "dtg", "sublimation"];
const MSG_NONE = "Tick at least one decoration type";
const MSG_ROLE = "Your role can't do this. Ask an admin.";
const MSG_NOT_SAVED = "Nothing was saved: the database didn't take the change. Try again.";
const MSG_AUDIT = "Could not write the audit log, so nothing was changed. Try again.";

(async () => {
  const d1 = await freshDb();
  const env = { DB: d1 };
  const pending = [];
  const quiet = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };
  const post = async (body, as = "admin", useEnv = env) => {
    L.as.role = typeof as === "string" ? ROLES[as] : as;
    const full = Object.assign({ key: "x" }, body);
    const res = await L.ordersApi({ env: useEnv, waitUntil: (p) => pending.push(Promise.resolve(p).catch(() => {})),
      request: { url: ADMIN_ORIGIN + "/api/orders", method: "POST", json: async () => full, headers: { get: () => null } } });
    await Promise.all(pending.splice(0));
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const refused = (r, status, message) => r.status === status && r.body.status === "error" && r.body.message === message;
  const forbidden = (r) => r.status === 403 && r.body.status === "error" && (r.body.code === "forbidden" || /role can't/.test(r.body.message || ""));
  const rowOf = (k) => (d1.q("SELECT value FROM global_settings WHERE key = ?", k)[0] || {}).value;
  const stored = (k) => { const v = rowOf(k); return v === undefined ? undefined : JSON.parse(v); };
  const version = () => Number(rowOf("catalogVersion") || 0);
  const auditRows = (like) => d1.q("SELECT action, detail, actor FROM audit_log WHERE action LIKE ? ORDER BY id", like).map(r => Object.assign({}, r, { detail: r.detail ? JSON.parse(r.detail) : null }));
  const hasCost = (pricing) => Object.values(pricing).some(v => "costCents" in v);
  const wipe = () => { d1.q("DELETE FROM global_settings WHERE key IN ('decorationTypes','decorationPricing')"); d1.q("DELETE FROM audit_log"); };

  // =====================================================================================================
  say("=== The permission wiring (permissions.js and orders.js's lists) ===");
  const perm = (a) => roles.ACTION_PERM[a];
  ok("saving the types and prices needs Global settings at edit", same(perm("updateDecorationSettings"), [["settings.global", "edit"]]));
  ok("reading them is open to Global settings and every screen that offers a type (products, graphics, orders, quotes, Run order, transfers, blanks to order, machines)",
    same(perm("getDecorationSettings").map(p => p[0]).sort(),
      ["settings.global", "catalog.products", "catalog.graphics", "orders.details", "quotes.estimates", "run.queue", "transfer.queue", "inventory.transfers", "inventory.blankorder", "production.machines"].sort()) &&
    perm("getDecorationSettings").every(p => p[1] === "read"));
  ok("asking for a price needs a quote at read, an order at edit or a product at read",
    same(perm("priceDecoration"), [["quotes.estimates", "read"], ["orders.details", "edit"], ["catalog.products", "read"]]));
  ok("Global settings' Save needs Global settings at edit", same(perm("saveGlobalSettingsAll"), [["settings.global", "edit"]]));
  const ordersJs = read("functions/api/orders.js");
  ok("Global settings' Save knows the section 'decoration' under the name Decoration types, saved by updateDecorationSettings",
    /decoration: \{ action: "updateDecorationSettings", label: "Decoration types" \}/.test(ordersJs));
  const noMonth = [...ordersJs.match(/const NO_MONTH_ACTIONS = new Set\(\[([\s\S]*?)\]\);/)[1].matchAll(/"(\w+)"/g)].map(m => m[1]);
  ok("saving the types and asking for a price change no month's numbers (NO_MONTH_ACTIONS)", noMonth.includes("updateDecorationSettings") && noMonth.includes("priceDecoration"));
  ok("the audit of a price change counts as money, hidden from a role without costs.view (settings.decoration_prices_set)", ordersJs.includes("settings\\\\.decoration_prices_set"));
  ok("the three actions are in the handler's list of known actions", /"getDecorationSettings", "updateDecorationSettings", "priceDecoration"/.test(ordersJs));
  ok("Global settings has the section a role can read: Admin and Manager read it, Back office and Production don't (settings.global)",
    ["admin", "manager", "staff", "production"].map(r => roles.effectivePermissions(roles.DEFAULT_ROLES[r])["settings.global"]).join() === "full,read,none,none");

  // =====================================================================================================
  say("=== db.js: getDecorationTypes and getDecorationPricing, and what they fall back to ===");
  {
    const fresh = await freshDb();
    ok("an install that saved nothing does embroidery and DTF (the default)", same(await L.getDecorationTypes(fresh), ["embroidery", "dtf"]) && same(L.DEFAULT_DECORATIONS, ["embroidery", "dtf"]));
    const defaults = await L.getDecorationPricing(fresh);
    ok("…and has every type's prices at zero, with the same keys the registry has", same(Object.keys(defaults), ALL_TYPES) &&
      defaults.dtf.priceCents === 0 && defaults.screenprint.maxColors === 6 && defaults.embroidery.stitchPricing === false);
    ok("with no database at all both answer the defaults, without throwing", same(await L.getDecorationTypes(null), ["embroidery", "dtf"]) && same(await L.getDecorationPricing(undefined), defaults));
    ok("the registry has six types in this order: embroidery, dtf, screenprint, vinyl, dtg, sublimation", same(L.DECORATION_KEYS, ALL_TYPES) && L.DECORATION_TYPES.length === 6);
    fresh.q("INSERT INTO global_settings (key, value) VALUES ('decorationTypes', ?)", '["sublimation","embroidery","embroidery","nonsense"]');
    ok("saved types come back in registry order, once each, unknown keys dropped", same(await L.getDecorationTypes(fresh), ["embroidery", "sublimation"]));
    fresh.q("UPDATE global_settings SET value = ? WHERE key = 'decorationTypes'", '["nonsense"]');
    ok("a saved list with no known type is the default", same(await L.getDecorationTypes(fresh), ["embroidery", "dtf"]));
    fresh.q("UPDATE global_settings SET value = ? WHERE key = 'decorationTypes'", "{ not json");
    ok("a saved value that isn't JSON is the default", same(await L.getDecorationTypes(fresh), ["embroidery", "dtf"]));
    fresh.q("UPDATE global_settings SET value = ? WHERE key = 'decorationTypes'", '"dtg"');
    ok("a saved value that isn't a list is the default", same(await L.getDecorationTypes(fresh), ["embroidery", "dtf"]));
    fresh.q("INSERT INTO global_settings (key, value) VALUES ('decorationPricing', ?)", '{"dtf":{"priceCents":"250","costCents":-5,"setupCents":99.9},"screenprint":{"maxColors":99},"bogus":{"x":1}}');
    const p = await L.getDecorationPricing(fresh);
    ok("saved prices are whole cents: text numbers read as numbers, negatives 0, fractions of a cent dropped", p.dtf.priceCents === 250 && p.dtf.costCents === 0 && p.dtf.setupCents === 99);
    ok("…the most colours is held between 1 and 12, and unknown types are left out", p.screenprint.maxColors === 12 && !("bogus" in p));
    fresh.q("UPDATE global_settings SET value = ? WHERE key = 'decorationPricing'", "[1,2]");
    ok("saved prices that are a list are the defaults", same(await L.getDecorationPricing(fresh), defaults));
    fresh.q("UPDATE global_settings SET value = ? WHERE key = 'decorationPricing'", "oops");
    ok("saved prices that aren't JSON are the defaults", same(await L.getDecorationPricing(fresh), defaults));
    fresh._raw.exec("DROP TABLE global_settings");
    ok("a database with no settings table (before it was made) answers the defaults for both", same(await L.getDecorationTypes(fresh), ["embroidery", "dtf"]) && same(await L.getDecorationPricing(fresh), defaults));
  }

  // =====================================================================================================
  say("=== db.js: setDecorationTypes ===");
  {
    const t = await freshDb();
    const err = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
    for (const [what, arg] of [["an empty list", []], ["null", null], ["text", "dtf"], ["an object", { dtf: true }]]) {
      const e = await err(() => L.setDecorationTypes(t, arg));
      ok(`${what} is refused with "${MSG_NONE}", in words a person can be shown`, !!e && e.message === MSG_NONE && e.userFacing === true);
    }
    let e = await err(() => L.setDecorationTypes(t, ["dtf", "paint"]));
    ok("an unknown type is refused by name: Unknown decoration type: paint", !!e && e.message === "Unknown decoration type: paint" && e.userFacing === true);
    e = await err(() => L.setDecorationTypes(t, ["x".repeat(80)]));
    ok("…a long name is cut to 40 characters in the sentence", !!e && e.message === "Unknown decoration type: " + "x".repeat(40));
    e = await err(() => L.setDecorationTypes(t, ["Embroidery"]));
    ok("…keys are exact: capital letters aren't a type", !!e && e.message === "Unknown decoration type: Embroidery");
    e = await err(() => L.setDecorationTypes(t, ["dtf", 7]));
    ok("…a number in the list isn't a type either", !!e && e.message === "Unknown decoration type: 7");
    ok("none of those refusals saved anything or moved the catalog version", rowOf("decorationTypes") === undefined && rowOf("catalogVersion") === undefined);
    const v0 = version();
    const got = await L.setDecorationTypes(t, ["dtg", "embroidery", "dtg", "vinyl"]);
    ok("a good list comes back in registry order, once each: embroidery, vinyl, dtg", same(got, ["embroidery", "vinyl", "dtg"]));
    ok("…and that is what is stored and what is read back", same(JSON.parse((t.q("SELECT value FROM global_settings WHERE key='decorationTypes'")[0]).value), ["embroidery", "vinyl", "dtg"]) &&
      same(await L.getDecorationTypes(t), ["embroidery", "vinyl", "dtg"]));
    ok("…the catalog version went up by one, so a shop page already open sees it", Number((t.q("SELECT value FROM global_settings WHERE key='catalogVersion'")[0]).value) === 1 && v0 === 0);
    await L.setDecorationTypes(t, ["screenprint"]);
    ok("a second save replaces the list (one type is enough) and raises the version again",
      same(await L.getDecorationTypes(t), ["screenprint"]) && Number((t.q("SELECT value FROM global_settings WHERE key='catalogVersion'")[0]).value) === 2);
    ok("the prices were never touched by saving types", t.q("SELECT value FROM global_settings WHERE key='decorationPricing'").length === 0);
  }

  // =====================================================================================================
  say("=== db.js: setDecorationPricing ===");
  {
    const t = await freshDb();
    const err = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
    for (const [what, arg] of [["null", null], ["a list", [1]], ["text", "dtf"], ["a number", 4]]) {
      const e = await err(() => L.setDecorationPricing(t, arg));
      ok(`${what} is refused: The decoration prices aren't readable`, !!e && e.message === "The decoration prices aren't readable" && e.userFacing === true);
    }
    ok("…and nothing was saved", t.q("SELECT key FROM global_settings WHERE key IN ('decorationPricing','catalogVersion')").length === 0);
    const got = await L.setDecorationPricing(t, {
      embroidery: { stitchPricing: "1", centsPer1000: "125", minStitches: 3000.7, minCents: -4 },
      screenprint: { inkColorCents: 150, screenSetupCents: 2000, reorderSetupCents: 500, costCents: 20, maxColors: 0 },
      dtf: { priceCents: 100000001 * 2, costCents: 30, setupCents: "x" },
      mystery: { priceCents: 5 } });
    ok("embroidery: the tick reads from 1, text numbers become numbers, a fraction of a stitch rounds down, a negative is 0",
      got.embroidery.stitchPricing === true && got.embroidery.centsPer1000 === 125 && got.embroidery.minStitches === 3000 && got.embroidery.minCents === 0);
    ok("screen print: the figures are kept, and a most-colours of 0 falls back to 6", got.screenprint.inkColorCents === 150 && got.screenprint.screenSetupCents === 2000 &&
      got.screenprint.reorderSetupCents === 500 && got.screenprint.costCents === 20 && got.screenprint.maxColors === 6);
    ok("DTF: a figure past $1,000,000 is held at it, text that isn't a number is 0", got.dtf.priceCents === 100000000 && got.dtf.costCents === 30 && got.dtf.setupCents === 0);
    ok("a type left out has its defaults, an unknown type is dropped, and the keys are the registry's", got.vinyl.priceCents === 0 && !("mystery" in got) && same(Object.keys(got), ALL_TYPES));
    ok("the saved row is the normalized value, and it reads back the same", same(JSON.parse((t.q("SELECT value FROM global_settings WHERE key='decorationPricing'")[0]).value), got) && same(await L.getDecorationPricing(t), got));
    ok("saving prices raised the catalog version once", Number((t.q("SELECT value FROM global_settings WHERE key='catalogVersion'")[0]).value) === 1);
    ok("…and saved no types", t.q("SELECT 1 FROM global_settings WHERE key='decorationTypes'").length === 0);
    const again = await L.setDecorationPricing(t, { screenprint: { maxColors: 99 }, embroidery: "no" });
    ok("a most-colours past 12 is held at 12; a type given as text counts as left out (its defaults, not the old figures)", again.screenprint.maxColors === 12 && again.embroidery.stitchPricing === false && again.dtf.priceCents === 0);
  }

  // =====================================================================================================
  say("=== db.js: buildDecorationSettings (the build step: checks first, writes nothing) ===");
  {
    const t = await freshDb();
    let b = await L.buildDecorationSettings(t);
    ok("called with nothing: no statements, nothing to refresh, and the value is what is in force now", b.stmts.length === 0 && b.after.length === 0 &&
      same(b.value.types, ["embroidery", "dtf"]) && same(b.value.pricing, await L.getDecorationPricing(t)));
    b = await L.buildDecorationSettings(t, { types: ["dtg"] });
    ok("types alone: one statement, the new list in the value, the prices as they are", b.stmts.length === 1 && same(b.value.types, ["dtg"]) && same(b.value.pricing, await L.getDecorationPricing(t)));
    ok("…and one refresh statement that raises the catalog version", b.after.length === 1);
    ok("…and building wrote nothing (not the types, not the version)", t.q("SELECT key FROM global_settings WHERE key IN ('decorationTypes','decorationPricing','catalogVersion')").length === 0);
    b = await L.buildDecorationSettings(t, { pricing: { dtf: { priceCents: 700 } } });
    ok("prices alone: one statement, the prices normalized, the types as they are", b.stmts.length === 1 && b.value.pricing.dtf.priceCents === 700 && same(b.value.types, ["embroidery", "dtf"]));
    b = await L.buildDecorationSettings(t, { types: ["vinyl"], pricing: { vinyl: { priceCents: 450 } } });
    ok("both: two statements, written by the batch writer together", b.stmts.length === 2);
    await L.writeSettingBuilds(t, [b], { batch: true });
    ok("…after the writer ran they are stored and the version is 1", same(await L.getDecorationTypes(t), ["vinyl"]) && (await L.getDecorationPricing(t)).vinyl.priceCents === 450 && version_(t) === 1);
    b = await L.buildDecorationSettings(t, { types: ["dtf"] });
    ok("a build for one part keeps the other part's stored value", same(b.value.types, ["dtf"]) && b.value.pricing.vinyl.priceCents === 450);
    let e = null;
    try { await L.buildDecorationSettings(t, { types: [], pricing: { dtf: { priceCents: 1 } } }); } catch (x) { e = x; }
    ok("an empty type list is refused even when the prices are good", !!e && e.message === MSG_NONE && same(await L.getDecorationTypes(t), ["vinyl"]));
    e = null;
    try { await L.buildDecorationSettings(t, { types: ["dtf"], pricing: [] }); } catch (x) { e = x; }
    ok("unreadable prices are refused even when the types are good", !!e && e.message === "The decoration prices aren't readable" && same(await L.getDecorationTypes(t), ["vinyl"]));
  }
  function version_(db) { const r = db.q("SELECT value FROM global_settings WHERE key='catalogVersion'")[0]; return r ? Number(r.value) : 0; }

  // =====================================================================================================
  say("=== getDecorationSettings: the answer and who may read it ===");
  wipe();
  {
    const r = await post({ action: "getDecorationSettings" });
    ok("an Admin is answered with the types in force, the registry and every type's prices", r.status === 200 && r.body.status === "ok" && same(r.body.types, ["embroidery", "dtf"]) &&
      same(r.body.registry.map(t => t.key), ALL_TYPES) && same(Object.keys(r.body.pricing), ALL_TYPES));
    ok("the registry carries each type's name for the screens (Embroidery, DTF transfer, Screen print, Vinyl / heat transfer, DTG, Sublimation)",
      same(r.body.registry.map(t => t.label), ["Embroidery", "DTF transfer", "Screen print", "Vinyl / heat transfer", "DTG", "Sublimation"]));
    ok("…an Admin sees the cost fields (they have costs.view)", hasCost(r.body.pricing) && "costCents" in r.body.pricing.screenprint);
    ok("…and embroidery's price has no cost field at all, as it never had one", !("costCents" in r.body.pricing.embroidery));
    await post({ action: "updateDecorationSettings", types: ["embroidery", "dtf", "screenprint"], pricing: { screenprint: { inkColorCents: 150, costCents: 40 }, dtf: { costCents: 90, priceCents: 300 } } });
    for (const who of ["manager", "staff", "production", "readGlobal", "catalogRead", "ordersRead"]) {
      const g = await post({ action: "getDecorationSettings" }, who);
      ok(`${who} may read the types: ${JSON.stringify(g.body.types)}`, g.status === 200 && same(g.body.types, ["embroidery", "dtf", "screenprint"]));
    }
    const m = await post({ action: "getDecorationSettings" }, "manager");
    ok("a Manager has costs.view, so sees the costs", m.body.pricing.screenprint.costCents === 40 && m.body.pricing.dtf.costCents === 90);
    for (const who of ["staff", "production", "readGlobal", "catalogRead", "ordersRead"]) {
      const g = await post({ action: "getDecorationSettings" }, who);
      ok(`${who} (no costs.view) gets the prices without any cost field, but the selling prices stay`, g.body.pricing.screenprint.inkColorCents === 150 && g.body.pricing.dtf.priceCents === 300 && !hasCost(g.body.pricing));
    }
    const w = await post({ action: "getDecorationSettings" }, "editWithCosts");
    ok("a made-up role with Global settings and costs.view sees the costs", w.body.pricing.dtf.costCents === 90);
    const n = await post({ action: "getDecorationSettings" }, "nobody");
    ok("a role with no part in any of those screens is refused, and told no price or type", forbidden(n) && !("types" in n.body) && !("pricing" in n.body));
    L.as.role = null;
    const out = await post({ action: "getDecorationSettings" }, null);
    ok("nobody signed in is refused", forbidden(out));
  }

  // =====================================================================================================
  say("=== updateDecorationSettings: who may save ===");
  wipe();
  {
    const v0 = version();
    for (const who of ["manager", "staff", "production", "readGlobal", "catalogRead", "ordersRead", "nobody", "auditCosts"]) {
      const r = await post({ action: "updateDecorationSettings", types: ["embroidery"] }, who);
      ok(`${who} can't save the types: refused, and nothing changed`, forbidden(r) && rowOf("decorationTypes") === undefined && version() === v0);
    }
    const none = await post({ action: "updateDecorationSettings", types: ["embroidery"] }, null);
    ok("nobody signed in can't save them", forbidden(none) && rowOf("decorationTypes") === undefined);
    for (const who of ["admin", "editNoCosts", "editWithCosts"]) {
      const r = await post({ action: "updateDecorationSettings", types: ["embroidery", "dtf"] }, who);
      ok(`${who} can save them`, r.status === 200 && r.body.status === "ok");
    }
  }

  // =====================================================================================================
  say("=== updateDecorationSettings: every refusal, and that a refusal saves nothing ===");
  wipe();
  {
    await post({ action: "updateDecorationSettings", types: ["embroidery", "dtf", "vinyl"], pricing: { vinyl: { priceCents: 300 } } });
    const types0 = rowOf("decorationTypes"), pricing0 = rowOf("decorationPricing"), v0 = version(), audits0 = auditRows("settings.%").length;
    const nothingChanged = () => rowOf("decorationTypes") === types0 && rowOf("decorationPricing") === pricing0 && version() === v0 && auditRows("settings.%").length === audits0;
    const cases = [
      ["an empty list of types", { types: [] }, MSG_NONE],
      ["types that aren't a list (text)", { types: "dtf" }, MSG_NONE],
      ["types that are null", { types: null }, MSG_NONE],
      ["types that are an object", { types: { dtf: true } }, MSG_NONE],
      ["an unknown type", { types: ["dtf", "paint"] }, "Unknown decoration type: paint"],
      ["an unknown type with a long name (cut to 40)", { types: ["y".repeat(90)] }, "Unknown decoration type: " + "y".repeat(40)],
      ["a type written with a capital", { types: ["DTF"] }, "Unknown decoration type: DTF"],
      ["a number as a type", { types: [3] }, "Unknown decoration type: 3"],
      ["a good list with one bad one beside it", { types: ["embroidery", "dtg", "x"] }, "Unknown decoration type: x"],
      ["prices that are null", { pricing: null }, "That isn't a valid set of decoration prices."],
      ["prices that are a list", { pricing: [] }, "That isn't a valid set of decoration prices."],
      ["prices that are text", { pricing: "free" }, "That isn't a valid set of decoration prices."],
      ["a type's prices that are text", { pricing: { dtf: "free" } }, "The DTF transfer prices aren't valid."],
      ["a type's prices that are null", { pricing: { screenprint: null } }, "The Screen print prices aren't valid."],
      ["a type's prices that are a list", { pricing: { vinyl: [1] } }, "The Vinyl / heat transfer prices aren't valid."],
      ["embroidery's stitch pricing given as text", { pricing: { embroidery: { stitchPricing: "yes" } } }, "Embroidery: price by stitch count is on or off."],
      ["embroidery's stitch pricing given as 1", { pricing: { embroidery: { stitchPricing: 1 } } }, "Embroidery: price by stitch count is on or off."],
      ["a minimum stitch count that is negative", { pricing: { embroidery: { minStitches: -1 } } }, "Embroidery: the minimum stitches is a whole number from 0 up."],
      ["a minimum stitch count with a fraction", { pricing: { embroidery: { minStitches: 10.5 } } }, "Embroidery: the minimum stitches is a whole number from 0 up."],
      ["a minimum stitch count past 100,000,000", { pricing: { embroidery: { minStitches: 100000001 } } }, "Embroidery: the minimum stitches is a whole number from 0 up."],
      ["a price per 1,000 stitches in dollars and cents", { pricing: { embroidery: { centsPer1000: 1.5 } } }, "Embroidery: prices are whole cents from $0 to $1,000,000."],
      ["a negative DTF price", { pricing: { dtf: { priceCents: -1 } } }, "DTF transfer: prices are whole cents from $0 to $1,000,000."],
      ["a DTF price as text", { pricing: { dtf: { priceCents: "5" } } }, "DTF transfer: prices are whole cents from $0 to $1,000,000."],
      ["a DTG cost past $1,000,000", { pricing: { dtg: { costCents: 100000001 } } }, "DTG: prices are whole cents from $0 to $1,000,000."],
      ["a sublimation setup with a fraction of a cent", { pricing: { sublimation: { setupCents: 0.5 } } }, "Sublimation: prices are whole cents from $0 to $1,000,000."],
      ["screen print's most colours 0", { pricing: { screenprint: { maxColors: 0 } } }, "Screen print: the most colours is a whole number from 1 to 12."],
      ["screen print's most colours 13", { pricing: { screenprint: { maxColors: 13 } } }, "Screen print: the most colours is a whole number from 1 to 12."],
      ["screen print's most colours as text", { pricing: { screenprint: { maxColors: "3" } } }, "Screen print: the most colours is a whole number from 1 to 12."],
      ["screen print's most colours with a fraction", { pricing: { screenprint: { maxColors: 2.5 } } }, "Screen print: the most colours is a whole number from 1 to 12."],
      ["good types beside bad prices", { types: ["dtg"], pricing: { dtf: { priceCents: -1 } } }, "DTF transfer: prices are whole cents from $0 to $1,000,000."],
      ["good prices beside bad types", { types: [], pricing: { dtf: { priceCents: 100 } } }, MSG_NONE],
    ];
    for (const [what, body, message] of cases) {
      const r = await post(Object.assign({ action: "updateDecorationSettings" }, body));
      ok(`${what} is refused (400): ${message}`, refused(r, 400, message) && nothingChanged());
    }
    ok("none of the refusals saved anything, moved the catalog version or wrote an audit row", nothingChanged());
  }

  // =====================================================================================================
  say("=== updateDecorationSettings: what is saved and answered ===");
  wipe();
  {
    const v0 = version();
    let r = await post({ action: "updateDecorationSettings", types: ["dtg", "screenprint", "embroidery", "dtg"] });
    ok("a list of types is saved in registry order, once each, and answered with the registry and prices", r.status === 200 && same(r.body.types, ["embroidery", "screenprint", "dtg"]) &&
      same(r.body.registry.map(t => t.key), ALL_TYPES) && same(stored("decorationTypes"), ["embroidery", "screenprint", "dtg"]));
    ok("…and the prices stayed at their defaults", same(Object.keys(r.body.pricing), ALL_TYPES) && r.body.pricing.dtf.priceCents === 0 && r.body.pricing.screenprint.maxColors === 6);
    ok("…and the catalog version went up", version() > v0);
    ok("the types read back through getDecorationSettings", same((await post({ action: "getDecorationSettings" })).body.types, ["embroidery", "screenprint", "dtg"]));
    r = await post({ action: "updateDecorationSettings", pricing: { embroidery: { stitchPricing: true, centsPer1000: 100, minStitches: 5000, minCents: 400 },
      screenprint: { inkColorCents: 150, screenSetupCents: 2000, reorderSetupCents: 500, costCents: 25, maxColors: 4 }, dtg: { priceCents: 800, costCents: 300, setupCents: 0 } } });
    ok("prices alone are saved, and the types stay as they were", r.status === 200 && same(r.body.types, ["embroidery", "screenprint", "dtg"]) && same(stored("decorationTypes"), ["embroidery", "screenprint", "dtg"]));
    ok("…every figure as sent, in cents", r.body.pricing.embroidery.stitchPricing === true && r.body.pricing.embroidery.centsPer1000 === 100 && r.body.pricing.embroidery.minStitches === 5000 &&
      r.body.pricing.embroidery.minCents === 400 && r.body.pricing.screenprint.inkColorCents === 150 && r.body.pricing.screenprint.maxColors === 4 && r.body.pricing.dtg.costCents === 300);
    ok("…and what is stored matches what was answered", same(stored("decorationPricing"), r.body.pricing));
    r = await post({ action: "updateDecorationSettings", pricing: { dtg: { priceCents: 900 } } });
    ok("sending one type's price keeps every other type's, and the fields left out of that type", r.body.pricing.dtg.priceCents === 900 && r.body.pricing.dtg.costCents === 300 &&
      r.body.pricing.screenprint.inkColorCents === 150 && r.body.pricing.embroidery.minStitches === 5000);
    r = await post({ action: "updateDecorationSettings", pricing: { dtf: { priceCents: 0 } } });
    ok("a price set to 0 is saved as 0 (not mistaken for left out)", r.body.pricing.dtf.priceCents === 0 && r.body.pricing.dtg.priceCents === 900);
    r = await post({ action: "updateDecorationSettings", pricing: { embroidery: { stitchPricing: false } } });
    ok("the stitch pricing tick can be switched off, and its figures stay", r.body.pricing.embroidery.stitchPricing === false && r.body.pricing.embroidery.centsPer1000 === 100);
    r = await post({ action: "updateDecorationSettings", pricing: { mystery: { priceCents: 1 }, vinyl: { bogusField: 5, priceCents: 120 } } });
    ok("an unknown type, and an unknown field of a known type, are left out of what is stored", r.status === 200 && !("mystery" in stored("decorationPricing")) &&
      !("bogusField" in stored("decorationPricing").vinyl) && stored("decorationPricing").vinyl.priceCents === 120);
    r = await post({ action: "updateDecorationSettings", types: ["dtf"], pricing: { dtf: { priceCents: 111 } } });
    ok("types and prices can be saved together", same(r.body.types, ["dtf"]) && r.body.pricing.dtf.priceCents === 111 && same(stored("decorationTypes"), ["dtf"]));
    const before = rowOf("decorationPricing"), vb = version();
    r = await post({ action: "updateDecorationSettings" });
    ok("a save that sends neither changes nothing stored and answers what is in force", r.status === 200 && rowOf("decorationPricing") === before && same(r.body.types, ["dtf"]));
    r = await post({ action: "updateDecorationSettings", types: ["embroidery", "dtf", "screenprint", "vinyl", "dtg", "sublimation"] });
    ok("every type can be ticked", same(r.body.types, ALL_TYPES) && vb <= version());
  }

  // =====================================================================================================
  say("=== updateDecorationSettings: a role without costs.view and the stored costs ===");
  wipe();
  {
    await post({ action: "updateDecorationSettings", types: ["embroidery", "dtf", "screenprint"], pricing: { dtf: { priceCents: 300, costCents: 90, setupCents: 50 }, screenprint: { inkColorCents: 150, costCents: 40, screenSetupCents: 2000 } } });
    const costsBefore = stored("decorationPricing");
    let r = await post({ action: "updateDecorationSettings", pricing: { dtf: { priceCents: 350, costCents: 1, setupCents: 60 }, screenprint: { costCents: 9999, inkColorCents: 175 } } }, "editNoCosts");
    ok("a role with Global settings but no costs.view saves the prices it can see", r.status === 200 && stored("decorationPricing").dtf.priceCents === 350 && stored("decorationPricing").dtf.setupCents === 60 && stored("decorationPricing").screenprint.inkColorCents === 175);
    ok("…and the costs it sent are ignored: the stored costs stay (DTF 90, screen print 40)", stored("decorationPricing").dtf.costCents === costsBefore.dtf.costCents && stored("decorationPricing").screenprint.costCents === 40);
    ok("…and its answer has no cost field", !hasCost(r.body.pricing) && r.body.pricing.dtf.priceCents === 350);
    r = await post({ action: "updateDecorationSettings", pricing: { dtf: { costCents: 110 } } }, "editWithCosts");
    ok("a role with costs.view saves a cost, and sees it in the answer", r.status === 200 && stored("decorationPricing").dtf.costCents === 110 && r.body.pricing.dtf.costCents === 110);
    r = await post({ action: "updateDecorationSettings", types: ["embroidery"] }, "editNoCosts");
    ok("a types-only save by a role without costs.view keeps all the costs", r.status === 200 && stored("decorationPricing").dtf.costCents === 110 && stored("decorationPricing").screenprint.costCents === 40 && !hasCost(r.body.pricing));
    r = await post({ action: "updateDecorationSettings", pricing: { dtf: { priceCents: 360 } } }, "admin");
    ok("an Admin's answer carries the costs", r.body.pricing.dtf.costCents === 110 && r.body.pricing.screenprint.costCents === 40);
    const audit = auditRows("settings.decoration_prices_set");
    ok("the price audit row of a save with a cost the role couldn't set shows no cost change", !audit.some(a => a.actor === "pat@example.com" && JSON.stringify(a.detail).includes('"dtf.costCents":{"from":110,"to":1}')));
  }

  // =====================================================================================================
  say("=== updateDecorationSettings: the audit ===");
  wipe();
  {
    await post({ action: "updateDecorationSettings", types: ["embroidery", "dtf", "dtg"] });
    let rows = auditRows("settings.decoration%");
    ok("changing the types writes one 'settings.decoration_set' row naming what it was and is", rows.length === 1 && rows[0].action === "settings.decoration_set" &&
      same(rows[0].detail.changes.types.from, ["embroidery", "dtf"]) && same(rows[0].detail.changes.types.to, ["embroidery", "dtf", "dtg"]));
    ok("…with the signed-in person as the actor", rows[0].actor === "pat@example.com");
    await post({ action: "updateDecorationSettings", types: ["dtg", "dtf", "embroidery"] });
    ok("saving the same types again writes no new types row", auditRows("settings.decoration_set").length === 1);
    wipe();
    await post({ action: "updateDecorationSettings", pricing: { dtf: { priceCents: 300 }, vinyl: { priceCents: 450, setupCents: 100 } } });
    rows = auditRows("settings.decoration_prices_set");
    ok("changing prices writes one 'settings.decoration_prices_set' row, each changed figure by name with its from and to",
      rows.length === 1 && same(rows[0].detail.changes["dtf.priceCents"], { from: 0, to: 300 }) && same(rows[0].detail.changes["vinyl.priceCents"], { from: 0, to: 450 }) &&
      same(rows[0].detail.changes["vinyl.setupCents"], { from: 0, to: 100 }));
    ok("…and only the figures that changed (no DTF cost, no embroidery lines)", Object.keys(rows[0].detail.changes).sort().join() === "dtf.priceCents,vinyl.priceCents,vinyl.setupCents");
    ok("…and no types row, as the types didn't change", auditRows("settings.decoration_set").length === 0);
    await post({ action: "updateDecorationSettings", pricing: { dtf: { priceCents: 300 } } });
    ok("saving the same prices again writes no row", auditRows("settings.decoration_prices_set").length === 1);
    await post({ action: "updateDecorationSettings", pricing: { embroidery: { stitchPricing: true } } });
    const last = auditRows("settings.decoration_prices_set").pop();
    ok("the stitch pricing tick is audited as a true or false", same(last.detail.changes["embroidery.stitchPricing"], { from: false, to: true }));
    wipe();
    await post({ action: "updateDecorationSettings", types: ["screenprint"], pricing: { screenprint: { inkColorCents: 150 } } });
    ok("types and prices together write both rows", auditRows("settings.decoration_set").length === 1 && auditRows("settings.decoration_prices_set").length === 1);
  }

  say("=== The audit log for a role without costs.view ===");
  {
    const q = async (as, filter) => (await post({ action: "getAuditLog", filter, limit: 50 }, as));
    const noCost = await q("auditNoCosts", "settings.decoration_prices_set");
    const costs = await q("auditCosts", "settings.decoration_prices_set");
    const rowsNo = noCost.body.entries || noCost.body.rows || noCost.body.log || [];
    const rowsYes = costs.body.entries || costs.body.rows || costs.body.log || [];
    ok("a role that reads the audit log with costs.view sees what each price changed from and to", rowsYes.length === 1 && !!rowsYes[0].detail && JSON.stringify(rowsYes[0].detail).includes("screenprint.inkColorCents"));
    ok("…without costs.view it sees that a price was changed, but not the figures", rowsNo.length === 1 && !rowsNo[0].detail);
    const types = await q("auditNoCosts", "settings.decoration_set");
    ok("…while a change of types is shown in full to both (it isn't money)", (types.body.entries || types.body.rows || types.body.log || []).every(e => !!e.detail) && auditRows("settings.decoration_set").length === 1);
  }

  say("=== updateDecorationSettings: the audit log or the database failing ===");
  wipe();
  {
    await post({ action: "updateDecorationSettings", types: ["embroidery", "dtf"], pricing: { dtf: { priceCents: 100 } } });
    const t0 = rowOf("decorationTypes"), p0 = rowOf("decorationPricing");
    d1._raw.exec("ALTER TABLE audit_log RENAME TO audit_log_away");
    let r;
    try { r = await quiet(() => post({ action: "updateDecorationSettings", types: ["dtf"] })); } finally { d1._raw.exec("ALTER TABLE audit_log_away RENAME TO audit_log"); }
    ok("changing the types when the audit log can't be written is refused (503), and nothing is saved", refused(r, 503, MSG_AUDIT) && rowOf("decorationTypes") === t0);
    const flaky = { prepare: (...a) => d1.prepare(...a), batch: async () => { throw new Error("database busy"); }, exec: (...a) => d1.exec(...a) };
    r = await quiet(() => post({ action: "updateDecorationSettings", pricing: { dtf: { priceCents: 999 } } }, "admin", { DB: flaky }));
    ok("a database that refuses the write answers 503 'Nothing was saved', and the prices stay", refused(r, 503, MSG_NOT_SAVED) && rowOf("decorationPricing") === p0);
    ok("…and no prices audit row was written for a save that didn't happen", auditRows("settings.decoration_prices_set").filter(a => a.detail.changes["dtf.priceCents"] && a.detail.changes["dtf.priceCents"].to === 999).length === 0);
  }

  // =====================================================================================================
  say("=== Global settings → Save: the Decoration types section ===");
  wipe();
  {
    const save = (settings, as = "admin", useEnv) => post({ action: "saveGlobalSettingsAll", settings }, as, useEnv);
    const v0 = version();
    let r = await save({ decoration: { types: ["embroidery", "screenprint"], pricing: { screenprint: { inkColorCents: 125, costCents: 35 } } } });
    ok("an Admin saves the section: ok, and the section is named Decoration types", r.status === 200 && r.body.status === "ok" && same(r.body.sections, ["Decoration types"]));
    ok("…the answer carries what was stored: types and prices", same(r.body.settings.decoration.types, ["embroidery", "screenprint"]) && r.body.settings.decoration.pricing.screenprint.inkColorCents === 125);
    ok("…an Admin's answer carries the costs", r.body.settings.decoration.pricing.screenprint.costCents === 35);
    ok("…what is stored is what was sent", same(stored("decorationTypes"), ["embroidery", "screenprint"]) && stored("decorationPricing").screenprint.costCents === 35);
    ok("…the catalog version went up, so shop pages see the types", version() > v0);
    ok("…both audit rows were written (types, and prices)", auditRows("settings.decoration_set").length === 1 && auditRows("settings.decoration_prices_set").length === 1);
    ok("…the types row names the list it was and is", same(auditRows("settings.decoration_set")[0].detail.changes.types, { from: ["embroidery", "dtf"], to: ["embroidery", "screenprint"] }));

    r = await save({ decoration: { pricing: { screenprint: { inkColorCents: 130, costCents: 9999 } } } }, "editNoCosts");
    ok("a role without costs.view saves the prices it sees, keeps the stored costs, and its answer carries no costs",
      r.status === 200 && stored("decorationPricing").screenprint.inkColorCents === 130 && stored("decorationPricing").screenprint.costCents === 35 && !hasCost(r.body.settings.decoration.pricing));
    r = await save({ decoration: { pricing: { screenprint: { costCents: 36 } } } }, "editWithCosts");
    ok("a role with costs.view saves the cost and sees it", stored("decorationPricing").screenprint.costCents === 36 && r.body.settings.decoration.pricing.screenprint.costCents === 36);
    r = await save({ decoration: { types: ["embroidery", "screenprint"] } });
    ok("a section that sends only types keeps the prices", stored("decorationPricing").screenprint.inkColorCents === 130);
    const vSame = version();
    await save({ decoration: { types: ["embroidery", "screenprint"] } });
    ok("a save that changes nothing writes no new types row", auditRows("settings.decoration_set").length === 1 && version() >= vSame);

    // The permission and the refusals.
    const stateBefore = () => rowOf("decorationTypes") + "|" + rowOf("decorationPricing") + "|" + version() + "|" + auditRows("settings.%").length;
    const s0 = stateBefore();
    for (const who of ["manager", "staff", "production", "readGlobal", "nobody", "catalogRead"]) {
      r = await save({ decoration: { types: ["dtf"] } }, who);
      ok(`${who} can't save Global settings' decoration section: refused, nothing saved`, forbidden(r) && stateBefore() === s0);
    }
    const cases = [
      ["an empty list of types", { types: [] }, MSG_NONE],
      ["an unknown type", { types: ["paint"] }, "Unknown decoration type: paint"],
      ["a bad price", { pricing: { dtf: { priceCents: -3 } } }, "DTF transfer: prices are whole cents from $0 to $1,000,000."],
      ["most colours 40", { pricing: { screenprint: { maxColors: 40 } } }, "Screen print: the most colours is a whole number from 1 to 12."],
      ["prices that are a list", { pricing: [] }, "That isn't a valid set of decoration prices."],
    ];
    for (const [what, section, message] of cases) {
      r = await save({ decoration: section });
      ok(`${what} is refused (400) with the section named: ${message}`, r.status === 400 && r.body.status === "error" && r.body.section === "Decoration types" && r.body.message === message && stateBefore() === s0);
    }
    r = await save({ decoration: ["dtf"] });
    ok("a section that is a list is refused: That isn't a valid Decoration types section.", r.status === 400 && r.body.section === "Decoration types" && r.body.message === "That isn't a valid Decoration types section." && stateBefore() === s0);
    r = await save({ decoration: "dtf" });
    ok("a section that is text is refused the same way", r.status === 400 && r.body.message === "That isn't a valid Decoration types section." && stateBefore() === s0);
    r = await save({ decoration: null });
    ok("a section sent as null is left out: nothing to save", refused(r, 400, "Nothing to save.") && stateBefore() === s0);

    // All or nothing with another section.
    const acct = () => rowOf("accounting");
    const a0 = acct();
    r = await save({ decoration: { types: ["dtg"] }, accounting: { saleDate: "never" } });
    ok("a good decoration section with a refused Bookkeeping section saves neither (all or nothing), and the answer names Bookkeeping",
      r.status === 400 && r.body.section === "Bookkeeping" && stateBefore() === s0 && acct() === a0);
    r = await save({ decoration: { types: [] }, accounting: { saleDate: "placed" } });
    ok("a refused decoration section with a good Bookkeeping section saves neither, and the answer names Decoration types",
      r.status === 400 && r.body.section === "Decoration types" && stateBefore() === s0 && acct() === a0);
    r = await save({ decoration: { types: ["dtg"], pricing: { dtg: { priceCents: 777 } } }, accounting: { saleDate: "placed" } });
    ok("two good sections are both saved in the one request", r.status === 200 && same(r.body.sections, ["Bookkeeping", "Decoration types"]) &&
      same(stored("decorationTypes"), ["dtg"]) && stored("decorationPricing").dtg.priceCents === 777 && JSON.parse(acct()).saleDate === "placed");
    wipe();
    await save({ decoration: { types: ["embroidery", "dtf"] } });
    const vBefore = version(), t1 = rowOf("decorationTypes");
    const flaky = { prepare: (...a) => d1.prepare(...a), batch: async () => { throw new Error("database busy"); }, exec: (...a) => d1.exec(...a) };
    r = await quiet(() => save({ decoration: { types: ["dtg"] } }, "admin", { DB: flaky }));
    ok("a database that refuses the batch answers 503 'Nothing was saved', and the types stay", refused(r, 503, MSG_NOT_SAVED) && rowOf("decorationTypes") === t1 && version() === vBefore);
  }

  // =====================================================================================================
  say("=== priceDecoration: the answer and who may ask ===");
  wipe();
  {
    await post({ action: "updateDecorationSettings", types: ["embroidery", "dtf", "screenprint", "vinyl"], pricing: {
      embroidery: { stitchPricing: true, centsPer1000: 100, minStitches: 0, minCents: 0 },
      screenprint: { inkColorCents: 150, screenSetupCents: 2000, reorderSetupCents: 500, costCents: 33, maxColors: 6 },
      dtf: { priceCents: 300, costCents: 111, setupCents: 100 }, vinyl: { priceCents: 450, costCents: 200, setupCents: 0 } } });
    const price = (type, params, as = "admin") => post({ action: "priceDecoration", type, params }, as);
    let r = await price("screenprint", { colors: 2, locations: 1 });
    ok("screen print, 2 colours, 1 location at $1.50 a colour: $3.00 a piece, $40.00 set up", r.status === 200 && r.body.status === "ok" && r.body.unitCents === 300 && r.body.setupCents === 4000);
    ok("…with a note that says how it was worked out", r.body.note === "2 colours × 1 location");
    r = await price("screenprint", { colors: 2, locations: 2, reorder: true });
    ok("a reorder uses the reorder setup and 2 locations double both: $6.00 a piece, $20.00 set up (2 colours × 2 locations × $5.00)", r.body.unitCents === 600 && r.body.setupCents === 2000 && r.body.note === "2 colours × 2 locations, reorder");
    r = await price("embroidery", { stitches: 8500 });
    ok("embroidery with stitch pricing on at $1.00 per 1,000: 8,500 stitches is $8.50 a piece", r.body.unitCents === 850 && r.body.setupCents === 0 && r.body.note === "8,500 stitches × $1.00 per 1,000");
    r = await price("dtf", { locations: 2 });
    ok("DTF: the price times the locations, and the setup", r.body.unitCents === 600 && r.body.setupCents === 100 && r.body.note === "2 locations × $3.00");
    r = await price("vinyl", {});
    ok("vinyl with no params counts 1 location", r.body.unitCents === 450 && r.body.setupCents === 0 && r.body.note === "1 location × $4.50");
    r = await price("vinyl");
    ok("…and with no params at all the same", r.body.status === "ok" && r.body.unitCents === 450);
    r = await price("vinyl", null);
    ok("…and with params null the same", r.body.status === "ok" && r.body.unitCents === 450);
    ok("the answer never carries a cost: only status, unitCents, setupCents and note", Object.keys((await price("dtf", { locations: 1 })).body).sort().join() === "note,setupCents,status,unitCents");
    r = await price("dtg", { locations: 1 });
    ok("a type switched off in Global settings is still priced from its saved prices (DTG: nothing set yet, so $0.00)", r.status === 200 && r.body.unitCents === 0);
    r = await price("paint", {});
    ok("an unknown type is refused (400): Unknown decoration type: paint", refused(r, 400, "Unknown decoration type: paint"));
    r = await price("q".repeat(70), {});
    ok("…a long name is cut to 40 characters", refused(r, 400, "Unknown decoration type: " + "q".repeat(40)));
    r = await price("", {});
    ok("a missing type is refused: Unknown decoration type: (empty)", r.status === 400 && /^Unknown decoration type: $/.test(r.body.message));
    r = await price(undefined, {});
    ok("…also when left out altogether", r.status === 400 && r.body.status === "error");
    r = await price("dtf", []);
    ok("params that are a list are refused: params must be an object", refused(r, 400, "params must be an object"));
    r = await price("dtf", "two");
    ok("params that are text are refused the same way", refused(r, 400, "params must be an object"));

    // Prices follow a save with no Publish.
    await post({ action: "updateDecorationSettings", pricing: { dtf: { priceCents: 325 } } });
    ok("a changed price answers at once, with no Publish", (await price("dtf", { locations: 1 })).body.unitCents === 325);

    // Who may ask.
    for (const who of ["manager", "staff", "catalogRead"]) {
      const g = await price("dtf", { locations: 1 }, who);
      ok(`${who} may ask for a price (a quote, an order or a product)`, g.status === 200 && g.body.unitCents === 325);
    }
    for (const who of ["production", "ordersRead", "readGlobal", "nobody"]) {
      const g = await price("dtf", { locations: 1 }, who);
      ok(`${who} may not (an order at read, Global settings and the Run order don't ask for prices)`, forbidden(g) && !("unitCents" in g.body));
    }
    const some = await price("dtf", { locations: 1 }, role("ordersEdit", { "orders.details": "edit" }));
    ok("a role with an order at edit may ask", some.status === 200 && some.body.unitCents === 325);
    const quote = await price("dtf", { locations: 1 }, role("quotesRead", { "quotes.estimates": "read" }));
    ok("a role with quotes at read may ask", quote.status === 200);
    const none = await price("dtf", { locations: 1 }, null);
    ok("nobody signed in is refused", forbidden(none));
  }

  // =====================================================================================================
  say("=== The public catalog carries decorationTypes ===");
  wipe();
  freshCacheApi();
  {
    const cat = await freshDb();
    const cenv = { DB: cat };
    cat._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('club','club','Example Club','t','t',1), ('boost','boost','Example Boosters','t','t',1);`);
    for (const id of ["club", "boost"]) { await L.createProduct(cat, id, { productId: "tee", type: "shirt", name: "Tee", pricingMode: "flat", flatPrice: 20, visible: true, noDesignNeeded: true, reorderQr: "none" }); await L.publishShop(cat, id); }
    const catalog = async (url) => { const res = await L.catalogGet({ request: { url, headers: { get: () => null } }, env: cenv }); return { status: res.status, body: JSON.parse(await res.text()) }; };
    const admin = (body, as = "admin") => post(body, as, cenv);
    ok("(a whole-install catalog of a database that saved nothing lists embroidery and DTF)", same((await L.getPublicCatalogData(cat)).decorationTypes, ["embroidery", "dtf"]));
    ok("the meta part of the catalog (what every API call reads) lists them too, and no shop's products", same((await L.getPublicCatalogMeta(cat)).decorationTypes, ["embroidery", "dtf"]) && !("orgs" in (await L.getPublicCatalogMeta(cat))));
    let c = await catalog(shopOrigin("club") + "/api/catalog");
    ok("a shop's answer lists them", c.status === 200 && c.body.status === "ok" && same(c.body.decorationTypes, ["embroidery", "dtf"]));
    let a = await catalog(ADMIN_ORIGIN + "/api/catalog");
    ok("the admin host's answer lists them (the admin pages read it from there)", a.body.status === "admin" && same(a.body.decorationTypes, ["embroidery", "dtf"]));
    let u = await catalog("https://elsewhere.invalid/api/catalog");
    ok("an address that isn't ours (404, Unrecognized host) still says which types are on", u.status === 404 && u.body.message === "Unrecognized host" && same(u.body.decorationTypes, ["embroidery", "dtf"]));
    u = await catalog("https://" + ROOT + "/api/catalog");
    ok("the root address (no shop: Unknown org) still says which types are on", u.status === 200 && u.body.message === "Unknown org" && same(u.body.decorationTypes, ["embroidery", "dtf"]));

    const v0 = Number((cat.q("SELECT value FROM global_settings WHERE key='catalogVersion'")[0] || { value: 0 }).value);
    const r = await admin({ action: "updateDecorationSettings", types: ["embroidery", "screenprint", "sublimation"] });
    ok("(the types are saved through the real action, with no Publish after)", r.status === 200 && Number(cat.q("SELECT value FROM global_settings WHERE key='catalogVersion'")[0].value) > v0);
    L.invalidateCatalogVersionCache();
    ok("the whole-install and meta answers show the new list", same((await L.getPublicCatalogData(cat)).decorationTypes, ["embroidery", "screenprint", "sublimation"]) &&
      same((await L.getPublicCatalogMeta(cat)).decorationTypes, ["embroidery", "screenprint", "sublimation"]));
    c = await catalog(shopOrigin("club") + "/api/catalog");
    ok("a shop page that already had the old answer cached sees the new list at its next read", same(c.body.decorationTypes, ["embroidery", "screenprint", "sublimation"]));
    const b = await catalog(shopOrigin("boost") + "/api/catalog");
    ok("…every shop sees it, as it is the install's (not a shop's)", same(b.body.decorationTypes, ["embroidery", "screenprint", "sublimation"]));
    a = await catalog(ADMIN_ORIGIN + "/api/catalog");
    ok("…and so does the admin host", same(a.body.decorationTypes, ["embroidery", "screenprint", "sublimation"]));

    // Through the Save of Global settings as well.
    const v1 = Number(cat.q("SELECT value FROM global_settings WHERE key='catalogVersion'")[0].value);
    const g = await admin({ action: "saveGlobalSettingsAll", settings: { decoration: { types: ["dtf", "dtg"] } } });
    ok("a save from Global settings → Save raises the catalog version too", g.status === 200 && Number(cat.q("SELECT value FROM global_settings WHERE key='catalogVersion'")[0].value) > v1);
    L.invalidateCatalogVersionCache();
    c = await catalog(shopOrigin("club") + "/api/catalog");
    ok("…and the shop sees: dtf, dtg", same(c.body.decorationTypes, ["dtf", "dtg"]));

    // The storefront switched off still says which types.
    await admin({ action: "updateFeatures", features: { storefront: false } });
    L.invalidateCatalogVersionCache();
    c = await catalog(shopOrigin("club") + "/api/catalog");
    ok("with the storefront switched off the closed page still carries the list", c.body.status === "closed" && same(c.body.decorationTypes, ["dtf", "dtg"]));
    await admin({ action: "updateFeatures", features: { storefront: true } });
    L.invalidateCatalogVersionCache();

    // A meta entry cached before the types existed.
    c = await catalog(shopOrigin("club") + "/api/catalog");
    const curV = Number(cat.q("SELECT value FROM global_settings WHERE key='catalogVersion'")[0].value);
    const metaKey = [...cacheStore.keys()].find(k => k.endsWith("/v" + curV + "/meta"));
    if (metaKey) {
      const entry = JSON.parse(await cacheStore.get(metaKey).clone().text());
      ok("(the cached meta entry holds the list)", Array.isArray(entry.decorationTypes));
      delete entry.decorationTypes;
      cacheStore.set(metaKey, new Response(JSON.stringify(entry), { headers: { "Content-Type": "application/json", "X-Catalog-Built-At": String(Date.now()) } }));
      L._resetCatalogCacheState();
      c = await catalog(shopOrigin("club") + "/api/catalog");
      ok("a meta entry cached before the types existed: the shop is answered, with no decorationTypes key (the page then treats every type as on)", c.status === 200 && c.body.status === "ok" && !("decorationTypes" in c.body));
      a = await catalog(ADMIN_ORIGIN + "/api/catalog");
      ok("…and the admin host's answer the same", a.body.status === "admin" && !("decorationTypes" in a.body));
    } else ok("the cached meta entry could be found by its key", false);
  }

  console.log("\nThe decoration settings checks are done.");
})().catch(e => { console.log("test375 crashed: " + (e && e.stack || e)); process.exit(1); });
