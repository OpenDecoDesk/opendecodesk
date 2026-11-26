const { makeAuth, totpNow, read } = require("./testlib/auth-harness");

// Turning two-step sign-in on (second review, 2026-11-25).
// "activate" used to need only a live session, and took whatever secret the browser sent: someone at a signed-in
// computer left alone could enrol their own phone on the owner's account (and got the recovery codes, while the
// owner's other sessions were ended), and a required two-step could be met with a secret anyone knows ("AAAA").
// Now:
//   - "generate" hands out the secret with a proof that this server made it for this user, good for 15 minutes;
//   - "activate" takes only such a secret, whole (the 32 characters generate makes), and asks for the user's
//     current password again — within the budgets Change password keeps, which the two screens share;
//   - the one session not asked for the password is the one pending "2fa" (two-step is required and this user has
//     none): it exists only because the password was just typed, and can do nothing else.
// The real sign-in code (testlib/auth-harness.js) with the real rate limiter on real SQL. Invented data only.

let failed = 0, passed = 0;
const ok = (label, cond) => { cond ? passed++ : failed++; console.log(label + ": " + !!cond); };
const PW = "correct horse battery", SAM_PW = "sam's own password", QUINN_PW = "quinn's own password";
const MADE_UP = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";   // a secret the browser chose, of the right length

// The budgets are counted in windows by the clock (a minute for an address, 15 minutes for a user): a count that must
// reach its limit isn't started in a window's last seconds, so it is never split across two.
const notNearTheEndOf = async (windowSeconds, margin) => {
  const left = windowSeconds - (Math.floor(Date.now() / 1000) % windowSeconds);
  if (left < margin) await new Promise(r => setTimeout(r, (left + 1) * 1000));
};

