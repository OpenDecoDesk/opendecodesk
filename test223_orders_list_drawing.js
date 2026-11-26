const fs = require("fs");
const { storefrontPage } = require("./testlib/storefront-page");
const { createD1 } = require("./testlib/d1-shim.js");
const { JSDOM, ResourceLoader } = require("jsdom");

// The Orders list with many orders (2026-11):
//   - one shop's list draws the newest 300 matching orders, says so, and Show more draws the next lot (the totals
//     still cover every order); the All-shops list the same
//   - the include boxes and Show more redraw from the orders already loaded — no request
//   - the list asks for blank stock only (getBlanks stockOnly), not the whole Blanks screen
//   - All shops says when its one limit over every shop cut the list
//   - the default date range follows the calendar: a page left open overnight shows the new day on Refresh, while
//     a date the admin picked stays put
// Real SQL (sql.js) + real db.js, orders.js and admin.js (jsdom). Invented shops and customers only.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + "\nreturn { insertOrder, createBlank };")();
const ordersSrc = strip(read("functions/api/orders.js"));
if (!ordersSrc.includes("const ORDERS_LIST_MAX = 2000;")) throw new Error("ORDERS_LIST_MAX not found in orders.js");
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'owner@test'; const adminUser = () => null;\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  dbSrc + "\n" + ordersSrc.replace("const ORDERS_LIST_MAX = 2000;", "const ORDERS_LIST_MAX = 330;") + "\nreturn onRequestPost;")();
let failed = 0;
const ok = (label, cond) => { if (!cond) failed++; console.log(label + ": " + !!cond); };
const hoursAgo = (n) => new Date(Date.now() - n * 3600000).toISOString();
const wait = async (fn, n = 400) => { for (let i = 0; i < n && !fn(); i++) await new Promise(x => setTimeout(x, 10)); return fn(); };

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Example Club','t','t'), ('rec','rec','Rec League','t','t');`);
  await lib.createBlank(d1, { name: "Plain cap", brand: "Generic", color: "Navy", productType: "cap" }, [{ size: "OSFA", quantity: 7 }]);
  // 320 orders for one shop over the last few days (one completed), 15 for the other.
  for (let i = 0; i < 320; i++) await lib.insertOrder(d1, { orderId: "A" + String(i).padStart(3, "0"), orgId: "acme", customerName: "Customer " + i, contact: "a" + i + "@example.com",
    placedAt: hoursAgo(1 + i * 0.25) }, [{ productId: "cap", name: "Cap", type: "cap", size: "OSFA", qty: 1, unitPrice: 20 }]);
  for (let i = 0; i < 15; i++) await lib.insertOrder(d1, { orderId: "R" + String(i).padStart(3, "0"), orgId: "rec", customerName: "Member " + i, contact: "r" + i + "@example.com",
    placedAt: hoursAgo(2 + i) }, [{ productId: "cap", name: "Cap", type: "cap", size: "OSFA", qty: 1, unitPrice: 20 }]);
  d1._raw.run("UPDATE orders SET paid = 1, deliveredAt = ?, completedAt = ? WHERE orderId = 'A000'", [hoursAgo(1), hoursAgo(1)]);
  const call = async (body) => {
    const res = await api({ env: { DB: d1 }, waitUntil: () => {}, request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };

  console.log("=== getBlanks stockOnly ===");
  const r = await call({ action: "getBlanks", stockOnly: true });
  ok("each blank's id and its sizes' stock on hand, nothing else", r.status === 200 && r.body.blanks.length === 1 && JSON.stringify(Object.keys(r.body.blanks[0])) === '["id","sizes"]' &&
    r.body.blanks[0].sizes.some(z => z.size === "OSFA" && z.quantity === 7) && !("reserved" in r.body) && !("lowStock" in r.body));
  const fullBlanks = await call({ action: "getBlanks" });
  ok("without it, getBlanks still gives the Blanks screen everything", fullBlanks.body.blanks[0].name === "Plain cap" && "reserved" in fullBlanks.body && "lowStock" in fullBlanks.body && "products" in fullBlanks.body);

  console.log("\n=== One shop: the newest 300 drawn, Show more for the rest ===");
  const adminJs = read("public/admin.js");
  const sent = [];
  class L extends ResourceLoader { fetch(url, o) { if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const dom = new JSDOM(storefrontPage(), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win) { win.fetch = async (u, init) => { const b = init && typeof init.body === "string" ? JSON.parse(init.body) : {}; sent.push(b); const x = await call(b);
      return { ok: x.status < 400, status: x.status, json: async () => x.body, text: async () => JSON.stringify(x.body) }; }; } });
  const w = dom.window, d = w.document;
  w.CSS = { escape: (x) => String(x).replace(/[^a-zA-Z0-9_-]/g, "\\$&") };
  await new Promise(x => setTimeout(x, 150));
  await w.loadAdminScript();
  w.eval('adminKey = "cookie"; adminOrgs = [{ orgId: "acme", name: "Example Club" }, { orgId: "rec", name: "Rec League" }];');
  const app = d.getElementById("app");
  const drawn = () => new Set([...d.querySelectorAll("#adminPanel tbody tr[data-order]")].map(tr => tr.dataset.order)).size;
  const summary = () => d.getElementById("ordSummaryBar").textContent.replace(/\s+/g, " ").trim();
  await w.renderAdminOrders(app, { orgId: "acme", name: "Example Club" });
  await wait(() => d.getElementById("ordSummaryBar"));
  ok("the list asks for blank stock only", sent.some(b => b.action === "getBlanks" && b.stockOnly === true) && !sent.some(b => b.action === "getBlanks" && !b.stockOnly));
  ok("319 open orders match; the newest 300 are drawn", drawn() === 300 && /^319 orders/.test(summary()));
  const note = () => (d.querySelector("#adminPanel .admin-note button[data-admin-action='ordersShowMore_']") || {}).parentElement;
  ok("…the note says so, with Show 19 more, and that Select all ticks only those shown", !!note() && /Showing the 300 most recent of 319 matching orders/.test(note().textContent) &&
    /Show 19 more/.test(note().textContent) && /Select all.{0,3} ticks only the orders shown/.test(note().textContent));
  ok("the totals still cover all 319 ($6380.00)", /\$6380\.00 active total/.test(summary()));
  const tick = d.querySelector('.order-select[data-order="A005"]'); tick.checked = true; tick.dispatchEvent(new w.Event("change"));
  sent.length = 0;
  await w.ordersShowMore_();
  ok("Show more draws all 319, with no request, the note gone and the tick kept", drawn() === 319 && !sent.length && !note() &&
    d.querySelector('.order-select[data-order="A005"]').checked && d.getElementById("bulkBar").style.display !== "none");

  console.log("\n=== The include boxes redraw from what's loaded ===");
  sent.length = 0;
  d.getElementById("ordIncludeCompleted").click();
  await wait(() => /^320 orders/.test(summary()));
  ok("Include completed shows the completed order without asking the server", /^320 orders/.test(summary()) && !!d.querySelector('tr[data-order="A000"]') && !sent.length);
  d.getElementById("ordIncludeCompleted").click();
  await wait(() => /^319 orders/.test(summary()));
  ok("…and unticking hides it again, still no request", /^319 orders/.test(summary()) && !d.querySelector('tr[data-order="A000"]') && !sent.length);
  sent.length = 0;
  await w.refreshOrdersInPlace_({ orgId: "acme", name: "Example Club" });
  ok("Refresh does load them again", sent.some(b => b.action === "getOrders"));

  console.log("\n=== All shops: one limit over every shop ===");
  await w.renderOrdersPage(app);
  await wait(() => d.querySelector("#adminPanel tbody tr[data-order]"));
  const panelText = () => d.getElementById("adminPanel").textContent.replace(/\s+/g, " ");
  ok("335 orders and a limit of 330: the note says only the newest 330 across all shops were loaded", /Only the newest 330 orders across all shops were loaded/.test(panelText()));
  ok("…and only 300 are drawn, with Show more", drawn() === 300 && /Showing the 300 most recent of 329 matching orders/.test(panelText()));
  sent.length = 0;
  await w.ordersShowMore_();
  ok("Show more on All shops draws the rest without a request", drawn() === 329 && !sent.length);

  console.log("\n=== The default dates follow the calendar ===");
  // n calendar days before the business's today. Not "now less n × 24 hours": across a clock change (within the
  // last 31 days) that lands an hour off, which near midnight is the next or previous day.
  const today = w.localDay_(new Date()), [ty, tm, td] = today.split("-").map(Number);
  const day = (n) => new Date(Date.UTC(ty, tm - 1, td - n)).toISOString().slice(0, 10);
  // As if the page was opened yesterday: the range it set then is still the automatic one.
  w._ordersFilter = { from: day(31), to: day(1) }; w._ordersFilterAuto_ = { from: day(31), to: day(1) };
  ok("a range left from yesterday moves on to today", w.ordersRollDates_() === true && w._ordersFilter.to === day(0) && w._ordersFilter.from === day(30));
  ok("…once (it's today's now)", w.ordersRollDates_() === false);
  w._ordersFilter = { from: day(10), to: day(1) }; w._ordersFilterAuto_ = { from: day(31), to: day(1) };
  ok("a start the admin picked stays; the end still moves to today", w.ordersRollDates_() === true && w._ordersFilter.from === day(10) && w._ordersFilter.to === day(0));
  w._ordersFilter = { from: day(31), to: day(3) }; w._ordersFilterAuto_ = { from: day(31), to: day(1) };
  ok("an end the admin picked stays, and so does the start", w.ordersRollDates_() === false && w._ordersFilter.to === day(3) && w._ordersFilter.from === day(31));
  w._ordersFilter = { from: "", to: "" };
  ok("cleared dates stay cleared", w.ordersRollDates_() === false && w._ordersFilter.to === "");
  w._ordersFilter = { from: day(31), to: day(1) }; w._ordersFilterAuto_ = { from: day(31), to: day(1) };
  await w.renderAdminOrders(app, { orgId: "rec", name: "Rec League" });
  await wait(() => d.getElementById("ordSummaryBar"));
  ok("opening the list on the new day asks for today, and the date boxes show it", sent.slice(-4).some(b => b.action === "getOrders" && b.dateTo === day(0) && b.dateFrom === day(30)) &&
    d.getElementById("ordFilterTo").value === day(0));

  console.log("\n=== An action on one order of a long list redraws only its rows (review #62) ===");
  const acme = { orgId: "acme", name: "Example Club" };
  await w.renderAdminOrders(app, acme);
  await wait(() => d.getElementById("ordSummaryBar") && drawn() === 300);
  const ids = () => [...new Set([...d.querySelectorAll("#adminPanel tbody tr[data-order]")].map(tr => tr.dataset.order))];
  const capText = () => (d.querySelector("#adminPanel .orders-cap-note") || {}).textContent || "";
  const tbody = d.querySelector("#adminPanel tbody"), a010 = d.querySelector('tr[data-order="A010"]');
  ok("(319 match, the newest 300 drawn, the 301st not)", /of 319 matching/.test(capText()) && drawn() === 300 && !d.querySelector('tr[data-order="A301"]'));
  // A005 completed: it leaves the list, and the next order down takes the last place drawn.
  d1._raw.run("UPDATE orders SET paid = 1, deliveredAt = ?, completedAt = ? WHERE orderId = 'A005'", [hoursAgo(1), hoursAgo(1)]);
  sent.length = 0;
  await w.refreshOrderRows_("acme", ["A005"]);
  ok("the order is asked for alone — no list reload", JSON.stringify(sent.map(b => b.action)) === '["getOrdersByIds"]');
  ok("…it leaves the list; still 300 drawn, the next one (A301) now among them; the rest are the same rows",
    !d.querySelector('tr[data-order="A005"]') && drawn() === 300 && !!d.querySelector('tr[data-order="A301"]') && d.querySelector('tr[data-order="A010"]') === a010 &&
    d.querySelector("#adminPanel tbody") === tbody);
  ok("…the note and the totals follow (318 matching)", /of 318 matching/.test(capText()) && /^318 orders/.test(summary()) && /\$6360\.00 active total/.test(summary()));
  // A new order (a Local sale) goes in at the top; the last one drawn drops below the line.
  await lib.insertOrder(d1, { orderId: "A900", orgId: "acme", customerName: "Walk-in", contact: "walkin@example.com", placedAt: new Date().toISOString() },
    [{ productId: "cap", name: "Cap", type: "cap", size: "OSFA", qty: 1, unitPrice: 20 }]);
  sent.length = 0;
  await w.refreshOrderRows_("acme", ["A900"]);
  ok("a new order is put in first, still 300 drawn (A301 drops below the line again), one request", ids()[0] === "A900" && drawn() === 300 && !d.querySelector('tr[data-order="A301"]') &&
    sent.length === 1 && sent[0].action === "getOrdersByIds" && /of 319 matching/.test(capText()) && /^319 orders/.test(summary()));
  ok("…and the loaded list has it first and A005 completed, so Show more draws from it", w._ordersCache.acme[0].orderId === "A900" &&
    !!w._ordersCache.acme.find(o => o.orderId === "A005").completedAt && w._ordersCache.acme.length === 321);
  sent.length = 0;
  await w.ordersShowMore_();
  ok("…Show more then draws all 319 without a request, A005 still out", drawn() === 319 && !sent.length && !d.querySelector('tr[data-order="A005"]'));

  if (failed) { console.log("\n" + failed + " check(s) failed"); process.exit(1); }
})().catch((e) => { console.error(e); console.log("test223 crashed: false"); process.exit(1); });
