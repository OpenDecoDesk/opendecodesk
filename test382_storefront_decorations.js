const fs = require("fs");
const { JSDOM, VirtualConsole } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");
const { storefrontPage } = require("./testlib/storefront-page");
const { shopOrigin, ROOT, ADMIN_ORIGIN } = require("./testlib/hosts.js");
const { ok } = require("./testlib/check");

// Decoration types (Global settings → Decoration types, phase 5) as a shop's visitors meet them:
//   functions/api/catalog.js — every answer (shop, admin, closed, unknown shop, unrecognized host) carries decorationTypes,
//     the enabled keys; left out when the cached meta entry predates the setting; a product carries its decorationType
//     only when set, and a decoration its type only when it has one; a switched-off type's decorations are left out.
//   public/storefront.js — applyDecorationTypes_ / decorationOn_ (an unknown list = every type on), decorationsHtml_ with
//     each made-label, "Name to embroider" only for an embroidered product, the custom-design hints and the soft-print
//     warning for each printed type, configurable pickers leaving out graphics of a switched-off type, the generic page's
//     wording, and escaping. The page is jsdom; its catalog is the REAL catalog.js on the REAL db.js on sql.js (a stub
//     answer only where a case needs a shape the server never sends).
// Invented data only.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");

global.fetch = async (url) => { throw new Error("unexpected fetch " + url); };
// getCatalogData, with a switch that makes the meta entry look as if it was cached before decorationTypes existed.
const catalogCacheSrc = strip(read("functions/_lib/catalogCache.js")).replace("async function getCatalogData(", "async function getCatalogDataReal_(") +
  "\nasync function getCatalogData(env, o){ const d = await getCatalogDataReal_(env, o); if(globalThis.__oldMeta){ const c = { ...d }; delete c.decorationTypes; return c; } return d; }\n";
const L = new Function(
  strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/db.js")) + "\n" +
  catalogCacheSrc + "\n" + strip(read("functions/api/catalog.js")) +
  "\nreturn { catalogGet: onRequestGet, createProduct, createGraphic, createTransfer, publishShop, setDecorationTypes, setFeatures, _resetCatalogCacheState, toClientProduct };")();

const pause = (ms) => new Promise(r => setTimeout(r, ms));
const wait = async (cond, n = 300) => { for (let i = 0; i < n && !cond(); i++) await pause(10); return !!cond(); };

let cacheStore;
function freshCacheApi() {
  cacheStore = new Map();
  global.caches = { default: {
    async match(key) { const hit = cacheStore.get(typeof key === "string" ? key : key.url); return hit ? hit.clone() : undefined; },
    async put(key, response) { cacheStore.set(typeof key === "string" ? key : key.url, response); },
  } };
  L._resetCatalogCacheState();
}

const ALL = ["embroidery", "dtf", "screenprint", "vinyl", "dtg", "sublimation"];
const MADE = { embroidery: "Embroidered", dtf: "Printed (DTF)", screenprint: "Screen printed", vinyl: "Vinyl", dtg: "DTG printed", sublimation: "Sublimated" };
const PRINTED = ["dtf", "screenprint", "vinyl", "dtg", "sublimation"];
const PRINTED_HINT = "Printed from your image — a sharp image about 3000 px across prints best at 10 inches.";
const PROOF_HINT = "A clear logo with solid colors works best — we'll email you a proof.";

async function freshDb() {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  return d1;
}

