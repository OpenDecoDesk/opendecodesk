process.env.TZ = "UTC";
const fs = require("fs");
const { storefrontPage } = require("./testlib/storefront-page");
const { createD1 } = require("./testlib/d1-shim.js");
const { ok, counts } = require("./testlib/check");
const roles = require("./testlib/roles");
const { JSDOM, ResourceLoader, VirtualConsole } = require("jsdom");

// Phase 5, the admin page's other branches (public/admin.js): what each decoration screen does when the server's answer is
// thin or missing (a list with no registry or prices, an unknown type, a read that fails), when a role can't see something,
// when a piece of the page is gone by the time an answer comes back, and the paths a refusal or a cancel takes. All of it in
// jsdom with the real orders.js / db.js on sql.js behind fetch; an answer is replaced (script) where the real server would
// not give that one. Covered here:
//   the helpers (the list when nothing has said, options with nothing picked, a read with no prices),
//   Global settings -> Decoration types (a list with no registry, no prices, a type the page doesn't know; the form wired,
//   read and checked with parts missing; a read that throws draws no section),
//   the product form's price helpers (a design with no stitch record or one that can't be read, the price refused, the
//   page changing while a price is coming, a screen print's colours and locations, Use this with nothing to add) and the
//   Decoration select's hide / show with nothing on the form,
//   the new-product wizard (an unknown or switched-off answer, no types on, the designs step for each type, a new graphic
//   image, the mockups list and the product it builds), the Run order page and its cards with sparse answers (Mark made
//   cancelled or refused, Undo, no blank), graphics (Printed by empty, a transfer's kind label), the order's Digitizing…
//   button (no order, the script can't load, the order's items), the vendors list, the notices roll-up kinds, the Pricing
//   analysis table's decoration column, the bulk due-date window, and who lands where.
// Invented data only.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async (env, host, key, request, msg, need) => roleAllows(DEFAULT_ROLES[globalThis.__role385] || null, need) ? null : jsonResponse({ status: 'error', message: 'Your role can\\'t do that here.' }, 403);\n" +
  "const adminActor = () => 'owner@example.test';\n" + roles.adminAs({ roleFrom: "globalThis.__role385" }) + "\n" + strip(read("functions/_lib/permissions.js")) + "\n" +
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
  globalThis.__role385 = "admin";
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

  const adminJs = read("public/admin.js"), dgJs = read("public/admin-digitizing.js");
  const sent = [], toasts = [], served = [];
  let scripted = [];       // [{ action, status, body, keep, delay }]: the next request for that action is answered with this
  let dgMode = "ok";       // "fail": /admin-digitizing.js can't be fetched
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
  class Loader extends ResourceLoader {
    fetch(url) {
      served.push(String(url));
      if (/\/admin\.js(\?|$)/.test(url)) return Promise.resolve(Buffer.from(adminJs));
      if (/\/admin-digitizing\.js(\?|$)/.test(url)) return dgMode === "fail" ? Promise.reject(new Error("offline")) : Promise.resolve(Buffer.from(dgJs));
      return Promise.resolve(Buffer.from(""));
    }
  }
  const vc = new VirtualConsole();
  vc.sendTo(console, { omitJSDOMErrors: true });
  vc.on("jsdomError", (e) => { if (!/Not implemented|Could not load script/.test(e.message)) console.error(e); });
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
          const i = scripted.findIndex(s => s.action === b.action && (!s.match || s.match(b)));
          if (i >= 0) { const s = scripted[i]; if (!s.keep) scripted.splice(i, 1); if (s.delay) await pause(s.delay); return reply(s.status || 200, s.body); }
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
  const asRoles = (pageRole, serverRole) => { globalThis.__role385 = serverRole || pageRole; w.eval(roles.asRole(pageRole, { name: "Tester", email: "tester@example.test" })); };
  const modal = () => { const all = qa(".admin-modal"); return all[all.length - 1] || null; };
  const KEYS = ["embroidery", "dtf", "screenprint", "vinyl", "dtg", "sublimation"];
  const setDeco = async (types, pricing) => { await must({ action: "updateDecorationSettings", types, pricing }); await w.loadDecorationTypes_(true); };
  const stage = (html) => { const h = d.createElement("div"); h.innerHTML = html; d.body.appendChild(h); return h; };
  asRoles("admin");
  w.renderAdminNav();

  // ==============================================================================================================
  console.log("=== The helpers when nothing has said yet, and an answer with parts missing ===");
  const realOn = w.eval("decorationOn_");
  w.eval("decorationOn_ = undefined");
  ok("with no list and no shop page to ask, every type counts as on", w.decorationIsOn_("vinyl") === true && w.decorationIsOn_("embroidery") === true);
  w.decorationOn_ = realOn;
  ok("with the shop page's own answer back, the same", w.decorationIsOn_("vinyl") === true && w.eval("typeof decorationOn_") === "function");
  const optAll = w.decorationOptionsHtml_();
  ok("options with nothing picked mark nothing selected and offer the types that are on", !/selected/.test(optAll) && /value="embroidery"/.test(optAll) && /value="dtf"/.test(optAll));
  ok("…and a null pick is the same as none", !/selected/.test(w.decorationOptionsHtml_(null)));
  scripted = [{ action: "getDecorationSettings", body: { status: "ok", types: ["embroidery", "vinyl"] } }];
  const thin = await w.loadDecorationTypes_(true);
  ok("a list with no prices and no registry is still taken, with empty prices", !!thin && same(thin.types, ["embroidery", "vinyl"]) && same(thin.pricing, {}) && thin.registry === undefined);
  ok("…the screens follow the list", same(w.decorationTypesOn_(), ["embroidery", "vinyl"]));
  const cached = await w.loadDecorationTypes_();
  ok("…and that read is kept for a minute like any other", same(cached.types, ["embroidery", "vinyl"]) && same(cached.pricing, {}));

  console.log("\n=== Global settings -> Decoration types, drawn from a thin answer ===");
  let h = stage(w.decorationSettingsHtml_(null));
  ok("with no answer at all, all six types are drawn from the page's own names, none ticked", qa("#gDecoration .gDecoType").length === 6 && qa("#gDecoration .gDecoType").every(b => !b.checked) &&
    same(qa("#gDecoration .g-feat-head strong").map(e => text(e)), ["Embroidery", "DTF transfer", "Screen print", "Vinyl / heat transfer", "DTG", "Sublimation"]));
  ok("…every price box reads its starting value (money 0.00, whole numbers 0, most colours 1)", id("gDeco-vinyl-priceCents").value === "0.00" && id("gDeco-embroidery-minStitches").value === "0" && id("gDeco-screenprint-maxColors").value === "1");
  h.remove();
  h = stage(w.decorationSettingsHtml_({ types: ["embroidery"], registry: [], pricing: undefined }));
  ok("an empty registry is the same as none", qa("#gDecoration .gDecoType").length === 6 && qa("#gDecoration .gDecoType").filter(b => b.checked).length === 1);
  h.remove();
  h = stage(w.decorationSettingsHtml_({ types: ["mystery", "vinyl"], registry: [{ key: "mystery" }, { key: "vinyl", label: "Heat press" }], pricing: { vinyl: { priceCents: 250 } } }));
    ok("a type the page doesn't know is still drawn and ticked, without a name, words or prices", !!q("#gFeatRow-mystery") && q('#gFeatRow-mystery .gDecoType').checked && text(q("#gFeatRow-mystery .g-feat-head strong")) === "" && text(q("#gFeatRow-mystery .g-feat-desc")) === "" && !q("#gPanel-mystery input"));
  ok("…its panel carries the printed types' note, and a registry label is the name shown", /A job costs the price per location/.test(text(id("gPanel-mystery"))) && text(q("#gFeatRow-vinyl .g-feat-head strong")) === "Heat press" && id("gDeco-vinyl-priceCents").value === "2.50");
  ok("…a type missing from the prices reads its starting values", id("gDeco-vinyl-costCents").value === "0.00");
  h.remove();
  h = stage(w.decorationSettingsHtml_({ registry: [{ key: "dtg" }] }));
  ok("an answer with no list of types ticks nothing", qa("#gDecoration .gDecoType").length === 1 && !q("#gDecoration .gDecoType").checked && text(q("#gFeatRow-dtg .g-feat-head strong")) === "DTG");
  h.remove();

  console.log("\n=== …wired, read and checked with parts missing ===");
  ok("with no section on the page, wiring does nothing, there is nothing to read and no problem", w.decorationSettingsWire_() === undefined && w.decorationSettingsCollect_() === null && w.decorationSettingsProblem_() === null);
  h = stage(w.decorationSettingsHtml_({ types: ["embroidery", "screenprint"], registry: [{ key: "embroidery" }, { key: "screenprint" }], pricing: {} }));
  w.decorationSettingsWire_();
  id("gDeco-screenprint-costCents").remove();
  type(id("gDeco-screenprint-inkColorCents"), "1.25");
  const got = w.decorationSettingsCollect_();
  ok("a price box that is gone is skipped, the rest are read in cents", !("costCents" in got.pricing.screenprint) && got.pricing.screenprint.inkColorCents === 125 && same(got.types, ["embroidery", "screenprint"]) && got.bad.length === 0);
  ok("an unknown type's name is the key", w.decoTypeLabel_("mystery") === "mystery" && w.decoTypeLabel_("vinyl") === "Vinyl / heat transfer");
  h.remove();
  h = stage(`<div id="gDecoration"></div>`);
  const none = w.decorationSettingsProblem_();
  ok("a section with no ticks at all still asks for one, and has no box to point at", none && /tick at least one decoration type/.test(none.text) && same(none.ids, []));
  h.remove();

  console.log("\n=== The settings page when the types can't be read ===");
  const realLoad = w.loadDecorationTypes_;
  w.loadDecorationTypes_ = async () => { throw new Error("offline"); };
  reset();
  await w.renderGlobalSettings(app); await idle();
  ok("a read that throws draws no Decoration types section, and the rest of the page is there", !id("gDecoration") && qa("#app h2").length > 3);
  await w.submitGlobalSettings(); await idle();
  ok("…and saving sends no decoration section", of("saveGlobalSettingsAll").every(b => !(b.settings && b.settings.decoration)) && of("updateDecorationSettings").length === 0);
  w.loadDecorationTypes_ = realLoad;
  await setDeco(KEYS, {});

  // ==============================================================================================================
  console.log("\n=== The product form's price helpers: designs that can't be counted, a price that isn't given ===");
  const FULL = { stitchPricing: true, centsPer1000: 100, minStitches: 0, minCents: 0 };
  const PRICES = { embroidery: FULL, screenprint: { inkColorCents: 150, screenSetupCents: 2000, reorderSetupCents: 1000, costCents: 20, maxColors: 6 },
    vinyl: { costCents: 75, priceCents: 300, setupCents: 500 }, dtg: { costCents: 0, priceCents: 0, setupCents: 0 } };
  await setDeco(KEYS, PRICES);
  const realDeco = await must({ action: "getDecorationSettings" });
  const FORM = `<select id="prodFormDecoration"><option value="embroidery">Embroidery</option><option value="screenprint">Screen print</option><option value="vinyl">Vinyl</option></select>
    <input id="prodFormPricingMode" value="flat"><input id="prodFormFlatPrice" value="20"><div id="prodDecoHelper"></div>`;
  const designReply = (n, body, status) => scripted.push({ action: "getDesign", keep: true, match: (b) => b.id === n, status, body });
  const priceReply = (body, extra) => scripted.push(Object.assign({ action: "priceDecoration", keep: true, body }, extra || {}));
  const unscript = () => { scripted = []; };
  const setCtx = (...ids) => { w._productDesignCtx = { rows: ids.map(n => ({ designId: n })) }; w.eval("decoStitchCache_.clear()"); };
  designReply(901, { status: "ok", versions: [{ stitchCount: 4000 }] });
  designReply(902, { status: "ok", design: { name: "Example Patch" } });
  designReply(903, { status: "error", message: "gone" }, 500);
  designReply(904, { status: "ok", versions: [{ stitchCount: 2000 }] });
  let host = stage(FORM);
  const helper = () => id("prodDecoHelper");
  setCtx(901, 902, 903);
  pick(id("prodFormDecoration"), "embroidery");
  await w.productDecorationHelper_();
  ok("a design whose answer has no versions, and one that can't be read, are both counted as having no stitch count", /By stitch count: \$4\.00 per piece/.test(text(helper())) && /2 designs have no stitch count yet, so it isn't counted/.test(text(helper())));
  ok("…the one that has a count is priced alone", of("priceDecoration").some(b => b.type === "embroidery" && b.params.stitches === 4000));
  setCtx(901, 904);
  priceReply({ status: "ok", unitCents: 600 });
  await w.productDecorationHelper_();
  ok("a price with no note is shown without one (and no word undefined)", /By stitch count: \$6\.00 per piece/.test(text(helper())) && !/undefined|null/.test(text(helper())) && /Use this/.test(text(helper())));
  ok("…every stitch count was added up (4,000 + 2,000) and asked of the server", of("priceDecoration").some(b => b.params.stitches === 6000));
  id("prodStitchUse").dataset.cents = "not a number";
  id("prodStitchUse").click();
  ok("a Use this whose amount can't be read adds nothing to the price, and still says it is done", id("prodFormFlatPrice").value === "20.00" && id("prodStitchUse").disabled && id("prodStitchUse").textContent === "Added");
  unscript(); designReply(901, { status: "ok", versions: [{ stitchCount: 4000 }] });
  priceReply({ status: "error", message: "no" });
  w.eval("decoStitchCache_.clear()");
  await w.productDecorationHelper_();
  ok("a price the server answers with an error shows no stitch row", !/By stitch count/.test(text(helper())) && helper().innerHTML === "");
  unscript();
  ok("adding to the prices with no form on the page adds to nothing", (host.remove(), w.decoAddToPrices_(100) === false));
  ok("a helper with nowhere on the page to draw does nothing at all", (await w.productDecorationHelper_()) === undefined);

  console.log("\n=== …and a page that changes while an answer is coming ===");
  const wasLoaded = (n) => of(n).length;
  host = stage(FORM); setCtx(901); designReply(901, { status: "ok", versions: [{ stitchCount: 4000 }] });
  w.eval("_decorationPricing_ = null");
  scripted.push({ action: "getDecorationSettings", delay: 60, body: realDeco });
  let run = w.productDecorationHelper_(); host.remove(); await run;
  ok("the form closed while the prices were being read: nothing is drawn into it", helper() === null && host.querySelector("#prodDecoHelper").innerHTML === "");
  host = stage(FORM); pick(id("prodFormDecoration"), "vinyl");
  scripted.push({ action: "getDecorationSettings", delay: 60, body: realDeco });
  w.eval("_decorationPricing_ = null");
  run = w.productDecorationHelper_(); host.remove(); await run;
  ok("…the same for a printed type's suggested price, which has nothing else to wait for", host.querySelector("#prodDecoHelper").innerHTML === "");
  host = stage(FORM);
  scripted.push({ action: "getDecorationSettings", delay: 60, body: realDeco });
  w.eval("_decorationPricing_ = null");
  run = w.productDecorationHelper_(); const second = w.productDecorationHelper_(); await Promise.all([run, second]);
  ok("a second draw started while the first waits wins, the first draws nothing of its own", /By stitch count/.test(text(helper())) && qa(".deco-helper-row").length === 1);
  host.remove(); host = stage(FORM); w.eval("decoStitchCache_.clear()");
  unscript(); designReply(901, { status: "ok", versions: [{ stitchCount: 4000 }] }); scripted[0].delay = 60;
  reset();
  run = w.productDecorationHelper_(); await pause(15); host.remove(); await run; await idle();
  ok("the form closed while a design's stitches were being read: nothing is drawn, and no price is asked for", host.querySelector("#prodDecoHelper").innerHTML === "" && of("priceDecoration").length === 0);
  host = stage(FORM); w.eval("decoStitchCache_.clear()"); unscript();
  designReply(901, { status: "ok", versions: [{ stitchCount: 4000 }] }); priceReply({ status: "ok", unitCents: 400, note: "x" }, { delay: 60 });
  run = w.productDecorationHelper_(); await pause(30); host.remove(); await run;
  ok("the form closed while the price was being worked out: nothing is drawn", host.querySelector("#prodDecoHelper").innerHTML === "");
  host = stage(FORM); unscript(); w.eval("decoStitchCache_.clear()");

  console.log("\n=== A suggested price for a printed type with parts missing ===");
  pick(id("prodFormDecoration"), "screenprint");
  w.eval("_decorationPricing_ = null");
  scripted.push({ action: "getDecorationSettings", keep: true, status: 500, body: { status: "error", message: "down" } });
  priceReply({ status: "ok", unitCents: 300 });
  await w.productDecorationHelper_();
  ok("when the prices can't be read, a screen print still gets its helper, with up to 6 colours", !!id("prodDecoColors") && id("prodDecoColors").max === "6");
  await idle();
  ok("a price with no setup and no note is just the per-piece price", text(id("prodDecoResult")) === "$3.00 per piece");
  unscript(); priceReply({ status: "ok", unitCents: 300 });
  const resEl = id("prodDecoResult");
  id("prodDecoLocs").remove();
  type(id("prodDecoColors"), "0"); await idle();
  const last = () => of("priceDecoration")[of("priceDecoration").length - 1];
  ok("a locations box that is gone counts as one location, and colours under 1 as one colour", last().params.locations === 1 && last().params.colors === 1 && last().params.reorder === false);
  id("prodDecoReorder").remove();
  type(id("prodDecoColors"), "2"); await idle();
  ok("a reorder tick that is gone counts as not a reorder", last().params.colors === 2 && last().params.reorder === false);
  priceReply({ status: "ok", unitCents: 900, setupCents: 100 }, { delay: 50 });
  scripted.unshift(scripted.pop());
  type(id("prodDecoColors"), "3"); await pause(10); const before = text(resEl); host.remove(); await pause(120);
  ok("the form closed while the price was coming: the answer isn't written anywhere", text(resEl) === before);
  unscript();
  w._productDesignCtx = null;

  console.log("\n=== The Decoration select and what the form sends, with nothing on the form ===");
  ok("hiding and showing with no form on the page does nothing", w.productDecorationVisibility_() === undefined);
  let called = 0; const realEnsure = w.ensureDecorationUi_;
  w.ensureDecorationUi_ = () => { called++; return Promise.resolve(); };
  w.productDecorationRefresh_();
  ok("redrawing the price helper with none on the page doesn't even ask for the page's pieces", called === 0);
  host = stage(FORM);
  w.ensureDecorationUi_ = () => Promise.reject(new Error("nope"));
  w.productDecorationRefresh_(); await pause(40);
  ok("…and when they can't load, nothing is thrown and the helper stays empty", text(helper()) === "");
  w.ensureDecorationUi_ = realEnsure;
  host.remove();

  // ==============================================================================================================
  console.log("\n=== The order's Digitizing… button: no order, the script that can't load, the order's lines ===");
  const closeModals = () => { qa(".admin-modal, .admin-modal-overlay, .admin-pass-overlay").forEach(e => e.remove()); };
  const btn = stage(`<button type="button" id="dgBtn" data-admin-action="showOrderDigitizing_" data-org="club" data-order="O-9">Digitizing…</button>`);
  w.eval("window._ordersCache = undefined");
  reset();
  id("dgBtn").click(); await pause(30);
  ok("the button's own action opens the order's records; with no orders list at all it says to refresh", toasts.length === 1 && toasts[0].m === "Order not found — refresh the list." && toasts[0].err);
  reset();
  w.eval("window._ordersCache = { band: [{ orderId: 'O-1', items: [] }], club: undefined }");
  await w.showOrderDigitizing_("club", "O-9");
  ok("an order that is in no shop's list, with a shop that has no list, says to refresh too", toasts.length === 1 && toasts[0].m === "Order not found — refresh the list.");
  reset(); dgMode = "fail";
  w.eval("window._ordersCache = { band: [{ orderId: 'O-9', items: [{ id: 5, name: 'Example Cap' }, { itemId: 6, name: 'Example Tee' }, { id: 7, name: 'Example Gone', cancelDate: '2026-01-02' }] }] }");
  await w.showOrderDigitizing_("club", "O-9");
  ok("an order listed under another shop is found, and when the digitizing script can't load the toast says so", toasts.length === 1 && toasts[0].m === "Couldn't load the digitizing records" && toasts[0].err && !modal());
  dgMode = "ok"; reset();
  const realDg = w.ensureDigitizingUi_;
  w.ensureDigitizingUi_ = () => Promise.reject({});
  await w.showOrderDigitizing_("club", "O-9");
  ok("a failure that says nothing still gets the plain words", toasts.length === 1 && toasts[0].m === "Couldn't load the digitizing records" && toasts[0].err);
  w.ensureDigitizingUi_ = realDg; reset();
  await w.showOrderDigitizing_("club", "O-9"); await wait(() => modal() && q("[data-dg-new]")); await idle();
  ok("with the script there, the window opens for that order", !!modal() && /Outside digitizing . O-9/.test(text(modal())) && served.some(u => /admin-digitizing\.js/.test(u)));
  q("[data-dg-new]").click(); await wait(() => id("dgItem")); await idle();
  ok("Send to digitizer offers the order's lines that aren't cancelled: by id, or by item id when there is no id", same([...id("dgItem").options].map(o => [o.value, text(o)]), [["", "Not for one line"], ["5", "Example Cap"], ["6", "Example Tee"]]));
  closeModals(); reset();
  w.eval("window._ordersCache = { club: [{ orderId: 'O-10' }] }");
  await w.showOrderDigitizing_("club", "O-10"); await wait(() => modal() && q("[data-dg-new]")); await idle();
  q("[data-dg-new]").click(); await wait(() => id("dgName")); await idle();
  ok("an order with no lines at all still opens, with no line to pick", !!id("dgName") && !id("dgItem"));
  closeModals(); btn.remove();

  console.log("\n=== A role that can't see invoices, who lands where, the bulk due date ===");
  w.eval(roles.asRole("admin", { name: "Tester", email: "tester@example.test" }) + ' adminPerms = Object.assign({}, adminPerms, { "orders.invoices": "none" });');
  const cell = d.createElement("div"); cell.innerHTML = w.adminActionCell({ orgId: "club" }, { orderId: "O-1", items: [{ id: 1, name: "Example Cap", qty: 1 }], paid: true, balanceDue: 0 });
  ok("an orders row without invoice access has its other buttons and none of the invoice's", !!cell.querySelector('[data-admin-action="showOrderDates_"]') && !cell.querySelector('[data-admin-action="downloadOrderPdf_"]'));
  asRoles("admin");
  const cell2 = d.createElement("div"); cell2.innerHTML = w.adminActionCell({ orgId: "club" }, { orderId: "O-1", items: [{ id: 1, name: "Example Cap", qty: 1 }], paid: true, balanceDue: 0 });
  ok("…while the admin's row has the invoice's PDF button", !!cell2.querySelector('[data-admin-action="downloadOrderPdf_"]'));
  ok("someone whose role opens the first page on the list lands on Home", w.adminFirstPage_() === "home");
  w.eval(roles.asRole("admin") + ' adminPerms = {}; adminMe = { role: "none" };');
  const lands = w.adminFirstPage_();
  ok("a role that can open nothing on that list is sent to the first page its own menu has", lands === "security");
  asRoles("admin");
  const cb = stage(`<input type="checkbox" class="order-select" data-order="O-1" checked>`);
  reset();
  const dueP = w.bulkSetDueDate("club"); await pause(20);
  const dueBox = q(".admin-pass-overlay");
  ok("Set due date opens a window that says soonest-due orders run first on the Run order", !!dueBox && /Due date . 1 order/.test(text(dueBox)) && /soonest-due orders run first on the Run order/.test(text(dueBox)));
  q(".admin-pass-cancel").click(); await dueP;
  ok("…cancelling it sends nothing", of("bulkSetDueDate").length === 0 && !q(".admin-pass-overlay"));
  cb.remove();

  console.log("\n=== Pricing analysis: the decoration's cost, the tax and overhead headings ===");
  const arow = (extra) => Object.assign({ group: "", size: "M", price: 20, flags: [], blank: 5, blankSource: "vendor", card: 0.9, tax: 1.1, transfer: 0, decoration: 0, supplies: 0.2, overhead: 0, costs: 8, income: 12, hourly: null, map: null }, extra || {});
  const setting = { cardPct: 2.9, cardFixed: 0.3, taxMode: "exclusive", shopRate: 24 };
  const tableOf = (a, s) => { const t = d.createElement("div"); t.innerHTML = w.pricingTableHtml_(a, s); return t; };
  let tb = tableOf({ rows: [arow({ decoration: 0.75, overhead: 1.5 }), arow({ size: "L", decoration: 0, overhead: 0 })], decorationLabel: "", decoration: "vinyl" }, setting);
  ok("a printed type's cost gets a column named from the type (Vinyl / heat transfer) when none is given", /Vinyl \/ heat transfer/.test(text(tb.querySelector("thead"))));
  ok("…a row with no cost set shows a dash, one with a cost shows it", /\$0\.75/.test(text(tb.querySelectorAll("tbody tr")[0])) && !!tb.querySelectorAll("tbody tr")[1].querySelector('[title="No cost is set for this type yet"]'));
  ok("…with the shop's hourly rate saved there is an Overhead column: a dash where no run time was typed", /Overhead/.test(text(tb.querySelector("thead"))) && !!tb.querySelectorAll("tbody tr")[1].querySelector('[title="No run time typed: no overhead charged"]') && /\$1\.50/.test(text(tb.querySelectorAll("tbody tr")[0])));
  ok("…with sales tax added on top the Tax heading says it costs the shop nothing", /costs you nothing/.test(tb.querySelector('th[title*="costs you nothing"]') ? tb.querySelector('th[title*="costs you nothing"]').getAttribute("title") : ""));
  tb = tableOf({ rows: [arow({ decoration: 0 })], decoration: "mystery", decorationCost: 0.5 }, { cardPct: 2.9, cardFixed: 0.3, taxMode: "inclusive" });
  ok("a decoration the page has no name for is just called Decoration, and a cost on the product alone gives the column", /Decoration/.test(text(tb.querySelector("thead"))) && !/Overhead/.test(text(tb.querySelector("thead"))));
  ok("…tax inside the price says it is backed out", /backed out of the price/.test(tb.querySelector('th[title*="backed out"]') ? tb.querySelector('th[title*="backed out"]').getAttribute("title") : ""));
  tb = tableOf({ rows: [arow()], decoration: "" }, { cardPct: 2.9, cardFixed: 0.3 });
  ok("a product with no decoration cost has no decoration column", !/Decoration|Vinyl/.test(text(tb.querySelector("thead"))));

  // ==============================================================================================================
  console.log("\n=== The new-product wizard: the choices when the list is odd ===");
  const wizHost = stage("");
  const setWiz = (answers, product, data) => w.eval("_wiz = { orgId: 'club', org: {}, state: { " + (answers === null ? "" : "answers: " + JSON.stringify(answers) + ", ") + "products: [" + JSON.stringify(product || {}) + "] }, data: " + JSON.stringify(data || {}) + " };");
  const shopScreen = () => { const sc = w.wizScreen_({ id: "decorate" }); wizHost.innerHTML = sc.html; return sc; };
  const prodScreen = (step) => { const sc = w.wizProductScreen_({ productIndex: 0, productStep: step || "decoration" }); wizHost.innerHTML = sc.html; return sc; };
  const choices = (name) => [...wizHost.querySelectorAll('input[name="' + name + '"]')].map(i => i.value);
  const checkedOf = (name) => (wizHost.querySelector('input[name="' + name + '"]:checked') || {}).value;
  await setDeco(KEYS, PRICES);
  w.eval("DECORATION_KEYS_.push('pad')");
  w._decorationTypes = ["embroidery", "pad"];
  const pad = w.wizDecoChoices_("");
  ok("a type that has no words of its own yet is offered with none", same(pad.map(c => c[0]), ["embroidery", "pad"]) && pad[1][2] === "" && pad[0][2] !== "");
  const gone = w.wizDecoChoices_("zzz");
  ok("a saved answer the page has never heard of is kept, marked switched off, with no words", gone[gone.length - 1][0] === "zzz" && gone[gone.length - 1][1] === "zzz (switched off)" && gone[gone.length - 1][2] === "");
  w.eval("DECORATION_KEYS_.pop()");
  ok("(the list of types is back as it was)", w.eval("DECORATION_KEYS_.length") === 6);
  w._decorationTypes = [];
  ok("with no type on at all there is nothing to offer, and embroidery is the starting choice", same(w.wizDecoChoices_(""), []) && w.eval("wizDecoDefault_()") === "embroidery");
  setWiz({}); shopScreen();
  ok("the shop-wide question then has no choices", choices("wizDeco").length === 0);
  const sc0 = shopScreen();
  ok("…saving it with nothing picked takes the starting choice", (await sc0.save()) === "" && w.eval("_wiz.state.answers.decoration") === "embroidery");
  await w.loadDecorationTypes_(true);
  setWiz({}); const sc1 = shopScreen();
  wizHost.querySelectorAll('input[name="wizDeco"]').forEach(i => { i.checked = false; });
  ok("with types on and nothing ticked, saving the shop-wide answer takes the first one that is on", (await sc1.save()) === "" && w.eval("_wiz.state.answers.decoration") === "embroidery");
  setWiz(null, { colors: [] });
  prodScreen();
  ok("a product's own decoration screen works before any shop-wide answer has been given, starting on the first type on", checkedOf("wizPDeco") === "embroidery" && choices("wizPDeco").length === 6 + 1);
  setWiz({}, {}, {});
  await w.wizLoad_("locations");
  ok("loading wizard lists also asks which decoration types are on", of("getDecorationSettings").length >= 1 && Array.isArray(w.eval("_wiz.data.locations")));

  console.log("\n=== The wizard's designs step, for each decoration ===");
  const loc1 = (await must({ action: "saveLocation", location: { name: "Left chest" } })).id, loc2 = (await must({ action: "saveLocation", location: { name: "Back" } })).id;
  const crestDesign = (await must({ action: "saveDesign", org: "club", design: { name: "Example Crest" } })).id;
  const sg = async (g) => (await must({ action: "saveGraphic", org: "club", graphic: Object.assign({ visible: true, imageUrl: "https://example.com/g.png", allowedLocations: [], allowedGarmentColors: [], inkColors: [] }, g) })).id;
  const gEmb = await sg({ name: "Example Crest", kind: "embroidery", designId: crestDesign });
  const gDtf = await sg({ name: "Example Print", kind: "transfer" });
  const gScr = await sg({ name: "Example Screen", kind: "transfer", decoration: "screenprint" });
  const gVin = await sg({ name: "Example Vinyl", kind: "transfer", decoration: "vinyl" });
  await setDeco(["embroidery", "dtf", "screenprint", "dtg"], PRICES);
  const designs = async (p, data) => { setWiz({}, p, data); const sc = prodScreen("designs"); await sc.wire(wizHost); return sc; };
  const optsOf = (sel) => [...wizHost.querySelectorAll(sel + " option")].map(o => o.value);
  await designs({ decoration: "embroidery" });
  ok("an embroidery product: a location and an embroidery graphic to pick, and no printed one", !!wizHost.querySelector("#wizFxLoc") && !wizHost.querySelector("#wizFxT") && same(optsOf("#wizFxPic"), ["", String(gEmb)]) && optsOf("#wizFxLoc").includes(String(loc1)) && optsOf("#wizFxLoc").includes(String(loc2)));
  await designs({ decoration: "screenprint" });
  ok("a screen print product: the printed side is named for the type, and there is no embroidery side", /^Screen print/.test(text(wizHost.querySelector(".wiz-field"))) && !!wizHost.querySelector("#wizFxT") && !wizHost.querySelector("#wizFxPic") && optsOf("#wizFxT").includes(String(gScr)));
  await designs({ decoration: "dtf" });
  ok("a DTF product says Printed (DTF)", /^Printed \(DTF\)/.test(text(wizHost.querySelector(".wiz-field"))));
  await designs({ decoration: "both" });
  ok("Both has the embroidery side and the printed one", !!wizHost.querySelector("#wizFxPic") && !!wizHost.querySelector("#wizFxT"));
  await designs({ decoration: "both", designMode: "options", options: { locations: [{ locationId: loc1, graphicIds: [gDtf] }, { locationId: loc2 }] } });
  const chip = (n) => [...wizHost.querySelectorAll(".wiz-chip")].find(c => text(c).startsWith(n));
  ok("options: each ticked location lists the graphics of the types that are on, named by the type", !!chip("Example Crest") && /Embroidery/.test(text(chip("Example Crest"))) && !!chip("Example Screen") && /Screen print/.test(text(chip("Example Screen"))) && /DTF/.test(text(chip("Example Print"))));
  ok("…a graphic of a type that is switched off is not offered", !chip("Example Vinyl"));
  ok("…the ones picked are ticked, and a location with no list yet has none ticked", wizHost.querySelector('.wizLocG[data-loc="' + loc1 + '"][value="' + gDtf + '"]').checked && !wizHost.querySelector('.wizLocG[data-loc="' + loc2 + '"][value="' + gDtf + '"]').checked);
  ok("…both kinds have their own Add image under the location (Embroidery: and Printed:)", /Printed:/.test(text(wizHost)) && /Embroidery:/.test(text(wizHost)));
  await designs({ decoration: "dtf", designMode: "options", options: { locations: [{ locationId: loc1, graphicIds: [] }] } });
  ok("a DTF product's options offer printed graphics only, and one kind of Add image", !chip("Example Crest") && !!chip("Example Print") && !/Printed:/.test(text(wizHost)));
  await designs({ decoration: "embroidery", designMode: "options", options: { locations: [{ locationId: loc1, graphicIds: [] }] } });
  ok("an embroidery product's options offer the embroidery graphic", !!chip("Example Crest") && !chip("Example Print"));

  console.log("\n=== …adding an image there ===");
  const realUp = w.uploadImage;
  w.uploadImage = async (file) => "https://example.com/uploads/" + file.name;
  await designs({ decoration: "screenprint" });
  const pickFile = (inp, name) => { Object.defineProperty(inp, "files", { value: [{ name }], configurable: true }); fire(inp, "change"); };
  reset();
  pickFile(wizHost.querySelector('[data-add-img="transfer"]'), "Club_logo.png");
  await wait(() => toasts.length && /Graphic added/.test(toasts[0].m)); await idle();
  const made = of("saveGraphic")[0];
  ok("an image added for a screen print product is saved as a screen print graphic", !!made && made.graphic.kind === "transfer" && made.graphic.decoration === "screenprint" && made.graphic.name === "Club logo");
  ok("…the list is read again and the new graphic is the one picked for the printed side", /Club logo/.test(wizHost.querySelector("#wizFxT").selectedOptions[0].textContent) && w.eval("_wiz.state.products[0].fixed.transferGraphicId") === Number(wizHost.querySelector("#wizFxT").value));
  w.uploadImage = async () => { throw new Error("That file is too big"); };
  await designs({ decoration: "embroidery" }); reset();
  pickFile(wizHost.querySelector('[data-add-img="embroidery"]'), "Big.png"); await wait(() => toasts.length); await idle();
  ok("an image that can't be added says why, and nothing is saved", toasts[0].m === "That file is too big" && toasts[0].err && of("saveGraphic").length === 0);
  w.uploadImage = async () => { throw {}; };
  reset(); pickFile(wizHost.querySelector('[data-add-img="embroidery"]'), "Big.png"); await wait(() => toasts.length); await idle();
  ok("…with no reason given, the plain words", toasts[0].m === "Couldn't add that image." && toasts[0].err);
  w.uploadImage = realUp;

  console.log("\n=== …the mockups list and the product that is built ===");
  const gridOf = (p) => w.wizMockupGrid_(p);
  ok("an embroidery product's fixed graphic and location make one mockup", same(gridOf({ decoration: "embroidery", fixed: { pictureGraphicId: gEmb, locationId: loc1 } }), [{ locationId: loc1, graphicId: gEmb, fixed: true }]));
  ok("…with no location yet, none", same(gridOf({ decoration: "embroidery", fixed: { pictureGraphicId: gEmb } }), []));
  ok("a printed product's fixed graphic and location make one (the printed side only)", same(gridOf({ decoration: "vinyl", fixed: { pictureGraphicId: gEmb, locationId: loc1, transferGraphicId: gVin, transferLocationId: loc2 } }), [{ locationId: loc2, graphicId: gVin, fixed: true }]));
  ok("Both makes one for each side", gridOf({ decoration: "both", fixed: { pictureGraphicId: gEmb, locationId: loc1, transferGraphicId: gDtf, transferLocationId: loc2 } }).length === 2);
  ok("with options the mockups are the graphics offered at each location", same(gridOf({ decoration: "dtf", designMode: "options", options: { locations: [{ locationId: loc1, graphicIds: [gDtf, gScr] }] } }), [{ locationId: loc1, graphicId: gDtf }, { locationId: loc1, graphicId: gScr }]));
  const BLANK = { id: 5, name: "Example Tee", productType: "shirt", sizes: [{ color: "Navy", size: "M", vendorPrice: 5 }] };
  const build = async (p) => {
    setWiz({}, p, { blanks: [BLANK] }); reset(); unscript();
    scripted.push({ action: "buildProductFromBlank", body: { status: "ok", productId: "example-tee" } });
    const why = await w.wizBuildProduct_(w.eval("_wiz.state.products[0]"));
    return { why, body: of("buildProductFromBlank")[0] };
  };
  const base = { blankId: 5, colors: ["Navy"], sizes: ["M"], pricing: { method: "cost", amount: 10 } };
  let b = await build(Object.assign({}, base, { fixed: { pictureGraphicId: gEmb, locationId: loc1 } }));
  ok("a product with no decoration chosen is built as the first type that is on", b.why === "" && !!b.body && b.body.decoration === "embroidery");
  ok("…its embroidery graphic and location go out as the mockup, and the graphic's own design is the design, placed there", same(b.body.mockupGraphics, [{ locationId: loc1, graphicId: gEmb }]) && same(b.body.designs, [{ designId: crestDesign, placement: "Left chest", isMain: true }]));
  b = await build(Object.assign({}, base, { decoration: "embroidery", fixed: { pictureGraphicId: gEmb } }));
  ok("an embroidery graphic with no location yet sends no mockup (and the design with no placement)", same(b.body.mockupGraphics, []) && same(b.body.designs, [{ designId: crestDesign, placement: "", isMain: true }]));
  b = await build(Object.assign({}, base, { decoration: "screenprint", fixed: { transferGraphicId: gScr, transferLocationId: loc2 } }));
  ok("a screen print product is built as that type, its fixed graphic as a transfer, with no mockup and no design", b.body.decoration === "screenprint" && same(b.body.fixedTransfers, [{ locationId: loc2, graphicId: gScr, ink: "" }]) && same(b.body.mockupGraphics, []) && same(b.body.designs, []));
  b = await build(Object.assign({}, base, { decoration: "embroidery", designMode: "options", options: { locations: [{ locationId: loc1, graphicIds: [gEmb] }] } }));
  ok("a product that offers options sends its locations, and no mockup, design or fixed graphic", b.body.locations.length === 1 && b.body.locations[0].label === "Left chest" && same(b.body.mockupGraphics, []) && same(b.body.designs, []) && same(b.body.fixedTransfers, []));
  b = await build(Object.assign({}, base, { blankId: 99 }));
  ok("a blank that has gone says so and builds nothing", b.why === "This blank is no longer in Blanks." && !b.body);
  w.eval("_wiz = null");

  // ==============================================================================================================
  console.log("\n=== The wizard's graphic list when a graphic is shared by every shop ===");
  await setDeco(["embroidery", "dtf", "screenprint", "dtg"], PRICES);
  setWiz({}, { decoration: "dtf", designMode: "options", options: { locations: [{ locationId: loc1, graphicIds: [] }] } }, {});
  scripted.push({ action: "listGraphics", keep: true, body: { status: "ok", graphics: [{ id: 41, name: "Example Shared Mark", kind: "transfer", isGlobal: true, visible: true, imageUrl: "https://example.com/s.png" }] } });
  { const sc = prodScreen("designs"); await sc.wire(wizHost); }
  unscript();
  ok("a graphic every shop shares is marked with the globe wherever it is offered", /^🌐 Example Shared Mark/.test(text([...wizHost.querySelectorAll(".wiz-chip")].find(c => /Shared Mark/.test(text(c))))));
  wizHost.remove(); w.eval("_wiz = null");

  console.log("\n=== A price the page can't take, and what Run order will do ===");
  const realApi = w.hoopApi_;
  w.hoopApi_ = async () => ({ status: "error", message: "not a price" });
  ok("an answer that says error, even when it isn't thrown, is no price", (await w.decoPrice_("vinyl", { locations: 1 })) === null);
  w.hoopApi_ = async () => ({ status: "ok", unitCents: 5 });
  ok("…and one that is fine is the price", (await w.decoPrice_("vinyl", { locations: 1 })).unitCents === 5);
  w.hoopApi_ = realApi;
  const pv = (extra) => Object.assign({ always: [{ designName: "Example Crest", label: "Left chest", hoopNames: ["Cap Frame"] }], printed: [], offersOptions: false, picks: [], personalization: null, customDesign: "" }, extra || {});
  let rp = w.runPreviewHtml_(pv({ printed: ["Screen print: Example Screen"], offersOptions: true, picks: [{ label: "Back", choices: [{ graphic: "Example Print", kind: "transfer", steps: [] }, { graphic: "Example Mark", kind: "embroidery", steps: [{ designName: "Example Mark", label: "Back" }] }] }], customDesign: "embroidery" }));
  ok("Run order's plan names what is pressed on every piece, and a pick that is a transfer is pressed, not stitched", /Pressed on every piece:<\/b> Screen print: Example Screen/.test(rp) && /Example Print .{1,3} <span class="rp-dim">pressed as a transfer \(Run order, DTF\)/.test(rp) && /Example Mark .{1,3} <span class="rp-step"/.test(rp));
  ok("…a customer's own embroidery design replaces the ones above, digitized per order", /Customer's own design:<\/b> replaces the designs above on that item, digitized per order/.test(rp));
  rp = w.runPreviewHtml_(pv({ customDesign: "transfer" }));
  ok("…a customer's own printed design is printed from their image", /Customer's own design:<\/b> printed from their image \(Run order, DTF\)/.test(rp) && !/Pressed on every piece/.test(rp));
  ok("…and with nothing to show there is nothing drawn", w.runPreviewHtml_(null) === "");

  console.log("\n=== The product form: reading the decoration list while it opens ===");
  const make = async (productId, extra) => must(Object.assign({ action: "createProduct", org: "club", productId, type: "shirt", name: "Example " + productId, pricingMode: "flat", flatPrice: 20, visible: true, taxable: true, images: [], features: [] }, extra));
  await make("plainx", { noDesignNeeded: true });
  const prod = async (pid) => (await must({ action: "listProducts", org: "club" })).products.find(x => x.productId === pid);
  const openForm = async (pid) => { reset(); w.renderProductForm(app, "club", await prod(pid)); await idle(); await pause(120); await idle(); };
  const mark = () => { const s = id("prodFormDecoration"); s.insertAdjacentHTML("beforeend", '<option value="zz">Marker</option>'); };
  await setDeco(KEYS, PRICES);
  w.eval("_decorationPricing_ = null");
  scripted.push({ action: "getDecorationSettings", keep: true, delay: 80, status: 500, body: { status: "error", message: "down" } });
  reset(); w.renderProductForm(app, "club", await prod("plainx")); await pause(20); mark();
  await pause(250); await idle(); unscript();
  ok("when the list can't be read as the form opens, the Decoration select is left as it was drawn", !!id("prodFormDecoration") && !!id("prodFormDecoration").querySelector('option[value="zz"]'));
  w.eval("_decorationPricing_ = null");
  scripted.push({ action: "getDecorationSettings", keep: true, delay: 80, body: realDeco });
  reset(); w.renderProductForm(app, "club", await prod("plainx")); await pause(20); mark();
  await pause(250); await idle(); unscript();
  ok("…and when it can, the select is drawn again from it", !id("prodFormDecoration").querySelector('option[value="zz"]') && id("prodFormDecoration").options.length === 7);
  w._prodDecoProduct = {};
  await setDeco(["dtf", "vinyl"], PRICES);
  w.productDecorationVisibility_();
  ok("a product the form knows nothing of has no personalization to keep its card, with embroidery off", id("prodCardPers").style.display === "none");
  w._prodDecoProduct = { personalizationPrice: 3 };
  w.productDecorationVisibility_();
  ok("…one that has a personalization price keeps it", id("prodCardPers").style.display !== "none");
  w._prodDecoProduct = { personalizationOptions: ["Name"] };
  w.productDecorationVisibility_();
  ok("…or a list of personalization options", id("prodCardPers").style.display !== "none");
  w._prodDecoProduct = {};
  w.productDecorationVisibility_();
  ok("…and with neither, it goes again", id("prodCardPers").style.display === "none");
  await setDeco(KEYS, PRICES);
  const dsel = id("prodFormDecoration"); dsel.closest("label").remove();
  reset();
  await w.submitProductForm("club", true); await idle();
  ok("a form with no Decoration select saves without a decoration type, so the stored one stays", of("updateProduct").length === 1 && !("decorationType" in of("updateProduct")[0]));

  // ==============================================================================================================
  console.log("\n=== Global settings: the list the server answers a save with ===");
  await setDeco(KEYS, PRICES);
  await w.renderGlobalSettings(app); await idle();
  reset();
  scripted.push({ action: "saveGlobalSettingsAll", body: { status: "ok", settings: { decoration: ["embroidery", "vinyl"] } } });
  scripted.push({ action: "getDecorationSettings", keep: true, status: 500, body: { status: "error", message: "down" } });
  await w.submitGlobalSettings(); await idle(); unscript();
  ok("a save answered with the list itself (not an object holding it) puts that list on every screen, even when the read back fails", same(w.decorationTypesOn_(), ["embroidery", "vinyl"]));
  await setDeco(KEYS, PRICES);
  w.renderAdminNav();

  console.log("\n=== Communications: the roll-up's own kinds of notice ===");
  const notice = (kind, summary) => ({ kind, urgent: false, createdAt: "2026-02-03T10:00:00Z", orderId: "Q-" + kind, orgName: "Example Club", summary });
  scripted.push({ action: "getPendingCommunications", body: { status: "ok", notices: [notice("quote", "Pat accepted the quote"), notice("gift_card", "A gift card was bought"), notice("po", "A purchase order came in"), notice("mystery", "Something new")], orders: [], inTransit: [], awaitingPickup: [], awaitingBlanks: [] } });
  await w.renderCommunications(app); await idle();
  const rowsByKind = Object.fromEntries(qa("#commsBody tbody tr").map(tr => [text(tr.children[2] || tr.children[1]).split(" ")[0], text(tr.children[1])]));
  const types = qa("#commsBody tbody tr").map(tr => text(tr.children[1]));
  ok("a quote, a gift card and a purchase order are named in the Type column, and a kind it doesn't know is shown as it is", ["Quote", "Gift card", "PO", "mystery"].every(k => types.includes(k)));
  ok("…each with its summary", /Pat accepted the quote/.test(text(q("#commsBody"))) && /A gift card was bought/.test(text(q("#commsBody"))));

  console.log("\n=== Vendors, graphics ===");
  await must({ action: "saveVendor", vendor: { name: "Example Retired Stitch Co", forBlanks: false, forDigitizing: false, hidden: true } });
  const vb = stage("");
  await w.mountVendorManager_(vb, () => {}); await idle(); await pause(40);
  ok("a hidden vendor is not listed until asked for", !/Example Retired Stitch Co/.test(text(vb)));
  vb.querySelector("[data-vd-showhidden]").click(); await pause(20);
  ok("…then it is listed and marked hidden", /Example Retired Stitch Co\s*\(hidden\)/.test(text(vb)));
  vb.remove();
  const kl = (g) => text(d.createElement("div").appendChild(Object.assign(d.createElement("span"), { innerHTML: w.graphicKindLabelHtml_(g) })));
  ok("a transfer graphic with no printed type is called Transfer (DTF), an embroidery one Embroidery", kl({ kind: "transfer" }) === "Transfer (DTF)" && kl({ kind: "transfer", decoration: "embroidery" }) === "Transfer (DTF)" && kl({ kind: "embroidery" }) === "Embroidery");
  ok("…a printed type the page has no name for is just Transfer, and since it is on no list it is marked switched off", kl({ kind: "transfer", decoration: "mystery" }) === "Transfer (switched off)");
  await setDeco(["embroidery"], PRICES);
  const asked = [];
  w.hoopApi_ = async (b) => { asked.push(b); return { status: "ok", id: 9 }; };
  const old = { id: 9, name: "Example Old Print", kind: "transfer", decoration: "mystery", designId: null, transferId: null, tier: null, inkColors: [], imageUrl: "https://example.com/o.png", thumbUrl: "", allowedLocations: [], allowedGarmentColors: [], visible: true };
  let saved9 = null;
  w.showGraphicFormModal_(old, "club", { designs: [], transfers: [{ id: 3, name: "Sheet" }], tiers: {}, allLocations: [], allColors: [], kind: "transfer" }, (gid) => { saved9 = gid; });
  const gm = modal();
  ok("with no printed type on and the graphic's own type unknown, the Printed by box has nothing in it", gm.querySelector("#gfDecoration").options.length === 0 && gm.querySelector("#gfDecoration").value === "");
  ok("…and it is treated as DTF: the transfer sheet box shows", gm.querySelector("#gfTransferWrap").style.display === "");
  gm.querySelector("#gfSave").click(); await pause(20);
  ok("…saving sends it as DTF, with the transfer sheet picked (none here)", asked.length === 1 && asked[0].graphic.decoration === "dtf" && asked[0].graphic.transferId === null && saved9 === 9);
  w.hoopApi_ = realApi; closeModals();
  await setDeco(KEYS, PRICES);

  // ==============================================================================================================
  console.log("\n=== The Run order page with a thin answer ===");
  const runPrefs = (type, sort) => { w.localStorage.setItem("odd_runorder_type", type); w.localStorage.setItem("odd_runorder_sort", sort); };
  const stubRun = (rq, extra) => {
    unscript();
    scripted.push({ action: "getRunQueue", keep: true, body: Object.assign({ status: "ok" }, rq) });
    for (const a of ["listMachines", "listActiveRuns", "listAbortReasons", "listHoops", "listThreads"]) scripted.push({ action: a, keep: true, body: { status: "ok" } });
    for (const s of extra || []) scripted.push(s);
  };
  runPrefs("all", "due");
  stubRun({ embroidery: [], transfers: {}, other: {}, types: ["embroidery", "dtf", "screenprint"] });
  reset();
  await w.renderRunOrder(app); await idle();
  ok("an answer with no machines, hoops, threads, runs or reasons, and no cards in any list, is an empty page", /Nothing to run/.test(text(id("roBody"))) && of("getRunQueue").length === 1 && !/Could not|Error/.test(text(id("roBody"))));
  ok("…with every type that is on still a button, and no gang sheet", qa("#roBar .ro-filter").map(b => b.dataset.type).join() === "all,embroidery,dtf,screenprint" && !id("rtGang"));
  stubRun({ types: ["dtf"] });
  reset();
  await w.renderRunOrder(app); await idle();
  ok("an answer with no embroidery, no transfers and no other list (a role with none of them) is empty too", /Nothing to run/.test(text(id("roBody"))) && of("listMachines").length === 0);

  console.log("\n=== …its cards with parts missing, and what their buttons do ===");
  const dtfCard = (o) => Object.assign({ itemId: 101, orderId: "O-101", orgId: "club", orgName: "Example Club", customerName: "Pat Example", itemName: "Example Tee", itemSize: "M", qty: 2, dueDate: "", placedAt: "2026-02-01T10:00:00Z", garmentColor: "Navy",
    blank: { name: "Example Tee", color: "Navy", size: "M", productType: "shirt" }, transfers: [{ location: "Back", graphicName: "Example Print", imageUrl: "https://example.com/p.png" }], blankReceived: true, transferReceived: false, hasEmbroidery: false }, o);
  const otherCard = (o) => Object.assign({ type: "screenprint", itemId: 201, orderId: "O-201", orgId: "club", orgName: "Example Club", customerName: "Sam Example", itemName: "Example Hoodie", qty: 3, dueDate: "", placedAt: "2026-02-02T10:00:00Z",
    blank: { name: "Example Hoodie" }, locations: [{ location: "Front", graphicName: "Example Screen", thumbUrl: "https://example.com/t.png" }], blankReceived: true, started: false, hasEmbroidery: false }, o);
  const paidRow = { orderId: "O-300", orgId: "club", orgName: "Example Club", customerName: "Pat Example", dueDate: "", placedAt: "2026-02-01T10:00:00Z", items: [{ qty: 1, name: "Example Tee", size: "M" }], types: ["dtf"], needsBlanks: true, blankReceived: false, blankOrder: null, blanksInStock: true };
  runPrefs("all", "blank");
  stubRun({ embroidery: [], transfers: { ready: [dtfCard({ hasEmbroidery: true, embroideryDone: true, transferReceived: true }), dtfCard({ itemId: 102, orderId: "O-102", transferReceived: true, transfers: undefined, orgName: undefined, customerName: undefined, placedAt: undefined, itemSize: undefined, garmentColor: "", blank: { name: "Example Cap" } }),
      dtfCard({ itemId: 103, orderId: "O-103", blank: null, itemSize: undefined, transferReceived: true })],
    waiting: [dtfCard({ itemId: 104, orderId: "O-104", transferReceived: true, transferShort: undefined })] },
    other: { ready: [otherCard(), otherCard({ itemId: 202, orderId: "O-202", type: "vinyl", hasEmbroidery: true, embroideryDone: false, locations: undefined, itemSize: undefined })], waiting: [otherCard({ itemId: 203, orderId: "O-203", type: "dtg", blankReceived: false })] },
    types: ["embroidery", "dtf", "screenprint", "vinyl", "dtg"], paidUnrun: [paidRow] });
  reset();
  await w.renderRunOrder(app); await idle();
  const dtfBtn = (o, cls) => qa(".ro-card " + cls).find(b => b.dataset.order === o);
  ok("a sparse answer draws every card, grouped by blank (one with no product type is under Blanks, one with no blank under Unlinked)", qa(".ro-card").length === 7 && qa("#roBody h2").map(h => text(h)).sort().join() === "Blanks,Unlinked,shirt" && /Example Cap — —/.test(text(id("roBody"))) && /No blank linked — —/.test(text(id("roBody"))));
  ok("a ready card that is also embroidered says its embroidery is done", qa(".rt-emb").length === 2 && qa(".rt-emb").filter(e => /✓ embroidery done/.test(text(e))).length === 1 && qa(".rt-emb").filter(e => /embroidery still to run/.test(text(e))).length === 1);
  ok("a card waiting on nothing the page can name still says it waits on the blank", qa(".ro-card-waiting").some(c => /Waiting on blank$/.test(text(c.querySelector('span[style*="b26a00"]')))));
  ok("a location whose picture is only an image link still shows it", !!qa('.ro-card img[src="https://example.com/p.png"]').length);
  const realAsk = w.askWhen_;
  w.askWhen_ = async () => null;
  reset();
  dtfBtn("O-101", ".rtApply").click(); await pause(30);
  dtfBtn("O-102", ".rtMake").click(); await pause(30);
  qa(".roDecMake")[0].click(); await pause(30);
  ok("cancelling the question when a card's button is pressed sends nothing", of("setTransfersApplied").length === 0 && of("makeTransferLine").length === 0 && of("makeDecoratedLine").length === 0 && toasts.length === 0);
  w.askWhen_ = async () => "2026-02-03T10:00:00Z";
  scripted.push({ action: "makeTransferLine", body: { status: "ok", orderComplete: false } });
  reset();
  dtfBtn("O-102", ".rtMake").click(); await pause(30); await idle();
  ok("Mark made on a printed card that doesn't finish the order says Marked made.", toasts.some(t => t.m === "Marked made.") && of("makeTransferLine")[0].at === "2026-02-03T10:00:00Z");
  scripted.push({ action: "makeDecoratedLine", body: { status: "ok", orderComplete: false } });
  reset();
  qa(".ro-card-other .roDecMake").find(b => b.dataset.order === "O-201").click(); await pause(30); await idle();
  ok("…and so does Mark made on another type's card", toasts.some(t => t.m === "Marked made.") && of("makeDecoratedLine")[0].orderId === "O-201");
  scripted.push({ action: "useBlanksFromStock", body: { status: "ok" } });
  reset();
  q(".ro-use-stock").click(); await pause(40); await idle();
  ok("Use blanks from stock on the Paid, not yet run table says what was used (nothing here) and the page is read again", toasts.some(t => /^Blanks from stock: \.$/.test(t.m)) && of("useBlanksFromStock").length === 1 && of("getRunQueue").length === 1);
  w.askWhen_ = realAsk;
  unscript(); scripted.push({ action: "getGangSheet", body: { status: "ok" } });
  reset(); await w.runGangSheet_(); await pause(30);
  ok("a gang sheet answer with no rows says there is nothing to print", /Nothing to print/.test(text(modal())));
  closeModals();
  runPrefs("all", "due");
  unscript();

  console.log("\n" + counts().passed + " checks passed");
})().catch(e => { console.log("test385 crashed:", false); console.error(e); process.exit(1); });
