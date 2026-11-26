// Orders → + Local sale sells a shop's products with the same choices its page offers (public/admin.js
// showLocalSaleModal, functions/api/orders.js createLocalSale). A product where the customer picks a garment color and
// a graphic at each location could not be sold here: the window had no way to pick them, and Record sale answered
// "Could not record local sale: Pick a garment color." What's checked, through the page:
//
// - the window lists the product's garment colors, each location's graphics (filtered for the color, with their
//   add-ons), the thread color of a graphic with several, and the customer's own design where the product takes one;
// - nothing picked is refused in the window, as on the shop's page;
// - the price follows the color's price group and the graphic's add-on; the sale is recorded and its line keeps the
//   choices (what production makes);
// - Override price on such a product keeps the choices too;
// - a plain product that takes only the customer's own design has the box ticked, and the line keeps the design's
//   entry for Files, with its add-on.
// - Edit items → + Add item: an added line of a product with choices gets the same lists and is saved with them.
//
// Each test makes its own shop, location, graphics and products through the owner's API; the sale is made through
// the page.
import { test, expect, openAdmin, leaveAdmin, toast, uniq, ADMIN } from "../fixtures.mjs";
import { makeShop } from "../lib/data.mjs";

// A shop with a $20 tee where the customer picks Navy or Heather (Heather $24) and, at Left chest, Crest (a $3
// add-on, in White or Gold) or Star (Navy only); and, unless { logoTee: false }, an $18 tee made only from the
// customer's own design ($5).
async function optionsShop(api, { logoTee = true } = {}) {
  const location = uniq("Left chest");
  const locId = (await api("saveLocation", { location: { name: location } })).id;
  // The graphics belong to the shop, so the shop comes first: made with no products, then filled in.
  const shop = await makeShop(api, { prefix: "lso", products: [], publish: false });
  const crestId = (await api("saveGraphic", { org: shop.orgId, graphic: { name: "Crest", kind: "transfer", tier: "small", inkColors: ["White", "Gold"], visible: true } })).id;
  const starId = (await api("saveGraphic", { org: shop.orgId, graphic: { name: "Star", kind: "transfer", allowedGarmentColors: ["Navy"], visible: true } })).id;
  await api("setTierPrices", { org: shop.orgId, tiers: { small: 3 } });
  const key = "loc" + locId;
  const tee = { productId: "tee" + Date.now().toString(36).slice(-4), name: uniq("Club Tee") };
  await api("createProduct", { org: shop.orgId, productId: tee.productId, type: "shirt", name: tee.name, pricingMode: "flat", flatPrice: 20, visible: true, images: [],
    configurable: true, garmentColors: ["Navy", "Heather"], colorGroups: [{ label: "Heather", colors: ["Heather"], flatPrice: 24 }], reorderQr: "none", noDesignNeeded: true,
    locations: [{ key, label: location, locationId: locId, graphicIds: [crestId, starId] }] });
  let logo = null;
  if (logoTee) {
    logo = { productId: "logo" + Date.now().toString(36).slice(-4), name: uniq("Your Logo Tee") };
    await api("createProduct", { org: shop.orgId, productId: logo.productId, type: "shirt", name: logo.name, pricingMode: "flat", flatPrice: 18, visible: true, images: [],
      customDesign: "transfer", customDesignPrice: 5 });
  }
  await api("publish", { org: shop.orgId });
  return { shop, tee, logo, key, location, crestId, starId };
}

const openLocalSale = async (page, shop) => {
  if (page.url().startsWith(ADMIN)) await leaveAdmin(page);
  await openAdmin(page, "orders/" + shop.orgId);
  await expect(page.getByRole("combobox", { name: "Shop" })).toHaveValue(shop.orgId);
  await page.getByRole("button", { name: "+ Local sale" }).click();
  const form = page.locator("#localSaleForm");
  await expect(form).toBeVisible();
  return form;
};
const lineOf = async (api, shop, customer) => {
  const o = (await api("getOrders", { org: shop.orgId })).orders.find(x => x.customerName === customer);
  return o ? o.items[0] : null;
};

test("Local sale: a product with a garment color and graphics is sold with them, at the color's price plus the add-on", async ({ page, api }) => {
  const { shop, tee, key, location, crestId } = await optionsShop(api, { logoTee: false });
  const form = await openLocalSale(page, shop);
  await form.locator("#lsProduct").selectOption({ label: tee.name });

  const color = form.getByLabel("Garment color");
  await expect(color).toBeVisible();
  await expect(color.locator("option")).toHaveText(["Navy", "Heather"]);
  const graphic = form.getByLabel(location, { exact: true });
  // One location: nothing to leave blank, so no None and the first graphic is picked (as on the shop's page).
  await expect(graphic.locator("option")).toHaveText(["Crest (+$3.00)", "Star"]);
  await color.selectOption("Heather");
  await expect(graphic.locator("option")).toHaveText(["Crest (+$3.00)"]);   // Star is for Navy only
  const ink = form.getByLabel("Thread color for " + location);
  await expect(ink).toBeVisible();
  await ink.selectOption("Gold");
  await form.locator("#lsQty").fill("2");
  await expect(form.locator("#lsPricePreview")).toContainText("= $54.00");   // ($24 + $3) × 2

  const customer = uniq("Lee Walkin");
  await form.locator("#lsPayment").selectOption("Cash");
  await form.locator("summary", { hasText: "Customer info" }).click();
  await form.locator("#lsName").fill(customer);
  await form.getByRole("button", { name: "Record sale" }).click();
  await expect(toast(page)).toContainText("Local sale recorded — ");
  await expect(page.locator("#localSaleForm")).toHaveCount(0);
  await expect(page.locator("tr[data-order]", { hasText: customer })).toHaveCount(1);

  const line = await lineOf(api, shop, customer);
  expect(line.unitPrice).toBe(27);
  expect(line.config.garmentColor).toBe("Heather");
  expect(line.config.locations.find(l => l.location === key)).toMatchObject({ graphicId: crestId, ink: "Gold", graphicName: "Crest" });
});

