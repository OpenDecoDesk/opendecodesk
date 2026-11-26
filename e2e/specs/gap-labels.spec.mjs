// Branded labels and Mailing labels on a shop's Orders page (public/admin.js renderBrandedLabels,
// renderMailingLabels — coverage gap: no e2e test drew either sheet's content). The security-policy spec only checks
// that the print pop-ups print and close; here the sheets themselves are read:
//
// - Branded labels (4 to a sheet, filled right to left): one label per order with the shop's name, "by <business>",
//   "scan to reorder", a QR code for the shop's own address, the customer, the order number and every line still
//   active ("<name>, <size>", OSFA for one-size). Paid only and Undelivered only filter the pool; One label per
//   shirt makes a label per sized line, × marking the shirt the label goes on (and the one-size lines on the first);
//   Start at label leaves the first slots blank; Font settings change the sizes and are kept per shop in this browser;
//   Print writes the same sheets into a pop-up.
// - Mailing labels (30 to a sheet): one label per order with a street address — name, street, second line,
//   "City, ST ZIP" — in the selection, paid or not; an order without one (a pickup, or only a phone number) gets no
//   label. Nothing selected: every order of the shop with an address, counted in the note.
//
// The print pop-ups would print and close themselves (printPopupWhenReady_): print() and close() are replaced on the
// pop-up, so the test can read it. The QR codes come from an outside service: answered here with a small PNG.
//
// Every test makes its own shop and orders (Local sales through the owner's API) and only looks at those.
import { test, expect, openAdmin, uniq, pngBytes, ADMIN, apiContext, callApi } from "../fixtures.mjs";
import { makeShop } from "../lib/data.mjs";

// ---- helpers ---------------------------------------------------------------------------------------------
const ordersPage = async (page, shop) => {
  if (page.url().startsWith(ADMIN)) await page.goto("about:blank");
  await openAdmin(page, "orders/" + shop.orgId);
  await expect(page.getByRole("combobox", { name: "Shop" })).toHaveValue(shop.orgId);
};
const select = (page, orderId) => page.getByRole("checkbox", { name: "Select order " + orderId }).check();
// A sized line ("Club Hoodie", "M") is a custom line of the Local sale; the one-size product is the shop's own.
const custom = (name, size, price = 30) => ({ productId: "__custom__", name, size, qty: 1, customUnitPrice: price, type: "shirt" });

// The shop and its orders: every test of this file reads the same five, each picking the ones it needs.
//   hoodie — Avery: paid, a hoodie (M), a tee (L), a cap (one size) and a cancelled patch; shipped to Springfield.
//   cap    — Blake: paid, a cap; a pickup (no address).
//   unpaid — Casey: not paid; shipped to Madison.
//   done   — Drew: paid and delivered; shipped to Austin.
//   phone  — Emery: paid; an address with only a phone number (no street).
async function makeLabelShop(api) {
  const shop = await makeShop(api, { prefix: "labels", products: [{ name: uniq("Club Cap"), price: 15, type: "cap" }] });
  const cap = { productId: shop.products[0].productId, qty: 1 };
  const sale = async (customer, items, extra = {}) => {
    const r = await api("createLocalSale", { org: shop.orgId, customerName: customer, paymentMethod: "Cash", items, ...extra });
    return r.orderId;
  };
  const people = { hoodie: uniq("Avery Shipper"), cap: uniq("Blake Pickup"), unpaid: uniq("Casey Unpaid"), done: uniq("Drew Delivered"), phone: uniq("Emery Phone") };
  const o = {};
  o.hoodie = await sale(people.hoodie, [custom("Club Hoodie", "M"), custom("Club Tee", "L", 20), cap, custom("Spare Patch", "", 5)], { paid: true,
    shippingAddress: { name: "Avery S. Shipper", line1: "12 Elm St", line2: "Apt 4", city: "Springfield", state: "IL", zip: "62701" } });
  o.cap = await sale(people.cap, [cap], { paid: true });
  o.unpaid = await sale(people.unpaid, [custom("Club Tee", "S", 20)], { shippingAddress: { line1: "34 Oak Ave", city: "Madison", state: "WI", zip: "53703" } });
  o.done = await sale(people.done, [cap], { paid: true, delivered: true, shippingAddress: { name: "Drew D.", line1: "9 Pine Rd", city: "Austin", state: "TX", zip: "78701" } });
  o.phone = await sale(people.phone, [cap], { paid: true, shippingAddress: { phone: "555-0100" } });
  // The hoodie order's patch is cancelled: it's on no label.
  const { orders } = await api("getOrders", { org: shop.orgId });
  const patch = orders.find(x => x.orderId === o.hoodie).items.find(it => it.name === "Spare Patch");
  await api("cancelLineItem", { org: shop.orgId, sheetRow: patch.sheetRow, reason: "Out of stock" });
  return { shop, o, people, capName: shop.products[0].name };
}

