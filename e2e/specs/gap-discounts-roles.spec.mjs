// Discount codes (migrations/0115): what each role may do with them (discounts.codes in functions/_lib/permissions.js;
// the checks in functions/api/orders.js; the page, the code's window and the menu item in public/admin.js).
//   - Manager (Full): "Discount codes" right after Quotes; makes a code in the page, changes it, switches it off and
//     deletes it; a used code's window is locked to expiry, uses, note and on/off, has no Delete, and the server
//     refuses deleting it.
//   - Back office (Read): the page and a code's window to read — no New code, no list-of-emails button, every field
//     greyed out, Close instead of Cancel, no Save or Delete — and the server refuses every write.
//   - Production (none): no menu item, no page, and the server refuses all six actions.
//   - A role with Discount codes at Edit but not Full: makes, changes and switches off codes, but has no Delete and the
//     server refuses deleting (Full, as every other delete is).
// Every shop, code and role is this file's own; each code works only at this file's shops, so no other spec's
// checkout sees it.
import crypto from "node:crypto";
import { request as playwrightRequest } from "@playwright/test";
import { test, expect, ADMIN, shopUrl, openAdmin, toast, confirmDialog, signInThroughPage, callApi, apiContext, freshIp, slug, uniq } from "../fixtures.mjs";
import { makeShop } from "../lib/data.mjs";

// ---- helpers ---------------------------------------------------------------------------------------------
const USERS = { path: "/api/admin-users" };
const FN = "discounts.codes";
const NO_ROLE = "Your role can't do this. Ask an admin.";
const FAR = "2099-12-31";   // an expiry no run of this suite reaches
const ACTIONS = ["listDiscountCodes", "getDiscountCode", "saveDiscountCode", "createDiscountCodes", "setDiscountCodeActive", "deleteDiscountCode"];

const nav = (page) => page.getByRole("navigation", { name: "Admin" });
const navBtn = (page) => nav(page).locator('.admin-nav-row > button[data-h="discounts"]');
const topButtons = (page) => nav(page).locator(".admin-nav-row > button[data-h]").evaluateAll(els => els.map(e => e.dataset.h));
const tryApi = (ctx, action, body) => callApi(ctx, action, body, { allowError: true, withStatus: true });
const refused = (r, what, message = NO_ROLE) => {
  expect(r.status, what + " is refused: " + JSON.stringify(r.data)).toBe(403);
  expect(r.data.status, what).toBe("error");
  expect(r.data.message, what).toBe(message);
};
const ok200 = (r, what) => {
  expect(r.status, what + ": " + JSON.stringify(r.data)).toBe(200);
  expect(r.data.status, what).toBe("ok");
};
const notAvailable = async (page, roleName) => {
  await expect(page.locator("#roleOffPanel")).toContainText("Not available to you.");
  await expect(page.locator("#roleOffPanel")).toContainText(`Your role (${roleName}) doesn't include this page.`);
};
// A code no other run or test has: "RLM1K3X9Q1AB".
const newCode = (prefix) => slug(prefix).toUpperCase().slice(0, 24);
const anEmail = () => slug("dr") + "@example.com";

// A code made through the owner's session: 10% off at `shop`, 50 uses, once per email.
async function makeCode(api, shop, fields = {}) {
  const r = await api("saveDiscountCode", { code: { code: newCode("dr"), kind: "percent", percent: 10, orgId: shop.orgId, maxUses: 50,
    oncePerEmail: true, expiresOn: FAR, note: "Made by the roles spec", ...fields } });
  return r.code;
}
const codeOf = async (api, id) => (await api("getDiscountCode", { id })).code;
const gone = async (api, id) => (await api("getDiscountCode", { id }, { allowError: true, withStatus: true })).status === 404;

