const fs = require("fs");
const os = require("os");
const path = require("path");
const { createD1 } = require("./testlib/d1-shim.js");
const { readSources, migrate } = require("./desktop/migrate.js");

// The desktop program's Help → Locked out? Reset sign-in… and File → Restore a backup… (second review, 2026-11-25).
// Either one in effect hands the program to whoever uses it: Reset sign-in voids every password and the window then
// sets up the Admin account again; a restored backup brings back the passwords of its day. Both only asked "are you
// sure?", so anyone at a shared computer — Production staff, say — could make themselves Admin in two clicks, and
// nothing anywhere said so. Now:
//   - both are refused while someone other than an Admin is signed in in the window (nobody signed in is allowed:
//     that is the locked-out owner the menu item is for), asked of the server as Global settings already does;
//   - on a Mac with Touch ID, the person at the computer confirms with it first; cancelled, nothing happens;
//   - the next start writes each in the audit log (actor "desktop") and as a problem in the roll-up.
// The decisions are desktop/menu-gate.js (no Electron needed); the record is desktop/server.js on a real database.

let failed = 0, passed = 0;
const ok = (label, cond) => { cond ? passed++ : failed++; console.log(label + ": " + !!cond); };
const read = (p) => fs.readFileSync(path.join(__dirname, p), "utf8");

