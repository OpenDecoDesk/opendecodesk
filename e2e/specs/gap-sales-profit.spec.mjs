// Phase 8 reports end to end: Reports → Sales by…, Profit per job and Gift card liability (public/admin-salesreports.js),
// the order window's Profit box (public/admin.js pmLoadProfit_ / pmProfitHtml_), and the server's answers and refusals
// (functions/api/orders.js getSalesReport, getProfitReport, getOrderProfit, getGiftCardLiability; functions/_lib/db.js
// businessRange_, getSalesReport, p8Profits_, getProfitReport, getGiftCardLiability). What's checked:
//
// - Two shops (Example Club, Example School District), two customer records and a walk-in with no record, and orders on
//   fixed days in March 2021 with the business on America/Chicago: a manual discount shared over two lines, a line refund,
//   a refund not tied to a line, a cancelled line, a gift card line on a mixed order, a gift-card-only order, a voided
//   order, orders shipped a few minutes either side of the range's business-day edges, and one not shipped at all.
// - Sales by…: the default dates and the quick ranges, the client's own date checks, the server's "three years" refusal
//   shown on the page, the shop select, each Group by (customer — with the record link, the no-record row and escaping —,
//   product, shop, decoration) with every column, the totals row and shipping / rush / tax below it, the share bars, the
//   sale-date note for both bases (shipped vs placed: the unshipped order appears only on "placed"), Export CSV, the empty
//   state, a load error, and a slower older answer never replacing a newer one.
// - The same orders under UTC: the business-day edges move (one order falls out, another comes in).
// - Profit per job: lowest margin first (negative marked), the other three sorts, the totals strip (orders using
//   estimates), "est." marks, a row's cost parts (Labor "not counted yet"), Export CSV with the parts as columns, the
//   order link opening the order, and the order window's Profit box (revenue, each cost part, profit, margin, the notes)
//   and its quiet failure line.
// - Gift card liability: months on the business calendar (a card issued at 23:30 on the last day of February is
//   February's), sold vs given, spent, put back, adjusted, voided, every month shown even when empty, the totals, "On cards
//   right now" and Export CSV.
// - Roles: Manager uses all three; Back office has no Sales by… or Profit per job (menu, page and server) and no Profit
//   box, but reads Gift card liability; Production has none of it; a role with Profit per job but without costs.view is
//   refused "You can't see costs." and has no Profit page or box. The server's checks of dates, group, sort, shop and order.
//
// Money the e2e install can't make through its pages (a Stripe-style card fee, a bought postage label, a digitizing
// vendor's bill, a gift card sold online, a line made before stock was tracked) and the dates of gift card ledger rows are
// put in the local database directly (wrangler d1 execute --local, as gap-decoration-quotes does). Everything else goes
// through the owner's API or the pages.
//
// The spec changes install-wide settings (Region time zone, the sale-date basis, decoration prices, the Pricing supplies
// default, the Read only role), so it is in ALONE (playwright.config.mjs) and puts each back in afterAll.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { test, expect, openAdmin, navTo, uniq, apiContext, callApi } from "../fixtures.mjs";
import { makeShop } from "../lib/data.mjs";
import { CONFIG, STATE_DIR, REPO } from "../lib/install.mjs";

test.describe.configure({ mode: "serial" });

const ZONE = "America/Chicago";     // CST (UTC−6) in early March 2021
const FROM = "2021-03-01", TO = "2021-03-10";
const TAG = crypto.randomBytes(3).toString("hex");
const D = {};                       // the data the tests read: made in the first test
const saved = {};                   // install-wide settings, put back in afterAll

