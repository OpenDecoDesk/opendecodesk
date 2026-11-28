// Net 30 with a PO (migrations/0121) end to end as the owner, in a real browser:
//   - off until Global settings → Payment methods ticks it: no Net 30… button, no Local sale option, nothing at the
//     shop's checkout, and the server refuses every way in;
//   - Global settings: "Net 30 (with a PO)" ticked and the Net 30 terms (default days, Terms start) saved through the
//     page, with the page's own check and the server's;
//   - a customer allowed Net 30 with 45 days on their own page;
//   - a Local sale on Net 30 without a PO: "PO needed", no steps, not on the Run order, the server refuses its steps;
//     the PO added in its Net 30… window clears it for work (Run order, steps, Mark completed) while it stays owed;
//   - the shop's checkout: the allowed customer's email offers "Net 30 (pay by invoice)", a typed PO arrives as
//     "PO to check" and Accept PO clears it; an unknown email (or a customer not allowed) never sees it, and the server
//     refuses Net 30 for it even when the page is made to offer it;
//   - the invoice page shows the terms and takes the customer's PO, which staff then accept;
//   - Terms start switched between the invoice, the order date and the order completed (shipped) moves the due date:
//     in the order's Net 30… window, its Orders tag, the invoice page and the Unpaid POs report (as of fixed days).
//
// Dates: the install's business time zone is UTC (checked, e2e/README.md), the browser runs in UTC, and every due date
// is worked out from the server's own timestamps or from fixed days set on the order (Oct 2026), never from this
// computer's clock. The report is read "as of" fixed days.
//
// This spec changes install-wide settings (Global settings → Payment methods' Net 30 and the Net 30 terms), so it is in
// ALONE in e2e/playwright.config.mjs and puts both back at the end. Its shops, customers and orders are its own.
import { test, expect, ADMIN, openAdmin, leaveAdmin, toast, uniq, slug, shopUrl, apiContext, callApi, waitIdle } from "../fixtures.mjs";
import { makeShop } from "../lib/data.mjs";

test.describe.configure({ mode: "serial" });
test.use({ timezoneId: "UTC", locale: "en-US" });

const NET30_OFF = "Net 30 isn't switched on for this shop (Global settings and Shop settings → Payment methods).";
const NOT_AVAILABLE = "Net 30 isn't available for this order.";
const TAG = slug("n").slice(-6);

// ---- what the tests share ------------------------------------------------------------------------------
let ownerCtx = null, before = null;
const S = {};

// ---- helpers ---------------------------------------------------------------------------------------------
const actionOf = (req) => { try { return JSON.parse(req.postData() || "{}").action; } catch (e) { return ""; } };
const answerOf = (page, action) => page.waitForResponse(r => /\/api\/orders$/.test(r.url()) && actionOf(r.request()) === action);
const tryApi = (api, action, body) => api(action, body, { allowError: true, withStatus: true });
const orderOf = async (api, shop, orderId) => (await api("getOrders", { org: shop.orgId })).orders.find(o => o.orderId === orderId);
const auditOf = async (api, orderId, action) => ((await api("getAuditLog", { orderId, filter: action, limit: 50 })).entries || []).filter(e => e.action === action);
const report = (api, body) => api("getUnpaidPoReport", body);
const reportRow = async (api, shop, orderId, asOf) => (await report(api, { orgId: shop.orgId, asOf })).rows.find(r => r.orderId === orderId);

// "2026-10-21" + n days, and how the pages write a day.
const addDays = (day, n) => new Date(Date.parse(day + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const utcDay = (iso) => new Date(iso).toISOString().slice(0, 10);   // the business zone is UTC (checked below)
const fmt = (day, opts) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...opts }).format(new Date(day + "T12:00:00Z"));
const longDay = (day) => fmt(day, { month: "short", day: "numeric", year: "numeric" });   // "Oct 21, 2026"
const shortDay = (day) => fmt(day, { month: "short", day: "numeric" });                   // "Oct 21"

// Global settings → Payment methods and → Net 30 terms, written as the owner (saveGlobalSettingsAll / updateTermsSettings).
const globalPayments = async (api) => ((await api("getGlobalSettings")).globalSettings || {}).enabledPayments || {};
const setNet30 = async (api, on) => api("saveGlobalSettingsAll", { settings: { payments: { ...(await globalPayments(api)), net30: on } } });
const termsOf = async (api) => (await api("getTermsSettings")).terms;
const setTermsApi = (api, terms) => api("updateTermsSettings", { terms });

// The Orders page of a shop; one order's row, its cells and buttons.
const ordersPage = async (page, shop) => {
  if (page.url().startsWith(ADMIN)) await leaveAdmin(page);
  await openAdmin(page, "orders/" + shop.orgId);
  await expect(page.getByRole("combobox", { name: "Shop" })).toHaveValue(shop.orgId);
};
// The same, with the list's From date moved back (it shows the last 30 days): for an order dated Oct 1, 2026.
const ordersPageFrom = async (page, shop, from) => {
  await ordersPage(page, shop);
  const box = page.getByRole("textbox", { name: "From" });
  await box.fill(from);
  await box.dispatchEvent("change");
  await waitIdle(page);
};
const orderRow = (page, orderId) => page.locator(`tr[data-order="${orderId}"]`).first();
const actionCell = (page, orderId) => orderRow(page, orderId).locator("td[data-action-td]");
const paidCell = (page, orderId) => orderRow(page, orderId).locator("td[data-paid-td]");
const n30Tag = (page, orderId) => orderRow(page, orderId).locator(".n30-tag");
const termsBtn = (page, orderId) => actionCell(page, orderId).getByRole("button", { name: "Net 30…", exact: true });
const acceptBtn = (page, orderId) => actionCell(page, orderId).getByRole("button", { name: "Accept PO", exact: true });
const stageSelect = (page, orderId) => actionCell(page, orderId).locator("select");
const confirmOk = async (page) => {
  const ok = page.locator(".confirm-modal #cmOk");
  await expect(ok).toBeVisible();
  await ok.click();
  await expect(page.locator(".confirm-modal")).toHaveCount(0);
};
// The order's Net 30… window.
const openTerms = async (page, orderId) => {
  await termsBtn(page, orderId).click();
  const dlg = page.locator(".admin-modal", { has: page.locator("[data-dialog-title]", { hasText: "Net 30 — " + orderId }) });
  await expect(dlg.locator("#n30Form")).toBeVisible();
  return dlg;
};
const openLocalSale = async (page, shop) => {
  await ordersPage(page, shop);
  await page.getByRole("button", { name: "+ Local sale" }).click();
  const form = page.locator("#localSaleForm");
  await expect(form).toBeVisible();
  return form;
};
// The order's steps up to QA and packed, then shipped, at the given times (as the Orders page's stage list sends them).
const stepsTo = async (api, shop, orderId, stages, at) => {
  for (const stage of stages) {
    const r = await tryApi(api, "setFulfillmentStage", { org: shop.orgId, orderId, stage, ...(at ? { at } : {}), ...(stage === "shipped" ? { trackingNumber: "E2E-N30-" + TAG } : {}) });
    if (r.status !== 200 && !(stage === "designApproved" || stage === "digitizingComplete")) throw new Error(stage + ": " + JSON.stringify(r.data));
  }
};

