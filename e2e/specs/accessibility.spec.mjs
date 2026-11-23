// Accessibility smoke test: every page in the admin's menu is reached with the keyboard alone (Tab to the
// menu, Enter opens a menu, Tab to the page, Enter), draws its own page, and logs no errors to the console;
// and a shop's page and its cart work from the keyboard without console errors.
//
// axe-core is not used: it would be a new dependency, and this smoke test asks the cheaper questions first.
import { test, expect, openAdmin, waitIdle, shopUrl, apiContext, callApi } from "../fixtures.mjs";
import { makeShop } from "../lib/data.mjs";

// The menu as public/admin.js draws it (ADMIN_NAV_GROUPS and the buttons before them): [hash, menu label, page label in
// the menu, page title]. The title is "<business> — <page title> (Admin)"; a few pages name their shop after it.
const TOP = [["home", "Home", "Home"], ["orders", "Orders", "Orders — "], ["runorder", "Run Order", "Run Order"],
  ["runtransfer", "Run Transfer Sheets", "Run Transfer Sheets"], ["catalog", "Manage catalog", "Manage catalog"]];
const GROUPS = {
  Catalog: [["setup", "Shop setup", "shop setup"], ["designs", "Designs", "Designs — "], ["graphics", "Graphics", "Graphics"],
    ["categories", "Product categories", "Product categories"], ["locations", "Decoration locations", "Decoration locations"],
    ["brandrules", "Brand rules", "Brand rules"], ["packages", "Package sizes", "Package sizes"]],
  Production: [["machines", "Machines", "Machines"], ["maintenance", "Machine maintenance", "Machine maintenance"], ["machinefiles", "Machine files", "Machine files"],
    ["hoops", "Hoops", "Hoops"], ["threads", "Threads", "Threads"], ["abortreasons", "Abort reasons", "Abort reasons"]],
  Inventory: [["inventory", "Blanks", "Blanks"], ["blankorder", "Blanks to order", "Blanks to order"], ["transfers", "Transfers", "Transfers"]],
  Finance: [["expenses", "Expenses", "Expenses"], ["money", "Accounts & money", "Accounts & money"], ["reconcile", "Reconcile", "Reconcile"],
    ["accountviewer", "Account viewer", "Account viewer"], ["shoprate", "Shop rate", "Shop rate"]],
  Reports: [["audit", "Audit log", "Audit log"], ["revenue", "Revenue report", "Revenue report"], ["salestax", "Sales tax report", "Sales tax report"],
    ["cogs", "Inventory & COGS", "Inventory & COGS"], ["runreport", "Run times", "Run times"], ["books", "Periods & export", "Periods & export"]],
  Settings: [["settings", "Global settings", "Global settings"], ["vendors", "Vendor integrations", "Vendor integrations"], ["comms", "Communications", "Communications"],
    ["orphans", "Orphaned images", "Orphaned images"], ["users", "Users", "Users"], ["security", "Security (2FA)", "Security"], ["password", "Change password", "Change password"]],
};

// KNOWN BUG (reported): Catalog → Shop setup / Designs / Graphics, chosen from the menu while a shop exists, throw
// "TypeError: Assignment to constant variable" (public/admin.js adminRoute assigns to `const raw`): the address
// changes but the page before stays on screen until a reload.
const KNOWN_BROKEN = new Set(["setup", "designs", "graphics"]);

// Run Order and Machine files look for the optional send-agent: on this computer (http://127.0.0.1:8787/ping,
// which the browser reports as a CORS / ERR_FAILED error when no agent is running) and through the relay
// (/api/agent?op=status, 503 "isn't set up" when AGENT_TOKEN isn't set). With no agent installed these two are
// the expected answers, not faults of the page; nothing else is let through.
const AGENT_PAGES = new Set(["runorder", "machinefiles"]);
const agentNoise = (e) => /127\.0\.0\.1:8787\/ping/.test(e.text + " " + e.url) || (/status of 503/.test(e.text) && /\/api\/agent\?op=status/.test(e.url));

function collectErrors(page) {
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push({ text: m.text(), url: (m.location() || {}).url || "" }); });
  page.on("pageerror", (e) => errors.push({ text: "uncaught: " + e.message, url: "" }));
  return errors;
}

// Tabs forward until `target` has the focus; fails if it isn't reached within `max` presses.
async function tabTo(page, target, max = 40) {
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return i;
    await page.keyboard.press("Tab");
  }
  await expect(target, "reached with Tab").toBeFocused({ timeout: 1 });
}

test.beforeAll(async ({ }, testInfo) => {
  // Shop setup, Designs and Graphics open a shop's page, so there must be one (and the known bug needs one).
  const ctx = await apiContext("owner", testInfo.workerIndex);
  const { orgs } = await callApi(ctx, "listOrgs");
  if (!orgs.length) await makeShop((a, b, o) => callApi(ctx, a, b, o), { prefix: "a11y" });
  await ctx.dispose();
});

