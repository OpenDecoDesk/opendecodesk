// Customer records (migrations/0108): a customer's tax exemption, and merging two customers, in a real browser.
//
// The exemption: the owner ticks it on the customer's page with a certificate and an expiry. It counts only when
// staff PICK that customer on a Local sale (the sale then carries no sales tax); an order that merely has the
// customer's email (the storefront) joins their history but is taxed as usual, and so is a picked sale once the
// certificate's expiry date has passed. Changing it is written to the audit log, and is Full's alone.
//
// Merging: "Merge into another customer…" on the duplicate's page finds the customer to keep and says how many
// orders move. Afterwards the kept customer has all the orders, the duplicate is off the list, its exemption was
// not carried over, and a later order with the duplicate's email lands on the kept customer. Also audited.
//
// Sales tax needs a rate, which is one setting for the whole install and 0 between tests (settings.spec.mjs checks
// that). So the rate is set only for the moment an order is recorded (taxedWhile below) and put back at once; the
// shops here are made taxable (makeShop's are exempt unless asked). Every date in this file is fixed (2099, 2020),
// so nothing depends on today or on this computer's time zone.
import { test, expect, ADMIN, shopUrl, openAdmin, toast, uniq, slug, user, apiContext, callApi } from "../fixtures.mjs";
import { makeShop } from "../lib/data.mjs";

// A rate no other spec uses, so this file can tell its own from someone else's. $20 at 5.25%: $1.00 of tax inside
// the price (inclusive, the default), $1.05 on top of it (exclusive).
const RATE = 5.25;
const taxOnTwenty = (order) => order.taxMode === "exclusive" ? 1.05 : 1;
const rateNow = async (api) => (await api("getSalesTaxSettings")).salesTax;

// Runs `record` (the one click or request that places an order) with the sales tax rate set, then sets it back to
// none. Waits first while another spec has a rate of its own in force, and never undoes a rate that isn't this one.
async function taxedWhile(api, record) {
  await expect.poll(async () => { const r = (await rateNow(api)).ratePercent; return r === 0 || r === RATE; }, { timeout: 30_000 }).toBe(true);
  const before = await rateNow(api);
  await api("updateSalesTaxSettings", { ratePercent: RATE, jurisdiction: before.jurisdiction || "", taxMode: before.taxMode });
  try { return await record(); }
  finally {
    const now = await rateNow(api);
    if (now.ratePercent === RATE) await api("updateSalesTaxSettings", { ratePercent: 0, jurisdiction: now.jurisdiction || "", taxMode: now.taxMode });
  }
}

const taxableShop = (api, prefix) => makeShop(api, { prefix, taxExempt: false, products: [{ name: "Sample Tee", price: 20 }] });
const email = (who) => who + "." + slug("c") + "@example.test";
const newCustomer = async (api, fields) => (await api("saveCustomer", fields)).id;
const orderOf = async (api, shop, orderId) => (await api("getOrders", { org: shop.orgId })).orders.find(o => o.orderId === orderId);
const customerOf = (api, id) => api("getCustomer", { id });

