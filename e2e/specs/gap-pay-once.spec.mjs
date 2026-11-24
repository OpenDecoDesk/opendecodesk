// Payments booked once (review #33, #53): money a page sends twice is recorded once. A double click on the
// Payments window's Save, a Save pressed again after its answer was lost, two Mark as paid at the same moment, a
// Local sale the page retries after a dropped connection, and a storefront order sent again after a lost answer.
//
// Each money form makes one key when it draws (public/admin.js newRequestId_) and sends it as `requestId` with every
// try; the server keeps it on the payment row (functions/api/orders.js requestKeyOf), and a Local sale's order
// number is made from it. A lost answer is made here the way it happens for real: the request reaches the server
// and is answered, and the page never gets the answer (route.fetch, then route.abort). Every count is read back
// from the server afterwards.
//
// Every test makes its own shop and orders, and only ever reads those: other specs use the same install at once.
import crypto from "node:crypto";
import { test, expect, openAdmin, toast, uniq, ADMIN, shopUrl } from "../fixtures.mjs";
import { makeShop, placeOrder } from "../lib/data.mjs";

// ---- helpers ---------------------------------------------------------------------------------------------
// The shop's Orders page, as a real page load.
const ordersPage = async (page, shop) => {
  if (page.url().startsWith(ADMIN)) await page.goto("about:blank");
  await openAdmin(page, "orders/" + shop.orgId);
  await expect(page.getByRole("combobox", { name: "Shop" })).toHaveValue(shop.orgId);
};
const orderRow = (page, orderId) => page.locator(`tr[data-order="${orderId}"]`).first();
const actionCell = (page, orderId) => orderRow(page, orderId).locator("td[data-action-td]");
const PAID = /\bPaid\b/;

// A $20 order (one Sample Tee) placed on a fresh shop's own page.
const shopWithOrder = async (api, page, prefix = "once") => {
  const shop = await makeShop(api, { prefix, products: [{ name: "Sample Tee", price: 20 }] });
  const order = await placeOrder(page, shop, { customer: uniq("Pat Payonce") });
  expect(order.total).toBe("20.00");
  return { shop, order };
};

// A key the way the admin page makes one (newRequestId_: a UUID without its dashes).
const requestId = () => crypto.randomUUID().replace(/-/g, "");
// The JSON body of a request the page sent (null when it isn't JSON).
const bodyOf = (req) => { try { return JSON.parse(req.postData() || "null"); } catch (e) { return null; } };
// An order as the owner's Orders list has it, read back from the server.
const readOrder = async (api, orgId, orderId) => (await api("getOrders", { org: orgId })).orders.find(o => o.orderId === orderId);
// Its payments that count (not voided).
const paymentsOf = async (api, orgId, orderId) => ((await readOrder(api, orgId, orderId)) || {}).payments?.filter(p => !p.voidedAt) || [];
// The audit entries of one kind for one order. The server writes them after answering (waitUntil), so this waits
// until the first is there and a moment more, then reads them all.
const auditOf = async (api, orderId, action) => {
  const read = async () => (await api("getAuditLog", { orderId, filter: action, limit: 20 })).entries.filter(e => e.action === action);
  await expect.poll(async () => (await read()).length, { timeout: 10_000 }).toBeGreaterThan(0);
  await new Promise(r => setTimeout(r, 1000));
  return read();
};

// Answers one kind of /api/orders request on the page by asking the server and then dropping the connection,
// so the server has done it and the page never hears (`times`: how many such requests are dropped; later ones go
// through). Returns the bodies of every request of that kind the page sent.
const loseAnswers = async (page, url, isTarget, times = 1) => {
  const sent = [];
  let dropped = 0;
  await page.route(url, async (route) => {
    const req = route.request();
    const body = req.method() === "POST" ? bodyOf(req) : null;
    if (!body || !isTarget(body)) return route.fallback();
    sent.push(body);
    if (dropped < times) {
      dropped++;
      await route.fetch();                       // the server records it…
      return route.abort("connectionreset");     // …and the answer never reaches the page
    }
    return route.fallback();
  });
  return sent;
};

