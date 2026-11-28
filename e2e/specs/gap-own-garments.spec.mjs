// Customer-supplied garments (migrations/0121) end to end, in a real browser:
//   - Global settings → Features → Customer-supplied garments starts OFF; the owner ticks it, changes the waiver line
//     printed on the check-in slip, and saves (audited, back as saved on a reload);
//   - a Local sale with a "Customer's own garment" line (a DTF product linked to a blank with stock): the line is
//     customer-owned, needs no blank (not on Blanks to order, while an ordinary sale of the same product is), the Run
//     order's backlog and DTF card say it waits on the customer's garments, and Mark manufactured is refused;
//   - Check in garments… on the Orders page: the window's own checks (size, twice, at least one, counts, a short count
//     or a condition other than Good needs a note), the save, the line "in", the card ready; the print slip with and
//     without the waiver (and with none set); Undo check-in puts it back to waiting; checked in again, Mark made on the
//     Run order makes it with no blank stock change and no blank movement;
//   - a quote line with the tick converts to a customer-owned order line;
//   - Back office checks garments in but can't undo; Production can't check in (the server's answers);
//   - switched off again on the page: the ticks are gone (Local sale, a quote's Add a product, Edit items) and the
//     server refuses a customer-owned line on a sale, Edit items and a quote, and every check-in action.
//
// It changes an install-wide setting (the Customer-supplied garments switch and its waiver), so it is in ALONE in
// playwright.config.mjs and puts both back as found (the switch starts off). Every test makes its own shop and data.
import { test, expect, ADMIN, openAdmin, toast, uniq, slug, confirmDialog, callApi, apiContext, waitIdle } from "../fixtures.mjs";
import { makeShop } from "../lib/data.mjs";
import crypto from "node:crypto";

test.describe.configure({ mode: "serial" });

const OFF_LINE = "Customer-supplied garments are switched off in Global settings.";
const OFF_FEATURE = "Customer-supplied garments is turned off. Turn it on under Settings → Global settings → Features.";
const NO_ROLE = "Your role can't do this. Ask an admin.";
const DEFAULT_WAIVER = "Customer's garments are decorated at the customer's risk; we're not responsible for garments damaged in normal production.";
const WAIVER = "Example Club garments are decorated at the owner's risk; we replace nothing damaged in normal production.";
const NEED_NOTE = "Say what's different (a note) when the count or condition isn't as expected.";
const WAITING = "Waiting on the customer's garments";

let before = null;     // the install's switch and waiver as found
const S = {};          // what the tests share

const requestId = () => "e2e" + crypto.randomBytes(8).toString("hex");
const actionOf = (req) => { try { return JSON.parse(req.postData() || "{}").action; } catch (e) { return ""; } };
const requestOf = (page, action) => page.waitForRequest(r => r.url().endsWith("/api/orders") && actionOf(r) === action);
const tryApi = (ctx, action, body) => callApi(ctx, action, body, { allowError: true, withStatus: true });
const orderOf = async (api, orgId, orderId) => (await api("getOrders", { org: orgId })).orders.find(o => o.orderId === orderId);
const auditOf = async (api, action) => (await api("getAuditLog", { filter: action, limit: 200 })).entries || [];
const itemIdOf = (it) => it.sheetRow != null ? it.sheetRow : it.id;
const stockOf = async (api, blankId) => {
  const b = (await api("getBlanks")).blanks.find(x => x.id === blankId);
  return Object.fromEntries(b.colors[0].sizes.map(z => [z.size, z.quantity]));
};

const ordersPage = async (page, orgId) => {
  if (page.url() === ADMIN + "/#orders/" + orgId) await page.goto("about:blank");
  await openAdmin(page, "orders/" + orgId);
  await expect(page.getByRole("combobox", { name: "Shop" })).toHaveValue(orgId);
};
const lineRow = (page, orderId) => page.locator(`tr[data-order="${orderId}"]`).first();
const garmentWindow = (page, orderId) => page.getByRole("dialog", { name: "Check in garments — " + orderId });
const openCheckin = async (page, orgId, orderId, label) => {
  await ordersPage(page, orgId);
  const listed = page.waitForResponse(r => r.url().endsWith("/api/orders") && actionOf(r.request()) === "listGarmentCheckins");
  await lineRow(page, orderId).getByRole("button", { name: label }).click();
  await listed;
  const dlg = garmentWindow(page, orderId);
  await expect(dlg).toBeVisible();
  return dlg;
};
const openLocalSale = async (page, orgId) => {
  await ordersPage(page, orgId);
  await page.getByRole("button", { name: "+ Local sale" }).click();
  const form = page.locator("#localSaleForm");
  await expect(form).toBeVisible();
  return form;
};
const saveGlobal = async (page) => {
  await page.getByRole("button", { name: "Save global settings" }).click();
  await expect(toast(page)).toContainText("Global settings saved.");
};
const runCard = (page, who) => page.locator(".ro-card", { hasText: who });
const backlogRow = (page, orderId) => page.locator("details tr", { hasText: orderId });
const openRunOrder = async (page) => {
  await openAdmin(page, "runorder");
  await expect(page.locator("#roBody")).not.toContainText("Loading");
};

