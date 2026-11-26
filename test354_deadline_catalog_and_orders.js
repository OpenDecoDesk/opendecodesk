const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { shopOrigin, ADMIN_ORIGIN } = require("./testlib/hosts.js");
const { MAIL_ENV, MAIL_OK, captureMail } = require("./testlib/mail-mock");
const { ok } = require("./testlib/check");
const roles = require("./testlib/roles");

// A shop's order deadline ends at 11:59:59 pm on its day in the business's time zone (Global settings → Region), for
// every shopper and for the server alike, with no grace period:
//   functions/api/catalog.js — the catalog answer carries the closing moment (orderClosesAt), the zone
//     (orderTimeZone) and its short name (orderZoneLabel), worked out from the cached settings — the saved Region zone
//     is in the cached meta entry, so the answer is the same for every request. A new Region zone moves it (the save
//     refreshes the catalog). A meta entry cached before it carried the zone sends none (the storefront then keeps
//     its old check).
//   functions/api/orders.js — order placement refuses an order after that moment when late orders are off, and takes
//     one just before it. Before, it took orders until the deadline day ended at UTC-12: seven hours past midnight in
//     New York, and a whole day late in Tokyo.
// The REAL db.js, catalogCache.js, catalog.js and orders.js on sql.js; only the Cache API and the clock (Date.now) are
// stand-ins. Invented data only.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");

const mail = [];
global.fetch = async (url, init) => {
  if (captureMail(url, init, mail)) return MAIL_OK;
  throw new Error("unexpected fetch " + url);
};

