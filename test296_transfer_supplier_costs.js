const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");

// What stock cost, on the Transfers and Supplier orders screens (review round 2): a role that may only LOOK there and
// has no costs.view (Money, costs and margins) gets these answers without their money, as their sibling reads
// (listTransfers, getTransferMovements, previewBlankCatchUp) already were:
//   - getTransferSheet: the sheet's total, each row's dollars and per-item price, the written-off and personal amounts,
//     and its invoice (receiptKey / receiptName). Rows, counts, % of the sheet, vendor and date stay.
//   - previewTransferCatchUp (Use transfers for past orders): each line's cost, each use's unit cost, the total and
//     what the later uses would be re-costed by (recostTotal). Lines, counts and how many would be re-costed stay.
//   - listSupplierOrders and checkSupplierOrderShipments: each order's total and its lines' prices (unitCents).
// costs.view, or Edit on that screen, still gets them (and for supplier orders Edit on Blanks too: Receive… fills its
// form from the order's prices). The pages show "—" where an amount is missing, never $NaN or $0.00.
// Real SQL (sql.js) + real db.js, permissions.js and orders.js; the page's own functions cut out of public/admin.js.
// Invented data only.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
const lib = new Function(dbSrc + "\nreturn { createTransfer };")();
// The gate as adminAuth.js runs it, for the role this test is acting as (__as.role; null = everything), as test251.
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
  // No supplier is asked anything here: the shipment check finds nothing new.
  "const checkSupplierShipments = async () => ({ checked: 1, added: 0, errors: [] }); const supplierShipMethods = () => [];\n" +
  "const sendOrderReceivedEmail = async () => false, sendOrderNotificationEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false;\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) +
  "\nreturn { post: onRequestPost, as: __as, normalizePermissions };")();
const adminJs = read("public/admin.js");
const cut = (from, to) => { const i = adminJs.indexOf(from); if (i < 0) throw new Error("not found: " + from); const j = adminJs.indexOf(to, i + from.length); if (j < 0) throw new Error("not found: " + to); return adminJs.slice(i, j); };

