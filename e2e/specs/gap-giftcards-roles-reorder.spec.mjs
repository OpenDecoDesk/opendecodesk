// Gift cards and Reorder (migrations/0120), by role and end to end, in a real browser:
//   - who has the Gift cards page (giftcards.cards in functions/_lib/permissions.js; public/admin-giftcards.js):
//     Manager (Full) issues, shows, adjusts and voids; Back office (Edit) issues, shows and resends but has no Adjust or
//     Void; Read only reads the list and a card with no buttons but Close; Production has no menu item and no page. The
//     server refuses each action a role may not do (functions/api/orders.js), and the card is left as it was.
//   - the Gift cards switch under Settings → Global settings → Features: off hides the page and its menu item, the
//     server refuses the page's actions and the card check, the checkout has no gift card box, and the order's Payments
//     window, the Local sale window and Payment methods offer no gift card; on again, all back.
//   - Reorder: an order row's Reorder button and a customer page's Reorder button open a Local sale filled with the old
//     order's lines (fee lines left out, today's prices, a note naming what changed); the new order records what it
//     reordered (orders.reorderOf). getOrderForReorder and createLocalSale's reorderOf refuse what they should.
// It switches Gift cards off for the whole install, so it runs alone, after every other spec (ALONE in
// e2e/playwright.config.mjs). Every shop, card, customer, order and role is this file's own.
import crypto from "node:crypto";
import { request as playwrightRequest } from "@playwright/test";
import { test, expect, ADMIN, shopUrl, openAdmin, toast, callApi, apiContext, freshIp, slug, uniq, user } from "../fixtures.mjs";
import { makeShop } from "../lib/data.mjs";

// ---- helpers ---------------------------------------------------------------------------------------------
const USERS = { path: "/api/admin-users" };
const NO_ROLE = "Your role can't do this. Ask an admin.";
const FEATURE_OFF = "Gift cards is turned off. Turn it on under Settings → Global settings → Features.";
const CARDS_OFF = "Gift cards aren't available right now.";
const CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}(-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}){3}$/;
const PAGE_ACTIONS = ["listGiftCards", "getGiftCard", "giftCardTotals", "issueGiftCard", "revealGiftCardCode", "resendGiftCard", "adjustGiftCard", "voidGiftCard"];
const PRODUCTS = [{ name: "Sample Tee", price: 20 }, { name: "Sample Cap", price: 18, type: "cap", idPrefix: "cap" }];

const nav = (page) => page.getByRole("navigation", { name: "Admin" });
const navBtn = (page) => nav(page).locator('.admin-nav-row > button[data-h="giftcards"]');
const topButtons = (page) => nav(page).locator(".admin-nav-row > button[data-h]").evaluateAll(els => els.map(e => e.dataset.h));
const tryApi = (ctx, action, body) => callApi(ctx, action, body, { allowError: true, withStatus: true });
const refused = (r, what, message = NO_ROLE, status = 403) => {
  expect(r.status, what + " is refused: " + JSON.stringify(r.data)).toBe(status);
  expect(r.data.status, what).toBe("error");
  expect(r.data.message, what).toBe(message);
};
const ok200 = (r, what) => {
  expect(r.status, what + ": " + JSON.stringify(r.data)).toBe(200);
  expect(r.data.status, what).toBe("ok");
};
const notAvailable = async (page, roleName) => {
  await expect(page.locator("#roleOffPanel")).toContainText("Not available to you.");
  await expect(page.locator("#roleOffPanel")).toContainText(`Your role (${roleName}) doesn't include this page.`);
};
const requestId = () => crypto.randomUUID().replace(/-/g, "");
const emailOf = (prefix) => slug(prefix) + "@example.com";

// A card issued through the owner's session: { card, code }.
async function issue(api, fields = {}) {
  const r = await api("issueGiftCard", { amountCents: 5000, recipientName: uniq("Pat Example"), recipientEmail: emailOf("gc"), message: "", note: "Made by the roles spec", sendEmail: false, requestId: requestId(), ...fields });
  expect(r.code).toMatch(CODE_RE);
  return r;
}
const cardOf = async (api, id) => api("getGiftCard", { id });
// The request each Gift cards page action takes, for card `c`.
const bodies = (c) => ({
  listGiftCards: { q: c.last4 },
  getGiftCard: { id: c.id },
  giftCardTotals: {},
  issueGiftCard: { amountCents: 2500, recipientName: "Never Made", recipientEmail: "", message: "", note: "Never made", sendEmail: false, requestId: requestId() },
  revealGiftCardCode: { id: c.id },
  resendGiftCard: { id: c.id, email: "pat@example.com" },
  adjustGiftCard: { id: c.id, deltaCents: 10000, note: "Given by someone who may not" },
  voidGiftCard: { id: c.id, note: "Voided by someone who may not" },
});

// The Gift cards page: the list, searched for one card (by its recipient's unique name): its row.
async function findRow(page, text) {
  await page.locator("#gcQ").fill(text);
  const row = page.locator("#gcBody tr[data-gc-row]", { hasText: text });
  await expect(row).toHaveCount(1);
  await expect(page.locator("#gcBody tr[data-gc-row]")).toHaveCount(1);
  return row;
}
const listShown = async (page) => {
  await expect(page).toHaveTitle(/ — Gift cards \(Admin\)$/);
  await expect(page.locator("#gcPage #gcQ")).toBeVisible();
};
// The window on top (a card's window, or the question asked over it).
const topModal = (page) => page.locator(".admin-modal").last();
const cardWindow = (page) => page.locator(".admin-modal", { has: page.locator("#gcCardBody") });
const doBtn = (page, what) => cardWindow(page).locator(`button[data-gc-do="${what}"]`);

// ---- the Orders page and the Local sale window -----------------------------------------------------------
const ordersPage = async (page, shop) => {
  if (page.url().startsWith(ADMIN)) await page.goto("about:blank");
  await openAdmin(page, "orders/" + shop.orgId);
  await expect(page.getByRole("combobox", { name: "Shop" })).toHaveValue(shop.orgId);
};
const actionCell = (page, orderId) => page.locator(`tr[data-order="${orderId}"]`).first().locator("td[data-action-td]");
const lineOf = (form, i) => form.locator(".ls-line").nth(i);
const field = (line, name) => line.locator(`[data-f="${name}"]`);
const posted = (page, action) => page.waitForRequest(r => r.url().endsWith("/api/orders") && new RegExp(`"action":"${action}"`).test(r.postData() || ""));
const orderOf = async (api, shop, orderId) => (await api("getOrders", { org: shop.orgId })).orders.find(o => o.orderId === orderId);
const openLines = (o) => o.items.filter(i => !i.cancelDate).map(i => [i.name, i.qty]);

