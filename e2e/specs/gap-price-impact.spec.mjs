// Brand rules → "Show price impact…" (admin.js showPriceImpact_) and the product form's supplier logo approval box
// (loadBrandApprovalBox_ / showBrandApprovalModal_). No other spec opens either: accessibility.spec only loads the
// Brand rules page.
//
// The price impact window lists every product size, in every shop, linked to a blank with a MAP: its price now
// (Before) and MAP + the price rule (After). A rule typed in the window changes After at once; the ticked After prices
// are applied to the products (drafts until each shop is published, which the window offers); "Save this rule" keeps
// the rule on Brand rules. Checked here: the rows and the change for this file's own products as the rule, its unit and
// the rounding change; a blank's MAP changed on Inventory → Blanks showing in After; Apply with Cancel (nothing
// changes) and with Apply prices (the saved prices, the shop page before and after Publish); Close without saving; Save
// this rule; and the role limits (Manager may apply but not save the rule; Read only only looks, and the server
// refuses it the apply). The product form's price calculator, which starts from the saved rule, is checked once too.
//
// The approval box shows on a product linked to a blank of a restricted brand: adding an approval (the supplier's file
// is required), for this product and another of the shop, then revoking it.
//
// Brand rules are one setting for the whole install. Every test here uses a brand of its own (an invented name made
// unique), so its rule only touches its own blanks, and takes that brand back off the rules when it ends. Products of
// other specs never change: before applying, every row is unticked and only this test's own are ticked again.
import { test, expect, openAdmin, leaveAdmin, toast, uniq, shopUrl, apiContext, callApi, pngBytes } from "../fixtures.mjs";
import { makeShop } from "../lib/data.mjs";

const key = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
// Takes `brand` off the price rules and the restricted brands, leaving everything else as it is.
async function dropBrand(api, brand) {
  const { rules } = await api("getBrandRules");
  await api("updateBrandRules", { rules: { ...rules,
    brands: rules.brands.filter(b => key(b.brand) !== key(brand)), brandPrices: (rules.brandPrices || []).filter(b => key(b.brand) !== key(brand)) } });
}
const brandPriceOf = async (api, brand) => ((await api("getBrandRules")).rules.brandPrices || []).find(b => key(b.brand) === key(brand)) || null;

// A blank of `brand` with a MAP per size (Navy), linked to two shops' products: shop A's sized tee (S $20, M $21,
// L $23; MAP S/M $10, L $12) and shop B's one-price cap ($18, linked to the blank's M).
async function mapSetup(api, label) {
  const brand = uniq("Test Map Co");
  const blank = uniq(label + " Blank");
  const blankId = (await api("createBlank", { name: blank, productType: "shirt", vendor: "", brand, sku: "", notes: "", color: "Navy",
    colors: [{ color: "Navy", images: [], sizes: [["S", 10], ["M", 10], ["L", 12]].map(([size, map]) => ({ size, quantity: 5, vendorPrice: 4, mapPrice: map })) }] })).id;
  const tee = uniq(label + " Tee"), cap = uniq(label + " Cap");
  const shopA = await makeShop(api, { prefix: "impa", products: [{ name: tee, price: 0, idPrefix: "tee", extra: { pricingMode: "sized", sizePricing: { S: 20, M: 21, L: 23 } } }] });
  const shopB = await makeShop(api, { prefix: "impb", products: [{ name: cap, price: 18, idPrefix: "cap" }] });
  await api("saveBlankLinks", { org: shopA.orgId, productId: shopA.products[0].productId, remove: [],
    set: ["S", "M", "L"].map(z => ({ productColor: "", productSize: z, blankId, blankColor: "Navy", blankSize: z })) });
  await api("saveBlankLinks", { org: shopB.orgId, productId: shopB.products[0].productId, remove: [],
    set: [{ productColor: "", productSize: "OSFA", blankId, blankColor: "Navy", blankSize: "M" }] });
  return { brand, blank, blankId, tee, cap, shopA, shopB };
}
// A product's prices as saved (drafts included): { S: 20, … } or { flat: 18 }.
async function pricesOf(api, shop) {
  const p = (await api("listProducts", { org: shop.orgId })).products.find(x => x.productId === shop.products[0].productId);
  return p.pricingMode === "flat" ? { flat: p.flatPrice } : p.sizePricing;
}