test.beforeAll(async ({ api }) => {
  const f = (await api("getFeatures")).features;
  before = { ownGarments: f.ownGarments === true, ownGarmentsWaiver: f.ownGarmentsWaiver };
});
// Whatever the tests did, the switch and the waiver go back to what they were (the switch starts off).
test.afterAll(async ({ api }) => {
  if (before) await api("updateFeatures", { features: { ownGarments: before.ownGarments, ownGarmentsWaiver: before.ownGarmentsWaiver } }).catch(() => {});
});

// =========================================================================================================
test("Global settings → Features: Customer-supplied garments starts off; ticked with a waiver line, saved, audited and back on a reload", async ({ page, api }) => {
  expect(before.ownGarments).toBe(false);
  expect(before.ownGarmentsWaiver).toBe(DEFAULT_WAIVER);
  await openAdmin(page, "settings");
  const row = page.locator("#gFeatRow-ownGarments");
  const box = row.locator(".gFeature");
  await expect(row).toContainText("Customer-supplied garments");
  await expect(box).not.toBeChecked();
  await expect(page.locator("#gPanel-ownGarments")).toBeHidden();
  // Ticking opens the panel: what it does, and the waiver line (the usual sentence until changed).
  await box.check();
  const panel = page.locator("#gPanel-ownGarments");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Customer's own garment");
  await expect(panel).toContainText("Customers can't choose it on the shop.");
  await expect(panel.locator("#gOwnWaiver")).toHaveValue(DEFAULT_WAIVER);
  await panel.locator("#gOwnWaiver").fill("  " + WAIVER + "  ");
  const sent = requestOf(page, "saveGlobalSettingsAll");
  await saveGlobal(page);
  const body = JSON.parse((await sent).postData());
  expect(body.settings.features).toMatchObject({ ownGarments: true, ownGarmentsWaiver: WAIVER });
  const f = (await api("getFeatures")).features;
  expect(f.ownGarments).toBe(true);
  expect(f.ownGarmentsWaiver).toBe(WAIVER);
  // The audit row names both changes.
  const a = (await auditOf(api, "settings.features_set")).find(e => JSON.stringify(e).includes(WAIVER));
  expect(a).toBeTruthy();
  expect(a.detail.changes.ownGarments).toEqual({ from: false, to: true });
  expect(a.detail.changes.ownGarmentsWaiver).toEqual({ from: DEFAULT_WAIVER, to: WAIVER });
  // Opened again: ticked, its panel open with the saved waiver.
  await openAdmin(page, "settings");
  await expect(page.locator("#gFeatRow-ownGarments .gFeature")).toBeChecked();
  await expect(page.locator("#gPanel-ownGarments")).toBeVisible();
  await expect(page.locator("#gOwnWaiver")).toHaveValue(WAIVER);
});

