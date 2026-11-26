// Refunds that reach 💰 Payments, and the bulk Cancel selected / Add tracking actions (coverage review gap 7:
// rows 55.7, 55.8, 55.10, 55.11, 52.22, 52.23 — proposed tests P12, P13, P20).
//
// - A paid line taken off in Edit items with a refund: paid back by Venmo, Zelle, check, cash or other, the refund
//   goes into the order's payments (functions/api/orders.js editOrder → recordLineRefund_), once, and no more than
//   the order still holds. Card: Stripe's webhook records it, so the line is only noted (no Stripe is needed for
//   that: nothing is sent to Stripe).
// - A cancelled line's Record refund (setLineItemRefund) does the same, once.
// - → Cancel selected sends the lines in groups of at most 20, each order's lines together (admin.js
//   postOrdersInGroups_), and its toast counts what was cancelled (it used to say "Cancelled 0" every time).
// - → Add tracking sets the number on every selected order in one request and counts orders it didn't find.
//
// Every test makes its own shop and orders and only looks at those: other specs run beside this one.
import { test, expect, openAdmin, toast, uniq, ADMIN } from "../fixtures.mjs";
import { makeShop, placeOrder } from "../lib/data.mjs";

// ---- helpers ---------------------------------------------------------------------------------------------
// Opens the shop's Orders page as a real page load (see orders.spec.mjs).
const ordersPage = async (page, shop) => {
  const target = ADMIN + "/#orders/" + shop.orgId;
  if (page.url() === target) await page.goto("about:blank");
  await openAdmin(page, "orders/" + shop.orgId);
  await expect(page.getByRole("combobox", { name: "Shop" })).toHaveValue(shop.orgId);
};
const orderRow = (page, orderId) => page.locator(`tr[data-order="${orderId}"]`).first();
const actionCell = (page, orderId) => orderRow(page, orderId).locator("td[data-action-td]");
// The table row of one line of an order, by the product's name (each test's products have distinct names).
const lineRow = (page, orderId, name) => page.locator(`tr[data-order="${orderId}"]`, { hasText: name });
const requestId = () => uniq("pay").replace(/\W/g, "");

// A shop with a Tee ($20) and a Cap ($15) — and any `extra` products — and one order placed on its page.
const shopWithOrder = async (api, page, { items, extra = [], customer } = {}) => {
  const shop = await makeShop(api, { prefix: "rfd", products: [
    { name: "Sample Tee", price: 20 },
    { name: "Sample Cap", price: 15, type: "cap", idPrefix: "cap" },
    ...extra,
  ] });
  const order = await placeOrder(page, shop, { customer: customer || uniq("Rae Refund"), items: items || [{ name: "Sample Tee", qty: 1 }, { name: "Sample Cap", qty: 1 }] });
  return { shop, order };
};
const productId = (shop, name) => shop.products.find(p => p.name === name).productId;
// More lines on an order, through the owner's API (the request Edit items → + Add item → Save sends).
const addLines = (api, orderId, pid, n) => api("editOrder", { orderId, removals: [], updates: [],
  additions: Array.from({ length: n }, () => ({ productId: pid, size: "OSFA", qty: 1, personalized: false, persName: "" })) });

// The order as the server has it (getOrders), and its refund entries in the payments ledger.
const getOrder = async (api, shop, orderId) => (await api("getOrders", { org: shop.orgId })).orders.find(o => o.orderId === orderId);
const ledgerRefunds = async (api, shop, orderId) => ((await getOrder(api, shop, orderId)).payments || []).filter(p => Number(p.amount) < 0 && !p.voidedAt);
const lineOf = (order, name) => order.items.find(it => it.name === name);

// Every POST /api/orders the page sends from now on, as { action, body }.
const watchOrderRequests = (page) => {
  const sent = [];
  page.on("request", (req) => {
    if (req.method() !== "POST" || !/\/api\/orders(\?|$)/.test(req.url())) return;
    try { const b = JSON.parse(req.postData() || "{}"); sent.push({ action: b.action, body: b }); } catch (e) { /* not JSON */ }
  });
  return sent;
};

// Edit items: the window's rows are its order's open lines, in order. The index of each row whose product is `pid`
// (read from the row's product list before any row is taken off — a removed row shows only the name).
const openEditItems = async (page, orderId) => {
  await actionCell(page, orderId).getByRole("button", { name: "Edit items" }).click();
  await expect(page.locator("#editOrderSave")).toBeVisible();
  return page.locator("#editOrderRows tr");
};
const editRowIndexes = async (rows, pid) => {
  const values = await rows.evaluateAll((trs) => trs.map(tr => { const s = tr.querySelector("select[data-field=productId]"); return s ? s.value : ""; }));
  return values.map((v, i) => (v === pid ? i : -1)).filter(i => i >= 0);
};
// A removed row's refund amount and how it was paid back. The amount box is taken on "change" (leaving it).
const setRemovedRefund = async (row, amount, method) => {
  const box = row.locator("input[data-field=_refundAmount]");
  await box.fill(String(amount));
  await box.dispatchEvent("change");
  if (method) await row.locator("select[data-field=_refundMethod]").selectOption(method);
};