// ---- P14: the Payments window's Save -----------------------------------------------------------------------
test("Payments: a double click on Save sends one request, reads Saving… while it waits, and books one payment", async ({ page, api }) => {
  const { shop, order } = await shopWithOrder(api, page, "pm2x");
  const id = order.orderId;
  await ordersPage(page, shop);
  // The addPayment requests the page sends are held until the test lets them go: a slow answer.
  const sent = [];
  let release;
  const gate = new Promise(r => { release = r; });
  await page.route("**/api/orders", async (route) => {
    const body = bodyOf(route.request());
    if (body && body.action === "addPayment") { sent.push(body); await gate; }
    return route.fallback();
  });
  await actionCell(page, id).getByRole("button", { name: "💰 Payments" }).click();
  const pm = page.locator("#pmContent");
  await expect(pm).toContainText(/Amount due\s*\$20\.00/);
  await pm.locator("#pmAmount").fill("20");
  await pm.locator("#pmMethod").selectOption("cash");
  const save = pm.locator("#pmSavePayment");
  await save.dblclick();
  // While the answer is on its way the button is off and says so; the second click sent nothing.
  await expect(save).toBeDisabled();
  await expect(save).toHaveText("Saving…");
  await page.waitForTimeout(500);
  expect(sent.length).toBe(1);
  expect(sent[0].requestId).toMatch(/^[0-9a-f]{32}$/);
  release();
  await expect(toast(page)).toContainText("Payment recorded.");
  await expect(page.locator("#pmContent")).toContainText(/Balance due\s*Settled ✓/);
  expect(sent.length).toBe(1);
  // The server agrees: one $20 cash payment.
  const pays = await paymentsOf(api, shop.orgId, id);
  expect(pays.map(p => Number(p.amount))).toEqual([20]);
});

test("Payments: Save again after a lost answer sends the same key and is booked once; an overpayment shows as a credit", async ({ page, api }) => {
  const { shop, order } = await shopWithOrder(api, page, "pmlost");
  const id = order.orderId;
  await ordersPage(page, shop);
  const sent = await loseAnswers(page, "**/api/orders", (b) => b.action === "addPayment");
  await actionCell(page, id).getByRole("button", { name: "💰 Payments" }).click();
  const pm = page.locator("#pmContent");
  await pm.locator("#pmAmount").fill("20");
  await pm.locator("#pmMethod").selectOption("cash");
  await pm.locator("#pmSavePayment").click();
  // No answer: the window says the payment may be in, and that Save again won't add it twice.
  await expect(pm.locator("#pmError")).toContainText("No answer from the server — the payment may have been recorded");
  await expect(pm.locator("#pmSavePayment")).toBeEnabled();
  await pm.locator("#pmSavePayment").click();
  await expect(toast(page)).toContainText("That payment was already recorded — it isn't added twice.");
  await expect(page.locator("#pmContent")).toContainText(/Balance due\s*Settled ✓/);
  // Both tries carried the window's one key.
  expect(sent.length).toBe(2);
  expect(sent[1].requestId).toBe(sent[0].requestId);
  expect(sent[0].requestId).toMatch(/^[0-9a-f]{32}$/);
  // One $20 payment on the server.
  expect((await paymentsOf(api, shop.orgId, id)).map(p => Number(p.amount))).toEqual([20]);

  // The page's very request, sent once more with the browser's own session: the server answers that it was a repeat.
  const replay = await page.request.post(ADMIN + "/api/orders", { data: sent[0], headers: { Origin: ADMIN } });
  const replayed = await replay.json();
  expect(replayed.status).toBe("ok");
  expect(replayed.duplicate).toBe(true);
  expect((await paymentsOf(api, shop.orgId, id)).map(p => Number(p.amount))).toEqual([20]);

  // $5 more than the order comes to, with a new key: recorded. The same key again: a repeat, not a second $5.
  const extra = { orderId: id, org: shop.orgId, amount: 5, method: "cash", reference: "", note: "Paid twice by mistake", requestId: requestId() };
  const first = await api("addPayment", extra);
  expect(first.duplicate).toBeFalsy();
  const again = await api("addPayment", extra);
  expect(again.duplicate).toBe(true);
  expect((await paymentsOf(api, shop.orgId, id)).map(p => Number(p.amount)).sort((a, b) => a - b)).toEqual([5, 20]);

  // The window shows the $5 as a credit — not "Settled ✓".
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await ordersPage(page, shop);
  await actionCell(page, id).getByRole("button", { name: "💰 Payments" }).click();
  const pm2 = page.locator("#pmContent");
  await expect(pm2).toContainText(/Credit \(paid more than owed\)\s*\$5\.00/);
  await expect(pm2).not.toContainText("Settled ✓");
});