// print() and close() of the next pop-up are replaced: printing is counted on the page, and the pop-up stays open.
const holdPopups = (page) => page.evaluate(() => {
  const open = window.open;
  window.__printed = 0;
  window.open = function (...args) {
    const w = open.apply(window, args);
    if (w) { w.print = () => { window.__printed++; }; w.close = () => {}; }
    return w;
  };
});
// The QR codes' outside service, answered here (the page's labels and the pop-up's).
const answerQr = (context) => context.route("https://api.qrserver.com/**", (route) => route.fulfill({ status: 200, contentType: "image/png", body: pngBytes(20, 20, [0, 0, 0]) }));

let D;
test.beforeAll(async ({}, testInfo) => {
  // The owner's API (the `api` fixture is per test): a context of its own, closed again.
  const ctx = await apiContext("owner", testInfo.workerIndex);
  D = await makeLabelShop((action, body, opts) => callApi(ctx, action, body, opts));
  await ctx.dispose();
});

// ---- Branded labels --------------------------------------------------------------------------------------
test("Branded labels for two selected orders: shop, business, QR code, customer, order number and active lines", async ({ page, context }) => {
  await answerQr(context);
  await ordersPage(page, D.shop);
  await select(page, D.o.hoodie);
  await select(page, D.o.cap);
  await page.getByRole("button", { name: "Branded labels" }).click();
  const area = page.locator("#blblArea");
  await expect(page.locator(".lbl-controls")).toContainText("2 selected orders");
  // One sheet of four: the two orders and two blank slots.
  await expect(area.locator(".bl-sheet")).toHaveCount(1);
  await expect(area.locator(".bl")).toHaveCount(4);
  const labels = area.locator(".bl:has(.bl-customer)");
  await expect(labels).toHaveCount(2);

  const biz = await page.evaluate(() => bizName_());
  const reorder = "https://" + D.shop.subdomain + ".localhost";
  const hoodie = labels.filter({ hasText: D.people.hoodie });
  await expect(hoodie.locator(".bl-orgname")).toHaveText(D.shop.name);
  await expect(hoodie.locator(".bl-byline")).toHaveText("by " + biz);
  await expect(hoodie.locator(".bl-reorder")).toHaveText("scan to reorder");
  await expect(hoodie.locator(".bl-customer")).toHaveText(D.people.hoodie);
  await expect(hoodie.locator(".bl-orderid")).toHaveText(D.o.hoodie);
  // Sized lines with their size, the cap as OSFA; the cancelled patch isn't there.
  await expect(hoodie.locator(".bl-items li")).toHaveText(["Club Hoodie, M", "Club Tee, L", D.capName + ", OSFA"]);
  await expect(hoodie.locator(".bl-items li.x")).toHaveCount(0);
  const qr = hoodie.getByRole("img", { name: "QR code — " + reorder });
  await expect(qr).toHaveAttribute("src", "https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=" + encodeURIComponent(reorder));

  const cap = labels.filter({ hasText: D.people.cap });
  await expect(cap.locator(".bl-orderid")).toHaveText(D.o.cap);
  await expect(cap.locator(".bl-items li")).toHaveText([D.capName + ", OSFA"]);

  // Back returns to the list, the two orders still there.
  await page.locator(".lbl-controls").getByRole("button", { name: "← Back" }).click();
  await expect(page.getByRole("checkbox", { name: "Select order " + D.o.hoodie })).toBeVisible();
});

