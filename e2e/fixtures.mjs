// Shared fixtures and helpers for the end-to-end specs.
//
// Every browser context the suite opens:
//   - says it comes from its own client address (the CF-Connecting-IP header Cloudflare would set). The app
//     limits sign-ins and orders per address per minute; on the real site every person has their own address,
//     here every test does, so one test's sign-ins never spend another's budget. (One test checks the limit.)
//   - serves the public picture addresses (https://images.example.test/…) from the app's own image proxy,
//     which reads the local R2 bucket — the stand-in for the bucket's public domain.
//   - records everything the page's Content-Security-Policy (public/_headers, sent by wrangler dev as by
//     Cloudflare) refuses, and fails the test if anything was: see watchCsp below.
import { test as base, expect, request as playwrightRequest } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { AUTH_DIR, CREDENTIALS, PORT, IMAGES_BASE } from "./lib/install.mjs";
import { freshTotp } from "./lib/totp.mjs";

export { expect };
export const ADMIN = "http://admin.localhost:" + PORT;
export const shopUrl = (subdomain) => "http://" + subdomain + ".localhost:" + PORT;
export const ROLES = ["owner", "manager", "staff", "production", "viewer", "twostep"];
export const stateFile = (role) => path.join(AUTH_DIR, role + ".json");

export function readCredentials() {
  return JSON.parse(fs.readFileSync(CREDENTIALS, "utf8"));
}
export function writeCredentials(c) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  fs.writeFileSync(CREDENTIALS, JSON.stringify(c, null, 2), { mode: 0o600 });
}
export function updateCredentials(fn) {
  const c = fs.existsSync(CREDENTIALS) ? readCredentials() : { users: {} };
  fn(c);
  writeCredentials(c);
  return c;
}
export const user = (role) => readCredentials().users[role];

// A client address no other test uses (10.x.y.z, random within the worker's own /16).
export function freshIp(workerIndex = 0) {
  const b = crypto.randomBytes(2);
  return "10." + (1 + (workerIndex % 250)) + "." + (b[0] % 250 + 1) + "." + (b[1] % 250 + 1);
}

// A name no other run or test has: "Sample Tee k3x9q1".
export const uniq = (prefix) => prefix + " " + Date.now().toString(36).slice(-5) + crypto.randomBytes(2).toString("hex");
export const slug = (prefix) => (prefix + Date.now().toString(36).slice(-5) + crypto.randomBytes(2).toString("hex")).toLowerCase().replace(/[^a-z0-9]/g, "");

// A real PNG, generated: w×h of one colour.
export function pngBytes(w = 64, h = 64, rgb = [30, 120, 200]) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// The public picture addresses, answered from the app's own /api/image-proxy (the local R2 bucket).
export async function serveImages(context) {
  await context.route(IMAGES_BASE + "/**", async (route) => {
    try {
      const res = await route.fetch({ url: ADMIN + "/api/image-proxy?src=" + encodeURIComponent(route.request().url()), headers: {} });
      await route.fulfill({ response: res });
    } catch (e) {
      // The test ended (its page closed) while a picture was still loading: nothing is waiting for it.
      await route.abort().catch(() => {});
    }
  });
}

// ---- The Content-Security-Policy ---------------------------------------------------------------------------
// The policy runs no inline script (no <script> without a src, no on…="" attribute). A control that still had
// an inline handler would do nothing at all, so every page a context opens (pop-ups too) reports each refusal
// two ways: the securitypolicyviolation event, through a binding added before the page's own script runs, and
// the browser's "Refused to …" console message. The returned list is what was refused; the context fixture
// below fails the test when it isn't empty.
export const CSP_CONSOLE = /Content Security Policy|Refused to (?:execute|load|apply|evaluate|run|connect|frame)/i;
export async function watchCsp(context) {
  const refused = [];
  await context.exposeBinding("__e2eCspViolation", (source, text) => { refused.push("event: " + text + " @ " + ((source && source.page && source.page.url()) || "")); });
  await context.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      try { window.__e2eCspViolation(e.violatedDirective + " blocked " + (e.blockedURI || "(inline)") + (e.sample ? " — " + e.sample : "")); } catch (x) {}
    }, true);
  });
  const watch = (p) => p.on("console", (m) => { if (CSP_CONSOLE.test(m.text())) refused.push("console: " + m.text() + " @ " + p.url()); });
  context.pages().forEach(watch);
  context.on("page", watch);
  return refused;
}

// ---- The admin's own API, as a signed-in user's browser calls it ----------------------------------------
// POST /api/orders { action, ... } with that user's session cookie and the same-origin Origin header the
// page sends. (Never the setup passphrase, and no `key` field: the cookie is the credential.)
// Throws on an error answer unless { allowError: true }.
export async function apiContext(role = "owner", workerIndex = 0) {
  return playwrightRequest.newContext({
    baseURL: ADMIN,
    storageState: stateFile(role),
    extraHTTPHeaders: { Origin: ADMIN, "CF-Connecting-IP": freshIp(workerIndex) },
  });
}
export async function callApi(ctx, action, body = {}, opts = {}) {
  const res = await ctx.post(opts.path || "/api/orders", { data: { action, ...body } });
  let data = null;
  try { data = await res.json(); } catch (e) { data = { status: "error", message: "not JSON: " + (await res.text()).slice(0, 200) }; }
  if (!opts.allowError && (!res.ok() || (data && data.status === "error"))) {
    throw new Error("API " + action + " failed (" + res.status() + "): " + JSON.stringify(data).slice(0, 400));
  }
  return opts.withStatus ? { status: res.status(), data } : data;
}

