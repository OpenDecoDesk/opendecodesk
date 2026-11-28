// Gift cards (migrations/0120) end to end as the owner, in a real browser. A gift card is a payment, never a discount.
//   - the Gift cards page: Issue gift card (its own checks, the full number shown once, "Email it to them now" on an
//     install that can't send email says so), the list (search, Used up), a card's window (Show the number, the
//     history: issued, spent, put back);
//   - spending one card in two places: part on a Local sale (the window's Gift card box), the rest in another order's
//     Payments window (Gift card as "Paid by": Check shows the balance, Apply card takes up to what is owed); an
//     empty card is refused; a gift-card payment is never filed in an account;
//   - voiding a gift-card payment puts the money back on the card, once; "Back to card…" puts part of one back;
//   - a customer spends a card at a shop's checkout together with a discount code while only one code is allowed
//     (the second code is refused, the card is not); a card that covers everything leaves nothing to pay;
//   - Global settings → Gift cards → selling online. This install has no Stripe (no card payments, no webhook secret:
//     e2e/README.md "Not covered"), so card payments are not ready: the sell-online tick is disabled with its note and
//     the server refuses selling online. With getGiftCardSettings answered cardReady true in the browser (as
//     gap-giftcard-tile does) the page's own amount checks run and a ticked Save is refused; the amounts save with
//     selling off. The shop shows no Gift cards button and the server refuses buyGiftCard with its reason. The buy form is then reached with the catalog's card fields stubbed
//     in the customer's browser: its own checks, the server's real refusal, and (with buyGiftCard and /api/checkout
//     stubbed too) the hand-off to the Checkout address and the thank-you page. The paid webhook that makes the card
//     can't be sent here (it needs Stripe's signature), so "the card appears once" is left to test19/test135-style
//     unit tests.
//
// This spec changes install-wide settings (the gift card settings, and the discount-code rule if another run left it
// on), so it is in ALONE in playwright.config.mjs and puts every setting back. Every test makes its own shop and data.
import { test, expect, ADMIN, openAdmin, toast, uniq, shopUrl, waitIdle, confirmDialog } from "../fixtures.mjs";
import { makeShop } from "../lib/data.mjs";
import crypto from "node:crypto";

const TAG = uniq("gc").split(" ")[1].toUpperCase().replace(/[^A-Z0-9]/g, "");
const CODE_RE = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
const last4Of = (code) => code.replace(/-/g, "").slice(-4);
const requestId = () => "e2e" + crypto.randomBytes(8).toString("hex");

// ---- helpers ---------------------------------------------------------------------------------------------
const actionOf = (req) => { try { return JSON.parse(req.postData() || "{}").action; } catch (e) { return ""; } };
const answerOf = (page, action) => page.waitForResponse(r => r.url().endsWith("/api/orders") && actionOf(r.request()) === action);

// A card made with the owner's API (the tests about issuing one do it through the page). Returns { id, code, last4 }.
const apiCard = async (api, dollars, extra = {}) => {
  const d = await api("issueGiftCard", { amountCents: Math.round(dollars * 100), recipientName: uniq("Sam Example"), note: "e2e " + TAG, requestId: requestId(), ...extra });
  return { id: d.card.id, code: d.code, last4: d.card.last4 };
};
const cardOf = async (api, id) => api("getGiftCard", { id });
// An unpaid order of the shop's product at index `i` (a Local sale left unpaid, through the owner's API).
const unpaidOrder = async (api, shop, i = 0, qty = 1) => (await api("createLocalSale", { org: shop.orgId, requestId: requestId(),
  items: [{ productId: shop.products[i].productId, qty }], paymentMethod: "Check", customerName: uniq("Uma Unpaid") })).orderId;
const orderOf = async (api, shop, orderId) => (await api("getOrders", { org: shop.orgId })).orders.find(o => o.orderId === orderId);
const auditOf = async (api, action) => (await api("getAuditLog", { filter: action, limit: 200 })).entries || [];

const ordersPage = async (page, shop) => {
  if (page.url() === ADMIN + "/#orders/" + shop.orgId) await page.goto("about:blank");
  await openAdmin(page, "orders/" + shop.orgId);
  await expect(page.getByRole("combobox", { name: "Shop" })).toHaveValue(shop.orgId);
};
const orderRow = (page, orderId) => page.locator(`tr[data-order="${orderId}"]`).first();
const openPayments = async (page, shop, orderId) => {
  await ordersPage(page, shop);
  await orderRow(page, orderId).locator("td[data-action-td]").getByRole("button", { name: "💰 Payments" }).click();
  const pm = page.locator("#pmContent");
  await expect(pm).toContainText("Amount due");
  return pm;
};

// The Gift cards page searched for one card; its row; its window.
const cardsPage = async (page, q) => {
  await openAdmin(page, "giftcards");
  await expect(page.locator("#gcPage")).toBeVisible();
  await expect(page).toHaveTitle(/Gift cards/);
  if (q != null) {
    const listed = answerOf(page, "listGiftCards");
    await page.locator("#gcQ").fill(q);
    await listed;
    await waitIdle(page);
  }
};
const cardRow = (page, last4) => page.locator("#gcBody tbody tr", { has: page.locator("a.dc-code", { hasText: new RegExp("^••" + last4 + "$") }) });
const openCard = async (page, last4) => {
  const got = answerOf(page, "getGiftCard");
  await cardRow(page, last4).locator("a.dc-code").click();
  await got;
  const dlg = page.getByRole("dialog", { name: "Gift card ••" + last4 });
  await expect(dlg).toBeVisible();
  return dlg;
};
const ledgerRows = async (dlg) => (await dlg.locator(".gc-ledger tbody tr").evaluateAll(trs => trs.map(tr => [...tr.cells].slice(1, 5).map(td => td.textContent.trim()))));

