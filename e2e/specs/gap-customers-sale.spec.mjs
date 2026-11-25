// Orders and customer records together (migrations/0108), in a real browser:
//   - the Local sale window's Customer search: what it lists and says, picking with the mouse and with Enter, the
//     name, email and phone it fills, Clear, an edited email forgetting the pick, and the customerId it sends;
//   - which customer an order lands on: the one picked, the one with the typed email, a new one for a new email,
//     none for a sale without an email; the same for an order a shopper places on a shop's own page;
//   - the customer's page then lists those orders with what they come to (orders, spent, balance due);
//   - "New sale for this customer" on the customer's page (it asks which shop, then opens the window with the
//     customer picked, and draws the page again with the new order);
//   - on the Orders page the customer's name is a link to their record; "Link to a customer…" and "Unlink
//     customer" on an order; neither on a voided order or one whose every line is cancelled;
//   - who is offered what (Production reads, Back office links, a role without Customers gets none of it), and
//     what the server answers when such a role asks anyway.
//
// Every test makes its own shop, customers and orders, with names no other test has: the customer search is
// install-wide, so each search here is for a tag only this test's customers carry.
import crypto from "node:crypto";
import { request as playwrightRequest } from "@playwright/test";
import { test, expect, ADMIN, openAdmin, toast, uniq, slug, user, apiContext, callApi, freshIp, signInThroughPage } from "../fixtures.mjs";
import { makeShop, placeOrder } from "../lib/data.mjs";

const USERS = { path: "/api/admin-users" };
const PRODUCTS = [{ name: "Sample Tee", price: 20 }, { name: "Sample Cap", price: 18, type: "cap", idPrefix: "cap" }];
const requestId = () => crypto.randomUUID().replace(/-/g, "");
// A word only this test's customers have in their names: "zk3x9q1ab12".
const tagOf = () => slug("z");
const emailOf = (prefix) => slug(prefix) + "@example.test";
// A phone number of the 555-01xx kind that no other test's customer has (the search matches phones too).
const phoneOf = () => "555-01" + String(crypto.randomInt(0, 100)).padStart(2, "0") + " x" + crypto.randomInt(10000, 100000);

// ---- data, made with the owner's session ---------------------------------------------------------------
const makeCustomer = async (api, c) => {
  const r = await api("saveCustomer", { name: "", company: "", email: "", phone: "", address: null, notes: "",
    taxExempt: false, taxExemptCertificate: "", taxExemptExpires: "", ...c });
  expect(r.created).toBe(true);
  return { id: r.id, name: "", company: "", email: "", phone: "", ...c };
};
// A local sale through the API (the request the window sends): returns its order number.
const apiSale = async (api, shop, extra = {}) => (await api("createLocalSale", {
  org: shop.orgId, items: [{ productId: shop.products[0].productId, size: "", qty: 1 }], paymentMethod: "cash",
  customerName: "", requestId: requestId(), ...extra })).orderId;
const orderOf = async (api, shop, orderId) => (await api("getOrders", { org: shop.orgId })).orders.find(o => o.orderId === orderId);
const customersWith = async (api, q) => (await api("listCustomers", { q, includeArchived: true, limit: 50, offset: 0 })).customers;
const historyOf = async (api, id) => api("getCustomer", { id });

// ---- the Orders page -----------------------------------------------------------------------------------
const ordersPage = async (page, shop) => {
  if (page.url().startsWith(ADMIN)) await page.goto("about:blank");
  await openAdmin(page, "orders/" + shop.orgId);
  await expect(page.getByRole("combobox", { name: "Shop" })).toHaveValue(shop.orgId);
};
const orderRow = (page, orderId) => page.locator(`tr[data-order="${orderId}"]`).first();
const actionCell = (page, orderId) => orderRow(page, orderId).locator("td[data-action-td]");
const linkBtn = (page, orderId) => actionCell(page, orderId).getByRole("button", { name: "Link to a customer…" });
const unlinkBtn = (page, orderId) => actionCell(page, orderId).getByRole("button", { name: "Unlink customer" });
// The customer's name in the order's row, when it is a link to their record.
const nameLink = (page, orderId) => orderRow(page, orderId).locator("a.order-customer-link");
const posted = (page, action) => page.waitForRequest(r => r.url().endsWith("/api/orders") && new RegExp(`"action":"${action}"`).test(r.postData() || ""));
// Counts the requests of one action a page sends from now on.
const countRequests = (page, action) => {
  const seen = [];
  page.on("request", (r) => { if (r.url().endsWith("/api/orders") && new RegExp(`"action":"${action}"`).test(r.postData() || "")) seen.push(r.postData()); });
  return seen;
};

// ---- the Local sale window -----------------------------------------------------------------------------
const openLocalSale = async (page, shop) => {
  await ordersPage(page, shop);
  await page.getByRole("button", { name: "+ Local sale" }).click();
  const form = page.locator("#localSaleForm");
  await expect(form).toBeVisible();
  return form;
};
// Types into the Customer search and waits for what it says under the field.
const searchCustomer = async (form, text, says) => {
  await form.locator("#lsCustomer").fill(text);
  await expect(form.locator("#lsCustomerNote")).toHaveText(says);
};
const matches = (form) => form.locator("#lsCustomerList button");
// Fills the rest of the window and records the sale. Returns what was sent and the new order's number.
const recordSale = async (page, form, { product = "Sample Tee", qty = 1, paid = false } = {}) => {
  await form.locator("#lsProduct").selectOption({ label: product });
  if (qty !== 1) await form.locator("#lsQty").fill(String(qty));
  await form.locator("#lsPayment").selectOption("Cash");
  if (paid) await form.locator("#lsPaid").check();
  const sent = posted(page, "createLocalSale");
  await form.getByRole("button", { name: "Record sale" }).click();
  const req = await sent;
  const answer = await (await req.response()).json();
  expect(answer.status).toBe("ok");
  await expect(toast(page)).toContainText("Local sale recorded — " + answer.orderId);
  await expect(form).toHaveCount(0);
  return { body: JSON.parse(req.postData()), orderId: answer.orderId };
};

// ---- the customer's page -------------------------------------------------------------------------------
const openCustomer = async (page, c) => {
  await openAdmin(page, "customers/" + c.id);
  await expect(page.locator("#custPage h2.cust-name")).toBeVisible();
};
const totalOf = (page, label) => page.locator("#custPage .cust-total").filter({ has: page.locator("span", { hasText: new RegExp("^" + label + "$") }) }).locator("b");
const historyRow = (page, orderId) => page.locator("#custPage table.cust-table tbody tr").filter({ has: page.getByRole("link", { name: orderId, exact: true }) });
// One order's cells in the customer's Orders table: [order, shop, placed, total, paid, balance, status].
const historyCells = async (page, orderId) => (await historyRow(page, orderId).locator("td").allTextContents()).map(s => s.trim());

