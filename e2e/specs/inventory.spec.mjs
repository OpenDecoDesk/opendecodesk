// Inventory: blanks (new, stock, receive an order, write off, count, history, reorder point → Blanks to order),
// transfer sheets (new, receive, count), and a shop product's finished (ready-to-ship) stock.
// Everything is made with unique names, and each check looks only at this file's own rows: other specs share
// the install and its inventory.
import { test, expect, openAdmin, toast, uniq, waitIdle } from "../fixtures.mjs";
import { makeShop } from "../lib/data.mjs";

test.describe.configure({ mode: "serial" });

const BLANK = uniq("Sample Tee Blank");
const TRANSFER = uniq("Example Club Crest Transfer");

// The blank's row in the Blanks list (its name is unique to this run).
const blankRow = (page) => page.getByRole("row", { name: new RegExp(BLANK) });
// A size's row in the New/Edit blank window (the sizes are listed in size order, not as typed).
const sizeRow = (dlg, size) => dlg.locator(`tr:has([data-sf=size][value="${size}"])`);
// The Blanks list narrowed to this file's blank by its search box.
async function openBlanks(page) {
  await openAdmin(page, "inventory");
  await page.getByRole("searchbox", { name: /Search name, vendor/ }).fill(BLANK);
  await expect(blankRow(page)).toBeVisible();
}

test("a new blank is created with a color, sizes, vendor price and opening stock", async ({ page }) => {
  await openAdmin(page, "inventory");
  await page.getByRole("button", { name: "+ New blank" }).click();
  const dlg = page.getByRole("dialog", { name: "New blank" });
  await dlg.locator("#blkName").fill(BLANK);
  await dlg.getByLabel("Brand").fill("Test Blank Co");
  await dlg.getByRole("textbox", { name: "Color" }).fill("Navy");
  // Two sizes: M with 3 in stock, L with none.
  await dlg.locator("[data-size-add]").click();
  await dlg.locator("[data-size-add]").click();
  const sizes = dlg.locator("[data-sf=size]"), prices = dlg.locator("[data-sf=vendorPrice]"), qty = dlg.locator("[data-sf=quantity]");
  await sizes.nth(0).fill("M"); await prices.nth(0).fill("4.50"); await qty.nth(0).fill("3");
  await sizes.nth(1).fill("L"); await prices.nth(1).fill("4.50");
  await dlg.getByRole("button", { name: "Create blank" }).click();
  await expect(dlg).toHaveCount(0);
  await page.getByRole("searchbox", { name: /Search name, vendor/ }).fill(BLANK);
  const row = blankRow(page);
  await expect(row).toContainText("Navy");
  await expect(row).toContainText("M: 3 · $4.50");
  await expect(row).toContainText("L: 0 · $4.50");
  await expect(row).toContainText("3 units · $13.50 value");
});

test("editing a blank's stock records an adjustment in its history", async ({ page }) => {
  await openBlanks(page);
  await blankRow(page).getByRole("button", { name: "Edit" }).click();
  const dlg = page.getByRole("dialog", { name: "Edit blank" });
  await sizeRow(dlg, "M").locator("[data-sf=quantity]").fill("5");
  await dlg.getByRole("button", { name: "Save changes" }).click();
  await expect(dlg).toHaveCount(0);
  await expect(blankRow(page)).toContainText("M: 5");
  await blankRow(page).getByRole("button", { name: "History" }).click();
  const hist = page.getByRole("dialog", { name: "Stock history — " + BLANK });
  await expect(hist.getByRole("row", { name: /Navy · M Adjusted \+3 .*Initial stock/ })).toBeVisible();
  await expect(hist.getByRole("row", { name: /Navy · M Adjusted \+2/ })).toBeVisible();
  await hist.getByRole("button", { name: "Close" }).click();
});