// ---- Signing in through the page ----------------------------------------------------------------------
// Fills the sign-in window (and the two-step code window when asked). Leaves the page where the app goes.
export async function signInThroughPage(page, { email, password, totpSecret = null, lastStep = -1 }) {
  const dialog = page.getByRole("dialog", { name: "Sign in" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Email").fill(email);
  await dialog.getByLabel("Password").fill(password);
  await dialog.getByRole("button", { name: "Submit" }).click();
  if (totpSecret) {
    const codeBox = page.locator("#adminTOTPInput");
    await expect(codeBox).toBeVisible();
    const { code, step } = await freshTotp(totpSecret, lastStep);
    await codeBox.fill(code);
    await page.getByRole("button", { name: "Verify" }).click();
    return step;
  }
  return null;
}

// Leaves the admin page for a blank one. A form left with unsaved changes (window._prodFormDirty: a product or shop
// form, Global settings) would ask the browser to stay; a test that is done with the page doesn't want that, so the
// mark is cleared first.
export async function leaveAdmin(page) {
  await page.evaluate(() => { window._prodFormDirty = false; }).catch(() => {});
  await page.goto("about:blank");
}

// Opens an admin page (#hash) and waits until the menu is there and the page has finished loading. Always a
// fresh load: going to the address the page is already on would only move within it and keep old data.
export async function openAdmin(page, hash = "home") {
  if (page.url().startsWith(ADMIN)) await leaveAdmin(page);
  await page.goto(ADMIN + "/#" + hash);
  await expect(page.getByRole("navigation", { name: "Admin" })).toBeVisible();
  await expect(page.locator("#app")).not.toContainText(/^\s*Loading…\s*$/);
  await waitIdle(page);
}

// Waits until the page has no API call in flight (each screen loads its data after drawing).
export async function waitIdle(page, ms = 300) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(ms);
}

// Opens a menu of the admin bar and clicks one of its pages. The bar can be drawn again while this happens (a list
// arriving), which closes the open menu and leaves the click waiting on a button that is gone; so opening the menu
// and clicking are tried again together, a few seconds at a time, instead of waiting out one long click.
export async function navTo(page, menu, item) {
  const nav = page.getByRole("navigation", { name: "Admin" });
  const target = nav.getByRole("button", { name: item, exact: true }).first();
  await expect(async () => {
    if (menu && !(await target.isVisible())) await nav.getByRole("button", { name: menu + " ▾" }).click({ timeout: 5_000 });
    await target.click({ timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
  await waitIdle(page);
}

// The toast the app shows after most actions.
export const toast = (page) => page.locator("#toastRegion");

// The app's own confirm window: click its button.
export async function confirmDialog(page, buttonName) {
  const dlg = page.getByRole("dialog").last();
  await expect(dlg).toBeVisible();
  if (buttonName) await dlg.getByRole("button", { name: buttonName }).click();
  else await dlg.locator("#cmOk").click();   // the answer button of askConfirm_ (its label follows the question's verb)
}

// ---- Fixtures --------------------------------------------------------------------------------------------
export const test = base.extend({
  // Every test's browser comes from an address of its own (see the top of this file).
  extraHTTPHeaders: async ({}, use, testInfo) => { await use({ "CF-Connecting-IP": freshIp(testInfo.workerIndex) }); },
  // …and whatever the security policy refused on its pages fails the test (`csp` is that list, for a test that
  // checks part-way through).
  context: async ({ context }, use) => {
    await serveImages(context);
    const refused = await watchCsp(context);
    context.cspRefused = refused;
    await use(context);
    expect(refused, "what the Content-Security-Policy refused on this test's pages").toEqual([]);
  },
  csp: async ({ context }, use) => { await use(context.cspRefused); },
  // Errors the page logged (console.error and uncaught exceptions), for tests that assert there are none.
  pageErrors: async ({ page }, use) => {
    const errors = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    await use(errors);
  },
  // The owner's API (signed-in cookie), for making the data a test needs before it opens the page.
  api: async ({}, use, testInfo) => {
    const ctx = await apiContext("owner", testInfo.workerIndex);
    await use((action, body, opts) => callApi(ctx, action, body, opts));
    await ctx.dispose();
  },
  // Another user's browser: const p = await as("staff"); (signed in from the setup project's saved state.)
  as: async ({ browser }, use, testInfo) => {
    const opened = [];
    await use(async (role) => {
      const context = await browser.newContext({ storageState: role ? stateFile(role) : undefined, extraHTTPHeaders: { "CF-Connecting-IP": freshIp(testInfo.workerIndex) } });
      await serveImages(context);
      opened.push({ context, refused: await watchCsp(context) });
      return context.newPage();
    });
    for (const c of opened) await c.context.close();
    expect(opened.flatMap(c => c.refused), "what the Content-Security-Policy refused on the other users' pages").toEqual([]);
  },
});
