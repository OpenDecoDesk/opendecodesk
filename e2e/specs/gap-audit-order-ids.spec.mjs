// Audit-log order IDs are data, not code (review 52.16): many actions pass the request's orderId to the audit log
// unchecked, and the Audit log screen makes each one a link that filters the log. The server keeps only a real
// order ID (letters, digits and dashes, up to 64: functions/_lib/db.js insertAuditLog) and drops anything else, and
// the page escapes every cell it draws and carries the ID as data (data-order, the auditFilterOrder_ action), never
// as script. Here a crafted order ID is sent with deleteBlankShipment (which records the request's orderId as it
// is) and the row shows "—" with nothing run: no window.__pwned, no dialog, nothing the page's security policy had
// to refuse (the context fixture fails the test on that). A crafted shop field on the same kind of entry shows as
// text. Then a real order's "Marked paid" entry's link filters the log to that order.
//
// Every entry here is this spec's own: the shipments don't exist (a random number, unique to the run), and the
// order is on a shop made for the test. Rows are found by those, never by position among other specs' entries.
import crypto from "node:crypto";
import { test, expect, openAdmin, uniq } from "../fixtures.mjs";
import { makeShop, placeOrder } from "../lib/data.mjs";

// A shipment number no shipment has (they count up from 1): the audit row is found by it.
const noSuchShipment = () => 900000000 + crypto.randomInt(0, 99999999);
// The audit entries of one kind, read back from the server. The server writes them after answering (waitUntil),
// so this waits until `found` picks one out.
const auditEntry = async (api, filter, found, opts = {}) => {
  let hit = null;
  await expect.poll(async () => {
    const { entries } = await api("getAuditLog", { filter, limit: 200, ...opts });
    hit = entries.find(found) || null;
    return !!hit;
  }, { timeout: 10_000 }).toBe(true);
  return hit;
};
// Runs a search on the Audit log page and waits for its answer.
const search = async (page, { action = null, order = null } = {}) => {
  if (action !== null) await page.locator("#afAction").fill(action);
  if (order !== null) await page.locator("#afOrder").fill(order);
  const answered = page.waitForResponse(r => r.url().endsWith("/api/orders") && /"action":"getAuditLog"/.test(r.request().postData() || ""));
  await page.getByRole("button", { name: "Search" }).click();
  await answered;
};
// The Audit log table's cells by column (Date / Time, Shop, Order, Action, Details).
const cell = (row, n) => row.locator("td").nth(n);

test("Audit log: a crafted order ID is dropped and shown as —, nothing runs; a real order's link filters the log", async ({ page, api }) => {
  // Anything that runs, or any dialog, is recorded.
  const dialogs = [];
  page.on("dialog", async (d) => { dialogs.push(d.type() + ": " + d.message()); await d.dismiss().catch(() => {}); });
  const pwned = () => page.evaluate(() => typeof window.__pwned);

  // Two crafted order IDs, each on a blank-shipment delete (the shipments don't exist; the entry is still written).
  const JS_ID = "x');window.__pwned=1;//";
  const HTML_ID = "\"><img src=x onerror=\"window.__pwned=2\">";
  const HTML_SHOP = "<b id=\"e2eAuditShop\">crafted shop</b>";
  const s1 = noSuchShipment(), s2 = noSuchShipment() + 1;
  await api("deleteBlankShipment", { id: s1, orderId: JS_ID });
  await api("deleteBlankShipment", { id: s2, orderId: HTML_ID, org: HTML_SHOP });
  // The server kept neither as an order ID.
  const e1 = await auditEntry(api, "blank.shipment_deleted", e => e.detail && e.detail.shipmentId === s1);
  const e2 = await auditEntry(api, "blank.shipment_deleted", e => e.detail && e.detail.shipmentId === s2);
  expect(e1.orderId).toBeNull();
  expect(e2.orderId).toBeNull();

  // On the page: each row's Order cell is "—" with no link; the crafted shop is text, not an element.
  await openAdmin(page, "audit");
  await page.locator("#afLimit").selectOption("200");
  await search(page, { action: "blank.shipment_deleted" });
  const results = page.locator("#auditResults");
  const row1 = results.locator("tbody tr", { hasText: '"shipmentId":' + s1 });
  const row2 = results.locator("tbody tr", { hasText: '"shipmentId":' + s2 });
  await expect(row1).toHaveCount(1);
  await expect(row2).toHaveCount(1);
  for (const row of [row1, row2]) {
    await expect(cell(row, 2)).toHaveText("—");
    await expect(cell(row, 2).locator("a")).toHaveCount(0);
  }
  await expect(cell(row2, 1)).toHaveText(HTML_SHOP);
  await expect(page.locator("#e2eAuditShop")).toHaveCount(0);
  await expect(results.locator("img")).toHaveCount(0);
  expect(await pwned()).toBe("undefined");

  // The crafted ID typed into the Order ID filter is only searched for: nothing is found, nothing runs.
  await search(page, { order: JS_ID });
  await expect(results).toContainText("No entries found for these filters.");
  await search(page, { order: HTML_ID });
  await expect(results).toContainText("No entries found for these filters.");
  expect(await pwned()).toBe("undefined");
  expect(dialogs).toEqual([]);

  // A real order, marked paid.
  const shop = await makeShop(api, { prefix: "audit", products: [{ name: "Sample Tee", price: 20 }] });
  const { orderId } = await placeOrder(page, shop, { customer: uniq("Avery Audit") });
  await api("markPaidManual", { org: shop.orgId, orderId, requestId: uniq("pay").replace(/\W/g, "") });
  await auditEntry(api, "order.marked_paid", e => e.orderId === orderId, { orderId });

  // Its Marked paid entry is listed with the order as a link; the link fills the Order ID filter and the log
  // lists that order's entries only.
  await openAdmin(page, "audit");
  await page.locator("#afLimit").selectOption("200");
  await search(page, { action: "order.marked_paid" });
  const paidRow = results.locator("tbody tr", { has: page.getByRole("link", { name: orderId, exact: true }) });
  await expect(paidRow).toHaveCount(1);
  await expect(paidRow).toContainText("Marked paid");
  await expect(cell(paidRow, 1)).toHaveText(shop.orgId);
  const filtered = page.waitForResponse(r => r.url().endsWith("/api/orders")
    && /"action":"getAuditLog"/.test(r.request().postData() || "") && (r.request().postData() || "").includes('"orderId":"' + orderId + '"'));
  await paidRow.getByRole("link", { name: orderId, exact: true }).click();
  await filtered;
  await expect(page.locator("#afOrder")).toHaveValue(orderId);
  const rows = results.locator("tbody tr");
  await expect(rows).toHaveCount(1);
  await expect(cell(rows.first(), 2)).toHaveText(orderId);
  await expect(rows.first()).toContainText("Marked paid");

  // With the action filter cleared, every entry listed is that order's (and Marked paid is among them).
  await search(page, { action: "" });
  await expect(rows.first()).toBeVisible();
  const n = await rows.count();
  expect(n).toBeGreaterThanOrEqual(1);
  for (let i = 0; i < n; i++) await expect(cell(rows.nth(i), 2)).toHaveText(orderId);
  await expect(results.locator("tbody tr", { hasText: "Marked paid" })).toHaveCount(1);

  expect(await pwned()).toBe("undefined");
  expect(dialogs).toEqual([]);
});
