// Quotes (migrations/0109, "estimates" in code): what each role may do with them (quotes.estimates in
// functions/_lib/permissions.js; the checks in functions/api/orders.js; the page in public/admin-quotes.js, the top
// button and route in public/admin.js, the customer's Quotes section in public/admin-customers.js).
//   - Manager (Full): the Quotes button right after Customers; makes, fills, saves, sends, converts and cancels.
//   - Back office (Edit): the same but Cancel quote, which isn't offered and which the server refuses.
//   - Read only (Read): the list and a quote to read, nothing to change, and the server refuses each write.
//   - Production (none): no button, no page, no Quotes on a customer, and the server refuses even the list.
//   - A role with Quotes at Edit but not what a step also needs: picking the customer (Customers), a typed price
//     (Payments), making the order (Order details at Edit) and emailing its invoice (Invoices).
// The Quotes feature switch is tested in gap-quotes-switch.spec.mjs, which runs after every other spec.
// Every shop, customer, quote and role here is this file's own.
import crypto from "node:crypto";
import { request as playwrightRequest } from "@playwright/test";
import { test, expect, ADMIN, shopUrl, openAdmin, toast, confirmDialog, signInThroughPage, callApi, apiContext, freshIp, slug, uniq } from "../fixtures.mjs";
import { makeShop } from "../lib/data.mjs";

// ---- helpers ---------------------------------------------------------------------------------------------
const USERS = { path: "/api/admin-users" };
const FN = "quotes.estimates";
const NO_ROLE = "Your role can't do this. Ask an admin.";
const FEATURE_OFF = "Quotes is turned off. Turn it on under Settings → Global settings → Features.";
const FAR = "2099-12-31";   // an expiry no run of this suite reaches
const ACTIONS = ["listEstimates", "getEstimate", "createEstimate", "saveEstimate", "sendEstimate", "convertEstimate", "cancelEstimate"];

const nav = (page) => page.getByRole("navigation", { name: "Admin" });
const navBtn = (page) => nav(page).locator('.admin-nav-row > button[data-h="quotes"]');
const topButtons = (page) => nav(page).locator(".admin-nav-row > button[data-h]").evaluateAll(els => els.map(e => e.dataset.h));
const anEmail = () => slug("qr") + "@example.test";
const tryApi = (ctx, action, body) => callApi(ctx, action, body, { allowError: true, withStatus: true });
const refused = (r, message, what) => {
  expect(r.status, what + " is refused").toBe(403);
  expect(r.data.status, what).toBe("error");
  expect(r.data.message, what).toBe(message);
};
const ok200 = (r, what) => {
  expect(r.status, what + ": " + JSON.stringify(r.data)).toBe(200);
  expect(r.data.status, what).toBe("ok");
};

const makeCustomer = async (api, fields = {}) => (await api("saveCustomer", { name: uniq("Pat Example"), email: anEmail(), ...fields })).id;
// A quote made through the owner's session, with a $10 × 2 custom line: { id, number }.
const makeQuote = async (api, shop, customerId, title = uniq("Team shirts")) => {
  const made = await api("createEstimate", { org: shop.orgId, customerId, title, expiresOn: FAR });
  await api("saveEstimate", { id: made.id, items: [{ kind: "custom", name: "Embroidered patch", qty: 2, unitPrice: 10, taxable: true }] });
  return { id: made.id, number: made.number, title };
};
const sendQuote = async (api, id) => (await api("sendEstimate", { id, email: anEmail() })).link;
const quoteOf = async (api, id) => (await api("getEstimate", { id })).estimate;
const tokenOf = (link) => /[?&]estimate=([0-9a-f]{32})$/.exec(link)[1];

// The request each action takes, for a quote `q` (a draft with lines) of customer `customerId` in `shop`.
const bodies = (shop, customerId, q) => ({
  listEstimates: {},
  getEstimate: { id: q.id },
  createEstimate: { org: shop.orgId, customerId, title: "Never made" },
  saveEstimate: { id: q.id, title: "Changed by someone who may not", items: [{ kind: "custom", name: "Never saved", qty: 1, unitPrice: 1, taxable: true }] },
  sendEstimate: { id: q.id, email: "pat@example.com" },
  convertEstimate: { id: q.id },
  cancelEstimate: { id: q.id },
});

