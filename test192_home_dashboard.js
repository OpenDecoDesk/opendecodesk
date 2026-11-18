const fs = require("fs");
const { may, lowest, pageLowest, asRole } = require("./testlib/roles");   // the built-in roles (functions/_lib/permissions.js)
const { createD1 } = require("./testlib/d1-shim.js");
const { JSDOM, ResourceLoader } = require("jsdom");

// Home (2026-11): the page the admin opens on. Open orders counted by the step each one is waiting
// on (one tile each), and the year's / month's money (db.js getDashboardMoney). Real SQL (sql.js) +
// real db.js, orders.js and admin.js (jsdom).

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "")
  .replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + "\nreturn { insertOrder, getDashboardMoney, getDashboard, homeOrderStage, DASHBOARD_TTL_MS, setFeatures };")();
const pad = (n) => String(n).padStart(2, "0");
const now = new Date();
const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const yearFrom = today.slice(0, 4) + "-01-01", monthFrom = today.slice(0, 7) + "-01";
const lastYear = (Number(today.slice(0, 4)) - 1) + "-06-15";
const at = (day) => day + "T12:00:00.000Z";

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('prime','prime','Example League','t','t'), ('rec','rec','REC','t','t');`);
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  // These figures count each order on the day it was placed (Global settings → Bookkeeping → "the order is placed";
  // the default, shipped or delivered, is test193's).
  d1._raw.run("INSERT INTO global_settings (key, value) VALUES ('accounting', '{\"saleDate\":\"placed\"}')");

  // Every order: 2 × $23 = $46 of goods, no tax, no shipping — placed today unless said otherwise.
  const add = (orderId, orgId, extra = {}, placed = today) => lib.insertOrder(d1, Object.assign({ orderId, orgId, customerName: "Cust " + orderId,
    contact: orderId.toLowerCase() + "@x.com", paymentMethod: "Venmo", placedAt: at(placed) }, extra),
    [{ productId: "", name: "Polo", type: "shirt", size: "L", qty: 2, unitPrice: 23 }]);
  const pay = (orderId) => { d1._raw.run("INSERT INTO order_payments (orderId, amountCents, receivedAt, method) VALUES (?, 4600, ?, 'venmo')", [orderId, at(today)]); d1._raw.run("UPDATE orders SET paid=1, paidAt=? WHERE orderId=?", [at(today), orderId]); };
  const set = (orderId, cols) => d1._raw.run(`UPDATE orders SET ${cols.map(c => c + "=?").join(", ")} WHERE orderId=?`, [...cols.map(() => at(today)), orderId]);

  await add("NEW1", "prime");
  await add("NEW2", "rec");
  await add("PAID1", "prime"); pay("PAID1");
  await add("BLANK1", "rec"); pay("BLANK1"); set("BLANK1", ["blankOrderedAt"]);
  await add("RUN1", "prime"); pay("RUN1"); set("RUN1", ["blankOrderedAt", "blankReceivedAt"]);
  await add("QA1", "prime"); pay("QA1"); set("QA1", ["blankOrderedAt", "blankReceivedAt", "manufacturedAt"]);
  await add("SHIP1", "rec"); pay("SHIP1"); set("SHIP1", ["blankOrderedAt", "blankReceivedAt", "manufacturedAt", "qaPackedAt"]);
  await add("GONE1", "rec"); pay("GONE1"); set("GONE1", ["blankOrderedAt", "blankReceivedAt", "manufacturedAt", "qaPackedAt", "shippedAt"]);
  // Not on the tiles: a completed order placed on Jan 1 (in the year, and in the month only in January), last
  // year's order, a voided one and a test.
  await add("JAN1", "prime", {}, yearFrom); pay("JAN1"); set("JAN1", ["blankOrderedAt", "blankReceivedAt", "manufacturedAt", "qaPackedAt", "deliveredAt", "completedAt"]);
  await add("OLD1", "prime", {}, lastYear);
  await add("VOID1", "rec"); d1._raw.run("UPDATE orders SET voidedAt=? WHERE orderId='VOID1'", [at(today)]);
  await add("TEST-1", "prime", { isTest: true });
  // Shipping charged on SHIP1 ($8): business revenue, not product revenue.
  d1._raw.run("UPDATE orders SET shippingCostCents = 800 WHERE orderId = 'SHIP1'");
  // Cost of goods: QA1's lines made today at an estimated $9 a shirt ($18).
  d1._raw.run("UPDATE order_items SET cogsCents = 1800, cogsSource = 'estimate' WHERE orderId = 'QA1'");
  // An expense of $120 today, one of $50 last year; other income of $30 today.
  const cat = d1._raw.exec("SELECT id FROM expense_categories LIMIT 1")[0].values[0][0];
  d1._raw.run("INSERT INTO expenses (expenseDate, description, categoryId, amountCents, createdAt, updatedAt) VALUES (?, 'Thread', ?, 12000, 't', 't'), (?, 'Old', ?, 5000, 't', 't')", [today, cat, lastYear, cat]);
  d1._raw.run("INSERT INTO accounts (name, type, createdAt, updatedAt) VALUES ('Bank', 'checking', 't', 't')");
  const acct = d1._raw.exec("SELECT id FROM accounts LIMIT 1")[0].values[0][0];
  d1._raw.run("INSERT INTO other_income (incomeDate, description, type, amountCents, accountId, createdAt, updatedAt) VALUES (?, 'Repair', 'service', 3000, ?, 't', 't')", [today, acct]);

  console.log("=== getDashboardMoney (db.js) ===");
  const m = await lib.getDashboardMoney(d1, { yearFrom, monthFrom, to: today });
  // This year's real orders: 8 placed today + JAN1 = 9 × $46; this month's: 8 (9 in January).
  const jan = monthFrom === yearFrom;
  console.log("product revenue = goods sold this year, voided / test / last year's left out:", m.year.productRevenue === 9 * 46);
  console.log("…and this month:", m.month.productRevenue === (jan ? 9 : 8) * 46);
  console.log("COGS is the cost of the lines made in the period:", m.year.cogs === 18 && m.month.cogs === 18 && m.year.estimatedCogs === 18);
  console.log("product net income = revenue − COGS:", m.year.productNet === 9 * 46 - 18);
  console.log("business revenue adds shipping charged and other income:", m.year.revenue === 9 * 46 + 8 + 30 && m.year.otherIncome === 30);
  console.log("business expenses = recorded expenses + COGS (last year's expense left out):", m.year.expenses === 120 + 18 && m.year.recordedExpenses === 120);

  console.log("\n=== Expenses by type, for Home's pies (getDashboardMoney byType) ===");
  {
    // c1 is the category the $120 expense above went in; c2 and c3 are two others.
    const c1 = d1._raw.exec("SELECT id, name FROM expense_categories WHERE id = ?", [cat])[0].values[0];
    const [c2, c3] = d1._raw.exec("SELECT id, name FROM expense_categories WHERE id != ? ORDER BY id LIMIT 2", [cat])[0].values;
    // Added for this block only: $40 today in a second category; in a third, $15 spent and a $25 refund today.
    d1._raw.run("INSERT INTO expenses (expenseDate, description, categoryId, amountCents, createdAt, updatedAt) VALUES (?, 'Ink', ?, 4000, 'x', 'x'), (?, 'Tape', ?, 1500, 'x', 'x'), (?, 'Refund', ?, -2500, 'x', 'x')",
      [today, c2[0], today, c3[0], today, c3[0]]);
    const b = await lib.getDashboardMoney(d1, { yearFrom, monthFrom, to: today });
    const names = b.year.byType.map(t => t.name + " " + t.amount).join(", ");
    console.log("one slice per category spent on, largest first, then cost of goods:", names === `${c1[1]} 120, ${c2[1]} 40, Cost of goods 18`);
    console.log("…the same for the month:", b.month.byType.map(t => t.name + " " + t.amount).join(", ") === names);
    console.log("no write-offs slice when there are none:", !b.year.byType.some(t => t.key === "writeoffs"));
    console.log("a category whose refunds outweigh it isn't a slice, and is named instead:", b.year.refundedTypes.length === 1 && b.year.refundedTypes[0] === c3[1]);
    console.log("cost of goods is keyed so it keeps its colour; categories carry their id:", b.year.byType[2].key === "cogs" && b.year.byType[0].id === c1[0]);
    d1._raw.run("DELETE FROM expenses WHERE createdAt = 'x'");
    const a = await lib.getDashboardMoney(d1, { yearFrom, monthFrom, to: today });
    console.log("the slices add up to the Expenses card:", a.year.byType.reduce((t, x) => t + x.amount, 0) === a.year.expenses && a.month.byType.reduce((t, x) => t + x.amount, 0) === a.month.expenses);
  }

  console.log("\n=== getDashboard admin action (orders.js) ===");
  const api = new Function(
    strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" +
    "const requireAdmin = async (env, host) => host.kind === 'admin' ? null : jsonResponse({ status: 'error', message: 'Admin only' }, 403); const adminActor = () => 'test';\n" +
    "const adminUser = () => globalThis.__homeUser || null;\n" +
    "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
    "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
    "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
    dbSrc + "\n" + strip(read("functions/_lib/email.js")) + "\n" + strip(read("functions/_lib/deliveryCheck.js")) + "\n" + strip(read("functions/api/orders.js")) + "\nreturn onRequestPost;")();
  const call = async (body, host = "admin.example.com") => {
    const x = await api({ env: { DB: d1 }, waitUntil: () => {}, request: { url: `https://${host}/api/orders`, json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: x.status, body: JSON.parse(await x.text()) };
  };
  let r = await call({ action: "getDashboard", today, fresh: true });
  console.log("returns the step counts and the year (from Jan 1) and month (from the 1st):", r.status === 200 && r.body.yearFrom === yearFrom && r.body.monthFrom === monthFrom
    && r.body.year.productRevenue === 9 * 46 && r.body.stages.new === 3 && r.body.open === 9 && r.body.onTheWay === 1 && r.body.cached === false);
  r = await call({ action: "getDashboard", today: "soon" });
  console.log("a bad date is refused:", r.status === 400);
  r = await call({ action: "getDashboard", today }, "league101.example.com");
  console.log("refused away from the admin subdomain:", r.status >= 400 && !r.body.year);
  r = await call({ action: "getOpenOrders" });
  console.log("getOpenOrders gives each order the step it's waiting on:", r.body.orders.find(o => o.orderId === "QA1").homeStage === "qa" && r.body.orders.find(o => o.orderId === "GONE1").homeStage === "");

  console.log("\n=== The money is a manager's (getDashboard as staff) ===");
  globalThis.__homeUser = { role: "staff" };
  r = await call({ action: "getDashboard", today });
  console.log("staff get the step counts and when they were worked out, and no money at all:", r.status === 200 && r.body.stages.new === 3 && r.body.open === 9 && r.body.onTheWay === 1 && !!r.body.cachedAt
    && ["year", "month", "saleDate", "yearFrom", "monthFrom", "bookkeeping"].every(k => !(k in r.body)) && !/productRevenue|expenses|cogs/.test(JSON.stringify(r.body)));
  globalThis.__homeUser = { role: "manager" };
  r = await call({ action: "getDashboard", today });
  console.log("a manager gets the money, from the same kept answer:", r.status === 200 && r.body.cached === true && r.body.year.productRevenue === 9 * 46);
  globalThis.__homeUser = null;

  console.log("\n=== Bookkeeping off (getDashboardMoney) ===");
  await lib.getDashboard(d1, { today, fresh: true });
  await lib.setFeatures(d1, { bookkeeping: false });
  console.log("saving the features drops Home's kept figures, so the switch shows at once:", d1._raw.exec("SELECT count(*) FROM global_settings WHERE key = 'dashboardCache'")[0].values[0][0] === 0);
  const off = await lib.getDashboardMoney(d1, { yearFrom, monthFrom, to: today });
  console.log("recorded expenses and other income (Bookkeeping's pages) are left out; COGS stays:", off.bookkeeping === false && off.year.recordedExpenses === 0 && off.year.otherIncome === 0
    && off.year.expenses === 18 && off.year.cogs === 18 && off.year.revenue === 9 * 46 + 8 && off.year.productRevenue === 9 * 46);
  console.log("…and the pies are just cost of goods (no categories):", off.year.byType.length === 1 && off.year.byType[0].key === "cogs" && off.year.byType[0].amount === 18);
  await lib.setFeatures(d1, { bookkeeping: true });
  console.log("…and on again they're back:", (await lib.getDashboardMoney(d1, { yearFrom, monthFrom, to: today })).bookkeeping === true);

  console.log("\n=== Kept for an hour (getDashboard) ===");
  const t0 = Date.now();
  const first = await lib.getDashboard(d1, { today, fresh: true, now: t0 });
  await add("LATE1", "prime");   // a new order after the figures were worked out
  const again = await lib.getDashboard(d1, { today, now: t0 + 59 * 60 * 1000 });
  console.log("within the hour the kept answer comes back (the new order isn't counted yet):", again.cached === true && again.stages.new === first.stages.new && again.cachedAt === first.cachedAt);
  const later = await lib.getDashboard(d1, { today, now: t0 + lib.DASHBOARD_TTL_MS });
  console.log("after an hour it's worked out again:", later.cached === false && later.stages.new === first.stages.new + 1);
  const refreshed = await lib.getDashboard(d1, { today, fresh: true, now: t0 + lib.DASHBOARD_TTL_MS + 1000 });
  console.log("Refresh (fresh) works it out again straight away:", refreshed.cached === false);
  const nextDay = await lib.getDashboard(d1, { today: "2099-01-01", now: t0 + lib.DASHBOARD_TTL_MS + 2000 });
  console.log("a different day isn't answered from the kept figures:", nextDay.cached === false && nextDay.monthFrom === "2099-01-01");
  d1._raw.run("DELETE FROM order_items WHERE orderId = 'LATE1'"); d1._raw.run("DELETE FROM orders WHERE orderId = 'LATE1'");
  await lib.getDashboard(d1, { today, fresh: true });

  console.log("\n=== Home page (jsdom) ===");
  const adminJs = read("public/admin.js");
  class L extends ResourceLoader { fetch(url, o){ if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const dom = new JSDOM(read("public/index.html"), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win){ win.fetch = async (u, init) => { const b = init && typeof init.body === "string" ? JSON.parse(init.body) : {}; const x = await call(b);
      return { ok: x.status < 400, status: x.status, json: async () => x.body, text: async () => JSON.stringify(x.body) }; }; } });
  const w = dom.window;
  await new Promise(x => setTimeout(x, 150));
  await w.loadAdminScript();
  w.eval('adminKey = "cookie"; adminOrgs = [{ orgId: "prime", name: "Example League" }, { orgId: "rec", name: "REC" }];');
  const wait = async (fn, n = 300) => { for (let i = 0; i < n && !fn(); i++) await new Promise(x => setTimeout(x, 10)); return fn(); };
  const route = async (hash) => { w.history.replaceState(null, "", hash); await w.adminRoute(); };
  const tile = (k) => w.document.querySelector(`.home-tile[data-stage="${k}"]`);

  await route("#");
  await wait(() => tile("new") && tile("new").querySelector(".home-num").textContent !== "…" && w.document.querySelector(".home-table"));
  console.log("the admin's home address opens Home, with Home lit in the menu:", w.location.hash === "#home" && !!w.document.querySelector('.admin-nav-row .admin-nav-btn.active') && w.document.querySelector('.admin-nav-row .admin-nav-btn.active').textContent === "Home");
  const counts = ["new", "paid", "blanks", "run", "qa", "ship"].map(k => tile(k).querySelector(".home-num").textContent).join(",");
  console.log("one tile per step, each order counted once at its first unfinished step (last year's unpaid order is still New):", counts === "3,1,1,1,1,1");
  console.log("shipped orders aren't on a tile, but are mentioned:", /9 open orders · 1 shipped and on the way/.test(w.document.getElementById("homeStagesNote").textContent));
  console.log("each tile links to its list:", tile("run").getAttribute("href") === "#home/run");
  const cards = [...w.document.querySelectorAll(".home-card .home-val")].map(e => e.textContent);
  console.log("business totals: revenue and expenses, year and month:", cards.length === 4 && cards[0] === "$" + (9 * 46 + 38) && cards[1] === "$138");
  const pies = [...w.document.querySelectorAll(".home-pie")];
  const legend = (pie) => [...pie.querySelectorAll(".home-legend tr")].map(tr => [...tr.cells].map(c => c.textContent).join("|"));
  const cat1 = d1._raw.exec("SELECT name FROM expense_categories WHERE id = ?", [cat])[0].values[0][0];
  console.log("Where the money went: a pie for the year and one for the month, between the totals and product sales:", pies.length === 2
    && /Year to date/.test(pies[0].textContent) && /Month to date/.test(pies[1].textContent)
    && w.document.querySelector(".home-tiles-4").compareDocumentPosition(pies[0]) & 4 && pies[1].compareDocumentPosition(w.document.querySelector(".home-table")) & 4);
  console.log("…each with a legend by type: amount and share:", legend(pies[0]).join(",") === `${cat1}|$120|87%,Cost of goods|$18|13%`);
  console.log("…a slice per type with its amount on hover, and the total in the middle:", pies[0].querySelectorAll("svg circle").length === 2
    && pies[0].querySelector("svg circle title").textContent === `${cat1} $120 (87%)` && pies[0].querySelector(".home-pie-total").textContent === "$138");
  console.log("…cost of goods is always green:", [...pies[0].querySelectorAll(".home-swatch")][1].getAttribute("style").includes("#008300"));
  const tRows = [...w.document.querySelectorAll(".home-table tbody tr")].map(tr => [...tr.cells].map(c => c.textContent));
  console.log("product sales: revenue, COGS, net income and margin for the year and the month:",
    tRows.length === 2 && tRows[0][0] === "Year to date" && tRows[0][1] === "$414" && tRows[0][2] === "$18" && tRows[0][3] === "$396" && tRows[0][4] === "96%");

  const updText = () => w.document.getElementById("homeUpdated").textContent;
  console.log("Home has a Refresh data button and says when the data was last updated:",
    w.document.getElementById("homeRefresh").tagName === "BUTTON" && /Refresh data/.test(w.document.getElementById("homeRefresh").textContent) && /^Data last updated \S/.test(updText()));
  // A new order after the figures were kept: the page shows the kept count until Refresh data.
  await add("LATE2", "rec");
  await route("#home");
  await wait(() => /^Data last updated/.test(updText()));
  console.log("opening Home again within the hour shows the kept figures (the new order isn't counted):", tile("new").querySelector(".home-num").textContent === "3");
  const reloads = []; w.addEventListener("beforeunload", () => reloads.push(1));
  w.document.getElementById("homeRefresh").click();
  console.log("Refresh data shows it's working (button busy):", w.document.getElementById("homeRefresh").disabled && /Refreshing/.test(w.document.getElementById("homeRefresh").textContent));
  await wait(() => tile("new").querySelector(".home-num").textContent === "4" && /^Data last updated/.test(updText()));
  console.log("…asks the server to work the figures out again and redraws them, without reloading the page:",
    tile("new").querySelector(".home-num").textContent === "4" && !reloads.length && !w.document.getElementById("homeRefresh").disabled && /^Data last updated/.test(updText()));
  d1._raw.run("DELETE FROM order_items WHERE orderId = 'LATE2'"); d1._raw.run("DELETE FROM orders WHERE orderId = 'LATE2'");
  await lib.getDashboard(d1, { today, fresh: true });

  // Bookkeeping off: the expenses cards say what they add up.
  await lib.setFeatures(d1, { bookkeeping: false }); w.eval("siteFeatures.bookkeeping = false;");
  await route("#home");
  await wait(() => w.document.querySelector(".home-table"));
  const hints = [...w.document.querySelectorAll(".home-card .home-hint")].map(e => e.textContent);
  console.log("bookkeeping off: the expenses cards are the cost of goods, and say so:", [...w.document.querySelectorAll(".home-card .home-val")].map(e => e.textContent)[1] === "$18"
    && hints[1] === "Cost of goods — bookkeeping is off" && hints[3] === "Cost of goods — bookkeeping is off" && !w.document.querySelector('#homeMoney a[href="#expenses"]'));
  await lib.setFeatures(d1, { bookkeeping: true }); w.eval("delete siteFeatures.bookkeeping;");
  // Staff: the order tiles, and no money anywhere on the page or in its menus.
  globalThis.__homeUser = { role: "staff" }; w.eval((asRole("staff", { name: "Sam" })));
  await route("#home");
  await wait(() => tile("new") && tile("new").querySelector(".home-num").textContent !== "…");
  const navText = (w.document.querySelector(".admin-nav-row") || {}).textContent || "";
  console.log("staff see the step tiles but no business totals or product sales:", tile("new").querySelector(".home-num").textContent === "3" && !w.document.getElementById("homeMoney") && !w.document.querySelector(".home-card"));
  console.log("…and no Revenue, Sales tax, Inventory & COGS or Expenses in the menus:", !/Revenue report|Sales tax report|Inventory & COGS|Expenses/.test(w.document.body.innerHTML.match(/admin-nav[\s\S]*?<\/nav>|$/)[0] + navText));
  await route("#revenue");
  console.log("…and opening the Revenue report says it isn't in their role instead of loading it:", !w.document.getElementById("revFrom") && /Not available to you/.test(w.document.getElementById("app").textContent) && /Back office/.test(w.document.getElementById("app").textContent));
  globalThis.__homeUser = null; w.eval(asRole(null));

  await route("#home/new");
  await wait(() => w.document.querySelector("#homeStageBody tr[data-order]"));
  const listed = [...w.document.querySelectorAll("#homeStageBody tr[data-order]")].map(tr => tr.dataset.order).sort().join(",");
  console.log("a tile's list shows just those orders, from every shop:", listed === "NEW1,NEW2,OLD1" && /\(3\)/.test(w.document.getElementById("homeStageCount").textContent));
  await route("#home/qa");
  await wait(() => w.document.querySelector("#homeStageBody tr[data-order]"));
  console.log("Ready to QA lists QA1:", [...w.document.querySelectorAll("#homeStageBody tr[data-order]")].map(tr => tr.dataset.order).join(",") === "QA1");
  await route("#home/nonsense");
  console.log("an unknown step goes back to Home:", w.location.hash === "#home");
  await route("#orders");
  await wait(() => w.document.getElementById("ordFilterOrg"));
  console.log("Orders is still one click away and opens on the first shop:", w.location.hash === "#orders/prime");

  console.log("\n=== Which step an order is waiting on (db.js homeOrderStage) ===");
  const st = (o) => lib.homeOrderStage(o);
  console.log("paid for the work (all but a rush fee) counts as paid:", st({ paid: false, paidForWork: true }) === "paid");
  console.log("nothing needs a blank: paid goes straight to Ready to run:", st({ paid: true, needsBlanks: false }) === "run");
  console.log("downloads only: paid is ready to deliver:", st({ paid: true, digitalOnly: true }) === "ship");
  console.log("delivered (not shipped) is off the tiles:", st({ paid: true, blankOrderedAt: "x", blankReceivedAt: "x", manufacturedAt: "x", qaPackedAt: "x", deliveredAt: "x" }) === "");
})().catch(e => { console.log("test192 crashed:", false); console.error(e); process.exit(1); });
