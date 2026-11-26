// Blanks from a vendor's product file (Blanks → Import ▾ → Vendor product file — new blanks… / — update prices…),
// coverage gap "showVendorFileImport_ / showVendorBlankReview_", which no test opened.
//
// The vendor's file (a CSV with one row per style, color and size, or an Excel .xlsx) is read in the browser; the
// window lists its styles to search and tick, and Review… sends only the ticked ones to the review window: a card
// per style — NEW BLANK (name, brand, SKU, category editable; the colors to bring in) or UPDATE of the blank on
// file (the price changes, new colors and sizes only when ticked, photos matched from the vendor's image folder by
// file name). Nothing is written until Create / apply; the summary, the Blanks list and getBlanks show the result.
// The errors a user meets — a file with no prices, a broken Excel file, no vendor picked, a new blank with no
// color ticked — and Cancel at either step, which saves nothing.
//
// Every file (and image) is invented here, and every vendor and style is unique to the test: other specs share the
// install. No vendor's real file, name or picture is used.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { test, expect, openAdmin, toast, uniq, slug, pngBytes, waitIdle } from "../fixtures.mjs";

// ---- helpers ---------------------------------------------------------------------------------------------
const csvText = (rows) => rows.map(r => r.map(v => { const s = String(v ?? ""); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(",")).join("\r\n") + "\r\n";
const csvFile = (name, rows) => ({ name, mimeType: "text/csv", buffer: Buffer.from(csvText(rows)) });
const styleId = (prefix) => slug(prefix).toUpperCase();

// A .zip of `entries` [{ name, text }], deflated — the container an Excel .xlsx file is.
function zipBytes(entries) {
  const locals = [], centrals = [];
  let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name), data = Buffer.from(e.text), comp = zlib.deflateRawSync(data), crc = zlib.crc32(data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, name, comp); centrals.push(ch, name);
    off += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
// A one-sheet .xlsx of `rows`: the header row's cells as shared strings, other text inline, numbers as numbers.
function xlsxFile(name, rows) {
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const col = (i) => String.fromCharCode(65 + i);
  const shared = rows[0].map(String);
  const cell = (v, i, r) => r === 1 ? `<c r="${col(i)}1" t="s"><v>${i}</v></c>`
    : typeof v === "number" ? `<c r="${col(i)}${r}"><v>${v}</v></c>` : `<c r="${col(i)}${r}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`;
  const sheet = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`
    + rows.map((row, ri) => `<row r="${ri + 1}">${row.map((v, i) => cell(v, i, ri + 1)).join("")}</row>`).join("") + `</sheetData></worksheet>`;
  const sst = `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}">`
    + shared.map(s => `<si><t>${esc(s)}</t></si>`).join("") + `</sst>`;
  return { name, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: zipBytes([{ name: "[Content_Types].xml", text: "<Types/>" }, { name: "xl/sharedStrings.xml", text: sst }, { name: "xl/worksheets/sheet1.xml", text: sheet }]) };
}

// A vendor for blanks, made for this test.
async function makeVendor(api) {
  const name = uniq("Example Mill Supply");
  await api("saveVendor", { vendor: { name, forBlanks: true } });
  return name;
}
const blanksWithSku = async (api, sku) => (await api("getBlanks")).blanks.filter(b => String(b.sku || "").toLowerCase() === sku.toLowerCase());
const vendorPrices = (b) => Object.fromEntries((b.colors || []).map(c => [c.color, Object.fromEntries((c.sizes || []).map(z => [z.size, z.vendorPrice]))]));

// Blanks → Import ▾ → the vendor product file item; returns its window.
async function openVendorImport(page, mode) {
  await page.getByRole("button", { name: "Import ▾", exact: true }).click();
  await page.getByRole("menuitem", { name: mode === "update" ? "Vendor product file — update prices…" : "Vendor product file — new blanks…" }).click();
  const dlg = page.getByRole("dialog", { name: mode === "update" ? "Update blanks from vendor files" : "New blanks from vendor files" });
  await expect(dlg).toBeVisible();
  return dlg;
}
// The vendor picker fills itself in once the vendor list has loaded.
async function pickVendor(dlg, vendor) {
  const sel = dlg.getByRole("combobox", { name: "Vendor" });
  await expect(sel.locator("option", { hasText: vendor })).toHaveCount(1);
  await sel.selectOption(vendor);
}
// A style's row in the file window's style list.
const styleBox = (dlg, style) => dlg.getByRole("checkbox", { name: new RegExp("^" + style + "\\b") });
const reviewDialog = (page) => page.getByRole("dialog", { name: "Review vendor blanks" });
// (A `has` locator is looked for inside each card, so it starts from the page, not from the window.)
const card = (rev, style) => rev.locator(".vb-card").filter({ has: rev.page().getByRole("checkbox", { name: style, exact: true }) });

const HEAD = ["style", "name", "brand", "category", "color", "hex", "size", "price", "description"];
const DESC = "<p>Soft ringspun cotton.</p><ul><li>Taped neck</li><li>Side seams</li></ul>";

// ---- New blanks ------------------------------------------------------------------------------------------
test("a vendor file's ticked style becomes a new blank with the colors kept in the review", async ({ page, api }) => {
  const vendor = await makeVendor(api);
  const tee = styleId("vft"), hood = styleId("vfh");
  const rows = [HEAD];
  for (const [color, hex, xl] of [["Navy", "1f2a44", 4.5], ["Red", "b03a2e", 4.5], ["Gold", "e0b030", 4.9]])
    for (const [size, price] of [["S", 3.1], ["M", 3.1], ["XL", xl]]) rows.push([tee, "Sample Heavy Tee " + tee, "Test Mill", "Shirts", color, hex, size, price, DESC]);
  for (const size of ["S", "M"]) rows.push([hood, "Sample Fleece Hood", "Test Mill", "Hoodies", "Black", "111111", size, 9, ""]);
  const file = csvFile("vendor-products-" + tee.toLowerCase() + ".csv", rows);

  await openAdmin(page, "inventory");
  const dlg = await openVendorImport(page, "new");
  await expect(dlg.getByRole("button", { name: "Review…" })).toBeDisabled();
  await pickVendor(dlg, vendor);
  await dlg.getByLabel("Vendor files").setInputFiles(file);
  await expect(dlg).toContainText(`2 styles in 11 rows of ${file.name}. Search and tick the styles to bring in.`);
  await expect(dlg).toContainText("0 picked · 2 matches");
  await expect(styleBox(dlg, tee)).toBeVisible();
  await expect(dlg.getByRole("button", { name: "Review…" })).toBeDisabled();

  // The search narrows the list; Select all shown / Clear tick and untick what it shows.
  await dlg.getByPlaceholder("Search style, name, brand…").fill("fleece");
  await expect(dlg).toContainText("0 picked · 1 match");
  await expect(styleBox(dlg, tee)).toHaveCount(0);
  await dlg.getByRole("button", { name: "Select all shown (1)" }).click();
  await expect(styleBox(dlg, hood)).toBeChecked();
  await dlg.getByRole("button", { name: "Clear" }).click();
  await expect(styleBox(dlg, hood)).not.toBeChecked();
  await dlg.getByPlaceholder("Search style, name, brand…").fill("");
  await styleBox(dlg, tee).check();
  await expect(dlg).toContainText("1 picked · 2 matches");
  await dlg.getByRole("button", { name: "Review…" }).click();

  // The review: one NEW BLANK card, its fields filled from the file, every color ticked.
  const rev = reviewDialog(page);
  await expect(rev).toBeVisible();
  await expect(dlg).toHaveCount(0);
  const c = card(rev, tee);
  await expect(c).toContainText("NEW BLANK");
  await expect(c.getByRole("textbox", { name: "Name" })).toHaveValue("Sample Heavy Tee");
  await expect(c.getByRole("textbox", { name: "Brand" })).toHaveValue("Test Mill");
  await expect(c.getByRole("textbox", { name: "SKU" })).toHaveValue(tee);
  await expect(c.getByRole("combobox", { name: "Category" })).toHaveValue("shirt");
  await expect(c).toContainText("Soft ringspun cotton.");
  await expect(c.getByRole("listitem")).toHaveText(["Taped neck", "Side seams"]);
  for (const color of ["Navy", "Red", "Gold"]) await expect(c.getByRole("checkbox", { name: color })).toBeChecked();
  // Gold's XL costs more than the other colors' XL.
  await expect(c.locator("div", { has: page.getByRole("checkbox", { name: "Gold" }) }).last()).toContainText("DIFFERENT PRICE");
  await expect(c.locator("div", { has: page.getByRole("checkbox", { name: "Navy" }) }).last()).not.toContainText("DIFFERENT PRICE");
  await expect(c).toContainText("S $3.10 · M $3.10 · XL $4.90");
  await expect(rev.getByRole("button", { name: "Create / apply (1)" })).toBeEnabled();

  // A new blank with no color ticked can't be made.
  await c.getByRole("button", { name: "None" }).first().click();
  for (const color of ["Navy", "Red", "Gold"]) await expect(c.getByRole("checkbox", { name: color })).not.toBeChecked();
  await rev.getByRole("button", { name: "Create / apply (1)" }).click();
  await expect(rev).toContainText(`${tee}: tick at least one color for the new blank (or untick the style).`);
  expect(await blanksWithSku(api, tee)).toHaveLength(0);

  // Navy and Gold, a name of our own: Create.
  const name = uniq("Sample Heavy Tee");
  await c.getByRole("checkbox", { name: "Navy" }).check();
  await c.getByRole("checkbox", { name: "Gold" }).check();
  await c.getByRole("textbox", { name: "Name" }).fill(name);
  await rev.getByRole("button", { name: "Create / apply (1)" }).click();
  await expect(rev).toContainText("Saved");
  await expect(rev).toContainText("✓ 1 new blank — 6 vendor prices set, 0 images added.");
  await expect(toast(page)).toContainText("1 new blank — 6 vendor prices set, 0 images added.");
  await rev.getByRole("button", { name: "Done" }).click();
  await expect(rev).toHaveCount(0);

  // On the Blanks list, and on the server: the colors ticked, at the file's prices, with its description.
  await page.getByRole("searchbox", { name: /Search name, vendor/ }).fill(tee);
  const row = page.getByRole("row", { name: new RegExp(name) });
  await expect(row).toBeVisible();
  await expect(row).toContainText(vendor);
  await expect(row).toContainText("Gold");
  await expect(row).not.toContainText("Red");
  const list = await blanksWithSku(api, tee);
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ name, vendor, brand: "Test Mill", productType: "shirt", description: "Soft ringspun cotton.", features: ["Taped neck", "Side seams"] });
  expect(vendorPrices(list[0])).toEqual({ Navy: { S: 3.1, M: 3.1, XL: 4.5 }, Gold: { S: 3.1, M: 3.1, XL: 4.9 } });
  expect(await blanksWithSku(api, hood)).toHaveLength(0);
});