test("Branded labels: Paid only, Undelivered only, One label per shirt and Start at label change what's drawn", async ({ page, context }) => {
  await answerQr(context);
  await ordersPage(page, D.shop);
  for (const id of [D.o.hoodie, D.o.cap, D.o.unpaid, D.o.done]) await select(page, id);
  await page.getByRole("button", { name: "Branded labels" }).click();
  const area = page.locator("#blblArea");
  const customers = area.locator(".bl-customer");
  await expect(page.locator(".lbl-controls")).toContainText("4 selected orders");
  // Paid and undelivered (the defaults): the hoodie and cap orders only.
  await expect(customers).toHaveCount(2);
  await expect(area).not.toContainText(D.people.unpaid);
  await expect(area).not.toContainText(D.people.done);

  await page.getByLabel("Paid only").uncheck();
  await expect(customers).toHaveCount(3);
  await expect(area).toContainText(D.people.unpaid);
  await page.getByLabel("Undelivered only").uncheck();
  await expect(customers).toHaveCount(4);
  await expect(area).toContainText(D.people.done);
  // Four labels fill one sheet exactly; back to the defaults.
  await expect(area.locator(".bl-sheet")).toHaveCount(1);
  await page.getByLabel("Paid only").check();
  await page.getByLabel("Undelivered only").check();
  await expect(customers).toHaveCount(2);

  // One label per shirt: the hoodie order gets one per sized line (× on that shirt, the cap × on the first only);
  // the cap order (no shirts) one label, every line ×.
  await page.getByLabel("One label per shirt").check();
  await expect(customers).toHaveCount(3);
  const hoodieLabels = area.locator(".bl", { hasText: D.people.hoodie });
  await expect(hoodieLabels).toHaveCount(2);
  const lines = (label) => label.locator(".bl-items li");
  const marked = (label) => label.locator(".bl-items li.x");
  // DOM order within a sheet is right to left per row; find each label by its marked shirt.
  const forHoodie = hoodieLabels.filter({ has: page.locator("li.x", { hasText: "Club Hoodie, M" }) });
  const forTee = hoodieLabels.filter({ has: page.locator("li.x", { hasText: "Club Tee, L" }) });
  await expect(lines(forHoodie)).toHaveText(["Club Hoodie, M", "Club Tee, L", D.capName + ", OSFA"]);
  await expect(marked(forHoodie)).toHaveText(["Club Hoodie, M", D.capName + ", OSFA"]);
  await expect(lines(forTee)).toHaveText(["Club Hoodie, M", "Club Tee, L"]);
  await expect(marked(forTee)).toHaveText(["Club Tee, L"]);
  const capLabel = area.locator(".bl", { hasText: D.people.cap });
  await expect(marked(capLabel)).toHaveText([D.capName + ", OSFA"]);
  await page.getByLabel("One label per shirt").uncheck();
  await expect(customers).toHaveCount(2);

  // Start at label 2: slot 1 (top right, the second in its row's markup) stays blank, the first label goes top left.
  await page.getByLabel("Start at label:").fill("2");
  const topRow = area.locator(".bl-sheet").first().locator(".bl-pair").first().locator(".bl");
  await expect(topRow.nth(1)).toBeEmpty();
  await expect(topRow.nth(0).locator(".bl-customer")).toHaveCount(1);
  // Start at 4 with two labels: the second spills onto a new sheet.
  await page.getByLabel("Start at label:").fill("4");
  await expect(area.locator(".bl-sheet")).toHaveCount(2);
  await expect(customers).toHaveCount(2);
});

test("Branded labels with nothing selected take every paid, undelivered order of the shop", async ({ page, context }) => {
  await answerQr(context);
  await ordersPage(page, D.shop);
  await page.getByRole("button", { name: "Branded labels" }).click();
  const area = page.locator("#blblArea");
  await expect(page.locator(".lbl-controls")).not.toContainText("selected order");
  // hoodie, cap and the phone-only order (paid, undelivered); not the unpaid or the delivered one.
  await expect(area.locator(".bl-customer")).toHaveCount(3);
  expect((await area.locator(".bl-customer").allTextContents()).sort()).toEqual([D.people.hoodie, D.people.cap, D.people.phone].sort());
});

