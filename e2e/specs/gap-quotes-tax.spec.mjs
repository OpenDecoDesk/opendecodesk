// Quotes (migrations/0109): sales tax on a quote, in a real browser.
//
// A quote is taxed by the same rules as a Local sale with its customer picked (docs/sales-tax.md, "Quotes"): a product
// line when the product is taxable, a custom line or a fee when its "Subject to sales tax" box is ticked, nothing when the
// shop or the customer is exempt. Until it is sent its tax follows the Global settings of the moment; sending keeps the
// rate and the mode (prices include tax, or tax added) as they were, so a later change of the settings leaves it alone,
// until the customer asks for changes (it follows the settings again) and it is sent again. The order it becomes (the
// customer's Accept on the quote's page, or staff's Convert to order) keeps the quote's mode, and its totals on the
// Orders page are the quote's when the rate is the same that day.
//
// Sales tax needs a rate, which is one setting for the whole install and 0 between tests (settings.spec.mjs checks
// that). So, as gap-customers-tax-merge.spec.mjs does, the rate (and the mode) is set only for the few steps that need
// it (withTax below) and put back at once, with rates no other spec uses. The shops here are made taxable (makeShop's
// are exempt unless asked). No date in this file depends on today or on this computer's time zone: the quotes have no
// expiry, and the exempt customer's certificate has none either.
import { test, expect, shopUrl, openAdmin, toast, uniq, slug } from "../fixtures.mjs";
import { makeShop } from "../lib/data.mjs";

// Rates only this file uses. 7.25% on $60.00: $4.06 inside the price (inclusive), $4.35 on top (exclusive); on $12.00:
// $0.81 inside, $0.87 on top; on $25.00: $1.69 inside. 3.5% on $60.00 on top: $2.10; on $20.00 on top: $0.70.
const RATE = 7.25;
const RATE2 = 3.5;
const MINE = [RATE, RATE2];
const taxNow = async (api) => (await api("getSalesTaxSettings")).salesTax;

// Runs `fn` with the sales tax rate and mode set, then puts the rate back to none and the mode back to what it was.
// Waits first while another spec has a rate of its own in force. `fn` gets set(rate, mode) to change them meanwhile.
async function withTax(api, { rate = RATE, mode }, fn) {
  await expect.poll(async () => (await taxNow(api)).ratePercent, { timeout: 45_000 }).toBe(0);
  const before = await taxNow(api);
  const set = (r, m) => api("updateSalesTaxSettings", { ratePercent: r, jurisdiction: before.jurisdiction || "", taxMode: m || before.taxMode });
  await set(rate, mode);
  try { return await fn(set); }
  finally {
    const now = await taxNow(api);
    if (MINE.includes(now.ratePercent)) await api("updateSalesTaxSettings", { ratePercent: 0, jurisdiction: now.jurisdiction || "", taxMode: before.taxMode });
  }
}

// A taxable shop with a taxable $20 tee and a $5 patch that isn't taxable.
const taxableShop = (api, prefix, opts = {}) => makeShop(api, { prefix, taxExempt: false, ...opts, products: [
  { name: "Sample Tee", price: 20, idPrefix: "tee" },
  { name: "Sample Patch", price: 5, idPrefix: "patch", extra: { taxable: false } },
] });
const email = (who) => who + "." + slug("q") + "@example.test";
const newCustomer = async (api, fields) => (await api("saveCustomer", fields)).id;
const newQuote = async (api, shop, customerId, title) => api("createEstimate", { org: shop.orgId, customerId, title, expiresOn: null });
const orderOf = async (api, shop, orderId) => (await api("getOrders", { org: shop.orgId })).orders.find(o => o.orderId === orderId);

