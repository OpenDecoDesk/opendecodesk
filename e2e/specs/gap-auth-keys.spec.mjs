// Two sign-in rules the unit tests check and no browser-level test did (coverage review, P2 and P3):
//   - the installer's setup passphrase is the way in to a new install through the sign-in page only. Sent with an
//     API request — as `key` in the body, as the X-Admin-Key header, with a picture upload — it opens nothing.
//   - failed sign-ins are counted per account (under a hash of the email typed) as well as per address and for
//     the whole install. Past 10 for one account in the 15-minute window, a sign-in to it is held up (this
//     install has no Turnstile keys, so it is refused until the window ends) — even with the right password, and
//     from an address that signed in here lately too (such an address skips only the install-wide budget). Other
//     accounts are not held up.
//
// The users this spec signs in as are its own, made here. P3's ten wrong passwords are the only failed sign-ins it
// sends: they spend 10 of the install's 100-per-15-minutes budget of failed sign-ins (which every spec's sign-ins
// draw on), and nothing else here counts toward it. P2's refusals are API requests without a session, which only
// count against their own address's per-minute limit.
import fs from "node:fs";
import crypto from "node:crypto";
import { request as playwrightRequest } from "@playwright/test";
import { test, expect, ADMIN, apiContext, callApi, freshIp, slug, pngBytes } from "../fixtures.mjs";
import { DEV_VARS } from "../lib/install.mjs";
import { makeShop } from "../lib/data.mjs";

// The setup passphrase of this install, from the secrets e2e/lib/install.mjs generated for it (as first-run reads it).
const passphrase = () => /PROXY_ADMIN_PASSPHRASE="([^"]+)"/.exec(fs.readFileSync(DEV_VARS, "utf8"))[1];
const strongPassword = () => "Gap-" + crypto.randomBytes(15).toString("base64url");

// A request context that is a browser of its own: the given client address (a fresh one by default), the admin's
// Origin header the page sends, and no cookie unless a saved state is given.
const client = (ip, storageState) => playwrightRequest.newContext({ baseURL: ADMIN, storageState,
  extraHTTPHeaders: { Origin: ADMIN, "CF-Connecting-IP": ip } });

// A user of `role` made by the owner, with the temporary password replaced as at a first sign-in (as auth.spec's
// makeUser). Its sign-ins succeed, so they spend nothing. Returns { id, email, password, name }.
async function makeUser(api, role, label, workerIndex) {
  const tag = slug("g");
  const name = (label || "Gil Gap") + " " + tag.slice(-4);
  const email = tag + "@example.test";
  const made = await api("create", { name, email, role }, { path: "/api/admin-users" });
  const c = await client(freshIp(workerIndex));
  let r = await c.post("/api/admin-session", { data: { email, key: made.temporaryPassword } });
  expect((await r.json()).pending).toBe("password");
  const password = strongPassword();
  r = await c.post("/api/admin-password", { data: { action: "change", current: made.temporaryPassword, next: password } });
  expect((await r.json()).status).toBe("ok");
  await c.dispose();
  return { id: made.user.id, email, password, name };
}

// One sign-in POST from a client of its own at `ip`: { status, body, cookie } (cookie: the Set-Cookie it sent, if any).
async function signIn(ip, email, password) {
  const c = await client(ip);
  const r = await c.post("/api/admin-session", { data: { email, key: password } });
  let body = null;
  try { body = await r.json(); } catch (e) { body = null; }
  const cookie = r.headersArray().filter(h => h.name.toLowerCase() === "set-cookie").map(h => h.value).join("\n");
  await c.dispose();
  return { status: r.status(), body, cookie, retryAfter: r.headers()["retry-after"] };
}

// A client address in 10.251.x.y: freshIp never makes one there (its second number is 1–250), so no other test's
// browser is ever on it.
const knownIp = () => "10.251." + (crypto.randomInt(250) + 1) + "." + (crypto.randomInt(250) + 1);

