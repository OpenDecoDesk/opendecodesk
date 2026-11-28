// Fundraising (migrations/0110): what each role may do with it (reports.fundraising, catalog.shops and finance.expenses
// in functions/_lib/permissions.js; the checks in functions/api/orders.js; the page, the shop form's Fundraiser
// section and Record payout… in public/admin.js).
//   - Manager (Full everywhere it matters): Reports → Fundraising right after Sales tax report, the report, Record
//     payout… (the amount starts at what is still owed), and the shop form's Fundraiser section, saved with the shop.
//   - Back office (Fundraising at Read, no Expenses, no shop setup): the report without Record payout, a note that
//     recording one needs Edit on Expenses, no shop form, and the server refuses setting a fundraiser or a payout.
//   - Read only (Read on everything): the report without Record payout, the Fundraiser section greyed out with no
//     Save, and the server refuses both writes.
//   - Production (no Fundraising): no menu item, no page, no shop form, and the server refuses all four actions.
//   - A role with Fundraising at Read and Expenses at Edit but without "Money, costs and margins": it records a payout
//     through the page, and its audit log keeps the payout's row without the amount (the owner's has it); the
//     fundraiser's own change is not money and keeps its detail.
// Bookkeeping is on in a fresh install and is not switched here. Every shop, order, payout and role is this file's own;
// the payouts (expenses) are deleted again at the end of each test.
import crypto from "node:crypto";
import { request as playwrightRequest } from "@playwright/test";
import { test, expect, ADMIN, openAdmin, toast, waitIdle, signInThroughPage, callApi, apiContext, freshIp, slug, uniq } from "../fixtures.mjs";
import { makeShop, placeOrder } from "../lib/data.mjs";

// ---- helpers ---------------------------------------------------------------------------------------------
const USERS = { path: "/api/admin-users" };
const FN = "reports.fundraising";
const NO_ROLE = "Your role can't do this. Ask an admin.";
const ACTIONS = ["getFundraisingReport", "listFundraiserPayouts", "setOrgFundraiser", "recordFundraiserPayout"];
const NEEDS_EXPENSES = "Recording a payout needs Edit on Expenses (Users → Roles and permissions).";
const utcToday = () => new Date().toISOString().slice(0, 10);   // the suite's install keeps its time zone at UTC
const yearStart = () => utcToday().slice(0, 4) + "-01-01";

const nav = (page) => page.getByRole("navigation", { name: "Admin" });
// The Reports menu's items on the desktop row, in order (their data-h).
const reportItems = (page) => nav(page).locator(".admin-nav-row .admin-nav-group").filter({ has: page.locator('button.admin-nav-drop', { hasText: /^Reports$/ }) })
  .locator(".admin-nav-menu button[data-h]").evaluateAll(els => els.map(e => e.dataset.h));
const navItem = (page) => nav(page).locator('.admin-nav-row button[data-h="fundraising"]');
const tryApi = (ctx, action, body) => callApi(ctx, action, body, { allowError: true, withStatus: true });
const refused = (r, what) => {
  expect(r.status, what + " is refused: " + JSON.stringify(r.data)).toBe(403);
  expect(r.data.status, what).toBe("error");
  expect(r.data.message, what).toBe(NO_ROLE);
};
const ok200 = (r, what) => {
  expect(r.status, what + ": " + JSON.stringify(r.data)).toBe(200);
  expect(r.data.status, what).toBe("ok");
};
const notAvailable = async (page, roleName) => {
  await expect(page.locator("#roleOffPanel")).toContainText("Not available to you.");
  await expect(page.locator("#roleOffPanel")).toContainText(`Your role (${roleName}) doesn't include this page.`);
};

// The request each action takes for `shop`.
const bodies = (shop, accountId) => ({
  getFundraisingReport: { dateFrom: yearStart(), dateTo: utcToday(), org: shop.orgId },
  listFundraiserPayouts: { org: shop.orgId },
  setOrgFundraiser: { org: shop.orgId, fundraiser: { mode: "percent", percent: 25, label: "Never set", showOnShop: true } },
  recordFundraiserPayout: { org: shop.orgId, amount: 1, date: utcToday(), accountId, note: "Never recorded" },
});

