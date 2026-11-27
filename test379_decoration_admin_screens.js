const fs = require("fs");
const { storefrontPage } = require("./testlib/storefront-page");
const { createD1 } = require("./testlib/d1-shim.js");
const { ok, counts } = require("./testlib/check");
const roles = require("./testlib/roles");
const { JSDOM, ResourceLoader, VirtualConsole } = require("jsdom");

// Phase 5: the admin screens that follow the decoration types (migrations/0118), in jsdom with the real orders.js / db.js
// on sql.js behind fetch:
//   Global settings -> Decoration types: the six ticks from the registry, each ticked type's price fields (in dollars), a
//   closed panel keeping what is in it, "tick at least one" and a bad price refused before anything is sent, the one save
//   (saveGlobalSettingsAll, settings.decoration, in cents), the page's list and the menu following at once, a section that
//   could not be read being neither drawn nor sent, and a read-only role sending none;
//   the menu: Transfers only with DTF on, Machines / Maintenance / Machine files / Hoops / Threads / Abort reasons only with
//   embroidery on, and those pages still opening by their address (Transfers says DTF is off);
//   the product form: the Decoration select (what is on, the current one marked when switched off), the embroidery-only and
//   printed-only blocks hidden while that type is off and unused (never when used) and back when it comes on, the suggested
//   decoration price helper (stitch count with "Use this", a printed type's colours / locations / reorder), and what the
//   Decoration choice saves;
//   the new-product wizard offering only the enabled types ("Both" only when embroidery and DTF are both on);
//   Graphics: the "Printed by" select and the Kind labels in the list; Vendors: "Digitizes designs" ticked and saved and
//   shown in the list; Pricing analysis: the decoration cost named for its type.
// The page signs in as a built-in role (testlib/roles.js asRole) and the server answers as one. Invented data only.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async (env, host, key, request, msg, need) => roleAllows(DEFAULT_ROLES[globalThis.__role379] || null, need) ? null : jsonResponse({ status: 'error', message: 'Your role can\\'t do that here.' }, 403);\n" +
  "const adminActor = () => 'owner@example.test';\n" + roles.adminAs({ roleFrom: "globalThis.__role379" }) + "\n" + strip(read("functions/_lib/permissions.js")) + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false;\n" +
  "const sendInvoiceEmail = async () => false, sendEstimateEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const pause = (ms) => new Promise(r => setTimeout(r, ms));
const wait = async (cond, n = 500) => { for (let i = 0; i < n && !cond(); i++) await pause(10); return !!cond(); };
process.on("unhandledRejection", (e) => { console.error(e); ok("nothing in the test was left to fail unseen", false); });