// The shop's page in a customer's own browser, `qty` of the first product in the cart, name and email typed.
const checkout = async (as, shop, { qty = 1, email = "casey@example.test", payment = "Check" } = {}) => {
  const cp = await as(null);
  await cp.goto(shopUrl(shop.subdomain) + "/");
  await expect(cp.getByRole("heading", { level: 1, name: shop.name })).toBeVisible();
  const card = cp.locator("main").getByRole("heading", { level: 3, name: shop.products[0].name, exact: true }).locator("xpath=ancestor::*[.//button[normalize-space()='Add to cart']][1]");
  if (qty !== 1) await card.getByRole("spinbutton").fill(String(qty));
  await card.getByRole("button", { name: "Add to cart" }).click();
  await cp.getByLabel("Your name").fill(uniq("Casey Customer"));
  await cp.getByLabel("Email address").fill(email);
  if (payment) await cp.getByLabel("Payment method").selectOption({ label: payment });
  return cp;
};
// Place order; the order's answer and what was sent.
const placeIt = async (cp) => {
  const saved = cp.waitForResponse(r => r.url().endsWith("/api/orders") && r.request().method() === "POST" && !actionOf(r.request()));
  await cp.getByRole("button", { name: "Place order" }).click();
  const res = await saved;
  const body = await res.json();
  await expect(cp.getByRole("heading", { level: 2, name: /^Order received/ })).toBeVisible();
  return { body, sent: JSON.parse(res.request().postData()) };
};
// The customer's checkout "Have a gift card?" → number → Check (the server's answer is returned).
const checkCard = async (cp, code) => {
  const open = cp.locator('[data-action="gift-open"]');
  if (await open.isVisible()) await open.click();
  await cp.locator("#giftCardInput").fill(code);
  const ans = answerOf(cp, "checkGiftCard");
  await cp.locator('[data-action="gift-check"]').click();
  return (await ans).json();
};

