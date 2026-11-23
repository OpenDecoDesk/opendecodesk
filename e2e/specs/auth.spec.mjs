// Signing in and out, two-step sign-in, a session that ends, and what each role may see and do — in the browser,
// with the server checked to refuse what the page hides. Users this spec changes (disables, resets, signs out
// everywhere) are its own, made here; the shared users from the setup project are only signed in as.
import crypto from "node:crypto";
import { request as playwrightRequest } from "@playwright/test";
import { test, expect, ADMIN, openAdmin, navTo, toast, confirmDialog, signInThroughPage, readCredentials, updateCredentials,
  apiContext, callApi, freshIp, slug, waitIdle } from "../fixtures.mjs";

const strongPassword = () => "Auth-" + crypto.randomBytes(15).toString("base64url");

// A request context that is a browser of its own: its own address, the admin's Origin, optionally a saved state.
const client = (storageState) => playwrightRequest.newContext({ baseURL: ADMIN, storageState, extraHTTPHeaders: { Origin: ADMIN, "CF-Connecting-IP": freshIp(7) } });

// A user of `role` made by the owner (temporary password replaced, as at a first sign-in). Returns { id, email, password, name }.
async function makeUser(api, role, label) {
  const tag = slug("u");
  const name = (label || "Una User") + " " + tag.slice(-4);
  const email = tag + "@example.test";
  const made = await api("create", { name, email, role }, { path: "/api/admin-users" });
  const c = await client();
  let r = await c.post("/api/admin-session", { data: { email, key: made.temporaryPassword } });
  expect((await r.json()).pending).toBe("password");
  const password = strongPassword();
  r = await c.post("/api/admin-password", { data: { action: "change", current: made.temporaryPassword, next: password } });
  expect((await r.json()).status).toBe("ok");
  await c.dispose();
  return { id: made.user.id, email, password, name };
}

// Is a cookie session still good? (listOrgs answers anyone signed in.)
async function sessionWorks(storageState) {
  const c = await client(storageState);
  const r = await c.post("/api/orders", { data: { action: "listOrgs" } });
  await c.dispose();
  return r.status() === 200;
}

const menu = (page) => page.getByRole("navigation", { name: "Admin" });

