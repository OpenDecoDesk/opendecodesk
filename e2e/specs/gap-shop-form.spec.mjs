// Shop settings (#catalog/orgs/<shop>/edit — public/admin.js renderOrgForm, drawOrgDeliveryList_, loadOrgTierBox_,
// submitOrgForm; coverage gap: shops.spec only changes the description there). What's checked:
//
// - The form opens with the shop as saved: name, fixed shop ID, web address, payments, and the delivery & pickup list
//   (Local pickup "Free", a custom option with its name and fee, ↑ on the first and ↓ on the last disabled).
// - The delivery list is edited in place: rename and re-price a custom option, + Custom option (its name box takes
//   the focus), ↑/↓ to reorder, Remove (and + Local pickup comes back), + Shipping (a "Variable" row, then removed
//   again; carrier rates can't be priced here). Name, small heading, accent, description,
//   payments and an order deadline change with it. Save is a draft: Manage catalog says "Unpublished changes" and
//   shoppers see the old shop until Publish, then the new name, heading, delivery choices (in the new order, with
//   their fees), payment methods and the deadline countdown.
// - A deadline that has passed, with late orders not allowed: the storefront shows the shop's closed text and no
//   catalog; allowing late orders again brings the catalog back under a "Deadline was …" note.
// - Bad input is refused with a message in the form and nothing saved: a web address with capitals or a dash, a
//   reserved one, another shop's (known to the page, or made by someone else after the page loaded — the server's
//   answer), a bad accent colour, an image address that isn't http(s) (the form's check) or has characters the server
//   refuses (the server's), the delivery list's problems (no options, a custom option with no name, two with the
//   same name, a fee over 1000). Two answers look wrong and are marked test.fail: an empty name is saved, and a
//   refused tax exemption still saves the rest of the form.
// - The Reorder QR code & option prices box saves the tier prices on its own button.
//
// Every test makes its own shop(s) with the owner's API (unique names); the thing tested is done through the page.
import { test, expect, openAdmin, uniq, slug, shopUrl, waitIdle } from "../fixtures.mjs";
import { makeShop } from "../lib/data.mjs";