test("an Excel (.xlsx) vendor file is read the same way", async ({ page, api }) => {
  const vendor = await makeVendor(api);
  const cap = styleId("vfx");
  const file = xlsxFile("vendor-sheet-" + cap.toLowerCase() + ".xlsx", [
    ["Style", "Product Title", "Brand Name", "Color Name", "Size Name", "Piece Price"],
    [cap, "Sample Twill Cap & Visor", "Test Mill", "Khaki", "OSFA", 2.75],
    [cap, "Sample Twill Cap & Visor", "Test Mill", "Olive", "OSFA", 2.95],
  ]);
  await openAdmin(page, "inventory");
  const dlg = await openVendorImport(page, "new");
  await pickVendor(dlg, vendor);
  await dlg.getByLabel("Vendor files").setInputFiles(file);
  await expect(dlg).toContainText(`1 style in 2 rows of ${file.name}.`);
  await expect(dlg).toContainText("Sample Twill Cap & Visor");
  await styleBox(dlg, cap).check();
  await dlg.getByRole("button", { name: "Review…" }).click();
  const rev = reviewDialog(page);
  await expect(card(rev, cap).getByRole("textbox", { name: "Name" })).toHaveValue("Sample Twill Cap & Visor");
  // No category in the file: the first one is offered; this is a cap.
  await card(rev, cap).getByRole("combobox", { name: "Category" }).selectOption("cap");
  await rev.getByRole("button", { name: "Create / apply (1)" }).click();
  await expect(rev).toContainText("✓ 1 new blank — 2 vendor prices set, 0 images added.");
  await rev.getByRole("button", { name: "Done" }).click();
  const [b] = await blanksWithSku(api, cap);
  expect(b).toMatchObject({ vendor, brand: "Test Mill", productType: "cap" });
  expect(vendorPrices(b)).toEqual({ Khaki: { OSFA: 2.75 }, Olive: { OSFA: 2.95 } });
});

