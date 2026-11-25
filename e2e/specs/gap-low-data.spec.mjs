// Data and queries (low review items, 2026-11):
//
// - Archived blanks (review #82, migrations/0104): Archive in a blank's ⋯ menu takes it off the Blanks list; Show
//   archived lists it again, marked ARCHIVED, and its History is all still there. Unarchive brings it back.
// - The Audit log (review #108): the Shop column shows the shop's name (its id as the tooltip); past the chosen
//   limit the footer says "Showing the newest N — narrow the dates or Load more", and Load more adds the next page
//   below, each entry once, until the footer just counts them.
//
// Each test makes its own blank or shop (unique names) and looks only at those: other specs share the install.
import { test, expect, openAdmin, toast, uniq } from "../fixtures.mjs";
import { makeShop } from "../lib/data.mjs";

test("archiving a blank takes it off the Blanks list; Show archived lists it, with its history", async ({ page, api }) => {
  const name = uniq("Retired Cap Blank");
  const { id } = await api("createBlank", { name, brand: "Generic", color: "Navy", productType: "cap", vendor: "",
    sizes: [{ color: "Navy", size: "OSFA", quantity: 3, purchasePrice: 2 }] });
  const row = () => page.getByRole("row", { name: new RegExp(name) });
  await openAdmin(page, "inventory");
  await page.getByRole("searchbox", { name: /Search name, vendor/ }).fill(name);
  await expect(row()).toBeVisible();
  await expect(page.getByLabel("Show archived")).not.toBeChecked();

  await row().getByRole("button", { name: "More for " + name }).click();
  await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
  await expect(toast(page)).toContainText("Blank archived.");
  await expect(row()).toHaveCount(0);

  await page.getByLabel("Show archived").check();
  await expect(row()).toBeVisible();
  await expect(row()).toContainText("ARCHIVED");
  await expect(row()).toContainText("OSFA: 3");
  await row().getByRole("button", { name: "History" }).click();
  const hist = page.getByRole("dialog", { name: "Stock history — " + name });
  await expect(hist.getByRole("row", { name: /Initial stock/ })).toBeVisible();
  await hist.getByRole("button", { name: "Close" }).click();
  // The server's view: still in stock, with its movements; off the default list of blanks.
  const { movements } = await api("getBlankMovements", { blankId: id });
  expect(movements.length).toBeGreaterThan(0);
  const { blanks } = await api("getBlanks");
  expect(blanks.find(b => b.id === id).archivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

  // Unarchive puts it back on the list.
  await row().getByRole("button", { name: "More for " + name }).click();
  await page.getByRole("menuitem", { name: "Unarchive" }).click();
  await expect(toast(page)).toContainText("Blank back in use.");
  await page.getByLabel("Show archived").uncheck();
  await expect(row()).toBeVisible();
  await expect(row()).not.toContainText("ARCHIVED");
});

test("the Audit log shows shop names, and Load more pages through every entry once", async ({ page, api }) => {
  // A shop of its own with enough entries to go past one page of 20 (the shop, its products, the publish).
  const shop = await makeShop(api, { products: Array.from({ length: 21 }, (_, i) => ({ name: uniq("Audit Tee " + i), price: 10 + i })) });
  let total = 0;
  await expect.poll(async () => (total = (await api("getAuditLog", { orgId: shop.orgId, limit: 200 })).entries.length), { timeout: 10_000 }).toBeGreaterThan(21);

  await openAdmin(page, "audit");
  await page.locator("#afOrg").selectOption(shop.orgId);
  await page.locator("#afLimit").selectOption("20");
  const answered = () => page.waitForResponse(r => r.url().endsWith("/api/orders") && /"action":"getAuditLog"/.test(r.request().postData() || ""));
  let wait = answered();
  await page.getByRole("button", { name: "Search" }).click();
  await wait;
  const rows = page.locator("#auditResults tbody tr");
  await expect(rows).toHaveCount(20);
  const footer = page.locator("#auditFooter");
  await expect(footer).toContainText("Showing the newest 20 — narrow the dates or");
  // The Shop column: the shop's name, its id as the tooltip.
  const shopCell = rows.first().locator("td").nth(1).locator("span");
  await expect(shopCell).toHaveText(shop.name);
  await expect(shopCell).toHaveAttribute("title", shop.orgId);

  // Load more until there is no more: every entry, once.
  for (let i = 0; i < 5 && await page.getByRole("button", { name: "Load more" }).count(); i++) {
    wait = answered();
    await page.getByRole("button", { name: "Load more" }).click();
    const res = await wait;
    expect(JSON.parse(res.request().postData()).before).toBeTruthy();
  }
  await expect(rows).toHaveCount(total);
  await expect(footer).toHaveText(total + " entries");
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
});
