const fs = require("fs");
const { storefrontPage } = require("./testlib/storefront-page");
const { autoConfirm } = require("./testlib/confirm.js");
const { asRole, adminAs } = require("./testlib/roles");
const { JSDOM, ResourceLoader } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");
const { ADMIN_ORIGIN } = require("./testlib/hosts.js");

// Brand rules → Show price impact, as a Manager: Brand approvals at Full (so Apply these prices is there) but Brand
// rules at Read (so the rule can be tried out in the window, not saved). The server now applies only the SAVED rule's
// prices (test360), so the window keeps Apply off while the rule shown differs from the saved one, and says why; set
// back, it applies — prices worked out in cents exactly as the server checks them (MAP $19.99 + 7.5% = $21.49).
// (An admin's Apply saves a rule changed in the window first: test164.) The real page in jsdom against the real API.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { createBlank, createProduct, setBlankLink, getProductsByOrg, setBrandRules, getBrandRules };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'test';\n" + adminAs("manager") + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: { acme: 'acme' }, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('acme','acme','Acme','t','t',1);`);
  const sent = [];
  const call = async (body) => { sent.push(body.action); const res = await api({ env: { DB: d1 }, waitUntil: (p) => Promise.resolve(p).catch(() => {}), request: { url: ADMIN_ORIGIN + "/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) }; };
  const tee = (await lib.createBlank(d1, { name: "Tee A", brand: "Acme Apparel", productType: "shirt", colors: [
    { color: "Black", images: [], sizes: [{ size: "M", vendorPrice: 5, purchasePrice: 5, quantity: 0, mapPrice: 19.99 }] }] })).id;
  await lib.createProduct(d1, "acme", { productId: "tee", type: "shirt", name: "Plain tee", pricingMode: "sized", sizePricing: { M: 30 }, visible: true });
  await lib.setBlankLink(d1, "acme", "tee", "", "M", tee, "Black", "M");
  await lib.setBrandRules(d1, Object.assign({}, await lib.getBrandRules(d1), { priceRule: { add: 7.5, unit: "pct" } }));

  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return Promise.resolve(Buffer.from("")); } }
  const dom = new JSDOM(storefrontPage(), { runScripts: "dangerously", resources: new L(), url: ADMIN_ORIGIN + "/", pretendToBeVisual: true,
    beforeParse(win){ win.CSS = win.CSS || { escape: (v) => String(v) }; autoConfirm(win, () => true); win.scrollTo = () => {}; win.fetch = async (url, init) => {
      if (String(url).includes("/api/orders")) { const x = await call(JSON.parse(init.body)); return { ok: x.status < 400, status: x.status, json: async () => x.body }; }
      return { ok: true, status: 200, json: async () => ({ status: "admin" }) }; }; } });
  const w = dom.window, d = w.document;
  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();
  w.eval(`adminKey = "cookie"; ` + asRole("manager", { name: "M", email: "m@example.test" }) + ` adminOrgs = [{ orgId: "acme", name: "Acme" }];`);
  const until = async (fn) => { for (let i = 0; i < 400 && !fn(); i++) await new Promise(res => setTimeout(res, 10)); return !!fn(); };
  const tick = () => new Promise(res => setTimeout(res, 30));
  const text = (el) => (el ? el.textContent : "").replace(/\s+/g, " ").trim();
  const app = d.getElementById("app");
  await w.renderBrandRules(app); await until(() => d.getElementById("brImpact"));
  d.getElementById("brImpact").click();
  await until(() => d.querySelector(".pi-row"));
  const after = () => text(d.querySelector(".pi-row .pi-after"));
  const apply = d.getElementById("piApply"), note = () => text(d.getElementById("piRuleNote"));
  ok("a Manager (Brand rules Read, Brand approvals Full) gets Apply but not Save this rule", apply && !d.getElementById("piSave"));
  ok("After is worked out in cents as the server checks it: MAP $19.99 + 7.5% = $21.49", after() === "$21.49");
  ok("…with the saved rule, Apply is on and nothing needs saying", !apply.disabled && /Apply 1 price/.test(text(apply)) && !note());
  const gen = d.getElementById("piGenAdd");
  gen.value = "20"; gen.dispatchEvent(new w.Event("input", { bubbles: true })); await tick();
  ok("trying another rule in the window shows its prices…", after() === "$23.99");
  ok("…but Apply is off, and the window says it applies the saved rule, which this role can't change", apply.disabled && /saved price rule/.test(note()) && /can't change the rule/.test(note()));
  apply.click(); await tick();
  ok("…so nothing is sent", !sent.includes("applyRulePrices") && !sent.includes("updateBrandRules"));
  gen.value = "7.5"; gen.dispatchEvent(new w.Event("input", { bubbles: true })); await tick();
  ok("set back to the saved rule, Apply is on again", !apply.disabled && !note());
  apply.click();
  await until(() => /Applied/.test(text(d.getElementById("piDone"))));
  const tee1 = (await lib.getProductsByOrg(d1, "acme")).find(p => p.productId === "tee");
  ok("Apply sets the saved rule's price, which the server accepts ($21.49), without saving any rule", tee1.sizePricing.M === 21.49 && !sent.includes("updateBrandRules"));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log("test363 crashed:", false); console.error(e); process.exit(1); });
