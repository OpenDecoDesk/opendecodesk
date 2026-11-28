process.env.TZ = "UTC";
const fs = require("fs");
const { storefrontPage } = require("./testlib/storefront-page");
const { createD1 } = require("./testlib/d1-shim.js");
const { ok } = require("./testlib/check");
const roles = require("./testlib/roles");
const { JSDOM, ResourceLoader, VirtualConsole } = require("jsdom");

// Phase 7 in the admin pages (public/admin.js, public/admin-receivables.js, public/admin-garments.js,
// public/admin-customers.js), run in jsdom with the real orders.js / db.js on sql.js behind fetch (migrations/0121):
//   Global settings: the Net 30 (with a PO) payment tick, the Net 30 terms section (default days, Terms start), and the
//   Features row Customer-supplied garments with its waiver line;
//   an order: its Net 30 tag on the Orders list and card, the Paid cell, Net 30… and Accept PO by role, the Net 30
//   window (tick, days, PO, Accept PO, due date, its own refusals, taking an order off terms);
//   the Local sale: Net 30 with a PO and days, and the Customer's own garment tick (only with the feature on);
//   Edit items: the same tick, sent only when changed;
//   Check in garments… (per line: expected, received, condition, note; Save; Undo; the slip with the waiver; errors);
//   Reports → Unpaid POs: the menu and route by permission, as-of date, shop and customer filters, the group strip, the
//   per-customer table, the rows with order links, Accept PO by permission, the CSV (with the formula guard), escaping,
//   and a late answer that must not replace a newer one;
//   Home's Unpaid POs block and the New tile's POs to check, by role;
//   a customer's page: Allow Net 30 and Terms (days).
// Invented shops, people and PO numbers only. "Today" is fixed at 2026-12-15 on the page and asked for as such from the
// server; every stored time is noon UTC, so no day depends on this machine's date or time zone.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
globalThis.__f406 = {};
globalThis.__role406 = "admin";
const L = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async (env, host, key, request, msg, need) => roleAllows(DEFAULT_ROLES[globalThis.__role406] || null, need) ? null : jsonResponse({ status: 'error', message: 'Your role can\\'t do that here.' }, 403);\n" +
  "const adminActor = () => 'owner@example.test';\n" + roles.adminAs({ roleFrom: "globalThis.__role406" }) + "\n" + strip(read("functions/_lib/permissions.js")) + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: { club: 'club', school: 'school' }, orgs: {}, features: globalThis.__f406 });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false;\n" +
  "const sendInvoiceEmail = async () => false, sendEstimateEmail = async () => false, sendGiftCardEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  "const setMarketingChoice = async () => ({});\n" +
  strip(read("functions/_lib/db.js")) + "\n" + strip(read("functions/api/orders.js")) + "\nreturn { post: onRequestPost };")();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const pause = (ms) => new Promise(r => setTimeout(r, ms));
