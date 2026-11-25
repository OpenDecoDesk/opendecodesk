const fs = require("fs");
const { ok } = require("./testlib/check");
const { createD1 } = require("./testlib/d1-shim.js");
const roles = require("./testlib/roles");
const { makeAuth, prelude, strip, read, request, answer } = require("./testlib/auth-harness");

// Fundraising for group shops (migrations/0110): the four admin actions of /api/orders, through the real handler.
//   - functions/_lib/permissions.js: the Fundraising report item, each action's function and level, the built-in defaults
//   - who may: every built-in role behind the REAL sign-in gate (adminAuth.js), and signed out
//   - the Bookkeeping switch (FEATURE_ACTIONS): only recording a payout is behind it
//   - getFundraisingReport, listFundraiserPayouts, setOrgFundraiser, recordFundraiserPayout: every refusal and its
//     sentence, the answers' shapes, the audit rows, the catalog version, the closed-month check
//   - the payout's audit detail hidden from a role without costs.view (MONEY_AUDIT_ACTIONS_)
//   - a database that hasn't had 0110 yet
// (How much a line raises and how the report adds it up are other files' business: here only what the actions answer.)
// Real SQL (sql.js) under the real db.js and orders.js. Invented shops and people only.

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keys = (o) => Object.keys(o || {}).sort().join(",");
const forbidden = (r) => r.status === 403 && r.body && r.body.status === "error" && r.body.code === "forbidden";
const refused = (r, status, message) => r.status === status && r.body && r.body.status === "error" && r.body.message === message;
const FOUR = ["getFundraisingReport", "listFundraiserPayouts", "setOrgFundraiser", "recordFundraiserPayout"];
const ROLE = "Your role can't do this. Ask an admin.";
const BAD_RANGE = "Invalid date range — expected YYYY-MM-DD", REVERSED = "The start date is after the end date.";
const CHOOSE_SHOP = "Choose a shop.", BAD_SHOP = "That shop isn't valid.", UNKNOWN_SHOP = "Unknown shop";
const SAY = "Say what the fundraiser is, or choose none.", BAD_F = "That fundraiser isn't valid.";
const AMOUNT = "Amount must be a positive number", DATE = "Date must be YYYY-MM-DD", FUTURE = "The date can't be in the future",
  TOO_OLD = "That date is too far back", ACCOUNT = "Choose which account paid it";
const BOOKS_OFF = "Bookkeeping is turned off. Turn it on under Settings → Global settings → Features.";
const NOT_READY_DB = "Fundraising needs the latest database update. Apply the migrations, then try again.";
const ordersJs = read("functions/api/orders.js");

