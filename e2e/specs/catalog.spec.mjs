// Catalog: product categories, the full product form (a plain flat-price product and a personalised one), a
// picture uploaded to a product, hiding and showing, and Publish — then the shop page shows exactly that.
import { test, expect, shopUrl, openAdmin, waitIdle, toast, uniq, slug, pngBytes } from "../fixtures.mjs";
import { makeShop } from "../lib/data.mjs";

test.describe.configure({ mode: "serial" });

let shop;                                   // a published shop of this file's own, with one product
const cat = {};                             // the category this file adds
const plain = {}, pers = {};                // the products it makes

const productsPage = (page) => openAdmin(page, "catalog/orgs/" + shop.orgId + "/products");
// A product's row on the Products page.
const productRow = (page, name) => page.locator("main tr", { hasText: name });

// Publish from Manage catalog's row for the shop (the shop bar's button can lag behind an edit — see the known
// bug at the end of this file).
async function publish(page) {
  await openAdmin(page, "catalog");
  const row = page.locator("main tr", { hasText: shop.orgId });
  await expect(row).toContainText("Unpublished changes");
  await row.getByRole("button", { name: "Publish" }).click();
  await expect(page.locator("main tr", { hasText: shop.orgId })).toContainText("✓ Published");
  await openAdmin(page, "catalog/orgs/" + shop.orgId + "/products");
}

async function openShop(page) {
  await page.goto(shopUrl(shop.subdomain) + "/");
  await expect(page.getByRole("heading", { level: 1, name: shop.name })).toBeVisible();
}

// Fills the basics of the New product form.
async function fillBasics(page, { id, name, sub, category, price }) {
  await page.locator("#prodFormId").fill(id);
  if (category) await page.locator("#prodFormType").selectOption({ label: category });
  await page.locator("#prodFormName").fill(name);
  if (sub) await page.locator("#prodFormSub").fill(sub);
  await page.locator("#prodFormVisible").check();
  // Made without a blank or a stitch file (so the catalog check has nothing to warn about for it).
  await page.locator("#prodFormNoBlank").check();
  await page.locator("#prodFormNoDesign").check();
  await page.locator("#prodFormPricingMode").selectOption({ label: "Flat (one price)" });
  if (price != null) await page.locator("#prodFormFlatPrice").fill(String(price));
}

test.beforeAll(async ({ api }) => {
  shop = await makeShop(api, { prefix: "catalog", products: [{ name: "Sample Tee", price: 20 }] });
});

test("a new product category is added under Product categories", async ({ page }) => {
  const sfx = uniq("x").split(" ")[1];
  cat.name = "Scarf " + sfx;
  cat.heading = "Scarves " + sfx;
  await openAdmin(page, "categories");
  await expect(page.getByRole("heading", { name: "Product categories", level: 2 })).toBeVisible();
  await page.getByRole("button", { name: "+ New category" }).click();
  const dlg = page.getByRole("dialog", { name: "New category" });
  await dlg.getByLabel("Name (one of them)").fill(cat.name);
  await dlg.getByLabel("Storefront heading (several)").fill(cat.heading);
  await dlg.getByLabel("When choosing a box, it counts as").selectOption({ label: "Nothing — quote shipping by hand" });
  await dlg.getByRole("button", { name: "Create category" }).click();
  await expect(dlg).toHaveCount(0);
  const row = page.locator("main tr", { hasText: cat.name });
  await expect(row).toContainText(cat.heading);
  await expect(row).toContainText("Nothing — quote shipping by hand");
});

test("the product form refuses a product without a price, then creates a flat-price one", async ({ page }) => {
  plain.id = slug("scarf").slice(0, 30);
  plain.name = uniq("Sample Scarf");
  await productsPage(page);
  await page.getByRole("button", { name: "+ New Product (full form)" }).click();
  await expect(page).toHaveURL(new RegExp("#catalog/orgs/" + shop.orgId + "/products/new$"));
  await fillBasics(page, { id: plain.id, name: plain.name, sub: "Knitted, one size", category: cat.name });
  await page.getByRole("button", { name: "Create product" }).click();
  await expect(page.locator("#prodFormError")).toHaveText("Enter the product's price.");

  await page.locator("#prodFormFlatPrice").fill("18");
  await page.getByRole("button", { name: "Create product" }).click();
  await expect(toast(page)).toContainText("Created. Now pick its blanks and colors.");
  // It opens on the new product's own page.
  await expect(page).toHaveURL(new RegExp("#catalog/orgs/" + shop.orgId + "/products/" + plain.id + "/edit$"));
  await expect(page.locator("#prodFormName")).toHaveValue(plain.name);
  await expect(page.locator("#prodFormId")).toBeDisabled();
});