// Brand rules → Show price impact…
async function openImpact(page) {
  await openAdmin(page, "brandrules");
  await page.getByRole("button", { name: "Show price impact…" }).click();
  const dlg = page.getByRole("dialog", { name: "Price impact of the price rule" });
  await expect(dlg.locator("#piSummary")).toContainText("prices on blanks with a MAP");
  return dlg;
}
// A price's row in the window: the product, and its size ("One price" for a one-price product).
const piRow = (dlg, product, what) => dlg.locator("tr.pi-row", { hasText: product })
  .filter({ has: dlg.page().locator("td", { hasText: new RegExp("^\\s*" + what + " MAP \\$") }) });
// Before / After / Change of a row, as shown.
async function figures(row) {
  return [await row.locator(".pi-before").innerText(), await row.locator(".pi-after").innerText(), await row.locator(".pi-change").innerText()].map(s => s.trim());
}
// The brand's own rule boxes in the window.
const brandRule = (dlg, brand) => {
  const el = dlg.locator(`.pi-brand[data-brand="${brand}"]`);
  return { amount: el.getByRole("spinbutton", { name: "Amount over MAP" }), unit: el.getByRole("combobox", { name: "Dollars or percent" }) };
};
// Unticks every price that would change, then ticks only `rows`.
async function tickOnly(dlg, rows) {
  await dlg.getByRole("checkbox", { name: "Tick every price that would change" }).uncheck();
  for (const r of rows) await r.getByRole("checkbox", { name: "Apply this price" }).check();
}
// The shop page's card of a product.
const shopCard = (page, name) => page.locator("main").getByRole("heading", { level: 3, name, exact: true })
  .locator("xpath=ancestor::*[.//button[contains(@class,'add-btn')]][1]");

