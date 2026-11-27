// Decoration types and the one Run order (migrations/0118), end to end as the owner: Global settings → Decoration types
// (tick Screen print, set its prices, Save), a Screen print graphic ("Printed by") and a product of that type made on
// the pages, orders placed and paid, then Run order: the type buttons with their counts, the card, Start then Mark made,
// a DTF order under the DTF filter with Gang sheet totals, Order by, #runtransfer opening on DTF, a Production user's
// view, and Screen print switched off again (its button marked while cards remain, gone after; the product form, the
// graphic form and the server stop offering it; the shop page drops its made-label).
// It changes the decoration types and their prices for the whole install, so it runs alone, after every other spec
// (ALONE in e2e/playwright.config.mjs), and puts both back as found.
import { test, expect, shopUrl, openAdmin, navTo, toast, confirmDialog, callApi, apiContext, slug, uniq, waitIdle, stateFile } from "../fixtures.mjs";
import { makeShop, placeOrder } from "../lib/data.mjs";

test.describe.configure({ mode: "serial" });

const OFF_MSG = "That decoration type is switched off in Global settings";
const NO_ROLE = "Your role can't do this. Ask an admin.";

let before = null;                       // the install's decoration settings as found (types and prices, in cents)
const S = {};                            // what the tests share: the shop, the graphic, the products, the orders

const runFilter = (page, label) => page.locator(".ro-filter", { hasText: label });
const cardOf = (page, who) => page.locator(".ro-card", { hasText: who });
// Which of `names` are on the page, in the order their cards are drawn.
const cardOrder = (page, names) => page.locator(".ro-card").evaluateAll((els, names) => els.map(e => names.find(n => e.textContent.includes(n))).filter(Boolean), names);
const filterNames = (page) => page.locator(".ro-filter").evaluateAll(els => els.map(e => e.textContent.replace(/\s+/g, " ").trim()));
const saveGlobal = async (page) => {
  await page.getByRole("button", { name: "Save global settings" }).click();
  await expect(toast(page)).toContainText("Global settings saved.");
};
const decoBox = (page, key) => page.locator("#gFeatRow-" + key + " .gDecoType");
const dollars = (page, key, field) => page.locator("#gDeco-" + key + "-" + field);

// The shop's own part of getRunQueue for the owner.
const queue = (api) => api("getRunQueue");
const tryApi = (ctx, action, body) => callApi(ctx, action, body, { allowError: true, withStatus: true });

test.beforeAll(async ({ api }) => {
  const r = await api("getDecorationSettings");
  before = { types: r.types, pricing: r.pricing };
});

// Whatever the tests did, the install goes back to what it was.
test.afterAll(async ({ api }) => {
  if (before) await api("updateDecorationSettings", { types: before.types, pricing: before.pricing }).catch(() => {});
});

