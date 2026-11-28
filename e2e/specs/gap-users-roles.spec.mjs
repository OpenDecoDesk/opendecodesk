// User management beyond the owner: a user whose role may manage users ("User desk" here, rank 60, with only
// Users and roles at Edit) never hands out, or moves anyone to, a role that ranks at or above their own or that
// can do something their own role can't; never sets up or changes a role to exceed their own; and can't delete
// a role at all (that needs Full). Every refusal is checked on the server's answer, then that nothing changed,
// and the page is checked to not offer it. Then, as the owner, a role is added, edited and deleted through the
// Roles and permissions page, and a role someone holds is refused deletion until they have another.
//
// Everything here is this spec's own: roles and users with unique names, made through the owner's session.
// The built-in roles and the shared users from the setup project are only read, never changed. The roles made
// here are deleted at the end of each test (their users moved to Production first, since a role anyone holds,
// disabled users included, can't be deleted).
import crypto from "node:crypto";
import { request as playwrightRequest } from "@playwright/test";
import { test, expect, ADMIN, openAdmin, toast, confirmDialog, signInThroughPage, readCredentials, callApi, freshIp, slug } from "../fixtures.mjs";

const USERS = { path: "/api/admin-users" };
const strongPassword = () => "Desk-" + crypto.randomBytes(15).toString("base64url");
const menu = (page) => page.getByRole("navigation", { name: "Admin" });

// A request context that is a browser of its own: its own address, the admin's Origin.
const client = () => playwrightRequest.newContext({ baseURL: ADMIN, extraHTTPHeaders: { Origin: ADMIN, "CF-Connecting-IP": freshIp(11) } });

// A user of `role` (a role key) made by the owner, with the temporary password replaced as at a first sign-in.
// Returns { id, email, password, name }.
async function makeUser(api, role, label) {
  const tag = slug("ur");
  const name = label + " " + tag.slice(-4);
  const email = tag + "@example.test";
  const made = await api("create", { name, email, role }, USERS);
  const c = await client();
  let r = await c.post("/api/admin-session", { data: { email, key: made.temporaryPassword } });
  expect((await r.json()).pending).toBe("password");
  const password = strongPassword();
  r = await c.post("/api/admin-password", { data: { action: "change", current: made.temporaryPassword, next: password } });
  expect((await r.json()).status).toBe("ok");
  await c.dispose();
  return { id: made.user.id, email, password, name };
}

// That user's own API, signed in with their password (the session cookie is the credential, as in the page).
async function signedIn(u) {
  const c = await client();
  const r = await c.post("/api/admin-session", { data: { email: u.email, key: u.password } });
  expect(r.status()).toBe(200);
  const body = await r.json();
  expect(body.status).toBe("ok");
  expect(body.pending).toBeFalsy();
  return { ctx: c, call: (action, data = {}) => callApi(c, action, data, { ...USERS, allowError: true, withStatus: true }) };
}

// The roles this spec works with:
//   desk    "User desk …", rank 60 (between Back office 50 and Manager 75): only Users and roles, at Edit;
//   junior  "Desk junior …", rank 30: only Users and roles, at Read — within the desk's own, so the desk may give it.
// And D, a user with the desk role.
async function makeDesk(api) {
  const tag = slug("d").slice(-6);
  const desk = (await api("saveRole", { name: "User desk " + tag, rank: 60, permissions: { fns: { "settings.users": "edit" } } }, USERS)).role;
  const junior = (await api("saveRole", { name: "Desk junior " + tag, rank: 30, permissions: { fns: { "settings.users": "read" } } }, USERS)).role;
  expect(desk.rank).toBe(60);
  expect(junior.rank).toBe(30);
  const D = await makeUser(api, desk.key, "Dana Desk");
  return { desk, junior, D };
}

// The owner's view of the users and roles, to check that nothing changed after a refusal.
const userByEmail = async (api, email) => (await api("list", {}, USERS)).users.find(u => u.email === email) || null;
const roleByKey = async (api, key) => (await api("listRoles", {}, USERS)).roles.find(r => r.key === key) || null;

