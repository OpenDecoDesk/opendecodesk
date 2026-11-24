// Closed months: the Inventory & COGS report's month-end stock snapshots, and the closed-month guards on an
// order's discount and its Shipped / Delivered / Completed dates.
//
// Closing a month is install-wide — a closed month refuses changes dated in it for every spec — so this file
// dates everything it makes in 2022 and early 2023, which no other spec uses, closes only those months, and
// reopens each one it closed in `finally` (and again after the last test, in case a test stopped part-way).
// Other specs add stock and orders at the same time, but dated now: nothing here reads a total that includes
// them. Each check is on this file's own transfer and orders, or compares two reads of the same past moment.
import { test, expect, uniq, apiContext, callApi } from "../fixtures.mjs";
import { makeShop } from "../lib/data.mjs";
import { freshAdmin } from "../lib/money.mjs";

test.describe.configure({ mode: "serial" });

// Every month this file may close. Nothing here closes any other month.
const SNAPSHOT_MONTH = "2022-06";      // the Inventory & COGS tests' closed month: reports from August on start at its end
const WAIVE_MONTH = "2022-09";         // the waived-discount order is placed in it
const SHIP_MONTHS = ["2022-11", "2022-12", "2023-02"];   // the dates tests' closed months
const MY_MONTHS = [SNAPSHOT_MONTH, WAIVE_MONTH, ...SHIP_MONTHS];

async function closeMonth(api, month) {
  expect(MY_MONTHS).toContain(month);
  await api("closePeriod", { month });
}
async function reopenMine(api, months = MY_MONTHS) {
  const { periods } = await api("listClosedPeriods");
  for (const p of periods) if (months.includes(p.month)) await api("reopenPeriod", { month: p.month });
}

// Each test reopens its months in `finally`. A test that fails makes the serial file skip the rest, so the last
// test's check may not run: this reopens them all once more, whatever happened.
test.afterAll(async () => {
  const ctx = await apiContext("owner");
  try { await reopenMine((action, body, opts) => callApi(ctx, action, body, opts)); }
  finally { await ctx.dispose(); }
});

// ---- The Inventory & COGS report on the page ---------------------------------------------------------------
// Runs the report for From–To on #cogs and returns what the page asked the server for (the getInventoryReport
// answer, read from the page's own request) and this file's transfer's row in the page's "Transfer sheets"
// ending table: { data, row: { qty, avg, value } }.
async function runReport(page, from, to, transferName) {
  await freshAdmin(page, "cogs");
  await page.locator("#cogsFrom").fill(from);
  await page.locator("#cogsTo").fill(to);
  const answer = page.waitForResponse((r) => r.url().endsWith("/api/orders") && r.request().method() === "POST"
    && /"action":"getInventoryReport"/.test(r.request().postData() || "") && (r.request().postData() || "").includes('"dateFrom":"' + from + '"'));
  await page.getByRole("button", { name: "Generate" }).click();
  const data = await (await answer).json();
  expect(data.status, JSON.stringify(data).slice(0, 300)).toBe("ok");
  const results = page.locator("#cogsResults");
  // The page dims the results it already shows (the opening load's) while a report loads, and undims them once it
  // has drawn the new one: only then are the rows this range's.
  await expect.poll(() => results.evaluate((el) => el.style.opacity)).toBe("");
  await expect(results.getByRole("heading", { name: "Transfer sheets" })).toBeVisible();
  let row = null;
  if (transferName) {
    const tr = results.getByRole("row", { name: new RegExp("^" + transferName) });
    await expect(tr).toHaveCount(1);
    const cells = (await tr.getByRole("cell").allTextContents()).map((s) => s.trim());
    row = { qty: Number(cells[1]), avg: cells[2], value: cells[3] };
  }
  return { data, row };
}
// This file's transfer in a valuation's rows ({ qty, avgCost, value } or null when none on hand).
const mine = (valuation, transferId) => {
  const r = valuation.rows.find((x) => Number(x.transferId) === Number(transferId));
  return r ? { qty: r.qty, avgCost: r.avgCost, value: r.value } : null;
};
// What the replay holds for this file's transfer, worked out here from the movements it made: a running weighted
// average in whole cents, rounded at each receipt, as the report keeps it.
function expected(moves) {
  let qty = 0, avg = 0;
  for (const m of [...moves].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))) {
    if (m.voided) continue;
    if (m.qty > 0) { avg = Math.round((Math.max(0, qty) * avg + m.qty * m.unitCents) / (Math.max(0, qty) + m.qty)); }
    qty += m.qty;
  }
  return { qty, avgCost: avg / 100, value: Math.max(0, qty) * avg / 100 };
}
const dollars = (n) => "$" + n.toFixed(2);