test("from the top of the page, Tab reaches the admin menu, with a visible focus ring", async ({ page }) => {
  await openAdmin(page, "home");
  await page.locator("body").focus();
  await page.evaluate(() => { document.activeElement && document.activeElement.blur(); window.scrollTo(0, 0); });
  const home = page.getByRole("navigation", { name: "Admin" }).getByRole("button", { name: "Home", exact: true }).first();
  const presses = await tabTo(page, home, 15);
  expect(presses).toBeGreaterThan(0);
  const ring = await home.evaluate((el) => { const s = getComputedStyle(el); return (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== "none"; });
  expect(ring, "the focused menu button shows a focus ring").toBe(true);
});

const PAGES = [...TOP.map(([h, l, t]) => ({ hash: h, menu: null, label: l, title: t })),
  ...Object.entries(GROUPS).flatMap(([menu, items]) => items.map(([h, l, t]) => ({ hash: h, menu, label: l, title: t })))];

for (const p of PAGES) {
  test(`${p.menu ? p.menu + " → " : ""}${p.label}: reached by keyboard, draws its page, no console errors`, async ({ page }) => {
    if (KNOWN_BROKEN.has(p.hash)) test.fail(true, "Known bug: adminRoute assigns to const raw for #" + p.hash + " (TypeError: Assignment to constant variable)");
    const errors = collectErrors(page);
    // Start somewhere else, so arriving is a change of page.
    const start = p.hash === "home" ? "users" : "home";
    await openAdmin(page, start);
    const nav = page.getByRole("navigation", { name: "Admin" });
    const startTitle = await page.title();
    await nav.getByRole("button", { name: "Home", exact: true }).first().focus();

    if (p.menu) {
      const menuBtn = nav.getByRole("button", { name: p.menu + " ▾" });
      await tabTo(page, menuBtn);
      await page.keyboard.press("Enter");
      const item = nav.locator(".admin-nav-row .admin-nav-group.open .admin-nav-menu").getByRole("button", { name: p.label, exact: true });
      await expect(item).toBeVisible();
      await tabTo(page, item);
    } else {
      await tabTo(page, nav.locator(".admin-nav-row").getByRole("button", { name: p.label, exact: true }));
    }
    await page.keyboard.press("Enter");

    await expect(page).toHaveURL(new RegExp("#" + p.hash + "(/|$)"));
    // The page drew itself: its own title, not the one before.
    await expect(page).not.toHaveTitle(startTitle, { timeout: 5000 });
    await expect(page).toHaveTitle(new RegExp("— (?:[^—]* )?" + p.title.replace(/[()&]/g, (c) => "\\" + c), "i"));
    await waitIdle(page, 600);
    // The menu closed behind it, and the page is still keyboard-reachable from the menu.
    await expect(nav.locator(".admin-nav-group.open")).toHaveCount(0);

    const bad = errors.filter((e) => !(AGENT_PAGES.has(p.hash) && agentNoise(e)));
    expect(bad.map((e) => e.text + (e.url ? " @ " + e.url : "")), "console errors").toEqual([]);
  });
}

test("a shop's page: no console errors, and the cart works from the keyboard", async ({ page, api }) => {
  const errors = collectErrors(page);
  const shop = await makeShop(api, { prefix: "a11yshop", products: [{ name: "Sample Tee", price: 20 }, { name: "Sample Cap", price: 15, type: "cap", idPrefix: "cap" }] });
  await page.goto(shopUrl(shop.subdomain) + "/");
  await expect(page.getByRole("heading", { level: 1, name: shop.name })).toBeVisible();

  // Tab to the first product's Add to cart and press Enter.
  const add = page.getByRole("region", { name: "Shirts" }).getByRole("button", { name: "Add to cart" });
  await page.locator("body").focus();
  await tabTo(page, add, 30);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 2, name: "Your order (1 item)" })).toBeVisible();
  await expect(page.getByRole("status").last()).toContainText("Added Sample Tee to cart.");

  // One more, then one fewer, with Space and Enter.
  const more = page.getByRole("button", { name: "One more Sample Tee" });
  await more.focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("heading", { level: 2, name: "Your order (2 items)" })).toBeVisible();
  await expect(page.locator("main")).toContainText(/Total\s*\$40\.00/);
  await page.getByRole("button", { name: "One fewer Sample Tee" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 2, name: "Your order (1 item)" })).toBeVisible();

  // Delivery with the arrow keys (a radio group).
  await page.getByRole("radio", { name: /^Local pickup/ }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("radio", { name: /^Local delivery/ })).toBeChecked();
  await expect(page.locator("main")).toContainText(/Total\s*\$25\.00/);

  // Remove it: the cart is empty again.
  await page.getByRole("button", { name: "Remove Sample Tee" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("main")).toContainText("Nothing added yet.");
  await expect(page.getByRole("button", { name: "Place order" })).toBeDisabled();
  await waitIdle(page);
  expect(errors.map((e) => e.text + (e.url ? " @ " + e.url : "")), "console errors").toEqual([]);
});
