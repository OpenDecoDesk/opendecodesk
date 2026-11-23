// A session that has ended (24 hours, or signed out elsewhere) is handled the same way on every screen: the call
// asks to sign in again and is repeated once, so the edit isn't lost; the orders list does the same instead of
// "Server error (HTTP 401)". Every screen's API helper goes through the one adminApi_.
const fs = require("fs");
const { storefrontPage } = require("./testlib/storefront-page");
const { JSDOM, ResourceLoader } = require("jsdom");

const ok = (d, v) => console.log(d + ":", !!v);
const tick = (ms) => new Promise(r => setTimeout(r, ms || 5));
const wait = async (f) => { for (let i = 0; i < 200 && !f(); i++) await tick(5); return f(); };

(async () => {
  const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
  const adminJs = read("public/admin.js"), indexHtml = storefrontPage();
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return Promise.resolve(Buffer.from("")); } }
  const calls = [];
  let expired = 0;   // how many /api/orders calls answer 401 before the session is good again
  const dom = new JSDOM(indexHtml, { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win){ win.fetch = async (url, init) => {
      const body = init && init.body ? JSON.parse(init.body) : null;
      calls.push({ url: String(url), method: (init && init.method) || "GET", body });
      const json = (status, b) => ({ ok: status < 400, status, json: async () => b, text: async () => JSON.stringify(b) });
      if (String(url).includes("/api/admin-session")) return init.method === "DELETE" ? json(200, { status: "ok" }) : json(200, { status: "ok", session: "cookie", expires: new Date(Date.now() + 864e5).toISOString() });
      if (expired > 0) { expired--; return json(401, { status: "error", message: "Session expired — please log in again." }); }
      if (body && body.action === "getOrders") return json(200, { orders: [{ orderId: "ORD-1", placedAt: "2026-11-01T10:00:00Z" }] });
      return json(200, { status: "ok", saved: body && body.action });
    }; } });
  const w = dom.window, d = w.document;
  await tick(150);
  await w.loadAdminScript();
  const signInWhenAsked = async () => {
    await wait(() => d.getElementById("adminPassInput"));
    d.getElementById("adminEmailInput").value = "pat@example.com";
    d.getElementById("adminPassInput").value = "a password";
    d.getElementById("adminPassForm").dispatchEvent(new w.Event("submit", { cancelable: true }));
  };

  w.eval(`adminKey = "cookie"`);
  expired = 1; calls.length = 0;
  let p = w.threadApi_({ action: "saveThread", name: "Navy" });
  await signInWhenAsked();
  let r = await p;
  ok("Threads: an ended session asks to sign in and the save goes through after it", r && r.saved === "saveThread" &&
    calls.filter(c => c.body && c.body.action === "saveThread").length === 2 && calls.some(c => c.url.includes("/api/admin-session") && c.method === "POST"));
  ok("…the old session was forgotten first (no stuck 'cookie' key)", calls.some(c => c.method === "DELETE"));

  expired = 2; calls.length = 0;
  p = w.machineApi_({ action: "saveMachine" });
  await signInWhenAsked();
  let err = null; try { await p; } catch (e) { err = e; }
  ok("Machines: if it still fails after signing in, it says the session ended (once, no loop)", err && /session ended/.test(err.message) && calls.filter(c => c.body && c.body.action === "saveMachine").length === 2);

  expired = 1; calls.length = 0;
  w.eval(`adminKey = "cookie"`);
  p = w.expApi_({ action: "saveExpense" });
  await wait(() => d.getElementById("adminPassInput"));
  d.querySelector(".admin-pass-cancel").click();
  err = null; try { await p; } catch (e) { err = e; }
  ok("Expenses: Cancel at the sign-in leaves a clear message, and the next call asks again", err && /session ended/.test(err.message) && !w.eval("adminKey"));

  w.eval(`adminKey = "cookie"`);
  expired = 1; calls.length = 0;
  p = w.fetchOrders("org1");
  await signInWhenAsked();
  r = await p;
  ok("Orders list: an ended session asks to sign in and loads, not 'Server error (HTTP 401)'", Array.isArray(r) && r.length === 1);

  ok("every screen's API helper goes through the one adminApi_", ["designApi_", "mnApi_", "expApi_", "threadApi_", "hoopApi_", "machineApi_", "runOrderApi_"].every(n => new RegExp("async function " + n + "\\(body\\)\\{ return adminApi_\\(body\\); \\}").test(adminJs)));
  ok("no inline check looks only for the word 'Unauthorized' (the server says 'Session expired' too)", !/\.message === "Unauthorized"\) clearAdminAuth\(\)/.test(adminJs) && !/status === 401\) clearAdminAuth\(\)/.test(adminJs));
  process.exit(0);
})().catch(e => { console.error(e); console.log("test crashed: false"); process.exit(1); });
