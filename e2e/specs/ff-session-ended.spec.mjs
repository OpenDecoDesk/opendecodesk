// A session that ends in the middle of the work costs a sign-in, not the work (public/admin.js adminSave_).
//
// Sessions last 24 hours and also end on Sign out everywhere, a role change, Disable or a password reset. Before,
// the product and shop forms only printed "Session expired — please log in again." under the form with no way to
// sign in (leaving the page to do it threw the edits away), and the Local sale window had already closed when the
// refusal arrived, so everything typed in it was gone. What's checked:
//
// - Product edit page: change the name, the session is ended from another place, Save changes → the Sign in window
//   opens over the form (the typed name still in it); signing in sends the same save again and the product is saved —
//   without the page loading again.
// - Shop settings: the same, for the shop's description.
// - Local sale: the window stays open while it asks to sign in. Cancel there leaves the sale as typed, saying nothing
//   was recorded; Record sale again asks to sign in, then records the sale — exactly one order, every request under
//   the window's one key.
//
// Global settings goes the same way (test294 covers it); it isn't changed here because it is the whole install's.
// Every test makes its own shop and its own user (a Manager), signed in through the page; ending that user's
// session touches nobody else's.
import crypto from "node:crypto";
import { request as playwrightRequest } from "@playwright/test";
import { test, expect, openAdmin, toast, uniq, ADMIN, freshIp, slug, signInThroughPage } from "../fixtures.mjs";
import { makeShop } from "../lib/data.mjs";

test.use({ storageState: { cookies: [], origins: [] } });

// ---- helpers ---------------------------------------------------------------------------------------------
const menu = (page) => page.getByRole("navigation", { name: "Admin" });
const signInWindow = (page) => page.getByRole("dialog", { name: "Sign in" });
// A request context that is a browser of its own (its own address), optionally with a saved state.
const client = (storageState) => playwrightRequest.newContext({ baseURL: ADMIN, storageState, extraHTTPHeaders: { Origin: ADMIN, "CF-Connecting-IP": freshIp(11) } });

// A user of `role` made by the owner, its temporary password replaced as at a first sign-in (as auth.spec makeUser).
async function makeUser(api, role, label) {
  const tag = slug("u");
  const name = label + " " + tag.slice(-4);
  const email = tag + "@example.test";
  const made = await api("create", { name, email, role }, { path: "/api/admin-users" });
  const c = await client();
  let r = await c.post("/api/admin-session", { data: { email, key: made.temporaryPassword } });
  expect((await r.json()).pending).toBe("password");
  const password = "Ffe-" + crypto.randomBytes(15).toString("base64url");
  r = await c.post("/api/admin-password", { data: { action: "change", current: made.temporaryPassword, next: password } });
  expect((await r.json()).status).toBe("ok");
  await c.dispose();
  return { id: made.user.id, email, password, name };
}
const signedInAs = async (page, u) => {
  await page.goto(ADMIN + "/");
  await signInThroughPage(page, u);
  await expect(menu(page)).toBeVisible();
};
// Ends the page's session from another place (as Sign out everywhere on another computer would): the page still
// has its cookie and still believes it is signed in.
const endSession = async (page) => {
  const elsewhere = await client(await page.context().storageState());
  expect((await elsewhere.delete("/api/admin-session")).status()).toBe(200);
  await elsewhere.dispose();
};
// From now on: the requests of one action the page sends, and the API answers that were 401.
const watch = (page, action) => {
  const seen = { sent: [], refused: [] };
  page.on("request", (req) => { if (req.url().endsWith("/api/orders") && new RegExp('"action":"' + action + '"').test(req.postData() || "")) seen.sent.push(JSON.parse(req.postData())); });
  page.on("response", (res) => { if (res.url().includes("/api/orders") && res.status() === 401) seen.refused.push(res.url()); });
  return seen;
};
// A mark on the page that a reload (or any new page load) would wipe.
const markPage = (page) => page.evaluate(() => { window.__ffSamePage = true; });
const samePage = (page) => page.evaluate(() => window.__ffSamePage === true);

