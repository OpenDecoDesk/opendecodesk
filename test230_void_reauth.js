// Voiding an order asks for the person's password again WITHOUT signing them out first: the server checks it
// belongs to the user of the current session (POST /api/admin-session with verify) and issues nothing; Cancel or a
// wrong password keeps the session. The row button says what it does ("Void…").
const fs = require("fs");
const { storefrontPage } = require("./testlib/storefront-page");
const { JSDOM, ResourceLoader } = require("jsdom");
const { makeAuth, request, answer } = require("./testlib/auth-harness");

const ok = (d, v) => console.log(d + ":", !!v);
const tick = (ms) => new Promise(r => setTimeout(r, ms || 5));
const wait = async (f) => { for (let i = 0; i < 200 && !f(); i++) await tick(5); return f(); };

(async () => {
  console.log("=== Server: verify checks the password of the signed-in user and keeps the session ===");
  const A = await makeAuth();
  const admin = await A.firstAdmin();
  const staff = await A.addUser(admin, "manager", "Max Manager", "max@myshop.com", "manager password 1");
  const verify = async (cookie, email, key, extra) => answer(await A.raw["/api/admin-session"].POST({ env: A.env,
    request: request("/api/admin-session", Object.assign({ email, key, verify: true }, extra || {}), { cookie }) }));
  const before = A.sessions();
  let r = await verify(staff, "max@myshop.com", "manager password 1");
  ok("the right password answers verified", r.status === 200 && r.body.verified === true);
  ok("…without issuing a session or a cookie", !r.cookie && A.sessions() === before);
  r = await verify(staff, "max@myshop.com", "a wrong password");
  ok("a wrong password is refused", r.status === 401);
  const gate = (cookie) => A.lib.requireAdmin(A.env, { kind: "admin" }, "", request("/api/orders", {}, { cookie }), "no", "staff");
  ok("…and the session still works afterwards", (await gate(staff)) === null && A.sessions() === before);
  r = await verify(staff, "olive@myshop.com", "correct horse battery");
  ok("another user's (correct) password doesn't confirm this session", r.status === 401 && !r.body.verified);
  r = await verify("", "max@myshop.com", "manager password 1");
  ok("with no session it says so (code no_session), so the page signs in the ordinary way", r.status === 401 && r.body.code === "no_session");

  console.log("\n=== Page: Cancel or a wrong password at the check keeps the user signed in ===");
  const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
  const adminJs = read("public/admin.js"), indexHtml = storefrontPage();
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return Promise.resolve(Buffer.from("")); } }
  const calls = [];
  let verifyAnswer = { status: "error", message: "Unauthorized" };
  const dom = new JSDOM(indexHtml, { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win){ win.fetch = async (url, init) => {
      const body = init && init.body ? JSON.parse(init.body) : null;
      calls.push({ url: String(url), method: (init && init.method) || "GET", body });
      if (String(url).includes("/api/admin-session") && init && init.method === "DELETE") return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
      if (String(url).includes("/api/admin-session")) return { ok: true, status: 200, json: async () => verifyAnswer };
      if (body && body.action === "voidOrder") return { ok: true, status: 200, json: async () => ({ status: "ok", voided: true }) };
      return { ok: true, status: 200, json: async () => ({ status: "error", message: "n/a" }) };
    }; } });
  const w = dom.window, d = w.document;
  await tick(150);
  await w.loadAdminScript();
  w.eval(`adminKey = "cookie"; window._ordersCache = { org1: [{ orderId: "ORD-7", orgId: "org1", customerName: "Pat Example", total: 20, items: [] }] }`);
  const voidOnce = async (answerPrompt) => {
    calls.length = 0;
    const p = w.deleteTransaction("org1", "ORD-7");
    await wait(() => d.getElementById("delReason"));
    d.getElementById("delReason").value = "Duplicate order";
    d.getElementById("delConfirm").click();
    await wait(() => d.getElementById("adminPassInput"));
    await answerPrompt();
    return p;
  };
  await voidOnce(async () => { d.querySelector(".admin-pass-cancel").click(); });
  ok("Cancel at the password: nothing is revoked, the user stays signed in, nothing is voided",
    !calls.some(c => c.method === "DELETE") && w.eval("adminKey") === "cookie" && !calls.some(c => c.body && c.body.action === "voidOrder"));

  let p = voidOnce(async () => {
    d.getElementById("adminEmailInput").value = "max@myshop.com";
    d.getElementById("adminPassInput").value = "typo";
    d.getElementById("adminPassForm").dispatchEvent(new w.Event("submit", { cancelable: true }));
  });
  await wait(() => d.querySelector(".admin-pass-error"));
  ok("a wrong password asks again in the same flow, saying why", /don't match/.test(d.querySelector(".admin-pass-error").textContent));
  ok("…still signed in (no sign-out request)", !calls.some(c => c.method === "DELETE") && w.eval("adminKey") === "cookie");
  ok("…the check is a verify, not a new sign-in", calls.some(c => c.url.includes("/api/admin-session") && c.body && c.body.verify === true));
  verifyAnswer = { status: "ok", verified: true };
  d.getElementById("adminPassInput").value = "manager password 1";
  d.getElementById("adminPassForm").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await p;
  ok("the right password voids the order, still with the same session", calls.some(c => c.body && c.body.action === "voidOrder" && c.body.reason === "Duplicate order") &&
    !calls.some(c => c.method === "DELETE") && w.eval("adminKey") === "cookie");
  ok("the row button says Void…, not Delete", /data-admin-action="deleteTransaction" style="margin-top:6px;">Void…<\/button>/.test(adminJs) && /deleteTransaction\(\)\{ deleteTransaction\(this\.dataset\.org, this\.dataset\.order\); \}/.test(adminJs));
  process.exit(0);
})().catch(e => { console.error(e); console.log("test crashed: false"); process.exit(1); });
