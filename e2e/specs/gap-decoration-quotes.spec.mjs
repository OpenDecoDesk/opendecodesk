// Phase 5, quotes and outside digitizing end to end (public/admin-quotes.js, public/admin-digitizing.js,
// functions/_lib/db.js priceDecoration / saveDigitizingJob, functions/_lib/email.js sendEstimateResponseNotification).
//
// With embroidery stitch pricing on and screen print ticked (Global settings → Decoration types; this spec sets them
// through the same action the page sends, and puts the install back as it found it):
//   - a quote with a configurable product (garment colour + a graphic) priced "By stitches" (stitches × the shop's $ per
//     1,000, plus the product's catalog price), a custom line priced by stitches alone, and a "Screen print price" that adds
//     to the line's price and adds a Screen setup fee line; pressing the helper again replaces its own price, not adds;
//   - the quote is sent and accepted on the customer's link: the order keeps the colour, the graphic and every price, and the
//     owner is told with a "quote" notice (what the morning roll-up lists under Quote);
//   - the helpers are not there when stitch pricing is off or screen print is not ticked;
//   - a design sent to a digitizing vendor, recorded from the order window with "Record the cost as an expense": the expense
//     is on Finance → Expenses (category Digitizing), tied to the order; the record can't be deleted until that expense is;
//   - a Back office user records one (and sees the Delete button gone, the server refusing it); a Production user sees the
//     records without their costs, can't add (no button, the server refuses).
//
// Every shop, product, customer, quote, vendor and order is this file's own. The spec changes an install-wide setting, so
// it runs alone (ALONE in playwright.config.mjs). Dates that matter are fixed; "today" is only used where the page itself
// supplies it.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test, expect, ADMIN, openAdmin, toast, slug, uniq, shopUrl, confirmDialog, apiContext, callApi } from "../fixtures.mjs";
import { makeShop } from "../lib/data.mjs";
import { CONFIG, STATE_DIR, REPO } from "../lib/install.mjs";

const FAR = "2099-12-31";
const sql = (command) => {
  const r = spawnSync(path.join(REPO, "node_modules", ".bin", "wrangler"), ["d1", "execute", "DB", "--local", "--config", CONFIG, "--persist-to", STATE_DIR, "--command", command, "--json"],
    { cwd: REPO, encoding: "utf8", env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" } });
  if (r.status !== 0) throw new Error("wrangler d1 execute failed: " + (r.stdout || "") + (r.stderr || ""));
  return JSON.parse(r.stdout)[0].results;
};

// ---- the install-wide setting: put back at the end ----------------------------------------------------------
let before = null;
const PRICES = {
  embroidery: { stitchPricing: true, centsPer1000: 100, minStitches: 0, minCents: 0 },
  screenprint: { inkColorCents: 150, screenSetupCents: 2000, reorderSetupCents: 500, costCents: 0, maxColors: 3 },
};
async function withOwner(fn) {
  const ctx = await apiContext("owner", 0);
  try { return await fn((action, body, opts) => callApi(ctx, action, body, opts)); } finally { await ctx.dispose(); }
}
const setDeco = (api, types, pricing = {}) => api("updateDecorationSettings", { types, pricing: { ...before.pricing, ...pricing } });

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  await withOwner(async (api) => {
    before = await api("getDecorationSettings", {});
    await setDeco(api, ["embroidery", "dtf", "screenprint"], PRICES);
  });
});
test.afterAll(async () => {
  if (!before) return;
  await withOwner((api) => api("updateDecorationSettings", { types: before.types, pricing: before.pricing }));
});

// ---- data, made with the owner's session -------------------------------------------------------------------
const emailOf = (p) => slug(p) + "@example.test";
// A shop whose $20 tee is configurable: Navy or Heather, and at its location the graphic Crest ($3 add-on, in White or Gold).
async function configShop(api) {
  const location = uniq("Left chest");
  const locId = (await api("saveLocation", { location: { name: location } })).id;
  const shop = await makeShop(api, { prefix: "dqs", products: [{ name: "Sample Cap", price: 15, type: "cap", idPrefix: "cap" }], publish: false });
  const crestId = (await api("saveGraphic", { org: shop.orgId, graphic: { name: "Crest", kind: "transfer", tier: "small", inkColors: ["White", "Gold"], visible: true } })).id;
  await api("setTierPrices", { org: shop.orgId, tiers: { small: 3 } });
  const key = "loc" + locId;
  const tee = { productId: "tee" + Date.now().toString(36).slice(-4), name: uniq("Club Tee") };
  await api("createProduct", { org: shop.orgId, productId: tee.productId, type: "shirt", name: tee.name, pricingMode: "flat", flatPrice: 20, visible: true, images: [],
    configurable: true, garmentColors: ["Navy", "Heather"], reorderQr: "none", noDesignNeeded: true,
    locations: [{ key, label: location, locationId: locId, graphicIds: [crestId] }] });
  await api("publish", { org: shop.orgId });
  return { shop, tee, key, location, crestId };
}
const makeCustomer = async (api, c) => {
  const r = await api("saveCustomer", { name: "", company: "", email: "", phone: "", address: null, notes: "", taxExempt: false, taxExemptCertificate: "", taxExemptExpires: "", ...c });
  return { id: r.id, ...c };
};

