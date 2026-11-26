// A product's blank links (the product form's "Blank & colors" card, admin.js loadBlankLinksSection): each product size
// — and, for a product the customer picks a color on, each color + size — linked to a blank's color and size, which is
// what stock and cost of goods are tracked by. No other spec drives this section through the page: gap-role-limits and
// gap-costs set links through the API.
//
// Covered here, through the page: linking (one row by hand, then "Auto-map all from the first row"), what the section
// offers (blanks of the product's type; archived ones only where already linked; a linked blank of another type, with
// a note), changing a link and taking one off (None), the MAP check refusing a link, a color the product offers that
// wasn't linked yet (filled in by name), moving a color's size to another ticked blank, a color dropped taking its
// links with it, and the role limits (Back office can change a link but not take it off; Read only sees it locked).
// After each save: the links the server keeps, the product's "Needs attention" list, and the Blanks screen's
// "used by" and stock.
//
// Taking a link off asks no question of its own: it is a "— None —" pick, saved with Save changes.
// Every blank and shop is made here with unique names; the checks only read this file's own rows.
import { test, expect, openAdmin, toast, uniq, waitIdle } from "../fixtures.mjs";
import { makeShop } from "../lib/data.mjs";

const BRAND = "Test Blank Co";

// A blank made through the owner's API: `colors` { color: { size: quantity } }, every size at `price` (and `map`).
async function makeBlank(api, name, { type = "shirt", colors = { Navy: { S: 4, M: 5, L: 6 } }, price = 4.5, map = null } = {}) {
  const r = await api("createBlank", {
    name, productType: type, vendor: "", brand: BRAND, sku: "", notes: "", color: Object.keys(colors)[0],
    colors: Object.entries(colors).map(([color, sizes]) => ({ color, images: [],
      sizes: Object.entries(sizes).map(([size, quantity]) => ({ size, quantity, vendorPrice: price, ...(map != null ? { mapPrice: map } : {}) })) })),
  });
  return r.id;
}
// A shop with one product sold in S / M / L (or the sizes given).
const sizedShop = (api, prefix, name, sizePricing = { S: 20, M: 20, L: 22 }, extra = {}) =>
  makeShop(api, { prefix, products: [{ name, price: 0, idPrefix: "linked", extra: { pricingMode: "sized", sizePricing, ...extra } }] });
// Links set through the owner's API (the product form's own request): every size given to `blankId`, same size name.
const linkAll = (api, shop, productId, blankId, sizes, color = "Navy", productColor = "") =>
  api("saveBlankLinks", { org: shop.orgId, productId, remove: [],
    set: sizes.map(z => ({ productColor, productSize: z, blankId, blankColor: color, blankSize: z })) });

// The product's links as the server keeps them: "color|size" → "blankId color size".
async function linksOf(api, shop, productId) {
  const out = {};
  for (const l of (await api("getBlankLinks", { org: shop.orgId })).links) {
    if (l.productId === productId) out[(l.productColor || "") + "|" + l.productSize] = `${l.blankId} ${l.blankColor} ${l.blankSize}`;
  }
  return out;
}

