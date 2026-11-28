process.env.TZ = "UTC";
const fs = require("fs");
const { storefrontPage } = require("./testlib/storefront-page");
const { createD1 } = require("./testlib/d1-shim.js");
const { ok } = require("./testlib/check");
const roles = require("./testlib/roles");
const { JSDOM, ResourceLoader, VirtualConsole } = require("jsdom");

// Phase 8 in the admin pages, run in jsdom with the real orders.js / db.js / quickbooks.js on sql.js behind fetch:
//   the Reports menu (Sales by…, Profit per job, Gift card liability, QuickBooks export) by role and by feature switch,
//   adminCanOpenPage_ (Profit per job needs costs.view too), ADMIN_PAGE_FEATURE;
//   the routes and their lazy loaders (public/admin-salesreports.js, public/admin-quickbooks.js): a script that can't be
//   fetched, a page left while its script was arriving, a script fetched once;
//   public/admin-salesreports.js: Sales by… (dates and quick ranges, Group by, shop, the table, totals, share bars,
//   customer links, the CSV), Profit per job (sort, totals strip, est. marks, negative margins, the cost parts row,
//   order links, the CSV) and Gift card liability (months, signs, totals, the CSV), each with its empty state, its
//   refusals, escaping and its guard against late answers;
//   the order window's Profit box (costs.view only, asked for after the window opens and on every redraw, each non-zero
//   cost part, the est. note, a quiet failure line).
// Invented shops, people and figures only. "Today" is fixed at 2026-12-15 on the page; the business is on
// America/Chicago, and the seeded sales and gift card changes sit on both sides of its midnights, so no day depends on
// this machine's date or time zone.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
globalThis.__f417 = {};
globalThis.__role417 = "admin";
const L = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async (env, host, key, request, msg, need) => roleAllows(DEFAULT_ROLES[globalThis.__role417] || null, need) ? null : jsonResponse({ status: 'error', message: 'Your role can\\'t do that here.' }, 403);\n" +
  "const adminActor = () => 'owner@example.test';\n" + roles.adminAs({ roleFrom: "globalThis.__role417" }) + "\n" + strip(read("functions/_lib/permissions.js")) + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: { club: 'club', school: 'school' }, orgs: {}, features: globalThis.__f417 });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false;\n" +
  "const sendInvoiceEmail = async () => false, sendEstimateEmail = async () => false, sendGiftCardEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  "const setMarketingChoice = async () => ({});\n" +
  strip(read("functions/_lib/db.js")) + "\n" + strip(read("functions/_lib/quickbooks.js")) + "\n" + strip(read("functions/api/orders.js")) + "\nreturn { post: onRequestPost };")();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const pause = (ms) => new Promise(r => setTimeout(r, ms));