// The libraries in one scope; orders.js and catalog.js each in their own (both declare onRequest…).
const L = new Function(
  strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  strip(read("functions/_lib/db.js")) + "\n" + strip(read("functions/_lib/email.js")) + "\n" + strip(read("functions/_lib/quoteToken.js")) + "\n" +
  strip(read("functions/_lib/boxSize.js")) + "\n" + strip(read("functions/_lib/catalogCache.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'pat@example.test';\n" + roles.adminAs() + "\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyTurnstile = async () => ({ ok: true });\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  "const ordersApi = (function(){\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost; })();\n" +
  "const catalogApi = (function(){\n" + strip(read("functions/api/catalog.js")) + "\nreturn { onRequestGet, orderClosing_ }; })();\n" +
  "return { ordersApi, catalogGet: catalogApi.onRequestGet, orderClosing_: catalogApi.orderClosing_,\n" +
  "  createProduct, publishShop, setLocaleSettings, getCatalogData, _resetCatalogCacheState };")();

// A stand-in for the Cache API (caches.default).
function freshCacheApi() {
  const store = new Map();
  global.caches = { default: {
    async match(key) { const hit = store.get(typeof key === "string" ? key : key.url); return hit ? hit.clone() : undefined; },
    async put(key, response) { store.set(typeof key === "string" ? key : key.url, response); },
  } };
  L._resetCatalogCacheState();
}
async function freshDb() {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  return d1;
}
async function addShop(d1, orgId, { deadline = null, late = 0 } = {}) {
  d1._raw.run(`INSERT INTO orgs (orgId, subdomain, name, accent, createdAt, updatedAt, ready, orderDeadline, allowOrdersAfterDeadline, closedMessage)
    VALUES (?, ?, 'Example Club', '#123456', 't', 't', 1, ?, ?, 'Orders for the season have closed.')`, [orgId, orgId, deadline, late]);
  await L.createProduct(d1, orgId, { productId: "tee", type: "shirt", name: "Club Tee", pricingMode: "flat", flatPrice: 20, visible: true, noDesignNeeded: true, reorderQr: "none" });
  await L.publishShop(d1, orgId);
}

// The clock order placement reads (Date.now), pinned for one call.
const realNow = Date.now;
async function at(iso, fn) { const t = Date.parse(iso); Date.now = () => t; try { return await fn(); } finally { Date.now = realNow; } }

(async () => {
  freshCacheApi();
  const d1 = await freshDb();
  let env = { DB: d1, ...MAIL_ENV };
  await addShop(d1, "club", { deadline: "2026-12-01" });
  await addShop(d1, "open");
  await L.setLocaleSettings(d1, { timeZone: "America/New_York" });

  const catalog = async (sub) => {
    const res = await L.catalogGet({ request: { url: shopOrigin(sub) + "/api/catalog", headers: { get: () => null } }, env });
    return JSON.parse(await res.text());
  };
  const call = async (url, body) => {
    const waits = [];
    const res = await L.ordersApi({ env, waitUntil: (p) => waits.push(Promise.resolve(p).catch(() => {})),
      request: { url, method: "POST", json: async () => body, headers: { get: () => null } } });
    await Promise.all(waits);
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const admin = (body) => call(ADMIN_ORIGIN + "/api/orders", Object.assign({ key: "x" }, body));
  let n = 0;
  const order = (when, sub = "club") => at(when, () => call(shopOrigin(sub) + "/api/orders",
    { orderId: "WEB-354-" + (++n), orgId: sub, customerName: "Pat Example", contact: "pat@example.test", paymentMethod: "Check", items: [{ productId: "tee", type: "shirt", qty: 1 }] }));
  const placed = (r) => r.status === 200 && r.body.status === "ok";
  const refused = (r) => r.status === 403 && r.body.message === "Orders for the season have closed.";
  const orderCount = () => d1.q("SELECT COUNT(*) AS n FROM orders")[0].n;

  console.log("=== The catalog answer names the moment ordering closes ===");
  let c = (await catalog("club")).catalog;
  ok("New York: the deadline day ends at 11:59:59 pm EST (04:59:59.999Z the next day)", c.orderClosesAt === "2026-12-02T04:59:59.999Z");
  ok("…with the zone and its short name for the banner", c.orderTimeZone === "America/New_York" && c.orderZoneLabel === "EST");
  ok("…and the deadline, the closed text and the late-orders switch as before",
    c.orderDeadline === "2026-12-01" && c.closedMessage === "Orders for the season have closed." && c.allowOrdersAfterDeadline === false);
  ok("the saved zone is in the cached settings entry (what the answer is worked out from)", (await L.getCatalogData(env)).locale.timeZone === "America/New_York");
  const later = await at("2026-12-05T12:00:00Z", async () => (await catalog("club")).catalog);
  ok("…so it doesn't depend on when it's asked: the same moment days later", later.orderClosesAt === c.orderClosesAt && later.orderZoneLabel === "EST");
  const none = (await catalog("open")).catalog;
  ok("a shop with no deadline gets none of the three", !("orderClosesAt" in none) && !("orderTimeZone" in none) && !("orderZoneLabel" in none) && none.orderDeadline === null);
  ok("a settings entry cached before it carried the zone sends nothing (the storefront keeps its old check)",
    JSON.stringify(L.orderClosing_("2026-12-01", { country: "US" }, {})) === "{}" && JSON.stringify(L.orderClosing_("2026-12-01", null, {})) === "{}");
  ok("…and a deadline that isn't a day sends nothing either", JSON.stringify(L.orderClosing_("soon", { country: "US", timeZone: "UTC" }, {})) === "{}");

  let r = await admin({ action: "updateLocaleSettings", locale: { timeZone: "Asia/Tokyo" } });
  c = (await catalog("club")).catalog;
  ok("a new Region zone (Tokyo, east of UTC) moves it at once: Dec 1 ends at 14:59:59.999Z, named GMT+9",
    r.status === 200 && c.orderClosesAt === "2026-12-01T14:59:59.999Z" && c.orderTimeZone === "Asia/Tokyo" && c.orderZoneLabel === "GMT+9");
  r = await admin({ action: "updateLocaleSettings", locale: { timeZone: "" } });
  env = { ...env, TIMEZONE: "America/Los_Angeles" };
  c = (await catalog("club")).catalog;
  ok("no zone saved: the TIMEZONE variable's (Los Angeles: 07:59:59.999Z, PST)", r.status === 200 && c.orderClosesAt === "2026-12-02T07:59:59.999Z" && c.orderZoneLabel === "PST");
  env = { DB: d1, ...MAIL_ENV };
  c = (await catalog("club")).catalog;
  ok("…and with neither, UTC", c.orderClosesAt === "2026-12-01T23:59:59.999Z" && c.orderTimeZone === "UTC" && c.orderZoneLabel === "UTC");

  console.log("\n=== Order placement closes at the same moment (late orders off) ===");
  await L.setLocaleSettings(d1, { timeZone: "America/New_York" });
  const before = orderCount();
  r = await order("2026-12-02T04:59:00Z");
  ok("New York, 11:59 pm on the deadline day: the order is taken", placed(r));
  r = await order("2026-12-02T05:00:01Z");
  ok("…12:00:01 am the next day: refused with the shop's closed text", refused(r));
  r = await order("2026-12-02T11:30:00Z");
  ok("…6:30 the next morning (still before the old UTC-12 end of day): refused", refused(r));
  ok("…and the refused orders weren't written", orderCount() === before + 1);
  await L.setLocaleSettings(d1, { timeZone: "Asia/Tokyo" });
  r = await order("2026-12-01T14:59:00Z");
  ok("Tokyo, 11:59 pm on the deadline day: taken", placed(r));
  r = await order("2026-12-01T15:00:01Z");
  ok("…12:00:01 am the next day there (still Dec 1 in UTC): refused", refused(r));
  await L.setLocaleSettings(d1, { timeZone: "" });
  r = await at("2026-12-01T12:00:00Z", async () => (await catalog("club")).catalog);
  const closes = Date.parse(r.orderClosesAt);
  const justBefore = await order(new Date(closes - 1000).toISOString()), justAfter = await order(new Date(closes + 1000).toISOString());
  ok("no zone saved (UTC): the catalog's moment is the server's — a second before it is taken, a second after refused", placed(justBefore) && refused(justAfter));

  d1._raw.run("UPDATE orgs SET allowOrdersAfterDeadline=1 WHERE orgId='club'");
  await L.publishShop(d1, "club");
  r = await order("2026-12-03T12:00:00Z");
  ok("with late orders allowed, an order days after the deadline is still taken", placed(r));

  process.exit(process.exitCode || 0);
})().catch(e => { console.error(e); process.exit(1); });