// =========================================================================================================
test("the owner issues a card on the Gift cards page (number shown once), spends part on a Local sale and the rest in an order's Payments window, then sees the balance and history", async ({ page, api }) => {
  test.setTimeout(150_000);
  const shop = await makeShop(api, { prefix: "gcflow", products: [{ name: "Sample Tee", price: 20 }, { name: "Sample Jacket", price: 45, idPrefix: "jkt" }] });
  const recipient = uniq("Sam Example");
  const note = "e2e " + TAG + " " + crypto.randomBytes(3).toString("hex");

  // ---- Issue gift card ---------------------------------------------------------------------------------------
  await cardsPage(page);
  await expect(page.locator("#gcPage")).toContainText("A gift card is a payment, not a discount");
  await page.getByRole("button", { name: "Issue gift card" }).click();
  const dlg = page.getByRole("dialog", { name: "Issue gift card" });
  await expect(dlg).toBeVisible();
  // The window's own checks: an amount, a real email, and an email when it is to be emailed.
  await dlg.getByRole("button", { name: "Issue card" }).click();
  await expect(dlg.locator("#gcIssueErr")).toHaveText("Enter an amount from $1 to $1,000,000.");
  await dlg.getByLabel("Amount ($)").fill("0.50");
  await dlg.getByRole("button", { name: "Issue card" }).click();
  await expect(dlg.locator("#gcIssueErr")).toHaveText("Enter an amount from $1 to $1,000,000.");
  await dlg.getByLabel("Amount ($)").fill("50");
  await dlg.getByLabel("For (name, optional)").fill(recipient);
  await dlg.getByLabel("Their email (optional)").fill("pat@example");
  await dlg.getByRole("button", { name: "Issue card" }).click();
  await expect(dlg.locator("#gcIssueErr")).toHaveText("Enter a valid email address, or leave it blank.");
  await dlg.getByLabel("Their email (optional)").fill("");
  await dlg.getByLabel("Email it to them now").check();
  await dlg.getByRole("button", { name: "Issue card" }).click();
  await expect(dlg.locator("#gcIssueErr")).toHaveText("Enter their email address to email the card.");
  await expect(dlg.getByLabel("Their email (optional)")).toBeFocused();
  await dlg.getByLabel("Their email (optional)").fill("pat@example.com");
  await dlg.getByLabel(/^Message/).fill("Happy birthday from Example Club");
  await dlg.getByLabel("Note (only you see it)").fill(note);
  const issued = answerOf(page, "issueGiftCard");
  await dlg.getByRole("button", { name: "Issue card" }).click();
  const issuedRes = await issued;
  const sent = JSON.parse(issuedRes.request().postData());
  expect(sent).toMatchObject({ amountCents: 5000, recipientName: recipient, recipientEmail: "pat@example.com", message: "Happy birthday from Example Club", note, sendEmail: true });
  const ans = await issuedRes.json();
  // The full number, once, grouped; this install can't send email, and the window says so (not "It was emailed").
  expect(ans.code).toMatch(CODE_RE);
  expect(ans.emailSent).toBe(false);
  const code = ans.code, last4 = last4Of(code);
  expect(ans.card).toMatchObject({ last4, balance: 50, initial: 50, recipientName: recipient, recipientEmail: "pat@example.com", status: "active" });
  expect(JSON.stringify(ans.card)).not.toContain(code.replace(/-/g, ""));
  await expect(dlg.locator("#gcIssueForm")).toBeHidden();
  await expect(dlg.locator(".gc-issued-h")).toHaveText(`Gift card ••${last4} for $50.00 is ready.`);
  await expect(dlg.locator("#gcIssuedCode")).toHaveText(code);
  await expect(dlg).toContainText("The email couldn't be sent. Use Resend on the card to try again.");
  await expect(dlg).not.toContainText("It was emailed to");
  await expect(toast(page)).toContainText(`Gift card ••${last4} issued.`);
  await dlg.getByRole("button", { name: "Done" }).click();
  await expect(dlg).toHaveCount(0);
  // The audit row has no number in it.
  const issuedAudit = (await auditOf(api, "giftcard.issued")).find(e => JSON.stringify(e).includes(note));
  expect(issuedAudit).toBeTruthy();
  expect(JSON.stringify(issuedAudit)).not.toContain(code.replace(/-/g, ""));

  // The list: searched by the last four, the card, its balance, who it is for, from the shop, Active.
  await cardsPage(page, last4);
  await expect(cardRow(page, last4)).toHaveCount(1);
  await expect(cardRow(page, last4)).toContainText("$50.00");
  await expect(cardRow(page, last4)).toContainText(recipient);
  await expect(cardRow(page, last4)).toContainText("The shop");
  await expect(cardRow(page, last4).locator(".cust-tag")).toHaveText("Active");

  // ---- part of it on a Local sale (a $20 tee): the card pays it all ------------------------------------------
  const buyer = uniq("Lee Localsale");
  await ordersPage(page, shop);
  await page.getByRole("button", { name: "+ Local sale" }).click();
  const form = page.locator("#localSaleForm");
  await expect(form).toBeVisible();
  await form.locator("#lsProduct").selectOption({ label: "Sample Tee" });
  await form.locator("#lsPayment").selectOption("Cash");
  // Nothing typed, then a number that isn't a card: said in the window.
  await form.locator("#lsGiftApply").click();
  await expect(form.locator("#lsGiftMsg")).toHaveText("Enter the gift card number first.");
  await form.locator("#lsGift").fill("ZZZZ-ZZZZ-ZZZZ-ZZZZ");
  await form.locator("#lsGiftApply").click();
  await expect(form.locator("#lsGiftMsg")).toHaveText("That gift card number isn't right.");
  await form.locator("#lsGift").fill(code.toLowerCase());
  await form.locator("#lsGiftApply").click();
  await expect(form.locator("#lsGiftMsg")).toHaveText(`✓ Gift card ••${last4} has $50.00.`);
  await expect(form.locator("#lsGift")).toHaveValue("");
  await expect(form.locator("#lsGiftList")).toContainText(`Gift card ••${last4} — balance $50.00, pays about $20.00 (before sales tax)`);
  // The same card twice: refused in the window.
  await form.locator("#lsGift").fill(code);
  await form.locator("#lsGift").press("Enter");
  await expect(form.locator("#lsGiftMsg")).toHaveText("That gift card is already on this sale.");
  await form.locator("#lsGift").fill("");
  await form.locator("summary", { hasText: "Customer info" }).click();
  await form.locator("#lsName").fill(buyer);
  const saleSent = page.waitForRequest(req => req.url().endsWith("/api/orders") && actionOf(req) === "createLocalSale");
  await form.getByRole("button", { name: "Record sale" }).click();
  const saleBody = JSON.parse((await saleSent).postData());
  expect(saleBody.giftCards).toEqual([{ code: code.toLowerCase(), amount: 50 }]);
  await expect(toast(page)).toContainText("Local sale recorded — ");
  await expect(toast(page)).not.toContainText("gift card");
  const sale = (await api("getOrders", { org: shop.orgId })).orders.find(o => o.customerName === buyer);
  expect(sale.paid).toBeTruthy();
  expect(sale.balanceDue).toBe(0);
  const salePays = (sale.payments || []).filter(p => !p.voidedAt);
  expect(salePays).toHaveLength(1);
  expect(salePays[0]).toMatchObject({ amount: 20, method: "other", reference: "Gift card ••" + last4, note: "Paid by gift card" });
  expect(salePays[0].accountId == null).toBe(true);
  expect((await cardOf(api, ans.card.id)).card.balance).toBe(30);

  // ---- the rest in another order's Payments window (a $45 jacket) --------------------------------------------
  const jacketId = await unpaidOrder(api, shop, 1);
  let pm = await openPayments(page, shop, jacketId);
  await pm.locator("#pmMethod").selectOption("__giftcard__");
  // Gift card replaces the account, reference, date and note; Save becomes "Apply card".
  await expect(pm.locator("#pmGiftCode")).toBeVisible();
  await expect(pm.locator("#pmReference")).toBeHidden();
  await expect(pm.locator("#pmNote")).toBeHidden();
  await expect(pm.locator("#pmSavePayment")).toHaveText("Apply card");
  await expect(pm.locator("#pmAmount")).toHaveAttribute("placeholder", "Up to the balance");
  await expect(pm).toContainText("The gift card pays up to what is owed on this order.");
  await pm.locator("#pmGiftCheck").click();
  await expect(pm.locator("#pmGiftInfo")).toHaveText("Enter the gift card number.");
  await pm.locator("#pmSavePayment").click();
  await expect(pm.locator("#pmError")).toHaveText("Enter the gift card number.");
  await pm.locator("#pmGiftCode").fill(code);
  await pm.locator("#pmGiftCheck").click();
  await expect(pm.locator("#pmGiftInfo")).toHaveText(`Gift card ••${last4} has $30.00.`);
  await pm.locator("#pmAmount").fill("-3");
  await pm.locator("#pmSavePayment").click();
  await expect(pm.locator("#pmError")).toHaveText("Enter an amount, or leave it empty to take as much as the card can.");
  await pm.locator("#pmAmount").fill("");
  const redeemed = answerOf(page, "redeemGiftCard");
  await pm.locator("#pmSavePayment").click();
  const redeemAns = await (await redeemed).json();
  expect(redeemAns).toMatchObject({ taken: 30, cardBalance: 0, last4, balanceDue: 15 });
  await expect(toast(page)).toContainText("Took $30.00 from the gift card; $0.00 is left on it.");
  pm = page.locator("#pmContent");
  await expect(pm).toContainText(/Received\s*\$30\.00/);
  await expect(pm).toContainText(/Balance due\s*\$15\.00/);
  const giftPayRow = pm.locator("tbody tr", { hasText: "Gift card ••" + last4 });
  await expect(giftPayRow).toContainText("Gift card · Gift card ••" + last4);
  await expect(giftPayRow).toContainText("no account");
  await expect(giftPayRow).toContainText("Paid by gift card");
  await expect(giftPayRow.locator("select.pm-acct")).toHaveCount(0);
  await expect(giftPayRow.getByRole("button", { name: "Back to card…" })).toBeVisible();
  // The empty card now: Check and Apply both say so, and nothing more is taken.
  await pm.locator("#pmMethod").selectOption("__giftcard__");
  await pm.locator("#pmGiftCode").fill(code);
  await pm.locator("#pmGiftCheck").click();
  await expect(pm.locator("#pmGiftInfo")).toHaveText("This gift card has no balance left.");
  await pm.locator("#pmSavePayment").click();
  await expect(pm.locator("#pmError")).toHaveText("This gift card has no balance left.");
  const jacket = await orderOf(api, shop, jacketId);
  expect(jacket.balanceDue).toBe(15);
  expect((jacket.payments || []).filter(p => !p.voidedAt && p.giftCardId)).toHaveLength(1);
  // The money moved as a payment, audited as one (method "gift card").
  const payAudit = (await auditOf(api, "payment.added")).filter(e => e.orderId === jacketId);
  expect(payAudit.some(e => JSON.stringify(e).includes('"method":"gift card"'))).toBe(true);

  // ---- the card now: used up, and its history ---------------------------------------------------------------
  await cardsPage(page, last4);
  await expect(cardRow(page, last4)).toContainText("$0.00");
  await expect(cardRow(page, last4).locator(".cust-tag")).toHaveText("Used up");
  // The "Active" filter (balance left) leaves it out; "All" shows it.
  const filtered = answerOf(page, "listGiftCards");
  await page.locator("#gcStatus").selectOption("active");
  expect(JSON.parse((await filtered).request().postData()).status).toBe("active");
  await expect(page.locator("#gcBody")).toHaveText("No gift card matches.");
  await page.locator("#gcStatus").selectOption("all");
  await expect(cardRow(page, last4)).toHaveCount(1);
  const cw = await openCard(page, last4);
  await expect(cw.locator(".gc-bal")).toHaveText("$0.00");
  await expect(cw).toContainText("left of $50.00");
  await expect(cw).toContainText(recipient + " · pat@example.com");
  await expect(cw).toContainText("Happy birthday from Example Club");
  await expect(cw).toContainText(note);
  // Masked until Show, which asks the server (audited) and shows the same number that was issued.
  await expect(cw.locator(".gc-code")).toHaveText("••••-••••-••••-" + last4);
  const shown = answerOf(page, "revealGiftCardCode");
  await cw.getByRole("button", { name: "Show" }).click();
  await shown;
  await expect(cw.locator(".gc-code")).toHaveText(code);
  await expect(cw.getByRole("button", { name: "Copy" })).toBeVisible();
  expect((await auditOf(api, "giftcard.code_shown")).some(e => JSON.stringify(e).includes('"last4":"' + last4 + '"'))).toBe(true);
  const rows = await ledgerRows(cw);
  expect(rows).toEqual([
    ["Issued", "+$50.00", "", "Issued"],
    ["Spent on an order", "−$20.00", sale.orderId, "Order " + sale.orderId],
    ["Spent on an order", "−$30.00", jacketId, "Order " + jacketId],
  ]);
  // Resend… on an install that can't send email: the toast says so (not "Gift card emailed to …").
  await cw.getByRole("button", { name: "Resend…" }).click();
  const ask = page.getByRole("dialog").last();
  await expect(ask.getByLabel("Email address")).toHaveValue("pat@example.com");
  const resent = answerOf(page, "resendGiftCard");
  await ask.getByRole("button", { name: "Send" }).click();
  expect(await (await resent).json()).toMatchObject({ status: "ok", emailSent: false, sentTo: "pat@example.com" });
  await expect(toast(page)).toContainText("The email couldn't be sent.");
  await expect(toast(page)).not.toContainText("Gift card emailed to");
  await cw.locator("[data-gc-do=close]").click();
  await expect(cw).toHaveCount(0);

  // ---- void the $30 payment: the money goes back on the card, once ------------------------------------------
  pm = await openPayments(page, shop, jacketId);
  const payRow = pm.locator("tbody tr", { hasText: "Gift card ••" + last4 });
  await expect(payRow.getByRole("button", { name: "Void" })).toHaveAttribute("title", /the money goes back on the gift card/);
  const voided = answerOf(page, "voidPayment");
  await payRow.getByRole("button", { name: "Void" }).click();
  await confirmDialog(page, "Void");
  expect((await voided).ok()).toBe(true);
  pm = page.locator("#pmContent");
  await expect(pm).toContainText(/Balance due\s*\$45\.00/);
  await expect(pm.locator("tbody tr", { hasText: "Gift card ••" + last4 })).toContainText("void");
  let after = await cardOf(api, ans.card.id);
  expect(after.card.balance).toBe(30);
  const putBack = after.ledger.filter(l => l.kind === "refund");
  expect(putBack).toHaveLength(1);
  expect(putBack[0]).toMatchObject({ delta: 30, orderId: jacketId });
  expect(putBack[0].note).toMatch(/voided/i);
  // Voided twice (the request the button sends, again): refused, and nothing more goes back.
  const voidedPay = (await orderOf(api, shop, jacketId)).payments.find(p => p.giftCardId && p.voidedAt);
  const again = await api("voidPayment", { paymentId: voidedPay.id, orderId: jacketId, reason: "again" }, { allowError: true, withStatus: true });
  expect(again.status).toBe(400);
  expect(again.data.message).toBe("That entry is already voided");
  after = await cardOf(api, ans.card.id);
  expect(after.card.balance).toBe(30);
  expect(after.ledger.filter(l => l.kind === "refund")).toHaveLength(1);
  expect((await orderOf(api, shop, jacketId)).balanceDue).toBe(45);

  // The card's window shows it as put back, active again.
  await cardsPage(page, last4);
  await expect(cardRow(page, last4).locator(".cust-tag")).toHaveText("Active");
  const cw2 = await openCard(page, last4);
  await expect(cw2.locator(".gc-bal")).toHaveText("$30.00");
  expect(await ledgerRows(cw2)).toEqual(expect.arrayContaining([["Put back", "+$30.00", jacketId, expect.stringMatching(/voided/i)]]));
});