// ---- helpers -----------------------------------------------------------------------------------------------------
const sql = (command) => {
  const r = spawnSync(path.join(REPO, "node_modules", ".bin", "wrangler"), ["d1", "execute", "DB", "--local", "--config", CONFIG, "--persist-to", STATE_DIR, "--command", command, "--json"],
    { cwd: REPO, encoding: "utf8", env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" } });
  if (r.status !== 0) throw new Error("wrangler d1 execute failed: " + (r.stdout || "") + (r.stderr || ""));
  return JSON.parse(r.stdout)[0].results;
};
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const requestId = () => "e2e" + crypto.randomBytes(8).toString("hex");
const actionOf = (req) => { try { return JSON.parse(req.postData() || "{}").action; } catch (e) { return ""; } };
const bodyOf = (req) => { try { return JSON.parse(req.postData() || "{}"); } catch (e) { return {}; } };
const answerOf = (page, action, pred = () => true) => page.waitForResponse(r => r.url().endsWith("/api/orders") && actionOf(r.request()) === action && pred(bodyOf(r.request())));
const $ = (c) => (c < 0 ? "−$" : "$") + (Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const minus = (c) => c ? "−" + $(c) : "—";
const pct = (part, whole) => (Math.round(part * 1000 / whole) / 10);
const pctText = (v) => v.toFixed(1) + "%";
const cellsOf = async (row) => (await row.locator(":scope > td").allInnerTexts()).map(t => t.replace(/\s+/g, " ").trim());
const readCsv = async (dl) => fs.readFileSync(await (await dl).path(), "utf8").split("\r\n").filter(Boolean);
// A user of `role`'s own API, answers kept with their status.
async function asApi(role, fn) {
  const ctx = await apiContext(role);
  try { return await fn((action, body = {}) => callApi(ctx, action, body, { allowError: true, withStatus: true })); }
  finally { await ctx.dispose(); }
}
async function withOwner(fn) {
  const ctx = await apiContext("owner");
  try { return await fn((action, body, opts) => callApi(ctx, action, body, opts)); } finally { await ctx.dispose(); }
}

// Pages.
const salesRoot = (page) => page.locator("#srSalesPage");
const profitRoot = (page) => page.locator("#srProfitPage");
const liabRoot = (page) => page.locator("#srLiabPage");
// Types the range into a report page's boxes: To first (an earlier To than From is the page's own error, no request),
// then From; waits for the answer to exactly that range.
async function setRange(page, root, action, from, to) {
  const fromBox = root.getByLabel("From"), toBox = root.getByLabel("To");
  if ((await fromBox.inputValue()) === from && (await toBox.inputValue()) === to) return;
  const ans = answerOf(page, action, b => b.dateFrom === from && b.dateTo === to);
  if ((await fromBox.inputValue()) > to) {
    await toBox.fill(to);
    await expect(root.locator(".sr-body [role=alert]")).toHaveText("The From date is after the To date.");
    await fromBox.fill(from);
  } else {
    await fromBox.fill(from);
    await toBox.fill(to);
  }
  await ans;
  await expect(root.locator(".sr-body")).not.toContainText("Loading…");
}
async function pickShop(page, root, action, orgId) {
  const ans = answerOf(page, action, b => (b.orgId || "") === orgId);
  await root.getByLabel("Shop").selectOption(orgId);
  const r = await ans;
  await expect(root.locator(".sr-body")).not.toContainText("Loading…");
  return r;
}
async function groupBy(page, label, by) {
  const root = salesRoot(page);
  const ans = answerOf(page, "getSalesReport", b => b.by === by);
  await root.getByRole("group", { name: "Group by" }).getByRole("button", { name: label, exact: true }).click();
  await ans;
  await expect(root.locator(".sr-body")).not.toContainText("Loading…");
  await expect(root.getByRole("button", { name: label, exact: true })).toHaveAttribute("aria-pressed", "true");
}
const salesRows = (page) => salesRoot(page).locator("#srSalesTable tbody tr");
const salesRow = (page, label) => salesRows(page).filter({ has: page.locator("td.stack-title").getByText(label, { exact: true }) });
// One row of the Sales by… table as the page writes it.
const salesCells = (label, r, share) => [label, String(r.orders), String(r.qty), $(r.gross), minus(r.disc), minus(r.ref), $(r.gross - r.disc - r.ref)]
  .concat(share === undefined ? [] : [pctText(share)]);
// Opens an order's 💰 Payments window from its shop's Orders page (the dates widened to the order's day, as a report's
// order link does).
async function paymentsOf(page, orgId, orderId, day) {
  await openAdmin(page, "orders/" + orgId);
  await page.evaluate(([o, i, d]) => openOrderFromDashboard_(o, i, d), [orgId, orderId, day + "T12:00:00Z"]);
  const row = page.locator(`tr[data-order="${orderId}"]`).first();
  await expect(row).toBeVisible();
  await row.locator("td[data-action-td]").getByRole("button", { name: "💰 Payments" }).click();
  await expect(page.locator("#pmContent")).toContainText("Amount due");
  return page.locator("#pmContent");
}
const profitRows = (page) => profitRoot(page).locator("#srProfitTable tbody tr.sr-prow");
const profitRow = (page, orderId) => profitRows(page).filter({ has: page.locator(".mono", { hasText: new RegExp("^" + orderId + "$") }) });

// ---- settings: put back at the end -----------------------------------------------------------------------------------
test.afterAll(async () => {
  await withOwner(async (api) => {
    if (saved.locale) await api("updateLocaleSettings", { locale: { timeZone: saved.locale.timeZone || "", country: saved.locale.country } });
    if (saved.saleDate) await api("updateAccountingSettings", { saleDate: saved.saleDate });
    if (saved.deco) await api("updateDecorationSettings", { types: saved.deco.types, pricing: saved.deco.pricing });
    if (saved.pricing) await api("updatePricingSettings", { pricing: saved.pricing });
  });
  if (saved.viewerRole) await restoreViewer();
});
async function viewerRole(api) {
  const roles = await api("listRoles", {}, { path: "/api/admin-users" });
  return roles.roles.find(r => r.name === "Read only");
}
async function restoreViewer() {
  await withOwner((api) => api("saveRole", { roleKey: saved.viewerRole.key, name: saved.viewerRole.name, rank: saved.viewerRole.rank, permissions: saved.viewerRole.permissions }, { path: "/api/admin-users" }));
  saved.viewerRole = null;
}

// ---- The data ------------------------------------------------------------------------------------------------------
test("The data: two shops, customers and orders on fixed days, the business on America/Chicago", async ({ api }) => {
  saved.locale = (await api("getLocaleSettings")).locale;
  saved.saleDate = (await api("getAccountingSettings")).accounting.saleDate;
  saved.deco = await api("getDecorationSettings", {});
  await api("updateLocaleSettings", { locale: { timeZone: ZONE, country: saved.locale.country } });
  await api("updateAccountingSettings", { saleDate: "shipped" });
  const pricing = saved.deco.pricing;
  await api("updateDecorationSettings", { types: [...new Set([...(saved.deco.types || []), "embroidery", "dtf", "screenprint"])],
    pricing: { ...pricing, dtf: { ...pricing.dtf, costCents: 200 }, screenprint: { ...pricing.screenprint, costCents: 100 } } });
  // The Pricing default for supplies a piece (what a product without its own supplies cost uses): $0.35 while this runs.
  const pr = (await api("getPricingSettings")).pricing;
  saved.pricing = { cardPct: pr.cardPct, cardFixed: pr.cardFixed, supplies: pr.supplies,
    targetHourly: pr.targetHourly == null ? "" : pr.targetHourly, targetIncome: pr.targetIncome == null ? "" : pr.targetIncome };
  await api("updatePricingSettings", { pricing: { ...saved.pricing, supplies: 0.35 } });
  D.supplies = 35;
  D.outstandingBefore = (await api("getGiftCardLiability", { dateFrom: FROM, dateTo: TO })).outstandingNowCents;

  // Example Club: a $20 tee (embroidery: no decoration cost; $1.25 of transfers and $0.50 of supplies a piece) and a $15
  // cap (DTF at $2.00, no blank, supplies at the Pricing default). Example School District: a $40 hoodie (screen print at
  // $1.00, no blank, $1.00 of supplies).
  const s1 = D.s1 = await makeShop(api, { prefix: "spc", name: "Example Club " + TAG, products: [
    { name: "Club Tee " + TAG, price: 20, idPrefix: "tee", extra: { decorationType: "embroidery", noDesignNeeded: true, transferCost: 1.25, suppliesCost: 0.5 } },
    { name: "Club Cap " + TAG, price: 15, idPrefix: "cap", type: "cap", extra: { decorationType: "dtf", noDesignNeeded: true, noBlankNeeded: true } }] });
  const s2 = D.s2 = await makeShop(api, { prefix: "spd", name: "Example School District " + TAG, products: [
    { name: "District Hoodie " + TAG, price: 40, idPrefix: "hood", extra: { decorationType: "screenprint", noDesignNeeded: true, noBlankNeeded: true, suppliesCost: 1 } }] });
  const [tee, cap] = s1.products, [hood] = s2.products;
  D.custA = { name: "Pat Example " + TAG };
  D.custA.id = (await api("saveCustomer", { name: D.custA.name, email: "pat." + TAG + "@example.com" })).id;
  // Markup in a name: shown as written.
  D.custB = { name: "Example School District <i>Office</i> " + TAG };
  D.custB.id = (await api("saveCustomer", { name: D.custB.name, email: "office." + TAG + "@example.com" })).id;
  D.lane = "lane." + TAG + "@example.com";

  const sale = async (shop, items, extra = {}) => (await api("createLocalSale", { org: shop.orgId, requestId: requestId(), paymentMethod: "", items, ...extra })).orderId;
  const ship = (orderId, shippedAt) => api("setOrderDates", { orderId, dates: { shippedAt } });
  const line = (p, qty) => ({ productId: p.productId, size: "", qty });
  const o = D.o = {};
  // O1: 2 tees + 1 cap ($55), a $5.50 discount (tee $4.00, cap $1.50), paid by Venmo; placed and shipped at 00:30 on
  // March 1 in Chicago (06:30 UTC) — the first minutes of the range.
  o.o1 = await sale(s1, [line(tee, 2), line(cap, 1)], { customerId: D.custA.id, customerName: D.custA.name, placedAt: "2021-03-01T06:30:00Z" });
  await api("setDiscount", { orderId: o.o1, org: s1.orgId, amount: 5.5, note: "Club discount" });
  await api("addPayment", { orderId: o.o1, org: s1.orgId, amount: 49.5, method: "venmo", requestId: requestId() });
  await ship(o.o1, "2021-03-01T06:30:00Z");
  // O2: a tee and a $10 custom "Setup fee"; $20 paid by check, $5 of the tee refunded (a line refund); shipped at 23:30 on
  // March 10 in Chicago (05:30 UTC on the 11th) — the last minutes of the range.
  o.o2 = await sale(s1, [line(tee, 1), { productId: "__custom__", name: "Setup fee " + TAG, customUnitPrice: 10, qty: 1, taxable: false }],
    { customerId: D.custA.id, customerName: D.custA.name, placedAt: "2021-03-02T15:00:00Z" });
  await api("addPayment", { orderId: o.o2, org: s1.orgId, amount: 20, method: "check", requestId: requestId() });
  D.o2TeeLine = sql(`SELECT id FROM order_items WHERE orderId = ${q(o.o2)} AND productId = ${q(tee.productId)}`)[0].id;
  await api("setLineItemRefund", { org: s1.orgId, sheetRow: D.o2TeeLine, refundAmount: 5, method: "check" });
  await ship(o.o2, "2021-03-11T05:30:00Z");
  // O3 (the district): 3 hoodies, a 4th hoodie on its own line (cancelled below) and a $25 gift card line (below), $8
  // shipping; $50 of it paid by a gift card ($10 of that put back on the card later), $70 in cash.
  o.o3 = await sale(s2, [line(hood, 3), line(hood, 1), { productId: "__custom__", name: "Gift card", customUnitPrice: 25, qty: 1, taxable: false }],
    { customerId: D.custB.id, customerName: D.custB.name, placedAt: "2021-03-05T15:00:00Z", shippingCost: 8, shippingMethod: "UPS Ground",
      shippingAddress: { name: "District Office", line1: "1 School Rd", city: "Springfield", state: "IL", zip: "62701" } });
  await ship(o.o3, "2021-03-05T18:00:00Z");
  // O5: a walk-in with no customer record; 1 hoodie paid in cash, $10 of it refunded (not tied to a line); a $50.00
  // digitizing bill (below) puts it under water.
  o.o5 = await sale(s2, [line(hood, 1)], { customerName: "Lane Walkin " + TAG, placedAt: "2021-03-03T15:00:00Z", paid: true, paymentMethod: "Cash" });
  await api("recordRefund", { orderId: o.o5, org: s2.orgId, amount: 10, method: "cash", note: "Part refund", requestId: requestId() });
  await ship(o.o5, "2021-03-03T18:00:00Z");
  // Left out: the gift-card-only order (O4), shipped in the range; 23:30 on Feb 28 and 00:30 on Mar 11 in Chicago
  // (O6, O7); a voided order (O9); and one not shipped (O8 — in only when sales count on the day they're placed).
  o.o4 = await sale(s2, [{ productId: "__custom__", name: "Gift card", customUnitPrice: 50, qty: 1, taxable: false }], { customerName: "Gift Buyer " + TAG, placedAt: "2021-03-04T15:00:00Z" });
  await ship(o.o4, "2021-03-04T18:00:00Z");
  o.o6 = await sale(s1, [line(tee, 1)], { customerId: D.custA.id, customerName: D.custA.name, placedAt: "2021-03-01T05:30:00Z" });
  await ship(o.o6, "2021-03-01T05:30:00Z");
  o.o7 = await sale(s1, [line(tee, 1)], { customerId: D.custA.id, customerName: D.custA.name, placedAt: "2021-03-11T06:30:00Z" });
  await ship(o.o7, "2021-03-11T06:30:00Z");
  o.o8 = await sale(s1, [line(cap, 1)], { customerId: D.custA.id, customerName: D.custA.name, placedAt: "2021-03-04T15:00:00Z" });
  o.o9 = await sale(s1, [line(tee, 1)], { customerId: D.custA.id, customerName: D.custA.name, placedAt: "2021-03-06T15:00:00Z" });
  await ship(o.o9, "2021-03-06T15:00:00Z");

  // Gift cards: G1 ($50, given) is spent on O3 and $10 of it put back; G2 ($50) is the one O4 sold; G3 ($30, given) gets
  // $5 taken off by hand and is then voided.
  const card = async (dollars) => { const d = await api("issueGiftCard", { amountCents: dollars * 100, recipientName: "Sam Example " + TAG, note: "e2e " + TAG, sendEmail: false, requestId: requestId() }); return { id: d.card.id, code: d.code }; };
  const g1 = D.g1 = await card(50), g2 = D.g2 = await card(50), g3 = D.g3 = await card(30);
  const red = await api("redeemGiftCard", { orderId: o.o3, org: s2.orgId, code: g1.code, amount: 50, requestId: requestId() });
  expect(red.taken).toBe(50);
  await api("addPayment", { orderId: o.o3, org: s2.orgId, amount: 70, method: "cash", requestId: requestId() });
  const gcPay = sql(`SELECT id FROM order_payments WHERE orderId = ${q(o.o3)} AND giftCardId = ${g1.id} AND kind = 'payment'`)[0].id;
  await api("refundToGiftCard", { paymentId: gcPay, amount: 10, orderId: o.o3, requestId: requestId() });
  await api("adjustGiftCard", { id: g3.id, deltaCents: -500, note: "Taken off by hand" });
  await api("voidGiftCard", { id: g3.id, note: "Lost card" });

  // What the pages can't make here.
  const t = (s) => q(s);
  sql([
    // O1: Venmo's $1.50 fee, a $8.00 label (and a voided one), a $12.00 digitizing bill (and a deleted one).
    `UPDATE order_payments SET feeCents = 150 WHERE orderId = ${q(o.o1)} AND kind = 'payment'`,
    `INSERT INTO shipping_labels (orderId, shippoTransactionId, carrier, service, amountCents, purchasedAt) VALUES (${q(o.o1)}, ${t("e2e-a-" + TAG)}, 'USPS', 'Ground Advantage', 800, '2021-03-01T12:00:00Z')`,
    `INSERT INTO shipping_labels (orderId, shippoTransactionId, carrier, service, amountCents, purchasedAt, voidedAt) VALUES (${q(o.o1)}, ${t("e2e-b-" + TAG)}, 'USPS', 'Ground Advantage', 9999, '2021-03-01T12:00:00Z', '2021-03-01T13:00:00Z')`,
    `INSERT INTO digitizing_jobs (orderId, name, vendor, sentAt, costCents, createdAt) VALUES (${q(o.o1)}, 'Example Club left chest', 'Example Digitizing', '2021-03-01', 1200, '2021-03-01T12:00:00Z')`,
    `INSERT INTO digitizing_jobs (orderId, name, vendor, sentAt, costCents, createdAt, deletedAt) VALUES (${q(o.o1)}, 'Sent twice', 'Example Digitizing', '2021-03-01', 9999, '2021-03-01T12:00:00Z', '2021-03-01T13:00:00Z')`,
    // O5: a $50.00 digitizing bill.
    `INSERT INTO digitizing_jobs (orderId, name, vendor, sentAt, costCents, createdAt) VALUES (${q(o.o5)}, 'Example District crest', 'Example Digitizing', '2021-03-03', 5000, '2021-03-03T12:00:00Z')`,
    // O2's tee was made before stock was tracked: a $3.00 estimated blank cost on the line.
    `UPDATE order_items SET cogsSource = 'estimate', cogsCents = 300 WHERE id = ${D.o2TeeLine}`,
    // O3: the 4th hoodie cancelled; the $25 line is a gift card sold with the order. O4 is nothing but a gift card.
    `UPDATE order_items SET cancelDate = '2021-03-05T19:00:00Z' WHERE id = (SELECT MAX(id) FROM order_items WHERE orderId = ${q(o.o3)} AND productId = ${q(hood.productId)})`,
    `UPDATE order_items SET productId = '__giftcard__' WHERE orderId IN (${q(o.o3)}, ${q(o.o4)}) AND name = 'Gift card'`,
    // O5's walk-in has no customer record; the order keeps only an email to go by.
    `UPDATE orders SET customerId = NULL, contact = ${q(D.lane)} WHERE orderId = ${q(o.o5)}`,
    `UPDATE orders SET voidedAt = '2021-03-07T15:00:00Z' WHERE orderId = ${q(o.o9)}`,
    // G2 was sold on O4. The ledger on fixed business days: G1 issued Feb 27, spent Mar 5, $10 back Mar 20; G2 sold at
    // 00:30 Mar 1 (March); G3 issued at 23:30 Feb 28 (still February in Chicago), $5 off Mar 15, voided Apr 2.
    `UPDATE gift_cards SET sourceOrderId = ${q(o.o4)} WHERE id = ${g2.id}`,
    `UPDATE gift_card_ledger SET at = '2021-02-27T18:00:00Z' WHERE cardId = ${g1.id} AND kind = 'issue'`,
    `UPDATE gift_card_ledger SET at = '2021-03-05T18:00:00Z' WHERE cardId = ${g1.id} AND kind = 'redeem'`,
    `UPDATE gift_card_ledger SET at = '2021-03-20T18:00:00Z' WHERE cardId = ${g1.id} AND kind = 'refund'`,
    `UPDATE gift_card_ledger SET at = '2021-03-01T06:30:00Z' WHERE cardId = ${g2.id} AND kind = 'issue'`,
    `UPDATE gift_card_ledger SET at = '2021-03-01T05:30:00Z' WHERE cardId = ${g3.id} AND kind = 'issue'`,
    `UPDATE gift_card_ledger SET at = '2021-03-15T18:00:00Z' WHERE cardId = ${g3.id} AND kind = 'adjust'`,
    `UPDATE gift_card_ledger SET at = '2021-04-02T18:00:00Z' WHERE cardId = ${g3.id} AND kind = 'void'`,
  ].join("; "));

  // The sales each shop's lines come to (cents): O1 tee 4000 − 400, cap 1500 − 150; O2 tee 2000 − 500 refunded, setup 1000;
  // O3 3 hoodies 12000 (the cancelled one and the gift card left out); O5 1 hoodie 4000 (its refund isn't a line's).
  D.sales = {
    tee: { orders: 2, qty: 3, gross: 6000, disc: 400, ref: 500 }, cap: { orders: 1, qty: 1, gross: 1500, disc: 150, ref: 0 },
    setup: { orders: 1, qty: 1, gross: 1000, disc: 0, ref: 0 }, hood: { orders: 2, qty: 4, gross: 16000, disc: 0, ref: 0 },
    custA: { orders: 2, qty: 5, gross: 8500, disc: 550, ref: 500 }, custB: { orders: 1, qty: 3, gross: 12000, disc: 0, ref: 0 },
    lane: { orders: 1, qty: 1, gross: 4000, disc: 0, ref: 0 },
    s1: { orders: 2, qty: 5, gross: 8500, disc: 550, ref: 500 }, s2: { orders: 2, qty: 4, gross: 16000, disc: 0, ref: 0 },
  };
  // Profit (cents). O1: revenue 4950; transfers 2 × 125 (estimated: not made), DTF 200, supplies 2 × 50 + the default,
  // digitizing 1200, Venmo's fee 150, postage 800. O2: revenue 2000 − 500 + 1000; the made-before-tracking blank 300,
  // transfers 125 (estimated), supplies 50. O3: revenue 12000 − 1000 put back on the card + 800 shipping; screen print
  // 3 × 100, supplies 3 × 100. O5: revenue 4000 − 1000 refunded; screen print 100, supplies 100, digitizing 5000.
  const P = (revenue, costs, estimated) => { const cost = Object.values(costs).reduce((s, c) => s + c, 0); return { revenue, costs, cost, profit: revenue - cost, margin: pct(revenue - cost, revenue), estimated }; };
  D.p = {
    o1: P(4950, { transfersCents: 250, decorationCents: 200, suppliesCents: 100 + D.supplies, digitizingCents: 1200, cardFeesCents: 150, postageCents: 800 }, true),
    o2: P(2500, { blanksCents: 300, transfersCents: 125, suppliesCents: 50 }, true),
    o3: P(11800, { decorationCents: 300, suppliesCents: 300 }, false),
    o5: P(3000, { decorationCents: 100, suppliesCents: 100, digitizingCents: 5000 }, false),
  };
});

// ---- Server answers: business days, the sale-date basis, the gift card lines ----------------------------------------
test("The server counts sales on business days in Chicago, on the install's sale date, without gift cards", async ({ api }) => {
  const o = D.o;
  const rep = (by, orgId, extra = {}) => api("getSalesReport", { dateFrom: FROM, dateTo: TO, by, orgId, ...extra });
  const s1 = await rep("customer", D.s1.orgId);
  expect(s1).toMatchObject({ dateFrom: FROM, dateTo: TO, basis: "shipped", by: "customer", orgId: D.s1.orgId });
  expect(s1.totals).toEqual({ orders: 2, qty: 5, grossCents: 8500, discountCents: 550, refundCents: 500, netCents: 7450, shippingCents: 0, rushCents: 0, taxCents: 0 });
  expect(s1.rows).toEqual([{ key: "c:" + D.custA.id, label: D.custA.name, customerId: D.custA.id, orders: 2, qty: 5, grossCents: 8500, discountCents: 550, refundCents: 500, netCents: 7450, sharePct: 100 }]);
  const s2 = await rep("customer", D.s2.orgId);
  expect(s2.totals).toEqual({ orders: 2, qty: 4, grossCents: 16000, discountCents: 0, refundCents: 0, netCents: 16000, shippingCents: 800, rushCents: 0, taxCents: 0 });
  expect(s2.rows.map(r => [r.key, r.label, r.netCents, r.sharePct])).toEqual([["c:" + D.custB.id, D.custB.name, 12000, 75], ["e:" + D.lane, "No customer record: " + D.lane, 4000, 25]]);
  // By product: the custom line by its name; by decoration: the custom line has none.
  const prod = await rep("product", D.s1.orgId);
  expect(prod.rows.map(r => [r.label, r.orders, r.qty, r.netCents, r.sharePct])).toEqual([
    [D.s1.products[0].name, 2, 3, 5100, 68.5], [D.s1.products[1].name, 1, 1, 1350, 18.1], ["Setup fee " + TAG, 1, 1, 1000, 13.4]]);
  expect(prod.rows[0]).toMatchObject({ key: "p:" + D.s1.orgId + "\u0001" + D.s1.products[0].productId, orgId: D.s1.orgId, productId: D.s1.products[0].productId, shop: D.s1.name });
  expect(prod.rows[2].key).toBe("n:setup fee " + TAG.toLowerCase());
  const dec = await rep("decoration", D.s1.orgId);
  expect(dec.rows.map(r => [r.key, r.label, r.netCents])).toEqual([["d:embroidery", "Embroidery", 5100], ["d:dtf", "DTF transfer", 1350], ["d:none", "No decoration", 1000]]);
  const shops = await rep("shop");
  const mine = shops.rows.filter(r => r.orgId === D.s1.orgId || r.orgId === D.s2.orgId);
  expect(mine.map(r => [r.key, r.label, r.orders, r.qty, r.netCents])).toEqual([["s:" + D.s2.orgId, D.s2.name, 2, 4, 16000], ["s:" + D.s1.orgId, D.s1.name, 2, 5, 7450]]);
  // Profit: the same orders. Placed basis brings in the unshipped O8.
  const pr = await api("getProfitReport", { dateFrom: FROM, dateTo: TO, orgId: D.s1.orgId });
  expect(pr.rows.map(r => r.orderId)).toEqual([o.o1, o.o2]);
  expect(pr.rows[0]).toMatchObject({ saleDate: "2021-03-01", revenueCents: D.p.o1.revenue, costCents: D.p.o1.cost, profitCents: D.p.o1.profit, marginPct: D.p.o1.margin, estimated: true });
  expect(pr.rows[1]).toMatchObject({ saleDate: "2021-03-10", revenue: { goodsCents: 2500, shippingCents: 0, rushCents: 0 } });
  await api("updateAccountingSettings", { saleDate: "placed" });
  try {
    const placed = await rep("customer", D.s1.orgId);
    expect(placed.basis).toBe("placed");
    expect(placed.totals).toMatchObject({ orders: 3, qty: 6, netCents: 7450 + 1500 });
    expect((await api("getProfitReport", { dateFrom: FROM, dateTo: TO, orgId: D.s1.orgId, sort: "date" })).rows.map(r => r.orderId)).toEqual([o.o8, o.o2, o.o1]);
  } finally { await api("updateAccountingSettings", { saleDate: "shipped" }); }
  // On UTC the edges move: O6 (05:30 UTC on Mar 1) comes in, O2 (05:30 UTC on Mar 11) falls out.
  await api("updateLocaleSettings", { locale: { timeZone: "UTC", country: saved.locale.country } });
  try {
    const utc = await api("getProfitReport", { dateFrom: FROM, dateTo: TO, orgId: D.s1.orgId, sort: "date" });
    expect(utc.rows.map(r => r.orderId).sort()).toEqual([o.o1, o.o6].sort());
  } finally { await api("updateLocaleSettings", { locale: { timeZone: ZONE, country: saved.locale.country } }); }
});

// ---- Sales by… --------------------------------------------------------------------------------------------------------
test("Sales by…: dates, quick ranges, shop, each Group by with every column, the totals, and the sale-date note", async ({ page }) => {
  const S = D.sales;
  await openAdmin(page, "home");
  const first = answerOf(page, "getSalesReport");
  await navTo(page, "Reports", "Sales by…");
  await expect(page).toHaveURL(/#salesby$/);
  await expect(page).toHaveTitle(/Sales by…/);
  const root = salesRoot(page);
  // Default: this month to date, by customer, all shops.
  const today = await page.evaluate(() => localToday_());
  const y = Number(today.slice(0, 4));
  const firstBody = bodyOf((await first).request());
  expect(firstBody).toMatchObject({ action: "getSalesReport", dateFrom: today.slice(0, 8) + "01", dateTo: today, by: "customer" });
  expect(firstBody.orgId).toBeUndefined();
  await expect(root.getByLabel("From")).toHaveValue(today.slice(0, 8) + "01");
  await expect(root.getByLabel("To")).toHaveValue(today);
  await expect(root.getByRole("button", { name: "Customer", exact: true })).toHaveAttribute("aria-pressed", "true");
  const presets = root.getByRole("group", { name: "Quick ranges" }).getByRole("button");
  await expect(presets).toHaveText(["This month", `Q1 ${y}`, `Q2 ${y}`, `Q3 ${y}`, `Q4 ${y}`, String(y), String(y - 1)]);
  await expect(presets.first()).toHaveClass(/\bon\b/);
  let ans = answerOf(page, "getSalesReport", b => b.dateFrom === `${y - 1}-01-01`);
  await presets.last().click();
  expect(bodyOf((await ans).request())).toMatchObject({ dateFrom: `${y - 1}-01-01`, dateTo: `${y - 1}-12-31` });
  await expect(root.getByLabel("From")).toHaveValue(`${y - 1}-01-01`);
  await expect(presets.last()).toHaveClass(/\bon\b/);
  await expect(presets.first()).not.toHaveClass(/\bon\b/);
  ans = answerOf(page, "getSalesReport", b => b.dateFrom === `${y}-04-01`);
  await root.getByRole("button", { name: `Q2 ${y}` }).click();
  expect(bodyOf((await ans).request())).toMatchObject({ dateFrom: `${y}-04-01`, dateTo: `${y}-06-30` });
  // A date box emptied: the page's own message, nothing asked.
  await root.getByLabel("From").fill("");
  await expect(root.locator(".sr-body [role=alert]")).toHaveText("Choose both dates.");
  await expect(root.getByRole("button", { name: "Export CSV" })).toBeDisabled();
  // More than three years: the server's refusal, shown on the page.
  ans = answerOf(page, "getSalesReport", b => b.dateFrom === "2021-03-01");
  await root.getByLabel("From").fill("2021-03-01");
  expect((await ans).status()).toBe(400);
  await expect(root.locator(".sr-body [role=alert]")).toHaveText("Pick at most three years.");
  await setRange(page, root, "getSalesReport", FROM, TO);
  await pickShop(page, root, "getSalesReport", D.s1.orgId);

  // By customer: one record, every column, the link to the customer.
  await expect(root.locator(".sr-basis")).toHaveText("3/1/2021 – 3/10/2021 · orders counted when they ship or are delivered, each day on the business's own calendar.");
  await expect(root.locator("#srSalesTable thead th")).toHaveText(["Customer", "Orders", "Qty", "Gross", "Discount", "Refunds", "Net sales", "Share"]);
  await expect(salesRows(page)).toHaveCount(1);
  expect(await cellsOf(salesRows(page).first())).toEqual(salesCells(D.custA.name, S.custA, 100));
  await expect(salesRows(page).first().locator(".sr-share-bar")).toHaveAttribute("style", "width:100%");
  await expect(salesRows(page).first().getByRole("link", { name: D.custA.name })).toHaveAttribute("href", "#customers/" + D.custA.id);
  expect(await cellsOf(root.locator("#srSalesTable tfoot tr"))).toEqual(["Total", "2", "5", $(8500), "−" + $(550), "−" + $(500), $(7450), ""]);
  await expect(root.locator(".sr-below > div")).toHaveText(["Shipping charged$0.00", "Rush fees$0.00", "Sales tax$0.00"]);
  await expect(root).toContainText("Orders in the total counts each order once, even when its items fall under several rows.");
  await expect(root).toContainText("gift cards sold are left out");

  // By product: the custom line under its own name; shares that add up.
  await groupBy(page, "Product", "product");
  await expect(root.locator("#srSalesTable thead th").first()).toHaveText("Product");
  await expect(salesRows(page)).toHaveCount(3);
  expect(await cellsOf(salesRows(page).nth(0))).toEqual(salesCells(D.s1.products[0].name, S.tee, 68.5));
  expect(await cellsOf(salesRows(page).nth(1))).toEqual(salesCells(D.s1.products[1].name, S.cap, 18.1));
  expect(await cellsOf(salesRows(page).nth(2))).toEqual(salesCells("Setup fee " + TAG, S.setup, 13.4));
  await expect(salesRows(page).nth(1).locator(".sr-share-bar")).toHaveAttribute("style", "width:18.1%");
  await expect(salesRows(page).first().getByRole("link")).toHaveCount(0);

  // By decoration: the custom line has none; the note about two kinds.
  await groupBy(page, "Decoration", "decoration");
  expect(await Promise.all([0, 1, 2].map(i => cellsOf(salesRows(page).nth(i))))).toEqual([
    salesCells("Embroidery", S.tee, 68.5), salesCells("DTF transfer", S.cap, 18.1), salesCells("No decoration", S.setup, 13.4)]);
  await expect(root).toContainText("An item with two kinds of decoration counts its pieces under each, and its money is split evenly between them.");

  // By shop, every shop: both of this spec's shops (other shops may have no sales in March 2021, but aren't assumed).
  await groupBy(page, "Shop", "shop");
  await pickShop(page, root, "getSalesReport", "");
  expect((await cellsOf(salesRow(page, D.s2.name))).slice(0, 7)).toEqual(salesCells(D.s2.name, S.s2));
  expect((await cellsOf(salesRow(page, D.s1.name))).slice(0, 7)).toEqual(salesCells(D.s1.name, S.s1));
  await expect(root).not.toContainText("An item with two kinds of decoration");

  // The district by customer: a name with markup shown as written, the walk-in with no record, $8 of shipping below.
  await pickShop(page, root, "getSalesReport", D.s2.orgId);
  await groupBy(page, "Customer", "customer");
  await expect(salesRows(page)).toHaveCount(2);
  expect(await cellsOf(salesRows(page).nth(0))).toEqual(salesCells(D.custB.name, S.custB, 75));
  expect(await cellsOf(salesRows(page).nth(1))).toEqual(salesCells("No customer record: " + D.lane, S.lane, 25));
  await expect(salesRows(page).nth(0).locator("i")).toHaveCount(0);
  await expect(salesRows(page).nth(1).getByRole("link")).toHaveCount(0);
  await expect(root.locator(".sr-below > div").first()).toHaveText("Shipping charged$8.00");

  // Export CSV: the rows shown and the total.
  const dl = page.waitForEvent("download");
  await root.getByRole("button", { name: "Export CSV" }).click();
  expect((await dl).suggestedFilename()).toBe(`sales-by-customer-${FROM}-to-${TO}-${D.s2.orgId}.csv`);
  expect(await readCsv(dl)).toEqual([
    "Customer,Orders,Qty,Gross,Discount,Refunds,Net sales,Share %",
    `${D.custB.name},1,3,120,0,0,120,75`,
    `No customer record: ${D.lane},1,1,40,0,0,40,25`,
    "Total,2,4,160,0,0,160,",
  ]);
});

test("Sales by…: placed basis, the empty state, a load error, and an older answer arriving last", async ({ page, api }) => {
  await openAdmin(page, "salesby");
  const root = salesRoot(page);
  await setRange(page, root, "getSalesReport", FROM, TO);
  await pickShop(page, root, "getSalesReport", D.s1.orgId);
  // Sales counted on the day placed: the unshipped cap order comes in, and the note says so.
  await api("updateAccountingSettings", { saleDate: "placed" });
  try {
    const ans = answerOf(page, "getSalesReport");
    await root.getByRole("button", { name: "Show" }).click();
    await ans;
    await expect(root.locator(".sr-basis")).toHaveText("3/1/2021 – 3/10/2021 · orders counted on the date they were placed, each day on the business's own calendar.");
    expect(await cellsOf(salesRows(page).first())).toEqual(salesCells(D.custA.name, { orders: 3, qty: 6, gross: 10000, disc: 550, ref: 500 }, 100));
  } finally { await api("updateAccountingSettings", { saleDate: "shipped" }); }

  // No sales: the empty line, Export CSV off.
  await setRange(page, root, "getSalesReport", "2021-01-04", "2021-01-05");
  await expect(root.locator(".sr-body")).toHaveText("No sales in these dates.");
  await expect(root.getByRole("button", { name: "Export CSV" })).toBeDisabled();

  // A failed load: the server's message, the basis line cleared.
  await page.route("**/api/orders", (route) => actionOf(route.request()) === "getSalesReport"
    ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ status: "error", message: "The report is resting." }) }) : route.fallback());
  await root.getByRole("button", { name: "Show" }).click();
  await expect(root.locator(".sr-body [role=alert]")).toHaveText("The report is resting.");
  await expect(root.locator(".sr-basis")).toHaveText("");
  await page.unroute("**/api/orders");

  // Two asks in a row: the first (slow) answer comes back last and is dropped; the page shows the newest.
  let release;
  const held = new Promise(r => { release = r; });
  let slowOne = true;
  await page.route("**/api/orders", async (route) => {
    if (actionOf(route.request()) !== "getSalesReport" || !slowOne) return route.fallback();
    slowOne = false;
    const res = await route.fetch();
    await held;
    return route.fulfill({ response: res });
  });
  const slow = answerOf(page, "getSalesReport", b => b.dateFrom === "2021-01-04");
  await root.getByRole("button", { name: "Show" }).click();   // Jan 4–5: no sales, held back
  const fast = answerOf(page, "getSalesReport", b => b.dateFrom === FROM && b.dateTo === TO);
  await root.getByLabel("To").fill(TO);
  await root.getByLabel("From").fill(FROM);
  await fast;
  await expect(salesRows(page)).toHaveCount(1);
  release();
  await slow;
  await page.waitForTimeout(300);
  await expect(salesRows(page)).toHaveCount(1);
  expect(await cellsOf(salesRows(page).first())).toEqual(salesCells(D.custA.name, D.sales.custA, 100));
  await page.unroute("**/api/orders");
});