// ---- The quote's page in the admin ------------------------------------------------------------------------------
const openQuote = async (page, id) => {
  await openAdmin(page, "quotes/" + id);
  await expect(page.locator("#qtForm")).toBeVisible();
};
const savedEstimate = (page) => page.waitForResponse(r => r.url().endsWith("/api/orders") && /"action":"saveEstimate"/.test(r.request().postData() || ""));
// + Product: the product, quantity; Add line. Waits for the server's answer (it prices the line).
async function addProduct(page, name, qty) {
  await page.locator("#qtAddProduct").click();
  const form = page.locator("#qtProdForm");
  await expect(form).toBeVisible();
  await form.getByLabel("Product").selectOption({ label: name });
  await form.getByRole("spinbutton", { name: "Quantity" }).fill(String(qty));
  const saved = savedEstimate(page);
  await form.getByRole("button", { name: "Add line" }).click();
  await saved;
  await expect(form).toHaveCount(0);
}
// + Fee: its kind, description, amount and whether it is taxed. Returns what the page sent.
async function addFee(page, kind, desc, amount, taxable) {
  await page.locator("#qtAddFee").click();
  const form = page.locator("#qtOtherForm");
  await expect(form).toBeVisible();
  await form.getByLabel("Kind of fee").selectOption({ label: kind });
  await form.getByLabel("Description (optional)").fill(desc);
  await form.getByLabel("Amount ($)").fill(String(amount));
  const box = form.getByRole("checkbox", { name: "Subject to sales tax" });
  await expect(box).toBeChecked();   // a new fee is taxed unless the box is cleared
  if (!taxable) await box.uncheck();
  const saved = savedEstimate(page);
  await form.getByRole("button", { name: "Add line" }).click();
  const res = await saved;
  await expect(form).toHaveCount(0);
  return JSON.parse(res.request().postData());
}
const lineRow = (page, text) => page.locator("#qtLines tbody tr", { hasText: text });
const sumRow = (page, label) => page.locator("#qtTotals table.qt-sum tr").filter({ has: page.locator("th", { hasText: new RegExp("^" + label + "$") }) }).locator("td");
const sumLabels = async (page) => (await page.locator("#qtTotals table.qt-sum th").allTextContents()).map(s => s.trim());
// The totals under the lines: inclusive shows Total and (when there is tax) "Includes sales tax"; exclusive shows
// Subtotal, Sales tax and Total.
async function expectSums(page, { mode, subtotal, tax, total }) {
  if (mode === "exclusive") {
    expect(await sumLabels(page)).toEqual(["Subtotal", "Sales tax", "Total"]);
    await expect(sumRow(page, "Subtotal")).toHaveText(subtotal);
    await expect(sumRow(page, "Sales tax")).toHaveText(tax);
  } else if (tax) {
    expect(await sumLabels(page)).toEqual(["Total", "Includes sales tax"]);
    await expect(sumRow(page, "Includes sales tax")).toHaveText(tax);
  } else {
    expect(await sumLabels(page)).toEqual(["Total"]);
  }
  await expect(sumRow(page, "Total")).toHaveText(total);
}

// Send…: the customer's email is filled in; no email can go from this install, so the page shows the link instead.
// Returns the link, reopened on the local port.
async function sendQuote(page, { again = false } = {}) {
  await page.locator("#qtSend").click();
  const form = page.locator("#qtSendForm");
  await expect(form).toBeVisible();
  const sent = page.waitForResponse(r => r.url().endsWith("/api/orders") && /"action":"sendEstimate"/.test(r.request().postData() || ""));
  await form.getByRole("button", { name: again ? "Send again" : "Send quote" }).click();
  await sent;
  const link = form.locator("#qtSendLink");
  await expect(link).toHaveValue(/\?estimate=[0-9a-f]{32}$/);
  const url = new URL(await link.inputValue());
  await form.getByRole("button", { name: "Done" }).click();
  await expect(form).toHaveCount(0);
  await expect(page.locator("#qtSend")).toHaveText("Send again…");
  return shopUrl(url.hostname.split(".")[0]) + "/" + url.search;
}

// ---- The customer's quote page (/?estimate=) -----------------------------------------------------------------------
const openCustomerQuote = async (visitor, link) => {
  await visitor.goto(link);
  await expect(visitor.locator(".inv table.inv-totals")).toBeVisible();
};
const custTotal = (visitor, label) => visitor.locator(".inv table.inv-totals tr").filter({ has: visitor.locator("td:first-child", { hasText: new RegExp("^" + label) }) }).locator("td.num");
const custTotalLabels = async (visitor) => (await visitor.locator(".inv table.inv-totals tr td:first-child").allTextContents()).map(s => s.trim());
async function acceptOnPage(visitor) {
  await visitor.getByRole("button", { name: "Accept quote" }).click();
  const answered = visitor.waitForResponse(r => r.url().includes("/api/estimate") && r.request().method() === "POST");
  await visitor.getByRole("button", { name: "Yes, accept and order" }).click();
  const data = await (await answered).json();
  expect(data.status).toBe("ok");
  expect(data.orderId).toMatch(/^[A-Z0-9]{1,4}-Q\d{5,}$/);
  await expect(visitor.locator("#estState")).toContainText("your order " + data.orderId + " is placed");
  return data.orderId;
}