// 💰 Payments for the order; returns the window's content and its refund rows (the history rows of refunds).
const openPayments = async (page, orderId) => {
  await actionCell(page, orderId).getByRole("button", { name: "💰 Payments" }).click();
  const pm = page.locator("#pmContent");
  await expect(pm).toContainText("Amount due");
  return { pm, refundRows: pm.locator("tr", { hasText: "Refund — " }) };
};
const closePayments = async (page) => {
  await page.locator("#pmCloseBottom").click();
  await expect(page.locator("#pmContent")).toHaveCount(0);
};

// What the Edit items window and the line's Record refund offer as "Refunded by" (admin.js LINE_REFUND_METHODS_).
const REFUND_METHODS = ["Venmo", "Zelle", "Check", "Cash", "Other", "Card (refunded in Stripe)"];

// ---- P12: Edit items --------------------------------------------------------------------------------------
test("Edit items: a paid line taken off with a cash refund puts one refund in Payments, capped at what was kept", async ({ page, api, pageErrors }) => {
  const { shop, order } = await shopWithOrder(api, page);
  const id = order.orderId;
  expect(order.total).toBe("35.00");
  await api("markPaidManual", { org: shop.orgId, orderId: id, requestId: requestId() });
  const capId = productId(shop, "Sample Cap");
  await ordersPage(page, shop);
  const sent = watchOrderRequests(page);

  // Remove, Undo, Remove on the Cap: the window's own buttons (data-edit-action) answer, nothing else does.
  let rows = await openEditItems(page, id);
  await expect(rows).toHaveCount(2);
  const [capIdx] = await editRowIndexes(rows, capId);
  const capRow = rows.nth(capIdx);
  await expect(capRow.locator("[data-edit-action=remove]")).toHaveText("Remove");
  await capRow.getByRole("button", { name: "Remove" }).click();
  await expect(capRow.locator("[data-edit-action=unremove]")).toHaveText("Undo");
  await expect(page.locator("#editOrderNewTotal")).toHaveText("$20.00");
  await capRow.getByRole("button", { name: "Undo" }).click();
  await expect(capRow.getByRole("button", { name: "Remove" })).toBeVisible();
  await expect(page.locator("#editOrderNewTotal")).toHaveText("$35.00");
  await capRow.getByRole("button", { name: "Remove" }).click();
  // The refund starts at the line's total, paid back the way the order was paid (Check, on the storefront).
  await expect(capRow.locator("input[data-field=_refundAmount]")).toHaveValue("15.00");
  await expect(capRow.locator("select[data-field=_refundMethod]")).toHaveValue("check");
  await expect(capRow.locator("select[data-field=_refundMethod] option")).toHaveText(REFUND_METHODS);

  // $40 back by cash is more than the $35 the order holds: refused, and nothing is written.
  await setRemovedRefund(capRow, 40, "cash");
  await page.locator("#editOrderSave").click();
  await expect(toast(page)).toContainText("Edit failed: Refunds can't exceed the $35.00 kept on this order");
  const sentEdit = sent.find(s => s.action === "editOrder");
  expect(sentEdit.body.removals).toEqual([expect.objectContaining({ refundAmount: 40, refundMethod: "cash" })]);
  let o = await getOrder(api, shop, id);
  expect(o.items.filter(it => !it.cancelDate)).toHaveLength(2);
  expect(await ledgerRefunds(api, shop, id)).toHaveLength(0);
  await expect(lineRow(page, id, "Sample Cap").getByRole("button", { name: "Cancel", exact: true })).toBeVisible();

  // $15 by cash: saved. The Cap is cancelled with its refund, and the refund is in Payments.
  rows = await openEditItems(page, id);
  const capRow2 = rows.nth((await editRowIndexes(rows, capId))[0]);
  await capRow2.getByRole("button", { name: "Remove" }).click();
  await setRemovedRefund(capRow2, 15, "cash");
  await page.locator("#editOrderSave").click();
  await expect(toast(page)).toContainText("Order updated. Total decreased by $15.00.");
  await expect(lineRow(page, id, "Sample Cap").locator(".refund-badge")).toContainText("$15.00");
  let { pm, refundRows } = await openPayments(page, id);
  await expect(refundRows).toHaveCount(1);
  await expect(refundRows.first()).toContainText("−$15.00");
  await expect(refundRows.first()).toContainText("Cash");
  await expect(refundRows.first()).toContainText("Refund — Sample Cap");
  await expect(pm).toContainText(/Amount due\s*\$20\.00/);
  await expect(pm).toContainText(/Received\s*\$35\.00/);
  await expect(pm).toContainText(/Refunded\s*−\$15\.00/);
  await expect(pm).toContainText(/Net kept\s*\$20\.00/);
  await expect(pm).toContainText(/Balance due\s*Settled ✓/);
  await closePayments(page);

  // Saving again doesn't book it twice: the same edit sent again (a retry), the line's own refund recorded again,
  // and Edit items saved once more (the Cap is no longer in it).
  o = await getOrder(api, shop, id);
  const capLine = lineOf(o, "Sample Cap");
  await api("editOrder", { orderId: id, removals: [{ itemId: capLine.sheetRow, reason: "Admin edit", refundAmount: 15, refundMethod: "cash" }], updates: [], additions: [] });
  await api("setLineItemRefund", { org: shop.orgId, sheetRow: capLine.sheetRow, refundAmount: 15, method: "cash" });
  expect(await ledgerRefunds(api, shop, id)).toHaveLength(1);
  await ordersPage(page, shop);
  rows = await openEditItems(page, id);
  await expect(rows).toHaveCount(1);
  await page.locator("#editOrderSave").click();
  await expect(toast(page)).toContainText("Order updated.");
  // After a page load: still one refund, and the order is settled at $20 kept.
  await ordersPage(page, shop);
  ({ pm, refundRows } = await openPayments(page, id));
  await expect(refundRows).toHaveCount(1);
  await expect(pm).toContainText(/Net kept\s*\$20\.00/);
  await expect(pm).toContainText(/Balance due\s*Settled ✓/);
  await closePayments(page);
  const refunds = await ledgerRefunds(api, shop, id);
  expect(refunds).toHaveLength(1);
  expect(refunds[0]).toMatchObject({ amount: -15, method: "cash", kind: "refund" });

  // The refused save answered 400, which the browser logs as a failed resource; nothing else may be logged.
  expect(pageErrors.filter(e => !/Failed to load resource: the server responded with a status of 400/.test(e))).toEqual([]);
});

