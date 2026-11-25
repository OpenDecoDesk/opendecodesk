// The Customers page (public/admin-customers.js, migrations/0108) in a real browser, as the owner: the menu button,
// the list (search, Show archived, paging, the notes it shows instead of a list), + New customer and what it refuses,
// one customer's page (every field edited and saved, what the form refuses, the tags, totals and orders, Archive and
// Restore), the addresses that open it (#customers/<id> after a reload, #/customers/<id>, an unknown id, an id that
// isn't a number, a customer merged away), the phone layout, and keyboard use (the dialog, the menu, the list's links).
// The last test checks what a Back office, a Production and a Read only user are offered and what the server refuses.
//
// The customer list is install-wide and other files add to it while this one runs, so every test makes its own
// customers with a token no one else has and reads the list through a search for that token. Nothing here depends on
// today's date: dates on screen are only checked to be dates, and the exemption dates are far in the past or future.
// Three branches can't be reached on a shared install (a list with no customer at all, a list the server couldn't
// send, an answer that arrives after a newer one): for those alone the listCustomers answer is replaced in the browser.
import crypto from "node:crypto";
import { test, expect, openAdmin, uniq, slug, waitIdle, toast, ADMIN, apiContext, callApi } from "../fixtures.mjs";
import { makeShop } from "../lib/data.mjs";

// ---- helpers ---------------------------------------------------------------------------------------------
// A token no other customer carries: letters and digits only, so a search for it matches these customers alone.
const token = (p = "zq") => slug(p);
// A customer through the owner's API (the request "+ New customer" and Save send). Returns its id.
const makeCustomer = async (api, f) => (await api("saveCustomer", { name: "", company: "", email: "", phone: "", address: null, notes: "",
  taxExempt: false, taxExemptCertificate: "", taxExemptExpires: "", ...f })).id;
const getCustomer = async (api, id) => (await api("getCustomer", { id })).customer;
const tryApi = (ctx, action, body) => callApi(ctx, action, body, { allowError: true, withStatus: true });

const searchBox = (page) => page.getByRole("searchbox", { name: "Search" });
const rows = (page) => page.locator("#custBody tr[data-cust-id]");
const row = (page, id) => page.locator(`#custBody tr[data-cust-id="${id}"]`);
const count = (page) => page.locator("#custCount");
const pager = (page) => page.locator("#custPager");
// Types a search and waits for the answer to that search to be drawn.
async function search(page, q) {
  const answered = page.waitForResponse((r) => r.url().endsWith("/api/orders") && isAction(r.request(), "listCustomers", (b) => b.q === q.trim()));
  await searchBox(page).fill(q);
  await answered;
}
function bodyOf(req) { try { return JSON.parse(req.postData() || "null") || {}; } catch (e) { return {}; } }
function isAction(req, action, also) { if (req.method() !== "POST") return false; const b = bodyOf(req); return b.action === action && (!also || also(b)); }
// The page's requests of one action, as sent.
function recordActions(page, action) {
  const sent = [];
  page.on("request", (req) => { if (/\/api\/orders(\?|$)/.test(req.url()) && isAction(req, action)) sent.push(bodyOf(req)); });
  return sent;
}
function collectErrors(page) {
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  page.on("pageerror", (e) => errors.push("uncaught: " + e.message));
  return errors;
}
// Tabs forward until `target` has the focus; fails if it isn't reached within `max` presses.
async function tabTo(page, target, max = 40) {
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return i;
    await page.keyboard.press("Tab");
  }
  await expect(target, "reached with Tab").toBeFocused({ timeout: 1 });
}
// One customer's page, as a fresh load, drawn.
async function openCustomer(page, id) {
  await openAdmin(page, "customers/" + id);
  await expect(page.locator("#custForm")).toBeVisible();
}
// Notes is a textarea inside its label, so once it holds text its accessible name is "Notes" plus that text: it is
// found by the label's own word instead.
const field = (page, label) => label === "Notes"
  ? page.locator("#custForm label.cust-field").filter({ has: page.locator("span", { hasText: /^Notes$/ }) }).locator("textarea")
  : page.locator("#custForm").getByLabel(label, { exact: true });
// The page's heading and breadcrumb are in the DOM but hidden on admin screens (admin.css .admin-hero: the highlighted
// menu says the same), so they are read from the DOM rather than as a screen reader would meet them.
const pageHeading = (page) => page.locator(".admin-hero h1");
const crumbs = (page) => page.locator(".admin-hero nav.breadcrumbs");
const save = (page) => page.locator("#custForm").getByRole("button", { name: "Save" });
// Presses Save and waits for the page to be drawn again from the saved customer.
async function saveAndRedraw(page) {
  await page.locator("#custPage").evaluate((el) => { el.dataset.e2eOld = "1"; });
  await save(page).click();
  await expect(toast(page)).toContainText("Customer saved.");
  await expect(page.locator("#custPage:not([data-e2e-old])")).toBeVisible();
  await expect(page.locator("#custForm")).toBeVisible();
}
const total = (page, label) => page.locator(".cust-total").filter({ has: page.locator("span", { hasText: new RegExp("^" + label + "$") }) });
const A_DATE = /\d{1,2}\/\d{1,2}\/\d{4}/;   // the browser's own date style (the suite's Chromium is en-US)