// ---- Profit per job ---------------------------------------------------------------------------------------------------
test("Profit per job: lowest margin first, the totals, est. marks, a job's cost parts, the sorts and Export CSV", async ({ page }) => {
  const o = D.o, P = D.p;
  await openAdmin(page, "home");
  await navTo(page, "Reports", "Profit per job");
  await expect(page).toHaveURL(/#profit$/);
  await expect(page).toHaveTitle(/Profit per job/);
  const root = profitRoot(page);
  await expect(root.getByLabel("Sort")).toHaveValue("margin");
  await expect(root.getByLabel("Sort").locator("option")).toHaveText(["Lowest margin first", "Highest profit", "Most revenue", "Newest"]);
  await expect(root).toContainText("Labor isn't counted yet.");
  await setRange(page, root, "getProfitReport", FROM, TO);
  await pickShop(page, root, "getProfitReport", D.s1.orgId);

  // The shop's totals: two orders, both with an estimate.
  const tot = (P.o1.revenue + P.o2.revenue), cost = P.o1.cost + P.o2.cost;
  await expect(root.locator(".sr-totals .gc-total")).toHaveText([
    $(tot) + "Revenue2 orders", $(cost) + "Costs", $(tot - cost) + "Profit", pctText(pct(tot - cost, tot)) + "Margin2 orders use estimates"], { useInnerText: false });
  await expect(root.locator(".sr-basis")).toContainText("orders counted when they ship or are delivered");
  await expect(root.locator("#srProfitTable thead th")).toHaveText(["", "Order", "Customer", "Date", "Revenue", "Costs", "Profit", "Margin"]);
  expect(await cellsOf(profitRows(page).nth(0))).toEqual(["▸", o.o1 + " " + D.s1.name, D.custA.name, "3/1/2021", $(P.o1.revenue), $(P.o1.cost) + " est.", $(P.o1.profit), pctText(P.o1.margin)]);
  expect(await cellsOf(profitRows(page).nth(1))).toEqual(["▸", o.o2 + " " + D.s1.name, D.custA.name, "3/10/2021", $(P.o2.revenue), $(P.o2.cost) + " est.", $(P.o2.profit), pctText(P.o2.margin)]);

  // Every shop: the district's two orders too, lowest margin first; the under-water job is marked.
  await pickShop(page, root, "getProfitReport", "");
  const order = () => profitRows(page).locator(".mono").allInnerTexts().then(ids => ids.filter(id => Object.values(o).includes(id)));
  expect(await order()).toEqual([o.o5, o.o1, o.o2, o.o3]);
  const neg = profitRow(page, o.o5);
  await expect(neg).toHaveClass(/sr-neg/);
  expect(await cellsOf(neg)).toEqual(["▸", o.o5 + " " + D.s2.name, "Lane Walkin " + TAG, "3/3/2021", $(P.o5.revenue), $(P.o5.cost), $(P.o5.profit), pctText(P.o5.margin)]);
  await expect(neg.locator("td.sr-negn")).toHaveCount(2);
  expect(await cellsOf(profitRow(page, o.o3))).toEqual(["▸", o.o3 + " " + D.s2.name, D.custB.name, "3/5/2021", $(P.o3.revenue), $(P.o3.cost), $(P.o3.profit), pctText(P.o3.margin)]);
  await expect(profitRow(page, o.o3)).not.toHaveClass(/sr-neg/);

  // A job's cost parts: each non-zero part, and Labor "not counted yet". Open twice closes.
  const toggle = profitRow(page, o.o1).getByRole("button", { name: "▸" });
  await toggle.click();
  const parts = profitRoot(page).locator("tr.sr-parts-row .sr-parts > div");
  await expect(parts).toHaveText(["Transfers" + $(250), "Decoration" + $(200), "Supplies" + $(100 + D.supplies), "Outside digitizing" + $(1200), "Card fees" + $(150), "Postage" + $(800), "Labornot counted yet"]);
  await expect(profitRow(page, o.o1).getByRole("button", { name: "▾" })).toHaveAttribute("aria-expanded", "true");
  await profitRow(page, o.o2).getByRole("button", { name: "▸" }).click();
  await expect(profitRoot(page).locator("tr.sr-parts-row")).toHaveCount(2);
  await expect(profitRoot(page).locator("tr.sr-parts-row").nth(1).locator(".sr-parts > div")).toHaveText(["Blanks" + $(300), "Transfers" + $(125), "Supplies" + $(50), "Labornot counted yet"]);
  await profitRow(page, o.o1).getByRole("button", { name: "▾" }).click();
  await expect(profitRoot(page).locator("tr.sr-parts-row")).toHaveCount(1);
  await profitRow(page, o.o2).getByRole("button", { name: "▾" }).click();
  await expect(profitRoot(page).locator("tr.sr-parts-row")).toHaveCount(0);

  // The other sorts.
  const sortBy = async (value, want) => {
    const ans = answerOf(page, "getProfitReport", b => b.sort === value);
    await root.getByLabel("Sort").selectOption(value);
    await ans;
    await expect(root.locator(".sr-body")).not.toContainText("Loading…");
    expect(await order()).toEqual(want);
  };
  const byProfit = [o.o3, ...(P.o1.profit >= P.o2.profit ? [o.o1, o.o2] : [o.o2, o.o1]), o.o5];
  await sortBy("profit", byProfit);
  await sortBy("revenue", [o.o3, o.o1, o.o5, o.o2]);
  await sortBy("date", [o.o2, o.o3, o.o5, o.o1]);
  await sortBy("margin", [o.o5, o.o1, o.o2, o.o3]);

  // Export CSV (the district): the parts as columns.
  await pickShop(page, root, "getProfitReport", D.s2.orgId);
  await expect(root.locator(".sr-totals .gc-total").nth(3)).toHaveText(pctText(pct(P.o5.profit + P.o3.profit, P.o5.revenue + P.o3.revenue)) + "Margin", { useInnerText: false });
  const dl = page.waitForEvent("download");
  await root.getByRole("button", { name: "Export CSV" }).click();
  expect((await dl).suggestedFilename()).toBe(`profit-per-job-${FROM}-to-${TO}-${D.s2.orgId}.csv`);
  expect(await readCsv(dl)).toEqual([
    "Order #,Shop,Customer,Sale date,Revenue,Costs,Profit,Margin %,Estimated,Blanks,Transfers,Decoration,Supplies,Outside digitizing,Card fees,Postage,Labor",
    `${o.o5},${D.s2.name},Lane Walkin ${TAG},2021-03-03,30,52,-22,-73.3,,0,0,1,1,50,0,0,0`,
    `${o.o3},${D.s2.name},${D.custB.name},2021-03-05,118,6,112,94.9,,0,0,3,3,0,0,0,0`,
  ]);

  // No orders: the empty line, no totals.
  await setRange(page, root, "getProfitReport", "2021-01-04", "2021-01-05");
  await expect(root.locator(".sr-body")).toHaveText("No orders in these dates.");
  await expect(root.locator(".sr-totals")).toBeEmpty();
  await expect(root.getByRole("button", { name: "Export CSV" })).toBeDisabled();
  // A From after the To: the page's own message, the totals cleared.
  await root.getByLabel("From").fill("2021-02-01");
  await root.getByLabel("To").fill("2021-01-01");
  await expect(root.locator(".sr-body [role=alert]")).toHaveText("The From date is after the To date.");
  await expect(root.locator(".sr-totals")).toBeEmpty();
});

test("Profit per job opens the order; its 💰 Payments window shows the Profit box, and a quiet line when it can't", async ({ page }) => {
  const o = D.o, P = D.p.o1;
  await openAdmin(page, "profit");
  const root = profitRoot(page);
  await setRange(page, root, "getProfitReport", FROM, TO);
  await pickShop(page, root, "getProfitReport", D.s1.orgId);
  await profitRow(page, o.o1).getByRole("button", { name: o.o1 }).click();
  const row = page.locator(`tr[data-order="${o.o1}"]`).first();
  await expect(row).toBeVisible();
  const asked = answerOf(page, "getOrderProfit", b => b.orderId === o.o1);
  await row.locator("td[data-action-td]").getByRole("button", { name: "💰 Payments" }).click();
  const pm = page.locator("#pmContent");
  await expect(pm).toContainText("Amount due");
  expect((await asked).status()).toBe(200);
  const box = pm.locator("#pmProfit");
  await expect(box.locator(".pm-profit-h")).toHaveText("Profit");
  const want = [["Revenue", $(P.revenue)], ["Transfers", "−" + $(250)], ["Decoration", "−" + $(200)], ["Supplies", "−" + $(100 + D.supplies)],
    ["Outside digitizing", "−" + $(1200)], ["Card fees", "−" + $(150)], ["Postage", "−" + $(800)], ["Profit", $(P.profit)], ["Margin", pctText(P.margin)]];
  await expect(box.locator("tr")).toHaveText(want.map(([a, b]) => a + b));
  await expect(box.locator(".pm-profit-note")).toHaveText("est. Part of the cost is an estimate: Transfer cost estimated for lines not yet made; Some lines have no blank cost to go on; "
    + "Decoration cost uses today's settings. Revenue leaves out sales tax and gift cards sold. Labor isn't counted yet.");
  await expect(box.locator("tr.pm-profit-neg")).toHaveCount(0);

  // The under-water job: profit and margin marked; its notes without an estimate.
  const box5 = (await paymentsOf(page, D.s2.orgId, o.o5, "2021-03-03")).locator("#pmProfit");
  await expect(box5.locator("tr.pm-profit-sum")).toHaveText("Profit" + $(D.p.o5.profit));
  await expect(box5.locator("tr.pm-profit-sum")).toHaveClass(/pm-profit-neg/);
  await expect(box5.locator("td.pm-profit-neg")).toHaveText(pctText(D.p.o5.margin));
  await expect(box5.locator(".pm-profit-note")).toHaveText("Refunds not tied to a line are taken off the goods; Decoration cost uses today's settings. Revenue leaves out sales tax and gift cards sold. Labor isn't counted yet.");

  // The server can't answer: a quiet line, the money table still there.
  await page.route("**/api/orders", (route) => actionOf(route.request()) === "getOrderProfit"
    ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ status: "error", message: "No." }) }) : route.fallback());
  await paymentsOf(page, D.s2.orgId, o.o5, "2021-03-03");
  await expect(page.locator("#pmContent #pmProfit")).toHaveText("ProfitProfit isn't available right now.", { useInnerText: false });
  await page.unroute("**/api/orders");
});

