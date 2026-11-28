// Net 30 with a PO on the customer's side (phase 7, migrations/0121):
//   1. functions/api/orders.js "checkNet30": { ok: true, termsDays } for a live customer whose record allows Net 30, at a
//      shop that takes it (Global settings and the shop's own Payment methods); exactly { ok: false } for everything else
//      (an unknown email, a customer not allowed, archived or merged, Net 30 off for every shop or for this one, the
//      Storefront off, a shop that isn't published, odd input), so the answer never says whether an email is a
//      customer's; its rate-limit bucket (net30_check, 10 a minute); the hosts it answers on; a database before 0121.
//   2. The storefront order with paymentMethod "Net 30": checked again as the order is placed (refused with "Net 30 isn't
//      available for this order." and nothing saved), saved on Net 30 with the customer's own days and the PO as typed
//      (noted, not accepted: "PO to check"), not cleared for work, not paid; the answer's net30 and termsDays.
//   3. functions/api/invoice.js: the terms on the invoice (the PO, the due date worked out when read in the business's
//      time zone, or what the days count from), the PO box only for a Net 30 order with no PO, and "setInvoicePo": its
//      rate limit (invoice_po, 10), only that invoice's order, refused once a PO is accepted or the order is paid,
//      typed and never accepted, audited.
//   4. public/storefront.js in jsdom: checkNet30 asked only where it may say yes, 700 ms after typing stops and at once
//      when the field changes; the "Net 30 (pay by invoice)" choice, its PO box and hint; the order sent; the thank-you
//      text; and the invoice page's Terms block, PO box and its thanks, against the real invoice.js.
// Real SQL (sql.js) under the real db.js, email.js, orders.js and invoice.js. "Today" never matters: every date the
// checks read is set on the order, and the business time zone is America/Denver (so a UTC day would show wrong).
// Invented shops, people and PO numbers only.
const fs = require("fs");
const { JSDOM, VirtualConsole } = require("jsdom");
const { ok } = require("./testlib/check");
const { createD1 } = require("./testlib/d1-shim.js");
const roles = require("./testlib/roles");
const { MAIL_ENV, MAIL_OK, captureMail } = require("./testlib/mail-mock");
const { ADMIN_ORIGIN, ROOT, shopOrigin } = require("./testlib/hosts.js");
const { storefrontPage } = require("./testlib/storefront-page");

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Wrapped db.js functions: globalThis.__o404[name] = (real, ...args) => … stands in for one while it is set.
const wrap = (src, names) => {
  let out = src;
  for (const n of names) {
    const from = "export async function " + n + "(";
    if (!out.includes(from)) throw new Error("no " + n);
    out = out.replace(from, "async function " + n + "_real404_(");
  }
  return strip(out) + "\n" + names.map(n => `async function ${n}(...a) { const o = globalThis.__o404[${JSON.stringify(n)}]; return o ? o(${n}_real404_, ...a) : ${n}_real404_(...a); }`).join("\n") + "\n";
};
globalThis.__o404 = {};
globalThis.__f404 = {};
globalThis.__rl404 = [];
globalThis.__rlBlock404 = "";
const dbSrc = wrap(read("functions/_lib/db.js"), ["getTerms", "getPublishedOrg", "getOrderById", "setOrderTerms", "insertAuditLog"]);
const libs = strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  strip(read("functions/_lib/quoteToken.js")) + "\n" + strip(read("functions/_lib/boxSize.js")) + "\n";
const rlStub = "const rateLimited = async (env, bucket, req, limit) => { globalThis.__rl404.push(bucket + '/' + limit); return { blocked: globalThis.__rlBlock404 === bucket, retryAfter: 30 }; };\n" +
  "const rateLimitResponse = (s) => jsonResponse({ status: 'error', message: 'Too many tries — wait ' + s + ' seconds.' }, 429);\n";
const A = new Function(libs +
  "const requireAdmin = async () => null; const adminActor = () => 'pat.staff@example.com';\n" + roles.adminAs() + "\n" + rlStub +
  "const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {};\n" +
  "const getCatalogData = async () => ({ subdomainMap: { acme: 'acme', beta: 'beta', draft: 'draft' }, orgs: {}, features: globalThis.__f404 });\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  dbSrc + "\n" + strip(read("functions/_lib/email.js")) + "\n" + strip(read("functions/_lib/digital.js")) + "\n" +
  "const ordersApi = (function(){\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost; })();\n" +
  "const invoiceApi = (function(){\n" + strip(read("functions/api/invoice.js")) + "\nreturn { onRequestGet, onRequestPost }; })();\n" +
  "return { ordersApi, invoiceApi, getOrderById, getOrderInvoiceByOrder, setLocaleSettings, resolveTimeZone, setTerms, net30Cleared, workCleared, publishShop };")();

const mail = [];
global.fetch = async (url, init) => {
  if (captureMail(url, init, mail)) return MAIL_OK;
  throw new Error("unexpected fetch " + url);
};
const ENV = { SIGNING_SECRET: "s".repeat(40), STRIPE_SECRET_KEY: "sk_test_example", DESIGNS: {}, ...MAIL_ENV };
const pause = (ms) => new Promise(r => setTimeout(r, ms));
const wait = async (cond, n = 400) => { for (let i = 0; i < n && !cond(); i++) await pause(10); return !!cond(); };
const quietly = async (fn) => { const err = console.error, logged = []; console.error = (...a) => logged.push(a.map(String).join(" ")); try { return { v: await fn(), logged }; } finally { console.error = err; } };
const using = async (over, fn) => { Object.assign(globalThis.__o404, over); try { return await fn(); } finally { for (const k of Object.keys(over)) delete globalThis.__o404[k]; } };
process.on("unhandledRejection", (e) => { console.error(e); ok("nothing in the test was left to fail unseen", false); });