// The customer's page, loaded afresh.
const openCustomer = async (page, id) => {
  await openAdmin(page, "customers/" + id);
  await expect(page.locator("#custForm")).toBeVisible();
};
const exemptBox = (page) => page.getByRole("checkbox", { name: /^Tax exempt: this customer's orders are not charged sales tax/ });
const certBox = (page) => page.getByLabel("Certificate number");
const expiresBox = (page) => page.getByLabel("Expires (blank = never)");
const saveCustomerForm = async (page) => {
  await page.locator("#custForm").getByRole("button", { name: "Save", exact: true }).click();
  await expect(toast(page)).toContainText("Customer saved.");
  await expect(page.locator("#custSave")).toBeEnabled();   // the page has drawn itself again from what was saved
};
// The Orders table on a customer's page: its order numbers, top to bottom.
const historyIds = async (page) => (await page.locator("#custPage table.cust-table tbody tr td:first-child").allTextContents()).map(s => s.trim());
const totalTile = (page, label) => page.locator(".cust-total").filter({ hasText: new RegExp("^\\s*\\S+\\s*" + label + "\\s*$") }).locator("b");

// A Local sale of one Sample Tee, paid in cash, for the customer found by typing `find` in the form's Customer
// box and picked from the list. Recorded while the tax rate is set. Returns { body (what the page sent), orderId }.
async function pickedSale(page, api, shop, find, { pickedText } = {}) {
  await openAdmin(page, "orders/" + shop.orgId);
  await expect(page.getByRole("combobox", { name: "Shop" })).toHaveValue(shop.orgId);
  await page.getByRole("button", { name: "+ Local sale" }).click();
  const form = page.locator("#localSaleForm");
  await expect(form).toBeVisible();
  await form.getByRole("searchbox", { name: "Customer (optional)" }).fill(find.name);
  const match = form.getByRole("group", { name: "Matching customers" }).getByRole("button").filter({ hasText: find.name });
  await expect(match).toHaveCount(1);
  if (find.listed) await find.listed(match);
  await match.click();
  const picked = form.locator("#lsCustomerPickedText");
  await expect(picked).toContainText("Picked: " + find.name);
  if (pickedText) await pickedText(picked);
  // Picking filled in who it is.
  await expect(form.locator("#lsName")).toHaveValue(find.name);
  await expect(form.locator("#lsEmail")).toHaveValue(find.email);
  await form.locator("#lsProduct").selectOption({ label: "Sample Tee" });
  await form.locator("#lsPayment").selectOption("Cash");
  await form.locator("#lsPaid").check();
  const sent = page.waitForRequest(req => req.url().endsWith("/api/orders") && /"action":"createLocalSale"/.test(req.postData() || ""));
  await taxedWhile(api, async () => {
    await form.getByRole("button", { name: "Record sale" }).click();
    await expect(toast(page)).toContainText("Local sale recorded — ");
  });
  const body = JSON.parse((await sent).postData());
  const mine = (await api("getOrders", { org: shop.orgId })).orders.filter(o => o.customerName === find.name);
  return { body, orders: mine };
}

// An order placed on the shop's own page by a customer who types `who.email` (pickup, by check), with the tax
// rate set for the moment it is placed. Returns the order number.
async function storefrontOrder(page, api, shop, who) {
  await page.goto(shopUrl(shop.subdomain) + "/");
  await expect(page.getByRole("heading", { level: 1, name: shop.name })).toBeVisible();
  const card = page.locator("main").getByRole("heading", { level: 3, name: "Sample Tee", exact: true }).locator("xpath=ancestor::*[.//button[normalize-space()='Add to cart']][1]");
  await card.getByRole("button", { name: "Add to cart" }).click();
  await page.getByLabel("Your name").fill(who.name);
  await page.getByLabel("Email address").fill(who.email);
  await page.getByLabel("Payment method").selectOption({ label: "Check" });
  await taxedWhile(api, async () => {
    await page.getByRole("button", { name: "Place order" }).click();
    await expect(page.getByRole("heading", { level: 2, name: /^Order received/ })).toBeVisible();
  });
  const line = await page.locator(".confirmation .order-number").textContent();
  return /^\s*(\S+)\s*·/.exec(line)[1];
}

// The audit entries of one kind about one customer, oldest first. The log is written before the change is saved
// (auditStrict), but the ordinary rows after the answer, so this waits until `count` are there.
const auditRows = async (api, filter, mine, count = 1) => {
  let hits = [];
  await expect.poll(async () => {
    const { entries } = await api("getAuditLog", { filter, limit: 200 });
    hits = entries.filter(e => e.detail && mine(e.detail));
    return hits.length;
  }, { timeout: 10_000 }).toBeGreaterThanOrEqual(count);
  return hits.slice().sort((a, b) => Number(a.id) - Number(b.id));
};
// The Audit log page, filtered to one action.
const searchAudit = async (page, action) => {
  await openAdmin(page, "audit");
  await page.locator("#afLimit").selectOption("200");
  await page.locator("#afAction").fill(action);
  const answered = page.waitForResponse(r => r.url().endsWith("/api/orders") && /"action":"getAuditLog"/.test(r.request().postData() || ""));
  await page.getByRole("button", { name: "Search" }).click();
  await answered;
  return page.locator("#auditResults");
};

test("Tax exemption: the owner marks a customer exempt; a Local sale with them picked has no tax, the same sale for another customer does", async ({ page, api }) => {
  test.setTimeout(120_000);
  const shop = await taxableShop(api, "cxa");
  const pat = { name: uniq("Pat Exempt"), email: email("pat") };
  const sam = { name: uniq("Sam Standard"), email: email("sam") };
  pat.id = await newCustomer(api, { name: pat.name, email: pat.email });
  sam.id = await newCustomer(api, { name: sam.name, email: sam.email });

  // The owner's page: not exempt yet, and the exemption can be edited (the owner has full access).
  await openCustomer(page, pat.id);
  const exemption = page.getByRole("group", { name: "Tax exemption" });
  await expect(exemption).toContainText("Applies to orders placed from now on, until the day it expires. Orders already placed keep the tax they were charged.");
  await expect(exemptBox(page)).not.toBeChecked();
  await expect(certBox(page)).toHaveValue("");
  await expect(expiresBox(page)).toHaveValue("");
  await expect(page.locator(".cust-sub .cust-tag")).toHaveCount(0);

  await exemptBox(page).check();
  await certBox(page).fill("EX-CERT-0001");
  await expiresBox(page).fill("2099-12-31");
  const saved = page.waitForRequest(req => req.url().endsWith("/api/orders") && /"action":"saveCustomer"/.test(req.postData() || ""));
  await saveCustomerForm(page);
  expect(JSON.parse((await saved).postData())).toMatchObject({ id: pat.id, taxExempt: true, taxExemptCertificate: "EX-CERT-0001", taxExemptExpires: "2099-12-31" });
  await expect(page.locator(".cust-sub .cust-tag")).toHaveText("Tax exempt");
  // …and it is what the server kept: a fresh load shows the same.
  await openCustomer(page, pat.id);
  await expect(exemptBox(page)).toBeChecked();
  await expect(certBox(page)).toHaveValue("EX-CERT-0001");
  await expect(expiresBox(page)).toHaveValue("2099-12-31");
  await expect(page.locator(".cust-sub .cust-tag")).toHaveText("Tax exempt");
  expect((await customerOf(api, pat.id)).customer).toMatchObject({ taxExempt: true, taxExemptCertificate: "EX-CERT-0001", taxExemptExpires: "2099-12-31" });

  // The list tags them; the other customer isn't tagged.
  await openAdmin(page, "customers");
  await page.getByLabel("Search").fill(pat.name);
  const patRow = page.locator("tr.cust-row", { hasText: pat.name });
  await expect(patRow).toHaveCount(1);
  await expect(patRow.locator(".cust-tag-exempt")).toHaveText("Exempt");
  await page.getByLabel("Search").fill(sam.name);
  const samRow = page.locator("tr.cust-row", { hasText: sam.name });
  await expect(samRow).toHaveCount(1);
  await expect(samRow.locator(".cust-tag")).toHaveCount(0);

  // A Local sale with the exempt customer picked: the list and the picked line say they are exempt, the page sends
  // their id, and the order carries no sales tax although a rate was in force.
  const exemptSale = await pickedSale(page, api, shop, {
    ...pat, listed: (match) => expect(match).toContainText("Exempt"),
  }, { pickedText: (picked) => expect(picked).toHaveText(new RegExp("^Picked: .* — tax exempt$")) });
  expect(exemptSale.body.customerId).toBe(pat.id);
  expect(exemptSale.orders).toHaveLength(1);
  const untaxed = exemptSale.orders[0];
  expect(untaxed.customerId).toBe(pat.id);
  expect(untaxed.taxExempt).toBe(true);
  expect(untaxed.salesTax).toBe(0);
  expect(untaxed.total).toBe(20);
  expect(untaxed.netSales).toBe(20);

  // The same sale for a customer who isn't exempt is taxed.
  const taxedSale = await pickedSale(page, api, shop, {
    ...sam, listed: (match) => expect(match).not.toContainText("Exempt"),
  }, { pickedText: (picked) => expect(picked).not.toContainText("tax exempt") });
  expect(taxedSale.body.customerId).toBe(sam.id);
  expect(taxedSale.orders).toHaveLength(1);
  const taxed = taxedSale.orders[0];
  expect(taxed.customerId).toBe(sam.id);
  expect(taxed.taxExempt).toBe(false);
  expect(taxed.taxRate).toBe(RATE);
  expect(taxed.salesTax).toBe(taxOnTwenty(taxed));
  expect(Math.round((taxed.netSales + taxed.salesTax) * 100)).toBe(Math.round(taxed.total * 100));

  // The audit log has the exemption, who set it and what changed; the save changed nothing else, so no "updated" row.
  const [entry] = await auditRows(api, "customer.exemption_changed", d => d.customerId === pat.id);
  expect(entry.detail.name).toBe(pat.name);
  expect(entry.detail.changes).toEqual({
    taxExempt: { from: false, to: true },
    taxExemptCertificate: { from: "", to: "EX-CERT-0001" },
    taxExemptExpires: { from: null, to: "2099-12-31" },
  });
  const { entries: updates } = await api("getAuditLog", { filter: "customer.updated", limit: 200 });
  expect(updates.filter(e => e.detail && e.detail.customerId === pat.id)).toEqual([]);
  const results = await searchAudit(page, "customer.exemption_changed");
  const row = results.locator("tbody tr", { hasText: pat.name });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("customer.exemption_changed");
  await expect(row).toContainText(user("owner").email);
  await expect(row).toContainText('"customerId":' + pat.id + ",");
});

test("Tax exemption: a storefront order with the exempt customer's email is taxed, and still lands in their history", async ({ page, api, as }) => {
  const shop = await taxableShop(api, "cxs");
  const pat = { name: uniq("Pat Online"), email: email("pat") };
  pat.id = await newCustomer(api, { name: pat.name, email: pat.email, taxExempt: true, taxExemptCertificate: "EX-CERT-0003", taxExemptExpires: "2099-12-31" });
  expect((await customerOf(api, pat.id)).totals.orderCount).toBe(0);

  const visitor = await as(null);
  // Typed in capitals: an email names the same customer however it is typed.
  const orderId = await storefrontOrder(visitor, api, shop, { name: "Someone Typing", email: pat.email.toUpperCase() });

  const order = await orderOf(api, shop, orderId);
  expect(order.customerId).toBe(pat.id);
  expect(order.taxExempt).toBe(false);
  expect(order.taxRate).toBe(RATE);
  expect(order.salesTax).toBe(taxOnTwenty(order));

  // The customer's page: the order is in their history and counted, and they are still exempt.
  await openCustomer(page, pat.id);
  expect(await historyIds(page)).toEqual([orderId]);
  await expect(totalTile(page, "Orders")).toHaveText("1");
  await expect(page.locator(".cust-sub .cust-tag")).toHaveText("Tax exempt");
  await expect(page.getByRole("heading", { level: 2, name: pat.name })).toBeVisible();   // the order's typed name didn't rename them
  // No second customer was made for that email.
  const { customers } = await api("listCustomers", { q: pat.email, includeArchived: true });
  expect(customers.map(c => c.id)).toEqual([pat.id]);
});

test("Tax exemption: once the expiry date has passed, a sale with the customer picked is taxed", async ({ page, api }) => {
  test.setTimeout(90_000);
  const shop = await taxableShop(api, "cxe");
  const lee = { name: uniq("Lee Lapsed"), email: email("lee") };
  lee.id = await newCustomer(api, { name: lee.name, email: lee.email, taxExempt: true, taxExemptCertificate: "EX-CERT-0004", taxExemptExpires: "2099-12-31" });

  // The owner changes only the expiry, to a day long gone.
  await openCustomer(page, lee.id);
  await expect(page.locator(".cust-sub .cust-tag")).toHaveText("Tax exempt");
  await expiresBox(page).fill("2020-01-01");
  await saveCustomerForm(page);
  await expect(page.locator(".cust-sub .cust-tag")).toHaveText("Exemption expired");
  await expect(exemptBox(page)).toBeChecked();
  await expect(expiresBox(page)).toHaveValue("2020-01-01");

  const sale = await pickedSale(page, api, shop, lee);
  expect(sale.body.customerId).toBe(lee.id);
  expect(sale.orders).toHaveLength(1);
  const order = sale.orders[0];
  expect(order.customerId).toBe(lee.id);
  expect(order.taxExempt).toBe(false);
  expect(order.taxRate).toBe(RATE);
  expect(order.salesTax).toBe(taxOnTwenty(order));

  // The log has the change of date, and only that.
  const [entry] = await auditRows(api, "customer.exemption_changed", d => d.customerId === lee.id);
  expect(entry.detail.changes).toEqual({ taxExemptExpires: { from: "2099-12-31", to: "2020-01-01" } });

  // An expiry that isn't a real day is refused in plain words, and the date stays.
  const bad = await api("saveCustomer", { id: lee.id, taxExemptExpires: "2027-02-31" }, { allowError: true, withStatus: true });
  expect(bad.status).toBe(400);
  expect(bad.data.message).toBe("The exemption's expiry date isn't a valid date.");
  expect((await customerOf(api, lee.id)).customer.taxExemptExpires).toBe("2020-01-01");
});

test("Merge: the duplicate's orders move to the customer kept, its exemption doesn't, and its email now leads to the one kept", async ({ page, api, as }) => {
  test.setTimeout(120_000);
  const shop = await taxableShop(api, "cxm");
  const keep = { name: uniq("Kerry Keep"), email: email("kerry") };
  const gone = { name: uniq("Dana Duplicate"), email: email("dana") };
  keep.id = await newCustomer(api, { name: keep.name, email: keep.email });
  gone.id = await newCustomer(api, { name: gone.name, email: gone.email, phone: "555-0100", taxExempt: true, taxExemptCertificate: "EX-CERT-0002", taxExemptExpires: "2099-12-31" });
  const sale = async (c) => (await api("createLocalSale", { org: shop.orgId, customerName: c.name, paymentMethod: "Cash", customerId: c.id,
    items: [{ productId: shop.products[0].productId, qty: 1 }] })).orderId;
  const goneOrders = [await sale(gone), await sale(gone)];
  const keepOrders = [await sale(keep)];
  expect((await customerOf(api, gone.id)).orders.map(o => o.orderId).sort()).toEqual(goneOrders.slice().sort());

  await openCustomer(page, gone.id);
  await expect(totalTile(page, "Orders")).toHaveText("2");
  await page.getByRole("button", { name: "Merge into another customer…" }).click();
  const dlg = page.locator(".admin-modal").filter({ has: page.getByRole("heading", { name: "Merge into another customer" }) });
  await expect(dlg).toBeVisible();
  await expect(dlg.locator("#custMergeIntro")).toHaveText(`Find the customer to keep. ${gone.name}'s orders move to it, and ${gone.name} is archived.`);
  const search = dlg.getByLabel("Search customers");
  await expect(search).toBeFocused();
  // The customer being merged is never offered as the one to keep.
  await search.fill(gone.name);
  await expect(dlg.locator("#custMergeStatus")).toHaveText("No other customer matches that search.");
  await expect(dlg.getByRole("group", { name: "Matching customers" }).getByRole("button")).toHaveCount(0);
  await search.fill(keep.name);
  await expect(dlg.locator("#custMergeStatus")).toHaveText("1 customer found");
  const choice = dlg.getByRole("group", { name: "Matching customers" }).getByRole("button");
  await expect(choice).toHaveCount(1);
  await expect(choice).toContainText(keep.name);
  await expect(choice).toContainText(keep.email + " · 1 order");
  await choice.click();

  // The question says who, how many orders move, that it can't be undone and that the exemption stays behind.
  const question = dlg.locator("#custMergeText");
  await expect(question).toBeVisible();
  await expect(question).toContainText(`Merge ${gone.name} into ${keep.name} (${keep.email})?`);
  await expect(question).toContainText(`2 orders will move to ${keep.name}. ${gone.name} is then archived and can't be used again. This can't be undone.`);
  await expect(question).toContainText(`A tax exemption is not carried over: if ${gone.name} is exempt, set the exemption on ${keep.name} yourself.`);
  // Enter must not merge by accident: the safe button has the focus, and it goes back to the search.
  const back = dlg.getByRole("button", { name: "Choose another" });
  await expect(back).toBeFocused();
  await back.click();
  await expect(question).toBeHidden();
  await expect(search).toBeFocused();
  // Nothing was sent by looking: both are as they were.
  expect((await customerOf(api, gone.id)).customer.id).toBe(gone.id);
  expect((await customerOf(api, keep.id)).totals.orderCount).toBe(1);

  await choice.click();
  const sent = page.waitForRequest(req => req.url().endsWith("/api/orders") && /"action":"mergeCustomers"/.test(req.postData() || ""));
  await dlg.getByRole("button", { name: "Merge", exact: true }).click();
  expect(JSON.parse((await sent).postData())).toMatchObject({ fromId: gone.id, intoId: keep.id });
  await expect(toast(page)).toContainText("Merged. 2 orders moved.");
  await expect(dlg).toHaveCount(0);

  // The page goes to the customer kept, who now has all three orders…
  await expect(page).toHaveURL(ADMIN + "/#customers/" + keep.id);
  await expect(page.getByRole("heading", { level: 2, name: keep.name })).toBeVisible();
  await expect(totalTile(page, "Orders")).toHaveText("3");
  expect((await historyIds(page)).sort()).toEqual([...goneOrders, ...keepOrders].sort());
  // …kept their own email, took the phone they didn't have, and did NOT become exempt from the other's certificate.
  await expect(page.getByLabel("Email", { exact: true })).toHaveValue(keep.email);
  await expect(page.getByLabel("Phone", { exact: true })).toHaveValue("555-0100");
  await expect(exemptBox(page)).not.toBeChecked();
  await expect(certBox(page)).toHaveValue("");
  await expect(expiresBox(page)).toHaveValue("");
  await expect(page.locator(".cust-sub .cust-tag")).toHaveCount(0);
  expect((await customerOf(api, keep.id)).customer).toMatchObject({ taxExempt: false, taxExemptCertificate: "", archived: false });
  for (const id of goneOrders) expect((await orderOf(api, shop, id)).customerId).toBe(keep.id);
  // A sale with the kept customer picked is taxed like anyone's.
  const after = await taxedWhile(api, () => sale(keep));
  const afterOrder = await orderOf(api, shop, after);
  expect(afterOrder.taxExempt).toBe(false);
  expect(afterOrder.salesTax).toBe(taxOnTwenty(afterOrder));

  // The duplicate is off the list, archived ones included; the one kept is there with its orders.
  await openAdmin(page, "customers");
  await page.getByLabel("Search").fill(gone.name);
  await expect(page.locator("#custBody")).toHaveText("No customer matches that search.");
  await page.getByRole("checkbox", { name: "Show archived" }).check();
  await expect(page.getByRole("checkbox", { name: "Show archived" })).toBeChecked();
  await page.getByLabel("Search").fill(gone.email);
  await expect(page.locator("#custBody")).toHaveText("No customer matches that search.");
  await page.getByLabel("Search").fill(gone.name);
  await expect(page.locator("#custBody")).toHaveText("No customer matches that search.");
  await page.getByLabel("Search").fill(keep.name);
  const keptRow = page.locator("tr.cust-row", { hasText: keep.name });
  await expect(keptRow).toHaveCount(1);
  await expect(keptRow.locator("td.cust-num")).toHaveText("4");
  await expect(keptRow.locator(".cust-tag")).toHaveCount(0);
  // The duplicate's old address opens the customer it was merged into.
  await openCustomer(page, gone.id);
  await expect(page.getByRole("heading", { level: 2, name: keep.name })).toBeVisible();
  await expect(page).toHaveURL(ADMIN + "/#customers/" + keep.id);

  // A new storefront order with the retired email lands on the customer kept, and makes no new customer.
  const visitor = await as(null);
  const webOrder = await storefrontOrder(visitor, api, shop, { name: gone.name, email: gone.email });
  expect((await orderOf(api, shop, webOrder)).customerId).toBe(keep.id);
  expect((await api("listCustomers", { q: gone.email, includeArchived: true })).customers).toEqual([]);
  await openCustomer(page, keep.id);
  await expect(totalTile(page, "Orders")).toHaveText("5");
  expect(await historyIds(page)).toContain(webOrder);

  // The audit log has the merge: who did it, which records, how many orders, and the exemption that was left behind.
  const [entry] = await auditRows(api, "customer.merged", d => d.fromId === gone.id);
  expect(entry.detail).toMatchObject({ fromId: gone.id, intoId: keep.id, orders: 2,
    from: { name: gone.name, email: gone.email, phone: "555-0100", taxExempt: true, taxExemptCertificate: "EX-CERT-0002", taxExemptExpires: "2099-12-31" },
    into: { name: keep.name, email: keep.email } });
  const results = await searchAudit(page, "customer.merged");
  const row = results.locator("tbody tr", { hasText: `"fromId":${gone.id},"intoId":${keep.id},` });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("customer.merged");
  await expect(row).toContainText(user("owner").email);
  await expect(row).toContainText(gone.name);

  // Merging the retired record again, or a customer into itself, is refused; nothing else is logged as merged.
  const again = await api("mergeCustomers", { fromId: gone.id, intoId: keep.id }, { allowError: true, withStatus: true });
  expect(again.status).toBe(400);
  expect(again.data.message).toBe("One of these customers was already merged into another one.");
  const self = await api("mergeCustomers", { fromId: keep.id, intoId: keep.id }, { allowError: true, withStatus: true });
  expect(self.status).toBe(400);
  expect(self.data.message).toBe("A customer can't be merged into themselves.");
  const { entries } = await api("getAuditLog", { filter: "customer.merge", limit: 200 });
  expect(entries.filter(e => e.detail && (e.detail.fromId === gone.id || e.detail.fromId === keep.id)).map(e => e.action)).toEqual(["customer.merged"]);
});

test("Back office can edit a customer but not their exemption or a merge: the page locks them and the server refuses", async ({ api, as }, testInfo) => {
  const pat = { name: uniq("Pat Certified"), email: email("pat") };
  const other = { name: uniq("Olive Other"), email: email("olive") };
  pat.id = await newCustomer(api, { name: pat.name, email: pat.email, taxExempt: true, taxExemptCertificate: "EX-CERT-0005", taxExemptExpires: "2099-12-31" });
  other.id = await newCustomer(api, { name: other.name, email: other.email });

  const page = await as("staff");
  await openCustomer(page, pat.id);
  const exemption = page.getByRole("group", { name: "Tax exemption" });
  await expect(exemption).toContainText("Only a role with full access to Customers can change a tax exemption.");
  // What is stored is shown, and can't be changed here.
  await expect(exemptBox(page)).toBeChecked();
  await expect(exemptBox(page)).toBeDisabled();
  await expect(certBox(page)).toHaveValue("EX-CERT-0005");
  await expect(certBox(page)).not.toBeEditable();
  await expect(expiresBox(page)).not.toBeEditable();
  await expect(page.getByRole("button", { name: "Merge into another customer…" })).toBeHidden();
  // The rest of the record is theirs to edit, and saving it leaves the exemption exactly as it was.
  await page.getByLabel("Notes").fill("Prefers pickup on Fridays.");
  const saved = page.waitForRequest(req => req.url().endsWith("/api/orders") && /"action":"saveCustomer"/.test(req.postData() || ""));
  await saveCustomerForm(page);
  expect(JSON.parse((await saved).postData())).toMatchObject({ taxExempt: true, taxExemptCertificate: "EX-CERT-0005", taxExemptExpires: "2099-12-31" });
  expect((await customerOf(api, pat.id)).customer).toMatchObject({ notes: "Prefers pickup on Fridays.", taxExempt: true, taxExemptCertificate: "EX-CERT-0005", taxExemptExpires: "2099-12-31" });

  // The server's own answer, whatever the page shows.
  const staff = await apiContext("staff", testInfo.workerIndex);
  const production = await apiContext("production", testInfo.workerIndex);
  try {
    const refusedExemption = "Your role can't change a customer's tax exemption. Ask an admin.";
    for (const change of [{ taxExempt: false }, { taxExemptCertificate: "EX-CERT-9999" }, { taxExemptExpires: "" }, { taxExemptExpires: "2098-01-01" }]) {
      const r = await callApi(staff, "saveCustomer", { id: pat.id, ...change }, { allowError: true, withStatus: true });
      expect(r.status, JSON.stringify(change)).toBe(403);
      expect(r.data.message).toBe(refusedExemption);
    }
    // Making a customer who is exempt from the start is the same change.
    const born = await callApi(staff, "saveCustomer", { name: uniq("Nico Newexempt"), taxExempt: true }, { allowError: true, withStatus: true });
    expect(born.status).toBe(403);
    expect(born.data.message).toBe(refusedExemption);
    for (const ctx of [staff, production]) {
      const r = await callApi(ctx, "mergeCustomers", { fromId: other.id, intoId: pat.id }, { allowError: true, withStatus: true });
      expect(r.status).toBe(403);
      expect(r.data.status).toBe("error");
    }
  } finally { await staff.dispose(); await production.dispose(); }
  // Nothing of it happened, and nothing of it is in the log.
  expect((await customerOf(api, pat.id)).customer).toMatchObject({ id: pat.id, taxExempt: true, taxExemptCertificate: "EX-CERT-0005", taxExemptExpires: "2099-12-31" });
  expect((await customerOf(api, other.id)).customer).toMatchObject({ id: other.id, archived: false });
  const log = async (filter) => (await api("getAuditLog", { filter, limit: 200 })).entries.filter(e => e.detail && (e.detail.customerId === pat.id || e.detail.fromId === other.id));
  expect(await log("customer.exemption")).toEqual([]);
  expect(await log("customer.merge")).toEqual([]);
});