// ---- Gift card liability -----------------------------------------------------------------------------------------------
test("Gift card liability: business months, sold vs given, spent, put back, adjusted, voided, the totals and what's on cards now", async ({ page, api }) => {
  await openAdmin(page, "home");
  await navTo(page, "Reports", "Gift card liability");
  await expect(page).toHaveURL(/#giftliability$/);
  await expect(page).toHaveTitle(/Gift card liability/);
  const root = liabRoot(page);
  const today = await page.evaluate(() => localToday_());
  const y = Number(today.slice(0, 4));
  await expect(root.getByLabel("From")).toHaveValue(`${y}-01-01`);
  await expect(root.getByLabel("To")).toHaveValue(today);
  await expect(root.getByLabel("Shop")).toHaveCount(0);
  await expect(root.getByRole("group", { name: "Quick ranges" }).getByRole("button")).toHaveText(["This year", String(y - 1), "This month"]);
  await setRange(page, root, "getGiftCardLiability", "2021-02-01", "2021-05-31");
  const nowOnCards = D.outstandingBefore + 1000 + 5000;   // G1's $10 put back, G2's $50; G3 is void
  expect((await api("getGiftCardLiability", { dateFrom: "2021-02-01", dateTo: "2021-05-31" })).outstandingNowCents).toBe(nowOnCards);
  await expect(root.locator(".sr-totals .gc-total")).toHaveText([$(nowOnCards) + "On cards right nowEvery active card's balance today",
    $(6000) + "Owed on 5/31/2021The closing balance of the last month"], { useInnerText: false });
  await expect(root.locator("#srLiabTable thead th")).toHaveText(["Month", "Opening", "Sold", "Given", "Spent", "Put back", "Adjusted", "Voided", "Closing"]);
  await expect(root.locator("#srLiabTable thead th", { hasText: "Given" })).toHaveAttribute("title", "Cards issued by staff without a sale");
  const rows = root.locator("#srLiabTable tbody tr");
  // February: G1 $50 and G3 $30 (issued at 23:30 on Feb 28 in Chicago) given. March: G2 sold, G1 spent, $10 back, $5 off.
  // April: G3's $25 voided. May: nothing, still shown.
  await expect(rows).toHaveCount(4);
  expect(await cellsOf(rows.nth(0))).toEqual(["February 2021", "$0.00", "—", $(8000), "—", "—", "—", "—", $(8000)]);
  expect(await cellsOf(rows.nth(1))).toEqual(["March 2021", $(8000), $(5000), "—", "−" + $(5000), $(1000), "−" + $(500), "—", $(8500)]);
  expect(await cellsOf(rows.nth(2))).toEqual(["April 2021", $(8500), "—", "—", "—", "—", "—", "−" + $(2500), $(6000)]);
  expect(await cellsOf(rows.nth(3))).toEqual(["May 2021", $(6000), "—", "—", "—", "—", "—", "—", $(6000)]);
  expect(await cellsOf(root.locator("#srLiabTable tfoot tr"))).toEqual(["Total", "$0.00", $(5000), $(8000), "−" + $(5000), $(1000), "−" + $(500), "−" + $(2500), $(6000)]);
  await expect(root).toContainText("Months are the business's own calendar months.");

  const dl = page.waitForEvent("download");
  await root.getByRole("button", { name: "Export CSV" }).click();
  expect((await dl).suggestedFilename()).toBe("gift-card-liability-2021-02-01-to-2021-05-31.csv");
  expect(await readCsv(dl)).toEqual([
    "Month,Opening,Sold,Given,Spent,Put back,Adjusted,Voided,Closing",
    "2021-02,0,0,80,0,0,0,0,80", "2021-03,80,50,0,50,10,-5,0,85", "2021-04,85,0,0,0,0,0,25,60", "2021-05,60,0,0,0,0,0,0,60",
    "Total,0,50,80,50,10,-5,25,60",
  ]);
  // One month: March opens with February's $80.
  await setRange(page, root, "getGiftCardLiability", "2021-03-01", "2021-03-31");
  await expect(rows).toHaveCount(1);
  expect(await cellsOf(root.locator("#srLiabTable tfoot tr"))).toEqual(["Total", $(8000), $(5000), "—", "−" + $(5000), $(1000), "−" + $(500), "—", $(8500)]);
  // A failed load: the message, no totals.
  await page.route("**/api/orders", (route) => actionOf(route.request()) === "getGiftCardLiability"
    ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ status: "error", message: "Ledger unavailable." }) }) : route.fallback());
  await root.getByRole("button", { name: "Show" }).click();
  await expect(root.locator(".sr-body [role=alert]")).toHaveText("Ledger unavailable.");
  await expect(root.locator(".sr-totals")).toBeEmpty();
  await page.unroute("**/api/orders");
});

