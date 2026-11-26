const fs = require("fs");
const { JSDOM, VirtualConsole } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");
const { storefrontPage } = require("./testlib/storefront-page");
const { shopOrigin } = require("./testlib/hosts.js");
const { ok } = require("./testlib/check");
const roles = require("./testlib/roles");

// Discount codes (migrations/0115) as a shop's customers meet them:
//   functions/api/catalog.js — catalog.discountCodes, the yes/no that shows the checkout's code box (DISCOUNT_BOX_SQL_):
//     a code that's on, for this shop or every shop, not past its last day (loose by one day), with uses left (released
//     uses don't count); false with no 0115 or on a failed read (logged unless it's "no such table"); not read at all
//     while the Discount codes feature is off; read fresh on every answer (saving a code needs no Publish).
//   public/storefront.js — the "Discount code" box in the real page (jsdom): when it shows, Apply / Enter / Remove, the
//     server's messages (aria-live) and announceStatus, the "Discount (SAVE10)" line and the total, cartTax_'s discount
//     in tax-added mode, the re-check when the cart changes (debounced; refused → removed, no answer → kept), an email
//     edit clearing a refusal about the address, placeOrder (a typed code not applied, discountCode sent, the attempt
//     signature, the saved discount/total/owed, owed 0 → no card step and "nothing to pay"), reset on a shop switch and
//     after an order. One section runs the page against the REAL catalog.js and orders.js.
//   functions/_lib/email.js — discountLabelNote_ in the receipt lines: "Discount (SAVE10)" from the code, the rest of
//     the note kept, a manual discount's note as before.
// The REAL db.js, email.js, pdf.js, catalogCache.js, catalog.js and orders.js on sql.js; only the Cache API and the mail
// provider are stand-ins. Invented data only.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");

global.fetch = async (url) => { throw new Error("unexpected fetch " + url); };

