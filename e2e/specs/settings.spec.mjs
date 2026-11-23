// Global settings and the audit log.
//
// These settings are install-wide and other specs run beside this one, so every test puts back what it changed
// (in a finally) and picks values that can't trip anyone up: the time zone is saved as the one already in use
// (UTC), only the Digital products feature is switched (no other spec uses it), and the brief sales-tax rate
// doesn't touch makeShop() shops (tax-exempt).
//
// KNOWN BUG (reported): on an install without a Shippo key — this one, like any new install that skipped
// carrier shipping — "Save global settings" saves nothing until Shipping is unticked, because the Shipping
// feature starts switched on but can't be on without a key. Unticking it is permanent (it can't be switched on
// again without a key) and other specs share this install, so the first test below asserts the correct
// behaviour as an expected failure, and the others make each change with the request that section of the
// page sends on Save (the owner's API) and check what the page and the shop then show.
import { test, expect, openAdmin, waitIdle, toast, uniq, user, shopUrl } from "../fixtures.mjs";
import { makeShop } from "../lib/data.mjs";
import { freshAdmin } from "../lib/money.mjs";

test.describe.configure({ mode: "serial" });

const setupRow = (page, name) => page.locator("#app tr").filter({ has: page.getByRole("cell", { name: new RegExp("^" + name + " (required|recommended|optional)") }) });

let bizName;

test("Save global settings saves a business-name change on an install without carrier shipping", async ({ page, api }) => {
  test.fail(true, "Known bug: a new install without a Shippo key can't save Global settings unless Shipping is unticked for good");
  const { business: before } = await api("getBusinessProfile");
  try {
    await freshAdmin(page, "settings");
    // Shipping is switched on, though this install has no Shippo key.
    await expect(page.locator("#gFeatRow-shipping .gFeature")).toBeChecked();
    await page.locator("#gBizName").fill(uniq("Example Stitch Co"));
    await page.getByRole("button", { name: "Save global settings" }).click();
    await expect(toast(page)).toContainText("Global settings saved.", { timeout: 4000 });
  } finally {
    await api("updateBusinessProfile", { business: before });
  }
});

test("Business profile: the saved name and contact email show in Global settings, the admin's titles and a shop's page", async ({ page, api }) => {
  const { business: before } = await api("getBusinessProfile");
  bizName = uniq("Example Stitch Co");
  try {
    await freshAdmin(page, "settings");
    await expect(setupRow(page, "Business profile")).toContainText("No business name yet");
    await api("updateBusinessProfile", { business: { ...before, name: bizName, supportEmail: "hello@example.test" } });

    await freshAdmin(page, "settings");
    await expect(page.locator("#gBizName")).toHaveValue(bizName);
    await expect(page.locator("#gBizSupportEmail")).toHaveValue("hello@example.test");
    await expect(setupRow(page, "Business profile")).not.toContainText("No business name yet");
    // The admin's page titles carry the business name.
    await expect(page).toHaveTitle(bizName + " — Global settings (Admin)");

    // A shop's page shows the business name to customers.
    const shop = await makeShop(api, { prefix: "biz" });
    await page.goto(shopUrl(shop.subdomain) + "/");
    await expect(page.locator("body")).toContainText(bizName);
  } finally {
    await api("updateBusinessProfile", { business: before });
  }
});

test("Region: the time zone saved (the UTC the install already uses) shows in Global settings", async ({ page, api }) => {
  const { locale: before, effectiveTimeZone } = await api("getLocaleSettings");
  expect(effectiveTimeZone).toBe("UTC");
  try {
    await freshAdmin(page, "settings");
    // Not saved yet: the box is empty and shows the zone in use as its placeholder.
    await expect(page.locator("#gLocaleTimeZone")).toHaveAttribute("placeholder", "UTC");
    await api("updateLocaleSettings", { locale: { timeZone: "UTC", country: before.country || "US" } });
    await freshAdmin(page, "settings");
    await expect(page.locator("#gLocaleTimeZone")).toHaveValue("UTC");
    await expect(setupRow(page, "Time zone")).toContainText("✓");
    // A zone that isn't one is refused.
    const bad = await api("updateLocaleSettings", { locale: { timeZone: "Not/AZone", country: "US" } }, { allowError: true });
    expect(bad.status).toBe("error");
  } finally {
    await api("updateLocaleSettings", { locale: { timeZone: before.timeZone || "", country: before.country || "US" } });
  }
});