// ---- Roles --------------------------------------------------------------------------------------------------------------
test("Roles: Manager uses all three; Back office and Production are refused Sales by… and Profit; no Profit box without costs", async ({ as }) => {
  const o = D.o;
  const range = { dateFrom: FROM, dateTo: TO };
  // Manager.
  await asApi("manager", async (call) => {
    expect((await call("getSalesReport", { ...range, orgId: D.s1.orgId })).status).toBe(200);
    expect((await call("getProfitReport", { ...range, orgId: D.s1.orgId })).data.rows.map(r => r.orderId)).toEqual([o.o1, o.o2]);
    expect((await call("getOrderProfit", { orderId: o.o1 })).data.profit).toMatchObject({ orderId: o.o1, profitCents: D.p.o1.profit, estimated: true });
    expect((await call("getGiftCardLiability", range)).status).toBe(200);
  });
  const mp = await as("manager");
  await openAdmin(mp, "profit");
  await expect(mp.locator("#srProfitPage")).toBeVisible();
  await openAdmin(mp, "salesby");
  await expect(mp.locator("#srSalesPage")).toBeVisible();

  // Back office: no Sales by… or Profit per job anywhere; Gift card liability read.
  await asApi("staff", async (call) => {
    for (const [a, b] of [["getSalesReport", range], ["getProfitReport", range], ["getOrderProfit", { orderId: o.o1 }]]) {
      const r = await call(a, b);
      expect(r.status, a).toBe(403);
      expect(r.data.status).toBe("error");
      expect(JSON.stringify(r.data)).not.toContain("profitCents");
    }
    expect((await call("getGiftCardLiability", range)).status).toBe(200);
  });
  const sp = await as("staff");
  await openAdmin(sp, "home");
  const nav = sp.getByRole("navigation", { name: "Admin" });
  await nav.getByRole("button", { name: "Reports ▾" }).click();
  await expect(nav.getByRole("button", { name: "Sales by…", exact: true })).toHaveCount(0);
  await expect(nav.getByRole("button", { name: "Profit per job", exact: true })).toHaveCount(0);
  await expect(nav.getByRole("button", { name: "Gift card liability", exact: true })).toBeVisible();
  for (const h of ["salesby", "profit"]) {
    await openAdmin(sp, h);
    await expect(sp.locator("#roleOffPanel")).toContainText("Not available to you. Your role (Back office) doesn't include this page.");
    await expect(sp).toHaveTitle(/Not available/);
  }
  await openAdmin(sp, "giftliability");
  await expect(sp.locator("#srLiabPage")).toBeVisible();
  // The order window: no Profit box, and nothing asked for it.
  let asked = 0;
  sp.on("request", (r) => { if (r.url().endsWith("/api/orders") && actionOf(r) === "getOrderProfit") asked++; });
  await paymentsOf(sp, D.s2.orgId, o.o3, "2021-03-05");
  await expect(sp.locator("#pmProfit")).toHaveCount(0);
  expect(asked).toBe(0);

  // Production: none of it.
  await asApi("production", async (call) => {
    for (const [a, b] of [["getSalesReport", range], ["getProfitReport", range], ["getOrderProfit", { orderId: o.o1 }], ["getGiftCardLiability", range]]) {
      expect((await call(a, b)).status, a).toBe(403);
    }
  });
  const pp = await as("production");
  for (const h of ["salesby", "profit", "giftliability"]) {
    await openAdmin(pp, h);
    await expect(pp.locator("#roleOffPanel")).toContainText("Not available to you. Your role (Production) doesn't include this page.");
  }
});