let failed = 0, passed = 0;
const ok = (label, cond) => { cond ? passed++ : failed++; console.log(label + ": " + !!cond); };
// A role of the owner's own making (Users → Roles and permissions): these functions, nothing else.
const role = (key, fns) => ({ key, name: key, rank: 10, locked: false, builtIn: false, permissions: api.normalizePermissions({ fns }) });
// Every key at any depth of an answer.
const keysDeep = (v, out = new Set()) => {
  if (Array.isArray(v)) v.forEach(x => keysDeep(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.add(k); keysDeep(x, out); }
  return out;
};
const moneyKeys = (v, re) => [...keysDeep(v)].filter(k => re.test(k));

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  // Two made orders whose line printed the shop's QR transfer (as test191): O2 never took it out of stock; O5 did, later.
  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('ac','ac','Example Club','t','t');
    INSERT INTO products (productId, orgId, type, name, pricingMode, flatPrice, sizePricing, createdAt, updatedAt) VALUES ('cap','ac','cap','Cap','flat',20,'{}','t','t');`);
  for (const id of ["O2", "O5"]) {
    d1._raw.run(`INSERT INTO orders (orderId, orgId, customerName, contact, paymentMethod, paid, subtotal, total, placedAt) VALUES (?, 'ac', 'Sam Example', 'sam@example.test', 'Card', 1, 20, 20, '2026-10-01T00:00:00Z')`, [id]);
    d1._raw.run(`INSERT INTO order_items (orderId, orgId, productId, name, type, qty, unitPrice, lineTotal, cancelDate) VALUES (?, 'ac', 'cap', 'Cap', 'cap', 1, 20, 20, '')`, [id]);
  }
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const env = { DB: d1, ROOT_DOMAIN: "example.com" };
  const call = async (body, as = null) => {
    api.as.role = as;
    const full = Object.assign({ key: "x" }, body);
    const req = { url: "https://admin.example.com/api/orders", json: async () => full, clone: () => ({ json: async () => full }), headers: { get: () => null } };
    const res = await api.post({ env, waitUntil: (p) => Promise.resolve(p).catch(() => {}), request: req });
    return { status: res.status, body: JSON.parse(await res.text()) };
  };
  await call({ action: "saveVendor", vendor: { name: "Sample Transfer Co", forTransfers: true } });
  const QR = await lib.createTransfer(d1, { name: "Shop QR" });
  d1._raw.run("UPDATE orgs SET reorderQrTransferId = ? WHERE orgId = 'ac'", [QR]);
  const qrCfg = JSON.stringify({ garmentColor: "", size: "OSFA", plain: true, locations: [{ location: "reorderqr", kind: "transfer", transferId: QR, auto: true }] });
  d1._raw.run("UPDATE orders SET manufacturedAt = ? WHERE orderId = 'O2'", ["2026-10-16T15:00:00Z"]);
  d1._raw.run("UPDATE orders SET manufacturedAt = ? WHERE orderId = 'O5'", ["2026-10-25T15:00:00Z"]);
  d1._raw.run("UPDATE order_items SET configJson = ?, cogsCents = 300, cogsSource = 'consumed'", [qrCfg]);
  const item = (orderId) => d1.q("SELECT id FROM order_items WHERE orderId = ?", orderId)[0].id;
  const KEY = "receipts/2026/" + "b".repeat(32) + ".pdf";
  // Two sheets: 10 at $1.00 on Oct 1 (with its invoice), 10 at $2.00 on Oct 20 with 10% written off. O5 used one on Oct 25.
  const supplies = d1.q("SELECT id FROM expense_categories WHERE name LIKE 'Supplies%' LIMIT 1")[0].id;
  const acct = d1.q("SELECT id FROM accounts WHERE active=1 ORDER BY id LIMIT 1")[0].id;
  let r = await call({ action: "receiveTransferSheet", receivedAt: "2026-10-01", vendor: "Sample Transfer Co", vendorRef: "A-1", total: 10, accountId: acct,
    receiptKey: KEY, receiptName: "sheet-a.pdf", rows: [{ transferId: QR, count: 10, pctOfSheet: 100 }] });
  ok("first sheet received (by the owner)", r.status === 200);
  r = await call({ action: "receiveTransferSheet", receivedAt: "2026-10-20", vendor: "Sample Transfer Co", vendorRef: "B-2", total: 22.22, accountId: acct,
    rows: [{ transferId: QR, count: 10, pctOfSheet: 90 }], writeoff: { pct: 10, description: "misprints", categoryId: supplies } });
  ok("second sheet received, part of it written off", r.status === 200);
  d1._raw.run(`INSERT INTO transfer_movements (transferId, transferName, qtyDelta, unitCostCents, kind, orderId, itemId, note, occurredAt, createdAt) VALUES (?, 'Shop QR', -1, 150, 'consume', 'O5', ?, 'Used', '2026-10-25T15:00:00Z', 't')`, [QR, item("O5")]);
  const sheetA = d1.q("SELECT id FROM transfer_movements WHERE kind='purchase' AND vendorRef='A-1'")[0].id;
  const sheetB = d1.q("SELECT id FROM transfer_movements WHERE kind='purchase' AND vendorRef='B-2'")[0].id;

  // Two supplier orders, as placeSupplierOrder writes them (one placed, one refused).
  const lines = JSON.stringify([{ blankId: 1, blank: "Sample Tee", color: "Navy", size: "M", style: "ST-1", productId: "ST-1", partId: "P-1", qty: 12, unitCents: 425, restockQty: 0 }]);
  d1._raw.run(`INSERT INTO supplier_orders (connectionId, vendor, environment, poNumber, status, carrier, service, shipToJson, totalCents, linesJson, itemIdsJson, createdAt, createdBy, placedAt)
    VALUES (1, 'Sample Vendor', 'test', 'PO-1001', 'placed', 'UPS', 'Ground', '{}', 5100, ?, '[]', '2026-11-20T10:00:00Z', 'pat@example.test', '2026-11-20T10:00:00Z'),
           (1, 'Sample Vendor', 'test', 'PO-1002', 'failed', 'UPS', 'Ground', '{}', 2125, ?, '[]', '2026-11-21T10:00:00Z', 'pat@example.test', NULL)`, [lines, lines]);

  const SHEET_MONEY = /^(total|totalCents|stockCents|amount|perItem|cents|receiptKey|receiptName)$/;
  const CATCHUP_MONEY = /^(unitCost|cost|total|recostTotal)(Cents)?$/;
  const SO_MONEY = /^(total|totalCents|unitCents|price|priceCents)$/;
  const reads = async (as) => ({
    sheetA: (await call({ action: "getTransferSheet", movementId: sheetA }, as)).body,
    sheetB: (await call({ action: "getTransferSheet", movementId: sheetB }, as)).body,
    catchUp: (await call({ action: "previewTransferCatchUp" }, as)).body,
    orders: (await call({ action: "listSupplierOrders" }, as)).body,
    check: (await call({ action: "checkSupplierOrderShipments" }, as)).body,
  });
  const transfersRead = role("transfersRead", { "inventory.transfers": "read" });
  const transfersReadCosts = role("transfersReadCosts", { "inventory.transfers": "read", "costs.view": "read" });
  const transfersEdit = role("transfersEdit", { "inventory.transfers": "edit" });
  const ordersRead = role("ordersRead", { "inventory.supplierOrders": "read" });
  const ordersReadCosts = role("ordersReadCosts", { "inventory.supplierOrders": "read", "costs.view": "read" });
  const ordersEdit = role("ordersEdit", { "inventory.supplierOrders": "edit" });
  const ordersReadBlanksEdit = role("ordersReadBlanksEdit", { "inventory.supplierOrders": "read", "inventory.blanks": "edit" });
  const A = await reads(null);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  console.log("=== The owner's answers carry the money ===");
  ok("transfer sheet: total, rows' dollars and per-item price, the written-off amount and the invoice",
    A.sheetA.sheet.total === 10 && A.sheetA.sheet.rows[0].amount === 10 && A.sheetA.sheet.rows[0].perItem === 1 && A.sheetA.sheet.receiptKey === KEY &&
    A.sheetB.sheet.writeoff && A.sheetB.sheet.writeoff.amount > 0 && typeof A.sheetB.sheet.writeoff.cents === "number");
  const o2 = (body) => (body.lines || []).find(l => l.orderId === "O2");
  ok("transfer catch-up: O2's cost and unit cost, the total and the re-cost amount", o2(A.catchUp) && o2(A.catchUp).cost === 1 && o2(A.catchUp).uses[0].unitCost === 1 &&
    A.catchUp.total === 1 && A.catchUp.recostLines === 1 && typeof A.catchUp.recostTotal === "number" && A.catchUp.recostTotal !== 0);
  ok("supplier orders: each total and line price", A.orders.orders.length === 2 && A.orders.orders[0].total === 21.25 && A.orders.orders[1].total === 51 &&
    A.orders.orders[1].lines[0].unitCents === 425 && A.check.orders.length === 2 && A.check.checked === 1);

  console.log("\n=== Read on Transfers without costs.view: the sheet and the catch-up without money ===");
  const T = await reads(transfersRead);
  ok("getTransferSheet answers (200) with the sheet's rows, counts, % of sheet, vendor and date", T.sheetA.status === "ok" && T.sheetA.sheet.rows[0].count === 10 &&
    T.sheetA.sheet.rows[0].pctOfSheet === 100 && T.sheetA.sheet.vendor === "Sample Transfer Co" && T.sheetA.sheet.date === "2026-10-01" && T.sheetA.sheet.rows[0].transferId === QR);
  ok("…and no total, row dollars, per-item price or invoice", moneyKeys(T.sheetA.sheet, SHEET_MONEY).length === 0);
  ok("…the written-off part keeps its % and description, not its amount", T.sheetB.sheet.writeoff && T.sheetB.sheet.writeoff.pct === A.sheetB.sheet.writeoff.pct &&
    T.sheetB.sheet.writeoff.description === "misprints" && !("amount" in T.sheetB.sheet.writeoff) && !("cents" in T.sheetB.sheet.writeoff) && moneyKeys(T.sheetB.sheet, SHEET_MONEY).length === 0);
  ok("previewTransferCatchUp: the same lines, counts and how many would be re-costed", T.catchUp.status === "ok" && o2(T.catchUp) && o2(T.catchUp).uses[0].qty === 1 &&
    T.catchUp.lines.length === A.catchUp.lines.length && T.catchUp.totalUnits === A.catchUp.totalUnits && T.catchUp.recostLines === 1);
  ok("…without any cost, unit cost, total or re-cost amount", moneyKeys(T.catchUp, CATCHUP_MONEY).length === 0);
  const TC = await reads(transfersReadCosts), TE = await reads(transfersEdit);
  ok("with costs.view: the sheet and the catch-up as the owner's", same(TC.sheetA, A.sheetA) && same(TC.sheetB, A.sheetB) && same(TC.catchUp, A.catchUp));
  ok("with Edit on Transfers: the same", same(TE.sheetA, A.sheetA) && same(TE.sheetB, A.sheetB) && same(TE.catchUp, A.catchUp));

  console.log("\n=== Read on Supplier orders without costs.view: the orders without their totals or prices ===");
  const S = await reads(ordersRead);
  ok("listSupplierOrders answers with both orders, their PO, status, supplier and pieces", S.orders.status === "ok" && S.orders.orders.map(o => o.poNumber).join() === "PO-1002,PO-1001" &&
    S.orders.orders[1].status === "placed" && S.orders.orders[1].vendor === "Sample Vendor" && S.orders.orders[1].lines[0].qty === 12);
  ok("…and no total or line price", moneyKeys(S.orders.orders, SO_MONEY).length === 0);
  ok("checkSupplierOrderShipments: what was checked, and the orders without totals or prices", S.check.status === "ok" && S.check.checked === 1 && S.check.orders.length === 2 &&
    moneyKeys(S.check, SO_MONEY).length === 0);
  const SC = await reads(ordersReadCosts), SE = await reads(ordersEdit), SB = await reads(ordersReadBlanksEdit);
  ok("with costs.view: as the owner's", same(SC.orders, A.orders) && same(SC.check, A.check));
  ok("with Edit on Supplier orders: as the owner's", same(SE.orders, A.orders) && same(SE.check, A.check));
  ok("Read there with Edit on Blanks (Receive… fills in its prices): as the owner's", same(SB.orders, A.orders) && same(SB.check, A.check));
  ok("…and Read on Transfers alone doesn't open supplier orders at all", T.orders.status === "error" && S.sheetA.status === "error");

  console.log("\n=== The pages show a dash where the amount was left out ===");
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");
  const soHtml = new Function("escapeHtml", "adminDay_", cut("const SUPPLIER_ORDER_STATUS_", "// Receive order, filled in from a placed supplier order") + "\nreturn supplierOrdersHtml_;")(esc, (s) => String(s || "").slice(0, 10));
  const stripped = soHtml(S.orders.orders), full = soHtml(A.orders.orders);
  const totals = (html) => [...html.matchAll(/<td style="[^"]*text-align:right;">([^<]*)<\/td>/g)].map(m => m[1]);
  ok("Supplier orders list: the Total column is — for each order, never $0.00 or NaN", totals(stripped).join() === "—,—" && !/\$|NaN|undefined/.test(stripped));
  ok("…and the owner's shows the totals", totals(full).join() === "$21.25,$51.00");
  const moneyFns = cut("function adminMoney_(n){", "// A stored date for display.");
  const fmt = new Function(moneyFns + "\n" + cut("  // Read on Transfers without costs.view gets the preview", "  const { ov, close } = inventoryModal_(\"Use transfers for past orders\"") + "\nreturn fmt;")();
  const u = T.catchUp.lines[0].uses[0];
  ok("Use transfers for past orders: a use's price and a sum over it are —, never $NaN", fmt(u.unitCost) === "—" && fmt(u.unitCost * u.qty) === "—" && fmt(1.5) === "$1.50" && fmt(0) === "$0.00");
  const tcu = cut("async function showTransferCatchUp_(onDone, filter){", "\nconst WRITEOFF_REASONS_");
  ok("…and the re-cost sentence leaves its amount out when there is none", /\$\{d\.recostTotal == null \? "" : `, \$\{d\.recostTotal >= 0 \? "\+" : "−"\}\$\{fmt\(Math\.abs\(d\.recostTotal\)\)\}`\}/.test(tcu));
  const sheetForm = cut("function showTransferSheetModal_(transfers, onDone, existing){", "  hideBookkeepingFields_(ov, [\"#trPaid\"");
  ok("Edit transfer sheet: a sheet without its total leaves the box empty (no NaN), and the dollar columns read —",
    /value="\$\{ed && ed\.total != null \? Number\(ed\.total\)\.toFixed\(2\) : ""\}"/.test(sheetForm) &&
    /const noTotal = ov\.querySelector\("#trTotal"\)\.value\.trim\(\) === "";/.test(sheetForm) &&
    /\.trRowDollars"\)\.textContent = noTotal \? "—" :/.test(sheetForm) && !/value="\$\{ed \? Number\(ed\.total\)/.test(sheetForm));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})().catch((e) => { console.log("test296 crashed:", false); console.error(e); process.exit(1); });
