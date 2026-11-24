const { makeAuth, read } = require("./testlib/auth-harness");
const { storefrontPage } = require("./testlib/storefront-page");
const { autoConfirm } = require("./testlib/confirm.js");
const { JSDOM, ResourceLoader } = require("jsdom");

// Users → Roles and permissions, from the page itself (343e242, "the eight bugs the end-to-end suite found"; coverage
// report 57.1). The admin page signs every request with `key` — "cookie" when signed in with its session — so the
// role a saveRole / deleteRole acts on travels as `roleKey`. Before the fix the page sent the role as `key` and the
// server read "cookie" as a role: every "+ Add role" answered "No such role.". test115 drives the endpoint with the old
// `key` spelling; here the real admin.js (jsdom) adds, renames and deletes a role through the real admin-users.js on
// real SQL, signed in as an admin with a session cookie — and the endpoint's reading of both spellings is checked.
// Invented people only.
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const wait = async (cond, n = 400) => { for (let i = 0; i < n && !cond(); i++) await new Promise(r => setTimeout(r, 10)); return cond(); };

(async () => {
  const A = await makeAuth();
  const admin = await A.firstAdmin("Olive Owner", "olive@example.test");
  const roles = () => A.d1.q("SELECT key, name, rank FROM roles ORDER BY key");
  const custom = () => roles().filter(r => /^r_/.test(r.key));

  console.log("=== The endpoint: which role a request names ===");
  // The page's own spelling: key is the session ("cookie"), roleKey absent for a new role.
  let r = await A.users({ key: "cookie", action: "saveRole", name: "Night shift", rank: 20, permissions: { fns: { "orders.details": "read" } } }, admin);
  const night = r.body && r.body.role && r.body.role.key;
  ok("key \"cookie\" and no roleKey adds a role (it used to answer \"No such role.\")", r.status === 200 && /^r_/.test(night || "") && custom().length === 1);
  r = await A.users({ key: "cookie", roleKey: night, action: "saveRole", name: "Night crew", rank: 20, permissions: { fns: {} } }, admin);
  ok("key \"cookie\" with roleKey changes that role, adding none", r.status === 200 && r.body.role.key === night && custom().length === 1 && custom()[0].name === "Night crew");
  r = await A.users({ key: night, action: "saveRole", name: "Night team", rank: 20, permissions: { fns: {} } }, admin);
  ok("an older caller that names the role as key (no roleKey) still changes it", r.status === 200 && r.body.role.key === night && custom()[0].name === "Night team");
  r = await A.users({ key: "production", roleKey: night, action: "saveRole", name: "Night team", rank: 21, permissions: { fns: {} } }, admin);
  ok("roleKey wins over key when both are sent", r.status === 200 && r.body.role.key === night && custom()[0].rank === 21);
  r = await A.users({ key: "cookie", roleKey: "r_nosuchrole", action: "saveRole", name: "Ghost", rank: 10, permissions: { fns: {} } }, admin);
  ok("a roleKey that isn't a role is refused (404), and nothing is added", r.status === 404 && /No such role/.test(r.body.message) && custom().length === 1);
  r = await A.users({ key: "cookie", action: "deleteRole" }, admin);
  ok("deleteRole with only key \"cookie\" names no role: \"No such role.\", nothing deleted", r.status === 404 && custom().length === 1);
  r = await A.users({ key: "cookie", roleKey: night, action: "deleteRole" }, admin);
  ok("deleteRole with roleKey deletes that role", r.status === 200 && custom().length === 0);

  console.log("\n=== The page: + Add role, Save role, Delete role ===");
  const adminJs = read("public/admin.js");
  const sent = [], toasts = [];
  class Loader extends ResourceLoader { fetch(url, o) { return Promise.resolve(Buffer.from(url.includes("/admin.js") ? adminJs : "")); } }
  const dom = new JSDOM(storefrontPage(), { runScripts: "dangerously", resources: new Loader(), url: "https://admin.example.com/#users", pretendToBeVisual: true,
    beforeParse(win) {
      autoConfirm(win, () => true);
      win.fetch = async (url, init) => {
        const b = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
        if (String(url).includes("/api/admin-users")) {
          sent.push(b);
          // The browser sends the session cookie by itself; the page's body says only "cookie".
          const x = await A.users(b, admin);
          return { ok: x.status < 400, status: x.status, json: async () => x.body };
        }
        return { ok: false, status: 404, json: async () => ({ status: "error", message: "not here" }) };
      };
    } });
  const w = dom.window, d = w.document;
  await new Promise(res => setTimeout(res, 150));
  await w.loadAdminScript();
  w.showToast = (m, isErr) => toasts.push({ m: String(m), err: !!isErr });
  w.eval('adminKey = "cookie";');
  const app = d.getElementById("app");
  await w.renderUsers(app);
  await wait(() => d.querySelector('[data-tab="roles"]'));
  await w.usersShowTab_("roles");
  await wait(() => d.querySelector(".role-chips"));
  const btn = (label) => [...d.querySelectorAll("#adminPanel button")].find(b => b.textContent.trim() === label);
  ok("(the Roles tab is drawn, with + Add role)", !!btn("＋ Add role") && d.querySelectorAll(".role-chip").length >= 4);

  btn("＋ Add role").click();
  await wait(() => btn("Add role"));
  const name = d.getElementById("roleName");
  name.value = "Weekend packers"; name.dispatchEvent(new w.Event("input", { bubbles: true }));
  sent.length = 0;
  btn("Add role").click();
  await wait(() => toasts.some(t => /Role added/.test(t.m)) && btn("Save role"));
  const add = sent.find(b => b.action === "saveRole");
  ok("+ Add role → Add role: the request is signed with key \"cookie\" and names no role", !!add && add.key === "cookie" && !("roleKey" in add) && add.name === "Weekend packers");
  ok("…the role is added (\"Role added.\", no error), and only one", toasts.some(t => t.m === "Role added.") && !toasts.some(t => t.err) &&
    custom().length === 1 && custom()[0].name === "Weekend packers");
  const added = custom()[0].key;
  ok("…the page then shows it, selected, with Save role and Delete role", w.eval("_roleDraft && _roleDraft.key") === added && !!btn("Save role") && !!btn("Delete role") &&
    [...d.querySelectorAll(".role-chip[aria-pressed='true']")].some(c => /Weekend packers/.test(c.textContent)));

  d.getElementById("roleName").value = "Weekend crew"; d.getElementById("roleName").dispatchEvent(new w.Event("input", { bubbles: true }));
  sent.length = 0; toasts.length = 0;
  btn("Save role").click();
  await wait(() => toasts.some(t => /Role saved/.test(t.m)));
  const save = sent.find(b => b.action === "saveRole");
  ok("Save role: key \"cookie\", and the role as roleKey", !!save && save.key === "cookie" && save.roleKey === added);
  ok("…that role is renamed; no second role is made", !toasts.some(t => t.err) && custom().length === 1 && custom()[0].key === added && custom()[0].name === "Weekend crew");

  sent.length = 0; toasts.length = 0;
  btn("Delete role").click();
  await wait(() => toasts.some(t => /Role deleted/.test(t.m)));
  const del = sent.find(b => b.action === "deleteRole");
  ok("Delete role (confirmed): key \"cookie\", and the role as roleKey", !!del && del.key === "cookie" && del.roleKey === added);
  ok("…the role is gone and the page no longer lists it", custom().length === 0 && !toasts.some(t => t.err) &&
    ![...d.querySelectorAll(".role-chip")].some(c => /Weekend crew/.test(c.textContent)));
  ok("…and the audit log has the three changes", A.audit("security.role_created").length === 2 && A.audit("security.role_deleted").length === 2 &&
    A.audit("security.role_changed").length >= 1);

  console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch((e) => { console.error(e); console.log("test254 crashed: false"); process.exit(1); });