test("A role with Profit per job but without costs.view is refused \"You can't see costs.\" and sees no Profit", async ({ api, as }) => {
  const role = await viewerRole(api);
  saved.viewerRole = JSON.parse(JSON.stringify(role));
  const fns = { ...role.permissions.fns, "costs.view": "none" };
  await api("saveRole", { roleKey: role.key, name: role.name, rank: role.rank, permissions: { ...role.permissions, fns } }, { path: "/api/admin-users" });
  try {
    await asApi("viewer", async (call) => {
      const r = await call("getProfitReport", { dateFrom: FROM, dateTo: TO });
      expect(r.status).toBe(403);
      expect(r.data).toMatchObject({ status: "error", code: "forbidden", message: "You can't see costs." });
      expect((await call("getOrderProfit", { orderId: D.o.o1 })).status).toBe(403);
      expect((await call("getSalesReport", { dateFrom: FROM, dateTo: TO, orgId: D.s1.orgId })).data.totals.netCents).toBe(7450);
    });
    const vp = await as("viewer");
    await openAdmin(vp, "home");
    const nav = vp.getByRole("navigation", { name: "Admin" });
    await nav.getByRole("button", { name: "Reports ▾" }).click();
    await expect(nav.getByRole("button", { name: "Sales by…", exact: true })).toBeVisible();
    await expect(nav.getByRole("button", { name: "Profit per job", exact: true })).toHaveCount(0);
    await openAdmin(vp, "profit");
    await expect(vp.locator("#roleOffPanel")).toContainText("Not available to you. Your role (Read only) doesn't include this page.");
    await paymentsOf(vp, D.s1.orgId, D.o.o1, "2021-03-01");
    await expect(vp.locator("#pmProfit")).toHaveCount(0);
  } finally { await restoreViewer(); }
});

