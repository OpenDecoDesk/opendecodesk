const fs = require("fs");
const { storefrontPage } = require("./testlib/storefront-page");
const { createD1 } = require("./testlib/d1-shim.js");
const { ok } = require("./testlib/check");
const roles = require("./testlib/roles");
const { JSDOM, ResourceLoader, VirtualConsole } = require("jsdom");

// The Quotes page (public/admin-quotes.js, migrations/0109), run in the real admin page (jsdom) with the real admin.js in
// front of it and the real orders.js / db.js on sql.js behind it:
//   the Quotes top button and the #quotes route (ensureQuotesPage_), shown only with the permission and the feature on;
//   the list: status and shop filters, the search, paging, a row opening its quote, "+ New quote" with the shared
//   customer search and a shop;
//   one quote: its fields, product / custom / fee lines priced by the server (list price, quantity price, unit, total),
//   Save, Send (email and message), Convert to order (with the invoice box), Cancel quote, the status badge, the
//   customer's change note and Revise, read-only once sent, links to the customer and the order;
//   the customer page's "New quote for this customer" and its list of quotes (public/admin-customers.js);
//   that nothing typed is read as HTML, the labels, and where focus goes.
// The page signs in as a built-in role (testlib/roles.js asRole) and the server answers as one (adminAs), each set by the
// test. Invented people and shops only. Dates are worked out from the page's own "today" (localToday_, the page told
// UTC), or are far in the past or the future, so no check depends on the day it runs or this machine's time zone.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + "\nreturn { createProduct };")();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async (env, host, key, request, msg, need) => roleAllows(DEFAULT_ROLES[globalThis.__role318] || null, need) ? null : jsonResponse({ status: 'error', message: 'Your role can\\'t do that here.' }, 403);\n" +
  "const adminActor = () => 'owner@example.test';\n" + roles.adminAs({ roleFrom: "globalThis.__role318" }) + "\n" + strip(read("functions/_lib/permissions.js")) + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false;\n" +
  // The two emails this page causes: whether they "went" is the test's to say.
  "const sendInvoiceEmail = async (env, o) => { globalThis.__mail318.push({ kind: 'invoice', to: o && o.order ? o.order.contact : '' }); return globalThis.__mailOk318; };\n" +
  "const sendEstimateEmail = async (env, o) => { globalThis.__mail318.push({ kind: 'estimate', link: o.link, message: o.message, to: o.estimate.sentTo }); return globalThis.__mailOk318; };\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
