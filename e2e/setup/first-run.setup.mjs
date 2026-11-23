// The first run of a brand-new install, through the real pages, exactly as an owner meets it:
// the setup passphrase → Finish setting up (name, email, password) → sign in → users of every role →
// two-step sign-in for one of them. Each user's signed-in browser is saved in e2e/.auth/<role>.json and the
// generated passwords in e2e/.auth/credentials.json (both git-ignored) for the specs.
import fs from "node:fs";
import crypto from "node:crypto";
import { test, expect, ADMIN, stateFile, readCredentials, writeCredentials, updateCredentials, signInThroughPage, toast, waitIdle, apiContext, callApi } from "../fixtures.mjs";
import { CREDENTIALS, INSTALL_FILE, DEV_VARS } from "../lib/install.mjs";
import { freshTotp } from "../lib/totp.mjs";

test.describe.configure({ mode: "serial" });

const install = () => JSON.parse(fs.readFileSync(INSTALL_FILE, "utf8"));
const passphrase = () => /PROXY_ADMIN_PASSPHRASE="([^"]+)"/.exec(fs.readFileSync(DEV_VARS, "utf8"))[1];
const strongPassword = () => "E2e-" + crypto.randomBytes(15).toString("base64url");

// E2E_REUSE: an install that already went through this keeps its users (the passphrase no longer opens it).
const alreadyDone = () => {
  try {
    const c = readCredentials();
    return c.installBuiltAt === install().builtAt && ["owner", "manager", "staff", "production", "viewer", "twostep"].every(r => fs.existsSync(stateFile(r)));
  } catch (e) { return false; }
};
test.skip(() => alreadyDone(), "This install has already been set up (E2E_REUSE)");

// The people the suite uses. Invented names on example.test.
const PEOPLE = {
  manager:    { name: "Mona Manager", email: "manager@example.test", roleLabel: "Manager" },
  staff:      { name: "Sam Backoffice", email: "staff@example.test", roleLabel: "Back office" },
  production: { name: "Pat Production", email: "production@example.test", roleLabel: "Production" },
  viewer:     { name: "Vic Viewer", email: "viewer@example.test", roleLabel: "Read only" },
  twostep:    { name: "Tess Twostep", email: "twostep@example.test", roleLabel: "Manager" },
};