// ---- The order on the Orders page ---------------------------------------------------------------------------------
const orderRow = (page, orderId) => page.locator(`tr[data-order="${orderId}"]`).first();
async function openPayments(page, shop, orderId) {
  await openAdmin(page, "orders/" + shop.orgId);
  await expect(orderRow(page, orderId)).toBeVisible();
  await orderRow(page, orderId).locator("td[data-action-td]").getByRole("button", { name: "💰 Payments" }).click();
  const pm = page.locator("#pmContent");
  await expect(pm).toContainText("Amount due");
  return pm;
}
const pmRow = (pm, label) => pm.locator("tr").filter({ has: pm.page().locator("td:first-child", { hasText: label }) }).first().locator("td").nth(1);

test("A quote in prices-include-tax mode: tax on the taxable lines only, kept once sent, and the accepted order carries it", async ({ page, api, as }) => {
  test.setTimeout(180_000);
  const shop = await taxableShop(api, "qta");
  const pat = { name: uniq("Pat Quoted"), email: email("pat") };
  pat.id = await newCustomer(api, { name: pat.name, email: pat.email });
  const q = await newQuote(api, shop, pat.id, "Team shirts");

  let link;
  await withTax(api, { mode: "inclusive" }, async (set) => {
    await openQuote(page, q.id);
    // 3 tees ($60, taxable), 2 patches ($10, the product isn't taxable), a $25 setup fee that isn't taxed, a $12 art fee that is.
    await addProduct(page, "Sample Tee", 3);
    await addProduct(page, "Sample Patch", 2);
    const setup = await addFee(page, "Setup fee", "Left chest logo", 25, false);
    expect(setup.items.find(it => it.kind === "fee")).toEqual({ kind: "fee", feeKind: "setup", name: "Left chest logo", amount: 25, taxable: false });
    const art = await addFee(page, "Art fee", "Club crest", 12, true);
    expect(art.items.find(it => it.kind === "fee" && it.feeKind === "art")).toMatchObject({ amount: 12, taxable: true });

    // The fee that isn't taxed says so; the taxed one and the product lines don't.
    await expect(lineRow(page, "Setup fee — Left chest logo")).toContainText("Not taxed");
    await expect(lineRow(page, "Art fee — Club crest")).not.toContainText("Not taxed");
    await expect(lineRow(page, "Sample Tee")).not.toContainText("Not taxed");
    await expect(lineRow(page, "Sample Tee").locator("td").nth(5)).toHaveText("$60.00");
    await expect(lineRow(page, "Sample Patch").locator("td").nth(5)).toHaveText("$10.00");
    // $107.00 in all; the tax inside it is the tees' $4.06 and the art fee's $0.81 — none on the patches or the setup fee.
    await expectSums(page, { mode: "inclusive", tax: "$4.87", total: "$107.00" });
    await expect(page.locator("#qtTotals")).toContainText("Prices follow the catalog until the quote is sent; from then on they are fixed.");
    expect((await api("getEstimate", { id: q.id })).totals).toEqual({ subtotal: 107, tax: 4.87, total: 107, taxMode: "inclusive", taxRateBps: 725 });

    // Ticking the setup fee's box taxes it too ($1.69 more), and clearing it again takes that off.
    const toggleSetupTax = async (on, expectTax) => {
      await lineRow(page, "Setup fee — Left chest logo").getByRole("button", { name: /^Change / }).click();
      const form = page.locator("#qtOtherForm");
      await expect(form).toBeVisible();
      const box = form.getByRole("checkbox", { name: "Subject to sales tax" });
      await expect(box).toBeChecked({ checked: !on });
      await box.setChecked(on);
      const saved = savedEstimate(page);
      await form.getByRole("button", { name: "Save line" }).click();
      await saved;
      await expect(form).toHaveCount(0);
      await expectSums(page, { mode: "inclusive", tax: expectTax, total: "$107.00" });
    };
    await toggleSetupTax(true, "$6.56");
    await expect(lineRow(page, "Setup fee — Left chest logo")).not.toContainText("Not taxed");
    await toggleSetupTax(false, "$4.87");
    await expect(lineRow(page, "Setup fee — Left chest logo")).toContainText("Not taxed");

    // A draft follows the settings: at another rate its tax is worked out again when the page is loaded.
    await set(RATE2, "inclusive");
    await openQuote(page, q.id);
    // 3.5% inside $60.00 is $2.03, inside $12.00 $0.41.
    await expectSums(page, { mode: "inclusive", tax: "$2.44", total: "$107.00" });
    await set(RATE, "inclusive");
    await openQuote(page, q.id);
    await expectSums(page, { mode: "inclusive", tax: "$4.87", total: "$107.00" });

    link = await sendQuote(page);
  });

  // The rate is back to none, and the quote that was sent still has the tax it was sent with: on its page, in the
  // list, to the server and on the customer's page.
  expect((await taxNow(api)).ratePercent).toBe(0);
  await openQuote(page, q.id);
  await expect(page.locator("#qtPage .cust-name")).toContainText("Sent");
  await expectSums(page, { mode: "inclusive", tax: "$4.87", total: "$107.00" });
  await expect(page.locator("#qtTotals")).not.toContainText("Prices follow the catalog");
  expect((await api("getEstimate", { id: q.id })).totals).toEqual({ subtotal: 107, tax: 4.87, total: 107, taxMode: "inclusive", taxRateBps: 725 });
  await openAdmin(page, "quotes");
  await page.getByLabel("Search").fill(q.number);
  const listRow = page.locator(`tr[data-qt-id="${q.id}"]`);
  await expect(listRow).toHaveCount(1);
  await expect(listRow.locator("td.cust-num")).toHaveText("$107.00");

  const visitor = await as(null);
  await openCustomerQuote(visitor, link);
  expect(await custTotalLabels(visitor)).toEqual(["Subtotal", "Total"]);
  await expect(custTotal(visitor, "Subtotal")).toHaveText("$107.00");
  await expect(custTotal(visitor, "Total")).toHaveText("$107.00");
  await expect(visitor.locator(".inv .inv-tax")).toHaveText(/^Includes sales tax \(7\.25%( \S+)?\) \$4\.87$/);
  const fees = visitor.locator(".inv table.inv-items").filter({ hasText: "One-time charges" });
  await expect(fees.locator("tbody tr")).toHaveText([/^Setup fee — Left chest logo\s*\$25\.00$/, /^Art fee — Club crest\s*\$12\.00$/]);
  // What the page was given: the fees' own taxability, the quote's rate (not today's none).
  const shown = await (await visitor.request.get(shopUrl(shop.subdomain) + "/api/estimate?token=" + new URL(link).searchParams.get("estimate"))).json();
  expect(shown.estimate).toMatchObject({ subtotal: 107, tax: 4.87, total: 107, taxMode: "inclusive", taxRate: 7.25 });
  expect(shown.estimate.fees.map(f => [f.feeKind, f.taxable])).toEqual([["setup", false], ["art", true]]);

  // The customer accepts on the day the rate is what the quote was sent with: the order carries the quote's tax.
  const orderId = await withTax(api, { mode: "inclusive" }, () => acceptOnPage(visitor));
  const order = await orderOf(api, shop, orderId);
  expect(order).toMatchObject({ customerId: pat.id, taxMode: "inclusive", taxExempt: false, taxRate: RATE, salesTax: 4.87, total: 107 });
  // Line by line: the setup fee and the patches carry none.
  const taxOf = (name) => order.items.filter(it => it.name.startsWith(name)).map(it => it.tax);
  expect(taxOf("Sample Tee")).toEqual([4.06]);
  expect(taxOf("Sample Patch")).toEqual([0]);
  expect(taxOf("Setup fee")).toEqual([0]);
  expect(taxOf("Art fee")).toEqual([0.81]);

  // The Orders page: the order's Payments window adds up to what the quote said.
  const pm = await openPayments(page, shop, orderId);
  await expect(pmRow(pm, "Subtotal")).toHaveText("$107.00");
  await expect(pmRow(pm, "Amount due")).toHaveText("$107.00");
  await expect(pmRow(pm, "Includes sales tax (7.25%)")).toHaveText("$4.87");
  await expect(pm).not.toContainText("added to the prices");
  // …and the quote names its order.
  await openQuote(page, q.id);
  await expect(page.locator("#qtOrderLink")).toHaveText(orderId);
  await expectSums(page, { mode: "inclusive", tax: "$4.87", total: "$107.00" });
});

