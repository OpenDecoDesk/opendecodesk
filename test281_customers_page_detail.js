const fs = require("fs");
const { storefrontPage } = require("./testlib/storefront-page");
const { createD1 } = require("./testlib/d1-shim.js");
const { ok, counts } = require("./testlib/check");
const roles = require("./testlib/roles");
const { JSDOM, ResourceLoader, VirtualConsole } = require("jsdom");

// One customer's page (public/admin-customers.js, #customers/<id>), run in the real admin page (jsdom) with the real
// admin.js in front of it and the real orders.js / db.js on sql.js behind it:
//   opening a customer (and an id nobody has, a merged-away id, an address that isn't a number);
//   the form and Save — every field, the address, what is refused here and by the server, what is shown again;
//   the Tax exemption box: changed with Full, read-only without (the save still goes through, sending what is stored);
//   the totals and the orders table (newest first, voided / test / completed marks, the link to the Orders page);
//   "New sale for this customer", Archive / Restore, "Merge into another customer…";
//   which buttons each built-in role is offered; that nothing typed is ever read as HTML; where focus goes.
// The page signs in as a built-in role (testlib/roles.js asRole) and the server answers as one (adminAs), each set by
// the test, so "the page offers it" and "the server allows it" can be told apart. Invented people and shops only.
// No check depends on today's date or this machine's time zone: stored times are fixed and the page is told UTC.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + "\nreturn { insertOrder };")();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  // The session check stands in for adminAuth.js: the role the test signed the server in as, held to the action's own
  // permission (ACTION_PERM), refusing in a sentence the way the real one does.
  "const requireAdmin = async (env, host, key, request, msg, need) => roleAllows(DEFAULT_ROLES[globalThis.__role281] || null, need) ? null : jsonResponse({ status: 'error', message: 'Your role can\\'t do that here.' }, 403);\n" +
  "const adminActor = () => 'owner@example.test';\n" + roles.adminAs({ roleFrom: "globalThis.__role281" }) + "\n" + strip(read("functions/_lib/permissions.js")) + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