let transferId = 0, transferName = "";
const moves = [];   // this file's movements of its transfer: { date, qty, unitCents, id, voided }

// Receives one sheet of this file's transfer, dated `date`: `count` transfers, the whole sheet, `total` dollars.
async function receive(api, date, count, total) {
  const r = await api("receiveTransferSheet", { receivedAt: date, total, vendorRef: "E2E-" + date,
    rows: [{ transferId, count, pctOfSheet: 100 }] });
  const { movements } = await api("getTransferMovements", { transferId });
  const mv = movements.find((m) => m.kind === "purchase" && String(m.occurredAt).startsWith(date) && !moves.some((x) => x.id === m.id));
  expect(mv, "the receipt's movement").toBeTruthy();
  moves.push({ date, qty: count, unitCents: Math.round(total * 100 / count), id: mv.id });
  return r;
}

test("Inventory & COGS from a closed month's snapshot equals a full replay, and follows backdated changes", async ({ page, api }) => {
  // Reports from August 2022 start at the end of July. With June closed, they start from June's snapshot and
  // replay only July. A report from June 2022 can't use any snapshot (no month of this file is closed before
  // May's end): its ending (July 31) is a full replay of the same moment.
  const SEEDED = ["2022-08-01", "2022-08-31"], FULL = ["2022-06-01", "2022-07-31"];
  // Eleven reports, each a fresh page load: more than the default minute beside the whole suite.
  test.setTimeout(150_000);
  try {
    await reopenMine(api);
    transferName = uniq("Closed Month Crest Transfer");
    ({ id: transferId } = await api("saveTransfer", { transfer: { name: transferName } }));
    expect(transferId).toBeGreaterThan(0);
    // February: 10 at $2.00; April: 10 at $3.00 (an average of $2.50), and 4 written off: 16 at $2.50 = $40.00.
    await receive(api, "2022-02-10", 10, 20);
    await receive(api, "2022-04-12", 10, 30);
    await api("writeOffTransfers", { transferId, qty: 4, note: "Damaged in the press", occurredAt: "2022-04-20" });
    moves.push({ date: "2022-04-20", qty: -4, unitCents: 0 });
    let want = expected(moves);
    expect(want).toEqual({ qty: 16, avgCost: 2.5, value: 40 });

    // r0: no month closed yet. The page's own row and the server's beginning both say 16 at $2.50.
    const r0 = await runReport(page, ...SEEDED, transferName);
    expect(mine(r0.data.transfers.beginning, transferId)).toEqual(want);
    expect(r0.row).toEqual({ qty: 16, avg: "$2.50", value: "$40.00" });

    // Close June. r1 is the first report that can start at June's end, so it writes the snapshot; r2 reads it.
    // (Another spec's report may have written it first: either way both equal r0.)
    await closeMonth(api, SNAPSHOT_MONTH);
    const r1 = await runReport(page, ...SEEDED, transferName);
    const r2 = await runReport(page, ...SEEDED, transferName);
    for (const r of [r1, r2]) {
      expect(mine(r.data.transfers.beginning, transferId)).toEqual(want);
      expect(r.row).toEqual(r0.row);
    }
    // Every row of every kind (blanks, transfers, finished stock) at July 31, from the snapshot, equals the full
    // replay of the same moment. Other specs' stock is dated now, so it is in neither.
    const full = await runReport(page, ...FULL, transferName);
    expect(r2.data.transfers.beginning.rows).toEqual(full.data.transfers.ending.rows);
    expect(r2.data.beginning.rows).toEqual(full.data.ending.rows);
    expect(r2.data.finished.beginning.rows).toEqual(full.data.finished.ending.rows);
    expect(r2.data.transfers.beginning.value).toBe(full.data.transfers.ending.value);
    expect(r2.data.beginning.value).toBe(full.data.ending.value);

    // A receipt backdated into July — open, after the snapshot: June's snapshot still holds and the report adds it.
    // 16 at $2.50 + 4 at $3.50 = 20 at $2.70 = $54.00.
    await receive(api, "2022-07-15", 4, 14);
    want = expected(moves);
    expect(want).toEqual({ qty: 20, avgCost: 2.7, value: 54 });
    const r3 = await runReport(page, ...SEEDED, transferName);
    expect(mine(r3.data.transfers.beginning, transferId)).toEqual(want);
    expect(r3.row).toEqual({ qty: 20, avg: "$2.70", value: "$54.00" });

    // A receipt backdated into May — open, but BEFORE the snapshot: June's snapshot no longer holds. A report that
    // still started from it would say $54.00; the true July 31 is 30 at $2.63 = $78.90.
    await receive(api, "2022-05-15", 10, 25);
    want = expected(moves);
    expect(want).toEqual({ qty: 30, avgCost: 2.63, value: 78.9 });
    const r4 = await runReport(page, ...SEEDED, transferName);
    expect(mine(r4.data.transfers.beginning, transferId)).toEqual(want);
    expect(r4.row).toEqual({ qty: 30, avg: "$2.63", value: dollars(78.9) });
    const r4full = await runReport(page, ...FULL, transferName);
    expect(r4.data.transfers.beginning.rows).toEqual(r4full.data.transfers.ending.rows);

    // Voiding the May receipt (a movement before the snapshot month, changed again) takes it back out: 20 at $2.70.
    const may = moves.find((m) => m.date === "2022-05-15");
    await api("voidTransferMovement", { movementId: may.id, reason: "Entered by mistake" });
    may.voided = true;
    want = expected(moves);
    expect(want).toEqual({ qty: 20, avgCost: 2.7, value: 54 });
    const r5 = await runReport(page, ...SEEDED, transferName);
    expect(mine(r5.data.transfers.beginning, transferId)).toEqual(want);
    expect(r5.row).toEqual({ qty: 20, avg: "$2.70", value: "$54.00" });
    // Read once more (from whichever snapshot the last report wrote): still the same.
    const r6 = await runReport(page, ...SEEDED, transferName);
    expect(mine(r6.data.transfers.beginning, transferId)).toEqual(want);

    // Reopening June drops its snapshot; the report replays everything and says the same.
    await api("reopenPeriod", { month: SNAPSHOT_MONTH });
    const r7 = await runReport(page, ...SEEDED, transferName);
    expect(mine(r7.data.transfers.beginning, transferId)).toEqual(want);
    expect(r7.row).toEqual(r5.row);
    expect(r7.data.transfers.beginning.rows).toEqual(r6.data.transfers.beginning.rows);
  } finally {
    await reopenMine(api, [SNAPSHOT_MONTH]);
  }
});