// ---- the quote page ----------------------------------------------------------------------------------------
const answerOf = (page, action) => page.waitForResponse(r => r.url().endsWith("/api/orders") && new RegExp(`"action":"${action}"`).test(r.request().postData() || ""));
async function saving(page, fn) {
  const done = answerOf(page, "saveEstimate");
  await fn();
  const body = await (await done).json();
  expect(body.status).toBe("ok");
  return body;
}
const lineRow = (page, text) => page.locator("#qtLines tbody tr").filter({ hasText: text });
const lineCells = async (page, text) => (await lineRow(page, text).locator("td").allTextContents()).map(s => s.trim().replace(/\s+/g, " "));
const totalOf = (page) => page.locator("#qtTotals tr.qt-sum-total td");
async function newQuote(api, page, shop, c, title) {
  const made = await api("createEstimate", { org: shop.orgId, customerId: c.id, title, expiresOn: FAR });
  await openAdmin(page, "quotes/" + made.id);
  await expect(page.locator("#qtPage h2.cust-name")).toBeVisible();
  return made;
}
const decoNote = (dlg) => dlg.locator("[data-qt-note]");
const decoBtn = (dlg, name) => dlg.locator(`[data-qt-deco="${name}"]`);
const decoPane = (dlg, name) => dlg.locator(`[data-qt-pane="${name}"]`);