test("Edit items: each refund method the picker offers — Venmo, Zelle, Check, Cash and Other reach Payments, Card only notes the line", async ({ page, api }) => {
  const { shop, order } = await shopWithOrder(api, page);
  const id = order.orderId;
  const capId = productId(shop, "Sample Cap");
  // Five more Caps on the order before it is paid: a Tee and six Caps, $110.
  await addLines(api, id, capId, 5);
  await api("markPaidManual", { org: shop.orgId, orderId: id, requestId: requestId() });
  expect((await getOrder(api, shop, id)).items).toHaveLength(7);
  await ordersPage(page, shop);

  // Take off all six Caps, each refunded a different amount a different way.
  const plan = [["venmo", 1, "Venmo"], ["zelle", 2, "Zelle"], ["check", 3, "Check"], ["cash", 4, "Cash"], ["other", 5, "Other"], ["card", 6, "Card"]];
  const rows = await openEditItems(page, id);
  await expect(rows).toHaveCount(7);
  const caps = await editRowIndexes(rows, capId);
  expect(caps).toHaveLength(6);
  for (const i of caps) await rows.nth(i).getByRole("button", { name: "Remove" }).click();
  await expect(page.locator("#editOrderNewTotal")).toHaveText("$20.00");
  for (const [n, i] of caps.entries()) {
    await expect(rows.nth(i).locator("select[data-field=_refundMethod] option")).toHaveText(REFUND_METHODS);
    await setRemovedRefund(rows.nth(i), plan[n][1], plan[n][0]);
  }
  await page.locator("#editOrderSave").click();
  await expect(toast(page)).toContainText("Order updated. Total decreased by $90.00.");

  // Payments: one refund for each method but card, for its own amount; the card one isn't there ($6).
  const { pm, refundRows } = await openPayments(page, id);
  await expect(refundRows).toHaveCount(5);
  for (const [, amount, label] of plan.slice(0, 5)) {
    const row = refundRows.filter({ hasText: "−$" + amount + ".00" });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(label);
  }
  await expect(pm).not.toContainText("−$6.00");
  await expect(pm).toContainText(/Received\s*\$110\.00/);
  await expect(pm).toContainText(/Refunded\s*−\$15\.00/);
  await expect(pm).toContainText(/Net kept\s*\$95\.00/);
  await closePayments(page);

  // The server agrees: five ledger refunds, by method; every Cap is cancelled with its refund noted on the line,
  // the card one included.
  const refunds = await ledgerRefunds(api, shop, id);
  expect(refunds.map(r => r.method).sort()).toEqual(["cash", "check", "other", "venmo", "zelle"]);
  expect(refunds.reduce((s, r) => s + Number(r.amount), 0)).toBe(-15);
  const o = await getOrder(api, shop, id);
  const capLines = o.items.filter(it => it.name === "Sample Cap");
  expect(capLines.every(it => it.cancelDate && it.refundDate)).toBe(true);
  expect(capLines.map(it => Number(it.refundAmount)).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(o.netReceived).toBe(95);
});

// ---- P13: a cancelled line's Record refund ----------------------------------------------------------------
test("a cancelled line's Record refund by check goes into Payments once; by card it is only noted on the line", async ({ page, api }) => {
  const { shop, order } = await shopWithOrder(api, page, {
    extra: [{ name: "Sample Scarf", price: 10, idPrefix: "scarf" }],
    items: [{ name: "Sample Tee", qty: 1 }, { name: "Sample Cap", qty: 1 }, { name: "Sample Scarf", qty: 1 }],
  });
  const id = order.orderId;
  expect(order.total).toBe("45.00");
  await api("markPaidManual", { org: shop.orgId, orderId: id, requestId: requestId() });
  await ordersPage(page, shop);

  // Cancel the Cap through the page.
  const cancelLine = async (name) => {
    await lineRow(page, id, name).getByRole("button", { name: "Cancel", exact: true }).click();
    await page.locator(".confirm-modal #cmOk").click();
    await expect(toast(page)).toContainText("Item canceled.");
    await expect(lineRow(page, id, name).getByRole("button", { name: "Record refund" })).toBeVisible();
  };
  await cancelLine("Sample Cap");

  // Record refund: it asks how the money went back (starting on Check, how the order was paid) and how much.
  await lineRow(page, id, "Sample Cap").getByRole("button", { name: "Record refund" }).click();
  let dlg = page.locator(".admin-modal", { has: page.locator("#lrMethod") });
  await expect(dlg).toBeVisible();
  await expect(dlg.locator("#lrMethod option")).toHaveText(REFUND_METHODS);
  await expect(dlg.locator("#lrMethod")).toHaveValue("check");
  await expect(dlg.locator("#lrAmount")).toHaveValue("15.00");
  await expect(dlg.locator("#lrOk")).toHaveText("Record refund");
  await dlg.locator("#lrAmount").fill("15");
  await dlg.locator("#lrOk").click();
  await expect(toast(page)).toContainText("Refund of $15.00 recorded — it's in 💰 Payments.");
  await expect(lineRow(page, id, "Sample Cap").locator(".refund-badge")).toContainText("$15.00");
  let { pm, refundRows } = await openPayments(page, id);
  await expect(refundRows).toHaveCount(1);
  await expect(refundRows.first()).toContainText("−$15.00");
  await expect(refundRows.first()).toContainText("Check");
  await expect(refundRows.first()).toContainText("Refund — Sample Cap");
  await expect(pm).toContainText(/Refunded\s*−\$15\.00/);
  await expect(pm).toContainText(/Net kept\s*\$30\.00/);
  await closePayments(page);

  // The Scarf, refunded by card: the button says it only notes it, and Payments doesn't change (Stripe's own
  // refund would reach it by the webhook).
  await cancelLine("Sample Scarf");
  await lineRow(page, id, "Sample Scarf").getByRole("button", { name: "Record refund" }).click();
  dlg = page.locator(".admin-modal", { has: page.locator("#lrMethod") });
  await dlg.locator("#lrMethod").selectOption("card");
  await expect(dlg.locator("#lrOk")).toHaveText("Note refund on line");
  await expect(dlg.locator("#lrNote")).toContainText("Stripe Dashboard");
  await dlg.locator("#lrOk").click();
  await expect(toast(page)).toContainText("Refund noted on the line. The Stripe refund shows in 💰 Payments once it's made.");
  await expect(lineRow(page, id, "Sample Scarf").locator(".refund-badge")).toContainText("$10.00");
  ({ pm, refundRows } = await openPayments(page, id));
  await expect(refundRows).toHaveCount(1);
  await expect(pm).toContainText(/Net kept\s*\$30\.00/);
  await closePayments(page);

  // The same line's refund again (a retry, a second admin): still one refund in the books.
  let o = await getOrder(api, shop, id);
  const cap = lineOf(o, "Sample Cap"), scarf = lineOf(o, "Sample Scarf");
  await api("setLineItemRefund", { org: shop.orgId, sheetRow: cap.sheetRow, refundAmount: 15, method: "check" });
  expect(await ledgerRefunds(api, shop, id)).toHaveLength(1);
  // A non-card refund is capped at what the order still holds ($30): refused, nothing recorded.
  const tooMuch = await api("setLineItemRefund", { org: shop.orgId, sheetRow: scarf.sheetRow, refundAmount: 100, method: "cash" }, { allowError: true, withStatus: true });
  expect(tooMuch.status).toBe(400);
  expect(tooMuch.data.message).toContain("Refund can't exceed the $30.00 kept on this order");
  expect(await ledgerRefunds(api, shop, id)).toHaveLength(1);
  // Cancelling the cancelled Cap again changes nothing — one at a time or in a bulk cancel — and keeps its date.
  const again = await api("cancelLineItem", { org: shop.orgId, sheetRow: cap.sheetRow, reason: "again" });
  expect(again.alreadyCancelled).toBe(true);
  const bulk = await api("bulkCancelLineItems", { org: shop.orgId, sheetRows: [cap.sheetRow], reason: "again" });
  expect(bulk.results).toEqual([expect.objectContaining({ itemId: cap.sheetRow, alreadyCancelled: true })]);
  o = await getOrder(api, shop, id);
  expect(lineOf(o, "Sample Cap").cancelDate).toBe(cap.cancelDate);
  expect(lineOf(o, "Sample Cap").cancelReason || "").not.toBe("again");
  expect(lineOf(o, "Sample Tee").cancelDate).toBeFalsy();

  // After a page load: one refund, $30 kept.
  await ordersPage(page, shop);
  ({ pm, refundRows } = await openPayments(page, id));
  await expect(refundRows).toHaveCount(1);
  await expect(pm).toContainText(/Net kept\s*\$30\.00/);
  await closePayments(page);
});

// 💰 Payments → Record refund checks the date and the paid-from account before it writes its audit entry
// (orders.js recordRefund), so a refund the server refuses leaves no "payment.refunded" entry for money that
// never moved. Here the account picked in the window is closed (made inactive) before Record refund is pressed.
test("💰 Payments → Record refund from an account closed meanwhile is refused and leaves no audit entry", async ({ page, api }) => {
  const { shop, order } = await shopWithOrder(api, page);
  const id = order.orderId;
  await api("markPaidManual", { org: shop.orgId, orderId: id, requestId: requestId() });
  const name = uniq("Refund float");
  const made = (await api("saveAccount", { account: { name, type: "checking", openingDate: "2020-01-01" } })).accounts.find(a => a.name === name);
  const refundAudits = async () => (await api("getAuditLog", { orderId: id, filter: "payment.refunded", limit: 20 })).entries.filter(e => e.action === "payment.refunded");

  await ordersPage(page, shop);
  const { pm } = await openPayments(page, id);
  await pm.locator("#pmRefundAmount").fill("5");
  await pm.locator("#pmRefundMethod").selectOption("venmo");
  await pm.locator("#pmRefundAccount").selectOption(String(made.id));
  // Closed by someone else while the window was open.
  await api("saveAccount", { account: { id: made.id, name, type: "checking", openingDate: "2020-01-01", active: false } });
  await pm.locator("#pmSaveRefund").click();
  await page.locator(".confirm-modal #cmOk").click();
  await expect(page.locator("#pmError")).toHaveText("Choose an active account");
  await page.waitForTimeout(1000);   // an audit entry written after the answer would be there by now
  expect(await refundAudits()).toHaveLength(0);
  expect(await ledgerRefunds(api, shop, id)).toHaveLength(0);

  // Another account: recorded, and audited once.
  const other = await pm.locator("#pmRefundAccount option").evaluateAll((os, v) => os.map(o => o.value).find(x => x && x !== v), String(made.id));
  await pm.locator("#pmRefundAccount").selectOption(other);
  await pm.locator("#pmSaveRefund").click();
  await page.locator(".confirm-modal #cmOk").click();
  await expect(toast(page)).toContainText("Refund recorded.");
  expect(await ledgerRefunds(api, shop, id)).toHaveLength(1);
  await expect.poll(async () => (await refundAudits()).length, { timeout: 10_000 }).toBe(1);
});

// Two refunds saved at the same moment (two admins, two tabs) can't both take the same money: the ceiling is checked
// in the insert itself (db.js addOrderPayment withinKept), so the one that comes second is refused with 409
// "Another refund was recorded first; reload the order to see it." and isn't audited. Which of two requests sent
// together reaches the database first isn't up to the test (on a slow machine one may always win), so the page's
// Save is raced against another refund of the same $35 for up to 8 rounds: each round exactly one of the two goes
// in, the other is refused, and the money is paid in again before the next round. The page is then shown the real
// 409 if a round gave the page's one; otherwise the same answer, so its message is still checked. The refusal
// itself, with both requests past the first check, is pinned by test342_refund_ceiling_race.js.
test("💰 Payments → Record refund raced by another refund of the same money is refused (409) and not recorded twice", async ({ page, api }) => {
  const { shop, order } = await shopWithOrder(api, page);
  const id = order.orderId;
  await api("markPaidManual", { org: shop.orgId, orderId: id, requestId: requestId() });
  const TAKEN = "Another refund was recorded first; reload the order to see it.";
  const rounds = [];
  await page.route(/\/api\/orders(\?|$)/, async (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    if (body.action !== "recordRefund") return route.continue();
    for (let i = 0; i < 8; i++) {
      if (i > 0) await api("addPayment", { orderId: id, amount: 35, method: "venmo", requestId: requestId() });
      const [mine, other] = await Promise.all([
        route.fetch({ postData: JSON.stringify({ ...body, requestId: requestId() }) }),
        api("recordRefund", { orderId: id, amount: 35, method: "cash", requestId: requestId() }, { allowError: true, withStatus: true }),
      ]);
      const mineData = await mine.json();
      rounds.push([mine.status(), mineData.message || "", other.status, other.data.message || ""]);
      if (mine.status() === 409) return route.fulfill({ response: mine });
    }
    return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ status: "error", message: TAKEN }) });
  });

  await ordersPage(page, shop);
  const { pm } = await openPayments(page, id);
  await expect(pm).toContainText(/Received\s*\$35\.00/);
  await pm.locator("#pmRefundAmount").fill("35");
  await pm.locator("#pmRefundMethod").selectOption("venmo");
  await pm.locator("#pmSaveRefund").click();
  await page.locator(".confirm-modal #cmOk").click();
  await expect(page.locator("#pmError")).toHaveText(TAKEN);
  await expect(page.getByText("Refund recorded.")).toHaveCount(0);
  await page.unroute(/\/api\/orders(\?|$)/);

  // Every round: one of the two went in; the other was refused — 409 once both had passed the first check, or the
  // plain "can't exceed" when one was already in by then.
  for (const [mine, mineMsg, other, otherMsg] of rounds) {
    expect([mine, other].filter(s => s === 200)).toHaveLength(1);
    for (const [s, m] of [[mine, mineMsg], [other, otherMsg]]) if (s !== 200) expect(s === 409 ? m === TAKEN : s === 400 && /can't exceed/.test(m)).toBe(true);
  }
  // One refund of $35 per round, the order never below nothing, and each refund audited once.
  const refunds = await ledgerRefunds(api, shop, id);
  expect(refunds).toHaveLength(rounds.length);
  expect(refunds.every(r => r.amount === -35)).toBe(true);
  const o = await getOrder(api, shop, id);
  expect(o.netReceived).toBe(0);
  await expect.poll(async () => (await api("getAuditLog", { orderId: id, filter: "payment.refunded", limit: 50 })).entries
    .filter(e => e.action === "payment.refunded").length, { timeout: 10_000 }).toBe(rounds.length);
});

