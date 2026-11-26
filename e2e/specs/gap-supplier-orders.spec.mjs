// Blanks to order → Order from <supplier>…: the window that builds an order to a supplier for blanks through its web
// service (coverage gap: admin.js showSupplierOrder_ and supplierOrderCall_ — never opened by an end-to-end test).
//
// The local install can't reach any supplier: the connections here point at supplier.example.test, which doesn't
// exist. So these tests check what a user can do and see without one: the window's lines (blank, color, size, the
// restock quantity, our price and cost), the ship method, the warning that it's a real order or the supplier's TEST
// service, free shipping's progress, changing a quantity, unticking lines, switching to the test service (a TEST-
// PO number), and the app's own answer when the supplier can't be asked — Place order stays off and nothing is
// saved. Then the way the screen offers to order by hand instead: Get me to free shipping → Continue to order (the
// same window again) and Mark as ordered…, which takes the restock off Blanks to order until it's received; the
// blanks received, the stock is there and the hand order says received.
//
// Vendor connections are install-wide: the two made here have their own company code and vendor name, and are
// deleted after the last test (their blank and vendor too). Nothing here reads any other spec's rows.
import { test, expect, openAdmin, toast, uniq, slug, apiContext, callApi } from "../fixtures.mjs";

test.describe.configure({ mode: "serial" });

const SUPPLIER = "https://supplier.example.test";
// A made-up login: only ever stored encrypted on the test install.
const LOGIN = { id: "e2e-supplier-user", password: "e2e-supplier-pass-not-real" };
const endpoints = (environment) => ({ environment, product: SUPPLIER + "/ps/product", ppc: SUPPLIER + "/ps/ppc", media: "", inv: SUPPLIER + "/ps/inv",
  po: SUPPLIER + "/ps/po", osn: "" });

const D = {};

test.beforeAll(async () => {
  const ctx = await apiContext("owner");
  const api = (action, body, opts) => callApi(ctx, action, body, opts);
  try {
    D.vendor = uniq("Test Supply Co");
    D.code = slug("E2EPO").toUpperCase();
    // Free shipping from $200.
    D.vendorId = (await api("saveVendor", { vendor: { name: D.vendor, forBlanks: true, over: 200 } })).vendor.id;
    D.prodId = (await api("saveVendorConnection", { companyCode: D.code, name: D.vendor, endpoints: endpoints("production"), credentials: LOGIN })).id;
    D.testName = D.vendor + " Test";
    D.testId = (await api("saveVendorConnection", { companyCode: D.code, name: D.testName, endpoints: endpoints("test"), credentials: LOGIN })).id;
    // A blank from that vendor, style E2E-…: Navy M (none on hand, keep 6) and Navy L (1 on hand, keep 4) — a restock
    // of 6 M and 3 L on Blanks to order.
    D.blankName = uniq("Sample Supplier Tee");
    D.sku = "E2E-" + slug("st").slice(-6).toUpperCase();
    D.blankId = (await api("createBlank", { name: D.blankName, brand: "Test Blank Co", sku: D.sku, vendor: D.vendor, productType: "Tee",
      colors: [{ color: "Navy", sizes: [
        { size: "M", quantity: 0, purchasePrice: 3.5, vendorPrice: 3.5, reorderPoint: 6 },
        { size: "L", quantity: 1, purchasePrice: 4, vendorPrice: 4, reorderPoint: 4 },
      ] }] })).id;
    await api("linkVendorConnectionBlanks", { id: D.prodId, blankIds: [D.blankId] });
  } finally { await ctx.dispose(); }
});

test.afterAll(async () => {
  const ctx = await apiContext("owner");
  const api = (action, body) => callApi(ctx, action, body, { allowError: true });
  try {
    for (const id of [D.prodId, D.testId]) if (id) await api("deleteVendorConnection", { id });
    if (D.blankId) await api("deleteBlank", { id: D.blankId });
    if (D.vendorId) await api("deleteVendor", { id: D.vendorId });
  } finally { await ctx.dispose(); }
});