// ---- The server's checks ------------------------------------------------------------------------------------------------
test("The server refuses bad dates, groups, sorts, shops and orders", async ({ api }) => {
  const bad = (action, body) => api(action, body, { allowError: true, withStatus: true });
  for (const action of ["getSalesReport", "getProfitReport", "getGiftCardLiability"]) {
    expect(await bad(action, { dateFrom: "2021-3-1", dateTo: TO })).toEqual({ status: 400, data: { status: "error", message: "Invalid date range — expected YYYY-MM-DD" } });
    expect(await bad(action, { dateFrom: TO, dateTo: FROM })).toEqual({ status: 400, data: { status: "error", message: "The start date is after the end date." } });
    expect(await bad(action, { dateFrom: "2021-03-01", dateTo: "2024-03-01" })).toEqual({ status: 400, data: { status: "error", message: "Pick at most three years." } });
    expect((await bad(action, { dateFrom: "2021-03-01", dateTo: "2024-02-29" })).status).toBe(200);
  }
  expect(await bad("getSalesReport", { ...{ dateFrom: FROM, dateTo: TO }, by: "colour" })).toEqual({ status: 400, data: { status: "error", message: "Group by customer, product, shop or decoration." } });
  expect((await bad("getSalesReport", { dateFrom: FROM, dateTo: TO, by: "" })).data.by).toBe("customer");
  expect(await bad("getProfitReport", { dateFrom: FROM, dateTo: TO, sort: "loss" })).toEqual({ status: 400, data: { status: "error", message: "Sort by margin, profit, revenue or date." } });
  expect((await bad("getProfitReport", { dateFrom: FROM, dateTo: TO, sort: "" })).data.sort).toBe("margin");
  for (const action of ["getSalesReport", "getProfitReport"]) {
    expect(await bad(action, { dateFrom: FROM, dateTo: TO, orgId: "no-such-shop-" + TAG })).toEqual({ status: 404, data: { status: "error", message: "Unknown shop" } });
    // `org` works as the shop too.
    expect((await bad(action, { dateFrom: FROM, dateTo: TO, org: D.s2.orgId })).data.orgId).toBe(D.s2.orgId);
  }
  expect(await bad("getOrderProfit", { orderId: "not an id!" })).toEqual({ status: 400, data: { status: "error", message: "Invalid order ID" } });
  expect(await bad("getOrderProfit", { orderId: "NOPE-" + TAG.toUpperCase() })).toEqual({ status: 404, data: { status: "error", message: "Order not found" } });
  expect(await bad("getOrderProfit", { orderId: D.o.o1, org: D.s2.orgId })).toEqual({ status: 404, data: { status: "error", message: "Order not found" } });
  const p = (await api("getOrderProfit", { orderId: D.o.o3, org: D.s2.orgId })).profit;
  expect(p).toEqual({ orderId: D.o.o3, revenueCents: 11800, revenue: { goodsCents: 11000, shippingCents: 800, rushCents: 0 },
    costs: { blanksCents: 0, transfersCents: 0, decorationCents: 300, suppliesCents: 300, digitizingCents: 0, cardFeesCents: 0, postageCents: 0, laborCents: 0 },
    costCents: 600, profitCents: 11200, marginPct: 94.9, estimated: false, notes: ["Refunds not tied to a line are taken off the goods", "Decoration cost uses today's settings"] });
  // A gift-card-only order has no revenue: margin null.
  expect((await api("getOrderProfit", { orderId: D.o.o4 })).profit).toMatchObject({ revenueCents: 0, costCents: 0, marginPct: null });
});