test("Local sale: Override price on a product with choices keeps the choices on the line", async ({ page, api }) => {
  const { shop, tee, key, location, starId } = await optionsShop(api, { logoTee: false });
  const form = await openLocalSale(page, shop);
  await form.locator("#lsProduct").selectOption({ label: tee.name });
  await form.getByLabel("Garment color").selectOption("Navy");
  await form.getByLabel(location, { exact: true }).selectOption({ label: "Star" });
  await form.locator("#lsOverridePrice").check();
  await form.locator("#lsCustomPrice").fill("12");
  const customer = uniq("Robin Discount");
  await form.locator("#lsPayment").selectOption("Cash");
  await form.locator("summary", { hasText: "Customer info" }).click();
  await form.locator("#lsName").fill(customer);
  await form.getByRole("button", { name: "Record sale" }).click();
  await expect(toast(page)).toContainText("Local sale recorded — ");

  const line = await lineOf(api, shop, customer);
  expect(line.unitPrice).toBe(12);
  expect(line.config.garmentColor).toBe("Navy");
  expect(line.config.locations.find(l => l.location === key)).toMatchObject({ graphicId: starId });
});

test("Local sale: a product made from the customer's own design has it ticked, and the line waits for the file", async ({ page, api }) => {
  const { shop, logo } = await optionsShop(api);
  const form = await openLocalSale(page, shop);
  await form.locator("#lsProduct").selectOption({ label: logo.name });
  const own = form.getByLabel(/Customer's own design/);
  await expect(own).toBeChecked();
  await expect(own).toBeDisabled();
  await expect(form.getByLabel("Garment color")).toBeHidden();
  await expect(form.locator("#lsPricePreview")).toContainText("= $23.00");   // $18 + the design's $5
  const customer = uniq("Sam Ownlogo");
  await form.locator("#lsPayment").selectOption("Cash");
  await form.locator("summary", { hasText: "Customer info" }).click();
  await form.locator("#lsName").fill(customer);
  await form.getByRole("button", { name: "Record sale" }).click();
  await expect(toast(page)).toContainText("Local sale recorded — ");

  const line = await lineOf(api, shop, customer);
  expect(line.unitPrice).toBe(23);
  expect(line.config.locations.find(l => l.custom)).toMatchObject({ location: "customdesign", uploadId: null });
});

// Edit items → + Add item had the same gap: an added line of a product with choices had no color or graphic lists, so
// Save answered "Edit failed: Pick a garment color."
test("Edit items: + Add item sells a product with choices too, at the color's price plus the add-on", async ({ page, api }) => {
  const { shop, tee, key, location, crestId } = await optionsShop(api, { logoTee: false });
  // An order with one cap, made through Local sale's own request.
  await api("createProduct", { org: shop.orgId, productId: "cap", type: "cap", name: "Club Cap", pricingMode: "flat", flatPrice: 15, visible: true, images: [], noDesignNeeded: true });
  await api("publish", { org: shop.orgId });
  const customer = uniq("Edit Mee");
  const { orderId } = await api("createLocalSale", { org: shop.orgId, customerName: customer, paymentMethod: "Cash", items: [{ productId: "cap", size: "OSFA", qty: 1 }] });

  if (page.url().startsWith(ADMIN)) await leaveAdmin(page);
  await openAdmin(page, "orders/" + shop.orgId);
  await page.locator(`tr[data-order="${orderId}"]`).first().locator("td[data-action-td]").getByRole("button", { name: "Edit items" }).click();
  const rows = page.locator("#editOrderRows");
  await expect(rows).toBeVisible();
  await page.getByRole("button", { name: "+ Add item" }).click();
  const added = rows.locator("tr").nth(1);
  await added.locator('select[data-field="productId"]').selectOption({ label: tee.name });
  const color = added.getByLabel("Garment color");
  await expect(color.locator("option")).toHaveText(["Navy", "Heather"]);
  await color.selectOption("Heather");
  await added.getByLabel(location, { exact: true }).selectOption({ label: "Crest (+$3.00)" });
  await added.getByLabel("Thread color for " + location).selectOption("Gold");
  await expect(page.locator("#editOrderNewTotal")).toHaveText("$42.00");   // the cap's $15 + Heather's $24 + Crest's $3
  await page.locator("#editOrderSave").click();
  await expect(toast(page)).toContainText("Order updated");

  const order = (await api("getOrders", { org: shop.orgId })).orders.find(o => o.orderId === orderId);
  const line = order.items.find(i => i.productId === tee.productId);
  expect(line.unitPrice).toBe(27);
  expect(line.config.garmentColor).toBe("Heather");
  expect(line.config.locations.find(l => l.location === key)).toMatchObject({ graphicId: crestId, ink: "Gold" });
});