// ---- Updating blanks on file ------------------------------------------------------------------------------
test("updating from a vendor file changes the prices, adds the ticked color and size, and matches the photos", async ({ page, api }, testInfo) => {
  const vendor = await makeVendor(api);
  const style = styleId("vfu"), other = styleId("vfo"), name = uniq("Sample Stocked Tee");
  const { id } = await api("createBlank", { name, vendor, sku: style, brand: "Test Mill", productType: "shirt",
    colors: [{ color: "Navy", sizes: [{ size: "S", quantity: 2, purchasePrice: 4, vendorPrice: 4 }, { size: "M", quantity: 0, vendorPrice: 4 }] }] });
  const navyImg = style.toLowerCase() + "-navy-front.png", forestImg = style.toLowerCase() + "-forest-front.png";
  const file = csvFile("vendor-update-" + style.toLowerCase() + ".csv", [
    ["style", "name", "brand", "color", "size", "price", "front image"],
    [style, "Sample Stocked Tee", "Test Mill", "Navy", "S", "4.40", navyImg],
    [style, "Sample Stocked Tee", "Test Mill", "Navy", "M", "4.00", navyImg],
    [style, "Sample Stocked Tee", "Test Mill", "Navy", "L", "4.40", navyImg],
    [style, "Sample Stocked Tee", "Test Mill", "Forest", "S", "4.40", forestImg],
    [style, "Sample Stocked Tee", "Test Mill", "Forest", "M", "4.40", forestImg],
    [other, "Sample Other Tee", "Test Mill", "White", "M", "2.00", ""],
  ]);
  // The vendor's image download, unzipped: one picture per color, by the file's own names (and one it doesn't name).
  const folder = testInfo.outputPath("vendor-images");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, navyImg), pngBytes(80, 80, [20, 30, 90]));
  fs.writeFileSync(path.join(folder, forestImg), pngBytes(80, 80, [20, 90, 40]));
  fs.writeFileSync(path.join(folder, "unrelated-photo.png"), pngBytes(16, 16));

  await openAdmin(page, "inventory");
  const dlg = await openVendorImport(page, "update");
  await pickVendor(dlg, vendor);
  await dlg.getByLabel("Vendor files").setInputFiles(file);
  await expect(dlg).toContainText("2 styles in 6 rows");
  await expect(dlg).toContainText("The styles you already have are picked.");
  await expect(dlg).toContainText("1 picked · 2 matches");
  await expect(styleBox(dlg, style)).toBeChecked();
  await expect(dlg.locator("label", { has: styleBox(page, style) })).toContainText("ON FILE");
  await expect(dlg.getByRole("button", { name: "Select all on file (1)" })).toBeVisible();
  await dlg.getByRole("button", { name: "Review…" }).click();

  const rev = reviewDialog(page);
  const c = card(rev, style);
  await expect(c).toContainText("UPDATE");
  await expect(c).toContainText(name);
  await expect(c).toContainText("Colors 2 · 1 not on file");
  await expect(c.getByRole("checkbox", { name: /Update the vendor prices of the colors it has — 1 change$/ })).toBeChecked();
  await expect(c.getByRole("checkbox", { name: "Add 1 size its colors are missing" })).not.toBeChecked();
  await expect(c.getByRole("checkbox", { name: /Forest/ })).not.toBeChecked();
  await expect(c).toContainText("NEW COLOR");
  // Navy S's price change is shown with the old price struck out; L is a size Navy doesn't have yet.
  await expect(c).toContainText("S $4.00 $4.40");
  await expect(c).toContainText("L $4.40 (new size)");
  await expect(c).toContainText("no photos yet");

  // The image folder: each color's picture is found by its file name, ticked.
  await rev.locator("#vbFolder").setInputFiles(folder);
  await expect(rev).toContainText("3 images in the folder · 2 matched");
  await expect(c.getByRole("checkbox", { name: "front" })).toHaveCount(2);
  for (const cb of await c.getByRole("checkbox", { name: "front" }).all()) await expect(cb).toBeChecked();

  // Bring in Forest and Navy's missing size, then apply.
  await c.getByRole("checkbox", { name: /Forest/ }).check();
  await c.getByRole("checkbox", { name: "Add 1 size its colors are missing" }).check();
  await rev.getByRole("button", { name: "Create / apply (1)" }).click();
  await expect(rev).toContainText("Saved", { timeout: 30_000 });
  await expect(rev).toContainText("✓ 1 updated — 4 vendor prices set, 2 images added.");
  await rev.getByRole("button", { name: "Done" }).click();
  await expect(rev).toHaveCount(0);

  // The list and the server: the same blank (no second one), stock untouched, the new prices, color, size and photos.
  await page.getByRole("searchbox", { name: /Search name, vendor/ }).fill(style);
  const row = page.getByRole("row", { name: new RegExp(name) });
  await expect(row).toContainText("Forest");
  const list = await blanksWithSku(api, style);
  expect(list.map(b => b.id)).toEqual([id]);
  expect(vendorPrices(list[0])).toEqual({ Navy: { S: 4.4, M: 4, L: 4.4 }, Forest: { S: 4.4, M: 4.4 } });
  const navy = list[0].colors.find(x => x.color === "Navy"), forest = list[0].colors.find(x => x.color === "Forest");
  expect(navy.sizes.find(z => z.size === "S").quantity).toBe(2);
  expect(navy.images).toHaveLength(1);
  expect(forest.images).toHaveLength(1);
  expect(await blanksWithSku(api, other)).toHaveLength(0);
  const hist = await api("getBlankVendorPriceHistory", { blankId: id });
  expect(JSON.stringify(hist)).toContain(vendor + " file");
});