test("Tax added on top: the quote shows it as its own line, keeps rate and mode once sent, and Convert to order keeps both", async ({ page, api, as }) => {
  test.setTimeout(180_000);
  const shop = await taxableShop(api, "qtx");
  const lee = { name: uniq("Lee Exclusive"), email: email("lee") };
  lee.id = await newCustomer(api, { name: lee.name, email: lee.email });
  const q = await newQuote(api, shop, lee.id, "Hoodies");
  const draft = await newQuote(api, shop, lee.id, "Caps, maybe");

  let link;
  await withTax(api, { mode: "exclusive" }, async (set) => {
    await openQuote(page, q.id);
    await addProduct(page, "Sample Tee", 3);
    await addFee(page, "Setup fee", "", 25, false);
    await addFee(page, "Art fee", "Club crest", 12, true);
    // The fee with no description is named by its kind.
    await expect(lineRow(page, "Setup fee")).toContainText("Not taxed");
    // $97.00 before tax; $4.35 on the tees and $0.87 on the art fee; nothing on the setup fee.
    await expectSums(page, { mode: "exclusive", subtotal: "$97.00", tax: "$5.22", total: "$102.22" });
    link = await sendQuote(page);

    await openQuote(page, draft.id);
    await addProduct(page, "Sample Tee", 1);
    await expectSums(page, { mode: "exclusive", subtotal: "$20.00", tax: "$1.45", total: "$21.45" });

    // The settings change: another rate, and prices that include tax. The draft follows them…
    await set(RATE2, "inclusive");
    await openQuote(page, draft.id);
    // 3.5% inside $20.00 is $0.68.
    await expectSums(page, { mode: "inclusive", tax: "$0.68", total: "$20.00" });
    // …the quote that was sent doesn't, and sending it again keeps what it was sent with.
    await openQuote(page, q.id);
    await expectSums(page, { mode: "exclusive", subtotal: "$97.00", tax: "$5.22", total: "$102.22" });
    await sendQuote(page, { again: true });
    await openQuote(page, q.id);
    await expect(page.locator("#qtPage .cust-sub").nth(1)).toContainText("(2 times)");
    await expectSums(page, { mode: "exclusive", subtotal: "$97.00", tax: "$5.22", total: "$102.22" });
    expect((await api("getEstimate", { id: q.id })).totals).toEqual({ subtotal: 97, tax: 5.22, total: 102.22, taxMode: "exclusive", taxRateBps: 725 });
  });

  // Back to no rate (and the mode as it was): the sent quote is unchanged, on the customer's page as well.
  await openQuote(page, q.id);
  await expectSums(page, { mode: "exclusive", subtotal: "$97.00", tax: "$5.22", total: "$102.22" });
  const visitor = await as(null);
  await openCustomerQuote(visitor, link);
  expect(await custTotalLabels(visitor)).toEqual(["Subtotal", expect.stringMatching(/^Sales tax \(7\.25%( \S+)?\)$/), "Total"]);
  await expect(custTotal(visitor, "Subtotal")).toHaveText("$97.00");
  await expect(custTotal(visitor, "Sales tax")).toHaveText("$5.22");
  await expect(custTotal(visitor, "Total")).toHaveText("$102.22");
  await expect(visitor.locator(".inv .inv-tax")).toHaveCount(0);

  // Staff convert it on a day the rate is the quote's and the settings say prices include tax: the order keeps the
  // quote's mode (tax on top) and its tax.
  const orderId = await withTax(api, { mode: "inclusive" }, async () => {
    await openQuote(page, q.id);
    await page.locator("#qtConvert").click();
    const form = page.locator("#qtConvForm");
    await expect(form).toBeVisible();
    await expect(form).toContainText("at the quote's prices ($102.22), not yet paid");
    await form.getByRole("checkbox", { name: /^Email the customer the invoice/ }).uncheck();
    const converted = page.waitForResponse(r => r.url().endsWith("/api/orders") && /"action":"convertEstimate"/.test(r.request().postData() || ""));
    await form.getByRole("button", { name: "Make the order" }).click();
    const a = await (await converted).json();
    await expect(toast(page)).toContainText("Order " + a.orderId + " made from quote " + q.number + ".");
    return a.orderId;
  });
  const order = await orderOf(api, shop, orderId);
  expect(order).toMatchObject({ customerId: lee.id, taxMode: "exclusive", taxExempt: false, taxRate: RATE, salesTax: 5.22, total: 102.22 });
  const setupLine = order.items.find(it => it.name === "Setup fee");
  expect(setupLine).toMatchObject({ lineTotal: 25, tax: 0 });

  const pm = await openPayments(page, shop, orderId);
  await expect(pmRow(pm, "Subtotal")).toHaveText("$97.00");
  await expect(pmRow(pm, "Sales tax (7.25%) — added to the prices")).toHaveText("$5.22");
  await expect(pmRow(pm, "Amount due")).toHaveText("$102.22");
  await expect(pm).not.toContainText("Includes sales tax");

  // The customer's page now says it is that order, with the same totals.
  await openCustomerQuote(visitor, link);
  await expect(visitor.locator(".inv")).toContainText("This quote has been accepted — it's order " + orderId + ".");
  await expect(custTotal(visitor, "Total")).toHaveText("$102.22");
});

