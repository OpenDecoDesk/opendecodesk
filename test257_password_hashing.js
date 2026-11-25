const fs = require("fs");
const os = require("os");
const path = require("path");
const { makeAuth } = require("./testlib/auth-harness");

// How passwords are stored (review #75; functions/_lib/adminAuth.js). PBKDF2 with 100,000 rounds in the desktop
// edition; 10,000 on Cloudflare (the Free plan's CPU limit per request) unless PASSWORD_ITERATIONS says more, up to
// 100,000. The hash is keyed with PASSWORD_PEPPER, a random secret of its own, when the install has one, else with
// the passphrase as before; each record says which, so adding a pepper voids nobody. A record made with fewer rounds,
// or before the pepper, is remade at its user's next sign-in. Replacing the passphrase still voids every password.
// The installer and the desktop program make the pepper only when there is none. Real SQL (sql.js) under the real
// adminAuth.js and sign-in endpoints; invented people.
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

(async () => {
  console.log("=== How many rounds ===");
  const A = await makeAuth();
  const it = (env) => A.lib.passwordIterations(env);
  ok("on Cloudflare 10,000 unless PASSWORD_ITERATIONS says otherwise", it({}) === 10000 && it({ PASSWORD_ITERATIONS: "" }) === 10000 && it({ PASSWORD_ITERATIONS: "lots" }) === 10000 && it({ PASSWORD_ITERATIONS: "50000" }) === 50000);
  ok("…never more than 100,000 (a Worker's PBKDF2 limit) and never fewer than 10,000", it({ PASSWORD_ITERATIONS: "900000" }) === 100000 && it({ PASSWORD_ITERATIONS: 500 }) === 10000 && it({ PASSWORD_ITERATIONS: "0" }) === 10000);
  ok("the desktop edition always uses 100,000", it({ EDITION: "desktop" }) === 100000 && it({ EDITION: " Desktop ", PASSWORD_ITERATIONS: "20000" }) === 100000);
  const deskRec = JSON.parse(await A.lib.passwordRecordFor_({ ...A.env, EDITION: "desktop" }, "a desktop password"));
  ok("…and a password set there is stored with 100,000", deskRec.iterations === 100000 && /^[0-9a-f]{64}$/.test(deskRec.hash));

  console.log("\n=== A record with fewer rounds is upgraded at the next sign-in ===");
  const PW = "correct horse battery";
  await A.firstAdmin("Olive Owner", "olive@example.test", PW);
  const rec0 = JSON.parse(A.user("olive@example.test").password);
  ok("a cloud install stores 10,000 rounds, keyed with the passphrase (no pepper)", rec0.iterations === 10000 && !("pepper" in rec0));
  A.env.PASSWORD_ITERATIONS = "100000";   // a paid plan raises it
  ok("a wrong password is refused and changes nothing", (await A.signIn("olive@example.test", PW + "x")).status === 401 && A.user("olive@example.test").password === JSON.stringify(rec0));
  ok("the 10,000-round record still signs in", (await A.signIn("olive@example.test", PW)).status === 200);
  const rec1 = JSON.parse(A.user("olive@example.test").password);
  ok("…and is remade with 100,000 rounds, a new salt and hash, the same mark and the same changed date", rec1.iterations === 100000 && rec1.salt !== rec0.salt && rec1.hash !== rec0.hash &&
    rec1.mark === rec0.mark && rec1.changedAt === rec0.changedAt);
  ok("…which signs in, and isn't remade again", (await A.signIn("olive@example.test", PW)).status === 200 && A.user("olive@example.test").password === JSON.stringify(rec1));
  A.env.PASSWORD_ITERATIONS = "10000";
  ok("lowering the setting never weakens a record already made", (await A.signIn("olive@example.test", PW)).status === 200 && JSON.parse(A.user("olive@example.test").password).iterations === 100000);

  console.log("\n=== Adding a pepper to an install that had none ===");
  A.env.PASSWORD_PEPPER = "a".repeat(64);
  ok("the password made under the passphrase still signs in", (await A.signIn("olive@example.test", PW)).status === 200);
  const rec2 = JSON.parse(A.user("olive@example.test").password);
  ok("…and is remade under the pepper (marked with which pepper), with a new salt", /^[0-9a-f]{16}$/.test(rec2.pepper) && rec2.salt !== rec1.salt && rec2.hash !== rec1.hash && rec2.mark === rec0.mark && rec2.changedAt === rec0.changedAt);
  ok("…and signs in from then on", (await A.signIn("olive@example.test", PW)).status === 200 && A.user("olive@example.test").password === JSON.stringify(rec2));
  delete A.env.PASSWORD_PEPPER;
  ok("taken away again, the pepper-made record no longer works (it isn't silently checked against the passphrase)", (await A.signIn("olive@example.test", PW)).status === 401);
  A.env.PASSWORD_PEPPER = "b".repeat(64);
  ok("nor under a different pepper", (await A.signIn("olive@example.test", PW)).status === 401);
  A.env.PASSWORD_PEPPER = "a".repeat(64);
  ok("with the same pepper back it works", (await A.signIn("olive@example.test", PW)).status === 200);

  console.log("\n=== An install with a pepper from the start ===");
  const P = await makeAuth();
  P.env.PASSWORD_PEPPER = "c".repeat(64);
  const pAdmin = await P.firstAdmin("Pat Owner", "pat@example.test", PW);
  const prec = JSON.parse(P.user("pat@example.test").password);
  ok("the first admin's password is stored under the pepper, and signs in", /^[0-9a-f]{16}$/.test(prec.pepper) && !!pAdmin && (await P.signIn("pat@example.test", PW)).status === 200);
  const made = await P.users({ action: "create", name: "Sam Staff", email: "sam@example.test", role: "staff" }, pAdmin);
  ok("so is a temporary password given to a new user", made.status === 200 && /^[0-9a-f]{16}$/.test(JSON.parse(P.user("sam@example.test").password).pepper) &&
    (await P.signIn("sam@example.test", made.body.temporaryPassword)).status === 200);
  const forged = Object.assign({}, prec); delete forged.pepper;
  P.d1._raw.exec(`UPDATE users SET password = '${JSON.stringify(forged)}' WHERE email = 'pat@example.test'`);
  ok("the hash really is keyed with the pepper: the same record claiming the passphrase doesn't match", (await P.signIn("pat@example.test", PW)).status === 401);
  P.d1._raw.exec(`UPDATE users SET password = '${JSON.stringify(prec)}' WHERE email = 'pat@example.test'`);
  P.d1._raw.exec(`UPDATE users SET password = '${JSON.stringify(Object.assign({}, prec, { pepper: "not a mark" }))}' WHERE email = 'sam@example.test'`);
  ok("a record whose pepper field isn't a mark isn't a password", (await P.signIn("sam@example.test", made.body.temporaryPassword)).status === 401);
  P.env.PROXY_ADMIN_PASSPHRASE = "a-new-passphrase-after-a-lockout";
  ok("replacing the passphrase still voids every password, pepper or not", (await P.signIn("pat@example.test", PW)).status === 401);

  console.log("\n=== Where the pepper comes from ===");
  const server = require("./desktop/server.js");
  const older = { SIGNING_SECRET: "s", PROXY_ADMIN_PASSPHRASE: "p", VENDOR_CREDENTIALS_KEY: "v" };
  const added = server.withNewSecrets(older);
  ok("the desktop program gives an install from before the pepper one, keeping every saved secret", /^[0-9a-f]{64}$/.test(added.PASSWORD_PEPPER) && added.SIGNING_SECRET === "s" && added.PROXY_ADMIN_PASSPHRASE === "p" && !("PASSWORD_PEPPER" in older));
  ok("…and never replaces one it has", server.withNewSecrets(added) === added && server.withNewSecrets(added).PASSWORD_PEPPER === added.PASSWORD_PEPPER);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "odd-pepper-"));
  try {
    fs.writeFileSync(path.join(tmp, "desktop.json"), JSON.stringify({ port: 47831, secrets: { ...older, PASSWORD_PEPPER: "the-saved-pepper" } }));
    server.resetSignIn(tmp);
    const after = JSON.parse(fs.readFileSync(path.join(tmp, "desktop.json"), "utf8")).secrets;
    ok("Reset sign-in replaces the passphrase but keeps the pepper", after.PASSWORD_PEPPER === "the-saved-pepper" && after.PROXY_ADMIN_PASSPHRASE !== "p");
    fs.writeFileSync(path.join(tmp, "desktop.json"), JSON.stringify({ port: 47831, secretsProtected: "not readable here" }));
    server.resetSignIn(tmp);
    ok("…and new secrets (nothing readable to keep) include one", /^[0-9a-f]{64}$/.test(JSON.parse(fs.readFileSync(path.join(tmp, "desktop.json"), "utf8")).secrets.PASSWORD_PEPPER));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  const setupSrc = fs.readFileSync(__dirname + "/scripts/setup.mjs", "utf8");
  ok("the installer makes it only when the Worker hasn't one (test108 runs it twice; test290 when the secrets can't be listed)", /const missing = \(name\) => !existing\.includes\(name\) && /.test(setupSrc) &&
    /for \(const name of \["SIGNING_SECRET", "CRON_SECRET", "PASSWORD_PEPPER"\]\) if \(missing\(name\)\)/.test(setupSrc) &&
    /SECRET_NAMES = \[[^\]]*"PASSWORD_PEPPER"/.test(setupSrc));
  ok("the settings are documented", /`PASSWORD_ITERATIONS`/.test(fs.readFileSync(__dirname + "/docs/configuration.md", "utf8")) && /`PASSWORD_PEPPER`/.test(fs.readFileSync(__dirname + "/docs/configuration.md", "utf8")));

  console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch((e) => { console.error(e); console.log("test257 crashed: false"); process.exit(1); });
