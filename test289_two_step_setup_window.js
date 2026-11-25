const fs = require("fs");
const { JSDOM } = require("jsdom");

// The two-step set-up window (Settings → Security, public/admin.js start2FASetup / submit2FAActivate), second review
// 2026-11-25: turning two-step on asks for the current password, and the browser hands the server back the setup
// key together with the proof the server gave for it.
//   - the window has a labelled "Current password" box; what is wrong with it (left empty, or refused by the
//     server) is said in a line of its own beside it, read out to a screen reader, with the box marked and focused;
//   - Activate sends the secret, its proof, the password and the code;
//   - in the step owed at sign-in (two-step is required and this user has none) the box isn't drawn and no password
//     is sent: it was typed a moment ago, and the server doesn't ask for it there.
// The real functions from public/admin.js, run in jsdom against a stand-in for /api/admin-2fa.

const adminJs = fs.readFileSync(__dirname + "/public/admin.js", "utf8");
const cut = (from, to) => { const i = adminJs.indexOf(from), j = adminJs.indexOf(to, i); if (i < 0 || j < 0) throw new Error("not found: " + from); return adminJs.slice(i, j); };
const source = cut("async function start2FASetup(){", "function copy2FAKey(){") + "\n" + cut("async function submit2FAActivate(){", "async function submit2FADisable(){");

let failed = 0, passed = 0;
const ok = (label, cond) => { cond ? passed++ : failed++; console.log(label + ": " + !!cond); };
const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP", PROOF = "1900000000." + "ab".repeat(32);

// One page: the Security panel's set-up area, the window's two functions, and a server that answers `answers` in turn.
function open(forced, answers) {
  const dom = new JSDOM(`<!doctype html><body><div id="adminPanel"><div id="tfa-setup-area"></div></div></body>`, { url: "https://admin.example.test/", runScripts: "outside-only" });
  const w = dom.window;
  const seen = { sent: [], toasts: [], codes: null, panel: null, stepDone: null };
  w.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.sent.push(body);
    if (body.action === "generate") return { ok: true, status: 200, json: async () => ({ status: "ok", secret: SECRET, proof: PROOF, otpauthUri: "otpauth://totp/x?secret=" + SECRET }) };
    const a = answers.shift() || { status: 200, body: { status: "ok", recoveryCodes: ["aaaaa-bbbbb"], pending: null } };
    return { ok: a.status < 400, status: a.status, json: async () => a.body };
  };
  w.eval(`
    var adminKey = "cookie", _tfa = { forced: ${forced ? "true" : "false"}, required: ${forced ? "true" : "false"}, codesLeft: 0 };
    function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
    function loadQRLib(){ return Promise.resolve(); }
    function renderQRCanvas(){ return null; }
    function showToast(m){ window.__seen.toasts.push(m); }
    function render2FACodes_(codes, then){ window.__seen.codes = codes; then(); }
    function render2FAPanel(on){ window.__seen.panel = on; }
    function adminStepDone_(pending){ window.__seen.stepDone = String(pending); }
  `);
  w.__seen = seen;
  w.eval(source + "\nwindow.start2FASetup = start2FASetup; window.submit2FAActivate = submit2FAActivate;");
  const $ = (id) => w.document.getElementById(id);
  return { w, $, seen, activates: () => seen.sent.filter(b => b.action === "activate") };
}

