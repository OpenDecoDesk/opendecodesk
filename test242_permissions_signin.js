const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { makeAuth, request, answer } = require("./testlib/auth-harness");

// Permissions and sign-in follow-ups to the 2026-11-21 review (items left partly done):
//   #22 costs.view: a role that can only LOOK at products, blank stock, finished stock, transfers or the audit log
//       (and has no costs.view) gets them without what things cost; whoever edits there still sees them
//   #11 the installer's passphrase is never an API key: it opens a new install only through the sign-in page,
//       which makes a session that must first set up the account
//   #1  failed sign-ins are counted per account too; once the site-wide budget (or one account's) is spent, a
//       Turnstile check is asked for instead of refusing everyone — an address that signed in here in the last 30
//       days needs none, and a site without Turnstile keys refuses as before
//   #30/#31 stock counts, average cost, merging blanks and removing a product's blank link are Full's
//   #51 every action that can change something is either in the closed-month rules or on the "no month" list
// Real SQL (sql.js) + real db.js, permissions.js and orders.js; the real sign-in code (testlib/auth-harness.js) with
// the real rate limiter. Invented data only.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
// The gate as adminAuth.js runs it, for the role this test is acting as (__as.role; null = everything).
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
  "const sendShippingPaymentEmail = async () => true; const sendCancellationEmail = async () => true;\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) +
  "\nreturn { post: onRequestPost, as: __as, NO_MONTH_ACTIONS, ACTION_PERM, normalizePermissions };")();

let failed = 0, passed = 0;
const ok = (label, cond) => { cond ? passed++ : failed++; console.log(label + ": " + !!cond); };

async function migratedDb() {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  return d1;
}
// A role of the owner's own making (Users → Roles and permissions): these functions, nothing else.
const role = (key, fns) => ({ key, name: key, rank: 10, locked: false, builtIn: false, permissions: api.normalizePermissions({ fns }) });