test("a Local sale with a Customer's own garment line: customer-owned, not on Blanks to order, and the Run order waits on the customer's garments", async ({ page, api }) => {
  test.setTimeout(150_000);
  // A DTF product with a transfer at a location, its one size linked to a blank with 10 in stock.
  S.shop = await makeShop(api, { prefix: "owng", products: [], publish: false });
  S.blankName = uniq("Example Own Blank");
  S.blankId = (await api("createBlank", { name: S.blankName, productType: "shirt", vendor: "", brand: "Test Blank Co", sku: "", notes: "", color: "Navy",
    colors: [{ color: "Navy", images: [], sizes: [{ size: "M", quantity: 10, vendorPrice: 4 }] }] })).id;
  const locId = (await api("saveLocation", { location: { name: uniq("Left chest") } })).id;
  const graphicId = (await api("saveGraphic", { org: S.shop.orgId, graphic: { name: uniq("Club Stripe"), kind: "transfer", inkColors: ["White"], visible: true } })).id;
  S.product = { productId: slug("own").slice(0, 30), name: uniq("Team Tee") };
  await api("createProduct", { org: S.shop.orgId, productId: S.product.productId, type: "shirt", name: S.product.name, pricingMode: "flat", flatPrice: 12,
    visible: true, images: [], noDesignNeeded: true, fixedTransfers: [{ locationId: locId, graphicId, ink: "White" }] });
  await api("saveBlankLinks", { org: S.shop.orgId, productId: S.product.productId, remove: [],
    set: [{ productColor: "", productSize: "OSFA", blankId: S.blankId, blankColor: "Navy", blankSize: "M" }] });
  await api("publish", { org: S.shop.orgId });

  // ---- the sale, through the page ------------------------------------------------------------------------------
  S.customer = uniq("Pat Example");
  const form = await openLocalSale(page, S.shop.orgId);
  await form.locator("#lsProduct").selectOption({ label: S.product.name });
  await form.locator("#lsQty").fill("3");
  const own = form.locator("#lsOwn");
  await expect(own).toBeVisible();
  await expect(form).toContainText("Customer's own garment — no blank; check the garments in on the order");
  await own.check();
  await form.locator("#lsPayment").selectOption("Cash");
  await form.locator("summary", { hasText: "Customer info" }).click();
  await form.locator("#lsName").fill(S.customer);
  await form.locator("#lsPaid").check();
  const sale = requestOf(page, "createLocalSale");
  await form.getByRole("button", { name: "Record sale" }).click();
  const req = await sale;
  expect(JSON.parse(req.postData()).items).toEqual([expect.objectContaining({ productId: S.product.productId, qty: 3, customerOwned: true })]);
  const ans = await (await req.response()).json();
  expect(ans.status).toBe("ok");
  S.orderId = ans.orderId;
  await expect(toast(page)).toContainText("Local sale recorded — ");

  const o = await orderOf(api, S.shop.orgId, S.orderId);
  expect(o.paid).toBeTruthy();
  expect(o.items).toHaveLength(1);
  expect(o.items[0]).toMatchObject({ customerOwned: true, qty: 3, size: "OSFA" });
  expect(o.items[0].ownReceivedAt).toBeFalsy();
  expect(o.ownGarments).toEqual({ lines: 1, waiting: 1 });
  expect(o.needsBlanks).toBe(false);
  S.itemId = itemIdOf(o.items[0]);
  // The Orders row: the tag and Check in garments….
  const row = lineRow(page, S.orderId);
  await expect(row.locator(".og-tag")).toHaveText("Customer's garments");
  await expect(row.getByRole("button", { name: "Check in garments…" })).toBeVisible();

  // An ordinary sale of the same product (no tick), for comparison: it needs its blank.
  S.plainCustomer = uniq("Sam Example");
  S.plainOrderId = (await api("createLocalSale", { org: S.shop.orgId, requestId: requestId(), paid: true, paymentMethod: "Cash",
    customerName: S.plainCustomer, items: [{ productId: S.product.productId, size: "OSFA", qty: 1 }] })).orderId;
  expect((await orderOf(api, S.shop.orgId, S.plainOrderId)).items[0].customerOwned).toBe(false);

  // ---- Blanks to order: only the ordinary sale's one piece ------------------------------------------------------
  const bto = JSON.stringify(await api("getBlanksToOrder", {}));
  expect(bto).toContain(S.plainOrderId);
  expect(bto).not.toContain(S.orderId);
  await openAdmin(page, "blankorder");
  await page.locator("#btoStock").uncheck();   // every piece needed, stock or not
  const btoRow = page.locator("#btoBody tr", { hasText: S.blankName });
  await expect(btoRow).toHaveCount(1);
  await expect(btoRow.locator("td").nth(5)).toHaveText("1");
  await expect(page.locator("#btoBody")).not.toContainText(S.orderId);
  await page.locator("#btoStock").check();

  // ---- the Run order -------------------------------------------------------------------------------------------
  // The transfer is in, so the only thing the card waits on is the customer's garments.
  for (const [orderId, itemId] of [[S.orderId, S.itemId], [S.plainOrderId, itemIdOf((await orderOf(api, S.shop.orgId, S.plainOrderId)).items[0])]])
    await api("setTransferReceived", { itemId, orderId, org: S.shop.orgId, received: true });
  const q = await api("getRunQueue");
  const card = q.transfers.waiting.concat(q.transfers.ready).find(c => c.orderId === S.orderId);
  expect(card).toMatchObject({ customerOwned: true, blankReceived: false });
  const unrun = q.paidUnrun.find(x => x.orderId === S.orderId);
  expect(unrun).toMatchObject({ garmentsStatus: WAITING, ownGarments: { lines: 1, waiting: 1 }, needsBlanks: false });
  await openRunOrder(page);
  await expect(backlogRow(page, S.orderId).locator(".ro-garments")).toHaveText(WAITING);
  await expect(backlogRow(page, S.plainOrderId).locator(".ro-garments")).toHaveCount(0);
  await expect(runCard(page, S.customer)).toHaveCount(1);
  await expect(runCard(page, S.customer)).toHaveClass(/ro-card-waiting/);
  await expect(runCard(page, S.customer)).toContainText(WAITING);
  await expect(runCard(page, S.customer).getByRole("button", { name: "Mark made" })).toHaveCount(0);
  // The ordinary sale's card still waits on its blank, in those words.
  await expect(runCard(page, S.plainCustomer)).toContainText("Waiting on blank");

  // Mark manufactured is refused while the garments aren't in (digitizing marked done first: the one step before it).
  await api("setFulfillmentStage", { org: S.shop.orgId, orderId: S.orderId, stage: "digitizingComplete" });
  const made = await api("setFulfillmentStage", { org: S.shop.orgId, orderId: S.orderId, stage: "manufactured" }, { allowError: true, withStatus: true });
  expect(made.status).toBeGreaterThanOrEqual(400);
  expect(made.data.message).toContain("the customer's garments haven't been checked in yet");
});

