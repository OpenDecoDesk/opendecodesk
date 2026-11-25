const fs = require("fs");
const { JSDOM, VirtualConsole } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");
const { storefrontPage } = require("./testlib/storefront-page");
const { shopOrigin, ADMIN_ORIGIN } = require("./testlib/hosts.js");
const { ok } = require("./testlib/check");
const roles = require("./testlib/roles");

// A shop's fundraiser (migrations/0110) as a shop's visitors see it:
//   functions/api/catalog.js — fundraiserShopText_ words the setup as one sentence ("$2.00 of every item supports …",
//     "10% of every purchase supports …"), only when the shop ticked "Show on the shop"; the catalog answer carries it
//     as fundraiser: { text } and nothing else of the setup, and leaves the key out otherwise. The setting is live: after
//     setOrgFundraiser (the real orders.js action) the catalog moves to a new version, and the shop page shows the new
//     line without a Publish. A cached shop entry from before 0110 and a database without 0110 show nothing.
//   public/storefront.js — renderOrgPage, in jsdom, shows the sentence escaped right under the shop's description; not
//     on the "coming soon" page, and nothing when the catalog sent none.
// The REAL db.js, catalogCache.js, catalog.js and orders.js on sql.js; only the Cache API is a stand-in. Invented data
// only. Nothing depends on today's date: the one deadline used is in 2000.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");

global.fetch = async (url) => { throw new Error("unexpected fetch " + url); };