(async () => {
  await notNearTheEndOf(900, 15);
  const A = await makeAuth({ realLimits: true });
  const clear = () => A.d1._raw.run("DELETE FROM rate_limits");
  const admin = await A.firstAdmin("Olive Owner", "olive@example.test", PW);
  clear();
  let sam = await A.addUser(admin, "staff", "Sam Staff", "sam@example.test", SAM_PW);
  clear();
  const quinn = await A.addUser(admin, "staff", "Quinn Staff", "quinn@example.test", QUINN_PW);
  clear();
  const off = (email) => A.user(email).totpSecret === null && A.user(email).recoveryCodes === null;
  const counted = (like) => Number((A.d1.q("SELECT sum(count) n FROM rate_limits WHERE key LIKE ?", like)[0] || {}).n || 0);
  let r;

  console.log("=== The secret comes with the server's proof ===");
  const g = await A.twoFactor({ action: "generate" }, sam);
  const SECRET = g.body.secret, PROOF = String(g.body.proof || "");
  ok("generate gives a 32-character secret, its proof (an expiry and a signature) and the link for the app", g.status === 200 && /^[A-Z2-7]{32}$/.test(SECRET) && /^\d{9,12}\.[0-9a-f]{64}$/.test(PROOF) &&
    g.body.otpauthUri.includes("secret=" + SECRET));
  const expires = Number(PROOF.split(".")[0]), now = Math.floor(Date.now() / 1000);
  ok("the proof is good for 15 minutes", expires > now + 14 * 60 && expires <= now + 15 * 60 + 2);
  ok("nothing is stored until the code is given", off("sam@example.test"));
  ok("the proof is signed for that user and that secret", await A.lib.verifyTwoStepProof(A.env, A.user("sam@example.test").id, SECRET, PROOF) &&
    !(await A.lib.verifyTwoStepProof(A.env, A.user("quinn@example.test").id, SECRET, PROOF)) && !(await A.lib.verifyTwoStepProof(A.env, A.user("sam@example.test").id, MADE_UP, PROOF)));
  ok("…under the site's signing secret, with a label of its own", !(await A.lib.verifyTwoStepProof(Object.assign({}, A.env, { SIGNING_SECRET: "another secret" }), A.user("sam@example.test").id, SECRET, PROOF)) &&
    /"odd-2fa-enrol-v1:"/.test(read("functions/_lib/http.js")));

  console.log("\n=== The current password is asked for again ===");
  const send = (extra, cookie = sam, opts) => A.twoFactor(Object.assign({ action: "activate", proposedSecret: SECRET, proof: PROOF, code: totpNow(SECRET) }, extra), cookie, opts);
  r = await send({});
  ok("without a password, a right code is refused", r.status === 400 && r.body.code === "password_required" && off("sam@example.test"));
  ok("…and an empty one, or one that isn't text", (await send({ current: "" })).status === 400 && (await send({ current: ["x"] })).status === 400 && off("sam@example.test"));
  ok("…none of which is a guess: nothing is counted", counted("rl:admin_auth:%") === 0 && counted("rl:admin_pw_user:%") === 0);
  const failuresBefore = A.d1.q("SELECT count(*) n FROM failed_admin_logins")[0].n;
  r = await send({ current: "not sam's password" });
  ok("with a wrong password, a right code is refused", r.status === 401 && r.body.code === "wrong_password" && /current password is not right/.test(r.body.message) && off("sam@example.test"));
  ok("…and counted: against this address's failed sign-ins and this user's own budget", counted("rl:admin_auth:%") === 1 && counted("rl:admin_pw_user:user:" + A.user("sam@example.test").id + ":%") === 1);
  ok("…and recorded for the owner's security alert", A.d1.q("SELECT count(*) n FROM failed_admin_logins")[0].n === failuresBefore + 1);
  ok("another user's password is a wrong password", (await send({ current: QUINN_PW })).status === 401 && off("sam@example.test"));
  ok("nothing was audited or handed out by any of these", A.audit("security.2fa_enabled").length === 0);

  console.log("\n=== Only a secret this server issued ===");
  r = await send({ proposedSecret: MADE_UP, proof: undefined, current: SAM_PW, code: totpNow(MADE_UP) });
  ok("a secret the browser made up is refused, with the right password and a right code", r.status === 400 && r.body.code === "setup_key_expired" && off("sam@example.test"));
  ok("…and with the proof of another secret", (await send({ proposedSecret: MADE_UP, current: SAM_PW, code: totpNow(MADE_UP) })).status === 400 && off("sam@example.test"));
  const forQuinn = await A.twoFactor({ action: "generate" }, quinn);
  r = await send({ proposedSecret: forQuinn.body.secret, proof: forQuinn.body.proof, current: SAM_PW, code: totpNow(forQuinn.body.secret) });
  ok("a secret issued to another user is refused", r.status === 400 && r.body.code === "setup_key_expired" && off("sam@example.test"));
  const samId = A.user("sam@example.test").id;
  for (const short of ["AAAA", "JBSWY3DPEHPK3PXP", SECRET.slice(0, 31), SECRET + "A", SECRET.toLowerCase()]) {
    // Even signed as the server would sign it: the length is checked on its own.
    r = await send({ proposedSecret: short, proof: await A.lib.signTwoStepProof(A.env, samId, short), current: SAM_PW, code: totpNow(short.toUpperCase()) });
    ok("a secret of " + short.length + " characters" + (short.length === 32 ? " in lower case" : "") + " is refused", r.status === 400 && r.body.code === "setup_key_expired" && off("sam@example.test"));
  }
  const realNow = Date.now;
  Date.now = () => realNow() - 16 * 60 * 1000;
  const oldProof = await A.lib.signTwoStepProof(A.env, samId, SECRET);
  Date.now = realNow;
  r = await send({ proof: oldProof, current: SAM_PW });
  ok("a proof more than 15 minutes old is refused, and says to start again", r.status === 400 && r.body.code === "setup_key_expired" && /Set up 2FA/.test(r.body.message) && off("sam@example.test"));
  const tampered = String(Number(PROOF.split(".")[0]) + 3600) + "." + PROOF.split(".")[1];
  ok("a proof with its expiry pushed out is refused", (await send({ proof: tampered, current: SAM_PW })).status === 400 && off("sam@example.test"));
  ok("…and so is anything that isn't a proof", (await send({ proof: "", current: SAM_PW })).status === 400 && (await send({ proof: { a: 1 }, current: SAM_PW })).status === 400 &&
    (await send({ proof: PROOF.split(".")[1], current: SAM_PW })).status === 400 && off("sam@example.test"));
  ok("a refused secret isn't a wrong password or a wrong code: nothing more was counted", counted("rl:admin_pw_user:%") === 2 && counted("rl:admin_2fa_code:%") === 0);
  const noSecret = Object.assign({}, A.env); delete noSecret.SIGNING_SECRET;
  ok("without a signing secret no proof is made, and none checks", (await A.lib.signTwoStepProof(noSecret, samId, SECRET)) === null && (await A.lib.verifyTwoStepProof(noSecret, samId, SECRET, PROOF)) === false);

  console.log("\n=== The code is still what turns it on ===");
  r = await send({ current: SAM_PW, code: "000000" });
  ok("the right password and proof with a wrong code: refused, and the code is counted", r.status === 400 && /Invalid code/.test(r.body.message) && off("sam@example.test") && counted("rl:admin_2fa_code:%") === 1);
  const samOther = (await A.signIn("sam@example.test", SAM_PW)).cookie;
  r = await send({ current: SAM_PW });
  ok("the right password, the server's secret and a right code turn two-step on", r.status === 200 && r.body.recoveryCodes.length === 10 && r.body.pending === null &&
    (await A.lib.openTotp(A.env, A.user("sam@example.test").totpSecret)) === SECRET);
  ok("…audited, and the user's other sessions are ended", A.audit("security.2fa_enabled").length === 1 && (await A.users({ action: "me" }, sam)).status === 200 && (await A.users({ action: "me" }, samOther)).status === 401);
  ok("signing in now needs the password and a code", (await A.signIn("sam@example.test", SAM_PW)).body.status === "totp_required" && (await A.signIn("sam@example.test", SAM_PW, totpNow(SECRET, 1))).status === 200);
  ok("the same secret can't be put on again while it is on", (await send({ current: SAM_PW, code: totpNow(SECRET, 1) })).status === 409);

  console.log("\n=== One budget of wrong passwords, shared with Change password ===");
  clear();
  const B = await makeAuth({ d1: A.d1, realLimits: true });   // a later quarter of an hour: no counts, a new copy of the code
  const q = (await B.signIn("quinn@example.test", QUINN_PW)).cookie;
  const qg = await B.twoFactor({ action: "generate" }, q);
  const qSend = (extra, ip) => B.twoFactor(Object.assign({ action: "activate", proposedSecret: qg.body.secret, proof: qg.body.proof, code: totpNow(qg.body.secret) }, extra), q, { headers: { "cf-connecting-ip": ip } });
  const wrong = [];
  // From several addresses, so only the user's own budget is what stops them (an address has its own ten a minute).
  for (let i = 0; i < 6; i++) wrong.push((await qSend({ current: "guess number " + i }, "198.51.100." + (i + 1))).status);
  for (let i = 0; i < 4; i++) wrong.push((await B.password({ action: "change", current: "guess number " + (6 + i), next: "a new password for quinn" }, q, { headers: { "cf-connecting-ip": "198.51.100." + (7 + i) } })).status);
  ok("ten wrong passwords, some typed here and some on Change password, are each refused", wrong.length === 10 && wrong.every(s => s === 401));
  r = await qSend({ current: QUINN_PW }, "198.51.100.50");
  ok("after them the right password isn't even looked at here", r.status === 429 && A.user("quinn@example.test").totpSecret === null);
  ok("…nor on Change password", (await B.password({ action: "change", current: QUINN_PW, next: "a new password for quinn" }, q, { headers: { "cf-connecting-ip": "198.51.100.51" } })).status === 429);
  ok("another user isn't held up by it", (await B.password({ action: "change", current: "not it", next: "whatever comes next" }, sam)).status === 401);
  clear();
  const C = await makeAuth({ d1: A.d1, realLimits: true });
  await notNearTheEndOf(60, 5);
  const oneAddress = [];
  for (let i = 0; i < 10; i++) oneAddress.push((await C.twoFactor({ action: "activate", proposedSecret: qg.body.secret, proof: qg.body.proof, code: totpNow(qg.body.secret), current: "guess " + i }, q, { headers: { "cf-connecting-ip": "198.51.100.77" } })).status);
  A.d1._raw.run("DELETE FROM rate_limits WHERE key LIKE 'rl:admin_pw_user:%'");   // the user's own budget aside: the address's
  ok("one address is stopped after ten wrong passwords in a minute, as at sign-in", oneAddress.every(s => s === 401) &&
    (await C.twoFactor({ action: "activate", proposedSecret: qg.body.secret, proof: qg.body.proof, code: totpNow(qg.body.secret), current: QUINN_PW }, q, { headers: { "cf-connecting-ip": "198.51.100.77" } })).status === 429);
  clear();

  console.log("\n=== The step owed at sign-in asks for no password ===");
  const D = await makeAuth({ d1: A.d1, realLimits: true });
  const boss = (await D.signIn("olive@example.test", PW)).cookie;
  // The owner enrols first (with the password), then requires two-step of everyone.
  const og = await D.twoFactor({ action: "generate" }, boss);
  ok("the owner turns their own on, with their password", (await D.twoFactor({ action: "activate", proposedSecret: og.body.secret, proof: og.body.proof, current: PW, code: totpNow(og.body.secret) }, boss)).status === 200);
  ok("…and requires it of everyone", (await D.users({ action: "setRequire2fa", on: true }, boss)).status === 200);
  r = await D.signIn("quinn@example.test", QUINN_PW);
  const owed = r.cookie;
  ok("at the next sign-in a user without it gets a session that can only enrol", r.status === 200 && r.body.pending === "2fa" && (await D.orders({ action: "listOrgs" }, owed)).body.code === "setup_required");
  const pg = await D.twoFactor({ action: "generate" }, owed);
  ok("that session is given a secret and its proof", pg.status === 200 && /^[A-Z2-7]{32}$/.test(pg.body.secret) && !!pg.body.proof);
  r = await D.twoFactor({ action: "activate", proposedSecret: MADE_UP, code: totpNow(MADE_UP) }, owed);
  ok("it still can't enrol a secret of its own choosing", r.status === 400 && r.body.code === "setup_key_expired" && D.user("quinn@example.test").totpSecret === null);
  ok("…nor a short one", (await D.twoFactor({ action: "activate", proposedSecret: "AAAA", proof: await D.lib.signTwoStepProof(D.env, D.user("quinn@example.test").id, "AAAA"), code: totpNow("AAAA") }, owed)).status === 400 &&
    D.user("quinn@example.test").totpSecret === null);
  ok("a wrong code doesn't enrol it", (await D.twoFactor({ action: "activate", proposedSecret: pg.body.secret, proof: pg.body.proof, code: "000000" }, owed)).status === 400);
  r = await D.twoFactor({ action: "activate", proposedSecret: pg.body.secret, proof: pg.body.proof, code: totpNow(pg.body.secret) }, owed);
  ok("with the server's secret and a right code it enrols without the password being asked again", r.status === 200 && r.body.pending === null && r.body.recoveryCodes.length === 10 &&
    (await D.lib.openTotp(D.env, D.user("quinn@example.test").totpSecret)) === pg.body.secret && (await D.orders({ action: "listOrgs" }, owed)).status === 200);
  // A user with a full session from before the switch (nothing pending) is asked for the password like anyone.
  await D.users({ action: "reset2fa", id: D.user("quinn@example.test").id }, boss);
  await D.users({ action: "setRequire2fa", on: false }, boss);
  const plain = (await D.signIn("quinn@example.test", QUINN_PW)).cookie;
  await D.users({ action: "setRequire2fa", on: true }, boss);
  const fg = await D.twoFactor({ action: "generate" }, plain);
  ok("a session with nothing pending is asked for the password even where two-step is required", (await D.users({ action: "me" }, plain)).body.pending === null &&
    (await D.twoFactor({ action: "activate", proposedSecret: fg.body.secret, proof: fg.body.proof, code: totpNow(fg.body.secret) }, plain)).body.code === "password_required" &&
    (await D.twoFactor({ action: "activate", proposedSecret: fg.body.secret, proof: fg.body.proof, current: QUINN_PW, code: totpNow(fg.body.secret) }, plain)).status === 200);

  console.log("\n=== The set-up window ===");
  const adminJs = read("public/admin.js");
  const setup = adminJs.slice(adminJs.indexOf("async function start2FASetup("), adminJs.indexOf("function copy2FAKey("));
  const submit = adminJs.slice(adminJs.indexOf("async function submit2FAActivate("), adminJs.indexOf("async function submit2FADisable("));
  ok("it has a labelled Current password box that a password manager fills", /<label for="tfa-current-password"[^>]*>Current password<\/label>/.test(setup) &&
    /<input type="password" id="tfa-current-password" autocomplete="current-password" required aria-describedby="tfa-password-error"/.test(setup));
  ok("…with its own message line beside it, read out when it changes", /<div id="tfa-password-error" class="admin-error" role="alert"/.test(setup) && /<div id="tfa-error" class="admin-error" role="alert"/.test(setup));
  ok("…not shown in the step owed at sign-in", /const askPassword = !_tfa\.forced;/.test(setup) && /\$\{askPassword \? `[\s\S]*tfa-current-password[\s\S]*` : ""\}/.test(setup));
  ok("it keeps the server's proof with the secret and sends both back", /<input type="hidden" id="tfa-proof" value="\$\{escapeHtml\(data\.proof \|\| ""\)\}" \/>/.test(setup) &&
    /proposedSecret:secret, proof:\(proofEl && proofEl\.value\) \|\| "", code\}, pwEl \? \{current\} : \{\}/.test(submit));
  ok("an empty password is said beside the box before anything is sent", submit.indexOf('pwWrong("Enter your current password.")') > 0 && submit.indexOf('pwWrong("Enter your current password.")') < submit.indexOf('fetch("/api/admin-2fa"'));
  ok("a wrong password from the server is said beside the box, which is marked and focused", /data\.code === "wrong_password" \|\| data\.code === "password_required"\)\) pwWrong\(message\)/.test(submit) &&
    /pwEl\.setAttribute\("aria-invalid", "true"\); pwEl\.focus\(\);/.test(submit));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})().catch(e => { console.error(e); console.log("test286 ran to the end without crashing: false"); process.exitCode = 1; });
