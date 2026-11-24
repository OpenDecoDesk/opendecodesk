// The business's time zone (review #60, and #52's "today" fixes): the admin shows every date and "today" on the
// business's calendar — Global settings → Region, else the TIMEZONE variable, else UTC — never on the calendar of
// the computer it is opened on. The e2e install is on UTC, and other specs count on that, so nothing here changes
// it. Instead the browser is put somewhere else: each context is opened with Playwright's `timezoneId` (Auckland,
// a day ahead of UTC for half of each UTC day; Los Angeles, a day behind for the other part), and the page's clock
// is pinned (page.clock.setFixedTime) to a moment when the browser's day and the UTC day differ. The pinned moment
// is always on the real UTC day, and in the Los Angeles tests never later than the real time, so the server (on the
// real clock) and the page agree on "today" and on what is "in the future". Only Date is pinned: the page's timers
// run as usual, and the session cookie is checked by the browser on the real clock, so signing in is unaffected.
//
// What a page on the wrong calendar would get wrong, and so what each check below would catch:
//   - "today" (Home's date, the Orders range, the audit log's and Expenses' dates, report To boxes, due-date chips)
//     would be the browser's day, a day off;
//   - the Orders whole-day filter would cut days at the browser's midnight, so an order placed early on a UTC day
//     would be found under the day before;
//   - a typed date and time ("When did this happen?", the Dates window) would be read on the browser's clock and
//     stored hours off;
//   - a stored time would be shown as the browser's day, and a plain stored date (a due date) read as UTC midnight
//     would move back a day west of UTC.
import { test, expect, openAdmin, waitIdle, toast, uniq, readCredentials, signInThroughPage, ADMIN } from "../fixtures.mjs";
import { makeShop, placeOrder } from "../lib/data.mjs";

// ---- the calendar ----------------------------------------------------------------------------------------
const DAY_MS = 86400000;
const BUSINESS_ZONE = "UTC";                  // the e2e install's zone (no Region set, TIMEZONE unset)
const AHEAD = "Pacific/Auckland";              // UTC+13 (NZDT) or +12: its day is the UTC day + 1 from 12:00 UTC on
const BEHIND = "America/Los_Angeles";          // UTC-8 (PST) or -7: its day is the UTC day - 1 until 07:00 UTC

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (day, n) => isoDay(Date.parse(day + "T12:00:00Z") + n * DAY_MS);
// A day as the admin writes it in a table: "11/23/2026" (adminDate_ / adminShortDate_ in en-US).
const mdy = (day) => { const [y, m, d] = day.split("-"); return `${+m}/${+d}/${y}`; };
// Home's heading date: "Mon, Nov 23, 2026".
const homeDate = (day) => new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
  .format(new Date(day + "T12:00:00Z"));

// The real UTC day, and the moment to pin the page's clock to for a browser in `zone`: the real time, moved (within
// the same UTC day) to when that zone's day differs from the UTC day. Ahead: no earlier than 12:30 UTC (it may be up
// to 12½ hours ahead of the real time — nothing in those tests records a time). Behind: no later than 06:30 UTC
// (always the real time or earlier, so a time typed in the page is never "in the future" for the server).
function calendarFor(zone) {
  const now = Date.now();
  const today = isoDay(now);
  const midnight = Date.parse(today + "T00:00:00Z");
  const pinned = zone === AHEAD ? Math.max(now, midnight + 12.5 * 3600000) : Math.min(now, midnight + 6.5 * 3600000);
  return { now, today, midnight, pinned };
}
// Close to UTC midnight the real day would change under a test (orders placed after it would fall outside the
// pinned "today"): those few minutes are skipped.
const nearUtcMidnight = () => { const m = new Date().getUTCHours() * 60 + new Date().getUTCMinutes(); return m >= 23 * 60 + 50; };