test("Exempt: no tax for an exempt customer, none in an exempt shop, and the order from it carries none", async ({ page, api, as }) => {
  test.setTimeout(180_000);
  const shop = await taxableShop(api, "qte");
  const exemptShop = await makeShop(api, { prefix: "qtz", products: [{ name: "Sample Tee", price: 20, idPrefix: "tee" }] });
  const kim = { name: uniq("Kim Exempt"), email: email("kim") };
  kim.id = await newCustomer(api, { name: kim.name, email: kim.email, taxExempt: true, taxExemptCertificate: "EX-QUOTE-0001" });
  const ash = { name: uniq("Ash Ordinary"), email: email("ash") };
  ash.id = await newCustomer(api, { name: ash.name, email: ash.email });
  const q = await newQuote(api, shop, kim.id, "Exempt order");
  const inExemptShop = await newQuote(api, exemptShop, ash.id, "From the exempt shop");

  let link;
  await withTax(api, { mode: "inclusive" }, async (set) => {
    await openQuote(page, q.id);
    await addProduct(page, "Sample Tee", 3);
    await addFee(page, "Art fee", "Club crest", 12, true);
    // Taxable lines, but the customer is exempt: no tax line at all.
    await expectSums(page, { mode: "inclusive", tax: null, total: "$72.00" });
    expect((await api("getEstimate", { id: q.id })).totals).toEqual({ subtotal: 72, tax: 0, total: 72, taxMode: "inclusive", taxRateBps: 0 });
    // With tax on top, the tax line is there and is nothing.
    await set(RATE, "exclusive");
    await openQuote(page, q.id);
    await expectSums(page, { mode: "exclusive", subtotal: "$72.00", tax: "$0.00", total: "$72.00" });
    link = await sendQuote(page);

    // A customer who isn't exempt, in a shop that is: no tax either.
    await openQuote(page, inExemptShop.id);
    await addProduct(page, "Sample Tee", 3);
    await expectSums(page, { mode: "exclusive", subtotal: "$60.00", tax: "$0.00", total: "$60.00" });
    expect((await api("getEstimate", { id: inExemptShop.id })).totals).toMatchObject({ tax: 0, total: 60, taxRateBps: 0 });
  });

  // Sent with no rate: the customer's page shows no tax, however the settings are later.
  const visitor = await as(null);
  await openCustomerQuote(visitor, link);
  expect(await custTotalLabels(visitor)).toEqual(["Subtotal", "Total"]);
  await expect(custTotal(visitor, "Total")).toHaveText("$72.00");
  await expect(visitor.locator(".inv .inv-tax")).toHaveCount(0);
  const shown = await (await visitor.request.get(shopUrl(shop.subdomain) + "/api/estimate?token=" + new URL(link).searchParams.get("estimate"))).json();
  expect(shown.estimate).toMatchObject({ tax: 0, total: 72, taxMode: "exclusive", taxRate: 0 });

  // Accepted while a rate is in force: the order is the exempt customer's, with no tax.
  const orderId = await withTax(api, { mode: "inclusive" }, () => acceptOnPage(visitor));
  const order = await orderOf(api, shop, orderId);
  expect(order).toMatchObject({ customerId: kim.id, taxExempt: true, salesTax: 0, total: 72, taxMode: "exclusive" });
  const pm = await openPayments(page, shop, orderId);
  await expect(pmRow(pm, "Subtotal")).toHaveText("$72.00");
  await expect(pmRow(pm, "Amount due")).toHaveText("$72.00");
  await expect(pmRow(pm, "Tax-exempt order")).toHaveText("—");
  await expect(pm).not.toContainText("added to the prices");
});