test("the price impact window follows the rule typed in it, applies the ticked prices as drafts, and publishes a shop", async ({ page, api, as }) => {
  const d = await mapSetup(api, "Impact");
  try {
    const dlg = await openImpact(page);
    // The blank's heading names it and its brand; no rule for the brand yet, so After is empty and nothing would change.
    await expect(dlg.locator("tr.pi-blank", { hasText: d.blank })).toContainText(d.blank + " · " + d.brand);
    const S = piRow(dlg, d.tee, "S"), M = piRow(dlg, d.tee, "M"), L = piRow(dlg, d.tee, "L"), C = piRow(dlg, d.cap, "One price");
    await expect(S).toContainText(d.shopA.name);
    await expect(C).toContainText(d.shopB.name);
    expect(await figures(S)).toEqual(["$20.00", "—", "—"]);
    expect(await figures(C)).toEqual(["$18.00", "—", "—"]);
    await expect(S.getByRole("checkbox")).toHaveCount(0);
    // "Only prices that would change" hides them while nothing would.
    await dlg.getByRole("checkbox", { name: "Only prices that would change" }).check();
    await expect(S).toHaveCount(0);

    // The brand's rule: MAP + $12 → S $22 (+$2), M $22 (+$1), L $24 (+$1), the cap $22 (+$4); listed again and ticked.
    const rule = brandRule(dlg, d.brand);
    await rule.amount.fill("12");
    expect(await figures(S)).toEqual(["$20.00", "$22.00", "+$2.00"]);
    expect(await figures(M)).toEqual(["$21.00", "$22.00", "+$1.00"]);
    expect(await figures(L)).toEqual(["$23.00", "$24.00", "+$1.00"]);
    expect(await figures(C)).toEqual(["$18.00", "$22.00", "+$4.00"]);
    for (const r of [S, M, L, C]) await expect(r.getByRole("checkbox", { name: "Apply this price" })).toBeChecked();
    // In percent: MAP + 12% → S $11.20; MAP + 50% → S $15 (−$5), L $18 (−$5).
    await rule.unit.selectOption("percent");
    expect(await figures(S)).toEqual(["$20.00", "$11.20", "−$8.80"]);
    await rule.amount.fill("50");
    expect(await figures(S)).toEqual(["$20.00", "$15.00", "−$5.00"]);
    expect(await figures(L)).toEqual(["$23.00", "$18.00", "−$5.00"]);
    await rule.amount.fill("15");   // MAP + 15%: S $11.50, L $13.80
    // Rounding only goes up: to .99, or to the next whole dollar.
    await dlg.getByRole("combobox", { name: "Round After" }).selectOption({ label: "Up to .99" });
    expect(await figures(S)).toEqual(["$20.00", "$11.99", "−$8.01"]);
    expect(await figures(L)).toEqual(["$23.00", "$13.99", "−$9.01"]);
    await dlg.getByRole("combobox", { name: "Round After" }).selectOption({ label: "Up to the next whole dollar" });
    expect(await figures(L)).toEqual(["$23.00", "$14.00", "−$9.00"]);
    // Back to dollars, exact.
    await dlg.getByRole("combobox", { name: "Round After" }).selectOption({ label: "Exact" });
    await rule.unit.selectOption("dollars");
    await rule.amount.fill("12");
    expect(await figures(L)).toEqual(["$23.00", "$24.00", "+$1.00"]);
    await dlg.getByRole("checkbox", { name: "Only prices that would change" }).uncheck();

    // Only this test's S, M and the cap ticked (L left as it is): Apply 3 prices in 2 shops.
    await tickOnly(dlg, [S, M, C]);
    const apply = dlg.getByRole("button", { name: "Apply 3 prices…" });
    await apply.click();
    const ask = page.getByRole("dialog", { name: "Apply 3 new prices in 2 shops?" });
    await expect(ask).toContainText("Shoppers see the new prices when each shop is published.");
    // Cancel: nothing is applied.
    await ask.getByRole("button", { name: "Cancel" }).click();
    await expect(ask).toHaveCount(0);
    expect(await pricesOf(api, d.shopA)).toEqual({ S: 20, M: 21, L: 23 });
    expect(await pricesOf(api, d.shopB)).toEqual({ flat: 18 });
    // Apply prices.
    await apply.click();
    await page.getByRole("dialog", { name: "Apply 3 new prices in 2 shops?" }).getByRole("button", { name: "Apply prices" }).click();
    const done = dlg.locator("#piDone");
    await expect(done).toContainText("Applied 3 prices in 2 shops. They're drafts until published:");
    expect(await pricesOf(api, d.shopA)).toEqual({ S: 22, M: 22, L: 23 });
    expect(await pricesOf(api, d.shopB)).toEqual({ flat: 22 });
    // The window reloads: the applied rows are at their After price; L still would change, ticked again.
    expect(await figures(S)).toEqual(["$22.00", "$22.00", "$0.00"]);
    expect(await figures(C)).toEqual(["$22.00", "$22.00", "$0.00"]);
    expect(await figures(L)).toEqual(["$23.00", "$24.00", "+$1.00"]);
    await expect(L.getByRole("checkbox", { name: "Apply this price" })).toBeChecked();

    // Drafts: the cap's shop page still sells it at $18 until its shop is published from the window.
    const shopper = await as(null);
    await shopper.goto(shopUrl(d.shopB.subdomain) + "/");
    await expect(shopCard(shopper, d.cap)).toContainText("$18.00");
    await done.getByRole("button", { name: "Publish " + d.shopB.name }).click();
    await expect(done.getByRole("button", { name: "✓ " + d.shopB.name + " published" })).toBeDisabled();
    await shopper.reload();
    await expect(shopCard(shopper, d.cap)).toContainText("$22.00");
    // Shop A wasn't published: its tee is still from $20.
    await shopper.goto(shopUrl(d.shopA.subdomain) + "/");
    await expect(shopCard(shopper, d.tee)).toContainText("from $20.00");

    // Closed without "Save this rule": the rule typed in the window wasn't kept.
    await dlg.getByRole("button", { name: "Close" }).first().click();
    await expect(dlg).toHaveCount(0);
    expect(await brandPriceOf(api, d.brand)).toBeNull();
  } finally {
    await dropBrand(api, d.brand);
  }
});