test("Global settings → Decoration types: tick Screen print and set its prices, then Save", async ({ page, api }) => {
  expect(before.types).not.toContain("screenprint");
  await openAdmin(page, "settings");
  await expect(page.getByRole("heading", { name: "Decoration types", level: 2 })).toBeVisible();
  // Every type of the registry is a row; embroidery and DTF are on in an install that never chose.
  for (const key of ["embroidery", "dtf", "screenprint", "vinyl", "dtg", "sublimation"]) await expect(page.locator("#gFeatRow-" + key)).toBeVisible();
  await expect(decoBox(page, "embroidery")).toBeChecked();
  await expect(decoBox(page, "dtf")).toBeChecked();
  await expect(decoBox(page, "screenprint")).not.toBeChecked();
  await expect(page.locator("#gPanel-screenprint")).toBeHidden();

  // Ticking it opens its prices; unticking closes them again and keeps what is in them.
  await decoBox(page, "screenprint").check();
  await expect(page.locator("#gPanel-screenprint")).toBeVisible();
  await dollars(page, "screenprint", "inkColorCents").fill("1.50");
  await dollars(page, "screenprint", "screenSetupCents").fill("20");
  await dollars(page, "screenprint", "reorderSetupCents").fill("8");
  await dollars(page, "screenprint", "costCents").fill("0.40");
  await dollars(page, "screenprint", "maxColors").fill("4");
  await decoBox(page, "screenprint").uncheck();
  await expect(page.locator("#gPanel-screenprint")).toBeHidden();
  await decoBox(page, "screenprint").check();
  await expect(dollars(page, "screenprint", "inkColorCents")).toHaveValue("1.50");

  // A price that isn't a number stops the save before anything is sent, and says where.
  await dollars(page, "screenprint", "inkColorCents").fill("-3");
  await page.getByRole("button", { name: "Save global settings" }).click();
  await expect(toast(page)).toContainText("Nothing was saved. Decoration types: Screen print — Price per ink colour, per location needs a number, 0 or more");
  await dollars(page, "screenprint", "inkColorCents").fill("1.50");

  // At least one type must stay ticked.
  await decoBox(page, "embroidery").uncheck();
  await decoBox(page, "dtf").uncheck();
  await decoBox(page, "screenprint").uncheck();
  await page.getByRole("button", { name: "Save global settings" }).click();
  await expect(toast(page)).toContainText("Decoration types: tick at least one decoration type");
  expect((await api("getDecorationSettings")).types).toEqual(before.types);   // nothing was saved
  await decoBox(page, "embroidery").check();
  await decoBox(page, "dtf").check();
  await decoBox(page, "screenprint").check();

  await saveGlobal(page);
  const saved = await api("getDecorationSettings");
  expect(saved.types).toEqual(["embroidery", "dtf", "screenprint"]);   // in the registry's order
  expect(saved.pricing.screenprint).toMatchObject({ inkColorCents: 150, screenSetupCents: 2000, reorderSetupCents: 800, costCents: 40, maxColors: 4 });
  // What a screen-print job costs the customer, from those prices (2 colours at $1.50, one location).
  const price = await api("priceDecoration", { type: "screenprint", params: { colors: 2, locations: 1 } });
  expect(price).toMatchObject({ unitCents: 300, setupCents: 4000 });
  // It comes back as saved when the page is opened again.
  await openAdmin(page, "settings");
  await expect(decoBox(page, "screenprint")).toBeChecked();
  await expect(dollars(page, "screenprint", "screenSetupCents")).toHaveValue("20.00");
  await expect(dollars(page, "screenprint", "maxColors")).toHaveValue("4");
});

