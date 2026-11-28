const fs = require("fs");
const { storefrontPage } = require("./testlib/storefront-page");
const { autoConfirm } = require("./testlib/confirm.js");
const { JSDOM, ResourceLoader, VirtualConsole } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");
const { MAIL_ENV, MAIL_OK, captureMail } = require("./testlib/mail-mock");
const { ok } = require("./testlib/check");
const roles = require("./testlib/roles");

// Quantity breaks and quotes (migrations/0109), the browser side — RUN in jsdom against the real handlers on sql.js:
//   public/storefront.js — the break table on a product card, the cart repriced per product across its lines ("was"
//     prices, the savings line, the next-break hint, the totals), and the customer's quote page (?estimate=): loading,
//     the quote as /api/estimate sends it, Accept with its confirmation, Ask for changes with a message, and every
//     state after (accepted with an order, accepted without one, changes sent, expired, cancelled, already accepted,
//     an unknown link), behind the real functions/api/estimate.js and functions/api/catalog.js;
//   public/admin.js — the product form's Quantity breaks section (rows added and removed, what Save sends as
//     qtyBreaks, the browser's own checks, the server's refusal shown, the deepest break's line in the costs panel),
//     the Local sale form's new limits (100 items, 5,000 a line) and its break prices, and "From quote Q-…" on an
//     order made from a quote.
// Invented data only. Nothing here depends on today's date: an expired quote ends in 2000, an open one in 2999.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");

const mail = [];
global.fetch = async (url, init) => {
  if (captureMail(url, init, mail)) return MAIL_OK;
  throw new Error("unexpected fetch " + url);
};

// One scope for the libraries; orders.js, estimate.js and catalog.js each in their own (they all declare onRequest…).
const M = new Function(
  strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  strip(read("functions/_lib/db.js")) + "\n" + strip(read("functions/_lib/email.js")) + "\n" + strip(read("functions/_lib/quoteToken.js")) + "\n" +
  strip(read("functions/_lib/boxSize.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'olive@example.test';\n" + roles.adminAs({ roleFrom: "globalThis.__role || 'admin'" }) + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: { acme: 'acme' }, orgs: {} });\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  "const ordersApi = (function(){\n" + strip(read("functions/api/orders.js")) + "\nreturn { onRequestPost, convertEstimateToOrder_ }; })();\n" +
  "const convertEstimateToOrder_ = ordersApi.convertEstimateToOrder_;\n" +
  "const estimateApi = (function(){\n" + strip(read("functions/api/estimate.js")) + "\nreturn { onRequestGet, onRequestPost }; })();\n" +
  "const catalogApi = (function(){ const getReadyToShipByOrg = async () => []; const getBlankReadyByOrg = async () => ({});\n" +
  "  const getCatalogData = async (env) => ({ ...(await getPublicCatalogData(env.DB)), subdomainMap: { acme: 'acme' } });\n" +
  "  const getCatalogShop = async (env, orgId) => (((await getCatalogData(env)) || {}).orgs || {})[orgId] || null;\n" +
  strip(read("functions/api/catalog.js")) + "\nreturn onRequestGet; })();\n" +
  "return { ordersApi: ordersApi.onRequestPost, estimateApi, catalogApi, createProduct, createBlank, setBlankLink, setPricingSettings, setFeatures, priceItem,\n" +
  "  createEstimate, saveEstimateItems, markEstimateSent, cancelEstimate, saveCustomer, getOrderById, setSalesTaxSettings };")();

