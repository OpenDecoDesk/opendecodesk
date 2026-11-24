// Void's password check and one sign-in window (review #52: 52.47, 52.59).
//
// 52.47 — Void asks for the signed-in person's own email and password again before it voids, WITHOUT signing them
// out first (public/admin.js adminConfirmIdentity_ → POST /api/admin-session with `verify`). The server takes the
// password only when it belongs to the user of this session (functions/api/admin-session.js, body.verify), so
// another user's correct email and password — a manager's, typed while someone else is signed in — is refused like a
// wrong one, and the window asks again. Cancel keeps the session and voids nothing. orders.spec covers a wrong
// password and the successful void; this file covers the other user's password and Cancel.
//
// 52.59 — When the session has ended elsewhere, a screen that sends several requests opens ONE sign-in window, not
// one per request (adminLogin shares the sign-in in flight), and says "Your session ended" once (adminApiOnce_ only
// toasts when no sign-in is open yet). Every sign-in window and toast the page adds is recorded as it appears, so a
// window or toast that came and went still counts.
//
// Every test makes its own shop, order and user; nothing install-wide is changed.
import crypto from "node:crypto";
import { request as playwrightRequest } from "@playwright/test";
import { test, expect, openAdmin, navTo, toast, uniq, user, ADMIN, freshIp, slug, signInThroughPage } from "../fixtures.mjs";
import { makeShop, placeOrder } from "../lib/data.mjs";

// ---- helpers ---------------------------------------------------------------------------------------------
const menu = (page) => page.getByRole("navigation", { name: "Admin" });
const orderRow = (page, orderId) => page.locator(`tr[data-order="${orderId}"]`).first();
const actionCell = (page, orderId) => orderRow(page, orderId).locator("td[data-action-td]");
// The shop's Orders page, as a real page load.
const ordersPage = async (page, shop) => {
  if (page.url().startsWith(ADMIN)) await page.goto("about:blank");
  await openAdmin(page, "orders/" + shop.orgId);
  await expect(page.getByRole("combobox", { name: "Shop" })).toHaveValue(shop.orgId);
};

// A request context that is a browser of its own (its own address), optionally with a saved state.
const client = (storageState) => playwrightRequest.newContext({ baseURL: ADMIN, storageState, extraHTTPHeaders: { Origin: ADMIN, "CF-Connecting-IP": freshIp(9) } });

// A user of `role` made by the owner, its temporary password replaced as at a first sign-in (as auth.spec makeUser).
async function makeUser(api, role, label) {
  const tag = slug("u");
  const name = label + " " + tag.slice(-4);
  const email = tag + "@example.test";
  const made = await api("create", { name, email, role }, { path: "/api/admin-users" });
  const c = await client();
  let r = await c.post("/api/admin-session", { data: { email, key: made.temporaryPassword } });
  expect((await r.json()).pending).toBe("password");
  const password = "Gap-" + crypto.randomBytes(15).toString("base64url");
  r = await c.post("/api/admin-password", { data: { action: "change", current: made.temporaryPassword, next: password } });
  expect((await r.json()).status).toBe("ok");
  await c.dispose();
  return { id: made.user.id, email, password, name };
}

