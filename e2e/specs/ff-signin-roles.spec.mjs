// Sign-in and roles (the second code review's fix-first round):
//   - Turning two-step sign-in on (Settings → Security) asks for the current password again: someone at a signed-in
//     computer left alone can't enrol their own phone. A wrong password is said beside the box and turns nothing
//     on; the right one, with a code from the app, does. The server also takes only a setup key it issued itself.
//   - The account list (listAccounts) carries balances only for a role with Accounts and money. Back office gets
//     the accounts' names — the payment window's account picker still lists them — and no balance.
//   - The screens that start by asking for the accounts are allowed to: a user with only Blanks at Edit opens
//     Receive order and chooses what it was paid from.
// Each test's users, roles, shop and blank are its own, with unique names, made through the owner's session; at the
// end the users are moved to Production and disabled, and the roles deleted. Nothing install-wide changes, and no
// payment or stock is recorded.
import crypto from "node:crypto";
import { request as playwrightRequest } from "@playwright/test";
import { test, expect, ADMIN, openAdmin, signInThroughPage, callApi, apiContext, freshIp, slug, uniq, toast } from "../fixtures.mjs";
import { makeShop } from "../lib/data.mjs";
import { freshTotp } from "../lib/totp.mjs";

const USERS = { path: "/api/admin-users" };
const strongPassword = () => "Desk-" + crypto.randomBytes(15).toString("base64url");
const client = (workerIndex) => playwrightRequest.newContext({ baseURL: ADMIN, extraHTTPHeaders: { Origin: ADMIN, "CF-Connecting-IP": freshIp(workerIndex) } });

// Users made by the owner, each having replaced the temporary password. `people.make(label, role)` takes a built-in
// role's key, or { fns } for a role of its own → { email, password, ctx (their signed-in API), user };
// `people.cleanUp()` puts everything back (after a failure too).
function people(api, workerIndex) {
  const made = [];
  return {
    async make(label, roleOrFns) {
      const entry = { role: null, user: null, ctx: null };
      made.push(entry);
      let roleKey = roleOrFns;
      if (typeof roleOrFns !== "string") {
        entry.role = (await api("saveRole", { name: label + " " + slug("r").slice(-6), rank: 20, permissions: { fns: roleOrFns.fns } }, USERS)).role;
        roleKey = entry.role.key;
      }
      const tag = slug("ff");
      const email = tag + "@example.test";
      const u = await api("create", { name: label + " " + tag.slice(-4), email, role: roleKey }, USERS);
      entry.user = u.user;
      const c = await client(workerIndex);
      let r = await c.post("/api/admin-session", { data: { email, key: u.temporaryPassword } });
      expect((await r.json()).pending).toBe("password");
      const password = strongPassword();
      r = await c.post("/api/admin-password", { data: { action: "change", current: u.temporaryPassword, next: password } });
      expect((await r.json()).status).toBe("ok");
      r = await c.post("/api/admin-session", { data: { email, key: password } });
      expect(r.status()).toBe(200);
      entry.ctx = c;
      return { email, password, ctx: c, user: u.user };
    },
    async cleanUp() {
      for (const { role, user, ctx } of made) {
        if (ctx) await ctx.dispose();
        if (user) {
          await api("reset2fa", { id: user.id }, { ...USERS, allowError: true });
          await api("setRole", { id: user.id, role: "production" }, { ...USERS, allowError: true });
          await api("setStatus", { id: user.id, status: "disabled" }, { ...USERS, allowError: true });
        }
        if (role) await api("deleteRole", { roleKey: role.key }, { ...USERS, allowError: true });
      }
      const keys = made.filter(m => m.role).map(m => m.role.key);
      const left = (await api("listRoles", {}, USERS)).roles.filter(r => keys.includes(r.key));
      expect(left, "this test's roles are gone again").toEqual([]);
    },
  };
}

// What the account list holds for a role kept from the business's money: these four, nothing else.
const NAME_FIELDS = ["active", "id", "name", "type"];
const MONEY_FIELDS = ["balance", "openingBalance", "openingDate", "moves", "csvMapping"];
// Every account the full list had (other specs running alongside may have added more since), by name only.
const expectNamesOnly = (reply, full) => {
  const names = reply.accounts.map(a => a.name);
  for (const a of full.accounts) expect(names).toContain(a.name);
  for (const a of reply.accounts) expect(Object.keys(a).sort()).toEqual(NAME_FIELDS);
  for (const f of MONEY_FIELDS) expect(JSON.stringify(reply), "no " + f + " in the reply").not.toContain('"' + f + '"');
  expect(reply.defaults).toEqual({});
};