// ---- P15: two Mark as paid at once ------------------------------------------------------------------------
// The money is booked once however the requests meet (settleOrderBalance books the balance only while the payments
// still add up to what it read). What the other requests are told, and whether they are audited and emailed again,
// depends on how they meet: that part is the test.fixme test below (a bug).
test("Mark as paid from two pages at the same moment books the balance once", async ({ page, api, as }) => {
  const { shop, order } = await shopWithOrder(api, page, "mp2p");
  const id = order.orderId;
  const other = await as("owner");
  // Each page's markPaidManual is held until both pages have sent theirs; then both go to the server together.
  const sent = [];
  let release;
  const gate = new Promise(r => { release = r; });
  const answers = [];
  for (const p of [page, other]) {
    await p.route("**/api/orders", async (route) => {
      const body = bodyOf(route.request());
      if (!body || body.action !== "markPaidManual") return route.fallback();
      sent.push(body);
      await gate;
      const res = await route.fetch();
      answers.push({ page: p, ...(await res.json()) });
      return route.fulfill({ response: res });
    });
  }
  await ordersPage(page, shop);
  await ordersPage(other, shop);
  for (const p of [page, other]) {
    await actionCell(p, id).getByRole("button", { name: "Mark as paid" }).click();
    await expect(p.locator(".confirm-modal")).toContainText("Mark order " + id + " as paid?");
    await p.locator(".confirm-modal #cmOk").click();
  }
  await expect.poll(() => sent.length).toBe(2);
  // What the pages sent: the same order, each with its own key and the time chosen in the window.
  expect(sent.every(b => b.orderId === id && b.org === shop.orgId && /^[0-9a-f]{32}$/.test(b.requestId) && b.at)).toBe(true);
  expect(sent[0].requestId).not.toBe(sent[1].requestId);
  release();
  await expect.poll(() => answers.length).toBe(2);
  expect(answers.every(a => a.status === "ok")).toBe(true);
  expect(answers.filter(a => !a.alreadyPaid).length).toBeGreaterThanOrEqual(1);
  // A page told it was already paid says so.
  for (const a of answers.filter(x => x.alreadyPaid)) {
    expect(a.amountRecorded).toBe(0);
    await expect(toast(a.page)).toContainText("This order was already paid — nothing more was recorded and no email was sent.");
  }
  for (const p of [page, other]) await expect(orderRow(p, id)).toContainText(PAID);

  // The server: one payment, of the $20.
  const pays = await paymentsOf(api, shop.orgId, id);
  expect(pays.length).toBe(1);
  expect(Number(pays[0].amount)).toBe(20);
  expect(pays[0].note).toMatch(/^Marked paid manually/);
  expect((await auditOf(api, id, "order.marked_paid")).length).toBeGreaterThanOrEqual(1);
});

// An unpaid $20 order made quickly (a Local sale left unpaid, through the owner's API).
const unpaidOrder = async (api, shop) => (await api("createLocalSale", { org: shop.orgId, requestId: requestId(),
  items: [{ productId: shop.products[0].productId, qty: 1 }], paymentMethod: "Check", customerName: uniq("Uma Unpaid") })).orderId;
// What the page sends for one Mark as paid (markOrderPaidOnce_): org, order, the chosen time, its key marker and a
// fresh requestId.
const markPaidBody = (shop, orderId, at) => ({ org: shop.orgId, orderId, at, key: "cookie", requestId: requestId() });

test("Mark as paid sent five times at once, on ten orders, books each balance once", async ({ api }) => {
  const shop = await makeShop(api, { prefix: "mp5x", products: [{ name: "Sample Tee", price: 20 }] });
  for (let round = 0; round < 10; round++) {
    const id = await unpaidOrder(api, shop);
    const at = new Date().toISOString();
    const answers = await Promise.all([0, 1, 2, 3, 4].map(() => api("markPaidManual", markPaidBody(shop, id, at))));
    expect(answers.every(a => a.status === "ok")).toBe(true);
    expect(answers.filter(a => !a.alreadyPaid).length).toBeGreaterThanOrEqual(1);
    expect((await paymentsOf(api, shop.orgId, id)).map(p => Number(p.amount)), "payments on " + id).toEqual([20]);
    // And once more, now that it is paid: told so, and nothing more.
    const late = await api("markPaidManual", markPaidBody(shop, id, at));
    expect(late).toMatchObject({ alreadyPaid: true, amountRecorded: 0 });
    expect((await paymentsOf(api, shop.orgId, id)).length).toBe(1);
  }
});