test("Check in garments… with a short count needs a note, then saves; the line is in and the Run order card is ready", async ({ page, api }) => {
  const dlg = await openCheckin(page, S.shop.orgId, S.orderId, "Check in garments…");
  await expect(dlg.locator(".og-head")).toContainText(S.product.name);
  await expect(dlg.locator(".og-head")).toContainText("· OSFA · 3 on the order");
  await expect(dlg.locator(".og-head")).toContainText(S.customer);
  await expect(dlg.locator("#ogLast")).toHaveCount(0);
  await expect(dlg.locator("#ogUndo")).toHaveCount(0);
  const rows = dlg.locator("#ogRows .og-row");
  await expect(rows).toHaveCount(1);
  await expect(rows.first().getByLabel("Size", { exact: true })).toHaveValue("OSFA");
  await expect(rows.first().getByLabel("Expected")).toHaveValue("3");
  await expect(rows.first().getByLabel("Received")).toHaveValue("3");
  await expect(rows.first().getByLabel("Condition")).toHaveValue("good");
  await expect(dlg.locator("#ogSum")).toHaveText("3 of 3 received");
  await expect(dlg.locator("#ogWaiver")).toBeChecked();
  await expect(dlg.locator(".og-waiver")).toHaveText("“" + WAIVER + "”");

  let asked = false;
  const watch = (r) => { if (actionOf(r) === "checkInGarments") asked = true; };
  page.on("request", watch);
  // The window's own checks, before anything is sent.
  await rows.first().getByLabel("Size", { exact: true }).fill("");
  await dlg.getByRole("button", { name: "Save check-in" }).click();
  await expect(dlg.locator("#ogErr")).toHaveText("Name the size (or One size).");
  await expect(rows.first().getByLabel("Size", { exact: true })).toBeFocused();
  await rows.first().getByLabel("Size", { exact: true }).fill("OSFA");
  await dlg.getByRole("button", { name: "+ Another size" }).click();
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1).getByLabel("Size", { exact: true })).toBeFocused();
  await rows.nth(1).getByLabel("Size", { exact: true }).fill("osfa");
  await dlg.getByRole("button", { name: "Save check-in" }).click();
  await expect(dlg.locator("#ogErr")).toHaveText("osfa is listed twice — put it on one row.");
  await rows.nth(1).getByRole("button", { name: "Remove this size" }).click();
  await expect(rows).toHaveCount(1);
  await expect(dlg.locator("#ogErr")).toHaveText("");
  await rows.first().getByRole("button", { name: "Remove this size" }).click();
  await expect(dlg.locator("#ogErr")).toHaveText("Keep at least one size.");
  await expect(rows).toHaveCount(1);
  await rows.first().getByLabel("Received").fill("");
  await dlg.getByRole("button", { name: "Save check-in" }).click();
  await expect(dlg.locator("#ogErr")).toHaveText("Received for OSFA: a whole number from 0 to 5000.");
  await expect(rows.first().getByLabel("Received")).toBeFocused();
  await rows.first().getByLabel("Expected").fill("2.5");
  await dlg.getByRole("button", { name: "Save check-in" }).click();
  await expect(dlg.locator("#ogErr")).toHaveText("Expected for OSFA: a whole number from 0 to 5000.");
  await rows.first().getByLabel("Expected").fill("3");
  // A short count: the summary says so, and it needs a note.
  await rows.first().getByLabel("Received").fill("2");
  await expect(dlg.locator("#ogSum")).toHaveText("2 of 3 received · 1 size not as expected");
  await dlg.getByRole("button", { name: "Save check-in" }).click();
  await expect(dlg.locator("#ogErr")).toHaveText(NEED_NOTE);
  await expect(rows.first().getByLabel("Note")).toBeFocused();
  // A condition other than Good needs one too, even with the count right.
  await rows.first().getByLabel("Received").fill("3");
  await rows.first().getByLabel("Condition").selectOption("damaged");
  await expect(dlg.locator("#ogSum")).toHaveText("3 of 3 received · 1 size not as expected");
  await dlg.getByRole("button", { name: "Save check-in" }).click();
  await expect(dlg.locator("#ogErr")).toHaveText(NEED_NOTE);
  expect(asked).toBe(false);
  page.off("request", watch);

  // The server checks it too.
  const refused = await api("checkInGarments", { orderId: S.orderId, itemId: S.itemId, counts: [{ size: "OSFA", expectedQty: 3, receivedQty: 2, condition: "good", note: "" }] }, { allowError: true, withStatus: true });
  expect(refused.status).toBe(400);
  expect(refused.data.message).toBe(NEED_NOTE);
  expect((await orderOf(api, S.shop.orgId, S.orderId)).items[0].ownReceivedAt).toBeFalsy();

  // Two short, in good condition, with the note: saved.
  await rows.first().getByLabel("Condition").selectOption("good");
  await rows.first().getByLabel("Received").fill("2");
  const note = "One short — Example Club brings it Friday";
  await rows.first().getByLabel("Note").fill(note);
  const saved = requestOf(page, "checkInGarments");
  await dlg.getByRole("button", { name: "Save check-in" }).click();
  const sent = JSON.parse((await saved).postData());
  expect(sent).toMatchObject({ orderId: S.orderId, itemId: Number(S.itemId), org: S.shop.orgId,
    counts: [{ size: "OSFA", expectedQty: 3, receivedQty: 2, condition: "good", note }] });
  await expect(toast(page)).toContainText("Garments checked in: 2 for " + S.product.name + ".");
  await expect(dlg).toHaveCount(0);
  const row = lineRow(page, S.orderId);
  await expect(row.locator(".og-tag")).toHaveText("Customer's garments · in");
  await expect(row.getByRole("button", { name: "Garments…" })).toBeVisible();

  const o = await orderOf(api, S.shop.orgId, S.orderId);
  expect(o.items[0].ownReceivedAt).toBeTruthy();
  expect(o.ownGarments).toEqual({ lines: 1, waiting: 0 });
  const list = await api("listGarmentCheckins", { orderId: S.orderId });
  expect(list.waiver).toBe(WAIVER);
  expect(list.checkins.filter(c => !c.voidedAt)).toEqual([expect.objectContaining({ itemId: Number(S.itemId), size: "OSFA", expectedQty: 3, receivedQty: 2, condition: "good", note })]);
  const audit = (await auditOf(api, "order.garments_checked_in")).find(e => e.orderId === S.orderId);
  expect(audit.detail).toMatchObject({ itemId: Number(S.itemId), expected: 3, received: 2 });

  // The Run order: the card is ready, the backlog says the garments are in.
  await openRunOrder(page);
  await expect(backlogRow(page, S.orderId).locator(".ro-garments")).toHaveText("Garments in");
  await expect(runCard(page, S.customer)).toHaveClass(/ro-card-ready/);
  await expect(runCard(page, S.customer)).not.toContainText("Waiting on");
  await expect(runCard(page, S.customer).getByRole("button", { name: "Mark made" })).toBeVisible();
});

