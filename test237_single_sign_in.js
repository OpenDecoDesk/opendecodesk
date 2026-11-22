// The admin asks for a sign-in once, however many requests need it at the same moment.
// Seen in Chrome: a screen that sends several requests at once after the session ended (or a change of
// page while the sign-in window was open) stacked two or three sign-in windows with the same field ids.
// adminLogin() now shares one sign-in between every caller waiting on it.
const fs = require("fs");
const adminJs = fs.readFileSync(__dirname + "/public/admin.js", "utf8");
const ok = (label, v) => console.log(label + ":", !!v);

const start = adminJs.indexOf("let _adminLoginInFlight = null;");
const end = adminJs.indexOf("async function adminLoginOnce_(){");
ok("adminLogin shares one sign-in between callers (the wrapper is in admin.js)", start > 0 && end > start);
const wrapper = adminJs.slice(start, end);

(async () => {
  let prompts = 0, release;
  const once = () => { prompts++; return new Promise(r => { release = r; }); };
  const api = new Function("adminLoginOnce_", wrapper + "\nreturn { adminLogin, inFlight: () => _adminLoginInFlight };")(once);

  const three = [api.adminLogin(), api.adminLogin(), api.adminLogin()];
  ok("three requests needing a sign-in at once open ONE sign-in window", prompts === 1);
  release("session-token");
  const answers = await Promise.all(three);
  ok("…and all three get that sign-in's answer", answers.every(a => a === "session-token"));
  ok("…and nothing is left waiting afterwards", api.inFlight() === null);

  const later = api.adminLogin();
  ok("a sign-in needed later (after the first finished) asks again", prompts === 2);
  release("");
  ok("…and a cancelled sign-in answers empty", (await later) === "");

  ok("the 'session ended' message is shown once, not once per request", /if\(attempt === 0\)\{ if\(!_adminLoginInFlight\) showToast\(SESSION_ENDED_, true\); continue; \}/.test(adminJs));
})();
