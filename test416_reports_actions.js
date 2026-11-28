process.env.TZ = "UTC";
const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { ok } = require("./testlib/check");
const roles = require("./testlib/roles");

// The phase 8 admin actions, through the real orders.js handler (with the real db.js, quickbooks.js and permissions.js
// on sql.js):
//   getSalesReport        Sales by customer / product / shop / decoration (reports.sales Read; always on)
//   getProfitReport       Profit per job (reports.profit Read AND costs.view; always on)
//   getOrderProfit        one order's profit, for the order window (costs.view Read AND orders.details Read; always on)
//   getGiftCardLiability  sold, spent and outstanding on gift cards by month (giftcards.cards Read; the Gift cards switch)
//   getQuickBooksSettings / updateQuickBooksSettings / getQuickBooksExport  the account mapping and the Online CSV or
//                         Desktop IIF files (reports.quickbooks Read, the mapping Edit; the Bookkeeping switch)
// Each one's checks (dates, from <= to, at most three years, its lists), every built-in role and nobody signed in, a
// custom role with Profit per job but no costs.view, the feature switches, the audit rows, the permissions.js entries
// and NO_MONTH_ACTIONS. "Now" is fixed (2026-04-15 17:00 UTC) inside the code under test and the business is in
// America/Chicago, so nothing depends on the machine's date or zone. Invented shops, people and amounts only.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/^import "[^"\n]+";\n/gm, "")
  .replace(/export (async function|function|const)/g, "$1");
const NOW = Date.parse("2026-04-15T17:00:00.000Z");
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(NOW); }
  static now() { return NOW; }
}
globalThis.__FixedDate416 = FixedDate;
// Who is signed in: a built-in role's key, a custom role's key (globalThis.__roles416), or nobody ("none").
// The switches: globalThis.__features416 (what the cached catalog carries).
globalThis.__roles416 = {};
globalThis.__features416 = {};
const ordersJs = read("functions/api/orders.js");
const glue = () => new Function("const Date = globalThis.__FixedDate416;\n" +
  strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  read("functions/_lib/permissions.js").replace(/export (async function|function|const)/g, "$1") + "\n" +
  "const roleOf416_ = (request) => { const k = request.headers.get('x-role') || 'admin'; return DEFAULT_ROLES[k] || globalThis.__roles416[k] || null; };\n" +
  "const requireAdmin = async (env, host, key, request, msg, need) => roleAllows(roleOf416_(request), need === 'staff' ? '*' : need) ? null : new Response(JSON.stringify({ status: 'error', code: 'forbidden' }), { status: 403 });\n" +
  "const adminActor = (request) => (request.headers.get('x-role') || 'admin') + '@example.test';\n" +
  "const adminUser = (request) => { const r = roleOf416_(request); return r ? { id: 1, email: r.key + '@example.test', name: r.name, role: r.key, roleInfo: r, pending: null, bootstrap: false } : null; };\n" +
  "const adminLevel = (request, fn) => effectiveLevel(roleOf416_(request), fn);\n" +
  "const adminCan = (request, fn, level) => { const rk = (l) => l === 'full' ? 3 : l === 'edit' ? 2 : l === 'read' ? 1 : 0; return rk(adminLevel(request, fn)) >= rk(level || 'read'); };\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {}, features: globalThis.__features416 });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  strip(read("functions/_lib/db.js")) + "\n" + strip(read("functions/_lib/quickbooks.js")) + "\n" + strip(ordersJs) +
  "\nconst realBuild416 = buildQuickBooksExport;\n" +
  "return { post: onRequestPost, getSalesReport, getProfitReport, getOrderProfit, getGiftCardLiability, getQuickBooksSettings, getQuickBooksData, iifBalanced, qbSummary,\n" +
  "  setBuild: (f) => { buildQuickBooksExport = f; }, restoreBuild: () => { buildQuickBooksExport = realBuild416; } };")();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const migrations = fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort();
