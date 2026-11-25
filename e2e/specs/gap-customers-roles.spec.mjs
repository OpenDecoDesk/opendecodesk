// Customers (migrations/0105): what each role may do with customer records (customers.records in
// functions/_lib/permissions.js; the checks in functions/api/orders.js; the page in public/admin-customers.js and
// the menu, the order's Link / Unlink and the Local sale Customer box in public/admin.js).
//   - Manager (Full): everything, the tax exemption and Merge included.
//   - Back office (Edit): adds, changes, archives, restores and links. The Tax exemption fields are read-only and
//     its save sends the stored exemption back; Merge isn't offered. The server refuses a save that changes the
//     exemption, and mergeCustomers.
//   - Production and the suite's Read only role (Read): open and read. No + New customer, Save, Archive, Merge or
//     Link, and the server refuses each write.
//   - A role without Customers: no Customers button, the page says it isn't part of the role, the server refuses
//     even the list, and the Local sale form has no Customer box. Giving it Read under Settings → Users → Roles
//     and permissions brings them all in at once; taking it away removes them again.
// The last one uses a role and a user of its own (made through the owner's session, deleted at the end), so the
// Read only role the other specs share is never changed. Every shop, customer and order here is this file's own.
import crypto from "node:crypto";
import { request as playwrightRequest } from "@playwright/test";
import { test, expect, ADMIN, openAdmin, waitIdle, toast, confirmDialog, signInThroughPage, callApi, apiContext, freshIp, slug, uniq } from "../fixtures.mjs";
import { makeShop } from "../lib/data.mjs";

// ---- helpers ---------------------------------------------------------------------------------------------
const USERS = { path: "/api/admin-users" };
const FN = "customers.records";
const NO_ROLE = "Your role can't do this. Ask an admin.";
const NO_EXEMPTION = "Your role can't change a customer's tax exemption. Ask an admin.";
const FAR = "2099-12-31";   // an expiry no run of this suite reaches

const nav = (page) => page.getByRole("navigation", { name: "Admin" });
// The Customers button in the row of top buttons (the phone menu repeats it, hidden at this width).
const navBtn = (page) => nav(page).locator('.admin-nav-row > button[data-h="customers"]');
const topButtons = (page) => nav(page).locator(".admin-nav-row > button[data-h]").evaluateAll(els => els.map(e => e.dataset.h));
const requestId = () => crypto.randomUUID().replace(/-/g, "");
const anEmail = () => slug("cr") + "@example.test";
// A request the server may refuse: { status, data } instead of throwing.
const tryApi = (ctx, action, body) => callApi(ctx, action, body, { allowError: true, withStatus: true });
const refused = (r, message, what) => {
  expect(r.status, what + " is refused").toBe(403);
  expect(r.data.status, what).toBe("error");
  expect(r.data.message, what).toBe(message);
};

// A customer made through the owner's session: its id.
const makeCustomer = async (api, fields = {}) => (await api("saveCustomer", { name: uniq("Pat Example"), ...fields })).id;
const customerOf = async (api, id) => (await api("getCustomer", { id })).customer;
// What a save or an archive could change, as the owner reads it back.
const stored = async (api, id) => {
  const c = await customerOf(api, id);
  return { id: c.id, name: c.name, company: c.company, email: c.email, phone: c.phone, notes: c.notes, archived: c.archived,
    taxExempt: c.taxExempt, taxExemptCertificate: c.taxExemptCertificate, taxExemptExpires: c.taxExemptExpires || "" };
};
// A $20 local sale in the shop, through the owner's session: on the customer's record when one is given.
const makeSale = async (api, shop, customerName, customerId) => (await api("createLocalSale", {
  org: shop.orgId, items: [{ productId: shop.products[0].productId, size: "", qty: 1 }], paymentMethod: "cash", customerName,
  requestId: requestId(), ...(customerId ? { customerId } : {}),
})).orderId;
const orderOf = async (api, shop, orderId) => (await api("getOrders", { org: shop.orgId })).orders.find(o => o.orderId === orderId);

const openCustomer = async (page, id) => {
  await openAdmin(page, "customers/" + id);
  await expect(page.locator("#custForm")).toBeVisible();
};
const ordersPage = async (page, shop) => {
  await openAdmin(page, "orders/" + shop.orgId);
  await expect(page.getByRole("combobox", { name: "Shop" })).toHaveValue(shop.orgId);
};
const orderRow = (page, orderId) => page.locator(`tr[data-order="${orderId}"]`).first();
const actionCell = (page, orderId) => orderRow(page, orderId).locator("td[data-action-td]");
// The Customers list is up (its heading is hidden on screen, kept for screen readers: the title and the search say it).
const listShown = async (page) => {
  await expect(page).toHaveTitle(/ — Customers \(Admin\)$/);
  await expect(page.locator("#custPage #custQ")).toBeVisible();
};
// The page a role without Customers gets instead.
const notAvailable = async (page, roleName) => {
  await expect(page.locator("#roleOffPanel")).toContainText("Not available to you.");
  await expect(page.locator("#roleOffPanel")).toContainText(`Your role (${roleName}) doesn't include this page.`);
  await expect(page.locator("#roleOffPanel")).toContainText("Settings → Users → Roles and permissions");
};
const sent = (page, action) => page.waitForRequest(r => r.url().endsWith("/api/orders") && (r.postDataJSON() || {}).action === action);