test("Receive order adds a vendor order to stock at its landed cost", async ({ page }) => {
  await openBlanks(page);
  await page.getByRole("button", { name: "Receive order" }).click();
  const dlg = page.getByRole("dialog", { name: "Receive a blank order" });
  await dlg.getByRole("combobox", { name: "Blank" }).selectOption({ label: BLANK });
  const mLine = dlg.locator("tr:has(.rcc-qty[data-size='M'])");
  await mLine.locator(".rcc-qty").fill("4");
  await mLine.locator(".rcc-cost").fill("20");
  await dlg.getByRole("textbox", { name: "Invoice / order #" }).fill("INV-E2E-1");
  await dlg.getByRole("button", { name: "Record order" }).click();
  await expect(toast(page)).toContainText("Order recorded — $20.00.");
  await expect(dlg).toHaveCount(0);
  // 5 at $4.50 + 4 at $5.00 = $42.50 for 9: an average cost of $4.72 each.
  await expect(blankRow(page)).toContainText("M: 9 · $4.50 (avg $4.72)");
  await expect(blankRow(page)).toContainText("9 units");
  await blankRow(page).getByRole("button", { name: "History" }).click();
  const hist = page.getByRole("dialog", { name: "Stock history — " + BLANK });
  await expect(hist.getByRole("row", { name: /Navy · M Received \+4 \$5\.00/ })).toBeVisible();
  await hist.getByRole("button", { name: "Close" }).click();
});

test("writing off a damaged blank takes it out of stock", async ({ page }) => {
  await openBlanks(page);
  await blankRow(page).getByRole("button", { name: "More for " + BLANK }).click();
  await page.getByRole("menuitem", { name: "Write off…" }).click();
  const dlg = page.getByRole("dialog", { name: "Write off stock — " + BLANK });
  await expect(dlg.locator("#woSize")).toContainText("Navy — M — on hand 9");
  await dlg.locator("#woQty").fill("1");
  await dlg.getByRole("button", { name: "Write off" }).click();
  await expect(toast(page)).toContainText("Written off.");
  await expect(blankRow(page)).toContainText("M: 8");
});

test("Count stock settles a difference with a correction", async ({ page }) => {
  await openBlanks(page);
  await page.getByRole("button", { name: "Count stock…" }).click();
  const dlg = page.getByRole("dialog", { name: "Count stock — blanks" });
  await dlg.getByRole("searchbox", { name: "Search" }).fill(BLANK);
  const row = dlg.getByRole("row", { name: /^Navy · M 8/ });
  await expect(row).toBeVisible();
  await row.getByRole("spinbutton", { name: "Counted" }).fill("6");
  await expect(row).toContainText("−2");
  await row.getByRole("button", { name: "Correct count" }).click();
  const ask = page.getByRole("dialog", { name: /Record a correction of −2/ });
  await ask.locator("#cmOk").click();
  await expect(toast(page)).toContainText("1 count corrected.");
  await expect(dlg.getByRole("row", { name: /^Navy · M 6 6 0/ })).toBeVisible();
  await dlg.getByRole("button", { name: "Close" }).last().click();
  await expect(blankRow(page)).toContainText("M: 6");
});

test("a reorder point below stock puts a restock on Blanks to order", async ({ page }) => {
  await openBlanks(page);
  await blankRow(page).getByRole("button", { name: "Edit" }).click();
  const dlg = page.getByRole("dialog", { name: "Edit blank" });
  // Keep at least 4 of size L, which has none.
  await sizeRow(dlg, "L").getByRole("spinbutton", { name: "Keep at least" }).fill("4");
  await dlg.getByRole("button", { name: "Save changes" }).click();
  await expect(dlg).toHaveCount(0);
  await openAdmin(page, "blankorder");
  await expect(page.getByRole("checkbox", { name: "Include restock (reorder points)" })).toBeChecked();
  // Its line: the restock that tops size L back up to 4 (an editable count).
  const line = page.locator("tr", { hasText: BLANK }).filter({ has: page.locator(".bto-restock") });
  await expect(line).toHaveCount(1);
  await expect(line.locator(".bto-rs-qty")).toHaveValue("4");
});