// The libraries in one scope; orders.js and catalog.js each in their own (both declare onRequest…).
const L = new Function(
  strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  strip(read("functions/_lib/db.js")) + "\n" + strip(read("functions/_lib/email.js")) + "\n" + strip(read("functions/_lib/quoteToken.js")) + "\n" +
  strip(read("functions/_lib/boxSize.js")) + "\n" + strip(read("functions/_lib/catalogCache.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'pat@example.com';\n" + roles.adminAs() + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyTurnstile = async () => ({ ok: true });\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  "const ordersApi = (function(){\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost; })();\n" +
  "const catalogApi = (function(){\n" + strip(read("functions/api/catalog.js")) + "\nreturn { onRequestGet, fundraiserShopText_ }; })();\n" +
  "return { ordersApi, catalogGet: catalogApi.onRequestGet, fundraiserShopText_: catalogApi.fundraiserShopText_,\n" +
  "  createProduct, publishShop, getPublishState, setOrgFundraiser, bumpCatalogVersion, invalidateCatalogVersionCache, _resetCatalogCacheState };")();

// A stand-in for the Cache API (caches.default).
let cacheStore = new Map();
function freshCacheApi() {
  cacheStore = new Map();
  global.caches = { default: {
    async match(key) { const hit = cacheStore.get(typeof key === "string" ? key : key.url); return hit ? hit.clone() : undefined; },
    async put(key, response) { cacheStore.set(typeof key === "string" ? key : key.url, response); },
  } };
  L._resetCatalogCacheState();
}

const pause = (ms) => new Promise(r => setTimeout(r, ms));
const wait = async (cond, n = 300) => { for (let i = 0; i < n && !cond(); i++) await pause(10); return !!cond(); };

async function freshDb(upTo = "9999") {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006" && f.slice(0, 4) <= upTo).sort()) d1.execFile(read("migrations/" + f));
  return d1;
}
async function addShop(d1, orgId, name, { ready = 1, desc = "Gear for the season." } = {}) {
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, "desc", accent, createdAt, updatedAt, ready) VALUES ('${orgId}','${orgId}','${name}','${desc}','#123456','t','t',${ready});`);
  await L.createProduct(d1, orgId, { productId: "tee", type: "shirt", name: "Club Tee", pricingMode: "flat", flatPrice: 20, visible: true, noDesignNeeded: true, reorderQr: "none" });
}

const NO_SETUP_KEYS = ["mode", "amount", "percent", "percentBps", "cents", "showOnShop", "label", "fundraiserJson"];

(async () => {
  // ============================================================================================================
  console.log("=== fundraiserShopText_: the sentence the shop page shows ===");
  // ============================================================================================================
  const T = L.fundraiserShopText_;
  ok("an amount per piece reads \"$2.00 of every item supports <label>\"",
    T({ mode: "perPiece", amount: 2, label: "Example Boosters", showOnShop: true }) === "$2.00 of every item supports Example Boosters");
  ok("…written to the cent: 0.5 → \"$0.50\", 12.25 → \"$12.25\", 1000 → \"$1000.00\"",
    T({ mode: "perPiece", amount: 0.5, label: "X", showOnShop: true }) === "$0.50 of every item supports X" &&
    T({ mode: "perPiece", amount: 12.25, label: "X", showOnShop: true }) === "$12.25 of every item supports X" &&
    T({ mode: "perPiece", amount: 1000, label: "X", showOnShop: true }) === "$1000.00 of every item supports X");
  ok("…an amount given as text is read as a number (\"3\" → \"$3.00\")",
    T({ mode: "perPiece", amount: "3", label: "X", showOnShop: true }) === "$3.00 of every item supports X");
  ok("a percent reads \"10% of every purchase supports <label>\"",
    T({ mode: "percent", percent: 10, label: "Example Club", showOnShop: true }) === "10% of every purchase supports Example Club");
  ok("…with no trailing zeros: 2.5 → \"2.5%\", 2.50 → \"2.5%\", 10.00 → \"10%\"",
    T({ mode: "percent", percent: 2.5, label: "X", showOnShop: true }) === "2.5% of every purchase supports X" &&
    T({ mode: "percent", percent: "2.50", label: "X", showOnShop: true }) === "2.5% of every purchase supports X" &&
    T({ mode: "percent", percent: "10.00", label: "X", showOnShop: true }) === "10% of every purchase supports X");
  ok("…two decimals kept (12.25 → \"12.25%\", 0.01 → \"0.01%\"), and more rounded to two (33.333 → \"33.33%\", 7.006 → \"7.01%\")",
    T({ mode: "percent", percent: 12.25, label: "X", showOnShop: true }) === "12.25% of every purchase supports X" &&
    T({ mode: "percent", percent: 0.01, label: "X", showOnShop: true }) === "0.01% of every purchase supports X" &&
    T({ mode: "percent", percent: 33.333, label: "X", showOnShop: true }) === "33.33% of every purchase supports X" &&
    T({ mode: "percent", percent: 7.006, label: "X", showOnShop: true }) === "7.01% of every purchase supports X");
  ok("the label is trimmed", T({ mode: "percent", percent: 5, label: "  Example Club  ", showOnShop: true }) === "5% of every purchase supports Example Club");
  ok("…and cut to 80 characters", T({ mode: "perPiece", amount: 1, label: "A".repeat(80) + "BCD", showOnShop: true }) === "$1.00 of every item supports " + "A".repeat(80));
  ok("…and left as typed otherwise — markup included (escaping is the page's job)",
    T({ mode: "perPiece", amount: 1, label: "<b>Example</b> & Co", showOnShop: true }) === "$1.00 of every item supports <b>Example</b> & Co");
  ok("nothing when \"Show on the shop\" is off", T({ mode: "percent", percent: 10, label: "Example Club", showOnShop: false }) === null);
  ok("…or missing", T({ mode: "percent", percent: 10, label: "Example Club" }) === null);
  ok("…or anything but true itself (\"true\", 1)",
    T({ mode: "percent", percent: 10, label: "Example Club", showOnShop: "true" }) === null && T({ mode: "percent", percent: 10, label: "Example Club", showOnShop: 1 }) === null);
  ok("nothing for no fundraiser (null, undefined) or one that isn't an object (\"\", a string, a number)",
    [null, undefined, "", "percent", 10, true].every(v => T(v) === null));
  ok("nothing for a setup with no label, an empty one, one of spaces only, or one that isn't text",
    [undefined, "", "   ", 0, null].every(label => T({ mode: "perPiece", amount: 2, label, showOnShop: true }) === null));
  ok("nothing for an amount per piece of 0, below 0, not a number, infinite or missing",
    [0, -1, "abc", Infinity, NaN, undefined].every(amount => T({ mode: "perPiece", amount, label: "X", showOnShop: true }) === null));
  ok("nothing for a percent of 0, below 0, not a number, infinite or missing",
    [0, -5, "ten", Infinity, NaN, undefined].every(percent => T({ mode: "percent", percent, label: "X", showOnShop: true }) === null));
  ok("nothing for an unknown mode, or none",
    T({ mode: "flat", amount: 2, percent: 10, label: "X", showOnShop: true }) === null && T({ amount: 2, label: "X", showOnShop: true }) === null &&
    T({ mode: "none", amount: 2, label: "X", showOnShop: true }) === null);
  ok("the STORED shape (percentBps / cents) is never read as a setup: nothing for it",
    T({ mode: "percent", percentBps: 1000, label: "X", showOnShop: true }) === null && T({ mode: "perPiece", cents: 200, label: "X", showOnShop: true }) === null);
  ok("an array is not a setup", T([]) === null);

  // ============================================================================================================
  console.log("\n=== The catalog answer carries the sentence, and only the sentence ===");
  // ============================================================================================================
  freshCacheApi();
  const d1 = await freshDb();
  const env = { DB: d1 };
  await addShop(d1, "club", "Example Club", { desc: "Gear for the Example Club." });
  await addShop(d1, "boost", "Example Boosters", { ready: 0, desc: "Coming in the spring." });
  await L.publishShop(d1, "club");
  const catalog = async (sub) => {
    const res = await L.catalogGet({ request: { url: shopOrigin(sub) + "/api/catalog", headers: { get: () => null } }, env });
    const text = await res.text();
    return { status: res.status, body: JSON.parse(text), text };
  };
  const admin = async (body) => {
    const res = await L.ordersApi({ env, waitUntil: (p) => Promise.resolve(p).catch(() => {}),
      request: { url: ADMIN_ORIGIN + "/api/orders", method: "POST", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const version = () => (d1.q("SELECT value FROM global_settings WHERE key='catalogVersion'")[0] || {}).value || null;

  let c = await catalog("club");
  ok("a shop with no fundraiser: the shop page is answered", c.status === 200 && c.body.status === "ok" && c.body.orgId === "club");
  ok("…and its catalog has no fundraiser key at all", !("fundraiser" in c.body.catalog));
  const prime = await catalog("club");   // the entry is now cached under this version
  ok("…the same answer from the cache", !("fundraiser" in prime.body.catalog));

  const v0 = version();
  let r = await admin({ action: "setOrgFundraiser", org: "club", fundraiser: { mode: "perPiece", amount: 2, label: "Example Boosters", showOnShop: true } });
  ok("setOrgFundraiser (an amount per piece, shown on the shop) is saved", r.status === 200 && r.body.status === "ok");
  ok("…and the catalog moves to a new version", version() !== v0 && Number(version()) === Number(v0 || 0) + 1);
  c = await catalog("club");
  ok("the next catalog answer has fundraiser: { text: \"$2.00 of every item supports Example Boosters\" }",
    JSON.stringify(c.body.catalog.fundraiser) === JSON.stringify({ text: "$2.00 of every item supports Example Boosters" }));
  ok("…without a Publish: the shop has no unpublished change", (await L.getPublishState(d1, ["club"])).club.state === "current");
  ok("…the fundraiser object holds the text alone", Object.keys(c.body.catalog.fundraiser).join(",") === "text");
  ok("…and nothing of the raw setup is anywhere in the answer (mode, amount, cents, the tick box)",
    !/percentBps|"cents"|showOnShop|fundraiserJson|perPiece/.test(c.text) && NO_SETUP_KEYS.every(k => !(k in c.body.catalog)));

  // The live value wins over the cached entry only once the version moves: a change behind the cache's back isn't seen.
  d1._raw.exec(`UPDATE orgs SET fundraiserJson='{"mode":"perPiece","cents":300,"label":"Example Boosters","showOnShop":true}' WHERE orgId='club';`);
  c = await catalog("club");
  ok("a change to the row with no version bump: the cached line stays (the bump is what shows it)", c.body.catalog.fundraiser.text === "$2.00 of every item supports Example Boosters");
  await L.bumpCatalogVersion(d1); L.invalidateCatalogVersionCache();
  c = await catalog("club");
  ok("…after the bump the live row is shown, still without a Publish", c.body.catalog.fundraiser.text === "$3.00 of every item supports Example Boosters");

  r = await admin({ action: "setOrgFundraiser", org: "club", fundraiser: { mode: "percent", percent: 10, label: "Example Club", showOnShop: true } });
  c = await catalog("club");
  ok("a percent of 10 reads \"10% of every purchase supports Example Club\"", r.status === 200 && c.body.catalog.fundraiser.text === "10% of every purchase supports Example Club");
  ok("…with no percent figure, bps or mode in the answer", !/percentBps|"percent"|"mode"|showOnShop/.test(c.text));
  await admin({ action: "setOrgFundraiser", org: "club", fundraiser: { mode: "percent", percent: 2.5, label: "Example Club", showOnShop: true } });
  c = await catalog("club");
  ok("a percent of 2.5 reads \"2.5%\"", c.body.catalog.fundraiser.text === "2.5% of every purchase supports Example Club");
  await admin({ action: "setOrgFundraiser", org: "club", fundraiser: { mode: "percent", percent: "12.25", label: "Example Club", showOnShop: true } });
  c = await catalog("club");
  ok("a percent of 12.25 reads \"12.25%\"", c.body.catalog.fundraiser.text === "12.25% of every purchase supports Example Club");
  await admin({ action: "setOrgFundraiser", org: "club", fundraiser: { mode: "perPiece", amount: 0.75, label: "  Example Club Boosters  ", showOnShop: true } });
  c = await catalog("club");
  ok("an amount of 0.75 reads \"$0.75\", with the label as saved (trimmed)", c.body.catalog.fundraiser.text === "$0.75 of every item supports Example Club Boosters");

  const vBefore = version();
  r = await admin({ action: "setOrgFundraiser", org: "club", fundraiser: { mode: "perPiece", amount: 0.75, label: "Example Club Boosters", showOnShop: false } });
  ok("ticking \"Show on the shop\" off moves the catalog to a new version", r.status === 200 && version() !== vBefore);
  c = await catalog("club");
  ok("…and the catalog leaves the fundraiser key out, though the shop still raises money", !("fundraiser" in c.body.catalog) &&
    JSON.parse(d1.q("SELECT fundraiserJson FROM orgs WHERE orgId='club'")[0].fundraiserJson).cents === 75);
  ok("…with no trace of the setup in the answer", !/fundraiser|Example Club Boosters|percentBps|showOnShop/.test(c.text));

  await admin({ action: "setOrgFundraiser", org: "club", fundraiser: { mode: "percent", percent: 10, label: "<b>Example</b> & Co", showOnShop: true } });
  c = await catalog("club");
  ok("a label with markup is sent as typed, as JSON text (the page escapes it)", c.body.catalog.fundraiser.text === "10% of every purchase supports <b>Example</b> & Co");
  const markupCatalog = c.body;

  r = await admin({ action: "setOrgFundraiser", org: "club", fundraiser: null });
  c = await catalog("club");
  ok("ending the fundraiser (null) leaves the key out on the next answer", r.status === 200 && !("fundraiser" in c.body.catalog));

  // A value that's damaged in the database is "nothing to show", never a broken sentence.
  const damaged = [
    ["that isn't JSON", "{not json"],
    ["with a percent of 0", '{"mode":"percent","percentBps":0,"label":"Example Club","showOnShop":true}'],
    ["with a percent over 50", '{"mode":"percent","percentBps":5001,"label":"Example Club","showOnShop":true}'],
    ["with a fractional bps", '{"mode":"percent","percentBps":10.5,"label":"Example Club","showOnShop":true}'],
    ["with an amount over $1,000", '{"mode":"perPiece","cents":100001,"label":"Example Club","showOnShop":true}'],
    ["with no label", '{"mode":"perPiece","cents":200,"label":"  ","showOnShop":true}'],
    ["with an unknown mode", '{"mode":"flat","cents":200,"label":"Example Club","showOnShop":true}'],
    ["in the parsed shape (percent, not percentBps)", '{"mode":"percent","percent":10,"label":"Example Club","showOnShop":true}'],
    ["that is a list", '[1,2]'],
    ["with the tick box as text", '{"mode":"perPiece","cents":200,"label":"Example Club","showOnShop":"true"}'],
  ];
  for (const [what, json] of damaged) {
    d1.q("UPDATE orgs SET fundraiserJson=? WHERE orgId='club'", json);
    await L.bumpCatalogVersion(d1); L.invalidateCatalogVersionCache();
    c = await catalog("club");
    ok(`a stored setup ${what}: the shop page is still answered, with no fundraiser key`, c.status === 200 && c.body.status === "ok" && !("fundraiser" in c.body.catalog));
  }
  // …and a valid one written the same way is shown (the loop's checks can tell the difference).
  d1.q("UPDATE orgs SET fundraiserJson=? WHERE orgId='club'", '{"mode":"perPiece","cents":150,"label":"Example Club","showOnShop":true}');
  await L.bumpCatalogVersion(d1); L.invalidateCatalogVersionCache();
  c = await catalog("club");
  ok("…while a whole stored setup written the same way is shown", c.body.catalog.fundraiser && c.body.catalog.fundraiser.text === "$1.50 of every item supports Example Club");
  const clubCatalog = c.body;

  await admin({ action: "setOrgFundraiser", org: "boost", fundraiser: { mode: "perPiece", amount: 1, label: "Example Boosters", showOnShop: true } });
  c = await catalog("boost");
  ok("a shop not ready yet still gets the line in its catalog (the page decides not to show it)",
    c.body.catalog.ready === false && c.body.catalog.fundraiser.text === "$1.00 of every item supports Example Boosters");
  const boostCatalog = c.body;

  // ============================================================================================================
  console.log("\n=== A shop entry cached before 0110 ===");
  // ============================================================================================================
  {
    // The club's entry as an install from before 0110 cached it: the same shop, with no fundraiser in it at all.
    d1.q("UPDATE orgs SET fundraiserJson=? WHERE orgId='club'", '{"mode":"percent","percentBps":1000,"label":"Example Club","showOnShop":true}');
    await L.bumpCatalogVersion(d1); L.invalidateCatalogVersionCache();
    await catalog("club");
    const key = [...cacheStore.keys()].find(k => k.endsWith("/v" + version() + "/shop/club"));
    const entry = JSON.parse(await cacheStore.get(key).clone().text());
    ok("(the cached entry holds the shop's parsed fundraiser)", !!entry && entry.fundraiser && entry.fundraiser.percent === 10);
    delete entry.fundraiser;
    cacheStore.set(key, new Response(JSON.stringify(entry), { headers: { "Content-Type": "application/json", "X-Catalog-Built-At": String(Date.now()) } }));
    L._resetCatalogCacheState();   // another isolate: it reads the Cache API's entry
    c = await catalog("club");
    ok("a cached entry with no fundraiser: the shop page is answered, with no fundraiser key", c.status === 200 && c.body.status === "ok" && !("fundraiser" in c.body.catalog));
    await L.bumpCatalogVersion(d1); L.invalidateCatalogVersionCache();
    c = await catalog("club");
    ok("…and the next version shows the live line", c.body.catalog.fundraiser && c.body.catalog.fundraiser.text === "10% of every purchase supports Example Club");
  }

  // ============================================================================================================
  console.log("\n=== A database without 0110 ===");
  // ============================================================================================================
  {
    freshCacheApi();
    const old = await freshDb("0109");
    await addShop(old, "club", "Example Club");
    await L.publishShop(old, "club");
    const res = await L.catalogGet({ request: { url: shopOrigin("club") + "/api/catalog", headers: { get: () => null } }, env: { DB: old } });
    const body = JSON.parse(await res.text());
    ok("the shop page is answered, with no fundraiser key", res.status === 200 && body.status === "ok" && body.catalog.products.length === 1 && !("fundraiser" in body.catalog));
    freshCacheApi();
  }

  // ============================================================================================================
  console.log("\n=== The shop page (public/storefront.js) ===");
  // ============================================================================================================
  const shop = async (sub, answer) => {
    const vc = new VirtualConsole();
    vc.on("jsdomError", (e) => { if (!/Not implemented: navigation/.test(String(e && e.message))) console.error(e); });
    const dom = new JSDOM(storefrontPage({ adminCss: false }), { runScripts: "dangerously", url: shopOrigin(sub) + "/", pretendToBeVisual: true, virtualConsole: vc,
      beforeParse(win) {
        win.scrollTo = () => {}; win.alert = () => {};
        win.fetch = async (u) => {
          const body = String(u).startsWith("/api/catalog") ? answer : {};
          return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } };
        };
      } });
    const w = dom.window, d = w.document;
    await wait(() => !!d.querySelector(".org-hero"));
    return { w, d };
  };

  {
    const { d } = await shop("club", clubCatalog);
    const line = d.querySelector(".org-hero .fundraiser-line");
    ok("the catalog's line is shown in the shop's heading", !!line && line.textContent === "$1.50 of every item supports Example Club");
    ok("…as a <p class=\"desc fundraiser-line\">", !!line && line.tagName === "P" && line.classList.contains("desc"));
    const desc = d.querySelector(".org-hero p.desc:not(.fundraiser-line)");
    ok("…right under the shop's description", !!desc && desc.textContent === "Gear for the Example Club." && desc.nextElementSibling === line);
    ok("…once", d.querySelectorAll(".fundraiser-line").length === 1);
    ok("…and the shop's products are shown too", !!d.getElementById("price-tee"));
  }
  {
    const { d } = await shop("club", markupCatalog);
    const line = d.querySelector(".org-hero .fundraiser-line");
    ok("a label with markup is shown as text: the visitor reads it as typed", !!line && line.textContent === "10% of every purchase supports <b>Example</b> & Co");
    ok("…and no element is made from it", !!line && line.children.length === 0 && !d.querySelector(".org-hero b"));
  }
  {
    const { d } = await shop("club", { ...clubCatalog, catalog: (({ fundraiser, ...rest }) => rest)(clubCatalog.catalog) });
    ok("a catalog without the key: the heading has the description and no fundraiser line",
      !!d.querySelector(".org-hero p.desc") && !d.querySelector(".fundraiser-line") && !/supports/.test(d.querySelector(".org-hero").textContent));
  }
  {
    const { d } = await shop("boost", boostCatalog);
    ok("a shop not ready yet shows \"Catalog coming soon\"", /Catalog coming soon/.test(d.getElementById("app").textContent));
    ok("…and not the fundraiser line, though its catalog has one", !d.querySelector(".fundraiser-line") && !/supports Example Boosters/.test(d.body.textContent));
  }
  {
    // renderOrgPage called with each shape a catalog could hold.
    const { w, d } = await shop("club", clubCatalog);
    const app = d.getElementById("app");
    const org = { ...clubCatalog.catalog, orgId: "club" };
    const draw = (fundraiser, extra = {}) => { w.renderOrgPage(app, "club", { ...org, fundraiser, ...extra }); return app.querySelector(".fundraiser-line"); };
    ok("renderOrgPage: a text with spaces around it is shown trimmed", (draw({ text: "  $2.00 of every item supports Example Club  " }) || {}).textContent === "$2.00 of every item supports Example Club");
    ok("…an empty text or one of spaces only shows nothing", draw({ text: "" }) === null && draw({ text: "   " }) === null);
    ok("…a text that isn't a string shows nothing", draw({ text: 5 }) === null && draw({ text: null }) === null && draw({}) === null);
    ok("…no fundraiser (missing, null) shows nothing", draw(undefined) === null && draw(null) === null);
    ok("…a fundraiser given as a bare string shows nothing (only { text } is read)", draw("$2.00 of every item supports Example Club") === null);
    ok("…markup in the text is escaped", (() => { const l = draw({ text: "<img src=x onerror=alert(1)> Example Club" }); return !!l && l.textContent === "<img src=x onerror=alert(1)> Example Club" && !app.querySelector("img[onerror]"); })());
    ok("…a shop past its deadline that takes no more orders still shows the line in its heading",
      (draw({ text: "10% of every purchase supports Example Club" }, { orderDeadline: "2000-01-01", allowOrdersAfterDeadline: false }) || {}).textContent === "10% of every purchase supports Example Club" &&
      !app.querySelector("#catalogArea"));
    ok("…the coming-soon page shows nothing, even with a text", draw({ text: "10% of every purchase supports Example Club" }, { ready: false }) === null && /Catalog coming soon/.test(app.textContent));
    ok("…while a draft preview of a shop not ready yet shows it", (draw({ text: "10% of every purchase supports Example Club" }, { ready: false, preview: true }) || {}).textContent === "10% of every purchase supports Example Club");
  }
})().catch((e) => { console.error(e); process.exit(1); });