test("a picture uploaded on the product's page is kept with Save changes", async ({ page }) => {
  await openAdmin(page, "catalog/orgs/" + shop.orgId + "/products/" + plain.id + "/edit");
  await expect(page.locator("#prodFormName")).toHaveValue(plain.name);
  await page.locator("#prodImgUpload").setInputFiles({ name: "scarf-front.png", mimeType: "image/png", buffer: pngBytes(160, 120, [180, 30, 60]) });
  await expect(page.locator("#prodImgStatus")).toHaveText("1 image added — Save changes to keep it.");
  const tile = page.getByRole("img", { name: "Product image 1" });
  await expect(tile).toBeVisible();
  // The picture is really stored: the thumbnail made in the browser loads back from the image bucket.
  await expect.poll(() => tile.evaluate((img) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Save changes" }).first().click();
  await expect(toast(page)).toContainText("Saved.");
  await expect(page).toHaveURL(new RegExp("#catalog/orgs/" + shop.orgId + "/products$"));
  // Listed under its category's heading, with its price, visible.
  await expect(page.getByRole("heading", { level: 3, name: new RegExp("^" + cat.heading) })).toBeVisible();
  const row = productRow(page, plain.name);
  await expect(row).toContainText("$18.00 flat");
  await expect(row).toContainText("Visible");
});

// (Free-form: the customer types the name. A pick list of words needs a stitch file per word, so it isn't used here.)
test("a personalised product is made with a personalization price", async ({ page }) => {
  pers.id = slug("cap").slice(0, 30);
  pers.name = uniq("Sample Cap");
  await openAdmin(page, "catalog/orgs/" + shop.orgId + "/products/new");
  await fillBasics(page, { id: pers.id, name: pers.name, category: "Cap", price: 15 });
  await page.locator("#prodFormPersPrice").fill("5");
  await page.getByRole("button", { name: "Create product" }).click();
  await expect(toast(page)).toContainText("Created.");
  await expect(page.locator("#prodFormPersPrice")).toHaveValue("5");
});

test("new products are drafts until Publish; then the shop page shows them", async ({ page, context }) => {
  await productsPage(page);
  // Not on the shop page yet.
  const shopper = await context.newPage();
  await openShop(shopper);
  await expect(shopper.getByRole("heading", { level: 3, name: "Sample Tee" })).toBeVisible();
  await expect(shopper.getByRole("heading", { level: 3, name: plain.name })).toHaveCount(0);
  await expect(shopper.getByRole("heading", { level: 3, name: pers.name })).toHaveCount(0);

  await publish(page);
  await shopper.reload();
  // The new category is a section of the page, headed by its storefront heading.
  const section = shopper.getByRole("region", { name: cat.heading });
  await expect(section.getByRole("heading", { level: 3, name: plain.name })).toBeVisible();
  await expect(section).toContainText("Knitted, one size");
  await expect(section).toContainText("$18.00");
  const pic = section.getByRole("img", { name: new RegExp("^" + plain.name) });
  await expect(pic).toBeVisible();
  await expect.poll(() => pic.evaluate((img) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
  await expect(shopper.getByRole("heading", { level: 3, name: pers.name })).toBeVisible();
});

test("the shop page asks for the name to embroider and prices it in the cart", async ({ page }) => {
  await openShop(page);
  const card = page.getByRole("heading", { level: 3, name: pers.name }).locator("xpath=ancestor::*[.//button[normalize-space()='Add to cart']][1]");
  const box = card.getByRole("checkbox", { name: "Add personalization (+$5.00)" });
  await expect(box).toBeVisible();
  const nameBox = card.getByLabel("Name to embroider on " + pers.name);
  await expect(nameBox).toBeHidden();
  await box.check();
  await expect(nameBox).toBeVisible();
  await nameBox.fill("CAPTAIN JO");
  await card.getByRole("button", { name: "Add to cart" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Your order (1 item)" })).toBeVisible();
  await expect(page.locator("main")).toContainText("CAPTAIN JO");
  // $15 + $5 personalization.
  await expect(page.locator("main")).toContainText('+ personalization: "CAPTAIN JO"');
  await expect(page.locator("main")).toContainText(/Total\s*\$20\.00/);
});

test("a price change stays a draft: shoppers pay the published price until Publish", async ({ page, context }) => {
  await openAdmin(page, "catalog/orgs/" + shop.orgId + "/products/" + plain.id + "/edit");
  await page.locator("#prodFormFlatPrice").fill("22");
  await page.getByRole("button", { name: "Save changes" }).first().click();
  // A changed price is shown worked out first: what the item costs and leaves at the new price.
  const check = page.getByRole("dialog", { name: "Price check — " + plain.name });
  await expect(check.getByRole("row", { name: /^One price \$22\.00/ })).toBeVisible();
  await check.getByRole("button", { name: "Back to products" }).click();
  await expect(toast(page)).toContainText("Saved.");
  await expect(productRow(page, plain.name)).toContainText("$22.00 flat");

  const shopper = await context.newPage();
  await openShop(shopper);
  const section = shopper.getByRole("region", { name: cat.heading });
  await expect(section).toContainText("$18.00");
  await expect(section).not.toContainText("$22.00");

  await publish(page);
  await shopper.reload();
  await expect(shopper.getByRole("region", { name: cat.heading })).toContainText("$22.00");
});

test("a hidden product leaves the shop page after Publish, and comes back when shown", async ({ page, context }) => {
  await productsPage(page);
  await productRow(page, plain.name).getByRole("button", { name: "Hide" }).click();
  await expect(productRow(page, plain.name)).toContainText("Hidden");
  await expect(productRow(page, plain.name).getByRole("button", { name: "Show" })).toBeVisible();
  await publish(page);

  const shopper = await context.newPage();
  await openShop(shopper);
  await expect(shopper.getByRole("heading", { level: 3, name: plain.name })).toHaveCount(0);
  await expect(shopper.getByRole("heading", { level: 3, name: pers.name })).toBeVisible();

  await productRow(page, plain.name).getByRole("button", { name: "Show" }).click();
  await expect(productRow(page, plain.name)).toContainText("Visible");
  await publish(page);
  await shopper.reload();
  await expect(shopper.getByRole("heading", { level: 3, name: plain.name })).toBeVisible();
});

test("the Read only role sees the products but can't add or change one", async ({ as }) => {
  const tee = shop.products[0].name;     // the shop's own first product (made before this file's tests)
  const p = await as("viewer");
  await openAdmin(p, "catalog/orgs/" + shop.orgId + "/products");
  await expect(productRow(p, tee)).toBeVisible();
  await expect(p.getByRole("button", { name: "+ New Product (full form)" })).toBeHidden();
  await expect(productRow(p, tee).getByRole("button", { name: "Hide" })).toBeHidden();
  // …and the server refuses it anyway.
  const status = await p.evaluate(async (org) => (await fetch("/api/orders", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "createProduct", org, productId: "viewer-made", type: "shirt", name: "Not allowed", pricingMode: "flat", flatPrice: 5, visible: true, images: [] }) })).status, shop.orgId);
  expect(status).toBe(403);
});

// Fixed (was a minor bug): after a product is saved, the shop bar above the Products page kept showing
// "✓ Published" (disabled) — the shop bar re-reads the publish state at most every 15 seconds
// (loadShopBarData_), and saving doesn't ask it to — while the same page's own line says "Unpublished changes".
// (Last in the file: a failed test, even an expected one, can restart the worker.)
test("after a product is changed, the shop bar offers Publish straight away", async ({ page }) => {
  await openAdmin(page, "catalog/orgs/" + shop.orgId + "/products/" + plain.id + "/edit");
  await page.locator("#prodFormSub").fill("Knitted, one size, fringed");
  await page.getByRole("button", { name: "Save changes" }).first().click();
  await expect(toast(page)).toContainText("Saved.");
  await expect(page).toHaveURL(new RegExp("#catalog/orgs/" + shop.orgId + "/products$"));
  await expect(page.locator("main")).toContainText("Unpublished changes");
  await waitIdle(page);
  await expect(page.getByRole("navigation", { name: "Shop" }).locator("button.shop-bar-pub")).toBeEnabled({ timeout: 3000 });
});