// The browser's own calendar day for a moment, as the page itself sees it (new Date() in its zone and pinned clock).
const browserToday = (page) => page.evaluate(() => { const d = new Date(); return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-"); });

// Pins the page's clock and checks the precondition every test depends on: the browser's day isn't the UTC day.
async function pinClock(page, zone) {
  const cal = calendarFor(zone);
  await page.clock.setFixedTime(cal.pinned);
  await page.goto("about:blank");
  const own = await browserToday(page);
  expect(own, "the browser's own day (" + zone + ") differs from the business's (UTC)").toBe(addDays(cal.today, zone === AHEAD ? 1 : -1));
  return cal;
}

// ---- the Orders page ---------------------------------------------------------------------------------------
const orderRow = (page, orderId) => page.locator(`tr[data-order="${orderId}"]`).first();
const actionCell = (page, orderId) => orderRow(page, orderId).locator("td[data-action-td]");
const stageCell = (page, orderId, field) => orderRow(page, orderId).locator(`td[data-stage-td="${field}"]`);
const ordersPage = async (page, shop) => {
  await openAdmin(page, "orders/" + shop.orgId);
  await expect(page.getByRole("combobox", { name: "Shop" })).toHaveValue(shop.orgId);
};
// Sets the Orders date range (each box fires its change, which loads that range) and waits for the list.
async function setRange(page, from, to) {
  for (const [id, v] of [["#ordFilterFrom", from], ["#ordFilterTo", to]]) {
    await page.locator(id).fill(v);
    await page.locator(id).dispatchEvent("change");
    await waitIdle(page);
  }
  await expect(page.locator("#adminPanel")).not.toContainText("Loading orders");
}
// Types a time into the confirm window's "When did this happen?" box (askWhen_) and confirms.
async function confirmAt(page, localValue) {
  const box = page.locator(".confirm-modal #cmWhen");
  await expect(box).toBeVisible();
  await box.fill(localValue);
  await page.locator(".confirm-modal #cmOk").click();
  await expect(page.locator(".confirm-modal")).toHaveCount(0);
}
// The order as the server has it.
const serverOrder = async (api, shop, orderId) => (await api("getOrdersByIds", { org: shop.orgId, orderIds: [orderId] })).orders[0];
const sameMoment = (stored) => new Date(stored).toISOString();

// The "today" every screen should start from, checked on one page in any zone.
async function expectBusinessToday(page, today, shop) {
  // Home's heading.
  await openAdmin(page, "home");
  await expect(page.locator("#app")).toContainText("All shops · " + homeDate(today));
  // Orders: the last 30 days and today.
  await ordersPage(page, shop);
  await expect(page.locator("#ordFilterTo")).toHaveValue(today);
  await expect(page.locator("#ordFilterFrom")).toHaveValue(addDays(today, -30));
  // The audit log's range.
  await openAdmin(page, "audit");
  await expect(page.locator("#afTo")).toHaveValue(today);
  await expect(page.locator("#afFrom")).toHaveValue(addDays(today, -30));
  // Expenses: a new expense is dated today, and can't be dated later.
  await openAdmin(page, "expenses");
  await expect(page.locator("#expDate")).toHaveValue(today);
  await expect(page.locator("#expDate")).toHaveAttribute("max", today);
  // The reports run from 1 January of the business's year to today. (Their To is the later of the business's day
  // and the UTC day — the same day here.)
  await openAdmin(page, "revenue");
  await expect(page.locator("#revFrom")).toHaveValue(today.slice(0, 4) + "-01-01");
  await expect(page.locator("#revTo")).toHaveValue(today);
  await openAdmin(page, "salestax");
  await expect(page.locator("#taxFrom")).toHaveValue(today.slice(0, 4) + "-01-01");
  await expect(page.locator("#taxTo")).toHaveValue(today);
}

// Run Order's "Paid, not yet run" list: the order's due-date chip.
async function expectDueChip(page, orderId, text) {
  await openAdmin(page, "runorder");
  const row = page.locator("tr", { has: page.getByRole("link", { name: orderId, exact: true }) });
  await expect(row).toContainText(text);
}

// ---- signing in ----------------------------------------------------------------------------------------------
test.describe("the business's zone comes with the sign-in", () => {
  test.use({ storageState: { cookies: [], origins: [] }, timezoneId: AHEAD, locale: "en-US" });

  test("the sign-in reply and \"me\" carry the zone, and with only the sign-in's copy Home is on the business's day", async ({ page, api }) => {
    test.skip(nearUtcMidnight(), "too close to UTC midnight: the day would change during the test");
    const me = await api("me", {}, { path: "/api/admin-users" });
    expect(me.timeZone).toBe(BUSINESS_ZONE);

    const { today } = await pinClock(page, AHEAD);
    // "me" is kept from answering, so the page has only the zone the sign-in reply (and then the stored session
    // marker) gave it.
    let meAsked = 0;
    await page.route(ADMIN + "/api/admin-users", async (route) => {
      let body = null;
      try { body = route.request().postDataJSON(); } catch (e) { /* not JSON */ }
      if (body && body.action === "me") { meAsked++; return route.abort(); }
      return route.continue();
    });
    await page.goto(ADMIN + "/#home");
    const reply = page.waitForResponse((r) => r.url().endsWith("/api/admin-session") && r.request().method() === "POST");
    await signInThroughPage(page, readCredentials().users.owner);
    const signedIn = await (await reply).json();
    expect(signedIn.status).toBe("ok");
    expect(signedIn.timeZone).toBe(BUSINESS_ZONE);
    await expect(page.getByRole("navigation", { name: "Admin" })).toBeVisible();
    expect(meAsked, "the page asked for \"me\" (and was refused)").toBeGreaterThan(0);

    // Straight after signing in (the same page, no reload): the sign-in may send the owner on to Global settings
    // (setup is incomplete on this install) a moment after the menu appears, so go to Home by its address once that
    // has settled — and again if it moved away first.
    await waitIdle(page, 500);
    await expect(async () => {
      if (!/#home$/.test(page.url())) await page.evaluate(() => { location.hash = "#home"; });
      await expect(page.locator("#app")).toContainText("All shops · " + homeDate(today), { timeout: 2000 });
    }).toPass({ timeout: 20_000 });
    // The session marker keeps the zone, and a fresh load (still without "me") uses it.
    const marker = await page.evaluate(() => Object.keys(localStorage).map(k => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } })
      .find(v => v && v.token === "cookie"));
    expect(marker && marker.timeZone).toBe(BUSINESS_ZONE);
    await openAdmin(page, "home");
    await expect(page.locator("#app")).toContainText("All shops · " + homeDate(today));
  });
});

// ---- a browser a day ahead of the business ------------------------------------------------------------------
test.describe("from a browser a day ahead (Auckland)", () => {
  test.use({ timezoneId: AHEAD, locale: "en-US" });

  test("Home, the Orders range, the audit log, Expenses, the report ranges and the due-date chip are on the business's today", async ({ page, api }) => {
    test.skip(nearUtcMidnight(), "too close to UTC midnight: the day would change during the test");
    // The order is placed (on the real clock) before the page's clock is pinned.
    const shop = await makeShop(api, { prefix: "tzahead" });
    const order = await placeOrder(page, shop, { customer: uniq("Ari Ahead") });
    const today = isoDay(Date.now());
    await api("markPaidManual", { org: shop.orgId, orderId: order.orderId, requestId: uniq("pay").replace(/\W/g, "") });
    await api("setOrderDates", { org: shop.orgId, orderId: order.orderId, dates: {}, dueDate: today });

    const cal = await pinClock(page, AHEAD);
    expect(cal.today).toBe(today);
    await expectBusinessToday(page, today, shop);

    // The order placed today is in the default range, its order date is the business's today, and its due date
    // (a plain day) is shown as written.
    await ordersPage(page, shop);
    await expect(orderRow(page, order.orderId)).toBeVisible();
    await expect(orderRow(page, order.orderId).locator("td[data-date-td]")).toContainText(mdy(today));
    await expect(orderRow(page, order.orderId).locator("td[data-due-td]")).toContainText(mdy(today));
    // Due today, not "1 day overdue" (the browser's day is tomorrow).
    await expectDueChip(page, order.orderId, `⏱ Due ${today} · due today`);
  });
});

// ---- a browser a day behind the business --------------------------------------------------------------------
test.describe("from a browser a day behind (Los Angeles)", () => {
  test.use({ timezoneId: BEHIND, locale: "en-US" });

  test("Home, the Orders range, the audit log, Expenses and the report ranges are on the business's today", async ({ page, api }) => {
    test.skip(nearUtcMidnight(), "too close to UTC midnight: the day would change during the test");
    const shop = await makeShop(api, { prefix: "tzbehind" });
    const { today } = await pinClock(page, BEHIND);
    await expectBusinessToday(page, today, shop);
  });

  test("typed times are read on the business's clock, the whole-day filter cuts at its midnight, and a due date never moves", async ({ page, api }) => {
    test.skip(nearUtcMidnight(), "too close to UTC midnight: the day would change during the test");
    const shop = await makeShop(api, { prefix: "tzclock" });
    const order = await placeOrder(page, shop, { customer: uniq("Bea Behind") });
    const id = order.orderId;
    const { today } = await pinClock(page, BEHIND);
    const yesterday = addDays(today, -1);
    await ordersPage(page, shop);
    await expect(orderRow(page, id)).toBeVisible();

    // The Dates window shows the order's time on the business's clock (UTC: the stored time's own wall-clock)…
    const placed = (await serverOrder(api, shop, id)).placedAt;
    await orderRow(page, id).locator("td[data-date-td]").getByRole("button").click();
    const placedBox = page.locator('.od-input[data-col="placedAt"]');
    await expect(placedBox).toHaveValue(sameMoment(placed).slice(0, 16));
    // …and reads a typed time on it: 00:30 yesterday is 00:30 UTC — early on the UTC day, still the day before
    // in Los Angeles.
    await placedBox.fill(yesterday + "T00:30");
    // The due date, a plain day: today.
    await page.locator(".od-due").fill(today);
    await page.locator("#odSave").click();
    await expect(toast(page)).toContainText(`Dates saved for ${id}.`);
    let o = await serverOrder(api, shop, id);
    expect(sameMoment(o.placedAt)).toBe(yesterday + "T00:30:00.000Z");
    expect(o.dueDate).toBe(today);
    // The order date is shown as the business's day it fell on, and the due date as written (not the day before).
    await expect(orderRow(page, id).locator("td[data-date-td]")).toContainText(mdy(yesterday));
    await expect(orderRow(page, id).locator("td[data-due-td]")).toContainText(mdy(today));

    // Steps recorded at a typed time land at that time on the business's clock.
    await actionCell(page, id).getByRole("button", { name: "Mark as paid" }).click();
    await confirmAt(page, yesterday + "T00:40");
    await expect(actionCell(page, id).getByRole("button", { name: "Mark as paid" })).toHaveCount(0);
    const stage = actionCell(page, id).locator("select");
    await expect(stage.locator("option", { hasText: /^digitizing complete$/ })).toHaveCount(1);
    await stage.selectOption({ label: "digitizing complete" });
    await confirmAt(page, yesterday + "T00:50");
    await expect(stageCell(page, id, "digitizingCompleteAt")).toContainText(mdy(yesterday));
    o = await serverOrder(api, shop, id);
    expect(sameMoment(o.paidAt)).toBe(yesterday + "T00:40:00.000Z");
    expect(sameMoment(o.digitizingCompleteAt)).toBe(yesterday + "T00:50:00.000Z");

    // The whole-day filter: the order is found under yesterday (its UTC day)…
    await setRange(page, yesterday, yesterday);
    await expect(orderRow(page, id)).toBeVisible();
    // …and under neither the day before (its day in Los Angeles) nor today.
    await setRange(page, addDays(today, -2), addDays(today, -2));
    await expect(orderRow(page, id)).toHaveCount(0);
    await setRange(page, today, today);
    await expect(orderRow(page, id)).toHaveCount(0);

    // Due today on Run Order's list, not "due in 1 day" (the browser's day is yesterday).
    await expectDueChip(page, id, `⏱ Due ${today} · due today`);
  });

  test("a page left open over the business's midnight moves the Orders range to the new day on Refresh", async ({ page, api }) => {
    test.skip(nearUtcMidnight(), "too close to UTC midnight: the day would change during the test");
    const shop = await makeShop(api, { prefix: "tzroll" });
    const today = isoDay(Date.now());
    const yesterday = addDays(today, -1);
    // 23:50 UTC yesterday — 15:50 or 16:50 the day before in Los Angeles, and still that day 20 minutes later:
    // only the business's midnight falls in between.
    const before = Date.parse(yesterday + "T23:50:00Z");
    await page.clock.setFixedTime(before);
    await ordersPage(page, shop);
    await expect(page.locator("#ordFilterTo")).toHaveValue(yesterday);
    await expect(page.locator("#ordFilterFrom")).toHaveValue(addDays(yesterday, -30));

    await page.clock.setFixedTime(before + 20 * 60000);
    expect(await browserToday(page)).toBe(addDays(today, -1));   // the browser's own day hasn't changed
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await waitIdle(page);
    await expect(page.locator("#ordFilterTo")).toHaveValue(today);
    await expect(page.locator("#ordFilterFrom")).toHaveValue(addDays(today, -30));
  });
});