test("the print slip shows the order, the counts and the waiver (or leaves it off); with no waiver set the window says so", async ({ page, api }) => {
  const dlg = await openCheckin(page, S.shop.orgId, S.orderId, "Garments…");
  await expect(dlg.locator("#ogLast")).toContainText("Checked in ");
  await expect(dlg.locator("#ogLast")).toContainText("Saving again replaces that count.");
  const rows = dlg.locator("#ogRows .og-row");
  await expect(rows.first().getByLabel("Received")).toHaveValue("2");
  await expect(rows.first().getByLabel("Note")).toHaveValue("One short — Example Club brings it Friday");
  await expect(dlg.locator("#ogSum")).toHaveText("2 of 3 received · 1 size not as expected");
  // No printer here: print() is caught, and the slip is read while it is on the page.
  await page.evaluate(() => { window.__printed = []; window.print = () => { const s = document.getElementById("ogSlipPrint"); window.__printed.push({ html: s ? s.innerText : "", printing: document.body.classList.contains("og-printing") }); }; });
  await dlg.getByRole("button", { name: "Print slip" }).click();
  const slip = page.locator("#ogSlipPrint");
  await expect(slip).toBeAttached();
  await expect(slip.locator(".og-slip-h")).toContainText("Garment check-in");
  const facts = slip.locator(".og-slip-facts");
  await expect(facts).toContainText(S.orderId);
  await expect(facts).toContainText(S.customer);
  await expect(facts).toContainText(S.product.name);
  await expect(slip.locator(".og-slip-counts tbody tr")).toHaveCount(1);
  expect((await slip.locator(".og-slip-counts tbody td").allTextContents()).map(s => s.trim())).toEqual(["OSFA", "3", "2", "Good", "One short — Example Club brings it Friday"]);
  await expect(slip.locator(".og-slip-waiver")).toHaveText(WAIVER);
  await expect(slip).toContainText("Customer signature");
  expect(await page.evaluate(() => window.__printed.length)).toBe(1);
  expect(await page.evaluate(() => window.__printed[0].printing)).toBe(true);
  // Printing over: the slip is tidied away.
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  await expect(slip).toHaveCount(0);
  expect(await page.evaluate(() => document.body.classList.contains("og-printing"))).toBe(false);
  // The waiver left off this time.
  await dlg.locator("#ogWaiver").uncheck();
  await dlg.getByRole("button", { name: "Print slip" }).click();
  await expect(slip).toBeAttached();
  await expect(slip.locator(".og-slip-waiver")).toHaveCount(0);
  await expect(slip).not.toContainText(WAIVER);
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  await expect(slip).toHaveCount(0);
  // Close: the waiver tick was changed, so the window asks first.
  await dlg.getByRole("button", { name: "Cancel" }).click();
  await confirmDialog(page, "Discard");
  await expect(dlg).toHaveCount(0);

  // No waiver line saved: the window says where to set one, and the slip has none.
  await api("updateFeatures", { features: { ownGarmentsWaiver: "" } });
  try {
    const d2 = await openCheckin(page, S.shop.orgId, S.orderId, "Garments…");
    await expect(d2).toContainText("No waiver line is set (Global settings → Features → Customer-supplied garments).");
    await expect(d2.locator("#ogWaiver")).toBeDisabled();
    await expect(d2.locator("#ogWaiver")).not.toBeChecked();
    await page.evaluate(() => { window.print = () => {}; });
    await d2.getByRole("button", { name: "Print slip" }).click();
    await expect(page.locator("#ogSlipPrint")).toBeAttached();
    await expect(page.locator("#ogSlipPrint .og-slip-waiver")).toHaveCount(0);
    await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
    await d2.getByRole("button", { name: "Cancel" }).click();
    await expect(d2).toHaveCount(0);
  } finally {
    await api("updateFeatures", { features: { ownGarmentsWaiver: WAIVER } });
  }
});

