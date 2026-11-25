// Money and stock, three fixes of 2026-11 seen from end to end:
//
// - A shop that adds sales tax on top and charges a taxable rush fee: the confirmation's Total, the "order · $…" line
//   and the Zelle amount are what the order owes — the rush fee and its tax included. (The order's answer left both
//   out, so the page asked for $21.20 where the order owed $31.80: functions/_lib/db.js insertOrder,
//   public/storefront.js placeOrder.)
// - An order whose line carries a transfer, marked Manufactured from the Orders screen's stage list: the transfer
//   leaves stock and its cost reaches the line. (Only Run Order's last piece used it: db.js consumeBlanksForOrder.)
// - Record order sent twice with the same key — the retry after a dropped answer — goes into stock once
//   (migrations/0107; functions/api/orders.js receiveBlankOrder). At the API: the page can't lose an answer on purpose.
//
// Every test makes its own shop, products and stock, and only looks at those.
//
// The first test needs the install's sales tax added on top at a rate, and the rush fee taxable — settings every
// shop shares. Other specs' shops are tax-exempt (makeShop), so their totals don't move; still, the settings are
// changed only for the one request that places the order (the page is filled in first) and put back at once, one
// copy of the test at a time (withTaxSettings). If another spec changed them in that moment the order shows it
// (it wasn't taxed on top), and the customer orders again.
import fs from "node:fs";
import path from "node:path";
import { test, expect, openAdmin, shopUrl, slug, uniq, ADMIN } from "../fixtures.mjs";
import { makeShop } from "../lib/data.mjs";
import { STATE_DIR } from "../lib/install.mjs";

// ---- helpers ---------------------------------------------------------------------------------------------
const today = () => new Date().toISOString().slice(0, 10);
const ordersPage = async (page, shop) => {
  if (page.url().startsWith(ADMIN)) await page.goto("about:blank");
  await openAdmin(page, "orders/" + shop.orgId);
  await expect(page.getByRole("combobox", { name: "Shop" })).toHaveValue(shop.orgId);
};
const orderRow = (page, orderId) => page.locator(`tr[data-order="${orderId}"]`).first();
const stageSelect = (page, orderId) => orderRow(page, orderId).locator("td[data-action-td]").locator("select");
const stageCell = (page, orderId, field) => orderRow(page, orderId).locator(`td[data-stage-td="${field}"]`);
const confirmOk = async (page) => {
  const ok = page.locator(".confirm-modal #cmOk");
  await expect(ok).toBeVisible();
  await ok.click();
  await expect(page.locator(".confirm-modal")).toHaveCount(0);
};
const orderOf = async (api, shop, orderId) => (await api("getOrders", { org: shop.orgId })).orders.find(o => o.orderId === orderId);
// Runs `fn` while the install adds 6% sales tax on top and taxes the rush fee, then puts both settings back as they
// were. One at a time across the suite's workers (a folder in the install's state directory is the lock: what one
// copy reads as "before" must not be what another has set for a moment). A lock left by a run that was stopped is
// taken over after 30 seconds.
async function withTaxSettings(api, fn) {
  const lock = path.join(STATE_DIR, "ff-money-tax-settings.lock"), started = Date.now();
  for (;;) {
    try { fs.mkdirSync(lock); break; }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (Date.now() - started > 30_000) break;
      await new Promise(r => setTimeout(r, 50));
    }
  }
  try {
    const { salesTax: taxBefore } = await api("getSalesTaxSettings");
    const { rush: rushBefore } = await api("getRushSettings");
    try {
      await api("updateSalesTaxSettings", { ratePercent: 6, jurisdiction: "", taxMode: "exclusive" });
      await api("updateRushSettings", { rush: { rule: rushBefore.rule, taxable: true } });
      return await fn();
    } finally {
      await api("updateRushSettings", { rush: { rule: rushBefore.rule, taxable: rushBefore.taxable } });
      await api("updateSalesTaxSettings", { ratePercent: taxBefore.ratePercent, jurisdiction: taxBefore.jurisdiction || "", taxMode: taxBefore.taxMode });
    }
  } finally { fs.rmSync(lock, { recursive: true, force: true }); }
}