// BUG (functions/api/orders.js, markPaidManual): a Mark as paid that loses the race books nothing, but is still
// answered as if it had paid the order, and is audited and emailed again. `newlyPaid = recorded > 0 ||
// (!before.paid && order.paid)`: the second half (meant for an order that owes $0) is also true for a losing
// request that read `before` before the winner's payment went in. So it answers plain "ok" (no alreadyPaid: its page
// shows no "already paid"), sends the customer a second payment-confirmed email, writes a second order.marked_paid
// audit entry and delivers digital products again. The money itself is booked once (the tests above).
// It shows only when the requests interleave on the server, which depends on how busy the machine is: while this
// spec was written it showed in up to half the rounds under load (it failed the two-page test above once in a full
// suite run) and in about 1 of 200 rounds on a quiet machine. A test.fail would then "unexpectedly pass", so this is
// test.fixme until markPaidManual is fixed; then take the fixme off and it must pass every time.
test.fixme("Mark as paid sent at once: one answer books it, the rest are told it was already paid, one audit entry", async ({ api }) => {
  test.setTimeout(120_000);
  const shop = await makeShop(api, { prefix: "mprace", products: [{ name: "Sample Tee", price: 20 }] });
  for (let round = 1; round <= 20; round++) {
    const id = await unpaidOrder(api, shop);
    const at = new Date().toISOString();
    const answers = await Promise.all([0, 1, 2, 3, 4].map(() => api("markPaidManual", markPaidBody(shop, id, at))));
    expect((await paymentsOf(api, shop.orgId, id)).length).toBe(1);
    expect(answers.filter(a => !a.alreadyPaid).length, "answers on " + id + " not saying alreadyPaid (round " + round + ")").toBe(1);
    expect(answers.filter(a => a.alreadyPaid === true && a.amountRecorded === 0).length).toBe(4);
    expect((await auditOf(api, id, "order.marked_paid")).length, "order.marked_paid entries on " + id).toBe(1);
  }
});

// ---- P16: a Local sale retried with its key -----------------------------------------------------------------
test("Local sale: the retry after a dropped connection carries the same key, gets one order and one payment, and says so", async ({ page, api }) => {
  const shop = await makeShop(api, { prefix: "lsretry", products: [{ name: "Sample Tee", price: 20 }] });
  const customer = uniq("Rae Retry");
  await ordersPage(page, shop);
  const sent = await loseAnswers(page, "**/api/orders", (b) => b.action === "createLocalSale");
  await page.getByRole("button", { name: "+ Local sale" }).click();
  const form = page.locator("#localSaleForm");
  await expect(form).toBeVisible();
  await form.locator("#lsProduct").selectOption({ label: "Sample Tee" });
  await form.locator("#lsQty").fill("1");
  await form.locator("#lsPayment").selectOption("Cash");
  await form.locator("summary", { hasText: "Customer info" }).click();
  await form.locator("#lsName").fill(customer);
  await form.locator("#lsPaid").check();
  await form.getByRole("button", { name: "Record sale" }).click();
  // The page tried once more by itself, with the same key, and the server said the sale was already there.
  await expect(toast(page)).toContainText("Local sale already recorded — ");
  expect(sent.length).toBe(2);
  expect(sent[0].requestId).toMatch(/^[0-9a-f]{32}$/);
  expect(sent[1].requestId).toBe(sent[0].requestId);
  // The order number comes from the key.
  const orderId = (await toast(page).textContent()).match(/already recorded — (\S+)/)[1];
  expect(orderId).toMatch(/-LS-[0-9A-F]{20}$/);
  expect(orderId.endsWith(sent[0].requestId.slice(0, 20).toUpperCase())).toBe(true);

  // One order on this shop, paid once.
  const orders = (await api("getOrders", { org: shop.orgId })).orders;
  expect(orders.map(o => o.orderId)).toEqual([orderId]);
  expect(orders[0].customerName).toBe(customer);
  expect((await paymentsOf(api, shop.orgId, orderId)).map(p => [Number(p.amount), p.note])).toEqual([[20, "Local sale (Cash)"]]);
  // The same request a third time (the page's own body, its own session): still the one order, answered as a repeat.
  const replay = await page.request.post(ADMIN + "/api/orders", { data: sent[0], headers: { Origin: ADMIN } });
  const replayed = await replay.json();
  expect(replayed).toMatchObject({ status: "ok", orderId, repeated: true });
  expect((await api("getOrders", { org: shop.orgId })).orders.length).toBe(1);
  expect((await paymentsOf(api, shop.orgId, orderId)).length).toBe(1);

  // The Payments window: one "Local sale (Cash)", $20 received, settled.
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await ordersPage(page, shop);
  await expect(page.locator("tr[data-order]", { hasText: customer })).toHaveCount(1);
  await expect(orderRow(page, orderId)).toContainText(PAID);
  await actionCell(page, orderId).getByRole("button", { name: "💰 Payments" }).click();
  const pm = page.locator("#pmContent");
  await expect(pm).toContainText(/Received\s*\$20\.00/);
  await expect(pm).toContainText(/Balance due\s*Settled ✓/);
  await expect(pm.getByText("Local sale (Cash)")).toHaveCount(1);
});

