const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { ok } = require("./testlib/check");
const roles = require("./testlib/roles");
const { storefrontPage } = require("./testlib/storefront-page");
const { JSDOM, ResourceLoader, VirtualConsole } = require("jsdom");

// Phase 5, the quote editor and outside digitizing: the answers the other tests leave out. The real admin page (jsdom)
// with the real admin.js, admin-quotes.js, admin-digitizing.js, orders.js and db.js (sql.js) behind it, and now and then
// a scripted answer where the server wouldn't say it (a missing field, an error with no words, a slow reply).
//   1. Outside digitizing (public/admin-digitizing.js): a section with no settings given, a list that can't load, a
//      window opened by a role that can't edit, a vendor list that comes back empty or after the page is gone, a job whose
//      expense is booked, a line with no name, a date the browser let through, errors with no words, a delete that is
//      cancelled, fails, or is for a record that has gone.
//   2. The quote editor (public/admin-quotes.js): lines and fees saved with no price helpers, the settings answering oddly,
//      the helpers' answers (nothing priced, a note missing, a window closed meanwhile, an error with no words), a
//      product that sends fewer fields than usual, a sized product, personalization, a hand-priced line changed in a
//      quote with two lines, a saved line's picks read back in several shapes, a shop whose graphics can't be read, and
//      the digitizing section arriving after the admin has left the quote or the quote has been drawn again.
// Invented people and shops only; no check depends on today's date or this machine's time zone.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + "\nreturn { createProduct, createGraphic, createTransfer, saveDesign, addDesignVersion, setProductDesign };")();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async (env, host, key, request, msg, need) => roleAllows(DEFAULT_ROLES[globalThis.__role386] || null, need) ? null : jsonResponse({ status: 'error', message: 'Your role can\\'t do that here.' }, 403);\n" +
  "const adminActor = () => 'owner@example.test';\n" + roles.adminAs({ roleFrom: "globalThis.__role386" }) + "\n" + strip(read("functions/_lib/permissions.js")) + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false;\n" +
  "const sendInvoiceEmail = async () => false;\n" +
  "const sendEstimateEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