// Blanks to order, and this vendor's block on it.
async function openBlocks(page) {
  await openAdmin(page, "blankorder");
  await expect(page.locator("#btoBody")).not.toContainText("Loading");
  return page.locator(".bto-supplier").filter({ has: page.getByRole("heading", { name: D.vendor, exact: true }) });
}
// The answer to the window's next "Check stock & prices" (previewSupplierOrder): { request, answer }.
const nextCheck = (page) => page.waitForResponse((r) => r.url().endsWith("/api/orders") && /"action":"previewSupplierOrder"/.test(r.request().postData() || ""))
  .then(async (r) => ({ request: JSON.parse(r.request().postData()), answer: await r.json() }));

const orderWindow = (page) => page.getByRole("dialog", { name: "Order from " + D.vendor });
const lineOf = (dlg, size) => dlg.locator("#soLines tbody tr").filter({ has: dlg.page().getByRole("cell", { name: size, exact: true }) });

test("Order from the supplier opens its order window with the restock lines; the supplier can't be reached, so nothing can be placed", async ({ page, api }) => {
  const block = await openBlocks(page);
  await expect(block).toHaveCount(1);
  await expect(block).toContainText("Free shipping");
  const checked = nextCheck(page);
  await block.getByRole("button", { name: "Order from " + D.vendor + "…" }).click();
  const dlg = orderWindow(page);
  await expect(dlg).toBeVisible();

  // The lines: the blank, its style #, color, size, the restock to order, our price and cost.
  const m = lineOf(dlg, "M"), l = lineOf(dlg, "L");
  await expect(m).toContainText(D.blankName);
  await expect(m).toContainText(D.sku);
  await expect(m).toContainText("Navy");
  await expect(m.getByRole("spinbutton")).toHaveValue("6");
  await expect(l.getByRole("spinbutton")).toHaveValue("3");
  await expect(m).toContainText("$3.50");
  await expect(m).toContainText("$21.00");
  await expect(l).toContainText("$12.00");
  // Where it goes: the production connection first, then the supplier's test service; a real order, said so.
  await expect(dlg.getByLabel("Send to").locator("option")).toHaveText([D.vendor, D.testName + " (TEST service)"]);
  await expect(dlg.getByLabel("Send to")).toHaveValue(String(D.prodId));
  await expect(dlg).toContainText(`This places a real order, charged to the payment method ${D.vendor} has on file.`);
  await expect(dlg.getByLabel("Ship method")).toHaveValue("0");
  await expect(dlg.getByLabel("Ship method").locator("option")).toHaveText(["UPS Ground"]);
  // Free shipping at $200: 6 × $3.50 + 3 × $4.00 = $33.00 of it.
  await expect(dlg.locator("#soFree")).toContainText("Free shipping at $200: $167.00 to go.");
  await expect(dlg.getByRole("button", { name: "Get me to free shipping" })).toBeVisible();

  // The window asks the supplier as it opens: both lines, at their quantities, from the production connection.
  const { request, answer } = await checked;
  expect(request).toMatchObject({ connectionId: D.prodId, lines: [
    { blankId: D.blankId, color: "Navy", size: "M", qty: 6, restockQty: 6 },
    { blankId: D.blankId, color: "Navy", size: "L", qty: 3, restockQty: 3 },
  ] });
  // The supplier couldn't be asked: each line says why, the window says to try again, and Place order stays off.
  expect(answer.status).toBe("ok");
  expect(answer.lookupError).toBeTruthy();
  expect(answer.lines.map((x) => x.problemKind)).toEqual(["lookup", "lookup"]);
  await expect(dlg.locator("#soMsg")).toContainText(`${D.vendor} couldn't be asked: ${answer.lookupError} Check stock & prices again in a moment.`);
  await expect(m.locator(".so-problem")).toHaveText(answer.lookupError);
  await expect(dlg.locator("#soTotal")).toHaveText("2 lines · $33.00 at our prices");
  await expect(dlg.getByRole("button", { name: /^Place order/ })).toBeDisabled();
  await expect(dlg.getByRole("button", { name: "Place order — $33.00" })).toBeVisible();
  // A PO number is filled in for it (the business's prefix, then a number).
  await expect(dlg.getByLabel("PO number")).toHaveValue(answer.poNumber);
  expect(answer.poNumber).toMatch(/^[A-Za-z0-9-]{1,28}$/);
  expect(answer.poNumber.startsWith("TEST")).toBe(false);

  // Asked again: the same answer.
  const again = nextCheck(page);
  await dlg.getByRole("button", { name: "Check stock & prices" }).click();
  expect((await again).answer.lookupError).toBeTruthy();
  await expect(dlg.getByRole("button", { name: /^Place order/ })).toBeDisabled();
  await dlg.getByRole("button", { name: "Close" }).click();
  await expect(dlg).toHaveCount(0);

  // Placing it anyway (the request the window would send) is refused, and nothing is saved.
  const placed = await api("placeSupplierOrder", { connectionId: D.prodId, lines: request.lines, itemIds: [], carrier: "UPS", service: "GROUND", poNumber: slug("E2EPO").toUpperCase() },
    { allowError: true, withStatus: true });
  expect(placed.data.status).toBe("error");
  expect([400, 409]).toContain(placed.status);
  const { orders } = await api("listSupplierOrders");
  expect(orders.filter((o) => o.vendor === D.vendor || o.vendor === D.testName)).toEqual([]);
});

