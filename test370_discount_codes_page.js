const fs = require("fs");
const { storefrontPage } = require("./testlib/storefront-page");
const { createD1 } = require("./testlib/d1-shim.js");
const { ok } = require("./testlib/check");
const roles = require("./testlib/roles");
const { JSDOM, ResourceLoader, VirtualConsole } = require("jsdom");

// Discount codes (migrations/0115) in the admin page (public/admin.js), run in jsdom with the real orders.js / db.js on
// sql.js behind fetch:
//   the "Discount codes" button in the menu (right after Quotes), who gets it (the feature, discounts.codes), the
//   #discounts route when it's off or not theirs;
//   the list (renderDiscountCodes): the toolbar, the Shop and Status filters, the search box's pause before it asks,
//   the table's cells, paging, a slower older answer never drawn over a newer one, the empty and error states, and
//   nothing typed read as HTML;
//   one code's window (dcShowCode_): a new code, "Make one", Percent off / Amount off, who can use it, the page's own
//   refusals, Create / Save (saveDiscountCode) against only the Active tick changed (setDiscountCodeActive), a used
//   code's locked fields and the line saying why, Delete only for an unused code and Full, the orders it was used on
//   with their links and "Given back";
//   Codes for a list of emails (dcShowBulk_): reading the list, the count, more than 500 refused, the prefix, the result,
//   skipped addresses, Copy as CSV and Download CSV;
//   a read-only role (Back office); and "Code SAVE10" on an order (orderDiscountNote_) in the Orders table, the phone's
//   order card, the Payments window and a row drawn again after a change.
// The page signs in as a built-in role (testlib/roles.js asRole) and the server answers as one (adminAs). Invented
// people, shops and codes only.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async (env, host, key, request, msg, need) => roleAllows(DEFAULT_ROLES[globalThis.__role334] || null, need) ? null : jsonResponse({ status: 'error', message: 'Your role can\\'t do that here.' }, 403);\n" +
  "const adminActor = () => 'owner@example.test';\n" + roles.adminAs({ roleFrom: "globalThis.__role334" }) + "\n" + strip(read("functions/_lib/permissions.js")) + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false;\n" +
  "const sendInvoiceEmail = async () => false, sendEstimateEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
