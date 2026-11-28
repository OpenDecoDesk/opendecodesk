const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// Saving the shop rate (Finance → Shop rate) or the sales tax (Global settings) re-checks every product's prices and
// answers with the ones now below a target. Those two saves sent the list as it was — each product's cost and margin
// shortfall ("Income below the $500.00 target on …") — to a role that may save them without Money, costs and margins
// (costs.view) (review round 2). Now both go through the same filter as the Pricing and Global settings saves: a role
// without costs.view hears only of prices under a blank's MAP (a vendor's public price), never of costs or targets.
// Real SQL (sql.js) + real db.js, permissions.js and orders.js; the sign-in gate stubbed as test247 does, with custom
// roles. Invented data only.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  strip(read("functions/_lib/permissions.js")) + "\n" +
  "const __as = { role: null };\n" +
  "const requireAdmin = async (env, host, key, request, msg, need) => !__as.role || roleAllows(__as.role, need) ? null : new Response(JSON.stringify({ status: 'error', code: 'forbidden', message: 'Your role can\\'t do this.' }), { status: 403 });\n" +
  "const adminActor = () => 'pat@example.test';\n" +
  "const adminUser = () => __as.role ? { id: 7, role: __as.role.key, roleInfo: __as.role } : null;\n" +
  "const adminCan = (request, fn, level) => !__as.role || permRank(effectiveLevel(__as.role, fn)) >= permRank(level || 'read');\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendShippingPaymentEmail = async () => true; const sendCancellationEmail = async () => true; const vendorCredentialsReady = () => false;\n" +
  strip(read("functions/_lib/db.js")) + "\n" + strip(read("functions/api/orders.js")) +
  "\nreturn { post: onRequestPost, as: __as, normalizePermissions, lib: { createProduct, setPricingSettings } };")();

let failed = 0, passed = 0;
const ok = (label, cond) => { cond ? passed++ : failed++; console.log(label + ": " + !!cond); };
const role = (key, fns) => ({ key, name: key, rank: 10, locked: false, builtIn: false, permissions: api.normalizePermissions({ fns }) });

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const env = { DB: d1, ROOT_DOMAIN: "example.com" };
  const pending = [];
  const call = async (body, as = null) => {
    api.as.role = as;
    const full = Object.assign({ key: "x" }, body);
    const req = { url: "https://admin.example.com/api/orders", json: async () => full, clone: () => ({ json: async () => full }), headers: { get: () => null } };
    const res = await api.post({ env, waitUntil: (p) => pending.push(p), request: req });
    await Promise.all(pending.splice(0));
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('acme','acme','Example Club','t','t',1);`);
  await api.lib.createProduct(d1, "acme", { productId: "tee", type: "shirt", name: "Club tee", pricingMode: "flat", flatPrice: 20, visible: true });
  // A $500 income target no $20 tee meets: the tee is below target, and the reason names its income — a cost figure.
  await api.lib.setPricingSettings(d1, { cardPctBps: 290, cardFixedCents: 30, suppliesCents: 0, targetHourlyCents: null, targetIncomeCents: 50000 });
  const shopRate = { period: "last12", extras: [{ label: "Rent share", cents: 60000 }], ownerPayCents: 3000000, profitPct: 10, hoursPerWeek: 20, weeksPerYear: 48 };
  const costText = (list) => JSON.stringify(list || []).match(/Income below|target/);

  console.log("=== Finance → Shop rate: Save ===");
  let r = await call({ action: "saveShopRate", shopRate });
  ok("someone with Money, costs and margins hears which products are below a target, and why", r.status === 200 && r.body.belowTarget.length === 1 &&
    r.body.belowTarget[0].productId === "tee" && /Income below the \$500\.00 target/.test(r.body.belowTarget[0].problems.join(" ")));
  const rates = role("rates", { "finance.shoprate": "edit" });
  r = await call({ action: "saveShopRate", shopRate }, rates);
  ok("Shop rate Edit without Money, costs and margins saves it…", r.status === 200 && r.body.shopRate && Array.isArray(r.body.belowTarget));
  ok("…but hears no cost or margin problems (no product below a target, no target, no income)", r.body.belowTarget.length === 0 && !costText(r.body.belowTarget));
  r = await call({ action: "saveShopRate", shopRate }, role("ratesCosts", { "finance.shoprate": "edit", "costs.view": "read" }));
  ok("…the same with Money, costs and margins hears them", r.status === 200 && r.body.belowTarget.length === 1 && !!costText(r.body.belowTarget));

  console.log("\n=== Global settings → Sales tax: Save ===");
  r = await call({ action: "updateSalesTaxSettings", ratePercent: 7.25, jurisdiction: "OH", taxMode: "exclusive" });
  ok("someone with Money, costs and margins hears which products are below a target", r.status === 200 && r.body.belowTarget.length === 1 && !!costText(r.body.belowTarget));
  const taxes = role("taxes", { "settings.global": "edit" });
  r = await call({ action: "updateSalesTaxSettings", ratePercent: 6, jurisdiction: "OH", taxMode: "inclusive" }, taxes);
  ok("Global settings Edit without Money, costs and margins saves the sales tax…", r.status === 200 && r.body.salesTax.rateBps === 600);
  ok("…but hears no cost or margin problems", Array.isArray(r.body.belowTarget) && r.body.belowTarget.length === 0 && !costText(r.body.belowTarget));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log("test361 crashed:", false); console.error(e); process.exit(1); });