test("in the order window a quantity changes, lines untick, and the supplier's test service gets a TEST PO number", async ({ page }) => {
  const block = await openBlocks(page);
  const first = nextCheck(page);
  await block.getByRole("button", { name: "Order from " + D.vendor + "…" }).click();
  const dlg = orderWindow(page);
  await first;
  const m = lineOf(dlg, "M"), l = lineOf(dlg, "L");
  const place = dlg.getByRole("button", { name: /^Place order/ });
  const msg = dlg.locator("#soMsg"), total = dlg.locator("#soTotal");

  // 10 of M: the check is out of date, and the totals follow the quantity.
  await m.getByRole("spinbutton").fill("10");
  await expect(total).toHaveText("2 lines · 13 pieces");
  await expect(msg).toHaveText("Changed — check stock & prices to place the order.");
  await expect(place).toHaveText("Place order");
  await expect(place).toBeDisabled();
  await expect(dlg.locator("#soFree")).toContainText("$153.00 to go");   // 10 × $3.50 + $12.00 = $47.00
  // Checked again: the supplier is asked about 10, and the line's cost and the total follow.
  const recheck = nextCheck(page);
  await dlg.getByRole("button", { name: "Check stock & prices" }).click();
  expect((await recheck).request.lines.find((x) => x.size === "M").qty).toBe(10);
  await expect(m).toContainText("$35.00");
  await expect(total).toHaveText("2 lines · $47.00 at our prices");
  await expect(place).toBeDisabled();

  // Nothing ticked: nothing to check.
  await m.getByRole("checkbox").uncheck();
  await l.getByRole("checkbox").uncheck();
  await expect(total).toHaveText("Nothing ticked");
  await expect(m.getByRole("spinbutton")).toBeDisabled();
  let asked = 0;
  const count = (r) => { if (/"action":"previewSupplierOrder"/.test(r.postData() || "")) asked++; };
  page.on("request", count);
  await dlg.getByRole("button", { name: "Check stock & prices" }).click();
  await expect(toast(page)).toContainText("Tick at least one line.");
  expect(asked).toBe(0);
  page.off("request", count);

  // L alone, sent to the supplier's TEST service: a fresh TEST- PO number, the warning, and only L asked about.
  // (L was already checked at this quantity: ticking it back needs no new check.)
  await l.getByRole("checkbox").check();
  await expect(total).toHaveText("1 line · $12.00 at our prices");
  const viaTest = nextCheck(page);
  await dlg.getByLabel("Send to").selectOption(String(D.testId));
  const { request, answer } = await viaTest;
  expect(request).toMatchObject({ connectionId: D.testId, lines: [{ blankId: D.blankId, color: "Navy", size: "L", qty: 3 }] });
  expect(request.lines).toHaveLength(1);
  expect(answer.poNumber).toMatch(/^TEST/);
  await expect(dlg.getByLabel("PO number")).toHaveValue(answer.poNumber);
  await expect(dlg).toContainText(`The supplier's TEST service — some suppliers still process these as real orders. Confirm with ${D.testName} before using it.`);
  await expect(msg).toContainText(`${D.testName} couldn't be asked:`);
  await expect(total).toHaveText("1 line · $12.00 at our prices");
  await expect(place).toBeDisabled();
  await dlg.getByRole("button", { name: "Close" }).click();
  await expect(dlg).toHaveCount(0);
});