// The shop's page in a customer's own browser: the first product in the cart, a name typed.
const shopCheckout = async (as, shop) => {
  const cp = await as(null);
  await cp.goto(shopUrl(shop.subdomain) + "/");
  await expect(cp.getByRole("heading", { level: 1, name: shop.name })).toBeVisible();
  const card = cp.locator("main").getByRole("heading", { level: 3, name: shop.products[0].name, exact: true }).locator("xpath=ancestor::*[.//button[normalize-space()='Add to cart']][1]");
  await card.getByRole("button", { name: "Add to cart" }).click();
  await cp.getByLabel("Your name").fill(uniq("Pat Example"));
  return cp;
};
// Types an email at the checkout and waits for the page's checkNet30 question about it; its answer.
const typeEmail = async (cp, email) => {
  const asked = cp.waitForResponse(r => /\/api\/orders$/.test(r.url()) && actionOf(r.request()) === "checkNet30" && JSON.parse(r.request().postData()).email === email);
  await cp.getByLabel("Email address").fill(email);
  const res = await asked;
  return { status: res.status(), body: await res.json() };
};
const payOptions = (cp) => cp.getByLabel("Payment method").locator("option").allTextContents();
// Place order: the order's answer and what was sent.
const placeIt = async (cp) => {
  const saved = cp.waitForResponse(r => /\/api\/orders$/.test(r.url()) && r.request().method() === "POST" && !actionOf(r.request()));
  await cp.getByRole("button", { name: "Place order" }).click();
  const res = await saved;
  return { status: res.status(), body: await res.json(), sent: JSON.parse(res.request().postData()) };
};
// The customer's invoice page; its POST (setInvoicePo) sent from it.
const invoicePost = (cp, token, body) => cp.evaluate(async ({ token, body }) => {
  const r = await fetch("/api/invoice", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, ...body }) });
  return { status: r.status, body: await r.json() };
}, { token, body });

// ---- settings in and out --------------------------------------------------------------------------------
test.beforeAll(async () => {
  ownerCtx = await apiContext("owner");
  const api = (action, body, opts) => callApi(ownerCtx, action, body, opts);
  before = { payments: await globalPayments(api), terms: await termsOf(api) };
  // Start from the install's defaults: Net 30 off, 30 days from the invoice.
  await setNet30(api, false);
  await setTermsApi(api, { defaultDays: 30, startsAt: "invoice" });
});
test.afterAll(async () => {
  if (!ownerCtx) return;
  const api = (action, body, opts) => callApi(ownerCtx, action, body, opts);
  try {
    if (before) {
      await api("saveGlobalSettingsAll", { settings: { payments: { ...(await globalPayments(api)), net30: before.payments.net30 === true } } });
      await setTermsApi(api, before.terms);
    }
  } finally { await ownerCtx.dispose(); }
});