// A sale through the API (the request the Local sale window sends): returns its order number.
const apiSale = async (api, shop, extra = {}) => (await api("createLocalSale", {
  org: shop.orgId, items: [{ productId: shop.products[0].productId, size: "", qty: 1 }], paymentMethod: "cash",
  customerName: "", requestId: requestId(), ...extra })).orderId;
const makeCustomer = async (api, c) => {
  const r = await api("saveCustomer", { name: "", company: "", email: "", phone: "", address: null, notes: "",
    taxExempt: false, taxExemptCertificate: "", taxExemptExpires: "", ...c });
  expect(r.created).toBe(true);
  return { id: r.id, name: "", company: "", email: "", phone: "", ...c };
};

// ---- Manager: Full ------------------------------------------------------------------------------------------
test("Manager: Gift cards right after Discount codes; issues a card, shows its number, adjusts and voids it in the page", async ({ api, as }, testInfo) => {
  test.setTimeout(120_000);
  const mp = await as("manager");
  await openAdmin(mp, "home");
  const tops = await topButtons(mp);
  expect(tops.indexOf("giftcards"), "Gift cards sits right after Discount codes").toBe(tops.indexOf("discounts") + 1);
  await navBtn(mp).click();
  await expect(mp).toHaveURL(/#giftcards$/);
  await listShown(mp);
  await expect(mp.locator("#gcNew")).toBeVisible();

  // Issue gift card: $50 for a person, with a message and a note.
  const who = uniq("Pat Example");
  await mp.locator("#gcNew").click();
  const dlg = topModal(mp);
  await expect(dlg.locator("[data-dialog-title]")).toHaveText("Issue gift card");
  // What the window refuses before it asks the server.
  await dlg.locator("#gcIssueSave").click();
  await expect(dlg.locator("#gcIssueErr")).toHaveText("Enter an amount from $1 to $1,000,000.");
  await dlg.locator("#gcAmount").fill("50");
  await dlg.locator("#gcRecipEmail").fill("not an email");
  await dlg.locator("#gcIssueSave").click();
  await expect(dlg.locator("#gcIssueErr")).toHaveText("Enter a valid email address, or leave it blank.");
  await dlg.locator("#gcRecipEmail").fill("");
  await dlg.locator("#gcSend").check();
  await dlg.locator("#gcIssueSave").click();
  await expect(dlg.locator("#gcIssueErr")).toHaveText("Enter their email address to email the card.");
  await dlg.locator("#gcSend").uncheck();
  await dlg.locator("#gcRecipName").fill(who);
  await dlg.locator("#gcMessage").fill("Happy birthday from Example Club");
  await dlg.locator("#gcNote").fill("Paid by cash at the show");
  const sent = mp.waitForRequest(r => r.url().endsWith("/api/orders") && (r.postDataJSON() || {}).action === "issueGiftCard");
  await dlg.locator("#gcIssueSave").click();
  expect((await sent).postDataJSON()).toMatchObject({ amountCents: 5000, recipientName: who, recipientEmail: "", message: "Happy birthday from Example Club", note: "Paid by cash at the show", sendEmail: false });
  const code = (await dlg.locator("#gcIssuedCode").textContent()).trim();
  expect(code, "the full number, shown once").toMatch(CODE_RE);
  const last4 = code.slice(-4);
  await expect(dlg.locator(".gc-issued-h")).toHaveText(`Gift card ••${last4} for $50.00 is ready.`);
  await expect(toast(mp)).toContainText(`Gift card ••${last4} issued.`);
  await expect(dlg.locator("#gcIssueForm")).toBeHidden();
  await dlg.locator("#gcIssuedDone").click();
  await expect(mp.locator(".admin-modal")).toHaveCount(0);

  // The list's row: card, balance, issued for, for, from, issued, status.
  let row = await findRow(mp, who);
  const cells = row.locator("td");
  await expect(cells.nth(0)).toHaveText("••" + last4);
  await expect(cells.nth(1)).toHaveText("$50.00");
  await expect(cells.nth(2)).toHaveText("$50.00");
  await expect(cells.nth(3)).toHaveText(who);
  await expect(cells.nth(4)).toHaveText("The shop");
  await expect(cells.nth(6)).toHaveText("Active");
  const listed = (await api("listGiftCards", { q: who })).cards;
  expect(listed).toHaveLength(1);
  const id = listed[0].id;
  expect(listed[0]).toMatchObject({ last4, balance: 50, initial: 50, recipientName: who, status: "active", note: "Paid by cash at the show" });

  // The card's window: the masked number, Show (the whole number), Adjust, Void and Resend for Full.
  await row.click();
  const win = cardWindow(mp);
  await expect(win.locator("[data-dialog-title]")).toHaveText(`Gift card ••${last4}`);
  await expect(win.locator(".gc-bal")).toHaveText("$50.00");
  await expect(win.locator(".gc-number .gc-code")).toHaveText("••••-••••-••••-" + last4);
  for (const b of ["show", "adjust", "void", "resend", "close"]) await expect(doBtn(mp, b), b).toBeVisible();
  await expect(win.locator("table.gc-ledger tbody tr")).toHaveCount(1);
  await expect(win.locator("table.gc-ledger tbody tr").first()).toContainText("Issued");
  await expect(win.locator("table.gc-ledger tbody tr").first()).toContainText("+$50.00");
  await doBtn(mp, "show").click();
  await expect(win.locator(".gc-number .gc-code")).toHaveText(code);
  await expect(doBtn(mp, "copy")).toBeVisible();
  await expect(doBtn(mp, "show")).toHaveCount(0);

  // Adjust: what the small window refuses, then −$10 with a reason.
  await doBtn(mp, "adjust").click();
  const adj = topModal(mp);
  await expect(adj.locator("[data-dialog-title]")).toHaveText("Adjust balance");
  await adj.locator("#gcAdjAmount").fill("-60");
  await adj.locator("#gcAdjSave").click();
  await expect(adj.locator("#gcAdjErr")).toHaveText("That is more than the $50.00 on the card.");
  await adj.locator("#gcAdjAmount").fill("-10");
  await adj.locator("#gcAdjSave").click();
  await expect(adj.locator("#gcAdjErr")).toHaveText("Say why the balance is being changed.");
  await adj.locator("#gcAdjNote").fill("Customer lost part of it");
  const adjusted = mp.waitForRequest(r => r.url().endsWith("/api/orders") && (r.postDataJSON() || {}).action === "adjustGiftCard");
  await adj.locator("#gcAdjSave").click();
  expect((await adjusted).postDataJSON()).toMatchObject({ id, deltaCents: -1000, note: "Customer lost part of it" });
  await expect(toast(mp)).toContainText("Balance changed.");
  await expect(win.locator(".gc-bal")).toHaveText("$40.00");
  await expect(win.locator("table.gc-ledger tbody tr")).toHaveCount(2);
  await expect(win.locator("table.gc-ledger")).toContainText("−$10.00");
  await expect(win.locator("table.gc-ledger")).toContainText("Customer lost part of it");
  // The full number stays shown while the window is open.
  await expect(win.locator(".gc-number .gc-code")).toHaveText(code);

  // Void: asks for a reason first.
  await doBtn(mp, "void").click();
  const ask = topModal(mp);
  await expect(ask.locator("[data-dialog-title]")).toHaveText(`Void gift card ••${last4}?`);
  await expect(ask).toContainText("Its $40.00 balance goes to $0.00 and it can't be spent again.");
  await expect(ask.locator("#cmOk")).toHaveText("Void card");
  await expect(ask.locator("#cmOk")).toBeDisabled();
  await ask.locator("#cmReason").fill("Reported stolen");
  await ask.locator("#cmOk").click();
  await expect(toast(mp)).toContainText("Gift card voided.");
  await expect(win.locator(".gc-bal")).toHaveText("$0.00");
  await expect(win.locator(".gc-summary")).toContainText("Void");
  for (const b of ["adjust", "void", "resend"]) await expect(doBtn(mp, b), b + " is gone on a void card").toHaveCount(0);
  await expect(win.locator("table.gc-ledger tbody tr")).toHaveCount(3);
  await expect(win.locator("table.gc-ledger")).toContainText("Voided");
  await doBtn(mp, "close").click();
  await expect(mp.locator(".admin-modal")).toHaveCount(0);
  await expect(row.locator("td").nth(6)).toHaveText("Void");
  expect((await cardOf(api, id)).card).toMatchObject({ status: "void", balance: 0 });

  // The Manager's session at the server: the reads and the writes answer; a void card refuses more.
  const ctx = await apiContext("manager", testInfo.workerIndex);
  try {
    const fresh = await issue(api);
    const b = bodies(fresh.card);
    for (const a of ["listGiftCards", "getGiftCard", "giftCardTotals", "revealGiftCardCode"]) ok200(await tryApi(ctx, a, b[a]), a);
    expect((await tryApi(ctx, "revealGiftCardCode", { id: fresh.card.id })).data.code).toBe(fresh.code);
    let r = await tryApi(ctx, "adjustGiftCard", { id: fresh.card.id, deltaCents: -6000, note: "Too much" });
    refused(r, "taking off more than the balance", "The balance can't go below $0.", 400);
    r = await tryApi(ctx, "adjustGiftCard", { id: fresh.card.id, deltaCents: 1000, note: "" });
    refused(r, "an adjustment with no reason", "Say why the balance is changing.", 400);
    r = await tryApi(ctx, "adjustGiftCard", b.adjustGiftCard);
    ok200(r, "adjustGiftCard");
    expect(r.data.card.balance).toBe(150);
    ok200(await tryApi(ctx, "voidGiftCard", b.voidGiftCard), "voidGiftCard");
    refused(await tryApi(ctx, "voidGiftCard", b.voidGiftCard), "voiding it again", "This gift card is already voided.", 409);
    refused(await tryApi(ctx, "adjustGiftCard", b.adjustGiftCard), "adjusting a void card", "This gift card was voided.", 409);
    refused(await tryApi(ctx, "resendGiftCard", b.resendGiftCard), "resending a void card", "This gift card was voided.", 409);
    refused(await tryApi(ctx, "getGiftCard", { id: 999999999 }), "an unknown card", "Gift card not found", 404);
    r = await tryApi(ctx, "issueGiftCard", { ...b.issueGiftCard, recipientName: uniq("Pat Example"), note: "Made by a manager" });
    ok200(r, "issueGiftCard");
    expect(r.data.card.createdBy).toBe(user("manager").email);
  } finally {
    await ctx.dispose();
  }
});

// ---- Back office: Edit ------------------------------------------------------------------------------------
test("Back office: issues a card and shows and resends it, but has no Adjust or Void; the server refuses adjusting and voiding", async ({ api, as }, testInfo) => {
  test.setTimeout(120_000);
  const sp = await as("staff");
  await openAdmin(sp, "home");
  const tops = await topButtons(sp);
  expect(tops.indexOf("giftcards"), "after Discount codes for Back office too").toBe(tops.indexOf("discounts") + 1);
  await navBtn(sp).click();
  await listShown(sp);
  await expect(sp.locator("#gcNew")).toBeVisible();

  // Issue through the page.
  const who = uniq("Sam Example");
  const email = emailOf("bo");
  await sp.locator("#gcNew").click();
  const dlg = topModal(sp);
  await dlg.locator("#gcAmount").fill("25.50");
  await dlg.locator("#gcRecipName").fill(who);
  await dlg.locator("#gcRecipEmail").fill(email);
  await dlg.locator("#gcSend").check();
  const issued = sp.waitForResponse(r => r.url().endsWith("/api/orders") && (r.request().postDataJSON() || {}).action === "issueGiftCard");
  await dlg.locator("#gcIssueSave").click();
  expect(await (await issued).json()).toMatchObject({ status: "ok", emailSent: false });
  const code = (await dlg.locator("#gcIssuedCode").textContent()).trim();
  expect(code).toMatch(CODE_RE);
  await expect(dlg.locator(".gc-issued-h")).toHaveText(`Gift card ••${code.slice(-4)} for $25.50 is ready.`);
  // This install can't send email: the window says so rather than that it was emailed.
  await expect(dlg.locator(".gc-issued")).toContainText("The email couldn't be sent. Use Resend on the card to try again.");
  await expect(dlg.locator(".gc-issued")).not.toContainText("It was emailed to");
  await expect(dlg.locator("#gcIssueForm"), "the form gives way to the card").toBeHidden();
  // ✕ closes it without asking to discard anything: the card is made.
  await dlg.locator("[data-modal-close]").click();
  await expect(sp.locator(".admin-modal")).toHaveCount(0);
  const mine = (await api("listGiftCards", { q: who })).cards;
  expect(mine).toHaveLength(1);
  expect(mine[0]).toMatchObject({ balance: 25.5, recipientEmail: email, status: "active" });
  const id = mine[0].id;
  expect((await api("revealGiftCardCode", { id })).code).toBe(code);

  // Its window: Show and Resend, no Adjust or Void.
  const row = await findRow(sp, who);
  await row.locator("a.dc-code").click();
  const win = cardWindow(sp);
  await expect(win.locator("[data-dialog-title]")).toHaveText(`Gift card ••${code.slice(-4)}`);
  await expect(doBtn(sp, "show")).toBeVisible();
  await expect(doBtn(sp, "resend")).toBeVisible();
  await expect(doBtn(sp, "adjust"), "no Adjust without Full").toHaveCount(0);
  await expect(doBtn(sp, "void"), "no Void without Full").toHaveCount(0);
  await doBtn(sp, "show").click();
  await expect(win.locator(".gc-number .gc-code")).toHaveText(code);
  // Resend: asks for the address (the recipient's, to start with). This install can't send email, and the page says so.
  await doBtn(sp, "resend").click();
  const ask = topModal(sp);
  await expect(ask.locator("#cmInput")).toHaveValue(email);
  await expect(ask.locator("#cmOk")).toHaveText("Send");
  await ask.locator("#cmInput").fill("not an email");
  await ask.locator("#cmOk").click();
  await expect(ask.locator("#cmInputErr")).toHaveText("Enter a valid email address.");
  await ask.locator("#cmInput").fill("pat@example.com");
  const resent = sp.waitForResponse(r => r.url().endsWith("/api/orders") && (r.request().postDataJSON() || {}).action === "resendGiftCard");
  await ask.locator("#cmOk").click();
  const answer = await (await resent).json();
  expect(answer).toMatchObject({ status: "ok", emailSent: false, sentTo: "pat@example.com" });
  await expect(toast(sp)).toContainText("The email couldn't be sent.");
  await expect(toast(sp)).not.toContainText("Gift card emailed to");
  await doBtn(sp, "close").click();

  // The server: reads, issue, show and resend answer; adjust and void are refused and change nothing.
  const ctx = await apiContext("staff", testInfo.workerIndex);
  try {
    const b = bodies({ id, last4: code.slice(-4) });
    for (const a of ["listGiftCards", "getGiftCard", "giftCardTotals", "revealGiftCardCode", "resendGiftCard"]) ok200(await tryApi(ctx, a, b[a]), a);
    const made = await tryApi(ctx, "issueGiftCard", { ...b.issueGiftCard, recipientName: uniq("Sam Example"), note: "Made by Back office" });
    ok200(made, "issueGiftCard");
    expect(made.data.code).toMatch(CODE_RE);
    refused(await tryApi(ctx, "adjustGiftCard", b.adjustGiftCard), "adjustGiftCard");
    refused(await tryApi(ctx, "voidGiftCard", b.voidGiftCard), "voidGiftCard");
  } finally {
    await ctx.dispose();
  }
  const after = await cardOf(api, id);
  expect(after.card).toMatchObject({ status: "active", balance: 25.5 });
  expect(after.ledger.map(l => l.kind)).toEqual(["issue"]);
});

// ---- Read only ----------------------------------------------------------------------------------------------
test("Read only: the list and a card's window to read, with no Issue, Show, Resend, Adjust or Void; the server refuses every write", async ({ api, as }, testInfo) => {
  const { card, code } = await issue(api);
  const vp = await as("viewer");
  await openAdmin(vp, "giftcards");
  await listShown(vp);
  await expect(vp.locator("#gcNew")).toBeHidden();
  const row = await findRow(vp, card.recipientName);
  await expect(row.locator("td").nth(1)).toHaveText("$50.00");
  await row.locator("td").nth(3).click();
  const win = cardWindow(vp);
  await expect(win.locator(".gc-bal")).toHaveText("$50.00");
  await expect(win.locator(".gc-number .gc-code")).toHaveText("••••-••••-••••-" + code.slice(-4));
  await expect(doBtn(vp, "show")).toBeHidden();
  for (const b of ["adjust", "void", "resend"]) await expect(doBtn(vp, b), b).toHaveCount(0);
  await doBtn(vp, "close").click();
  await expect(vp.locator(".admin-modal")).toHaveCount(0);

  const ctx = await apiContext("viewer", testInfo.workerIndex);
  try {
    const b = bodies(card);
    for (const a of ["listGiftCards", "getGiftCard", "giftCardTotals"]) ok200(await tryApi(ctx, a, b[a]), a);
    for (const a of ["issueGiftCard", "revealGiftCardCode", "resendGiftCard", "adjustGiftCard", "voidGiftCard"]) refused(await tryApi(ctx, a, b[a]), a);
    // Spending a card on an order is a payment (orders.payments Edit), putting money back on one a refund (Full).
    refused(await tryApi(ctx, "redeemGiftCard", { orderId: "NO-SUCH-1", code, requestId: requestId() }), "redeemGiftCard");
    refused(await tryApi(ctx, "refundToGiftCard", { paymentId: 1, amount: 1, orderId: "NO-SUCH-1", requestId: requestId() }), "refundToGiftCard");
  } finally {
    await ctx.dispose();
  }
  const after = await cardOf(api, card.id);
  expect(after.card).toMatchObject({ status: "active", balance: 50 });
  expect(after.ledger).toHaveLength(1);
  expect((await api("listGiftCards", { q: "Never Made" })).cards.filter(c => c.note === "Never made")).toEqual([]);
});

// ---- Production: none -----------------------------------------------------------------------------------------
test("Production: no Gift cards in the menu, no page, and the server refuses every gift card action", async ({ api, as }, testInfo) => {
  const { card, code } = await issue(api);
  const pp = await as("production");
  await openAdmin(pp, "home");
  expect(await topButtons(pp)).not.toContain("giftcards");
  await expect(nav(pp).locator('[data-h="giftcards"]')).toHaveCount(0);
  await openAdmin(pp, "giftcards");
  await notAvailable(pp, "Production");
  await expect(pp.locator("#gcPage")).toHaveCount(0);
  await openAdmin(pp, "giftcards/" + card.id);
  await notAvailable(pp, "Production");
  await expect(pp.locator("#gcCardBody")).toHaveCount(0);

  const ctx = await apiContext("production", testInfo.workerIndex);
  try {
    const b = bodies(card);
    for (const a of PAGE_ACTIONS) refused(await tryApi(ctx, a, b[a]), a);
    refused(await tryApi(ctx, "redeemGiftCard", { orderId: "NO-SUCH-1", code, requestId: requestId() }), "redeemGiftCard");
    refused(await tryApi(ctx, "refundToGiftCard", { paymentId: 1, amount: 1, orderId: "NO-SUCH-1", requestId: requestId() }), "refundToGiftCard");
  } finally {
    await ctx.dispose();
  }
  expect((await cardOf(api, card.id)).card).toMatchObject({ status: "active", balance: 50 });
});

// ---- Reorder from an order's row --------------------------------------------------------------------------------
test("Reorder on an order's row opens a Local sale with its lines at today's prices (fee lines left out, the changed price named) and the new order records what it reordered", async ({ page, api }) => {
  test.setTimeout(120_000);
  const shop = await makeShop(api, { prefix: "gro", products: PRODUCTS });
  const [tee, cap] = shop.products;
  const name = uniq("Robin Reorder");
  const email = emailOf("ro");
  const was = await apiSale(api, shop, {
    items: [{ productId: tee.productId, size: "", qty: 2 }, { productId: cap.productId, size: "", qty: 1 },
      { productId: "__custom__", name: "Setup fee", type: "custom", size: "OSFA", qty: 1, customUnitPrice: 15, taxable: false },
      { productId: "__custom__", name: "Club banner", type: "custom", size: "OSFA", qty: 1, customUnitPrice: 30, taxable: false }],
    customerName: name, contact: email, phone: "555-0142", paid: true });
  const before = await orderOf(api, shop, was);
  expect(openLines(before).sort()).toEqual([["Club banner", 1], ["Sample Cap", 1], ["Sample Tee", 2], ["Setup fee", 1]]);
  expect(before.reorderOf).toBe("");
  // The cap costs more now (published: the sale is priced as the shop sells).
  await api("updateProduct", { org: shop.orgId, productId: cap.productId, type: "cap", name: cap.name, pricingMode: "flat", flatPrice: 22, visible: true, images: [] });
  await api("publish", { org: shop.orgId });

  // What the server hands the window.
  const got = await api("getOrderForReorder", { orderId: was });
  expect(got.reorder).toMatchObject({ orgId: shop.orgId, reorderOf: was, customer: { name, email } });
  expect(got.orgId).toBe(shop.orgId);
  expect(got.reorder.lines.map(l => [l.name, l.qty, l.priceThen])).toEqual([["Sample Tee", 2, 20], ["Sample Cap", 1, 18], ["Club banner", 1, 30]]);
  expect(got.reorder.lines[2]).toMatchObject({ productId: "__custom__", customUnitPrice: 30 });

  await ordersPage(page, shop);
  const btn = actionCell(page, was).getByRole("button", { name: "Reorder" });
  await expect(btn).toBeVisible();
  const asked = posted(page, "getOrderForReorder");
  await btn.click();
  expect(JSON.parse((await asked).postData())).toMatchObject({ orderId: was });
  const form = page.locator("#localSaleForm");
  await expect(form).toBeVisible();
  await expect(form.locator("#lsReorderNote")).toBeVisible();
  await expect(form.locator("#lsReorderNote")).toHaveText(`Reordered from ${was}. Prices are today's; 1 changed since the original order: Sample Cap (was $18.00, now $22.00).`);
  await expect(form.locator(".ls-line")).toHaveCount(3);
  await expect(field(lineOf(form, 0), "product")).toHaveValue(tee.productId);
  await expect(field(lineOf(form, 0), "qty")).toHaveValue("2");
  await expect(field(lineOf(form, 1), "product")).toHaveValue(cap.productId);
  await expect(field(lineOf(form, 1), "qty")).toHaveValue("1");
  await expect(field(lineOf(form, 2), "product")).toHaveValue("__custom__");
  await expect(field(lineOf(form, 2), "customDesc")).toHaveValue("Club banner");
  await expect(field(lineOf(form, 2), "customUnitPrice")).toHaveValue("30.00");
  await expect(form.locator("#lsPricePreview")).toHaveText("Total for 3 items: $92.00");
  // The old order's customer, as it was.
  await expect(form.locator("#lsCustomerPickedText")).toContainText("Picked: " + name);

  await form.locator("#lsPayment").selectOption("Cash");
  await form.locator("#lsPaid").check();
  const sale = posted(page, "createLocalSale");
  await form.getByRole("button", { name: "Record sale" }).click();
  const body = JSON.parse((await sale).postData());
  expect(body).toMatchObject({ reorderOf: was, paymentMethod: "Cash" });
  expect(body.customerId).toBe(before.customerId);
  await expect(toast(page)).toContainText("Local sale recorded — ");
  await expect(form).toHaveCount(0);

  const mine = (await api("getOrders", { org: shop.orgId })).orders.filter(o => o.reorderOf === was);
  expect(mine).toHaveLength(1);
  const now = mine[0];
  expect(now.orderId).not.toBe(was);
  expect(openLines(now).sort()).toEqual([["Club banner", 1], ["Sample Cap", 1], ["Sample Tee", 2]]);
  expect(now.total).toBe(92);
  expect(now.customerId).toBe(before.customerId);
  expect(now.paid).toBeTruthy();
  await expect(page.locator(`tr[data-order="${now.orderId}"]`).first()).toBeVisible();
  // The original is untouched.
  expect((await orderOf(api, shop, was)).reorderOf).toBe("");

  // A reorder whose prices haven't changed says so.
  const plain = await apiSale(api, shop, { customerName: uniq("Casey Plain") });
  await ordersPage(page, shop);
  await actionCell(page, plain).getByRole("button", { name: "Reorder" }).click();
  await expect(form.locator("#lsReorderNote")).toHaveText(`Reordered from ${plain}. Prices are today's; none changed since the original order.`);
  await expect(form.locator(".ls-line")).toHaveCount(1);
  await form.getByRole("button", { name: "Cancel" }).click();
  await expect(form).toHaveCount(0);
});

// ---- Reorder: what the server refuses ---------------------------------------------------------------------------------
const strongPassword = () => "Desk-" + crypto.randomBytes(15).toString("base64url");
const client = (workerIndex) => playwrightRequest.newContext({ baseURL: ADMIN, extraHTTPHeaders: { Origin: ADMIN, "CF-Connecting-IP": freshIp(workerIndex) } });

test("Reorder at the server: Back office reads an order to reorder it, Read only and Production are refused, an unknown or another shop's order is refused, and a role without Customers gets no customer record", async ({ api }, testInfo) => {
  test.setTimeout(120_000);
  const shop = await makeShop(api, { prefix: "grs", products: PRODUCTS });
  const other = await makeShop(api, { prefix: "grx", products: PRODUCTS });
  const c = await makeCustomer(api, { name: uniq("Jamie Example"), email: emailOf("rs") });
  const was = await apiSale(api, shop, { customerId: c.id, customerName: c.name,
    items: [{ productId: shop.products[0].productId, size: "", qty: 1 }, { productId: shop.products[1].productId, size: "", qty: 2 }] });
  const wasOrder = await orderOf(api, shop, was);
  expect(wasOrder.customerId).toBe(c.id);
  // The cap line is cancelled: a reorder leaves it out.
  await api("cancelLineItem", { org: shop.orgId, sheetRow: Number(wasOrder.items.find(i => i.name === "Sample Cap").sheetRow), reason: "Out of stock" });
  expect(openLines(await orderOf(api, shop, was))).toEqual([["Sample Tee", 1]]);

  // The owner: what isn't an order, isn't one, or is another shop's.
  refused(await api("getOrderForReorder", { orderId: "" }, { allowError: true, withStatus: true }), "no order id", "Invalid order ID", 400);
  refused(await api("getOrderForReorder", { orderId: "NO-SUCH-" + slug("x").toUpperCase() }, { allowError: true, withStatus: true }), "an unknown order", "Order not found", 404);
  refused(await api("getOrderForReorder", { orderId: was, org: other.orgId }, { allowError: true, withStatus: true }), "another shop's order", "Order not found", 404);
  // A sale that says it reorders another shop's order, or something that isn't an order number, is refused and not made.
  const tag = uniq("Never Made");
  for (const reorderOf of [was, "not an order!", "NO-SUCH-" + slug("y").toUpperCase()]) {
    const r = await api("createLocalSale", { org: other.orgId, items: [{ productId: other.products[0].productId, size: "", qty: 1 }], paymentMethod: "cash",
      customerName: tag, requestId: requestId(), reorderOf }, { allowError: true, withStatus: true });
    refused(r, "reorderOf " + reorderOf, "That order can't be copied.", 400);
  }
  expect((await api("getOrders", { org: other.orgId })).orders.filter(o => o.customerName === tag)).toEqual([]);

  // Back office (orders.details Edit, Customers Edit): the order with its customer record.
  const sctx = await apiContext("staff", testInfo.workerIndex);
  try {
    const r = await tryApi(sctx, "getOrderForReorder", { orderId: was });
    ok200(r, "getOrderForReorder for Back office");
    expect(r.data.reorder).toMatchObject({ customerId: c.id, reorderOf: was, customer: { name: c.name, email: c.email } });
    expect(r.data.reorder.lines.map(l => [l.name, l.qty, l.priceThen]), "the cancelled line is left out").toEqual([["Sample Tee", 1, 20]]);
    const made = await tryApi(sctx, "createLocalSale", { org: shop.orgId, items: [{ productId: shop.products[1].productId, size: "", qty: 3 }], paymentMethod: "cash",
      customerName: c.name, customerId: c.id, requestId: requestId(), reorderOf: was });
    ok200(made, "createLocalSale with reorderOf for Back office");
    expect((await orderOf(api, shop, made.data.orderId)).reorderOf).toBe(was);
  } finally {
    await sctx.dispose();
  }
  // Read only and Production (orders.details Read): refused.
  for (const role of ["viewer", "production"]) {
    const ctx = await apiContext(role, testInfo.workerIndex);
    try { refused(await tryApi(ctx, "getOrderForReorder", { orderId: was }), "getOrderForReorder for " + role); }
    finally { await ctx.dispose(); }
  }

  // A role that may record a sale but not see customers: the lines and the customer's name, but no customer record.
  const roleName = "Seller " + slug("r").slice(-6);
  const role = (await api("saveRole", { name: roleName, rank: 20, permissions: { fns: { "home.counts": "read", "orders.details": "edit" } } }, USERS)).role;
  let userId = null, ctx = null;
  try {
    const t = slug("gr");
    const who = { email: t + "@example.test", password: strongPassword() };
    const u = await api("create", { name: "Robin Seller " + t.slice(-4), email: who.email, role: role.key }, USERS);
    userId = u.user.id;
    ctx = await client(testInfo.workerIndex);
    let res = await ctx.post("/api/admin-session", { data: { email: who.email, key: u.temporaryPassword } });
    expect((await res.json()).pending).toBe("password");
    res = await ctx.post("/api/admin-password", { data: { action: "change", current: u.temporaryPassword, next: who.password } });
    expect((await res.json()).status).toBe("ok");
    res = await ctx.post("/api/admin-session", { data: { email: who.email, key: who.password } });
    expect(res.status()).toBe(200);
    const r = await tryApi(ctx, "getOrderForReorder", { orderId: was });
    ok200(r, "getOrderForReorder without Customers");
    expect(r.data.reorder.customerId, "no customer record without Customers").toBeUndefined();
    expect(r.data.customerId).toBeUndefined();
    expect(r.data.reorder).toMatchObject({ reorderOf: was, customer: { name: c.name } });
    expect(r.data.reorder.lines.map(l => l.name)).toEqual(["Sample Tee"]);
  } finally {
    if (ctx) await ctx.dispose();
    if (userId) {
      await api("setRole", { id: userId, role: "production" }, { ...USERS, allowError: true });
      await api("setStatus", { id: userId, status: "disabled" }, { ...USERS, allowError: true });
    }
    await api("deleteRole", { roleKey: role.key }, { ...USERS, allowError: true });
  }
});

// ---- Reorder from the customer's page, as Back office -----------------------------------------------------------------
test("Reorder on a customer's page (Back office): a button on each order but a voided one, the sale opens with the customer picked, and the page lists the new order; an archived customer has none", async ({ api, as }) => {
  test.setTimeout(120_000);
  const shop = await makeShop(api, { prefix: "grc", products: PRODUCTS });
  const c = await makeCustomer(api, { name: uniq("Alex Example"), email: emailOf("rc"), phone: "555-0163" });
  const kept = await apiSale(api, shop, { customerId: c.id, customerName: c.name, items: [{ productId: shop.products[1].productId, size: "", qty: 4 }] });
  const voided = await apiSale(api, shop, { customerId: c.id, customerName: c.name });
  await api("voidOrder", { orderId: voided, reason: "Example void" });

  const sp = await as("staff");
  await openAdmin(sp, "customers/" + c.id);
  const historyRow = (orderId) => sp.locator("#custPage table.cust-table tbody tr").filter({ has: sp.getByRole("link", { name: orderId, exact: true }) });
  await expect(historyRow(kept)).toHaveCount(1);
  await expect(historyRow(voided)).toHaveCount(1);
  await expect(historyRow(kept).getByRole("button", { name: "Reorder" })).toBeVisible();
  await expect(historyRow(voided).getByRole("button", { name: "Reorder" }), "no Reorder on a voided order").toHaveCount(0);

  await historyRow(kept).getByRole("button", { name: "Reorder" }).click();
  const form = sp.locator("#localSaleForm");
  await expect(form).toBeVisible();
  await expect(form.locator("#lsReorderNote")).toHaveText(`Reordered from ${kept}. Prices are today's; none changed since the original order.`);
  await expect(form.locator("#lsCustomerPickedText")).toContainText("Picked: " + c.name);
  await expect(field(lineOf(form, 0), "product")).toHaveValue(shop.products[1].productId);
  await expect(field(lineOf(form, 0), "qty")).toHaveValue("4");
  await form.locator("#lsPayment").selectOption("Cash");
  const sale = posted(sp, "createLocalSale");
  await form.getByRole("button", { name: "Record sale" }).click();
  const body = JSON.parse((await sale).postData());
  expect(body).toMatchObject({ reorderOf: kept, customerId: c.id });
  await expect(toast(sp)).toContainText("Local sale recorded — ");
  const now = (await api("getOrders", { org: shop.orgId })).orders.filter(o => o.reorderOf === kept);
  expect(now).toHaveLength(1);
  expect(now[0]).toMatchObject({ customerId: c.id, total: 72 });
  expect(openLines(now[0])).toEqual([["Sample Cap", 4]]);
  // The customer's page is drawn again with the new order on it.
  await expect(sp).toHaveURL(new RegExp("#/?customers/" + c.id + "$"));
  await expect(historyRow(now[0].orderId)).toHaveCount(1);
  await expect(historyRow(now[0].orderId).getByRole("button", { name: "Reorder" })).toBeVisible();

  // Archived: no Reorder at all.
  await api("setCustomerArchived", { id: c.id, archived: true });
  try {
    await openAdmin(sp, "customers/" + c.id);
    await expect(historyRow(kept)).toHaveCount(1);
    await expect(sp.locator("#custPage").getByRole("button", { name: "Reorder" })).toHaveCount(0);
  } finally {
    await api("setCustomerArchived", { id: c.id, archived: false });
  }

  // Read only sees the customer's orders but no Reorder, there or on the order's row.
  const vp = await as("viewer");
  await openAdmin(vp, "customers/" + c.id);
  await expect(vp.locator("#custPage table.cust-table tbody tr").filter({ has: vp.getByRole("link", { name: kept, exact: true }) })).toHaveCount(1);
  await expect(vp.locator("#custPage").getByRole("button", { name: "Reorder" })).toHaveCount(0);
  await ordersPage(vp, shop);
  await expect(actionCell(vp, kept)).toBeVisible();
  await expect(actionCell(vp, kept).getByRole("button", { name: "Reorder" })).toHaveCount(0);
});

// ---- The Gift cards switch ---------------------------------------------------------------------------------------
// The shop's checkout with its first product in the cart (the page keeps a cart across visits: emptied first).
async function openCart(page, shop) {
  await page.goto(shopUrl(shop.subdomain) + "/");
  await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch (e) {} });
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: shop.name })).toBeVisible();
  const card = page.locator("main").getByRole("heading", { level: 3, name: shop.products[0].name, exact: true }).locator("xpath=ancestor::*[.//button[normalize-space()='Add to cart']][1]");
  await card.getByRole("button", { name: "Add to cart" }).click();
  await expect(page.getByRole("button", { name: "Place order" })).toBeVisible();
}
const catalogOf = async (request, shop) => {
  const res = await request.get(shopUrl(shop.subdomain) + "/api/catalog", { headers: { "Cache-Control": "no-store" } });
  expect(res.status()).toBe(200);
  return (await res.json()).catalog;
};
const checkAtShop = async (request, shop, code) => {
  const res = await request.post(shopUrl(shop.subdomain) + "/api/orders", { headers: { Origin: shopUrl(shop.subdomain) }, data: { action: "checkGiftCard", code } });
  return { status: res.status(), data: await res.json() };
};