// ---- The closed-month guards on an order ------------------------------------------------------------------
// An order of `shop`'s first product recorded as a local sale, dated `placedAt` (YYYY-MM-DD); paid in full that
// day when `paid`. Returns the order as getOrders lists it.
async function localSale(api, shop, placedAt, { paid = false } = {}) {
  const r = await api("createLocalSale", { org: shop.orgId, customerName: "Casey Customer", paymentMethod: "Cash", placedAt, paid,
    items: [{ productId: shop.products[0].productId, qty: 1 }] });
  expect(r.orderId).toBeTruthy();
  return orderOf(api, shop, r.orderId);
}
async function orderOf(api, shop, orderId) {
  const { orders } = await api("getOrders", { org: shop.orgId });
  const o = orders.find((x) => x.orderId === orderId);
  expect(o, "order " + orderId).toBeTruthy();
  return o;
}

test("a payment that waives the rest is refused on a closed month's order; a plain payment is taken", async ({ api }) => {
  const shop = await makeShop(api, { prefix: "waive", products: [{ name: "Waived Tee", price: 20 }] });
  try {
    await reopenMine(api, [WAIVE_MONTH]);
    // A $20 order placed in September 2022, nothing paid. Then September is closed (filed).
    const order = await localSale(api, shop, "2022-09-05");
    expect(order.placedAt.slice(0, 7)).toBe(WAIVE_MONTH);
    expect(order.effectiveTotal).toBe(20);
    await closeMonth(api, WAIVE_MONTH);

    // $5 now with the rest ($15) waived as a discount: the discount would change September's sales, so it is
    // refused — and nothing is recorded, not even the $5.
    const refused = await api("addPayment", { org: shop.orgId, orderId: order.orderId, amount: 5, method: "cash", discountRemainder: true },
      { allowError: true, withStatus: true });
    expect(refused.status).toBe(409);
    expect(refused.data.message).toMatch(/September 2022 is closed/);
    let now = await orderOf(api, shop, order.orderId);
    expect(now.amountReceived).toBe(0);
    expect(now.discountAmount || 0).toBe(0);
    expect(now.effectiveTotal).toBe(20);

    // The same $5 without waiving the rest only touches this month: taken.
    const ok = await api("addPayment", { org: shop.orgId, orderId: order.orderId, amount: 5, method: "cash" });
    expect(ok.amountReceived).toBe(5);
    expect(ok.balanceDue).toBe(15);
    expect(ok.discountAmount || 0).toBe(0);
    now = await orderOf(api, shop, order.orderId);
    expect(now.amountReceived).toBe(5);
    expect(now.discountAmount || 0).toBe(0);
  } finally {
    await reopenMine(api, [WAIVE_MONTH]);
  }
});