// =========================================================================================================
test("A quote with a configurable product priced by stitches and a screen print price: sent, accepted on the link, and the order keeps the choices and prices", async ({ page, api, as }) => {
  const { shop, tee, key, location, crestId } = await configShop(api);
  const tag = slug("q");
  const c = await makeCustomer(api, { name: "Pat Example " + tag, company: "Example Boosters " + tag, email: emailOf("pat"), phone: "555-0120" });
  const made = await newQuote(api, page, shop, c, "Club gear " + tag);

  // ---- + Product: a configurable product is on the list, with its colour and graphic picks ---------------------
  await page.locator("#qtAddProduct").click();
  let dlg = page.getByRole("dialog", { name: "Add a product" });
  await expect(dlg.locator("#qtProd option").filter({ hasText: tee.name })).toHaveCount(1);   // no longer left out as a product with choices
  await expect(dlg.locator("#qtProd option").filter({ hasText: "Sample Cap" })).toHaveCount(1);
  await dlg.locator("#qtProd").selectOption({ label: tee.name });
  await expect(dlg.locator("#qtProdCfg")).toBeVisible();
  await expect(dlg.locator("#qtProdColor option")).toHaveText(["Navy", "Heather"]);
  const locSel = dlg.locator(`select[data-qt-loc="${key}"]`);
  await expect(dlg.locator("#qtProdLocs label").first()).toContainText(location);
  await expect(locSel.locator("option")).toHaveText(["Crest (+$3.00)"]);    // one location, one graphic: nothing to leave blank
  await expect(dlg.locator("#qtProdPreview")).toHaveText("Catalog price $23.00 each with the choices above.");
  // A plain product has no picks.
  await dlg.locator("#qtProd").selectOption({ label: "Sample Cap" });
  await expect(dlg.locator("#qtProdCfg")).toBeHidden();
  await expect(dlg.locator("#qtProdPreview")).toHaveText("Catalog price $15.00 each.");
  await dlg.locator("#qtProd").selectOption({ label: tee.name });
  await dlg.locator("#qtProdColor").selectOption("Navy");
  await dlg.locator("#qtProdQty").fill("6");

  // ---- By stitches ---------------------------------------------------------------------------------------
  await expect(decoBtn(dlg, "stitch")).toHaveText("By stitches");
  await expect(decoBtn(dlg, "screen")).toHaveText("Screen print price");
  await expect(decoBtn(dlg, "stitch")).toHaveAttribute("aria-expanded", "false");
  await expect(decoPane(dlg, "stitch")).toBeHidden();
  await decoBtn(dlg, "stitch").click();
  await expect(decoBtn(dlg, "stitch")).toHaveAttribute("aria-expanded", "true");
  await expect(decoPane(dlg, "stitch")).toBeVisible();
  await expect(dlg.locator('[data-qt-f="stitches"]')).toBeFocused();
  await expect(dlg.locator('[data-qt-f="addCatalog"]')).toBeChecked();
  // Nothing typed.
  await dlg.locator('[data-qt-go="stitch"]').click();
  await expect(decoNote(dlg)).toHaveText("Enter the number of stitches (a whole number, like 8500).");
  await expect(dlg.locator('[data-qt-f="stitches"]')).toBeFocused();
  // 8,500 stitches at $1.00 per 1,000 = $8.50, plus the product's $23.00 with its choices. Enter in the field works it out too.
  await dlg.locator('[data-qt-f="stitches"]').fill("8500");
  await dlg.locator('[data-qt-f="stitches"]').press("Enter");
  await expect(decoNote(dlg)).toHaveText("8,500 stitches × $1.00 per 1,000: $8.50 + catalog price $23.00 each.");
  await expect(dlg.locator("#qtProdOwn")).toBeChecked();             // the price becomes one set by hand
  await expect(dlg.locator("#qtProdOwnPrice")).toHaveValue("31.50");
  await expect(dlg.locator("#qtProdPreview")).toHaveText("Price set by hand.");
  // Without the catalog price, the stitch price alone.
  await dlg.locator('[data-qt-f="addCatalog"]').uncheck();
  await dlg.locator('[data-qt-go="stitch"]').click();
  await expect(decoNote(dlg)).toHaveText("8,500 stitches × $1.00 per 1,000: $8.50 each.");
  await expect(dlg.locator("#qtProdOwnPrice")).toHaveValue("8.50");
  await dlg.locator('[data-qt-f="addCatalog"]').check();
  await dlg.locator('[data-qt-go="stitch"]').click();
  await expect(dlg.locator("#qtProdOwnPrice")).toHaveValue("31.50");
  // The pane closes again with its button.
  await decoBtn(dlg, "stitch").click();
  await expect(decoPane(dlg, "stitch")).toBeHidden();
  await expect(decoBtn(dlg, "stitch")).toHaveAttribute("aria-expanded", "false");

  const saveReq = page.waitForRequest(r => r.url().endsWith("/api/orders") && /"action":"saveEstimate"/.test(r.postData() || ""));
  const a = await saving(page, () => dlg.locator("#qtProdSave").click());
  const sent = JSON.parse((await saveReq).postData()).items[0];
  expect(sent).toMatchObject({ kind: "product", productId: tee.productId, qty: 6, customUnitPrice: 31.5 });
  expect(sent.config).toMatchObject({ garmentColor: "Navy", locations: [{ location: key, graphicId: crestId, ink: expect.any(String) }] });
  expect(a.items[0]).toMatchObject({ qty: 6, unitPrice: 31.5, customPrice: true });
  await expect(dlg).toHaveCount(0);
  // The picks are written under the line.
  expect(await lineCells(page, tee.name)).toEqual([tee.name + "Navy · " + location + ": Crest (White) · Price set by hand", "", "$31.50", "", "$31.50", "$189.00", "Change Remove"]);
  await expect(totalOf(page)).toHaveText("$189.00");

  // ---- A custom line: the stitch price alone (no catalog price to add), then screen print on top ----------------
  await page.locator("#qtAddCustom").click();
  dlg = page.getByRole("dialog", { name: "Add a custom line" });
  await dlg.locator("#qtOtherName").fill("Names on the back");
  await dlg.locator("#qtOtherQty").fill("6");
  await decoBtn(dlg, "stitch").click();
  await expect(dlg.locator('[data-qt-f="addCatalog"]')).toHaveCount(0);
  await dlg.locator('[data-qt-f="stitches"]').fill("2000");
  await dlg.locator('[data-qt-go="stitch"]').click();
  await expect(decoNote(dlg)).toHaveText("2,000 stitches × $1.00 per 1,000: $2.00 each.");
  await expect(dlg.locator("#qtOtherPrice")).toHaveValue("2.00");
  // Screen print: 2 colors, 1 location = $1.50 × 2 = $3.00 a piece, and a setup of $20 × 2 colors = $40.
  await expect(dlg.locator('[data-qt-f="colors"] option')).toHaveText(["1", "2", "3"]);     // the shop's "most colors" is 3
  await decoBtn(dlg, "screen").click();
  await expect(decoPane(dlg, "screen")).toBeVisible();
  await expect(dlg.locator('[data-qt-f="colors"]')).toBeFocused();
  await dlg.locator('[data-qt-f="locations"]').fill("0");
  await dlg.locator('[data-qt-go="screen"]').click();
  await expect(decoNote(dlg)).toHaveText("Enter how many locations (1 to 10).");
  await expect(dlg.locator('[data-qt-f="locations"]')).toBeFocused();
  await dlg.locator('[data-qt-f="locations"]').fill("1");
  await dlg.locator('[data-qt-f="colors"]').selectOption("2");
  await dlg.locator('[data-qt-go="screen"]').click();
  await expect(decoNote(dlg)).toHaveText("Screen print adds $3.00 to each piece; a $40.00 screen setup fee is added as its own line when you save.");
  await expect(dlg.locator("#qtOtherPrice")).toHaveValue("5.00");              // $2.00 + $3.00
  // Pressed again (a reorder this time: $5 a colour), it replaces its own part instead of adding twice.
  await dlg.locator('[data-qt-f="reorder"]').check();
  await dlg.locator('[data-qt-f="colors"]').selectOption("1");
  await dlg.locator('[data-qt-go="screen"]').click();
  await expect(decoNote(dlg)).toHaveText("Screen print adds $1.50 to each piece; a $5.00 screen setup fee is added as its own line when you save.");
  await expect(dlg.locator("#qtOtherPrice")).toHaveValue("3.50");
  await dlg.locator('[data-qt-f="reorder"]').uncheck();
  await dlg.locator('[data-qt-f="colors"]').selectOption("2");
  await dlg.locator('[data-qt-go="screen"]').click();
  await expect(dlg.locator("#qtOtherPrice")).toHaveValue("5.00");
  const a2 = await saving(page, () => dlg.locator("#qtOtherSave").click());
  expect(a2.items.map(i => i.kind)).toEqual(["product", "custom", "fee"]);
  expect(a2.items[1]).toMatchObject({ kind: "custom", name: "Names on the back", qty: 6, unitPrice: 5 });
  expect(a2.items[2]).toMatchObject({ kind: "fee", feeKind: "setup", name: "Screen setup — 2 colors", qty: 1, unitPrice: 40, taxable: true });
  expect(await lineCells(page, "Names on the back")).toEqual(["Names on the backCustom line", "", "", "", "$5.00", "$30.00", "Change Remove"]);
  expect(await lineCells(page, "Screen setup")).toEqual(["Setup fee — Screen setup — 2 colors", "1", "", "", "$40.00", "$40.00", "Change Remove"]);
  await expect(totalOf(page)).toHaveText("$259.00");

  // ---- Outside digitizing under the quote's lines --------------------------------------------------------
  const vendor = uniq("Example Digitizing Co");
  const blankVendor = uniq("Example Blanks Co");
  await api("saveVendor", { vendor: { name: vendor, forBlanks: false, forDigitizing: true } });
  await api("saveVendor", { vendor: { name: blankVendor, forBlanks: true } });
  expect((await api("listVendors", {})).vendors.find(v => v.name === vendor)).toMatchObject({ forDigitizing: true });
  const dg = page.locator("#qtDigitizing");
  await expect(dg.getByRole("heading", { name: "Outside digitizing" })).toBeVisible();
  await expect(dg).toContainText("Nothing has been sent to an outside digitizer. “Send to digitizer…” records one.");
  await openAdmin(page, "quotes/" + made.id);                      // fresh load: the vendor list is asked once per page load
  await page.locator("#qtDigitizing").getByRole("button", { name: "Send to digitizer…" }).click();
  const dj = page.getByRole("dialog", { name: "Send to digitizer" });
  await expect(dj.locator("#dgItem")).toHaveCount(0);              // a quote has no order lines to pick
  // Those marked "Digitizes designs" come first; the others are offered too, said not to be digitizers.
  const offered = await dj.locator("#dgVendor option").allTextContents();
  expect(offered).toContain(vendor);
  expect(offered).toContain(blankVendor + " (not marked as a digitizer)");
  expect(offered.at(-1)).toBe("Someone else…");
  expect(offered.indexOf(vendor)).toBeLessThan(offered.indexOf(blankVendor + " (not marked as a digitizer)"));
  expect(offered.filter(n => n.endsWith("(not marked as a digitizer)")).length).toBeGreaterThan(0);
  await dj.locator("#dgVendor").selectOption(vendor);
  await dj.locator("#dgName").fill("Crest logo " + tag);
  await dj.locator("#dgCost").fill("35");
  await dj.locator("#dgSave").click();
  await expect(toast(page)).toContainText("Digitizing record added.");
  await expect(dg.locator("tbody tr")).toContainText([vendor]);
  await expect(dg.locator("tbody tr")).toContainText("Crest logo " + tag);
  await expect(dg.locator("tbody tr")).toContainText("$35.00");
  await expect(dg.locator("tbody tr")).toContainText("Not back yet");
  const quoteJobs = (await api("listDigitizingJobs", { estimateId: made.id })).jobs;
  expect(quoteJobs).toHaveLength(1);
  expect(quoteJobs[0]).toMatchObject({ estimateId: made.id, orderId: "", vendor, costCents: 3500, expenseId: null });
  // No expense was asked for, so Delete goes straight through after its question; and the record is made again for the order's sake below.
  await dg.getByRole("button", { name: "Delete Crest logo " + tag }).click();
  await confirmDialog(page, "Delete");
  await expect(toast(page)).toContainText("Digitizing record deleted.");
  await expect(dg).toContainText("Nothing has been sent to an outside digitizer.");
  expect((await api("listDigitizingJobs", { estimateId: made.id })).jobs).toEqual([]);

  // ---- send it; the customer accepts on the link -----------------------------------------------------------
  const sentAns = await api("sendEstimate", { id: made.id, email: c.email });
  const token = /\?estimate=([0-9a-f]{32})$/.exec(sentAns.link)[1];
  const cp = await as(null);
  await cp.goto(shopUrl(shop.subdomain) + "/?estimate=" + token);
  await expect(cp.getByRole("heading", { level: 1, name: shop.name })).toBeVisible();
  const row = (t) => cp.locator(".inv table.inv-items tbody tr").filter({ hasText: t });
  await expect(row(tee.name)).toContainText("Navy");
  await expect(row(tee.name)).toContainText("Crest");
  await expect(row(tee.name)).toContainText("$31.50");
  await expect(row(tee.name)).toContainText("$189.00");
  await expect(row("Names on the back")).toContainText("$30.00");
  await expect(row("Screen setup — 2 colors")).toContainText("$40.00");
  await expect(cp.locator(".inv-totals tr.inv-total")).toContainText("$259.00");
  await cp.locator("#estAccept").click();
  await expect(cp.locator("#estConfirmText")).toHaveText("Accept this quote and place the order for $259.00? We'll start on it and email you the invoice.");
  const accepted = cp.waitForResponse(r => r.url().endsWith("/api/estimate") && r.request().method() === "POST");
  await cp.locator("#estAcceptYes").click();
  const acc = await (await accepted).json();
  expect(acc).toMatchObject({ status: "ok", action: "accept" });
  const orderId = acc.orderId;
  expect(orderId).toBeTruthy();

  // ---- the order: the colour and graphic kept, every price as quoted -------------------------------------------
  const o = (await api("getOrders", { org: shop.orgId })).orders.find(x => x.orderId === orderId);
  expect(Number(o.total)).toBe(259);
  const tline = o.items.find(i => i.name === tee.name);
  expect(tline).toMatchObject({ qty: 6, unitPrice: 31.5 });
  expect(tline.config.garmentColor).toBe("Navy");
  expect(tline.config.locations.find(l => l.location === key)).toMatchObject({ graphicId: crestId, graphicName: "Crest" });
  expect(o.items.find(i => i.name === "Names on the back")).toMatchObject({ qty: 6, unitPrice: 5 });
  expect(o.items.find(i => /^Setup fee — Screen setup — 2 colors/.test(i.name))).toMatchObject({ unitPrice: 40 });
  await openAdmin(page, "orders/" + shop.orgId);
  const rows = page.locator(`tr[data-order="${orderId}"]`);
  await expect(rows.filter({ hasText: tee.name })).toContainText("$189.00");
  await expect(rows.filter({ hasText: tee.name })).toContainText("Crest");

  // ---- the owner's roll-up: a quote notice, not an invoice one ---------------------------------------------------
  const notices = sql(`SELECT id, kind, orderId, orgId, summary FROM owner_notices WHERE orderId = '${orderId}'`);
  try {
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: "quote", orgId: shop.orgId });
    expect(notices[0].summary).toContain(c.name + " accepted quote " + made.number + " — it is now order " + orderId);
  } finally {
    sql(`UPDATE owner_notices SET sentAt = '2000-01-01T00:00:00.000Z' WHERE orderId = '${orderId}' AND sentAt IS NULL`);   // not left for the next roll-up
  }
});

