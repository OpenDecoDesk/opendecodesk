// The set-up step is closed once set up (review 52.3): POST /api/admin-password { action: "account" } is the
// "Finish setting up" step only (a name, an email and a password, for a session signed in with the setup
// passphrase or an owner from before there were users). A session that is already set up is refused it with
// code "already_set_up" (403), so a borrowed session can't swap the sign-in email and password without the
// current password (functions/api/admin-password.js). Nothing changes: the old sign-in still works, the new email
// signs nobody in, the user's name and email are as they were, and the session itself goes on working.
//
// The user here is this spec's own (Back office, unique name, made through the owner's session) and is disabled
// at the end. The shared users from the setup project are never used.
import crypto from "node:crypto";
import { request as playwrightRequest } from "@playwright/test";
import { test, expect, ADMIN, freshIp, slug } from "../fixtures.mjs";

const USERS = { path: "/api/admin-users" };
const strongPassword = () => "Desk-" + crypto.randomBytes(15).toString("base64url");

// A request context that is a browser of its own: its own address, the admin's Origin.
const client = (workerIndex) => playwrightRequest.newContext({ baseURL: ADMIN, extraHTTPHeaders: { Origin: ADMIN, "CF-Connecting-IP": freshIp(workerIndex) } });

// A user of `role` made by the owner, with the temporary password replaced as at a first sign-in.
// Returns { id, email, password, name }.
async function makeUser(api, role, label, workerIndex) {
  const tag = slug("sc");
  const name = label + " " + tag.slice(-4);
  const email = tag + "@example.test";
  const made = await api("create", { name, email, role }, USERS);
  const c = await client(workerIndex);
  let r = await c.post("/api/admin-session", { data: { email, key: made.temporaryPassword } });
  expect((await r.json()).pending).toBe("password");
  const password = strongPassword();
  r = await c.post("/api/admin-password", { data: { action: "change", current: made.temporaryPassword, next: password } });
  expect((await r.json()).status).toBe("ok");
  await c.dispose();
  return { id: made.user.id, email, password, name };
}

// Signs in from a client of its own: { ctx, status, body }.
async function signIn(email, password, workerIndex) {
  const ctx = await client(workerIndex);
  const r = await ctx.post("/api/admin-session", { data: { email, key: password } });
  return { ctx, status: r.status(), body: await r.json().catch(() => null) };
}

test("a signed-in user can't use Finish setting up to change their sign-in email and password", async ({ api }, testInfo) => {
  const w = testInfo.workerIndex;
  const U = await makeUser(api, "staff", "Sam Setupdone", w);
  const opened = [];
  try {
    // U signs in: set up, nothing pending.
    const s = await signIn(U.email, U.password, w);
    opened.push(s.ctx);
    expect(s.status).toBe(200);
    expect(s.body.status).toBe("ok");
    expect(s.body.pending).toBeFalsy();

    // The set-up step from that signed-in session, with a new name, email and password: refused.
    const newEmail = slug("newmail") + "@example.test";
    const newPassword = strongPassword();
    const r = await s.ctx.post("/api/admin-password", { data: { action: "account", name: "Not Changed", email: newEmail, next: newPassword } });
    expect(r.status()).toBe(403);
    const refused = await r.json();
    expect(refused.status).toBe("error");
    expect(refused.code).toBe("already_set_up");
    expect(refused.message).toBe("Your account is already set up. To change your password, use Settings → Change password.");

    // The session still works (the refusal didn't sign it out), and is still U's, with nothing pending.
    const st = await s.ctx.post("/api/admin-password", { data: { action: "status" } });
    expect(st.status()).toBe(200);
    const status = await st.json();
    expect(status.user.email).toBe(U.email);
    expect(status.user.name).toBe(U.name);
    expect(status.pending).toBeNull();

    // The owner's list agrees: U's name and email are as they were, and no user has the new email.
    const users = (await api("list", {}, USERS)).users;
    const u = users.find(x => x.id === U.id);
    expect(u.email).toBe(U.email);
    expect(u.name).toBe(U.name);
    expect(users.map(x => x.email)).not.toContain(newEmail);

    // The old sign-in still works; the new email with the new password signs nobody in…
    const again = await signIn(U.email, U.password, w);
    opened.push(again.ctx);
    expect(again.status).toBe(200);
    expect(again.body.status).toBe("ok");
    const wrong = await signIn(newEmail, newPassword, w);
    opened.push(wrong.ctx);
    expect(wrong.status).toBe(401);
    expect(wrong.body.status).toBe("error");
    // …nor does U's own email with the password the refused request carried.
    const wrongPw = await signIn(U.email, newPassword, w);
    opened.push(wrongPw.ctx);
    expect(wrongPw.status).toBe(401);
  } finally {
    for (const c of opened) await c.dispose();
    await api("setStatus", { id: U.id, status: "disabled" }, { ...USERS, allowError: true });
  }
});