// ---- a role and a user of the test's own (the built-in roles all have Customers) -------------------------
const strongPassword = () => "Desk-" + crypto.randomBytes(15).toString("base64url");
const client = (workerIndex) => playwrightRequest.newContext({ baseURL: ADMIN, extraHTTPHeaders: { Origin: ADMIN, "CF-Connecting-IP": freshIp(workerIndex) } });
async function makeRoleUser(api, fns, label, workerIndex) {
  const role = (await api("saveRole", { name: label + " " + slug("c").slice(-6), rank: 20, permissions: { fns } }, USERS)).role;
  let U = null;
  const cleanUp = async () => {
    if (U) {
      await api("setRole", { id: U.id, role: "production" }, { ...USERS, allowError: true });
      await api("setStatus", { id: U.id, status: "disabled" }, { ...USERS, allowError: true });
    }
    await api("deleteRole", { roleKey: role.key }, { ...USERS, allowError: true });
    const left = (await api("listRoles", {}, USERS)).roles.filter(r => r.key === role.key);
    expect(left, "this test's role is gone again").toEqual([]);
  };
  try {
    const email = emailOf("cory");
    const made = await api("create", { name: "Cory " + label, email, role: role.key }, USERS);
    const c = await client(workerIndex);
    let r = await c.post("/api/admin-session", { data: { email, key: made.temporaryPassword } });
    expect((await r.json()).pending).toBe("password");
    const password = strongPassword();
    r = await c.post("/api/admin-password", { data: { action: "change", current: made.temporaryPassword, next: password } });
    expect((await r.json()).status).toBe("ok");
    await c.dispose();
    U = { id: made.user.id, email, password };
  } catch (e) { await cleanUp(); throw e; }
  return { role, U, cleanUp };
}
// That user's own API, signed in with their password.
async function signedInClient(U, workerIndex) {
  const ctx = await client(workerIndex);
  const r = await ctx.post("/api/admin-session", { data: { email: U.email, key: U.password } });
  expect(r.status()).toBe(200);
  return ctx;
}
const ask = (ctx, action, body) => callApi(ctx, action, body, { allowError: true, withStatus: true });

// =========================================================================================================
test("Local sale: a customer picked from the search fills name, email and phone, and the sales are in their history with the right totals", async ({ page, api }) => {
  const shop = await makeShop(api, { prefix: "cus", products: PRODUCTS });
  const tag = tagOf();
  const c = await makeCustomer(api, { name: "Pat Example " + tag, company: "Example Club " + tag, email: emailOf("pat"), phone: "555-0100" });

  const form = await openLocalSale(page, shop);
  // The Customer field sits above Customer info, which is still closed.
  await expect(form.locator("label[for=lsCustomer]")).toContainText("Customer");
  await expect(form.locator("#lsCustomer")).toHaveAttribute("placeholder", "Search by name, company, email or phone");
  await expect(form.locator("#lsName")).toBeHidden();
  await expect(form.locator("#lsCustomerPicked")).toBeHidden();
  await expect(matches(form)).toHaveCount(0);

  await searchCustomer(form, tag, "1 customer found.");
  await expect(matches(form)).toHaveCount(1);
  await expect(matches(form).first().locator("strong")).toHaveText(c.name);
  await expect(matches(form).first().locator("span").last()).toHaveText(`${c.company} · ${c.email} · ${c.phone}`);
  await expect(matches(form).first()).not.toContainText("Exempt");
  await matches(form).first().click();

  // Picked: the search gives way to who was picked, and Customer info opens with their details in it.
  await expect(form.locator("#lsCustomerPickedText")).toHaveText(`Picked: ${c.name} · ${c.company} · ${c.email} · ${c.phone}`);
  await expect(form.locator("#lsCustomerFind")).toBeHidden();
  await expect(form.locator("#lsCustomerClear")).toBeFocused();
  await expect(form.locator("#lsName")).toBeVisible();
  await expect(form.locator("#lsName")).toHaveValue(c.name);
  await expect(form.locator("#lsEmail")).toHaveValue(c.email);
  await expect(form.locator("#lsPhone")).toHaveValue(c.phone);

  const first = await recordSale(page, form, { qty: 2, paid: true });
  expect(first.body.customerId).toBe(c.id);
  expect(first.body.customerName).toBe(c.name);
  expect(first.body.contact).toBe(c.email);
  expect(first.body.phone).toBe(c.phone);
  expect((await orderOf(api, shop, first.orderId)).customerId).toBe(c.id);

  // The new row's name is a link to the customer.
  await expect(nameLink(page, first.orderId)).toHaveText(c.name);
  await expect(nameLink(page, first.orderId)).toHaveAttribute("href", "#/customers/" + c.id);
  await expect(unlinkBtn(page, first.orderId)).toBeVisible();
  await expect(linkBtn(page, first.orderId)).toHaveCount(0);

  // A second, unpaid sale for the same customer under another name on the order: the pick stays (only a different
  // email is a different person), so the order still goes on their record.
  await page.getByRole("button", { name: "+ Local sale" }).click();
  const form2 = page.locator("#localSaleForm");
  await expect(form2).toBeVisible();
  await searchCustomer(form2, c.email, "1 customer found.");
  await matches(form2).first().click();
  const other = "Robin Pickup " + tag;
  await form2.locator("#lsName").fill(other);
  await form2.locator("#lsPhone").fill("555-0101");
  await expect(form2.locator("#lsCustomerPickedText")).toContainText("Picked: " + c.name);
  const second = await recordSale(page, form2);
  expect(second.body.customerId).toBe(c.id);
  expect(second.body.customerName).toBe(other);
  const o2 = await orderOf(api, shop, second.orderId);
  expect(o2.customerId).toBe(c.id);
  expect(o2.customerName).toBe(other);
  // No second customer was made for it, and the record's own name and phone are as they were.
  const found = await customersWith(api, tag);
  expect(found.map(x => x.id)).toEqual([c.id]);
  expect([found[0].name, found[0].phone, found[0].orderCount]).toEqual([c.name, "555-0100", 2]);

  // The link in the row opens the customer's page: both orders, and what they come to.
  await expect(nameLink(page, second.orderId)).toHaveText(other);
  await nameLink(page, first.orderId).click();
  await expect(page).toHaveURL(new RegExp("#/?customers/" + c.id + "$"));
  await expect(page.locator("#custPage h2.cust-name")).toHaveText(c.name);
  await expect(totalOf(page, "Orders")).toHaveText("2");
  await expect(totalOf(page, "Spent")).toHaveText("$60.00");
  await expect(totalOf(page, "Balance due")).toHaveText("$20.00");
  await expect(page.locator("#custPage table.cust-table tbody tr")).toHaveCount(2);
  const paidCells = await historyCells(page, first.orderId);
  expect([paidCells[0], paidCells[1], paidCells[3], paidCells[4], paidCells[5]]).toEqual([first.orderId, shop.name, "$40.00", "$40.00", "$0.00"]);
  const owedCells = await historyCells(page, second.orderId);
  expect([owedCells[0], owedCells[1], owedCells[3], owedCells[4], owedCells[5]]).toEqual([second.orderId, shop.name, "$20.00", "$0.00", "$20.00"]);
  // Newest first.
  await expect(page.locator("#custPage table.cust-table tbody tr").first()).toContainText(second.orderId);
  await expect(page.locator("#custPage")).not.toContainText("Voided and test orders are listed");

  // An order number there opens that order on its shop's Orders page.
  await historyRow(page, second.orderId).getByRole("link", { name: second.orderId, exact: true }).click();
  await expect(page).toHaveURL(new RegExp("#/?orders/" + shop.orgId));
  await expect(orderRow(page, second.orderId)).toBeVisible();
});