// =========================================================================================================
test("Back to card… puts part of a gift-card payment back on the card; the order shows it as a refund", async ({ page, api }) => {
  const shop = await makeShop(api, { prefix: "gcback", products: [{ name: "Sample Tee", price: 20 }] });
  const card = await apiCard(api, 25);
  const orderId = await unpaidOrder(api, shop);
  await api("redeemGiftCard", { orderId, code: card.code, requestId: requestId() });
  expect((await cardOf(api, card.id)).card.balance).toBe(5);

  let pm = await openPayments(page, shop, orderId);
  await expect(pm).toContainText(/Balance due\s*Settled ✓/);
  const payRow = pm.locator("tbody tr", { hasText: "Gift card ••" + card.last4 });
  await payRow.getByRole("button", { name: "Back to card…" }).click();
  const ask = page.getByRole("dialog").last();
  await expect(ask).toContainText("How much goes back on the gift card?");
  await expect(ask).toContainText("Up to $20.00, the amount of this payment.");
  const amountBox = ask.getByLabel("Amount ($)");
  await expect(amountBox).toHaveValue("20.00");
  await amountBox.fill("25");
  await ask.getByRole("button", { name: "Refund to card" }).click();
  await expect(ask).toContainText("Enter an amount from $0.01 to $20.00.");
  await amountBox.fill("7.50");
  const refunded = answerOf(page, "refundToGiftCard");
  await ask.getByRole("button", { name: "Refund to card" }).click();
  expect(JSON.parse((await refunded).request().postData())).toMatchObject({ amount: 7.5, orderId });
  await expect(toast(page)).toContainText("$7.50 put back on the gift card.");
  pm = page.locator("#pmContent");
  await expect(pm).toContainText(/Refunded\s*−\$7\.50/);
  const got = await cardOf(api, card.id);
  expect(got.card.balance).toBe(12.5);
  expect(got.ledger.filter(l => l.kind === "refund").map(l => [l.delta, l.orderId])).toEqual([[7.5, orderId]]);
  const o = await orderOf(api, shop, orderId);
  const back = o.payments.filter(p => !p.voidedAt && p.amount < 0);
  expect(back).toHaveLength(1);
  expect(back[0]).toMatchObject({ amount: -7.5, kind: "refund" });
  expect(back[0].giftCardId).toBe(card.id);
  expect(back[0].accountId == null).toBe(true);
});

