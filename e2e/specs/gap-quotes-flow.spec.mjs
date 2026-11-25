// Quotes end to end (migrations/0109), in a real browser:
//   - the owner starts a quote on the Quotes page (+ New quote: customer search, shop, title, expiry), adds a product
//     line whose quantity break applies, a product at a price set by hand, a custom line and a setup fee, changes and
//     removes lines, saves, and sends it (no email locally, so the Send window shows the link);
//   - the customer opens the link in a browser of their own, sees the quote as sent (break price with the list price
//     it came down from, fees, totals, the last day), steps in and out of Accept and Ask for changes, and accepts;
//   - the order is on the Orders page at the quoted prices, "From quote Q-…", linked to the customer, and the quote
//     says it was converted;
//   - a second quote, started from the customer's page: the customer asks for changes, Back office revises it and sends
//     it again (same link), then converts it to an order; Back office can't cancel a quote;
//   - an expired quote can't be accepted (nor sent again), and a link that isn't one says so;
//   - cancelling a quote, and the list's search and status filter.
//
// Every test makes its own shops, customer and quotes, with names no other test has. Dates are fixed (an expiry far
// in the future, or long past) so nothing depends on today's date or this computer's time zone.
import { test, expect, ADMIN, openAdmin, toast, slug, shopUrl, confirmDialog } from "../fixtures.mjs";
import { makeShop } from "../lib/data.mjs";

const FAR = "2099-12-31";            // an expiry that never comes
const FAR_LONG = "December 31, 2099";
const PAST = "2020-01-15";           // a last day long gone
const tagOf = () => slug("q");
const emailOf = (prefix) => slug(prefix) + "@example.test";
const PRODUCTS = [
  { name: "Sample Tee", price: 20, extra: { qtyBreaks: [{ minQty: 12, off: 2 }] } },
  { name: "Sample Cap", price: 15, type: "cap", idPrefix: "cap" },
];

// ---- data, made with the owner's session ---------------------------------------------------------------
const makeCustomer = async (api, c) => {
  const r = await api("saveCustomer", { name: "", company: "", email: "", phone: "", address: null, notes: "",
    taxExempt: false, taxExemptCertificate: "", taxExemptExpires: "", ...c });
  expect(r.created).toBe(true);
  return { id: r.id, name: "", company: "", email: "", phone: "", ...c };
};
// A sent quote for the customer: `items` as saveEstimate takes them. Returns { id, number, token }.
async function sentQuote(api, shop, c, { title = "Team shirts", items, expiresOn = FAR } = {}) {
  const made = await api("createEstimate", { org: shop.orgId, customerId: c.id, title, expiresOn });
  await api("saveEstimate", { id: made.id, items: items || [{ kind: "product", productId: shop.products[0].productId, size: "OSFA", qty: 3 }] });
  const sent = await api("sendEstimate", { id: made.id, email: c.email });
  const token = /\?estimate=([0-9a-f]{32})$/.exec(sent.link)[1];
  return { id: made.id, number: made.number, token };
}
const orderIdFor = (shop, number) => shop.orgId.replace(/[^A-Za-z0-9]/g, "").slice(0, 4).toUpperCase() + "-" + number.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
const orderOf = async (api, shop, orderId) => (await api("getOrders", { org: shop.orgId })).orders.find(o => o.orderId === orderId);

// ---- the admin's quote pages ------------------------------------------------------------------------------
const quotePage = async (page, id) => {
  await openAdmin(page, "quotes/" + id);
  await expect(page.locator("#qtPage h2.cust-name")).toBeVisible();
};
const head = (page) => page.locator("#qtPage h2.cust-name");
const lineRow = (page, text) => page.locator("#qtLines tbody tr").filter({ hasText: text });
// One line's cells: [item, qty, list, quantity price, unit, total(, change/remove)].
const lineCells = async (page, text) => (await lineRow(page, text).locator("td").allTextContents()).map(s => s.trim().replace(/\s+/g, " "));
const totalOf = (page) => page.locator("#qtTotals tr.qt-sum-total td");
const answerOf = (page, action) => page.waitForResponse(r => r.url().endsWith("/api/orders") && new RegExp(`"action":"${action}"`).test(r.request().postData() || ""));
// Saves through one of the line windows (or a quantity) and waits for the server's priced answer.
async function saving(page, fn) {
  const done = answerOf(page, "saveEstimate");
  await fn();
  const res = await done;
  const body = await res.json();
  expect(body.status).toBe("ok");
  return body;
}
// Opens Send…, sends, and reads the link from the window (no email goes out locally). Returns { token, answer, body }.
async function sendThroughPage(page, { title, email }) {
  await page.locator("#qtSend").click();
  const dlg = page.getByRole("dialog", { name: title });
  await expect(dlg).toBeVisible();
  if (email !== undefined) await dlg.locator("#qtSendEmail").fill(email);
  const sent = page.waitForRequest(r => r.url().endsWith("/api/orders") && /"action":"sendEstimate"/.test(r.postData() || ""));
  await dlg.locator("#qtSendGo").click();
  const req = await sent;
  const answer = await (await req.response()).json();
  expect(answer.status).toBe("ok");
  expect(answer.emailSent).toBe(false);
  await expect(dlg.locator("#qtSendLinkNote")).toHaveText("The quote is marked sent, but the email couldn't be sent. Copy this link and send it to the customer yourself.");
  await expect(dlg.locator("#qtSendLink")).toHaveValue(answer.link);
  await expect(dlg.locator("#qtSendLink")).toBeFocused();
  await expect(dlg.locator("#qtSendGo")).toHaveText("Done");
  await expect(dlg.locator("#qtSendCancel")).toBeHidden();
  await dlg.locator("#qtSendGo").click();
  await expect(dlg).toHaveCount(0);
  const m = /^https:\/\/([a-z0-9-]+)\.localhost\/\?estimate=([0-9a-f]{32})$/.exec(answer.link);
  expect(m, "the link is the shop's own address with a 32-character token: " + answer.link).not.toBeNull();
  return { subdomain: m[1], token: m[2], answer, body: JSON.parse(req.postData()) };
}