test.describe("signing in and out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("a wrong password and an unknown email get the same refusal, and nothing opens", async ({ page }) => {
    const owner = readCredentials().users.owner;
    await page.goto(ADMIN + "/");
    await signInThroughPage(page, { email: owner.email, password: owner.password + "-wrong" });
    await expect(toast(page)).toContainText("That email and password don't match.");
    await expect(page.locator("#adminPanel")).toContainText("Passphrase required.");
    await expect(menu(page)).toHaveCount(0);

    await page.getByRole("button", { name: "Try again" }).click();
    await signInThroughPage(page, { email: "nobody-" + slug("x") + "@example.test", password: owner.password });
    await expect(toast(page).last()).toContainText("That email and password don't match.");
    await expect(menu(page)).toHaveCount(0);

    // The right password still works afterwards.
    await page.getByRole("button", { name: "Try again" }).click();
    await signInThroughPage(page, owner);
    await expect(menu(page)).toBeVisible();
  });

  test("a user signs in, signs out from the Settings menu, and the old session is dead on the server", async ({ page, api }) => {
    const u = await makeUser(api, "staff", "Sid Signout");
    await page.goto(ADMIN + "/");
    await signInThroughPage(page, u);
    await expect(menu(page)).toBeVisible();
    const signedIn = await page.context().storageState();
    expect(await sessionWorks(signedIn)).toBe(true);

    await menu(page).getByRole("button", { name: "Settings ▾" }).click();
    await menu(page).getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Sign in" })).toBeVisible();
    await expect(menu(page)).toHaveCount(0);
    // The cookie the browser had is refused now, wherever it is replayed from.
    expect(await sessionWorks(signedIn)).toBe(false);
  });

  test("two-step sign-in: a wrong code is refused, the authenticator's code signs in", async ({ page }) => {
    const u = readCredentials().users.twostep;
    await page.goto(ADMIN + "/");
    const dialog = page.getByRole("dialog", { name: "Sign in" });
    await dialog.getByLabel("Email").fill(u.email);
    await dialog.getByLabel("Password").fill(u.password);
    await dialog.getByRole("button", { name: "Submit" }).click();
    await expect(page.locator("#adminTOTPInput")).toBeVisible();
    await page.locator("#adminTOTPInput").fill("000000");
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(menu(page)).toHaveCount(0);
    await expect(page.locator("#adminPanel")).toContainText("Passphrase required.");

    await page.getByRole("button", { name: "Try again" }).click();
    const step = await signInThroughPage(page, { email: u.email, password: u.password, totpSecret: u.totpSecret, lastStep: u.lastStep });
    await expect(menu(page)).toBeVisible();
    updateCredentials(c => { c.users.twostep.lastStep = Math.max(step, c.users.twostep.lastStep || -1); });
    // The password alone never opened it: the server asked for the code.
    const c = await client();
    const r = await c.post("/api/admin-session", { data: { email: u.email, key: u.password } });
    expect((await r.json()).status).toBe("totp_required");
    await c.dispose();
  });

  test("a recovery code signs in once and never again", async ({ page }) => {
    const u = readCredentials().users.twostep;
    const used = new Set(u.usedRecoveryCodes || []);
    const code = u.recoveryCodes.find(x => !used.has(x));
    test.skip(!code, "every recovery code of this install has been used by earlier runs");
    updateCredentials(c => { c.users.twostep.usedRecoveryCodes = [...used, code]; });
    await page.goto(ADMIN + "/");
    const dialog = page.getByRole("dialog", { name: "Sign in" });
    await dialog.getByLabel("Email").fill(u.email);
    await dialog.getByLabel("Password").fill(u.password);
    await dialog.getByRole("button", { name: "Submit" }).click();
    await page.locator("#adminTOTPInput").fill(code);
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(menu(page)).toBeVisible();

    // The same code a second time is refused.
    const c = await client();
    const r = await c.post("/api/admin-session", { data: { email: u.email, key: u.password, totpCode: code } });
    expect(r.status()).toBe(401);
    await c.dispose();
  });

  test("sign-in attempts from one address are limited to 10 a minute", async ({ api }) => {
    const u = await makeUser(api, "production", "Rita Ratelimit");
    const c = await client();
    const answers = [];
    for (let i = 0; i < 11; i++) answers.push((await c.post("/api/admin-session", { data: { email: u.email, key: u.password } })).status());
    await c.dispose();
    // The limit counts every sign-in from the address in the minute; it starts at a minute boundary, so the first
    // ten may straddle two windows — but never all eleven pass.
    expect(answers.filter(s => s === 200).length).toBeGreaterThanOrEqual(10);
    expect(answers).toContain(429);
    // Another address is not affected.
    const other = await client();
    expect((await other.post("/api/admin-session", { data: { email: u.email, key: u.password } })).status()).toBe(200);
    await other.dispose();
  });
});

