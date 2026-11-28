const fs = require("fs");
const { storefrontPage } = require("./testlib/storefront-page");
const { createD1 } = require("./testlib/d1-shim.js");
const { JSDOM, ResourceLoader } = require("jsdom");

// Orders → Send design proof (orders.js sendDesignVerification) had no limit: every picked order was read in full,
// with its shop, one after another, then emailed — a big selection could run past what one Worker request may do,
// part-way through the emails. Now one request takes at most 20 orders (BULK_STAGE_MAX, as the other step changes),
// reads them in one go (getOrdersByIds) and each of their shops once; the Orders page sends a bigger selection in
// groups of 20 and adds up sent / skipped, saying how many were already sent if a later group fails.
// Real SQL (sql.js) + real db.js and orders.js; the page's own bulkSendDesignVerification in jsdom. Invented data only.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + "\nreturn { insertOrder };")();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'owner@example.test'; " + require("./testlib/roles").adminAs() + "\n" + strip(read("functions/_lib/permissions.js")) + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
  "const sendDesignVerificationEmail = async (env, args) => { (globalThis.__proofs = globalThis.__proofs || []).push(args); return true; };\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();

let passed = 0, failed = 0;
const ok = (label, cond) => { cond ? passed++ : failed++; console.log(label + ": " + !!cond); };

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Example Club','t','t'), ('bolt','boltshop','Example Team','t','t');`);

  // The database calls a request makes, reads apart from writes; and how many times a shop is read.
  const counted = { reads: 0, writes: 0, orgReads: 0 };
  const tally = (sql) => { if (/^\s*(SELECT|WITH)\b/i.test(sql)) counted.reads++; else counted.writes++; if (/FROM orgs WHERE orgId/i.test(sql)) counted.orgReads++; };
  const wrap = (st) => ({ _sql: st._sql, _params: st._params,
    first: (...a) => { tally(st._sql); return st.first(...a); }, all: (...a) => { tally(st._sql); return st.all(...a); }, run: (...a) => { tally(st._sql); return st.run(...a); } });
  const db = {
    prepare: (sql) => { const p = d1.prepare(sql); return Object.assign(wrap(p), { bind: (...v) => wrap(p.bind(...v)) }); },
    batch: (stmts) => { stmts.forEach(s => tally(s._sql)); return d1.batch(stmts); },
  };
  const call = async (body) => {
    const waits = [];
    counted.reads = counted.writes = counted.orgReads = 0; globalThis.__proofs = [];
    const res = await api({ env: { DB: db, ROOT_DOMAIN: "example.com" }, waitUntil: (p) => waits.push(p && p.then ? p.then(() => {}, () => {}) : null),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x", org: "acme" }, body), headers: { get: () => null } } });
    await Promise.all(waits);
    return { status: res.status, body: JSON.parse(await res.text()), ...counted, proofs: globalThis.__proofs };
  };

  const ids = [];
  for (let i = 0; i < 45; i++) {
    const id = "P" + String(i).padStart(3, "0");
    ids.push(id);
    await lib.insertOrder(d1, { orderId: id, orgId: i % 2 ? "bolt" : "acme", customerName: "Customer " + i, contact: i === 3 ? "" : "c" + i + "@example.test", placedAt: "2026-10-01T00:00:00Z" },
      [{ productId: "cap", name: "Cap", type: "cap", size: "OSFA", qty: 1, unitPrice: 20 }, { productId: "tee", name: "Tee", type: "shirt", size: "M", qty: 1, unitPrice: 15 }]);
  }
  const rows = () => d1.q("SELECT COUNT(*) n FROM design_verifications")[0].n;

  console.log("=== At most 20 orders a request ===");
  let r = await call({ action: "sendDesignVerification", orderIds: ids.slice(0, 21), message: "Please check the logo." });
  ok("21 orders are refused, saying the most it takes", r.status === 400 && /max 20/.test(r.body.message || ""));
  ok("…and nothing is sent or recorded", r.proofs.length === 0 && rows() === 0);

  console.log("\n=== The orders read in one go, each shop once ===");
  await call({ action: "sendDesignVerification", orderIds: [ids[44]], message: "Warm-up." });   // the first request's one-off checks
  const five = await call({ action: "sendDesignVerification", orderIds: ids.slice(20, 25), message: "Please check the logo." });
  const twenty = await call({ action: "sendDesignVerification", orderIds: ids.slice(0, 20), message: "Please check the logo." });
  ok("20 orders: 19 proofs sent, the one with no email skipped saying why", twenty.status === 200 && twenty.body.sent === 19 && twenty.body.skipped === 1 &&
    twenty.body.skippedReasons.join() === "P003: no email" && twenty.proofs.length === 19);
  ok(`the reads don't grow with the orders (5 orders ${five.reads}, 20 orders ${twenty.reads})`, twenty.reads === five.reads);
  ok("…one write each: the proof recorded", twenty.writes === 19 && rows() === 25);
  ok("each of the two shops is read once", twenty.orgReads === 2);
  const toBolt = twenty.proofs.find(p => p.orderId === "P001") || {}, toAcme = twenty.proofs.find(p => p.orderId === "P000") || {};
  ok("each proof links to its own shop's address", /^https:\/\/boltshop\.example\.com\/\?verify=[a-z0-9]{32}$/.test(toBolt.verifyUrl || "") &&
    /^https:\/\/acme\.example\.com\/\?verify=/.test(toAcme.verifyUrl || "") && toBolt.customerEmail === "c1@example.test");
  r = await call({ action: "sendDesignVerification", orderIds: ["NOPE-1", ids[0]], message: "Again." });
  ok("an order that doesn't exist is skipped with a reason; the rest still go", r.status === 200 && r.body.sent === 1 && r.body.skippedReasons.join() === "NOPE-1: not found");

  console.log("\n=== The Orders page sends a big selection in groups (jsdom) ===");
  const adminJs = read("public/admin.js");
  const sent = [];
  let failAt = 0;   // the group (1-based) the server refuses; 0 = none
  class L extends ResourceLoader { fetch(url, o) { if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return Promise.resolve(Buffer.from("")); } }
  const dom = new JSDOM(storefrontPage(), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win) { win.fetch = async (u, init) => {
      const b = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
      if (b.action === "sendDesignVerification") {
        sent.push(b);
        if (failAt && sent.length === failAt) return { ok: false, status: 500, json: async () => ({ status: "error", message: "Server error" }) };
        const skip = b.orderIds.includes("P003");
        return { ok: true, status: 200, json: async () => ({ status: "ok", sent: b.orderIds.length - (skip ? 1 : 0), skipped: skip ? 1 : 0, skippedReasons: skip ? ["P003: no email"] : [] }) };
      }
      return { ok: true, status: 200, json: async () => ({ status: "ok", orders: [] }) };
    }; } });
  const w = dom.window;
  await new Promise(x => setTimeout(x, 150));
  await w.loadAdminScript();
  w.eval('adminKey = "cookie"; adminOrgs = [];');
  const toasts = []; w.showToast = (m, bad) => toasts.push({ m, bad: !!bad });
  w.showDesignVerifModal = async () => ({ message: "Please check the logo.", imageUrls: ["https://images.example.test/proof.png"] });
  const box = w.document.createElement("div");
  w.document.body.appendChild(box);
  const tick = () => { box.innerHTML = ids.map(id => `<input type="checkbox" class="order-select" data-org="acme" data-order="${id}" checked>`).join(""); };

  tick();
  await w.bulkSendDesignVerification("acme");
  ok("45 picked orders go as three requests of 20, 20 and 5, in order", sent.map(b => b.orderIds.length).join(",") === "20,20,5" &&
    sent.flatMap(b => b.orderIds).join(",") === ids.join(","));
  ok("…each with the message, the pictures and the shop", sent.every(b => b.message === "Please check the logo." && b.imageUrls.length === 1 && b.org === "acme"));
  let t = toasts.slice(-1)[0] || { m: "" };
  ok("…and the message adds them up across the groups", /sent to 44 orders/.test(t.m) && /1 skipped — P003: no email/.test(t.m) && !t.bad);

  tick(); sent.length = 0; failAt = 3;
  await w.bulkSendDesignVerification("acme");
  t = toasts.slice(-1)[0] || { m: "" };
  ok("the third group failing: the message says 40 orders were already handled and the other 5 weren't sent", sent.length === 3 && t.bad &&
    /sent to 39 orders/.test(t.m) && /stopped after 40 of 45 orders/.test(t.m) && /other 5 were not sent/.test(t.m));

  tick(); sent.length = 0; failAt = 1;
  await w.bulkSendDesignVerification("acme");
  t = toasts.slice(-1)[0] || { m: "" };
  ok("the first group failing reads as before: an error, nothing more sent", sent.length === 1 && t.bad && /^Error: Server error/.test(t.m));
  w.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch((e) => { console.error(e); console.log("test303 crashed: false"); process.exit(1); });
