const fs = require("fs");
const { storefrontPage } = require("./testlib/storefront-page");
const { autoConfirm } = require("./testlib/confirm.js");
const { ok, counts } = require("./testlib/check");
const { adminAs, asRole, effectivePermissions, DEFAULT_ROLES } = require("./testlib/roles");
const { JSDOM, ResourceLoader, VirtualConsole } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");

// Customer records (migrations/0108) on the Orders page and from a customer's page — public/admin.js run in the real
// admin page (jsdom) against the real orders.js / db.js on sql.js:
//   orderCustomerId_ / orderCustomerNameHtml_ — a linked order's customer name is a link to the customer's page, in
//     the table and in the phone cards, for a role that may open Customers; plain text otherwise;
//   adminActionCell's "Link to a customer…" / "Unlink customer" — who is offered them, and on which orders;
//   linkOrderCustomer_ / pickCustomerModal_ / wireCustomerSearch_ / customerLine_ — the dialog: what the search starts
//     on, typing, the keyboard, pick, Link, Cancel, Escape;
//   unlinkOrderCustomer_ / setOrderCustomer_ — the question ("Unlink"), the database, the row redrawn, a refusal shown;
//   adminNewSaleForCustomer_ / askSaleShop_ — the Local sale form with the customer picked, "Which shop is the sale
//     in?" with more than one shop, and the customer's page drawn again after the sale.
// Invented data only.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + `\nreturn { insertOrder, createProduct };`)();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  strip(read("functions/_lib/permissions.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'olive@example.test';\n" + adminAs({ roleFrom: "globalThis.__test283Role" }) + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
const pause = (ms) => new Promise(r => setTimeout(r, ms));
const wait = async (cond, n = 400) => { for (let i = 0; i < n && !cond(); i++) await pause(10); return !!cond(); };