(async () => {
  console.log("=== The permission (functions/_lib/permissions.js) ===");
  {
    const reports = roles.PERMISSION_AREAS.find(a => a.key === "reports");
    const at = reports.items.findIndex(i => i.hash === "fundraising");
    ok("Reports has a Fundraising page (#fundraising) with one function, reports.fundraising \"Fundraising report\"",
      at >= 0 && same(reports.items[at], { hash: "fundraising", label: "Fundraising", fns: [["reports.fundraising", "Fundraising report"]] }));
    ok("…placed right after Run times", at > 0 && reports.items[at - 1].hash === "runreport");
    ok("the function is on the Roles screen's list once", roles.PERM_FUNCTIONS.filter(f => f === "reports.fundraising").length === 1);
    const perm = (a) => roles.ACTION_PERM[a];
    ok("the report and the list of payouts need reports.fundraising at read",
      same(perm("getFundraisingReport"), [["reports.fundraising", "read"]]) && same(perm("listFundraiserPayouts"), [["reports.fundraising", "read"]]));
    ok("setting a shop's fundraiser needs catalog.shops at edit", same(perm("setOrgFundraiser"), [["catalog.shops", "edit"]]));
    ok("recording a payout needs finance.expenses at edit (it is an expense)", same(perm("recordFundraiserPayout"), [["finance.expenses", "edit"]]));
    const level = (role, fn) => roles.effectivePermissions(roles.DEFAULT_ROLES[role])[fn];
    ok("built-in defaults for reports.fundraising: Admin full, Manager full, Back office read, Production none",
      ["admin", "manager", "staff", "production"].map(r => level(r, "reports.fundraising")).join() === "full,full,read,none");
    const P = new Function(read("functions/_lib/permissions.js").replace(/export (async function|function|const)/g, "$1") + "\nreturn { normalizePermissions, roleAllows, ACTION_PERM };")();
    const stored = P.normalizePermissions({ fns: { "reports.revenue": "read" } });
    ok("a role stored before the permission existed has none of it, so neither report action",
      stored.fns["reports.fundraising"] === "none" && ["getFundraisingReport", "listFundraiserPayouts"].every(a => !P.roleAllows({ key: "r_old", permissions: stored }, P.ACTION_PERM[a])));
    const noMonth = [...ordersJs.match(/const NO_MONTH_ACTIONS = new Set\(\[([\s\S]*?)\]\);/)[1].matchAll(/"(\w+)"/g)].map(m => m[1]);
    ok("setting a fundraiser changes no month's numbers (NO_MONTH_ACTIONS); recording a payout isn't on that list",
      noMonth.includes("setOrgFundraiser") && !noMonth.includes("recordFundraiserPayout"));
    const featureLists = {};
    for (const m of ordersJs.match(/const FEATURE_ACTIONS = \{([\s\S]*?)\n\};/)[1].matchAll(/\n  (\w+): \[([\s\S]*?)\],/g)) featureLists[m[1]] = [...m[2].matchAll(/"(\w+)"/g)].map(x => x[1]);
    ok("recordFundraiserPayout is listed under the Bookkeeping switch; the other three under no switch at all",
      (featureLists.bookkeeping || []).includes("recordFundraiserPayout") && Object.keys(featureLists).length >= 3 &&
      FOUR.filter(a => a !== "recordFundraiserPayout").every(a => Object.values(featureLists).every(l => !l.includes(a))));
  }

  // ---- The real endpoint behind the real sign-in (adminAuth.js), on schema.sql ----
  // Stand-ins: the catalog carries the feature switches from globalThis.__t325Features; the catalog-version cache's
  // clear counts its calls (and can be made to fail).
  const STUB = "const getCatalogData = async () => ({ subdomainMap: {}, business: {} });";
  const pre = prelude(false, false);
  if (!pre.includes(STUB)) throw new Error("testlib/auth-harness.js's catalog stand-in changed: update test325");
  const A = await makeAuth();
  const d1 = A.d1;
  const post = new Function("__hits", pre.replace(STUB, "const getCatalogData = async () => ({ subdomainMap: {}, business: {}, features: globalThis.__t325Features || {} });") +
    strip(read("functions/_lib/catalogValidation.js")) + "\n" + strip(read("functions/_lib/quoteToken.js")) + "\n" +
    "const invalidateCatalogVersionCache = () => { globalThis.__t325Cleared = (globalThis.__t325Cleared || 0) + 1; if (globalThis.__t325ClearFails) throw new Error('cache unavailable'); };\n" +
    "const selectBox = () => null;\n" +
    strip(read("functions/_lib/setupStatus.js")) + "\n" + strip(read("functions/_lib/vendorCredentials.js")) + "\n" + strip(read("functions/_lib/smtp.js")) + "\n" +
    strip(read("functions/_lib/email.js")) + "\n" + strip(ordersJs) + "\nreturn onRequestPost;")(A.hits);
  const call = async (body, cookie) => {
    const waits = [];
    const res = await post({ request: request("/api/orders", body, { cookie }), env: A.env, waitUntil: (p) => waits.push(Promise.resolve(p).catch(() => {})) });
    await Promise.all(waits);
    return answer(res);
  };
  const lib = new Function(strip(read("functions/_lib/db.js")) + "\nreturn { insertOrder };")();
  const q = (sql) => d1.q(sql);
  const auditCount = () => q("SELECT count(*) n FROM audit_log")[0].n;
  const expenseCount = () => q("SELECT count(*) n FROM expenses")[0].n;
  const orgRow = (id) => q("SELECT * FROM orgs").find(o => o.orgId === id) || null;
  const version = () => Number((q("SELECT value FROM global_settings WHERE key = 'catalogVersion'")[0] || { value: 0 }).value);
  const cleared = () => globalThis.__t325Cleared || 0;
  // What a request left behind: the answer, the audit rows written by it, the catalog version moves and cache clears.
  const logged = async (body, cookie) => {
    const before = q("SELECT COALESCE(MAX(id), 0) m FROM audit_log")[0].m, v = version(), c = cleared();
    const r = await call(body, cookie);
    return { ...r, rows: q("SELECT * FROM audit_log WHERE id > " + before + " ORDER BY id").map(x => ({ ...x, detail: JSON.parse(x.detail || "null") })),
      bumped: version() - v, clears: cleared() - c };
  };
  const quietly = async (fn) => { const err = console.error, logs = []; console.error = (...a) => logs.push(a.map(String).join(" ")); try { return { out: await fn(), logs }; } finally { console.error = err; } };

  const admin = await A.firstAdmin("Olive Owner", "olive@example.com");
  const manager = await A.addUser(admin, "manager", "Mo Manager", "mo@example.com");
  const staff = await A.addUser(admin, "staff", "Sam Staff", "sam@example.com");
  const prod = await A.addUser(admin, "production", "Pat Production", "pp@example.com");
  // A made-up role that may read the audit log but not see money (costs.view none).
  const staffRole = (await A.users({ action: "listRoles" }, admin)).body.roles.find(x => x.key === "staff");
  const auditorPerms = JSON.parse(JSON.stringify(staffRole.permissions));
  auditorPerms.fns["reports.audit"] = "read"; auditorPerms.fns["costs.view"] = "none";
  const auditorKey = (await A.users({ action: "saveRole", name: "Auditor", rank: 40, permissions: auditorPerms }, admin)).body.role.key;
  const auditor = await A.addUser(admin, auditorKey, "Avery Auditor", "avery@example.com");
  const me = async (cookie) => (await A.users({ action: "me" }, cookie)).body.permissions;
  ok("the roles under test are what they should be: Back office reads the report, Production doesn't, the Auditor reads the audit log without costs.view",
    (await me(staff))["reports.fundraising"] === "read" && (await me(prod))["reports.fundraising"] === "none" &&
    (await me(auditor))["reports.audit"] === "read" && (await me(auditor))["costs.view"] === "none" && (await me(admin))["costs.view"] === "full");

  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Example Club','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
    INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('band','band','Example Band','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
    INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('blank','blank','','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
    INSERT INTO accounts (id, name, type, active, createdAt, updatedAt) VALUES (90, 'Old savings', 'checking', 0, 't', 't');`);
  const cat = q("SELECT id, name FROM expense_categories WHERE systemKey = 'fundraiser_payout'")[0];
  ok("the install has the built-in Fundraiser payouts category and an active Business checking account (id 1)",
    !!cat && cat.name === "Fundraiser payouts" && q("SELECT active FROM accounts WHERE id = 1")[0].active === 1);

  console.log("\n=== Signed out: nothing answers ===");
  {
    const log = auditCount(), exp = expenseCount(), v = version();
    const bodies = { getFundraisingReport: { dateFrom: "2026-03-01", dateTo: "2026-03-31" }, listFundraiserPayouts: {},
      setOrgFundraiser: { org: "acme", fundraiser: { mode: "percent", percent: 10, label: "Example Boosters" } },
      recordFundraiserPayout: { org: "acme", amount: 5, date: "2026-03-10", accountId: 1 } };
    const got = [];
    for (const a of FOUR) got.push(await call(Object.assign({ action: a }, bodies[a]), ""));
    ok("each of the four fundraising actions answers 401 Unauthorized without a session", got.every(r => refused(r, 401, "Unauthorized")));
    ok("…and gives nothing away: no report, no payouts, no fundraiser, no id", got.every(r => keys(r.body) === "message,status"));
    ok("a session that has ended is told to sign in again", refused(await call({ action: "getFundraisingReport", dateFrom: "2026-03-01", dateTo: "2026-03-31" }, "sess_" + "0".repeat(48)), 401, "Session expired — please log in again."));
    globalThis.__t325Features = { bookkeeping: false };
    const off = await call(Object.assign({ action: "recordFundraiserPayout" }, bodies.recordFundraiserPayout), "");
    delete globalThis.__t325Features;
    ok("with Bookkeeping off, a signed-out payout is still told 401 Unauthorized (sign-in first: nothing said about switches)", refused(off, 401, "Unauthorized") && off.body.feature === undefined);
    ok("nothing was changed, recorded or logged", auditCount() === log && expenseCount() === exp && version() === v && orgRow("acme").fundraiserJson === "");
  }

  console.log("\n=== Who may: each built-in role ===");
  {
    // Bodies refused AFTER the gate (a 400 or 404), so the same request can be sent as every role and change nothing:
    // 403 is the gate's answer, anything else got past it.
    const probe = { getFundraisingReport: { dateFrom: "nope", dateTo: "2026-03-31" }, listFundraiserPayouts: { dateFrom: "nope" },
      setOrgFundraiser: { org: "no-such-shop", fundraiser: null }, recordFundraiserPayout: { org: "no-such-shop", amount: 5, date: "2026-03-10", accountId: 1 } };
    const who = { admin, manager, staff, production: prod };
    const row = async (a) => { const out = []; for (const r of ["production", "staff", "manager", "admin"]) { const x = await call(Object.assign({ action: a }, probe[a]), who[r]);
      out.push(forbidden(x) ? (x.body.message === ROLE ? "no" : "no?") : x.status === 401 ? "out" : (x.status === 400 || x.status === 404) ? "yes" : "? " + x.status); } return out.join(); };
    const log = auditCount();
    ok("getFundraisingReport: not Production (\"Your role can't do this. Ask an admin.\"); Back office, Manager and Admin", await row("getFundraisingReport") === "no,yes,yes,yes");
    ok("listFundraiserPayouts: not Production; Back office, Manager and Admin", await row("listFundraiserPayouts") === "no,yes,yes,yes");
    ok("setOrgFundraiser: not Production or Back office; Manager and Admin", await row("setOrgFundraiser") === "no,no,yes,yes");
    ok("recordFundraiserPayout: not Production or Back office; Manager and Admin", await row("recordFundraiserPayout") === "no,no,yes,yes");
    ok("a refusal for the role writes nothing to the audit log", auditCount() === log);
  }

  console.log("\n=== The Bookkeeping switch (FEATURE_ACTIONS) ===");
  {
    globalThis.__t325Features = { bookkeeping: false };
    const exp = expenseCount(), log = auditCount();
    let r = await call({ action: "recordFundraiserPayout", org: "acme", amount: 5, date: "2026-03-10", accountId: 1 }, admin);
    ok("with Bookkeeping off, recording a payout answers 403 { feature: \"bookkeeping\", \"" + BOOKS_OFF + "\" }",
      r.status === 403 && r.body.status === "error" && r.body.feature === "bookkeeping" && r.body.message === BOOKS_OFF);
    ok("…and nothing is recorded or logged", expenseCount() === exp && auditCount() === log);
    r = await call({ action: "recordFundraiserPayout", org: "acme", amount: 5, date: "2026-03-10", accountId: 1 }, prod);
    ok("a role that may not record payouts is told about its role first, not the switch", forbidden(r) && r.body.message === ROLE);
    // Every switch off: the report, the payouts' list and the shop setting still answer.
    const allOff = {};
    for (const m of ordersJs.match(/const FEATURE_ACTIONS = \{([\s\S]*?)\n\};/)[1].matchAll(/\n  (\w+): \[/g)) allOff[m[1]] = false;
    globalThis.__t325Features = allOff;
    const rep = await call({ action: "getFundraisingReport", dateFrom: "2026-03-01", dateTo: "2026-03-31" }, admin);
    const list = await call({ action: "listFundraiserPayouts" }, admin);
    const set = await logged({ action: "setOrgFundraiser", org: "band", fundraiser: null }, admin);
    ok("with every feature switch off (" + Object.keys(allOff).length + " of them), the report, the payouts' list and setting a fundraiser still answer 200",
      Object.keys(allOff).length >= 3 && rep.status === 200 && rep.body.status === "ok" && list.status === 200 && list.body.status === "ok" && set.status === 200 && set.body.status === "ok");
    delete globalThis.__t325Features;
    r = await call({ action: "recordFundraiserPayout", org: "acme", amount: 5, date: "2026-03-10", accountId: 1 }, admin);
    ok("with Bookkeeping on again, the same payout is recorded", r.status === 200 && r.body.status === "ok" && expenseCount() === exp + 1);
    d1._raw.exec("DELETE FROM expenses WHERE id = " + Number(r.body.id) + "; DELETE FROM audit_log WHERE action = 'fundraiser.payout_recorded';");
  }

  console.log("\n=== setOrgFundraiser ===");
  {
    const quiet = (r) => r.rows.length === 0 && r.bumped === 0 && r.clears === 0;
    const unchangedAcme = () => orgRow("acme").fundraiserJson === "";
    const checks = [
      [{ fundraiser: null }, 400, CHOOSE_SHOP, "no shop named: 400 \"Choose a shop.\""],
      [{ org: "", fundraiser: null }, 400, CHOOSE_SHOP, "an empty shop: the same"],
      [{ org: 12, fundraiser: null }, 400, BAD_SHOP, "a shop that isn't text: 400 \"That shop isn't valid.\""],
      [{ org: "x".repeat(101), fundraiser: null }, 400, BAD_SHOP, "a shop name over 100 characters: the same"],
      [{ org: "no-such-shop", fundraiser: null }, 404, UNKNOWN_SHOP, "a shop that doesn't exist: 404 \"Unknown shop\""],
      [{ org: "acme" }, 400, SAY, "the fundraiser left out: 400 \"" + SAY + "\" (never read as none)"],
      [{ org: "acme", fundraiser: "10%" }, 400, BAD_F, "a fundraiser that isn't an object: 400 \"" + BAD_F + "\""],
      [{ org: "acme", fundraiser: 10 }, 400, BAD_F, "…a number: the same"],
      [{ org: "acme", fundraiser: [{ mode: "percent", percent: 10, label: "Example Boosters" }] }, 400, BAD_F, "…a list: the same"],
      [{ org: "acme", fundraiser: { mode: "half", percent: 10, label: "Example Boosters" } }, 400, "Pick how the fundraiser is worked out: a percent of each item, or an amount per piece.", "a mode it doesn't know: the setup's own sentence"],
      [{ org: "acme", fundraiser: { mode: "percent", percent: 10, label: "   " } }, 400, "Enter who the fundraiser supports (for example, the team or club's name).", "no one it supports: the setup's own sentence"],
      [{ org: "acme", fundraiser: { mode: "percent", percent: 10, label: "x".repeat(81) } }, 400, "Who the fundraiser supports can be at most 80 characters.", "who it supports over 80 characters: the setup's own sentence"],
      [{ org: "acme", fundraiser: { mode: "percent", percent: 10, label: "Example Boosters", showOnShop: "yes" } }, 400, "\"Show on the shop\" must be on or off.", "\"show on the shop\" that isn't true or false: the setup's own sentence"],
      [{ org: "acme", fundraiser: { mode: "percent", percent: 60, label: "Example Boosters" } }, 400, "The fundraiser's percent must be from 0.01 to 50.", "a percent over 50: the setup's own sentence"],
      [{ org: "acme", fundraiser: { mode: "percent", percent: 12.345, label: "Example Boosters" } }, 400, "The fundraiser's percent can have at most two decimals.", "a percent with three decimals: the setup's own sentence"],
      [{ org: "acme", fundraiser: { mode: "perPiece", amount: 0, label: "Example Boosters" } }, 400, "The fundraiser's amount per piece must be from $0.01 to $1,000.", "an amount per piece of $0: the setup's own sentence"],
      [{ org: "acme", fundraiser: { mode: "perPiece", amount: 1.005, label: "Example Boosters" } }, 400, "The fundraiser's amount per piece must be in whole cents.", "an amount per piece in part-cents: the setup's own sentence"],
    ];
    for (const [body, status, message, says] of checks) {
      const r = await logged(Object.assign({ action: "setOrgFundraiser" }, body), admin);
      ok(says, refused(r, status, message) && keys(r.body) === "message,status" && quiet(r) && unchangedAcme());
    }

    let r = await logged({ action: "setOrgFundraiser", org: "acme", fundraiser: { mode: "percent", percent: 10, label: " Example Boosters ", showOnShop: true } }, manager);
    const pct = { mode: "percent", percent: 10, label: "Example Boosters", showOnShop: true };
    ok("a Manager sets a 10% fundraiser: 200 { status: \"ok\", fundraiser } in the parsed shape, label trimmed", r.status === 200 && same(r.body, { status: "ok", fundraiser: pct }));
    ok("…stored as basis points on the shop's row", same(JSON.parse(orgRow("acme").fundraiserJson), { mode: "percent", percentBps: 1000, label: "Example Boosters", showOnShop: true }));
    ok("…leaving the shop's updatedAt alone (a live setting, never an unpublished change)", orgRow("acme").updatedAt === "2026-01-01T00:00:00.000Z");
    ok("…one audit row org.fundraiser_set for the shop, { from: null, to: the new fundraiser }",
      r.rows.length === 1 && r.rows[0].action === "org.fundraiser_set" && r.rows[0].orgId === "acme" && r.rows[0].orderId === null && same(r.rows[0].detail, { from: null, to: pct }));
    ok("…and the catalog moves to a new version, its cached version cleared", r.bumped === 1 && r.clears === 1);

    r = await logged({ action: "setOrgFundraiser", org: "acme", fundraiser: { mode: "percent", percent: "10.00", label: "Example Boosters", showOnShop: true } }, admin);
    ok("saving the same fundraiser again (written differently) answers ok quietly: no audit row, no new catalog version, no cache clear",
      r.status === 200 && same(r.body, { status: "ok", fundraiser: pct }) && quiet(r));

    r = await logged({ action: "setOrgFundraiser", org: "acme", fundraiser: { mode: "perPiece", amount: "2", label: "Example Boosters" } }, admin);
    const per = { mode: "perPiece", amount: 2, label: "Example Boosters", showOnShop: false };
    ok("changing it to $2 a piece: { from: the percent, to: the amount per piece }, show on the shop off by default",
      r.status === 200 && same(r.body.fundraiser, per) && r.rows.length === 1 && same(r.rows[0].detail, { from: pct, to: per }) && r.bumped === 1 && r.clears === 1 &&
      same(JSON.parse(orgRow("acme").fundraiserJson), { mode: "perPiece", cents: 200, label: "Example Boosters", showOnShop: false }));

    r = await logged({ action: "setOrgFundraiser", org: "acme", fundraiser: { mode: "none" } }, admin);
    ok("{ mode: \"none\" } ends it: fundraiser null, the row emptied, audited { from: the amount per piece, to: null }",
      r.status === 200 && same(r.body, { status: "ok", fundraiser: null }) && orgRow("acme").fundraiserJson === "" && r.rows.length === 1 && same(r.rows[0].detail, { from: per, to: null }) && r.bumped === 1);
    r = await logged({ action: "setOrgFundraiser", org: "acme", fundraiser: null }, admin);
    ok("an explicit null for a shop that has none is ok and quiet", r.status === 200 && same(r.body, { status: "ok", fundraiser: null }) && quiet(r));

    await call({ action: "setOrgFundraiser", org: "acme", fundraiser: pct }, admin);
    r = await logged({ action: "setOrgFundraiser", org: "acme", fundraiser: null }, admin);
    ok("an explicit null clears a fundraiser: audited { from: the percent, to: null }, catalog bumped",
      r.status === 200 && orgRow("acme").fundraiserJson === "" && r.rows.length === 1 && same(r.rows[0].detail, { from: pct, to: null }) && r.bumped === 1 && r.clears === 1);

    globalThis.__t325ClearFails = true;
    const { out: failed, logs } = await quietly(() => logged({ action: "setOrgFundraiser", org: "acme", fundraiser: pct }, admin));
    globalThis.__t325ClearFails = false;
    ok("if the catalog's cache can't be cleared, the fundraiser is still saved and audited, and the failure is logged, not answered",
      failed.status === 200 && same(failed.body, { status: "ok", fundraiser: pct }) && failed.rows.length === 1 && failed.bumped === 1 &&
      orgRow("acme").fundraiserJson !== "" && logs.some(l => l.includes("catalog version bump failed")));

    const lo = await call({ action: "listOrgs" }, admin);
    const label = (id) => { const o = ((lo.body && lo.body.orgs) || []).find(x => x.orgId === id); return o ? o.fundraiserLabel : undefined; };
    ok("listOrgs answers each shop's fundraiserLabel: who its fundraiser supports (Example Club → \"Example Boosters\")",
      lo.status === 200 && label("acme") === "Example Boosters");
    ok("…and \"\" for a shop with none", label("band") === "" && label("blank") === "");
    ok("…and no fundraiser amounts (only the label)", ((lo.body && lo.body.orgs) || []).every(o => !("fundraiser" in o) && keys(o) === "fundraiserLabel,name,orgId,subdomain"));
  }

  // Orders under test, priced with Example Club's 10% fundraiser (set above): O-1 two caps at $20, shipped; O-2 one cap,
  // paid but not shipped yet; a payout to Example Band (no fundraiser) on 2026-03-05.
  const cap = (qty) => [{ productId: "cap", name: "Cap", type: "cap", size: "OSFA", qty, unitPrice: 20 }];
  await lib.insertOrder(d1, { orderId: "O-1", orgId: "acme", customerName: "Pat Example", contact: "pat@example.com", placedAt: "2026-03-10T15:00:00.000Z" }, cap(2));
  await lib.insertOrder(d1, { orderId: "O-2", orgId: "acme", customerName: "Lee Example", contact: "lee@example.com", placedAt: "2026-03-11T15:00:00.000Z" }, cap(1));
  d1._raw.exec(`UPDATE orders SET paid = 1; UPDATE orders SET shippedAt = '2026-03-12T15:00:00.000Z' WHERE orderId = 'O-1';`);
  ok("the orders under test raised $4.00 and $2.00 for Example Club's fundraiser",
    q("SELECT sum(fundraiserCents) c FROM order_items WHERE orderId = 'O-1'")[0].c === 400 && q("SELECT sum(fundraiserCents) c FROM order_items WHERE orderId = 'O-2'")[0].c === 200);

  console.log("\n=== recordFundraiserPayout ===");
  let firstPayout;
  {
    const base = { action: "recordFundraiserPayout", org: "acme", amount: 3, date: "2026-03-20", accountId: 1, note: "Spring check" };
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const checks = [
      [{ org: undefined }, 400, CHOOSE_SHOP, "no shop named: 400 \"Choose a shop.\""],
      [{ org: ["acme"] }, 400, BAD_SHOP, "a shop that isn't text: 400 \"That shop isn't valid.\""],
      [{ org: "no-such-shop" }, 404, UNKNOWN_SHOP, "a shop that doesn't exist: 404 \"Unknown shop\""],
      [{ amount: undefined }, 400, AMOUNT, "no amount: 400 \"" + AMOUNT + "\""],
      [{ amount: "" }, 400, AMOUNT, "an empty amount: the same"],
      [{ amount: null }, 400, AMOUNT, "a null amount: the same"],
      [{ amount: true }, 400, AMOUNT, "true as the amount: the same"],
      [{ amount: "lots" }, 400, AMOUNT, "an amount that isn't a number: the same"],
      [{ amount: 0 }, 400, AMOUNT, "$0: the same"],
      [{ amount: -5 }, 400, AMOUNT, "a negative amount: the same"],
      [{ amount: 1000000.01 }, 400, AMOUNT, "over $1,000,000: the same"],
      [{ date: undefined }, 400, DATE, "no date: 400 \"" + DATE + "\""],
      [{ date: "03/20/2026" }, 400, DATE, "a date in another form: the same"],
      [{ date: "2026-02-30" }, 400, DATE, "a day that doesn't exist (February 30): the same"],
      [{ date: tomorrow }, 400, FUTURE, "tomorrow (UTC): 400 \"" + FUTURE + "\""],
      [{ date: "2019-12-31" }, 400, TOO_OLD, "before 2020: 400 \"" + TOO_OLD + "\""],
      [{ accountId: undefined }, 400, ACCOUNT, "no account: 400 \"" + ACCOUNT + "\""],
      [{ accountId: 999 }, 400, ACCOUNT, "an account that doesn't exist: the same"],
      [{ accountId: 90 }, 400, ACCOUNT, "an account that is no longer active: the same"],
      [{ amount: 5.555 }, 400, "The amount must be in whole cents.", "an amount in part-cents: the database's own refusal, as a 400"],
    ];
    const exp = expenseCount();
    for (const [change, status, message, says] of checks) {
      const r = await logged(Object.assign({}, base, change), admin);
      ok(says, refused(r, status, message) && keys(r.body) === "message,status" && r.rows.length === 0 && expenseCount() === exp);
    }
    ok("the earliest allowed date, 2020-01-01, is accepted", (await call(Object.assign({}, base, { date: "2020-01-01", amount: 1 }), admin)).status === 200);
    ok("…and so is $1,000,000 exactly", (await call(Object.assign({}, base, { amount: 1000000 }), admin)).status === 200);
    d1._raw.exec("DELETE FROM expenses; DELETE FROM audit_log WHERE action = 'fundraiser.payout_recorded';");

    // A closed month (closePeriod, as Periods & Export does it).
    const closed = await call({ action: "closePeriod", month: "2026-02" }, admin);
    ok("February 2026 is closed for the checks below", closed.status === 200 && q("SELECT count(*) n FROM closed_periods WHERE month = '2026-02'")[0].n === 1);
    let r = await logged(Object.assign({}, base, { date: "2026-02-10" }), admin);
    ok("a payout dated in a closed month: 409 \"February 2026 is closed (already filed). Reopen it under Periods & Export to change it.\"",
      refused(r, 409, "February 2026 is closed (already filed). Reopen it under Periods & Export to change it.") && r.rows.length === 0 && expenseCount() === 0);

    r = await logged(Object.assign({}, base, { note: "  Spring check  " }), manager);
    firstPayout = r.body.id;
    ok("a Manager records $3 paid to Example Club's group on 2026-03-20: 200 { status: \"ok\", id }",
      r.status === 200 && keys(r.body) === "id,status" && r.body.status === "ok" && Number.isInteger(r.body.id) && r.body.id > 0);
    const e = q("SELECT * FROM expenses WHERE id = " + Number(firstPayout))[0];
    ok("…an expense in the built-in Fundraiser payouts category, tied to the shop, from Business checking",
      !!e && e.categoryId === cat.id && e.fundraiserOrgId === "acme" && e.accountId === 1 && e.amountCents === 300 && e.expenseDate === "2026-03-20");
    ok("…described \"Fundraiser payout — Example Boosters — Spring check\" (the note trimmed), paid to Example Boosters",
      e.description === "Fundraiser payout — Example Boosters — Spring check" && e.vendor === "Example Boosters");
    ok("…all business use, the vendor charged tax, not paid personally", e.businessUsePct === 100 && e.vendorChargedTax === 1 && e.paidPersonally === 0);
    ok("…audited fundraiser.payout_recorded { expenseId, amount, date, accountId, note, label } for the shop",
      r.rows.length === 1 && r.rows[0].action === "fundraiser.payout_recorded" && r.rows[0].orgId === "acme" && r.rows[0].orderId === null &&
      same(r.rows[0].detail, { expenseId: firstPayout, amount: 3, date: "2026-03-20", accountId: 1, note: "Spring check", label: "Example Boosters" }));

    r = await logged(Object.assign({}, base, { org: "band", amount: "7.5", date: "2026-03-05", note: "n".repeat(250) }), admin);
    const e2 = q("SELECT * FROM expenses WHERE id = " + Number(r.body.id))[0];
    ok("a shop with no fundraiser: paid to the shop's name, the note cut to 200 characters, an amount sent as text read as a number",
      r.status === 200 && e2.description === "Fundraiser payout — Example Band — " + "n".repeat(200) && e2.vendor === "Example Band" && e2.amountCents === 750 &&
      r.rows.length === 1 && r.rows[0].detail.label === "Example Band" && r.rows[0].detail.note === "n".repeat(200) && r.rows[0].detail.amount === 7.5);
    r = await logged(Object.assign({}, base, { org: "blank", amount: 1, date: "2026-03-06", note: null }), admin);
    const e3 = q("SELECT * FROM expenses WHERE id = " + Number(r.body.id))[0];
    ok("a shop with no name and no fundraiser: labelled with its id; no note leaves the description without one",
      r.status === 200 && e3.description === "Fundraiser payout — blank" && r.rows[0].detail.label === "blank" && r.rows[0].detail.note === "");
    d1._raw.exec("UPDATE expenses SET deletedAt = '2026-03-07T00:00:00.000Z' WHERE id = " + Number(r.body.id));
  }

  console.log("\n=== getFundraisingReport ===");
  {
    const range = { action: "getFundraisingReport", dateFrom: "2026-03-01", dateTo: "2026-03-31" };
    const bad = [
      [{ dateFrom: undefined }, BAD_RANGE, "no start date: 400 \"" + BAD_RANGE + "\""],
      [{ dateTo: "" }, BAD_RANGE, "an empty end date: the same"],
      [{ dateFrom: "2026/03/01" }, BAD_RANGE, "a date in another form: the same"],
      [{ dateTo: "2026-02-30" }, BAD_RANGE, "a day that doesn't exist (February 30): the same"],
      [{ dateFrom: "2026-04-01" }, REVERSED, "a start after the end: 400 \"" + REVERSED + "\""],
    ];
    for (const [change, message, says] of bad) ok(says, refused(await call(Object.assign({}, range, change), admin), 400, message));
    ok("a shop that doesn't exist: 404 \"Unknown shop\"", refused(await call(Object.assign({}, range, { org: "no-such-shop" }), admin), 404, UNKNOWN_SHOP));
    ok("a shop that isn't text: 400 \"That shop isn't valid.\"", refused(await call(Object.assign({}, range, { org: 7 }), admin), 400, BAD_SHOP));

    let r = await call(Object.assign({}, range, { dateFrom: " 2026-03-01 " }), staff);
    ok("Back office reads March: { status, dateFrom, dateTo, orgId, saleDate, shops, orders, totals, owedAsOf } (dates trimmed)",
      r.status === 200 && keys(r.body) === "dateFrom,dateTo,orders,orgId,owedAsOf,saleDate,shops,status,totals" &&
      r.body.status === "ok" && r.body.dateFrom === "2026-03-01" && r.body.dateTo === "2026-03-31");
    ok("…orgId null (every shop), owed as of the end date, sale date by the default basis \"shipped\"",
      r.body.orgId === null && r.body.owedAsOf === "2026-03-31" && r.body.saleDate === "shipped");
    ok("…only the shipped order counts: O-1, two pieces, $40 sold, $4 raised", same(r.body.orders.map(o => o.orderId), ["O-1"]) &&
      same(r.body.orders[0], { orderId: "O-1", orgId: "acme", placedAt: "2026-03-10T15:00:00.000Z", customerName: "Pat Example", pieces: 2, sales: 40, raised: 4 }));
    const club = r.body.shops.find(s => s.orgId === "acme"), band = r.body.shops.find(s => s.orgId === "band");
    ok("…Example Club: its fundraiser now, $3 paid out in March, $1 still owed",
      same(club, { orgId: "acme", name: "Example Club", label: "Example Boosters", mode: "percent", orders: 1, pieces: 2, sales: 40, raised: 4, paidOut: 3, owed: 1 }));
    ok("…Example Band, with no fundraiser but a payout in March: label \"\", mode null, owed -$7.50 (not clamped)",
      same(band, { orgId: "band", name: "Example Band", label: "", mode: null, orders: 0, pieces: 0, sales: 0, raised: 0, paidOut: 7.5, owed: -7.5 }));
    ok("…shops sorted by name; the unnamed shop's payout, deleted, leaves it out", same(r.body.shops.map(s => s.orgId), ["band", "acme"]));
    ok("…totals add the shops up", same(r.body.totals, { orders: 1, pieces: 2, sales: 40, raised: 4, paidOut: 10.5, owed: -6.5 }));

    r = await call(Object.assign({}, range, { org: "acme", dateTo: "2026-03-15" }), admin);
    ok("one shop, up to March 15: orgId \"acme\", owed as of March 15 — the March 20 payout not yet taken off",
      r.status === 200 && r.body.orgId === "acme" && r.body.owedAsOf === "2026-03-15" && same(r.body.shops.map(s => s.orgId), ["acme"]) &&
      r.body.shops[0].paidOut === 0 && r.body.shops[0].owed === 4);
    r = await call(Object.assign({}, range, { org: "acme", dateFrom: "2026-04-01", dateTo: "2026-04-30" }), admin);
    ok("April alone: nothing sold or paid out in the range, but owed is all time to April 30: $1",
      r.status === 200 && same(r.body.orders, []) && r.body.shops[0].raised === 0 && r.body.shops[0].paidOut === 0 && r.body.shops[0].owed === 1);

    d1._raw.exec(`INSERT OR REPLACE INTO global_settings (key, value) VALUES ('accounting', '{"saleDate":"placed"}')`);
    r = await call(range, admin);
    ok("with sales dated when placed, the answer says saleDate \"placed\" and the unshipped O-2 counts too",
      r.status === 200 && r.body.saleDate === "placed" && same(r.body.orders.map(o => o.orderId), ["O-1", "O-2"]) && r.body.shops.find(s => s.orgId === "acme").raised === 6);
    d1._raw.exec(`DELETE FROM global_settings WHERE key = 'accounting'`);
  }

  console.log("\n=== listFundraiserPayouts ===");
  {
    let r = await call({ action: "listFundraiserPayouts" }, staff);
    ok("Back office lists the payouts: { status, payouts }, newest first, the deleted one left out",
      r.status === 200 && keys(r.body) === "payouts,status" && same(r.body.payouts.map(p => p.date), ["2026-03-20", "2026-03-05"]));
    const p = r.body.payouts[0];
    ok("…each an expense with its shop and account: id, date, description, amount, accountId, category, orgId, orgName, accountName",
      p.id === firstPayout && p.description === "Fundraiser payout — Example Boosters — Spring check" && p.amount === 3 && p.accountId === 1 &&
      p.category === "Fundraiser payouts" && p.fundraiserOrgId === "acme" && p.orgId === "acme" && p.orgName === "Example Club" && p.accountName === "Business checking" && p.note === undefined);
    r = await call({ action: "listFundraiserPayouts", org: "band" }, admin);
    ok("one shop's payouts", r.status === 200 && same(r.body.payouts.map(x => x.orgId), ["band"]));
    r = await call({ action: "listFundraiserPayouts", dateFrom: "2026-03-10" }, admin);
    const r2 = await call({ action: "listFundraiserPayouts", dateTo: "2026-03-10" }, admin);
    ok("from a date, and up to a date", same(r.body.payouts.map(x => x.date), ["2026-03-20"]) && same(r2.body.payouts.map(x => x.date), ["2026-03-05"]));
    ok("a date in another form: 400 \"" + BAD_RANGE + "\" (from or to)",
      refused(await call({ action: "listFundraiserPayouts", dateFrom: "March 1" }, admin), 400, BAD_RANGE) && refused(await call({ action: "listFundraiserPayouts", dateTo: "2026-13-01" }, admin), 400, BAD_RANGE));
    ok("a shop that doesn't exist: 404 \"Unknown shop\"; one that isn't text: 400",
      refused(await call({ action: "listFundraiserPayouts", org: "no-such-shop" }, admin), 404, UNKNOWN_SHOP) && refused(await call({ action: "listFundraiserPayouts", org: { id: "acme" } }, admin), 400, BAD_SHOP));
  }

  console.log("\n=== The audit log: a payout's amounts need costs.view ===");
  {
    const read_ = async (cookie, filter) => (await call({ action: "getAuditLog", filter, limit: 50 }, cookie)).body.entries || [];
    const asAdmin = (await read_(admin, "fundraiser.payout_recorded")).find(e => e.detail && e.detail.expenseId === firstPayout);
    ok("an Admin (costs.view) sees the payout's detail: amount, date, account, note, label",
      !!asAdmin && asAdmin.detail.amount === 3 && asAdmin.detail.label === "Example Boosters" && asAdmin.detail.note === "Spring check");
    const hidden = await read_(auditor, "fundraiser.payout_recorded");
    ok("a role that reads the audit log without costs.view sees the payout rows, with no detail",
      hidden.length >= 3 && hidden.every(e => e.action === "fundraiser.payout_recorded" && e.detail === null));
    const set = await read_(auditor, "org.fundraiser_set");
    ok("…while a fundraiser being set (no money paid) keeps its detail for that role", set.length > 0 && set.every(e => e.detail && "from" in e.detail && "to" in e.detail));
    const R = new RegExp(ordersJs.match(/const MONEY_AUDIT_ACTIONS_ = new RegExp\(("[\s\S]*?")\);/)[1].split(/"\s*\+\s*"/).join("").replace(/^"|"$/g, "").replace(/\\\\/g, "\\"));
    ok("the money pattern matches fundraiser.payout_recorded exactly, not org.fundraiser_set or a longer name",
      R.test("fundraiser.payout_recorded") && !R.test("org.fundraiser_set") && !R.test("fundraiser.payout_recorded_extra"));
  }

  // ---- A database built from the migrations up to 0109, signed in with testlib/roles.js adminAs() ----
  console.log("\n=== A database that hasn't had migrations/0110 yet ===");
  {
    const glue = (signIn) => new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
      "const requireAdmin = async () => null; const adminActor = () => 'owner@example.test';\n" + signIn + "\n" + strip(read("functions/_lib/permissions.js")) + "\n" +
      "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
      "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
      "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
      "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false, sendEstimateEmail = async () => false;\n" +
      strip(read("functions/_lib/db.js")) + "\n" + strip(ordersJs) + "\nreturn onRequestPost;")();
    const db = await createD1();
    db._raw.exec(read("testlib/schema-pre-0006.sql"));
    for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006" && f.slice(0, 4) <= "0109").sort()) db.execFile(read("migrations/" + f));
    db._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Example Club','t','t');`);
    const api = glue(roles.adminAs("admin"));
    const old = async (body) => { const waits = [];
      const res = await api({ env: { DB: db }, waitUntil: (p) => waits.push(p && p.then ? p.then(() => {}, () => {}) : null),
        request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
      await Promise.all(waits); return { status: res.status, body: JSON.parse(await res.text()) }; };
    ok("the database under test has no orgs.fundraiserJson and no expenses.fundraiserOrgId",
      !db.q("PRAGMA table_info(orgs)").some(c => c.name === "fundraiserJson") && !db.q("PRAGMA table_info(expenses)").some(c => c.name === "fundraiserOrgId"));
    const log = db.q("SELECT count(*) n FROM audit_log")[0].n;
    let r = await old({ action: "getFundraisingReport", dateFrom: "2026-03-01", dateTo: "2026-03-31" });
    ok("getFundraisingReport answers an empty report, every field there",
      r.status === 200 && r.body.status === "ok" && same(r.body.shops, []) && same(r.body.orders, []) && r.body.owedAsOf === "2026-03-31" && r.body.saleDate === "shipped" &&
      same(r.body.totals, { orders: 0, pieces: 0, sales: 0, raised: 0, paidOut: 0, owed: 0 }));
    r = await old({ action: "listFundraiserPayouts" });
    ok("listFundraiserPayouts answers no payouts", r.status === 200 && same(r.body, { status: "ok", payouts: [] }));
    r = await old({ action: "recordFundraiserPayout", org: "acme", amount: 5, date: "2026-03-10", accountId: 1 });
    const NOT_READY_503 = "Fundraising isn't ready yet: the database is still being updated. Try again in a minute.";
    ok("recordFundraiserPayout is refused with 503 \"" + NOT_READY_503 + "\"", refused(r, 503, NOT_READY_503) && db.q("SELECT count(*) n FROM expenses")[0].n === 0);
    const ver = () => { try { return JSON.stringify(db.q("SELECT value FROM global_settings WHERE key = 'catalogVersion'")); } catch (e) { return ""; } };
    const ver0 = ver();
    r = await old({ action: "setOrgFundraiser", org: "acme", fundraiser: { mode: "percent", percent: 10, label: "Example Boosters" } });
    ok("setOrgFundraiser is refused with the same 503, not answered as saved", refused(r, 503, NOT_READY_503));
    ok("…and the catalog version is left alone", ver() === ver0);
    r = await old({ action: "setOrgFundraiser", org: "acme", fundraiser: null });
    ok("ending one is refused the same way", refused(r, 503, NOT_READY_503));
    ok("none of them wrote an audit row", db.q("SELECT count(*) n FROM audit_log")[0].n === log);
    r = await old({ action: "recordFundraiserPayout", org: "acme", amount: 0, date: "2026-03-10", accountId: 1 });
    ok("what is wrong with the request itself is still said first", refused(r, 400, AMOUNT));
  }
})().catch((e) => { console.error(e); process.exit(1); });