(async () => {
  console.log("=== Settings → Security: the password is asked for ===");
  let p = open(false, [{ status: 401, body: { status: "error", code: "wrong_password", message: "The current password is not right." } },
    { status: 400, body: { status: "error", message: "Invalid code — check your device and try again." } },
    { status: 400, body: { status: "error", code: "setup_key_expired", message: "That setup key isn't one this site just made for you, or it is more than 15 minutes old." } }]);
  await p.w.start2FASetup();
  const box = p.$("tfa-current-password");
  ok("the window has a Current password box", !!box && box.type === "password");
  ok("…labelled, and filled by a password manager as the current password", !!box && p.w.document.querySelector('label[for="tfa-current-password"]').textContent.trim() === "Current password" && box.getAttribute("autocomplete") === "current-password");
  ok("…with a message line of its own that a screen reader reads out, tied to the box", !!p.$("tfa-password-error") && p.$("tfa-password-error").getAttribute("role") === "alert" &&
    box.getAttribute("aria-describedby") === "tfa-password-error" && p.$("tfa-password-error").classList.contains("admin-error"));
  ok("…above the code, in reading order", !!(box.compareDocumentPosition(p.$("tfa-verify-code")) & p.w.Node.DOCUMENT_POSITION_FOLLOWING));
  ok("the window's other message line is read out too", p.$("tfa-error").getAttribute("role") === "alert");
  ok("the server's proof is kept with the setup key", p.$("tfa-proposed-secret").value === SECRET && p.$("tfa-proof").value === PROOF);

  p.$("tfa-verify-code").value = "123456";
  await p.w.submit2FAActivate();
  ok("with the password left empty, it says so beside the box and sends nothing", p.$("tfa-password-error").textContent === "Enter your current password." && p.activates().length === 0 &&
    box.getAttribute("aria-invalid") === "true" && p.w.document.activeElement === box && p.$("tfa-error").textContent === "");

  box.value = "a wrong password";
  await p.w.submit2FAActivate();
  let sent = p.activates();
  ok("Activate sends the setup key, its proof, the password and the code", sent.length === 1 && sent[0].proposedSecret === SECRET && sent[0].proof === PROOF && sent[0].current === "a wrong password" && sent[0].code === "123456");
  ok("a password the server refuses is said beside the box, which is marked and focused", p.$("tfa-password-error").textContent === "The current password is not right." &&
    box.getAttribute("aria-invalid") === "true" && p.w.document.activeElement === box && p.$("tfa-error").textContent === "");
  ok("…and two-step isn't shown as on", p.seen.panel === null && p.seen.codes === null && p.seen.toasts.length === 0);

  box.value = "the right password";
  await p.w.submit2FAActivate();
  ok("a wrong code is said by the code, and the password box is no longer marked", /Invalid code/.test(p.$("tfa-error").textContent) && p.$("tfa-password-error").textContent === "" && !box.hasAttribute("aria-invalid"));
  await p.w.submit2FAActivate();
  ok("a setup key the server no longer takes is said in the window's own line", /setup key/.test(p.$("tfa-error").textContent) && p.$("tfa-password-error").textContent === "");
  await p.w.submit2FAActivate();
  ok("with the right password and code: the recovery codes, then the panel shows two-step on", p.seen.codes && p.seen.codes.length === 1 && p.seen.panel === true && p.seen.stepDone === null &&
    p.seen.toasts.join() === "Two-factor authentication is now active.");
  ok("the password was sent each time, exactly as typed", p.activates().length === 4 && p.activates().slice(1).every(b => b.current === "the right password"));

  console.log("\n=== The step owed at sign-in: no password box ===");
  p = open(true, []);
  await p.w.start2FASetup();
  ok("the window has no Current password box there", !p.$("tfa-current-password") && !p.$("tfa-password-error") && !/Current password/.test(p.$("tfa-setup-area").textContent));
  ok("…but still keeps the server's proof", p.$("tfa-proof").value === PROOF);
  await p.w.submit2FAActivate();
  ok("without a code it asks for the code and sends nothing", p.$("tfa-error").textContent === "Enter the 6-digit code from the app." && p.activates().length === 0);
  p.$("tfa-verify-code").value = "654321";
  await p.w.submit2FAActivate();
  sent = p.activates();
  ok("Activate sends the setup key, its proof and the code — and no password", sent.length === 1 && sent[0].proposedSecret === SECRET && sent[0].proof === PROOF && sent[0].code === "654321" && !("current" in sent[0]));
  ok("…and once the codes are saved the sign-in carries on", p.seen.codes && p.seen.stepDone === "null" && p.seen.panel === null);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})().catch(e => { console.error(e); console.log("test289 ran to the end without crashing: false"); process.exitCode = 1; });