// The balance due counts the money given back for a cancelled line: $35 paid, the $15 Cap cancelled and refunded,
// then another $15 Cap added — $15 is due again (it used to read Paid, $0 due, so the new Cap was never charged).
// A goodwill refund with nothing cancelled never reopens a balance.
test("a cancelled, refunded line replaced by a new one puts its price back on the balance; a goodwill refund doesn't", async ({ page, api }) => {
  const { shop, order } = await shopWithOrder(api, page);
  const id = order.orderId;
  await api("markPaidManual", { org: shop.orgId, orderId: id, requestId: requestId() });
  await ordersPage(page, shop);
  await lineRow(page, id, "Sample Cap").getByRole("button", { name: "Cancel", exact: true }).click();
  await page.locator(".confirm-modal #cmOk").click();
  await expect(toast(page)).toContainText("Item canceled.");
  await lineRow(page, id, "Sample Cap").getByRole("button", { name: "Record refund" }).click();
  const dlg = page.locator(".admin-modal", { has: page.locator("#lrMethod") });
  await dlg.locator("#lrMethod").selectOption("check");
  await dlg.locator("#lrAmount").fill("15");
  await dlg.locator("#lrOk").click();
  await expect(toast(page)).toContainText("Refund of $15.00 recorded");
  let { pm } = await openPayments(page, id);
  await expect(pm).toContainText(/Amount due\s*\$20\.00/);
  await expect(pm).toContainText(/Balance due\s*Settled ✓/);
  await closePayments(page);

  // Another Cap in its place (the request Edit items → + Add item → Save sends).
  await addLines(api, id, productId(shop, "Sample Cap"), 1);
  await ordersPage(page, shop);
  ({ pm } = await openPayments(page, id));
  await expect(pm).toContainText(/Amount due\s*\$35\.00/);
  await expect(pm).toContainText(/Received\s*\$35\.00/);
  await expect(pm).toContainText(/Refunded\s*−\$15\.00/);
  await expect(pm).toContainText(/Net kept\s*\$20\.00/);
  await expect(pm).toContainText(/Balance due\s*\$15\.00/);
  await closePayments(page);
  let o = await getOrder(api, shop, id);
  expect(o.balanceDue).toBe(15);
  expect(o.paid).toBe(false);

  // Mark as paid books the $15, and the order is settled.
  await api("markPaidManual", { org: shop.orgId, orderId: id, requestId: requestId() });
  o = await getOrder(api, shop, id);
  expect(o.balanceDue).toBe(0);
  expect(o.paid).toBe(true);
  expect(o.amountReceived).toBe(50);

  // A $5 goodwill refund (nothing more cancelled): still settled.
  await api("recordRefund", { orderId: id, amount: 5, method: "cash", requestId: requestId() });
  await ordersPage(page, shop);
  ({ pm } = await openPayments(page, id));
  await expect(pm).toContainText(/Refunded\s*−\$20\.00/);
  await expect(pm).toContainText(/Balance due\s*Settled ✓/);
  await closePayments(page);
  o = await getOrder(api, shop, id);
  expect(o.balanceDue).toBe(0);
  expect(o.paid).toBe(true);
});