// Moves this test's users off its roles (to Production) and deletes the roles. Runs after a failure too.
async function cleanUp(api, userIds, roleKeys) {
  for (const id of userIds) if (id) await api("setRole", { id, role: "production" }, { ...USERS, allowError: true });
  for (const key of roleKeys) if (key) await api("deleteRole", { roleKey: key }, { ...USERS, allowError: true });
  const left = (await api("listRoles", {}, USERS)).roles.filter(r => roleKeys.includes(r.key));
  expect(left.map(r => r.name), "this test's roles are gone again").toEqual([]);
}

// The desk user's browser, signed in through the page and on Settings → Users.
async function deskPage(as, D) {
  const page = await as(null);
  await page.goto(ADMIN + "/#users");
  await signInThroughPage(page, D);
  await expect(menu(page)).toBeVisible();
  await openAdmin(page, "users");
  await expect(page.locator("#usersTable")).toBeVisible();
  return page;
}

test.describe("no role beyond your own", () => {
  test("a user manager can't give, or move someone to, a role stronger than their own", async ({ api, as }) => {
    const { desk, junior, D } = await makeDesk(api);
    let P = null, J = null, d = null;
    try {
      P = await makeUser(api, "production", "Pat Production");
      d = await signedIn(D);

      // Creating a user: Production and Back office rank below the desk but can do what it can't; Manager and
      // Admin rank above it; the desk's own role ranks the same. All refused, and no user is made.
      const refusedEmails = [];
      const tryCreate = async (role) => {
        const email = slug("nope") + "@example.test";
        refusedEmails.push(email);
        return d.call("create", { name: "Not Made", email, role });
      };
      for (const role of ["production", "staff"]) {
        const r = await tryCreate(role);
        expect(r.status, "create as " + role).toBe(403);
        expect(r.data.message).toMatch(/^That role can do more than your own role can \(.+\)\. Ask an admin\.$/);
        expect(r.data.temporaryPassword).toBeUndefined();
      }
      for (const role of ["manager", "admin", desk.key]) {
        const r = await tryCreate(role);
        expect(r.status, "create as " + role).toBe(403);
        expect(r.data.message).toBe("You can only give a role that ranks below your own.");
        expect(r.data.temporaryPassword).toBeUndefined();
      }
      const everyone = (await api("list", {}, USERS)).users.map(u => u.email);
      for (const email of refusedEmails) expect(everyone, "no user was made for " + email).not.toContain(email);

      // A role within the desk's own it may give: a user of the junior role is made.
      const madeJ = await d.call("create", { name: "Jo Junior " + slug("j").slice(-4), email: slug("jo") + "@example.test", role: junior.key });
      expect(madeJ.status).toBe(200);
      expect(madeJ.data.user.role).toBe(junior.key);
      expect(madeJ.data.temporaryPassword).toBeTruthy();
      J = madeJ.data.user;

      // P has Production, which can do more than the desk: P's password, role and status are out of the desk's reach.
      let r = await d.call("resetPassword", { id: P.id });
      expect(r.status).toBe(403);
      expect(r.data.message).toBe("This user's role can do more than your own role can, so only an admin can change them.");
      expect(r.data.temporaryPassword).toBeUndefined();
      r = await d.call("setRole", { id: P.id, role: junior.key });
      expect(r.status).toBe(403);
      expect(r.data.message).toBe("This user's role can do more than your own role can, so only an admin can change them.");
      r = await d.call("setStatus", { id: P.id, status: "disabled" });
      expect(r.status).toBe(403);
      const pAfter = await userByEmail(api, P.email);
      expect(pAfter.role).toBe("production");
      expect(pAfter.status).toBe("active");
      expect(pAfter.mustChangePassword).toBe(false);
      // P's own password still signs in, with nothing owed.
      const p = await signedIn(P);
      await p.ctx.dispose();

      // J the desk may change — but never move to a role stronger than the desk's own.
      for (const [role, message] of [
        ["production", /^That role can do more than your own role can \(.+\)\. Ask an admin\.$/],
        ["staff", /^That role can do more than your own role can \(.+\)\. Ask an admin\.$/],
        [desk.key, /^You can only give a role that ranks below your own\.$/],
        ["manager", /^You can only give a role that ranks below your own\.$/],
        ["admin", /^You can only give a role that ranks below your own\.$/],
      ]) {
        r = await d.call("setRole", { id: J.id, role });
        expect(r.status, "move J to " + role).toBe(403);
        expect(r.data.message).toMatch(message);
      }
      expect((await userByEmail(api, J.email)).role).toBe(junior.key);

      // The page offers none of it. The Add user role list has only roles within the desk's own.
      const page = await deskPage(as, D);
      const addRole = page.locator("#userForm #userRole");
      await expect(addRole).toBeVisible();
      const offered = (await addRole.locator("option").allTextContents()).map(s => s.trim());
      expect(offered).toContain(junior.name);
      for (const name of ["Production", "Back office", "Manager", "Admin", "Read only", desk.name]) expect(offered, "Add user offers " + name).not.toContain(name);
      // P's row: no role picker, no Reset password, no Disable — and it says why.
      const pRow = page.locator("#usersTable tr", { hasText: P.email });
      await expect(pRow).toContainText("Production");
      await expect(pRow).toContainText("Their role can do more than yours");
      await expect(pRow.locator("select.user-role")).toHaveCount(0);
      await expect(pRow.getByRole("button", { name: "Reset password" })).toHaveCount(0);
      await expect(pRow.getByRole("button", { name: "Disable" })).toHaveCount(0);
      // J's row: a role picker without the stronger roles, and the buttons the desk may use.
      const jRow = page.locator("#usersTable tr", { hasText: J.email });
      const jRoles = (await jRow.locator("select.user-role option").allTextContents()).map(s => s.trim());
      expect(jRoles).toContain(junior.name);
      for (const name of ["Production", "Back office", "Manager", "Admin", desk.name]) expect(jRoles, "J's picker offers " + name).not.toContain(name);
      await expect(jRow.getByRole("button", { name: "Reset password" })).toBeVisible();
      // The owner ranks above the desk: shown, not changed.
      const ownerRow = page.locator("#usersTable tr", { hasText: readCredentials().users.owner.email });
      await expect(ownerRow).toContainText("Ranked at or above you");
      await expect(ownerRow.getByRole("button", { name: "Reset password" })).toHaveCount(0);
      // D's own row: no picker either.
      const mine = page.locator("#usersTable tr", { hasText: D.email });
      await expect(mine).toContainText("(you)");
      await expect(mine.locator("select.user-role")).toHaveCount(0);
    } finally {
      if (d) await d.ctx.dispose();
      await cleanUp(api, [D.id, J && J.id], [desk.key, junior.key]);
    }
  });

  test("a user manager can't set up or change a role to exceed their own, nor delete one", async ({ api, as }) => {
    const { desk, junior, D } = await makeDesk(api);
    let d = null;
    try {
      d = await signedIn(D);
      const before = await roleByKey(api, junior.key);

      // A new role ranked at the desk's own rank: refused.
      const tooHigh = "Too high " + slug("t").slice(-5);
      let r = await d.call("saveRole", { name: tooHigh, rank: 60, permissions: { fns: { "settings.users": "read" } } });
      expect(r.status).toBe(403);
      expect(r.data.message).toBe("A role you set up must rank below your own (60).");
      // A new role ranked below, with more than the desk has: Users and roles at Full, or anything else at all.
      const tooMuch = "Too much " + slug("t").slice(-5);
      r = await d.call("saveRole", { name: tooMuch, rank: 20, permissions: { fns: { "settings.users": "full" } } });
      expect(r.status).toBe(403);
      expect(r.data.message).toBe("You can't give a role more than your own role has (settings.users).");
      r = await d.call("saveRole", { name: tooMuch, rank: 20, permissions: { fns: { "settings.users": "read", "orders.details": "read" } } });
      expect(r.status).toBe(403);
      expect(r.data.message).toBe("You can't give a role more than your own role has (orders.details).");
      const names = (await api("listRoles", {}, USERS)).roles.map(x => x.name);
      expect(names).not.toContain(tooHigh);
      expect(names).not.toContain(tooMuch);

      // Changing the junior role (ranked below the desk) to more than the desk has: refused, and it is as it was.
      r = await d.call("saveRole", { roleKey: junior.key, name: junior.name, rank: 30, permissions: { fns: { "settings.users": "read", "home.counts": "read" } } });
      expect(r.status).toBe(403);
      expect(r.data.message).toBe("You can't give a role more than your own role has (home.counts).");
      r = await d.call("saveRole", { roleKey: junior.key, name: junior.name, rank: 60, permissions: { fns: { "settings.users": "read" } } });
      expect(r.status).toBe(403);
      expect(r.data.message).toBe("A role you set up must rank below your own (60).");
      expect(await roleByKey(api, junior.key)).toEqual(before);
      // Its own role, ranked the same as the desk: not the desk's to change.
      const deskBefore = await roleByKey(api, desk.key);
      r = await d.call("saveRole", { roleKey: desk.key, name: desk.name, rank: 30, permissions: { fns: { "settings.users": "read" } } });
      expect(r.status).toBe(403);
      expect(r.data.message).toBe("You can only change a role that ranks below your own.");
      expect(await roleByKey(api, desk.key)).toEqual(deskBefore);
      // Deleting a role needs Users and roles at Full: the desk has Edit.
      r = await d.call("deleteRole", { roleKey: junior.key });
      expect(r.status).toBe(403);
      expect(r.data.message).toBe("Your role can't do this. Ask an admin.");
      expect(await roleByKey(api, junior.key)).toEqual(before);

      // Within its own, the desk may change the junior role.
      r = await d.call("saveRole", { roleKey: junior.key, name: junior.name, rank: 40, permissions: { fns: { "settings.users": "read" } } });
      expect(r.status).toBe(200);
      expect((await roleByKey(api, junior.key)).rank).toBe(40);

      // The page: the junior role's levels above the desk's own can't be picked and the rank stops below 60; the
      // desk's own role is shown but not editable. (Delete role: the next test.)
      const page = await deskPage(as, D);
      await page.getByRole("tab", { name: "Roles and permissions" }).click();
      await page.locator(".role-chip", { hasText: junior.name }).click();
      await expect(page.locator("#roleName")).toHaveValue(junior.name);
      await expect(page.locator("#roleRank")).toHaveAttribute("max", "59");
      await expect(page.locator('input[name="perm-settings.users"][value="full"]')).toBeDisabled();
      await expect(page.locator('input[name="perm-settings.users"][value="edit"]')).toBeEnabled();
      // Switching on a menu the desk has nothing in turns nothing on.
      const ordersMenu = page.locator('.perm-menu-head input[data-menu="orders"]');
      await ordersMenu.click();
      await expect(page.locator('input[name="perm-orders.details"]')).toHaveCount(0);
      await expect(page.locator('.perm-menu-head input[data-menu="orders"]')).not.toBeChecked();
      // What it may do, it does: Users and roles at Edit on the junior role, saved through the page.
      await page.locator('input[name="perm-settings.users"][value="edit"]').check();
      await page.getByRole("button", { name: "Save role" }).click();
      await expect(toast(page)).toContainText("Role saved. It applies at once to everyone who has it.");
      const saved = await roleByKey(api, junior.key);
      expect(saved.permissions.fns["settings.users"]).toBe("edit");
      expect(Object.entries(saved.permissions.fns).filter(([k, v]) => k !== "settings.users" && v !== "none")).toEqual([]);

      await page.locator(".role-chip", { hasText: desk.name }).click();
      await expect(page.locator("#roleName")).toBeDisabled();
      await expect(page.locator(".role-editor")).toContainText("This role ranks at or above yours, so you can see it but not change it.");
      await expect(page.getByRole("button", { name: "Save role" })).toHaveCount(0);
    } finally {
      if (d) await d.ctx.dispose();
      await cleanUp(api, [D.id], [desk.key, junior.key]);
    }
  });

  // deleteRole needs Users and roles at Full (functions/api/admin-users.js), so the Roles tab offers "Delete role" only
  // to Full (fixed 2026-11-23: renderRolesTab_ used to show it to anyone who could edit roles, and the server refused it).
  test("Delete role is not offered to a user manager without Full on Users and roles", async ({ api, as }) => {
    const { desk, junior, D } = await makeDesk(api);
    try {
      const page = await deskPage(as, D);
      await page.getByRole("tab", { name: "Roles and permissions" }).click();
      await page.locator(".role-chip", { hasText: junior.name }).click();
      await expect(page.getByRole("button", { name: "Save role" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Delete role" })).toHaveCount(0, { timeout: 3000 });
    } finally {
      await cleanUp(api, [D.id], [desk.key, junior.key]);
    }
  });
});

test.describe("your own sign-in email", () => {
  // Users → Edit on your own row changes the email you sign in with: a session someone else is holding (an unlocked
  // browser) could move the account to an address of theirs. So it needs your current password, as Change password
  // does. A new name needs nothing.
  test("changing your own email needs your current password; a new name doesn't", async ({ api, as }) => {
    const { desk, junior, D } = await makeDesk(api);
    let d = null;
    try {
      d = await signedIn(D);
      const newEmail = slug("dnew") + "@example.test";
      // On the server: without the password refused, nothing changed and still signed in.
      let r = await d.call("update", { id: D.id, name: D.name, email: newEmail });
      expect(r.status).toBe(403);
      expect(r.data.code).toBe("current_password_needed");
      expect(r.data.message).toBe("Type your current password to change your own sign-in email.");
      expect((await userByEmail(api, D.email)).id).toBe(D.id);
      expect((await d.call("me")).status).toBe(200);
      // A new name on its own is saved with nothing asked.
      r = await d.call("update", { id: D.id, name: D.name + " B", email: D.email });
      expect(r.status).toBe(200);
      expect((await userByEmail(api, D.email)).name).toBe(D.name + " B");

      // In the page: the password field shows only once the email is changed.
      const page = await deskPage(as, D);
      const mine = page.locator("#usersTable tr", { hasText: D.email });
      await mine.getByRole("button", { name: "Edit" }).click();
      const current = page.locator("#userCurrent");
      await expect(current).toBeHidden();
      await page.locator("#userEmail").fill(newEmail);
      await expect(current).toBeVisible();
      await expect(page.getByLabel("Your current password (needed to change the email you sign in with)")).toBeVisible();
      // Saved without it: said by the field, and nothing is sent.
      let sent = 0;
      page.on("request", (q) => { if (q.url().endsWith("/api/admin-users") && (q.postDataJSON() || {}).action === "update") sent++; });
      await page.locator("#userSubmit").click();
      await expect(page.locator("#userCurrentError")).toHaveText("Type your current password to change the email you sign in with.");
      expect(sent).toBe(0);
      // A wrong one: the server's answer by the field, still signed in, nothing changed.
      await current.fill("not my password at all");
      await page.locator("#userSubmit").click();
      await expect(page.locator("#userCurrentError")).toHaveText("The current password is not right.");
      await expect(menu(page)).toBeVisible();
      expect((await userByEmail(api, D.email)).id).toBe(D.id);
      // The right one: saved.
      await current.fill(D.password);
      await page.locator("#userSubmit").click();
      await expect(toast(page)).toContainText("Saved. Sign in with the new email from now on.");
      await expect(page.locator("#usersTable tr", { hasText: newEmail })).toContainText("(you)");
      expect(await userByEmail(api, D.email)).toBeNull();
      expect((await userByEmail(api, newEmail)).id).toBe(D.id);
      // …and D signs in with it.
      const again = await signedIn({ ...D, email: newEmail });
      await again.ctx.dispose();
    } finally {
      if (d) await d.ctx.dispose();
      await cleanUp(api, [D.id], [desk.key, junior.key]);
    }
  });
});

test.describe("roles in the page", () => {
  test("the owner adds a role, changes its rank and deletes it on Roles and permissions", async ({ page, api }) => {
    const roleName = "Rank role " + slug("r").slice(-5);
    let key = null;
    try {
      await openAdmin(page, "users");
      await page.getByRole("tab", { name: "Roles and permissions" }).click();
      await page.getByRole("button", { name: "＋ Add role" }).click();
      await page.locator("#roleName").fill(roleName);
      await page.locator("#roleRank").fill("10");
      await page.getByRole("button", { name: "Add role" }).last().click();
      await expect(toast(page)).toContainText("Role added.");
      const added = (await api("listRoles", {}, USERS)).roles.find(r => r.name === roleName);
      expect(added).toBeTruthy();
      key = added.key;
      expect(added.rank).toBe(10);

      // Open its chip, change the rank to 11 and save: the request names the role by roleKey.
      await page.locator(".role-chip", { hasText: roleName }).click();
      await expect(page.locator("#roleName")).toHaveValue(roleName);
      await page.locator("#roleRank").fill("11");
      const saveReq = page.waitForRequest(r => r.url().endsWith("/api/admin-users") && (r.postDataJSON() || {}).action === "saveRole");
      await page.getByRole("button", { name: "Save role" }).click();
      expect((await saveReq).postDataJSON()).toMatchObject({ action: "saveRole", roleKey: key, name: roleName, rank: 11 });
      await expect(toast(page)).toContainText("Role saved. It applies at once to everyone who has it.");
      expect((await roleByKey(api, key)).rank).toBe(11);
      // Reopened from a fresh load, the rank is 11.
      await openAdmin(page, "users");
      await page.getByRole("tab", { name: "Roles and permissions" }).click();
      await page.locator(".role-chip", { hasText: roleName }).click();
      await expect(page.locator("#roleRank")).toHaveValue("11");

      // Delete role asks first, then deletes it.
      const delReq = page.waitForRequest(r => r.url().endsWith("/api/admin-users") && (r.postDataJSON() || {}).action === "deleteRole");
      await page.getByRole("button", { name: "Delete role" }).click();
      await confirmDialog(page, "Delete role");
      expect((await delReq).postDataJSON()).toMatchObject({ action: "deleteRole", roleKey: key });
      await expect(toast(page)).toContainText("Role deleted.");
      await expect(page.locator(".role-chip", { hasText: roleName })).toHaveCount(0);
      expect(await roleByKey(api, key)).toBeNull();
      key = null;
    } finally {
      if (key) await api("deleteRole", { roleKey: key }, { ...USERS, allowError: true });
    }
  });

  test("a role someone holds can't be deleted, even by the owner, until they have another", async ({ page, api }) => {
    const role = (await api("saveRole", { name: "Held role " + slug("h").slice(-5), rank: 15, permissions: { fns: { "home.counts": "read" } } }, USERS)).role;
    let H = null;
    try {
      H = (await api("create", { name: "Hal Holder " + slug("h").slice(-4), email: slug("hal") + "@example.test", role: role.key }, USERS)).user;

      // In the page: Delete role, confirmed, is refused with the reason, and the role stays.
      await openAdmin(page, "users");
      await page.getByRole("tab", { name: "Roles and permissions" }).click();
      const chip = page.locator(".role-chip", { hasText: role.name });
      await expect(chip).toContainText("1 user");
      await chip.click();
      await page.getByRole("button", { name: "Delete role" }).click();
      await confirmDialog(page, "Delete role");
      await expect(toast(page)).toContainText("Someone still has this role. Give them another role first (disabled users count).");
      await expect(page.locator(".role-chip", { hasText: role.name })).toHaveCount(1);
      expect(await roleByKey(api, role.key)).not.toBeNull();

      // A disabled holder still counts.
      await api("setStatus", { id: H.id, status: "disabled" }, USERS);
      const r = await api("deleteRole", { roleKey: role.key }, { ...USERS, allowError: true, withStatus: true });
      expect(r.status).toBe(409);
      expect(r.data.message).toBe("Someone still has this role. Give them another role first (disabled users count).");
      expect(await roleByKey(api, role.key)).not.toBeNull();
      expect((await userByEmail(api, H.email)).role).toBe(role.key);

      // Once they have another role, Delete role in the page deletes it.
      await api("setRole", { id: H.id, role: "production" }, USERS);
      await openAdmin(page, "users");
      await page.getByRole("tab", { name: "Roles and permissions" }).click();
      await page.locator(".role-chip", { hasText: role.name }).click();
      await expect(page.locator(".role-chip", { hasText: role.name })).toContainText("0 users");
      await page.getByRole("button", { name: "Delete role" }).click();
      await confirmDialog(page, "Delete role");
      await expect(toast(page)).toContainText("Role deleted.");
      await expect(page.locator(".role-chip", { hasText: role.name })).toHaveCount(0);
      expect(await roleByKey(api, role.key)).toBeNull();
    } finally {
      await cleanUp(api, [H && H.id], [role.key]);
    }
  });
});