(async () => {
  freshCacheApi();
  const d1 = await freshDb();
  d1._raw.exec(`DELETE FROM locations; INSERT INTO locations (id, name, createdAt, updatedAt) VALUES (1, 'Front', 't', 't'), (2, 'Left chest', 't', 't');
    INSERT INTO orgs (orgId, subdomain, name, "desc", accent, createdAt, updatedAt, ready) VALUES ('club','club','Example Club','Gear.','#123456','t','t',1);`);
  const prod = (productId, extra = {}) => L.createProduct(d1, "club", { productId, type: "shirt", name: "Item " + productId, pricingMode: "flat", flatPrice: 20,
    visible: true, noDesignNeeded: true, reorderQr: "none", ...extra });
  const sheet = await L.createTransfer(d1, { name: "Sheet" });
  const mkTransfer = (name, decoration) => L.createGraphic(d1, "club", { name, kind: "transfer", transferId: sheet, tier: "small", inkColors: ["White"], decoration });
  d1._raw.exec(`INSERT INTO designs (orgId, name, createdAt, updatedAt) VALUES ('club', '<b>Club Crest</b>', 't', 't');`);
  const designId = d1.q("SELECT id FROM designs WHERE orgId='club'")[0].id;
  const gEmb = await L.createGraphic(d1, "club", { name: "Stitch Mark", kind: "embroidery", designId });
  const gDtf = await mkTransfer("DTF Mark", "dtf"), gSp = await mkTransfer("<i>SP Mark</i>", "screenprint"), gVinyl = await mkTransfer("Vinyl Mark", "vinyl"),
    gDtg = await mkTransfer("DTG Mark", "dtg"), gSub = await mkTransfer("Sub Mark", "sublimation");
  const gid = { dtf: gDtf, screenprint: gSp, vinyl: gVinyl, dtg: gDtg, sublimation: gSub };

  // What the product list says each product is decorated with: one printed graphic fixed on a product per type, an embroidered design.
  await prod("emb", { name: "Embroidered Polo", noDesignNeeded: false, personalizationPrice: 5 });
  d1._raw.exec(`INSERT INTO product_designs (orgId, productId, designId, placement, sortOrder, createdAt) VALUES ('club', 'emb', ${designId}, 'Left chest', 0, 't');`);
  for (const t of PRINTED) {
    await prod("fx-" + t, { name: "Fixed " + t });
    d1._raw.exec(`UPDATE products SET fixedTransfersJson='[{"locationId":1,"graphicId":${gid[t]},"ink":"White"}]' WHERE orgId='club' AND productId='fx-${t}'`);
  }
  // Personalization: each stored type, and none.
  await prod("pers-none", { name: "Plain Hat", personalizationPrice: 5 });
  await prod("pers-emb", { name: "Typed Hat", decorationType: "embroidery", personalizationPrice: 5 });
  for (const t of PRINTED) await prod("pers-" + t, { name: "Printed Hat " + t, decorationType: t, personalizationPrice: 5 });
  await prod("pers-opt-emb", { name: "Closure Cap", decorationType: "embroidery", personalizationPrice: 3, personalizationOptions: ["Snap", "Buckle"] });
  await prod("pers-opt-vinyl", { name: "Vinyl Cap", decorationType: "vinyl", personalizationPrice: 3, personalizationOptions: ["Snap", "Buckle"] });
  await prod("pers-evil", { name: "<img src=x onerror=alert(1)> Cap", personalizationPrice: 5 });
  await prod("no-pers", { name: "No Names Tee" });
  // The customer's own design, by decoration type and by custom kind.
  await prod("cd-none-emb", { customDesign: "embroidery" });
  await prod("cd-none-tr", { customDesign: "transfer" });
  await prod("cd-emb-emb", { decorationType: "embroidery", customDesign: "embroidery" });
  await prod("cd-emb-tr", { decorationType: "embroidery", customDesign: "transfer" });
  for (const t of PRINTED) await prod("cd-" + t, { decorationType: t, customDesign: "embroidery" });
  // A configurable product with a graphic of every type at each of two locations.
  await prod("rag", { name: "Raglan", configurable: true, garmentColors: ["Navy"],
    locations: [{ key: "front", label: "Front", graphicIds: [gEmb, gDtf, gSp, gVinyl, gDtg, gSub] }, { key: "back", label: "Back", graphicIds: [gSp, gDtf] }] });
  await prod("rag-sp", { name: "Screen Raglan", configurable: true, garmentColors: ["Navy"], decorationType: "screenprint", personalizationPrice: 4,
    locations: [{ key: "front", label: "Front", graphicIds: [gSp] }] });

  const setTypes = async (list) => { await L.setDecorationTypes(d1, list); freshCacheApi(); };
  const getAnswer = async (origin = shopOrigin("club"), env = { DB: d1 }, path = "/api/catalog") => {
    const res = await L.catalogGet({ request: { url: origin + path, headers: { get: () => null } }, env });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => { if (!/Not implemented: navigation/.test(String(e && e.message))) console.error(e); });
  // The shop page. `answer` = the page's /api/catalog answer, or by default the real one (host: whose subdomain).
  const uploads = [];
  const openPage = async ({ answer, host = shopOrigin("club"), ready = ".product", bitmap, uploadSize } = {}) => {
    uploads.length = 0;
    const seen = { answer: null };
    const dom = new JSDOM(storefrontPage({ adminCss: false }), { runScripts: "dangerously", url: host + "/", pretendToBeVisual: true, virtualConsole: vc,
      beforeParse(win) {
        win.scrollTo = () => {}; win.alert = () => {};
        win.URL.createObjectURL = () => "blob:" + host + "/u1"; win.URL.revokeObjectURL = () => {};
        win.createImageBitmap = async () => bitmap || { width: 2000, height: 2000, close() {} };
        win.fetch = async (u, init) => {
          const url = String(u);
          if (url.startsWith("/api/customer-design")) {
            uploads.push(url);
            const s = uploadSize || { width: 2000, height: 2000 };
            return { ok: true, status: 200, json: async () => ({ status: "ok", uploadId: "a".repeat(32), ...s }) };
          }
          if (!url.startsWith("/api/catalog")) return { ok: true, status: 200, json: async () => ({}), text: async () => "{}", headers: { get: () => null } };
          let status = 200, body = answer;
          if (!answer) { const r = await getAnswer(host); status = r.status; body = r.body; }
          seen.answer = body;
          const text = JSON.stringify(body);
          return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(text), text: async () => text, headers: { get: () => null } };
        };
      } });
    const w = dom.window, d = w.document;
    await wait(() => !!d.querySelector(ready));
    await pause(30);
    const card = (id) => { const el = d.getElementById("price-" + id); return el ? el.closest(".product") : null; };
    const decor = (id) => { const c = card(id); return c ? [...c.querySelectorAll(".product-decor li")].map(li => li.textContent.replace(/\s+/g, " ").trim()) : null; };
    const pers = (id) => !!d.getElementById("pers-" + id);
    const hint = (id, loc = "customdesign") => { const b = d.getElementById("cd-" + id + "-" + loc); return b ? b.querySelector(".cd-hint").textContent : null; };
    const options = (id, loc) => { const s = d.getElementById("loc-" + id + "-" + loc); return s ? [...s.options].map(o => o.textContent.replace(/ \(\+\$[\d.]+\)$/, "")) : null; };   // without the tier add-on
    const choose = async (id, loc = "customdesign") => {
      const input = d.getElementById("cd-" + id + "-" + loc).querySelector(".cd-file");
      Object.defineProperty(input, "files", { value: [new w.File([new Uint8Array(100)], "logo.png", { type: "image/png" })], configurable: true });
      input.dispatchEvent(new w.Event("change", { bubbles: true }));
      await wait(() => /Uploaded/.test(d.getElementById("cd-" + id + "-" + loc).querySelector(".cd-status").textContent));
      return d.getElementById("cd-" + id + "-" + loc).querySelector(".cd-status").textContent;
    };
    return { w, d, seen, card, decor, pers, hint, options, choose, state: () => w.eval("siteDecorations") };
  };

  // =========================================================================================================
  console.log("=== /api/catalog carries the decoration types ===");
  // =========================================================================================================
  await L.publishShop(d1, "club");
  await setTypes(["embroidery", "dtf"]);
  let a = await getAnswer();
  ok("a shop's answer lists the enabled types", a.status === 200 && JSON.stringify(a.body.decorationTypes) === JSON.stringify(["embroidery", "dtf"]));
  await setTypes(["dtg", "screenprint"]);
  a = await getAnswer();
  ok("…in the registry's order, as saved in Global settings", JSON.stringify(a.body.decorationTypes) === JSON.stringify(["screenprint", "dtg"]));
  await setTypes(ALL);
  a = await getAnswer();
  ok("with every type on, all six", JSON.stringify(a.body.decorationTypes) === JSON.stringify(ALL));
  ok("the answer is the shop's own (products came with it)", a.body.status === "ok" && a.body.catalog.products.length > 20);
  a = await getAnswer(ADMIN_ORIGIN);
  ok("the admin address's answer carries them too", a.body.status === "admin" && JSON.stringify(a.body.decorationTypes) === JSON.stringify(ALL));
  a = await getAnswer("https://" + ROOT);
  ok("the main address's answer (no shop here) carries them", a.status === 200 && a.body.status === "error" && a.body.message === "Unknown org" && JSON.stringify(a.body.decorationTypes) === JSON.stringify(ALL));
  a = await getAnswer("https://nobody." + ROOT);
  ok("an unrecognized address's answer (404) carries them", a.status === 404 && a.body.message === "Unrecognized host" && JSON.stringify(a.body.decorationTypes) === JSON.stringify(ALL));
  await L.setFeatures(d1, { storefront: false }); freshCacheApi();
  a = await getAnswer();
  ok("a switched-off storefront's \"closed\" answer carries them", a.body.status === "closed" && JSON.stringify(a.body.decorationTypes) === JSON.stringify(ALL));
  await L.setFeatures(d1, { storefront: true }); freshCacheApi();

  globalThis.__oldMeta = true;
  a = await getAnswer();
  ok("a meta entry cached before the setting: the key is left out, not sent as empty", a.body.status === "ok" && !("decorationTypes" in a.body));
  a = await getAnswer(ADMIN_ORIGIN);
  ok("…also from the admin address", a.body.status === "admin" && !("decorationTypes" in a.body));
  a = await getAnswer("https://" + ROOT);
  ok("…and the main address", a.body.message === "Unknown org" && !("decorationTypes" in a.body));
  a = await getAnswer("https://nobody." + ROOT);
  ok("…and an unrecognized address", a.status === 404 && !("decorationTypes" in a.body));
  await L.setFeatures(d1, { storefront: false }); freshCacheApi();
  a = await getAnswer();
  ok("…and the closed answer", a.body.status === "closed" && !("decorationTypes" in a.body));
  await L.setFeatures(d1, { storefront: true }); freshCacheApi();
  { const old = await openPage();
    ok("the page given no list treats every type as on", old.state() === null && ALL.every(k => old.w.decorationOn_(k))); old.w.close(); }
  globalThis.__oldMeta = false; freshCacheApi();

  console.log("\n=== A product's type and its decorations in the answer ===");
  a = await getAnswer();
  const P = (id) => a.body.catalog.products.find(p => p.id === id);
  ok("a product with a chosen type sends it", P("pers-dtg").decorationType === "dtg" && P("pers-emb").decorationType === "embroidery");
  ok("a product with no chosen type sends no decorationType key", !("decorationType" in P("pers-none")) && !("decorationType" in P("emb")));
  ok("a decoration the server lists is {kind, name, location, type}, with the type's made-label as its kind",
    JSON.stringify(P("fx-screenprint").decorations) === JSON.stringify([{ kind: "Screen printed", name: "<i>SP Mark</i>", location: "Front", type: "screenprint" }]));
  ok("…and the decoration's type (its key) is on every entry, so the page can filter switched-off types: embroidery, dtf, vinyl, dtg, sublimation",
    P("emb").decorations.length > 0 && P("emb").decorations.every(x => x.type === "embroidery") && P("fx-dtf").decorations.every(x => x.type === "dtf") && P("fx-vinyl").decorations.every(x => x.type === "vinyl") &&
    P("fx-dtg").decorations.every(x => x.type === "dtg") && P("fx-sublimation").decorations.every(x => x.type === "sublimation"));

  {
    const base = { productId: "x", type: "shirt", name: "X", sub: "", images: [], features: [], personalizationPrice: null, pricingMode: "flat", flatPrice: 1 };
    const out = L.toClientProduct({ ...base, decorationType: "vinyl", decorations: [{ kind: "Vinyl", name: "A", location: "Front", type: "vinyl" }, { kind: "Embroidered", name: "B" }, { kind: 3, name: "C", type: 9 }] });
    ok("toClientProduct keeps a decoration's type when it has one, as text", out.decorations[0].type === "vinyl" && out.decorations[2].type === "9");
    ok("…and no type key when it has none; the other fields as before", !("type" in out.decorations[1]) && JSON.stringify(out.decorations[1]) === JSON.stringify({ kind: "Embroidered", name: "B", location: "" }));
    ok("…the product's chosen type with it", out.decorationType === "vinyl" && !("decorationType" in L.toClientProduct({ ...base, decorationType: "" })));
  }

  // =========================================================================================================
  console.log("\n=== applyDecorationTypes_ and decorationOn_ ===");
  // =========================================================================================================
  {
    const { w, state } = await openPage();
    ok("a page loaded with a list keeps it", JSON.stringify(state()) === JSON.stringify(ALL));
    w.applyDecorationTypes_(["dtf"]);
    ok("a known list: only its types are on", w.decorationOn_("dtf") && !w.decorationOn_("embroidery") && !w.decorationOn_("vinyl") && !w.decorationOn_("screenprint"));
    ok("a type nobody has heard of is off while the list is known", !w.decorationOn_("laser"));
    w.applyDecorationTypes_(null);
    ok("no list (null): every type is on, so is any key", state() === null && w.decorationOn_("embroidery") && w.decorationOn_("laser"));
    w.applyDecorationTypes_(["vinyl"]); w.applyDecorationTypes_(undefined);
    ok("no list (undefined): every type on again", state() === null && w.decorationOn_("dtg"));
    w.applyDecorationTypes_(["vinyl"]); w.applyDecorationTypes_("vinyl");
    ok("a string is not a list: unknown, all on", state() === null && w.decorationOn_("dtf"));
    w.applyDecorationTypes_(["vinyl"]); w.applyDecorationTypes_({ 0: "vinyl" });
    ok("an object is not a list either", state() === null);
    w.applyDecorationTypes_([]);
    ok("an empty list is a list: nothing on", Array.isArray(state()) && state().length === 0 && !w.decorationOn_("embroidery") && !w.decorationOn_("dtf"));
    w.applyDecorationTypes_([7, "dtg"]);
    ok("entries are read as text", JSON.stringify(state()) === JSON.stringify(["7", "dtg"]) && w.decorationOn_("dtg") && w.decorationOn_(7));
    w.close();
  }
  {
    const { w, state } = await openPage({ host: shopOrigin("nobody"), ready: "h1" });
    ok("an unknown address's error answer applies its list too (not just a good one's)", JSON.stringify(state()) === JSON.stringify(ALL));
    w.close();
  }
  await setTypes(["embroidery", "vinyl"]);
  {
    const { w, state, d } = await openPage({ host: shopOrigin("nobody"), ready: "h1" });
    ok("…whatever it is at the time", JSON.stringify(state()) === JSON.stringify(["embroidery", "vinyl"]) && w.decorationOn_("vinyl") && !w.decorationOn_("dtf") && !!d.querySelector("h1"));
    w.close();
  }
  {
    const { w, state } = await openPage({ host: "https://" + ROOT, ready: ".org-hero" });
    ok("the main address's page (no shop) has the list as well", JSON.stringify(state()) === JSON.stringify(["embroidery", "vinyl"]));
    w.close();
  }
  { // an error answer with no list (an old meta entry)
    const { w, state } = await openPage({ answer: { status: "error", message: "Unknown org" }, ready: "h1" });
    ok("an error answer without a list leaves every type on", state() === null);
    w.close();
  }
  {
    const { w, state } = await openPage({ answer: { status: "closed", message: "Online ordering isn't available here.", features: { storefront: false }, decorationTypes: ["dtg"] }, ready: "h1" });
    ok("a \"closed\" answer's list is kept too", JSON.stringify(state()) === JSON.stringify(["dtg"]));
    w.close();
  }
  { // the failing read: a 5xx with a body
    const dom = new JSDOM(storefrontPage({ adminCss: false }), { runScripts: "dangerously", url: shopOrigin("club") + "/", pretendToBeVisual: true, virtualConsole: vc,
      beforeParse(win) {
        win.scrollTo = () => {};
        win.fetch = async () => ({ ok: false, status: 503, json: async () => ({ status: "error", message: "Catalog temporarily unavailable", decorationTypes: ["sublimation"] }), text: async () => "{}", headers: { get: () => null } });
      } });
    await pause(200);
    ok("even a passing server error's body gives the list (the retry page still knows the types)", JSON.stringify(dom.window.eval("siteDecorations")) === JSON.stringify(["sublimation"]));
    dom.window.close();
  }

  // =========================================================================================================
  console.log("\n=== The decorations listed on a product, with each made-label ===");
  // =========================================================================================================
  await setTypes(ALL);
  {
    const { d, decor, w } = await openPage();
    ok("an embroidered design: \"Embroidered: <name> — <placement>\"", JSON.stringify(decor("emb")) === JSON.stringify(["Embroidered: <b>Club Crest</b> — Left chest"]));
    ok("…the list is labelled \"Decoration\" for readers", d.querySelector("#price-emb").closest(".product").querySelector("ul.product-decor").getAttribute("aria-label") === "Decoration");
    ok("a DTF transfer: \"Printed (DTF)\"", decor("fx-dtf")[0] === "Printed (DTF): DTF Mark — Front");
    ok("screen print: \"Screen printed\" (the name's markup is shown as text)", decor("fx-screenprint")[0] === "Screen printed: <i>SP Mark</i> — Front");
    ok("vinyl: \"Vinyl\"", decor("fx-vinyl")[0] === "Vinyl: Vinyl Mark — Front");
    ok("DTG: \"DTG printed\"", decor("fx-dtg")[0] === "DTG printed: DTG Mark — Front");
    ok("sublimation: \"Sublimated\"", decor("fx-sublimation")[0] === "Sublimated: Sub Mark — Front");
    ok("a product with nothing to list shows no decoration list", decor("no-pers").length === 0 && !d.querySelector("#price-no-pers").closest(".product").querySelector(".product-decor"));
    ok("nothing was injected by names (the markup stayed text)", !d.querySelector(".product-decor b") && !d.querySelector(".product-decor i"));
    w.close();
  }
  await setTypes(["embroidery", "dtf"]);
  {
    const { decor, w } = await openPage();
    ok("types switched off in Global settings: the server leaves out their decorations (vinyl, screen print, DTG, sublimation)",
      decor("fx-vinyl").length === 0 && decor("fx-screenprint").length === 0 && decor("fx-dtg").length === 0 && decor("fx-sublimation").length === 0);
    ok("…those still on keep theirs", decor("fx-dtf").length === 1 && decor("emb").length === 1);
    w.close();
  }
  await setTypes(["screenprint"]);
  {
    const { decor, w } = await openPage();
    ok("only screen print on: its decoration is listed, embroidery and DTF are not", decor("fx-screenprint").length === 1 && decor("fx-dtf").length === 0 && decor("emb").length === 0);
    w.close();
  }
  await setTypes(ALL);

  console.log("\n=== decorationsHtml_ on answers with a type on each decoration ===");
  {
    const { w } = await openPage();
    const html = (list) => w.decorationsHtml_({ decorations: list });
    const lis = (list) => { const t = w.document.createElement("div"); t.innerHTML = html(list); return [...t.querySelectorAll("li")].map(li => li.textContent.replace(/\s+/g, " ").trim()); };
    ok("each type's made-label replaces the kind the server wrote",
      JSON.stringify(lis(ALL.map(t => ({ kind: "Old kind", name: "N " + t, location: "L", type: t })))) === JSON.stringify(ALL.map(t => MADE[t] + ": N " + t + " — L")));
    w.applyDecorationTypes_(null);
    ok("a type with no label of its own (when the types aren't known) falls back to the kind", JSON.stringify(lis([{ kind: "Laser etched", name: "Crest", location: "", type: "laser" }])) === JSON.stringify(["Laser etched: Crest"]));
    w.applyDecorationTypes_(ALL);
    ok("…a type the list doesn't have is not listed", lis([{ kind: "Laser etched", name: "Crest", location: "", type: "laser" }]).length === 0);
    ok("no type: the kind (an older answer)", JSON.stringify(lis([{ kind: "Embroidered", name: "Crest", location: "Back" }])) === JSON.stringify(["Embroidered: Crest — Back"]));
    ok("no type and no kind: \"Decorated\"", JSON.stringify(lis([{ name: "Crest" }])) === JSON.stringify(["Decorated: Crest"]));
    ok("no list at all or an empty one: nothing drawn", w.decorationsHtml_({}) === "" && w.decorationsHtml_(null) === "" && html([]) === "");
    w.applyDecorationTypes_(["dtf"]);
    ok("a decoration whose type is switched off since the page loaded is not listed",
      JSON.stringify(lis([{ kind: "x", name: "A", location: "", type: "vinyl" }, { kind: "x", name: "B", location: "", type: "dtf" }, { kind: "Embroidered", name: "C", location: "" }])) === JSON.stringify(["Printed (DTF): B", "Embroidered: C"]));
    ok("…all switched off: no list", html([{ kind: "x", name: "A", location: "", type: "vinyl" }]) === "");
    w.applyDecorationTypes_(null);
    ok("with no list known, a typed decoration is listed", lis([{ kind: "x", name: "A", location: "", type: "vinyl" }]).join() === "Vinyl: A");
    const evil = lis([{ kind: "<u>k</u>", name: "<s>n</s>", location: "<em>l</em>" }]);
    const probe = w.document.createElement("div"); probe.innerHTML = html([{ kind: "<u>k</u>", name: "<s>n</s>", location: "<em>l</em>" }]);
    ok("kind, name and location are escaped", evil[0] === "<u>k</u>: <s>n</s> — <em>l</em>" && !probe.querySelector("u, s, em"));
    w.close();
  }

  // =========================================================================================================
  console.log("\n=== Personalization (\"Name to embroider\") only for an embroidered product ===");
  // =========================================================================================================
  {
    const { d, pers, w } = await openPage();
    ok("embroidery on: a product with a design (no stored type) offers it", pers("emb"));
    ok("a product with no stored type is worked out as before: any product may be embroidered", pers("pers-none") && pers("pers-evil"));
    ok("a product stored as embroidery offers it", pers("pers-emb"));
    ok("…the box says what it is for", d.getElementById("pers-name-pers-emb").getAttribute("placeholder") === "Name to embroider" &&
      d.getElementById("pers-name-pers-emb").getAttribute("aria-label") === "Name to embroider on Typed Hat");
    ok("…with its price", /Add personalization \(\+\$5\.00\)/.test(d.getElementById("pers-pers-emb").closest("label").textContent));
    for (const t of PRINTED) ok("a " + t + " product is never offered a name to embroider", !pers("pers-" + t) && !d.getElementById("pers-name-pers-" + t));
    ok("a product that sets no price offers none", !pers("no-pers"));
    const sel = d.getElementById("pers-name-pers-opt-emb");
    ok("an embroidered product with a word list gets the dropdown", !!sel && sel.tagName === "SELECT" && [...sel.options].map(o => o.value).join("|") === "|Snap|Buckle");
    ok("…the same list on a vinyl product is not offered at all", !d.getElementById("pers-pers-opt-vinyl") && !d.getElementById("pers-name-pers-opt-vinyl"));
    ok("a configurable product made with screen print offers no name either", !pers("rag-sp"));
    ok("a name in the product's name is escaped in the box's label", d.getElementById("pers-name-pers-evil").getAttribute("aria-label") === "Name to embroider on <img src=x onerror=alert(1)> Cap" && !d.querySelector("img[src='x']"));
    w.close();
  }
  await setTypes(["dtf", "screenprint"]);
  {
    const { pers, w } = await openPage();
    ok("embroidery switched off: no product offers a name, whatever its stored type", !pers("pers-none") && !pers("pers-emb") && !pers("pers-evil") && !pers("pers-opt-emb"));
    w.close();
  }
  await setTypes(["embroidery"]);
  {
    const { pers, w } = await openPage();
    ok("embroidery the only type: names still offered for embroidered and unset products, not for a stored DTF one", pers("pers-emb") && pers("pers-none") && !pers("pers-dtf"));
    w.close();
  }
  await setTypes(ALL);
  {
    const { w } = await openPage();
    ok("productEmbroidered_: no product at all is not embroidered-checked as one (unset)", w.productEmbroidered_({}) === true && w.productEmbroidered_(null) === true);
    ok("…a stored embroidery one is", w.productEmbroidered_({ decorationType: "embroidery" }) === true);
    ok("…any other stored type is not", ["dtf", "screenprint", "vinyl", "dtg", "sublimation"].every(t => w.productEmbroidered_({ decorationType: t }) === false));
    w.applyDecorationTypes_(["dtg"]);
    ok("…and with embroidery off, none is (even unset)", w.productEmbroidered_({}) === false && w.productEmbroidered_({ decorationType: "embroidery" }) === false);
    w.close();
  }

  // =========================================================================================================
  console.log("\n=== The custom-design hints, by type ===");
  // =========================================================================================================
  {
    const { hint, w } = await openPage();
    ok("an embroidery product taking the customer's logo: the proof hint", hint("cd-emb-emb") === PROOF_HINT);
    ok("a product with no stored type and an embroidery design box: the proof hint", hint("cd-none-emb") === PROOF_HINT);
    ok("a transfer design box with no stored type: the printed hint (as before)", hint("cd-none-tr") === PRINTED_HINT);
    ok("an embroidery-typed product whose design box is a transfer one: printed", hint("cd-emb-tr") === PRINTED_HINT);
    for (const t of PRINTED) ok("a " + t + " product says \"printed\" even with an embroidery-kind box", hint("cd-" + t) === PRINTED_HINT);
    ok("printedDecoration_: nothing stored and no transfer box is not printed", w.printedDecoration_({}) === false && w.printedDecoration_(null) === false && w.printedDecoration_({ customDesign: { kind: "embroidery" } }) === false);
    ok("…a stored embroidery type is not", w.printedDecoration_({ decorationType: "embroidery" }) === false);
    ok("…any other stored type is", PRINTED.every(t => w.printedDecoration_({ decorationType: t }) === true));
    ok("…and a transfer box makes it printed whatever the type", w.printedDecoration_({ customDesign: { kind: "transfer" } }) === true && w.printedDecoration_({ decorationType: "embroidery", customDesign: { kind: "transfer" } }) === true);
    w.close();
  }
  {
    const p = await openPage({ uploadSize: { width: 1000, height: 900 } });
    for (const t of PRINTED) ok("a small image (1000 px) on a " + t + " product warns it may print soft", /may print soft — about 3000 px is best for a 10-inch print\./.test(await p.choose("cd-" + t)));
    ok("…the same size on an embroidery product has no warning", !/print soft/.test(await p.choose("cd-emb-emb")) && !/print soft/.test(await p.choose("cd-none-emb")));
    ok("…on a transfer box it warns", /may print soft/.test(await p.choose("cd-none-tr")) && /may print soft/.test(await p.choose("cd-emb-tr")));
    ok("the warning shows in the warning style", p.d.getElementById("cd-cd-dtg-customdesign").querySelector(".cd-status").className === "cd-status cd-warn");
    p.w.close();
  }
  {
    const p = await openPage({ uploadSize: { width: 3000, height: 2000 } });
    ok("a big enough image (3000 px) on a printed product has no warning", (await p.choose("cd-vinyl")) === "Uploaded: logo.png (3000 × 2000 px)");
    p.w.close();
  }
  {
    const p = await openPage({ uploadSize: { width: 1500, height: 100 } });
    ok("exactly 1500 px on the long side is not soft", (await p.choose("cd-dtg")) === "Uploaded: logo.png (1500 × 100 px)");
    p.w.close();
  }

  // =========================================================================================================
  console.log("\n=== Configurable products leave out graphics of a switched-off type ===");
  // =========================================================================================================
  a = await getAnswer();
  ok("the graphics in the answer carry their decoration type", JSON.stringify(a.body.catalog.graphics.map(g => g.decoration).sort()) === JSON.stringify(["dtf", "dtg", "embroidery", "screenprint", "sublimation", "vinyl"]));
  {
    const { options, w } = await openPage();
    ok("every type on: every graphic is offered at the front", JSON.stringify(options("rag", "front")) === JSON.stringify(["None", "Stitch Mark", "DTF Mark", "<i>SP Mark</i>", "Vinyl Mark", "DTG Mark", "Sub Mark"]));
    ok("…and at the back", JSON.stringify(options("rag", "back")) === JSON.stringify(["None", "<i>SP Mark</i>", "DTF Mark"]));
    w.close();
  }
  await setTypes(["embroidery", "dtf"]);
  {
    const { options, w, d } = await openPage();
    ok("embroidery and DTF on: only those graphics at the front", JSON.stringify(options("rag", "front")) === JSON.stringify(["None", "Stitch Mark", "DTF Mark"]));
    ok("…and the back keeps just its DTF one", JSON.stringify(options("rag", "back")) === JSON.stringify(["None", "DTF Mark"]));
    ok("the names are escaped in the pick list (no markup made)", !d.querySelector("#loc-rag-front i"));
    w.close();
  }
  await setTypes(["screenprint"]);
  {
    const { options, w } = await openPage();
    ok("screen print alone: just its graphic", JSON.stringify(options("rag", "front")) === JSON.stringify(["None", "<i>SP Mark</i>"]) && JSON.stringify(options("rag", "back")) === JSON.stringify(["None", "<i>SP Mark</i>"]));
    ok("…a product with its one location is preselected with it, no None", JSON.stringify(options("rag-sp", "front")) === JSON.stringify(["<i>SP Mark</i>"]));
    w.close();
  }
  await setTypes(["vinyl"]);
  {
    const p = await openPage(); const { options, w } = p;
    ok("a location whose graphics are all switched off has only None", JSON.stringify(options("rag", "back")) === JSON.stringify(["None"]));
    ok("…a one-location product with nothing left offers only None (and cannot be added yet)", JSON.stringify(options("rag-sp", "front")) === JSON.stringify(["None"]) && p.d.getElementById("cadd-rag-sp").disabled);
    w.close();
  }
  await setTypes(ALL);
  { // cfgOptionsForLocation_ with answers the server never sends
    const { w } = await openPage();
    const org = { graphics: [{ id: 1, name: "Old", kind: "transfer" }, { id: 2, name: "Typed", kind: "transfer", decoration: "vinyl" }, { id: 3, name: "Gone", kind: "transfer", decoration: "dtg" }] };
    const names = () => w.cfgOptionsForLocation_({}, org, { key: "front", graphicIds: [1, 2, 3] }, "").map(g => g.name).join();
    ok("a graphic with no decoration (an older answer) is always offered", w.applyDecorationTypes_(["dtf"]) === undefined && names() === "Old");
    w.applyDecorationTypes_(["dtf", "vinyl"]);
    ok("a graphic of an on type is offered", names() === "Old,Typed");
    w.applyDecorationTypes_(null);
    ok("with no list known every graphic is offered", names() === "Old,Typed,Gone");
    w.close();
  }

  // =========================================================================================================
  console.log("\n=== A page with no list in its answer (older catalog) ===");
  // =========================================================================================================
  {
    const base = await getAnswer();
    const stub = JSON.parse(JSON.stringify(base.body)); delete stub.decorationTypes;
    stub.catalog.products = stub.catalog.products.filter(p => ["rag", "pers-dtg", "pers-none", "fx-vinyl", "cd-dtg"].includes(p.id));
    stub.catalog.products.find(p => p.id === "fx-vinyl").decorations = [{ kind: "Vinyl", name: "Old Mark", location: "Front", type: "vinyl" }];
    stub.catalog.graphics.forEach(g => { delete g.decoration; });
    const { d, options, decor, pers, w, state } = await openPage({ answer: stub });
    ok("no list: every type counts as on", state() === null);
    ok("…every typed decoration is listed", JSON.stringify(decor("fx-vinyl")) === JSON.stringify(["Vinyl: Old Mark — Front"]));
    ok("…every graphic is offered (none says what it is)", options("rag", "front").length === 7);
    ok("…names follow the product's stored type only", !pers("pers-dtg") && pers("pers-none") && !!d.getElementById("cd-cd-dtg-customdesign"));
    w.close();
  }
  {
    const base = await getAnswer();
    const stub = JSON.parse(JSON.stringify(base.body)); stub.decorationTypes = ["dtf"];
    stub.catalog.products = stub.catalog.products.filter(p => ["fx-vinyl", "fx-dtf"].includes(p.id));
    stub.catalog.products.find(p => p.id === "fx-vinyl").decorations = [{ kind: "Vinyl", name: "Old Mark", location: "Front", type: "vinyl" }];
    stub.catalog.products.find(p => p.id === "fx-dtf").decorations = [{ kind: "Printed (DTF)", name: "Kept Mark", location: "Front", type: "dtf" }, { kind: "Embroidered", name: "Typeless Mark", location: "" }];
    const { decor, w } = await openPage({ answer: stub });
    ok("a page loaded before a switch: a typed decoration of a now-off type is left out, the rest stay",
      decor("fx-vinyl").length === 0 && JSON.stringify(decor("fx-dtf")) === JSON.stringify(["Printed (DTF): Kept Mark — Front", "Embroidered: Typeless Mark"]));
    w.close();
  }

  // =========================================================================================================
  console.log("\n=== The generic page (no shop at the address) says \"custom apparel\" ===");
  // =========================================================================================================
  {
    const { d, w } = await openPage({ host: "https://" + ROOT, ready: ".org-hero" });
    ok("the eyebrow and the default line no longer say embroidery or heat transfer",
      d.querySelector(".org-eyebrow-lg").textContent === "Custom apparel" && d.querySelector(".org-hero .desc").textContent === "Custom decorated apparel for organizations, teams, and businesses.");
    w.close();
  }
  {
    const stub = { status: "error", message: "Unknown org", business: { name: "Example Club", tagline: "Our <b>own</b> words" }, country: "US", features: {} };
    const { d, w } = await openPage({ answer: stub, host: "https://" + ROOT, ready: ".org-hero" });
    ok("a business's own tagline replaces the default, escaped", d.querySelector(".org-hero .desc").textContent === "Our <b>own</b> words" && !d.querySelector(".org-hero .desc b"));
    w.close();
  }
  {
    const html = fs.readFileSync(__dirname + "/public/index.html", "utf8");
    ok("the page's meta descriptions say \"decorated apparel\", not embroidered", !/embroidered/i.test(html.match(/<meta name="description"[^>]*>/)[0]) && /Order custom decorated apparel/.test(html.match(/<meta property="og:description"[^>]*>/)[0]));
  }
})().catch((e) => { console.error(e); process.exit(1); });
