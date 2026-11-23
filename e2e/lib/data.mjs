// Test data a spec needs before it opens a page, made through the admin's own API with the owner's signed-in
// session (the same requests the admin pages send). Each spec makes its own, with unique names, so a spec can
// run alone or beside the others. The specs that test making these things do it through the pages instead.
import { slug, uniq, expect, shopUrl } from "../fixtures.mjs";

// A shop that is open, with pickup and a flat-fee local delivery, the non-card payment methods, and `products`
// plain flat-price products ({ name, price }). Published unless { publish: false }.
// Returns { orgId, subdomain, name, products: [{ productId, name, price }] }.
export async function makeShop(api, opts = {}) {
  const id = opts.orgId || slug(opts.prefix || "shop");
  const shop = { orgId: id, subdomain: opts.subdomain || id, name: opts.name || uniq("Example Club"), products: [] };
  await api("createOrg", {
    orgId: shop.orgId, subdomain: shop.subdomain, name: shop.name, ready: opts.ready !== false,
    desc: "A shop made by the end-to-end suite.", accent: "#2563eb",
    enabledPayments: opts.payments || { card: false, venmo: true, zelle: true, check: true, cash: true, other: true },
    deliveryOptions: opts.deliveryOptions || [{ type: "pickup" }, { type: "custom", label: "Local delivery", fee: 5 }],
    // Tax-exempt unless asked otherwise, so a sales-tax rate another spec sets for a moment never changes this
    // shop's totals.
    ...(opts.taxExempt === false ? {} : { taxExempt: true, taxExemptCertificate: "E2E-EXEMPT-1" }),
  });
  for (const p of opts.products || [{ name: "Sample Tee", price: 20 }]) {
    const productId = slug(p.idPrefix || "tee").slice(0, 30);
    await api("createProduct", {
      org: shop.orgId, productId, type: p.type || "shirt", name: p.name, pricingMode: "flat", flatPrice: p.price,
      visible: true, images: [], ...(p.extra || {}),
    });
    shop.products.push({ productId, name: p.name, price: p.price });
  }
  if (opts.publish !== false) await api("publish", { org: shop.orgId });
  return shop;
}

// Places an order on the shop's own page, as a customer: `items` [{ name, qty }] (by product name; the
// product must be one-size), `payment` the label in the Payment method list (Check, Venmo, Zelle),
// `delivery` the label start of a delivery radio ("Local pickup", "Local delivery"). Leaves the page on the
// confirmation and returns { orderId, total } (total as the text after "$").
export async function placeOrder(page, shop, { items = [{ name: shop.products[0].name, qty: 1 }], customer = "Casey Customer",
  email = "casey@example.test", payment = "Check", delivery = null } = {}) {
  await page.goto(shopUrl(shop.subdomain) + "/");
  await expect(page.getByRole("heading", { level: 1, name: shop.name })).toBeVisible();
  for (const it of items) {
    const card = page.locator("main").getByRole("heading", { level: 3, name: it.name, exact: true }).locator("xpath=ancestor::*[.//button[normalize-space()='Add to cart']][1]");
    if ((it.qty || 1) !== 1) await card.getByRole("spinbutton").fill(String(it.qty));
    await card.getByRole("button", { name: "Add to cart" }).click();
  }
  if (delivery) await page.getByRole("radio", { name: new RegExp("^" + delivery) }).check();
  await page.getByLabel("Your name").fill(customer);
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Payment method").selectOption({ label: payment });
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.getByRole("heading", { level: 2, name: /^Order received/ })).toBeVisible();
  const line = await page.locator(".confirmation .order-number").textContent();
  const m = /^\s*(\S+)\s*·\s*\$([\d,.]+)/.exec(line);
  return { orderId: m[1], total: m[2] };
}