test("Font settings change the branded labels' sizes, are kept for the shop, and print in the pop-up", async ({ page, context }) => {
  await answerQr(context);
  await ordersPage(page, D.shop);
  await select(page, D.o.hoodie);
  await page.getByRole("button", { name: "Branded labels" }).click();
  const fontCss = () => page.evaluate(() => document.getElementById("blbl-font-style").textContent);
  await expect.poll(fontCss).toContain(".bl-orgname{font-size:13pt;font-weight:700;}");

  // Cancel changes nothing.
  await page.getByRole("button", { name: "Font settings" }).click();
  let dlg = page.getByRole("dialog", { name: "Label font settings" });
  await expect(dlg.locator("tbody tr")).toHaveCount(6);
  await dlg.locator("#lfs_header_sz").fill("20");
  await dlg.getByRole("button", { name: "Cancel" }).click();
  await expect(dlg).toHaveCount(0);
  expect(await fontCss()).toContain(".bl-orgname{font-size:13pt;font-weight:700;}");

  // Header 20pt, not bold; customer name 16pt: applied to the sheet and saved for this shop.
  await page.getByRole("button", { name: "Font settings" }).click();
  dlg = page.getByRole("dialog", { name: "Label font settings" });
  await expect(dlg.locator("#lfs_header_sz")).toHaveValue("13");
  await dlg.locator("#lfs_header_sz").fill("20");
  await dlg.locator("#lfs_header_b").uncheck();
  await dlg.locator("#lfs_customer_sz").fill("16");
  await dlg.getByRole("button", { name: "Apply" }).click();
  await expect(dlg).toHaveCount(0);
  await expect.poll(fontCss).toContain(".bl-orgname{font-size:20pt;font-weight:400;}");
  expect(await fontCss()).toContain(".bl-customer{font-size:16pt;font-weight:700;}");
  expect(await page.evaluate((k) => JSON.parse(localStorage.getItem(k)).header, "odd_label_fonts_" + D.shop.orgId)).toEqual({ size: 20, bold: false });
  await expect(page.locator("#blblArea .bl-customer")).toHaveText([D.people.hoodie]);

  // Print: the pop-up has the same label, on the 4.25 × 10 inch mini-sheet, with the chosen sizes; it prints once.
  await holdPopups(page);
  const popupWaiting = page.waitForEvent("popup");
  await page.locator(".lbl-controls").getByRole("button", { name: "Print" }).click();
  const popup = await popupWaiting;
  await expect(popup.locator(".bl-customer")).toHaveText([D.people.hoodie]);
  await expect(popup.locator(".bl-orderid")).toHaveText([D.o.hoodie]);
  await expect(popup.locator(".bl-items li")).toHaveText(["Club Hoodie, M", "Club Tee, L", D.capName + ", OSFA"]);
  await expect(popup.locator(".bl")).toHaveCount(4);
  const css = await popup.evaluate(() => document.querySelector("style").textContent);
  expect(css).toContain("@page{size:4.25in 10in;margin:0;}");
  expect(css).toMatch(/\.bl-orgname\{[^}]*font-size:20pt;font-weight:400;/);
  expect(css).toMatch(/\.bl-customer\{[^}]*font-size:16pt;font-weight:700;/);
  // Printing waits for the QR code. A new pop-up's first requests can stall under Playwright's request interception
  // (see security-policy.spec), so a picture still loading is given a data: picture: then it prints, once.
  await page.waitForTimeout(500);
  if (await popup.evaluate(() => [...document.images].filter((i) => !i.complete).length)) {
    expect(await page.evaluate(() => window.__printed), "not printed while the QR code loads").toBe(0);
    await popup.evaluate((src) => { for (const i of document.images) if (!i.complete) i.src = src; }, "data:image/png;base64," + pngBytes(4, 4, [0, 0, 0]).toString("base64"));
  }
  await expect.poll(() => page.evaluate(() => window.__printed)).toBe(1);
  await popup.close();

  // Opened again (a new page load): the saved sizes are used; Reset in the window brings back the defaults.
  await ordersPage(page, D.shop);
  await page.getByRole("button", { name: "Branded labels" }).click();
  await expect.poll(fontCss).toContain(".bl-orgname{font-size:20pt;font-weight:400;}");
  await page.getByRole("button", { name: "Font settings" }).click();
  dlg = page.getByRole("dialog", { name: "Label font settings" });
  await expect(dlg.locator("#lfs_header_sz")).toHaveValue("20");
  await expect(dlg.locator("#lfs_header_b")).not.toBeChecked();
  await dlg.getByRole("button", { name: "Reset" }).click();
  await expect(dlg.locator("#lfs_header_sz")).toHaveValue("13");
  await expect(dlg.locator("#lfs_header_b")).toBeChecked();
  await dlg.getByRole("button", { name: "Apply" }).click();
  await expect.poll(fontCss).toContain(".bl-orgname{font-size:13pt;font-weight:700;}");
  expect(await page.evaluate((k) => JSON.parse(localStorage.getItem(k)).header, "odd_label_fonts_" + D.shop.orgId)).toEqual({ size: 13, bold: true });
});