// ---- Manager: everything ---------------------------------------------------------------------------------
test("Manager: adds a customer, sets the tax exemption, archives, restores and merges, in the page and at the server", async ({ api, as }, testInfo) => {
  const mp = await as("manager");
  await openAdmin(mp, "home");
  // Customers sits right after Orders.
  await expect(navBtn(mp)).toBeVisible();
  const tops = await topButtons(mp);
  expect(tops.indexOf("customers")).toBe(tops.indexOf("orders") + 1);
  await navBtn(mp).click();
  await expect(mp).toHaveURL(/#customers$/);
  await listShown(mp);

  // + New customer.
  const name = uniq("Morgan Manager-made"), email = anEmail();
  await expect(mp.locator("#custNew")).toBeVisible();
  await mp.locator("#custNew").click();
  await mp.locator("#custNewName").fill(name);
  await mp.locator("#custNewEmail").fill(email);
  await mp.locator("#custNewSave").click();
  await expect(toast(mp)).toContainText("Customer created.");
  await expect(mp).toHaveURL(/#customers\/\d+$/);
  await expect(mp.locator("#custName")).toHaveValue(name);
  const id = Number(/#customers\/(\d+)$/.exec(mp.url())[1]);
  expect(await stored(api, id)).toMatchObject({ name, email, taxExempt: false, archived: false });

  // The tax exemption is the Manager's to change.
  await expect(mp.locator("#custExempt")).toBeEnabled();
  await expect(mp.locator("#custCert")).toBeEnabled();
  await expect(mp.locator("#custExpires")).toBeEnabled();
  await expect(mp.locator("fieldset.cust-exempt")).toContainText("Applies to orders placed from now on, until the day it expires.");
  await expect(mp.locator("fieldset.cust-exempt")).not.toContainText("Only a role with full access");
  await mp.locator("#custExempt").check();
  await mp.locator("#custCert").fill("EX-MGR-1");
  await mp.locator("#custExpires").fill(FAR);
  await mp.locator("#custSave").click();
  await expect(toast(mp)).toContainText("Customer saved.");
  await expect(mp.locator(".cust-sub .cust-tag-exempt")).toHaveText("Tax exempt");
  await expect(mp.locator("#custExempt")).toBeChecked();
  expect(await stored(api, id)).toMatchObject({ taxExempt: true, taxExemptCertificate: "EX-MGR-1", taxExemptExpires: FAR });

  // Archive, then Restore.
  await expect(mp.locator("#custNewSale")).toBeVisible();
  await expect(mp.locator("#custArchive")).toHaveText("Archive");
  await mp.locator("#custArchive").click();
  await confirmDialog(mp, "Archive");
  await expect(toast(mp)).toContainText("Customer archived.");
  await expect(mp.locator("#custArchive")).toHaveText("Restore");
  expect((await stored(api, id)).archived).toBe(true);
  await mp.locator("#custArchive").click();
  await expect(toast(mp)).toContainText("Customer restored.");
  await expect(mp.locator("#custArchive")).toHaveText("Archive");
  expect((await stored(api, id)).archived).toBe(false);

  // Merge into another customer…
  const keepName = uniq("Kit Keeper");
  const keepId = await makeCustomer(api, { name: keepName });
  await expect(mp.locator("#custMerge")).toBeVisible();
  await mp.locator("#custMerge").click();
  await mp.locator("#custMergeQ").fill(keepName);
  await mp.locator("#custMergeList button", { hasText: keepName }).click();
  await expect(mp.locator("#custMergeText")).toContainText(`Merge ${name} into ${keepName}?`);
  await expect(mp.locator("#custMergeText")).toContainText(`0 orders will move to ${keepName}.`);
  await mp.locator("#custMergeGo").click();
  await expect(toast(mp)).toContainText("Merged. 0 orders moved.");
  await expect(mp).toHaveURL(new RegExp("#customers/" + keepId + "$"));
  await expect(mp.locator("#custName")).toHaveValue(keepName);
  // The merged-away record now answers as the one kept, which took its email but not its exemption.
  const kept = await stored(api, id);
  expect(kept).toMatchObject({ id: keepId, name: keepName, email, taxExempt: false });

  // The server, asked with the Manager's session: an exemption change and a merge both go through.
  const mgr = await apiContext("manager", testInfo.workerIndex);
  try {
    const a = await makeCustomer(api), b = await makeCustomer(api);
    let r = await tryApi(mgr, "saveCustomer", { id: a, taxExempt: true, taxExemptCertificate: "EX-MGR-2", taxExemptExpires: FAR });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(await stored(api, a)).toMatchObject({ taxExempt: true, taxExemptCertificate: "EX-MGR-2", taxExemptExpires: FAR });
    r = await tryApi(mgr, "saveCustomer", { name: uniq("Exempt From-the-start"), taxExempt: true, taxExemptCertificate: "EX-MGR-3" });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.created).toBe(true);
    expect((await stored(api, r.data.id)).taxExempt).toBe(true);
    r = await tryApi(mgr, "mergeCustomers", { fromId: a, intoId: b });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.moved).toBe(0);
    expect((await customerOf(api, a)).id).toBe(b);
  } finally {
    await mgr.dispose();
  }
});

// ---- Back office: Edit ------------------------------------------------------------------------------------
test("Back office: adds, changes, archives and restores a customer; the Tax exemption is read-only and Merge isn't offered", async ({ api, as }) => {
  const sp = await as("staff");
  await openAdmin(sp, "home");
  await expect(navBtn(sp)).toBeVisible();
  await navBtn(sp).click();
  await listShown(sp);

  // + New customer.
  const name = uniq("Blake Backoffice-made");
  await expect(sp.locator("#custNew")).toBeVisible();
  await sp.locator("#custNew").click();
  await sp.locator("#custNewName").fill(name);
  await sp.locator("#custNewPhone").fill("555-0100");
  await sp.locator("#custNewSave").click();
  await expect(toast(sp)).toContainText("Customer created.");
  await expect(sp).toHaveURL(/#customers\/\d+$/);
  const madeId = Number(/#customers\/(\d+)$/.exec(sp.url())[1]);
  expect(await stored(api, madeId)).toMatchObject({ name, phone: "555-0100", taxExempt: false });
  // On a customer that isn't exempt the fields are locked too.
  await expect(sp.locator("#custExempt")).toBeDisabled();
  await expect(sp.locator("#custExempt")).not.toBeChecked();

  // A customer the owner made exempt.
  const exemptName = uniq("Exempt Example Club");
  const id = await makeCustomer(api, { name: exemptName, phone: "555-0101", taxExempt: true, taxExemptCertificate: "EX-OWNER-1", taxExemptExpires: FAR });
  await openCustomer(sp, id);
  await expect(sp.locator("#custName")).toBeEnabled();
  await expect(sp.locator("#custSave")).toBeVisible();
  await expect(sp.locator("#custExempt")).toBeDisabled();
  await expect(sp.locator("#custExempt")).toBeChecked();
  await expect(sp.locator("#custCert")).toBeDisabled();
  await expect(sp.locator("#custCert")).toHaveValue("EX-OWNER-1");
  await expect(sp.locator("#custExpires")).toBeDisabled();
  await expect(sp.locator("#custExpires")).toHaveValue(FAR);
  await expect(sp.locator("fieldset.cust-exempt")).toContainText("Only a role with full access to Customers can change a tax exemption.");
  await expect(sp.locator(".cust-sub .cust-tag-exempt")).toHaveText("Tax exempt");
  await expect(sp.locator("#custMerge")).toBeHidden();
  await expect(sp.locator("#custNewSale")).toBeVisible();

  // Save: the details change, and the exemption goes back as it is stored.
  await sp.locator("#custPhone").fill("555-0102");
  await sp.locator("#custNotes").fill("Calls before pickup.");
  const save = sent(sp, "saveCustomer");
  await sp.locator("#custSave").click();
  expect((await save).postDataJSON()).toMatchObject({ id, phone: "555-0102", taxExempt: true, taxExemptCertificate: "EX-OWNER-1", taxExemptExpires: FAR });
  await expect(toast(sp)).toContainText("Customer saved.");
  await expect(sp.locator("#custPhone")).toHaveValue("555-0102");
  expect(await stored(api, id)).toMatchObject({ name: exemptName, phone: "555-0102", notes: "Calls before pickup.",
    taxExempt: true, taxExemptCertificate: "EX-OWNER-1", taxExemptExpires: FAR });

  // Archive (asked first), then Restore.
  await sp.locator("#custArchive").click();
  await expect(sp.getByRole("dialog").last()).toContainText(`Archive ${exemptName}?`);
  await confirmDialog(sp, "Archive");
  await expect(toast(sp)).toContainText("Customer archived.");
  await expect(sp.locator("#custArchive")).toHaveText("Restore");
  await expect(sp.locator("#custNewSale")).toHaveCount(0);
  await expect(sp.locator("#custMerge")).toBeHidden();
  expect((await stored(api, id)).archived).toBe(true);
  await sp.locator("#custArchive").click();
  await expect(toast(sp)).toContainText("Customer restored.");
  await expect(sp.locator("#custArchive")).toHaveText("Archive");
  expect((await stored(api, id)).archived).toBe(false);
});

test("Back office: unlinks an order from its customer and links it to another, on the Orders page", async ({ api, as }) => {
  const shop = await makeShop(api, { prefix: "crl", products: [{ name: "Sample Tee", price: 20 }] });
  const firstName = uniq("Lee Linked"), otherName = uniq("Ola Other");
  const first = await makeCustomer(api, { name: firstName }), other = await makeCustomer(api, { name: otherName });
  const orderId = await makeSale(api, shop, firstName, first);
  expect((await orderOf(api, shop, orderId)).customerId).toBe(first);

  const sp = await as("staff");
  await ordersPage(sp, shop);
  // A linked order: the name opens the customer, and the button is Unlink customer.
  await expect(orderRow(sp, orderId).locator("a.order-customer-link")).toHaveAttribute("href", "#/customers/" + first);
  await expect(actionCell(sp, orderId).getByRole("button", { name: "Link to a customer…" })).toHaveCount(0);
  await actionCell(sp, orderId).getByRole("button", { name: "Unlink customer" }).click();
  await expect(sp.getByRole("dialog").last()).toContainText(`Take order ${orderId} off its customer's record?`);
  await confirmDialog(sp, "Unlink");
  await expect(toast(sp)).toContainText(`Order ${orderId} is no longer linked to a customer.`);
  await expect(orderRow(sp, orderId).locator("a.order-customer-link")).toHaveCount(0);
  expect((await orderOf(api, shop, orderId)).customerId).toBeNull();

  // Unlinked: Link to a customer… finds one, and Link puts the order on their record.
  await actionCell(sp, orderId).getByRole("button", { name: "Link to a customer…" }).click();
  const form = sp.locator("#pickCustomerForm");
  await expect(form).toBeVisible();
  await expect(form.getByRole("button", { name: "Link", exact: true })).toBeDisabled();
  await form.locator("#pcSearch").fill(otherName);
  await form.locator("#pcSearchList button", { hasText: otherName }).click();
  await expect(form.locator("#pcPicked")).toContainText("Picked: " + otherName);
  await form.getByRole("button", { name: "Link", exact: true }).click();
  await expect(toast(sp)).toContainText(`Order ${orderId} linked to ${otherName}.`);
  await expect(orderRow(sp, orderId).locator("a.order-customer-link")).toHaveAttribute("href", "#/customers/" + other);
  await expect(actionCell(sp, orderId).getByRole("button", { name: "Unlink customer" })).toBeVisible();
  expect((await orderOf(api, shop, orderId)).customerId).toBe(other);
  expect((await api("getCustomer", { id: other })).totals.orderCount).toBe(1);
  expect((await api("getCustomer", { id: first })).totals.orderCount).toBe(0);
});

test("Back office at the server: a changed exemption and a merge are refused; the same save with the stored exemption goes through", async ({ api }, testInfo) => {
  const plain = await makeCustomer(api, { phone: "555-0103" });
  const exempt = await makeCustomer(api, { taxExempt: true, taxExemptCertificate: "EX-OWNER-2", taxExemptExpires: FAR });
  const plainBefore = await stored(api, plain), exemptBefore = await stored(api, exempt);
  const staff = await apiContext("staff", testInfo.workerIndex);
  try {
    // Each of the three exemption fields, on its own, is a change to the exemption. Nothing else in the request is saved.
    refused(await tryApi(staff, "saveCustomer", { id: plain, phone: "555-0199", taxExempt: true }), NO_EXEMPTION, "ticking Tax exempt");
    refused(await tryApi(staff, "saveCustomer", { id: plain, taxExemptCertificate: "EX-STAFF" }), NO_EXEMPTION, "typing a certificate");
    refused(await tryApi(staff, "saveCustomer", { id: plain, taxExemptExpires: FAR }), NO_EXEMPTION, "setting an expiry");
    refused(await tryApi(staff, "saveCustomer", { id: exempt, taxExempt: false }), NO_EXEMPTION, "taking an exemption off");
    refused(await tryApi(staff, "saveCustomer", { id: exempt, taxExemptExpires: "" }), NO_EXEMPTION, "clearing the expiry");
    expect(await stored(api, plain)).toEqual(plainBefore);
    expect(await stored(api, exempt)).toEqual(exemptBefore);
    // A new customer can't start out exempt either: none is made.
    const newName = uniq("Never Made");
    refused(await tryApi(staff, "saveCustomer", { name: newName, taxExempt: true }), NO_EXEMPTION, "adding an exempt customer");
    refused(await tryApi(staff, "saveCustomer", { name: newName, taxExempt: false, taxExemptCertificate: "EX-STAFF" }), NO_EXEMPTION, "adding a customer with a certificate");
    expect((await api("listCustomers", { q: newName, includeArchived: true })).total).toBe(0);

    // The exemption as it is stored (what the page sends back) isn't a change: the rest is saved.
    let r = await tryApi(staff, "saveCustomer", { id: exempt, phone: "555-0104", taxExempt: true, taxExemptCertificate: "EX-OWNER-2", taxExemptExpires: FAR });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data).toMatchObject({ status: "ok", id: exempt, created: false });
    expect(await stored(api, exempt)).toEqual({ ...exemptBefore, phone: "555-0104" });
    // …and so is a save that leaves the exemption out, or a new customer with the blanks the New customer window sends.
    r = await tryApi(staff, "saveCustomer", { id: exempt, notes: "Left as it was." });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(await stored(api, exempt)).toEqual({ ...exemptBefore, phone: "555-0104", notes: "Left as it was." });
    r = await tryApi(staff, "saveCustomer", { name: uniq("Staff Added"), taxExempt: false, taxExemptCertificate: "", taxExemptExpires: "" });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.created).toBe(true);

    // Merge is Full's.
    refused(await tryApi(staff, "mergeCustomers", { fromId: plain, intoId: exempt }), NO_ROLE, "mergeCustomers");
    expect((await customerOf(api, plain)).id).toBe(plain);
    expect(await stored(api, plain)).toEqual(plainBefore);

    // Archive, restore and an order's customer are Edit's.
    r = await tryApi(staff, "setCustomerArchived", { id: plain, archived: true });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect((await stored(api, plain)).archived).toBe(true);
    r = await tryApi(staff, "setCustomerArchived", { id: plain, archived: false });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect((await stored(api, plain)).archived).toBe(false);
    const shop = await makeShop(api, { prefix: "crs", products: [{ name: "Sample Tee", price: 20 }] });
    const orderId = await makeSale(api, shop, uniq("Una Unlinked"));
    expect((await orderOf(api, shop, orderId)).customerId).toBeNull();
    r = await tryApi(staff, "setOrderCustomer", { org: shop.orgId, orderId, customerId: plain });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect((await orderOf(api, shop, orderId)).customerId).toBe(plain);
  } finally {
    await staff.dispose();
  }
});

// ---- Production and Read only: Read -------------------------------------------------------------------------
for (const [role, label] of [["production", "Production"], ["viewer", "Read only"]]) {
  test(`${label}: opens the list and a customer to read; no New, Save, Archive, Merge or Link, and the server refuses each write`, async ({ api, as }, testInfo) => {
    if (role === "viewer") {
      // The suite's setup gives its Read only role Read on every function the server lists, this one included.
      const mine = (await api("listRoles", {}, USERS)).roles.find(r => r.name === "Read only");
      expect(mine.permissions.fns[FN]).toBe("read");
    }
    const shop = await makeShop(api, { prefix: "crr", products: [{ name: "Sample Tee", price: 20 }] });
    const tag = slug("rd");
    const name = "Robin Reader " + tag, archivedName = "Archie Archived " + tag;
    const id = await makeCustomer(api, { name, company: "Example Club", email: anEmail(), phone: "555-0105", notes: "Likes navy.",
      taxExempt: true, taxExemptCertificate: "EX-OWNER-3", taxExemptExpires: FAR });
    const other = await makeCustomer(api, { name: uniq("Sam Second") });
    const archivedId = await makeCustomer(api, { name: archivedName });
    await api("setCustomerArchived", { id: archivedId, archived: true });
    const orderId = await makeSale(api, shop, name, id);
    const looseId = await makeSale(api, shop, uniq("Una Unlinked"));
    const before = await stored(api, id);

    const p = await as(role);
    await openAdmin(p, "home");
    await expect(navBtn(p)).toBeVisible();
    await navBtn(p).click();
    await expect(p).toHaveURL(/#customers$/);
    await listShown(p);
    await expect(p.locator("#custNew")).toBeHidden();

    // The search and Show archived work for a reader.
    await p.locator("#custQ").fill(tag);
    const row = p.locator(`tr[data-cust-id="${id}"]`);
    await expect(row).toBeVisible();
    await expect(p.locator("tr[data-cust-id]")).toHaveCount(1);
    await expect(row.locator(".cust-tag-exempt")).toHaveText("Exempt");
    await expect(row).toContainText("Example Club");
    await expect(row).toContainText("555-0105");
    await expect(row.locator("td.cust-num")).toHaveText("1");
    await p.locator("#custShowArchived").check();
    await expect(p.locator(`tr[data-cust-id="${archivedId}"]`)).toContainText("Archived");
    await expect(p.locator("tr[data-cust-id]")).toHaveCount(2);

    // The customer: everything to read, nothing to change.
    await row.locator("a.cust-link").click();
    await expect(p).toHaveURL(new RegExp("#customers/" + id + "$"));
    await expect(p.locator("#custForm")).toBeVisible();
    await expect(p.locator("#custName")).toHaveValue(name);
    for (const f of ["#custName", "#custCompany", "#custEmail", "#custPhone", "#custLine1", "#custCity", "#custNotes", "#custExempt", "#custCert", "#custExpires"]) {
      await expect(p.locator(f), f + " is read-only").toBeDisabled();
    }
    await expect(p.locator("#custNotes")).toHaveValue("Likes navy.");
    await expect(p.locator("#custExempt")).toBeChecked();
    await expect(p.locator("#custCert")).toHaveValue("EX-OWNER-3");
    await expect(p.locator("fieldset.cust-exempt")).toContainText("Only a role with full access to Customers can change a tax exemption.");
    await expect(p.locator("#custSave")).toBeHidden();
    await expect(p.locator("#custArchive")).toBeHidden();
    await expect(p.locator("#custMerge")).toBeHidden();
    await expect(p.locator("#custNewSale")).toBeHidden();
    await expect(p.locator(".cust-totals")).toContainText("$20.00");
    await expect(p.locator(".cust-table a.cust-link", { hasText: orderId })).toBeVisible();

    // The Orders page: the name opens the customer; no Link or Unlink on either order.
    await ordersPage(p, shop);
    await expect(orderRow(p, looseId).locator("a.order-customer-link")).toHaveCount(0);
    for (const o of [orderId, looseId]) {
      await expect(orderRow(p, o)).toBeVisible();
      await expect(actionCell(p, o).getByRole("button", { name: /Link to a customer|Unlink customer/ })).toHaveCount(0);
      await expect(actionCell(p, o).locator('[data-admin-action="linkOrderCustomer_"], [data-admin-action="unlinkOrderCustomer_"]')).toHaveCount(0);
    }
    await orderRow(p, orderId).locator("a.order-customer-link").click();
    await expect(p).toHaveURL(new RegExp("#/?customers/" + id + "$"));
    await expect(p.locator("#custName")).toHaveValue(name);

    // The server, asked with this role's session: reads answer, every write is refused and nothing changes.
    const ctx = await apiContext(role, testInfo.workerIndex);
    try {
      let r = await tryApi(ctx, "listCustomers", { q: tag });
      expect(r.status).toBe(200);
      expect(r.data.customers.map(c => c.id)).toEqual([id]);
      r = await tryApi(ctx, "getCustomer", { id });
      expect(r.status).toBe(200);
      expect(r.data.customer.name).toBe(name);
      expect(r.data.totals).toMatchObject({ orderCount: 1, totalSpent: 20 });

      refused(await tryApi(ctx, "saveCustomer", { name: "Never Made " + tag }), NO_ROLE, "adding a customer");
      refused(await tryApi(ctx, "saveCustomer", { id, phone: "555-0199" }), NO_ROLE, "changing a customer");
      refused(await tryApi(ctx, "saveCustomer", { id, taxExempt: false }), NO_ROLE, "changing the exemption");
      refused(await tryApi(ctx, "setCustomerArchived", { id, archived: true }), NO_ROLE, "archiving");
      refused(await tryApi(ctx, "setCustomerArchived", { id: archivedId, archived: false }), NO_ROLE, "restoring");
      refused(await tryApi(ctx, "mergeCustomers", { fromId: id, intoId: other }), NO_ROLE, "merging");
      refused(await tryApi(ctx, "setOrderCustomer", { org: shop.orgId, orderId, customerId: null }), NO_ROLE, "unlinking an order");
      refused(await tryApi(ctx, "setOrderCustomer", { org: shop.orgId, orderId: looseId, customerId: id }), NO_ROLE, "linking an order");
    } finally {
      await ctx.dispose();
    }
    expect(await stored(api, id)).toEqual(before);
    expect((await customerOf(api, id)).id).toBe(id);
    expect((await stored(api, archivedId)).archived).toBe(true);
    expect((await api("listCustomers", { q: tag, includeArchived: true })).total).toBe(2);
    expect((await orderOf(api, shop, orderId)).customerId).toBe(id);
    expect((await orderOf(api, shop, looseId)).customerId).toBeNull();
  });
}

// ---- A role without Customers, then given Read on the Roles page ------------------------------------------
const strongPassword = () => "Desk-" + crypto.randomBytes(15).toString("base64url");
const client = (workerIndex) => playwrightRequest.newContext({ baseURL: ADMIN, extraHTTPHeaders: { Origin: ADMIN, "CF-Connecting-IP": freshIp(workerIndex) } });

test("A custom role starts without Customers (no button, no page, no Local sale Customer box, the server refuses); Read given on Roles and permissions brings them in, and taking it away removes them", async ({ page, api, as }, testInfo) => {
  test.setTimeout(120_000);
  const roleName = "Counter " + slug("c").slice(-6);
  // A new custom role: orders at Edit (so it has + Local sale) and nothing said about Customers.
  const role = (await api("saveRole", { name: roleName, rank: 20, permissions: { fns: { "home.counts": "read", "orders.details": "edit", "catalog.products": "read" } } }, USERS)).role;
  let userId = null, ctx = null;
  try {
    expect(role.permissions.fns[FN] || "none").toBe("none");
    const tag = slug("cu");
    const who = { email: tag + "@example.test", password: strongPassword() };
    const made = await api("create", { name: "Cory Counter " + tag.slice(-4), email: who.email, role: role.key }, USERS);
    userId = made.user.id;
    ctx = await client(testInfo.workerIndex);
    let res = await ctx.post("/api/admin-session", { data: { email: who.email, key: made.temporaryPassword } });
    expect((await res.json()).pending).toBe("password");
    res = await ctx.post("/api/admin-password", { data: { action: "change", current: made.temporaryPassword, next: who.password } });
    expect((await res.json()).status).toBe("ok");
    res = await ctx.post("/api/admin-session", { data: { email: who.email, key: who.password } });
    expect(res.status()).toBe(200);

    const shop = await makeShop(api, { prefix: "crn", products: [{ name: "Sample Tee", price: 20 }] });
    const custName = uniq("Nico Nopick");
    const custId = await makeCustomer(api, { name: custName, phone: "555-0106" });
    const other = await makeCustomer(api);
    const orderId = await makeSale(api, shop, custName, custId);
    const before = await stored(api, custId);
    const sale = (extra) => tryApi(ctx, "createLocalSale", { org: shop.orgId, items: [{ productId: shop.products[0].productId, size: "", qty: 1 }],
      paymentMethod: "cash", customerName: uniq("Lane Localsale"), requestId: requestId(), ...extra });
    const shopOrders = async () => (await api("getOrders", { org: shop.orgId })).orders.map(o => o.orderId);

    // -- Without Customers: the server.
    const writes = async (when) => {
      refused(await tryApi(ctx, "saveCustomer", { name: "Never Made " + tag }), NO_ROLE, when + ": adding a customer");
      refused(await tryApi(ctx, "saveCustomer", { id: custId, phone: "555-0199" }), NO_ROLE, when + ": changing a customer");
      refused(await tryApi(ctx, "setCustomerArchived", { id: custId, archived: true }), NO_ROLE, when + ": archiving");
      refused(await tryApi(ctx, "mergeCustomers", { fromId: custId, intoId: other }), NO_ROLE, when + ": merging");
      refused(await tryApi(ctx, "setOrderCustomer", { org: shop.orgId, orderId, customerId: null }), NO_ROLE, when + ": unlinking an order");
    };
    const withoutCustomers = async (when) => {
      refused(await tryApi(ctx, "listCustomers", {}), NO_ROLE, when + ": listCustomers");
      refused(await tryApi(ctx, "getCustomer", { id: custId }), NO_ROLE, when + ": getCustomer");
      await writes(when);
      // A sale can't be put on a customer's record by a role that can't open Customers: no order is made.
      const had = await shopOrders();
      refused(await sale({ customerId: custId }), "Your role can't pick a customer for a sale. Ask an admin.", when + ": a sale with a customer picked");
      expect(await shopOrders()).toEqual(had);
    };
    await withoutCustomers("without Customers");

    // -- Without Customers: the pages.
    const cp = await as(null);
    await cp.goto(ADMIN + "/#orders/" + shop.orgId);
    await signInThroughPage(cp, who);
    await expect(nav(cp)).toBeVisible();
    const pagesWithout = async () => {
      await openAdmin(cp, "customers");
      await expect(nav(cp).locator('[data-h="customers"]')).toHaveCount(0);
      expect(await topButtons(cp)).toContain("orders");
      expect(await topButtons(cp)).not.toContain("customers");
      await notAvailable(cp, roleName);
      await expect(cp.locator("#custPage")).toHaveCount(0);
      await openAdmin(cp, "customers/" + custId);
      await notAvailable(cp, roleName);
      await expect(cp.locator("#custForm")).toHaveCount(0);
      // Orders: the customer's name is plain text, with no Link or Unlink; the Local sale form has no Customer box.
      await ordersPage(cp, shop);
      await expect(orderRow(cp, orderId)).toContainText(custName);
      await expect(orderRow(cp, orderId).locator("a.order-customer-link")).toHaveCount(0);
      await expect(actionCell(cp, orderId).getByRole("button", { name: /Link to a customer|Unlink customer/ })).toHaveCount(0);
      await cp.getByRole("button", { name: "+ Local sale" }).click();
      await expect(cp.locator("#localSaleForm #lsProduct")).toBeVisible();
      await expect(cp.locator("#lsCustomerWrap")).toHaveCount(0);
      await expect(cp.locator("#lsCustomer")).toHaveCount(0);
      await expect(cp.locator("#localSaleForm #lsCustomerInfo")).toHaveCount(1);   // the typed name and contact are still there
      await cp.locator("#localSaleForm .admin-pass-cancel").click();
      await expect(cp.locator("#localSaleForm")).toHaveCount(0);
    };
    await pagesWithout();

    // -- The owner gives the role Read on Customers: Settings → Users → Roles and permissions.
    const rolesTab = async () => {
      await openAdmin(page, "users");
      await page.getByRole("tab", { name: "Roles and permissions" }).click();
      await page.locator(".role-chip", { hasText: roleName }).click();
      await expect(page.locator("#roleName")).toHaveValue(roleName);
    };
    const customersSwitch = page.locator('.perm-menu-head input[data-menu="customers"]');
    const storedLevel = async () => ((await api("listRoles", {}, USERS)).roles.find(r => r.key === role.key).permissions.fns[FN]) || "none";
    await rolesTab();
    await expect(page.locator(".perm-menu-head", { has: page.locator('input[data-menu="customers"]') })).toContainText("Customers");
    await expect(customersSwitch).not.toBeChecked();
    await expect(page.locator(`input[name="perm-${FN}"]`)).toHaveCount(0);
    await customersSwitch.check();
    await expect(page.getByRole("radiogroup", { name: "Customer records" })).toBeVisible();
    await page.locator(`input[name="perm-${FN}"][value="read"]`).check();
    await page.getByRole("button", { name: "Save role" }).click();
    await expect(toast(page)).toContainText("Role saved. It applies at once to everyone who has it.");
    expect(await storedLevel()).toBe("read");

    // -- With Read: the button, the list, a customer to read, the order's name as a link, the Customer box.
    await openAdmin(cp, "home");
    await expect(navBtn(cp)).toBeVisible();
    const tops = await topButtons(cp);
    expect(tops.indexOf("customers"), "Customers sits right after Orders").toBe(tops.indexOf("orders") + 1);
    await navBtn(cp).click();
    await listShown(cp);
    await expect(cp.locator("#custNew")).toBeHidden();
    await cp.locator("#custQ").fill(custName);
    await cp.locator(`tr[data-cust-id="${custId}"] a.cust-link`).click();
    await expect(cp.locator("#custName")).toHaveValue(custName);
    await expect(cp.locator("#custName")).toBeDisabled();
    await expect(cp.locator("#custSave")).toBeHidden();
    await expect(cp.locator("#custArchive")).toBeHidden();
    await expect(cp.locator("#custMerge")).toBeHidden();
    // This role may record a sale (Orders at Edit), so that button is offered.
    await expect(cp.locator("#custNewSale")).toBeVisible();

    let r = await tryApi(ctx, "listCustomers", { q: custName });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.customers.map(c => c.id)).toEqual([custId]);
    r = await tryApi(ctx, "getCustomer", { id: custId });
    expect(r.status).toBe(200);
    await writes("with Read");

    await ordersPage(cp, shop);
    await expect(orderRow(cp, orderId).locator("a.order-customer-link")).toHaveAttribute("href", "#/customers/" + custId);
    await expect(actionCell(cp, orderId).getByRole("button", { name: /Link to a customer|Unlink customer/ })).toHaveCount(0);
    // The Local sale form now has the Customer box: a customer picked there goes with the sale.
    await cp.getByRole("button", { name: "+ Local sale" }).click();
    const form = cp.locator("#localSaleForm");
    await expect(form.locator("#lsCustomerWrap")).toBeVisible();
    await expect(form.getByLabel("Customer (optional)", { exact: true })).toBeVisible();
    await form.locator("#lsCustomer").fill(custName);
    await form.locator("#lsCustomerList button", { hasText: custName }).click();
    await expect(form.locator("#lsCustomerPickedText")).toContainText("Picked: " + custName);
    await expect(form.locator("#lsName")).toHaveValue(custName);
    await form.locator("#lsProduct").selectOption({ label: shop.products[0].name });
    await form.locator("#lsQty").fill("1");
    await form.locator("#lsPayment").selectOption("Cash");
    const saleSent = sent(cp, "createLocalSale");
    await form.getByRole("button", { name: "Record sale" }).click();
    expect((await saleSent).postDataJSON().customerId).toBe(custId);
    await expect(toast(cp)).toContainText("Local sale recorded — ");
    await expect(cp.locator("#localSaleForm")).toHaveCount(0);
    await waitIdle(cp);
    const linked = (await api("getOrders", { org: shop.orgId })).orders.filter(o => o.customerId === custId).map(o => o.orderId);
    expect(linked).toHaveLength(2);
    expect(linked).toContain(orderId);

    // -- The owner takes Customers away again (the role is as it was made), and everything goes with it.
    await rolesTab();
    await expect(customersSwitch).toBeChecked();
    await expect(page.locator(`input[name="perm-${FN}"][value="read"]`)).toBeChecked();
    await customersSwitch.uncheck();
    await expect(page.locator(`input[name="perm-${FN}"]`)).toHaveCount(0);
    await page.getByRole("button", { name: "Save role" }).click();
    await expect(toast(page)).toContainText("Role saved. It applies at once to everyone who has it.");
    expect(await storedLevel()).toBe("none");
    await withoutCustomers("with Customers taken away");
    await pagesWithout();

    // Nothing the refused requests carried was written.
    expect(await stored(api, custId)).toEqual(before);
    expect((await customerOf(api, custId)).id).toBe(custId);
    expect((await orderOf(api, shop, orderId)).customerId).toBe(custId);
    expect((await api("listCustomers", { q: "Never Made " + tag, includeArchived: true })).total).toBe(0);
  } finally {
    if (ctx) await ctx.dispose();
    if (userId) {
      await api("setRole", { id: userId, role: "production" }, { ...USERS, allowError: true });
      await api("setStatus", { id: userId, status: "disabled" }, { ...USERS, allowError: true });
    }
    await api("deleteRole", { roleKey: role.key }, { ...USERS, allowError: true });
    expect((await api("listRoles", {}, USERS)).roles.filter(r => r.key === role.key), "this test's role is gone again").toEqual([]);
  }
});
