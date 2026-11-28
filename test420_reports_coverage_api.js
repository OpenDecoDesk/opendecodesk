process.env.TZ = "UTC";
const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const { ok } = require("./testlib/check");
const roles = require("./testlib/roles");

// Phase 8's less travelled paths, through the real code:
//   orders.js (the real handler, with the real db.js, quickbooks.js and permissions.js on sql.js):
//     - a report whose db.js call refuses (an { error } answer, with or without its own status, or a userFacing throw)
//       answers that message for Sales by…, Profit per job, an order's profit, gift card liability and the QuickBooks
//       export;
//     - an order's profit asked for under a shop it isn't in is "Order not found";
//     - an order's profit is still refused without costs.view even when sign-in let the request through;
//     - the QuickBooks mapping page lists the app's accounts and categories even when a name, type or "active" is
//       missing, and with neither table readable lists none;
//     - a QuickBooks save whose answer carries no settings reads them back for the reply and the audit row;
//     - an export with no format asked for takes the saved one, else QuickBooks Online;
//     - "Can a shop sell gift cards by card?" when Global settings' payment boxes can't be read (no) or hold nothing
//       (yes, card is on unless switched off).
//   quickbooks.js (the pure builders): a sale with no lines or a nameless line, files named when a part or bank
//   account has no letters, expenses / postage / deposits each missing, deposit memos (1 payment, none, a note), a
//   payment on an order outside the export named by shop or customer, iifBalanced reading short or header-less rows,
//   qbSummary with nothing, and the CSV / IIF cell writers given a number, nothing or control characters.
// "Now" is fixed (2026-04-15 17:00 UTC) inside the code under test and the business is in America/Chicago. Invented
// shops, people and amounts only.
const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/^import "[^"\n]+";\n/gm, "")
  .replace(/export (async function|function|const)/g, "$1");
const NOW = Date.parse("2026-04-15T17:00:00.000Z");
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(NOW); }
  static now() { return NOW; }
}
globalThis.__FixedDate420 = FixedDate;
globalThis.__roles420 = {};
globalThis.__features420 = {};
// The db.js calls the handler makes for phase 8, each one swappable (set) and put back (reset).
const SWAP = ["getSalesReport", "getProfitReport", "getOrderProfit", "getGiftCardLiability", "getQuickBooksData", "setQuickBooksSettings", "getGlobalSettings"];
const glue = () => new Function("const Date = globalThis.__FixedDate420;\n" +
  strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  read("functions/_lib/permissions.js").replace(/export (async function|function|const)/g, "$1") + "\n" +
  "const roleOf420_ = (request) => { const k = request.headers.get('x-role') || 'admin'; return DEFAULT_ROLES[k] || globalThis.__roles420[k] || null; };\n" +
  // x-gate: open — sign-in lets the request through whatever it asks for (the handler's own checks still apply).
  "const requireAdmin = async (env, host, key, request, msg, need) => request.headers.get('x-gate') === 'open' || roleAllows(roleOf420_(request), need === 'staff' ? '*' : need) ? null : new Response(JSON.stringify({ status: 'error', code: 'forbidden' }), { status: 403 });\n" +
  "const adminActor = (request) => (request.headers.get('x-role') || 'admin') + '@example.test';\n" +
  "const adminUser = (request) => { const r = roleOf420_(request); return r ? { id: 1, email: r.key + '@example.test', name: r.name, role: r.key, roleInfo: r, pending: null, bootstrap: false } : null; };\n" +
  "const adminLevel = (request, fn) => effectiveLevel(roleOf420_(request), fn);\n" +
  "const adminCan = (request, fn, level) => { const rk = (l) => l === 'full' ? 3 : l === 'edit' ? 2 : l === 'read' ? 1 : 0; return rk(adminLevel(request, fn)) >= rk(level || 'read'); };\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {}, features: globalThis.__features420 });\n" +
  "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
  "const ensureOrgDomain = async () => ({}), getOrgDomainStatus = async () => ({ configured: false });\n" +
  strip(read("functions/_lib/db.js")) + "\n" + strip(read("functions/_lib/quickbooks.js")) + "\n" + strip(read("functions/api/orders.js")) +
  "\nconst real420 = { " + SWAP.join(", ") + " };\n" +
  "return { post: onRequestPost, getQuickBooksSettings,\n" +
  "  set: (name, f) => { switch (name) { " + SWAP.map(n => `case '${n}': ${n} = f; break;`).join(" ") + " default: throw new Error('no ' + name); } },\n" +
  "  reset: () => { " + SWAP.map(n => `${n} = real420.${n};`).join(" ") + " } };")();