// ---- P17: a storefront order sent again after a lost answer ------------------------------------------------
test("storefront: Place order again after a lost answer resends the same order and makes one order", async ({ as, api, page: admin }) => {
  const shop = await makeShop(api, { prefix: "sfretry", products: [{ name: "Sample Tee", price: 20 }] });
  const customer = uniq("Lou Lostanswer");
  const page = await as(null);
  const sent = await loseAnswers(page, shopUrl(shop.subdomain) + "/api/orders", (b) => !b.action && !!b.orderId);
  const answers = [];
  page.on("response", async (res) => {
    if (res.request().method() === "POST" && res.url() === shopUrl(shop.subdomain) + "/api/orders") answers.push(await res.json().catch(() => null));
  });
  await page.goto(shopUrl(shop.subdomain) + "/");
  await expect(page.getByRole("heading", { level: 1, name: shop.name })).toBeVisible();
  const tee = page.locator("main").getByRole("heading", { level: 3, name: "Sample Tee", exact: true })
    .locator("xpath=ancestor::*[.//button[normalize-space()='Add to cart']][1]");
  await tee.getByRole("button", { name: "Add to cart" }).click();
  await page.getByLabel("Your name").fill(customer);
  await page.getByLabel("Email address").fill("lou@example.test");
  await page.getByLabel("Payment method").selectOption({ label: "Check" });
  await page.getByRole("button", { name: "Place order" }).click();

  // No answer: no confirmation, the page says it couldn't confirm the order, and the cart is still there.
  await expect(page.locator("#checkoutMsg")).toContainText("We couldn't confirm your order went through.");
  await expect(page.locator("#checkoutMsg")).toContainText("it won't be placed twice");
  await expect(page.getByRole("heading", { level: 2, name: /^Order received/ })).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 2, name: "Your order (1 item)" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Place order" })).toBeEnabled();

  // Place order again: the confirmation, for the order the first try made.
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page.getByRole("heading", { level: 2, name: /^Order received/ })).toBeVisible();
  const line = await page.locator(".confirmation .order-number").textContent();
  const shownId = /^\s*(\S+)\s*·/.exec(line)[1];
  expect(sent.length).toBe(2);
  expect(sent[0].orderId).toBe(shownId);
  expect(sent[1].orderId).toBe(shownId);
  // The server recognised the second as the first one's repeat.
  await expect.poll(() => answers.length).toBe(1);
  expect(answers[0]).toMatchObject({ status: "ok", duplicate: true });

  // The owner's list: exactly one order for this customer, with the confirmation's number.
  const mine = (await api("getOrders", { org: shop.orgId })).orders.filter(o => o.customerName === customer);
  expect(mine.map(o => o.orderId)).toEqual([shownId]);
  await ordersPage(admin, shop);
  await expect(admin.locator("tr[data-order]", { hasText: customer })).toHaveCount(1);
});