// ---- the menu and the list ---------------------------------------------------------------------------------
test("Customers is in the menu right after Orders and opens the list: search, Show archived, + New customer, the columns", async ({ page, api }) => {
  const t = token();
  await makeCustomer(api, { name: "Pat " + t });
  await openAdmin(page, "home");
  const nav = page.getByRole("navigation", { name: "Admin" });
  const labels = await nav.locator(".admin-nav-row > button.admin-nav-btn").allTextContents();
  expect(labels.indexOf("Customers"), "Customers is one of the top buttons").toBeGreaterThan(-1);
  expect(labels.indexOf("Customers"), "right after Orders").toBe(labels.indexOf("Orders") + 1);

  await nav.locator(".admin-nav-row").getByRole("button", { name: "Customers", exact: true }).click();
  await expect(page).toHaveURL(/#customers$/);
  await expect(page).toHaveTitle(/ — Customers \(Admin\)$/);
  await expect(pageHeading(page)).toHaveText("Customers");
  await expect(crumbs(page)).toHaveCount(0);
  await expect(nav.locator(".admin-nav-row").getByRole("button", { name: "Customers", exact: true })).toHaveClass(/active/);

  await expect(searchBox(page)).toBeVisible();
  await expect(searchBox(page)).toHaveValue("");
  await expect(searchBox(page)).toHaveAttribute("placeholder", "Name, company, email or phone");
  await expect(page.getByRole("checkbox", { name: "Show archived" })).not.toBeChecked();
  await expect(page.getByRole("button", { name: "+ New customer" })).toBeVisible();
  await expect(page.locator("#custBody thead th")).toHaveText(["Name", "Company", "Email", "Phone", "Orders", "Last order"]);
  // The list is drawn (this install has at least the customer made above), and says how many.
  await expect(rows(page).first()).toBeVisible();
  await expect(count(page)).toHaveText(/^(\d+ customers?|Showing 1–\d+ of \d+ customers)$/);
  await expect(count(page)).toHaveAttribute("role", "status");
});

test("the list: a row per customer in name order, with company, email, phone, orders, last order and the Exempt tag; the search matches each of them", async ({ page, api }) => {
  const t = token();
  const shop = await makeShop(api, { prefix: "cust", products: [{ name: "Sample Tee", price: 20 }] });
  // Names chosen so the order shows the rule: by name without regard to case, a customer with only a company by it.
  const bea = await makeCustomer(api, { name: "bea " + t, company: "Example Club", email: "bea." + t + "@example.test", phone: "555-0100" });
  const coId = await makeCustomer(api, { company: "Club " + t });
  const dee = await makeCustomer(api, { name: "Dee " + t, taxExempt: true, taxExemptCertificate: "EX-1" });
  const html = await makeCustomer(api, { name: "Eve <b>" + t + "</b> & Co", phone: "555-0177" });
  const sale = await api("createLocalSale", { org: shop.orgId, requestId: crypto.randomUUID().replace(/-/g, ""), customerId: bea,
    items: [{ productId: shop.products[0].productId, qty: 1 }], paymentMethod: "Check", customerName: "bea " + t, contact: "bea." + t + "@example.test" });
  expect(sale.orderId).toBeTruthy();

  await openAdmin(page, "customers");
  await search(page, t);
  await expect(rows(page)).toHaveCount(4);
  await expect(count(page)).toHaveText("4 customers");
  await expect(pager(page)).toBeEmpty();
  expect(await rows(page).evaluateAll((trs) => trs.map((tr) => Number(tr.dataset.custId)))).toEqual([bea, coId, dee, html]);

  // Every cell of a full row. The name is a link to the customer.
  const cells = row(page, bea).locator("td");
  await expect(cells.nth(0)).toHaveText("bea " + t);
  await expect(cells.nth(0).getByRole("link", { name: "bea " + t })).toHaveAttribute("href", "#customers/" + bea);
  await expect(cells.nth(1)).toHaveText("Example Club");
  await expect(cells.nth(2)).toHaveText("bea." + t + "@example.test");
  await expect(cells.nth(3)).toHaveText("555-0100");
  await expect(cells.nth(4)).toHaveText("1");
  await expect(cells.nth(5)).toHaveText(A_DATE);
  // No orders: 0 and no date. Only a company: it is the customer's name on the list.
  await expect(row(page, coId).locator("td").nth(0)).toHaveText("Club " + t);
  await expect(row(page, coId).locator("td").nth(1)).toHaveText("Club " + t);
  await expect(row(page, coId).locator("td").nth(4)).toHaveText("0");
  await expect(row(page, coId).locator("td").nth(5)).toHaveText("");
  // The Exempt tag, on the exempt customer only.
  await expect(row(page, dee).locator(".cust-tag")).toHaveText(["Exempt"]);
  await expect(row(page, bea).locator(".cust-tag")).toHaveCount(0);
  // What was typed is shown as typed, never run as markup.
  await expect(row(page, html).locator("td").nth(0)).toHaveText("Eve <b>" + t + "</b> & Co");
  await expect(row(page, html).locator("b")).toHaveCount(0);

  // The search looks in the name, the company, the email and the phone, in any letter case, as you type.
  await search(page, "BEA " + t.toUpperCase());
  await expect(rows(page)).toHaveCount(1);
  await expect(row(page, bea)).toBeVisible();
  await expect(count(page)).toHaveText("1 customer");
  await search(page, "club " + t);
  await expect(rows(page)).toHaveCount(1);
  await expect(row(page, coId)).toBeVisible();
  await search(page, "bea." + t + "@EXAMPLE");
  await expect(rows(page)).toHaveCount(1);
  await expect(row(page, bea)).toBeVisible();
  // Spaces around what was typed are not part of the search.
  await search(page, "  Dee " + t + "  ");
  await expect(rows(page)).toHaveCount(1);
  await expect(row(page, dee)).toBeVisible();

  // Nothing matches: a note in place of the table, no count, no paging.
  await search(page, t + "nothinglikeit");
  await expect(rows(page)).toHaveCount(0);
  await expect(page.locator("#custBody")).toHaveText("No customer matches that search.");
  await expect(count(page)).toHaveText("");
  await expect(pager(page)).toBeEmpty();

  // The phone is searched too (a number of this test's own, so only its customer answers among this token's).
  await search(page, "555-0177");
  await expect(row(page, html)).toBeVisible();
});

test("the search waits for a pause in the typing: one request for a word typed letter by letter", async ({ page, api }) => {
  const t = token();
  await makeCustomer(api, { name: "Pat " + t });
  await openAdmin(page, "customers");
  const sent = recordActions(page, "listCustomers");
  await searchBox(page).pressSequentially(t, { delay: 20 });
  await expect(rows(page)).toHaveCount(1);
  await waitIdle(page, 400);
  expect(sent.map((b) => b.q)).toEqual([t]);
  expect(sent[0]).toMatchObject({ includeArchived: false, limit: 50, offset: 0 });
});

test("Show archived: an archived customer is off the list until the box is ticked, then listed greyed with an Archived tag", async ({ page, api }) => {
  const t = token();
  const live = await makeCustomer(api, { name: "Ann " + t });
  const gone = await makeCustomer(api, { name: "Bo " + t, taxExempt: true });
  await api("setCustomerArchived", { id: gone, archived: true });

  await openAdmin(page, "customers");
  await search(page, t);
  await expect(rows(page)).toHaveCount(1);
  await expect(row(page, live)).toBeVisible();
  await expect(count(page)).toHaveText("1 customer");

  await page.getByRole("checkbox", { name: "Show archived" }).check();
  await expect(rows(page)).toHaveCount(2);
  await expect(count(page)).toHaveText("2 customers");
  await expect(row(page, gone)).toHaveClass(/cust-row-archived/);
  await expect(row(page, gone).locator(".cust-tag")).toHaveText(["Exempt", "Archived"]);
  await expect(row(page, live)).not.toHaveClass(/cust-row-archived/);
  await expect(row(page, live).locator(".cust-tag")).toHaveCount(0);

  await page.getByRole("checkbox", { name: "Show archived" }).uncheck();
  await expect(rows(page)).toHaveCount(1);
  await expect(row(page, gone)).toHaveCount(0);
});

test("paging: 55 customers are shown 50 at a time with Previous and Next, and a page that has emptied goes back to the first", async ({ page, api }) => {
  test.setTimeout(120_000);
  const t = token();
  // "Zz…" sorts these after other files' customers on the unsearched list; they are archived again at the end.
  const ids = [];
  for (let i = 1; i <= 55; i++) ids.push(await makeCustomer(api, { name: "Zz " + t + " " + String(i).padStart(2, "0") }));
  try {
    await openAdmin(page, "customers");
    await search(page, t);
    const prev = pager(page).getByRole("button", { name: "‹ Previous" }), next = pager(page).getByRole("button", { name: "Next ›" });
    await expect(rows(page)).toHaveCount(50);
    await expect(count(page)).toHaveText("Showing 1–50 of 55 customers");
    await expect(prev).toBeDisabled();
    await expect(next).toBeEnabled();
    await expect(rows(page).first()).toHaveAttribute("data-cust-id", String(ids[0]));
    await expect(rows(page).last()).toHaveAttribute("data-cust-id", String(ids[49]));

    const sent = recordActions(page, "listCustomers");
    await next.click();
    await expect(rows(page)).toHaveCount(5);
    await expect(count(page)).toHaveText("Showing 51–55 of 55 customers");
    await expect(prev).toBeEnabled();
    await expect(next).toBeDisabled();
    await expect(rows(page).first()).toHaveAttribute("data-cust-id", String(ids[50]));
    await expect(rows(page).last()).toHaveAttribute("data-cust-id", String(ids[54]));
    expect(sent[sent.length - 1]).toMatchObject({ q: t, limit: 50, offset: 50 });

    await prev.click();
    await expect(rows(page)).toHaveCount(50);
    await expect(count(page)).toHaveText("Showing 1–50 of 55 customers");
    await expect(prev).toBeDisabled();
    expect(sent[sent.length - 1]).toMatchObject({ offset: 0 });

    // A new search starts from the first page again.
    await next.click();
    await expect(count(page)).toHaveText("Showing 51–55 of 55 customers");
    await search(page, t + " 5");
    await expect(count(page)).toHaveText("6 customers");          // 50 to 55
    await expect(pager(page)).toBeEmpty();
    await search(page, t);
    await expect(count(page)).toHaveText("Showing 1–50 of 55 customers");

    // The second page's customers are archived elsewhere while the first is on screen: Next finds nothing there,
    // so the list goes back to the first page, which is now the whole list (50, no paging).
    for (const id of ids.slice(50)) await api("setCustomerArchived", { id, archived: true });
    await pager(page).getByRole("button", { name: "Next ›" }).click();
    await expect(count(page)).toHaveText("50 customers");
    await expect(rows(page)).toHaveCount(50);
    await expect(pager(page)).toBeEmpty();
    // Show archived brings all 55 back, from the first page.
    await page.getByRole("checkbox", { name: "Show archived" }).check();
    await expect(count(page)).toHaveText("Showing 1–50 of 55 customers");
  } finally {
    for (const id of ids) await api("setCustomerArchived", { id, archived: true }, { allowError: true });
  }
});

test("a row opens its customer (a click anywhere on it, or its name), and ‹ Customers comes back to the same search", async ({ page, api }) => {
  const t = token();
  const a = await makeCustomer(api, { name: "Ann " + t, company: "Example Club" });
  const b = await makeCustomer(api, { name: "Bo " + t });
  await api("setCustomerArchived", { id: b, archived: true });
  await openAdmin(page, "customers");
  await search(page, t);
  await page.getByRole("checkbox", { name: "Show archived" }).check();
  await expect(rows(page)).toHaveCount(2);

  // A click on a cell that isn't the name.
  await row(page, a).locator("td").nth(1).click();
  await expect(page).toHaveURL(new RegExp("#customers/" + a + "$"));
  await expect(page.locator(".cust-name")).toHaveText("Ann " + t);
  await expect(page).toHaveTitle(new RegExp(" — Ann " + t + " \\(Admin\\)$"));
  await expect(pageHeading(page)).toHaveText("Ann " + t);
  await expect(crumbs(page)).toHaveText("Customers › Ann " + t);
  await expect(crumbs(page).locator("a.bc-link")).toHaveAttribute("href", "#customers");

  // Back: the search, the tick and the rows are as they were left.
  await page.locator("#custPage").getByRole("link", { name: "‹ Customers" }).click();
  await expect(page).toHaveURL(/#customers$/);
  await expect(searchBox(page)).toHaveValue(t);
  await expect(page.getByRole("checkbox", { name: "Show archived" })).toBeChecked();
  await expect(rows(page)).toHaveCount(2);

  // The name itself is a link.
  await row(page, b).getByRole("link", { name: "Bo " + t }).click();
  await expect(page).toHaveURL(new RegExp("#customers/" + b + "$"));
  await expect(page.locator(".cust-name")).toHaveText("Bo " + t);
  // The browser's Back goes to the list as well.
  await page.goBack();
  await expect(page).toHaveURL(/#customers$/);
  await expect(rows(page)).toHaveCount(2);
});

// The listCustomers answer replaced in the browser, for what a shared install can't be put into (see the top).
test("the list's other answers: no customers at all, a list the server couldn't send, and a slow answer that arrives after a newer one", async ({ page, api }) => {
  const t = token();
  const first = await makeCustomer(api, { name: "Ann " + t + "first" });
  const second = await makeCustomer(api, { name: "Bo " + t + "second" });
  let mode = "empty", releaseSlow = null;
  const slowSeen = new Promise((res) => { releaseSlow = res; });
  let letSlowGo = null;
  const slowHeld = new Promise((res) => { letSlowGo = res; });
  await page.route("**/api/orders", async (route) => {
    const req = route.request();
    if (!isAction(req, "listCustomers")) return route.fallback();
    const q = bodyOf(req).q;
    if (mode === "empty") return route.fulfill({ json: { status: "ok", customers: [], total: 0 } });
    if (mode === "error") return route.fulfill({ status: 500, json: { status: "error", message: "The list <i>couldn't</i> be read." } });
    if (mode === "race" && q === t + "first") { releaseSlow(); await slowHeld; }
    return route.fallback();
  });

  await openAdmin(page, "customers");
  await expect(page.locator("#custBody")).toHaveText("No customers yet. A customer is added when an order comes in with an email address, or with “+ New customer”.");
  await expect(count(page)).toHaveText("");
  await expect(pager(page)).toBeEmpty();

  // The server's own sentence, as an alert, shown as text.
  mode = "error";
  await page.getByRole("checkbox", { name: "Show archived" }).check();
  const alert = page.locator("#custBody").getByRole("alert");
  await expect(alert).toHaveText("The list <i>couldn't</i> be read.");
  await expect(alert.locator("i")).toHaveCount(0);
  await expect(count(page)).toHaveText("");
  await page.getByRole("checkbox", { name: "Show archived" }).uncheck();

  // "…first" is asked and held back; "…second" is asked and answered; then the first answer arrives. The list keeps
  // the answer to what is in the box.
  mode = "race";
  await searchBox(page).fill(t + "first");
  await slowSeen;
  await search(page, t + "second");
  await expect(row(page, second)).toBeVisible();
  const lateAnswer = page.waitForResponse((r) => isAction(r.request(), "listCustomers", (b) => b.q === t + "first"));
  letSlowGo();
  await lateAnswer;
  await waitIdle(page, 300);
  await expect(rows(page)).toHaveCount(1);
  await expect(row(page, second)).toBeVisible();
  await expect(row(page, first)).toHaveCount(0);
});

// ---- + New customer ------------------------------------------------------------------------------------------
test("+ New customer: needs a name or a company, a real email and an email no other customer has; then opens the new customer", async ({ page, api }) => {
  const t = token();
  const takenEmail = "taken." + t + "@example.test";
  await makeCustomer(api, { name: "Taken " + t, email: takenEmail });
  await openAdmin(page, "customers");
  const sent = recordActions(page, "saveCustomer");
  await page.getByRole("button", { name: "+ New customer" }).click();
  const dlg = page.getByRole("dialog", { name: "New customer" });
  await expect(dlg).toBeVisible();
  const err = dlg.getByRole("alert");
  const create = dlg.getByRole("button", { name: "Create customer" });
  await expect(dlg.getByLabel("Email")).toHaveAttribute("placeholder", "pat@example.com");

  // Nothing typed, then only spaces, then only an email and a phone: no name or company.
  await create.click();
  await expect(err).toHaveText("Enter a name or a company.");
  await expect(dlg.getByLabel("Name")).toBeFocused();
  await dlg.getByLabel("Name").fill("   ");
  await dlg.getByLabel("Email").fill("pat." + t + "@example.test");
  await dlg.getByLabel("Phone").fill("555-0101");
  await create.click();
  await expect(err).toHaveText("Enter a name or a company.");
  await expect(dlg.getByLabel("Name")).toBeFocused();

  // An email that isn't one.
  await dlg.getByLabel("Name").fill("Pat " + t);
  for (const bad of ["pat-at-example", "pat@example", "pat @example.test"]) {
    await dlg.getByLabel("Email").fill(bad);
    await create.click();
    await expect(err, bad).toHaveText("That email address doesn't look right.");
    await expect(dlg.getByLabel("Email")).toBeFocused();
  }
  expect(sent, "nothing was sent while the form was refused").toEqual([]);

  // Another customer's email (typed in capitals: it is the same address): the server's sentence, and the form stays
  // open with what was typed and its button usable again.
  await dlg.getByLabel("Email").fill(takenEmail.toUpperCase());
  await create.click();
  await expect(err).toHaveText("Another customer already has that email.");
  await expect(create).toBeEnabled();
  await expect(dlg.getByLabel("Name")).toHaveValue("Pat " + t);
  expect(sent).toHaveLength(1);

  // Put right: the customer is created with what was typed (trimmed, the email in lower case) and its page opens.
  await dlg.getByLabel("Name").fill("  Pat " + t + "  ");
  await dlg.getByLabel("Company").fill(" Example Club ");
  await dlg.getByLabel("Email").fill("Pat." + t + "@Example.test");
  await create.click();
  await expect(toast(page)).toContainText("Customer created.");
  await expect(dlg).toHaveCount(0);
  await expect(page).toHaveURL(/#customers\/\d+$/);
  const id = Number(/#customers\/(\d+)$/.exec(page.url())[1]);
  await expect(page.locator(".cust-name")).toHaveText("Pat " + t);
  expect(sent[1]).toMatchObject({ name: "Pat " + t, company: "Example Club", email: "Pat." + t + "@Example.test", phone: "555-0101",
    address: null, notes: "", taxExempt: false, taxExemptCertificate: "", taxExemptExpires: "" });
  expect(sent[1].id).toBeUndefined();
  expect(await getCustomer(api, id)).toMatchObject({ id, name: "Pat " + t, company: "Example Club", email: "pat." + t + "@example.test", phone: "555-0101",
    address: null, notes: "", taxExempt: false, taxExemptCertificate: "", archived: false });
  await expect(field(page, "Email")).toHaveValue("pat." + t + "@example.test");

  // A company alone is enough, with no email; Enter in a field creates it.
  await openAdmin(page, "customers");
  await page.getByRole("button", { name: "+ New customer" }).click();
  await dlg.getByLabel("Company").fill("Club " + t);
  await dlg.getByLabel("Company").press("Enter");
  await expect(toast(page)).toContainText("Customer created.");
  await expect(page).toHaveURL(/#customers\/\d+$/);
  await expect(page.locator(".cust-name")).toHaveText("Club " + t);
  const coId = Number(/#customers\/(\d+)$/.exec(page.url())[1]);
  expect(coId).not.toBe(id);
  expect(await getCustomer(api, coId)).toMatchObject({ name: "", company: "Club " + t, email: "", phone: "" });
});

test("+ New customer from the keyboard: focus starts on Name, Tab goes field to field and stays inside, Escape closes it and focus goes back; typing is not thrown away without asking, by Escape or Cancel", async ({ page, api }) => {
  const t = token();
  await openAdmin(page, "customers");
  const sent = recordActions(page, "saveCustomer");
  const newBtn = page.getByRole("button", { name: "+ New customer" });
  await newBtn.focus();
  await page.keyboard.press("Enter");
  const dlg = page.getByRole("dialog", { name: "New customer" });
  await expect(dlg).toBeVisible();
  await expect(dlg).toHaveAttribute("aria-modal", "true");
  await expect(dlg.getByLabel("Name")).toBeFocused();

  // Tab order: the fields as they read, then Cancel, Create customer, and round to the window's ✕.
  for (const next of [dlg.getByLabel("Company"), dlg.getByLabel("Email"), dlg.getByLabel("Phone"), dlg.getByRole("button", { name: "Cancel" }),
    dlg.getByRole("button", { name: "Create customer" }), dlg.getByRole("button", { name: "Close" }), dlg.getByLabel("Name")]) {
    await page.keyboard.press("Tab");
    await expect(next).toBeFocused();
  }
  // And backwards from the first control to the last.
  await dlg.getByRole("button", { name: "Close" }).focus();
  await page.keyboard.press("Shift+Tab");
  await expect(dlg.getByRole("button", { name: "Create customer" })).toBeFocused();

  // Nothing typed: Escape closes it at once and focus is back on the button that opened it.
  await page.keyboard.press("Escape");
  await expect(dlg).toHaveCount(0);
  await expect(newBtn).toBeFocused();

  // Something typed: Escape asks first. Keep editing keeps the window and the typing.
  await page.keyboard.press("Enter");
  await expect(dlg.getByLabel("Name")).toBeFocused();
  await page.keyboard.type("Kit " + t);
  await page.keyboard.press("Escape");
  const ask = page.getByRole("dialog").filter({ hasText: "Discard changes?" });
  await expect(ask).toContainText("What you typed in this window hasn't been saved.");
  await ask.getByRole("button", { name: "Keep editing" }).click();
  await expect(ask).toHaveCount(0);
  await expect(dlg.getByLabel("Name")).toHaveValue("Kit " + t);
  // Discard closes it; nothing was created.
  await page.keyboard.press("Escape");
  await ask.getByRole("button", { name: "Discard" }).click();
  await expect(dlg).toHaveCount(0);

  // Cancel asks too once something is typed, and Discard closes it without saving; ✕ closes an untouched one.
  await newBtn.click();
  await dlg.getByLabel("Name").fill("Kit " + t);
  await dlg.getByRole("button", { name: "Cancel" }).click();
  await ask.getByRole("button", { name: "Keep editing" }).click();
  await expect(dlg.getByLabel("Name")).toHaveValue("Kit " + t);
  await dlg.getByRole("button", { name: "Cancel" }).click();
  await ask.getByRole("button", { name: "Discard" }).click();
  await expect(dlg).toHaveCount(0);
  await newBtn.click();
  await expect(dlg.getByLabel("Name")).toHaveValue("");     // a new window each time, not the last one's typing
  await dlg.getByRole("button", { name: "Close" }).click();
  await expect(dlg).toHaveCount(0);
  expect(sent).toEqual([]);
  expect((await api("listCustomers", { q: t, includeArchived: true })).total).toBe(0);
});

// ---- one customer ----------------------------------------------------------------------------------------------
test("a customer's page: name, company and since when, the totals, and their orders, each opening on its shop's Orders page", async ({ page, api }) => {
  const t = token();
  const shop = await makeShop(api, { prefix: "cust", products: [{ name: "Sample Tee", price: 20 }] });
  const email = "ann." + t + "@example.test";
  const id = await makeCustomer(api, { name: "Ann " + t, company: "Club " + t, email, phone: "555-0102" });
  const sale = async (qty, paid) => (await api("createLocalSale", { org: shop.orgId, requestId: crypto.randomUUID().replace(/-/g, ""), customerId: id,
    items: [{ productId: shop.products[0].productId, qty }], paymentMethod: "Cash", paid, customerName: "Ann " + t, contact: email })).orderId;
  const owed = await sale(1, false);      // $20, nothing received
  const paid = await sale(2, true);       // $40, paid

  await openCustomer(page, id);
  await expect(page).toHaveTitle(new RegExp(" — Ann " + t + " \\(Admin\\)$"));
  await expect(page.getByRole("heading", { level: 2, name: "Ann " + t })).toBeVisible();
  await expect(page.locator(".cust-sub")).toHaveText(new RegExp("^\\s*Club " + t + " · Customer since " + A_DATE.source + "\\s*$"));
  await expect(page.locator(".cust-sub .cust-tag")).toHaveCount(0);
  await expect(page.locator("#custPage").getByRole("button", { name: "New sale for this customer" })).toBeVisible();
  await expect(page.locator("#custPage").getByRole("button", { name: "Archive" })).toBeVisible();
  await expect(page.locator("#custPage").getByRole("button", { name: "Merge into another customer…" })).toBeVisible();

  // Totals: two orders, $60 in all, $20 still owed (marked as owed).
  await expect(page.locator(".cust-total")).toHaveCount(3);
  await expect(total(page, "Orders").locator("b")).toHaveText("2");
  await expect(total(page, "Spent").locator("b")).toHaveText("$60.00");
  await expect(total(page, "Balance due").locator("b")).toHaveText("$20.00");
  await expect(total(page, "Balance due")).toHaveClass(/cust-total-due/);

  // The orders, newest first.
  const table = page.locator("#custPage table.cust-table");
  await expect(table.locator("thead th")).toHaveText(["Order", "Shop", "Placed", "Total", "Paid", "Balance", "Status"]);
  const orderRow = (orderId) => table.locator("tbody tr").filter({ has: page.getByRole("link", { name: orderId, exact: true }) });
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await expect(orderRow(owed).locator("td")).toHaveText([owed, shop.name, A_DATE, "$20.00", "$0.00", "$20.00", ""]);
  await expect(orderRow(paid).locator("td")).toHaveText([paid, shop.name, A_DATE, "$40.00", "$40.00", "$0.00", ""]);
  await expect(page.locator("#custPage")).not.toContainText("Voided and test orders are listed");
  await expect(page.locator("#custPage")).not.toContainText("No orders yet.");

  // An order's number opens that order on its shop's Orders page.
  await orderRow(owed).getByRole("link", { name: owed, exact: true }).click();
  await expect(page).toHaveURL(new RegExp("#orders/" + shop.orgId + "$"));
  await expect(page.getByRole("combobox", { name: "Shop" })).toHaveValue(shop.orgId);
  await expect(page.locator(`tr[data-order="${owed}"]`).first()).toBeVisible();

  // The list counts those orders for the customer.
  await openAdmin(page, "customers");
  await search(page, t);
  await expect(row(page, id).locator("td").nth(4)).toHaveText("2");
  await expect(row(page, id).locator("td").nth(5)).toHaveText(A_DATE);
});

test("a voided order stays on the customer's list, greyed and tagged Voided, out of the totals, and its number still opens it", async ({ page, api }) => {
  const t = token();
  const shop = await makeShop(api, { prefix: "cust", products: [{ name: "Sample Tee", price: 20 }] });
  const email = "vic." + t + "@example.test";
  const id = await makeCustomer(api, { name: "Vic " + t, email });
  const sale = async () => (await api("createLocalSale", { org: shop.orgId, requestId: crypto.randomUUID().replace(/-/g, ""), customerId: id,
    items: [{ productId: shop.products[0].productId, qty: 1 }], paymentMethod: "Check", customerName: "Vic " + t, contact: email })).orderId;
  const kept = await sale();
  const voided = await sale();
  await api("voidOrder", { orderId: voided, reason: "Example void" });

  await openCustomer(page, id);
  await expect(total(page, "Orders").locator("b")).toHaveText("1");
  await expect(total(page, "Spent").locator("b")).toHaveText("$20.00");
  const table = page.locator("#custPage table.cust-table");
  await expect(table.locator("tbody tr")).toHaveCount(2);
  const vRow = table.locator("tbody tr").filter({ has: page.getByRole("link", { name: voided, exact: true }) });
  const kRow = table.locator("tbody tr").filter({ has: page.getByRole("link", { name: kept, exact: true }) });
  await expect(vRow).toHaveClass(/cust-row-archived/);
  await expect(vRow.locator(".cust-tag")).toHaveText(["Voided"]);
  await expect(kRow).not.toHaveClass(/cust-row-archived/);
  await expect(kRow.locator(".cust-tag")).toHaveCount(0);
  await expect(page.locator("#custPage")).toContainText("Voided and test orders are listed but not counted in the totals.");

  // The list's count leaves the voided order out too.
  await openAdmin(page, "customers");
  await search(page, t);
  await expect(row(page, id).locator("td").nth(4)).toHaveText("1");

  // A voided order is hidden on the Orders page until "Include cancelled" is ticked: its number opens it anyway.
  await openCustomer(page, id);
  await vRow.getByRole("link", { name: voided, exact: true }).click();
  await expect(page).toHaveURL(new RegExp("#orders/" + shop.orgId + "$"));
  await expect(page.locator(`tr[data-order="${voided}"]`).first()).toBeVisible();
});

test("a customer with only a company and no orders: named by the company, nothing owed, “No orders yet.”", async ({ page, api }) => {
  const t = token();
  const id = await makeCustomer(api, { company: "Club " + t });
  await openCustomer(page, id);
  await expect(page.locator(".cust-name")).toHaveText("Club " + t);
  await expect(page).toHaveTitle(new RegExp(" — Club " + t + " \\(Admin\\)$"));
  // The company is the heading, so the line under it doesn't repeat it.
  await expect(page.locator(".cust-sub")).toHaveText(new RegExp("^\\s*Customer since " + A_DATE.source + "\\s*$"));
  await expect(total(page, "Orders").locator("b")).toHaveText("0");
  await expect(total(page, "Spent").locator("b")).toHaveText("$0.00");
  await expect(total(page, "Balance due").locator("b")).toHaveText("$0.00");
  await expect(total(page, "Balance due")).not.toHaveClass(/cust-total-due/);
  await expect(page.locator("#custPage table")).toHaveCount(0);
  await expect(page.locator("#custPage")).toContainText("No orders yet.");
  // The form holds what the customer has: blanks, and the exemption off.
  for (const l of ["Name", "Email", "Phone", "Address", "Address line 2", "City", "State", "ZIP", "Notes", "Certificate number", "Expires (blank = never)"]) await expect(field(page, l), l).toHaveValue("");
  await expect(field(page, "Company")).toHaveValue("Club " + t);
  await expect(page.locator("#custForm").getByRole("checkbox", { name: /^Tax exempt/ })).not.toBeChecked();
  await expect(page.locator("#custForm").getByRole("group", { name: "Tax exemption" })).toContainText("Applies to orders placed from now on, until the day it expires. Orders already placed keep the tax they were charged.");
});

test("every field of a customer is edited and saved: details, address, notes and the tax exemption, and they read back after a reload", async ({ page, api }) => {
  const t = token();
  const id = await makeCustomer(api, { name: "Old " + t });
  await openCustomer(page, id);
  const sent = recordActions(page, "saveCustomer");
  const typed = { "Name": "  Pat " + t + " ", "Company": "Example Club " + t, "Email": "Pat." + t + "@Example.test", "Phone": "555-0103",
    "Address": "1 Example Street", "Address line 2": "Suite 2", "City": "Sampleville", "State": "ZZ", "ZIP": "00000",
    "Notes": "Prefers pickup.\nSecond line <b>plain</b>.", "Certificate number": "EX-" + t };
  for (const [label, value] of Object.entries(typed)) await field(page, label).fill(value);
  await page.locator("#custForm").getByRole("checkbox", { name: /^Tax exempt/ }).check();
  await field(page, "Expires (blank = never)").fill("2099-12-31");
  await saveAndRedraw(page);

  expect(sent).toHaveLength(1);
  expect(sent[0]).toEqual({ action: "saveCustomer", id, name: "Pat " + t, company: "Example Club " + t, email: "Pat." + t + "@Example.test", phone: "555-0103",
    address: { line1: "1 Example Street", line2: "Suite 2", city: "Sampleville", state: "ZZ", zip: "00000" },
    notes: "Prefers pickup.\nSecond line <b>plain</b>.", taxExempt: true, taxExemptCertificate: "EX-" + t, taxExemptExpires: "2099-12-31", ...(sent[0].key !== undefined ? { key: sent[0].key } : {}) });

  const saved = { name: "Pat " + t, company: "Example Club " + t, email: "pat." + t + "@example.test", phone: "555-0103",
    notes: "Prefers pickup.\nSecond line <b>plain</b>.", taxExempt: true, taxExemptCertificate: "EX-" + t, taxExemptExpires: "2099-12-31" };
  const stored = await getCustomer(api, id);
  expect(stored).toMatchObject(saved);
  expect(stored.address).toMatchObject({ line1: "1 Example Street", line2: "Suite 2", city: "Sampleville", state: "ZZ", zip: "00000" });

  // The page drawn after the save, and again after a reload of its own address: everything as saved.
  const shows = async () => {
    await expect(page.locator(".cust-name")).toHaveText("Pat " + t);
    await expect(page.locator(".cust-sub")).toContainText("Example Club " + t + " · Customer since");
    await expect(page.locator(".cust-sub .cust-tag")).toHaveText(["Tax exempt"]);
    await expect(page.locator(".cust-sub .cust-tag")).toHaveClass(/cust-tag-exempt/);
    await expect(field(page, "Name")).toHaveValue("Pat " + t);
    await expect(field(page, "Company")).toHaveValue("Example Club " + t);
    await expect(field(page, "Email")).toHaveValue("pat." + t + "@example.test");
    await expect(field(page, "Phone")).toHaveValue("555-0103");
    await expect(field(page, "Address")).toHaveValue("1 Example Street");
    await expect(field(page, "Address line 2")).toHaveValue("Suite 2");
    await expect(field(page, "City")).toHaveValue("Sampleville");
    await expect(field(page, "State")).toHaveValue("ZZ");
    await expect(field(page, "ZIP")).toHaveValue("00000");
    await expect(field(page, "Notes")).toHaveValue("Prefers pickup.\nSecond line <b>plain</b>.");
    await expect(page.locator("#custForm").getByRole("checkbox", { name: /^Tax exempt/ })).toBeChecked();
    await expect(field(page, "Certificate number")).toHaveValue("EX-" + t);
    await expect(field(page, "Expires (blank = never)")).toHaveValue("2099-12-31");
    await expect(page.locator("#custErr")).toHaveText("");
    await expect(save(page)).toBeEnabled();
  };
  await shows();
  await page.reload();
  await expect(page.locator("#custForm")).toBeVisible();
  await expect(page).toHaveURL(new RegExp("#customers/" + id + "$"));
  await shows();

  // The list shows the new details and the Exempt tag.
  await openAdmin(page, "customers");
  await search(page, t);
  await expect(row(page, id).locator("td")).toHaveText([/^Pat \S+\s+Exempt$/, "Example Club " + t, "pat." + t + "@example.test", "555-0103", "0", ""]);

  // Taken off again: every field emptied but the name, the exemption unticked. The address is then no address.
  await openCustomer(page, id);
  for (const label of Object.keys(typed).filter((l) => l !== "Name")) await field(page, label).fill("");
  await field(page, "Expires (blank = never)").fill("");
  await page.locator("#custForm").getByRole("checkbox", { name: /^Tax exempt/ }).uncheck();
  await saveAndRedraw(page);
  expect(sent[1]).toMatchObject({ id, name: "Pat " + t, company: "", email: "", phone: "", address: null, notes: "", taxExempt: false, taxExemptCertificate: "", taxExemptExpires: "" });
  const cleared = await getCustomer(api, id);
  expect(cleared).toMatchObject({ name: "Pat " + t, company: "", email: "", phone: "", address: null, notes: "", taxExempt: false, taxExemptCertificate: "" });
  expect(cleared.taxExemptExpires || "").toBe("");
  await expect(page.locator(".cust-sub .cust-tag")).toHaveCount(0);
  await expect(page.locator(".cust-sub")).not.toContainText("·");
  await expect(field(page, "Address")).toHaveValue("");
});

test("what Save refuses: no name and no company, an email that isn't one, another customer's email; the form keeps what was typed and nothing is saved", async ({ page, api }) => {
  const t = token();
  const takenEmail = "taken." + t + "@example.test";
  await makeCustomer(api, { name: "Taken " + t, email: takenEmail });
  const id = await makeCustomer(api, { name: "Pat " + t, company: "Example Club", email: "pat." + t + "@example.test" });
  const before = await getCustomer(api, id);
  await openCustomer(page, id);
  const sent = recordActions(page, "saveCustomer");
  const err = page.locator("#custErr");
  await expect(err).toHaveAttribute("role", "alert");

  await field(page, "Name").fill("  ");
  await field(page, "Company").fill("");
  await save(page).click();
  await expect(err).toHaveText("Enter a name or a company.");
  await expect(field(page, "Name")).toBeFocused();

  await field(page, "Name").fill("Pat " + t);
  await field(page, "Email").fill("pat-at-example");
  await save(page).click();
  await expect(err).toHaveText("That email address doesn't look right.");
  await expect(field(page, "Email")).toBeFocused();
  expect(sent, "nothing was sent while the form was refused").toEqual([]);

  await field(page, "Email").fill(takenEmail);
  await field(page, "Notes").fill("Typed before the refusal.");
  await save(page).click();
  await expect(err).toHaveText("Another customer already has that email.");
  await expect(save(page)).toBeEnabled();
  await expect(field(page, "Notes")).toHaveValue("Typed before the refusal.");
  await expect(field(page, "Email")).toHaveValue(takenEmail);
  expect(sent).toHaveLength(1);
  expect(await getCustomer(api, id)).toEqual(before);

  // Its own email is not "another customer's": put back, the save goes through and the message is gone.
  await field(page, "Email").fill("pat." + t + "@example.test");
  await field(page, "Company").fill("");     // a name alone is enough
  await saveAndRedraw(page);
  await expect(page.locator("#custErr")).toHaveText("");
  expect(await getCustomer(api, id)).toMatchObject({ name: "Pat " + t, company: "", email: "pat." + t + "@example.test", notes: "Typed before the refusal." });
});

test("the parts of a stored address the form has no field for are kept when the address is edited", async ({ page, api }) => {
  const t = token();
  const id = await makeCustomer(api, { name: "Pat " + t, address: { name: "Pat Recipient", line1: "1 Example Street", line2: "", city: "Sampleville", state: "ZZ", zip: "00000", country: "US", phone: "555-0104" } });
  await openCustomer(page, id);
  await expect(field(page, "Address")).toHaveValue("1 Example Street");
  await expect(field(page, "City")).toHaveValue("Sampleville");
  await field(page, "Address").fill("2 Sample Road");
  await field(page, "Address line 2").fill("Unit 5");
  await saveAndRedraw(page);
  expect((await getCustomer(api, id)).address).toEqual({ name: "Pat Recipient", line1: "2 Sample Road", line2: "Unit 5", city: "Sampleville", state: "ZZ", zip: "00000", country: "US", phone: "555-0104" });
});

test("the exemption's tag: “Tax exempt” with no expiry or one still ahead, “Exemption expired” once the date has passed", async ({ page, api }) => {
  const t = token();
  const never = await makeCustomer(api, { name: "Never " + t, taxExempt: true, taxExemptCertificate: "EX-1" });
  const past = await makeCustomer(api, { name: "Past " + t, taxExempt: true, taxExemptCertificate: "EX-2", taxExemptExpires: "2020-01-31" });
  const notTicked = await makeCustomer(api, { name: "Plain " + t, taxExemptCertificate: "EX-3", taxExemptExpires: "2020-01-31" });

  await openCustomer(page, never);
  await expect(page.locator(".cust-sub .cust-tag")).toHaveText(["Tax exempt"]);
  await expect(field(page, "Expires (blank = never)")).toHaveValue("");

  await openCustomer(page, past);
  await expect(page.locator(".cust-sub .cust-tag")).toHaveText(["Exemption expired"]);
  await expect(page.locator(".cust-sub .cust-tag")).toHaveClass(/cust-tag-warn/);
  await expect(field(page, "Expires (blank = never)")).toHaveValue("2020-01-31");
  await expect(page.locator("#custForm").getByRole("checkbox", { name: /^Tax exempt/ })).toBeChecked();

  // A certificate and a date without the tick is not an exemption: no tag.
  await openCustomer(page, notTicked);
  await expect(page.locator(".cust-sub .cust-tag")).toHaveCount(0);
  await expect(field(page, "Certificate number")).toHaveValue("EX-3");

  // Moving the date ahead through the form turns "expired" back into "Tax exempt".
  await openCustomer(page, past);
  await field(page, "Expires (blank = never)").fill("2099-01-31");
  await saveAndRedraw(page);
  await expect(page.locator(".cust-sub .cust-tag")).toHaveText(["Tax exempt"]);
  expect((await getCustomer(api, past)).taxExemptExpires).toBe("2099-01-31");
});

test("Archive asks first, then the customer is archived (tag, Restore, no New sale) and off the list; Restore brings it back without asking", async ({ page, api }) => {
  const t = token();
  const id = await makeCustomer(api, { name: "Pat " + t });
  await openCustomer(page, id);
  const sent = recordActions(page, "setCustomerArchived");
  const head = page.locator("#custPage .cust-actions");

  // Back out of the question: nothing happens.
  await head.getByRole("button", { name: "Archive" }).click();
  const ask = page.locator(".confirm-modal");
  await expect(ask).toContainText("Archive Pat " + t + "?");
  await expect(ask).toContainText("It leaves the customer list and the customer search. Its orders stay as they are, and you can restore it at any time.");
  await expect(ask.locator("#cmOk")).toHaveText("Archive");
  await ask.locator("#cmCancel").click();
  await expect(ask).toHaveCount(0);
  await waitIdle(page);
  expect(sent).toEqual([]);
  expect((await getCustomer(api, id)).archived).toBe(false);
  await expect(head.getByRole("button", { name: "Archive" })).toBeVisible();

  // Archive.
  await head.getByRole("button", { name: "Archive" }).click();
  await ask.locator("#cmOk").click();
  await expect(toast(page)).toContainText("Customer archived.");
  await expect(head.getByRole("button", { name: "Restore" })).toBeVisible();
  await expect(head.getByRole("button", { name: "Archive" })).toHaveCount(0);
  await expect(head.getByRole("button", { name: "New sale for this customer" })).toHaveCount(0);
  await expect(page.locator(".cust-sub .cust-tag")).toHaveText(["Archived"]);
  await expect(page).toHaveURL(new RegExp("#customers/" + id + "$"));
  expect(sent).toEqual([expect.objectContaining({ id, archived: true })]);
  expect((await getCustomer(api, id)).archived).toBe(true);
  // An archived customer can still be edited.
  await field(page, "Phone").fill("555-0108");
  await saveAndRedraw(page);
  await expect(page.locator(".cust-sub .cust-tag")).toHaveText(["Archived"]);
  expect(await getCustomer(api, id)).toMatchObject({ phone: "555-0108", archived: true });

  // Off the list, until Show archived.
  await page.locator("#custPage").getByRole("link", { name: "‹ Customers" }).click();
  await search(page, t);
  await expect(rows(page)).toHaveCount(0);
  await expect(page.locator("#custBody")).toHaveText("No customer matches that search.");
  await page.getByRole("checkbox", { name: "Show archived" }).check();
  await expect(row(page, id).locator(".cust-tag")).toHaveText(["Archived"]);
  await row(page, id).getByRole("link").click();

  // Restore: no question.
  await expect(page.locator("#custForm")).toBeVisible();
  await page.locator("#custPage .cust-actions").getByRole("button", { name: "Restore" }).click();
  await expect(toast(page)).toContainText("Customer restored.");
  await expect(page.locator(".confirm-modal")).toHaveCount(0);
  await expect(page.locator("#custPage .cust-actions").getByRole("button", { name: "Archive" })).toBeVisible();
  await expect(page.locator("#custPage .cust-actions").getByRole("button", { name: "New sale for this customer" })).toBeVisible();
  await expect(page.locator(".cust-sub .cust-tag")).toHaveCount(0);
  expect(sent[sent.length - 1]).toMatchObject({ id, archived: false });
  expect((await getCustomer(api, id)).archived).toBe(false);
  await page.locator("#custPage").getByRole("link", { name: "‹ Customers" }).click();
  await page.getByRole("checkbox", { name: "Show archived" }).uncheck();
  await expect(row(page, id)).toBeVisible();
  await expect(row(page, id).locator(".cust-tag")).toHaveCount(0);
});

test("Archive that the server refuses says why and leaves the page as it was", async ({ page, api }) => {
  const t = token();
  const id = await makeCustomer(api, { name: "Pat " + t });
  await openCustomer(page, id);
  await page.route("**/api/orders", (route) => isAction(route.request(), "setCustomerArchived")
    ? route.fulfill({ status: 400, json: { status: "error", message: "Couldn't change the customer. Try again." } }) : route.fallback());
  await page.locator("#custPage .cust-actions").getByRole("button", { name: "Archive" }).click();
  await page.locator(".confirm-modal #cmOk").click();
  await expect(toast(page)).toContainText("Couldn't change the customer. Try again.");
  await expect(page.locator("#custPage .cust-actions").getByRole("button", { name: "Archive" })).toBeVisible();
  expect((await getCustomer(api, id)).archived).toBe(false);
});

// ---- addresses --------------------------------------------------------------------------------------------------
test("a customer's own address: #customers/<id> opens it and survives a reload; #/customers/<id> too; an unknown id says so; an id that isn't a number is the list; a merged-away id opens the customer kept", async ({ page, api }) => {
  const t = token();
  const id = await makeCustomer(api, { name: "Pat " + t });
  const dup = await makeCustomer(api, { name: "Pat Twin " + t });

  await page.goto(ADMIN + "/#customers/" + id);
  await expect(page.locator(".cust-name")).toHaveText("Pat " + t);
  await page.reload();
  await expect(page.locator(".cust-name")).toHaveText("Pat " + t);
  await expect(page).toHaveURL(new RegExp("#customers/" + id + "$"));
  await expect(page.getByRole("navigation", { name: "Admin" }).locator(".admin-nav-row").getByRole("button", { name: "Customers", exact: true })).toHaveClass(/active/);

  // The address the order pages link to.
  await page.goto("about:blank");
  await page.goto(ADMIN + "/#/customers/" + id);
  await expect(page.locator(".cust-name")).toHaveText("Pat " + t);
  await expect(field(page, "Name")).toHaveValue("Pat " + t);

  // No such customer: the server's answer, a way back, and no form.
  const unknown = 900000000 + Math.floor(Math.random() * 90000000);
  expect((await api("getCustomer", { id: unknown }, { allowError: true, withStatus: true })).status).toBe(404);
  await openAdmin(page, "customers/" + unknown);
  await expect(page.locator("#custPage").getByRole("alert")).toHaveText("Customer not found");
  await expect(page.locator("#custForm")).toHaveCount(0);
  await expect(page).toHaveTitle(/ — Customer \(Admin\)$/);
  await page.locator("#custPage").getByRole("link", { name: "‹ Customers" }).click();
  await expect(page).toHaveURL(/#customers$/);
  await expect(searchBox(page)).toBeVisible();

  // Not a customer's number: the list, and nothing asked of the server about a customer.
  for (const bad of ["abc", "0", "-3", "1.5", id + "x"]) {
    await page.goto("about:blank");
    const asked = recordActions(page, "getCustomer");
    await page.goto(ADMIN + "/#customers/" + bad);
    await expect(searchBox(page), bad).toBeVisible();
    await expect(page.locator("#custForm")).toHaveCount(0);
    await expect(page).toHaveTitle(/ — Customers \(Admin\)$/);
    await waitIdle(page, 200);
    expect(asked, bad).toEqual([]);
  }

  // A customer merged into another answers as the one kept, and the address follows.
  await api("mergeCustomers", { fromId: dup, intoId: id });
  await openAdmin(page, "customers/" + dup);
  await expect(page.locator(".cust-name")).toHaveText("Pat " + t);
  await expect(page).toHaveURL(new RegExp("#customers/" + id + "$"));
});

// ---- on a phone --------------------------------------------------------------------------------------------------
test("on a phone (390×844): Customers is in ☰ Menu, the list is a card per customer, the form is one column, and New customer, Save and Archive work", async ({ page, api }) => {
  const t = token();
  const id = await makeCustomer(api, { name: "Pat " + t, company: "Example Club", email: "pat." + t + "@example.test", phone: "555-0106" });
  await page.setViewportSize({ width: 390, height: 844 });
  const fits = async (what) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), what + " fits the screen's width").toBe(true);
  await openAdmin(page, "home");
  const nav = page.getByRole("navigation", { name: "Admin" });
  await expect(nav.locator(".admin-nav-row")).toBeHidden();
  await nav.getByRole("button", { name: "Menu" }).click();
  const sheetTop = nav.locator(".admin-nav-sheet-top").getByRole("button");
  const labels = await sheetTop.allTextContents();
  expect(labels.indexOf("Customers")).toBe(labels.indexOf("Orders") + 1);
  await nav.locator(".admin-nav-sheet-top").getByRole("button", { name: "Customers", exact: true }).click();
  await expect(page).toHaveURL(/#customers$/);
  await expect(nav.locator(".admin-nav-current")).toHaveText("Customers");
  await expect(searchBox(page)).toBeVisible();
  await fits("the list");

  // Cards: no heading row, each cell says what it is, the name on top.
  await search(page, t);
  await expect(rows(page)).toHaveCount(1);
  await expect(page.locator("#custBody thead")).toBeHidden();
  const cells = row(page, id).locator("td");
  await expect(cells.nth(1)).toHaveAttribute("data-label", "Company");
  await expect(cells.nth(2)).toHaveAttribute("data-label", "Email");
  await expect(cells.nth(3)).toHaveAttribute("data-label", "Phone");
  await expect(cells.nth(4)).toHaveAttribute("data-label", "Orders");
  await expect(cells.nth(5)).toHaveAttribute("data-label", "Last order");
  expect(await row(page, id).evaluate((tr) => getComputedStyle(tr).display)).toBe("flex");
  const boxes = await cells.evaluateAll((tds) => tds.map((td) => { const r = td.getBoundingClientRect(); return { top: r.top, left: r.left }; }));
  for (let i = 1; i < boxes.length; i++) expect(boxes[i].top, "cell " + i + " is under the one before").toBeGreaterThanOrEqual(boxes[i - 1].top);
  await fits("the searched list");

  // + New customer fits and its fields are one under the other.
  await page.getByRole("button", { name: "+ New customer" }).click();
  const dlg = page.getByRole("dialog", { name: "New customer" });
  await expect(dlg).toBeVisible();
  const dBox = await dlg.boundingBox();
  expect(dBox.x).toBeGreaterThanOrEqual(0);
  expect(dBox.x + dBox.width).toBeLessThanOrEqual(390);
  const nameBox = await dlg.getByLabel("Name").boundingBox(), companyBox = await dlg.getByLabel("Company").boundingBox();
  expect(companyBox.y).toBeGreaterThan(nameBox.y + nameBox.height - 1);
  await dlg.getByLabel("Name").fill("Phone " + t);
  await dlg.getByRole("button", { name: "Create customer" }).click();
  await expect(toast(page)).toContainText("Customer created.");
  await expect(page.locator(".cust-name")).toHaveText("Phone " + t);
  await fits("a new customer's page");

  // The first customer, opened by tapping its card.
  await page.locator("#custPage").getByRole("link", { name: "‹ Customers" }).click();
  await expect(rows(page)).toHaveCount(2);
  await row(page, id).locator("td").nth(2).click();
  await expect(page.locator(".cust-name")).toHaveText("Pat " + t);
  await fits("the customer's page");
  // One column: every field starts at the same left edge (those in the Tax exemption box at that box's own edge), one under the other.
  for (const sel of ["#custForm > .cust-grid input, #custForm > label textarea", "#custForm fieldset .cust-grid input"]) {
    const boxes = await page.locator(sel).evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return { left: Math.round(r.left), top: r.top }; }));
    expect(new Set(boxes.map((b) => b.left)).size, sel + " share one left edge: " + boxes.map((b) => b.left).join(",")).toBe(1);
    for (let i = 1; i < boxes.length; i++) expect(boxes[i].top, sel + " field " + i + " is under the one before").toBeGreaterThan(boxes[i - 1].top);
  }
  // The page's buttons are big enough for a thumb, and what is typed isn't zoomed (16px).
  for (const name of ["New sale for this customer", "Archive", "Merge into another customer…"]) {
    const b = await page.locator("#custPage .cust-actions").getByRole("button", { name }).boundingBox();
    expect(b.height, name).toBeGreaterThanOrEqual(44);
  }
  expect(await field(page, "Name").evaluate((el) => getComputedStyle(el).fontSize)).toBe("16px");

  await field(page, "City").fill("Sampleville");
  await field(page, "Notes").fill("Saved on a phone.");
  await saveAndRedraw(page);
  expect(await getCustomer(api, id)).toMatchObject({ notes: "Saved on a phone.", address: { city: "Sampleville" } });
  await fits("the saved customer's page");

  await page.locator("#custPage .cust-actions").getByRole("button", { name: "Archive" }).click();
  await page.locator(".confirm-modal #cmOk").click();
  await expect(toast(page)).toContainText("Customer archived.");
  await expect(page.locator("#custPage .cust-actions").getByRole("button", { name: "Restore" })).toBeVisible();
  expect((await getCustomer(api, id)).archived).toBe(true);
});

// ---- accessibility: the checks accessibility.spec.mjs makes of every page, on the list and on one customer ------
test("Customers: reached by keyboard from the menu, draws its page, no console errors; a customer is opened from the list with Tab and Enter", async ({ page, api, csp }) => {
  const t = token();
  const id = await makeCustomer(api, { name: "Pat " + t, company: "Example Club", email: "pat." + t + "@example.test", taxExempt: true });
  const errors = collectErrors(page);
  await openAdmin(page, "home");
  const nav = page.getByRole("navigation", { name: "Admin" });
  const startTitle = await page.title();
  await nav.getByRole("button", { name: "Home", exact: true }).first().focus();
  await tabTo(page, nav.locator(".admin-nav-row").getByRole("button", { name: "Customers", exact: true }));
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#customers$/);
  await expect(page).not.toHaveTitle(startTitle, { timeout: 5000 });
  await expect(page).toHaveTitle(/— Customers \(Admin\)$/);
  await waitIdle(page, 600);
  await expect(nav.locator(".admin-nav-group.open")).toHaveCount(0);

  // Every control of the list has a name a screen reader can say.
  await expect(searchBox(page)).toBeVisible();
  const unnamed = () => page.locator("#custPage").evaluate((root) => [...root.querySelectorAll("input, textarea, select, button, a[href]")]
    .filter((el) => !((el.labels && [...el.labels].some((l) => l.textContent.trim())) || el.getAttribute("aria-label") || el.textContent.trim()))
    .map((el) => el.outerHTML.slice(0, 80)));
  expect(await unnamed(), "controls without a name on the list").toEqual([]);

  // Tab to the search, type, Tab on to the customer's name, Enter.
  await tabTo(page, searchBox(page));
  const answered = page.waitForResponse((r) => isAction(r.request(), "listCustomers", (b) => b.q === t));
  await page.keyboard.type(t);
  await answered;
  await expect(rows(page)).toHaveCount(1);
  const link = row(page, id).getByRole("link", { name: "Pat " + t });
  await tabTo(page, link);
  const ring = await link.evaluate((el) => { const s = getComputedStyle(el); return (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== "none"; });
  expect(ring, "the focused name shows a focus ring").toBe(true);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp("#customers/" + id + "$"));
  await expect(page).toHaveTitle(new RegExp("— Pat " + t + " \\(Admin\\)$"));
  await expect(page.locator("#custForm")).toBeVisible();
  await waitIdle(page, 600);

  // One customer: its name as the heading, every field labelled, the exemption a named group.
  await expect(pageHeading(page)).toHaveText("Pat " + t);
  await expect(page.getByRole("heading", { level: 2, name: "Pat " + t })).toBeVisible();
  expect(await unnamed(), "controls without a name on the customer's page").toEqual([]);
  await expect(page.locator("#custForm").getByRole("group", { name: "Tax exemption" })).toBeVisible();
  // The form from the keyboard: Tab from Name runs through the fields in reading order to Save; Enter in a field saves.
  await field(page, "Name").focus();
  for (const l of ["Company", "Email", "Phone", "Address", "Address line 2", "City", "State", "ZIP", "Notes"]) {
    await page.keyboard.press("Tab");
    await expect(field(page, l), l).toBeFocused();
  }
  await page.keyboard.press("Tab");
  await expect(page.locator("#custForm").getByRole("checkbox", { name: /^Tax exempt/ })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(field(page, "Certificate number")).toBeFocused();
  await tabTo(page, save(page), 8);     // a date field takes a Tab for each of its parts
  await field(page, "Phone").focus();
  await page.keyboard.type("555-0107");
  await page.locator("#custPage").evaluate((el) => { el.dataset.e2eOld = "1"; });
  await page.keyboard.press("Enter");
  await expect(toast(page)).toContainText("Customer saved.");
  await expect(page.locator("#custPage:not([data-e2e-old])")).toBeVisible();
  expect((await getCustomer(api, id)).phone).toBe("555-0107");
  await waitIdle(page, 300);

  expect(errors, "console errors").toEqual([]);
  expect(csp, "what the Content-Security-Policy refused").toEqual([]);
});

// ---- other roles: what the page offers, and what the server answers -----------------------------------------------
test("Back office edits a customer but not the exemption; Production and Read only only read: in the page and at the server", async ({ api, as }, testInfo) => {
  const t = token();
  const id = await makeCustomer(api, { name: "Pat " + t, taxExempt: true, taxExemptCertificate: "EX-" + t, taxExemptExpires: "2099-12-31" });
  const exemption = { taxExempt: true, taxExemptCertificate: "EX-" + t, taxExemptExpires: "2099-12-31" };

  // Back office (Edit): New customer and Archive are offered, Merge isn't; the exemption is read-only and says why.
  const sp = await as("staff");
  await openCustomer(sp, id);
  await expect(sp.locator("#custPage .cust-actions").getByRole("button", { name: "Archive" })).toBeVisible();
  await expect(sp.locator("#custPage .cust-actions").getByRole("button", { name: "Merge into another customer…" })).toBeHidden();
  const group = sp.locator("#custForm").getByRole("group", { name: "Tax exemption" });
  await expect(group).toContainText("Only a role with full access to Customers can change a tax exemption.");
  await expect(group.getByRole("checkbox")).toBeDisabled();
  await expect(group.getByRole("checkbox")).toBeChecked();
  await expect(field(sp, "Certificate number")).toBeDisabled();
  await expect(field(sp, "Expires (blank = never)")).toBeDisabled();
  await expect(field(sp, "Name")).toBeEnabled();
  // Its save sends the stored exemption back, so it goes through and the exemption is as it was.
  const sent = recordActions(sp, "saveCustomer");
  await field(sp, "Phone").fill("555-0108");
  await saveAndRedraw(sp);
  expect(sent[0]).toMatchObject({ id, phone: "555-0108", ...exemption });
  expect(await getCustomer(api, id)).toMatchObject({ phone: "555-0108", ...exemption });
  // The server refuses Back office a change to the exemption, and nothing of that request is saved.
  const staff = await apiContext("staff", testInfo.workerIndex);
  const production = await apiContext("production", testInfo.workerIndex);
  const viewer = await apiContext("viewer", testInfo.workerIndex);
  try {
    let r = await tryApi(staff, "saveCustomer", { id, name: "Changed " + t, taxExempt: false });
    expect(r.status).toBe(403);
    expect(r.data.message).toBe("Your role can't change a customer's tax exemption. Ask an admin.");
    expect(await getCustomer(api, id)).toMatchObject({ name: "Pat " + t, ...exemption });
    await openAdmin(sp, "customers");
    await expect(sp.getByRole("button", { name: "+ New customer" })).toBeVisible();

    // Production (Read): the list and the customer, nothing to change them with.
    const pp = await as("production");
    await openAdmin(pp, "customers");
    await expect(pp.getByRole("navigation", { name: "Admin" }).locator(".admin-nav-row").getByRole("button", { name: "Customers", exact: true })).toBeVisible();
    await expect(searchBox(pp)).toBeVisible();
    await expect(pp.getByRole("button", { name: "+ New customer" })).toBeHidden();
    await search(pp, t);
    await row(pp, id).getByRole("link").click();
    await expect(pp.locator("#custForm")).toBeVisible();
    await expect(pp.locator(".cust-name")).toHaveText("Pat " + t);
    for (const l of ["Name", "Company", "Email", "Phone", "Address", "Address line 2", "City", "State", "ZIP", "Notes", "Certificate number", "Expires (blank = never)"]) await expect(field(pp, l), l).toBeDisabled();
    await expect(pp.locator("#custSave")).toBeHidden();
    for (const idOf of ["#custArchive", "#custMerge", "#custNewSale"]) await expect(pp.locator(idOf), idOf).toBeHidden();
    r = await tryApi(production, "saveCustomer", { id, name: "Changed " + t });
    expect(r.status).toBe(403);
    r = await tryApi(production, "saveCustomer", { name: "New " + t });
    expect(r.status).toBe(403);
    r = await tryApi(production, "setCustomerArchived", { id, archived: true });
    expect(r.status).toBe(403);
    expect((await tryApi(production, "getCustomer", { id })).status).toBe(200);
    expect(await getCustomer(api, id)).toMatchObject({ name: "Pat " + t, archived: false });
    expect((await api("listCustomers", { q: "New " + t, includeArchived: true })).total).toBe(0);

    // Read only (the suite's custom role, Read on everything, so Read on Customers): the list but no + New customer,
    // and the server refuses its changes.
    const vp = await as("viewer");
    await openAdmin(vp, "customers");
    await expect(vp.getByRole("navigation", { name: "Admin" }).locator(".admin-nav-row").getByRole("button", { name: "Customers", exact: true })).toBeVisible();
    await search(vp, t);
    await expect(row(vp, id)).toBeVisible();
    await expect(vp.getByRole("button", { name: "+ New customer" })).toBeHidden();
    for (const [action, body] of [["saveCustomer", { name: "New " + t }], ["saveCustomer", { id, name: "Changed " + t }], ["setCustomerArchived", { id, archived: true }]]) {
      r = await tryApi(viewer, action, body);
      expect(r.status, action).toBe(403);
    }
    expect(await getCustomer(api, id)).toMatchObject({ name: "Pat " + t, archived: false });
  } finally {
    await staff.dispose(); await production.dispose(); await viewer.dispose();
  }
});
