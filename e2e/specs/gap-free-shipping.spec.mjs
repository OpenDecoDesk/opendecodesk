// Inventory → Blanks to order: a vendor's free shipping and "Get me to free shipping" (admin.js freeShipHeaderHtml_,
// showFreeShipping_, fillToFreeShipping_, restockOrdersHtml_; orders.js getBlanksToOrder, freeShippingSuggestions,
// saveVendor, recordRestockOrder, cancelRestockOrder). No e2e test opened the free-shipping window before.
// Free shipping here is what a blank VENDOR charges the business: set on the vendor (over a dollar amount or at a
// piece count, or "no free shipping"), measured against the restock order Blanks to order builds. It isn't a
// storefront setting: nothing on a shop's cart or checkout reads it.
// Each test makes its own vendor (a unique made-up name) and its own blank of that vendor, with a reorder point above
// what's on hand, so the vendor has its own block on the shared Blanks to order page; nothing install-wide changes.
// Vendor connections (ordering through a supplier's web service, Look up on <vendor>) need a real supplier and
// aren't here.
import fs from "node:fs";
import { test, expect, openAdmin, toast, uniq, slug } from "../fixtures.mjs";

// ---- helpers ---------------------------------------------------------------------------------------------
// A vendor of blanks (free shipping as given) and one blank of it: Navy M with 2 on hand and "keep at least 5" (so
// Blanks to order suggests a restock of 3), Navy L with none and no reorder point; both $4.50 from the vendor.
const vendorWithBlank = async (api, freeShipping = {}) => {
  const vendor = uniq("Sample Supply");
  const saved = await api("saveVendor", { vendor: { name: vendor, forBlanks: true, ...freeShipping } });
  const sku = ("E2E-" + slug("fs")).toUpperCase().slice(0, 20);
  const blank = uniq("Free Ship Tee");
  const r = await api("createBlank", {
    name: blank, productType: "shirt", vendor, brand: "Test Blank Co", sku, notes: "", color: "Navy",
    colors: [{ color: "Navy", images: [], sizes: [{ size: "M", quantity: 2, vendorPrice: 4.5, reorderPoint: 5 }, { size: "L", quantity: 0, vendorPrice: 4.5 }] }],
  });
  return { vendor, vendorId: saved.vendor.id, blank, blankId: r.id, sku };
};
const blanksToOrder = async (page) => {
  await openAdmin(page, "blankorder");
  await expect(page.locator("#btoBody")).not.toContainText("Loading");
};
const block = (page, vendor) => page.locator(`.bto-supplier[data-supplier="${vendor}"]`);
const freeHeader = (page, vendor) => block(page, vendor).locator(".bto-fs");
const fsWindow = (page, vendor) => page.getByRole("dialog", { name: "Get me to free shipping — " + vendor });
const vendorWindow = (page, vendor) => page.getByRole("dialog", { name: "Edit vendor — " + vendor });
const vendorNow = async (api, id) => (await api("listVendors", {})).vendors.find(v => v.id === id);