test.describe("a session that ends", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("after being signed out elsewhere, the next save asks to sign in and then goes through", async ({ page, api }) => {
    const u = await makeUser(api, "staff", "Eve Expiry");
    await page.goto(ADMIN + "/");
    await signInThroughPage(page, u);
    await expect(menu(page)).toBeVisible();
    await openAdmin(page, "abortreasons");

    // The same session is ended from another place (as when it expires or is signed out elsewhere).
    const elsewhere = await client(await page.context().storageState());
    expect((await elsewhere.delete("/api/admin-session")).status()).toBe(200);
    await elsewhere.dispose();

    const reason = "Thread snapped " + slug("r");
    await page.getByRole("button", { name: "+ New reason" }).click();
    const dlg = page.getByRole("dialog", { name: "New reason" });
    await dlg.getByLabel("Reason").fill(reason);
    await dlg.getByRole("button", { name: "Create reason" }).click();
    // Asked to sign in again — and the reason typed isn't lost.
    await signInThroughPage(page, u);
    await expect(toast(page)).toContainText("Reason created.");
    await expect(page.locator("#app")).toContainText(reason);
  });

  test("reloading after the session ended says so and offers to sign in", async ({ page, api }) => {
    const u = await makeUser(api, "staff", "Ray Reload");
    await page.goto(ADMIN + "/");
    await signInThroughPage(page, u);
    await expect(menu(page)).toBeVisible();
    const elsewhere = await client(await page.context().storageState());
    await elsewhere.delete("/api/admin-session");
    await elsewhere.dispose();

    await page.reload();
    await expect(page.locator("#adminPanel")).toContainText("Session expired — please log in again.");
    await expect(menu(page)).toHaveCount(0);
    await page.getByRole("button", { name: "Try again" }).click();
    await signInThroughPage(page, u);
    await expect(menu(page)).toBeVisible();
  });

  test("Sign out everywhere ends the user's sessions in every browser", async ({ page, api, as }) => {
    const u = await makeUser(api, "staff", "Wes Everywhere");
    await page.goto(ADMIN + "/");
    await signInThroughPage(page, u);
    await expect(menu(page)).toBeVisible();
    const other = await as(null);
    await other.goto(ADMIN + "/");
    await signInThroughPage(other, u);
    await expect(menu(other)).toBeVisible();
    const otherState = await other.context().storageState();

    await menu(page).getByRole("button", { name: "Settings ▾" }).click();
    await menu(page).getByRole("button", { name: "Sign out everywhere" }).click();
    await confirmDialog(page);
    await expect(toast(page)).toContainText("Signed out everywhere.");
    await expect(page.getByRole("dialog", { name: "Sign in" })).toBeVisible();
    expect(await sessionWorks(otherState)).toBe(false);
    await other.reload();
    await expect(other.locator("#adminPanel")).toContainText("Session expired — please log in again.");
  });

  test("Change password signs the user out and only the new password works", async ({ page, api }) => {
    const u = await makeUser(api, "production", "Cy Changepw");
    await page.goto(ADMIN + "/");
    await signInThroughPage(page, u);
    await expect(menu(page)).toBeVisible();
    await navTo(page, "Settings", "Change password");
    const next = strongPassword();
    await page.getByLabel("Current password").fill(u.password);
    await page.getByLabel("New password (at least 12 characters)").fill(next);
    await page.getByLabel("New password again").fill(next + "!");
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.locator("#pwError")).toHaveText("The two new passwords don't match.");
    await page.getByLabel("New password again").fill(next);
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(toast(page)).toContainText("Password changed. Sign in with the new one.");

    await signInThroughPage(page, { email: u.email, password: u.password });
    await expect(toast(page).last()).toContainText("That email and password don't match.");
    await page.getByRole("button", { name: "Try again" }).click();
    await signInThroughPage(page, { email: u.email, password: next });
    await expect(menu(page)).toBeVisible();
  });
});

