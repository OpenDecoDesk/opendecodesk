const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// Global settings → Save is one request, saved all or nothing (review #73): saveGlobalSettingsAll checks every
// section's permission and feature, runs every section's check (db.js build…Settings) and only then writes them
// all in one db.batch. A refusal anywhere — or a write that fails part-way — saves nothing. The side effects
// (audit entries, the catalog refresh, the pricing check) happen once, after the write. The old per-section
// actions, which other screens and the desktop program still call, keep working through the same build steps.
// Real SQL (sql.js) + real db.js, permissions.js and orders.js; the sign-in gate stubbed as test242 does. Invented data only.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  strip(read("functions/_lib/permissions.js")) + "\n" +
  "const __as = { role: null }; const __seen = { invalidated: 0 };\n" +
  "const requireAdmin = async (env, host, key, request, msg, need) => !__as.role || roleAllows(__as.role, need) ? null : new Response(JSON.stringify({ status: 'error', code: 'forbidden', message: 'Your role can\\'t do this.' }), { status: 403 });\n" +
  "const adminActor = () => 'pat@example.test';\n" +
  "const adminUser = () => __as.role ? { id: 7, role: __as.role.key, roleInfo: __as.role } : null;\n" +
  "const adminCan = (request, fn, level) => !__as.role || permRank(effectiveLevel(__as.role, fn)) >= permRank(level || 'read');\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => { __seen.invalidated++; }; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendShippingPaymentEmail = async () => true; const sendCancellationEmail = async () => true; const vendorCredentialsReady = () => false;\n" +
  strip(read("functions/_lib/db.js")) + "\n" + strip(read("functions/api/orders.js")) +
  "\nreturn { post: onRequestPost, as: __as, seen: __seen, ACTION_PERM, NO_MONTH_ACTIONS, CATALOG_ADMIN_ACTIONS, normalizePermissions, lib: { getLocaleSettings, getFeatures, getShipFromAddress, getGlobalSettings, getSalesTaxSettings, getAccountingSettings, getBusinessProfile, getEmailSettings, getDigitalSettings, getMachineSettings, getPricingSettings, getRushSettings } };")();

let failed = 0, passed = 0;
const ok = (label, cond) => { cond ? passed++ : failed++; console.log(label + ": " + !!cond); };

async function migratedDb() {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  return d1;
}
const role = (key, fns) => ({ key, name: key, rank: 10, locked: false, builtIn: false, permissions: api.normalizePermissions({ fns }) });

