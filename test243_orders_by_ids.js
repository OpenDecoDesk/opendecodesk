const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// getOrdersByIds (review #62): the Orders page asks for just the orders an action changed and redraws their rows,
// instead of reloading the whole list. The server answers with:
//   - only the orders asked for, and only the asked-for shop's — an id of another shop's order is left out
//   - at most ORDERS_BY_IDS_MAX ids a request, each a valid order id
//   - the same cost hiding as getOrders: a role without costs.view gets no line cost of goods or processor fees
//   - the same permission as getOrders (orders.details read)
// setRushFee's reply (the order the page redraws its row from) hides costs the same way.
// Real SQL (sql.js) + real db.js, permissions.js and orders.js; the role gate as adminAuth.js runs it. Invented data only.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const ordersSrc = strip(read("functions/api/orders.js"));
const maxMatch = ordersSrc.match(/const ORDERS_BY_IDS_MAX = (\d+);/);
if (!maxMatch) throw new Error("ORDERS_BY_IDS_MAX not found in orders.js");
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  strip(read("functions/_lib/permissions.js")) + "\n" +
  "const __as = { role: null };\n" +
  "const requireAdmin = async (env, host, key, request, msg, need) => !__as.role || roleAllows(__as.role, need) ? null : new Response(JSON.stringify({ status: 'error', code: 'forbidden', message: 'Your role can\\'t do this.' }), { status: 403 });\n" +
  "const adminActor = () => 'pat@example.test';\n" +
  "const adminUser = () => __as.role ? { id: 7, role: __as.role.key, roleInfo: __as.role } : null;\n" +
  "const adminCan = (request, fn, level) => !__as.role || permRank(effectiveLevel(__as.role, fn)) >= permRank(level || 'read');\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  dbSrc + "\n" + ordersSrc +
  "\nreturn { post: onRequestPost, as: __as, ACTION_PERM, normalizePermissions, insertOrder };")();