// =========================================================================================================
test("The price helpers follow Global settings: no By stitches with stitch pricing off, no Screen print price with screen print not ticked", async ({ page, api }) => {
  const shop = await makeShop(api, { prefix: "dqo", products: [{ name: "Sample Cap", price: 15, type: "cap", idPrefix: "cap" }] });
  const c = await makeCustomer(api, { name: "Robin Example " + slug("r"), email: emailOf("robin"), phone: "555-0121" });
  const open = async (title) => {
    const made = await newQuote(api, page, shop, c, title);
    await page.locator("#qtAddProduct").click();
    return page.getByRole("dialog", { name: "Add a product" });
  };
  try {
    // Stitch pricing off (embroidery still ticked): only the screen print helper.
    await setDeco(api, ["embroidery", "dtf", "screenprint"], { embroidery: { ...before.pricing.embroidery, stitchPricing: false } });
    let dlg = await open("Helpers one");
    await expect(dlg.locator("#qtProdQty")).toBeVisible();
    await expect(dlg.locator("[data-qt-deco]")).toHaveText(["Screen print price"]);
    await page.keyboard.press("Escape");

    // Stitch pricing on but embroidery not ticked: not offered; screen print not ticked: not offered either.
    await setDeco(api, ["dtf"], PRICES);
    dlg = await open("Helpers two");
    await expect(dlg.locator("#qtProdQty")).toBeVisible();
    await expect(dlg.locator("[data-qt-deco]")).toHaveCount(0);
    await expect(dlg.locator("#qtProdDeco")).toBeHidden();
    await page.keyboard.press("Escape");

    // Stitch pricing on and ticked, screen print not: only By stitches. A price of $0 per 1,000 says where to set it.
    await setDeco(api, ["embroidery", "dtf"], { embroidery: { ...PRICES.embroidery, centsPer1000: 0 } });
    dlg = await open("Helpers three");
    await expect(dlg.locator("[data-qt-deco]")).toHaveText(["By stitches"]);
    await decoBtn(dlg, "stitch").click();
    await dlg.locator('[data-qt-f="stitches"]').fill("5000");
    await dlg.locator('[data-qt-go="stitch"]').click();
    await expect(decoNote(dlg)).toContainText("Set the stitch price under Global settings → Decoration types.");
    await expect(dlg.locator("#qtProdOwn")).not.toBeChecked();
  } finally {
    await setDeco(api, ["embroidery", "dtf", "screenprint"], PRICES);
  }
  // The server's own answers, from the saved prices.
  expect(await api("priceDecoration", { type: "embroidery", params: { stitches: 8500 } })).toMatchObject({ unitCents: 850, setupCents: 0 });
  expect(await api("priceDecoration", { type: "screenprint", params: { colors: 2, locations: 1 } })).toMatchObject({ unitCents: 300, setupCents: 4000 });
  expect(await api("priceDecoration", { type: "screenprint", params: { colors: 2, locations: 1, reorder: true } })).toMatchObject({ unitCents: 300, setupCents: 1000 });
  const bad = await api("priceDecoration", { type: "stencil", params: {} }, { allowError: true, withStatus: true });
  expect(bad.status).toBe(400);
  expect(bad.data.message).toBe("Unknown decoration type: stencil");
});