test("ordered by hand instead: Get me to free shipping leads back to the order window, and Mark as ordered… holds the restock until the blanks are received", async ({ page, api }) => {
  let block = await openBlocks(page);
  const first = nextCheck(page);
  await block.getByRole("button", { name: "Order from " + D.vendor + "…" }).click();
  await first;
  // The order window's Get me to free shipping: the lines carry over.
  await orderWindow(page).getByRole("button", { name: "Get me to free shipping" }).click();
  await expect(orderWindow(page)).toHaveCount(0);
  let fs = page.getByRole("dialog", { name: "Get me to free shipping — " + D.vendor });
  await expect(fs).toBeVisible();
  await expect(fs.locator("tr[data-fs-line]")).toHaveCount(2);
  await expect(fs.locator("#fsTally")).toContainText("$33.00 of $200");
  // Continue to order: the same order window, with those lines.
  const back = nextCheck(page);
  await fs.getByRole("button", { name: "Continue to order" }).click();
  const dlg = orderWindow(page);
  await expect(dlg).toBeVisible();
  const { request } = await back;
  expect(request.lines.map((x) => [x.size, x.qty])).toEqual([["M", 6], ["L", 3]]);
  await expect(lineOf(dlg, "M").getByRole("spinbutton")).toHaveValue("6");
  await expect(dlg.getByRole("button", { name: /^Place order/ })).toBeDisabled();
  await dlg.getByRole("button", { name: "Close" }).click();

  // The supplier can't be reached: ordered on its site instead, and recorded here.
  block = await openBlocks(page);
  await block.getByRole("button", { name: "Get me to free shipping" }).first().click();
  fs = page.getByRole("dialog", { name: "Get me to free shipping — " + D.vendor });
  await expect(fs.locator("tr[data-fs-line]")).toHaveCount(2);
  await fs.getByRole("button", { name: "Mark as ordered…" }).click();
  const ask = page.getByRole("dialog").last();
  await ask.getByLabel("Vendor order # (optional)").fill("WEB-1234");
  await ask.getByRole("button", { name: "Record as placed" }).click();
  await expect(toast(page)).toContainText(`Recorded — 9 pieces of restock on order from ${D.vendor}.`);
  await expect(fs).toHaveCount(0);
  // The restock is on its way: off the list, and listed as ordered by hand.
  await expect(page.locator(".bto-supplier").filter({ has: page.getByRole("heading", { name: D.vendor, exact: true }) })).toHaveCount(0);
  const handRow = page.locator("#btoRestockOrders tr", { hasText: D.vendor });
  await expect(handRow).toContainText("WEB-1234");
  await expect(handRow).toContainText("2 lines, 9 pieces");
  await expect(handRow).not.toContainText("received");

  // The box arrives (Blanks → Receive order's request): the stock is there and the hand order says received.
  const today = new Date().toISOString().slice(0, 10);
  await api("receiveBlankOrder", { groups: [{ blankId: D.blankId, lines: [{ color: "Navy", size: "M", qty: 6, total: 21 }, { color: "Navy", size: "L", qty: 3, total: 12 }] }],
    vendor: D.vendor, vendorRef: "WEB-1234", receivedAt: today, paidPersonally: true });
  const blank = (await api("getBlanks")).blanks.find((b) => b.id === D.blankId);
  const qty = Object.fromEntries(blank.colors[0].sizes.map((z) => [z.size, z.quantity]));
  expect(qty).toEqual({ M: 6, L: 4 });
  await openBlocks(page);
  await expect(page.locator("#btoRestockOrders tr", { hasText: D.vendor })).toContainText("2 lines, 9 pieces · received");
  await expect(page.locator(".bto-supplier").filter({ has: page.getByRole("heading", { name: D.vendor, exact: true }) })).toHaveCount(0);
});