// quickbooks.js on its own, with the two cell writers the files are made of.
const QB = new Function(read("functions/_lib/quickbooks.js").replace(/export (async function|function|const)/g, "$1") +
  "\nreturn { qbFilename_, buildQboCsv, buildIif, iifBalanced, qbSummary, buildQuickBooksExport, csvCell_, iifTrns_ };")();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const migrations = fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort();
const fresh = async () => {
  const d = await createD1();
  d._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of migrations) d.execFile(read("migrations/" + f));
  d._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('club','club','Example Club','t','t',1);
    INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt, ready) VALUES ('school','school','Example School District','t','t',1);
    INSERT INTO global_settings (key, value) VALUES ('locale', '{"timeZone":"America/Chicago","country":"US"}');`);
  return d;
};
// A database where some exact statements answer something else (a function of the SQL: a fake statement, or null to
// use the real one).
const fakeStmt = (all, first) => { const s = { bind: () => s, all: async () => all(), first: async () => first(), run: async () => ({}) }; return s; };
const wrapDb = (d1, rule) => new Proxy(d1, { get(t, k) {
  if (k === "prepare") return (sql) => rule(sql) || t.prepare(sql);
  const v = t[k]; return typeof v === "function" ? v.bind(t) : v;
} });
const callOn = (L, d1, extraEnv = {}) => async (body, role = "admin", headers = {}) => {
  const pending = [];
  const h = Object.assign({ "x-role": role }, headers);
  const res = await L.post({ env: Object.assign({ DB: d1 }, extraEnv), waitUntil: (p) => { pending.push(Promise.resolve(p).catch(() => {})); },
    request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: (n) => h[n.toLowerCase()] != null ? h[n.toLowerCase()] : null } } });
  await Promise.all(pending);
  const text = await res.text();
  let parsed; try { parsed = JSON.parse(text); } catch (_) { parsed = text; }
  return { status: res.status, body: parsed };
};
const q = (s) => s == null ? "NULL" : "'" + String(s).replace(/'/g, "''") + "'";
const audits = (d1, action) => (d1._raw.exec(`SELECT detail FROM audit_log WHERE action = ${q(action)} ORDER BY id`)[0] || { values: [] }).values.map(([d]) => JSON.parse(d || "null"));
const userFacing = (m) => { const e = new Error(m); e.userFacing = true; return e; };
process.on("unhandledRejection", (e) => { console.error(e); ok("nothing in the test was left to fail unseen", false); });
let finished = false;
process.on("exit", () => { if (!finished) { console.log("the test ran to its end: false"); process.exitCode = 1; } });

const fnsOf = (set) => Object.assign(Object.fromEntries(roles.PERM_FUNCTIONS.map(k => [k, "none"])), set);
globalThis.__roles420 = {
  ordersNoCosts: { key: "ordersNoCosts", name: "Order reader", rank: 40, builtIn: false, locked: false,
    permissions: { menus: {}, items: {}, fns: fnsOf({ "orders.details": "read", "reports.profit": "read" }), costsApart: true } },
};

(async () => {
  const L = glue();
  const d1 = await fresh();
  const call = callOn(L, d1);
  d1._raw.exec(`INSERT INTO products (productId, orgId, type, name, createdAt, updatedAt, decorationType) VALUES ('tee', 'club', 'shirt', 'Club Tee', 't', 't', 'screenprint');
    INSERT INTO orders (orderId, orgId, customerName, contact, placedAt, shippedAt, isTest, shippingCostCents, discountCents, taxMode)
      VALUES ('CLUB-1', 'club', 'Sam Sample', 'sam@example.com', '2026-03-02T18:00:00.000Z', '2026-03-03T18:00:00.000Z', 0, 0, 0, 'exclusive');
    INSERT INTO order_items (orderId, orgId, productId, name, type, size, qty, lineTotalCents, taxCents, manufacturedQty, taxable)
      VALUES ('CLUB-1', 'club', 'tee', 'Club Tee', 'shirt', 'M', 2, 4000, 0, 2, 1);`);
  const MARCH = { dateFrom: "2026-03-01", dateTo: "2026-03-31" };

  console.log("=== A db.js refusal is the answer: its message, its status or 400 ===");
  {
    const cases = [
      ["getSalesReport", { action: "getSalesReport", ...MARCH }],
      ["getProfitReport", { action: "getProfitReport", ...MARCH }],
      ["getOrderProfit", { action: "getOrderProfit", orderId: "CLUB-1" }],
      ["getGiftCardLiability", { action: "getGiftCardLiability", ...MARCH }],
      ["getQuickBooksData", { action: "getQuickBooksExport", ...MARCH, format: "online" }],
    ];
    for (const [fn, body] of cases) {
      L.set(fn, async () => ({ error: "Example refusal from " + fn }));
      let r = await call(body);
      const plain = r.status === 400 && r.body.status === "error" && r.body.message === "Example refusal from " + fn;
      L.set(fn, async () => ({ error: "Busy right now", status: 409 }));
      r = await call(body);
      const withStatus = r.status === 409 && r.body.message === "Busy right now";
      L.set(fn, async () => { throw userFacing("Example: that range can't be read."); });
      r = await call(body);
      const thrown = r.status === 400 && r.body.message === "Example: that range can't be read.";
      L.reset();
      ok(`${body.action}: an { error } answer is a 400 with its message, its own status when it gives one, and a userFacing throw is a 400 too`,
        plain && withStatus && thrown);
    }
    const r = await call({ action: "getQuickBooksExport", ...MARCH, format: "online" });
    ok("the real calls are back afterwards (the export answers files)", r.status === 200 && Array.isArray(r.body.files));
    ok("a refused export writes no audit row", audits(d1, "report.quickbooks_export").length === 1);
  }

  console.log("\n=== An order's profit under a shop ===");
  {
    let r = await call({ action: "getOrderProfit", orderId: "CLUB-1", org: "club" });
    ok("asked for under its own shop: the profit (revenue 40.00)", r.status === 200 && r.body.profit && r.body.profit.revenueCents === 4000);
    r = await call({ action: "getOrderProfit", orderId: "CLUB-1", org: "school" });
    ok("asked for under another shop: 404 Order not found, and no profit", r.status === 404 && r.body.message === "Order not found" && !("profit" in r.body));
    r = await call({ action: "getOrderProfit", orderId: "NONE-1", org: "club" });
    ok("an order that doesn't exist, under a shop: 404 Order not found", r.status === 404 && r.body.message === "Order not found");
    r = await call({ action: "getOrderProfit", orderId: "CLUB-1" });
    ok("with no shop given: the profit", r.status === 200 && r.body.profit.revenueCents === 4000);
  }

  console.log("\n=== An order's profit needs costs.view even past sign-in ===");
  {
    let r = await call({ action: "getOrderProfit", orderId: "CLUB-1" }, "ordersNoCosts", { "x-gate": "open" });
    ok("a role that can open orders but not see costs: 403 \"You can't see costs.\"", r.status === 403 && r.body.code === "forbidden" && r.body.message === "You can't see costs." && !("profit" in r.body));
    r = await call({ action: "getOrderProfit", orderId: "CLUB-1" }, "admin", { "x-gate": "open" });
    ok("the same gate with costs.view: the profit", r.status === 200 && r.body.profit.revenueCents === 4000);
  }

  console.log("\n=== The QuickBooks mapping page's accounts and categories ===");
  {
    const ACC = "SELECT id, name, type, active FROM accounts ORDER BY id", CAT = "SELECT id, name FROM expense_categories ORDER BY name";
    let odd = wrapDb(d1, (sql) => sql === ACC ? fakeStmt(() => ({ results: [{ id: "7", name: null, type: null, active: null }, { id: 8, name: "Example Petty Cash", type: "cash", active: 0 }, { id: 9, name: "Example Checking", type: "checking", active: "1" }] }), () => null)
      : sql === CAT ? fakeStmt(() => ({ results: [{ id: "3", name: null }] }), () => null) : null);
    let r = await callOn(L, odd)({ action: "getQuickBooksSettings" });
    ok("an account with no name, type or active flag: id 7, empty name and type, active",
      r.status === 200 && same(r.body.accounts[0], { id: 7, name: "", type: "", active: true }));
    ok("active 0 is not active, \"1\" is", r.body.accounts[1].active === false && r.body.accounts[2].active === true && r.body.accounts[1].name === "Example Petty Cash");
    ok("a category with no name: id 3, empty name", same(r.body.categories, [{ id: 3, name: "" }]));
    const broken = wrapDb(d1, (sql) => sql === ACC || sql === CAT ? fakeStmt(() => { throw new Error("no such table"); }, () => null) : null);
    r = await callOn(L, broken)({ action: "getQuickBooksSettings" });
    ok("neither table readable: the page still opens, with no accounts and no categories",
      r.status === 200 && same(r.body.accounts, []) && same(r.body.categories, []) && r.body.quickbooks && r.body.quickbooks.format === "online");
    const empty = wrapDb(d1, (sql) => sql === ACC || sql === CAT ? fakeStmt(() => ({}), () => null) : null);
    r = await callOn(L, empty)({ action: "getQuickBooksSettings" });
    ok("an answer with no rows at all: no accounts and no categories", r.status === 200 && same(r.body.accounts, []) && same(r.body.categories, []));
  }

  console.log("\n=== A QuickBooks save whose answer carries no settings ===");
  {
    const realSet = (await L.getQuickBooksSettings(d1));
    let called = 0;
    L.set("setQuickBooksSettings", async (db, v) => {
      called++;
      d1._raw.exec(`INSERT OR REPLACE INTO global_settings (key, value) VALUES ('quickbooks', ${q(JSON.stringify({ format: "desktop", salesAs: v.salesAs }))})`);
      return { saved: true };
    });
    const r = await call({ action: "updateQuickBooksSettings", settings: { salesAs: "invoices" } });
    L.reset();
    const fromDb = await L.getQuickBooksSettings(d1);
    ok("the reply carries the settings read back from the database (Desktop, invoices, the account names)",
      called === 1 && r.status === 200 && r.body.quickbooks.format === "desktop" && r.body.quickbooks.salesAs === "invoices" &&
      same(r.body.quickbooks, fromDb) && same(r.body.settings, fromDb) && r.body.quickbooks.accounts.sales === fromDb.accounts.sales);
    const a = audits(d1, "settings.quickbooks");
    ok("the audit row goes from what was saved before to what was read back", a.length === 1 && same(a[0].from, realSet) && same(a[0].to, fromDb));
    d1._raw.exec("DELETE FROM global_settings WHERE key = 'quickbooks'");
  }

  console.log("\n=== The export's format when none is asked for ===");
  {
    let r = await call({ action: "getQuickBooksExport", ...MARCH, summaryOnly: true });
    ok("nothing saved: QuickBooks Online", r.status === 200 && r.body.format === "online");
    d1._raw.exec(`INSERT OR REPLACE INTO global_settings (key, value) VALUES ('quickbooks', '{"format":"desktop"}')`);
    r = await call({ action: "getQuickBooksExport", ...MARCH, summaryOnly: true });
    ok("Desktop saved: QuickBooks Desktop", r.status === 200 && r.body.format === "desktop");
    r = await call({ action: "getQuickBooksExport", ...MARCH, format: "online", summaryOnly: true });
    ok("…unless Online is asked for", r.status === 200 && r.body.format === "online");
    L.set("getQuickBooksData", async () => ({ sales: [], payments: [], expenses: [], postage: [], deposits: [], accounts: [], categories: [] }));
    r = await call({ action: "getQuickBooksExport", ...MARCH, summaryOnly: true });
    const noSettings = r.status === 200 && r.body.format === "online";
    L.set("getQuickBooksData", async () => ({ sales: [], settings: { format: "paper" } }));
    r = await call({ action: "getQuickBooksExport", ...MARCH });
    L.reset();
    ok("data with no settings, or a format that isn't one: QuickBooks Online", noSettings && r.status === 200 && r.body.format === "online" &&
      r.body.files.every(f => /\.csv$/.test(f.filename)));
    d1._raw.exec("DELETE FROM global_settings WHERE key = 'quickbooks'");
  }

  console.log("\n=== Can a shop sell gift cards by card, when the payment boxes can't be read or hold nothing ===");
  {
    const PAY = "SELECT value FROM global_settings WHERE key='enabledPayments'";
    const stripe = { STRIPE_SECRET_KEY: "sk_test_example" };
    let r = await callOn(L, d1, stripe)({ action: "getGiftCardSettings" });
    ok("Stripe set up and the boxes as they come: ready", r.status === 200 && r.body.giftCards.cardReady === true);
    const unreadable = wrapDb(d1, (sql) => sql === PAY ? fakeStmt(() => ({}), () => { throw new Error("database is locked"); }) : null);
    r = await callOn(L, unreadable, stripe)({ action: "getGiftCardSettings" });
    ok("the payment boxes can't be read: not ready", r.status === 200 && r.body.giftCards.cardReady === false);
    r = await callOn(L, unreadable, stripe)({ action: "updateGiftCardSettings", sellOnline: true, amounts: [2500, 5000], minCents: 1000, maxCents: 50000 });
    ok("…so selling gift cards online is refused: set up card payments first", r.status === 400 && r.body.message === "Set up card payments before selling gift cards on a shop.");
    d1._raw.exec(`INSERT OR REPLACE INTO global_settings (key, value) VALUES ('enabledPayments', 'null')`);
    r = await callOn(L, d1, stripe)({ action: "getGiftCardSettings" });
    ok("the boxes saved as nothing: card isn't switched off, so ready", r.status === 200 && r.body.giftCards.cardReady === true);
    L.set("getGlobalSettings", async () => null);
    r = await callOn(L, d1, stripe)({ action: "getGiftCardSettings" });
    L.reset();
    ok("Global settings answering nothing at all: card isn't switched off, so ready", r.status === 200 && r.body.giftCards.cardReady === true);
    r = await callOn(L, d1)({ action: "getGiftCardSettings" });
    ok("no Stripe key on this install: not ready", r.status === 200 && r.body.giftCards.cardReady === false);
    d1._raw.exec(`INSERT OR REPLACE INTO global_settings (key, value) VALUES ('enabledPayments', '{"card":false}')`);
    r = await callOn(L, d1, stripe)({ action: "getGiftCardSettings" });
    ok("card switched off: not ready", r.status === 200 && r.body.giftCards.cardReady === false);
    d1._raw.exec("DELETE FROM global_settings WHERE key = 'enabledPayments'");
  }

  console.log("\n=== quickbooks.js: sales with no lines, or a line with no name or quantity ===");
  {
    const data = { dateFrom: "2026-03-01", dateTo: "2026-03-31", sales: [
      { orderId: "NOLINES-1", date: "2026-03-05", customer: "Pat Example", shippingCents: 700 },
      { orderId: "BLANK-1", date: "2026-03-06", customer: "Pat Example", lines: [{ name: " ", qty: "many", rateCents: 500, amountCents: 500 }] },
    ] };
    const csv = QB.buildQboCsv(data, "sales").csv.split("\r\n");
    ok("a sale with no lines still goes in, with only its shipping", csv.some(l => l.startsWith("NOLINES-1,") && l.includes(",Shipping,") && l.endsWith(",7.00,7.00,N")) &&
      !csv.some(l => l.startsWith("NOLINES-1,") && l.includes(",Sales,")));
    ok("a line with no name is \"Item\" and an unreadable quantity is 0", csv.some(l => l.startsWith("BLANK-1,") && l.includes(",Item,0,5.00,5.00,N")));
    const iif = QB.buildIif(data, ["sales"]).iif;
    ok("the Desktop file posts both, balanced", /CASH SALE\t03\/05\/2026\tUndeposited Funds\tPat Example\t7\.00\tNOLINES-1/.test(iif) && QB.iifBalanced(iif).ok);
    ok("the summary counts a sale with no lines at its shipping", same(QB.qbSummary({ sales: [data.sales[0]] }).sales, { count: 1, totalCents: 700 }));
  }

  console.log("\n=== quickbooks.js: file names with nothing to make a name of ===");
  {
    ok("a part that isn't there is named \"account\", and a missing range start / end", QB.qbFilename_("online", null, null, undefined) === "odd-qbo-account-start-to-end.csv");
    const data = { dateFrom: "2026-03-01", dateTo: "2026-03-31", accounts: [{ id: 4, name: "Checking", type: "checking" }],
      settings: { bankAccounts: { 4: "★★★" } },
      payments: [{ id: 1, orderId: "A-1", date: "2026-03-02", amountCents: 1000, accountId: 4, method: "check" }] };
    const files = QB.buildQboCsv(data, "payments").files;
    ok("a bank account whose QuickBooks name has no letters or digits: its file is …-payments-account-…",
      files.length === 1 && files[0].filename === "odd-qbo-payments-account-2026-03-01-to-2026-03-31.csv" && files[0].account === "★★★");
  }

  console.log("\n=== quickbooks.js: expenses, postage and deposits each missing ===");
  {
    const base = { dateFrom: "2026-03-01", dateTo: "2026-03-31", accounts: [{ id: 4, name: "Example Checking", type: "checking" }] };
    const postageOnly = QB.buildQboCsv({ ...base, postage: [{ id: 1, date: "2026-03-04", accountId: 4, amountCents: 850, orderId: "A-1" }] }, "expenses").files;
    ok("postage with no expenses: one file, the postage row", postageOnly.length === 1 && /03\/04\/2026,Postage - order A-1 - Postage and Delivery,-8\.50/.test(postageOnly[0].csv));
    const expensesOnly = QB.buildQboCsv({ ...base, expenses: [{ id: 1, date: "2026-03-05", accountId: 4, amountCents: 1200, payee: "Example Vendor", categoryName: "Supplies" }] }, "expenses").files;
    ok("expenses with no postage: one file, the expense row", expensesOnly.length === 1 && /03\/05\/2026,Example Vendor - Supplies,-12\.00/.test(expensesOnly[0].csv));
    ok("no deposits at all: no deposit file", same(QB.buildQboCsv(base, "deposits").files, []));
    const deps = [
      { id: 1, date: "2026-03-07", accountId: 4, amountCents: 3000, paymentIds: [11] },
      { id: 2, date: "2026-03-08", accountId: 4, amountCents: 2000, note: "Example cash-out" },
      { id: 3, date: "2026-03-09", accountId: 4, amountCents: 1500, paymentIds: [12, 13], memo: "Example memo", note: "ignored" },
    ];
    const csv = QB.buildQboCsv({ ...base, deposits: deps }, "deposits").files[0].csv;
    ok("deposit descriptions: \"1 payment\", none named when it lists none (its note), and a memo before the note",
      csv.includes("03/07/2026,Deposit - 1 payment,30.00") && csv.includes("03/08/2026,Deposit - Example cash-out,20.00") &&
      csv.includes("03/09/2026,Deposit - 2 payments - Example memo,15.00"));
    const iif = QB.buildIif({ ...base, deposits: deps }, ["deposits"]).iif;
    ok("the Desktop deposits say the same, balanced", iif.includes("DEP1\tDeposit - 1 payment\t") && iif.includes("DEP2\tDeposit - Example cash-out\t") &&
      iif.includes("DEP3\tDeposit - 2 payments - Example memo\t") && QB.iifBalanced(iif).ok);
    const sum = QB.qbSummary({ postage: [{ amountCents: 850 }] });
    ok("the summary counts postage with no expenses", same(sum.expenses, { count: 1, totalCents: 850 }));
  }

  console.log("\n=== quickbooks.js: a payment on an order outside the export ===");
  {
    const pays = [
      { id: 1, orderId: "OLD-1", date: "2026-03-02", amountCents: 1000, accountId: 4, customer: "Pat Example", shop: "Example Club" },
      { id: 2, orderId: "OLD-2", date: "2026-03-02", amountCents: 1000, accountId: 4, customer: "Pat Example" },
      { id: 3, orderId: "OLD-3", date: "2026-03-02", amountCents: 1000, accountId: 4 },
      { id: 4, orderId: "OLD-4", date: "2026-03-02", amountCents: 1000, accountId: 4, shop: "Example School District" },
    ];
    const base = { dateFrom: "2026-03-01", dateTo: "2026-03-31", accounts: [{ id: 4, name: "Example Checking", type: "checking" }], payments: pays };
    // A check paid straight into the bank: a DEPOSIT whose split names who paid.
    const nameOn = (iif, id) => { const l = iif.split("\r\n").find(x => x.startsWith("SPL\tDEPOSIT\t") && x.includes("order " + id)); return l ? l.split("\t")[4] : "none"; };
    let iif = QB.buildIif({ ...base, settings: { customerName: "shop" } }, ["payments"]).iif;
    ok("named by shop: the shop, else the customer, else \"Customer\"",
      nameOn(iif, "OLD-1") === "Example Club" && nameOn(iif, "OLD-2") === "Pat Example" && nameOn(iif, "OLD-3") === "Customer" && QB.iifBalanced(iif).ok);
    iif = QB.buildIif({ ...base, settings: { customerName: "customer" } }, ["payments"]).iif;
    ok("named by customer: the customer, else the shop, else \"Customer\"",
      nameOn(iif, "OLD-1") === "Pat Example" && nameOn(iif, "OLD-4") === "Example School District" && nameOn(iif, "OLD-3") === "Customer");
  }

  console.log("\n=== quickbooks.js: iifBalanced reading short and header-less rows ===");
  {
    const H = "!TRNS\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM\r\n!SPL\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tDOCNUM\r\n!ENDTRNS\r\n";
    let r = QB.iifBalanced(H + "TRNS\tGENERAL JOURNAL\r\nSPL\tGENERAL JOURNAL\r\nENDTRNS\r\n");
    ok("rows cut short before AMOUNT read as 0, so the transaction balances", r.ok === true && same(r.bad, []));
    r = QB.iifBalanced(H + "TRNS\tGENERAL JOURNAL\t03/01/2026\tChecking\t\t1,000.00\tJ-1\r\nSPL\tGENERAL JOURNAL\t03/01/2026\tSales\t\t-1000.00\tJ-1\r\nENDTRNS\r\n");
    ok("an amount that isn't a plain decimal (1,000.00) is crooked, named by its DOCNUM", r.ok === false && same(r.bad, ["J-1"]));
    r = QB.iifBalanced("!TRNS\tTRNSTYPE\tAMOUNT\tDOCNUM\r\nTRNS\tGENERAL JOURNAL\t5.00\tJ-2\r\nSPL\tGENERAL JOURNAL\t-5.00\r\nENDTRNS\r\n");
    ok("SPL rows with no !SPL header can't be read: crooked", r.ok === false && same(r.bad, ["J-2"]));
    r = QB.iifBalanced("!TRNS\tTRNSTYPE\tAMOUNT\r\nTRNS\tGENERAL JOURNAL\t5.00\r\n!SPL\tTRNSTYPE\tAMOUNT\r\nSPL\tGENERAL JOURNAL\t-5.00\r\nENDTRNS\r\n");
    ok("…and with both headers and no DOCNUM column, a balanced one is fine", r.ok === true);
  }

  console.log("\n=== quickbooks.js: the summary with nothing ===");
  {
    const zero = { sales: { count: 0, totalCents: 0 }, payments: { count: 0, totalCents: 0 }, expenses: { count: 0, totalCents: 0 }, deposits: { count: 0, totalCents: 0 } };
    ok("no data at all, or an empty object, or sales that aren't a list: every part 0 and 0",
      same(QB.qbSummary(), zero) && same(QB.qbSummary(null), zero) && same(QB.qbSummary({ sales: "x" }), zero));
    ok("payments and deposits are counted and summed when they are there",
      same(QB.qbSummary({ payments: [{ amountCents: 500 }, { amountCents: -200 }], deposits: [{ amountCents: 300 }] }).payments, { count: 2, totalCents: 300 }) &&
      same(QB.qbSummary({ deposits: [{ amountCents: 300 }, { amountCents: "x" }] }).deposits, { count: 2, totalCents: 300 }));
    ok("an export with no data has no files and the empty summary", same(QB.buildQuickBooksExport(null, "online", ["deposits"]), { files: [], summary: zero }));
  }

  console.log("\n=== quickbooks.js: the cell writers ===");
  {
    ok("a CSV number cell is written as it is, and a number that isn't finite is empty",
      QB.csvCell_(12.5) === "12.5" && QB.csvCell_(-3) === "-3" && QB.csvCell_(NaN) === "" && QB.csvCell_(Infinity) === "");
    ok("an empty CSV cell for nothing", QB.csvCell_(null) === "" && QB.csvCell_(undefined) === "");
    ok("control characters in a CSV cell become spaces", QB.csvCell_("Example\u0001Club\u0007") === "\"Example Club \"" && QB.csvCell_("A\u000BB") === "A B");
    const rows = QB.iifTrns_({ date: "2026-03-01", docnum: "X-1", memo: "Example", trns: { accnt: "Checking", name: "Pat Example", amount: 100 },
      spl: [{ accnt: "Sales", name: "Pat Example", amount: -100 }] });
    ok("an IIF row with no transaction type leaves that column empty (TRNS and SPL)",
      rows[0].startsWith("TRNS\t\t03/01/2026\tChecking\tPat Example\t1.00\tX-1\tExample\tN\t\t") && rows[1].startsWith("SPL\t\t03/01/2026\tSales\tPat Example\t-1.00\tX-1"));
  }

  finished = true;
})().catch((e) => { console.error(e); ok("the test ran without throwing", false); });
