const { makeAuth, request, answer, read } = require("./testlib/auth-harness");

// A "known" sign-in address and the failed-sign-in budgets (second review, 2026-11-25).
// An address that signed in here in the last 30 days used to skip BOTH the install-wide budget and the account's
// own: everyone behind an office's or a phone carrier's shared address — and any user, about any other user — could
// guess at one account's password held up only by the address's own share. Now such an address still skips the
// install-wide budget (the people who work here keep signing in while someone floods the sign-in page), and never
// the account's: once ten sign-ins for one account have failed in 15 minutes, that account is held up from every
// address, known or not (a Turnstile check where the keys are set, a wait where they aren't).
// The real sign-in code (testlib/auth-harness.js) with the real rate limiter on real SQL. Invented data only.

let failed = 0, passed = 0;
const ok = (label, cond) => { cond ? passed++ : failed++; console.log(label + ": " + !!cond); };

(async () => {
  // The budgets are counted in 15-minute windows by the clock, and this takes about a second: it doesn't start in a
  // window's last few seconds, so no count is split across two.
  const left = 900 - (Math.floor(Date.now() / 1000) % 900);
  if (left < 10) await new Promise(r => setTimeout(r, (left + 1) * 1000));
  let S = await makeAuth({ realLimits: true });
  await S.firstAdmin("Olive Owner", "olive@example.test", "correct horse battery");
  const admin = (await S.signIn("olive@example.test", "correct horse battery")).cookie;
  await S.addUser(admin, "staff", "Sam Staff", "sam@example.test", "sams own password");
  await S.addUser(admin, "staff", "Quinn Staff", "quinn@example.test", "quinns own password");
  // A clean slate, as a later quarter of an hour would be: no counts, and a new copy of the sign-in code on the same
  // database (the limiter also remembers, per running copy, which counters it has already seen full).
  const clear = async () => { S.d1._raw.run("DELETE FROM rate_limits"); S = await makeAuth({ d1: S.d1, realLimits: true }); };
  // Each address may also try only ten times a minute, whatever the answer (admin-session.js): the tests below are
  // about the 15-minute budgets, so that minute is let pass between tries.
  const nextMinute = () => S.d1._raw.run("DELETE FROM rate_limits WHERE key LIKE 'rl:admin_auth:%'");
  const post = async (ip, email, key, extra = {}) => { nextMinute(); return answer(await S.raw["/api/admin-session"].POST({ env: S.env,
    request: request("/api/admin-session", Object.assign({ email, key }, extra), { headers: { "cf-connecting-ip": ip } }) })); };
  const count = (like) => Number((S.d1.q("SELECT sum(count) n FROM rate_limits WHERE key LIKE ?", like)[0] || {}).n || 0);
  // Turnstile's answer, as Cloudflare would give it: a token "good-…" passes.
  const verified = [];
  global.fetch = async (url, init) => {
    if (String(url) !== "https://challenges.cloudflare.com/turnstile/v0/siteverify") throw new Error("unexpected fetch " + url);
    const token = init.body.get("response"); verified.push(token);
    return { json: async () => (/^good-/.test(token) ? { success: true } : { success: false, "error-codes": ["invalid-input-response"] }) };
  };
  await clear();
  const OFFICE = "203.0.113.7", STRANGER = "198.51.100.99";
  let r;

  console.log("=== From an address that signed in here lately ===");
  ok("the office's address signs in, and is known from then on", (await post(OFFICE, "quinn@example.test", "quinns own password")).status === 200 &&
    S.d1.q("SELECT count(*) n FROM rate_limits WHERE key LIKE 'rl:admin_known:%'")[0].n === 1);
  const tries = [];
  for (let i = 1; i <= 10; i++) tries.push((await post(OFFICE, "sam@example.test", "not sams password " + i)).status);
  ok("ten wrong passwords for one account from that address are each refused as wrong", tries.every(s => s === 401));
  ok("…and counted against that account", count("rl:admin_auth_acct:%") === 10);
  r = await post(OFFICE, "sam@example.test", "sams own password");
  ok("with the account's budget spent, the next try isn't checked — even the right password, even from the known address", r.status === 429 && !r.cookie);
  ok("…and a guess after that isn't counted or checked either", (await post(OFFICE, "sam@example.test", "another guess")).status === 429 && count("rl:admin_auth_acct:%") === 10);
  ok("another account still signs in from the same address", (r = await post(OFFICE, "quinn@example.test", "quinns own password")).status === 200 && !!r.cookie);
  ok("…and so does the owner", (await post(OFFICE, "olive@example.test", "correct horse battery")).status === 200);
  ok("the held-up account is held up from any other address too", (await post(STRANGER, "sam@example.test", "sams own password")).status === 429);
  ok("…however its email is typed", (await post(OFFICE, "  SAM@Example.test ", "sams own password")).status === 429);

  console.log("\n=== With Turnstile keys: a check instead of a wait ===");
  S.env.TURNSTILE_SECRET_KEY = "ts-secret"; S.env.TURNSTILE_SITE_KEY = "ts-site";
  r = await post(OFFICE, "sam@example.test", "sams own password");
  ok("the known address is asked for the check for that account, and the password isn't looked at", r.status === 429 && r.body.code === "turnstile_required" && r.body.siteKey === "ts-site" && !r.cookie && verified.length === 0);
  ok("…not for another account", (await post(OFFICE, "quinn@example.test", "quinns own password")).status === 200 && verified.length === 0);
  r = await post(OFFICE, "sam@example.test", "sams own password", { turnstileToken: "good-1" });
  ok("a passed check goes on to the password, and signs in", r.status === 200 && !!r.cookie && verified.join() === "good-1");
  ok("a wrong password after a passed check is still refused", (await post(OFFICE, "sam@example.test", "a wrong one", { turnstileToken: "good-2" })).status === 401);
  delete S.env.TURNSTILE_SECRET_KEY; delete S.env.TURNSTILE_SITE_KEY;

  console.log("\n=== The install-wide budget: a known address still goes straight on ===");
  await clear();
  S.env.ADMIN_AUTH_GLOBAL_LIMIT = "5";
  await post(OFFICE, "quinn@example.test", "quinns own password");   // known again (the marks were cleared)
  for (let i = 1; i <= 5; i++) await post("192.0.2." + i, "nobody" + i + "@example.test", "wrong password " + i);
  ok("five failures from five addresses spend the whole site's budget", count("rl:admin_auth_all:%") === 5);
  ok("an address that hasn't signed in here is refused, as before", (r = await post(STRANGER, "sam@example.test", "sams own password")).status === 429 && r.body.code !== "turnstile_required");
  ok("the known address isn't: the people who work here keep signing in", (await post(OFFICE, "sam@example.test", "sams own password")).status === 200 &&
    (await post(OFFICE, "olive@example.test", "correct horse battery")).status === 200);
  ok("…though a wrong password from it is still just wrong", (await post(OFFICE, "sam@example.test", "not it")).status === 401);
  delete S.env.ADMIN_AUTH_GLOBAL_LIMIT;

  console.log("\n=== An address that hasn't signed in here behaves as it did ===");
  await clear();
  for (let i = 1; i <= 10; i++) await post("198.51.100." + i, "sam@example.test", "not sams password");
  ok("ten failures for one account from ten addresses hold that account up from a new address", (await post("198.51.100.50", "sam@example.test", "sams own password")).status === 429);
  ok("…while another account signs in from a new address", (await post("198.51.100.51", "olive@example.test", "correct horse battery")).status === 200);
  await clear();
  const mine = [];
  for (let i = 1; i <= 20; i++) mine.push((await post(STRANGER, "nobody" + i + "@example.test", "guess " + i)).status);
  ok("one address is still refused on its own past its share of the site's budget (20 failures)", mine.every(s => s === 401) && (await post(STRANGER, "olive@example.test", "correct horse battery")).status === 429);
  await clear();
  await post(OFFICE, "quinn@example.test", "quinns own password");
  for (let i = 1; i <= 20; i++) await post(OFFICE, "nobody" + i + "@example.test", "guess " + i);
  ok("a known address past its own share is refused like any other", (await post(OFFICE, "quinn@example.test", "quinns own password")).status === 429);
  await clear();
  S.env.ADMIN_AUTH_GLOBAL_LIMIT = "0";
  await post(OFFICE, "quinn@example.test", "quinns own password");
  for (let i = 1; i <= 12; i++) await post(OFFICE, "sam@example.test", "not sams password " + i);
  ok("with the budgets switched off (ADMIN_AUTH_GLOBAL_LIMIT=0) nothing is held up, as before", (await post(OFFICE, "sam@example.test", "sams own password")).status === 200);
  delete S.env.ADMIN_AUTH_GLOBAL_LIMIT;

  console.log("\n=== The code says so ===");
  const src = read("functions/_lib/adminAuth.js");
  const fn = src.slice(src.indexOf("export async function signInBudgetBlocked("), src.indexOf("export async function countSignInFailure("));
  ok("signInBudgetBlocked never returns early for a known address", !/rateLimitMarked\([^)]*\)\)\s*return null/.test(fn) && /const known = await rateLimitMarked\(env, ADMIN_KNOWN_BUCKET, request\);/.test(fn));
  ok("…the mark only stands in for the install-wide check", /const all = known \? \{ blocked: false \} : await rateLimitCheckGlobal\(/.test(fn));
  ok("…and the account's budget is looked at for every address", /const acct = account \? await rateLimitCheck\(env, ADMIN_AUTH_ACCOUNT_BUCKET/.test(fn) && fn.indexOf("const acct") > fn.indexOf("const known"));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})().catch(e => { console.error(e); console.log("test287 ran to the end without crashing: false"); process.exitCode = 1; });