// ---- helpers ---------------------------------------------------------------------------------------------
const editShop = async (page, shop) => {
  await openAdmin(page, "catalog/orgs/" + shop.orgId + "/edit");
  await expect(page.getByRole("heading", { name: "Shop settings", level: 2 })).toBeVisible();
};
const field = (page, label) => page.getByRole("textbox", { name: label });
const delivery = (page) => page.locator("#orgFormDelivery");
const dlvRows = (page) => delivery(page).locator("tbody tr[data-dlv-row]");
const dlvRow = (page, i) => delivery(page).locator(`tr[data-dlv-row="${i}"]`);
const formError = (page) => page.locator("#orgFormError");
const save = (page) => page.getByRole("button", { name: "Save changes" }).click();
const orgOf = async (api, orgId) => (await api("listOrgsAdmin")).orgs.find(o => o.orgId === orgId);
// What the rows of the delivery list say: "Local pickup | Free", or a custom row's typed name and fee.
const dlvRowsText = (page) => dlvRows(page).evaluateAll(rows => rows.map(r => {
  const label = r.querySelector(".dlv-label"), fee = r.querySelector(".dlv-fee");
  return (label ? label.value : r.cells[0].innerText.trim()) + " | " + (fee ? fee.value : r.cells[1].innerText.trim());
}));
const dayInDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const longDate = (ymd) => new Date(ymd + "T12:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
const publishFromCatalog = async (page, shop) => {
  const row = page.locator("tr", { hasText: shop.orgId });
  await row.getByRole("button", { name: "Publish" }).click();
  await expect(page.locator("tr", { hasText: shop.orgId })).toContainText("✓ Published");
};

// ---- The form, the delivery list, draft until Publish, the storefront ------------------------------------
test("Shop settings: edit name, look, delivery options and payments; a draft until Publish, then the storefront shows them", async ({ page, api, as }) => {
  const shop = await makeShop(api, { prefix: "shopform", products: [{ name: uniq("Form Tee"), price: 18 }] });
  await editShop(page, shop);

  // As saved.
  await expect(field(page, "Name *")).toHaveValue(shop.name);
  await expect(field(page, "Shop ID *")).toHaveValue(shop.orgId);
  await expect(field(page, "Shop ID *")).toBeDisabled();
  await expect(field(page, "Web address *")).toHaveValue(shop.subdomain);
  await expect(page.getByLabel("Ready (live storefront")).toBeChecked();
  await expect(page.getByLabel("Credit / Debit Card")).not.toBeChecked();
  for (const m of ["Venmo", "Zelle", "Check"]) await expect(page.getByLabel(m, { exact: true })).toBeChecked();
  await expect.poll(() => dlvRowsText(page)).toEqual(["Local pickup | Free", "Local delivery | 5.00"]);
  await expect(dlvRow(page, 0).getByRole("button", { name: "Move up" })).toBeDisabled();
  await expect(dlvRow(page, 1).getByRole("button", { name: "Move down" })).toBeDisabled();
  await expect(delivery(page).getByRole("button", { name: "+ Local pickup" })).toHaveCount(0);
  await expect(delivery(page).getByRole("button", { name: "+ Custom option" })).toBeEnabled();
  // + Shipping (the Shipping feature is on in this install, the country US): a "Variable" row and a note about weights;
  // only one; Remove takes it off again.
  await expect(page.locator("#orgDeliveryFeatureNote")).toHaveCount(0);
  await delivery(page).getByRole("button", { name: "+ Shipping" }).click();
  await expect.poll(() => dlvRowsText(page)).toEqual(["Local pickup | Free", "Local delivery | 5.00", "Shipping — carrier rates for the customer's ZIP | Variable"]);
  await expect(delivery(page)).toContainText("Shipping needs a weight on every visible product, and the customer's ZIP to price it.");
  await expect(delivery(page).getByRole("button", { name: "+ Shipping" })).toHaveCount(0);
  await dlvRow(page, 2).getByRole("button", { name: "Remove" }).click();
  await expect(dlvRows(page)).toHaveCount(2);
  await expect(delivery(page).getByRole("button", { name: "+ Shipping" })).toBeEnabled();
  // No automatic domain setup here: the box says what to do instead.
  await expect(page.locator("#orgDomainBox")).toContainText("Automatic domain setup isn't configured — add " + shop.subdomain + ".localhost");

  // Edit. The look:
  const newName = uniq("Renamed Club");
  await field(page, "Name *").fill(newName);
  await field(page, "Small heading above the name (optional)").fill("Spring order");
  await page.locator("#orgFormAccent").fill("#aa3300");
  await expect(page.locator("#orgFormAccentPick")).toHaveValue("#aa3300");
  await field(page, "Description").fill("Spring kit for the club — new colours.");
  // The delivery list: rename and re-price the custom option, add a free one (its name box gets the focus), move it
  // to the top, and take Local pickup off.
  await dlvRow(page, 1).getByRole("textbox", { name: "Name of this delivery option" }).fill("Delivered at practice");
  await dlvRow(page, 1).getByRole("spinbutton", { name: "Fee for this delivery option" }).fill("3");
  await delivery(page).getByRole("button", { name: "+ Custom option" }).click();
  await expect(dlvRows(page)).toHaveCount(3);
  const newLabel = dlvRow(page, 2).getByRole("textbox", { name: "Name of this delivery option" });
  await expect(newLabel).toBeFocused();
  await newLabel.fill("Club night drop-off");
  await dlvRow(page, 2).getByRole("button", { name: "Move up" }).click();
  await dlvRow(page, 1).getByRole("button", { name: "Move up" }).click();
  // What was typed survives the redraws.
  await expect.poll(() => dlvRowsText(page)).toEqual(["Club night drop-off | ", "Local pickup | Free", "Delivered at practice | 3.00"]);
  await dlvRow(page, 1).getByRole("button", { name: "Remove" }).click();
  await expect.poll(() => dlvRowsText(page)).toEqual(["Club night drop-off | ", "Delivered at practice | 3.00"]);
  await expect(delivery(page).getByRole("button", { name: "+ Local pickup" })).toBeVisible();
  // ↓ then ↑ puts it back where it was.
  await dlvRow(page, 0).getByRole("button", { name: "Move down" }).click();
  await expect.poll(() => dlvRowsText(page)).toEqual(["Delivered at practice | 3.00", "Club night drop-off | "]);
  await dlvRow(page, 1).getByRole("button", { name: "Move up" }).click();
  await expect.poll(() => dlvRowsText(page)).toEqual(["Club night drop-off | ", "Delivered at practice | 3.00"]);
  // Payments and a deadline 20 days out.
  await page.getByLabel("Venmo", { exact: true }).uncheck();
  const deadline = dayInDays(20);
  await page.getByLabel("Order deadline (optional)").fill(deadline);

  await save(page);
  await expect(page).toHaveURL(/#catalog$/);
  await expect(page.locator("tr", { hasText: shop.orgId })).toContainText("Unpublished changes");
  // Saved: the server has the new settings (custom options with their fees, in this order).
  const saved = await orgOf(api, shop.orgId);
  expect(saved.name).toBe(newName);
  expect(saved.eyebrow).toBe("Spring order");
  expect(saved.accent).toBe("#aa3300");
  expect(saved.deliveryOptions.map(o => [o.type, o.label, o.fee])).toEqual([["custom", "Club night drop-off", 0], ["custom", "Delivered at practice", 3]]);
  expect(saved.enabledPayments).toMatchObject({ card: false, venmo: false, zelle: true, check: true });
  expect(String(saved.orderDeadline).slice(0, 10)).toBe(deadline);

  // Shoppers still see the published shop.
  const shopper = await as(null);
  await shopper.goto(shopUrl(shop.subdomain) + "/");
  await expect(shopper.getByRole("heading", { level: 1 })).toHaveText(shop.name);
  await expect(shopper.getByRole("radio", { name: /^Local pickup/ })).toBeVisible();
  await expect(shopper.locator(".deadline-banner")).toHaveCount(0);

  await publishFromCatalog(page, { ...shop });
  await shopper.reload();
  await expect(shopper.getByRole("heading", { level: 1 })).toHaveText(newName);
  await expect(shopper.locator(".org-eyebrow-lg")).toHaveText("Spring order");
  await expect(shopper.locator("main")).toContainText("Spring kit for the club — new colours.");
  // The delivery choices in the saved order, with their fees; no pickup any more.
  const radios = shopper.getByRole("radio");
  await expect(radios).toHaveCount(2);
  await expect(radios.nth(0)).toHaveAccessibleName(/^Club night drop-off/);
  await expect(radios.nth(1)).toHaveAccessibleName(/^Delivered at practice — \$3\.00/);
  await expect(shopper.getByRole("radio", { name: /^Local pickup/ })).toHaveCount(0);
  const pay = shopper.getByLabel("Payment method");
  await expect(pay.locator("option", { hasText: "Venmo" })).toHaveCount(0);
  await expect(pay.locator("option", { hasText: "Zelle" })).toHaveCount(1);
  await expect(pay.locator("option", { hasText: "Check" })).toHaveCount(1);
  // 20 days by the calendar here (UTC); the shopper's page counts to the end of that day in its own time zone.
  await expect(shopper.locator(".deadline-banner")).toContainText(/\b(20|21|22) days left\b/);
  await expect(shopper.locator(".deadline-banner")).toContainText("Ordering closes " + longDate(deadline) + ".");

  // Opened again, the form shows what was saved.
  await editShop(page, { ...shop });
  await expect(field(page, "Name *")).toHaveValue(newName);
  await expect.poll(() => dlvRowsText(page)).toEqual(["Club night drop-off | ", "Delivered at practice | 3.00"]);
  await expect(page.getByLabel("Venmo", { exact: true })).not.toBeChecked();
  await expect(page.getByLabel("Order deadline (optional)")).toHaveValue(deadline);
});

test("a passed deadline with late orders off shows the closed text and no catalog; allowing late orders brings it back", async ({ page, api, as }) => {
  const shop = await makeShop(api, { prefix: "closedform", products: [{ name: uniq("Late Tee"), price: 18 }] });
  const past = dayInDays(-3);
  await editShop(page, shop);
  await page.getByLabel("Order deadline (optional)").fill(past);
  await field(page, "Text shown when closed (optional)").fill("Orders for this season have closed.");
  await page.getByLabel("Allow orders to be placed after the deadline").uncheck();
  await save(page);
  await expect(page).toHaveURL(/#catalog$/);
  await publishFromCatalog(page, shop);
  const saved = await orgOf(api, shop.orgId);
  expect(saved.allowOrdersAfterDeadline).toBe(false);
  expect(saved.closedMessage).toBe("Orders for this season have closed.");

  const shopper = await as(null);
  await shopper.goto(shopUrl(shop.subdomain) + "/");
  await expect(shopper.getByRole("heading", { level: 1 })).toHaveText(shop.name);
  const banner = shopper.locator(".deadline-banner");
  await expect(banner).toHaveText("Closed " + longDate(past) + " Orders for this season have closed.");
  await expect(shopper.getByRole("button", { name: "Add to cart" })).toHaveCount(0);
  await expect(shopper.locator("#catalogArea")).toHaveCount(0);

  await editShop(page, shop);
  await expect(page.getByLabel("Allow orders to be placed after the deadline")).not.toBeChecked();
  await expect(field(page, "Text shown when closed (optional)")).toHaveValue("Orders for this season have closed.");
  await page.getByLabel("Allow orders to be placed after the deadline").check();
  await save(page);
  await expect(page).toHaveURL(/#catalog$/);
  await publishFromCatalog(page, shop);
  await shopper.reload();
  await expect(banner).toHaveText("Deadline was " + longDate(past) + " Orders for this season have closed. Late orders are still being accepted.");
  await expect(shopper.getByRole("button", { name: "Add to cart" })).toBeVisible();
});

// ---- Bad input ---------------------------------------------------------------------------------------------
test("Shop settings refuses a bad, reserved or taken web address with a message, and saves nothing", async ({ page, api }) => {
  const shop = await makeShop(api, { prefix: "badaddr" });
  const other = await makeShop(api, { prefix: "takenaddr" });
  const before = await orgOf(api, shop.orgId);
  await editShop(page, shop);
  const refused = async (value, message) => {
    await field(page, "Web address *").fill(value);
    await save(page);
    await expect(formError(page)).toHaveText(message);
    await expect(page).toHaveURL(/\/edit$/);
  };
  await refused("Bad-Address", "The web address needs 2–40 lowercase letters or numbers (no spaces or dashes).");
  await refused("x", "The web address needs 2–40 lowercase letters or numbers (no spaces or dashes).");
  await refused("admin", "“admin” is reserved — pick another web address.");
  await refused("www", "“www” is reserved — pick another web address.");
  await refused(other.subdomain, "Another shop already uses the web address “" + other.subdomain + "”.");
  // A shop made after this page loaded (someone else, another tab): the page doesn't know it; the server refuses.
  const late = await makeShop(api, { prefix: "lateaddr", publish: false });
  await refused(late.subdomain, "Another shop already uses the web address “" + late.subdomain + "”.");
  // Nothing was saved.
  expect((await orgOf(api, shop.orgId)).subdomain).toBe(before.subdomain);
  // A free address of its own is fine.
  const fresh = slug("freeaddr");
  await field(page, "Web address *").fill(fresh);
  await save(page);
  await expect(page).toHaveURL(/#catalog$/);
  expect((await orgOf(api, shop.orgId)).subdomain).toBe(fresh);
});

test("Shop settings refuses a bad accent colour, a non-web image address and every delivery-list problem", async ({ page, api }) => {
  const shop = await makeShop(api, { prefix: "badform" });
  const before = await orgOf(api, shop.orgId);
  await editShop(page, shop);
  const refused = async (message) => {
    await save(page);
    await expect(formError(page)).toHaveText(message);
    await expect(page).toHaveURL(/\/edit$/);
  };
  await page.locator("#orgFormAccent").fill("not-a-colour");
  await refused("Accent must be a valid CSS color (e.g. #1E7A4C, navy, rgb(30,122,76)).");
  await page.locator("#orgFormAccent").fill("navy");
  await page.locator("#orgFormImgShirt").fill("ftp://images.example.test/crest.png");
  await refused("Image URLs must start with http:// or https://");
  // An https address with a character the server won't store: the form lets it through, the server refuses it.
  await page.locator("#orgFormImgShirt").fill("https://images.example.test/crest<1>.png");
  await refused("Image URLs must start with https:// (or be a site path like images/foo.jpg).");
  await page.locator("#orgFormImgShirt").fill("");

  // The delivery list. A custom option with no name:
  await delivery(page).getByRole("button", { name: "+ Custom option" }).click();
  await refused("Give each custom delivery option a name.");
  // Two with the same name (any case):
  await dlvRow(page, 2).getByRole("textbox", { name: "Name of this delivery option" }).fill("local DELIVERY");
  await refused('Two delivery options are both named "local DELIVERY".');
  // A fee over 1000:
  await dlvRow(page, 2).getByRole("textbox", { name: "Name of this delivery option" }).fill("Courier");
  await dlvRow(page, 2).getByRole("spinbutton", { name: "Fee for this delivery option" }).fill("2000");
  await refused('The fee for "Courier" must be a number from 0 to 1000 (0 = free).');
  // None at all: the list says so, and so does Save.
  for (let i = 0; i < 3; i++) await dlvRow(page, 0).getByRole("button", { name: "Remove" }).click();
  await expect(dlvRows(page)).toHaveCount(0);
  await expect(delivery(page)).toContainText("No options yet — add at least one before saving.");
  await refused("Add at least one delivery or pickup option.");

  // Nothing of it was saved.
  const after = await orgOf(api, shop.orgId);
  expect(after.accent).toBe(before.accent);
  expect(after.deliveryOptions).toEqual(before.deliveryOptions);
  // + Local pickup puts a valid list back; Save works.
  await delivery(page).getByRole("button", { name: "+ Local pickup" }).click();
  await save(page);
  await expect(page).toHaveURL(/#catalog$/);
  const saved = await orgOf(api, shop.orgId);
  expect(saved.accent).toBe("navy");
  expect(saved.deliveryOptions.map(o => o.type)).toEqual(["pickup"]);
});

test("Shop settings refuses an empty name", async ({ page, api }) => {
  // BUG: submitOrgForm (public/admin.js ~11731) never checks the name, and updateOrg (functions/api/orders.js ~3459)
  // saves whatever comes — createOrg refuses a missing name, updateOrg doesn't, so a shop can be left nameless.
  test.fail(true, "BUG: an empty shop name is saved (updateOrg has no name check)");
  const shop = await makeShop(api, { prefix: "noname" });
  await editShop(page, shop);
  await field(page, "Name *").fill("   ");
  await save(page);
  await waitIdle(page);
  // Today the form saves it and goes back to Manage catalog, and the shop's name is "". The name is put back first
  // (a nameless shop would show as a blank entry in every shop list the other specs open).
  const after = await orgOf(api, shop.orgId);
  if (after.name !== shop.name) {
    await api("updateOrg", { orgId: shop.orgId, subdomain: after.subdomain, name: shop.name, eyebrow: after.eyebrow, accent: after.accent,
      desc: after.desc, ready: after.ready, enabledPayments: after.enabledPayments, allowOrdersAfterDeadline: after.allowOrdersAfterDeadline !== false });
  }
  expect(after.name, "the shop's name after saving an empty one").toBe(shop.name);
  await expect(page).toHaveURL(/\/edit$/);
  await expect(formError(page)).not.toBeEmpty();
});

test("a refused tax exemption saves nothing else of the form", async ({ page, api }) => {
  // BUG: updateOrg (functions/api/orders.js ~3500) writes the shop's settings, delivery and rush fee first and only then
  // checks the exemption certificate: the form shows the error, yet the rest of what was typed is already saved.
  test.fail(true, "BUG: updateOrg saves the form before refusing a tax exemption with no certificate");
  const shop = await makeShop(api, { prefix: "taxform" });   // tax-exempt, with a certificate
  await editShop(page, shop);
  await field(page, "Description").fill("Changed together with a refused exemption.");
  await field(page, "Exemption certificate #").fill("");
  await save(page);
  await expect(formError(page)).toHaveText("A tax-exempt org needs its exemption certificate number");
  await expect(page).toHaveURL(/\/edit$/);
  expect((await orgOf(api, shop.orgId)).desc).toBe("A shop made by the end-to-end suite.");
});

// ---- Reorder QR code & option prices -------------------------------------------------------------------------
test("the Reorder QR code & option prices box saves the tier prices on its own", async ({ page, api }) => {
  const shop = await makeShop(api, { prefix: "tierform" });
  await editShop(page, shop);
  const box = page.locator("#orgTierBox");
  await expect(box).toContainText("Option tier prices");
  await expect(box.getByLabel("Small ($)")).toHaveValue("1.00");
  await expect(box.getByLabel("Medium ($)")).toHaveValue("2.00");
  await expect(box.getByLabel("Large ($)")).toHaveValue("4.00");
  await box.getByLabel("Small ($)").fill("1.50");
  await box.getByLabel("Medium ($)").fill("2.75");
  await box.getByLabel("Large ($)").fill("5");
  await box.getByRole("button", { name: "Save reorder QR & prices" }).click();
  await expect(box.locator("#otpStatus")).toHaveText("Saved.");
  // Redrawn from the server.
  await expect(box.getByLabel("Large ($)")).toHaveValue("5.00");
  const r = await api("listGraphics", { org: shop.orgId });
  expect(r.tiersCents).toEqual({ small: 150, medium: 275, large: 500 });
  // Opened again, the box shows the saved prices.
  await editShop(page, shop);
  await expect(box.getByLabel("Medium ($)")).toHaveValue("2.75");
});