const pause = (ms) => new Promise(r => setTimeout(r, ms));
const wait = async (cond, n = 500) => { for (let i = 0; i < n && !cond(); i++) await pause(10); return !!cond(); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
process.on("unhandledRejection", (e) => { console.error(e); ok("nothing in the test was left to fail unseen", false); });

(async () => {
  globalThis.__role334 = "admin";
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
  const must = async (body) => { const r = await call(body); if (r.status !== 200) throw new Error("seed " + body.action + ": " + JSON.stringify(r.body)); return r.body; };
  const codeRow = (code) => d1.q("SELECT * FROM discount_codes WHERE code = ?", code)[0];

  const BAND_NAME = "Example <b>Band</b>";
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('club','club','Example Club','t','t'), ('band','band','${BAND_NAME}','t','t');`);

  // ---- The page ---------------------------------------------------------------------------------------------------
  const adminJs = read("public/admin.js");
  const sent = [], toasts = [], downloads = [], clipboard = [];
  let scripted = [];       // [{ action, status, body | throws }]: the next request for that action is answered with this
  let hold = null;         // { action, gate }: the next request for that action waits for gate
  let clipboardFails = false;
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
  class Loader extends ResourceLoader {
    fetch(url) { if (/\/admin\.js(\?|$)/.test(url)) return Promise.resolve(Buffer.from(adminJs)); return Promise.resolve(Buffer.from("")); }
  }
  const vc = new VirtualConsole();
  vc.sendTo(console, { omitJSDOMErrors: true });
  vc.on("jsdomError", (e) => { if (!/Not implemented/.test(e.message)) console.error(e); });
  let inflight = 0;
  const dom = new JSDOM(storefrontPage(), { runScripts: "dangerously", resources: new Loader(), virtualConsole: vc, url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win) {
      win.CSS = win.CSS || { escape: (s) => String(s).replace(/["\\]/g, "\\$&") };
      win.scrollTo = () => {};
      Object.defineProperty(win.navigator, "clipboard", { configurable: true, value: { writeText: async (t) => { if (clipboardFails) throw new Error("denied"); clipboard.push(String(t)); } } });
      win.fetch = async (url, init) => {
        const u = String(url), b = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
        if (!u.includes("/api/orders")) return reply(404, { status: "error", message: "not here" });
        sent.push(b); inflight++;
        try {
          const i = scripted.findIndex(s => s.action === b.action);
          if (i >= 0) { const s = scripted.splice(i, 1)[0]; if (s.throws) throw new Error(s.throws); return reply(s.status || 200, s.body); }
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
  const blobs = new Map();
  w.URL.createObjectURL = (blob) => { const k = "blob:t/" + blobs.size; blobs.set(k, blob); return k; };
  w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function () { if (this.download) downloads.push({ name: this.download, blob: blobs.get(this.href) }); };
  const blobText = (blob) => new Promise((res) => { const r = new w.FileReader(); r.onload = () => res(String(r.result)); r.readAsText(blob); });
  w.eval('adminKey = "cookie"; setAdminTimeZone_("UTC");');
  const shopList = [{ orgId: "club", name: "Example Club" }, { orgId: "band", name: BAND_NAME }];
  const setShops = (list) => w.eval("adminOrgs = " + JSON.stringify(list) + ";");
  setShops(shopList);
  const q = (s) => d.querySelector(s), qa = (s) => [...d.querySelectorAll(s)];
  const id = (s) => d.getElementById(s);
  const app = id("app");
  const text = (el) => el ? el.textContent.replace(/\s+/g, " ").trim() : "";
  const reset = () => { sent.length = 0; toasts.length = 0; downloads.length = 0; clipboard.length = 0; };
  const of = (action) => sent.filter(b => b.action === action).map(b => { const c = Object.assign({}, b); delete c.listHeld; delete c.key; return c; });
  const lastToast = () => toasts[toasts.length - 1] || { m: "", err: false };
  const hashNow = () => w.location.hash.replace(/^#\/?/, "");
  const idle = async () => { for (let calm = 0, i = 0; calm < 3 && i < 500; i++) { await pause(10); calm = inflight === 0 ? calm + 1 : 0; } };
  const levelsOf = (role) => roles.effectivePermissions(roles.DEFAULT_ROLES[role]);
  const asRoles = (pageRole, serverRole) => { globalThis.__role334 = serverRole || pageRole; w.eval(roles.asRole(pageRole, { name: "Tester", email: "tester@example.test" })); };
  const signInWith = (perms, serverRole) => { globalThis.__role334 = serverRole || "admin"; w.eval(`adminMe = { role: "custom", roleName: "Front desk" }; adminPerms = ${JSON.stringify(perms)}; adminAreas = ${JSON.stringify(roles.PERMISSION_AREAS)};`); };
  const withLevels = (role, changes) => Object.assign({}, levelsOf(role), changes);
  const features = (f) => w.applyFeatures_(f);
  const modal = () => { const all = qa(".admin-modal"); return all[all.length - 1] || null; };
  const confirmBox = () => q(".confirm-modal");
  const answer = async (yes) => { await wait(() => confirmBox()); const box = confirmBox(); const info = { message: box.dataset.message, okLabel: box.querySelector("#cmOk").textContent, cancelLabel: box.querySelector("#cmCancel").textContent };
    box.querySelector(yes ? "#cmOk" : "#cmCancel").click(); await wait(() => !confirmBox()); return info; };
  const fire = (el, type) => el.dispatchEvent(new w.Event(type, { bubbles: true }));
  const type = (el, v) => { el.value = v; fire(el, "input"); };
  const pick = (el, v) => { el.value = v; fire(el, "change"); };
  const tick = (el, v) => { el.checked = v; fire(el, "change"); };
  const day = (v) => w.adminDate_(v);
  const rowButtons = () => qa("#adminNav .admin-nav-row > button.admin-nav-btn");
  const hashes = (btns) => btns.map(b => b.dataset.h);
  const page = () => id("dcPage");
  const listDrawn = () => !!(page() && !/Loading…/.test(id("dcBody").textContent));
  const go = async () => { const old = page(); if (hashNow() === "discounts") w.adminRoute(); else w.location.hash = "#discounts"; await wait(() => page() && page() !== old && listDrawn()); await idle(); };
  const rows = () => qa("#dcBody table.dc-table tbody tr");
  const cellsOf = (tr) => [...tr.children].map(td => text(td));
  const rowOf = (code) => rows().find(tr => text(tr.children[0]) === code);
  const off = (el) => !!el && el.hasAttribute("data-perm-off");
  asRoles("admin");

  // ==============================================================================================================
  console.log("=== The Discount codes button in the menu ===");
  // ==============================================================================================================
  w.renderAdminNav();
  { const row = hashes(rowButtons());
    const btn = rowButtons().find(b => b.dataset.h === "discounts");
    ok("an admin's top buttons have “Discount codes”, once", row.filter(h => h === "discounts").length === 1 && !!btn && btn.textContent === "Discount codes");
    ok("…right after Quotes", row[row.indexOf("discounts") - 1] === "quotes");
    ok("…a button that goes to #discounts like the others", btn.dataset.adminAction === "navGo" && btn.type === "button"); }
  ok("(the built-in roles) Admin and Manager have Full on Discount codes, Back office Read, Production none",
    levelsOf("admin")["discounts.codes"] === "full" && levelsOf("manager")["discounts.codes"] === "full" && levelsOf("staff")["discounts.codes"] === "read" && levelsOf("production")["discounts.codes"] === "none");
  for (const [role, label] of [["manager", "Manager"], ["staff", "Back office"]]) {
    asRoles(role); w.renderAdminNav();
    ok(label + " gets the button too", hashes(rowButtons()).includes("discounts") && w.adminCanOpen_("discounts") === true);
  }
  asRoles("production"); w.renderAdminNav();
  ok("Production, with no access, gets no button and can't open the page", rowButtons().length > 0 && !hashes(rowButtons()).includes("discounts") && w.adminCanOpen_("discounts") === false && w.adminCanDiscounts_() === false);
  signInWith(withLevels("admin", { "discounts.codes": "read" })); w.renderAdminNav();
  ok("Read on Discount codes is enough for the button", hashes(rowButtons()).includes("discounts") && w.adminCanDiscounts_() === true);
  signInWith(withLevels("admin", { "discounts.codes": "none" })); w.renderAdminNav();
  ok("None on Discount codes: no button, even with everything else", !hashes(rowButtons()).includes("discounts") && hashes(rowButtons()).includes("quotes") && w.adminCanOpen_("discounts") === false);
  signInWith(withLevels("admin", { "quotes.estimates": "none" })); w.renderAdminNav();
  { const row = hashes(rowButtons());
    ok("a role without Quotes gets Discount codes where Quotes would be: right after Customers", !row.includes("quotes") && row[row.indexOf("discounts") - 1] === "customers"); }
  signInWith(withLevels("admin", { "quotes.estimates": "none", "customers.records": "none" })); w.renderAdminNav();
  { const row = hashes(rowButtons());
    ok("…and without Customers either, right after Orders", !row.includes("customers") && row[row.indexOf("discounts") - 1] === "orders"); }
  { const nothing = Object.fromEntries(Object.keys(levelsOf("admin")).map(f => [f, "none"]));
    signInWith(Object.assign({}, nothing, { "discounts.codes": "read", "run.queue": "read" }));
    ok("a role whose first page is Discount codes lands on it, ahead of Run Order", w.adminFirstPage_() === "discounts"); }
  asRoles("admin");
  features({ discounts: false }); w.renderAdminNav();
  ok("with the Discount codes feature turned off there is no button, even for an admin", !hashes(rowButtons()).includes("discounts") && hashes(rowButtons()).includes("quotes") && w.adminCanOpen_("discounts") === false);
  reset();
  w.location.hash = "#discounts";
  await wait(() => !!id("featureOffPanel"));
  ok("…#discounts says “Discount codes is turned off” and asks the server for nothing", /Discount codes is turned off/.test(app.textContent) && id("featureOffPanel").dataset.feature === "discounts" && of("listDiscountCodes").length === 0);
  features({}); w.renderAdminNav();
  ok("…and the button is back when it is on again", hashes(rowButtons()).includes("discounts"));
  asRoles("production");
  reset();
  w.location.hash = "#home"; await idle();
  w.location.hash = "#discounts";
  await wait(() => !!id("roleOffPanel"));
  ok("a role without it is told “Not available to you” at #discounts, and nothing is asked for", /Not available to you\./.test(app.textContent) && of("listDiscountCodes").length === 0);
  asRoles("admin");

  // ==============================================================================================================
  console.log("\n=== The page with no codes yet ===");
  // ==============================================================================================================
  reset();
  w.location.hash = "#home"; await idle();
  await go();
  ok("#discounts draws “Discount codes”, the tab's title too", text(q("#app h1")) === "Discount codes" && /Discount codes \(Admin\)$/.test(d.title) && hashNow() === "discounts");
  ok("…lit in the menu", w.adminNavActive_() === "discounts" && rowButtons().find(b => b.dataset.h === "discounts").classList.contains("active"));
  ok("it asked for the first page: every status, every shop, 50 at a time", same(of("listDiscountCodes"), [{ action: "listDiscountCodes", q: "", org: "", status: "all", limit: 50, offset: 0 }]));
  ok("with none at all: “No discount codes yet. Make one with “+ New code”.”, no count, no pager", text(id("dcBody")) === "No discount codes yet. Make one with “+ New code”." && id("dcCount").textContent === "" && id("dcPager").innerHTML === "");
  ok("the toolbar: Search (code, email or note), Shop (All shops, then each shop by name, as text), Status",
    id("dcQ").type === "search" && id("dcQ").placeholder === "Code, email or note" && id("dcQ").maxLength === 200 &&
    same([...id("dcShop").options].map(o => o.value + "=" + o.textContent), ["=All shops", "club=Example Club", "band=" + BAND_NAME].sort((a, b) => a === "=All shops" ? -1 : b === "=All shops" ? 1 : a.split("=")[1].localeCompare(b.split("=")[1]))) &&
    !id("dcShop").querySelector("b"));
  ok("…Status: Active, Switched off, Expired, Used up, All — All chosen", same([...id("dcStatus").options].map(o => o.value + "=" + o.textContent), ["active=Active", "off=Switched off", "expired=Expired", "usedUp=Used up", "all=All"]) && id("dcStatus").value === "all");
  ok("…and “+ New code” and “Codes for a list of emails…”, needing Edit", text(id("dcNew")) === "+ New code" && id("dcNew").getAttribute("data-need") === "discounts.codes:edit" && !off(id("dcNew")) &&
    text(id("dcBulk")) === "Codes for a list of emails…" && id("dcBulk").getAttribute("data-need") === "discounts.codes:edit" && !off(id("dcBulk")));
  ok("the note under it: the discount is off the goods, one code an order, a void gives the use back",
    /the discount comes off the goods \(not shipping or a rush fee\), and an order uses one code at most\. A voided or deleted order gives its use back\./.test(text(page())));
  asRoles("staff");
  await go();
  ok("Back office (Read): the same empty list without the “Make one” sentence, and the buttons hidden", text(id("dcBody")) === "No discount codes yet." && off(id("dcNew")) && off(id("dcBulk")));
  asRoles("admin");
  setShops([{ orgId: "club", name: "Example Club" }]);
  w.eval('_dcView.org = "band";');
  await go();
  ok("with one shop there is no Shop filter, and a filter for a shop not in the list is let go", !id("dcShop") && w.eval("_dcView.org") === "" && of("listDiscountCodes").pop().org === "");
  setShops(shopList);

  // ---- The codes ------------------------------------------------------------------------------------------------
  const mk = async (c) => (await must({ action: "saveDiscountCode", code: c })).code;
  const ROBIN = '<img src=x onerror="window.__xss334=1">Robin';
  const now = Date.now(), ago = (h) => new Date(now - h * 3600e3).toISOString();
  const order = (oid, org, name, placed, discountCents, note, extra) => {
    d1.q("INSERT INTO orders (orderId, orgId, customerName, contact, placedAt, paid, discountCents, discountNote, voidedAt) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)",
      oid, org, name, "pat@example.com", placed, discountCents, note, (extra && extra.voidedAt) || null);
    d1.q("INSERT INTO order_items (orderId, orgId, productId, name, type, size, qty, unitPriceCents, lineTotalCents) VALUES (?, ?, 'cap', 'Club cap', 'cap', 'OSFA', 2, 2000, 4000)", oid, org);
  };
  const use = (codeId, oid, email, cents, at, releasedAt) => d1.q("INSERT INTO discount_code_uses (codeId, orderId, email, amountCents, usedAt, releasedAt) VALUES (?, ?, ?, ?, ?, ?)", codeId, oid, email, cents, at, releasedAt || null);
  // Made oldest first (the list is newest first).
  const cOld = await mk({ code: "OLDCODE", kind: "amount", amount: 2, maxUses: 5, expiresOn: "2020-01-01" });
  const cOff = await mk({ code: "OFFCODE", kind: "percent", percent: 5, maxUses: 10 });
  await must({ action: "setDiscountCodeActive", id: cOff.id, active: false });
  const cGone = await mk({ code: "USEDUP", kind: "amount", amount: 3, maxUses: 1 });
  const cPat = await mk({ code: "PAT-ONE", kind: "percent", percent: 15, email: "Pat@Example.com", orgId: "band", note: '"><b>vip</b>' });
  const cFive = await mk({ code: "FIVEOFF", kind: "amount", amount: 5, orgId: "club", maxUses: 3, oncePerEmail: true, expiresOn: "2999-12-31" });
  const cSave = await mk({ code: "SAVE10", kind: "percent", percent: 10, maxUses: 50, note: "Spring" });
  order("CLUB-1", "club", "Pat Example", ago(5), 400, "Code SAVE10");
  order("CLUB-2", "club", ROBIN, ago(4), 400, "Code SAVE10", { voidedAt: ago(3) });
  order("CLUB-3", "club", "Sam Example", ago(2), 400, "Code SAVE10");
  order("CLUB-4", "club", "Lee Example", ago(1), 500, "Loyal customer");
  order("CLUB-5", "club", "Kim Example", ago(1.5), 300, "Owner's own");
  use(cSave.id, "CLUB-1", "pat@example.com", 400, ago(5));
  use(cSave.id, "CLUB-2", "robin@example.com", 400, ago(4), ago(3));
  use(cSave.id, "CLUB-3", "sam@example.com", 400, ago(2));
  use(cFive.id, "CLUB-4", "lee@example.com", 500, ago(1));
  use(cGone.id, "GONE-9", "jo@example.com", 300, ago(30));   // an order that isn't there any more (no shop)

  // ==============================================================================================================
  console.log("\n=== The list ===");
  // ==============================================================================================================
  await go();
  ok("the table's columns: Code, Discount, Shop, For, Used, Expires, Status", same(qa("#dcBody table.dc-table thead th").map(th => th.textContent), ["Code", "Discount", "Shop", "For", "Used", "Expires", "Status"]));
  ok("one row a code, newest first", same(rows().map(tr => text(tr.children[0])), ["SAVE10", "FIVEOFF", "PAT-ONE", "USEDUP", "OFFCODE", "OLDCODE"]));
  ok("the count: “6 codes”, and no pager for one page", id("dcCount").textContent === "6 codes" && id("dcPager").innerHTML.trim() === "");
  ok("SAVE10: 10% off, All shops, Anyone, 2 of 50 (the given-back use doesn't count), Never, Active",
    same(cellsOf(rowOf("SAVE10")), ["SAVE10", "10% off", "All shops", "Anyone", "2 of 50", "Never", "Active"]));
  ok("FIVEOFF: $5.00 off, the club, “Anyone, once per email”, 1 of 3, its expiry day, Active",
    same(cellsOf(rowOf("FIVEOFF")), ["FIVEOFF", "$5.00 off", "Example Club", "Anyone, once per email", "1 of 3", day("2999-12-31"), "Active"]));
  ok("PAT-ONE: one person's code shows the address (lower-case), the band's name as text",
    same(cellsOf(rowOf("PAT-ONE")), ["PAT-ONE", "15% off", BAND_NAME, "pat@example.com", "0 of 1", "Never", "Active"]) && !rowOf("PAT-ONE").querySelector("b"));
  ok("USEDUP: “Used up”; OFFCODE: “Switched off”; OLDCODE: “Expired”",
    cellsOf(rowOf("USEDUP"))[6] === "Used up" && cellsOf(rowOf("USEDUP"))[4] === "1 of 1" && cellsOf(rowOf("OFFCODE"))[6] === "Switched off" && cellsOf(rowOf("OLDCODE"))[6] === "Expired");
  ok("…each status has its own tag style, and a code that isn't active is greyed", rowOf("USEDUP").querySelector(".cust-tag.dc-st-usedUp") && rowOf("OFFCODE").querySelector(".cust-tag.dc-st-off") &&
    rowOf("OLDCODE").querySelector(".cust-tag.dc-st-expired") && rowOf("SAVE10").querySelector(".cust-tag.dc-st-active") &&
    rowOf("OFFCODE").classList.contains("cust-row-archived") && !rowOf("SAVE10").classList.contains("cust-row-archived"));
  ok("the code is a link (monospace), for the keyboard", rows().every(tr => { const a = tr.children[0].querySelector("a.dc-code[data-dc-open]"); return a && a.getAttribute("href") === "#discounts"; }));
  ok("(each status's tag has its own style in admin.css)", ["active", "off", "expired", "usedUp"].every(s => new RegExp("\\.dc-st-" + s + "\\b[^{]*\\{[^}]*background").test(read("public/admin.css"))));
  { // dcShopName_ / dcWho_ / dcStatusTag_ on their own
    ok("a code's shop: its orgName, else the page's shop name, else its id; no shop is All shops",
      w.dcShopName_({ orgId: "club", orgName: "Given" }) === "Given" && w.dcShopName_({ orgId: "club" }) === "Example Club" && w.dcShopName_({ orgId: "zz" }) === "zz" && w.dcShopName_({ orgId: null }) === "All shops" && w.dcShopName_(null) === "All shops");
    ok("an unknown status is shown as Active", /dc-st-active[^>]*>Active</.test(w.dcStatusTag_({ status: "weird" })));
  }

  console.log("\n=== Filters and search ===");
  reset();
  pick(id("dcStatus"), "usedUp");
  await wait(() => of("listDiscountCodes").length === 1 && listDrawn()); await idle();
  ok("Status → Used up asks for that status from the first page, and shows only USEDUP",
    same(of("listDiscountCodes")[0], { action: "listDiscountCodes", q: "", org: "", status: "usedUp", limit: 50, offset: 0 }) && same(rows().map(tr => text(tr.children[0])), ["USEDUP"]) && id("dcCount").textContent === "1 code");
  reset();
  pick(id("dcStatus"), "off");
  await wait(() => of("listDiscountCodes").length === 1 && listDrawn()); await idle();
  ok("Switched off shows OFFCODE", same(rows().map(tr => text(tr.children[0])), ["OFFCODE"]));
  reset();
  pick(id("dcStatus"), "all"); await idle();
  reset();
  pick(id("dcShop"), "band");
  await wait(() => of("listDiscountCodes").length === 1 && listDrawn()); await idle();
  ok("Shop → the band asks for its codes (its own and every-shop ones), not the club's",
    of("listDiscountCodes")[0].org === "band" && rows().some(tr => text(tr.children[0]) === "PAT-ONE") && rows().some(tr => text(tr.children[0]) === "SAVE10") && !rows().some(tr => text(tr.children[0]) === "FIVEOFF"));
  reset();
  await go();
  ok("drawn again (left and come back), the Shop filter still has the band chosen and asks for its codes",
    id("dcShop").value === "band" && id("dcShop").querySelector('option[value="band"]').hasAttribute("selected") && of("listDiscountCodes").pop().org === "band");
  reset();
  pick(id("dcShop"), ""); await idle();
  reset();
  type(id("dcQ"), "  sav");
  await pause(80);
  ok("typing in Search asks nothing at once", of("listDiscountCodes").length === 0);
  type(id("dcQ"), "  save10 ");
  await pause(120);
  ok("…nor while typing goes on", of("listDiscountCodes").length === 0);
  await wait(() => of("listDiscountCodes").length === 1); await idle();
  ok("…then, after the pause, one request with what was typed, trimmed, from the first page",
    of("listDiscountCodes").length === 1 && same(of("listDiscountCodes")[0], { action: "listDiscountCodes", q: "save10", org: "", status: "all", limit: 50, offset: 0 }) && same(rows().map(tr => text(tr.children[0])), ["SAVE10"]));
  reset();
  type(id("dcQ"), "example.com"); await wait(() => of("listDiscountCodes").length === 1); await idle();
  ok("search matches an email too", same(rows().map(tr => text(tr.children[0])), ["PAT-ONE"]));
  type(id("dcQ"), "nothing-like-it"); await wait(() => /No code matches/.test(text(id("dcBody")))); await idle();
  ok("nothing matching: “No code matches.”, no count, no pager", text(id("dcBody")) === "No code matches." && id("dcCount").textContent === "" && id("dcPager").innerHTML === "");
  await go();
  ok("leaving and coming back keeps the search (the view is kept while the admin is open)", id("dcQ").value === "nothing-like-it" && of("listDiscountCodes").pop().q === "nothing-like-it");
  type(id("dcQ"), ""); await wait(() => rows().length === 6); await idle();
  { const fake = Array.from({ length: 3 }, (_, i) => ({ id: 900 + i, code: "X" + i, kind: "percent", percent: 1, label: "1% off", orgId: null, email: "", maxUses: 1, used: 0, status: "active" }));
    // An input event from anywhere but the search box asks nothing.
    reset(); fire(id("dcStatus"), "input"); await pause(300);
    ok("an input event from another field asks nothing", of("listDiscountCodes").length === 0);
    scripted.push({ action: "listDiscountCodes", body: { status: "ok", codes: fake } });
    await go();
    ok("an answer without a total counts the codes it has", id("dcCount").textContent === "3 codes"); }
  scripted.push({ action: "listDiscountCodes", body: { status: "ok", total: 0 } });
  await go();
  ok("an answer without a codes list is an empty list", text(id("dcBody")) === "No discount codes yet. Make one with “+ New code”.");
  scripted.push({ action: "listDiscountCodes", status: 503, body: { status: "error", message: "Discount codes aren't <ready> yet." } });
  await go();
  ok("the server refuses: its message in place of the list, as text", text(id("dcBody")) === "Discount codes aren't <ready> yet." && !!id("dcBody").querySelector(".cust-err[role=alert]") && !id("dcBody").querySelector("ready") && id("dcCount").textContent === "");

  console.log("\n=== Paging ===");
  { // 55 more codes (single use, for a list of addresses), all with one prefix.
    const emails = Array.from({ length: 55 }, (_, i) => `p${String(i).padStart(2, "0")}@example.com`);
    const r = await must({ action: "createDiscountCodes", emails, prefix: "BULK-", kind: "amount", amount: 1 });
    ok("(55 codes made for the paging)", r.codes.length === 55); }
  await go();
  ok("61 codes: the first 50, “Showing 1–50 of 61 codes”", rows().length === 50 && id("dcCount").textContent === "Showing 1–50 of 61 codes");
  const pg = (which) => q(`#dcPager button[data-dc-page="${which}"]`);
  ok("…‹ Previous is off, Next › is on", !!pg("prev") && pg("prev").disabled && !pg("next").disabled && text(pg("prev")) === "‹ Previous" && text(pg("next")) === "Next ›");
  reset(); pg("next").click();
  await wait(() => of("listDiscountCodes").length === 1 && listDrawn()); await idle();
  ok("Next › asks for offset 50 and shows 51–61, Next now off", of("listDiscountCodes")[0].offset === 50 && rows().length === 11 && id("dcCount").textContent === "Showing 51–61 of 61 codes" &&
    !pg("prev").disabled && pg("next").disabled && rowOf("OLDCODE"));
  reset(); pg("prev").click();
  await wait(() => of("listDiscountCodes").length === 1 && listDrawn()); await idle();
  ok("‹ Previous goes back to offset 0", of("listDiscountCodes")[0].offset === 0 && rows().length === 50);
  pg("next").click(); await wait(() => rows().length === 11); await idle();
  reset();
  pick(id("dcStatus"), "active"); await wait(() => of("listDiscountCodes").length === 1 && listDrawn()); await idle();
  ok("a filter changed on page 2 starts again at the first page", of("listDiscountCodes")[0].offset === 0);
  pick(id("dcStatus"), "all"); await idle();
  pg("next").click(); await wait(() => rows().length === 11); await idle();
  // The second page empties under it (its codes deleted elsewhere): drawn again, it goes back to the first.
  const keep = d1.q("SELECT * FROM discount_codes WHERE code NOT LIKE 'BULK-%'");
  d1.q("DELETE FROM discount_codes WHERE code LIKE 'BULK-%' AND id NOT IN (SELECT id FROM discount_codes WHERE code LIKE 'BULK-%' ORDER BY id DESC LIMIT 44)");
  reset();
  await go();
  ok("a page that's gone empty (its codes deleted) goes back to the first page by itself",
    same(of("listDiscountCodes").map(b => b.offset), [50, 0]) && w.eval("_dcView.offset") === 0 && rows().length === 50 && id("dcCount").textContent === "50 codes" && id("dcPager").innerHTML.trim() === "");
  d1.q("DELETE FROM discount_codes WHERE code LIKE 'BULK-%'");
  ok("(the paging codes gone again)", keep.length === 6);
  await go();
  ok("6 codes on one page: no pager", rows().length === 6 && id("dcPager").innerHTML.trim() === "");

  console.log("\n=== A slower, older answer is never drawn over a newer one ===");
  { let release; hold = { action: "listDiscountCodes", gate: new Promise(r => { release = r; }) };
    reset();
    pick(id("dcStatus"), "off");
    await wait(() => of("listDiscountCodes").length === 1);
    pick(id("dcStatus"), "expired");
    await wait(() => of("listDiscountCodes").length === 2 && rows().length === 1); await idle();
    ok("the newer answer (Expired) is drawn", same(rows().map(tr => text(tr.children[0])), ["OLDCODE"]));
    release(); await pause(50); await idle();
    ok("…and when the older one (Switched off) arrives late it is dropped", same(rows().map(tr => text(tr.children[0])), ["OLDCODE"])); }
  { let fail; hold = { action: "listDiscountCodes", gate: new Promise((_, rej) => { fail = rej; }) };
    reset();
    pick(id("dcStatus"), "off");
    await wait(() => of("listDiscountCodes").length === 1);
    pick(id("dcStatus"), "all");
    await wait(() => of("listDiscountCodes").length === 2 && rows().length === 6); await idle();
    fail(new Error("offline")); await pause(50); await idle();
    ok("an older request that fails after a newer answer was drawn shows no error over it", rows().length === 6 && !id("dcBody").querySelector(".cust-err")); }
  { let release; hold = { action: "listDiscountCodes", gate: new Promise(r => { release = r; }) };
    reset();
    pick(id("dcStatus"), "off");
    await wait(() => of("listDiscountCodes").length === 1);
    w.location.hash = "#home";
    await wait(() => !page()); await idle();
    release(); await pause(50); await idle();
    ok("an answer that arrives after leaving the page draws nothing", !page() && !id("dcBody")); }
  { let fail; hold = { action: "listDiscountCodes", gate: new Promise((_, rej) => { fail = rej; }) };
    reset();
    w.location.hash = "#discounts";
    await wait(() => of("listDiscountCodes").length === 1);
    const before = page();
    w.location.hash = "#home";
    await wait(() => !page()); await idle();
    fail(new Error("offline")); await pause(50); await idle();
    ok("…nor does one that fails after leaving", !before.isConnected && !page() && !q(".cust-err")); }
  w.eval('_dcView.status = "all";');
  await go();

  // ==============================================================================================================
  console.log("\n=== Opening a code ===");
  // ==============================================================================================================
  const win = () => { const m = modal(); return m && m.querySelector("#dcForm") ? m : null; };
  const $ = (sel) => win() && win().querySelector(sel);
  const openRow = async (code, how) => {
    const tr = rowOf(code);
    if (how === "cell") tr.children[2].click(); else tr.children[0].querySelector("a").dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true }));
    await wait(() => !!win()); await idle(); return win();
  };
  reset();
  await openRow("SAVE10", "cell");
  ok("a click anywhere on a row opens that code, asking the server for it (with its orders)", !!win() && same(of("getDiscountCode"), [{ action: "getDiscountCode", id: cSave.id }]));
  $("#dcCancel").click(); await wait(() => !win());
  ok("Cancel closes it (nothing typed: nothing asked)", !win() && !confirmBox());
  reset();
  await openRow("SAVE10", "link");
  ok("the code's link opens it too, and the address stays #discounts", !!win() && of("getDiscountCode").length === 1 && hashNow() === "discounts");
  $("#dcCancel").click(); await wait(() => !win());
  { // A click on the pager or other controls doesn't open anything; a click outside rows neither.
    reset(); id("dcCount").click(); await pause(30);
    ok("a click outside the rows opens nothing", !win() && of("getDiscountCode").length === 0); }

  console.log("\n=== A used code (SAVE10): its window ===");
  reset();
  await openRow("SAVE10");
  ok("titled “Discount code SAVE10”", text(win().querySelector("[data-dialog-title]")) === "Discount code SAVE10");
  ok("under it: its status, value, uses, when and by whom it was made",
    text(win().querySelector(".dc-sub")) === "Active 10% off · used 2 of 50 · made " + day(codeRow("SAVE10").createdAt) + " by owner@example.test");
  ok("the line saying why most of it is locked", text(win().querySelector(".dc-locked")) === "This code has been used, so only its expiry, uses, note and on/off can change. To offer a different discount, make a new code.");
  ok("locked: the code, the discount, the shop, who can use it, the email and once-per-email; no “Make one”",
    $("#dcCode").disabled && $("#dcKind").disabled && $("#dcValue").disabled && $("#dcOrg").disabled && [...win().querySelectorAll('input[name="dcWho"]')].every(r => r.disabled) && $("#dcEmail").disabled && $("#dcOnce").disabled && !$("#dcMake"));
  ok("open: Uses in all (no lower than the uses so far), Expires, Note, Active",
    !$("#dcMax").disabled && $("#dcMax").min === "2" && $("#dcMax").max === "100000" && !$("#dcExpires").disabled && !$("#dcNote").disabled && !$("#dcActive").disabled);
  ok("filled in: SAVE10, Percent off 10, All shops, Anyone, 50, no expiry, the note, Active ticked",
    $("#dcCode").value === "SAVE10" && $("#dcKind").value === "percent" && $("#dcValue").value === "10" && text($("#dcValueLabel")) === "Percent (%)" && $("#dcOrg").value === "" &&
    win().querySelector('input[name="dcWho"]:checked').value === "any" && $("#dcMax").value === "50" && $("#dcExpires").value === "" && $("#dcNote").value === "Spring" && $("#dcActive").checked && !$("#dcOnce").checked);
  ok("only the Anyone fields show; the email box is hidden", win().querySelector('[data-dc-for="one"]').hidden && !win().querySelector('[data-dc-for="any"]').hidden);
  ok("no Delete (it has been used); Cancel and Save", !$("#dcDelete") && text($("#dcCancel")) === "Cancel" && text($("#dcSave")) === "Save" && !off($("#dcSave")));
  const usesRows = () => qa(".admin-modal table.dc-uses tbody tr");
  ok("“Orders (3)”: its uses, newest first, the given-back one too",
    [...win().querySelectorAll("h4.dc-h")].some(h => text(h) === "Orders (3)") && same(usesRows().map(tr => text(tr.children[0])), ["CLUB-3", "CLUB-2", "CLUB-1"]));
  ok("…columns: Order, Customer, Email, Discount, Used, and the given-back tag", same(qa(".admin-modal table.dc-uses thead th").map(th => th.textContent), ["Order", "Customer", "Email", "Discount", "Used", ""]));
  ok("a use: the order, the customer, the email, $4.00 and the day", same(cellsOf(usesRows()[2]), ["CLUB-1", "Pat Example", "pat@example.com", "$4.00", day(ago(5)), ""]));
  { const tag = usesRows()[1].querySelector(".cust-tag");
    ok("the voided order's use: “Given back”, saying when on hover, its row greyed; the customer's name as text",
      !!tag && text(tag) === "Given back" && tag.title === "The order was voided or deleted on " + day(ago(3)) + ", so this use no longer counts" && usesRows()[1].classList.contains("cust-row-archived") &&
      text(usesRows()[1].children[1]) === ROBIN && !win().querySelector("table.dc-uses img") && w.__xss334 === undefined); }
  ok("each order is a link to its shop's orders", usesRows().every(tr => { const a = tr.children[0].querySelector("a[data-dc-order]"); return a && a.getAttribute("href") === "#orders/club"; }));

  // Save's refusals on a used code
  type($("#dcMax"), "1");
  reset();
  fire($("#dcForm"), "submit"); await idle();
  ok("fewer uses in all than it has had: “It has been used 2 times already, so it can't allow fewer.”, nothing sent",
    text($("#dcErr")) === "It has been used 2 times already, so it can't allow fewer." && sent.length === 0);
  for (const bad of ["", "0", "1.5", "100001"]) {
    type($("#dcMax"), bad); fire($("#dcForm"), "submit"); await idle();
    if (!ok("uses in all of “" + bad + "”: “Enter how many times it can be used in all, from 1 to 100,000.”", text($("#dcErr")) === "Enter how many times it can be used in all, from 1 to 100,000." && sent.length === 0)) break;
  }
  type($("#dcMax"), "60"); type($("#dcExpires"), "2999-06-30"); type($("#dcNote"), "  Spring <again>  ");
  reset();
  fire($("#dcForm"), "submit");
  await wait(() => !win()); await idle();
  ok("Save sends saveDiscountCode with the whole code as it was, the new uses, expiry and note (trimmed), and Active",
    same(of("saveDiscountCode"), [{ action: "saveDiscountCode", code: { code: "SAVE10", kind: "percent", percent: 10, amount: null, maxDiscount: null, orgId: null, email: "", maxUses: 60, oncePerEmail: false, expiresOn: "2999-06-30", note: "Spring <again>", id: cSave.id, active: true } }]) &&
    of("setDiscountCodeActive").length === 0);
  ok("…the server keeps it, the window closes, “Code SAVE10 saved.”, and the list is asked for again",
    codeRow("SAVE10").maxUses === 60 && codeRow("SAVE10").expiresOn === "2999-06-30" && codeRow("SAVE10").note === "Spring <again>" && lastToast().m === "Code SAVE10 saved." && !lastToast().err && of("listDiscountCodes").length === 1 &&
    cellsOf(rowOf("SAVE10"))[4] === "2 of 60");

  console.log("\n=== Only Active changed: the switch, not a save ===");
  await openRow("SAVE10");
  tick($("#dcActive"), false);
  reset();
  fire($("#dcForm"), "submit");
  await wait(() => !win()); await idle();
  ok("unticking Active alone sends setDiscountCodeActive { id, active: false }, no saveDiscountCode",
    same(of("setDiscountCodeActive"), [{ action: "setDiscountCodeActive", id: cSave.id, active: false }]) && of("saveDiscountCode").length === 0);
  ok("…“Code SAVE10 switched off.”, and the list shows it off", lastToast().m === "Code SAVE10 switched off." && codeRow("SAVE10").active === 0 && cellsOf(rowOf("SAVE10"))[6] === "Switched off");
  await openRow("SAVE10");
  ok("opened again: “Switched off”, Active unticked", !$("#dcActive").checked && /^Switched off/.test(text(win().querySelector(".dc-sub"))));
  tick($("#dcActive"), true);
  reset();
  fire($("#dcForm"), "submit");
  await wait(() => !win()); await idle();
  ok("ticking it again: setDiscountCodeActive active: true, “Code SAVE10 switched on.”", same(of("setDiscountCodeActive").map(b => b.active), [true]) && lastToast().m === "Code SAVE10 switched on." && codeRow("SAVE10").active === 1);
  await openRow("SAVE10");
  tick($("#dcActive"), false); type($("#dcNote"), "Spring");
  reset();
  fire($("#dcForm"), "submit");
  await wait(() => !win()); await idle();
  ok("Active and the note changed together: one saveDiscountCode with active: false, no switch",
    of("saveDiscountCode").length === 1 && of("saveDiscountCode")[0].code.active === false && of("saveDiscountCode")[0].code.note === "Spring" && of("setDiscountCodeActive").length === 0 &&
    lastToast().m === "Code SAVE10 saved." && codeRow("SAVE10").active === 0);
  await must({ action: "setDiscountCodeActive", id: cSave.id, active: true });
  await openRow("SAVE10");
  reset();
  fire($("#dcForm"), "submit");
  await wait(() => !win()); await idle();
  ok("nothing changed at all: Save still saves (the whole code), not the switch", of("saveDiscountCode").length === 1 && of("setDiscountCodeActive").length === 0);
  await go();

  console.log("\n=== The orders' links ===");
  await openRow("SAVE10");
  w.eval("window._orderView.includeCancelled = false;");
  usesRows()[0].querySelector("a").dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true }));
  await wait(() => hashNow() === "orders/club" && !!q('#app tr[data-order="CLUB-3"]'), 1500); await idle();
  ok("an order's link closes the window and opens its shop's orders with the order in the list",
    !win() && hashNow() === "orders/club" && !!q('#app tr[data-order="CLUB-3"]') && !toasts.some(t => /isn't in this list/.test(t.m)) && w.eval("window._orderView.includeCancelled") === false);
  await go();
  await openRow("SAVE10");
  usesRows()[1].querySelector("a").dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true }));
  await wait(() => hashNow() === "orders/club" && !!q('#app tr[data-order="CLUB-2"]'), 1500); await idle();
  ok("a given-back use's order (voided) is opened with “Include cancelled” ticked, so it is in the list",
    w.eval("window._orderView.includeCancelled") === true && !!q('#app tr[data-order="CLUB-2"]'));
  w.eval("window._orderView.includeCancelled = false;");
  await go();
  await openRow("USEDUP");
  ok("a use whose order is gone (no shop) is the order id as text, no link", usesRows().length === 1 && text(usesRows()[0].children[0]) === "GONE-9" && !usesRows()[0].querySelector("a") &&
    text(usesRows()[0].children[1]) === "");
  $("#dcCancel").click(); await wait(() => !win());
  signInWith(Object.fromEntries(Object.entries(levelsOf("admin")).map(([k, v]) => [k, /^orders\./.test(k) ? "none" : v])));
  await openRow("SAVE10");
  ok("a role that can't open Orders sees the order ids as text", !w.adminCanOpen_("orders") && usesRows().length === 3 && !win().querySelector("table.dc-uses a") && text(usesRows()[0].children[0]) === "CLUB-3");
  $("#dcCancel").click(); await wait(() => !win());
  asRoles("admin");
  { // A click on the uses table that isn't a link does nothing.
    await openRow("SAVE10");
    usesRows()[0].children[1].click(); await pause(20);
    ok("a click on the uses table off the links leaves the window open", !!win() && hashNow() === "discounts");
    $("#dcCancel").click(); await wait(() => !win()); }

  console.log("\n=== One person's unused code (PAT-ONE) ===");
  await openRow("PAT-ONE");
  ok("nothing locked, no locked line, “Make one” there", !win().querySelector(".dc-locked") && !$("#dcCode").disabled && !$("#dcKind").disabled && !$("#dcOrg").disabled && !!$("#dcMake"));
  ok("filled in: One person, their email, the band chosen (named as text), 15 percent", win().querySelector('input[name="dcWho"]:checked').value === "one" && $("#dcEmail").value === "pat@example.com" &&
    $("#dcOrg").value === "band" && $("#dcValue").value === "15" && !$("#dcOrg").querySelector("b") && $("#dcMax").value === "");
  ok("the note that looks like HTML is in its box as typed", $("#dcNote").value === '"><b>vip</b>' && !win().querySelector("form b"));
  ok("only the email box shows", !win().querySelector('[data-dc-for="one"]').hidden && win().querySelector('[data-dc-for="any"]').hidden);
  ok("“Not used yet.” in place of the orders, “Orders (0)”", [...win().querySelectorAll("h4.dc-h")].some(h => text(h) === "Orders (0)") && /Not used yet\./.test(text(win())) && !win().querySelector("table.dc-uses"));
  ok("Delete is there for an admin (Full), needing Full", !!$("#dcDelete") && $("#dcDelete").getAttribute("data-need") === "discounts.codes:full" && text($("#dcDelete")) === "Delete");
  // Who can use it: switching
  const who = (v) => { const r = win().querySelector(`input[name="dcWho"][value="${v}"]`); r.checked = true; fire(r, "change"); };
  who("any");
  ok("choosing Anyone shows Uses in all and Once per email, hides the email", win().querySelector('[data-dc-for="one"]').hidden && !win().querySelector('[data-dc-for="any"]').hidden);
  reset();
  fire($("#dcForm"), "submit"); await idle();
  ok("…Save with no uses in all: refused, nothing sent", text($("#dcErr")) === "Enter how many times it can be used in all, from 1 to 100,000." && sent.length === 0);
  who("one");
  type($("#dcEmail"), "not-an-email");
  fire($("#dcForm"), "submit"); await idle();
  ok("One person with an address that isn't one: “Enter the email address of the person it's for.”", text($("#dcErr")) === "Enter the email address of the person it's for." && sent.length === 0);
  // Kind switch
  pick($("#dcKind"), "amount");
  ok("Amount off relabels the box “Amount ($)” and lets it go to 10000", text($("#dcValueLabel")) === "Amount ($)" && $("#dcValue").max === "10000");
  pick($("#dcKind"), "percent");
  ok("…Percent off back to “Percent (%)”, up to 100", text($("#dcValueLabel")) === "Percent (%)" && $("#dcValue").max === "100");
  // Delete
  reset();
  $("#dcDelete").click();
  let asked = await answer(false);
  ok("Delete asks first, saying nobody has used it and how to stop it for now instead",
    asked.message === "Delete PAT-ONE?\n\nNobody has used it yet. Once deleted it can't be used or brought back. To stop it for now instead, untick Active." && asked.okLabel === "Delete");
  ok("…No: nothing is sent, the window stays", sent.length === 0 && !!win() && !!codeRow("PAT-ONE"));
  scripted.push({ action: "deleteDiscountCode", status: 409, body: { status: "error", message: "Someone <used> it just now." } });
  $("#dcDelete").click(); await answer(true); await idle();
  ok("the server refuses: its message in the window, as text, and Delete can be pressed again", text($("#dcErr")) === "Someone <used> it just now." && !$("#dcErr").querySelector("used") && $("#dcDelete").disabled === false && !!codeRow("PAT-ONE"));
  reset();
  $("#dcDelete").click(); await answer(true);
  await wait(() => !win()); await idle();
  ok("Yes: deleteDiscountCode { id }, the window closes, “Code PAT-ONE deleted.”, gone from the list",
    same(of("deleteDiscountCode"), [{ action: "deleteDiscountCode", id: cPat.id }]) && !codeRow("PAT-ONE") && lastToast().m === "Code PAT-ONE deleted." && !rowOf("PAT-ONE") && of("listDiscountCodes").length === 1);

  console.log("\n=== Delete needs Full ===");
  signInWith(withLevels("admin", { "discounts.codes": "edit" }));
  await go();
  await openRow("OFFCODE");
  ok("Edit on Discount codes: an unused code's window has no Delete, but Save is there", !$("#dcDelete") && !!$("#dcSave") && !off($("#dcSave")));
  $("#dcCancel").click(); await wait(() => !win());
  asRoles("admin");

  console.log("\n=== A used amount code for anyone, once per email (FIVEOFF) ===");
  await go();
  await openRow("FIVEOFF");
  ok("Anyone, with Once per email address ticked (and locked: it has been used), $5.00 off",
    win().querySelector('input[name="dcWho"]:checked').value === "any" && $("#dcOnce").checked && $("#dcOnce").disabled && $("#dcKind").value === "amount" && $("#dcValue").value === "5.00" && $("#dcMax").value === "3");
  tick($("#dcActive"), false);
  reset();
  fire($("#dcForm"), "submit");
  await wait(() => !win()); await idle();
  ok("an amount code with only Active unticked: setDiscountCodeActive, no saveDiscountCode, “Code FIVEOFF switched off.”",
    same(of("setDiscountCodeActive"), [{ action: "setDiscountCodeActive", id: cFive.id, active: false }]) && of("saveDiscountCode").length === 0 &&
    lastToast().m === "Code FIVEOFF switched off." && codeRow("FIVEOFF").active === 0);
  await must({ action: "setDiscountCodeActive", id: cFive.id, active: true });

  console.log("\n=== A used code for one person: Save keeps its email ===");
  const cJo = await mk({ code: "JO-ONLY", kind: "amount", amount: 4, email: "jo@example.com" });
  use(cJo.id, "JO-1", "jo@example.com", 400, ago(1));
  await go();
  await openRow("JO-ONLY");
  ok("One person, the email locked", win().querySelector('input[name="dcWho"]:checked').value === "one" && $("#dcEmail").disabled && $("#dcEmail").value === "jo@example.com" && !!win().querySelector(".dc-locked"));
  type($("#dcExpires"), "2999-01-31");
  reset();
  fire($("#dcForm"), "submit");
  await wait(() => !win()); await idle();
  ok("Save sends the code's own email and single use, and the server takes it (only the expiry changed)",
    of("saveDiscountCode").length === 1 && of("saveDiscountCode")[0].code.email === "jo@example.com" && of("saveDiscountCode")[0].code.maxUses === 1 &&
    lastToast().m === "Code JO-ONLY saved." && codeRow("JO-ONLY").expiresOn === "2999-01-31" && codeRow("JO-ONLY").email === "jo@example.com");
  d1.q("DELETE FROM discount_code_uses WHERE codeId = ?", cJo.id); d1.q("DELETE FROM discount_codes WHERE id = ?", cJo.id);

  console.log("\n=== A code for a shop the admin's list doesn't have ===");
  const cBand = await mk({ code: "BANDONLY", kind: "percent", percent: 5, maxUses: 2, orgId: "band" });
  setShops([shopList[0]]);
  await go();
  await openRow("BANDONLY");
  ok("its shop is still chosen, named by its id", $("#dcOrg").value === "band" && text($("#dcOrg").selectedOptions[0]) === "band" && [...$("#dcOrg").options].length === 3);
  reset();
  fire($("#dcForm"), "submit");
  await wait(() => !win()); await idle();
  ok("…so Save keeps the code's shop rather than making it every shop's", of("saveDiscountCode").length === 1 && of("saveDiscountCode")[0].code.orgId === "band" && codeRow("BANDONLY").orgId === "band");
  d1.q("DELETE FROM discount_codes WHERE id = ?", cBand.id);
  setShops(shopList);
  await go();

  console.log("\n=== When the code can't be had ===");
  scripted.push({ action: "getDiscountCode", body: { status: "ok" } });
  reset();
  rowOf("OFFCODE").children[0].querySelector("a").dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true }));
  await wait(() => toasts.length > 0); await idle();
  ok("an answer without the code: “That code is gone — it may have been deleted.”, no window, the list asked for again",
    lastToast().m === "That code is gone — it may have been deleted." && lastToast().err && !win() && of("listDiscountCodes").length === 1);
  scripted.push({ action: "getDiscountCode", status: 404, body: { status: "error", message: "Discount code not found" } });
  reset();
  rowOf("OFFCODE").children[0].querySelector("a").dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true }));
  await wait(() => toasts.length > 0); await idle();
  ok("the server says it isn't there: its message, no window", lastToast().m === "Discount code not found" && lastToast().err && !win() && of("listDiscountCodes").length === 0);
  scripted.push({ action: "getDiscountCode", body: { status: "ok", code: Object.assign({}, cOff, { used: 0, status: "off", label: "5% off", uses: undefined }), uses: [{ orderId: "OLD-SHAPE", orgId: null, amount: 1, usedAt: ago(1) }] } });
  rowOf("OFFCODE").children[0].querySelector("a").dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true }));
  await wait(() => !!win()); await idle();
  ok("uses sent beside the code (not inside it) are listed too", usesRows().length === 1 && text(usesRows()[0].children[0]) === "OLD-SHAPE");
  $("#dcCancel").click(); await wait(() => !win());

  // ==============================================================================================================
  console.log("\n=== A new code ===");
  // ==============================================================================================================
  const openNew = async () => { id("dcNew").click(); await wait(() => !!win()); return win(); };
  reset();
  await openNew();
  ok("“+ New code” opens “New discount code” without asking the server", text(win().querySelector("[data-dialog-title]")) === "New discount code" && sent.length === 0);
  ok("…empty: the code (blank = make one), Percent off, All shops, Anyone, no Active tick, no orders, no Delete",
    $("#dcCode").value === "" && $("#dcCode").placeholder === "Blank = make one" && $("#dcCode").maxLength === 32 && $("#dcKind").value === "percent" && $("#dcValue").value === "" &&
    $("#dcOrg").value === "" && win().querySelector('input[name="dcWho"]:checked').value === "any" && !$("#dcActive") && !win().querySelector("h4.dc-h") && !$("#dcDelete") && !win().querySelector(".dc-sub"));
  ok("…Create code and Cancel", text($("#dcSave")) === "Create code" && text($("#dcCancel")) === "Cancel");
  ok("the Shop list: All shops, then each by name", same([...$("#dcOrg").options].map(o => o.value), ["", "club", "band"].sort((a, b) => !a ? -1 : !b ? 1 : (a === "club" ? "Example Club" : BAND_NAME).localeCompare(b === "club" ? "Example Club" : BAND_NAME))));
  ok("the hints: what a code may be, and that it works through its expiry day", /3–32 letters, digits, “-” or “_”\. Customers can type it in any case\./.test(text(win())) && /It works through the end of its expiry day\./.test(text(win())));
  type($("#dcCode"), "save-me");
  ok("what is typed in the code becomes capitals", $("#dcCode").value === "SAVE-ME");
  $("#dcMake").click();
  const made = $("#dcCode").value;
  ok("“Make one” fills in 8 characters from the readable alphabet (no 0/O, 1/I)", /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(made));
  $("#dcMake").click();
  ok("…a different one each time", $("#dcCode").value !== made && /^[A-Z2-9]{8}$/.test($("#dcCode").value));
  ok("dcMakeCode_ with a start: the start, capitals, only letters/digits/-/_, at most 12, then 8", /^SPRING-X_12A[A-Z2-9]{8}$/.test(w.dcMakeCode_("spring-x_12abc!!")) && /^AB[A-Z2-9]{8}$/.test(w.dcMakeCode_("a b")) && w.dcMakeCode_().length === 8);
  // The page's refusals
  const refuse = async (setup, msg, label) => { setup(); reset(); fire($("#dcForm"), "submit"); await idle(); return ok(label + ": “" + msg + "”, nothing sent", text($("#dcErr")) === msg && sent.length === 0); };
  await refuse(() => type($("#dcCode"), "AB"), "A code is 3–32 letters, digits, “-” or “_” — or leave it blank to make one.", "a code of 2 characters");
  await refuse(() => type($("#dcCode"), "SAVE 10"), "A code is 3–32 letters, digits, “-” or “_” — or leave it blank to make one.", "a code with a space");
  type($("#dcCode"), "");
  for (const v of ["", "0", "100.01", "abc", "1.234"]) await refuse(() => type($("#dcValue"), v), "Enter a percent from 0.01 to 100.", "a percent of “" + v + "”");
  pick($("#dcKind"), "amount");
  for (const v of ["", "0", "10000.01", "-1"]) await refuse(() => type($("#dcValue"), v), "Enter an amount from $0.01 to $10,000.", "an amount of “" + v + "”");
  ok("dcNum_: a number with at most two decimals, else NaN", w.dcNum_(" 12.5 ") === 12.5 && w.dcNum_("3") === 3 && Number.isNaN(w.dcNum_("1e3")) && Number.isNaN(w.dcNum_(null)) && Number.isNaN(w.dcNum_("0.123")));
  // Create: an amount off, the club, anyone, 25 uses, once per email, an expiry
  type($("#dcCode"), "club5"); type($("#dcValue"), "5"); pick($("#dcOrg"), "club"); type($("#dcMax"), "25"); tick($("#dcOnce"), true); type($("#dcExpires"), "2999-01-31"); type($("#dcNote"), " Fall ");
  reset();
  { let release; hold = { action: "saveDiscountCode", gate: new Promise(r => { release = r; }) };
    fire($("#dcForm"), "submit");
    await wait(() => of("saveDiscountCode").length === 1);
    ok("while it saves, Create code is off", $("#dcSave").disabled === true && text($("#dcErr")) === "");
    release(); }
  await wait(() => !win()); await idle();
  ok("Create code sends saveDiscountCode with no id or Active: the code, amount 5, the club, 25 uses, once per email, the expiry and the note",
    same(of("saveDiscountCode"), [{ action: "saveDiscountCode", code: { code: "CLUB5", kind: "amount", percent: null, amount: 5, maxDiscount: null, orgId: "club", email: "", maxUses: 25, oncePerEmail: true, expiresOn: "2999-01-31", note: "Fall" } }]));
  ok("…the server makes it, “Code CLUB5 created.”, and it is in the list", !!codeRow("CLUB5") && codeRow("CLUB5").amountCents === 500 && codeRow("CLUB5").oncePerEmail === 1 && lastToast().m === "Code CLUB5 created." &&
    same(cellsOf(rowOf("CLUB5")), ["CLUB5", "$5.00 off", "Example Club", "Anyone, once per email", "0 of 25", day("2999-01-31"), "Active"]));
  // One person, a blank code (the server makes it up)
  await openNew();
  who("one"); type($("#dcEmail"), "  Sam@Example.COM "); type($("#dcValue"), "12.5"); type($("#dcMax"), "");
  reset();
  fire($("#dcForm"), "submit");
  await wait(() => !win()); await idle();
  const saved = of("saveDiscountCode")[0];
  ok("one person's code: the email lower-case and trimmed, 1 use, once per email off, a blank code", same(saved, { action: "saveDiscountCode", code: { code: "", kind: "percent", percent: 12.5, amount: null, maxDiscount: null, orgId: null, email: "sam@example.com", maxUses: 1, oncePerEmail: false, expiresOn: "", note: "" } }));
  { const r = d1.q("SELECT * FROM discount_codes WHERE email = 'sam@example.com'")[0];
    ok("…the toast names the code the server made up", !!r && lastToast().m === "Code " + r.code + " created." && /^[A-Z2-9]{8}$/.test(r.code)); }
  // A code already taken
  await openNew();
  type($("#dcCode"), "save10"); type($("#dcValue"), "5"); type($("#dcMax"), "3");
  reset();
  fire($("#dcForm"), "submit"); await idle();
  ok("a code already taken: the server's message in the window, which stays, Create code on again",
    text($("#dcErr")) === "The code SAVE10 is already taken. Choose another." && !!win() && $("#dcSave").disabled === false && of("saveDiscountCode").length === 1);
  scripted.push({ action: "saveDiscountCode", throws: "offline" });
  type($("#dcCode"), "NEWONE");
  reset();
  fire($("#dcForm"), "submit"); await idle();
  ok("the server out of reach: a problem said in the window, nothing made", text($("#dcErr")) !== "" && !!win() && !codeRow("NEWONE") && $("#dcSave").disabled === false);
  scripted.push({ action: "saveDiscountCode", body: { status: "ok" } });
  reset();
  fire($("#dcForm"), "submit");
  await wait(() => !win()); await idle();
  ok("an ok answer without the code: the toast names the code that was typed", lastToast().m === "Code NEWONE created.");
  // Discard changes
  await openNew();
  type($("#dcNote"), "half typed");
  win().querySelector("[data-modal-close]").click();
  asked = await answer(false);
  ok("✕ after typing asks “Discard changes?”", /^Discard changes\?/.test(asked.message) && asked.okLabel === "Discard" && !!win() && $("#dcNote").value === "half typed");
  $("#dcCancel").click();
  await answer(true);
  ok("…Cancel asks the same, and Discard closes it", !win());

  // ==============================================================================================================
  console.log("\n=== Back office: read only ===");
  // ==============================================================================================================
  asRoles("staff");
  await go();
  ok("Back office sees the list, without “+ New code” or the bulk button", rows().length >= 6 && off(id("dcNew")) && off(id("dcBulk")));
  reset();
  await openRow("SAVE10");
  ok("…opens a code: every field locked, Save and Make one hidden, the orders listed", [...win().querySelectorAll("#dcForm input, #dcForm select")].every(f => f.disabled) && off($("#dcSave")) &&
    usesRows().length === 3 && !$("#dcDelete"));
  ok("…its one button reads Close and closes without asking", text($("#dcCancel")) === "Close" && !off($("#dcCancel")));
  reset();
  fire($("#dcForm"), "submit"); await idle();
  ok("…a submit anyway sends nothing", sent.length === 0 && !!win());
  $("#dcCancel").click(); await wait(() => !win());
  ok("…closed", !win() && !confirmBox());
  {
    reset(); await openRow("OFFCODE");
    ok("an unused code in Back office has no Make one or Delete either", off($("#dcMake")) && !$("#dcDelete"));
    $("#dcCancel").click(); await wait(() => !win()); }
  asRoles("admin");

  // ==============================================================================================================
  console.log("\n=== Codes for a list of emails ===");
  // ==============================================================================================================
  const bulk = () => { const m = modal(); return m && m.querySelector("#dcBulkForm") ? m : null; };
  const b$ = (sel) => bulk() && bulk().querySelector(sel);
  await go();
  reset();
  id("dcBulk").click(); await wait(() => !!bulk());
  ok("“Codes for a list of emails…” opens its window without asking the server", text(bulk().querySelector("[data-dialog-title]")) === "Codes for a list of emails" && sent.length === 0);
  ok("…saying each code works once, for its address, and that nothing is sent", /One single-use code for each address: it works once, and only on an order placed with that email\. Nothing is sent — copy or download the list afterwards and send the codes yourself\./.test(text(bulk())));
  ok("…the boxes: the emails, a start for each code (at most 12), the discount, the shop, expiry and note",
    !!b$("#dcEmails") && b$("#dcPrefix").maxLength === 12 && b$("#dcPrefix").placeholder === "e.g. SPRING-" && b$("#dcKind").value === "percent" && b$("#dcOrg").value === "" && !!b$("#dcExpires") && b$("#dcNote").maxLength === 200 &&
    text(b$("#dcSave")) === "Make codes");
  type(b$("#dcEmails"), "Pat@Example.com, sam@example.com\n\npat@example.com;lee@example.com  not-an-email");
  ok("the count: the addresses, each once whatever its case (“4 addresses”)", b$("#dcEmailCount").textContent === "4 addresses");
  type(b$("#dcEmails"), "one@example.com");
  ok("…“1 address”", b$("#dcEmailCount").textContent === "1 address");
  type(b$("#dcEmails"), " \n , ");
  ok("…nothing for none", b$("#dcEmailCount").textContent === "");
  type(b$("#dcPrefix"), "spring-");
  ok("the start becomes capitals", b$("#dcPrefix").value === "SPRING-");
  const bRefuse = async (msg, label) => { reset(); fire(b$("#dcBulkForm"), "submit"); await idle(); return ok(label + ": “" + msg + "”, nothing sent", text(b$("#dcErr")) === msg && sent.length === 0); };
  await bRefuse("Paste at least one email address.", "no addresses");
  type(b$("#dcEmails"), Array.from({ length: 501 }, (_, i) => `m${i}@example.com`).join("\n"));
  ok("501 addresses are counted", b$("#dcEmailCount").textContent === "501 addresses");
  await bRefuse("That's 501 addresses; make at most 500 at a time.", "501 addresses");
  type(b$("#dcEmails"), Array.from({ length: 500 }, (_, i) => `m${i}@example.com`).join("\n") + "\nM0@example.com");
  ok("(500 different addresses and a repeat count as 500)", b$("#dcEmailCount").textContent === "500 addresses");
  type(b$("#dcEmails"), "Pat@Example.com, sam@example.com\npat@example.com;lee@example.com  not-an-email");
  type(b$("#dcPrefix"), "SP!");
  await bRefuse("The start of the code can only have letters, digits, “-” or “_”.", "a start with “!”");
  type(b$("#dcPrefix"), "spring-");
  await bRefuse("Enter a percent from 0.01 to 100.", "no percent");
  pick(b$("#dcKind"), "amount");
  ok("Amount off relabels the bulk window's box too", text(b$("#dcValueLabel")) === "Amount ($)" && b$("#dcValue").max === "10000");
  type(b$("#dcValue"), "10001");
  await bRefuse("Enter an amount from $0.01 to $10,000.", "an amount over $10,000");
  type(b$("#dcValue"), "7.5"); pick(b$("#dcOrg"), "club"); type(b$("#dcExpires"), "2999-03-31"); type(b$("#dcNote"), "  List one  ");
  scripted.push({ action: "createDiscountCodes", status: 400, body: { status: "error", message: "Not <now>." } });
  reset();
  fire(b$("#dcBulkForm"), "submit"); await idle();
  ok("the server refuses: its message, as text; Make codes on again; the list not asked for", text(b$("#dcErr")) === "Not <now>." && !b$("#dcErr").querySelector("now") && b$("#dcSave").disabled === false && of("listDiscountCodes").length === 0);
  reset();
  fire(b$("#dcBulkForm"), "submit");
  await wait(() => !b$("#dcBulkForm") || b$("#dcBulkForm").hidden); await idle();
  ok("Make codes sends createDiscountCodes: the addresses (lower-case, each once), the start, amount 7.5, the club, the expiry and the note trimmed",
    same(of("createDiscountCodes"), [{ action: "createDiscountCodes", emails: ["pat@example.com", "sam@example.com", "lee@example.com", "not-an-email"], prefix: "SPRING-", kind: "amount", percent: null, amount: 7.5, maxDiscount: null, org: "club", expiresOn: "2999-03-31", note: "List one" }]));
  const doneEl = () => b$("#dcBulkDone");
  const madeRows = () => [...doneEl().querySelectorAll("table")][0].querySelectorAll("tbody tr");
  ok("…the form gives way to the result: “3 codes made. 1 address was skipped (below). Each works once, for its own email address.”",
    b$("#dcBulkForm").hidden && !doneEl().hidden && text(doneEl().querySelector("#dcBulkSaid")) === "3 codes made. 1 address was skipped (below). Each works once, for its own email address.");
  const madeList = [...madeRows()].map(tr => [text(tr.children[0]), text(tr.children[1])]);
  ok("…each email and its code, the codes starting SPRING-", madeList.length === 3 && same(madeList.map(r => r[0]), ["pat@example.com", "sam@example.com", "lee@example.com"]) && madeList.every(r => /^SPRING-[A-Z2-9]{8}$/.test(r[1])) &&
    madeList.every(r => !!codeRow(r[1]) && codeRow(r[1]).email === r[0] && codeRow(r[1]).amountCents === 750 && codeRow(r[1]).orgId === "club"));
  ok("…“Skipped” with the address and why", [...doneEl().querySelectorAll("h4.dc-h")].some(h => text(h) === "Skipped") &&
    same([...[...doneEl().querySelectorAll("table")][1].querySelectorAll("tbody tr")].map(tr => cellsOf(tr)), [["not-an-email", "Not an email address."]]));
  ok("…and the list behind it is asked for again", of("listDiscountCodes").length === 1);
  ok("the result's buttons: Copy as CSV, Download CSV, Done", text(b$("#dcCopyCsv")) === "Copy as CSV" && text(b$("#dcDownloadCsv")) === "Download CSV" && text(b$("#dcBulkClose")) === "Done");
  const csvWanted = "email,code\r\n" + madeList.map(r => r[0] + "," + r[1]).join("\r\n") + "\r\n";
  reset();
  b$("#dcCopyCsv").click(); await pause(20);
  ok("Copy as CSV puts “email,code” and a line each on the clipboard, and says so", same(clipboard, [csvWanted]) && lastToast().m === "Copied 3 codes." && !lastToast().err);
  clipboardFails = true; reset();
  b$("#dcCopyCsv").click(); await pause(20);
  ok("…a browser that won't copy: “Couldn't copy — use Download CSV instead.”", lastToast().m === "Couldn't copy — use Download CSV instead." && lastToast().err);
  clipboardFails = false;
  reset();
  b$("#dcDownloadCsv").click(); await pause(20);
  ok("Download CSV hands over discount-codes-<today>.csv with the same lines", downloads.length === 1 && downloads[0].name === "discount-codes-" + w.localToday_() + ".csv" && (await blobText(downloads[0].blob)) === csvWanted);
  bulk().querySelector("[data-modal-close]").click(); await pause(30);
  ok("once made, ✕ closes without asking about discarding", !bulk() && !confirmBox());
  // All skipped
  id("dcBulk").click(); await wait(() => !!bulk());
  type(b$("#dcEmails"), "pat@example.com"); type(b$("#dcValue"), "5");
  scripted.push({ action: "createDiscountCodes", body: { status: "ok", codes: [], skipped: [{ email: "<b>x</b>@example.com" }] } });
  reset();
  fire(b$("#dcBulkForm"), "submit");
  await wait(() => b$("#dcBulkForm").hidden); await idle();
  ok("every address skipped: “0 codes made. 1 address was skipped”, no Copy or Download, the address as text, no reason left blank",
    /^0 codes made\. 1 address was skipped \(below\)\./.test(text(b$("#dcBulkSaid"))) && !b$("#dcCopyCsv") && !b$("#dcDownloadCsv") && doneEl().querySelectorAll("table").length === 1 &&
    same(cellsOf(doneEl().querySelector("table tbody tr")), ["<b>x</b>@example.com", ""]) && !doneEl().querySelector("table b"));
  b$("#dcBulkClose").click(); await pause(20);
  ok("Done closes it", !bulk());
  id("dcBulk").click(); await wait(() => !!bulk());
  type(b$("#dcEmails"), "pat@example.com, sam@example.com"); type(b$("#dcValue"), "5");
  scripted.push({ action: "createDiscountCodes", body: { status: "ok" } });
  fire(b$("#dcBulkForm"), "submit");
  await wait(() => b$("#dcBulkForm").hidden); await idle();
  ok("an answer with no lists: “0 codes made.” and nothing skipped", /^0 codes made\. Each works once/.test(text(b$("#dcBulkSaid"))) && !doneEl().querySelector("table"));
  b$("#dcBulkClose").click(); await pause(20);
  id("dcBulk").click(); await wait(() => !!bulk());
  type(b$("#dcEmails"), "x@example.com");
  bulk().querySelector("[data-modal-close]").click();
  asked = await answer(false);
  ok("closing the bulk window with something typed asks first", /^Discard changes\?/.test(asked.message) && !!bulk());
  b$("#dcCancel").click(); await answer(true);
  ok("…Discard closes it", !bulk());
  { // A single made code: “1 code made.” with no skipped part, “Copied 1 code.”
    id("dcBulk").click(); await wait(() => !!bulk());
    type(b$("#dcEmails"), "solo@example.com"); type(b$("#dcValue"), "5");
    fire(b$("#dcBulkForm"), "submit");
    await wait(() => b$("#dcBulkForm").hidden); await idle();
    ok("one code: “1 code made. Each works once, for its own email address.”", text(b$("#dcBulkSaid")) === "1 code made. Each works once, for its own email address.");
    reset(); b$("#dcCopyCsv").click(); await pause(20);
    ok("…“Copied 1 code.”", lastToast().m === "Copied 1 code.");
    b$("#dcBulkClose").click(); await pause(20); }

  // ==============================================================================================================
  console.log("\n=== “Code SAVE10” on an order (orderDiscountNote_) ===");
  // ==============================================================================================================
  const note = (o) => w.orderDiscountNote_(o);
  ok("a code and the note that already says it: the note as it is", note({ discountNote: "Code SAVE10", discountCode: "SAVE10" }) === "Code SAVE10" && note({ discountNote: "code save10 applied", discountCode: "SAVE10" }) === "code save10 applied");
  ok("a code and an owner's own note: “Code FIVEOFF · Loyal customer”", note({ discountNote: " Loyal customer ", discountCode: "FIVEOFF" }) === "Code FIVEOFF · Loyal customer");
  ok("a code with no note: “Code FIVEOFF”", note({ discountNote: "", discountCode: " FIVEOFF " }) === "Code FIVEOFF");
  ok("no code: the note alone, trimmed; nothing for none", note({ discountNote: " Owner's own " }) === "Owner's own" && note({ discountNote: "x", discountCode: "" }) === "x" && note({}) === "" && note(null) === "" &&
    note({ discountNote: "y", discountCode: 5 }) === "y");
  // The Orders table, from the server's own orders (discountCode from the live use)
  reset();
  order("CLUB-6", "club", "Jo Example", ago(0.5), 200, "");
  order("CLUB-7", "club", "Max Example", ago(0.4), 0, "");
  w.location.hash = "#orders/club";
  await wait(() => !!q('#app tr[data-order="CLUB-4"]'), 1500); await idle();
  const discCell = (oid) => q(`#app tr[data-order="${oid}"] td[data-discount-td]`);
  ok("the Orders table: an order whose note already names its code shows it once (“Code SAVE10”)", /−\$4\.00/.test(text(discCell("CLUB-1"))) && text(discCell("CLUB-1")).endsWith("Code SAVE10") && !/Code SAVE10.*Code SAVE10/.test(text(discCell("CLUB-1"))));
  ok("…an order with a code and the owner's own note: “Code FIVEOFF · Loyal customer”", text(discCell("CLUB-4")) === "−$5.00Code FIVEOFF · Loyal customer");
  ok("…an order with only the owner's note: the note", text(discCell("CLUB-5")) === "−$3.00Owner's own");
  ok("…an order with a discount and neither a code nor a note: the amount alone", text(discCell("CLUB-6")) === "−$2.00" && !discCell("CLUB-6").querySelector("br"));
  { const cached = ((w._ordersCache && w._ordersCache.club) || []);
    const o4 = cached.find(o => o.orderId === "CLUB-4");
    ok("(the orders the page has carry discountCode: FIVEOFF, and none for the owner's own)", !!o4 && o4.discountCode === "FIVEOFF" && cached.find(o => o.orderId === "CLUB-5").discountCode === "");
    const box = d.createElement("div");
    box.innerHTML = w.orderCardHtml_(o4, { orgId: "club", name: "Example Club" }, null, false);
    ok("the phone's order card: “Discount −$5.00 Code FIVEOFF · Loyal customer”", /Discount\s*−\$5\.00\s*Code FIVEOFF · Loyal customer/.test(text(box)) && [...box.querySelectorAll(".oc-dim")].some(e => text(e) === "Code FIVEOFF · Loyal customer"));
    const o5 = cached.find(o => o.orderId === "CLUB-5");
    box.innerHTML = w.orderCardHtml_(Object.assign({}, o5, { discountNote: "<b>bold</b>", discountCode: "" }), { orgId: "club", name: "Example Club" }, null, false);
    ok("…a note that looks like HTML is text there", /<b>bold<\/b>/.test(text(box)) && !box.querySelector(".oc-dim b"));
    const o6 = cached.find(o => o.orderId === "CLUB-6");
    box.innerHTML = w.orderCardHtml_(o6, { orgId: "club", name: "Example Club" }, null, false);
    box.innerHTML = w.orderCardHtml_(cached.find(o => o.orderId === "CLUB-7"), { orgId: "club", name: "Example Club" }, null, false);
    ok("…an order with no discount has no Discount line", !!text(box) && ![...box.querySelectorAll("div")].some(e => /^Discount/.test(text(e))));
    box.innerHTML = w.orderCardHtml_(o6, { orgId: "club", name: "Example Club" }, null, false);
    ok("…a discount with neither a code nor a note: “Discount −$2.00” and nothing after it", !!o6 && text([...box.querySelectorAll("div")].find(e => /^Discount/.test(text(e)) && !e.querySelector("div"))) === "Discount −$2.00");
    const pm = w.showPaymentsModal("club", "CLUB-4");
    await wait(() => !!q("#pmContent"));
    ok("the Payments window: “Discount (Code FIVEOFF · Loyal customer)  −$5.00”", [...qa("#pmContent tr")].some(tr => text(tr) === "Discount (Code FIVEOFF · Loyal customer)−$5.00"));
    q("#pmCloseBottom").click(); await pm;
    const pm2 = w.showPaymentsModal("club", "CLUB-5");
    await wait(() => !!q("#pmContent"));
    ok("…an order with only the owner's note: “Discount (Owner's own)”", [...qa("#pmContent tr")].some(tr => text(tr) === "Discount (Owner's own)−$3.00"));
    q("#pmCloseBottom").click(); await pm2;
    const pm3 = w.showPaymentsModal("club", "CLUB-6");
    await wait(() => !!q("#pmContent"));
    ok("…an order with neither: “Discount  −$2.00”, no brackets", [...qa("#pmContent tr")].some(tr => text(tr) === "Discount−$2.00"));
    q("#pmCloseBottom").click(); await pm3;
    const pm4 = w.showPaymentsModal("club", "CLUB-7");
    await wait(() => !!q("#pmContent"));
    ok("…an order with no discount has no Discount row", qa("#pmContent tr").length > 0 && ![...qa("#pmContent tr")].some(tr => /^Discount/.test(text(tr))));
    q("#pmCloseBottom").click(); await pm4;
    // A row drawn again after a change (updateOrderTableRow)
    w.updateOrderTableRow("club", "CLUB-5", Object.assign({}, o5, { discountAmount: 2, discountNote: "Note <i>x</i>", discountCode: "SAVE10" }));
    ok("a row drawn again after a change shows the code with the note: “Code SAVE10 · Note <i>x</i>”, as text", text(discCell("CLUB-5")) === "−$2.00Code SAVE10 · Note <i>x</i>" && !discCell("CLUB-5").querySelector("i"));
    w.updateOrderTableRow("club", "CLUB-5", Object.assign({}, o5, { discountAmount: 2, discountNote: "", discountCode: "SAVE10" }));
    ok("…a code with no note at all still shows “Code SAVE10”", text(discCell("CLUB-5")) === "−$2.00Code SAVE10");
    w.updateOrderTableRow("club", "CLUB-5", Object.assign({}, o5, { discountAmount: 2, discountNote: "", discountCode: "" }));
    ok("…with neither, the amount alone", text(discCell("CLUB-5")) === "−$2.00" && !discCell("CLUB-5").querySelector("br"));
    w.updateOrderTableRow("club", "CLUB-5", Object.assign({}, o5, { discountAmount: 0, discountCode: "SAVE10" }));
    ok("…no discount: “—”, even with a code", text(discCell("CLUB-5")) === "—"); }

  ok("nothing typed anywhere ran as HTML", w.__xss334 === undefined);
  await idle();
})().catch((e) => { console.error(e); ok("test370 ran to the end", false); });
