// The morning roll-up on an install with no email service set up (review round 2). It used to fail every
// morning: the send failed, so the run answered 502, the scheduled tick recorded "roll-up did not complete" and
// tried again twice more, every email recorded an "Emails that couldn't be sent" problem, and since problems are
// only cleared by a roll-up that is sent, the list only ever grew. Now:
//   - with no provider at all the roll-up does its checks, sends nothing and answers 200 {sent:false, reason}
//     (so the tick counts it done for the day); progress isn't saved and nothing is marked sent;
//   - a send with no provider isn't recorded as a failed send (Setup status says email isn't set up);
//   - Communications has a Clear button for the problems list: settings.comms at Edit, audited first.
// Real SQL (sql.js), the real migrations, db.js, email.js, deliveryCheck.js, daily-digest.js, orders.js and
// permissions.js; invented data.
const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { MAIL_ENV, MAIL_OK, captureMail } = require("./testlib/mail-mock");

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + "\nreturn { insertOrder, recordSystemIssue, addOwnerNotice };")();
const mail = new Function(dbSrc + "\n" + strip(read("functions/_lib/email.js")) + "\nreturn { sendOrderReceivedEmail, emailCanSend };")();
const digest = new Function(strip(read("functions/_lib/http.js")) + "\n" +
  "function timingSafeEqual(a, b){ return typeof a === 'string' && a === b; }\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const checkSupplierShipments = async () => ({ checked: 0, errors: [] });\n" +
  dbSrc + "\n" + strip(read("functions/_lib/email.js")) + "\n" + strip(read("functions/_lib/deliveryCheck.js")) + "\n" + strip(read("functions/api/daily-digest.js")) +
  "\nreturn { runDailyDigest };")();
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  strip(read("functions/_lib/permissions.js")) + "\n" +
  "const __as = { role: null };\n" +
  "const requireAdmin = async (env, host, key, request, msg, need) => roleAllows(__as.role, need) ? null : new Response(JSON.stringify({ status: 'error', code: 'forbidden', message: 'Your role can\\'t do this.' }), { status: 403 });\n" +
  "const adminActor = () => 'pat@example.test';\n" +
  "const adminUser = () => __as.role ? { id: 7, role: __as.role.key, roleInfo: __as.role } : null;\n" +
  "const adminCan = (request, fn, level) => !!__as.role && permRank(effectiveLevel(__as.role, fn)) >= permRank(level || 'read');\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) +
  "\nreturn { post: onRequestPost, as: __as, DEFAULT_ROLES, ACTION_PERM };")();