(async () => {
  const gate = require("./desktop/menu-gate.js");
  const server = require("./desktop/server.js");

  console.log("=== Who may use them ===");
  const me = (role, extra = {}) => ({ status: 200, body: Object.assign({ status: "ok", user: { id: 1, name: "Someone", role } }, extra) });
  ok("nobody signed in in the window (no session cookie): allowed — the locked-out owner", gate.menuGateDecision(null).ok === true);
  ok("a session that has ended (the server says 401): allowed, as nobody signed in", gate.menuGateDecision({ status: 401, body: { status: "error" } }).ok === true);
  ok("an Admin signed in: allowed", gate.menuGateDecision(me("admin")).ok === true);
  ok("…even one with a step still to finish", gate.menuGateDecision(me("admin", { pending: "2fa" })).ok === true);
  const refused = ["manager", "staff", "production", "a-custom-role"].map((r) => gate.menuGateDecision(me(r)));
  ok("a Manager, Back office, Production or a custom role signed in: refused", refused.every((d) => d.ok === false));
  ok("…saying an Admin must be signed in, or the window signed out", refused.every((d) => d.message === "An Admin must be signed in to do this." && /sign out first/.test(d.detail)));
  ok("the server couldn't be asked: refused (never taken as nobody signed in)", gate.menuGateDecision({ error: true }).ok === false && /Couldn't check who is signed in/.test(gate.menuGateDecision({ error: true }).message));
  ok("…nor an answer that isn't a clear yes or no", [{ status: 500, body: {} }, { status: 403, body: { status: "error" } }, { status: 200, body: { status: "error" } }, { status: 200, body: { status: "ok" } }]
    .every((a) => gate.menuGateDecision(a).ok === false));

  console.log("\n=== Touch ID on a Mac ===");
  const asked = [];
  const prefs = (can, answer) => ({ canPromptTouchID: () => can, promptTouchID: async (reason) => { asked.push(reason); if (answer !== "yes") throw new Error("cancelled"); } });
  ok("a Mac with Touch ID asks for it, with what for, and goes on when it is given", await gate.confirmWithTouchId({ platform: "darwin", systemPreferences: prefs(true, "yes") }, "reset sign-in") === true && asked.join() === "reset sign-in");
  ok("…and does nothing when it is cancelled or fails", await gate.confirmWithTouchId({ platform: "darwin", systemPreferences: prefs(true, "no") }, "restore a backup") === false && asked.length === 2);
  ok("a Mac without Touch ID goes on without asking", await gate.confirmWithTouchId({ platform: "darwin", systemPreferences: prefs(false, "no") }, "reset sign-in") === true && asked.length === 2);
  ok("Windows and Linux go on without asking", await gate.confirmWithTouchId({ platform: "win32", systemPreferences: prefs(true, "no") }, "reset sign-in") === true &&
    await gate.confirmWithTouchId({ platform: "linux", systemPreferences: undefined }, "reset sign-in") === true && asked.length === 2);

  console.log("\n=== The menu items use them ===");
  const main = read("desktop/main.js");
  const fn = (name) => main.slice(main.indexOf("async function " + name + "("), main.indexOf("\n}\n", main.indexOf("async function " + name + "(")));
  const reset = fn("resetSignInMenu"), restore = fn("restore");
  ok("Reset sign-in asks who is signed in first, then Touch ID, before anything is changed",
    /^async function resetSignInMenu\(\) \{\n  if \(!\(await menuActionMayRun\(\)\)\) return;/.test(reset) &&
    reset.indexOf('confirmWithTouchId({ platform: process.platform, systemPreferences }, "reset sign-in")') > 0 &&
    reset.indexOf("confirmWithTouchId") < reset.indexOf("resetSignIn(dataDir"));
  ok("Restore a backup the same, and notes the restore for the next start",
    /^async function restore\(\) \{\n  if \(!\(await menuActionMayRun\(\)\)\) return;/.test(restore) &&
    restore.indexOf('confirmWithTouchId({ platform: process.platform, systemPreferences }, "restore a backup")') > 0 &&
    restore.indexOf("confirmWithTouchId") < restore.indexOf("restoreState(dataDir") && restore.indexOf("restoreState(dataDir") < restore.indexOf("noteRestored(dataDir, crypt())"));
  ok("who is signed in is asked of the server, as Global settings asks (a failure refuses)",
    /const d = menuGateDecision\(answer\);/.test(main) && /answer = await askWhoIsSignedIn\(\);/.test(main) && /catch \(err\) \{[^}]*answer = \{ error: true \};/.test(main) &&
    /const answer = await askWhoIsSignedIn\(\);/.test(fn("signedInMayEditSettings")));
  ok("the installed program carries menu-gate.js", JSON.parse(read("desktop/package.json")).build.files.includes("menu-gate.js"));

  console.log("\n=== Written down at the next start ===");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "odd-menu-gate-"));
  try {
    const cfgOf = () => JSON.parse(fs.readFileSync(path.join(tmp, "desktop.json"), "utf8"));
    fs.writeFileSync(path.join(tmp, "desktop.json"), JSON.stringify({ port: 47832, secrets: { SIGNING_SECRET: "s", PROXY_ADMIN_PASSPHRASE: "p", VENDOR_CREDENTIALS_KEY: "v", PASSWORD_PEPPER: "pp" } }));
    server.resetSignIn(tmp);
    ok("Reset sign-in keeps the time it was done for the next start", !isNaN(Date.parse(cfgOf().signInResetAt)) && cfgOf().secrets.PROXY_ADMIN_PASSPHRASE !== "p");
    server.noteRestored(tmp);
    ok("so does a restore", !isNaN(Date.parse(cfgOf().restoredAt)) && cfgOf().secrets.PASSWORD_PEPPER === "pp");
    const db = await createD1();
    await migrate(db, readSources(__dirname));
    const written = await server.recordDesktopEvents(db, cfgOf());
    const audit = db.q("SELECT action, actor, detail FROM audit_log ORDER BY id");
    ok("the next start writes both in the audit log, as done from the desktop", written.join() === "signInResetAt,restoredAt" &&
      audit.map((a) => a.action).join() === "security.desktop_signin_reset,security.desktop_restore" && audit.every((a) => a.actor === "desktop") &&
      JSON.parse(audit[0].detail).at === cfgOf().signInResetAt);
    const issues = db.q("SELECT kind, sample FROM system_issues ORDER BY id");
    ok("…and as problems for the owner's roll-up", issues.length === 2 && issues.every((i) => i.kind === "desktop_menu") &&
      /^Sign-in was reset in the desktop program at /.test(issues[0].sample) && /^A backup was restored from the desktop program's menu at /.test(issues[1].sample));
    const { SYSTEM_ISSUE_LABELS } = await import("./functions/_lib/db.js");
    ok("…which the roll-up and Communications name in plain words", /desktop program's menu/.test(SYSTEM_ISSUE_LABELS.desktop_menu || ""));
    ok("with nothing new since the last start, nothing is written", (await server.recordDesktopEvents(db, { port: 1 })).length === 0 && db.q("SELECT count(*) n FROM audit_log")[0].n === 2);
    const broken = { prepare: db.prepare.bind(db), batch: async () => { throw new Error("database locked"); } };
    const logged = [];
    const none = await server.recordDesktopEvents(broken, cfgOf(), (m) => logged.push(m));
    ok("a write that fails is logged and writes nothing, so the start keeps the marks and tries again next time", none.length === 0 &&
      /Couldn't write the reset or restore in the audit log/.test(logged.join()) && db.q("SELECT count(*) n FROM audit_log")[0].n === 2);
    const src = read("desktop/server.js");
    const start = src.slice(src.indexOf("async function startServer("), src.indexOf("pruneUpdateCopies(dataDir, { log });"));
    ok("startServer writes them after updating the database, and forgets only those written",
      /const result = await migrate\(db, src\);\n  const written = await recordDesktopEvents\(db, cfg, log\);[\s\S]*for \(const k of written\) delete cfg\[k\];\n  saveConfig\(dataDir, cfg, secrets, \{ protect \}\);/.test(start));
    fs.writeFileSync(path.join(tmp, "desktop.json"), JSON.stringify({ port: 47832, secretsProtected: "not readable here" }));
    const before = fs.readFileSync(path.join(tmp, "desktop.json"), "utf8");
    server.noteRestored(tmp);
    ok("a restore note never saves over secrets it couldn't read", fs.readFileSync(path.join(tmp, "desktop.json"), "utf8") === before);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  ok("the Audit log screen names the two entries", /"security\.desktop_signin_reset": "Sign-in reset in the desktop program"/.test(read("public/admin.js")) &&
    /"security\.desktop_restore":\s+"Backup restored in the desktop program"/.test(read("public/admin.js")));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})().catch((e) => { console.error(e); console.log("test358 ran to the end without crashing: false"); process.exitCode = 1; });