const openQuote = async (page, id) => {
  await openAdmin(page, "quotes/" + id);
  await expect(page.locator("#qtForm")).toBeVisible();
};
const listShown = async (page) => {
  await expect(page).toHaveTitle(/ — Quotes \(Admin\)$/);
  await expect(page.locator("#qtPage #qtQ")).toBeVisible();
};
const statusTag = (page) => page.locator("#qtPage h2.cust-name .qt-st");
const notAvailable = async (page, roleName) => {
  await expect(page.locator("#roleOffPanel")).toContainText("Not available to you.");
  await expect(page.locator("#roleOffPanel")).toContainText(`Your role (${roleName}) doesn't include this page.`);
};
const quotesHeading = (page) => page.locator("#custPage h3.cust-h", { hasText: /^Quotes$/ });

// + New quote (or the customer page's button, which arrives with `customerName` picked): a quote in `shop`.
// Returns { id, number }.
async function fillNewQuote(page, shop, customerName, title, { picked = false } = {}) {
  const form = page.locator("#qtNewForm");
  await expect(form).toBeVisible();
  if (!picked) {
    await expect(form.locator("#qtNewSave")).toBeVisible();
    await form.locator("#qtNewCust").fill(customerName);
    await form.locator("#qtNewCustList button", { hasText: customerName }).click();
  }
  await expect(form.locator("#qtNewPickedText")).toHaveText(new RegExp("^For " + customerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  // The shop list is there whenever the install has more than one shop (other files' shops count).
  if (await form.locator("#qtNewShop").count()) await form.locator("#qtNewShop").selectOption(shop.orgId);
  await form.locator("#qtNewTitle").fill(title);
  await form.locator("#qtNewExpires").fill(FAR);
  await form.locator("#qtNewSave").click();
  await expect(toast(page)).toContainText(/Quote Q-\d{5} started\./);
  await expect(page).toHaveURL(/#quotes\/\d+$/);
  await expect(page.locator("#qtForm")).toBeVisible();
  const id = Number(/#quotes\/(\d+)$/.exec(page.url())[1]);
  const number = (await page.locator("#qtPage h2.cust-name").textContent()).match(/Q-\d{5}/)[0];
  return { id, number };
}
async function addFee(page, feeKind, name, amount) {
  await page.locator("#qtAddFee").click();
  const f = page.locator("#qtOtherForm");
  await f.locator("#qtOtherKind").selectOption(feeKind);
  await f.locator("#qtOtherName").fill(name);
  await f.locator("#qtOtherPrice").fill(amount);
  await f.locator("#qtOtherSave").click();
  await expect(f).toHaveCount(0);
}
async function addCustom(page, name, qty, price) {
  await page.locator("#qtAddCustom").click();
  const f = page.locator("#qtOtherForm");
  await f.locator("#qtOtherName").fill(name);
  await f.locator("#qtOtherQty").fill(qty);
  await f.locator("#qtOtherPrice").fill(price);
  await f.locator("#qtOtherSave").click();
  await expect(f).toHaveCount(0);
}
// Send… through the page. The suite's install sends no email, so the window shows the link instead: its token.
async function sendInPage(page, shop, email) {
  await page.locator("#qtSend").click();
  const f = page.locator("#qtSendForm");
  await f.locator("#qtSendEmail").fill(email);
  await f.locator("#qtSendGo").click();
  await expect(f.locator("#qtSendLinkNote")).toContainText("The quote is marked sent, but the email couldn't be sent.");
  const link = await f.locator("#qtSendLink").inputValue();
  expect(link).toMatch(new RegExp("^https://" + shop.subdomain + "\\.localhost/\\?estimate=[0-9a-f]{32}$"));
  await f.locator("#qtSendGo").click();   // now "Done"
  await expect(f).toHaveCount(0);
  await expect(statusTag(page)).toHaveText("Sent");
  await expect(page.locator("#qtSend")).toHaveText("Send again…");
  return tokenOf(link);
}

// ---- Manager: everything -----------------------------------------------------------------------------------
test("Manager: the Quotes button after Customers; makes, fills, saves, sends, converts and cancels quotes in the page", async ({ api, as }) => {
  const shop = await makeShop(api, { prefix: "qrm", products: [{ name: "Sample Tee", price: 20 }] });
  const custName = uniq("Morgan Quoted");
  const custId = await makeCustomer(api, { name: custName });

  const mp = await as("manager");
  await openAdmin(mp, "home");
  await expect(navBtn(mp)).toBeVisible();
  await expect(navBtn(mp)).toHaveText("Quotes");
  const tops = await topButtons(mp);
  expect(tops.indexOf("quotes"), "Quotes sits right after Customers").toBe(tops.indexOf("customers") + 1);
  await navBtn(mp).click();
  await expect(mp).toHaveURL(/#quotes$/);
  await listShown(mp);

  // + New quote, then a fee and a product line, each saved as it is added.
  await expect(mp.locator("#qtNew")).toBeVisible();
  await mp.locator("#qtNew").click();
  const q = await fillNewQuote(mp, shop, custName, uniq("Club polos"));
  await expect(statusTag(mp)).toHaveText("Draft");
  await addFee(mp, "setup", "Left chest logo", "25");
  await mp.locator("#qtAddProduct").click();
  const pf = mp.locator("#qtProdForm");
  await pf.locator("#qtProd").selectOption(shop.products[0].productId);
  await pf.locator("#qtProdQty").fill("3");
  await expect(pf.locator("#qtProdOwn"), "a Manager may type a price").toBeVisible();
  await pf.locator("#qtProdSave").click();
  await expect(pf).toHaveCount(0);
  await expect(mp.locator("#qtLines")).toContainText("Setup fee — Left chest logo");
  await expect(mp.locator("#qtLines")).toContainText("Sample Tee");
  await expect(mp.locator("#qtTotals .qt-sum-total")).toContainText("$85.00");

  // Save.
  await mp.locator("#qtInternal").fill("Collar tag left in.");
  await mp.locator("#qtSave").click();
  await expect(toast(mp)).toContainText("Quote saved.");
  let got = await api("getEstimate", { id: q.id });
  expect(got.estimate).toMatchObject({ status: "draft", customerId: custId, orgId: shop.orgId, internalNote: "Collar tag left in.", expiresOn: FAR });
  expect(got.items.map(i => i.kind).sort()).toEqual(["fee", "product"]);
  expect(got.totals.total).toBe(85);

  // Send…: the link is shown, as this install has no email.
  const token = await sendInPage(mp, shop, anEmail());
  got = await api("getEstimate", { id: q.id });
  expect(got.estimate.status).toBe("sent");
  expect(got.estimate.token).toBe(token);
  // Sent: the lines are fixed, the fields can still be saved.
  await expect(mp.locator("#qtAddProduct")).toHaveCount(0);
  await expect(mp.locator("#qtSave")).toBeVisible();

  // Convert to order…, with the box for emailing the invoice (the Manager may send invoices).
  await mp.locator("#qtConvert").click();
  const cf = mp.locator("#qtConvForm");
  await expect(cf).toContainText(`An order is recorded for ${custName}`);
  await expect(cf.locator("#qtConvInvoice")).toBeVisible();
  await expect(cf.locator("#qtConvInvoice")).toBeChecked();
  await cf.locator("#qtConvInvoice").uncheck();
  const conv = mp.waitForRequest(r => r.url().endsWith("/api/orders") && (r.postDataJSON() || {}).action === "convertEstimate");
  await cf.locator("#qtConvGo").click();
  expect((await conv).postDataJSON()).toMatchObject({ id: q.id, sendInvoice: false });
  await expect(toast(mp)).toContainText(new RegExp(`Order \\S+ made from quote ${q.number}\\.`));
  await expect(statusTag(mp)).toHaveText("Converted");
  got = await api("getEstimate", { id: q.id });
  const orderId = got.estimate.orderId;
  expect(orderId).toBe(shop.orgId.slice(0, 4).toUpperCase() + "-" + q.number.replace(/[^A-Za-z0-9]/g, ""));
  await expect(mp.locator("#qtOrderLink")).toHaveText(orderId);
  for (const b of ["#qtSend", "#qtConvert", "#qtCancel", "#qtSave"]) await expect(mp.locator(b), b + " is gone once converted").toHaveCount(0);
  const order = (await api("getOrders", { org: shop.orgId })).orders.find(o => o.orderId === orderId);
  expect(order.customerId).toBe(custId);
  expect(order.estimate).toMatchObject({ id: q.id, number: q.number });

  // The order on the Orders page links back to its quote, for a role that may open Quotes.
  await openAdmin(mp, "orders/" + shop.orgId);
  await expect(mp.locator(`tr[data-order="${orderId}"] a.order-estimate-link`).first()).toHaveAttribute("href", "#/quotes/" + q.id);

  // Cancel quote… on another one: asked first, then the quote is closed.
  const other = await makeQuote(api, shop, custId);
  await openQuote(mp, other.id);
  await expect(mp.locator("#qtCancel")).toBeVisible();
  await mp.locator("#qtCancel").click();
  await expect(mp.getByRole("dialog").last()).toContainText(`Cancel quote ${other.number}?`);
  await confirmDialog(mp);
  await expect(toast(mp)).toContainText(`Quote ${other.number} cancelled.`);
  await expect(statusTag(mp)).toHaveText("Cancelled");
  await expect(mp.locator("#qtPage")).toContainText("The customer's link no longer accepts it.");
  for (const b of ["#qtSend", "#qtConvert", "#qtCancel", "#qtSave"]) await expect(mp.locator(b), b + " is gone once cancelled").toHaveCount(0);
  await expect(mp.locator("#qtTitle")).toBeDisabled();
  expect((await quoteOf(api, other.id)).status).toBe("cancelled");
});

// ---- Back office: Edit -------------------------------------------------------------------------------------
test("Back office: starts a quote from the customer's page, fills, saves, sends and converts it; Cancel quote isn't offered and the server refuses it", async ({ api, as }, testInfo) => {
  const shop = await makeShop(api, { prefix: "qrb", products: [{ name: "Sample Tee", price: 20 }] });
  const custName = uniq("Blake Quoted");
  const custId = await makeCustomer(api, { name: custName });

  const sp = await as("staff");
  await openAdmin(sp, "home");
  await expect(navBtn(sp)).toBeVisible();
  await navBtn(sp).click();
  await listShown(sp);
  await expect(sp.locator("#qtNew")).toBeVisible();

  // The customer's page: its Quotes section and "New quote for this customer", which arrives with them picked.
  await openAdmin(sp, "customers/" + custId);
  await expect(quotesHeading(sp)).toBeVisible();
  await expect(sp.locator("#custPage")).toContainText("No quotes yet.");
  await expect(sp.locator("#custNewQuote")).toBeVisible();
  await sp.locator("#custNewQuote").click();
  const q = await fillNewQuote(sp, shop, custName, uniq("Away kit"), { picked: true });
  await expect(sp.locator("#qtCancel"), "Cancel quote is Full's").toBeHidden();
  await expect(sp.locator("#qtSend")).toBeVisible();
  await expect(sp.locator("#qtConvert")).toBeVisible();

  await addCustom(sp, "Embroidered patch", "10", "4.50");
  // Back office may type a price (it has Payments at Edit).
  await sp.locator("#qtAddProduct").click();
  const pf = sp.locator("#qtProdForm");
  await pf.locator("#qtProd").selectOption(shop.products[0].productId);
  await pf.locator("#qtProdQty").fill("2");
  await pf.locator("#qtProdOwn").check();
  await pf.locator("#qtProdOwnPrice").fill("15");
  await pf.locator("#qtProdSave").click();
  await expect(pf).toHaveCount(0);
  await expect(sp.locator("#qtLines")).toContainText("Price set by hand");
  await expect(sp.locator("#qtTotals .qt-sum-total")).toContainText("$75.00");
  await sp.locator("#qtMessage").fill("Thanks for asking us.");
  await sp.locator("#qtSave").click();
  await expect(toast(sp)).toContainText("Quote saved.");
  let got = await api("getEstimate", { id: q.id });
  expect(got.estimate).toMatchObject({ status: "draft", message: "Thanks for asking us.", createdBy: expect.any(String) });
  expect(got.items.find(i => i.kind === "product")).toMatchObject({ customPrice: true, unitPrice: 15, qty: 2 });
  expect(got.totals.total).toBe(75);

  await sendInPage(sp, shop, anEmail());
  expect((await quoteOf(api, q.id)).status).toBe("sent");
  await expect(sp.locator("#qtCancel")).toBeHidden();

  await sp.locator("#qtConvert").click();
  const cf = sp.locator("#qtConvForm");
  await expect(cf.locator("#qtConvInvoice"), "Back office may send invoices").toBeVisible();
  await cf.locator("#qtConvInvoice").uncheck();
  await cf.locator("#qtConvGo").click();
  await expect(toast(sp)).toContainText(new RegExp(`made from quote ${q.number}\\.`));
  await expect(statusTag(sp)).toHaveText("Converted");
  const orderId = (await quoteOf(api, q.id)).orderId;
  expect((await api("getOrders", { org: shop.orgId })).orders.find(o => o.orderId === orderId).customerId).toBe(custId);

  // The server: Back office's session cancels nothing; everything else it may do goes through.
  const draft = await makeQuote(api, shop, custId);
  const staff = await apiContext("staff", testInfo.workerIndex);
  try {
    refused(await tryApi(staff, "cancelEstimate", { id: draft.id }), NO_ROLE, "cancelEstimate");
    expect((await quoteOf(api, draft.id)).status).toBe("draft");
    let r = await tryApi(staff, "listEstimates", { customerId: custId });
    ok200(r, "listEstimates");
    expect(r.data.estimates.map(e => e.id).sort()).toEqual([q.id, draft.id].sort());
    ok200(await tryApi(staff, "getEstimate", { id: draft.id }), "getEstimate");
    r = await tryApi(staff, "createEstimate", { org: shop.orgId, customerId: custId, title: "Made by Back office" });
    ok200(r, "createEstimate");
    expect(r.data.number).toMatch(/^Q-\d{5}$/);
    ok200(await tryApi(staff, "saveEstimate", { id: r.data.id, items: [{ kind: "product", productId: shop.products[0].productId, size: "OSFA", qty: 1, customUnitPrice: 12 }] }), "saveEstimate with a typed price");
    ok200(await tryApi(staff, "sendEstimate", { id: r.data.id, email: anEmail() }), "sendEstimate");
    r = await tryApi(staff, "convertEstimate", { id: r.data.id, sendInvoice: false });
    ok200(r, "convertEstimate");
    expect(r.data.orderId).toBeTruthy();
  } finally {
    await staff.dispose();
  }
});

// ---- Read only: Read -----------------------------------------------------------------------------------------
test("Read only: opens the list and a quote to read; no New, Save, Send, Convert or Cancel, and the server refuses each write", async ({ api, as }, testInfo) => {
  // The suite's setup gives its Read only role Read on every function the server lists, this one included.
  const mine = (await api("listRoles", {}, USERS)).roles.find(r => r.name === "Read only");
  expect(mine.permissions.fns[FN]).toBe("read");
  const shop = await makeShop(api, { prefix: "qrr", products: [{ name: "Sample Tee", price: 20 }] });
  const custName = uniq("Robin Reader");
  const custId = await makeCustomer(api, { name: custName });
  const q = await makeQuote(api, shop, custId);
  const sent = await makeQuote(api, shop, custId);
  await sendQuote(api, sent.id);
  const before = await api("getEstimate", { id: q.id });

  const vp = await as("viewer");
  await openAdmin(vp, "home");
  await expect(navBtn(vp)).toBeVisible();
  await navBtn(vp).click();
  await listShown(vp);
  await expect(vp.locator("#qtNew")).toBeHidden();
  await vp.locator("#qtQ").fill(q.number);
  const row = vp.locator(`tr[data-qt-id="${q.id}"]`);
  await expect(row).toBeVisible();
  await expect(row).toContainText(custName);
  await expect(row).toContainText("$20.00");
  await row.locator("a.cust-link").click();
  await expect(vp).toHaveURL(new RegExp("#quotes/" + q.id + "$"));
  await expect(vp.locator("#qtForm")).toBeVisible();
  await expect(vp.locator("#qtLines")).toContainText("Embroidered patch");
  for (const f of ["#qtTitle", "#qtExpires", "#qtMessage", "#qtInternal"]) await expect(vp.locator(f), f + " is read-only").toBeDisabled();
  for (const b of ["#qtSave", "#qtAddProduct", "#qtAddCustom", "#qtAddFee", "#qtConvert", "[data-qt-remove]", "input[data-qt-qty]"]) {
    await expect(vp.locator(b), b + " isn't offered").toHaveCount(0);
  }
  await expect(vp.locator("#qtSend")).toBeHidden();
  await expect(vp.locator("#qtCancel")).toBeHidden();
  // The customer's name opens their record (Read only may open Customers).
  await expect(vp.locator(`#qtPage .cust-sub a.cust-link[href="#customers/${custId}"]`)).toBeVisible();

  // The customer's page lists both quotes, with no New quote button.
  await openAdmin(vp, "customers/" + custId);
  await expect(quotesHeading(vp)).toBeVisible();
  await expect(vp.locator(`#custPage a.cust-link[href="#quotes/${q.id}"]`)).toHaveText(q.number);
  await expect(vp.locator(`#custPage a.cust-link[href="#quotes/${sent.id}"]`)).toHaveText(sent.number);
  await expect(vp.locator("#custNewQuote")).toBeHidden();

  // The server: reads answer, every write is refused and nothing changes.
  const ctx = await apiContext("viewer", testInfo.workerIndex);
  try {
    const b = bodies(shop, custId, q);
    let r = await tryApi(ctx, "listEstimates", { customerId: custId });
    ok200(r, "listEstimates");
    expect(r.data.estimates.map(e => e.id).sort()).toEqual([q.id, sent.id].sort());
    r = await tryApi(ctx, "getEstimate", { id: q.id });
    ok200(r, "getEstimate");
    expect(r.data.estimate.number).toBe(q.number);
    for (const a of ["createEstimate", "saveEstimate", "sendEstimate", "convertEstimate", "cancelEstimate"]) refused(await tryApi(ctx, a, b[a]), NO_ROLE, a);
    refused(await tryApi(ctx, "saveEstimate", { id: sent.id, internalNote: "Not mine to write" }), NO_ROLE, "saveEstimate on a sent quote");
  } finally {
    await ctx.dispose();
  }
  const after = await api("getEstimate", { id: q.id });
  expect(after.estimate).toMatchObject({ status: "draft", title: before.estimate.title, orderId: "" });
  expect(after.items).toEqual(before.items);
  expect((await quoteOf(api, sent.id)).status).toBe("sent");
  expect((await api("listEstimates", { customerId: custId })).total).toBe(2);
});

// ---- Production: none ------------------------------------------------------------------------------------------
test("Production: no Quotes button, page or customer section; an order's quote is plain text; the server refuses every quote action", async ({ api, as }, testInfo) => {
  const shop = await makeShop(api, { prefix: "qrp", products: [{ name: "Sample Tee", price: 20 }] });
  const custId = await makeCustomer(api);
  const q = await makeQuote(api, shop, custId);
  const converted = await makeQuote(api, shop, custId);
  const { orderId } = await api("convertEstimate", { id: converted.id });
  const before = await api("getEstimate", { id: q.id });

  const pp = await as("production");
  await openAdmin(pp, "home");
  await expect(nav(pp)).toBeVisible();
  const tops = await topButtons(pp);
  expect(tops).toContain("customers");
  expect(tops).not.toContain("quotes");
  await expect(nav(pp).locator('[data-h="quotes"]')).toHaveCount(0);
  await openAdmin(pp, "quotes");
  await notAvailable(pp, "Production");
  await expect(pp.locator("#qtPage")).toHaveCount(0);
  await openAdmin(pp, "quotes/" + q.id);
  await notAvailable(pp, "Production");
  await expect(pp.locator("#qtForm")).toHaveCount(0);
  // The customer's page (Production reads Customers) has no Quotes section.
  await openAdmin(pp, "customers/" + custId);
  await expect(pp.locator("#custForm")).toBeVisible();
  await expect(quotesHeading(pp)).toHaveCount(0);
  await expect(pp.locator("#custNewQuote")).toHaveCount(0);
  // The order made from a quote says so, without a link to a page Production can't open.
  await openAdmin(pp, "orders/" + shop.orgId);
  const pill = pp.locator(`tr[data-order="${orderId}"] .order-estimate-link`).first();
  await expect(pill).toHaveText("From quote " + converted.number);
  await expect(pill).not.toHaveAttribute("href", /.*/);

  const ctx = await apiContext("production", testInfo.workerIndex);
  try {
    const b = bodies(shop, custId, q);
    for (const a of ACTIONS) refused(await tryApi(ctx, a, b[a]), NO_ROLE, a);
  } finally {
    await ctx.dispose();
  }
  const after = await api("getEstimate", { id: q.id });
  expect(after.estimate).toMatchObject({ status: "draft", title: before.estimate.title });
  expect(after.items).toEqual(before.items);
});

// ---- A custom role: Quotes at Edit without what some steps also need ------------------------------------------
const strongPassword = () => "Desk-" + crypto.randomBytes(15).toString("base64url");
const client = (workerIndex) => playwrightRequest.newContext({ baseURL: ADMIN, extraHTTPHeaders: { Origin: ADMIN, "CF-Connecting-IP": freshIp(workerIndex) } });

test("A role with Quotes at Edit still needs Customers to start a quote, Payments for a typed price, Order details at Edit to convert and Invoices to email the invoice", async ({ page, api, as }, testInfo) => {
  test.setTimeout(120_000);
  const roleName = "Quoter " + slug("q").slice(-6);
  const base = { "home.counts": "read", "orders.details": "read", "catalog.products": "read", [FN]: "edit" };
  const role = (await api("saveRole", { name: roleName, rank: 20, permissions: { fns: base } }, USERS)).role;
  let userId = null, ctx = null;
  try {
    expect(role.permissions.fns[FN]).toBe("edit");
    expect(role.permissions.fns["customers.records"] || "none").toBe("none");
    const tag = slug("qu");
    const who = { email: tag + "@example.test", password: strongPassword() };
    const made = await api("create", { name: "Quinn Quoter " + tag.slice(-4), email: who.email, role: role.key }, USERS);
    userId = made.user.id;
    ctx = await client(testInfo.workerIndex);
    let res = await ctx.post("/api/admin-session", { data: { email: who.email, key: made.temporaryPassword } });
    expect((await res.json()).pending).toBe("password");
    res = await ctx.post("/api/admin-password", { data: { action: "change", current: made.temporaryPassword, next: who.password } });
    expect((await res.json()).status).toBe("ok");
    res = await ctx.post("/api/admin-session", { data: { email: who.email, key: who.password } });
    expect(res.status()).toBe(200);

    const shop = await makeShop(api, { prefix: "qrc", products: [{ name: "Sample Tee", price: 20 }] });
    const custName = uniq("Casey Quoted");
    const custId = await makeCustomer(api, { name: custName });
    const q = await makeQuote(api, shop, custId);

    // -- The server, without Customers, Payments, Order details at Edit or Invoices.
    refused(await tryApi(ctx, "createEstimate", { org: shop.orgId, customerId: custId, title: "Never made " + tag }),
      "Your role can't pick a customer for a quote. Ask an admin.", "createEstimate without Customers");
    expect((await api("listEstimates", { q: "Never made " + tag })).total).toBe(0);
    const typed = [{ kind: "product", productId: shop.products[0].productId, size: "OSFA", qty: 2, customUnitPrice: 1 }];
    refused(await tryApi(ctx, "saveEstimate", { id: q.id, items: typed }), "Your role can't set a custom price. Ask an admin.", "a typed price without Payments");
    expect((await api("getEstimate", { id: q.id })).items.map(i => i.kind)).toEqual(["custom"]);
    // The same line at the catalog's price is this role's to save.
    let r = await tryApi(ctx, "saveEstimate", { id: q.id, items: [{ kind: "custom", name: "Embroidered patch", qty: 2, unitPrice: 10, taxable: true },
      { kind: "product", productId: shop.products[0].productId, size: "OSFA", qty: 2 }] });
    ok200(r, "saveEstimate at the catalog's price");
    expect(r.data.totals.total).toBe(60);
    refused(await tryApi(ctx, "convertEstimate", { id: q.id }), "Your role can't make orders. Ask an admin.", "convertEstimate without Order details at Edit");
    refused(await tryApi(ctx, "cancelEstimate", { id: q.id }), NO_ROLE, "cancelEstimate at Edit");
    expect((await quoteOf(api, q.id))).toMatchObject({ status: "draft", orderId: "" });

    // -- The pages.
    const cp = await as(null);
    await cp.goto(ADMIN + "/#quotes");
    await signInThroughPage(cp, who);
    await expect(nav(cp)).toBeVisible();
    await openAdmin(cp, "home");
    let tops = await topButtons(cp);
    expect(tops).not.toContain("customers");
    expect(tops.indexOf("quotes"), "without Customers, Quotes sits where Customers would").toBe(tops.indexOf("orders") + 1);
    await navBtn(cp).click();
    await listShown(cp);
    await cp.locator("#qtNew").click();
    await expect(toast(cp)).toContainText("Your role can't pick a customer, so it can't start a quote. Ask an admin.");
    await expect(cp.locator("#qtNewForm")).toHaveCount(0);
    await openQuote(cp, q.id);
    // The customer's name is plain text (no Customers page to open), and there is no Convert or Cancel.
    await expect(cp.locator("#qtPage .cust-sub").first()).toContainText("For " + custName);
    await expect(cp.locator('#qtPage .cust-sub a[href^="#customers/"]')).toHaveCount(0);
    await expect(cp.locator("#qtConvert")).toHaveCount(0);
    await expect(cp.locator("#qtCancel")).toBeHidden();
    await expect(cp.locator("#qtSend")).toBeVisible();
    await expect(cp.locator("#qtSave")).toBeVisible();
    // A product line has no typed price.
    await cp.locator("#qtAddProduct").click();
    await expect(cp.locator("#qtProdForm")).toBeVisible();
    await expect(cp.locator("#qtProdForm #qtProdOwn")).toHaveCount(0);
    await cp.locator("#qtProdForm #qtProdQty").fill("1");
    await cp.locator("#qtProdForm #qtProdSave").click();
    await expect(cp.locator("#qtProdForm")).toHaveCount(0);
    await expect(cp.locator("#qtTotals .qt-sum-total")).toContainText("$80.00");

    // -- The owner gives the role Order details at Edit and Customers at Read (not Invoices).
    await api("saveRole", { roleKey: role.key, name: roleName, rank: 20, permissions: { fns: { ...base, "orders.details": "edit", "customers.records": "read" } } }, USERS);
    refused(await tryApi(ctx, "convertEstimate", { id: q.id, sendInvoice: true }), "Your role can't send invoices. Ask an admin.", "convertEstimate emailing the invoice without Invoices");
    expect((await quoteOf(api, q.id)).status).toBe("draft");
    r = await tryApi(ctx, "createEstimate", { org: shop.orgId, customerId: custId, title: "Made with Customers " + tag });
    ok200(r, "createEstimate with Customers at Read");

    await openQuote(cp, q.id);
    tops = await topButtons(cp);
    expect(tops.indexOf("quotes"), "with Customers, Quotes sits right after it").toBe(tops.indexOf("customers") + 1);
    await expect(cp.locator(`#qtPage .cust-sub a.cust-link[href="#customers/${custId}"]`)).toBeVisible();
    await expect(cp.locator("#qtConvert")).toBeVisible();
    await cp.locator("#qtConvert").click();
    const cf = cp.locator("#qtConvForm");
    await expect(cf).toBeVisible();
    await expect(cf.locator("#qtConvInvoice"), "no invoice box without Invoices").toHaveCount(0);
    const conv = cp.waitForRequest(r => r.url().endsWith("/api/orders") && (r.postDataJSON() || {}).action === "convertEstimate");
    await cf.locator("#qtConvGo").click();
    expect((await conv).postDataJSON().sendInvoice).toBe(false);
    await expect(toast(cp)).toContainText(new RegExp(`made from quote ${q.number}\\.`));
    await expect(statusTag(cp)).toHaveText("Converted");
    const got = await quoteOf(api, q.id);
    expect(got.status).toBe("converted");
    expect((await api("getOrders", { org: shop.orgId })).orders.find(o => o.orderId === got.orderId).customerId).toBe(custId);
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