test("Changes asked: the quote follows the settings again, and sending the revision takes the rate of that day", async ({ page, api, as }) => {
  test.setTimeout(180_000);
  const shop = await taxableShop(api, "qtc");
  const ray = { name: uniq("Ray Revise"), email: email("ray") };
  ray.id = await newCustomer(api, { name: ray.name, email: ray.email });
  const q = await newQuote(api, shop, ray.id, "Polos");

  let link;
  await withTax(api, { mode: "exclusive" }, async () => {
    await openQuote(page, q.id);
    await addProduct(page, "Sample Tee", 3);
    await expectSums(page, { mode: "exclusive", subtotal: "$60.00", tax: "$4.35", total: "$64.35" });
    link = await sendQuote(page);
  });
  const inEffect = await taxNow(api);

  // The customer asks for changes while no rate is set: the quote is being worked on again, so it shows today's tax.
  const visitor = await as(null);
  await openCustomerQuote(visitor, link);
  await expect(custTotal(visitor, "Sales tax")).toHaveText("$4.35");
  await visitor.getByRole("button", { name: "Ask for changes" }).click();
  await visitor.getByLabel("What would you like changed?").fill("Four shirts, please.");
  const asked = visitor.waitForResponse(r => r.url().includes("/api/estimate") && r.request().method() === "POST");
  await visitor.getByRole("button", { name: "Send my request" }).click();
  expect((await (await asked).json()).status).toBe("ok");
  await expect(visitor.locator("#estState")).toContainText("we've sent your message");

  await openQuote(page, q.id);
  await expect(page.locator(".qt-callout-changes")).toContainText("Four shirts, please.");
  const live = await api("getEstimate", { id: q.id });
  expect(live.estimate.status).toBe("changes");
  expect(live.totals).toMatchObject({ subtotal: 60, tax: 0, taxRateBps: 0, taxMode: inEffect.taxMode });
  await expectSums(page, { mode: inEffect.taxMode, subtotal: "$60.00", tax: inEffect.taxMode === "exclusive" ? "$0.00" : null, total: "$60.00" });

  // Revised (a fourth shirt) and sent again on a day the rate is 3.5%, tax on top: that is what it keeps now.
  await withTax(api, { rate: RATE2, mode: "exclusive" }, async () => {
    await openQuote(page, q.id);
    const qty = page.getByRole("spinbutton", { name: "Quantity of Sample Tee" });
    const saved = savedEstimate(page);
    await qty.fill("4");
    await qty.press("Enter");
    await saved;
    // 3.5% on $80.00: $2.80.
    await expectSums(page, { mode: "exclusive", subtotal: "$80.00", tax: "$2.80", total: "$82.80" });
    await page.getByRole("button", { name: "Revise" }).click();
    await expect(toast(page)).toContainText("Quote revised. Send it again when it's ready.");
    const again = await sendQuote(page);
    expect(again).toBe(link);   // the same link
  });
  await openQuote(page, q.id);
  await expectSums(page, { mode: "exclusive", subtotal: "$80.00", tax: "$2.80", total: "$82.80" });
  expect((await api("getEstimate", { id: q.id })).totals).toEqual({ subtotal: 80, tax: 2.8, total: 82.8, taxMode: "exclusive", taxRateBps: 350 });
  await openCustomerQuote(visitor, link);
  await expect(custTotal(visitor, "Sales tax")).toHaveText("$2.80");
  await expect(visitor.locator(".inv table.inv-totals")).toContainText("Sales tax (3.5%");
  await expect(custTotal(visitor, "Total")).toHaveText("$82.80");
});