let failed = 0, passed = 0;
const ok = (label, cond) => { cond ? passed++ : failed++; console.log(label + ": " + !!cond); };
const role = (key, fns) => ({ key, name: key, rank: 10, locked: false, builtIn: false, permissions: api.normalizePermissions({ fns }) });

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const env = { DB: d1, ROOT_DOMAIN: "example.com" };
  const call = async (body, as = null) => {
    api.as.role = as;
    const full = Object.assign({ key: "x" }, body);
    const req = { url: "https://admin.example.com/api/orders", json: async () => full, clone: () => ({ json: async () => full }), headers: { get: () => null } };
    const res = await api.post({ env, waitUntil: () => {}, request: req });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Example Club','t','t'), ('rec','rec','Rec League','t','t');`);
  const placed = new Date(Date.now() - 86400000).toISOString();
  for (const [id, org] of [["A1", "acme"], ["A2", "acme"], ["A3", "acme"], ["R1", "rec"]]) {
    await api.insertOrder(d1, { orderId: id, orgId: org, customerName: "Customer " + id, contact: id.toLowerCase() + "@example.com", placedAt: placed },
      [{ productId: "cap", name: "Cap", type: "cap", size: "OSFA", qty: 1, unitPrice: 20 }]);
  }
  d1._raw.run("UPDATE order_items SET cogsCents = 450, cogsSource = 'consumed'");

  console.log("=== Only the orders asked for, of that shop ===");
  let r = await call({ action: "getOrdersByIds", org: "acme", orderIds: ["A1", "A3"] });
  const ids = (x) => (x.body.orders || []).map(o => o.orderId).sort().join(",");
  ok("A1 and A3 come back, in full (lines, payments, labels), and not A2", r.status === 200 && ids(r) === "A1,A3" &&
    r.body.orders.every(o => o.orgId === "acme" && o.items.length === 1 && Array.isArray(o.payments) && Array.isArray(o.labels) && "balanceDue" in o));
  r = await call({ action: "getOrdersByIds", org: "acme", orderIds: ["A1", "R1"] });
  ok("another shop's order is never returned, even when its id is asked for", r.status === 200 && ids(r) === "A1");
  r = await call({ action: "getOrdersByIds", org: "rec", orderIds: ["A1", "A2"] });
  ok("…and asking for one shop's orders under another shop returns none", r.status === 200 && r.body.orders.length === 0);
  r = await call({ action: "getOrdersByIds", org: "acme", orderIds: ["A2", "A2", "NOPE"] });
  ok("an id asked twice comes once; an unknown id is left out", r.status === 200 && ids(r) === "A2");

  console.log("\n=== The ids are checked, and capped ===");
  const max = Number(maxMatch[1]);
  r = await call({ action: "getOrdersByIds", org: "acme", orderIds: Array.from({ length: max }, (_, i) => i === 0 ? "A1" : "X" + i) });
  ok(`${max} ids (the most one request takes) are answered`, r.status === 200 && ids(r) === "A1" && r.body.max === max);
  r = await call({ action: "getOrdersByIds", org: "acme", orderIds: Array.from({ length: max + 1 }, (_, i) => "X" + i) });
  ok(`${max + 1} ids are refused, saying the limit`, r.status === 400 && new RegExp("max " + max).test(r.body.message) && !r.body.orders);
  r = await call({ action: "getOrdersByIds", org: "acme", orderIds: ["A1", "bad id'"] });
  ok("an id that isn't an order id is refused", r.status === 400 && /Invalid order ID/.test(r.body.message));
  r = await call({ action: "getOrdersByIds", org: "acme", orderIds: ["A1", 7] });
  ok("…so is one that isn't text", r.status === 400);
  r = await call({ action: "getOrdersByIds", org: "acme", orderIds: [] });
  ok("no ids is refused", r.status === 400);
  r = await call({ action: "getOrdersByIds", org: "acme", orderIds: "A1" });
  ok("…as is a list that isn't a list", r.status === 400);
  r = await call({ action: "getOrdersByIds", orderIds: ["A1"] });
  ok("no shop is refused (Unknown org)", r.status === 404 && !r.body.orders);

  console.log("\n=== Costs and permission, as getOrders ===");
  const looks = role("orderLooks", { "orders.details": "read" });
  const looksWithCosts = role("orderLooksWithCosts", { "orders.details": "read", "costs.view": "read" });
  const elsewhere = role("blanksOnly", { "inventory.blanks": "edit" });
  ok("the action needs what getOrders needs", JSON.stringify(api.ACTION_PERM.getOrdersByIds) === JSON.stringify(api.ACTION_PERM.getOrders));
  r = await call({ action: "getOrdersByIds", org: "acme", orderIds: ["A1"] }, looks);
  const line = r.body.orders && r.body.orders[0] && r.body.orders[0].items[0];
  ok("a role without costs.view gets the order without its lines' cost of goods or the processor fees", r.status === 200 && line && !("cogs" in line) && !("cogsSource" in line) &&
    !("processorFees" in r.body.orders[0]) && line.lineTotal === 20);
  const plain = await call({ action: "getOrders", org: "acme" }, looks);
  const sameAsList = plain.body.orders.find(o => o.orderId === "A1");
  ok("…exactly as getOrders gives it to that role", JSON.stringify(sameAsList) === JSON.stringify(r.body.orders[0]));
  r = await call({ action: "getOrdersByIds", org: "acme", orderIds: ["A1"] }, looksWithCosts);
  ok("a role with costs.view sees them", r.status === 200 && r.body.orders[0].items[0].cogs === 4.5 && "processorFees" in r.body.orders[0]);
  r = await call({ action: "getOrdersByIds", org: "acme", orderIds: ["A1"] }, elsewhere);
  ok("a role that can't see orders is refused", r.status === 403 && !r.body.orders);

  console.log("\n=== setRushFee answers with the order, costs hidden the same way ===");
  const rushPerm = api.ACTION_PERM.setRushFee;
  ok("(the role can set a rush fee)", Array.isArray(rushPerm));
  const rushAs = role("rushAll", Object.fromEntries(rushPerm.map(([fn, lvl]) => [fn, lvl])));
  r = await call({ action: "setRushFee", org: "acme", orderId: "A2", requested: true, pending: false, amount: 15 }, rushAs);
  const ro = r.body.order;
  ok("the reply has the order with its fee, without the line costs for a role without costs.view", r.status === 200 && ro && ro.orderId === "A2" && ro.rushFee === 15 &&
    !("cogs" in ro.items[0]) && !("processorFees" in ro));
  r = await call({ action: "setRushFee", org: "acme", orderId: "A2", requested: true, pending: false, amount: 15 });
  ok("…and with them for the owner", r.status === 200 && r.body.order.items[0].cogs === 4.5);

  console.log(`\n${failed ? "FAIL" : "PASS"} — ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch(e => { console.error(e); console.log("test243 crashed: false"); process.exit(1); });