// ---- the vendor's free shipping on Blanks to order ----------------------------------------------------------
test("Set free shipping… on a vendor's block: the header shows what's still to go, the vendor list keeps it, and No free shipping turns it off", async ({ page, api }) => {
  const { vendor, vendorId, blank } = await vendorWithBlank(api);
  await blanksToOrder(page);
  // The block: the blank's restock (3 of size M, $13.50), and no free shipping set yet.
  const b = block(page, vendor);
  await expect(b.getByRole("heading", { name: vendor })).toBeVisible();
  const line = b.locator("tbody tr", { hasText: blank });
  await expect(line).toHaveCount(1);
  await expect(line.locator(".bto-rs-qty")).toHaveValue("3");
  await expect(b.locator(".bto-supplier-total")).toHaveText("$13.50");
  await expect(freeHeader(page, vendor)).toHaveCount(0);
  await expect(b.getByRole("button", { name: "Get me to free shipping" })).toHaveCount(0);

  // Set it: free at $50.
  await b.getByRole("button", { name: "Set free shipping…" }).click();
  const dlg = vendorWindow(page, vendor);
  await expect(dlg).toBeVisible();
  await expect(dlg.getByLabel("No free shipping — this vendor always charges for shipping")).not.toBeChecked();
  // A negative amount is refused in the window, by the server's own check.
  await dlg.getByLabel("Free at ($ or more)").fill("-5");
  await dlg.getByRole("button", { name: "Save changes" }).click();
  await expect(dlg.locator("#vfmErr")).toHaveText("Free shipping at ($) must be a number from 0 to 100,000.");
  // So is no name at all.
  await dlg.getByLabel("Name").fill(" ");
  await dlg.getByRole("button", { name: "Save changes" }).click();
  await expect(dlg.locator("#vfmErr")).toHaveText("Name the vendor.");
  await dlg.getByLabel("Name").fill(vendor);
  await dlg.getByLabel("Free at ($ or more)").fill("50");
  await dlg.getByRole("button", { name: "Save changes" }).click();
  await expect(toast(page)).toContainText(vendor + " saved.");
  await expect(dlg).toHaveCount(0);
  // The block now measures its order against it: $13.50 of $50.
  await expect(freeHeader(page, vendor)).toContainText("Free shipping at $50 — $36.50 to go");
  await expect(b.getByRole("button", { name: "Get me to free shipping" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Vendor to start an order for" }).locator("option", { hasText: vendor })).toHaveText(vendor + " — free at $50");
  expect((await vendorNow(api, vendorId)).freeShipping).toMatchObject({ overCents: 5000, minQty: null });

  // ✎ changes it: $50 or 3 pieces, whichever comes first — 3 pieces is already reached.
  await freeHeader(page, vendor).getByRole("button", { name: "✎" }).click();
  await expect(dlg.getByLabel("Free at ($ or more)")).toHaveValue("50.00");
  await dlg.getByLabel("…or at (pieces)").fill("3");
  await dlg.getByRole("button", { name: "Save changes" }).click();
  await expect(toast(page)).toContainText(vendor + " saved.");
  await expect(freeHeader(page, vendor)).toContainText("✓ Free shipping");
  await expect(b.getByRole("button", { name: "Get me to free shipping" })).toHaveCount(0);
  // 10 pieces is not: "$36.50 to go or 7 pieces to go".
  await freeHeader(page, vendor).getByRole("button", { name: "✎" }).click();
  await dlg.getByLabel("…or at (pieces)").fill("10");
  await dlg.getByRole("button", { name: "Save changes" }).click();
  await expect(freeHeader(page, vendor)).toContainText("Free shipping at $50 or at 10 pieces — $36.50 to go or 7 pieces to go");

  // No free shipping: the amounts can't be typed, and the block is back to "Set free shipping…".
  await freeHeader(page, vendor).getByRole("button", { name: "✎" }).click();
  await dlg.getByLabel("No free shipping — this vendor always charges for shipping").check();
  await expect(dlg.getByLabel("Free at ($ or more)")).toBeDisabled();
  await expect(dlg.getByLabel("…or at (pieces)")).toBeDisabled();
  await dlg.getByRole("button", { name: "Save changes" }).click();
  await expect(toast(page)).toContainText(vendor + " saved.");
  await expect(b.getByRole("button", { name: "Set free shipping…" })).toBeVisible();
  await expect(freeHeader(page, vendor)).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Vendor to start an order for" }).locator("option", { hasText: vendor })).toHaveText(vendor);
  const v = await vendorNow(api, vendorId);
  expect(v.noFreeShipping).toBe(true);
  expect(v.freeShipping).toBeNull();
  expect(v.freeShipOverCents).toBeNull();
  // Cancel in the vendor window changes nothing.
  await b.getByRole("button", { name: "Set free shipping…" }).click();
  await dlg.getByLabel("No free shipping — this vendor always charges for shipping").uncheck();
  await dlg.getByLabel("Free at ($ or more)").fill("75");
  await dlg.getByRole("button", { name: "Cancel" }).click();
  await expect(dlg).toHaveCount(0);
  expect((await vendorNow(api, vendorId)).noFreeShipping).toBe(true);
});

test("Back office sees the free-shipping progress and Get me to free shipping, but can't change the vendor's free shipping", async ({ api, as }) => {
  const { vendor } = await vendorWithBlank(api, { over: "50" });
  const staff = await as("staff");
  await blanksToOrder(staff);
  await expect(freeHeader(staff, vendor)).toContainText("Free shipping at $50 — $36.50 to go");
  await expect(block(staff, vendor).getByRole("button", { name: "Get me to free shipping" })).toBeVisible();
  // Changing a vendor is Full on Blanks to order: no ✎.
  await expect(freeHeader(staff, vendor).getByRole("button", { name: "✎" })).toBeHidden();
});

// ---- Get me to free shipping -----------------------------------------------------------------------------------
test("Get me to free shipping: the restock on the list, an item added until it ships free, a CSV of it, Mark as ordered…, then Cancel", async ({ page, api }) => {
  const { vendor, blank, sku } = await vendorWithBlank(api, { over: "50" });
  await blanksToOrder(page);
  await block(page, vendor).getByRole("button", { name: "Get me to free shipping" }).click();
  const dlg = fsWindow(page, vendor);
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText(vendor + " ships free at $50.");
  // The order so far: the restock of size M already on Blanks to order (3 × $4.50).
  const rows = dlg.locator("#fsLines tbody tr");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(blank);
  await expect(rows.first()).toContainText("Already in the order · Restock (keep 5)");
  await expect(rows.first()).toContainText("$13.50");
  // No sales history for this vendor's blanks: nothing more to suggest.
  await expect(dlg.locator("#fsNote")).toHaveText(`No sales history for ${vendor}'s blanks yet, so there's nothing more to suggest — add items below.`);
  const tally = dlg.locator("#fsTally");
  await expect(tally).toHaveText("Order $13.50 of $50 · 3 pieces — $36.50 to go");

  // + Add item: the vendor's blanks, found by SKU; 9 of size L ($40.50) reaches free shipping.
  await dlg.getByPlaceholder("SKU / style #, name or color").fill(sku);
  const found = dlg.locator("#fsFound tr");
  await expect(found).toHaveCount(2);
  const sizeL = found.filter({ has: page.locator("td:nth-child(4)", { hasText: /^L$/ }) });
  await sizeL.getByRole("spinbutton", { name: "Quantity" }).fill("9");
  await sizeL.getByRole("button", { name: "Add" }).click();
  await expect(rows).toHaveCount(2);
  const added = rows.nth(1);
  await expect(added).toContainText("Added");
  await expect(added.locator("[data-fs-total]")).toHaveText("$40.50");
  await expect(tally).toHaveText("Order $54.00 of $50 · 12 pieces — Free shipping ✓");
  // Fewer pieces: just short again.
  await added.getByRole("spinbutton").fill("8");
  await expect(added.locator("[data-fs-total]")).toHaveText("$36.00");
  await expect(tally).toHaveText("Order $49.50 of $50 · 11 pieces — $0.50 to go");
  // Unticked, the line doesn't count (and its quantity can't be changed).
  await added.getByRole("checkbox", { name: "Include" }).uncheck();
  await expect(added.getByRole("spinbutton")).toBeDisabled();
  await expect(tally).toHaveText("Order $13.50 of $50 · 3 pieces — $36.50 to go");
  await added.getByRole("checkbox", { name: "Include" }).check();
  await added.getByRole("spinbutton").fill("9");
  await expect(tally).toHaveText("Order $54.00 of $50 · 12 pieces — Free shipping ✓");
  // Adding the same size again adds to its line rather than making another.
  await sizeL.getByRole("spinbutton", { name: "Quantity" }).fill("1");
  await sizeL.getByRole("button", { name: "Add" }).click();
  await expect(rows).toHaveCount(2);
  await expect(added.getByRole("spinbutton")).toHaveValue("10");
  await expect(tally).toHaveText("Order $58.50 of $50 · 13 pieces — Free shipping ✓");
  await added.getByRole("spinbutton").fill("9");
  // A search with no match says so.
  await dlg.getByPlaceholder("SKU / style #, name or color").fill("no-such-style-" + sku);
  await expect(dlg.locator("#fsFound")).toHaveText("No blank on file matches.");

  // Download CSV: the ticked lines, as the vendor's order list.
  const dl = page.waitForEvent("download");
  await dlg.getByRole("button", { name: "Download CSV" }).click();
  const file = await dl;
  expect(file.suggestedFilename()).toMatch(/^order-sample-supply-[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = fs.readFileSync(await file.path(), "utf8").trim().split(/\r?\n/);
  expect(csv[0]).toBe("Style,Description,Color,Size,Qty,Unit,Total");
  expect(csv.slice(1)).toEqual([`${sku},${blank},Navy,M,3,4.5,13.5`, `${sku},${blank},Navy,L,9,4.5,40.5`]);

  // Mark as ordered…: recorded with the vendor's order number; the window closes and the page reloads.
  const ref = "PO-" + slug("r").slice(-6).toUpperCase();
  await dlg.getByRole("button", { name: "Mark as ordered…" }).click();
  const ask = page.getByRole("dialog").last();
  await expect(ask).toContainText(`Record this ${vendor} order as placed`);
  await ask.getByLabel("Vendor order # (optional)").fill(ref);
  await ask.getByRole("button", { name: "Record as placed" }).click();
  await expect(toast(page)).toContainText(`Recorded — 12 pieces of restock on order from ${vendor}.`);
  await expect(dlg).toHaveCount(0);
  // The restock is on its way: size M is no longer short, so the vendor has nothing on the list…
  await expect(block(page, vendor)).toHaveCount(0);
  // …and the order is listed under "Restock ordered by hand".
  const recorded = page.locator("#btoRestockOrders tr", { hasText: ref });
  await expect(recorded).toContainText(vendor);
  await expect(recorded).toContainText("2 lines, 12 pieces");
  const listed = (await api("getBlanksToOrder", {})).restockOrders.find(o => o.reference === ref);
  expect(listed).toMatchObject({ vendor, pieces: 12 });
  expect(listed.lines.map(l => [l.color, l.size, l.qty])).toEqual([["Navy", "M", 3], ["Navy", "L", 9]]);

  // Cancel it (it never got ordered): the restock is suggested again.
  await recorded.getByRole("button", { name: "Cancel" }).click();
  await page.locator(".confirm-modal #cmOk").click();
  await expect(toast(page)).toContainText("Restock order cancelled.");
  await expect(page.locator("#btoRestockOrders tr", { hasText: ref })).toHaveCount(0);
  await expect(block(page, vendor).locator(".bto-rs-qty")).toHaveValue("3");
  await expect(freeHeader(page, vendor)).toContainText("$36.50 to go");
  expect((await api("getBlanksToOrder", {})).restockOrders.find(o => o.reference === ref)).toBeUndefined();
});

test("Start an order for… a vendor with no free shipping builds a list without a goal; with nothing ticked there is nothing to copy or record", async ({ page, api }) => {
  const { vendor, blank } = await vendorWithBlank(api);
  await blanksToOrder(page);
  // Nothing picked yet.
  await page.locator("#btoStartBtn").click();
  await expect(toast(page)).toContainText("Pick a vendor first.");
  await page.getByRole("combobox", { name: "Vendor to start an order for" }).selectOption(vendor);
  await page.locator("#btoStartBtn").click();
  const dlg = fsWindow(page, vendor);
  await expect(dlg).toContainText(`${vendor} has no free shipping set — set it on Blanks to Order (Set free shipping…), or use this window to build an order list.`);
  // The vendor's restock is the starting point; the tally has no goal to measure against.
  await expect(dlg.locator("#fsLines tbody tr")).toHaveCount(1);
  await expect(dlg.locator("#fsLines")).toContainText(blank);
  await expect(dlg.locator("#fsTally")).toHaveText("Order $13.50 · 3 pieces");
  // Copy order list: the ticked lines, tab-separated, on the clipboard.
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await dlg.getByRole("button", { name: "Copy order list" }).click();
  await expect(toast(page)).toContainText(`Copied 1 line for ${vendor}.`);
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied.split("\n")).toEqual(["Style\tDescription\tColor\tSize\tQty\tUnit\tTotal", expect.stringMatching(new RegExp(`\\t${blank}\\tNavy\\tM\\t3\\t4\\.50\\t13\\.50$`))]);
  await dlg.getByRole("button", { name: "Close" }).click();
  await expect(dlg).toHaveCount(0);

  // A vendor with nothing on the list (its blank has no reorder point): the window starts empty, and with nothing
  // ticked, Copy, Download CSV and Mark as ordered… have nothing to use.
  const empty = uniq("Sample Supply");
  await api("saveVendor", { vendor: { name: empty, forBlanks: true } });
  await api("createBlank", { name: uniq("Plain Tee"), productType: "shirt", vendor: empty, brand: "Test Blank Co", sku: "", notes: "", color: "Navy",
    colors: [{ color: "Navy", images: [], sizes: [{ size: "M", quantity: 4, vendorPrice: 3 }] }] });
  await blanksToOrder(page);
  await page.getByRole("combobox", { name: "Vendor to start an order for" }).selectOption(empty);
  await page.locator("#btoStartBtn").click();
  const dlg2 = fsWindow(page, empty);
  await expect(dlg2.locator("#fsLines")).toHaveText("Nothing yet — add items below.");
  await expect(dlg2.locator("#fsNote")).toHaveText(`No sales history for ${empty}'s blanks yet and no reorder points set, so there's nothing more to suggest — add items below.`);
  await expect(dlg2.locator("#fsTally")).toHaveText("Order $0.00 · 0 pieces");
  for (const name of ["Copy order list", "Download CSV", "Mark as ordered…"]) {
    await dlg2.getByRole("button", { name }).click();
    await expect(toast(page)).toContainText("Nothing ticked.");
  }
  // Its own blank is found by name and added; unticked again, the order is back to nothing.
  await dlg2.getByPlaceholder("SKU / style #, name or color").fill("Plain Tee");
  await dlg2.locator("#fsFound tr").first().getByRole("button", { name: "Add" }).click();
  await expect(dlg2.locator("#fsTally")).toHaveText("Order $3.00 · 1 piece");
  await dlg2.locator("#fsLines tbody tr").first().getByRole("checkbox", { name: "Include" }).uncheck();
  await expect(dlg2.locator("#fsTally")).toHaveText("Order $0.00 · 0 pieces");
  // Mark as ordered… with the line ticked, then Cancel in the question: nothing is recorded.
  await dlg2.locator("#fsLines tbody tr").first().getByRole("checkbox", { name: "Include" }).check();
  await dlg2.getByRole("button", { name: "Mark as ordered…" }).click();
  await page.getByRole("dialog").last().getByRole("button", { name: "Cancel" }).click();
  await expect(dlg2).toBeVisible();
  expect((await api("getBlanksToOrder", {})).restockOrders.filter(o => o.vendor === empty)).toEqual([]);
  await dlg2.getByRole("button", { name: "Close" }).click();
});
