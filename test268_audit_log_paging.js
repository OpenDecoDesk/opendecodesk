const fs = require("fs");
const { storefrontPage } = require("./testlib/storefront-page");
const { createD1 } = require("./testlib/d1-shim.js");
const { JSDOM, ResourceLoader } = require("jsdom");

// The audit log (review #100, #108). It keeps everything (no deletion), so:
//   - each entry's detail is at most 8 KB: a bigger {from, to} keeps only the fields that changed, anything else
//     bigger becomes {truncated, bytes, preview}; the Audit log screen says so
//   - the action filter maps the typed text to the action names it appears in and reads by name, on the
//     (action, createdAt) index migrations/0104 adds, instead of a "contains" match no index can serve
//   - paging: newest first, ties on createdAt ordered by id, `before` = the last entry shown, `more` says older ones
//     match too; no entry is shown twice or skipped
//   - the screen shows shop names (the id as its tooltip) and "Showing the newest N — narrow the dates or Load more"
// Real SQL (sql.js) + real db.js and orders.js; the Audit log screen in jsdom. Invented data only.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + "\nreturn { insertAuditLog, auditLogStatement, getAuditLog, auditDetailJson_ };")();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'owner@example.test';\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
let failed = 0;
const ok = (label, cond) => { if (!cond) failed++; console.log(label + ": " + !!cond); };
const tick = (ms = 40) => new Promise(r => setTimeout(r, ms));
const bytes = (s) => Buffer.byteLength(s, "utf8");

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const call = async (body) => {
    const res = await api({ env: { DB: d1 }, waitUntil: (p) => p.then(() => {}, () => {}),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };

  console.log("=== Each entry's detail is at most 8 KB ===");
  const small = { productId: "tee", changes: { flatPrice: { from: 20, to: 22 } } };
  ok("a small detail is kept as it is", lib.auditDetailJson_(small) === JSON.stringify(small) && lib.auditDetailJson_(null) === null);
  const big = "x".repeat(3000);
  const settings = { from: { a: big, b: big, c: big, rate: 5 }, to: { a: big, b: big, c: big, rate: 6 }, section: "pricing" };
  const slim = JSON.parse(lib.auditDetailJson_(settings));
  ok("a bigger {from, to} keeps only the fields that changed (and says so)", slim.onlyChanged === true && slim.section === "pricing" &&
    JSON.stringify(slim.from) === '{"rate":5}' && JSON.stringify(slim.to) === '{"rate":6}');
  const huge = { rows: Array.from({ length: 2000 }, (_, i) => ({ i, note: "row " + i + " ✓ é" })) };
  const capped = lib.auditDetailJson_(huge), cut = JSON.parse(capped);
  ok("anything else bigger: {truncated, bytes, preview}, the whole entry within 8 KB (multi-byte text included)", cut.truncated === true && cut.bytes === bytes(JSON.stringify(huge)) &&
    JSON.stringify(huge).startsWith(cut.preview) && cut.preview.length > 1000 && bytes(capped) <= 8192);
  const quotes = lib.auditDetailJson_({ text: '"'.repeat(20000) });
  ok("…even when escaping makes the preview longer than its text", bytes(quotes) <= 8192 && JSON.parse(quotes).truncated === true);
  const wide = { from: { list: big + big + big }, to: { list: big + big + big + "!" } };
  ok("a {from, to} whose changed field alone is too big is cut like anything else", JSON.parse(lib.auditDetailJson_(wide)).truncated === true);
  await lib.insertAuditLog(d1, { orgId: null, orderId: null, action: "settings.pricing_changed", detail: huge, actor: "owner@example.test" });
  await d1.batch([lib.auditLogStatement(d1, { orgId: null, orderId: null, action: "settings.features_changed", detail: huge })]);
  ok("both ways of writing an entry store it capped", d1.q("SELECT detail FROM audit_log WHERE action IN ('settings.pricing_changed', 'settings.features_changed')").every(r => bytes(r.detail) <= 8192 && JSON.parse(r.detail).truncated));

  console.log("\n=== The action filter reads by name ===");
  ok("migration 0104 (and schema.sql) index the log by (action, createdAt)", d1.q("SELECT sql FROM sqlite_master WHERE name = 'idx_audit_log_action'")[0].sql.replace(/\s+/g, " ").includes("audit_log(action, createdAt)") &&
    /idx_audit_log_action\s+ON audit_log\(action, createdAt\)/.test(read("schema.sql")));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Example Club','t','t'), ('rec','rec','Rec League','t','t');`);
  const T = "2026-10-01T12:00:00.000Z";
  // 25 entries at exactly the same moment, plus 15 others around them.
  for (let i = 0; i < 25; i++) d1.q("INSERT INTO audit_log (createdAt, orgId, orderId, action, detail) VALUES (?, ?, NULL, ?, ?)", T, i % 2 ? "acme" : "rec", i % 3 ? "payment.added" : "order.edited", JSON.stringify({ n: i }));
  for (let i = 0; i < 15; i++) d1.q("INSERT INTO audit_log (createdAt, orgId, orderId, action, detail) VALUES (?, 'acme', NULL, 'payment.voided', ?)", `2026-10-0${1 + (i % 2) * 2}T0${i % 10}:00:00.000Z`, JSON.stringify({ n: 100 + i }));
  const like = (t) => d1.q("SELECT id FROM audit_log WHERE action LIKE ? ORDER BY id", "%" + t + "%").map(r => r.id).join();
  const byFilter = async (t) => (await lib.getAuditLog(d1, { action: t, limit: 200 })).map(e => e.id).sort((a, b) => a - b).join();
  ok("the same entries as the old 'contains' match, any case", await byFilter("payment") === like("payment") && await byFilter("PAYMENT.ADD") === like("payment.add") && await byFilter("edit") === like("edit"));
  ok("text in no action name: nothing (and no read of the log itself)", (await lib.getAuditLog(d1, { action: "nothing-like-this" })).length === 0 &&
    JSON.stringify(await lib.getAuditLog(d1, { action: "nothing-like-this", paged: true })) === '{"entries":[],"more":false}');

  console.log("\n=== Paging ===");
  const all = d1.q("SELECT id FROM audit_log ORDER BY createdAt DESC, id DESC").map(r => r.id);
  const seen = [];
  let page = await lib.getAuditLog(d1, { limit: 10, paged: true }), pages = 1;
  seen.push(...page.entries.map(e => e.id));
  while (page.more && pages < 20) {
    const last = page.entries[page.entries.length - 1];
    page = await lib.getAuditLog(d1, { limit: 10, paged: true, before: { createdAt: last.createdAt, id: last.id } });
    seen.push(...page.entries.map(e => e.id)); pages++;
  }
  ok("pages of 10 through 25 entries sharing one moment and the rest: every entry once, newest first, ties by id", seen.join() === all.join() && new Set(seen).size === seen.length && pages === Math.ceil(all.length / 10));
  ok("…the last page says there are no more; a full page with more behind it says there are", page.more === false && (await lib.getAuditLog(d1, { limit: 10, paged: true })).more === true);
  ok("called as before (no paged): the entries array, still at most 200", Array.isArray(await lib.getAuditLog(d1, { limit: 500 })) && (await lib.getAuditLog(d1, { limit: 5 })).length === 5);
  let r = await call({ action: "getAuditLog", limit: 20, filter: "payment" });
  const r2 = await call({ action: "getAuditLog", limit: 20, filter: "payment", before: { createdAt: r.body.entries[19].createdAt, id: r.body.entries[19].id } });
  const both = r.body.entries.concat(r2.body.entries).map(e => e.id);
  ok("the API: entries and more, and before for the next page", r.status === 200 && r.body.more === true && r2.body.more === false &&
    both.join() === d1.q("SELECT id FROM audit_log WHERE action LIKE '%payment%' ORDER BY createdAt DESC, id DESC").map(x => x.id).join());

  console.log("\n=== The Audit log screen ===");
  const adminJs = read("public/admin.js");
  const sent = [];
  class L extends ResourceLoader { fetch(url, o) {
    if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs));
    const local = new URL(url).pathname.match(/^\/vendor\/fonts\/[a-z0-9.-]+$/);
    return local ? Promise.resolve(fs.readFileSync(__dirname + "/public" + local[0])) : super.fetch(url, o); } }
  const dom = new JSDOM(storefrontPage(), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win) { win.fetch = async (u, init) => {
      if (String(u).includes("/api/catalog")) return { ok: true, status: 200, json: async () => ({ status: "admin", features: {} }) };
      if (!String(u).includes("/api/orders")) return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
      const b = init && typeof init.body === "string" ? JSON.parse(init.body) : {}; sent.push(b); const x = await call(b);
      return { ok: x.status < 400, status: x.status, json: async () => x.body, text: async () => JSON.stringify(x.body) }; }; } });
  const w = dom.window, doc = w.document;
  await tick(150);
  await w.loadAdminScript();
  w.eval('adminKey = "cookie"; adminOrgs = [{ orgId: "acme", name: "Example Club" }, { orgId: "rec", name: "Rec League" }];');
  const app = doc.getElementById("app");
  await w.renderAuditLog(app);
  doc.getElementById("afFrom").value = "2026-01-01"; doc.getElementById("afTo").value = "2026-12-31";
  sent.length = 0;
  doc.getElementById("auditFilters").dispatchEvent(new w.Event("submit"));
  const rows = () => [...doc.querySelectorAll("#auditResults tbody tr")];
  for (let i = 0; i < 50 && rows().length < 20; i++) await tick(20);
  const footer = () => (doc.getElementById("auditFooter") || {}).textContent || "";
  ok("the first 20, and the footer says only the newest are shown, with Load more", rows().length === 20 && /Showing the newest 20 — narrow the dates or/.test(footer()) && !!doc.getElementById("auditMore"));
  const shop = rows().map(tr => tr.querySelector(".audit-shop span[title]")).find(Boolean);
  ok("the Shop column shows the shop's name, its id as the tooltip", shop && ["Example Club", "Rec League"].includes(shop.textContent) && ["acme", "rec"].includes(shop.title));
  doc.getElementById("auditMore").click();
  for (let i = 0; i < 50 && rows().length < 40; i++) await tick(20);
  ok("Load more asks for the page after the last row (the same filters) and adds it below", rows().length === 40 && sent.length === 2 && sent[1].before &&
    sent[1].before.id === all[19] && sent[1].limit === 20 && sent[1].dateFrom === sent[0].dateFrom);
  doc.getElementById("auditMore") && doc.getElementById("auditMore").click();
  for (let i = 0; i < 50 && rows().length < all.length; i++) await tick(20);
  const shownTimes = rows().length;
  ok("…until every entry is shown, each once; then the footer just counts them", shownTimes === all.length && !doc.getElementById("auditMore") && footer().trim() === all.length + " entries");
  const truncatedRow = rows().find(tr => /Too long to keep in full/.test(tr.textContent));
  ok("an entry cut to 8 KB says so, with the start of what it held", !!truncatedRow && /\(\d+ KB\)/.test(truncatedRow.textContent) && /\{"rows":\[/.test(truncatedRow.textContent));
  dom.window.close();
  if (failed) console.log("\nFAILED:", failed);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log("crashed: false"); console.error(e); process.exit(1); });
