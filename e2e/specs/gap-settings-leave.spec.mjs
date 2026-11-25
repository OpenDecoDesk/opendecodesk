// Global settings guards unsaved changes, and Save and Discard stay on it (review #110). Typing in the form marks the
// page; going elsewhere then asks "Leave without saving?" (Stay keeps the edit, Leave goes), as the product and shop
// forms do. The old Cancel (which went to Manage catalog) is "Discard changes": it asks, then draws the page again
// from what is saved. A successful Save clears the mark and stays on Global settings.
//
// These settings are install-wide and other specs run beside this one, so nothing here is saved: the edits are
// discarded or left, and the one Save is answered by the test (page.route) with what the page sent, so the page
// does everything it does after a save while the install keeps its settings.
import { test, expect, openAdmin, toast, uniq } from "../fixtures.mjs";

const menu = (page) => page.getByRole("navigation", { name: "Admin" });
const settingsHash = (page) => new URL(page.url()).hash;

test("Global settings: leaving with a change asks first; Stay keeps it, Discard changes puts back what is saved", async ({ page, api }) => {
  const { business } = await api("getBusinessProfile");
  const saved = business.tagline || "";
  await openAdmin(page, "settings");
  const tagline = page.locator("#gBizTagline");
  await expect(tagline).toHaveValue(saved);
  const edit = uniq("Unsaved tagline");
  await tagline.fill(edit);

  // The menu: asked first, and Stay keeps the page and the edit.
  await menu(page).getByRole("button", { name: "Orders", exact: true }).click();
  const ask = page.getByRole("dialog").last();
  await expect(ask).toContainText("Leave without saving?");
  await ask.getByRole("button", { name: "Stay" }).click();
  await expect(ask).toHaveCount(0);
  expect(settingsHash(page)).toBe("#settings");
  await expect(tagline).toHaveValue(edit);

  // Discard changes asks, then the page is drawn again from what is saved — still Global settings.
  await page.getByRole("button", { name: "Discard changes" }).click();
  const discard = page.getByRole("dialog").last();
  await expect(discard).toContainText("Discard your changes?");
  await discard.getByRole("button", { name: "Discard changes" }).click();
  await expect(page.locator("#gBizTagline")).toHaveValue(saved);
  await expect(toast(page)).toContainText("Changes discarded.");
  expect(settingsHash(page)).toBe("#settings");
  await expect(page).toHaveTitle(/Global settings/);
  await expect(page.getByRole("button", { name: "Save global settings" })).toBeVisible();

  // Nothing changed now: the menu goes straight to Orders.
  await menu(page).getByRole("button", { name: "Orders", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => settingsHash(page)).not.toBe("#settings");
  expect((await api("getBusinessProfile")).business.tagline || "").toBe(saved);
});

test("Global settings: Leave goes where the admin was heading, without saving", async ({ page, api }) => {
  const { business } = await api("getBusinessProfile");
  await openAdmin(page, "settings");
  await page.locator("#gBizTagline").fill(uniq("Left tagline"));
  await menu(page).getByRole("button", { name: "Orders", exact: true }).click();
  const ask = page.getByRole("dialog").last();
  await expect(ask).toContainText("Leave without saving?");
  await ask.getByRole("button", { name: "Leave" }).click();
  await expect.poll(() => settingsHash(page)).not.toBe("#settings");
  await expect(page.locator("#gBizTagline")).toHaveCount(0);
  expect((await api("getBusinessProfile")).business.tagline || "").toBe(business.tagline || "");
});

test("Global settings: a successful Save stays on Global settings and clears the unsaved mark", async ({ page }) => {
  await openAdmin(page, "settings");
  // The save is answered here with what the page sent, so the install's settings stay as they are.
  let sentSave = null;
  await page.route("**/api/orders", async (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    if (body.action !== "saveGlobalSettingsAll") return route.continue();
    sentSave = body;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "ok", settings: {}, belowTarget: [] }) });
  });
  const tagline = page.locator("#gBizTagline");
  await tagline.fill(await tagline.inputValue());   // typed: the page counts it as a change
  await page.getByRole("button", { name: "Save global settings" }).click();
  await expect(toast(page)).toContainText("Global settings saved.");
  expect(sentSave && sentSave.settings && typeof sentSave.settings.business).toBe("object");
  // Still Global settings (it used to go on to Manage catalog), drawn again…
  expect(settingsHash(page)).toBe("#settings");
  await expect(page.locator("#gBizTagline")).toBeVisible();
  await page.unroute("**/api/orders");
  // …and nothing is unsaved now: the menu goes without asking.
  await menu(page).getByRole("button", { name: "Orders", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => settingsHash(page)).not.toBe("#settings");
});
