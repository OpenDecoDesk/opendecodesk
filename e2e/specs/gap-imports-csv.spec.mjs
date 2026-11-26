// Spreadsheet (CSV) imports, through the one import window they share (admin.js showCsvImportModal_) — coverage gap
// "showCsvImportModal_ / showBlankCsvImportModal_", which no test opened:
//
// - Blanks → Import ▾ → Spreadsheet (CSV)…: the file is checked first (a dry run), row by row — New, Update, or
//   Can't import with the reason (no size costs, a cost that isn't a number, a supplier that isn't in the vendor
//   list, a style twice) — and nothing is saved until Import, which sends only the rows left ticked. Importing the
//   same style again updates that blank's vendor prices. A blanks file without colors can take them from the
//   products file (blank_style + all_colors) picked in the same window.
// - A file the window can't use says why and saves nothing: only a header line, no style column, more than 2,000
//   rows. Cancel at the preview saves nothing either.
// - A shop's Products → Import CSV… (linking each product to its blank by blank_style) and Orders → Import orders…
//   (a plain sheet, one row per item, grouped into orders) go through the same window.
//
// Every file is invented here; every style, SKU, vendor and order number is unique to the test (other specs share
// the install). Each result is checked on its screen and through the API.
import { test, expect, openAdmin, toast, uniq, slug, waitIdle } from "../fixtures.mjs";
import { makeShop } from "../lib/data.mjs";