test.describe("users and roles", () => {
  test("Production sees only its pages; others say Not available and the server refuses them", async ({ as, }, testInfo) => {
    const page = await as("production");
    await openAdmin(page, "home");
    for (const name of ["Home", "Orders", "Run Order", "Run Transfer Sheets", "Production ▾", "Settings ▾"]) {
      await expect(menu(page).getByRole("button", { name, exact: true })).toBeVisible();
    }
    for (const name of ["Manage catalog", "Catalog ▾", "Inventory ▾", "Finance ▾", "Reports ▾"]) {
      await expect(menu(page).getByRole("button", { name, exact: true })).toHaveCount(0);
    }
    await menu(page).getByRole("button", { name: "Settings ▾" }).click();
    await expect(menu(page).getByRole("button", { name: "Users", exact: true })).toHaveCount(0);
    await expect(menu(page).getByRole("button", { name: "Security (2FA)" })).toBeVisible();

    for (const hash of ["users", "expenses", "audit", "settings"]) {
      await openAdmin(page, hash);
      await expect(page.locator("#roleOffPanel")).toContainText("Not available to you.");
      await expect(page.locator("#roleOffPanel")).toContainText("Your role (Production)");
    }
    const c = await apiContext("production", testInfo.workerIndex);
    expect((await callApi(c, "getAuditLog", {}, { allowError: true, withStatus: true })).status).toBe(403);
    expect((await callApi(c, "saveHoop", { name: "Nope hoop", widthMm: 100, heightMm: 100 }, { allowError: true, withStatus: true })).status).toBe(403);
    expect((await callApi(c, "list", {}, { path: "/api/admin-users", allowError: true, withStatus: true })).status).toBe(403);
    // What it may read, it gets.
    expect((await callApi(c, "listHoops", {}, { withStatus: true })).status).toBe(200);
    await c.dispose();
  });

  test("Back office works on orders and the catalog but has no Finance, Users or Global settings", async ({ as }, testInfo) => {
    const page = await as("staff");
    await openAdmin(page, "home");
    for (const name of ["Manage catalog", "Catalog ▾", "Production ▾", "Inventory ▾"]) {
      await expect(menu(page).getByRole("button", { name, exact: true })).toBeVisible();
    }
    await expect(menu(page).getByRole("button", { name: "Finance ▾", exact: true })).toHaveCount(0);
    await menu(page).getByRole("button", { name: "Settings ▾" }).click();
    for (const name of ["Global settings", "Users", "Vendor integrations"]) {
      await expect(menu(page).getByRole("button", { name, exact: true })).toHaveCount(0);
    }
    await openAdmin(page, "settings");
    await expect(page.locator("#roleOffPanel")).toContainText("Your role (Back office)");
    const c = await apiContext("staff", testInfo.workerIndex);
    expect((await callApi(c, "updateBusinessProfile", { name: "Not allowed" }, { allowError: true, withStatus: true })).status).toBe(403);
    expect((await callApi(c, "listExpenses", {}, { allowError: true, withStatus: true })).status).toBe(403);
    await c.dispose();
  });

  test("Manager can read Global settings but not save it, and has no Users or Audit log", async ({ as }, testInfo) => {
    const page = await as("manager");
    await openAdmin(page, "home");
    await menu(page).getByRole("button", { name: "Settings ▾" }).click();
    await expect(menu(page).getByRole("button", { name: "Global settings", exact: true })).toBeVisible();
    await expect(menu(page).getByRole("button", { name: "Users", exact: true })).toHaveCount(0);
    await menu(page).getByRole("button", { name: "Reports ▾" }).click();
    await expect(menu(page).getByRole("button", { name: "Audit log", exact: true })).toHaveCount(0);
    await expect(menu(page).getByRole("button", { name: "Revenue report", exact: true })).toBeVisible();

    await openAdmin(page, "settings");
    await expect(page.locator("#app")).toContainText("Setup status");
    await openAdmin(page, "users");
    await expect(page.locator("#roleOffPanel")).toContainText("Your role (Manager)");
    const c = await apiContext("manager", testInfo.workerIndex);
    expect((await callApi(c, "getBusinessProfile", {}, { withStatus: true })).status).toBe(200);
    expect((await callApi(c, "updateBusinessProfile", { name: "Not allowed" }, { allowError: true, withStatus: true })).status).toBe(403);
    expect((await callApi(c, "getAuditLog", {}, { allowError: true, withStatus: true })).status).toBe(403);
    await c.dispose();
  });

  test("Read only sees the pages but no button that changes anything, and the server refuses changes", async ({ as }, testInfo) => {
    const page = await as("viewer");
    await openAdmin(page, "hoops");
    await expect(page.locator("#app")).not.toContainText("Not available to you");
    await expect(page.getByRole("button", { name: "+ New hoop" })).toHaveCount(0);
    await openAdmin(page, "abortreasons");
    await expect(page.getByRole("button", { name: "+ New reason" })).toHaveCount(0);
    await openAdmin(page, "expenses");
    await expect(page.locator("#app")).not.toContainText("Not available to you");
    const c = await apiContext("viewer", testInfo.workerIndex);
    expect((await callApi(c, "listHoops", {}, { withStatus: true })).status).toBe(200);
    expect((await callApi(c, "saveHoop", { name: "Nope hoop", widthMm: 100, heightMm: 100 }, { allowError: true, withStatus: true })).status).toBe(403);
    expect((await callApi(c, "saveExpense", { amount: 1, category: "Supplies", date: "2026-01-01" }, { allowError: true, withStatus: true })).status).toBe(403);
    await c.dispose();
  });

  test("the owner can't change their own role; each other user has a role picker", async ({ page, api }) => {
    const u = await makeUser(api, "production", "Rob Rolepick");
    await openAdmin(page, "users");
    const mine = page.locator("#usersTable tr", { hasText: readCredentials().users.owner.email });
    await expect(mine).toContainText("(you)");
    await expect(mine.locator("select.user-role")).toHaveCount(0);
    const theirs = page.locator("#usersTable tr", { hasText: u.email });
    await expect(theirs.locator("select.user-role")).toBeVisible();

    // Making them Back office asks first and signs them out.
    await theirs.locator("select.user-role").selectOption({ label: "Back office" });
    await confirmDialog(page);
    await expect(toast(page)).toContainText("Role changed.");
    await expect(page.locator("#usersTable tr", { hasText: u.email }).locator("select.user-role option:checked")).toHaveText("Back office");
  });

  test("disabling a user ends their session at once; enabling lets them sign in again", async ({ page, api, as }) => {
    const u = await makeUser(api, "staff", "Dee Disabled");
    const theirPage = await as(null);
    await theirPage.goto(ADMIN + "/");
    await signInThroughPage(theirPage, u);
    await expect(menu(theirPage)).toBeVisible();
    const theirState = await theirPage.context().storageState();

    await openAdmin(page, "users");
    const row = () => page.locator("#usersTable tr", { hasText: u.email });
    await row().getByRole("button", { name: "Disable" }).click();
    await confirmDialog(page);
    await expect(toast(page)).toContainText("Disabled.");
    await expect(row()).toContainText("Disabled");
    expect(await sessionWorks(theirState)).toBe(false);

    // A disabled user can't sign in.
    await theirPage.reload();
    await theirPage.getByRole("button", { name: "Try again" }).click();
    await signInThroughPage(theirPage, u);
    await expect(toast(theirPage).last()).toContainText("That email and password don't match.");

    await row().getByRole("button", { name: "Enable" }).click();
    await expect(toast(page)).toContainText("Enabled.");
    await theirPage.getByRole("button", { name: "Try again" }).click();
    await signInThroughPage(theirPage, u);
    await expect(menu(theirPage)).toBeVisible();
  });

  test("an admin resets a password: the user must choose a new one before anything opens", async ({ page, api, as }) => {
    const u = await makeUser(api, "production", "Ria Reset");
    await openAdmin(page, "users");
    await page.locator("#usersTable tr", { hasText: u.email }).getByRole("button", { name: "Reset password" }).click();
    await confirmDialog(page);
    const temp = (await page.locator("#tempPassword").textContent()).trim();
    await page.locator("#tempDone").click();

    const theirPage = await as(null);
    await theirPage.goto(ADMIN + "/");
    await signInThroughPage(theirPage, { email: u.email, password: u.password });
    await expect(toast(theirPage)).toContainText("That email and password don't match.");
    await theirPage.getByRole("button", { name: "Try again" }).click();
    await signInThroughPage(theirPage, { email: u.email, password: temp });
    await expect(theirPage.getByRole("heading", { name: "Choose your password", level: 2 })).toBeVisible();
    await expect(menu(theirPage)).toHaveCount(0);
    // While that step is owed the server answers nothing else.
    const pending = await client(await theirPage.context().storageState());
    const r = await pending.post("/api/orders", { data: { action: "listHoops" } });
    expect(r.status()).toBeGreaterThanOrEqual(400);
    await pending.dispose();
  });
});