// A shop with a $2-per-piece fundraiser for its own "Example Boosters …", and one $20 order placed on the shop's page,
// paid and shipped today (the report counts paid orders on their sale date, shipped by default): it raised $2.00.
async function fundraisingShop(api, as, prefix) {
  const shop = await makeShop(api, { prefix, products: [{ name: "Sample Tee", price: 20 }] });
  shop.label = uniq("Example Boosters");
  const set = await api("setOrgFundraiser", { org: shop.orgId, fundraiser: { mode: "perPiece", amount: 2, label: shop.label, showOnShop: false } });
  expect(set.fundraiser).toEqual({ mode: "perPiece", amount: 2, label: shop.label, showOnShop: false });
  const customer = await as(null);
  shop.order = await placeOrder(customer, shop, { customer: uniq("Pat Example"), email: slug("fr") + "@example.com" });
  await customer.close();
  await api("markPaidManual", { org: shop.orgId, orderId: shop.order.orderId, requestId: slug("pay") });
  await api("setOrderDates", { org: shop.orgId, orderId: shop.order.orderId, dates: { shippedAt: new Date().toISOString() } });
  const rep = await api("getFundraisingReport", { dateFrom: yearStart(), dateTo: utcToday(), org: shop.orgId });
  expect(rep.shops).toHaveLength(1);
  expect(rep.shops[0]).toMatchObject({ orgId: shop.orgId, label: shop.label, orders: 1, pieces: 1, raised: 2, paidOut: 0, owed: 2 });
  return shop;
}
const businessChecking = async (api) => (await api("listAccounts")).accounts.find(a => a.name === "Business checking" && a.active);
const payoutsOf = async (api, shop) => (await api("listFundraiserPayouts", { org: shop.orgId })).payouts;
const fundraiserOf = async (api, shop) => ((await api("listOrgsAdmin")).orgs.find(o => o.orgId === shop.orgId) || {}).fundraiser;
const deletePayouts = async (api, shop) => {
  for (const p of await payoutsOf(api, shop).catch(() => [])) await api("deleteExpense", { expenseId: p.id }, { allowError: true });
};

// Reports → Fundraising for one shop: the shop's row of the per-shop table.
async function openReport(page, shop) {
  await openAdmin(page, "fundraising");
  await expect(page).toHaveTitle(/Fundraising/);
  await expect(page.locator("#frFilters")).toBeVisible();
  await page.locator("#frOrg").selectOption(shop.orgId);
  const row = page.locator("#frShops tbody tr", { hasText: shop.name });
  await expect(row).toBeVisible();
  await expect(page.locator("#frShops tbody tr")).toHaveCount(1);
  return row;
}
// Orders, Pieces, Sales, Raised, Paid out, Still owed: the 2nd to 7th cells.
async function expectShopRow(row, { paidOut, owed }) {
  const cells = row.locator("td");
  await expect(cells.nth(1)).toHaveText("1");
  await expect(cells.nth(2)).toHaveText("1");
  await expect(cells.nth(3)).toHaveText("$20.00");
  await expect(cells.nth(4)).toHaveText("$2.00");
  await expect(cells.nth(5)).toHaveText(paidOut);
  await expect(cells.nth(6)).toHaveText(owed);
}
// What a role that may look but not pay sees: the report, its order, Export CSV, no Record payout and the note.
async function expectReportWithoutPayout(page, shop) {
  const row = await openReport(page, shop);
  await expectShopRow(row, { paidOut: "—", owed: "$2.00" });
  await expect(row).toContainText("Supports " + shop.label);
  await expect(page.locator("#frShops thead th")).toHaveCount(7);
  await expect(page.getByRole("button", { name: "Record payout…" })).toHaveCount(0);
  await expect(page.locator("#frResults")).toContainText(NEEDS_EXPENSES);
  await expect(page.locator("#frOrders tbody tr", { hasText: shop.order.orderId })).toBeVisible();
  await expect(page.getByRole("button", { name: "Export CSV" })).toBeVisible();
  await expect(page.locator("#frPayouts")).toContainText("No payouts in this range.");
}

