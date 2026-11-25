const fs = require("fs");
const { storefrontPage } = require("./testlib/storefront-page");
const { autoConfirm } = require("./testlib/confirm.js");
const { JSDOM, ResourceLoader, VirtualConsole } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");
const { ok } = require("./testlib/check");
const roles = require("./testlib/roles");

// Customer records (migrations/0108), the part of them that lives in public/admin.js — RUN in the real admin page
// (jsdom) against the real orders.js / db.js on sql.js:
//   adminCanCustomers_ and the menu — Customers among the top buttons right after Orders (after Home for a role
//     without Orders), in the phone's menu sheet too, and only for a role that may open it;
//   the route (#customers, #customers/<id>) and ensureCustomersPage_ — /admin-customers.js asked for once, a load
//     that fails says so and can be tried again, the page that was asked for is the one drawn;
//   the Local sale form's Customer search (customerSearchHtml_, wireCustomerSearch_) — the wait after the last key,
//     eight results, the keyboard, what a pick fills in and remembers, what forgets it, Clear, and the customerId
//     that goes with createLocalSale and ends up on the order.
// The Customers page itself (public/admin-customers.js) is served as it is; its own screens are another file's.
// Invented data only.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { createProduct };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'olive@example.test';\n" + roles.adminAs() + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
const pause = (ms) => new Promise(r => setTimeout(r, ms));
const wait = async (cond, n = 500) => { for (let i = 0; i < n && !cond(); i++) await pause(10); return !!cond(); };

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const call = async (body) => {
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => Promise.resolve(p).catch(() => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Example Club','t','t');`);
  await lib.createProduct(d1, "acme", { productId: "cap", type: "cap", name: "Club cap", pricingMode: "flat", flatPrice: 20, visible: true, noDesignNeeded: true });
  const HTML_NAME = '<img src=x onerror="window.__xss=1">Robin & Co', HTML_COMPANY = "<b>Bold</b> Ltd";
  const mkCustomer = async (fields) => {
    const r = await call(Object.assign({ action: "saveCustomer", name: "", company: "", email: "", phone: "", address: null, notes: "" }, fields));
    if (r.status !== 200) throw new Error("could not make the customer " + JSON.stringify(fields) + " — " + JSON.stringify(r.body));
    return r.body.id;
  };
  const patId = await mkCustomer({ name: "Pat Example", company: "Example Club", email: "pat@example.com", phone: "555-0100" });
  const samId = await mkCustomer({ name: "Pat Sample", email: "pat.sample@example.com" });
  const rileyId = await mkCustomer({ name: "Riley Exempt", email: "riley@example.com", taxExempt: true, taxExemptCertificate: "CERT-1" });
  const boostersId = await mkCustomer({ company: "Example Boosters", phone: "555-0101" });
  const robinId = await mkCustomer({ name: HTML_NAME, company: HTML_COMPANY, email: "robin@example.com" });
  const goneId = await mkCustomer({ name: "Pat Archived", email: "pat.archived@example.com" });
  if ((await call({ action: "setCustomerArchived", id: goneId, archived: true })).status !== 200) throw new Error("could not archive a customer");
  for (let i = 1; i <= 10; i++) await mkCustomer({ name: "Member " + String(i).padStart(2, "0"), email: "member" + i + "@example.com" });

  // ---- The page ------------------------------------------------------------------------------------------------
  const adminJs = read("public/admin.js"), customersJs = read("public/admin-customers.js");
  const sent = [], toasts = [], pageLoads = [], drawn = [];
  let pageMode = "ok", pageGate = null, scripted = [], inflight = 0;
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
  class Loader extends ResourceLoader {
    fetch(url) {
      if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs));
      if (/\/admin-customers\.js(\?|$)/.test(url)) {
        pageLoads.push(url);
        if (pageMode === "fail") return Promise.reject(new Error("offline"));
        return Promise.resolve(pageGate).then(() => Buffer.from(customersJs));
      }
      return Promise.resolve(Buffer.from(""));
    }
  }
  // The Customers page refused on purpose is jsdom's own complaint; anything else the page throws is still shown.
  const vc = new VirtualConsole();
  vc.sendTo(console, { omitJSDOMErrors: true });
  vc.on("jsdomError", (e) => { if (!/Could not load script: "https:\/\/admin\.example\.com\/admin-customers\.js/.test(e.message)) console.error(e); });
  const dom = new JSDOM(storefrontPage(), { runScripts: "dangerously", resources: new Loader(), virtualConsole: vc, url: "https://admin.example.com/#orders/acme", pretendToBeVisual: true,
    beforeParse(win) {
      autoConfirm(win, () => true);
      win.CSS = win.CSS || { escape: (s) => String(s).replace(/["\\]/g, "\\$&") };
      // renderCustomers, watched: the page's own function still runs; what it was called with is kept. Until the
      // script has defined it there is none (ensureCustomersPage_ asks `typeof renderCustomers`).
      let real = null;
      const spy = function (app, id) { drawn.push({ app, id }); return real.apply(this, arguments); };
      Object.defineProperty(win, "renderCustomers", { configurable: true, get: () => (real ? spy : undefined), set: (v) => { real = v; } });
      win.fetch = async (url, init) => {
        const u = String(url), b = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
        if (!u.includes("/api/orders")) return reply(404, { status: "error", message: "not here" });
        sent.push(b); inflight++;
        try {
          if (scripted.length && scripted[0].action === b.action) { const s = scripted.shift(); if (s.gate) await s.gate; return reply(s.status || 200, s.body); }
          const x = await call(b);
          return reply(x.status, x.body);
        } finally { inflight--; }
      };
    } });
  const w = dom.window, d = w.document;
  await pause(150);
  await w.loadAdminScript();
  w.showToast = (m, isErr) => toasts.push({ m: String(m), err: !!isErr });
  w.eval('adminKey = "cookie"; adminOrgs = [{ orgId: "acme", name: "Example Club" }];');
  const app = d.getElementById("app");
  const idle = async () => { for (let calm = 0, i = 0; calm < 3 && i < 500; i++) { await pause(10); calm = inflight === 0 ? calm + 1 : 0; } };
  const lastToast = () => (toasts[toasts.length - 1] || { m: "" });
  const actions = () => sent.map(b => b.action);
  const reset = () => { sent.length = 0; toasts.length = 0; };

  // Who is signed in, as the page knows it: a built-in role, or a role with some functions changed.
  const levelsOf = (role) => roles.effectivePermissions(roles.DEFAULT_ROLES[role]);
  const signIn = (role) => w.eval(roles.asRole(role));
  const signInWith = (perms, areas) => w.eval(`adminMe = { role: "custom", roleName: "Front desk" }; adminPerms = ${JSON.stringify(perms)}; adminAreas = ${JSON.stringify(areas || roles.PERMISSION_AREAS)};`);
  const ORDERS_FNS = roles.PERMISSION_AREAS.flatMap(m => m.items).find(it => it.hash === "orders").fns.map(f => f[0]);
  const without = (perms, fns) => Object.assign({}, perms, Object.fromEntries(fns.map(f => [f, "none"])));
  const noCustomers = without(levelsOf("admin"), ["customers.records"]);
  const noOrders = without(levelsOf("admin"), ORDERS_FNS);
  const rowButtons = () => [...d.querySelectorAll("#adminNav .admin-nav-row > button.admin-nav-btn")];
  const sheetButtons = () => [...d.querySelectorAll("#adminNav .admin-nav-sheet .admin-nav-sheet-top > button.admin-nav-btn")];
  const hashes = (btns) => btns.map(b => b.dataset.h);
  const before = (list, h) => list[list.indexOf(h) - 1];

  console.log("=== Who may open Customers (adminCanCustomers_) ===");
  for (const [role, label] of [["admin", "Admin"], ["manager", "Manager"], ["staff", "Back office"], ["production", "Production"]]) {
    signIn(role);
    ok(label + " (customers.records " + levelsOf(role)["customers.records"] + ") may", levelsOf(role)["customers.records"] !== "none" && w.adminCanCustomers_() === true && w.adminCanOpenPage_("customers") === true);
  }
  signInWith(noCustomers);
  ok("a role with customers.records at none may not — the list, a customer's page, with or without the slash", w.adminCanCustomers_() === false && w.adminCanOpenPage_("customers") === false &&
    w.adminCanOpenPage_("customers/3") === false && w.adminCanOpenPage_("#/customers/3") === false && w.adminCanOpen_("customers") === false);
  ok("…while its other pages stay open", w.adminCanOpenPage_("orders") === true);
  signInWith(Object.assign({}, noCustomers, { "customers.records": "read" }));
  ok("read is enough", w.adminCanCustomers_() === true && w.adminCanOpen_("customers/3") === true);
  // A deploy half way: the server's list of menus has no Customers yet, and the role's levels don't name it.
  const oldAreas = roles.PERMISSION_AREAS.map(m => Object.assign({}, m, { items: m.items.filter(it => it.hash !== "customers") })).filter(m => m.items.length);
  const oldPerms = Object.assign({}, levelsOf("staff")); delete oldPerms["customers.records"];
  signInWith(oldPerms, oldAreas);
  ok("a server that doesn't list the page yet doesn't make it look open to a role never given it", w.adminItemFns_("customers") === null && w.adminCanCustomers_() === false && w.adminCanOpenPage_("customers") === false);
  signInWith(levelsOf("staff"), oldAreas);
  ok("…and a role that was given it can open it whatever that list says", w.adminCanOpenPage_("customers") === true);
  signIn(null); w.eval('adminMe = { role: "admin" };');
  ok("before the role's levels are known nothing is held back (the server still checks)", w.adminCanCustomers_() === true);

  console.log("\n=== Customers in the menu (renderAdminNav) ===");
  signIn("admin"); w.renderAdminNav();
  const adminRow = hashes(rowButtons());
  ok("an admin's top buttons have Customers", adminRow.filter(h => h === "customers").length === 1 && rowButtons().find(b => b.dataset.h === "customers").textContent === "Customers");
  ok("…right after Orders, before Run Order", before(adminRow, "customers") === "orders" && adminRow[adminRow.indexOf("customers") + 1] === "runorder" && adminRow[0] === "home");
  ok("…as a button that goes to #customers like the others", rowButtons().find(b => b.dataset.h === "customers").dataset.adminAction === "navGo" && rowButtons().find(b => b.dataset.h === "customers").type === "button");
  ok("the phone's menu sheet has it too, in the same place", hashes(sheetButtons()).filter(h => h === "customers").length === 1 && before(hashes(sheetButtons()), "customers") === "orders" &&
    sheetButtons().find(b => b.dataset.h === "customers").textContent === "Customers" && JSON.stringify(hashes(sheetButtons())) === JSON.stringify(adminRow));
  ok("…and it is in no dropdown menu a second time", d.querySelectorAll('#adminNav [data-h="customers"]').length === 2);
  for (const [role, label] of [["manager", "Manager"], ["staff", "Back office"], ["production", "Production"]]) {
    signIn(role); w.renderAdminNav();
    const r = hashes(rowButtons());
    ok(label + " gets the button too, after " + (r.includes("orders") ? "Orders" : "Home"), r.includes("customers") && before(r, "customers") === (r.includes("orders") ? "orders" : "home") && hashes(sheetButtons()).includes("customers"));
  }
  signInWith(noOrders); w.renderAdminNav();
  ok("a role without Orders gets Customers right after Home", !hashes(rowButtons()).includes("orders") && JSON.stringify(hashes(rowButtons()).slice(0, 2)) === '["home","customers"]' &&
    JSON.stringify(hashes(sheetButtons()).slice(0, 2)) === '["home","customers"]');
  signInWith(noCustomers); w.renderAdminNav();
  ok("a role that can't open Customers gets no button — top row or phone sheet", rowButtons().length > 0 && !d.querySelector('#adminNav [data-h="customers"]') && hashes(rowButtons()).includes("orders") &&
    !/Customers/.test(d.querySelector("#adminNav .admin-nav-sheet-top").textContent));
  ok("…and the rest of its buttons are in the order they always were", JSON.stringify(hashes(rowButtons())) === JSON.stringify(adminRow.filter(h => h !== "customers")));
  // Where someone lands when the address points at a page that isn't theirs (adminFirstPage_).
  const nothing = Object.fromEntries(Object.keys(levelsOf("admin")).map(f => [f, "none"]));
  signInWith(Object.assign({}, nothing, { "customers.records": "read", "run.queue": "read" }));
  ok("a role with Customers but neither Home nor Orders lands on Customers, ahead of Run Order", w.adminFirstPage_() === "customers" && w.adminCanOpen_("runorder") === true && w.adminCanOpen_("home") === false);
  signInWith(Object.assign({}, nothing, { "customers.records": "read", "orders.details": "read" }));
  ok("…with Orders as well, on Orders", w.adminFirstPage_() === "orders");
  signInWith(Object.assign({}, nothing, { "run.queue": "read" }));
  ok("…and without Customers, on its next page", w.adminFirstPage_() === "runorder");

  console.log("\n=== The route and the page's script (adminRoute, ensureCustomersPage_) ===");
  const go = async (hash, until) => { w.location.hash = hash; const done = await wait(until); await idle(); return done; };
  const pageScripts = () => d.querySelectorAll('script[src="/admin-customers.js"]').length;
  signInWith(noCustomers);
  await go("#customers", () => !!d.getElementById("roleOffPanel"));
  ok("a role that can't open it is told \"Not available to you\" at #customers", /Not available to you\./.test(app.textContent) && /Front desk/.test(d.getElementById("roleOffPanel").textContent));
  await go("#home", () => !d.getElementById("roleOffPanel"));
  await go("#customers/" + patId, () => !!d.getElementById("roleOffPanel"));
  ok("…and at a customer's own address", /Not available to you\./.test(app.textContent) && !/Pat Example/.test(app.textContent));
  ok("…without the page's script being asked for, or any customer", pageLoads.length === 0 && pageScripts() === 0 && drawn.length === 0 && !actions().includes("listCustomers") && !actions().includes("getCustomer"));

  signIn("admin");
  pageMode = "fail";
  await go("#customers", () => /Couldn't load the Customers page/.test(app.textContent));
  ok("the script can't be loaded: the page says so instead of staying blank", /Couldn't load the Customers page\. Check your connection and reload the page\./.test(app.querySelector(".admin-empty").textContent));
  ok("…under the Customers heading and title, with Customers lit in the menu", app.querySelector("h1").textContent.trim() === "Customers" && / — Customers \(Admin\)$/.test(d.title) &&
    rowButtons().find(b => b.dataset.h === "customers").classList.contains("active") && w.location.hash === "#customers");
  ok("…the script was asked for once, at /admin-customers.js, and its tag is taken out again", pageLoads.length === 1 && /^https:\/\/admin\.example\.com\/admin-customers\.js$/.test(pageLoads[0]) && pageScripts() === 0 && drawn.length === 0);
  let refused = null;
  try { await w.ensureCustomersPage_(); } catch (e) { refused = e; }
  ok("ensureCustomersPage_ fails with a plain sentence, and tries again each time it is asked", !!refused && refused.message === "Couldn't load the Customers page" && pageLoads.length === 2);

  // A slow load: two asks share one script; the address moves on before it arrives.
  pageMode = "ok";
  let release; pageGate = new Promise(r => { release = r; });
  w.location.hash = "#home"; await wait(() => !/Couldn't load/.test(app.textContent)); await idle();
  w.location.hash = "#customers";
  await wait(() => pageLoads.length === 3);
  const p1 = w.ensureCustomersPage_(), p2 = w.ensureCustomersPage_();
  ok("while the script is on its way, everyone who asks waits for the same one", p1 === p2 && pageLoads.length === 3 && pageScripts() === 1);
  w.location.hash = "#customers/" + patId;
  await pause(60);
  ok("…and nothing is drawn before it is there", drawn.length === 0 && pageLoads.length === 3);
  release(); pageGate = null;
  await wait(() => drawn.length > 0 && /Pat Example/.test(app.textContent)); await idle();
  ok("the address moved on while it loaded: only the page now asked for is drawn", drawn.length === 1 && drawn[0].id === patId && !d.getElementById("custQ"));
  ok("renderCustomers gets the page's #app and the customer's id as a number", drawn[0].app === app && typeof drawn[0].id === "number");
  ok("…and that customer's page is what is on screen", /pat@example\.com/.test(app.innerHTML) && actions().includes("getCustomer") && sent.find(b => b.action === "getCustomer").id === patId);
  ok("on a customer's page Customers is lit in the menu, and named on the phone's bar", rowButtons().find(b => b.dataset.h === "customers").classList.contains("active") &&
    sheetButtons().find(b => b.dataset.h === "customers").classList.contains("active") && d.querySelector("#adminNav .admin-nav-current").textContent === "Customers" && w.adminNavActive_() === "customers");

  reset(); drawn.length = 0;
  rowButtons().find(b => b.dataset.h === "customers").click();
  await wait(() => !!d.getElementById("custQ") && /Pat Example/.test(app.textContent)); await idle();
  ok("the Customers button opens the list: renderCustomers(app, null)", w.location.hash === "#customers" && drawn.length === 1 && drawn[0].id === null && drawn[0].app === app);
  ok("…which asks the server for the customers and lists them", actions().includes("listCustomers") && /Example Boosters/.test(app.textContent) && / — Customers \(Admin\)$/.test(d.title));
  const idFor = async (hash) => { drawn.length = 0; w.location.hash = hash; await wait(() => drawn.length > 0); await idle(); return drawn.length === 1 ? drawn[0].id : "drawn " + drawn.length + " times"; };
  ok("#/customers/<id> (with the slash) is the same customer", (await idFor("#/customers/" + samId)) === samId && /Pat Sample/.test(app.textContent));
  ok("an id that isn't a number is the list", (await idFor("#customers/abc")) === null);
  ok("…so is 0", (await idFor("#customers/0")) === null);
  ok("…and a number written with a leading zero", (await idFor("#customers/007")) === null);
  ok("…and #customers/ with nothing after it", (await idFor("#customers/")) === null && !!d.getElementById("custQ"));
  ok("through all of that the script was loaded once", pageLoads.length === 3 && pageScripts() === 1);
  const sameAgain = w.ensureCustomersPage_();
  ok("…and asking again answers at once, with no new request", (await sameAgain) === undefined && pageLoads.length === 3 && pageScripts() === 1);

  // ---- The Local sale form ---------------------------------------------------------------------------------------
  await go("#orders/acme", () => !!(w._ordersCache && w._ordersCache.acme) && !d.getElementById("custQ"));
  const form = () => d.getElementById("localSaleForm");
  const el = (id) => d.getElementById(id);
  const box = () => el("lsCustomer"), list = () => el("lsCustomerList"), note = () => el("lsCustomerNote");
  const results = () => [...list().querySelectorAll("button[data-i]")];
  const shown = (e) => !!e && e.style.display !== "none";
  const typeIn = (e, v) => { e.value = v; e.dispatchEvent(new w.Event("input", { bubbles: true })); };
  const key = (e, k) => { const ev = new w.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }); e.dispatchEvent(ev); return ev; };
  const searches = () => sent.filter(b => b.action === "listCustomers");
  // Types into the Customer field and waits for that search's answer to be on screen.
  const search = async (text) => { const n = searches().length; typeIn(box(), text); await wait(() => searches().length > n); await idle(); };
  // (answers the form's own promise inside an object: handing the promise back would wait for the form to close)
  const openSale = async (opts) => { reset(); const closed = w.createLocalSale("acme", opts); await wait(() => !!form()); return { closed }; };
  const picked = () => shown(el("lsCustomerPicked"));
  const pickedText = () => el("lsCustomerPickedText").textContent;
  const fields = () => [el("lsName").value, el("lsEmail").value, el("lsPhone").value].join(" | ");
  // Records the sale on the form (a cap, cash) and answers what was sent and the order it made.
  const record = async (closed) => {
    el("lsProduct").value = "cap"; el("lsProduct").dispatchEvent(new w.Event("change", { bubbles: true }));
    el("lsPayment").value = "Cash";
    form().querySelector(".admin-pass-submit").click();
    await closed; await idle();
    const body = sent.filter(b => b.action === "createLocalSale").pop();
    const orderId = (lastToast().m.match(/^Local sale recorded — (\S+)$/) || [])[1] || "";
    return { body, orderId, row: d1.q("SELECT customerId, customerName, contact FROM orders WHERE orderId = ?", orderId)[0] };
  };

  console.log("\n=== The Local sale form's Customer field ===");
  signIn("admin");
  let closed; ({ closed } = await openSale());
  ok("the form has a Customer search field, marked optional and tied to its label", !!box() && box().type === "search" && form().querySelector('label[for="lsCustomer"]').textContent.replace(/\s+/g, " ").trim() === "Customer (optional)" &&
    box().getAttribute("placeholder") === "Search by name, company, email or phone" && box().getAttribute("autocomplete") === "off" && box().maxLength === 200);
  ok("…above the name, email and phone under Customer info", !!(el("lsCustomerWrap").compareDocumentPosition(el("lsCustomerInfo")) & w.Node.DOCUMENT_POSITION_FOLLOWING) &&
    el("lsCustomerInfo").contains(el("lsName")) && el("lsCustomerInfo").contains(el("lsEmail")) && el("lsCustomerInfo").contains(el("lsPhone")));
  ok("…with a named place for the matches and a status line a screen reader hears, both empty to start", list().getAttribute("role") === "group" && list().getAttribute("aria-label") === "Matching customers" &&
    note().getAttribute("role") === "status" && box().getAttribute("aria-describedby") === "lsCustomerNote" && !shown(list()) && !shown(note()) && !picked() && shown(el("lsCustomerFind")));
  ok("opening the form asks for no customers", searches().length === 0);

  typeIn(box(), "p"); typeIn(box(), "pa"); typeIn(box(), "pat");
  await pause(60);
  ok("typing doesn't search on every key", searches().length === 0);
  await wait(() => searches().length > 0); await idle(); await pause(320);
  ok("a moment after the last key, one search for what was typed", searches().length === 1 && searches()[0].q === "pat");
  ok("…the first eight, not the archived ones, from the start", searches()[0].limit === 8 && searches()[0].includeArchived === false && searches()[0].offset === 0);
  ok("the matches are listed as buttons, by name", shown(list()) && results().length === 2 && results().every(b => b.type === "button") &&
    JSON.stringify(results().map(b => b.querySelector("strong").textContent)) === '["Pat Example","Pat Sample"]');
  ok("…each with its company, email and phone under the name", results()[0].querySelector("span[style*='display:block']").textContent === "Example Club · pat@example.com · 555-0100" &&
    results()[1].querySelector("span[style*='display:block']").textContent === "pat.sample@example.com");
  ok("…an archived customer isn't offered", !/Pat Archived/.test(list().textContent));
  ok("…and the status line says how many", shown(note()) && note().textContent === "2 customers found.");
  ok("nothing is filled in or picked by searching", fields() === " |  | " && !picked());

  console.log("\n=== The keyboard in the Customer field ===");
  let ev = key(box(), "Enter");
  ok("Enter with two matches picks neither, and doesn't send the form", ev.defaultPrevented && !picked() && !!form() && !shown(el("lsErr")) && !actions().includes("createLocalSale") && results().length === 2);
  ev = key(box(), "ArrowDown");
  ok("↓ goes into the list, to the first match", ev.defaultPrevented && d.activeElement === results()[0]);
  ev = key(results()[0], "ArrowDown");
  ok("↓ again moves to the next", ev.defaultPrevented && d.activeElement === results()[1]);
  ev = key(results()[1], "ArrowDown");
  ok("…and stays on the last", ev.defaultPrevented && d.activeElement === results()[1]);
  ev = key(results()[1], "ArrowUp");
  ok("↑ moves back up", ev.defaultPrevented && d.activeElement === results()[0]);
  ev = key(results()[0], "ArrowUp");
  ok("…and from the first match back to the field", ev.defaultPrevented && d.activeElement === box());
  key(box(), "ArrowDown");
  ev = key(d.activeElement, "Escape");
  ok("Escape in the list closes the list and returns to the field — the form stays open", ev.defaultPrevented && !shown(list()) && results().length === 0 && !shown(note()) && d.activeElement === box() && !!form() && box().value === "pat");
  ev = key(box(), "ArrowDown");
  ok("with no list, ↓ does nothing", !ev.defaultPrevented && d.activeElement === box());
  ev = key(box(), "Enter");
  ok("…and Enter still doesn't send the form", ev.defaultPrevented && !!form() && !shown(el("lsErr")) && !actions().includes("createLocalSale"));
  await search("pat e");
  ok("(the list is back after typing on: one match, \"1 customer found.\")", results().length === 1 && note().textContent === "1 customer found.");
  ev = key(box(), "Escape");
  ok("Escape in the field closes the list first, not the form", ev.defaultPrevented && !shown(list()) && !shown(note()) && !!form());
  ev = key(box(), "Escape");
  await closed;
  ok("…and with no list to close, Escape closes the form: nothing recorded", !ev.defaultPrevented && !form() && !actions().includes("createLocalSale"));

  console.log("\n=== Picking a customer ===");
  ({ closed } = await openSale());
  await search("pat ex");
  typeIn(box(), "pat e");
  ev = key(box(), "Enter");
  ok("Enter while a new search is still to come picks nothing", ev.defaultPrevented && !picked() && fields() === " |  | ");
  await wait(() => searches().length === 2); await idle();
  ok("(that search has one match)", results().length === 1 && results()[0].querySelector("strong").textContent === "Pat Example");
  ev = key(box(), "Enter");
  ok("Enter with exactly one match picks it — and still doesn't send the form", ev.defaultPrevented && picked() && !!form() && !actions().includes("createLocalSale") && !shown(el("lsErr")));
  ok("the pick fills in the name, the email and the phone", fields() === "Pat Example | pat@example.com | 555-0100");
  ok("…opens Customer info so they can be seen", el("lsCustomerInfo").open === true);
  ok("…and shows who was picked in place of the search field, with a Clear button that has the focus", !shown(el("lsCustomerFind")) && el("lsCustomerPicked").style.display === "flex" &&
    pickedText() === "Picked: Pat Example · Example Club · pat@example.com · 555-0100" && el("lsCustomerPickedText").getAttribute("role") === "status" &&
    el("lsCustomerClear").textContent === "Clear" && el("lsCustomerClear").type === "button" && d.activeElement === el("lsCustomerClear"));
  ok("…the search field and its list are emptied", box().value === "" && results().length === 0 && !shown(list()) && !shown(note()));

  typeIn(el("lsName"), "Pat's daughter");
  typeIn(el("lsPhone"), "555-0142");
  ok("changing the name or the phone afterwards keeps the pick", picked() && /^Picked: Pat Example/.test(pickedText()));
  typeIn(el("lsEmail"), "  PAT@Example.com ");
  ok("the same email in other capitals or with spaces round it keeps the pick too", picked());
  typeIn(el("lsEmail"), "pat@example.com");
  let made = await record(closed);
  ok("Record sale sends the picked customer's id as customerId", !!made.body && made.body.customerId === patId && made.body.customerName === "Pat's daughter" && made.body.contact === "pat@example.com" && made.body.phone === "555-0142");
  ok("…and the order is on that customer's record in the database, under the name typed", !!made.row && made.row.customerId === patId && made.row.customerName === "Pat's daughter");

  ({ closed } = await openSale());
  await search("boosters");
  const boosters = { title: results()[0].querySelector("strong").textContent, under: results()[0].querySelector("span[style*='display:block']").textContent };
  results()[0].click();
  ok("clicking a match picks it; a customer with only a company gets the company as the name", picked() && fields() === "Example Boosters |  | 555-0101" && pickedText() === "Picked: Example Boosters · 555-0101");
  ok("…having been listed under its company, not named twice", boosters.title === "Example Boosters" && boosters.under === "555-0101");
  made = await record(closed);
  ok("a picked customer with no email: the id alone puts the order on their record", made.body.customerId === boostersId && made.body.contact === "" && !!made.row && made.row.customerId === boostersId && made.row.contact === "");

  ({ closed } = await openSale());
  el("lsName").value = "Walk-in Sam";
  made = await record(closed);
  ok("a sale with nobody picked sends no customerId at all", !!made.body && !("customerId" in made.body) && made.body.customerName === "Walk-in Sam" && searches().length === 0);
  ok("…and with no email either, the order is on no customer's record", !!made.row && made.row.customerId === null);

  console.log("\n=== Forgetting the pick: a different email, and Clear ===");
  ({ closed } = await openSale());
  await search("pat ex"); results()[0].click();
  typeIn(el("lsEmail"), "pat2@example.com");
  ok("typing a different email forgets the pick: the search field is back", !picked() && shown(el("lsCustomerFind")) && pickedText() === "");
  ok("…and what was filled in stays as typed", fields() === "Pat Example | pat2@example.com | 555-0100");
  typeIn(el("lsEmail"), "pat@example.com");
  ok("…typing the old email back doesn't pick them again", !picked());
  await search("pat ex"); results()[0].click();
  el("lsCustomerClear").click();
  ok("Clear forgets the pick and empties what it filled in", !picked() && shown(el("lsCustomerFind")) && fields() === " |  | ");
  ok("…and puts the focus back in the search field", d.activeElement === box());
  await search("pat ex"); results()[0].click();
  typeIn(el("lsName"), "Pat's daughter"); typeIn(el("lsPhone"), "555-0142");
  el("lsCustomerClear").click();
  ok("Clear leaves a name and a phone typed over the pick's", !picked() && fields() === "Pat's daughter |  | 555-0142");
  el("lsName").value = ""; el("lsPhone").value = "555-0199";
  await search("pat.sample"); results()[0].click();
  ok("picking a customer with no phone leaves the phone already typed", picked() && fields() === "Pat Sample | pat.sample@example.com | 555-0199");
  typeIn(el("lsEmail"), "PAT.SAMPLE@EXAMPLE.COM");
  el("lsCustomerClear").click();
  ok("…and Clear leaves it too, while the email goes even in other capitals", !picked() && fields() === " |  | 555-0199");
  el("lsPhone").value = "";
  await search("riley");
  ok("an exempt customer is tagged Exempt in the list", results().length === 1 && /Exempt/.test(results()[0].textContent) && !/Archived/.test(results()[0].textContent));
  await search("pat ex");
  ok("…others are not", results().length === 1 && !/Exempt/.test(results()[0].textContent));
  await search("riley"); results()[0].click();
  ok("…and picked, the form says they are tax exempt", pickedText() === "Picked: Riley Exempt · riley@example.com — tax exempt");
  typeIn(el("lsEmail"), "someone.else@example.com");
  el("lsName").value = "Someone Else";
  made = await record(closed);
  ok("a sale recorded after the pick was forgotten sends no customerId", !!made.body && !("customerId" in made.body) && made.body.contact === "someone.else@example.com");
  ok("…so it isn't put on the forgotten customer's record", !!made.row && made.row.customerId !== rileyId);

  console.log("\n=== What the search says, and what it never draws ===");
  ({ closed } = await openSale());
  await search("member");
  ok("more than eight matches: eight are listed", results().length === 8 && results()[0].querySelector("strong").textContent === "Member 01");
  ok("…and the status line says so and to keep typing", note().textContent === "Showing the first 8 of 10 — keep typing to narrow it down.");
  await search("nobody at all");
  ok("no match: \"No customer matches that.\", and no list", note().textContent === "No customer matches that." && shown(note()) && !shown(list()) && results().length === 0);
  let n = searches().length;
  typeIn(box(), "   ");
  await pause(400);
  ok("only spaces (or an emptied field) asks nothing and clears the line", searches().length === n && !shown(note()) && note().textContent === "" && !shown(list()));
  await search("robin");
  ok("a name with HTML in it is shown as text", results().length === 1 && results()[0].querySelector("strong").textContent === HTML_NAME && !list().querySelector("img, b") && w.__xss === undefined);
  ok("…its company too", results()[0].querySelector("span[style*='display:block']").textContent === HTML_COMPANY + " · robin@example.com" && /&lt;img src=x/.test(list().innerHTML) && /&lt;b&gt;Bold/.test(list().innerHTML));
  results()[0].click();
  ok("…and picked, it is text in the form and the name field", pickedText() === "Picked: " + HTML_NAME + " · " + HTML_COMPANY + " · robin@example.com" && el("lsCustomerPickedText").children.length === 0 &&
    el("lsName").value === HTML_NAME && w.__xss === undefined);
  el("lsCustomerClear").click();
  // Answers the real server wouldn't give this search, to see how each is drawn.
  const many = Array.from({ length: 12 }, (_, i) => ({ id: 500 + i, name: "Listed " + (i + 1), company: "", email: "", phone: "", taxExempt: false, archived: false }));
  scripted = [{ action: "listCustomers", body: { status: "ok", customers: many } }];
  await search("listed");
  ok("an answer with more than eight rows is cut to eight", results().length === 8 && note().textContent === "8 customers found.");
  scripted = [{ action: "listCustomers", body: { status: "ok", total: 2, customers: [
    { id: 601, name: "", company: "Example Guild", email: "guild@example.com", phone: "", taxExempt: false, archived: true },
    { id: 602, name: "", company: "", email: "", phone: "", taxExempt: true, archived: false }] } }];
  await search("guild");
  ok("a customer with only a company is titled by it, without repeating it underneath", results()[0].querySelector("strong").textContent === "Example Guild" && results()[0].querySelector("span[style*='display:block']").textContent === "guild@example.com");
  ok("…an archived one the server sends is tagged Archived", /Archived/.test(results()[0].textContent) && !/Exempt/.test(results()[0].textContent));
  ok("…and one with nothing at all is \"Customer <id>\"", results()[1].querySelector("strong").textContent === "Customer 602" && /Exempt/.test(results()[1].textContent));
  results()[1].click();
  ok("…picked, it is \"Customer <id> — tax exempt\" and fills in nothing", pickedText() === "Picked: Customer 602 — tax exempt" && fields() === " |  | ");
  el("lsCustomerClear").click();
  scripted = [{ action: "listCustomers", body: { status: "ok", customers: [{ id: "abc", name: "No Number" }, { id: 0, name: "Zero" }] } }];
  await search("number");
  results()[0].click();
  ok("a row whose id isn't a customer's number can't be picked", !picked() && fields() === " |  | ");
  scripted = [{ action: "listCustomers", body: { status: "ok", customers: [{ id: 603, name: "x".repeat(250), email: "  Long@Example.COM ", phone: "5".repeat(60) }] } }];
  await search("long");
  results()[0].click();
  ok("a pick's name is cut to 200 characters and its phone to 50, the email lower-cased and trimmed", el("lsName").value === "x".repeat(200) && el("lsPhone").value === "5".repeat(50) && el("lsEmail").value === "long@example.com");
  el("lsCustomerClear").click();
  ok("…and Clear takes exactly those back", fields() === " |  | ");
  scripted = [{ action: "listCustomers", status: 503, body: { status: "error", message: "Customers aren't ready yet." } }];
  await search("pat");
  ok("a search the server refuses: \"Couldn't search the customers: <its message>\", and no list", note().textContent === "Couldn't search the customers: Customers aren't ready yet." && shown(note()) && !shown(list()) && results().length === 0);
  // An answer that arrives after the person typed on is for a search nobody is waiting for.
  let late; scripted = [{ action: "listCustomers", gate: new Promise(r => { late = r; }), body: { status: "ok", customers: [{ id: 700, name: "Late Answer" }] } }];
  n = searches().length;
  typeIn(box(), "pat s");
  await wait(() => searches().length === n + 1);
  await search("pat sa");
  ok("(the newer search is on screen)", results().length === 1 && results()[0].querySelector("strong").textContent === "Pat Sample");
  late(); await idle(); await pause(30);
  ok("an older search's answer arriving late isn't drawn over it", results().length === 1 && results()[0].querySelector("strong").textContent === "Pat Sample" && !/Late Answer/.test(list().textContent) && note().textContent === "1 customer found.");
  form().querySelector(".admin-pass-cancel").click();
  await closed;
  ok("Cancel closes the form with nothing recorded", !form() && !actions().includes("createLocalSale"));
  const none = w.wireCustomerSearch_(d.createElement("div"), "nothingHere", () => {});
  ok("wiring a search field that isn't on the page does nothing (and doesn't throw)", typeof none.reset === "function" && typeof none.search === "function" && none.reset() === undefined && none.search() === undefined);

  console.log("\n=== The form opened for a customer, and for a role without Customers ===");
  const recorded = [];
  ({ closed } = await openSale({ customer: { id: samId, name: "Pat Sample", company: "", email: "pat.sample@example.com", phone: "" }, onRecorded: (data) => recorded.push(data) }));
  ok("opened for a customer, the form starts with them picked and filled in", picked() && pickedText() === "Picked: Pat Sample · pat.sample@example.com" && fields() === "Pat Sample | pat.sample@example.com | " &&
    el("lsCustomerInfo").open === true && searches().length === 0);
  made = await record(closed);
  ok("…the sale carries their id and the order is theirs", made.body.customerId === samId && !!made.row && made.row.customerId === samId);
  ok("…and what the opener asked to be told is told, in place of redrawing the Orders list", recorded.length === 1 && recorded[0].orderId === made.orderId && !actions().includes("getOrdersByIds"));

  signInWith(noCustomers);
  ({ closed } = await openSale({ customer: { id: patId, name: "Pat Example", company: "Example Club", email: "pat@example.com", phone: "555-0100" } }));
  ok("a role without Customers gets no Customer search field on the form", !!form() && !el("lsCustomerWrap") && !box() && !el("lsCustomerClear") && !/Search by name, company/.test(form().innerHTML));
  ok("…the name, email and phone are there as before, empty", !!el("lsCustomerInfo") && fields() === " |  | " && el("lsCustomerInfo").open === false);
  el("lsName").value = "Walk-in Lee";
  made = await record(closed);
  ok("…and its sale sends no customerId, whoever the form was opened for", !!made.body && !("customerId" in made.body) && !!made.row && made.row.customerId === null && made.row.customerName === "Walk-in Lee");
  ok("…having never asked for a customer", searches().length === 0);

  ok("nothing a customer's name carried was ever run", w.__xss === undefined);
  const { passed, failed } = require("./testlib/check").counts();
  console.log(`\n${failed ? "FAIL" : "PASS"} — ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); console.log("test308 crashed: false"); process.exit(1); });