// ---- Product form ----------------------------------------------------------------------------------------
test("product page: Save after the session ended asks to sign in, then saves what was typed without reloading", async ({ page, api }) => {
  const shop = await makeShop(api, { prefix: "ffsess", products: [{ name: uniq("Session Tee"), price: 21 }] });
  const product = shop.products[0];
  const u = await makeUser(api, "manager", "Pru Product");
  await signedInAs(page, u);
  await openAdmin(page, "catalog/orgs/" + shop.orgId + "/products/" + product.productId + "/edit");
  await expect(page.locator("#prodFormName")).toHaveValue(product.name);

  const newName = uniq("Session Tee renamed");
  await page.locator("#prodFormName").fill(newName);
  await page.locator("#prodFormSub").fill("Typed before the session ended");
  await markPage(page);
  const seen = watch(page, "updateProduct");
  await endSession(page);

  await page.getByRole("button", { name: "Save changes" }).first().click();
  // The sign-in window, over the form as it was typed — not "Session expired" under it.
  await expect(signInWindow(page)).toBeVisible();
  await expect(toast(page)).toContainText("Your session ended — sign in again.");
  await expect(page.locator("#prodFormName")).toHaveValue(newName);
  await expect(page.locator("#prodFormSub")).toHaveValue("Typed before the session ended");
  await expect(page.locator("#prodFormError")).toHaveText("");
  await expect(page).toHaveURL(new RegExp("/products/" + product.productId + "/edit$"));
  expect(seen.refused.length, "the save was refused once").toBe(1);

  await signInThroughPage(page, u);
  // Saved: the form's usual end (the toast, back on the shop's products), on the same page load.
  await expect(toast(page)).toContainText("Saved.");
  await expect(page).toHaveURL(new RegExp("#catalog/orgs/" + shop.orgId + "/products$"));
  await expect(signInWindow(page)).toHaveCount(0);
  await expect(page.locator("#app")).toContainText(newName);
  expect(await samePage(page), "the page was not loaded again").toBe(true);
  // The same save, sent twice: refused, then accepted.
  expect(seen.sent).toHaveLength(2);
  expect(seen.sent[1]).toEqual(seen.sent[0]);
  const saved = (await api("listProducts", { org: shop.orgId })).products.find(p => p.productId === product.productId);
  expect(saved.name).toBe(newName);
  expect(saved.sub).toBe("Typed before the session ended");
});