// Roles and permissions → + Add role, through the page (review of the e2e run: usersCall_ sent { key: 'cookie' } with
// every call and saveRole read it as the role to change, so every new role was refused).
test("Roles and permissions: + Add role adds a role (it answered 'No such role.')", async ({ page }) => {
  const roleName = "Viewer " + slug("r").slice(-5);
  await page.goto(ADMIN + "/#users");
  await expect(page.locator("#usersTable")).toBeVisible();
  await page.getByRole("tab", { name: "Roles and permissions" }).click();
  await page.getByRole("button", { name: "＋ Add role" }).click();
  await page.getByLabel("Name").fill(roleName);
  await page.getByLabel(/^Rank/).fill("10");
  // A new role starts from Production's permissions: switch every menu off, then on again — switching a
  // menu on opens each of its pages at Read.
  const menus = page.locator(".perm-menu-head input[type=checkbox]");
  const n = await menus.count();
  expect(n).toBeGreaterThan(5);
  for (let i = 0; i < n; i++) {
    const box = page.locator(".perm-menu-head input[type=checkbox]").nth(i);
    if (await box.isChecked()) await box.uncheck();
    await page.locator(".perm-menu-head input[type=checkbox]").nth(i).check();
  }
  // Nothing above Read anywhere.
  await expect(page.locator(".perm-seg input[value=edit]:checked, .perm-seg input[value=full]:checked")).toHaveCount(0);
  expect(await page.locator(".perm-seg input[value=read]:checked").count()).toBeGreaterThan(20);
  await page.getByRole("button", { name: "Add role" }).last().click();
  await expect(toast(page)).toContainText("Role added.", { timeout: 4000 });
  await expect(page.locator(".role-chip", { hasText: roleName })).toBeVisible();
});
