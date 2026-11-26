const fs = require("fs");
const { createD1 } = require("./testlib/d1-shim.js");
const roles = require("./testlib/roles");   // the built-in roles, read from functions/_lib/permissions.js

// Who gets what from listAccounts (second review, 2026-11-25):
//   - what each account holds (balance, opening balance and date, how many entries, its statement-file settings) and
//     the money defaults go only to a role with Accounts and money at Read or better. Back office (Payments), a role
//     with only Expenses, and every screen below get the accounts' NAMES for their picker — id, name, type, active —
//     and for them the balance sums aren't run at all;
//   - the screens that start by asking for the accounts are allowed to: the Account viewer, Reconcile, and the
//     Receive blanks / Receive transfers forms (Blanks or Transfers at Edit). Each of those screens' other first
//     calls is allowed for the screen's own function too;
//   - a role with none of these is refused.
// Real SQL (sql.js) + real db.js, permissions.js and orders.js, behind the gate as adminAuth.js runs it for the role
// the test is acting as. Invented data only.

const read = (p) => fs.readFileSync(__dirname + "/" + p, "utf8");
const strip = (src) => src.replace(/import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\n?/g, "").replace(/export (async function|function|const)/g, "$1");
const dbSrc = strip(read("functions/_lib/db.js"));
// __as.role: the role signed in (null: nobody — every check then fails closed, as without adminAuth.js).
const api = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
  strip(read("functions/_lib/permissions.js")) + "\n" +
  "const __as = { role: null };\n" +
  "const requireAdmin = async (env, host, key, request, msg, need) => __as.role && roleAllows(__as.role, need) ? null : new Response(JSON.stringify({ status: 'error', code: 'forbidden', message: 'Your role can\\'t do this.' }), { status: 403 });\n" +
  "const adminActor = () => 'pat@example.test';\n" +
  "const adminUser = () => __as.role ? { id: 7, role: __as.role.key, roleInfo: __as.role } : null;\n" +
  "const adminCan = (request, fn, level) => !!__as.role && permRank(effectiveLevel(__as.role, fn)) >= permRank(level || 'read');\n" +
  "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
  "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
  "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
  "const sendShippingPaymentEmail = async () => true; const sendCancellationEmail = async () => true;\n" +
  dbSrc + "\n" + strip(read("functions/api/orders.js")) +
  "\nreturn { post: onRequestPost, as: __as, ACTION_PERM, DEFAULT_ROLES, normalizePermissions };")();

let failed = 0, passed = 0;
const ok = (label, cond) => { cond ? passed++ : failed++; console.log(label + ": " + !!cond); };

// A role of the owner's own making (Users → Roles and permissions): these functions, nothing else.
const role = (key, fns) => ({ key, name: key, rank: 10, locked: false, builtIn: false, permissions: api.normalizePermissions({ fns }) });
const MONEY_FIELDS = ["openingBalance", "openingDate", "balance", "moves", "csvMapping"];
const NAME_FIELDS = "active,id,name,type";

