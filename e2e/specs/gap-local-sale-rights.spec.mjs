// Local sale Paid and Delivered need their own rights (review 52.11): + Local sale needs Orders → details at Edit,
// but its Paid box records a payment (what Mark as paid needs: Payments at Edit) and its Delivered box sets the
// Delivered step (the late steps at Edit). The server asks again for each (functions/api/orders.js createLocalSale:
// "Your role can't record payments." / "Your role can't set that step."), and the window shows neither box to a
// role without it (public/admin.js, data-need on each label). A role with only Orders → details at Edit ("Counter"
// here) records an unpaid, undelivered sale through the API. The window itself also lists the shop's products
// (listProducts, which needs Products at Read), so the page test gives the role that as well; the owner sees both
// boxes. The last test is an expected failure: + Local sale is offered to a role with only Orders → details at
// Edit, and its window doesn't open for it (see the test).
//
// Each test's role, its user and the shop are its own, with unique names, made through the owner's session. At
// the end the user is moved to Production and disabled, and the role deleted.
import crypto from "node:crypto";
import { request as playwrightRequest } from "@playwright/test";
import { test, expect, ADMIN, openAdmin, toast, signInThroughPage, callApi, freshIp, slug, uniq } from "../fixtures.mjs";
import { makeShop } from "../lib/data.mjs";

const USERS = { path: "/api/admin-users" };
const strongPassword = () => "Desk-" + crypto.randomBytes(15).toString("base64url");
const menu = (page) => page.getByRole("navigation", { name: "Admin" });
// A key the way the admin page makes one (newRequestId_: a UUID without its dashes).
const requestId = () => crypto.randomUUID().replace(/-/g, "");

// A request context that is a browser of its own: its own address, the admin's Origin.
const client = (workerIndex) => playwrightRequest.newContext({ baseURL: ADMIN, extraHTTPHeaders: { Origin: ADMIN, "CF-Connecting-IP": freshIp(workerIndex) } });

// A user of `role` (a role key) made by the owner, with the temporary password replaced as at a first sign-in.
async function makeUser(api, role, label, workerIndex) {
  const tag = slug("ls");
  const name = label + " " + tag.slice(-4);
  const email = tag + "@example.test";
  const made = await api("create", { name, email, role }, USERS);
  const c = await client(workerIndex);
  let r = await c.post("/api/admin-session", { data: { email, key: made.temporaryPassword } });
  expect((await r.json()).pending).toBe("password");
  const password = strongPassword();
  r = await c.post("/api/admin-password", { data: { action: "change", current: made.temporaryPassword, next: password } });
  expect((await r.json()).status).toBe("ok");
  await c.dispose();
  return { id: made.user.id, email, password, name };
}

// The shop's Orders page, as a real page load.
const ordersPage = async (page, shop) => {
  if (page.url().startsWith(ADMIN)) await page.goto("about:blank");
  await openAdmin(page, "orders/" + shop.orgId);
  await expect(page.getByRole("combobox", { name: "Shop" })).toHaveValue(shop.orgId);
};
const openLocalSale = async (page, shop) => {
  await ordersPage(page, shop);
  await page.getByRole("button", { name: "+ Local sale" }).click();
  const form = page.locator("#localSaleForm");
  await expect(form).toBeVisible();
  return form;
};

// A "Counter" role with `fns`, and a user of it. cleanUp() puts everything back (after a failure too).
async function makeCounter(api, fns, workerIndex) {
  const role = (await api("saveRole", { name: "Counter " + slug("c").slice(-6), rank: 20, permissions: { fns } }, USERS)).role;
  let C = null;
  const cleanUp = async () => {
    if (C) {
      await api("setRole", { id: C.id, role: "production" }, { ...USERS, allowError: true });
      await api("setStatus", { id: C.id, status: "disabled" }, { ...USERS, allowError: true });
    }
    await api("deleteRole", { roleKey: role.key }, { ...USERS, allowError: true });
    const left = (await api("listRoles", {}, USERS)).roles.filter(r => r.key === role.key);
    expect(left, "this test's role is gone again").toEqual([]);
  };
  try { C = await makeUser(api, role.key, "Cory Counter", workerIndex); }
  catch (e) { await cleanUp(); throw e; }
  return { role, C, cleanUp };
}
// That user's browser, signed in through the page.
const counterPage = async (as, C, shop) => {
  const cp = await as(null);
  await cp.goto(ADMIN + "/#orders/" + shop.orgId);
  await signInThroughPage(cp, C);
  await expect(menu(cp)).toBeVisible();
  return cp;
};