// ---- P20: bulk cancel and bulk tracking -------------------------------------------------------------------
test("→ Cancel selected: 24 lines over three orders go in groups of at most 20, and the toast counts them", async ({ page, api }) => {
  const { shop, order: a } = await shopWithOrder(api, page);
  const capId = productId(shop, "Sample Cap");
  const b = await placeOrder(page, shop, { customer: uniq("Bea Bulk"), items: [{ name: "Sample Tee", qty: 1 }, { name: "Sample Cap", qty: 1 }] });
  const c = await placeOrder(page, shop, { customer: uniq("Cy Bulk") });
  // A and B: twelve lines each. One of A's is cancelled already: bulk cancel leaves it out.
  await addLines(api, a.orderId, capId, 10);
  await addLines(api, b.orderId, capId, 10);
  const a0 = await getOrder(api, shop, a.orderId);
  const preCancelled = a0.items[a0.items.length - 1];
  await api("cancelLineItem", { org: shop.orgId, sheetRow: preCancelled.sheetRow, reason: "Cancelled before the bulk cancel" });
  const before = (await getOrder(api, shop, a.orderId)).items.find(it => it.sheetRow === preCancelled.sheetRow);
  expect(before.cancelDate).toBeTruthy();

  await ordersPage(page, shop);
  const sent = watchOrderRequests(page);
  await page.getByRole("checkbox", { name: "Select all orders" }).check();
  await expect(page.locator("#bulkBarCount")).toHaveText("3 orders selected");
  await page.locator("#bulkBar").getByRole("button", { name: "→ Cancel selected" }).click();
  const dlg = page.locator(".confirm-modal");
  await expect(dlg).toContainText("Cancel 24 items?");
  await expect(dlg).toContainText("Across 3 orders");
  await dlg.locator("#cmReason").fill("Event called off");
  await dlg.locator("#cmOk").click();
  await expect(toast(page)).toContainText("Cancelled 24 items.");
  await expect(toast(page)).not.toContainText("stopped");

  // Two requests, neither over 20 lines, each order's lines all in one of them (so its customer gets one email):
  // in the list's order, C's one line with B's twelve, then A's eleven.
  const reqs = sent.filter(s => s.action === "bulkCancelLineItems");
  expect(reqs.map(r => r.body.sheetRows.length).sort((x, y) => x - y)).toEqual([11, 13]);
  expect(reqs.every(r => r.body.reason === "Event called off")).toBe(true);
  for (const o of [a, b, c]) {
    const open = (await getOrder(api, shop, o.orderId)).items.filter(it => it.sheetRow !== preCancelled.sheetRow).map(it => it.sheetRow);
    expect(reqs.filter(r => open.some(row => r.body.sheetRows.includes(row))), "requests holding " + o.orderId + "'s lines").toHaveLength(1);
    expect(reqs.find(r => open.some(row => r.body.sheetRows.includes(row))).body.sheetRows).toEqual(expect.arrayContaining(open));
  }
  expect(reqs.flatMap(r => r.body.sheetRows)).toHaveLength(24);
  expect(reqs.flatMap(r => r.body.sheetRows)).not.toContain(preCancelled.sheetRow);

  // All three orders are cancelled now: they leave the list unless Include cancelled is ticked.
  for (const o of [a, b, c]) await expect(orderRow(page, o.orderId)).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Include cancelled" }).check();
  for (const o of [a, b, c]) await expect(orderRow(page, o.orderId)).toBeVisible();
  for (const o of [a, b, c]) {
    const items = (await getOrder(api, shop, o.orderId)).items;
    expect(items.every(it => it.cancelDate)).toBe(true);
  }
  // The line cancelled before kept its own date and reason.
  const after = (await getOrder(api, shop, a.orderId)).items.find(it => it.sheetRow === preCancelled.sheetRow);
  expect(after.cancelDate).toBe(before.cancelDate);
  expect(after.cancelReason).toBe(before.cancelReason);
  await page.getByRole("checkbox", { name: "Include cancelled" }).uncheck();
});

