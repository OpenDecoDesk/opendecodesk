const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// Brand rules → Show price impact → Apply these prices (applyRulePrices) needs Brand approvals Edit, not Products Edit.
// It took whatever prices the browser sent ($0 to $10,000), so a role meant only to apply the price rule could set any
// product's price in any shop (review round 2). Now the server works out each price itself from the SAVED price rule
// (a brand's own, else the general one) and the product's MAP, and takes only that price or that price rounded up as
// the window offers (to the next whole dollar, or to .99). Anything else is refused, naming the product, and nothing
// is written. A rule changed in the window but not saved doesn't count until it is saved.
// Real SQL (sql.js) + real db.js, permissions.js and orders.js; the sign-in gate stubbed as test247 does, with a custom
// role. Invented data only.

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
  "\nreturn { post: onRequestPost, as: __as, normalizePermissions, lib: { createBlank, createProduct, setBlankLink, getProductsByOrg, getBrandRules } };")();

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
  const L = api.lib;
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('acme','acme','Example Club','t','t',1), ('beta','beta','Second Club','t','t',1);`);
  const sz = (size, map) => ({ size, vendorPrice: 5, purchasePrice: 5, quantity: 0, mapPrice: map });
  // Two blanks with a MAP: one of a brand with its own rule (MAP + 10%), one that takes the general rule (MAP + $2).
  const own = (await L.createBlank(d1, { name: "Tee A", brand: "Acme Apparel", productType: "shirt", colors: [{ color: "Black", images: [], sizes: [sz("M", 19.99), sz("L", 22)] }] })).id;
  const gen = (await L.createBlank(d1, { name: "Tee B", brand: "Other Mills", productType: "shirt", colors: [{ color: "Black", images: [], sizes: [sz("M", 18)] }] })).id;
  await L.createProduct(d1, "acme", { productId: "tee", type: "shirt", name: "Club tee", pricingMode: "sized", sizePricing: { M: 30, L: 30 }, visible: true });
  for (const s of ["M", "L"]) await L.setBlankLink(d1, "acme", "tee", "", s, own, "Black", s);
  await L.createProduct(d1, "beta", { productId: "cap", type: "hat", name: "Club cap", pricingMode: "flat", flatPrice: 30, visible: true });
  await L.setBlankLink(d1, "beta", "cap", "", "", gen, "Black", "M");
  const rules0 = (await call({ action: "getBrandRules" })).body.rules;
  let r = await call({ action: "updateBrandRules", rules: Object.assign({}, rules0, { priceRule: { add: 2, unit: "amount" }, brandPrices: [{ brand: "Acme Apparel", add: 7.5, unit: "pct" }] }) });
  ok("set up: a general rule (MAP + $2) and a brand's own (MAP + 7.5%)", r.status === 200);
  const priceOf = async (org, id, size) => { const p = (await L.getProductsByOrg(d1, org)).find(x => x.productId === id); return size ? p.sizePricing[size] : p.flatPrice; };
  const applied = () => d1.q("SELECT count(*) n FROM audit_log WHERE action='product.prices_applied'")[0].n;

  // A role meant only to apply the rule: Brand approvals Edit, Products read, and the costs the window shows.
  const pricer = role("pricer", { "catalog.brandApprovals": "edit", "catalog.products": "read", "catalog.brandrules": "read", "costs.view": "read" });

  console.log("=== Any other price is refused ===");
  r = await call({ action: "applyRulePrices", changes: [{ org: "acme", productId: "tee", size: "M", price: 1 }] }, pricer);
  ok("Brand approvals Edit can't set a product to any price ($1): refused, naming the product, the size and the rule's price", r.status === 400 &&
    /Club tee M: \$1\.00 isn't the saved price rule's price \(\$21\.49/.test(r.body.message));
  ok("…and nothing is written", await priceOf("acme", "tee", "M") === 30 && applied() === 0);
  r = await call({ action: "applyRulePrices", changes: [{ org: "acme", productId: "tee", size: "M", price: 21.49 }, { org: "beta", productId: "cap", size: "", price: 9999 }] }, pricer);
  ok("one wrong price in the list refuses the whole list (the right one isn't written either)", r.status === 400 && /Club cap: \$9999\.00 isn't/.test(r.body.message) &&
    await priceOf("acme", "tee", "M") === 30 && await priceOf("beta", "cap") === 30);
  r = await call({ action: "applyRulePrices", changes: [{ org: "beta", productId: "cap", size: "", price: 19.35 }] }, pricer);
  ok("a brand without its own rule takes the general one, not another brand's ($18 + 7.5% is refused; $18 + $2 is the rule)", r.status === 400 && /\(\$20\.00/.test(r.body.message));

  console.log("\n=== The saved rule's price, or that rounded up as the window offers ===");
  r = await call({ action: "applyRulePrices", changes: [{ org: "acme", productId: "tee", size: "M", price: 21.49 }, { org: "beta", productId: "cap", size: "", price: 20 }] }, pricer);
  ok("the rule's price itself is applied: MAP $19.99 + 7.5% = $21.49 (in cents, as the window works it out); $18 + $2 = $20", r.status === 200 && r.body.prices === 2 &&
    await priceOf("acme", "tee", "M") === 21.49 && await priceOf("beta", "cap") === 20);
  r = await call({ action: "applyRulePrices", changes: [{ org: "acme", productId: "tee", size: "L", price: 23.99 }] }, pricer);
  ok("…rounded up to .99 ($22 + 7.5% = $23.65 → $23.99)", r.status === 200 && await priceOf("acme", "tee", "L") === 23.99);
  r = await call({ action: "applyRulePrices", changes: [{ org: "acme", productId: "tee", size: "L", price: 24 }] }, pricer);
  ok("…rounded up to the next whole dollar ($23.65 → $24)", r.status === 200 && await priceOf("acme", "tee", "L") === 24);
  r = await call({ action: "applyRulePrices", changes: [{ org: "acme", productId: "tee", size: "L", price: 23 }] }, pricer);
  ok("…but never rounded down ($23 is refused)", r.status === 400 && await priceOf("acme", "tee", "L") === 24);

  console.log("\n=== Only the SAVED rule counts ===");
  r = await call({ action: "applyRulePrices", changes: [{ org: "beta", productId: "cap", size: "", price: 23 }] }, pricer);
  ok("a price from a rule changed in the window but not saved (MAP + $5) is refused", r.status === 400 && await priceOf("beta", "cap") === 20);
  r = await call({ action: "updateBrandRules", rules: Object.assign({}, await L.getBrandRules(d1), { priceRule: { add: 5, unit: "amount" } }) }, pricer);
  ok("this role can't save the rule (Brand rules Read)", r.status === 403);
  r = await call({ action: "updateBrandRules", rules: Object.assign({}, await L.getBrandRules(d1), { priceRule: { add: 5, unit: "amount" } }) });
  r = await call({ action: "applyRulePrices", changes: [{ org: "beta", productId: "cap", size: "", price: 23 }] }, pricer);
  ok("…once someone who may saves it, its price is applied", r.status === 200 && await priceOf("beta", "cap") === 23);

  console.log("\n=== Who may apply ===");
  r = await call({ action: "applyRulePrices", changes: [{ org: "beta", productId: "cap", size: "", price: 23 }] }, role("looker", { "catalog.brandApprovals": "read", "catalog.products": "edit", "costs.view": "read" }));
  ok("Brand approvals Read can't apply rule prices", r.status === 403);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log("test360 crashed:", false); console.error(e); process.exit(1); });