// =========================================================================================================
test("Net 30 is off until Global settings ticks it: no Net 30… button, no Local sale option, nothing at checkout, and the server refuses", async ({ page, api, as }) => {
  const me = await api("me", {}, { path: "/api/admin-users" });
  expect(me.timeZone, "the install's business time zone").toBe("UTC");
  expect((await globalPayments(api)).net30).toBe(false);
  S.shop = await makeShop(api, { prefix: "n30", products: [{ name: "Sample Tee", price: 20, extra: { noBlankNeeded: true, noDesignNeeded: true } }] });
  S.email = ("pat." + TAG + "@example.com").toLowerCase();
  S.customerId = (await api("saveCustomer", { name: "Pat Example " + TAG, company: "Example School District", email: S.email, phone: "", address: null, notes: "",
    taxExempt: false, taxExemptCertificate: "", taxExemptExpires: "", allowNet30: true, termsDays: 45 })).id;
  // An unpaid order (a Local sale left unpaid).
  const plain = (await api("createLocalSale", { org: S.shop.orgId, items: [{ productId: S.shop.products[0].productId, qty: 1 }], paymentMethod: "Check", customerName: uniq("Uma Unpaid") })).orderId;
  S.plain = plain;

  const list = await api("getOrders", { org: S.shop.orgId });
  expect(list.net30).toEqual({ allowed: false, defaultDays: 30 });
  await ordersPage(page, S.shop);
  await expect(actionCell(page, plain).getByRole("button", { name: "Mark as paid" })).toBeVisible();
  await expect(termsBtn(page, plain)).toHaveCount(0);
  await expect(n30Tag(page, plain)).toHaveCount(0);
  const form = await openLocalSale(page, S.shop);
  await expect(form.locator("#lsPayment option[value='Net 30']")).toHaveCount(0);
  await expect(form.locator("#lsNet30Wrap")).toHaveCount(0);
  await form.locator(".admin-pass-cancel").click();

  // The server: no Net 30 on an order or a sale while it's off.
  let r = await tryApi(api, "setOrderTerms", { org: S.shop.orgId, orderId: plain, net30: true });
  expect(r.status).toBe(409);
  expect(r.data.message).toBe(NET30_OFF);
  r = await tryApi(api, "createLocalSale", { org: S.shop.orgId, items: [{ productId: S.shop.products[0].productId, qty: 1 }], paymentMethod: "Net 30", customerName: uniq("Lane Localsale"), net30: true });
  expect(r.status).toBe(409);
  expect(r.data.message).toBe(NET30_OFF);
  expect((await orderOf(api, S.shop, plain)).net30).toBe(false);

  // The shop: the catalog says asking can't say yes, and the answer to asking is the plain no, even for the allowed
  // customer's email. The checkout doesn't ask.
  const cp = await shopCheckout(as, S.shop);
  const cat = await cp.evaluate(async () => (await (await fetch("/api/catalog", { cache: "no-store" })).json()));
  expect(cat.catalog.net30Offered).toBe(false);
  expect(cat.catalog.enabledPayments).not.toContain("Net 30");
  const asked = [];
  cp.on("request", req => { if (actionOf(req) === "checkNet30") asked.push(req); });
  await cp.getByLabel("Email address").fill(S.email);
  await cp.getByLabel("Your name").click();
  await cp.waitForTimeout(1000);   // past the page's 700 ms pause: nothing was asked
  expect(asked).toHaveLength(0);
  expect(await payOptions(cp)).not.toContain("Net 30 (pay by invoice)");
  const ans = await cp.evaluate(async ({ orgId, email }) => (await (await fetch("/api/orders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "checkNet30", orgId, email }) })).json()), { orgId: S.shop.orgId, email: S.email });
  expect(ans).toEqual({ status: "ok", ok: false });
});

// =========================================================================================================
test("Global settings: Net 30 (with a PO) ticked and its terms (default days, Terms start) saved through the page", async ({ page, api }) => {
  await openAdmin(page, "settings");
  const box = page.locator("#gPayNet30");
  await expect(page.getByLabel("Net 30 (with a PO)")).not.toBeChecked();
  await expect(page.getByRole("heading", { name: "Net 30 terms", level: 2 })).toBeVisible();
  await expect(page.locator("#gTermsDays")).toHaveValue("30");
  await expect(page.locator("#gTermsStarts")).toHaveValue("invoice");
  await expect(page.locator("#gTermsStarts option")).toHaveText(["When the invoice is sent (the order date when none was sent)", "On the order date", "When the order is completed (shipped or picked up)"]);

  // The page's own check: nothing is sent.
  await box.check();
  await page.locator("#gTermsDays").fill("0");
  await page.getByRole("button", { name: "Save global settings" }).click();
  await expect(page.locator("#globalSettingsError")).toContainText("Net 30 terms: the default days to pay is a whole number from 1 to 365.");
  expect(await termsOf(api)).toEqual({ defaultDays: 30, startsAt: "invoice" });
  expect((await globalPayments(api)).net30).toBe(false);

  // 20 days from the invoice: saved with the payment methods.
  await page.locator("#gTermsDays").fill("20");
  const saved = answerOf(page, "saveGlobalSettingsAll");
  await page.getByRole("button", { name: "Save global settings" }).click();
  const res = await saved;
  expect(res.ok()).toBe(true);
  const sent = JSON.parse(res.request().postData()).settings;
  expect(sent.payments.net30).toBe(true);
  expect(sent.terms).toEqual({ defaultDays: 20, startsAt: "invoice" });
  await expect(toast(page)).toContainText("Global settings saved.");
  expect(await termsOf(api)).toEqual({ defaultDays: 20, startsAt: "invoice" });
  expect((await globalPayments(api)).net30).toBe(true);
  const audits = ((await api("getAuditLog", { filter: "settings.terms_set", limit: 20 })).entries || []).filter(e => e.action === "settings.terms_set");
  expect(audits.some(e => JSON.stringify(e.detail).includes('"defaultDays":20'))).toBe(true);
  // As saved when the page is opened again.
  await openAdmin(page, "settings");
  await expect(page.locator("#gPayNet30")).toBeChecked();
  await expect(page.locator("#gTermsDays")).toHaveValue("20");
  await expect(page.locator("#gTermsStarts")).toHaveValue("invoice");
  await leaveAdmin(page);

  // The server's own checks.
  let r = await tryApi(api, "updateTermsSettings", { terms: { defaultDays: 366, startsAt: "invoice" } });
  expect(r.status).toBe(400);
  expect(r.data.message).toBe("The usual terms are a whole number of days from 1 to 365.");
  r = await tryApi(api, "updateTermsSettings", { defaultDays: 30, startsAt: "shipped" });
  expect(r.status).toBe(400);
  expect(r.data.message).toBe("Choose when the days start: the invoice, the order date or the order completed.");
  r = await tryApi(api, "saveGlobalSettingsAll", { settings: { terms: { defaultDays: 1.5, startsAt: "order" } } });
  expect(r.status).toBe(400);
  expect(await termsOf(api)).toEqual({ defaultDays: 20, startsAt: "invoice" });
  // Now the shop's orders may go on terms.
  expect((await api("getOrders", { org: S.shop.orgId })).net30).toEqual({ allowed: true, defaultDays: 20 });
});

// =========================================================================================================
test("a customer is allowed Net 30 with 45 days on their own page", async ({ page, api }) => {
  // A customer of this test's own, not allowed yet; the one the checkout uses is made allowed here through the page.
  await api("saveCustomer", { id: S.customerId, name: "Pat Example " + TAG, company: "Example School District", email: S.email, phone: "", address: null, notes: "",
    taxExempt: false, taxExemptCertificate: "", taxExemptExpires: "", allowNet30: false, termsDays: null });
  await openAdmin(page, "customers/" + S.customerId);
  const f = page.locator("#custForm");
  await expect(f).toBeVisible();
  const terms = f.locator("fieldset.cust-terms");
  await expect(terms.locator("legend")).toHaveText("Net 30 terms");
  await expect(terms.locator("#custNet30")).not.toBeChecked();
  await expect(terms.locator("#custTermsDays")).toHaveValue("");
  await expect(page.locator(".cust-tag-net30")).toHaveCount(0);
  await terms.locator("#custNet30").check();
  await terms.locator("#custTermsDays").fill("0");
  await f.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#custErr")).toHaveText("Terms: a whole number of days from 1 to 365, or blank for the default.");
  await expect(terms.locator("#custTermsDays")).toBeFocused();
  expect((await api("getCustomer", { id: S.customerId })).customer.allowNet30).toBe(false);
  await terms.locator("#custTermsDays").fill("45");
  const sent = page.waitForRequest(req => actionOf(req) === "saveCustomer");
  await f.getByRole("button", { name: "Save" }).click();
  expect(JSON.parse((await sent).postData())).toMatchObject({ allowNet30: true, termsDays: 45 });
  await expect(toast(page)).toContainText("Customer saved.");
  const c = (await api("getCustomer", { id: S.customerId })).customer;
  expect(c).toMatchObject({ allowNet30: true, termsDays: 45 });
  await openAdmin(page, "customers/" + S.customerId);
  await expect(page.locator("#custNet30")).toBeChecked();
  await expect(page.locator("#custTermsDays")).toHaveValue("45");
  await expect(page.locator(".cust-tag-net30").first()).toHaveText("Net 45");

  // Back office (Customers edit, not full) can save the customer with the terms as they are, but not change them.
  const staff = await apiContext("staff", test.info().workerIndex);
  try {
    let r = await callApi(staff, "saveCustomer", { id: S.customerId, notes: "Called about PO " + TAG, allowNet30: true, termsDays: 45 }, { allowError: true, withStatus: true });
    expect(r.status).toBe(200);
    r = await callApi(staff, "saveCustomer", { id: S.customerId, allowNet30: false }, { allowError: true, withStatus: true });
    expect(r.status).toBe(403);
    expect(r.data.message).toBe("Your role can't change a customer's Net 30 terms. Ask an admin.");
    r = await callApi(staff, "saveCustomer", { id: S.customerId, termsDays: 60 }, { allowError: true, withStatus: true });
    expect(r.status).toBe(403);
  } finally { await staff.dispose(); }
  expect((await api("getCustomer", { id: S.customerId })).customer).toMatchObject({ allowNet30: true, termsDays: 45 });
});

// =========================================================================================================
test("a Local sale on Net 30 without a PO waits (PO needed, not on the Run order); its PO added in Net 30… clears it for work while it stays owed, and it can be completed", async ({ page, api }) => {
  test.setTimeout(150_000);
  const shop = S.shop, who = uniq("Lee Localsale");
  const form = await openLocalSale(page, shop);
  await expect(form.locator("#lsPayment option[value='Net 30']")).toHaveText("Net 30 (pay by invoice)");
  await form.locator("#lsProduct").selectOption({ label: "Sample Tee" });
  await form.locator("#lsQty").fill("1");
  await form.locator("summary", { hasText: "Customer info" }).click();
  await form.locator("#lsName").fill(who);
  // The PO and days show only while Net 30 is the payment picked.
  await expect(form.locator("#lsNet30Wrap")).toBeHidden();
  await form.locator("#lsPayment").selectOption("Net 30");
  await expect(form.locator("#lsNet30Wrap")).toBeVisible();
  await form.locator("#lsPayment").selectOption("Cash");
  await expect(form.locator("#lsNet30Wrap")).toBeHidden();
  await form.locator("#lsPayment").selectOption("Net 30");
  // Paid with Net 30: refused in the window. Days out of range too.
  await form.locator("#lsPaid").check();
  await form.getByRole("button", { name: "Record sale" }).click();
  await expect(form.locator("#lsErr")).toHaveText("Net 30 is paid later, by invoice: untick Paid.");
  await form.locator("#lsPaid").uncheck();
  // Days over 365: the field itself refuses it (min 1, max 365), and nothing is sent.
  const sales = [];
  page.on("request", req => { if (actionOf(req) === "createLocalSale") sales.push(req); });
  await form.locator("#lsTermsDays").fill("400");
  await form.getByRole("button", { name: "Record sale" }).click();
  await expect(form.locator("#lsTermsDays:invalid")).toHaveCount(1);
  expect(await form.locator("#lsTermsDays").evaluate(el => el.validity.rangeOverflow)).toBe(true);
  await form.locator("#lsTermsDays").fill("");
  expect(sales).toHaveLength(0);
  const sent = page.waitForRequest(req => actionOf(req) === "createLocalSale");
  await form.getByRole("button", { name: "Record sale" }).click();
  const body = JSON.parse((await sent).postData());
  expect(body).toMatchObject({ net30: true, paymentMethod: "Net 30" });
  expect(body).not.toHaveProperty("poNumber");
  expect(body).not.toHaveProperty("termsDays");
  expect(body.paid).toBeFalsy();
  await expect(toast(page)).toContainText("Local sale recorded — ");

  const made = (await api("getOrders", { org: shop.orgId })).orders.find(o => o.customerName === who);
  const id = S.sale = made.orderId;
  expect(made).toMatchObject({ net30: true, poNumber: "", poStatus: "PO needed", paid: false, termsDays: null, poAcceptedAt: "" });
  expect(made.balanceDue).toBe(20);
  // Due from the order date (no invoice sent yet) with the default 20 days.
  expect(made.termsDueDate).toBe(addDays(utcDay(made.placedAt), 20));

  // The row: PO needed, unpaid on Net 30, no steps, Net 30… but no Accept PO.
  await ordersPage(page, shop);
  await expect(n30Tag(page, id)).toHaveText("Net 30 — PO needed");
  await expect(paidCell(page, id)).toHaveText("Unpaid · Net 30");
  await expect(stageSelect(page, id)).toHaveCount(0);
  await expect(termsBtn(page, id)).toBeVisible();
  await expect(acceptBtn(page, id)).toHaveCount(0);
  // The server: its steps wait, and there is no PO to accept.
  let r = await tryApi(api, "setFulfillmentStage", { org: shop.orgId, orderId: id, stage: "manufactured" });
  expect(r.status).toBe(409);
  r = await tryApi(api, "acceptOrderPo", { org: shop.orgId, orderId: id });
  expect(r.status).toBe(409);
  expect(r.data.message).toBe("There's no PO number to accept yet.");
  r = await tryApi(api, "acceptOrderPo", { org: shop.orgId, orderId: S.plain });
  expect(r.status).toBe(409);
  expect(r.data.message).toBe("This order isn't on Net 30.");
  // The sale's own checks on the server: days out of range, Paid with Net 30, a PO without Net 30.
  const sale = (extra) => tryApi(api, "createLocalSale", { org: shop.orgId, items: [{ productId: shop.products[0].productId, qty: 1 }], paymentMethod: "Net 30", customerName: uniq("Lane Localsale"), ...extra });
  r = await sale({ net30: true, termsDays: 400 });
  expect(r.status).toBe(400);
  expect(r.data.message).toBe("Terms are a whole number of days from 1 to 365 (leave it blank for the usual).");
  r = await sale({ net30: true, paid: true });
  expect(r.status).toBe(400);
  expect(r.data.message).toBe("Choose one of Paid, Pay on delivery or Net 30.");
  r = await sale({ poNumber: "PO-1001" });
  expect(r.status).toBe(400);
  expect(r.data.message).toBe("Tick Net 30 to give the sale a PO number or terms.");
  r = await sale({ net30: true, poNumber: "P".repeat(61) });
  expect(r.status).toBe(400);
  expect(r.data.message).toBe("A PO number is at most 60 characters.");
  // Not on the Run order.
  expect((await api("getRunQueue")).paidUnrun.map(o => o.orderId)).not.toContain(id);
  await openAdmin(page, "runorder");
  await expect(page.locator("#roBody")).toBeVisible();
  await expect(page.locator("#roBody")).not.toContainText(id);

  // The Net 30… window: no PO yet, due from the order date with the shop's default days.
  await ordersPage(page, shop);
  let dlg = await openTerms(page, id);
  const facts = dlg.locator("#n30Facts");
  await expect(facts).toContainText("No PO yet");
  await expect(facts).toContainText("Due " + longDay(made.termsDueDate) + " · Net 20 · no invoice sent yet");
  await expect(facts).toContainText("Still owed: $20.00");
  await expect(dlg.locator("#n30On")).toBeChecked();
  await expect(dlg.locator("#n30Days")).toHaveValue("");
  await expect(dlg.locator("#n30Days")).toHaveAttribute("placeholder", "Default (20)");
  await expect(dlg.locator("#n30Accept")).toHaveCount(0);
  await dlg.locator("#n30Days").fill("0");
  await dlg.locator("#n30Save").click();
  await expect(dlg.locator("#n30Err")).toHaveText("Days to pay: a whole number from 1 to 365, or blank for the default.");
  await dlg.locator("#n30Days").fill("");
  await dlg.locator("#n30Po").fill("PO-1001");
  const saved = answerOf(page, "setOrderTerms");
  await dlg.locator("#n30Save").click();
  const savedRes = await saved;
  expect(JSON.parse(savedRes.request().postData())).toMatchObject({ orderId: id, net30: true, termsDays: null, poNumber: "PO-1001" });
  expect(await savedRes.json()).toMatchObject({ status: "ok", net30: true, poNumber: "PO-1001", poStatus: "accepted", net30Cleared: true, paid: false });
  await expect(toast(page)).toContainText("Order " + id + " is on Net 30 with PO-1001.");

  // Cleared for work, still owed.
  await expect(n30Tag(page, id)).toHaveText("PO-1001 · due " + shortDay(made.termsDueDate));
  await expect(paidCell(page, id)).toHaveText("Unpaid · Net 30");
  await expect(stageSelect(page, id)).toBeVisible();
  let o = await orderOf(api, shop, id);
  expect(o).toMatchObject({ poStatus: "accepted", poNumber: "PO-1001", paid: false, balanceDue: 20 });
  expect(o.poAcceptedAt).toBeTruthy();
  expect(o.poAcceptedBy).toBeTruthy();
  const set = await auditOf(api, id, "order.terms_set");
  expect(set).toHaveLength(1);
  expect(set[0].detail.changes).toEqual({ poNumber: { from: "", to: "PO-1001" } });
  // The PO saved again unchanged doesn't add another change.
  dlg = await openTerms(page, id);
  await expect(dlg.locator("#n30Facts")).toContainText("PO accepted — PO-1001");
  await dlg.locator("#n30Save").click();
  await expect(toast(page)).toContainText("Order " + id + " is on Net 30 with PO-1001.");
  expect(await auditOf(api, id, "order.terms_set")).toHaveLength(1);

  // On the Run order now.
  expect((await api("getRunQueue")).paidUnrun.map(o => o.orderId)).toContain(id);
  await openAdmin(page, "runorder");
  await expect(page.locator("#roBody")).toContainText(id);
  await expect(page.locator("#roBody tr", { hasText: id })).toContainText(who);

  // Its steps go on to delivered; completing it is allowed while money is owed.
  await stepsTo(api, shop, id, ["digitizingComplete", "designApproved", "manufactured", "qaPacked", "delivered"]);
  o = await orderOf(api, shop, id);
  expect(o.deliveredAt).toBeTruthy();
  expect(o.completedAt || "").toBe("");
  // Delivered and still owed: Mark completed is offered (an unpaid order without an accepted PO never gets it).
  await ordersPage(page, shop);
  await expect(paidCell(page, id)).toHaveText("Unpaid · Net 30");
  await actionCell(page, id).getByRole("button", { name: "Mark completed" }).click();
  await confirmOk(page);
  await expect.poll(async () => (await orderOf(api, shop, id)).completedAt || "").not.toBe("");
  o = await orderOf(api, shop, id);
  expect(o).toMatchObject({ paid: false, balanceDue: 20, poStatus: "accepted" });
  // Still owed: on the Unpaid POs report.
  const row = await reportRow(api, shop, id, utcDay(o.completedAt) > made.termsDueDate ? utcDay(o.completedAt) : made.termsDueDate);
  expect(row).toMatchObject({ poNumber: "PO-1001", poStatus: "accepted", owedCents: 2000 });

  // Taken off Net 30 (another sale): asked first, the PO and days go with it.
  const off = (await api("createLocalSale", { org: shop.orgId, items: [{ productId: shop.products[0].productId, qty: 1 }], paymentMethod: "Net 30", customerName: uniq("Owen Off"), net30: true, poNumber: "PO-1009", termsDays: 10 })).orderId;
  expect(await orderOf(api, shop, off)).toMatchObject({ net30: true, poNumber: "PO-1009", termsDays: 10, poStatus: "accepted" });
  await ordersPage(page, shop);
  dlg = await openTerms(page, off);
  await expect(dlg.locator("#n30Days")).toHaveValue("10");
  await expect(dlg.locator("#n30Facts")).toContainText("Net 10");
  await dlg.locator("#n30On").uncheck();
  await expect(dlg.locator("#n30Fields")).toBeHidden();
  await dlg.locator("#n30Save").click();
  await expect(page.locator(".confirm-modal")).toContainText("Take order " + off + " off Net 30?");
  await confirmOk(page);
  await expect(toast(page)).toContainText("Order " + off + " is off Net 30.");
  expect(await orderOf(api, shop, off)).toMatchObject({ net30: false, poNumber: "", termsDays: null, poStatus: "" });
  await expect(n30Tag(page, off)).toHaveCount(0);
  await expect(paidCell(page, off)).toHaveText("Unpaid");
  // A PO without Net 30 is refused by the server.
  r = await tryApi(api, "setOrderTerms", { org: shop.orgId, orderId: off, net30: false, poNumber: "PO-1010" });
  expect(r.status).toBe(400);
  expect(r.data.message).toBe("Tick Net 30 to give the order a PO number or terms.");
});

// =========================================================================================================
test("at the shop's checkout the allowed customer's email offers Net 30; a typed PO arrives as PO to check and Accept PO clears it", async ({ page, api, as }) => {
  test.setTimeout(120_000);
  const shop = S.shop;
  const cp = await shopCheckout(as, shop);
  const cat = await cp.evaluate(async () => (await (await fetch("/api/catalog", { cache: "no-store" })).json()));
  expect(cat.catalog.net30Offered).toBe(true);
  expect(cat.catalog.enabledPayments).not.toContain("Net 30");
  // Typed in other capitals: the same customer.
  const ans = await typeEmail(cp, S.email.toUpperCase());
  expect(ans.body).toEqual({ status: "ok", ok: true, termsDays: 45 });
  await expect.poll(() => payOptions(cp)).toContain("Net 30 (pay by invoice)");
  const sel = cp.getByLabel("Payment method");
  await sel.selectOption({ label: "Net 30 (pay by invoice)" });
  const po = cp.getByLabel("PO number");
  await expect(po).toBeVisible();
  await expect(cp.locator("#custPoHint")).toHaveText("Your PO number, if you have it — you can add it later from your invoice.");
  await expect(cp.locator("#paymentHint")).toHaveText("No payment now — we'll send you an invoice, due within 45 days.");
  await po.fill("PO-1001");
  // Another method hides the box; back to Net 30 keeps what was typed.
  await sel.selectOption({ label: "Check" });
  await expect(po).toBeHidden();
  await sel.selectOption({ label: "Net 30 (pay by invoice)" });
  await expect(po).toHaveValue("PO-1001");
  const placed = await placeIt(cp);
  expect(placed.status).toBe(200);
  expect(placed.sent).toMatchObject({ paymentMethod: "Net 30", poNumber: "PO-1001" });
  expect(placed.body).toMatchObject({ net30: true, termsDays: 45 });
  await expect(cp.getByRole("heading", { level: 2, name: /^Order received/ })).toBeVisible();
  await expect(cp.locator(".confirmation")).toContainText("Your order is in — there's nothing to pay now. We'll send an invoice; payment is due within 45 days. Your PO number PO-1001 is on the order; we'll confirm it.");
  const id = S.checkout = placed.sent.orderId;
  let o = await orderOf(api, shop, id);
  expect(o).toMatchObject({ net30: true, termsDays: 45, poNumber: "PO-1001", poStatus: "PO to check", paid: false, poAcceptedAt: "", paymentMethod: "Net 30" });
  expect(o.poTypedAt).toBeTruthy();
  expect(o.termsDueDate).toBe(addDays(utcDay(o.placedAt), 45));

  // The row: PO to check, no steps, Accept PO.
  await ordersPage(page, shop);
  await expect(n30Tag(page, id)).toHaveText("Net 30 — PO to check");
  await expect(n30Tag(page, id)).toHaveAttribute("title", "The customer typed PO-1001: accept it to clear the order for work");
  await expect(stageSelect(page, id)).toHaveCount(0);
  expect((await api("getRunQueue")).paidUnrun.map(x => x.orderId)).not.toContain(id);
  // Accept PO asks; Cancel leaves it.
  await acceptBtn(page, id).click();
  await expect(page.locator(".confirm-modal")).toContainText("Accept PO-1001 for order " + id + "?");
  await page.locator(".confirm-modal").getByRole("button", { name: "Cancel" }).click();
  expect((await orderOf(api, shop, id)).poStatus).toBe("PO to check");
  await acceptBtn(page, id).click();
  await confirmOk(page);
  await expect(toast(page)).toContainText("PO-1001 accepted for order " + id + ".");
  await expect(n30Tag(page, id)).toHaveText("PO-1001 · due " + shortDay(o.termsDueDate));
  await expect(acceptBtn(page, id)).toHaveCount(0);
  await expect(stageSelect(page, id)).toBeVisible();
  o = await orderOf(api, shop, id);
  expect(o).toMatchObject({ poStatus: "accepted", paid: false, balanceDue: 20 });
  const acc = await auditOf(api, id, "order.po_accepted");
  expect(acc).toHaveLength(1);
  expect(acc[0].detail.poNumber).toBe("PO-1001");
  expect((await api("getRunQueue")).paidUnrun.map(x => x.orderId)).toContain(id);
  // Accepting again changes nothing (no second audit).
  const again = await api("acceptOrderPo", { org: shop.orgId, orderId: id });
  expect(again).toMatchObject({ poStatus: "accepted", net30Cleared: true });
  expect(await auditOf(api, id, "order.po_accepted")).toHaveLength(1);
});

// =========================================================================================================
test("an unknown email, or a customer not allowed Net 30, never sees it; the server refuses Net 30 for them even when the page is made to offer it", async ({ api, as }) => {
  const shop = S.shop;
  const notAllowed = ("sam." + TAG + "@example.com").toLowerCase();
  await api("saveCustomer", { name: "Sam Example " + TAG, company: "", email: notAllowed, phone: "", address: null, notes: "",
    taxExempt: false, taxExemptCertificate: "", taxExemptExpires: "", allowNet30: false, termsDays: 60 });
  const cp = await shopCheckout(as, shop);
  for (const email of ["nobody." + TAG + "@example.com", notAllowed]) {
    const ans = await typeEmail(cp, email);
    expect(ans.status).toBe(200);
    expect(ans.body).toEqual({ status: "ok", ok: false });
    await expect.poll(() => payOptions(cp)).not.toContain("Net 30 (pay by invoice)");
  }
  // The allowed email, then an unknown one: Net 30 goes away again.
  await typeEmail(cp, S.email);
  await expect.poll(() => payOptions(cp)).toContain("Net 30 (pay by invoice)");
  await typeEmail(cp, "nobody2." + TAG + "@example.com");
  await expect.poll(() => payOptions(cp)).not.toContain("Net 30 (pay by invoice)");

  // The page made to offer it (its question answered yes by a stub): the server asks again and refuses.
  await cp.route("**/api/orders", async (route) => {
    if (actionOf(route.request()) !== "checkNet30") return route.fallback();
    await route.fulfill({ json: { status: "ok", ok: true, termsDays: 30 } });
  });
  await typeEmail(cp, "nobody3." + TAG + "@example.com");
  await expect.poll(() => payOptions(cp)).toContain("Net 30 (pay by invoice)");
  await cp.getByLabel("Payment method").selectOption({ label: "Net 30 (pay by invoice)" });
  const placed = await placeIt(cp);
  expect(placed.status).toBe(400);
  expect(placed.body.message).toBe(NOT_AVAILABLE);
  await expect(cp.getByText(NOT_AVAILABLE)).toBeVisible();
  await expect(cp.getByRole("heading", { level: 2, name: /^Order received/ })).toHaveCount(0);

  // A shop that switched Net 30 off for itself: not offered, and the allowed customer's email is a plain no there.
  const closed = await makeShop(api, { prefix: "n30off", payments: { card: false, venmo: true, zelle: true, check: true, cash: true, other: true, net30: false } });
  const cp2 = await shopCheckout(as, closed);
  const cat = await cp2.evaluate(async () => (await (await fetch("/api/catalog", { cache: "no-store" })).json()));
  expect(cat.catalog.net30Offered).toBe(false);
  const no = await cp2.evaluate(async ({ orgId, email }) => (await (await fetch("/api/orders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "checkNet30", orgId, email }) })).json()), { orgId: closed.orgId, email: S.email });
  expect(no).toEqual({ status: "ok", ok: false });
  expect((await api("getOrders", { org: closed.orgId })).net30.allowed).toBe(false);
});

// =========================================================================================================
test("the invoice page shows the terms and takes the customer's PO, which staff accept in Net 30…", async ({ page, api, as }) => {
  test.setTimeout(120_000);
  const shop = S.shop;
  // The allowed customer orders on Net 30 with no PO.
  const cp = await shopCheckout(as, shop);
  await typeEmail(cp, S.email);
  await expect.poll(() => payOptions(cp)).toContain("Net 30 (pay by invoice)");
  await cp.getByLabel("Payment method").selectOption({ label: "Net 30 (pay by invoice)" });
  const placed = await placeIt(cp);
  expect(placed.sent).not.toHaveProperty("poNumber");
  await expect(cp.locator(".confirmation")).toContainText("Add your PO number from your invoice when you have it.");
  const id = S.invoiced = placed.sent.orderId;
  expect(await orderOf(api, shop, id)).toMatchObject({ poStatus: "PO needed", termsDays: 45 });

  const sent = await api("sendInvoice", { orderId: id, org: shop.orgId, allowDelivery: false });
  const token = new URL(sent.url).searchParams.get("invoice");
  let o = await orderOf(api, shop, id);
  expect(o.invoicedAt).toBeTruthy();
  const due = addDays(utcDay(o.invoicedAt), 45);
  expect(o.termsDueDate).toBe(due);

  await cp.goto(shopUrl(shop.subdomain) + "/?invoice=" + token);
  const inv = cp.locator(".inv");
  await expect(inv).toContainText("Invoice for order " + id);
  await expect(inv.getByRole("heading", { level: 2, name: "Terms" })).toBeVisible();
  await expect(inv.locator(".inv-terms")).toHaveText("Net 45 — due " + longDay(due) + "PO needed: add your PO number below.");
  // Nothing typed: said on the page, nothing sent.
  await inv.getByRole("button", { name: "Add PO number" }).click();
  await expect(inv.locator("#invPoMsg")).toHaveText("Enter your PO number.");
  await inv.getByLabel("Your PO number").fill("PO-2002");
  await expect(inv.locator("#invPoMsg")).toHaveText("");
  const post = cp.waitForResponse(r => r.url().endsWith("/api/invoice") && r.request().method() === "POST");
  await inv.getByRole("button", { name: "Add PO number" }).click();
  expect(JSON.parse((await post).request().postData())).toMatchObject({ action: "setInvoicePo", poNumber: "PO-2002", token });
  await expect(inv.locator(".inv-detail[role=status]")).toHaveText("Thanks — we'll confirm your PO.");
  await expect(inv.locator(".inv-terms")).toHaveText("Net 45 — PO-2002 — due " + longDay(due));
  await expect(inv.getByLabel("Your PO number")).toHaveCount(0);
  o = await orderOf(api, shop, id);
  expect(o).toMatchObject({ poNumber: "PO-2002", poStatus: "PO to check", poAcceptedAt: "" });
  expect(o.poTypedAt).toBeTruthy();
  const typed = await auditOf(api, id, "order.invoice_po_typed");
  expect(typed).toHaveLength(1);
  expect(typed[0].detail.poNumber).toEqual({ from: "", to: "PO-2002" });
  // Opened again: the PO waits to be confirmed.
  await cp.reload();
  await expect(inv.locator(".inv-terms")).toHaveText("Net 45 — PO-2002 — due " + longDay(due) + "We'll confirm your PO number.");

  // The server: empty or too long refused; the customer may still replace their own PO until it's accepted.
  let r = await invoicePost(cp, token, { action: "setInvoicePo", poNumber: "  " });
  expect(r.status).toBe(400);
  expect(r.body.message).toBe("Enter your PO number.");
  r = await invoicePost(cp, token, { action: "setInvoicePo", poNumber: "P".repeat(61) });
  expect(r.status).toBe(400);
  expect(r.body.message).toBe("A PO number can be up to 60 characters.");
  r = await invoicePost(cp, token, { action: "setInvoicePo", poNumber: "PO-2003" });
  expect(r.status).toBe(200);
  expect(r.body.invoice.terms).toMatchObject({ net30: true, termsDays: 45, poNumber: "PO-2003", poStatus: "PO to check", dueDate: due, canSetPo: false });

  // Staff accept it in the order's Net 30… window.
  await ordersPage(page, shop);
  await expect(n30Tag(page, id)).toHaveText("Net 30 — PO to check");
  const dlg = await openTerms(page, id);
  await expect(dlg.locator("#n30Facts")).toContainText("PO typed by the customer, not accepted yet — PO-2003");
  await expect(dlg.locator("#n30Facts")).toContainText("Typed by the customer ");
  await expect(dlg.locator("#n30Facts")).toContainText("Due " + longDay(due) + " · Net 45 · invoice first sent ");
  await expect(dlg.locator("#n30Po")).toHaveValue("PO-2003");
  await dlg.locator("#n30Accept").click();
  await expect(toast(page)).toContainText("PO-2003 accepted: order " + id + " is cleared for work.");
  await expect(n30Tag(page, id)).toHaveText("PO-2003 · due " + shortDay(due));
  expect(await orderOf(api, shop, id)).toMatchObject({ poStatus: "accepted", poNumber: "PO-2003", paid: false });

  // Accepted: the invoice can't change it, and shows no box.
  r = await invoicePost(cp, token, { action: "setInvoicePo", poNumber: "PO-2004" });
  expect(r.status).toBe(409);
  expect(r.body.message).toBe("Your PO is already on this order — contact us to change it.");
  await cp.reload();
  await expect(inv.locator(".inv-terms")).toHaveText("Net 45 — PO-2003 — due " + longDay(due));
  await expect(inv.getByLabel("Your PO number")).toHaveCount(0);

  // An order not on Net 30: no Terms on its invoice, and no PO taken.
  const plainSent = await api("sendInvoice", { orderId: S.plain, org: shop.orgId, allowDelivery: false, email: "uma." + TAG + "@example.com" });
  const plainToken = new URL(plainSent.url).searchParams.get("invoice");
  await cp.goto(shopUrl(shop.subdomain) + "/?invoice=" + plainToken);
  await expect(inv).toContainText("Invoice for order " + S.plain);
  await expect(inv.getByRole("heading", { level: 2, name: "Terms" })).toHaveCount(0);
  r = await invoicePost(cp, plainToken, { action: "setInvoicePo", poNumber: "PO-2005" });
  expect(r.status).toBe(409);
  expect(r.body.message).toBe("This order doesn't take a PO number — contact us if you need one on it.");
});

// =========================================================================================================
test("Terms start switched between the invoice, the order date and the order completed moves the due date in Net 30…, the Orders tag, the invoice page and the Unpaid POs report", async ({ page, api, as }) => {
  test.setTimeout(150_000);
  const shop = S.shop, id = S.invoiced;   // the allowed customer's order: Net 45, invoice sent today, PO accepted
  // Its order date moved to Oct 1, 2026 and shipped on Oct 10 (fixed days, not this computer's).
  await api("setOrderDates", { org: shop.orgId, orderId: id, dates: { placedAt: "2026-10-01T15:00:00.000Z" } });
  await stepsTo(api, shop, id, ["digitizingComplete", "designApproved", "manufactured", "qaPacked", "shipped"], "2026-10-10T16:00:00.000Z");
  const o = await orderOf(api, shop, id);
  expect(utcDay(o.placedAt)).toBe("2026-10-01");
  expect(utcDay(o.shippedAt)).toBe("2026-10-10");
  expect(o.completedAt || "").toBe("");
  const byInvoice = addDays(utcDay(o.invoicedAt), 45), byOrder = "2026-11-15", byShipped = "2026-11-24";
  // The not-yet-shipped Net 30 order of the checkout test (Net 45 from Oct… no: placed today) stays as it is.
  const waiting = S.checkout;

  const sent = await api("sendInvoice", { orderId: id, org: shop.orgId, allowDelivery: false });
  const token = new URL(sent.url).searchParams.get("invoice");
  expect((await orderOf(api, shop, id)).invoicedAt).toBe(o.invoicedAt);   // a resend doesn't move it

  const cp = await as(null);
  const setStart = async (value) => {
    await openAdmin(page, "settings");
    await page.locator("#gTermsStarts").selectOption(value);
    const saved = answerOf(page, "saveGlobalSettingsAll");
    await page.getByRole("button", { name: "Save global settings" }).click();
    expect((await saved).ok()).toBe(true);
    await expect(toast(page)).toContainText("Global settings saved.");
    expect(await termsOf(api)).toEqual({ defaultDays: 20, startsAt: value });
  };
  const expectDue = async (day, { late, group, daysLate }) => {
    expect((await orderOf(api, shop, id)).termsDueDate).toBe(day);
    await ordersPageFrom(page, shop, "2026-09-01");
    await expect(n30Tag(page, id)).toHaveText("PO-2003 · " + (late ? "was due " : "due ") + shortDay(day));
    if (late) await expect(n30Tag(page, id)).toHaveClass(/n30-tag-late/);
    else await expect(n30Tag(page, id)).not.toHaveClass(/n30-tag-late/);
    const dlg = await openTerms(page, id);
    await expect(dlg.locator("#n30Facts")).toContainText("Due " + longDay(day) + " · Net 45");
    await dlg.locator("#n30Cancel").click();
    await cp.goto(shopUrl(shop.subdomain) + "/?invoice=" + token);
    await expect(cp.locator(".inv .inv-terms")).toHaveText("Net 45 — PO-2003 — due " + longDay(day));
    const row = await reportRow(api, shop, id, "2026-12-20");
    expect(row).toMatchObject({ dueDate: day, group, daysLate, poStatus: "accepted", owedCents: 2000 });
  };
  // The Orders tag says "was due" once the business's today is past the due date with money owed. The admin's clock
  // isn't pinned (a pinned clock ends the signed-in session); the fixed due days (Nov 15, Nov 24, 2026) are before any
  // day this test can run on, and the invoice's due day is 45 days after the real one.
  expect(utcDay((await api("getOrders", { org: shop.orgId })).orders.find(x => x.orderId === id).invoicedAt) > byShipped).toBe(true);

  // The invoice (the first send): today + 45 — not due yet on Dec 20.
  await expectDue(byInvoice, { late: false, group: "notdue", daysLate: 0 });
  // The order date: Oct 1 + 45 = Nov 15 — 35 days late on Dec 20; due that day itself is not late.
  await setStart("order");
  await expectDue(byOrder, { late: true, group: "31-60", daysLate: 35 });
  expect(await reportRow(api, shop, id, "2026-11-15")).toMatchObject({ dueDate: byOrder, daysLate: 0, group: "notdue" });
  expect(await reportRow(api, shop, id, "2026-11-16")).toMatchObject({ daysLate: 1, group: "1-30" });
  // Completed (shipped or picked up): Oct 10 + 45 = Nov 24 — 26 days late on Dec 20.
  await setStart("completed");
  await expectDue(byShipped, { late: true, group: "1-30", daysLate: 26 });
  // An order not shipped yet has no due date under "completed": the window and the invoice say when the days start.
  const w = await orderOf(api, shop, waiting);
  expect(w.termsDueDate).toBe("");
  await ordersPage(page, shop);
  await expect(n30Tag(page, waiting)).toHaveText("PO-1001 · due date to come");
  const dlg = await openTerms(page, waiting);
  await expect(dlg.locator("#n30Facts")).toContainText("Due date: not known yet · Net 45");
  await dlg.locator("#n30Cancel").click();
  const wSent = await api("sendInvoice", { orderId: waiting, org: shop.orgId, allowDelivery: false });
  await cp.goto(shopUrl(shop.subdomain) + "/?invoice=" + new URL(wSent.url).searchParams.get("invoice"));
  await expect(cp.locator(".inv .inv-terms")).toHaveText("Net 45 — PO-1001 — due 45 days after your order ships or is picked up");
  expect(await reportRow(api, shop, waiting, "2027-06-30")).toMatchObject({ dueDate: "", group: "notdue", daysLate: 0 });
  // Back to the invoice: the first send's day again.
  await setStart("invoice");
  await expectDue(byInvoice, { late: false, group: "notdue", daysLate: 0 });
});

// =========================================================================================================
test("settings put back: Net 30 unticked through the page, and the shop's orders can't go on terms again", async ({ page, api }) => {
  await openAdmin(page, "settings");
  await page.locator("#gPayNet30").uncheck();
  await page.locator("#gTermsDays").fill("30");
  const saved = answerOf(page, "saveGlobalSettingsAll");
  await page.getByRole("button", { name: "Save global settings" }).click();
  const sent = JSON.parse((await saved).request().postData()).settings;
  expect(sent.payments.net30).toBe(false);
  await expect(toast(page)).toContainText("Global settings saved.");
  expect((await globalPayments(api)).net30).toBe(false);
  expect(await termsOf(api)).toEqual({ defaultDays: 30, startsAt: "invoice" });
  // Orders already on Net 30 keep their terms; nothing new goes on them.
  expect((await api("getOrders", { org: S.shop.orgId })).net30).toEqual({ allowed: false, defaultDays: 30 });
  const r = await tryApi(api, "setOrderTerms", { org: S.shop.orgId, orderId: S.plain, net30: true });
  expect(r.status).toBe(409);
  expect(r.data.message).toBe(NET30_OFF);
  expect((await orderOf(api, S.shop, S.invoiced)).net30).toBe(true);
  await ordersPage(page, S.shop);
  await expect(termsBtn(page, S.plain)).toHaveCount(0);
  await expect(termsBtn(page, S.checkout)).toBeVisible();   // on Net 30 already: its terms can still be seen and taken off
});