test("Save this rule keeps the rule on Brand rules, and a blank's MAP changed on Inventory shows in After", async ({ page, api }) => {
  const d = await mapSetup(api, "Rule");
  try {
    let dlg = await openImpact(page);
    const rule = brandRule(dlg, d.brand);
    await rule.amount.fill("5");
    await rule.unit.selectOption("dollars");
    expect(await figures(piRow(dlg, d.tee, "L"))).toEqual(["$23.00", "$17.00", "−$6.00"]);
    await dlg.getByRole("button", { name: "Save this rule" }).click();
    await expect(toast(page)).toContainText("Price rule saved.");
    await expect(dlg).toHaveCount(0);
    expect(await brandPriceOf(api, d.brand)).toEqual({ brand: d.brand, add: 5, unit: "amount" });
    // Brand rules lists it, and the window opens with it.
    const row = page.locator(".br-prow").filter({ has: page.locator(`input.br-pbrand[value="${d.brand}"]`) });
    await expect(row.getByRole("spinbutton", { name: "Amount over MAP" })).toHaveValue("5");
    await expect(row.getByRole("combobox", { name: "Dollars or percent" })).toHaveValue("amount");

    // The blank's L MAP raised to $15 on Inventory → Blanks → Edit: After for L follows (MAP $15 + $5).
    await openAdmin(page, "inventory");
    await page.getByRole("searchbox", { name: /Search name, vendor/ }).fill(d.blank);
    await page.getByRole("row", { name: new RegExp(d.blank) }).getByRole("button", { name: "Edit" }).click();
    const edit = page.getByRole("dialog", { name: "Edit blank" });
    await edit.locator('tr:has([data-sf=size][value="L"])').getByRole("spinbutton", { name: "MAP" }).fill("15");
    await edit.getByRole("button", { name: "Save changes" }).click();
    await expect(edit).toHaveCount(0);
    dlg = await openImpact(page);
    await expect(brandRule(dlg, d.brand).amount).toHaveValue("5");
    expect(await figures(piRow(dlg, d.tee, "L"))).toEqual(["$23.00", "$20.00", "−$3.00"]);
    await expect(piRow(dlg, d.tee, "L")).toContainText("L MAP $15.00");
    expect(await figures(piRow(dlg, d.tee, "S"))).toEqual(["$20.00", "$15.00", "−$5.00"]);
    // Nothing was applied by any of it.
    expect(await pricesOf(api, d.shopA)).toEqual({ S: 20, M: 21, L: 23 });

    // The tee's price calculator starts from the saved rule, worked out from the linked sizes' MAPs.
    await openAdmin(page, "catalog/orgs/" + d.shopA.orgId + "/products/" + d.shopA.products[0].productId + "/edit");
    await expect(page.locator("#blankLinksSection")).not.toContainText("Loading blank links");
    await page.getByText("Work out the prices from the blank's cost or MAP…").click();
    const calc = page.locator("#priceCalcBody");
    await expect(calc).toContainText(`Your price rule for ${d.brand}: MAP + $5.00 (Catalog → Brand rules)`);
    await calc.getByRole("button", { name: "Fill in the prices" }).click();
    await expect(calc).toContainText("Filled in 3 prices — check them, then Save changes.");
    // MAP + $5, rounded up to .99 (the calculator's own default): S and M on a $10 MAP, L on the new $15.
    for (const [z, v] of [["S", "15.99"], ["M", "15.99"], ["L", "20.99"]]) await expect(page.locator("#prodFormSize-" + z)).toHaveValue(v);
    await leaveAdmin(page);
    expect(await pricesOf(api, d.shopA)).toEqual({ S: 20, M: 21, L: 23 });
  } finally {
    await dropBrand(api, d.brand);
  }
});

