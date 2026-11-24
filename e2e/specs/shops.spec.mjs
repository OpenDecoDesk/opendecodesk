// Shops: the New shop setup wizard from a name to "Your shop is open", Shop settings, the Live / Coming soon
// switch, Publish and Preview — and what a shopper sees at http://<shop>.localhost:8897 after each.
import { test, expect, ADMIN, shopUrl, openAdmin, toast, uniq, pngBytes, confirmDialog } from "../fixtures.mjs";
import { makeShop } from "../lib/data.mjs";

test.describe.configure({ mode: "serial" });

// The wizard's "Save & continue" (or the step's own label): click it and wait for the next question.
async function wizNext(page, nextHeading) {
  await page.locator("#wizNext").click();
  if (nextHeading) await expect(page.locator(".wiz-screen h2.wiz-q")).toHaveText(nextHeading);
  await expect(page.locator("#wizErr")).toBeEmpty();
}

// What a shopper sees: the shop's own address, its heading and (when open) its products.
async function openShop(page, shop) {
  await page.goto(shopUrl(shop.subdomain) + "/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

const shop = {};          // the shop the wizard makes
let location = "";        // a decoration location of its own (the wizard's Graphics step needs one)

test("the setup wizard makes a new shop, one question per screen", async ({ page, api }) => {
  location = uniq("Left chest");
  await api("saveLocation", { location: { name: location } });
  shop.name = uniq("Example Rowing Club");
  shop.orgId = shop.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  shop.subdomain = shop.name.toLowerCase().replace(/[^a-z0-9]+/g, "");

  await openAdmin(page, "catalog");
  await page.getByRole("button", { name: "＋ New shop setup" }).click();
  await expect(page).toHaveURL(/#wizard\/new$/);
  const rail = page.getByRole("complementary", { name: "Setup steps" });
  // Until the shop has a name, only the first step can be opened.
  await expect(rail.getByRole("button", { name: "Delivery" })).toBeDisabled();
  await expect(page.locator(".wiz-screen h2.wiz-q")).toHaveText("What's the shop called?");
  // An empty name is refused.
  await page.locator("#wizNext").click();
  await expect(page.locator("#wizErr")).toHaveText("Give the shop a name.");

  await page.getByPlaceholder("e.g. Northside Rowing Club").fill(shop.name);
  // The web address is filled in from the name (shown under "Change the web address").
  await expect(page.locator("#wizAddr")).toContainText(shop.subdomain + ".localhost");
  await wizNext(page, "How will you decorate for this shop?");
  await expect(page).toHaveURL(new RegExp("#wizard/" + shop.orgId + "$"));
  await expect(rail.getByRole("button", { name: "Delivery" })).toBeEnabled();

  await page.getByRole("radio", { name: /^Embroidery/ }).check();
  await wizNext(page, "How do customers get their order?");
  // Pickup, plus a delivery option of the shop's own with a fee.
  await page.getByRole("checkbox", { name: /^Local pickup/ }).check();
  await page.getByRole("checkbox", { name: /^Your own delivery option/ }).check();
  await page.getByPlaceholder("Name, e.g. Delivered at the next meeting").fill("Delivered at practice");
  await page.locator("#wizOwnFee").fill("3");
  await wizNext(page, "How can customers pay?");
  // No card (this install has no card payments): check and Zelle only.
  for (const [label, on] of [["Card", false], ["Venmo", false], ["Zelle", true], ["Check", true]]) {
    await page.getByRole("checkbox", { name: label, exact: true }).setChecked(on);
  }
  await wizNext(page, "Is there an order deadline?");
  await page.getByRole("radio", { name: "No deadline" }).check();
  await wizNext(page, "How should the shop look?");
  await page.locator("#wizEyebrow").fill("Est. 2026");
  await page.locator("#wizDesc").fill("Club kit for members of the example rowing club.");
  await wizNext(page, "Which blanks do you want to sell?");
  await expect(page.locator(".wiz-pct")).toHaveText(/^\d+% to publish$/);

  // The shop exists now, closed for orders: Manage catalog lists it as "Coming soon".
  const api2 = await api("listOrgsAdmin");
  const made = api2.orgs.find(o => o.orgId === shop.orgId);
  expect(made).toBeTruthy();
  expect(made.ready).toBeFalsy();
  expect(made.deliveryOptions.map(o => o.label)).toEqual(["Local pickup", "Delivered at practice"]);
  expect(made.enabledPayments).toMatchObject({ card: false, venmo: false, zelle: true, check: true });
});

test("the wizard turns a blank typed in on the spot into a product", async ({ page }) => {
  await openAdmin(page, "wizard/" + shop.orgId);
  // Resumes where it was left.
  await expect(page.locator(".wiz-screen h2.wiz-q")).toHaveText("Which blanks do you want to sell?");
  shop.blank = uniq("Club Tee Blank");
  await page.getByRole("button", { name: "+ Enter a blank…" }).click();
  const dlg = page.getByRole("dialog", { name: "Enter a blank" });
  await dlg.getByLabel("Name").fill(shop.blank);
  await dlg.getByRole("checkbox", { name: "Navy", exact: true }).check();
  await dlg.getByRole("checkbox", { name: "White", exact: true }).check();
  await dlg.locator("#qbPrice").fill("4.50");
  await dlg.locator("#qbOk").click();
  // "N blanks added and ticked." — N counts every blank new since the list was read, so a blank another test
  // adds at the same moment is ticked too: untick anything that isn't ours.
  await expect(toast(page)).toContainText(/blanks? added and ticked\./);
  await expect(page.getByRole("checkbox", { name: new RegExp(shop.blank) })).toBeChecked();
  const ticked = page.locator("#wizBlankList input:checked");
  for (const box of await ticked.all()) {
    const label = await box.locator("xpath=..").innerText();
    if (!label.includes(shop.blank)) await box.uncheck();
  }
  await expect(ticked).toHaveCount(1);

  await wizNext(page, "Which colors will you offer?");
  await expect(page.locator(".wiz-kicker")).toContainText(shop.blank + " · 1 of 1");
  // Both colors start ticked; keep Navy only.
  await page.locator(".wiz-swatch input[value=White]").uncheck();
  await expect(page.locator(".wiz-swatch input:checked")).toHaveCount(1);
  await wizNext(page, "How is this product decorated?");
  await wizNext(page, "What goes on it?");
  // One fixed graphic at the shop's decoration location, from a picture uploaded here.
  await page.getByLabel("Decoration location", { exact: true }).selectOption({ label: location });
  await page.locator(".wiz-screen input[type=file]").first().setInputFiles({ name: "club-crest.png", mimeType: "image/png", buffer: pngBytes(120, 120, [20, 60, 140]) });
  await expect(page.getByLabel("Embroidery graphic")).toHaveValue(/^\d+$/);
  await wizNext(page, "Which sizes, and what will you charge?");
  // Cost $4.50 + $12, rounded up to .99.
  await expect(page.locator(".wiz-grid tbody td").first()).toContainText("$16.99");
  await page.getByRole("checkbox", { name: "2XL", exact: true }).uncheck();
  await expect(page.locator(".wiz-grid thead th")).toHaveText(["", "S", "M", "L", "XL"]);
  await wizNext(page, "Name it and check the details");
  shop.product = uniq("Club Tee");
  await page.getByLabel("Product name").fill(shop.product);
  await page.getByLabel("One line under the name (optional)").fill("Soft cotton, club crest on the chest");
  await wizNext(page, "Show it decorated (optional)");
  await wizNext(page, "Anything missing before you publish?");
  await expect(page.locator("#wizCheck")).toContainText("Nothing missing — 1 product ready.");
});

test("Go live opens the shop for orders and publishes it", async ({ page }) => {
  await openAdmin(page, "wizard/" + shop.orgId);
  await expect(page.locator(".wiz-screen h2.wiz-q")).toHaveText("Anything missing before you publish?");
  await wizNext(page, "Ready to open the shop?");
  await expect(page.locator(".wiz-summary")).toContainText("Delivery: Local pickup, Delivered at practice");
  await expect(page.locator(".wiz-summary")).toContainText("Payment: Zelle, Check");
  // Asked first; Cancel changes nothing.
  await page.getByRole("button", { name: "Open for orders & publish" }).click();
  await confirmDialog(page, "Cancel");
  await expect(page.locator("#wizErr")).toHaveText("Not opened — nothing changed.");
  await page.getByRole("button", { name: "Open for orders & publish" }).click();
  await confirmDialog(page, "Open for orders");
  await expect(page.locator(".wiz-screen h2.wiz-q")).toHaveText("Your shop is open 🎉");
  await expect(page.locator(".wiz-ok")).toContainText(shop.name + " is open for orders and published.");
  // The shop bar agrees: live, and nothing waiting to publish.
  await expect(page.getByRole("switch", { name: "Live" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("button", { name: "✓ Published" })).toBeDisabled();
});

test("the shop's address shows the published catalog", async ({ page }) => {
  await openShop(page, shop);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(shop.name);
  await expect(page.locator("main")).toContainText("Club kit for members of the example rowing club.");
  await expect(page.locator("main")).toContainText("Est. 2026");
  const card = page.getByRole("heading", { level: 3, name: shop.product });
  await expect(card).toBeVisible();
  await expect(page.locator("main")).toContainText("$16.99");
  // The delivery options and payment methods chosen in the wizard.
  await expect(page.getByRole("radio", { name: /^Local pickup/ })).toBeVisible();
  await expect(page.getByRole("radio", { name: /^Delivered at practice — \$3\.00/ })).toBeVisible();
  const pay = page.getByLabel("Payment method");
  await expect(pay.locator("option")).toHaveText(["How will you pay?", "Zelle", "Check"]);
});

test("Shop settings changes are a draft until Publish, and Preview shows the draft", async ({ page, context }) => {
  await openAdmin(page, "catalog/orgs/" + shop.orgId + "/edit");
  await expect(page.getByRole("heading", { name: "Shop settings", level: 2 })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Shop ID *" })).toBeDisabled();
  await page.getByRole("textbox", { name: "Description" }).fill("New season kit — order by the end of the month.");
  await page.getByRole("button", { name: "Save changes" }).click();
  // Saved, and back on Manage catalog, where the shop has unpublished changes.
  await expect(page).toHaveURL(/#catalog$/);
  const row = page.locator("tr", { hasText: shop.orgId });
  await expect(row).toContainText("Unpublished changes");

  // Shoppers still see the published description.
  const shopper = await context.newPage();
  await openShop(shopper, shop);
  await expect(shopper.locator("main")).toContainText("Club kit for members of the example rowing club.");
  await expect(shopper.locator("main")).not.toContainText("New season kit");

  // Preview opens the shop's own address with a signed link that shows the draft. The app writes shop links as
  // https://<shop>.<domain>/ (the real site is https only); here that address is the local http server.
  await context.route(/^https:\/\/[a-z0-9-]+\.localhost\//, (route) => {
    const u = new URL(route.request().url());
    return route.fulfill({ status: 302, headers: { location: "http://" + u.hostname + ":" + new URL(ADMIN).port + u.pathname + u.search } });
  });
  const [preview] = await Promise.all([context.waitForEvent("page"), row.getByRole("button", { name: "Preview" }).click()]);
  await preview.waitForLoadState();
  await expect(preview).toHaveURL(new RegExp("^http://" + shop.subdomain + "\\.localhost(:\\d+)?/\\?preview="));
  await expect(preview.locator("main")).toContainText("New season kit — order by the end of the month.");

  await row.getByRole("button", { name: "Publish" }).click();
  await expect(page.locator("tr", { hasText: shop.orgId })).toContainText("✓ Published");
  await shopper.reload();
  await expect(shopper.locator("main")).toContainText("New season kit — order by the end of the month.");
});

// The shop bar, read afresh (after the Live switch the bar redraws from what it last read, up to 15 seconds old):
// nothing waits to publish. The switch changes the published copy as well as the draft (functions/_lib/db.js
// setOrgReady), so a shop with nothing else changed stays "✓ Published" and needs no Publish either way.
async function expectNothingToPublish(page) {
  await page.reload();
  const bar = page.getByRole("navigation", { name: "Shop" });
  await expect(bar.locator("button.shop-bar-pub")).toBeVisible();
  await expect(bar.getByRole("button", { name: "✓ Published" })).toBeDisabled();
}

test("the Live switch puts the shop on Coming soon and opens it again (no Publish needed)", async ({ page, context }) => {
  await openAdmin(page, "catalog/orgs/" + shop.orgId + "/products");
  const live = page.getByRole("switch");
  await expect(live).toHaveText("Live");
  // Asked first; Cancel leaves it open.
  await live.click();
  await confirmDialog(page, "Cancel");
  await expect(page.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  await page.getByRole("switch").click();
  await confirmDialog(page, "Show coming soon");
  await expect(toast(page)).toContainText("now shows “Coming soon”");
  await expect(page.getByRole("switch")).toHaveText("Coming soon");
  await expect(page.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  await expectNothingToPublish(page);
  await expect(page.getByRole("switch")).toHaveText("Coming soon");

  const shopper = await context.newPage();
  await openShop(shopper, shop);
  await expect(shopper.getByRole("heading", { name: "Catalog coming soon" })).toBeVisible();
  await expect(shopper.getByRole("button", { name: "Place order" })).toHaveCount(0);

  await page.getByRole("switch").click();
  await confirmDialog(page, "Go live");
  await expect(toast(page)).toContainText("is open for orders.");
  await expect(page.getByRole("switch")).toHaveText("Live");
  await expectNothingToPublish(page);
  await expect(page.getByRole("switch")).toHaveText("Live");
  await shopper.reload();
  await expect(shopper.getByRole("heading", { level: 3, name: shop.product })).toBeVisible();
  await expect(shopper.getByRole("button", { name: "Place order" })).toBeVisible();
});

// Fixed bug: on a shop that had been published, the Live switch changed only the draft. Its
// confirmation says "Shoppers can't order until you open it again", but shoppers keep seeing the shop and can
// still order (the published copy says ready) until someone publishes; getPublishState reports the shop as
// "changed". setOrgReady updates only the live orgs row (functions/_lib/db.js), while the shop page and order
// submission read the published snapshot (getPublishedOrg).
test("Show coming soon stops orders at once, as its confirmation says", async ({ page, api, context }) => {
  const own = await makeShop(api, { prefix: "soon" });
  await openAdmin(page, "catalog/orgs/" + own.orgId + "/products");
  await page.getByRole("switch").click();
  await confirmDialog(page, "Show coming soon");
  await expect(toast(page)).toContainText("now shows “Coming soon”");
  // Everything above must work; only what the shopper sees is the known bug.
  const shopper = await context.newPage();
  await openShop(shopper, own);
  await expect(shopper.getByRole("heading", { name: "Catalog coming soon" })).toBeVisible({ timeout: 3000 });
});

// Fixed bug: a shop just made (New shop setup's first screen, or createOrg) wasn't known at its own address
// until the catalog version next changes — someone's Publish, or the cached catalog expiring (up to 5 minutes).
// Until then <shop>.<domain> answers 404 and shows the generic "Looking for your organization's order page? … the
// link may be mistyped" page instead of "Catalog coming soon", and the wizard's own "Preview the shop" link (a signed
// ?preview= link to the same address) shows that page too. createOrg doesn't bump the catalog version
// (functions/api/orders.js), and the shop list comes from the version-keyed cache (functions/_lib/catalogCache.js).
test("a shop just made answers at its own address straight away (coming soon, and its preview)", async ({ api, request }) => {
  const id = ("fresh" + uniq("x").split(" ")[1]).toLowerCase();
  // Made and asked for back to back, so no other test's Publish can land in between and hide the problem.
  await api("createOrg", { orgId: id, subdomain: id, name: uniq("Example Club"), ready: false, deliveryOptions: [{ type: "pickup" }] });
  const res = await request.get(shopUrl(id) + "/api/catalog");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.catalog.ready).toBe(false);
});

test("a Back office user works on products but has no Shop setup, Live switch or Publish", async ({ api, as }) => {
  const own = await makeShop(api, { prefix: "shopstaff" });
  const p = await as("staff");
  await openAdmin(p, "catalog/orgs/" + own.orgId + "/products");
  const bar = p.getByRole("navigation", { name: "Shop" });
  await expect(bar.getByRole("link", { name: "Products" })).toBeVisible();
  await expect(bar.getByRole("link", { name: "Shop setup" })).toHaveCount(0);
  await expect(bar.getByRole("link", { name: "Shop settings" })).toHaveCount(0);
  await expect(bar.getByRole("switch")).toHaveCount(0);
  await expect(bar.getByRole("button", { name: /Publish/ })).toHaveCount(0);
  // The page for a new shop says the role can't use it.
  await p.goto(ADMIN + "/#wizard/new");
  await expect(p.locator("#app")).not.toContainText("What's the shop called?");
  // …and the server refuses the request itself.
  const r = await p.evaluate(async (org) => {
    const res = await fetch("/api/orders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "publish", org }) });
    return res.status;
  }, own.orgId);
  expect(r).toBe(403);
});