// ---- orders with digitizing ------------------------------------------------------------------------------------
async function orderWithShop(api, prefix = "dqd") {
  const shop = await makeShop(api, { prefix, products: [{ name: "Sample Cap", price: 15, type: "cap", idPrefix: "cap" }, { name: "Sample Tee", price: 20 }] });
  const orderId = (await api("createLocalSale", { org: shop.orgId, customerName: uniq("Pat Picker"), paymentMethod: "Cash", paid: true,
    items: [{ productId: shop.products[0].productId, qty: 2 }, { productId: shop.products[1].productId, qty: 1 }] })).orderId;
  return { shop, orderId };
}
const openDigitizing = async (page, shop, orderId) => {
  await openAdmin(page, "orders/" + shop.orgId);
  await expect(page.getByRole("combobox", { name: "Shop" })).toHaveValue(shop.orgId);
  await page.locator(`tr[data-order="${orderId}"]`).first().locator("td[data-action-td]").getByRole("button", { name: "Digitizing…" }).click();
  const dlg = page.getByRole("dialog", { name: "Outside digitizing — " + orderId });
  await expect(dlg).toBeVisible();
  return dlg;
};
const sendWindow = (page) => page.getByRole("dialog").filter({ has: page.locator("#dgForm") });

// =========================================================================================================
test("Outside digitizing from the order window: recorded with its cost booked as an expense tied to the order, on Finance → Expenses; deleting waits for the expense", async ({ page, api }) => {
  const { shop, orderId } = await orderWithShop(api);
  const vendor = uniq("Example Digitizing Co");
  await api("saveVendor", { vendor: { name: vendor, forBlanks: false, forDigitizing: true } });
  const tag = slug("d");
  const name = "Boosters crest " + tag;

  let win = await openDigitizing(page, shop, orderId);
  // The days come from the page's own "today" (the business's), so nothing here assumes the date or this computer's zone.
  const today = await page.evaluate(() => localToday_());
  const sentDay = await page.evaluate(() => addDays_(localToday_(), -3)), earlier = await page.evaluate(() => addDays_(localToday_(), -4));
  const shown = (d) => page.evaluate((x) => adminDate_(x), d);
  await expect(win).toContainText("Nothing has been sent to an outside digitizer. “Send to digitizer…” records one.");
  await win.getByRole("button", { name: "Send to digitizer…" }).click();
  let dj = sendWindow(page);
  await expect(dj.locator("#dgSave")).toHaveText("Record it");
  await expect(dj.locator("#dgName")).toBeFocused();
  await expect(dj.locator("#dgItem option")).toHaveText(["Not for one line", "Sample Cap", "Sample Tee"]);
  await expect(dj.locator("#dgExpense")).not.toBeChecked();
  // The checks the window makes before asking the server.
  await dj.locator("#dgSave").click();
  await expect(dj.locator("#dgErr")).toHaveText("Say what was sent.");
  await dj.locator("#dgName").fill(name);
  await dj.locator("#dgVendor").selectOption("__other__");
  await expect(dj.locator("#dgVendorOtherWrap")).toBeVisible();
  await dj.locator("#dgSave").click();
  await expect(dj.locator("#dgErr")).toHaveText("Say who digitized it.");
  await dj.locator("#dgVendor").selectOption(vendor);
  await expect(dj.locator("#dgVendorOtherWrap")).toBeHidden();
  await dj.locator("#dgSent").fill("");
  await dj.locator("#dgSave").click();
  await expect(dj.locator("#dgErr")).toHaveText("Enter the day it was sent.");
  await dj.locator("#dgSent").fill(sentDay);
  await dj.locator("#dgBack").fill(earlier);
  await dj.locator("#dgSave").click();
  await expect(dj.locator("#dgErr")).toHaveText("It can't come back before it was sent.");
  await dj.locator("#dgBack").fill("");
  await dj.locator("#dgCost").fill("12.345");
  await dj.locator("#dgSave").click();
  await expect(dj.locator("#dgErr")).toHaveText("Enter the cost (0 or more, like 25.00).");
  // An expense for nothing is refused: a cost first.
  await dj.locator("#dgCost").fill("");
  await dj.locator("#dgExpense").check();
  await dj.locator("#dgSave").click();
  await expect(dj.locator("#dgErr")).toHaveText("There is no cost to record as an expense. Enter the cost first.");
  await expect(dj.locator("#dgCost")).toBeFocused();
  // Recorded: for the cap line, back on the 12th, $45.00, booked as an expense.
  await dj.locator("#dgItem").selectOption({ label: "Sample Cap" });
  await dj.locator("#dgBack").fill(today);
  await dj.locator("#dgCost").fill("45");
  await dj.locator("#dgNote").fill("Left chest, 8,500 stitches");
  const posted = page.waitForRequest(r => r.url().endsWith("/api/orders") && /"action":"saveDigitizingJob"/.test(r.postData() || ""));
  await dj.locator("#dgSave").click();
  const body = JSON.parse((await posted).postData());
  expect(body.job).toMatchObject({ orderId, name, vendor, sentAt: sentDay, returnedAt: today, costCents: 4500, note: "Left chest, 8,500 stitches", recordExpense: true });
  await expect(toast(page)).toContainText("Digitizing record added.");
  await expect(dj).toHaveCount(0);
  const row = win.locator("tbody tr");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(name);
  await expect(row).toContainText(await shown(sentDay));
  await expect(row).toContainText(await shown(today));
  await expect(row).toContainText("Left chest, 8,500 stitches · cost booked as an expense");
  await expect(row).toContainText(vendor);
  await expect(row).toContainText("$45.00");
  await expect(row).not.toContainText("Not back yet");

  // The expense: on the books, tied to this order, in the Digitizing category, dated the day it came back.
  const exp = sql(`SELECT id, expenseDate, description, amountCents, vendor, orderId, categoryId FROM expenses WHERE orderId = '${orderId}' AND deletedAt IS NULL`);
  expect(exp).toHaveLength(1);
  expect(exp[0]).toMatchObject({ expenseDate: today, description: "Digitizing: " + name, amountCents: 4500, vendor });
  expect(sql(`SELECT name FROM expense_categories WHERE id = ${exp[0].categoryId}`)[0].name).toBe("Digitizing");
  const jobs = (await api("listDigitizingJobs", { orderId })).jobs;
  expect(jobs[0]).toMatchObject({ orderId, itemId: expect.any(Number), name, vendor, costCents: 4500, expenseId: exp[0].id });

  // …and on Finance → Expenses.
  await openAdmin(page, "expenses");
  await expect(page.locator("#expYear")).toHaveValue(today.slice(0, 4));      // the page opens on this month
  const erow = page.locator(`#expList tr[data-expense-row="${exp[0].id}"]`);
  await expect(erow).toContainText("Digitizing: " + name);
  await expect(erow).toContainText("Digitizing");
  await expect(erow).toContainText("$45.00");
  await expect(erow).toContainText(today);

  // Changing the record: its cost is the expense's now, and there is no second expense to book.
  win = await openDigitizing(page, shop, orderId);
  await win.getByRole("button", { name: "Change " + name }).click();
  dj = sendWindow(page);
  await expect(dj.locator("#dgSave")).toHaveText("Save");
  await expect(dj.locator("#dgName")).toHaveValue(name);
  await expect(dj.locator("#dgVendor")).toHaveValue(vendor);
  await expect(dj.locator("#dgItem")).toHaveValue(String(jobs[0].itemId));
  await expect(dj.locator("#dgCost")).toBeDisabled();
  await expect(dj.locator("#dgCost")).toHaveValue("45.00");
  await expect(dj.locator("#dgExpense")).toHaveCount(0);
  await expect(dj).toContainText("Its cost is booked as an expense; change the amount there.");
  await dj.locator("#dgNote").fill("Left chest only");
  await dj.locator("#dgSave").click();
  await expect(toast(page)).toContainText("Digitizing record saved.");
  await expect(win.locator("tbody tr")).toContainText("Left chest only · cost booked as an expense");
  expect(sql(`SELECT COUNT(*) AS n FROM expenses WHERE orderId = '${orderId}' AND deletedAt IS NULL`)[0].n).toBe(1);
  expect((await api("listDigitizingJobs", { orderId })).jobs[0]).toMatchObject({ costCents: 4500, expenseId: exp[0].id, note: "Left chest only" });

  // Delete asks; the server refuses while the expense is live, and the record stays.
  await win.getByRole("button", { name: "Delete " + name }).click();
  await confirmDialog(page, "Delete");
  await expect(toast(page)).toContainText("Delete its expense first");
  await expect(win.locator("tbody tr")).toHaveCount(1);
  // Delete the expense (Finance → Expenses' own action), and the record can go.
  await api("deleteExpense", { expenseId: exp[0].id });
  await win.getByRole("button", { name: "Delete " + name }).click();
  await confirmDialog(page, "Delete");
  await expect(toast(page)).toContainText("Digitizing record deleted.");
  await expect(win).toContainText("Nothing has been sent to an outside digitizer.");
  expect((await api("listDigitizingJobs", { orderId })).jobs).toEqual([]);
  // A deleted record can't be deleted again, and the server's other refusals are plain.
  const again = await api("deleteDigitizingJob", { id: jobs[0].id }, { allowError: true, withStatus: true });
  expect(again.status).toBe(409);
  expect(again.data.message).toBe("That digitizing record no longer exists.");
  const noWhere = await api("listDigitizingJobs", {}, { allowError: true, withStatus: true });
  expect(noWhere.status).toBe(400);
  // What the server checks that the window can't.
  const day = { orderId, vendor, sentAt: today, name: "Check " + tag };
  const tries = [
    [{ ...day, name: " " }, 400, "Say what was sent (its name)"],
    [{ ...day, name: "x".repeat(201) }, 400, "The name is up to 200 characters"],
    [{ ...day, sentAt: "2026-02-31" }, 400, "Enter the day it was sent (YYYY-MM-DD)"],
    [{ ...day, returnedAt: "soon" }, 400, "Enter the day it came back (YYYY-MM-DD) or leave it empty"],
    [{ ...day, sentAt: "2026-03-10", returnedAt: "2026-03-09" }, 400, "It can't come back before it was sent"],
    [{ ...day, costCents: 1.5 }, 400, "The cost is whole cents from $0 to $1,000,000"],
    [{ ...day, costCents: -1 }, 400, "The cost is whole cents from $0 to $1,000,000"],
    [{ ...day, costCents: 100000001 }, 400, "The cost is whole cents from $0 to $1,000,000"],
    [{ ...day, orderId: "NOPE-0000" }, 404, "Order not found"],
  ];
  for (const [job, status, message] of tries) {
    const r = await api("saveDigitizingJob", { job }, { allowError: true, withStatus: true });
    expect(r, JSON.stringify(job).slice(0, 80)).toMatchObject({ status, data: { message } });
  }
  expect((await api("saveDigitizingJob", { job: null }, { allowError: true, withStatus: true })).status).toBe(400);
  expect((await api("deleteDigitizingJob", { id: 0 }, { allowError: true, withStatus: true })).status).toBe(400);
  const stranger = await api("saveDigitizingJob", { job: { ...day, vendor: "Nobody Listed " + tag } }, { allowError: true, withStatus: true });
  expect(stranger.status).toBe(400);
  expect(stranger.data.message).toContain("isn't in the vendor list");
  expect((await api("listDigitizingJobs", { orderId })).jobs).toEqual([]);      // none of those was written
});

