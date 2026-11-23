// The Content-Security-Policy (public/_headers): its script-src runs only script files — no inline <script>, no
// on…="" attribute. This install sends it (wrangler dev reads public/_headers, as Cloudflare does), the browser
// enforces it here, and the pages that used to need inline script still work under it: the label sheets' print
// pop-ups, which used to carry a script of their own. Every other spec fails on anything the policy refuses
// (fixtures.mjs watchCsp), so between them they check the admin's buttons and the shop's page.
import { test, expect, openAdmin, ADMIN, shopUrl, watchCsp, pngBytes } from "../fixtures.mjs";
import { makeShop, placeOrder } from "../lib/data.mjs";

const SCRIPT_SRC = "script-src 'self' https://static.cloudflareinsights.com https://challenges.cloudflare.com";
const scriptSrc = (csp) => (String(csp || "").split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src ")) || "");

test("the admin, a shop and their scripts are sent with the strict script policy", async ({ request, api }) => {
  const shop = await makeShop(api, { prefix: "csp" });
  for (const url of [ADMIN + "/", ADMIN + "/storefront.js", ADMIN + "/admin.js", shopUrl(shop.subdomain) + "/", shopUrl(shop.subdomain) + "/storefront.js"]) {
    const res = await request.get(url);
    expect(res.ok(), url).toBe(true);
    const csp = res.headers()["content-security-policy"];
    expect(scriptSrc(csp), url).toBe(SCRIPT_SRC);
    expect(csp, url).toContain("style-src 'self' 'unsafe-inline'");
  }
  const html = await (await request.get(shopUrl(shop.subdomain) + "/")).text();
  expect(html, "the page loads its script as a file").toContain('<script src="/storefront.js"></script>');
  expect(html.match(/<script\b(?![^>]*\bsrc=)[^>]*>/gi), "no inline <script> in the page").toBeNull();
});

test("the browser enforces it here: an inline handler or inline script is refused", async ({ browser }) => {
  // A context of its own, without the fixtures' check (which would fail this test on purpose).
  const context = await browser.newContext({ storageState: undefined });
  const refused = await watchCsp(context);
  const page = await context.newPage();
  await page.goto(ADMIN + "/");
  await page.evaluate(() => {
    const b = document.createElement("button");
    b.id = "injected"; b.setAttribute("onclick", "window.__inlineRan = true"); b.textContent = "x";
    document.body.appendChild(b);
    const s = document.createElement("script");
    s.textContent = "window.__inlineScriptRan = true";
    document.body.appendChild(s);
  });
  // Clicked from the page's own script: the sign-in window covers the page, and its overlay would take a real click.
  await page.evaluate(() => document.getElementById("injected").click());
  await expect.poll(() => refused.length).toBeGreaterThanOrEqual(2);
  expect(await page.evaluate(() => [window.__inlineRan, window.__inlineScriptRan])).toEqual([undefined, undefined]);
  expect(refused.some((r) => /script-src/.test(r))).toBe(true);
  await context.close();
});

// Stubs print() on the pop-up the page opens (the real one would wait on a print dialog), counting it on the page.
const stubPopupPrint = (page) => page.evaluate(() => {
  const open = window.open;
  window.__printed = 0;
  window.open = function (...args) {
    const w = open.apply(window, args);
    if (w) w.print = () => { window.__printed++; };
    return w;
  };
});

test("the label sheets' print pop-ups print and close without a script of their own", async ({ page, context, api, csp }) => {
  // The branded labels' QR codes come from an outside service: answered here instead (pop-ups included), so the
  // test never reaches it and the pop-up's wait for its pictures ends.
  await context.route("https://api.qrserver.com/**", (route) => route.fulfill({ status: 200, contentType: "image/png", body: pngBytes(20, 20, [0, 0, 0]) }));
  const shop = await makeShop(api, { prefix: "csplbl" });
  await placeOrder(page, shop, {});
  await openAdmin(page, "orders/" + shop.orgId);
  for (const [button, area] of [["Packing labels", "#labelArea"], ["Branded labels", "#blblArea"]]) {
    await openAdmin(page, "orders/" + shop.orgId);
    await page.getByRole("button", { name: button }).click();
    await expect(page.locator(area)).toBeVisible();
    // A control on the sheet (its data-admin-change, not an inline handler) still redraws it.
    await page.locator(".lbl-controls input[type=checkbox]").first().uncheck();
    await expect(page.locator(area)).toBeVisible();
    await stubPopupPrint(page);
    const popupWaiting = page.waitForEvent("popup");
    await page.locator(".lbl-controls").getByRole("button", { name: "Print" }).click();
    const popup = await popupWaiting;
    // It waits for its pictures (the branded labels' QR codes). A new pop-up's very first requests can stall under
    // Playwright's request interception, so a picture still loading after a moment is given a data: picture instead:
    // printing must wait for it, then happen.
    // (A sheet with no pictures may have printed and closed already.)
    await page.waitForTimeout(500);
    const pending = popup.isClosed() ? 0 : await popup.evaluate(() => [...document.images].filter((i) => !i.complete).length).catch(() => 0);
    if (pending) {
      expect(await page.evaluate(() => window.__printed), button + ": not printed while a picture is loading").toBe(0);
      await popup.evaluate((src) => { for (const i of document.images) if (!i.complete) i.src = src; }, "data:image/png;base64," + pngBytes(4, 4, [0, 0, 0]).toString("base64"));
    }
    await expect.poll(() => page.evaluate(() => window.__printed), { message: button + ": printed once" }).toBe(1);
    await expect.poll(() => popup.isClosed(), { message: button + ": the pop-up closed after printing" }).toBe(true);
  }
  expect(csp, "what the Content-Security-Policy refused").toEqual([]);
});