test.describe("the setup passphrase is no API key", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("sent as body key, X-Admin-Key or with an upload, the passphrase opens nothing; the owner's cookie does", async ({ api }, testInfo) => {
    const key = passphrase();
    expect(key).toMatch(/^e2e-setup-/);
    const shop = await makeShop(api, { publish: false, products: [], prefix: "keyshop" });
    const png = pngBytes(16, 16);

    // From a client with no cookie: every way the passphrase could be sent as a key is answered 401, and no
    // session is handed out on the way.
    const anon = await client(freshIp(testInfo.workerIndex));
    const refusals = {
      "listOrgs, key in the body": await anon.post("/api/orders", { data: { action: "listOrgs", key } }),
      "listOrgs, X-Admin-Key header": await anon.post("/api/orders", { data: { action: "listOrgs" }, headers: { "X-Admin-Key": key } }),
      "admin-users list, key in the body": await anon.post("/api/admin-users", { data: { action: "list", key } }),
      "upload, X-Admin-Key header": await anon.post("/api/upload?org=" + shop.orgId, { data: png, headers: { "Content-Type": "image/png", "X-Admin-Key": key } }),
    };
    for (const [what, r] of Object.entries(refusals)) {
      expect(r.status(), what).toBe(401);
      const body = await r.json();
      expect(body.status, what).toBe("error");
      expect(body.message, what).toBe("Unauthorized");
      expect(JSON.stringify(body), what + ": nothing of the install comes back").not.toContain(shop.orgId);
      expect(body.url, what).toBeUndefined();
      expect(r.headers()["set-cookie"], what + ": no session").toBeUndefined();
    }
    // The browser of the client is still not signed in: nothing was stored for it.
    expect((await anon.storageState()).cookies).toEqual([]);
    await anon.dispose();

    // The same requests with the owner's signed-in cookie (and no key) are answered: the refusals above were the
    // credential's, not the shape of the request's.
    const owner = await apiContext("owner", testInfo.workerIndex);
    const orgs = await callApi(owner, "listOrgs");
    expect(orgs.orgs.map(o => o.orgId)).toContain(shop.orgId);
    const users = await callApi(owner, "list", {}, { path: "/api/admin-users" });
    expect(users.users.length).toBeGreaterThan(0);
    const up = await owner.post("/api/upload?org=" + shop.orgId, { data: png, headers: { "Content-Type": "image/png" } });
    expect(up.status()).toBe(200);
    const upBody = await up.json();
    expect(upBody.status).toBe("ok");
    expect(upBody.url).toContain("/uploads/" + shop.orgId + "/");
    await owner.dispose();
  });
});

test.describe("the per-account sign-in budget", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("past 10 failed sign-ins one account is held up from every address, one that signed in lately included; other accounts are not", async ({ api }, testInfo) => {
    // The failure counts run in fixed 15-minute windows (from the epoch, on the server's clock — this computer's).
    // Ten failures and the checks after them take a few seconds; if the window is about to turn, wait for the new
    // one, or the count would start again half-way.
    const WINDOW = 15 * 60;
    const left = WINDOW - (Math.floor(Date.now() / 1000) % WINDOW);
    test.setTimeout(120_000 + (left < 45 ? left * 1000 : 0));
    if (left < 45) await new Promise(r => setTimeout(r, (left + 1) * 1000));

    const u = await makeUser(api, "production", "Una Budget", testInfo.workerIndex);
    const other = await makeUser(api, "production", "Otto Other", testInfo.workerIndex);

    // U signs in once from an address of its own: that address is now one that signed in lately.
    const known = knownIp();
    const first = await signIn(known, u.email, u.password);
    expect(first.status).toBe(200);
    expect(first.cookie).toMatch(/HttpOnly.*Max-Age=86400/);

    // Ten wrong passwords for U, each from an address that has never been seen (so no address's own limit is
    // reached): every one is checked and refused. These ten are the spec's whole spend of the install's budget.
    for (let i = 0; i < 10; i++) {
      const wrong = await signIn(freshIp(testInfo.workerIndex), u.email, u.password + "-wrong-" + i);
      expect(wrong.status, "wrong password #" + (i + 1)).toBe(401);
      expect(wrong.body.message).toBe("Unauthorized");
    }

    // U's account is spent. From yet another new address, U's RIGHT password is held up before it is checked:
    // 429, the plain "too many" answer (no Turnstile keys on this install, so no check is offered), no session.
    const held = await signIn(freshIp(testInfo.workerIndex), u.email, u.password);
    expect(held.status).toBe(429);
    expect(held.body.code).not.toBe("turnstile_required");
    expect(held.body.siteKey).toBeUndefined();
    expect(held.body.message).toMatch(/Too many requests/);
    expect(Number(held.retryAfter)).toBeGreaterThan(0);
    expect(held.cookie).toBe("");
    // The account is counted by the email as it is meant, not as typed: upper case and spaces around it are the
    // same account.
    const heldTyped = await signIn(freshIp(testInfo.workerIndex), "  " + u.email.toUpperCase() + " ", u.password);
    expect(heldTyped.status).toBe(429);
    expect(heldTyped.cookie).toBe("");
    // A wrong password from a new address is held up the same way — refused before it is checked, so it isn't
    // counted as another failure either.
    const heldWrong = await signIn(freshIp(testInfo.workerIndex), u.email, u.password + "-wrong-again");
    expect(heldWrong.status).toBe(429);

    // Only U's account is held up: another user signs in from a new address.
    const otherIn = await signIn(freshIp(testInfo.workerIndex), other.email, other.password);
    expect(otherIn.status).toBe(200);
    expect(otherIn.body.user.email).toBe(other.email);
    expect(otherIn.cookie).toMatch(/HttpOnly.*Max-Age=86400/);

    // The address U signed in from before is NOT let past an account's own budget (it skips only the install-wide
    // one): U's right password is held up there too, before it is checked…
    const back = await signIn(known, u.email, u.password);
    expect(back.status).toBe(429);
    expect(back.body.message).toMatch(/Too many requests/);
    expect(back.cookie).toBe("");
    // …while another account signs in from that same address.
    const otherThere = await signIn(known, other.email, other.password);
    expect(otherThere.status).toBe(200);
    expect(otherThere.body.user.email).toBe(other.email);
    expect(otherThere.cookie).toMatch(/HttpOnly.*Max-Age=86400/);
  });
});
