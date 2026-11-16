// The desktop program's server, headless: the same desktop/server.js startServer the Electron app
// runs (Miniflare → workerd → the Worker in src/worker.js → its SQLite file in <dataDir>/state/d1),
// signed in over HTTP the way the program's first minute does it. Nothing here touches Cloudflare.
//
//   const S = await openServer(dataDir);          // started (and signed in: a new folder gets an owner)
//   const r = await S.orders({ action: "getOpenOrders" });   // → { status, ms, bytes, body }
//   await S.stop();
const fs = require("fs");
const path = require("path");
const { performance } = require("perf_hooks");
const { startServer } = require(path.join(__dirname, "..", "..", "desktop", "server.js"));

const OWNER = { name: "Pat Example", email: "owner@example.com", pass: "a long scale-test password" };

// The SQLite file Miniflare keeps the database in (one .sqlite under state/d1).
function sqlitePath(dataDir) {
  const dir = path.join(dataDir, "state", "d1", "miniflare-D1DatabaseObject");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith(".sqlite") && f !== "metadata.sqlite") : [];
  if (files.length !== 1) throw new Error("Expected one .sqlite in " + dir + ", found " + files.length);
  return path.join(dir, files[0]);
}

async function openServer(dataDir, { timeoutMs = 120000, quiet = !process.env.PERF_SERVER_LOG } = {}) {
  const t0 = performance.now();
  const s = await startServer({ dataDir, port: 0, onOutput: quiet ? () => {} : (o) => process.stdout.write("  [server] " + o) });
  const startMs = performance.now() - t0;
  const origin = s.url.replace(/\/$/, "");
  let cookie = "";

  async function call(p, body, { timeout = timeoutMs } = {}) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    const t = performance.now();
    try {
      const res = await fetch(origin + p, { method: "POST", signal: ac.signal,
        headers: { "content-type": "application/json", origin, cookie: cookie ? "__Host-odd_admin=" + cookie : "" },
        body: JSON.stringify(body) });
      const text = await res.text();
      const ms = performance.now() - t;
      const set = (res.headers.get("set-cookie") || "").match(/__Host-odd_admin=([^;]*)/);
      if (set) cookie = set[1];
      let json = null; try { json = JSON.parse(text); } catch (e) { /* a PDF or HTML answer */ }
      return { status: res.status, ms, bytes: Buffer.byteLength(text), body: json, text: json ? null : text.slice(0, 300) };
    } catch (e) {
      if (e && e.name === "AbortError") return { status: 0, ms: performance.now() - t, bytes: 0, body: null, timeout: true };
      throw e;
    } finally { clearTimeout(timer); }
  }

  // A new folder: the installer's passphrase, then the owner's account. An existing one: the owner.
  const key = await s.firstRunKey();
  if (key) {
    const a = await call("/api/admin-session", { email: "", key });
    if (a.status !== 200) throw new Error("First sign-in failed: " + a.status + " " + JSON.stringify(a.body));
    const b = await call("/api/admin-password", { action: "account", name: OWNER.name, email: OWNER.email, next: OWNER.pass });
    if (b.status !== 200) throw new Error("Account setup failed: " + b.status + " " + JSON.stringify(b.body));
  }
  const c = await call("/api/admin-session", { email: OWNER.email, key: OWNER.pass });
  if (c.status !== 200 || !cookie) throw new Error("Sign-in failed: " + c.status + " " + JSON.stringify(c.body));

  return {
    url: s.url, startMs, dataDir, server: s,
    call,
    orders: (body, opts) => call("/api/orders", body, opts),
    // An action that must work (setting up data): its body, or a thrown error that says why.
    async must(body) {
      const r = await call("/api/orders", body);
      if (r.status !== 200 || (r.body && r.body.status === "error")) {
        throw new Error(body.action + " failed: " + r.status + " " + JSON.stringify(r.body || r.text).slice(0, 400));
      }
      return r.body;
    },
    sqlitePath: () => sqlitePath(dataDir),
    async stop() { await s.stop(); },
  };
}

module.exports = { openServer, sqlitePath, OWNER };
