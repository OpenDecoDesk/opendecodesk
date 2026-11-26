// Help → Locked out? Reset sign-in… and File → Restore a backup… (main.js) each let whoever uses them in
// effect become the Admin: Reset sign-in voids every password and the window then sets up the account again,
// and a restored backup brings back the passwords that were in use when it was made. In a shop where
// staff share the computer, that is a way round every role. So, before either one:
//   1. Whoever is signed in in the program's window must be an Admin. Nobody signed in is allowed: that is
//      the locked-out owner this menu item is for.
//   2. On a Mac that has Touch ID, the person at the computer confirms with it.
// And afterwards the next start writes it in the audit log and in the roll-up's problems (server.js
// recordDesktopEvents). Anyone at the computer can still open the data folder; this slows a takeover down
// and makes it visible rather than making it impossible.
// Kept apart from main.js so the decisions can be tested without Electron (test358).

// What the server said about the window's session, and so whether the menu item may go on. `answer`:
//   null                       the window has no session cookie (nobody signed in)
//   { error }                  the server couldn't be asked
//   { status, body }           its reply to /api/admin-users { action: "me" }
// Returns { ok: true } or { ok: false, message, detail } for the dialog.
const ADMIN_ONLY = {
  ok: false,
  message: "An Admin must be signed in to do this.",
  detail: "Someone other than an Admin is signed in in the program's window. Ask an Admin to sign in, or sign out first (Settings → Sign out in the page's menu), then try again.",
};
const CANT_TELL = {
  ok: false,
  message: "Couldn't check who is signed in.",
  detail: "The program couldn't ask its server who is signed in in the window. Try again in a moment, or sign out first.",
};
function menuGateDecision(answer) {
  if (answer == null) return { ok: true };
  if (answer.error || !Number.isInteger(answer.status)) return CANT_TELL;
  // A session that has ended (or was never good) is nobody signed in.
  if (answer.status === 401) return { ok: true };
  if (answer.status !== 200 || !answer.body || answer.body.status !== "ok") return CANT_TELL;
  const user = answer.body.user;
  return user && user.role === "admin" ? { ok: true } : ADMIN_ONLY;
}

// Touch ID before acting, on a Mac that can ask for it (Electron's systemPreferences). `reason` finishes the
// system's sentence "OpenDecoDesk is trying to …". True to go on: confirmed, or no Touch ID to ask; false when
// it was cancelled or failed.
async function confirmWithTouchId({ platform, systemPreferences }, reason) {
  if (platform !== "darwin" || !systemPreferences || typeof systemPreferences.canPromptTouchID !== "function") return true;
  let can = false;
  try { can = !!systemPreferences.canPromptTouchID(); } catch (e) { can = false; }
  if (!can) return true;
  try { await systemPreferences.promptTouchID(reason); return true; }
  catch (e) { return false; }
}

module.exports = { menuGateDecision, confirmWithTouchId };