const wait = async (cond, n = 500) => { for (let i = 0; i < n && !cond(); i++) await pause(10); return !!cond(); };
process.on("unhandledRejection", (e) => { console.error(e); ok("nothing in the test was left to fail unseen", false); });
let finished = false;
process.on("exit", () => { if (!finished) { console.log("the test ran to its end: false"); process.exitCode = 1; } });
const TODAY = "2026-12-15";

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
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('club','club','Example Club','t','t',1), ('school','school','Example School Shop','t','t',1);
    INSERT INTO customers (id, name, email, phone, createdAt, updatedAt) VALUES (1, 'Pat Example', 'pat@example.com', '555-0101', '2026-01-02T12:00:00.000Z', 't');
    INSERT INTO customers (id, name, company, email, createdAt, updatedAt) VALUES (2, '', 'Example School District', 'ap@example.org', '2026-01-02T12:00:00.000Z', 't');
    INSERT OR REPLACE INTO global_settings (key, value) VALUES ('locale', '{"timeZone":"America/Chicago","country":"US"}'), ('accounting', '{"saleDate":"placed"}');`);
  for (const org of ["club", "school"])
    await must({ action: "createProduct", org, productId: "mug", type: "other", name: "Club Mug", pricingMode: "flat", flatPrice: 10, visible: true, weightOz: 10, noDesignNeeded: true });
  let seq = 0;
  // Made now, then dated (the server won't take a sale dated after the machine's own today).
  const sale = async (org, placedIso, qty, extra) => {
    const oid = (await must(Object.assign({ action: "createLocalSale", org, requestId: "seed417-" + (++seq) + "-abcdef", customerName: "Walk-in",
      paymentMethod: "Cash", items: [{ productId: "mug", size: "", qty }] }, extra || {}))).orderId;
    d1._raw.exec(`UPDATE orders SET placedAt = '${placedIso}' WHERE orderId = '${oid}'`);
    return oid;
  };
  // Chicago is UTC−6 in December: 06:00Z is midnight there.
  const oDec1 = await sale("club", "2026-12-01T06:30:00.000Z", 2, { customerId: 1, customerName: "Pat Example" });       // Dec 1, 00:30
  const oNov30 = await sale("club", "2026-12-01T05:30:00.000Z", 1);                                                       // Nov 30, 23:30
  const oDec15 = await sale("school", "2026-12-16T05:59:00.000Z", 3, { customerId: 2, customerName: "Example School District" }); // Dec 15, 23:59
  const oDec16 = await sale("club", "2026-12-16T06:00:00.000Z", 1, { customerId: 1, customerName: "Pat Example" });      // Dec 16, 00:00
  // Gift cards: one from last year, one bought on a shop order, one given by staff; Chicago months (UTC−6 in winter).
  d1._raw.exec(`INSERT INTO gift_cards (id, code, last4, initialCents, balanceCents, sourceOrderId, status, createdAt) VALUES
      (1, 'GC-OLD-0001', '0001', 1000, 1000, '', 'active', '2025-12-31T12:00:00.000Z'),
      (2, 'GC-SOLD-0002', '0002', 5000, 4000, '${oDec1}', 'active', '2026-01-01T06:30:00.000Z'),
      (3, 'GC-GIVEN-0003', '0003', 2000, 2000, '', 'active', '2026-02-01T05:30:00.000Z');
    INSERT INTO gift_card_ledger (cardId, kind, deltaCents, at) VALUES
      (1, 'issue', 1000, '2025-12-31T12:00:00.000Z'),
      (2, 'issue', 5000, '2026-01-01T06:30:00.000Z'),
      (3, 'issue', 2000, '2026-02-01T05:30:00.000Z'),
      (2, 'redeem', -1000, '2026-03-01T06:00:00.000Z');`);

  // ---- The page ---------------------------------------------------------------------------------------------------
  const adminJs = read("public/admin.js"), srJs = read("public/admin-salesreports.js"), qbJs = read("public/admin-quickbooks.js"), custJs = read("public/admin-customers.js");
  const sent = [], toasts = [], served = [], blobs = [];
  let scripted = [];       // [{ action, status, body | throws | empty, gate }]: the next request for that action is answered with this
  let failScript = null;   // a script name that can't be fetched
  let scriptGate = null;   // { name, gate }: that script arrives when gate settles
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
  const scriptOf = (name) => name === "admin-salesreports.js" ? srJs : name === "admin-quickbooks.js" ? qbJs : name === "admin.js" ? adminJs : name === "admin-customers.js" ? custJs : "";
  class Loader extends ResourceLoader {
    fetch(url) {
      served.push(String(url));
      const name = (String(url).match(/\/([\w-]+\.js)(\?|$)/) || [])[1];
      if (name && name === failScript) return Promise.reject(new Error("offline"));
      if (scriptGate && name === scriptGate.name) { const g = scriptGate.gate; scriptGate = null; return g.then(() => Buffer.from(scriptOf(name))); }
      return Promise.resolve(Buffer.from(scriptOf(name)));
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
      win.URL.createObjectURL = (b) => { blobs.push(b); return "blob:csv"; };
      win.URL.revokeObjectURL = () => {};
      win.fetch = async (url, init) => {
        const u = String(url), b = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
        if (!u.includes("/api/orders")) return reply(404, { status: "error", message: "not here" });
        sent.push(JSON.parse(JSON.stringify(b))); inflight++;
        try {
          const i = scripted.findIndex(s => s.action === b.action);
          if (i >= 0) { const s = scripted.splice(i, 1)[0]; if (s.gate) await s.gate; if (s.empty) throw new Error(""); if (s.throws) throw new Error(s.throws); return reply(s.status || 200, s.body); }
          const x = await call(b);
          return reply(x.status, x.body);
        } finally { inflight--; }
      };
    } });
  const w = dom.window, d = w.document;
  await pause(150);
  await w.loadAdminScript();
  w.showToast = (m, isErr) => toasts.push({ m: String(m), err: !!isErr });
  w.eval('adminKey = "cookie"; setAdminTimeZone_("America/Chicago");');
  w.eval(`localToday_ = function (off) { const t = "${TODAY}"; return off ? addDays_(t, off) : t; };`);
  w.eval("adminOrgs = " + JSON.stringify([{ orgId: "school", name: "Example School Shop" }, { orgId: "club", name: "Example Club" }]) + ";");
  const q = (s) => d.querySelector(s), qa = (s) => [...d.querySelectorAll(s)];
  const id = (s) => d.getElementById(s);
  const app = id("app");
  const text = (el) => el ? el.textContent.replace(/\s+/g, " ").trim() : "";
  const idle = async () => { for (let calm = 0, i = 0; calm < 3 && i < 500; i++) { await pause(10); calm = inflight === 0 ? calm + 1 : 0; } };
  const of = (action) => sent.filter(b => b.action === action).map(b => { const c = Object.assign({}, b); delete c.key; return c; });
  const reset = () => { sent.length = 0; toasts.length = 0; };
  const lastToast = () => toasts[toasts.length - 1] || { m: "", err: false };
  const fire = (el, type) => el.dispatchEvent(new w.Event(type, { bubbles: true }));
  const choose = (el, v) => { el.value = v; fire(el, "change"); };
  const levelsOf = (role) => roles.effectivePermissions(roles.DEFAULT_ROLES[role]);
  const asRoles = (pageRole, serverRole) => { globalThis.__role417 = serverRole || pageRole; w.eval(roles.asRole(pageRole, { name: "Tester", email: "tester@example.test" })); };
  const signInWith = (perms, serverRole) => { globalThis.__role417 = serverRole || "admin"; w.eval(`adminMe = { role: "custom", roleName: "Front desk" }; adminPerms = ${JSON.stringify(perms)}; adminAreas = ${JSON.stringify(roles.PERMISSION_AREAS)};`); };
  const withLevels = (role, changes) => Object.assign({}, levelsOf(role), changes);
  const hashNow = () => w.location.hash.replace(/^#\/?/, "");
  const fetched = (name) => served.filter(u => u.endsWith("/" + name)).length;
  const features = (f) => { globalThis.__f417 = Object.assign({}, f); w.applyFeatures_(Object.assign({}, f)); };
  const gate = () => { let release; const g = new Promise(r => { release = r; }); return { g, release }; };
  const downloads = [];
  const aClick = w.HTMLAnchorElement.prototype.click;
  w.HTMLAnchorElement.prototype.click = function () { if (this.download) downloads.push(this.download); else return aClick.call(this); };
  const csvText = async () => { const b = blobs[blobs.length - 1]; return b ? await new Promise(res => { const r = new w.FileReader(); r.onload = () => res(r.result); r.readAsText(b); }) : ""; };
  const csvLines = async () => (await csvText()).split("\r\n").filter(Boolean);
  const $m = (n) => w.adminMoney_(n);
  const day = (ymd) => w.adminDate_(ymd);
  asRoles("admin");
  features({});
  w.renderAdminNav();
  w.openOrderFromDashboard_ = (org, oid, placed) => { w.__opened = [org, oid, placed]; };

  // ==============================================================================================================
  console.log("=== The Reports menu and who can open each page ===");
  // ==============================================================================================================
  const reportItems = () => { const g = w.adminNavGroups_().find(x => x.label === "Reports"); return g ? g.items.map(it => it[0]) : []; };
  const navLabel = (h) => (w.eval("ADMIN_NAV_GROUPS").find(g => g.label === "Reports").items.find(it => it[0] === h) || [])[1];
  ok("an admin's Reports menu: Audit log, Revenue, Sales tax, Fundraising, Unpaid POs, Sales by…, Profit per job, Gift card liability, Inventory & COGS, Run times, Periods & export, QuickBooks export, Tax packet",
    same(reportItems(), ["audit", "revenue", "salestax", "fundraising", "unpaidpos", "salesby", "profit", "giftliability", "cogs", "runreport", "books", "quickbooks", "taxpacket"]));
  ok("…named “Sales by…”, “Profit per job”, “Gift card liability” and “QuickBooks export”",
    navLabel("salesby") === "Sales by…" && navLabel("profit") === "Profit per job" && navLabel("giftliability") === "Gift card liability" && navLabel("quickbooks") === "QuickBooks export");
  asRoles("manager");
  ok("a Manager has all four", ["salesby", "profit", "giftliability", "quickbooks"].every(h => reportItems().includes(h) && w.adminCanOpen_(h) === true));
  asRoles("staff");
  ok("Back office: the QuickBooks export and Gift card liability (it reads gift cards), never Sales by… or Profit per job",
    reportItems().includes("quickbooks") && reportItems().includes("giftliability") && !reportItems().includes("salesby") && !reportItems().includes("profit") &&
    w.adminCanOpen_("salesby") === false && w.adminCanOpen_("profit") === false);
  asRoles("production");
  ok("Production: none of the four", ["salesby", "profit", "giftliability", "quickbooks"].every(h => !reportItems().includes(h) && w.adminCanOpen_(h) === false));
  signInWith(withLevels("production", { "reports.sales": "read" }));
  ok("Read on the Sales report alone opens Sales by…", w.adminCanOpen_("salesby") === true && reportItems().includes("salesby"));
  signInWith(withLevels("admin", { "reports.sales": "none" }));
  ok("…and None on it closes it, even with everything else", w.adminCanOpen_("salesby") === false && !reportItems().includes("salesby") && reportItems().includes("profit"));
  signInWith(withLevels("admin", { "costs.view": "none" }));
  ok("Profit per job needs costs.view too: Full on the report without it isn't enough", w.adminCanProfit_() === false && w.adminCanOpen_("profit") === false && !reportItems().includes("profit"));
  signInWith(withLevels("production", { "costs.view": "read" }));
  ok("…and costs.view without the report isn't either", w.adminCanProfit_() === false && w.adminCanOpen_("profit") === false);
  signInWith(withLevels("production", { "costs.view": "read", "reports.profit": "read" }));
  ok("…Read on both opens it", w.adminCanProfit_() === true && w.adminCanOpen_("profit") === true && reportItems().includes("profit"));
  signInWith(withLevels("admin", { "giftcards.cards": "none" }));
  ok("Gift card liability follows Gift cards (giftcards.cards): None there, no liability page", w.adminCanOpen_("giftliability") === false && !reportItems().includes("giftliability"));
  signInWith(withLevels("production", { "giftcards.cards": "read" }));
  ok("…Read there opens it", w.adminCanOpen_("giftliability") === true);
  signInWith(withLevels("admin", { "reports.quickbooks": "none" }));
  ok("the QuickBooks export needs Read on its own item", w.adminCanOpen_("quickbooks") === false && !reportItems().includes("quickbooks"));
  signInWith(withLevels("production", { "reports.quickbooks": "read" }));
  ok("…which is enough by itself", w.adminCanOpen_("quickbooks") === true);
  asRoles("admin");
  ok("the QuickBooks export is a Bookkeeping page and Gift card liability a Gift cards page; Sales by… and Profit per job have no switch",
    w.adminPageFeature_("quickbooks") === "bookkeeping" && w.adminPageFeature_("giftliability") === "giftCards" && w.adminPageFeature_("salesby") === "" && w.adminPageFeature_("profit") === "");
  features({ giftCards: false });
  ok("Gift cards switched off: no Gift card liability in the menu (the rest stay)", !reportItems().includes("giftliability") && reportItems().includes("salesby") && reportItems().includes("quickbooks"));
  features({ bookkeeping: false });
  ok("Bookkeeping switched off: no QuickBooks export (Sales by… and Profit per job stay)", !reportItems().includes("quickbooks") && reportItems().includes("salesby") && reportItems().includes("profit"));
  features({});

  // ==============================================================================================================
  console.log("\n=== The routes and their scripts ===");
  // ==============================================================================================================
  const srPage = () => id("srSalesPage"), prPage = () => id("srProfitPage"), lbPage = () => id("srLiabPage");
  const bodyOf = (root) => root ? root.querySelector(".sr-body") : null;
  const drawn = (root) => !!root && !/Loading…/.test(text(bodyOf(root)));
  w.location.hash = "#home"; await idle();
  failScript = "admin-salesreports.js";
  for (const [hash, title] of [["salesby", "Sales by…"], ["profit", "Profit per job"], ["giftliability", "Gift card liability"]]) {
    reset(); w.location.hash = "#" + hash;
    await wait(() => /Couldn't load the report page/.test(text(app)));
    ok(`#${hash} whose script can't be fetched: “Couldn't load the report page. Check your connection and reload the page.”, titled ${title}, nothing asked`,
      /Couldn't load the report page\. Check your connection and reload the page\./.test(text(app)) && text(q("#app h1")) === title && d.title.includes(title) && hashNow() === hash && sent.filter(b => /^get(Sales|Profit|GiftCardLiab)/.test(b.action)).length === 0);
    w.location.hash = "#home"; await idle();
  }
  ok("…and each try asked for the script again (a failed load isn't kept)", fetched("admin-salesreports.js") === 3 && typeof w.renderSalesBy !== "function" && !q('script[src="/admin-salesreports.js"]'));
  failScript = "admin-quickbooks.js";
  reset(); w.location.hash = "#quickbooks";
  await wait(() => /Couldn't load the QuickBooks export page/.test(text(app)));
  ok("#quickbooks whose script can't be fetched: “Couldn't load the QuickBooks export page. Check your connection and reload the page.”",
    /Couldn't load the QuickBooks export page\. Check your connection and reload the page\./.test(text(app)) && d.title.includes("QuickBooks export") && of("getQuickBooksSettings").length === 0);
  failScript = null;
  w.location.hash = "#home"; await idle();
  { const { g, release } = gate();
    scriptGate = { name: "admin-salesreports.js", gate: g };
    reset(); w.location.hash = "#salesby"; await pause(30);
    w.location.hash = "#home"; await idle();
    release(); await pause(30); await idle();
    ok("Sales by… left while its script was still arriving: nothing drawn, nothing asked (the script is there now)", !srPage() && of("getSalesReport").length === 0 && typeof w.renderSalesBy === "function" &&
      typeof w.renderProfitReport === "function" && typeof w.renderGiftCardLiability === "function"); }
  { const { g, release } = gate();
    scriptGate = { name: "admin-quickbooks.js", gate: g };
    reset(); w.location.hash = "#quickbooks"; await pause(30);
    w.location.hash = "#home"; await idle();
    release(); await pause(30); await idle();
    ok("the QuickBooks export left while its script was arriving: nothing drawn, nothing asked", !id("qbPage") && of("getQuickBooksSettings").length === 0 && typeof w.renderQuickBooks === "function"); }
  reset(); w.location.hash = "#quickbooks"; await wait(() => !!id("qbPage")); await idle();
  ok("#quickbooks opened again draws the QuickBooks export page from its script (fetched twice in all)", !!id("qbPage") && fetched("admin-quickbooks.js") === 2 && d.title.includes("QuickBooks export"));
  w.location.hash = "#home"; await idle();
  const goTo = async (hash, page) => { const old = page(); reset(); if (hashNow() === hash) w.adminRoute(); else w.location.hash = "#" + hash; await wait(() => page() && page() !== old && drawn(page())); await idle(); };
  await goTo("salesby", srPage);
  await goTo("profit", prPage);
  await goTo("giftliability", lbPage);
  ok("the three report pages draw from the one script, fetched once more when it arrived and never again", fetched("admin-salesreports.js") === 4 && !!lbPage());
  for (const [hash, label] of [["salesby", "Sales by…"], ["profit", "Profit per job"]]) {
    asRoles("staff");
    w.location.hash = "#home"; await idle();
    reset(); w.location.hash = "#" + hash; await wait(() => !!id("roleOffPanel"));
    ok(`Back office at #${hash} is told “Not available to you”, and nothing is asked (${label})`, /Not available to you\./.test(text(app)) && sent.filter(b => /^get(Sales|Profit)Report$/.test(b.action)).length === 0);
  }
  signInWith(withLevels("admin", { "costs.view": "none" }));
  w.location.hash = "#home"; await idle();
  reset(); w.location.hash = "#profit"; await wait(() => !!id("roleOffPanel"));
  ok("an admin-like role without costs.view at #profit: “Not available to you”, getProfitReport never asked", !!id("roleOffPanel") && of("getProfitReport").length === 0);
  asRoles("admin");
  features({ giftCards: false });
  w.location.hash = "#home"; await idle();
  reset(); w.location.hash = "#giftliability"; await wait(() => !!id("featureOffPanel"));
  ok("Gift cards switched off at #giftliability: “Gift cards is turned off”, nothing asked", id("featureOffPanel").dataset.feature === "giftCards" && /Gift cards is turned off/.test(text(app)) && of("getGiftCardLiability").length === 0);
  features({ bookkeeping: false });
  w.location.hash = "#home"; await idle();
  reset(); w.location.hash = "#quickbooks"; await wait(() => !!id("featureOffPanel"));
  ok("Bookkeeping switched off at #quickbooks: “Bookkeeping is turned off”", id("featureOffPanel").dataset.feature === "bookkeeping" && of("getQuickBooksSettings").length === 0);
  features({});
  w.location.hash = "#home"; await idle();

  // ==============================================================================================================
  console.log("\n=== Sales by… ===");
  // ==============================================================================================================
  // (The views are kept while the admin is open: start from a fresh this-month view.)
  const goSales = () => goTo("salesby", srPage);
  await goSales();
  const s$ = (sel) => srPage().querySelector(sel);
  const rowsOf = (tableId) => qa(`#${tableId} tbody tr`).map(tr => [...tr.children].map(text));
  const footOf = (tableId) => qa(`#${tableId} tfoot tr td`).map(text);
  ok("the tab says Sales by… and the address is #salesby", d.title.includes("Sales by…") && hashNow() === "salesby" && text(q("#app h1")) === "Sales by…");
  ok("this month to date by default, grouped by customer, all shops: asked once as such",
    s$(".sr-from").value === "2026-12-01" && s$(".sr-to").value === TODAY && s$(".sr-org").value === "" &&
    same(of("getSalesReport"), [{ action: "getSalesReport", dateFrom: "2026-12-01", dateTo: TODAY, by: "customer" }]));
  ok("the Shop list: All shops, then each shop by name", same([...s$(".sr-org").options].map(o => o.value + "=" + text(o)), ["=All shops", "club=Example Club", "school=Example School Shop"]));
  const presetsOf = (root) => [...root.querySelectorAll(".sr-preset")].map(b => [text(b), b.dataset.srFrom, b.dataset.srTo, b.classList.contains("on")]);
  ok("the quick ranges: This month (on), Q1–Q4 2026, 2026 and 2025", same(presetsOf(srPage()), [["This month", "2026-12-01", TODAY, true], ["Q1 2026", "2026-01-01", "2026-03-31", false],
    ["Q2 2026", "2026-04-01", "2026-06-30", false], ["Q3 2026", "2026-07-01", "2026-09-30", false], ["Q4 2026", "2026-10-01", "2026-12-31", false], ["2026", "2026-01-01", "2026-12-31", false], ["2025", "2025-01-01", "2025-12-31", false]]));
  const byBtns = () => [...srPage().querySelectorAll(".sr-by-btn")].map(b => [b.dataset.srBy, text(b), b.getAttribute("aria-pressed"), b.classList.contains("on")]);
  ok("Group by: Customer (pressed), Product, Shop, Decoration", same(byBtns(), [["customer", "Customer", "true", true], ["product", "Product", "false", false], ["shop", "Shop", "false", false], ["decoration", "Decoration", "false", false]]));
  ok("the basis line: the dates, orders counted on the day placed, on the business's own calendar",
    text(s$(".sr-basis")) === `${day("2026-12-01")} – ${day(TODAY)} · orders counted on the date they were placed, each day on the business's own calendar.`);
  ok("only the sales made on Chicago's December 1–15: 00:30 on the 1st and 23:59 on the 15th are in; 23:30 on Nov 30 and midnight on the 16th aren't",
    same(rowsOf("srSalesTable").map(r => r[0]), ["Example School District", "Pat Example"]));
  ok("a row: customer, orders, qty, gross, “—” for no discount or refund, net sales, its share", same(rowsOf("srSalesTable"), [
    ["Example School District", "1", "3", "$30.00", "—", "—", "$30.00", "60.0%"], ["Pat Example", "1", "2", "$20.00", "—", "—", "$20.00", "40.0%"]]));
  ok("…a share bar as wide as the share", qa("#srSalesTable .sr-share-bar").map(b => b.style.width).join(",") === "60%,40%");
  ok("the headings: Customer, Orders, Qty, Gross, Discount, Refunds, Net sales, Share", same(qa("#srSalesTable thead th").map(text), ["Customer", "Orders", "Qty", "Gross", "Discount", "Refunds", "Net sales", "Share"]));
  ok("the total row: 2 orders, 5 pieces, $50.00", same(footOf("srSalesTable"), ["Total", "2", "5", "$50.00", "—", "—", "$50.00", ""]));
  ok("a customer's name links to their page", same(qa("#srSalesTable a.cust-link").map(a => a.getAttribute("href")), ["#customers/2", "#customers/1"]));
  ok("below the table: Shipping charged, Rush fees and Sales tax", same(qa("#srSalesPage .sr-below > div").map(x => [text(x.querySelector("span")), text(x.querySelector("strong"))]),
    [["Shipping charged", "$0.00"], ["Rush fees", "$0.00"], ["Sales tax", "$0.00"]]));
  ok("…with the notes: gift cards sold are left out, and each order counts once in the total",
    /gift cards sold are left out — a gift card is money owed on the card until it is spent \(Reports → Gift card liability\)/.test(text(srPage())) &&
    /Orders in the total counts each order once, even when its items fall under several rows\./.test(text(srPage())));
  ok("Export CSV is usable", !s$(".sr-csv").disabled);
  s$(".sr-csv").click(); await idle();
  let csv = await csvLines();
  ok("Export CSV downloads sales-by-customer-2026-12-01-to-2026-12-15.csv", downloads[downloads.length - 1] === "sales-by-customer-2026-12-01-to-2026-12-15.csv");
  ok("…columns Customer, Orders, Qty, Gross, Discount, Refunds, Net sales, Share %; money in dollars; a Total row", same(csv, [
    "Customer,Orders,Qty,Gross,Discount,Refunds,Net sales,Share %", "Example School District,1,3,30,0,0,30,60", "Pat Example,1,2,20,0,0,20,40", "Total,2,5,50,0,0,50,"]));

  console.log("\n--- Group by ---");
  reset(); s$('[data-sr-by="product"]').click(); await idle();
  ok("Product: asked by product, the button pressed and the others not", same(of("getSalesReport"), [{ action: "getSalesReport", dateFrom: "2026-12-01", dateTo: TODAY, by: "product" }]) &&
    same(byBtns().map(b => b[2]), ["false", "true", "false", "false"]) && same(byBtns().map(b => b[3]), [false, true, false, false]));
  ok("…a row per shop's product (named with its shop), headed Product, with no customer links", text(q("#srSalesTable thead th")) === "Product" && same(rowsOf("srSalesTable").map(r => r[0] + " " + r[2]), ["Club Mug (Example School Shop) 3", "Club Mug (Example Club) 2"]) &&
    !q("#srSalesTable a"));
  reset(); s$('[data-sr-by="shop"]').click(); await idle();
  ok("Shop: a row per shop", text(q("#srSalesTable thead th")) === "Shop" && same(rowsOf("srSalesTable").map(r => r[0] + " " + r[6]), ["Example School Shop $30.00", "Example Club $20.00"]));
  s$(".sr-csv").click(); await idle();
  csv = await csvLines();
  ok("…its CSV is sales-by-shop-…, headed Shop", downloads[downloads.length - 1] === "sales-by-shop-2026-12-01-to-2026-12-15.csv" && csv[0].startsWith("Shop,Orders,"));
  reset(); s$('[data-sr-by="decoration"]').click(); await idle();
  ok("Decoration: undecorated mugs are “No decoration”, with the note on items with two kinds", text(q("#srSalesTable thead th")) === "Decoration" && rowsOf("srSalesTable").length === 1 &&
    /An item with two kinds of decoration counts its pieces under each, and its money is split evenly between them\./.test(text(srPage())));
  reset(); s$('[data-sr-by="customer"]').click(); await idle();
  ok("…and the note isn't there for customers", !/two kinds of decoration/.test(text(srPage())));

  console.log("\n--- Dates and shop ---");
  reset(); choose(s$(".sr-org"), "school"); await idle();
  ok("a shop picked: asked with its orgId, only its sales", same(of("getSalesReport"), [{ action: "getSalesReport", dateFrom: "2026-12-01", dateTo: TODAY, by: "customer", orgId: "school" }]) &&
    same(rowsOf("srSalesTable").map(r => r[0]), ["Example School District"]));
  s$(".sr-csv").click(); await idle();
  ok("…its CSV is named for the shop too", downloads[downloads.length - 1] === "sales-by-customer-2026-12-01-to-2026-12-15-school.csv");
  reset(); choose(s$(".sr-org"), ""); await idle();
  reset(); s$('.sr-preset[data-sr-from="2026-10-01"]').click(); await idle();
  ok("Q4 2026: asked for October to December, the button marked and This month not",
    same(of("getSalesReport"), [{ action: "getSalesReport", dateFrom: "2026-10-01", dateTo: "2026-12-31", by: "customer" }]) && s$(".sr-from").value === "2026-10-01" && s$(".sr-to").value === "2026-12-31" &&
    same(presetsOf(srPage()).map(p => p[3]), [false, false, false, false, true, false, false]));
  ok("…all four sales, the walk-in as a name without a link", rowsOf("srSalesTable").length === 3 && footOf("srSalesTable")[1] === "4" &&
    qa("#srSalesTable tbody tr").some(tr => !tr.querySelector("a") && /\$10\.00/.test(text(tr))));
  reset(); s$(".sr-from").value = "2026-11-01"; s$(".sr-to").value = "2026-11-30"; fire(s$(".sr-bar"), "submit"); await idle();
  ok("November typed and Show: only the 23:30 sale on Nov 30, no quick range marked", same(of("getSalesReport").map(b => b.dateFrom + ".." + b.dateTo), ["2026-11-01..2026-11-30"]) &&
    footOf("srSalesTable")[1] === "1" && footOf("srSalesTable")[6] === "$10.00" && presetsOf(srPage()).every(p => !p[3]));
  reset(); s$(".sr-to").value = "2026-12-01"; fire(s$(".sr-to"), "change"); await idle();
  ok("a date changed asks again at once", same(of("getSalesReport").map(b => b.dateFrom + ".." + b.dateTo), ["2026-11-01..2026-12-01"]) && footOf("srSalesTable")[1] === "2");
  reset(); s$(".sr-from").value = ""; fire(s$(".sr-from"), "change"); await idle();
  ok("a date left empty: “Choose both dates.”, nothing asked, nothing to export", text(bodyOf(srPage())) === "Choose both dates." && of("getSalesReport").length === 0 && s$(".sr-csv").disabled);
  reset(); s$(".sr-from").value = "2026-12-10"; s$(".sr-to").value = "2026-12-01"; fire(s$(".sr-bar"), "submit"); await idle();
  ok("From after To: “The From date is after the To date.”, nothing asked", text(bodyOf(srPage())) === "The From date is after the To date." && of("getSalesReport").length === 0 && !!q("#srSalesPage .cust-err[role=alert]"));
  reset(); s$('.sr-preset[data-sr-from="2025-01-01"]').click(); await idle();
  ok("2025, with no sales: “No sales in these dates.”, nothing to export", text(bodyOf(srPage())) === "No sales in these dates." && s$(".sr-csv").disabled && !q("#srSalesTable"));
  s$(".sr-csv").disabled = false; reset(); s$(".sr-csv").click(); await idle();
  ok("…Export CSV pressed anyway: “There are no sales to export.”", lastToast().m === "There are no sales to export." && lastToast().err);
  s$('.sr-preset[data-sr-from="2026-10-01"]').click(); await idle();
  s$('[data-sr-by="shop"]').click(); await idle();
  w.location.hash = "#home"; await idle();
  await goSales();
  ok("coming back finds the same view: Q4 2026 by shop", s$(".sr-from").value === "2026-10-01" && s$(".sr-to").value === "2026-12-31" && byBtns()[2][2] === "true" &&
    same(of("getSalesReport"), [{ action: "getSalesReport", dateFrom: "2026-10-01", dateTo: "2026-12-31", by: "shop" }]));

  console.log("\n--- What the server answers ---");
  const SALES = { status: "ok", dateFrom: "2026-10-01", dateTo: "2026-12-31", basis: "shipped", by: "customer",
    rows: [{ key: "c:7", label: "<b>Example</b> & Co", orders: 3, qty: 12, grossCents: 123456, discountCents: 2345, refundCents: 1000, netCents: 120111, sharePct: 150 },
      { key: "e:pat@example.com", customerId: "x", label: "No customer record: pat@example.com", orders: 1, qty: 1, grossCents: 500, discountCents: 0, refundCents: 0, netCents: 500, sharePct: -5 },
      { key: "12", label: "", orders: 1, qty: 2, grossCents: 100, discountCents: 0, refundCents: 0, netCents: 100, sharePct: 0.04 },
      { key: "", label: "", orders: 0, qty: 0, grossCents: 0, netCents: 0 }],
    totals: { orders: 4, qty: 15, grossCents: 124056, discountCents: 2345, refundCents: 1000, netCents: 120711, shippingCents: 1500, rushCents: 2000, taxCents: 987 } };
  scripted = [{ action: "getSalesReport", body: { status: "ok", report: Object.assign({}, SALES, { by: undefined }) } }];
  s$('[data-sr-by="customer"]').click(); await idle();
  ok("the shipped basis: “orders counted when they ship or are delivered”", /· orders counted when they ship or are delivered, each day/.test(text(s$(".sr-basis"))));
  ok("a report sent inside “report” is read, and its rows keep the asked grouping", text(q("#srSalesTable thead th")) === "Customer");
  ok("names are text, never HTML", rowsOf("srSalesTable")[0][0] === "<b>Example</b> & Co" && !q("#srSalesTable b"));
  ok("a discount and a refund show with a minus: −$23.45, −$10.00; thousands are separated", same(rowsOf("srSalesTable")[0].slice(3, 7), ["$1,234.56", "−$23.45", "−$10.00", "$1,201.11"]));
  ok("a share over 100 fills the bar and no more; below 0 is empty; the figure has one decimal, “—” when there is none",
    same(qa("#srSalesTable .sr-share-bar").map(b => b.style.width), ["100%", "0%", "0.04%", "0%"]) && same(rowsOf("srSalesTable").map(r => r[7]), ["150.0%", "-5.0%", "0.0%", "—"]));
  ok("a key “c:7” links to customer 7; a key of digits to that customer; an email row and a row with no key don't link",
    same(qa("#srSalesTable tbody tr").map(tr => tr.querySelector("a") ? tr.querySelector("a").getAttribute("href") : ""), ["#customers/7", "", "#customers/12", ""]));
  ok("a row with no label shows its key, and one with neither shows “—”", rowsOf("srSalesTable")[2][0] === "12" && rowsOf("srSalesTable")[3][0] === "—");
  ok("the totals below: $15.00 shipping, $20.00 rush, $9.87 tax", same(qa("#srSalesPage .sr-below strong").map(text), ["$15.00", "$20.00", "$9.87"]));
  s$(".sr-csv").click(); await idle();
  csv = await csvLines();
  ok("the CSV: a name like HTML kept as written, a share as a figure, an empty label as the key, the Total row's share empty", same(csv, [
    "Customer,Orders,Qty,Gross,Discount,Refunds,Net sales,Share %", "<b>Example</b> & Co,3,12,1234.56,23.45,10,1201.11,150", "No customer record: pat@example.com,1,1,5,0,0,5,-5",
    "12,1,2,1,0,0,1,0.04", ",0,0,0,0,0,0,0", "Total,4,15,1240.56,23.45,10,1207.11,"]));
  scripted = [{ action: "getSalesReport", body: Object.assign({}, SALES, { rows: [{ key: "c:1", label: "=HYPERLINK(\"http://x.example\",\"Pat\")", orders: 1, qty: 1, grossCents: 100, netCents: 100, sharePct: 100 }] }) }];
  s$('[data-sr-by="customer"]').click(); await idle();
  s$(".sr-csv").click(); await idle();
  csv = await csvLines();
  ok("…a name that starts like a formula is kept as text (a ' in front)", csv[1] === "\"'=HYPERLINK(\"\"http://x.example\"\",\"\"Pat\"\")\",1,1,1,0,0,1,100");
  signInWith(withLevels("admin", { "customers.records": "none" }));
  scripted = [{ action: "getSalesReport", body: SALES }];
  s$('[data-sr-by="customer"]').click(); await idle();
  ok("a role that can't open customers sees their names without links", rowsOf("srSalesTable").length === 4 && !q("#srSalesTable a"));
  asRoles("admin");
  scripted = [{ action: "getSalesReport", status: 400, body: { status: "error", message: "Pick at most three years." } }];
  reset(); s$('[data-sr-by="customer"]').click(); await idle();
  ok("refused: the server's words in an alert, the basis line cleared, nothing to export", text(bodyOf(srPage())) === "Pick at most three years." && text(s$(".sr-basis")) === "" && s$(".sr-csv").disabled &&
    !!q("#srSalesPage .sr-body [role=alert]"));
  scripted = [{ action: "getSalesReport", empty: true }];
  s$('[data-sr-by="customer"]').click(); await idle();
  ok("…a failure with no words: “Couldn't load the report.”", text(bodyOf(srPage())) === "Couldn't load the report.");
  { const { g, release } = gate();
    scripted = [{ action: "getSalesReport", gate: g, body: Object.assign({}, SALES, { rows: [{ key: "c:9", label: "LATE-ANSWER", orders: 1, qty: 1, netCents: 1, grossCents: 1 }] }) }];
    reset(); s$('[data-sr-by="product"]').click(); await pause(30);
    s$('[data-sr-by="shop"]').click(); await idle();
    release(); await pause(30); await idle();
    ok("a slower, older answer doesn't replace a newer one: the shop rows stay", !/LATE-ANSWER/.test(text(srPage())) && text(q("#srSalesTable thead th")) === "Shop" && of("getSalesReport").length === 2); }
  { const { g, release } = gate();
    scripted = [{ action: "getSalesReport", gate: g, body: Object.assign({}, SALES, { rows: [{ key: "c:9", label: "LATE-ANSWER", orders: 1, qty: 1, netCents: 1, grossCents: 1 }] }) }];
    s$('[data-sr-by="customer"]').click(); await pause(30);
    w.location.hash = "#home"; await idle();
    release(); await pause(30); await idle();
    ok("an answer arriving after the page was left draws nothing", !srPage() && !/LATE-ANSWER/.test(text(app))); }
  await goSales();
  { const { g, release } = gate();
    scripted = [{ action: "getSalesReport", gate: g, status: 500, body: { status: "error", message: "LATE-FAILURE" } }];
    s$('[data-sr-by="product"]').click(); await pause(30);
    s$('[data-sr-by="shop"]').click(); await idle();
    release(); await pause(30); await idle();
    ok("…nor does an older failure", !/LATE-FAILURE/.test(text(srPage())) && text(q("#srSalesTable thead th")) === "Shop"); }
  { const { g, release } = gate();
    scripted = [{ action: "getSalesReport", gate: g, status: 500, body: { status: "error", message: "LATE-FAILURE" } }];
    s$('[data-sr-by="customer"]').click(); await pause(30);
    w.location.hash = "#home"; await idle();
    release(); await pause(30); await idle();
    ok("…and a failure arriving after the page was left draws nothing", !srPage() && !/LATE-FAILURE/.test(text(app))); }

  // ==============================================================================================================
  console.log("\n=== Profit per job ===");
  // ==============================================================================================================
  await goTo("profit", prPage);
  const p$ = (sel) => prPage().querySelector(sel);
  ok("the tab says Profit per job and the address is #profit", d.title.includes("Profit per job") && hashNow() === "profit");
  ok("this month to date, lowest margin first, all shops: asked once as such", p$(".sr-from").value === "2026-12-01" && p$(".sr-to").value === TODAY &&
    same(of("getProfitReport"), [{ action: "getProfitReport", dateFrom: "2026-12-01", dateTo: TODAY, sort: "margin" }]));
  ok("Sort: Lowest margin first, Highest profit, Most revenue, Newest", same([...p$(".sr-sort-sel").options].map(o => o.value + "=" + text(o)),
    ["margin=Lowest margin first", "profit=Highest profit", "revenue=Most revenue", "date=Newest"]) && p$(".sr-sort-sel").value === "margin");
  ok("the same quick ranges and Shop list as Sales by…", presetsOf(prPage()).length === 7 && presetsOf(prPage())[0][3] === true && [...p$(".sr-org").options].length === 3);
  const prRows = () => qa("#srProfitTable tbody tr.sr-prow");
  ok("the same orders as Sales by…: the two sold on Chicago's December 1–15", same(prRows().map(tr => text(tr.querySelector("[data-sr-open]"))).sort(), [oDec1, oDec15].sort()));
  ok("…each with its revenue, from the real figures", prRows().some(tr => text(tr.querySelector("[data-sr-open]")) === oDec1 && text(tr.children[4]) === "$20.00") &&
    prRows().some(tr => text(tr.querySelector("[data-sr-open]")) === oDec15 && text(tr.children[4]) === "$30.00" && /Example School Shop/.test(text(tr.children[1]))));
  ok("the totals strip starts with Revenue $50.00 on 2 orders", same([...p$(".sr-totals").querySelectorAll(".gc-total")][0] ? [text(p$(".sr-totals .gc-total-n")), text(p$(".sr-totals .gc-total-l")), text(p$(".sr-totals .gc-total-note"))] : [], ["$50.00", "Revenue", "2 orders"]));
  ok("the note says labor isn't counted yet", /Labor isn't counted yet\./.test(text(prPage())));
  const PROFIT = { status: "ok", dateFrom: "2026-12-01", dateTo: TODAY, basis: "placed", rows: [
      { orderId: "ORD-NEG-1", orgId: "club", orgName: "", customerName: "<i>Pat</i>", saleDate: "2026-12-03", placedAt: "2026-12-03T15:00:00.000Z", revenueCents: 10000, costCents: 12500, profitCents: -2500, marginPct: -25, estimated: true,
        costs: { blanksCents: 6000, transfersCents: 0, decorationCents: 2500, suppliesCents: 300, digitizingCents: 2000, cardFeesCents: 320, postageCents: 1380, laborCents: 0 } },
      { orderId: "ORD-OK-2", orgId: "school", orgName: "Example School Shop", customerName: "", saleDate: "2026-12-05", revenueCents: 20000, costCents: 5000, profitCents: 15000, marginPct: 75, estimated: false,
        costs: { transfersCents: 5000 } },
      { orderId: "ORD-ZERO-3", orgId: "gone", customerName: "Example School District", saleDate: "", revenueCents: 0, costCents: 0, profitCents: 0, marginPct: null, estimated: false } ],
    totals: { orders: 3, revenueCents: 30000, costCents: 17500, profitCents: 12500, marginPct: 41.7, estimatedCount: 1 } };
  scripted = [{ action: "getProfitReport", body: { status: "ok", report: PROFIT } }];
  reset(); choose(p$(".sr-sort-sel"), "profit"); await idle();
  ok("Highest profit: asked with sort profit", same(of("getProfitReport"), [{ action: "getProfitReport", dateFrom: "2026-12-01", dateTo: TODAY, sort: "profit" }]));
  const strip3 = () => [...p$(".sr-totals").querySelectorAll(".gc-total")].map(c => [text(c.querySelector(".gc-total-l")), text(c.querySelector(".gc-total-n")), text(c.querySelector(".gc-total-note")), c.classList.contains("ar-total-warn")]);
  ok("the totals strip: Revenue on 3 orders, Costs, Profit, Margin with “1 order uses estimates”", same(strip3(), [
    ["Revenue", "$300.00", "3 orders", false], ["Costs", "$175.00", "", false], ["Profit", "$125.00", "", false], ["Margin", "41.7%", "1 order uses estimates", false]]));
  ok("the headings: (toggle), Order, Customer, Date, Revenue, Costs, Profit, Margin", same(qa("#srProfitTable thead th").map(text), ["", "Order", "Customer", "Date", "Revenue", "Costs", "Profit", "Margin"]));
  const pcells = (i) => [...prRows()[i].children].map(text);
  ok("a loss: marked as such, its costs “est.”, profit and margin in red", same(pcells(0).slice(1), ["ORD-NEG-1Example Club", "<i>Pat</i>", day("2026-12-03"), "$100.00", "$125.00 est.", "−$25.00", "-25.0%"]) &&
    prRows()[0].classList.contains("sr-neg") && prRows()[0].children[6].classList.contains("sr-negn") && prRows()[0].children[7].classList.contains("sr-negn") && !q("#srProfitTable i"));
  ok("…the shop's name comes from the shop list when the row has none", /Example Club/.test(text(prRows()[0].querySelector(".ar-sub"))));
  ok("a profitable job: no est., nothing red, “—” for no customer", same(pcells(1).slice(2), ["—", day("2026-12-05"), "$200.00", "$50.00", "$150.00", "75.0%"]) &&
    !prRows()[1].classList.contains("sr-neg") && !prRows()[1].querySelector(".sr-est,.sr-negn"));
  ok("no revenue: “—” for the margin and the date; an unknown shop shows its id", same(pcells(2).slice(3), ["—", "$0.00", "$0.00", "$0.00", "—"]) && text(prRows()[2].querySelector(".ar-sub")) === "gone");
  ok("every row starts closed (▸)", prRows().every(tr => tr.querySelector(".sr-toggle").getAttribute("aria-expanded") === "false" && text(tr.querySelector(".sr-toggle")) === "▸") && !q(".sr-parts-row"));
  prRows()[0].querySelector(".sr-toggle").click(); await idle();
  const parts = () => qa("#srProfitTable .sr-parts > div").map(x => text(x.querySelector("span")) + " " + text(x.querySelector("strong")));
  ok("opened (▾): the cost parts that aren't zero, in order, and Labor “not counted yet”",
    same(parts(), ["Blanks $60.00", "Decoration $25.00", "Supplies $3.00", "Outside digitizing $20.00", "Card fees $3.20", "Postage $13.80", "Labor not counted yet"]) &&
    prRows()[0].querySelector(".sr-toggle").getAttribute("aria-expanded") === "true" && text(prRows()[0].querySelector(".sr-toggle")) === "▾");
  prRows()[1].querySelector(".sr-toggle").click(); await idle();
  const partsIn = (i) => [...qa("#srProfitTable .sr-parts-row")[i].querySelectorAll(".sr-parts > div")].map(x => text(x.querySelector("span")) + " " + text(x.querySelector("strong")));
  ok("a second row opened: its parts are Transfers and Labor", qa("#srProfitTable .sr-parts-row").length === 2 && same(partsIn(1), ["Transfers $50.00", "Labor not counted yet"]));
  prRows()[2].querySelector(".sr-toggle").click(); await idle();
  ok("a job with no cost parts at all still says Labor isn't counted", same(partsIn(2), ["Labor not counted yet"]));
  prRows()[1].querySelector(".sr-toggle").click(); prRows()[2].querySelector(".sr-toggle").click(); await idle();
  ok("clicked again: closed", qa("#srProfitTable .sr-parts-row").length === 1);
  scripted = [{ action: "getProfitReport", body: PROFIT }];
  reset(); choose(p$(".sr-sort-sel"), "revenue"); await idle();
  ok("an opened row stays open when the report is asked again (Most revenue)", of("getProfitReport")[0].sort === "revenue" && qa("#srProfitTable .sr-parts-row").length === 1 &&
    prRows()[0].querySelector(".sr-toggle").getAttribute("aria-expanded") === "true");
  w.__opened = null;
  prRows()[0].querySelector("[data-sr-open]").click(); await idle();
  ok("the order's button opens it in its shop's orders, at its placed time", same(w.__opened, ["club", "ORD-NEG-1", "2026-12-03T15:00:00.000Z"]));
  prRows()[1].querySelector("[data-sr-open]").click(); await idle();
  ok("…a row with only a sale date opens at noon UTC that day", same(w.__opened, ["school", "ORD-OK-2", "2026-12-05T12:00:00Z"]));
  prRows()[2].querySelector("[data-sr-open]").click(); await idle();
  ok("…and with neither, with no time", same(w.__opened, ["gone", "ORD-ZERO-3", ""]));
  p$(".sr-csv").click(); await idle();
  csv = await csvLines();
  ok("Export CSV downloads profit-per-job-2026-12-01-to-2026-12-15.csv", downloads[downloads.length - 1] === "profit-per-job-2026-12-01-to-2026-12-15.csv");
  ok("…columns: Order #, Shop, Customer, Sale date, Revenue, Costs, Profit, Margin %, Estimated, then every cost part",
    csv[0] === "Order #,Shop,Customer,Sale date,Revenue,Costs,Profit,Margin %,Estimated,Blanks,Transfers,Decoration,Supplies,Outside digitizing,Card fees,Postage,Labor");
  ok("…a row per order in dollars, “yes” when estimated, no margin left empty", same(csv.slice(1), [
    "ORD-NEG-1,Example Club,<i>Pat</i>,2026-12-03,100,125,-25,-25,yes,60,0,25,3,20,3.2,13.8,0",
    "ORD-OK-2,Example School Shop,,2026-12-05,200,50,150,75,,0,50,0,0,0,0,0,0",
    "ORD-ZERO-3,gone,Example School District,,0,0,0,,,0,0,0,0,0,0,0,0"]));
  scripted = [{ action: "getProfitReport", body: Object.assign({}, PROFIT, { totals: { orders: 1, revenueCents: 100, costCents: 300, profitCents: -200, marginPct: -200, estimatedCount: 2 } }) }];
  choose(p$(".sr-sort-sel"), "date"); await idle();
  ok("a loss overall: Profit and Margin warned, “1 order”, “2 orders use estimates”", same(strip3(), [
    ["Revenue", "$1.00", "1 order", false], ["Costs", "$3.00", "", false], ["Profit", "−$2.00", "", true], ["Margin", "-200.0%", "2 orders use estimates", true]]));
  ok("Newest was asked for", of("getProfitReport").pop().sort === "date");
  scripted = [{ action: "getProfitReport", body: Object.assign({}, PROFIT, { totals: { orders: 2, revenueCents: 100, costCents: 0, profitCents: 100, marginPct: null } }) }];
  choose(p$(".sr-sort-sel"), "margin"); await idle();
  ok("no margin overall: “—”, and no estimates note", same(strip3()[3], ["Margin", "—", "", false]));
  signInWith(withLevels("admin", Object.fromEntries(Object.keys(levelsOf("admin")).filter(f => f.startsWith("orders.")).map(f => [f, "none"]))));
  const ordersOpen = w.adminCanOpen_("orders");
  w.location.hash = "#home"; await idle();
  scripted = [{ action: "getProfitReport", body: PROFIT }];
  await goTo("profit", prPage);
  ok("a role that can't open orders sees the order number as text, not a button", ordersOpen === false && !q("#srProfitTable [data-sr-open]") && text(prRows()[0].querySelector("span.mono")) === "ORD-NEG-1");
  asRoles("admin");
  scripted = [{ action: "getProfitReport", body: Object.assign({}, PROFIT, { rows: [], totals: {} }) }];
  reset(); choose(p$(".sr-sort-sel"), "margin"); await idle();
  ok("no orders: “No orders in these dates.”, no totals strip, nothing to export", text(bodyOf(prPage())) === "No orders in these dates." && text(p$(".sr-totals")) === "" && p$(".sr-csv").disabled);
  p$(".sr-csv").disabled = false; p$(".sr-csv").click(); await idle();
  ok("…Export CSV pressed anyway: “There are no orders to export.”", lastToast().m === "There are no orders to export." && lastToast().err);
  scripted = [{ action: "getProfitReport", body: PROFIT }];
  choose(p$(".sr-sort-sel"), "margin"); await idle();
  scripted = [{ action: "getProfitReport", status: 403, body: { status: "error", code: "forbidden", message: "You can't see costs." } }];
  choose(p$(".sr-sort-sel"), "profit"); await idle();
  ok("refused (“You can't see costs.”): the words in an alert, the totals and basis cleared, nothing to export", text(bodyOf(prPage())) === "You can't see costs." && text(p$(".sr-totals")) === "" &&
    text(p$(".sr-basis")) === "" && p$(".sr-csv").disabled);
  scripted = [{ action: "getProfitReport", body: PROFIT }];
  choose(p$(".sr-sort-sel"), "margin"); await idle();
  reset(); p$(".sr-from").value = "2026-12-20"; fire(p$(".sr-from"), "change"); await idle();
  ok("From after To: the message, the totals cleared, nothing asked", text(bodyOf(prPage())) === "The From date is after the To date." && text(p$(".sr-totals")) === "" && of("getProfitReport").length === 0 && p$(".sr-csv").disabled);
  reset(); p$('.sr-preset[data-sr-from="2026-12-01"]').click(); await idle();
  { const { g, release } = gate();
    scripted = [{ action: "getProfitReport", gate: g, body: Object.assign({}, PROFIT, { rows: [{ orderId: "LATE-PROFIT", revenueCents: 1, costCents: 0, profitCents: 1, marginPct: 100 }] }) }];
    choose(p$(".sr-sort-sel"), "revenue"); await pause(30);
    choose(p$(".sr-sort-sel"), "margin"); await idle();
    release(); await pause(30); await idle();
    ok("an older answer arriving last doesn't replace the newer one", !/LATE-PROFIT/.test(text(prPage())) && prRows().length === 2); }
  { const { g, release } = gate();
    scripted = [{ action: "getProfitReport", gate: g, status: 500, body: { status: "error", message: "LATE-FAILURE" } }];
    choose(p$(".sr-sort-sel"), "profit"); await pause(30);
    choose(p$(".sr-sort-sel"), "margin"); await idle();
    release(); await pause(30); await idle();
    ok("…nor does an older failure", !/LATE-FAILURE/.test(text(prPage())) && prRows().length === 2); }
  { const { g, release } = gate();
    scripted = [{ action: "getProfitReport", gate: g, body: Object.assign({}, PROFIT, { rows: [{ orderId: "LATE-PROFIT", revenueCents: 1, costCents: 0, profitCents: 1, marginPct: 100 }] }) }];
    choose(p$(".sr-sort-sel"), "revenue"); await pause(30);
    w.location.hash = "#home"; await idle();
    release(); await pause(30); await idle();
    ok("an answer arriving after the page was left draws nothing", !prPage() && !/LATE-PROFIT/.test(text(app))); }

  // ==============================================================================================================
  console.log("\n=== Gift card liability ===");
  // ==============================================================================================================
  await goTo("giftliability", lbPage);
  const l$ = (sel) => lbPage().querySelector(sel);
  ok("the tab says Gift card liability and the address is #giftliability", d.title.includes("Gift card liability") && hashNow() === "giftliability");
  ok("this year to date by default, asked once as such, with no shop list", l$(".sr-from").value === "2026-01-01" && l$(".sr-to").value === TODAY && !l$(".sr-org") &&
    same(of("getGiftCardLiability"), [{ action: "getGiftCardLiability", dateFrom: "2026-01-01", dateTo: TODAY }]));
  ok("the quick ranges: This year (on), 2025, This month", same(presetsOf(lbPage()), [["This year", "2026-01-01", TODAY, true], ["2025", "2025-01-01", "2025-12-31", false], ["This month", "2026-12-01", TODAY, false]]));
  ok("the headings: Month, Opening, Sold, Given, Spent, Put back, Adjusted, Voided, Closing — each change explained on hover",
    same(qa("#srLiabTable thead th").map(text), ["Month", "Opening", "Sold", "Given", "Spent", "Put back", "Adjusted", "Voided", "Closing"]) &&
    q("#srLiabTable thead th:nth-child(3)").title === "Cards bought by customers" && q("#srLiabTable thead th:nth-child(4)").title === "Cards issued by staff without a sale" &&
    q("#srLiabTable thead th:nth-child(5)").title === "Spent on orders" && !q("#srLiabTable thead th:nth-child(2)").title);
  const lrows = () => rowsOf("srLiabTable");
  ok("every month of the year so far, by name", lrows().length === 12 && lrows()[0][0] === w.adminDate_("2026-01", { month: "long", year: "numeric" }) && /January/.test(lrows()[0][0]) && /December/.test(lrows()[11][0]));
  ok("January on Chicago's calendar: last year's $10.00 to start, $50.00 sold at 00:30 on the 1st, $20.00 given at 23:30 on the 31st, $80.00 at the end",
    same(lrows()[0].slice(1), ["$10.00", "$50.00", "$20.00", "—", "—", "—", "—", "$80.00"]));
  ok("February: nothing happened (“—”), $80.00 carried through", same(lrows()[1].slice(1), ["$80.00", "—", "—", "—", "—", "—", "—", "$80.00"]));
  ok("March: $10.00 spent at midnight on the 1st, shown with a minus", same(lrows()[2].slice(1), ["$80.00", "—", "—", "−$10.00", "—", "—", "—", "$70.00"]));
  ok("the total row: opening $10.00, $50.00 sold, $20.00 given, −$10.00 spent, closing $70.00", same(footOf("srLiabTable"), ["Total", "$10.00", "$50.00", "$20.00", "−$10.00", "—", "—", "—", "$70.00"]));
  const ltotals = () => [...l$(".sr-totals").querySelectorAll(".gc-total")].map(c => [text(c.querySelector(".gc-total-l")), text(c.querySelector(".gc-total-n")), text(c.querySelector(".gc-total-note"))]);
  ok("on top: “On cards right now” $70.00 (every active card) and “Owed on” the last day $70.00 — the two agree", same(ltotals(), [
    ["On cards right now", "$70.00", "Every active card's balance today"], [`Owed on ${day(TODAY)}`, "$70.00", "The closing balance of the last month"]]));
  ok("the dates above the table and the note on why cards are owed, not sold", text(q("#srLiabPage .sr-body > .cust-note")) === `${day("2026-01-01")} – ${day(TODAY)}` &&
    /Money on gift cards is owed to whoever holds them until it is spent, so it is a liability, not a sale\./.test(text(lbPage())));
  l$(".sr-csv").click(); await idle();
  csv = await csvLines();
  ok("Export CSV downloads gift-card-liability-2026-01-01-to-2026-12-15.csv", downloads[downloads.length - 1] === "gift-card-liability-2026-01-01-to-2026-12-15.csv");
  ok("…columns Month, Opening, Sold, Given, Spent, Put back, Adjusted, Voided, Closing; months as YYYY-MM; dollars; a Total row",
    csv[0] === "Month,Opening,Sold,Given,Spent,Put back,Adjusted,Voided,Closing" && csv[1] === "2026-01,10,50,20,0,0,0,0,80" && csv[3] === "2026-03,80,0,0,10,0,0,0,70" &&
    csv.length === 14 && csv[13] === "Total,10,50,20,10,0,0,0,70");
  reset(); l$('.sr-preset[data-sr-from="2025-01-01"]').click(); await idle();
  ok("2025: the card staff gave on Dec 31 is that month's (Given), $10.00 at the close", same(of("getGiftCardLiability"), [{ action: "getGiftCardLiability", dateFrom: "2025-01-01", dateTo: "2025-12-31" }]) &&
    lrows().length === 12 && same(lrows()[11].slice(1), ["$0.00", "—", "$10.00", "—", "—", "—", "—", "$10.00"]) && ltotals()[1][0] === `Owed on ${day("2025-12-31")}`);
  ok("…opening at nothing shows $0.00, not “—”", lrows()[0][1] === "$0.00" && lrows()[0][8] === "$0.00");
  scripted = [{ action: "getGiftCardLiability", body: { status: "ok", report: { dateFrom: "2026-11-01", dateTo: "2026-11-30", months: [
    { month: "2026-11", openingCents: 0, soldCents: 0, issuedCents: 0, redeemedCents: 0, refundedCents: 1500, adjustedCents: -250, voidedCents: 700, closingCents: 550 }],
    totals: { openingCents: 0, refundedCents: 1500, adjustedCents: -250, voidedCents: 700, closingCents: 550 }, outstandingNowCents: 123456 } } }];
  l$('.sr-preset[data-sr-from="2026-12-01"]').click(); await idle();
  ok("put back, a change by hand below zero, and voided (with a minus): $15.00, −$2.50, −$7.00", same(lrows()[0].slice(5), ["$15.00", "−$2.50", "−$7.00", "$5.50"]));
  ok("…an answer inside “report” is read; its own last day names the closing tile", same(ltotals(), [["On cards right now", "$1,234.56", "Every active card's balance today"], [`Owed on ${day("2026-11-30")}`, "$5.50", "The closing balance of the last month"]]));
  scripted = [{ action: "getGiftCardLiability", body: { status: "ok", months: [], totals: {}, outstandingNowCents: 2500 } }];
  l$('.sr-preset[data-sr-from="2026-12-01"]').click(); await idle();
  ok("no months: “No months in these dates.”, only “On cards right now”, nothing to export", text(bodyOf(lbPage())) === "No months in these dates." &&
    same(ltotals(), [["On cards right now", "$25.00", "Every active card's balance today"]]) && l$(".sr-csv").disabled);
  l$(".sr-csv").disabled = false; reset(); l$(".sr-csv").click(); await idle();
  ok("…Export CSV pressed anyway: “There are no months to export.”", lastToast().m === "There are no months to export." && lastToast().err);
  scripted = [{ action: "getGiftCardLiability", status: 403, body: { status: "error", message: "Your role can't do that here." } }];
  l$('.sr-preset[data-sr-from="2026-12-01"]').click(); await idle();
  ok("refused: the server's words, the tiles cleared", text(bodyOf(lbPage())) === "Your role can't do that here." && text(l$(".sr-totals")) === "" && l$(".sr-csv").disabled);
  reset(); l$(".sr-to").value = "bad"; fire(l$(".sr-bar"), "submit"); await idle();
  ok("a date that isn't one: “Choose both dates.”, nothing asked", text(bodyOf(lbPage())) === "Choose both dates." && of("getGiftCardLiability").length === 0);
  l$('.sr-preset[data-sr-from="2026-01-01"]').click(); await idle();
  { const { g, release } = gate();
    scripted = [{ action: "getGiftCardLiability", gate: g, body: { status: "ok", months: [{ month: "1999-01", openingCents: 0, closingCents: 0 }], totals: {}, outstandingNowCents: 99999 } }];
    l$('.sr-preset[data-sr-from="2025-01-01"]').click(); await pause(30);
    l$('.sr-preset[data-sr-from="2026-01-01"]').click(); await idle();
    release(); await pause(30); await idle();
    ok("an older answer arriving last doesn't replace the newer one", lrows().length === 12 && ltotals()[0][1] === "$70.00"); }
  { const { g, release } = gate();
    scripted = [{ action: "getGiftCardLiability", gate: g, status: 500, body: { status: "error", message: "LATE-FAILURE" } }];
    l$('.sr-preset[data-sr-from="2025-01-01"]').click(); await pause(30);
    w.location.hash = "#home"; await idle();
    release(); await pause(30); await idle();
    ok("a failure arriving after the page was left draws nothing", !lbPage() && !/LATE-FAILURE/.test(text(app))); }
  asRoles("staff");
  await goTo("giftliability", lbPage);
  ok("Back office reads it too (through Gift cards)", lrows().length === 12 && of("getGiftCardLiability").length === 1);
  asRoles("admin");
  w.location.hash = "#home"; await idle();

  // ==============================================================================================================
  console.log("\n=== The order window's Profit box ===");
  // ==============================================================================================================
  w._ordersCache = { club: (await must({ action: "getOrders", org: "club", dateFrom: "2026-01-01", dateTo: "2026-12-31" })).orders };
  const openPay = async (oid) => { const p = w.showPaymentsModal("club", oid); await wait(() => !!q("#pmContent")); return { p }; };
  const closePay = async (box) => { const b = q("#pmCloseBottom"); if (b) b.click(); await box.p; await idle(); };
  const pbox = () => q("#pmProfit");
  const prow = () => qa("#pmProfit tr").map(tr => [...tr.children].map(text));
  const failLine = () => !!pbox() && pbox().children.length === 2 && text(q("#pmProfit .pm-profit-h")) === "Profit" && text(q("#pmProfit .pm-profit-note")) === "Profit isn't available right now.";
  const NOTE_TAIL = "Revenue leaves out sales tax and gift cards sold. Labor isn't counted yet.";
  { const { g, release } = gate();
    scripted = [{ action: "getOrderProfit", gate: g, body: { status: "ok", profit: { revenueCents: 1, profitCents: 1, costs: {} } } }];
    reset(); const pm = await openPay(oDec1);
    ok("with costs.view the window has a Profit box under the money table, “Working it out…” until the answer comes", !!pbox() && text(q("#pmProfit .pm-profit-h")) === "Profit" && text(q("#pmProfit .pm-profit-note")) === "Working it out…" &&
      pbox().getAttribute("aria-live") === "polite" && same(of("getOrderProfit"), [{ action: "getOrderProfit", orderId: oDec1 }]));
    release(); await idle();
    await closePay(pm); }
  reset(); let pm = await openPay(oDec1); await idle();
  ok("the real order: Revenue $20.00, Costs $0.00, Profit $20.00, Margin 100.0%", same(prow(), [["Revenue", "$20.00"], ["Costs", "$0.00"], ["Profit", "$20.00"], ["Margin", "100.0%"]]));
  ok("…and the note: the server's note on blank costs, sales tax and gift cards sold left out, labor not counted yet", text(q("#pmProfit .pm-profit-note")) === "Some lines have no blank cost to go on. " + NOTE_TAIL);
  reset();
  q("#pmContent #pmAmount").value = "20"; q("#pmContent #pmSavePayment").click();
  await wait(() => of("getOrderProfit").length > 0); await idle();
  ok("a payment recorded redraws the window, and the Profit box is asked for again", of("addPayment").length === 1 && of("getOrderProfit").length === 1 && !!pbox() && /Revenue/.test(text(pbox())));
  await closePay(pm);
  const box = async (profit, status) => { scripted = [{ action: "getOrderProfit", status: status || 200, body: profit }]; reset(); const p = await openPay(oDec1); await idle(); return p; };
  pm = await box({ status: "ok", profit: { revenueCents: 10000, profitCents: 7212, marginPct: 72.12, estimated: true,
    costs: { blanksCents: 500, transfersCents: 0, decorationCents: 250, suppliesCents: 0, digitizingCents: 1500, cardFeesCents: 88, postageCents: 450, laborCents: 0 },
    notes: ["Blank cost estimated for lines not yet made.", "Decoration cost uses today's settings", "  ", "<b>Example</b>..."] } });
  ok("each cost part that isn't zero, with a minus, in order; zero parts and labor left out", same(prow(), [["Revenue", "$100.00"], ["Blanks", "−$5.00"], ["Decoration", "−$2.50"],
    ["Outside digitizing", "−$15.00"], ["Card fees", "−$0.88"], ["Postage", "−$4.50"], ["Profit", "$72.12"], ["Margin", "72.1%"]]));
  ok("an estimate: “est. Part of the cost is an estimate: …” with the notes, their full stops trimmed, blank ones dropped, as text",
    text(q("#pmProfit .pm-profit-note")) === "est. Part of the cost is an estimate: Blank cost estimated for lines not yet made; Decoration cost uses today's settings; <b>Example</b>. " .trim() + " " + NOTE_TAIL &&
    !!q("#pmProfit .pm-profit-note .sr-est") && !q("#pmProfit .pm-profit-note b"));
  ok("…profit not red", !q("#pmProfit .pm-profit-neg"));
  await closePay(pm);
  pm = await box({ status: "ok", profit: { revenueCents: 1000, profitCents: -1500, marginPct: -150, estimated: false, costs: { transfersCents: 2500, laborCents: 0 }, notes: ["Decoration cost uses today's settings."] } });
  ok("a loss: Transfers −$25.00, Profit −$15.00 and Margin -150.0% in red", same(prow(), [["Revenue", "$10.00"], ["Transfers", "−$25.00"], ["Profit", "−$15.00"], ["Margin", "-150.0%"]]) &&
    q("#pmProfit tr.pm-profit-sum").classList.contains("pm-profit-neg") && q("#pmProfit tr:last-child td:last-child").classList.contains("pm-profit-neg"));
  ok("…notes without an estimate are said plainly, with no est.", text(q("#pmProfit .pm-profit-note")) === "Decoration cost uses today's settings. " + NOTE_TAIL && !q("#pmProfit .sr-est"));
  await closePay(pm);
  pm = await box({ status: "ok", revenueCents: 0, profitCents: 0, marginPct: null, costs: null });
  ok("a profit sent at the top level is read; no revenue gives a margin of “—”", same(prow(), [["Revenue", "$0.00"], ["Costs", "$0.00"], ["Profit", "$0.00"], ["Margin", "—"]]));
  await closePay(pm);
  pm = await box({ status: "error", message: "Order not found" }, 404);
  ok("refused: “Profit isn't available right now.”, quietly in the box", failLine() && !q("#pmContent #pmError").textContent.trim());
  await closePay(pm);
  pm = await box({ status: "ok", profit: { revenueCents: 100 } });
  ok("an answer without a profit: the same quiet line", failLine());
  await closePay(pm);
  scripted = [{ action: "getOrderProfit", empty: true }];
  reset(); pm = await openPay(oDec1); await idle();
  ok("a request that fails outright: the same quiet line", failLine());
  await closePay(pm);
  { const { g, release } = gate();
    scripted = [{ action: "getOrderProfit", gate: g, body: { status: "ok", profit: { revenueCents: 4242, profitCents: 4242, costs: {} } } }];
    reset(); const p = await openPay(oDec1);
    await closePay(p);
    release(); await pause(30); await idle();
    ok("the window closed before the answer: nothing is drawn anywhere", !pbox() && !qa(".pm-profit, .pm-profit-t").length && !/\$42\.42/.test(text(app))); }
  { const { g, release } = gate();
    scripted = [{ action: "getOrderProfit", gate: g, status: 500, body: { status: "error", message: "down" } }];
    reset(); const p = await openPay(oDec1);
    await closePay(p);
    release(); await pause(30); await idle();
    ok("…nor when that late answer is a failure", !pbox() && !qa(".pm-profit, .pm-profit-note").length); }
  asRoles("staff");
  reset(); pm = await openPay(oDec1); await idle();
  ok("Back office (no costs.view): no Profit box, getOrderProfit never asked", !pbox() && of("getOrderProfit").length === 0 && !/Working it out/.test(text(q("#pmContent"))));
  await closePay(pm);
  ok("…and pmLoadProfit_ asks nothing for it even when called", await (async () => { reset(); const b = d.createElement("div"); d.body.appendChild(b); await w.pmLoadProfit_(b, oDec1); const r = b.innerHTML === "" && of("getOrderProfit").length === 0; b.remove(); return r; })());
  asRoles("admin");
  ok("pmLoadProfit_ with no box does nothing", await (async () => { reset(); await w.pmLoadProfit_(null, oDec1); return of("getOrderProfit").length === 0; })());
  { const r = await call({ action: "getOrderProfit", orderId: oDec1 });
    globalThis.__role417 = "staff"; const s = await call({ action: "getOrderProfit", orderId: oDec1 }); globalThis.__role417 = "admin";
    ok("(the server agrees: the admin gets the profit, Back office is refused)", r.status === 200 && r.body.profit.revenueCents === 2000 && s.status === 403); }

  finished = true;
})().catch((e) => { console.error(e); ok("the test ran without an exception", false); finished = true; process.exit(1); });
