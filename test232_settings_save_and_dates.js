// Global settings saves part by part: a rush-fee rule that can't be saved is caught before anything is sent, and a
// part that fails half-way says which parts are already saved (and live) and which aren't.
// Also: the admin's "today" is the local day everywhere (not the UTC one, which is tomorrow in a US evening).
const fs = require("fs");
const { JSDOM, ResourceLoader } = require("jsdom");

const ok = (d, v) => console.log(d + ":", !!v);
const tick = (ms) => new Promise(r => setTimeout(r, ms || 40));

(async () => {
  const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
  const adminJs = read("public/admin.js"), html = read("public/index.html");
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
        if (body.action === "updatePricingSettings" && failPricing) return j({ status: "error", message: "The card fee must be 0 to 10%." }, 400);
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
  ok("an out-of-range rush fee is refused with nothing saved", /^Nothing was saved\. Rush fee: Enter the rush fee/.test(err()) && !calls.some(a => /^update/.test(a)));
  ok("…its box is outlined", /solid/.test(d.getElementById("gRushAmount").style.outline));

  console.log("\n=== A part that fails half-way says what is saved and what isn't ===");
  d.getElementById("gRushAmount").value = "15";
  failPricing = true; calls.length = 0;
  await w.submitGlobalSettings(); await tick();
  ok("the saved parts are named as saved and live", /^Saved \(already live\): Region, Features, Payment methods, Sales tax/.test(err()));
  ok("…and the failed part and the ones after it as not saved, with the reason", /Not saved: Pricing, Rush fee — The card fee must be 0 to 10%\./.test(err()) && !calls.includes("updateRushSettings"));

  console.log("\n=== Today is the local day ===");
  // In a US evening (UTC already tomorrow) the admin's today must still be today.
  const realDate = w.Date;
  const fixed = new realDate("2026-11-05T02:30:00Z");   // 8:30 PM on Nov 4 in Chicago
  w.eval(`(() => { const R = Date; const T = ${fixed.getTime()}; class D extends R { constructor(...a){ if (a.length) super(...a); else super(T); } static now(){ return T; } } window.Date = D; })()`);
  const tzDay = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(fixed);
  ok("localToday_() is the browser's own calendar day, not the UTC one", w.localToday_() === tzDay);
  w.Date = realDate;
  const code = adminJs.split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
  ok("no screen takes 'today' from the UTC date any more", !/new Date\(\)\.toISOString\(\)\.slice\(0, ?10\)/.test(code));
  ok("the audit log's From / To are sent as the local day's bounds", /dateFrom:\s+localDayStartIso_\(/.test(adminJs) && /dateTo:\s+localDayEndIso_\(/.test(adminJs));
  ok("a step's time (ISO) shows as the local day, a plain day as written", w.adminShortDate_("2026-11-04") === "11/4/2026" &&
    w.adminShortDate_(new Date(2026, 10, 4, 21, 30).toISOString()) === "11/4/2026" && w.adminDay_(new Date(2026, 10, 4, 23, 50).toISOString()) === "2026-11-04");
  ok("…the order steps and design-approval cells use it", (adminJs.match(/adminShortDate_\((verif\.sentAt|verif\.respondedAt|dateStr)\)/g) || []).length === 3);
  ok("a local day's bounds cover that whole day here", w.localDayStartIso_("2026-11-04") === new Date(2026, 10, 4).toISOString() && w.localDayEndIso_("2026-11-04") === new Date(new Date(2026, 10, 5).getTime() - 1).toISOString() && w.localDayEndIso_("") === "");
  const db = read("functions/_lib/db.js");
  ok("…and the server uses a full time as it is (a plain day still runs to the end of the UTC day)", db.includes('params.push(/T/.test(dateTo) ? dateTo : dateTo + "T23:59:59.999Z")'));
  process.exit(0);
})().catch(e => { console.error(e); console.log("test crashed: false"); process.exit(1); });