test("→ Add tracking sets the number on every selected order in one request, and counts an order it didn't find", async ({ page, api }) => {
  const shop = await makeShop(api, { prefix: "rtk", products: [{ name: "Sample Tee", price: 20 }] });
  const ids = [];
  for (const who of ["Ari Track", "Bo Track"]) {
    const o = await placeOrder(page, shop, { customer: uniq(who) });
    await api("markPaidManual", { org: shop.orgId, orderId: o.orderId, requestId: requestId() });
    ids.push(o.orderId);
  }
  await ordersPage(page, shop);
  const sent = watchOrderRequests(page);
  const bar = page.locator("#bulkBar");
  const selectAll = async () => {
    for (const id of ids) {
      const box = page.getByRole("checkbox", { name: "Select order " + id });
      if (!(await box.isChecked())) await box.check();
    }
    await expect(page.locator("#bulkBarCount")).toHaveText("2 orders selected");
  };
  await selectAll();
  await bar.getByRole("button", { name: "→ Add tracking" }).click();
  const form = page.locator("form", { has: page.locator(".tracking-input") });
  await expect(form).toContainText("Add tracking — 2 orders");
  // The number is required here.
  await form.getByRole("button", { name: "Save tracking" }).click();
  await expect(form.locator(".tracking-err")).toHaveText("Enter a tracking number.");
  const tn = "TRK-E2E-9" + Date.now().toString(36).slice(-4).toUpperCase();
  await form.locator(".tracking-input").fill(tn);
  await form.getByRole("button", { name: "Save tracking" }).click();
  await expect(toast(page)).toContainText("Tracking saved for 2 orders.");
  for (const id of ids) await expect(orderRow(page, id).locator("td[data-tracking-td]")).toContainText(tn);
  const reqs = sent.filter(s => s.action === "bulkRecordTracking");
  expect(reqs).toHaveLength(1);
  expect([...reqs[0].body.orderIds].sort()).toEqual([...ids].sort());

  // An order that has gone by the time the request lands (deleted elsewhere) is counted, not silently dropped:
  // the request is sent with a third, unknown order number added.
  const gone = "E2E-GONE-" + Date.now().toString(36).toUpperCase();
  await page.route("**/api/orders", async (route) => {
    const req = route.request();
    let body = null;
    try { body = JSON.parse(req.postData() || "{}"); } catch (e) { /* not JSON */ }
    if (req.method() === "POST" && body && body.action === "bulkRecordTracking") {
      await route.continue({ postData: JSON.stringify({ ...body, orderIds: [...body.orderIds, gone] }) });
    } else {
      await route.continue();
    }
  });
  await selectAll();
  await bar.getByRole("button", { name: "→ Add tracking" }).click();
  const tn2 = tn + "-B";
  await form.locator(".tracking-input").fill(tn2);
  await form.getByRole("button", { name: "Save tracking" }).click();
  await expect(toast(page)).toContainText("Tracking saved for 2 orders, 1 not found (deleted?).");
  await page.unroute("**/api/orders");

  // After a page load both orders have the new number.
  await ordersPage(page, shop);
  for (const id of ids) await expect(orderRow(page, id).locator("td[data-tracking-td]")).toContainText(tn2);
  for (const id of ids) expect((await getOrder(api, shop, id)).trackingNumber).toBe(tn2);
});