test("a Screen print graphic ('Printed by') and a Screen print product are made on the pages", async ({ page, api }) => {
  S.shop = await makeShop(api, { prefix: "dsp", products: [], publish: false });
  S.graphicName = uniq("Club Crest");
  S.productName = uniq("Printed Tee");

  // The graphic: Printed (transfer sheet), Printed by Screen print (the DTF-only transfer item is hidden then).
  await openAdmin(page, "graphics/" + S.shop.orgId);
  await page.locator("#grNewBtn").click();
  const dlg = page.getByRole("dialog", { name: "New graphic" });
  await dlg.locator("#gfName").fill(S.graphicName);
  await expect(dlg.locator("#gfDecoration option")).toHaveText(["DTF transfer", "Screen print"]);
  await expect(dlg.locator("#gfTransferWrap")).toBeVisible();   // DTF: the transfer sheet item
  await dlg.locator("#gfDecoration").selectOption({ label: "Screen print" });
  await expect(dlg.locator("#gfTransferWrap")).toBeHidden();
  await dlg.locator("#gfInk").fill("Black");
  await dlg.getByRole("button", { name: "Create" }).click();
  await expect(toast(page)).toContainText("Graphic created.");
  await expect(page.locator("#grBody tr", { hasText: S.graphicName })).toContainText("Screen print");
  const g = (await api("listGraphics", { org: S.shop.orgId })).graphics.find(x => x.name === S.graphicName);
  expect(g).toMatchObject({ kind: "transfer", decoration: "screenprint" });
  S.graphicId = g.id;

  // The product form offers Screen print; the product is made with it.
  S.productId = slug("tee").slice(0, 30);
  await openAdmin(page, "catalog/orgs/" + S.shop.orgId + "/products/new");
  const sel = page.locator("#prodFormDecoration");
  await expect(sel.locator("option")).toHaveText(["Worked out from the design / transfers", "Embroidery", "DTF transfer", "Screen print"]);
  await page.locator("#prodFormId").fill(S.productId);
  await page.locator("#prodFormName").fill(S.productName);
  await page.locator("#prodFormVisible").check();
  await page.locator("#prodFormNoBlank").check();
  await page.locator("#prodFormNoDesign").check();
  await page.locator("#prodFormPricingMode").selectOption({ label: "Flat (one price)" });
  await page.locator("#prodFormFlatPrice").fill("22");
  await sel.selectOption({ label: "Screen print" });
  await page.getByRole("button", { name: "Create product" }).click();
  await expect(toast(page)).toContainText("Created. Now pick its blanks and colors.");
  const made = (await api("listProducts", { org: S.shop.orgId })).products.find(p => p.productId === S.productId);
  expect(made).toMatchObject({ decorationType: "screenprint", decoration: "screenprint" });
  // It is on the edit form as chosen.
  await openAdmin(page, "catalog/orgs/" + S.shop.orgId + "/products/" + S.productId + "/edit");
  await expect(page.locator("#prodFormDecoration")).toHaveValue("screenprint");

  // A second product prints the graphic at a location (its made-label on the shop page; printed transfers on a plain product stay DTF
  // work on the Run order), a DTF one is the DTF order's.
  const locName = uniq("Left chest");
  const locId = (await api("saveLocation", { location: { name: locName } })).id;
  S.locName = locName;
  S.labelProduct = { productId: slug("lab").slice(0, 30), name: uniq("Labelled Tee") };
  await api("createProduct", { org: S.shop.orgId, productId: S.labelProduct.productId, type: "shirt", name: S.labelProduct.name, pricingMode: "flat", flatPrice: 25,
    visible: true, images: [], noBlankNeeded: true, noDesignNeeded: true, decorationType: "screenprint", fixedTransfers: [{ locationId: locId, graphicId: S.graphicId, ink: "Black" }] });
  S.dtfProduct = { productId: slug("dtf").slice(0, 30), name: uniq("Transfer Tee") };
  S.dtfGraphic = uniq("Club Stripe");
  const dtfGraphicId = (await api("saveGraphic", { org: S.shop.orgId, graphic: { name: S.dtfGraphic, kind: "transfer", inkColors: ["White"], visible: true } })).id;
  await api("createProduct", { org: S.shop.orgId, productId: S.dtfProduct.productId, type: "shirt", name: S.dtfProduct.name, pricingMode: "flat", flatPrice: 21,
    visible: true, images: [], noBlankNeeded: true, noDesignNeeded: true, fixedTransfers: [{ locationId: locId, graphicId: dtfGraphicId, ink: "White" }] });
  await api("publish", { org: S.shop.orgId });
});

test("the shop page names what a product is made with, in the type's own words", async ({ as }) => {
  const cust = await as(null);
  await cust.goto(shopUrl(S.shop.subdomain) + "/");
  await expect(cust.getByRole("heading", { level: 1, name: S.shop.name })).toBeVisible();
  const card = cust.locator("main").getByRole("heading", { level: 3, name: S.labelProduct.name, exact: true }).locator("xpath=ancestor::*[.//button[normalize-space()='Add to cart']][1]");
  await expect(card.locator("ul.product-decor")).toContainText("Screen printed: " + S.graphicName + " — " + S.locName);
});