test("Security: turning two-step sign-in on asks for the current password — a wrong one is refused beside the box, the right one works", async ({ api, as }, testInfo) => {
  const P = people(api, testInfo.workerIndex);
  try {
    const u = await P.make("Tia Twofactor", "production");
    const page = await as(null);
    await page.goto(ADMIN + "/#security");
    await signInThroughPage(page, u);
    await expect(page.getByRole("navigation", { name: "Admin" })).toBeVisible();
    await openAdmin(page, "security");
    await page.getByRole("button", { name: "Set up 2FA" }).click();
    const secretEl = page.locator("#tfa-secret-display");
    await expect(secretEl).toBeVisible();
    const secret = (await secretEl.textContent()).replace(/\s/g, "");
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    // The password box: labelled, a password manager's "current password", with its own message line.
    const password = page.getByLabel("Current password");
    await expect(password).toBeVisible();
    await expect(password).toHaveAttribute("type", "password");
    await expect(password).toHaveAttribute("autocomplete", "current-password");
    const passwordError = page.locator("#tfa-password-error");
    await expect(passwordError).toHaveAttribute("role", "alert");
    const status = async () => (await (await page.request.post("/api/admin-2fa", { headers: { Origin: ADMIN }, data: { action: "status" } })).json()).enabled;

    // No password: said beside the box, and nothing is sent.
    let sent = 0;
    page.on("request", (req) => { if (req.url().endsWith("/api/admin-2fa") && /"activate"/.test(req.postData() || "")) sent++; });
    await page.locator("#tfa-verify-code").fill((await freshTotp(secret)).code);
    await page.getByRole("button", { name: "Activate 2FA" }).click();
    await expect(passwordError).toHaveText("Enter your current password.");
    expect(sent).toBe(0);

    // A wrong password with a right code: refused with a message beside the box, which is marked and focused.
    await password.fill("not-" + u.password);
    await page.locator("#tfa-verify-code").fill((await freshTotp(secret)).code);
    await page.getByRole("button", { name: "Activate 2FA" }).click();
    await expect(passwordError).toHaveText("The current password is not right.");
    await expect(passwordError).toBeVisible();
    await expect(password).toHaveAttribute("aria-invalid", "true");
    await expect(password).toBeFocused();
    await expect(page.locator("#tfa-error")).toBeEmpty();
    expect(sent).toBe(1);
    expect(await status()).toBe(false);

    // The server takes only a setup key it issued: one made up in the browser is refused, right password or not.
    const madeUp = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
    const direct = await page.request.post("/api/admin-2fa", { headers: { Origin: ADMIN },
      data: { action: "activate", proposedSecret: madeUp, current: u.password, code: (await freshTotp(madeUp)).code } });
    expect(direct.status()).toBe(400);
    expect((await direct.json()).code).toBe("setup_key_expired");
    // …and none at all without the password.
    const noPassword = await page.request.post("/api/admin-2fa", { headers: { Origin: ADMIN },
      data: { action: "activate", proposedSecret: secret, proof: await page.locator("#tfa-proof").inputValue(), code: (await freshTotp(secret)).code } });
    expect(noPassword.status()).toBe(400);
    expect((await noPassword.json()).code).toBe("password_required");
    expect(await status()).toBe(false);

    // The right password with a code from the app turns it on.
    await password.fill(u.password);
    const { code, step } = await freshTotp(secret);
    await page.locator("#tfa-verify-code").fill(code);
    await page.getByRole("button", { name: "Activate 2FA" }).click();
    await expect(toast(page)).toContainText("Two-factor authentication is now active.");
    const codes = (await page.locator("#tfa-codes").textContent()).split("\n").map(s => s.trim()).filter(Boolean);
    expect(codes.length).toBe(10);
    await page.locator("#tfa-codes-done").click();
    await expect(page.locator("#adminPanel")).toContainText("Active");
    expect(await status()).toBe(true);

    // Signing in now asks for a code as well, and a later code gets in.
    const c = await client(testInfo.workerIndex);
    let r = await c.post("/api/admin-session", { data: { email: u.email, key: u.password } });
    expect((await r.json()).status).toBe("totp_required");
    r = await c.post("/api/admin-session", { data: { email: u.email, key: u.password, totpCode: (await freshTotp(secret, step)).code } });
    expect(r.status()).toBe(200);
    await c.dispose();
  } finally {
    await P.cleanUp();
  }
});