// ---- the customer's quote page -----------------------------------------------------------------------------
const openQuoteLink = async (cp, shop, token) => {
  await cp.goto(shopUrl(shop.subdomain) + "/?estimate=" + token);
  await expect(cp.getByRole("heading", { level: 1, name: shop.name })).toBeVisible();
};
// What the customer's page would send, from the page itself (same origin, the customer's own address).
const customerPost = (cp, body) => cp.evaluate(async (b) => {
  const r = await fetch("/api/estimate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
  return { status: r.status, data: await r.json() };
}, body);
const custRow = (cp, text) => cp.locator(".inv table.inv-items tbody tr").filter({ hasText: text });
const custCells = async (cp, text) => (await custRow(cp, text).locator("td").allTextContents()).map(s => s.trim().replace(/\s+/g, " "));

// =========================================================================================================
test("A quote end to end: the owner builds it with a quantity break, a custom line and a setup fee, sends it, the customer accepts, and the order is on the Orders page at the quoted prices", async ({ page, api, as }) => {
  const shop = await makeShop(api, { prefix: "qtf", products: PRODUCTS });
  await makeShop(api, { prefix: "qtg" });   // a second shop, so the New quote window always asks which one
  const tag = tagOf();
  const c = await makeCustomer(api, { name: "Pat Example " + tag, company: "Example Club " + tag, email: emailOf("pat"), phone: "555-0110" });

  // ---- + New quote -------------------------------------------------------------------------------------
  await openAdmin(page, "quotes");
  await expect(page.getByRole("navigation", { name: "Admin" }).getByRole("button", { name: "Quotes", exact: true })).toBeVisible();
  await expect(page.locator("#qtQ")).toHaveAttribute("placeholder", "Quote number, title or customer");
  await page.locator("#qtNew").click();
  const nq = page.getByRole("dialog", { name: "New quote" });
  await expect(nq).toBeVisible();
  await expect(nq.locator("#qtNewCust")).toBeFocused();
  // The expiry starts 30 days from the business's today (worked out by the page itself, so no clock is assumed here).
  const in30 = await page.evaluate(() => localToday_(30));
  await expect(nq.locator("#qtNewExpires")).toHaveValue(in30);
  // No customer picked yet.
  await nq.locator("#qtNewSave").click();
  await expect(nq.locator("#qtNewErr")).toHaveText("Search for the customer and pick them from the list first.");
  await expect(nq.locator("#qtNewCust")).toBeFocused();
  await nq.locator("#qtNewCust").fill(tag);
  await expect(nq.locator("#qtNewCustNote")).toHaveText("1 customer found.");
  await nq.locator("#qtNewCustList button").first().click();
  await expect(nq.locator("#qtNewPickedText")).toHaveText(`For ${c.name} · ${c.company} · ${c.email} · ${c.phone}`);
  await expect(nq.locator("#qtNewFind")).toBeHidden();
  await expect(nq.locator("#qtNewErr")).toHaveText("");
  await expect(nq.locator("#qtNewTitle")).toBeFocused();
  // Change goes back to the search, empty.
  await nq.locator("#qtNewChange").click();
  await expect(nq.locator("#qtNewPicked")).toBeHidden();
  await expect(nq.locator("#qtNewCust")).toHaveValue("");
  await expect(nq.locator("#qtNewCust")).toBeFocused();
  await nq.locator("#qtNewCust").fill(c.email);
  await expect(nq.locator("#qtNewCustNote")).toHaveText("1 customer found.");
  await nq.locator("#qtNewCust").press("Enter");     // Enter picks the only match
  await expect(nq.locator("#qtNewPickedText")).toHaveText(`For ${c.name} · ${c.company} · ${c.email} · ${c.phone}`);
  await nq.locator("#qtNewShop").selectOption(shop.orgId);
  await nq.locator("#qtNewTitle").fill("Team shirts " + tag);
  // A last day already gone is refused before anything is sent.
  await nq.locator("#qtNewExpires").fill(PAST);
  await nq.locator("#qtNewSave").click();
  await expect(nq.locator("#qtNewErr")).toHaveText("The last day to accept can't be in the past.");
  await expect(nq.locator("#qtNewExpires")).toBeFocused();
  await nq.locator("#qtNewExpires").fill(FAR);
  const created = answerOf(page, "createEstimate");
  await nq.locator("#qtNewSave").click();
  const made = await (await created).json();
  expect(made.status).toBe("ok");
  expect(made.number).toMatch(/^Q-\d{5,}$/);
  const number = made.number, id = made.id;
  await expect(nq).toHaveCount(0);
  await expect(toast(page)).toContainText(`Quote ${number} started.`);
  await expect(page).toHaveURL(new RegExp(`#quotes/${id}$`));

  // ---- the new quote: empty, a draft ----------------------------------------------------------------------
  await expect(head(page)).toContainText(`${number} · Team shirts ${tag}`);
  await expect(head(page).locator(".qt-st-draft")).toHaveText("Draft");
  await expect(page.locator("#qtPage .cust-sub").first()).toContainText("For " + c.name);
  await expect(page.locator("#qtPage .cust-sub a.cust-link")).toHaveAttribute("href", "#customers/" + c.id);
  await expect(page.locator("#qtLines")).toHaveText("No lines yet. Add a product, a custom line or a fee.");
  await expect(page.locator("#qtExpires")).toHaveValue(FAR);
  await expect(page.locator("#qtSend")).toHaveText("Send…");
  await expect(page.locator("#qtConvert")).toHaveText("Convert to order…");
  await expect(page.locator("#qtCancel")).toHaveText("Cancel quote…");
  await expect(page.locator("#qtSave")).toHaveText("Save");
  // Nothing to send yet.
  await page.locator("#qtSend").click();
  await expect(page.locator("#qtErr")).toHaveText("Add at least one line before sending the quote.");

  // ---- + Product: 12 tees, the 12+ break applies -----------------------------------------------------------
  await page.locator("#qtAddProduct").click();
  let dlg = page.getByRole("dialog", { name: "Add a product" });
  await expect(dlg).toBeVisible();
  await dlg.locator("#qtProd").selectOption({ label: "Sample Cap" });
  await expect(dlg.locator("#qtProdPreview")).toHaveText("Catalog price $15.00 each.");
  await dlg.locator("#qtProd").selectOption({ label: "Sample Tee" });
  await expect(dlg.locator("#qtProdPreview")).toHaveText("Catalog price $20.00 each. Quantity prices: 12+ pieces, $2.00 off each — counted across every line of this product on the quote.");
  await expect(dlg.locator("#qtProdSizeWrap")).toBeHidden();       // a flat-price product has no sizes
  await expect(dlg.locator("#qtProdPersWrap")).toBeHidden();       // nor personalization
  await expect(dlg.locator("#qtProdOwnWrap")).toBeHidden();
  await dlg.locator("#qtProdQty").fill("0");
  await dlg.locator("#qtProdSave").click();
  await expect(dlg.locator("#qtProdErr")).toHaveText("Enter a quantity from 1 to 5,000.");
  await expect(dlg.locator("#qtProdQty")).toBeFocused();
  await dlg.locator("#qtProdQty").fill("12");
  let a = await saving(page, () => dlg.locator("#qtProdSave").click());
  expect(a.items[0]).toMatchObject({ kind: "product", productId: shop.products[0].productId, qty: 12, unitPrice: 18, listUnitPrice: 20 });
  await expect(dlg).toHaveCount(0);
  expect(await lineCells(page, "Sample Tee")).toEqual(["Sample Tee", "", "$20.00", "−$2.00", "$18.00", "$216.00", "Change Remove"]);
  await expect(lineRow(page, "Sample Tee").locator("input[data-qt-qty]")).toHaveValue("12");
  await expect(totalOf(page)).toHaveText("$216.00");
  await expect(page.locator("#qtTotals .cust-note")).toHaveText("Prices follow the catalog until the quote is sent; from then on they are fixed.");

  // One piece fewer is below the break: the server prices it again at the list price.
  const qty = lineRow(page, "Sample Tee").locator("input[data-qt-qty]");
  await qty.fill("0");
  await qty.press("Enter");
  await expect(page.locator("#qtErr")).toHaveText("A quantity is a whole number from 1 to 5,000.");
  await qty.fill("11");
  a = await saving(page, () => qty.press("Enter"));
  expect(a.items[0]).toMatchObject({ qty: 11, unitPrice: 20 });
  expect(await lineCells(page, "Sample Tee")).toEqual(["Sample Tee", "", "$20.00", "", "$20.00", "$220.00", "Change Remove"]);
  await expect(totalOf(page)).toHaveText("$220.00");
  // Back to 12 through the line's own Change window.
  await lineRow(page, "Sample Tee").getByRole("button", { name: "Change Sample Tee" }).click();
  dlg = page.getByRole("dialog", { name: "Change product line" });
  await expect(dlg.locator("#qtProd")).toHaveValue(shop.products[0].productId);
  await expect(dlg.locator("#qtProdQty")).toHaveValue("11");
  await dlg.locator("#qtProdQty").fill("12");
  await saving(page, () => dlg.getByRole("button", { name: "Save line" }).click());
  await expect(dlg).toHaveCount(0);
  expect(await lineCells(page, "Sample Tee")).toEqual(["Sample Tee", "", "$20.00", "−$2.00", "$18.00", "$216.00", "Change Remove"]);

  // ---- + Product at a price set by hand (the owner may) -----------------------------------------------------
  await page.locator("#qtAddProduct").click();
  dlg = page.getByRole("dialog", { name: "Add a product" });
  await dlg.locator("#qtProd").selectOption({ label: "Sample Cap" });
  await dlg.locator("#qtProdQty").fill("2");
  await dlg.locator("#qtProdOwn").check();
  await expect(dlg.locator("#qtProdOwnWrap")).toBeVisible();
  await expect(dlg.locator("#qtProdPreview")).toHaveText("Price set by hand.");
  await dlg.locator("#qtProdSave").click();
  await expect(dlg.locator("#qtProdErr")).toHaveText("Enter the price per piece (0 or more, like 12.50).");
  await expect(dlg.locator("#qtProdOwnPrice")).toBeFocused();
  await dlg.locator("#qtProdOwnPrice").fill("12.50");
  const capSave = page.waitForRequest(r => r.url().endsWith("/api/orders") && /"action":"saveEstimate"/.test(r.postData() || ""));
  a = await saving(page, () => dlg.locator("#qtProdSave").click());
  const capItems = JSON.parse((await capSave).postData()).items;
  expect(capItems[1]).toMatchObject({ kind: "product", productId: shop.products[1].productId, qty: 2, customUnitPrice: 12.5 });
  expect(a.items[1]).toMatchObject({ qty: 2, unitPrice: 12.5, customPrice: true });
  expect(await lineCells(page, "Sample Cap")).toEqual(["Sample CapPrice set by hand", "", "$12.50", "", "$12.50", "$25.00", "Change Remove"]);
  await expect(totalOf(page)).toHaveText("$241.00");

  // ---- + Custom line ------------------------------------------------------------------------------------
  await page.locator("#qtAddCustom").click();
  dlg = page.getByRole("dialog", { name: "Add a custom line" });
  await expect(dlg.locator("#qtOtherName")).toBeFocused();
  await expect(dlg.locator("#qtOtherTax")).toBeChecked();
  await dlg.locator("#qtOtherSave").click();
  await expect(dlg.locator("#qtOtherErr")).toHaveText("Describe the line, as the customer will read it.");
  await dlg.locator("#qtOtherName").fill("Extra patch");
  await dlg.locator("#qtOtherQty").fill("0");
  await dlg.locator("#qtOtherSave").click();
  await expect(dlg.locator("#qtOtherErr")).toHaveText("Enter a quantity from 1 to 5,000.");
  await dlg.locator("#qtOtherQty").fill("12");
  await dlg.locator("#qtOtherSave").click();
  await expect(dlg.locator("#qtOtherErr")).toHaveText("Enter the price per piece (0 or more, like 12.50).");
  await dlg.locator("#qtOtherPrice").fill("3");
  await dlg.locator("#qtOtherTax").uncheck();
  a = await saving(page, () => dlg.locator("#qtOtherSave").click());
  expect(a.items[2]).toMatchObject({ kind: "custom", name: "Extra patch", qty: 12, unitPrice: 3, taxable: false });
  expect(await lineCells(page, "Extra patch")).toEqual(["Extra patchCustom line · Not taxed", "", "", "", "$3.00", "$36.00", "Change Remove"]);
  // Changed: its window opens with what it has.
  await lineRow(page, "Extra patch").getByRole("button", { name: "Change Extra patch" }).click();
  dlg = page.getByRole("dialog", { name: "Change custom line" });
  await expect(dlg.locator("#qtOtherName")).toHaveValue("Extra patch");
  await expect(dlg.locator("#qtOtherQty")).toHaveValue("12");
  await expect(dlg.locator("#qtOtherPrice")).toHaveValue("3.00");
  await expect(dlg.locator("#qtOtherTax")).not.toBeChecked();
  await dlg.locator("#qtOtherPrice").fill("3.50");
  await saving(page, () => dlg.getByRole("button", { name: "Save line" }).click());
  expect(await lineCells(page, "Extra patch")).toEqual(["Extra patchCustom line · Not taxed", "", "", "", "$3.50", "$42.00", "Change Remove"]);

  // ---- + Fee: a setup fee, and a digitizing fee taken off again ----------------------------------------------
  await page.locator("#qtAddFee").click();
  dlg = page.getByRole("dialog", { name: "Add a fee" });
  await expect(dlg.locator("#qtOtherKind")).toBeFocused();
  await expect(dlg.locator("#qtOtherQty")).toHaveCount(0);      // a fee is one amount, once
  await dlg.locator("#qtOtherKind").selectOption({ label: "Setup fee" });
  await dlg.locator("#qtOtherName").fill("Left logo");
  await dlg.locator("#qtOtherSave").click();
  await expect(dlg.locator("#qtOtherErr")).toHaveText("Enter the fee's amount (more than 0, like 25.00).");
  await dlg.locator("#qtOtherPrice").fill("0");
  await dlg.locator("#qtOtherSave").click();
  await expect(dlg.locator("#qtOtherErr")).toHaveText("Enter the fee's amount (more than 0, like 25.00).");
  await dlg.locator("#qtOtherPrice").fill("25");
  a = await saving(page, () => dlg.locator("#qtOtherSave").click());
  expect(a.items[3]).toMatchObject({ kind: "fee", feeKind: "setup", name: "Left logo", qty: 1, unitPrice: 25, taxable: true });
  expect(await lineCells(page, "Setup fee")).toEqual(["Setup fee — Left logo", "1", "", "", "$25.00", "$25.00", "Change Remove"]);
  await page.locator("#qtAddFee").click();
  dlg = page.getByRole("dialog", { name: "Add a fee" });
  await dlg.locator("#qtOtherKind").selectOption({ label: "Digitizing fee" });
  await dlg.locator("#qtOtherPrice").fill("40");
  a = await saving(page, () => dlg.locator("#qtOtherSave").click());
  expect(a.items[4]).toMatchObject({ kind: "fee", feeKind: "digitizing", name: "Digitizing fee" });   // no description: the kind's name
  expect(await lineCells(page, "Digitizing fee")).toEqual(["Digitizing fee", "1", "", "", "$40.00", "$40.00", "Change Remove"]);
  await expect(totalOf(page)).toHaveText("$348.00");
  a = await saving(page, () => page.getByRole("button", { name: "Remove Digitizing fee" }).click());
  expect(a.items.map(i => i.kind)).toEqual(["product", "product", "custom", "fee"]);
  await expect(lineRow(page, "Digitizing fee")).toHaveCount(0);
  await expect(page.locator("#qtAddProduct")).toBeFocused();
  await expect(totalOf(page)).toHaveText("$308.00");

  // ---- the notes, saved with Save --------------------------------------------------------------------------
  await page.locator("#qtMessage").fill("Thanks for asking, " + c.name + ".");
  await page.locator("#qtInternal").fill("Staff only: rush if they accept by Friday.");
  await expect(page.locator("#qtSaved")).toHaveText("");
  const fieldsSave = page.waitForRequest(r => r.url().endsWith("/api/orders") && /"action":"saveEstimate"/.test(r.postData() || ""));
  await page.locator("#qtSave").click();
  const fieldsBody = JSON.parse((await fieldsSave).postData());
  expect(fieldsBody).toMatchObject({ title: "Team shirts " + tag, message: "Thanks for asking, " + c.name + ".", internalNote: "Staff only: rush if they accept by Friday.", expiresOn: FAR });
  expect(fieldsBody.items).toHaveLength(4);
  await expect(toast(page)).toContainText("Quote saved.");
  await expect(page.locator("#qtSaved")).toHaveText("Saved.");

  // ---- Send… -----------------------------------------------------------------------------------------------
  await page.locator("#qtSend").click();
  let send = page.getByRole("dialog", { name: "Send " + number });
  await expect(send.locator(".cust-note").first()).toHaveText("The customer gets a link to see the quote, and to accept it or ask for changes. From now on its prices are fixed.");
  await expect(send.locator("#qtSendEmail")).toHaveValue(c.email);
  await expect(send.locator("#qtSendEmail")).toBeFocused();
  await expect(send.locator("#qtSendMsg")).toHaveValue("Thanks for asking, " + c.name + ".");
  await send.locator("#qtSendEmail").fill("not an address");
  await send.locator("#qtSendGo").click();
  await expect(send.locator("#qtSendErr")).toHaveText("Enter the email address to send the quote to.");
  await send.locator("#qtSendCancel").click();        // the email was changed, so it asks before closing
  await confirmDialog(page, "Discard");
  await expect(send).toHaveCount(0);
  const s1 = await sendThroughPage(page, { title: "Send " + number });
  expect(s1.body).toMatchObject({ id, email: c.email, message: "Thanks for asking, " + c.name + "." });
  expect(s1.subdomain).toBe(shop.subdomain);
  expect(s1.answer.sentTo).toBe(c.email);

  // Sent: its lines are fixed, its fields (but the internal note) only through the server's rules.
  await expect(head(page).locator(".qt-st-sent")).toHaveText("Sent");
  await expect(page.locator("#qtSend")).toHaveText("Send again…");
  await expect(page.locator("#qtPage .cust-sub").nth(1)).toContainText("to " + c.email);
  await expect(page.locator("#qtPage .cust-sub").nth(1)).not.toContainText("times");
  await expect(page.locator("#qtPage .cust-note").first()).toHaveText("This quote has been sent, so its lines and prices are fixed; its title, notes and expiry can still change. Its lines can change again if the customer asks for changes.");
  await expect(page.locator("#qtAddProduct")).toHaveCount(0);
  await expect(page.locator("#qtLines input[data-qt-qty]")).toHaveCount(0);
  await expect(page.locator("#qtLines").getByRole("button", { name: /^Change / })).toHaveCount(0);
  await expect(page.locator("#qtTotals .cust-note")).toHaveCount(0);
  await expect(page.locator("#qtSave")).toHaveText("Save");
  // Send again… keeps the same link.
  await page.locator("#qtSend").click();
  send = page.getByRole("dialog", { name: "Send again: " + number });
  await expect(send.locator(".cust-note").first()).toHaveText("The customer gets the same link again.");
  await expect(send.locator("#qtSendGo")).toHaveText("Send again");
  await send.locator("#qtSendCancel").click();
  await expect(send).toHaveCount(0);
  const s2 = await sendThroughPage(page, { title: "Send again: " + number });
  expect(s2.token).toBe(s1.token);
  await expect(page.locator("#qtPage .cust-sub").nth(1)).toContainText("(2 times)");
  // A sent quote's lines can't be changed by asking the server either.
  const refusedLines = await api("saveEstimate", { id, items: [] }, { allowError: true, withStatus: true });
  expect(refusedLines.status).toBe(409);
  expect(refusedLines.data.message).toBe("This quote was sent: its lines can't change unless the customer asks for changes. Cancel it and make a new one instead.");

  // ---- the customer's page -------------------------------------------------------------------------------
  const cp = await as(null);
  await openQuoteLink(cp, shop, s1.token);
  await expect(cp).toHaveTitle("Quote — " + number);
  await expect(cp.locator(".inv-sub")).toContainText(`Quote ${number} · ${c.name}`);
  await expect(cp.getByRole("heading", { level: 2, name: "Team shirts " + tag })).toBeVisible();
  await expect(cp.locator(".inv-note")).toHaveText("Thanks for asking, " + c.name + ".");
  await expect(cp.locator(".inv")).not.toContainText("Staff only");
  expect(await custCells(cp, "Sample Tee")).toEqual(["Sample Tee", "12", "$18.00was $20.00", "$216.00"]);
  await expect(custRow(cp, "Sample Tee").locator("del")).toHaveText("$20.00");
  expect(await custCells(cp, "Sample Cap")).toEqual(["Sample Cap", "2", "$12.50", "$25.00"]);   // a price set by hand has no "was"
  expect(await custCells(cp, "Extra patch")).toEqual(["Extra patch", "12", "$3.50", "$42.00"]);
  await expect(cp.locator(".inv table.inv-items").nth(1).locator("thead")).toContainText("One-time charges");
  expect(await custCells(cp, "Setup fee")).toEqual(["Setup fee — Left logo", "$25.00"]);
  await expect(cp.locator(".inv-totals")).toContainText("Subtotal$308.00");
  await expect(cp.locator(".inv-totals tr.inv-total")).toContainText("$308.00");
  await expect(cp.getByRole("heading", { level: 2, name: "Your answer" })).toBeVisible();
  await expect(cp.locator(".inv")).toContainText("You can accept this quote until " + FAR_LONG + ".");
  // Accept asks first, in the page; Not yet and Escape step back out.
  await cp.locator("#estAccept").click();
  await expect(cp.locator("#estConfirmText")).toHaveText("Accept this quote and place the order for $308.00? We'll start on it and email you the invoice.");
  await expect(cp.locator("#estAcceptYes")).toBeFocused();
  await expect(cp.locator("#estAskOpen")).toHaveCount(0);
  await cp.locator("#estAcceptNo").click();
  await expect(cp.locator("#estConfirm")).toHaveCount(0);
  await expect(cp.locator("#estAccept")).toBeFocused();
  await cp.locator("#estAccept").click();
  await cp.locator("#estAcceptYes").press("Escape");
  await expect(cp.locator("#estConfirm")).toHaveCount(0);
  await expect(cp.locator("#estAccept")).toBeFocused();
  // Ask for changes opens a box (Accept goes away meanwhile); Cancel closes it.
  await cp.locator("#estAskOpen").click();
  await expect(cp.locator("#estNote")).toBeFocused();
  await expect(cp.locator("#estAccept")).toHaveCount(0);
  await cp.locator("#estAskCancel").click();
  await expect(cp.locator("#estAsk")).toHaveCount(0);
  await expect(cp.locator("#estAskOpen")).toBeFocused();
  // Accept.
  await cp.locator("#estAccept").click();
  const accepted = cp.waitForResponse(r => r.url().endsWith("/api/estimate") && r.request().method() === "POST");
  await cp.locator("#estAcceptYes").click();
  const acc = await (await accepted).json();
  const orderId = orderIdFor(shop, number);
  expect(acc).toMatchObject({ status: "ok", action: "accept", orderId, invoiceSent: false });
  await expect(cp.locator("#estState")).toHaveText(`Thank you — your order ${orderId} is placed. We'll be in touch about payment.`);
  await expect(cp.locator("#estState")).toBeFocused();
  await expect(cp.locator("#estAccept")).toHaveCount(0);
  await expect(cp.locator("#estAskOpen")).toHaveCount(0);
  // Opened again: accepted, the order named, nothing left to answer.
  await openQuoteLink(cp, shop, s1.token);
  await expect(cp.locator(".inv-banner")).toContainText(`This quote has been accepted — it's order ${orderId}.`);
  await expect(cp.locator("#estAccept")).toHaveCount(0);
  await expect(cp.locator(".inv")).not.toContainText("Valid until");
  // A second accept is refused, naming the order.
  const again = await customerPost(cp, { token: s1.token, action: "accept" });
  expect(again.status).toBe(409);
  expect(again.data.message).toBe(`This quote has already been accepted — your order is ${orderId}.`);

  // ---- the order: on the Orders page at the quoted prices, from the quote, on the customer's record ---------
  const o = await orderOf(api, shop, orderId);
  expect(o.customerId).toBe(c.id);
  expect(o.estimate).toEqual({ id, number });
  expect(Number(o.total)).toBe(308);
  await openAdmin(page, "orders/" + shop.orgId);
  const rows = page.locator(`tr[data-order="${orderId}"]`);
  await expect(rows.filter({ hasText: "Sample Tee" })).toContainText("$216.00");
  await expect(rows.filter({ hasText: "Sample Cap" })).toContainText("$25.00");
  await expect(rows.filter({ hasText: "Extra patch" })).toContainText("$42.00");
  await expect(rows.filter({ hasText: "Setup fee — Left logo" })).toContainText("$25.00");
  const pill = rows.first().locator("a.order-estimate-link");
  await expect(pill).toHaveText("From quote " + number);
  await expect(pill).toHaveAttribute("href", `#/quotes/${id}`);
  await expect(rows.first().locator("a.order-customer-link")).toHaveAttribute("href", "#/customers/" + c.id);
  await expect(rows.first().locator("a.order-customer-link")).toHaveText(c.name);
  // The pill opens the quote, which now says it was converted, with nothing left to do.
  await pill.click();
  await expect(head(page)).toContainText(number);
  await expect(head(page).locator(".qt-st-converted")).toHaveText("Converted");
  await expect(page.locator("#qtPage .cust-sub").nth(1)).toContainText("Opened by the customer");
  await expect(page.locator("#qtPage .qt-callout").first()).toContainText(`Converted to order ${orderId} on `);
  await expect(page.locator("#qtSend")).toHaveCount(0);
  await expect(page.locator("#qtConvert")).toHaveCount(0);
  await expect(page.locator("#qtCancel")).toHaveCount(0);
  await expect(page.locator("#qtSave")).toHaveCount(0);
  await expect(page.locator("#qtTitle")).toBeDisabled();
  await expect(page.locator("#qtInternal")).toBeDisabled();
  // Its order link opens the order on the Orders page.
  await page.locator("#qtOrderLink").click();
  await expect(page.locator(`tr[data-order="${orderId}"]`).first()).toBeVisible();
  // A converted quote can't be cancelled.
  const noCancel = await api("cancelEstimate", { id }, { allowError: true, withStatus: true });
  expect(noCancel.status).toBe(409);
  expect(noCancel.data.message).toBe(`This quote is already order ${orderId}. Void or edit the order instead.`);
});

// =========================================================================================================
test("The customer asks for changes; Back office revises the quote, sends it again on the same link, and converts it to an order", async ({ page, api, as }) => {
  const shop = await makeShop(api, { prefix: "qtc", products: PRODUCTS });
  await makeShop(api, { prefix: "qth" });
  const tag = tagOf();
  // No email on the record: the quote goes to an address typed in Send, and only the record's id ties the order to them.
  const c = await makeCustomer(api, { name: "Robin Example " + tag, phone: "555-0111" });
  const sendTo = emailOf("robin");

  // Started from the customer's page: the New quote window opens with them picked.
  await openAdmin(page, "customers/" + c.id);
  await expect(page.locator("#custPage")).toContainText("No quotes yet.");
  await page.locator("#custNewQuote").click();
  const nq = page.getByRole("dialog", { name: "New quote" });
  await expect(nq.locator("#qtNewPickedText")).toHaveText(`For ${c.name} · ${c.phone}`);
  await expect(nq.locator("#qtNewTitle")).toBeFocused();
  await nq.locator("#qtNewShop").selectOption(shop.orgId);
  await nq.locator("#qtNewTitle").fill("Club caps " + tag);
  await nq.locator("#qtNewExpires").fill(FAR);
  const created = answerOf(page, "createEstimate");
  await nq.locator("#qtNewSave").click();
  const { id, number } = await (await created).json();
  await expect(head(page)).toContainText(`${number} · Club caps ${tag}`);
  await page.locator("#qtAddProduct").click();
  const dlg = page.getByRole("dialog", { name: "Add a product" });
  await dlg.locator("#qtProd").selectOption({ label: "Sample Tee" });
  await dlg.locator("#qtProdQty").fill("6");
  await saving(page, () => dlg.locator("#qtProdSave").click());
  await expect(totalOf(page)).toHaveText("$120.00");
  // Send… with no address to start from: it asks for one.
  await page.locator("#qtSend").click();
  const first = page.getByRole("dialog", { name: "Send " + number });
  await expect(first.locator("#qtSendEmail")).toHaveValue("");
  await first.locator("#qtSendGo").click();
  await expect(first.locator("#qtSendErr")).toHaveText("Enter the email address to send the quote to.");
  await first.locator("#qtSendCancel").click();
  await expect(first).toHaveCount(0);
  const s1 = await sendThroughPage(page, { title: "Send " + number, email: sendTo });
  expect(s1.answer.sentTo).toBe(sendTo);

  // The customer's page lists it on their record.
  await openAdmin(page, "customers/" + c.id);
  const qrow = page.locator("#custPage table.cust-quotes tbody tr").filter({ hasText: number });
  await expect(qrow).toContainText("Sent");
  await expect(qrow).toContainText("$120.00");

  // ---- the customer asks for changes ----------------------------------------------------------------------
  const cp = await as(null);
  await openQuoteLink(cp, shop, s1.token);
  expect(await custCells(cp, "Sample Tee")).toEqual(["Sample Tee", "6", "$20.00", "$120.00"]);
  await cp.locator("#estAskOpen").click();
  await cp.locator("#estAskSend").click();
  await expect(cp.locator("#estErr")).toHaveText("Tell us what you'd like changed.");
  await expect(cp.locator("#estNote")).toBeFocused();
  // Escape closes the box and keeps what was typed for next time.
  await cp.locator("#estNote").fill("Please make it 12 shirts.");
  await cp.locator("#estNote").press("Escape");
  await expect(cp.locator("#estAsk")).toHaveCount(0);
  await expect(cp.locator("#estAskOpen")).toBeFocused();
  await cp.locator("#estAskOpen").click();
  await expect(cp.locator("#estNote")).toHaveValue("Please make it 12 shirts.");
  const asked = cp.waitForResponse(r => r.url().endsWith("/api/estimate") && r.request().method() === "POST");
  await cp.locator("#estAskSend").click();
  const askedBody = JSON.parse((await asked).request().postData());
  expect(askedBody).toEqual({ token: s1.token, action: "changes", note: "Please make it 12 shirts." });
  await expect(cp.locator("#estState")).toHaveText(`Thanks — we've sent your message to ${shop.name}. We'll get back to you with a revised quote.`);
  // Opened again: waiting on the revision; it can't be accepted meanwhile.
  await openQuoteLink(cp, shop, s1.token);
  await expect(cp.locator(".inv-banner")).toContainText("You asked for changes on ");
  await expect(cp.locator(".inv-banner")).toContainText("We'll send you a revised quote.");
  await expect(cp.locator(".inv-banner")).toContainText("Your message: Please make it 12 shirts.");
  await expect(cp.locator("#estAccept")).toHaveCount(0);
  const early = await customerPost(cp, { token: s1.token, action: "accept" });
  expect(early.status).toBe(409);
  expect(early.data.message).toBe("You've asked for changes to this quote — we'll send you the revised quote to accept.");
  const noNote = await customerPost(cp, { token: s1.token, action: "changes", note: "  " });
  expect(noNote.status).toBe(400);
  expect(noNote.data.message).toBe("Please tell us what you'd like changed.");

  // ---- Back office revises it -----------------------------------------------------------------------------
  const sp = await as("staff");
  await quotePage(sp, id);
  await expect(head(sp).locator(".qt-st-changes")).toHaveText("Changes asked");
  await expect(sp.locator("#qtPage .qt-callout-changes")).toContainText("The customer asked for changes on ");
  await expect(sp.locator("#qtPage .qt-callout-changes .qt-quote-text")).toHaveText("Please make it 12 shirts.");
  await expect(sp.locator("#qtPage .qt-callout-changes")).toContainText("Change the quote, press Revise, then send it again.");
  await expect(sp.locator("#qtSave")).toHaveText("Revise");
  await expect(sp.locator("#qtSend")).toHaveText("Send…");
  await expect(sp.locator("#qtAddProduct")).toBeVisible();
  // Cancelling is Full's: Back office isn't offered it, and the server refuses it.
  await expect(sp.locator("#qtCancel")).toBeHidden();
  const refused = await sp.evaluate(async (qid) => {
    const r = await fetch("/api/orders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "cancelEstimate", id: qid }) });
    return { status: r.status, data: await r.json() };
  }, id);
  expect(refused.status).toBe(403);
  const qty = lineRow(sp, "Sample Tee").locator("input[data-qt-qty]");
  await qty.fill("12");
  await saving(sp, () => qty.press("Tab"));
  expect(await lineCells(sp, "Sample Tee")).toEqual(["Sample Tee", "", "$20.00", "−$2.00", "$18.00", "$216.00", "Change Remove"]);
  await expect(totalOf(sp)).toHaveText("$216.00");
  await sp.locator("#qtSave").click();
  await expect(toast(sp)).toContainText("Quote revised. Send it again when it's ready.");
  // Sent again: the same link.
  const s2 = await sendThroughPage(sp, { title: "Send " + number });
  expect(s2.token).toBe(s1.token);
  await expect(head(sp).locator(".qt-st-sent")).toHaveText("Sent");
  await expect(sp.locator("#qtPage .cust-sub").nth(1)).toContainText("(2 times)");

  // The customer sees the revised prices and may accept again.
  await openQuoteLink(cp, shop, s1.token);
  expect(await custCells(cp, "Sample Tee")).toEqual(["Sample Tee", "12", "$18.00was $20.00", "$216.00"]);
  await expect(cp.locator("#estAccept")).toBeVisible();

  // ---- Back office converts it ------------------------------------------------------------------------------
  await sp.locator("#qtConvert").click();
  const conv = sp.getByRole("dialog", { name: `Convert ${number} to an order` });
  await expect(conv.locator(".cust-merge-text")).toContainText(`An order is recorded for ${c.name} in ${shop.name}, at the quote's prices ($216.00), not yet paid.`);
  await expect(conv.locator("#qtConvCancel")).toBeFocused();
  await expect(conv.locator("#qtConvInvoice")).toBeChecked();      // the quote went to an email address
  await conv.locator("#qtConvCancel").click();
  await expect(conv).toHaveCount(0);
  await sp.locator("#qtConvert").click();
  const convReq = sp.waitForRequest(r => r.url().endsWith("/api/orders") && /"action":"convertEstimate"/.test(r.postData() || ""));
  await sp.getByRole("dialog", { name: `Convert ${number} to an order` }).locator("#qtConvGo").click();
  const req = await convReq;
  expect(JSON.parse(req.postData())).toMatchObject({ id, sendInvoice: true });
  const ans = await (await req.response()).json();
  const orderId = orderIdFor(shop, number);
  expect(ans).toMatchObject({ status: "ok", orderId, invoiceSent: false });
  await expect(toast(sp)).toContainText(`Order ${orderId} made from quote ${number}.`);
  await expect(head(sp).locator(".qt-st-converted")).toHaveText("Converted");
  await expect(sp.locator("#qtConvert")).toHaveCount(0);
  // Converting again answers the same order.
  const repeat = await api("convertEstimate", { id });
  expect(repeat).toMatchObject({ orderId, repeated: true });

  // The order: at the revised prices, on the customer's record, from the quote.
  const o = await orderOf(api, shop, orderId);
  expect(o.customerId).toBe(c.id);
  expect(o.estimate).toEqual({ id, number });
  expect(Number(o.total)).toBe(216);
  await openAdmin(sp, "orders/" + shop.orgId);
  const row = sp.locator(`tr[data-order="${orderId}"]`).first();
  await expect(row).toContainText("$216.00");
  await expect(row.locator(".order-estimate-link")).toHaveText("From quote " + number);
  await expect(row.locator("a.order-customer-link")).toHaveAttribute("href", "#/customers/" + c.id);

  // The customer's link now says it is an order, and can't be accepted again.
  await openQuoteLink(cp, shop, s1.token);
  await expect(cp.locator(".inv-banner")).toContainText(`This quote has been accepted — it's order ${orderId}.`);
  await expect(cp.locator("#estAccept")).toHaveCount(0);
  const late = await customerPost(cp, { token: s1.token, action: "accept" });
  expect(late.status).toBe(409);
});

// =========================================================================================================
test("An expired quote can't be accepted or sent again, and a link that isn't a quote's says so", async ({ page, api, as }) => {
  const shop = await makeShop(api, { prefix: "qte", products: PRODUCTS });
  const tag = tagOf();
  const c = await makeCustomer(api, { name: "Sam Example " + tag, email: emailOf("sam") });
  const q = await sentQuote(api, shop, c, { title: "Late order " + tag });

  // The customer asks for changes; while it waits on them, its last day can still change.
  const cp = await as(null);
  await openQuoteLink(cp, shop, q.token);
  const ask = await customerPost(cp, { token: q.token, action: "changes", note: "Can it be blue?" });
  expect(ask.status).toBe(200);

  // The page won't move it into the past…
  await quotePage(page, q.id);
  await page.locator("#qtExpires").fill(PAST);
  await page.locator("#qtSave").click();
  await expect(page.locator("#qtErr")).toHaveText("The last day to accept can't be in the past.");
  // …but a quote can still outlive its last day; here the server is told one long gone.
  await api("saveEstimate", { id: q.id, expiresOn: PAST });
  await quotePage(page, q.id);
  await expect(head(page).locator(".cust-tag-warn")).toHaveText("Expired");
  // Sending it again is refused until a later day is set.
  await page.locator("#qtSend").click();
  const send = page.getByRole("dialog", { name: "Send " + q.number });
  await send.locator("#qtSendGo").click();
  await expect(send.locator("#qtSendErr")).toHaveText(`This quote's last day (${PAST}) has passed. Set a later expiry date before sending it.`);
  // The list marks it expired too.
  await openAdmin(page, "quotes");
  await page.locator("#qtQ").fill(q.number);
  const listRow = page.locator(`#qtBody tr[data-qt-id="${q.id}"]`);
  await expect(listRow).toBeVisible();
  await expect(listRow.locator(".cust-tag-warn")).toHaveText("Expired");
  await expect(listRow).toContainText("1/15/2020");

  // The customer's page says so, and offers nothing.
  await openQuoteLink(cp, shop, q.token);
  await expect(cp.locator(".inv-banner")).toHaveText("This quote expired on January 15, 2020, so it can't be accepted. Please contact us for an updated quote.");
  await expect(cp.locator("#estAccept")).toHaveCount(0);
  await expect(cp.locator("#estAskOpen")).toHaveCount(0);
  const acc = await customerPost(cp, { token: q.token, action: "accept" });
  expect(acc.status).toBe(410);
  expect(acc.data.message).toBe("This quote expired on Wednesday, January 15, 2020 — contact us for a new one.");
  const chg = await customerPost(cp, { token: q.token, action: "changes", note: "Still blue, please." });
  expect(chg.status).toBe(410);

  // A link that isn't one.
  await cp.goto(shopUrl(shop.subdomain) + "/?estimate=" + "0".repeat(32));
  await expect(cp.getByRole("alert")).toHaveText("This quote link isn't valid.");
  const bad = await customerPost(cp, { token: "not-a-token", action: "accept" });
  expect(bad.status).toBe(404);
  expect(bad.data.message).toBe("This quote link isn't valid.");
});

// =========================================================================================================
test("Cancelling a quote: it asks first, the customer's link stops accepting it, and the list finds it by number and status", async ({ page, api, as }) => {
  const shop = await makeShop(api, { prefix: "qtx", products: PRODUCTS });
  const tag = tagOf();
  const c = await makeCustomer(api, { name: "Lee Example " + tag, email: emailOf("lee") });
  const q = await sentQuote(api, shop, c, { title: "Spare hats " + tag });

  await quotePage(page, q.id);
  // Keep it: nothing happens.
  await page.locator("#qtCancel").click();
  let ask = page.getByRole("dialog").last();
  await expect(ask).toContainText(`Cancel quote ${q.number}?`);
  await expect(ask).toContainText("The customer can no longer accept it, and it can't be sent again. This can't be undone.");
  await ask.getByRole("button", { name: "Keep it" }).click();
  await expect(head(page).locator(".qt-st-sent")).toHaveText("Sent");
  // Yes, cancel it.
  await page.locator("#qtCancel").click();
  await confirmDialog(page, "Yes, cancel it");
  await expect(toast(page)).toContainText(`Quote ${q.number} cancelled.`);
  await expect(head(page).locator(".qt-st-cancelled")).toHaveText("Cancelled");
  await expect(page.locator("#qtPage")).toContainText("The customer's link no longer accepts it.");
  await expect(page.locator("#qtSend")).toHaveCount(0);
  await expect(page.locator("#qtConvert")).toHaveCount(0);
  await expect(page.locator("#qtCancel")).toHaveCount(0);
  // Again: already cancelled is fine; it can't become an order or be sent.
  expect((await api("cancelEstimate", { id: q.id })).status).toBe("ok");
  const conv = await api("convertEstimate", { id: q.id }, { allowError: true, withStatus: true });
  expect(conv.status).toBe(409);
  expect(conv.data.message).toBe("This quote was cancelled.");
  const resend = await api("sendEstimate", { id: q.id, email: c.email }, { allowError: true, withStatus: true });
  expect(resend.status).toBe(409);
  expect(resend.data.message).toBe("This quote was cancelled.");

  // The customer's page.
  const cp = await as(null);
  await openQuoteLink(cp, shop, q.token);
  await expect(cp.locator(".inv-banner")).toHaveText("This quote has been withdrawn, so it can't be accepted. Please contact us if you'd still like to order.");
  await expect(cp.locator("#estAccept")).toHaveCount(0);
  const acc = await customerPost(cp, { token: q.token, action: "accept" });
  expect(acc.status).toBe(409);
  expect(acc.data.message).toBe("This quote was cancelled — contact us if you'd still like to go ahead.");

  // The list: search by number, the status filter, and a search that matches nothing.
  await openAdmin(page, "quotes");
  await page.locator("#qtQ").fill(q.number);
  const row = page.locator(`#qtBody tr[data-qt-id="${q.id}"]`);
  await expect(row).toBeVisible();
  await expect(page.locator("#qtCount")).toHaveText("1 quote");
  await expect(row).toHaveClass(/cust-row-archived/);
  await expect(row).toContainText(c.name);
  await expect(row).toContainText("Spare hats " + tag);
  await expect(row.locator(".qt-st-cancelled")).toHaveText("Cancelled");
  await page.locator("#qtStatus").selectOption("sent");
  await expect(page.locator("#qtBody")).toHaveText("No quote matches.");
  await page.locator("#qtStatus").selectOption("cancelled");
  await expect(row).toBeVisible();
  await page.locator("#qtQ").fill(tag);
  await expect(row).toBeVisible();
  await page.locator("#qtQ").fill("nothing-" + tag);
  await expect(page.locator("#qtBody")).toHaveText("No quote matches.");
  // A row opens its quote.
  await page.locator("#qtQ").fill(q.number);
  await row.locator("td").nth(2).click();
  await expect(page).toHaveURL(new RegExp(`#quotes/${q.id}$`));
  await expect(head(page)).toContainText(q.number);
});

// =========================================================================================================
test("Product lines in sizes with personalization: the break counts every line of the product, and the customer sees size and text", async ({ page, api, as }) => {
  const shop = await makeShop(api, { prefix: "qts", products: [
    { name: "Sample Hoodie", price: 0, idPrefix: "hood", extra: { pricingMode: "sized", sizePricing: { S: 30, M: 30, L: 34 }, personalizationPrice: 5, qtyBreaks: [{ minQty: 10, off: 3 }] } },
    { name: "Sample Scarf", price: 9, idPrefix: "scarf", extra: { visible: false } },
  ] });
  const empty = await makeShop(api, { prefix: "qtn", products: [] });
  const tag = tagOf();
  const c = await makeCustomer(api, { name: "Kim Example " + tag, email: emailOf("kim") });

  // A shop with nothing to quote says so.
  const blank = await api("createEstimate", { org: empty.orgId, customerId: c.id, title: "Nothing yet", expiresOn: FAR });
  await quotePage(page, blank.id);
  await page.locator("#qtAddProduct").click();
  await expect(toast(page)).toContainText("This shop has no products to quote. Add a custom line instead.");
  await expect(page.getByRole("dialog", { name: "Add a product" })).toHaveCount(0);

  const made = await api("createEstimate", { org: shop.orgId, customerId: c.id, title: "Hoodies " + tag, expiresOn: FAR });
  await quotePage(page, made.id);
  await page.locator("#qtAddProduct").click();
  let dlg = page.getByRole("dialog", { name: "Add a product" });
  await expect(dlg.locator("#qtProd option")).toHaveText(["Sample Hoodie", "Sample Scarf (hidden)"]);
  await dlg.locator("#qtProd").selectOption({ label: "Sample Hoodie" });
  await expect(dlg.locator("#qtProdSizeWrap")).toBeVisible();
  await expect(dlg.locator("#qtProdSize option")).toHaveText(["S — $30.00", "M — $30.00", "L — $34.00"]);
  await expect(dlg.locator("#qtProdPersWrap")).toBeVisible();
  await expect(dlg.locator("#qtProdPersPrice")).toHaveText("(+$5.00 each)");
  await expect(dlg.locator("#qtProdPersFields")).toBeHidden();
  await dlg.locator("#qtProdSize").selectOption("L");
  await expect(dlg.locator("#qtProdPreview")).toHaveText("Catalog price $34.00 each. Quantity prices: 10+ pieces, $3.00 off each — counted across every line of this product on the quote.");
  await dlg.locator("#qtProdPers").check();
  await expect(dlg.locator("#qtProdPersFields")).toBeVisible();
  await expect(dlg.locator("#qtProdPersOptWrap")).toBeHidden();
  await expect(dlg.locator("#qtProdPreview")).toContainText("Catalog price $34.00 each + $5.00 personalization.");
  await dlg.locator("#qtProdPersName").fill("COACH");
  await dlg.locator("#qtProdQty").fill("6");
  let a = await saving(page, () => dlg.locator("#qtProdSave").click());
  expect(a.items[0]).toMatchObject({ size: "L", qty: 6, personalized: true, persName: "COACH", personalizationFee: 5, breakOff: 0 });
  await expect(lineRow(page, "Sample Hoodie").locator(".qt-line-sub")).toHaveText("Size L · Personalized: COACH (+$5.00 each)");
  const below = await lineCells(page, "Sample Hoodie");
  expect(below[3]).toBe("");               // 6 pieces: no break yet
  // Six more in M: twelve of the product in all, so both lines come down $3 a piece.
  await page.locator("#qtAddProduct").click();
  dlg = page.getByRole("dialog", { name: "Add a product" });
  await dlg.locator("#qtProd").selectOption({ label: "Sample Hoodie" });
  await dlg.locator("#qtProdSize").selectOption("M");
  await dlg.locator("#qtProdQty").fill("6");
  a = await saving(page, () => dlg.locator("#qtProdSave").click());
  expect(a.items.map(i => i.breakOff)).toEqual([3, 3]);
  const rows = page.locator("#qtLines tbody tr");
  await expect(rows).toHaveCount(2);
  expect((await rows.nth(0).locator("td").allTextContents()).map(s => s.trim()).slice(2, 4)).toEqual(["$34.00", "−$3.00"]);
  expect((await rows.nth(1).locator("td").allTextContents()).map(s => s.trim()).slice(2, 6)).toEqual(["$30.00", "−$3.00", "$27.00", "$162.00"]);
  await expect(rows.nth(1).locator(".qt-line-sub")).toHaveText("Size M");
  // Changing the personalized line keeps its size and text.
  await rows.nth(0).getByRole("button", { name: /^Change / }).click();
  dlg = page.getByRole("dialog", { name: "Change product line" });
  await expect(dlg.locator("#qtProdSize")).toHaveValue("L");
  await expect(dlg.locator("#qtProdPers")).toBeChecked();
  await expect(dlg.locator("#qtProdPersName")).toHaveValue("COACH");
  // Cancel with nothing changed closes at once.
  await dlg.locator("#qtProdCancel").click();
  await expect(dlg).toHaveCount(0);
  const total = (await totalOf(page).textContent()).trim();

  // Sent, and seen by the customer.
  await page.locator("#qtSend").click();
  const send = page.getByRole("dialog", { name: "Send " + made.number });
  const sent = answerOf(page, "sendEstimate");
  await send.locator("#qtSendGo").click();
  const link = (await (await sent).json()).link;
  const token = /estimate=([0-9a-f]{32})/.exec(link)[1];
  const cp = await as(null);
  await openQuoteLink(cp, shop, token);
  const hoodies = cp.locator(".inv table.inv-items tbody tr");
  await expect(hoodies).toHaveCount(2);
  await expect(hoodies.nth(0).locator("td").first()).toContainText("Sample Hoodie · L");
  await expect(hoodies.nth(0).locator("td").first()).toContainText("“COACH”");
  await expect(hoodies.nth(1).locator("td").first()).toHaveText("Sample Hoodie · M");
  await expect(hoodies.nth(1).locator("td").nth(2)).toHaveText("$27.00was $30.00");
  await expect(cp.locator(".inv-totals tr.inv-total")).toContainText(total);
});
