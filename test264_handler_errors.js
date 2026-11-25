const fs = require("fs");
const { makePlatformDb } = require("./testlib/platform-db");

// An API handler that throws gets a plain JSON error, and the error is logged and recorded (code review #95). The
// Worker entry (src/worker.js handleRequest) called the handler with no try/catch, so a bug or an uncaught database
// error gave the runtime's bare 500 page — which the admin's and the shop's pages can't read — and left the error
// only in the Worker's log. Now: a 500 JSON answer ({status:"error", message}) with Cache-Control: no-store and no
// stack, console.error with the route, and an "api_error" system issue for the next roll-up (recorded through
// ctx.waitUntil, after the answer). The real worker.js with a stand-in route.
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

(async () => {
  const w = await import("./src/worker.js");
  const db = await import("./functions/_lib/db.js");
  const req = (p, method = "GET") => new Request("https://admin.example.test" + p, { method });
  const ctx = () => { const waits = []; return { waits, waitUntil: (p) => waits.push(p), passThroughOnException() {} }; };
  const withRoute = async (handler, fn) => {
    const saved = w.ROUTES["image-proxy"];
    w.ROUTES["image-proxy"] = { onRequestGet: handler };
    try { return await fn(); } finally { w.ROUTES["image-proxy"] = saved; }
  };
  const logged = [];
  const origError = console.error;
  console.error = (...a) => logged.push(a);
  try {
    const DB = await makePlatformDb();
    const c = ctx();
    const boom = new Error("no such column: secretThing at line 12");
    const res = await withRoute(async () => { throw boom; }, () => w.handleRequest(req("/api/image-proxy?u=1"), { DB, SIGNING_SECRET: "s" }, c));
    const text = await res.text();
    let body = null; try { body = JSON.parse(text); } catch (e) { /* not JSON */ }
    ok("a handler that throws gives a 500", res.status === 500);
    ok("…as JSON the pages can read: status error and a plain message", !!body && body.status === "error" && body.message === "Something went wrong — it has been logged." &&
      /application\/json/.test(res.headers.get("Content-Type") || ""));
    ok("…never the error's text or stack", !/secretThing|at line|Error:|\.js:\d/.test(text));
    ok("…not cached", res.headers.get("Cache-Control") === "no-store");
    ok("the error is logged with its route", logged.some(a => /image-proxy/.test(String(a[0])) && a.includes(boom)));
    ok("the system issue is recorded after the answer (through waitUntil)", c.waits.length === 1);
    await Promise.all(c.waits);
    const rows = DB.q("SELECT kind, sample FROM system_issues");
    ok("…as an api_error naming the route and the message, for the roll-up", rows.length === 1 && rows[0].kind === "api_error" && rows[0].sample === "image-proxy: no such column: secretThing at line 12");
    ok("…with a plain label in the roll-up", /Something went wrong/.test(db.SYSTEM_ISSUE_LABELS.api_error || "") && (await db.getSystemIssues(DB))[0].label === db.SYSTEM_ISSUE_LABELS.api_error);

    const syncThrow = await withRoute(() => { throw new TypeError("x is undefined"); }, () => w.handleRequest(req("/api/image-proxy"), { DB, SIGNING_SECRET: "s" }, ctx()));
    ok("a handler that throws before returning a promise is caught the same way", syncThrow.status === 500 && (await syncThrow.json()).status === "error");
    const noCtx = await withRoute(async () => { throw new Error("no ctx"); }, () => w.handleRequest(req("/api/image-proxy"), { DB, SIGNING_SECRET: "s" }, undefined));
    ok("with no execution context, the issue is recorded before answering", noCtx.status === 500 && DB.q("SELECT count(*) AS n FROM system_issues WHERE sample = 'image-proxy: no ctx'")[0].n === 1);
    const noDb = await withRoute(async () => { throw "a thrown string"; }, () => w.handleRequest(req("/api/image-proxy"), { SIGNING_SECRET: "s" }, ctx()));
    ok("with no database (or a thrown non-Error), still the JSON 500", noDb.status === 500 && (await noDb.json()).status === "error");

    const fine = await withRoute(async () => new Response("ok", { status: 201 }), () => w.handleRequest(req("/api/image-proxy"), { DB, SIGNING_SECRET: "s" }, ctx()));
    ok("a handler that answers is passed through untouched", fine.status === 201 && (await fine.text()) === "ok");
    const before = DB.q("SELECT count(*) AS n FROM system_issues")[0].n;
    const own = await withRoute(async () => new Response(JSON.stringify({ status: "error", message: "Bad input" }), { status: 400 }), () => w.handleRequest(req("/api/image-proxy"), { DB, SIGNING_SECRET: "s" }, ctx()));
    ok("…including its own error answers", own.status === 400 && (await own.json()).message === "Bad input" && DB.q("SELECT count(*) AS n FROM system_issues")[0].n === before);
  } finally { console.error = origError; }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); console.log("test264 crashed: false"); process.exit(1); });