// Mail is never sent: send_ records the message instead.
const sentMail = [];
const emailSrc = strip(read("functions/_lib/email.js")).replace(/async function send_\(/, "async function send_unused_(") +
  "\nasync function send_(env, m) { __sent.push(m); return true; }\n";
const L = new Function("__sent",
  strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  strip(read("functions/_lib/db.js")) + "\n" + strip(read("functions/_lib/pdf.js")) + "\n" + emailSrc + "\n" + strip(read("functions/_lib/quoteToken.js")) + "\n" +
  strip(read("functions/_lib/boxSize.js")) + "\n" + strip(read("functions/_lib/catalogCache.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'pat@example.com';\n" + roles.adminAs() + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyTurnstile = async () => ({ ok: true });\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  "const ordersApi = (function(){\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost; })();\n" +
  "const catalogApi = (function(){\n" + strip(read("functions/api/catalog.js")) + "\nreturn { onRequestGet, DISCOUNT_BOX_SQL_ }; })();\n" +
  "return { ordersApi, catalogGet: catalogApi.onRequestGet, DISCOUNT_BOX_SQL_: catalogApi.DISCOUNT_BOX_SQL_, receiptLines_, discountLabelNote_, buildOrderReceivedEmail,\n" +
  "  createProduct, publishShop, setFeatures, bumpCatalogVersion, invalidateCatalogVersionCache, _resetCatalogCacheState, saveDiscountCode, getOrderById };")(sentMail);

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
const DAY = 86400000;
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const quietly = async (fn) => { const err = console.error, logged = []; console.error = (...a) => logged.push(a.map(String).join(" ")); try { return { v: await fn(), logged }; } finally { console.error = err; } };

async function freshDb(upTo = "9999") {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006" && f.slice(0, 4) <= upTo).sort()) d1.execFile(read("migrations/" + f));
  return d1;
}
async function addShop(d1, orgId, name) {
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, "desc", accent, createdAt, updatedAt, ready) VALUES ('${orgId}','${orgId}','${name}','Gear.','#123456','t','t',1);`);
  await L.createProduct(d1, orgId, { productId: "tee", type: "shirt", name: "Club Tee", pricingMode: "flat", flatPrice: 20, visible: true, noDesignNeeded: true, reorderQr: "none" });
}
let codeN = 0;
// A code row as the migration stores it (the catalog's query reads the table, not db.js).
function addCode(d1, { orgId = null, active = 1, expiresOn = null, maxUses = 5, code = "CODE" + (++codeN) } = {}) {
  d1.q(`INSERT INTO discount_codes (code, kind, percentBps, orgId, maxUses, expiresOn, active, createdAt) VALUES (?, 'percent', 1000, ?, ?, ?, ?, 't')`,
    code, orgId, maxUses, expiresOn, active);
  return d1.q("SELECT id FROM discount_codes WHERE code = ?", code)[0].id;
}
const addUse = (d1, codeId, orderId, released = false) =>
  d1.q("INSERT INTO discount_code_uses (codeId, orderId, email, amountCents, usedAt, releasedAt) VALUES (?, ?, '', 100, 't', ?)", codeId, orderId, released ? "t2" : null);

(async () => {
  // ============================================================================================================
  console.log("=== catalog.discountCodes: whether the checkout shows the code box ===");
  // ============================================================================================================
  freshCacheApi();
  const d1 = await freshDb();
  await addShop(d1, "club", "Example Club");
  await addShop(d1, "boost", "Example Boosters");
  await L.publishShop(d1, "club"); await L.publishShop(d1, "boost");
  const env = { DB: d1 };
  const catalogOn = async (sub, e = env) => {
    const res = await L.catalogGet({ request: { url: shopOrigin(sub) + "/api/catalog", headers: { get: () => null } }, env: e });
    const text = await res.text();
    return { status: res.status, body: JSON.parse(text), text };
  };
  const flag = async (sub, e) => (await catalogOn(sub, e)).body.catalog.discountCodes;
  const clear = () => { d1._raw.exec("DELETE FROM discount_code_uses; DELETE FROM discount_codes;"); };

  let c = await catalogOn("club");
  ok("no codes at all: the catalog says discountCodes: false (the key is there, a boolean)", c.status === 200 && c.body.catalog.discountCodes === false);
  const allShops = addCode(d1, { code: "SAVE10" });
  c = await catalogOn("club");
  ok("an every-shop code (orgId NULL), on, no expiry, uses left → true, without a Publish or a version bump", c.body.catalog.discountCodes === true);
  ok("…only the yes/no leaves the server: no code text, value or count in the answer", !/SAVE10|percentBps|maxUses|discount_codes/.test(c.text));
  ok("…and for every shop", (await flag("boost")) === true);
  d1.q("UPDATE discount_codes SET active = 0 WHERE id = ?", allShops);
  ok("switched off → false (the cached shop isn't what decides: read fresh each time)", (await flag("club")) === false);
  d1.q("UPDATE discount_codes SET active = 1, orgId = 'boost' WHERE id = ?", allShops);
  ok("a code for one shop → true there", (await flag("boost")) === true);
  ok("…and false at another shop", (await flag("club")) === false);
  d1.q("UPDATE discount_codes SET orgId = 'club' WHERE id = ?", allShops);
  ok("…and true at its own", (await flag("club")) === true);

  const now = Date.now();
  d1.q("UPDATE discount_codes SET expiresOn = ? WHERE id = ?", utcDay(now + 30 * DAY), allShops);
  ok("a last day in the future → true", (await flag("club")) === true);
  d1.q("UPDATE discount_codes SET expiresOn = ? WHERE id = ?", utcDay(now), allShops);
  ok("a last day of today (UTC) → true", (await flag("club")) === true);
  d1.q("UPDATE discount_codes SET expiresOn = ? WHERE id = ?", utcDay(now - DAY), allShops);
  ok("a last day of yesterday (UTC) → still true: loose by one day, since the business's today may be UTC's yesterday", (await flag("club")) === true);
  d1.q("UPDATE discount_codes SET expiresOn = ? WHERE id = ?", utcDay(now - 2 * DAY), allShops);
  ok("a last day two days back → false", (await flag("club")) === false);
  d1.q("UPDATE discount_codes SET expiresOn = NULL, maxUses = 2 WHERE id = ?", allShops);
  addUse(d1, allShops, "CLUB-1");
  ok("one live use of two → true", (await flag("club")) === true);
  addUse(d1, allShops, "CLUB-2");
  ok("two live uses of two (used up) → false", (await flag("club")) === false);
  d1.q("UPDATE discount_code_uses SET releasedAt = 't3' WHERE orderId = 'CLUB-2'");
  ok("one of them given back (released, a voided order) → true again: released uses don't count", (await flag("club")) === true);
  addUse(d1, addCode(d1, { orgId: "club", maxUses: 1 }), "CLUB-3", true);
  d1.q("UPDATE discount_codes SET active = 0 WHERE id = ?", allShops);
  ok("a single-use code whose one use was given back → true (another code, the first switched off)", (await flag("club")) === true);
  clear();
  const usedUp = addCode(d1, { orgId: null, maxUses: 1 });
  addUse(d1, usedUp, "BOOST-1");
  addCode(d1, { orgId: "club", active: 0 });
  addCode(d1, { orgId: "boost", expiresOn: utcDay(now - 5 * DAY) });
  ok("several codes, none usable (used up, off, expired) → false", (await flag("club")) === false && (await flag("boost")) === false);
  addCode(d1, { orgId: "boost" });
  ok("…one usable among them → true for its shop only", (await flag("boost")) === true && (await flag("club")) === false);

  {
    // The query's text, checked as written (a mutation of a clause shows up in the checks above too).
    const sql = L.DISCOUNT_BOX_SQL_;
    ok("DISCOUNT_BOX_SQL_ is one cheap row (LIMIT 1) and counts only live uses (releasedAt IS NULL)", /LIMIT 1\s*$/.test(sql) && /u\.releasedAt IS NULL/.test(sql) && /< d\.maxUses/.test(sql));
  }

  // The feature switch: off → no read at all, and false.
  {
    const seen = [];
    const spy = Object.assign({}, d1, { prepare: (sql) => { seen.push(sql); return d1.prepare(sql); } });
    await flag("boost", { DB: spy });
    ok("(with the feature on the discount query is read)", seen.some(s => /FROM discount_codes/.test(s)));
    await L.setFeatures(d1, { discounts: false }); await L.bumpCatalogVersion(d1); L.invalidateCatalogVersionCache();
    seen.length = 0;
    c = await catalogOn("boost", { DB: spy });
    ok("Discount codes feature off → discountCodes false although boost has a usable code", c.status === 200 && c.body.catalog.discountCodes === false);
    ok("…and the discount_codes table isn't read at all", !seen.some(s => /discount_codes/.test(s)));
    ok("…while the answer still tells the page the feature is off", c.body.features && c.body.features.discounts === false);
    await L.setFeatures(d1, { discounts: true }); await L.bumpCatalogVersion(d1); L.invalidateCatalogVersionCache();
    ok("back on → true again", (await flag("boost")) === true);
  }
  // A read that fails: false, logged (anything but a missing table).
  {
    const broken = Object.assign({}, d1, { prepare: (sql) => /FROM discount_codes/.test(sql) ? { bind: () => ({ first: async () => { throw new Error("D1_ERROR: disk I/O"); } }) } : d1.prepare(sql) });
    const r = await quietly(() => catalogOn("boost", { DB: broken }));
    ok("a failed read → the shop is still answered, discountCodes false", r.v.status === 200 && r.v.body.catalog.discountCodes === false);
    ok("…and the failure is logged", r.logged.some(l => /discount code check failed/.test(l) && /disk I\/O/.test(l)));
    const missing = Object.assign({}, d1, { prepare: (sql) => /FROM discount_codes/.test(sql) ? { bind: () => ({ first: async () => { throw new Error("D1_ERROR: no such table: discount_codes"); } }) } : d1.prepare(sql) });
    const r2 = await quietly(() => catalogOn("boost", { DB: missing }));
    ok("\"no such table\" → false, and nothing logged", r2.v.body.catalog.discountCodes === false && !r2.logged.some(l => /discount code check failed/.test(l)));
  }
  {
    freshCacheApi();
    const old = await freshDb("0110");
    await addShop(old, "club", "Example Club");
    await L.publishShop(old, "club");
    const r = await quietly(() => catalogOn("club", { DB: old }));
    ok("a database without 0115: the shop page is answered with discountCodes false", r.v.status === 200 && r.v.body.status === "ok" && r.v.body.catalog.discountCodes === false && r.v.body.catalog.products.length === 1);
    ok("…and nothing logged about it", !r.logged.some(l => /discount code check failed/.test(l)));
    freshCacheApi();
  }

  // ============================================================================================================
  console.log("\n=== email.js: the receipt's discount line (discountLabelNote_) ===");
  // ============================================================================================================
  {
    const N = L.discountLabelNote_;
    ok("no code, no note → nothing", N({}) === "" && N({ discountNote: "  " }) === "");
    ok("no code, a manual note → \" (note)\", trimmed", N({ discountNote: " Team rate " }) === " (Team rate)");
    ok("a code with its stored note \"Code SAVE10\" → \" (SAVE10)\" (not \"Code SAVE10\")", N({ discountCode: "SAVE10", discountNote: "Code SAVE10" }) === " (SAVE10)");
    ok("…the note matched whatever its case", N({ discountCode: "SAVE10", discountNote: "code save10" }) === " (SAVE10)");
    ok("…a note the owner added to since: \"Code SAVE10; Balance waived\" → \" (SAVE10; Balance waived)\"",
      N({ discountCode: "SAVE10", discountNote: "Code SAVE10; Balance waived" }) === " (SAVE10; Balance waived)");
    ok("…with no space after the ';' as well", N({ discountCode: "SAVE10", discountNote: "Code SAVE10;Balance waived" }) === " (SAVE10; Balance waived)");
    ok("…a note that's something else entirely is kept after the code", N({ discountCode: "SAVE10", discountNote: "Owner's pick" }) === " (SAVE10; Owner's pick)");
    ok("…\"Code SAVE100\" is not \"Code SAVE10\" (the code must end there)", N({ discountCode: "SAVE10", discountNote: "Code SAVE100" }) === " (SAVE10; Code SAVE100)");
    ok("…no note → just the code", N({ discountCode: " SAVE10 ", discountNote: "" }) === " (SAVE10)");
    ok("…a code with - and _ is matched too", N({ discountCode: "CLUB-2026_A", discountNote: "Code CLUB-2026_A" }) === " (CLUB-2026_A)");

    const base = { orderId: "CLUB-9", customerName: "Pat Example", contact: "pat@example.com", items: [{ name: "Club Tee", qty: 2, lineTotal: 40, tax: 0 }], taxMode: "inclusive" };
    const label = (o) => (L.receiptLines_(o).rows.find(r => /^Discount/.test(r.label)) || {}).label || null;
    const row = (o) => L.receiptLines_(o).rows.find(r => /^Discount/.test(r.label)) || null;
    ok("receiptLines_: a code's discount reads \"Discount (SAVE10)\" −$4.00, in green",
      (() => { const r = row({ ...base, discountAmount: 4, discountNote: "Code SAVE10", discountCode: "SAVE10" }); return r && r.label === "Discount (SAVE10)" && r.value === "−$4.00" && r.green === true; })());
    ok("…a manual discount still reads \"Discount (Team rate)\"", label({ ...base, discountAmount: 4, discountNote: "Team rate" }) === "Discount (Team rate)");
    ok("…and a bare \"Discount\" with no note", label({ ...base, discountAmount: 4 }) === "Discount");
    ok("…no row at all with no discount, even with a code", row({ ...base, discountAmount: 0, discountCode: "SAVE10" }) === null);
    const mail = await L.buildOrderReceivedEmail({}, { ...base, discountAmount: 4, discountNote: "Code SAVE10", discountCode: "SAVE10", balanceDue: 36 }, { pdf: false });
    ok("the order-received email's text has \"Discount (SAVE10): −$4.00\"", /\nDiscount \(SAVE10\): −\$4\.00\n/.test(mail.text));
    ok("…and its HTML the same label, escaped", /Discount \(SAVE10\)<\/td><td[^>]*>−\$4\.00/.test(mail.html) && !/Code SAVE10/.test(mail.html));
  }

  // ============================================================================================================
  console.log("\n=== The shop page: the code box (public/storefront.js, with a stand-in server) ===");
  // ============================================================================================================
  const baseCatalog = { name: "Example Club", eyebrow: "", accent: "#123456", ready: true, desc: "", designImages: { shirt: "", cap: "", detail: "" },
    enabledPayments: ["Card", "Check"], salesTaxRate: 0, discountCodes: true, graphics: [],
    products: [
      { id: "tee", type: "shirt", name: "Club Tee", sub: "", images: [], features: [], flatPrice: 20, personalizationPrice: null },
      { id: "cap", type: "cap", name: "Club Cap", sub: "", images: [], features: [], flatPrice: 20, personalizationPrice: null, taxable: false },
    ] };
  // server: { check(body) → { status, body } | Promise, order(body) → { status, body }, checkout(body) }
  const page = async ({ catalog = {}, features = {}, preview = false, server = {} } = {}) => {
    const calls = [];
    const vc = new VirtualConsole();
    vc.on("jsdomError", (e) => { if (!/Not implemented: navigation/.test(String(e && e.message))) console.error(e); });
    const answer = { status: "ok", orgId: "club", features, ...(preview ? { preview: true } : {}), catalog: { ...baseCatalog, ...catalog } };
    const dom = new JSDOM(storefrontPage({ adminCss: false }), { runScripts: "dangerously", url: shopOrigin("club") + "/", pretendToBeVisual: true, virtualConsole: vc,
      beforeParse(win) {
        win.scrollTo = () => {}; win.alert = () => {};
        win.fetch = async (u, opts) => {
          const url = String(u), body = opts && opts.body ? JSON.parse(opts.body) : null;
          calls.push({ url, body });
          if (server.fetchThrows && server.fetchThrows(url, body)) throw new TypeError("Failed to fetch");
          let r = { status: 200, body: {} };
          if (url.startsWith("/api/catalog")) r = { status: 200, body: answer };
          else if (url.startsWith("/api/orders") && body && body.action === "checkDiscountCode") r = await (server.check ? server.check(body) : { status: 200, body: { status: "ok", code: "SAVE10", label: "10% off", discount: 2 } });
          else if (url.startsWith("/api/orders")) r = await (server.order ? server.order(body) : { status: 200, body: { status: "ok", checkoutToken: "tok-1" } });
          else if (url.startsWith("/api/checkout")) r = server.checkout ? server.checkout(body) : { status: 200, body: { url: "https://checkout.example.test/s" } };
          const text = JSON.stringify(r.body);
          return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => JSON.parse(text), text: async () => text, headers: { get: () => null } };
        };
      } });
    const w = dom.window, d = w.document;
    await wait(() => !!d.getElementById("ticketPanel"));
    const ev = (el, t) => el.dispatchEvent(new w.Event(t, { bubbles: true }));
    const $ = (id) => d.getElementById(id);
    const add = (pid = "tee") => d.querySelector(`[data-action="add"][data-pid="${pid}"]`).click();
    const type = (text) => { const i = $("discountCodeInput"); i.value = text; ev(i, "input"); };
    const apply = () => d.querySelector('[data-action="discount-apply"]').click();
    const checks = () => calls.filter(x => x.body && x.body.action === "checkDiscountCode");
    const orders = () => calls.filter(x => x.url.startsWith("/api/orders") && x.body && !x.body.action);
    const status = () => { const s = $("statusRegion"); return s ? s.textContent : ""; };
    const spans = (l) => l ? [...l.children].map(x => x.textContent.trim()).join(" ") : null;
    const lineText = () => spans(d.querySelector(".ticket-discount-line"));
    const total = () => d.querySelector(".ticket-total .t-amount").textContent.trim();
    const details = (payment = "Check") => { $("custName").value = "Pat Example"; $("custContact").value = "pat@example.com"; $("custPaymentMethod").value = payment; };
    const place = async () => { $("placeOrderBtn").click(); await pause(60); };
    return { w, d, calls, ev, $, add, spans, type, apply, checks, orders, status, lineText, total, details, place };
  };

  // ---- When the box shows ----
  {
    let p = await page();
    ok("an empty cart: no code box, though the shop has codes", !p.$("discountCodeInput") && !p.d.querySelector(".discount-section"));
    p.add();
    const box = p.$("discountCodeInput");
    ok("an item in the cart: the \"Discount code\" box shows", !!box && p.d.querySelector('label[for="discountCodeInput"]').textContent === "Discount code");
    ok("…with an Apply button (no Remove yet)", !!p.d.querySelector('[data-action="discount-apply"]') && p.d.querySelector('[data-action="discount-apply"]').textContent === "Apply" && !p.d.querySelector('[data-action="discount-remove"]'));
    ok("…the field takes up to 32 characters, no autocomplete, not read-only", box.maxLength === 32 && box.getAttribute("autocomplete") === "off" && !box.readOnly);
    ok("…its message is an aria-live region, hidden while empty", p.$("discountMsg").getAttribute("aria-live") === "polite" && p.$("discountMsg").hidden && p.$("discountOn").hidden);
    ok("…described by the message and the applied line", box.getAttribute("aria-describedby") === "discountMsg discountOn");
    ok("…placed above the totals", !!p.d.querySelector(".discount-section ~ .ticket-total"));
    p = await page({ catalog: { discountCodes: false } }); p.add();
    ok("catalog.discountCodes false: no box", !p.$("discountCodeInput"));
    p = await page({ catalog: { discountCodes: undefined } }); p.add();
    ok("…missing: no box", !p.$("discountCodeInput"));
    p = await page({ catalog: { discountCodes: "true" } }); p.add();
    ok("…anything but true itself (\"true\"): no box", !p.$("discountCodeInput"));
    p = await page({ features: { discounts: false } }); p.add();
    ok("the Discount codes feature off: no box, though the catalog says true", !p.$("discountCodeInput"));
    p = await page({ features: { discounts: true } }); p.add();
    ok("…the feature on (explicitly): the box", !!p.$("discountCodeInput"));
    p = await page({ preview: true }); p.add();
    ok("a draft preview (ordering is off there): no box", !p.$("discountCodeInput"));
  }

  // ---- Apply / Enter / Remove, the messages and the totals ----
  {
    let release;
    const p = await page({ server: { check: (body) => new Promise(res => { release = () => res({ status: 200, body: { status: "ok", code: "SAVE10", label: "10% off", discount: 2 } }); }) } });
    p.add();
    p.apply();
    ok("Apply with an empty box: \"Enter a discount code.\" and no request", p.$("discountMsg").textContent === "Enter a discount code." && !p.$("discountMsg").hidden && p.checks().length === 0);
    p.type("save10");
    ok("typing clears the message at once", p.$("discountMsg").hidden && p.$("discountMsg").textContent === "");
    p.$("custContact").value = "  pat@example.com ";
    p.type("  save10 ");
    p.apply();
    await pause(10);
    const req = p.checks()[0];
    ok("Apply asks /api/orders { action: checkDiscountCode } once", p.checks().length === 1 && req.url === "/api/orders");
    ok("…with this shop's orgId, the code trimmed, the email typed so far", req.body.orgId === "club" && req.body.code === "save10" && req.body.email === "pat@example.com");
    ok("…and the cart's lines (productId, qty, lineTotal)", Array.isArray(req.body.items) && req.body.items.length === 1 && req.body.items[0].productId === "tee" && req.body.items[0].qty === 1 && req.body.items[0].lineTotal === 20);
    const btn = p.d.querySelector('[data-action="discount-apply"]');
    ok("while it's asked: the button says \"Checking…\" and is disabled", btn.textContent === "Checking…" && btn.disabled);
    p.$("discountCodeInput").dispatchEvent(new p.w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await pause(10);
    ok("…Enter meanwhile doesn't ask again", p.checks().length === 1);
    ok("…and the email typed is kept through the redraw", p.$("custContact").value === "pat@example.com");
    release(); await pause(20);
    ok("the server's yes: the box shows the code it sent, read-only", p.$("discountCodeInput").value === "SAVE10" && p.$("discountCodeInput").readOnly);
    ok("…\"SAVE10 — 10% off\" under it", !p.$("discountOn").hidden && p.$("discountOn").textContent === "SAVE10 — 10% off");
    ok("…Remove instead of Apply", !!p.d.querySelector('[data-action="discount-remove"]') && !p.d.querySelector('[data-action="discount-apply"]'));
    ok("…a \"Discount (SAVE10) −$2.00\" line in the totals", p.lineText() === "Discount (SAVE10) −$2.00");
    ok("…the Merchandise line stays the full $20.00", /Merchandise\s*\$20\.00/.test(p.d.querySelector(".ticket-breakdown").textContent));
    ok("…and the total is $18.00", p.total() === "$18.00");
    ok("…announced: \"SAVE10 applied: 10% off. \"", p.status() === "SAVE10 applied: 10% off. ");
    ok("…no message", p.$("discountMsg").hidden);
    p.$("discountCodeInput").dispatchEvent(new p.w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await pause(10);
    ok("Enter on an applied code asks nothing", p.checks().length === 1);
    p.d.querySelector('[data-action="discount-remove"]').click();
    ok("Remove: the box is empty and editable again, with Apply", p.$("discountCodeInput").value === "" && !p.$("discountCodeInput").readOnly && !!p.d.querySelector('[data-action="discount-apply"]'));
    ok("…the discount line is gone and the total back to $20.00", p.lineText() === null && p.total() === "$20.00");
    ok("…focus is on the box", p.d.activeElement === p.$("discountCodeInput"));
    ok("…announced: \"Discount code SAVE10 removed.\"", p.status() === "Discount code SAVE10 removed.");
    ok("…and no breakdown at all for a plain $20 cart", !p.d.querySelector(".ticket-breakdown"));
  }
  {
    // Enter applies; a server answer with no label; a code sent back in another case.
    const p = await page({ server: { check: () => ({ status: 200, body: { status: "ok", code: "", label: "", discount: 5 } }) } });
    p.add();
    p.type("club5");
    const e = new p.w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    p.$("discountCodeInput").dispatchEvent(e);
    await pause(20);
    ok("Enter in the box applies it (and the key's default is stopped)", p.checks().length === 1 && e.defaultPrevented);
    ok("…a reply without a code: the typed code, upper-cased", p.$("discountCodeInput").value === "CLUB5" && p.lineText() === "Discount (CLUB5) −$5.00");
    ok("…without a label: just the code under the box, and \"discount\" in the announcement", p.$("discountOn").textContent === "CLUB5" && p.status() === "CLUB5 applied: discount. ");
    p.$("custContact").dispatchEvent(new p.w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    p.d.querySelector('[data-action="discount-remove"]').click();
    p.type("x");
    p.$("custName").dispatchEvent(new p.w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    p.$("discountCodeInput").dispatchEvent(new p.w.KeyboardEvent("keydown", { key: "a", bubbles: true }));
    await pause(20);
    ok("Enter in another field, or another key in the box, asks nothing", p.checks().length === 1);
  }
  {
    // Refusals and failures, as the customer reads them.
    const answers = [];
    const p = await page({ server: { check: () => answers.shift(), fetchThrows: (url, body) => body && body.code === "OFFLINE" } });
    p.add();
    const tryCode = async (code, answer) => { if (answer) answers.push(answer); p.type(code); p.apply(); await pause(20); return p.$("discountMsg"); };
    let m = await tryCode("NOPE", { status: 400, body: { status: "error", message: "This code isn't valid." } });
    ok("a refusal (400): the server's sentence under the box, shown", m.textContent === "This code isn't valid." && !m.hidden);
    ok("…announced as well", p.status() === "This code isn't valid.");
    ok("…the box keeps what was typed, editable, with Apply", p.$("discountCodeInput").value === "NOPE" && !p.$("discountCodeInput").readOnly && !!p.d.querySelector('[data-action="discount-apply"]'));
    ok("…no discount line, total unchanged", p.lineText() === null && p.total() === "$20.00");
    m = await tryCode("OLD", { status: 200, body: { status: "error", message: "This code has expired." } });
    ok("a 200 that says status \"error\": its message", m.textContent === "This code has expired.");
    m = await tryCode("MANY", { status: 429, body: { status: "error", message: "Too many requests" } });
    ok("429: \"Too many tries — please wait a minute and try again.\"", m.textContent === "Too many tries — please wait a minute and try again.");
    m = await tryCode("SRV", { status: 500, body: { status: "error", message: "D1_ERROR: internals" } });
    ok("500: a passing failure, never the server's internals", m.textContent === "We couldn't check that code just now. Please try again." && !/D1_ERROR/.test(p.d.body.textContent));
    m = await tryCode("SRV2", { status: 400, body: {} });
    ok("a 4xx with no message: the passing-failure sentence", m.textContent === "We couldn't check that code just now. Please try again.");
    m = await tryCode("OFFLINE");
    ok("no answer at all (fetch fails): \"check your connection\"", m.textContent === "We couldn't check that code — check your connection and try again." && p.status() === m.textContent);
    ok("…and the button is usable again", !p.d.querySelector('[data-action="discount-apply"]').disabled && p.d.querySelector('[data-action="discount-apply"]').textContent === "Apply");
    m = await tryCode("ESC", { status: 400, body: { status: "error", message: "<img src=x onerror=alert(1)>" } });
    ok("a message with markup is shown as text", m.textContent === "<img src=x onerror=alert(1)>" && !p.d.querySelector("#discountMsg img"));
  }

  // ---- The discount in the totals: capped, and the tax estimate in tax-added mode ----
  {
    const p = await page({ server: { check: () => ({ status: 200, body: { status: "ok", code: "BIG", label: "$50.00 off", discount: 50 } }) } });
    p.add(); p.type("BIG"); p.apply(); await pause(20);
    ok("a discount bigger than the goods shows as the goods' total: −$20.00, total $0.00", p.lineText() === "Discount (BIG) −$20.00" && p.total() === "$0.00");
  }
  {
    const p = await page({ catalog: { salesTaxMode: "exclusive", salesTaxRate: 10, salesTaxJurisdiction: "" },
      server: { check: () => ({ status: 200, body: { status: "ok", code: "SAVE10", label: "10% off", discount: 4 } }) } });
    p.add("tee"); p.add("cap");
    const taxLine = () => { const l = p.d.querySelector(".ticket-tax-line"); return l ? [...l.children].map(x => x.textContent.trim()).join(" ") : null; };
    ok("tax added on top, before a code: $2.00 tax on the taxable tee, total $42.00", taxLine() === "Sales tax (10%) $2.00" && p.total() === "$42.00");
    p.type("SAVE10"); p.apply(); await pause(20);
    ok("…a $4 code on $40 of goods ($20 taxable): the tax comes down by the discount's taxable half's tax, to $1.80", taxLine() === "Sales tax (10%) $1.80");
    ok("…total $40 − $4 + $1.80 = $37.80", p.total() === "$37.80" && p.lineText() === "Discount (SAVE10) −$4.00");
    const tax = (args, discount) => p.w.cartTax_(p.w.eval("currentOrg"), { kind: "option", fee: 0 }, 0, discount);
    ok("cartTax_ with no discount argument: as before ($2.00)", tax(null, undefined).tax === 2 && tax(null, undefined).added === true);
    ok("…a discount of 0 or not a number changes nothing", tax(null, 0).tax === 2 && tax(null, "abc").tax === 2);
    ok("…a discount past the goods counts only up to them (all of the taxable share comes off)", tax(null, 400).tax === 0);
    ok("…1 cent of discount: half a cent taxable rounds to 1 cent, tax of it rounds to 0", tax(null, 0.01).tax === 2);
    p.w.eval("currentOrg.salesTaxMode = 'inclusive'");
    ok("…tax included in the prices: nothing added, discount or not", tax(null, 4).added === false && tax(null, 4).tax === 0);
  }

  // ---- The cart changes: the code is asked about again ----
  {
    const answers = [];
    const p = await page({ server: { check: (body) => answers.length ? answers.shift() : { status: 200, body: { status: "ok", code: "SAVE10", label: "10% off", discount: Math.round(body.items.reduce((s, i) => s + i.lineTotal, 0) * 10) / 100 } } } });
    p.add(); p.type("SAVE10"); p.apply(); await pause(20);
    ok("(applied: −$2.00 on $20)", p.lineText() === "Discount (SAVE10) −$2.00" && p.checks().length === 1);
    p.d.querySelector('.cart-line [data-action="qty"][data-d="1"]').click();
    p.d.querySelector('.cart-line [data-action="qty"][data-d="1"]').click();
    await pause(100);
    ok("+ twice: no request at once (debounced)", p.checks().length === 1);
    ok("…meanwhile the line shows the last answer (still −$2.00, not more)", p.lineText() === "Discount (SAVE10) −$2.00" && p.total() === "$58.00");
    await pause(750);
    ok("…after the pause ONE request, for the cart as it is now (3 pieces)", p.checks().length === 2 && p.checks()[1].body.items[0].qty === 3 && p.checks()[1].body.code === "SAVE10");
    ok("…and its answer shown: −$6.00, total $54.00", p.lineText() === "Discount (SAVE10) −$6.00" && p.total() === "$54.00");
    await pause(800);
    ok("…and no more requests while nothing changes", p.checks().length === 2);
    // No answer: kept as it was.
    answers.push({ status: 503, body: { status: "error", message: "busy" } });
    p.d.querySelector('.cart-line [data-action="qty"][data-d="-1"]').click();
    await pause(800);
    ok("a re-check with no answer (503): the code is kept, with the last discount", p.checks().length === 3 && p.lineText() === "Discount (SAVE10) −$6.00" && p.$("discountMsg").hidden);
    await pause(800);
    ok("…and not asked again for the same cart (its answer stands for it)", p.checks().length === 3);
    // Refused: removed, with the reason.
    answers.push({ status: 400, body: { status: "error", message: "This code has reached its limit." } });
    p.add("cap");
    await pause(800);
    ok("a re-check refused: the code comes off", p.lineText() === null && p.total() === "$60.00" && !p.$("discountCodeInput").readOnly);
    ok("…with \"SAVE10 no longer applies: This code has reached its limit.\" under the box", p.$("discountMsg").textContent === "SAVE10 no longer applies: This code has reached its limit." && !p.$("discountMsg").hidden);
    ok("…announced", p.status() === "SAVE10 no longer applies: This code has reached its limit.");
    ok("…and the box has Apply again", !!p.d.querySelector('[data-action="discount-apply"]'));
  }
  {
    // The cart emptied: the code goes with it.
    const p = await page();
    p.add(); p.type("SAVE10"); p.apply(); await pause(20);
    p.d.querySelector(".remove-x").click();
    ok("the last line removed: the box is gone and nothing is applied", !p.$("discountCodeInput") && p.w.eval("discountApplied_") === null);
    p.add();
    ok("…adding again shows the box with Apply, empty of discount", !!p.d.querySelector('[data-action="discount-apply"]') && p.lineText() === null);
    await pause(800);
    ok("…and no re-check was sent for it", p.checks().length === 1);
  }
  {
    // A re-check whose answer comes after the code was removed is ignored; one whose cart was emptied meanwhile clears.
    let release;
    let n = 0;
    const p = await page({ server: { check: () => (++n === 1 ? { status: 200, body: { status: "ok", code: "SAVE10", label: "10% off", discount: 2 } }
      : new Promise(res => { release = () => res({ status: 200, body: { status: "ok", code: "SAVE10", label: "10% off", discount: 9 } }); })) } });
    p.add(); p.type("SAVE10"); p.apply(); await pause(20);
    p.d.querySelector('.cart-line [data-action="qty"][data-d="1"]').click();
    await pause(780);
    ok("(a re-check is on its way)", p.checks().length === 2);
    p.d.querySelector('[data-action="discount-remove"]').click();
    release(); await pause(20);
    ok("removed meanwhile: its late answer doesn't bring the code back", p.lineText() === null && p.w.eval("discountApplied_") === null && p.$("discountCodeInput").value === "");
    n = 0;
    p.type("SAVE10"); p.apply(); await pause(20);
    p.w.eval("scheduleDiscountRecheck_(); cart.length = 0;");
    await pause(780);
    ok("a re-check that finds the cart empty: the code is cleared, nothing asked", p.w.eval("discountApplied_") === null && p.checks().length === 3);
  }

  // ---- The email address ----
  {
    const answers = [];
    const p = await page({ server: { check: () => answers.shift() || { status: 200, body: { status: "ok", code: "PAT1", label: "$5.00 off", discount: 5 } } } });
    p.add();
    const email = (v) => { p.$("custContact").value = v; p.ev(p.$("custContact"), "input"); };
    answers.push({ status: 400, body: { status: "error", message: "This code isn't valid. If it was sent to you, check the email address is the one it was sent to." } });
    p.type("PAT1"); p.apply(); await pause(20);
    ok("(a refusal about the address)", /check the email address/.test(p.$("discountMsg").textContent));
    email("pat@example.co");
    ok("typing in the email field clears a refusal about the address", p.$("discountMsg").hidden && p.$("discountMsg").textContent === "");
    answers.push({ status: 400, body: { status: "error", message: "Enter your email address first — this code is for one person." } });
    p.apply(); await pause(20);
    email("pat@example.com");
    ok("…and \"Enter your email address first\"", p.$("discountMsg").hidden);
    answers.push({ status: 400, body: { status: "error", message: "This code has expired." } });
    p.apply(); await pause(20);
    email("pat@example.org");
    ok("…but not a refusal that isn't about the address (\"This code has expired.\")", !p.$("discountMsg").hidden && p.$("discountMsg").textContent === "This code has expired.");
    p.type("PAT1"); p.apply(); await pause(20);
    const before = p.checks().length;
    email("pat@example.net");
    await pause(100);
    ok("with a code applied, an email edit asks again — after the pause", p.checks().length === before);
    await pause(750);
    ok("…once, with the new address", p.checks().length === before + 1 && p.checks()[before].body.email === "pat@example.net");
    answers.push({ status: 400, body: { status: "error", message: "This code isn't valid. If it was sent to you, check the email address is the one it was sent to." } });
    email("sam@example.com");
    await pause(800);
    ok("…a code for one person refused for the new address comes off, with the reason", p.lineText() === null && /^PAT1 no longer applies: This code isn't valid\./.test(p.$("discountMsg").textContent));
    email("pat@example.com");
    ok("…and that reason clears as the address is typed again", p.$("discountMsg").hidden);
  }

  // ---- Placing the order ----
  {
    const p = await page({ server: { order: () => ({ status: 200, body: { status: "ok", checkoutToken: "tok-1", discount: 2, discountCode: "SAVE10", total: 18, owed: 18 } }) } });
    p.add(); p.details("Check");
    p.type("SAVE10");
    await p.place();
    ok("a code typed but not applied: the order isn't sent", p.orders().length === 0);
    ok("…\"Press Apply to use your discount code, or clear the box to order without it.\", and the box focused",
      p.$("checkoutMsg").textContent === "Press Apply to use your discount code, or clear the box to order without it." && !p.$("checkoutMsg").hidden && p.d.activeElement === p.$("discountCodeInput"));
    p.type("   ");
    await p.place();
    ok("a box of spaces only doesn't hold the order up, and sends no code", p.orders().length === 1 && !("discountCode" in p.orders()[0].body) && !("discount" in p.orders()[0].body));
  }
  {
    let release;
    const p = await page({ server: { check: () => new Promise(res => { release = () => res({ status: 200, body: { status: "ok", code: "SAVE10", label: "10% off", discount: 2 } }); }),
      order: () => ({ status: 200, body: { status: "ok", checkoutToken: "tok-1", discount: 2, discountCode: "SAVE10", total: 18, owed: 18 } }) } });
    p.add(); p.details("Check"); p.type("SAVE10"); p.apply();
    await p.place();
    ok("Place order while the code is being checked: \"Checking your discount code — one moment.\", nothing sent",
      p.$("checkoutMsg").textContent === "Checking your discount code — one moment." && p.orders().length === 0);
    release(); await pause(20);
    await p.place();
    const sent = p.orders()[0];
    ok("once applied: the order carries discountCode \"SAVE10\" and the discount the cart showed", !!sent && sent.body.discountCode === "SAVE10" && sent.body.discount === 2);
    ok("…and the total the cart showed ($18.00)", sent.body.total === 18);
    const conf = p.d.querySelector(".confirmation");
    ok("the confirmation lists \"Discount (SAVE10) −$2.00\"", !!conf && /Discount \(SAVE10\)\s*−\$2\.00/.test(conf.querySelector(".conf-items").textContent));
    ok("…the total $18.00, in the summary and by the order number", /Total\s*\$18\.00/.test(conf.textContent) && /· \$18\.00/.test(conf.querySelector(".order-number").textContent));
    ok("…and, with something owed, the check payment details", /Check payment/.test(conf.textContent) && /Please pay using the details below/.test(conf.textContent));
    ok("after the order the code is reset (nothing applied, box empty)", p.w.eval("discountApplied_") === null && p.w.eval("discountInput_") === "" && p.w.eval("discountMsg_") === "");
    p.d.querySelector('[data-action="go-org"]').click();
    p.add();
    ok("…the next cart starts with an empty box and no discount", p.$("discountCodeInput").value === "" && p.lineText() === null && !!p.d.querySelector('[data-action="discount-apply"]'));
  }
  {
    // The server's figures win; an answer without discountCode keeps the applied code's text.
    const p = await page({ server: { order: () => ({ status: 200, body: { status: "ok", taxMode: "exclusive", salesTax: 1.5, checkoutToken: "tok-1", discount: 3.25, total: 17.75, owed: 17.75 } }) } });
    p.add(); p.details("Check"); p.type("SAVE10"); p.apply(); await pause(20);
    await p.place();
    const conf = p.d.querySelector(".confirmation");
    ok("the server's discount (3.25), not the cart's, is on the confirmation", /Discount \(SAVE10\)\s*−\$3\.25/.test(conf.textContent));
    ok("…with its total ($17.75)", /Total\s*\$17\.75/.test(conf.textContent) && /· \$17\.75/.test(conf.textContent));
  }
  {
    // owed 0 by Card: no card step, "nothing to pay".
    const p = await page({ server: { order: () => ({ status: 200, body: { status: "ok", checkoutToken: "tok-1", discount: 20, discountCode: "FREE", total: 0, owed: 0 } }),
      check: () => ({ status: 200, body: { status: "ok", code: "FREE", label: "100% off", discount: 20 } }) } });
    p.add(); p.details("Card"); p.type("FREE"); p.apply(); await pause(20);
    ok("(a 100% code: the cart total is $0.00)", p.total() === "$0.00");
    await p.place();
    ok("owed 0 by card: no card step (/api/checkout not called)", !p.calls.some(c => c.url.startsWith("/api/checkout")));
    const conf = p.d.querySelector(".confirmation");
    ok("…the confirmation says \"Your order is in. Your discount covers it — there's nothing to pay.\"", !!conf && conf.querySelector("p").textContent === "Your order is in. Your discount covers it — there's nothing to pay.");
    ok("…shows Discount (FREE) −$20.00 and a total of $0.00", /Discount \(FREE\)\s*−\$20\.00/.test(conf.textContent) && /Total\s*\$0\.00/.test(conf.textContent));
    ok("…and nothing pending for a card (no unpaid banner remembered)", !p.w.sessionStorage.getItem("pendingCard:club"));
    ok("…the code is reset", p.w.eval("discountApplied_") === null);
  }
  {
    // owed 0 by Check: no payment instructions.
    const p = await page({ server: { order: () => ({ status: 200, body: { status: "ok", checkoutToken: "tok-1", discount: 20, discountCode: "FREE", total: 0, owed: 0 } }),
      check: () => ({ status: 200, body: { status: "ok", code: "FREE", label: "100% off", discount: 20 } }) } });
    p.add(); p.details("Check"); p.type("FREE"); p.apply(); await pause(20);
    await p.place();
    const conf = p.d.querySelector(".confirmation");
    ok("owed 0 by check: \"nothing to pay\", and no check payment details", /nothing to pay/.test(conf.textContent) && !/Check payment/.test(conf.textContent) && !conf.querySelector(".payment-instructions"));
  }
  {
    // Something owed by Card: the card step, and the code reset on the way to it.
    const p = await page({ server: { order: () => ({ status: 200, body: { status: "ok", checkoutToken: "tok-1", discount: 2, discountCode: "SAVE10", total: 18, owed: 18 } }) } });
    p.add(); p.details("Card"); p.type("SAVE10"); p.apply(); await pause(20);
    await p.place();
    ok("owed 18 by card: the card step is started", p.calls.filter(c => c.url.startsWith("/api/checkout")).length === 1);
    ok("…remembering the server's total ($18)", JSON.parse(p.w.sessionStorage.getItem("pendingCard:club") || "null").total === 18);
    ok("…and the code is reset on the way to Stripe", p.w.eval("discountApplied_") === null && p.w.eval("discountInput_") === "");
  }
  {
    // The card step fails: the order is saved, the code reset.
    for (const how of ["no url", "throws"]) {
      const p = await page({ server: { order: () => ({ status: 200, body: { status: "ok", checkoutToken: "tok-1", discount: 2, discountCode: "SAVE10", total: 18, owed: 18 } }),
        checkout: () => { if (how === "throws") throw new Error("offline"); return { status: 500, body: { status: "error" } }; } } });
      p.add(); p.details("Card"); p.type("SAVE10"); p.apply(); await pause(20);
      const err = console.error; console.error = () => {};
      await p.place();
      console.error = err;
      ok(`the card step failing (${how}): the confirmation, and the code reset`, !!p.d.querySelector(".confirmation") && p.w.eval("discountApplied_") === null && p.w.eval("discountInput_") === "");
    }
  }
  {
    // The order attempt's signature includes the code: same checkout → same order id; a code → a new one.
    let fail = true;
    const p = await page({ server: { order: () => fail ? { status: 500, body: {} } : { status: 200, body: { status: "ok", checkoutToken: "tok-1" } } } });
    p.add(); p.details("Check");
    const err = console.error; console.error = () => {};
    await p.place(); await p.place();
    const [a, b] = p.orders().map(o => o.body.orderId);
    ok("a retry of the same checkout (no code) sends the same order id", !!a && a === b);
    p.type("SAVE10"); p.apply(); await pause(20);
    await p.place();
    const c3 = p.orders()[2].body.orderId;
    ok("…with a code applied it's another order (a new id)", !!c3 && c3 !== a && p.orders()[2].body.discountCode === "SAVE10");
    await p.place();
    ok("…retried with the same code: that new id again", p.orders()[3].body.orderId === c3);
    p.d.querySelector('[data-action="discount-remove"]').click();
    await p.place();
    console.error = err;
    ok("…removed again: not the code's id", p.orders()[4].body.orderId !== c3 && !("discountCode" in p.orders()[4].body));
  }
  {
    // A refusal of the order (400, e.g. the code was used up meanwhile): the code stays, the message is shown.
    const p = await page({ server: { order: () => ({ status: 400, body: { status: "error", message: "This code has reached its limit." } }) } });
    p.add(); p.details("Check"); p.type("SAVE10"); p.apply(); await pause(20);
    const err = console.error; console.error = () => {};
    await p.place();
    console.error = err;
    ok("an order refused for its code: the reason in the checkout message, nothing recorded",
      /This code has reached its limit\./.test(p.$("checkoutMsg").textContent) && /Nothing was recorded/.test(p.$("checkoutMsg").textContent));
    ok("…the code still applied, for the customer to Remove or try again", !!p.w.eval("discountApplied_") && p.lineText() === "Discount (SAVE10) −$2.00");
  }
  {
    // A shop switch (render() for another org) resets the code.
    const p = await page();
    p.add(); p.type("SAVE10"); p.apply(); await pause(20);
    ok("(applied)", !!p.w.eval("discountApplied_"));
    p.w.eval("currentOrg = Object.assign({}, currentOrg, { orgId: 'boost' }); route = { view: 'org', org: 'boost' }; render();");
    ok("switching to another shop: nothing applied, nothing typed, no message", p.w.eval("discountApplied_") === null && p.w.eval("discountInput_") === "" && p.w.eval("discountMsg_") === "");
    p.add();
    ok("…its cart's box is empty", p.$("discountCodeInput").value === "" && p.lineText() === null);
    p.type("ABC");
    p.w.eval("render();");
    ok("…while a redraw of the SAME shop keeps what's typed", p.w.eval("discountInput_") === "ABC" && p.$("discountCodeInput").value === "ABC");
  }

  // ============================================================================================================
  console.log("\n=== The page against the real server (catalog.js + orders.js) ===");
  // ============================================================================================================
  {
    freshCacheApi();
    const db = await freshDb();
    await addShop(db, "club", "Example Club");
    db._raw.exec(`UPDATE orgs SET enabledPayments='["Check"]' WHERE orgId='club'`);
    await L.publishShop(db, "club");
    const saved = await L.saveDiscountCode(db, { code: "SAVE10", kind: "percent", percent: 10, orgId: "club", maxUses: 5 }, { actor: "pat@example.com" });
    ok("(SAVE10 saved for the shop)", !!saved.code);
    const realEnv = { DB: db, SIGNING_SECRET: "s".repeat(40) };
    const calls = [];
    const vc = new VirtualConsole();
    vc.on("jsdomError", (e) => { if (!/Not implemented: navigation/.test(String(e && e.message))) console.error(e); });
    const dom = new JSDOM(storefrontPage({ adminCss: false }), { runScripts: "dangerously", url: shopOrigin("club") + "/", pretendToBeVisual: true, virtualConsole: vc,
      beforeParse(win) {
        win.scrollTo = () => {}; win.alert = () => {};
        win.fetch = async (u, opts) => {
          const url = shopOrigin("club") + String(u), body = opts && opts.body ? JSON.parse(opts.body) : null;
          calls.push({ url: String(u), body });
          const waits = [];
          const ctx = { env: realEnv, waitUntil: (p) => waits.push(Promise.resolve(p).catch(() => {})),
            request: { url, method: opts && opts.method || "GET", json: async () => body, headers: { get: () => null } } };
          const res = String(u).startsWith("/api/catalog") ? await L.catalogGet(ctx) : await L.ordersApi(ctx);
          await Promise.all(waits);
          const text = await res.text();
          return { ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => JSON.parse(text), text: async () => text, headers: { get: () => null } };
        };
      } });
    const w = dom.window, d = w.document;
    await wait(() => !!d.getElementById("ticketPanel"));
    const ev = (el, t) => el.dispatchEvent(new w.Event(t, { bubbles: true }));
    ok("the real catalog says discountCodes: true, and the page reads it", w.eval("currentOrg.discountCodes") === true);
    d.querySelector('[data-action="add"][data-pid="tee"]').click();
    d.querySelector('.cart-line [data-action="qty"][data-d="1"]').click();
    const box = d.getElementById("discountCodeInput");
    box.value = "save10"; ev(box, "input");
    d.querySelector('[data-action="discount-apply"]').click();
    await wait(() => !!d.querySelector(".ticket-discount-line"));
    ok("Apply against the real orders.js: \"SAVE10 — 10% off\" and −$4.00 on $40", d.getElementById("discountOn").textContent === "SAVE10 — 10% off" &&
      /Discount \(SAVE10\)\s*−\$4\.00/.test(d.querySelector(".ticket-discount-line").textContent) && d.querySelector(".ticket-total .t-amount").textContent.trim() === "$36.00");
    d.getElementById("custName").value = "Pat Example"; d.getElementById("custContact").value = "pat@example.com"; d.getElementById("custPaymentMethod").value = "Check";
    sentMail.length = 0;
    d.getElementById("placeOrderBtn").click();
    await wait(() => !!d.querySelector(".confirmation"));
    const conf = d.querySelector(".confirmation");
    ok("Place order: the confirmation shows the server's Discount (SAVE10) −$4.00 and total $36.00", !!conf && /Discount \(SAVE10\)\s*−\$4\.00/.test(conf.textContent) && /Total\s*\$36\.00/.test(conf.textContent));
    const orderId = calls.find(c => c.body && c.body.discountCode).body.orderId;
    const order = await L.getOrderById(db, orderId);
    ok("…the order is booked with the discount and the code (discountNote \"Code SAVE10\")", order && Number(order.discountAmount) === 4 && order.discountNote === "Code SAVE10" && order.discountCode === "SAVE10");
    ok("…one use recorded", db.q("SELECT COUNT(*) AS n FROM discount_code_uses WHERE orderId = ? AND releasedAt IS NULL", orderId)[0].n === 1);
    const mail = sentMail.find(m => /Order received/.test(m.subject));
    ok("…and the order-received email has \"Discount (SAVE10): −$4.00\" (not \"Code SAVE10\")", !!mail && /\nDiscount \(SAVE10\): −\$4\.00\n/.test(mail.text) && !/Code SAVE10/.test(mail.text));
    freshCacheApi();
  }
})().catch((e) => { console.error(e); console.log("test crashed: false"); process.exit(1); });