const wait = async (cond, n = 500) => { for (let i = 0; i < n && !cond(); i++) await pause(10); return !!cond(); };
process.on("unhandledRejection", (e) => { console.error(e); ok("nothing in the test was left to fail unseen", false); });
let finished = false;
process.on("exit", () => { if (!finished) { console.log("the test ran to its end: false"); process.exitCode = 1; } });
const TODAY = "2026-12-15";
const noon = (ymd) => ymd + "T12:00:00.000Z";

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const call = async (body) => {
    const waits = [];
    const res = await L.post({ env: { DB: d1, DESIGNS: {} }, waitUntil: (p) => waits.push(Promise.resolve(p).catch(() => {})),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    await Promise.all(waits);
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const must = async (body) => { const r = await call(body); if (r.status !== 200) throw new Error("seed " + body.action + ": " + JSON.stringify(r.body)); return r.body; };
  const orderRow = (id) => d1.q("SELECT * FROM orders WHERE orderId = ?", id)[0];
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('club','club','Example Club','t','t',1), ('school','school','Example School Shop','t','t',1);
    INSERT INTO customers (id, name, email, phone, createdAt, updatedAt) VALUES (1, 'Pat Example', 'pat@example.com', '555-0101', '2026-01-02T12:00:00.000Z', 't');
    INSERT INTO customers (id, name, company, email, createdAt, updatedAt, allowNet30, termsDays) VALUES (2, '', 'Example School District', 'ap@example.org', '2026-01-02T12:00:00.000Z', 't', 1, 45);`);
  for (const org of ["club", "school"])
    await must({ action: "createProduct", org, productId: "mug", type: "other", name: "Club Mug", pricingMode: "flat", flatPrice: 10, visible: true, weightOz: 10, noDesignNeeded: true });

  // ---- The page ---------------------------------------------------------------------------------------------------
  const adminJs = read("public/admin.js"), custJs = read("public/admin-customers.js"), recvJs = read("public/admin-receivables.js"), garmJs = read("public/admin-garments.js");
  const sent = [], toasts = [], served = [], blobs = [];
  let scripted = [];       // [{ action, status, body | throws | empty }]: the next request for that action is answered with this
  let hold = null;         // { action, gate }: the next request for that action waits for gate
  let failScript = null;   // a script name that can't be fetched
  let scriptGate = null;   // { name, gate }: that script arrives when gate settles
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
  class Loader extends ResourceLoader {
    fetch(url) {
      served.push(String(url));
      const name = (String(url).match(/\/([\w-]+\.js)(\?|$)/) || [])[1];
      if (name && name === failScript) return Promise.reject(new Error("offline"));
      if (scriptGate && name === scriptGate.name) { const g = scriptGate.gate; scriptGate = null; return g.then(() => Buffer.from(name === "admin-receivables.js" ? recvJs : garmJs)); }
      if (name === "admin-receivables.js") return Promise.resolve(Buffer.from(recvJs));
      if (name === "admin-garments.js") return Promise.resolve(Buffer.from(garmJs));
      if (name === "admin.js") return Promise.resolve(Buffer.from(adminJs));
      if (name === "admin-customers.js") return Promise.resolve(Buffer.from(custJs));
      return Promise.resolve(Buffer.from(""));
    }
  }
  const vc = new VirtualConsole();
  vc.sendTo(console, { omitJSDOMErrors: true });
  vc.on("jsdomError", (e) => { if (!/Not implemented|Could not load script/.test(e.message)) console.error(e); });
  let inflight = 0;
  const dom = new JSDOM(storefrontPage(), { runScripts: "dangerously", resources: new Loader(), virtualConsole: vc, url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win) {
      win.CSS = win.CSS || { escape: (s) => String(s).replace(/["\\]/g, "\\$&") };
      win.scrollTo = () => {};
      win.print = () => { win.__printed = (win.__printed || 0) + 1; win.__slipAtPrint = win.document.getElementById("ogSlipPrint") ? win.document.getElementById("ogSlipPrint").outerHTML : ""; win.__printingClass = win.document.body.classList.contains("og-printing"); };
      win.URL.createObjectURL = (b) => { blobs.push(b); return "blob:csv"; };
      win.URL.revokeObjectURL = () => {};
      win.fetch = async (url, init) => {
        const u = String(url), b = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
        if (!u.includes("/api/orders")) return reply(404, { status: "error", message: "not here" });
        sent.push(JSON.parse(JSON.stringify(b))); inflight++;
        try {
          const i = scripted.findIndex(s => s.action === b.action);
          if (i >= 0) { const s = scripted.splice(i, 1)[0]; if (s.gate) await s.gate; if (s.empty) throw new Error(""); if (s.throws) throw new Error(s.throws); return reply(s.status || 200, s.body); }
          if (hold && hold.action === b.action) { const h = hold; hold = null; await h.gate; }
          const x = await call(b);
          return reply(x.status, x.body);
        } finally { inflight--; }
      };
    } });
  const w = dom.window, d = w.document;
  await pause(150);
  await w.loadAdminScript();
  w.showToast = (m, isErr) => toasts.push({ m: String(m), err: !!isErr });
  w.eval('adminKey = "cookie"; setAdminTimeZone_("UTC");');
  // Today on the page is fixed; a day offset still works from it.
  w.eval(`localToday_ = function (off) { const t = "${TODAY}"; return off ? addDays_(t, off) : t; };`);
  w.eval("adminOrgs = " + JSON.stringify([{ orgId: "school", name: "Example School Shop" }, { orgId: "club", name: "Example Club" }]) + ";");
  const q = (s) => d.querySelector(s), qa = (s) => [...d.querySelectorAll(s)];
  const id = (s) => d.getElementById(s);
  const app = id("app");
  const text = (el) => el ? el.textContent.replace(/\s+/g, " ").trim() : "";
  const idle = async () => { for (let calm = 0, i = 0; calm < 3 && i < 500; i++) { await pause(10); calm = inflight === 0 ? calm + 1 : 0; } };
  const of = (action) => sent.filter(b => b.action === action).map(b => { const c = Object.assign({}, b); delete c.key; delete c.listHeld; return c; });
  const reset = () => { sent.length = 0; toasts.length = 0; };
  const lastToast = () => toasts[toasts.length - 1] || { m: "", err: false };
  const fire = (el, type) => el.dispatchEvent(new w.Event(type, { bubbles: true }));
  const typeIn = (el, v) => { el.value = v; fire(el, "input"); };
  const choose = (el, v) => { el.value = v; fire(el, "change"); };
  const tick = (el, v) => { el.checked = v; fire(el, "change"); };
  const levelsOf = (role) => roles.effectivePermissions(roles.DEFAULT_ROLES[role]);
  const asRoles = (pageRole, serverRole) => { globalThis.__role406 = serverRole || pageRole; w.eval(roles.asRole(pageRole, { name: "Tester", email: "tester@example.test" })); };
  const signInWith = (perms, serverRole) => { globalThis.__role406 = serverRole || "admin"; w.eval(`adminMe = { role: "custom", roleName: "Front desk" }; adminPerms = ${JSON.stringify(perms)}; adminAreas = ${JSON.stringify(roles.PERMISSION_AREAS)};`); };
  const withLevels = (role, changes) => Object.assign({}, levelsOf(role), changes);
  const modal = () => { const all = qa(".admin-modal"); return all[all.length - 1] || null; };
  const confirmBox = () => q(".confirm-modal");
  const answer = async (yes) => {
    await wait(() => !!confirmBox()); const box = confirmBox();
    const msg = box.dataset.message || text(box);
    box.querySelector(yes ? "#cmOk" : "#cmCancel").click(); await pause(30);
    return msg;
  };
  const hashNow = () => w.location.hash.replace(/^#\/?/, "");
  const fetched = (name) => served.filter(u => u.endsWith("/" + name)).length;
  const features = (f) => { globalThis.__f406 = Object.assign({}, f); w.applyFeatures_(Object.assign({}, f)); };
  asRoles("admin");
  features({});
  w.renderAdminNav();
  w.refreshOrderRows_ = (org, ids) => { w.__refreshed = (w.__refreshed || []).concat([[org, ids]]); };

  // ==============================================================================================================
  console.log("=== Reports → Unpaid POs in the menu ===");
  // ==============================================================================================================
  const reportItems = () => { const g = w.adminNavGroups_().find(x => x.label === "Reports"); return g ? g.items.map(it => it[0]) : []; };
  ok("(the built-in roles) Admin and Manager have Full on the Unpaid POs report, Back office Read, Production none",
    levelsOf("admin")["reports.receivables"] === "full" && levelsOf("manager")["reports.receivables"] === "full" && levelsOf("staff")["reports.receivables"] === "read" && levelsOf("production")["reports.receivables"] === "none");
  ok("an admin's Reports menu has “Unpaid POs”, right after Fundraising", reportItems().includes("unpaidpos") && reportItems()[reportItems().indexOf("unpaidpos") - 1] === "fundraising" &&
    w.eval("ADMIN_NAV_GROUPS").find(g => g.label === "Reports").items.find(it => it[0] === "unpaidpos")[1] === "Unpaid POs");
  for (const [role, label] of [["manager", "Manager"], ["staff", "Back office"]]) {
    asRoles(role);
    ok(label + " can open it too", reportItems().includes("unpaidpos") && w.adminCanOpen_("unpaidpos") === true && w.adminCanUnpaidPos_() === true);
  }
  asRoles("production");
  ok("Production can't: no menu item and adminCanOpen_ says no", !reportItems().includes("unpaidpos") && w.adminCanOpen_("unpaidpos") === false && w.adminCanUnpaidPos_() === false);
  signInWith(withLevels("admin", { "reports.receivables": "none" }));
  ok("None on the Unpaid POs report: no item, even with everything else", !reportItems().includes("unpaidpos") && reportItems().includes("fundraising") && w.adminCanOpen_("unpaidpos") === false);
  signInWith(withLevels("production", { "reports.receivables": "read" }));
  ok("Read on it alone is enough", w.adminCanOpen_("unpaidpos") === true);
  asRoles("admin");
  ok("the page has no feature switch of its own", w.adminPageFeature_("unpaidpos") === "");
  ok("Customer-supplied garments has its name for the “turned off” page", w.eval("FEATURE_LABELS_.ownGarments") === "Customer-supplied garments");
  features({}); ok("Customer-supplied garments starts off: a catalog that never sent the switch is off", w.ownGarmentsOn_() === false && w.adminFeatureOn_("ownGarments") === true);
  features({ ownGarments: "yes" }); ok("…anything but true is off", w.ownGarmentsOn_() === false);
  features({ ownGarments: true }); ok("…true is on", w.ownGarmentsOn_() === true);
  features({});

  // ==============================================================================================================
  console.log("\n=== Global settings: the Net 30 payment, Net 30 terms and Customer-supplied garments ===");
  // ==============================================================================================================
  const panel = () => id("adminPanel");
  const drawSettings = async () => { reset(); await w.renderGlobalSettings(app); await wait(() => !!id("gPayCard")); await idle(); };
  const h2s = () => qa("#adminPanel h2").map(h => text(h));
  const saveSettings = async () => { reset(); const r = await w.submitGlobalSettings(); await idle(); return { r, saves: of("saveGlobalSettingsAll") }; };
  const errNow = () => id("globalSettingsError") ? id("globalSettingsError").textContent : "";
  const featRow = (k) => q(`#adminPanel input[data-feature="${k}"]`);
  const WAIVER = "Customer's garments are decorated at the customer's risk; we're not responsible for garments damaged in normal production.";
  await drawSettings();
  ok("the page reads the Net 30 terms (getTermsSettings)", of("getTermsSettings").length === 1);
  ok("Payment methods has “Net 30 (with a PO)”, off until ticked", !!id("gPayNet30") && !id("gPayNet30").checked && text(id("gPayNet30").closest("label")) === "Net 30 (with a PO)");
  ok("…with a note: a PO typed by staff counts at once, one the customer types waits for Accept PO, the money stays owed on Unpaid POs",
    /one typed by staff counts at once, one the customer types \(at checkout or on the invoice page\) waits for Accept PO\. The money stays owed until it is paid, on Reports → Unpaid POs\./.test(text(panel())));
  ok("a “Net 30 terms” section after Payment methods: default 30 days, starting when the invoice is sent",
    h2s().indexOf("Net 30 terms") > h2s().indexOf("Payment methods") && id("gTermsDays").value === "30" && id("gTermsStarts").value === "invoice" &&
    same([...id("gTermsStarts").options].map(o => o.value + "=" + text(o)), ["invoice=When the invoice is sent (the order date when none was sent)", "order=On the order date", "completed=When the order is completed (shipped or picked up)"]));
  ok("…saying the invoice date is the first send and that “completed” waits for shipping or pick-up",
    /The invoice date is the first time it was sent; sending it again doesn't move it\. With “completed”, an order isn't due until it has shipped or been picked up\./.test(text(panel())));
  ok("Features lists “Customer-supplied garments”, unticked (it starts off)", !!featRow("ownGarments") && featRow("ownGarments").checked === false);
  ok("…with its waiver line box holding the usual sentence (the server said what is saved)", !!id("gOwnWaiver") && id("gOwnWaiver").value === WAIVER && id("gOwnWaiver").dataset.known === "1");
  ok("…and a note that customers can't choose it on the shop", /Customers can't choose it on the shop\./.test(text(id("gOwnWaiver").closest("div").parentElement || panel())) || /Customers can't choose it on the shop\./.test(text(panel())));
  tick(id("gPayNet30"), true);
  id("gTermsDays").value = "45"; choose(id("gTermsStarts"), "order");
  tick(featRow("ownGarments"), true);
  id("gOwnWaiver").value = "  Garments are <b>at your risk</b>.  ";
  let s = await saveSettings();
  ok("Save sends the tick, the terms and the waiver in the one saveGlobalSettingsAll",
    s.saves.length === 1 && s.saves[0].settings.payments.net30 === true && same(s.saves[0].settings.terms, { defaultDays: 45, startsAt: "order" }) &&
    s.saves[0].settings.features.ownGarments === true && s.saves[0].settings.features.ownGarmentsWaiver === "Garments are <b>at your risk</b>." && errNow() === "");
  { const t = await must({ action: "getTermsSettings" }), f = await must({ action: "getFeatures" }), g = await must({ action: "getGlobalSettings" });
    ok("…saved: Net 45 from the order date, the switch on with its waiver, and Net 30 ticked",
      same(t.terms, { defaultDays: 45, startsAt: "order" }) && f.features.ownGarments === true && (f.ownGarmentsWaiver === "Garments are <b>at your risk</b>." || f.features.ownGarmentsWaiver === "Garments are <b>at your risk</b>.") &&
      JSON.stringify(g).includes('"net30":true')); }
  await drawSettings();
  ok("drawn again: all four read back (the waiver as text, not HTML)", id("gPayNet30").checked && id("gTermsDays").value === "45" && id("gTermsStarts").value === "order" &&
    featRow("ownGarments").checked && id("gOwnWaiver").value === "Garments are <b>at your risk</b>." && !id("gOwnWaiver").querySelector("b"));
  for (const [v, label] of [["0", "0"], ["366", "366"], ["2.5", "2.5"], ["", "nothing"]]) {
    id("gTermsDays").value = v;
    s = await saveSettings();
    ok(`default days of ${label}: “Nothing was saved. Net 30 terms: the default days to pay is a whole number from 1 to 365.”`,
      s.saves.length === 0 && errNow() === "Nothing was saved. Net 30 terms: the default days to pay is a whole number from 1 to 365." && lastToast().err);
  }
  id("gTermsDays").value = "30"; choose(id("gTermsStarts"), "invoice");
  id("gOwnWaiver").value = "";
  s = await saveSettings();
  ok("an emptied waiver box is sent as no waiver line", s.saves.length === 1 && s.saves[0].settings.features.ownGarmentsWaiver === "" && same(s.saves[0].settings.terms, { defaultDays: 30, startsAt: "invoice" }));
  scripted = [{ action: "getTermsSettings", status: 500, body: { status: "error", message: "down" } }];
  await drawSettings();
  ok("terms the server can't give: the section isn't drawn (the payment tick still is)", !id("gTermsDays") && !h2s().includes("Net 30 terms") && !!id("gPayNet30"));
  s = await saveSettings();
  ok("…and no terms are sent, so the form's defaults can't be saved over the real ones", s.saves.length === 1 && !("terms" in s.saves[0].settings));
  scripted = [{ action: "getTermsSettings", body: { status: "ok", terms: { defaultDays: 30, startsAt: "whenever" } } }];
  await drawSettings();
  ok("terms with a start the page doesn't know aren't drawn either", !id("gTermsDays"));
  scripted = [{ action: "getTermsSettings", body: { status: "ok", defaultDays: 60, startsAt: "completed" } }];
  await drawSettings();
  ok("terms answered at the top level are drawn", id("gTermsDays").value === "60" && id("gTermsStarts").value === "completed");
  scripted = [{ action: "getFeatures", body: { status: "ok", list: [{ key: "ownGarments", label: "Customer-supplied garments", description: "" }], features: {}, locked: [] } }];
  await drawSettings();
  ok("a server that doesn't say what waiver is saved: the usual sentence is offered, marked unknown", id("gOwnWaiver").value === WAIVER && id("gOwnWaiver").dataset.known === "");
  s = await saveSettings();
  ok("…and not sent while it is unchanged", s.saves.length === 1 && !("ownGarmentsWaiver" in s.saves[0].settings.features));
  id("gOwnWaiver").value = "Our own line.";
  s = await saveSettings();
  ok("…sent once it is changed", s.saves.length === 1 && s.saves[0].settings.features.ownGarmentsWaiver === "Our own line.");
  scripted = [{ action: "getFeatures", body: { status: "ok", list: [{ key: "ownGarments", label: "Customer-supplied garments", description: "" }], features: { ownGarmentsWaiver: "From the switches." }, locked: [] } }];
  await drawSettings();
  ok("a waiver sent among the switches is read from there", id("gOwnWaiver").value === "From the switches." && id("gOwnWaiver").dataset.known === "1");
  signInWith(withLevels("admin", { "settings.global": "read" }));
  await drawSettings();
  s = await saveSettings();
  ok("a role that can only read Global settings sees the terms but sends none", !!id("gTermsDays") && s.saves.length === 1 && !("terms" in s.saves[0].settings));
  asRoles("admin");
  // Back to: Net 30 on, Net 30 from the invoice, garments on with the usual waiver.
  await must({ action: "updateTermsSettings", terms: { defaultDays: 30, startsAt: "invoice" } });
  await must({ action: "updateFeatures", features: { ownGarments: true, ownGarmentsWaiver: WAIVER } });
  features({ ownGarments: true });

  // ==============================================================================================================
  console.log("\n=== Orders on Net 30 (seeded through the real actions) ===");
  // ==============================================================================================================
  { const g = await must({ action: "getGlobalSettings" });
    const pay = Object.assign({}, (g.globalSettings || g.settings || g).enabledPayments || {}, { net30: true });
    await must({ action: "updateGlobalSettings", globalSettings: { enabledPayments: pay } }); }
  let seq = 0;
  // Made now, then dated: the server refuses a sale dated after the machine's own today, and this test can't depend on it.
  const sale = async (org, placed, extra, qty = 1) => {
    const oid = (await must(Object.assign({ action: "createLocalSale", org, requestId: "seed406-" + (++seq) + "-abcdef", customerName: "Walk-in",
      paymentMethod: "Net 30", net30: true, items: [{ productId: "mug", size: "", qty }] }, extra || {}))).orderId;
    d1._raw.exec(`UPDATE orders SET placedAt = '${noon(placed)}' WHERE orderId = '${oid}'`);
    return oid;
  };
  const oNoPo = await sale("club", "2026-12-01", { customerId: 2, customerName: "Example School District" });
  const oCheck = await sale("club", "2026-12-05", { customerId: 1, customerName: "Pat Example" });
  d1._raw.exec(`UPDATE orders SET poNumber = 'PO-1002', poTypedAt = '${noon("2026-12-06")}' WHERE orderId = '${oCheck}'`);
  const oOk = await sale("club", "2026-12-01", { customerId: 1, customerName: "Pat Example", poNumber: "1003" });
  d1._raw.exec(`UPDATE orders SET invoicedAt = '${noon("2026-12-02")}' WHERE orderId = '${oOk}'`);
  const o3160 = await sale("club", "2026-10-01", { customerId: 2, customerName: "Example School District", poNumber: "PO-1004", termsDays: 30 });
  const o130 = await sale("club", "2026-11-01", { customerId: 2, customerName: "Example School District", poNumber: "PO-1005", termsDays: 30 }, 3);
  await must({ action: "addPayment", orderId: o130, amount: 10, method: "check" });
  const o6190 = await sale("club", "2026-09-10", { customerId: 1, customerName: "Pat Example", poNumber: "1006" });
  const WALKIN = '=HYPERLINK("http://x.example","<b>Walk-in</b>")';
  const o90 = await sale("club", "2026-08-01", { customerName: WALKIN, poNumber: "+1007" });
  const oPaid = await sale("club", "2026-12-03", { customerId: 1, customerName: "Pat Example", poNumber: "1008" });
  await must({ action: "addPayment", orderId: oPaid, amount: 10, method: "check" });
  const oFuture = await sale("club", "2026-12-20", { customerId: 1, customerName: "Pat Example", poNumber: "1009" });
  const oSchool = await sale("school", "2026-12-10", { customerId: 2, customerName: "Example School District", poNumber: "PO-1010" });
  const oPlain = await sale("club", "2026-12-10", { paymentMethod: "Cash", net30: undefined });
  ok("(seeded: staff's POs accepted at once, the customer's waiting, the District's own 45 days filled in)",
    !!orderRow(oOk).poAcceptedAt && !orderRow(oCheck).poAcceptedAt && orderRow(oNoPo).termsDays === 45 && orderRow(o3160).termsDays === 30 && !orderRow(oPlain).net30);

  // ==============================================================================================================
  console.log("\n=== An order's Net 30 tag, Paid cell and buttons ===");
  // ==============================================================================================================
  const reload = async (org = "club") => { w._ordersCache = w._ordersCache || {}; const r = await must({ action: "getOrders", org, dateFrom: "2026-01-01", dateTo: "2026-12-31" }); w._ordersCache[org] = r.orders; (w._ordersNet30 = w._ordersNet30 || {})[org] = r.net30; return r; };
  w._ordersFilter = { from: "2026-07-01", to: "2026-12-31" };
  reset();
  w.location.hash = "#orders/club";
  await wait(() => !!q(`#app tr[data-order="${oCheck}"]`), 1500); await idle();
  ok("the Orders page lists the Net 30 orders", !!q(`#app tr[data-order="${oNoPo}"]`) && !!q(`#app tr[data-order="${oOk}"]`));
  ok("…and keeps the shop's rule from getOrders: Net 30 allowed", same(w._ordersNet30.club, { allowed: true, defaultDays: 30 }) && w.net30Rule_("club").allowed === true);
  const ORG = { orgId: "club", name: "Example Club" };
  { const r = await must({ action: "getOrders", org: "club", dateFrom: "2026-01-01", dateTo: "2026-12-31" }); delete r.net30;
    scripted = [{ action: "getOrders", body: r }];
    await w.fetchOrders("club");
    ok("a server that doesn't say whether a shop takes Net 30: not allowed", same(w._ordersNet30.club, { allowed: false }));
    scripted = [{ action: "getOrders", body: Object.assign({}, r, { net30: "yes" }) }];
    await w.fetchOrders("club");
    ok("…nor when it says so in a shape the page doesn't know", same(w._ordersNet30.club, { allowed: false })); }
  w._ordersNet30 = {};
  reset(); w.location.hash = "#orders/all";
  await wait(() => of("getOrdersAllShops").length > 0 && !!q(`#app tr[data-order="${oSchool}"]`), 1500); await idle();
  ok("every shop's orders at once: each shop's rule kept from its own part of the answer", same(w._ordersNet30.school, { allowed: true, defaultDays: 30 }) && same(w._ordersNet30.club, { allowed: true, defaultDays: 30 }));
  await reload();
  const get = (oid, org = "club") => (w._ordersCache[org] || []).find(o => o.orderId === oid);
  const tagOf = (o) => { const h = d.createElement("div"); h.innerHTML = w.net30Tag_(o); return h.querySelector(".n30-tag"); };
  const rowOf = (oid) => q(`#app tr[data-order="${oid}"]`);
  ok("an order with no PO: “Net 30 — PO needed”", text(tagOf(get(oNoPo))) === "Net 30 — PO needed" && tagOf(get(oNoPo)).classList.contains("n30-tag-need") &&
    tagOf(get(oNoPo)).title === "On Net 30 terms: the work waits for a PO number");
  ok("a PO the customer typed: “Net 30 — PO to check”, the PO in its title", text(tagOf(get(oCheck))) === "Net 30 — PO to check" && tagOf(get(oCheck)).classList.contains("n30-tag-check") &&
    tagOf(get(oCheck)).title === "The customer typed PO-1002: accept it to clear the order for work");
  ok("an accepted PO: “PO 1003 · due Jan 1” (from the invoice sent Dec 2, Net 30), who accepted it in its title",
    text(tagOf(get(oOk))) === "PO 1003 · due Jan 1" && !tagOf(get(oOk)).classList.contains("n30-tag-late") && tagOf(get(oOk)).title === "Net 30 · PO accepted by owner@example.test");
  ok("a PO past its due date with money owed: “PO-1004 · was due Oct 31”, in red", text(tagOf(get(o3160))) === "PO-1004 · was due Oct 31" && tagOf(get(o3160)).classList.contains("n30-tag-late"));
  ok("a PO number already starting with PO is shown as typed; any other gets “PO ” in front", w.net30PoText_("po 77") === "po 77" && w.net30PoText_(" 1003 ") === "PO 1003" && w.net30PoText_("POLAR-1") === "PO POLAR-1" && w.net30PoText_("") === "");
  ok("a paid order past its date isn't red, and says no due date", text(tagOf(Object.assign({}, get(oPaid), { termsDueDate: "2026-01-01" }))) === "PO 1008 · due Jan 1" && !tagOf(Object.assign({}, get(oPaid), { termsDueDate: "2026-01-01" })).classList.contains("n30-tag-late"));
  ok("no due date yet while money is owed (terms that start when it's completed): “PO 7 · due date to come”", text(tagOf({ net30: true, poNumber: "7", poAcceptedAt: "x", termsDueDate: "", balanceDue: 5 })) === "PO 7 · due date to come");
  ok("…and with nothing owed, just the PO", text(tagOf({ net30: true, poNumber: "7", poAcceptedAt: "x", termsDueDate: "", balanceDue: 0, termsDays: 45 })) === "PO 7" && tagOf({ net30: true, poNumber: "7", poAcceptedAt: "x", termsDays: 45 }).title === "Net 45");
  { const keep = w._ordersNet30.club;
    w._ordersNet30.club = Object.assign({}, keep, { defaultDays: 45 });
    const t = tagOf({ orgId: "club", net30: true, poNumber: "7", poAcceptedAt: "x", termsDueDate: "", balanceDue: 0, termsDays: null });
    ok("an accepted PO with no days of its own: its title names the shop's default days (getOrders' net30.defaultDays, here Net 45), not 30", !!t && t.title === "Net 45");
    w._ordersNet30.club = keep; }
  ok("an order not on terms has no tag", w.net30Tag_(get(oPlain)) === "" && w.net30Status_(get(oPlain)) === "" && w.net30Status_(null) === "");
  ok("a status the server didn't send is worked out from the fields", w.net30Status_({ net30: true }) === "PO needed" && w.net30Status_({ net30: true, poNumber: "1" }) === "PO to check" && w.net30Status_({ net30: true, poNumber: "1", poAcceptedAt: "t" }) === "accepted");
  ok("the row's Payment cell shows the method and the tag", /^Net 30\s*Net 30 — PO to check$/.test(text(rowOf(oCheck).querySelector("td[rowspan] + td[data-paid-td]") ? rowOf(oCheck).querySelector("td[data-paid-td]").previousElementSibling : null)));
  ok("the Paid cell: “Unpaid · Net 30”; a plain unpaid order “Unpaid”", text(rowOf(oCheck).querySelector("td[data-paid-td]")) === "Unpaid · Net 30" && text(rowOf(oPlain).querySelector("td[data-paid-td]")) === "Unpaid" &&
    w.paidLabel_({ paid: true, net30: true }) === "Paid" && w.paidLabel_({ payOnDelivery: true, net30: true }) === "Unpaid · on delivery");
  { const h = d.createElement("div"); h.innerHTML = w.orderCardHtml_(get(oOk), ORG, null, false);
    ok("an order's card (phone) carries the same tag", text(h.querySelector(".oc-amt .n30-tag")) === "PO 1003 · due Jan 1");
    h.innerHTML = w.orderCardHtml_(get(oPlain), ORG, null, false);
    ok("…and none for an order not on terms", !h.querySelector(".n30-tag")); }
  ok("Net 30 with an accepted PO clears the work; a PO to check or none doesn't",
    w.workCleared_(get(oOk)) === true && w.workCleared_(get(oCheck)) === false && w.workCleared_(get(oNoPo)) === false && w.workCleared_({ net30: true, poNumber: " ", poAcceptedAt: "t" }) === false);
  ok("an accepted PO lets a delivered order be completed while it's still owed; a PO to check doesn't",
    w.canCompleteOrder(Object.assign({}, get(oOk), { deliveredAt: "t" })) === true && w.canCompleteOrder(Object.assign({}, get(oCheck), { deliveredAt: "t" })) === false);
  const cellOf = (o, org = ORG) => { const h = d.createElement("div"); h.innerHTML = w.adminActionCell(org, o); return h; };
  const btn = (h, action) => h.querySelector(`[data-admin-action="${action}"]`);
  ok("no PO yet: Net 30… (titled “This order's Net 30 terms…”), no Accept PO", !!btn(cellOf(get(oNoPo)), "showOrderTerms_") && !btn(cellOf(get(oNoPo)), "acceptOrderPoRow_") &&
    btn(cellOf(get(oNoPo)), "showOrderTerms_").title === "This order's Net 30 terms: its PO, days and due date" && btn(cellOf(get(oNoPo)), "showOrderTerms_").dataset.need === "orders.terms:edit");
  ok("a PO to check: Accept PO and Net 30…", !!btn(cellOf(get(oCheck)), "acceptOrderPoRow_") && !!btn(cellOf(get(oCheck)), "showOrderTerms_"));
  ok("an accepted PO (the work is cleared): Net 30… still, no Accept PO", !!btn(cellOf(get(oOk)), "showOrderTerms_") && !btn(cellOf(get(oOk)), "acceptOrderPoRow_"));
  ok("an unpaid order not on terms, in a shop that takes Net 30: Net 30… to put it on terms", !!btn(cellOf(get(oPlain)), "showOrderTerms_") && btn(cellOf(get(oPlain)), "showOrderTerms_").title === "Let the customer pay by invoice: the work goes ahead once a PO is in");
  ok("…not on an order paid, completed or voided", !btn(cellOf(Object.assign({}, get(oPlain), { paid: true })), "showOrderTerms_") && !btn(cellOf(Object.assign({}, get(oPlain), { completedAt: "t" })), "showOrderTerms_") &&
    !btn(cellOf(Object.assign({}, get(oCheck), { voidedAt: "t" })), "showOrderTerms_") && !btn(cellOf(Object.assign({}, get(oCheck), { voidedAt: "t" })), "acceptOrderPoRow_"));
  w._ordersNet30.club = { allowed: false };
  ok("a shop that doesn't take Net 30: no Net 30… on an order not on terms, but still on one that is", !btn(cellOf(get(oPlain)), "showOrderTerms_") && !!btn(cellOf(get(oNoPo)), "showOrderTerms_"));
  w._ordersNet30 = {};
  ok("…and a server that didn't say counts as not allowed", w.net30Rule_("club").allowed === false && !btn(cellOf(get(oPlain)), "showOrderTerms_"));
  w._ordersNet30.club = { allowed: true };
  asRoles("staff");
  ok("Back office (Edit on Net 30 terms) gets both buttons", levelsOf("staff")["orders.terms"] === "edit" && !!btn(cellOf(get(oCheck)), "acceptOrderPoRow_") && !!btn(cellOf(get(oCheck)), "showOrderTerms_"));
  asRoles("production");
  ok("Production (none) gets neither", levelsOf("production")["orders.terms"] === "none" && !btn(cellOf(get(oCheck)), "acceptOrderPoRow_") && !btn(cellOf(get(oCheck)), "showOrderTerms_"));
  signInWith(withLevels("admin", { "orders.terms": "read" }));
  ok("Read on Net 30 terms isn't enough for either", !btn(cellOf(get(oCheck)), "acceptOrderPoRow_") && !btn(cellOf(get(oOk)), "showOrderTerms_"));
  asRoles("admin");

  // ==============================================================================================================
  console.log("\n=== The Net 30… window ===");
  // ==============================================================================================================
  const n30 = () => { const m = modal(); return m && m.querySelector("#n30Form") ? m : null; };
  const n30q = (s) => n30().querySelector(s);
  const openTerms = async (oid) => { reset(); w.__refreshed = []; const p = w.showOrderTerms_("club", oid); await wait(() => !!n30()); await idle(); return p; };
  const closeTerms = async () => { const c = n30q("#n30Cancel"); c.click(); await pause(20); if (confirmBox()) confirmBox().querySelector("#cmOk").click(); await wait(() => !n30()); };
  const submitTerms = async () => { fire(n30q("#n30Form"), "submit"); await idle(); };
  await reload();
  reset(); await w.showOrderTerms_("club", "NOPE-1");
  ok("an order that isn't in the list: “Order not found — refresh the list.”, no window", lastToast().m === "Order not found — refresh the list." && lastToast().err && !n30());
  await openTerms(oNoPo);
  ok("its title names the order", text(n30().querySelector("[data-dialog-title]")) === "Net 30 — " + oNoPo);
  ok("no PO yet: “No PO yet”, due Jan 15, 2027 (the District's Net 45 from the order date), no invoice sent, still owed $10.00",
    /^No PO yet\s*Due Jan 15, 2027 · Net 45 · no invoice sent yet\s*Still owed: \$10\.00$/.test(text(n30q("#n30Facts"))));
  ok("…the tick is on, its days (45) and an empty PO box shown, no Accept PO", n30q("#n30On").checked && !n30q("#n30Fields").hidden && n30q("#n30Days").value === "45" && n30q("#n30Po").value === "" && !n30q("#n30Accept"));
  for (const [v, label] of [["0", "0"], ["400", "400"], ["1.5", "1.5"]]) {
    n30q("#n30Days").value = v; reset(); await submitTerms();
    ok(`days of ${label}: “Days to pay: a whole number from 1 to 365, or blank for the default.”, nothing sent`, text(n30q("#n30Err")) === "Days to pay: a whole number from 1 to 365, or blank for the default." && of("setOrderTerms").length === 0);
  }
  n30q("#n30Days").value = ""; n30q("#n30Po").value = "P".repeat(61); reset(); await submitTerms();
  ok("a PO of 61 characters: “A PO number is at most 60 characters.”, nothing sent", text(n30q("#n30Err")) === "A PO number is at most 60 characters." && of("setOrderTerms").length === 0);
  n30q("#n30Po").value = "  PO-2001 "; reset(); await submitTerms();
  ok("Save sends the terms: Net 30, blank days (the default), the PO trimmed", same(of("setOrderTerms"), [{ action: "setOrderTerms", orderId: oNoPo, org: "club", net30: true, termsDays: null, poNumber: "PO-2001" }]));
  ok("…the window closes with “Order … is on Net 30 with PO-2001.” and the row is read again", !n30() && lastToast().m === "Order " + oNoPo + " is on Net 30 with PO-2001." && same(w.__refreshed, [["club", [oNoPo]]]));
  ok("…saved: staff's PO counts at once", orderRow(oNoPo).poNumber === "PO-2001" && !!orderRow(oNoPo).poAcceptedAt);
  await reload();
  await openTerms(oNoPo);
  ok("an accepted PO: “PO accepted — PO-2001”, accepted by whom", /^PO accepted — PO-2001\s*Accepted .+ by owner@example\.test\s*Due /.test(text(n30q("#n30Facts"))));
  n30q("#n30Po").value = ""; reset(); await submitTerms();
  ok("on Net 30 with the PO taken out: “… is on Net 30 — it waits for a PO number.”", lastToast().m === "Order " + oNoPo + " is on Net 30 — it waits for a PO number." && of("setOrderTerms")[0].poNumber === "" && orderRow(oNoPo).poNumber === "");
  await reload();
  await openTerms(oPlain);
  ok("an order not on terms: “Not on Net 30: the work waits for payment as usual.”, the tick off and its fields hidden", text(n30q("#n30Facts")) === "Not on Net 30: the work waits for payment as usual." && !n30q("#n30On").checked && n30q("#n30Fields").hidden);
  tick(n30q("#n30On"), true);
  ok("ticking Net 30 shows the days and PO", !n30q("#n30Fields").hidden);
  tick(n30q("#n30On"), false);
  ok("…unticking hides them again", n30q("#n30Fields").hidden);
  n30q("#n30Days").value = "0"; reset(); await submitTerms();
  ok("unticked, the fields aren't checked and an order not on terms isn't asked about: it sends Net 30 off and closes", !n30() && same(of("setOrderTerms"), [{ action: "setOrderTerms", orderId: oPlain, org: "club", net30: false }]) && !confirmBox() &&
    lastToast().m === "Order " + oPlain + " is off Net 30.");
  await reload();
  await openTerms(oPlain);
  tick(n30q("#n30On"), true); n30q("#n30Days").value = "60"; reset(); await submitTerms();
  ok("putting an order on Net 30 with 60 days and no PO: sent, and saved waiting for a PO", same(of("setOrderTerms"), [{ action: "setOrderTerms", orderId: oPlain, org: "club", net30: true, termsDays: 60, poNumber: "" }]) &&
    orderRow(oPlain).net30 === 1 && orderRow(oPlain).termsDays === 60 && lastToast().m === "Order " + oPlain + " is on Net 30 — it waits for a PO number.");
  await reload();
  await openTerms(oPlain);
  tick(n30q("#n30On"), false); reset();
  fire(n30q("#n30Form"), "submit");
  let asked = await answer(false); await idle();
  ok("taking an order off Net 30 asks first: “Take order … off Net 30? Steps not done yet wait for payment again.”", /^Take order .+ off Net 30\?\s+Steps not done yet wait for payment again\.$/.test(asked));
  ok("…No: nothing sent, the window stays", of("setOrderTerms").length === 0 && !!n30());
  fire(n30q("#n30Form"), "submit"); await answer(true); await idle();
  ok("…Yes: Net 30 off is sent, and “Order … is off Net 30.”", same(of("setOrderTerms"), [{ action: "setOrderTerms", orderId: oPlain, org: "club", net30: false }]) && lastToast().m === "Order " + oPlain + " is off Net 30." && orderRow(oPlain).net30 === 0);
  await reload();
  // Paid in full and not on terms: the server refuses Net 30, and says so in the window.
  const oPaidPlain = await sale("club", "2026-12-11", { paymentMethod: "Cash", net30: undefined, paid: true });
  await reload();
  await openTerms(oPaidPlain);
  tick(n30q("#n30On"), true); reset(); await submitTerms();
  ok("the server's refusal is shown in the window, Save usable again", of("setOrderTerms").length === 1 && text(n30q("#n30Err")) !== "" && !n30q("#n30Save").disabled && orderRow(oPaidPlain).net30 === 0);
  scripted = [{ action: "setOrderTerms", empty: true }]; await submitTerms();
  ok("…a failure with no words: “Couldn't save the terms.”", text(n30q("#n30Err")) === "Couldn't save the terms.");
  await closeTerms();
  await openTerms(oCheck);
  ok("a PO the customer typed: “PO typed by the customer, not accepted yet — PO-1002”, when they typed it, due Jan 4, 2027",
    /^PO typed by the customer, not accepted yet — PO-1002\s*Typed by the customer .+Due Jan 4, 2027 · Net 30 · no invoice sent yet/.test(text(n30q("#n30Facts"))));
  ok("…with Accept PO in the window", !!n30q("#n30Accept") && text(n30q("#n30Accept")) === "Accept PO");
  scripted = [{ action: "acceptOrderPo", status: 409, body: { status: "error", message: "Not today." } }];
  n30q("#n30Accept").click(); await idle();
  ok("Accept PO refused: the server's words in the window, the button usable again", text(n30q("#n30Err")) === "Not today." && !n30q("#n30Accept").disabled);
  scripted = [{ action: "acceptOrderPo", empty: true }];
  n30q("#n30Accept").click(); await idle();
  ok("…a failure with no words: “Couldn't accept the PO.”", text(n30q("#n30Err")) === "Couldn't accept the PO.");
  reset(); n30q("#n30Accept").click(); await idle();
  ok("Accept PO: sent, the window closes with “PO-1002 accepted: order … is cleared for work.”",
    same(of("acceptOrderPo"), [{ action: "acceptOrderPo", orderId: oCheck, org: "club" }]) && !n30() && lastToast().m === "PO-1002 accepted: order " + oCheck + " is cleared for work." && !!orderRow(oCheck).poAcceptedAt);
  d1._raw.exec(`UPDATE orders SET poAcceptedAt = NULL, poAcceptedBy = '' WHERE orderId = '${oCheck}'`);
  await reload();
  { const paidO = Object.assign({}, get(oPaid), { balanceDue: 0 });
    w._ordersCache.club.push(Object.assign(paidO, { orderId: "FAKE-PAID" }));
    await openTerms("FAKE-PAID");
    ok("an order paid in full says “Paid in full.”", /Paid in full\.$/.test(text(n30q("#n30Facts"))));
    await closeTerms(); }
  w._ordersCache.club.push(Object.assign({}, get(oPlain), { orderId: "FAKE-POD", payOnDelivery: true, net30: false }));
  await openTerms("FAKE-POD");
  ok("an order set to pay on delivery says so", text(n30q("#n30Facts")) === "Not on Net 30: the work waits for payment as usual (it is set to pay on delivery).");
  typeIn(n30q("#n30Po"), "x");
  n30q("#n30Cancel").click(); await pause(30);
  ok("Cancel after typing asks before throwing it away", !!confirmBox());
  await answer(true); await wait(() => !n30());
  w._ordersCache.club.push(Object.assign({}, get(oOk), { orderId: "FAKE-OLD", poStatus: "", termsDueDate: "", termsDays: null, invoicedAt: "" }));
  await openTerms("FAKE-OLD");
  ok("no due date from the server: “Due date: not known yet · Net 30”", /Due date: not known yet · Net 30 · no invoice sent yet/.test(text(n30q("#n30Facts"))));
  await closeTerms();
  signInWith(withLevels("admin", { "orders.terms": "read" }));
  await openTerms(oCheck);
  ok("a role that can only read Net 30 terms sees the facts and a note, with no tick, Save or Accept PO",
    !n30q("#n30On") && !n30q("#n30Save") && !n30q("#n30Accept") && /Changing an order's terms needs Net 30 terms on orders \(Users → Roles and permissions\)\./.test(text(n30())) && text(n30q("#n30Cancel")) === "Close");
  n30q("#n30Cancel").click(); await wait(() => !n30());
  ok("…Close closes it", !n30());
  asRoles("admin");

  // ==============================================================================================================
  console.log("\n=== Accept PO on an order's row ===");
  // ==============================================================================================================
  reset(); w.__refreshed = [];
  let p = w.acceptOrderPoRow_("club", oCheck);
  asked = await answer(false); await p;
  ok("it asks first: “Accept PO-1002 for order …? The order is cleared for work…”", /^Accept PO-1002 for order .+\?\s+The order is cleared for work: blanks, the run and delivery go ahead\. The money stays owed until it's paid\.$/.test(asked));
  ok("…No: nothing sent", of("acceptOrderPo").length === 0);
  scripted = [{ action: "acceptOrderPo", status: 409, body: { status: "error", message: "Already done." } }];
  p = w.acceptOrderPoRow_("club", oCheck); await answer(true); await p; await idle();
  ok("refused: “Couldn't accept the PO: Already done.” (an error)", lastToast().m === "Couldn't accept the PO: Already done." && lastToast().err);
  scripted = [{ action: "acceptOrderPo", empty: true }];
  p = w.acceptOrderPoRow_("club", oCheck); await answer(true); await p; await idle();
  ok("…with no words: “Couldn't accept the PO: unknown error”", lastToast().m === "Couldn't accept the PO: unknown error");
  reset();
  p = w.acceptOrderPoRow_("club", oCheck); await answer(true); await p; await idle();
  ok("Yes: accepted, “PO-1002 accepted for order ….”, the row read again", same(of("acceptOrderPo"), [{ action: "acceptOrderPo", orderId: oCheck, org: "club" }]) && lastToast().m === "PO-1002 accepted for order " + oCheck + "." &&
    !!orderRow(oCheck).poAcceptedAt && same(w.__refreshed, [["club", [oCheck]]]));
  p = w.acceptOrderPoRow_("club", "NOT-LISTED"); asked = await answer(false); await p;
  ok("an order not in the list is asked about as “the PO”", /^Accept the PO for order NOT-LISTED\?/.test(asked));
  d1._raw.exec(`UPDATE orders SET poAcceptedAt = NULL, poAcceptedBy = '' WHERE orderId = '${oCheck}'`);
  await reload();

  // ==============================================================================================================
  console.log("\n=== The Local sale: Net 30 and the customer's own garment ===");
  // ==============================================================================================================
  const form = () => q("#localSaleForm");
  const openSale = async (opts) => { reset(); const done = w.createLocalSale("club", opts); await wait(() => !!form()); await idle(); return { p: done }; };
  const closeSale = async (box) => {
    const c = [...form().querySelectorAll("button")].find(b => /^Cancel$/.test(text(b))); c.click();
    await wait(() => { if (confirmBox()) confirmBox().querySelector("#cmOk").click(); return !form(); });
    await (box && box.p); await idle(); };
  const lsErr = () => text(form().querySelector("#lsErr"));
  const lsSubmit = async () => { form().querySelector(".admin-pass-submit").click(); await idle(); };
  const lines = () => qa("#localSaleForm .ls-line");
  const fld = (line, nm) => line.querySelector(`[data-f="${nm}"]`);
  const pickMug = (n = 1) => { choose(fld(lines()[0], "product"), "mug"); typeIn(fld(lines()[0], "qty"), String(n)); };
  const optionTexts = () => [...form().querySelector("#lsPayment").options].map(o => o.value + "=" + text(o));
  w._ordersNet30 = { club: { allowed: true } };
  w._ordersPod = { club: { allowed: true, localSaleOnly: false } };
  let ls = await openSale();
  ok("a shop that takes Net 30: Payment offers “Net 30 (pay by invoice)”", optionTexts().includes("Net 30=Net 30 (pay by invoice)"));
  ok("…its PO and days are hidden until it is picked", !!form().querySelector("#lsNet30Wrap") && form().querySelector("#lsNet30Wrap").style.display === "none" && form().querySelector("#lsNet30Wrap").dataset.need === "orders.terms:edit");
  choose(form().querySelector("#lsPayment"), "Net 30");
  ok("…picked: “PO number” and “Days to pay” (blank: the default)", form().querySelector("#lsNet30Wrap").style.display === "" && form().querySelector("#lsPo").maxLength === 60 &&
    form().querySelector("#lsTermsDays").placeholder === "Default" && /With a PO the work goes ahead now and the money stays owed \(Reports → Unpaid POs\)/.test(text(form().querySelector("#lsNet30Wrap"))));
  choose(form().querySelector("#lsPayment"), "Cash");
  ok("…another method hides them again", form().querySelector("#lsNet30Wrap").style.display === "none");
  ok("…hidden, its boxes are switched off (so they take no part in the form's checks); shown, on again",
    form().querySelector("#lsTermsDays").disabled && form().querySelector("#lsPo").disabled &&
    (choose(form().querySelector("#lsPayment"), "Net 30"), !form().querySelector("#lsTermsDays").disabled && !form().querySelector("#lsPo").disabled) &&
    (choose(form().querySelector("#lsPayment"), "Cash"), form().querySelector("#lsTermsDays").disabled));
  ok("with Customer-supplied garments on, each line has “Customer's own garment”", !!fld(lines()[0], "customerOwned") && /Customer's own garment — no blank; check the garments in on the order/.test(text(fld(lines()[0], "ownWrap"))));
  choose(form().querySelector("#lsPayment"), "Net 30");
  pickMug(2);
  form().querySelector("#lsPaid").checked = true;
  await lsSubmit();
  ok("Net 30 with Paid ticked: “Net 30 is paid later, by invoice: untick Paid.”, nothing sent", lsErr() === "Net 30 is paid later, by invoice: untick Paid." && of("createLocalSale").length === 0);
  form().querySelector("#lsPaid").checked = false;
  form().querySelector("#lsPod").checked = true;
  await lsSubmit();
  ok("…with Pay on delivery ticked: “… untick Pay on delivery.”", lsErr() === "Net 30 is paid later, by invoice: untick Pay on delivery." && of("createLocalSale").length === 0);
  form().querySelector("#lsPod").checked = false;
  for (const v of ["0", "366", "4.5"]) {
    // The box's own min/max/step stop a browser's submit first; the window's check is there for whatever gets past them.
    form().querySelector("#lsTermsDays").value = v;
    fire(form(), "submit"); await idle();
    ok(`days of ${v}: “Days to pay: a whole number from 1 to 365, or blank for the default.”`, lsErr() === "Days to pay: a whole number from 1 to 365, or blank for the default." && of("createLocalSale").length === 0);
  }
  form().querySelector("#lsTermsDays").value = "20";
  form().querySelector("#lsPo").value = "  PO-3001 ";
  tick(fld(lines()[0], "customerOwned"), true);
  reset();
  form().querySelector(".admin-pass-submit").click(); await ls.p; await idle();
  const lsSent = of("createLocalSale")[0] || {};
  ok("Record sale sends Net 30, its 20 days and the PO (trimmed), and the line as the customer's own",
    lsSent.paymentMethod === "Net 30" && lsSent.net30 === true && lsSent.termsDays === 20 && lsSent.poNumber === "PO-3001" && lsSent.paid === false && !lsSent.payOnDelivery &&
    lsSent.items.length === 1 && lsSent.items[0].customerOwned === true && lsSent.items[0].qty === 2);
  const oSale = (d1.q("SELECT orderId FROM orders ORDER BY rowid DESC LIMIT 1")[0] || {}).orderId;
  ok("…saved: on Net 30 for 20 days with PO-3001 accepted (staff's), the line marked the customer's own",
    orderRow(oSale).net30 === 1 && orderRow(oSale).termsDays === 20 && orderRow(oSale).poNumber === "PO-3001" && !!orderRow(oSale).poAcceptedAt &&
    d1.q("SELECT customerOwned FROM order_items WHERE orderId = ?", oSale)[0].customerOwned === 1);
  ls = await openSale({ customer: { id: 2, name: "", company: "Example School District", email: "ap@example.org", termsDays: 45 } });
  choose(form().querySelector("#lsPayment"), "Net 30");
  ok("a customer with days of their own: Days to pay says “45 (theirs)”", form().querySelector("#lsTermsDays").placeholder === "45 (theirs)");
  form().querySelector("#lsCustomerClear").click();
  ok("…cleared: “Default” again", form().querySelector("#lsTermsDays").placeholder === "Default");
  pickMug(1);
  reset();
  form().querySelector(".admin-pass-submit").click(); await ls.p; await idle();
  { const b = of("createLocalSale")[0] || {};
    ok("Net 30 with no PO and blank days sends just Net 30, and a line not ticked isn't the customer's own", b.net30 === true && !("termsDays" in b) && !("poNumber" in b) && !("customerOwned" in b.items[0])); }
  ls = await openSale({ customer: { id: 1, name: "Pat Example", email: "pat@example.com" } });
  ok("a customer without days of their own: “Default”", form().querySelector("#lsTermsDays").placeholder === "Default");
  choose(form().querySelector("#lsPayment"), "Net 30"); form().querySelector("#lsTermsDays").value = "0";
  choose(form().querySelector("#lsPayment"), "Cash"); pickMug(1);
  ok("days of 0 left in the hidden Net 30 box don't make the form invalid", form().checkValidity() === true);
  // Record sale clicked as a person would: the browser's own checks run first (a hidden box out of range used to stop it).
  reset(); form().querySelector(".admin-pass-submit").click(); await ls.p; await idle();
  { const b = of("createLocalSale")[0] || {};
    ok("another method: Net 30's boxes aren't read or sent", b.paymentMethod === "Cash" && !("net30" in b) && !("termsDays" in b) && !("poNumber" in b)); }
  w._ordersNet30 = { club: { allowed: false } };
  ls = await openSale();
  ok("a shop that doesn't take Net 30: no Net 30 option, no PO box", !optionTexts().some(o => /^Net 30=/.test(o)) && !form().querySelector("#lsNet30Wrap"));
  await closeSale(ls);
  w._ordersNet30 = { club: { allowed: true } };
  signInWith(withLevels("admin", { "orders.terms": "read" }));
  ls = await openSale();
  ok("a role without Edit on Net 30 terms isn't offered it", !optionTexts().some(o => /^Net 30=/.test(o)) && !form().querySelector("#lsNet30Wrap"));
  await closeSale(ls);
  asRoles("admin");
  features({});
  ls = await openSale();
  ok("Customer-supplied garments off: no “Customer's own garment” on a line", !fld(lines()[0], "customerOwned") && !fld(lines()[0], "ownWrap"));
  await closeSale(ls);
  features({ ownGarments: true });
  scripted = [{ action: "getOrderForReorder", body: { status: "ok", reorder: { orgId: "club", lines: [{ productId: "mug", name: "Club Mug", qty: 4, size: "", customerOwned: true }, { productId: "mug", name: "Club Mug", qty: 1, size: "" }] } } }];
  ls = await openSale({ reorder: { orderId: oSale } });
  ok("a reorder of a line on the customer's own garments comes back ticked (and the other line not)", lines().length === 2 && fld(lines()[0], "customerOwned").checked && !fld(lines()[1], "customerOwned").checked);
  await closeSale(ls);
  w._ordersPod = {};

  // ==============================================================================================================
  console.log("\n=== Edit items: the customer's own garment ===");
  // ==============================================================================================================
  const oEdit = await sale("club", "2026-12-12", { customerId: 1, customerName: "Pat Example", paymentMethod: "Cash", net30: undefined });
  const editWin = () => q("#editOrderSave") ? q("#editOrderSave").closest(".admin-modal, div[style*='position:fixed'], body > div") : null;
  const openEdit = async (oid) => { await reload(); reset(); const p = w.editOrder("club", oid); await wait(() => !!q("#editOrderSave")); await idle(); return { p }; };
  const ownBoxes = () => qa('input[data-field="customerOwned"]');
  const saveEdit = async (box) => { q("#editOrderSave").click(); await pause(30); if (confirmBox()) confirmBox().querySelector("#cmOk").click(); await box.p; await idle(); return of("editOrder")[0] || null; };
  let pe = await openEdit(oEdit);
  ok("with the feature on, each line has “Customer's own garment”, unticked for a plain line", ownBoxes().length === 1 && !ownBoxes()[0].checked && /Customer's own garment/.test(text(ownBoxes()[0].closest("label"))));
  tick(ownBoxes()[0], true);
  let ed = await saveEdit(pe);
  const itemIdOf = (oid) => d1.q("SELECT id FROM order_items WHERE orderId = ? ORDER BY id", oid).map(r => r.id);
  ok("ticking it sends that line as an update with customerOwned true, and nothing else", !!ed && ed.updates.length === 1 && ed.updates[0].customerOwned === true && ed.updates[0].itemId === itemIdOf(oEdit)[0] && ed.additions.length === 0);
  ok("…saved on the line", d1.q("SELECT customerOwned FROM order_items WHERE orderId = ?", oEdit)[0].customerOwned === 1);
  pe = await openEdit(oEdit);
  ok("opened again it is ticked", ownBoxes().length === 1 && ownBoxes()[0].checked);
  const qtyBox = () => q('input[data-field="qty"]');
  qtyBox().value = "2"; fire(qtyBox(), "change"); fire(qtyBox(), "input");
  ed = await saveEdit(pe);
  ok("a change of quantity alone doesn't send customerOwned", !!ed && ed.updates.length === 1 && !("customerOwned" in ed.updates[0]) && ed.updates[0].qty === 2);
  pe = await openEdit(oEdit);
  tick(ownBoxes()[0], false);
  ed = await saveEdit(pe);
  ok("unticking sends customerOwned false", !!ed && ed.updates.length === 1 && ed.updates[0].customerOwned === false && d1.q("SELECT customerOwned FROM order_items WHERE orderId = ?", oEdit)[0].customerOwned === 0);
  pe = await openEdit(oEdit);
  q("#editOrderAddRow").click(); await idle();
  ok("an added line has the tick too", ownBoxes().length === 2);
  tick(ownBoxes()[1], true);
  ed = await saveEdit(pe);
  ok("an added line ticked is sent with customerOwned true", !!ed && ed.additions.length === 1 && ed.additions[0].customerOwned === true && ed.updates.length === 0);
  pe = await openEdit(oEdit);
  q("#editOrderAddRow").click(); await idle();
  ed = await saveEdit(pe);
  ok("…one not ticked isn't", !!ed && ed.additions.length === 1 && !("customerOwned" in ed.additions[0]));
  features({});
  pe = await openEdit(oEdit);
  ok("with the feature off: no tick, but a line already on the customer's garments still says so",
    ownBoxes().length === 0 && qa(".og-tag").filter(t => text(t) === "Customer's garments").length === 1);
  q("#editOrderCancel").click(); await pause(30); if (confirmBox()) confirmBox().querySelector("#cmOk").click(); await pe.p; await idle();
  features({ ownGarments: true });

  // ==============================================================================================================
  console.log("\n=== A line on the customer's own garments, on the Orders list ===");
  // ==============================================================================================================
  const oOwn = (await must({ action: "createLocalSale", org: "club", requestId: "seed406-own-abcdef", customerId: 1, customerName: "Pat Example", paymentMethod: "Cash",
    items: [{ productId: "mug", size: "", qty: 3, customerOwned: true }] })).orderId;
  await reload();
  const ownO = () => get(oOwn), ownIt = () => get(oOwn).items[0];
  const ownLine = (o, it) => { const h = d.createElement("div"); h.innerHTML = w.ownGarmentLineHtml_(o, it, "club"); return h; };
  ok("(the line is the customer's own, by its line number)", ownIt().customerOwned === true && ownIt().sheetRow != null);
  ok("its tag “Customer's garments” and “Check in garments…” for that line",
    text(ownLine(ownO(), ownIt()).querySelector(".og-tag")) === "Customer's garments" && !ownLine(ownO(), ownIt()).querySelector(".og-tag-in") &&
    text(ownLine(ownO(), ownIt()).querySelector("button")) === "Check in garments…" && ownLine(ownO(), ownIt()).querySelector("button").dataset.item === String(ownIt().sheetRow) &&
    ownLine(ownO(), ownIt()).querySelector("button").dataset.adminAction === "showGarmentCheckinFor_");
  ok("a line that isn't the customer's own has nothing", w.ownGarmentLineHtml_(ownO(), Object.assign({}, ownIt(), { customerOwned: false }), "club") === "" && w.ownGarmentLineHtml_(ownO(), null, "club") === "");
  ok("checked in: “Customer's garments · in” and “Garments…”", (() => { const h = ownLine(ownO(), Object.assign({}, ownIt(), { ownReceivedAt: noon("2026-12-14") }));
    return text(h.querySelector(".og-tag-in")) === "Customer's garments · in" && text(h.querySelector("button")) === "Garments…" && h.querySelector(".og-tag-in").title === "Checked in " + w.adminDate_(noon("2026-12-14")); })());
  ok("no button on a voided or completed order, or a cancelled line", !ownLine(Object.assign({}, ownO(), { voidedAt: "t" }), ownIt()).querySelector("button") &&
    !ownLine(Object.assign({}, ownO(), { completedAt: "t" }), ownIt()).querySelector("button") && !ownLine(ownO(), Object.assign({}, ownIt(), { cancelDate: "t" })).querySelector("button"));
  ok("…or a line with no number", !ownLine(ownO(), Object.assign({}, ownIt(), { sheetRow: null, id: null })).querySelector("button") && !!ownLine(ownO(), Object.assign({}, ownIt(), { sheetRow: null, id: 9 })).querySelector('button[data-item="9"]'));
  signInWith(withLevels("admin", { "orders.stepsEarly": "read" }));
  ok("a role that can only read the early steps: no Check in garments…, but Garments… once they're in (to see the count)",
    !ownLine(ownO(), ownIt()).querySelector("button") && !!ownLine(ownO(), Object.assign({}, ownIt(), { ownReceivedAt: "t" })).querySelector("button"));
  asRoles("admin");
  { const h = d.createElement("table"); h.innerHTML = "<tbody>" + w.orderRowsHtml_([ownO()], () => ORG, () => null, false) + "</tbody>";
    ok("the Orders row shows it beside the item's name", /Club Mug Customer's garments Check in garments…/.test(text(h))); }
  { const h = d.createElement("div"); h.innerHTML = w.orderCardHtml_(ownO(), ORG, null, false);
    ok("…and so does its card", /Customer's garments/.test(text(h.querySelector(".oc-item-main"))) && !!h.querySelector('.oc-item-main [data-admin-action="showGarmentCheckinFor_"]')); }

  // ==============================================================================================================
  console.log("\n=== Check in garments… ===");
  // ==============================================================================================================
  const og = () => { const m = modal(); return m && m.querySelector("#ogForm") ? m : null; };
  const ogq = (s) => og().querySelector(s);
  const ogRows = () => [...og().querySelectorAll(".og-row")];
  const cellVals = (tr) => [tr.querySelector(".og-size").value, tr.querySelector(".og-exp").value, tr.querySelector(".og-rec").value, tr.querySelector(".og-cond").value, tr.querySelector(".og-note").value];
  const ogErr = () => text(ogq("#ogErr"));
  const headParts = () => [...ogq(".og-head").querySelectorAll("strong, .og-dim")].map(text);
  const ogSave = async () => { fire(ogq("#ogForm"), "submit"); await idle(); };
  const closeOg = async () => { ogq("#ogCancel").click(); await wait(() => { if (confirmBox()) confirmBox().querySelector("#cmOk").click(); return !og(); }); };
  const openOg = async (oid = oOwn, itemId) => { reset(); w.__refreshed = []; const p = w.showGarmentCheckinFor_("club", oid, String(itemId != null ? itemId : ownIt().sheetRow)); await wait(() => !!og() || toasts.length > 0); await idle(); return { p }; };
  ok("the window's own script isn't loaded until a check-in is opened", fetched("admin-garments.js") === 0 && typeof w.showGarmentCheckin_ !== "function");
  reset(); await w.showGarmentCheckinFor_("club", oOwn, "99999");
  ok("a line that isn't in the list: “That line isn't in the list — refresh it.”", lastToast().m === "That line isn't in the list — refresh it." && lastToast().err && fetched("admin-garments.js") === 0);
  failScript = "admin-garments.js";
  await openOg();
  ok("the script can't be fetched: “Couldn't load the garment check-in”, no window", lastToast().m === "Couldn't load the garment check-in" && lastToast().err && !og());
  failScript = null;
  await openOg();
  ok("opened: the script fetched once more, and the line's check-ins asked for", fetched("admin-garments.js") === 2 && typeof w.showGarmentCheckin_ === "function" && same(of("listGarmentCheckins"), [{ action: "listGarmentCheckins", orderId: oOwn, org: "club" }]));
  ok("its title names the order; the line, its size and quantity, and the customer", text(og().querySelector("[data-dialog-title]")) === "Check in garments — " + oOwn && same(headParts(), ["Club Mug", "· One size · 3 on the order", "Pat Example"]));
  ok("one row to start: One size, 3 expected and 3 received, in good condition, no note", ogRows().length === 1 && same(cellVals(ogRows()[0]), ["One size", "3", "3", "good", ""]) &&
    same([...ogRows()[0].querySelector(".og-cond").options].map(o => text(o)), ["Good", "Damaged", "Other"]));
  ok("…the sum “3 of 3 received”; no last count, no Undo", text(ogq("#ogSum")) === "3 of 3 received" && !ogq("#ogLast") && !ogq("#ogUndo"));
  ok("…the waiver line, ticked, as Global settings has it", ogq("#ogWaiver").checked && !ogq("#ogWaiver").disabled && text(ogq(".og-waiver")) === "“" + WAIVER + "”");
  typeIn(ogRows()[0].querySelector(".og-rec"), "2");
  ok("2 received: “2 of 3 received · 1 size not as expected”", text(ogq("#ogSum")) === "2 of 3 received · 1 size not as expected");
  reset(); await ogSave();
  ok("a count that's off with no note: “Say what's different (a note) when the count or condition isn't as expected.”, nothing sent",
    ogErr() === "Say what's different (a note) when the count or condition isn't as expected." && of("checkInGarments").length === 0 && ogRows()[0].querySelector(".og-note").style.outline !== "");
  typeIn(ogRows()[0].querySelector(".og-rec"), "3");
  choose(ogRows()[0].querySelector(".og-cond"), "damaged");
  ok("a condition that isn't Good counts as not as expected too", text(ogq("#ogSum")) === "3 of 3 received · 1 size not as expected");
  await ogSave();
  ok("…and needs a note as well", ogErr() === "Say what's different (a note) when the count or condition isn't as expected." && of("checkInGarments").length === 0);
  choose(ogRows()[0].querySelector(".og-cond"), "good");
  ogq("#ogAdd").click(); await idle();
  ok("+ Another size adds an empty row (expecting none)", ogRows().length === 2 && same(cellVals(ogRows()[1]), ["", "0", "0", "good", ""]) && text(ogq("#ogSum")) === "3 of 3 received");
  await ogSave();
  ok("a row with no size: “Name the size (or One size).”", ogErr() === "Name the size (or One size).");
  typeIn(ogRows()[1].querySelector(".og-size"), "one SIZE");
  await ogSave();
  ok("the same size twice (in any case): “one SIZE is listed twice — put it on one row.”", ogErr() === "one SIZE is listed twice — put it on one row.");
  typeIn(ogRows()[1].querySelector(".og-size"), "XL");
  typeIn(ogRows()[1].querySelector(".og-exp"), "");
  await ogSave();
  ok("no expected count: “Expected for XL: a whole number from 0 to 5000.”", ogErr() === "Expected for XL: a whole number from 0 to 5000.");
  typeIn(ogRows()[1].querySelector(".og-exp"), "1.5"); await ogSave();
  ok("…nor a part of one", ogErr() === "Expected for XL: a whole number from 0 to 5000.");
  typeIn(ogRows()[1].querySelector(".og-exp"), "1");
  typeIn(ogRows()[1].querySelector(".og-rec"), "5001"); await ogSave();
  ok("received over 5000: “Received for XL: a whole number from 0 to 5000.”", ogErr() === "Received for XL: a whole number from 0 to 5000.");
  typeIn(ogRows()[1].querySelector(".og-rec"), "-1"); await ogSave();
  ok("…or below 0", ogErr() === "Received for XL: a whole number from 0 to 5000.");
  ogRows()[1].querySelector(".og-remove").click(); await idle();
  ok("× takes a row off", ogRows().length === 1 && ogErr() === "");
  ogRows()[0].querySelector(".og-remove").click(); await idle();
  ok("…but not the last one: “Keep at least one size.”", ogRows().length === 1 && ogErr() === "Keep at least one size.");
  for (let i = 0; i < 29; i++) ogq("#ogAdd").click();
  ok("at most 30 sizes: + Another size is then disabled", ogRows().length === 30 && ogq("#ogAdd").disabled);
  ogq("#ogAdd").disabled = false; ogq("#ogAdd").click();
  ok("…and adds nothing even if clicked", ogRows().length === 30);
  while (ogRows().length > 1) ogRows()[1].querySelector(".og-remove").click();
  typeIn(ogRows()[0].querySelector(".og-rec"), "2"); typeIn(ogRows()[0].querySelector(".og-note"), "  one short <i>pat</i>  ");
  scripted = [{ action: "checkInGarments", status: 409, body: { status: "error", message: "Not now." } }];
  reset(); await ogSave();
  ok("refused by the server: its words in the window, Save usable again", ogErr() === "Not now." && !ogq("#ogSave").disabled && !!og());
  scripted = [{ action: "checkInGarments", empty: true }];
  await ogSave();
  ok("…a failure with no words: “Couldn't save the check-in.”", ogErr() === "Couldn't save the check-in.");
  reset(); await ogSave();
  ok("Save check-in sends the line and its count (the note trimmed)", same(of("checkInGarments"), [{ action: "checkInGarments", orderId: oOwn, itemId: ownIt().sheetRow,
    counts: [{ size: "One size", expectedQty: 3, receivedQty: 2, condition: "good", note: "one short <i>pat</i>" }], org: "club" }]));
  ok("…closes with “Garments checked in: 2 for Club Mug.” and the row is read again", !og() && lastToast().m === "Garments checked in: 2 for Club Mug." && same(w.__refreshed, [["club", [oOwn]]]));
  ok("…saved: the line's garments are in", !!d1.q("SELECT ownReceivedAt FROM order_items WHERE orderId = ?", oOwn)[0].ownReceivedAt &&
    d1.q("SELECT receivedQty, note FROM garment_checkins WHERE orderId = ? AND voidedAt IS NULL", oOwn).length === 1);
  await reload();
  await openOg();
  ok("opened again: when and by whom it was checked in, and that saving again replaces it", /^Checked in .+ by owner@example\.test\. Saving again replaces that count\.$/.test(text(ogq("#ogLast"))));
  ok("…the last count is the starting point (the note as text)", ogRows().length === 1 && same(cellVals(ogRows()[0]), ["One size", "3", "2", "good", "one short <i>pat</i>"]) && !ogRows()[0].querySelector("i"));
  ok("…with Undo check-in", !!ogq("#ogUndo") && text(ogq("#ogUndo")) === "Undo check-in");

  console.log("\n--- The slip ---");
  w.__printed = 0;
  ogq("#ogPrint").click(); await idle();
  { const slip = d.createElement("div"); slip.innerHTML = w.__slipAtPrint || "";
    ok("Print slip prints a slip on its own (the page hidden while it prints)", w.__printed === 1 && w.__printingClass === true);
    ok("…headed “… — Garment check-in”, with the order, the customer, the item and when it was checked in",
      /— Garment check-in$/.test(text(slip.querySelector(".og-slip-h"))) && same([...slip.querySelectorAll(".og-slip-facts th")].map(text), ["Order", "Customer", "Item", "Checked in"]) &&
      text(slip.querySelector(".og-slip-facts")).includes(oOwn) && text(slip.querySelector(".og-slip-facts")).includes("Pat Example"));
    ok("…the counts as the form shows them, the condition in words, the note as text",
      same([...slip.querySelectorAll(".og-slip-counts tbody td")].map(text), ["One size", "3", "2", "Good", "one short <i>pat</i>"]) && !slip.querySelector(".og-slip-counts i"));
    ok("…the waiver line and a place to sign", text(slip.querySelector(".og-slip-waiver")) === WAIVER && /Customer signature\s*Date/.test(text(slip.querySelector(".og-slip-sign")))); }
  ok("…the slip stays while the browser prints", !!id("ogSlipPrint") && d.body.classList.contains("og-printing"));
  w.dispatchEvent(new w.Event("afterprint"));
  ok("…and goes once printing is done, the page back", !id("ogSlipPrint") && !d.body.classList.contains("og-printing"));
  tick(ogq("#ogWaiver"), false);
  ogq("#ogPrint").click(); await idle();
  ok("the waiver unticked: the slip prints without it", w.__printed === 2 && !/og-slip-waiver/.test(w.__slipAtPrint));
  w.dispatchEvent(new w.Event("afterprint"));
  { const was = w.print; w.print = () => { throw new Error("no printer"); };
    ogq("#ogPrint").click(); await idle();
    w.dispatchEvent(new w.Event("afterprint"));
    ok("no printer: nothing breaks, and the slip is tidied away", !id("ogSlipPrint") && !d.body.classList.contains("og-printing"));
    w.print = was; }

  console.log("\n--- Undo ---");
  reset();
  ogq("#ogUndo").click();
  let said = await answer(false); await idle();
  ok("Undo asks first: “Undo this check-in? The count is taken back and the line waits for the customer's garments again.”",
    /^Undo this check-in\?\s+The count is taken back and the line waits for the customer's garments again\.$/.test(said) && of("undoGarmentCheckin").length === 0 && !!og());
  scripted = [{ action: "undoGarmentCheckin", status: 409, body: { status: "error", message: "Too late." } }];
  ogq("#ogUndo").click(); await answer(true); await idle();
  ok("refused: its words in the window, Undo usable again", ogErr() === "Too late." && !ogq("#ogUndo").disabled);
  scripted = [{ action: "undoGarmentCheckin", empty: true }];
  ogq("#ogUndo").click(); await answer(true); await idle();
  ok("…with no words: “Couldn't undo the check-in.”", ogErr() === "Couldn't undo the check-in.");
  reset(); w.__refreshed = [];
  ogq("#ogUndo").click(); await answer(true); await idle();
  ok("Yes: sent, “Check-in taken back.”, the row read again", same(of("undoGarmentCheckin"), [{ action: "undoGarmentCheckin", orderId: oOwn, itemId: ownIt().sheetRow, org: "club" }]) &&
    !og() && lastToast().m === "Check-in taken back." && same(w.__refreshed, [["club", [oOwn]]]) && !d1.q("SELECT ownReceivedAt FROM order_items WHERE orderId = ?", oOwn)[0].ownReceivedAt);
  await reload();
  await openOg();
  typeIn(ogRows()[0].querySelector(".og-rec"), "0"); typeIn(ogRows()[0].querySelector(".og-note"), "not here yet");
  reset(); await ogSave();
  ok("a count of nothing received: “Check-in saved: nothing received yet, so the line still waits for the garments.”",
    lastToast().m === "Check-in saved: nothing received yet, so the line still waits for the garments." && !d1.q("SELECT ownReceivedAt FROM order_items WHERE orderId = ?", oOwn)[0].ownReceivedAt);
  await reload();

  console.log("\n--- What the window starts from ---");
  scripted = [{ action: "listGarmentCheckins", status: 500, body: { status: "error", message: "Down." } }];
  await openOg();
  ok("the check-ins can't be read and the order carried none: “Couldn't load the garment check-ins: Down.”, no window", lastToast().m === "Couldn't load the garment check-ins: Down." && lastToast().err && !og());
  const withRows = Object.assign({}, ownIt(), { checkins: [{ itemId: ownIt().sheetRow, size: "M", expectedQty: 3, receivedQty: 3, condition: "weird", note: "", at: noon("2026-12-14"), by: "" },
    { itemId: ownIt().sheetRow, size: "L", expectedQty: 1, receivedQty: 1, condition: "good", note: "", at: noon("2026-12-13"), by: "", voidedAt: "t" }, { itemId: 424242, size: "S", expectedQty: 1, receivedQty: 1 }] });
  scripted = [{ action: "listGarmentCheckins", status: 500, body: { status: "error", message: "Down." } }];
  reset(); let gp = w.showGarmentCheckin_(oOwn, withRows, { orgId: "club", order: { customerName: "Pat Example", company: "Example Club Boosters" } }); await wait(() => !!og()); await idle();
  ok("…but with the order's own live rows it opens on them (a condition it doesn't know read as Good; voided rows and other lines left out)",
    ogRows().length === 1 && same(cellVals(ogRows()[0]), ["M", "3", "3", "good", ""]) && /^Checked in .+\. Saving again replaces that count\.$/.test(text(ogq("#ogLast"))) && !/ by /.test(text(ogq("#ogLast"))));
  ok("…the customer and company both named", headParts()[2] === "Pat Example · Example Club Boosters");
  await closeOg();
  scripted = [{ action: "listGarmentCheckins", body: { status: "ok", rows: [{ itemId: ownIt().sheetRow, size: "S", expectedQty: "x", receivedQty: 2, condition: "other", note: "seams", at: noon("2026-12-14"), by: "sam@example.com" }], waiver: "" } }];
  await openOg();
  ok("rows answered as `rows`, a count that isn't a number read as 0", ogRows().length === 1 && same(cellVals(ogRows()[0]), ["S", "0", "2", "other", "seams"]) && /by sam@example\.com\./.test(text(ogq("#ogLast"))));
  ok("no waiver line saved: its tick off and disabled, with a note saying where to set one", !ogq("#ogWaiver").checked && ogq("#ogWaiver").disabled && !ogq(".og-waiver") &&
    /No waiver line is set \(Global settings → Features → Customer-supplied garments\)\./.test(text(og())));
  ogq("#ogPrint").click(); await idle(); w.dispatchEvent(new w.Event("afterprint"));
  ok("…and the slip has none", !/og-slip-waiver/.test(w.__slipAtPrint));
  await closeOg();
  scripted = [{ action: "listGarmentCheckins", body: { status: "ok" } }];
  w.eval('siteFeatures.ownGarmentsWaiver = "  From the catalog.  "');
  await openOg();
  ok("an answer with no waiver: the catalog's line, trimmed", text(ogq(".og-waiver")) === "“From the catalog.”");
  await closeOg();
  scripted = [{ action: "listGarmentCheckins", body: { status: "ok" } }];
  w.eval('delete siteFeatures.ownGarmentsWaiver');
  await openOg();
  ok("…and with none there either, the usual sentence", text(ogq(".og-waiver")) === "“" + WAIVER + "”");
  typeIn(ogRows()[0].querySelector(".og-note"), "x");
  ogq("#ogCancel").click(); await pause(30);
  ok("Cancel after typing asks before throwing it away", !!confirmBox());
  await answer(true); await wait(() => !og());
  reset(); await w.showGarmentCheckin_("", ownIt(), {});
  ok("no order or line given: “That line can't be found — refresh the list.”", lastToast().m === "That line can't be found — refresh the list." && !og());
  reset(); await w.showGarmentCheckin_(oOwn, { name: "Loose", qty: 1 }, {});
  ok("…nor a line with no number", lastToast().m === "That line can't be found — refresh the list.");
  reset(); gp = w.showGarmentCheckin_(oOwn, { itemId: ownIt().sheetRow, name: "", size: " L ", qty: "2.5" }, {}); await wait(() => !!og()); await idle();
  ok("a line given by itemId, with no shop: asked without one; its own size shown, a quantity that isn't whole read as 0; the rows from the last count (nothing received)",
    same(of("listGarmentCheckins"), [{ action: "listGarmentCheckins", orderId: oOwn }]) && same(headParts(), ["", "· L · 0 on the order"]) && same(cellVals(ogRows()[0]), ["One size", "3", "0", "good", "not here yet"]));
  typeIn(ogRows()[0].querySelector(".og-rec"), "1"); typeIn(ogRows()[0].querySelector(".og-note"), "extra");
  reset(); await ogSave();
  ok("…saved without a shop, and the toast names “the line”", of("checkInGarments").length === 1 && !("org" in of("checkInGarments")[0]) && lastToast().m === "Garments checked in: 1 for the line.");
  await reload();

  console.log("\n--- By role ---");
  signInWith(withLevels("admin", { "orders.stepsEarly": "read" }));
  await openOg();
  ok("a role that can only read the early steps: everything disabled, no Save, Undo or + Another size; Print slip and Close only",
    ogRows().every(tr => [...tr.querySelectorAll("input, select")].every(e => e.disabled)) && !ogq("#ogSave") && !ogq("#ogUndo") && !ogq("#ogAdd") && !ogq(".og-remove") &&
    text(ogq("#ogCancel")) === "Close" && !!ogq("#ogPrint") && /^Checked in .+\.$/.test(text(ogq("#ogLast"))) && !/Saving again/.test(text(ogq("#ogLast"))));
  fire(ogq("#ogForm"), "submit"); await idle();
  ok("…a submit sends nothing", of("checkInGarments").length === 0);
  ogq("#ogCancel").click(); await wait(() => !og());
  asRoles("staff");
  await openOg();
  ok("Back office (Edit on the early steps) can check garments in", !!ogq("#ogSave") && !ogRows()[0].querySelector(".og-rec").disabled);
  await closeOg();
  asRoles("admin");

  // Every order made "now" above gets a fixed day too, so nothing below depends on the machine's date.
  d1._raw.exec(`UPDATE orders SET placedAt = '${noon("2026-12-13")}' WHERE placedAt NOT LIKE '%T12:00:00.000Z'`);

  const oSale2 = (await must({ action: "getUnpaidPoReport", asOf: TODAY })).rows.find(r => r.poStatus === "PO needed" && r.customerName === "Local Sale").orderId;

  // ==============================================================================================================
  console.log("\n=== Home: the Unpaid POs block and POs to check ===");
  // ==============================================================================================================
  const goHome = async () => { reset(); w.history.replaceState(null, "", "#home"); await w.adminRoute(); await wait(() => !!id("homeStages") && of("getDashboard").length > 0); await idle(); };
  const poBlock = () => q('[data-home-block="unpaidpos"]');
  const poCards = () => qa('[data-home-block="unpaidpos"] .home-po-card').map(c => [text(c.querySelector(".home-lbl")), text(c.querySelector(".home-val")), text(c.querySelector(".home-hint")), c.classList.contains("home-card-warn")]);
  const newHint = () => text(q('#homeStages .home-tile[data-stage="new"] .home-hint'));
  await goHome();
  ok("Home asks for today's figures (the page's fixed today)", of("getDashboard")[0].today === TODAY);
  ok("an admin's Home has an Unpaid POs block after Business totals", !!poBlock() && text(poBlock().querySelector(".home-h")) === "Unpaid POs" &&
    [...d.querySelectorAll("[data-home-block]")].map(e => e.dataset.homeBlock).filter(k => ["totals", "unpaidpos", "inout"].includes(k)).join() === "totals,unpaidpos,inout");
  ok("…10 Net 30 orders still owed, $120.00 owed, $50.00 late (in red), 1 PO to check (in red)", same(poCards(), [
    ["Unpaid POs", "10", "Net 30 orders still owed", false], ["Owed", "$120.00", "On Net 30 terms, all shops", false], ["Late", "$50.00", "Past the due date", true],
    ["POs to check", "1", "Typed by customers — accept each one", true]]));
  ok("…with a link to the report", !!poBlock().querySelector('a[href="#unpaidpos"]') && text(poBlock().querySelector('a[href="#unpaidpos"]')) === "Unpaid POs report →");
  ok("the New tile says how many POs wait to be checked", newHint() === "Waiting for payment · 1 PO to check");
  asRoles("staff");
  await goHome();
  ok("Back office: the block with the counts only — no money", !!poBlock() && same(poCards(), [["Unpaid POs", "10", "Net 30 orders still owed", false], ["POs to check", "1", "Typed by customers — accept each one", true]]) && !/\$/.test(text(poBlock())));
  ok("…and the New tile's count too", newHint() === "Waiting for payment · 1 PO to check");
  { const real = await must({ action: "getDashboard", today: TODAY, blocks: ["orders", "totals"] });
    const shaped = Object.assign({}, real, { poToCheck: 2 }); delete shaped.unpaidPos;
    scripted = [{ action: "getDashboard", body: shaped }];
    await goHome();
    ok("an answer with only the orders part's own count (poToCheck): the New tile says “2 POs to check”", newHint() === "Waiting for payment · 2 POs to check"); }
  asRoles("production");
  await goHome();
  ok("Production (can't open the report): no block, and the New tile says nothing of POs", !poBlock() && newHint() === "Waiting for payment");
  signInWith(withLevels("staff", { "reports.receivables": "none" }), "staff");
  await goHome();
  ok("a role with orders but not the report: no block", !poBlock());
  asRoles("admin");
  { const h = (p) => { const x = d.createElement("div"); x.innerHTML = w.homeUnpaidPos_(p); return x; };
    const cards = (x) => [...x.querySelectorAll(".home-po-card")].map(c => [text(c.querySelector(".home-lbl")), text(c.querySelector(".home-val")), text(c.querySelector(".home-hint")), c.classList.contains("home-card-warn")]);
    ok("one order, nothing late or to check: “Net 30 order still owed”, “Nothing past its due date”, “None waiting”, nothing in red",
      same(cards(h({ count: 1, owedCents: 1250, lateCents: 0, toCheck: 0 })), [["Unpaid POs", "1", "Net 30 order still owed", false], ["Owed", "$12.50", "On Net 30 terms, all shops", false], ["Late", "$0.00", "Nothing past its due date", false], ["POs to check", "0", "None waiting", false]]));
    ok("money sent as dollars is read too", same(cards(h({ count: 2, owed: 5, late: "x" })).slice(1, 3).map(c => c[1]), ["$5.00", "$0.00"]));
    ok("nothing sent: “The Unpaid POs figures didn't come back — try Refresh.”, with the link", /The Unpaid POs figures didn't come back — try Refresh\./.test(text(h(null))) && !!h(null).querySelector('a[href="#unpaidpos"]') && /didn't come back/.test(text(h("x"))));
    signInWith(withLevels("admin", { "reports.receivables": "none" }));
    ok("…the link only for a role that can open the report", !h(null).querySelector("a"));
    asRoles("admin");
  }
  reset();
  w.history.replaceState(null, "", "#home/new"); await w.adminRoute(); await wait(() => of("getOpenOrdersByStage").length > 0 || /Waiting for payment/.test(text(app)), 300); await idle();
  ok("the New list (#home/new) shows a Net 30 order's tag beside its customer", qa("#app tr").some(tr => /Pat Example/.test(text(tr)) && /Net 30 — PO to check/.test(text(tr))));

  // ==============================================================================================================
  console.log("\n=== Reports → Unpaid POs: the route ===");
  // ==============================================================================================================
  const arPage = () => id("arPage");
  const drawn = () => !!arPage() && !/Loading…/.test(text(id("arBody")));
  const goAr = async () => { const old = arPage(); reset(); if (hashNow() === "unpaidpos") w.adminRoute(); else w.location.hash = "#unpaidpos"; await wait(() => arPage() && arPage() !== old && drawn()); await idle(); };
  w.openOrderFromDashboard_ = (org, oid, placed) => { w.__opened = [org, oid, placed]; };
  w.location.hash = "#home"; await idle();
  failScript = "admin-receivables.js";
  reset(); w.location.hash = "#unpaidpos";
  await wait(() => /Couldn't load the Unpaid POs page/.test(text(app)));
  ok("the page's script can't be fetched: “Couldn't load the Unpaid POs page. Check your connection and reload the page.”, nothing asked",
    /Couldn't load the Unpaid POs page\. Check your connection and reload the page\./.test(text(app)) && of("getUnpaidPoReport").length === 0 && d.title.includes("Unpaid POs"));
  failScript = null;
  w.location.hash = "#home"; await idle();
  { let release; const gate = new Promise(r => { release = r; });
    scriptGate = { name: "admin-receivables.js", gate };
    reset(); w.location.hash = "#unpaidpos"; await pause(30);
    w.location.hash = "#home"; await idle();
    release(); await pause(30); await idle();
    ok("the page left while its script was still arriving: nothing drawn, nothing asked", !arPage() && of("getUnpaidPoReport").length === 0 && typeof w.renderUnpaidPos === "function"); }
  await goAr();
  ok("…opened later: the page draws (its script asked for twice in all)", fetched("admin-receivables.js") === 2 && !!arPage() && typeof w.renderUnpaidPos === "function");
  w.location.hash = "#home"; await idle();
  await goAr();
  ok("opened again: the script isn't fetched a third time", fetched("admin-receivables.js") === 2);
  asRoles("production");
  w.location.hash = "#home"; await idle();
  reset(); w.location.hash = "#unpaidpos"; await wait(() => !!id("roleOffPanel"));
  ok("Production is told “Not available to you”, and nothing is asked", /Not available to you\./.test(text(app)) && of("getUnpaidPoReport").length === 0);
  asRoles("admin");
  w.location.hash = "#home"; await idle();
  { let release; const gate = new Promise(r => { release = r; });
    scripted = [{ action: "getUnpaidPoReport", gate, body: { status: "ok", rows: [{ orderId: "LATE-1", group: "nopo", poStatus: "PO needed", owedCents: 100 }] } }];
    w.location.hash = "#unpaidpos"; await wait(() => !!arPage());
    w.location.hash = "#home"; await idle();
    release(); await pause(30); await idle();
    ok("an answer arriving after the page was left draws nothing", !arPage() && !/LATE-1/.test(text(app))); }

  // ==============================================================================================================
  console.log("\n=== Reports → Unpaid POs: the page ===");
  // ==============================================================================================================
  await goAr();
  ok("the tab says Unpaid POs and the address is #unpaidpos", d.title.includes("Unpaid POs") && hashNow() === "unpaidpos");
  ok("as of today by default, asked for that day with no shop or customer", id("arAsOf").value === TODAY && same(of("getUnpaidPoReport"), [{ action: "getUnpaidPoReport", asOf: TODAY }]));
  ok("the Shop filter: All shops, then each shop by name", same([...id("arOrg").options].map(o => o.value + "=" + text(o)), ["=All shops", "club=Example Club", "school=Example School Shop"]));
  ok("the Customer filter: All customers, then each customer record owing (not walk-ins)", same([...id("arCustomer").options].map(o => o.value + "=" + text(o)), ["=All customers", "2=Example School District", "1=Pat Example"]));
  const totals = () => qa("#arTotals .gc-total").map(c => [text(c.querySelector(".gc-total-l")), text(c.querySelector(".gc-total-n")), text(c.querySelector(".gc-total-note")), c.classList.contains("ar-total-warn")]);
  ok("the totals: $120.00 owed on 10 orders, $50.00 late (in red), 1 PO to check (in red)", same(totals(), [
    ["Owed on Net 30", "$120.00", "10 orders", false], ["Late", "$50.00", "Past the due date", true], ["POs to check", "1", "Typed by the customer — accept each one", true]]));
  const strip = () => qa("#arGroups .ar-group").map(b => [b.dataset.arGroup, text(b.querySelector(".ar-group-l")), text(b.querySelector(".ar-group-n")), text(b.querySelector(".ar-group-m"))]);
  ok("the group strip, in order, with counts and money", same(strip(), [["nopo", "No PO yet", "2", "$20.00"], ["tocheck", "PO to check", "1", "$10.00"], ["notdue", "Not yet due", "3", "$40.00"],
    ["1-30", "1–30 days late", "1", "$20.00"], ["31-60", "31–60 days late", "1", "$10.00"], ["61-90", "61–90 days late", "1", "$10.00"], ["90+", "Over 90 days late", "1", "$10.00"]]) &&
    qa("#arGroups .ar-group").every(b => b.getAttribute("aria-pressed") === "false" && !b.classList.contains("ar-group-zero")));
  ok("the basis: as of today, from the invoice, with a link to the setting",
    text(id("arBasis")) === "As of " + w.adminDate_(TODAY) + ". Due dates count from the day the invoice was first sent (the order date when no invoice was sent), plus the order's terms (the customer's own days, else the default) — change it under Global settings → Net 30 terms. A day is late once it is past the due date; due today isn't late yet." &&
    !!id("arBasis").querySelector('a[href="#settings"]'));
  ok("Export CSV is usable", !id("arCsv").disabled);
  const custRows = () => qa("#arBody table.ar-customers tbody tr").map(tr => [...tr.children].map(text));
  ok("By customer: who owes what, most first; “—” where nothing is late; a walk-in's name as text", same(custRows(), [
    ["Example School District", "4", "$50.00", "$30.00"], ["Local Sale", "2", "$30.00", "—"], ["Pat Example", "3", "$30.00", "$10.00"], [WALKIN, "1", "$10.00", "$10.00"]]) &&
    !q("#arBody table.ar-customers b") && q("#arBody table.ar-customers tbody tr:nth-child(1) td:nth-child(4)").classList.contains("ar-late"));
  const arRows = () => qa("#arBody table.ar-rows tbody tr");
  const rowFor = (oid) => arRows().find(tr => tr.querySelector("td").textContent.includes(oid));
  const cells = (tr) => [...tr.children].map(text);
  ok("the orders heading: “Orders (10)”, every row listed", /^Orders \(10\)$/.test(text(q("#arBody .cust-h-row h3"))) && arRows().length === 10);
  ok("…in the report's order: No PO first, the most late last", arRows()[0].querySelector("[data-ar-open]") && text(arRows()[0].querySelector("[data-ar-open]")) === oNoPo && text(arRows()[9].querySelector("[data-ar-open]")) === o90);
  ok("a row: the order (a button) with its shop and day, the customer linked to their page, the PO, Late, not invoiced, the due date with its days, 14 days late, $20.00 of $30.00",
    same(cells(rowFor(o130)), [o130 + " Example Club · placed " + w.adminDate_("2026-11-01"), "Example School District", "PO-1005", "Late", "Not sent", w.adminDate_("2026-12-01") + "Net 30", "14", "$20.00of $30.00", ""]) &&
    rowFor(o130).querySelector('a.cust-link').getAttribute("href") === "#customers/2" && rowFor(o130).children[6].classList.contains("ar-late"));
  ok("a PO to check: “PO to check” and Accept PO", same(cells(rowFor(oCheck)).slice(2, 5), ["PO-1002", "PO to check", "Not sent"]) && !!rowFor(oCheck).querySelector("[data-ar-accept]") &&
    text(rowFor(oCheck).querySelector("[data-ar-accept]")) === "Accept PO" && rowFor(oCheck).querySelector("[data-ar-accept]").dataset.need === "orders.terms:edit");
  ok("no PO yet: “—” for the PO, “PO needed”, nothing late, no Accept PO", same(cells(rowFor(oNoPo)).slice(2, 4), ["—", "PO needed"]) && cells(rowFor(oNoPo))[6] === "—" && !rowFor(oNoPo).querySelector("[data-ar-accept]"));
  ok("an accepted PO not yet due: “PO 1003”, “PO accepted”, invoiced Dec 2", same(cells(rowFor(oOk)).slice(2, 5), ["PO 1003", "PO accepted", w.adminDate_("2026-12-02")]));
  ok("a walk-in: its name as text, no link; its PO “PO +1007”", cells(rowFor(o90))[1] === WALKIN && !rowFor(o90).querySelector("a.cust-link") && !rowFor(o90).querySelector("b") && cells(rowFor(o90))[2] === "PO +1007");
  ok("the other shop's order is there with its shop's name", /Example School Shop · placed/.test(cells(rowFor(oSchool))[0]));
  ok("a paid order and one placed after today aren't", !rowFor(oPaid) && !rowFor(oFuture));
  rowFor(o130).querySelector("[data-ar-open]").click(); await idle();
  ok("the order's button opens it in its shop's orders", same(w.__opened, ["club", o130, noon("2026-11-01")]));

  console.log("\n--- Groups ---");
  q('#arGroups [data-ar-group="1-30"]').click(); await idle();
  ok("a group clicked: only its orders, “Orders — 1–30 days late (1)”, its button pressed, nothing asked again",
    arRows().length === 1 && /^Orders — 1–30 days late \(1\)$/.test(text(q("#arBody .cust-h-row h3"))) && q('#arGroups [data-ar-group="1-30"]').getAttribute("aria-pressed") === "true" &&
    q('#arGroups [data-ar-group="1-30"]').classList.contains("on") && of("getUnpaidPoReport").length === 1);
  q('#arGroups [data-ar-group="1-30"]').click(); await idle();
  ok("clicked again: every group", arRows().length === 10);
  q('#arGroups [data-ar-group="90+"]').click(); await idle();
  q('#arBody [data-ar-group=""]').click(); await idle();
  ok("“Show every group” does the same", arRows().length === 10 && !q('#arBody [data-ar-group=""]'));

  console.log("\n--- The CSV ---");
  const downloads = [];
  const aClick = w.HTMLAnchorElement.prototype.click;
  w.HTMLAnchorElement.prototype.click = function () { if (this.download) downloads.push(this.download); else return aClick.call(this); };
  const csvText = async () => { const b = blobs[blobs.length - 1]; return b ? await new Promise(res => { const r = new w.FileReader(); r.onload = () => res(r.result); r.readAsText(b); }) : ""; };
  const csvLines = async () => (await csvText()).split("\r\n").filter(Boolean);
  id("arCsv").click(); await idle();
  let csv = await csvLines();
  ok("Export CSV downloads unpaid-pos-2026-12-15.csv", downloads[downloads.length - 1] === "unpaid-pos-2026-12-15.csv");
  ok("…with these columns", csv[0] === "Order #,Shop,Customer,Company,PO number,PO status,Group,Placed,Invoiced,Completed,Terms (days),Due,Days late,Total,Received,Owed");
  ok("…a row per order (10)", csv.length === 11);
  ok("…money in dollars, days as figures, the group's name", csv.includes(`${o130},Example Club,Example School District,Example School District,PO-1005,accepted,1–30 days late,2026-11-01,,,30,2026-12-01,14,30,10,20`));
  ok("…a name that starts like a formula is kept as text (a ' in front), and so is a PO starting with +",
    csv.some(l => l.startsWith(o90 + ",Example Club,\"'=HYPERLINK(\"\"http://x.example\"\",\"\"<b>Walk-in</b>\"\")\",,'+1007,accepted,Over 90 days late,2026-08-01,,,30,2026-08-31,106,10,0,10")));
  ok("…an invoiced order carries its invoice day, a PO needed none", csv.some(l => l.startsWith(oOk + ",") && l.includes(",2026-12-01,2026-12-02,,30,2027-01-01,0,10,0,10")) && csv.some(l => l.startsWith(oNoPo + ",") && l.includes(",,PO needed,No PO yet,")));
  q('#arGroups [data-ar-group="nopo"]').click(); await idle();
  id("arCsv").click(); await idle();
  csv = await csvLines();
  ok("with a group picked, only its orders go in the file", csv.length === 3 && csv.slice(1).every(l => l.includes(",No PO yet,")));
  q('#arGroups [data-ar-group="nopo"]').click(); await idle();

  console.log("\n--- Accept PO ---");
  reset();
  rowFor(oCheck).querySelector("[data-ar-accept]").click();
  let said2 = await answer(false); await idle();
  ok("Accept PO asks first: “Accept PO-1002 for order …? … the order stays on this report until then.”",
    /^Accept PO-1002 for order .+\?\s+The order is cleared for work: blanks, the run and delivery go ahead\. The money stays owed until it's paid, and the order stays on this report until then\.$/.test(said2) && of("acceptOrderPo").length === 0);
  scripted = [{ action: "acceptOrderPo", status: 409, body: { status: "error", message: "Busy." } }];
  rowFor(oCheck).querySelector("[data-ar-accept]").click(); await answer(true); await idle();
  ok("refused: “Couldn't accept the PO: Busy.”, the button usable again", lastToast().m === "Couldn't accept the PO: Busy." && lastToast().err && !rowFor(oCheck).querySelector("[data-ar-accept]").disabled);
  scripted = [{ action: "acceptOrderPo", empty: true }];
  rowFor(oCheck).querySelector("[data-ar-accept]").click(); await answer(true); await idle();
  ok("…with no words: “Couldn't accept the PO: unknown error”", lastToast().m === "Couldn't accept the PO: unknown error");
  reset();
  rowFor(oCheck).querySelector("[data-ar-accept]").click(); await answer(true); await idle();
  ok("Yes: accepted (“PO-1002 accepted for order ….”) and the report read again", same(of("acceptOrderPo"), [{ action: "acceptOrderPo", orderId: oCheck, org: "club" }]) &&
    lastToast().m === "PO-1002 accepted for order " + oCheck + "." && of("getUnpaidPoReport").length === 1 && !!orderRow(oCheck).poAcceptedAt);
  ok("…the order moves to Not yet due, and nothing is left to check (“None waiting”)", cells(rowFor(oCheck))[3] === "PO accepted" && !rowFor(oCheck).querySelector("[data-ar-accept]") &&
    same(totals()[2], ["POs to check", "0", "None waiting", false]) && strip()[1][2] === "0" && q('#arGroups [data-ar-group="tocheck"]').classList.contains("ar-group-zero"));
  q('#arGroups [data-ar-group="tocheck"]').click(); await idle();
  ok("an empty group: “No order in this group.”, and nothing to export", /No order in this group\./.test(text(id("arBody"))) && id("arCsv").disabled);
  id("arCsv").disabled = false; reset(); id("arCsv").click(); await idle();
  ok("…Export forced anyway: “There are no orders to export.”", lastToast().m === "There are no orders to export." && lastToast().err);
  q('#arGroups [data-ar-group="tocheck"]').click(); await idle();

  console.log("\n--- Filters ---");
  reset(); choose(id("arAsOf"), "2026-12-20"); await idle();
  ok("another as-of day: asked for that day; an order placed by then now counts", same(of("getUnpaidPoReport").map(b => b.asOf), ["2026-12-20"]) && !!rowFor(oFuture) && text(id("arBasis")).startsWith("As of " + w.adminDate_("2026-12-20") + "."));
  reset(); choose(id("arAsOf"), ""); await idle();
  ok("an emptied date asks for nothing", of("getUnpaidPoReport").length === 0);
  reset(); id("arToday").click(); await idle();
  ok("Today goes back to today", id("arAsOf").value === TODAY && same(of("getUnpaidPoReport").map(b => b.asOf), [TODAY]));
  q('#arGroups [data-ar-group="notdue"]').click(); await idle();
  reset(); choose(id("arOrg"), "school"); await idle();
  ok("a shop picked: asked for that shop alone, the group cleared", same(of("getUnpaidPoReport"), [{ action: "getUnpaidPoReport", asOf: TODAY, orgId: "school" }]) && arRows().length === 1 && !!rowFor(oSchool) &&
    !q("#arGroups .ar-group.on"));
  ok("…one customer owing, but no customer picked: By customer is still shown", custRows().length === 1 && custRows()[0][0] === "Example School District");
  ok("…the Customer filter now lists that shop's customers", same([...id("arCustomer").options].map(o => o.value), ["", "2"]));
  reset(); choose(id("arCustomer"), "2"); await idle();
  ok("a customer picked: asked for the shop and that customer (a number)", same(of("getUnpaidPoReport"), [{ action: "getUnpaidPoReport", asOf: TODAY, orgId: "school", customerId: 2 }]) && !q("#arBody table.ar-customers"));
  reset(); choose(id("arOrg"), ""); await idle();
  ok("changing the shop clears the customer", same(of("getUnpaidPoReport"), [{ action: "getUnpaidPoReport", asOf: TODAY }]) && id("arCustomer").value === "" && arRows().length === 10);
  reset(); q('#arBody table.ar-customers [data-ar-cust="0"]').click(); await idle();
  ok("a customer's name in By customer shows only their orders", same(of("getUnpaidPoReport"), [{ action: "getUnpaidPoReport", asOf: TODAY, customerId: 2 }]) && id("arCustomer").value === "2" && arRows().length === 4);
  reset(); choose(id("arCustomer"), ""); await idle();
  q('#arBody table.ar-customers [data-ar-cust="1"]').click(); await idle();
  ok("…a walk-in group has no record to pick: nothing asked", of("getUnpaidPoReport").length === 1);
  reset(); fire(id("arFilters"), "submit"); await idle();
  ok("submitting the filters reads it again", of("getUnpaidPoReport").length === 1);
  scripted = [{ action: "getUnpaidPoReport", body: { status: "ok", asOf: TODAY, rows: [], customers: [], net30On: true } }];
  reset(); choose(id("arCustomer"), "1"); await idle();
  ok("nothing owed for a customer: “No unpaid Net 30 order for this shop or customer.”, nothing to export", /^No unpaid Net 30 order for this shop or customer\.$/.test(text(q("#arBody .ar-empty"))) && id("arCsv").disabled);
  scripted = [{ action: "getUnpaidPoReport", body: { status: "ok", asOf: TODAY, rows: [], net30On: true } }];
  choose(id("arCustomer"), ""); await idle();
  ok("nothing owed at all: “No Net 30 order has money owed. Everything on terms is paid.”", text(q("#arBody .ar-empty")) === "No Net 30 order has money owed. Everything on terms is paid.");
  ok("…the totals say $0.00 on 0 orders, nothing late, none to check", same(totals(), [["Owed on Net 30", "$0.00", "0 orders", false], ["Late", "$0.00", "Nothing past its due date", false], ["POs to check", "0", "None waiting", false]]));
  scripted = [{ action: "getUnpaidPoReport", body: { status: "ok", asOf: TODAY, rows: [], net30On: false } }];
  fire(id("arFilters"), "submit"); await idle();
  ok("Net 30 off and nothing on terms: says so, with a link to Payment methods", /^Net 30 is switched off, and no order is on Net 30 terms\. Turn it on under Global settings → Payment methods \(“Net 30 \(with a PO\)”\)\.$/.test(text(q("#arBody .ar-empty"))) &&
    !!q('#arBody .ar-empty a[href="#settings"]'));
  signInWith(withLevels("staff", {}), "staff");
  scripted = [{ action: "getUnpaidPoReport", body: { status: "ok", asOf: TODAY, rows: [], enabled: false } }];
  fire(id("arFilters"), "submit"); await idle();
  ok("…for a role without Global settings: “An admin can turn it on under Global settings → Payment methods.”, and no settings link in the basis",
    /An admin can turn it on under Global settings → Payment methods\.$/.test(text(q("#arBody .ar-empty"))) && !q("#arPage a[href='#settings']"));
  asRoles("admin");
  scripted = [{ action: "getUnpaidPoReport", status: 500, body: { status: "error", message: "The <b>report</b> is down." } }];
  fire(id("arFilters"), "submit"); await idle();
  ok("an error: its words (as text), the totals and strip emptied", text(q("#arBody .cust-err")) === "The <b>report</b> is down." && !q("#arBody b") && id("arTotals").innerHTML === "" && id("arGroups").innerHTML === "");
  scripted = [{ action: "getUnpaidPoReport", empty: true }];
  fire(id("arFilters"), "submit"); await idle();
  ok("…with no words: “Couldn't load the report.”", text(q("#arBody .cust-err")) === "Couldn't load the report.");
  reset(); fire(id("arFilters"), "submit"); await idle();
  ok("…a later read draws it again", arRows().length === 10);

  console.log("\n--- Answers in another shape ---");
  scripted = [{ action: "getUnpaidPoReport", body: { status: "ok", report: { startsAt: "completed", groups: [{ key: "tocheck" }], customers: [{ customerId: 99, company: "Example Boosters", count: 1, owed: 12.5 }],
    rows: [{ orderId: "X-<1>", orgId: "club", group: "tocheck", poStatus: "PO to check", poNumber: "PO-9", owed: 12.5, received: 0, total: 12.5, daysLate: 0, company: "Example Boosters", customerName: "Sam Example", customerId: 99 },
      { orderId: "X-2", orgId: "club", group: "notdue", poNumber: "", poStatus: "", owed: 1, daysLate: 0 }] } } }];
  fire(id("arFilters"), "submit"); await idle();
  ok("money in dollars and no totals: worked out from the rows ($13.50 on 2 orders, 1 PO to check)", same(totals(), [["Owed on Net 30", "$13.50", "2 orders", false], ["Late", "$0.00", "Nothing past its due date", false], ["POs to check", "1", "Typed by the customer — accept each one", true]]));
  ok("…a group with only its key: its count and money from the rows", same(strip()[1], ["tocheck", "PO to check", "1", "$12.50"]) && same(strip()[2], ["notdue", "Not yet due", "1", "$1.00"]));
  ok("…terms that start on completion: said in the basis, and “When completed” for a due date not known", /Due dates count from the day the order was completed — shipped or picked up \(not due until then\)/.test(text(id("arBasis"))) && cells(rowFor("X-2"))[5] === "When completed");
  ok("…a row with no PO and no status reads “PO needed”; the order number as text", cells(rowFor("X-2"))[3] === "PO needed" && cells(rowFor("X-<1>"))[0].startsWith("X-<1>"));
  ok("…a company under a different customer name", same([...rowFor("X-<1>").children[1].childNodes].map(n => n.textContent.trim()).filter(Boolean), ["Sam Example", "Example Boosters"]) && cells(rowFor("X-2"))[1] === "—");
  ok("…the Customer filter keeps a customer it was only told about", [...id("arCustomer").options].some(o => o.value === "99" && text(o) === "Example Boosters"));
  // A customer the filter was never told about (an option put there by hand) keeps a place in it, by number.
  id("arCustomer").insertAdjacentHTML("beforeend", '<option value="77">?</option>');
  scripted = [{ action: "getUnpaidPoReport", body: { status: "ok", rows: [], customers: [] } }];
  reset(); choose(id("arCustomer"), "77"); await idle();
  ok("a picked customer the list doesn't have shows in the filter as “Customer 77”", same(of("getUnpaidPoReport").map(b => b.customerId), [77]) &&
    [...id("arCustomer").options].some(o => o.value === "77" && text(o) === "Customer 77") && id("arCustomer").value === "77");
  choose(id("arCustomer"), ""); await idle();

  console.log("\n--- Who sees what ---");
  signInWith(withLevels("staff", { "orders.terms": "read", "customers.records": "none" }), "staff");
  fire(id("arFilters"), "submit"); await idle();
  ok("without Edit on Net 30 terms: no Accept PO column", !q("#arBody table.ar-rows [data-ar-accept]") && qa("#arBody table.ar-rows thead th").length === 8);
  ok("…without Customers: names as text, no links", !q("#arBody table.ar-rows a.cust-link") && cells(rowFor(o130))[1] === "Example School District");
  asRoles("staff");
  fire(id("arFilters"), "submit"); await idle();
  ok("Back office: Accept PO where there is a PO to check (none now)", qa("#arBody table.ar-rows thead th").length === 9);
  signInWith({ "reports.receivables": "read" }, "staff");
  fire(id("arFilters"), "submit"); await idle();
  ok("a role that can't open Orders: the order number as text, not a button", !q("#arBody [data-ar-open]") && !!rowFor(o130) && w.adminCanOpen_("orders") === false);
  asRoles("admin");

  console.log("\n--- A late answer never replaces a newer one ---");
  { let release; const gate = new Promise(r => { release = r; });
    scripted = [{ action: "getUnpaidPoReport", gate, body: { status: "ok", asOf: "2026-01-01", rows: [{ orderId: "OLD-1", group: "nopo", poStatus: "PO needed", owedCents: 100 }] } }];
    reset(); choose(id("arAsOf"), "2026-01-01"); await pause(20);
    choose(id("arAsOf"), TODAY); await wait(() => of("getUnpaidPoReport").length === 2); await pause(50);
    release(); await pause(30); await idle();
    ok("the older read, answering last, is dropped: the page shows today's", !rowFor("OLD-1") && arRows().length === 10 && text(id("arBasis")).startsWith("As of " + w.adminDate_(TODAY) + ".")); }
  w.location.hash = "#home"; await idle();
  await goAr();
  ok("coming back finds the same view (today, every shop)", id("arAsOf").value === TODAY && id("arOrg").value === "");

  // ==============================================================================================================
  console.log("\n=== A customer's page: Allow Net 30 and Terms (days) ===");
  // ==============================================================================================================
  const custPage = () => id("custPage");
  const openCust = async (cid) => { const old = custPage(); reset(); const h = "customers/" + cid; if (hashNow() === h) w.adminRoute(); else w.location.hash = "#" + h; await wait(() => custPage() && custPage() !== old && !!q("#custForm")); await idle(); };
  const openList = async () => { const old = custPage(); reset(); w.location.hash = "#customers"; await wait(() => custPage() && custPage() !== old && !!q("#custPage tr.cust-row")); await idle(); };
  const custSave = async () => { const old = custPage(); reset(); fire(q("#custForm"), "submit"); await idle(); await wait(() => (custPage() !== old && !!q("#custForm")) || text(q("#custErr")) !== "", 100); await idle(); return of("saveCustomer")[0] || null; };
  const subTags = () => qa(".cust-sub .cust-tag").map(text);
  // The real list action: it sends allowNet30 / termsDays and the terms' default days.
  const sam = await must({ action: "saveCustomer", name: "Sam Example", email: "sam@example.com", allowNet30: true, termsDays: null });
  { const real = await must({ action: "listCustomers" });
    const samRow = real.customers.find(c => c.id === sam.id), c2 = real.customers.find(c => c.id === 2);
    ok("listCustomers sends each row's Allow Net 30 and own days (null = the default), and the default days", !!samRow && samRow.allowNet30 === true && samRow.termsDays === null &&
      !!c2 && c2.allowNet30 === true && c2.termsDays === 45 && real.defaultDays === 30 && real.customers.find(c => c.id === 1).allowNet30 === false); }
  await must({ action: "updateTermsSettings", terms: { defaultDays: 60, startsAt: "invoice" } });
  await openList();
  { const rowOfC = (cid) => q(`#custPage tr.cust-row[data-cust-id="${cid}"]`);
    ok("the Customers list marks a customer allowed Net 30 with their days: “Net 45”; without days of their own, the default (Global settings → Net 30 terms, here “Net 60”)",
      !!rowOfC(2) && text(rowOfC(2).querySelector(".cust-tag-net30")) === "Net 45" && !!rowOfC(sam.id) && text(rowOfC(sam.id).querySelector(".cust-tag-net30")) === "Net 60");
    ok("…and none on a customer not allowed it", !!rowOfC(1) && !rowOfC(1).querySelector(".cust-tag-net30")); }
  await openCust(sam.id);
  ok("…and the customer's own page says “Net 60” too", subTags().includes("Net 60"));
  await must({ action: "updateTermsSettings", terms: { defaultDays: 30, startsAt: "invoice" } });
  await openCust(2);
  ok("a customer allowed Net 30: “Net 45” under the name", subTags().includes("Net 45"));
  ok("a “Net 30 terms” box: Allow Net 30 ticked, Terms (days) 45", text(q("fieldset.cust-terms legend")) === "Net 30 terms" && q("#custNet30").checked && q("#custTermsDays").value === "45" &&
    q("#custTermsDays").placeholder === "Default" && q("fieldset.cust-terms").dataset.needForm === "customers.records:full" &&
    /^Allow Net 30: this customer can choose to pay by invoice at checkout$/.test(text(q("#custNet30").closest("label"))));
  ok("…with a note on what it does", /Checkout offers Net 30 to this customer's email once it's allowed here and switched on under Global settings → Payment methods\. Terms: how many days they have to pay \(Net 45 = 45\); blank is the default\./.test(text(q("fieldset.cust-terms"))));
  q("#custTermsDays").value = "60";
  let cs = await custSave();
  ok("Save sends Allow Net 30 and the days with the customer", !!cs && cs.allowNet30 === true && cs.termsDays === 60 && cs.id === 2);
  ok("…saved, and the page says “Net 60”", d1.q("SELECT allowNet30, termsDays FROM customers WHERE id = 2")[0].termsDays === 60 && subTags().includes("Net 60"));
  for (const v of ["0", "366", "7.5"]) {
    q("#custTermsDays").value = v; reset();
    fire(q("#custForm"), "submit"); await idle();
    ok(`days of ${v}: “Terms: a whole number of days from 1 to 365, or blank for the default.”, nothing sent`, text(q("#custErr")) === "Terms: a whole number of days from 1 to 365, or blank for the default." && of("saveCustomer").length === 0);
  }
  { // What isn't a number at all: a number box's value is then "" (badInput) — refused, not saved as the default.
    const box = q("#custTermsDays"); box.value = "";
    Object.defineProperty(box, "validity", { configurable: true, get: () => ({ badInput: true, valid: false }) });
    reset(); fire(q("#custForm"), "submit"); await idle();
    ok("days that aren't a number (the box holds nothing it can read): the Terms refusal, nothing sent", text(q("#custErr")) === "Terms: a whole number of days from 1 to 365, or blank for the default." && of("saveCustomer").length === 0);
    delete box.validity; }
  { const au0 = d1.q("SELECT count(*) AS n FROM audit_log WHERE action = 'customer.updated'")[0].n;
    const r = await call({ action: "saveCustomer", id: 2, name: "", company: "Example School District", email: "ap@example.org", allowNet30: true, termsDays: 50 });
    const rows = d1.q("SELECT detail FROM audit_log WHERE action = 'customer.updated' ORDER BY id").map(a => JSON.parse(a.detail || "{}"));
    ok("a change to Terms (days) alone is audited: customer.updated with termsDays {from 60, to 50}", r.status === 200 && rows.length === au0 + 1 &&
      same(rows[rows.length - 1].changes, { termsDays: { from: 60, to: 50 } }));
    await call({ action: "saveCustomer", id: 2, name: "", company: "Example School District", email: "ap@example.org", allowNet30: false, termsDays: 60 });
    const last = d1.q("SELECT detail FROM audit_log WHERE action = 'customer.updated' ORDER BY id DESC LIMIT 1").map(a => JSON.parse(a.detail || "{}"))[0];
    ok("…and Allow Net 30 with it: allowNet30 {from true, to false}, termsDays {from 50, to 60}", !!last && same(last.changes, { allowNet30: { from: true, to: false }, termsDays: { from: 50, to: 60 } }));
    await call({ action: "saveCustomer", id: 2, name: "", company: "Example School District", email: "ap@example.org", allowNet30: true, termsDays: 60 });
    const n = d1.q("SELECT count(*) AS n FROM audit_log WHERE action = 'customer.updated'")[0].n;
    await call({ action: "saveCustomer", id: 2, name: "", company: "Example School District", email: "ap@example.org", allowNet30: true, termsDays: 60 });
    ok("…a save that changes nothing writes no row", d1.q("SELECT count(*) AS n FROM audit_log WHERE action = 'customer.updated'")[0].n === n); }
  await openCust(2);
  q("#custTermsDays").value = "";
  cs = await custSave();
  ok("blank days: sent as none (the default), and the page says “Net 30”", !!cs && cs.termsDays === null && cs.allowNet30 === true && d1.q("SELECT termsDays FROM customers WHERE id = 2")[0].termsDays === null && subTags().includes("Net 30"));
  tick(q("#custNet30"), false);
  cs = await custSave();
  ok("unticked: Net 30 no longer allowed, no tag", !!cs && cs.allowNet30 === false && d1.q("SELECT allowNet30 FROM customers WHERE id = 2")[0].allowNet30 === 0 && !subTags().some(t => /^Net /.test(t)) && !q("#custNet30").checked);
  tick(q("#custNet30"), true); q("#custTermsDays").value = "45";
  cs = await custSave();
  ok("ticked again with 45 days", !!cs && cs.allowNet30 === true && cs.termsDays === 45 && subTags().includes("Net 45"));
  asRoles("staff");
  await openCust(2);
  ok("Back office (Edit on Customers): the box is shown with a note that only Full can change it", !!q("fieldset.cust-terms") && /Only a role with full access to Customers can change Net 30 terms\./.test(text(q("fieldset.cust-terms"))));
  q("#custTermsDays").value = "10"; q("#custNet30").checked = false;
  cs = await custSave();
  ok("…its Save sends what is stored, not what the boxes say", !!cs && cs.allowNet30 === true && cs.termsDays === 45 && d1.q("SELECT allowNet30, termsDays FROM customers WHERE id = 2")[0].termsDays === 45);
  await openCust(1);
  q("#custTermsDays").value = "10";
  cs = await custSave();
  ok("…and for a customer with no days of their own, none", !!cs && cs.allowNet30 === false && cs.termsDays === null);
  { const body = { action: "saveCustomer", id: 2, name: "", company: "Example School District", email: "ap@example.org" };
    let r = await call(Object.assign({}, body, { allowNet30: false, termsDays: 45 }));
    ok("the server refuses Back office turning Net 30 off for a customer (403), and keeps it", r.status === 403 && /Net 30 terms/.test(r.body.message) && d1.q("SELECT allowNet30 FROM customers WHERE id = 2")[0].allowNet30 === 1);
    r = await call(Object.assign({}, body, { termsDays: "30" }));
    ok("…or changing the days", r.status === 403 && d1.q("SELECT termsDays FROM customers WHERE id = 2")[0].termsDays === 45);
    r = await call(Object.assign({}, body, { allowNet30: true, termsDays: "45" }));
    ok("…but takes the same terms sent back unchanged", r.status === 200); }
  asRoles("admin");
  { let r = await call({ action: "saveCustomer", id: 1, name: "Pat Example", allowNet30: true, termsDays: 400 });
    ok("an admin's days out of range are refused by the server", r.status === 400 && d1.q("SELECT allowNet30 FROM customers WHERE id = 1")[0].allowNet30 === 0);
    r = await call({ action: "saveCustomer", name: "New Example", allowNet30: true, termsDays: 15 });
    ok("a new customer can be saved allowed Net 30 with their days", r.status === 200 && same(d1.q("SELECT allowNet30, termsDays FROM customers WHERE id = ?", r.body.id)[0], { allowNet30: 1, termsDays: 15 }));
    r = await call({ action: "saveCustomer", id: 1, name: "Pat Example" });
    ok("a save that leaves them out keeps what is stored", r.status === 200 && same(d1.q("SELECT allowNet30, termsDays FROM customers WHERE id = 1")[0], { allowNet30: 0, termsDays: null })); }
  { const real = await must({ action: "getCustomer", id: 1 });
    const old = JSON.parse(JSON.stringify(real)); delete old.customer.allowNet30; delete old.customer.termsDays;
    scripted = [{ action: "getCustomer", body: old }];
    await openCust(1);
    ok("a server that doesn't send the terms: no Net 30 box", !q("fieldset.cust-terms") && !q("#custNet30"));
    cs = await custSave();
    ok("…and its Save sends none of it", !!cs && !("allowNet30" in cs) && !("termsDays" in cs)); }

  finished = true;
  w.close();
})().catch((e) => { console.error(e); ok("the test ran without an exception", false); finished = true; process.exit(1); });