(async () => {
  const d1 = await createD1();
  d1._raw.exec(read("testlib/schema-pre-0006.sql"));
  for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006").sort()) d1.execFile(read("migrations/" + f));
  const env = { DB: d1, ROOT_DOMAIN: "example.com" };
  // Every statement the handler prepares, so a test can say which were run for one call.
  const prepared = [];
  const realPrepare = d1.prepare.bind(d1);
  d1.prepare = (sql) => { prepared.push(String(sql)); return realPrepare(sql); };
  const call = async (body, as) => {
    api.as.role = as;
    const full = Object.assign({ key: "x" }, body);
    const req = { url: "https://admin.example.com/api/orders", json: async () => full, clone: () => ({ json: async () => full }), headers: { get: () => null } };
    prepared.length = 0;
    const res = await api.post({ env, waitUntil: () => {}, request: req });
    return { status: res.status, body: JSON.parse(await res.text()), sql: prepared.slice() };
  };

  // The accounts a new install has, with money in two of them and a saved statement layout on one.
  const acct = (n) => d1.q("SELECT id FROM accounts WHERE name = ?", n)[0].id;
  const checking = acct("Business checking"), venmo = acct("Venmo");
  d1._raw.run("UPDATE accounts SET openingDate = '2026-01-01', openingBalanceCents = 1234500, csvMapping = '{\"date\":\"Posted\"}' WHERE id = ?", [checking]);
  d1._raw.run("UPDATE accounts SET openingDate = '2026-01-01', openingBalanceCents = 4200 WHERE id = ?", [venmo]);
  d1._raw.run("INSERT INTO other_income (incomeDate, type, description, amountCents, accountId, createdAt, updatedAt) VALUES ('2026-02-01', 'interest', 'Interest', 5500, ?, '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z')", [checking]);
  const count = d1.q("SELECT count(*) n FROM accounts")[0].n;
  const sums = (sql) => sql.filter(s => /SUM\(CASE WHEN m\.d >= a\.openingDate/.test(s)).length;
  const namesOnly = (r) => r.status === 200 && r.body.accounts.length === count && r.body.accounts.every(a => Object.keys(a).sort().join() === NAME_FIELDS) &&
    !MONEY_FIELDS.some(f => new RegExp('"' + f + '"').test(JSON.stringify(r.body))) && !/12345|1234500|Posted/.test(JSON.stringify(r.body));

  console.log("=== Balances are for Accounts and money ===");
  const admin = api.DEFAULT_ROLES.admin, manager = api.DEFAULT_ROLES.manager, staff = api.DEFAULT_ROLES.staff, production = api.DEFAULT_ROLES.production;
  let r = await call({ action: "listAccounts" }, admin);
  const full = r.body.accounts.find(a => a.id === checking);
  ok("the admin gets every account with what it holds", r.status === 200 && r.body.accounts.length === count && full.balance === 12400 && full.openingBalance === 12345 && full.openingDate === "2026-01-01" &&
    full.moves === 1 && full.csvMapping === '{"date":"Posted"}' && "postageAccountId" in r.body.defaults);
  ok("…which takes the balance sums", sums(r.sql) > 5);
  const moneyRead = role("moneyRead", { "finance.money": "read" });
  r = await call({ action: "listAccounts" }, moneyRead);
  ok("a role with Accounts and money at Read gets the balances too", r.status === 200 && r.body.accounts.find(a => a.id === checking).balance === 12400 &&
    r.body.accounts.find(a => a.id === venmo).openingBalance === 42 && "payoutAccountId" in r.body.defaults);
  ok("…and so does the built-in Manager", (r = await call({ action: "listAccounts" }, manager)).status === 200 && r.body.accounts.find(a => a.id === checking).balance === 12400);
  ok("a balance on a past date still works for them", (r = await call({ action: "listAccounts", asOf: "2026-01-15" }, moneyRead)).body.accounts.find(a => a.id === checking).balance === 12345);

  console.log("\n=== Everyone else who is let in gets names only ===");
  ok("the built-in Back office role has Payments and not Accounts and money", roles.may("staff", "addPayment") && roles.effectivePermissions(roles.DEFAULT_ROLES.staff)["finance.money"] === "none");
  r = await call({ action: "listAccounts" }, staff);
  ok("Back office gets the accounts' names for the payment window: id, name, type, active", namesOnly(r) &&
    r.body.accounts.find(a => a.id === checking).name === "Business checking" && r.body.accounts.find(a => a.id === checking).active === true && typeof r.body.accounts[0].type === "string");
  ok("…with no balance, opening balance, opening date, entry count or statement settings anywhere in the reply", !MONEY_FIELDS.some(f => f in r.body.accounts[0]));
  ok("…and no money defaults (which account postage and payouts use)", JSON.stringify(r.body.defaults) === "{}");
  ok("…while the lists the pickers label with are still there", !!r.body.accountTypes && !!r.body.accountTypes.checking && !!r.body.otherIncomeTypes);
  ok("for them the balance sums aren't run at all: one query, of the accounts' names", sums(r.sql) === 0 && r.sql.filter(s => /FROM accounts/.test(s)).length === 1 &&
    /^SELECT id, name, type, active FROM accounts/.test(r.sql.find(s => /FROM accounts/.test(s))) && !r.sql.some(s => /moneyDefaults|global_settings WHERE key = 'money/i.test(s)));
  ok("asking for a date changes nothing for them", namesOnly(await call({ action: "listAccounts", asOf: "2026-01-15" }, staff)));
  const expensesRead = role("expensesRead", { "finance.expenses": "read" });
  ok("a role with only Expenses at Read: the same names, no balances", namesOnly(await call({ action: "listAccounts" }, expensesRead)));
  ok("a role with only Payments at Read: the same", namesOnly(await call({ action: "listAccounts" }, role("paymentsRead", { "orders.payments": "read" }))));
  ok("costs.view doesn't open the balances either (they are Accounts and money's)", namesOnly(await call({ action: "listAccounts" }, role("costs", { "orders.payments": "read", "costs.view": "read" }))));
  const moneyOff = { key: "moneyOff", name: "moneyOff", rank: 10, locked: false, builtIn: false,
    permissions: api.normalizePermissions({ fns: { "finance.money": "full", "finance.expenses": "read" }, items: { money: false } }) };
  ok("Accounts and money switched off as a menu item counts as not having it", namesOnly(await call({ action: "listAccounts" }, moneyOff)));

  console.log("\n=== The screens that start by asking for the accounts are allowed to ===");
  const viewer = role("viewer", { "finance.accountviewer": "read" });
  const reconcile = role("reconcile", { "finance.reconcile": "read" });
  const blanksEdit = role("blanksEdit", { "inventory.blanks": "edit" });
  const transfersEdit = role("transfersEdit", { "inventory.transfers": "edit" });
  ok("Account viewer: the account list is allowed, names only", namesOnly(await call({ action: "listAccounts" }, viewer)));
  r = await call({ action: "getAccountRegister", accountId: checking, dateFrom: "2026-01-01", dateTo: "2026-03-01" }, viewer);
  ok("…and its next call, the account's register, is the screen's own", r.status === 200 && r.body.status === "ok");
  ok("Reconcile: the account list is allowed, names only", namesOnly(await call({ action: "listAccounts" }, reconcile)));
  r = await call({ action: "getReconciliation", accountId: checking, month: "2026-02" }, reconcile);
  ok("…and its next call, the month's statement, is the screen's own", r.status === 200 && r.body.status === "ok");
  ok("Receive blanks (Blanks at Edit): the 'paid from' accounts are allowed, names only", namesOnly(await call({ action: "listAccounts" }, blanksEdit)));
  ok("…with the form's other first calls: the blanks and the expense categories", (await call({ action: "getBlanks" }, blanksEdit)).status === 200 && (await call({ action: "listExpenseCategories" }, blanksEdit)).status === 200);
  ok("Receive transfers (Transfers at Edit): the 'paid from' accounts are allowed, names only", namesOnly(await call({ action: "listAccounts" }, transfersEdit)));
  ok("…with the form's other first calls: the transfers and the expense categories", (await call({ action: "listTransfers" }, transfersEdit)).status === 200 && (await call({ action: "listExpenseCategories" }, transfersEdit)).status === 200);
  ok("the permission list says so", ["finance.money,read", "orders.payments,read", "finance.expenses,read", "finance.accountviewer,read", "finance.reconcile,read", "inventory.blanks,edit", "inventory.transfers,edit"]
    .every(p => api.ACTION_PERM.listAccounts.some(e => e.join() === p)) && api.ACTION_PERM.listAccounts.length === 7);

  console.log("\n=== A role with none of them is refused ===");
  ok("Blanks at Read only (it can't receive an order) is refused", (await call({ action: "listAccounts" }, role("blanksRead", { "inventory.blanks": "read" }))).status === 403);
  ok("Transfers at Read only is refused", (await call({ action: "listAccounts" }, role("transfersRead", { "inventory.transfers": "read" }))).status === 403);
  ok("the built-in Production role is refused", (r = await call({ action: "listAccounts" }, production)).status === 403 && !/Business checking/.test(JSON.stringify(r.body)));
  ok("a role with only orders and the catalog is refused", (await call({ action: "listAccounts" }, role("orders", { "orders.details": "edit", "catalog.products": "edit", "costs.view": "read" }))).status === 403);
  ok("nobody signed in is refused", (await call({ action: "listAccounts" }, null)).status === 403);

  console.log("\n=== Changing accounts is still Accounts and money's ===");
  r = await call({ action: "saveAccount", account: { name: "Petty cash", type: "cash", openingBalance: 10, openingDate: "2026-01-01" } }, staff);
  ok("Back office can't add an account (whose reply would carry balances)", r.status === 403 && d1.q("SELECT count(*) n FROM accounts WHERE name = 'Petty cash'")[0].n === 0);
  ok("…nor read the money lists", (await call({ action: "listMoney", dateFrom: "2026-01-01", dateTo: "2026-12-31" }, staff)).status === 403);
  ok("the Account viewer role can't either", (await call({ action: "saveAccount", account: { name: "Petty cash", type: "cash", openingBalance: 10, openingDate: "2026-01-01" } }, viewer)).status === 403);

  console.log("\n=== The admin page copes with names only ===");
  const adminJs = read("public/admin.js");
  const fn = (name) => { const i = adminJs.indexOf("function " + name + "("); let d = 0, j = adminJs.indexOf("{", adminJs.indexOf(")", i)); const s = j;
    for (;; j++) { if (adminJs[j] === "{") d++; else if (adminJs[j] === "}" && --d === 0) break; } return adminJs.slice(i, j + 1); };
  const page = new Function("const escapeHtml = (s) => String(s);\nconst METHOD_ACCOUNT_TYPE = { card: 'stripe', venmo: 'venmo', cash: 'cash', zelle: 'checking', check: 'checking', other: 'checking' };\n" +
    fn("accountOptions_") + "\n" + fn("accountForMethod_") + "\nreturn { accountOptions_, accountForMethod_ };")();
  const names = (await call({ action: "listAccounts" }, staff)).body.accounts;
  const options = page.accountOptions_(names, checking, { personal: true });
  ok("the picker lists every active account by name from a names-only reply", names.filter(a => a.active).every(a => options.includes(">" + a.name + "</option>")) &&
    new RegExp('value="' + checking + '" selected').test(options) && /Personal funds/.test(options) && !/undefined|NaN/.test(options));
  ok("…and still picks the account a payment method usually goes to (by type)", page.accountForMethod_(names, "venmo") === venmo && page.accountForMethod_(names, "check") === checking);
  const reads = [...adminJs.matchAll(/\b(?:a|acct|x)\.(balance|openingBalance|openingDate|moves)\b/g)].map(m => m.index);
  const money0 = adminJs.indexOf("async function renderMoney("), money1 = adminJs.indexOf("async function renderAccountViewer(");
  ok("only the Accounts & money screen reads an account's balance or opening balance from the list", reads.length >= 3 && money0 > 0 && money1 > money0 && reads.every(i => i > money0 && i < money1));
  ok("…and that screen is Accounts and money's own (its first call needs it)", roles.ACTION_PERM.listMoney.length === 1 && roles.ACTION_PERM.listMoney[0].join() === "finance.money,read");
  ok("the expense import falls back to reading the file's headers when no saved layout comes with the account", /saved = acct && acct\.csvMapping \? JSON\.parse\(acct\.csvMapping\) : \{\}/.test(adminJs));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})().catch(e => { console.error(e); console.log("test288 ran to the end without crashing: false"); process.exitCode = 1; });