(async () => {
  const d1 = await migratedDb();
  const env = { DB: d1, ROOT_DOMAIN: "example.com" };
  const call = async (body, as = null) => {
    api.as.role = as;
    const full = Object.assign({ key: "x" }, body);
    const req = { url: "https://admin.example.com/api/orders", json: async () => full, clone: () => ({ json: async () => full }), headers: { get: () => null } };
    const res = await api.post({ env, waitUntil: () => {}, request: req });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const t = "2026-11-02T15:00:00.000Z";
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Example Club','${t}','${t}');
    INSERT INTO products (productId, orgId, type, name, pricingMode, flatPriceCents, createdAt, updatedAt, transferCostCents, suppliesCostCents)
      VALUES ('tee','acme','Tee','Club tee','flat',2000,'${t}','${t}',350,125);
    INSERT INTO inventory (productType, brand, color, size, purchasePrice, quantity, createdAt, updatedAt) VALUES ('Tee','Sample Brand','Navy','M',4.25,12,'${t}','${t}');
    INSERT INTO ready_to_ship (orgId, productId, size, quantity, updatedAt, avgCostCents) VALUES ('acme','tee','',5,'${t}',640);
    INSERT INTO finished_goods_movements (orgId, productId, size, qtyDelta, unitCostCents, kind, occurredAt, createdAt) VALUES ('acme','tee','',5,640,'adjust','${t}','${t}');
    INSERT INTO transfers (name, quantity, purchasePriceCents, createdAt, updatedAt) VALUES ('Crest transfer', 30, 180, '${t}', '${t}');
    INSERT INTO transfer_movements (transferId, transferName, qtyDelta, unitCostCents, kind, occurredAt, createdAt) VALUES (1, 'Crest transfer', 30, 180, 'purchase', '${t}', '${t}');
    INSERT INTO audit_log (createdAt, action, detail, actor) VALUES
      ('${t}', 'settings.pricing_set', '{"targetMarginPct":55}', 'pat@example.test'),
      ('${t}', 'settings.shop_rate_set', '{"ratePerHourCents":6500}', 'pat@example.test'),
      ('${t}', 'payment.added', '{"amount":20}', 'pat@example.test'),
      ('${t}', 'expense.created', '{"amount":75}', 'pat@example.test'),
      ('${t}', 'recurring_expense.created', '{"amount":30}', 'pat@example.test'),
      ('${t}', 'product.updated', '{"name":"Club tee"}', 'pat@example.test');`);

  const looks = role("looks", { "catalog.products": "read", "inventory.blanks": "read", "inventory.transfers": "read", "reports.audit": "read" });
  const edits = role("edits", { "catalog.products": "edit", "inventory.blanks": "edit", "inventory.transfers": "edit", "reports.audit": "read" });
  const looksWithCosts = role("looksWithCosts", { "catalog.products": "read", "inventory.blanks": "read", "inventory.transfers": "read", "reports.audit": "read", "costs.view": "read" });
  const has = (v, re) => re.test(JSON.stringify(v));
  const COSTS = /"(transferCost|suppliesCost|purchasePrice|avgCost|value|unitCost|cost)(Cents)?":/;

  console.log("=== #22 What a role without costs.view sees ===");
  const reads = async (as) => ({
    products: (await call({ action: "listProducts", org: "acme" }, as)).body.products,
    inventory: (await call({ action: "getInventory" }, as)).body.items,
    ready: (await call({ action: "getReadyToShip", org: "acme", productId: "tee" }, as)).body,
    finished: (await call({ action: "getFinishedGoodsMovements", org: "acme", productId: "tee" }, as)).body.movements,
    transfers: (await call({ action: "listTransfers" }, as)).body.transfers,
    transferMoves: (await call({ action: "getTransferMovements", transferId: 1 }, as)).body.movements,
    audit: (await call({ action: "getAuditLog", limit: 50 }, as)).body.entries,
  });
  const L = await reads(looks), E = await reads(edits), C = await reads(looksWithCosts), A = await reads(null);
  ok("the products list leaves out the transfer and supplies cost", L.products.length === 1 && L.products[0].name === "Club tee" && !has(L.products, /"(transferCost|suppliesCost)(Cents)?":/));
  ok("…blank stock its purchase price", L.inventory.length === 1 && L.inventory[0].quantity === 12 && !has(L.inventory, /"purchasePrice/));
  ok("…finished stock its average cost and value (on hand still there)", L.ready.finished && L.ready.finished.sizes[0].onHand === 5 && !has(L.ready, COSTS));
  ok("…finished-stock history its unit cost", L.finished.length === 1 && L.finished[0].qtyDelta === 5 && !has(L.finished, COSTS));
  ok("…transfers their purchase price, and their history the unit cost", L.transfers[0].quantity === 30 && !has(L.transfers, COSTS) && L.transferMoves[0].qtyDelta === 30 && !has(L.transferMoves, COSTS));
  const detailOf = (list, action) => (list.find(e => e.action === action) || {}).detail;
  ok("the audit log keeps pricing, shop rate, payment and expense entries but not their details",
    ["settings.pricing_set", "settings.shop_rate_set", "payment.added", "expense.created", "recurring_expense.created"].every(a => L.audit.some(e => e.action === a) && detailOf(L.audit, a) === null) &&
    detailOf(L.audit, "product.updated").name === "Club tee");
  ok("whoever edits on that screen still sees every cost", E.products[0].transferCost === 3.5 && E.products[0].suppliesCost === 1.25 && E.inventory[0].purchasePrice === 4.25 &&
    E.ready.finished.sizes[0].avgCost === 6.4 && E.ready.finished.sizes[0].value === 32 && E.finished[0].unitCost === 6.4 && E.transfers[0].purchasePrice === 1.8 && E.transferMoves[0].unitCost === 1.8);
  ok("…but an edit level elsewhere doesn't open the audit log's money details", detailOf(E.audit, "payment.added") === null);
  ok("a role with costs.view sees them all, the audit details too", C.products[0].transferCost === 3.5 && C.ready.finished.sizes[0].avgCost === 6.4 && C.transferMoves[0].unitCost === 1.8 &&
    detailOf(C.audit, "payment.added").amount === 20 && detailOf(C.audit, "settings.pricing_set").targetMarginPct === 55);
  ok("the admin (no role limits) sees what it always did", JSON.stringify(A) === JSON.stringify(C));

  console.log("\n=== #22 The screens show a dash for a cost that isn't sent ===");
  const adminJs = read("public/admin.js");
  ok("finished stock and its history write a missing cost as —", /const money = \(n\) => n == null \? "—" : "\$" \+ Number\(n\)\.toFixed\(2\);/.test(adminJs.slice(adminJs.indexOf("async function showStockModal")))
    && /money\(r\.avgCost\)/.test(adminJs) && /money\(m\.unitCost\)/.test(adminJs));
  ok("transfers' average cost and history unit cost too", /\$\{t\.purchasePrice == null \? "—" : "\$" \+ Number\(t\.purchasePrice\)\.toFixed\(2\)\}/.test(adminJs) &&
    /\$\{m\.unitCost == null \? "—" : "\$" \+ Number\(m\.unitCost\)\.toFixed\(2\)\}/.test(adminJs));

  console.log("\n=== #30 / #31 Stock, average cost, merging and removing links are Full's ===");
  const staff = role("staffLike", { "inventory.blanks": "edit", "catalog.products": "edit", "costs.view": "read" });
  const full = role("fullBlanks", { "inventory.blanks": "full", "catalog.products": "edit", "costs.view": "read" });
  const created = await call({ action: "createBlank", name: "Plain tee", productType: "Tee", brand: "Sample Brand", sku: "T1",
    colors: [{ color: "Navy", sizes: [{ size: "M", quantity: 10, purchasePrice: 4, vendorPrice: 4 }, { size: "L", quantity: 6, purchasePrice: 4, vendorPrice: 4 }] }] });
  const blankId = created.body.id;
  const sizes = () => d1.q("SELECT size, quantity, purchasePriceCents FROM blank_sizes WHERE blankId=? ORDER BY size", blankId);
  const before = JSON.stringify(sizes());
  let r = await call({ action: "updateBlank", id: blankId, name: "Plain tee", productType: "Tee", brand: "Sample Brand", sku: "T1",
    colors: [{ color: "Navy", sizes: [{ size: "M", quantity: 2, purchasePrice: 4, vendorPrice: 4 }, { size: "L", quantity: 6, purchasePrice: 4, vendorPrice: 4 }] }] }, staff);
  ok("with Edit, the blank form can't change a count", r.status === 403 && JSON.stringify(sizes()) === before);
  r = await call({ action: "updateBlank", id: blankId, name: "Plain tee", productType: "Tee", brand: "Sample Brand", sku: "T1",
    colors: [{ color: "Navy", sizes: [{ size: "M", quantity: 10, purchasePrice: 9, vendorPrice: 4 }, { size: "L", quantity: 6, purchasePrice: 4, vendorPrice: 4 }] }] }, staff);
  ok("…nor an average cost", r.status === 403 && JSON.stringify(sizes()) === before);
  r = await call({ action: "updateBlank", id: blankId, name: "Plain tee", productType: "Tee", brand: "Sample Brand", sku: "T1",
    colors: [{ color: "Navy", sizes: [{ size: "M", quantity: 10, purchasePrice: 4, vendorPrice: 5 }, { size: "L", quantity: 6, purchasePrice: 4, vendorPrice: 4 }] }] }, staff);
  ok("…while the rest of the form (a vendor price) saves", r.status === 200 && JSON.stringify(sizes()) === before);
  r = await call({ action: "updateBlank", id: blankId, name: "Plain tee", productType: "Tee", brand: "Sample Brand", sku: "T1",
    colors: [{ color: "Navy", sizes: [{ size: "M", quantity: 8, purchasePrice: 4, vendorPrice: 5 }, { size: "L", quantity: 6, purchasePrice: 4, vendorPrice: 4 }] }] }, full);
  ok("with Full, the count changes (recorded as an adjustment)", r.status === 200 && sizes().find(s => s.size === "M").quantity === 8);

  const copy = (await call({ action: "createBlank", name: "Plain tee (old)", productType: "Tee", brand: "Sample Brand", sku: "T1-OLD", colors: [{ color: "Navy", sizes: [{ size: "M", quantity: 0 }] }] })).body.id;
  ok("merging blanks is refused with Edit", (await call({ action: "mergeBlanks", targetId: blankId, sourceIds: [copy] }, staff)).status === 403 && d1.q("SELECT id FROM blanks WHERE id=?", copy).length === 1);
  ok("…and done with Full", (await call({ action: "mergeBlanks", targetId: blankId, sourceIds: [copy] }, full)).status === 200 && d1.q("SELECT id FROM blanks WHERE id=?", copy).length === 0);

  const links = () => d1.q("SELECT productSize FROM product_blank_links WHERE orgId='acme' AND productId='tee' ORDER BY productSize").map(x => x.productSize);
  const link = (size) => ({ productColor: "", productSize: size, blankId, blankColor: "Navy", blankSize: size });
  r = await call({ action: "saveBlankLinks", org: "acme", productId: "tee", set: [link("M"), link("L")], remove: [] }, staff);
  ok("with Edit, a product's blank links are set", r.status === 200 && links().join() === "L,M");
  r = await call({ action: "saveBlankLinks", org: "acme", productId: "tee", set: [], remove: [{ productColor: "", productSize: "L" }] }, staff);
  ok("…but removing one is refused, and nothing is written", r.status === 403 && links().join() === "L,M");
  r = await call({ action: "saveBlankLinks", org: "acme", productId: "tee", set: [link("L")], remove: [{ productColor: "", productSize: "M" }] }, staff);
  ok("…even alongside links being set (nothing of that save is written)", r.status === 403 && links().join() === "L,M");
  ok("removing one link on its own needs Full too", (await call({ action: "deleteBlankLink", org: "acme", productId: "tee", productColor: "", productSize: "L" }, staff)).status === 403 && links().join() === "L,M");
  r = await call({ action: "saveBlankLinks", org: "acme", productId: "tee", set: [], remove: [{ productColor: "", productSize: "L" }] }, full);
  ok("with Full, the link is removed", r.status === 200 && links().join() === "M");
  ok("correcting the finished-stock count is Full's", (await call({ action: "setReadyToShipQty", org: "acme", productId: "tee", size: "", quantity: 9 }, staff)).status === 403 &&
    d1.q("SELECT quantity FROM ready_to_ship WHERE productId='tee'")[0].quantity === 5 &&
    (await call({ action: "setReadyToShipQty", org: "acme", productId: "tee", size: "", quantity: 6 }, full)).status === 200 && d1.q("SELECT quantity FROM ready_to_ship WHERE productId='tee'")[0].quantity === 6);
  ok("the permission list says so", api.ACTION_PERM.mergeBlanks[0].join() === "inventory.blanks,full" && api.ACTION_PERM.deleteBlankLink[0].join() === "inventory.blanks,full" &&
    api.ACTION_PERM.setReadyToShipQty[0].join() === "inventory.blanks,full" && api.ACTION_PERM.saveBlankLinks[0].join() === "inventory.blanks,edit");
  const stock = adminJs.slice(adminJs.indexOf("async function showStockModal"), adminJs.indexOf("async function showStockModal") + 9000);
  ok("in the admin, the finished-stock count is read-only without Full: its box and button need Full", /class="fsCount"[^>]*data-need-form="inventory\.blanks:full"/.test(stock) &&
    /class="admin-btn fsCorrect" data-need="inventory\.blanks:full"/.test(stock) && /id="fsNewCount"[^>]*data-need-form="inventory\.blanks:full"/.test(adminJs) && /id="fsNewCorrect"[^>]*data-need="inventory\.blanks:full"/.test(adminJs));
  ok("…the Merge menu item needs Full", /data-need="inventory\.blanks:full" onclick="blankMerge/.test(adminJs));
  ok("…and the product form offers no 'None' for a saved link, nor sends a removal, without Full", /const canUnlink = adminCan_\("inventory\.blanks", "full"\)/.test(adminJs) &&
    /<option value=""\$\{!canUnlink && linkMap\[pc \+ "\|" \+ size\] \? " disabled" : ""\}>— None —<\/option>/.test(adminJs) && /if \(!canUnlink\) remove\.length = 0;/.test(adminJs));

  console.log("\n=== #51 Every changing action is in the closed-month rules or named as touching no month ===");
  const src = read("functions/api/orders.js");
  const g0 = src.indexOf("const periodGuard = async (b) => {"), g1 = src.indexOf("for (const m of [...new Set(months", g0);
  const ruled = new Set([...src.slice(g0, g1).matchAll(/"([A-Za-z]+)"/g)].map(m => m[1]).filter(a => api.ACTION_PERM[a]));
  const changing = Object.entries(api.ACTION_PERM).filter(([, p]) => Array.isArray(p) && p.some(e => Array.isArray(e) && e[1] !== "read")).map(([a]) => a);
  const neither = changing.filter(a => !ruled.has(a) && !api.NO_MONTH_ACTIONS.has(a));
  ok("found the month rules (" + ruled.size + " actions) and the no-month list (" + api.NO_MONTH_ACTIONS.size + ")", g0 > 0 && g1 > g0 && ruled.size > 40 && api.NO_MONTH_ACTIONS.size > 100);
  ok("no changing action is in neither" + (neither.length ? " — missing: " + neither.join(", ") : ""), neither.length === 0);
  const both = [...api.NO_MONTH_ACTIONS].filter(a => ruled.has(a));
  ok("none is in both" + (both.length ? " — " + both.join(", ") : ""), both.length === 0);
  const unknown = [...api.NO_MONTH_ACTIONS].filter(a => !api.ACTION_PERM[a]);
  ok("the no-month list names only real actions" + (unknown.length ? " — " + unknown.join(", ") : ""), unknown.length === 0);
  const readOnly = Object.entries(api.ACTION_PERM).filter(([a, p]) => !changing.includes(a)).map(([a]) => a);
  ok("a read-only action is in neither (it changes nothing)", readOnly.every(a => !api.NO_MONTH_ACTIONS.has(a)) && readOnly.every(a => !ruled.has(a) || a === "listClosedPeriods"));

  console.log("\n=== #11 The installer's passphrase is never an API key ===");
  {
    const S = await makeAuth({ realLimits: true });
    const gate = (key, cookie) => S.lib.requireAdmin(S.env, { kind: "admin" }, key, request("/api/orders", {}, { cookie, headers: { "cf-connecting-ip": "203.0.113.40" } }), "no", "staff");
    const byKey = await gate(S.PRINTED, "");
    ok("on a new site, the passphrase sent with an API request opens nothing", !!byKey && byKey.status === 401 && S.d1.q("SELECT count(*) n FROM users")[0].n === 0);
    ok("…by the orders endpoint either (body key)", (await S.orders({ action: "listOrgs", key: S.PRINTED }, "")).status === 401);
    const first = await S.signIn("", S.PRINTED);
    ok("the sign-in page still takes it: the first admin, whose session must set up the account first", first.status === 200 && first.body.pending === "account" && !!first.cookie &&
      (await S.orders({ action: "listOrgs" }, first.cookie)).body.code === "setup_required");
    await S.password({ action: "account", name: "Olive Owner", email: "olive@example.test", next: "correct horse battery" }, first.cookie);
    const owner = (await S.signIn("olive@example.test", "correct horse battery")).cookie;
    ok("…and once the account is set, the owner's own session works", (await S.orders({ action: "listOrgs" }, owner)).status === 200 && (await gate("", owner)) === null);
    ok("the passphrase still opens nothing by API afterwards", (await gate(S.PRINTED, "")).status === 401);
    ok("a request without a session isn't a guess at a password: it doesn't count toward the site-wide budget",
      Number((S.d1.q("SELECT sum(count) n FROM rate_limits WHERE key LIKE 'rl:admin_auth_all:%'")[0] || {}).n || 0) === 0);
    const authSrc = read("functions/_lib/adminAuth.js");
    ok("adminAuth.js no longer compares a request's key with the passphrase", !/timingSafeEqual\(key, env\.PROXY_ADMIN_PASSPHRASE\)/.test(authSrc) && !/bootstrap: true/.test(authSrc));
  }

  console.log("\n=== #1 Sign-in lockout: per account, and a check instead of a wall ===");
  {
    const S = await makeAuth({ realLimits: true });
    await S.firstAdmin("Olive Owner", "olive@example.test", "correct horse battery");
    const admin = (await S.signIn("olive@example.test", "correct horse battery")).cookie;
    await S.addUser(admin, "staff", "Sam Staff", "sam@example.test", "sams own password");
    const clear = () => S.d1._raw.run("DELETE FROM rate_limits");
    clear();
    const post = async (ip, email, key, extra = {}) => answer(await S.raw["/api/admin-session"].POST({ env: S.env,
      request: request("/api/admin-session", Object.assign({ email, key }, extra), { headers: { "cf-connecting-ip": ip } }) }));
    // Turnstile's answer, as Cloudflare would give it: a token "good-…" passes.
    const verified = [];
    global.fetch = async (url, init) => {
      if (String(url) !== "https://challenges.cloudflare.com/turnstile/v0/siteverify") throw new Error("unexpected fetch " + url);
      const token = init.body.get("response"); verified.push(token);
      return { json: async () => ({ success: /^good-/.test(token) }) };
    };

    // One account, many addresses.
    for (let i = 1; i <= 10; i++) await post("198.51.100." + i, "sam@example.test", "not sams password");
    ok("ten failures for one account from ten addresses: that account isn't checked any further from a new address", (await post("198.51.100.50", "sam@example.test", "sams own password")).status === 429);
    ok("…while another account signs in", (await post("198.51.100.51", "olive@example.test", "correct horse battery")).status === 200);
    ok("…and the same account, typed another way, is the same account", (await post("198.51.100.52", "  SAM@Example.test ", "sams own password")).status === 429);
    const keys = S.d1.q("SELECT key FROM rate_limits").map(r => r.key).join(" ");
    ok("the count is kept under a hash of the email, never the email", /rl:admin_auth_acct:acct:[0-9a-f]{32}:/.test(keys) && !/sam@|example\.test/i.test(keys));
    clear();

    // The whole site's budget, from many addresses.
    S.env.ADMIN_AUTH_GLOBAL_LIMIT = "5";
    await post("203.0.113.7", "olive@example.test", "correct horse battery");   // the owner's usual address, known from here on
    for (let i = 1; i <= 5; i++) await post("192.0.2." + i, "olive@example.test", "wrong password " + i);
    r = await post("192.0.2.99", "olive@example.test", "correct horse battery");
    ok("without Turnstile keys, a spent budget refuses a new address as before", r.status === 429 && r.body.code !== "turnstile_required");
    ok("…but an address that signed in here in the last 30 days goes straight on", (await post("203.0.113.7", "olive@example.test", "correct horse battery")).status === 200);
    S.env.TURNSTILE_SECRET_KEY = "ts-secret"; S.env.TURNSTILE_SITE_KEY = "ts-site";
    r = await post("192.0.2.99", "olive@example.test", "correct horse battery");
    ok("with Turnstile keys, a new address is asked for the check instead (with the site key), and the password isn't looked at",
      r.status === 429 && r.body.code === "turnstile_required" && r.body.siteKey === "ts-site" && !r.cookie && verified.length === 0);
    r = await post("192.0.2.99", "olive@example.test", "correct horse battery", { turnstileToken: "bad-token" });
    ok("a token Cloudflare turns down is asked again", r.status === 429 && r.body.code === "turnstile_required" && verified.join() === "bad-token");
    r = await post("192.0.2.99", "olive@example.test", "correct horse battery", { turnstileToken: "good-1" });
    ok("a passed check goes on to the password, and signs in", r.status === 200 && !!r.cookie);
    r = await post("192.0.2.98", "olive@example.test", "a wrong password", { turnstileToken: "good-2" });
    ok("…a wrong password after a passed check is still refused", r.status === 401);
    ok("an address that just signed in is known now: no check", (await post("192.0.2.99", "olive@example.test", "correct horse battery")).status === 200);
    const marks = S.d1.q("SELECT key, expiresAt FROM rate_limits WHERE key LIKE 'rl:admin_known:%'");
    const now = Math.floor(Date.now() / 1000);
    ok("…for 30 days", marks.length >= 2 && marks.every(m => m.expiresAt > now + 29 * 86400 && m.expiresAt <= now + 30 * 86400 + 5));
    S.env.TURNSTILE_SITE_KEY = "";
    ok("a secret without a site key can't show the check, so it refuses as before", (await post("192.0.2.97", "olive@example.test", "correct horse battery")).body.code !== "turnstile_required");
    S.env.ADMIN_AUTH_GLOBAL_LIMIT = "0"; S.env.TURNSTILE_SITE_KEY = "ts-site";
    ok("with the budget off, nobody is asked", (await post("192.0.2.96", "olive@example.test", "correct horse battery")).status === 200);
    delete S.env.ADMIN_AUTH_GLOBAL_LIMIT;
    ok("the per-address limit is still there", /rateLimited\(env, "admin_auth", request, 10\)/.test(read("functions/api/admin-session.js")));
    const adminJs2 = read("public/admin.js");
    ok("the sign-in page shows the check when the server asks for it, and sends its token", /data && data\.code === "turnstile_required" && data\.siteKey/.test(adminJs2) &&
      /turnstileToken: token/.test(adminJs2) && /challenges\.cloudflare\.com\/turnstile\/v0\/api\.js\?render=explicit/.test(adminJs2) && /function adminTurnstileCheck_\(siteKey, message\)/.test(adminJs2));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})().catch(e => { console.error(e); console.log("test242 ran to the end without crashing: false"); process.exitCode = 1; });