// ---- What goes wrong, and Cancel ------------------------------------------------------------------------
test("a vendor file the import can't use says why; no vendor, or Cancel at either step, saves nothing", async ({ page, api }) => {
  const vendor = await makeVendor(api);
  const a = styleId("vfa"), b = styleId("vfb");
  const good = csvFile("vendor-good-" + a.toLowerCase() + ".csv", [
    ["style", "name", "color", "size", "price"],
    [a, "Sample Alpha Tee", "Navy", "M", "3.00"],
    [b, "Sample Beta Tee", "Navy", "M", "3.50"],
  ]);
  await openAdmin(page, "inventory");
  let dlg = await openVendorImport(page, "new");
  await pickVendor(dlg, vendor);

  // No price column: not a products file.
  await dlg.getByLabel("Vendor files").setInputFiles(csvFile("no-prices.csv", [["style", "color", "size"], [a, "Navy", "M"]]));
  await expect(dlg).toContainText("None of those files has products with prices");
  await expect(dlg.getByRole("button", { name: "Review…" })).toBeDisabled();
  // A file named .xlsx that isn't one.
  await dlg.getByLabel("Vendor files").setInputFiles({ name: "broken.xlsx", mimeType: "application/octet-stream", buffer: Buffer.from("not really a spreadsheet") });
  await expect(dlg).toContainText("That isn't an Excel (.xlsx) file.");
  await expect(dlg.getByRole("button", { name: "Review…" })).toBeDisabled();
  // Cancel at the file step.
  await dlg.getByRole("button", { name: "Cancel" }).click();
  await expect(dlg).toHaveCount(0);

  // No vendor picked (and none to guess from the file): Review… asks for one.
  dlg = await openVendorImport(page, "new");
  await dlg.getByLabel("Vendor files").setInputFiles(good);
  await expect(dlg).toContainText("2 styles in 2 rows");
  await styleBox(dlg, a).check();
  await dlg.getByRole("button", { name: "Review…" }).click();
  await expect(dlg).toContainText("Say which vendor these files are from.");
  await expect(reviewDialog(page)).toHaveCount(0);

  // Picking the vendor reads the file again; tick both, review, include none, then Cancel.
  await pickVendor(dlg, vendor);
  await expect(dlg).toContainText("0 picked · 2 matches");
  await dlg.getByRole("button", { name: "Select all shown (2)" }).click();
  await expect(dlg).toContainText("2 picked");
  await dlg.getByRole("button", { name: "Review…" }).click();
  const rev = reviewDialog(page);
  await expect(rev.locator(".vb-card")).toHaveCount(2);
  await expect(rev.getByRole("button", { name: "Create / apply (2)" })).toBeEnabled();
  await rev.getByRole("button", { name: "None", exact: true }).first().click();
  await expect(rev.getByRole("button", { name: "Create / apply (0)" })).toBeDisabled();
  await rev.getByRole("button", { name: "All", exact: true }).first().click();
  await expect(rev.getByRole("button", { name: "Create / apply (2)" })).toBeEnabled();
  await rev.getByRole("checkbox", { name: b, exact: true }).uncheck();
  await expect(rev.getByRole("button", { name: "Create / apply (1)" })).toBeEnabled();
  await rev.getByRole("button", { name: "Cancel" }).click();
  await expect(rev).toHaveCount(0);
  await waitIdle(page);
  expect(await blanksWithSku(api, a)).toHaveLength(0);
  expect(await blanksWithSku(api, b)).toHaveLength(0);
});