test("orders for Screen print and DTF are placed and paid", async ({ api, as }) => {
  test.setTimeout(120_000);
  const place = async (product, customer, due) => {
    const cust = await as(null);
    const { orderId } = await placeOrder(cust, S.shop, { items: [{ name: product.name, qty: 1 }], customer });
    await api("markPaidManual", { org: S.shop.orgId, orderId });
    await api("setOrderDueDate", { orderId, dueDate: due });
    return orderId;
  };
  const tag = uniq("x").split(" ")[1];
  // Placed in this order, due in the opposite order: A is first by date placed, B is first by due date.
  S.a = { customer: "Customer Alpha " + tag, product: { name: S.productName } };
  S.b = { customer: "Customer Bravo " + tag, product: { name: S.productName } };
  S.c = { customer: "Customer Charlie " + tag, product: S.dtfProduct };
  S.a.orderId = await place(S.a.product, S.a.customer, "2099-03-01");
  S.b.orderId = await place(S.b.product, S.b.customer, "2099-01-01");
  S.c.orderId = await place(S.c.product, S.c.customer, "2099-02-01");

  const q = await queue(api);
  const cards = q.other.ready.filter(c => [S.a.orderId, S.b.orderId].includes(c.orderId));
  expect(cards.map(c => c.type)).toEqual(["screenprint", "screenprint"]);
  expect(q.transfers.ready.concat(q.transfers.waiting).filter(c => c.orderId === S.c.orderId)).toHaveLength(1);
  expect(q.types).toEqual(["embroidery", "dtf", "screenprint"]);
  expect(q.counts.screenprint).toBeGreaterThanOrEqual(2);
});

