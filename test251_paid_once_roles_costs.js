const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { JSDOM } = require("jsdom");

// Three fixes (2026-11-23):
//   1. Mark as paid, several at once: only the request whose guarded write took the row books the payment AND sends
//      the "paid" email, writes the audit entry and delivers digital files; the rest are told it was already paid
//      (orders.js markPaidManual, db.js settleOrderBalanceOnce — decided from the write's own result, tookRow_).
//   2. The Roles tab offers Delete role only to whoever has Users and roles at Full, as the server asks (deleteRole).
//   3. Read on Blanks without costs.view is stock and details only (owner's decision): no average cost, vendor price,
//      MAP, movement cost or Blanks to Order price — costs.view, or Edit on Blanks (Blanks to Order), still see them.
//   4. (2026-11-24) The Blanks page's Import, Connected vendor and More menus lead only to changes, so they're Edit's.
//   5. (2026-11-24) Audit entries whose detail is what stock cost (receipts, vendor prices, average costs, catch-ups,
//      supplier orders, statements…) keep their row but not their detail for a role without costs.view.
// Real SQL (sql.js) + real db.js, permissions.js and orders.js; the page's own functions cut out of public/admin.js.
// Invented data only.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + "\nreturn { insertOrder, getOrderById, createBlank, receiveBlanks, setBlankLink };")();
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
  "const sendOrderReceivedEmail = async () => false, sendOrderNotificationEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false;\n" +
  "const sendPaymentConfirmedEmail = async (env, order) => { (globalThis.__paidEmails = globalThis.__paidEmails || []).push(order.orderId); return true; };\n" +
  "const deliverOrderDownloads = async (env, orderId) => { (globalThis.__delivered = globalThis.__delivered || []).push(orderId); return null; };\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) +
  "\nreturn { post: onRequestPost, as: __as, normalizePermissions };")();

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
  const pending = [];
  const call = async (body, as = null) => {
    api.as.role = as;
    const full = Object.assign({ key: "x" }, body);
    const req = { url: "https://admin.example.com/api/orders", json: async () => full, clone: () => ({ json: async () => full }), headers: { get: () => null } };
    const res = await api.post({ env, waitUntil: (p) => pending.push(Promise.resolve(p).catch(() => {})), request: req });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  const settle = async () => { while (pending.length) await pending.shift(); };
  const t = "2026-11-02T15:00:00.000Z";
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Example Club','${t}','${t}');`);

  // ---- 1. Mark as paid, several at once -------------------------------------------------------------------------
  console.log("=== Mark as paid: several requests at once book, email, audit and deliver once ===");
  const mk = (orderId, price) => lib.insertOrder(d1, { orderId, orgId: "acme", customerName: "Pat Example", contact: "pat@example.test",
    paymentMethod: "Venmo", placedAt: t, subtotal: price, shippingCost: 0, total: price },
    [{ productId: "", name: "Tee", type: "shirt", size: "L", qty: 1, unitPrice: price }]);
  const pays = (id) => d1.q("SELECT amountCents FROM order_payments WHERE orderId=? AND kind='payment' AND voidedAt IS NULL", id);
  const audits = (id) => d1.q("SELECT COUNT(*) n FROM audit_log WHERE action='order.marked_paid' AND orderId=?", id)[0].n;
  const count = (list, id) => (list || []).filter(x => x === id).length;
  const race = async (orderId, n = 5) => {
    globalThis.__paidEmails = []; globalThis.__delivered = [];
    // Different keys (several admins / tabs): the payments ledger's own guard is all that stops a second booking.
    const rs = await Promise.all(Array.from({ length: n }, (_, i) => call({ action: "markPaidManual", org: "acme", orderId, requestId: "req-race-" + orderId + "-" + i })));
    await settle();
    return rs;
  };
  await mk("PAY-1", 80);
  let rs = await race("PAY-1");
  const winners = rs.filter(r => r.status === 200 && !r.body.alreadyPaid), losers = rs.filter(r => r.status === 200 && r.body.alreadyPaid === true);
  ok("five at once → one $80 payment", pays("PAY-1").length === 1 && pays("PAY-1")[0].amountCents === 8000);
  ok("…exactly one request answers that it paid it; the other four say it was already paid, with nothing recorded",
    winners.length === 1 && losers.length === 4 && losers.every(r => r.body.amountRecorded === 0));
  ok("…one 'paid' email", count(globalThis.__paidEmails, "PAY-1") === 1);
  ok("…one 'marked paid' audit entry", audits("PAY-1") === 1);
  ok("…and digital delivery run once", count(globalThis.__delivered, "PAY-1") === 1);
  ok("…the order is paid", (await lib.getOrderById(d1, "PAY-1")).paid === true);
  rs = await race("PAY-1", 2);
  ok("asked again later: already paid, no email, audit or delivery", rs.every(r => r.body.alreadyPaid === true) && globalThis.__paidEmails.length === 0 &&
    globalThis.__delivered.length === 0 && audits("PAY-1") === 1 && pays("PAY-1").length === 1);

  // An order that owes nothing ($0): the paid flag is the only write, guarded on "still unpaid".
  await mk("PAY-0", 0);
  rs = await race("PAY-0");
  ok("a $0 order marked paid five times at once: one request takes it, the others are told it was already paid",
    rs.filter(r => !r.body.alreadyPaid).length === 1 && rs.filter(r => r.body.alreadyPaid === true).length === 4 && pays("PAY-0").length === 0);
  ok("…one email, one audit entry, one delivery", count(globalThis.__paidEmails, "PAY-0") === 1 && audits("PAY-0") === 1 && count(globalThis.__delivered, "PAY-0") === 1);
  ok("…and it is paid", (await lib.getOrderById(d1, "PAY-0")).paid === true);
  await mk("PAY-2", 30);
  rs = await race("PAY-2", 1);
  ok("one Mark as paid on its own still books, emails, audits and delivers", rs[0].status === 200 && !rs[0].body.alreadyPaid && pays("PAY-2").length === 1 &&
    count(globalThis.__paidEmails, "PAY-2") === 1 && audits("PAY-2") === 1 && count(globalThis.__delivered, "PAY-2") === 1);
  const ordersJs = read("functions/api/orders.js");
  const handler = ordersJs.slice(ordersJs.indexOf('if (body.action === "markPaidManual")'), ordersJs.indexOf('if (body.action === "resendEmail")'));
  ok("the handler decides from the write's own result, not from a read made before it", /if \(!tookRow\) return jsonResponse\(\{ status: "ok", alreadyPaid/.test(handler) &&
    !/before\.paid/.test(handler) && !/newlyPaid/.test(handler));
  ok("…and the $0 path's write is guarded on paid = 0 and counted with tookRow_ (D1 counts trigger rows too)",
    /WHERE orderId = \? AND paid = 0"\)[\s\S]{0,120}tookRow: tookRow_\(r\)/.test(read("functions/_lib/db.js")));

  // ---- 2. Delete role: Full only ---------------------------------------------------------------------------------
  console.log("\n=== The Roles tab offers Delete role only with Users and roles at Full ===");
  const adminJs = read("public/admin.js");
  const cut = (start, end) => { const i = adminJs.indexOf(start); const j = adminJs.indexOf(end, i); if (i < 0 || j < 0) throw new Error("admin.js no longer has: " + start); return adminJs.slice(i, j); };
  const rolesTab = (level, draft) => {
    const panel = { innerHTML: "" };
    const d = { roles: [{ key: "custom1", name: "Packers", userCount: 0 }], areas: [], myRank: 75, myLevels: { "settings.users": level } };
    new Function("adminPerms", "document", "_rolesData", "_roleDraft", "escapeHtml", "usersTabsHtml_", "ROLE_LEVELS_",
      cut("const ADMIN_LEVEL_RANK_", "function adminRoleName_") + cut("function roleFnOn_(p, fn)", "// Switching an item on") + "\nrenderRolesTab_();")(
      { "settings.users": level }, { getElementById: (id) => id === "adminPanel" ? panel : null }, d, draft,
      (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";"), () => "", [["none", "None"], ["read", "Read"], ["edit", "Edit"], ["full", "Full"]]);
    return panel.innerHTML;
  };
  const custom = () => ({ key: "custom1", name: "Packers", rank: 20, builtIn: false, locked: false, canEdit: true, userCount: 0, permissions: { menus: {}, items: {}, fns: {} } });
  const full = rolesTab("full", custom()), edit = rolesTab("edit", custom()), readOnly = rolesTab("read", custom());
  ok("Users and roles at Full: a custom role has Delete role, tagged as Full's", /data-admin-action="roleDelete_"/.test(full) && /data-need="settings\.users:full" data-admin-action="roleDelete_"/.test(full));
  ok("…at Edit: Save role is there, Delete role is not", /data-admin-action="roleSave_"/.test(edit) && !/roleDelete_/.test(edit) && !/Delete role/.test(edit));
  ok("…at Read: neither", !/roleSave_/.test(readOnly) && !/roleDelete_/.test(readOnly));
  ok("a built-in role has no Delete role, even at Full", !/roleDelete_/.test(rolesTab("full", Object.assign(custom(), { builtIn: true }))));
  const tab = cut("function renderRolesTab_(){", "// Switching an item on");
  const perm = read("functions/api/admin-users.js");
  ok("nothing else on the tab is Full's on the server: only deleteRole asks for Full, and the tab's other actions are Edit's",
    /action === "deleteRole" \? \[\["settings\.users", "full"\]\] : \[\["settings\.users", "edit"\]\]/.test(perm) &&
    [...tab.matchAll(/data-admin-action="(\w+)"/g)].map(m => m[1]).every(a => ["roleSelect_", "roleNew_", "roleCopy_", "roleSave_", "roleUndoChanges_", "loadRoles_", "roleDelete_"].includes(a)));

  // ---- 3. Read on Blanks: no money ---------------------------------------------------------------------------------
  console.log("\n=== Read on Blanks without costs.view: stock and details, no money ===");
  const blankId = (await lib.createBlank(d1, { name: "Sample Tee", productType: "tee", brand: "Sample Brand", sku: "ST-1", vendor: "",
    colors: [{ color: "Navy", images: [], sizes: [{ size: "M", quantity: 0, purchasePrice: 0 }, { size: "L", quantity: 0, purchasePrice: 0 }] }] })).id;
  await lib.receiveBlanks(d1, { blankId, lines: [{ color: "Navy", size: "M", qty: 10, unitCost: 4.5 }, { color: "Navy", size: "L", qty: 4, unitCost: 5 }], receivedAt: "2026-10-01T12:00:00.000Z" });
  d1._raw.exec(`UPDATE blank_sizes SET vendorPriceCents=425, vendorPriceAt='${t}', mapPriceCents=1200, weightOz=5.3 WHERE blankId=${blankId};
    INSERT INTO blank_vendor_prices (blankId, color, size, priceCents, previousCents, enteredAt, actor, note) VALUES (${blankId}, 'Navy', 'M', 425, 400, '${t}', 'pat@example.test', '');
    INSERT INTO products (productId, orgId, type, name, pricingMode, flatPriceCents, createdAt, updatedAt, garmentColorsJson, configurable)
      VALUES ('tee','acme','Tee','Club tee','flat',2000,'${t}','${t}','["Navy","Red"]',1);`);
  await lib.setBlankLink(d1, "acme", "tee", "Navy", "", blankId, "Navy", "M");
  await lib.setBlankLink(d1, "acme", "tee", "", "", blankId, "Navy", "M");
  d1._raw.exec(`UPDATE blanks SET vendor='Sample Vendor' WHERE id=${blankId}`);
  // An open order for 3 of the tee: Blanks to Order lists the blank to buy.
  await lib.insertOrder(d1, { orderId: "BTO-1", orgId: "acme", customerName: "Sam Example", contact: "sam@example.test", paymentMethod: "Venmo", placedAt: t,
    subtotal: 60, shippingCost: 0, total: 60 }, [{ productId: "tee", name: "Club tee", type: "Tee", size: "", qty: 3, unitPrice: 20 }]);

  const looks = role("looks", { "inventory.blanks": "read", "inventory.blankorder": "read" });
  const looksWithCosts = role("looksWithCosts", { "inventory.blanks": "read", "inventory.blankorder": "read", "costs.view": "read" });
  const edits = role("edits", { "inventory.blanks": "edit", "inventory.blankorder": "edit" });
  const MONEY = /"(purchasePrice|vendorPrice|vendorPriceAt|mapPrice|unitCost|cost|costs|avgCost|value|price|previous|oldCost|total|replacedEstimate)(Cents)?":/;
  const has = (v, re) => re.test(JSON.stringify(v));
  const reads = async (as) => ({
    blanks: (await call({ action: "getBlanks" }, as)).body,
    moves: (await call({ action: "getBlankMovements", blankId }, as)).body,
    history: (await call({ action: "getBlankVendorPriceHistory", blankId }, as)).body,
    catchUp: (await call({ action: "previewBlankCatchUp" }, as)).body,
    groups: (await call({ action: "suggestColorGroups", org: "acme", productId: "tee" }, as)).body,
    toOrder: (await call({ action: "getBlanksToOrder", includeUnpaid: true }, as)).body,
    freeShip: (await call({ action: "freeShippingSuggestions", vendor: "Sample Vendor" }, as)).body,
  });
  // The same answer, apart from when it was worked out.
  const same = (a, b) => JSON.stringify(a, (k, v) => k === "generatedAt" ? undefined : v) === JSON.stringify(b, (k, v) => k === "generatedAt" ? undefined : v);
  const btoRow = (body) => (((body.suppliers || [])[0] || { rows: [] }).rows || [])[0] || {};
  const L = await reads(looks), C = await reads(looksWithCosts), E = await reads(edits), A = await reads(null);
  const sizeM = (body) => ((((body.blanks || []).find(b => b.id === blankId) || {}).colors || [])[0] || { sizes: [] }).sizes.find(z => z.size === "M") || {};
  ok("every answer is a 200 for each role", [L, C, E, A].every(x => Object.values(x).every(b => b.status === "ok")));
  ok("getBlanks: the blank, its colors, sizes, stock, weight, SKU and vendor — no average cost, vendor price, its date or MAP",
    sizeM(L.blanks).quantity === 10 && sizeM(L.blanks).weightOz === 5.3 && L.blanks.blanks.find(b => b.id === blankId).sku === "ST-1" &&
    !has(L.blanks.blanks, MONEY) && !has(L.blanks.blanks.find(b => b.id === blankId).sizes, MONEY));
  ok("…stock-only reads (the Orders page) are unchanged", (await call({ action: "getBlanks", stockOnly: true }, looks)).body.blanks.find(b => b.id === blankId).sizes.some(z => z.size === "M" && z.quantity === 10));
  ok("stock history: the movements and their quantities, no unit cost", L.moves.movements.length === 2 && L.moves.movements.some(m => m.qtyDelta === 10) && !has(L.moves.movements, MONEY));
  ok("vendor price history: no prices", L.history.history.length === 1 && !has(L.history.history, MONEY));
  ok("Use blanks for past orders (preview): no costs or totals", !has(L.catchUp, MONEY) && "totalUnits" in L.catchUp);
  ok("color groups suggested from blank prices: no costs and no prices worked out from them", !has(L.groups, /"(costs|sizePricing|flatPrice)":/));
  ok("Blanks to Order (Read there): what to order, no price", btoRow(L.toOrder).needed === 3 && btoRow(L.toOrder).onHand === 10 && !has(L.toOrder, MONEY));
  ok("…nor in Get me to free shipping's suggestions", (L.freeShip.candidates || []).length === 2 && !has(L.freeShip.candidates, MONEY));
  ok("a role with costs.view sees every one of them", sizeM(C.blanks).purchasePrice === 4.5 && sizeM(C.blanks).vendorPrice === 4.25 && sizeM(C.blanks).mapPrice === 12 &&
    C.moves.movements.some(m => m.unitCost === 4.5) && C.history.history[0].price === 4.25 && C.history.history[0].previous === 4 &&
    has(C.groups, /"costs":/) && btoRow(C.toOrder).price === 4.5 && btoRow(C.toOrder).vendorPrice === 4.25 && C.freeShip.candidates.some(c => c.price === 4.25) && same(C, A));
  ok("a role with Edit on Blanks (and Blanks to Order) sees them too", sizeM(E.blanks).purchasePrice === 4.5 && sizeM(E.blanks).vendorPrice === 4.25 && sizeM(E.blanks).vendorPriceAt === t &&
    E.moves.movements.some(m => m.unitCost === 4.5) && E.history.history[0].price === 4.25 && btoRow(E.toOrder).vendorPrice === 4.25 && same(E, A));
  // Production (Run Order) still gets the blanks without costs, as before.
  const prod = role("prod", { "run.queue": "read" });
  const P = (await call({ action: "getBlanks" }, prod)).body;
  ok("Run Order's blanks (no Blanks, no costs.view): stock, no money", sizeM(P).quantity === 10 && !has(P.blanks, MONEY));

  console.log("\n=== The Blanks screens leave the money out instead of showing $0.00 or NaN ===");
  ok("the page asks one question for it: costs.view, or Edit on Blanks", /function adminSeesBlankCosts_\(\)\{ return adminCan_\("costs\.view"\) \|\| adminCan_\("inventory\.blanks", "edit"\); \}/.test(adminJs));
  // The Blanks list, drawn by its own function for each kind of role.
  const drawList = (perms, blanks) => {
    const panel = { innerHTML: "" };
    const win = { _blanksReserved: {}, _blanksLow: {}, _blanksPriceCheck: blanks.map(b => b.id), _blankProducts: {} };
    new Function("adminPerms", "window", "productCategories_", "categoryPlural_", "sizesInOrder_", "escapeHtml", "thumbUrl", "blankUsesHtml_", "blankPricesCheckedLabel_",
      "adminMenuHtml_", "adminMenuItem_", "blanks",
      cut("const ADMIN_LEVEL_RANK_", "function adminRoleName_") + cut("function blankSizePrices_(s) {", "// Vendor prices (migrations/0062)") +
      cut("function renderBlanksTable(panel, app, blanks, query) {", "  panel.innerHTML = html;") + "\n  panel.innerHTML = html;\n}\nrenderBlanksTable(arguments[12], null, blanks, '');")(
      perms, win, () => [{ key: "tee" }], () => "Tees", (s) => s, (s) => String(s == null ? "" : s), (u) => u, () => "", () => "Vendor prices checked",
      () => "", () => "", blanks, panel);
    return panel.innerHTML;
  };
  const row = (body) => body.blanks.filter(b => b.id === blankId);
  const listL = drawList({ "inventory.blanks": "read" }, row(L.blanks)), listC = drawList({ "inventory.blanks": "read", "costs.view": "read" }, row(C.blanks));
  ok("Read on Blanks: the list shows stock and no money at all — no $, no NaN, no 'value'", /10/.test(listL) && !/\$/.test(listL) && !/NaN/.test(listL) && !/value/i.test(listL) &&
    /Total blanks in stock: 14 units/.test(listL) && !/Vendor prices checked/.test(listL));
  ok("…with costs.view it shows the prices and the held value as before", /\$4\.25/.test(listC) && /\$65\.00 value/.test(listC) && /Total held inventory value: \$65\.00/.test(listC));
  const hist = cut("async function showBlankHistoryModal(blank, onDone){", "  window.voidBlankMovement_");
  ok("stock history: the Unit cost column only for whoever is sent it, and a missing cost is a dash, never $NaN",
    /const costs = adminSeesBlankCosts_\(\);/.test(hist) && /\$\{costs \? `<th[^`]*>Unit cost<\/th>` : ""\}/.test(hist) && /adminMoneyOr_\(m\.unitCost\)/.test(hist) && !/Number\(m\.unitCost\)\.toFixed/.test(hist));
  const bto = cut("async function renderBlanksToOrder", "function freeShipHeaderHtml_");
  ok("Blanks to Order: Price, Cost, totals and free-shipping progress only for costs.view or Edit there",
    /const costs = adminCan_\("costs\.view"\) \|\| adminCan_\("inventory\.blankorder", "edit"\);/.test(bto) && /\$\{costs \? `<th style="\$\{th\}\$\{num\}">Price<\/th>/.test(bto) &&
    /\$\{s\.vendor && costs \? freeShipHeaderHtml_\(s, si\) : ""\}/.test(bto) && /\$\{costs \? `<strong>Total \$\{money\(t\.grandCost\)\}<\/strong>` : ""\}/.test(bto));
  ok("the product form's 'Suggest from blank prices' only for whoever is sent blank costs", /\$\{adminSeesBlankCosts_\(\) \? `<button type="button" class="admin-btn" id="cgSuggest"/.test(adminJs) &&
    /if \(suggestBtn\) suggestBtn\.onclick/.test(adminJs));

  // ---- 4. The Blanks toolbar: what leads only to changes is Edit's ----------------------------------------------------
  console.log("\n=== Blanks: Import, Connected vendor and More are Edit's ===");
  const toolbar = (perms) => {
    const dom = new JSDOM("<!doctype html><body><div id=app></div></body>");
    const doc = dom.window.document, app = doc.getElementById("app");
    new Function("adminPerms", "document", "window", "adminSetHash", "adminTitle_", "adminPageHead_", "escapeHtml",
      cut("const ADMIN_LEVEL_RANK_", "function adminRoleName_") + cut("function adminPermOk_(spec){", "// Every screen and popup is built") +
      cut("function adminMenuHtml_(label, itemsHtml, opts){", "function closeAdminMenus_") + cut("function blanksView_() {", "\n") +
      cut("async function renderAdminBlanks(app) {", '  document.getElementById("blankGroup").value') + "}\nrenderAdminBlanks(arguments[7]); adminApplyPerms_(document.body);")(
      perms, doc, {}, () => {}, (t) => t, (t) => "<h1>" + t + "</h1>", (x) => String(x == null ? "" : x).replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";"), app);
    const shown = (id) => { const el = doc.getElementById(id); return !!el && !el.closest("[data-perm-off]"); };
    return { shown, doc };
  };
  const CHANGES = ["blankAddBtn", "blankOrderBtn", "blankCountBtn", "blankImportPdfBtn", "blankVendorNewBtn", "blankVendorUpdBtn", "blankImportCsvBtn",
    "blankVendorApiNewBtn", "blankVendorLiveBtn", "blankDupPhotosBtn", "blankRepairThumbsBtn"];
  const tbRead = toolbar({ "inventory.blanks": "read" }), tbEdit = toolbar({ "inventory.blanks": "edit" });
  ok("Read on Blanks: search and the group filter, and none of New blank, Receive order, Count stock or the Import / Connected vendor / More items",
    tbRead.shown("blankSearch") && tbRead.shown("blankGroup") && CHANGES.every(id => tbRead.doc.getElementById(id) && !tbRead.shown(id)));
  ok("…none of the three menus' own buttons is shown either", ["Import", "Connected vendor", "More"].every(label =>
    [...tbRead.doc.querySelectorAll(".admin-menu > button")].filter(b => b.textContent.trim().startsWith(label)).every(b => !!b.closest("[data-perm-off]"))));
  ok("Edit on Blanks: every one of them is there (Connected vendor still waits for a connected vendor)", CHANGES.every(id => tbEdit.shown(id)));
  ok("the Connected vendor menu doesn't even ask for connections without Edit", /if \(!adminCan_\("inventory\.blanks", "edit"\)\) return;/.test(cut("function showBlankVendorMenu_(){", "async function repairBlankThumbs_")));

  // ---- 5. The audit log: what stock cost keeps its row, not its detail -------------------------------------------
  console.log("\n=== The audit log: entries about what stock cost keep their row, not their detail, without costs.view ===");
  const MONEY_ENTRIES = {
    "inventory.received": { blankId, lines: [{ color: "Navy", size: "M", qty: 10, unitCost: 4.5 }], extraCost: 2 },
    "inventory.order_received": { parts: { blanks: 45 }, total: 47 },
    "inventory.receipt_account_changed": { kind: "blanks", total: 47 },
    "inventory.vendor_prices_changed": { blankId, changes: [{ color: "Navy", size: "M", from: 4, to: 4.25 }] },
    "inventory.average_cost_recomputed": { blankId, changes: [{ color: "Navy", size: "M", from: 4, to: 4.5 }] },
    "inventory.catch_up": { lines: [{ itemId: 1, qty: 1, unitCostCents: 450, oldCostCents: 400 }] },
    "inventory.movement_voided": { movementId: 1, qtyDelta: 10, unitCost: 4.5 },
    "inventory.movement_restored": { movementId: 1, qtyDelta: 10, unitCost: 4.5 },
    "inventory.made_for_stock": { productId: "tee", qty: 2, unitCost: 6.25 },
    "transfer.received": { rows: [{ transferId: 1, count: 10 }], total: 25 },
    "transfer.sheet_edited": { movementId: 1, before: { total: 25 }, after: { total: 30 } },
    "transfer.catch_up": { lines: [{ itemId: 1, uses: [{ transferId: 1, qty: 1, unitCostCents: 250 }] }] },
    "transfer.movement_voided": { movementId: 1, unitCost: 2.5 },
    "transfer.movement_restored": { movementId: 1, unitCost: 2.5 },
    "transfer.receipt_account_changed": { kind: "transfers", total: 25 },
    "supplier_order.placed": { id: 1, poNumber: "PO-1", total: 99.5 },
    "supplier_order.failed": { id: 2, poNumber: "PO-2", total: 12 },
    "statement.created_entry": { lineId: 1, kind: "blanks", amount: 47 },
    "statement.reconciled": { account: "Checking", month: "2026-10", statementBalance: 1000, bookBalance: 1000 },
    "payments.deposit_mapped": { lineId: 2, coveredCents: 4000, depositCents: 3880, differenceCents: 120 },
    "payments.stripe_fees_backfilled": { updated: 3, results: [{ paymentId: 1, feeCents: 88 }] },
    "product.prices_confirmed": { productId: "tee", changes: [{ blankId, from: 4, to: 4.25 }] },
  };
  const KEPT = {
    "inventory.counted": { rows: [{ blankId, color: "Navy", size: "M", counted: 9, onHand: 10, delta: -1 }] },
    "inventory.written_off": { blankId, color: "Navy", size: "M", qty: 1, reason: "damaged" },
    "transfer.counted": { rows: [{ transferId: 1, counted: 9, onHand: 10, delta: -1 }] },
    "inventory.blank_sizes_added": { blankId, sizes: [{ color: "Navy", size: "XL" }] },
    "supplier_order.cancelled": { id: 1, poNumber: "PO-1", vendor: "Sample Vendor" },
    "statement.reopened": { account: "Checking", month: "2026-10" },
  };
  for (const [action, detail] of Object.entries({ ...MONEY_ENTRIES, ...KEPT, "product.updated": { productId: "tee", changes: { name: { from: "Tee", to: "Club tee" }, transferCost: { from: 1, to: 1.5 }, suppliesCost: { from: 0.5, to: 0.75 } } } }))
    d1._raw.exec(`INSERT INTO audit_log (createdAt, action, detail, actor) VALUES ('${t}', '${action}', '${JSON.stringify(detail).replace(/'/g, "''")}', 'pat@example.test')`);
  const auditAs = async (as) => (await call({ action: "getAuditLog", limit: 500 }, as)).body.entries || [];
  const reader = role("auditReader", { "reports.audit": "read" }), readerCosts = role("auditReaderCosts", { "reports.audit": "read", "costs.view": "read" });
  const R = await auditAs(reader), RC = await auditAs(readerCosts);
  const entry = (list, action) => list.find(e => e.action === action);
  const hidden = Object.keys(MONEY_ENTRIES).filter(a => !(entry(R, a) && entry(R, a).detail === null));
  if (hidden.length) console.log("   still with detail:", hidden.join(", "));
  ok(`without costs.view: all ${Object.keys(MONEY_ENTRIES).length} kinds of entry about what stock cost are listed, with no detail`, hidden.length === 0);
  ok("…counts, write-offs, sizes added, a cancelled supplier order and a reopened month keep their detail",
    Object.entries(KEPT).every(([a, d]) => entry(R, a) && JSON.stringify(entry(R, a).detail) === JSON.stringify(d)));
  const pu = entry(R, "product.updated");
  ok("…a product change keeps its name change but not the product's transfer or supplies cost", pu && pu.detail.changes.name.to === "Club tee" && !("transferCost" in pu.detail.changes) && !("suppliesCost" in pu.detail.changes));
  ok("with costs.view every detail is there", Object.entries(MONEY_ENTRIES).every(([a, d]) => entry(RC, a) && JSON.stringify(entry(RC, a).detail) === JSON.stringify(d)) &&
    entry(RC, "product.updated").detail.changes.transferCost.to === 1.5);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exit(1); });