const fresh = async (upTo) => {
  const d = await createD1();
  d._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of migrations.filter(f => !upTo || f < upTo)) d.execFile(read("migrations/" + f));
  d._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('club','club','Example Club','t','t',1);
    INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('school','school','Example School District','t','t',1);
    INSERT INTO global_settings (key, value) VALUES ('locale', '{"timeZone":"America/Chicago","country":"US"}');`);
  return d;
};
const callOn = (L, d1) => async (body, role = "admin") => {
  const pending = [];
  const res = await L.post({ env: { DB: d1 }, waitUntil: (p) => { pending.push(Promise.resolve(p).catch(() => {})); },
    request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: (h) => h.toLowerCase() === "x-role" ? role : null } } });
  await Promise.all(pending);
  const text = await res.text();
  let parsed; try { parsed = JSON.parse(text); } catch (_) { parsed = text; }
  return { status: res.status, body: parsed };
};
const q = (s) => s == null ? "NULL" : "'" + String(s).replace(/'/g, "''") + "'";
const audits = (d1, action) => (d1._raw.exec(`SELECT orgId, orderId, action, detail, actor FROM audit_log WHERE action = ${q(action)} ORDER BY id`)[0] || { values: [] }).values
  .map(([orgId, orderId, a, detail, actor]) => ({ orgId, orderId, action: a, detail: JSON.parse(detail || "null"), actor }));
const storedQb = (d1) => { const r = d1._raw.exec("SELECT value FROM global_settings WHERE key = 'quickbooks'")[0]; return r ? JSON.parse(r.values[0][0]) : null; };
process.on("unhandledRejection", (e) => { console.error(e); ok("nothing in the test was left to fail unseen", false); });
let finished = false;
process.on("exit", () => { if (!finished) { console.log("the test ran to its end: false"); process.exitCode = 1; } });

// The custom roles: one with Profit per job (and Sales by…, and orders) but not costs.view; one that also has costs.view;
// one with costs.view but no orders.
const fnsOf = (set) => Object.assign(Object.fromEntries(roles.PERM_FUNCTIONS.map(k => [k, "none"])), set);
const custom = (key, name, set) => ({ key, name, rank: 40, builtIn: false, locked: false, permissions: { menus: {}, items: {}, fns: fnsOf(set), costsApart: true } });
globalThis.__roles416 = {
  profitNoCosts: custom("profitNoCosts", "Report reader", { "reports.profit": "full", "reports.sales": "read", "orders.details": "read" }),
  profitCosts: custom("profitCosts", "Costing clerk", { "reports.profit": "read", "costs.view": "read", "orders.details": "read" }),
  costsNoOrders: custom("costsNoOrders", "Pricing only", { "costs.view": "read" }),
  qbEditor: custom("qbEditor", "Bookkeeper", { "reports.quickbooks": "edit" }),
};
const WHO = { admin: "Admin", manager: "Manager", staff: "Back office", production: "Production", none: "nobody signed in" };

(async () => {
  const L = glue();
  const d1 = await fresh();
  const call = callOn(L, d1);
  // ---- The data: orders sold (shipped) at the edges of March on Chicago's clock, a gift card order, a card payment,
  // an expense, a Stripe payout, and gift cards sold, given and spent ----
  d1._raw.exec(`INSERT INTO customers (id, name, company, email, createdAt, updatedAt) VALUES (1, 'Pat Example', 'Example School District', 'pat@example.com', 't', 't');
    INSERT INTO products (productId, orgId, type, name, createdAt, updatedAt, suppliesCostCents, decorationType) VALUES ('tee', 'club', 'shirt', 'Club Tee', 't', 't', 300, 'screenprint');
    INSERT INTO products (productId, orgId, type, name, createdAt, updatedAt, decorationType) VALUES ('cap', 'school', 'hat', 'School Cap', 't', 't', 'embroidery');
    INSERT INTO expense_categories (id, name, deductionType, createdAt, updatedAt) VALUES (900, 'Example supplies', 'deductible', 't', 't');
    INSERT INTO expense_categories (id, name, deductionType, createdAt, updatedAt) VALUES (901, 'Another category', 'deductible', 't', 't');`);
  const seed = (o) => {
    d1._raw.exec(`INSERT INTO orders (orderId, orgId, customerId, customerName, contact, placedAt, shippedAt, voidedAt, isTest, shippingCostCents, discountCents, taxMode)
      VALUES (${q(o.id)}, ${q(o.org || "club")}, ${o.cust == null ? "NULL" : o.cust}, 'Sam Sample', 'sam@example.com', ${q(o.placedAt || "2026-02-20T18:00:00.000Z")}, ${q(o.shippedAt)}, NULL, 0,
        ${o.shipping || 0}, 0, 'exclusive')`);
    for (const it of o.items) d1._raw.exec(`INSERT INTO order_items (orderId, orgId, productId, name, type, size, qty, lineTotalCents, taxCents, manufacturedQty, taxable)
      VALUES (${q(o.id)}, ${q(o.org || "club")}, ${q(it.p)}, ${q(it.name || "Line")}, 'shirt', 'M', ${it.qty || 1}, ${it.c}, 0, ${it.qty || 1}, 1)`);
  };
  seed({ id: "EDGE-0", shippedAt: "2026-03-01T05:59:59.000Z", items: [{ p: "tee", c: 9900 }] });             // 11:59:59 pm Feb 28 in Chicago
  seed({ id: "EDGE-1", cust: 1, shippedAt: "2026-03-01T06:00:00.000Z", shipping: 500, items: [{ p: "tee", c: 5000, qty: 2, name: "Club Tee" }] });   // midnight Mar 1
  seed({ id: "EDGE-2", org: "school", shippedAt: "2026-04-01T04:59:59.000Z", items: [{ p: "cap", c: 2000, name: "School Cap" }] });                 // 11:59:59 pm Mar 31 (CDT)
  seed({ id: "EDGE-3", org: "school", shippedAt: "2026-04-01T05:00:00.000Z", items: [{ p: "cap", c: 7700 }] });   // midnight Apr 1
  seed({ id: "GIFT-1", shippedAt: "2026-03-10T18:00:00.000Z", items: [{ p: "__giftcard__", c: 2500, name: "Gift card" }] });
  const accts = d1._raw.exec("SELECT id, name, type, active FROM accounts ORDER BY id")[0].values;
  const idOf = (type) => (accts.find(a => a[2] === type) || [])[0];
  const STRIPE = idOf("stripe"), CHECKING = idOf("checking");
  d1._raw.exec(`INSERT INTO order_payments (orderId, amountCents, receivedAt, kind, method, accountId, feeCents) VALUES ('EDGE-1', 5500, '2026-03-02T18:00:00.000Z', 'payment', 'card', ${STRIPE}, 335);
    INSERT INTO account_transfers (id, transferDate, fromAccountId, toAccountId, amountCents, note, externalRef, createdAt, updatedAt) VALUES (1, '2026-03-06', ${STRIPE}, ${CHECKING}, 5165, 'Stripe payout', 'po_1', 't', 't');
    INSERT INTO expenses (expenseDate, description, categoryId, amountCents, vendor, createdAt, updatedAt, accountId) VALUES ('2026-03-09', 'Thread', 900, 4200, 'Example Vendor', 't', 't', ${CHECKING});
    INSERT INTO gift_cards (id, code, last4, initialCents, balanceCents, sourceOrderId, status, createdAt) VALUES (1, 'EXAMPLECARDAAAA', 'AAAA', 2500, 2000, 'GIFT-1', 'active', '2026-03-10T18:00:00.000Z');
    INSERT INTO gift_cards (id, code, last4, initialCents, balanceCents, sourceOrderId, status, createdAt) VALUES (2, 'EXAMPLECARDBBBB', 'BBBB', 1000, 1000, '', 'active', '2026-02-27T18:00:00.000Z');
    INSERT INTO gift_card_ledger (cardId, kind, deltaCents, at) VALUES (2, 'issue', 1000, '2026-02-27T18:00:00.000Z');
    INSERT INTO gift_card_ledger (cardId, kind, deltaCents, at) VALUES (1, 'issue', 2500, '2026-03-10T18:00:00.000Z');
    INSERT INTO gift_card_ledger (cardId, kind, deltaCents, at) VALUES (1, 'redeem', -500, '2026-04-01T04:59:59.000Z');`);
  const MARCH = { dateFrom: "2026-03-01", dateTo: "2026-03-31" };

  console.log("=== The permissions: three new items under Reports, and where the two other actions live ===");
  {
    const reportItems = roles.PERMISSION_AREAS.find(m => m.key === "reports").items;
    const it = (hash) => reportItems.find(i => i.hash === hash);
    ok("Reports has Sales by… (salesby, reports.sales), Profit per job (profit, reports.profit) and QuickBooks export (quickbooks, reports.quickbooks)",
      same(it("salesby"), { hash: "salesby", label: "Sales by…", fns: [["reports.sales", "Sales by customer, product, shop and decoration"]] }) &&
      same(it("profit"), { hash: "profit", label: "Profit per job", fns: [["reports.profit", "Profit per job"]] }) &&
      same(it("quickbooks"), { hash: "quickbooks", label: "QuickBooks export", fns: [["reports.quickbooks", "QuickBooks export"]] }));
    const hashes = reportItems.map(i => i.hash);
    ok("they come after Unpaid POs and before Periods and export, in that order",
      same(hashes.slice(hashes.indexOf("unpaidpos"), hashes.indexOf("books") + 1), ["unpaidpos", "salesby", "profit", "quickbooks", "books"]));
    ok("the three are functions a role can be given", ["reports.sales", "reports.profit", "reports.quickbooks"].every(f => roles.PERM_FUNCTIONS.includes(f)));
    ok("each action asks for exactly its function and level",
      same(roles.ACTION_PERM.getSalesReport, [["reports.sales", "read"]]) && same(roles.ACTION_PERM.getProfitReport, [["reports.profit", "read"]]) &&
      same(roles.ACTION_PERM.getOrderProfit, [["costs.view", "read"]]) && same(roles.ACTION_PERM.getGiftCardLiability, [["giftcards.cards", "read"]]) &&
      same(roles.ACTION_PERM.getQuickBooksSettings, [["reports.quickbooks", "read"]]) && same(roles.ACTION_PERM.updateQuickBooksSettings, [["reports.quickbooks", "edit"]]) &&
      same(roles.ACTION_PERM.getQuickBooksExport, [["reports.quickbooks", "read"]]));
    const lv = (role) => { const p = roles.effectivePermissions(roles.DEFAULT_ROLES[role]); return [p["reports.sales"], p["reports.profit"], p["reports.quickbooks"]].join(" "); };
    ok("by default Admin and Manager have all three in full", lv("admin") === "full full full" && lv("manager") === "full full full");
    ok("Back office reads the QuickBooks export only (no sales by…, no profit)", lv("staff") === "none none read");
    ok("Production has none of them", lv("production") === "none none none");
    ok("none of the built-in roles but Admin and Manager sees costs (so Profit per job is theirs)",
      ["staff", "production"].every(r => roles.effectivePermissions(roles.DEFAULT_ROLES[r])["costs.view"] === "none"));
  }

  console.log("\n=== The switches and the closed months ===");
  {
    const names = (text) => [...text.matchAll(/"(\w+)"/g)].map(m => m[1]);
    const feat = ordersJs.match(/const FEATURE_ACTIONS = \{([\s\S]*?)\n\};/)[1];
    const book = names(feat.match(/bookkeeping: \[([\s\S]*?)\],/)[1]), gift = names(feat.match(/giftCards: \[([\s\S]*?)\],/)[1]), all = names(feat);
    ok("the QuickBooks actions are Bookkeeping's", ["getQuickBooksSettings", "updateQuickBooksSettings", "getQuickBooksExport"].every(a => book.includes(a)));
    ok("the Gift card liability report is the Gift cards switch's", gift.includes("getGiftCardLiability"));
    ok("Sales by…, Profit per job and an order's profit are behind no switch", ["getSalesReport", "getProfitReport", "getOrderProfit"].every(a => !all.includes(a)));
    const noMonth = names(ordersJs.match(/const NO_MONTH_ACTIONS = new Set\(\[([\s\S]*?)\]\);/)[1]);
    ok("saving the QuickBooks account names changes no month's numbers (NO_MONTH_ACTIONS)", noMonth.includes("updateQuickBooksSettings"));
  }

  console.log("\n=== Who may ask: each built-in role and nobody signed in ===");
  {
    // [sales, profit, orderProfit, liability, qbSettings, qbSave, qbExport]
    const want = { admin: [200, 200, 200, 200, 200, 200, 200], manager: [200, 200, 200, 200, 200, 200, 200],
      staff: [403, 403, 403, 200, 200, 403, 200], production: [403, 403, 403, 403, 403, 403, 403], none: [403, 403, 403, 403, 403, 403, 403] };
    for (const role of Object.keys(want)) {
      const got = [];
      got.push((await call({ action: "getSalesReport", ...MARCH }, role)).status);
      got.push((await call({ action: "getProfitReport", ...MARCH }, role)).status);
      got.push((await call({ action: "getOrderProfit", orderId: "EDGE-1" }, role)).status);
      got.push((await call({ action: "getGiftCardLiability", ...MARCH }, role)).status);
      got.push((await call({ action: "getQuickBooksSettings" }, role)).status);
      got.push((await call({ action: "updateQuickBooksSettings", settings: { salesAs: "receipts" } }, role)).status);
      got.push((await call({ action: "getQuickBooksExport", ...MARCH, summaryOnly: true }, role)).status);
      const yn = (i) => (want[role][i] === 200 ? "allowed" : "refused");
      ok(`${WHO[role]}: Sales by… ${yn(0)}, Profit per job ${yn(1)}, an order's profit ${yn(2)}, Gift card liability ${yn(3)}, ` +
        `the QuickBooks export ${yn(6)} and its mapping read ${yn(4)}, saving the mapping ${yn(5)}`, same(got, want[role]));
    }
    const r = await call({ action: "getSalesReport", ...MARCH }, "none");
    ok("a refusal for nobody signed in says only that it's forbidden (no report in it)", r.body.code === "forbidden" && !("rows" in r.body));
    const nothingSaved = await fresh(); const callN = callOn(L, nothingSaved);
    await callN({ action: "updateQuickBooksSettings", settings: { format: "desktop" } }, "staff");
    await callN({ action: "getQuickBooksExport", ...MARCH }, "production");
    ok("a refused save stores nothing and a refused export writes no audit row",
      storedQb(nothingSaved) === null && audits(nothingSaved, "settings.quickbooks").length === 0 && audits(nothingSaved, "report.quickbooks_export").length === 0);
  }

  console.log("\n=== A custom role with Profit per job but not costs.view ===");
  {
    let r = await call({ action: "getProfitReport", ...MARCH }, "profitNoCosts");
    ok("Profit per job is refused: 403, \"You can't see costs.\"", r.status === 403 && r.body.code === "forbidden" && r.body.message === "You can't see costs." && !("rows" in r.body));
    r = await call({ action: "getProfitReport", dateFrom: "bad", dateTo: "2026-03-31" }, "profitNoCosts");
    ok("…before its dates are even looked at (a bad date is still the costs refusal)", r.status === 403 && r.body.message === "You can't see costs.");
    r = await call({ action: "getOrderProfit", orderId: "EDGE-1" }, "profitNoCosts");
    ok("an order's profit is refused too, at sign-in (costs.view is what it asks for)", r.status === 403 && r.body.code === "forbidden" && !("profit" in r.body));
    r = await call({ action: "getSalesReport", ...MARCH }, "profitNoCosts");
    ok("Sales by… shows no costs, so the same role gets it", r.status === 200 && r.body.status === "ok" && r.body.rows.length > 0);
    r = await call({ action: "getProfitReport", ...MARCH }, "profitCosts");
    ok("with costs.view added (Read), Profit per job is answered", r.status === 200 && r.body.status === "ok" && r.body.rows.length === 2);
    r = await call({ action: "getOrderProfit", orderId: "EDGE-1" }, "profitCosts");
    ok("…and so is an order's profit (it can open orders)", r.status === 200 && r.body.profit && r.body.profit.orderId === "EDGE-1");
    r = await call({ action: "getOrderProfit", orderId: "EDGE-1" }, "costsNoOrders");
    ok("costs.view without opening orders: an order's profit is refused, \"Your role can't open orders. Ask an admin.\"",
      r.status === 403 && r.body.code === "forbidden" && r.body.message === "Your role can't open orders. Ask an admin." && !("profit" in r.body));
    r = await call({ action: "getOrderProfit", orderId: "!!" }, "costsNoOrders");
    ok("…even for an order number that isn't valid (the role is checked first)", r.status === 403 && r.body.message === "Your role can't open orders. Ask an admin.");
    r = await call({ action: "getProfitReport", ...MARCH }, "costsNoOrders");
    ok("costs.view alone doesn't open Profit per job", r.status === 403 && r.body.code === "forbidden");
    r = await call({ action: "updateQuickBooksSettings", settings: { customerName: "shop" } }, "qbEditor");
    ok("a role with the QuickBooks export at Edit saves the account mapping", r.status === 200 && r.body.settings.customerName === "shop");
    await call({ action: "updateQuickBooksSettings", settings: { customerName: "customer" } });
  }

  console.log("\n=== The dates: YYYY-MM-DD, from on or before to, at most three years ===");
  {
    const dated = [["getSalesReport", {}], ["getProfitReport", {}], ["getGiftCardLiability", {}], ["getQuickBooksExport", { summaryOnly: true }]];
    for (const [action, extra] of dated) {
      const ask = (dates) => call({ action, ...extra, ...dates });
      const bad = [{}, { dateFrom: "2026-03-01" }, { dateTo: "2026-03-31" }, { dateFrom: "2026-3-1", dateTo: "2026-03-31" }, { dateFrom: "2026-02-30", dateTo: "2026-03-31" },
        { dateFrom: "2026-03-01", dateTo: "2026-03-31T00:00" }, { dateFrom: 20260301, dateTo: "2026-03-31" }];
      const refusals = await Promise.all(bad.map(ask));
      ok(`${action}: missing, short, impossible (Feb 30) or timed dates are refused, "Invalid date range — expected YYYY-MM-DD"`,
        refusals.every(r => r.status === 400 && r.body.status === "error" && r.body.message === "Invalid date range — expected YYYY-MM-DD"));
      let r = await ask({ dateFrom: " 2026-03-01 ", dateTo: "2026-03-31 " });
      ok(`${action}: spaces around the days are trimmed`, r.status === 200 && r.body.dateFrom === "2026-03-01" && r.body.dateTo === "2026-03-31");
      r = await ask({ dateFrom: "2026-03-02", dateTo: "2026-03-01" });
      ok(`${action}: a start after the end is refused, "The start date is after the end date."`, r.status === 400 && r.body.message === "The start date is after the end date.");
      r = await ask({ dateFrom: "2026-03-01", dateTo: "2026-03-01" });
      ok(`${action}: one day (from = to) is fine`, r.status === 200);
      r = await ask({ dateFrom: "2024-01-01", dateTo: "2026-12-31" });
      ok(`${action}: three years less a day (2024-01-01 to 2026-12-31) is fine`, r.status === 200);
      r = await ask({ dateFrom: "2024-01-01", dateTo: "2027-01-01" });
      ok(`${action}: three years to the day (to 2027-01-01) is refused, "Pick at most three years."`, r.status === 400 && r.body.message === "Pick at most three years.");
    }
    let r = await call({ action: "getSalesReport", dateFrom: "2024-02-29", dateTo: "2027-02-28" });
    ok("from a 29 February, the 28th three years on is still allowed", r.status === 200);
    r = await call({ action: "getSalesReport", dateFrom: "2024-02-29", dateTo: "2027-03-01" });
    ok("…and 1 March is refused", r.status === 400 && r.body.message === "Pick at most three years.");
  }

  console.log("\n=== getSalesReport ===");
  {
    let r = await call({ action: "getSalesReport", ...MARCH });
    ok("with no grouping it groups by customer", r.status === 200 && r.body.status === "ok" && r.body.by === "customer");
    ok("the days are the business's (Chicago): sold at midnight March 1 and at 11:59:59 pm March 31 are in, a second either side is out",
      r.body.totals.orders === 2 && r.body.totals.grossCents === 7000);
    ok("the gift card order is no sale here", r.body.totals.grossCents === 7000 && !r.body.rows.some(x => /Gift/.test(x.label)));
    const direct = await L.getSalesReport(d1, { ...MARCH, by: "customer" });
    ok("the answer is db.js's report as it is, with orgId null when no shop was asked",
      same(r.body.rows, direct.rows) && same(r.body.totals, direct.totals) && r.body.basis === direct.basis && r.body.dateFrom === "2026-03-01" && r.body.dateTo === "2026-03-31" && r.body.orgId === null);
    ok("by customer: Pat Example (the customer record) and an order with no record, by its contact",
      same(r.body.rows.map(x => [x.label, x.netCents]), [["Pat Example", 5000], ["No customer record: sam@example.com", 2000]]));
    r = await call({ action: "getSalesReport", ...MARCH, by: "" });
    ok("an empty grouping is by customer too", r.status === 200 && r.body.by === "customer");
    for (const [by, labels] of [["product", ["Club Tee", "School Cap"]], ["shop", ["Example Club", "Example School District"]], ["decoration", ["Screen print", "Embroidery"]]]) {
      r = await call({ action: "getSalesReport", ...MARCH, by });
      ok(`by ${by}: ${labels.join(" and ")}`, r.status === 200 && r.body.by === by && same(r.body.rows.map(x => x.label), labels));
    }
    for (const by of ["color", "Customer", "customers", 7]) {
      r = await call({ action: "getSalesReport", ...MARCH, by });
      ok(`grouping by ${JSON.stringify(by)} is refused, "Group by customer, product, shop or decoration."`, r.status === 400 && r.body.message === "Group by customer, product, shop or decoration.");
    }
    r = await call({ action: "getSalesReport", ...MARCH, by: "shop", orgId: "school" });
    ok("orgId narrows it to one shop, and the answer names it", r.status === 200 && r.body.orgId === "school" && same(r.body.rows.map(x => x.label), ["Example School District"]) && r.body.totals.orders === 1);
    r = await call({ action: "getSalesReport", ...MARCH, by: "shop", org: "club" });
    ok("org works as well as orgId", r.status === 200 && r.body.orgId === "club" && same(r.body.rows.map(x => x.label), ["Example Club"]));
    r = await call({ action: "getSalesReport", ...MARCH, by: "shop", orgId: "school", org: "club" });
    ok("orgId wins over org", r.status === 200 && r.body.orgId === "school");
    r = await call({ action: "getSalesReport", ...MARCH, by: "shop", orgId: "", org: "club" });
    ok("an empty orgId falls back to org", r.status === 200 && r.body.orgId === "club");
    r = await call({ action: "getSalesReport", ...MARCH, orgId: "nowhere" });
    ok("an unknown shop is refused, 404 \"Unknown shop\"", r.status === 404 && r.body.message === "Unknown shop");
    r = await call({ action: "getSalesReport", ...MARCH, orgId: 5 });
    ok("a shop that isn't text is refused, \"That shop isn't valid.\"", r.status === 400 && r.body.message === "That shop isn't valid.");
    r = await call({ action: "getSalesReport", ...MARCH, by: "nope", orgId: "nowhere" });
    ok("the grouping is checked before the shop", r.status === 400 && r.body.message === "Group by customer, product, shop or decoration.");
    r = await call({ action: "getSalesReport", dateFrom: "x", dateTo: "y", by: "nope" });
    ok("the dates are checked before the grouping", r.status === 400 && r.body.message === "Invalid date range — expected YYYY-MM-DD");
    r = await call({ action: "getSalesReport", ...MARCH }, "manager");
    ok("Manager gets the same report", r.status === 200 && same(r.body.totals, direct.totals));
  }

  console.log("\n=== getProfitReport ===");
  {
    let r = await call({ action: "getProfitReport", ...MARCH });
    const direct = await L.getProfitReport(d1, { ...MARCH, sort: "margin" });
    ok("sorted by margin when no sort is asked, and it says so", r.status === 200 && r.body.status === "ok" && r.body.sort === "margin");
    ok("the answer is db.js's report, with orgId null", same(r.body.rows, direct.rows) && same(r.body.totals, direct.totals) && r.body.orgId === null && r.body.basis === direct.basis);
    ok("the same two orders as Sales by… (the edges of the month on Chicago's clock; no gift card order)", same(r.body.rows.map(x => x.orderId).sort(), ["EDGE-1", "EDGE-2"]));
    ok("each row has revenue, its costs and profit in cents",
      r.body.rows.every(x => Number.isInteger(x.revenueCents) && Number.isInteger(x.costCents) && x.profitCents === x.revenueCents - x.costCents && x.costs && "cardFeesCents" in x.costs));
    ok("EDGE-1: goods and shipping are its revenue (5000 + 500), its card fee (335) and supplies (2 × 300) among its costs",
      (() => { const e = r.body.rows.find(x => x.orderId === "EDGE-1"); return e.revenueCents === 5500 && e.costs.cardFeesCents === 335 && e.costs.suppliesCents === 600; })());
    ok("lowest margin first", r.body.rows.length === 2 && r.body.rows[0].marginPct <= r.body.rows[1].marginPct);
    r = await call({ action: "getProfitReport", ...MARCH, sort: "" });
    ok("an empty sort is by margin too", r.status === 200 && r.body.sort === "margin");
    for (const sort of ["profit", "revenue", "date"]) {
      r = await call({ action: "getProfitReport", ...MARCH, sort });
      const d = await L.getProfitReport(d1, { ...MARCH, sort });
      ok(`sort ${sort}: answered in that order, and it says so`, r.status === 200 && r.body.sort === sort && same(r.body.rows.map(x => x.orderId), d.rows.map(x => x.orderId)));
    }
    r = await call({ action: "getProfitReport", ...MARCH, sort: "revenue" });
    ok("by revenue, EDGE-1 (5500) comes before EDGE-2 (2000)", same(r.body.rows.map(x => x.orderId), ["EDGE-1", "EDGE-2"]));
    r = await call({ action: "getProfitReport", ...MARCH, sort: "date" });
    ok("by date, newest (EDGE-2, March 31) first", same(r.body.rows.map(x => x.orderId), ["EDGE-2", "EDGE-1"]));
    for (const sort of ["cost", "Margin", 1]) {
      r = await call({ action: "getProfitReport", ...MARCH, sort });
      ok(`sorting by ${JSON.stringify(sort)} is refused, "Sort by margin, profit, revenue or date."`, r.status === 400 && r.body.message === "Sort by margin, profit, revenue or date.");
    }
    r = await call({ action: "getProfitReport", ...MARCH, orgId: "school" });
    ok("orgId narrows it to one shop", r.status === 200 && r.body.orgId === "school" && same(r.body.rows.map(x => x.orderId), ["EDGE-2"]));
    r = await call({ action: "getProfitReport", ...MARCH, org: "club" });
    ok("org works as well", r.status === 200 && r.body.orgId === "club" && same(r.body.rows.map(x => x.orderId), ["EDGE-1"]));
    r = await call({ action: "getProfitReport", ...MARCH, orgId: "nowhere" });
    ok("an unknown shop is refused, 404", r.status === 404 && r.body.message === "Unknown shop");
    r = await call({ action: "getProfitReport", ...MARCH, org: ["club"] });
    ok("a shop that isn't text is refused", r.status === 400 && r.body.message === "That shop isn't valid.");
    r = await call({ action: "getProfitReport", ...MARCH, sort: "nope", orgId: "nowhere" });
    ok("the sort is checked before the shop", r.status === 400 && r.body.message === "Sort by margin, profit, revenue or date.");
  }

  console.log("\n=== getOrderProfit ===");
  {
    let r = await call({ action: "getOrderProfit", orderId: "EDGE-1" });
    const direct = await L.getOrderProfit(d1, "EDGE-1");
    ok("one order's profit: db.js's answer under profit", r.status === 200 && r.body.status === "ok" && same(r.body.profit, direct));
    ok("…with revenue, every cost part (labor 0 for now), profit and margin",
      r.body.profit.revenueCents === 5500 && same(Object.keys(r.body.profit.costs).sort(), ["blanksCents", "cardFeesCents", "decorationCents", "digitizingCents", "laborCents", "postageCents", "suppliesCents", "transfersCents"]) &&
      r.body.profit.costs.laborCents === 0 && r.body.profit.profitCents === r.body.profit.revenueCents - r.body.profit.costCents);
    r = await call({ action: "getOrderProfit", orderId: "  EDGE-1 " });
    ok("the order number is trimmed", r.status === 200 && r.body.profit.orderId === "EDGE-1");
    r = await call({ action: "getOrderProfit", orderId: "EDGE-0" });
    ok("any order can be asked, whatever its date", r.status === 200 && r.body.profit.orderId === "EDGE-0");
    for (const bad of [undefined, "", "EDGE 1", "x".repeat(65), "EDGE-1;"]) {
      r = await call({ action: "getOrderProfit", orderId: bad });
      ok(`an order number like ${JSON.stringify(bad === undefined ? "(none)" : bad.length > 20 ? "65 letters" : bad)} is refused, "Invalid order ID"`, r.status === 400 && r.body.message === "Invalid order ID");
    }
    r = await call({ action: "getOrderProfit", orderId: "NO-SUCH-1" });
    ok("an order that doesn't exist: 404 \"Order not found\"", r.status === 404 && r.body.message === "Order not found");
    r = await call({ action: "getOrderProfit", orderId: "EDGE-1", org: "club" });
    ok("asked from its own shop: answered", r.status === 200 && r.body.profit.orderId === "EDGE-1");
    r = await call({ action: "getOrderProfit", orderId: "EDGE-1" }, "manager");
    ok("Manager gets it", r.status === 200 && same(r.body.profit, direct));
  }

  console.log("\n=== getGiftCardLiability ===");
  {
    let r = await call({ action: "getGiftCardLiability", ...MARCH });
    const direct = await L.getGiftCardLiability(d1, MARCH);
    ok("the answer is the range and db.js's months, totals and what cards hold now",
      r.status === 200 && r.body.status === "ok" && r.body.dateFrom === "2026-03-01" && r.body.dateTo === "2026-03-31" &&
      same(r.body.months, direct.months) && same(r.body.totals, direct.totals) && r.body.outstandingNowCents === direct.outstandingNowCents);
    ok("March opens with the card given in February (1000), sells 2500 and closes 3500 (the spend at 11:59:59 pm March 31 Chicago is in March)",
      r.body.months.length === 1 && r.body.months[0].openingCents === 1000 && r.body.months[0].soldCents === 2500 && r.body.months[0].redeemedCents === 500 && r.body.months[0].closingCents === 3000);
    ok("cards hold 3000 now", r.body.outstandingNowCents === 3000);
    r = await call({ action: "getGiftCardLiability", dateFrom: "2026-02-01", dateTo: "2026-04-30" });
    ok("a range of three months gives three months, February to April", r.status === 200 && same(r.body.months.map(m => m.month), ["2026-02", "2026-03", "2026-04"]) && r.body.months[0].issuedCents === 1000);
    r = await call({ action: "getGiftCardLiability", ...MARCH }, "staff");
    ok("Back office (gift cards at Edit) reads it", r.status === 200 && same(r.body.months, direct.months));
    const old = await fresh("0120"), callOld = callOn(L, old);
    r = await callOld({ action: "getGiftCardLiability", ...MARCH });
    ok("before gift cards existed (before migrations/0120): an empty month, nothing held, no error",
      r.status === 200 && r.body.months.length === 1 && r.body.months[0].closingCents === 0 && r.body.outstandingNowCents === 0);
  }

  console.log("\n=== getQuickBooksSettings ===");
  {
    let r = await call({ action: "getQuickBooksSettings" }, "staff");
    const direct = await L.getQuickBooksSettings(d1);
    ok("Back office reads the mapping: quickbooks and settings are the same, the defaults filled in",
      r.status === 200 && r.body.status === "ok" && same(r.body.quickbooks, direct) && same(r.body.settings, direct) && r.body.settings.accounts.sales === "Sales" &&
      r.body.settings.accounts.cardFees === "Merchant Fees" && r.body.settings.format === "online");
    ok("it carries the app's own bank accounts (id, name, type, active) in id order, so the page needs no Finance permission",
      same(r.body.accounts, accts.map(([id, name, type, active]) => ({ id, name, type, active: !!active }))));
    ok("…and the expense categories by name", same(r.body.categories.filter(c => c.id >= 900), [{ id: 901, name: "Another category" }, { id: 900, name: "Example supplies" }]) &&
      r.body.categories.map(c => c.name).join("|") === r.body.categories.map(c => c.name).slice().sort((a, b) => a < b ? -1 : a > b ? 1 : 0).join("|"));
    d1._raw.exec(`UPDATE accounts SET active = 0 WHERE id = ${CHECKING}`);
    r = await call({ action: "getQuickBooksSettings" });
    ok("an account switched off comes with active false", r.body.accounts.find(a => a.id === CHECKING).active === false);
    d1._raw.exec(`UPDATE accounts SET active = 1 WHERE id = ${CHECKING}`);
    const old = await fresh("0012"), callOld = callOn(L, old);
    r = await callOld({ action: "getQuickBooksSettings" });
    ok("before the accounts and expense categories existed (before migrations/0012): no accounts, no categories, the defaults, no error",
      r.status === 200 && same(r.body.accounts, []) && same(r.body.categories, []) && r.body.settings.accounts.sales === "Sales");
  }

  console.log("\n=== updateQuickBooksSettings ===");
  {
    let r = await call({ action: "updateQuickBooksSettings", settings: { format: "desktop", accounts: { sales: "  Embroidery Sales  " }, bankAccounts: { [CHECKING]: "Business Checking" } } });
    ok("the page's way (settings: {…}): saved, and the cleaned mapping answered as quickbooks and settings",
      r.status === 200 && r.body.status === "ok" && r.body.settings.format === "desktop" && r.body.settings.accounts.sales === "Embroidery Sales" &&
      r.body.settings.bankAccounts[String(CHECKING)] === "Business Checking" && same(r.body.quickbooks, r.body.settings));
    ok("…and it is what is stored (no stray settings or quickbooks key in it)", (() => { const s = storedQb(d1); return s.format === "desktop" && s.accounts.sales === "Embroidery Sales" && !("settings" in s) && !("quickbooks" in s) && !("action" in s); })());
    const a1 = audits(d1, "settings.quickbooks").pop();
    ok("audited settings.quickbooks, from what was there to what is now, by who saved it, for no shop and no order",
      !!a1 && a1.detail.from.format === "online" && a1.detail.from.accounts.sales === "Sales" && a1.detail.to.format === "desktop" && a1.detail.to.accounts.sales === "Embroidery Sales" &&
      a1.actor === "admin@example.test" && a1.orgId === null && a1.orderId === null);
    r = await call({ action: "updateQuickBooksSettings", quickbooks: { salesAs: "invoices" } }, "manager");
    ok("quickbooks: {…} works too, and Manager may save; what wasn't sent is kept", r.status === 200 && r.body.settings.salesAs === "invoices" && r.body.settings.format === "desktop");
    r = await call({ action: "updateQuickBooksSettings", quickbooks: { customerName: "shop" }, settings: { customerName: "customer" } });
    ok("given both, quickbooks wins", r.status === 200 && r.body.settings.customerName === "shop");
    r = await call({ action: "updateQuickBooksSettings", customerName: "customer", salesAs: "receipts" });
    ok("flat in the request works too", r.status === 200 && r.body.settings.customerName === "customer" && r.body.settings.salesAs === "receipts");
    r = await call({ action: "updateQuickBooksSettings", settings: ["format", "online"], format: "online" });
    ok("a list in settings is no mapping: the request's own fields are read", r.status === 200 && r.body.settings.format === "online");
    const nBefore = audits(d1, "settings.quickbooks").length, sBefore = JSON.stringify(storedQb(d1));
    const refusals = [
      [{ accounts: { sales: "Bad\tname" } }, "Sales: QuickBooks names can't have tabs or line breaks."],
      [{ accounts: { cardFees: "Two\nlines" } }, "Card fees: QuickBooks names can't have tabs or line breaks."],
      [{ accounts: { postage: "x".repeat(101) } }, "Postage: a QuickBooks name can be at most 100 characters."],
      [{ bankAccounts: { [CHECKING]: "Tab\there" } }, `${accts.find(a => a[0] === CHECKING)[1]}: QuickBooks names can't have tabs or line breaks.`],
      [{ format: "excel" }, "Pick QuickBooks Online or QuickBooks Desktop."],
      [{ salesAs: "bills" }, "Sales go in as sales receipts or invoices."],
      [{ customerName: "email" }, "Name the customer by the customer or by the shop."],
      [{ accounts: "Sales" }, "Send the QuickBooks account names as a list."],
      [{ expenseAccounts: 7 }, "Send the QuickBooks account names as a list."],
    ];
    for (const [settings, message] of refusals) {
      r = await call({ action: "updateQuickBooksSettings", settings });
      ok(`refused, 400 "${message}"`, r.status === 400 && r.body.status === "error" && r.body.message === message);
    }
    ok("a refused save changes nothing and writes no audit row", audits(d1, "settings.quickbooks").length === nBefore && JSON.stringify(storedQb(d1)) === sBefore);
    r = await call({ action: "updateQuickBooksSettings", settings: { accounts: { postage: "x".repeat(100) } } });
    ok("100 characters is allowed", r.status === 200 && r.body.settings.accounts.postage.length === 100);
    r = await call({ action: "updateQuickBooksSettings", settings: { accounts: { postage: "" } } });
    ok("an empty name goes back to the default", r.status === 200 && r.body.settings.accounts.postage === "Postage and Delivery");
    // A closed month doesn't stop it: the account names move no money.
    d1._raw.exec(`INSERT INTO closed_periods (month, closedAt, closedBy) VALUES ('2026-04', '2026-04-15T00:00:00.000Z', 'owner@example.test')`);
    r = await call({ action: "updateQuickBooksSettings", settings: { format: "desktop" } });
    ok("with this month closed, the mapping still saves (it changes no month's numbers)", r.status === 200 && r.body.settings.format === "desktop");
    d1._raw.exec("DELETE FROM closed_periods");
    r = await call({ action: "updateQuickBooksSettings", settings: { format: "online" } }, "qbEditor");
    ok("a role with the export at Edit saves it, and the audit names them", r.status === 200 && audits(d1, "settings.quickbooks").pop().actor === "qbEditor@example.test");
  }

  console.log("\n=== getQuickBooksExport ===");
  {
    const before = audits(d1, "report.quickbooks_export").length;
    let r = await call({ action: "getQuickBooksExport", ...MARCH, summaryOnly: true }, "staff");
    const data = await L.getQuickBooksData(d1, MARCH);
    ok("summaryOnly: the counts and totals only (the page's strip), no files", r.status === 200 && r.body.status === "ok" && !("files" in r.body) &&
      same(r.body.summary, L.qbSummary({ ...data, ...MARCH })) && r.body.format === "online" && same(r.body.parts, ["sales", "payments", "expenses", "deposits"]));
    ok("…three sales (the gift card order is one in QuickBooks), one payment, one expense, one deposit",
      r.body.summary.sales.count === 3 && r.body.summary.payments.count === 1 && r.body.summary.payments.totalCents === 5500 &&
      r.body.summary.expenses.count === 1 && r.body.summary.expenses.totalCents === 4200 && r.body.summary.deposits.count === 1 && r.body.summary.deposits.totalCents === 5165);
    ok("…and nothing in the audit log", audits(d1, "report.quickbooks_export").length === before);
    r = await call({ action: "getQuickBooksExport", ...MARCH, summaryOnly: "true" });
    ok("summaryOnly must be true itself: the text \"true\" makes the files (and an audit row)", r.status === 200 && Array.isArray(r.body.files) && audits(d1, "report.quickbooks_export").length === before + 1);

    r = await call({ action: "getQuickBooksExport", ...MARCH, format: "online" }, "staff");
    ok("Online, every part: CSV files (text/csv), named for the part, the bank account where it has one, and the range",
      r.status === 200 && r.body.format === "online" && same(r.body.parts, ["sales", "payments", "expenses", "deposits"]) && r.body.files.length >= 4 &&
      r.body.files.every(f => f.mime === "text/csv" && /^odd-qbo-[a-z0-9-]+-2026-03-01-to-2026-03-31\.csv$/.test(f.filename) && typeof f.text === "string" && f.text.length > 0));
    ok("…a file for each part, sales first", /^odd-qbo-sales-/.test(r.body.files[0].filename) &&
      ["payments", "expenses", "deposits"].every(p => r.body.files.some(f => f.filename.startsWith("odd-qbo-" + p + "-"))));
    ok("…with the summary, and the range", r.body.dateFrom === "2026-03-01" && r.body.dateTo === "2026-03-31" && same(r.body.summary, L.qbSummary({ ...data, ...MARCH })));
    const a = audits(d1, "report.quickbooks_export").pop();
    ok("audited report.quickbooks_export with the format, parts and range, by Back office, for no shop and no order",
      same(a.detail, { format: "online", parts: ["sales", "payments", "expenses", "deposits"], dateFrom: "2026-03-01", dateTo: "2026-03-31" }) &&
      a.actor === "staff@example.test" && a.orgId === null && a.orderId === null);

    r = await call({ action: "getQuickBooksExport", ...MARCH, format: "desktop" });
    ok("Desktop, every part: one .iif file (application/octet-stream) for the range", r.status === 200 && r.body.format === "desktop" && r.body.files.length === 1 &&
      r.body.files[0].filename === "odd-quickbooks-2026-03-01-to-2026-03-31.iif" && r.body.files[0].mime === "application/octet-stream");
    ok("…every transaction in it balances", L.iifBalanced(r.body.files[0].text).ok === true && /!TRNS/.test(r.body.files[0].text));
    ok("…and it is audited as desktop", audits(d1, "report.quickbooks_export").pop().detail.format === "desktop");

    for (const part of ["sales", "payments", "expenses", "deposits"]) {
      r = await call({ action: "getQuickBooksExport", ...MARCH, format: "online", parts: [part] });
      ok(`Online, ${part} alone: only ${part} files`, r.status === 200 && same(r.body.parts, [part]) && r.body.files.length >= 1 && r.body.files.every(f => f.filename.startsWith("odd-qbo-" + part + "-")));
      r = await call({ action: "getQuickBooksExport", ...MARCH, format: "desktop", parts: [part] });
      ok(`Desktop, ${part} alone: one balanced .iif`, r.status === 200 && same(r.body.parts, [part]) && r.body.files.length === 1 && L.iifBalanced(r.body.files[0].text).ok === true);
    }
    r = await call({ action: "getQuickBooksExport", ...MARCH, format: "online", parts: ["deposits", "sales", "deposits"] });
    ok("the parts are put in the usual order, each once", r.status === 200 && same(r.body.parts, ["sales", "deposits"]) &&
      same(audits(d1, "report.quickbooks_export").pop().detail.parts, ["sales", "deposits"]));

    // The format: asked, or the saved one, or Online.
    await call({ action: "updateQuickBooksSettings", settings: { format: "desktop" } });
    r = await call({ action: "getQuickBooksExport", ...MARCH, format: "" });
    ok("with no format asked, the saved one (Desktop)", r.status === 200 && r.body.format === "desktop" && /\.iif$/.test(r.body.files[0].filename));
    r = await call({ action: "getQuickBooksExport", ...MARCH, summaryOnly: true });
    ok("…for the summary too", r.body.format === "desktop");
    r = await call({ action: "getQuickBooksExport", ...MARCH, format: "online" });
    ok("an asked format wins over the saved one", r.body.format === "online" && /\.csv$/.test(r.body.files[0].filename));
    await call({ action: "updateQuickBooksSettings", settings: { format: "online" } });
    r = await call({ action: "getQuickBooksExport", ...MARCH });
    ok("saved Online: Online", r.body.format === "online");

    for (const format of ["excel", "Online", 1]) {
      r = await call({ action: "getQuickBooksExport", ...MARCH, format });
      ok(`format ${JSON.stringify(format)} is refused, "Choose QuickBooks Online or QuickBooks Desktop."`, r.status === 400 && r.body.message === "Choose QuickBooks Online or QuickBooks Desktop.");
    }
    for (const parts of ["sales", [], ["sales", "taxes"], [null], {}]) {
      r = await call({ action: "getQuickBooksExport", ...MARCH, parts });
      ok(`parts ${JSON.stringify(parts)} is refused, "Pick what to export: sales, payments, expenses or deposits."`,
        r.status === 400 && r.body.message === "Pick what to export: sales, payments, expenses or deposits.");
    }
    r = await call({ action: "getQuickBooksExport", ...MARCH, format: "excel", parts: [] });
    ok("the format is checked before the parts", r.body.message === "Choose QuickBooks Online or QuickBooks Desktop.");
    r = await call({ action: "getQuickBooksExport", dateFrom: "x", dateTo: "y", format: "excel" });
    ok("the dates are checked before the format", r.body.message === "Invalid date range — expected YYYY-MM-DD");
    const nAudit = audits(d1, "report.quickbooks_export").length;
    ok("refused exports write no audit row (the count didn't move through the refusals)", audits(d1, "report.quickbooks_export").length === nAudit);

    // A file that can't be made (quickbooks.js refuses an IIF that doesn't balance): 409 with its reason, nothing audited.
    const errs = [], realErr = console.error;
    console.error = (...a) => { errs.push(a.map(String).join(" ")); };
    L.setBuild(() => { throw new Error("QuickBooks Desktop transaction 3 doesn't balance (off by 0.01)."); });
    r = await call({ action: "getQuickBooksExport", ...MARCH, format: "desktop" });
    ok("an export the builder refuses: 409 with its reason", r.status === 409 && r.body.status === "error" && r.body.message === "QuickBooks Desktop transaction 3 doesn't balance (off by 0.01).");
    L.setBuild(() => { throw new Error("y".repeat(400)); });
    r = await call({ action: "getQuickBooksExport", ...MARCH });
    ok("…a long reason is cut to 300 characters", r.status === 409 && r.body.message.length === 300);
    L.setBuild(() => { throw null; });   // eslint-disable-line no-throw-literal
    r = await call({ action: "getQuickBooksExport", ...MARCH });
    ok("…and with no reason at all, \"The QuickBooks file couldn't be made.\"", r.status === 409 && r.body.message === "The QuickBooks file couldn't be made.");
    ok("…each failure is logged for the owner", errs.filter(e => /QuickBooks export failed/.test(e)).length === 3);
    ok("…and none is audited", audits(d1, "report.quickbooks_export").length === nAudit);
    r = await call({ action: "getQuickBooksExport", ...MARCH, summaryOnly: true });
    ok("…while the summary (which builds no file) is still answered", r.status === 200 && !!r.body.summary);
    L.setBuild(undefined);
    r = await call({ action: "getQuickBooksExport", ...MARCH });
    ok("with no file builder at all: 503 \"The QuickBooks export isn't available right now.\"", r.status === 503 && r.body.message === "The QuickBooks export isn't available right now.");
    L.restoreBuild();
    console.error = realErr;
    r = await call({ action: "getQuickBooksExport", ...MARCH });
    ok("with the builder back, the export works again", r.status === 200 && r.body.files.length >= 4);

    const empty = await fresh(), callE = callOn(L, empty);
    r = await callE({ action: "getQuickBooksExport", ...MARCH, format: "desktop" });
    ok("a month with nothing in it still answers (an empty, balanced file and zero counts)", r.status === 200 && r.body.files.length === 1 &&
      L.iifBalanced(r.body.files[0].text).ok === true && r.body.summary.sales.count === 0 && r.body.summary.payments.count === 0);
  }

  console.log("\n=== The switches: Bookkeeping off, Gift cards off ===");
  {
    globalThis.__features416 = { bookkeeping: false };
    const off = "Bookkeeping is turned off. Turn it on under Settings → Global settings → Features.";
    for (const [action, extra] of [["getQuickBooksSettings", {}], ["updateQuickBooksSettings", { settings: { format: "desktop" } }], ["getQuickBooksExport", { ...MARCH }]]) {
      const r = await call({ action, ...extra });
      ok(`Bookkeeping off: ${action} is refused, 403 "${off}"`, r.status === 403 && r.body.feature === "bookkeeping" && r.body.message === off);
    }
    ok("…the refused save stored nothing", storedQb(d1).format === "online");
    let r = await call({ action: "getQuickBooksExport", ...MARCH }, "none");
    ok("…nobody signed in learns nothing about the switch (forbidden, not the switch's message)", r.status === 403 && r.body.code === "forbidden" && !("feature" in r.body));
    r = await call({ action: "getQuickBooksExport", ...MARCH }, "production");
    ok("…nor does a role that may not export", r.status === 403 && !("feature" in r.body));
    r = await call({ action: "getQuickBooksExport", ...MARCH }, "staff");
    ok("…Back office, who may, is told it's switched off", r.status === 403 && r.body.feature === "bookkeeping");
    r = await call({ action: "getGiftCardLiability", ...MARCH });
    ok("…Gift card liability doesn't follow Bookkeeping", r.status === 200);

    globalThis.__features416 = { giftCards: false };
    r = await call({ action: "getGiftCardLiability", ...MARCH });
    ok("Gift cards off: Gift card liability is refused, 403 \"Gift cards is turned off. …\"", r.status === 403 && r.body.feature === "giftCards" && /^Gift cards is turned off\. Turn it on under Settings/.test(r.body.message));
    r = await call({ action: "getGiftCardLiability", ...MARCH }, "production");
    ok("…to a role that may not see gift cards, just forbidden", r.status === 403 && !("feature" in r.body));
    r = await call({ action: "getQuickBooksSettings" });
    ok("…the QuickBooks export doesn't follow Gift cards", r.status === 200);

    globalThis.__features416 = Object.fromEntries(["storefront", "production", "bookkeeping", "giftCards", "shipping", "inventory", "quotes", "discounts", "emailCampaigns"].map(k => [k, false]));
    r = await call({ action: "getSalesReport", ...MARCH });
    const p = await call({ action: "getProfitReport", ...MARCH }), o = await call({ action: "getOrderProfit", orderId: "EDGE-1" });
    ok("with every switch off, Sales by…, Profit per job and an order's profit still answer", r.status === 200 && p.status === 200 && o.status === 200);
    globalThis.__features416 = {};
  }

  finished = true;
})();