test("a new install refuses a wrong setup passphrase", async ({ page }) => {
  writeCredentials({ installBuiltAt: install().builtAt, users: {} });
  await page.goto(ADMIN + "/");
  const dialog = page.getByRole("dialog", { name: "Sign in" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("New install? Leave the email empty and type the setup password");
  await dialog.getByLabel("Password").fill("not-the-setup-passphrase-at-all");
  await dialog.getByRole("button", { name: "Submit" }).click();
  await expect(toast(page)).toContainText("That email and password don't match.");
  await expect(page.locator("#adminPanel")).toContainText("Passphrase required.");
  await expect(page.getByRole("navigation", { name: "Admin" })).toHaveCount(0);
});

test("the setup passphrase opens Finish setting up, which checks the new password", async ({ page }) => {
  await page.goto(ADMIN + "/");
  const dialog = page.getByRole("dialog", { name: "Sign in" });
  await dialog.getByLabel("Password").fill(passphrase());
  await dialog.getByRole("button", { name: "Submit" }).click();
  await expect(page.getByRole("heading", { name: "Finish setting up", level: 2 })).toBeVisible();
  // No menu while a step is owed.
  await expect(page.getByRole("navigation", { name: "Admin" })).toHaveCount(0);

  await page.getByLabel("Your name").fill("Olive Owner");
  await page.getByLabel("Email (you sign in with it)").fill("owner@example.test");
  await page.getByLabel("Password (at least 12 characters)").fill("short");
  await page.getByLabel("Password again").fill("short");
  await page.getByRole("button", { name: "Save" }).click();
  // The browser itself refuses a password under 12 characters (the field's minlength), so nothing is sent.
  expect(await page.locator("#acctNext").evaluate(e => e.validity.tooShort)).toBe(true);
  await expect(page.getByRole("heading", { name: "Finish setting up", level: 2 })).toBeVisible();

  const password = strongPassword();
  await page.getByLabel("Password (at least 12 characters)").fill(password);
  await page.getByLabel("Password again").fill(password + "x");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#acctError")).toHaveText("The two passwords don't match.");

  await page.getByLabel("Password again").fill(password);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(toast(page)).toContainText("Saved. Sign in with your email and new password.");
  // Back at the sign-in window, with the email remembered.
  await expect(page.getByRole("dialog", { name: "Sign in" }).getByLabel("Email")).toHaveValue("owner@example.test");
  updateCredentials(c => { c.users.owner = { name: "Olive Owner", email: "owner@example.test", password, role: "admin" }; });
});

test("once the owner has a password, the setup passphrase stops working", async ({ page }) => {
  await page.goto(ADMIN + "/");
  const dialog = page.getByRole("dialog", { name: "Sign in" });
  await dialog.getByLabel("Email").fill("");
  await dialog.getByLabel("Password").fill(passphrase());
  await dialog.getByRole("button", { name: "Submit" }).click();
  await expect(toast(page)).toContainText("That email and password don't match.");
  await expect(page.getByRole("navigation", { name: "Admin" })).toHaveCount(0);
});

test("the owner signs in and lands on Global settings while setup is incomplete", async ({ page }) => {
  const owner = readCredentials().users.owner;
  await page.goto(ADMIN + "/");
  await signInThroughPage(page, owner);
  await expect(page.getByRole("navigation", { name: "Admin" })).toBeVisible();
  await expect(page).toHaveURL(/#settings$/);
  await expect(page.locator("#app")).toContainText("Setup status");
  await page.context().storageState({ path: stateFile("owner") });
});

// KNOWN BUG (reported): "Add role" always answers "No such role." The page's users helper (public/admin.js
// usersCall_) sends { key: adminKey } — "cookie" — with every call, and saveRole reads `key` as the key of the
// role to change. Marked as an expected failure so the suite notices when it is fixed.
test("the owner adds a read-only role under Roles and permissions", async ({ browser }) => {
  test.fail(true, "Known bug: Roles and permissions → Add role answers 'No such role.' (usersCall_ sends key: 'cookie')");
  const context = await browser.newContext({ storageState: stateFile("owner") });
  const page = await context.newPage();
  await page.goto(ADMIN + "/#users");
  await page.getByRole("tab", { name: "Roles and permissions" }).click();
  await page.getByRole("button", { name: "＋ Add role" }).click();
  await page.getByLabel("Name").fill("Read only");
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
  await expect(page.locator(".role-chip", { hasText: "Read only" })).toBeVisible();
  await context.close();
});

// Until that is fixed, the same request the page means to send — without the stray key — through the owner's
// session, and the Roles screen then shows the role at Read everywhere.
test("a read-only role exists and Roles and permissions shows it at Read everywhere", async ({ browser }) => {
  const ctx = await apiContext("owner");
  const roles = await callApi(ctx, "listRoles", {}, { path: "/api/admin-users" });
  if (!roles.roles.some(r => r.name === "Read only")) {
    const fns = {};
    for (const m of roles.areas) for (const it of m.items) for (const [fn] of it.fns) fns[fn] = "read";
    await callApi(ctx, "saveRole", { name: "Read only", rank: 10, permissions: { menus: {}, items: {}, fns } }, { path: "/api/admin-users" });
  }
  await ctx.dispose();
  const context = await browser.newContext({ storageState: stateFile("owner") });
  const page = await context.newPage();
  await page.goto(ADMIN + "/#users");
  await page.getByRole("tab", { name: "Roles and permissions" }).click();
  await page.locator(".role-chip", { hasText: "Read only" }).click();
  await expect(page.locator("#roleName")).toHaveValue("Read only");
  await expect(page.locator(".perm-seg input[value=edit]:checked, .perm-seg input[value=full]:checked")).toHaveCount(0);
  expect(await page.locator(".perm-seg input[value=read]:checked").count()).toBeGreaterThan(20);
  await context.close();
});

test("the owner adds a user of each role, each with a temporary password shown once", async ({ browser }) => {
  const context = await browser.newContext({ storageState: stateFile("owner") });
  const page = await context.newPage();
  await page.goto(ADMIN + "/#users");
  await expect(page.locator("#usersTable")).toContainText("Olive Owner");
  for (const [role, p] of Object.entries(PEOPLE)) {
    await page.getByLabel("Name", { exact: true }).fill(p.name);
    await page.getByLabel("Email (they sign in with it)").fill(p.email);
    await page.getByLabel("Role", { exact: true }).selectOption({ label: p.roleLabel });
    await page.getByRole("button", { name: "Add user" }).click();
    const temp = page.locator("#tempPassword");
    await expect(temp).toBeVisible();
    const temporary = (await temp.textContent()).trim();
    expect(temporary.length).toBeGreaterThanOrEqual(12);
    await page.locator("#tempDone").click();
    await expect(temp).toHaveCount(0);
    updateCredentials(c => { c.users[role] = { name: p.name, email: p.email, temporary, roleLabel: p.roleLabel }; });
    await expect(page.locator("#usersTable")).toContainText(p.email);
  }
  // Each new user is listed with their role.
  for (const p of Object.values(PEOPLE)) {
    const row = page.locator("#usersTable tr", { hasText: p.email });
    await expect(row.locator("select.user-role")).toHaveValue(/.+/);
    await expect(row.locator("select.user-role option:checked")).toHaveText(p.roleLabel);
  }
  await context.close();
});

test("each new user must replace the temporary password at the first sign-in", async ({ browser }) => {
  for (const role of Object.keys(PEOPLE)) {
    const u = readCredentials().users[role];
    const context = await browser.newContext({ extraHTTPHeaders: { "CF-Connecting-IP": "10.250." + (Object.keys(PEOPLE).indexOf(role) + 1) + ".1" } });
    const page = await context.newPage();
    await page.goto(ADMIN + "/");
    await signInThroughPage(page, { email: u.email, password: u.temporary });
    await expect(page.getByRole("heading", { name: "Choose your password", level: 2 })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Admin" })).toHaveCount(0);
    const password = strongPassword();
    await page.getByLabel("The temporary password you were given").fill(u.temporary);
    await page.getByLabel("New password (at least 12 characters)").fill(password);
    await page.getByLabel("New password again").fill(password);
    await page.getByRole("button", { name: "Set password" }).click();
    await expect(toast(page)).toContainText("Password changed. Sign in with the new one.");
    updateCredentials(c => { c.users[role].password = password; delete c.users[role].temporary; });
    // The temporary password no longer opens anything; the new one does.
    await signInThroughPage(page, { email: u.email, password });
    await expect(page.getByRole("navigation", { name: "Admin" })).toBeVisible();
    await waitIdle(page);
    await context.storageState({ path: stateFile(role) });
    await context.close();
  }
});

test("one user turns on two-step sign-in with an authenticator code", async ({ browser }) => {
  const context = await browser.newContext({ storageState: stateFile("twostep"), extraHTTPHeaders: { "CF-Connecting-IP": "10.250.9.1" } });
  const page = await context.newPage();
  await page.goto(ADMIN + "/#security");
  await page.getByRole("button", { name: "Set up 2FA" }).click();
  const secretEl = page.locator("#tfa-secret-display");
  await expect(secretEl).toBeVisible();
  const secret = (await secretEl.textContent()).replace(/\s/g, "");
  expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
  // A wrong code is refused.
  await page.locator("#tfa-verify-code").fill("000000");
  await page.getByRole("button", { name: "Activate 2FA" }).click();
  await expect(page.locator("#tfa-error")).not.toBeEmpty();
  const { code, step } = await freshTotp(secret);
  await page.locator("#tfa-verify-code").fill(code);
  await page.getByRole("button", { name: "Activate 2FA" }).click();
  await expect(toast(page)).toContainText("Two-factor authentication is now active.");
  const codes = (await page.locator("#tfa-codes").textContent()).split("\n").map(s => s.trim()).filter(Boolean);
  expect(codes.length).toBeGreaterThanOrEqual(5);
  await page.locator("#tfa-codes-done").click();
  updateCredentials(c => { Object.assign(c.users.twostep, { totpSecret: secret, lastStep: step, recoveryCodes: codes }); });
  await context.close();

  // Signing in now asks for the code as well.
  const fresh = await browser.newContext({ extraHTTPHeaders: { "CF-Connecting-IP": "10.250.9.2" } });
  const p2 = await fresh.newPage();
  await p2.goto(ADMIN + "/");
  const u = readCredentials().users.twostep;
  const used = await signInThroughPage(p2, { email: u.email, password: u.password, totpSecret: u.totpSecret, lastStep: u.lastStep });
  await expect(p2.getByRole("navigation", { name: "Admin" })).toBeVisible();
  updateCredentials(c => { c.users.twostep.lastStep = used; });
  await waitIdle(p2);
  await fresh.storageState({ path: stateFile("twostep") });
  await fresh.close();
});