// The request each action takes, for code `c` at `shop`.
const bodies = (shop, c) => ({
  listDiscountCodes: { q: c.code },
  getDiscountCode: { id: c.id },
  saveDiscountCode: { code: { id: c.id, code: c.code, kind: "amount", amount: 50, orgId: shop.orgId, maxUses: 99, expiresOn: "", note: "Changed by someone who may not" } },
  createDiscountCodes: { emails: [anEmail()], kind: "percent", percent: 50, org: shop.orgId, expiresOn: FAR, note: "Never made" },
  setDiscountCodeActive: { id: c.id, active: false },
  deleteDiscountCode: { id: c.id },
});
// A new code by someone who may not.
const newBody = (shop) => ({ code: { code: newCode("nv"), kind: "percent", percent: 5, orgId: shop.orgId, maxUses: 1 } });

// An order placed at the shop's own address with `code` (the storefront's request, as a customer sends it).
async function orderWithCode(request, shop, code, email) {
  const orderId = "DR-" + slug("o").toUpperCase().slice(0, 20);
  const res = await request.post(shopUrl(shop.subdomain) + "/api/orders", {
    headers: { Origin: shopUrl(shop.subdomain) },
    data: { orderId, orgId: shop.orgId, customerName: "Pat Example", contact: email, paymentMethod: "Check",
      items: [{ productId: shop.products[0].productId, name: shop.products[0].name, size: "OSFA", qty: 1 }], discountCode: code },
  });
  return { orderId, status: res.status(), data: await res.json() };
}

// The list, searched for one code: its row.
async function findRow(page, code) {
  await page.locator("#dcQ").fill(code);
  const row = page.locator("#dcBody tr[data-dc-row]", { hasText: code });
  await expect(row).toHaveCount(1);
  await expect(page.locator("#dcBody tr[data-dc-row]")).toHaveCount(1);
  return row;
}
const listShown = async (page) => {
  await expect(page).toHaveTitle(/ — Marketing \(Admin\)$/);
  await expect(page.locator("#dcPage #dcQ")).toBeVisible();
};
const dialog = (page) => page.locator(".admin-modal");
const FIELDS = ["#dcCode", "#dcKind", "#dcValue", "#dcOrg", "#dcMax", "#dcOnce", "#dcExpires", "#dcNote", "#dcActive", 'input[name="dcWho"][value="one"]', 'input[name="dcWho"][value="any"]'];

