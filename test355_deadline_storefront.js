// The shopper's computer is far from the business: Auckland, a day ahead of New York for most of each day. Set before
// anything reads the clock's zone, so every Date below (in jsdom too) is on Auckland's calendar.
process.env.TZ = "Pacific/Auckland";
const fs = require("fs");
const { JSDOM, VirtualConsole } = require("jsdom");
const { createD1 } = require("./testlib/d1-shim.js");
const { storefrontPage } = require("./testlib/storefront-page");
const { shopOrigin } = require("./testlib/hosts.js");
const { ok } = require("./testlib/check");

// The shop page's order deadline (public/storefront.js deadlineBannerHtml, renderOrgPage) on the business's clock,
// not the shopper's: the banner and the order block go by the catalog's orderClosesAt (11:59:59 pm on the deadline
// day in the business's time zone, the moment the server refuses orders), "today" and "days left" are counted on the
// business's calendar, and the banner names the time ("Ordering closes today at 11:59 pm EST"). A catalog cached
// before it sent orderClosesAt keeps the old check (the end of the day on the shopper's own clock), with no time
// named. The catalog answer comes from the REAL db.js, catalogCache.js and catalog.js on sql.js; the page is jsdom.
// Only the clock (Date.now, or the banner's `now`) is pinned; invented data only.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
global.fetch = async (url) => { throw new Error("unexpected fetch " + url); };
const L = new Function(
  strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/db.js")) + "\n" +
  strip(read("functions/_lib/catalogCache.js")) + "\n" + strip(read("functions/api/catalog.js")) +
  "\nreturn { catalogGet: onRequestGet, createProduct, publishShop, setLocaleSettings, _resetCatalogCacheState };")();