(async () => {
  const d1 = await migratedDb();
  const env = { DB: d1, ROOT_DOMAIN: "example.com", SHIPPO_API_KEY: "shippo_test_example" };
  const pending = [];
  const call = async (body, as = null) => {
    api.as.role = as;
    const full = Object.assign({ key: "x" }, body);
    const req = { url: "https://admin.example.com/api/orders", json: async () => full, clone: () => ({ json: async () => full }), headers: { get: () => null } };
    const res = await api.post({ env, waitUntil: (p) => pending.push(p), request: req });
    await Promise.all(pending.splice(0));
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const q = (sql) => d1._raw.exec(sql)[0] ? d1._raw.exec(sql)[0].values : [];
  // Everything a save could touch: the settings rows (but the list cache's versions, which a change's answer moves on
  // its own), the audit log and the catalog version.
  const snapshot = () => JSON.stringify({ settings: q("SELECT key, value FROM global_settings WHERE key NOT LIKE 'listCache%' ORDER BY key"), audit: q("SELECT count(*) FROM audit_log") });
  const version = () => Number((q("SELECT value FROM global_settings WHERE key = 'catalogVersion'")[0] || [0])[0]) || 0;
  const audits = (action) => q(`SELECT detail FROM audit_log WHERE action = '${action}' ORDER BY id`).map(r => JSON.parse(r[0] || "null"));
  const t = "2026-11-02T15:00:00.000Z";
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Example Club','${t}','${t}');
    INSERT INTO products (productId, orgId, type, name, pricingMode, flatPriceCents, createdAt, updatedAt, transferCostCents, suppliesCostCents, visible)
      VALUES ('tee','acme','Tee','Club tee','flat',2000,'${t}','${t}',350,125,1);`);
  // Shipping starts off, so switching it on below needs the key (env) and a complete ship-from address.
  await call({ action: "updateFeatures", features: { shipping: false } });

  const shipFrom = { name: "Example Stitch", street1: "12 Elm St", city: "Columbus", state: "OH", zip: "43004", phone: "614-555-0100", email: "ship@example.test" };
  const all = () => ({
    locale: { timeZone: "America/Chicago", country: "US" },
    features: { shipping: true, production: true, digital: true },
    shipFrom: { ...shipFrom },
    payments: { card: true, venmo: false, zelle: true, check: false },
    salesTax: { ratePercent: 7.25, jurisdiction: "oh", taxMode: "exclusive" },
    accounting: { saleDate: "placed" },
    business: { name: "Example Stitch Co", supportEmail: "help@example.test", venmo: "@example-stitch", website: "example.test" },
    email: { attachPdf: false },
    digital: { days: 14, downloads: 3, email: true, attach: false, attachMb: 8 },
    machine: { showDeleteButton: true },
    pricing: { cardPct: "3.1", cardFixed: "0.35", supplies: "0.50", targetHourly: "45", targetIncome: "" },
    rush: { rule: { mode: "fixed", amount: 15 }, taxable: true },
  });

  console.log("=== One request saves every section ===");
  {
    const v0 = version(), inv0 = api.seen.invalidated, audit0 = q("SELECT count(*) FROM audit_log")[0][0];
    const r = await call({ action: "saveGlobalSettingsAll", settings: all() });
    ok("the save is answered ok, naming the sections it saved", r.status === 200 && r.body.status === "ok" && r.body.sections.length === 11 && r.body.sections.includes("Rush fee"));
    const L = api.lib;
    ok("Region saved", JSON.stringify(await L.getLocaleSettings(d1)) === JSON.stringify({ timeZone: "America/Chicago", country: "US" }));
    const f = await L.getFeatures(d1);
    ok("Features saved (Shipping on, with its ship-from address)", f.shipping === true && f.production === true && (await L.getShipFromAddress(d1)).street1 === "12 Elm St");
    ok("payment methods saved", JSON.stringify((await L.getGlobalSettings(d1)).enabledPayments) === JSON.stringify({ card: true, venmo: false, zelle: true, check: false }));
    const tax = await L.getSalesTaxSettings(d1);
    ok("sales tax saved (the state upper-cased, as its own action does)", tax.rateBps === 725 && tax.jurisdiction === "OH" && tax.taxMode === "exclusive");
    ok("bookkeeping saved", (await L.getAccountingSettings(d1)).saleDate === "placed");
    const biz = await L.getBusinessProfile(d1);
    ok("business profile saved, cleaned as its own action cleans it", biz.name === "Example Stitch Co" && biz.venmo === "example-stitch" && biz.website === "https://example.test");
    ok("email and digital-product settings saved", (await L.getEmailSettings(d1)).attachPdf === false && (await L.getDigitalSettings(d1)).days === 14 && (await L.getDigitalSettings(d1)).attach === false);
    ok("machine settings saved", (await L.getMachineSettings(d1)).showDeleteButton === true);
    const pr = await L.getPricingSettings(d1);
    ok("pricing saved, in cents and basis points", pr.cardPctBps === 310 && pr.cardFixedCents === 35 && pr.suppliesCents === 50 && pr.targetHourlyCents === 4500 && pr.targetIncomeCents === null);
    const rush = await L.getRushSettings(d1);
    ok("rush fee saved", rush.rule.mode === "fixed" && rush.rule.amountCents === 1500 && rush.taxable === true);
    ok("a Region save sends back the time zone now in force (the page shows dates on it at once)", r.body.effectiveTimeZone === "America/Chicago");
    ok("the answer carries what was saved (the page applies the country, switches and business at once)", r.body.settings.locale.country === "US" && r.body.settings.features.shipping === true &&
      r.body.settings.business.name === "Example Stitch Co" && r.body.settings.salesTax.ratePercent === 7.25 && r.body.settings.rush.rule.amount === 15 && Array.isArray(r.body.belowTarget));

    console.log("\n=== The side effects, once, after the write ===");
    ok("the catalog moves on one version, and its cached version is dropped once", version() === v0 + 1 && api.seen.invalidated === inv0 + 1);
    const each = ["settings.locale_set", "settings.features_set", "settings.ship_from_set", "settings.business_set", "settings.sales_tax_set", "settings.accounting_set",
      "settings.email_set", "settings.digital_set", "settings.machine_set", "settings.pricing_set", "settings.rush_fee_set"];
    const counts = each.map(a => q(`SELECT count(*) FROM audit_log WHERE id > ${audit0} AND action = '${a}'`)[0][0]);
    ok("one audit entry per section that has one, as its own action writes it", counts.every(n => n === 1) && q(`SELECT count(*) FROM audit_log WHERE id > ${audit0}`)[0][0] === each.length);
    const feat = audits("settings.features_set").pop(), tx = audits("settings.sales_tax_set").pop(), loc = audits("settings.locale_set").pop();
    ok("…with the same details: the switches changed, tax from → to, the region's changes", feat.changes.shipping.from === false && feat.changes.shipping.to === true &&
      tx.from.rateBps === 0 && tx.to.rateBps === 725 && tx.to.jurisdiction === "OH" && loc.changes.timeZone.to === "America/Chicago" && !("country" in loc.changes));
    ok("the actor is on every entry", q(`SELECT count(*) FROM audit_log WHERE id > ${audit0} AND actor = 'pat@example.test'`)[0][0] === each.length);
    ok("the pricing check ran: the tee is below the new target or not, but the list came back", Array.isArray(r.body.belowTarget));
  }

  console.log("\n=== A refusal in any section saves nothing ===");
  {
    const bad = {
      locale: (s) => { s.locale.timeZone = "Nowhere/Land"; },
      features: (s) => { s.features.teleport = true; },
      shipFrom: (s) => { s.features.shipping = true; s.shipFrom.zip = "4300"; },
      salesTax: (s) => { s.salesTax.ratePercent = 20; },
      accounting: (s) => { s.accounting.saleDate = "someday"; },
      business: (s) => { s.business.supportEmail = "not-an-email"; },
      pricing: (s) => { s.pricing.cardPct = "50"; },
      rush: (s) => { s.rush.rule = { mode: "fixed", amount: 5000 }; },
    };
    const label = { locale: "Region", features: "Features", shipFrom: "Features", salesTax: "Sales tax", accounting: "Bookkeeping", business: "Business profile", pricing: "Pricing", rush: "Rush fee" };
    // Turn Shipping off first, so the ship-from check (made when Shipping is switched on) applies.
    await call({ action: "updateFeatures", features: { shipping: false } });
    for (const [k, spoil] of Object.entries(bad)) {
      const s = all(); s.locale.timeZone = "Europe/London"; s.salesTax.ratePercent = 5; s.business.name = "Changed name"; spoil(s);
      const before = snapshot(), v0 = version(), inv0 = api.seen.invalidated;
      const r = await call({ action: "saveGlobalSettingsAll", settings: s });
      ok(`a bad ${k} is refused, naming ${label[k]}, and nothing at all is saved — no other section, no audit entry, no catalog refresh`,
        r.status === 400 && r.body.status === "error" && r.body.section === label[k] && !!r.body.message && snapshot() === before && version() === v0 && api.seen.invalidated === inv0);
    }
    const s = all(); s.locale.country = "OTHER"; s.salesTax.jurisdiction = "Ontario"; s.features.shipping = false; delete s.shipFrom;
    const r = await call({ action: "saveGlobalSettingsAll", settings: s });
    ok("the tax home state is checked against the country saved in the same request (Ontario is fine outside the US)", r.status === 200 && (await api.lib.getSalesTaxSettings(d1)).jurisdiction === "Ontario");
    const s2 = all(); s2.locale.country = "US"; s2.salesTax.jurisdiction = "Ontario"; s2.features.shipping = false; delete s2.shipFrom;
    const before = snapshot();
    const r2 = await call({ action: "saveGlobalSettingsAll", settings: s2 });
    ok("…and switching back to the US with a free-text state is refused, the country included", r2.status === 400 && r2.body.section === "Sales tax" && snapshot() === before && (await api.lib.getLocaleSettings(d1)).country === "OTHER");
    await call({ action: "updateLocaleSettings", locale: { timeZone: "America/Chicago", country: "US" } });
    await call({ action: "updateSalesTaxSettings", ratePercent: 7.25, jurisdiction: "OH", taxMode: "exclusive" });
    const r3 = await call({ action: "saveGlobalSettingsAll", settings: { pricing: { cardPct: "2.9", cardFixed: "0.30", supplies: "0" }, nonsense: {} } });
    ok("a part that isn't Global settings is refused", r3.status === 400 && /isn't a part of Global settings/.test(r3.body.message));
    ok("…and so is a request with nothing to save", (await call({ action: "saveGlobalSettingsAll", settings: {} })).status === 400);
  }

  console.log("\n=== A write that fails part-way saves nothing ===");
  {
    const realBatch = d1.batch.bind(d1);
    d1.batch = (stmts) => realBatch([...stmts, d1.prepare("INSERT INTO no_such_table (x) VALUES (1)")]);
    const before = snapshot(), v0 = version();
    const s = all(); s.business.name = "Never saved"; delete s.shipFrom; s.features.shipping = false;
    const logged = [], realError = console.error; console.error = (...a) => logged.push(a.join(" "));
    const r = await call({ action: "saveGlobalSettingsAll", settings: s });
    d1.batch = realBatch; console.error = realError;
    ok("the database refusing the last statement rolls back every section, and says nothing was saved", r.status === 503 && /Nothing was saved/.test(r.body.message) &&
      snapshot() === before && version() === v0 && (await api.lib.getBusinessProfile(d1)).name === "Example Stitch Co" && logged.some(l => /nothing was saved/.test(l)));
  }

  console.log("\n=== Features: a section whose feature is off is refused, as its own action is ===");
  {
    const s = { features: { production: false }, machine: { showDeleteButton: false } };
    const before = snapshot();
    const r = await call({ action: "saveGlobalSettingsAll", settings: s });
    ok("switching Production off while saving its Machine Files setting is refused, and Production stays on", r.status === 403 && r.body.section === "Machine settings" && r.body.feature === "production" &&
      snapshot() === before && (await api.lib.getFeatures(d1)).production === true);
    await call({ action: "updateFeatures", features: { production: false } });
    const r2 = await call({ action: "saveGlobalSettingsAll", settings: { features: { production: true }, machine: { showDeleteButton: false } } });
    ok("…and switching it on in the same save lets it through", r2.status === 200 && (await api.lib.getFeatures(d1)).production === true && (await api.lib.getMachineSettings(d1)).showDeleteButton === false);
  }

  console.log("\n=== Permissions: each section needs what its own action needs ===");
  {
    const viewer = role("viewer", { "settings.global": "read" });
    const editor = role("editor", { "settings.global": "edit" });
    const s = all(); delete s.shipFrom; s.features.shipping = true; s.business.name = "Role test";
    let before = snapshot();
    let r = await call({ action: "saveGlobalSettingsAll", settings: s }, viewer);
    ok("a role that can only look at Global settings is refused, nothing saved", r.status === 403 && snapshot() === before);
    r = await call({ action: "saveGlobalSettingsAll", settings: s }, role("nobody", {}));
    ok("…and so is a role without it at all", r.status === 403 && snapshot() === before);
    // One section's action needing something else (as pricing would if it moved to Finance): the role has Global
    // settings but not that, so the whole save is refused, naming the section.
    const keep = api.ACTION_PERM.updatePricingSettings;
    api.ACTION_PERM.updatePricingSettings = [["finance.shoprate", "edit"]];
    r = await call({ action: "saveGlobalSettingsAll", settings: s }, editor);
    ok("a role lacking one section's permission is refused, naming it, with nothing saved", r.status === 403 && r.body.code === "forbidden" && /Pricing/.test(r.body.message) && !/Region/.test(r.body.message) &&
      snapshot() === before && (await api.lib.getBusinessProfile(d1)).name !== "Role test");
    const noPricing = { ...s }; delete noPricing.pricing;
    r = await call({ action: "saveGlobalSettingsAll", settings: noPricing }, editor);
    ok("…the same role saves the sections it may change", r.status === 200 && (await api.lib.getBusinessProfile(d1)).name === "Role test");
    r = await call({ action: "saveGlobalSettingsAll", settings: s }, role("both", { "settings.global": "edit", "finance.shoprate": "edit" }));
    ok("…and a role with both saves everything", r.status === 200);
    api.ACTION_PERM.updatePricingSettings = keep;
    ok("it is listed with Global settings' edit actions, and as touching no month's numbers", JSON.stringify(api.ACTION_PERM.saveGlobalSettingsAll) === JSON.stringify([["settings.global", "edit"]]) &&
      api.NO_MONTH_ACTIONS.has("saveGlobalSettingsAll") && api.CATALOG_ADMIN_ACTIONS.has("saveGlobalSettingsAll"));
  }

  console.log("\n=== The per-section actions still work, through the same build steps ===");
  {
    const L = api.lib;
    let r = await call({ action: "updateLocaleSettings", locale: { timeZone: "Asia/Tokyo", country: "US" } });
    ok("updateLocaleSettings", r.status === 200 && (await L.getLocaleSettings(d1)).timeZone === "Asia/Tokyo");
    r = await call({ action: "updateLocaleSettings", locale: { timeZone: "Nowhere/Land" } });
    ok("…and its refusal", r.status === 400 && /isn't a time zone/.test(r.body.message));
    r = await call({ action: "updateFeatures", features: { bookkeeping: false } });
    ok("updateFeatures", r.status === 200 && (await L.getFeatures(d1)).bookkeeping === false && audits("settings.features_set").pop().changes.bookkeeping.to === false);
    await call({ action: "updateFeatures", features: { bookkeeping: true, shipping: false } });
    r = await call({ action: "updateFeatures", features: { shipping: true }, shipFrom: { ...shipFrom, phone: "" } });
    ok("…and its Shipping check", r.status === 400 && r.body.code === "shipping_setup" && /Phone/.test(r.body.message));
    r = await call({ action: "updateGlobalSettings", globalSettings: { enabledPayments: { card: false, venmo: true, zelle: true, check: true } } });
    ok("updateGlobalSettings", r.status === 200 && (await L.getGlobalSettings(d1)).enabledPayments.card === false);
    r = await call({ action: "updateSalesTaxSettings", ratePercent: 6, jurisdiction: "pa" });
    ok("updateSalesTaxSettings", r.status === 200 && r.body.salesTax.rateBps === 600 && r.body.salesTax.jurisdiction === "PA" && Array.isArray(r.body.belowTarget));
    r = await call({ action: "updateSalesTaxSettings", ratePercent: 6, jurisdiction: "Penn" });
    ok("…and its refusal", r.status === 400 && r.body.message === "Jurisdiction must be a 2-letter state code");
    r = await call({ action: "updateAccountingSettings", saleDate: "shipped" });
    ok("updateAccountingSettings", r.status === 200 && (await L.getAccountingSettings(d1)).saleDate === "shipped");
    r = await call({ action: "updateAccountingSettings", saleDate: "never" });
    ok("…and its refusal", r.status === 400 && /Choose when a sale counts/.test(r.body.message));
    r = await call({ action: "updateBusinessProfile", business: { name: "Solo save" } });
    ok("updateBusinessProfile", r.status === 200 && (await L.getBusinessProfile(d1)).name === "Solo save");
    r = await call({ action: "updateEmailSettings", emailSettings: { attachPdf: true } });
    ok("updateEmailSettings", r.status === 200 && (await L.getEmailSettings(d1)).attachPdf === true);
    r = await call({ action: "updateDigitalSettings", digital: { days: 30 } });
    ok("updateDigitalSettings", r.status === 200 && (await L.getDigitalSettings(d1)).days === 30);
    r = await call({ action: "updateMachineSettings", machineSettings: { showDeleteButton: true } });
    ok("updateMachineSettings", r.status === 200 && r.body.machineSettings.showDeleteButton === true);
    r = await call({ action: "updatePricingSettings", pricing: { cardPct: "2.9", cardFixed: "0.30", supplies: "0.25", targetHourly: "", targetIncome: "" } });
    ok("updatePricingSettings", r.status === 200 && (await L.getPricingSettings(d1)).cardPctBps === 290 && (await L.getPricingSettings(d1)).suppliesCents === 25);
    r = await call({ action: "updatePricingSettings", pricing: { cardPct: "2.9", cardFixed: "", supplies: "0" } });
    ok("…and its refusal", r.status === 400 && /Fill in every fee field/.test(r.body.message));
    r = await call({ action: "updateRushSettings", rush: { rule: { mode: "percent", pct: 10 }, taxable: false } });
    ok("updateRushSettings", r.status === 200 && (await L.getRushSettings(d1)).rule.pctBps === 1000);
    r = await call({ action: "updateShipFromAddress", shipFrom: { ...shipFrom, street1: "9 Oak Ave" } });
    ok("updateShipFromAddress", r.status === 200 && (await L.getShipFromAddress(d1)).street1 === "9 Oak Ave");
  }

  console.log("\n=== The page sends one request ===");
  {
    const adminJs = read("public/admin.js");
    const fn = adminJs.slice(adminJs.indexOf("async function submitGlobalSettings(){"), adminJs.indexOf("// ---- QR code library lazy loader ----"));
    const actions = [...fn.matchAll(/action: "(\w+)"/g)].map(m => m[1]);
    ok("submitGlobalSettings sends saveGlobalSettingsAll, and apart from it only the mailbox check and the mailbox itself", actions.filter(a => a === "saveGlobalSettingsAll").length === 1 &&
      actions.every(a => ["saveGlobalSettingsAll", "checkMailbox", "updateEmailSettings"].includes(a)));
    ok("…the mailbox (its password) after the rest is saved, never with it", fn.indexOf('action: "updateEmailSettings"') > fn.indexOf('action: "saveGlobalSettingsAll"') && /updateEmailSettings", mailbox: mailboxChange \}/.test(fn));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); console.log("test crashed: false"); process.exit(1); });