// ---- helpers ---------------------------------------------------------------------------------------------
// A CSV file from rows of values (quoted where needed), as the file chooser takes it.
const csvText = (rows) => rows.map(r => r.map(v => { const s = String(v ?? ""); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(",")).join("\r\n") + "\r\n";
const csvFile = (name, rows) => ({ name, mimeType: "text/csv", buffer: Buffer.from(csvText(rows)) });
// A style no other test or run uses: "CSV-K3X9Q1".
const styleId = (prefix) => slug(prefix).toUpperCase();

// Clicks a control that opens the browser's file picker, and answers it with `file`.
async function chooseFile(page, open, file) {
  const chooser = page.waitForEvent("filechooser");
  await open();
  await (await chooser).setFiles(file);
}
// Blanks → Import ▾ → Spreadsheet (CSV)…, answered with `file`; returns the import window.
async function importBlanksFile(page, file) {
  await chooseFile(page, async () => {
    await page.getByRole("button", { name: "Import ▾", exact: true }).click();
    await page.getByRole("menuitem", { name: "Spreadsheet (CSV)…" }).click();
  }, file);
  return page.getByRole("dialog", { name: "Import blanks — " + file.name });
}
// The preview table's row for `text` (a style, SKU or order number).
const previewRow = (dlg, text) => dlg.getByRole("row").filter({ hasText: text });
// The owner's blanks with this SKU (style).
const blanksWithSku = async (api, sku) => (await api("getBlanks")).blanks.filter(b => String(b.sku || "").toLowerCase() === sku.toLowerCase());
// Each color's sizes and vendor prices of a blank: { Navy: { S: 3.1, … }, … }.
const vendorPrices = (b) => Object.fromEntries((b.colors || []).map(c => [c.color, Object.fromEntries((c.sizes || []).map(z => [z.size, z.vendorPrice]))]));
// A vendor for blanks, made for this test (a row's supplier must be in the vendor list).
async function makeVendor(api, prefix) {
  const name = uniq(prefix);
  await api("saveVendor", { vendor: { name, forBlanks: true } });
  return name;
}
// The Blanks list narrowed by its search box.
async function searchBlanks(page, q) {
  await page.getByRole("searchbox", { name: /Search name, vendor/ }).fill(q);
}

const BLANK_HEAD = ["style", "name", "brand", "supplier", "category", "cost_S", "cost_M", "cost_XL", "colors", "notes"];

// ---- Blanks ------------------------------------------------------------------------------------------------
test("a blanks CSV is checked row by row; only the rows left ticked are imported", async ({ page, api }) => {
  const vendor = await makeVendor(api, "Example Blank Supply");
  const good = styleId("csva"), noCost = styleId("csvb"), stranger = styleId("csvc"), badCost = styleId("csve"), left = styleId("csvf");
  const name = uniq("Sample Crew Tee");
  const file = csvFile("blanks-" + good.toLowerCase() + ".csv", [
    BLANK_HEAD,
    [good, name, "Test Blank Co", vendor, "Shirts", "3.10", "3.10", "4.25", "Navy|Red", "Imported by the e2e suite"],
    [noCost, "Sample No Cost Tee", "Test Blank Co", vendor, "Shirts", "", "", "", "Navy", ""],
    [stranger, "Sample Stranger Tee", "Test Blank Co", "Nowhere Supply " + stranger, "Shirts", "3", "3", "", "Navy", ""],
    [good, "Sample Repeat Tee", "Test Blank Co", vendor, "Shirts", "3", "3", "", "Navy", ""],
    [badCost, "Sample Bad Cost Tee", "Test Blank Co", vendor, "Shirts", "abc", "3", "", "Navy", ""],
    [left, "Sample Left Out Tee", "Test Blank Co", vendor, "Spaceships", "2", "2", "", "White", ""],
  ]);

  await openAdmin(page, "inventory");
  const dlg = await importBlanksFile(page, file);
  await expect(dlg).toContainText("6 rows: 2 new, 0 to update, 4 that can't be imported.");
  await expect(dlg).toContainText("Nothing is saved until you press Import.");

  // The two good rows: New, ticked; the one with an unknown category is filed under Other, and says so.
  await expect(previewRow(dlg, good).first()).toContainText("New");
  await expect(previewRow(dlg, good).first()).toContainText("Sizes S, M, XL · 2 colors");
  await expect(previewRow(dlg, left)).toContainText(`Category "Spaceships" isn't one this site knows — filed under Other`);
  // The others can't be imported, each with its reason, and their boxes can't be ticked.
  await expect(previewRow(dlg, noCost)).toContainText("Can't import");
  await expect(previewRow(dlg, noCost)).toContainText("No size costs — fill at least one cost_<size> column");
  await expect(previewRow(dlg, stranger)).toContainText(`Supplier “Nowhere Supply ${stranger}” isn't in the vendor list`);
  await expect(previewRow(dlg, good).nth(1)).toContainText("This style is in the file more than once");
  await expect(previewRow(dlg, badCost)).toContainText(`Cost for S isn't a number ("abc")`);
  for (const n of [3, 4, 5, 6]) await expect(dlg.getByRole("checkbox", { name: "Import row " + n, exact: true })).toBeDisabled();
  await expect(dlg.getByRole("checkbox", { name: "Import row 2", exact: true })).toBeChecked();
  await expect(dlg.getByRole("button", { name: "Import 2 rows" })).toBeEnabled();

  // Untick every row: nothing to import. Tick them back, then leave the last good row out.
  await dlg.getByRole("checkbox", { name: "Tick every row" }).uncheck();
  await expect(dlg.getByRole("button", { name: "Import 0 rows" })).toBeDisabled();
  await dlg.getByRole("checkbox", { name: "Tick every row" }).check();
  await expect(dlg.getByRole("button", { name: "Import 2 rows" })).toBeEnabled();
  await dlg.getByRole("checkbox", { name: "Import row 7", exact: true }).uncheck();
  await dlg.getByRole("button", { name: "Import 1 row", exact: true }).click();
  await expect(dlg).toHaveCount(0);
  await expect(toast(page)).toContainText("Blanks imported: 1 new, 0 updated.");

  // On the Blanks list: the new blank, with its vendor and both colors.
  await searchBlanks(page, good);
  const row = page.getByRole("row", { name: new RegExp(name) });
  await expect(row).toBeVisible();
  await expect(row).toContainText(vendor);
  await expect(row).toContainText("Navy");
  await expect(row).toContainText("Red");
  // The server's view: one blank of that style, every color at every size at that size's cost; the rest not made.
  const [b] = await blanksWithSku(api, good);
  expect(b).toMatchObject({ name, vendor, brand: "Test Blank Co", productType: "shirt" });
  expect(vendorPrices(b)).toEqual({ Navy: { S: 3.1, M: 3.1, XL: 4.25 }, Red: { S: 3.1, M: 3.1, XL: 4.25 } });
  expect(await blanksWithSku(api, good)).toHaveLength(1);
  for (const s of [noCost, stranger, badCost, left]) expect(await blanksWithSku(api, s), s).toHaveLength(0);
});

test("importing a blank's style again updates its vendor prices instead of making another", async ({ page, api }) => {
  const vendor = await makeVendor(api, "Example Blank Supply");
  const style = styleId("csvu"), name = uniq("Sample Update Tee");
  const row = (s, m) => [style, name, "Test Blank Co", vendor, "Shirts", s, m, "", "Navy", ""];
  // The blank as an earlier import left it (the same request the window sends).
  await api("importBlanks", { rows: [Object.fromEntries(BLANK_HEAD.map((h, i) => [h, row("3.00", "3.00")[i]]))] });
  expect(vendorPrices((await blanksWithSku(api, style))[0])).toEqual({ Navy: { S: 3, M: 3 } });

  await openAdmin(page, "inventory");
  const dlg = await importBlanksFile(page, csvFile("prices-" + style.toLowerCase() + ".csv", [BLANK_HEAD, row("3.40", "3.00")]));
  await expect(dlg).toContainText("1 row: 0 new, 1 to update.");
  await expect(previewRow(dlg, style)).toContainText("Update");
  await expect(previewRow(dlg, style)).toContainText("Sets the vendor price on 1 size row");
  await dlg.getByRole("button", { name: "Import 1 row", exact: true }).click();
  await expect(toast(page)).toContainText("Blanks imported: 0 new, 1 updated.");

  const list = await blanksWithSku(api, style);
  expect(list).toHaveLength(1);
  expect(vendorPrices(list[0])).toEqual({ Navy: { S: 3.4, M: 3 } });
  // …and its price history has the change, from the CSV import.
  const hist = await api("getBlankVendorPriceHistory", { blankId: list[0].id });
  expect(JSON.stringify(hist)).toContain("CSV import");
});

test("a blanks file without colors takes them from the products file picked in the window", async ({ page, api }) => {
  const vendor = await makeVendor(api, "Example Blank Supply");
  const style = styleId("csvk"), name = uniq("Sample Colorless Tee");
  const file = csvFile("nocolors-" + style.toLowerCase() + ".csv", [
    ["style", "name", "supplier", "category", "cost_S", "cost_M"],
    [style, name, vendor, "Shirts", "2.50", "2.75"],
  ]);
  await openAdmin(page, "inventory");
  const dlg = await importBlanksFile(page, file);
  await expect(dlg).toContainText("This file has no colors. Blanks would be imported with sizes and costs only.");
  await expect(previewRow(dlg, style)).toContainText("no colors");

  // A products file with nothing to read colors from: the window says so and keeps the preview.
  await chooseFile(page, () => dlg.getByText("Choose the products file…").click(),
    csvFile("wrong-products.csv", [["sku", "name", "price"], ["tee-1", "Sample Tee", "20"]]));
  await expect(dlg).toContainText("wrong-products.csv has no blank_style + all_colors columns to read colors from.");

  // The right one: its blank_style matches, and all_colors (plus default_colors) are the colors.
  await chooseFile(page, () => dlg.getByText("Choose the products file…").click(), csvFile("products-" + style.toLowerCase() + ".csv", [
    ["sku", "name", "blank_style", "all_colors", "default_colors"],
    ["tee-a", "Sample Club Tee", style, "Navy|Heather Grey", "Navy|Gold"],
    ["tee-b", "Another Tee", "OTHER-" + style, "Black", ""],
  ]));
  await expect(dlg).toContainText(`Colors read from products-${style.toLowerCase()}.csv: 1 of 1 style matched on blank_style.`);
  await expect(previewRow(dlg, style)).toContainText("3 colors");
  await expect(dlg.getByText("Choose a different file…")).toBeVisible();
  await dlg.getByRole("button", { name: "Import 1 row", exact: true }).click();
  await expect(toast(page)).toContainText("Blanks imported: 1 new, 0 updated.");

  const [b] = await blanksWithSku(api, style);
  expect((b.colors || []).map(c => c.color).sort()).toEqual(["Gold", "Heather Grey", "Navy"]);
  expect(vendorPrices(b).Gold).toEqual({ S: 2.5, M: 2.75 });
});

test("a file the import can't use says why, and Cancel saves nothing", async ({ page, api }) => {
  const vendor = await makeVendor(api, "Example Blank Supply");
  await openAdmin(page, "inventory");

  // Only a header line.
  let dlg = await importBlanksFile(page, csvFile("header-only.csv", [BLANK_HEAD]));
  await expect(dlg).toContainText("That file has no rows under its header line. Save the sheet as CSV (comma separated) and try again.");
  await expect(dlg).toContainText("cost_<size>");   // what the file should have
  await dlg.getByRole("button", { name: "Close", exact: true }).last().click();
  await expect(dlg).toHaveCount(0);

  // No style column: the columns it does have are named.
  dlg = await importBlanksFile(page, csvFile("no-style.csv", [["name", "cost_M"], ["Sample Nameless Tee", "3"]]));
  await expect(dlg).toContainText("That file has no style column, so the rows can't be told apart. Its columns are: name, cost_M.");
  await dlg.getByRole("button", { name: "Close", exact: true }).last().click();

  // More than 2,000 rows.
  const many = [["style", "cost_M"], ...Array.from({ length: 2001 }, (_, i) => ["BIG-" + i, "1"])];
  dlg = await importBlanksFile(page, csvFile("too-many.csv", many));
  await expect(dlg).toContainText("That file has 2001 rows — import up to 2,000 at a time.");
  await dlg.getByRole("button", { name: "Close", exact: true }).last().click();

  // Not even CSV text: still no rows.
  dlg = await importBlanksFile(page, { name: "not-a-sheet.csv", mimeType: "text/csv", buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
  await expect(dlg).toContainText("That file has no rows under its header line.");
  await dlg.getByRole("button", { name: "Close", exact: true }).last().click();

  // A good file, cancelled at the preview.
  const style = styleId("csvx");
  dlg = await importBlanksFile(page, csvFile("cancel-" + style.toLowerCase() + ".csv", [BLANK_HEAD,
    [style, uniq("Sample Cancelled Tee"), "Test Blank Co", vendor, "Shirts", "3", "3", "", "Navy", ""]]));
  await expect(dlg).toContainText("1 row: 1 new, 0 to update.");
  await dlg.getByRole("button", { name: "Cancel" }).click();
  await expect(dlg).toHaveCount(0);
  await waitIdle(page);
  expect(await blanksWithSku(api, style)).toHaveLength(0);
  expect(await blanksWithSku(api, "BIG-1")).toHaveLength(0);
});

// ---- A shop's products -----------------------------------------------------------------------------------
test("a shop's products CSV is previewed, links each product to its blank, and imports the ticked rows", async ({ page, api }) => {
  const vendor = await makeVendor(api, "Example Blank Supply");
  const style = styleId("csvp");
  await api("importBlanks", { rows: [{ style, name: uniq("Sample Linked Blank"), supplier: vendor, category: "Shirts", cost_S: "3", cost_M: "3", colors: "Navy|Red" }] });
  const shop = await makeShop(api, { prefix: "csvp", products: [], publish: false });
  const tag = slug("p").slice(-6);
  const tee = "tee-" + tag, cap = "cap-" + tag, hood = "hood-" + tag;
  const teeName = uniq("Club Crew Tee");
  const file = csvFile("products-" + tag + ".csv", [
    ["sku", "name", "category", "price", "sizes", "size_upcharges", "default_colors", "blank_style", "active"],
    [tee, teeName, "Shirts", "18", "S|M", "M:1.00", "Navy|Red", style, "TRUE"],
    [cap, "Club Cap", "Caps", "", "", "", "Black", "", "TRUE"],
    [hood, "Club Hoodie", "Hoodies", "30", "S|M", "", "Grey", "NOPE-" + style, "TRUE"],
  ]);

  await openAdmin(page, "catalog/orgs/" + shop.orgId + "/products");
  await chooseFile(page, () => page.getByRole("button", { name: "Import CSV…" }).click(), file);
  const dlg = page.getByRole("dialog", { name: "Import products — " + file.name });
  await expect(dlg).toContainText("3 rows: 2 new, 0 to update, 1 that can't be imported.");
  await expect(dlg).toContainText("Some rows name a blank that isn't in Blanks yet.");
  await expect(previewRow(dlg, tee)).toContainText("$18.00–$19.00");
  await expect(previewRow(dlg, tee)).toContainText(`Linked to blank ${style}`);
  await expect(previewRow(dlg, cap)).toContainText("No price");
  await expect(dlg.getByRole("checkbox", { name: "Import row 3", exact: true })).toBeDisabled();
  // The hoodie would come in unlinked: leave it out.
  await dlg.getByRole("checkbox", { name: "Import row 4", exact: true }).uncheck();
  await dlg.getByRole("button", { name: "Import 1 row", exact: true }).click();
  await expect(dlg).toHaveCount(0);
  await expect(toast(page)).toContainText("Products imported: 1 new, 0 updated. Press Publish to put them on the storefront.");
  await expect(page.locator("#app")).toContainText(teeName);

  const { products } = await api("listProducts", { org: shop.orgId });
  expect(products.map(p => p.productId).sort()).toEqual([tee]);
  const p = products[0];
  expect(p.name).toBe(teeName);
  expect(p.sizePricing).toEqual({ S: 18, M: 19 });
  // Linked to the blank: each of the product's colors and sizes to the same one of the blank's.
  const [blank] = await blanksWithSku(api, style);
  const { links } = await api("getBlankLinks", { org: shop.orgId });
  const mine = links.filter(l => l.productId === tee).map(l => [l.productColor, l.productSize, l.blankId, l.blankColor, l.blankSize].join("/")).sort();
  expect(mine).toEqual([["Navy", "M"], ["Navy", "S"], ["Red", "M"], ["Red", "S"]].map(([c, z]) => [c, z, blank.id, c, z].join("/")));
});

// ---- A shop's orders ------------------------------------------------------------------------------------
test("orders from a sheet are grouped by order number, previewed, and imported", async ({ page, api }) => {
  const shop = await makeShop(api, { prefix: "csvo", products: [{ name: "Sample Tee", price: 20 }], publish: false });
  const tee = shop.products[0];
  const tag = slug("o").slice(-6).toUpperCase();
  const a = "A-" + tag, b = "B-" + tag, c = "C-" + tag;
  const head = ["order", "date", "customer", "email", "sku", "item", "size", "qty", "price", "shipping", "paid"];
  const file = csvFile("orders-" + tag.toLowerCase() + ".csv", [
    head,
    [a, "2026-11-02", "Pat Example", "pat@example.test", tee.productId, "", "", "2", "20.00", "0", "yes"],
    [a, "2026-11-02", "Pat Example", "pat@example.test", "", "Sample Sticker", "", "1", "3.00", "", "yes"],
    [b, "2026-11-03", "Lee Example", "lee@example.test", "", "Sample Patch", "", "1", "5.00", "", "no"],
    [c, "", "Sam Example", "sam@example.test", "", "Sample Patch", "", "1", "5.00", "", "no"],
  ]);

  await openAdmin(page, "orders/" + shop.orgId);
  await expect(page.getByRole("combobox", { name: "Shop" })).toHaveValue(shop.orgId);
  // A file that isn't an orders export: the window names its columns and saves nothing.
  await chooseFile(page, () => page.getByRole("button", { name: "Import orders…" }).click(),
    csvFile("not-orders.csv", [["style", "cost_M"], ["X", "1"]]));
  let dlg = page.getByRole("dialog", { name: "Import orders — not-orders.csv" });
  await expect(dlg).toContainText("That file isn't ");
  await expect(dlg).toContainText("or a sheet with an order column. Its columns are: style, cost_M.");
  await dlg.getByRole("button", { name: "Close", exact: true }).last().click();

  await chooseFile(page, () => page.getByRole("button", { name: "Import orders…" }).click(), file);
  dlg = page.getByRole("dialog", { name: "Import orders — " + file.name });
  await expect(dlg).toContainText("Reading this as a sheet.");
  await expect(dlg).toContainText("3 orders: 2 new, 1 that can't be imported.");
  await expect(previewRow(dlg, a)).toContainText("2 × Sample Tee");
  await expect(previewRow(dlg, a)).toContainText("1 × Sample Sticker (custom)");
  await expect(previewRow(dlg, a)).toContainText("paid");
  await expect(previewRow(dlg, b)).toContainText("unpaid");
  await expect(previewRow(dlg, c)).toContainText("No order date");
  // Row numbers are the file's: the third order starts on line 5.
  await expect(dlg.getByRole("checkbox", { name: "Import row 5", exact: true })).toBeDisabled();
  await dlg.getByRole("button", { name: "Import 2 orders" }).click();
  await expect(dlg).toHaveCount(0);
  await expect(toast(page)).toContainText("Orders imported: 2.");
  await expect(page.locator("#app")).toContainText("Pat Example");
  await expect(page.locator("#app")).toContainText("Imported " + a);

  const { orders } = await api("getOrders", { org: shop.orgId });
  const mine = orders.filter(o => [a, b, c].includes(o.externalOrderId));
  expect(mine.map(o => o.externalOrderId).sort()).toEqual([a, b]);
  const pa = mine.find(o => o.externalOrderId === a);
  expect(pa.customerName || pa.name).toBe("Pat Example");
  expect(pa.items.map(i => i.qty).sort()).toEqual([1, 2]);

  // The same file again: both are already in, so nothing new can be imported.
  await chooseFile(page, () => page.getByRole("button", { name: "Import orders…" }).click(), file);
  dlg = page.getByRole("dialog", { name: "Import orders — " + file.name });
  await expect(dlg).toContainText("3 orders: 0 new, 3 that can't be imported.");
  await expect(previewRow(dlg, a)).toContainText("Already imported");
  await expect(dlg.getByRole("button", { name: "Import 0 orders" })).toBeDisabled();
  await dlg.getByRole("button", { name: "Cancel" }).click();
  await expect(dlg).toHaveCount(0);
});