test("Back office: the payment window lists the accounts by name, and the account list carries no balance", async ({ api, as }, testInfo) => {
  const shop = await makeShop(api, { prefix: "ffpay", products: [{ name: uniq("Club Cap"), price: 15, type: "cap" }] });
  const orderId = (await api("createLocalSale", { org: shop.orgId, customerName: uniq("Pat Picker"), paymentMethod: "Cash",
    items: [{ productId: shop.products[0].productId, qty: 1 }] })).orderId;
  // What the owner (Accounts and money) gets: every account with what it holds.
  const full = await api("listAccounts");
  expect(full.accounts.length).toBeGreaterThan(1);
  for (const a of full.accounts) { expect(typeof a.balance).toBe("number"); expect(typeof a.openingBalance).toBe("number"); }
  const active = full.accounts.filter(a => a.active).map(a => a.name);
  expect(active.length).toBeGreaterThan(1);

  // A Back office user, asking the server directly: the same accounts, names only.
  const staff = await apiContext("staff", testInfo.workerIndex);
  try {
    expectNamesOnly(await callApi(staff, "listAccounts"), full);
    expectNamesOnly(await callApi(staff, "listAccounts", { asOf: "2030-01-01" }), full);
  } finally { await staff.dispose(); }

  // …and in their Payments window the account picker lists every active account.
  const page = await as("staff");
  await openAdmin(page, "orders/" + shop.orgId);
  await expect(page.getByRole("combobox", { name: "Shop" })).toHaveValue(shop.orgId);
  await page.locator(`tr[data-order="${orderId}"]`).first().locator("td[data-action-td]").getByRole("button", { name: "💰 Payments" }).click();
  const pm = page.locator("#pmContent");
  await expect(pm).toContainText(/Amount due\s*\$15\.00/);
  const picker = pm.locator("#pmAccount");
  await expect(picker).toBeVisible();
  await expect(picker.locator("option")).toHaveText(active);
  // Choosing a method still moves the picker to the account that method usually goes to (by the account's type).
  const cash = full.accounts.find(a => a.active && a.type === "cash");
  if (cash) {
    await pm.locator("#pmMethod").selectOption("cash");
    await expect(picker).toHaveValue(String(cash.id));
  }
  await expect(pm).not.toContainText("NaN");
  await expect(pm).not.toContainText("undefined");
});

test("Blanks at Edit only: Receive order opens and offers what it was paid from", async ({ api, as }, testInfo) => {
  const P = people(api, testInfo.workerIndex);
  try {
    const blank = uniq("Paid From Tee");
    await api("createBlank", { name: blank, productType: "shirt", vendor: "", brand: uniq("Test Blank Co"), sku: "", notes: "", color: "Navy",
      colors: [{ color: "Navy", images: [], sizes: [{ size: "M", quantity: 0, vendorPrice: 4 }] }] });
    const full = await api("listAccounts");
    const active = full.accounts.filter(a => a.active).map(a => a.name);
    const u = await P.make("Bea Blanks", { fns: { "inventory.blanks": "edit" } });

    // The server lets the form's first calls through for this role: the accounts by name only.
    expectNamesOnly(await callApi(u.ctx, "listAccounts"), full);
    // A role that can only look at Blanks can't receive an order, and isn't given the accounts.
    const looker = await P.make("Lou Looker", { fns: { "inventory.blanks": "read" } });
    const refused = await callApi(looker.ctx, "listAccounts", {}, { allowError: true, withStatus: true });
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.data)).not.toContain(active[0]);

    const page = await as(null);
    await page.goto(ADMIN + "/#inventory");
    await signInThroughPage(page, u);
    await expect(page.getByRole("navigation", { name: "Admin" })).toBeVisible();
    await openAdmin(page, "inventory");
    await page.getByRole("button", { name: "Receive order" }).click();
    const dlg = page.getByRole("dialog", { name: "Receive a blank order" });
    await expect(dlg).toBeVisible();
    const paidFrom = dlg.locator("#roPaidFrom");
    await expect(paidFrom).toBeVisible();
    // Every active account by name, then personal funds — not "(accounts unavailable)". Other specs running at the
    // same time may add accounts meanwhile, so the list is checked for these names, not for exactly these.
    const offered = paidFrom.locator("option").filter({ hasNotText: /^Choose…$/ });
    await expect(offered.last()).toHaveText("Personal funds (owner paid)");
    const names = await offered.allTextContents();
    for (const name of active) expect(names).toContain(name);
    await expect(paidFrom).not.toContainText("accounts unavailable");
    // One can be chosen, and the form's own blank is on offer.
    await paidFrom.selectOption({ label: active[0] });
    await expect(paidFrom).toHaveValue(String(full.accounts.find(a => a.name === active[0]).id));
    await expect(dlg.getByRole("combobox", { name: "Blank" }).locator("option", { hasText: blank })).toHaveCount(1);
    await dlg.getByRole("button", { name: "Cancel" }).click();
  } finally {
    await P.cleanUp();
  }
});