test("Undo check-in puts the line back to waiting; checked in again, Mark made on the Run order makes it with no blank stock change", async ({ page, api }) => {
  test.setTimeout(120_000);
  const dlg = await openCheckin(page, S.shop.orgId, S.orderId, "Garments…");
  await dlg.getByRole("button", { name: "Undo check-in" }).click();
  const ask = page.getByRole("dialog").last();
  await expect(ask).toContainText("Undo this check-in?");
  await expect(ask).toContainText("The count is taken back and the line waits for the customer's garments again.");
  await ask.getByRole("button", { name: "Undo check-in" }).click();
  await expect(toast(page)).toContainText("Check-in taken back.");
  await expect(dlg).toHaveCount(0);
  const row = lineRow(page, S.orderId);
  await expect(row.locator(".og-tag")).toHaveText("Customer's garments");
  await expect(row.getByRole("button", { name: "Check in garments…" })).toBeVisible();
  let o = await orderOf(api, S.shop.orgId, S.orderId);
  expect(o.items[0].ownReceivedAt).toBeFalsy();
  expect(o.ownGarments).toEqual({ lines: 1, waiting: 1 });
  expect((await api("listGarmentCheckins", { orderId: S.orderId })).checkins.filter(c => !c.voidedAt)).toEqual([]);
  const undone = (await auditOf(api, "order.garments_checkin_undone")).find(e => e.orderId === S.orderId);
  expect(undone.detail).toMatchObject({ itemId: Number(S.itemId), before: { counts: [expect.objectContaining({ size: "OSFA", expected: 3, received: 2 })] } });
  // Nothing left to undo: the server says so.
  const again = await api("undoGarmentCheckin", { orderId: S.orderId, itemId: S.itemId }, { allowError: true, withStatus: true });
  expect(again.status).toBeGreaterThanOrEqual(400);
  expect(again.data.message).toBe("Nothing has been checked in for that line.");
  await openRunOrder(page);
  await expect(runCard(page, S.customer)).toHaveClass(/ro-card-waiting/);
  await expect(runCard(page, S.customer)).toContainText(WAITING);
  await expect(backlogRow(page, S.orderId).locator(".ro-garments")).toHaveText(WAITING);

  // Checked in again, all three in good condition (no note needed).
  const d2 = await openCheckin(page, S.shop.orgId, S.orderId, "Check in garments…");
  await expect(d2.locator("#ogRows .og-row").first().getByLabel("Received")).toHaveValue("3");
  await d2.getByRole("button", { name: "Save check-in" }).click();
  await expect(toast(page)).toContainText("Garments checked in: 3 for " + S.product.name + ".");

  // Mark made on the Run order: made, with the blank's stock untouched and no blank movement.
  const stock = await stockOf(api, S.blankId);
  expect(stock.M).toBe(10);
  const moves = (await api("getBlankMovements", { blankId: S.blankId })).movements.length;
  await openRunOrder(page);
  const card = runCard(page, S.customer);
  await expect(card).toHaveClass(/ro-card-ready/);
  await card.getByRole("button", { name: "Mark made" }).click();
  const when = page.getByRole("dialog").last();
  await expect(when).toContainText("Mark this line made?");
  await confirmDialog(page);
  await expect(toast(page)).toContainText(/Order complete\.|Marked made\./);
  await expect(runCard(page, S.customer)).toHaveCount(0);
  o = await orderOf(api, S.shop.orgId, S.orderId);
  expect(o.manufacturedAt).toBeTruthy();
  expect(await stockOf(api, S.blankId)).toEqual(stock);
  expect((await api("getBlankMovements", { blankId: S.blankId })).movements.length).toBe(moves);
});

