const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { adminAs } = require("./testlib/roles");
const { ok } = require("./testlib/check");

// The permission checks inside /api/orders (orders.js: seesPricing_, seesExpenses_, stageDenied_, can_, mayUse_) fail
// closed. They used to let a request through — and show it costs and money — whenever there was no adminCan to ask
// (a test harness built without adminAuth.js) or no user behind the request, a branch only tests ever took. Now
// missing means refused, and a harness signs in with testlib/roles.js adminAs(), which answers from the real role
// tables. Real SQL (sql.js), db.js, permissions.js and orders.js; invented data only.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const ordersSrc = read("functions/api/orders.js");

console.log("=== orders.js has no allow-when-missing fallback ===");
const checks = ordersSrc.slice(ordersSrc.indexOf("const seesPricing_ ="), ordersSrc.indexOf("const forbidden_ ="));
ok("the checks are where this test reads them", checks.length > 200 && /const stageDenied_ =/.test(checks) && /const can_ =/.test(checks) && /const mayUse_ =/.test(checks));
ok("no check allows when adminCan is missing (typeof adminCan !== \"function\" || …)", !/typeof adminCan\s*!==?\s*["']function["']\s*\|\|/.test(ordersSrc));
ok("costs and expenses are never shown for want of a user, nor decided by a bare role name", !/if \(!u \|\| !u\.role\) return true/.test(checks) && !/u\.role === "manager"/.test(checks) &&
  /const seesPricing_ = \(\) => typeof adminCan === "function" && adminCan\(request, "costs\.view", "read"\);/.test(checks) &&
  /const seesExpenses_ = \(\) => typeof adminCan === "function" && adminCan\(request, "finance\.expenses", "read"\);/.test(checks));
ok("an action ACTION_PERM doesn't list is an admin's, never allowed for want of a user", !/return !u \|\|/.test(checks) &&
  /return !!\(u && u\.roleInfo && u\.roleInfo\.locked === true && u\.roleInfo\.key === "admin"\);/.test(checks));

// One harness, three ways of signing in: none (no adminUser / adminCan at all), and adminAs() for a role.
const harness = (signIn) => new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
  strip(read("functions/_lib/catalogValidation.js")) + "\n" + strip(read("functions/_lib/permissions.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'pat@example.test';\n" + signIn + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false;\n" +
  strip(read("functions/_lib/db.js")) + "\n" + strip(ordersSrc) + "\nreturn onRequestPost;")();

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const t = "2026-11-02T15:00:00.000Z";
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Example Club','${t}','${t}');
    INSERT INTO orders (orderId, orgId, customerName, contact, placedAt, paid) VALUES ('A-1','acme','Pat Example','pat@example.test','${t}',1);`);
  const env = { DB: d1, ROOT_DOMAIN: "example.com" };
  const caller = (api) => async (body) => {
    const full = Object.assign({ key: "x" }, body);
    const request = { url: "https://admin.example.com/api/orders", json: async () => full, clone: () => ({ json: async () => full }), headers: { get: () => null } };
    const res = await api({ env, waitUntil: (p) => Promise.resolve(p).catch(() => {}), request });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const nobody = caller(harness("")), admin = caller(harness(adminAs())), production = caller(harness(adminAs("production")));
  const stage = (call, s) => call({ action: "setFulfillmentStage", org: "acme", orderId: "A-1", stage: s, value: true });
  const today = "2026-11-10";

  console.log("\n=== A harness without adminCan is refused ===");
  let r = await stage(nobody, "qaPacked");
  ok("a step change is refused (403), and the order is unchanged", r.status === 403 && r.body.code === "forbidden" && !d1.q("SELECT qaPackedAt FROM orders WHERE orderId='A-1'")[0].qaPackedAt);
  r = await nobody({ action: "getDashboard", today, fresh: true });
  ok("Home's dashboard gives the step counts but no money", r.status === 200 && !!r.body.stages && !("year" in r.body) && !/productRevenue/.test(JSON.stringify(r.body)));

  console.log("\n=== Signed in with adminAs(), the same requests answer as that role ===");
  r = await admin({ action: "getDashboard", today, fresh: true });
  ok("the admin gets the money", r.status === 200 && !!r.body.year && typeof r.body.year.productRevenue === "number");
  r = await stage(production, "manufactured");
  ok("Production may set a late step (Edit on the late steps) — refused only for want of the order's earlier steps, not by role", r.status !== 403 || r.body.code !== "forbidden");
  r = await stage(production, "blankOrdered");
  ok("…but not an early one: refused as its role", r.status === 403 && r.body.code === "forbidden");
  r = await production({ action: "getDashboard", today, fresh: true });
  ok("…and sees no money", r.status === 200 && !("year" in r.body));
  r = await stage(admin, "blankOrdered");
  ok("the admin may set an early step", r.status === 200 && r.body.status === "ok");
  r = await stage(admin, "qaPacked");
  ok("…and a late one is refused only by the order's own steps (not made yet), not by role", r.status === 409 && /isn't manufactured yet/.test(r.body.message));
})().catch((e) => { console.error(e); ok("test273 ran to the end", false); });