test("orders sold when shipped: Shipped, Delivered and Completed can't move into or out of a closed month", async ({ api }) => {
  // The default basis — orders count as sold when they ship — is what makes these dates the sale date. This file
  // never changes it; if another spec has it on "placed" right now, these dates aren't guarded and there's
  // nothing to check.
  const { accounting } = await api("getAccountingSettings");
  test.skip(accounting.saleDate !== "shipped", "the sale-date basis is " + accounting.saleDate + ", not the default");

  // A cap that needs no blank, sold and paid on October 3, 2022, then digitized, approved, made and packed that
  // week (each step dated when it happened).
  const shop = await makeShop(api, { prefix: "shipclose", products: [{ name: "Closed Month Cap", price: 18, type: "cap", idPrefix: "cap", extra: { noBlankNeeded: true } }] });
  try {
    await reopenMine(api, SHIP_MONTHS);
    const { orderId } = await localSale(api, shop, "2022-10-03", { paid: true });
    for (const [stage, at] of [["digitizingComplete", "2022-10-04"], ["designApproved", "2022-10-05"], ["manufactured", "2022-10-06"], ["qaPacked", "2022-10-07"]]) {
      await api("setFulfillmentStage", { org: shop.orgId, orderId, stage, at });
    }
    let order = await orderOf(api, shop, orderId);
    expect(order.qaPackedAt.slice(0, 10)).toBe("2022-10-07");
    expect(order.shippedAt || "").toBe("");
    const setDates = (dates) => api("setOrderDates", { orderId, dates }, { allowError: true, withStatus: true });
    const refusedFor = (r, month, what) => {
      expect(r.status, JSON.stringify(r.data)).toBe(409);
      expect(r.data.message).toMatch(new RegExp(month + " is closed"));
      expect(r.data.message).toMatch(new RegExp(what + " can't move into or out of it"));
    };

    // Into a closed month: November 2022 is closed, so Shipped can't be November 10 — and it stays empty.
    await closeMonth(api, "2022-11");
    refusedFor(await setDates({ shippedAt: "2022-11-10" }), "November 2022", "shipped");
    order = await orderOf(api, shop, orderId);
    expect(order.shippedAt || "").toBe("");
    // QA and packed isn't the sale date: it may be dated in the closed month.
    expect((await setDates({ qaPackedAt: "2022-11-02" })).data.status).toBe("ok");
    // December is open: Shipped December 10 is taken.
    const shipped = await setDates({ shippedAt: "2022-12-10" });
    expect(shipped.data.status, JSON.stringify(shipped.data)).toBe("ok");
    expect(shipped.data.order.shippedAt.slice(0, 10)).toBe("2022-12-10");

    // Out of a closed month: with December closed, Shipped can't move from December 10 to January — and stays.
    await closeMonth(api, "2022-12");
    refusedFor(await setDates({ shippedAt: "2023-01-10" }), "December 2022", "shipped");
    order = await orderOf(api, shop, orderId);
    expect(order.shippedAt.slice(0, 10)).toBe("2022-12-10");
    // Delivered can't go into December either; in January (open) it is taken.
    refusedFor(await setDates({ deliveredAt: "2022-12-20" }), "December 2022", "delivered");
    order = await orderOf(api, shop, orderId);
    expect(order.deliveredAt || "").toBe("");
    const delivered = await setDates({ deliveredAt: "2023-01-15" });
    expect(delivered.data.status, JSON.stringify(delivered.data)).toBe("ok");

    // Completed: not into closed February; March (open) is taken; and from March not back into February.
    await closeMonth(api, "2023-02");
    refusedFor(await setDates({ completedAt: "2023-02-01" }), "February 2023", "completed");
    order = await orderOf(api, shop, orderId);
    expect(order.completedAt || "").toBe("");
    const completed = await setDates({ completedAt: "2023-03-01" });
    expect(completed.data.status, JSON.stringify(completed.data)).toBe("ok");
    expect(completed.data.order.completedAt.slice(0, 10)).toBe("2023-03-01");
    refusedFor(await setDates({ completedAt: "2023-02-20" }), "February 2023", "completed");
    order = await orderOf(api, shop, orderId);
    expect(order.completedAt.slice(0, 10)).toBe("2023-03-01");

    // Reopened, the same move is taken.
    await api("reopenPeriod", { month: "2022-12" });
    const moved = await setDates({ shippedAt: "2023-01-10" });
    expect(moved.data.status, JSON.stringify(moved.data)).toBe("ok");
    expect(moved.data.order.shippedAt.slice(0, 10)).toBe("2023-01-10");
  } finally {
    await reopenMine(api, SHIP_MONTHS);
  }
});

// However a test above ended, none of this file's months is left closed.
test("none of this file's months is left closed", async ({ api }) => {
  await reopenMine(api);
  const { periods } = await api("listClosedPeriods");
  expect(periods.map((p) => p.month).filter((m) => MY_MONTHS.includes(m))).toEqual([]);
});
