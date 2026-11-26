const { makeAuth, read } = require("./testlib/auth-harness");

// Changing your OWN sign-in email on the Users screen needs your current password (second review, 2026-11-25).
// Every other change to how you sign in (password, two-step) asks for proof it is you, but Users → Edit on your own
// row saved a new email with nothing asked: anyone holding your session (an unlocked browser) could move the account
// to an address of theirs. Now a new email for yourself needs your current password, checked within the same
// budgets as Change password; a new name needs nothing, and changing someone else's row is as it was.
// The real sign-in code and Users endpoint (testlib/auth-harness.js) on real SQL. Invented data only.

let failed = 0, passed = 0;
const ok = (label, cond) => { cond ? passed++ : failed++; console.log(label + ": " + !!cond); };

(async () => {
  const A = await makeAuth();
  const admin = await A.firstAdmin("Olive Owner", "olive@example.test", "correct horse battery");
  await A.addUser(admin, "staff", "Sam Staff", "sam@example.test", "sams own password");
  const me = A.user("olive@example.test").id, sam = A.user("sam@example.test").id;
  const audits = () => A.audit("security.user_updated").length;
  let r;

  console.log("=== Your own email ===");
  A.hits.length = 0;
  let before = audits();
  r = await A.users({ action: "update", id: me, name: "Olive Owner", email: "someone.else@example.test" }, admin);
  ok("a new email for yourself with no password is refused", r.status === 403 && r.body.code === "current_password_needed" && /current password/i.test(r.body.message));
  ok("…the email is unchanged, nothing is written to the audit log, nothing counted as a guess",
    A.user("olive@example.test") && audits() === before && A.hits.length === 0);
  r = await A.users({ action: "update", id: me, name: "Olive Owner", email: "someone.else@example.test", current: "not my password" }, admin);
  ok("with a wrong password it is refused as Change password refuses one", r.status === 401 && r.body.code === "wrong_password");
  ok("…unchanged, and counted against the failed-sign-in budget", !!A.user("olive@example.test") && !A.user("someone.else@example.test") && A.hits.length === 1 && A.hits[0] === "admin_auth");
  ok("…and the session is still good", (await A.users({ action: "list" }, admin)).status === 200);
  r = await A.users({ action: "update", id: me, name: "Olive Owner", email: "olive.new@example.test", current: "correct horse battery" }, admin);
  ok("with your current password it is saved", r.status === 200 && r.body.user.email === "olive.new@example.test" && !!A.user("olive.new@example.test") && audits() === before + 1);
  ok("…and you sign in with the new email", (await A.signIn("olive.new@example.test", "correct horse battery")).status === 200);
  before = audits();
  r = await A.users({ action: "update", id: me, name: "Olive O. Owner", email: "OLIVE.NEW@example.test" }, admin);
  ok("a new name needs no password (nor the same email typed in capitals)", r.status === 200 && A.user("olive.new@example.test").name === "Olive O. Owner" && audits() === before + 1);

  console.log("\n=== Someone else's row ===");
  r = await A.users({ action: "update", id: sam, name: "Sam Staff", email: "sam.new@example.test" }, admin);
  ok("an admin changes another user's email as before, with no password asked", r.status === 200 && !!A.user("sam.new@example.test"));

  console.log("\n=== The code says so ===");
  const src = read("functions/api/admin-users.js");
  const upd = src.slice(src.indexOf('if(action === "update"){'), src.indexOf('if(action === "setRole" || action === "setStatus"){'));
  ok("update checks your current password with checkCurrentPassword before saving your own new email",
    /if\(isMe && email !== /.test(upd) && /checkCurrentPassword\(env, request, target, current\)/.test(upd) && upd.indexOf("checkCurrentPassword") < upd.indexOf("updateUser("));
  const ui = read("public/admin.js");
  ok("the Users screen asks for it on your own row, and shows the server's answer by the field",
    /id="userCurrent"/.test(ui) && /function usersOwnEmailChange_\(\)/.test(ui) && /userCurrentError/.test(ui) && /usersEmailInput_\(\)\{ usersShowCurrent_\(\); \}/.test(ui));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})().catch(e => { console.error(e); console.log("test357 ran to the end without crashing: false"); process.exitCode = 1; });
