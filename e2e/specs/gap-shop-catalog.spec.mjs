// A shop's address answers only with its own catalog (review #6, PR #59: the storefront catalog is cached per shop).
//
// functions/api/catalog.js takes the shop from the request's Host (<shop>.<domain>) and ignores ?org= there
// entirely; the root domain serves no shop at all, whatever ?org= says. functions/_lib/catalogCache.js keeps one
// entry per shop under the catalog version, so publishing one shop gives every shop a fresh entry, each still built
// from that shop's own rows only.
//
// Two shops of this file's own, with products of their own. Other specs publish their shops at the same time, which
// only bumps the catalog version; nothing install-wide is changed here. The shops are made with the owner's API; the
// rename and Publish are done on the admin pages, and what a shopper gets is read from the shop's own address.
import { test, expect, shopUrl, uniq, openAdmin, toast } from "../fixtures.mjs";
import { makeShop } from "../lib/data.mjs";

test.describe.configure({ mode: "serial" });

const ROOT = shopUrl("").replace("://.", "://");   // http://localhost:<port>: the root domain of this install

// GET <address>/api/catalog[?org=…], as the shop page asks for it: { status, body, text }.
async function catalogAt(request, base, org) {
  const res = await request.get(base + "/api/catalog" + (org ? "?org=" + encodeURIComponent(org) : ""));
  const text = await res.text();
  return { status: res.status(), body: JSON.parse(text), text };
}
// What an answer says about the shop itself: which shop, its name, open or not, and its products (id, name, price).
// Not the install-wide parts (business, features, sales tax, rush), which other specs change for a moment.
const shopPart = (body) => ({
  orgId: body.orgId, name: body.catalog.name, ready: body.catalog.ready,
  products: body.catalog.products.map(p => ({ id: p.id, name: p.name, flatPrice: p.flatPrice })).sort((a, b) => a.id.localeCompare(b.id)),
});
const productHeading = (page, name) => page.locator("main").getByRole("heading", { level: 3, name, exact: true });

let A, B;

test("each shop's address answers with its own catalog, whatever ?org= names", async ({ api, request }) => {
  A = await makeShop(api, { prefix: "cata", name: uniq("Example Rowing Club"), products: [{ name: uniq("Rowing Tee"), price: 21 }] });
  B = await makeShop(api, { prefix: "catb", name: uniq("Example Chess Club"), products: [{ name: uniq("Chess Cap"), price: 17, type: "cap", idPrefix: "cap" }] });

  for (const [mine, other] of [[A, B], [B, A]]) {
    const plain = await catalogAt(request, shopUrl(mine.subdomain));
    expect(plain.status).toBe(200);
    expect(plain.body.status).toBe("ok");
    expect(shopPart(plain.body)).toEqual({
      orgId: mine.orgId, name: mine.name, ready: true,
      products: [{ id: mine.products[0].productId, name: mine.products[0].name, flatPrice: mine.products[0].price }],
    });

    // Asked for the other shop by ?org=: the same answer, this shop's, with nothing of the other shop anywhere in it
    // (its id is a prefix and a random tail, so it can't be part of anything else in the answer either).
    const asked = await catalogAt(request, shopUrl(mine.subdomain), other.orgId);
    expect(asked.status).toBe(200);
    expect(shopPart(asked.body)).toEqual(shopPart(plain.body));
    for (const leak of [other.name, other.products[0].name, other.products[0].productId, other.orgId]) expect(asked.text).not.toContain(leak);
  }
});

test("the shop page at a shop's address with ?org= of another shop shows its own shop", async ({ as }) => {
  const page = await as(null);
  await page.goto(shopUrl(A.subdomain) + "/?org=" + encodeURIComponent(B.orgId));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(A.name);
  await expect(productHeading(page, A.products[0].name)).toBeVisible();
  await expect(page.getByRole("button", { name: "Place order" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(B.products[0].name);
  await expect(page.locator("body")).not.toContainText(B.name);
});

test("the root domain serves no shop, whatever ?org= names", async ({ request }) => {
  const res = await catalogAt(request, ROOT, B.orgId);
  // The same answer for any ?org= (so shop ids can't be probed): no shop, and nothing of B in it.
  expect(res.status).toBe(200);
  expect(res.body.status).toBe("error");
  expect(res.body.message).toBe("Unknown org");
  expect(res.body.catalog).toBeUndefined();
  for (const leak of [B.name, B.products[0].name, B.products[0].productId]) expect(res.text).not.toContain(leak);
  const none = await catalogAt(request, ROOT, "no-such-shop-" + Date.now().toString(36));
  expect(none.status).toBe(200);
  expect(none.body).toEqual(res.body);
});

test("renaming B's product and publishing B changes B's answer only", async ({ page, request }) => {
  // Both shops' entries are asked for first, so each is built and cached before B changes.
  const aBefore = shopPart((await catalogAt(request, shopUrl(A.subdomain), B.orgId)).body);
  const bBefore = shopPart((await catalogAt(request, shopUrl(B.subdomain))).body);
  expect(bBefore.products[0].name).toBe(B.products[0].name);

  // Renamed on the product's own page: a draft, so shoppers still get the published name.
  const renamed = uniq("Chess Beanie");
  await openAdmin(page, "catalog/orgs/" + B.orgId + "/products/" + B.products[0].productId + "/edit");
  await expect(page.locator("#prodFormName")).toHaveValue(B.products[0].name);
  await page.locator("#prodFormName").fill(renamed);
  await page.getByRole("button", { name: "Save changes" }).first().click();
  await expect(toast(page)).toContainText("Saved.");
  expect(shopPart((await catalogAt(request, shopUrl(B.subdomain))).body)).toEqual(bBefore);

  // Published from Manage catalog's row for B (a row's Publish publishes that one shop).
  await openAdmin(page, "catalog");
  const row = page.locator("main tr", { hasText: B.orgId });
  await expect(row).toContainText("Unpublished changes");
  await row.getByRole("button", { name: "Publish" }).click();
  await expect(page.locator("main tr", { hasText: B.orgId })).toContainText("✓ Published");

  const bAfter = await catalogAt(request, shopUrl(B.subdomain));
  expect(shopPart(bAfter.body)).toEqual({ ...bBefore, products: [{ ...bBefore.products[0], name: renamed }] });
  // A's answer (asked with B's id again) is what it was, with neither of B's product names in it.
  const aAfter = await catalogAt(request, shopUrl(A.subdomain), B.orgId);
  expect(shopPart(aAfter.body)).toEqual(aBefore);
  for (const leak of [renamed, B.products[0].name, B.name]) expect(aAfter.text).not.toContain(leak);

  // The shop pages agree: B's shows the new name, A's is unchanged.
  const shopper = await page.context().newPage();
  await shopper.goto(shopUrl(B.subdomain) + "/");
  await expect(productHeading(shopper, renamed)).toBeVisible();
  await expect(shopper.locator("main")).not.toContainText(B.products[0].name);
  await shopper.goto(shopUrl(A.subdomain) + "/");
  await expect(shopper.getByRole("heading", { level: 1 })).toHaveText(A.name);
  await expect(productHeading(shopper, A.products[0].name)).toBeVisible();
  await expect(shopper.locator("body")).not.toContainText(renamed);
});