test("a quote line with the Customer's own garment tick converts to a customer-owned order line", async ({ page, api }) => {
  const c = await api("saveCustomer", { name: uniq("Example School District"), company: "", email: slug("pat") + "@example.com", phone: "", address: null, notes: "",
    taxExempt: false, taxExemptCertificate: "", taxExemptExpires: "" });
  const made = await api("createEstimate", { org: S.shop.orgId, customerId: c.id, title: "Team shirts", expiresOn: "2099-12-31" });
  S.quoteId = made.id;
  S.customerId = c.id;
  await openAdmin(page, "quotes/" + made.id);
  await expect(page.locator("#qtPage h2.cust-name")).toBeVisible();
  await page.locator("#qtAddProduct").click();
  const dlg = page.getByRole("dialog", { name: "Add a product" });
  await expect(dlg).toBeVisible();
  await dlg.locator("#qtProd").selectOption({ label: S.product.name });
  await dlg.locator("#qtProdQty").fill("4");
  await expect(dlg.locator("#qtProdOwnGarment")).not.toBeChecked();
  await expect(dlg.locator("label", { has: page.locator("#qtProdOwnGarment") })).toContainText("Customer's own garment (the customer brings the garments: no blank is ordered and the price is for the decoration)");
  await dlg.locator("#qtProdOwnGarment").check();
  const saved = requestOf(page, "saveEstimate");
  await dlg.locator("#qtProdSave").click();
  const req = await saved;
  expect(JSON.parse(req.postData()).items).toEqual([expect.objectContaining({ kind: "product", productId: S.product.productId, qty: 4, customerOwned: true })]);
  expect((await (await req.response()).json()).status).toBe("ok");
  await expect(dlg).toHaveCount(0);
  const line = page.locator("#qtLines tbody tr", { hasText: S.product.name });
  await expect(line).toContainText("Customer's own garment");
  const est = await api("getEstimate", { id: made.id });
  expect((est.items || est.estimate.items).find(i => i.productId === S.product.productId).customerOwned).toBeTruthy();

  await page.locator("#qtConvert").click();
  const conv = page.getByRole("dialog", { name: `Convert ${made.number} to an order` });
  const go = requestOf(page, "convertEstimate");
  await conv.locator("#qtConvGo").click();
  const ans = await (await (await go).response()).json();
  expect(ans.status).toBe("ok");
  S.quoteOrderId = ans.orderId;
  await expect(toast(page)).toContainText(`Order ${ans.orderId} made from quote ${made.number}.`);
  const o = await orderOf(api, S.shop.orgId, ans.orderId);
  expect(o.items).toHaveLength(1);
  expect(o.items[0]).toMatchObject({ customerOwned: true, qty: 4 });
  expect(o.ownGarments).toEqual({ lines: 1, waiting: 1 });
  await ordersPage(page, S.shop.orgId);
  await expect(lineRow(page, ans.orderId).locator(".og-tag")).toHaveText("Customer's garments");
  await expect(lineRow(page, ans.orderId).getByRole("button", { name: "Check in garments…" })).toBeVisible();
});

test("Back office checks garments in but can't undo; Production can't check in", async ({ as, api }, testInfo) => {
  const staff = await as("staff");
  const it = (await orderOf(api, S.shop.orgId, S.quoteOrderId)).items[0];
  const dlg = await openCheckin(staff, S.shop.orgId, S.quoteOrderId, "Check in garments…");
  await expect(dlg.getByRole("button", { name: "Save check-in" })).toBeVisible();
  await dlg.getByRole("button", { name: "Save check-in" }).click();
  await expect(toast(staff)).toContainText("Garments checked in: 4 for " + S.product.name + ".");
  // Opened again: the count, but no Undo (that needs Full).
  const d2 = await openCheckin(staff, S.shop.orgId, S.quoteOrderId, "Garments…");
  await expect(d2.locator("#ogLast")).toContainText("Checked in ");
  await expect(d2.locator("#ogUndo")).toHaveCount(0);
  await d2.getByRole("button", { name: "Cancel" }).click();
  const sctx = await apiContext("staff", testInfo.workerIndex);
  const undo = await tryApi(sctx, "undoGarmentCheckin", { orderId: S.quoteOrderId, itemId: itemIdOf(it) });
  expect(undo.status).toBe(403);
  expect(undo.data.message).toBe(NO_ROLE);
  await sctx.dispose();
  expect((await orderOf(api, S.shop.orgId, S.quoteOrderId)).items[0].ownReceivedAt).toBeTruthy();

  const pctx = await apiContext("production", testInfo.workerIndex);
  const listed = await tryApi(pctx, "listGarmentCheckins", { orderId: S.quoteOrderId });
  expect(listed.status).toBe(200);
  const checkIn = await tryApi(pctx, "checkInGarments", { orderId: S.quoteOrderId, itemId: itemIdOf(it), counts: [{ size: "OSFA", expectedQty: 4, receivedQty: 4, condition: "good" }] });
  expect(checkIn.status).toBe(403);
  expect(checkIn.data.message).toBe(NO_ROLE);
  await pctx.dispose();
});

