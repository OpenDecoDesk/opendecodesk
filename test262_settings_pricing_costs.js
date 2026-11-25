// Global settings → Pricing is costs, so it follows Money, costs and margins (costs.view; review #88). A user who may
// edit Global settings without costs.view used to get the Pricing boxes filled with the page's defaults (2.9% + $0.30,
// no supplies, no targets — the real figures were refused to them) and every Save sent those defaults back, overwriting
// the shop's real fees and targets. Now the page shows and sends Pricing only for a role with costs.view and only once
// the real figures have loaded; the server's side (refusing it, and the below-target list) is in test247.
// The real admin page in jsdom, signed in as a built-in role (testlib/roles asRole), with a stand-in server.
const fs = require("fs");
const { storefrontPage } = require("./testlib/storefront-page");
const { asRole } = require("./testlib/roles");
const { JSDOM, ResourceLoader } = require("jsdom");

let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const tick = (ms) => new Promise(r => setTimeout(r, ms || 40));

(async () => {
  const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
  const adminJs = read("public/admin.js");
  const calls = [];
  let saved = null, pricingRefused = false;
  class L extends ResourceLoader { fetch(url, o) { if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return Promise.resolve(Buffer.from("")); } }
  // A fresh page for each case (a save moves the page on to Manage catalog).
  const page = () => new JSDOM(storefrontPage(), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win) {
      win.fetch = async (url, opts) => {
        const body = opts && opts.body ? JSON.parse(opts.body) : {};
        const j = (x, status) => ({ ok: !status, status: status || 200, json: async () => x });
        if (!body.action) return j({ status: "admin", business: {}, country: "US" });
        calls.push(body.action);
        if (body.action === "getGlobalSettings") return j({ status: "ok", globalSettings: { enabledPayments: {} } });
        if (body.action === "getFeatures") return j({ status: "ok", list: [{ key: "shipping", label: "Shipping", description: "Carrier shipping." }], features: { shipping: false }, locked: [], shippoKey: false });
        if (body.action === "getLocaleSettings") return j({ status: "ok", locale: { timeZone: "", country: "US" }, effectiveTimeZone: "America/Chicago", envTimeZone: "America/Chicago" });
        if (body.action === "getSalesTaxSettings") return j({ status: "ok", salesTax: { ratePercent: 6, jurisdiction: "OH", taxMode: "inclusive" } });
        if (body.action === "getRushSettings") return j({ status: "ok", rush: { rule: { mode: "off" }, taxable: false } });
        if (body.action === "getBusinessProfile") return j({ status: "ok", business: {} });
        if (body.action === "getPricingSettings") return pricingRefused ? j({ status: "error", code: "forbidden", message: "Your role can't do this." }, 403)
          : j({ status: "ok", pricing: { cardPct: 3.4, cardFixed: 0.45, supplies: 1.25, targetHourly: 40, targetIncome: 8 } });
        if (body.action === "saveGlobalSettingsAll") { saved = body.settings; return j({ status: "ok", settings: { ...body.settings, business: {} }, belowTarget: [] }); }
        return j({ status: "error", message: "n/a" });
      };
    } });
  // Renders Global settings as `role` (with `perms` on top), then saves it unchanged: what was fetched, shown and sent.
  const openAndSave = async (role, perms) => {
    const dom = page(), w = dom.window, d = w.document;
    await tick(150);
    await w.loadAdminScript();
    w.eval('adminKey = "cookie";');
    w.eval(asRole(role));
    if (perms) w.eval(`adminPerms = Object.assign({}, adminPerms, ${JSON.stringify(perms)});`);
    calls.length = 0; saved = null;
    await w.renderGlobalSettings(d.getElementById("app")); await tick(80);
    const fetched = calls.includes("getPricingSettings");
    const box = d.getElementById("gPriceCardPct");
    const heading = [...d.querySelectorAll("#adminPanel h2")].some(h => h.textContent.trim() === "Pricing");
    await w.submitGlobalSettings(); await tick();
    return { fetched, shown: !!box && heading, value: box && box.value, saved };
  };

  console.log("=== A role with costs.view: Pricing as it is, saved as it is ===");
  let r = await openAndSave("admin");
  ok("an admin's page loads Pricing and shows the real figures", r.fetched && r.shown && r.value === "3.4");
  ok("…and Save sends them back unchanged", r.saved && r.saved.pricing && r.saved.pricing.cardPct === "3.4" && r.saved.pricing.supplies === "1.25" && r.saved.pricing.targetIncome === "8");

  console.log("\n=== Global settings Edit without costs.view ===");
  r = await openAndSave("admin", { "costs.view": "none" });
  ok("Pricing isn't asked for, and isn't on the page", !r.fetched && !r.shown);
  ok("…and Save sends no Pricing — so the shop's real fees and targets aren't overwritten with the defaults", r.saved && !("pricing" in r.saved) && "rush" in r.saved);

  console.log("\n=== Pricing that didn't load ===");
  pricingRefused = true;
  r = await openAndSave("admin");
  ok("a refused or failed Pricing load leaves the section off the page", r.fetched && !r.shown);
  ok("…and out of the save (the defaults are never sent as if they were the shop's)", r.saved && !("pricing" in r.saved));
  pricingRefused = false;

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch(e => { console.log("test262 crashed:", false); console.error(e); process.exit(1); });