// ---- Manager ------------------------------------------------------------------------------------------------------
test("Manager: Fundraising after Sales tax report, records a payout from the report and changes the shop's fundraiser in its form", async ({ api, as }, testInfo) => {
  const shop = await fundraisingShop(api, as, "frm");
  const checking = await businessChecking(api);
  try {
    const mp = await as("manager");
    await openAdmin(mp, "home");
    const items = await reportItems(mp);
    expect(items.indexOf("fundraising"), "Fundraising sits right after Sales tax report").toBe(items.indexOf("salestax") + 1);
    await nav(mp).getByRole("button", { name: "Reports ▾" }).click();
    await navItem(mp).click();
    await expect(mp).toHaveURL(/#fundraising$/);

    // The report, with Record payout… on the shop's row and no note.
    const row = await openReport(mp, shop);
    await expectShopRow(row, { paidOut: "—", owed: "$2.00" });
    await expect(mp.locator("#frShops thead th")).toHaveCount(8);
    await expect(mp.locator("#frResults")).not.toContainText(NEEDS_EXPENSES);
    await expect(row.getByRole("button", { name: "Record payout…" })).toBeVisible();

    // Record payout…: the amount starts at what is owed, the account is chosen, then saved.
    await row.getByRole("button", { name: "Record payout…" }).click();
    const dlg = mp.locator(".admin-modal");
    await expect(dlg.locator("h3")).toHaveText("Record payout — " + shop.name);
    await expect(dlg).toContainText("Money you paid to " + shop.label);
    await expect(dlg.locator("#frpAmount")).toHaveValue("2.00");
    await expect(dlg.locator("#frpDate")).toHaveValue(utcToday());
    const note = uniq("Check 1042");
    await dlg.locator("#frpAccount").selectOption(String(checking.id));
    await dlg.locator("#frpNote").fill(note);
    const sent = mp.waitForRequest(r => r.url().endsWith("/api/orders") && (r.postDataJSON() || {}).action === "recordFundraiserPayout");
    await dlg.locator("#frpSave").click();
    expect((await sent).postDataJSON()).toMatchObject({ org: shop.orgId, amount: 2, date: utcToday(), accountId: checking.id, note });
    await expect(toast(mp)).toContainText("Payout of $2.00 recorded for " + shop.label + ".");
    await expect(dlg).toHaveCount(0);
    // The report again: paid out, nothing owed, and the payout listed.
    await expectShopRow(mp.locator("#frShops tbody tr", { hasText: shop.name }), { paidOut: "$2.00", owed: "—" });
    const payRow = mp.locator("#frPayouts tbody tr");
    await expect(payRow).toHaveCount(1);
    await expect(payRow).toContainText("$2.00");
    await expect(payRow).toContainText("Business checking");
    await expect(payRow).toContainText(note);
    const payouts = await payoutsOf(api, shop);
    expect(payouts).toHaveLength(1);
    expect(payouts[0]).toMatchObject({ amount: 2, date: utcToday(), accountId: checking.id, orgId: shop.orgId });

    // The Manager's session: the reads answer, a payout goes through.
    const ctx = await apiContext("manager", testInfo.workerIndex);
    try {
      let r = await tryApi(ctx, "getFundraisingReport", bodies(shop).getFundraisingReport);
      ok200(r, "getFundraisingReport");
      expect(r.data.shops[0]).toMatchObject({ orgId: shop.orgId, paidOut: 2, owed: 0 });
      r = await tryApi(ctx, "listFundraiserPayouts", { org: shop.orgId });
      ok200(r, "listFundraiserPayouts");
      expect(r.data.payouts.map(p => p.id)).toEqual([payouts[0].id]);
      r = await tryApi(ctx, "recordFundraiserPayout", bodies(shop, checking.id).recordFundraiserPayout);
      ok200(r, "recordFundraiserPayout");
      expect(r.data.id).toBeTruthy();
    } finally {
      await ctx.dispose();
    }
    expect((await payoutsOf(api, shop)).length).toBe(2);

    // The shop form: the Fundraiser section is the Manager's to change; Save changes sends it.
    await openAdmin(mp, "catalog/orgs/" + shop.orgId + "/edit");
    const box = mp.locator("#orgFormFundraiser");
    await expect(box.locator("#orgFrMode")).toBeEnabled();
    await expect(box.locator("#orgFrMode")).toHaveValue("perPiece");
    await expect(box.locator("#orgFrAmount")).toHaveValue("2.00");
    await expect(box.locator("#orgFrLabel")).toHaveValue(shop.label);
    await expect(box.locator("#orgFrShow")).not.toBeChecked();
    await box.locator("#orgFrMode").selectOption("percent");
    await box.locator("#orgFrAmount").fill("10");
    await box.locator("#orgFrShow").check();
    await expect(box.locator("#orgFrPreview")).toHaveText("The shop shows: “10% of every purchase supports " + shop.label + ".”");
    const saveFr = mp.waitForRequest(r => r.url().endsWith("/api/orders") && (r.postDataJSON() || {}).action === "setOrgFundraiser");
    await mp.getByRole("button", { name: "Save changes" }).click();
    expect((await saveFr).postDataJSON()).toMatchObject({ org: shop.orgId, fundraiser: { mode: "percent", percent: 10, label: shop.label, showOnShop: true } });
    await expect.poll(() => fundraiserOf(api, shop)).toEqual({ mode: "percent", percent: 10, label: shop.label, showOnShop: true });
  } finally {
    await deletePayouts(api, shop);
  }
});

// ---- Back office ------------------------------------------------------------------------------------------------
test("Back office: reads the report without Record payout, has no shop form, and the server refuses a fundraiser or a payout", async ({ api, as }, testInfo) => {
  const shop = await fundraisingShop(api, as, "frb");
  const checking = await businessChecking(api);
  try {
    const sp = await as("staff");
    await openAdmin(sp, "home");
    expect(await reportItems(sp)).toContain("fundraising");
    await expectReportWithoutPayout(sp, shop);
    // The order's number opens it (Back office may open Orders).
    await expect(sp.locator("#frOrders tbody tr").getByRole("button", { name: shop.order.orderId })).toBeVisible();
    // No shop setup for Back office: the shop form isn't theirs.
    await openAdmin(sp, "catalog/orgs/" + shop.orgId + "/edit");
    await notAvailable(sp, "Back office");
    await expect(sp.locator("#orgFormFundraiser")).toHaveCount(0);

    const ctx = await apiContext("staff", testInfo.workerIndex);
    try {
      const b = bodies(shop, checking.id);
      let r = await tryApi(ctx, "getFundraisingReport", b.getFundraisingReport);
      ok200(r, "getFundraisingReport");
      expect(r.data.shops[0]).toMatchObject({ orgId: shop.orgId, raised: 2, owed: 2 });
      r = await tryApi(ctx, "listFundraiserPayouts", b.listFundraiserPayouts);
      ok200(r, "listFundraiserPayouts");
      expect(r.data.payouts).toEqual([]);
      refused(await tryApi(ctx, "setOrgFundraiser", b.setOrgFundraiser), "setOrgFundraiser");
      refused(await tryApi(ctx, "setOrgFundraiser", { org: shop.orgId, fundraiser: null }), "setOrgFundraiser to none");
      refused(await tryApi(ctx, "recordFundraiserPayout", b.recordFundraiserPayout), "recordFundraiserPayout");
    } finally {
      await ctx.dispose();
    }
    expect(await fundraiserOf(api, shop)).toEqual({ mode: "perPiece", amount: 2, label: shop.label, showOnShop: false });
    expect(await payoutsOf(api, shop)).toEqual([]);
  } finally {
    await deletePayouts(api, shop);
  }
});

// ---- Read only ----------------------------------------------------------------------------------------------------
test("Read only: reads the report and exports it, sees the shop's Fundraiser greyed out with no Save, and the server refuses both writes", async ({ api, as }, testInfo) => {
  // The suite's setup gives its Read only role Read on every function the server lists, this one included.
  const mine = (await api("listRoles", {}, USERS)).roles.find(r => r.name === "Read only");
  expect(mine.permissions.fns[FN]).toBe("read");
  expect(mine.permissions.fns["finance.expenses"]).toBe("read");
  const shop = await fundraisingShop(api, as, "frr");
  const checking = await businessChecking(api);
  try {
    const vp = await as("viewer");
    await openAdmin(vp, "home");
    expect(await reportItems(vp)).toContain("fundraising");
    await expectReportWithoutPayout(vp, shop);
    const download = vp.waitForEvent("download");
    await vp.getByRole("button", { name: "Export CSV" }).click();
    expect((await download).suggestedFilename()).toBe(`fundraising-${shop.orgId}-${yearStart()}-to-${utcToday()}.csv`);

    // The shop form opens to read: the Fundraiser section shows what is set, every field greyed out, no Save.
    await openAdmin(vp, "catalog/orgs/" + shop.orgId + "/edit");
    const box = vp.locator("#orgFormFundraiser");
    await expect(box.locator("#orgFrMode")).toHaveValue("perPiece");
    await expect(box.locator("#orgFrLabel")).toHaveValue(shop.label);
    for (const f of ["#orgFrMode", "#orgFrAmount", "#orgFrLabel", "#orgFrShow"]) await expect(box.locator(f), f + " is read-only").toBeDisabled();
    await expect(vp.getByRole("button", { name: "Save changes" })).toBeHidden();

    const ctx = await apiContext("viewer", testInfo.workerIndex);
    try {
      const b = bodies(shop, checking.id);
      ok200(await tryApi(ctx, "getFundraisingReport", b.getFundraisingReport), "getFundraisingReport");
      ok200(await tryApi(ctx, "listFundraiserPayouts", b.listFundraiserPayouts), "listFundraiserPayouts");
      refused(await tryApi(ctx, "setOrgFundraiser", b.setOrgFundraiser), "setOrgFundraiser");
      refused(await tryApi(ctx, "recordFundraiserPayout", b.recordFundraiserPayout), "recordFundraiserPayout");
    } finally {
      await ctx.dispose();
    }
    expect(await fundraiserOf(api, shop)).toEqual({ mode: "perPiece", amount: 2, label: shop.label, showOnShop: false });
    expect(await payoutsOf(api, shop)).toEqual([]);
  } finally {
    await deletePayouts(api, shop);
  }
});

// ---- Production -----------------------------------------------------------------------------------------------------
test("Production: no Fundraising in the menu, no report page or shop form, and the server refuses all four actions", async ({ api, as }, testInfo) => {
  const shop = await fundraisingShop(api, as, "frp");
  const checking = await businessChecking(api);
  try {
    const pp = await as("production");
    await openAdmin(pp, "home");
    await expect(nav(pp).locator('[data-h="fundraising"]')).toHaveCount(0);
    await openAdmin(pp, "fundraising");
    await notAvailable(pp, "Production");
    await expect(pp.locator("#frFilters")).toHaveCount(0);
    await openAdmin(pp, "catalog/orgs/" + shop.orgId + "/edit");
    await notAvailable(pp, "Production");
    await expect(pp.locator("#orgFormFundraiser")).toHaveCount(0);

    const ctx = await apiContext("production", testInfo.workerIndex);
    try {
      const b = bodies(shop, checking.id);
      for (const a of ACTIONS) refused(await tryApi(ctx, a, b[a]), a);
    } finally {
      await ctx.dispose();
    }
    expect(await fundraiserOf(api, shop)).toEqual({ mode: "perPiece", amount: 2, label: shop.label, showOnShop: false });
    expect(await payoutsOf(api, shop)).toEqual([]);
  } finally {
    await deletePayouts(api, shop);
  }
});

// ---- A role without "Money, costs and margins" -----------------------------------------------------------------------
const strongPassword = () => "Fund-" + crypto.randomBytes(15).toString("base64url");
const client = (storageState, workerIndex) => playwrightRequest.newContext({ baseURL: ADMIN, storageState,
  extraHTTPHeaders: { Origin: ADMIN, "CF-Connecting-IP": freshIp(workerIndex) } });
async function searchAudit(page, shop, action) {
  await openAdmin(page, "audit");
  await page.locator("#afOrg").selectOption(shop.orgId);
  await page.locator("#afLimit").selectOption("200");
  await page.locator("#afAction").fill(action);
  await page.getByRole("button", { name: "Search" }).click();
  await waitIdle(page);
  return page.locator("#auditResults tbody tr");
}

test("A role with Fundraising and Expenses but not costs records a payout in the page; its audit log keeps the row, not the amount", async ({ page, api, as }, testInfo) => {
  test.setTimeout(120_000);
  const roleName = "Fund payer " + slug("f").slice(-6);
  const fns = { "home.counts": "read", [FN]: "read", "finance.expenses": "edit", "reports.audit": "read" };
  const role = (await api("saveRole", { name: roleName, rank: 20, permissions: { fns } }, USERS)).role;
  let userId = null, ctx = null, shop = null;
  try {
    expect(role.permissions.fns["costs.view"] || "none").toBe("none");
    const tag = slug("fp");
    const who = { email: tag + "@example.test", password: strongPassword() };
    const made = await api("create", { name: "Robin Payer " + tag.slice(-4), email: who.email, role: role.key }, USERS);
    userId = made.user.id;
    ctx = await client(undefined, testInfo.workerIndex);
    let res = await ctx.post("/api/admin-session", { data: { email: who.email, key: made.temporaryPassword } });
    expect((await res.json()).pending).toBe("password");
    res = await ctx.post("/api/admin-password", { data: { action: "change", current: made.temporaryPassword, next: who.password } });
    expect((await res.json()).status).toBe("ok");
    res = await ctx.post("/api/admin-session", { data: { email: who.email, key: who.password } });
    expect(res.status()).toBe(200);

    shop = await fundraisingShop(api, as, "frc");
    const checking = await businessChecking(api);
    // The server: Expenses at Edit is what a payout needs; the shop's fundraiser stays catalog.shops's.
    refused(await tryApi(ctx, "setOrgFundraiser", bodies(shop).setOrgFundraiser), "setOrgFundraiser without shop setup");

    // The page: the report with Record payout…, and a payout recorded through it.
    const cp = await as(null);
    await cp.goto(ADMIN + "/#fundraising");
    await signInThroughPage(cp, who);
    await expect(nav(cp)).toBeVisible();
    const row = await openReport(cp, shop);
    await expect(cp.locator("#frResults")).not.toContainText(NEEDS_EXPENSES);
    await row.getByRole("button", { name: "Record payout…" }).click();
    const dlg = cp.locator(".admin-modal");
    await expect(dlg.locator("#frpAmount")).toHaveValue("2.00");
    await dlg.locator("#frpAmount").fill("1.50");
    await dlg.locator("#frpAccount").selectOption(String(checking.id));
    const note = uniq("Spring season");
    await dlg.locator("#frpNote").fill(note);
    await dlg.locator("#frpSave").click();
    await expect(toast(cp)).toContainText("Payout of $1.50 recorded for " + shop.label + ".");
    await expectShopRow(cp.locator("#frShops tbody tr", { hasText: shop.name }), { paidOut: "$1.50", owed: "$0.50" });
    const payouts = await payoutsOf(api, shop);
    expect(payouts).toHaveLength(1);
    expect(payouts[0]).toMatchObject({ amount: 1.5, accountId: checking.id });

    // The audit log, the owner's and theirs: the payout's row with its amount for the owner, without it for them.
    const ownerRows = await searchAudit(page, shop, "fundraiser.payout_recorded");
    await expect(ownerRows).toHaveCount(1);
    await expect(ownerRows).toContainText("Fundraiser payout recorded");
    await expect(ownerRows).toContainText("$1.50 to " + shop.label);
    await expect(ownerRows).toContainText(note);
    const theirRows = await searchAudit(cp, shop, "fundraiser.payout_recorded");
    await expect(theirRows).toHaveCount(1);
    await expect(theirRows).toContainText("Fundraiser payout recorded");
    await expect(theirRows).not.toContainText("$");
    await expect(theirRows).not.toContainText(note);
    // The fundraiser's own setting isn't money: its detail stays for them.
    const setRows = await searchAudit(cp, shop, "org.fundraiser_set");
    await expect(setRows).toHaveCount(1);
    await expect(setRows).toContainText("none → $2.00 of every item supports " + shop.label);

    // The same from the API.
    const theirs = await client(await cp.context().storageState(), testInfo.workerIndex);
    try {
      const ask = { orgId: shop.orgId, filter: "fundraiser.payout_recorded", limit: 50 };
      const o = await api("getAuditLog", ask);
      expect(o.entries).toHaveLength(1);
      expect(o.entries[0].detail).toMatchObject({ expenseId: payouts[0].id, amount: 1.5, accountId: checking.id, note, label: shop.label });
      const t = await callApi(theirs, "getAuditLog", ask);
      expect(t.entries).toHaveLength(1);
      expect(t.entries[0]).toMatchObject({ id: o.entries[0].id, action: "fundraiser.payout_recorded", detail: null });
      const s = await callApi(theirs, "getAuditLog", { orgId: shop.orgId, filter: "org.fundraiser_set", limit: 50 });
      expect(s.entries[0].detail).toMatchObject({ from: null, to: { mode: "perPiece", amount: 2, label: shop.label } });
    } finally {
      await theirs.dispose();
    }
  } finally {
    if (ctx) await ctx.dispose();
    if (shop) await deletePayouts(api, shop);
    if (userId) {
      await api("setRole", { id: userId, role: "production" }, { ...USERS, allowError: true });
      await api("setStatus", { id: userId, status: "disabled" }, { ...USERS, allowError: true });
    }
    await api("deleteRole", { roleKey: role.key }, { ...USERS, allowError: true });
    expect((await api("listRoles", {}, USERS)).roles.filter(r => r.key === role.key), "this test's role is gone again").toEqual([]);
  }
});