test("Local sale: the Customer search says what it found, Enter picks only a single match, the arrow keys and Escape work the list", async ({ page, api }) => {
  const shop = await makeShop(api, { prefix: "cus", products: PRODUCTS });
  const tag = tagOf();
  // Nine customers share the tag; one of them has a word of its own, is tax-exempt and has only a company.
  const solo = "solo" + tag;
  const exempt = await makeCustomer(api, { company: `Example Club ${tag} ${solo}`, email: emailOf("club"), taxExempt: true, taxExemptCertificate: "E2E-CERT-1" });
  const pair = "pair" + tag;
  const a = await makeCustomer(api, { name: `Avery Example ${tag} ${pair}`, email: emailOf("avery") });
  const b = await makeCustomer(api, { name: `Blake Example ${tag} ${pair}`, phone: "555-0102" });
  for (let i = 0; i < 6; i++) await makeCustomer(api, { name: `Casey Example ${tag} ${i}` });
  const sales = countRequests(page, "createLocalSale");

  const form = await openLocalSale(page, shop);
  // Nothing matches.
  await searchCustomer(form, "nobody-" + tag, "No customer matches that.");
  await expect(form.locator("#lsCustomerList")).toBeHidden();
  // Enter with no match picks nobody and doesn't send the sale.
  await form.locator("#lsCustomer").press("Enter");
  await expect(form.locator("#lsCustomerPicked")).toBeHidden();

  // More than eight: the first eight, and how many there are.
  await searchCustomer(form, tag, "Showing the first 8 of 9 — keep typing to narrow it down.");
  await expect(matches(form)).toHaveCount(8);

  // Two: Enter doesn't choose between them.
  await searchCustomer(form, pair, "2 customers found.");
  await expect(matches(form).locator("strong")).toHaveText([a.name, b.name]);
  await expect(matches(form).nth(0).locator("span").last()).toHaveText(a.email);
  await expect(matches(form).nth(1).locator("span").last()).toHaveText("555-0102");
  await form.locator("#lsCustomer").press("Enter");
  await expect(form.locator("#lsCustomerPicked")).toBeHidden();
  await expect(matches(form)).toHaveCount(2);
  // ↓ goes into the list and on to the next match, ↑ back up and out to the field again.
  await form.locator("#lsCustomer").press("ArrowDown");
  await expect(matches(form).nth(0)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(matches(form).nth(1)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(matches(form).nth(1)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(matches(form).nth(0)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(form.locator("#lsCustomer")).toBeFocused();
  // Escape in the list closes the list, not the window, and returns to the field.
  await form.locator("#lsCustomer").press("ArrowDown");
  await page.keyboard.press("Escape");
  await expect(form.locator("#lsCustomerList")).toBeHidden();
  await expect(form.locator("#lsCustomerNote")).toBeHidden();
  await expect(form.locator("#lsCustomer")).toBeFocused();
  await expect(form).toBeVisible();
  // Escape in the field does the same while the list is open.
  await searchCustomer(form, pair + " ", "2 customers found.");
  await form.locator("#lsCustomer").press("Escape");
  await expect(form.locator("#lsCustomerList")).toBeHidden();
  await expect(form).toBeVisible();

  // An archived customer isn't offered.
  await api("setCustomerArchived", { id: b.id, archived: true });
  await searchCustomer(form, pair, "1 customer found.");
  await expect(matches(form).locator("strong")).toHaveText([a.name]);

  // One match, marked exempt; Enter picks it. A customer with only a company goes on the order under that name.
  await searchCustomer(form, solo, "1 customer found.");
  await expect(matches(form).first().locator("strong")).toHaveText(exempt.company);
  await expect(matches(form).first()).toContainText("Exempt");
  await form.locator("#lsCustomer").press("Enter");
  await expect(form.locator("#lsCustomerPickedText")).toHaveText(`Picked: ${exempt.company} · ${exempt.email} — tax exempt`);
  await expect(form.locator("#lsName")).toHaveValue(exempt.company);
  await expect(form.locator("#lsEmail")).toHaveValue(exempt.email);
  await expect(form.locator("#lsPhone")).toHaveValue("");
  await expect(form.locator("#lsCustomerClear")).toBeFocused();
  // Enter never sent the sale.
  await expect(form).toBeVisible();
  expect(sales).toEqual([]);

  const sale = await recordSale(page, form);
  expect(sale.body.customerId).toBe(exempt.id);
  expect((await orderOf(api, shop, sale.orderId)).customerId).toBe(exempt.id);
  await expect(nameLink(page, sale.orderId)).toHaveText(exempt.company);
});

test("Local sale: Clear takes back only what the pick wrote, and a different email forgets the pick and makes a new customer", async ({ page, api }) => {
  const shop = await makeShop(api, { prefix: "cus", products: PRODUCTS });
  const tag = tagOf();
  const c = await makeCustomer(api, { name: "Pat Example " + tag, email: emailOf("pat"), phone: phoneOf() });
  const form = await openLocalSale(page, shop);
  const pick = async () => { await searchCustomer(form, tag, "1 customer found."); await matches(form).first().click(); await expect(form.locator("#lsCustomerPicked")).toBeVisible(); };

  // Clear straight after a pick empties all three fields and returns to the search.
  await pick();
  await form.locator("#lsCustomerClear").click();
  await expect(form.locator("#lsCustomerPicked")).toBeHidden();
  await expect(form.locator("#lsCustomerFind")).toBeVisible();
  await expect(form.locator("#lsCustomer")).toBeFocused();
  await expect(form.locator("#lsCustomer")).toHaveValue("");
  await expect(form.locator("#lsName")).toHaveValue("");
  await expect(form.locator("#lsEmail")).toHaveValue("");
  await expect(form.locator("#lsPhone")).toHaveValue("");

  // A name and phone typed over the pick are the person's own: Clear leaves them, and takes the email back.
  await pick();
  await form.locator("#lsName").fill("Typed Name " + tag);
  await form.locator("#lsPhone").fill("555-0103");
  await form.locator("#lsCustomerClear").click();
  await expect(form.locator("#lsName")).toHaveValue("Typed Name " + tag);
  await expect(form.locator("#lsPhone")).toHaveValue("555-0103");
  await expect(form.locator("#lsEmail")).toHaveValue("");

  // The same email in other letters is still the same person; a different one is not.
  await form.locator("#lsName").fill("");
  await form.locator("#lsPhone").fill("");
  await pick();
  await form.locator("#lsEmail").fill(c.email.toUpperCase());
  await expect(form.locator("#lsCustomerPicked")).toBeVisible();
  const newEmail = emailOf("newperson");
  await form.locator("#lsEmail").fill(newEmail);
  await expect(form.locator("#lsCustomerPicked")).toBeHidden();
  await expect(form.locator("#lsCustomerFind")).toBeVisible();
  // What was filled in stays for the person to change.
  await expect(form.locator("#lsName")).toHaveValue(c.name);
  const newName = "Nico Newperson " + tag;
  await form.locator("#lsName").fill(newName);
  await form.locator("#lsPhone").fill("555-0104");

  const sale = await recordSale(page, form, { product: "Sample Cap" });
  expect(sale.body).not.toHaveProperty("customerId");
  expect(sale.body.contact).toBe(newEmail);
  // A new customer was made from the order: its email and the name typed. (The phone typed isn't checked: a
  // sale that isn't shipped drops it, so the new customer has none; reported, not asserted.)
  const made = await customersWith(api, newEmail);
  expect(made).toHaveLength(1);
  expect(made[0].id).not.toBe(c.id);
  expect([made[0].name, made[0].email, made[0].orderCount]).toEqual([newName, newEmail, 1]);
  expect((await orderOf(api, shop, sale.orderId)).customerId).toBe(made[0].id);
  // …and the customer picked first got nothing.
  expect((await historyOf(api, c.id)).orders).toEqual([]);
  await expect(nameLink(page, sale.orderId)).toHaveAttribute("href", "#/customers/" + made[0].id);

  // The new customer's page has the order.
  await nameLink(page, sale.orderId).click();
  await expect(page.locator("#custPage h2.cust-name")).toHaveText(newName);
  await expect(page.locator("#custEmail")).toHaveValue(newEmail);
  await expect(totalOf(page, "Orders")).toHaveText("1");
  await expect(totalOf(page, "Spent")).toHaveText("$18.00");
  await expect(totalOf(page, "Balance due")).toHaveText("$18.00");
  await expect(historyRow(page, sale.orderId)).toHaveCount(1);
});

test("Local sale: a typed email joins the customer who has it, whatever its letters; a sale without an email is nobody's", async ({ page, api }) => {
  const shop = await makeShop(api, { prefix: "cus", products: PRODUCTS });
  const tag = tagOf();
  const email = emailOf("morgan");
  const name = "Morgan Typed " + tag;

  // Typed, nobody picked: the first sale makes the customer.
  let form = await openLocalSale(page, shop);
  await form.locator("summary", { hasText: "Customer info" }).click();
  await form.locator("#lsName").fill(name);
  await form.locator("#lsEmail").fill(email);
  const first = await recordSale(page, form, { paid: true });
  expect(first.body).not.toHaveProperty("customerId");
  let made = await customersWith(api, email);
  expect(made).toHaveLength(1);
  const id = made[0].id;
  expect([made[0].name, made[0].email, made[0].orderCount]).toEqual([name, email, 1]);
  await expect(nameLink(page, first.orderId)).toHaveAttribute("href", "#/customers/" + id);

  // The same email in capitals, under another name: the same customer, whose own name stays.
  await page.getByRole("button", { name: "+ Local sale" }).click();
  form = page.locator("#localSaleForm");
  await form.locator("summary", { hasText: "Customer info" }).click();
  await form.locator("#lsName").fill("M. Typed " + tag);
  await form.locator("#lsEmail").fill("  " + email.toUpperCase() + " ");
  const second = await recordSale(page, form, { product: "Sample Cap" });
  made = await customersWith(api, email);
  expect(made.map(x => [x.id, x.name, x.orderCount])).toEqual([[id, name, 2]]);
  expect((await orderOf(api, shop, second.orderId)).customerId).toBe(id);

  // A name and a phone but no email: no customer is made, and the row offers to link it.
  await page.getByRole("button", { name: "+ Local sale" }).click();
  form = page.locator("#localSaleForm");
  await form.locator("summary", { hasText: "Customer info" }).click();
  const walkIn = "Wren Walkin " + tag;
  await form.locator("#lsName").fill(walkIn);
  await form.locator("#lsPhone").fill("555-0108");
  const third = await recordSale(page, form);
  expect((await orderOf(api, shop, third.orderId)).customerId).toBeNull();
  expect(await customersWith(api, walkIn)).toEqual([]);
  await expect(orderRow(page, third.orderId)).toContainText(walkIn);
  await expect(nameLink(page, third.orderId)).toHaveCount(0);
  await expect(linkBtn(page, third.orderId)).toBeVisible();
  await expect(unlinkBtn(page, third.orderId)).toHaveCount(0);

  // The customer's page: two orders, $38 in all, $18 of it still owed.
  await openCustomer(page, { id });
  await expect(totalOf(page, "Orders")).toHaveText("2");
  await expect(totalOf(page, "Spent")).toHaveText("$38.00");
  await expect(totalOf(page, "Balance due")).toHaveText("$18.00");
  await expect(historyRow(page, first.orderId)).toHaveCount(1);
  await expect(historyRow(page, second.orderId)).toHaveCount(1);
  await expect(historyRow(page, third.orderId)).toHaveCount(0);
});

test("an order a shopper places with a known customer's email is in that customer's history; a new email makes a customer", async ({ page, api, as }) => {
  const shop = await makeShop(api, { prefix: "cus", products: PRODUCTS });
  const tag = tagOf();
  const known = await makeCustomer(api, { name: "Kai Known " + tag, company: "Example Club " + tag, email: emailOf("kai"), phone: "555-0106" });

  // The shopper types their email with capitals, and their name their own way.
  const shopper = await as(null);
  const typedName = "K. Known " + tag;
  const o1 = await placeOrder(shopper, shop, { customer: typedName, email: known.email.toUpperCase(), items: [{ name: "Sample Tee", qty: 2 }] });
  expect(o1.total).toBe("40.00");
  expect((await orderOf(api, shop, o1.orderId)).customerId).toBe(known.id);
  // No second record for that email, and the customer's own name and company stay.
  const same = await customersWith(api, known.email);
  expect(same.map(x => [x.id, x.name, x.company, x.orderCount])).toEqual([[known.id, known.name, known.company, 1]]);

  // A shopper nobody has seen before.
  const stranger = await as(null);
  const newName = "Sky Stranger " + tag, newEmail = emailOf("sky");
  expect(await customersWith(api, newEmail)).toEqual([]);
  const o2 = await placeOrder(stranger, shop, { customer: newName, email: newEmail, items: [{ name: "Sample Cap", qty: 1 }] });
  const made = await customersWith(api, newEmail);
  expect(made).toHaveLength(1);
  expect([made[0].name, made[0].email, made[0].orderCount, made[0].taxExempt, made[0].archived]).toEqual([newName, newEmail, 1, false, false]);
  expect((await orderOf(api, shop, o2.orderId)).customerId).toBe(made[0].id);

  // Orders page: each name is a link to its customer (the order keeps the name the shopper typed).
  await ordersPage(page, shop);
  await expect(nameLink(page, o1.orderId)).toHaveText(typedName);
  await expect(nameLink(page, o1.orderId)).toHaveAttribute("href", "#/customers/" + known.id);
  await expect(nameLink(page, o2.orderId)).toHaveAttribute("href", "#/customers/" + made[0].id);
  await expect(unlinkBtn(page, o1.orderId)).toBeVisible();

  // The known customer's page: the order, unpaid, counted.
  await nameLink(page, o1.orderId).click();
  await expect(page.locator("#custPage h2.cust-name")).toHaveText(known.name);
  await expect(totalOf(page, "Orders")).toHaveText("1");
  await expect(totalOf(page, "Spent")).toHaveText("$40.00");
  await expect(totalOf(page, "Balance due")).toHaveText("$40.00");
  const cells = await historyCells(page, o1.orderId);
  expect([cells[0], cells[1], cells[3], cells[4], cells[5]]).toEqual([o1.orderId, shop.name, "$40.00", "$0.00", "$40.00"]);

  // The new customer is on the Customers list, and their page has their order.
  await openAdmin(page, "customers");
  await page.locator("#custQ").fill(newEmail);
  const listed = page.locator(`#custPage tr[data-cust-id="${made[0].id}"]`);
  await expect(listed).toBeVisible();
  await expect(listed).toContainText(newName);
  await expect(listed.locator("td.cust-num")).toHaveText("1");
  await listed.getByRole("link", { name: newName }).click();
  await expect(page.locator("#custPage h2.cust-name")).toHaveText(newName);
  await expect(totalOf(page, "Spent")).toHaveText("$18.00");
  await expect(historyRow(page, o2.orderId)).toHaveCount(1);
  await expect(page.locator("#custPage table.cust-table tbody tr")).toHaveCount(1);
});

test("New sale for this customer asks which shop, opens the Local sale window with them picked, and the page then lists the order", async ({ page, api }) => {
  // Two shops of this test's own, so there is always more than one to ask about.
  const shopA = await makeShop(api, { prefix: "cus", products: PRODUCTS });
  const shopB = await makeShop(api, { prefix: "cus", products: PRODUCTS });
  const tag = tagOf();
  const c = await makeCustomer(api, { name: "Jo Regular " + tag, company: "Example Club " + tag, email: emailOf("jo"), phone: "555-0107" });
  const sales = countRequests(page, "createLocalSale");

  await openCustomer(page, c);
  await expect(page.locator("#custPage")).toContainText("No orders yet.");
  await expect(totalOf(page, "Orders")).toHaveText("0");
  const newSale = page.getByRole("button", { name: "New sale for this customer" });
  await newSale.click();
  const which = page.getByRole("dialog", { name: "Which shop is the sale in?" });
  await expect(which).toBeVisible();
  await expect(which).toContainText("For " + c.name + ".");
  const shopPick = which.getByLabel("Shop");
  await expect(shopPick).toBeFocused();
  // Both shops are offered, by name.
  await expect(shopPick.locator(`option[value="${shopA.orgId}"]`)).toHaveText(shopA.name);
  await expect(shopPick.locator(`option[value="${shopB.orgId}"]`)).toHaveText(shopB.name);
  // Cancel: no sale window.
  await which.getByRole("button", { name: "Cancel" }).click();
  await expect(which).toHaveCount(0);
  await expect(page.locator("#localSaleForm")).toHaveCount(0);

  await newSale.click();
  await which.getByLabel("Shop").selectOption(shopB.orgId);
  await which.getByRole("button", { name: "Continue" }).click();
  await expect(which).toHaveCount(0);
  const form = page.locator("#localSaleForm");
  await expect(form).toBeVisible();
  await expect(form.locator("#lsCustomerPickedText")).toHaveText(`Picked: ${c.name} · ${c.company} · ${c.email} · ${c.phone}`);
  await expect(form.locator("#lsCustomerFind")).toBeHidden();
  await expect(form.locator("#lsName")).toHaveValue(c.name);
  await expect(form.locator("#lsEmail")).toHaveValue(c.email);
  await expect(form.locator("#lsPhone")).toHaveValue(c.phone);
  // The window is shop B's: its products are the ones listed.
  const sale = await recordSale(page, form, { qty: 3, paid: true });
  expect(sale.body.org).toBe(shopB.orgId);
  expect(sale.body.customerId).toBe(c.id);

  // Still on the customer's page, drawn again with the order.
  await expect(page).toHaveURL(new RegExp("#/?customers/" + c.id + "$"));
  await expect(historyRow(page, sale.orderId)).toHaveCount(1);
  await expect(totalOf(page, "Orders")).toHaveText("1");
  await expect(totalOf(page, "Spent")).toHaveText("$60.00");
  await expect(totalOf(page, "Balance due")).toHaveText("$0.00");
  const cells = await historyCells(page, sale.orderId);
  expect([cells[1], cells[3], cells[4], cells[5]]).toEqual([shopB.name, "$60.00", "$60.00", "$0.00"]);
  expect((await orderOf(api, shopB, sale.orderId)).customerId).toBe(c.id);

  // Asked again, the list starts on the shop just used; cancelling the sale window records nothing.
  await page.getByRole("button", { name: "New sale for this customer" }).click();
  await expect(which.getByLabel("Shop")).toHaveValue(shopB.orgId);
  await which.getByLabel("Shop").selectOption(shopA.orgId);
  await which.getByRole("button", { name: "Continue" }).click();
  await expect(form.locator("#lsCustomerPickedText")).toContainText("Picked: " + c.name);
  await form.getByRole("button", { name: "Cancel" }).click();
  await expect(form).toHaveCount(0);
  expect(sales).toHaveLength(1);
  await expect(page.locator("#custPage table.cust-table tbody tr")).toHaveCount(1);

  // Escape closes the shop question too.
  await page.getByRole("button", { name: "New sale for this customer" }).click();
  await expect(which).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(which).toHaveCount(0);
  await expect(page.locator("#localSaleForm")).toHaveCount(0);

  // An archived customer isn't offered a new sale.
  await api("setCustomerArchived", { id: c.id, archived: true });
  await openCustomer(page, c);
  await expect(page.getByRole("button", { name: "Restore" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New sale for this customer" })).toHaveCount(0);
});

test("New sale for a customer with only a company puts the company on the order", async ({ page, api }) => {
  const shop = await makeShop(api, { prefix: "cus", products: PRODUCTS });
  const tag = tagOf();
  const c = await makeCustomer(api, { company: "Example Club " + tag });
  await openCustomer(page, c);
  await page.getByRole("button", { name: "New sale for this customer" }).click();
  const which = page.getByRole("dialog", { name: "Which shop is the sale in?" });
  await expect(which).toContainText("For " + c.company + ".");
  await which.getByLabel("Shop").selectOption(shop.orgId);
  await which.getByRole("button", { name: "Continue" }).click();
  const form = page.locator("#localSaleForm");
  await expect(form.locator("#lsCustomerPickedText")).toHaveText("Picked: " + c.company);
  await expect(form.locator("#lsName")).toHaveValue(c.company);
  await expect(form.locator("#lsEmail")).toHaveValue("");
  await expect(form.locator("#lsPhone")).toHaveValue("");
  const sale = await recordSale(page, form);
  expect(sale.body.customerId).toBe(c.id);
  expect(sale.body.contact).toBe("");
  // No email on the order: it is this customer's only because they were picked.
  const o = await orderOf(api, shop, sale.orderId);
  expect([o.customerId, o.customerName, o.contact]).toEqual([c.id, c.company, ""]);
  await expect(historyRow(page, sale.orderId)).toHaveCount(1);
  await expect(totalOf(page, "Balance due")).toHaveText("$20.00");
});

test("Link to a customer… puts an order with a phone contact on a customer's record, and Unlink customer takes it off again", async ({ page, api }) => {
  const shop = await makeShop(api, { prefix: "cus", products: PRODUCTS });
  const tag = tagOf();
  const phone = phoneOf();
  const c = await makeCustomer(api, { name: "Lee Linked " + tag, company: "Example Club " + tag, phone });
  const other = await makeCustomer(api, { name: "Lee Lookalike " + tag });
  // Two orders that came in with a phone number for a contact: one under a name, one under none.
  const named = await apiSale(api, shop, { customerName: "Lee Linked " + tag, contact: phone, phone });
  const unnamed = await apiSale(api, shop, { contact: phone });
  expect((await orderOf(api, shop, named)).customerId).toBeNull();
  const links = countRequests(page, "setOrderCustomer");

  await ordersPage(page, shop);
  await expect(orderRow(page, named)).toContainText("Lee Linked " + tag);
  await expect(nameLink(page, named)).toHaveCount(0);
  await expect(unlinkBtn(page, named)).toHaveCount(0);
  await linkBtn(page, named).click();

  // The window starts on the order's name; nothing can be linked until someone is picked.
  const dlg = page.getByRole("dialog", { name: `Link order ${named} to a customer` });
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText("The order joins that customer's history and totals. The name and contact on the order itself stay as they are.");
  await expect(dlg.getByLabel("Customer", { exact: true })).toHaveValue("Lee Linked " + tag);
  await expect(dlg.locator("#pcSearchNote")).toHaveText("1 customer found.");
  await expect(dlg.getByRole("button", { name: "Link", exact: true })).toBeDisabled();
  await expect(dlg.locator("#pcPicked")).toBeHidden();
  // Cancel: nothing sent, nothing changed.
  await dlg.getByRole("button", { name: "Cancel" }).click();
  await expect(dlg).toHaveCount(0);
  expect(links).toEqual([]);
  await expect(linkBtn(page, named)).toBeVisible();

  // Again, searching by the tag: both customers; pick the right one, then Link.
  await linkBtn(page, named).click();
  await dlg.getByLabel("Customer", { exact: true }).fill(tag);
  await expect(dlg.locator("#pcSearchNote")).toHaveText("2 customers found.");
  await dlg.locator("#pcSearchList button").filter({ hasText: c.name }).click();
  await expect(dlg.locator("#pcPicked")).toHaveText(`Picked: ${c.name} · ${c.company} · ${phone}`);
  await expect(dlg.getByLabel("Customer", { exact: true })).toHaveValue("");
  const link = dlg.getByRole("button", { name: "Link", exact: true });
  await expect(link).toBeEnabled();
  await expect(link).toBeFocused();
  // Picking someone else instead replaces the pick.
  await dlg.getByLabel("Customer", { exact: true }).fill(other.name);
  await expect(dlg.locator("#pcSearchNote")).toHaveText("1 customer found.");
  await dlg.getByLabel("Customer", { exact: true }).press("Enter");
  await expect(dlg.locator("#pcPicked")).toHaveText("Picked: " + other.name);
  await dlg.getByLabel("Customer", { exact: true }).fill(c.name);
  await expect(dlg.locator("#pcSearchNote")).toHaveText("1 customer found.");
  await dlg.locator("#pcSearchList button").first().click();
  await expect(dlg.locator("#pcPicked")).toContainText("Picked: " + c.name);
  await link.click();
  await expect(toast(page)).toContainText(`Order ${named} linked to ${c.name}.`);
  await expect(dlg).toHaveCount(0);
  expect(links.map(p => JSON.parse(p)).map(b => [b.orderId, b.customerId, b.org])).toEqual([[named, c.id, shop.orgId]]);

  // The row follows without a reload: the name is the link, and the button is now Unlink customer.
  await expect(nameLink(page, named)).toHaveText("Lee Linked " + tag);
  await expect(nameLink(page, named)).toHaveAttribute("href", "#/customers/" + c.id);
  await expect(unlinkBtn(page, named)).toBeVisible();
  await expect(linkBtn(page, named)).toHaveCount(0);
  // Only whose order it is changed.
  let o = await orderOf(api, shop, named);
  expect([o.customerId, o.customerName, o.contact]).toEqual([c.id, "Lee Linked " + tag, phone]);
  let h = await historyOf(api, c.id);
  expect(h.orders.map(x => x.orderId)).toEqual([named]);
  expect([h.totals.orderCount, h.totals.totalSpent, h.totals.balanceDue]).toEqual([1, 20, 20]);

  // The order without a name starts the search on its contact, the phone number.
  await linkBtn(page, unnamed).click();
  const dlg2 = page.getByRole("dialog", { name: `Link order ${unnamed} to a customer` });
  await expect(dlg2.getByLabel("Customer", { exact: true })).toHaveValue(phone);
  await expect(dlg2.locator("#pcSearchNote")).toHaveText("1 customer found.");
  await expect(dlg2.locator("#pcSearchList button strong")).toHaveText([c.name]);
  // Escape closes the list first, then the window.
  await dlg2.getByLabel("Customer", { exact: true }).press("Escape");
  await expect(dlg2.locator("#pcSearchList")).toBeHidden();
  await expect(dlg2).toBeVisible();
  await dlg2.getByLabel("Customer", { exact: true }).press("Escape");
  await expect(dlg2).toHaveCount(0);
  await expect(linkBtn(page, unnamed)).toBeVisible();

  // The customer's page shows the linked order; back on Orders, Unlink customer asks first.
  await nameLink(page, named).click();
  await expect(page.locator("#custPage h2.cust-name")).toHaveText(c.name);
  await expect(historyRow(page, named)).toHaveCount(1);
  await expect(totalOf(page, "Orders")).toHaveText("1");
  await ordersPage(page, shop);
  await unlinkBtn(page, named).click();
  const sure = page.locator(".confirm-modal");
  await expect(sure).toContainText(`Take order ${named} off its customer's record?`);
  await expect(sure).toContainText("You can link it again at any time.");
  await sure.getByRole("button", { name: "Cancel" }).click();
  await expect(sure).toHaveCount(0);
  await expect(unlinkBtn(page, named)).toBeVisible();
  expect(links).toHaveLength(1);
  await unlinkBtn(page, named).click();
  await sure.getByRole("button", { name: "Unlink", exact: true }).click();
  await expect(toast(page)).toContainText(`Order ${named} is no longer linked to a customer.`);
  expect(JSON.parse(links[1]).customerId).toBeNull();
  await expect(nameLink(page, named)).toHaveCount(0);
  await expect(orderRow(page, named)).toContainText("Lee Linked " + tag);
  await expect(linkBtn(page, named)).toBeVisible();
  await expect(unlinkBtn(page, named)).toHaveCount(0);
  o = await orderOf(api, shop, named);
  expect([o.customerId, o.customerName, o.contact]).toEqual([null, "Lee Linked " + tag, phone]);
  h = await historyOf(api, c.id);
  expect(h.orders).toEqual([]);
  expect(h.totals.orderCount).toBe(0);
  await openCustomer(page, c);
  await expect(page.locator("#custPage")).toContainText("No orders yet.");
});

test("Link to a customer…: a customer merged away meanwhile is refused in plain words and the order stays unlinked", async ({ page, api }) => {
  const shop = await makeShop(api, { prefix: "cus", products: PRODUCTS });
  const tag = tagOf();
  const gone = await makeCustomer(api, { name: "Dana Duplicate " + tag });
  const kept = await makeCustomer(api, { name: "Dana Kept " + tag });
  const orderId = await apiSale(api, shop, { customerName: "Dana Duplicate " + tag, contact: "555-0108" });
  await ordersPage(page, shop);
  await linkBtn(page, orderId).click();
  const dlg = page.getByRole("dialog", { name: `Link order ${orderId} to a customer` });
  await expect(dlg.locator("#pcSearchNote")).toHaveText("1 customer found.");
  await dlg.locator("#pcSearchList button").first().click();
  await expect(dlg.locator("#pcPicked")).toHaveText("Picked: " + gone.name);
  // Someone else merges that customer into another before Link is pressed.
  await api("mergeCustomers", { fromId: gone.id, intoId: kept.id });
  await dlg.getByRole("button", { name: "Link", exact: true }).click();
  await expect(toast(page)).toContainText("Couldn't link the order: That customer was merged into another one. Open that one instead.");
  await expect(linkBtn(page, orderId)).toBeVisible();
  await expect(nameLink(page, orderId)).toHaveCount(0);
  expect((await orderOf(api, shop, orderId)).customerId).toBeNull();
});

test("a voided order, and one whose every line is cancelled, offer neither Link to a customer… nor Unlink customer", async ({ page, api }) => {
  const shop = await makeShop(api, { prefix: "cus", products: PRODUCTS });
  const tag = tagOf();
  const c = await makeCustomer(api, { name: "Val Voided " + tag, email: emailOf("val") });
  // Four unpaid orders: a linked and an unlinked one to void, and one of each to cancel. One linked order stays.
  const kept = await apiSale(api, shop, { customerName: c.name, customerId: c.id });
  const linkedVoid = await apiSale(api, shop, { customerName: c.name, customerId: c.id });
  const looseVoid = await apiSale(api, shop, { customerName: "Walk In " + tag, contact: "555-0109" });
  const linkedCancel = await apiSale(api, shop, { customerName: c.name, customerId: c.id });
  const looseCancel = await apiSale(api, shop, { customerName: "Walk In " + tag, contact: "555-0109" });

  await ordersPage(page, shop);
  await expect(unlinkBtn(page, linkedVoid)).toBeVisible();
  await expect(linkBtn(page, looseVoid)).toBeVisible();
  await expect(unlinkBtn(page, linkedCancel)).toBeVisible();
  await expect(linkBtn(page, looseCancel)).toBeVisible();

  // Cancel the only line of two of them.
  for (const id of [linkedCancel, looseCancel]) {
    await orderRow(page, id).getByRole("button", { name: "Cancel", exact: true }).click();
    await page.locator(".confirm-modal #cmOk").click();
    await expect(toast(page)).toContainText("Item canceled.");
    await expect(orderRow(page, id)).toHaveCount(0);
  }
  // Void the other two, through the page (reason, then the owner's password again).
  const owner = user("owner");
  for (const id of [linkedVoid, looseVoid]) {
    await actionCell(page, id).getByRole("button", { name: "Void…" }).click();
    await page.locator("#delReason").fill("Made by mistake in the e2e suite");
    await page.locator("#delConfirm").click();
    const who = page.getByRole("dialog", { name: "Confirm it's you to void " + id });
    await who.getByLabel("Email").fill(owner.email);
    await who.getByLabel("Password").fill(owner.password);
    await who.getByRole("button", { name: "Submit" }).click();
    await expect(toast(page)).toContainText("Order " + id + " voided");
    await expect(orderRow(page, id)).toHaveCount(0);
  }

  await page.getByRole("checkbox", { name: "Include cancelled" }).check();
  for (const id of [linkedVoid, looseVoid, linkedCancel, looseCancel]) {
    await expect(orderRow(page, id)).toBeVisible();
    await expect(linkBtn(page, id)).toHaveCount(0);
    await expect(unlinkBtn(page, id)).toHaveCount(0);
  }
  await expect(orderRow(page, linkedVoid)).toContainText("VOID");
  await expect(actionCell(page, linkedCancel)).toContainText("Cancelled");
  // They stay on the record they were on: the name is still the link, and the untouched order still unlinks.
  await expect(nameLink(page, linkedVoid)).toHaveAttribute("href", "#/customers/" + c.id);
  await expect(nameLink(page, linkedCancel)).toHaveAttribute("href", "#/customers/" + c.id);
  await expect(nameLink(page, looseVoid)).toHaveCount(0);
  await expect(unlinkBtn(page, kept)).toBeVisible();
  // The same after a fresh load of the page.
  await ordersPage(page, shop);
  await page.getByRole("checkbox", { name: "Include cancelled" }).check();
  await expect(orderRow(page, linkedVoid)).toBeVisible();
  for (const id of [linkedVoid, looseVoid, linkedCancel, looseCancel]) {
    await expect(linkBtn(page, id)).toHaveCount(0);
    await expect(unlinkBtn(page, id)).toHaveCount(0);
  }

  // The customer's page lists the voided order, marked, and leaves it out of the totals.
  await openCustomer(page, c);
  await expect(page.locator("#custPage table.cust-table tbody tr")).toHaveCount(3);
  await expect(historyRow(page, linkedVoid).locator("td").last()).toHaveText("Voided");
  await expect(historyRow(page, kept).locator("td").last()).toHaveText("");
  await expect(page.locator("#custPage")).toContainText("Voided and test orders are listed but not counted in the totals.");
  const h = await historyOf(api, c.id);
  await expect(totalOf(page, "Orders")).toHaveText(String(h.totals.orderCount));
  expect(h.orders.find(x => x.orderId === linkedVoid).voided).toBe(true);
  expect(h.orders.filter(x => !x.voided).map(x => x.orderId).sort()).toEqual([kept, linkedCancel].sort());
  // Opening the voided order from here shows it on the Orders page (Include cancelled is ticked for it).
  await historyRow(page, linkedVoid).getByRole("link", { name: linkedVoid, exact: true }).click();
  await expect(orderRow(page, linkedVoid)).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Include cancelled" })).toBeChecked();
  await expect(unlinkBtn(page, linkedVoid)).toHaveCount(0);
});

test("Production follows an order's customer link but can't link or unlink; Back office can", async ({ page, api, as }, testInfo) => {
  const shop = await makeShop(api, { prefix: "cus", products: PRODUCTS });
  const tag = tagOf();
  const c = await makeCustomer(api, { name: "Rory Roles " + tag, email: emailOf("rory") });
  const linked = await apiSale(api, shop, { customerName: c.name, customerId: c.id, paid: true });
  const loose = await apiSale(api, shop, { customerName: "Rory Roles " + tag, contact: "555-0110", paid: true });

  // Production (Customers at Read): the name is a link, the two buttons aren't there.
  const pp = await as("production");
  await ordersPage(pp, shop);
  await expect(nameLink(pp, linked)).toHaveAttribute("href", "#/customers/" + c.id);
  await expect(orderRow(pp, loose)).toContainText("Rory Roles " + tag);
  await expect(actionCell(pp, linked).locator('[data-admin-action="unlinkOrderCustomer_"]')).toHaveCount(0);
  await expect(actionCell(pp, loose).locator('[data-admin-action="linkOrderCustomer_"]')).toHaveCount(0);
  // The link opens the record, without a New sale button (Production can't record a sale).
  await nameLink(pp, linked).click();
  await expect(pp.locator("#custPage h2.cust-name")).toHaveText(c.name);
  await expect(historyRow(pp, linked)).toHaveCount(1);
  await expect(pp.getByRole("button", { name: "New sale for this customer" })).toHaveCount(0);
  // …and the server refuses Production's own request to link or unlink.
  const prod = await apiContext("production", testInfo.workerIndex);
  try {
    let r = await ask(prod, "setOrderCustomer", { org: shop.orgId, orderId: loose, customerId: c.id });
    expect(r.status).toBe(403);
    expect(r.data.status).toBe("error");
    r = await ask(prod, "setOrderCustomer", { org: shop.orgId, orderId: linked, customerId: null });
    expect(r.status).toBe(403);
    // A sale isn't Production's to record either, with a customer or without.
    r = await ask(prod, "createLocalSale", { org: shop.orgId, items: [{ productId: shop.products[0].productId, size: "", qty: 1 }], paymentMethod: "cash", customerName: "", customerId: c.id, requestId: requestId() });
    expect(r.status).toBe(403);
  } finally { await prod.dispose(); }
  expect((await orderOf(api, shop, loose)).customerId).toBeNull();
  expect((await orderOf(api, shop, linked)).customerId).toBe(c.id);

  // Back office (Customers at Edit) links and unlinks through the page.
  const sp = await as("staff");
  await ordersPage(sp, shop);
  await linkBtn(sp, loose).click();
  const dlg = sp.getByRole("dialog", { name: `Link order ${loose} to a customer` });
  await expect(dlg.locator("#pcSearchNote")).toHaveText("1 customer found.");
  await dlg.getByLabel("Customer", { exact: true }).press("Enter");
  await expect(dlg.locator("#pcPicked")).toHaveText(`Picked: ${c.name} · ${c.email}`);
  await dlg.getByRole("button", { name: "Link", exact: true }).click();
  await expect(toast(sp)).toContainText(`Order ${loose} linked to ${c.name}.`);
  await expect(nameLink(sp, loose)).toHaveAttribute("href", "#/customers/" + c.id);
  expect((await orderOf(api, shop, loose)).customerId).toBe(c.id);
  await unlinkBtn(sp, linked).click();
  await sp.locator(".confirm-modal").getByRole("button", { name: "Unlink", exact: true }).click();
  await expect(toast(sp)).toContainText(`Order ${linked} is no longer linked to a customer.`);
  expect((await orderOf(api, shop, linked)).customerId).toBeNull();
  // Back office records a sale for a picked customer from the customer's page.
  await openCustomer(sp, c);
  await sp.getByRole("button", { name: "New sale for this customer" }).click();
  const which = sp.getByRole("dialog", { name: "Which shop is the sale in?" });
  await which.getByLabel("Shop").selectOption(shop.orgId);
  await which.getByRole("button", { name: "Continue" }).click();
  const sale = await recordSale(sp, sp.locator("#localSaleForm"));
  expect(sale.body.customerId).toBe(c.id);
  await expect(historyRow(sp, sale.orderId)).toHaveCount(1);
});

test("a role without Customers gets a plain name, no customer search on a sale and no link buttons, and the server refuses it a customer", async ({ api, as }, testInfo) => {
  const w = testInfo.workerIndex;
  const shop = await makeShop(api, { prefix: "cus", products: PRODUCTS });
  const tee = shop.products[0];
  const tag = tagOf();
  const c = await makeCustomer(api, { name: "Noel Norights " + tag, email: emailOf("noel") });
  const linked = await apiSale(api, shop, { customerName: c.name, customerId: c.id });
  const loose = await apiSale(api, shop, { customerName: "Walk In " + tag, contact: "555-0111" });
  const sale = (ctx, extra) => ask(ctx, "createLocalSale", { org: shop.orgId, items: [{ productId: tee.productId, size: "", qty: 1 }], paymentMethod: "cash",
    customerName: "Counter Sale " + tag, requestId: requestId(), ...extra });

  // "Counter": Orders → details at Edit and nothing of Customers.
  const counter = await makeRoleUser(api, { "orders.details": "edit" }, "Counter", w);
  let ctx = null;
  try {
    const cp = await as(null);
    await cp.goto(ADMIN + "/#orders/" + shop.orgId);
    await signInThroughPage(cp, counter.U);
    const nav = cp.getByRole("navigation", { name: "Admin" });
    await expect(nav).toBeVisible();
    await expect(cp.getByRole("combobox", { name: "Shop" })).toHaveValue(shop.orgId);
    await expect(nav.getByRole("button", { name: "Orders", exact: true })).toBeVisible();
    await expect(nav.getByRole("button", { name: "Customers", exact: true })).toHaveCount(0);
    // The linked order's name is text, not a link, and neither order has a customer button.
    await expect(orderRow(cp, linked)).toContainText(c.name);
    await expect(nameLink(cp, linked)).toHaveCount(0);
    for (const id of [linked, loose]) {
      await expect(actionCell(cp, id).getByRole("button", { name: "Edit items" })).toBeVisible();
      await expect(linkBtn(cp, id)).toHaveCount(0);
      await expect(unlinkBtn(cp, id)).toHaveCount(0);
    }
    // The Local sale window has no Customer search; Customer info is as it always was.
    await cp.getByRole("button", { name: "+ Local sale" }).click();
    const form = cp.locator("#localSaleForm");
    await expect(form).toBeVisible();
    await expect(form.locator("#lsCustomerWrap")).toHaveCount(0);
    await expect(form.locator("#lsCustomer")).toHaveCount(0);
    await form.locator("summary", { hasText: "Customer info" }).click();
    await form.locator("#lsName").fill("Counter Typed " + tag);
    await form.locator("#lsEmail").fill(c.email);
    const typed = await recordSale(cp, form);
    expect(typed.body).not.toHaveProperty("customerId");
    // Typed with the customer's email, the sale still joins their history.
    expect((await orderOf(api, shop, typed.orderId)).customerId).toBe(c.id);
    await expect(nameLink(cp, typed.orderId)).toHaveCount(0);

    // The server, asked directly by that role.
    ctx = await signedInClient(counter.U, w);
    let r = await sale(ctx, { customerId: c.id });
    expect(r.status).toBe(403);
    expect(r.data.message).toBe("Your role can't pick a customer for a sale. Ask an admin.");
    r = await ask(ctx, "listCustomers", { q: tag });
    expect(r.status).toBe(403);
    r = await ask(ctx, "getCustomer", { id: c.id });
    expect(r.status).toBe(403);
    r = await ask(ctx, "setOrderCustomer", { org: shop.orgId, orderId: loose, customerId: c.id });
    expect(r.status).toBe(403);
    r = await ask(ctx, "setOrderCustomer", { org: shop.orgId, orderId: linked, customerId: null });
    expect(r.status).toBe(403);
    // Nothing of that was done: one sale of this role's exists (the typed one), and the two orders are as they were.
    const orders = (await api("getOrders", { org: shop.orgId })).orders;
    expect(orders.filter(o => o.customerName === "Counter Sale " + tag)).toEqual([]);
    expect(orders.find(o => o.orderId === loose).customerId).toBeNull();
    expect(orders.find(o => o.orderId === linked).customerId).toBe(c.id);
    // Without a customer the same role's sale goes through.
    r = await sale(ctx, {});
    expect(r.status).toBe(200);
    expect((await orderOf(api, shop, r.data.orderId)).customerId).toBeNull();
  } finally {
    if (ctx) await ctx.dispose();
    await counter.cleanUp();
  }
});

test("the server on an order's customer: Customers at Edit also needs Orders to link, and a customer that isn't one is refused or ignored", async ({ api }, testInfo) => {
  const w = testInfo.workerIndex;
  const shop = await makeShop(api, { prefix: "cus", products: PRODUCTS });
  const tee = shop.products[0];
  const tag = tagOf();
  const c = await makeCustomer(api, { name: "Sage Server " + tag });
  const loose = await apiSale(api, shop, { customerName: "Walk In " + tag, contact: "555-0112" });
  const owner = (action, body) => api(action, body, { allowError: true, withStatus: true });
  const sale = (extra) => owner("createLocalSale", { org: shop.orgId, items: [{ productId: tee.productId, size: "", qty: 1 }], paymentMethod: "cash",
    customerName: "Server Sale " + tag, requestId: requestId(), ...extra });

  // A sale's customerId must be a positive whole number…
  for (const bad of ["abc", 0, -3, 1.5, true]) {
    const r = await sale({ customerId: bad });
    expect([bad, r.status, r.data.message]).toEqual([bad, 400, "That customer isn't valid. Pick one from the list."]);
  }
  expect((await api("getOrders", { org: shop.orgId })).orders.filter(o => o.customerName === "Server Sale " + tag)).toEqual([]);
  // …and one that is no customer's number is ignored: the sale is recorded, on nobody's record.
  let r = await sale({ customerId: 987654321 });
  expect(r.status).toBe(200);
  expect((await orderOf(api, shop, r.data.orderId)).customerId).toBeNull();

  // Linking: the same checks, then the order and the customer must exist.
  r = await owner("setOrderCustomer", { org: shop.orgId, orderId: loose, customerId: "abc" });
  expect([r.status, r.data.message]).toEqual([400, "That customer isn't valid. Pick one from the list."]);
  r = await owner("setOrderCustomer", { org: shop.orgId, orderId: loose, customerId: 987654321 });
  expect([r.status, r.data.message]).toEqual([404, "Customer not found"]);
  r = await owner("setOrderCustomer", { org: shop.orgId, orderId: "", customerId: c.id });
  expect([r.status, r.data.message]).toEqual([400, "Invalid order ID"]);
  expect((await orderOf(api, shop, loose)).customerId).toBeNull();
  // An archived customer can still be given an order.
  await api("setCustomerArchived", { id: c.id, archived: true });
  r = await owner("setOrderCustomer", { org: shop.orgId, orderId: loose, customerId: c.id });
  expect(r.status).toBe(200);
  expect((await orderOf(api, shop, loose)).customerId).toBe(c.id);
  // Unlinking twice is fine both times.
  for (let i = 0; i < 2; i++) expect((await owner("setOrderCustomer", { org: shop.orgId, orderId: loose, customerId: null })).status).toBe(200);
  expect((await orderOf(api, shop, loose)).customerId).toBeNull();

  // A role with Customers at Edit but no Orders can't move an order by its number.
  const clerk = await makeRoleUser(api, { "customers.records": "edit" }, "Records", w);
  let ctx = null;
  try {
    ctx = await signedInClient(clerk.U, w);
    r = await ask(ctx, "listCustomers", { q: tag, includeArchived: true });
    expect(r.status).toBe(200);
    expect(r.data.customers.map(x => x.id)).toEqual([c.id]);
    r = await ask(ctx, "setOrderCustomer", { org: shop.orgId, orderId: loose, customerId: c.id });
    expect([r.status, r.data.message]).toEqual([403, "Your role can't change an order's customer. Ask an admin."]);
    expect((await orderOf(api, shop, loose)).customerId).toBeNull();
  } finally {
    if (ctx) await ctx.dispose();
    await clerk.cleanUp();
  }
});