const pause = (ms) => new Promise(r => setTimeout(r, ms));
const wait = async (cond, n = 500) => { for (let i = 0; i < n && !cond(); i++) await pause(10); return !!cond(); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
process.on("unhandledRejection", (e) => { console.error(e); ok("nothing in the test was left to fail unseen", false); });

(async () => {
  globalThis.__role318 = "admin";
  globalThis.__mail318 = [];
  globalThis.__mailOk318 = true;
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
  const est = (id) => d1.q("SELECT * FROM estimates WHERE id = ?", id)[0];
  const itemsOf = (id) => d1.q("SELECT * FROM estimate_items WHERE estimateId = ? ORDER BY position", id);

  // ---- What is in the database ----------------------------------------------------------------------------------
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Example Club','t','t'), ('rec','rec','Rec <i>League</i>','t','t');`);
  const add = async (c) => {
    const r = await call(Object.assign({ action: "saveCustomer", name: "", company: "", email: "", phone: "", address: null, notes: "", taxExempt: false, taxExemptCertificate: "", taxExemptExpires: "" }, c));
    if (r.status !== 200) throw new Error("seed: " + JSON.stringify(r.body));
    return r.body.id;
  };
  const PAT = await add({ name: "Pat Example", company: "Example Club", email: "pat@example.com", phone: "555-0100" });
  const SAM = await add({ name: "Sam Noemail", phone: "555-0101" });
  const HTML_NAME = '<img src=x onerror="window.__xss318=1">Robin & Co';
  const ROBIN = await add({ name: HTML_NAME, email: "robin@example.com" });
  const GONE = await add({ name: "Pat Archived", email: "pat.archived@example.com" });
  await call({ action: "setCustomerArchived", id: GONE, archived: true });
  await lib.createProduct(d1, "acme", { productId: "cap", type: "cap", name: "Club cap", pricingMode: "flat", flatPrice: 20, visible: true, noDesignNeeded: true,
    personalizationPrice: 5, personalizationOptions: ["Left side", "Back"], qtyBreaks: [{ minQty: 12, off: 2 }, { minQty: 24, off: 3 }] });
  await lib.createProduct(d1, "acme", { productId: "tee", type: "tee", name: "Club <tee>", pricingMode: "sized", sizePricing: { S: 15, M: 15, XL: 18 }, visible: true, noDesignNeeded: true });
  await lib.createProduct(d1, "acme", { productId: "spare", type: "cap", name: "Spare cap", pricingMode: "flat", flatPrice: 9, visible: false, noDesignNeeded: true });
  await lib.createProduct(d1, "acme", { productId: "beanie", type: "cap", name: "Beanie", pricingMode: "flat", flatPrice: 10, visible: true, noDesignNeeded: true,
    personalizationPrice: 3, versionGroup: "beanies", versionLabel: "Winter" });
  await lib.createProduct(d1, "acme", { productId: "jacket", type: "jacket", name: "Build-a-jacket", pricingMode: "flat", flatPrice: 50, visible: true, noDesignNeeded: true });
  d1._raw.run("UPDATE products SET configurable = 1 WHERE productId = 'jacket'");
  await lib.createProduct(d1, "rec", { productId: "visor", type: "cap", name: "League visor", pricingMode: "flat", flatPrice: 12, visible: true, noDesignNeeded: true });
  d1._raw.run("UPDATE products SET configurable = 1 WHERE orgId = 'rec'");

  // ---- The page ---------------------------------------------------------------------------------------------------
  const adminJs = read("public/admin.js"), custJs = read("public/admin-customers.js"), quotesJs = read("public/admin-quotes.js");
  const sent = [], toasts = [], served = [];
  let quotesMode = "ok";   // "fail": /admin-quotes.js can't be fetched
  let quotesGate = null;   // a promise: /admin-quotes.js arrives when it settles
  let scripted = null;     // { action, status, body }: the next request for that action is answered with this
  let hold = null;         // { action, gate }: the next request for that action waits for gate
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
  class Loader extends ResourceLoader {
    fetch(url) {
      served.push(String(url));
      if (/\/admin-quotes\.js(\?|$)/.test(url)) return quotesMode === "fail" ? Promise.reject(new Error("offline")) : Promise.resolve(quotesGate).then(() => Buffer.from(quotesJs));
      if (/\/admin-customers\.js(\?|$)/.test(url)) return Promise.resolve(Buffer.from(custJs));
      if (/\/admin\.js(\?|$)/.test(url)) return Promise.resolve(Buffer.from(adminJs));
      return Promise.resolve(Buffer.from(""));
    }
  }
  const vc = new VirtualConsole();
  vc.sendTo(console, { omitJSDOMErrors: true });
  vc.on("jsdomError", (e) => { if (!/Not implemented|Could not load script: "https:\/\/admin\.example\.com\/admin-quotes\.js/.test(e.message)) console.error(e); });
  const dom = new JSDOM(storefrontPage(), { runScripts: "dangerously", resources: new Loader(), virtualConsole: vc, url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win) {
      win.CSS = win.CSS || { escape: (s) => String(s).replace(/["\\]/g, "\\$&") };
      win.fetch = async (url, init) => {
        const u = String(url), b = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
        if (!u.includes("/api/orders")) return reply(404, { status: "error", message: "not here" });
        sent.push(b);
        if (scripted && scripted.action === b.action) { const s = scripted; scripted = null; return reply(s.status || 200, typeof s.body === "function" ? await s.body(b) : s.body); }
        if (hold && hold.action === b.action) { const h = hold; hold = null; await h.gate; }
        const x = await call(b);
        return reply(x.status, x.body);
      };
    } });
  const w = dom.window, d = w.document;
  await pause(150);
  await w.loadAdminScript();
  w.showToast = (m, isErr) => toasts.push({ m: String(m), err: !!isErr });
  const twoShops = [{ orgId: "acme", name: "Example Club" }, { orgId: "rec", name: "Rec <i>League</i>" }];
  const setShops = (list) => w.eval("adminOrgs = " + JSON.stringify(list) + ";");
  w.eval('adminKey = "cookie"; setAdminTimeZone_("UTC");');
  setShops(twoShops);
  const q = (s) => d.querySelector(s), qa = (s) => [...d.querySelectorAll(s)];
  const app = d.getElementById("app");
  const page = () => d.getElementById("qtPage");
  const reset = () => { sent.length = 0; toasts.length = 0; globalThis.__mail318.length = 0; };
  const of = (action) => sent.filter(b => b.action === action);
  const lastToast = () => toasts[toasts.length - 1] || { m: "", err: false };
  const hashNow = () => w.location.hash.replace(/^#\/?/, "");
  const levelsOf = (role) => roles.effectivePermissions(roles.DEFAULT_ROLES[role]);
  const asRoles = (pageRole, serverRole) => { globalThis.__role318 = serverRole || pageRole; w.eval(roles.asRole(pageRole, { name: "Tester", email: "tester@example.test" })); };
  const signInWith = (perms, serverRole) => { globalThis.__role318 = serverRole || "admin"; w.eval(`adminMe = { role: "custom", roleName: "Front desk" }; adminPerms = ${JSON.stringify(perms)}; adminAreas = ${JSON.stringify(roles.PERMISSION_AREAS)};`); };
  const withLevels = (role, changes) => Object.assign({}, levelsOf(role), changes);
  const features = (f) => w.applyFeatures_(f);
  const off = (sel) => { const el = q(sel); return !!el && el.hasAttribute("data-perm-off"); };
  const shown = (sel) => { const el = q(sel); return !!el && !el.hasAttribute("data-perm-off"); };
  const modal = () => { const all = qa(".admin-modal"); return all[all.length - 1] || null; };
  const confirmBox = () => q(".confirm-modal");
  const answer = async (yes) => { await wait(() => confirmBox()); const box = confirmBox(); const info = { message: box.dataset.message, okLabel: box.querySelector("#cmOk").textContent };
    box.querySelector(yes ? "#cmOk" : "#cmCancel").click(); await wait(() => !confirmBox()); return info; };
  const listDrawn = () => !!(page() && q("#qtQ") && !/Loading…/.test(q("#qtBody").textContent));
  const oneDrawn = () => !!(page() && (q("#qtForm") || page().querySelector(".cust-err")));
  // Goes to an address the way a link does (or draws it again when it is already there), and waits for the screen.
  const go = async (hash, drawn) => {
    const old = page();
    if (hashNow() === hash) w.adminRoute(); else w.location.hash = "#" + hash;
    return wait(() => page() && page() !== old && (drawn || (hash.includes("/") ? oneDrawn : listDrawn))());
  };
  const openQ = (id) => go("quotes/" + id, oneDrawn);
  const redrawn = async (act) => { const old = page(); await act(); return wait(() => page() && page() !== old && oneDrawn()); };
  const rowButtons = () => qa("#adminNav .admin-nav-row > button.admin-nav-btn");
  const hashes = (btns) => btns.map(b => b.dataset.h);
  const lines = () => qa("#qtLines table.qt-lines tbody tr");
  const cells = (tr) => [...tr.children].map(td => td.textContent.trim());
  const totalsRows = () => qa("#qtTotals table.qt-sum tr").map(tr => tr.querySelector("th").textContent + " " + tr.querySelector("td").textContent);
  // The quote's own server call, for setting things up.
  const mk = async (org, customerId, extra) => { const r = await call(Object.assign({ action: "createEstimate", org, customerId }, extra || {})); if (r.status !== 200) throw new Error("seed quote: " + JSON.stringify(r.body)); return r.body; };
  const saveItems = async (id, items) => { const r = await call({ action: "saveEstimate", id, items }); if (r.status !== 200) throw new Error("seed items: " + JSON.stringify(r.body)); return r.body; };

  asRoles("admin");
  w.eval('adminMe.email = "tester@example.test";');

  console.log("=== The Quotes button in the menu ===");
  w.renderAdminNav();
  ok("the page's own script isn't loaded until Quotes is opened", !served.some(u => /admin-quotes\.js/.test(u)) && typeof w.renderQuotes !== "function");
  const adminRow = hashes(rowButtons());
  ok("an admin's top buttons have Quotes, named “Quotes”, once", adminRow.filter(h => h === "quotes").length === 1 && rowButtons().find(b => b.dataset.h === "quotes").textContent === "Quotes");
  ok("…right after Customers", adminRow[adminRow.indexOf("quotes") - 1] === "customers");
  ok("…a button that goes to #quotes like the others", rowButtons().find(b => b.dataset.h === "quotes").dataset.adminAction === "navGo" && rowButtons().find(b => b.dataset.h === "quotes").type === "button");
  ok("(the built-in roles) Admin and Manager have Full on Quotes, Back office Edit, Production none",
    levelsOf("admin")["quotes.estimates"] === "full" && levelsOf("manager")["quotes.estimates"] === "full" && levelsOf("staff")["quotes.estimates"] === "edit" && levelsOf("production")["quotes.estimates"] === "none");
  for (const [role, label] of [["manager", "Manager"], ["staff", "Back office"]]) {
    asRoles(role); w.renderAdminNav();
    ok(label + " gets the Quotes button too", hashes(rowButtons()).includes("quotes"));
  }
  asRoles("production"); w.renderAdminNav();
  ok("Production, with no access to Quotes, gets no Quotes button", rowButtons().length > 0 && !hashes(rowButtons()).includes("quotes") && !q('#adminNav [data-h="quotes"]'));
  signInWith(withLevels("admin", { "quotes.estimates": "read" })); w.renderAdminNav();
  ok("Read on Quotes is enough for the button", hashes(rowButtons()).includes("quotes") && w.adminCanQuotes_() === true && w.adminCanOpen_("quotes/3") === true);
  signInWith(withLevels("admin", { "customers.records": "none" })); w.renderAdminNav();
  ok("a role without Customers gets Quotes where Customers would be: right after Orders", !hashes(rowButtons()).includes("customers") && hashes(rowButtons())[hashes(rowButtons()).indexOf("quotes") - 1] === "orders");
  asRoles("admin");
  features({ quotes: false }); w.renderAdminNav();
  ok("with the Quotes feature turned off there is no Quotes button, even for an admin", !hashes(rowButtons()).includes("quotes") && hashes(rowButtons()).includes("customers") && w.adminCanOpen_("quotes") === false);
  features({}); w.renderAdminNav();
  ok("…and it is back when the feature is on again", hashes(rowButtons()).includes("quotes"));
  { const nothing = Object.fromEntries(Object.keys(levelsOf("admin")).map(f => [f, "none"]));
    signInWith(Object.assign({}, nothing, { "quotes.estimates": "read", "run.queue": "read" }));
    ok("a role whose first page is Quotes lands on Quotes, ahead of Run Order", w.adminFirstPage_() === "quotes"); }
  asRoles("admin");

  console.log("\n=== The #quotes route and the page's script (ensureQuotesPage_) ===");
  reset();
  features({ quotes: false });
  await go("quotes", () => !!q("#featureOffPanel"));
  ok("with the feature off, #quotes says “Quotes is turned off” and loads nothing", /Quotes is turned off/.test(app.textContent) && !served.some(u => /admin-quotes\.js/.test(u)) && sent.length === 0);
  features({});
  asRoles("production");
  await go("quotes/5", () => !!q("#roleOffPanel"));
  ok("a role without Quotes is told “Not available to you” at a quote's address, and nothing is asked for", /Not available to you\./.test(app.textContent) && !served.some(u => /admin-quotes\.js/.test(u)) && sent.length === 0);
  asRoles("admin");
  quotesMode = "fail";
  await go("quotes", () => /Couldn't load the Quotes page/.test(app.textContent));
  ok("the script can't be loaded: “Couldn't load the Quotes page. Check your connection and reload the page.”", q("#app .admin-empty").textContent === "Couldn't load the Quotes page. Check your connection and reload the page.");
  ok("…under the Quotes heading and the tab's title, and the address stays #quotes", q("h1").textContent.trim() === "Quotes" && /Quotes \(Admin\)$/.test(d.title) && hashNow() === "quotes");
  ok("…the script was asked for at /admin-quotes.js, and its tag taken out again", served.filter(u => /\/admin-quotes\.js$/.test(u)).length === 1 && !q('script[src="/admin-quotes.js"]'));
  { let refused = null; try { await w.ensureQuotesPage_(); } catch (e) { refused = e; }
    ok("ensureQuotesPage_ fails with a plain sentence and asks again each time", !!refused && refused.message === "Couldn't load the Quotes page" && served.filter(u => /\/admin-quotes\.js$/.test(u)).length === 2); }
  quotesMode = "ok";
  { let release; quotesGate = new Promise(r => { release = r; });
    reset();
    w.location.hash = "#quotes";
    await wait(() => served.filter(u => /\/admin-quotes\.js$/.test(u)).length === 3);
    const p1 = w.ensureQuotesPage_(), p2 = w.ensureQuotesPage_();
    ok("while the script is on its way, everyone who asks waits for the same one", p1 === p2 && served.filter(u => /\/admin-quotes\.js$/.test(u)).length === 3);
    w.location.hash = "#home";
    await wait(() => !/Couldn't load the Quotes page/.test(app.textContent));
    release(); quotesGate = null; await p1; await pause(80);
    ok("the address moved on while it loaded: the Quotes page isn't drawn over the page now asked for", !q("#qtPage") && sent.filter(b => b.action === "listEstimates").length === 0 && hashNow() === "home"); }
  reset();
  ok("once it is there, #quotes draws the list", await go("quotes") && !!q("#qtQ") && typeof w.renderQuotes === "function");
  ok("…the script was fetched once more, and only once", served.filter(u => /\/admin-quotes\.js$/.test(u)).length === 3 && qa('script[src="/admin-quotes.js"]').length === 1);
  ok("…Quotes is lit in the menu", rowButtons().find(b => b.dataset.h === "quotes").classList.contains("active") && w.adminNavActive_() === "quotes");
  { const n = served.length; await w.ensureQuotesPage_(); ok("asking for the page again once it is there fetches nothing", served.length === n); }
  reset();
  await go("quotes/abc");
  ok("an address that isn't a quote's number (#quotes/abc) is the list, and asks for no quote", !!q("#qtQ") && of("getEstimate").length === 0 && of("listEstimates").length === 1);
  for (const [label, v] of [["nothing", null], ["an empty id", ""], ["zero", 0], ["a negative number", -2], ["a fraction", 1.5], ["letters", "x"]]) {
    reset();
    await w.renderQuotes(app, v);
    ok("renderQuotes with " + label + " draws the list", !!q("#qtQ") && of("getEstimate").length === 0 && of("listEstimates").length === 1);
  }

  console.log("\n=== The list: #quotes ===");
  reset();
  await go("quotes");
  ok("the list is headed “Quotes”, in the tab's title too", q("h1.org-name").textContent === "Quotes" && /Quotes \(Admin\)$/.test(d.title));
  ok("with no quotes it says how to start one, and shows no count or pages", q("#qtBody .cust-note").textContent === "No quotes yet. Start one with “+ New quote”, or from a customer's page." && q("#qtCount").textContent === "" && q("#qtPager").innerHTML === "");
  ok("…it asked for the first 50 quotes of any status and shop, with no search", of("listEstimates").length === 1 && same(of("listEstimates")[0], { action: "listEstimates", q: "", status: "", limit: 50, offset: 0, key: "cookie" }));
  ok("the search box is labelled “Search” and says what it finds", q("#qtQ").closest("label").querySelector("span").textContent === "Search" && q("#qtQ").placeholder === "Quote number, title or customer" && q("#qtQ").type === "search");
  ok("the status filter is labelled “Status”: Any status, then every status by name", q("#qtStatus").closest("label").querySelector("span").textContent === "Status" &&
    same([...q("#qtStatus").options].map(o => o.value + "=" + o.textContent), ["=Any status", "draft=Draft", "sent=Sent", "changes=Changes asked", "accepted=Accepted", "converted=Converted", "cancelled=Cancelled"]));
  ok("with two shops, a “Shop” filter: All shops, then each shop by name, shown as text", q("#qtShop").closest("label").querySelector("span").textContent === "Shop" &&
    same([...q("#qtShop").options].map(o => o.value + "=" + o.textContent), ["=All shops", "acme=Example Club", "rec=Rec <i>League</i>"]) && !q("#qtShop i"));
  ok("“+ New quote” is there, and needs Edit on Quotes", q("#qtNew").textContent === "+ New quote" && q("#qtNew").getAttribute("data-need") === "quotes.estimates:edit" && shown("#qtNew"));
  ok("the count under the bar is announced", q("#qtCount").getAttribute("role") === "status" && q("#qtCount").getAttribute("aria-live") === "polite");

  // Quotes to list: one for Pat in each shop, a cancelled one, one past its last day, and 52 for Sam.
  const Q1 = (await mk("acme", PAT, { title: "Team <b>shirts</b>", expiresOn: "2999-06-30" })).id;
  await saveItems(Q1, [{ kind: "product", productId: "cap", size: "OSFA", qty: 2 }]);
  const QREC = (await mk("rec", PAT, { title: "League visors" })).id;
  const QCAN = (await mk("acme", ROBIN, { title: "Old order" })).id;
  await call({ action: "cancelEstimate", id: QCAN });
  const QOLD = (await mk("acme", PAT, { title: "Last year" })).id;
  d1._raw.run("UPDATE estimates SET expiresOn = '2000-01-01' WHERE id IN (?, ?)", [QOLD, QCAN]);
  const bulk = [];
  for (let i = 1; i <= 52; i++) bulk.push((await mk("acme", SAM, { title: "Bulk " + String(i).padStart(2, "0") })).id);
  // Fixed, distinct times, so the order (newest change first) is known: Q1 newest, then QREC, QCAN, QOLD, then the bulk ones.
  d1._raw.run("UPDATE estimates SET updatedAt = '2026-01-01T12:00:00.000Z', createdAt = '2026-01-01T12:00:00.000Z'");
  d1._raw.run("UPDATE estimates SET updatedAt = '2026-03-05T12:00:00.000Z' WHERE id = ?", [Q1]);
  d1._raw.run("UPDATE estimates SET updatedAt = '2026-03-04T12:00:00.000Z' WHERE id = ?", [QREC]);
  d1._raw.run("UPDATE estimates SET updatedAt = '2026-03-03T12:00:00.000Z' WHERE id = ?", [QCAN]);
  d1._raw.run("UPDATE estimates SET updatedAt = '2026-03-02T12:00:00.000Z' WHERE id = ?", [QOLD]);
  const rows = () => qa("#qtBody table.qt-table tbody tr");
  const heads = () => qa("#qtBody table.qt-table thead th").map(th => th.textContent);
  const rowOf = (id) => q(`#qtBody tr[data-qt-id="${id}"]`);

  reset();
  await go("quotes");
  ok("the list's columns: Quote, Customer, Title, Shop, Status, Total, Expires, Updated", same(heads(), ["Quote", "Customer", "Title", "Shop", "Status", "Total", "Expires", "Updated"]));
  ok("50 quotes to a page, the most recently changed first", rows().length === 50 && rows()[0].dataset.qtId === String(Q1) && rows()[1].dataset.qtId === String(QREC) && rows()[2].dataset.qtId === String(QCAN) && rows()[3].dataset.qtId === String(QOLD));
  ok("the count says which ones are shown of how many", q("#qtCount").textContent === "Showing 1–50 of 56 quotes");
  { const r = rowOf(Q1);
    ok("a row: the quote's number as a link to it, the customer, the title, the shop, the status, the total, the last day and the last change",
      same(cells(r), [est(Q1).number, "Pat Example", "Team <b>shirts</b>", "Example Club", "Draft", "$40.00", w.adminDate_("2999-06-30"), w.adminDate_("2026-03-05T12:00:00.000Z")]) &&
      r.querySelector("a").getAttribute("href") === "#quotes/" + Q1 && /^Q-\d{5}$/.test(est(Q1).number));
    ok("…a title is text, never markup", !r.querySelector("b"));
    ok("…the status is a tag named for it", r.querySelector(".qt-st").textContent === "Draft" && r.querySelector(".qt-st").classList.contains("qt-st-draft")); }
  ok("a shop's name is shown as text", cells(rowOf(QREC))[3] === "Rec <i>League</i>" && !rowOf(QREC).querySelector("i"));
  ok("a quote with no lines totals $0.00, and one with no last day shows none", cells(rowOf(QREC))[5] === "$0.00" && cells(rowOf(QREC))[6] === "");
  ok("a cancelled quote is greyed and tagged “Cancelled” — not “Expired”, though its last day has passed", rowOf(QCAN).classList.contains("cust-row-archived") && cells(rowOf(QCAN))[4] === "Cancelled" && !rowOf(QCAN).querySelector(".cust-tag-warn"));
  ok("a customer's name is text, never markup", cells(rowOf(QCAN))[1] === HTML_NAME && !rowOf(QCAN).querySelector("img"));
  ok("an open quote whose last day has passed is tagged “Expired” as well, as a warning", cells(rowOf(QOLD))[4] === "Draft Expired" && rowOf(QOLD).querySelector(".cust-tag-warn").textContent === "Expired" && !rowOf(Q1).querySelector(".cust-tag-warn"));
  const pagerBtn = (which) => q(`#qtPager button[data-qt-page="${which}"]`);
  ok("the pages: “‹ Previous” off on the first page, “Next ›” on", pagerBtn("prev").textContent === "‹ Previous" && pagerBtn("prev").disabled && pagerBtn("next").textContent === "Next ›" && !pagerBtn("next").disabled);
  reset();
  pagerBtn("next").click();
  await wait(() => q("#qtCount").textContent.startsWith("Showing 51"));
  ok("Next asks for the next 50 and shows them", of("listEstimates").length === 1 && of("listEstimates")[0].offset === 50 && rows().length === 6 && q("#qtCount").textContent === "Showing 51–56 of 56 quotes");
  ok("…on the last page Next is off and Previous on", pagerBtn("next").disabled && !pagerBtn("prev").disabled);
  reset();
  pagerBtn("prev").click();
  await wait(() => q("#qtCount").textContent.startsWith("Showing 1–"));
  ok("Previous goes back to the first 50", of("listEstimates")[0].offset === 0 && rows().length === 50);
  pagerBtn("next").click();
  await wait(() => q("#qtCount").textContent.startsWith("Showing 51"));
  // The page being looked at empties meanwhile: the list goes back to the first page.
  d1._raw.run("UPDATE estimates SET orgId = 'rec' WHERE id IN (SELECT id FROM estimates WHERE title LIKE 'Bulk%' ORDER BY id LIMIT 20)");
  q("#qtShop").value = "acme"; reset();
  q("#qtShop").dispatchEvent(new w.Event("change", { bubbles: true }));
  await wait(() => of("listEstimates").length === 1 && q("#qtCount").textContent === "35 quotes");
  ok("picking a shop asks for that shop's quotes from the first page", of("listEstimates")[0].org === "acme" && of("listEstimates")[0].offset === 0 && q("#qtCount").textContent === "35 quotes" && !q("#qtPager button"));
  ok("…a list that fits on one page has no Previous or Next", q("#qtPager").innerHTML.trim() === "");
  d1._raw.run("UPDATE estimates SET orgId = 'acme' WHERE title LIKE 'Bulk%'");
  q("#qtShop").value = ""; q("#qtShop").dispatchEvent(new w.Event("change", { bubbles: true }));
  await wait(() => q("#qtCount").textContent === "Showing 1–50 of 56 quotes");
  pagerBtn("next").click();
  await wait(() => q("#qtCount").textContent.startsWith("Showing 51"));
  d1._raw.run("DELETE FROM estimates WHERE id IN (SELECT id FROM estimates WHERE title LIKE 'Bulk%' ORDER BY updatedAt, id LIMIT 10)");
  reset();
  await go("quotes");
  ok("coming back to a page that no longer has any quote shows the first page instead", same(of("listEstimates").map(b => b.offset), [50, 0]) && q("#qtCount").textContent === "46 quotes" && rows().length === 46);

  reset();
  q("#qtStatus").value = "cancelled"; q("#qtStatus").dispatchEvent(new w.Event("change", { bubbles: true }));
  await wait(() => of("listEstimates").length === 1 && q("#qtCount").textContent === "1 quote");
  ok("the status filter asks for that status, and one quote is “1 quote”", of("listEstimates")[0].status === "cancelled" && rows().length === 1 && rows()[0].dataset.qtId === String(QCAN));
  q("#qtStatus").value = ""; q("#qtStatus").dispatchEvent(new w.Event("change", { bubbles: true }));
  await wait(() => q("#qtCount").textContent === "46 quotes");
  reset();
  const type = (text) => { q("#qtQ").value = text; q("#qtQ").dispatchEvent(new w.Event("input", { bubbles: true })); };
  type("Le"); type("Leag"); type("  League  ");
  ok("typing doesn't search on every key", of("listEstimates").length === 0);
  await wait(() => of("listEstimates").length === 1); await pause(320);
  ok("…it searches once, after a pause, for what was typed last, trimmed", of("listEstimates").length === 1 && of("listEstimates")[0].q === "League" && rows().length === 1 && rows()[0].dataset.qtId === String(QREC));
  reset();
  type("nothing like this"); await wait(() => of("listEstimates").length === 1 && !q("#qtBody table"));
  ok("a search that finds nothing says “No quote matches.”", q("#qtBody .cust-note").textContent === "No quote matches." && q("#qtCount").textContent === "");
  type('"><b>x'); await wait(() => of("listEstimates").length === 2);
  await go("quotes/" + Q1, oneDrawn);
  await go("quotes");
  ok("coming back to the list keeps the search, shown as typed (never as markup)", q("#qtQ").value === '"><b>x' && !page().querySelector(".cust-bar b") && of("listEstimates").pop().q === '"><b>x');
  type(""); await wait(() => q("#qtCount").textContent === "46 quotes");
  scripted = { action: "listEstimates", body: { status: "ok", estimates: [{ id: 77, number: "", customerName: "", title: "", orgId: "gone", status: "odd", total: null, expiresOn: null, updatedAt: "" }], total: 1 } };
  await go("quotes");
  ok("a row the server sends with little in it: “Quote <id>”, the shop's id, Draft, a dash for the total, no days", same(cells(rowOf(77)), ["Quote 77", "", "", "gone", "Draft", "—", "", ""]) && q("#qtCount").textContent === "1 quote");
  scripted = { action: "listEstimates", status: 503, body: { status: "error", message: "Quotes aren't set up on this database yet." } };
  reset(); await go("quotes", () => !!q("#qtBody .cust-err"));
  ok("a list the server can't give: its sentence, as an alert, with no count or pages", q("#qtBody .cust-err").textContent === "Quotes aren't set up on this database yet." && q("#qtBody .cust-err").getAttribute("role") === "alert" && q("#qtCount").textContent === "" && q("#qtPager").innerHTML === "");
  { let release; hold = { action: "listEstimates", gate: new Promise(r => { release = r; }) };
    await go("quotes", () => !!q("#qtQ"));
    await wait(() => !hold);
    type("Team"); await wait(() => /1 quote/.test(q("#qtCount").textContent));
    release(); await pause(120);
    ok("a slow answer to an earlier ask never replaces the newer search's results", q("#qtCount").textContent === "1 quote" && rows().length === 1 && rows()[0].dataset.qtId === String(Q1)); }
  { let release; hold = { action: "listEstimates", gate: new Promise(r => { release = r; }) };
    w.adminRoute(); await wait(() => !hold);
    await go("home", () => !q("#qtPage"));
    release(); await pause(120);
    ok("…nor draws over the page the admin went to meanwhile", !q("#qtPage") && hashNow() === "home"); }
  await go("quotes");
  { const td = rowOf(Q1).children[2];
    td.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    ok("pressing anywhere on a row opens that quote", await wait(() => hashNow() === "quotes/" + Q1 && oneDrawn())); }
  await go("quotes"); type(""); await pause(320);
  setShops([{ orgId: "acme", name: "Example Club" }]);
  await go("quotes");
  ok("with one shop there is no Shop filter or column", !q("#qtShop") && same(heads(), ["Quote", "Customer", "Title", "Status", "Total", "Expires", "Updated"]) && rowOf(Q1).children.length === 7);
  setShops(twoShops);
  q("#qtShop") || await go("quotes");
  q("#qtShop").value = "rec"; q("#qtShop").dispatchEvent(new w.Event("change", { bubbles: true }));
  await wait(() => q("#qtCount").textContent === "1 quote");
  setShops([{ orgId: "acme", name: "Example Club" }, { orgId: "other", name: "Other Example" }]);
  reset(); await go("quotes");
  ok("a shop picked earlier that the admin no longer has is dropped from the filter", of("listEstimates")[0].org === undefined && q("#qtShop").value === "");
  setShops(twoShops);
  await go("quotes");

  console.log("\n=== + New quote ===");
  const nq = () => modal();
  const nqOpen = async () => { q("#qtNew").focus(); q("#qtNew").click(); return wait(() => nq() && nq().querySelector("#qtNewForm")); };
  const nqClose = async () => { const m = nq(); m.querySelector("#qtNewCancel").click(); if (await wait(() => confirmBox() || !m.isConnected, 50) && confirmBox()) await answer(true); await wait(() => !m.isConnected); };
  const nqType = (text) => { const i = nq().querySelector("#qtNewCust"); i.value = text; i.dispatchEvent(new w.Event("input", { bubbles: true })); };
  const nqFound = () => [...nq().querySelectorAll("#qtNewCustList button")];
  reset();
  ok("the button opens a window titled “New quote”", await nqOpen() && nq().querySelector("[data-dialog-title]").textContent === "New quote");
  ok("…focus starts in the customer search, labelled “Customer”", d.activeElement === nq().querySelector("#qtNewCust") && nq().querySelector('label[for="qtNewCust"] span').textContent === "Customer");
  ok("…with two shops a “Shop” choice, each by name as text, the last shop used picked", same([...nq().querySelector("#qtNewShop").options].map(o => o.value + "=" + o.textContent), ["acme=Example Club", "rec=Rec <i>League</i>"]) && nq().querySelector("#qtNewShop").value === w.adminLastShop_());
  ok("…a title, optional, and the last day it can be accepted: 30 days from today to start", nq().querySelector("#qtNewTitle").closest("label").textContent.trim() === "Title (optional)" &&
    nq().querySelector("#qtNewExpires").type === "date" && nq().querySelector("#qtNewExpires").value === w.localToday_(30) && /blank = no end/.test(nq().querySelector("#qtNewExpires").closest("label").textContent));
  ok("…its buttons: Cancel and Create quote; nothing asked of the server yet", same([...nq().querySelectorAll(".cust-dialog-actions button")].map(b => b.textContent), ["Cancel", "Create quote"]) && sent.length === 0);
  nq().querySelector("#qtNewForm").dispatchEvent(new w.Event("submit", { cancelable: true }));
  ok("Create quote with no customer picked: “Search for the customer and pick them from the list first.”, focus back in the search", nq().querySelector("#qtNewErr").textContent === "Search for the customer and pick them from the list first." &&
    nq().querySelector("#qtNewErr").getAttribute("role") === "alert" && d.activeElement === nq().querySelector("#qtNewCust") && sent.length === 0);
  nqType("pat");
  await wait(() => of("listCustomers").length === 1 && nqFound().length > 0);
  ok("the search is the shared customer search: listCustomers, archived customers left out", of("listCustomers")[0].q === "pat" && of("listCustomers")[0].includeArchived === false && nqFound().every(b => !/Archived/.test(b.textContent)) && nqFound().length === 1);
  nqFound()[0].click();
  ok("picking a customer shows “For” them in place of the search, and focus moves to the title", nq().querySelector("#qtNewFind").hidden && !nq().querySelector("#qtNewPicked").hidden &&
    nq().querySelector("#qtNewPickedText").textContent === "For Pat Example · Example Club · pat@example.com · 555-0100" && d.activeElement === nq().querySelector("#qtNewTitle"));
  nq().querySelector("#qtNewChange").click();
  ok("“Change” brings the search back, emptied, with focus in it", !nq().querySelector("#qtNewFind").hidden && nq().querySelector("#qtNewPicked").hidden && nq().querySelector("#qtNewCust").value === "" && d.activeElement === nq().querySelector("#qtNewCust") && nq().querySelector("#qtNewPickedText").textContent === "");
  nqType("Robin");
  await wait(() => nqFound().length === 1);
  nqFound()[0].click();
  ok("a customer's name is shown as text in the window", nq().querySelector("#qtNewPickedText").textContent.startsWith("For " + HTML_NAME) && !nq().querySelector("img"));
  nq().querySelector("#qtNewExpires").value = w.localToday_(-1);
  reset(); nq().querySelector("#qtNewForm").dispatchEvent(new w.Event("submit", { cancelable: true }));
  ok("a last day already gone: “The last day to accept can't be in the past.”, focus on it, nothing sent", nq().querySelector("#qtNewErr").textContent === "The last day to accept can't be in the past." && d.activeElement === nq().querySelector("#qtNewExpires") && sent.length === 0);
  nq().querySelector("#qtNewExpires").value = "";
  nq().querySelector("#qtNewTitle").value = "  Spring <hats>  ";
  nq().querySelector("#qtNewShop").value = "rec";
  scripted = { action: "createEstimate", status: 400, body: { status: "error", message: "That customer was merged into another one. Open that one instead." } };
  reset(); nq().querySelector("#qtNewForm").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await wait(() => nq().querySelector("#qtNewErr").textContent !== "");
  ok("a refusal from the server is shown in the window, and Create quote can be pressed again", nq().querySelector("#qtNewErr").textContent === "That customer was merged into another one. Open that one instead." && !nq().querySelector("#qtNewSave").disabled && !!nq());
  reset();
  nq().querySelector("#qtNewForm").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await wait(() => of("createEstimate").length === 1 && /^quotes\/\d+$/.test(hashNow()) && oneDrawn());
  const QNEW = Number(hashNow().split("/")[1]);
  ok("Create quote sends the shop, the customer, the title trimmed and no last day (blank)", same(of("createEstimate")[0], { action: "createEstimate", org: "rec", customerId: ROBIN, title: "Spring <hats>", expiresOn: null, key: "cookie" }));
  ok("…closes the window, says “Quote Q-… started.” and opens the new quote", !modal() && lastToast().m === "Quote " + est(QNEW).number + " started." && !lastToast().err && est(QNEW).customerId === ROBIN && est(QNEW).orgId === "rec" && est(QNEW).expiresOn == null);
  ok("…and the shop becomes the one last used", w.adminLastShop_() === "rec");
  await go("quotes");
  reset(); await nqOpen();
  ok("the next New quote starts in that shop", nq().querySelector("#qtNewShop").value === "rec");
  nq().querySelector("#qtNewTitle").value = "x"; nq().querySelector("#qtNewTitle").dispatchEvent(new w.Event("input", { bubbles: true }));
  nq().querySelector("#qtNewCancel").click();
  { const asked = await answer(false);
    ok("Cancel after typing asks before throwing it away", asked.message.startsWith("Discard changes?") && !!nq() && nq().querySelector("#qtNewTitle").value === "x"); }
  nq().querySelector("#qtNewCancel").click(); await answer(true);
  ok("…and closes the window when told to, with nothing made", await wait(() => !modal()) && of("createEstimate").length === 0);
  w.renderQuotes.newForCustomer({ name: "No id" });
  ok("a customer handed over without an id opens the window with the search, nobody picked", await wait(() => modal() && modal().querySelector("#qtNewForm")) && !nq().querySelector("#qtNewFind").hidden && nq().querySelector("#qtNewPicked").hidden && d.activeElement === nq().querySelector("#qtNewCust"));
  nq().querySelector("[data-modal-close]").click(); await wait(() => !modal());
  setShops([{ orgId: "acme", name: "Example Club" }]);
  await go("quotes");
  await nqOpen();
  ok("with one shop there is no Shop choice", !nq().querySelector("#qtNewShop"));
  nqType("Sam"); await wait(() => nqFound().length === 1); nqFound()[0].click();
  reset();
  nq().querySelector("#qtNewForm").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await wait(() => of("createEstimate").length === 1 && oneDrawn());
  ok("…the quote is made in that one shop, with the 30-day last day", of("createEstimate")[0].org === "acme" && of("createEstimate")[0].expiresOn === w.localToday_(30) && of("createEstimate")[0].title === "");
  const QSAM = Number(hashNow().split("/")[1]);
  setShops(twoShops);
  await go("quotes");
  setShops([]);
  reset(); q("#qtNew").click(); await pause(20);
  ok("with no shop at all: “Add a shop first — a quote is made in a shop.”, and no window", lastToast().m === "Add a shop first — a quote is made in a shop." && lastToast().err && !modal());
  setShops(twoShops);
  signInWith(withLevels("admin", { "customers.records": "none" }));
  reset(); q("#qtNew").click(); await pause(20);
  ok("a role that can't pick a customer is told so, and no window opens", lastToast().m === "Your role can't pick a customer, so it can't start a quote. Ask an admin." && lastToast().err && !modal());
  signInWith(withLevels("admin", { "quotes.estimates": "read" }));
  await go("quotes");
  ok("a role with Read on Quotes sees the list but isn't offered + New quote", rows().length > 0 && off("#qtNew"));
  reset(); w.renderQuotes.newForCustomer({ id: PAT, name: "Pat Example" }); await pause(20);
  ok("…and is told “Your role can't make quotes.” if it gets there anyway", lastToast().m === "Your role can't make quotes." && lastToast().err && !modal());
  asRoles("admin");

  console.log("\n=== One quote: #quotes/<id> ===");
  const N1 = est(Q1).number;
  reset();
  ok("#quotes/<id> draws that quote, asked for by number, once", await openQ(Q1) && same(of("getEstimate"), [{ action: "getEstimate", id: Q1, key: "cookie" }]));
  ok("…headed by its number, on the page, in the tab's title and in the breadcrumbs under Quotes", q("h1.org-name").textContent === N1 && d.title.includes(N1) && q(".bc-current").textContent === N1 && /Quotes/.test(q(".admin-hero").textContent));
  ok("…with a “‹ Quotes” link back to the list", q("#qtPage a.backlink").getAttribute("href") === "#quotes" && q("#qtPage a.backlink").textContent === "‹ Quotes");
  ok("…the number, the title (as text) and a “Draft” tag in its heading", q("h2.cust-name").textContent.replace(/\s+/g, " ").trim() === N1 + " · Team <b>shirts</b> Draft" && !q("h2.cust-name b") && q("h2.cust-name .qt-st-draft").textContent === "Draft");
  ok("…who it is for, as a link to the customer, the shop, and when it was started", q(".cust-sub").textContent.replace(/\s+/g, " ").trim() === "For Pat Example · Example Club · Started " + w.adminDate_("2026-01-01T12:00:00.000Z") &&
    q(".cust-sub a.cust-link").getAttribute("href") === "#customers/" + PAT);
  ok("…nothing about sending yet", qa("#qtPage .cust-sub").length === 1);
  ok("the buttons: Send…, Convert to order…, Cancel quote…; Send needs Edit and Cancel Full", same(qa(".cust-actions button").map(b => b.textContent), ["Send…", "Convert to order…", "Cancel quote…"]) &&
    q("#qtSend").getAttribute("data-need") === "quotes.estimates:edit" && q("#qtCancel").getAttribute("data-need") === "quotes.estimates:full" && shown("#qtSend") && shown("#qtCancel"));
  ok("the form: Title, the last day, the note to the customer and the internal note, each labelled", same(qa("#qtForm label.cust-field > span").map(s => s.textContent),
    ["Title", "Can be accepted until (blank = no end)", "Note to the customer (shown on the quote)", "Internal note (staff only)"]) && qa("#qtForm > .cust-grid input, #qtForm > label textarea").every(f => !!f.closest("label")));
  ok("…holding the stored title and last day", q("#qtTitle").value === "Team <b>shirts</b>" && q("#qtExpires").value === "2999-06-30" && q("#qtExpires").type === "date" && q("#qtMessage").value === "" && q("#qtInternal").value === "");
  ok("…a “Lines” heading, and buttons to add a product, a custom line or a fee", q("#qtForm h3.cust-h").textContent === "Lines" && same(qa(".qt-add button").map(b => b.textContent), ["+ Product", "+ Custom line", "+ Fee"]));
  ok("the lines' columns: Item, Qty, List, Quantity price, Unit, Total, and one for Change / Remove (named for a screen reader)", same(qa("#qtLines thead th").map(th => th.textContent), ["Item", "Qty", "List", "Quantity price", "Unit", "Total", "Change or remove"]) && !!q("#qtLines thead .qt-sr"));
  ok("a product line: its name, the quantity in a box, its list price, no quantity price yet, its unit price and total — the server's figures", same(cells(lines()[0]).slice(0, 6), ["Club cap", "", "$20.00", "", "$20.00", "$40.00"]) &&
    lines()[0].querySelector("input.qt-qty").value === "2" && Number(itemsOf(Q1)[0].lineTotalCents) === 4000);
  ok("…the quantity box is labelled for its line, and takes 1 to 5000", lines()[0].querySelector("input.qt-qty").getAttribute("aria-label") === "Quantity of Club cap" && lines()[0].querySelector("input.qt-qty").min === "1" && lines()[0].querySelector("input.qt-qty").max === "5000");
  ok("…Change and Remove name the line for a screen reader", same([...lines()[0].querySelectorAll(".qt-line-acts button")].map(b => b.textContent + "|" + b.getAttribute("aria-label")), ["Change|Change Club cap", "Remove|Remove Club cap"]));
  ok("the totals: a tax-inclusive quote with no tax shows just the Total", same(totalsRows(), ["Total $40.00"]) && q("#qtTotals").getAttribute("aria-live") === "polite");
  ok("…and, while it is a draft, that prices follow the catalog until it is sent", q("#qtTotals .cust-note").textContent === "Prices follow the catalog until the quote is sent; from then on they are fixed.");
  ok("Save is there, with a status beside it", q("#qtSave").textContent === "Save" && q("#qtSave").type === "submit" && q("#qtSaved").getAttribute("role") === "status");

  console.log("\n=== A line's quantity ===");
  const qtyBox = (i) => lines()[i].querySelector("input.qt-qty");
  const setQty = (i, v) => { const b = qtyBox(i); b.focus(); b.value = v; b.dispatchEvent(new w.Event("change", { bubbles: true })); };
  const afterSave = async (act) => { q("#qtSaved").textContent = ""; const n = of("saveEstimate").length; await act(); return wait(() => of("saveEstimate").length === n + 1 && q("#qtSaved").textContent === "Saved."); };
  reset();
  ok("a quantity typed into a line is saved at once", await afterSave(() => setQty(0, "12")));
  ok("…the whole quote is sent: what is typed above and every line", same(of("saveEstimate")[0], { action: "saveEstimate", id: Q1, title: "Team <b>shirts</b>", message: "", internalNote: "", expiresOn: "2999-06-30",
    items: [{ kind: "product", productId: "cap", size: "OSFA", qty: 12, personalized: false, persName: "" }], key: "cookie" }));
  ok("…and the line shows the server's price: list $20.00, the 12-piece price $2.00 off, $18.00 each, $216.00", same(cells(lines()[0]).slice(2, 6), ["$20.00", "−$2.00", "$18.00", "$216.00"]) && same(totalsRows(), ["Total $216.00"]));
  ok("…“Saved.” is said, and focus is back in that quantity", q("#qtSaved").textContent === "Saved." && d.activeElement === qtyBox(0));
  for (const bad of ["0", "5001", "2.5", "x", ""]) {
    reset(); setQty(0, bad); await pause(20);
    ok(`a quantity of “${bad}” is refused: “A quantity is a whole number from 1 to 5,000.”, nothing sent, focus in it`, q("#qtErr").textContent === "A quantity is a whole number from 1 to 5,000." && sent.length === 0 && d.activeElement === qtyBox(0));
  }
  reset(); setQty(0, "12"); await pause(30);
  ok("the same quantity again sends nothing", sent.length === 0);
  { const ev = new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }); qtyBox(0).focus(); qtyBox(0).dispatchEvent(ev);
    ok("Enter in a quantity doesn't send the whole form: it leaves the box (which saves it)", ev.defaultPrevented && d.activeElement !== qtyBox(0) && of("saveEstimate").length === 0); }
  { const ev = new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }); q("#qtTitle").dispatchEvent(ev);
    ok("…Enter anywhere else is left alone", !ev.defaultPrevented); }

  console.log("\n=== + Product ===");
  const pm = () => modal();
  const openProduct = async (btn) => { const n = qa(".admin-modal").length; (btn || q("#qtAddProduct")).click(); return wait(() => qa(".admin-modal").length === n + 1 && !!pm().querySelector("#qtProdForm")); };
  const submitIn = async (formSel) => { const m = modal(); const n = of("saveEstimate").length; m.querySelector(formSel).dispatchEvent(new w.Event("submit", { cancelable: true })); await wait(() => !m.isConnected || m.querySelector(".cust-err").textContent !== "" || of("saveEstimate").length > n); await wait(() => !m.isConnected || m.querySelector(".cust-err").textContent !== "", 60); return m; };
  const choose = (sel, v) => { const el = pm().querySelector(sel); el.value = v; el.dispatchEvent(new w.Event("change", { bubbles: true })); };
  const tick = (sel, on) => { const el = modal().querySelector(sel); el.checked = on; el.dispatchEvent(new w.Event("change", { bubbles: true })); };
  reset();
  ok("“+ Product” opens “Add a product”, with focus on the product", await openProduct() && pm().querySelector("[data-dialog-title]").textContent === "Add a product" && d.activeElement === pm().querySelector("#qtProd"));
  ok("…the shop's products are asked for, once", same(of("listProducts").map(b => b.org), ["acme"]));
  ok("…every product of the shop, by name as text, a version with its label, a hidden one marked “(hidden)” — but not one with choices to make", same([...pm().querySelectorAll("#qtProd option")].map(o => o.value + "=" + o.textContent).sort(), ["beanie=Beanie — Winter", "cap=Club cap", "spare=Spare cap (hidden)", "tee=Club <tee>"]) && !pm().querySelector("#qtProd tee"));
  choose("#qtProd", "tee");
  ok("a product with sizes: a Size choice with each size's price", !pm().querySelector("#qtProdSizeWrap").hidden && same([...pm().querySelectorAll("#qtProdSize option")].map(o => o.textContent), ["S — $15.00", "M — $15.00", "XL — $18.00"]));
  ok("…no personalization for a product that has none", pm().querySelector("#qtProdPersWrap").hidden);
  ok("…the catalog price is shown for the size picked", pm().querySelector("#qtProdPreview").textContent === "Catalog price $15.00 each." && pm().querySelector("#qtProdPreview").getAttribute("role") === "status");
  choose("#qtProdSize", "XL");
  ok("…and follows the size", pm().querySelector("#qtProdPreview").textContent === "Catalog price $18.00 each.");
  ok("Quantity starts at 1, and takes up to 5000", pm().querySelector("#qtProdQty").value === "1" && pm().querySelector("#qtProdQty").max === "5000");
  ok("(Admin may price by hand) a box to set the price per piece by hand, its field hidden until ticked", !!pm().querySelector("#qtProdOwn") && !pm().querySelector("#qtProdOwn").checked && pm().querySelector("#qtProdOwnWrap").hidden &&
    pm().querySelector("#qtProdOwn").closest("label").textContent.trim() === "Set the price per piece by hand (no quantity price)");
  ok("…the buttons: Cancel and Add line", same([...pm().querySelectorAll(".cust-dialog-actions button")].map(b => b.textContent), ["Cancel", "Add line"]));
  for (const bad of ["0", "5001", "1.5", ""]) {
    pm().querySelector("#qtProdQty").value = bad; reset();
    await submitIn("#qtProdForm");
    ok(`a quantity of “${bad}” is refused: “Enter a quantity from 1 to 5,000.”, focus on it, nothing sent`, pm().querySelector("#qtProdErr").textContent === "Enter a quantity from 1 to 5,000." && d.activeElement === pm().querySelector("#qtProdQty") && sent.length === 0);
  }
  pm().querySelector("#qtProdQty").value = "3"; reset();
  ok("Add line saves the quote with the new line and closes the window", !(await submitIn("#qtProdForm")).isConnected && of("saveEstimate").length === 1);
  ok("…the new line goes last, with its size and quantity", same(of("saveEstimate")[0].items, [{ kind: "product", productId: "cap", size: "OSFA", qty: 12, personalized: false, persName: "" }, { kind: "product", productId: "tee", size: "XL", qty: 3, personalized: false, persName: "" }]));
  ok("…shown with its size under the name, and the server's price", same(cells(lines()[1]).slice(0, 6), ["Club <tee>Size XL", "", "$18.00", "", "$18.00", "$54.00"]) && lines()[1].querySelector(".qt-line-sub").textContent === "Size XL" && !lines()[1].querySelector("tee"));
  ok("…and the total follows", same(totalsRows(), ["Total $270.00"]));
  reset();
  await openProduct();
  ok("the products are asked for once per shop: not again", of("listProducts").length === 0 && pm().querySelector("#qtProd").value === pm().querySelector("#qtProd option").value);
  choose("#qtProd", "cap");
  ok("a flat-priced product has no Size", pm().querySelector("#qtProdSizeWrap").hidden && pm().querySelector("#qtProdSize").options.length === 0);
  ok("…its personalization is offered, with its price", !pm().querySelector("#qtProdPersWrap").hidden && pm().querySelector("#qtProdPersPrice").textContent === "(+$5.00 each)" && pm().querySelector("#qtProdPersFields").hidden);
  ok("…its quantity prices are listed, counted across the whole quote", pm().querySelector("#qtProdPreview").textContent === "Catalog price $20.00 each. Quantity prices: 12+ pieces, $2.00 off each; 24+ pieces, $3.00 off each — counted across every line of this product on the quote.");
  tick("#qtProdPers", true);
  ok("ticking Personalize shows a placement choice (the product's options) and a text box, and adds the price", !pm().querySelector("#qtProdPersFields").hidden && !pm().querySelector("#qtProdPersOptWrap").hidden &&
    same([...pm().querySelectorAll("#qtProdPersOpt option")].map(o => o.value), ["Left side", "Back"]) && /^Catalog price \$20\.00 each \+ \$5\.00 personalization\./.test(pm().querySelector("#qtProdPreview").textContent));
  choose("#qtProdPersOpt", "Back");
  pm().querySelector("#qtProdQty").value = "12"; reset();
  await submitIn("#qtProdForm");
  ok("with no text typed, the placement picked is what is sent", same(of("saveEstimate")[0].items[2], { kind: "product", productId: "cap", size: "OSFA", qty: 12, personalized: true, persName: "Back" }));
  const capLine = (i) => itemsOf(Q1)[i];
  ok("…now 24 caps in all: both cap lines get the 24-piece price, $3.00 off, as the server worked it out", same(cells(lines()[0]).slice(2, 4), ["$20.00", "−$3.00"]) && same(cells(lines()[2]).slice(2, 4), ["$20.00", "−$3.00"]) &&
    cells(lines()[0])[4] === w.adminMoney_(capLine(0).unitPriceCents / 100) && cells(lines()[2])[4] === w.adminMoney_(capLine(2).unitPriceCents / 100) && cells(lines()[2])[5] === w.adminMoney_(capLine(2).lineTotalCents / 100));
  ok("…the personalized line says so, with the option and its price", lines()[2].querySelector(".qt-line-sub").textContent === "Personalized: Back (+$5.00 each)");
  ok("…and the tees, another product, are not counted with the caps", same(cells(lines()[1]).slice(2, 5), ["$18.00", "", "$18.00"]));
  reset();
  await openProduct(lines()[2].querySelector("[data-qt-edit]"));
  ok("Change on a line opens “Change product line”, filled in from the line, with Save line", pm().querySelector("[data-dialog-title]").textContent === "Change product line" && pm().querySelector("#qtProd").value === "cap" &&
    pm().querySelector("#qtProdQty").value === "12" && pm().querySelector("#qtProdPers").checked && !pm().querySelector("#qtProdPersFields").hidden && pm().querySelector("#qtProdPersOpt").value === "Back" && pm().querySelector("#qtProdPersName").value === "" &&
    pm().querySelector("#qtProdSave").textContent === "Save line");
  pm().querySelector("#qtProdPersName").value = "  #7 Robin  ";
  await submitIn("#qtProdForm");
  ok("…typed personalization text wins over the placement, trimmed, and the line is changed in place", same(of("saveEstimate")[0].items.map(i => i.persName), ["", "", "#7 Robin"]) && of("saveEstimate")[0].items.length === 3 &&
    lines()[2].querySelector(".qt-line-sub").textContent === "Personalized: #7 Robin (+$5.00 each)");
  await openProduct(lines()[2].querySelector("[data-qt-edit]"));
  ok("…opened again, typed text is in the text box", pm().querySelector("#qtProdPersName").value === "#7 Robin");
  choose("#qtProd", "tee");
  ok("picking another product starts its own choices afresh", !pm().querySelector("#qtProdSizeWrap").hidden && pm().querySelector("#qtProdPersWrap").hidden && pm().querySelector("#qtProdPersName").value === "" && pm().querySelector("#qtProdSize").value === "S");
  tick("#qtProdOwn", true);
  ok("ticking “Set the price per piece by hand” shows the price field and drops the catalog figures", !pm().querySelector("#qtProdOwnWrap").hidden && pm().querySelector("#qtProdPreview").textContent === "Price set by hand." &&
    pm().querySelector("#qtProdOwnPrice").closest("label").querySelector("span").textContent === "Price per piece ($)");
  for (const bad of ["", "abc", "1.234", "-2"]) {
    pm().querySelector("#qtProdOwnPrice").value = bad; reset();
    await submitIn("#qtProdForm");
    ok(`a hand price of “${bad}” is refused: “Enter the price per piece (0 or more, like 12.50).”, nothing sent`, pm().querySelector("#qtProdErr").textContent === "Enter the price per piece (0 or more, like 12.50)." && sent.length === 0 && d.activeElement === pm().querySelector("#qtProdOwnPrice"));
  }
  pm().querySelector("#qtProdOwnPrice").value = "9.5"; pm().querySelector("#qtProdQty").value = "4"; reset();
  await submitIn("#qtProdForm");
  ok("a hand price is sent as the line's custom price", same(of("saveEstimate")[0].items[2], { kind: "product", productId: "tee", size: "S", qty: 4, personalized: false, persName: "", customUnitPrice: 9.5 }));
  ok("…the line says “Price set by hand”, with no quantity price, at $9.50", lines()[2].querySelector(".qt-line-sub").textContent === "Size S · Price set by hand" && same(cells(lines()[2]).slice(2, 6), ["$9.50", "", "$9.50", "$38.00"]));
  ok("…and the 12 caps left drop back to the 12-piece price", same(cells(lines()[0]).slice(2, 5), ["$20.00", "−$2.00", "$18.00"]));
  reset(); setQty(0, "13"); await wait(() => of("saveEstimate").length === 1); await pause(30);
  ok("the hand price is sent again with every later save", same(of("saveEstimate")[0].items[2].customUnitPrice, 9.5));
  await openProduct(lines()[2].querySelector("[data-qt-edit]"));
  ok("…and is shown, ticked, when the line is changed", pm().querySelector("#qtProdOwn").checked && !pm().querySelector("#qtProdOwnWrap").hidden && pm().querySelector("#qtProdOwnPrice").value === "9.50" && pm().querySelector("#qtProdSize").value === "S");
  scripted = { action: "saveEstimate", status: 400, body: { status: "error", message: "Line 3: that size isn't sold." } };
  { const m = await submitIn("#qtProdForm");
    ok("a line the server refuses: its sentence in the window, which stays open with Save line on again", m.isConnected && m.querySelector("#qtProdErr").textContent === "Line 3: that size isn't sold." && !m.querySelector("#qtProdSave").disabled); }
  pm().querySelector("#qtProdQty").value = "5"; pm().querySelector("#qtProdQty").dispatchEvent(new w.Event("input", { bubbles: true }));
  pm().querySelector("#qtProdCancel").click();
  { const asked = await answer(true); ok("…Cancel after a change asks first, then closes", asked.message.startsWith("Discard changes?") && await wait(() => !modal())); }
  await openProduct();
  pm().querySelector("#qtProdCancel").click();
  ok("Cancel with nothing changed closes at once", await wait(() => !modal()) && !confirmBox());
  // A role that may not set a price by hand.
  signInWith(withLevels("admin", { "orders.payments": "read" }));
  await openQ(Q1);
  await openProduct(lines()[2].querySelector("[data-qt-edit]"));
  ok("a role that can't set prices has no hand-price box", !pm().querySelector("#qtProdOwn") && !pm().querySelector("#qtProdOwnPrice") && pm().querySelector("#qtProdPreview").textContent === "Catalog price $15.00 each.");
  choose("#qtProdSize", "M"); reset();
  await submitIn("#qtProdForm");
  ok("…changing a hand-priced line's size keeps the price someone else set", of("saveEstimate").length === 1 && of("saveEstimate")[0].items[2].customUnitPrice === 9.5 && of("saveEstimate")[0].items[2].size === "M");
  await openProduct(lines()[2].querySelector("[data-qt-edit]"));
  choose("#qtProd", "cap"); reset();
  await submitIn("#qtProdForm");
  ok("…but a line changed to another product is priced by the catalog", of("saveEstimate").length === 1 && of("saveEstimate")[0].items[2].customUnitPrice === undefined && of("saveEstimate")[0].items[2].productId === "cap");
  asRoles("admin");
  await openQ(Q1);
  reset();
  lines()[2].querySelector("[data-qt-remove]").click();
  await wait(() => of("saveEstimate").length === 1 && lines().length === 2);
  ok("Remove saves the quote without that line, at once, and focus goes to “+ Product”", same(of("saveEstimate")[0].items.map(i => i.productId), ["cap", "tee"]) && lines().length === 2 && d.activeElement === q("#qtAddProduct"));

  await openProduct();
  choose("#qtProd", "beanie");
  ok("a product with personalization but no placements: only the text box", !pm().querySelector("#qtProdPersWrap").hidden && pm().querySelector("#qtProdPersOptWrap").hidden && pm().querySelector("#qtProdPersPrice").textContent === "(+$3.00 each)" &&
    pm().querySelector("#qtProdPersOpt").options.length === 0 && pm().querySelector("#qtProdPreview").textContent === "Catalog price $10.00 each.");
  tick("#qtProdPers", true); reset();
  await submitIn("#qtProdForm");
  ok("…personalized with nothing typed sends no text", same(of("saveEstimate")[0].items[2], { kind: "product", productId: "beanie", size: "OSFA", qty: 1, personalized: true, persName: "" }) &&
    lines()[2].querySelector(".qt-line-sub").textContent === "Personalized (+$3.00 each)" && cells(lines()[2])[0].startsWith("Beanie"));
  reset(); lines()[2].querySelector("[data-qt-remove]").click(); await wait(() => lines().length === 2);

  console.log("\n=== + Custom line and + Fee ===");
  const openOther = async (btn) => { const n = qa(".admin-modal").length; btn.click(); return wait(() => qa(".admin-modal").length === n + 1 && !!modal().querySelector("#qtOtherForm")); };
  const om = () => modal();
  reset();
  ok("“+ Custom line” opens “Add a custom line”, focus on the description", await openOther(q("#qtAddCustom")) && om().querySelector("[data-dialog-title]").textContent === "Add a custom line" && d.activeElement === om().querySelector("#qtOtherName"));
  ok("…labelled Description, Quantity, Price per piece ($); taxed unless unticked; no kind of fee", same([...om().querySelectorAll("label.cust-field > span")].map(s => s.textContent), ["Description", "Quantity", "Price per piece ($)"]) &&
    om().querySelector("#qtOtherTax").checked && om().querySelector("#qtOtherTax").closest("label").textContent.trim() === "Subject to sales tax" && !om().querySelector("#qtOtherKind") && om().querySelector("#qtOtherQty").value === "1");
  const fill = (name, qty, price) => { for (const [sel, v] of [["#qtOtherName", name], ["#qtOtherQty", qty], ["#qtOtherPrice", price]]) if (v != null) { const el = om().querySelector(sel); el.value = v; el.dispatchEvent(new w.Event("input", { bubbles: true })); } };
  for (const [label, vals, msg, focus] of [
    ["no description", ["  ", "1", "3"], "Describe the line, as the customer will read it.", "#qtOtherName"],
    ["a quantity of 0", ["Patch", "0", "3"], "Enter a quantity from 1 to 5,000.", "#qtOtherQty"],
    ["a quantity over 5000", ["Patch", "5001", "3"], "Enter a quantity from 1 to 5,000.", "#qtOtherQty"],
    ["no price", ["Patch", "2", ""], "Enter the price per piece (0 or more, like 12.50).", "#qtOtherPrice"],
    ["a price with three decimals", ["Patch", "2", "1.005"], "Enter the price per piece (0 or more, like 12.50).", "#qtOtherPrice"]]) {
    fill(...vals); reset();
    await submitIn("#qtOtherForm");
    ok(`a custom line with ${label} is refused: “${msg}”`, om().querySelector("#qtOtherErr").textContent === msg && d.activeElement === om().querySelector(focus) && sent.length === 0);
  }
  fill("  Extra <patch>  ", "10", "3.5"); om().querySelector("#qtOtherTax").checked = false; reset();
  ok("Add line saves the custom line and closes", !(await submitIn("#qtOtherForm")).isConnected);
  ok("…sent with its description trimmed, quantity, price and not taxed", same(of("saveEstimate")[0].items[2], { kind: "custom", name: "Extra <patch>", qty: 10, unitPrice: 3.5, taxable: false }));
  ok("…shown as text, marked “Custom line · Not taxed”, with no list price", same(cells(lines()[2]).slice(0, 6), ["Extra <patch>Custom line · Not taxed", "", "", "", "$3.50", "$35.00"]) && !lines()[2].querySelector("patch") && lines()[2].querySelector("input.qt-qty").value === "10");
  await openOther(lines()[2].querySelector("[data-qt-edit]"));
  ok("Change on a custom line opens “Change custom line”, filled in, untaxed", om().querySelector("[data-dialog-title]").textContent === "Change custom line" && om().querySelector("#qtOtherName").value === "Extra <patch>" &&
    om().querySelector("#qtOtherQty").value === "10" && om().querySelector("#qtOtherPrice").value === "3.50" && !om().querySelector("#qtOtherTax").checked && om().querySelector("#qtOtherSave").textContent === "Save line");
  fill(null, null, "0"); om().querySelector("#qtOtherTax").checked = true; reset();
  await submitIn("#qtOtherForm");
  ok("…a custom line may cost nothing, and be taxed again", same(of("saveEstimate")[0].items[2], { kind: "custom", name: "Extra <patch>", qty: 10, unitPrice: 0, taxable: true }) && lines()[2].querySelector(".qt-line-sub").textContent === "Custom line" && cells(lines()[2])[5] === "$0.00");
  reset();
  ok("“+ Fee” opens “Add a fee”, focus on the kind of fee", await openOther(q("#qtAddFee")) && om().querySelector("[data-dialog-title]").textContent === "Add a fee" && d.activeElement === om().querySelector("#qtOtherKind"));
  ok("…the kinds: Setup, Digitizing, Art, Other fee; then an optional description and an amount, no quantity", same([...om().querySelectorAll("#qtOtherKind option")].map(o => o.value + "=" + o.textContent), ["setup=Setup fee", "digitizing=Digitizing fee", "art=Art fee", "other=Other fee"]) &&
    same([...om().querySelectorAll("label.cust-field > span")].map(s => s.textContent), ["Kind of fee", "Description (optional)", "Amount ($)"]) && !om().querySelector("#qtOtherQty"));
  for (const bad of ["", "0", "0.00", "abc"]) {
    fill(null, null, bad); reset();
    await submitIn("#qtOtherForm");
    ok(`a fee of “${bad}” is refused: “Enter the fee's amount (more than 0, like 25.00).”`, om().querySelector("#qtOtherErr").textContent === "Enter the fee's amount (more than 0, like 25.00)." && d.activeElement === om().querySelector("#qtOtherPrice") && sent.length === 0);
  }
  om().querySelector("#qtOtherKind").value = "digitizing"; fill("", null, "25"); reset();
  await submitIn("#qtOtherForm");
  ok("a fee with no description is named for its kind, and taxed", same(of("saveEstimate")[0].items[3], { kind: "fee", feeKind: "digitizing", name: "Digitizing fee", amount: 25, taxable: true }));
  ok("…shown as one, with no quantity box and no sub-line", same(cells(lines()[3]).slice(0, 6), ["Digitizing fee", "1", "", "", "$25.00", "$25.00"]) && !lines()[3].querySelector("input") && !lines()[3].querySelector(".qt-line-sub"));
  await openOther(lines()[3].querySelector("[data-qt-edit]"));
  ok("Change on a fee opens “Change fee”, its kind picked and amount filled in", om().querySelector("[data-dialog-title]").textContent === "Change fee" && om().querySelector("#qtOtherKind").value === "digitizing" && om().querySelector("#qtOtherPrice").value === "25.00" && om().querySelector("#qtOtherTax").checked);
  om().querySelector("#qtOtherKind").value = "setup"; fill("Left <logo>", null, "40"); om().querySelector("#qtOtherTax").checked = false; reset();
  await submitIn("#qtOtherForm");
  ok("…a fee with a description shows the kind, then the description; untaxed is marked", same(of("saveEstimate")[0].items[3], { kind: "fee", feeKind: "setup", name: "Left <logo>", amount: 40, taxable: false }) &&
    lines()[3].children[0].firstChild.textContent === "Setup fee — Left <logo>" && lines()[3].querySelector(".qt-line-sub").textContent === "Not taxed" && !lines()[3].querySelector("logo"));
  scripted = { action: "saveEstimate", status: 409, body: { status: "error", message: "The customer accepted this quote: it can't change now." } };
  await openOther(q("#qtAddFee")); fill(null, null, "5");
  { const m = await submitIn("#qtOtherForm");
    ok("a fee the server refuses: its sentence in the window, Add line on again", m.isConnected && m.querySelector("#qtOtherErr").textContent === "The customer accepted this quote: it can't change now." && !m.querySelector("#qtOtherSave").disabled); }
  om().querySelector("#qtOtherPrice").dispatchEvent(new w.Event("input", { bubbles: true }));
  om().querySelector("#qtOtherCancel").click(); await answer(true); await wait(() => !modal());
  ok("…and, cancelled, the quote is as it was", lines().length === 4);

  console.log("\n=== Limits, and one change at a time ===");
  const QBIG = (await mk("acme", SAM, { title: "Big order" })).id;
  await saveItems(QBIG, Array.from({ length: 100 }, (_, i) => ({ kind: "custom", name: "Line " + (i + 1), qty: 1, unitPrice: 1, taxable: true })));
  await openQ(QBIG);
  reset();
  await openOther(q("#qtAddCustom")); fill("One more", "1", "1");
  await submitIn("#qtOtherForm");
  ok("a quote with 100 lines takes no more: “A quote can have at most 100 lines.”, nothing sent", om().querySelector("#qtOtherErr").textContent === "A quote can have at most 100 lines." && sent.length === 0 && lines().length === 100);
  om().querySelector("#qtOtherCancel").click(); await answer(true); await wait(() => !modal());
  await openOther(lines()[0].querySelector("[data-qt-edit]")); fill("Line one", null, null); reset();
  await submitIn("#qtOtherForm");
  ok("…but its lines can still be changed", of("saveEstimate").length === 1 && of("saveEstimate")[0].items.length === 100 && cells(lines()[0])[0].startsWith("Line one"));
  await openQ(Q1);
  { let release; hold = { action: "saveEstimate", gate: new Promise(r => { release = r; }) };
    reset(); setQty(0, "14"); await wait(() => of("saveEstimate").length === 1);
    lines()[2].querySelector("[data-qt-remove]").click(); await pause(30);
    ok("a second change while one is being saved: “Still saving — try again in a moment.”, nothing more sent", q("#qtErr").textContent === "Still saving — try again in a moment." && of("saveEstimate").length === 1);
    release(); await wait(() => cells(lines()[0])[5] !== "" && qtyBox(0).value === "14" && q("#qtSaved").textContent === "Saved.");
    ok("…the first one is saved, and the line it would have removed is still there", lines().length === 4 && itemsOf(Q1)[0].qty === 14 && itemsOf(Q1).length === 4);
    ok("…and “Still saving” is gone once it has (it can be tried again now)", q("#qtErr").textContent === ""); }
  { let release; const gate = new Promise(r => { release = r; });
    scripted = { action: "saveEstimate", status: 400, body: async () => { await gate; return { status: "error", message: "Line 1: couldn't price it. Try again." }; } };
    reset(); setQty(0, "16"); await wait(() => of("saveEstimate").length === 1);
    lines()[2].querySelector("[data-qt-remove]").click(); await pause(30);
    release(); await wait(() => q("#qtErr").textContent !== "Still saving — try again in a moment.");
    ok("…when the first save is refused, its own reason replaces “Still saving”", q("#qtErr").textContent === "Line 1: couldn't price it. Try again." && itemsOf(Q1)[0].qty === 14);
    scripted = null; }
  { let release; hold = { action: "saveEstimate", gate: new Promise(r => { release = r; }) };
    reset(); setQty(0, "15"); await wait(() => of("saveEstimate").length === 1);
    await go("quotes");
    release(); await pause(120);
    ok("a save that finishes after the admin left draws nothing over the list", !!q("#qtQ") && !q("#qtForm") && itemsOf(Q1)[0].qty === 15); }

  console.log("\n=== The totals ===");
  const real1 = (await call({ action: "getEstimate", id: Q1 })).body;
  const copy = (o) => JSON.parse(JSON.stringify(o));
  { const s = copy(real1); s.totals = { subtotal: 300, tax: 24.75, total: 324.75, taxMode: "exclusive", taxRateBps: 825 };
    scripted = { action: "getEstimate", body: s }; await openQ(Q1);
    ok("tax added on top: Subtotal, Sales tax, then Total", same(totalsRows(), ["Subtotal $300.00", "Sales tax $24.75", "Total $324.75"]) && q("#qtTotals tr.qt-sum-total").textContent.includes("$324.75")); }
  { const s = copy(real1); s.totals = { subtotal: 300, tax: 22.87, total: 300, taxMode: "inclusive", taxRateBps: 825 };
    scripted = { action: "getEstimate", body: s }; await openQ(Q1);
    ok("tax included in the prices: Total, then “Includes sales tax”", same(totalsRows(), ["Total $300.00", "Includes sales tax $22.87"])); }
  { const s = copy(real1); delete s.totals; s.estimate.status = "mystery";
    scripted = { action: "getEstimate", body: s }; await openQ(Q1);
    ok("no totals from the server: a dash for the total", same(totalsRows(), ["Total —"]));
    ok("a status the page doesn't know is shown as Draft", q("h2.cust-name .qt-st").textContent === "Draft" && q("h2.cust-name .qt-st").classList.contains("qt-st-draft")); }
  { const s = copy(real1); s.items = []; delete s.customer;
    scripted = { action: "getEstimate", body: s }; await openQ(Q1);
    ok("no lines: “No lines yet. Add a product, a custom line or a fee.”, and no totals", q("#qtLines .cust-note").textContent === "No lines yet. Add a product, a custom line or a fee." && q("#qtTotals").innerHTML === "");
    ok("an answer without the customer still names one: “Customer <id>”, linked to their page", q(".cust-sub a.cust-link").textContent === "Customer " + PAT && q(".cust-sub a.cust-link").getAttribute("href") === "#customers/" + PAT); }

  console.log("\n=== Lines as the server sends them ===");
  { const base = (await call({ action: "getEstimate", id: QNEW })).body;
    const s = copy(base);
    s.estimate.number = "";
    s.items = [
      { kind: "product", productId: "cap", size: "", qty: "3", configJson: '{"thread":"navy"}', personalized: 1, persName: "", personalizationFee: 0, unitPrice: 20, listUnitPrice: null, lineTotal: null, customPrice: 0, taxable: 1 },
      { kind: "product", productId: "cap", size: "OSFA", qty: 1, configJson: "{not json", personalized: 0, unitPrice: 20, listUnitPrice: 20, lineTotal: 20, customPrice: false, taxable: true },
      { kind: "product", productId: "cap", size: "OSFA", qty: 1, config: { thread: "red" }, configJson: '{"thread":"navy"}', unitPrice: 20, listUnitPrice: 20, lineTotal: 20 },
      { kind: "custom", name: "", qty: 0, unitPrice: "x", taxable: 0, lineTotal: 0 },
      { kind: "fee", feeKind: "", name: "", unitPrice: 12, taxable: "1", lineTotal: 12 }];
    scripted = { action: "getEstimate", body: s };
    await openQ(QNEW);
    ok("a quote with no number is called “Quote <id>”", q("h1.org-name").textContent === "Quote " + QNEW && q("h2.cust-name").textContent.startsWith("Quote " + QNEW + " · Spring <hats>"));
    ok("a personalized line with no text says just “Personalized”, with no price when there is none", lines()[0].querySelector(".qt-line-sub").textContent === "Personalized");
    ok("…no list price from the server: the unit price stands in, and no quantity price", same(cells(lines()[0]).slice(2, 6), ["$20.00", "", "$20.00", "—"]));
    ok("a fee of no known kind is an “Other fee”", cells(lines()[4])[0] === "Other fee" && cells(lines()[4])[1] === "1");
    ok("a custom line with no name is still listed, untaxed", lines()[3].querySelector(".qt-line-sub").textContent === "Custom line · Not taxed");
    scripted = { action: "saveEstimate", body: { status: "ok" } };
    reset(); q("#qtSave").click(); await wait(() => toasts.length === 1);
    ok("each line goes back as saveEstimate takes it: the size OSFA when none, the stored design choices, quantities and amounts as numbers", same(of("saveEstimate")[0].items, [
      { kind: "product", productId: "cap", size: "OSFA", qty: 3, personalized: true, persName: "", config: { thread: "navy" } },
      { kind: "product", productId: "cap", size: "OSFA", qty: 1, personalized: false, persName: "" },
      { kind: "product", productId: "cap", size: "OSFA", qty: 1, personalized: false, persName: "", config: { thread: "red" } },
      { kind: "custom", name: "", qty: 1, unitPrice: 0, taxable: false },
      { kind: "fee", feeKind: "other", name: "", amount: 12, taxable: true }]));
    ok("an answer without the quote in it leaves the lines as they were, and still says saved", lines().length === 5 && q("#qtSaved").textContent === "Saved." && lastToast().m === "Quote saved.");
    scripted = { action: "getEstimate", body: { status: "ok" } };
    const before = page();
    w.adminRoute(); await pause(150);
    ok("an answer with no quote in it leaves “Loading…” rather than drawing half a page", /Loading…/.test(page().textContent) && page() !== before && !q("#qtForm")); }
  await openQ(QCAN);
  reset(); q("#qtForm").dispatchEvent(new w.Event("submit", { cancelable: true })); await pause(40);
  ok("a read-only quote's form sends nothing even if it is submitted", sent.length === 0 && toasts.length === 0);

  console.log("\n=== Save ===");
  await openQ(Q1);
  q("#qtTitle").value = "  Team shirts, spring  "; q("#qtMessage").value = "  Thanks for asking.\nSee you soon. "; q("#qtInternal").value = " Call before Friday. "; q("#qtExpires").value = "2999-07-31";
  q("#qtTitle").dispatchEvent(new w.Event("input", { bubbles: true }));
  ok("typing above the lines clears “Saved.”", q("#qtSaved").textContent === "");
  reset();
  q("#qtSave").click();
  await wait(() => toasts.length === 1);
  ok("Save sends the fields, trimmed, with every line", same(Object.keys(of("saveEstimate")[0]).sort(), ["action", "expiresOn", "id", "internalNote", "items", "key", "message", "title"]) && of("saveEstimate")[0].title === "Team shirts, spring" &&
    of("saveEstimate")[0].message === "Thanks for asking.\nSee you soon." && of("saveEstimate")[0].internalNote === "Call before Friday." && of("saveEstimate")[0].expiresOn === "2999-07-31" && of("saveEstimate")[0].items.length === 4);
  ok("…says “Quote saved.”, and it is stored", lastToast().m === "Quote saved." && !lastToast().err && q("#qtSaved").textContent === "Saved." && est(Q1).title === "Team shirts, spring" && est(Q1).internalNote === "Call before Friday." && est(Q1).expiresOn === "2999-07-31");
  q("#qtExpires").value = ""; reset(); q("#qtSave").click(); await wait(() => toasts.length === 1);
  ok("a blank last day is sent as none: the quote has no end", of("saveEstimate")[0].expiresOn === null && est(Q1).expiresOn == null);
  q("#qtExpires").value = w.localToday_(-1); reset(); q("#qtSave").click(); await pause(40);
  ok("a last day already gone is refused: “The last day to accept can't be in the past.”, nothing sent", q("#qtErr").textContent === "The last day to accept can't be in the past." && sent.length === 0 && !q("#qtSave").disabled);
  q("#qtExpires").value = w.localToday_(); reset(); q("#qtSave").click(); await wait(() => toasts.length === 1);
  ok("…today is fine", of("saveEstimate").length === 1 && est(Q1).expiresOn === w.localToday_());
  await openQ(QOLD);
  ok("a quote whose stored last day has gone is tagged Expired", /Expired/.test(q("h2.cust-name").textContent) && !!q("h2.cust-name .cust-tag-warn"));
  q("#qtTitle").value = "Last year, still"; reset(); q("#qtSave").click(); await wait(() => toasts.length === 1);
  ok("…and can still be saved while that day is left as it is", of("saveEstimate").length === 1 && of("saveEstimate")[0].expiresOn === "2000-01-01" && lastToast().m === "Quote saved.");
  scripted = { action: "saveEstimate", status: 400, body: { status: "error", message: "The quote's expiry date isn't a valid date." } };
  reset(); q("#qtSave").click(); await wait(() => q("#qtErr").textContent !== "");
  ok("a save the server refuses shows its sentence under the form, Save on again, nothing said as saved", q("#qtErr").textContent === "The quote's expiry date isn't a valid date." && q("#qtErr").getAttribute("role") === "alert" && !q("#qtSave").disabled && toasts.length === 0);
  { let release; hold = { action: "saveEstimate", gate: new Promise(r => { release = r; }) };
    reset(); q("#qtSave").click(); await wait(() => of("saveEstimate").length === 1);
    ok("while saving, Save is off and the last refusal is cleared", q("#qtSave").disabled && q("#qtErr").textContent === "");
    release(); await wait(() => toasts.length === 1); ok("…and on again after", !q("#qtSave").disabled); }

  console.log("\n=== Send… ===");
  await openQ(QSAM);
  reset(); q("#qtSend").click(); await pause(30);
  ok("Send on a quote with no lines: “Add at least one line before sending the quote.”, and no window", q("#qtErr").textContent === "Add at least one line before sending the quote." && !modal() && sent.length === 0);
  await saveItems(QSAM, [{ kind: "fee", feeKind: "art", name: "Art fee", amount: 30, taxable: true }]);
  await openQ(QSAM);
  q("#qtSend").focus(); q("#qtSend").click(); await wait(() => modal());
  const sm = () => modal();
  ok("Send… opens “Send <number>”, saying what sending does, focus in Email", sm().querySelector("[data-dialog-title]").textContent === "Send " + est(QSAM).number &&
    sm().querySelector(".cust-note").textContent === "The customer gets a link to see the quote, and to accept it or ask for changes. From now on its prices are fixed." && d.activeElement === sm().querySelector("#qtSendEmail"));
  ok("…a customer with no email: the Email box starts empty; the note box holds the quote's note", sm().querySelector("#qtSendEmail").value === "" && sm().querySelector("#qtSendMsg").value === "" &&
    same([...sm().querySelectorAll("label.cust-field > span")].map(s => s.textContent).slice(0, 2), ["Email", "Note to the customer (on the quote and in the email)"]));
  ok("…its buttons: Cancel and Send quote; the link isn't shown", same([...sm().querySelectorAll(".cust-dialog-actions button")].map(b => b.textContent), ["Cancel", "Send quote"]) && sm().querySelector("#qtSendLinkWrap").hidden);
  for (const bad of ["", "sam at example", "sam@example"]) {
    sm().querySelector("#qtSendEmail").value = bad; reset();
    sm().querySelector("#qtSendForm").dispatchEvent(new w.Event("submit", { cancelable: true })); await pause(20);
    ok(`an email of “${bad}”: “Enter the email address to send the quote to.”, nothing sent`, sm().querySelector("#qtSendErr").textContent === "Enter the email address to send the quote to." && sent.length === 0 && d.activeElement === sm().querySelector("#qtSendEmail"));
  }
  sm().querySelector("#qtSendEmail").value = " sam@example.com "; sm().querySelector("#qtSendMsg").value = "  Here is your <quote>.  ";
  globalThis.__mailOk318 = false; reset();
  sm().querySelector("#qtSendForm").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await wait(() => !sm().querySelector("#qtSendLinkWrap").hidden);
  ok("Send quote sends the email address and the note, trimmed", same(of("sendEstimate")[0], { action: "sendEstimate", id: QSAM, email: "sam@example.com", message: "Here is your <quote>.", key: "cookie" }));
  ok("an email that couldn't go: the window stays, says the quote is marked sent, and shows its link to send another way", !!sm() && sm().querySelector("#qtSendLinkNote").textContent === "The quote is marked sent, but the email couldn't be sent. Copy this link and send it to the customer yourself." &&
    /^https:\/\/acme\.[^/]+\/\?estimate=[0-9a-f]{32}$/.test(sm().querySelector("#qtSendLink").value) && sm().querySelector("#qtSendLink").value.endsWith(est(QSAM).token) && sm().querySelector("#qtSendLink").readOnly);
  ok("…the link has focus, the button now reads Done, and Cancel is gone", d.activeElement === sm().querySelector("#qtSendLink") && sm().querySelector("#qtSendGo").textContent === "Done" && sm().querySelector("#qtSendCancel").hidden && est(QSAM).status === "sent");
  ok("…the note typed there became the quote's note", est(QSAM).message === "Here is your <quote>.");
  reset();
  await redrawn(() => sm().querySelector("#qtSendForm").dispatchEvent(new w.Event("submit", { cancelable: true })));
  ok("Done closes the window and draws the quote again, sending nothing more", !modal() && of("sendEstimate").length === 0 && of("getEstimate").length === 1);
  globalThis.__mailOk318 = true;
  ok("a sent quote is tagged “Sent”, says when and to whom", q("h2.cust-name .qt-st-sent").textContent === "Sent" && qa("#qtPage .cust-sub")[1].textContent === "Sent " + w.adminDate_(est(QSAM).sentAt) + " to sam@example.com");
  ok("…says it is fixed as sent, all but its internal note", qa("#qtPage .cust-note").some(n => n.textContent === "This quote has been sent, so it is fixed as the customer has it: its lines, prices, title, note to the customer and expiry. Only the internal note can change. The rest can change again if the customer asks for changes."));
  ok("…its lines can't be changed: no add buttons, the quantity as text, no Change or Remove", !q(".qt-add") && !q("#qtLines input") && !q("[data-qt-edit]") && !q("[data-qt-remove]") && qa("#qtLines thead th").length === 6 && cells(lines()[0])[1] === "1");
  ok("…no word about catalog prices any more", !q("#qtTotals .cust-note"));
  ok("…only the internal note stays open (title, note to the customer and expiry can't change), with Save; the button reads “Send again…”",
    q("#qtTitle").disabled && q("#qtMessage").disabled && q("#qtExpires").disabled && !q("#qtInternal").disabled && q("#qtSave").textContent === "Save" && q("#qtSend").textContent === "Send again…");
  const titleWas = est(QSAM).title;
  q("#qtTitle").value = "Changed while disabled"; q("#qtInternal").value = "Waiting on the art."; q("#qtInternal").dispatchEvent(new w.Event("input", { bubbles: true }));
  reset(); q("#qtSave").click(); await wait(() => toasts.length === 1);
  ok("Save on a sent quote sends the internal note alone (no lines, no title, note or expiry), and it is stored",
    of("saveEstimate").length === 1 && same(Object.keys(of("saveEstimate")[0]).filter(k => k !== "key").sort(), ["action", "id", "internalNote"]) && lastToast().m === "Quote saved." &&
    est(QSAM).internalNote === "Waiting on the art." && est(QSAM).title === titleWas && q("#qtErr").textContent === "");
  q("#qtSend").click(); await wait(() => modal());
  ok("Send again… opens “Send again: <number>”, to the address it went to, saying it is the same link", sm().querySelector("[data-dialog-title]").textContent === "Send again: " + est(QSAM).number && sm().querySelector("#qtSendEmail").value === "sam@example.com" &&
    sm().querySelector(".cust-note").textContent === "The customer gets the same link again." && sm().querySelector("#qtSendGo").textContent === "Send again" && sm().querySelector("#qtSendMsg").value === "Here is your <quote>.");
  scripted = { action: "sendEstimate", status: 409, body: { status: "error", message: "This quote was cancelled." } };
  reset(); sm().querySelector("#qtSendForm").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await wait(() => sm().querySelector("#qtSendErr").textContent !== "");
  ok("a send the server refuses: its sentence in the window, the button on again", sm().querySelector("#qtSendErr").textContent === "This quote was cancelled." && !sm().querySelector("#qtSendGo").disabled && sm().querySelector("#qtSendLinkWrap").hidden);
  const tokenWas = est(QSAM).token;
  reset();
  await redrawn(() => sm().querySelector("#qtSendForm").dispatchEvent(new w.Event("submit", { cancelable: true })));
  ok("an email that went: the window closes, “Quote <number> sent to <email>.”, and the quote is drawn again", !modal() && lastToast().m === "Quote " + est(QSAM).number + " sent to sam@example.com." && !lastToast().err);
  ok("…with the same link, now sent twice", est(QSAM).token === tokenWas && globalThis.__mail318.some(m => m.kind === "estimate" && m.link.endsWith(tokenWas)) && /\(2 times\)$/.test(qa("#qtPage .cust-sub")[1].textContent));
  d1._raw.run("UPDATE estimates SET viewedAt = '2026-04-02T12:00:00.000Z' WHERE id = ?", [QSAM]);
  await openQ(QSAM);
  ok("once the customer has opened it, that is said too", qa("#qtPage .cust-sub")[1].textContent.endsWith(" · Opened by the customer " + w.adminDate_("2026-04-02T12:00:00.000Z")));
  reset(); q("#qtSend").click(); await wait(() => modal());
  sm().querySelector("#qtSendEmail").dispatchEvent(new w.Event("input", { bubbles: true }));
  sm().querySelector("#qtSendCancel").click(); await answer(true);
  ok("Cancel in the Send window (after typing) asks, then closes, sending nothing", await wait(() => !modal()) && of("sendEstimate").length === 0);
  // What is typed above the lines goes with Send and Convert.
  await openQ(Q1);
  q("#qtMessage").value = "Typed, not saved."; q("#qtMessage").dispatchEvent(new w.Event("input", { bubbles: true }));
  reset(); q("#qtSend").click(); await wait(() => modal());
  ok("Send with unsaved typing saves the quote first, so the customer gets what is on the screen", same(sent.map(b => b.action), ["saveEstimate"]) && est(Q1).message === "Typed, not saved." && sm().querySelector("#qtSendEmail").value === "pat@example.com" && sm().querySelector("#qtSendMsg").value === "Typed, not saved.");
  sm().querySelector("#qtSendCancel").click(); await wait(() => !modal());
  reset(); q("#qtSend").click(); await wait(() => modal());
  ok("…with nothing new typed, Send saves nothing", sent.length === 0);
  sm().querySelector("#qtSendCancel").click(); await wait(() => !modal());
  q("#qtExpires").value = "1999-01-01"; q("#qtExpires").dispatchEvent(new w.Event("input", { bubbles: true }));
  reset(); q("#qtSend").click(); await pause(40);
  ok("…and when that typing can't be saved, the problem is shown and no window opens", q("#qtErr").textContent === "The last day to accept can't be in the past." && !modal() && sent.length === 0);
  q("#qtConvert").click(); await pause(40);
  ok("…the same for Convert to order", q("#qtErr").textContent === "The last day to accept can't be in the past." && !modal() && sent.length === 0);
  q("#qtExpires").value = "2999-12-31"; q("#qtExpires").dispatchEvent(new w.Event("input", { bubbles: true }));
  reset(); q("#qtConvert").click(); await wait(() => modal());
  ok("Convert with unsaved typing saves first, then asks", same(sent.map(b => b.action), ["saveEstimate"]) && est(Q1).expiresOn === "2999-12-31" && !!modal().querySelector("#qtConvForm"));
  modal().querySelector("#qtConvCancel").click(); await wait(() => !modal());

  console.log("\n=== The customer asked for changes: Revise ===");
  await saveItems(QREC, [{ kind: "custom", name: "League visor", qty: 20, unitPrice: 11, taxable: true }]);
  await call({ action: "sendEstimate", id: QREC, email: "pat@example.com" });
  d1._raw.run("UPDATE estimates SET status = 'changes', customerNote = ?, respondedAt = '2026-04-03T12:00:00.000Z' WHERE id = ?", ["Can the logo be <i>bigger</i>?\nThanks", QREC]);
  await openQ(QREC);
  ok("a quote the customer wants changed is tagged “Changes asked”", q("h2.cust-name .qt-st-changes").textContent === "Changes asked");
  ok("…says so, with the day and the customer's own words, as text", q(".qt-callout-changes b").textContent === "The customer asked for changes on " + w.adminDate_("2026-04-03T12:00:00.000Z") + "." &&
    q(".qt-callout-changes .qt-quote-text").textContent === "Can the logo be <i>bigger</i>?\nThanks" && !q(".qt-callout-changes i") && q(".qt-callout-changes").getAttribute("role") === "note");
  ok("…and what to do: change it, press Revise, send it again", /Change the quote, press Revise, then send it again\./.test(q(".qt-callout-changes").textContent));
  ok("…its lines can change again, Save reads “Revise”, and Send reads “Send…”", !!q(".qt-add") && !!q("#qtLines input.qt-qty") && q("#qtSave").textContent === "Revise" && q("#qtSend").textContent === "Send…");
  ok("…the shop is named, as text", q(".cust-sub").textContent.includes(" · Rec <i>League</i> · ") && !q(".cust-sub i"));
  reset(); setQty(0, "30"); await wait(() => of("saveEstimate").length === 1 && q("#qtSaved").textContent === "Saved.");
  ok("a changed quantity is saved, as on a draft", itemsOf(QREC)[0].qty === 30 && cells(lines()[0])[5] === "$330.00");
  reset(); q("#qtSave").click(); await wait(() => toasts.length === 1);
  ok("Revise saves it and says “Quote revised. Send it again when it's ready.”", of("saveEstimate").length === 1 && lastToast().m === "Quote revised. Send it again when it's ready.");
  scripted = { action: "listProducts", status: 500, body: { status: "error", message: "Try again in a moment." } };
  reset(); q("#qtAddProduct").click(); await wait(() => toasts.length === 1);
  ok("+ Product when the shop's products can't be loaded: “Couldn't load the shop's products: …”, and no window", lastToast().m === "Couldn't load the shop's products: Try again in a moment." && lastToast().err && !modal());
  reset(); q("#qtAddProduct").click(); await wait(() => toasts.length === 1);
  ok("+ Product in a shop whose every product has choices to make: “This shop has no products to quote. Add a custom line instead.”", lastToast().m === "This shop has no products to quote. Add a custom line instead." && lastToast().err && !modal() && of("listProducts").length === 1);
  d1._raw.run("UPDATE estimates SET customerNote = '', respondedAt = NULL WHERE id = ?", [QREC]);
  await openQ(QREC);
  ok("asked for changes with no words and no day: just “The customer asked for changes.”", q(".qt-callout-changes b").textContent === "The customer asked for changes." && !q(".qt-quote-text"));

  console.log("\n=== Cancel quote… ===");
  reset(); q("#qtCancel").click();
  { const asked = await answer(false);
    ok("Cancel quote asks first, naming the quote and saying it can't be undone", asked.message === `Cancel quote ${est(QREC).number}?\n\nThe customer can no longer accept it, and it can't be sent again. This can't be undone.`);
    await pause(30);
    ok("…answering no sends nothing", sent.length === 0 && est(QREC).status === "changes"); }
  asRoles("admin", "staff");
  reset(); q("#qtCancel").click(); await answer(true); await wait(() => toasts.length === 1);
  ok("a cancel the server refuses is shown as an error, and nothing changes", lastToast().m === "Your role can't do that here." && lastToast().err && est(QREC).status === "changes");
  asRoles("admin");
  reset();
  await redrawn(async () => { q("#qtCancel").click(); await answer(true); });
  ok("answering yes cancels it: “Quote <number> cancelled.”, and the quote is drawn again", same(of("cancelEstimate"), [{ action: "cancelEstimate", id: QREC, key: "cookie" }]) && lastToast().m === "Quote " + est(QREC).number + " cancelled." && est(QREC).status === "cancelled");
  ok("a cancelled quote: tagged Cancelled, with the day, and that the customer's link no longer accepts it", q("h2.cust-name .qt-st-cancelled").textContent === "Cancelled" &&
    qa("#qtPage .cust-note").some(n => n.textContent === "Cancelled on " + w.adminDate_(est(QREC).cancelledAt) + ". The customer's link no longer accepts it."));
  ok("…no Send, Convert or Cancel; every field read-only, no Save, no way to change a line", qa(".cust-actions button").length === 0 && !q("#qtSave") && qa("#qtForm input, #qtForm textarea").every(f => f.disabled) && !q(".qt-add") && !q("[data-qt-edit]"));
  ok("…its lines are still listed", lines().length === 1 && cells(lines()[0])[1] === "30");
  { const s = copy((await call({ action: "getEstimate", id: QREC })).body); s.estimate.cancelledAt = null; scripted = { action: "getEstimate", body: s }; await openQ(QREC);
    ok("…“Cancelled.” alone when the day isn't known", qa("#qtPage .cust-note").some(n => n.textContent === "Cancelled. The customer's link no longer accepts it.")); }

  console.log("\n=== Convert to order… ===");
  await openQ(QBIG);
  q("#qtConvert").focus(); q("#qtConvert").click(); await wait(() => modal());
  const cm = () => modal();
  ok("Convert to order… opens “Convert <number> to an order”, saying what it does, with the quote's total", cm().querySelector("[data-dialog-title]").textContent === "Convert " + est(QBIG).number + " to an order" &&
    cm().querySelector(".cust-merge-text").textContent === "An order is recorded for Sam Noemail in Example Club, at the quote's prices ($100.00), not yet paid. The quote is then marked converted.");
  ok("…a customer with no email: the invoice box is off and says why", cm().querySelector("#qtConvInvoice").disabled && !cm().querySelector("#qtConvInvoice").checked && cm().querySelector("#qtConvInvoice").closest("label").textContent.trim() === "Email the customer the invoice (no email address on the customer)");
  ok("…focus starts on Cancel, so Enter can't make the order by accident", d.activeElement === cm().querySelector("#qtConvCancel") && same([...cm().querySelectorAll(".cust-dialog-actions button")].map(b => b.textContent), ["Cancel", "Make the order"]));
  reset(); cm().querySelector("#qtConvCancel").click();
  ok("Cancel closes it at once, nothing made", await wait(() => !modal()) && sent.length === 0 && !confirmBox() && est(QBIG).status === "draft");
  await openQ(QSAM);
  q("#qtConvert").click(); await wait(() => modal());
  ok("a quote that was emailed: the invoice box is ticked, to go to that address", cm().querySelector("#qtConvInvoice").checked && !cm().querySelector("#qtConvInvoice").disabled && cm().querySelector("#qtConvInvoice").closest("label").textContent.trim() === "Email the customer the invoice");
  scripted = { action: "convertEstimate", status: 409, body: { status: "error", message: "That month is closed." } };
  reset(); cm().querySelector("#qtConvForm").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await wait(() => cm().querySelector("#qtConvErr").textContent !== "");
  ok("a convert the server refuses: its sentence in the window, Make the order on again", cm().querySelector("#qtConvErr").textContent === "That month is closed." && !cm().querySelector("#qtConvGo").disabled && cm().querySelector("#qtConvErr").getAttribute("role") === "alert");
  reset();
  await redrawn(() => cm().querySelector("#qtConvForm").dispatchEvent(new w.Event("submit", { cancelable: true })));
  const ORDER_SAM = est(QSAM).orderId;
  ok("Make the order sends the quote and “email the invoice”", same(of("convertEstimate"), [{ action: "convertEstimate", id: QSAM, sendInvoice: true, key: "cookie" }]));
  ok("…says “Order <id> made from quote <number>.”, and the quote is drawn again, converted", !modal() && lastToast().m === "Order " + ORDER_SAM + " made from quote " + est(QSAM).number + "." && !!ORDER_SAM && est(QSAM).status === "converted");
  ok("a converted quote: tagged Converted, “Converted to order <id> on <day>.”, the order a link", q("h2.cust-name .qt-st-converted").textContent === "Converted" &&
    q(".qt-callout").textContent === "Converted to order " + ORDER_SAM + " on " + w.adminDate_(est(QSAM).convertedAt) + "." && q("#qtOrderLink").getAttribute("href") === "#orders/acme" && q("#qtOrderLink").textContent === ORDER_SAM);
  ok("…no Send, Convert or Cancel, and nothing to change", qa(".cust-actions button").length === 0 && !q("#qtSave") && qa("#qtForm input, #qtForm textarea").every(f => f.disabled));
  { const realOpen = w.openOrderFromDashboard_, opened = [];
    w.openOrderFromDashboard_ = (...a) => { opened.push(a); };
    const ev = new w.MouseEvent("click", { bubbles: true, cancelable: true }); q("#qtOrderLink").dispatchEvent(ev);
    ok("pressing the order opens it on the Orders page: its shop, its id, the day it was made", ev.defaultPrevented && same(opened, [["acme", ORDER_SAM, est(QSAM).convertedAt]]));
    w.openOrderFromDashboard_ = realOpen; }
  signInWith(withLevels("admin", Object.fromEntries(Object.keys(levelsOf("admin")).filter(k => /^orders\./.test(k)).map(k => [k, "none"]))));
  await openQ(QSAM);
  ok("a role that can't open Orders sees the order's id as plain text", !q("#qtOrderLink") && q(".qt-callout b").textContent === ORDER_SAM);
  asRoles("admin");
  await openQ(Q1);
  q("#qtConvert").click(); await wait(() => modal());
  cm().querySelector("#qtConvInvoice").checked = false; reset();
  await redrawn(() => cm().querySelector("#qtConvForm").dispatchEvent(new w.Event("submit", { cancelable: true })));
  ok("with the box unticked, no invoice is asked for", of("convertEstimate")[0].sendInvoice === false && est(Q1).status === "converted" && !globalThis.__mail318.some(m => m.kind === "invoice"));
  { const s = copy((await call({ action: "getEstimate", id: Q1 })).body); s.estimate.convertedAt = null; s.estimate.status = "accepted"; scripted = { action: "getEstimate", body: s }; await openQ(Q1);
    ok("an order made when the customer accepted reads “Order <id>.”", q(".qt-callout").textContent === "Order " + est(Q1).orderId + "." && !q(".qt-callout-changes") && qa(".cust-actions button").length === 0); }
  d1._raw.run("UPDATE estimates SET status = 'accepted', acceptedAt = '2026-04-04T12:00:00.000Z' WHERE id = ?", [QOLD]);
  d1._raw.run("INSERT INTO estimate_items (estimateId, position, kind, name, qty, unitPriceCents, listUnitCents, lineTotalCents) VALUES (?, 0, 'custom', 'Banner', 1, 5000, 5000, 5000)", [QOLD]);
  await openQ(QOLD);
  ok("a quote accepted whose order wasn't made: tagged Accepted, says so and points to Convert to order", q("h2.cust-name .qt-st-accepted").textContent === "Accepted" && !/Expired/.test(q("h2.cust-name").textContent) &&
    q(".qt-callout-changes").textContent === "The customer accepted this quote on " + w.adminDate_("2026-04-04T12:00:00.000Z") + ", but its order wasn't made. Use Convert to order.");
  ok("…offers Convert and Cancel but not Send; its fields are read-only", same(qa(".cust-actions button").map(b => b.textContent), ["Convert to order…", "Cancel quote…"]) && !q("#qtSave") && qa("#qtForm input, #qtForm textarea").every(f => f.disabled));
  d1._raw.run("UPDATE estimates SET acceptedAt = NULL WHERE id = ?", [QOLD]);
  await openQ(QOLD);
  ok("…without the day when it isn't known", q(".qt-callout-changes").textContent === "The customer accepted this quote, but its order wasn't made. Use Convert to order.");

  console.log("\n=== Who is offered what ===");
  asRoles("staff");
  await openQ(QBIG);
  ok("Back office (Edit) may send, convert and save, but isn't offered Cancel quote", shown("#qtSend") && !!q("#qtConvert") && shown("#qtSave") && off("#qtCancel"));
  q("#qtConvert").click(); await wait(() => modal());
  ok("…and may email the invoice", !!cm().querySelector("#qtConvInvoice"));
  cm().querySelector("#qtConvCancel").click(); await wait(() => !modal());
  signInWith(withLevels("admin", { "orders.invoices": "read" }));
  await openQ(QBIG);
  q("#qtConvert").click(); await wait(() => modal());
  ok("a role that can't send invoices gets no invoice box", !cm().querySelector("#qtConvInvoice"));
  reset();
  await redrawn(() => cm().querySelector("#qtConvForm").dispatchEvent(new w.Event("submit", { cancelable: true })));
  ok("…and the order is made without one", of("convertEstimate")[0].sendInvoice === false && est(QBIG).status === "converted");
  signInWith(withLevels("admin", { "orders.details": "read" }));
  await openQ(QNEW);
  ok("a role that can't make orders isn't offered Convert to order", !q("#qtConvert") && !!q("#qtSend"));
  signInWith(withLevels("admin", { "quotes.estimates": "read" }));
  await openQ(QNEW);
  ok("a role with Read on Quotes sees the quote, every field read-only, with no Save, no Convert, no way to add or change a line",
    qa("#qtForm input, #qtForm textarea").every(f => f.disabled) && !q("#qtSave") && !q("#qtConvert") && !q(".qt-add") && !q("[data-qt-edit]") && off("#qtSend") && off("#qtCancel"));
  ok("…its empty quote reads “No lines.”", q("#qtLines .cust-note").textContent === "No lines.");
  signInWith(withLevels("admin", { "customers.records": "none" }));
  await openQ(QNEW);
  ok("a role that can't open Customers sees the customer's name as text, not a link — never as markup", !q(".cust-sub a") && q(".cust-sub").textContent.startsWith("For " + HTML_NAME) && !q(".cust-sub img") && w.__xss318 === undefined);
  asRoles("admin");
  await openQ(QNEW);
  ok("for others the customer is a link to their page, the name still text", q(".cust-sub a.cust-link").textContent === HTML_NAME && q(".cust-sub a.cust-link").getAttribute("href") === "#customers/" + ROBIN && !q("#qtPage img"));
  ok("…and the heading names the title as text", q("h2.cust-name").textContent.includes(" · Spring <hats>") && !q("h2.cust-name hats"));
  setShops([{ orgId: "acme", name: "Example Club" }]);
  await openQ(QBIG);
  ok("with one shop, the shop isn't named under the quote", q(".cust-sub").textContent.replace(/\s+/g, " ").trim() === "For Sam Noemail · Started " + w.adminDate_(est(QBIG).createdAt));
  await openQ(QNEW);
  q("#qtConvert").click(); await wait(() => modal());
  ok("…nor in the Convert window", cm().querySelector(".cust-merge-text").textContent === "An order is recorded for " + HTML_NAME + ", at the quote's prices ($0.00), not yet paid. The quote is then marked converted." && !cm().querySelector("img") && cm().querySelector("#qtConvInvoice").checked);
  cm().querySelector("#qtConvCancel").click(); await wait(() => !modal());
  setShops(twoShops);

  console.log("\n=== A quote that isn't there, or takes a moment ===");
  reset();
  ok("a number no quote has: the server's sentence, as an alert, under the way back", await openQ(999999) && !q("#qtForm") && q("#qtPage .cust-err").textContent === (await call({ action: "getEstimate", id: 999999 })).body.message &&
    q("#qtPage .cust-err").getAttribute("role") === "alert" && q("#qtPage a.backlink").getAttribute("href") === "#quotes");
  { let release; hold = { action: "getEstimate", gate: new Promise(r => { release = r; }) };
    w.location.hash = "#quotes/" + QNEW;
    await wait(() => !hold);
    ok("while a quote loads, “Loading…” under the way back", /Loading…/.test(page().textContent) && !!q("#qtPage a.backlink") && !q("#qtForm") && q("h1.org-name").textContent === "Quote");
    await go("quotes");
    release(); await pause(120);
    ok("…an answer that arrives after the admin moved on draws nothing", !!q("#qtQ") && !q("#qtForm")); }
  { let release; hold = { action: "getEstimate", gate: new Promise(r => { release = r; }) };
    w.location.hash = "#quotes/999998";
    await wait(() => !hold);
    await go("quotes");
    release(); await pause(120);
    ok("…nor does a refusal that arrives late", !!q("#qtQ") && !q("#qtPage .cust-err")); }

  console.log("\n=== A customer's page: their quotes and “New quote for this customer” ===");
  const cpage = () => d.getElementById("custPage");
  const custDrawn = () => !!(cpage() && cpage().querySelector("#custForm"));
  const openCust = async (id) => { const old = cpage(); if (hashNow() === "customers/" + id) w.adminRoute(); else w.location.hash = "#customers/" + id; return wait(() => cpage() && cpage() !== old && custDrawn()); };
  const qHead = () => qa("#custPage h3.cust-h").find(h => h.textContent === "Quotes");
  const qRows = () => qa("#custPage table.cust-quotes tbody tr");
  d1._raw.run("UPDATE estimates SET updatedAt = '2026-05-03T12:00:00.000Z' WHERE id = ?", [QOLD]);
  d1._raw.run("UPDATE estimates SET updatedAt = '2026-05-02T12:00:00.000Z' WHERE id = ?", [Q1]);
  d1._raw.run("UPDATE estimates SET updatedAt = '2026-05-01T12:00:00.000Z' WHERE id = ?", [QREC]);
  reset();
  ok("a customer's page has a “Quotes” section", await openCust(PAT) && !!qHead());
  ok("…the customer's quotes were asked for once, by customer, up to 50", same(of("listEstimates"), [{ action: "listEstimates", customerId: PAT, limit: 50, offset: 0, key: "cookie" }]));
  ok("…in a table: Quote, Title, Shop, Status, Total, Updated", same(qa("#custPage table.cust-quotes thead th").map(th => th.textContent), ["Quote", "Title", "Shop", "Status", "Total", "Updated"]));
  ok("…newest change first, each number a link to its quote", same(qRows().map(tr => tr.querySelector("a").getAttribute("href")), ["#quotes/" + QOLD, "#quotes/" + Q1, "#quotes/" + QREC]) && qRows()[1].querySelector("a").textContent === est(Q1).number);
  ok("…a row: the title, the shop by name (as text), the status, the total, the day of the last change", same(cells(qRows()[2]), [est(QREC).number, "League visors", "Rec <i>League</i>", "Cancelled", "$330.00", w.adminDate_("2026-05-01T12:00:00.000Z")]) && !qRows()[2].querySelector("i"));
  ok("…a converted quote names its order beside the status", cells(qRows()[1])[3] === "Converted Order " + est(Q1).orderId && qRows()[1].querySelector(".cust-tag").textContent === "Converted");
  ok("…a cancelled quote's row is greyed", qRows()[2].classList.contains("cust-row-archived") && !qRows()[0].classList.contains("cust-row-archived"));
  ok("…no word about a 50-quote limit for three quotes", !/most recent quotes are listed/.test(cpage().textContent));
  ok("“New quote for this customer” is beside the heading, and needs Edit on Quotes", q("#custNewQuote").textContent === "New quote for this customer" && q("#custNewQuote").getAttribute("data-need") === "quotes.estimates:edit" &&
    q("#custNewQuote").closest(".cust-h-row") === qHead().closest(".cust-h-row") && shown("#custNewQuote"));
  reset();
  q("#custNewQuote").click();
  await wait(() => modal() && modal().querySelector("#qtNewForm"));
  ok("it opens the New quote window with the customer already picked, focus on the title", !modal().querySelector("#qtNewPicked").hidden && modal().querySelector("#qtNewFind").hidden &&
    modal().querySelector("#qtNewPickedText").textContent === "For Pat Example · Example Club · pat@example.com · 555-0100" && d.activeElement === modal().querySelector("#qtNewTitle"));
  ok("…asking the server nothing until Create quote", sent.length === 0);
  modal().querySelector("#qtNewTitle").value = "Fall caps"; modal().querySelector("#qtNewShop").value = "acme";
  reset();
  modal().querySelector("#qtNewForm").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await wait(() => /^quotes\/\d+$/.test(hashNow()) && oneDrawn());
  const QFROMC = Number(hashNow().split("/")[1]);
  ok("Create quote makes it for that customer and opens it", of("createEstimate")[0].customerId === PAT && est(QFROMC).customerId === PAT && est(QFROMC).title === "Fall caps" && q(".cust-sub a.cust-link").getAttribute("href") === "#customers/" + PAT);
  reset();
  await openCust(PAT);
  ok("back on the customer's page, the new quote is listed first", qRows().length === 4 && qRows()[0].querySelector("a").getAttribute("href") === "#quotes/" + QFROMC);
  reset();
  q("#custPhone").value = "555-0102";
  { const old = cpage(); q("#custSave").click(); await wait(() => cpage() && cpage() !== old && custDrawn()); }
  ok("saving the customer draws the page again without asking for the quotes again — they are still listed", of("saveCustomer").length === 1 && of("listEstimates").length === 0 && qRows().length === 4);
  { const realEnsure = w.ensureQuotesPage_;
    w.ensureQuotesPage_ = () => Promise.reject(new Error("Couldn't load the Quotes page"));
    reset(); q("#custNewQuote").click(); await wait(() => toasts.length === 1);
    ok("when the Quotes page can't be loaded, the button says so and opens nothing", lastToast().m === "Couldn't load the Quotes page. Check your connection and try again." && lastToast().err && !modal());
    w.ensureQuotesPage_ = realEnsure; }
  reset();
  await openCust(SAM);
  ok("a customer whose quotes are all one shop's still has them listed", qRows().length > 0 && qRows().every(tr => cells(tr)[2] === "Example Club"));
  const LEE = await add({ name: "Lee Example", email: "lee@example.com" });
  await openCust(LEE);
  ok("a customer with no quotes: “No quotes yet.”, with the button", qHead() && qa("#custPage .cust-note").some(n => n.textContent === "No quotes yet.") && !q("#custPage table.cust-quotes") && !!q("#custNewQuote"));
  await openCust(GONE);
  ok("an archived customer's page lists its quotes but offers no new one", !!qHead() && !q("#custNewQuote"));
  { const many = Array.from({ length: 50 }, (_, i) => ({ id: 1000 + i, number: "", orgId: "acme", title: "T" + i, status: "weird", total: 1, updatedAt: "" }));
    scripted = { action: "listEstimates", body: { status: "ok", estimates: many, total: 60 } };
    await openCust(SAM);
    ok("50 quotes listed: a note says only the 50 most recent are, and the Quotes page has them all", qRows().length === 50 && qa("#custPage .cust-note").some(n => n.textContent === "The 50 most recent quotes are listed; the Quotes page has them all."));
    ok("…a quote with no number is called “Quote <id>”, an unknown status is shown as Draft, no day as nothing", cells(qRows()[0])[0] === "Quote 1000" && cells(qRows()[0])[3] === "Draft" && qRows()[0].querySelector(".cust-tag").classList.contains("qt-st-draft") && cells(qRows()[0])[5] === ""); }
  scripted = { action: "listEstimates", body: { status: "ok" } };
  await openCust(SAM);
  ok("an answer with no list reads as no quotes yet", !!qHead() && qa("#custPage .cust-note").some(n => n.textContent === "No quotes yet."));
  scripted = { action: "listEstimates", status: 503, body: { status: "error", message: "Quotes aren't set up on this database yet." } };
  await openCust(PAT);
  ok("a server that can't list quotes (a database not yet updated): the section is left out, the rest of the page is there", !qHead() && !q("#custNewQuote") && !!q("#custForm") && q(".cust-name").textContent === "Pat Example");
  features({ quotes: false });
  reset(); await openCust(PAT);
  ok("with the Quotes feature off: no section, and no quotes asked for", !qHead() && of("listEstimates").length === 0);
  features({});
  signInWith(withLevels("admin", { "quotes.estimates": "none" }));
  reset(); await openCust(PAT);
  ok("a role with no access to Quotes: no section, and no quotes asked for", !qHead() && of("listEstimates").length === 0 && !!q("#custForm"));
  signInWith(withLevels("admin", { "quotes.estimates": "read" }));
  reset(); await openCust(PAT);
  ok("a role with Read on Quotes sees the list but isn't offered a new quote", qRows().length === 4 && off("#custNewQuote"));
  asRoles("admin");
  { let release; hold = { action: "listEstimates", gate: new Promise(r => { release = r; }) };
    w.location.hash = "#customers/" + SAM; await wait(() => !hold);
    await go("quotes");
    release(); await pause(120);
    ok("a customer's quotes that arrive after the admin moved on draw nothing", !!q("#qtQ") && !cpage()); }
  await openCust(PAT);
  { const realEnsure = w.ensureQuotesPage_; let resolveEnsure;
    w.ensureQuotesPage_ = () => new Promise(r => { resolveEnsure = r; });
    reset(); q("#custNewQuote").click(); await pause(20);
    await go("quotes");
    resolveEnsure(); await pause(60);
    ok("…and “New quote for this customer” pressed just before leaving opens nothing once the Quotes page arrives", !modal());
    w.ensureQuotesPage_ = realEnsure; }

  console.log("\n=== Clicks and typing that aren't for the quote's own controls ===");
  const QX = (await mk("acme", SAM, { title: "Clicks" })).id;
  await saveItems(QX, [{ kind: "custom", name: "Club banner", qty: 2, unitPrice: 25, taxable: true }]);
  await openQ(QX);
  reset(); q("#qtTotals").dispatchEvent(new w.MouseEvent("click", { bubbles: true })); await pause(30);
  ok("a click on the quote that isn't on a button or link does nothing", sent.length === 0 && !modal());
  q("#qtTitle").dispatchEvent(new w.Event("change", { bubbles: true })); await pause(30);
  ok("a change to a field that isn't a quantity saves nothing by itself", sent.length === 0);
  qtyBox(0).dispatchEvent(new w.Event("input", { bubbles: true }));
  reset(); q("#qtSend").click(); await wait(() => modal());
  ok("typing in a line's quantity isn't typing above the lines: Send saves nothing first", sent.length === 0 && !!modal().querySelector("#qtSendForm"));
  scripted = { action: "sendEstimate", body: { status: "ok", sentTo: "sam@example.com", emailSent: false, link: "https://acme.example.com/?estimate=" + "a".repeat(32) } };
  modal().querySelector("#qtSendEmail").value = "sam@example.com";
  modal().querySelector("#qtSendForm").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await wait(() => !modal().querySelector("#qtSendLinkWrap").hidden);
  reset();
  await redrawn(() => modal().querySelector("#qtSendCancel").click());
  ok("once the quote is marked sent, the window's Cancel closes it and draws the quote again", !modal() && of("getEstimate").length === 1 && of("sendEstimate").length === 0);
})();