test("a Manager may apply the window's prices but not save its rule; Read only only looks, and can't apply", async ({ api, as }, testInfo) => {
  const d = await mapSetup(api, "Roles");
  try {
    // Manager: Brand rules is read-only (Brand rules: Read), but applying prices is theirs (Brand approvals: Full).
    const manager = await as("manager");
    await openAdmin(manager, "brandrules");
    await expect(manager.getByText("Only an admin can change these.")).toBeVisible();
    await expect(manager.locator("#brPriceAdd")).toBeDisabled();
    let dlg = await openImpact(manager);
    await expect(dlg.getByRole("button", { name: "Save this rule" })).toHaveCount(0);
    await brandRule(dlg, d.brand).amount.fill("12");
    const S = piRow(dlg, d.tee, "S");
    expect(await figures(S)).toEqual(["$20.00", "$22.00", "+$2.00"]);
    await tickOnly(dlg, [S]);
    await dlg.getByRole("button", { name: "Apply 1 price…" }).click();
    await manager.getByRole("dialog", { name: "Apply 1 new price in 1 shop?" }).getByRole("button", { name: "Apply prices" }).click();
    await expect(dlg.locator("#piDone")).toContainText("Applied 1 price in 1 shop.");
    expect(await pricesOf(api, d.shopA)).toEqual({ S: 22, M: 21, L: 23 });

    // Read only: the window shows the prices and follows a rule typed in it, with nothing to tick, save or apply.
    const viewer = await as("viewer");
    dlg = await openImpact(viewer);
    await expect(dlg.getByRole("button", { name: "Save this rule" })).toHaveCount(0);
    await expect(dlg.getByRole("button", { name: /^Apply/ })).toHaveCount(0);
    await expect(dlg.getByRole("checkbox", { name: "Tick every price that would change" })).toHaveCount(0);
    await brandRule(dlg, d.brand).amount.fill("12");
    const vL = piRow(dlg, d.tee, "L");
    expect(await figures(vL)).toEqual(["$23.00", "$24.00", "+$1.00"]);
    await expect(vL.getByRole("checkbox")).toHaveCount(0);
    await dlg.getByRole("button", { name: "Close" }).first().click();
    await expect(dlg).toHaveCount(0);
    // …and the server refuses Read only the apply itself.
    const ctx = await apiContext("viewer", testInfo.workerIndex);
    try {
      const r = await callApi(ctx, "applyRulePrices", { changes: [{ org: d.shopA.orgId, productId: d.shopA.products[0].productId, group: "", size: "L", price: 24 }] }, { allowError: true, withStatus: true });
      expect(r.status).toBe(403);
    } finally { await ctx.dispose(); }
    expect(await pricesOf(api, d.shopA)).toEqual({ S: 22, M: 21, L: 23 });
  } finally {
    await dropBrand(api, d.brand);
  }
});

