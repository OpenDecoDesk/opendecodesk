const { makeAuth, totpNow } = require("./testlib/auth-harness");

// Two-step (TOTP) secrets at rest (review #76; functions/_lib/totp.js sealTotp/openTotp). users.totpSecret is stored
// sealed — AES-GCM under a key derived from the PROXY_ADMIN_PASSPHRASE secret, "v1:" + base64(iv ‖ ciphertext) — so a
// copy of the database alone can't make codes. It is sealed when two-step is turned on and when an older install's
// owner is adopted (test114), and opened only where a code is checked: signing in, and the codes Security (2FA) asks
// for. A secret stored before this (no prefix) still works and is sealed after the next code that matches it. A seal
// that won't open fails CLOSED: the sign-in is refused with what to do (ask an admin to reset two-step), never let in
// as if there were no two-step. Real SQL (sql.js) under the real adminAuth.js and the account endpoints; invented people.
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

(async () => {
  const A = await makeAuth();
  const PW = "correct horse battery", SAM_PW = "sam's own password", QUINN_PW = "quinn's own password";
  const admin = await A.firstAdmin("Olive Owner", "olive@example.test", PW);
  let sam = await A.addUser(admin, "staff", "Sam Staff", "sam@example.test", SAM_PW);
  const stored = (email) => A.user(email).totpSecret;
  const opens = async (email) => A.lib.openTotp(A.env, stored(email));

  console.log("=== Turning two-step on ===");
  let g = await A.twoFactor({ action: "generate" }, sam);
  const SAM_SECRET = g.body.secret;
  let a = await A.twoFactor({ action: "activate", proposedSecret: SAM_SECRET, code: totpNow(SAM_SECRET) }, sam);
  const samCodes = a.body.recoveryCodes;
  ok("the secret is stored sealed: prefixed, not the secret, and it opens to it", a.status === 200 && /^v1:[A-Za-z0-9+/]+=*$/.test(stored("sam@example.test")) &&
    !stored("sam@example.test").includes(SAM_SECRET) && (await opens("sam@example.test")) === SAM_SECRET);
  ok("…nothing in the database holds the secret itself", !JSON.stringify(A.d1.q("SELECT * FROM users")).includes(SAM_SECRET) && !JSON.stringify(A.d1.q("SELECT * FROM global_settings")).includes(SAM_SECRET));
  const s1 = stored("sam@example.test"), s2 = await A.lib.sealTotp(A.env, SAM_SECRET);
  ok("two seals of the same secret differ (a fresh nonce each time)", s1 !== s2 && (await A.lib.openTotp(A.env, s2)) === SAM_SECRET);
  ok("the status and the Users list still say two-step is on", (await A.twoFactor({ action: "status" }, sam)).body.enabled === true &&
    (await A.users({ action: "list" }, admin)).body.users.find(u => u.email === "sam@example.test").has2fa === true);
  a = await A.signIn("sam@example.test", SAM_PW);
  ok("signing in asks for the code", a.body.status === "totp_required");
  a = await A.signIn("sam@example.test", SAM_PW, totpNow(SAM_SECRET, 1));
  ok("…and the sealed secret checks it", a.status === 200 && !!a.cookie);
  sam = a.cookie;

  console.log("\n=== A seal that won't open fails closed ===");
  // As after `npm run setup -- --new-passphrase` (which also voids the password) or a damaged row: sealed under another key.
  A.d1._raw.exec(`UPDATE users SET totpSecret = '${await A.lib.sealTotp({ PROXY_ADMIN_PASSPHRASE: "some other passphrase" }, SAM_SECRET)}' WHERE email = 'sam@example.test'`);
  ok("a password alone still isn't enough: the code is still asked for", (await A.signIn("sam@example.test", SAM_PW)).body.status === "totp_required");
  a = await A.signIn("sam@example.test", SAM_PW, totpNow(SAM_SECRET));
  ok("with a code it is refused, saying to ask an admin to reset two-step, and no session is made", a.status === 409 && a.body.code === "totp_unreadable" && /ask an admin to reset your two-step/i.test(a.body.message) && !a.cookie);
  ok("…two-step still counts as on (has2fa is whether a secret is stored)", (await A.users({ action: "list" }, admin)).body.users.find(u => u.email === "sam@example.test").has2fa === true);
  a = await A.twoFactor({ action: "disable", code: totpNow(SAM_SECRET) }, sam);
  ok("Security (2FA) refuses a code against it the same way, and nothing is switched off", a.status === 409 && a.body.code === "totp_unreadable" && !!stored("sam@example.test"));
  a = await A.signIn("sam@example.test", SAM_PW, samCodes[0]);
  ok("a recovery code still gets the user in (it doesn't need the seal)", a.status === 200);
  A.d1._raw.exec(`UPDATE users SET totpSecret = 'v1:not-a-seal' WHERE email = 'sam@example.test'`);
  a = await A.signIn("sam@example.test", SAM_PW, totpNow(SAM_SECRET));
  ok("a damaged value is refused the same way, never read as no two-step", a.status === 409 && a.body.code === "totp_unreadable" && !a.cookie);
  const samId = A.user("sam@example.test").id;
  ok("an admin's Reset two-step clears it, and the user signs in with the password alone", (await A.users({ action: "reset2fa", id: samId }, admin)).status === 200 && stored("sam@example.test") === null &&
    (await A.signIn("sam@example.test", SAM_PW)).status === 200);

  console.log("\n=== A secret stored before sealing ===");
  const RAW = "KRSXG5CTMVRXEZLU", RAW2 = "JBSWY3DPEHPK3PXP";
  await A.addUser(admin, "staff", "Quinn Staff", "quinn@example.test", QUINN_PW);
  A.d1._raw.exec(`UPDATE users SET totpSecret = '${RAW}', totpLastCounter = NULL WHERE email = 'quinn@example.test'`);
  ok("it is still asked for", (await A.signIn("quinn@example.test", QUINN_PW)).body.status === "totp_required");
  ok("a wrong code is refused and leaves it as it was", (await A.signIn("quinn@example.test", QUINN_PW, "000000")).status === 401 && stored("quinn@example.test") === RAW);
  a = await A.signIn("quinn@example.test", QUINN_PW, totpNow(RAW));
  ok("the right code signs in, and the secret is sealed from then on", a.status === 200 && /^v1:/.test(stored("quinn@example.test")) && (await opens("quinn@example.test")) === RAW);
  const quinn = a.cookie;
  A.d1._raw.exec(`UPDATE users SET totpSecret = '${RAW2}', totpLastCounter = NULL WHERE email = 'quinn@example.test'`);
  a = await A.twoFactor({ action: "newRecoveryCodes", code: totpNow(RAW2) }, quinn);
  ok("a code given to Security (2FA) seals one too", a.status === 200 && Array.isArray(a.body.recoveryCodes) && /^v1:/.test(stored("quinn@example.test")) && (await opens("quinn@example.test")) === RAW2);

  console.log("\n=== The code ===");
  const read = (p) => require("fs").readFileSync(__dirname + "/" + p, "utf8");
  ok("the raw proposed secret is never what activation stores", /totpSecret: await sealTotp\(env, proposedSecret\)/.test(read("functions/api/admin-2fa.js")) && !/totpSecret: proposedSecret/.test(read("functions/api/admin-2fa.js")));
  ok("codes are checked against the opened secret, at both places a code is checked", /verifyTOTP\(secret, code\)/.test(read("functions/api/admin-session.js")) && /verifyTOTP\(secret, code\)/.test(read("functions/api/admin-2fa.js")) &&
    !/verifyTOTP\(user\.totpSecret/.test(read("functions/api/admin-session.js") + read("functions/api/admin-2fa.js")));
  ok("the key is derived from the passphrase with the odd-totp-v1 label", /info: enc\.encode\("odd-totp-v1"\)/.test(read("functions/_lib/totp.js")) && /name: "HKDF"/.test(read("functions/_lib/totp.js")));

  console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch((e) => { console.error(e); console.log("test258 crashed: false"); process.exit(1); });