const pause = (ms) => new Promise(r => setTimeout(r, ms));
const wait = async (cond, n = 500) => { for (let i = 0; i < n && !cond(); i++) await pause(10); return !!cond(); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
process.on("unhandledRejection", (e) => { console.error(e); ok("nothing in the test was left to fail unseen", false); });
const gateOf = () => { const g = {}; g.p = new Promise(r => { g.go = r; }); return g; };

(async () => {
  globalThis.__role386 = "admin";
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const call = async (body) => {
    const waits = [];
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => waits.push(Promise.resolve(p).catch(() => {})),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    await Promise.all(waits);
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const itemsOf = (id) => d1.q("SELECT * FROM estimate_items WHERE estimateId = ? ORDER BY position", id);

  // ---- What is in the database ----------------------------------------------------------------------------------
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Example Club','t','t'), ('rec','rec','Example Boosters','t','t'), ('bare','bare','Example Band','t','t');`);
  const cust = await call({ action: "saveCustomer", name: "Pat Example", company: "Example Club", email: "pat@example.com", phone: "555-0100", address: null, notes: "", taxExempt: false, taxExemptCertificate: "", taxExemptExpires: "" });
  const PAT = cust.body.id;
  const setDeco = async (types, pricing) => { const r = await call({ action: "updateDecorationSettings", types, pricing }); if (r.status !== 200) throw new Error("seed deco: " + JSON.stringify(r.body)); return r; };
  const PRICES = { embroidery: { stitchPricing: true, centsPer1000: 100, minStitches: 0, minCents: 0 }, screenprint: { inkColorCents: 150, screenSetupCents: 2000, reorderSetupCents: 1000, maxColors: 4 } };
  const DESN = await lib.saveDesign(d1, "acme", { name: "Example scarf mark" });
  const tr = await lib.createTransfer(d1, { name: "Example sheet" });
  const gA1 = await lib.createGraphic(d1, "acme", { name: "Lockup", kind: "transfer", transferId: tr, tier: "small", inkColors: ["White", "Gold"] });
  const gA2 = await lib.createGraphic(d1, "acme", { name: "Capital", kind: "transfer", transferId: tr, tier: "small" });
  const flat = (id, name, price, extra) => lib.createProduct(d1, "acme", Object.assign({ productId: id, type: id, name, pricingMode: "flat", flatPrice: price, visible: true, noDesignNeeded: true }, extra || {}));
  await flat("cap", "Club cap", 20);
  await flat("mug", "Club mug", 8);
  await flat("free", "Club freebie", 0);
  await flat("tag", "Club tag", 8, { personalizationPrice: 3 });
  await flat("scarf", "Club scarf", 9);
  await lib.setProductDesign(d1, "acme", "scarf", DESN);
  await lib.createProduct(d1, "acme", { productId: "tee", type: "tee", name: "Club tee", pricingMode: "sized", sizePricing: { S: 10, M: 12, L: 14 }, visible: true, noDesignNeeded: true });
  const cfg = (id, name, extra) => lib.createProduct(d1, "acme", Object.assign({ productId: id, type: id, name, pricingMode: "flat", flatPrice: 30, visible: true, noDesignNeeded: true, configurable: true, reorderQr: "none" }, extra));
  await cfg("plainfx", "Build-a-jacket", { garmentColors: ["Navy", "Grey"], locations: [{ key: "front", label: "Front", graphicIds: [gA1, gA2] }, { key: "back", label: "Back", graphicIds: [gA1] }] });
  d1._raw.run("UPDATE products SET colorGroupsJson = ? WHERE orgId = 'acme' AND productId = 'plainfx'", [JSON.stringify([{ label: "Heathers", colors: ["Grey"], flatPriceCents: 3300 }])]);
  await cfg("nofields", "Build-a-vest", { flatPrice: 25, garmentColors: ["Navy"], locations: [{ key: "front", label: "Front", graphicIds: [gA1] }] });
  await cfg("bare", "Build-a-sash", { flatPrice: 18, garmentColors: [], locations: [{ key: "front", label: "Front", graphicIds: [gA1] }] });
  await cfg("onlycustom", "Build-a-flag", { garmentColors: [], customDesign: "transfer", locations: [{ key: "front", label: "Front", graphicIds: [gA1] }] });
  // Another shop whose graphics come back without their price list, and one whose graphics can't be read at first.
  const gRec = await lib.createGraphic(d1, "rec", { name: "Booster mark", kind: "transfer", transferId: tr, tier: "small" });
  await lib.createProduct(d1, "rec", { productId: "pennant", type: "flag", name: "Build-a-pennant", pricingMode: "flat", flatPrice: 10, visible: true, noDesignNeeded: true,
    configurable: true, garmentColors: [], reorderQr: "none", locations: [{ key: "top", label: "Top", graphicIds: [gRec] }] });
  await lib.createProduct(d1, "bare", { productId: "bareflat", type: "mug", name: "Band mug", pricingMode: "flat", flatPrice: 7, visible: true, noDesignNeeded: true });
  await lib.createProduct(d1, "bare", { productId: "bareprod", type: "flag", name: "Band banner", pricingMode: "flat", flatPrice: 11, visible: true, noDesignNeeded: true,
    configurable: true, garmentColors: [], reorderQr: "none", locations: [{ key: "front", label: "Front", graphicIds: [gA1] }] });
  const mk = async (org) => { const r = await call({ action: "createEstimate", org, customerId: PAT }); if (r.status !== 200) throw new Error("seed quote: " + JSON.stringify(r.body)); return r.body; };

  // ---- A page: the real admin page with the server behind it, and a way to script one answer -------------------------
  const adminJs = read("public/admin.js"), custJs = read("public/admin-customers.js"), quotesJs = read("public/admin-quotes.js"), dgJs = read("public/admin-digitizing.js");
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
  async function boot(opts) {
    opts = opts || {};
    const P = { sent: [], toasts: [], queue: [] };
    // script(action, { body, status } | { reject } | { patch(answer) }, gate?): the next request for that action is answered
    // so; a gate holds the answer until it is opened.
    P.script = (action, spec) => P.queue.push(Object.assign({ action }, spec));
    class Loader extends ResourceLoader {
      fetch(url) {
        if (/\/admin-digitizing\.js(\?|$)/.test(url)) return opts.realDigitizing ? (opts.dgGate ? opts.dgGate.p.then(() => Buffer.from(dgJs)) : Promise.resolve(Buffer.from(dgJs))) : Promise.resolve(Buffer.from(""));
        if (/\/admin-quotes\.js(\?|$)/.test(url)) return Promise.resolve(Buffer.from(quotesJs));
        if (/\/admin-customers\.js(\?|$)/.test(url)) return Promise.resolve(Buffer.from(custJs));
        if (/\/admin\.js(\?|$)/.test(url)) return Promise.resolve(Buffer.from(adminJs));
        return Promise.resolve(Buffer.from(""));
      }
    }
    const vc = new VirtualConsole();
    vc.sendTo(console, { omitJSDOMErrors: true });
    vc.on("jsdomError", (e) => { if (!/Not implemented|Could not load script/.test(e.message)) console.error(e); });
    const dom = new JSDOM(storefrontPage(), { runScripts: "dangerously", resources: new Loader(), virtualConsole: vc, url: "https://admin.example.com/", pretendToBeVisual: true,
      beforeParse(win) {
        win.CSS = win.CSS || { escape: (s) => String(s).replace(/["\\]/g, "\\$&") };
        win.fetch = async (url, init) => {
          const u = String(url), b = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
          if (!u.includes("/api/orders")) return reply(404, { status: "error", message: "not here" });
          P.sent.push(b);
          const i = P.queue.findIndex(s => s.action === b.action);
          const s = i >= 0 ? P.queue.splice(i, 1)[0] : null;
          if (s && s.gate) await s.gate.p;
          if (s && s.reject) throw s.reject;
          if (s && s.body !== undefined) return reply(s.status || 200, s.body);
          const x = await call(b);
          if (s && s.patch) s.patch(x.body);
          return reply(x.status, x.body);
        };
      } });
    const w = dom.window, d = w.document;
    await pause(150);
    await w.loadAdminScript();
    w.showToast = (m, isErr) => P.toasts.push({ m: String(m), err: !!isErr });
    w.eval('adminKey = "cookie"; setAdminTimeZone_("UTC"); adminOrgs = ' + JSON.stringify([{ orgId: "acme", name: "Example Club" }, { orgId: "rec", name: "Example Boosters" }, { orgId: "bare", name: "Example Band" }]) + ';');
    w.eval(roles.asRole("admin", { name: "Tester", email: "tester@example.test" }));
    Object.assign(P, { w, d, q: (s) => d.querySelector(s), qa: (s) => [...d.querySelectorAll(s)], reset: () => { P.sent.length = 0; P.toasts.length = 0; }, of: (action) => P.sent.filter(b => b.action === action) });
    return P;
  }
  const noWords = () => new Error("");

  // =================================================================================================================
  // 1. Outside digitizing
  // =================================================================================================================
  {
    const P = await boot({ realDigitizing: true });
    const { w, d, q, qa, of, script } = P;
    await w.ensureDigitizingUi_();
    const modals = () => qa(".admin-modal").filter(m => !m.querySelector("#cmOk"));
    const formOpen = () => q("#dgForm");
    const confirmBox = () => q(".confirm-modal");
    const answerConfirm = async (yes) => { await wait(() => confirmBox()); const box = confirmBox(); const info = { message: box.dataset.message, okLabel: box.querySelector("#cmOk").textContent };
      box.querySelector(yes ? "#cmOk" : "#cmCancel").click(); await wait(() => !confirmBox()); return info; };
    const mount = (ctx) => { const div = d.createElement("div"); d.body.appendChild(div); div.innerHTML = w.digitizingSectionHtml_(ctx); return div; };
    const textOf = (el) => el.textContent.replace(/\s+/g, " ").trim();
    const setVal = (sel, v) => { const el = q(sel); el.value = v; el.dispatchEvent(new w.Event("input", { bubbles: true })); el.dispatchEvent(new w.Event("change", { bubbles: true })); };
    const submit = async () => { q("#dgForm").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true })); await pause(40); };
    const JOBS = [
      { id: 1, name: "", vendor: "", sentAt: "2026-03-02", returnedAt: "", expenseId: 5, costCents: null, itemId: 11, note: "" },
      { id: 2, name: "Example crest", vendor: "Example Digitizing Co", sentAt: "2026-03-03", returnedAt: "2026-03-05", expenseId: null, costCents: 2500, itemId: null, note: "" },
    ];

    console.log("=== A section built with no settings at all ===");
    {
      script("listDigitizingJobs", { body: { status: "ok" } });
      const div = mount(undefined);
      await w.wireDigitizingSection_(div);
      ok("a section given no settings and an answer with no list says nothing has been sent, without the way to add one (it can't edit)", textOf(div.querySelector("[data-dg-list]")) === "Nothing has been sent to an outside digitizer." && !div.querySelector("[data-dg-new]"));
      ok("…and asks for no order or quote (none was given)", of("listDigitizingJobs").length === 1 && of("listDigitizingJobs")[0].orderId === undefined && of("listDigitizingJobs")[0].estimateId === undefined);
      P.reset();
      script("listDigitizingJobs", { reject: noWords() });
      const box = mount({ orderId: "O-1", canEdit: false });
      await w.wireDigitizingSection_(box.firstElementChild, { orderId: "O-1", canEdit: false });
      ok("a list that can't load, with an error that has no words, says “Couldn't load the digitizing records.” as an alert", textOf(box.querySelector("[data-dg-list]")) === "Couldn't load the digitizing records." && !!box.querySelector("[data-dg-list] [role=alert]"));
      ok("…asked for the order it was given", of("listDigitizingJobs").length === 1 && of("listDigitizingJobs")[0].orderId === "O-1");
      P.reset();
      // Buttons that only a role that edits is given: a read-only section ignores them if they turn up.
      box.firstElementChild.insertAdjacentHTML("beforeend", `<button type="button" data-dg-new>Send</button><button type="button" data-dg-del="999">Gone</button>`);
      ok("(the pressed buttons are inside the section that listens)", !!box.querySelector("[data-dg-root] [data-dg-new]") && !!box.querySelector("[data-dg-root] [data-dg-del]"));
      box.querySelector("[data-dg-new]").click(); await pause(30);
      ok("a Send to digitizer press in a section that can't edit opens nothing and asks for nothing", modals().length === 0 && !formOpen() && of("listVendors").length === 0);
      box.querySelector("[data-dg-list]").click(); await pause(10);
      ok("a click on the list itself (not a button) does nothing", modals().length === 0 && P.sent.length === 0);
      box.querySelector("[data-dg-del=\"999\"]").click(); await pause(30);
      ok("deleting a record that isn't in the list (gone since it was drawn) asks nothing and deletes nothing", !confirmBox() && of("deleteDigitizingJob").length === 0 && P.toasts.length === 0);
      div.remove(); box.remove();
    }

    console.log("\n=== A vendor list that comes back after the page has gone ===");
    {
      P.reset();
      const ctx = { orderId: "O-1", canEdit: true, canExpense: false, items: [{ itemId: 11, itemName: "Hat" }, { id: 12 }, { id: null, itemId: null }] };
      script("listDigitizingJobs", { body: { status: "ok", jobs: JOBS } });
      const div = mount(ctx);
      await w.wireDigitizingSection_(div, ctx);
      ok("a record with no name is listed as “Digitizing”, with its expense noted, and its cost (none given) left blank", /^Digitizing/.test(textOf(div.querySelector("tbody tr"))) && /cost booked as an expense/.test(textOf(div.querySelector("tbody tr"))) && textOf(div.querySelectorAll("tbody tr")[0].querySelector(".cust-num")) === "");
      const gate = gateOf();
      script("listVendors", { body: { status: "ok" }, gate });
      div.querySelector("[data-dg-new]").click();
      await wait(() => of("listVendors").length === 1);
      div.remove();
      gate.go(); await pause(40);
      ok("the vendor list answered with no vendors after the section left the page: no window is drawn over the page the admin went to", !formOpen() && modals().length === 0);
      script("listDigitizingJobs", { body: { status: "ok", jobs: JOBS } });
      const div2 = mount(ctx);
      await w.wireDigitizingSection_(div2, ctx);
      div2.querySelector("[data-dg-new]").click();
      await wait(formOpen);
      ok("asked again, the same answer (no vendors) gives a window with a plain Digitizer box and no list to pick from", !!formOpen() && !q("#dgVendor") && !!q("#dgVendorOther") && q("#dgVendorOtherWrap").hidden === false && of("listVendors").length === 1);
      ok("a line with a number and a name, one with only a number, and none with neither: “Not for one line”, “Hat”, “Line 12”", same([...q("#dgItem").options].map(o => o.textContent), ["Not for one line", "Hat", "Line 12"]) && same([...q("#dgItem").options].map(o => o.value), ["", "11", "12"]));
      P.reset();
      q("#dgCancel").click(); await wait(() => !formOpen());
      div2.remove();
    }

    console.log("\n=== A date the browser let through, and an expense that is already booked ===");
    {
      P.reset();
      const ctx = { orderId: "O-1", canEdit: true, canExpense: true, items: [{ itemId: 11, itemName: "Hat" }, { id: 12 }] };
      script("listDigitizingJobs", { body: { status: "ok", jobs: JOBS } });
      let div = mount(ctx);
      await w.wireDigitizingSection_(div, ctx);
      div.querySelector("[data-dg-new]").click(); await wait(formOpen);
      setVal("#dgName", "Example Club left chest logo"); setVal("#dgVendorOther", "Example Digitizing Co");
      q("#dgBack").type = "text"; setVal("#dgBack", "soon");
      await submit();
      ok("a “came back” day that isn't a day (a browser with no date box): “Enter the day it came back, or leave it blank.”, the box has focus, nothing sent", q("#dgErr").textContent === "Enter the day it came back, or leave it blank." && d.activeElement === q("#dgBack") && of("saveDigitizingJob").length === 0);
      q("#dgCancel").click(); await answerConfirm(true);
      ok("Discard closes the window", !formOpen());
      // The record with its expense booked: its cost can't be changed here and is sent as nothing when it is blank.
      div.querySelector("[data-dg-edit=\"1\"]").click(); await wait(formOpen);
      ok("changing a record whose expense is booked: the cost box is off, with the sentence saying where to change it, and the record's line is picked", q("#dgCost").disabled && /Its cost is booked as an expense; change the amount there\./.test(q("#dgForm").textContent) && q("#dgItem").value === "11" && !q("#dgExpense"));
      setVal("#dgName", "Fixed crest"); setVal("#dgVendorOther", "Example Digitizing Co");
      script("saveDigitizingJob", { reject: noWords() });
      await submit();
      ok("a save refused with an error that has no words says “Couldn't save the record.” and the button works again", q("#dgErr").textContent === "Couldn't save the record." && q("#dgSave").disabled === false && formOpen());
      script("saveDigitizingJob", { body: { status: "ok", id: 1, jobs: [] } });
      P.toasts.length = 0;
      await submit(); await wait(() => !formOpen());
      const sentJob = of("saveDigitizingJob").pop().job;
      ok("saved again, the booked cost of nothing goes as 0 cents, with the record's expense, line and vendor kept, and no new expense asked for", sentJob.costCents === 0 && sentJob.expenseId === 5 && sentJob.itemId === 11 && sentJob.id === 1 && sentJob.vendor === "Example Digitizing Co" && sentJob.recordExpense === undefined && sentJob.orderId === "O-1");
      ok("…the window closes with “Digitizing record saved.”", !formOpen() && P.toasts.some(t => t.m === "Digitizing record saved." && !t.err));
      await pause(30);

      console.log("\n=== Deleting ===");
      P.reset();
      div.remove();
      script("listDigitizingJobs", { body: { status: "ok", jobs: JOBS } });
      const divD = mount(ctx);
      await w.wireDigitizingSection_(divD, ctx);
      div = divD;
      div.querySelector("[data-dg-del=\"1\"]").click();
      const info = await answerConfirm(false);
      ok("deleting a record with no name asks about “Digitizing” and says its expense stays until it is deleted in Expenses", info.message === "Delete the digitizing record “Digitizing”?\n\nIt is removed from this list. Its expense stays: delete that in Expenses first." && info.okLabel === "Delete");
      ok("…and “Cancel” deletes nothing", of("deleteDigitizingJob").length === 0);
      div.querySelector("[data-dg-del=\"2\"]").click();
      const info2 = await answerConfirm(false);
      ok("a record with a name and no expense is asked about by its name, with no word about an expense", info2.message === "Delete the digitizing record “Example crest”?\n\nIt is removed from this list.");
      div.querySelector("[data-dg-del=\"1\"]").click();
      script("deleteDigitizingJob", { reject: noWords() });
      await answerConfirm(true); await wait(() => of("deleteDigitizingJob").length === 1); await pause(20);
      ok("a delete that fails with an error that has no words shows “Couldn't delete the record.” as an error, and the list is as it was", P.toasts.length === 1 && P.toasts[0].m === "Couldn't delete the record." && P.toasts[0].err === true && div.querySelectorAll("tbody tr").length === 2);
      div.remove();
    }

    console.log("\n=== A quote's section: a record for a line, in a section that offers no lines ===");
    {
      P.reset();
      const ctx = { estimateId: 7, canEdit: true, canExpense: false };
      script("listDigitizingJobs", { body: { status: "ok", jobs: [{ id: 3, name: "Quote crest", vendor: "Someone Else", sentAt: "2026-03-03", returnedAt: null, costCents: 0, itemId: 4, expenseId: null, note: "" }] } });
      const div = mount(ctx);
      await w.wireDigitizingSection_(div, ctx);
      ok("a quote's list is asked for by its number", of("listDigitizingJobs")[0].estimateId === 7 && of("listDigitizingJobs")[0].orderId === undefined);
      div.querySelector("[data-dg-edit=\"3\"]").click(); await wait(formOpen);
      ok("the window offers no line to pick (a quote has none to offer)", !q("#dgItem"));
      script("saveDigitizingJob", { body: { status: "ok", id: 3, jobs: [] } });
      await submit(); await wait(() => !formOpen());
      const j = of("saveDigitizingJob").pop().job;
      ok("saving keeps the record's own line (4) and says which quote it is for", j.itemId === 4 && j.estimateId === 7 && j.id === 3 && j.orderId === undefined && j.returnedAt === null);
      div.remove();
    }
  }

  console.log("\n=== A vendor with a blank name ===");
  {
    const P = await boot({ realDigitizing: true });
    const { w, d, q, of, script } = P;
    await w.ensureDigitizingUi_();
    const ctx = { orderId: "O-1", canEdit: true, canExpense: false };
    script("listDigitizingJobs", { body: { status: "ok", jobs: [] } });
    const div = d.createElement("div"); d.body.appendChild(div); div.innerHTML = w.digitizingSectionHtml_(ctx);
    await w.wireDigitizingSection_(div, ctx);
    script("listVendors", { body: { status: "ok", vendors: [{ name: " ", forDigitizing: 1 }, { name: "Example Digitizing Co", forDigitizing: 1 }, { name: "Hidden Digitizer", forDigitizing: 1, hidden: true }] } });
    div.querySelector("[data-dg-new]").click(); await wait(() => q("#dgForm"));
    ok("the list shows the blank-named vendor first (nothing sorts before it) and the other, and not the hidden one", same([...q("#dgVendor").options].map(o => o.value), [" ", "Example Digitizing Co", "__other__"]));
    q("#dgName").value = "Example Club crest";
    q("#dgForm").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true })); await pause(30);
    ok("a vendor picked that is only spaces: “Say who digitized it.”, focus on the vendor list, nothing sent", q("#dgErr").textContent === "Say who digitized it." && d.activeElement === q("#dgVendor") && of("saveDigitizingJob").length === 0);
  }

  // =================================================================================================================
  // 2. The quote editor
  // =================================================================================================================
  const P = await boot();
  const { w, d, q, qa, of, script, sent, toasts, reset } = P;
  const page = () => d.getElementById("qtPage");
  const hashNow = () => w.location.hash.replace(/^#\/?/, "");
  const oneDrawn = () => !!(page() && (q("#qtForm") || page().querySelector(".cust-err")));
  const openQ = async (id) => { const old = page(); if (hashNow() === "quotes/" + id) w.adminRoute(); else w.location.hash = "#quotes/" + id; return wait(() => page() && page() !== old && oneDrawn()); };
  const modal = () => { const all = qa(".admin-modal"); return all[all.length - 1] || null; };
  const pm = modal;
  const lines = () => qa("#qtLines table.qt-lines tbody tr");
  const cells = (tr) => [...tr.children].map(td => td.textContent.trim());
  const sub = (i) => (lines()[i].querySelector(".qt-line-sub") || { textContent: "" }).textContent;
  const openProduct = async () => { const n = qa(".admin-modal").length; q("#qtAddProduct").click(); return wait(() => qa(".admin-modal").length === n + 1 && !!pm().querySelector("#qtProdForm")); };
  const openCustom = async () => { const n = qa(".admin-modal").length; q("#qtAddCustom").click(); return wait(() => qa(".admin-modal").length === n + 1 && !!pm().querySelector("#qtOtherForm")); };
  const openFee = async () => { const n = qa(".admin-modal").length; q("#qtAddFee").click(); return wait(() => qa(".admin-modal").length === n + 1 && !!pm().querySelector("#qtOtherForm")); };
  const closeModal = async () => { const m = modal(); if (!m) return; m.querySelector("[data-modal-close]").click(); await pause(5);
    const box = q(".confirm-modal"); if (box) box.querySelector("#cmOk").click();
    await wait(() => !m.isConnected, 100); };
  const choose = (sel, v) => { const el = pm().querySelector(sel); el.value = v; el.dispatchEvent(new w.Event("change", { bubbles: true })); };
  const tick = (sel, on) => { const el = pm().querySelector(sel); el.checked = on; el.dispatchEvent(new w.Event("change", { bubbles: true })); };
  const typeIn = (sel, v) => { const el = pm().querySelector(sel); el.value = v; el.dispatchEvent(new w.Event("input", { bubbles: true })); };
  const click = (sel) => pm().querySelector(sel).click();
  const submitIn = async (formSel) => { const m = modal(); const n = of("saveEstimate").length; m.querySelector(formSel).dispatchEvent(new w.Event("submit", { cancelable: true })); await wait(() => !m.isConnected || m.querySelector(".cust-err").textContent !== "" || of("saveEstimate").length > n); await wait(() => !m.isConnected || m.querySelector(".cust-err").textContent !== "", 60); return m; };
  const note = () => pm().querySelector("[data-qt-note]").textContent;
  const noteBad = () => pm().querySelector("[data-qt-note]").style.color !== "";
  const press = async (goAttr, settle) => { click(`[data-qt-go="${goAttr}"]`); await wait(() => note() !== "", 200); await pause(settle || 5); };
  const decoBtns = () => [...pm().querySelectorAll("[data-qt-deco]")].map(b => b.textContent);
  const freshQuote = async (org) => { const id = (await mk(org || "acme")).id; await openQ(id); return id; };
  const locSel = (k) => pm().querySelector(`select[data-qt-loc="${k}"]`);
  const optsOf = (sel) => [...sel.options].map(o => o.textContent);
  const prodOptions = () => [...pm().querySelectorAll("#qtProd option")].map(o => o.value);
  const preview = () => pm().querySelector("#qtProdPreview").textContent;
  // The server's product list, with fields taken away or changed for the products named.
  const patchProducts = (edits) => script("listProducts", { patch: (b) => { for (const p of b.products) if (edits[p.productId]) edits[p.productId](p); } });

  // Products are read once per shop while the page stays, so every change to what the server says is scripted now.
  patchProducts({
    plainfx: (p) => { delete p.blockedGraphicColors; p.colorGroups = [{ label: "Odd", colors: undefined }].concat(p.colorGroups); },
    nofields: (p) => { delete p.locations; delete p.fixedTransfers; delete p.colorGroups; delete p.flatPrice; },
    bare: (p) => { delete p.garmentColors; delete p.locations; delete p.fixedTransfers; delete p.colorGroups; delete p.blockedGraphicColors; },
    onlycustom: (p) => { delete p.locations[0].graphicIds; delete p.locations[0].label; },
    tee: (p) => { p.sizePricing = { S: 10, M: 0, L: 14 }; },
  });

  console.log("=== A line, a custom line and a fee saved with no price helpers ===");
  let Q = await freshQuote();
  await openProduct(); choose("#qtProd", "cap"); typeIn("#qtProdQty", "2"); reset();
  await submitIn("#qtProdForm");
  ok("with the stored settings (no helpers) a product line saves as it is", same(of("saveEstimate")[0].items, [{ kind: "product", productId: "cap", size: "OSFA", qty: 2, personalized: false, persName: "" }]) && lines().length === 1);
  await openCustom(); typeIn("#qtOtherName", "Extra patch"); typeIn("#qtOtherQty", "1"); typeIn("#qtOtherPrice", "4"); reset();
  await submitIn("#qtOtherForm");
  ok("…a custom line saves with no extra line beside it", of("saveEstimate")[0].items.length === 2 && of("saveEstimate")[0].items[1].name === "Extra patch" && lines().length === 2);
  await openFee(); typeIn("#qtOtherPrice", "25"); reset();
  await submitIn("#qtOtherForm");
  ok("…and a fee saves as one line of its own, with no helper line beside it", of("saveEstimate")[0].items.length === 3 && of("saveEstimate")[0].items[2].kind === "fee" && of("saveEstimate")[0].items[2].amount === 25 && lines().length === 3 && cells(lines()[2])[5] === "$25.00");

  console.log("\n=== A hand-priced line changed in a quote with two lines ===");
  Q = await freshQuote();
  await openProduct(); choose("#qtProd", "cap"); typeIn("#qtProdQty", "2"); tick("#qtProdOwn", true); typeIn("#qtProdOwnPrice", "12.50");
  await submitIn("#qtProdForm");
  await openProduct(); choose("#qtProd", "mug"); typeIn("#qtProdQty", "1");
  await submitIn("#qtProdForm");
  ok("two lines in the quote, the first priced by hand", lines().length === 2 && sub(0) === "Price set by hand");
  reset();
  lines()[0].querySelector("[data-qt-edit]").click(); await wait(() => !!modal() && !!pm().querySelector("#qtProdForm"));
  ok("Change opens the hand price in the box ($12.50), ticked and shown", pm().querySelector("#qtProdOwn").checked && pm().querySelector("#qtProdOwnPrice").value === "12.50" && !pm().querySelector("#qtProdOwnWrap").hidden);
  typeIn("#qtProdQty", "3"); reset();
  await submitIn("#qtProdForm");
  ok("saved: the first line is the changed one and the second line goes back as it was", same(of("saveEstimate")[0].items, [
    { kind: "product", productId: "cap", size: "OSFA", qty: 3, personalized: false, persName: "", customUnitPrice: 12.5 },
    { kind: "product", productId: "mug", size: "OSFA", qty: 1, personalized: false, persName: "" }]));
  ok("…and the quote shows three at $12.50 on the first line and one mug on the second", lines().length === 2 && lines()[0].querySelector("input[data-qt-qty]").value === "3" && cells(lines()[0])[5] === "$37.50" && /^Club mug/.test(cells(lines()[1])[0]));

  console.log("\n=== A sized product, and personalization ===");
  Q = await freshQuote();
  await openProduct(); choose("#qtProd", "tee");
  ok("a sized product (not one with choices) lists its sizes with their prices; one priced at nothing shows $0.00", same(optsOf(pm().querySelector("#qtProdSize")), ["S — $10.00", "M — $0.00", "L — $14.00"]) && !pm().querySelector("#qtProdSizeWrap").hidden);
  choose("#qtProdSize", "M");
  ok("…choosing the one priced at nothing says $0.00 each", preview() === "Catalog price $0.00 each.");
  choose("#qtProdSize", "L"); typeIn("#qtProdQty", "2");
  await submitIn("#qtProdForm");
  ok("a sized line is saved with its size", of("saveEstimate").pop().items[0].size === "L" && sub(0) === "Size L");
  lines()[0].querySelector("[data-qt-edit]").click(); await wait(() => !!modal() && !!pm().querySelector("#qtProdForm"));
  ok("Change on it opens with that size picked (L)", pm().querySelector("#qtProdSize").value === "L" && pm().querySelector("#qtProd").value === "tee");
  await closeModal();
  await openProduct(); choose("#qtProd", "tag");
  ok("a product with a personalization price has the tick, with its price", !pm().querySelector("#qtProdPersWrap").hidden && /\+\$3\.00 each/.test(pm().querySelector("#qtProdPersPrice").textContent));
  tick("#qtProdPers", true);
  ok("ticked, the preview adds the personalization: “Catalog price $8.00 each + $3.00 personalization.”", preview() === "Catalog price $8.00 each + $3.00 personalization.");
  await closeModal();

  console.log("\n=== A product that sends fewer fields than usual ===");
  Q = await freshQuote(); await openProduct();
  choose("#qtProd", "nofields");
  ok("no locations, no price groups and no flat price: a color to pick, no place to decorate, and a catalog price of $0.00", pm().querySelector("#qtProdColor").value === "Navy" && !pm().querySelector("#qtProdCfg").hidden && pm().querySelector("#qtProdLocs").children.length === 0 && preview() === "Catalog price $0.00 each with the choices above.");
  choose("#qtProdColor", "Navy");
  ok("…choosing the color again draws it again with nothing to carry over", pm().querySelector("#qtProdLocs").children.length === 0 && preview() === "Catalog price $0.00 each with the choices above.");
  choose("#qtProd", "bare");
  ok("no colors, no locations and no fixed transfers: the color box is hidden and the flat price is the catalog's ($18.00)", pm().querySelector("#qtProdColorWrap").hidden && pm().querySelector("#qtProdLocs").children.length === 0 && preview() === "Catalog price $18.00 each with the choices above.");
  choose("#qtProd", "onlycustom");
  ok("one place that offers no graphics but the customer's own design: no “None”, the customer's design is picked, with no price added", same(optsOf(locSel("front")), ["Customer's own design"]) && locSel("front").value === "custom" && preview() === "Catalog price $30.00 each with the choices above.");
  ok("…the place has no label, so it is called by its key, and its thread color list by it too", pm().querySelector("#qtProdLocs label span").textContent === "front" && !!pm().querySelector('select[data-qt-ink="front"][aria-label="Thread color for front"]'));
  choose("#qtProd", "plainfx");
  ok("a product with a price group for Grey (and another group with no colors listed): Navy is $30.00", same([...pm().querySelector("#qtProdColor").options].map(o => o.value), ["Navy", "Grey"]) && preview() === "Catalog price $30.00 each with the choices above.");
  choose("#qtProdColor", "Grey");
  ok("…Grey is the group's flat price, $33.00, and the graphics are still offered with no blocked colors listed", preview() === "Catalog price $33.00 each with the choices above." && optsOf(locSel("front")).length === 3);
  await closeModal();

  console.log("\n=== A saved line's picks read back in other shapes ===");
  Q = await freshQuote(); await openProduct(); choose("#qtProd", "plainfx"); choose("#qtProdColor", "Navy"); choose(`select[data-qt-loc="front"]`, String(gA1));
  await submitIn("#qtProdForm");
  ok("a line with choices is saved", lines().length === 1 && itemsOf(Q).length === 1);
  const CFG_JSON = JSON.stringify({ garmentColor: "Navy", locations: [{ location: "front", label: "Chest", graphicName: "Lockup", ink: "Gold" }, { location: "back", custom: true }, { location: "side" }, { location: "x", auto: true, graphicName: "Hidden" }] });
  script("getEstimate", { patch: (b) => { const it = b.items[0]; delete it.config; it.configJson = CFG_JSON; b.items.push(Object.assign({}, it, { id: 9999, configJson: "{not json" })); } });
  await openQ(Q);
  ok("picks held as text are read: the color, a place with its graphic and thread color, the customer's own design, and a place with neither", sub(0) === "Navy · Chest: Lockup (Gold) · back: Customer's own design · side: ");
  ok("…text that isn't readable gives no picks on its line", lines().length === 2 && sub(1) === "");
  script("getEstimate", { patch: (b) => { b.items[0].config = { garmentColor: "Navy" }; } });
  await openQ(Q);
  lines()[0].querySelector("[data-qt-edit]").click(); await wait(() => !!modal() && !!pm().querySelector("#qtProdForm"));
  ok("a saved line whose choices list no places opens with its color and nothing picked", pm().querySelector("#qtProd").value === "plainfx" && pm().querySelector("#qtProdColor").value === "Navy" && locSel("front").value === "" && locSel("back").value === "");
  await closeModal();
  script("getEstimate", { patch: (b) => { b.items[0].config = { garmentColor: "Grey", locations: [{ location: "front", auto: true }, { location: "reorderqr", graphicId: 1 }, { location: "front", fixed: true }, { location: "back", graphicId: null }] }; } });
  await openQ(Q);
  lines()[0].querySelector("[data-qt-edit]").click(); await wait(() => !!modal() && !!pm().querySelector("#qtProdForm"));
  ok("entries the shop added itself are skipped and a place with no graphic stays on None; the color is kept", pm().querySelector("#qtProdColor").value === "Grey" && locSel("front").value === "" && locSel("back").value === "");
  await closeModal();

  console.log("\n=== A shop whose graphics come back short, or not at all ===");
  Q = await freshQuote("bare");
  script("listGraphics", { reject: noWords() });
  toasts.length = 0; await openProduct();
  ok("graphics that can't be read, with an error that has no words: the toast says “unknown error”, and only the product with no choices is offered", toasts.length === 1 && toasts[0].err && toasts[0].m === "Couldn't load the shop's graphics: unknown error Products with choices can't be quoted until they load." && same(prodOptions(), ["bareflat"]));
  await closeModal();
  script("listGraphics", { body: { status: "ok" } });
  toasts.length = 0; await openProduct();
  ok("an answer with no graphics and no price list is taken as an empty shop: the product with choices is offered, with nothing to pick", !toasts.length && same(prodOptions(), ["bareflat", "bareprod"]));
  choose("#qtProd", "bareprod");
  ok("…its place offers only “None” (no graphic of the shop is on offer)", same(optsOf(locSel("front")), ["None"]));
  await closeModal();
  Q = await freshQuote("rec");
  script("listGraphics", { patch: (b) => { delete b.tiersCents; } });
  await openProduct();
  ok("a price list that doesn't say what the graphic's size adds: the graphic is offered with nothing added", same(optsOf(locSel("top")), ["Booster mark"]) && preview() === "Catalog price $10.00 each with the choices above.");
  await closeModal();

  console.log("\n=== The settings answering oddly ===");
  await setDeco(["embroidery", "screenprint", "dtf"], PRICES);
  script("getDecorationSettings", { body: { status: "ok", types: "embroidery" } });
  Q = await freshQuote(); await openCustom();
  ok("types that aren't a list, and no price list: no helpers", pm().querySelector("#qtOtherDeco").hidden && decoBtns().length === 0);
  await closeModal();
  script("getDecorationSettings", { body: { status: "ok", types: ["screenprint"] } });
  Q = await freshQuote(); await openCustom();
  ok("screen print on and no price list: the helper is there, with up to 6 colors (nothing says fewer)", same(decoBtns(), ["Screen print price"]));
  click('[data-qt-deco="screen"]');
  ok("…the colors list is 1 to 6", same([...pm().querySelectorAll('[data-qt-f="colors"] option')].map(o => o.value), ["1", "2", "3", "4", "5", "6"]));
  click('[data-qt-note]'); await pause(5);
  ok("pressing the note under the buttons (not a button) does nothing: the pane stays open and nothing is asked", !pm().querySelector('[data-qt-pane="screen"]').hidden && of("priceDecoration").length === 0);
  script("priceDecoration", { body: { status: "ok" } });
  await press("screen", 20);
  ok("an answer with no prices puts $0.00 in the price and says screen print adds $0.00, with no setup fee promised", pm().querySelector("#qtOtherPrice").value === "0.00" && note() === "Screen print adds $0.00 to each piece." && !noteBad());
  typeIn("#qtOtherName", "Example tote"); reset();
  await submitIn("#qtOtherForm");
  ok("…and the line saves with no setup line beside it", of("saveEstimate")[0].items.length === 1 && of("saveEstimate")[0].items[0].unitPrice === 0);
  script("priceDecoration", { reject: noWords() });
  await openCustom(); click('[data-qt-deco="screen"]');
  await press("screen", 20);
  ok("a screen print price refused with an error that has no words says “Couldn't work out the price.” in red, and the button works again", note() === "Couldn't work out the price." && noteBad() && !pm().querySelector('[data-qt-go="screen"]').disabled);
  const gate1 = gateOf();
  script("priceDecoration", { body: { status: "ok", unitCents: 300, setupCents: 4000 }, gate: gate1 });
  click('[data-qt-go="screen"]'); await wait(() => of("priceDecoration").length === 2);
  { const m = modal(), priceBox = m.querySelector("#qtOtherPrice"), noteBox = m.querySelector("[data-qt-note]");
    await closeModal();
    gate1.go(); await pause(40);
    ok("a screen print answer that comes after its window was closed changes nothing in that window and says nothing", priceBox.value === "" && noteBox.textContent === "" && toasts.length === 0); }

  console.log("\n=== By stitches: the answers it can get ===");
  await setDeco(["embroidery", "screenprint", "dtf"], PRICES);
  Q = await freshQuote(); await openCustom(); click('[data-qt-deco="stitch"]'); typeIn('[data-qt-f="stitches"]', "5000");
  script("priceDecoration", { body: { status: "ok", unitCents: 0 } });
  await press("stitch", 20);
  ok("an answer with no price and no words says “No price worked out.” and where to set it, in red, and fills nothing", note() === "No price worked out. Set the stitch price under Global settings → Decoration types." && noteBad() && pm().querySelector("#qtOtherPrice").value === "");
  script("priceDecoration", { body: { status: "ok", unitCents: 500 } });
  await press("stitch", 20);
  ok("a price with no words of its own is called “Embroidery”: $5.00 each, put in the price", note() === "Embroidery: $5.00 each." && !noteBad() && pm().querySelector("#qtOtherPrice").value === "5.00");
  script("priceDecoration", { reject: noWords() });
  await press("stitch", 20);
  ok("an error with no words says “Couldn't work out the price.” in red", note() === "Couldn't work out the price." && noteBad() && !pm().querySelector('[data-qt-go="stitch"]').disabled);
  click("#qtOtherCancel"); await pause(5); { const box = q(".confirm-modal"); if (box) box.querySelector("#cmOk").click(); } await wait(() => !modal());
  Q = await freshQuote(); await openProduct(); choose("#qtProd", "cap"); click('[data-qt-deco="stitch"]'); typeIn('[data-qt-f="stitches"]', "5000");
  const gate2 = gateOf();
  script("priceDecoration", { body: { status: "ok", unitCents: 500, note: "5,000 stitches" }, gate: gate2 });
  click('[data-qt-go="stitch"]'); await wait(() => of("priceDecoration").length >= 1 && sent.filter(b => b.action === "priceDecoration").length >= 1);
  { const m = modal(), priceBox = m.querySelector("#qtProdOwnPrice"), noteBox = m.querySelector("[data-qt-note]");
    toasts.length = 0;
    await closeModal();
    gate2.go(); await pause(40);
    ok("a stitch price that comes after its window was closed changes nothing in that window", priceBox.value === "" && noteBox.textContent === "" && !m.querySelector("#qtProdOwn").checked && toasts.length === 0); }
  await openProduct(); choose("#qtProd", "free"); click('[data-qt-deco="stitch"]'); typeIn('[data-qt-f="stitches"]', "8500");
  await press("stitch", 20);
  ok("on a product whose catalog price is nothing, the stitch price stands alone ($8.50) and no catalog price is mentioned", pm().querySelector("#qtProdOwnPrice").value === "8.50" && note() === "8,500 stitches × $1.00 per 1,000: $8.50 each.");
  await closeModal();
  script("getDesign", { body: { status: "ok" } });
  toasts.length = 0; reset();
  await openProduct(); choose("#qtProd", "scarf"); click('[data-qt-deco="stitch"]'); await wait(() => of("getDesign").length === 1); await pause(40);
  ok("a design whose answer lists no versions gives an empty count, with no complaint", of("getDesign").length === 1 && pm().querySelector('[data-qt-f="stitches"]').value === "" && toasts.length === 0 && note() === "");
  choose("#qtProd", "cap"); choose("#qtProd", "scarf"); await pause(40);
  ok("…the same design is not asked for again, and its count stays empty", of("getDesign").length === 1 && pm().querySelector('[data-qt-f="stitches"]').value === "");
  await closeModal();

  console.log("\n=== The digitizing section arrives late ===");
  {
    const gate = gateOf();
    const R = await boot({ realDigitizing: true, dgGate: gate });
    const rd = R.d;
    const rhash = () => R.w.location.hash.replace(/^#\/?/, "");
    const mk2 = async () => (await mk("acme"));
    const A = await mk2(), B = await mk2();
    R.w.location.hash = "#quotes/" + A.id;
    await wait(() => rd.querySelector("#qtForm"));
    R.w.location.hash = "#quotes/" + B.id;
    await wait(() => rd.querySelector("#qtForm") && rhash() === "quotes/" + B.id && R.of("getEstimate").length >= 2);
    await pause(30);
    R.reset();
    gate.go(); await pause(80);
    ok("the digitizing script came after the admin had gone on to another quote: nothing of it is drawn for the first, and the second has its own section once", rd.querySelectorAll("[data-dg-root]").length === 1 && R.of("listDigitizingJobs").length === 1 && R.of("listDigitizingJobs")[0].estimateId === B.id);
    // The same quote drawn again before the script came: the first drawing's section is gone and gets nothing.
    const gate3 = gateOf();
    const R2 = await boot({ realDigitizing: true, dgGate: gate3 });
    const C = await mk("acme");
    R2.w.location.hash = "#quotes/" + C.id;
    await wait(() => R2.d.querySelector("#qtForm"));
    const first = R2.d.getElementById("qtPage");
    R2.w.adminRoute();
    await wait(() => R2.d.getElementById("qtPage") && R2.d.getElementById("qtPage") !== first && R2.d.querySelector("#qtForm"));
    R2.reset();
    gate3.go(); await pause(80);
    ok("the same quote drawn again before the script came: its section is drawn once, in the page that is showing", R2.d.querySelectorAll("[data-dg-root]").length === 1 && R2.d.getElementById("qtPage").contains(R2.d.querySelector("[data-dg-root]")) && !first.isConnected && R2.of("listDigitizingJobs").length === 1);
  }
})();
