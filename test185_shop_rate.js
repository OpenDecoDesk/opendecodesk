const fs = require("fs");
const { storefrontPage } = require("./testlib/storefront-page");
const { may, lowest, pageLowest, asRole } = require("./testlib/roles");   // the built-in roles (functions/_lib/permissions.js)
const { JSDOM, ResourceLoader } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");

// Finance → Shop rate: what an hour of production costs, from a year of expenses (business share), equipment spread
// over its life, an optional owner pay and profit %, divided by the hours worked — every figure overridable, saved,
// and used by price analysis (overhead per run minute as a cost; the rest of the rate as the hourly target unless one
// is typed). Real db.js / orders.js on sql.js; the screen and the pricing table in jsdom.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { createProduct, analyzePricing, setPricingSettings, computeShopRate, setShopRate, getShopRate, shopRatePeriod };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" + strip(read("functions/_lib/fileUpload.js")) + "\n" + strip(read("functions/_lib/vendorImages.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'owner@test'; const adminUser = () => (globalThis.__role ? { role: globalThis.__role } : null);\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const TODAY = new Date("2026-11-15T12:00:00Z");

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const call = async (body) => {
    const res = await api({ env: { DB: d1, TIME_ZONE: "UTC" }, waitUntil: (p) => Promise.resolve(p).catch(() => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const cat = (name) => d1.q("SELECT id FROM expense_categories WHERE name = ?", name)[0].id;
  d1._raw.exec("INSERT INTO expense_categories (name, deductionType, scheduleCLine, deductiblePct, createdAt, updatedAt) VALUES ('Rent & utilities','deductible','20b',100,'t','t')");
  const add = (date, desc, catName, cents, pct = 100, dep = null) => d1._raw.run(
    "INSERT INTO expenses (expenseDate, description, categoryId, amountCents, businessUsePct, depMethod, placedInService, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?)",
    [date, desc, cat(catName), cents, pct, dep, dep ? date : null, "t", "t"]);
  add("2026-02-01", "Website plan", "Software & subscriptions", 118800);
  add("2024-06-01", "Old software", "Software & subscriptions", 99900);          // before the period
  add("2026-03-10", "Liability insurance", "Insurance", 84000);
  add("2026-04-01", "Flyers", "Advertising", 50000, 50);                          // half business use
  add("2026-05-01", "Thread", "Supplies (thread, stabilizer, needles)", 195000);  // already per product
  add("2025-03-02", "Tajima 6-head", "Equipment & machines", 1850000, 100, "macrs7");
  add("2026-01-14", "Heat press", "Equipment & machines", 89900, 100, "ask_cpa");
  add("2018-01-01", "Old single-head", "Equipment & machines", 500000, 100, "macrs5"); // life used up in 2023
  // 2 timed hours of runs in the period, one untimed run that doesn't count.
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('acme','acme','Acme','t','t',1);`);
  d1._raw.exec(`INSERT INTO orders (orderId, orgId, customerName, contact, placedAt) VALUES ('O1','acme','C','c@x.com','2026-06-01T00:00:00Z')`);
  d1._raw.exec(`INSERT INTO order_items (orderId, orgId, productId, name, type, size, qty, unitPriceCents, lineTotalCents, configJson) VALUES ('O1','acme','tee','Tee','shirt','M',1,2000,2000,'{}')`);
  const item = d1.q("SELECT id FROM order_items")[0].id;
  d1._raw.run("INSERT INTO production_runs (orgId, orderId, itemId, startedAt, finishedAt, status, createdAt, timed) VALUES ('acme','O1',?, '2026-06-01T10:00:00.000Z','2026-06-01T11:30:00.000Z','done','t',1)", [item]);
  d1._raw.run("INSERT INTO production_runs (orgId, orderId, itemId, startedAt, finishedAt, status, createdAt, timed) VALUES ('acme','O1',?, '2026-06-02T10:00:00.000Z','2026-06-02T10:30:00.000Z','done','t',1)", [item]);
  d1._raw.run("INSERT INTO production_runs (orgId, orderId, itemId, startedAt, finishedAt, status, createdAt, timed) VALUES ('acme','O1',?, '2026-06-03T10:00:00.000Z','2026-06-03T15:00:00.000Z','done','t',0)", [item]);

  console.log("=== Worked out from the expenses ===");
  let r = await lib.computeShopRate(d1, {}, { today: TODAY });
  ok("the period is the last 12 months up to today", r.period.from === "2025-11-16" && r.period.to === "2026-11-15");
  const run = (name) => r.running.find(c => c.name === name);
  ok("each category's expenses in the period, at their business share", run("Software & subscriptions").fromExpensesCents === 118800 && run("Advertising").fromExpensesCents === 25000 && run("Insurance").cents === 84000);
  ok("supplies start excluded (already in each product's cost)", run("Supplies (thread, stabilizer, needles)").excluded && run("Supplies (thread, stabilizer, needles)").cents === 0);
  ok("equipment isn't a running cost", !run("Equipment & machines"));
  const eq = (d) => r.equipment.find(e => e.description === d);
  ok("equipment spread over its life: MACRS 7 → 7 years (bought before the period), otherwise 5", eq("Tajima 6-head").life === 7 && eq("Tajima 6-head").perYearCents === 264286 && eq("Heat press").life === 5 && eq("Heat press").perYearCents === 17980);
  ok("equipment whose life was used up before the period is left out", !eq("Old single-head"));
  ok("timed hours on Run order (untimed runs left out)", r.timedHours === 2);
  ok("no hours yet: no rate", r.ratePerHourCents === null);

  console.log("\n=== Overridden ===");
  const choices = { period: "last12", categories: { [cat("Insurance")]: { cents: 60000 } }, extras: [{ label: "Electricity share", cents: 60000 }],
    lives: { [d1.q("SELECT id FROM expenses WHERE description='Heat press'")[0].id]: 3 }, ownerPayCents: 3000000, profitPct: 10, hoursPerWeek: 20, weeksPerYear: 48 };
  r = await lib.computeShopRate(d1, choices, { today: TODAY });
  ok("an amount typed over a category wins, marked as overridden", run("Insurance") === undefined ? false : r.running.find(c => c.name === "Insurance").cents === 60000 && r.running.find(c => c.name === "Insurance").overridden);
  ok("a cost not in expenses is added", r.runningCents === 118800 + 60000 + 25000 + 60000);
  ok("a life typed over the default changes the yearly share", r.equipment.find(e => e.description === "Heat press").perYearCents === 29967 && r.equipmentCents === 264286 + 29967);
  ok("hours: 20 a week × 48 weeks", r.hours === 960);
  const overhead = 263800 + 294253;
  ok("overhead per hour = (running + equipment) ÷ hours", r.overheadCents === overhead && r.overheadPerHourCents === Math.round(overhead / 960));
  ok("+ pay per hour, + profit % on both, = the shop rate", r.payPerHourCents === 3125 && r.profitPerHourCents === Math.round((581 + 3125) * 0.1) && r.ratePerHourCents === 581 + 3125 + 371);
  const incl = await lib.computeShopRate(d1, { ...choices, categories: { ...choices.categories, [cat("Supplies (thread, stabilizer, needles)")]: { included: true } } }, { today: TODAY });
  ok("supplies can be ticked back in", incl.runningCents === r.runningCents + 195000);
  const y = await lib.computeShopRate(d1, { ...choices, period: "2024" }, { today: TODAY });
  ok("another period: that calendar year's expenses (the old software, not this year's)", y.period.from === "2024-01-01" && y.running.find(c => c.name === "Software & subscriptions").fromExpensesCents === 99900);

  console.log("\n=== Saved, and used by pricing ===");
  let a = await call({ action: "saveShopRate", shopRate: { ...choices, hoursPerWeek: 0 } });
  ok("saving without hours is refused, saying what's missing", a.status === 400 && /hours a week/.test(a.body.message));
  a = await call({ action: "getShopRate", shopRate: choices });
  ok("the page's unsaved choices are worked out without saving", a.body.status === "ok" && a.body.shopRate.rate === 40.77 && !a.body.shopRate.saved);
  a = await call({ action: "saveShopRate", shopRate: choices });
  ok("saved: the rate, its overhead per hour and the date", a.body.status === "ok" && a.body.shopRate.saved.rate === 40.77 && a.body.shopRate.saved.overheadPerHour === 5.81 && /^2026|^20/.test(a.body.shopRate.saved.savedAt));
  a = await call({ action: "getShopRate" });
  ok("…and comes back with the choices as saved", a.body.input.ownerPayCents === 3000000 && a.body.input.categories[cat("Insurance")].cents === 60000 && a.body.shopRate.rate === 40.77);
  ok("the save is in the audit log", d1.q("SELECT * FROM audit_log WHERE action='settings.shop_rate_set'").length === 1);
  // The sign-in is stubbed here; what each action needs is what requireAdmin is given (permissions.js ACTION_PERM).
  const ordersSrc = read("functions/api/orders.js");
  ok("only an admin can see or change it (both actions are admin-only)", lowest("getShopRate") === "admin" && lowest("saveShopRate") === "admin");

  await lib.createProduct(d1, "acme", { productId: "cap", type: "hat", name: "Cap", pricingMode: "flat", flatPrice: 25, visible: true, noBlankNeeded: true, taxable: false, runMinutes: 10 });
  await lib.createProduct(d1, "acme", { productId: "pin", type: "other", name: "Pin", pricingMode: "flat", flatPrice: 5, visible: true, noBlankNeeded: true, taxable: false });
  let p = await lib.analyzePricing(d1, { orgId: "acme" });
  const cap = p.products.find(x => x.productId === "cap"), pin = p.products.find(x => x.productId === "pin");
  ok("overhead is charged on each item: run time × overhead per hour", cap.rows[0].overhead === Math.round(10 * 581 / 60) / 100 && Math.abs(cap.rows[0].costs - (cap.rows[0].card + cap.rows[0].supplies + cap.rows[0].overhead)) < 0.011);
  ok("…and none without a run time", pin.rows[0].overhead === 0);
  ok("the target hourly rate is the shop rate less overhead (income is already after it), and says so", p.settings.targetHourly === 34.96 && p.settings.targetHourlySource === "shopRate" && p.settings.shopRate.rate === 40.77);
  ok("a cheap item is flagged below it", (cap.rows[0].hourly < 34.96) === cap.rows[0].flags.includes("hourly"));
  await lib.setPricingSettings(d1, { cardPctBps: 290, cardFixedCents: 30, suppliesCents: 0, targetHourlyCents: 2000, targetIncomeCents: null });
  p = await lib.analyzePricing(d1, { orgId: "acme" });
  ok("a target typed in Global settings → Pricing still wins", p.settings.targetHourly === 20 && p.settings.targetHourlySource === "typed");
  a = await call({ action: "getPricingSettings" });
  ok("Global settings → Pricing is told the shop rate's target", a.body.pricing.shopRate.target === 34.96 && a.body.pricing.shopRate.rate === 40.77);

  console.log("\n=== The screen ===");
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){
    if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs));
    const local = new URL(url).pathname.match(/^\/vendor\/fonts\/[a-z0-9.-]+$/);
    return local ? Promise.resolve(fs.readFileSync(__dirname + "/public" + local[0])) : super.fetch(url, o); } }
  const dom = new JSDOM(storefrontPage(), { runScripts: "dangerously", resources: new L(), url: "https://admin.acme.test/", pretendToBeVisual: true,
    beforeParse(win){ win.fetch = async (url, opts) => {
      if (String(url).includes("/api/orders")) { const r = await call(JSON.parse(opts.body)); return { ok: r.status < 300, status: r.status, json: async () => r.body }; }
      return { ok: true, status: 200, json: async () => ({ status: "error", message: "n/a" }) }; }; win.confirm = () => true; } });
  const w = dom.window, doc = w.document, tick = (ms) => new Promise(res => setTimeout(res, ms || 50));
  await tick(200); await w.loadAdminScript(); await tick(100);
  w.eval('adminKey = "x"; adminCan_ = () => true;');
  ok("Finance has a Shop rate item, for admins", w.eval("JSON.stringify(ADMIN_NAV_GROUPS)").includes('["shoprate","Shop rate"]') && pageLowest("#shoprate") === "admin");
  const app = doc.createElement("div"); doc.body.appendChild(app);
  await w.renderShopRate(app); await tick(100);
  const $ = (id) => doc.getElementById(id);
  ok("it shows each category, equipment, your pay, the hours and the saved rate", doc.querySelectorAll("#srRunning tr[data-cat]").length >= 4 && doc.querySelectorAll("#srEquipment tr[data-exp]").length === 2 &&
    $("srPay").value === "30000" && $("srHours").value === "20" && $("srRate").textContent === "$40.77" && /Saved/.test($("srSaved").textContent));
  ok("an overridden figure is marked ✎", /✎/.test(doc.querySelector(`#srRunning tr[data-cat="${cat("Insurance")}"]`).textContent));
  $("srHours").value = "40"; $("srHours").dispatchEvent(new w.Event("input", { bubbles: true })); await tick(600);
  ok("changing the hours works the rate out again (not saved yet)", $("srHoursTotal").textContent === "1920" && $("srRate").textContent !== "$40.77");
  const ins = doc.querySelector(`#srRunning tr[data-cat="${cat("Insurance")}"] .sr-inc`);
  ins.checked = false; ins.dispatchEvent(new w.Event("change", { bubbles: true })); await tick(600);
  ok("unticking a category leaves it out", doc.querySelector(`#srRunning tr[data-cat="${cat("Insurance")}"] .sr-counted`).textContent === "—");
  $("srSave").click(); await tick(300);
  const saved = await lib.getShopRate(d1);
  ok("Save stores what's on the page", saved.hoursPerWeek === 40 && saved.categories[cat("Insurance")].excluded === true);
  const pricing = await lib.analyzePricing(d1, { orgId: "acme" });
  const table = w.pricingTableHtml_(pricing.products.find(x => x.productId === "cap"), pricing.settings);
  ok("the price analysis table has an Overhead column", />Overhead</.test(table));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
