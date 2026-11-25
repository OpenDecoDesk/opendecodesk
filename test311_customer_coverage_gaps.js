const fs = require("fs");
const { ok, counts } = require("./testlib/check");
const { storefrontPage } = require("./testlib/storefront-page");
const { autoConfirm } = require("./testlib/confirm.js");
const { createD1 } = require("./testlib/d1-shim.js");
const { adminAs, asRole, effectivePermissions, DEFAULT_ROLES } = require("./testlib/roles");
const { JSDOM, ResourceLoader, VirtualConsole } = require("jsdom");

// Customer records (migrations/0108): the branches the other customer tests (test300–test310) leave untaken.
//   orders.js — the audit rows of archiving and merging when a customer has no name, no company or no email;
//   admin-customers.js — "Show archived" kept when coming back to the list, a change event from the search box,
//     a click on the customer's page that isn't on a button, a customer with only an email in the merge search,
//     a failed merge search answered late, a click in the merge list that isn't on a customer;
//   admin.js adminCanOpenPage_ — an empty address is not the Customers page.
// Real SQL (sql.js) under the real db.js and orders.js; public/admin.js and admin-customers.js in jsdom. Invented data only.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + "\nreturn { insertOrder, createProduct };")();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  strip(read("functions/_lib/permissions.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'olive@example.test';\n" + adminAs({ roleFrom: "globalThis.__test311Role" }) + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
const pause = (ms) => new Promise(r => setTimeout(r, ms));
const wait = async (cond, n = 400) => { for (let i = 0; i < n && !cond(); i++) await pause(10); return !!cond(); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  globalThis.__test311Role = "admin";
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  // One request; the audit rows it leaves for after the answer (waitUntil) are written before this returns.
  const call = async (body) => {
    const waits = [];
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => waits.push(Promise.resolve(p).catch(() => {})),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    await Promise.all(waits);
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const auditOf = (action) => d1.q("SELECT * FROM audit_log ORDER BY id").filter(r => r.action === action).map(r => JSON.parse(r.detail || "null"));
  const lastAudit = (action) => { const all = auditOf(action); return all[all.length - 1] || null; };
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Example Club','t','t');`);
  await lib.createProduct(d1, "acme", { productId: "cap", type: "cap", name: "Club cap", pricingMode: "flat", flatPrice: 20, visible: true, noDesignNeeded: true });
  const newCustomer = async (fields) => (await call(Object.assign({ action: "saveCustomer" }, fields))).body.id;
  const clubId = await newCustomer({ name: "", company: "Example Boosters", email: "", phone: "555-0110" });
  const samId = await newCustomer({ name: "Sam Sample", company: "", email: "sam@example.com", phone: "" });
  const patId = await newCustomer({ name: "Pat Example", company: "", email: "pat@example.com", phone: "555-0101" });
  const dupId = await newCustomer({ name: "Pat Duplicate", company: "", email: "pat.dup@example.com", phone: "" });
  const robinId = await newCustomer({ name: "Robin Archived", company: "", email: "robin@example.com", phone: "" });
  // An order with an email and no name: its customer has only the email.
  await lib.insertOrder(d1, { orderId: "E1", orgId: "acme", customerName: "", contact: "lee@example.com", paymentMethod: "Cash", placedAt: "2026-03-05T15:00:00.000Z" },
    [{ productId: "cap", name: "Club cap", type: "cap", size: "OSFA", qty: 1, unitPrice: 20 }]);
  const leeId = d1.q("SELECT customerId FROM orders WHERE orderId = 'E1'")[0].customerId;
  const custRow = (id) => d1.q("SELECT * FROM customers WHERE id = ?", id)[0] || null;
  ok("the test's own data: a customer with only a company, two with only a name, and one with only an email",
    [clubId, samId, patId, dupId, robinId, leeId].every(n => Number.isInteger(n) && n > 0) && custRow(leeId).name === "" && custRow(leeId).company === "" && custRow(leeId).email === "lee@example.com");

  console.log("=== The audit rows of archiving and merging, for a customer missing a name, a company or an email ===");
  let r = await call({ action: "setCustomerArchived", id: clubId, archived: true });
  ok("archiving a customer with only a company logs its empty name as \"\" and its company", r.status === 200 && r.body.status === "ok" &&
    same(lastAudit("customer.archived"), { customerId: clubId, name: "", company: "Example Boosters" }));
  r = await call({ action: "setCustomerArchived", id: clubId, archived: false });
  ok("…and restoring it logs the same", r.status === 200 && same(lastAudit("customer.restored"), { customerId: clubId, name: "", company: "Example Boosters" }) && custRow(clubId).archivedAt == null);
  r = await call({ action: "setCustomerArchived", id: samId, archived: true });
  ok("archiving a customer with only a name logs its empty company as \"\"", r.status === 200 && same(lastAudit("customer.archived"), { customerId: samId, name: "Sam Sample", company: "" }));
  await call({ action: "setCustomerArchived", id: samId, archived: false });
  r = await call({ action: "mergeCustomers", fromId: dupId, intoId: clubId });
  const merged = lastAudit("customer.merged");
  ok("merging into a customer with no name and no email logs the kept customer as \"\", its company and \"\"", r.status === 200 && r.body.status === "ok" &&
    !!merged && merged.fromId === dupId && merged.intoId === clubId && same(merged.into, { name: "", company: "Example Boosters", email: "" }) && merged.from.name === "Pat Duplicate");
  ok("…the merge itself happened: the duplicate points at the kept customer, which took its email", custRow(dupId).mergedIntoId === clubId && custRow(clubId).email === "pat.dup@example.com");
  await call({ action: "setCustomerArchived", id: robinId, archived: true });

  // ---- The admin page ------------------------------------------------------------------------------------------
  const adminJs = read("public/admin.js"), customersJs = read("public/admin-customers.js");
  const sent = [];
  let hook = null;   // (body) => { gate, status, body } for the next requests it answers, or null
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
  class Loader extends ResourceLoader {
    fetch(url) {
      if (url.includes("/admin-customers.js")) return Promise.resolve(Buffer.from(customersJs));
      if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs));
      return Promise.resolve(Buffer.from(""));
    }
  }
  const vc = new VirtualConsole();
  vc.sendTo(console, { omitJSDOMErrors: true });
  vc.on("jsdomError", (e) => { if (!/Not implemented/.test(e.message)) console.error(e); });
  const dom = new JSDOM(storefrontPage(), { runScripts: "dangerously", resources: new Loader(), virtualConsole: vc, url: "https://admin.example.com/#abortreasons", pretendToBeVisual: true,
    beforeParse(win) {
      autoConfirm(win, () => true);
      win.CSS = win.CSS || { escape: (s) => String(s).replace(/["\\]/g, "\\$&") };
      win.scrollTo = () => {};
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
  const toasts = [];
  w.showToast = (m, isErr) => toasts.push({ m: String(m), err: !!isErr });
  w.eval('adminKey = "cookie"; adminOrgs = [{ orgId: "acme", name: "Example Club" }]; adminTimeZone = "UTC";' + asRole("admin", { name: "Olive", email: "olive@example.test" }));

  const $ = (sel) => d.querySelector(sel);
  const lists = () => sent.filter(b => b.action === "listCustomers");
  const listShown = () => !!$("#custPage #custQ") && !!$("#custBody") && !/Loading/.test($("#custBody").textContent);
  const rowNames = () => [...d.querySelectorAll("#custBody tr[data-cust-id] a.cust-link")].map(a => a.textContent);
  const go = async (hash, until) => { w.location.hash = hash; return wait(until); };
  const leave = async () => { w.location.hash = "#abortreasons"; await wait(() => !$("#custPage") && w.eval("_currentAdminHash") === "abortreasons"); await pause(20); };
  const onePage = () => !!$("#custPage #custForm");
  const modal = () => { const all = [...d.querySelectorAll(".admin-modal")]; return all[all.length - 1] || null; };

  console.log("\n=== The list: \"Show archived\" is kept, and the search box's change event is not the tick box's ===");
  await go("#customers", listShown);
  ok("the list starts without archived customers", !rowNames().includes("Robin Archived") && $("#custShowArchived").checked === false);
  { const n = lists().length;
    $("#custShowArchived").click();
    await wait(() => lists().length === n + 1 && rowNames().includes("Robin Archived"));
    ok("ticking Show archived lists the archived customer too", lists()[lists().length - 1].includeArchived === true && rowNames().includes("Robin Archived")); }
  await go("#customers/" + patId, onePage);
  await leave();
  sent.length = 0;
  await go("#customers", listShown);
  ok("coming back to the list, Show archived is still ticked", $("#custShowArchived").checked === true);
  ok("…and the list is asked for with archived customers, and shows them", lists().length === 1 && lists()[0].includeArchived === true && rowNames().includes("Robin Archived"));
  await pause(150);
  { sent.length = 0;
    const box = $("#custQ"), before = rowNames().join("|");
    box.value = "Pat";
    box.dispatchEvent(new w.Event("change", { bubbles: true }));
    await pause(350);
    ok("a change event from the search box (leaving it after typing) neither reloads the list nor touches Show archived",
      lists().length === 0 && $("#custShowArchived").checked === true && rowNames().join("|") === before && before.includes("Robin Archived")); }
  $("#custShowArchived").click();
  await wait(() => !rowNames().includes("Robin Archived"));

  console.log("\n=== A customer's page: a click that isn't on a button ===");
  await go("#customers/" + patId, onePage);
  { sent.length = 0; toasts.length = 0;
    const before = $("#custPage").innerHTML, hash = w.location.hash, errors = [];
    // The page's click handler is async: a mistake in it would be a rejected promise, caught here.
    const onError = (e) => { errors.push(String(e && e.message)); };
    process.on("unhandledRejection", onError);
    $("#custPage .cust-name").click();
    $("#custPage .cust-totals").click();
    await pause(60);
    process.off("unhandledRejection", onError);
    ok("clicking the name or the totals does nothing: nothing sent, no message, no error, the page and its address as they were",
      errors.length === 0 && sent.length === 0 && toasts.length === 0 && $("#custPage").innerHTML === before && w.location.hash === hash && !modal()); }

  console.log("\n=== Merge: a customer with only an email, a late failed search, a click beside the customers ===");
  const openMerge = async () => { $("#custMerge").click(); await wait(() => modal() && modal().querySelector("#custMergeQ")); };
  const mq = () => modal().querySelector("#custMergeQ"), mlist = () => [...modal().querySelectorAll("#custMergeList button")];
  const mstatus = () => modal().querySelector("#custMergeStatus").textContent;
  const type = (text) => { mq().value = text; mq().dispatchEvent(new w.Event("input", { bubbles: true })); };
  const search = async (text) => { const n = lists().length; type(text); await wait(() => lists().length === n + 1); await pause(60); };
  await openMerge();
  await search("lee@");
  ok("a customer with only an email is offered by the email, which isn't repeated under it", mlist().length === 1 && mlist()[0].querySelector("b").textContent === "lee@example.com" &&
    mlist()[0].querySelector("span").textContent === "1 order" && mstatus() === "1 customer found");
  await search("Boosters");
  ok("…a customer with a company and no name is offered by the company, with its email under it", mlist().length === 1 && mlist()[0].querySelector("b").textContent === "Example Boosters" &&
    mlist()[0].querySelector("span").textContent === "pat.dup@example.com · 555-0110 · 0 orders");
  { const pick = modal().querySelector("#custMergePick"), confirm = modal().querySelector("#custMergeConfirm"), list = modal().querySelector("#custMergeList");
    list.click();
    await pause(30);
    ok("a click in the results that isn't on a customer picks nothing: the question isn't asked and the results stay", confirm.hidden === true && pick.hidden === false && mlist().length === 1 &&
      sent.filter(b => b.action === "mergeCustomers").length === 0); }
  { let release; const gate = new Promise(res => { release = res; });
    hook = (b) => b.action === "listCustomers" && b.q === "Sam" ? (hook = null, { gate, status: 500, body: { status: "error", message: "The search isn't available right now." } }) : null;
    const n = lists().length;
    type("Sam"); await wait(() => lists().length === n + 1);
    await search("lee@");
    release(); await pause(120);
    ok("a search that fails after a newer one was answered doesn't replace the newer results with its error",
      mlist().length === 1 && mlist()[0].querySelector("b").textContent === "lee@example.com" && mstatus() === "1 customer found"); }
  { let release; const gate = new Promise(res => { release = res; });
    hook = (b) => b.action === "listCustomers" && b.q === "Sam" ? (hook = null, { gate, status: 500, body: { status: "error", message: "The search isn't available right now." } }) : null;
    const n = lists().length;
    type("Sam"); await wait(() => lists().length === n + 1);
    const m = modal(), listBefore = m.querySelector("#custMergeList").innerHTML;
    m.querySelector("[data-modal-close]").click(); await wait(() => !m.isConnected);
    release(); await pause(120);
    ok("a search that fails after the window was closed writes nothing into it", !m.isConnected && m.querySelector("#custMergeStatus").textContent === "1 customer found" &&
      m.querySelector("#custMergeList").innerHTML === listBefore && !modal() && sent.filter(b => b.action === "mergeCustomers").length === 0); }

  console.log("\n=== adminCanOpenPage_: an empty address is not Customers ===");
  w.eval("adminPerms = " + JSON.stringify(Object.assign({}, effectivePermissions(DEFAULT_ROLES.admin), { "customers.records": "none" })) + ";");
  ok("for a role without Customers, Customers can't be opened but an empty address (the first page) still can",
    w.adminCanOpenPage_("customers") === false && w.adminCanOpenPage_("#/customers/3") === false && w.adminCanOpenPage_("") === true && w.adminCanOpenPage_(undefined) === true);
  w.eval(asRole("admin", { name: "Olive", email: "olive@example.test" }));
  ok("…and with Customers back, both can", w.adminCanOpenPage_("customers") === true && w.adminCanOpenPage_("") === true);

  const c = counts();
  console.log(`\n${c.failed ? "FAIL" : "PASS"} — ${c.passed} passed, ${c.failed} failed`);
  process.exit(c.failed ? 1 : 0);
})().catch((e) => { console.error(e); console.log("test311 crashed: false"); process.exit(1); });