// Records, from now on, every sign-in window (the .admin-pass-overlay promptAdminPassphrase adds) and every toast
// the page adds, as they appear. Read back with seen(page).
async function watchWindowsAndToasts(page) {
  await page.evaluate(() => {
    window.__seen = { windows: [], toasts: [] };
    new MutationObserver((list) => {
      for (const m of list) for (const n of m.addedNodes) {
        if (!(n instanceof HTMLElement)) continue;
        if (n.classList.contains("admin-pass-overlay")) window.__seen.windows.push(n.querySelector("#adminEmailInput") ? "sign-in" : "other");
        if (n.classList.contains("toast")) window.__seen.toasts.push(n.textContent);
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
}
const seen = (page) => page.evaluate(() => window.__seen);

// ---- 52.47: Void's password check ------------------------------------------------------------------------
test("Void refuses another user's correct email and password, and Cancel keeps you signed in with the order not voided", async ({ page, api }) => {
  const shop = await makeShop(api, { prefix: "gvoid", products: [{ name: "Sample Tee", price: 20 }] });
  const { orderId: id } = await placeOrder(page, shop, { customer: uniq("Vic Voidcheck") });
  await ordersPage(page, shop);   // signed in as the owner
  const voids = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/api/orders") && /"action":"voidOrder"/.test(r.postData() || "")) voids.push(r.postData());
  });

  await actionCell(page, id).getByRole("button", { name: "Void…" }).click();
  await expect(page.getByText("⚠ Void this order?")).toBeVisible();
  await page.locator("#delReason").fill("Gap test: not to be voided");
  await page.locator("#delConfirm").click();
  const who = () => page.getByRole("dialog", { name: "Confirm it's you to void " + id });
  await expect(who()).toBeVisible();

  // The manager's own, correct email and password — but the owner is the one signed in.
  const manager = user("manager");
  const verify = page.waitForResponse((r) => r.url().endsWith("/api/admin-session") && r.request().method() === "POST");
  await who().getByLabel("Email").fill(manager.email);
  await who().getByLabel("Password").fill(manager.password);
  await who().getByRole("button", { name: "Submit" }).click();
  const answer = await verify;
  expect(JSON.parse(answer.request().postData()).verify).toBe(true);   // a check, not a sign-in
  expect((await answer.json()).verified).toBeFalsy();
  await expect(who().getByRole("alert")).toContainText("don't match");
  // The window asks again; the order is still in the list behind it.
  await expect(who().getByLabel("Password")).toHaveValue("");
  await expect(orderRow(page, id)).toBeVisible();

  // Cancel: the window closes, nothing is voided, and the owner is still signed in.
  await who().getByRole("button", { name: "Cancel" }).click();
  await expect(who()).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Sign in" })).toHaveCount(0);
  await expect(menu(page)).toBeVisible();
  await expect(orderRow(page, id)).toBeVisible();
  await expect(page.locator("#toastRegion .toast", { hasText: "voided" })).toHaveCount(0);
  expect(voids).toEqual([]);

  // A fresh load of the page: no sign-in asked (the session was kept), and the order is still open.
  await ordersPage(page, shop);
  await expect(page.getByRole("dialog", { name: "Sign in" })).toHaveCount(0);
  await expect(orderRow(page, id)).toBeVisible();
  await expect(actionCell(page, id).getByRole("button", { name: "Void…" })).toBeVisible();
  // And the server has it not voided: the owner's own list still has it as open.
  const { orders } = await api("getOrders", { org: shop.orgId });
  const o = orders.find((x) => x.orderId === id);
  expect(o).toBeTruthy();
  expect(o.voidedAt || null).toBeNull();
});

// ---- 52.59: one sign-in window -----------------------------------------------------------------------------
test.describe("a session that ended elsewhere", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("opening another screen shows one Sign in window and one 'Your session ended', and signing in draws Home", async ({ page, api }) => {
    const u = await makeUser(api, "staff", "Ona Onewindow");
    await page.goto(ADMIN + "/");
    await signInThroughPage(page, u);
    await expect(menu(page)).toBeVisible();
    await openAdmin(page, "orders/all");

    // The same session is ended from another place.
    const elsewhere = await client(await page.context().storageState());
    expect((await elsewhere.delete("/api/admin-session")).status()).toBe(200);
    await elsewhere.dispose();

    // The API requests refused from now on for the ended session.
    const refused = [];
    page.on("response", (r) => { if (r.url().includes("/api/") && r.status() === 401) refused.push(r.url()); });
    await watchWindowsAndToasts(page);

    await menu(page).getByRole("button", { name: "Home", exact: true }).click();
    const signIn = page.getByRole("dialog", { name: "Sign in" });
    await expect(signIn).toBeVisible();
    await expect(toast(page)).toContainText("Your session ended — sign in again.");
    // Home's request (getDashboard) has been answered — refused — and there is still only the one window.
    await expect.poll(() => refused.length).toBeGreaterThan(0);
    await expect(signIn).toHaveCount(1);
    await expect(page.locator(".admin-pass-overlay")).toHaveCount(1);
    let s = await seen(page);
    expect(s.windows, "sign-in windows opened").toEqual(["sign-in"]);
    expect(s.toasts.filter((t) => /session ended/i.test(t)), "'session ended' toasts").toHaveLength(1);

    // Signing in again draws Home, with no second window after it.
    await signInThroughPage(page, u);
    await expect(signIn).toHaveCount(0);
    await expect(page).toHaveURL(/#home$/);
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await expect(page.locator("#homeUpdated")).toContainText("Data last updated");
    await expect(menu(page)).toBeVisible();
    s = await seen(page);
    expect(s.windows, "sign-in windows opened").toEqual(["sign-in"]);
    expect(s.toasts.filter((t) => /session ended/i.test(t))).toHaveLength(1);
  });

  // Home sends one request; this screen sends two at once (listThreads and listSpoolSizes), both refused, which is
  // what used to stack a sign-in window per request.
  test("a screen that sends two requests at once still opens one Sign in window, and both go through after signing in", async ({ page, api }) => {
    const u = await makeUser(api, "production", "Tam Twowindow");
    await page.goto(ADMIN + "/");
    await signInThroughPage(page, u);
    await expect(menu(page)).toBeVisible();
    await openAdmin(page, "home");

    const elsewhere = await client(await page.context().storageState());
    expect((await elsewhere.delete("/api/admin-session")).status()).toBe(200);
    await elsewhere.dispose();

    // Each list request's answers, by action, in order.
    const answers = { listThreads: [], listSpoolSizes: [] };
    page.on("response", (r) => {
      if (!r.url().endsWith("/api/orders") || r.request().method() !== "POST") return;
      const action = (JSON.parse(r.request().postData() || "{}")).action;
      if (answers[action]) answers[action].push(r.status());
    });
    await watchWindowsAndToasts(page);

    await navTo(page, "Production", "Threads");
    const signIn = page.getByRole("dialog", { name: "Sign in" });
    await expect(signIn).toBeVisible();
    // Both requests were sent and refused before any sign-in: still one window and one toast.
    await expect.poll(() => [answers.listThreads[0], answers.listSpoolSizes[0]]).toEqual([401, 401]);
    await expect(signIn).toHaveCount(1);
    await expect(page.locator(".admin-pass-overlay")).toHaveCount(1);
    let s = await seen(page);
    expect(s.windows, "sign-in windows opened").toEqual(["sign-in"]);
    expect(s.toasts.filter((t) => /session ended/i.test(t)), "'session ended' toasts").toHaveLength(1);

    // One sign-in answers both: each is sent again once and succeeds, and the Threads page draws.
    await signInThroughPage(page, u);
    await expect(signIn).toHaveCount(0);
    await expect.poll(() => [answers.listThreads, answers.listSpoolSizes]).toEqual([[401, 200], [401, 200]]);
    await expect(page.locator("#thrBody")).not.toContainText("Loading");
    await expect(page.locator("#thrBody")).not.toContainText(/session ended|sign-in required/i);
    s = await seen(page);
    expect(s.windows).toEqual(["sign-in"]);
    expect(s.toasts.filter((t) => /session ended/i.test(t))).toHaveLength(1);
  });
});
