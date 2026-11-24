// List copies (review #53, migration 0102): the reference lists the admin asks for again and again (hoops,
// machines, threads, blanks, shops…) are kept by the page for the visit, each with the version number the server
// sent (public/admin.js listCacheAsk_ / listCacheTake_). Asking again sends that number as `cacheVersion`; while it
// is still current the server answers only `unchanged: true` and the page draws its copy, otherwise the new list
// and number replace the copy (functions/api/orders.js listAnswer_). Sign-out empties the copies
// (clearAdminAuth → listCacheClear_), so the next user on the same computer never sees the last one's lists.
//
// The rest of the suite opens every page with openAdmin, which always reloads, so a copy never survives into a
// later check there. These tests stay in ONE document (menu clicks only) to see the copies at work:
//   - a hoop saved elsewhere (the owner API) shows on the next ask, without a reload, and an ask with no change
//     in between gets `unchanged` and still draws the rows;
//   - after Sign out and another user's sign-in in the same document, the first listHoops / listMachines carry
//     no `cacheVersion`.
// The hoop is this test's own (unique name) and is deleted in `finally`; the user is made here.
import crypto from "node:crypto";
import { request as playwrightRequest } from "@playwright/test";
import { test, expect, ADMIN, openAdmin, navTo, signInThroughPage, readCredentials, freshIp, uniq, slug } from "../fixtures.mjs";

// ---- helpers ---------------------------------------------------------------------------------------------
// Records the page's POST /api/orders requests for `actions`, each with its answer once it has come.
function recordLists(page, actions) {
  const seen = [];
  page.on("request", (req) => {
    if (req.method() !== "POST" || new URL(req.url()).pathname !== "/api/orders") return;
    let body;
    try { body = JSON.parse(req.postData() || "{}"); } catch (e) { return; }
    if (!actions.includes(body.action)) return;
    const entry = { action: body.action, body, answer: undefined };
    entry.answered = req.response().then((r) => (r ? r.json() : null)).catch(() => null).then((j) => { entry.answer = j; return j; });
    seen.push(entry);
  });
  return seen;
}
// The first recorded request for `action` from index `from` on, once it has been answered.
async function firstAfter(seen, action, from) {
  const find = () => seen.slice(from).find((e) => e.action === action);
  await expect.poll(() => !!find(), { message: "a " + action + " request after #" + from }).toBe(true);
  const e = find();
  await e.answered;
  return e;
}

// A user of `role` made by the owner, temporary password already replaced (as auth.spec's makeUser).
async function makeUser(api, role, label) {
  const tag = slug("u");
  const email = tag + "@example.test";
  const made = await api("create", { name: label + " " + tag.slice(-4), email, role }, { path: "/api/admin-users" });
  const c = await playwrightRequest.newContext({ baseURL: ADMIN, extraHTTPHeaders: { Origin: ADMIN, "CF-Connecting-IP": freshIp(9) } });
  try {
    let r = await c.post("/api/admin-session", { data: { email, key: made.temporaryPassword } });
    expect((await r.json()).pending).toBe("password");
    const password = "Copies-" + crypto.randomBytes(15).toString("base64url");
    r = await c.post("/api/admin-password", { data: { action: "change", current: made.temporaryPassword, next: password } });
    expect((await r.json()).status).toBe("ok");
    return { email, password };
  } finally { await c.dispose(); }
}

const menu = (page) => page.getByRole("navigation", { name: "Admin" });
const hoopRows = (page) => page.locator("#hpBody tbody tr");

