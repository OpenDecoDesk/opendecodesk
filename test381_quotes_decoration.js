const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { ok } = require("./testlib/check");
const roles = require("./testlib/roles");
const { MAIL_ENV, MAIL_OK, captureMail } = require("./testlib/mail-mock");
const { storefrontPage } = require("./testlib/storefront-page");
const { JSDOM, ResourceLoader, VirtualConsole } = require("jsdom");

// Phase 5, the quotes gaps. Two halves.
//   1. The quote editor (public/admin-quotes.js) in the real admin page (jsdom) with the real admin.js, orders.js and db.js
//      on sql.js behind it: a product with choices can be quoted (colour, a graphic at each location, the customer's own
//      design), what is picked is saved with the line, shown under it and kept on the order the quote becomes; "By stitches"
//      and "Screen print price" fill the price (and a Screen setup fee line) where the shop has that pricing on.
//   2. The emails (functions/_lib/email.js): a quote line's picks in the quote email, the customer's answer queued for the
//      morning roll-up as "Quote", and the roll-up's names for Quote, Gift card and PO, with a real invoice notice still "Invoice".
// Invented people and shops only; no check depends on today's date or this machine's time zone.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + "\nreturn { createProduct, createGraphic, createTransfer, saveDesign, addDesignVersion, setProductDesign, setProductGraphicColorBlocked, getOrderById };")();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async (env, host, key, request, msg, need) => roleAllows(DEFAULT_ROLES[globalThis.__role381] || null, need) ? null : jsonResponse({ status: 'error', message: 'Your role can\\'t do that here.' }, 403);\n" +
  "const adminActor = () => 'owner@example.test';\n" + roles.adminAs({ roleFrom: "globalThis.__role381" }) + "\n" + strip(read("functions/_lib/permissions.js")) + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false;\n" +
  "const sendInvoiceEmail = async () => false;\n" +
  "const sendEstimateEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