(async () => {
  globalThis.__role379 = "admin";
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const call = async (body) => {
    const waits = [];
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => waits.push(Promise.resolve(p).catch(() => {})),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    await Promise.all(waits);
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const must = async (body) => { const r = await call(body); if (r.status !== 200) throw new Error("seed " + body.action + ": " + JSON.stringify(r.body)); return r.body; };
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('club','club','Example Club','t','t');`);

  const adminJs = read("public/admin.js");
  const sent = [], toasts = [];
  let scripted = [];       // [{ action, status, body }]: the next request for that action is answered with this
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
  class Loader extends ResourceLoader {
    fetch(url) { if (/\/admin\.js(\?|$)/.test(url)) return Promise.resolve(Buffer.from(adminJs)); return Promise.resolve(Buffer.from("")); }
  }
  const vc = new VirtualConsole();
  vc.sendTo(console, { omitJSDOMErrors: true });
  vc.on("jsdomError", (e) => { if (!/Not implemented/.test(e.message)) console.error(e); });
  let inflight = 0;
  const dom = new JSDOM(storefrontPage(), { runScripts: "dangerously", resources: new Loader(), virtualConsole: vc, url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win) {
      win.CSS = win.CSS || { escape: (s) => String(s).replace(/["\\]/g, "\\$&") };
      win.scrollTo = () => {};
      win.fetch = async (url, init) => {
        const u = String(url), b = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
        if (!u.includes("/api/orders")) return reply(404, { status: "error", message: "not here" });
        sent.push(JSON.parse(JSON.stringify(b))); inflight++;
        try {
          const i = scripted.findIndex(s => s.action === b.action);
          if (i >= 0) { const s = scripted.splice(i, 1)[0]; return reply(s.status || 200, s.body); }
          const x = await call(b);
          return reply(x.status, x.body);
        } finally { inflight--; }
      };
    } });
  const w = dom.window, d = w.document;
  await pause(150);
  await w.loadAdminScript();
  w.showToast = (m, isErr) => toasts.push({ m: String(m), err: !!isErr });
  w.eval('adminKey = "cookie"; setAdminTimeZone_("UTC");');
  w.eval("adminOrgs = " + JSON.stringify([{ orgId: "club", name: "Example Club" }]) + ";");
  const q = (s) => d.querySelector(s), qa = (s) => [...d.querySelectorAll(s)];
  const id = (s) => d.getElementById(s);
  const app = id("app");
  const text = (el) => el ? el.textContent.replace(/\s+/g, " ").trim() : "";
  const idle = async () => { for (let calm = 0, i = 0; calm < 3 && i < 500; i++) { await pause(10); calm = inflight === 0 ? calm + 1 : 0; } };
  const of = (action) => sent.filter(b => b.action === action).map(b => { const c = Object.assign({}, b); delete c.key; return c; });
  const reset = () => { sent.length = 0; toasts.length = 0; };
  const fire = (el, type) => el.dispatchEvent(new w.Event(type, { bubbles: true }));
  const type = (el, v) => { el.value = v; fire(el, "input"); };
  const pick = (el, v) => { el.value = v; fire(el, "change"); };
  const tick = (el, v) => { el.checked = v; fire(el, "change"); };
  const asRoles = (pageRole, serverRole) => { globalThis.__role379 = serverRole || pageRole; w.eval(roles.asRole(pageRole, { name: "Tester", email: "tester@example.test" })); };
  const modal = () => { const all = qa(".admin-modal"); return all[all.length - 1] || null; };
  const KEYS = ["embroidery", "dtf", "screenprint", "vinyl", "dtg", "sublimation"];
  const ticked = () => qa("#gDecoration .gDecoType").filter(b => b.checked).map(b => b.dataset.feature);
  const dco = (t, k) => id("gDeco-" + t + "-" + k);
  const panelOpen = (t) => !!id("gPanel-" + t) && !id("gPanel-" + t).hidden;
  const navHashes = () => [...new Set(qa("#adminNav .admin-nav-menu button[data-h]").map(b => b.dataset.h))];
  const serverDeco = async () => must({ action: "getDecorationSettings" });
  // The server's list and prices set directly, then the page told (a forced read).
  const setDeco = async (types, pricing) => { await must({ action: "updateDecorationSettings", types, pricing }); await w.loadDecorationTypes_(true); };
  const optionsOf = (sel) => [...sel.options].map(o => [o.value, text(o)]);
  asRoles("admin");
  w.renderAdminNav();

  // ==============================================================================================================
  console.log("=== Global settings -> Decoration types: what the form shows ===");
  await w.renderGlobalSettings(app); await idle();
  ok("the section is on the page, with a heading", !!id("gDecoration") && qa("#adminPanel h2, #app h2").some(h => text(h) === "Decoration types"));
  ok("six ticks, in the registry's order, named by it", same(qa("#gDecoration .gDecoType").map(b => b.dataset.feature), KEYS) &&
    same(qa("#gDecoration .g-feat-head strong").map(e => text(e)), ["Embroidery", "DTF transfer", "Screen print", "Vinyl / heat transfer", "DTG", "Sublimation"]));
  ok("a new install has embroidery and DTF ticked, and only those", same(ticked(), ["embroidery", "dtf"]));
  ok("each type says in words what it is", qa("#gDecoration .g-feat-desc").length === 6 && /Stitched designs on a machine/.test(text(q("#gFeatRow-embroidery .g-feat-desc"))) && /one screen per colour/.test(text(q("#gFeatRow-screenprint .g-feat-desc"))));
  ok("only a ticked type's prices are open", panelOpen("embroidery") && panelOpen("dtf") && !panelOpen("screenprint") && !panelOpen("vinyl") && !panelOpen("dtg") && !panelOpen("sublimation"));
  ok("embroidery has Price by stitch count, per 1,000 stitches, minimum stitches and minimum price", !!dco("embroidery", "stitchPricing") && dco("embroidery", "stitchPricing").type === "checkbox" &&
    ["centsPer1000", "minStitches", "minCents"].every(k => !!dco("embroidery", k)) && /Price per 1,000 stitches \(\$\)/.test(text(dco("embroidery", "centsPer1000").parentNode)));
  ok("screen print has ink colour, screen setup, reorder setup, cost and most colours (6 until changed)", ["inkColorCents", "screenSetupCents", "reorderSetupCents", "costCents", "maxColors"].every(k => !!dco("screenprint", k)) &&
    dco("screenprint", "maxColors").value === "6" && dco("screenprint", "maxColors").min === "1" && dco("screenprint", "maxColors").max === "12");
  ok("DTF, vinyl, DTG and sublimation each have a cost, a price and a setup fee per location", ["dtf", "vinyl", "dtg", "sublimation"].every(t => ["costCents", "priceCents", "setupCents"].every(k => !!dco(t, k))));
  ok("money fields are in dollars with cents, nothing set yet reads 0.00", dco("vinyl", "priceCents").value === "0.00" && dco("vinyl", "priceCents").step === "0.01" && dco("embroidery", "minStitches").step === "1");
  tick(q('#gDecoration .gDecoType[data-feature="screenprint"]'), true);
  ok("ticking a type opens its prices", panelOpen("screenprint"));
  type(dco("screenprint", "inkColorCents"), "1.75");
  tick(q('#gDecoration .gDecoType[data-feature="screenprint"]'), false);
  ok("unticking closes them…", !panelOpen("screenprint"));
  ok("…and keeps what was in them", dco("screenprint", "inkColorCents").value === "1.75");

  console.log("\n=== Decoration types refused before anything is sent ===");
  reset();
  for (const k of KEYS) tick(q('#gDecoration .gDecoType[data-feature="' + k + '"]'), false);
  await w.submitGlobalSettings(); await idle();
  ok("unticking every type is refused on the page, in words", /Decoration types: tick at least one decoration type/.test(text(id("globalSettingsError"))));
  ok("…with the same words in a toast", toasts.some(t => t.err && /tick at least one decoration type/.test(t.m)));
  ok("…and the first tick outlined for the person to find", !!id("gDecoFirstBox") && id("gDecoFirstBox").dataset.feature === "embroidery" && /b03a2e|176, ?58, ?46/i.test(id("gDecoFirstBox").style.outline || ""));
  ok("…nothing was sent to the server", of("saveGlobalSettingsAll").length === 0);
  ok("…and the server still has what it had", same((await serverDeco()).types, ["embroidery", "dtf"]));
  for (const k of ["embroidery", "dtf"]) tick(q('#gDecoration .gDecoType[data-feature="' + k + '"]'), true);

  const refusedWith = async (what) => { reset(); await w.submitGlobalSettings(); await idle(); const e = text(id("globalSettingsError")); return { text: e, sent: of("saveGlobalSettingsAll").length, hit: what }; };
  tick(q('#gDecoration .gDecoType[data-feature="vinyl"]'), true);
  type(dco("vinyl", "priceCents"), "-1");
  let r = await refusedWith();
  ok("a negative price on a ticked type is refused, naming the type and the field", /Decoration types: Vinyl \/ heat transfer . Price per location needs a number, 0 or more/.test(r.text) && r.sent === 0);
  ok("…the box is outlined", /b03a2e|176, ?58, ?46/i.test(dco("vinyl", "priceCents").style.outline || ""));
  type(dco("vinyl", "priceCents"), "3.25");
  type(dco("embroidery", "minStitches"), "1.5");
  r = await refusedWith();
  ok("a whole-number field with a fraction is refused", /Embroidery . Minimum stitches billed needs a number/.test(r.text) && r.sent === 0);
  type(dco("embroidery", "minStitches"), "0");
  tick(q('#gDecoration .gDecoType[data-feature="screenprint"]'), true);
  type(dco("screenprint", "maxColors"), "13");
  r = await refusedWith();
  ok("Most colours above 12 is refused", /Screen print . Most colours needs a number/.test(r.text) && r.sent === 0);
  type(dco("screenprint", "maxColors"), "0");
  r = await refusedWith();
  ok("…and below 1", /Screen print . Most colours needs a number/.test(r.text) && r.sent === 0);
  type(dco("embroidery", "centsPer1000"), "99999999999");
  type(dco("screenprint", "maxColors"), "6");
  r = await refusedWith();
  ok("an enormous price is refused", /Embroidery . Price per 1,000 stitches needs a number/.test(r.text) && r.sent === 0);
  type(dco("embroidery", "centsPer1000"), "0");
  type(dco("vinyl", "costCents"), "abc");
  ok("a box can't hold text (it reads as empty, so as 0)", dco("vinyl", "costCents").value === "");
  type(dco("embroidery", "minCents"), "-2"); type(dco("vinyl", "setupCents"), "-3");
  r = await refusedWith();
  ok("two bad prices are both named", /Embroidery . Minimum price per piece/.test(r.text) && /Vinyl \/ heat transfer . Setup fee/.test(r.text) && / need a number/.test(r.text) && r.sent === 0);
  type(dco("embroidery", "minCents"), "0"); type(dco("vinyl", "setupCents"), "0");
  tick(q('#gDecoration .gDecoType[data-feature="sublimation"]'), false);
  type(dco("sublimation", "priceCents"), "-5");
  tick(q('#gDecoration .gDecoType[data-feature="vinyl"]'), false);
  type(dco("vinyl", "priceCents"), "-5");
  tick(q('#gDecoration .gDecoType[data-feature="screenprint"]'), false);
  r = await refusedWith();
  ok("a bad figure in an unticked type's closed panel doesn't stop the save (the shop isn't using it)", r.sent === 1 && !/Decoration types/.test(r.text));
  ok("…and it is saved as 0, not as the bad figure", of("saveGlobalSettingsAll")[0].settings.decoration.pricing.vinyl.priceCents === 0 && of("saveGlobalSettingsAll")[0].settings.decoration.pricing.sublimation.priceCents === 0);

  console.log("\n=== Save: dollars typed, cents sent, the page and the menu follow at once ===");
  const hashesBefore = navHashes();
  ok("with DTF and embroidery on, the menu has Transfers and the embroidery pages", ["transfers", "machines", "maintenance", "machinefiles", "hoops", "threads", "abortreasons"].every(h => hashesBefore.includes(h)));
  await w.renderGlobalSettings(app); await idle();
  tick(q('#gDecoration .gDecoType[data-feature="dtf"]'), false);
  for (const k of ["screenprint", "vinyl"]) tick(q('#gDecoration .gDecoType[data-feature="' + k + '"]'), true);
  tick(dco("embroidery", "stitchPricing"), true);
  type(dco("embroidery", "centsPer1000"), "1.00"); type(dco("embroidery", "minStitches"), "4000"); type(dco("embroidery", "minCents"), "2.50");
  type(dco("screenprint", "inkColorCents"), "1.50"); type(dco("screenprint", "screenSetupCents"), "20"); type(dco("screenprint", "reorderSetupCents"), "10");
  type(dco("screenprint", "costCents"), "0.20"); type(dco("screenprint", "maxColors"), "8");
  type(dco("vinyl", "costCents"), "0.75"); type(dco("vinyl", "priceCents"), "3.25"); type(dco("vinyl", "setupCents"), "5");
  reset();
  await w.submitGlobalSettings(); await idle();
  const saveReq = of("saveGlobalSettingsAll");
  ok("one request saves it, with the other Global settings sections", saveReq.length === 1 && !!saveReq[0].settings.payments && !!saveReq[0].settings.decoration);
  const sd = saveReq[0].settings.decoration;
  ok("the ticked types go in registry order", same(sd.types, ["embroidery", "screenprint", "vinyl"]));
  ok("embroidery's prices go as cents and whole numbers", same(sd.pricing.embroidery, { stitchPricing: true, centsPer1000: 100, minStitches: 4000, minCents: 250 }));
  ok("screen print's prices go as cents (most colours as it is)", same(sd.pricing.screenprint, { inkColorCents: 150, screenSetupCents: 2000, reorderSetupCents: 1000, costCents: 20, maxColors: 8 }));
  ok("vinyl's prices go as cents", same(sd.pricing.vinyl, { costCents: 75, priceCents: 325, setupCents: 500 }));
  ok("every type has its prices in the request, ticked or not", ["dtf", "dtg", "sublimation"].every(t => same(sd.pricing[t], { costCents: 0, priceCents: 0, setupCents: 0 })));
  const stored = await serverDeco();
  ok("the server kept the types", same(stored.types, ["embroidery", "screenprint", "vinyl"]));
  ok("…and the prices, in cents", stored.pricing.vinyl.priceCents === 325 && stored.pricing.screenprint.screenSetupCents === 2000 && stored.pricing.embroidery.minCents === 250 && stored.pricing.embroidery.stitchPricing === true);
  ok("the page's own list followed without a reload (menus and forms read it)", same(w.decorationTypesOn_(), ["embroidery", "screenprint", "vinyl"]) && w.decorationIsOn_("vinyl") && !w.decorationIsOn_("dtf"));
  ok("…and so did the storefront script's list", same(w.eval("siteDecorations"), ["embroidery", "screenprint", "vinyl"]));
  ok("the menu lost Transfers, as DTF is off", !navHashes().includes("transfers") && navHashes().includes("machines"));
  ok("the menu keeps the embroidery pages while embroidery is on", ["machines", "maintenance", "machinefiles", "hoops", "threads", "abortreasons"].every(h => navHashes().includes(h)));
  ok("the saved page reads the values back (the list was read again)", of("getDecorationSettings").length >= 1);

  // Embroidery off and DTF on.
  await w.renderGlobalSettings(app); await idle();
  ok("the form drawn again shows what was saved", same(ticked(), ["embroidery", "screenprint", "vinyl"]) && dco("vinyl", "priceCents").value === "3.25" && dco("screenprint", "maxColors").value === "8" && dco("embroidery", "stitchPricing").checked === true && dco("embroidery", "minCents").value === "2.50");
  tick(q('#gDecoration .gDecoType[data-feature="embroidery"]'), false);
  tick(q('#gDecoration .gDecoType[data-feature="dtf"]'), true);
  reset();
  await w.submitGlobalSettings(); await idle();
  ok("unticking embroidery saves", of("saveGlobalSettingsAll").length === 1 && same(of("saveGlobalSettingsAll")[0].settings.decoration.types, ["dtf", "screenprint", "vinyl"]));
  const hashes2 = navHashes();
  ok("the menu has Transfers back, as DTF is on", hashes2.includes("transfers"));
  ok("…and loses Machines, Machine maintenance, Machine files, Hoops, Threads and Abort reasons, as embroidery is off", ["machines", "maintenance", "machinefiles", "hoops", "threads", "abortreasons"].every(h => !hashes2.includes(h)));
  ok("…while Designs, Graphics and the other pages stay", ["designs", "graphics", "settings", "inventory", "expenses"].every(h => hashes2.includes(h)));
  ok("the phone's menu sheet follows too", !qa("#adminNav button[data-h=\"machines\"]").length && qa("#adminNav button[data-h=\"transfers\"]").length > 0);
  ok("a page of an off type is not on, one of an on type is", !w.adminPageOn_("machines") && !w.adminPageOn_("#hoops/x") && w.adminPageOn_("transfers") && w.adminPageOn_("orders"));
  w.location.hash = "#machines"; w.adminRoute(); await idle();
  ok("a switched-off type's page still opens by its address (what is on record can be reached)", w.location.hash === "#machines" && /Machines/.test(d.title) && !q("#featureOffPanel") && !q("#roleOffPanel"));

  console.log("\n=== The decoration section when it can't be read, and for a role that can't change it ===");
  scripted = [{ action: "getDecorationSettings", status: 500, body: { status: "error", message: "Could not read" } }];
  reset();
  await w.renderGlobalSettings(app); await idle();
  ok("when the server can't say, the section isn't drawn (the form's defaults can't be saved over the real prices)", !id("gDecoration") && !qa("#app h2").some(h => text(h) === "Decoration types"));
  await w.submitGlobalSettings(); await idle();
  ok("…and the save sends no decoration section", of("saveGlobalSettingsAll").length === 1 && !("decoration" in of("saveGlobalSettingsAll")[0].settings));
  ok("…the types the server has are untouched", same((await serverDeco()).types, ["dtf", "screenprint", "vinyl"]));
  asRoles("manager");
  await w.renderGlobalSettings(app); await idle();
  ok("a role that may only read Global settings still sees the section", !!id("gDecoration"));
  reset();
  await w.submitGlobalSettings(); await idle();
  ok("…but its save carries no decoration (settings.global edit is needed)", of("saveGlobalSettingsAll").length === 1 && !("decoration" in of("saveGlobalSettingsAll")[0].settings));
  ok("…and the server's list is what it was", same((await serverDeco()).types, ["dtf", "screenprint", "vinyl"]));
  asRoles("admin");

  console.log("\n=== The product form: the Decoration select ===");
  const FULL = { stitchPricing: true, centsPer1000: 100, minStitches: 0, minCents: 0 };
  const PRICES = { embroidery: FULL, screenprint: { inkColorCents: 150, screenSetupCents: 2000, reorderSetupCents: 1000, costCents: 20, maxColors: 6 },
    vinyl: { costCents: 75, priceCents: 300, setupCents: 500 }, dtg: { costCents: 0, priceCents: 0, setupCents: 0 } };
  await setDeco(["embroidery", "dtf", "screenprint", "vinyl", "dtg"], PRICES);
  const crest = (await must({ action: "saveDesign", org: "club", design: { name: "Example Crest" } })).id;
  const word = (await must({ action: "saveDesign", org: "club", design: { name: "Example Wordmark" } })).id;
  await must({ action: "saveDesignVersion", designId: crest, machineFileKey: "crest.dst", stitchCount: 8500 });
  await must({ action: "saveDesignVersion", designId: word, machineFileKey: "word.dst" });
  const make = async (productId, extra) => must(Object.assign({ action: "createProduct", org: "club", productId, type: "shirt", name: "Example " + productId, pricingMode: "flat", flatPrice: 20, visible: true, taxable: true, images: [], features: [] }, extra));
  await make("tee"); await make("polo", { pricingMode: "sized", flatPrice: undefined, sizePricing: { S: 20, M: 20, L: 22 } });
  await make("twotee"); await make("wordonly"); await make("banner", { decorationType: "screenprint", noDesignNeeded: true });
  await make("plain", { noDesignNeeded: true }); await make("pressed", { noDesignNeeded: true, transferCost: 1.5 });
  for (const [pid, designs] of [["tee", [crest]], ["polo", [crest]], ["twotee", [crest, word]], ["wordonly", [word]]])
    await must({ action: "setProductDesigns", org: "club", productId: pid, designs: designs.map((x, i) => ({ designId: x, placement: "Left chest" + (i ? " " + i : ""), isMain: i === 0 })) });
  const prod = async (pid) => (await must({ action: "listProducts", org: "club" })).products.find(x => x.productId === pid);
  const openForm = async (pid) => { reset(); w.renderProductForm(app, "club", await prod(pid)); await idle(); await pause(120); await idle(); };
  const sel = () => id("prodFormDecoration");
  await openForm("tee");
  ok("it is on the form, with 'worked out from the design' first", !!sel() && optionsOf(sel())[0][0] === "" && /Worked out from the design/.test(optionsOf(sel())[0][1]));
  ok("…then only the types that are on, in registry order, by their registry names", same(optionsOf(sel()).slice(1), [["embroidery", "Embroidery"], ["dtf", "DTF transfer"], ["screenprint", "Screen print"], ["vinyl", "Vinyl / heat transfer"], ["dtg", "DTG"]]));
  ok("a product with nothing picked is on 'worked out'", sel().value === "");
  await openForm("banner");
  ok("a product with a type picked shows it", sel().value === "screenprint" && (await prod("banner")).decorationType === "screenprint");
  ok("the choice is explained on the form", /types on offer are the ones ticked in Global settings/.test(text(sel().closest("label").nextElementSibling)));

  console.log("\n=== The product form: By stitch count ===");
  w.eval("decoStitchCache_.clear()");
  await openForm("tee");
  ok("with stitch pricing on, a product whose design has 8,500 stitches shows what that comes to", /By stitch count: \$8\.50 per piece/.test(text(id("prodDecoHelper"))) && /8,500 stitches . \$1\.00 per 1,000/.test(text(id("prodDecoHelper"))));
  ok("…asked of the server with the stitches (the page works out no money)", of("priceDecoration").some(b => b.type === "embroidery" && b.params.stitches === 8500));
  ok("…and the design's stitch count was read from its newest version", of("getDesign").some(b => b.id === crest));
  ok("it offers Use this", !!id("prodStitchUse") && id("prodStitchUse").dataset.cents === "850" && /Use this/.test(id("prodStitchUse").textContent));
  ok("the price box starts at the product's $20.00", id("prodFormFlatPrice").value === "20");
  id("prodStitchUse").click();
  ok("Use this adds the stitch price to the price box", id("prodFormFlatPrice").value === "28.50");
  ok("…and the button says it is done and can't add twice", id("prodStitchUse").disabled && id("prodStitchUse").textContent === "Added");
  ok("…nothing was saved by that (the box is what gets saved)", of("updateProduct").length === 0);
  type(id("prodFormFlatPrice"), "");
  await openForm("tee");
  type(id("prodFormFlatPrice"), "");
  id("prodStitchUse").click();
  ok("with no price typed, Use this says to enter one first", toasts.some(t => t.err && /Enter a price first/.test(t.m)));
  ok("…and adds nothing and stays available", id("prodFormFlatPrice").value === "" && !id("prodStitchUse").disabled);
  await openForm("polo");
  ok("on a product priced by size, the helper shows the same figure", /By stitch count: \$8\.50/.test(text(id("prodDecoHelper"))));
  const sizeBoxes = qa(".prodFormSize");
  const before = Object.fromEntries(sizeBoxes.map(b => [b.dataset.size, b.value]));
  id("prodStitchUse").click();
  const after = Object.fromEntries(qa(".prodFormSize").map(b => [b.dataset.size, b.value]));
  ok("Use this adds it to every size that has a price", after.S === "28.50" && after.M === "28.50" && after.L === "30.50");
  ok("…and leaves a size with no price blank", Object.keys(before).some(k => before[k] === "" && after[k] === ""));
  await openForm("twotee");
  ok("a design with no stitch count yet is left out of the total and said so", /By stitch count: \$8\.50/.test(text(id("prodDecoHelper"))) && /1 design has no stitch count yet, so it isn't counted/.test(text(id("prodDecoHelper"))));
  await openForm("wordonly");
  ok("when no design has a stitch count, it says none is known (and offers no price)", /Stitch pricing is on, but no stitch count is known/.test(text(id("prodDecoHelper"))) && !id("prodStitchUse"));
  await openForm("plain");
  ok("a product with no designs shows no stitch helper", text(id("prodDecoHelper")) === "");
  await setDeco(["embroidery", "dtf", "screenprint", "vinyl", "dtg"], Object.assign({}, PRICES, { embroidery: Object.assign({}, FULL, { stitchPricing: false }) }));
  await openForm("tee");
  ok("with stitch pricing off in Global settings there is no stitch helper", text(id("prodDecoHelper")) === "" && !id("prodStitchUse"));
  await setDeco(["dtf", "screenprint", "vinyl", "dtg"], PRICES);
  await openForm("tee");
  ok("with embroidery switched off there is none either, though the price is on", text(id("prodDecoHelper")) === "" && !id("prodStitchUse"));
  await setDeco(["embroidery", "dtf", "screenprint", "vinyl", "dtg"], PRICES);

  console.log("\n=== The product form: a suggested price for a printed type ===");
  await openForm("banner");
  const res = () => text(id("prodDecoResult"));
  ok("a screen print product shows a suggested price, for information", /Suggested decoration price/.test(text(id("prodDecoHelper"))) && /Screen print . for information; the price you type is what is saved/.test(text(id("prodDecoHelper"))));
  ok("…for one colour and one location to start", id("prodDecoColors").value === "1" && id("prodDecoLocs").value === "1" && /\$1\.50 per piece \+ \$20\.00 setup . 1 colour . 1 location/.test(res()));
  ok("…colours can't go past the most colours in Global settings", id("prodDecoColors").max === "6" && id("prodDecoLocs").max === "12");
  type(id("prodDecoColors"), "2");
  await idle();
  ok("two colours: the ink price and the setup follow", /\$3\.00 per piece \+ \$40\.00 setup . 2 colours . 1 location/.test(res()));
  ok("…the server was asked with the colours, locations and reorder", of("priceDecoration").some(b => b.type === "screenprint" && b.params.colors === 2 && b.params.locations === 1 && b.params.reorder === false));
  tick(id("prodDecoReorder"), true); await idle();
  ok("a reorder uses the reorder setup (screens exist)", /\$3\.00 per piece \+ \$20\.00 setup . 2 colours . 1 location, reorder/.test(res()) && of("priceDecoration").some(b => b.params.reorder === true));
  type(id("prodDecoLocs"), "2"); await idle();
  ok("two locations: the ink price and the setup double", /\$6\.00 per piece \+ \$40\.00 setup/.test(res()) && /2 locations/.test(res()));
  ok("a price helper never changes the price box", id("prodFormFlatPrice").value === "20");
  pick(sel(), "vinyl"); await idle(); await pause(60);
  ok("picking vinyl redraws it: no colours or reorder, just locations", !id("prodDecoColors") && !id("prodDecoReorder") && !!id("prodDecoLocs") && /Vinyl \/ heat transfer . for information/.test(text(id("prodDecoHelper"))));
  ok("…with vinyl's price and setup", /\$3\.00 per piece \+ \$5\.00 setup . 1 location . \$3\.00/.test(res()));
  pick(sel(), "dtg"); await idle(); await pause(60);
  ok("a type with no prices set says so, and where to set them", /No prices are set for this type yet \(Global settings . Decoration types\)/.test(res()));
  scripted = [{ action: "priceDecoration", status: 500, body: { status: "error", message: "boom" } }];
  pick(sel(), "vinyl"); await idle(); await pause(60);
  ok("when the server can't work a price out, it says so", /Couldn't work out a price\./.test(res()));
  pick(sel(), "embroidery"); await idle(); await pause(60);
  ok("picking embroidery on a product with no design shows no printed helper", text(id("prodDecoHelper")) === "");
  pick(sel(), "dtf"); await idle(); await pause(60);
  ok("picking DTF shows no helper (DTF has no suggested price here)", text(id("prodDecoHelper")) === "");

  console.log("\n=== The product form: blocks for a type that is off and unused ===");
  await make("named", { noDesignNeeded: true, personalizationPrice: 5 });
  const slot = (n) => q('.prod-slot[data-slot="' + n + '"]');
  const gone = (el) => !!el && el.style.display === "none";
  const embBlocks = () => [id("productDesignsBlock"), id("productDesignSection"), id("prodFormNoDesign").closest("label"), id("prodRunPreview"), slot("cfgEmbWrap"), q(".prod-emb-options-note")];
  const printedBlocks = () => [slot("cfgFixedWrap"), id("prodFormTransferCost").closest("label")];
  const allGone = (list) => list.every(e => !!e) && list.every(gone);
  const noneGone = (list) => list.every(e => !!e) && list.every(e => !gone(e));
  await setDeco(["dtf", "screenprint", "vinyl", "dtg"], PRICES);
  await openForm("plain");
  ok("embroidery off, a product with no design: designs, 'no design needed', the Run order preview and the embroidery options are hidden", allGone(embBlocks()));
  ok("…and so is personalization (it is stitched), as it has none set", gone(id("prodCardPers")));
  ok("…while the printed blocks stay, as printed types are on", noneGone(printedBlocks()));
  await openForm("named");
  ok("…personalization stays for a product that already has it", !gone(id("prodCardPers")) && allGone(embBlocks()));
  await openForm("tee");
  ok("embroidery off, a product that has a design keeps every embroidery block (what is on record is never hidden)", noneGone(embBlocks()) && !gone(id("prodCardPers")));
  await openForm("banner");
  ok("a screen print product with no design has them hidden", allGone(embBlocks()));
  await setDeco(["embroidery", "dtf", "screenprint", "vinyl", "dtg"], PRICES);
  await openForm("plain");
  ok("with embroidery on, nothing is hidden", noneGone(embBlocks()) && noneGone(printedBlocks()) && !gone(id("prodCardPers")));
  await setDeco(["embroidery"], PRICES);
  await openForm("tee");
  ok("no printed type on, a product that doesn't use one: printed transfers and the transfer cost are hidden", allGone(printedBlocks()));
  await openForm("plain");
  ok("…but a product with no design is worked out as printed (DTF), so it keeps them", (await prod("plain")).decoration === "dtf" && noneGone(printedBlocks()));
  ok("…while the embroidery blocks stay", noneGone(embBlocks()));
  await openForm("pressed");
  ok("a product that has a transfer cost keeps the transfer blocks", noneGone(printedBlocks()));
  await openForm("banner");
  ok("a product picked as screen print keeps them too", noneGone(printedBlocks()));
  await openForm("tee");
  await setDeco(["embroidery", "dtf"], PRICES);
  w.productDecorationChanged_(); await idle();
  ok("when a printed type comes on while the form is open, the hidden blocks come back as they were", noneGone(printedBlocks()) && printedBlocks().every(e => !("decoHid" in e.dataset)));
  await openForm("plain");
  await setDeco(["dtf"], PRICES);
  w.productDecorationChanged_(); await idle();
  ok("and go again when embroidery goes off", allGone(embBlocks()));
  await setDeco(["embroidery", "dtf"], PRICES);
  w.productDecorationChanged_(); await idle();
  ok("…and return", noneGone(embBlocks()) && !gone(id("prodCardPers")));
  w.renderProductForm(app, "club", null); await idle(); await pause(100);
  ok("a new product's form has the select too, on 'worked out'", !!sel() && sel().value === "" && noneGone(embBlocks().filter(e => e !== slot("cfgEmbWrap") && e !== slot("cfgFixedWrap"))));

  console.log("\n=== The product form: a type switched off is marked, and what Save sends ===");
  await setDeco(["embroidery", "dtf", "vinyl"], PRICES);
  await openForm("banner");
  ok("a product whose type was switched off since still shows it, marked", same(optionsOf(sel()).map(o => o[0]), ["", "embroidery", "dtf", "vinyl", "screenprint"]) && sel().value === "screenprint" && optionsOf(sel()).find(o => o[0] === "screenprint")[1] === "Screen print (switched off)");
  ok("…and the types that are off and not its own aren't offered", !optionsOf(sel()).some(o => o[0] === "dtg" || o[0] === "sublimation"));
  await w.submitProductForm("club", true); await idle();
  ok("saving it unchanged sends the type it has", of("updateProduct").length === 1 && of("updateProduct")[0].decorationType === "screenprint");
  ok("…and the server keeps it, though it is off", (await prod("banner")).decorationType === "screenprint" && !text(id("prodFormError")));
  await openForm("banner");
  pick(sel(), "vinyl");
  await w.submitProductForm("club", true); await idle();
  ok("picking vinyl and saving sends and stores vinyl", of("updateProduct")[0].decorationType === "vinyl" && (await prod("banner")).decorationType === "vinyl");
  await openForm("banner");
  pick(sel(), "");
  await w.submitProductForm("club", true); await idle();
  ok("picking 'worked out' sends an empty type, and the server stores none", of("updateProduct")[0].decorationType === "" && (await prod("banner")).decorationType === "");
  await setDeco(["embroidery", "dtf", "screenprint", "vinyl", "dtg"], PRICES);

  console.log("\n=== Graphics: the Printed by select and the Kind labels ===");
  const ALL6 = Object.assign({}, PRICES, { sublimation: { costCents: 0, priceCents: 0, setupCents: 0 }, dtf: { costCents: 0, priceCents: 0, setupCents: 0 } });
  await setDeco(KEYS, ALL6);
  const gfRows = () => qa("#grBody tbody tr").filter(tr => tr.children.length > 3);
  const kindOf = (name) => { const tr = gfRows().find(r => text(r.children[1]).startsWith(name)); return tr ? text(tr.children[2]) : null; };
  await w.renderGraphics(app, "club"); await idle();
  id("grNewBtn").click(); await pause(60);
  let m = modal();
  const g$ = (sel) => m.querySelector(sel);
  ok("a new graphic's Kind offers printed and embroidery, as both are on", same([...g$("#gfKind").options].map(o => o.value), ["transfer", "embroidery"]) && /Printed \(transfer sheet\)/.test(text(g$("#gfKind").options[0])));
  ok("'Printed by' offers the printed types that are on, by name, and not embroidery", same(optionsOf(g$("#gfDecoration")), [["dtf", "DTF transfer"], ["screenprint", "Screen print"], ["vinyl", "Vinyl / heat transfer"], ["dtg", "DTG"], ["sublimation", "Sublimation"]]));
  ok("…DTF is the starting choice, and its transfer sheet picker shows", g$("#gfDecoration").value === "dtf" && g$("#gfDecoWrap").style.display === "" && g$("#gfTransferWrap").style.display === "");
  pick(g$("#gfDecoration"), "screenprint");
  ok("picking a type that has no transfer sheets hides the sheet picker", g$("#gfTransferWrap").style.display === "none" && g$("#gfDecoWrap").style.display === "");
  pick(g$("#gfKind"), "embroidery");
  ok("an embroidery graphic has no 'Printed by', but its design picker", g$("#gfDecoWrap").style.display === "none" && g$("#gfDesignWrap").style.display === "");
  pick(g$("#gfKind"), "transfer");
  ok("back to printed, 'Printed by' returns with what was picked", g$("#gfDecoWrap").style.display === "" && g$("#gfDecoration").value === "screenprint" && g$("#gfTransferWrap").style.display === "none");
  type(g$("#gfName"), "Example logo screens");
  reset();
  g$("#gfSave").click(); await idle(); await pause(60);
  ok("saving sends the type picked, and no transfer sheet", of("saveGraphic").length === 1 && of("saveGraphic")[0].graphic.kind === "transfer" && of("saveGraphic")[0].graphic.decoration === "screenprint" && of("saveGraphic")[0].graphic.transferId === null);
  ok("…it shows in the list as Screen print", kindOf("Example logo screens") === "Screen print");
  id("grNewBtn").click(); await pause(60); m = modal();
  type(g$("#gfName"), "Example logo DTF");
  reset(); g$("#gfSave").click(); await idle(); await pause(60);
  ok("a DTF graphic sends dtf", of("saveGraphic")[0].graphic.decoration === "dtf");
  ok("…and the list says Transfer (DTF), as it always did", kindOf("Example logo DTF") === "Transfer (DTF)");
  id("grNewBtn").click(); await pause(60); m = modal();
  pick(g$("#gfKind"), "embroidery"); type(g$("#gfName"), "Example crest stitched"); pick(g$("#gfDesign"), String(crest));
  reset(); g$("#gfSave").click(); await idle(); await pause(60);
  ok("an embroidery graphic sends no printed type", of("saveGraphic")[0].graphic.kind === "embroidery" && of("saveGraphic")[0].graphic.decoration === "" && of("saveGraphic")[0].graphic.designId === crest);
  ok("…and the list says Embroidery", kindOf("Example crest stitched") === "Embroidery");
  for (const [name, dec] of [["Example logo vinyl", "vinyl"], ["Example logo sublimation", "sublimation"]]) await must({ action: "saveGraphic", org: "club", graphic: { name, kind: "transfer", decoration: dec, visible: true } });
  await w.renderGraphics(app, "club"); await idle();
  ok("every printed type is named in the list", kindOf("Example logo vinyl") === "Vinyl / heat transfer" && kindOf("Example logo sublimation") === "Sublimation");

  await setDeco(["screenprint", "vinyl", "dtg"], ALL6);
  await w.renderGraphics(app, "club"); await idle();
  ok("a graphic whose type was switched off is marked in the list, never hidden", kindOf("Example logo DTF") === "Transfer (DTF) (switched off)" && kindOf("Example logo sublimation") === "Sublimation (switched off)" && kindOf("Example crest stitched") === "Embroidery (switched off)");
  ok("…one whose type is on is not marked", kindOf("Example logo screens") === "Screen print" && kindOf("Example logo vinyl") === "Vinyl / heat transfer");
  id("grNewBtn").click(); await pause(60); m = modal();
  ok("a new graphic with embroidery off can't be an embroidery one", same([...g$("#gfKind").options].map(o => o.value), ["transfer"]));
  ok("…and 'Printed by' offers only the printed types still on", same(optionsOf(g$("#gfDecoration")).map(o => o[0]), ["screenprint", "vinyl", "dtg"]));
  ok("…and it starts on the first of them, not on the DTF that is off", g$("#gfDecoration").value === "screenprint");
  type(g$("#gfName"), "Example logo DTG");
  reset(); g$("#gfSave").click(); await idle(); await pause(60);
  ok("…so a new graphic saves without choosing", of("saveGraphic").length === 1 && of("saveGraphic")[0].graphic.decoration === "screenprint" && toasts.some(t => /Graphic created/.test(t.m)) && !toasts.some(t => t.err));
  const subl = (await must({ action: "listGraphics", org: "club" })).graphics.find(x => x.name === "Example logo sublimation");
  w.graphicEdit_(String(subl.id)); await pause(60); m = modal();
  ok("editing a graphic of an off type keeps it picked, marked, after the types that are on", same(optionsOf(g$("#gfDecoration")), [["screenprint", "Screen print"], ["vinyl", "Vinyl / heat transfer"], ["dtg", "DTG"], ["sublimation", "Sublimation (switched off)"]]) && g$("#gfDecoration").value === "sublimation");
  reset(); g$("#gfSave").click(); await idle(); await pause(60);
  ok("saving it unchanged is accepted (a type already on a record is kept)", of("saveGraphic").length === 1 && of("saveGraphic")[0].graphic.decoration === "sublimation" && toasts.some(t => /Graphic updated/.test(t.m)) && !toasts.some(t => t.err));
  const stitched = (await must({ action: "listGraphics", org: "club" })).graphics.find(x => x.name === "Example crest stitched");
  w.graphicEdit_(String(stitched.id)); await pause(60); m = modal();
  ok("an embroidery graphic with embroidery off keeps its Kind, marked", g$("#gfKind").value === "embroidery" && /Embroidery \(switched off\)/.test(text(g$("#gfKind").selectedOptions[0])) && [...g$("#gfKind").options].some(o => o.value === "transfer"));
  g$("#gfCancel").click();
  await setDeco(["embroidery"], ALL6);
  id("grNewBtn") && await w.renderGraphics(app, "club"); await idle();
  id("grNewBtn").click(); await pause(60); m = modal();
  ok("with no printed type on, a new graphic can only be embroidery", same([...g$("#gfKind").options].map(o => o.value), ["embroidery"]) && g$("#gfDecoWrap").style.display === "none");
  ok("…and starts as one (its design picker shows)", g$("#gfKind").value === "embroidery" && g$("#gfDesignWrap").style.display === "");
  type(g$("#gfName"), "Example crest again"); pick(g$("#gfDesign"), String(crest));
  reset(); g$("#gfSave").click(); await idle(); await pause(60);
  ok("…so it saves without choosing a kind", of("saveGraphic").length === 1 && of("saveGraphic")[0].graphic.kind === "embroidery" && toasts.some(t => /Graphic created/.test(t.m)) && !toasts.some(t => t.err));
  await setDeco(["embroidery", "dtf", "screenprint", "vinyl", "dtg"], ALL6);

  console.log("\n=== Transfers: only for DTF ===");
  await w.renderTransfers(app); await idle();
  ok("with DTF on the page doesn't say it is off", !/DTF is switched off/.test(text(app)));
  await setDeco(["embroidery", "screenprint"], ALL6);
  await w.renderTransfers(app); await idle();
  ok("with DTF off the page says so, and where to turn it on", /DTF is switched off in Global settings . Decoration types/.test(text(app)) && /out of the menu/.test(text(app)));
  ok("…and the menu lacks it", (w.renderAdminNav(), !navHashes().includes("transfers")));
  await setDeco(["embroidery", "dtf", "screenprint", "vinyl", "dtg"], ALL6);
  w.renderAdminNav();
  ok("…until DTF is on again", navHashes().includes("transfers"));

  console.log("\n=== Vendors: Digitizes designs ===");
  let savedVendors = null;
  w.showVendorFormModal_(null, (list) => { savedVendors = list; }); await pause(60); m = modal();
  ok("a new vendor form has the tick, off to start", !!g$("#vfmDigitizes") && g$("#vfmDigitizes").checked === false && /Digitizes designs/.test(text(g$("#vfmDigitizes").parentNode)));
  type(g$("#vfmName"), "Example Digitizing Co"); tick(g$("#vfmDigitizes"), true);
  reset(); g$("#vfmSave").click(); await idle(); await pause(60);
  ok("saving sends it ticked", of("saveVendor").length === 1 && of("saveVendor")[0].vendor.forDigitizing === true);
  const vend = (await must({ action: "listVendors" })).vendors.find(v => v.name === "Example Digitizing Co");
  ok("the server keeps it", !!vend && vend.forDigitizing === true);
  ok("a vendor that only digitizes isn't a blanks vendor unless ticked (the other tick is its own)", vend.forBlanks === true);
  w.showVendorFormModal_(vend, () => {}); await pause(60); m = modal();
  ok("editing it shows the tick set", g$("#vfmDigitizes").checked === true);
  tick(g$("#vfmDigitizes"), false);
  reset(); g$("#vfmSave").click(); await idle(); await pause(60);
  ok("unticking saves it off", of("saveVendor")[0].vendor.forDigitizing === false && (await must({ action: "listVendors" })).vendors.find(v => v.name === "Example Digitizing Co").forDigitizing === false);
  ok("a change to another field of a vendor keeps its Digitizes tick", w.vendorFormValues_({ id: 1, name: "x", forBlanks: false, forDigitizing: true, hidden: false }).forDigitizing === true && w.vendorFormValues_({ id: 1, name: "x" }).forDigitizing === false);
  const vendBox = d.createElement("div"); d.body.appendChild(vendBox);
  await must({ action: "saveVendor", vendor: { name: "Example Stitch Files", forBlanks: false, forDigitizing: true } });
  await w.mountVendorManager_(vendBox, () => {}); await idle(); await pause(60);
  const vrow = (n) => [...vendBox.querySelectorAll("[data-vendor-row]")].find(r => text(r.children[0]).startsWith(n));
  ok("the vendor list says which vendors digitize designs", !!vrow("Example Stitch Files") && /digitizes designs/.test(text(vrow("Example Stitch Files").children[0])));
  ok("…and not the others", !!vrow("Example Digitizing Co") && !/digitizes designs/.test(text(vrow("Example Digitizing Co").children[0])));
  vendBox.remove();

  console.log("\n=== The new-product wizard: only the enabled types ===");
  const wizHost = d.createElement("div"); d.body.appendChild(wizHost);
  const setWiz = (answers, product) => w.eval("_wiz = { orgId: 'club', org: {}, state: { answers: " + JSON.stringify(answers) + ", products: [" + JSON.stringify(product || {}) + "] }, data: {} };");
  // The shop-wide question, and the one on each product's own screen: what they offer, which is on, what they save.
  const shopScreen = () => { const sc = w.wizScreen_({ id: "decorate" }); wizHost.innerHTML = sc.html; return sc; };
  const prodScreen = () => { const sc = w.wizProductScreen_({ productIndex: 0, productStep: "decoration" }); wizHost.innerHTML = sc.html; return sc; };
  const choices = (name) => [...wizHost.querySelectorAll('input[name="' + name + '"]')].map(i => i.value);
  const checkedOf = (name) => (wizHost.querySelector('input[name="' + name + '"]:checked') || {}).value;
  const labelOf = (name, v) => text(wizHost.querySelector('input[name="' + name + '"][value="' + v + '"]').closest("label"));
  await setDeco(["embroidery", "dtf", "screenprint", "vinyl", "dtg", "sublimation"], ALL6);
  setWiz({}); shopScreen();
  ok("with every type on, the shop-wide question offers each, with 'Both' right after DTF", same(choices("wizDeco"), ["embroidery", "dtf", "both", "screenprint", "vinyl", "dtg", "sublimation"]));
  ok("…named as the page names them, with their one-line help", /^Embroidery/.test(labelOf("wizDeco", "embroidery")) && /DTF \(printed transfers\)/.test(labelOf("wizDeco", "dtf")) && /Ink through a screen, one per color/.test(labelOf("wizDeco", "screenprint")) && /Vinyl \/ heat transfer/.test(labelOf("wizDeco", "vinyl")) && /Dye pressed into polyester/.test(labelOf("wizDeco", "sublimation")));
  ok("…embroidery is the starting choice", checkedOf("wizDeco") === "embroidery");
  setWiz({ decoration: "vinyl" }); shopScreen();
  ok("an earlier answer stays picked", checkedOf("wizDeco") === "vinyl");
  let sc = shopScreen(); wizHost.querySelector('input[name="wizDeco"][value="dtg"]').checked = true;
  await sc.save();
  ok("saving the pick stores it as the shop's answer", w.eval("_wiz.state.answers.decoration") === "dtg");

  await setDeco(["dtf", "screenprint"], ALL6);
  setWiz({}); sc = shopScreen();
  ok("with embroidery off it isn't offered, and 'Both' isn't (it needs both)", same(choices("wizDeco"), ["dtf", "screenprint"]));
  ok("…the starting choice is the first one on", checkedOf("wizDeco") === "dtf");
  await sc.save();
  ok("…and saving with nothing picked takes it, not embroidery", w.eval("_wiz.state.answers.decoration") === "dtf");
  await setDeco(["embroidery", "screenprint"], ALL6);
  setWiz({}); shopScreen();
  ok("with DTF off, 'Both' isn't offered either", same(choices("wizDeco"), ["embroidery", "screenprint"]));
  await setDeco(["embroidery", "dtf"], ALL6);
  setWiz({}); shopScreen();
  ok("with just embroidery and DTF, it is today's three choices", same(choices("wizDeco"), ["embroidery", "dtf", "both"]) && /^Both/.test(labelOf("wizDeco", "both")));
  await setDeco(["embroidery"], ALL6);
  setWiz({}); shopScreen();
  ok("embroidery alone: one choice", same(choices("wizDeco"), ["embroidery"]));
  await setDeco(["screenprint", "vinyl"], ALL6);
  setWiz({ decoration: "embroidery" }); shopScreen();
  ok("an answer whose type was switched off since stays, marked, so it isn't changed quietly", same(choices("wizDeco"), ["screenprint", "vinyl", "embroidery"]) && /Embroidery \(switched off\)/.test(labelOf("wizDeco", "embroidery")) && checkedOf("wizDeco") === "embroidery");
  setWiz({ decoration: "both" }); shopScreen();
  ok("…so does 'Both'", /Both \(switched off\)/.test(labelOf("wizDeco", "both")) && checkedOf("wizDeco") === "both");

  await setDeco(KEYS, ALL6);
  setWiz({ decoration: "screenprint" }, {}); sc = prodScreen();
  ok("a product's own screen offers the same types", same(choices("wizPDeco"), ["embroidery", "dtf", "both", "screenprint", "vinyl", "dtg", "sublimation"]) && /Embroidery/.test(labelOf("wizPDeco", "embroidery")));
  ok("…and starts on the shop-wide answer", checkedOf("wizPDeco") === "screenprint");
  setWiz({ decoration: "screenprint" }, { decoration: "sublimation" }); prodScreen();
  ok("…unless the product has its own", checkedOf("wizPDeco") === "sublimation");
  setWiz({}, {}); sc = prodScreen();
  wizHost.querySelector('input[name="wizPDeco"][value="vinyl"]').checked = true;
  ok("saving a pick sets the product's type and marks the step done", (await sc.save()) === "" && w.eval("_wiz.state.products[0].decoration") === "vinyl" && w.eval("_wiz.state.products[0].done").includes("decoration"));
  await setDeco(["dtf", "dtg"], ALL6);
  setWiz({}, {}); sc = prodScreen();
  ok("with embroidery off, a product's screen starts on the first type that is on, and saves it when left alone", checkedOf("wizPDeco") === "dtf" && same(choices("wizPDeco"), ["dtf", "dtg"]));
  wizHost.querySelectorAll('input[name="wizPDeco"]').forEach(i => { i.checked = false; });
  await sc.save();
  ok("…even with nothing ticked", w.eval("_wiz.state.products[0].decoration") === "dtf");
  setWiz({}, { decoration: "screenprint" }); prodScreen();
  ok("a product's switched-off type stays, marked", /Screen print \(switched off\)/.test(labelOf("wizPDeco", "screenprint")) && checkedOf("wizPDeco") === "screenprint");

  console.log("\n=== The wizard: what is still to come for each type ===");
  await setDeco(KEYS, ALL6);
  const todo = (decoration) => { setWiz({}, { decoration, fixed: {} }); return w.eval("wizDesignsPending_(_wiz.state.products[0])"); };
  ok("an embroidered product still needs its embroidery graphic", same(todo("embroidery"), ["Pick or add its embroidery graphic (the picture shoppers see)"]));
  ok("a DTF product needs its printed graphic, called DTF", same(todo("dtf"), ["Pick or add its printed graphic (DTF)"]));
  ok("'Both' needs both", same(todo("both"), ["Pick or add its embroidery graphic (the picture shoppers see)", "Pick or add its printed graphic (DTF)"]));
  ok("a screen print product needs its printed graphic, called Screen print — and no embroidery one", same(todo("screenprint"), ["Pick or add its printed graphic (Screen print)"]));
  ok("vinyl, DTG and sublimation likewise, by their names", same(todo("vinyl"), ["Pick or add its printed graphic (Vinyl / heat transfer)"]) && same(todo("dtg"), ["Pick or add its printed graphic (DTG)"]) && same(todo("sublimation"), ["Pick or add its printed graphic (Sublimation)"]));
  ok("a product with no answer yet is read as embroidery", same(todo(""), ["Pick or add its embroidery graphic (the picture shoppers see)"]));
  ok("the word for the printed side: Printed (DTF) for DTF and Both, the type's name for the others", same(w.eval("[wizPrintedLabel_('dtf'), wizPrintedLabel_('both'), wizPrintedLabel_('screenprint'), wizPrintedLabel_('dtg')]"), ["Printed (DTF)", "Printed (DTF)", "Screen print", "DTG"]));
  wizHost.remove();

  console.log("\n=== Price analysis: the decoration's cost, named for its type ===");
  await setDeco(KEYS, ALL6);
  await make("screens", { decorationType: "screenprint", noDesignNeeded: true });
  await make("vinylcap", { decorationType: "vinyl", noDesignNeeded: true });
  await make("dtgtee", { decorationType: "dtg", noDesignNeeded: true });
  const analysisOf = async (params) => { w.showPriceAnalysis_(params); await wait(() => id("paBody") && !/Working out costs/.test(id("paBody").textContent)); await idle(); return id("paBody"); };
  const heads = (det) => [...det.querySelectorAll("table.pricing-table thead th")].map(th => text(th));
  const detOf = (body, name) => [...body.querySelectorAll("details.pa-product")].find(dt => text(dt.querySelector("summary b")) === name);
  let pa = await analysisOf({ org: "club" });
  const banner = detOf(pa, "Example screens"), vcap = detOf(pa, "Example vinylcap"), dtgt = detOf(pa, "Example dtgtee"), teeD = detOf(pa, "Example tee");
  ok("a screen print product has a cost column named Screen print", !!banner && heads(banner).includes("Screen print"));
  ok("…it shows the type's cost for one colour and one location ($0.20)", (() => { const i = heads(banner).indexOf("Screen print"); return text(banner.querySelector("table.pricing-table tbody tr").children[i]) === "$0.20"; })());
  ok("…its heading says what it is", /What Screen print costs you per piece \(Global settings . Decoration types\)/.test(banner.querySelector("table.pricing-table thead th[title*='Screen print']").title));
  ok("a vinyl product's column is named for vinyl, with its cost ($0.75)", !!vcap && heads(vcap).includes("Vinyl / heat transfer") && !heads(vcap).includes("Screen print") && (() => { const i = heads(vcap).indexOf("Vinyl / heat transfer"); return text(vcap.querySelector("table.pricing-table tbody tr").children[i]) === "$0.75"; })());
  ok("the column sits between DTF and Supplies", (() => { const h = heads(banner); return h.indexOf("Screen print") === h.indexOf("DTF") + 1 && h.indexOf("Supplies") === h.indexOf("Screen print") + 1; })());
  ok("a type with no cost set adds no column", !!dtgt && !heads(dtgt).includes("DTG") && !heads(dtgt).includes("Decoration"));
  ok("an embroidered product has none either", !!teeD && !["Screen print", "Vinyl / heat transfer", "DTG", "Embroidery"].some(n => heads(teeD).includes(n)));
  const an = (await must({ action: "analyzePricing", org: "club" })).products;
  ok("…the analysis says the type, its label and the cost per piece", an.find(x => x.productId === "screens").decoration === "screenprint" && an.find(x => x.productId === "screens").decorationLabel === "Screen print" && an.find(x => x.productId === "screens").decorationCost === 0.2);
  q(".admin-modal #paDone").click();
  await setDeco(["embroidery", "dtf", "vinyl"], ALL6);
  pa = await analysisOf({ org: "club" });
  ok("a product of a switched-off type keeps its column in the analysis (records are never hidden)", heads(detOf(pa, "Example screens")).includes("Screen print"));
  q(".admin-modal #paDone").click();
  await setDeco(KEYS, ALL6);

  console.log("\n=== The page's list of types: before anything has said, and when it can't be read ===");
  w.eval("window._decorationTypes = undefined; siteDecorations = null; window._decorationRegistry = undefined;");
  ok("before the catalog or the server has said, it is today's behaviour: embroidery and DTF", same(w.decorationTypesOn_(), ["embroidery", "dtf"]) && w.decorationIsOn_("embroidery") && w.decorationIsOn_("vinyl"));
  ok("…labels come from the page's own list until the server's registry arrives", w.decorationLabel_("screenprint") === "Screen print" && w.decorationLabel_("nope") === "");
  w.eval("siteDecorations = ['dtg']");
  ok("a list from the shop page's catalog is used when the admin one hasn't been read", same(w.decorationTypesOn_(), ["dtg"]) && w.decorationIsOn_("dtg") && !w.decorationIsOn_("dtf"));
  w.applyDecorationList_("not a list"); w.applyDecorationList_(null);
  ok("something that isn't a list changes nothing", same(w.decorationTypesOn_(), ["dtg"]));
  w.applyDecorationList_(["sublimation", "embroidery", "zzz"]);
  ok("a new list is taken at once, in registry order, unknown names dropped", same(w.decorationTypesOn_(), ["embroidery", "sublimation"]) && same(w.eval("siteDecorations"), ["sublimation", "embroidery", "zzz"]));
  ok("a page whose type is switched off is out, one for an on type is in, one for no type always is", !w.adminPageOn_("transfers") && w.adminPageOn_("threads") && w.adminPageOn_("hoops") && w.adminPageOn_("graphics"));
  ok("the options list marks a switched-off pick and leaves out what isn't on", w.decorationOptionsHtml_("dtf").includes("DTF transfer (switched off)") && !w.decorationOptionsHtml_("").includes("DTF"));
  ok("…and only offers what includeKeys allows", !w.decorationOptionsHtml_("embroidery", { includeKeys: ["dtf", "sublimation"] }).includes("Embroidery") && w.decorationOptionsHtml_("embroidery", { includeKeys: ["dtf", "sublimation"] }).includes("Sublimation"));
  ok("…a name that isn't a type is never added", !w.decorationOptionsHtml_("zzz").includes("zzz"));
  scripted = [{ action: "getDecorationSettings", status: 500, body: { status: "error", message: "down" } }];
  ok("when the server can't be read, the list read is nothing (and the page keeps its own)", (await w.loadDecorationTypes_(true)) === null && same(w.decorationTypesOn_(), ["embroidery", "sublimation"]));
  scripted = [{ action: "getDecorationSettings", status: 200, body: { status: "ok", note: "no list" } }];
  ok("an answer without a list is also nothing", (await w.loadDecorationTypes_(true)) === null);
  reset();
  const first = await w.loadDecorationTypes_(true);
  ok("a read answers the types, the registry and the prices", !!first && same(first.types, KEYS) && first.registry.length === 6 && !!first.pricing.vinyl);
  await w.loadDecorationTypes_(); await w.loadDecorationTypes_();
  ok("…and is asked for again at most once a minute unless forced", of("getDecorationSettings").length === 1);
  await w.loadDecorationTypes_(true);
  ok("…a forced read goes to the server", of("getDecorationSettings").length === 2);
  ok("the list came back to all six", same(w.decorationTypesOn_(), KEYS) && w.decorationLabel_("vinyl") === "Vinyl / heat transfer");

  console.log("\n" + counts().passed + " checks passed");
})().catch(e => { console.log("test379 crashed:", false); console.error(e); process.exit(1); });