// ---- Mailing labels --------------------------------------------------------------------------------------
test("Mailing labels for selected orders: one per street address, paid or not; a pickup and a phone-only address get none", async ({ page }) => {
  await ordersPage(page, D.shop);
  for (const id of [D.o.hoodie, D.o.cap, D.o.unpaid, D.o.phone]) await select(page, id);
  await page.getByRole("button", { name: "Mailing labels" }).click();
  await expect(page.locator(".lbl-controls")).toContainText("4 selected orders");
  const area = page.locator("#labelArea");
  // One sheet of 30; two of them addressed.
  await expect(area.locator(".label-sheet")).toHaveCount(1);
  await expect(area.locator(".packing-label")).toHaveCount(30);
  const labels = area.locator(".packing-label:has(.mail-label-name)");
  await expect(labels).toHaveCount(2);
  // The address's own name when it has one (else the customer's), the street, the second line, City, ST ZIP.
  const avery = labels.filter({ hasText: "Avery S. Shipper" });
  await expect(avery.locator(".mail-label-name")).toHaveText("Avery S. Shipper");
  await expect(avery.locator(".mail-label-line")).toHaveText(["12 Elm St", "Apt 4", "Springfield, IL 62701"]);
  const casey = labels.filter({ hasText: D.people.unpaid });
  await expect(casey.locator(".mail-label-name")).toHaveText(D.people.unpaid);
  await expect(casey.locator(".mail-label-line")).toHaveText(["34 Oak Ave", "Madison, WI 53703"]);
  // The pickup and the phone-only address: no label (and no order numbers on mailing labels at all).
  await expect(area).not.toContainText(D.people.cap);
  await expect(area).not.toContainText(D.people.phone);
  await expect(area).not.toContainText("555-0100");
  await expect(area).not.toContainText(D.o.hoodie);

  // Start at label 3: two blank slots first, still one sheet.
  await page.getByLabel("Start at label:").fill("3");
  const slots = area.locator(".packing-label");
  await expect(slots.nth(0)).toBeEmpty();
  await expect(slots.nth(1)).toBeEmpty();
  await expect(slots.nth(2).locator(".mail-label-name")).toHaveCount(1);
  await expect(slots).toHaveCount(30);
  // Start at 30 with two labels: a second sheet's worth of slots.
  await page.getByLabel("Start at label:").fill("30");
  await expect(slots).toHaveCount(60);
  await expect(labels).toHaveCount(2);
  await page.getByLabel("Start at label:").fill("1");

  // Print: the same two labels, on a letter sheet; printed once.
  await holdPopups(page);
  const popupWaiting = page.waitForEvent("popup");
  await page.locator(".lbl-controls").getByRole("button", { name: "Print" }).click();
  const popup = await popupWaiting;
  await expect(popup.locator(".mail-label-name")).toHaveText(await area.locator(".mail-label-name").allTextContents());
  await expect(popup.locator(".mail-label-line")).toHaveText(await area.locator(".mail-label-line").allTextContents());
  await expect(popup.locator(".packing-label")).toHaveCount(30);
  expect(await popup.evaluate(() => document.querySelector("style").textContent)).toContain("@page{size:letter;margin:0;}");
  await expect.poll(() => page.evaluate(() => window.__printed)).toBe(1);
  await popup.close();
});

test("Mailing labels with nothing selected: every order of the shop with a street address, counted", async ({ page }) => {
  await ordersPage(page, D.shop);
  await page.getByRole("button", { name: "Mailing labels" }).click();
  // The hoodie, unpaid and delivered orders have a street; the phone-only address and the pickup don't.
  await expect(page.locator(".lbl-controls")).toContainText("3 shipping order(s)");
  const names = page.locator("#labelArea .mail-label-name");
  await expect(names).toHaveCount(3);
  expect((await names.allTextContents()).sort()).toEqual(["Avery S. Shipper", D.people.unpaid, "Drew D."].sort());
  await expect(page.locator("#labelArea")).toContainText("Austin, TX 78701");
});

test("a shop whose orders have no street address has no Mailing labels button", async ({ page, api }) => {
  const shop = await makeShop(api, { prefix: "nomail", products: [{ name: uniq("Pickup Cap"), price: 12, type: "cap" }] });
  await api("createLocalSale", { org: shop.orgId, customerName: uniq("Frankie Pickup"), paymentMethod: "Cash", paid: true,
    items: [{ productId: shop.products[0].productId, qty: 1 }] });
  await ordersPage(page, shop);
  await expect(page.getByRole("button", { name: "Branded labels" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Mailing labels" })).toHaveCount(0);
});