const productForm = async (page, shop, productId) => {
  await openAdmin(page, "catalog/orgs/" + shop.orgId + "/products/" + productId + "/edit");
  await expect(page.locator("#blankLinksSection")).not.toContainText("Loading blank links");
  return page.locator("#blankLinksSection");
};
// A product size's row in the section (for a color, inside its block): its three pickers — blank, blank color, size.
const linkRow = (section, size, color = null) => {
  const scope = color ? section.locator(`details.bl-block[data-pc="${color}"]`) : section;
  const row = scope.locator("tbody tr").filter({ has: section.page().getByRole("cell", { name: size, exact: true }) });
  return { row, blank: row.getByRole("combobox").nth(0), color: row.getByRole("combobox").nth(1), size: row.getByRole("combobox").nth(2) };
};
const optionTexts = (select) => select.locator("option").allTextContents();
// The form's Save changes, back on the products list (through the price check window when one is shown).
async function saveForm(page) {
  await page.getByRole("button", { name: "Save changes" }).first().click();
  await expect(toast(page)).toContainText("Saved.");
  const check = page.getByRole("dialog", { name: /^Price check — / });
  await expect(async () => {
    if (await check.isVisible()) await check.getByRole("button", { name: "Back to products" }).click();
    await expect(page).toHaveURL(/#catalog\/orgs\/[^/]+\/products$/, { timeout: 500 });
  }).toPass();
}
// The blank's row on Inventory → Blanks, found with the list's search box.
async function blankRow(page, name) {
  await openAdmin(page, "inventory");
  await page.getByRole("searchbox", { name: /Search name, vendor/ }).fill(name);
  const row = page.getByRole("row", { name: new RegExp(name) });
  await expect(row).toBeVisible();
  return row;
}

test("the owner links a product's sizes to a blank: one row by hand, the rest by Auto-map, saved with Save changes", async ({ page, api }) => {
  const A = uniq("Links Blank A"), B = uniq("Links Blank B"), OLD = uniq("Links Blank Retired"), CAP = uniq("Links Cap Blank");
  const idA = await makeBlank(api, A, { colors: { Navy: { S: 4, M: 5, L: 6 }, Heather: { S: 1, M: 1, L: 1 } } });
  await makeBlank(api, B);
  const idOld = await makeBlank(api, OLD);
  await api("setBlankArchived", { id: idOld, archived: true });
  await makeBlank(api, CAP, { type: "cap", colors: { Navy: { OSFA: 3 } } });
  const name = uniq("Links Tee");
  const shop = await sizedShop(api, "links", name);
  const productId = shop.products[0].productId;

  const section = await productForm(page, shop, productId);
  // Nothing linked yet: the product's checks say so, and every size starts at None.
  await expect(page.locator("#prodFormIssues")).toContainText("Not linked to a blank");
  const S = linkRow(section, "S"), M = linkRow(section, "M"), L = linkRow(section, "L");
  for (const r of [S, M, L]) await expect(r.blank).toHaveValue("");
  // Offered: the shirt blanks, not the archived one, not the cap.
  const offered = await optionTexts(S.blank);
  expect(offered).toEqual(expect.arrayContaining(["— None —", A, B]));
  expect(offered).not.toContain(OLD);
  expect(offered).not.toContain(CAP);

  // Auto-map with nothing picked in the first row does nothing.
  await section.getByRole("button", { name: "↓ Auto-map all from the first row" }).click();
  for (const r of [S, M, L]) await expect(r.blank).toHaveValue("");

  // S: the blank, then its color (its colors are offered once the blank is picked), and the size follows by name.
  await S.blank.selectOption({ label: A });
  expect(await optionTexts(S.color)).toEqual(["—", "Navy", "Heather"]);
  await expect(S.size).toHaveValue("");
  await S.color.selectOption("Navy");
  await expect(S.size).toHaveValue("S");
  expect((await optionTexts(S.size)).sort()).toEqual(["—", "L", "M", "S"].sort());
  // Auto-map: M and L take the same blank and color, each its own size.
  await section.getByRole("button", { name: "↓ Auto-map all from the first row" }).click();
  for (const [r, z] of [[M, "M"], [L, "L"]]) {
    await expect(r.blank).toHaveValue(String(idA));
    await expect(r.color).toHaveValue("Navy");
    await expect(r.size).toHaveValue(z);
  }
  await saveForm(page);

  expect(await linksOf(api, shop, productId)).toEqual({ "|S": `${idA} Navy S`, "|M": `${idA} Navy M`, "|L": `${idA} Navy L` });

  // The Blanks screen: the blank is on sale in this product, for its three sizes; its stock is as made.
  const row = await blankRow(page, A);
  await expect(row).toContainText("ON SALE");
  await expect(row.getByRole("link", { name })).toHaveAttribute("title", `${shop.name} — sizes L, M, S`);
  for (const t of ["S: 4", "M: 5", "L: 6"]) await expect(row).toContainText(t);
  await expect(row).toContainText("18 units");
  // The other shirt blank is linked to nothing.
  await expect(await blankRow(page, B)).toContainText("NOT LINKED TO ANY PRODUCT");

  // The link on the Blanks screen opens the product: its links shown as saved, and its checks clear of them.
  await (await blankRow(page, A)).getByRole("link", { name }).click();
  await expect(page.locator("#blankLinksSection")).not.toContainText("Loading blank links");
  for (const [r, z] of [[S, "S"], [M, "M"], [L, "L"]]) {
    await expect(r.blank).toHaveValue(String(idA));
    await expect(r.color).toHaveValue("Navy");
    await expect(r.size).toHaveValue(z);
  }
  await expect(page.locator("#prodFormIssues")).not.toContainText("linked to a blank");
});

test("changing a link points a size at another color of its blank, and None takes a size off; the Blanks screen and checks follow", async ({ page, api }) => {
  const A = uniq("Links Move Blank");
  const idA = await makeBlank(api, A, { colors: { Navy: { S: 2, M: 2, L: 2 }, Heather: { L: 7 } } });
  const name = uniq("Links Move Tee");
  const shop = await sizedShop(api, "linksmove", name);
  const productId = shop.products[0].productId;
  await linkAll(api, shop, productId, idA, ["S", "M", "L"]);

  const section = await productForm(page, shop, productId);
  const S = linkRow(section, "S"), M = linkRow(section, "M"), L = linkRow(section, "L");
  await expect(S.blank).toHaveValue(String(idA));
  // L to the blank's Heather: the sizes offered are that color's (only L), and L is picked by name.
  await L.color.selectOption("Heather");
  expect(await optionTexts(L.size)).toEqual(["—", "L"]);
  await expect(L.size).toHaveValue("L");
  // S: None (the owner has Full on Blanks, so None can be picked on a saved link); its color and size go empty.
  await expect(S.blank.locator("option", { hasText: "— None —" })).toBeEnabled();
  await S.blank.selectOption({ label: "— None —" });
  await expect(S.color).toHaveValue("");
  await expect(S.size).toHaveValue("");
  await saveForm(page);

  expect(await linksOf(api, shop, productId)).toEqual({ "|M": `${idA} Navy M`, "|L": `${idA} Heather L` });

  // The Blanks screen: the blank is used for M and L now.
  await expect((await blankRow(page, A)).getByRole("link", { name })).toHaveAttribute("title", `${shop.name} — sizes L, M`);

  // The product: S is unlinked, and its checks name it.
  await productForm(page, shop, productId);
  await expect(S.blank).toHaveValue("");
  await expect(M.blank).toHaveValue(String(idA));
  await expect(L.color).toHaveValue("Heather");
  await expect(page.locator("#prodFormIssues")).toContainText("Sizes not linked to a blank: S");

  // Saving again with nothing changed sends no link change: the links stay as they are.
  await saveForm(page);
  expect(await linksOf(api, shop, productId)).toEqual({ "|M": `${idA} Navy M`, "|L": `${idA} Heather L` });
});

// BUG: a product the customer doesn't pick a color on has no Blanks & colors list to tick blanks in, yet each row's
// Blank picker offers only the blanks the product is already linked to (admin.js loadBlankLinksSection, rowBlanks
// ~14272: preferBlankIds starts as the linked blanks, which the comment at ~14216 calls "offered first"). So once one
// size is linked, no size of it can be moved to — or linked to — another blank of its type through the page.
test("a linked size of a product without colors can be moved to another blank of its type", async ({ page, api }) => {
  test.fail(true, "BUG: a classic product's Blank pickers offer only the blanks already linked (admin.js rowBlanks)");
  const A = uniq("Links Switch A"), B = uniq("Links Switch B");
  const idA = await makeBlank(api, A), idB = await makeBlank(api, B);
  const shop = await sizedShop(api, "linkswitch", uniq("Links Switch Tee"), { S: 20, M: 20 });
  const productId = shop.products[0].productId;
  await linkAll(api, shop, productId, idA, ["S", "M"]);

  const section = await productForm(page, shop, productId);
  const M = linkRow(section, "M");
  await expect(M.blank).toHaveValue(String(idA));
  expect(await optionTexts(M.blank)).toEqual(expect.arrayContaining([A, B]));
  await M.blank.selectOption({ label: B });
  await M.color.selectOption("Navy");
  await saveForm(page);
  expect(await linksOf(api, shop, productId)).toEqual({ "|S": `${idA} Navy S`, "|M": `${idB} Navy M` });
});

test("an archived blank is offered only where it's already linked, and a linked blank of another type stays, with a note", async ({ page, api }) => {
  const OLD = uniq("Links Archived Blank"), CAP = uniq("Links Odd Type Blank");
  const idOld = await makeBlank(api, OLD), idCap = await makeBlank(api, CAP, { type: "cap", colors: { Navy: { OSFA: 3, M: 3 } } });
  const shop = await makeShop(api, { prefix: "linksarch", products: [
    { name: uniq("Links Kept Tee"), price: 0, idPrefix: "kept", extra: { pricingMode: "sized", sizePricing: { S: 20, M: 20, L: 20 } } },
    { name: uniq("Links New Tee"), price: 0, idPrefix: "fresh", extra: { pricingMode: "sized", sizePricing: { S: 20, M: 20 } } },
  ] });
  const [kept, fresh] = shop.products;
  await linkAll(api, shop, kept.productId, idOld, ["S"]);
  await linkAll(api, shop, kept.productId, idCap, ["M"]);
  await api("setBlankArchived", { id: idOld, archived: true });

  // The product linked to them: both still shown and offered, and the cap's type is pointed out.
  let section = await productForm(page, shop, kept.productId);
  const S = linkRow(section, "S"), M = linkRow(section, "M"), L = linkRow(section, "L");
  await expect(S.blank).toHaveValue(String(idOld));
  await expect(S.size).toHaveValue("S");
  await expect(M.blank).toHaveValue(String(idCap));
  const note = section.locator(".bl-type-mismatch");
  await expect(note).toContainText(CAP + " is filed as");
  await expect(note).toContainText("It stays linked; change the blank's type");
  // An unlinked size is offered the blanks the product is made on: the archived one among them.
  expect(await optionTexts(L.blank)).toEqual(expect.arrayContaining([OLD, CAP]));
  await expect(page.locator("#prodFormIssues")).toContainText("Sizes not linked to a blank: L");

  // Another product of the type: neither is offered.
  section = await productForm(page, shop, fresh.productId);
  const offered = await optionTexts(linkRow(section, "S").blank);
  expect(offered).not.toContain(OLD);
  expect(offered).not.toContain(CAP);
});

test("a link that would put a price below the blank's MAP is refused, and the product's links stay as they were", async ({ page, api }) => {
  const MAP = uniq("Links Map Blank");
  const idMap = await makeBlank(api, MAP, { colors: { Navy: { S: 2, M: 2 } }, map: 25 });
  const shop = await sizedShop(api, "linksmap", uniq("Links Map Tee"), { S: 20, M: 30 });
  const productId = shop.products[0].productId;

  const section = await productForm(page, shop, productId);
  const S = linkRow(section, "S"), M = linkRow(section, "M");
  await S.blank.selectOption({ label: MAP });
  await S.color.selectOption("Navy");
  await section.getByRole("button", { name: "↓ Auto-map all from the first row" }).click();
  await expect(M.size).toHaveValue("M");
  await page.getByRole("button", { name: "Save changes" }).first().click();
  // The product itself saves; the links don't, and the page stays open saying why.
  const err = page.locator("#prodFormError");
  await expect(err).toContainText("The product was saved, but: Blank links: Not saved —");
  await expect(err).toContainText("is below the MAP of $25.00");
  await expect(err).toContainText("Raise the price first.");
  await expect(page).toHaveURL(/\/edit$/);
  expect(await linksOf(api, shop, productId)).toEqual({});

  // S raised to the MAP: saving again links both.
  await page.locator("#prodFormSize-S").fill("25");
  await saveForm(page);
  expect(await linksOf(api, shop, productId)).toEqual({ "|S": `${idMap} Navy S`, "|M": `${idMap} Navy M` });
});

test("a color the product offers is linked by name, a size moves to another ticked blank, and a color dropped takes its links", async ({ page, api }) => {
  const A = uniq("Links Color Blank A"), B = uniq("Links Color Blank B");
  const idA = await makeBlank(api, A, { colors: { Navy: { S: 3, M: 3 }, Heather: { S: 1, M: 1 } } });
  const idB = await makeBlank(api, B, { colors: { Navy: { S: 2, M: 2 } } });
  const shop = await sizedShop(api, "linkscolor", uniq("Links Color Tee"), { S: 20, M: 20 }, { configurable: true, garmentColors: ["Navy", "Heather"] });
  const productId = shop.products[0].productId;
  await linkAll(api, shop, productId, idA, ["S", "M"], "Navy", "Navy");

  let section = await productForm(page, shop, productId);
  // Heather is offered but had no links: filled in from the linked blank, by color and size name, and said so.
  await expect(section.locator(".bl-autofilled")).toContainText("Heather wasn't linked to the blank yet — linked automatically by color and size name.");
  const block = (pc) => section.locator(`details.bl-block[data-pc="${pc}"]`);
  await expect(block("Navy").locator("summary")).toContainText(`Navy → ${A} · Navy ✓ all 2 sizes linked`);
  await expect(block("Heather").locator("summary")).toContainText(`Heather → ${A} · Heather ✓ all 2 sizes linked`);
  // A fully linked color is folded away; opened, its rows show the links.
  await expect(block("Heather")).not.toHaveAttribute("open", "");
  await block("Heather").locator("summary").click();
  const hS = linkRow(section, "S", "Heather");
  await expect(hS.blank).toHaveValue(String(idA));
  await expect(hS.color).toHaveValue("Heather");
  await expect(hS.size).toHaveValue("S");
  // Unpicking a size's blank shows in the color's line at once, and picking it again puts it back.
  await hS.blank.selectOption({ label: "— None —" });
  await expect(block("Heather").locator("summary")).toContainText("⚠ 1 of 2 sizes linked");
  await hS.blank.selectOption({ label: A });
  await expect(hS.color).toHaveValue("Heather");
  await expect(hS.size).toHaveValue("S");
  await expect(block("Heather").locator("summary")).toContainText("✓ all 2 sizes linked");
  await saveForm(page);
  expect(await linksOf(api, shop, productId)).toEqual({
    "Navy|S": `${idA} Navy S`, "Navy|M": `${idA} Navy M`, "Heather|S": `${idA} Heather S`, "Heather|M": `${idA} Heather M` });

  // Blank B ticked under Blanks & colors: the rows offer it, and Navy M moves to it (its color and size by name).
  section = await productForm(page, shop, productId);
  await expect(section.locator(".bl-autofilled")).toHaveCount(0);
  await page.locator("#cfgBlankList").getByRole("checkbox", { name: new RegExp(B) }).check();
  await block("Navy").locator("summary").click();
  const nM = linkRow(section, "M", "Navy");
  expect(await optionTexts(nM.blank)).toEqual(expect.arrayContaining([A, B]));
  await nM.blank.selectOption({ label: B });
  await expect(nM.color).toHaveValue("Navy");
  await expect(nM.size).toHaveValue("M");
  // A color typed in that neither blank comes in: its sizes stay unlinked, its block open, and its line says so.
  await page.getByRole("textbox", { name: "Add a color by name" }).fill("Red");
  await page.getByRole("button", { name: "Add color" }).click();
  await expect(block("Red").locator("summary")).toContainText("Red → not linked ⚠ 0 of 2 sizes linked");
  await expect(block("Red")).toHaveAttribute("open", "");
  // Heather and Red dropped from the colors offered: their blocks go, and the save takes Heather's links off.
  await page.locator("#cfgColorList").getByRole("checkbox", { name: "Heather" }).uncheck();
  // (A typed-in color leaves the list once unticked: only the blanks' colors stay listed.)
  await page.locator("#cfgColorList").getByRole("checkbox", { name: /^Red/ }).click();
  await expect(page.locator("#cfgColorList").getByRole("checkbox", { name: /^Red/ })).toHaveCount(0);
  await expect(block("Heather")).toHaveCount(0);
  await expect(block("Red")).toHaveCount(0);
  await saveForm(page);
  expect(await linksOf(api, shop, productId)).toEqual({ "Navy|S": `${idA} Navy S`, "Navy|M": `${idB} Navy M` });

  // Both blanks list the product on the Blanks screen.
  await expect((await blankRow(page, A)).getByRole("link", { name: shop.products[0].name })).toHaveAttribute("title", `${shop.name} — sizes S`);
  await expect((await blankRow(page, B)).getByRole("link", { name: shop.products[0].name })).toHaveAttribute("title", `${shop.name} — sizes M`);
});

test("Back office can change a size's link but not take it off; Read only sees the links locked", async ({ api, as }) => {
  const A = uniq("Links Role Blank");
  const idA = await makeBlank(api, A, { colors: { Navy: { S: 2, M: 2 }, Heather: { M: 4 } } });
  const shop = await sizedShop(api, "linksrole", uniq("Links Role Tee"), { S: 20, M: 20 });
  const productId = shop.products[0].productId;
  await linkAll(api, shop, productId, idA, ["S", "M"]);

  // Back office (Edit on Blanks, not Full): None can't be picked on a saved link; another color of the blank can.
  const staff = await as("staff");
  let section = await productForm(staff, shop, productId);
  const S = linkRow(section, "S"), M = linkRow(section, "M");
  await expect(S.blank.locator("option", { hasText: "— None —" })).toBeDisabled();
  await expect(M.blank.locator("option", { hasText: "— None —" })).toBeDisabled();
  await M.color.selectOption("Heather");
  await expect(M.size).toHaveValue("M");
  await saveForm(staff);
  expect(await linksOf(api, shop, productId)).toEqual({ "|S": `${idA} Navy S`, "|M": `${idA} Heather M` });

  // Read only: the links are shown, every picker locked, and there's no Auto-map or Save changes.
  const viewer = await as("viewer");
  section = await productForm(viewer, shop, productId);
  const vS = linkRow(section, "S"), vM = linkRow(section, "M");
  await expect(vS.blank).toHaveValue(String(idA));
  await expect(vM.color).toHaveValue("Heather");
  for (const r of [vS, vM]) { await expect(r.blank).toBeDisabled(); await expect(r.color).toBeDisabled(); await expect(r.size).toBeDisabled(); }
  await expect(section.getByRole("button", { name: "↓ Auto-map all from the first row" })).toBeHidden();
  await expect(viewer.getByRole("button", { name: "Save changes" })).toBeHidden();
  await waitIdle(viewer);
  expect(await linksOf(api, shop, productId)).toEqual({ "|S": `${idA} Navy S`, "|M": `${idA} Heather M` });
});
