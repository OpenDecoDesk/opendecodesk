const fs = require("fs");
const { ok, counts } = require("./testlib/check");
const { storefrontPage } = require("./testlib/storefront-page");
const { autoConfirm } = require("./testlib/confirm.js");
const { createD1 } = require("./testlib/d1-shim.js");
const { adminAs, lowest, may } = require("./testlib/roles");
const { JSDOM, ResourceLoader, VirtualConsole } = require("jsdom");

// Quantity breaks in the pricing analysis (migrations/0109). The deepest break (the one with the most pieces) is a
// price too: every row of analyzePricing also carries breakPrice and breakIncome (what is left at that price), a row
// whose full price meets the blank's MAP but whose break price doesn't is flagged breakMap with its own mapProblems
// sentence (so belowMap is true), and each product reports deepestBreak { minQty, off, unitPrice, margin } — the
// lowest break price and the least left across its rows — or null without breaks. The product form's unsaved breaks
// travel as draft.qtyBreaks; products without breaks read exactly as before. Reached by the admin through the
// analyzePricing action (Price analysis, the product form's costs panel), the product save's MAP check and the
// 6 AM roll-up. Real db.js / orders.js on sql.js; public/admin.js in jsdom. Invented data only.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + "\nreturn { createProduct, createBlank, setBlankLink, analyzePricing, setPricingSettings, getNewPricingAlerts };")();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  strip(read("functions/_lib/fileUpload.js")) + "\n" + strip(read("functions/_lib/vendorImages.js")) + "\n" + strip(read("functions/_lib/permissions.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'owner@example.test';\n" + adminAs({ roleFrom: "globalThis.__test314Role" }) + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
const pause = (ms) => new Promise(r => setTimeout(r, ms));
const wait = async (cond, n = 400) => { for (let i = 0; i < n && !cond(); i++) await pause(10); return !!cond(); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// A database with every migration (or only those before `before`), one shop and one blank with costs and MAPs.
async function newDb(before) {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006" && (!before || f < before)).sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('acme','acme','Example Club','t','t',1);`);
  // Sales tax 6% inside the prices, so the tax at a break price is a different amount from the full price's.
  d1._raw.exec(`INSERT OR REPLACE INTO global_settings (key, value) VALUES ('salesTax', '{"rateBps":600,"taxShipping":false,"jurisdiction":"","taxMode":"inclusive"}');`);
  const blankId = (await lib.createBlank(d1, { name: "Example Tee Blank", productType: "shirt",
    colors: [{ color: "White", images: [], sizes: [{ size: "S", purchasePrice: 0, quantity: 0 }, { size: "M", purchasePrice: 0, quantity: 0 }] },
             { color: "Ash", images: [], sizes: [{ size: "S", purchasePrice: 0, quantity: 0 }] }] })).id;
  // White S: costs $9, MAP $18. White M: costs $14, MAP $15. Ash S: costs $9, MAP $24.
  const set = (c, z, v, m) => d1._raw.run("UPDATE blank_sizes SET vendorPriceCents=?, mapPriceCents=? WHERE blankId=? AND color=? AND size=?", [v, m, blankId, c, z]);
  set("White", "S", 900, 1800); set("White", "M", 1400, 1500); set("Ash", "S", 900, 2400);
  return { d1, blankId };
}

(async () => {
  globalThis.__test314Role = "admin";
  const { d1, blankId } = await newDb();
  const call = async (body) => {
    const waits = [];
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => waits.push(Promise.resolve(p).catch(() => {})),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    await Promise.all(waits);
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const one = async (productId, draft) => (await lib.analyzePricing(d1, { orgId: "acme", productId, draft: draft || null })).products[0];
  const row = (a, size, group) => a.rows.find(r => r.size === size && (group === undefined || r.group === group));

  // "tee": sized S $20 / M $22, breaks from 12 pieces $1 off and from 48 pieces $3 off.
  await lib.createProduct(d1, "acme", { productId: "tee", type: "shirt", name: "Club Tee", pricingMode: "sized", sizePricing: { S: 20, M: 22 }, visible: true, noDesignNeeded: true,
    qtyBreaks: [{ minQty: 12, off: 1 }, { minQty: 48, off: 3 }] });
  await lib.setBlankLink(d1, "acme", "tee", "", "S", blankId, "White", "S");
  await lib.setBlankLink(d1, "acme", "tee", "", "M", blankId, "White", "M");
  // "plain": the same prices and links, no breaks.
  await lib.createProduct(d1, "acme", { productId: "plain", type: "shirt", name: "Plain Tee", pricingMode: "sized", sizePricing: { S: 20, M: 22 }, visible: true, noDesignNeeded: true });
  await lib.setBlankLink(d1, "acme", "plain", "", "S", blankId, "White", "S");
  await lib.setBlankLink(d1, "acme", "plain", "", "M", blankId, "White", "M");

  console.log("=== A product without quantity breaks ===");
  let p = await one("plain");
  ok("its deepestBreak is null", p.deepestBreak === null);
  ok("its rows carry no breakPrice or breakIncome at all", p.rows.length === 2 && p.rows.every(r => !("breakPrice" in r) && !("breakIncome" in r)));
  ok("nothing is flagged breakMap and it isn't below MAP (both prices meet their MAPs)", p.rows.every(r => !r.flags.includes("breakMap")) && p.belowMap === false && same(p.mapProblems, []));
  const plainBefore = JSON.stringify(p);

  console.log("\n=== The deepest break on every row ===");
  let a = await one("tee");
  ok("deepestBreak names the break with the most pieces (48) and its amount off ($3.00)", a.deepestBreak && a.deepestBreak.minQty === 48 && a.deepestBreak.off === 3);
  ok("each row's breakPrice is its price less the deepest break ($17.00 and $19.00), in dollars", row(a, "S").breakPrice === 17 && row(a, "M").breakPrice === 19);
  const atBreak = await one("plain", { pricingMode: "sized", sizePricing: { S: 17, M: 19 } });
  ok("each row's breakIncome is what the same item leaves sold at the break price (card fee and tax worked out on that price)",
    row(a, "S").breakIncome === row(atBreak, "S").income && row(a, "M").breakIncome === row(atBreak, "M").income);
  ok("…which is less than the full price leaves, and not simply the income less $3 (the card fee and tax shrink too)",
    row(a, "S").breakIncome < row(a, "S").income && row(a, "S").breakIncome !== Math.round((row(a, "S").income - 3) * 100) / 100);
  ok("the full price's numbers on each row are unchanged by the breaks", ["price", "blank", "card", "tax", "costs", "income"].every(k => row(a, "S")[k] === row(JSON.parse(plainBefore), "S")[k] && row(a, "M")[k] === row(JSON.parse(plainBefore), "M")[k]));
  ok("deepestBreak.unitPrice is the lowest break price across the rows ($17.00, size S)", a.deepestBreak.unitPrice === 17);
  ok("deepestBreak.margin is the least left at the break across the rows — M's, from a dearer blank, not S's", a.deepestBreak.margin === row(a, "M").breakIncome && row(a, "M").breakIncome < row(a, "S").breakIncome);

  console.log("\n=== MAP at the deepest break ===");
  ok("S at $20 meets its $18 MAP, but $17 at the 48+ break doesn't: flagged breakMap (and not map)", row(a, "S").flags.includes("breakMap") && !row(a, "S").flags.includes("map"));
  ok("M at the break ($19) still meets its $15 MAP: not flagged", !row(a, "M").flags.includes("breakMap"));
  ok("the product is below MAP because of the break alone", a.belowMap === true);
  ok("mapProblems names the size, the break, the price there, the MAP and the blank it comes from",
    same(a.mapProblems, ["S at the 48+ pieces break, $17.00, is below the MAP of $18.00 (Example Tee Blank White S)"]));
  a = await one("tee", { qtyBreaks: [{ minQty: 12, off: 3 }, { minQty: 48, off: 1 }] });
  ok("only the deepest break (most pieces) counts: from 48 pieces $1 off ($19) is fine though 12+ at $3 off would not be", a.deepestBreak.minQty === 48 && row(a, "S").breakPrice === 19 && a.belowMap === false && !row(a, "S").flags.includes("breakMap"));
  a = await one("tee", { qtyBreaks: [{ minQty: 48, off: 2 }] });
  ok("a break price exactly at MAP ($18.00) is fine", row(a, "S").breakPrice === 18 && !row(a, "S").flags.includes("breakMap") && a.belowMap === false);
  a = await one("tee", { sizePricing: { S: 17.5, M: 22 }, qtyBreaks: [{ minQty: 48, off: 3 }] });
  ok("a full price already under MAP is flagged map only, not breakMap as well", row(a, "S").flags.includes("map") && !row(a, "S").flags.includes("breakMap"));
  ok("…with the one plain MAP sentence, no break sentence", same(a.mapProblems, ["S $17.50 is below the MAP of $18.00 (Example Tee Blank White S)"]));
  a = await one("tee", { noBlankNeeded: true, qtyBreaks: [{ minQty: 48, off: 15 }] });
  ok("a row with no MAP (no blank needed) is never flagged breakMap, however deep the break", row(a, "S").breakPrice === 5 && a.rows.every(r => !r.flags.includes("breakMap")) && a.belowMap === false);
  a = await one("tee", { qtyBreaks: [{ minQty: 48, off: 30 }] });
  ok("a break bigger than the price takes it to $0.00, never below", row(a, "S").breakPrice === 0 && row(a, "M").breakPrice === 0 && a.deepestBreak.unitPrice === 0);
  ok("…what's left there is the costs as a loss (no card fee or tax on nothing): minus the blank", row(a, "S").breakIncome === -9 && row(a, "M").breakIncome === -14 && a.deepestBreak.margin === -14);
  ok("…and both sizes are below MAP at that break", row(a, "S").flags.includes("breakMap") && row(a, "M").flags.includes("breakMap") && a.mapProblems.length === 2 &&
    a.mapProblems[1] === "M at the 48+ pieces break, $0.00, is below the MAP of $15.00 (Example Tee Blank White M)");

  console.log("\n=== The sentence for a flat price and for a color group ===");
  await lib.createProduct(d1, "acme", { productId: "cap", type: "cap", name: "Club Cap", pricingMode: "flat", flatPrice: 20, visible: true, noDesignNeeded: true, qtyBreaks: [{ minQty: 24, off: 4 }] });
  await lib.setBlankLink(d1, "acme", "cap", "", "", blankId, "White", "S");
  a = await one("cap");
  ok("a flat price's row is worked out at the break too ($16.00)", a.rows.length === 1 && a.rows[0].size === "" && a.rows[0].breakPrice === 16 && a.deepestBreak.minQty === 24 && a.deepestBreak.off === 4);
  ok("…and its sentence starts with \"The price\"", same(a.mapProblems, ["The price at the 24+ pieces break, $16.00, is below the MAP of $18.00 (Example Tee Blank White S)"]));
  await lib.createProduct(d1, "acme", { productId: "hood", type: "shirt", name: "Club Hood", pricingMode: "sized", sizePricing: { S: 30 }, visible: true, noDesignNeeded: true,
    configurable: true, garmentColors: ["White", "Ash"], colorGroupsCents: [{ key: "heathers", label: "Heathers", colors: ["Ash"], sizePricingCents: { S: 2500 } }], qtyBreaks: [{ minQty: 12, off: 2 }] });
  await lib.setBlankLink(d1, "acme", "hood", "White", "S", blankId, "White", "S");
  await lib.setBlankLink(d1, "acme", "hood", "Ash", "S", blankId, "Ash", "S");
  a = await one("hood");
  ok("each color group's rows get their own break price (Standard $28.00, Heathers $23.00)", row(a, "S", "Standard").breakPrice === 28 && row(a, "S", "Heathers").breakPrice === 23 && a.deepestBreak.unitPrice === 23);
  ok("…and the sentence names the group and size", same(a.mapProblems, ["Heathers S at the 12+ pieces break, $23.00, is below the MAP of $24.00 (Example Tee Blank Ash S)"]));

  console.log("\n=== Breaks that don't count ===");
  a = await one("tee", { qtyBreaks: [{ minQty: 0, off: 2 }, { minQty: -12, off: 2 }, { minQty: 2.5, off: 2 }, { minQty: 10, off: 0 }, { minQty: 10, off: -1 }, null, { minQty: "many", off: 1 }, { off: 1 }] });
  ok("a break with no whole positive number of pieces, or nothing off, or no break at all is left out: no deepest break", a.deepestBreak === null && a.rows.every(r => !("breakPrice" in r)));
  a = await one("tee", { qtyBreaks: "48:3" });
  ok("a list that isn't a list is no breaks", a.deepestBreak === null && a.belowMap === false);
  a = await one("tee", { qtyBreaks: [{ minQty: "36", off: "2.50" }, { minQty: 6, off: 0.5 }] });
  ok("numbers typed as text count, and the breaks are put in order first (36 pieces, $2.50, is the deepest)", a.deepestBreak.minQty === 36 && a.deepestBreak.off === 2.5 && row(a, "S").breakPrice === 17.5);
  await lib.createProduct(d1, "acme", { productId: "noprice", type: "shirt", name: "Unpriced Tee", pricingMode: "sized", sizePricing: {}, visible: true, noDesignNeeded: true, qtyBreaks: [{ minQty: 12, off: 1 }] });
  a = await one("noprice");
  ok("a product with breaks but no prices has no rows and no deepestBreak", a.rows.length === 0 && a.deepestBreak === null);

  console.log("\n=== The form's unsaved breaks (draft.qtyBreaks) ===");
  a = await one("tee", { qtyBreaks: [] });
  ok("an empty list in the draft is no breaks, whatever is saved", a.deepestBreak === null && a.belowMap === false && a.rows.every(r => !("breakPrice" in r)));
  a = await one("tee", { sizePricing: { S: 25, M: 22 } });
  ok("a draft without qtyBreaks uses the saved ones (48 pieces, $3 off) on the draft's prices", a.deepestBreak.minQty === 48 && row(a, "S").breakPrice === 22 && a.belowMap === false);
  a = await one("plain", { qtyBreaks: [{ minQty: 10, off: 2.5 }] });
  ok("a product with none saved is analysed with the breaks being typed", a.deepestBreak.minQty === 10 && row(a, "S").breakPrice === 17.5 && row(a, "S").flags.includes("breakMap"));
  const shop = await lib.analyzePricing(d1, { orgId: "acme", draft: { qtyBreaks: [{ minQty: 10, off: 5 }] } });
  ok("a draft is only for one product: the shop's analysis ignores it", shop.products.find(x => x.productId === "plain").deepestBreak === null && shop.products.find(x => x.productId === "tee").deepestBreak.minQty === 48);

  console.log("\n=== Products without breaks are unchanged ===");
  ok("with breaks on other products, the plain product reads exactly as it did", JSON.stringify(shop.products.find(x => x.productId === "plain")) === plainBefore);
  const old = await newDb("0109");
  await lib.createProduct(old.d1, "acme", { productId: "plain", type: "shirt", name: "Plain Tee", pricingMode: "sized", sizePricing: { S: 20, M: 22 }, visible: true, noDesignNeeded: true });
  await lib.setBlankLink(old.d1, "acme", "plain", "", "S", old.blankId, "White", "S");
  await lib.setBlankLink(old.d1, "acme", "plain", "", "M", old.blankId, "White", "M");
  const pre = (await lib.analyzePricing(old.d1, { orgId: "acme", productId: "plain" })).products[0];
  ok("a database from before migration 0109 (no breaks column) analyses with no breaks and the same numbers", pre.deepestBreak === null && JSON.stringify(pre) === plainBefore);
  await lib.createProduct(old.d1, "acme", { productId: "tee", type: "shirt", name: "Club Tee", pricingMode: "sized", sizePricing: { S: 20 }, visible: true, noDesignNeeded: true, qtyBreaks: [{ minQty: 48, off: 3 }] });
  ok("…where breaks sent with a product are quietly not kept", (await lib.analyzePricing(old.d1, { orgId: "acme", productId: "tee" })).products[0].deepestBreak === null);

  console.log("\n=== Targets stay about the full price ===");
  await lib.setPricingSettings(d1, { cardPctBps: 290, cardFixedCents: 30, suppliesCents: 0, targetIncomeCents: 500, targetHourlyCents: null });
  a = await one("tee");
  ok("a price that meets the income target at full price but not at the break isn't below target (the break's margin is shown beside it)",
    a.rows.every(r => r.income >= 5 && !r.flags.includes("income")) && row(a, "M").breakIncome < 5 && a.deepestBreak.margin < 5 && a.belowTarget === false && same(a.problems, []));
  await lib.setPricingSettings(d1, { cardPctBps: 290, cardFixedCents: 30, suppliesCents: 0, targetIncomeCents: null, targetHourlyCents: null });

  console.log("\n=== The analyzePricing action ===");
  const mgr = lowest("analyzePricing");
  ok("the pricing analysis is a manager's (costs.view)", mgr === "manager");
  globalThis.__test314Role = "manager";
  let r = await call({ action: "analyzePricing", org: "acme", productId: "tee" });
  let got = r.body.products && r.body.products[0];
  ok("a manager's analysis of one product carries deepestBreak, each row's breakPrice / breakIncome and the break's MAP sentence",
    r.status === 200 && got.deepestBreak.minQty === 48 && got.deepestBreak.unitPrice === 17 && row(got, "S").breakPrice === 17 && typeof row(got, "M").breakIncome === "number" &&
    got.belowMap === true && /S at the 48\+ pieces break, \$17\.00, is below the MAP of \$18\.00/.test(got.mapProblems.join()));
  r = await call({ action: "analyzePricing", org: "acme", productId: "tee", draft: { pricingMode: "sized", sizePricing: { S: 20, M: 22 }, qtyBreaks: [{ minQty: 24, off: 1.5 }] } });
  got = r.body.products[0];
  ok("the form's draft breaks are what it's worked out with (from 24 pieces, $1.50 off: $18.50, no MAP problem)", r.status === 200 && got.deepestBreak.minQty === 24 && got.deepestBreak.off === 1.5 && got.deepestBreak.unitPrice === 18.5 && got.belowMap === false);
  r = await call({ action: "analyzePricing", org: "acme", draft: { qtyBreaks: [] } });
  ok("a draft sent without a product is ignored: the shop's products keep their saved breaks", r.status === 200 && r.body.products.find(x => x.productId === "tee").deepestBreak.minQty === 48);
  r = await call({ action: "analyzePricing", org: "acme", productId: "tee", draft: { runMinutes: 2000, qtyBreaks: [{ minQty: 24, off: 1 }] } });
  ok("a draft with breaks is still refused over a bad run time", r.status === 400 && /Run time must be/.test(r.body.message));
  r = await call({ action: "analyzePricing" });
  ok("the every-shop analysis carries deepestBreak too (null for a product without breaks)", r.status === 200 && r.body.products.find(x => x.productId === "tee").deepestBreak.minQty === 48 && r.body.products.find(x => x.productId === "plain").deepestBreak === null);
  ok("Back office and Production can't run it (the margins at the break are a manager's to see)", !may("staff", "analyzePricing") && !may("production", "analyzePricing") && may("manager", "analyzePricing"));
  globalThis.__test314Role = "admin";

  console.log("\n=== Saving a product checks MAP at the deepest break ===");
  const save = (qtyBreaks) => call({ action: "updateProduct", org: "acme", productId: "plain", type: "shirt", name: "Plain Tee", pricingMode: "sized", sizePricing: { S: 20, M: 22 }, visible: true, noDesignNeeded: true, qtyBreaks });
  r = await save([{ minQty: 12, off: 1 }, { minQty: 48, off: 2.5 }]);
  ok("breaks whose deepest goes under MAP are refused (code belowMap) with the analysis's sentence",
    r.status === 400 && r.body.code === "belowMap" && /S at the 48\+ pieces break, \$17\.50, is below the MAP of \$18\.00 \(Example Tee Blank White S\)/.test(r.body.message));
  ok("…and nothing was saved", (await one("plain")).deepestBreak === null);
  r = await save([{ minQty: 12, off: 1 }, { minQty: 48, off: 2 }]);
  ok("breaks that keep every size at or over MAP are saved, and the analysis then has them", r.status === 200 && (await one("plain")).deepestBreak.minQty === 48);
  r = await save([]);
  ok("…saving no breaks takes them off again", r.status === 200 && (await one("plain")).deepestBreak === null && JSON.stringify(await one("plain")) === plainBefore);

  console.log("\n=== The 6 AM roll-up ===");
  const alerts = await lib.getNewPricingAlerts(d1);
  const teeAlert = alerts.products.find(x => x.productId === "tee");
  ok("a visible product below MAP only at its deepest break is reported, with the break sentence", teeAlert && teeAlert.problems.includes("S at the 48+ pieces break, $17.00, is below the MAP of $18.00 (Example Tee Blank White S)"));
  ok("…and a product without breaks that meets MAP isn't", !alerts.products.some(x => x.productId === "plain"));

  console.log("\n=== The admin page ===");
  const adminJs = read("public/admin.js");
  const sent = [];
  class Ld extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  // The page's font stylesheet can't be fetched here; that's not what this file checks.
  const vc = new VirtualConsole(); vc.on("error", (e) => console.error(e)); vc.on("jsdomError", (e) => { if (!/Could not load link/.test(String(e && e.message))) console.error(e); });
  const dom = new JSDOM(storefrontPage(), { virtualConsole: vc, runScripts: "dangerously", resources: new Ld(), url: "https://admin.example.com/#catalog", pretendToBeVisual: true,
    beforeParse(win){ autoConfirm(win, () => true); win.CSS = win.CSS || { escape: (x) => String(x) }; win.fetch = async (url, init) => {
      if (String(url).includes("/api/orders")) { const b = JSON.parse(init.body); sent.push(b); const x = await call(b); return { ok: x.status < 400, status: x.status, json: async () => x.body }; }
      return { ok: false, status: 404, json: async () => ({ status: "error" }) }; }; } });
  const w = dom.window, d = w.document;
  await pause(150);
  await w.loadAdminScript();
  w.eval('adminKey = "cookie"; adminOrgs = [{ orgId: "acme", name: "Example Club" }]; window._adminOrgRegistry = [{ orgId: "acme", name: "Example Club" }];');
  const html = (deep, settings) => { const box = d.createElement("div"); box.innerHTML = w.pricingBreakHtml_(deep === undefined ? null : { deepestBreak: deep }, settings); return box; };
  ok("the break line is drawn only for a product with a deepest break", w.pricingBreakHtml_(null, {}) === "" && w.pricingBreakHtml_({ deepestBreak: null }, {}) === "" && w.pricingBreakHtml_({ deepestBreak: { minQty: 0, unitPrice: 1, margin: 1 } }, {}) === "");
  let box = html({ minQty: 48, off: 3, unitPrice: 17, margin: 5.25 }, { targetIncome: 4 });
  ok("it says the pieces, the price a piece and what's left after costs",
    box.textContent.trim() === "At the deepest quantity break (from 48 pieces): $17.00 a piece, leaving $5.25 after costs.");
  ok("…green when that meets the income target", /#166534/.test(box.querySelector(".pricing-break b:last-child").getAttribute("style")));
  box = html({ minQty: 48, off: 3, unitPrice: 17, margin: 3.5 }, { targetIncome: 4 });
  ok("…red, with ⚠, when it's under the income target", /#b03a2e/.test(box.querySelector(".pricing-break b:last-child").getAttribute("style")) && /leaving ⚠ \$3\.50 after costs/.test(box.textContent));
  box = html({ minQty: 48, off: 3, unitPrice: 17, margin: -0.5 }, null);
  ok("…red when it leaves less than nothing, with no target set", /#b03a2e/.test(box.querySelector(".pricing-break b:last-child").getAttribute("style")) && /⚠/.test(box.textContent));
  box = html({ minQty: 48, off: 3, unitPrice: 17, margin: 0 }, {});
  ok("…green at exactly nothing left when there's no target", /#166534/.test(box.querySelector(".pricing-break b:last-child").getAttribute("style")) && !/⚠/.test(box.textContent));

  // Price analysis (the Products list's button): the break's MAP sentence with the problems, the break line under the table.
  sent.length = 0;
  const done = w.showPriceAnalysis_({ org: "acme", productId: "tee" }, { title: "Price analysis" });
  await wait(() => d.querySelector("#paBody .pa-product"));
  await done;
  const pa = d.getElementById("paBody");
  ok("Price analysis shows the break's MAP sentence with the product's problems", pa.textContent.includes("S at the 48+ pieces break, $17.00, is below the MAP of $18.00 (Example Tee Blank White S)"));
  ok("…and the deepest break's price and margin under its table", /At the deepest quantity break \(from 48 pieces\): \$17\.00 a piece/.test(pa.querySelector(".pricing-break") ? pa.querySelector(".pricing-break").textContent : ""));
  ok("…opened and marked, because it's below MAP", d.querySelector("#paBody .pa-product").open);
  d.getElementById("paDone").click();

  // The product form's costs panel: drawn from the saved breaks, then redrawn from the breaks as typed.
  const app = d.getElementById("app");
  const listed = (await call({ action: "listProducts", org: "acme" })).body.products.find(x => x.productId === "tee");
  sent.length = 0;
  w.renderProductForm(app, "acme", listed);
  await wait(() => d.querySelector("#pricingTable .pricing-break"));
  const panel = () => d.getElementById("pricingTable").textContent;
  ok("the product form's costs panel shows the deepest saved break's price and the MAP sentence", /from 48 pieces\): \$17\.00 a piece/.test(panel()) && /S at the 48\+ pieces break/.test(panel()));
  ok("…its request sent the form's breaks as the draft", sent.some(b => b.action === "analyzePricing" && b.draft && same(b.draft.qtyBreaks, [{ minQty: 12, off: 1 }, { minQty: 48, off: 3 }])));
  sent.length = 0;
  d.getElementById("qtyBreakAdd").click();
  const rows = () => [...d.querySelectorAll("#qtyBreakRows .qty-break-row")];
  await wait(() => sent.some(b => b.action === "analyzePricing"), 200);
  const lastDraft = () => { const l = sent.filter(b => b.action === "analyzePricing"); return l.length ? l[l.length - 1].draft : null; };
  ok("adding an empty row redraws the panel, leaving the half-typed row out of the draft", rows().length === 3 && same(lastDraft().qtyBreaks, [{ minQty: 12, off: 1 }, { minQty: 48, off: 3 }]));
  const typeRow = (i, min, off) => { const r3 = rows()[i]; r3.querySelector(".qtyBreakMin").value = min; r3.querySelector(".qtyBreakOff").value = off; r3.querySelector(".qtyBreakOff").dispatchEvent(new w.Event("input", { bubbles: true })); };
  sent.length = 0;
  typeRow(2, "96", "5");
  await wait(() => /from 96 pieces\): \$15\.00 a piece/.test(panel()), 200);
  ok("typing a deeper break redraws the panel at it (96 pieces: $15.00), in order, with both sizes' MAP sentences",
    same(lastDraft().qtyBreaks, [{ minQty: 12, off: 1 }, { minQty: 48, off: 3 }, { minQty: 96, off: 5 }]) && /from 96 pieces\): \$15\.00 a piece/.test(panel()) && /S at the 96\+ pieces break, \$15\.00/.test(panel()));
  sent.length = 0;
  typeRow(2, "48", "4");
  await wait(() => sent.some(b => b.action === "analyzePricing"), 200);
  ok("a second break at the same number of pieces is left out of the draft until it's changed", same(lastDraft().qtyBreaks, [{ minQty: 12, off: 1 }, { minQty: 48, off: 3 }]));
  sent.length = 0;
  for (let i = 0; i < 3; i++) d.querySelector("#qtyBreakRows .qtyBreakRm").click();
  await wait(() => !d.querySelector("#pricingTable .pricing-break") && sent.length > 0, 200);
  ok("removing every break sends an empty list, and the break line and its MAP sentence go", same(lastDraft().qtyBreaks, []) && !d.querySelector("#pricingTable .pricing-break") && !/pieces break/.test(panel()));
  // A product from a server older than breaks (no qtyBreaks list): no section, and the draft leaves the breaks to the server.
  const older = Object.assign({}, listed); delete older.qtyBreaks;
  sent.length = 0;
  w.renderProductForm(app, "acme", older);
  await wait(() => d.querySelector("#pricingTable .pricing-break"));
  ok("with no breaks section the draft has no qtyBreaks, so the saved breaks are analysed", !d.getElementById("qtyBreaksSection") && sent.some(b => b.action === "analyzePricing" && b.draft && !("qtyBreaks" in b.draft)) &&
    /from 48 pieces/.test(panel()));

  const c = counts();
  console.log(`\n${c.failed ? "FAIL" : "PASS"} - ${c.passed} passed, ${c.failed} failed`);
})().catch(e => { console.error(e); console.log("test314 crashed: false"); process.exit(1); });