const pause = (ms) => new Promise(r => setTimeout(r, ms));
const wait = async (cond, n = 500) => { for (let i = 0; i < n && !cond(); i++) await pause(10); return !!cond(); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
process.on("unhandledRejection", (e) => { console.error(e); ok("nothing in the test was left to fail unseen", false); });

(async () => {
  globalThis.__role281 = "admin";
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
  const row = (id) => d1.q("SELECT * FROM customers WHERE id = ?", id)[0];

  // ---- What is in the database ----------------------------------------------------------------------------------
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Example Club','t','t'), ('rec','rec','Rec League','t','t'), ('gone','gone','Closed Shop','t','t');`);
  const add = async (c) => {
    const r = await call(Object.assign({ action: "saveCustomer", name: "", company: "", email: "", phone: "", address: null, notes: "", taxExempt: false, taxExemptCertificate: "", taxExemptExpires: "" }, c));
    if (r.status !== 200) throw new Error("seed: " + JSON.stringify(r.body));
    return r.body.id;
  };
  const A = await add({ name: "Pat Example", company: "Example Club", email: "pat@example.com", phone: "555-0100", notes: "Likes navy thread.",
    address: { name: "Pat Example", line1: "1 Example Street", line2: "Unit 2", city: "Exampleville", state: "EX", zip: "00000", country: "US" } });
  const B = await add({ name: "Pat Other", email: "pat.e@example.com" });
  const C = await add({ company: "Example Supply Co" });
  const T = [];
  for (let i = 1; i <= 10; i++) T.push(await add(Object.assign({ name: "Sample Target " + String(i).padStart(2, "0") },
    i === 1 ? { company: "Example <Supply>", email: "t01@example.com", phone: "555-0101" } : {})));
  const ARCH = await add({ name: "Sample Target Archived" });
  await call({ action: "setCustomerArchived", id: ARCH, archived: true });
  const SPARE = await add({ name: "Spare Example", email: "spare@example.com" });
  d1._raw.run("UPDATE customers SET createdAt = '2025-06-15T12:00:00.000Z'");
  const order = (orderId, orgId, contact, placedAt, qty, price) => lib.insertOrder(d1, { orderId, orgId, customerName: "Pat Example", contact, paymentMethod: "Cash", placedAt },
    [{ productId: "cap", name: "Cap", type: "cap", size: "OSFA", qty, unitPrice: price }]);
  await order("O-1001", "acme", "pat@example.com", "2026-01-10T15:00:00.000Z", 2, 20);
  await order("O-1002", "rec", "pat@example.com", "2026-02-10T15:00:00.000Z", 1, 25);
  await order("O-1003", "acme", "pat@example.com", "2026-03-10T15:00:00.000Z", 1, 30);
  await order("O-1004", "acme", "pat@example.com", "2026-03-20T15:00:00.000Z", 1, 35);
  await order("O-1005", "gone", "pat@example.com", "2025-12-01T15:00:00.000Z", 1, 20);
  await order("O-2001", "acme", "pat.e@example.com", "2026-02-01T15:00:00.000Z", 1, 15);
  for (const id of ["O-1001", "O-1005"]) { const r = await call({ action: "markPaidManual", org: id === "O-1001" ? "acme" : "gone", orderId: id, requestId: "seed-" + id }); if (r.status !== 200) throw new Error("seed pay: " + JSON.stringify(r.body)); }
  d1._raw.run("UPDATE orders SET voidedAt = '2026-03-11T15:00:00.000Z' WHERE orderId = 'O-1003'");
  d1._raw.run("UPDATE orders SET isTest = 1 WHERE orderId = 'O-1004'");
  d1._raw.run("UPDATE orders SET completedAt = '2025-12-05T15:00:00.000Z' WHERE orderId = 'O-1005'");
  ok("(setting up) the five orders with Pat's email are linked to Pat's record, the sixth to the other Pat", d1.q("SELECT count(*) n FROM orders WHERE customerId = ?", A)[0].n === 5 && d1.q("SELECT count(*) n FROM orders WHERE customerId = ?", B)[0].n === 1);

  // ---- The page ---------------------------------------------------------------------------------------------------
  const adminJs = read("public/admin.js"), custJs = read("public/admin-customers.js");
  const sent = [], toasts = [], served = [];
  let scripted = null;   // { action, status, body }: the next request for that action is answered with this, not by the server
  let hold = null;       // { action, gate }: the next request for that action waits for gate before the server gets it
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
  class Loader extends ResourceLoader {
    fetch(url) {
      served.push(String(url));
      if (/\/admin-customers\.js(\?|$)/.test(url)) return Promise.resolve(Buffer.from(custJs));
      if (/\/admin\.js(\?|$)/.test(url)) return Promise.resolve(Buffer.from(adminJs));
      return Promise.resolve(Buffer.from(""));
    }
  }
  const vc = new VirtualConsole();
  vc.sendTo(console, { omitJSDOMErrors: true });
  vc.on("jsdomError", (e) => { if (!/Not implemented/.test(e.message)) console.error(e); });
  const dom = new JSDOM(storefrontPage(), { runScripts: "dangerously", resources: new Loader(), virtualConsole: vc, url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win) {
      win.CSS = win.CSS || { escape: (s) => String(s).replace(/["\\]/g, "\\$&") };
      win.fetch = async (url, init) => {
        const u = String(url), b = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
        if (!u.includes("/api/orders")) return reply(404, { status: "error", message: "not here" });
        sent.push(b);
        if (scripted && scripted.action === b.action) { const s = scripted; scripted = null; return reply(s.status || 200, s.body); }
        if (hold && hold.action === b.action) { const h = hold; hold = null; await h.gate; }
        const x = await call(b);
        return reply(x.status, x.body);
      };
    } });
  const w = dom.window, d = w.document;
  await pause(150);
  await w.loadAdminScript();
  w.showToast = (m, isErr) => toasts.push({ m: String(m), err: !!isErr });
  w.eval('adminKey = "cookie"; setAdminTimeZone_("UTC"); adminOrgs = [{ orgId: "acme", name: "Example Club" }, { orgId: "rec", name: "Rec <i>League</i>" }];');
  const q = (s) => d.querySelector(s), qa = (s) => [...d.querySelectorAll(s)];
  const app = d.getElementById("app");
  const page = () => d.getElementById("custPage");
  const reset = () => { sent.length = 0; toasts.length = 0; };
  const of = (action) => sent.filter(b => b.action === action);
  const lastToast = () => toasts[toasts.length - 1] || { m: "", err: false };
  const hashNow = () => w.location.hash.replace(/^#\/?/, "");
  const drawn = () => !!(page() && (page().querySelector("#custForm") || page().querySelector(".cust-err") || page().querySelector("#custBody")));
  const asRoles = (pageRole, serverRole) => { globalThis.__role281 = serverRole || pageRole; w.eval(roles.asRole(pageRole, { name: "Tester", email: "tester@example.test" })); };
  // Goes to an address the way a link does (or draws it again when it is already there), and waits for the screen.
  const go = async (hash) => {
    const old = page();
    if (hashNow() === hash) w.adminRoute(); else w.location.hash = "#" + hash;
    return wait(() => page() && page() !== old && drawn());
  };
  const open = (id) => go("customers/" + id);
  const redrawnAfter = async (act) => { const old = page(); await act(); return wait(() => page() && page() !== old && !!page().querySelector("#custForm")); };
  const set = (id, v) => { q("#" + id).value = v; };
  const save = () => q("#custSave").click();
  const tiles = () => qa("#custPage .cust-total").map(t => t.querySelector("span").textContent + " " + t.querySelector("b").textContent);
  const orderRows = () => qa("#custPage table.cust-table tbody tr");
  const heads = () => qa("#custPage table.cust-table thead th").map(th => th.textContent);
  const modal = () => { const all = qa(".admin-modal"); return all[all.length - 1] || null; };
  const confirmBox = () => q(".confirm-modal");
  const answer = async (yes) => { await wait(() => confirmBox()); const box = confirmBox(); const info = { message: box.dataset.message, okLabel: box.querySelector("#cmOk").textContent, focusIn: box.contains(d.activeElement) };
    box.querySelector(yes ? "#cmOk" : "#cmCancel").click(); await wait(() => !confirmBox()); return info; };
  const lvl = (role, fn) => roles.effectivePermissions(roles.DEFAULT_ROLES[role])[fn];
  const off = (sel) => { const el = q(sel); return !!el && el.hasAttribute("data-perm-off"); };
  const shown = (sel) => { const el = q(sel); return !!el && !el.hasAttribute("data-perm-off"); };

  asRoles("admin");

  console.log("=== Opening a customer: #customers/<id> ===");
  ok("the Customers page's own script isn't loaded until the page is opened", !served.some(u => /admin-customers\.js/.test(u)) && typeof w.renderCustomers !== "function");
  reset();
  ok("#customers/<id> draws that customer", await open(A) && !!q("#custForm"));
  ok("…the script was fetched from /admin-customers.js, once", served.filter(u => /\/admin-customers\.js$/.test(u)).length === 1 && typeof w.renderCustomers === "function");
  ok("…the customer is asked for by number, once", of("getCustomer").length === 1 && of("getCustomer")[0].id === A);
  ok("…the heading is the customer's name, on the page and for a screen reader", q(".cust-name").textContent === "Pat Example" && q("h1.org-name").textContent === "Pat Example");
  ok("…the tab's title names the customer", /Pat Example/.test(d.title) && /\(Admin\)/.test(d.title));
  ok("…the breadcrumbs lead back to Customers", q(".bc-current").textContent === "Pat Example" && /Customers/.test(q(".admin-hero").textContent));
  ok("…and so does a “‹ Customers” link above the customer", q("#custPage a.backlink").getAttribute("href") === "#customers" && /Customers/.test(q("#custPage a.backlink").textContent));
  ok("…under the name: the company, then since when they have been a customer", q(".cust-sub").textContent.replace(/\s+/g, " ").trim() === "Example Club · Customer since " + w.adminDate_("2025-06-15T12:00:00.000Z"));
  ok("…no Archived or Tax exempt mark on a customer who is neither", !q(".cust-sub .cust-tag"));
  ok("the form shows the stored name, company, email and phone", q("#custName").value === "Pat Example" && q("#custCompany").value === "Example Club" && q("#custEmail").value === "pat@example.com" && q("#custPhone").value === "555-0100");
  ok("…the stored address, line by line", q("#custLine1").value === "1 Example Street" && q("#custLine2").value === "Unit 2" && q("#custCity").value === "Exampleville" && q("#custState").value === "EX" && q("#custZip").value === "00000");
  ok("…the notes", q("#custNotes").value === "Likes navy thread.");
  ok("…and the tax exemption: not exempt, no certificate, no expiry", q("#custExempt").checked === false && q("#custCert").value === "" && q("#custExpires").value === "");
  ok("the exemption sits in a box titled “Tax exemption”", q("fieldset.cust-exempt legend").textContent === "Tax exemption" && q("fieldset.cust-exempt").contains(q("#custExempt")) && q("fieldset.cust-exempt").contains(q("#custCert")) && q("fieldset.cust-exempt").contains(q("#custExpires")));
  ok("every field of the form has its own label", qa("#custForm input, #custForm textarea").length === 13 && qa("#custForm input, #custForm textarea").every(f => { const l = f.closest("label"); return l && l.textContent.trim().length > 0; }));
  ok("…named Name, Company, Email, Phone, Address, Address line 2, City, State, ZIP, Notes, Certificate number, Expires",
    same(qa("#custForm label.cust-field > span").map(s => s.textContent), ["Name", "Company", "Email", "Phone", "Address", "Address line 2", "City", "State", "ZIP", "Notes", "Certificate number", "Expires (blank = never)"]));
  ok("the address stays #customers/<id>", hashNow() === "customers/" + A);

  ok("a customer with only a company is headed by the company", await open(C) && q(".cust-name").textContent === "Example Supply Co" && q("#custName").value === "" && q("#custCompany").value === "Example Supply Co");
  ok("…and the line under it doesn't repeat the company", q(".cust-sub").textContent.replace(/\s+/g, " ").trim() === "Customer since " + w.adminDate_("2025-06-15T12:00:00.000Z"));
  ok("…with no address stored, every address field is empty", ["custLine1", "custLine2", "custCity", "custState", "custZip"].every(id => q("#" + id).value === ""));

  reset();
  ok("a number no customer has: the page says so instead of a form", await open(999999) && !q("#custForm") && q("#custPage .cust-err").textContent === "Customer not found");
  ok("…as an alert, with the way back to the list still there", q("#custPage .cust-err").getAttribute("role") === "alert" && q("#custPage a.backlink").getAttribute("href") === "#customers");
  ok("…and nothing but the one question was sent", sent.length === 1 && sent[0].action === "getCustomer" && sent[0].id === 999999);

  scripted = { action: "getCustomer", status: 503, body: { status: "error", message: "Customers aren't set up on this database yet." } };
  ok("the server's own sentence is shown when it can't answer (a database not yet updated, say)", await open(A) && !q("#custForm") && q("#custPage .cust-err").textContent === "Customers aren't set up on this database yet.");

  console.log("\n=== renderCustomers(app, id): what counts as a customer's number ===");
  for (const [label, v] of [["nothing", null], ["an empty id", ""], ["letters", "abc"], ["zero", 0], ["a negative number", -3], ["a fraction", 1.5]]) {
    reset();
    await w.renderCustomers(app, v);
    ok("renderCustomers with " + label + " draws the list and asks for no customer", !!q("#custQ") && !q("#custForm") && of("getCustomer").length === 0 && of("listCustomers").length === 1);
  }
  reset();
  await w.renderCustomers(app, String(A));
  ok("renderCustomers with a number written as text opens that customer", !!q("#custForm") && of("getCustomer").length === 1 && of("getCustomer")[0].id === A && q(".cust-name").textContent === "Pat Example");

  console.log("\n=== A customer that takes a moment to load ===");
  { let release; hold = { action: "getCustomer", gate: new Promise(r => { release = r; }) };
    reset();
    w.location.hash = "#customers/" + B;
    await wait(() => of("getCustomer").length === 1);
    ok("while the customer loads the page says “Loading…” under the way back", /Loading…/.test(page().textContent) && !!q("#custPage a.backlink") && !q("#custForm"));
    await go("customers");
    ok("(leaving for the list meanwhile)", !!q("#custQ"));
    release(); await pause(120);
    ok("an answer that arrives after the admin moved on doesn't draw over the page they went to", !!q("#custQ") && !q("#custForm") && hashNow() === "customers"); }
  { let release; hold = { action: "getCustomer", gate: new Promise(r => { release = r; }) };
    w.location.hash = "#customers/999998";
    await wait(() => !!hold === false);
    await go("customers");
    release(); await pause(120);
    ok("…nor does a refusal that arrives late", !!q("#custQ") && !q("#custPage .cust-err")); }

  console.log("\n=== The form and Save ===");
  await open(A);
  reset();
  set("custName", "  Pat Q. Example "); set("custCompany", " Example Rowing Club "); set("custEmail", "  PAT@Example.com "); set("custPhone", " 555-0111 ");
  set("custLine1", " 2 Example Avenue "); set("custLine2", ""); set("custCity", " Sampleton "); set("custState", " SM "); set("custZip", " 00001 "); set("custNotes", "  Prefers pickup.\nCall first. ");
  ok("Save sends the customer and draws the page again", await redrawnAfter(save));
  ok("…one saveCustomer with every field, trimmed, and the exemption as it was", of("saveCustomer").length === 1 && same(of("saveCustomer")[0], { action: "saveCustomer", id: A, name: "Pat Q. Example", company: "Example Rowing Club", email: "PAT@Example.com", phone: "555-0111",
    address: { name: "Pat Example", line1: "2 Example Avenue", line2: "", city: "Sampleton", state: "SM", zip: "00001", country: "US" }, notes: "Prefers pickup.\nCall first.",
    taxExempt: false, taxExemptCertificate: "", taxExemptExpires: "", key: "cookie" }));
  ok("…the parts of the address the form has no field for (the recipient, the country) are sent back unchanged", of("saveCustomer")[0].address.name === "Pat Example" && of("saveCustomer")[0].address.country === "US");
  ok("…the page says “Customer saved.”", toasts.length === 1 && toasts[0].m === "Customer saved." && !toasts[0].err);
  ok("…and it is stored", row(A).name === "Pat Q. Example" && row(A).company === "Example Rowing Club" && row(A).phone === "555-0111" && row(A).notes === "Prefers pickup.\nCall first." &&
    same(JSON.parse(row(A).addressJson), { name: "Pat Example", line1: "2 Example Avenue", city: "Sampleton", state: "SM", zip: "00001", country: "US" }));
  ok("…the customer is read again after the save", sent.map(b => b.action).join(",") === "saveCustomer,getCustomer");
  ok("…so the form shows what the server kept, not what was typed (the email in lower case)", q("#custEmail").value === "pat@example.com" && q("#custName").value === "Pat Q. Example" && q("#custCompany").value === "Example Rowing Club" && q("#custPhone").value === "555-0111");
  ok("…the new address and notes are shown again", q("#custLine1").value === "2 Example Avenue" && q("#custLine2").value === "" && q("#custCity").value === "Sampleton" && q("#custState").value === "SM" && q("#custZip").value === "00001" && q("#custNotes").value === "Prefers pickup.\nCall first.");
  ok("…and the heading, the line under it and the tab's title follow the new name and company", q(".cust-name").textContent === "Pat Q. Example" && /^Example Rowing Club · Customer since/.test(q(".cust-sub").textContent.trim()) && /Pat Q\. Example/.test(d.title));

  reset();
  for (const id of ["custLine1", "custLine2", "custCity", "custState", "custZip"]) set(id, "  ");
  await redrawnAfter(save);
  ok("emptying every address field sends no address at all", of("saveCustomer").length === 1 && of("saveCustomer")[0].address === null);
  ok("…and the stored address is gone, the recipient and country with it", row(A).addressJson === "" && q("#custLine1").value === "" && q("#custCity").value === "");
  reset();
  set("custCity", "Sampleton");
  await redrawnAfter(save);
  ok("one address field filled in is enough for an address", same(of("saveCustomer")[0].address, { line1: "", line2: "", city: "Sampleton", state: "", zip: "" }) && q("#custCity").value === "Sampleton");

  reset();
  { const before = page();
    set("custName", "  "); set("custCompany", "");
    save(); await pause(60);
    ok("no name and no company: “Enter a name or a company.”, shown as an alert", q("#custErr").textContent === "Enter a name or a company." && q("#custErr").getAttribute("role") === "alert");
    ok("…nothing is sent, the page stays as it is, and the cursor goes to Name", sent.length === 0 && page() === before && d.activeElement === q("#custName") && toasts.length === 0);
    set("custName", "Pat Q. Example"); set("custEmail", "pat at example");
    save(); await pause(60);
    ok("an email that isn't one: “That email address doesn't look right.”, nothing sent, the cursor in Email", q("#custErr").textContent === "That email address doesn't look right." && sent.length === 0 && d.activeElement === q("#custEmail"));
    set("custEmail", "pat@example"); save(); await pause(60);
    ok("…an address with no dot after the @ is stopped the same way", q("#custErr").textContent === "That email address doesn't look right." && sent.length === 0);
    set("custEmail", "pat.e@example.com"); set("custPhone", "555-0199");
    save(); await wait(() => of("saveCustomer").length === 1 && !q("#custSave").disabled);
    ok("an email another customer has: the server's refusal is shown under the form", q("#custErr").textContent === "Another customer already has that email.");
    ok("…the page isn't drawn again, so what was typed is still there to correct", page() === before && q("#custEmail").value === "pat.e@example.com" && q("#custPhone").value === "555-0199");
    ok("…Save can be pressed again, nothing says “saved”, and nothing was stored", q("#custSave").disabled === false && toasts.length === 0 && row(A).email === "pat@example.com" && row(A).phone === "555-0111");
    // Corrected: the message goes while the save is on its way, and Save can't be pressed twice.
    let release; hold = { action: "saveCustomer", gate: new Promise(r => { release = r; }) };
    set("custEmail", ""); set("custName", ""); set("custCompany", "Example Rowing Club");
    reset(); save(); await wait(() => of("saveCustomer").length === 1);
    ok("while a save is on its way Save is switched off and the last refusal is cleared", q("#custSave").disabled === true && q("#custErr").textContent === "");
    release(); await wait(() => page() !== before && !!q("#custForm"));
    ok("a customer may be left with a company and no name or email", toasts.length === 1 && toasts[0].m === "Customer saved." && row(A).name === "" && row(A).email === "" && q(".cust-name").textContent === "Example Rowing Club");
    ok("…and the phone typed before the refusal went with it", row(A).phone === "555-0199" && q("#custPhone").value === "555-0199"); }
  set("custName", "Pat Example"); set("custCompany", "Example Club"); set("custEmail", "pat@example.com"); set("custPhone", "555-0100"); set("custNotes", "Likes navy thread.");
  await redrawnAfter(save);

  console.log("\n=== The Tax exemption box, with Full access ===");
  ok("(the built-in roles) Admin and Manager have Full on Customer records, Back office Edit, Production Read", lvl("admin", "customers.records") === "full" && lvl("manager", "customers.records") === "full" && lvl("staff", "customers.records") === "edit" && lvl("production", "customers.records") === "read");
  ok("with Full the tick box, the certificate and the expiry can be changed", !q("#custExempt").disabled && !q("#custCert").disabled && !q("#custExpires").disabled && q("#custExpires").type === "date");
  ok("…and the box says when an exemption applies", /Applies to orders placed from now on, until the day it expires\. Orders already placed keep the tax they were charged\./.test(q("fieldset.cust-exempt .cust-note").textContent));
  reset();
  q("#custExempt").checked = true; set("custCert", "  EX-0001 "); set("custExpires", "2999-12-31");
  await redrawnAfter(save);
  ok("ticking it with a certificate and an expiry sends all three", of("saveCustomer")[0].taxExempt === true && of("saveCustomer")[0].taxExemptCertificate === "EX-0001" && of("saveCustomer")[0].taxExemptExpires === "2999-12-31");
  ok("…they are stored", row(A).taxExempt === 1 && row(A).taxExemptCertificate === "EX-0001" && row(A).taxExemptExpires === "2999-12-31" && toasts[0].m === "Customer saved.");
  ok("…and shown again, with a “Tax exempt” mark under the name", q("#custExempt").checked && q("#custCert").value === "EX-0001" && q("#custExpires").value === "2999-12-31" &&
    qa(".cust-sub .cust-tag").length === 1 && q(".cust-sub .cust-tag").textContent === "Tax exempt" && q(".cust-sub .cust-tag").classList.contains("cust-tag-exempt"));
  set("custExpires", "2000-01-01");
  await redrawnAfter(save);
  ok("an exemption whose expiry has passed is marked “Exemption expired”, as a warning", q(".cust-sub .cust-tag").textContent === "Exemption expired" && q(".cust-sub .cust-tag").classList.contains("cust-tag-warn") && !q(".cust-sub .cust-tag-exempt"));
  set("custExpires", "");
  await redrawnAfter(save);
  ok("no expiry means it never expires: “Tax exempt” again", row(A).taxExemptExpires == null && q(".cust-sub .cust-tag").textContent === "Tax exempt" && q("#custExpires").value === "");
  reset();
  q("#custExempt").checked = false;
  await redrawnAfter(save);
  ok("unticking it sends not exempt, and the mark goes", of("saveCustomer")[0].taxExempt === false && row(A).taxExempt === 0 && !q(".cust-sub .cust-tag") && q("#custExempt").checked === false);
  q("#custExempt").checked = true; set("custExpires", "2999-12-31");
  await redrawnAfter(save);

  console.log("\n=== The Tax exemption box without Full access (Back office: Edit) ===");
  asRoles("staff");
  await open(A);
  ok("the exemption is shown: ticked, the certificate, the expiry", q("#custExempt").checked && q("#custCert").value === "EX-0001" && q("#custExpires").value === "2999-12-31");
  ok("…but none of the three can be changed", q("#custExempt").disabled && q("#custCert").disabled && q("#custExpires").disabled);
  ok("…and the box says who can", q("fieldset.cust-exempt .cust-note").textContent.trim() === "Only a role with full access to Customers can change a tax exemption.");
  ok("the rest of the form is open, with its Save", ["custName", "custCompany", "custEmail", "custPhone", "custLine1", "custLine2", "custCity", "custState", "custZip", "custNotes"].every(id => !q("#" + id).disabled) && shown("#custSave"));
  reset();
  set("custPhone", "555-0122");
  // Even if the locked fields were changed behind the page's back, what is sent is what is stored.
  q("#custExempt").checked = false; q("#custCert").value = "EX-9999"; q("#custExpires").value = "";
  ok("Back office saves a phone number and the page is drawn again", await redrawnAfter(save));
  ok("…the save carries the exemption exactly as stored, never what the locked fields hold", of("saveCustomer")[0].taxExempt === true && of("saveCustomer")[0].taxExemptCertificate === "EX-0001" && of("saveCustomer")[0].taxExemptExpires === "2999-12-31" && of("saveCustomer")[0].phone === "555-0122");
  ok("…so the server, which refuses Back office a change to the exemption, accepts it", toasts.length === 1 && toasts[0].m === "Customer saved." && row(A).phone === "555-0122");
  ok("…and the exemption is untouched", row(A).taxExempt === 1 && row(A).taxExemptCertificate === "EX-0001" && row(A).taxExemptExpires === "2999-12-31" && q("#custExempt").checked);
  await open(C);
  reset();
  set("custPhone", "555-0133");
  await redrawnAfter(save);
  ok("for a customer with no exemption it sends not exempt, no certificate, no expiry — and saves", of("saveCustomer")[0].taxExempt === false && of("saveCustomer")[0].taxExemptCertificate === "" && of("saveCustomer")[0].taxExemptExpires === "" && row(C).phone === "555-0133" && toasts[0].m === "Customer saved.");
  // The page's rule is its own: with the page on Full and the server on Edit, the server's refusal is what shows.
  asRoles("admin", "staff");
  await open(C);
  { const before = page(); reset();
    q("#custExempt").checked = true; save();
    await wait(() => of("saveCustomer").length === 1 && !q("#custSave").disabled);
    ok("a change to the exemption the server refuses is shown under the form, and nothing is saved", q("#custErr").textContent === "Your role can't change a customer's tax exemption. Ask an admin." && page() === before && row(C).taxExempt === 0 && toasts.length === 0); }

  console.log("\n=== Which buttons each role is offered ===");
  asRoles("admin");
  await open(A);
  ok("the three buttons say what each needs: a sale Edit on orders, Archive Edit on customers, Merge Full on customers", q("#custNewSale").getAttribute("data-need") === "orders.details:edit" &&
    q("#custArchive").getAttribute("data-need") === "customers.records:edit" && q("#custMerge").getAttribute("data-need") === "customers.records:full");
  ok("…the form needs Edit on customers, its exemption box Full", q("#custForm").getAttribute("data-need-form") === "customers.records:edit" && q("fieldset.cust-exempt").getAttribute("data-need-form") === "customers.records:full");
  ok("Admin is offered New sale, Archive and Merge, and Save", shown("#custNewSale") && shown("#custArchive") && shown("#custMerge") && shown("#custSave"));
  ok("…in that order, by those names", same(qa(".cust-actions button").map(b => b.textContent), ["New sale for this customer", "Archive", "Merge into another customer…"]));
  asRoles("manager");
  await open(A);
  ok("Manager too, and may change the exemption", shown("#custNewSale") && shown("#custArchive") && shown("#custMerge") && shown("#custSave") && !q("#custExempt").disabled && !q("#custCert").disabled);
  asRoles("staff");
  await open(A);
  ok("Back office is offered Archive and Save but not Merge", shown("#custArchive") && shown("#custSave") && off("#custMerge"));
  ok("…and New sale, as it can record a sale", lvl("staff", "orders.details") !== "read" && lvl("staff", "orders.details") !== "none" && shown("#custNewSale"));
  asRoles("production");
  await open(A);
  ok("Production (Read) still sees the customer, the totals and the orders", q(".cust-name").textContent === "Pat Example" && tiles().length === 3 && orderRows().length === 5);
  ok("…every field is read-only, the exemption included", qa("#custForm input, #custForm textarea").length === 13 && qa("#custForm input, #custForm textarea").every(f => f.disabled));
  ok("…and it is offered neither Save, Archive nor Merge", off("#custSave") && off("#custArchive") && off("#custMerge"));
  ok("…New sale only if the role may record one (Production may not)", lvl("production", "orders.details") === "read" ? off("#custNewSale") : shown("#custNewSale"));
  ok("…the exemption box tells it who can change an exemption", /Only a role with full access to Customers/.test(q("fieldset.cust-exempt .cust-note").textContent));
  asRoles("admin");

  console.log("\n=== The totals ===");
  await open(A);
  ok("three figures: Orders, Spent, Balance due", same(tiles(), ["Orders 3", "Spent $85.00", "Balance due $25.00"]));
  ok("…a voided order and a test order are in neither the count nor the money", orderRows().length === 5 && tiles()[0] === "Orders 3");
  ok("…money still owed is picked out", qa("#custPage .cust-total")[2].classList.contains("cust-total-due") && !qa("#custPage .cust-total")[1].classList.contains("cust-total-due"));
  await open(C);
  ok("a customer with no orders: 0 orders, $0.00 spent, $0.00 due, and nothing picked out as owed", same(tiles(), ["Orders 0", "Spent $0.00", "Balance due $0.00"]) && !q("#custPage .cust-total-due"));
  ok("…and “No orders yet.” in place of the table", !q("#custPage table.cust-table") && qa("#custPage .cust-note").some(n => n.textContent === "No orders yet."));
  const real = (await call({ action: "getCustomer", id: A })).body;
  const copy = (o) => JSON.parse(JSON.stringify(o));
  { const s = copy(real); s.totals = { orderCount: 2 }; s.orders = s.orders.map(o => ({ orderId: o.orderId, orgId: o.orgId, placedAt: o.placedAt, voided: o.voided, isTest: o.isTest, completed: o.completed }));
    scripted = { action: "getCustomer", body: s };
    await open(A);
    ok("when the server leaves the money out, only the order count is shown: no Spent, no Balance due", same(tiles(), ["Orders 2"]));
    ok("…and the orders table has no Total, Paid or Balance column", same(heads(), ["Order", "Shop", "Placed", "Status"]) && orderRows().every(tr => tr.children.length === 4) && !/\$/.test(q("#custPage table.cust-table").textContent)); }
  { const s = copy(real); delete s.totals.balanceDue;
    scripted = { action: "getCustomer", body: s };
    await open(A);
    ok("a figure is left out one at a time: Spent without Balance due", same(tiles(), ["Orders 3", "Spent $85.00"])); }
  { const s = copy(real); delete s.totals; s.orders = [{ orderId: "O-9001", orgId: "acme", placedAt: "2026-01-05T15:00:00.000Z", total: 12.5, paidAmount: null, voided: false, isTest: false, completed: false }];
    scripted = { action: "getCustomer", body: s };
    await open(A);
    ok("no totals at all reads as 0 orders", same(tiles(), ["Orders 0"]));
    ok("…an order that does carry a total keeps the money columns, with a dash for an amount that is missing", same(heads(), ["Order", "Shop", "Placed", "Total", "Paid", "Balance", "Status"]) &&
      same([...orderRows()[0].children].slice(3, 6).map(td => td.textContent), ["$12.50", "—", "—"])); }
  { const s = copy(real); delete s.orders;
    scripted = { action: "getCustomer", body: s };
    await open(A);
    ok("an answer with no list of orders is shown as no orders yet", !q("#custPage table.cust-table") && qa("#custPage .cust-note").some(n => n.textContent === "No orders yet.") && tiles()[0] === "Orders 3"); }

  console.log("\n=== The orders table ===");
  await open(A);
  ok("the columns: Order, Shop, Placed, Total, Paid, Balance, Status", same(heads(), ["Order", "Shop", "Placed", "Total", "Paid", "Balance", "Status"]));
  ok("every order of the customer, newest first", same(orderRows().map(tr => tr.children[0].textContent.trim()), ["O-1004", "O-1003", "O-1002", "O-1001", "O-1005"]));
  ok("…each with the day it was placed", same(orderRows().map(tr => tr.children[2].textContent), ["2026-03-20", "2026-03-10", "2026-02-10", "2026-01-10", "2025-12-01"].map(day => w.adminDate_(day + "T15:00:00.000Z"))) && orderRows()[0].children[2].textContent !== orderRows()[1].children[2].textContent);
  ok("…its shop by name — a shop's name is text, never markup", orderRows()[3].children[1].textContent === "Example Club" && orderRows()[2].children[1].textContent === "Rec <i>League</i>" && !q("#custPage table.cust-table i"));
  ok("…or the shop's id when this admin's list doesn't have the shop", orderRows()[4].children[1].textContent === "gone");
  ok("…what it came to, what was paid and what is owed", same([...orderRows()[3].children].slice(3, 6).map(td => td.textContent), ["$40.00", "$40.00", "$0.00"]) && same([...orderRows()[2].children].slice(3, 6).map(td => td.textContent), ["$25.00", "$0.00", "$25.00"]));
  const marks = (i) => [...orderRows()[i].children[6].querySelectorAll(".cust-tag")].map(t => t.textContent);
  ok("a voided order is marked “Voided”, as a warning, and its row greyed", same(marks(1), ["Voided"]) && orderRows()[1].children[6].querySelector(".cust-tag").classList.contains("cust-tag-warn") && orderRows()[1].classList.contains("cust-row-archived"));
  ok("a test order is marked “Test”", same(marks(0), ["Test"]) && !orderRows()[0].classList.contains("cust-row-archived"));
  ok("a completed order is marked “Completed”", same(marks(4), ["Completed"]));
  ok("an open, real order has no mark", same(marks(2), []) && same(marks(3), []) && !orderRows()[2].classList.contains("cust-row-archived"));
  ok("under the table: voided and test orders are listed but not counted", qa("#custPage .cust-note").some(n => n.textContent === "Voided and test orders are listed but not counted in the totals."));
  ok("…and no word about a 500-order limit for five orders", !/most recent orders are listed/.test(page().textContent));
  await open(B);
  ok("a customer with neither a voided nor a test order has no such note", orderRows().length === 1 && !/not counted in the totals/.test(page().textContent));

  console.log("\n=== An order number opens that order on the Orders page ===");
  await open(A);
  const links = () => orderRows().map(tr => tr.children[0].querySelector("a"));
  ok("every order number is a link to its shop's Orders page", links().every(a => !!a) && same(links().map(a => a.getAttribute("href")), ["#orders/acme", "#orders/acme", "#orders/rec", "#orders/acme", "#orders/gone"]));
  ok("(the admin keeps one Orders view, with “Include completed” and “Include cancelled” unticked to start)", !!w._orderView && w._orderView.includeCompleted === false && w._orderView.includeCancelled === false);
  { const realOpen = w.openOrderFromDashboard_, realView = w._orderView, opened = [];
    w.openOrderFromDashboard_ = (...a) => { opened.push(a); };
    const press = (i) => { const ev = new w.MouseEvent("click", { bubbles: true, cancelable: true }); links()[i].dispatchEvent(ev); return ev.defaultPrevented; };
    w._orderView = {};
    const stopped = press(2);
    ok("pressing one opens the order the way Home does: its shop, its number, the day it was placed", opened.length === 1 && same(opened[0], ["rec", "O-1002", "2026-02-10T15:00:00.000Z"]));
    ok("…in place of following the link, and without ticking “Include completed” or “Include cancelled” for an open order", stopped === true && same(w._orderView, {}) && hashNow() === "customers/" + A);
    press(4);
    ok("a completed order ticks “Include completed” on the Orders page first, so the order is there", same(opened[1], ["gone", "O-1005", "2025-12-01T15:00:00.000Z"]) && w._orderView.includeCompleted === true && !w._orderView.includeCancelled);
    w._orderView = {};
    press(1);
    ok("a voided order ticks “Include cancelled”", same(opened[2], ["acme", "O-1003", "2026-03-10T15:00:00.000Z"]) && w._orderView.includeCancelled === true && !w._orderView.includeCompleted);
    w._orderView = undefined;
    press(3);
    ok("…and with no Orders view kept yet it still opens the order", opened.length === 4 && same(opened[3], ["acme", "O-1001", "2026-01-10T15:00:00.000Z"]));
    w.openOrderFromDashboard_ = realOpen; w._orderView = realView; }
  // A role that may open Customers but not Orders (a custom role): the numbers are plain text.
  w.eval(`adminPerms = Object.assign({}, adminPerms); Object.keys(adminPerms).forEach(k => { if (/^orders\\./.test(k)) adminPerms[k] = "none"; });`);
  ok("(a role with Customers but no Orders page)", w.adminCanOpen_("orders") === false && w.adminCanOpen_("customers") === true);
  await open(A);
  ok("a role that can't open the Orders page gets the order numbers as plain text, not links", orderRows().length === 5 && !q("#custPage table.cust-table a") && orderRows()[3].children[0].textContent.trim() === "O-1001");
  ok("…and isn't offered “New sale for this customer”", off("#custNewSale"));
  asRoles("admin");

  console.log("\n=== “New sale for this customer” ===");
  await open(A);
  { const realSale = w.adminNewSaleForCustomer_, got = [];
    w.adminNewSaleForCustomer_ = (c) => { got.push(c); };
    reset();
    q("#custNewSale").click(); await pause(30);
    ok("the button hands the customer to adminNewSaleForCustomer_", got.length === 1 && got[0].id === A && got[0].name === "Pat Example" && got[0].company === "Example Club" && got[0].email === "pat@example.com" && got[0].phone === "555-0122");
    ok("…and sends nothing itself", sent.length === 0 && toasts.length === 0);
    w.adminNewSaleForCustomer_ = undefined;
    let threw = false; const onErr = () => { threw = true; }; w.addEventListener("error", onErr);
    q("#custNewSale").click(); await pause(30);
    w.removeEventListener("error", onErr);
    ok("on an admin page without that function the button does nothing rather than fail", !threw && sent.length === 0 && !!q("#custForm"));
    w.adminNewSaleForCustomer_ = realSale; }

  console.log("\n=== Archive and Restore ===");
  { const before = page(); reset();
    q("#custArchive").focus(); q("#custArchive").click();
    let asked = await answer(false);
    ok("Archive asks first, naming the customer and saying what archiving does", asked.message === "Archive Pat Example?\n\nIt leaves the customer list and the customer search. Its orders stay as they are, and you can restore it at any time.");
    ok("…the question's own button reads “Archive”, and focus is inside the question", asked.okLabel === "Archive" && asked.focusIn === true);
    await pause(40);
    ok("…Cancel sends nothing and leaves the page as it was", sent.length === 0 && page() === before && toasts.length === 0 && row(A).archivedAt == null);
    ok("…and focus is back on the Archive button", d.activeElement === q("#custArchive"));
    const done = redrawnAfter(async () => { q("#custArchive").click(); asked = await answer(true); });
    ok("answering Archive archives the customer and draws the page again", await done);
    ok("…one setCustomerArchived for this customer, archived: true", of("setCustomerArchived").length === 1 && same(of("setCustomerArchived")[0], { action: "setCustomerArchived", id: A, archived: true, key: "cookie" }) && row(A).archivedAt != null);
    ok("…the page says “Customer archived.”", toasts.length === 1 && toasts[0].m === "Customer archived." && !toasts[0].err); }
  ok("an archived customer is marked “Archived” under the name, beside “Tax exempt”", same(qa(".cust-sub .cust-tag").map(t => t.textContent), ["Archived", "Tax exempt"]));
  ok("…the button now reads “Restore”", q("#custArchive").textContent === "Restore");
  ok("…and “New sale for this customer” is not there", !q("#custNewSale") && same(qa(".cust-actions button").map(b => b.textContent), ["Restore", "Merge into another customer…"]));
  ok("…the form, the totals and the orders are all still shown", q("#custName").value === "Pat Example" && tiles().length === 3 && orderRows().length === 5 && shown("#custSave"));
  reset();
  await redrawnAfter(async () => { q("#custArchive").click(); });
  ok("Restore asks nothing: it sends archived: false straight away", !confirmBox() && of("setCustomerArchived").length === 1 && of("setCustomerArchived")[0].archived === false && of("setCustomerArchived")[0].id === A && row(A).archivedAt == null);
  ok("…says “Customer restored.”", toasts.length === 1 && toasts[0].m === "Customer restored." && !toasts[0].err);
  ok("…and the page is as before: Archive, New sale back, no Archived mark", q("#custArchive").textContent === "Archive" && !!q("#custNewSale") && same(qa(".cust-sub .cust-tag").map(t => t.textContent), ["Tax exempt"]));
  { const before = page(); reset();
    globalThis.__role281 = "production";
    q("#custArchive").click(); await answer(true);
    await wait(() => toasts.length === 1);
    ok("a refusal from the server is shown as an error, and the page stays as it was", toasts.length === 1 && toasts[0].err === true && toasts[0].m === "Your role can't do that here." && page() === before && row(A).archivedAt == null && q("#custArchive").textContent === "Archive");
    globalThis.__role281 = "admin";
    scripted = { action: "setCustomerArchived", status: 400, body: { status: "error", message: "That customer was merged into another one. Open that one instead." } };
    reset(); q("#custArchive").click(); await answer(true); await wait(() => toasts.length === 1);
    ok("…in the server's own words", toasts[0].m === "That customer was merged into another one. Open that one instead." && toasts[0].err === true && page() === before); }

  console.log("\n=== “Merge into another customer…”: finding the customer to keep ===");
  const mq = () => modal().querySelector("#custMergeQ"), mlist = () => [...modal().querySelectorAll("#custMergeList button")], mstatus = () => modal().querySelector("#custMergeStatus").textContent;
  const mpick = () => modal().querySelector("#custMergePick"), mconfirm = () => modal().querySelector("#custMergeConfirm"), mtext = () => modal().querySelector("#custMergeText").textContent, merr = () => modal().querySelector("#custMergeErr").textContent;
  const type = (text) => { mq().value = text; mq().dispatchEvent(new w.Event("input", { bubbles: true })); };
  const search = async (text) => { const n = of("listCustomers").length; type(text); await wait(() => of("listCustomers").length === n + 1); await pause(60); };
  const openMerge = async () => { q("#custMerge").focus(); q("#custMerge").click(); await wait(() => modal() && modal().querySelector("#custMergeQ")); };
  const closeMerge = async () => { const m = modal(); m.querySelector("[data-modal-close]").click(); await wait(() => !m.isConnected); };
  reset();
  await openMerge();
  ok("the button opens a window titled “Merge into another customer”", modal().querySelector("[data-dialog-title]").textContent === "Merge into another customer");
  ok("…a dialog for a screen reader, named by that title", modal().firstElementChild.getAttribute("role") === "dialog" && modal().firstElementChild.getAttribute("aria-modal") === "true" &&
    d.getElementById(modal().firstElementChild.getAttribute("aria-labelledby")).textContent === "Merge into another customer");
  ok("…it says what a merge does, naming this customer", modal().querySelector("#custMergeIntro").textContent === "Find the customer to keep. Pat Example's orders move to it, and Pat Example is archived.");
  ok("…the search box is labelled “Search customers” and focus starts in it", mq().closest("label").querySelector("span").textContent === "Search customers" && d.activeElement === mq());
  ok("…the question and its Merge button aren't shown yet, and nothing has been asked of the server", mconfirm().hidden === true && mpick().hidden === false && sent.length === 0 && mlist().length === 0 && mstatus() === "");
  ok("…the results are a labelled group and the count under them is announced", modal().querySelector("#custMergeList").getAttribute("aria-label") === "Matching customers" && modal().querySelector("#custMergeStatus").getAttribute("role") === "status");
  type("Sample"); type("Sample Tar"); type("Sample Target");
  ok("typing doesn't search on every key", of("listCustomers").length === 0);
  await wait(() => of("listCustomers").length >= 1); await pause(350);
  ok("…it searches once, after a pause, for what was typed last", of("listCustomers").length === 1 && of("listCustomers")[0].q === "Sample Target");
  ok("…asking for 9 customers from the start, archived ones left out", of("listCustomers")[0].limit === 9 && of("listCustomers")[0].offset === 0 && of("listCustomers")[0].includeArchived === false);
  ok("…and offers the first 8 of them", mlist().length === 8 && same(mlist().map(b => b.querySelector("b").textContent), [1, 2, 3, 4, 5, 6, 7, 8].map(i => "Sample Target 0" + i)) && mstatus() === "8 customers found");
  ok("…an archived customer is never offered", !mlist().some(b => /Archived/.test(b.textContent)));
  ok("each is a button with the customer's company, email, phone and order count — shown as text", mlist()[0].tagName === "BUTTON" && mlist()[0].type === "button" && mlist()[0].querySelector("span").textContent === "Example <Supply> · t01@example.com · 555-0101 · 0 orders" && !modal().querySelector("#custMergeList supply"));
  ok("…or just the order count when that is all there is", mlist()[1].querySelector("span").textContent === "0 orders");
  await search("pat");
  ok("the customer being merged is never offered to itself: “pat” finds only the other Pat", mlist().length === 1 && mlist()[0].querySelector("b").textContent === "Pat Other" && mstatus() === "1 customer found");
  ok("…with its email and “1 order”", mlist()[0].querySelector("span").textContent === "pat.e@example.com · 1 order");
  await search("pat@example.com");
  ok("a search that finds only this customer says “No other customer matches that search.”", mlist().length === 0 && mstatus() === "No other customer matches that search.");
  await search("Example Supply Co");
  ok("a customer with only a company is listed by it, without repeating it underneath", mlist().length === 1 && mlist()[0].querySelector("b").textContent === "Example Supply Co" && mlist()[0].querySelector("span").textContent === "555-0133 · 0 orders");
  { const n = of("listCustomers").length;
    type("   "); await pause(350);
    ok("clearing the box clears the results without asking the server", mlist().length === 0 && mstatus() === "" && of("listCustomers").length === n); }
  scripted = { action: "listCustomers", status: 500, body: { status: "error", message: "The search isn't available right now." } };
  await search("Sample");
  ok("a search the server can't run shows the server's sentence and no results", mlist().length === 0 && mstatus() === "The search isn't available right now.");
  { let release; hold = { action: "listCustomers", gate: new Promise(r => { release = r; }) };
    const n = of("listCustomers").length;
    type("pat"); await wait(() => of("listCustomers").length === n + 1);
    await search("Example Supply Co");
    release(); await pause(120);
    ok("a slow answer to an earlier search never replaces the newer search's results", mlist().length === 1 && mlist()[0].querySelector("b").textContent === "Example Supply Co" && mstatus() === "1 customer found"); }
  await closeMerge();
  ok("✕ closes the window, nothing was merged, and focus is back on the Merge button", !modal() && of("mergeCustomers").length === 0 && d.activeElement === q("#custMerge"));
  await openMerge();
  d.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  ok("Escape closes it too, focus back on the button", await wait(() => !modal()) && d.activeElement === q("#custMerge"));
  { let release; hold = { action: "listCustomers", gate: new Promise(r => { release = r; }) };
    await openMerge();
    const n = of("listCustomers").length;
    type("pat"); await wait(() => of("listCustomers").length === n + 1);
    const m = modal();
    await closeMerge();
    release(); await pause(120);
    ok("a search still on its way when the window is closed draws nothing afterwards", !modal() && m.querySelector("#custMergeList").children.length === 0 && m.querySelector("#custMergeStatus").textContent === ""); }

  console.log("\n=== Merge: the question, and backing out ===");
  reset();
  await openMerge();
  await search("pat");
  mlist()[0].click();
  ok("picking a customer swaps the search for one question", mpick().hidden === true && mconfirm().hidden === false);
  ok("…it names both customers (the one kept with its email), counts the orders that move — every order on the page, voided and test too — and says it can't be undone",
    mtext() === "Merge Pat Example into Pat Other (pat.e@example.com)?\n\n5 orders will move to Pat Other. Pat Example is then archived and can't be used again. This can't be undone.\n\n" +
      "A tax exemption is not carried over: if Pat Example is exempt, set the exemption on Pat Other yourself.");
  ok("…two buttons, “Choose another” and “Merge”, and focus on the safe one", same([...mconfirm().querySelectorAll("button")].map(b => b.textContent), ["Choose another", "Merge"]) && d.activeElement === modal().querySelector("#custMergeBack"));
  ok("…nothing has been merged by picking", of("mergeCustomers").length === 0 && merr() === "");
  modal().querySelector("#custMergeBack").click();
  ok("“Choose another” goes back to the search, as it was left, with focus in the box", mpick().hidden === false && mconfirm().hidden === true && d.activeElement === mq() && mq().value === "pat" && mlist().length === 1);
  modal().querySelector("#custMergeGo").click(); await pause(60);
  ok("…and the customer picked before is forgotten: Merge does nothing until one is picked again", of("mergeCustomers").length === 0);
  await search("Example Supply Co");
  mlist()[0].click();
  ok("a customer kept that has no email is named without one", /^Merge Pat Example into Example Supply Co\?\n\n5 orders will move to Example Supply Co\. /.test(mtext()));
  await closeMerge();
  ok("closing the window at the question merges nothing", of("mergeCustomers").length === 0 && d1.q("SELECT count(*) n FROM customers WHERE mergedIntoId IS NOT NULL")[0].n === 0);
  await open(B);
  await openMerge(); await search("Spare");
  mlist()[0].click();
  ok("one order reads “1 order will move”", /\n\n1 order will move to Spare Example\. Pat Other is then archived/.test(mtext()));
  await closeMerge();
  await open(C);
  await openMerge(); await search("Spare");
  mlist()[0].click();
  ok("none reads “0 orders will move”", /\n\n0 orders will move to Spare Example\. /.test(mtext()));
  await closeMerge();
  { const s = copy(real);
    s.orders = Array.from({ length: 500 }, (_, i) => ({ orderId: "O-5" + String(i).padStart(3, "0"), orgId: "acme", placedAt: "2026-01-10T15:00:00.000Z", total: 1, paidAmount: 1, balanceDue: 0, voided: false, isTest: false, completed: false }));
    s.totals = { orderCount: 640, totalSpent: 640, balanceDue: 0 };
    scripted = { action: "getCustomer", body: s };
    await open(A);
    ok("a customer with more orders than the page is sent: the 500 most recent are listed, and the page says the totals count them all", orderRows().length === 500 && tiles()[0] === "Orders 640" &&
      qa("#custPage .cust-note").some(n => n.textContent === "The 500 most recent orders are listed. The totals above count every order."));
    await openMerge(); await search("Spare");
    mlist()[0].click();
    ok("…and the merge question says “500 or more orders will move”", /\n\n500 or more orders will move to Spare Example\. /.test(mtext()));
    await closeMerge();
    s.orders.pop();
    scripted = { action: "getCustomer", body: s };
    await open(A);
    await openMerge(); await search("Spare");
    mlist()[0].click();
    ok("…one fewer and it is counted exactly: “499 orders will move”", /\n\n499 orders will move to Spare Example\. /.test(mtext()) && !/most recent orders are listed/.test(page().textContent));
    await closeMerge(); }

  console.log("\n=== Merge: refused by the server ===");
  await open(B);
  reset();
  await openMerge(); await search("Sample Target 02");
  mlist()[0].click();
  globalThis.__role281 = "staff";
  { const m = modal(), before = page();
    m.querySelector("#custMergeGo").click();
    await wait(() => of("mergeCustomers").length === 1 && !m.querySelector("#custMergeGo").disabled);
    ok("a merge the server refuses (a role without Full) shows the server's sentence in the window, as an alert", m.isConnected && merr() === "Your role can't do that here." && m.querySelector("#custMergeErr").getAttribute("role") === "alert" && same(of("mergeCustomers")[0], { action: "mergeCustomers", fromId: B, intoId: T[1], key: "cookie" }));
    ok("…the window stays on the question with Merge usable again, the page behind untouched, nothing merged and nothing said to be", mconfirm().hidden === false && m.querySelector("#custMergeGo").disabled === false && page() === before && hashNow() === "customers/" + B &&
      toasts.length === 0 && row(B).mergedIntoId == null && d1.q("SELECT customerId c FROM orders WHERE orderId = 'O-2001'")[0].c === B);
    globalThis.__role281 = "admin";
    // The customer picked was merged away by someone else in the meantime.
    const gone = await call({ action: "mergeCustomers", fromId: T[1], intoId: T[2] });
    reset();
    m.querySelector("#custMergeGo").click();
    await wait(() => of("mergeCustomers").length === 1 && !m.querySelector("#custMergeGo").disabled);
    ok("picking a customer that has itself been merged away meanwhile: the server's reason replaces the earlier one", gone.status === 200 && merr() === "One of these customers was already merged into another one." && row(B).mergedIntoId == null && toasts.length === 0);
    let release; hold = { action: "mergeCustomers", gate: new Promise(r => { release = r; }) };
    m.querySelector("#custMergeBack").click();
    await search("Sample Target 03"); mlist()[0].click();
    ok("picking again clears the refusal", merr() === "" && mtext().startsWith("Merge Pat Other into Sample Target 03?"));
    reset();
    // (held, then refused — the server is Back office again when it gets there — so nothing is merged here)
    m.querySelector("#custMergeGo").click();
    await wait(() => of("mergeCustomers").length === 1);
    ok("while a merge is on its way the Merge button is switched off", m.querySelector("#custMergeGo").disabled === true);
    globalThis.__role281 = "staff"; release();
    await wait(() => !m.querySelector("#custMergeGo").disabled);
    globalThis.__role281 = "admin";
    await closeMerge(); }

  console.log("\n=== Merge: done ===");
  reset();
  await openMerge(); await search("pat@example.com");
  ok("(the other Pat's page finds Pat Example to merge into)", mlist().length === 1 && mlist()[0].querySelector("b").textContent === "Pat Example" && /Example Club · pat@example\.com · 555-0122 · 3 orders/.test(mlist()[0].querySelector("span").textContent));
  mlist()[0].click();
  ok("the question: Pat Other into Pat Example (pat@example.com), 1 order", /^Merge Pat Other into Pat Example \(pat@example\.com\)\?\n\n1 order will move to Pat Example\. Pat Other is then archived/.test(mtext()));
  { const m = modal(), old = page(); reset();
    m.querySelector("#custMergeGo").click();
    ok("Merge closes the window and opens the customer that was kept", await wait(() => !m.isConnected && page() !== old && !!q("#custForm") && hashNow() === "customers/" + A));
    ok("…one mergeCustomers was sent: from this customer, into the one picked", of("mergeCustomers").length === 1 && same(of("mergeCustomers")[0], { action: "mergeCustomers", fromId: B, intoId: A, key: "cookie" }));
    ok("…the page reports how many orders moved: “Merged. 1 order moved.”", toasts.length === 1 && toasts[0].m === "Merged. 1 order moved." && !toasts[0].err);
    ok("…the kept customer's page now lists the order that moved, in its place by date", q(".cust-name").textContent === "Pat Example" && same(orderRows().map(tr => tr.children[0].textContent.trim()), ["O-1004", "O-1003", "O-1002", "O-2001", "O-1001", "O-1005"]) && tiles()[0] === "Orders 4");
    ok("…and in the database the order moved and the duplicate is merged away and archived", d1.q("SELECT customerId c FROM orders WHERE orderId = 'O-2001'")[0].c === A && row(B).mergedIntoId === A && row(B).archivedAt != null); }
  ok("opening the merged-away customer's old address shows the customer it was merged into", await open(B) && q(".cust-name").textContent === "Pat Example" && orderRows().length === 6);
  ok("…and the address follows to that customer", hashNow() === "customers/" + A);
  reset();
  set("custPhone", "555-0144");
  await redrawnAfter(save);
  ok("…so a save from there changes the kept customer, not the retired one", of("saveCustomer")[0].id === A && row(A).phone === "555-0144" && row(B).phone === "" && hashNow() === "customers/" + A);
  // Plural, and a customer with orders merged into one with none.
  await open(A);
  await openMerge(); await search("Spare");
  mlist()[0].click();
  { const m = modal(), old = page(); reset();
    m.querySelector("#custMergeGo").click();
    await wait(() => !m.isConnected && page() !== old && !!q("#custForm") && hashNow() === "customers/" + SPARE);
    ok("six orders moved reads “Merged. 6 orders moved.”, and the kept customer's page has all six", toasts.length === 1 && toasts[0].m === "Merged. 6 orders moved." && q(".cust-name").textContent === "Spare Example" && orderRows().length === 6);
    ok("…a tax exemption is not carried over: the kept customer is not exempt", q("#custExempt").checked === false && !q(".cust-sub .cust-tag") && row(SPARE).taxExempt === 0); }
  await open(C);
  await openMerge(); await search("Sample Target 04");
  mlist()[0].click();
  { const m = modal(), old = page(); reset();
    m.querySelector("#custMergeGo").click();
    await wait(() => !m.isConnected && page() !== old && !!q("#custForm"));
    ok("a customer with no orders: “Merged. 0 orders moved.”", toasts.length === 1 && toasts[0].m === "Merged. 0 orders moved." && hashNow() === "customers/" + T[3] && q(".cust-name").textContent === "Sample Target 04"); }

  console.log("\n=== Nothing typed is ever read as HTML ===");
  const X = await add({ name: "Temp Example" });
  await open(X);
  const evil = { name: `Pat <img src=x onerror="window.__x281=1">`, company: `Example "Club" & <b>Sons</b>`, notes: `</textarea><script>window.__x281=2</script><u>note</u>`, cert: `"><img src=x onerror="window.__x281=3">`,
    line1: `<i>1</i> Example "Street"`, phone: `<s>555</s>-0155` };
  set("custName", evil.name); set("custCompany", evil.company); set("custNotes", evil.notes); set("custCert", evil.cert); set("custLine1", evil.line1); set("custPhone", evil.phone);
  q("#custExempt").checked = true;
  reset();
  ok("a name, company, notes, address, phone and certificate full of markup are saved", await redrawnAfter(save) && toasts[0].m === "Customer saved." && row(X).name === evil.name && row(X).taxExemptCertificate === evil.cert && row(X).notes === evil.notes);
  ok("…and shown again exactly as typed, each in its own field", q("#custName").value === evil.name && q("#custCompany").value === evil.company && q("#custNotes").value === evil.notes && q("#custCert").value === evil.cert && q("#custLine1").value === evil.line1 && q("#custPhone").value === evil.phone);
  ok("…the heading, the line under it and the breadcrumb show them as text", q(".cust-name").textContent === evil.name && q("h1.org-name").textContent === evil.name && q(".bc-current").textContent === evil.name && q(".cust-sub").textContent.trim().startsWith(evil.company + " · Customer since"));
  ok("…no element came of any of it, on the page or in its heading", !q("#app img, #app script, #app u, #app i, #app s") && !q(".cust-name *") && !q(".cust-sub b") && qa("#custForm textarea").length === 1 && qa("#custForm input").length === 12);
  ok("…and none of its script ran", w.__x281 === undefined);
  q("#custArchive").click();
  { await wait(() => confirmBox());
    const box = confirmBox();
    ok("the Archive question shows the name as text", box.dataset.message.startsWith("Archive " + evil.name + "?") && box.textContent.includes(evil.name) && !box.querySelector("img"));
    box.querySelector("#cmCancel").click(); await wait(() => !confirmBox()); }
  await openMerge();
  ok("the merge window's opening line shows the name as text", modal().querySelector("#custMergeIntro").textContent.includes(evil.name + "'s orders move to it") && !modal().querySelector("img"));
  await search("Sample Target 01");
  mlist()[0].click();
  ok("…and so does its question", mtext().startsWith("Merge " + evil.name + " into Sample Target 01 (t01@example.com)?") && !modal().querySelector("img, script") && w.__x281 === undefined);
  await closeMerge();
  await open(T[4]);
  await openMerge(); await search("Pat <img");
  ok("in the merge search a customer's name and company are listed as text", mlist().length === 1 && mlist()[0].querySelector("b").textContent === evil.name && mlist()[0].querySelector("span").textContent.startsWith(evil.company + " · " + evil.phone) && !modal().querySelector("img, s") && mlist()[0].querySelectorAll("b").length === 1);
  mlist()[0].click();
  ok("…and named as text in the question when picked", mtext().includes("will move to " + evil.name + ". Sample Target 05 is then archived") && !modal().querySelector("img") && w.__x281 === undefined);
  await closeMerge();

  console.log("\n=== A customer the server sends with no name ===");
  { const s = copy(real); s.customer = Object.assign({}, s.customer, { id: 77, name: "", company: "", email: "only@example.com", archived: false, taxExempt: false }); s.orders = []; s.totals = { orderCount: 0, totalSpent: 0, balanceDue: 0 };
    scripted = { action: "getCustomer", body: s };
    await open(T[5]);
    ok("with only an email, the email is the heading", q(".cust-name").textContent === "only@example.com" && q(".cust-sub").textContent.trim().startsWith("Customer since"));
    ok("…and an answer that is a different customer than asked for moves the address to that customer", hashNow() === "customers/77");
    const s2 = copy(s); s2.customer.email = "";
    scripted = { action: "getCustomer", body: s2 };
    await open(77);
    ok("with nothing at all it is “Customer <number>”", q(".cust-name").textContent === "Customer 77" && /Customer 77/.test(d.title)); }

  console.log("\n=== An order number really does open the order (the real Orders page) ===");
  await open(SPARE);
  { const a = orderRows().map(tr => tr.children[0].querySelector("a")).find(x => x.textContent === "O-1001");
    a.click();
    const there = await wait(() => qa("#adminPanel tr[data-order], #adminPanel .order-card[data-order-card]").some(el => (el.dataset.order || el.dataset.orderCard) === "O-1001"), 900);
    ok("pressing O-1001 on the customer's page lands on its shop's Orders page with that order in the list", there && /^orders\/acme/.test(hashNow()) && !q("#custPage")); }

  const c = counts();
  console.log("\n" + c.passed + " checks passed, " + c.failed + " did not.");
  dom.window.close();
})().catch((e) => { console.error(e); ok("the test ran to its end", false); });