// ---- the storefront total ---------------------------------------------------------------------------------
test("tax added on top and a taxable rush fee: the confirmation's total and the Zelle amount are what the order owes", async ({ page, api }) => {
  // A shop that charges sales tax (not exempt) with its own fixed $10 rush fee, and a $20 tee.
  const id = slug("ffrush");
  const shop = { orgId: id, subdomain: id, name: uniq("Example Club") };
  await api("createOrg", { orgId: id, subdomain: id, name: shop.name, ready: true, desc: "A shop made by the end-to-end suite.", accent: "#2563eb",
    enabledPayments: { card: false, venmo: true, zelle: true, check: true, cash: true, other: true }, deliveryOptions: [{ type: "pickup" }],
    rushFee: { use: "own", rule: { mode: "fixed", amount: 10 } } });
  const productId = slug("tee").slice(0, 30), productName = uniq("Sample Rush Tee");
  await api("createProduct", { org: id, productId, type: "shirt", name: productName, pricingMode: "flat", flatPrice: 20, visible: true, images: [] });
  await api("publish", { org: id });

  const conf = page.locator(".confirmation");
  let o = null;
  for (let attempt = 0; attempt < 3 && !(o && o.taxMode === "exclusive" && o.rushFeeTax > 0); attempt++) {
    // The customer fills the order in: the tee, rush, Zelle.
    await page.goto(shopUrl(shop.subdomain) + "/");
    await expect(page.getByRole("heading", { level: 1, name: shop.name })).toBeVisible();
    await page.getByRole("button", { name: "Add to cart" }).first().click();
    await page.locator("#rushOrder").check();
    await page.getByLabel("Your name").fill("Casey Customer " + (attempt + 1));
    await page.getByLabel("Email address").fill("casey@example.test");
    await page.getByLabel("Payment method").selectOption({ label: "Zelle" });
    // …and places it while the install adds 6% on top and taxes the rush fee.
    await withTaxSettings(api, async () => {
      await page.getByRole("button", { name: "Place order" }).click();
      await expect(page.getByRole("heading", { level: 2, name: /^Order received/ })).toBeVisible();
    });
    const orderId = /^\s*(\S+)\s*·/.exec(await conf.locator(".order-number").textContent())[1];
    o = await orderOf(api, shop, orderId);
  }
  // The order was taken with tax on top, the rush fee's too.
  expect(o).toMatchObject({ taxMode: "exclusive", rushFee: 10, rushFeeTax: 0.6 });

  // $20 + $1.20 tax + $10 rush + $0.60 tax = $31.80, everywhere the page names an amount.
  await expect(conf.locator(".order-number")).toContainText(o.orderId + " · $31.80");
  await expect(conf.locator(".conf-items .row.total")).toHaveText(/Total\s*\$31\.80/);
  await expect(conf.locator(".conf-items")).toContainText(/Rush fee\s*\$10\.00/);
  await expect(conf.locator(".payment-instructions")).toContainText("$31.80");
  await expect(conf).not.toContainText("$21.20");
  // …and it is what the order owes.
  expect(o.effectiveTotal).toBe(31.8);
  expect(Math.round(o.salesTax * 100)).toBe(180);
});