// ---- Shop form -------------------------------------------------------------------------------------------
test("shop settings: Save after the session ended asks to sign in, then saves what was typed without reloading", async ({ page, api }) => {
  const shop = await makeShop(api, { prefix: "ffsess", products: [{ name: uniq("Session Cap"), price: 18 }] });
  const u = await makeUser(api, "manager", "Shay Shopform");
  await signedInAs(page, u);
  await openAdmin(page, "catalog/orgs/" + shop.orgId + "/edit");
  await expect(page.getByRole("heading", { name: "Shop settings", level: 2 })).toBeVisible();
  await expect(page.locator("#orgFormName")).toHaveValue(shop.name);

  const newDesc = "Described while the session was ending — " + uniq("note");
  await page.locator("#orgFormDesc").fill(newDesc);
  await markPage(page);
  const seen = watch(page, "updateOrg");
  await endSession(page);

  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(signInWindow(page)).toBeVisible();
  await expect(page.locator("#orgFormDesc")).toHaveValue(newDesc);
  await expect(page.locator("#orgFormError")).toHaveText("");
  await expect(page).toHaveURL(new RegExp("#catalog/orgs/" + shop.orgId + "/edit$"));
  expect(seen.refused.length, "the save was refused once").toBe(1);

  await signInThroughPage(page, u);
  // Saved: back on Manage catalog, on the same page load.
  await expect(page).toHaveURL(/#catalog$/);
  await expect(signInWindow(page)).toHaveCount(0);
  expect(await samePage(page), "the page was not loaded again").toBe(true);
  expect(seen.sent).toHaveLength(2);
  expect(seen.sent[1]).toEqual(seen.sent[0]);
  const saved = (await api("listOrgsAdmin")).orgs.find(o => o.orgId === shop.orgId);
  expect(saved.desc).toBe(newDesc);
});

// ---- Local sale ------------------------------------------------------------------------------------------
test("Local sale: the window stays open through the sign-in, Cancel keeps what was typed, and one order is recorded", async ({ page, api }) => {
  const shop = await makeShop(api, { prefix: "ffsess", products: [{ name: "Sample Tee", price: 20 }] });
  const u = await makeUser(api, "manager", "Lou Localsale");
  const customer = uniq("Walk-in Session");
  await signedInAs(page, u);
  await openAdmin(page, "orders/" + shop.orgId);
  await expect(page.getByRole("combobox", { name: "Shop" })).toHaveValue(shop.orgId);
  await page.getByRole("button", { name: "+ Local sale" }).click();
  const form = page.locator("#localSaleForm");
  await expect(form).toBeVisible();
  await form.locator("#lsProduct").selectOption({ label: "Sample Tee" });
  await form.locator("#lsQty").fill("2");
  await form.locator("#lsPayment").selectOption("Cash");
  await form.locator("summary", { hasText: "Customer info" }).click();
  await form.locator("#lsName").fill(customer);
  await form.locator("#lsPaid").check();
  await markPage(page);
  const seen = watch(page, "createLocalSale");
  await endSession(page);

  // Record sale: refused for the ended session. The window is still there under the sign-in.
  await form.getByRole("button", { name: "Record sale" }).click();
  await expect(signInWindow(page)).toBeVisible();
  await expect(form).toBeVisible();
  await expect(form.locator("#lsName")).toHaveValue(customer);
  // Cancel at the sign-in: the sale is as typed, and the window says nothing was recorded.
  await signInWindow(page).getByRole("button", { name: "Cancel" }).click();
  await expect(signInWindow(page)).toHaveCount(0);
  await expect(form.locator("#lsErr")).toHaveText("Nothing was recorded: your session ended. Press Record sale again and sign in.");
  await expect(form.locator("#lsName")).toHaveValue(customer);
  await expect(form.locator("#lsQty")).toHaveValue("2");
  await expect(form.locator("#lsPayment")).toHaveValue("Cash");
  await expect(form.locator("#lsPaid")).toBeChecked();
  expect((await api("getOrders", { org: shop.orgId })).orders.filter(o => o.customerName === customer)).toHaveLength(0);

  // Record sale again: asked to sign in first, then the sale is recorded and the window closes.
  await form.getByRole("button", { name: "Record sale" }).click();
  await signInThroughPage(page, u);
  await expect(toast(page)).toContainText("Local sale recorded — ");
  await expect(form).toHaveCount(0);
  expect(await samePage(page), "the page was not loaded again").toBe(true);

  // Exactly one order, paid once; the refused request and the one that went through carried the same key.
  const mine = (await api("getOrders", { org: shop.orgId })).orders.filter(o => o.customerName === customer);
  expect(mine).toHaveLength(1);
  expect(mine[0].total).toBe(40);
  expect((mine[0].payments || []).filter(p => !p.voidedAt)).toHaveLength(1);
  expect(seen.sent).toHaveLength(2);
  expect(seen.sent[0].requestId).toMatch(/^[0-9a-f]{32}$/);
  expect(seen.sent[1].requestId).toBe(seen.sent[0].requestId);
  expect(seen.refused.length, "refused once, for the ended session").toBe(1);
  await expect(page.locator(`tr[data-order="${mine[0].orderId}"]`).first()).toBeVisible();
});

// The same window when the person signs in straight away: one request refused, the same one accepted, one order.
test("Local sale: signing in when asked records the sale once", async ({ page, api }) => {
  const shop = await makeShop(api, { prefix: "ffsess", products: [{ name: "Sample Tee", price: 20 }] });
  const u = await makeUser(api, "manager", "Lee Localsale");
  const customer = uniq("Walk-in Once");
  await signedInAs(page, u);
  await openAdmin(page, "orders/" + shop.orgId);
  await expect(page.getByRole("combobox", { name: "Shop" })).toHaveValue(shop.orgId);
  await page.getByRole("button", { name: "+ Local sale" }).click();
  const form = page.locator("#localSaleForm");
  await expect(form).toBeVisible();
  await form.locator("#lsProduct").selectOption({ label: "Sample Tee" });
  await form.locator("#lsPayment").selectOption("Cash");
  await form.locator("summary", { hasText: "Customer info" }).click();
  await form.locator("#lsName").fill(customer);
  const seen = watch(page, "createLocalSale");
  await endSession(page);

  await form.getByRole("button", { name: "Record sale" }).click();
  await expect(signInWindow(page)).toBeVisible();
  await expect(form.locator("#lsName")).toHaveValue(customer);
  await signInThroughPage(page, u);
  await expect(toast(page)).toContainText("Local sale recorded — ");
  await expect(form).toHaveCount(0);
  const mine = (await api("getOrders", { org: shop.orgId })).orders.filter(o => o.customerName === customer);
  expect(mine).toHaveLength(1);
  expect(seen.sent).toHaveLength(2);
  expect(seen.sent[1]).toEqual(seen.sent[0]);
});