test("Run order: type buttons with counts, Order by, the card, Start then Mark made, a DTF order with Gang sheet totals", async ({ page, api }) => {
  test.setTimeout(150_000);
  await openAdmin(page, "runorder");
  await expect(page).toHaveTitle(/Run Order/);
  // One menu item for everything: the old Run Transfer Sheets item is gone.
  const nav = page.getByRole("navigation", { name: "Admin" });
  await expect(nav.locator('button[data-h="runorder"]').first()).toBeAttached();
  await expect(nav.locator('button[data-h="runtransfer"]')).toHaveCount(0);

  // Type buttons: All, then one per type that is on, each with its count (the server's own).
  const q = await queue(api);
  const names = await filterNames(page);
  expect(names[0]).toBe("All (" + (q.counts.embroidery + q.counts.dtf + q.counts.screenprint) + ")");
  expect(names).toEqual(expect.arrayContaining(["Embroidery (" + q.counts.embroidery + ")", "DTF (" + q.counts.dtf + ")", "Screen print (" + q.counts.screenprint + ")"]));
  for (const off of ["Vinyl", "DTG", "Sublimation"]) expect(names.join("|")).not.toContain(off);
  await expect(runFilter(page, "All")).toHaveAttribute("aria-pressed", "true");

  // All: the cards of every type, with their own chip.
  for (const w of [S.a.customer, S.b.customer, S.c.customer]) await expect(cardOf(page, w)).toHaveCount(1);
  await expect(cardOf(page, S.a.customer).locator(".ro-chip")).toHaveText("Screen print");
  await expect(cardOf(page, S.c.customer).locator(".ro-chip")).toHaveText("DTF");
  await expect(cardOf(page, S.a.customer)).toContainText(S.productName + " (OSFA)");
  await expect(cardOf(page, S.a.customer)).toContainText("Qty 1");

  // Screen print only.
  await runFilter(page, "Screen print").click();
  await expect(runFilter(page, "Screen print")).toHaveAttribute("aria-pressed", "true");
  await expect(runFilter(page, "All")).toHaveAttribute("aria-pressed", "false");
  await expect(cardOf(page, S.c.customer)).toHaveCount(0);
  await expect(page.locator(".ro-card:not([data-type='screenprint'])")).toHaveCount(0);
  await expect(page.locator("#rtGang")).toHaveCount(0);   // Gang sheet totals belong to DTF

  // Order by: Due date (the default) puts the earlier due date first; Order date puts the order placed first, first.
  await expect(page.locator("#roSort")).toHaveValue("due");
  const both = [S.a.customer, S.b.customer];
  await expect.poll(() => cardOrder(page, both)).toEqual([S.b.customer, S.a.customer]);
  await page.locator("#roSort").selectOption({ label: "Order date" });
  await expect.poll(() => cardOrder(page, both)).toEqual([S.a.customer, S.b.customer]);
  await page.locator("#roSort").selectOption({ label: "Customer / shop" });
  await page.locator("#roSort").selectOption({ label: "Due date" });
  await expect.poll(() => cardOrder(page, both)).toEqual([S.b.customer, S.a.customer]);
  // The choices are kept on this computer: after a reload the page opens on them.
  await page.locator("#roSort").selectOption({ label: "Order date" });
  await page.reload();
  await expect(page.locator("#roSort")).toHaveValue("order");
  await expect(runFilter(page, "Screen print")).toHaveAttribute("aria-pressed", "true");
  await page.locator("#roSort").selectOption({ label: "Due date" });

  // Start, then Mark made, on order B's card.
  const b = cardOf(page, S.b.customer);
  await expect(b).toHaveCount(1);
  await expect(b).toContainText("Qty 1");
  await expect(b.getByRole("button", { name: "Start", exact: true })).toBeVisible();
  await expect(b.locator(".ro-started")).toHaveCount(0);
  await b.getByRole("button", { name: "Start", exact: true }).click();
  await expect(toast(page)).toContainText("Started.");
  await expect(cardOf(page, S.b.customer).locator(".ro-started")).toHaveText("● Started");
  await expect(cardOf(page, S.b.customer).getByRole("button", { name: "Start", exact: true })).toHaveCount(0);
  expect((await queue(api)).other.ready.find(c => c.orderId === S.b.orderId).started).toBe(true);
  // Undo takes the start back.
  await cardOf(page, S.b.customer).getByRole("button", { name: "Undo" }).click();
  await expect(toast(page)).toContainText("Start undone.");
  await expect(cardOf(page, S.b.customer).locator(".ro-started")).toHaveCount(0);
  expect((await queue(api)).other.ready.find(c => c.orderId === S.b.orderId).started).toBe(false);
  await cardOf(page, S.b.customer).getByRole("button", { name: "Start", exact: true }).click();
  await expect(cardOf(page, S.b.customer).locator(".ro-started")).toBeVisible();

  // Mark made asks when; Cancel leaves it as it is.
  await cardOf(page, S.b.customer).getByRole("button", { name: "Mark made" }).click();
  const when = page.getByRole("dialog").last();
  await expect(when).toContainText("Mark this line made?");
  await when.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(cardOf(page, S.b.customer)).toHaveCount(1);
  expect((await api("getOrders", { org: S.shop.orgId })).orders.find(o => o.orderId === S.b.orderId).manufacturedAt).toBeFalsy();
  await cardOf(page, S.b.customer).getByRole("button", { name: "Mark made" }).click();
  await confirmDialog(page);
  await expect(toast(page)).toContainText("Order complete.");
  await expect(cardOf(page, S.b.customer)).toHaveCount(0);
  const order = (await api("getOrders", { org: S.shop.orgId })).orders.find(o => o.orderId === S.b.orderId);
  expect(order.manufacturedAt).toBeTruthy();
  // The other screen-print order is untouched.
  await expect(cardOf(page, S.a.customer)).toHaveCount(1);

  // DTF: its own button, its card with the transfer buttons, and the Gang sheet totals.
  await runFilter(page, "DTF").click();
  await expect(cardOf(page, S.c.customer)).toHaveCount(1);
  await expect(cardOf(page, S.a.customer)).toHaveCount(0);
  await expect(cardOf(page, S.c.customer).locator(".ro-chip")).toHaveText("DTF");
  await expect(cardOf(page, S.c.customer)).toContainText(S.dtfGraphic);       // its transfer's picture tile
  await expect(cardOf(page, S.c.customer)).toContainText("Waiting on transfers");
  await expect(cardOf(page, S.c.customer).getByRole("button", { name: "Mark made" })).toHaveCount(0);
  await page.locator("#rtGang").click();
  const gang = page.getByRole("dialog", { name: "Gang sheet totals" });
  await expect(gang).toBeVisible();
  await expect(gang).toContainText("What still has to be printed");
  await expect(gang).toContainText(S.dtfGraphic);
  await expect(gang.getByRole("button", { name: "Download CSV" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // Mark transfer received (asks when): the card is ready and offers Mark made.
  await cardOf(page, S.c.customer).getByRole("button", { name: "Mark transfer received" }).click();
  await confirmDialog(page);
  await expect(toast(page)).toContainText("Transfer received.");
  await expect(cardOf(page, S.c.customer).getByRole("button", { name: "Mark made" })).toBeVisible();
  await expect(cardOf(page, S.c.customer)).not.toContainText("Waiting on");
});

test("#runtransfer opens the Run order with DTF selected", async ({ page }) => {
  await openAdmin(page, "runtransfer");
  await expect(page).toHaveURL(/#runorder$/);
  await expect(runFilter(page, "DTF")).toHaveAttribute("aria-pressed", "true");
  await expect(cardOf(page, S.c.customer)).toHaveCount(1);
  await expect(page.locator(".ro-card:not([data-type='dtf'])")).toHaveCount(0);
  await expect(page.locator("#rtGang")).toBeVisible();
  // All brings every type back.
  await runFilter(page, "All").click();
  await expect(cardOf(page, S.a.customer)).toHaveCount(1);
  await expect(cardOf(page, S.c.customer)).toHaveCount(1);
});

test("a Production user sees the Run order, its type buttons and cards, and can Start one", async ({ as, api }) => {
  const prod = await as("production");
  await openAdmin(prod, "runorder");
  await expect(prod.locator("#roBody")).not.toContainText("Loading");
  await expect(runFilter(prod, "Screen print")).toBeVisible();
  await expect(runFilter(prod, "DTF")).toBeVisible();
  await expect(cardOf(prod, S.a.customer)).toHaveCount(1);
  await expect(cardOf(prod, S.c.customer)).toHaveCount(1);
  await expect(prod.locator("#rtGang")).toBeVisible();
  await runFilter(prod, "Screen print").click();
  await cardOf(prod, S.a.customer).getByRole("button", { name: "Start", exact: true }).click();
  await expect(toast(prod)).toContainText("Started.");
  await expect(cardOf(prod, S.a.customer).locator(".ro-started")).toBeVisible();
  await cardOf(prod, S.a.customer).getByRole("button", { name: "Undo" }).click();
  await expect(toast(prod)).toContainText("Start undone.");
  // #runtransfer is open to Production too.
  await openAdmin(prod, "runtransfer");
  await expect(runFilter(prod, "DTF")).toHaveAttribute("aria-pressed", "true");
});

test("the server: who may read the Run order, mark work, and change the decoration types", async ({ api }, testInfo) => {
  const api_ = api;
  const viewer = await apiContext("viewer", testInfo.workerIndex);
  const manager = await apiContext("manager", testInfo.workerIndex);
  const prod = await apiContext("production", testInfo.workerIndex);
  const staff = await apiContext("staff", testInfo.workerIndex);
  try {
    const card = (await queue(api_)).other.ready.find(c => c.orderId === S.a.orderId);
    const line = { orderId: S.a.orderId, itemId: card.itemId };
    // Read only may read the Run order and the types, and cannot mark anything or change them.
    const seen = await tryApi(viewer, "getRunQueue", {});
    expect(seen.status).toBe(200);
    expect(seen.data.types).toEqual(["embroidery", "dtf", "screenprint"]);
    for (const [action, body] of [["setDecorationStarted", { ...line, on: true }], ["makeDecoratedLine", line], ["updateDecorationSettings", { types: ["embroidery"] }]]) {
      const r = await tryApi(viewer, action, body);
      expect(r.status, action).toBe(403);
      expect(r.data.message, action).toBe(NO_ROLE);
    }
    expect((await queue(api_)).other.ready.find(c => c.orderId === S.a.orderId).started).toBe(false);
    // Back office and Production read it; both may mark work (run.markMade edit).
    for (const ctx of [staff, prod]) {
      const r = await tryApi(ctx, "getRunQueue", {});
      expect(r.status).toBe(200);
      expect(r.data.other.ready.length + r.data.other.waiting.length).toBeGreaterThan(0);
      expect(r.data.types).toEqual(["embroidery", "dtf", "screenprint"]);
    }
    // Back office marks a start and takes it back (run.markMade edit).
    expect((await tryApi(staff, "setDecorationStarted", { ...line, on: true })).data).toMatchObject({ status: "ok", started: true });
    expect((await queue(api_)).other.ready.find(c => c.orderId === S.a.orderId).started).toBe(true);
    expect((await tryApi(staff, "setDecorationStarted", { ...line, on: false })).data).toMatchObject({ status: "ok", started: false });
    // Changing the types takes settings.global edit: a Manager has it read-only, Back office and Production none.
    for (const ctx of [manager, staff, prod]) {
      const r = await tryApi(ctx, "updateDecorationSettings", { types: ["embroidery"] });
      expect(r.status).toBe(403);
    }
    expect((await tryApi(manager, "getDecorationSettings", {})).data.types).toEqual(["embroidery", "dtf", "screenprint"]);
    // Production reads the types without the costs.
    const pr = (await tryApi(prod, "getDecorationSettings", {})).data;
    expect(pr.types).toEqual(["embroidery", "dtf", "screenprint"]);
    expect(pr.pricing.screenprint.inkColorCents).toBe(150);
    expect(pr.pricing.screenprint).not.toHaveProperty("costCents");
    // A bad line or time is refused plainly.
    const bad = await tryApi(prod, "setDecorationStarted", {});
    expect(bad.status).toBe(400);
    expect(bad.data.message).toBe("orderId and itemId required");
    expect((await tryApi(prod, "makeDecoratedLine", { orderId: S.a.orderId, itemId: 999999999 })).data.message).toBe("Line item not found");
  } finally {
    await Promise.all([viewer, manager, prod, staff].map(c => c.dispose()));
  }
});

test("Screen print switched off: its button is marked while cards remain and goes when they are done; nothing offers it; the shop page drops it", async ({ page, api, as }) => {
  test.setTimeout(150_000);
  await openAdmin(page, "settings");
  await decoBox(page, "screenprint").uncheck();
  await saveGlobal(page);
  expect((await api("getDecorationSettings")).types).toEqual(["embroidery", "dtf"]);
  // The prices stay as typed, for when it is ticked again.
  expect((await api("getDecorationSettings")).pricing.screenprint.inkColorCents).toBe(150);

  // Order A's card is still there, so the button stays, marked.
  await openAdmin(page, "runorder");
  await expect(runFilter(page, "Screen print")).toHaveText(/^Screen print \(switched off\) \(\d+\)$/);
  await runFilter(page, "Screen print").click();
  await expect(cardOf(page, S.a.customer)).toHaveCount(1);
  await expect(cardOf(page, S.a.customer).locator(".ro-chip")).toHaveText("Screen print (switched off)");
  await cardOf(page, S.a.customer).getByRole("button", { name: "Mark made" }).click();
  await confirmDialog(page);
  await expect(toast(page)).toContainText("Order complete.");
  expect((await api("getOrders", { org: S.shop.orgId })).orders.find(o => o.orderId === S.a.orderId).manufacturedAt).toBeTruthy();

  // Nothing of this spec's Screen print work is left. On a fresh install that is all there is, so the button is gone, and
  // whatever was chosen before is not applied; on an install that earlier runs left cards in, it stays, marked, with them.
  const left = (await queue(api)).counts.screenprint;
  await openAdmin(page, "runorder");
  if (left) await expect(runFilter(page, "Screen print")).toHaveText("Screen print (switched off) (" + left + ")");
  else await expect.poll(async () => (await filterNames(page)).join("|")).not.toContain("Screen print");
  expect(await filterNames(page)).toEqual(expect.arrayContaining([expect.stringMatching(/^All \(/), expect.stringMatching(/^Embroidery \(/), expect.stringMatching(/^DTF \(/)]));
  await expect(runFilter(page, "Screen print")).toHaveCount(left ? 1 : 0);
  if (left) await runFilter(page, "All").click();
  else await expect(runFilter(page, "All")).toHaveAttribute("aria-pressed", "true");
  await expect(cardOf(page, S.a.customer)).toHaveCount(0);                         // order A is made
  await expect(cardOf(page, S.c.customer)).toHaveCount(1);                         // the DTF order is still on the page

  // The product form no longer offers it for a new product, but keeps it, marked, on the product that has it.
  await openAdmin(page, "catalog/orgs/" + S.shop.orgId + "/products/new");
  await expect(page.locator("#prodFormDecoration option")).toHaveText(["Worked out from the design / transfers", "Embroidery", "DTF transfer"]);
  await openAdmin(page, "catalog/orgs/" + S.shop.orgId + "/products/" + S.productId + "/edit");
  await expect(page.locator("#prodFormDecoration")).toHaveValue("screenprint");
  await expect(page.locator("#prodFormDecoration option:checked")).toHaveText("Screen print (switched off)");
  // The graphic form: Printed by lists DTF only for a new graphic; the existing one shows its type marked.
  await openAdmin(page, "graphics/" + S.shop.orgId);
  await expect(page.locator("#grBody tr", { hasText: S.graphicName })).toContainText("Screen print (switched off)");
  await page.locator("#grNewBtn").click();
  await expect(page.locator("#gfDecoration option")).toHaveText(["DTF transfer"]);

  // The server refuses a new choice of it, and a type already on a record is kept.
  const newProduct = { org: S.shop.orgId, productId: slug("no").slice(0, 30), type: "shirt", name: uniq("Refused Tee"), pricingMode: "flat", flatPrice: 5, visible: true, images: [], noBlankNeeded: true, noDesignNeeded: true };
  const refused = await api("createProduct", { ...newProduct, decorationType: "screenprint" }, { allowError: true, withStatus: true });
  expect(refused.status).toBe(400);
  expect(refused.data.message).toBe(OFF_MSG);
  const g = await api("saveGraphic", { org: S.shop.orgId, graphic: { name: uniq("Refused Crest"), kind: "transfer", decoration: "screenprint", visible: true } }, { allowError: true, withStatus: true });
  expect(g.status).toBe(400);
  expect(g.data.message).toBe(OFF_MSG);
  const kept = await api("updateProduct", { org: S.shop.orgId, productId: S.productId, type: "shirt", name: S.productName, pricingMode: "flat", flatPrice: 22, visible: true, images: [], noBlankNeeded: true, noDesignNeeded: true, decorationType: "screenprint" }, { allowError: true, withStatus: true });
  expect(kept.status).toBe(200);
  expect((await api("listProducts", { org: S.shop.orgId })).products.find(p => p.productId === S.productId).decorationType).toBe("screenprint");

  // The shop page no longer says "Screen printed" (the made-label follows what is ticked).
  const cust = await as(null);
  await cust.goto(shopUrl(S.shop.subdomain) + "/");
  await expect(cust.getByRole("heading", { level: 1, name: S.shop.name })).toBeVisible();
  const card = cust.locator("main").getByRole("heading", { level: 3, name: S.labelProduct.name, exact: true }).locator("xpath=ancestor::*[.//button[normalize-space()='Add to cart']][1]");
  await expect(card).toBeVisible();
  await expect(card.locator("ul.product-decor")).toHaveCount(0);
  await expect(cust.locator("body")).not.toContainText("Screen printed:");
});
