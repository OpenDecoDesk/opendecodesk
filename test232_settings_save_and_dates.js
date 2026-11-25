// Global settings saves every section in one request (saveGlobalSettingsAll, all or nothing): a rush-fee rule that
// can't be saved is caught before anything is sent, and a section the server refuses means nothing was saved, the
// refusal naming that section.
// Also: the admin's "today" is the local day everywhere (not the UTC one, which is tomorrow in a US evening).
const fs = require("fs");
const { storefrontPage } = require("./testlib/storefront-page");
const { JSDOM, ResourceLoader } = require("jsdom");

const ok = (d, v) => console.log(d + ":", !!v);
const tick = (ms) => new Promise(r => setTimeout(r, ms || 40));

(async () => {
  const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
  const adminJs = read("public/admin.js"), html = storefrontPage();
  const calls = [];
  let failPricing = false;
  class L extends ResourceLoader { fetch(url, o) { if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return Promise.resolve(Buffer.from("")); } }
  const dom = new JSDOM(html, { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
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
        if (body.action === "getRushSettings") return j({ status: "ok", rush: { rule: { mode: "fixed", amount: 15 }, taxable: false } });
        if (body.action === "getBusinessProfile") return j({ status: "ok", business: {} });
        if (body.action === "saveGlobalSettingsAll" && failPricing) return j({ status: "error", section: "Pricing", message: "The card fee must be 0 to 10%." }, 400);
        if (body.action === "saveGlobalSettingsAll") return j({ status: "ok", settings: { ...body.settings, business: {} }, belowTarget: [] });
        if (body.action === "updateFeatures") return j({ status: "ok", features: body.features });
        if (/^update/.test(body.action)) return j({ status: "ok", business: {}, locale: { country: "US" }, salesTax: {}, features: {}, globalSettings: {} });
        return j({ status: "error", message: "n/a" });
      };
    } });
  const w = dom.window, d = w.document;
  await tick(150);
  await w.loadAdminScript();
  w.eval('adminKey = "cookie";');
  w.renderGlobalSettings(d.getElementById("app")); await tick(80);
  const err = () => d.getElementById("globalSettingsError").textContent;

  console.log("=== A bad rush rule stops the save before anything is sent ===");
  ok("(the rush fee rule is on the page)", !!d.getElementById("gRushMode") && !!d.getElementById("gRushAmount"));
  d.getElementById("gRushAmount").value = "5000";
  calls.length = 0;
  await w.submitGlobalSettings(); await tick();
  ok("an out-of-range rush fee is refused with nothing saved", /^Nothing was saved\. Rush fee: Enter the rush fee/.test(err()) && !calls.some(a => /^update|^saveGlobal/.test(a)));
  ok("…its box is outlined", /solid/.test(d.getElementById("gRushAmount").style.outline));

  console.log("\n=== One request; a section the server refuses means nothing was saved ===");
  d.getElementById("gRushAmount").value = "15";
  failPricing = true; calls.length = 0;
  await w.submitGlobalSettings(); await tick();
  ok("Save sends every section in one request, and nothing else", calls.filter(a => /^update|^saveGlobal/.test(a)).join() === "saveGlobalSettingsAll");
  ok("a refusal says nothing was saved, naming the section and why", /^Nothing was saved\. Pricing: The card fee must be 0 to 10%\. Fix it and save again\.$/.test(err()));

  console.log("\n=== Unsaved changes are guarded; Save and Discard stay on Global settings (#110) ===");
  failPricing = false;
  w.renderGlobalSettings(d.getElementById("app")); await tick(80);
  const until = async (test) => { for (let i = 0; i < 80 && !test(); i++) await tick(25); return test(); };
  ok("a freshly drawn page has nothing unsaved", w._prodFormDirty === false && w.location.hash === "#settings");
  const rate = d.getElementById("gTaxRate");
  rate.value = "7.25"; rate.dispatchEvent(new w.Event("input", { bubbles: true }));
  ok("typing in the form marks the page as changed", w._prodFormDirty === true);
  w._prodFormDirty = false;
  d.getElementById("gPayVenmo").click();
  ok("…so does ticking a box", w._prodFormDirty === true);
  w._prodFormDirty = false;
  const alone = d.createElement("div"); alone.setAttribute("data-no-dirty", ""); alone.innerHTML = `<input id="t232Alone">`;
  d.querySelector("#adminPanel .admin-form").appendChild(alone);
  d.getElementById("t232Alone").dispatchEvent(new w.Event("input", { bubbles: true }));
  ok("a part that saves on its own (data-no-dirty) doesn't", w._prodFormDirty === false);
  ok("…supplier connections are such a part", /<div data-no-dirty id="gSuppliersBody">/.test(adminJs));
  rate.value = "7.25"; rate.dispatchEvent(new w.Event("input", { bubbles: true }));
  w.location.hash = "#orders";
  ok("leaving with a change asks first, and the page stays", await until(() => /Leave without saving\?/.test(d.body.textContent) && !!d.getElementById("cmOk")) && w.location.hash === "#settings" && !!d.getElementById("gTaxRate"));
  d.getElementById("cmCancel").click(); await tick();
  ok("…Stay keeps the change", d.getElementById("gTaxRate").value === "7.25" && w._prodFormDirty === true);
  ok("the Cancel button is now Discard changes", d.getElementById("gDiscardChanges").textContent === "Discard changes" && !d.querySelector('#adminPanel [data-admin-action="goCatalog_"]'));
  d.getElementById("gDiscardChanges").click();
  ok("Discard changes asks first when something changed", await until(() => /Discard your changes\?/.test(d.body.textContent) && !!d.getElementById("cmOk")));
  d.getElementById("cmOk").click();
  ok("…then draws the page again from what is saved, still on Global settings", await until(() => d.getElementById("gTaxRate") && d.getElementById("gTaxRate").value === "6") &&
    w.location.hash === "#settings" && w._prodFormDirty === false);
  d.getElementById("gTaxRate").value = "6.5"; d.getElementById("gTaxRate").dispatchEvent(new w.Event("input", { bubbles: true }));
  const toastText = () => [...d.querySelectorAll("#toastRegion .toast")].map(t => t.textContent).join(" | ");
  await w.submitGlobalSettings(); await tick(80);
  ok("a successful save clears the changed mark and stays on Global settings (not Manage catalog)", w._prodFormDirty === false && w.location.hash === "#settings" && !!d.getElementById("gTaxRate"));
  ok("…with the saved toast there", /Global settings saved\./.test(toastText()));

  console.log("\n=== Today is the local day ===");
  // In a US evening (UTC already tomorrow) the admin's today must still be today.
  const realDate = w.Date;
  const fixed = new realDate("2026-11-05T02:30:00Z");   // 8:30 PM on Nov 4 in Chicago
  w.eval(`(() => { const R = Date; const T = ${fixed.getTime()}; class D extends R { constructor(...a){ if (a.length) super(...a); else super(T); } static now(){ return T; } } window.Date = D; })()`);
  const tzDay = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(fixed);
  ok("localToday_() is the browser's own calendar day, not the UTC one", w.localToday_() === tzDay);
  // A report's To date has to reach the UTC day too: the server counts report days in UTC, so this evening's
  // runs and sales (already "tomorrow" in UTC) would be left out of a report that stops at the local day.
  ok("a report's default To covers what happened since UTC midnight (the later of the two days)", w.reportToDay_() === "2026-11-05" && tzDay <= w.reportToDay_());
  w.Date = realDate;
  ok("Revenue, Sales tax, Cost of goods and Run Times default their To to that day",
    /const defaultTo   = reportToDay_\(\);/.test(adminJs) && ["taxTo", "cogsTo", "rrTo"].every(id => new RegExp('id="' + id + '" value="\\$\\{reportToDay_\\(\\)\\}"').test(adminJs)));
  const code = adminJs.split("\n").filter(l => !/^\s*\/\//.test(l) && !/^function reportToDay_\(\)/.test(l)).join("\n");
  ok("no screen takes 'today' from the UTC date any more (except a report's To, above)", !/new Date\(\)\.toISOString\(\)\.slice\(0, ?10\)/.test(code));
  ok("the audit log's From / To are sent as the local day's bounds", /dateFrom:\s+localDayStartIso_\(/.test(adminJs) && /dateTo:\s+localDayEndIso_\(/.test(adminJs));
  ok("a step's time (ISO) shows as the local day, a plain day as written", w.adminShortDate_("2026-11-04") === "11/4/2026" &&
    w.adminShortDate_(new Date(2026, 10, 4, 21, 30).toISOString()) === "11/4/2026" && w.adminDay_(new Date(2026, 10, 4, 23, 50).toISOString()) === "2026-11-04");
  ok("…the order steps and design-approval cells use it", (adminJs.match(/adminShortDate_\((verif\.sentAt|verif\.respondedAt|dateStr)\)/g) || []).length === 3);
  ok("a local day's bounds cover that whole day here", w.localDayStartIso_("2026-11-04") === new Date(2026, 10, 4).toISOString() && w.localDayEndIso_("2026-11-04") === new Date(new Date(2026, 10, 5).getTime() - 1).toISOString() && w.localDayEndIso_("") === "");
  const db = read("functions/_lib/db.js");
  ok("…and the server uses a full time as it is (a plain day still runs to the end of the UTC day)", db.includes('params.push(/T/.test(dateTo) ? dateTo : dateTo + "T23:59:59.999Z")'));
  process.exit(0);
})().catch(e => { console.error(e); console.log("test crashed: false"); process.exit(1); });