// ---- transfers on Manufactured ------------------------------------------------------------------------------
test("Manufactured from the Orders screen's stage list takes the line's transfers out of stock and into its cost", async ({ page, api }) => {
  const shop = await makeShop(api, { prefix: "fftr", products: [], publish: false });
  // A transfer with 10 on hand at $2.50 each, a graphic that is that transfer, and a product that offers it on
  // its front — nothing to digitize and no blank to wait for, so a paid order can be made at once.
  const transferName = uniq("Example Crest Transfer");
  const transferId = (await api("saveTransfer", { transfer: { name: transferName } })).id;
  await api("receiveTransferSheet", { rows: [{ transferId, count: 10, pctOfSheet: 100 }], total: 25, receivedAt: today(), vendor: "", vendorRef: "", paidPersonally: true });
  const graphicId = (await api("saveGraphic", { org: shop.orgId, graphic: { name: uniq("Example Crest"), kind: "transfer", transferId, tier: null } })).id;
  const productId = slug("crest").slice(0, 30);
  await api("createProduct", { org: shop.orgId, productId, type: "shirt", name: uniq("Sample Crest Tee"), pricingMode: "flat", flatPrice: 20, visible: true, images: [],
    noDesignNeeded: true, noBlankNeeded: true, configurable: true, garmentColors: ["Navy"], reorderQr: "none",
    locations: [{ key: "front", label: "Front", graphicIds: [graphicId] }] });
  await api("publish", { org: shop.orgId });
  const onHand = async () => (await api("listTransfers", {})).transfers.find(t => t.id === transferId).quantity;
  expect(await onHand()).toBe(10);

  // Two of them sold and paid (a Local sale, as the Orders screen records one).
  const { orderId } = await api("createLocalSale", { org: shop.orgId, customerName: uniq("Casey Customer"), paymentMethod: "Cash", paid: true,
    items: [{ productId, size: "", qty: 2, config: { garmentColor: "Navy", locations: [{ location: "front", graphicId }] } }] });
  expect((await orderOf(api, shop, orderId)).items[0].config.locations[0]).toMatchObject({ kind: "transfer", transferId });
  expect(await onHand()).toBe(10);   // nothing is used until it's made
  // The steps before making it (the design ones; this product waits for no blank).
  await api("setFulfillmentStage", { org: shop.orgId, orderId, stage: "digitizingComplete" });
  await api("setFulfillmentStage", { org: shop.orgId, orderId, stage: "designApproved" }, { allowError: true });

  await ordersPage(page, shop);
  await expect(stageSelect(page, orderId).locator("option", { hasText: /^manufactured$/ })).toHaveCount(1);
  await stageSelect(page, orderId).selectOption({ label: "manufactured" });
  await confirmOk(page);
  await expect(stageCell(page, orderId, "manufacturedAt")).toContainText(/\d/);

  // Two transfers left stock, at their $2.50 each on the line.
  expect(await onHand()).toBe(8);
  const made = await orderOf(api, shop, orderId);
  expect(made.manufacturedAt).toBeTruthy();
  expect(made.items[0].cogs).toBe(5);
  // The stage set again (as a second click or another admin would) uses nothing more.
  await api("setFulfillmentStage", { org: shop.orgId, orderId, stage: "manufactured" });
  await api("bulkSetFulfillmentStage", { org: shop.orgId, orderIds: [orderId], stage: "manufactured" });
  expect(await onHand()).toBe(8);
  expect((await orderOf(api, shop, orderId)).items[0].cogs).toBe(5);
});

// ---- received stock, once ------------------------------------------------------------------------------------
test("Record order sent twice with the same key is received once; a new key is a new order", async ({ api }) => {
  const blankName = uniq("Sample Once Blank");
  const blankId = (await api("createBlank", { name: blankName, brand: "Test Blank Co", productType: "Tee",
    colors: [{ color: "Navy", sizes: [{ size: "M", quantity: 0, purchasePrice: 0 }, { size: "L", quantity: 0, purchasePrice: 0 }] }] })).id;
  const stock = async () => {
    const sizes = (await api("getBlanks")).blanks.find(b => b.id === blankId).colors[0].sizes;
    return Object.fromEntries(sizes.map(z => [z.size, [z.quantity, z.purchasePrice]]));
  };
  // Paid with personal funds: no account, no vendor — only the stock is recorded.
  const order = (requestId) => ({ requestId, receivedAt: today(), paidPersonally: true,
    groups: [{ blankId, lines: [{ color: "Navy", size: "M", qty: 5, unitCost: 4 }, { color: "Navy", size: "L", qty: 3, unitCost: 6 }] }], extraCost: 4 });
  const key = slug("receive");

  const first = await api("receiveBlankOrder", order(key));
  expect(first.status).toBe("ok");
  expect(first.total).toBe(42);
  const after = await stock();
  expect(after.M[0]).toBe(5);
  expect(after.L[0]).toBe(3);

  // The same request again — what pressing Record order again after a lost answer sends.
  const again = await api("receiveBlankOrder", order(key));
  expect(again.status).toBe("ok");
  expect(again.total).toBe(first.total);
  expect(again.parts).toEqual(first.parts);
  expect(await stock()).toEqual(after);
  const history = (await api("getBlankMovements", { blankId })).movements.filter(m => m.kind === "purchase");
  expect(history.reduce((n, m) => n + m.qtyDelta, 0)).toBe(8);

  // Another form's key is another order.
  await api("receiveBlankOrder", order(slug("receive")));
  const twice = await stock();
  expect(twice.M[0]).toBe(10);
  expect(twice.L[0]).toBe(6);
});
