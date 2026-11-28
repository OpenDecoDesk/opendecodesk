const { makeAuth, request, answer, prelude, strip, read } = require("./testlib/auth-harness");

// Sign-in failure budgets are spent BEFORE the password is checked (second review, 2026-11-25).
// The budgets used to be read first and counted only after a wrong password: a burst of sign-ins sent at the same
// moment all read the counters before any failure was written, so every one of them got a guess — the account's
// ten-in-15-minutes and the site's hundred could be overshot many times over. Now each sign-in takes its slot in
// every budget in one atomic step first, keeps it for a wrong password or code, and gives back exactly the slot it
// took for any other answer. "Confirm it's you" password checks (Change password, turning two-step on) do the same.
// The real sign-in code (testlib/auth-harness.js) with the real rate limiter on real SQL. Invented data only.

let failed = 0, passed = 0;
const ok = (label, cond) => { cond ? passed++ : failed++; console.log(label + ": " + !!cond); };

(async () => {
  // The budgets are counted in 15-minute windows by the clock: don't start in a window's last few seconds.
  const left = 900 - (Math.floor(Date.now() / 1000) % 900);
  if (left < 15) await new Promise(r => setTimeout(r, (left + 1) * 1000));
  const S = await makeAuth({ realLimits: true });
  await S.firstAdmin("Olive Owner", "olive@example.test", "correct horse battery");
  const admin = (await S.signIn("olive@example.test", "correct horse battery")).cookie;
  const samCookie = await S.addUser(admin, "staff", "Sam Staff", "sam@example.test", "sams own password");

  // The endpoints again on the same database, with every password check counted. A fresh copy each time: the
  // limiter also remembers, per running copy, which counters it has seen full.
  let checks = 0;
  const counted = (file) => new Function("__hits", prelude(true, false) + strip(read(file)) +
    "\nconst __verify = verifyUserPassword; verifyUserPassword = async (...a) => { __count(); return __verify(...a); };\nreturn onRequestPost;")
    .call(null, []);
  global.__count = () => { checks++; };
  const fresh = () => { S.d1._raw.run("DELETE FROM rate_limits"); checks = 0; return { session: counted("functions/api/admin-session.js"), password: counted("functions/api/admin-password.js") }; };
  const post = (fn, path, body, ip, cookie) => fn({ env: S.env, waitUntil: () => {}, request: request(path, body, { cookie, headers: { "cf-connecting-ip": ip } }) }).then(answer);
  const count = (like) => Number((S.d1.q("SELECT sum(count) n FROM rate_limits WHERE key LIKE ?", like)[0] || {}).n || 0);

  console.log("=== Thirty wrong sign-ins for one account, sent at the same moment ===");
  let E = fresh();
  const burst = await Promise.all(Array.from({ length: 30 }, (_, i) =>
    post(E.session, "/api/admin-session", { email: "sam@example.test", key: "guess number " + i }, "198.51.100." + (i + 1))));
  const statuses = burst.map(r => r.status);
  ok("no more than the account's budget (10) got a password check", checks <= 10);
  ok("…exactly ten were checked and refused as wrong", checks === 10 && statuses.filter(s => s === 401).length === 10);
  ok("…the other twenty were held up without a check", statuses.filter(s => s === 429).length === 20);
  ok("the account's count is the ten wrong passwords, not the thirty tries", count("rl:admin_auth_acct:%") === 10);
  ok("…and so is the site's", count("rl:admin_auth_all:%") === 10);
  ok("the right password is held up too, until the window ends", (await post(E.session, "/api/admin-session", { email: "sam@example.test", key: "sams own password" }, "198.51.100.99")).status === 429 && checks === 10);

  console.log("\n=== Anything but a wrong credential gives the slots back ===");
  E = fresh();
  let r = await post(E.session, "/api/admin-session", { email: "sam@example.test", key: "sams own password" }, "198.51.100.40");
  ok("a sign-in that works leaves nothing counted", r.status === 200 && count("rl:admin_auth_acct:%") === 0 && count("rl:admin_auth_all:%") === 0 && count("rl:admin_auth_ip15:%") === 0);
  const before = checks;
  const fine = await Promise.all(Array.from({ length: 15 }, (_, i) =>
    post(E.session, "/api/admin-session", { email: "sam@example.test", key: "sams own password" }, "198.51.100." + (100 + i))));
  ok("fifteen right sign-ins at once: at least ten get in, and every slot is given back",fine.filter(x => x.status === 200).length >= 10 && count("rl:admin_auth_acct:%") === 0 && checks > before);
  E = fresh();
  r = await post(E.session, "/api/admin-session", { email: "sam@example.test", key: "not it" }, "198.51.100.41");
  ok("a wrong password keeps one slot in each budget", r.status === 401 && count("rl:admin_auth_acct:%") === 1 && count("rl:admin_auth_all:%") === 1 && count("rl:admin_auth_ip15:%") === 1);

  console.log("\n=== Two-step: a code still needed isn't a guess ===");
  S.d1._raw.run("UPDATE users SET totpSecret = 'JBSWY3DPEHPK3PXP' WHERE email = 'sam@example.test'");
  E = fresh();
  r = await post(E.session, "/api/admin-session", { email: "sam@example.test", key: "sams own password" }, "198.51.100.42");
  ok("asked for the code: the slots are given back", r.status === 200 && r.body.status === "totp_required" && count("rl:admin_auth_acct:%") === 0 && count("rl:admin_auth_all:%") === 0);
  r = await post(E.session, "/api/admin-session", { email: "sam@example.test", key: "sams own password", totpCode: "000000" }, "198.51.100.42");
  ok("a wrong code keeps them", r.status === 401 && count("rl:admin_auth_acct:%") === 1);
  S.d1._raw.run("UPDATE users SET totpSecret = NULL WHERE email = 'sam@example.test'");

  console.log("\n=== Change password: thirty wrong current passwords at once ===");
  E = fresh();
  const pw = await Promise.all(Array.from({ length: 30 }, (_, i) =>
    post(E.password, "/api/admin-password", { action: "change", current: "guess number " + i, next: "a brand new password " + i }, "203.0.113.9", samCookie)));
  ok("no more than ten got a password check (this address's ten a minute)", checks <= 10 && pw.filter(x => x.status === 401).length === checks);
  ok("…the rest were held up", pw.filter(x => x.status === 429).length === 30 - checks);
  ok("the user's own budget holds the wrong ones only", count("rl:admin_pw_user:%") === checks);
  E = fresh();
  r = await post(E.password, "/api/admin-password", { action: "change", current: "sams own password", next: "sams second password" }, "203.0.113.9", samCookie);
  ok("the right current password gives both slots back", r.status === 200 && count("rl:admin_pw_user:%") === 0 && count("rl:admin_auth:%") === 0);

  console.log("\n=== The limiter gives back the exact slot it took ===");
  const L = S.limits;
  S.d1._raw.run("DELETE FROM rate_limits");
  const realNow = Date.now;
  const slot = await L.rateLimitReserve(S.env, "unit_reserve", "who", 3, 900);
  ok("a slot is taken in one step, and says which window it is in", slot.blocked === false && slot.where === "db" && count("rl:unit_reserve:%") === 1 && /^rl:unit_reserve:who:\d+$/.test(slot.key));
  Date.now = () => realNow() + 900 * 1000;   // the clock moves on to the next window before it is given back
  await L.rateLimitRelease(S.env, slot);
  Date.now = realNow;
  ok("…and is given back in that window, not the one the clock is in now", Number(S.d1.q("SELECT count FROM rate_limits WHERE key = ?", slot.key)[0].count) === 0 && count("rl:unit_reserve:%") === 0);
  for (let i = 0; i < 3; i++) await L.rateLimitReserve(S.env, "unit_reserve", "who", 3, 900);
  ok("past the limit a slot is refused", (await L.rateLimitReserve(S.env, "unit_reserve", "who", 3, 900)).blocked === true);
  await L.rateLimitRelease(S.env, slot); await L.rateLimitRelease(S.env, slot); await L.rateLimitRelease(S.env, slot); await L.rateLimitRelease(S.env, slot); await L.rateLimitRelease(S.env, slot);
  ok("a count never goes below nothing", Number(S.d1.q("SELECT count FROM rate_limits WHERE key = ?", slot.key)[0].count) === 0);
  const broken = { DB: { prepare() { throw new Error("D1 down"); } } };
  const origError = console.error; console.error = () => {};
  const m1 = await L.rateLimitReserve(broken, "unit_mem", "who", 1, 60);
  const m2 = await L.rateLimitReserve(broken, "unit_mem", "who", 1, 60);
  await L.rateLimitRelease(broken, m2); await L.rateLimitRelease(broken, m1);
  const m3 = await L.rateLimitReserve(broken, "unit_mem", "who", 1, 60);
  console.error = origError;
  ok("with the database down, slots are counted in memory…", m1.where === "memory" && !m1.blocked && m2.blocked && m2.key === m1.key);
  ok("…and given back there: with both given back, the next one is the first again", m3.where === "memory" && !m3.blocked);

  console.log("\n=== The code says so ===");
  const src = read("functions/_lib/adminAuth.js"), sess = read("functions/api/admin-session.js");
  ok("countSignInFailure (count after the check) is gone", !/countSignInFailure/.test(src) && !/countSignInFailure/.test(sess));
  ok("sign-in gives back the slots it took, unless refuse() kept them", /finally\{ if\(!held\.kept\) await releaseSignInSlots\(env, held\.slots\); \}/.test(sess) && /held\.kept = true;/.test(sess));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})().catch(e => { console.error(e); console.log("test356 ran to the end without crashing: false"); process.exitCode = 1; });