test("Local sale: with only Orders → details at Edit, the server refuses Paid and Delivered and records an unpaid sale", async ({ api }, testInfo) => {
  const w = testInfo.workerIndex;
  const { C, cleanUp } = await makeCounter(api, { "orders.details": "edit" }, w);
  let ctx = null;
  try {
    const shop = await makeShop(api, { prefix: "lsr", products: [{ name: "Sample Tee", price: 20 }] });
    const tee = shop.products[0];
    // C's own API, signed in with their password.
    ctx = await client(w);
    const r0 = await ctx.post("/api/admin-session", { data: { email: C.email, key: C.password } });
    expect(r0.status()).toBe(200);
    const sale = (extra) => callApi(ctx, "createLocalSale", {
      org: shop.orgId, items: [{ productId: tee.productId, size: "", qty: 1 }], paymentMethod: "cash",
      customerName: uniq("Lane Localsale"), requestId: requestId(), ...extra,
    }, { allowError: true, withStatus: true });

    // Paid: a payment, which this role can't record. Refused.
    let r = await sale({ paid: true });
    expect(r.status).toBe(403);
    expect(r.data.code).toBe("forbidden");
    expect(r.data.message).toBe("Your role can't record payments. Ask an admin.");
    // Delivered: a late step, which this role can't set. Refused too.
    r = await sale({ delivered: true });
    expect(r.status).toBe(403);
    expect(r.data.code).toBe("forbidden");
    expect(r.data.message).toBe("Your role can't set that step. Ask an admin.");
    // Neither refusal made an order.
    expect((await api("getOrders", { org: shop.orgId })).orders).toEqual([]);

    // Neither box: recorded, unpaid and not delivered.
    r = await sale({});
    expect(r.status).toBe(200);
    expect(r.data.status).toBe("ok");
    const madeId = r.data.orderId;
    expect(madeId).toBeTruthy();
    const orders = (await api("getOrders", { org: shop.orgId })).orders;
    expect(orders.map(o => o.orderId)).toEqual([madeId]);
    expect(orders[0].paid).toBeFalsy();
    expect(orders[0].deliveredAt || "").toBe("");
    expect((orders[0].payments || []).filter(p => !p.voidedAt)).toEqual([]);
  } finally {
    if (ctx) await ctx.dispose();
    await cleanUp();
  }
});

test("Local sale: the window shows no Paid or Delivered box to a role without them, and records an unpaid sale; the owner sees both", async ({ page, api, as }, testInfo) => {
  // Products at Read too: the window lists the shop's products (listProducts) before it opens.
  const { C, cleanUp } = await makeCounter(api, { "orders.details": "edit", "catalog.products": "read" }, testInfo.workerIndex);
  try {
    const shop = await makeShop(api, { prefix: "lsw", products: [{ name: "Sample Tee", price: 20 }] });
    const tee = shop.products[0];

    const cp = await counterPage(as, C, shop);
    const form = await openLocalSale(cp, shop);
    await expect(form.locator("#lsProduct")).toBeVisible();
    await expect(form.locator("#lsPaid")).toBeHidden();
    await expect(form.locator("#lsDelivered")).toBeHidden();
    const customer = uniq("Robin Counterbuy");
    await form.locator("#lsProduct").selectOption({ label: tee.name });
    await form.locator("#lsQty").fill("1");
    await form.locator("#lsPayment").selectOption("Cash");
    await form.locator("summary", { hasText: "Customer info" }).click();
    await form.locator("#lsName").fill(customer);
    const sent = cp.waitForRequest(req => req.url().endsWith("/api/orders") && /"action":"createLocalSale"/.test(req.postData() || ""));
    await form.getByRole("button", { name: "Record sale" }).click();
    const body = JSON.parse((await sent).postData());
    expect(body.paid).toBe(false);
    expect(body.delivered).toBe(false);
    await expect(toast(cp)).toContainText("Local sale recorded — ");
    const row = cp.locator("tr[data-order]", { hasText: customer });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Unpaid");
    const made = (await api("getOrders", { org: shop.orgId })).orders.find(o => o.customerName === customer);
    expect(made.paid).toBeFalsy();
    expect(made.deliveredAt || "").toBe("");

    // The owner sees both boxes in the same window.
    const ownerForm = await openLocalSale(page, shop);
    await expect(ownerForm.locator("#lsPaid")).toBeVisible();
    await expect(ownerForm.locator("#lsDelivered")).toBeVisible();
    await ownerForm.locator(".admin-pass-cancel").click();
    await expect(page.locator("#localSaleForm")).toHaveCount(0);
  } finally {
    await cleanUp();
  }
});

// BUG (expected failure): "+ Local sale" is shown to any role with Orders → details at Edit (its data-need, public/
// admin.js ordersFilterBar_) and the server records the sale on that alone (createLocalSale is orders.details:edit in
// functions/_lib/permissions.js), but the window first asks for listProducts, which needs Products at Read
// (catalog.products) and has no ALSO entry for the order screens. For a role without Products the click shows
// "Could not load products: …" and no window opens. Remove test.fail once the button and the window agree.
test("Local sale: with only Orders → details at Edit, + Local sale opens its window", async ({ api, as }, testInfo) => {
  test.fail(true, "+ Local sale is offered, but its window needs listProducts (Products at Read), which this role lacks");
  const { C, cleanUp } = await makeCounter(api, { "orders.details": "edit" }, testInfo.workerIndex);
  try {
    const shop = await makeShop(api, { prefix: "lsb", products: [{ name: "Sample Tee", price: 20 }] });
    const cp = await counterPage(as, C, shop);
    await ordersPage(cp, shop);
    await cp.getByRole("button", { name: "+ Local sale" }).click();
    await expect(cp.locator("#localSaleForm")).toBeVisible({ timeout: 5_000 });
    await expect(cp.locator("#localSaleForm #lsPaid")).toBeHidden();
    await expect(cp.locator("#localSaleForm #lsDelivered")).toBeHidden();
  } finally {
    await cleanUp();
  }
});