// ---- (a) a change made elsewhere ---------------------------------------------------------------------------
test("a hoop saved elsewhere shows on the next ask without a reload; an ask with no change gets 'unchanged' and still draws", async ({ page, api }) => {
  const seen = recordLists(page, ["listHoops"]);
  await openAdmin(page, "hoops");
  const first = await firstAfter(seen, "listHoops", 0);
  expect(first.body.cacheVersion, "a fresh page holds no copy").toBeUndefined();
  expect(first.answer.status).toBe("ok");
  const v1 = first.answer.version;
  expect(typeof v1).toBe("number");

  const name = uniq("Square Hoop");
  let hoopId = null;
  try {
    // The change, made somewhere else (the owner's API session, not this page).
    hoopId = (await api("saveHoop", { hoop: { name, widthMm: 120, heightMm: 120 } })).id;
    await page.evaluate(() => { window.__e2eSameDoc = 1; });

    // Machines asks for hoops too (its hoop boxes): the first ask after the change names the copy's version and
    // gets the new list, with a new version.
    const mark = seen.length;
    await navTo(page, "Production", "Machines");
    const changed = await firstAfter(seen, "listHoops", mark);
    expect(changed.body.cacheVersion).toBe(v1);
    expect(changed.answer.status).toBe("ok");
    expect(changed.answer.unchanged).toBeUndefined();
    expect(typeof changed.answer.version).toBe("number");
    expect(changed.answer.version).not.toBe(v1);
    expect(changed.answer.hoops.map((h) => h.name)).toContain(name);
    let v2 = changed.answer.version, count = changed.answer.hoops.length;

    // Back to Hoops by the menu: nothing changed since, so the answer is only "unchanged", and the page draws its
    // copy, the new hoop included. Other spec files running at the same time can add or remove a hoop in between;
    // then the answer is the new list (a later version), and the page asks again until one ask finds nothing new.
    let again = null;
    for (let tries = 0; tries < 5 && !(again && again.answer.unchanged); tries++) {
      if (again) {
        // Another file changed the hoops in between: take that list as the copy, go away and come back.
        v2 = again.answer.version; count = again.answer.hoops.length;
        const markM = seen.length;
        await navTo(page, "Production", "Machines");
        const viaMachines = await firstAfter(seen, "listHoops", markM);
        if (!viaMachines.answer.unchanged) { v2 = viaMachines.answer.version; count = viaMachines.answer.hoops.length; }
      }
      const mark2 = seen.length;
      await navTo(page, "Production", "Hoops");
      again = await firstAfter(seen, "listHoops", mark2);
      expect(again.body.cacheVersion).toBe(v2);
      expect(again.answer.status).toBe("ok");
      if (!again.answer.unchanged) {
        expect(again.answer.version, "a new list only when the hoops changed").toBeGreaterThan(v2);
        expect(again.answer.hoops.map((h) => h.name)).toContain(name);
      }
    }
    expect(again.answer).toMatchObject({ status: "ok", unchanged: true, version: v2 });
    expect(again.answer.hoops).toBeUndefined();
    await expect(page.getByRole("row", { name: new RegExp(name) })).toBeVisible();
    await expect(hoopRows(page)).toHaveCount(count);

    expect(await page.evaluate(() => window.__e2eSameDoc), "all in one document, no reload").toBe(1);
  } finally {
    if (hoopId) await api("deleteHoop", { id: hoopId }, { allowError: true });
  }
});

// ---- (b) sign-out clears the copies --------------------------------------------------------------------------
test.describe("signed in through the page", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("sign-out empties the list copies: the next user's first listHoops and listMachines carry no cacheVersion", async ({ page, api }) => {
    const next = await makeUser(api, "production", "Pia Copies");
    const seen = recordLists(page, ["listHoops", "listMachines"]);

    // Its own session (signing out ends it on the server; the shared owner session is left alone).
    await page.goto(ADMIN + "/");
    await signInThroughPage(page, readCredentials().users.owner);
    await expect(menu(page)).toBeVisible();
    await page.evaluate(() => { window.__e2eSameDoc = 1; });

    // Hoops, Machines, Hoops, Machines by the menu: by the second visit each list is asked for with its copy's version.
    await navTo(page, "Production", "Hoops");
    await navTo(page, "Production", "Machines");
    let mark = seen.length;
    await navTo(page, "Production", "Hoops");
    expect(typeof (await firstAfter(seen, "listHoops", mark)).body.cacheVersion, "a copy of the hoops is held").toBe("number");
    mark = seen.length;
    await navTo(page, "Production", "Machines");
    expect(typeof (await firstAfter(seen, "listMachines", mark)).body.cacheVersion, "a copy of the machines is held").toBe("number");

    // Sign out from the Settings menu, and sign in as someone else in the same document.
    await menu(page).getByRole("button", { name: "Settings ▾" }).click();
    await menu(page).getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Sign in" })).toBeVisible();
    await expect(menu(page)).toHaveCount(0);
    const signedOut = seen.length;
    await signInThroughPage(page, next);
    await expect(menu(page)).toBeVisible();

    await navTo(page, "Production", "Hoops");
    await expect(page.locator("#hpBody")).not.toContainText("Loading");
    await navTo(page, "Production", "Machines");
    expect(await page.evaluate(() => window.__e2eSameDoc), "still the same document: no reload in between").toBe(1);

    const hoops = await firstAfter(seen, "listHoops", signedOut);
    const machines = await firstAfter(seen, "listMachines", signedOut);
    expect(hoops.body.cacheVersion, "the last user's hoop copy is gone").toBeUndefined();
    expect(machines.body.cacheVersion, "the last user's machine copy is gone").toBeUndefined();
    // …so the answers are whole lists, not "unchanged".
    expect(hoops.answer.unchanged).toBeUndefined();
    expect(Array.isArray(hoops.answer.hoops)).toBe(true);
    expect(machines.answer.unchanged).toBeUndefined();
    expect(Array.isArray(machines.answer.machines)).toBe(true);
  });
});