test("switched off on the page: the ticks are gone and the server refuses customer-owned lines and every check-in action", async ({ page, api }) => {
  test.setTimeout(150_000);
  await openAdmin(page, "settings");
  const box = page.locator("#gFeatRow-ownGarments .gFeature");
  await expect(box).toBeChecked();
  await box.uncheck();
  await expect(page.locator("#gPanel-ownGarments")).toBeHidden();
  await saveGlobal(page);
  const f = (await api("getFeatures")).features;
  expect(f.ownGarments).toBe(false);
  expect(f.ownGarmentsWaiver).toBe(WAIVER);   // kept for when it's switched on again

  // The Local sale has no tick.
  const form = await openLocalSale(page, S.shop.orgId);
  await form.locator("#lsProduct").selectOption({ label: S.product.name });
  await expect(form.locator("#lsOwn")).toHaveCount(0);
  await expect(form).not.toContainText("Customer's own garment");
  await page.keyboard.press("Escape");

  // Edit items on the quote's order: no tick, the line still tagged.
  await ordersPage(page, S.shop.orgId);
  await lineRow(page, S.quoteOrderId).locator("td[data-action-td]").getByRole("button", { name: "Edit items" }).click();
  const edit = page.locator("#editOrderRows");
  await expect(edit.locator("tr")).toHaveCount(1);
  await expect(edit.locator("input[data-field=customerOwned]")).toHaveCount(0);
  await expect(edit.locator(".og-tag")).toHaveText("Customer's garments");
  await page.locator("#editOrderAddRow").click();
  await expect(edit.locator("tr")).toHaveCount(2);
  await expect(edit.locator("input[data-field=customerOwned]")).toHaveCount(0);
  await page.keyboard.press("Escape");

  // A quote's Add a product: no tick.
  const made = await api("createEstimate", { org: S.shop.orgId, customerId: S.customerId, title: "More shirts", expiresOn: "2099-12-31" });
  await openAdmin(page, "quotes/" + made.id);
  await page.locator("#qtAddProduct").click();
  const dlg = page.getByRole("dialog", { name: "Add a product" });
  await dlg.locator("#qtProd").selectOption({ label: S.product.name });
  await expect(dlg.locator("#qtProdOwnGarment")).toHaveCount(0);
  await expect(dlg).not.toContainText("Customer's own garment");
  await page.keyboard.press("Escape");

  // The server refuses a customer-owned line wherever one could be sent…
  const sale = await api("createLocalSale", { org: S.shop.orgId, requestId: requestId(), paid: true, paymentMethod: "Cash", customerName: uniq("Lee Example"),
    items: [{ productId: S.product.productId, qty: 1, customerOwned: true }] }, { allowError: true, withStatus: true });
  expect(sale.status).toBe(400);
  expect(sale.data.message).toBe(OFF_LINE);
  const qItem = (await orderOf(api, S.shop.orgId, S.quoteOrderId)).items[0];
  const editAdd = await api("editOrder", { org: S.shop.orgId, orderId: S.quoteOrderId, removals: [], updates: [],
    additions: [{ productId: S.product.productId, name: S.product.name, size: "OSFA", qty: 1, customerOwned: true }] }, { allowError: true, withStatus: true });
  expect(editAdd.status).toBe(400);
  expect(editAdd.data.message).toBe(OFF_LINE);
  const editUpd = await api("editOrder", { org: S.shop.orgId, orderId: S.plainOrderId, removals: [], additions: [],
    updates: [{ itemId: itemIdOf((await orderOf(api, S.shop.orgId, S.plainOrderId)).items[0]), customerOwned: true }] }, { allowError: true, withStatus: true });
  expect(editUpd.status).toBe(400);
  expect(editUpd.data.message).toBe(OFF_LINE);
  expect((await orderOf(api, S.shop.orgId, S.plainOrderId)).items[0].customerOwned).toBe(false);
  const quote = await api("saveEstimate", { id: made.id, items: [{ kind: "product", productId: S.product.productId, size: "OSFA", qty: 2, customerOwned: true }] }, { allowError: true, withStatus: true });
  expect(quote.status).toBe(400);
  expect(quote.data.message).toBe(OFF_LINE);
  // …and every check-in action.
  for (const [action, body] of [
    ["listGarmentCheckins", { orderId: S.quoteOrderId }],
    ["checkInGarments", { orderId: S.quoteOrderId, itemId: itemIdOf(qItem), counts: [{ size: "OSFA", expectedQty: 4, receivedQty: 4, condition: "good" }] }],
    ["undoGarmentCheckin", { orderId: S.quoteOrderId, itemId: itemIdOf(qItem) }],
  ]) {
    const r = await api(action, body, { allowError: true, withStatus: true });
    expect(r.status, action).toBe(403);
    expect(r.data.message, action).toBe(OFF_FEATURE);
  }
  // The check-in that was made stays as it was.
  expect((await orderOf(api, S.shop.orgId, S.quoteOrderId)).items[0].ownReceivedAt).toBeTruthy();
  await waitIdle(page);
});