// ---- Manager: Full ------------------------------------------------------------------------------------------
test("Manager: Discount codes right after Quotes; makes, changes, switches off and deletes a code in the page; a used code is locked and can't be deleted", async ({ api, as }, testInfo) => {
  test.setTimeout(120_000);
  const shop = await makeShop(api, { prefix: "drm", products: [{ name: "Sample Tee", price: 20 }] });
  const mp = await as("manager");
  await openAdmin(mp, "home");
  const tops = await topButtons(mp);
  expect(tops.indexOf("discounts"), "Discount codes sits right after Quotes").toBe(tops.indexOf("quotes") + 1);
  await navBtn(mp).click();
  await expect(mp).toHaveURL(/#discounts$/);
  await listShown(mp);
  await expect(mp.locator("#dcNew")).toBeVisible();
  await expect(mp.locator("#dcBulk")).toBeVisible();

  // + New code: 10% off at the shop, 50 uses, once per email.
  const code = newCode("drm");
  await mp.locator("#dcNew").click();
  const dlg = dialog(mp);
  await expect(dlg.locator("h3")).toHaveText("New discount code");
  await expect(dlg.locator("#dcDelete")).toHaveCount(0);
  await expect(dlg.locator("#dcActive"), "a new code has no on/off tick").toHaveCount(0);
  await dlg.locator("#dcCode").fill(code.toLowerCase());
  await expect(dlg.locator("#dcCode"), "typed in upper case").toHaveValue(code);
  await dlg.locator("#dcKind").selectOption("percent");
  await dlg.locator("#dcValue").fill("10");
  await dlg.locator("#dcOrg").selectOption(shop.orgId);
  await dlg.locator('input[name="dcWho"][value="any"]').check();
  await dlg.locator("#dcMax").fill("50");
  await dlg.locator("#dcOnce").check();
  await dlg.locator("#dcExpires").fill(FAR);
  await dlg.locator("#dcNote").fill("Spring club night");
  const sent = mp.waitForRequest(r => r.url().endsWith("/api/orders") && (r.postDataJSON() || {}).action === "saveDiscountCode");
  await dlg.locator("#dcSave").click();
  expect((await sent).postDataJSON().code).toEqual({ code, kind: "percent", percent: 10, amount: null, maxDiscount: null, minOrder: null, freeShipping: false, orgId: shop.orgId, email: "",
    maxUses: 50, oncePerEmail: true, expiresOn: FAR, note: "Spring club night" });
  await expect(toast(mp)).toContainText(`Code ${code} created.`);
  await expect(dlg).toHaveCount(0);
  const made = (await api("listDiscountCodes", { q: code })).codes;
  expect(made).toHaveLength(1);
  expect(made[0]).toMatchObject({ code, kind: "percent", percent: 10, orgId: shop.orgId, maxUses: 50, oncePerEmail: true, expiresOn: FAR, active: true, used: 0, status: "active" });
  const id = made[0].id;

  // The list's row: code, discount, shop, who, used, status.
  let row = await findRow(mp, code);
  const cells = row.locator("td");
  await expect(cells.nth(0)).toHaveText(code);
  await expect(cells.nth(1)).toHaveText("10% off");
  await expect(cells.nth(2)).toHaveText(shop.name);
  await expect(cells.nth(3)).toHaveText("Anyone, once per email");
  await expect(cells.nth(4)).toHaveText("0 of 50");
  await expect(cells.nth(5)).not.toHaveText("Never");
  await expect(cells.nth(6)).toHaveText("Active");

  // Change it: 15% off and another note.
  await row.locator("a.dc-code").click();
  await expect(dlg.locator("h3")).toHaveText("Discount code " + code);
  await expect(dlg.locator("#dcValue")).toHaveValue("10");
  await expect(dlg.locator("#dcOrg")).toHaveValue(shop.orgId);
  await expect(dlg.locator("#dcMax")).toHaveValue("50");
  await expect(dlg.locator("#dcOnce")).toBeChecked();
  await expect(dlg.locator("#dcActive")).toBeChecked();
  await expect(dlg.locator("#dcDelete")).toBeVisible();
  await expect(dlg).toContainText("Not used yet.");
  await dlg.locator("#dcValue").fill("15");
  await dlg.locator("#dcNote").fill("Spring club night, raised");
  await dlg.locator("#dcSave").click();
  await expect(toast(mp)).toContainText(`Code ${code} saved.`);
  await expect(dlg).toHaveCount(0);
  expect(await codeOf(api, id)).toMatchObject({ percent: 15, note: "Spring club night, raised", active: true });
  await expect(row.locator("td").nth(1)).toHaveText("15% off");

  // Only the tick changed: the switch itself, not a save of the whole code.
  await row.locator("a.dc-code").click();
  await dlg.locator("#dcActive").uncheck();
  const switched = mp.waitForRequest(r => r.url().endsWith("/api/orders") && (r.postDataJSON() || {}).action === "setDiscountCodeActive");
  await dlg.locator("#dcSave").click();
  expect((await switched).postDataJSON()).toMatchObject({ id, active: false });
  await expect(toast(mp)).toContainText(`Code ${code} switched off.`);
  expect(await codeOf(api, id)).toMatchObject({ active: false, status: "off", percent: 15 });
  await expect(row.locator("td").nth(6)).toHaveText("Switched off");

  // Delete it (asks first).
  await row.locator("a.dc-code").click();
  await dlg.locator("#dcDelete").click();
  await confirmDialog(mp, "Delete");
  await expect(toast(mp)).toContainText(`Code ${code} deleted.`);
  expect(await gone(api, id), "the code is gone").toBe(true);
  await expect(mp.locator("#dcBody")).toContainText("No code matches.");

  // A code used on an order: its window is locked to expiry, uses, note and on/off, with no Delete.
  const used = await makeCode(api, shop);
  const customer = await as(null);
  const placed = await orderWithCode(customer.request, shop, used.code, anEmail());
  expect(placed.status, JSON.stringify(placed.data)).toBe(200);
  expect(placed.data).toMatchObject({ status: "ok", discount: 2, discountCode: used.code });
  await openAdmin(mp, "discounts");
  row = await findRow(mp, used.code);
  await expect(row.locator("td").nth(4)).toHaveText("1 of 50");
  await row.locator("a.dc-code").click();
  await expect(dlg.locator(".dc-locked")).toContainText("This code has been used, so only its expiry, uses, note and on/off can change.");
  for (const f of ["#dcCode", "#dcKind", "#dcValue", "#dcOrg", "#dcOnce"]) await expect(dlg.locator(f), f + " is locked once used").toBeDisabled();
  for (const f of ["#dcMax", "#dcExpires", "#dcNote", "#dcActive"]) await expect(dlg.locator(f), f + " can still change").toBeEnabled();
  await expect(dlg.locator("#dcDelete"), "no Delete for a used code").toHaveCount(0);
  await expect(dlg.locator("#dcMake")).toHaveCount(0);
  await expect(dlg.locator("table.dc-uses tbody tr")).toHaveCount(1);
  await expect(dlg.locator("table.dc-uses tbody tr")).toContainText(placed.orderId);
  await expect(dlg.locator("h4.dc-h")).toHaveText("Orders (1)");
  await dlg.locator("#dcMax").fill("60");
  await dlg.locator("#dcSave").click();
  await expect(toast(mp)).toContainText(`Code ${used.code} saved.`);
  expect(await codeOf(api, used.id)).toMatchObject({ maxUses: 60, used: 1, percent: 10 });

  // The Manager's session at the server: the reads, a change, the switch and a delete of an unused code answer; a
  // used code's delete and a change to its value are refused.
  const ctx = await apiContext("manager", testInfo.workerIndex);
  try {
    let r = await tryApi(ctx, "listDiscountCodes", { q: used.code });
    ok200(r, "listDiscountCodes");
    expect(r.data.codes.map(c => c.id)).toEqual([used.id]);
    r = await tryApi(ctx, "getDiscountCode", { id: used.id });
    ok200(r, "getDiscountCode");
    expect(r.data.code.uses.map(u => u.orderId)).toEqual([placed.orderId]);
    r = await tryApi(ctx, "deleteDiscountCode", { id: used.id });
    expect(r.status, "a used code's delete").toBe(409);
    expect(r.data.message).toBe("This code has been used, so it can't be deleted — switch it off instead.");
    r = await tryApi(ctx, "saveDiscountCode", { code: { id: used.id, code: used.code, kind: "percent", percent: 50, orgId: shop.orgId, maxUses: 60, oncePerEmail: true, expiresOn: FAR } });
    expect(r.status, "a used code's value").toBe(400);
    expect(r.data.message).toBe("This code has been used — you can change its expiry, uses, note or switch it off.");
    ok200(await tryApi(ctx, "setDiscountCodeActive", { id: used.id, active: false }), "setDiscountCodeActive");
    r = await tryApi(ctx, "createDiscountCodes", { emails: [anEmail(), "not an email"], kind: "amount", amount: 5, org: shop.orgId, expiresOn: FAR });
    ok200(r, "createDiscountCodes");
    expect(r.data.codes).toHaveLength(1);
    expect(r.data.skipped).toHaveLength(1);
    const bulk = (await api("listDiscountCodes", { q: r.data.codes[0].code })).codes[0];
    expect(bulk).toMatchObject({ kind: "amount", amount: 5, maxUses: 1, email: r.data.codes[0].email });
    ok200(await tryApi(ctx, "deleteDiscountCode", { id: bulk.id }), "deleteDiscountCode of an unused code");
    expect(await gone(api, bulk.id)).toBe(true);
  } finally {
    await ctx.dispose();
  }
  expect(await codeOf(api, used.id)).toMatchObject({ active: false, percent: 10, used: 1 });
});

// ---- Back office: Read ---------------------------------------------------------------------------------------
test("Back office: reads the list and a code's window with every field greyed out and no buttons but Close; the server refuses every write", async ({ api, as }, testInfo) => {
  const shop = await makeShop(api, { prefix: "drb", products: [{ name: "Sample Tee", price: 20 }] });
  const c = await makeCode(api, shop);
  const single = await makeCode(api, shop, { email: "Pat.Example@Example.com", maxUses: 1, oncePerEmail: false, expiresOn: "" });
  expect(single).toMatchObject({ email: "pat.example@example.com", maxUses: 1 });

  const sp = await as("staff");
  await openAdmin(sp, "home");
  const tops = await topButtons(sp);
  expect(tops.indexOf("discounts"), "after Quotes for Back office too").toBe(tops.indexOf("quotes") + 1);
  await navBtn(sp).click();
  await listShown(sp);
  await expect(sp.locator("#dcNew")).toBeHidden();
  await expect(sp.locator("#dcBulk")).toBeHidden();
  let row = await findRow(sp, single.code);
  await expect(row.locator("td").nth(3)).toHaveText("pat.example@example.com");
  await expect(row.locator("td").nth(4)).toHaveText("0 of 1");
  await expect(row.locator("td").nth(5)).toHaveText("Never");

  row = await findRow(sp, c.code);
  await expect(row.locator("td").nth(1)).toHaveText("10% off");
  // Anywhere on the row opens the code.
  await row.locator("td").nth(2).click();
  const dlg = dialog(sp);
  await expect(dlg.locator("h3")).toHaveText("Discount code " + c.code);
  await expect(dlg.locator("#dcCode")).toHaveValue(c.code);
  await expect(dlg.locator("#dcValue")).toHaveValue("10");
  await expect(dlg.locator("#dcNote")).toHaveValue("Made by the roles spec");
  for (const f of FIELDS) await expect(dlg.locator(f), f + " is read-only").toBeDisabled();
  await expect(dlg.locator("#dcSave")).toBeHidden();
  await expect(dlg.locator("#dcMake")).toBeHidden();
  await expect(dlg.locator("#dcDelete")).toHaveCount(0);
  await expect(dlg.locator("#dcCancel")).toHaveText("Close");
  await expect(dlg.locator("#dcCancel")).toBeVisible();
  await expect(dlg).toContainText("Not used yet.");
  await dlg.locator("#dcCancel").click();
  await expect(dlg).toHaveCount(0);

  const ctx = await apiContext("staff", testInfo.workerIndex);
  try {
    const b = bodies(shop, c);
    let r = await tryApi(ctx, "listDiscountCodes", b.listDiscountCodes);
    ok200(r, "listDiscountCodes");
    expect(r.data.codes.map(x => x.id)).toEqual([c.id]);
    r = await tryApi(ctx, "getDiscountCode", b.getDiscountCode);
    ok200(r, "getDiscountCode");
    expect(r.data.code).toMatchObject({ id: c.id, code: c.code, percent: 10, uses: [] });
    for (const a of ["saveDiscountCode", "createDiscountCodes", "setDiscountCodeActive", "deleteDiscountCode"]) refused(await tryApi(ctx, a, b[a]), a);
    refused(await tryApi(ctx, "saveDiscountCode", newBody(shop)), "saveDiscountCode for a new code");
  } finally {
    await ctx.dispose();
  }
  expect(await codeOf(api, c.id)).toMatchObject({ kind: "percent", percent: 10, maxUses: 50, active: true, note: "Made by the roles spec" });
  expect((await api("listDiscountCodes", { org: shop.orgId, q: "Never made" })).total).toBe(0);
});

// ---- Production: none ------------------------------------------------------------------------------------------
test("Production: no Discount codes in the menu, no page, and the server refuses all six actions", async ({ api, as }, testInfo) => {
  const shop = await makeShop(api, { prefix: "drp", products: [{ name: "Sample Tee", price: 20 }] });
  const c = await makeCode(api, shop);
  const pp = await as("production");
  await openAdmin(pp, "home");
  await expect(nav(pp)).toBeVisible();
  expect(await topButtons(pp)).not.toContain("discounts");
  await expect(nav(pp).locator('[data-h="discounts"]')).toHaveCount(0);
  await openAdmin(pp, "discounts");
  await notAvailable(pp, "Production");
  await expect(pp.locator("#dcPage")).toHaveCount(0);

  const ctx = await apiContext("production", testInfo.workerIndex);
  try {
    const b = bodies(shop, c);
    for (const a of ACTIONS) refused(await tryApi(ctx, a, b[a]), a);
    refused(await tryApi(ctx, "saveDiscountCode", newBody(shop)), "saveDiscountCode for a new code");
  } finally {
    await ctx.dispose();
  }
  expect(await codeOf(api, c.id)).toMatchObject({ kind: "percent", percent: 10, active: true });
});

// ---- A custom role: Discount codes at Edit, not Full --------------------------------------------------------------
const strongPassword = () => "Desk-" + crypto.randomBytes(15).toString("base64url");
const client = (workerIndex) => playwrightRequest.newContext({ baseURL: ADMIN, extraHTTPHeaders: { Origin: ADMIN, "CF-Connecting-IP": freshIp(workerIndex) } });

test("A role with Discount codes at Edit makes, changes and switches off codes, but has no Delete and the server refuses deleting", async ({ api, as }, testInfo) => {
  test.setTimeout(120_000);
  const roleName = "Coder " + slug("d").slice(-6);
  const role = (await api("saveRole", { name: roleName, rank: 20, permissions: { fns: { "home.counts": "read", [FN]: "edit" } } }, USERS)).role;
  let userId = null, ctx = null;
  const made = [];
  try {
    expect(role.permissions.fns[FN]).toBe("edit");
    const tag = slug("dc");
    const who = { email: tag + "@example.test", password: strongPassword() };
    const user = await api("create", { name: "Robin Coder " + tag.slice(-4), email: who.email, role: role.key }, USERS);
    userId = user.user.id;
    ctx = await client(testInfo.workerIndex);
    let res = await ctx.post("/api/admin-session", { data: { email: who.email, key: user.temporaryPassword } });
    expect((await res.json()).pending).toBe("password");
    res = await ctx.post("/api/admin-password", { data: { action: "change", current: user.temporaryPassword, next: who.password } });
    expect((await res.json()).status).toBe("ok");
    res = await ctx.post("/api/admin-session", { data: { email: who.email, key: who.password } });
    expect(res.status()).toBe(200);

    const shop = await makeShop(api, { prefix: "drc", products: [{ name: "Sample Tee", price: 20 }] });
    const c = await makeCode(api, shop);
    made.push(c.id);

    // -- The server: everything but the delete.
    const b = bodies(shop, c);
    ok200(await tryApi(ctx, "listDiscountCodes", b.listDiscountCodes), "listDiscountCodes");
    ok200(await tryApi(ctx, "getDiscountCode", b.getDiscountCode), "getDiscountCode");
    refused(await tryApi(ctx, "deleteDiscountCode", b.deleteDiscountCode), "deleteDiscountCode at Edit");
    expect(await codeOf(api, c.id), "the code is still there").toMatchObject({ id: c.id, active: true });
    let r = await tryApi(ctx, "saveDiscountCode", { code: { id: c.id, code: c.code, kind: "amount", amount: 3, orgId: shop.orgId, maxUses: 20, expiresOn: FAR } });
    ok200(r, "saveDiscountCode");
    expect(r.data.code).toMatchObject({ kind: "amount", amount: 3, maxUses: 20, oncePerEmail: false, label: "$3.00 off" });
    ok200(await tryApi(ctx, "setDiscountCodeActive", { id: c.id, active: false }), "setDiscountCodeActive");
    r = await tryApi(ctx, "createDiscountCodes", { emails: [anEmail()], kind: "percent", percent: 5, org: shop.orgId, expiresOn: FAR });
    ok200(r, "createDiscountCodes");
    const bulk = (await api("listDiscountCodes", { q: r.data.codes[0].code })).codes[0];
    made.push(bulk.id);
    refused(await tryApi(ctx, "deleteDiscountCode", { id: bulk.id }), "deleteDiscountCode of a fresh code at Edit");

    // -- The page: New code and the list-of-emails button, a code made and switched off, no Delete.
    const cp = await as(null);
    await cp.goto(ADMIN + "/#discounts");
    await signInThroughPage(cp, who);
    await expect(nav(cp)).toBeVisible();
    await openAdmin(cp, "discounts");
    await listShown(cp);
    await expect(navBtn(cp)).toBeVisible();
    await expect(cp.locator("#dcNew")).toBeVisible();
    await expect(cp.locator("#dcBulk")).toBeVisible();
    await cp.locator("#dcNew").click();
    const dlg = dialog(cp);
    await expect(dlg.locator("h3")).toHaveText("New discount code");
    // "Make one" fills in a code from the server's alphabet.
    await dlg.locator("#dcMake").click();
    await expect(dlg.locator("#dcCode")).toHaveValue(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
    const code = newCode("drc");
    await dlg.locator("#dcCode").fill(code);
    await dlg.locator("#dcKind").selectOption("amount");
    await dlg.locator("#dcValue").fill("4");
    await dlg.locator("#dcOrg").selectOption(shop.orgId);
    await dlg.locator('input[name="dcWho"][value="one"]').check();
    await expect(dlg.locator("#dcMax")).toBeHidden();
    await dlg.locator("#dcEmail").fill(anEmail());
    await dlg.locator("#dcSave").click();
    await expect(toast(cp)).toContainText(`Code ${code} created.`);
    const mine = (await api("listDiscountCodes", { q: code })).codes[0];
    made.push(mine.id);
    expect(mine).toMatchObject({ kind: "amount", amount: 4, maxUses: 1, orgId: shop.orgId, createdBy: who.email, label: "$4.00 off" });

    const row = await findRow(cp, code);
    await row.locator("a.dc-code").click();
    await expect(dlg.locator("h3")).toHaveText("Discount code " + code);
    await expect(dlg.locator("#dcSave")).toBeVisible();
    await expect(dlg.locator("#dcDelete"), "no Delete without Full").toHaveCount(0);
    await expect(dlg.locator("#dcCancel")).toHaveText("Cancel");
    await dlg.locator("#dcActive").uncheck();
    await dlg.locator("#dcSave").click();
    await expect(toast(cp)).toContainText(`Code ${code} switched off.`);
    expect(await codeOf(api, mine.id)).toMatchObject({ active: false, status: "off" });
  } finally {
    if (ctx) await ctx.dispose();
    // The owner (Full) deletes what this test made: none of it was used.
    for (const id of made) await api("deleteDiscountCode", { id }, { allowError: true });
    if (userId) {
      await api("setRole", { id: userId, role: "production" }, { ...USERS, allowError: true });
      await api("setStatus", { id: userId, status: "disabled" }, { ...USERS, allowError: true });
    }
    await api("deleteRole", { roleKey: role.key }, { ...USERS, allowError: true });
    expect((await api("listRoles", {}, USERS)).roles.filter(r => r.key === role.key), "this test's role is gone again").toEqual([]);
  }
  for (const id of made) expect(await gone(api, id), "the owner (Full) deleted code " + id).toBe(true);
});