test("a product of a restricted brand takes the supplier's logo approval, for itself and another product, and it can be revoked", async ({ page, api, as }) => {
  const brand = uniq("Test Logo Co");
  const blankId = (await api("createBlank", { name: uniq("Logo Blank"), productType: "shirt", vendor: "", brand, sku: "", notes: "", color: "Navy",
    colors: [{ color: "Navy", images: [], sizes: [{ size: "M", quantity: 3, vendorPrice: 4 }] }] })).id;
  const shop = await makeShop(api, { prefix: "logo", products: [{ name: uniq("Logo Tee"), price: 20, idPrefix: "logotee" }, { name: uniq("Logo Polo"), price: 30, idPrefix: "logopolo" }] });
  const [tee, polo] = shop.products;
  for (const p of [tee, polo]) await api("saveBlankLinks", { org: shop.orgId, productId: p.productId, remove: [], set: [{ productColor: "", productSize: "OSFA", blankId, blankColor: "Navy", blankSize: "M" }] });
  try {
    // The brand made restricted on Brand rules (+ Add brand, Save).
    await openAdmin(page, "brandrules");
    await page.getByRole("button", { name: "+ Add brand" }).click();
    await page.locator(".br-row").last().locator(".br-brand").fill(brand);
    await page.locator("#brSave").click();
    await expect(toast(page)).toContainText("Brand rules saved.");

    // The tee's form: the approval box, with none on file.
    await openAdmin(page, "catalog/orgs/" + shop.orgId + "/products/" + tee.productId + "/edit");
    const box = page.locator("#prodFormBrandApprovals");
    await expect(box).toContainText(`Supplier logo approval (${brand})`);
    await expect(box).toContainText("None on file — a large order of this product can't be ordered from the supplier here until it's added");
    await box.getByRole("button", { name: "+ Add approval…" }).click();
    const add = page.getByRole("dialog", { name: "Add the supplier's logo approval" });
    await expect(add.getByRole("combobox", { name: "Brand" })).toHaveValue(brand);
    // The supplier's file is required.
    await add.getByRole("spinbutton", { name: /Approved up to/ }).fill("50");
    await add.getByRole("textbox", { name: "Note" }).fill("Invented approval for the end-to-end suite");
    await add.getByRole("button", { name: "Save approval" }).click();
    await expect(add.locator("#baErr")).toHaveText("Attach the supplier's approval.");
    await add.locator("#baFile").setInputFiles({ name: "approval.png", mimeType: "image/png", buffer: pngBytes(40, 40) });
    // The same logo on the shop's polo.
    await add.getByText(/^Same logo on other products of this shop\? \(1\)/).click();
    await add.getByRole("checkbox", { name: polo.name }).check();
    const approvedOn = await add.locator("#baDate").inputValue();
    await add.getByRole("button", { name: "Save approval" }).click();
    await expect(toast(page)).toContainText("Approval saved for 2 products.");
    await expect(add).toHaveCount(0);
    const item = box.locator(".ba-item");
    await expect(item).toHaveCount(1);
    await expect(item).toContainText(`${brand} — approved ${approvedOn}, up to 50 · Invented approval for the end-to-end suite`);
    await expect(item.getByRole("button", { name: "📎 View" })).toBeVisible();
    // The polo has it too.
    const poloList = (await api("listBrandApprovals", { org: shop.orgId, productId: polo.productId })).approvals;
    expect(poloList.map(a => [a.brand, a.maxQty, a.revokedAt || null])).toEqual([[brand, 50, null]]);

    // Back office sees it, with no Add or Revoke; Read only sees it on a locked form.
    for (const role of ["staff", "viewer"]) {
      const other = await as(role);
      await openAdmin(other, "catalog/orgs/" + shop.orgId + "/products/" + tee.productId + "/edit");
      const b = other.locator("#prodFormBrandApprovals");
      await expect(b.locator(".ba-item")).toContainText(`${brand} — approved ${approvedOn}, up to 50`);
      await expect(b.getByRole("button", { name: "+ Add approval…" })).toHaveCount(0);
      await expect(b.getByRole("button", { name: "Revoke…" })).toHaveCount(0);
    }

    // Revoke…: the window asks why (labelled optional), and the server wants a reason.
    await item.getByRole("button", { name: "Revoke…" }).click();
    let ask = page.getByRole("dialog", { name: "Revoke this approval?" });
    await expect(ask).toContainText("Supplier ordering for this brand will need a new approval.");
    await ask.getByRole("button", { name: "Revoke" }).click();
    await expect(toast(page)).toContainText("Say why it's being revoked.");
    await expect(item.getByRole("button", { name: "Revoke…" })).toBeVisible();
    await item.getByRole("button", { name: "Revoke…" }).click();
    ask = page.getByRole("dialog", { name: "Revoke this approval?" });
    await ask.getByRole("textbox", { name: "Why (optional)" }).fill("Wrong logo version");
    await ask.getByRole("button", { name: "Revoke" }).click();
    await expect(toast(page)).toContainText("Approval revoked.");
    await expect(item).toContainText(/revoked \S+: Wrong logo version/);
    await expect(item.getByRole("button", { name: "Revoke…" })).toHaveCount(0);
    // Only the tee's is revoked; the polo's stands.
    expect((await api("listBrandApprovals", { org: shop.orgId, productId: tee.productId })).approvals.every(a => a.revokedAt)).toBe(true);
    expect((await api("listBrandApprovals", { org: shop.orgId, productId: polo.productId })).approvals.some(a => !a.revokedAt)).toBe(true);
  } finally {
    await dropBrand(api, brand);
  }
});