test("Gift cards switched off in Global settings: no menu item or page, the server refuses, no gift card at checkout, in Payments, in a Local sale or in Payment methods; on again, all back", async ({ page, api, as }) => {
  test.setTimeout(180_000);
  const shop = await makeShop(api, { prefix: "gsw", products: [{ name: "Sample Tee", price: 20 }] });
  const order = await apiSale(api, shop, { customerName: uniq("Taylor Example") });
  const { card, code } = await issue(api);
  expect((await api("getFeatures")).features.giftCards).not.toBe(false);
  const box = page.locator("#gFeatRow-giftCards .gFeature");
  const saveSettings = async () => {
    await page.getByRole("button", { name: "Save global settings" }).click();
    await expect(toast(page)).toContainText("Global settings saved.");
  };
  const giftOffered = async (on) => {
    // The order's Payments window: the Gift card choice under Paid by.
    await ordersPage(page, shop);
    await actionCell(page, order).getByRole("button", { name: "💰 Payments" }).click();
    await expect(page.locator("#pmContent")).toContainText("Amount due");
    await expect(page.locator('#pmMethod option[value="__giftcard__"]')).toHaveCount(on ? 1 : 0);
    await page.locator("#pmCloseBottom").click();
    await expect(page.locator("#pmContent")).toHaveCount(0);
    // The Local sale window: its Gift card box.
    await page.getByRole("button", { name: "+ Local sale" }).click();
    const form = page.locator("#localSaleForm");
    await expect(form).toBeVisible();
    await expect(form.locator("#lsGiftWrap")).toHaveCount(on ? 1 : 0);
    await form.getByRole("button", { name: "Cancel" }).click();
    await expect(form).toHaveCount(0);
    // Payment methods in Global settings: the Gift cards tick.
    await openAdmin(page, "settings");
    await expect(page.locator("#gPayGiftCard")).toHaveCount(on ? 1 : 0);
  };
  const cust = await as(null);
  // On: the checkout has the box, the card checks.
  expect((await catalogOf(cust.request, shop)).giftCardPay).toBe(true);
  await openCart(cust, shop);
  await expect(cust.locator(".gift-section")).toBeVisible();
  await expect(cust.getByRole("button", { name: "Have a gift card?" })).toBeVisible();
  let r = await checkAtShop(cust.request, shop, code);
  expect(r.data).toEqual({ status: "ok", ok: true, last4: code.slice(-4), balance: 50 });
  await giftOffered(true);

  let switchedOff = false;
  try {
    // -- Off, through the page.
    await expect(page.locator("#gFeatRow-giftCards")).toContainText("Gift cards");
    await expect(box).toBeChecked();
    await expect(navBtn(page)).toBeVisible();
    await box.uncheck();
    switchedOff = true;
    await saveSettings();
    expect((await api("getFeatures")).features.giftCards).toBe(false);
    await expect(navBtn(page)).toHaveCount(0);
    await openAdmin(page, "giftcards");
    await expect(page.locator("#featureOffPanel")).toContainText("Gift cards is turned off.");
    await expect(page.locator("#featureOffPanel")).toHaveAttribute("data-feature", "giftCards");
    await expect(page).toHaveTitle(/Gift cards is turned off/);
    await expect(page.locator("#gcPage")).toHaveCount(0);
    const sp = await as("staff");
    await openAdmin(sp, "home");
    await expect(navBtn(sp)).toHaveCount(0);

    // The server: every page action, and spending a card, refused as switched off; checking a card too.
    const b = bodies(card);
    for (const a of PAGE_ACTIONS) {
      const res = await api(a, b[a], { allowError: true, withStatus: true });
      expect(res.status, a + " with Gift cards off").toBe(403);
      expect(res.data, a).toMatchObject({ status: "error", feature: "giftCards", message: FEATURE_OFF });
    }
    r = await api("redeemGiftCard", { orderId: order, code, requestId: requestId() }, { allowError: true, withStatus: true });
    expect(r.status).toBe(403);
    expect(r.data).toMatchObject({ feature: "giftCards", message: FEATURE_OFF });
    r = await api("checkGiftCard", { code }, { allowError: true, withStatus: true });
    expect(r).toEqual({ status: 400, data: { status: "error", message: CARDS_OFF } });
    r = await checkAtShop(cust.request, shop, code);
    expect(r).toEqual({ status: 400, data: { status: "error", message: CARDS_OFF } });
    // A Local sale sent with a card is refused and not made.
    const tag = uniq("Never Made");
    r = await api("createLocalSale", { org: shop.orgId, items: [{ productId: shop.products[0].productId, size: "", qty: 1 }], paymentMethod: "Other",
      customerName: tag, requestId: requestId(), giftCards: [{ code, amount: 20 }] }, { allowError: true, withStatus: true });
    expect(r).toEqual({ status: 400, data: { status: "error", message: CARDS_OFF } });
    expect((await api("getOrders", { org: shop.orgId })).orders.filter(o => o.customerName === tag)).toEqual([]);

    // The checkout: no box.
    expect((await catalogOf(cust.request, shop)).giftCardPay).toBe(false);
    await openCart(cust, shop);
    await expect(cust.getByLabel("Email address")).toBeVisible();
    await expect(cust.locator(".gift-section")).toHaveCount(0);
    await expect(cust.getByRole("button", { name: "Have a gift card?" })).toHaveCount(0);
    await giftOffered(false);

    // -- On again, through the page.
    await expect(box).not.toBeChecked();
    await box.check();
    await saveSettings();
    expect((await api("getFeatures")).features.giftCards).toBe(true);
    switchedOff = false;
    await expect(navBtn(page)).toBeVisible();
    await navBtn(page).click();
    await listShown(page);
    const row = await findRow(page, card.recipientName);
    await expect(row.locator("td").nth(1)).toHaveText("$50.00");
    // Nothing changed while it was off.
    expect((await cardOf(api, card.id)).card).toMatchObject({ status: "active", balance: 50 });
    expect((await catalogOf(cust.request, shop)).giftCardPay).toBe(true);
    await openCart(cust, shop);
    await expect(cust.getByRole("button", { name: "Have a gift card?" })).toBeVisible();
    r = await checkAtShop(cust.request, shop, code);
    expect(r.data).toMatchObject({ ok: true, balance: 50 });
    await giftOffered(true);
  } finally {
    if (switchedOff || (await api("getFeatures")).features.giftCards === false) await api("updateFeatures", { features: { giftCards: true } });
  }
});