test("Features: with Digital products off, its settings leave Global settings; on again, they are back", async ({ page, api }) => {
  const { features: before } = await api("getFeatures");
  expect(before.digital).toBe(true);
  try {
    await freshAdmin(page, "settings");
    await expect(page.locator("#gFeatRow-digital .gFeature")).toBeChecked();
    await expect(page.locator("#gDigDays")).toBeVisible();

    await api("updateFeatures", { features: { digital: false } });
    await freshAdmin(page, "settings");
    await expect(page.locator("#gFeatRow-digital .gFeature")).not.toBeChecked();
    await expect(page.locator("#gDigDays")).toBeHidden();
    // The other switches are untouched.
    for (const key of ["storefront", "production", "bookkeeping", "shipping", "designVerification"]) {
      await expect(page.locator(`#gFeatRow-${key} .gFeature`)).toBeChecked();
    }

    await api("updateFeatures", { features: { digital: true } });
    await freshAdmin(page, "settings");
    await expect(page.locator("#gFeatRow-digital .gFeature")).toBeChecked();
    await expect(page.locator("#gDigDays")).toBeVisible();
  } finally {
    if ((await api("getFeatures")).features.digital !== before.digital) await api("updateFeatures", { features: { digital: before.digital } });
  }
});

test("Features: Shipping can't be switched on without a Shippo key (the clear error, nothing changed)", async ({ api }) => {
  const r = await api("updateFeatures", { features: { shipping: true } }, { allowError: true });
  expect(r.status).toBe("error");
  expect(r.message).toContain("Shipping needs a Shippo key");
  expect((await api("getFeatures")).features).toMatchObject({ storefront: true, digital: true });
});

test("Sales tax: a rate shows in Global settings and Setup status says what is still missing; then none again", async ({ page, api }) => {
  const { salesTax: before } = await api("getSalesTaxSettings");
  expect(before.ratePercent).toBe(0);
  try {
    await freshAdmin(page, "settings");
    await expect(setupRow(page, "Sales tax")).toContainText("No rate is set");
    await api("updateSalesTaxSettings", { ratePercent: 6.5, jurisdiction: "", taxMode: before.taxMode });
    await freshAdmin(page, "settings");
    await expect(page.locator("#gTaxRate")).toHaveValue("6.5");
    // A rate with no home state (left empty here) is flagged, not ticked.
    await expect(setupRow(page, "Sales tax")).toContainText("A rate is set but no home state");
    // The Sales tax report says which rate it backs out.
    await freshAdmin(page, "salestax");
    await page.getByRole("button", { name: "Generate" }).click();
    await expect(page.locator("#taxResults")).toContainText("6.5%");

    await api("updateSalesTaxSettings", { ratePercent: 0, jurisdiction: "", taxMode: before.taxMode });
    await freshAdmin(page, "settings");
    await expect(page.locator("#gTaxRate")).toHaveValue("0");
    await expect(setupRow(page, "Sales tax")).toContainText("No rate is set");
  } finally {
    await api("updateSalesTaxSettings", { ratePercent: before.ratePercent, jurisdiction: before.jurisdiction || "", taxMode: before.taxMode });
  }
});

