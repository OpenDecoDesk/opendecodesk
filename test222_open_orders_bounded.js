const fs = require("fs");
const { storefrontPage } = require("./testlib/storefront-page");
const { createD1 } = require("./testlib/d1-shim.js");
const { JSDOM, ResourceLoader } = require("jsdom");

// Open orders as they pile up (2026-11). Nothing closes an order on its own, so the open set only grows while
// orders are left open; what's loaded is bounded instead:
//   - Home's step counts come from the orders' own columns (getOpenOrderStages), no order loaded in full
//   - getOpenOrders takes a step (only that step's orders are loaded) and returns at most OPEN_ORDERS_MAX, the
//     oldest, with `count` and `more`
//   - opening an order from Home widens the Orders date range back to the day it was placed, and says so when the
//     order still can't be shown
// Real SQL (sql.js) + real db.js, orders.js and admin.js (jsdom). Invented shops and customers only.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + "\nreturn { insertOrder, createProduct, getOpenOrders, getOpenOrderStages, homeOrderStage, getDashboard };")();
const ordersSrc = strip(read("functions/api/orders.js"));
if (!ordersSrc.includes("const OPEN_ORDERS_MAX = 1000;")) throw new Error("OPEN_ORDERS_MAX not found in orders.js");
const makeApi = (src) => new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  "const requireAdmin = async () => null; const adminActor = () => 'owner@test'; const adminUser = () => null;\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  dbSrc + "\n" + src + "\nreturn onRequestPost;")();
const api = makeApi(ordersSrc), apiSmall = makeApi(ordersSrc.replace("const OPEN_ORDERS_MAX = 1000;", "const OPEN_ORDERS_MAX = 2;"));
let failed = 0;
const ok = (label, cond) => { if (!cond) failed++; console.log(label + ": " + !!cond); };
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Example Club','t','t'), ('rec','rec','Rec League','t','t');`);
  await lib.createProduct(d1, "acme", { productId: "cap", type: "cap", name: "Cap", pricingMode: "flat", flatPrice: 20, visible: true });
  await lib.createProduct(d1, "acme", { productId: "sticker", type: "other", name: "Sticker", pricingMode: "flat", flatPrice: 5, visible: true });
  await lib.createProduct(d1, "acme", { productId: "file", type: "other", name: "Pattern file", pricingMode: "flat", flatPrice: 9, visible: true });
  d1._raw.run("UPDATE products SET noBlankNeeded = 1 WHERE productId = 'sticker'");
  d1._raw.run("UPDATE products SET digital = 1 WHERE productId = 'file'");

  const add = (id, org, days, product = "cap") => lib.insertOrder(d1, { orderId: id, orgId: org, customerName: "Customer " + id, contact: id.toLowerCase() + "@example.com", placedAt: daysAgo(days) },
    [{ productId: product, name: product, type: "cap", size: "OSFA", qty: 1, unitPrice: 20 }]);
  const set = (id, cols) => d1._raw.run(`UPDATE orders SET paid = 1, ${cols.map(c => c + " = ?").join(", ")} WHERE orderId = ?`, [...cols.map(() => daysAgo(1)), id]);
  await add("NEW1", "acme", 60);
  await add("PAID1", "acme", 50); set("PAID1", ["paidAt"]);
  await add("BLK1", "rec", 45); set("BLK1", ["blankOrderedAt"]);
  await add("RUN1", "acme", 40); set("RUN1", ["blankOrderedAt", "blankReceivedAt"]);
  await add("QA1", "acme", 35); set("QA1", ["blankOrderedAt", "blankReceivedAt", "manufacturedAt"]);
  await add("QA2", "rec", 30); set("QA2", ["blankOrderedAt", "blankReceivedAt", "manufacturedAt"]);
  await add("QA3", "acme", 25); set("QA3", ["blankOrderedAt", "blankReceivedAt", "manufacturedAt"]);
  await add("SHIP1", "acme", 20); set("SHIP1", ["blankOrderedAt", "blankReceivedAt", "manufacturedAt", "qaPackedAt"]);
  await add("GONE1", "rec", 15); set("GONE1", ["blankOrderedAt", "blankReceivedAt", "manufacturedAt", "qaPackedAt", "shippedAt"]);
  await add("NOBLANK1", "acme", 12, "sticker"); set("NOBLANK1", ["paidAt"]);
  await add("DIGI1", "acme", 10, "file"); set("DIGI1", ["paidAt"]);
  await add("DONE1", "acme", 70); set("DONE1", ["blankOrderedAt", "blankReceivedAt", "manufacturedAt", "qaPackedAt", "deliveredAt", "completedAt"]);

  console.log("=== Home's steps from the orders' own columns ===");
  const full = await lib.getOpenOrders(d1), light = await lib.getOpenOrderStages(d1);
  ok("the same open orders, oldest first", light.map(s => s.orderId).join(",") === full.map(o => o.orderId).join(",") && !light.some(s => s.orderId === "DONE1"));
  ok("each one's step is the one the full order gives (blank-free and download-only orders too)",
    light.every((s, i) => s.stage === lib.homeOrderStage(full[i])) && light.find(s => s.orderId === "NOBLANK1").stage === "run" && light.find(s => s.orderId === "DIGI1").stage === "ship");
  const dash = await lib.getDashboard(d1, { today: daysAgo(0).slice(0, 10), blocks: ["orders"], fresh: true });
  ok("Home's tiles count them", dash.open === 11 && dash.stages.new === 1 && dash.stages.qa === 3 && dash.stages.run === 2 && dash.stages.ship === 2 && dash.onTheWay === 1);
  ok("getOpenOrders takes a limit: the oldest that many", (await lib.getOpenOrders(d1, { limit: 2 })).map(o => o.orderId).join(",") === "NEW1,PAID1");

  console.log("\n=== getOpenOrders: one step, a limit ===");
  const call = async (fn, body) => {
    const res = await fn({ env: { DB: d1 }, waitUntil: () => {}, request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  let r = await call(api, { action: "getOpenOrders", stage: "qa" });
  ok("a step gives only its orders, in full, oldest first, with the count", r.status === 200 && r.body.orders.map(o => o.orderId).join(",") === "QA1,QA2,QA3" &&
    r.body.orders.every(o => o.homeStage === "qa" && Array.isArray(o.items) && o.orgName) && r.body.count === 3 && r.body.more === false);
  r = await call(api, { action: "getOpenOrders", stage: "" });
  ok("the empty step is the shipped ones waiting to be closed out", r.body.orders.map(o => o.orderId).join(",") === "GONE1");
  ok("an unknown step is refused", (await call(api, { action: "getOpenOrders", stage: "bogus" })).status === 400);
  r = await call(apiSmall, { action: "getOpenOrders", stage: "qa" });
  ok("past the limit: the oldest that many, the full count, and more", r.body.orders.map(o => o.orderId).join(",") === "QA1,QA2" && r.body.count === 3 && r.body.more === true && r.body.max === 2);
  r = await call(apiSmall, { action: "getOpenOrders" });
  ok("no step: every open order up to the limit, the oldest, and more", r.body.orders.map(o => o.orderId).join(",") === "NEW1,PAID1" && r.body.more === true);
  r = await call(api, { action: "getOpenOrders" });
  ok("…under the limit, all of them and more is false", r.body.orders.length === 11 && r.body.more === false);

  console.log("\n=== Opening an old order from Home (jsdom) ===");
  const adminJs = read("public/admin.js");
  ok("the Home step list asks the server for its step", /hoopApi_\(\{ action: "getOpenOrders", stage: key \}\)/.test(adminJs));
  class L extends ResourceLoader { fetch(url, o) { if (url.includes("/admin.js")) return Promise.resolve(Buffer.from(adminJs)); return super.fetch(url, o); } }
  const dom = new JSDOM(storefrontPage(), { runScripts: "dangerously", resources: new L(), url: "https://admin.example.com/", pretendToBeVisual: true,
    beforeParse(win) { win.fetch = async (u, init) => { const b = init && typeof init.body === "string" ? JSON.parse(init.body) : {}; const x = await call(api, b);
      return { ok: x.status < 400, status: x.status, json: async () => x.body, text: async () => JSON.stringify(x.body) }; }; } });
  const w = dom.window;
  w.CSS = { escape: (x) => String(x).replace(/[^a-zA-Z0-9_-]/g, "\\$&") };
  await new Promise(x => setTimeout(x, 150));
  await w.loadAdminScript();
  w.eval('adminKey = "cookie"; adminOrgs = [{ orgId: "acme", name: "Example Club" }, { orgId: "rec", name: "Rec League" }];');
  const toasts = []; w.showToast = (m, bad) => toasts.push({ m, bad: !!bad });
  const f0 = Object.assign({}, w._ordersFilter);
  ok("the Orders list starts on the last 30 days", !!f0.from && !!f0.to && f0.from > daysAgo(32).slice(0, 10));
  const row = (id) => w.document.querySelector(`#adminPanel tr[data-order="${id}"]`);
  await w.openOrderFromDashboard_("acme", "NEW1", full.find(o => o.orderId === "NEW1").placedAt);
  ok("opening a 60-day-old order widens the range back to its day, and its row is there", !!row("NEW1") && w._ordersFilter.from <= daysAgo(59).slice(0, 10) && w._ordersFilter.to === f0.to);
  ok("…the date box shows the new start", w.document.getElementById("ordFilterFrom").value === w._ordersFilter.from && !toasts.some(t => t.bad));
  await w.openOrderFromDashboard_("acme", "DONE1");
  ok("an order the list hides (completed, no date to go on) gets a message saying what hides it", !row("DONE1") && toasts.some(t => t.bad && /DONE1 isn't in this list/.test(t.m) && /Include completed/.test(t.m)));

  if (failed) { console.log("\n" + failed + " check(s) failed"); process.exit(1); }
})().catch((e) => { console.error(e); console.log("test222 crashed: false"); process.exit(1); });
