process.env.TZ = "UTC";
const fs = require("fs");
const { storefrontPage } = require("./testlib/storefront-page");
const { ok } = require("./testlib/check");
const roles = require("./testlib/roles");
const { JSDOM, ResourceLoader, VirtualConsole } = require("jsdom");

// Phase 8 admin pages, the answers nobody else sends: in jsdom with public/admin.js, admin-salesreports.js and
// admin-quickbooks.js, every /api/orders answer written by this test (an odd server, a late one, one that fails), so
// the fallbacks of each page are driven and their visible result checked:
//   the order window's Profit box (pmLoadProfit_ / pmProfitHtml_): an answer that isn't an object, a profit that isn't
//   nested, the note with and without an estimate or notes;
//   Sales by…: shops without a name or no shop list at all, a remembered shop that is gone, an answer that isn't an object,
//   rows without totals, dates or basis, an unknown grouping, a customer row without a key, CSV clicked with nothing to
//   export, clicks that aren't on a button;
//   Profit per job: an unknown sort, a shop chosen (asked for and in the CSV name), shop names from the answer, the shop
//   list, the shop id or nothing, toggles and order links that point at no row;
//   Gift card liability: months without a name, totals or end date, CSV with nothing to export;
//   QuickBooks export: the page left while its settings, its accounts or a download were on the way, a server that sends
//   no settings, accounts or summary, the `quickbooks` answer key, unnamed bank accounts and categories, every mapping
//   refusal, no Sales/Customer choice ticked, a Save answered without settings, a format change the server refuses,
//   parts remembered unticked, files without a name, text or type, unknown presets.
// Invented shops, people and figures only. "Today" is fixed at 2026-12-15 on the page, the business on America/Chicago.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const pause = (ms) => new Promise(r => setTimeout(r, ms));
const wait = async (cond, n = 500) => { for (let i = 0; i < n && !cond(); i++) await pause(10); return !!cond(); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
process.on("unhandledRejection", (e) => { console.error(e); ok("nothing in the test was left to fail unseen", false); });
let finished = false;
process.on("exit", () => { if (!finished) { console.log("the test ran to its end: false"); process.exitCode = 1; } });
const TODAY = "2026-12-15";

(async () => {
  const adminJs = read("public/admin.js"), srJs = read("public/admin-salesreports.js"), qbJs = read("public/admin-quickbooks.js"), custJs = read("public/admin-customers.js");
  const sent = [], toasts = [], blobs = [], saves = [];
  // The next answer for an action: { status, body, gate } (body may be any JSON value, even a string). Without one, an
  // action is answered by `answers[action]` and then by a plain { status: "ok" }.
  let scripted = [];
  let answers = {};
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
  const scriptOf = (name) => name === "admin-salesreports.js" ? srJs : name === "admin-quickbooks.js" ? qbJs : name === "admin.js" ? adminJs : name === "admin-customers.js" ? custJs : "";
  class Loader extends ResourceLoader {
    fetch(url) { const name = (String(url).match(/\/([\w-]+\.js)(\?|$)/) || [])[1]; return Promise.resolve(Buffer.from(scriptOf(name))); }
  }
  const vc = new VirtualConsole();
  vc.sendTo(console, { omitJSDOMErrors: true });
  vc.on("jsdomError", (e) => { if (!/Not implemented|Could not load script/.test(e.message)) console.error(e); });
  let inflight = 0;
  const dom = new JSDOM(storefrontPage(), { runScripts: "dangerously", resources: new Loader(), virtualConsole: vc, url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win) {
      win.CSS = win.CSS || { escape: (s) => String(s).replace(/["\\]/g, "\\$&") };
      win.scrollTo = () => {};
      win.URL.createObjectURL = (b) => { blobs.push(b); return "blob:file-" + blobs.length; };
      win.URL.revokeObjectURL = () => {};
      win.HTMLAnchorElement.prototype.click = function () { if (this.download) saves.push(this.download); };
      win.fetch = async (url, init) => {
        const u = String(url), b = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
        if (!u.includes("/api/orders")) return reply(404, { status: "error", message: "not here" });
        sent.push(JSON.parse(JSON.stringify(b))); inflight++;
        try {
          const i = scripted.findIndex(s => s.action === b.action);
          const s = i >= 0 ? scripted.splice(i, 1)[0] : answers[b.action] ? answers[b.action](b) : { body: { status: "ok" } };
          if (s.gate) await s.gate;
          return reply(s.status || 200, s.body);
        } finally { inflight--; }
      };
    } });
  const w = dom.window, d = w.document;
  await pause(150);
  await w.loadAdminScript();
  w.showToast = (m, isErr) => toasts.push({ m: String(m), err: !!isErr });
  w.eval('adminKey = "cookie"; setAdminTimeZone_("America/Chicago");');
  w.eval(`localToday_ = function (off) { const t = "${TODAY}"; return off ? addDays_(t, off) : t; };`);
  const setShops = (list) => w.eval("adminOrgs = " + JSON.stringify(list) + ";");
  setShops([{ orgId: "school", name: "Example School Shop" }, { orgId: "club", name: "Example Club" }]);
  const q = (s) => d.querySelector(s), qa = (s) => [...d.querySelectorAll(s)];
  const id = (s) => d.getElementById(s);
  const app = id("app");
  const text = (el) => el ? el.textContent.replace(/\s+/g, " ").trim() : "";
  const idle = async () => { for (let calm = 0, i = 0; calm < 3 && i < 500; i++) { await pause(10); calm = inflight === 0 ? calm + 1 : 0; } };
  const of = (action) => sent.filter(b => b.action === action).map(b => { const c = Object.assign({}, b); delete c.key; return c; });
  const reset = () => { sent.length = 0; toasts.length = 0; };
  const lastToast = () => toasts[toasts.length - 1] || { m: "", err: false };
  const fire = (el, type) => el.dispatchEvent(new w.Event(type, { bubbles: true, cancelable: true }));
  const choose = (el, v) => { el.value = v; fire(el, "change"); };
  const tick = (el, v) => { el.checked = v; fire(el, "change"); };
  const click = (el) => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true }));
  const gate = () => { let release; const g = new Promise(r => { release = r; }); return { g, release }; };
  const blobText = (b) => new Promise((res) => { const r = new w.FileReader(); r.onload = () => res(String(r.result)); r.readAsText(b); });
  const csvLines = async () => (await blobText(blobs[blobs.length - 1])).split("\r\n").filter(Boolean);
  const $m = (c) => w.adminMoney_(c / 100);
  const day = (ymd) => w.adminDate_(ymd);
  const hashNow = () => w.location.hash.replace(/^#\/?/, "");
  w.eval(roles.asRole("admin", { name: "Tester", email: "tester@example.test" }));
  w.applyFeatures_({});
  w.renderAdminNav();
  const opened = [];
  w.openOrderFromDashboard_ = (org, oid, placed) => { opened.push([org, oid, placed]); };

  // ==============================================================================================================
  console.log("=== The order window's Profit box ===");
  // ==============================================================================================================
  const box = () => { const b = d.createElement("div"); d.body.appendChild(b); return b; };
  { const b = box();
    scripted = [{ action: "getOrderProfit", body: "not an object" }];
    reset(); await w.pmLoadProfit_(b, "EX-1001");
    ok("an answer that isn't an object (a plain string): the quiet line “Profit isn't available right now.”, never figures",
      of("getOrderProfit").length === 1 && text(b.querySelector(".pm-profit-note")) === "Profit isn't available right now." && !b.querySelector("table"));
    b.remove(); }
  { const b = box();
    scripted = [{ action: "getOrderProfit", body: { status: "ok", profit: "n/a", revenueCents: 1500, profitCents: 600, marginPct: 40, costs: { blanksCents: 900 } } }];
    reset(); await w.pmLoadProfit_(b, "EX-1001");
    const rows = [...b.querySelectorAll("tr")].map(r => [...r.cells].map(text).join(" "));
    ok("a profit that isn't nested (profit is a string, the figures at the top of the answer): those figures are shown — Revenue $15.00, Blanks −$9.00, Profit $6.00, Margin 40.0%",
      same(rows, [`Revenue ${$m(1500)}`, `Blanks −${$m(900)}`, `Profit ${$m(600)}`, "Margin 40.0%"]));
    b.remove(); }
  const noteOf = (p) => { const b = box(); b.innerHTML = w.pmProfitHtml_(p); const n = text(b.querySelector(".pm-profit-note")); const est = !!b.querySelector(".sr-est"); b.remove(); return { n, est }; };
  { const plain = noteOf({ revenueCents: 1000, profitCents: 1000, costs: {} });
    ok("not estimated and no notes: the note is only “Revenue leaves out sales tax and gift cards sold. Labor isn't counted yet.”, no est. mark",
      plain.n === "Revenue leaves out sales tax and gift cards sold. Labor isn't counted yet." && !plain.est);
    const notes = noteOf({ revenueCents: 1000, profitCents: 1000, costs: {}, notes: ["Thread at today's price.", "  "] });
    ok("…with a note but no estimate: the note first (its full stop kept once, blank notes dropped), still no est. mark",
      notes.n === "Thread at today's price. Revenue leaves out sales tax and gift cards sold. Labor isn't counted yet." && !notes.est);
    const est = noteOf({ revenueCents: 1000, profitCents: 1000, costs: {}, estimated: true });
    ok("…estimated without notes: “est. Part of the cost is an estimate.” and nothing after the colon",
      est.est && est.n === "est. Part of the cost is an estimate. Revenue leaves out sales tax and gift cards sold. Labor isn't counted yet."); }

  // ==============================================================================================================
  console.log("\n=== Sales by… ===");
  // ==============================================================================================================
  const srPage = () => id("srSalesPage"), prPage = () => id("srProfitPage"), lbPage = () => id("srLiabPage");
  const drawn = (root) => !!root && !/Loading…/.test(text(root.querySelector(".sr-body")));
  const goTo = async (hash, page) => { const old = page(); reset(); if (hashNow() === hash) w.adminRoute(); else w.location.hash = "#" + hash; await wait(() => page() && page() !== old && drawn(page())); await idle(); };
  const sales = (report) => ({ body: { status: "ok", report } });
  answers.getSalesReport = () => sales({ rows: [], totals: {} });
  const opts = (root) => [...root.querySelectorAll(".sr-org option")].map(o => text(o));
  const selShop = (root) => root.querySelector(".sr-org").value;
  setShops([{ orgId: "zeta-shop" }, { orgId: "club", name: "Example Club" }, { orgId: "aaa", name: "" }]);
  await goTo("salesby", srPage);
  ok("shops without a name are listed by their id and sorted with the rest: All shops, aaa, Example Club, zeta-shop",
    same(opts(srPage()), ["All shops", "aaa", "Example Club", "zeta-shop"]) && srPage().querySelector('.sr-org option[value="zeta-shop"]').textContent === "zeta-shop");
  // With no shop list the router shows the sign-in picker, so the page is drawn straight (as a redraw after the list
  // was dropped would).
  const drawStraight = async (fn, page) => { reset(); const old = page(); w[fn](app); await wait(() => page() && page() !== old && drawn(page())); await idle(); };
  setShops(null);
  await drawStraight("renderSalesBy", srPage);
  ok("no shop list at all: the Shop box has only All shops, and the report is still asked for", same(opts(srPage()), ["All shops"]) && of("getSalesReport").length === 1);
  setShops([{ orgId: "school", name: "Example School Shop" }, { orgId: "club", name: "Example Club" }]);
  await goTo("salesby", srPage);
  reset(); choose(srPage().querySelector(".sr-org"), "club"); await idle();
  ok("a shop chosen: the report is asked for that shop", of("getSalesReport").length === 1 && of("getSalesReport")[0].orgId === "club");
  await goTo("salesby", srPage);
  ok("coming back: Example Club is still chosen and asked for", selShop(srPage()) === "club" && srPage().querySelector(".sr-org option:checked").textContent === "Example Club" && of("getSalesReport")[0].orgId === "club");
  setShops([{ orgId: "school", name: "Example School Shop" }]);
  await goTo("salesby", srPage);
  ok("…and when that shop is no longer in the list: back to All shops, and the report is asked for every shop",
    selShop(srPage()) === "" && of("getSalesReport").length === 1 && !("orgId" in of("getSalesReport")[0]));
  setShops([{ orgId: "school", name: "Example School Shop" }, { orgId: "club", name: "Example Club" }]);

  scripted = [{ action: "getSalesReport", body: "not an object" }];
  await goTo("salesby", srPage);
  ok("an answer that isn't an object: “No sales in these dates.”, the dates asked for (Dec 1 – Dec 15) with no basis note, CSV off",
    text(srPage().querySelector(".sr-body")) === "No sales in these dates." &&
    text(srPage().querySelector(".sr-basis")) === `${day("2026-12-01")} – ${day("2026-12-15")}, each day on the business's own calendar.` &&
    srPage().querySelector(".sr-csv").disabled === true);
  reset(); { const csv = srPage().querySelector(".sr-csv"); csv.disabled = false; click(csv); }
  ok("…its Export CSV forced on: “There are no sales to export.”, nothing saved", lastToast().m === "There are no sales to export." && lastToast().err && saves.length === 0);

  scripted = [{ action: "getSalesReport", body: { status: "ok", report: { by: "bogus", rows: [{ key: null, label: "Walk-ins", customerId: null, orders: 1, qty: 2, grossCents: 500, netCents: 500, sharePct: 100 }] } } }];
  await goTo("salesby", srPage);
  const srRows = () => [...srPage().querySelectorAll("#srSalesTable tbody tr")];
  ok("an unknown grouping in the answer: the first column is headed Customer", text(srPage().querySelector("#srSalesTable thead th")) === "Customer");
  ok("…a customer row without a key or id: its label as plain text, no link to a customer", text(srRows()[0].cells[0]) === "Walk-ins" && !srRows()[0].querySelector("a"));
  ok("…no totals in the answer: the Total row reads 0 orders, 0 qty and $0.00", same([...srPage().querySelectorAll("#srSalesTable tfoot td")].slice(0, 4).map(text), ["Total", "0", "0", $m(0)]) &&
    text(srPage().querySelector("#srSalesTable tfoot td[data-label='Net sales']")) === $m(0));
  reset(); saves.length = 0; click(srPage().querySelector(".sr-csv")); await pause(10);
  { const lines = await csvLines();
    ok("…its CSV: named for the grouping the server gave, headed Customer, its Total line all zeros",
      saves[0] === "sales-by-bogus-2026-12-01-to-2026-12-15.csv" && lines[0].startsWith("Customer,Orders,Qty") && lines[1].startsWith("Walk-ins,1,2,5") && lines[2] === "Total,0,0,0,0,0,0,"); }
  reset(); click(srPage().querySelector(".sr-basis"));
  ok("a click on the page that isn't on a button asks nothing and changes nothing", of("getSalesReport").length === 0 && srRows().length === 1);

  scripted = [{ action: "getSalesReport", body: { status: "ok", report: { rows: "none" } } }];
  await goTo("salesby", srPage);
  reset(); { const csv = srPage().querySelector(".sr-csv"); csv.disabled = false; click(csv); }
  ok("rows that aren't a list: “No sales in these dates.”, and CSV forced on still says “There are no sales to export.”",
    text(srPage().querySelector(".sr-body")) === "No sales in these dates." && lastToast().m === "There are no sales to export.");
  scripted = [{ action: "getSalesReport", status: 500, body: { status: "error", message: "The report is resting." } }];
  await goTo("salesby", srPage);
  reset(); { const csv = srPage().querySelector(".sr-csv"); csv.disabled = false; click(csv); }
  ok("after a failed load: the error on the page, and CSV forced on says “There are no sales to export.”",
    /The report is resting\./.test(text(srPage().querySelector(".sr-body"))) && lastToast().m === "There are no sales to export." && saves.length === 1);

  { const byBox = srPage().querySelector(".sr-by");
    byBox.insertAdjacentHTML("beforeend", '<button type="button" class="sr-by-btn" data-sr-by="bogus">Bogus</button>');
    reset(); click(byBox.querySelector('[data-sr-by="bogus"]')); await idle();
    const asked = of("getSalesReport");
    await goTo("salesby", srPage);
    ok("a grouping the page doesn't know (from a button added to the page): asked once as is, and the page opened again goes back to Customer",
      asked.length === 1 && asked[0].by === "bogus" && of("getSalesReport")[0].by === "customer" &&
      srPage().querySelector('.sr-by-btn[data-sr-by="customer"]').classList.contains("on") && srPage().querySelector('.sr-by-btn[data-sr-by="customer"]').getAttribute("aria-pressed") === "true"); }

  // ==============================================================================================================
  console.log("\n=== Profit per job ===");
  // ==============================================================================================================
  const prRow = (o) => Object.assign({ orgId: "club", customerName: "Pat Example", saleDate: "2026-12-02", revenueCents: 2000, costCents: 500, profitCents: 1500, marginPct: 75, costs: { blanksCents: 500 } }, o);
  answers.getProfitReport = () => ({ body: { status: "ok", report: { rows: [], totals: {} } } });
  await goTo("profit", prPage);
  { const sel = prPage().querySelector(".sr-sort-sel");
    sel.insertAdjacentHTML("beforeend", '<option value="bogus">Bogus</option>');
    reset(); choose(sel, "bogus"); await idle();
    const asked = of("getProfitReport");
    await goTo("profit", prPage);
    ok("a sort the page doesn't know (an option added to the page): asked once as is, and the page opened again sorts by Lowest margin first",
      asked.length === 1 && asked[0].sort === "bogus" && of("getProfitReport")[0].sort === "margin" && prPage().querySelector(".sr-sort-sel").value === "margin"); }
  answers.getProfitReport = () => ({ body: { status: "ok", report: { rows: [prRow({ orderId: "EX-1", orgName: "Club From Server" }), prRow({ orderId: "EX-2" }), prRow({ orderId: "EX-3", orgId: "gone" }), prRow({ orderId: "EX-4", orgId: "" })] } } });
  reset(); choose(prPage().querySelector(".sr-org"), "club"); await idle();
  const subs = () => [...prPage().querySelectorAll("#srProfitTable .ar-sub")].map(text);
  ok("a shop chosen: Profit per job is asked for that shop", of("getProfitReport").length === 1 && of("getProfitReport")[0].orgId === "club");
  ok("each order's shop: the name the server sent, else the shop list's name, else its id, else nothing",
    same(subs(), ["Club From Server", "Example Club", "gone", ""]));
  ok("no totals or basis in the answer: the strip reads $0.00 and 0 orders, the dates with no basis note",
    same([...prPage().querySelectorAll(".sr-totals .gc-total")][0].children.length && [...[...prPage().querySelectorAll(".sr-totals .gc-total")][0].children].map(text), [$m(0), "Revenue", "0 orders"]) &&
    text(prPage().querySelector(".sr-basis")) === `${day("2026-12-01")} – ${day("2026-12-15")}, each day on the business's own calendar.`);
  reset(); saves.length = 0; click(prPage().querySelector(".sr-csv")); await pause(10);
  ok("…its CSV is named for the chosen shop", saves[0] === "profit-per-job-2026-12-01-to-2026-12-15-club.csv");
  { const lines = await csvLines();
    ok("…and its shop column follows the same names", same(lines.slice(1).map(l => l.split(",")[1]), ["Club From Server", "Example Club", "gone", ""])); }
  setShops(null);
  await drawStraight("renderProfitReport", prPage);
  ok("no shop list at all: an order without a shop name from the server shows its shop id", subs()[1] === "club" && subs()[0] === "Club From Server");
  setShops([{ orgId: "school", name: "Example School Shop" }, { orgId: "club", name: "Example Club" }]);
  { const body = prPage().querySelector(".sr-body");
    body.insertAdjacentHTML("beforeend", '<button type="button" class="sr-toggle" data-sr-toggle="99">x</button>');
    reset(); click(body.querySelector('[data-sr-toggle="99"]'));
    ok("a toggle for a row that isn't there: nothing opens, nothing is asked", !prPage().querySelector(".sr-parts-row") && sent.length === 0);
    reset(); click(prPage().querySelector(".sr-totals"));
    ok("a click that isn't on a button: nothing opens, nothing is asked", !prPage().querySelector(".sr-parts-row") && sent.length === 0 && opened.length === 0); }
  scripted = [{ action: "getProfitReport", body: "not an object" }];
  await goTo("profit", prPage);
  ok("an answer that isn't an object: “No orders in these dates.” and no totals strip",
    text(prPage().querySelector(".sr-body")) === "No orders in these dates." && text(prPage().querySelector(".sr-totals")) === "");
  scripted = [{ action: "getProfitReport", status: 500, body: { status: "error", message: "Costs are resting." } }];
  await goTo("profit", prPage);
  { const body = prPage().querySelector(".sr-body");
    body.insertAdjacentHTML("beforeend", '<button type="button" data-sr-open="0">x</button><button type="button" data-sr-toggle="0">y</button>');
    reset(); opened.length = 0; click(body.querySelector("[data-sr-open]")); click(body.querySelector("[data-sr-toggle]"));
    ok("after a failed load, an order link or toggle left on the page opens nothing", opened.length === 0 && !prPage().querySelector(".sr-parts-row") && /Costs are resting\./.test(text(body)));
    reset(); saves.length = 0; const csv = prPage().querySelector(".sr-csv"); csv.disabled = false; click(csv);
    ok("…and CSV forced on says “There are no orders to export.”", lastToast().m === "There are no orders to export." && lastToast().err && saves.length === 0); }

  // ==============================================================================================================
  console.log("\n=== Gift card liability ===");
  // ==============================================================================================================
  scripted = [{ action: "getGiftCardLiability", body: { status: "ok", report: { outstandingNowCents: 2500, months: [{ month: "", openingCents: 2500, soldCents: 0, closingCents: 2500 }] } } }];
  await goTo("giftliability", lbPage);
  ok("no end date in the answer: “Owed on” the To date asked for (Dec 15)", text(lbPage().querySelector(".sr-totals")).includes(`Owed on ${day(TODAY)}`) && of("getGiftCardLiability")[0].dateTo === TODAY);
  ok("a month without a name: an empty first cell, its figures still shown", (() => { const r = lbPage().querySelector("#srLiabTable tbody tr"); return text(r.cells[0]) === "" && text(r.cells[1]) === $m(2500); })());
  ok("no totals in the answer: the Total row shows $0.00 opening and closing", (() => { const c = [...lbPage().querySelectorAll("#srLiabTable tfoot td")].map(text); return c[0] === "Total" && c[1] === $m(0) && c[8] === $m(0); })());
  reset(); saves.length = 0; click(lbPage().querySelector(".sr-csv")); await pause(10);
  { const lines = await csvLines();
    ok("…its CSV: the month line, and a Total line all zeros", saves[0] === `gift-card-liability-2026-01-01-to-${TODAY}.csv` && lines.length === 3 && lines[2] === "Total,0,0,0,0,0,0,0,0"); }
  scripted = [{ action: "getGiftCardLiability", body: "not an object" }];
  await goTo("giftliability", lbPage);
  ok("an answer that isn't an object: “No months in these dates.”, only “On cards right now” ($0.00)",
    text(lbPage().querySelector(".sr-body")) === "No months in these dates." && lbPage().querySelectorAll(".sr-totals .gc-total").length === 1 && same([...lbPage().querySelector(".sr-totals .gc-total").children].map(text), [$m(0), "On cards right now", "Every active card's balance today"]));
  scripted = [{ action: "getGiftCardLiability", status: 500, body: { status: "error", message: "Cards are resting." } }];
  await goTo("giftliability", lbPage);
  reset(); saves.length = 0; { const csv = lbPage().querySelector(".sr-csv"); csv.disabled = false; click(csv); }
  ok("after a failed load, CSV forced on says “There are no months to export.”", lastToast().m === "There are no months to export." && lastToast().err && saves.length === 0);

  // ==============================================================================================================
  console.log("\n=== QuickBooks export ===");
  // ==============================================================================================================
  const page = () => id("qbPage");
  const leave = async () => { w.location.hash = "#giftliability"; await wait(() => !!lbPage() && !page()); await idle(); };
  const okSettings = (o) => ({ body: Object.assign({ status: "ok" }, o) });
  answers.getQuickBooksSettings = () => okSettings({ settings: { format: "online" }, accounts: [], categories: [] });
  answers.getQuickBooksExport = (b) => ({ body: { status: "ok", summary: { sales: { count: 1, totalCents: 1000 }, payments: { count: 0, totalCents: 0 }, expenses: { count: 0, totalCents: 0 }, deposits: { count: 0, totalCents: 0 } } } });
  const goQb = async () => { const old = page(); reset(); if (hashNow() === "quickbooks") w.adminRoute(); else w.location.hash = "#quickbooks"; await wait(() => !!page() && page() !== old && !!q("#qbMap input, #qbMap .cust-err")); await idle(); };
  { const { g, release } = gate();
    scripted = [{ action: "getQuickBooksSettings", gate: g, body: { status: "ok", settings: {} } }];
    reset(); w.location.hash = "#quickbooks"; await wait(() => of("getQuickBooksSettings").length === 1);
    await leave(); release(); await pause(30); await idle();
    ok("left while the settings were on the way: no accounts, categories or summary asked for afterwards",
      of("listAccounts").length === 0 && of("listExpenseCategories").length === 0 && of("getQuickBooksExport").length === 0 && !page()); }
  { const { g, release } = gate();
    scripted = [{ action: "getQuickBooksSettings", gate: g, status: 500, body: { status: "error", message: "Settings are resting." } }];
    reset(); w.location.hash = "#quickbooks"; await wait(() => of("getQuickBooksSettings").length === 1);
    await leave(); release(); await pause(30); await idle();
    ok("…nor when that late answer is a failure", of("listAccounts").length === 0 && of("getQuickBooksExport").length === 0 && !/Settings are resting/.test(text(app))); }
  { const { g, release } = gate();
    scripted = [{ action: "getQuickBooksSettings", body: { status: "ok", settings: {} } }, { action: "listAccounts", gate: g, body: { status: "ok", accounts: [] } }];
    reset(); w.location.hash = "#quickbooks"; await wait(() => of("listAccounts").length === 1);
    await leave(); release(); await pause(30); await idle();
    ok("left while the bank accounts were on the way: no summary asked for", of("getQuickBooksExport").length === 0 && !page()); }

  scripted = [{ action: "getQuickBooksSettings", body: { status: "ok" } }, { action: "listAccounts", body: "" }, { action: "listExpenseCategories", body: "" },
    { action: "getQuickBooksExport", body: { status: "ok" } }];
  await goQb();
  const accBox = (k) => q(`#qbMap input[data-qb-acc="${k}"]`), bankBox = (k) => q(`#qbMap input[data-qb-bank="${k}"]`), catBox = (k) => q(`#qbMap input[data-qb-cat="${k}"]`);
  ok("a server that sends no settings and empty answers for the accounts and categories: each account box holds its QuickBooks default (Sales, Undeposited Funds)",
    accBox("sales").value === "Sales" && accBox("undepositedFunds").value === "Undeposited Funds" && of("listAccounts").length === 1 && of("listExpenseCategories").length === 1);
  ok("…“No accounts set up yet (Finance → Accounts).” and “No expense categories yet.”, QuickBooks Online picked",
    /No accounts set up yet \(Finance → Accounts\)\./.test(text(id("qbMap"))) && /No expense categories yet\./.test(text(id("qbMap"))) && q('input[name="qbFormat"][value="online"]').checked);
  const cellText = (label) => { const c = qa("#qbSummary .gc-total").find(x => text(x.querySelector(".gc-total-l")) === label); return c ? [...c.children].map(text).join(" ") : ""; };
  ok("…no summary in its answer: every part $0.00, “0 orders”, and “Nothing in these dates for the ticked parts.”",
    cellText("Sales") === `${$m(0)} Sales 0 orders` && cellText("Deposits") === `${$m(0)} Deposits 0 deposits` && text(id("qbDownloadNote")) === "Nothing in these dates for the ticked parts." && id("qbDownload").disabled === false);

  scripted = [{ action: "getQuickBooksSettings", body: { status: "ok", quickbooks: { format: "desktop", accounts: { sales: "Income:Embroidery" } },
    accounts: [{ id: 5, name: "" }, { id: 6, name: "Checking" }], categories: [{ id: 9, name: "" }, { id: 10, name: "Thread" }] } }];
  await goQb();
  ok("settings sent under `quickbooks`: Sales mapped to Income:Embroidery, the rest at their defaults",
    accBox("sales").value === "Income:Embroidery" && accBox("postage").value === "Postage and Delivery");
  ok("a bank account with no name and no mapping: an empty box with no placeholder; a named one holds its own name",
    bankBox("5").value === "" && bankBox("5").getAttribute("placeholder") === "" && bankBox("6").value === "Checking" && bankBox("6").getAttribute("placeholder") === "Checking");
  ok("…the same for expense categories", catBox("9").value === "" && catBox("10").value === "Thread");
  const submitMap = async () => { reset(); fire(id("qbMap"), "submit"); await pause(20); await idle(); };
  const mapErr = () => text(id("qbMapErr"));
  await submitMap();
  ok("Save with the unnamed account and category empty: “Give 2 boxes a name of 1 to 100 characters, on one line.”, nothing sent",
    mapErr() === "Give 2 boxes a name of 1 to 100 characters, on one line." && of("updateQuickBooksSettings").length === 0);
  bankBox("5").value = "Savings";
  await submitMap();
  ok("…only the category left: it is named “category 9” (it has no name of its own)", mapErr() === "Give category 9 a name of 1 to 100 characters, on one line.");
  catBox("9").value = "Supplies";
  id("qbMap").querySelector("div").insertAdjacentHTML("beforeend", '<input type="text" data-qb-bank="77" value=""><input type="text" data-qb-acc="otherIncome" value="">');
  await submitMap();
  ok("boxes for an account and a bank account the page doesn't know: named by their key (“otherIncome”) and “account 77”",
    mapErr() === "Give 2 boxes a name of 1 to 100 characters, on one line." && of("updateQuickBooksSettings").length === 0);
  q('#qbMap input[data-qb-acc="otherIncome"]').value = "Other Income";
  await submitMap();
  ok("…the bank account alone: “Give account 77 a name of 1 to 100 characters, on one line.”", mapErr() === "Give account 77 a name of 1 to 100 characters, on one line.");
  q('#qbMap input[data-qb-bank="77"]').remove(); q('#qbMap input[data-qb-acc="otherIncome"]').remove();
  id("qbMap").querySelector("div").insertAdjacentHTML("beforeend", '<input type="text" data-qb-cat="88" value="">');
  await submitMap();
  ok("…and a category the page doesn't know: “Give category 88 a name of 1 to 100 characters, on one line.”", mapErr() === "Give category 88 a name of 1 to 100 characters, on one line." && of("updateQuickBooksSettings").length === 0);
  q('#qbMap input[data-qb-cat="88"]').remove();
  accBox("postage").value = "Postage\tand Delivery";
  await submitMap();
  ok("a name with a tab in it is refused: “Give Postage a name of 1 to 100 characters, on one line.”", mapErr() === "Give Postage a name of 1 to 100 characters, on one line.");
  accBox("postage").value = "P".repeat(101);
  await submitMap();
  ok("…so is one of 101 characters", mapErr() === "Give Postage a name of 1 to 100 characters, on one line." && of("updateQuickBooksSettings").length === 0);
  accBox("postage").value = "Postage";
  qa('#qbMap input[name="qbSalesAs"], #qbMap input[name="qbCustomerName"]').forEach(r => { r.checked = false; });
  scripted = [{ action: "updateQuickBooksSettings", body: { status: "ok" } }];
  await submitMap();
  { const s = of("updateQuickBooksSettings")[0] || {};
    ok("no Sales go in as or Customer name ticked: sent as Sales receipts under the customer's name, with the names typed",
      s.salesAs === "receipts" && s.customerName === "customer" && s.bankAccounts && s.bankAccounts["5"] === "Savings" && s.expenseAccounts["9"] === "Supplies" && s.accounts.postage === "Postage");
    ok("…a Save answered without the settings: “QuickBooks account mapping saved.”, and the page keeps what was typed with Sales receipts and Customer ticked",
      lastToast().m === "QuickBooks account mapping saved." && !lastToast().err && bankBox("5").value === "Savings" && catBox("9").value === "Supplies" &&
      q('input[name="qbSalesAs"][value="receipts"]').checked && q('input[name="qbCustomerName"][value="customer"]').checked && mapErr() === ""); }

  scripted = [{ action: "updateQuickBooksSettings", status: 500, body: { status: "error", message: "Settings are resting." } }];
  reset(); tick(q('input[name="qbFormat"][value="desktop"]'), true); await idle();
  ok("a format change the server refuses to remember: asked once with Desktop, no message about it, and the page shows the Desktop how-to",
    of("updateQuickBooksSettings").length === 1 && of("updateQuickBooksSettings")[0].format === "desktop" && toasts.length === 0 && /QuickBooks Desktop:/.test(text(id("qbHowTo"))));

  reset(); tick(q('input[data-qb-part="deposits"]'), false);
  await leave(); await goQb();
  ok("a part unticked is still unticked when the page is opened again (and shown as Not exported)",
    q('input[data-qb-part="deposits"]').checked === false && q('input[data-qb-part="sales"]').checked === true && /Not exported/.test(cellText("Deposits")));
  tick(q('input[data-qb-part="deposits"]'), true);

  scripted = [{ action: "getQuickBooksExport", status: 500, body: { status: "error", message: "Export is resting." } }];
  reset(); fire(id("qbFilters"), "submit"); await idle();
  ok("a summary that fails: its message on the page, Download off", /Export is resting\./.test(text(id("qbSummary"))) && id("qbDownload").disabled === true);
  tick(q('input[data-qb-part="sales"]'), false);
  ok("…a part ticked off after that: every part shows $0.00, and Download stays off with no summary",
    cellText("Payments") === `${$m(0)} Payments 0 payments` && /Not exported/.test(cellText("Sales")) && id("qbDownload").disabled === true && text(id("qbDownloadNote")) === "");
  tick(q('input[data-qb-part="sales"]'), true);
  reset(); fire(id("qbFilters"), "submit"); await idle();

  scripted = [{ action: "getQuickBooksExport", body: { status: "ok", files: "none" } }];
  reset(); saves.length = 0; click(id("qbDownload")); await idle();
  ok("files that aren't a list: “Nothing to export in these dates.”, nothing saved, no message", text(id("qbFiles")) === "Nothing to export in these dates." && saves.length === 0 && toasts.length === 0);
  scripted = [{ action: "getQuickBooksExport", body: { status: "ok", files: [{ filename: "example-sales.csv" }, { text: "no name" }, null] } }];
  reset(); saves.length = 0; const blobsBefore = blobs.length; click(id("qbDownload")); await idle(); await pause(50);
  ok("a file without text or a type, beside entries without a name: only the named one, saved empty as plain text",
    same(saves, ["example-sales.csv"]) && blobs.length === blobsBefore + 1 && blobs[blobs.length - 1].size === 0 && blobs[blobs.length - 1].type === "text/plain;charset=utf-8" &&
    lastToast().m === "QuickBooks file saved." && text(id("qbFiles")).startsWith("Saved: example-sales.csv"));
  { const { g, release } = gate();
    scripted = [{ action: "getQuickBooksExport", gate: g, body: { status: "ok", files: [{ filename: "late.iif", text: "!TRNS" }] } }];
    reset(); saves.length = 0; click(id("qbDownload")); await wait(() => of("getQuickBooksExport").length === 1);
    await leave(); release(); await pause(50); await idle();
    ok("a download whose page was left before its answer: nothing saved, no message", saves.length === 0 && toasts.length === 0); }

  await goQb();
  reset(); click(id("qbHowTo"));
  const dl = id("qbDownload").disabled;
  ok("a click that isn't on a button asks nothing", sent.length === 0 && dl === false);
  q("#qbFilters div").insertAdjacentHTML("beforeend", '<button type="button" data-qb-preset="someday">Someday</button>');
  { const from = id("qbFrom").value, to = id("qbTo").value;
    reset(); click(q('[data-qb-preset="someday"]')); await idle();
    ok("a preset the page doesn't know: the dates stay and nothing is asked", sent.length === 0 && id("qbFrom").value === from && id("qbTo").value === to); }

  scripted = [{ action: "getQuickBooksSettings", status: 500, body: { status: "error", message: "Mapping is resting." } }];
  await leave(); await goQb();
  ok("settings that fail: their message where the mapping goes, no Save button", /Mapping is resting\./.test(text(id("qbMap"))) && !id("qbSave"));
  reset(); tick(q('input[name="qbFormat"][value="online"]'), true); await idle();
  ok("…a format picked then isn't saved (there are no settings to save it into), the Online how-to shows", of("updateQuickBooksSettings").length === 0 && /QuickBooks Online:/.test(text(id("qbHowTo"))));

  finished = true;
})().catch((e) => { console.error(e); ok("the test ran without an exception", false); finished = true; process.exit(1); });