test("Rush orders: a fixed rush fee shows in Global settings and is offered on a shop's page; then off again", async ({ page, api }) => {
  const { rush: before } = await api("getRushSettings");
  expect(before.rule.mode).toBe("off");
  try {
    await api("updateRushSettings", { rush: { rule: { ...before.rule, mode: "fixed", amount: 10 }, taxable: false } });
    await freshAdmin(page, "settings");
    await expect(page.locator("#gRushMode")).toHaveValue("fixed");
    await expect(page.locator("#gRushAmount")).toHaveValue("10");

    // A shop that follows the global rule offers it to customers, with its fee.
    const shop = await makeShop(api, { prefix: "rush" });
    await page.goto(shopUrl(shop.subdomain) + "/");
    await page.getByRole("button", { name: "Add to cart" }).first().click();
    const rush = page.locator("label", { has: page.locator("#rushOrder") });
    await expect(rush).toContainText("Rush my order");
    await expect(rush).toContainText("+$10");
    await expect(page.locator("main")).toContainText(/Total\s*\$20\.00/);
    await page.locator("#rushOrder").check();
    await expect(page.locator("main")).toContainText(/Total\s*\$30\.00/);

    // A fee out of range is refused.
    const bad = await api("updateRushSettings", { rush: { rule: { ...before.rule, mode: "fixed", amount: 5000 }, taxable: false } }, { allowError: true });
    expect(bad.status).toBe("error");
  } finally {
    await api("updateRushSettings", { rush: { rule: before.rule, taxable: before.taxable } });
  }
  await freshAdmin(page, "settings");
  await expect(page.locator("#gRushMode")).toHaveValue("off");
});

test("Pricing: a card fee shows in Global settings; then set back", async ({ page, api }) => {
  const { pricing: before } = await api("getPricingSettings");
  const restore = { cardPct: before.cardPct, cardFixed: before.cardFixed, supplies: before.supplies,
    targetHourly: before.targetHourly == null ? "" : before.targetHourly, targetIncome: before.targetIncome == null ? "" : before.targetIncome };
  try {
    await api("updatePricingSettings", { pricing: { ...restore, cardPct: 3.1 } });
    await freshAdmin(page, "settings");
    await expect(page.locator("#gPriceCardPct")).toHaveValue("3.1");
  } finally {
    await api("updatePricingSettings", { pricing: restore });
  }
  await freshAdmin(page, "settings");
  await expect(page.locator("#gPriceCardPct")).toHaveValue(String(before.cardPct));
});

test("Audit log: the changes above and a new expense are listed, with who made them; filters narrow it", async ({ page, api }) => {
  const owner = user("owner").email;
  const expenseDesc = uniq("Thread cones from Test Thread Co");
  const { categories } = await api("listExpenseCategories");
  const office = categories.find(c => c.name === "Office expense");
  const { accounts } = await api("listAccounts");
  // The same request Expenses → Save expense sends (that page is money.spec's subject).
  await api("saveExpense", { expense: { date: new Date().toISOString().slice(0, 10), description: expenseDesc, categoryId: office.id, amount: 12.5,
    vendor: "", businessUsePct: 100, vendorChargedTax: true, accountId: accounts.find(a => a.name === "Business checking").id } });

  await freshAdmin(page, "audit");
  const results = page.locator("#auditResults");
  await page.locator("#afLimit").selectOption("200");
  await page.locator("#afAction").fill("settings.business");
  await page.getByRole("button", { name: "Search" }).click();
  const biz = results.locator("tr", { hasText: bizName });
  await expect(biz).toHaveCount(2);   // set, then put back
  await expect(biz.first()).toContainText(owner);

  await page.locator("#afAction").fill("settings.sales_tax");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(results.locator("tr", { hasText: "Sales tax rate set" }).first()).toContainText(owner);

  await page.locator("#afAction").fill("expense.created");
  await page.getByRole("button", { name: "Search" }).click();
  const exp = results.locator("tr", { hasText: expenseDesc });
  await expect(exp).toContainText("$12.50");
  await expect(exp).toContainText("Office expense");
  await expect(exp).toContainText(owner);

  // A filter that matches nothing says so.
  await page.locator("#afAction").fill("no-such-action-" + Date.now());
  await page.getByRole("button", { name: "Search" }).click();
  await expect(results).toContainText("No entries found for these filters.");

  // The Security button lists sign-in and user changes (the first run added users and signed them in).
  await page.locator("#afSecurity").click();
  await expect(page.locator("#afAction")).toHaveValue("security.");
  await expect(results.locator("tbody tr").first()).toBeVisible();
});