(async () => {
  globalThis.__test283Role = "admin";
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const call = async (body) => {
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => Promise.resolve(p).catch(() => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Example Club','t','t'), ('rec','rec','Rec League','t','t');`);
  await lib.createProduct(d1, "acme", { productId: "cap", type: "cap", name: "Club cap", pricingMode: "flat", flatPrice: 20, visible: true, noDesignNeeded: true });
  await lib.createProduct(d1, "rec", { productId: "cap", type: "cap", name: "League cap", pricingMode: "flat", flatPrice: 25, visible: true, noDesignNeeded: true });
  // Every order is a few hours to days old, so it is inside the Orders page's default dates whatever today is.
  const ago = (hours) => new Date(Date.now() - hours * 3600000).toISOString();
  const mk = (orderId, hours, customerName, contact) => lib.insertOrder(d1, { orderId, orgId: "acme", customerName, contact, paymentMethod: "Cash", placedAt: ago(hours) },
    [{ productId: "cap", name: "Club cap", type: "cap", size: "OSFA", qty: 1, unitPrice: 20 }]);
  await mk("L1", 30, "Pat <Example>", "pat@example.com");        // linked by its email
  await mk("L2", 31, "Pat <Example>", "pat@example.com");        // the same customer again
  await mk("U1", 32, "Sam Sample", "555-0100");                  // a phone number: not linked
  await mk("U2", 33, "Local Sale", "555-0101");                  // the name a sale gets when none is typed
  await mk("U3", 34, "", "");                                    // nobody named
  await mk("U4", 35, "Walk In", "555-0102");
  await mk("V1", 36, "Vera Void", "vera@example.com");           // voided, linked
  await mk("V2", 37, "Val Void", "555-0103");                    // voided, not linked
  await mk("C1", 38, "Cal Cancelled", "cal@example.com");        // every line cancelled, linked
  await mk("C2", 39, "Cam Cancelled", "555-0104");               // every line cancelled, not linked
  d1._raw.run("UPDATE orders SET voidedAt = ?, voidReason = 'entered twice' WHERE orderId IN ('V1','V2')", [ago(1)]);
  d1._raw.run("UPDATE order_items SET cancelDate = ? WHERE orderId IN ('C1','C2')", [ago(1)]);
  const newCustomer = async (fields) => (await call(Object.assign({ action: "saveCustomer" }, fields))).body.id;
  const samId = await newCustomer({ name: "Sam Sample", company: "Sample Works", email: "sam@example.com", phone: "555-0100" });
  const clubId = await newCustomer({ name: "", company: "Example Boosters", email: "", phone: "" });
  const phoneId = await newCustomer({ name: "Lee Sample", company: "", email: "", phone: "555-0101" });
  const tessId = await newCustomer({ name: "Tess Sample", company: "", email: "tess@example.com", phone: "", taxExempt: true });
  for (let i = 1; i <= 9; i++) await newCustomer({ name: "Bulk Buyer " + i, company: "", email: "bulk" + i + "@example.com", phone: "" });
  const custOf = (orderId) => d1.q("SELECT customerId FROM orders WHERE orderId = ?", orderId)[0].customerId;
  const patId = custOf("L1");
  ok("the test's own data: an order with an email is on a customer's record, one with a phone number is not",
    Number.isInteger(patId) && patId > 0 && custOf("L2") === patId && custOf("U1") === null && [samId, clubId, phoneId, tessId].every(n => Number.isInteger(n) && n > 0));

  // ---- The page ------------------------------------------------------------------------------------------------
  const adminJs = read("public/admin.js"), customersJs = read("public/admin-customers.js");
  const sent = [], toasts = [];
  let scripted = null;   // { action, status, body } or { action, down: true }: the next answer to that action
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
  const dom = new JSDOM(storefrontPage(), { runScripts: "dangerously", resources: new Loader(), virtualConsole: vc, url: "https://admin.example.com/#orders/acme", pretendToBeVisual: true,
    beforeParse(win) {
      autoConfirm(win, () => true);
      win.__width = 1200;   // a desk's screen; 500 is a phone (the Orders page's cards)
      win.CSS = win.CSS || { escape: (s) => String(s).replace(/["\\]/g, "\\$&") };
      win.scrollTo = () => {};
      win.matchMedia = (q) => { const m = /max-width:\s*(\d+)px/.exec(q); return { get matches() { return m ? win.__width <= Number(m[1]) : false; }, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }; };
      win.fetch = async (url, init) => {
        const u = String(url), b = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
        if (u.includes("/api/orders")) {
          sent.push(b);
          if (scripted && scripted.action === b.action) { const s = scripted; scripted = null; if (s.down) throw new TypeError("Failed to fetch"); return reply(s.status, s.body); }
          const x = await call(b);
          return reply(x.status, x.body);
        }
        return reply(404, { status: "error", message: "not here" });
      };
    } });
  const w = dom.window, d = w.document;
  await pause(150);
  await w.loadAdminScript();
  w.showToast = (m, isErr) => toasts.push({ m: String(m), err: !!isErr });
  const SHOPS = [{ orgId: "acme", name: "Example Club" }, { orgId: "rec", name: "Rec League" }];
  const setShops = (list) => w.eval("adminOrgs = " + JSON.stringify(list) + ";");
  // Signed in as a built-in role, in the page and on the server alike. `change`: that role with some levels changed
  // (the page only — what the page offers is what is being looked at).
  const signIn = (role, change) => {
    globalThis.__test283Role = role;
    w.eval('adminKey = "cookie"; ' + asRole(role, { name: "Olive", email: "olive@example.test" }));
    if (change) w.eval("adminPerms = " + JSON.stringify(Object.assign({}, effectivePermissions(DEFAULT_ROLES[role]), change)) + ";");
  };
  setShops(SHOPS);
  signIn("admin");
  const app = d.getElementById("app"), org = SHOPS[0];
  const lastToast = () => toasts[toasts.length - 1] || { m: "", err: false };
  const reset = () => { sent.length = 0; toasts.length = 0; };
  const actions = () => sent.map(b => b.action);
  const of = (action) => sent.filter(b => b.action === action);
  const text = (el) => (el ? el.textContent : "").replace(/\s+/g, " ").trim();
  const key = (el, k) => { const e = new w.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }); el.dispatchEvent(e); return e; };
  const typeIn = (el, v) => { el.value = v; el.dispatchEvent(new w.Event("input", { bubbles: true })); };

  // The Orders list of the first shop, cancelled and voided orders included, on a desk (table) or a phone (cards).
  const drawOrders = async (width) => {
    w.__width = width || 1200;
    w._orderView.includeCancelled = true;
    w.location.hash = "#orders/acme";
    await w.renderAdminOrders(app, org);
    await wait(() => d.querySelector(w.__width > 760 ? '#adminPanel tr[data-order="L1"]' : '#adminPanel .order-card[data-order-card="L1"]'));
  };
  const rowsOf = (id) => [...d.querySelectorAll(`#adminPanel tr[data-order="${id}"]`)];
  const cardOf = (id) => d.querySelector(`#adminPanel .order-card[data-order-card="${id}"]`);
  // Where the order's customer name is: the table's Customer cell, or the card's heading.
  const nameBox = (id) => cardOf(id) ? cardOf(id).querySelector(".oc-name") : (rowsOf(id)[0] ? rowsOf(id)[0].children[[...d.querySelectorAll("#adminPanel thead th")].findIndex(th => th.textContent === "Customer")] : null);
  const nameLink = (id) => nameBox(id) && nameBox(id).querySelector("a");
  const inOrder = (id, sel) => cardOf(id) ? cardOf(id).querySelector(sel) : (rowsOf(id).map(tr => tr.querySelector(sel)).find(Boolean) || null);
  const linkBtn = (id) => inOrder(id, '[data-admin-action="linkOrderCustomer_"]');
  const unlinkBtn = (id) => inOrder(id, '[data-admin-action="unlinkOrderCustomer_"]');
  const cached = (id) => (w._ordersCache.acme || []).find(o => o.orderId === id);
  const listReads = () => actions().filter(a => a === "getOrders" || a === "getOrdersByIds" || a === "getOrdersAllShops").length;

  console.log("=== An order's customer name on the Orders page (orderCustomerId_, orderCustomerNameHtml_) ===");
  await drawOrders();
  ok("the server sends each order's customer: its id when linked, nothing when not", cached("L1").customerId === patId && cached("U1").customerId == null);
  ok("in the table a linked order's customer name is a link to that customer's page", !!nameLink("L1") && /^#\/?customers\/\d+$/.test(nameLink("L1").getAttribute("href")) &&
    nameLink("L1").getAttribute("href").replace(/^#\/?/, "") === "customers/" + patId && nameLink("L1").textContent === "Pat <Example>");
  ok("…it says what it opens, and what the customer typed is shown as text, not as markup", nameLink("L1").title === "Open this customer's record" && !nameBox("L1").querySelector("example") &&
    nameBox("L1").innerHTML.includes("Pat &lt;Example&gt;"));
  ok("…an order that isn't linked shows the name as plain text", !!nameBox("U1") && !nameLink("U1") && text(nameBox("U1")) === "Sam Sample");
  ok("…a voided order and one with every line cancelled keep the link to their customer", !!nameLink("V1") && nameLink("V1").getAttribute("href").endsWith("customers/" + custOf("V1")) && /VOID/.test(text(nameBox("V1"))) &&
    !!nameLink("C1") && nameLink("C1").getAttribute("href").endsWith("customers/" + custOf("C1")));
  ok("…a voided or cancelled order that isn't linked stays plain text", !nameLink("V2") && /^Val Void/.test(text(nameBox("V2"))) && !nameLink("C2") && /^Cam Cancelled/.test(text(nameBox("C2"))));
  const idOf = (v) => w.orderCustomerId_(v);
  ok("an order's customer id is a positive whole number, or nothing: null, \"\", 0, a negative, a fraction and a word are all \"not linked\"",
    idOf({ customerId: 7 }) === 7 && idOf({ customerId: "7" }) === 7 && idOf({ customerId: null }) === null && idOf({ customerId: "" }) === null && idOf({}) === null && idOf(null) === null &&
    idOf({ customerId: 0 }) === null && idOf({ customerId: -3 }) === null && idOf({ customerId: 1.5 }) === null && idOf({ customerId: "abc" }) === null);
  ok("a linked order with no name on it still gives a link, reading \"Customer\"", (() => { const box = d.createElement("div"); box.innerHTML = w.orderCustomerNameHtml_({ customerId: 12, customerName: "" });
    const a = box.querySelector("a"); return !!a && a.textContent === "Customer" && a.getAttribute("href").replace(/^#\/?/, "") === "customers/12"; })());
  ok("one customer as a line of text: name, company, email and phone that it has, else \"Customer <id>\"",
    w.customerLine_({ id: 4, name: "Pat Example", company: "Example Club", email: "pat@example.com", phone: "555-0100" }) === "Pat Example · Example Club · pat@example.com · 555-0100" &&
    w.customerLine_({ id: 4, name: " ", company: "Example Club", email: "", phone: null }) === "Example Club" && w.customerLine_({ id: 4 }) === "Customer 4");

  signIn("production");
  await drawOrders();
  ok("Production (may read Customers): the name is still a link", !!nameLink("L1") && nameLink("L1").getAttribute("href").replace(/^#\/?/, "") === "customers/" + patId);
  signIn("admin", { "customers.records": "none" });
  await drawOrders();
  ok("a role that may not open Customers: the name is plain text, no link", !!nameBox("L1") && !nameLink("L1") && text(nameBox("L1")) === "Pat <Example>" && !d.querySelector("#adminPanel a.order-customer-link"));
  ok("…and neither Link nor Unlink is offered to it", !d.querySelector('#adminPanel [data-admin-action="linkOrderCustomer_"], #adminPanel [data-admin-action="unlinkOrderCustomer_"]'));

  signIn("admin");
  await drawOrders(500);
  ok("on a phone the orders are cards, and a linked order's name in its card is the same link", !!cardOf("L1") && !d.querySelector("#adminPanel .orders-table-wrap") &&
    !!nameLink("L1") && nameLink("L1").closest(".oc-name") === nameBox("L1") && nameLink("L1").getAttribute("href").replace(/^#\/?/, "") === "customers/" + patId && nameLink("L1").textContent === "Pat <Example>");
  ok("…an unlinked order's card shows the name as plain text", !!cardOf("U1") && !nameLink("U1") && text(nameBox("U1")) === "Sam Sample");
  signIn("admin", { "customers.records": "none" });
  await drawOrders(500);
  ok("…and for a role that may not open Customers every card's name is plain text", !!cardOf("L1") && !d.querySelector("#adminPanel a.order-customer-link") && text(nameBox("L1")) === "Pat <Example>");

  console.log("\n=== Who is offered \"Link to a customer…\" and \"Unlink customer\" (adminActionCell) ===");
  signIn("admin");
  await drawOrders();
  ok("an order that isn't linked offers \"Link to a customer…\", and not Unlink", !!linkBtn("U1") && linkBtn("U1").textContent === "Link to a customer…" && !unlinkBtn("U1") &&
    linkBtn("U1").dataset.org === "acme" && linkBtn("U1").dataset.order === "U1" && linkBtn("U1").title === "Put this order on a customer's record");
  ok("a linked order offers \"Unlink customer\", and not Link", !!unlinkBtn("L1") && unlinkBtn("L1").textContent === "Unlink customer" && !linkBtn("L1") &&
    unlinkBtn("L1").dataset.order === "L1" && unlinkBtn("L1").title === "Take this order off its customer's record");
  ok("…both are marked as needing Customers at edit", linkBtn("U1").dataset.need === "customers.records:edit" && unlinkBtn("L1").dataset.need === "customers.records:edit");
  ok("a voided order offers neither, linked or not", rowsOf("V1").length > 0 && rowsOf("V2").length > 0 && !linkBtn("V1") && !unlinkBtn("V1") && !linkBtn("V2") && !unlinkBtn("V2"));
  ok("an order whose every line is cancelled offers neither, linked or not", rowsOf("C1").length > 0 && /Cancelled/.test(text(rowsOf("C1")[0])) && !linkBtn("C1") && !unlinkBtn("C1") && !linkBtn("C2") && !unlinkBtn("C2"));
  signIn("staff");
  await drawOrders();
  ok("Back office (Customers at edit) is offered both", !!linkBtn("U1") && !!unlinkBtn("L1"));
  signIn("production");
  await drawOrders();
  ok("Production (Customers at read only) is offered neither, on any order", rowsOf("U1").length > 0 && rowsOf("L1").length > 0 &&
    !d.querySelector('#adminPanel [data-admin-action="linkOrderCustomer_"], #adminPanel [data-admin-action="unlinkOrderCustomer_"]'));
  signIn("admin");
  await drawOrders(500);
  ok("on a phone the card has the same buttons: Link on an unlinked order, Unlink on a linked one, neither on a voided or cancelled one",
    !!linkBtn("U1") && linkBtn("U1").closest(".oc-actions") && !unlinkBtn("U1") && !!unlinkBtn("L1") && !linkBtn("L1") &&
    !!cardOf("V2") && !linkBtn("V2") && !unlinkBtn("V1") && !!cardOf("C2") && !linkBtn("C2") && !unlinkBtn("C1"));

  console.log("\n=== Link to a customer… : the window (linkOrderCustomer_, pickCustomerModal_) ===");
  await drawOrders();
  const form = () => d.getElementById("pickCustomerForm");
  const search = () => d.getElementById("pcSearch"), list = () => d.getElementById("pcSearchList"), note = () => d.getElementById("pcSearchNote");
  const picked = () => d.getElementById("pcPicked"), linkGo = () => form().querySelector(".admin-pass-submit");
  const found = () => [...list().querySelectorAll("button[data-i]")];
  const lastSearch = () => of("listCustomers")[of("listCustomers").length - 1];
  reset();
  linkBtn("U1").click();
  await wait(() => form() && found().length === 1);
  ok("the button opens a window named for the order, saying what linking does", text(form().querySelector("[data-dialog-title]")) === "Link order U1 to a customer" &&
    /The order joins that customer's history and totals\. The name and contact on the order itself stay as they are\./.test(text(form())));
  ok("…it is a dialog with a labelled Customer search field, and the keyboard starts in that field", form().getAttribute("role") === "dialog" && form().getAttribute("aria-modal") === "true" &&
    text(form().querySelector('label[for="pcSearch"]')) === "Customer" && search().type === "search" && d.activeElement === search());
  ok("…the search starts on the order's customer name, and is asked for at once (eight at most, archived left out)", search().value === "Sam Sample" && of("listCustomers").length === 1 &&
    lastSearch().q === "Sam Sample" && lastSearch().limit === 8 && lastSearch().offset === 0 && lastSearch().includeArchived === false);
  ok("…the match is listed as a button with the customer's name, company, email and phone, and how many were found is said",
    found().length === 1 && text(found()[0].querySelector("strong")) === "Sam Sample" && /Sample Works · sam@example\.com · 555-0100/.test(text(found()[0])) && text(note()) === "1 customer found." && list().style.display !== "none");
  ok("…Link is disabled until a customer is picked, and nothing is shown as picked", linkGo().disabled && linkGo().textContent === "Link" && picked().style.display === "none");
  form().dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
  ok("…sending the form with nobody picked says to search and pick first, and sends nothing", text(d.getElementById("pcErr")) === "Search for the customer and pick them from the list first." &&
    d.getElementById("pcErr").style.display !== "none" && !!form() && of("setOrderCustomer").length === 0 && d.activeElement === search());
  form().querySelector(".admin-pass-cancel").click();
  await pause(30);
  ok("Cancel closes the window: nothing is sent, the order stays unlinked and its row is as it was", !form() && of("setOrderCustomer").length === 0 && custOf("U1") === null && !!linkBtn("U1") && toasts.length === 0);

  reset();
  linkBtn("U2").click();
  await wait(() => form() && found().length === 1);
  ok("an order named \"Local Sale\" (no name was typed) starts the search on its contact instead", search().value === "555-0101" && lastSearch().q === "555-0101" && text(found()[0].querySelector("strong")) === "Lee Sample");
  key(d, "Escape");
  ok("Escape closes the window, linking nothing", await wait(() => !form()) && of("setOrderCustomer").length === 0 && custOf("U2") === null);

  reset();
  linkBtn("U3").click();
  await wait(() => form());
  await pause(40);
  ok("an order with no name and no contact opens on an empty search, and nothing is asked for yet", search().value === "" && of("listCustomers").length === 0 && found().length === 0 && note().style.display === "none");

  console.log("\n=== …searching in it (wireCustomerSearch_) ===");
  typeIn(search(), "Tess");
  ok("typing doesn't ask at once (it waits a moment for the next key)", of("listCustomers").length === 0);
  await wait(() => found().length === 1);
  ok("…then asks for what was typed, once", of("listCustomers").length === 1 && lastSearch().q === "Tess");
  ok("…a tax-exempt customer is marked \"Exempt\" in the list", /Tess Sample/.test(text(found()[0])) && /Exempt/.test(text(found()[0].querySelector("span"))));
  typeIn(search(), "Te"); typeIn(search(), "Tes"); typeIn(search(), "Example Boost");
  await wait(() => found().length === 1 && /Example Boosters/.test(text(found()[0])));
  ok("typing quickly asks only for the last thing typed", of("listCustomers").length === 2 && lastSearch().q === "Example Boost");
  ok("…a customer with a company and no name is listed by the company", text(found()[0].querySelector("strong")) === "Example Boosters" && !/Exempt/.test(text(found()[0])));
  typeIn(search(), "Bulk Buyer");
  await wait(() => found().length === 8);
  ok("more than eight matches: the first eight, and a note to keep typing", found().length === 8 && text(note()) === "Showing the first 8 of 9 — keep typing to narrow it down.");
  let ev = key(search(), "Enter");
  ok("Enter in the field with several matches picks nobody, and never sends the form around it", ev.defaultPrevented && linkGo().disabled && picked().style.display === "none" && !!form());
  key(search(), "ArrowDown");
  ok("↓ goes from the field into the list", d.activeElement === found()[0]);
  key(found()[0], "ArrowDown");
  ok("…↓ again moves to the next match", d.activeElement === found()[1]);
  key(found()[1], "ArrowUp"); const backOnFirst = d.activeElement === found()[0];
  key(found()[0], "ArrowUp");
  ok("…↑ moves back up, and from the first match returns to the field", backOnFirst && d.activeElement === search());
  found()[7].focus(); key(found()[7], "ArrowDown");
  ok("…↓ on the last match stays on it", d.activeElement === found()[7]);
  ev = key(found()[7], "Escape");
  ok("Escape in the list closes the list and returns to the field — the window stays open", found().length === 0 && list().style.display === "none" && note().style.display === "none" &&
    d.activeElement === search() && !!form() && ev.defaultPrevented);
  typeIn(search(), "Bulk Buyer 1");
  await wait(() => found().length === 1);
  ev = key(search(), "Escape");
  ok("Escape in the field closes an open list first, not the window", found().length === 0 && !!form() && ev.defaultPrevented);
  typeIn(search(), "Nobody By That Name");
  await wait(() => /No customer/.test(text(note())));
  ok("no match: \"No customer matches that.\", and no list", text(note()) === "No customer matches that." && found().length === 0 && list().style.display === "none");
  key(search(), "Enter");
  ok("…Enter then picks nobody", linkGo().disabled && picked().style.display === "none");
  scripted = { action: "listCustomers", status: 503, body: { status: "error", message: "Customers aren't set up on this database yet." } };
  typeIn(search(), "Sam");
  await wait(() => /Couldn't search/.test(text(note())));
  ok("a search the server refuses says so with the server's sentence", text(note()) === "Couldn't search the customers: Customers aren't set up on this database yet." && found().length === 0);
  typeIn(search(), "   ");
  await pause(330);
  ok("emptying the field clears the list and the note without asking the server", found().length === 0 && note().style.display === "none" && lastSearch().q === "Sam");
  typeIn(search(), "sam@example.com");
  await wait(() => found().length === 1);
  key(search(), "Enter");
  ok("Enter in the field with exactly one match picks it: shown as picked, the search emptied, Link enabled with the keyboard on it",
    text(picked()) === "Picked: Sam Sample · Sample Works · sam@example.com · 555-0100" && picked().style.display !== "none" && search().value === "" && found().length === 0 &&
    !linkGo().disabled && d.activeElement === linkGo() && d.getElementById("pcErr").style.display === "none");
  form().querySelector(".admin-pass-cancel").click();
  await pause(30);
  ok("…Cancel after picking still links nothing", !form() && of("setOrderCustomer").length === 0 && custOf("U3") === null);

  console.log("\n=== Link: the order is put on the customer's record (setOrderCustomer_) ===");
  reset();
  linkBtn("U1").click();
  await wait(() => form() && found().length === 1);
  found()[0].click();
  ok("clicking a match picks it", text(picked()) === "Picked: Sam Sample · Sample Works · sam@example.com · 555-0100" && !linkGo().disabled);
  const u1RowBefore = rowsOf("U1")[0], l2RowBefore = rowsOf("L2")[0];
  linkGo().click();
  await wait(() => unlinkBtn("U1"));
  ok("Link sends the order, its shop and the customer picked", of("setOrderCustomer").length === 1 && of("setOrderCustomer")[0].org === "acme" && of("setOrderCustomer")[0].orderId === "U1" && of("setOrderCustomer")[0].customerId === samId);
  ok("…the order is linked in the database, its name and contact unchanged", custOf("U1") === samId &&
    d1.q("SELECT customerName, contact FROM orders WHERE orderId='U1'")[0].customerName === "Sam Sample" && d1.q("SELECT contact FROM orders WHERE orderId='U1'")[0].contact === "555-0100");
  ok("…the window closes and a message names the order and the customer", !form() && lastToast().m === "Order U1 linked to Sam Sample." && !lastToast().err);
  ok("…the order's row is drawn again: its name is now the link, and it offers Unlink instead of Link", !!nameLink("U1") && nameLink("U1").getAttribute("href").replace(/^#\/?/, "") === "customers/" + samId &&
    nameLink("U1").textContent === "Sam Sample" && !!unlinkBtn("U1") && !linkBtn("U1") && rowsOf("U1")[0] !== u1RowBefore);
  ok("…from what the page already knew: no list is loaded again, and the other rows are left alone", listReads() === 0 && rowsOf("L2")[0] === l2RowBefore && cached("U1").customerId === samId);

  reset();
  linkBtn("U4").click();
  await wait(() => form() && search().value === "Walk In");
  typeIn(search(), "Example Boosters");
  await wait(() => found().length === 1);
  found()[0].click();
  linkGo().click();
  await wait(() => unlinkBtn("U4"));
  ok("linking to a customer with only a company names the company in the message", custOf("U4") === clubId && lastToast().m === "Order U4 linked to Example Boosters." && !lastToast().err);

  // What the list shows for rows a search can send: an archived customer, one with neither name nor company.
  reset();
  linkBtn("U3").click();
  await wait(() => form());
  scripted = { action: "listCustomers", status: 200, body: { status: "ok", total: 2, customers: [
    { id: tessId, name: "", company: "", email: "", phone: "", taxExempt: false, archived: true },
    { id: samId, name: "Sam Sample", company: "Sample Works", email: "sam@example.com", phone: "555-0100", taxExempt: false, archived: false }] } };
  typeIn(search(), "Anyone");
  await wait(() => found().length === 2);
  ok("two matches: \"2 customers found.\"", text(note()) === "2 customers found.");
  ok("…an archived customer is marked \"Archived\", and one with neither name nor company is listed as \"Customer <id>\"",
    text(found()[0].querySelector("strong")) === "Customer " + tessId && /Archived/.test(text(found()[0])) && !/Archived/.test(text(found()[1])));
  found()[0].click();
  ok("…picking that one shows \"Picked: Customer <id>\"", text(picked()) === "Picked: Customer " + tessId);
  linkGo().click();
  await wait(() => unlinkBtn("U3"));
  ok("…and Link says the order was \"linked to the customer.\"", custOf("U3") === tessId && lastToast().m === "Order U3 linked to the customer." && !lastToast().err);

  console.log("\n=== Link: the server's refusal is shown ===");
  reset();
  linkBtn("U2").click();
  await wait(() => form() && found().length === 1);
  found()[0].click();
  d1._raw.run("UPDATE customers SET mergedIntoId = ?, archivedAt = ? WHERE id = ?", [samId, ago(0), phoneId]);   // merged away while the window was open
  linkGo().click();
  await wait(() => toasts.length > 0);
  ok("a customer merged away in the meantime: the server's sentence is shown as a problem", lastToast().m === "Couldn't link the order: That customer was merged into another one. Open that one instead." && lastToast().err);
  ok("…the order stays unlinked, in the database and on the page, and still offers Link", custOf("U2") === null && !!linkBtn("U2") && !unlinkBtn("U2") && !nameLink("U2") && cached("U2").customerId == null && listReads() === 0);
  d1._raw.run("UPDATE customers SET mergedIntoId = NULL, archivedAt = NULL WHERE id = ?", [phoneId]);
  reset();
  linkBtn("U2").click();
  await wait(() => form() && found().length === 1);
  found()[0].click();
  scripted = { action: "setOrderCustomer", down: true };
  linkGo().click();
  await wait(() => toasts.length > 0);
  ok("a server that can't be reached: \"Couldn't link the order: …\", and nothing changes", /^Couldn't link the order: \S/.test(lastToast().m) && lastToast().err && custOf("U2") === null && !!linkBtn("U2"));

  console.log("\n=== Unlink customer (unlinkOrderCustomer_) ===");
  const asked = [];
  const answer = (yes) => autoConfirm(w, (msg) => { const ov = d.querySelector(".confirm-modal"); asked.push({ msg, okLabel: text(ov.querySelector("#cmOk")), cancelLabel: text(ov.querySelector("#cmCancel")), danger: /admin-btn-danger/.test(ov.querySelector("#cmOk").className) }); return yes; });
  answer(false);
  reset();
  unlinkBtn("L1").click();
  await wait(() => asked.length === 1);
  await pause(60);
  ok("Unlink asks first, naming the order and saying the order itself doesn't change and can be linked again",
    /^Take order L1 off its customer's record\?/.test(asked[0].msg) && /The order itself doesn't change/.test(asked[0].msg) && /no longer counts in that customer's history and totals/.test(asked[0].msg) && /You can link it again at any time\./.test(asked[0].msg));
  ok("…the button that goes ahead reads \"Unlink\" (not marked as destructive), beside Cancel", asked[0].okLabel === "Unlink" && asked[0].cancelLabel === "Cancel" && asked[0].danger === false);
  ok("…Cancel leaves it: nothing sent, the order still linked, its row as it was", of("setOrderCustomer").length === 0 && custOf("L1") === patId && !!unlinkBtn("L1") && !!nameLink("L1") && toasts.length === 0);
  answer(true);
  const l1RowBefore = rowsOf("L1")[0];
  unlinkBtn("L1").click();
  await wait(() => linkBtn("L1"));
  ok("…Unlink sends the order with no customer", of("setOrderCustomer").length === 1 && of("setOrderCustomer")[0].orderId === "L1" && of("setOrderCustomer")[0].org === "acme" && of("setOrderCustomer")[0].customerId === null);
  ok("…the order is off the record in the database, and the customer's other order stays on it", custOf("L1") === null && custOf("L2") === patId);
  ok("…a message says so", lastToast().m === "Order L1 is no longer linked to a customer." && !lastToast().err);
  ok("…the row is drawn again: the name is plain text and it offers \"Link to a customer…\"", !nameLink("L1") && text(nameBox("L1")) === "Pat <Example>" && !!linkBtn("L1") && !unlinkBtn("L1") &&
    rowsOf("L1")[0] !== l1RowBefore && listReads() === 0 && cached("L1").customerId == null);
  // The server's refusal: the order is gone by the time Unlink is pressed.
  reset();
  d1._raw.run("PRAGMA foreign_keys = OFF"); d1._raw.run("UPDATE orders SET orderId = 'L2-MOVED' WHERE orderId = 'L2'");
  unlinkBtn("L2").click();
  await wait(() => toasts.length > 0);
  ok("an order the server no longer has: its refusal is shown as a problem (\"Couldn't unlink the order: …\")", lastToast().m === "Couldn't unlink the order: Order not found" && lastToast().err);
  ok("…and the row keeps its link and its Unlink button", !!unlinkBtn("L2") && !!nameLink("L2") && cached("L2").customerId === patId);
  d1._raw.run("UPDATE orders SET orderId = 'L2' WHERE orderId = 'L2-MOVED'"); d1._raw.run("PRAGMA foreign_keys = ON");
  ok("…nothing was changed in the database", custOf("L2") === patId);

  console.log("\n=== Link and Unlink on a phone: the card is drawn again ===");
  await drawOrders(500);
  reset();
  const l1CardBefore = cardOf("L1");
  linkBtn("L1").click();
  await wait(() => form() && found().length >= 1);
  typeIn(search(), "pat@example.com");
  await wait(() => found().length === 1 && /pat@example\.com/.test(text(found()[0])));
  found()[0].click();
  linkGo().click();
  await wait(() => unlinkBtn("L1"));
  ok("Link from a card: linked in the database, and the card redrawn with the name as a link and Unlink", custOf("L1") === patId && cardOf("L1") !== l1CardBefore && !!nameLink("L1") &&
    nameLink("L1").getAttribute("href").replace(/^#\/?/, "") === "customers/" + patId && !linkBtn("L1") && lastToast().m === "Order L1 linked to Pat <Example>." && listReads() === 0);
  unlinkBtn("U4").click();
  await wait(() => linkBtn("U4"));
  ok("Unlink from a card: off the record in the database, and the card redrawn with plain text and Link", custOf("U4") === null && !nameLink("U4") && text(nameBox("U4")) === "Walk In" && !unlinkBtn("U4"));

  console.log("\n=== The link opens the customer's page ===");
  await drawOrders();
  const openCustomer = async (hash) => { w.location.hash = hash; await w.adminRoute(); await wait(() => d.getElementById("custName")); };
  reset();
  await openCustomer(nameLink("L1").getAttribute("href"));
  ok("following an order's customer link draws that customer's page", of("getCustomer").length >= 1 && of("getCustomer")[0].id === patId && d.getElementById("custName").value === "Pat <Example>" &&
    d.getElementById("custEmail").value === "pat@example.com" && /L1/.test(text(d.querySelector(".cust-table"))) && /L2/.test(text(d.querySelector(".cust-table"))));

  console.log("\n=== New sale for this customer (adminNewSaleForCustomer_, askSaleShop_) ===");
  const pat = (await call({ action: "getCustomer", id: patId })).body.customer;
  const saleForm = () => d.getElementById("localSaleForm"), shopForm = () => d.getElementById("saleShopForm");
  const closeSale = async (p) => { saleForm().querySelector(".admin-pass-cancel").click(); await p; };
  await drawOrders();
  setShops([SHOPS[0]]);
  reset();
  let going = w.adminNewSaleForCustomer_(pat);
  await wait(() => saleForm());
  ok("with one shop no question is asked: the Local sale form opens for that shop", !!saleForm() && !shopForm() && of("listProducts").length === 1 && of("listProducts")[0].org === "acme");
  ok("…with the customer already picked, shown above the form with Clear", text(d.getElementById("lsCustomerPickedText")) === "Picked: Pat <Example> · pat@example.com" &&
    d.getElementById("lsCustomerPicked").style.display !== "none" && d.getElementById("lsCustomerFind").style.display === "none" && text(d.getElementById("lsCustomerClear")) === "Clear");
  ok("…and their name and email filled in under Customer info, opened so they can be seen", d.getElementById("lsName").value === "Pat <Example>" && d.getElementById("lsEmail").value === "pat@example.com" && d.getElementById("lsCustomerInfo").open === true);
  await closeSale(going);
  ok("…closing the form records nothing", !saleForm() && of("createLocalSale").length === 0);

  setShops(SHOPS);
  w._adminLastShop = "rec";
  reset();
  going = w.adminNewSaleForCustomer_(pat);
  await wait(() => shopForm());
  ok("with several shops it asks \"Which shop is the sale in?\" first, naming the customer", text(shopForm().querySelector("[data-dialog-title]")) === "Which shop is the sale in?" && /For Pat <Example>\./.test(text(shopForm())) &&
    !saleForm() && of("listProducts").length === 0 && shopForm().getAttribute("role") === "dialog");
  const shopPick = () => d.getElementById("saleShopPick");
  ok("…a labelled Shop list of every shop, starting on the shop last worked in, with Cancel and Continue", text(shopForm().querySelector('label[for="saleShopPick"]')) === "Shop" &&
    [...shopPick().options].map(o => o.value + "=" + o.textContent).join() === "acme=Example Club,rec=Rec League" && shopPick().value === "rec" && d.activeElement === shopPick() &&
    text(shopForm().querySelector(".admin-pass-cancel")) === "Cancel" && text(shopForm().querySelector(".admin-pass-submit")) === "Continue");
  shopForm().querySelector(".admin-pass-cancel").click();
  await going; await pause(40);
  ok("…Cancel there does nothing: no form, nothing asked of the server, no message, the shop last worked in unchanged", !shopForm() && !saleForm() && sent.length === 0 && toasts.length === 0 && w._adminLastShop === "rec");
  going = w.adminNewSaleForCustomer_(pat);
  await wait(() => shopForm());
  key(d, "Escape");
  await going; await pause(40);
  ok("…Escape there does nothing either", !shopForm() && !saleForm() && sent.length === 0);
  going = w.adminNewSaleForCustomer_(pat);
  await wait(() => shopForm());
  shopPick().value = "acme";
  shopForm().querySelector(".admin-pass-submit").click();
  await wait(() => saleForm());
  ok("…Continue opens the Local sale form for the shop chosen, with the customer picked, and remembers that shop", !shopForm() && of("listProducts").length === 1 && of("listProducts")[0].org === "acme" &&
    text(d.getElementById("lsCustomerPickedText")) === "Picked: Pat <Example> · pat@example.com" && w._adminLastShop === "acme" &&
    [...d.getElementById("lsProduct").options].some(o => o.value === "cap"));
  await closeSale(going);
  going = w.adminNewSaleForCustomer_({ id: clubId, name: "", company: "Example Boosters", email: "", phone: "" });
  await wait(() => shopForm());
  ok("…a customer with only a company is named by it in the question", /For Example Boosters\./.test(text(shopForm())));
  shopForm().querySelector(".admin-pass-cancel").click(); await going;
  going = w.adminNewSaleForCustomer_({ id: clubId });
  await wait(() => shopForm());
  ok("…and one with neither is \"this customer\"", /For this customer\./.test(text(shopForm())));
  shopForm().querySelector(".admin-pass-cancel").click(); await going;

  reset();
  await w.adminNewSaleForCustomer_(null); await w.adminNewSaleForCustomer_({ name: "Nobody" }); await w.adminNewSaleForCustomer_({ id: 0, name: "Nobody" });
  await pause(30);
  ok("no customer, or one without a record's id: nothing happens", !shopForm() && !saleForm() && sent.length === 0 && toasts.length === 0);
  setShops([]);
  await w.adminNewSaleForCustomer_(pat);
  ok("no shop yet: \"Add a shop first — a sale is recorded in a shop.\"", lastToast().m === "Add a shop first — a sale is recorded in a shop." && lastToast().err && !saleForm() && sent.length === 0);
  setShops(SHOPS);
  signIn("production");
  reset();
  await w.adminNewSaleForCustomer_(pat);
  ok("a role that can't change orders: \"Your role can't record a sale.\", and no question or form", lastToast().m === "Your role can't record a sale." && lastToast().err && !shopForm() && !saleForm() && sent.length === 0);
  signIn("admin");

  console.log("\n=== After the sale the customer's page is drawn again ===");
  await openCustomer("#customers/" + patId);
  const ordersBefore = d1.q("SELECT orderId FROM orders WHERE customerId = ?", patId).map(r => r.orderId);
  const tableIds = () => [...d.querySelectorAll(".cust-table tbody tr td:first-child")].map(td => text(td));
  ok("the customer's page lists their orders, and has \"New sale for this customer\"", tableIds().slice().sort().join() === ordersBefore.slice().sort().join() && ordersBefore.length === 2 && text(d.getElementById("custNewSale")) === "New sale for this customer");
  reset();
  d.getElementById("custNewSale").click();
  await wait(() => shopForm());
  shopPick().value = "rec";
  shopForm().querySelector(".admin-pass-submit").click();
  await wait(() => saleForm());
  ok("the page's button asks for the shop, then opens the form with this customer picked", of("listProducts")[0].org === "rec" && text(d.getElementById("lsCustomerPickedText")) === "Picked: Pat <Example> · pat@example.com");
  const prod = d.getElementById("lsProduct");
  prod.value = "cap"; prod.dispatchEvent(new w.Event("change", { bubbles: true }));
  d.getElementById("lsPayment").value = "Cash";
  saleForm().querySelector(".admin-pass-submit").click();
  await wait(() => of("createLocalSale").length === 1 && of("getCustomer").length >= 1 && tableIds().length === 3);
  const sale = of("createLocalSale")[0] || {};
  const made = d1.q("SELECT orderId, orgId, customerId, customerName, contact FROM orders WHERE customerId = ? AND orderId NOT IN ('L1','L2')", patId);
  ok("recording the sale sends the customer's id with it, for the shop chosen", sale.customerId === patId && sale.org === "rec" && sale.customerName === "Pat <Example>" && sale.contact === "pat@example.com");
  ok("…the new order is on the customer's record in the database", made.length === 1 && made[0].orgId === "rec" && made[0].customerId === patId);
  ok("…a message says the sale was recorded, with its order number", made.length === 1 && lastToast().m === "Local sale recorded — " + made[0].orderId && !lastToast().err);
  ok("…the customer's page is asked for again and now shows the new order, in its shop", made.length === 1 && of("getCustomer").length === 1 && of("getCustomer")[0].id === patId && tableIds().includes(made[0].orderId) &&
    tableIds().length === 3 && /Rec League/.test(text([...d.querySelectorAll(".cust-table tbody tr")].find(tr => text(tr.children[0]) === made[0].orderId))) && /^#\/?customers\/\d+$/.test(w.location.hash));
  ok("…and its count of orders went from 2 to 3", /^3\s*Orders$/.test(text(d.querySelector(".cust-total"))));
  ok("…the Orders list isn't asked for (the page drawn is the customer's)", listReads() === 0 && !d.getElementById("adminPanel"));

  // Somewhere else by the time the sale is recorded: the customer's page is not drawn over that page.
  await drawOrders();
  setShops([SHOPS[0]]);
  reset();
  going = w.adminNewSaleForCustomer_(pat);
  await wait(() => saleForm());
  d.getElementById("lsProduct").value = "cap"; d.getElementById("lsProduct").dispatchEvent(new w.Event("change", { bubbles: true }));
  d.getElementById("lsPayment").value = "Cash";
  saleForm().querySelector(".admin-pass-submit").click();
  await going; await pause(80);
  ok("a sale recorded while another page is showing is still put on the customer's record, and that page stays", of("createLocalSale").length === 1 && of("createLocalSale")[0].customerId === patId &&
    d1.q("SELECT COUNT(*) n FROM orders WHERE customerId = ?", patId)[0].n === 4 && of("getCustomer").length === 0 && !d.getElementById("custPage") && !!d.getElementById("adminPanel") && /^Local sale recorded — /.test(lastToast().m));

  const c = counts();
  console.log(`\n${c.failed ? "FAIL" : "PASS"} — ${c.passed} passed, ${c.failed} failed`);
  process.exit(c.failed ? 1 : 0);
})().catch((e) => { console.error(e); console.log("test309 crashed: false"); process.exit(1); });