test("a transfer sheet is received into stock and counted", async ({ page }) => {
  await openAdmin(page, "transfers");
  await page.getByRole("button", { name: "+ New transfer" }).click();
  const nd = page.getByRole("dialog", { name: "New transfer" });
  await nd.getByLabel("Name").fill(TRANSFER);
  await nd.getByRole("button", { name: "Create" }).click();
  await expect(toast(page)).toContainText("Created.");
  const row = page.getByRole("row", { name: new RegExp("^" + TRANSFER) });
  await expect(row).toContainText(TRANSFER + " 0 $0.00");

  // One sheet: 10 transfers of it, the whole sheet, $25.
  await page.getByRole("button", { name: "Receive sheet" }).click();
  const rd = page.getByRole("dialog", { name: "Receive a transfer sheet" });
  await rd.locator("#trTotal").fill("25");
  await rd.locator(".trRow .trItem").first().selectOption({ label: TRANSFER });
  await rd.locator(".trRow .trCount").first().fill("10");
  await rd.locator(".trRow .trPct").first().fill("100");
  await rd.getByRole("button", { name: "Receive" }).click();
  await expect(toast(page)).toContainText("Sheet received.");
  await expect(row).toContainText(TRANSFER + " 10 $2.50");

  await page.getByRole("button", { name: "Count stock…" }).click();
  const cd = page.getByRole("dialog", { name: "Count stock — transfers" });
  await cd.getByRole("searchbox", { name: "Search" }).fill(TRANSFER);
  const crow = cd.getByRole("row", { name: new RegExp("^" + TRANSFER) });
  await crow.getByRole("spinbutton", { name: "Counted" }).fill("8");
  await crow.getByRole("button", { name: "Correct count" }).click();
  await page.getByRole("dialog", { name: /Record a correction of −2/ }).locator("#cmOk").click();
  await expect(toast(page)).toContainText("1 count corrected.");
  await cd.getByRole("button", { name: "Close" }).last().click();
  await expect(row).toContainText(TRANSFER + " 8 $2.50");
});

test("a product's finished stock (ready to ship) takes a count", async ({ page, api }) => {
  const shop = await makeShop(api, { prefix: "invstock", products: [{ name: "Sample Stock Tee", price: 22 }] });
  await openAdmin(page, "catalog/orgs/" + shop.orgId + "/products");
  await page.getByTitle("Finished stock: pieces already decorated for this shop").first().click();
  const dlg = page.getByRole("dialog", { name: "Finished stock — Sample Stock Tee" });
  const count = dlg.getByRole("spinbutton", { name: /^Counted on hand/ });
  await expect(count).toHaveValue("0");
  await count.fill("3");
  await dlg.getByRole("button", { name: "Correct count" }).click();
  await page.getByRole("dialog", { name: /Correct the count to 3\?/ }).locator("#cmOk").click();
  await expect(toast(page)).toContainText("Count corrected.");
  await expect(dlg.getByRole("spinbutton", { name: /^Counted on hand/ })).toHaveValue("3");
  await expect(dlg.locator("#fsHistory")).toContainText("+3");
  await dlg.getByRole("button", { name: "Done" }).click();
});

test("a read-only user sees the blanks but none of the buttons that change them", async ({ as }) => {
  const viewer = await as("viewer");
  await openAdmin(viewer, "inventory");
  await viewer.getByRole("searchbox", { name: /Search name, vendor/ }).fill(BLANK);
  await expect(viewer.getByRole("row", { name: new RegExp(BLANK) })).toContainText("M: 6");
  for (const name of ["+ New blank", "Receive order", "Count stock…"]) await expect(viewer.getByRole("button", { name })).toBeHidden();

  const staff = await as("staff");
  await openAdmin(staff, "inventory");
  await expect(staff.getByRole("button", { name: "+ New blank" })).toBeVisible();
  await expect(staff.getByRole("button", { name: "Receive order" })).toBeVisible();
});