const pause = (ms) => new Promise(r => setTimeout(r, ms));
const wait = async (cond, n = 500) => { for (let i = 0; i < n && !cond(); i++) await pause(10); return !!cond(); };
const reply = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const env = { DB: d1, SIGNING_SECRET: "test-signing-secret", ...MAIL_ENV };
  const ctx = (request) => ({ env, request, waitUntil: (p) => Promise.resolve(p).catch(() => {}) });
  const call = async (body) => {
    const res = await M.ordersApi(ctx({ url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } }));
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, accent, createdAt, updatedAt, ready) VALUES ('acme','acme','Example Club','#123456','t','t',1);`);
  await M.setPricingSettings(d1, { cardPctBps: 0, cardFixedCents: 0, suppliesCents: 0, targetIncomeCents: 500 });

  // The shop: a tee (sizes, $2 off from 12 pieces, $3.50 from 24), a cap with no breaks, a polo with choices
  // (configurable) and one break.
  const TEE_BREAKS = [{ minQty: 12, off: 2 }, { minQty: 24, off: 3.5 }];
  await M.createProduct(d1, "acme", { productId: "tee", type: "shirt", name: "Club Tee", pricingMode: "sized", sizePricing: { S: 20, M: 20, L: 22 }, personalizationPrice: 5,
    visible: true, noDesignNeeded: true, sortOrder: 1, qtyBreaks: TEE_BREAKS });
  await M.createProduct(d1, "acme", { productId: "cap", type: "cap", name: "Club Cap", pricingMode: "flat", flatPrice: 15, visible: true, noDesignNeeded: true, sortOrder: 2 });
  await M.createProduct(d1, "acme", { productId: "polo", type: "shirt", name: "Club Polo", pricingMode: "sized", sizePricing: { M: 30 }, visible: true, noDesignNeeded: true, sortOrder: 3,
    configurable: true, garmentColors: ["Navy", "Red"], qtyBreaks: [{ minQty: 6, off: 1 }] });

  // ============================================================================================================
  // The shop page: the break table, and the cart
  // ============================================================================================================
  const cat = JSON.parse(await (await M.catalogApi({ request: { url: "https://acme.example.com/api/catalog", headers: { get: () => null } }, env })).text());
  const cTee = cat.catalog.products.find(p => p.id === "tee"), cCap = cat.catalog.products.find(p => p.id === "cap");
  console.log("=== The catalog the shop page reads ===");
  ok("the catalog sends a product's breaks as qtyBreaks, in dollars, fewest pieces first", JSON.stringify(cTee.qtyBreaks) === JSON.stringify(TEE_BREAKS));
  ok("…and an empty list for a product without breaks", Array.isArray(cCap.qtyBreaks) && cCap.qtyBreaks.length === 0);

  const shop = async (url, { seed, estimateFetch } = {}) => {
    const calls = [];
    const vc = new VirtualConsole();
    vc.on("jsdomError", (e) => { if (!/Not implemented: navigation/.test(String(e && e.message))) console.error(e); });
    const dom = new JSDOM(storefrontPage({ adminCss: false }), { runScripts: "dangerously", url, pretendToBeVisual: true, virtualConsole: vc,
      beforeParse(win) {
        for (const [k, v] of Object.entries(seed || {})) win.sessionStorage.setItem(k, JSON.stringify(v));
        win.scrollTo = () => {}; win.alert = () => {};
        win.fetch = async (u, init) => {
          const s = String(u);
          calls.push({ url: s, method: (init && init.method) || "GET", body: init && init.body ? JSON.parse(init.body) : null });
          if (s.startsWith("/api/catalog")) return reply(200, cat);
          if (s.startsWith("/api/estimate")) {
            if (estimateFetch) { const x = await estimateFetch(s, init); if (x) return x; }
            const request = { url: "https://acme.example.com" + s, headers: { get: (h) => (/cf-connecting-ip/i.test(h) ? "203.0.113.9" : null) },
              json: async () => JSON.parse(init.body) };
            const res = init && init.method === "POST" ? await M.estimateApi.onRequestPost(ctx(request)) : await M.estimateApi.onRequestGet(ctx(request));
            return reply(res.status, JSON.parse(await res.text()));
          }
          return reply(200, {});
        };
      } });
    const w = dom.window;
    await pause(120);
    return { w, d: w.document, calls };
  };

  console.log("\n=== The break table on a product ===");
  let { w, d } = await shop("https://acme.example.com/");
  await wait(() => !!d.getElementById("price-tee"));
  const card = (pid) => d.getElementById("price-" + pid).closest(".product");
  const teeTable = card("tee").querySelector("table.qty-breaks");
  ok("a product with breaks shows a table captioned \"Quantity pricing\"", !!teeTable && teeTable.querySelector("caption").textContent.trim() === "Quantity pricing");
  ok("…one row a break: \"12+ pieces\" as the row's heading, \"$2.00 off each\" beside it",
    JSON.stringify([...teeTable.querySelectorAll("tbody tr")].map(r => [r.querySelector("th").textContent, r.querySelector("th").getAttribute("scope"), r.querySelector("td").textContent])) ===
    JSON.stringify([["12+ pieces", "row", "$2.00 off each"], ["24+ pieces", "row", "$3.50 off each"]]));
  ok("…and says the pieces count every size of it in the order", card("tee").querySelector(".qty-breaks-note").textContent === "Counts every size of this item in your order.");
  ok("a product with choices says every size, color and design counts", card("polo").querySelector(".qty-breaks-note").textContent === "Counts every size, color and design of this item in your order." &&
    card("polo").querySelector(".qty-breaks td").textContent === "$1.00 off each");
  ok("a product without breaks has no table and no note", !card("cap").querySelector(".qty-breaks") && !card("cap").querySelector(".qty-breaks-note"));
  ok("breaks that make no sense (fewer than 2 pieces, nothing off) aren't shown",
    w.qtyBreaksHtml_({ qtyBreaks: [{ minQty: 1, off: 2 }, { minQty: 5, off: 0 }] }) === "" && w.qtyBreaksHtml_({}) === "" && w.qtyBreaksHtml_({ qtyBreaks: "12:2" }) === "");

  console.log("\n=== The cart counts a product's pieces across its lines ===");
  const ev = (el, t) => el.dispatchEvent(new w.Event(t, { bubbles: true }));
  const addTee = (size, qty, pers) => {
    d.getElementById("size-tee").value = size; ev(d.getElementById("size-tee"), "change");
    d.getElementById("qty-tee").value = String(qty);
    const p = d.getElementById("pers-tee"); p.checked = !!pers; ev(p, "change");
    if (pers) { const n = d.getElementById("pers-name-tee"); n.value = pers; ev(n, "input"); }
    d.querySelector('[data-action="add"][data-pid="tee"]').click();
  };
  const addCap = (qty) => { d.getElementById("qty-cap").value = String(qty); d.querySelector('[data-action="add"][data-pid="cap"]').click(); };
  const cart = () => w.eval("cart");
  const lineEls = () => [...d.querySelectorAll("#ticketPanel .cart-line")];
  const panel = () => d.getElementById("ticketPanel").textContent.replace(/\s+/g, " ");
  addTee("S", 6);
  ok("6 tees: no break yet, each at its list price, no \"was\"", cart()[0].unitPrice === 20 && cart()[0].breakOff === 0 && cart()[0].lineTotal === 120 && !lineEls()[0].querySelector(".cart-was"));
  ok("…the line keeps its list price and the product's own price for the break to come off", cart()[0].listUnitPrice === 20 && cart()[0].basePrice === 20 && cart()[0].breakMin === 0);
  ok("…and under it: how many more reach the first break", lineEls()[0].querySelector(".qty-break-next").textContent === "Add 6 more Club Tee for $2.00 off each.");
  ok("no savings line while nothing is off", !d.querySelector(".cart-savings"));
  addCap(2);
  addTee("M", 6, "Pat");
  const [s6, cap2, m6] = cart();
  ok("6 S + 6 M tees (two lines) reach the 12-piece break: both lines are $2.00 less", s6.unitPrice === 18 && m6.unitPrice === 18 && s6.breakOff === 2 && m6.breakOff === 2 && s6.breakMin === 12);
  ok("…the line totals follow, personalization added at full price ($18 + $5) × 6", s6.lineTotal === 108 && m6.lineTotal === 138);
  ok("…the cap on its own line is another product: not counted, not discounted", cap2.unitPrice === 15 && cap2.breakOff === 0 && cap2.lineTotal === 30);
  ok("each tee line shows the price each and the \"was\" price (personalization included)",
    /× \$18\.00 each \(was \$20\.00\)/.test(lineEls()[0].textContent.replace(/\s+/g, " ")) && /× \$23\.00 each \(was \$25\.00\)/.test(lineEls()[2].textContent.replace(/\s+/g, " ")) &&
    lineEls()[0].querySelector(".cart-was del").textContent === "$20.00");
  ok("…and which break it is", lineEls()[0].querySelector(".qty-break-on").textContent === "Quantity price: 12+ pieces, $2.00 off each");
  ok("the next break is offered once, under the product's last line only", !lineEls()[0].querySelector(".qty-break-next") && !lineEls()[1].querySelector(".qty-break-next") &&
    lineEls()[2].querySelector(".qty-break-next").textContent === "Add 12 more Club Tee for $3.50 off each.");
  ok("a savings line adds up what the breaks took off: 12 × $2.00", d.querySelector(".cart-savings").textContent === "Quantity savings: $24.00 (already taken off the prices above)");
  ok("the cart bar's total is the lines after the break ($108 + $30 + $138)", /\$276\.00/.test(d.getElementById("cartBar").textContent));
  const srv = await M.priceItem(d1, "acme", "tee", "S", 6, false, null, { breakQty: 12 });
  ok("the page's price is the server's for the same pieces (priceItem with breakQty)", srv.unitPrice === 18 && srv.listUnitPrice === 20 && srv.breakOff === 2);

  d.querySelector('#ticketPanel .cart-line [data-action="qty"][data-d="-1"]').click();
  ok("one fewer tee (11 in all) and every tee line is back at its list price", cart()[0].qty === 5 && cart()[0].unitPrice === 20 && cart()[1].unitPrice === 15 && cart()[2].unitPrice === 20 &&
    cart()[2].lineTotal === 150 && !d.querySelector(".cart-savings") && lineEls()[2].querySelector(".qty-break-next").textContent === "Add 1 more Club Tee for $2.00 off each.");
  d.querySelector('#ticketPanel .cart-line [data-action="qty"][data-d="1"]').click();
  ok("one more and the break is back on both lines", cart()[0].unitPrice === 18 && cart()[2].unitPrice === 18);
  addTee("L", 12);
  const l12 = cart()[3];
  ok("24 tees in three lines reach the deepest break: $3.50 off each, sizes priced on their own (L $22 → $18.50)",
    cart()[0].unitPrice === 16.5 && cart()[2].unitPrice === 16.5 && l12.unitPrice === 18.5 && l12.lineTotal === 222 && l12.breakMin === 24);
  ok("…with no further break to offer", !d.querySelector(".qty-break-next"));
  ok("…and the savings are 24 × $3.50", d.querySelector(".cart-savings").textContent === "Quantity savings: $84.00 (already taken off the prices above)");
  const sub = cart().reduce((s, c) => s + Math.round(c.lineTotal * 100), 0) / 100;
  ok("the order's subtotal is the lines after the break", sub === 99 + 30 + 129 + 222 && /\$480\.00/.test(d.getElementById("cartBar").textContent));
  d.querySelectorAll("#ticketPanel .remove-x")[3].click();
  ok("removing a line reprices the others (12 tees left: the 12-piece break)", cart().length === 3 && cart()[0].unitPrice === 18 && cart()[2].unitPrice === 18);
  ok("the cart kept in the session carries the list price and the break", (() => { const s = JSON.parse(w.sessionStorage.getItem("cart:acme")); return s[0].listUnitPrice === 20 && s[0].breakOff === 2 && s[0].unitPrice === 18; })());

  d.getElementById("size-polo").value = "M"; ev(d.getElementById("size-polo"), "change");
  d.getElementById("qty-polo").value = "6";
  d.querySelector('[data-action="add"][data-pid="polo"]').click();
  const polo = cart().find(c => c.productId === "polo");
  ok("a product with choices reaches its own break (6 polos, $1.00 off), from its garment price", !!polo && polo.basePrice === 30 && polo.listUnitPrice === 30 && polo.unitPrice === 29 && polo.breakMin === 6 && polo.lineTotal === 174);
  ok("…and the tees beside it keep theirs", cart()[0].unitPrice === 18 && cart()[0].breakMin === 12);

  console.log("\n=== A kept cart is priced by today's breaks ===");
  // A cart saved before breaks existed: no listUnitPrice, no basePrice — its unitPrice is its list price.
  ({ w, d } = await shop("https://acme.example.com/", { seed: { "cart:acme": [
    { productId: "tee", name: "Club Tee", type: "shirt", size: "S", qty: 10, unitPrice: 20, personalized: false, persName: "", personalizationFee: 0, lineTotal: 200 },
    { productId: "tee", name: "Club Tee", type: "shirt", size: "M", qty: 4, unitPrice: 20, personalized: false, persName: "", personalizationFee: 0, lineTotal: 80 },
  ] } }));
  await wait(() => !!d.querySelector("#ticketPanel .cart-line"));
  ok("an old line's unitPrice is taken as its list price, and the break comes off it (14 pieces)",
    cart()[0].listUnitPrice === 20 && cart()[0].unitPrice === 18 && cart()[0].lineTotal === 180 && cart()[1].lineTotal === 72);
  ok("…and the page shows it", /\$252\.00/.test(d.getElementById("cartBar").textContent) && !!d.querySelector(".cart-savings"));
  // The break never takes more than the product's own price, and never below zero.
  w.eval(`cart = [{ productId: "tee", name: "Club Tee", size: "S", qty: 30, unitPrice: 9, listUnitPrice: 9, basePrice: 1, personalizationFee: 0, lineTotal: 0 }]; cartReprice_();`);
  ok("a break bigger than the product's own price takes off only that price", cart()[0].breakOff === 1 && cart()[0].unitPrice === 8 && cart()[0].lineTotal === 240);
  w.eval(`cart = [{ productId: "nope", name: "Gone", size: "S", qty: 30, unitPrice: 9, personalizationFee: 0, lineTotal: 0 }]; cartReprice_();`);
  ok("a line whose product isn't in the catalog keeps its price", cart()[0].unitPrice === 9 && cart()[0].breakOff === 0 && cart()[0].lineTotal === 270);

  // ============================================================================================================
  // The quote page (?estimate=)
  // ============================================================================================================
  const custId = (await call({ action: "saveCustomer", name: "Pat Example", company: "Example Club", email: "pat@example.com", phone: "555-0100", address: null, notes: "" })).body.id;
  const quietId = (await call({ action: "saveCustomer", name: "Sam Example", company: "", email: "", phone: "555-0101", address: null, notes: "" })).body.id;
  const QUOTE_ITEMS = [
    { kind: "product", productId: "tee", name: "Club Tee", type: "shirt", size: "M", qty: 12, unitPrice: 18, listUnitPrice: 20, personalized: false },
    { kind: "product", productId: "cap", name: "Club Cap", type: "cap", size: "OSFA", qty: 2, unitPrice: 15, listUnitPrice: 15, personalized: true, persName: "Pat", personalizationFee: 3 },
    { kind: "custom", name: "Banner <b>stitch</b>", qty: 1, unitPrice: 40, taxable: true },
    { kind: "fee", feeKind: "setup", name: "Logo", amount: 25, taxable: false },
    { kind: "fee", feeKind: "digitizing", name: "", amount: 30, taxable: true },
  ];
  const makeQuote = async ({ customerId = custId, title = "Team order", message = "Thanks for asking!", expiresOn = "2999-12-31", items = QUOTE_ITEMS, send = true, tax } = {}) => {
    const q = await M.createEstimate(d1, { orgId: "acme", customerId, title, message, internalNote: "Staff only: margin is thin", expiresOn, createdBy: "olive@example.test" });
    if (q.error) throw new Error(q.error);
    const s = await M.saveEstimateItems(d1, q.id, items);
    if (s.error) throw new Error(s.error);
    let token = null;
    if (send) { const r = await M.markEstimateSent(d1, q.id, Object.assign({ sentTo: "pat@example.com" }, tax || { taxMode: "inclusive", taxRateBps: 0 })); if (r.error) throw new Error(r.error); token = r.token; }
    return { id: q.id, number: q.number, token };
  };
  const estPage = async (token, opts) => { const s = await shop("https://acme.example.com/?estimate=" + encodeURIComponent(token), opts); await wait(() => !/Loading your quote/.test(s.d.getElementById("app").textContent)); await pause(20); return s; };
  const text = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");
  const id = (x) => d.getElementById(x);

  console.log("\n=== Opening a quote ===");
  const q1 = await makeQuote({ tax: { taxMode: "exclusive", taxRateBps: 600 } });
  await M.setSalesTaxSettings(d1, { rateBps: 600, jurisdiction: "Example County" });
  // The first paint, before /api/estimate answers.
  let release; const gate = new Promise(r => { release = r; });
  ({ w, d } = await shop("https://acme.example.com/?estimate=" + q1.token, { estimateFetch: async () => { await gate; return null; } }));
  ok("while it loads the page says so, as a status", text(d.querySelector("#app .inv[role=status]")) === "Loading your quote…" && d.title === "Quote");
  release(); await wait(() => !/Loading/.test(id("app").textContent)); await pause(20);
  const calls = [];
  ({ w, d } = await estPage(q1.token));
  const app = () => id("app");
  ok("the page is titled with the quote's number", d.title === "Quote — " + q1.number);
  ok("the shop's name heads it, then the quote number and who it's for", app().querySelector("h1").textContent === "Example Club" &&
    new RegExp("^Quote " + q1.number + " · Pat Example · [A-Z][a-z]+ \\d{1,2}, \\d{4}$").test(text(app().querySelector(".inv-sub"))));
  ok("…in the shop's own colour", app().querySelector(".inv").getAttribute("style").includes("--inv-accent:#123456"));
  ok("the title and the note to the customer are shown; the internal note is not",
    text(app().querySelector("h2")) === "Team order" && text(app().querySelector(".inv-note")) === "Thanks for asking!" && !/Staff only/.test(app().textContent));
  const rows = [...app().querySelectorAll("table.inv-items")[0].querySelectorAll("tbody tr")].map(r => [...r.children].map(text));
  ok("each line: name · size, qty, price each, amount", JSON.stringify(rows[0]) === JSON.stringify(["Club Tee · M", "12", "$18.00was $20.00", "$216.00"]));
  ok("…a line with a break shows the list price struck through", app().querySelector("table.inv-items tbody tr td.num del").textContent === "$20.00");
  ok("…one without a break, no \"was\"; its personalization under the name, as on a receipt", JSON.stringify(rows[1]) === JSON.stringify(["Club Cap“Pat”", "2", "$15.00", "$36.00"]) &&
    text(app().querySelectorAll("table.inv-items tbody tr")[1].querySelector(".inv-detail")) === "“Pat”");
  ok("…a custom line, its name escaped", rows[2][0] === "Banner <b>stitch</b>" && !app().querySelector("table.inv-items b") && rows[2][3] === "$40.00");
  const feeRows = [...app().querySelectorAll("table.inv-items")[1].querySelectorAll("tbody tr")].map(r => [...r.children].map(text));
  ok("one-time charges are a table of their own, named by kind", text(app().querySelectorAll("table.inv-items")[1].querySelector("th")) === "One-time charges" &&
    JSON.stringify(feeRows) === JSON.stringify([["Setup fee — Logo", "$25.00"], ["Digitizing fee", "$30.00"]]));
  const totals = [...app().querySelectorAll("table.inv-totals tr")].map(r => [...r.children].map(text));
  ok("tax added on top is its own line, with the rate and the place: subtotal, tax, total",
    JSON.stringify(totals) === JSON.stringify([["Subtotal", "$347.00"], ["Sales tax (6% Example County)", "$19.32"], ["Total", "$366.32"]]) && !app().querySelector(".inv-tax"));
  ok("\"Your answer\" offers Accept and Ask for changes, with the last day it can be accepted",
    !!id("estAccept") && !!id("estAskOpen") && id("estAccept").textContent === "Accept quote" && id("estAskOpen").textContent === "Ask for changes" &&
    /You can accept this quote until December 31, 2999\./.test(app().textContent) && !/Valid until/.test(app().textContent));
  ok("…and nothing about where it stands yet", !app().querySelector(".inv-banner"));
  ok("opening the link marks the quote viewed", !!d1.q("SELECT viewedAt FROM estimates WHERE id=?", q1.id)[0].viewedAt);

  console.log("\n=== Accept, with a confirmation ===");
  id("estAccept").click();
  ok("Accept asks first, in the page: the total and what happens", !!id("estConfirm") && id("estConfirm").getAttribute("role") === "group" && id("estConfirm").getAttribute("aria-labelledby") === "estConfirmText" &&
    text(id("estConfirmText")) === "Accept this quote and place the order for $366.32? We'll start on it and email you the invoice.");
  ok("…with the focus on \"Yes, accept and order\", and \"Not yet\" beside it; Ask for changes steps aside",
    d.activeElement === id("estAcceptYes") && id("estAcceptYes").textContent === "Yes, accept and order" && id("estAcceptNo").textContent === "Not yet" && !id("estAskOpen") && !id("estAccept"));
  ok("…nothing has been sent", !d1.q("SELECT acceptedAt FROM estimates WHERE id=?", q1.id)[0].acceptedAt);
  id("estAcceptNo").click();
  ok("\"Not yet\" goes back, the focus on Accept again", !id("estConfirm") && d.activeElement === id("estAccept") && !!id("estAskOpen"));
  id("estAccept").click();
  let esc = new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }); id("estAcceptYes").dispatchEvent(esc);
  ok("Escape steps back out of the confirmation too", esc.defaultPrevented && !id("estConfirm") && d.activeElement === id("estAccept"));
  id("estAccept").click();
  const other = new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }); id("estAcceptYes").dispatchEvent(other);
  ok("…while any other key leaves it open", !other.defaultPrevented && !!id("estConfirm"));
  mail.length = 0;
  id("estAcceptYes").click();
  ok("while it's placing the order, both buttons are off and the button says so", id("estAcceptYes").disabled && id("estAcceptNo").disabled && id("estAcceptYes").textContent === "Placing your order…");
  await wait(() => !id("estConfirm"));
  const orderId1 = d1.q("SELECT orderId FROM estimates WHERE id=?", q1.id)[0].orderId;
  ok("the quote is accepted and the order made (ACME-" + q1.number.replace(/\W/g, "") + ")", orderId1 === "ACME-" + q1.number.replace(/\W/g, "") && d1.q("SELECT status FROM estimates WHERE id=?", q1.id)[0].status === "converted");
  ok("after: \"your order <id> is placed\", the invoice on its way, as a status with the focus on it",
    text(id("estState")) === `Thank you — your order ${orderId1} is placed. Your invoice is on its way by email.` && id("estState").getAttribute("role") === "status" && d.activeElement === id("estState"));
  ok("…the invoice really went to the customer", mail.some(m => m.to === "pat@example.com" || (Array.isArray(m.to) && m.to.includes("pat@example.com"))));
  ok("…no buttons are left, and a screen reader hears it", !id("estAccept") && !id("estAskOpen") && !/Your answer/.test(app().textContent) && /Your order is placed\./.test(id("statusRegion").textContent));
  ok("…the quote itself is still there below", !!app().querySelector("table.inv-items") && /\$366\.32/.test(app().textContent));

  console.log("\n=== Opening it again: already accepted ===");
  ({ w, d } = await estPage(q1.token));
  ok("the link says it has been accepted, naming the order and the day", new RegExp(`^This quote has been accepted — it's order ${orderId1}\\. \\([A-Z][a-z]+ \\d{1,2}, \\d{4}\\)$`).test(text(app().querySelector(".inv-banner"))) &&
    app().querySelector(".inv-banner").classList.contains("inv-ok"));
  ok("…and offers nothing to do, not even its expiry", !id("estAccept") && !id("estAskOpen") && !/Valid until|You can accept/.test(app().textContent));

  console.log("\n=== Ask for changes, with a message ===");
  const q2 = await makeQuote({ title: "", message: "", tax: { taxMode: "inclusive", taxRateBps: 600 } });
  ({ w, d } = await estPage(q2.token));
  ok("with no title or note, neither is drawn", !app().querySelector(".inv-note") && JSON.stringify([...app().querySelectorAll("h2")].map(text)) === '["Your answer"]');
  ok("tax in the prices is noted under the total, not added", !/Sales tax \(/.test(text(app().querySelector("table.inv-totals"))) &&
    /^Includes sales tax \(6% Example County\) \$\d+\.\d\d$/.test(text(app().querySelector(".inv-tax"))));
  id("estAskOpen").click();
  ok("Ask for changes opens a message box with a label, the focus in it; Accept steps aside",
    !!id("estNote") && d.querySelector('label[for="estNote"]').textContent === "What would you like changed?" && d.activeElement === id("estNote") &&
    id("estNote").getAttribute("maxlength") === "2000" && !id("estAccept") && id("estAskSend").textContent === "Send my request" && id("estAskCancel").textContent === "Cancel");
  id("estAskSend").click();
  ok("sending it empty asks for the message, and sends nothing", text(id("estErr")) === "Tell us what you'd like changed." && id("estErr").getAttribute("role") === "alert" && d.activeElement === id("estNote") &&
    d1.q("SELECT status FROM estimates WHERE id=?", q2.id)[0].status === "sent");
  const typeNote = (v) => { id("estNote").value = v; ev(id("estNote"), "input"); };
  typeNote("x".repeat(2001));
  id("estAskSend").click();
  ok("a message over 2,000 characters is refused in the page", text(id("estErr")) === "Please keep your message under 2,000 characters." && d1.q("SELECT status FROM estimates WHERE id=?", q2.id)[0].status === "sent");
  typeNote("Could the caps be navy?");
  id("estAskCancel").click();
  ok("Cancel closes the box, the focus back on Ask for changes", !id("estNote") && d.activeElement === id("estAskOpen") && !!id("estAccept") && text(id("estErr")) === "");
  id("estAskOpen").click();
  ok("…and opening it again keeps what was typed", id("estNote").value === "Could the caps be navy?");
  esc = new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }); id("estNote").dispatchEvent(esc);
  ok("Escape closes it as well, keeping the words", esc.defaultPrevented && !id("estNote") && d.activeElement === id("estAskOpen"));
  id("estAskOpen").click();
  typeNote("  Could the caps be navy?  ");
  id("estAskSend").click();
  ok("while sending, the button says \"Sending…\"", id("estAskSend").textContent === "Sending…" && id("estAskSend").disabled);
  await wait(() => !id("estAsk"));
  const r2 = d1.q("SELECT status, customerNote FROM estimates WHERE id=?", q2.id)[0];
  ok("the request is recorded, trimmed", r2.status === "changes" && r2.customerNote === "Could the caps be navy?");
  ok("after: thanks, naming the shop, as a status with the focus on it", text(id("estState")) === "Thanks — we've sent your message to Example Club. We'll get back to you with a revised quote." &&
    d.activeElement === id("estState") && /Your message was sent\./.test(id("statusRegion").textContent));
  ok("…no buttons, and the last day still said", !id("estAccept") && !id("estAskOpen") && /Valid until December 31, 2999\./.test(app().textContent));

  ({ w, d } = await estPage(q2.token));
  ok("opened again: \"You asked for changes on …\" with their own message", new RegExp("^You asked for changes on [A-Z][a-z]+ \\d{1,2}, \\d{4}\\. We'll send you a revised quote\\. ?Your message: Could the caps be navy\\?$").test(text(app().querySelector(".inv-banner"))) &&
    app().querySelector(".inv-banner").classList.contains("inv-wait"));
  ok("…and it can't be accepted while it waits on those changes", !id("estAccept") && !id("estAskOpen") && /Valid until December 31, 2999\./.test(app().textContent));

  console.log("\n=== Accepted, but the order couldn't be made ===");
  const q3 = await makeQuote({ customerId: quietId });
  const q3Order = "ACME-" + q3.number.replace(/\W/g, "");
  d1._raw.exec(`CREATE TRIGGER test_refuse_order BEFORE INSERT ON orders WHEN NEW.orderId = '${q3Order}' BEGIN SELECT RAISE(ABORT, 'the database is busy'); END;`);
  ({ w, d } = await estPage(q3.token));
  const origError = console.error; console.error = () => {};
  id("estAccept").click(); id("estAcceptYes").click();
  await wait(() => !!id("estState"));
  console.error = origError;
  ok("the acceptance stands without an order: the page says only that, no order number", text(id("estState")) === "Thank you — you've accepted this quote. We'll be in touch about your order and payment." &&
    d1.q("SELECT status FROM estimates WHERE id=?", q3.id)[0].status === "accepted" && !d1.q("SELECT 1 FROM orders WHERE orderId=?", q3Order).length);
  ({ w, d } = await estPage(q3.token));
  ok("opened again: accepted, with no order to name", /^This quote has been accepted\. \([A-Z][a-z]+ \d{1,2}, \d{4}\)$/.test(text(app().querySelector(".inv-banner"))) && !id("estAccept"));
  d1._raw.exec("DROP TRIGGER test_refuse_order;");

  console.log("\n=== Accepted, with no email to send the invoice to ===");
  const q4 = await makeQuote({ customerId: quietId });
  ({ w, d } = await estPage(q4.token));
  id("estAccept").click(); id("estAcceptYes").click();
  await wait(() => !!id("estState"));
  ok("the order is placed, and the page doesn't promise an invoice by email", new RegExp(`^Thank you — your order ACME-${q4.number.replace(/\W/g, "")} is placed\\. We'll be in touch about payment\\.$`).test(text(id("estState"))));

  console.log("\n=== Expired, cancelled, unknown ===");
  const q5 = await makeQuote();
  d1._raw.exec(`UPDATE estimates SET expiresOn='2000-01-15' WHERE id=${q5.id}`);
  ({ w, d } = await estPage(q5.token));
  ok("an expired quote says when it ended and that it can't be accepted", text(app().querySelector(".inv-banner")) === "This quote expired on January 15, 2000, so it can't be accepted. Please contact us for an updated quote." &&
    !id("estAccept") && !id("estAskOpen") && !/Valid until/.test(app().textContent));
  const q6 = await makeQuote();
  await M.cancelEstimate(d1, q6.id);
  ({ w, d } = await estPage(q6.token));
  ok("a cancelled one says it was withdrawn", text(app().querySelector(".inv-banner")) === "This quote has been withdrawn, so it can't be accepted. Please contact us if you'd still like to order." && !id("estAccept"));
  ({ w, d } = await estPage("0123456789abcdef0123456789abcdef"));
  ok("a link to no quote: \"This quote link isn't valid.\" as an alert, and nothing else", text(app()) === "This quote link isn't valid." && app().querySelector(".inv-err").getAttribute("role") === "alert");
  const draft = await makeQuote({ send: false });
  d1._raw.exec(`UPDATE estimates SET token='feedfacefeedfacefeedfacefeedface' WHERE id=${draft.id}`);
  ({ w, d } = await estPage("feedfacefeedfacefeedfacefeedface"));
  ok("…and a quote that was never sent can't be opened", text(app()) === "This quote link isn't valid.");
  ({ w, d } = await estPage("not a token"));
  ok("…nor can a link that isn't one", text(app()) === "This quote link isn't valid.");
  await M.setFeatures(d1, { quotes: false });
  ({ w, d } = await estPage(q2.token));
  ok("with Quotes switched off the link says quotes aren't available", text(app()) === "Quotes aren't available.");
  await M.setFeatures(d1, { quotes: true });
  ({ w, d } = await estPage(q2.token, { estimateFetch: async () => { throw new Error("offline"); } }));
  ok("no connection: the page says it couldn't load the quote", text(app()) === "We couldn't load your quote. Check your connection and try the link again." && app().querySelector(".inv-err").getAttribute("role") === "alert");
  ({ w, d } = await estPage(q2.token, { estimateFetch: async () => reply(500, { status: "error" }) }));
  ok("an answer with no message: the link isn't valid", text(app()) === "This quote link isn't valid.");

  console.log("\n=== The server says no, or doesn't answer ===");
  const q7 = await makeQuote();
  ({ w, d } = await estPage(q7.token));
  d1._raw.exec(`UPDATE estimates SET expiresOn='2000-01-15' WHERE id=${q7.id}`);   // expired while the page was open
  id("estAccept").click(); id("estAcceptYes").click();
  await wait(() => !id("estConfirm"));
  ok("an accept refused meanwhile shows the server's reason, in the customer's words, as an alert",
    text(id("estErr")) === "This quote expired on Saturday, January 15, 2000 — contact us for a new one." && id("estErr").getAttribute("role") === "alert");
  ok("…the confirmation closes, and the order isn't made", !id("estConfirm") && d1.q("SELECT status FROM estimates WHERE id=?", q7.id)[0].status === "sent");
  ok("…and the page is drawn again from the quote the server sent back: expired, with no Accept quote or Ask for changes",
    !id("estAccept") && !id("estAskOpen") && !id("estAcceptYes") && /^This quote expired on January 15, 2000, so it can't be accepted\./.test(text(app().querySelector(".inv-banner"))));
  d1._raw.exec(`UPDATE estimates SET expiresOn='2999-12-31' WHERE id=${q7.id}`);
  let postMode = "drop";
  ({ w, d } = await estPage(q7.token, { estimateFetch: async (u, init) => {
    if (!(init && init.method === "POST")) return null;
    if (postMode === "drop") throw new Error("offline");
    if (postMode === "refuse") return reply(409, { status: "error", message: "This quote was cancelled — contact us if you'd still like to go ahead." });
    if (postMode === "bare") return reply(409, { status: "error" });
    if (postMode === "refuseWith") return reply(409, { status: "error", message: "This quote was cancelled — contact us if you'd still like to go ahead.",
      estimate: Object.assign({}, w.eval("_est.data"), { status: "cancelled", canAccept: false, canAskChanges: false }) });
    if (postMode === "okBare") return reply(200, { status: "ok", action: "accept", orderId: "ACME-TEST1", invoiceSent: false, estimate: null });
    return null;
  } }));
  id("estAccept").click(); id("estAcceptYes").click();
  await wait(() => !!text(id("estErr")));
  ok("an accept with no answer says to reload before trying again (it may have gone through)",
    text(id("estErr")) === "We couldn't confirm that reached us. Reload this page to see whether your order was placed before trying again.");
  ok("…the confirmation stays, its buttons working again", !!id("estConfirm") && !id("estAcceptYes").disabled && id("estAcceptYes").textContent === "Yes, accept and order" && !id("estAcceptNo").disabled);
  id("estAcceptNo").click();
  id("estAskOpen").click(); typeNote("Navy please"); id("estAskSend").click();
  await wait(() => text(id("estErr")) === "We couldn't reach the server — try again.");
  ok("a changes request with no answer says to try again, keeping the box and the words", text(id("estErr")) === "We couldn't reach the server — try again." && !!id("estNote") && id("estNote").value === "Navy please");
  postMode = "refuse"; id("estAskSend").click();
  await wait(() => /cancelled/.test(text(id("estErr"))));
  ok("a refusal without the quote keeps the page as it was and shows the reason", text(id("estErr")) === "This quote was cancelled — contact us if you'd still like to go ahead." && !app().querySelector(".inv-banner"));
  postMode = "bare"; id("estAskSend").click();
  await wait(() => text(id("estErr")) === "We couldn't do that — try again.");
  ok("a refusal with no words of its own: \"We couldn't do that — try again.\"", text(id("estErr")) === "We couldn't do that — try again.");
  postMode = "refuseWith"; id("estAskSend").click();
  await wait(() => !!app().querySelector(".inv-banner"));
  ok("a refusal that carries the quote redraws it as it is now: withdrawn, nothing left to press", /^This quote has been withdrawn/.test(text(app().querySelector(".inv-banner"))) && !id("estAccept") && !id("estNote"));
  w.estApply_(Object.assign({}, w.eval("_est.data"), { status: "sent", canAccept: true }));
  id("estAskCancel").click();
  postMode = "okBare"; id("estAccept").click(); id("estAcceptYes").click();
  await wait(() => !!id("estState"));
  ok("an ok answer without the quote: the page marks it accepted itself and names the order it was given",
    text(id("estState")) === "Thank you — your order ACME-TEST1 is placed. We'll be in touch about payment." && w.eval("_est.data.status") === "converted");

  console.log("\n=== Older or partial answers ===");
  const can = (v) => w.estCanRespond_(v);
  ok("the server's canAccept decides; without it, sent or changes and not expired can be answered",
    can({ canAccept: false, status: "sent" }) === false && can({ canAccept: true, status: "cancelled" }) === true && can({ status: "sent" }) === true && can({ status: "changes" }) === true &&
    can({ status: "sent", expired: true }) === false && can({ status: "accepted" }) === false && can({ status: "cancelled" }) === false);
  w.eval(`_est.done = ""; _est.confirming = false; _est.asking = false;`);
  w.estApply_({ orgName: "Example Club", status: "sent", orgAccent: "red; color: x", items: [{ kind: "product", name: "Club Tee", size: "OSFA", qty: 0, unitPrice: 18, wasUnitPrice: 20, lineTotal: 18 },
    { kind: "product", name: "Club Cap", qty: 1, unitPrice: 15, listUnitPrice: 15, lineTotal: 15, personalized: true, persName: "Pat <3" }, { kind: "fee", feeKind: "art", name: "", lineTotal: 10 }, { kind: "fee", feeKind: "other", name: "", amount: 5 }],
    subtotal: 48, salesTax: 2, taxMode: "inclusive", total: 48 });
  const lr = [...app().querySelectorAll("table.inv-items")[0].querySelectorAll("tbody tr")].map(r => [...r.children].map(text));
  ok("an answer with `items`, wasUnitPrice and persName still draws: OSFA left out, a missing qty as 1, the name to stitch escaped", JSON.stringify(lr[0]) === JSON.stringify(["Club Tee", "1", "$18.00was $20.00", "$18.00"]) &&
    JSON.stringify(lr[1]) === JSON.stringify(["Club CapPersonalization: “Pat <3”", "1", "$15.00", "$15.00"]));
  ok("…a fee with no name reads by its kind (\"Art fee\"), an other one as \"Fee\"",
    JSON.stringify([...app().querySelectorAll("table.inv-items")[1].querySelectorAll("tbody tr")].map(r => text(r.children[0]))) === JSON.stringify(["Art fee", "Fee"]));
  ok("…a colour that isn't one falls back to the default, the tax as salesTax, no rate", app().querySelector(".inv").getAttribute("style").includes("--inv-accent:#1d4ed8") &&
    text(app().querySelector(".inv-tax")) === "Includes sales tax $2.00" && d.title === "Quote" && text(app().querySelector(".inv-sub")) === "Quote");
  w.estApply_({ orgName: "Example Club", status: "sent", canAccept: true, lines: [], fees: [{ feeKind: "setup", name: "Setup fee", amount: 20 }], subtotal: 20, tax: 0, total: 20 });
  ok("a quote of only fees has no line table, and a fee already named by its kind keeps its name", app().querySelectorAll("table.inv-items").length === 1 &&
    text(app().querySelector("table.inv-items tbody td")) === "Setup fee" && !/You can accept this quote until/.test(app().textContent));

  // ============================================================================================================
  // The admin: the product form, the Local sale form, "From quote"
  // ============================================================================================================
  const adminJs = read("public/admin.js");
  const sent = [];
  let inflight = 0, scripted = [];
  class Loader extends ResourceLoader { fetch(url, o) { if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return Promise.resolve(Buffer.from("")); } }
  const avc = new VirtualConsole(); avc.sendTo(console, { omitJSDOMErrors: true });
  const adom = new JSDOM(storefrontPage(), { runScripts: "dangerously", resources: new Loader(), virtualConsole: avc, url: "https://admin.example.com/#home", pretendToBeVisual: true,
    beforeParse(win) {
      autoConfirm(win, () => true);
      win.CSS = win.CSS || { escape: (s) => String(s).replace(/["\\]/g, "\\$&") };
      win.scrollTo = () => {};
      win.fetch = async (url, init) => {
        const u = String(url), b = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
        if (!u.includes("/api/orders")) return reply(404, { status: "error", message: "not here" });
        sent.push(b); inflight++;
        try {
          if (scripted.length && scripted[0].action === b.action) { const s = scripted.shift(); return reply(s.status || 200, s.body); }
          const x = await call(b); return reply(x.status, x.body);
        } finally { inflight--; }
      };
    } });
  w = adom.window; d = adom.window.document;
  await pause(150);
  await w.loadAdminScript();
  const toasts = [];
  w.showToast = (m, isErr) => toasts.push({ m: String(m), err: !!isErr });
  w.eval('adminKey = "cookie"; adminOrgs = [{ orgId: "acme", name: "Example Club" }]; window._adminOrgRegistry = [{ orgId: "acme", name: "Example Club" }];');
  w.eval(roles.asRole("admin"));
  const idle = async () => { for (let calm = 0, i = 0; calm < 3 && i < 500; i++) { await pause(10); calm = inflight === 0 ? calm + 1 : 0; } };
  const productOf = async (pid) => (await call({ action: "listProducts", org: "acme" })).body.products.find(p => p.productId === pid);

  console.log("\n=== The product form's Quantity breaks ===");
  let tee = await productOf("tee");
  ok("(listProducts gives the form the breaks in dollars)", JSON.stringify(tee.qtyBreaks) === JSON.stringify(TEE_BREAKS));
  w.renderProductForm(d.getElementById("app"), "acme", tee);
  const qRows = () => [...d.querySelectorAll("#qtyBreakRows .qty-break-row")];
  const typed = () => qRows().map(r => [r.querySelector(".qtyBreakMin").value, r.querySelector(".qtyBreakOff").value]);
  ok("the section is there, headed \"Quantity breaks\", with what a break does", !!id("qtyBreaksSection") && /^Quantity breaks/.test(text(id("qtyBreaksSection"))) &&
    /every piece costs that much less/.test(text(id("qtyBreaksSection"))) && /Up to 6\./.test(text(id("qtyBreaksSection"))));
  ok("…one row a saved break, filled in", JSON.stringify(typed()) === JSON.stringify([["12", "2"], ["24", "3.5"]]));
  ok("…each row's boxes and Remove labelled by its number", qRows()[1].querySelector(".qtyBreakMin").getAttribute("aria-label") === "Break 2: from how many pieces" &&
    qRows()[1].querySelector(".qtyBreakOff").getAttribute("aria-label") === "Break 2: dollars off each piece" && qRows()[1].querySelector(".qtyBreakRm").getAttribute("aria-label") === "Remove break 2" &&
    qRows()[0].querySelector(".qtyBreakMin").min === "2" && qRows()[0].querySelector(".qtyBreakMin").max === "100000");
  w._prodFormDirty = false;
  id("qtyBreakAdd").click();
  ok("+ Add a break adds an empty row, the focus in its first box, and counts as a change",
    qRows().length === 3 && JSON.stringify(typed()[2]) === '["",""]' && d.activeElement === qRows()[2].querySelector(".qtyBreakMin") && w._prodFormDirty === true);
  qRows()[0].querySelector(".qtyBreakOff").value = "2.25";
  id("qtyBreakAdd").click();
  ok("…keeping what was typed in the others", typed()[0][1] === "2.25" && qRows().length === 4);
  id("qtyBreakAdd").click(); id("qtyBreakAdd").click();
  ok("at six rows the add button goes away", qRows().length === 6 && id("qtyBreakAdd").style.display === "none");
  id("qtyBreakAdd").click();
  ok("…and can't add a seventh", qRows().length === 6);
  w._prodFormDirty = false;
  qRows()[5].querySelector(".qtyBreakRm").click();
  ok("Remove takes that row out, brings the add button back, and counts as a change", qRows().length === 5 && id("qtyBreakAdd").style.display === "" && w._prodFormDirty === true);
  ok("…the focus moves to the row now in its place (the last one)", d.activeElement === qRows()[4].querySelector(".qtyBreakMin"));
  qRows()[1].querySelector(".qtyBreakRm").click();
  ok("removing one in the middle renumbers the rest, the focus on the next", qRows().length === 4 && JSON.stringify(typed()[1]) === '["",""]' &&
    qRows()[1].querySelector(".qtyBreakRm").getAttribute("aria-label") === "Remove break 2" && d.activeElement === qRows()[1].querySelector(".qtyBreakMin"));
  while (qRows().length) qRows()[0].querySelector(".qtyBreakRm").click();
  ok("with no rows it says there are none, the focus on the add button", /No quantity breaks: every piece is the same price however many are ordered\./.test(text(id("qtyBreakRows"))) && d.activeElement === id("qtyBreakAdd"));

  // Save: what is sent, and the browser's checks.
  const setRows = (list) => {
    while (qRows().length) qRows()[0].querySelector(".qtyBreakRm").click();
    for (const [mn, off] of list) { id("qtyBreakAdd").click(); const r = qRows()[qRows().length - 1]; r.querySelector(".qtyBreakMin").value = mn; r.querySelector(".qtyBreakOff").value = off; }
  };
  const errText = () => (id("prodFormError") || { textContent: "" }).textContent;
  // Save changes; a save that went through leaves the form for the Products list, so the form is drawn again after.
  const save = async () => { sent.length = 0; await idle(); sent.length = 0; w.submitProductForm("acme", true); await wait(() => !!errText() || sent.some(b => b.action === "updateProduct")); await idle(); };
  const reopen = async () => { w.renderProductForm(d.getElementById("app"), "acme", await productOf("tee")); await idle(); };
  const saves = () => sent.filter(b => b.action === "updateProduct");
  const refuse = async (rows, msg, focusOf) => {
    setRows(rows); await save();
    return errText() === msg && saves().length === 0 && (!focusOf || d.activeElement === focusOf());
  };
  ok("a break from 1 piece is refused, the focus on its box", await refuse([["1", "2"]], "A quantity break starts at a whole number of pieces from 2 to 100000.", () => qRows()[0].querySelector(".qtyBreakMin")));
  ok("…and so is 2.5 pieces, or more than 100000", await refuse([["2.5", "2"]], "A quantity break starts at a whole number of pieces from 2 to 100000.") &&
    await refuse([["100001", "2"]], "A quantity break starts at a whole number of pieces from 2 to 100000."));
  ok("a break with nothing off is refused, the focus on the amount", await refuse([["12", ""]], "Enter the dollars off each piece for the break from 12 pieces (more than $0, in cents at most).", () => qRows()[0].querySelector(".qtyBreakOff")));
  ok("…and so is $0, or a fraction of a cent", await refuse([["12", "0"]], "Enter the dollars off each piece for the break from 12 pieces (more than $0, in cents at most).") &&
    await refuse([["12", "1.005"]], "Enter the dollars off each piece for the break from 12 pieces (more than $0, in cents at most)."));
  ok("a break that takes off the lowest price or more is refused, naming it", await refuse([["12", "20"]], "The break from 12 pieces takes off $20.00 — it must be less than the product's lowest price ($20.00).", () => qRows()[0].querySelector(".qtyBreakOff")));
  ok("two breaks at the same number of pieces are refused", await refuse([["12", "1"], ["12", "2"]], "Two quantity breaks start at 12 pieces — give each its own number.", () => qRows()[1].querySelector(".qtyBreakMin")));
  ok("a bigger break that takes no more off is refused", await refuse([["24", "1"], ["12", "2"]], "A bigger break must take more off: from 24 pieces should be more than $2.00 off.", () => qRows()[0].querySelector(".qtyBreakOff")));
  setRows([["2", "0.1"], ["3", "0.2"], ["4", "0.3"], ["5", "0.4"], ["6", "0.5"], ["7", "0.6"]]);
  id("qtyBreakRows").insertAdjacentHTML("beforeend", w.qtyBreakRowHtml_({ minQty: 8, off: 0.7 }, 6));
  ok("more than six (a seventh row that got in) is refused, the focus on the seventh",
    (await save(), errText() === "A product can have at most 6 quantity breaks." && saves().length === 0 && d.activeElement === qRows()[6].querySelector(".qtyBreakMin")));
  setRows([["24", "3.5"], ["", ""], ["12", "2"]]);
  await save();
  ok("Save sends qtyBreaks sorted by pieces, a row left empty on both sides dropped", errText() === "" && saves().length === 1 && JSON.stringify(saves()[0].qtyBreaks) === JSON.stringify(TEE_BREAKS));
  await reopen();
  setRows([["10", "1.5"]]);
  await save();
  ok("a changed break is sent and saved", saves().length === 1 && JSON.stringify(saves()[0].qtyBreaks) === '[{"minQty":10,"off":1.5}]' &&
    d1.q("SELECT qtyBreaksJson FROM products WHERE productId='tee'")[0].qtyBreaksJson === '[{"minQty":10,"offCents":150}]');
  w.renderProductForm(d.getElementById("app"), "acme", await productOf("tee"));
  setRows([]);
  await save();
  ok("no rows sends an empty list, which takes the breaks off", saves().length === 1 && Array.isArray(saves()[0].qtyBreaks) && saves()[0].qtyBreaks.length === 0 &&
    d1.q("SELECT qtyBreaksJson FROM products WHERE productId='tee'")[0].qtyBreaksJson === "[]");
  // The server's own refusal: a deepest break that takes a price under the blank's MAP.
  const blank = await M.createBlank(d1, { name: "Example blank", productType: "shirt", colors: [{ color: "White", images: [], sizes: [{ size: "S", purchasePrice: 4, quantity: 10 }, { size: "M", purchasePrice: 4, quantity: 10 }, { size: "L", purchasePrice: 4, quantity: 10 }] }] });
  d1._raw.exec(`UPDATE blank_sizes SET mapPriceCents=1900 WHERE blankId=${blank.id}`);
  for (const z of ["S", "M", "L"]) await M.setBlankLink(d1, "acme", "tee", "", z, blank.id, "White", z);
  w.renderProductForm(d.getElementById("app"), "acme", await productOf("tee"));
  setRows([["12", "2"]]);
  await save();
  ok("the server's refusal is shown in the form, naming the break and the MAP", /^Below the vendor's minimum advertised price \(MAP\): .*12\+ pieces break, \$18\.00, is below the MAP of \$19\.00/.test(errText()) &&
    saves().length === 1 && d1.q("SELECT qtyBreaksJson FROM products WHERE productId='tee'")[0].qtyBreaksJson === "[]");
  d1._raw.exec(`UPDATE blank_sizes SET mapPriceCents=NULL WHERE blankId=${blank.id}`);

  // A product from a server older than breaks: no qtyBreaks list → no section, and nothing sent.
  const old = Object.assign({}, await productOf("tee")); delete old.qtyBreaks;
  w.renderProductForm(d.getElementById("app"), "acme", old);
  ok("a product from a server without breaks: no section", !id("qtyBreaksSection") && !id("qtyBreakRows") && w.readQtyBreaks_(10) === null && w.qtyBreaksDraft_() === undefined);
  await save();
  ok("…and Save sends no qtyBreaks at all, so nothing it never showed is wiped", saves().length === 1 && !("qtyBreaks" in saves()[0]));
  w.renderProductForm(d.getElementById("app"), "acme", null);
  ok("a new product's form has the section, with no breaks yet", !!id("qtyBreaksSection") && qRows().length === 0 && /No quantity breaks/.test(text(id("qtyBreakRows"))));

  w.renderProductForm(d.getElementById("app"), "acme", await productOf("cap"));
  await idle();
  setRows([["10", "15"]]);
  await save();
  ok("a flat-priced product holds a break under its one price ($15.00)", errText() === "The break from 10 pieces takes off $15.00 — it must be less than the product's lowest price ($15.00)." && saves().length === 0);

  console.log("\n=== The deepest break in the costs panel ===");
  await call(Object.assign({}, await productOf("tee"), { action: "updateProduct", org: "acme", qtyBreaks: TEE_BREAKS }));
  tee = await productOf("tee");
  sent.length = 0;
  w.renderProductForm(d.getElementById("app"), "acme", tee);
  await wait(() => !!d.querySelector("#pricingTable .pricing-break"), 300);
  const brkLine = () => d.querySelector("#pricingTable .pricing-break");
  ok("the costs panel has a line for the deepest break: from how many pieces, the price a piece and what it leaves",
    !!brkLine() && /^At the deepest quantity break \(from 24 pieces\): \$16\.50 a piece, leaving \$\d+\.\d\d after costs\.$/.test(text(brkLine())));
  ok("…in green when that meets the income target", /#166534/.test(brkLine().querySelector("b:last-child").getAttribute("style")) && !/⚠/.test(text(brkLine())));
  const draftSent = () => sent.filter(b => b.action === "analyzePricing").pop();
  ok("…worked out from the breaks typed on the form (the draft carries them)", JSON.stringify(draftSent().draft.qtyBreaks) === JSON.stringify(TEE_BREAKS));
  qRows()[1].querySelector(".qtyBreakOff").value = "15"; ev(qRows()[1].querySelector(".qtyBreakOff"), "input");
  await wait(() => /\$5\.00 a piece/.test(text(brkLine())), 300);
  ok("typing a deeper break redraws it: $5.00 a piece leaves less than the $5 target, shown in red with ⚠",
    /\$5\.00 a piece/.test(text(brkLine())) && /#b03a2e/.test(brkLine().querySelector("b:last-child").getAttribute("style")) && /⚠/.test(text(brkLine())));
  id("qtyBreakAdd").click(); qRows()[2].querySelector(".qtyBreakMin").value = "3"; ev(qRows()[2].querySelector(".qtyBreakMin"), "input");
  await wait(() => draftSent() && JSON.stringify(draftSent().draft.qtyBreaks) === JSON.stringify([{ minQty: 12, off: 2 }, { minQty: 24, off: 15 }]), 300);
  ok("a half-typed row isn't in the draft until it makes sense", JSON.stringify(draftSent().draft.qtyBreaks) === JSON.stringify([{ minQty: 12, off: 2 }, { minQty: 24, off: 15 }]));
  setRows([["30", "4"], ["12", "1"], ["12", "2"], ["2", "0.1"], ["3", "0.2"], ["4", "0.3"]]);
  ok("the draft is sorted, a repeated number kept once", JSON.stringify(w.qtyBreaksDraft_()) === JSON.stringify([{ minQty: 2, off: 0.1 }, { minQty: 3, off: 0.2 }, { minQty: 4, off: 0.3 }, { minQty: 12, off: 1 }, { minQty: 30, off: 4 }]));
  setRows([["2", "0.1"], ["3", "0.2"], ["4", "0.3"], ["5", "0.4"], ["6", "0.5"], ["7", "0.6"]]);
  id("qtyBreakRows").insertAdjacentHTML("beforeend", w.qtyBreakRowHtml_({ minQty: 8, off: 0.7 }, 6));
  ok("…and holds at most six", JSON.stringify(w.qtyBreaksDraft_().map(b => b.minQty)) === "[2,3,4,5,6,7]");
  ok("the line needs a deepest break: none without one", w.pricingBreakHtml_({ deepestBreak: null }, {}) === "" && w.pricingBreakHtml_({ deepestBreak: { minQty: 0 } }, {}) === "" && w.pricingBreakHtml_(null, {}) === "");
  ok("…red with no target when it leaves less than nothing, green when it leaves something",
    /#b03a2e/.test(w.pricingBreakHtml_({ deepestBreak: { minQty: 12, unitPrice: 3, margin: -1 } }, {})) && /#166534/.test(w.pricingBreakHtml_({ deepestBreak: { minQty: 12, unitPrice: 3, margin: 0.5 } }, {})));
  // After a save that changed a price, the price check opens: it has the line too.
  w.renderProductForm(d.getElementById("app"), "acme", tee);
  [...d.querySelectorAll(".prodFormSize")].find(x => x.dataset.size === "L").value = "23";
  sent.length = 0; scripted = [];
  w.submitProductForm("acme", true);
  await wait(() => /At the deepest quantity break/.test(d.body.textContent.replace(/<[^>]*>/g, "")) && !!d.querySelector(".pa-edit"), 400);
  ok("the price check after saving a new price shows the deepest break's line under the product", [...d.querySelectorAll(".pricing-break")].some(e => /^At the deepest quantity break \(from 24 pieces\): \$16\.50 a piece/.test(text(e)) && !e.closest("#pricingTable")));
  d.querySelectorAll(".admin-pass-overlay, .modal-overlay").forEach(x => x.remove());

  console.log("\n=== The Local sale form ===");
  const form = () => id("localSaleForm");
  const lsLines = () => [...d.querySelectorAll("#lsLines .ls-line")];
  const fld = (line, name) => line.querySelector(`[data-f="${name}"]`);
  const pick = (line, pid) => { fld(line, "product").value = pid; ev(fld(line, "product"), "change"); };
  const qty = (line, n) => { fld(line, "qty").value = String(n); ev(fld(line, "qty"), "input"); };
  const sizeOf = (line, z) => { fld(line, "size").value = z; ev(fld(line, "size"), "change"); };
  const preview = () => id("lsPricePreview").textContent, note = () => id("lsBreakNote");
  sent.length = 0;
  let closed = w.createLocalSale("acme");
  await wait(() => !!form());
  ok("a line's quantity box goes up to 5,000", fld(lsLines()[0], "qty").max === "5000" && fld(lsLines()[0], "qty").min === "1");
  pick(lsLines()[0], "tee"); sizeOf(lsLines()[0], "M"); qty(lsLines()[0], 6);
  ok("6 tees, under the first break: the list price, no note", preview() === "$20.00 × 6 = $120.00" && note().style.display === "none" && note().textContent === "");
  qty(lsLines()[0], 12);
  ok("12 tees: $2.00 off each, the list price named, the break's pieces", preview() === "$18.00 (was $20.00, 12+ pieces) × 12 = $216.00");
  ok("…and a note that breaks count the whole sale and are worked out again when it is recorded", note().style.display === "" && note().getAttribute("role") === "status" &&
    note().textContent === "Quantity breaks count every piece of a product in this sale. They're worked out again from the shop's published prices when the sale is recorded.");
  qty(lsLines()[0], 30);
  ok("30 tees: the deepest break", preview() === "$16.50 (was $20.00, 24+ pieces) × 30 = $495.00");
  qty(lsLines()[0], 6);
  id("lsAddLine").click();
  pick(lsLines()[1], "tee"); sizeOf(lsLines()[1], "L"); qty(lsLines()[1], 6);
  ok("two tee items of 6 (M and L, $20 and $23) count together: both at the 12-piece price, each size from its own",
    fld(lsLines()[0], "linePrice").textContent === "$18.00 (was $20.00, 12+ pieces) × 6 = $108.00" && fld(lsLines()[1], "linePrice").textContent === "$21.00 (was $23.00, 12+ pieces) × 6 = $126.00" &&
    preview() === "Total for 2 items: $234.00" && note().style.display === "");
  fld(lsLines()[1], "pers").checked = true; ev(fld(lsLines()[1], "pers"), "change");
  ok("personalization is added at its full price, after the break", fld(lsLines()[1], "linePrice").textContent === "$21.00 (was $23.00, 12+ pieces) + $5.00 personalization × 6 = $156.00");
  fld(lsLines()[1], "pers").checked = false; ev(fld(lsLines()[1], "pers"), "change");
  id("lsAddLine").click();
  pick(lsLines()[2], "cap"); qty(lsLines()[2], 40);
  ok("a cap line is another product: no break, and the tees keep theirs", fld(lsLines()[2], "linePrice").textContent === "$15.00 × 40 = $600.00" && /12\+ pieces/.test(fld(lsLines()[0], "linePrice").textContent));
  fld(lsLines()[1], "override").checked = true; ev(fld(lsLines()[1], "override"), "change");
  fld(lsLines()[1], "customPrice").value = "19"; ev(fld(lsLines()[1], "customPrice"), "input");
  ok("a typed price is the price: no break taken off it, though its pieces still count for the others",
    fld(lsLines()[1], "linePrice").textContent === "$19.00 (custom) × 6 = $114.00" && /\$18\.00 \(was \$20\.00, 12\+ pieces\)/.test(fld(lsLines()[0], "linePrice").textContent));
  fld(lsLines()[1], "override").checked = false; ev(fld(lsLines()[1], "override"), "change");
  pick(lsLines()[2], "__custom__");
  ok("a custom item isn't counted with any product", /12\+ pieces/.test(fld(lsLines()[0], "linePrice").textContent));
  lsLines()[1].querySelector('[data-f="remove"]').click();
  ok("removing the second tee item takes the first back under the break, and the note goes", fld(lsLines()[0], "linePrice").textContent === "$20.00 × 6 = $120.00" && note().style.display === "none");
  lsLines()[1].querySelector('[data-f="remove"]').click();
  qty(lsLines()[0], 6000);
  ok("a quantity over 5,000 is priced as 5,000", preview() === "$16.50 (was $20.00, 24+ pieces) × 5000 = $82500.00");
  // Up to 100 items.
  for (let i = 1; i < 100; i++) id("lsAddLine").click();
  ok("+ Add another item goes up to 100 items, then gives way to a note", lsLines().length === 100 && id("lsAddLine").style.display === "none" &&
    id("lsLineLimit").style.display === "" && id("lsLineLimit").textContent === "100 items is the most one sale can have.");
  id("lsAddLine").click();
  ok("…and adds no 101st", lsLines().length === 100);
  ok("…the last is \"Item 100\"", lsLines()[99].querySelector(".ls-line-title").textContent === "Item 100" && fld(lsLines()[99], "remove").getAttribute("aria-label") === "Remove item 100");
  lsLines()[99].querySelector('[data-f="remove"]').click();
  ok("removing one brings the button back", lsLines().length === 99 && id("lsAddLine").style.display === "" && id("lsLineLimit").style.display === "none");
  while (lsLines().length > 1) lsLines()[1].querySelector('[data-f="remove"]').click();
  // Record it: more than 5,000 isn't sent (the box's own limit); 5,000 is, and the server prices the break the same.
  qty(lsLines()[0], 6000);
  id("lsPayment").value = "Cash";
  id("lsName").value = "Pat Example";
  form().querySelector(".admin-pass-submit").click();
  await pause(50); await idle();
  ok("Record sale with 6,000 typed: the quantity box holds it back (over its 5,000), nothing is sent",
    !!form() && fld(lsLines()[0], "qty").validity.rangeOverflow && !sent.some(b => b.action === "createLocalSale"));
  qty(lsLines()[0], 5000);
  form().querySelector(".admin-pass-submit").click();
  await wait(() => !form()); await closed; await idle();
  const made = sent.filter(b => b.action === "createLocalSale").pop();
  const madeId = ((toasts[toasts.length - 1] || { m: "" }).m.match(/Local sale recorded — (\S+)/) || [])[1];
  ok("5,000 is recorded as 5,000", !!made && made.items.length === 1 && made.items[0].qty === 5000);
  const madeRow = madeId ? d1.q("SELECT unitPriceCents, qty FROM order_items WHERE orderId=?", madeId)[0] : null;
  ok("…and the order is charged what the form showed: $16.50 each", !!madeRow && madeRow.qty === 5000 && madeRow.unitPriceCents === 1650);

  // A server older than breaks: its products have no qtyBreaks, and the form takes none off.
  const oldList = (await call({ action: "listProducts", org: "acme" })).body;
  oldList.products.forEach(x => { delete x.qtyBreaks; });
  scripted = [{ action: "listProducts", body: oldList }];
  closed = w.createLocalSale("acme");
  await wait(() => !!form());
  pick(lsLines()[0], "tee"); sizeOf(lsLines()[0], "M"); qty(lsLines()[0], 30);
  ok("products from a server without breaks are priced as listed, with no note", preview() === "$20.00 × 30 = $600.00" && note().style.display === "none");
  const cancel = [...form().querySelectorAll("button")].find(b => /^Cancel$/.test(b.textContent.trim()));
  cancel.click(); await wait(() => !form()); await closed; scripted = [];

  console.log("\n=== \"From quote\" on an order ===");
  const order = await M.getOrderById(d1, orderId1);
  ok("(an order made from a quote carries the quote's id and number)", order && order.estimate && order.estimate.number === q1.number && order.estimate.id === q1.id);
  const pill = (o) => { const box = d.createElement("div"); box.innerHTML = w.orderEstimatePill_(o); return box.firstElementChild; };
  let p = pill(order);
  ok("for a role that may open Quotes it is a link to the quote: \"From quote " + q1.number + "\"", p && p.tagName === "A" && p.getAttribute("href") === "#/quotes/" + q1.id &&
    p.textContent === "From quote " + q1.number && p.classList.contains("order-estimate-link") && p.title === "Open the quote this order was made from");
  const noQuotes = Object.assign({}, roles.effectivePermissions(roles.DEFAULT_ROLES.admin), { "quotes.estimates": "none" });
  const signInNoQuotes = () => w.eval(`adminMe = { role: "custom", roleName: "Front desk" }; adminPerms = ${JSON.stringify(noQuotes)}; adminAreas = ${JSON.stringify(roles.PERMISSION_AREAS)};`);
  signInNoQuotes();
  p = pill(order);
  ok("for a role that may not, the number alone, not a link", p && p.tagName === "SPAN" && p.textContent === "From quote " + q1.number && p.classList.contains("order-estimate-link"));
  w.eval(roles.asRole("admin"));
  w.eval("siteFeatures = Object.assign({}, siteFeatures, { quotes: false });");
  p = pill(order);
  ok("…and with Quotes switched off, the number alone too", p && p.tagName === "SPAN");
  w.eval("siteFeatures = Object.assign({}, siteFeatures, { quotes: true });");
  ok("nothing for an order not made from a quote, or from a server older than quotes", w.orderEstimatePill_({ estimate: null }) === "" && w.orderEstimatePill_({}) === "" && w.orderEstimatePill_(null) === "");
  ok("…or with a quote that has no proper id or number", w.orderEstimatePill_({ estimate: { id: 0, number: "Q-1" } }) === "" && w.orderEstimatePill_({ estimate: { id: "x", number: "Q-1" } }) === "" &&
    w.orderEstimatePill_({ estimate: { id: 3, number: "" } }) === "" && w.orderEstimatePill_({ estimate: { id: 1.5, number: "Q-1" } }) === "" && w.orderEstimatePill_({ estimate: "Q-1" }) === "");
  ok("the number is escaped", /From quote &lt;b&gt;/.test(w.orderEstimatePill_({ estimate: { id: 4, number: "<b>" } })));
  // On the Orders page itself: every line of the two orders made from quotes, and no other order.
  const showOrders = async () => { w.location.hash = "#home"; await wait(() => w.location.hash === "#home"); await idle(); w.location.hash = "#orders/acme"; await wait(() => !!d.querySelector("tr .order-estimate-link"), 600); await idle(); };
  await showOrders();
  const pills = () => [...d.querySelectorAll("#app .order-estimate-link")];
  const rowOrder = (a) => a.closest("tr").textContent;
  const q4Order = "ACME-" + q4.number.replace(/\W/g, "");
  ok("the Orders page shows it by the customer's name on each line of those orders, as a link", pills().length > 0 && pills().every(a => a.tagName === "A" && a.closest("tr")) &&
    pills().filter(a => rowOrder(a).includes(orderId1)).every(a => a.textContent === "From quote " + q1.number) && pills().some(a => rowOrder(a).includes(orderId1)) &&
    pills().filter(a => rowOrder(a).includes(q4Order)).every(a => a.textContent === "From quote " + q4.number) && pills().some(a => rowOrder(a).includes(q4Order)));
  ok("…and on no other order (the local sale has none)", !!madeId && [...d.querySelectorAll("#app tr")].some(tr => tr.textContent.includes(madeId)) &&
    ![...d.querySelectorAll("#app tr")].some(tr => tr.textContent.includes(madeId) && tr.querySelector(".order-estimate-link")));
  const cardBox = d.createElement("div");
  cardBox.innerHTML = w.orderCardHtml_(order, { orgId: "acme", name: "Example Club" }, null, false);
  ok("the phone's order card has it next to the name too", text(cardBox.querySelector(".oc-name .order-estimate-link")) === "From quote " + q1.number);
  signInNoQuotes();
  await showOrders();
  ok("for a role that can't open Quotes the Orders page shows the number without a link", pills().length > 0 && pills().every(a => a.tagName === "SPAN") && !d.querySelector("#app a.order-estimate-link"));
})().catch((e) => { console.error(e); ok("test319 ran to the end", false); });