// =========================================================================================================
test("Digitizing by role: Back office records (no expense, no delete), Production and Read only see the records (Production without their cost) and can't add", async ({ page, api, as }, testInfo) => {
  const NO_ROLE = "Your role can't do this. Ask an admin.";
  const { shop, orderId } = await orderWithShop(api, "dqr");
  const vendor = uniq("Example Digitizing Co");
  await api("saveVendor", { vendor: { name: vendor, forBlanks: false, forDigitizing: true } });
  const today = await (async () => { await openAdmin(page, "home"); return page.evaluate(() => localToday_()); })();
  const base = { orderId, vendor, sentAt: today, returnedAt: null, note: "" };
  // The owner's record, with a cost and an expense: what the others see of it.
  const ownerJob = (await api("saveDigitizingJob", { job: { ...base, name: "Owner crest " + slug("o"), costCents: 6000, recordExpense: true } })).id;
  const expenseId = (await api("listDigitizingJobs", { orderId })).jobs.find(j => j.id === ownerJob).expenseId;
  expect(expenseId).toEqual(expect.any(Number));

  // ---- Back office -----------------------------------------------------------------------------------------
  const staff = await as("staff");
  let win = await openDigitizing(staff, shop, orderId);
  await expect(win.locator("tbody tr")).toContainText("$60.00");                  // may see costs (they enter them)
  await win.getByRole("button", { name: "Send to digitizer…" }).click();
  const dj = sendWindow(staff);
  await expect(dj.locator("#dgCost")).toBeVisible();
  await expect(dj.locator("#dgExpense")).toHaveCount(0);                          // no Expenses permission: nothing to book
  const name = "Staff logo " + slug("s");
  await dj.locator("#dgName").fill(name);
  await dj.locator("#dgVendor").selectOption(vendor);
  await dj.locator("#dgCost").fill("20");
  await dj.locator("#dgSave").click();
  await expect(toast(staff)).toContainText("Digitizing record added.");
  await expect(win.locator("tbody tr").filter({ hasText: name })).toContainText("$20.00");
  // Change is there; Delete is switched off by the page (it needs Full).
  await expect(win.getByRole("button", { name: "Change " + name })).toBeEnabled();
  const del = win.locator("[data-dg-del]");
  await expect(del).toHaveCount(2);
  for (const b of await del.all()) { await expect(b).toHaveAttribute("data-perm-off", ""); await expect(b).toBeHidden(); }
  const staffCtx = await apiContext("staff", testInfo.workerIndex);
  try {
    const staffJobs = (await callApi(staffCtx, "listDigitizingJobs", { orderId })).jobs;
    expect(staffJobs).toHaveLength(2);
    const mine = staffJobs.find(j => j.name === name);
    expect(mine).toMatchObject({ costCents: 2000, expenseId: null });
    const refused = await callApi(staffCtx, "deleteDigitizingJob", { id: mine.id }, { allowError: true, withStatus: true });
    expect(refused.status).toBe(403);
    expect(refused.data.message).toBe(NO_ROLE);
    // …and asking the server to book an expense is refused with the reason, nothing written.
    const noExp = await callApi(staffCtx, "saveDigitizingJob", { job: { ...base, name: "Staff expense try", costCents: 1000, recordExpense: true } }, { allowError: true, withStatus: true });
    expect(noExp.status).toBe(403);
    expect(noExp.data.message).toBe("Your role can't record an expense. Untick “Record the cost as an expense”, or ask an admin.");
    expect((await api("listDigitizingJobs", { orderId })).jobs.map(j => j.name)).not.toContain("Staff expense try");
    expect(sql(`SELECT COUNT(*) AS n FROM expenses WHERE orderId = '${orderId}' AND deletedAt IS NULL`)[0].n).toBe(1);   // the owner's only
    // Back office can change the record (not its cost: that is the expense's).
    const upd = await callApi(staffCtx, "saveDigitizingJob", { job: { ...base, id: mine.id, name, costCents: 2000, note: "Changed by Back office" } });
    expect(upd.status).toBe("ok");
    // The server also checks what the window can't: a day that isn't a day, an order that isn't one.
    const badDay = await callApi(staffCtx, "saveDigitizingJob", { job: { ...base, name, sentAt: "2026-02-31" } }, { allowError: true, withStatus: true });
    expect(badDay).toMatchObject({ status: 400, data: { message: "Enter the day it was sent (YYYY-MM-DD)" } });
    const noOrder = await callApi(staffCtx, "saveDigitizingJob", { job: { ...base, name, orderId: "NOPE-0000" } }, { allowError: true, withStatus: true });
    expect(noOrder).toMatchObject({ status: 404, data: { message: "Order not found" } });
    const noVendor = await callApi(staffCtx, "saveDigitizingJob", { job: { ...base, name, vendor: "Nobody Listed " + slug("n") } }, { allowError: true, withStatus: true });
    expect(noVendor.status).toBe(400);
  } finally { await staffCtx.dispose(); }

  // ---- Production ----------------------------------------------------------------------------------------
  const prod = await as("production");
  win = await openDigitizing(prod, shop, orderId);
  await expect(win.locator("tbody tr")).toHaveCount(2);                           // sees what was sent
  await expect(win.locator("tbody tr").filter({ hasText: name })).toContainText(vendor);
  await expect(win).not.toContainText("$");                                       // …without any cost
  await expect(win).not.toContainText("cost booked as an expense");
  await expect(win.getByRole("button", { name: "Send to digitizer…" })).toHaveCount(0);
  await expect(win.getByRole("button", { name: /^Change / })).toHaveCount(0);
  await expect(win.getByRole("button", { name: /^Delete / })).toHaveCount(0);
  const prodCtx = await apiContext("production", testInfo.workerIndex);
  try {
    const seen = (await callApi(prodCtx, "listDigitizingJobs", { orderId })).jobs;
    expect(seen).toHaveLength(2);
    for (const j of seen) { expect(j).not.toHaveProperty("costCents"); expect(j).not.toHaveProperty("expenseId"); expect(j.vendor).toBe(vendor); }
    for (const [action, body] of [
      ["saveDigitizingJob", { job: { ...base, name: "Production try", costCents: 0 } }],
      ["deleteDigitizingJob", { id: ownerJob }],
      ["priceDecoration", { type: "embroidery", params: { stitches: 1000 } }],
    ]) {
      const r = await callApi(prodCtx, action, body, { allowError: true, withStatus: true });
      expect(r.status, action + ": " + JSON.stringify(r.data)).toBe(403);
      expect(r.data.message, action).toBe(NO_ROLE);
    }
    expect((await api("listDigitizingJobs", { orderId })).jobs.map(j => j.name)).not.toContain("Production try");
  } finally { await prodCtx.dispose(); }

  // ---- Read only (every function at Read): the records to look at, nothing to change --------------------------
  const viewer = await as("viewer");
  win = await openDigitizing(viewer, shop, orderId);
  await expect(win.locator("tbody tr")).toHaveCount(2);
  await expect(win.getByRole("button", { name: "Send to digitizer…" })).toHaveCount(0);
  await expect(win.getByRole("button", { name: /^Change / })).toHaveCount(0);
  const viewCtx = await apiContext("viewer", testInfo.workerIndex);
  try {
    expect((await callApi(viewCtx, "listDigitizingJobs", { orderId })).jobs).toHaveLength(2);
    for (const [action, body] of [["saveDigitizingJob", { job: { ...base, name: "Viewer try", costCents: 0 } }], ["deleteDigitizingJob", { id: ownerJob }]]) {
      const r = await callApi(viewCtx, action, body, { allowError: true, withStatus: true });
      expect(r.status, action).toBe(403);
      expect(r.data.message, action).toBe(NO_ROLE);
    }
  } finally { await viewCtx.dispose(); }

  // The owner's expense is untouched by all of it.
  expect(sql(`SELECT amountCents FROM expenses WHERE id = ${expenseId} AND deletedAt IS NULL`)[0].amountCents).toBe(6000);
});