const pause = (ms) => new Promise(r => setTimeout(r, ms));
const wait = async (cond, n = 300) => { for (let i = 0; i < n && !cond(); i++) await pause(10); return !!cond(); };
const text = (html) => String(html || "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

(async () => {
  // A New York business with a shop that closes on Dec 1 and takes no late orders.
  const store = new Map();
  global.caches = { default: {
    async match(key) { const hit = store.get(typeof key === "string" ? key : key.url); return hit ? hit.clone() : undefined; },
    async put(key, response) { store.set(typeof key === "string" ? key : key.url, response); },
  } };
  L._resetCatalogCacheState();
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, accent, createdAt, updatedAt, ready, orderDeadline, allowOrdersAfterDeadline, closedMessage)
    VALUES ('club', 'club', 'Example Club', '#123456', 't', 't', 1, '2026-12-01', 0, 'Orders for the season have closed.');`);
  await L.createProduct(d1, "club", { productId: "tee", type: "shirt", name: "Club Tee", pricingMode: "flat", flatPrice: 20, visible: true, noDesignNeeded: true, reorderQr: "none" });
  await L.publishShop(d1, "club");
  await L.setLocaleSettings(d1, { timeZone: "America/New_York" });
  const res = await L.catalogGet({ request: { url: shopOrigin("club") + "/api/catalog", headers: { get: () => null } }, env: { DB: d1 } });
  const answer = JSON.parse(await res.text());
  ok("the catalog answer carries the closing moment, the zone and its name",
    answer.catalog.orderClosesAt === "2026-12-02T04:59:59.999Z" && answer.catalog.orderTimeZone === "America/New_York" && answer.catalog.orderZoneLabel === "EST");

  // The shop page, opened with that answer and the page's clock pinned to `nowIso`.
  const shop = async (catalogAnswer, nowIso) => {
    const vc = new VirtualConsole();
    vc.on("jsdomError", (e) => { if (!/Not implemented: navigation/.test(String(e && e.message))) console.error(e); });
    const t = Date.parse(nowIso);
    const dom = new JSDOM(storefrontPage({ adminCss: false }), { runScripts: "dangerously", url: shopOrigin("club") + "/", pretendToBeVisual: true, virtualConsole: vc,
      beforeParse(win) {
        win.scrollTo = () => {}; win.alert = () => {};
        // The page's clock: Date.now() and a new Date() with nothing given are `nowIso`.
        const RealDate = win.Date;
        win.Date = class extends RealDate { constructor(...a){ if(a.length) super(...a); else super(t); } static now(){ return t; } };
        win.fetch = async (u) => {
          const body = String(u).startsWith("/api/catalog") ? catalogAnswer : {};
          return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } };
        };
      } });
    const w = dom.window, d = w.document;
    await wait(() => !!d.querySelector(".org-hero"));
    return { w, d };
  };
  const { w } = await shop(answer, "2026-11-25T12:00:00Z");
  const org = { ...answer.catalog };
  const banner = (o, iso) => text(w.deadlineBannerHtml(o, new Date(Date.parse(iso))));
  const cls = (o, iso) => (/class="([^"]+)"/.exec(w.deadlineBannerHtml(o, new Date(Date.parse(iso)))) || [])[1];

  console.log("\n=== The banner counts on the business's calendar and names its time ===");
  // 3 pm in New York on Dec 1 is 9 am on Dec 2 in Auckland: the shopper's own clock would call the shop closed.
  ok("on the deadline day in New York (already the next day for the shopper): \"Today\", closing at 11:59 pm EST",
    banner(org, "2026-12-01T20:00:00Z") === "Today Ordering closes today at 11:59 pm EST — submit your order now." && cls(org, "2026-12-01T20:00:00Z") === "deadline-banner urgent");
  ok("…the minute before it closes, still \"Today\"", /^Today Ordering closes today at 11:59 pm EST/.test(banner(org, "2026-12-02T04:59:00Z")));
  ok("the day before (New York), \"1 day left\", with the date and time",
    banner(org, "2026-11-30T20:00:00Z") === "1 day left Ordering closes December 1, 2026 at 11:59 pm EST.");
  ok("…counted by the business's calendar: late on Nov 29 there (already Nov 30 for the shopper) is still 2 days",
    banner(org, "2026-11-30T04:00:00Z") === "2 days left Ordering closes December 1, 2026 at 11:59 pm EST.");
  ok("more than a week out: not urgent", banner(org, "2026-11-20T12:00:00Z") === "11 days left Ordering closes December 1, 2026 at 11:59 pm EST." && cls(org, "2026-11-20T12:00:00Z") === "deadline-banner");
  ok("a second after 11:59:59 pm EST: closed, with the shop's text", banner(org, "2026-12-02T05:00:01Z") === "Closed December 1, 2026 Orders for the season have closed.");
  ok("…and with late orders allowed: the deadline was, and late orders are taken",
    banner({ ...org, allowOrdersAfterDeadline: true }, "2026-12-02T05:00:01Z") === "Deadline was December 1, 2026 Orders for the season have closed. Late orders are still being accepted.");
  ok("the zone's name is escaped", /at 11:59 pm &lt;b&gt;X&lt;\/b&gt;/.test(w.deadlineBannerHtml({ ...org, orderZoneLabel: "<b>X</b>" }, new Date(Date.parse("2026-11-30T20:00:00Z")))));
  ok("a zone this browser doesn't know: the shopper's calendar for the days, the time still named",
    banner({ ...org, orderTimeZone: "Not/AZone" }, "2026-11-30T20:00:00Z") === "Today Ordering closes today at 11:59 pm EST — submit your order now.");
  ok("called without a time (as the page does), it uses now", /Closed December 1, 2026/.test(text(w.deadlineBannerHtml(org))) === (Date.now() > Date.parse(org.orderClosesAt)));

  console.log("\n=== A catalog cached before the closing moment was sent ===");
  const old = { ...org }; delete old.orderClosesAt; delete old.orderTimeZone; delete old.orderZoneLabel;
  // Auckland's end of Dec 1 is 10:59:59 UTC that day.
  ok("the old check: open until the end of the day on the shopper's clock, with no time named",
    banner(old, "2026-12-01T10:59:00Z") === "Today Ordering closes today — submit your order now.");
  ok("…and closed after it", banner(old, "2026-12-01T11:00:01Z") === "Closed December 1, 2026 Orders for the season have closed.");
  ok("…days left on the shopper's calendar", banner(old, "2026-11-28T00:00:00Z") === "3 days left Ordering closes December 1, 2026.");

  console.log("\n=== The order block closes at the same moment ===");
  {
    const { d } = await shop(answer, "2026-12-01T20:00:00Z");
    ok("3 pm in New York on the deadline day (Dec 2 for the shopper): the catalog and the order form are shown",
      !!d.getElementById("catalogArea") && !!d.getElementById("price-tee") && /Today/.test(d.querySelector(".deadline-banner").textContent));
  }
  {
    const { d } = await shop(answer, "2026-12-02T05:00:01Z");
    ok("12:00:01 am in New York: closed — the shop's text and no catalog",
      !d.getElementById("catalogArea") && /Closed December 1, 2026/.test(d.querySelector(".deadline-banner").textContent));
  }
  {
    const late = { ...answer, catalog: { ...answer.catalog, allowOrdersAfterDeadline: true } };
    const { d } = await shop(late, "2026-12-02T05:00:01Z");
    ok("…unless late orders are allowed: the catalog is still shown", !!d.getElementById("catalogArea") && /Late orders are still being accepted/.test(d.querySelector(".deadline-banner").textContent));
  }
  {
    const oldAnswer = { ...answer, catalog: old };
    const { d } = await shop(oldAnswer, "2026-12-01T20:00:00Z");
    ok("a catalog without the moment: the shopper's own end of day closes it, as before", !d.getElementById("catalogArea"));
  }
  process.exit(process.exitCode || 0);
})().catch(e => { console.error(e); process.exit(1); });