const migrations = fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort();
const newDb = async (before) => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of migrations) if (!before || f < before) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready, shippingEnabled) VALUES
    ('acme','acme','Example Club','t','t',1,1), ('beta','beta','Sample League','t','t',1,1), ('draft','draft','Example Boosters','t','t',0,1);`);
  return d1;
};

const harness = (d1) => {
  const E = { DB: d1, ...ENV };
  const call = async (fn, url, body, { waitUntil = true } = {}) => {
    const waits = [];
    const ctx = { env: E, request: { url, json: async () => body, headers: { get: (h) => (h === "CF-Connecting-IP" ? "203.0.113.7" : null) } } };
    if (waitUntil) ctx.waitUntil = (p) => waits.push(Promise.resolve(p).catch(() => {}));
    const res = await fn(ctx);
    await Promise.all(waits);
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const admin = (body) => call(A.ordersApi, ADMIN_ORIGIN + "/api/orders", { key: "x", org: "acme", ...body });
  const post = (body, origin = shopOrigin("acme")) => call(A.ordersApi, origin + "/api/orders", body);
  const net30 = (email, extra = {}, origin) => post({ action: "checkNet30", orgId: "acme", email, ...extra }, origin);
  let n = 0;
  const shop = async (contact, paymentMethod, extra = {}, origin) => {
    const orderId = extra.orderId || "WEB-" + (++n);
    return { orderId, ...(await post({ orderId, orgId: "acme", customerName: "Pat Example", contact, paymentMethod, items: [{ productId: "mug", qty: 2 }], ...extra }, origin)) };
  };
  const inv = (body, opts) => call(A.invoiceApi.onRequestPost, shopOrigin("acme") + "/api/invoice", body, opts);
  const invGet = async (token) => { const res = await A.invoiceApi.onRequestGet({ env: E, request: { url: shopOrigin("acme") + "/api/invoice?token=" + token, headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) }; };
  return { E, admin, post, net30, shop, inv, invGet };
};

(async () => {
  const d1 = await newDb();
  const H = harness(d1);
  const { admin, net30, shop, inv, invGet } = H;
  const q = (sql, ...p) => d1.q(sql, ...p);
  const q1 = (sql, ...p) => d1.q(sql, ...p)[0] || null;
  let r;

  await A.setLocaleSettings(d1, { timeZone: "America/Denver" });
  await A.resolveTimeZone({ DB: d1 });
  await A.setTerms(d1, { defaultDays: 30, startsAt: "invoice" });
  q("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('business', ?)", JSON.stringify({ name: "Example Embroidery" }));
  const setGlobalPayments = (v) => q("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('enabledPayments', ?)", JSON.stringify(v));
  // A shop's own Payment methods count once published (the checkout reads the published shop).
  const setShopPayments = async (orgId, v) => { q("UPDATE orgs SET enabledPayments = ? WHERE orgId = ?", JSON.stringify(v || { card: true, venmo: true, zelle: true, check: true }), orgId); await A.publishShop(d1, orgId); };
  const ALL_ON = { card: true, venmo: true, zelle: true, check: true, net30: true };
  setGlobalPayments(ALL_ON);
  r = await admin({ action: "createProduct", productId: "mug", type: "other", name: "Club Mug", pricingMode: "flat", flatPrice: 10, visible: true, weightOz: 10, noDesignNeeded: true });
  if (r.status !== 200) throw new Error("createProduct " + JSON.stringify(r));
  await A.publishShop(d1, "acme");
  await A.publishShop(d1, "beta");
  const addCustomer = (email, allow, days, extra = "") => {
    q(`INSERT INTO customers (name, company, email, createdAt, updatedAt, allowNet30, termsDays${extra ? ", " + extra.split("=")[0] : ""}) VALUES (?, 'Example School District', ?, 't', 't', ?, ?${extra ? ", " + extra.split("=")[1] : ""})`,
      "Pat Example", email, allow, days);
    return q1("SELECT id FROM customers WHERE email = ? ORDER BY id DESC", email).id;
  };
  const PAT = addCustomer("pat@example.com", 1, 45);
  const SAM = addCustomer("sam@example.com", 1, null);
  addCustomer("lee@example.com", 0, 60);
  addCustomer("old@example.com", 1, 45, "archivedAt='2026-01-01T00:00:00Z'");
  addCustomer("gone@example.com", 1, 45, "mergedIntoId=" + PAT);
  const NO = { status: "ok", ok: false };

  // =================================================================================================================
  console.log("=== checkNet30: what the checkout is told about an email ===");
  // =================================================================================================================
  globalThis.__rl404 = [];
  r = await net30("pat@example.com");
  ok("a live customer allowed Net 30 with their own 45 days, at a shop that takes it: 200 { status ok, ok true, termsDays 45 }",
    r.status === 200 && same(r.body, { status: "ok", ok: true, termsDays: 45 }));
  ok("the check is counted in its own rate-limit bucket, net30_check, at 10 a minute", globalThis.__rl404.join(" ") === "net30_check/10");
  r = await net30("  PAT@Example.COM ");
  ok("the email in another case and with spaces around it is the same customer", same(r.body, { status: "ok", ok: true, termsDays: 45 }));
  r = await net30("sam@example.com");
  ok("a customer allowed Net 30 without days of their own: the usual 30 days (Global settings → Net 30 terms)", same(r.body, { status: "ok", ok: true, termsDays: 30 }));
  await A.setTerms(d1, { defaultDays: 20 });
  r = await net30("sam@example.com");
  ok("…the usual days changed to 20: 20, read fresh", same(r.body, { status: "ok", ok: true, termsDays: 20 }));
  r = await using({ getTerms: () => { throw new Error("terms unreadable (test)"); } }, () => net30("sam@example.com"));
  ok("…the terms unreadable: 30 days", same(r.body, { status: "ok", ok: true, termsDays: 30 }));
  r = await using({ getTerms: async () => ({ defaultDays: 0, startsAt: "invoice" }) }, () => net30("sam@example.com"));
  ok("…terms that give no days: 30 days", same(r.body, { status: "ok", ok: true, termsDays: 30 }));
  await A.setTerms(d1, { defaultDays: 30 });

  const noes = {};
  noes.unknown = await net30("nobody@example.com");
  noes.notAllowed = await net30("lee@example.com");
  noes.archived = await net30("old@example.com");
  noes.merged = await net30("gone@example.com");
  noes.notEmail = await net30("pat at example.com");
  noes.long = await net30("p".repeat(195) + "@example.com");
  noes.tooLong = await net30("p".repeat(250) + "@example.com");
  noes.numberEmail = await net30(12345);
  noes.noEmail = await net30(undefined);
  ok("an unknown email: exactly { status ok, ok false } (200), no days", noes.unknown.status === 200 && same(noes.unknown.body, NO));
  ok("…a customer not allowed Net 30, an archived one and a merged one: the very same answer", [noes.notAllowed, noes.archived, noes.merged].every(x => x.status === 200 && same(x.body, NO)));
  ok("…an address that isn't an email, one over 200 or over 254 characters, a number, or none: the same", [noes.notEmail, noes.long, noes.tooLong, noes.numberEmail, noes.noEmail].every(x => x.status === 200 && same(x.body, NO)));
  r = await net30("pat@example.com", { orgId: "beta" });
  ok("on a shop's own address the shop is the address's: an orgId for another shop in the request changes nothing", same(r.body, { status: "ok", ok: true, termsDays: 45 }));
  r = await net30("pat@example.com", { orgId: "acme" }, shopOrigin("beta"));
  ok("…and the other shop answers for itself (it takes Net 30 too)", same(r.body, { status: "ok", ok: true, termsDays: 45 }));
  await setShopPayments("beta", { card: true, net30: false });
  r = await net30("pat@example.com", {}, shopOrigin("beta"));
  const rAcme = await net30("pat@example.com");
  ok("a shop that switched Net 30 off for itself: { ok false } there, while the other shop still says yes", same(r.body, NO) && same(rAcme.body, { status: "ok", ok: true, termsDays: 45 }));
  await setShopPayments("beta", { card: true });
  r = await net30("pat@example.com", {}, shopOrigin("beta"));
  ok("…a shop's payment list that doesn't mention Net 30 leaves it on", same(r.body, { status: "ok", ok: true, termsDays: 45 }));
  setGlobalPayments({ ...ALL_ON, net30: false });
  r = await net30("pat@example.com");
  ok("Net 30 unticked in Global settings: { ok false } for the very customer who has it", same(r.body, NO));
  setGlobalPayments({ card: true, check: true });
  r = await net30("pat@example.com");
  ok("…Global settings that don't mention Net 30: off (it starts off, like pay on delivery)", same(r.body, NO));
  q("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('enabledPayments', 'not json')");
  r = await net30("pat@example.com");
  ok("…payment settings that can't be read: off", same(r.body, NO));
  setGlobalPayments(ALL_ON);
  globalThis.__f404 = { storefront: false };
  r = await net30("pat@example.com");
  globalThis.__f404 = {};
  ok("the Storefront switched off: { ok false }", same(r.body, NO));
  r = await net30("pat@example.com", {}, shopOrigin("draft"));
  ok("a shop that isn't published: { ok false }", same(r.body, NO));
  r = await using({ getPublishedOrg: () => { throw new Error("shop unreadable (test)"); } }, () => net30("pat@example.com"));
  ok("the shop can't be read: { ok false }, no error page", r.status === 200 && same(r.body, NO));
  {
    // The customer lookup is the one that fails: the handler's database is swapped for one call.
    const saved = H.E.DB;
    H.E.DB = new Proxy(d1, { get(t, k) {
      if (k === "prepare") return (sql) => /allowNet30 = 1/.test(sql) ? { bind: () => ({ first: async () => { throw new Error("D1_ERROR: disk I/O (test)"); } }) } : t.prepare(sql);
      const v = t[k]; return typeof v === "function" ? v.bind(t) : v; } });
    const x = await quietly(async () => { try { return await net30("pat@example.com"); } finally { H.E.DB = saved; } });
    ok("the customer lookup failing: { ok false }, logged as \"Net 30 customer check failed\"", same(x.v.body, NO) && x.logged.some(l => /Net 30 customer check failed/.test(l) && /disk I\/O/.test(l)));
  }
  const rOrg1 = await net30("pat@example.com", { orgId: 42 }, "http://localhost:8788");
  const rOrg2 = await net30("pat@example.com", { orgId: "" }, "http://localhost:8788");
  const rOrg3 = await net30("pat@example.com", { orgId: "a".repeat(101) }, "http://localhost:8788");
  const rOrg4 = await net30("pat@example.com", { orgId: "nosuchshop" }, "http://localhost:8788");
  const rLocal = await net30("pat@example.com", { orgId: "acme" }, "http://localhost:8788");
  ok("on localhost (a developer's machine) the shop comes from the request: acme says yes", same(rLocal.body, { status: "ok", ok: true, termsDays: 45 }));
  ok("…an orgId that is a number, empty, over 100 characters or no shop at all: { ok false }", [rOrg1, rOrg2, rOrg3, rOrg4].every(x => x.status === 200 && same(x.body, NO)));
  r = await net30("pat@example.com", {}, "https://" + ROOT);
  ok("the bare domain: 403 \"Orders are placed from a shop's own page.\"", r.status === 403 && r.body.message === "Orders are placed from a shop's own page.");
  r = await net30("pat@example.com", {}, ADMIN_ORIGIN);
  ok("the admin's address: 403 \"Not available here.\"", r.status === 403 && r.body.message === "Not available here.");
  globalThis.__rl404 = [];
  r = await net30("pat@example.com", {}, "https://" + ROOT);
  ok("…the bare domain is turned away before it counts against the rate limit", globalThis.__rl404.length === 0);
  globalThis.__rlBlock404 = "net30_check";
  r = await net30("pat@example.com");
  globalThis.__rlBlock404 = "";
  ok("too many checks from one address: the rate limiter's 429 and no days", r.status === 429 && r.body.status === "error" && !("termsDays" in r.body) && !("ok" in r.body));
  globalThis.__rlBlock404 = "net30_check";
  r = await net30("nobody@example.com", { orgId: 7 });
  globalThis.__rlBlock404 = "";
  ok("…the limit comes before anything is looked at, an odd request included", r.status === 429);
  {
    const old = await newDb("0121");
    old.q("INSERT OR REPLACE INTO global_settings (key, value) VALUES ('enabledPayments', ?)", JSON.stringify(ALL_ON));
    old.q("INSERT INTO customers (name, email, createdAt, updatedAt) VALUES ('Pat Example', 'pat@example.com', 't', 't')");
    await A.publishShop(old, "acme");
    const Hold = harness(old);
    const x = await quietly(() => Hold.net30("pat@example.com"));
    ok("a database before migrations/0121 (no allowNet30): { ok false }, and nothing logged", same(x.v.body, NO) && !x.logged.some(l => /Net 30/.test(l)));
    await Hold.admin({ action: "createProduct", productId: "mug", type: "other", name: "Club Mug", pricingMode: "flat", flatPrice: 10, visible: true, weightOz: 10, noDesignNeeded: true });
    await A.publishShop(old, "acme");
    const y = await quietly(() => Hold.shop("pat@example.com", "Net 30", { orderId: "OLD-1" }));
    ok("…and an order on Net 30 there: 400 \"Net 30 isn't available for this order.\", nothing saved",
      y.v.status === 400 && y.v.body.message === "Net 30 isn't available for this order." && old.q("SELECT count(*) AS n FROM orders")[0].n === 0);
  }

  // =================================================================================================================
  console.log("\n=== The storefront order on Net 30 ===");
  // =================================================================================================================
  const orderCount = () => q1("SELECT count(*) AS n FROM orders").n;
  const row = (id) => q1("SELECT paymentMethod, paid, net30, termsDays, poNumber, poTypedAt, poAcceptedAt, poAcceptedBy, placedAt, customerId FROM orders WHERE orderId = ?", id);
  const P1 = await shop("pat@example.com", "Net 30", { poNumber: "PO-1001" });
  ok("pat (allowed, 45 days) orders on Net 30 with PO-1001: 200 ok, the answer says net30 true and 45 days",
    P1.status === 200 && P1.body.status === "ok" && P1.body.net30 === true && P1.body.termsDays === 45);
  let o = row(P1.orderId);
  ok("…saved as paymentMethod \"Net 30\", on Net 30 (net30 1) with the customer's 45 days, linked to that customer",
    o.paymentMethod === "Net 30" && o.net30 === 1 && o.termsDays === 45 && o.customerId === PAT);
  ok("…the PO as typed, noted when the order was placed (poTypedAt), and not accepted", o.poNumber === "PO-1001" && o.poTypedAt === o.placedAt && o.poAcceptedAt === null && o.poAcceptedBy === "");
  ok("…not paid", o.paid === 0);
  let full = await A.getOrderById(d1, P1.orderId);
  ok("…read back: \"PO to check\", not cleared for work (net30Cleared and workCleared false, paidForWork false)",
    full.poStatus === "PO to check" && A.net30Cleared(full) === false && A.workCleared(full) === false && full.paidForWork === false);
  const S1 = await shop("sam@example.com", "Net 30");
  o = row(S1.orderId);
  ok("sam (allowed, the usual days) with no PO: 200, net30 true and the usual 30 days in the answer", S1.status === 200 && S1.body.net30 === true && S1.body.termsDays === 30);
  ok("…saved on Net 30 with no days of its own (the usual applies) and no PO", o.net30 === 1 && o.termsDays === null && o.poNumber === "" && o.poTypedAt === null && o.poAcceptedAt === null);
  ok("…read back: \"PO needed\"", (await A.getOrderById(d1, S1.orderId)).poStatus === "PO needed");
  const S2 = await shop(" SAM@EXAMPLE.COM ", " Net 30 ", { poNumber: "  PO\u0007-55\n " });
  o = row(S2.orderId);
  ok("\" Net 30 \" with spaces, the email in capitals: still Net 30, saved as \"Net 30\"", S2.status === 200 && o.paymentMethod === "Net 30" && o.net30 === 1);
  ok("…control characters in the PO become a space and it is trimmed: \"PO -55\"", o.poNumber === "PO -55");
  const S3 = await shop("sam@example.com", "Net 30", { poNumber: null });
  ok("a PO of null: no PO", S3.status === 200 && row(S3.orderId).poNumber === "");
  const S4 = await shop("sam@example.com", "Net 30", { poNumber: "P".repeat(60) });
  ok("a PO of exactly 60 characters is kept", S4.status === 200 && row(S4.orderId).poNumber === "P".repeat(60));
  r = await using({ getTerms: () => { throw new Error("terms unreadable (test)"); } }, () => shop("sam@example.com", "Net 30"));
  ok("the terms unreadable as sam orders: the answer says 30 days", r.status === 200 && r.body.termsDays === 30);

  let before = orderCount();
  const refusals = {
    long: await shop("pat@example.com", "Net 30", { poNumber: "P".repeat(61) }),
    number: await shop("pat@example.com", "Net 30", { poNumber: 1001 }),
  };
  ok("a PO over 60 characters: 400 \"A PO number is at most 60 characters.\"", refusals.long.status === 400 && refusals.long.body.message === "A PO number is at most 60 characters.");
  ok("a PO that isn't text: 400 \"That PO number isn't valid.\"", refusals.number.status === 400 && refusals.number.body.message === "That PO number isn't valid.");
  const NA = "Net 30 isn't available for this order.";
  const naFor = async (contact, extra) => { const x = await shop(contact, "Net 30", extra); return x.status === 400 && x.body.status === "error" && x.body.message === NA; };
  ok("a customer not allowed Net 30: 400 \"Net 30 isn't available for this order.\"", await naFor("lee@example.com"));
  ok("…an unknown email, an archived customer and a merged one: the same sentence", (await naFor("nobody@example.com")) && (await naFor("old@example.com")) && (await naFor("gone@example.com")));
  await setShopPayments("acme", { card: true, check: true, net30: false });
  const shopOff = await naFor("pat@example.com");
  await setShopPayments("acme", null);
  setGlobalPayments({ ...ALL_ON, net30: false });
  const globalOff = await naFor("pat@example.com", { poNumber: "PO-1" });
  setGlobalPayments(ALL_ON);
  ok("…Net 30 off for this shop, or for every shop: the same sentence, whatever the checkout was told earlier", shopOff && globalOff);
  ok("…and none of these refusals saved an order", orderCount() === before);
  const C1 = await shop("pat@example.com", "Check", { poNumber: "PO-9" });
  o = row(C1.orderId);
  ok("pat paying by Check with a PO in the request: an ordinary order (not Net 30, no PO), no net30 or termsDays in the answer",
    C1.status === 200 && o.net30 === 0 && o.poNumber === "" && o.termsDays === null && !("net30" in C1.body) && !("termsDays" in C1.body));

  // =================================================================================================================
  console.log("\n=== The invoice: the terms it shows ===");
  // =================================================================================================================
  const invoiceOf = async (orderId) => {
    const s = await admin({ action: "sendInvoice", orderId });
    if (s.status !== 200) throw new Error("sendInvoice " + JSON.stringify(s));
    return (await A.getOrderInvoiceByOrder(d1, orderId)).token;
  };
  // Dates on the order, so "today" never matters: placed 03:00 UTC on Nov 2 is Nov 1 in Denver; invoiced 05:00 UTC
  // on Nov 10 is Nov 9 there.
  const dated = (id, placedAt, invoicedAt) => q("UPDATE orders SET placedAt = ?, invoicedAt = ? WHERE orderId = ?", placedAt, invoicedAt, id);
  const TP = await invoiceOf(P1.orderId);
  dated(P1.orderId, "2026-11-02T03:00:00.000Z", "2026-11-10T05:00:00.000Z");
  r = await invGet(TP);
  ok("pat's invoice: terms { net30, 45 days, PO-1001, due 2026-12-24 (Nov 9 in Denver + 45), no dueText, \"PO to check\", no PO box }",
    r.status === 200 && same(r.body.invoice.terms, { net30: true, termsDays: 45, poNumber: "PO-1001", dueDate: "2026-12-24", dueText: "", poStatus: "PO to check", canSetPo: false }));
  dated(P1.orderId, "2026-11-02T03:00:00.000Z", null);
  r = await invGet(TP);
  ok("…never invoiced (invoicedAt empty): the days count from the order date, Nov 1 in Denver → 2026-12-16", r.body.invoice.terms.dueDate === "2026-12-16");
  await A.setTerms(d1, { startsAt: "order" });
  dated(P1.orderId, "2026-11-02T03:00:00.000Z", "2026-11-10T05:00:00.000Z");
  r = await invGet(TP);
  ok("…terms that start on the order date: 2026-12-16 although it was invoiced later", r.body.invoice.terms.dueDate === "2026-12-16");
  await A.setTerms(d1, { startsAt: "completed" });
  r = await invGet(TP);
  ok("…terms that start once the order is completed, not completed yet: no due date, \"due 45 days after your order ships or is picked up\"",
    r.body.invoice.terms.dueDate === "" && r.body.invoice.terms.dueText === "due 45 days after your order ships or is picked up");
  await A.setTerms(d1, { startsAt: "invoice" });
  r = await using({ getOrderById: async (real, ...a) => { const x = await real(...a); return x && { ...x, termsDueDate: "" }; } }, () => invGet(TP));
  ok("…a due date not known while the days start at the invoice: \"due within 45 days of the invoice\"", r.body.invoice.terms.dueDate === "" && r.body.invoice.terms.dueText === "due within 45 days of the invoice");
  r = await using({ getOrderById: async (real, ...a) => { const x = await real(...a); return x && { ...x, termsDueDate: "Dec 24" }; } }, () => invGet(TP));
  ok("…a due date that isn't YYYY-MM-DD is not shown as one", r.body.invoice.terms.dueDate === "" && r.body.invoice.terms.dueText === "due within 45 days of the invoice");
  const TS = await invoiceOf(S1.orderId);
  dated(S1.orderId, "2026-11-02T03:00:00.000Z", "2026-11-10T05:00:00.000Z");
  r = await invGet(TS);
  ok("sam's invoice (the usual 30 days, no PO): due 2026-12-09, \"PO needed\", and the PO box (canSetPo)",
    same(r.body.invoice.terms, { net30: true, termsDays: 30, poNumber: "", dueDate: "2026-12-09", dueText: "", poStatus: "PO needed", canSetPo: true }));
  await A.setTerms(d1, { defaultDays: 20 });
  r = await invGet(TS);
  ok("…the usual days changed to 20: 20 days, due 2026-11-29, worked out when read", r.body.invoice.terms.termsDays === 20 && r.body.invoice.terms.dueDate === "2026-11-29");
  await A.setTerms(d1, { defaultDays: 30 });
  // The terms made to fail (or give no days) only where the invoice page reads them, not inside the order reader.
  let inReader = 0;
  const reader = (change = (x) => x) => async (real, ...a) => { inReader++; try { const x = await real(...a); return x && change(x); } finally { inReader--; } };
  const termsAtPage = (fake) => async (real, ...a) => (inReader ? real(...a) : fake());
  r = await using({ getOrderById: reader(), getTerms: termsAtPage(() => { throw new Error("terms unreadable (test)"); }) }, () => invGet(TS));
  ok("…the terms unreadable: the invoice still opens, 30 days", r.status === 200 && r.body.invoice.terms.termsDays === 30 && r.body.invoice.terms.canSetPo === true);
  r = await using({ getOrderById: reader((x) => ({ ...x, termsDueDate: "" })), getTerms: termsAtPage(async () => ({ defaultDays: 0, startsAt: "completed" })) }, () => invGet(TS));
  ok("…terms that give no days: 30, and what the days count from as the terms say", r.body.invoice.terms.termsDays === 30 && r.body.invoice.terms.dueText === "due 30 days after your order ships or is picked up");
  r = await using({ getOrderById: async (real, ...a) => { const x = await real(...a); return x && { ...x, poStatus: "" }; } }, () => invGet(TS));
  const rTP = await using({ getOrderById: async (real, ...a) => { const x = await real(...a); return x && { ...x, poStatus: "" }; } }, () => invGet(TP));
  ok("an order read without a poStatus: worked out on the page's side (\"PO needed\" with none, \"PO to check\" typed, not accepted)",
    r.body.invoice.terms.poStatus === "PO needed" && rTP.body.invoice.terms.poStatus === "PO to check");
  const TC = await invoiceOf(C1.orderId);
  r = await invGet(TC);
  ok("an invoice for an order not on Net 30: terms null", r.status === 200 && r.body.invoice.terms === null);

  // =================================================================================================================
  console.log("\n=== The invoice: setInvoicePo ===");
  // =================================================================================================================
  globalThis.__rl404 = [];
  r = await inv({ token: TS, action: "setInvoicePo", poNumber: "  PO-2002 ", orderId: P1.orderId });
  ok("sam types PO-2002 on the invoice: 200, the fresh invoice with \"PO-2002\", \"PO to check\", no PO box",
    r.status === 200 && r.body.status === "ok" && r.body.invoice.orderId === S1.orderId && r.body.invoice.terms.poNumber === "PO-2002" &&
    r.body.invoice.terms.poStatus === "PO to check" && r.body.invoice.terms.canSetPo === false);
  ok("…counted in its own bucket, invoice_po at 10, after the page's own", globalThis.__rl404.join(" ") === "invoice/30 invoice_po/10");
  o = row(S1.orderId);
  ok("…saved as the customer's (poTypedAt) and not accepted, the usual days kept (none of its own)", o.poNumber === "PO-2002" && !!o.poTypedAt && o.poAcceptedAt === null && o.termsDays === null && o.net30 === 1);
  ok("…only on that invoice's order: an orderId in the request is ignored (pat's PO is still PO-1001)", row(P1.orderId).poNumber === "PO-1001");
  ok("…not cleared for work", A.net30Cleared(await A.getOrderById(d1, S1.orderId)) === false);
  ok("…audited as order.invoice_po_typed (from \"\" to PO-2002) by customer-invoice with the address",
    same(q("SELECT detail, actor, ip FROM audit_log WHERE orderId = ? AND action = 'order.invoice_po_typed'", S1.orderId),
      [{ detail: JSON.stringify({ poNumber: { from: "", to: "PO-2002" } }), actor: "customer-invoice", ip: "203.0.113.7" }]));
  r = await inv({ token: TS, action: "setInvoicePo", poNumber: "PO-2003" });
  ok("the customer can replace their own PO while it isn't accepted: PO-2003, audited from PO-2002",
    r.status === 200 && row(S1.orderId).poNumber === "PO-2003" &&
    q("SELECT detail FROM audit_log WHERE orderId = ? AND action = 'order.invoice_po_typed' ORDER BY id DESC", S1.orderId)[0].detail === JSON.stringify({ poNumber: { from: "PO-2002", to: "PO-2003" } }));
  const emptyish = await Promise.all(["", "   ", 2002, null].map(p => inv({ token: TS, action: "setInvoicePo", poNumber: p })));
  const noField = await inv({ token: TS, action: "setInvoicePo" });
  ok("no PO, a blank one, a number or null: 400 \"Enter your PO number.\"", [...emptyish, noField].every(x => x.status === 400 && x.body.message === "Enter your PO number."));
  r = await inv({ token: TS, action: "setInvoicePo", poNumber: "P".repeat(61) });
  ok("61 characters: 400 \"A PO number can be up to 60 characters.\" and the PO unchanged", r.status === 400 && r.body.message === "A PO number can be up to 60 characters." && row(S1.orderId).poNumber === "PO-2003");
  r = await inv({ token: TS, action: "setInvoicePo", poNumber: " " + "Q".repeat(60) + " " });
  ok("…60 characters after trimming: saved", r.status === 200 && row(S1.orderId).poNumber === "Q".repeat(60));
  globalThis.__rlBlock404 = "invoice_po";
  r = await inv({ token: TS, action: "setInvoicePo", poNumber: "PO-RL" });
  globalThis.__rlBlock404 = "";
  ok("too many tries: 429, nothing saved", r.status === 429 && row(S1.orderId).poNumber === "Q".repeat(60));
  r = await inv({ token: TC, action: "setInvoicePo", poNumber: "PO-3003" });
  ok("an order not on Net 30: 409 \"This order doesn't take a PO number — contact us if you need one on it.\"",
    r.status === 409 && r.body.message === "This order doesn't take a PO number — contact us if you need one on it." && row(C1.orderId).poNumber === "");
  r = await admin({ action: "acceptOrderPo", orderId: S1.orderId });
  ok("(staff accept sam's PO)", r.status === 200 && !!row(S1.orderId).poAcceptedAt);
  r = await inv({ token: TS, action: "setInvoicePo", poNumber: "PO-4004" });
  ok("once a PO is accepted: 409 \"Your PO is already on this order — contact us to change it.\", the PO unchanged",
    r.status === 409 && r.body.message === "Your PO is already on this order — contact us to change it." && row(S1.orderId).poNumber === "Q".repeat(60));
  r = await invGet(TS);
  ok("…the invoice shows it accepted, with no PO box", r.body.invoice.terms.poStatus === "accepted" && r.body.invoice.terms.canSetPo === false);
  r = await using({ getOrderById: async (real, ...a) => { const x = await real(...a); return x && { ...x, poAcceptedAt: "" }; } },
    () => inv({ token: TS, action: "setInvoicePo", poNumber: "PO-4004" }));
  ok("accepted between reading the order and saving: the database refuses, 409 \"Your PO number has already been accepted.\"",
    r.status === 409 && r.body.message === "Your PO number has already been accepted." && row(S1.orderId).poNumber === "Q".repeat(60));

  // Pat's second order (45 days, no PO), for the remaining refusals.
  const P2 = await shop("pat@example.com", "Net 30");
  const TP2 = await invoiceOf(P2.orderId);
  r = await inv({ token: TP2, action: "setInvoicePo", poNumber: "PO-5005" }, { waitUntil: false });
  ok("a customer with their own 45 days types a PO: the 45 days stay on the order", r.status === 200 && row(P2.orderId).termsDays === 45 && row(P2.orderId).poNumber === "PO-5005");
  ok("…with no waitUntil the audit row is written before the answer", q("SELECT count(*) AS n FROM audit_log WHERE orderId = ? AND action = 'order.invoice_po_typed'", P2.orderId)[0].n === 1);
  let x = await quietly(() => using({ insertAuditLog: async (real, db, rec) => { if (rec.action === "order.invoice_po_typed") throw new Error("audit down (test)"); return real(db, rec); } },
    () => inv({ token: TP2, action: "setInvoicePo", poNumber: "PO-5006" })));
  ok("the audit write failing: the PO is still saved (200), and the failure logged", x.v.status === 200 && row(P2.orderId).poNumber === "PO-5006" &&
    x.logged.some(l => /Invoice PO number saved, but recording it failed/.test(l)));
  x = await quietly(() => using({ setOrderTerms: () => { throw new Error("D1_ERROR: busy (test)"); } }, () => inv({ token: TP2, action: "setInvoicePo", poNumber: "PO-5007" })));
  ok("the save throwing: 500 \"We couldn't save your PO number just now. Please try again.\", logged, nothing changed",
    x.v.status === 500 && x.v.body.message === "We couldn't save your PO number just now. Please try again." && x.logged.some(l => /A PO number on an invoice failed/.test(l)) && row(P2.orderId).poNumber === "PO-5006");
  const say = async (answer) => (await using({ setOrderTerms: async () => answer }, () => inv({ token: TP2, action: "setInvoicePo", poNumber: "PO-5008" })));
  const rErr = await say({ error: "This order is voided." }), rReason = await say({ ok: false, reason: "Not now." }), rMsg = await say({ ok: false, message: "Later." }), rBare = await say({ ok: false });
  ok("a refusal from the database is passed on as its own sentence (409): its error, reason or message",
    rErr.status === 409 && rErr.body.message === "This order is voided." && rReason.body.message === "Not now." && rMsg.body.message === "Later.");
  ok("…a refusal without words: \"We couldn't save your PO number.\"", rBare.status === 409 && rBare.body.message === "We couldn't save your PO number.");
  ok("…and no audit row for any refusal (only PO-5005's: PO-5006's write failed)", same(q("SELECT detail FROM audit_log WHERE orderId = ? AND action = 'order.invoice_po_typed'", P2.orderId).map(x => JSON.parse(x.detail).poNumber.to), ["PO-5005"]));
  const P3 = await shop("pat@example.com", "Net 30");
  const TP3 = await invoiceOf(P3.orderId);
  r = await admin({ action: "addPayment", orderId: P3.orderId, amount: 20, method: "check" });
  ok("(pat's third order paid in full by check)", r.status === 200 && q1("SELECT paid FROM orders WHERE orderId = ?", P3.orderId).paid === 1);
  r = await inv({ token: TP3, action: "setInvoicePo", poNumber: "PO-6006" });
  ok("a paid order: 409 \"This order is already paid — contact us if you need your PO number on it.\"",
    r.status === 409 && r.body.message === "This order is already paid — contact us if you need your PO number on it." && row(P3.orderId).poNumber === "");
  r = await invGet(TP3);
  ok("…its invoice has no PO box (canSetPo false), still \"PO needed\"", r.body.invoice.terms.canSetPo === false && r.body.invoice.terms.poStatus === "PO needed");
  r = await using({ getOrderById: async (real, ...a) => { const x = await real(...a); return x && { ...x, balanceDue: 5 }; } }, () => invGet(TP3));
  ok("…paid but with money still owed (a later charge): the box is back", r.body.invoice.terms.canSetPo === true);
  r = await using({ getOrderById: async (real, ...a) => { const x = await real(...a); return x && { ...x, poNumber: "" }; } }, () => invGet(TS));
  const rNone = await using({ getOrderById: async (real, ...a) => { const x = await real(...a); return x && { ...x, poNumber: "", poAcceptedAt: "" }; } }, () => invGet(TS));
  ok("an order with no PO number but an acceptance still on it: no box; with neither: the box", r.body.invoice.terms.canSetPo === false && rNone.body.invoice.terms.canSetPo === true);


  // =================================================================================================================
  console.log("\n=== The checkout page: Net 30 for the email typed (public/storefront.js, with a stand-in server) ===");
  // =================================================================================================================
  const baseCatalog = { name: "Example Club", eyebrow: "", accent: "#123456", ready: true, desc: "", designImages: { shirt: "", cap: "", detail: "" },
    enabledPayments: ["Card", "Check"], salesTaxRate: 0, discountCodes: false, graphics: [], net30Offered: true,
    products: [{ id: "tee", type: "shirt", name: "Club Tee", sub: "", images: [], features: [], flatPrice: 20, personalizationPrice: null }] };
  // server.net30(body) → { status, body } (or a Promise); server.order(body) → { status, body }; server.throws(body) → true to fail the fetch.
  const page = async ({ catalog = {}, preview = false, server = {} } = {}) => {
    const calls = [];
    const vc = new VirtualConsole();
    vc.on("jsdomError", (e) => { if (!/Not implemented: navigation/.test(String(e && e.message))) console.error(e); });
    const answer = { status: "ok", orgId: "club", features: {}, ...(preview ? { preview: true } : {}), catalog: { ...baseCatalog, ...catalog } };
    const dom = new JSDOM(storefrontPage({ adminCss: false }), { runScripts: "dangerously", url: shopOrigin("club") + "/", pretendToBeVisual: true, virtualConsole: vc,
      beforeParse(win) {
        win.scrollTo = () => {}; win.alert = () => {};
        win.fetch = async (u, opts) => {
          const url = String(u), body = opts && opts.body ? JSON.parse(opts.body) : null;
          calls.push({ url, body });
          if (server.throws && server.throws(body)) throw new TypeError("Failed to fetch");
          let r = { status: 200, body: {} };
          if (url.startsWith("/api/catalog")) r = { status: 200, body: answer };
          else if (url.startsWith("/api/orders") && body && body.action === "checkNet30") r = await (server.net30 ? server.net30(body) : { status: 200, body: { status: "ok", ok: true, termsDays: 45 } });
          else if (url.startsWith("/api/orders")) r = await (server.order ? server.order(body) : { status: 200, body: { status: "ok", checkoutToken: "tok-1", emailOn: true, net30: true, termsDays: 45 } });
          const text = JSON.stringify(r.body);
          return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => JSON.parse(text), text: async () => text, headers: { get: () => null } };
        };
      } });
    const w = dom.window, d = w.document;
    await wait(() => !!d.getElementById("ticketPanel"));
    const ev = (el, t) => el.dispatchEvent(new w.Event(t, { bubbles: true }));
    const $ = (id) => d.getElementById(id);
    d.querySelector('[data-action="add"][data-pid="tee"]').click();
    const type = (text) => { const i = $("custContact"); i.value = text; ev(i, "input"); };
    const leave = () => ev($("custContact"), "change");
    const checks = () => calls.filter(x => x.body && x.body.action === "checkNet30");
    const orders = () => calls.filter(x => x.url.startsWith("/api/orders") && x.body && !x.body.action);
    const options = () => $("custPaymentMethod") ? [...$("custPaymentMethod").options].map(o => o.value + "=" + o.textContent) : null;
    const offered = () => !!d.querySelector('#custPaymentMethod option[value="Net 30"]');
    const choose = (m) => { $("custPaymentMethod").value = m; ev($("custPaymentMethod"), "change"); };
    const poType = (text) => { const i = $("custPoNumber"); i.value = text; ev(i, "input"); };
    const status = () => { const s = $("statusRegion"); return s ? s.textContent : ""; };
    const place = async () => { $("custName").value = "Pat Example"; $("placeOrderBtn").click(); await pause(80); };
    return { w, d, calls, ev, $, type, leave, checks, orders, options, offered, choose, poType, status, place };
  };

  {
    let p = await page({ catalog: { net30Offered: false, enabledPayments: ["Card", "Check", "Net 30"] } });
    p.type("pat@example.com"); await pause(800); p.leave(); await pause(30);
    ok("a shop where Net 30 can't be offered (net30Offered false): typing and leaving the email asks nothing", p.checks().length === 0);
    ok("…and \"Net 30\" is never an option, even sent in the shop's payment list", same(p.options(), ["=How will you pay?", "Card=Credit / Debit Card", "Check=Check"]));
    p = await page({ catalog: { net30Offered: "true" } });
    p.type("pat@example.com"); await pause(800);
    ok("…net30Offered anything but true itself (\"true\"): nothing asked", p.checks().length === 0);
    p = await page({ preview: true });
    p.type("pat@example.com"); await pause(800); p.leave(); await pause(30);
    ok("a draft preview: nothing asked", p.checks().length === 0 && !p.offered());
  }
  {
    const p = await page();
    p.type("pat@example.co");
    await pause(300);
    p.type("pat@example.com");
    await pause(300);
    ok("at a shop that may offer it: nothing asked while the customer is still typing", p.checks().length === 0);
    await pause(600);
    ok("…700 ms after the last key ONE question: { action checkNet30, orgId club, email pat@example.com }",
      p.checks().length === 1 && p.checks()[0].url === "/api/orders" && same(p.checks()[0].body, { action: "checkNet30", orgId: "club", email: "pat@example.com" }));
    ok("…the answer yes: \"Net 30 (pay by invoice)\" joins the shop's methods", same(p.options(), ["=How will you pay?", "Card=Credit / Debit Card", "Check=Check", "Net 30=Net 30 (pay by invoice)"]));
    ok("…announced: \"Net 30 (pay by invoice) is available for this order.\"", p.status() === "Net 30 (pay by invoice) is available for this order.");
    ok("…the email typed is kept through the redraw", p.$("custContact").value === "pat@example.com");
    const po = p.$("custPoNumber");
    ok("…a PO number box under it, hidden until Net 30 is chosen", !!po && p.$("net30PoWrap").hidden === true);
    ok("…it takes up to 60 characters, no autocomplete, \"PO number (optional)\", described by its hint",
      po.maxLength === 60 && po.getAttribute("autocomplete") === "off" && po.placeholder === "PO number (optional)" && po.getAttribute("aria-describedby") === "custPoHint" &&
      p.$("custPoHint").textContent === "Your PO number, if you have it — you can add it later from your invoice.");
    p.leave(); await pause(30);
    ok("leaving the field with the same address asks nothing more (the answer is in hand)", p.checks().length === 1);
    p.type("  PAT@Example.com "); await pause(800);
    ok("…nor the same address in other case or with spaces", p.checks().length === 1 && p.offered());
    p.choose("Net 30");
    ok("choosing Net 30: the PO box shows", p.$("net30PoWrap").hidden === false);
    ok("…the hint: \"No payment now — we'll send you an invoice, due within 45 days.\"", p.$("paymentHint").textContent === "No payment now — we'll send you an invoice, due within 45 days.");
    p.poType("  PO-1001 ");
    p.choose("Check");
    ok("switching to Check hides the PO box", p.$("net30PoWrap").hidden === true);
    p.choose("Net 30");
    ok("…and back: shown again with what was typed", p.$("net30PoWrap").hidden === false && p.$("custPoNumber").value === "  PO-1001 ");
    p.d.querySelector('.cart-line [data-action="qty"][data-d="1"]').click();
    ok("a redraw of the checkout (the cart changed) keeps Net 30 chosen and the PO typed", p.$("custPaymentMethod").value === "Net 30" && p.$("custPoNumber").value === "  PO-1001 " && p.$("net30PoWrap").hidden === false);
    await p.place();
    const sent = p.orders()[0];
    ok("Place order sends paymentMethod \"Net 30\" and the PO trimmed (poNumber \"PO-1001\")", p.orders().length === 1 && sent.body.paymentMethod === "Net 30" && sent.body.poNumber === "PO-1001");
    ok("…with no question asked again (the answer for this address is in hand), and no card step", p.checks().length === 1 && !p.calls.some(x => x.url.startsWith("/api/checkout")));
    ok("…the thank-you page: \"Your order is in — there's nothing to pay now. We'll send an invoice; payment is due within 45 days. Your PO number PO-1001 is on the order; we'll confirm it.\"",
      p.d.body.textContent.includes("Your order is in — there's nothing to pay now. We'll send an invoice; payment is due within 45 days. Your PO number PO-1001 is on the order; we'll confirm it."));
  }
  {
    const p = await page({ server: { net30: () => ({ status: 200, body: { status: "ok", ok: true, termsDays: "soon" } }),
      order: () => ({ status: 200, body: { status: "ok", checkoutToken: "tok-2", net30: true, termsDays: 60 } }) } });
    p.type("sam@example.com"); p.leave(); await pause(40);
    ok("leaving the field asks at once (no pause), and only once when the pause then ends", p.checks().length === 1 && p.offered());
    await pause(750);
    ok("…(still one question after the pause)", p.checks().length === 1);
    p.choose("Net 30");
    ok("an answer whose days aren't a whole number: the hint names no days, \"No payment now — we'll send you an invoice.\"", p.$("paymentHint").textContent === "No payment now — we'll send you an invoice.");
    p.poType("P".repeat(70));
    await p.place();
    ok("a blank-free PO longer than the box allows is cut to 60 characters", p.orders()[0].body.poNumber === "P".repeat(60));
    ok("…the thank-you page takes the days from the server's answer (60): \"payment is due within 60 days\"", p.d.body.textContent.includes("payment is due within 60 days."));
  }
  {
    const p = await page({ server: { net30: () => ({ status: 200, body: { status: "ok", ok: true } }), order: () => ({ status: 200, body: { status: "ok", checkoutToken: "tok-3" } }) } });
    p.type("sam@example.com"); p.leave(); await pause(40);
    p.choose("Net 30");
    p.poType("   ");
    await p.place();
    ok("Net 30 with no PO typed (only spaces): no poNumber in the order sent", p.orders().length === 1 && !("poNumber" in p.orders()[0].body) && p.orders()[0].body.paymentMethod === "Net 30");
    ok("…no days anywhere: \"payment is due within the terms on it. Add your PO number from your invoice when you have it.\"",
      p.d.body.textContent.includes("We'll send an invoice; payment is due within the terms on it. Add your PO number from your invoice when you have it."));
  }
  {
    const p = await page();
    p.type("pat@example.com"); p.leave(); await pause(40);
    p.choose("Net 30"); p.poType("PO-9"); p.choose("Check");
    await p.place();
    ok("Net 30 offered, a PO typed, then Check chosen: the order is a Check order with no poNumber", p.orders()[0].body.paymentMethod === "Check" && !("poNumber" in p.orders()[0].body));
  }
  {
    const answers = { "pat@example.com": { status: "ok", ok: true, termsDays: 45 } };
    const p = await page({ server: { net30: (b) => ({ status: 200, body: answers[b.email] || { status: "ok", ok: false } }) } });
    p.type("lee@example.com"); p.leave(); await pause(40);
    ok("the answer no: no Net 30 option, nothing announced about it", p.checks().length === 1 && !p.offered() && !/Net 30/.test(p.status()));
    p.type("pat@example.com"); p.leave(); await pause(40);
    ok("…another address that may: asked, and offered", p.checks().length === 2 && p.offered());
    p.type("lee@example.com"); p.leave(); await pause(40);
    ok("…back to the address that may not: asked again, and Net 30 is taken out of the select", p.checks().length === 3 && !p.offered());
    p.type("pat@example.com"); p.leave(); await pause(40);
    p.type("pat@"); p.leave(); await pause(40);
    ok("…an address that isn't an email yet: not sent to the server, and Net 30 taken out", p.checks().length === 4 && !p.offered());
    p.type("pat@example.com"); p.leave(); await pause(40); p.choose("Net 30");
    p.type("lee@example.com"); p.leave(); await pause(40);
    ok("…Net 30 chosen and then taken out: the select is back to \"How will you pay?\" and the PO box is gone", p.$("custPaymentMethod").value === "" && !p.$("custPoNumber") && !p.offered());
    ok("…and the hint no longer promises an invoice: \"Choose how you'll pay — you'll see how to pay after you place the order.\"",
      p.$("paymentHint").textContent === "Choose how you'll pay — you'll see how to pay after you place the order." && !/invoice/.test(p.$("paymentHint").textContent));
  }
  {
    const answers = { "pat@example.com": { status: "ok", ok: true, termsDays: 45 } };
    const p = await page({ server: { net30: (b) => ({ status: 200, body: answers[b.email] || { status: "ok", ok: false } }) } });
    p.type("pat@example.com"); p.leave(); await pause(40);
    p.choose("Net 30");
    p.$("custContact").value = "lee@example.com";   // changed with no event (pasted and Place order clicked at once)
    await p.place();
    ok("Net 30 chosen, then the email changed to one that may not use it: Place order asks about the new address first",
      p.checks().length === 2 && p.checks()[1].body.email === "lee@example.com");
    ok("…and stops: \"Net 30 isn't available for this email address — please choose another way to pay.\", nothing sent, the select focused",
      p.orders().length === 0 && p.$("checkoutMsg").textContent === "Net 30 isn't available for this email address — please choose another way to pay." && p.d.activeElement === p.$("custPaymentMethod"));
  }
  {
    // Answers that arrive late, or not at all.
    const pending = [];
    const p = await page({ server: { net30: (b) => new Promise(res => pending.push({ email: b.email, res })), throws: (b) => b && b.email === "offline@example.com" } });
    p.type("pat@example.com"); p.leave(); await pause(20);
    p.type("sam@example.com"); p.leave(); await pause(20);
    ok("two addresses asked about in turn: two questions in flight", p.checks().length === 2 && pending.length === 2);
    pending[0].res({ status: 200, body: { status: "ok", ok: true, termsDays: 45 } }); await pause(30);
    ok("…the reply for the address typed over is dropped (no Net 30 for sam on pat's answer)", !p.offered());
    pending[1].res({ status: 200, body: { status: "ok", ok: false } }); await pause(30);
    ok("…and the reply for the address in the box now decides: no", !p.offered());
    p.type("offline@example.com"); p.leave(); await pause(30);
    ok("no answer at all (the fetch fails): no Net 30", p.checks().length === 3 && !p.offered());
    p.leave(); await pause(30);
    ok("…and nothing remembered: leaving the field asks again", p.checks().length === 4);
  }
  {
    const p = await page({ server: { net30: () => ({ status: 500, body: { status: "error", message: "D1_ERROR" } }) } });
    p.type("pat@example.com"); p.leave(); await pause(30);
    ok("a server error: no Net 30, and nothing shown about it", !p.offered() && !/D1_ERROR/.test(p.d.body.textContent));
    p.leave(); await pause(30);
    ok("…an answer that came back is remembered for that address (leaving the field again asks nothing)", p.checks().length === 1);
  }
  {
    const p = await page({ server: { net30: () => ({ status: 200, body: "not an answer" }) } });
    p.type("pat@example.com"); p.leave(); await pause(30);
    ok("an answer that isn't the expected shape: no Net 30", p.checks().length === 1 && !p.offered());
  }

  // =================================================================================================================
  console.log("\n=== The invoice page: the Terms block and the PO box (public/storefront.js against the real invoice.js) ===");
  // =================================================================================================================
  let gate = null, failPost = false;
  const invPage = async (token) => {
    const calls = [];
    const vc = new VirtualConsole();
    vc.on("jsdomError", (e) => { if (!/Not implemented: navigation/.test(String(e && e.message))) console.error(e); });
    const dom = new JSDOM(storefrontPage({ adminCss: false }), { runScripts: "dangerously", url: shopOrigin("acme") + "/?invoice=" + token, pretendToBeVisual: true, virtualConsole: vc,
      beforeParse(win) {
        win.scrollTo = () => {};
        win.fetch = async (u, opts) => {
          const url = String(u), body = opts && opts.body ? JSON.parse(opts.body) : null;
          calls.push({ url, body });
          const wrapRes = async (res) => { const text = await res.text(); return { ok: res.status < 400, status: res.status, json: async () => JSON.parse(text) }; };
          if (url.startsWith("/api/invoice?")) return wrapRes(await A.invoiceApi.onRequestGet({ env: H.E, request: { url: shopOrigin("acme") + url, headers: { get: () => null } } }));
          if (url === "/api/invoice") {
            if (gate) await gate;
            if (failPost) throw new TypeError("Failed to fetch");
            return wrapRes(await A.invoiceApi.onRequestPost({ env: H.E, waitUntil: () => {}, request: { url: shopOrigin("acme") + url, json: async () => body, headers: { get: () => null } } }));
          }
          return { ok: true, status: 200, json: async () => ({ status: "error", message: "n/a", country: "US", business: { name: "Example Embroidery" } }) };
        };
      } });
    const w = dom.window, d = w.document;
    await wait(() => !!d.querySelector(".inv h1, .inv h2, .inv-err"));
    const $ = (id) => d.getElementById(id);
    const terms = () => { const t = d.querySelector(".inv-terms"); return t ? t.textContent.replace(/\s+/g, " ").trim() : null; };
    const heading = () => [...d.querySelectorAll(".inv h2")].map(h => h.textContent);
    const posts = () => calls.filter(x => x.url === "/api/invoice");
    const typePo = (text) => { const i = $("invPo"); i.value = text; i.dispatchEvent(new w.Event("input", { bubbles: true })); };
    const status = () => { const s = $("statusRegion"); return s ? s.textContent : ""; };
    return { w, d, $, terms, heading, posts, typePo, status };
  };
  const S5 = await shop("sam@example.com", "Net 30");
  const TS5 = await invoiceOf(S5.orderId);
  dated(S5.orderId, "2026-11-02T03:00:00.000Z", "2026-11-10T05:00:00.000Z");
  {
    const p = await invPage(TS5);
    ok("a Net 30 invoice with no PO: a \"Terms\" heading before \"Pay\"", p.heading().join("|").includes("Terms|Pay"));
    ok("…\"Net 30 — due Dec 9, 2026\" and \"PO needed: add your PO number below.\"", p.terms() === "Net 30 — due Dec 9, 2026PO needed: add your PO number below.");
    const box = p.$("invPo"), btn = p.$("invPoBtn");
    ok("…the box: labelled \"Your PO number\", up to 60 characters, no autocomplete, described by its message, with \"Add PO number\"",
      !!box && p.d.querySelector('label[for="invPo"]').textContent === "Your PO number" && box.maxLength === 60 && box.getAttribute("autocomplete") === "off" &&
      box.getAttribute("aria-describedby") === "invPoMsg" && btn.textContent === "Add PO number" && !btn.disabled);
    btn.click(); await pause(20);
    ok("Add with an empty box: \"Enter your PO number.\" (an alert), nothing sent", p.$("invPoMsg").textContent === "Enter your PO number." && p.$("invPoMsg").getAttribute("role") === "alert" && p.posts().length === 0);
    p.typePo("x");
    ok("…typing clears the message", p.$("invPoMsg").textContent === "");
    p.typePo("P".repeat(61)); p.$("invPoBtn").click(); await pause(20);
    ok("61 characters (pasted past the box's limit): \"A PO number can be up to 60 characters.\", nothing sent", p.$("invPoMsg").textContent === "A PO number can be up to 60 characters." && p.posts().length === 0);
    let release; gate = new Promise(r => { release = r; });
    p.typePo("  PO-7007 ");
    p.$("invPo").dispatchEvent(new p.w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await pause(20);
    ok("Enter in the box sends it: \"Saving…\", the button disabled, the text kept", p.$("invPoBtn").textContent === "Saving…" && p.$("invPoBtn").disabled && p.$("invPo").value === "  PO-7007 ");
    release(); gate = null; await wait(() => !p.$("invPo"));
    ok("…POST /api/invoice { token, action setInvoicePo, poNumber \"PO-7007\" } (trimmed)", p.posts().length === 1 && same(p.posts()[0].body, { token: TS5, action: "setInvoicePo", poNumber: "PO-7007" }));
    ok("…the box is gone; the terms read \"Net 30 — PO-7007 — due Dec 9, 2026\" (no \"PO PO-\")", !p.$("invPo") && p.terms() === "Net 30 — PO-7007 — due Dec 9, 2026");
    const thanks = p.d.querySelector('.inv-detail[role="status"]');
    ok("…\"Thanks — we'll confirm your PO.\" under it, and announced", !!thanks && thanks.textContent === "Thanks — we'll confirm your PO." && p.status() === "Thanks — we'll confirm your PO.");
    ok("…saved on the order as the customer's, not accepted", row(S5.orderId).poNumber === "PO-7007" && row(S5.orderId).poAcceptedAt === null);
    const again = await invPage(TS5);
    ok("opened again: \"Net 30 — PO-7007 — due Dec 9, 2026\" and \"We'll confirm your PO number.\"", again.terms() === "Net 30 — PO-7007 — due Dec 9, 2026We'll confirm your PO number." && !again.$("invPo"));
    await admin({ action: "acceptOrderPo", orderId: S5.orderId });
    const acc = await invPage(TS5);
    ok("accepted by the shop: just \"Net 30 — PO-7007 — due Dec 9, 2026\"", acc.terms() === "Net 30 — PO-7007 — due Dec 9, 2026");
  }
  {
    const P6 = await shop("pat@example.com", "Net 30", { poNumber: "1001" });
    const T6 = await invoiceOf(P6.orderId);
    dated(P6.orderId, "2026-11-02T03:00:00.000Z", "2026-11-10T05:00:00.000Z");
    let p = await invPage(T6);
    ok("pat's 45 days and a PO that is just a number: \"Net 45 — PO 1001 — due Dec 24, 2026\"", p.terms() === "Net 45 — PO 1001 — due Dec 24, 2026We'll confirm your PO number.");
    await A.setTerms(d1, { startsAt: "completed" });
    p = await invPage(T6);
    await A.setTerms(d1, { startsAt: "invoice" });
    ok("terms that start on completion: \"Net 45 — PO 1001 — due 45 days after your order ships or is picked up\"",
      p.terms() === "Net 45 — PO 1001 — due 45 days after your order ships or is picked up We'll confirm your PO number.".replace(" We'll", "We'll"));
    await admin({ action: "addPayment", orderId: P6.orderId, amount: 20, method: "check" });
    p = await invPage(T6);
    ok("paid in full: no Terms heading, the line \"Net 45 — PO 1001\" only", !p.heading().includes("Terms") && p.terms() === "Net 45 — PO 1001");
  }
  {
    const P7 = await shop("pat@example.com", "Net 30");
    const T7 = await invoiceOf(P7.orderId);
    await admin({ action: "addPayment", orderId: P7.orderId, amount: 20, method: "check" });
    let p = await invPage(T7);
    ok("paid in full with no PO: no terms line at all", p.terms() === null && !p.heading().includes("Terms"));
    const C7 = await shop("pat@example.com", "Check");
    p = await invPage(await invoiceOf(C7.orderId));
    ok("an invoice not on Net 30: no Terms", p.terms() === null && !p.heading().includes("Terms"));
  }
  {
    const S8 = await shop("sam@example.com", "Net 30");
    const T8 = await invoiceOf(S8.orderId);
    dated(S8.orderId, "2026-11-02T03:00:00.000Z", "2026-11-10T05:00:00.000Z");
    let p = await using({ getOrderById: async (real, ...a) => { const x = await real(...a); return x && { ...x, poAcceptedAt: "2026-11-03T00:00:00Z" }; } }, () => invPage(T8));
    ok("no PO but the box not offered (canSetPo false): \"PO needed: please send us your PO number.\" and no box", /PO needed: please send us your PO number\.$/.test(p.terms()) && !p.$("invPo"));
    p = await invPage(T8);
    // The shop puts a PO on it meanwhile (staff: accepted at once); the page still shows the box.
    await admin({ action: "setOrderTerms", orderId: S8.orderId, poNumber: "PO-8008" });
    p.typePo("PO-8009"); p.$("invPoBtn").click(); await wait(() => !!p.$("invPoMsg") && !!p.$("invPoMsg").textContent);
    ok("a refusal (409): the server's sentence under the box, the text kept", p.$("invPoMsg").textContent === "Your PO is already on this order — contact us to change it." && p.$("invPo").value === "PO-8009" && !p.$("invPoBtn").disabled);
    const S9 = await shop("sam@example.com", "Net 30");
    const T9 = await invoiceOf(S9.orderId);
    p = await invPage(T9);
    globalThis.__rlBlock404 = "invoice_po";
    p.typePo("PO-9009"); p.$("invPoBtn").click(); await wait(() => !!p.$("invPoMsg").textContent);
    globalThis.__rlBlock404 = "";
    ok("too many tries (429): \"Too many tries — please wait a minute and try again.\"", p.$("invPoMsg").textContent === "Too many tries — please wait a minute and try again.");
    await quietly(async () => { await using({ setOrderTerms: () => { throw new Error("D1_ERROR: internals (test)"); } }, async () => { p.$("invPoBtn").click(); await wait(() => /couldn't save that/.test(p.$("invPoMsg").textContent)); }); });
    ok("a server failure (500): \"We couldn't save that just now. Please try again.\", never its internals", p.$("invPoMsg").textContent === "We couldn't save that just now. Please try again." && !/D1_ERROR/.test(p.d.body.textContent));
    failPost = true;
    p.$("invPoBtn").click(); await wait(() => /reach the server/.test(p.$("invPoMsg").textContent));
    failPost = false;
    ok("no answer at all: \"We couldn't reach the server — try again.\", the button usable again", p.$("invPoMsg").textContent === "We couldn't reach the server — try again." && !p.$("invPoBtn").disabled);
    p.$("invPo").dispatchEvent(new p.w.KeyboardEvent("keydown", { key: "a", bubbles: true }));
    await pause(20);
    ok("another key in the box sends nothing", p.posts().length === 3);
    p.$("invPoBtn").click(); await wait(() => !p.$("invPo"));
    ok("…and the next try goes through", row(S9.orderId).poNumber === "PO-9009");
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
