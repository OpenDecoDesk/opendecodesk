// The admin's dates, "today" and money follow the business, not the computer it is opened on (review item #45).
//   - The sign-in and admin-users "me" carry the business's time zone (Region, else TIMEZONE, else UTC).
//   - Today, a report's To, the year a report starts, the audit log's From / To and the Orders range are days on
//     that calendar; a date-and-time box reads and writes the business's clock.
//   - adminDate_ shows a time as the business's day, and a plain day (YYYY-MM-DD) as written, whatever the zone.
//   - adminMoney_ is the one money style ("−$1,234.56"), and the screens' own money helpers are it.
// This computer is in New York; the business is in Auckland. At 12:30 UTC on Dec 31 2026 it is 7:30 AM on Dec 31 in
// New York and already 1:30 AM on Jan 1 2027 in Auckland: a new day and a new year for the business.
process.env.TZ = "America/New_York";
const fs = require("fs");
const { storefrontPage } = require("./testlib/storefront-page");
const { JSDOM, ResourceLoader } = require("jsdom");
const { makeAuth } = require("./testlib/auth-harness");

let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const tick = (ms) => new Promise(r => setTimeout(r, ms || 40));
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");

(async () => {
  console.log("=== The server sends the business's time zone with the sign-in and with \"me\" ===");
  const A = await makeAuth();
  A.env.TIMEZONE = "Pacific/Auckland";
  const first = await A.signIn("", A.PRINTED);
  ok("the sign-in reply carries the zone (the TIMEZONE variable, with no Region saved)", first.status === 200 && first.body.timeZone === "Pacific/Auckland");
  const cookie = await A.firstAdmin();
  let me = await A.users({ action: "me" }, cookie);
  ok("…and so does \"me\"", me.status === 200 && me.body.timeZone === "Pacific/Auckland");
  A.d1._raw.exec(`INSERT OR REPLACE INTO global_settings (key, value) VALUES ('locale', '{"timeZone":"Asia/Tokyo","country":"US"}')`);
  me = await A.users({ action: "me" }, cookie);
  const again = await A.signIn("olive@myshop.com", "correct horse battery");
  ok("the Region setting comes before the TIMEZONE variable, in both", me.body.timeZone === "Asia/Tokyo" && again.body.timeZone === "Asia/Tokyo");

  console.log("\n=== The admin page keeps the zone it is sent ===");
  const adminJs = read("public/admin.js"), html = storefrontPage();
  const sent = [];
  let zoneFromServer = "Pacific/Auckland";
  class L extends ResourceLoader { fetch(url) { if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return Promise.resolve(Buffer.from("")); } }
  const dom = new JSDOM(html, { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win) {
      win.fetch = async (url, opts) => {
        const body = opts && opts.body ? JSON.parse(opts.body) : {};
        const j = (x, status) => ({ ok: !status, status: status || 200, json: async () => x, text: async () => JSON.stringify(x) });
        if (!body.action) return j({ status: "admin", business: {}, country: "US" });
        sent.push(body);
        if (String(url).includes("/api/admin-users") && body.action === "me")
          return j({ status: "ok", user: { id: 1, name: "Olive", email: "olive@myshop.com", role: "admin" }, pending: null, permissions: null, timeZone: zoneFromServer });
        if (body.action === "getAuditLog") return j({ status: "ok", entries: [
          { createdAt: "2026-12-31T12:30:00.000Z", action: "order.voided", orgId: "s1", orderId: "ORD-1", detail: { customerName: "Ann", total: 1234.5 } },
          { createdAt: "2026-12-31T12:30:00.000Z", action: "payment.refunded", orgId: "s1", orderId: "ORD-1", detail: { amount: 1234.56, method: "cash" } }] });
        return j({ status: "ok" });
      };
    } });
  const w = dom.window, d = w.document;
  await tick(150);
  await w.loadAdminScript();
  w.eval('adminKey = "cookie";');

  // Fixed at 12:30 UTC on Dec 31 2026 (no-argument Date and Date.now; anything given a time is left alone).
  const T = Date.UTC(2026, 11, 31, 12, 30);
  w.eval(`(() => { const R = Date; class D extends R { constructor(...a){ if (a.length) super(...a); else super(${T}); } static now(){ return ${T}; } } window.Date = D; })()`);
  const browserDay = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(T));
  ok("(this test's computer is a day behind the business: New York's Dec 31, UTC's Dec 31)", browserDay === "2026-12-31" && new Date(T).toISOString().slice(0, 10) === "2026-12-31");
  ok("before the zone is known, this computer's own day stands in", w.localToday_() === "2026-12-31");
  // The Orders range set when the page loaded (on this computer's calendar), as the real page has it.
  w._ordersFilter = w.ordersDefaultDates_(); w._ordersFilterAuto_ = Object.assign({}, w._ordersFilter);
  ok("…and the Orders range it starts with ends on that day", w._ordersFilter.to === "2026-12-31" && w._ordersFilter.from === "2026-12-01");

  await w.refreshAdminMe_();
  ok("\"me\" gives the page the business's zone", w.eval("adminTimeZone") === "Pacific/Auckland");
  zoneFromServer = "Not/AZone"; await w.refreshAdminMe_();
  ok("a zone this browser doesn't know is ignored (the last good one stays)", w.eval("adminTimeZone") === "Pacific/Auckland");
  zoneFromServer = undefined; await w.refreshAdminMe_();
  ok("…and so is none at all (an older server)", w.eval("adminTimeZone") === "Pacific/Auckland");
  w.saveAdminSession("cookie", new Date(T + 3600e3).toISOString());
  ok("the sign-in marker keeps it, so a reload has it before \"me\" answers", JSON.parse(w.localStorage.getItem("oddAdminSession")).timeZone === "Pacific/Auckland" &&
    /if\(stored\)\{[^\n]*setAdminTimeZone_\(stored\.timeZone\)/.test(adminJs) && /adminMe = data\.user \|\| null;\s*setAdminTimeZone_\(data\.timeZone\);/.test(adminJs));
  ok("a Region saved in Global settings is used at once", /setAdminTimeZone_\(data\.effectiveTimeZone\)/.test(adminJs));

  console.log("\n=== Today, report dates and the audit filter follow the business ===");
  ok("today is the business's: Jan 1 2027 in Auckland", w.localToday_() === "2027-01-01");
  ok("…and whole days move from it on the calendar", w.localToday_(-30) === "2026-12-02" && w.localToday_(1) === "2027-01-02" && w.addDays_("2027-03-01", -1) === "2027-02-28");
  ok("a report's To is the business's today (not New York's, not UTC's)", w.reportToDay_() === "2027-01-01");
  ok("\"this year\" is the business's", w.adminYear_() === 2027);
  const app = d.getElementById("app");
  w.renderRevenueReport(app); await tick();
  ok("Revenue opens on the business's year, To today", d.getElementById("revFrom").value === "2027-01-01" && d.getElementById("revTo").value === "2027-01-01");
  w.renderSalesTaxReport(app); await tick();
  ok("Sales tax too", d.getElementById("taxFrom").value === "2027-01-01" && d.getElementById("taxTo").value === "2027-01-01");
  sent.length = 0;
  w.renderAuditLog(app); await tick(120);
  const ask = sent.find(b => b.action === "getAuditLog") || {};
  ok("the audit log's From / To are the business's last 30 days", d.getElementById("afFrom").value === "2026-12-02" && d.getElementById("afTo").value === "2027-01-01");
  ok("…sent as the first and last moment of those days in Auckland", ask.dateFrom === "2026-12-01T11:00:00.000Z" && ask.dateTo === "2027-01-01T10:59:59.999Z");
  const rows = d.getElementById("auditResults").textContent;
  const aklDay = new Intl.DateTimeFormat(undefined, { timeZone: "Pacific/Auckland" }).format(new Date(T));
  ok("an entry shows the business's day and time", rows.includes(aklDay) && /1:30/.test(rows) && !rows.includes(new Intl.DateTimeFormat().format(new Date(T))));
  ok("…and its money in the one style", rows.includes("Ann · $1,234.50") && rows.includes("−$1,234.56 cash"));
  w.ordersRollDates_();
  ok("the Orders range set before the zone was known moves to the business's days", w._ordersFilter.to === "2027-01-01" && w._ordersFilter.from === "2026-12-02");
  w._ordersFilter = { from: "2027-01-01", to: "2027-01-01" };
  const placed = (iso) => w.ordersDateFilter_([{ placedAt: iso }]).length === 1;
  ok("…and a day in it is the business's whole day", placed("2026-12-31T11:00:00.000Z") && placed("2027-01-01T10:59:59.000Z") && !placed("2026-12-31T10:59:00.000Z") && !placed("2027-01-01T11:00:00.000Z"));

  console.log("\n=== A date-and-time box is on the business's clock ===");
  ok("its default is now in Auckland", w.localDateTime_() === "2027-01-01T01:30" && w.localDateTime_("2026-12-31T12:30:00Z") === "2027-01-01T01:30");
  ok("what is typed in it is read on that clock too", w.localDateTimeToDate_("2027-01-01T01:30").toISOString() === "2026-12-31T12:30:00.000Z");
  const box = d.createElement("input"); box.type = "datetime-local"; box.value = "2027-01-01T00:15"; box.dataset.shown = "2027-01-01T01:30";
  ok("…when it is changed (readWhen_)", w.readWhen_(box).at === "2026-12-31T11:15:00.000Z");
  ok("a business day's bounds survive a clock change (Auckland's April 5 2026 has 25 hours)",
    w.localDayStartIso_("2026-04-05") === "2026-04-04T11:00:00.000Z" && w.localDayEndIso_("2026-04-05") === "2026-04-05T11:59:59.999Z");

  console.log("\n=== adminDate_: a time on the business's calendar, a plain day as written ===");
  ok("a time shows the day it was in Auckland", w.adminDate_("2026-12-31T12:30:00.000Z", undefined, "en-US") === "1/1/2027" && w.adminShortDate_("2026-12-31T12:30:00.000Z") === "1/1/2027");
  ok("…with any date style", w.adminDate_("2026-12-31T12:30:00.000Z", { month: "short", day: "numeric", year: "numeric" }, "en-US") === "Jan 1, 2027");
  ok("a database time with no zone counts as UTC", w.adminDay_("2026-12-31 12:30:00") === "2027-01-01");
  ok("date and time together, and a time alone", w.adminDateTime_("2026-12-31T12:30:00.000Z", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }, "en-US") === "Jan 1, 1:30 AM" &&
    w.adminTime_("2026-12-31T12:30:00.000Z", { hour: "numeric", minute: "2-digit" }) === new Intl.DateTimeFormat(undefined, { timeZone: "Pacific/Auckland", hour: "numeric", minute: "2-digit" }).format(new Date(T)));
  let still = true;
  for (const z of ["Pacific/Kiritimati", "Pacific/Auckland", "UTC", "America/New_York", "Pacific/Pago_Pago"]) {
    w.setAdminTimeZone_(z);
    still = still && w.adminDate_("2026-11-04", undefined, "en-US") === "11/4/2026" && w.adminShortDate_("2026-11-04") === "11/4/2026" && w.adminDay_("2026-11-04") === "2026-11-04" &&
      w.adminDate_("2026-11-04", { weekday: "long" }, "en-US") === "Wednesday" && w.adminDate_("2026-11", { month: "long", year: "numeric" }, "en-US") === "November 2026" &&
      /^Nov 4(, 2026)?$/.test(w.expShortDate_("2026-11-04"));   // the year is shown when it isn't the business's
  }
  ok("a plain day (and a month) is never moved a day, in any zone from +14 to −11", still);
  w.setAdminTimeZone_("Pacific/Auckland");
  ok("an empty date shows nothing, a broken one as it was", w.adminDate_("") === "" && w.adminDate_(null) === "" && w.adminDate_("soon") === "soon");
  ok("due-date chips count days on the business's calendar", /due today/.test(w.dueBadge_("2027-01-01")) && /1 day overdue/.test(w.dueBadge_("2026-12-31")) && /due in 2 days/.test(w.dueBadge_("2027-01-03")));
  const code = adminJs.split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");
  ok("no screen formats a date on this computer's own zone any more", !/\.toLocaleDateString\(/.test(code) && !/toLocaleTimeString\(/.test(code));
  ok("the old local-day helpers are gone", !/rushLocalToday_|ordersLocalDay_|expToday_|toLocaleDateString\("en-CA"\)/.test(code));

  console.log("\n=== adminMoney_: one money style ===");
  ok("thousands separated, two decimals", w.adminMoney_(1234.5) === "$1,234.50" && w.adminMoney_(0) === "$0.00" && w.adminMoney_(null) === "$0.00" && w.adminMoney_("12") === "$12.00");
  ok("a negative has a true minus before the dollar sign", w.adminMoney_(-1234.56) === "−$1,234.56" && w.adminMoney_(-0.4) === "−$0.40");
  ok("an amount not entered is a dash (or what the screen says)", w.adminMoneyOr_(null) === "—" && w.adminMoneyOr_(undefined, "not entered") === "not entered" && w.adminMoneyOr_(0) === "$0.00");
  const run = (expr) => w.eval(expr);   // the helpers are `const`s, not window properties
  ok("the screens' own helpers are it", run("expMoney_(-12.99)") === "−$12.99" && run("pricingMoney_(-1234.5)") === "−$1,234.50" && run("srMoney_(null)") === "—" && run("srMoney_(2500)") === "$2,500.00");
  ok("…free shipping's goal keeps whole dollars whole", run("fsDollars_(5000)") === "$50" && run("fsDollars_(4950)") === "$49.50" && run("fsDollars_(500000)") === "$5,000");
  ok("no screen's helper writes \"$\" + toFixed(2) any more", !/const (money|fmt|m|\$) = \([a-z]\) => [^;]*"\$" \+[^;]*toFixed\(2\)/.test(code) && !/function fmt\(n\) \{ return "\$"/.test(code));
  ok("the audit log's summaries use it", !/case "[a-z_.]+":[^\n]*"\$" \+ Number\(/.test(code));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); console.log("test crashed: false"); process.exit(1); });