// =========================================================================================================
test("a customer spends a gift card at checkout with a discount code while only one code is allowed; a second code is refused, the card isn't", async ({ api, as }) => {
  test.setTimeout(120_000);
  const { discountRules: rulesBefore } = await api("getDiscountRules");
  if (rulesBefore.multiple) await api("updateDiscountRules", { multiple: false });
  try {
    const shop = await makeShop(api, { prefix: "gcco", products: [{ name: "Sample Tee", price: 20 }] });
    const pct = ("G" + TAG + "10").slice(0, 32), amt = ("G" + TAG + "5").slice(0, 32);
    await api("saveDiscountCode", { code: { code: pct, kind: "percent", percent: 10, maxUses: 50, orgId: shop.orgId } });
    await api("saveDiscountCode", { code: { code: amt, kind: "amount", amount: 5, maxUses: 50, orgId: shop.orgId } });
    const card = await apiCard(api, 10);

    const cp = await checkout(as, shop, { qty: 2 });
    // The catalog: one code at a time, cards can pay here.
    const cat = await cp.evaluate(async () => (await (await fetch("/api/catalog", { cache: "no-store" })).json()));
    expect(cat.catalog.discountRules).toEqual({ multiple: false });
    expect(cat.catalog.giftCardPay).toBe(true);

    // The code: 10% off $40.
    await cp.locator("#discountCodeInput").fill(pct);
    const checked = answerOf(cp, "checkDiscountCode");
    await cp.getByRole("button", { name: "Apply" }).click();
    expect((await checked).status()).toBe(200);
    await expect(cp.locator(".ticket-discount-line")).toContainText("−$4.00");
    // A second code while one is on: the server refuses it (the box offers no second one in this mode).
    const second = await cp.evaluate(async ({ code, other }) => {
      const r = await fetch("/api/orders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "checkDiscountCode", orgId: currentOrg.orgId, code, others: [other], email: "casey@example.test", items: cart.map(({ cdPreviews, ...line }) => line) }) });
      return { status: r.status, body: await r.json() };
    }, { code: amt, other: pct });
    expect(JSON.stringify(second.body)).toContain("Only one discount code can be used on an order.");
    await expect(cp.locator('[data-action="discount-add"]')).toHaveCount(0);

    // The gift card is a payment: allowed with the code. A short number and an unknown one first.
    await cp.locator('[data-action="gift-open"]').click();
    await cp.locator("#giftCardInput").fill("ABCD");
    await cp.locator('[data-action="gift-check"]').click();
    await expect(cp.locator("#giftMsg")).toHaveText("That gift card number isn't right.");
    let r = await checkCard(cp, "ZZZZ-ZZZZ-ZZZZ-ZZZZ");
    expect(r).toMatchObject({ status: "ok", ok: false });
    await expect(cp.locator("#giftMsg")).toHaveText("That gift card number isn't right.");
    r = await checkCard(cp, card.code);
    expect(r).toMatchObject({ status: "ok", ok: true, last4: card.last4, balance: 10 });
    // Nothing about the card's owner is in the answer.
    expect(Object.keys(r).sort()).toEqual(["balance", "last4", "ok", "status"]);
    await expect(cp.locator("#giftMsg")).toHaveText(`Gift card ••${card.last4} has $10.00 on it. Press Apply to use it.`);
    await cp.locator('[data-action="gift-apply"]').click();
    await expect(cp.locator(".discount-chip", { hasText: "Gift card" })).toContainText(`Gift card ••${card.last4} — $10.00 on it`);
    await expect(cp.locator(".ticket-gift-line")).toContainText(`Gift card ••${card.last4}`);
    await expect(cp.locator(".ticket-gift-line")).toContainText("−$10.00");
    await expect(cp.locator(".ticket-topay-line")).toContainText("$26.00");
    await expect(cp.locator(".ticket-discount-line").first()).toContainText("−$4.00");
    await expect(cp.locator(".ticket-total .t-amount")).toHaveText("$36.00");
    await expect(cp.locator('[data-action="gift-open"]')).toHaveText("Add another gift card");
    // The same card again: said at once, nothing asked.
    await cp.locator('[data-action="gift-open"]').click();
    await cp.locator("#giftCardInput").fill(card.code);
    await cp.locator('[data-action="gift-check"]').click();
    await expect(cp.locator("#giftMsg")).toHaveText("That gift card is already added.");
    await cp.locator("#giftCardInput").fill("");

    const { body, sent } = await placeIt(cp);
    const orderId = sent.orderId;
    expect(sent.discountCode).toBe(pct);
    expect(sent.discountCodes).toBeUndefined();
    expect(sent.giftCards).toEqual([{ code: card.code.replace(/-/g, ""), amount: 10 }]);
    expect(body.giftCards).toEqual([expect.objectContaining({ ok: true, last4: card.last4, taken: 10, balance: 0 })]);
    expect(body.owed).toBe(26);
    // The confirmation: the total, the card's part and what is still to pay by check.
    const conf = cp.locator(".confirmation");
    await expect(conf.locator(".order-number")).toContainText("$36.00");
    await expect(conf).toContainText(`Paid by gift card ••${card.last4}`);
    await expect(conf.locator(".conf-items")).toContainText(/Still to pay\s*\$26\.00/);
    await expect(conf).toContainText("Check payment");
    await expect(conf.locator(".gift-refused")).toHaveCount(0);

    // The order: the code's discount, the card's $10 as a payment (not a discount), $26 still owed.
    const o = await orderOf(api, shop, orderId);
    expect(o.discountAmount).toBe(4);
    expect(o.discountCodes).toEqual([pct]);
    expect(o.effectiveTotal).toBe(36);
    expect(o.balanceDue).toBe(26);
    expect(o.paid).toBeFalsy();
    const pays = (o.payments || []).filter(p => !p.voidedAt);
    expect(pays).toHaveLength(1);
    expect(pays[0]).toMatchObject({ amount: 10, method: "other", reference: "Gift card ••" + card.last4 });
    expect((await cardOf(api, card.id)).card.balance).toBe(0);
  } finally {
    if (rulesBefore.multiple) await api("updateDiscountRules", { multiple: true });
  }
});

test("a gift card that covers the whole order: nothing to pay, no payment method needed, and the order is paid", async ({ api, as }) => {
  const shop = await makeShop(api, { prefix: "gcall", products: [{ name: "Sample Tee", price: 20 }] });
  const card = await apiCard(api, 50);
  const cp = await checkout(as, shop, { payment: null });
  await checkCard(cp, card.code);
  await cp.locator('[data-action="gift-apply"]').click();
  // The card pays what is owed ($20), not its whole $50.
  await expect(cp.locator(".ticket-gift-line")).toContainText("−$20.00");
  await expect(cp.locator(".ticket-topay-line")).toContainText("$0.00");
  await expect(cp.locator("#paymentHint")).toHaveText("Your gift card covers it — there's nothing to pay.");
  const { body, sent } = await placeIt(cp);
  expect(body.owed).toBe(0);
  expect(sent.giftCards).toEqual([{ code: card.code.replace(/-/g, ""), amount: 20 }]);
  expect(sent.paymentMethod || "").toBe("");
  await expect(cp.locator(".confirmation .conf-items")).toContainText(new RegExp("Paid by gift card ••" + card.last4 + "\\s*−\\$20\\.00"));
  await expect(cp.locator(".confirmation")).toContainText("Your order is in. Your gift card covers it — there's nothing to pay.");
  await expect(cp.locator(".confirmation .payment-instructions")).toHaveCount(0);
  const o = await orderOf(api, shop, sent.orderId);
  expect(o.paid).toBeTruthy();
  expect(o.balanceDue).toBe(0);
  expect((await cardOf(api, card.id)).card.balance).toBe(30);
});

// =========================================================================================================
test("Global settings → Gift cards: without Stripe the sell-online tick is disabled and selling online is refused, the amounts still save through the page; the shop sells none and the server refuses; the buy form's checks, refusal and Checkout hand-off", async ({ page, api, as }) => {
  test.setTimeout(150_000);
  const NOT_READY_NOTE = "Card payments must be set up and switched on to sell gift cards on a shop: add your Stripe keys (see Setup) and tick Card under Payment methods. A shop also needs Card switched on in its own payment methods.";
  const NEEDS_CARD = "Set up card payments before selling gift cards on a shop.";
  const { giftCards: before } = await api("getGiftCardSettings");
  expect(before.cardReady).toBe(false);
  const shop = await makeShop(api, { prefix: "gcsell", products: [{ name: "Sample Tee", price: 20 }] });
  const saveSettings = async () => {
    const saved = answerOf(page, "saveGlobalSettingsAll");
    await page.getByRole("button", { name: "Save global settings" }).click();
    const res = await saved;
    expect(res.ok()).toBe(true);
    return JSON.parse(res.request().postData()).settings;
  };
  // The customer's buy request, from the shop's own page (the real server).
  const buy = (cp, extra = {}) => cp.evaluate(async (body) => {
    const r = await fetch("/api/orders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  }, { action: "buyGiftCard", orgId: shop.orgId, amountCents: 5000, recipientName: "Sam Example", recipientEmail: "sam@example.com", buyerName: "Pat Example", buyerEmail: "pat@example.com", requestId: requestId(), ...extra });
  try {
    // ---- card payments not ready (no Stripe): the tick is disabled with its note, and the server refuses --------
    await openAdmin(page, "settings");
    await expect(page.getByRole("heading", { name: "Gift cards" })).toBeVisible();
    const sell = page.locator("#gGiftSell");
    await expect(sell).toBeDisabled();
    await expect(sell).not.toBeChecked();
    await expect(page.locator("#gGiftSellNote")).toHaveText(NOT_READY_NOTE);
    let refused = await api("updateGiftCardSettings", { sellOnline: true, amounts: [2500, 5000, 10000], minCents: 1000, maxCents: 20000 }, { allowError: true, withStatus: true });
    expect(refused.status).toBe(400);
    expect(refused.data).toEqual({ status: "error", message: NEEDS_CARD });

    // ---- with card payments answered ready in this browser: the tick works, the page's own checks run, and the
    // ticked Save is still refused by this Stripe-less server, storing nothing ---------------------------------------
    await page.route("**/api/orders", async (route) => {
      if (actionOf(route.request()) !== "getGiftCardSettings") return route.fallback();
      const res = await route.fetch();
      const j = await res.json();
      j.giftCards.cardReady = true;
      await route.fulfill({ response: res, json: j });
    });
    await openAdmin(page, "settings");
    await expect(sell).toBeEnabled();
    await sell.check();
    await page.locator("#gGiftAmounts").fill("abc");
    await page.getByRole("button", { name: "Save global settings" }).click();
    await expect(page.locator("#globalSettingsError")).toContainText("Gift cards: enter 1 to 6 amounts, each from $1 to $10,000, like 25, 50, 100.");
    await page.locator("#gGiftAmounts").fill("50, 25, 25, 100");
    await page.locator("#gGiftMin").fill("10");
    await page.locator("#gGiftMax").fill("5");
    await page.getByRole("button", { name: "Save global settings" }).click();
    await expect(page.locator("#globalSettingsError")).toContainText("Gift cards: the custom amount's two figures must run from at least $1 up to no more than $10,000, the second not below the first.");
    await page.locator("#gGiftMax").fill("200");
    const tried = answerOf(page, "saveGlobalSettingsAll");
    await page.getByRole("button", { name: "Save global settings" }).click();
    const triedRes = await tried;
    expect(JSON.parse(triedRes.request().postData()).settings.giftCards).toEqual({ sellOnline: true, amounts: [2500, 5000, 10000], minCents: 1000, maxCents: 20000 });
    expect(triedRes.status()).toBe(400);
    expect(await triedRes.json()).toMatchObject({ status: "error", section: "Gift cards", message: NEEDS_CARD });
    await expect(page.locator("#globalSettingsError")).toContainText(NEEDS_CARD);
    expect((await api("getGiftCardSettings")).giftCards).toEqual(before);
    // Unticked, the same amounts save.
    await sell.uncheck();
    const settings = await saveSettings();
    expect(settings.giftCards).toEqual({ sellOnline: false, amounts: [2500, 5000, 10000], minCents: 1000, maxCents: 20000 });
    expect((await api("getGiftCardSettings")).giftCards).toEqual({ sellOnline: false, amounts: [2500, 5000, 10000], minCents: 1000, maxCents: 20000, cardReady: false });
    await page.unroute("**/api/orders");
    await openAdmin(page, "settings");
    await expect(page.locator("#gGiftSell")).toBeDisabled();
    await expect(page.locator("#gGiftSell")).not.toBeChecked();
    await expect(page.locator("#gGiftAmounts")).toHaveValue("25, 50, 100");

    // ---- the shop: no card payments on this install, so no Gift cards button, and the server says why -----------
    const cp = await as(null);
    await cp.goto(shopUrl(shop.subdomain) + "/");
    await expect(cp.getByRole("heading", { level: 1, name: shop.name })).toBeVisible();
    await expect(cp.getByRole("button", { name: "Gift cards" })).toHaveCount(0);
    const cat = await cp.evaluate(async () => (await (await fetch("/api/catalog", { cache: "no-store" })).json()));
    expect(cat.catalog.enabledPayments).not.toContain("Card");
    expect(cat.catalog.giftCards).toEqual({ sellOnline: false, amounts: [], min: 10, max: 200 });
    let r = await buy(cp);
    expect(r.status).toBe(400);
    expect(r.body.message).toBe("Gift cards aren't sold online right now.");

    // ---- the buy form, with the catalog's card fields stubbed (this install has no Stripe) ------------------------
    const bp = await as(null);
    await bp.route("**/api/catalog**", async (route) => {
      const res = await route.fetch();
      const j = await res.json();
      if (j && j.catalog) {
        j.catalog.enabledPayments = [...new Set([...(j.catalog.enabledPayments || []), "Card"])];
        j.catalog.giftCards = { sellOnline: true, amounts: [25, 50, 100], min: 10, max: 200 };
      }
      await route.fulfill({ response: res, json: j });
    });
    await bp.goto(shopUrl(shop.subdomain) + "/");
    await bp.getByRole("button", { name: "Gift cards" }).click();
    await expect(bp.getByRole("heading", { level: 2, name: "Gift cards" })).toBeVisible();
    await expect(bp).toHaveTitle(shop.name + " — Gift cards");
    await expect(bp.locator(".gb-amount")).toHaveText(["$25", "$50", "$100"]);
    const gbMsg = bp.locator("#gbMsg");
    const pay = bp.getByRole("button", { name: "Pay by card" });
    await pay.click();
    await expect(gbMsg).toHaveText("Choose an amount, or type one between $10.00 and $200.00.");
    await bp.getByLabel(/^Or another amount/).fill("500");
    await pay.click();
    await expect(gbMsg).toHaveText("Choose an amount, or type one between $10.00 and $200.00.");
    await bp.getByRole("button", { name: "$50" }).click();
    await expect(bp.getByRole("button", { name: "$50" })).toHaveAttribute("aria-pressed", "true");
    await expect(bp.getByLabel(/^Or another amount/)).toHaveValue("");
    await pay.click();
    await expect(gbMsg).toHaveText("Please add the name of the person it is for.");
    await bp.getByLabel("Who is it for? (name)").fill("Sam Example");
    await pay.click();
    await expect(gbMsg).toHaveText("Please add a valid email address for the person it is for — the gift card is sent there.");
    await bp.getByLabel("Their email address").fill("sam@example.com");
    await pay.click();
    await expect(gbMsg).toHaveText("Please add your name.");
    await bp.getByLabel("Your name").fill("Pat Example");
    await pay.click();
    await expect(gbMsg).toHaveText("Please add a valid email address for your receipt.");
    await bp.getByLabel(/^Your email address/).fill("pat@example.com");
    await bp.getByLabel(/^Message/).fill("Enjoy!");
    await expect(bp.locator("#gbCount")).toHaveText("6 / 300");
    // The real server: no card payments here.
    let buySent = answerOf(bp, "buyGiftCard");
    await pay.click();
    let buyRes = await buySent;
    expect(JSON.parse(buyRes.request().postData())).toMatchObject({ orgId: shop.orgId, amountCents: 5000, recipientName: "Sam Example", recipientEmail: "sam@example.com", buyerName: "Pat Example", buyerEmail: "pat@example.com", message: "Enjoy!" });
    expect(buyRes.status()).toBe(400);
    await expect(gbMsg).toHaveText("Gift cards aren't sold online right now.");
    await expect(pay).toBeEnabled();

    // With the order and Checkout answered by stubs, the page goes to the Checkout address it is given (here the
    // shop's own success address, as Stripe would send the buyer back) and says the card goes to the recipient.
    const fakeId = (shop.orgId.slice(0, 4).toUpperCase()) + "-GC-E2E" + TAG.slice(0, 6);
    await bp.route("**/api/orders", async (route) => {
      if (actionOf(route.request()) !== "buyGiftCard") return route.fallback();
      await route.fulfill({ json: { status: "ok", orderId: fakeId, orgId: shop.orgId, checkoutToken: "stub-token", total: 50, giftCard: true, emailOn: false } });
    });
    const back = shopUrl(shop.subdomain) + "/?stripe=success&orderId=" + encodeURIComponent(fakeId) + "&org=" + encodeURIComponent(shop.orgId) + "&giftcard=1";
    let checkoutBody = null;
    await bp.route("**/api/checkout", async (route) => { checkoutBody = JSON.parse(route.request().postData()); await route.fulfill({ json: { status: "ok", url: back } }); });
    await pay.click();
    await bp.waitForURL(/stripe=success/);
    expect(checkoutBody).toEqual({ orderId: fakeId, orgId: shop.orgId, checkoutToken: "stub-token" });
    await expect(bp.getByRole("heading", { level: 2, name: "Thank you — your payment went through." })).toBeVisible();
    await expect(bp.locator(".confirmation")).toContainText("Your gift card for Sam Example is on its way: we're emailing it to sam@example.com now.");
    await bp.unroute("**/api/orders");
    await bp.unroute("**/api/checkout");

    // ---- saved again through the page: the tick is still disabled, selling stays off, the server still refuses -----
    await openAdmin(page, "settings");
    await expect(page.locator("#gGiftSell")).toBeDisabled();
    const again = await saveSettings();
    expect(again.giftCards.sellOnline).toBe(false);
    expect((await api("getGiftCardSettings")).giftCards.sellOnline).toBe(false);
    r = await buy(cp);
    expect(r.status).toBe(400);
    expect(r.body.message).toBe("Gift cards aren't sold online right now.");
  } finally {
    await page.unroute("**/api/orders").catch(() => {});
    await api("updateGiftCardSettings", { sellOnline: before.sellOnline, amounts: before.amounts, minCents: before.minCents, maxCents: before.maxCents });
  }
  expect((await api("getGiftCardSettings")).giftCards).toEqual(before);
});