let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec("INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Example Club','t','t')");
  const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
  const add = (orderId, h) => lib.insertOrder(d1, { orderId, orgId: "acme", customerName: "Cust " + orderId, contact: orderId.toLowerCase() + "@example.test",
    paymentMethod: "Venmo", placedAt: hoursAgo(h) }, [{ productId: "", name: "Polo", type: "shirt", size: "L", qty: 1, unitPrice: 20 }]);
  await add("N1", 3); await add("N2", 2);
  await lib.addOwnerNotice(d1, { kind: "payment", orderId: "N1", orgId: "acme", summary: "Paid $20" });
  const emails = [], outside = [];
  global.fetch = async (url, init) => { outside.push(String(url)); if (captureMail(url, init, emails)) return MAIL_OK; return { ok: true, json: async () => ({}) }; };
  const issues = () => d1.q("SELECT kind FROM system_issues").map(r => r.kind);
  const setting = (k) => (d1.q("SELECT value FROM global_settings WHERE key = ?", k)[0] || {}).value;

  console.log("=== No email service set up: the roll-up is done for the day, not failed ===");
  const noMail = { DB: d1, ROOT_DOMAIN: "example.test" };
  ok("emailCanSend says no (no provider, no binding, no token)", (await mail.emailCanSend(noMail)) === false && (await mail.emailCanSend({ DB: d1, ...MAIL_ENV })) === true);
  let res = await digest.runDailyDigest(noMail, "scheduled");
  let body = JSON.parse(await res.text());
  ok("the run answers 200 (the scheduled tick then counts it done — no 3 tries a day), not sent, and says why",
    res.status === 200 && body.sent === false && body.reason === "email not set up");
  ok("no email was attempted (not even the quiet-morning one) and no problem was recorded", emails.length === 0 && outside.length === 0 && issues().length === 0);
  ok("progress isn't saved: the first roll-up once email is set up reports these orders", setting("dailyDigest") === undefined);
  ok("…and the queued notices stay unsent", d1.q("SELECT COUNT(*) AS n FROM owner_notices WHERE sentAt IS NULL")[0].n === 1);
  const runRec = JSON.parse(setting("dailyDigestRun"));
  ok("the run is recorded as complete, with the reason (Communications says email isn't set up)", runRec.ok === true && runRec.sent === false && runRec.reason === "email not set up");
  const worker = read("src/worker.js");
  ok("(the tick records digest_failed only for a run that isn't ok, and marks an ok one done)",
    /if \(!res\.ok\) \{[\s\S]{0,300}digest_failed[\s\S]{0,200}\}\s*await markDone\(\);/.test(worker));

  console.log("\n=== A send with no provider isn't a failed send ===");
  const sent = await mail.sendOrderReceivedEmail(noMail, { orderId: "N1", orgId: "acme", customerName: "Cust N1", contact: "n1@example.test", items: [], placedAt: hoursAgo(3) });
  ok("an order email with no provider: not sent, nothing recorded", sent === false && issues().length === 0 && outside.length === 0);
  ok("(a provider that is set up but fails is still recorded as a failed send)",
    /if \(r === true\) return true;[\s\S]{0,300}recordSystemIssue\(env && env\.DB, "email_failed"/.test(read("functions/_lib/email.js")));

  console.log("\n=== With email set up, the roll-up goes out as before ===");
  const withMail = { DB: d1, ROOT_DOMAIN: "example.test", ...MAIL_ENV };
  res = await digest.runDailyDigest(withMail, "manual");
  body = JSON.parse(await res.text());
  ok("sent, with both orders that waited", res.status === 200 && body.sent === true && body.orders === 2 && emails.length === 1 && /N1/.test(emails[0].body) && /N2/.test(emails[0].body));

  console.log("\n=== Communications → Clear the problems list ===");
  await lib.recordSystemIssue(d1, "email_failed", "Order received"); await lib.recordSystemIssue(d1, "email_failed", "Shipped");
  await lib.recordSystemIssue(d1, "webhook_failed", "evt_1");
  const pending = [];
  const call = async (b, role) => {
    api.as.role = role ? api.DEFAULT_ROLES[role] : null;
    const full = Object.assign({ key: "x" }, b);
    const req = { url: "https://admin.example.test/api/orders", json: async () => full, clone: () => ({ json: async () => full }), headers: { get: () => null } };
    const r = await api.post({ env: { DB: d1, ROOT_DOMAIN: "example.test" }, waitUntil: (p) => pending.push(Promise.resolve(p).catch(() => {})), request: req });
    return { status: r.status, body: JSON.parse(await r.text()) };
  };
  ok("the action belongs to Communications at Edit", JSON.stringify(api.ACTION_PERM.clearSystemIssues) === JSON.stringify([["settings.comms", "edit"]]));
  let r = await call({ action: "clearSystemIssues" }, "staff");
  ok("Back office (Communications at Read) is refused, and nothing is cleared", r.status === 403 && issues().length === 3);
  r = await call({ action: "clearSystemIssues" }, "production");
  ok("…and so is Production (no Communications)", r.status === 403 && issues().length === 3);
  r = await call({ action: "clearSystemIssues" }, "manager");
  ok("Manager clears them all and is told how many", r.status === 200 && r.body.cleared === 3 && issues().length === 0);
  const audit = d1.q("SELECT actor, detail FROM audit_log WHERE action = 'system_issues.cleared'");
  ok("…with an audit entry saying who and what was cleared", audit.length === 1 && audit[0].actor === "pat@example.test" &&
    JSON.stringify(JSON.parse(audit[0].detail).problems) === JSON.stringify([{ kind: "email_failed", count: 2 }, { kind: "webhook_failed", count: 1 }]));
  r = await call({ action: "clearSystemIssues" }, "admin");
  ok("clearing an empty list is fine (nothing cleared)", r.status === 200 && r.body.cleared === 0);
  await lib.recordSystemIssue(d1, "email_failed", "Invoice");
  // The audit row has to be written first: when it can't be, nothing is cleared.
  const realPrepare = d1.prepare.bind(d1);
  d1.prepare = (sql) => /INSERT INTO audit_log/.test(sql) ? { bind: () => ({ run: async () => { throw new Error("D1_ERROR: read-only"); } }), run: async () => { throw new Error("D1_ERROR: read-only"); } } : realPrepare(sql);
  r = await call({ action: "clearSystemIssues" }, "admin");
  d1.prepare = realPrepare;
  ok("no audit entry, nothing cleared", r.status === 503 && issues().length === 1);

  console.log("\n=== The page ===");
  const admin = read("public/admin.js");
  const comms = admin.slice(admin.indexOf("async function renderCommunications("), admin.indexOf("async function checkBlankShipmentsNow("));
  ok("the problems box has a Clear button, shown to a role with Communications at Edit", /<button id="commsClearIssuesBtn"[^>]*data-need="settings\.comms:edit"[^>]*data-admin-action="commsClearIssues_">Clear<\/button>/.test(comms));
  const fn = admin.slice(admin.indexOf("async function commsClearIssues_("), admin.indexOf("async function commsClearIssues_(") + 700);
  ok("…which asks first, then sends clearSystemIssues and refreshes the page", /askConfirm_\(/.test(fn) && fn.indexOf("askConfirm_(") < fn.indexOf('action: "clearSystemIssues"') && /refreshComms_\(\)/.test(fn) &&
    /commsClearIssues_\(\)\{ commsClearIssues_\(this\); \}/.test(admin));
  ok("the last-run line says email isn't set up when that's why nothing was sent", /run\.reason === "email not set up" \? "no email was sent, because email isn't set up/.test(comms));
  ok("Setup status no longer promises a problem per attempt", !/each attempt is listed as a problem/.test(read("functions/_lib/setupStatus.js")) && /Email isn't set up|"email", "Email"/.test(read("functions/_lib/setupStatus.js")));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
