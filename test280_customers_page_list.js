const fs = require("fs");
const { ok, counts } = require("./testlib/check");
const { storefrontPage } = require("./testlib/storefront-page");
const { autoConfirm } = require("./testlib/confirm.js");
const { createD1 } = require("./testlib/d1-shim.js");
const { adminAs, asRole, effectivePermissions, DEFAULT_ROLES } = require("./testlib/roles");
const { JSDOM, ResourceLoader, VirtualConsole } = require("jsdom");

// The Customers page (public/admin-customers.js, migrations/0105): its LIST screen and how the admin gets to it.
// The real admin.js draws it in jsdom, with the real orders.js / db.js on sql.js behind its requests:
//   - the address: #customers and #/customers, an id that isn't a customer's number, the script loaded once (and
//     tried again after it couldn't load), renderCustomers the one name the file adds
//   - the list: the empty state, the columns, the Exempt and Archived tags, what a customer is called when it has no
//     name, the count line, everything typed drawn as text
//   - the search: sent once typing pauses (the page's 250 ms timer is held here and fired by hand, so no check waits
//     on the clock), by name, company, email or phone; an older, slower answer never replaces a newer one
//   - Show archived, paging past 50, a row opening the customer, the list remembered while the admin is open
//   - "+ New customer": its fields and labels, what it refuses, the server's refusal shown, Cancel / Escape, where
//     the keyboard focus goes, the new customer's page opening
//   - a role with Read only (no New button) and a role without Customers at all
// Invented people and businesses only. Dates shown are compared in a time zone this test sets (UTC).
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + "\nreturn { insertOrder, createProduct };")();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async (env, host, key, request, msg, spec) => { const u = adminUser(request); if (!u) return jsonResponse({ status: 'error', message: 'Sign-in required' }, 403);\n" +
  "  for (const e of (Array.isArray(spec) ? spec : [])) if (Array.isArray(e) && !adminCan(request, e[0], e[1])) return jsonResponse({ status: 'error', code: 'forbidden', message: \"Your role can't do that.\" }, 403); return null; };\n" +
  "const adminActor = () => 'tester@example.test';\n" + adminAs({ roleFrom: "globalThis.__role" }) + "\n" + strip(read("functions/_lib/permissions.js")) + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
const pause = (ms) => new Promise(r => setTimeout(r, ms));
const wait = async (cond, n = 500) => { for (let i = 0; i < n && !cond(); i++) await pause(10); return !!cond(); };
const section = (t) => console.log("=== " + t + " ===");

(async () => {
  globalThis.__role = "admin";
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Example Club','t','t');`);
  await lib.createProduct(d1, "acme", { productId: "cap", type: "cap", name: "Club cap", pricingMode: "flat", flatPrice: 20, visible: true, noDesignNeeded: true });
  const call = async (body) => {
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => Promise.resolve(p).catch(() => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const rowsInDb = (sql, params) => { const st = d1._raw.prepare(sql); st.bind(params || []); const out = []; while (st.step()) out.push(st.getAsObject()); st.free(); return out; };

  // ---- The page ------------------------------------------------------------------------------------------------
  const adminJs = read("public/admin.js"), customersJs = read("public/admin-customers.js");
  const sent = [], toasts = [], pageLoads = [], asks = [];
  let pageScript = "ok", confirmAnswer = true;
  // What a request is answered with, in place of the handler: hook(body) gives nothing (the handler answers), or
  // { status, body } (a scripted answer), either one after `gate` (a promise) when it has one.
  let hook = null;
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
  class Loader extends ResourceLoader {
    fetch(url) {
      if (url.includes("/admin-customers.js")) { pageLoads.push(url); return pageScript === "fail" ? Promise.reject(new Error("offline")) : Promise.resolve(Buffer.from(customersJs)); }
      if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs));
      return Promise.resolve(Buffer.from(""));
    }
  }
  // The one jsdom complaint this test causes on purpose (the page's script refused once) is dropped.
  const vc = new VirtualConsole();
  vc.sendTo(console, { omitJSDOMErrors: true });
  vc.on("jsdomError", (e) => { if (!/Could not load script: "https:\/\/admin\.example\.com\/admin-customers\.js"/.test(e.message)) console.error(e); });
  const dom = new JSDOM(storefrontPage(), { runScripts: "dangerously", resources: new Loader(), virtualConsole: vc, url: "https://admin.example.com/#abortreasons", pretendToBeVisual: true,
    beforeParse(win) {
      autoConfirm(win, (m) => { asks.push(m); return confirmAnswer; });
      win.CSS = win.CSS || { escape: (s) => String(s).replace(/["\\]/g, "\\$&") };
      win.fetch = async (url, init) => {
        const u = String(url), b = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
        if (!u.includes("/api/orders")) return reply(404, { status: "error", message: "not here" });
        sent.push(b);
        const h = hook ? hook(b) : null;
        if (h && h.gate) await h.gate;
        if (h && h.body) return reply(h.status || 200, h.body);
        const x = await call(b);
        return reply(x.status, x.body);
      };
    } });
  const w = dom.window, d = w.document;
  await pause(150);
  await w.loadAdminScript();
  w.showToast = (m, isErr) => toasts.push({ m: String(m), err: !!isErr });
  w.eval('adminKey = "cookie"; adminOrgs = [{ orgId: "acme", name: "Example Club" }]; adminTimeZone = "UTC";' + asRole("admin", { name: "Tester", email: "tester@example.test" }));

  // The search's timer, held: a 250 ms timer the page starts is kept here until the test fires it; every other
  // timer runs as usual. What was asked for is recorded either way.
  const held = new Map(); let heldSeq = 0; const timersAsked = [];
  const realSet = w.setTimeout.bind(w), realClear = w.clearTimeout.bind(w);
  w.setTimeout = (fn, ms, ...rest) => { if (ms !== 250) return realSet(fn, ms, ...rest); timersAsked.push(ms); const id = "held" + (++heldSeq); held.set(id, fn); return id; };
  w.clearTimeout = (id) => { if (typeof id === "string" && id.startsWith("held")) { held.delete(id); return; } return realClear(id); };
  const fireSearch = () => { const fns = [...held.values()]; held.clear(); fns.forEach(fn => fn()); return fns.length; };

  const app = () => d.getElementById("app");
  const $ = (sel) => d.querySelector(sel);
  const rows = () => [...d.querySelectorAll("#custBody tr[data-cust-id]")];
  const names = () => rows().map(tr => tr.querySelector("a.cust-link").textContent);
  const cells = (tr) => [...tr.children].map(td => td.textContent.trim());
  const rowOf = (name) => rows().find(tr => tr.querySelector("a.cust-link").textContent === name);
  const lists = () => sent.filter(b => b.action === "listCustomers");
  const lastList = () => lists()[lists().length - 1];
  const note = () => ($("#custBody .cust-note") || { textContent: "" }).textContent;
  const listShown = () => !!$("#custPage #custQ") && !/Loading/.test(note());
  const reset = () => { sent.length = 0; toasts.length = 0; asks.length = 0; };
  const go = async (hash, until) => { w.location.hash = hash; return wait(until || listShown); };
  const leave = async () => { w.location.hash = "#abortreasons"; await wait(() => !$("#custPage") && w.location.hash === "#abortreasons" && w.eval("_currentAdminHash") === "abortreasons"); await pause(20); };
  const type = (text) => { const q = $("#custQ"); q.value = text; q.dispatchEvent(new w.Event("input", { bubbles: true })); };
  const search = async (text) => { const before = lists().length; type(text); fireSearch(); await wait(() => lists().length > before); await wait(() => listShown()); await pause(20); };
  const settled = () => pause(40);

  // ================================================================================================================
  section("Getting to the page");
  ok("before Customers is opened its script hasn't been asked for and there is no renderCustomers", pageLoads.length === 0 && typeof w.renderCustomers === "undefined");
  pageScript = "fail";
  await go("#customers", () => /Couldn't load the Customers page/.test(app().textContent));
  ok("when the page's script can't load, the admin says so and what to do", /Couldn't load the Customers page\. Check your connection and reload the page\./.test(app().textContent));
  ok("…and nothing was asked of the server", lists().length === 0);
  pageScript = "ok";
  await leave();
  reset();
  // Every function the page has by name, before the script is in (an element's id is a name on the page too: not counted).
  const fnNames = () => Object.getOwnPropertyNames(w).filter(n => typeof w[n] === "function");
  const namesBefore = new Set(fnNames());
  await go("#customers");
  ok("#customers shows the Customers list", !!$("#custPage") && $("#app h1").textContent === "Customers");
  ok("…asking for /admin-customers.js again after the load that failed", pageLoads.length === 2 && pageLoads.every(u => /^https:\/\/admin\.example\.com\/admin-customers\.js$/.test(u)));
  ok("the tab's title names the page", / — Customers \(Admin\)$/.test(d.title));
  const added = fnNames().filter(n => !namesBefore.has(n));
  ok("the script adds renderCustomers to the page", typeof w.renderCustomers === "function" && added.includes("renderCustomers"));
  ok("…and no other name (its helpers stay inside it)", added.join(",") === "renderCustomers" &&
    w.eval('typeof renderList + typeof showNewCustomer + typeof listView + typeof custLabel + typeof PAGE_SIZE + typeof CUST_FN') === "undefined".repeat(6));

  section("An empty list");
  ok("with no customers the page says so, and how one comes to be", note() === "No customers yet. A customer is added when an order comes in with an email address, or with “+ New customer”.");
  ok("…with no table, no count and no paging buttons", !$("#custBody table") && $("#custCount").textContent === "" && $("#custPager").innerHTML.trim() === "");
  ok("the list is asked for a page of 50 from the start, without archived customers", JSON.stringify([lastList().q, lastList().includeArchived, lastList().limit, lastList().offset]) === '["",false,50,0]');

  // ---- Customers --------------------------------------------------------------------------------------------------
  const add = async (c) => { const r = await call(Object.assign({ action: "saveCustomer", address: null, notes: "", taxExempt: false, taxExemptCertificate: "", taxExemptExpires: "" }, c)); if (r.status !== 200) throw new Error("seed: " + JSON.stringify(r.body)); return r.body.id; };
  const XSS = { name: "<script>window.__pwned = 1</script>", company: "\"><img src=x onerror=\"window.__pwned = 2\">", email: "\"<i>x</i>\"@example.com", phone: "'\"><b>555-0144</b>" };
  const alexId = await add({ name: "Alex Rivera", company: "Example Club", email: "alex@example.com", phone: "555-0100" });
  const blakeId = await add({ name: "Blake Stone", company: "Sample Works", email: "blake@example.org", phone: "555-0111", taxExempt: true, taxExemptCertificate: "CERT-1" });
  const guildId = await add({ name: "", company: "Thread Guild", email: "", phone: "555-0122" });
  const oldId = await add({ name: "Old Account", company: "", email: "dana@example.net", phone: "555-0133" });
  const xssId = await add(XSS);
  await call({ action: "setCustomerArchived", id: oldId, archived: true });
  d1._raw.run("INSERT INTO customers (name, company, email, phone, createdAt, updatedAt) VALUES ('', '', 'onlymail@example.com', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')");
  d1._raw.run("INSERT INTO customers (name, company, email, phone, createdAt, updatedAt) VALUES ('', '', '', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')");
  const blankId = rowsInDb("SELECT id FROM customers WHERE name = '' AND company = '' AND email = ''")[0].id;
  const order = (orderId, placedAt) => lib.insertOrder(d1, { orderId, orgId: "acme", customerName: "Alex Rivera", contact: "alex@example.com", paymentMethod: "Venmo", placedAt },
    [{ productId: "cap", name: "Club cap", type: "cap", size: "OSFA", qty: 1, unitPrice: 20 }]);
  await order("A1", "2026-03-05T15:00:00.000Z");
  await order("A2", "2026-04-09T15:00:00.000Z");
  const dateShown = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "numeric", day: "numeric", timeZone: "UTC" }).format(new Date("2026-04-09T15:00:00.000Z"));

  section("The list");
  await leave(); reset();
  await go("#/customers");
  ok("#/customers shows the list too, and the address becomes #customers", listShown() && w.location.hash === "#customers");
  ok("…without loading the script a second time", pageLoads.length === 2 && d.querySelectorAll('script[src="/admin-customers.js"]').length === 1);
  const heads = [...d.querySelectorAll("#custBody thead th")].map(th => th.textContent);
  ok("the table's columns are Name, Company, Email, Phone, Orders and Last order", heads.join("|") === "Name|Company|Email|Phone|Orders|Last order");
  ok("every customer that isn't archived has a row", rows().length === 6 && !rowOf("Old Account"));
  ok("…and the count under the search says how many", $("#custCount").textContent === "6 customers");
  ok("…announced to a screen reader when it changes", $("#custCount").getAttribute("role") === "status" && $("#custCount").getAttribute("aria-live") === "polite");
  ok("no paging buttons while everything fits on one page", $("#custPager").innerHTML.trim() === "");
  const alex = rowOf("Alex Rivera");
  ok("a row shows the customer's name, company, email and phone", !!alex && cells(alex).slice(0, 4).join("|") === "Alex Rivera|Example Club|alex@example.com|555-0100");
  ok("…how many orders they have", cells(alex)[4] === "2");
  ok("…and the day of the latest one", cells(alex)[5] === dateShown && dateShown.length > 5);
  ok("a customer with no orders shows 0 and no date", cells(rowOf("Blake Stone"))[4] === "0" && cells(rowOf("Blake Stone"))[5] === "");
  ok("the name is a link to the customer's page", alex.querySelector("a.cust-link").getAttribute("href") === "#customers/" + alexId && alex.dataset.custId === String(alexId));
  const exemptTags = (tr) => [...tr.querySelectorAll(".cust-tag")].map(t => t.textContent);
  ok("a tax-exempt customer is tagged Exempt", exemptTags(rowOf("Blake Stone")).join("|") === "Exempt" && !!rowOf("Blake Stone").querySelector(".cust-tag-exempt"));
  ok("…and nobody else is", rows().filter(tr => tr.querySelector(".cust-tag-exempt")).length === 1 && exemptTags(alex).length === 0);
  ok("a customer with only a company is called by the company", !!rowOf("Thread Guild") && cells(rowOf("Thread Guild"))[1] === "Thread Guild");
  ok("a customer with only an email is called by the email", !!rowOf("onlymail@example.com"));
  ok("a customer with nothing to call it by is \"Customer\" and its number", !!rowOf("Customer " + blankId));
  ok("customers are in name order, a company standing in for a missing name", names().indexOf("Alex Rivera") < names().indexOf("Blake Stone") && names().indexOf("Blake Stone") < names().indexOf("Thread Guild"));

  section("What was typed is shown as text");
  const x = rowOf(XSS.name);
  ok("a name with a <script> in it is drawn as its characters", !!x && x.querySelector("a.cust-link").children.length === 0);
  ok("…so are a company, an email and a phone with quotes and tags", !!x && cells(x).slice(1, 4).join("|") === [XSS.company, XSS.email, XSS.phone].join("|"));
  ok("…none of it became an element or ran", !d.querySelector("#custBody script, #custBody img, #custBody b, #custBody i") && w.__pwned === undefined);
  ok("nothing on the page has an inline handler", [...d.querySelectorAll("#custPage, #custPage *")].every(el => [...el.attributes].every(a => !/^on/i.test(a.name))));

  section("The controls");
  const q = $("#custQ"), arch = $("#custShowArchived"), newBtn = $("#custNew");
  ok("the search box is labelled Search", q.type === "search" && q.labels.length === 1 && q.labels[0].textContent.trim() === "Search");
  ok("…and says what it looks in", q.placeholder === "Name, company, email or phone" && q.getAttribute("maxlength") === "200");
  ok("the tick box is labelled Show archived, and starts off", arch.type === "checkbox" && arch.labels.length === 1 && arch.labels[0].textContent.trim() === "Show archived" && arch.checked === false);
  ok("the + New customer button is there for a role that may edit customers", newBtn.textContent === "+ New customer" && newBtn.type === "button" && !newBtn.hasAttribute("data-perm-off") && newBtn.getAttribute("data-need") === "customers.records:edit");

  section("Searching");
  reset(); timersAsked.length = 0;
  type("b"); type("bl"); type("blake");
  await settled();
  ok("typing sends nothing at once", lists().length === 0);
  ok("…it waits a quarter of a second after each key, dropping the wait before it", timersAsked.join(",") === "250,250,250" && held.size === 1);
  fireSearch();
  await wait(() => lists().length === 1 && names().length === 1);
  ok("once typing pauses, one search is sent with what the box holds", lists().length === 1 && lastList().q === "blake" && lastList().offset === 0 && lastList().limit === 50);
  ok("a search by name shows the customers it matches, whatever the capitals", names().join("|") === "Blake Stone" && $("#custCount").textContent === "1 customer");
  await search("thread gui");
  ok("a search by company finds the customer", names().join("|") === "Thread Guild");
  await search("ALEX@EXAMPLE");
  ok("a search by email finds the customer", names().join("|") === "Alex Rivera");
  await search("555-0111");
  ok("a search by phone finds the customer", names().join("|") === "Blake Stone");
  await search("   stone   ");
  ok("spaces around what was typed are left out of the search", lastList().q === "stone" && names().join("|") === "Blake Stone");
  await search("no such person");
  ok("a search that matches nobody says so", note() === "No customer matches that search." && !$("#custBody table") && $("#custCount").textContent === "" && $("#custPager").innerHTML.trim() === "");
  await search("old account");
  ok("an archived customer isn't found while Show archived is off", note() === "No customer matches that search.");
  await search("");
  ok("clearing the box brings everyone back", rows().length === 6 && lastList().q === "");

  section("Answers that arrive out of order");
  {
    let release; const gate = new Promise(r => { release = r; });
    hook = (b) => b.action === "listCustomers" && b.q === "alex" ? { gate } : null;
    reset();
    type("alex"); fireSearch();                       // this answer is held back
    await wait(() => lists().length === 1);
    type("blake"); fireSearch();                      // …while this one comes straight away
    await wait(() => names().join("|") === "Blake Stone");
    ok("a newer search is drawn while an older one is still on its way", names().join("|") === "Blake Stone" && lists().length === 2);
    release(); await settled(); await settled();
    ok("…and the older answer, arriving late, doesn't replace it", names().join("|") === "Blake Stone" && $("#custCount").textContent === "1 customer");
    hook = null;
  }
  {
    let release; const gate = new Promise(r => { release = r; });
    hook = (b) => b.action === "listCustomers" && b.q === "alex" ? { gate, status: 500, body: { status: "error", message: "The server tripped." } } : null;
    type("alex"); fireSearch();
    await pause(20);
    type("guild"); fireSearch();
    await wait(() => names().join("|") === "Thread Guild");
    release(); await settled(); await settled();
    ok("an older search that failed late doesn't replace a newer answer either", names().join("|") === "Thread Guild" && !$("#custBody .cust-err"));
    hook = null;
  }
  hook = (b) => b.action === "listCustomers" ? { status: 500, body: { status: "error", message: "The <b>server</b> tripped." } } : null;
  type("stone"); fireSearch();
  await wait(() => !!$("#custBody .cust-err"));
  ok("a search the server can't answer shows the server's message in place of the table", !!$("#custBody .cust-err") && $("#custBody .cust-err").textContent === "The <b>server</b> tripped." && $("#custBody .cust-err").getAttribute("role") === "alert" && !$("#custBody table"));
  ok("…with the count and the paging buttons cleared", $("#custCount").textContent === "" && $("#custPager").innerHTML.trim() === "");
  hook = null;
  {
    let release; const gate = new Promise(r => { release = r; });
    hook = (b) => b.action === "listCustomers" ? { gate } : null;
    await leave(); reset();
    w.location.hash = "#customers";
    await wait(() => lists().length === 1 && !!$("#custBody"));
    const bodyThen = $("#custBody");
    ok("the list says Loading… until its answer comes", bodyThen.textContent.trim() === "Loading…");
    ok("…with the search still in the box from before", $("#custQ").value === "stone");
    await leave();
    release(); await settled(); await settled();
    ok("an answer that comes after the admin has gone to another page draws nothing", bodyThen.textContent.trim() === "Loading…" && !$("#custPage"));
    hook = null;
  }
  await go("#customers");
  await search("");

  section("Show archived");
  reset(); timersAsked.length = 0;
  $("#custShowArchived").click();
  await wait(() => !!rowOf("Old Account"));
  ok("ticking Show archived asks again at once, archived customers included", lists().length === 1 && lastList().includeArchived === true && lastList().offset === 0 && timersAsked.length === 0);
  ok("…and the archived customer is listed, tagged Archived and greyed", !!rowOf("Old Account") && exemptTags(rowOf("Old Account")).join("|") === "Archived" && rowOf("Old Account").classList.contains("cust-row-archived"));
  ok("…among the others, who aren't tagged", rows().length === 7 && rows().filter(tr => tr.classList.contains("cust-row-archived")).length === 1 && $("#custCount").textContent === "7 customers");
  await search("old account");
  ok("an archived customer can now be searched for", names().join("|") === "Old Account");
  await search("");
  reset();
  $("#custShowArchived").click();
  await wait(() => lists().length === 1 && rows().length === 6);
  ok("unticking it hides archived customers again", lastList().includeArchived === false && !rowOf("Old Account") && rows().length === 6);

  section("More than one page");
  const stmt = d1._raw.prepare("INSERT INTO customers (name, company, email, phone, createdAt, updatedAt) VALUES (?, '', ?, ?, '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')");
  for (let i = 1; i <= 50; i++) { const n = String(i).padStart(2, "0"); stmt.run(["Member " + n, "member" + n + "@example.com", "555-02" + n]); }
  stmt.free();
  await leave(); reset();
  await go("#customers");
  const pagerBtn = (which) => $('#custPager button[data-cust-page="' + which + '"]');
  ok("with 56 customers the first 50 are listed", rows().length === 50 && lastList().limit === 50 && lastList().offset === 0);
  ok("…and the count says which ones", $("#custCount").textContent === "Showing 1–50 of 56 customers");
  ok("the paging buttons appear: Previous (nothing before, so off) and Next", !!pagerBtn("prev") && pagerBtn("prev").disabled === true && pagerBtn("prev").textContent === "‹ Previous" && pagerBtn("next").disabled === false && pagerBtn("next").textContent === "Next ›");
  const firstPage = names();
  reset();
  pagerBtn("next").click();
  await wait(() => lists().length === 1 && rows().length === 6);
  ok("Next asks for the customers after the first 50", lastList().offset === 50 && lastList().limit === 50);
  ok("…and shows the rest, none of them from the first page", rows().length === 6 && names().every(n => !firstPage.includes(n)) && $("#custCount").textContent === "Showing 51–56 of 56 customers");
  ok("…with Next off (nothing after) and Previous on", pagerBtn("next").disabled === true && pagerBtn("prev").disabled === false);
  reset();
  pagerBtn("prev").click();
  await wait(() => lists().length === 1 && rows().length === 50);
  ok("Previous goes back to the first 50", lastList().offset === 0 && names().join("|") === firstPage.join("|") && pagerBtn("prev").disabled === true);
  pagerBtn("next").click();
  await wait(() => rows().length === 6);
  reset();
  await search("member");
  ok("a search from a later page starts at its first page", lastList().offset === 0 && lastList().q === "member" && rows().length === 50 && $("#custCount").textContent === "50 customers");
  ok("…and exactly one page of matches has no paging buttons", $("#custPager").innerHTML.trim() === "");
  await search("");
  pagerBtn("next").click();
  await wait(() => rows().length === 6);
  reset();
  $("#custShowArchived").click();
  await wait(() => lists().length === 1 && rows().length === 50);
  ok("ticking Show archived from a later page starts at the first page too", lastList().offset === 0 && $("#custCount").textContent === "Showing 1–50 of 57 customers");
  $("#custShowArchived").click();
  await wait(() => $("#custCount").textContent === "Showing 1–50 of 56 customers");

  section("Coming back to the list");
  pagerBtn("next").click();
  await wait(() => rows().length === 6);
  await search("e");                                    // everyone on this list has an "e" somewhere
  pagerBtn("next").click();
  await wait(() => lastList().offset === 50 && /^Showing 51–/.test($("#custCount").textContent));
  const pageTwo = names();
  await leave(); reset();
  await go("#customers");
  ok("the list comes back with the same search in the box", $("#custQ").value === "e" && lastList().q === "e");
  ok("…on the same page of it", lastList().offset === 50 && names().join("|") === pageTwo.join("|"));
  // The customers of that second page are archived meanwhile: the page asked for is no longer there.
  d1._raw.run("UPDATE customers SET archivedAt = '2026-05-01T00:00:00.000Z' WHERE name LIKE 'Member 4%' OR name LIKE 'Member 5%' OR name LIKE 'Member 3%'");
  await leave(); reset();
  await go("#customers", () => listShown() && lists().length === 2);
  ok("when that page has emptied meanwhile, the list goes back to the first page", lists().map(b => b.offset).join(",") === "50,0" && rows().length > 0 && rows().length <= 50 && !!$("#custBody table"));
  d1._raw.run("UPDATE customers SET archivedAt = NULL WHERE name LIKE 'Member %'");
  await search("");
  // A search with markup in it, kept in the box when the list is drawn again.
  const nasty = "\"><b id=\"inj\">x</b>";
  await search(nasty);
  await leave();
  await go("#customers");
  ok("a search with quotes and tags in it is put back in the box as typed, not into the page", $("#custQ").value === nasty && !d.getElementById("inj") && note() === "No customer matches that search.");
  await search("");

  section("Opening a customer");
  const onePage = (name) => () => !!$("#custPage .cust-name") && $("#custPage .cust-name").textContent === name;
  rowOf("Alex Rivera").children[1].click();
  await wait(onePage("Alex Rivera"));
  ok("clicking anywhere on a row opens that customer", w.location.hash === "#customers/" + alexId && onePage("Alex Rivera")());
  await go("#customers");
  {
    const link = rowOf("Blake Stone").querySelector("a.cust-link");
    const stop = (e) => e.preventDefault();
    link.addEventListener("click", stop);
    link.click();
    await settled();
    ok("a click on the name is left to the link itself (the row doesn't also open the customer)", w.location.hash === "#customers" && !!$("#custQ"));
    link.removeEventListener("click", stop);
    link.click();
    await wait(onePage("Blake Stone"));
    ok("…and the link opens the customer", w.location.hash === "#customers/" + blakeId && onePage("Blake Stone")());
  }
  await go("#/customers/" + guildId, onePage("Thread Guild"));
  ok("#/customers/<number> opens that customer as well", onePage("Thread Guild")() && sent.some(b => b.action === "getCustomer" && b.id === guildId));
  for (const [bad, why] of [["abc", "a word"], ["0", "zero"], ["-3", "a negative number"], ["1.5", "a fraction"], ["12abc", "a number with letters after it"], ["", "nothing"]]) {
    await leave(); reset();
    await go("#customers/" + bad);
    ok("#customers/ followed by " + why + " shows the list", listShown() && rows().length > 0 && !sent.some(b => b.action === "getCustomer"));
  }
  for (const [bad, why] of [[null, "no id"], ["", "an empty id"], ["abc", "a word"], [0, "zero"], [-2, "a negative number"], [2.5, "a fraction"]]) {
    await leave(); reset();
    await w.renderCustomers(app(), bad);
    ok("renderCustomers called with " + why + " draws the list", listShown() && w.location.hash === "#customers" && !sent.some(b => b.action === "getCustomer"));
  }
  await leave(); reset();
  w.renderCustomers(app(), String(alexId));
  await wait(onePage("Alex Rivera"));
  ok("renderCustomers called with a customer's number draws that customer", onePage("Alex Rivera")() && sent.some(b => b.action === "getCustomer" && b.id === alexId));
  ok("through all of it the script was loaded once", pageLoads.length === 2 && d.querySelectorAll('script[src="/admin-customers.js"]').length === 1);

  section("+ New customer");
  await go("#customers");
  const dlg = () => d.querySelector(".admin-modal #custNewForm") && d.querySelector(".admin-modal #custNewForm").closest(".admin-modal");
  const field = (id) => d.getElementById(id);
  const fill = (id, v) => { const el = field(id); el.value = v; el.dispatchEvent(new w.Event("input", { bubbles: true })); };
  const submit = () => field("custNewForm").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
  const open = () => { $("#custNew").focus(); $("#custNew").click(); };
  const saves = () => sent.filter(b => b.action === "saveCustomer");
  const escape = () => d.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  reset();
  open();
  ok("+ New customer opens a window titled New customer", !!dlg() && dlg().querySelector("[data-dialog-title]").textContent === "New customer");
  const box = dlg().firstElementChild;
  ok("…a dialog for a screen reader, named by its title", box.getAttribute("role") === "dialog" && box.getAttribute("aria-modal") === "true" && d.getElementById(box.getAttribute("aria-labelledby")).textContent === "New customer");
  ok("its fields are Name, Company, Email and Phone", [...dlg().querySelectorAll("form input")].map(i => i.id + ":" + i.type).join("|") === "custNewName:text|custNewCompany:text|custNewEmail:email|custNewPhone:tel");
  ok("…each with its label", ["Name", "Company", "Email", "Phone"].every(l => { const i = field("custNew" + l); return i.labels.length === 1 && i.labels[0].textContent.trim() === l; }));
  ok("…and a limit on how much can be typed", ["custNewName", "custNewCompany", "custNewEmail"].every(id => field(id).getAttribute("maxlength") === "200") && field("custNewPhone").getAttribute("maxlength") === "50");
  ok("its buttons are Cancel and Create customer", field("custNewCancel").textContent === "Cancel" && field("custNewCancel").type === "button" && field("custNewSave").textContent === "Create customer" && field("custNewSave").type === "submit");
  ok("the keyboard focus starts in the Name field", d.activeElement === field("custNewName"));
  ok("nothing in the window has an inline handler", [...dlg().querySelectorAll("*")].every(el => [...el.attributes].every(a => !/^on/i.test(a.name))));
  field("custNewCancel").click();
  ok("Cancel closes it without saving anything", !dlg() && saves().length === 0 && w.location.hash === "#customers");
  ok("…and the focus goes back to the + New customer button", d.activeElement === $("#custNew"));
  open();
  escape();
  await wait(() => !dlg());
  ok("Escape closes an untouched window without asking", !dlg() && asks.length === 0 && d.activeElement === $("#custNew"));
  open();
  dlg().querySelector("[data-modal-close]").click();
  await wait(() => !dlg());
  ok("so does its ✕", !dlg() && asks.length === 0);
  open();
  fill("custNewName", "Half typed");
  confirmAnswer = false;
  escape();
  await wait(() => asks.length === 1);
  await settled();
  ok("once something is typed, Escape asks before throwing it away", asks.length === 1 && /^Discard changes\?/.test(asks[0]));
  ok("…and keeps the window when the answer is to keep editing", !!dlg() && field("custNewName").value === "Half typed");
  confirmAnswer = true;
  escape();
  await wait(() => !dlg());
  ok("…or closes it when the answer is Discard, saving nothing", !dlg() && asks.length === 2 && saves().length === 0);

  reset();
  open();
  const err = () => field("custNewErr").textContent;
  ok("the place for a problem is empty to start with, and is read out when it fills", err() === "" && field("custNewErr").getAttribute("role") === "alert");
  fill("custNewPhone", "555-0155");
  submit();
  await settled();
  ok("with neither a name nor a company it says to enter one", err() === "Enter a name or a company." && saves().length === 0);
  ok("…and puts the focus in Name", d.activeElement === field("custNewName"));
  fill("custNewName", "   ");
  fill("custNewCompany", "  ");
  submit();
  await settled();
  ok("spaces alone don't count as a name", err() === "Enter a name or a company." && saves().length === 0);
  fill("custNewName", "Casey Example");
  fill("custNewEmail", "casey-at-example");
  submit();
  await settled();
  ok("an email that isn't one is refused before anything is sent", err() === "That email address doesn't look right." && saves().length === 0);
  ok("…with the focus in Email", d.activeElement === field("custNewEmail"));
  fill("custNewEmail", "casey @example.com");
  submit();
  await settled();
  ok("…as is one with a space in it", err() === "That email address doesn't look right." && saves().length === 0);
  fill("custNewEmail", "ALEX@example.com");
  submit();
  await wait(() => saves().length === 1 && field("custNewSave").disabled === false && err() !== "");
  ok("the server's refusal is shown in the window (an email another customer has)", err() === "Another customer already has that email." && !!dlg());
  ok("…the button works again and nothing was created", field("custNewSave").disabled === false && rowsInDb("SELECT count(*) AS n FROM customers WHERE name = 'Casey Example'")[0].n === 0 && toasts.length === 0 && w.location.hash === "#customers");
  hook = (b) => b.action === "saveCustomer" ? { status: 503, body: { status: "error", message: "Customers aren't <ready> yet." } } : null;
  submit();
  await wait(() => saves().length === 2 && /ready/.test(err()));
  ok("any other refusal from the server is shown the same way, as text", err() === "Customers aren't <ready> yet." && field("custNewErr").children.length === 0 && !!dlg());
  hook = null;
  {
    let release; const gate = new Promise(r => { release = r; });
    hook = (b) => b.action === "saveCustomer" ? { gate } : null;
    reset();
    fill("custNewName", "  Casey Example  ");
    fill("custNewCompany", " Example Guild ");
    fill("custNewEmail", " casey@example.com ");
    fill("custNewPhone", " 555-0155 ");
    submit();
    await wait(() => saves().length === 1);
    ok("while it is being saved the button is off and the old problem is cleared", field("custNewSave").disabled === true && err() === "");
    const s = saves()[0];
    ok("what is sent is the four fields, trimmed", s.id === undefined && s.name === "Casey Example" && s.company === "Example Guild" && s.email === "casey@example.com" && s.phone === "555-0155");
    ok("…with no address, no notes and no tax exemption", s.address === null && s.notes === "" && s.taxExempt === false && s.taxExemptCertificate === "" && s.taxExemptExpires === "");
    release();
    hook = null;
  }
  await wait(onePage("Casey Example"));
  const casey = rowsInDb("SELECT * FROM customers WHERE email = 'casey@example.com'")[0];
  ok("the customer is created", !!casey && casey.name === "Casey Example" && casey.company === "Example Guild" && casey.phone === "555-0155" && casey.taxExempt === 0);
  ok("…the window closes and a message says so", !dlg() && toasts.length === 1 && toasts[0].m === "Customer created." && toasts[0].err === false);
  ok("…and the new customer's page opens", !!casey && w.location.hash === "#customers/" + casey.id && onePage("Casey Example")());
  await go("#customers");
  ok("back on the list, the new customer is there", !!rowOf("Casey Example") && cells(rowOf("Casey Example")).slice(1, 4).join("|") === "Example Guild|casey@example.com|555-0155");
  reset();
  open();
  fill("custNewCompany", "Stitch <b>Collective</b>");
  submit();
  await wait(() => !!$("#custPage .cust-name") && !dlg());
  const coll = rowsInDb("SELECT * FROM customers WHERE company = 'Stitch <b>Collective</b>'")[0];
  ok("a company alone is enough to create a customer", !!coll && coll.name === "" && coll.email === "" && w.location.hash === "#customers/" + coll.id);
  ok("…and its page shows the company as typed, tags and all, as text", $("#custPage .cust-name").textContent === "Stitch <b>Collective</b>" && $("#custPage .cust-name").children.length === 0);

  section("A role that may only read customers (Production)");
  globalThis.__role = "production";
  w.eval(asRole("production", { name: "Pat", email: "pat@example.test" }));
  await leave(); reset();
  await go("#customers");
  ok("the list opens and shows the customers", listShown() && !!rowOf("Alex Rivera") && lists().length === 1);
  ok("…with search and Show archived", !!$("#custQ") && !$("#custQ").disabled && !!$("#custShowArchived"));
  ok("…but no + New customer button", $("#custNew").hasAttribute("data-perm-off") && w.getComputedStyle($("#custNew")).display === "none");
  await search("blake");
  ok("searching still works", names().join("|") === "Blake Stone");
  await search("");
  rowOf("Alex Rivera").children[2].click();
  await wait(onePage("Alex Rivera"));
  ok("…and a row still opens the customer", onePage("Alex Rivera")() && w.location.hash === "#customers/" + alexId);

  section("A role that may edit customers (Back office)");
  globalThis.__role = "staff";
  w.eval(asRole("staff", { name: "Sam", email: "sam@example.test" }));
  await leave(); reset();
  await go("#customers");
  ok("the + New customer button is shown", !$("#custNew").hasAttribute("data-perm-off") && w.getComputedStyle($("#custNew")).display !== "none");
  open();
  fill("custNewName", "Robin Sample");
  submit();
  await wait(onePage("Robin Sample"));
  ok("…and creates a customer", rowsInDb("SELECT count(*) AS n FROM customers WHERE name = 'Robin Sample'")[0].n === 1 && onePage("Robin Sample")());

  section("A role without Customers");
  const none = Object.assign({}, effectivePermissions(DEFAULT_ROLES.production), { "customers.records": "none" });
  w.eval(asRole("production", { name: "Pat", email: "pat@example.test" }) + " adminPerms = " + JSON.stringify(none) + ";");
  await leave(); reset();
  w.location.hash = "#customers";
  await wait(() => /Not available to you/.test(app().textContent));
  ok("#customers says the page isn't available to them", /Not available to you/.test(app().textContent) && !$("#custPage"));
  ok("…and asks the server for nothing", lists().length === 0 && !sent.some(b => b.action === "getCustomer"));

  ok("nothing typed on the way ever ran as script", w.__pwned === undefined);
  const { passed, failed } = counts();
  console.log(`\n${failed ? "FAIL" : "PASS"} — ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); console.log("test280 crashed: false"); process.exit(1); });