const pause = (ms) => new Promise(r => setTimeout(r, ms));
const wait = async (cond, n = 500) => { for (let i = 0; i < n && !cond(); i++) await pause(10); return !!cond(); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
process.on("unhandledRejection", (e) => { console.error(e); ok("nothing in the test was left to fail unseen", false); });

(async () => {
  globalThis.__role381 = "admin";
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
  const est = (id) => d1.q("SELECT * FROM estimates WHERE id = ?", id)[0];
  const itemsOf = (id) => d1.q("SELECT * FROM estimate_items WHERE estimateId = ? ORDER BY position", id);

  // ---- What is in the database ----------------------------------------------------------------------------------
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Example Club','t','t'), ('rec','rec','Example Boosters','t','t');`);
  const cust = await call({ action: "saveCustomer", name: "Pat Example", company: "Example Club", email: "pat@example.com", phone: "555-0100", address: null, notes: "", taxExempt: false, taxExemptCertificate: "", taxExemptExpires: "" });
  const PAT = cust.body.id;
  // The decoration settings: the stored ones (what an install has before anyone ticks anything) are embroidery and DTF
  // with stitch pricing off. setDeco() saves a new set through the real action.
  const setDeco = async (types, pricing) => { const r = await call({ action: "updateDecorationSettings", types, pricing }); if (r.status !== 200) throw new Error("seed deco: " + JSON.stringify(r.body)); return r; };
  const PRICES = { embroidery: { stitchPricing: true, centsPer1000: 100, minStitches: 0, minCents: 0 }, screenprint: { inkColorCents: 150, screenSetupCents: 2000, reorderSetupCents: 1000, maxColors: 4 } };

  // A design with stitch counts on three versions: the newest has none, so the newest that has one (9,200) is the start.
  const DES = await lib.saveDesign(d1, "acme", { name: "Example crest" });
  await lib.addDesignVersion(d1, DES, { machineFileKey: "k1", stitchCount: 7000, uploadedAt: "2026-01-01T00:00:00Z" });
  await lib.addDesignVersion(d1, DES, { machineFileKey: "k2", stitchCount: 9200, uploadedAt: "2026-02-01T00:00:00Z" });
  await lib.addDesignVersion(d1, DES, { machineFileKey: "k3", uploadedAt: "2026-03-01T00:00:00Z" });
  const DESX = await lib.saveDesign(d1, "acme", { name: "Example badge" });
  await lib.addDesignVersion(d1, DESX, { machineFileKey: "k5", stitchCount: 3000, uploadedAt: "2026-01-01T00:00:00Z" });
  const DES0 = await lib.saveDesign(d1, "acme", { name: "Example mark with no count" });
  await lib.addDesignVersion(d1, DES0, { machineFileKey: "k4", uploadedAt: "2026-01-01T00:00:00Z" });

  await lib.createProduct(d1, "acme", { productId: "cap", type: "cap", name: "Club cap", pricingMode: "flat", flatPrice: 20, visible: true, noDesignNeeded: true });
  await lib.setProductDesign(d1, "acme", "cap", DES);
  await lib.createProduct(d1, "acme", { productId: "mug", type: "mug", name: "Club mug", pricingMode: "flat", flatPrice: 8, visible: true, noDesignNeeded: true });
  await lib.createProduct(d1, "acme", { productId: "patch", type: "patch", name: "Club patch", pricingMode: "flat", flatPrice: 5, visible: true, noDesignNeeded: true });
  await lib.setProductDesign(d1, "acme", "patch", DESX);
  await lib.createProduct(d1, "acme", { productId: "bag", type: "bag", name: "Club bag", pricingMode: "flat", flatPrice: 12, visible: true, noDesignNeeded: true });
  await lib.setProductDesign(d1, "acme", "bag", DES0);
  // Graphics: Lockup (medium, +$2.00, two thread colours), Capital (large, +$4.00, Front only), Crest (embroidery, no add-on),
  // Winter mark (Grey garments only), Vinyl mark (printed by vinyl), Hidden mark (not offered).
  const tr = await lib.createTransfer(d1, { name: "Example sheet" });
  const gLock = await lib.createGraphic(d1, "acme", { name: "Lockup", kind: "transfer", transferId: tr, tier: "medium", inkColors: ["White", "Gold"] });
  const gCap = await lib.createGraphic(d1, "acme", { name: "Capital", kind: "transfer", transferId: tr, tier: "large", allowedLocations: ["front"] });
  const gCrest = await lib.createGraphic(d1, "acme", { name: "Crest", kind: "embroidery", designId: DES, tier: null, inkColors: ["Navy"] });
  const gWinter = await lib.createGraphic(d1, "acme", { name: "Winter mark", kind: "transfer", transferId: tr, tier: "small", allowedGarmentColors: ["Grey"] });
  const gVinyl = await lib.createGraphic(d1, "acme", { name: "Vinyl mark", kind: "transfer", transferId: tr, tier: "small", decoration: "vinyl" });
  const gHidden = await lib.createGraphic(d1, "acme", { name: "Hidden mark", kind: "transfer", transferId: tr, tier: "small", visible: false });
  const gBlock = await lib.createGraphic(d1, "acme", { name: "Blocked mark", kind: "transfer", transferId: tr, tier: "small" });
  const jacketLocs = [
    { key: "front", label: "Front", graphicIds: [gLock, gCap, gCrest, gWinter, gVinyl, gHidden, gBlock] },
    { key: "back", label: "Back", graphicIds: [gLock, gCap, gWinter], customDesignPriceCents: 900 },
  ];
  await lib.createProduct(d1, "acme", { productId: "jacket", type: "jacket", name: "Build-a-jacket", pricingMode: "flat", flatPrice: 50, visible: true, noDesignNeeded: true,
    configurable: true, garmentColors: ["Navy", "Grey"], reorderQr: "none", locations: jacketLocs, customDesign: "transfer", customDesignPrice: 6 });
  await lib.setProductGraphicColorBlocked(d1, "acme", "jacket", gBlock, "Grey", true);
  // Sized, with a price group: Navy is the product's own prices, Grey costs more.
  await lib.createProduct(d1, "acme", { productId: "hoodie", type: "hoodie", name: "Build-a-hoodie", pricingMode: "sized", sizePricing: { S: 30, M: 30, L: 34 }, visible: true, noDesignNeeded: true,
    configurable: true, garmentColors: ["Navy", "Grey"], reorderQr: "none", locations: [{ key: "front", label: "Front", graphicIds: [gLock, gCrest] }],
    });
  d1._raw.run("UPDATE products SET colorGroupsJson = ? WHERE orgId = 'acme' AND productId = 'hoodie'", [JSON.stringify([{ label: "Heathers", colors: ["Grey"], sizePricingCents: { S: 3300, M: 3300, L: 3700 } }])]);
  // One place to decorate and nothing fixed: no "None" to choose.
  await lib.createProduct(d1, "acme", { productId: "visor", type: "cap", name: "Build-a-visor", pricingMode: "flat", flatPrice: 15, visible: true, noDesignNeeded: true,
    configurable: true, garmentColors: [], reorderQr: "none", locations: [{ key: "front", label: "Front", graphicIds: [gLock, gCrest] }] });
  // The same with a transfer already fixed on the product: the place can still be left blank.
  await lib.createProduct(d1, "acme", { productId: "visor2", type: "cap", name: "Build-a-visor with a fixed mark", pricingMode: "flat", flatPrice: 15, visible: true, noDesignNeeded: true,
    configurable: true, garmentColors: [], reorderQr: "none", locations: [{ key: "front", label: "Front", graphicIds: [gLock, gCrest] }] });
  d1._raw.run("UPDATE products SET fixedTransfersJson = ? WHERE orgId = 'acme' AND productId = 'visor2'", [JSON.stringify([{ locationId: null, graphicId: gCrest, ink: "" }])]);
  // Another shop: every product has choices.
  const gRec = await lib.createGraphic(d1, "rec", { name: "Booster mark", kind: "transfer", transferId: tr, tier: "small" });
  await lib.createProduct(d1, "rec", { productId: "pennant", type: "flag", name: "Build-a-pennant", pricingMode: "flat", flatPrice: 10, visible: true, noDesignNeeded: true,
    configurable: true, garmentColors: ["Red"], reorderQr: "none", locations: [{ key: "top", label: "Top", graphicIds: [gRec] }] });
  const mk = async (org, extra) => { const r = await call(Object.assign({ action: "createEstimate", org, customerId: PAT }, extra || {})); if (r.status !== 200) throw new Error("seed quote: " + JSON.stringify(r.body)); return r.body; };
  const saveItems = async (id, items) => { const r = await call({ action: "saveEstimate", id, items }); if (r.status !== 200) throw new Error("seed items: " + JSON.stringify(r.body)); return r.body; };

  // ---- The page ---------------------------------------------------------------------------------------------------
  const adminJs = read("public/admin.js"), custJs = read("public/admin-customers.js"), quotesJs = read("public/admin-quotes.js");
  const sent = [], toasts = [];
  let scripted = null;
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
  class Loader extends ResourceLoader {
    fetch(url) {
      if (/\/admin-quotes\.js(\?|$)/.test(url)) return Promise.resolve(Buffer.from(quotesJs));
      if (/\/admin-customers\.js(\?|$)/.test(url)) return Promise.resolve(Buffer.from(custJs));
      if (/\/admin\.js(\?|$)/.test(url)) return Promise.resolve(Buffer.from(adminJs));
      return Promise.resolve(Buffer.from(""));
    }
  }
  const vc = new VirtualConsole();
  vc.sendTo(console, { omitJSDOMErrors: true });
  vc.on("jsdomError", (e) => { if (!/Not implemented|Could not load script/.test(e.message)) console.error(e); });
  const dom = new JSDOM(storefrontPage(), { runScripts: "dangerously", resources: new Loader(), virtualConsole: vc, url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win) {
      win.CSS = win.CSS || { escape: (s) => String(s).replace(/["\\]/g, "\\$&") };
      win.fetch = async (url, init) => {
        const u = String(url), b = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
        if (!u.includes("/api/orders")) return reply(404, { status: "error", message: "not here" });
        sent.push(b);
        if (scripted && scripted.action === b.action) { const s = scripted; scripted = null; return reply(s.status || 200, s.body); }
        const x = await call(b);
        return reply(x.status, x.body);
      };
    } });
  const w = dom.window, d = w.document;
  await pause(150);
  await w.loadAdminScript();
  w.showToast = (m, isErr) => toasts.push({ m: String(m), err: !!isErr });
  w.eval('adminKey = "cookie"; setAdminTimeZone_("UTC"); adminOrgs = ' + JSON.stringify([{ orgId: "acme", name: "Example Club" }, { orgId: "rec", name: "Example Boosters" }]) + ';');
  w.eval(roles.asRole("admin", { name: "Tester", email: "tester@example.test" }));
  const q = (s) => d.querySelector(s), qa = (s) => [...d.querySelectorAll(s)];
  const page = () => d.getElementById("qtPage");
  const reset = () => { sent.length = 0; toasts.length = 0; };
  const of = (action) => sent.filter(b => b.action === action);
  const hashNow = () => w.location.hash.replace(/^#\/?/, "");
  const oneDrawn = () => !!(page() && (q("#qtForm") || page().querySelector(".cust-err")));
  const openQ = async (id) => { const old = page(); if (hashNow() === "quotes/" + id) w.adminRoute(); else w.location.hash = "#quotes/" + id; return wait(() => page() && page() !== old && oneDrawn()); };
  const modal = () => { const all = qa(".admin-modal"); return all[all.length - 1] || null; };
  const pm = modal;
  const lines = () => qa("#qtLines table.qt-lines tbody tr");
  const cells = (tr) => [...tr.children].map(td => td.textContent.trim());
  const sub = (i) => (lines()[i].querySelector(".qt-line-sub") || { textContent: "" }).textContent;
  const openProduct = async () => { const n = qa(".admin-modal").length; q("#qtAddProduct").click(); return wait(() => qa(".admin-modal").length === n + 1 && !!pm().querySelector("#qtProdForm")); };
  const openCustom = async () => { const n = qa(".admin-modal").length; q("#qtAddCustom").click(); return wait(() => qa(".admin-modal").length === n + 1 && !!pm().querySelector("#qtOtherForm")); };
  // A window with typing in it asks “Discard changes?” first: answered yes.
  const closeModal = async () => { const m = modal(); if (!m) return; m.querySelector("[data-modal-close]").click(); await pause(5);
    const box = q(".confirm-modal"); if (box) box.querySelector("#cmOk").click();
    await wait(() => !m.isConnected, 100); };
  const choose = (sel, v) => { const el = pm().querySelector(sel); el.value = v; el.dispatchEvent(new w.Event("change", { bubbles: true })); };
  const tick = (sel, on) => { const el = pm().querySelector(sel); el.checked = on; el.dispatchEvent(new w.Event("change", { bubbles: true })); };
  const typeIn = (sel, v) => { const el = pm().querySelector(sel); el.value = v; el.dispatchEvent(new w.Event("input", { bubbles: true })); };
  const click = (sel) => pm().querySelector(sel).click();
  const submitIn = async (formSel) => { const m = modal(); const n = of("saveEstimate").length; m.querySelector(formSel).dispatchEvent(new w.Event("submit", { cancelable: true })); await wait(() => !m.isConnected || m.querySelector(".cust-err").textContent !== "" || of("saveEstimate").length > n); await wait(() => !m.isConnected || m.querySelector(".cust-err").textContent !== "", 60); return m; };
  const note = () => pm().querySelector("[data-qt-note]").textContent;
  const noteBad = () => pm().querySelector("[data-qt-note]").style.color !== "";
  const press = async (goAttr, settle) => { click(`[data-qt-go="${goAttr}"]`); await wait(() => note() !== "", 200); await pause(settle || 5); };
  const decoBtns = () => [...pm().querySelectorAll("[data-qt-deco]")].map(b => b.textContent);
  const freshQuote = async (org) => { const id = (await mk(org || "acme")).id; await openQ(id); return id; };
  const locSel = (k) => pm().querySelector(`select[data-qt-loc="${k}"]`);
  const optsOf = (sel) => [...sel.options].map(o => o.textContent);
  const valsOf = (sel) => [...sel.options].map(o => o.value);

  console.log("=== Before anyone ticks anything: no price helpers ===");
  // The shop's graphics are asked for with the first window: this once they can't be read.
  scripted = { action: "listGraphics", status: 500, body: { status: "error", message: "Graphics are away (test)." } };
  let Q = await freshQuote();
  toasts.length = 0; await openProduct();
  ok("graphics that can't be read: a toast says products with choices can't be quoted until they load, and only the plain products are offered", toasts.length === 1 && toasts[0].err && toasts[0].m === "Couldn't load the shop's graphics: Graphics are away (test). Products with choices can't be quoted until they load." && same([...pm().querySelectorAll("#qtProd option")].map(o => o.value).sort(), ["bag", "cap", "mug", "patch"]));
  await closeModal(); toasts.length = 0; await openProduct();
  ok("…a failure isn't remembered: the next window asks again, and then offers the products with choices too", of("listGraphics").length === 2 && of("listGraphics")[0].org === "acme" && !toasts.length && same([...pm().querySelectorAll("#qtProd option")].map(o => o.value).sort(), ["bag", "cap", "hoodie", "jacket", "mug", "patch", "visor", "visor2"]));
  ok("with the stored settings (embroidery and DTF, stitch pricing off) a product line has no “By stitches” or “Screen print price”", pm().querySelector("#qtProdDeco").hidden && decoBtns().length === 0 && !pm().querySelector("[data-qt-pane]"));
  await closeModal();
  await openCustom();
  ok("…nor does a custom line", pm().querySelector("#qtOtherDeco").hidden && decoBtns().length === 0);
  await closeModal();
  ok("the quote asked for the shop's decoration settings once as it opened", of("getDecorationSettings").length === 1);

  console.log("\n=== Which helpers are shown ===");
  await setDeco(["embroidery", "dtf"], PRICES);
  Q = await freshQuote(); await openProduct();
  ok("stitch pricing on, screen print not ticked: only “By stitches” (a button that starts closed)", same(decoBtns(), ["By stitches"]) && !pm().querySelector("#qtProdDeco").hidden &&
    pm().querySelector('[data-qt-deco="stitch"]').getAttribute("aria-expanded") === "false" && pm().querySelector('[data-qt-pane="stitch"]').hidden);
  await closeModal();
  await setDeco(["screenprint", "dtf"], PRICES);
  Q = await freshQuote(); await openProduct();
  ok("screen print ticked, embroidery not: only “Screen print price”", same(decoBtns(), ["Screen print price"]) && !pm().querySelector('[data-qt-pane="stitch"]'));
  await closeModal();
  await setDeco(["embroidery", "dtf"], { embroidery: { stitchPricing: false } });
  Q = await freshQuote(); await openProduct();
  ok("embroidery ticked but stitch pricing off, no screen print: no helpers, the box stays hidden", decoBtns().length === 0 && pm().querySelector("#qtProdDeco").hidden);
  await closeModal();
  scripted = { action: "getDecorationSettings", status: 500, body: { status: "error", message: "Settings are down (test)." } };
  Q = await freshQuote(); await openProduct();
  ok("a server that can't say what the shop does gives no helpers (and the window still opens)", decoBtns().length === 0 && !!pm().querySelector("#qtProd"));
  await closeModal();
  await setDeco(["embroidery", "screenprint", "dtf"], PRICES);
  const sentQ = await mk("acme"); await saveItems(sentQ.id, [{ kind: "custom", name: "Banner", qty: 1, unitPrice: 10 }]);
  await call({ action: "sendEstimate", id: sentQ.id, to: "pat@example.com" });
  reset(); await openQ(sentQ.id);
  ok("a quote that can't be edited (sent) doesn't ask for the settings", of("getDecorationSettings").length === 0);

  console.log("\n=== By stitches, on a product line ===");
  Q = await freshQuote(); await openProduct();
  ok("both helpers are drawn, “By stitches” first", same(decoBtns(), ["By stitches", "Screen print price"]));
  choose("#qtProd", "cap");
  click('[data-qt-deco="stitch"]');
  ok("the button opens its pane, says it is open, and puts focus in Stitches", !pm().querySelector('[data-qt-pane="stitch"]').hidden && pm().querySelector('[data-qt-deco="stitch"]').getAttribute("aria-expanded") === "true" && d.activeElement === pm().querySelector('[data-qt-f="stitches"]'));
  ok("…the pane has the stitch field, the catalog-price tick (on) and the button", pm().querySelector('[data-qt-f="addCatalog"]').checked && pm().querySelector('[data-qt-f="addCatalog"]').closest("label").textContent.trim() === "Add the product's catalog price" && pm().querySelector('[data-qt-go="stitch"]').textContent === "Work out the price");
  ok("…and is a status area for its message", pm().querySelector("[data-qt-note]").getAttribute("role") === "status" && pm().querySelector("[data-qt-note]").getAttribute("aria-live") === "polite");
  ok("a product with a design starts the stitch count at the design's newest known count (9,200)", await wait(() => pm().querySelector('[data-qt-f="stitches"]').value === "9200"));
  ok("…asked for by design number, once", of("getDesign").length === 1 && of("getDesign")[0].id === DES);
  click('[data-qt-deco="stitch"]');
  ok("pressing the button again closes the pane", pm().querySelector('[data-qt-pane="stitch"]').hidden && pm().querySelector('[data-qt-deco="stitch"]').getAttribute("aria-expanded") === "false");
  click('[data-qt-deco="stitch"]');
  reset(); await press("stitch", 20);
  ok("Work out the price: 9,200 stitches at $1.00 per 1,000 is $9.20, plus the catalog $20.00, is $29.20 each", pm().querySelector("#qtProdOwnPrice").value === "29.20" && of("priceDecoration").length === 1 &&
    same(of("priceDecoration")[0].params, { stitches: 9200 }) && of("priceDecoration")[0].type === "embroidery");
  ok("…the price is now set by hand (the box ticked, the field shown) so no quantity price replaces it", pm().querySelector("#qtProdOwn").checked && !pm().querySelector("#qtProdOwnWrap").hidden && pm().querySelector("#qtProdPreview").textContent === "Price set by hand.");
  ok("…and says how: “9,200 stitches × $1.00 per 1,000: $9.20 + catalog price $20.00 each.”", note() === "9,200 stitches × $1.00 per 1,000: $9.20 + catalog price $20.00 each." && !noteBad());
  tick('[data-qt-f="addCatalog"]', false);
  await press("stitch", 20);
  ok("without the catalog price the stitch price stands alone: $9.20 each", pm().querySelector("#qtProdOwnPrice").value === "9.20" && note() === "9,200 stitches × $1.00 per 1,000: $9.20 each.");
  typeIn('[data-qt-f="stitches"]', "12500");
  await press("stitch", 20);
  ok("a count typed by hand is used: 12,500 stitches is $12.50", pm().querySelector("#qtProdOwnPrice").value === "12.50");
  for (const bad of ["", "0", "-5", "8.5", "abc"]) {
    typeIn('[data-qt-f="stitches"]', bad); reset(); click('[data-qt-go="stitch"]'); await pause(10);
    ok(`stitches of “${bad}” are refused: “Enter the number of stitches (a whole number, like 8500).” in red, focus on the field, nothing asked`, note() === "Enter the number of stitches (a whole number, like 8500)." && noteBad() && d.activeElement === pm().querySelector('[data-qt-f="stitches"]') && of("priceDecoration").length === 0);
  }
  typeIn('[data-qt-f="stitches"]', "9200"); tick('[data-qt-f="addCatalog"]', true);
  scripted = { action: "priceDecoration", status: 500, body: { status: "error", message: "The price list is busy (test)." } };
  await press("stitch", 20);
  ok("a server error is shown in the note, in red, and the button works again", note() === "The price list is busy (test)." && noteBad() && !pm().querySelector('[data-qt-go="stitch"]').disabled);
  await press("stitch", 20);
  ok("…and the next press clears the red and prices as before", pm().querySelector("#qtProdOwnPrice").value === "29.20" && !noteBad());
  // Enter in the field works the price out and doesn't save the line.
  typeIn('[data-qt-f="stitches"]', "4000"); reset();
  { const ev = new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }); pm().querySelector('[data-qt-f="stitches"]').dispatchEvent(ev);
    await wait(() => pm().querySelector("#qtProdOwnPrice").value === "24.00", 200);
    ok("Enter in the stitch field works the price out ($4.00 + $20.00) and doesn't save the line", ev.defaultPrevented && pm().querySelector("#qtProdOwnPrice").value === "24.00" && of("saveEstimate").length === 0); }
  { const ev = new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }); pm().querySelector("#qtProdQty").dispatchEvent(ev);
    ok("…Enter in a field outside the helpers is left alone", !ev.defaultPrevented); }
  { const ev = new w.KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }); pm().querySelector('[data-qt-f="stitches"]').dispatchEvent(ev);
    ok("…and any other key in it too", !ev.defaultPrevented); }
  pm().querySelector("#qtProdQty").value = "10"; reset();
  await submitIn("#qtProdForm");
  ok("Add line saves the quote with the price set by hand: $24.00 each", of("saveEstimate").length === 1 && same(of("saveEstimate")[0].items, [{ kind: "product", productId: "cap", size: "OSFA", qty: 10, personalized: false, persName: "", customUnitPrice: 24 }]));
  ok("…no setup line (the stitch helper adds none), the line is “Price set by hand” and totals $240.00", lines().length === 1 && sub(0) === "Price set by hand" && cells(lines()[0])[5] === "$240.00" && Number(itemsOf(Q)[0].customPrice) === 1);

  console.log("\n=== The stitch count starts from the product's design ===");
  await openProduct();
  choose("#qtProd", "mug"); click('[data-qt-deco="stitch"]'); await pause(30);
  ok("a product with no design starts with the field empty (placeholder 8500)", pm().querySelector('[data-qt-f="stitches"]').value === "" && pm().querySelector('[data-qt-f="stitches"]').placeholder === "8500");
  choose("#qtProd", "bag"); await pause(40);
  ok("a design with no stitch count on any version: empty", pm().querySelector('[data-qt-f="stitches"]').value === "");
  choose("#qtProd", "cap"); await pause(40);
  ok("changing to a product with a design fills it again (9,200)", pm().querySelector('[data-qt-f="stitches"]').value === "9200");
  reset(); choose("#qtProd", "mug"); choose("#qtProd", "cap"); await pause(40);
  ok("a design's count is asked for once while the page stays", of("getDesign").length === 0 && pm().querySelector('[data-qt-f="stitches"]').value === "9200");
  typeIn('[data-qt-f="stitches"]', "5000");
  choose("#qtProd", "mug"); choose("#qtProd", "cap"); await pause(40);
  ok("a count typed by hand is not written over by the design's", pm().querySelector('[data-qt-f="stitches"]').value === "5000");
  await closeModal();
  await openProduct();
  scripted = { action: "getDesign", status: 404, body: { status: "error", message: "Design not found" } };
  reset(); choose("#qtProd", "patch"); click('[data-qt-deco="stitch"]'); await wait(() => of("getDesign").length === 1); await pause(30);
  ok("a design that can't be read gives an empty count, with no complaint", pm().querySelector('[data-qt-f="stitches"]').value === "" && !toasts.length && !note());
  choose("#qtProd", "mug"); choose("#qtProd", "patch"); await pause(30);
  ok("…and isn't asked for again", of("getDesign").length === 1 && pm().querySelector('[data-qt-f="stitches"]').value === "");
  await closeModal();

  console.log("\n=== By stitches when it can't give a price ===");
  await setDeco(["embroidery", "dtf"], { embroidery: { stitchPricing: true, centsPer1000: 0 } });
  Q = await freshQuote(); await openProduct(); click('[data-qt-deco="stitch"]'); typeIn('[data-qt-f="stitches"]', "9000"); await press("stitch", 20);
  ok("a stitch price of $0 says so and where to set it, in red, and fills nothing", note() === "9,000 stitches × $0.00 per 1,000 Set the stitch price under Global settings → Decoration types." && noteBad() && pm().querySelector("#qtProdOwnPrice").value === "" && !pm().querySelector("#qtProdOwn").checked);
  await closeModal();
  await setDeco(["embroidery", "dtf"], { embroidery: { stitchPricing: true, centsPer1000: 100, minStitches: 5000, minCents: 750 } });
  Q = await freshQuote(); await openProduct(); click('[data-qt-deco="stitch"]'); tick('[data-qt-f="addCatalog"]', false);
  typeIn('[data-qt-f="stitches"]', "1000"); await press("stitch", 20);
  ok("the shop's minimums count: 1,000 stitches bills 5,000, and $5.00 is lifted to the $7.50 minimum", pm().querySelector("#qtProdOwnPrice").value === "7.50" && note() === "5,000 stitches × $1.00 per 1,000: $7.50 each.");
  await closeModal();
  await setDeco(["embroidery", "screenprint", "dtf"], PRICES);

  console.log("\n=== By stitches, on a custom line ===");
  Q = await freshQuote(); reset(); await openCustom();
  click('[data-qt-deco="stitch"]');
  ok("a custom line has the helper with no catalog-price tick", !pm().querySelector('[data-qt-f="addCatalog"]') && same(decoBtns(), ["By stitches", "Screen print price"]));
  ok("…and no design to start the count from", pm().querySelector('[data-qt-f="stitches"]').value === "" && of("getDesign").length === 0);
  typeIn('[data-qt-f="stitches"]', "8500"); await press("stitch", 20);
  ok("8,500 stitches at $1.00 per 1,000: the stitch price alone, $8.50, goes in the price per piece", pm().querySelector("#qtOtherPrice").value === "8.50" && note() === "8,500 stitches × $1.00 per 1,000: $8.50 each.");
  typeIn("#qtOtherName", "Embroidered patch"); typeIn("#qtOtherQty", "6"); reset();
  await submitIn("#qtOtherForm");
  ok("saved as a custom line at $8.50 and no extra lines", same(of("saveEstimate")[0].items, [{ kind: "custom", name: "Embroidered patch", qty: 6, unitPrice: 8.5, taxable: true }]) && lines().length === 1 && cells(lines()[0])[5] === "$51.00");
  await openCustom();
  click('[data-qt-deco="stitch"]');
  ok("a fee has no helpers at all", (await (async () => { await closeModal(); q("#qtAddFee").click(); await wait(() => !!pm().querySelector("#qtOtherForm")); return !pm().querySelector("#qtOtherDeco") && decoBtns().length === 0; })()));
  await closeModal();

  console.log("\n=== Screen print price ===");
  Q = await freshQuote(); await openProduct(); choose("#qtProd", "cap");
  click('[data-qt-deco="screen"]');
  ok("the button opens its pane and puts focus in Colors, which lists 1 to the shop's most (4)", !pm().querySelector('[data-qt-pane="screen"]').hidden && d.activeElement === pm().querySelector('[data-qt-f="colors"]') && same(valsOf(pm().querySelector('[data-qt-f="colors"]')), ["1", "2", "3", "4"]));
  ok("…Locations starts at 1 and the reorder box is off", pm().querySelector('[data-qt-f="locations"]').value === "1" && !pm().querySelector('[data-qt-f="reorder"]').checked && pm().querySelector('[data-qt-f="reorder"]').closest("label").textContent.trim() === "A reorder (the screens already exist)");
  choose('[data-qt-f="colors"]', "2"); reset();
  await press("screen", 20);
  ok("2 colors, 1 location: $3.00 on each piece, on top of the catalog $20.00, so $23.00 (the price still follows the catalog until typed)", of("priceDecoration").length === 1 && of("priceDecoration")[0].type === "screenprint" && same(of("priceDecoration")[0].params, { colors: 2, locations: 1, reorder: false }) && pm().querySelector("#qtProdOwnPrice").value === "23.00" && pm().querySelector("#qtProdOwn").checked);
  ok("…and says what it did, with the setup fee to come", note() === "Screen print adds $3.00 to each piece; a $40.00 screen setup fee is added as its own line when you save." && !noteBad());
  choose('[data-qt-f="colors"]', "3");
  await press("screen", 20);
  ok("pressing it again replaces its own part: 3 colors is $4.50, so $24.50, not stacked on the $23.00", pm().querySelector("#qtProdOwnPrice").value === "24.50" && note() === "Screen print adds $4.50 to each piece; a $60.00 screen setup fee is added as its own line when you save.");
  typeIn('[data-qt-f="locations"]', "2"); tick('[data-qt-f="reorder"]', true);
  await press("screen", 20);
  ok("3 colors, 2 locations, a reorder: $9.00 each ($29.00) and a $60.00 setup (3 × 2 × $10.00)", pm().querySelector("#qtProdOwnPrice").value === "29.00" && same(of("priceDecoration").pop().params, { colors: 3, locations: 2, reorder: true }) && /a \$60\.00 screen setup fee/.test(note()));
  for (const bad of ["0", "11", "x", "2.5", ""]) {
    typeIn('[data-qt-f="locations"]', bad); reset(); click('[data-qt-go="screen"]'); await pause(10);
    ok(`locations of “${bad}” are refused: “Enter how many locations (1 to 10).” in red, focus on the field, nothing asked`, note() === "Enter how many locations (1 to 10)." && noteBad() && d.activeElement === pm().querySelector('[data-qt-f="locations"]') && of("priceDecoration").length === 0);
  }
  typeIn('[data-qt-f="locations"]', "2"); typeIn("#qtProdQty", "4"); reset();
  await submitIn("#qtProdForm");
  ok("Add line saves the line at $29.00 by hand and, beside it, a Setup fee line named for what it covers, $60.00, taxed", same(of("saveEstimate")[0].items, [
    { kind: "product", productId: "cap", size: "OSFA", qty: 4, personalized: false, persName: "", customUnitPrice: 29 },
    { kind: "fee", feeKind: "setup", name: "Screen setup — 3 colors, 2 locations (reorder)", amount: 60, taxable: true }]));
  ok("…the quote lists the product line and then the fee line, as the server stored them (feeKind setup)", lines().length === 2 && itemsOf(Q).map(i => i.kind + ":" + i.feeKind).join() === "product:,fee:setup" &&
    cells(lines()[1])[0] === "Setup fee — Screen setup — 3 colors, 2 locations (reorder)" && cells(lines()[1])[5] === "$60.00" && cells(lines()[0])[5] === "$116.00");
  await openProduct(); choose("#qtProd", "cap"); click('[data-qt-deco="screen"]');
  await press("screen", 20);
  ok("1 color, 1 location: a $1.50 piece and a $20.00 setup, the name with no “1 location” and the singular “color”", /a \$20\.00 screen setup fee/.test(note()) && pm().querySelector("#qtProdOwnPrice").value === "21.50");
  reset(); await submitIn("#qtProdForm");
  ok("…the new fee line is “Screen setup — 1 color”, and the earlier one is sent back unchanged", same(of("saveEstimate")[0].items.filter(i => i.kind === "fee").map(i => i.name), ["Screen setup — 3 colors, 2 locations (reorder)", "Screen setup — 1 color"]));
  ok("…and Setup fee lines from earlier are kept", lines().filter(tr => /^Setup fee/.test(cells(tr)[0])).length === 2);

  console.log("\n=== Screen print with no setup, and on a custom line ===");
  await setDeco(["embroidery", "screenprint", "dtf"], { screenprint: { inkColorCents: 150, screenSetupCents: 0, reorderSetupCents: 0, maxColors: 4 } });
  Q = await freshQuote(); await openCustom(); click('[data-qt-deco="screen"]');
  ok("with no price typed yet the helper starts from $0.00 (not the catalog: there is none on a custom line)", pm().querySelector("#qtOtherPrice").value === "");
  choose('[data-qt-f="colors"]', "2"); await press("screen", 20);
  ok("2 colors is $3.00, and with no setup price saved no setup fee is promised", pm().querySelector("#qtOtherPrice").value === "3.00" && note() === "Screen print adds $3.00 to each piece.");
  typeIn("#qtOtherName", "Screen printed tote"); typeIn("#qtOtherQty", "5"); reset();
  await submitIn("#qtOtherForm");
  ok("saved as one custom line at $3.00 and no fee line", same(of("saveEstimate")[0].items, [{ kind: "custom", name: "Screen printed tote", qty: 5, unitPrice: 3, taxable: true }]));
  await openCustom(); typeIn("#qtOtherPrice", "10.00"); click('[data-qt-deco="screen"]'); choose('[data-qt-f="colors"]', "1"); await press("screen", 20);
  ok("a price typed first is added to: $10.00 + $1.50 is $11.50", pm().querySelector("#qtOtherPrice").value === "11.50");
  await closeModal();
  await setDeco(["embroidery", "screenprint", "dtf"], PRICES);
  Q = await freshQuote(); await openCustom(); click('[data-qt-deco="screen"]'); choose('[data-qt-f="colors"]', "2"); await press("screen", 20);
  typeIn("#qtOtherName", "Screen printed banner"); typeIn("#qtOtherQty", "2"); reset();
  await submitIn("#qtOtherForm");
  ok("a custom line with a setup saves the line and the Screen setup fee line beside it", same(of("saveEstimate")[0].items, [
    { kind: "custom", name: "Screen printed banner", qty: 2, unitPrice: 3, taxable: true },
    { kind: "fee", feeKind: "setup", name: "Screen setup — 2 colors", amount: 40, taxable: true }]) && lines().length === 2);
  scripted = { action: "priceDecoration", status: 500, body: { status: "error", message: "No screen prices (test)." } };
  await openCustom(); click('[data-qt-deco="screen"]'); await press("screen", 20);
  ok("a server error on the screen print price is shown in red", note() === "No screen prices (test)." && noteBad() && !pm().querySelector('[data-qt-go="screen"]').disabled);
  await closeModal();

  console.log("\n=== The line limit counts the setup fee line too ===");
  Q = await freshQuote();
  await saveItems(Q, Array.from({ length: 99 }, (_, i) => ({ kind: "custom", name: "Patch " + (i + 1), qty: 1, unitPrice: 1 })));
  await openQ(Q); await openCustom(); click('[data-qt-deco="screen"]'); choose('[data-qt-f="colors"]', "1"); await press("screen", 20);
  typeIn("#qtOtherName", "One too many"); reset();
  await submitIn("#qtOtherForm");
  ok("a 100th line with its setup line would be the 101st: “A quote can have at most 100 lines.”, nothing saved, the window stays", pm().querySelector("#qtOtherErr").textContent === "A quote can have at most 100 lines." && of("saveEstimate").length === 0 && itemsOf(Q).length === 99 && !pm().querySelector("#qtOtherSave").disabled);
  await closeModal();
  await openCustom(); typeIn("#qtOtherName", "Just the hundredth"); typeIn("#qtOtherPrice", "1"); reset();
  await submitIn("#qtOtherForm");
  ok("a 100th line alone is fine", of("saveEstimate").length === 1 && itemsOf(Q).length === 100);

  console.log("\n=== A role that can't set a price by hand: the product line has no helpers ===");
  w.eval(`adminPerms = ${JSON.stringify(Object.assign({}, roles.effectivePermissions(roles.DEFAULT_ROLES.admin), { "orders.payments": "read" }))};`);
  Q = await freshQuote(); await openProduct();
  ok("with no way to type a price on the line there is nothing for the helpers to fill: no hand-price box, no helper box", !pm().querySelector("#qtProdOwn") && !pm().querySelector("#qtProdDeco") && decoBtns().length === 0);
  await closeModal(); await openCustom();
  ok("…a custom line has its price field anyway, so its helpers stay", decoBtns().length === 2);
  await closeModal();
  w.eval(roles.asRole("admin", { name: "Tester", email: "tester@example.test" }));

  console.log("\n=== A product with choices: what + Product offers ===");
  // The failures come first: the page keeps a shop's graphics once it has them.
  scripted = { action: "listGraphics", status: 500, body: { status: "error", message: "Graphics are away (test)." } };
  Q = await freshQuote("rec"); reset(); q("#qtAddProduct").click(); await wait(() => toasts.length === 1);
  ok("a shop whose every product has choices, with its graphics unreadable: a toast says the choices products can't be quoted until they load", toasts[0].m === "Couldn't load the shop's graphics: Graphics are away (test). Products with choices can't be quoted until they load." && toasts[0].err);
  await wait(() => toasts.length >= 2, 100);
  ok("…and “This shop has no products to quote. Add a custom line instead.” follows", toasts.length === 2 && toasts[1].m === "This shop has no products to quote. Add a custom line instead." && toasts.every(t => t.err) && !modal());
  reset(); await openProduct();
  ok("…asked again, the graphics load and the product with choices is offered", of("listGraphics").length === 1 && of("listGraphics")[0].org === "rec" && same([...pm().querySelectorAll("#qtProd option")].map(o => o.value), ["pennant"]) && !toasts.length);
  ok("…its colour (Red) and its one place (Top, no None, the graphic picked) are drawn", pm().querySelector("#qtProdColor").value === "Red" && same(optsOf(locSel("top")), ["Booster mark (+$1.00)"]) && locSel("top").value === String(gRec));
  await closeModal();
  Q = await freshQuote(); reset(); await openProduct();
  ok("the other shop's graphics were kept from its first window: not asked for again", of("listGraphics").length === 0);
  ok("a plain product has no colour or location pickers", (choose("#qtProd", "cap"), pm().querySelector("#qtProdCfg").hidden && pm().querySelector("#qtProdLocs").innerHTML === ""));

  console.log("\n=== The colour and graphic pickers ===");
  choose("#qtProd", "jacket");
  const cfgBox = () => pm().querySelector("#qtProdCfg");
  ok("a product with choices shows its picks: Garment color with its colors", !cfgBox().hidden && !pm().querySelector("#qtProdColorWrap").hidden && same(valsOf(pm().querySelector("#qtProdColor")), ["Navy", "Grey"]) && pm().querySelector("#qtProdColor").value === "Navy");
  ok("…a pick for each place: Front and Back, each starting at None", same([...pm().querySelectorAll("#qtProdLocs label.cust-field > span:not(.qt-sr)")].map(s => s.textContent), ["Front", "Back"]) && locSel("front").value === "" && locSel("back").value === "");
  ok("…Front on a Navy jacket offers, with each add-on price, only what the shop sells there: no Winter mark (Grey only), no Vinyl mark (vinyl isn't ticked), no Hidden mark, then the customer's own design", same(optsOf(locSel("front")), ["None", "Lockup (+$2.00)", "Capital (+$4.00)", "Crest", "Blocked mark (+$1.00)", "Customer's own design (+$6.00)"]));
  ok("…Back leaves out Capital (Front only) and shows its own design price ($9.00), not the product's", same(optsOf(locSel("back")), ["None", "Lockup (+$2.00)", "Customer's own design (+$9.00)"]));
  ok("…the preview says the catalog price is with the choices above", pm().querySelector("#qtProdPreview").textContent === "Catalog price $50.00 each with the choices above.");
  choose('select[data-qt-loc="front"]', String(gLock));
  ok("picking Lockup adds its price to the preview: $52.00", pm().querySelector("#qtProdPreview").textContent === "Catalog price $52.00 each with the choices above.");
  ok("…and it has two thread colours, so a thread colour pick appears, on the first", !pm().querySelector('select[data-qt-ink="front"]').closest("label").hidden && same(valsOf(pm().querySelector('select[data-qt-ink="front"]')), ["White", "Gold"]) && pm().querySelector('select[data-qt-ink="front"]').value === "White" &&
    pm().querySelector('select[data-qt-ink="front"]').getAttribute("aria-label") === "Thread color for Front");
  ok("…Back has no thread colour pick while it is None", pm().querySelector('select[data-qt-ink="back"]').closest("label").hidden);
  choose('select[data-qt-ink="front"]', "Gold");
  choose('select[data-qt-loc="back"]', "custom");
  ok("the customer's own design at Back adds its place's price: $50 + $2 + $9 = $61.00", pm().querySelector("#qtProdPreview").textContent === "Catalog price $61.00 each with the choices above." && pm().querySelector('select[data-qt-ink="front"]').value === "Gold");
  choose('select[data-qt-loc="front"]', String(gCrest));
  ok("a graphic with a single thread colour shows no thread pick (its colour goes with the line)", pm().querySelector('select[data-qt-ink="front"]').closest("label").hidden && pm().querySelector("#qtProdPreview").textContent === "Catalog price $59.00 each with the choices above.");
  choose('select[data-qt-loc="front"]', String(gLock));
  ok("coming back to a two-colour graphic starts at its first colour (the pick was for another graphic)", pm().querySelector('select[data-qt-ink="front"]').value === "White");
  choose("#qtProdColor", "Grey");
  ok("a Grey jacket: the Winter mark (Grey only) is offered, and the blocked mark (blocked for Grey) is not", same(optsOf(locSel("front")), ["None", "Lockup (+$2.00)", "Capital (+$4.00)", "Crest", "Winter mark (+$1.00)", "Customer's own design (+$6.00)"]));
  ok("…what was picked and is still offered stays picked (Lockup in Front, the customer's design at Back)", locSel("front").value === String(gLock) && locSel("back").value === "custom");
  choose('select[data-qt-loc="front"]', String(gWinter));
  choose("#qtProdColor", "Navy");
  ok("back to Navy: the Winter mark is gone, so Front falls back to None (not to something else)", locSel("front").value === "" && !optsOf(locSel("front")).some(t => /Winter/.test(t)));
  await closeModal();

  console.log("\n=== Which graphics are offered follows the switched-on decorations ===");
  await openProduct(); choose("#qtProd", "jacket");
  ok("a graphic printed by a switched-off type (Vinyl mark, vinyl is not ticked) is not offered", !optsOf(locSel("front")).some(t => /Vinyl mark/.test(t)));
  await closeModal();
  await setDeco(["embroidery", "screenprint", "vinyl", "dtf"], PRICES);
  Q = await freshQuote(); await openProduct(); choose("#qtProd", "jacket");
  ok("…and is offered once vinyl is ticked", optsOf(locSel("front")).includes("Vinyl mark (+$1.00)"));
  choose('select[data-qt-loc="front"]', String(gVinyl)); choose("#qtProdQty", "1");
  typeIn("#qtProdQty", "2"); reset();
  await submitIn("#qtProdForm");
  const VQ = Q;
  ok("(a jacket with the Vinyl mark is quoted)", of("saveEstimate").length === 1 && lines().length === 1);
  await setDeco(["embroidery", "screenprint", "dtf"], PRICES);
  await openQ(VQ); q("#qtLines [data-qt-edit]").click(); await wait(() => !!modal() && !!pm().querySelector("#qtProdForm"));
  ok("with vinyl switched off again, a quote line that already has the Vinyl mark still shows and keeps it (nothing is hidden from a record)", locSel("front").value === String(gVinyl) && optsOf(locSel("front")).some(t => /Vinyl mark/.test(t)));
  await closeModal();
  await openQ(Q); await openProduct(); choose("#qtProd", "jacket");
  ok("…while a new line doesn't offer it", !optsOf(locSel("front")).some(t => /Vinyl mark/.test(t)));
  await closeModal();

  console.log("\n=== A single place to decorate, and the colour price groups ===");
  await openProduct(); choose("#qtProd", "visor");
  ok("a product with no garment colours has no colour pick", pm().querySelector("#qtProdColorWrap").hidden);
  ok("…one place and options to choose from: no None, the first is picked", same(optsOf(locSel("front")), ["Lockup (+$2.00)", "Crest"]) && locSel("front").value === String(gLock));
  ok("…and the preview includes it: $15 + $2 = $17.00", pm().querySelector("#qtProdPreview").textContent === "Catalog price $17.00 each with the choices above.");
  choose("#qtProd", "visor2");
  ok("with something already fixed on the product, a single place can still be left blank: None is offered and chosen", same(optsOf(locSel("front")), ["None", "Lockup (+$2.00)", "Crest"]) && locSel("front").value === "" && pm().querySelector("#qtProdPreview").textContent === "Catalog price $15.00 each with the choices above.");
  choose("#qtProd", "hoodie");
  ok("a sized product with colour prices: the sizes are priced for the colour picked (Navy: the product's own)", same(optsOf(pm().querySelector("#qtProdSize")), ["S — $30.00", "M — $30.00", "L — $34.00"]));
  choose("#qtProdSize", "L"); choose("#qtProdColor", "Grey");
  ok("…choosing Grey reprices every size from its colour group, and the size stays on L", same(optsOf(pm().querySelector("#qtProdSize")), ["S — $33.00", "M — $33.00", "L — $37.00"]) && pm().querySelector("#qtProdSize").value === "L");
  ok("…and the preview is the Grey L price plus the Lockup that is picked for the only place: $37.00 + $2.00", pm().querySelector("#qtProdPreview").textContent === "Catalog price $39.00 each with the choices above.");
  choose('select[data-qt-loc="front"]', String(gCrest));
  ok("…a graphic with no add-on leaves just the Grey L price: $37.00", pm().querySelector("#qtProdPreview").textContent === "Catalog price $37.00 each with the choices above.");
  await closeModal();
  await openProduct(); choose("#qtProd", "jacket");
  ok("going back to a plain product hides the picks, and to another with choices starts them afresh", (() => { choose("#qtProd", "cap"); const hid = cfgBox().hidden && pm().querySelector("#qtProdLocs").innerHTML === ""; choose("#qtProd", "jacket"); return hid && locSel("front").value === "" && pm().querySelector("#qtProdColor").value === "Navy"; })());
  await closeModal();

  console.log("\n=== A graphic with one thread colour sends that colour ===");
  Q = await freshQuote(); await openProduct(); choose("#qtProd", "visor"); choose('select[data-qt-loc="front"]', String(gCrest)); reset();
  await submitIn("#qtProdForm");
  ok("the thread colour isn't asked (one only) but goes with the line, and a product with no colours sends an empty garment colour", same(of("saveEstimate")[0].items[0].config, { garmentColor: "", locations: [{ location: "front", graphicId: gCrest, ink: "Navy" }] }) && lines().length === 1 && sub(0) === "Front: Crest (Navy)");

  console.log("\n=== A product with choices on the quote: saved, shown, changed, converted ===");
  Q = await freshQuote(); await openProduct(); choose("#qtProd", "jacket");
  choose("#qtProdColor", "Grey");
  choose('select[data-qt-loc="front"]', String(gLock)); choose('select[data-qt-ink="front"]', "Gold");
  choose('select[data-qt-loc="back"]', "custom");
  typeIn("#qtProdQty", "3"); reset();
  await submitIn("#qtProdForm");
  const sentItem = of("saveEstimate")[0].items[0];
  ok("the line is saved with its colour and each place picked: the graphic and thread colour, or “custom” for the customer's own", same(sentItem.config, { garmentColor: "Grey", locations: [{ location: "front", graphicId: gLock, ink: "Gold" }, { location: "back", custom: true }] }) && sentItem.size === "OSFA");
  ok("…the quote kept it (configJson), with the graphic's name filled in by the server", (() => { const c = JSON.parse(itemsOf(Q)[0].configJson); return c.garmentColor === "Grey" && c.locations.length === 2 && c.locations[0].graphicName === "Lockup" && c.locations[0].ink === "Gold"; })());
  ok("…the line shows the picks under its name: colour, then each place", sub(0) === "Grey · Front: Lockup (Gold) · Back: Your own design");
  ok("…priced with the add-ons: $50 + $2 + $9 = $61.00 each, $183.00", cells(lines()[0])[4] === "$61.00" && cells(lines()[0])[5] === "$183.00");
  reset(); q("#qtLines [data-qt-edit]").click(); await wait(() => !!modal() && !!pm().querySelector("#qtProdForm"));
  ok("Change opens with the saved picks in place: the product, the colour, the graphic, its thread colour and the customer's design", pm().querySelector("#qtProd").value === "jacket" && pm().querySelector("#qtProdColor").value === "Grey" && locSel("front").value === String(gLock) &&
    pm().querySelector('select[data-qt-ink="front"]').value === "Gold" && locSel("back").value === "custom" && pm().querySelector("#qtProdQty").value === "3");
  choose('select[data-qt-loc="back"]', ""); choose('select[data-qt-loc="front"]', String(gCap)); reset();
  await submitIn("#qtProdForm");
  ok("changing the picks and saving replaces the line in place: Capital in Front only, $50 + $4 = $54.00", lines().length === 1 && sub(0) === "Grey · Front: Capital" && cells(lines()[0])[4] === "$54.00" && of("saveEstimate")[0].items[0].config.locations.length === 1);
  ok("a quote line's picks are not repeated as a size: no “Size” text", !/Size/.test(sub(0)));
  // A bad pick is the server's to say.
  await openProduct(); choose("#qtProd", "jacket"); reset();
  await submitIn("#qtProdForm");
  ok("a jacket with nothing picked at either place is refused by the server, its words shown in the window", of("saveEstimate").length === 1 && /^Line 2: /.test(pm().querySelector("#qtProdErr").textContent) && pm().querySelector("#qtProdErr").textContent.length > 12 && !pm().querySelector("#qtProdSave").disabled);
  await closeModal();
  // Convert to order: the order line keeps the config.
  await openQ(Q);
  q("#qtConvert").click(); await wait(() => modal());
  reset();
  await (async () => { const old = page(); modal().querySelector("#qtConvForm").dispatchEvent(new w.Event("submit", { cancelable: true })); return wait(() => page() && page() !== old && oneDrawn()); })();
  const conv = est(Q);
  const ordRows = d1.q("SELECT * FROM order_items WHERE orderId = ?", conv.orderId);
  ok("Convert to order makes the order, and its line keeps the colour and the picks", conv.status === "converted" && ordRows.length === 1 && (() => { const c = JSON.parse(ordRows[0].configJson); return c.garmentColor === "Grey" && c.locations.length === 1 && c.locations[0].graphicName === "Capital"; })());
  ok("…at the quote's price: 3 at $54.00", ordRows[0].qty === 3 && ordRows[0].unitPriceCents === 5400 && ordRows[0].lineTotalCents === 16200);

  console.log("\n=== A line's picks as text: what is left out ===");
  const QT = (await mk("acme")).id;
  await saveItems(QT, [{ kind: "product", productId: "cap", size: "OSFA", qty: 1, personalized: false, persName: "" }, { kind: "custom", name: "Banner", qty: 1, unitPrice: 5 }]);
  d1._raw.run("UPDATE estimate_items SET configJson = ? WHERE estimateId = ? AND position = 0", [JSON.stringify({ garmentColor: "Navy", locations: [
    { location: "front", label: "Front", graphicName: "Lockup", ink: "White" }, { location: "back", auto: true, graphicName: "Auto mark" }, { location: "reorderqr", graphicName: "QR" },
    { location: "sleeve", fixed: true, graphicName: "Sleeve" }, { location: "hem", custom: true }, { location: "cuff", graphicName: "Cuff" }] }), QT]);
  d1._raw.run("UPDATE estimate_items SET configJson = ? WHERE estimateId = ? AND position = 1", [JSON.stringify({ garmentColor: "Red", locations: [{ location: "front", graphicName: "Should not show on a custom line" }] }), QT]);
  await openQ(QT);
  ok("the colour, then each place's name and thread colour; a reorder QR, an automatic or a fixed one is left out; the customer's own design is named; a place with no label shows its key", sub(0) === "Navy · Front: Lockup (White) · hem: Customer's own design · cuff: Cuff");
  ok("a custom line never shows picks", !/Navy|Red|Should not/.test(sub(1)) && sub(1) === "Custom line");
  d1._raw.run("UPDATE estimate_items SET configJson = ? WHERE estimateId = ? AND position = 0", [JSON.stringify({ garmentColor: "Navy" }), QT]);
  await openQ(QT);
  ok("a saved copy with no places listed shows nothing", sub(0) === "");

  await part2();
  async function part2() {
    console.log("\n=== The quote email shows a line's picks ===");
    const mail = [];
    global.fetch = async (url, init) => { if (captureMail(url, init, mail)) return MAIL_OK; throw new Error("unexpected fetch " + url); };
    const M = new Function(dbSrc + "\n" + strip(read("functions/_lib/email.js")) + "\nreturn { estimateLinesView, buildEstimateEmail, sendEstimateResponseNotification, sendInvoiceDeliveryNotification, sendDailyDigestEmail, getEstimate, addOwnerNotice, getUnsentOwnerNotices };")();
    const env = { DB: d1, ...MAIL_ENV, OWNER_EMAIL: "owner@example.com" };
    const plain = (html) => String(html || "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
    const real = await M.getEstimate(d1, Q);
    const view = M.estimateLinesView(real.items);
    ok("a real quote's line with picks has them as its detail: the colour, then each place, as the admin page shows them", view.lines.length === 1 && view.lines[0].detail === "Grey · Front: Capital");
    const email = M.buildEstimateEmail({ estimate: real.estimate, items: real.items, totals: real.totals, orgName: "Example Club", link: "https://example.com/?estimate=abc" });
    ok("the quote email shows them in small print under the line's name", email.html.includes('Build-a-jacket<div style="font-size:12px;color:#666">Grey · Front: Capital</div>'));
    ok("…and in the plain-text copy after a dash", email.text.includes("3 × Build-a-jacket — Grey · Front: Capital  $54.00 each  $162.00"));
    const plainLine = M.estimateLinesView([{ kind: "product", name: "Club cap", size: "OSFA", qty: 1, unitPrice: 20, lineTotal: 20 }]);
    ok("a plain line has no small print under it", plainLine.lines[0].detail === "" && !/font-size:12px;color:#666/.test(M.buildEstimateEmail({ estimate: {}, items: [{ kind: "product", name: "Club cap", qty: 1, unitPrice: 20, lineTotal: 20 }], totals: {} }).html));
    const both = M.estimateLinesView([{ kind: "product", name: "Jacket", qty: 1, unitPrice: 50, lineTotal: 50, config: { garmentColor: "Navy", locations: [{ location: "front", label: "Front", graphicName: "Crest", ink: "White" }, { location: "back", auto: true, graphicName: "QR" }] }, personalized: true, persName: "Sam" }]);
    ok("with a personalization too, both are there: the picks, then the name in quotes (an automatic place is left out)", both.lines[0].detail === "Navy · Front: Crest (White) · “Sam”");

    console.log("\n=== The customer's answer is queued as a Quote ===");
    d1._raw.run("DELETE FROM owner_notices");
    await M.sendEstimateResponseNotification(env, { estimate: { number: "Q-00123", orgId: "acme", customerName: "Pat Example" }, accepted: true, orderId: "ACME-Q00123", note: "Thanks!" });
    const nrows = d1.q("SELECT * FROM owner_notices");
    ok("the answer is one notice of kind quote (the database allows it, migrations/0119), not invoice", nrows.length === 1 && nrows[0].kind === "quote" && nrows[0].orderId === "ACME-Q00123" && nrows[0].orgId === "acme" && nrows[0].summary === "Pat Example accepted quote Q-00123 — it is now order ACME-Q00123" && nrows[0].detail === "Their note: Thanks!");
    ok("…and nothing was emailed at once", mail.length === 0);
    await M.sendEstimateResponseNotification(env, { estimate: { number: "Q-00124", orgId: "acme" }, accepted: false, note: "" });
    await M.sendInvoiceDeliveryNotification(env, { orderId: "ACME-1001", orgId: "acme", customerName: "Sam Example", choice: "pickup", detail: "" });
    await M.addOwnerNotice(d1, { kind: "gift_card", orderId: "GC-1", orgId: "acme", summary: "A gift card was bought" });
    await M.addOwnerNotice(d1, { kind: "po", orderId: "PO-1", orgId: "acme", summary: "A purchase order came in" });
    ok("a real invoice notice is still kind invoice, and the gift card and PO kinds are accepted by the database", d1.q("SELECT kind FROM owner_notices ORDER BY id").map(r => r.kind).join() === "quote,quote,invoice,gift_card,po");

    console.log("\n=== The morning roll-up's names ===");
    const unsent = await M.getUnsentOwnerNotices(d1);
    const sentOk = await M.sendDailyDigestEmail(env, { notices: unsent, orgNames: { acme: "Example Club" } });
    const roll = mail[mail.length - 1];
    const typeCells = [...roll.htmlBody.matchAll(/<td style="padding:6px 8px;vertical-align:top;white-space:nowrap">([^<]*)<\/td>\s*<td style="padding:6px 8px;vertical-align:top;white-space:nowrap">[^<]*<br>/g)].map(m => m[1]);
    ok("the roll-up is sent", sentOk === true && !!roll && /Daily roll-up/.test(roll.subject));
    ok("its Type column names the notices Quote, Quote, Invoice, Gift card and PO, in order", same(typeCells, ["Quote", "Quote", "Invoice", "Gift card", "PO"]));
    ok("…a customer's quote answer is under “Payments, refunds & customer responses” with its summary and their note", /Payments, refunds &amp; customer responses/.test(roll.htmlBody) && plain(roll.htmlBody).includes("Pat Example accepted quote Q-00123 — it is now order ACME-Q00123 Their note: Thanks!"));
    const odd = await M.sendDailyDigestEmail(env, { notices: [{ kind: "mystery", orderId: "X-1", orgId: "acme", summary: "Something new", detail: "", imageUrls: [], urgent: false, createdAt: "2026-01-01T00:00:00Z" }], orgNames: {} });
    ok("a kind the roll-up has no name for shows as it is", odd === true && /<td[^>]*>mystery<\/td>/.test(mail[mail.length - 1].htmlBody));
    ok("the plain-text roll-up lists them with the same names", ["Quote  ACME-Q00123", "Quote  Q-00124", "Invoice  ACME-1001", "Gift card  GC-1", "PO  PO-1"].every(t => roll.body.includes(t)));

    console.log("\n=== The admin Communications page names the notices ===");
    {
      const adminSrc = read("public/admin.js");
      const fn = adminSrc.slice(adminSrc.indexOf("async function renderCommunications("), adminSrc.indexOf("async function checkBlankShipmentsNow("));
      const m = fn.match(/const KIND = (\{[^}]*\});/);
      const KIND = m ? new Function("return " + m[1])() : {};
      ok("its kind names include Quote, Gift card and PO (as the roll-up's do), so a quote notice is not shown as raw \"quote\"", KIND.quote === "Quote" && KIND.gift_card === "Gift card" && KIND.po === "PO");
      ok("…and the ones it already had are unchanged", KIND.payment === "Payment" && KIND.refund === "Refund" && KIND.dispute === "Dispute" && KIND.design === "Design response" && KIND.delivered === "Delivered" && KIND.picked_up === "Picked up");
    }

    console.log("\n=== A database from before the quote notices ===");
    const old = await createD1();
    old._raw.exec(read("testlib/schema-pre-0006.sql"));
    for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006" && f < "0119").sort()) old.execFile(read("migrations/" + f));
    mail.length = 0;
    const realError = console.error; const logged = []; console.error = (...a) => logged.push(a.map(String).join(" "));
    try { await M.sendEstimateResponseNotification({ DB: old, ...MAIL_ENV, OWNER_EMAIL: "owner@example.com" }, { estimate: { number: "Q-00200", orgId: "acme" }, accepted: true, orderId: "ACME-Q00200", customerName: "Pat Example", note: "" }); }
    finally { console.error = realError; }
    ok("when the database refuses the new kind the owner is emailed at once instead, so the answer is never lost", mail.length === 1 && mail[0].subject === "Quote accepted — acme — Q-00200" && old.q("SELECT COUNT(*) AS n FROM owner_notices")[0].n === 0 && logged.some(l => /Could not queue owner notice/.test(l)));
  }

  console.log("\nAll checks ran");
})().catch((e) => { console.error(e); console.log("test381 crashed: false"); process.exit(1); });
