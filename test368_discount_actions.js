const fs = require("fs");
const { ok } = require("./testlib/check");
const { createD1 } = require("./testlib/d1-shim.js");
const roles = require("./testlib/roles");
const { makeAuth, prelude, strip, read, request, answer } = require("./testlib/auth-harness");

// Discount codes (migrations/0115): the six admin actions of /api/orders, through the real handler.
//   - functions/_lib/permissions.js: the Discount codes area, each action's function and level, the built-in defaults
//   - who may: every built-in role and a made-up one with edit but not full (no delete), behind the REAL sign-in gate
//   - the Discount codes switch (FEATURE_ACTIONS), and NO_MONTH_ACTIONS (a code changes no month's numbers)
//   - listDiscountCodes, getDiscountCode, saveDiscountCode, createDiscountCodes, setDiscountCodeActive,
//     deleteDiscountCode: every refusal and its sentence, 404 / unknown shop, 409 for a taken code and a used code,
//     the answers' shapes, the audit rows (an edit logs only what changed; bulk codes log a count, never the emails)
//   - voiding or deleting an order that used a code: the use is given back and the void's audit row names the code
//   - a database that hasn't had 0115 yet (503 for the writes that need the tables), and one that is down
// (Checkout — checkDiscountCode, claiming a use, the order's discount — is other files' business.)
// Real SQL (sql.js) under the real db.js and orders.js. Invented shops and people only.

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keys = (o) => Object.keys(o || {}).sort().join(",");
const forbidden = (r) => r.status === 403 && r.body && r.body.status === "error" && r.body.code === "forbidden";
const refused = (r, status, message) => r.status === status && r.body && r.body.status === "error" && r.body.message === message;
const SIX = ["listDiscountCodes", "getDiscountCode", "saveDiscountCode", "createDiscountCodes", "setDiscountCodeActive", "deleteDiscountCode"];
const WRITES = ["saveDiscountCode", "createDiscountCodes", "setDiscountCodeActive", "deleteDiscountCode"];
const ROLE = "Your role can't do this. Ask an admin.";
const INVALID = "That code isn't valid.", NOT_FOUND = "Discount code not found", BAD_SHOP = "That shop isn't valid.", UNKNOWN_SHOP = "Unknown shop";
const NO_EMAILS = "Enter the email addresses, one per line.";
const OFF = "Discount codes is turned off. Turn it on under Settings → Global settings → Features.";
const LOCKED = "This code has been used — you can change its expiry, uses, note or switch it off.";
const USED_NO_DELETE = "This code has been used, so it can't be deleted — switch it off instead.";
const NOT_READY_DB = "Discount codes need the latest database update. Apply the migrations, then try again.";
const CODE_KEYS = "active,amount,code,createdAt,createdBy,email,expiresOn,freeShipping,id,kind,label,maxDiscount,maxUses,minOrder,note,oncePerEmail,orgId,orgName,percent,status,used";
const ordersJs = read("functions/api/orders.js");

(async () => {
  console.log("=== The permission (functions/_lib/permissions.js) and orders.js's lists ===");
  {
    const at = roles.PERMISSION_AREAS.findIndex(a => a.key === "discounts");
    ok("there is a Marketing area with one page (#discounts): discounts.codes \"Discount codes\", and its Email campaigns tab's discounts.campaigns (migrations/0117)",
      at >= 0 && same(roles.PERMISSION_AREAS[at], { key: "discounts", label: "Marketing", items: [{ hash: "discounts", label: "Marketing", fns: [["discounts.codes", "Discount codes"], ["discounts.campaigns", "Email campaigns"]] }] }));
    ok("…placed right after Quotes", at > 0 && roles.PERMISSION_AREAS[at - 1].key === "quotes");
    ok("the function is on the Roles screen's list once", roles.PERM_FUNCTIONS.filter(f => f === "discounts.codes").length === 1);
    const perm = (a) => roles.ACTION_PERM[a];
    ok("listing codes and opening one need discounts.codes at read",
      same(perm("listDiscountCodes"), [["discounts.codes", "read"]]) && same(perm("getDiscountCode"), [["discounts.codes", "read"]]));
    ok("saving a code, making codes for a list, and switching one on or off need discounts.codes at edit",
      ["saveDiscountCode", "createDiscountCodes", "setDiscountCodeActive"].every(a => same(perm(a), [["discounts.codes", "edit"]])));
    ok("deleting a code needs discounts.codes at full", same(perm("deleteDiscountCode"), [["discounts.codes", "full"]]));
    ok("the storefront's checkDiscountCode is no admin action (no permission listed: it needs no sign-in)", perm("checkDiscountCode") === undefined &&
      ordersJs.includes('const STOREFRONT_CHECK_DISCOUNT_ = "checkDiscountCode";'));
    const level = (role, fn) => roles.effectivePermissions(roles.DEFAULT_ROLES[role])[fn];
    ok("built-in defaults for discounts.codes: Admin full, Manager full, Back office read, Production none",
      ["admin", "manager", "staff", "production"].map(r => level(r, "discounts.codes")).join() === "full,full,read,none");
    const P = new Function(read("functions/_lib/permissions.js").replace(/export (async function|function|const)/g, "$1") + "\nreturn { normalizePermissions, roleAllows, ACTION_PERM };")();
    const stored = P.normalizePermissions({ fns: { "quotes.estimates": "edit" } });
    ok("a role stored before the permission existed has none of it, so none of the six actions",
      stored.fns["discounts.codes"] === "none" && SIX.every(a => !P.roleAllows({ key: "r_old", permissions: stored }, P.ACTION_PERM[a])));
    const featureLists = {};
    for (const m of ordersJs.match(/const FEATURE_ACTIONS = \{([\s\S]*?)\n\};/)[1].matchAll(/\n  (\w+): \[([\s\S]*?)\],/g)) featureLists[m[1]] = [...m[2].matchAll(/"(\w+)"/g)].map(x => x[1]);
    ok("the six actions, the Local sale's code check and the two codes-on-an-order actions (phase 6) are listed under the discounts feature switch", same([...(featureLists.discounts || [])].sort(), [...SIX, "checkLocalSaleCode", "applyOrderDiscountCode", "removeOrderDiscountCode"].sort()));
    ok("…and under no other switch", Object.entries(featureLists).filter(([k]) => k !== "discounts").every(([, l]) => SIX.every(a => !l.includes(a))));
    const noMonth = [...ordersJs.match(/const NO_MONTH_ACTIONS = new Set\(\[([\s\S]*?)\]\);/)[1].matchAll(/"(\w+)"/g)].map(m => m[1]);
    ok("the four writes change no month's numbers (NO_MONTH_ACTIONS): a code is no sale", WRITES.every(a => noMonth.includes(a)));
  }

  // ---- The real endpoint behind the real sign-in (adminAuth.js), on schema.sql ----
  // The catalog stand-in carries the feature switches from globalThis.__t332Features (the gate reads them there).
  const STUB = "const getCatalogData = async () => ({ subdomainMap: {}, business: {} });";
  const pre = prelude(false, false);
  if (!pre.includes(STUB)) throw new Error("testlib/auth-harness.js's catalog stand-in changed: update test368");
  const A = await makeAuth();
  const d1 = A.d1;
  const post = new Function("__hits", pre.replace(STUB, "const getCatalogData = async () => ({ subdomainMap: {}, business: {}, features: globalThis.__t332Features || {} });") +
    strip(read("functions/_lib/catalogValidation.js")) + "\n" + strip(read("functions/_lib/quoteToken.js")) + "\n" +
    "const invalidateCatalogVersionCache = () => {}; const selectBox = () => null;\n" +
    strip(read("functions/_lib/setupStatus.js")) + "\n" + strip(read("functions/_lib/vendorCredentials.js")) + "\n" + strip(read("functions/_lib/smtp.js")) + "\n" +
    strip(read("functions/_lib/email.js")) + "\n" + strip(ordersJs) + "\nreturn onRequestPost;")(A.hits);
  const call = async (body, cookie) => {
    const waits = [];
    const res = await post({ request: request("/api/orders", body, { cookie }), env: A.env, waitUntil: (p) => waits.push(Promise.resolve(p).catch(() => {})) });
    await Promise.all(waits);
    return answer(res);
  };
  const lib = new Function(strip(read("functions/_lib/db.js")) + "\nreturn { insertOrder, claimDiscountCode, localToday };")();
  const q = (sql) => d1.q(sql);
  const auditCount = () => q("SELECT count(*) n FROM audit_log")[0].n;
  const codeCount = () => q("SELECT count(*) n FROM discount_codes")[0].n;
  const codeRow = (code) => q("SELECT * FROM discount_codes").find(c => c.code === code) || null;
  const logged = async (body, cookie) => { const before = q("SELECT COALESCE(MAX(id), 0) m FROM audit_log")[0].m; const r = await call(body, cookie);
    return { ...r, rows: q("SELECT * FROM audit_log WHERE id > " + before + " ORDER BY id").map(x => ({ ...x, detail: JSON.parse(x.detail || "null") })) }; };
  const today = await lib.localToday(A.env);

  const admin = await A.firstAdmin("Olive Owner", "olive@example.com");
  const manager = await A.addUser(admin, "manager", "Mo Manager", "mo@example.com");
  const staff = await A.addUser(admin, "staff", "Sam Staff", "sam@example.com");
  const prod = await A.addUser(admin, "production", "Pat Production", "pp@example.com");
  // A made-up role: Back office, with discount codes at edit (not full).
  const staffRole = (await A.users({ action: "listRoles" }, admin)).body.roles.find(x => x.key === "staff");
  const editorPerms = JSON.parse(JSON.stringify(staffRole.permissions));
  editorPerms.fns["discounts.codes"] = "edit";
  const editorKey = (await A.users({ action: "saveRole", name: "Codes editor", rank: 40, permissions: editorPerms }, admin)).body.role.key;
  const editor = await A.addUser(admin, editorKey, "Eddie Editor", "eddie@example.com");
  const me = async (cookie) => (await A.users({ action: "me" }, cookie)).body.permissions;
  ok("the roles under test are what they should be: Back office reads codes, Production has none, the Codes editor has edit",
    (await me(staff))["discounts.codes"] === "read" && (await me(prod))["discounts.codes"] === "none" && (await me(editor))["discounts.codes"] === "edit" &&
    (await me(manager))["discounts.codes"] === "full");

  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Example Club','t','t');
    INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('band','band','Example Band','t','t');`);

  console.log("\n=== Signed out: nothing answers ===");
  {
    const log = auditCount(), n = codeCount();
    const bodies = { listDiscountCodes: {}, getDiscountCode: { id: 1 }, saveDiscountCode: { code: { code: "SAVE10", kind: "percent", percent: 10, maxUses: 5 } },
      createDiscountCodes: { emails: ["pat@example.com"], kind: "percent", percent: 10 }, setDiscountCodeActive: { id: 1, active: false }, deleteDiscountCode: { id: 1 } };
    const got = [];
    for (const a of SIX) got.push(await call(Object.assign({ action: a }, bodies[a]), ""));
    ok("each of the six actions answers 401 Unauthorized without a session, giving nothing away", got.every(r => refused(r, 401, "Unauthorized") && keys(r.body) === "message,status"));
    ok("nothing was made or logged", auditCount() === log && codeCount() === n);
  }

  console.log("\n=== Who may: each built-in role and a role with edit but not full ===");
  {
    // Bodies refused AFTER the gate (400), so the same request can be sent as every role and change nothing.
    const probe = { listDiscountCodes: { status: "nope" }, getDiscountCode: { id: "x" }, saveDiscountCode: { code: null },
      createDiscountCodes: { emails: null }, setDiscountCodeActive: { id: 0, active: true }, deleteDiscountCode: { id: "x" } };
    const who = { production: prod, staff, editor, manager, admin };
    const row = async (a) => { const out = []; for (const r of ["production", "staff", "editor", "manager", "admin"]) { const x = await call(Object.assign({ action: a }, probe[a]), who[r]);
      out.push(forbidden(x) ? (x.body.message === ROLE ? "no" : "no?") : x.status === 400 ? "yes" : "? " + x.status); } return out.join(); };
    const log = auditCount();
    ok("listDiscountCodes: not Production; Back office, the Codes editor, Manager and Admin", await row("listDiscountCodes") === "no,yes,yes,yes,yes");
    ok("getDiscountCode: the same", await row("getDiscountCode") === "no,yes,yes,yes,yes");
    ok("saveDiscountCode: not Production or Back office (read only); the Codes editor, Manager and Admin", await row("saveDiscountCode") === "no,no,yes,yes,yes");
    ok("createDiscountCodes: the same", await row("createDiscountCodes") === "no,no,yes,yes,yes");
    ok("setDiscountCodeActive: the same", await row("setDiscountCodeActive") === "no,no,yes,yes,yes");
    ok("deleteDiscountCode: only Manager and Admin (full) — not the Codes editor with edit", await row("deleteDiscountCode") === "no,no,no,yes,yes");
    ok("a refusal for the role writes nothing to the audit log", auditCount() === log);
  }

  console.log("\n=== saveDiscountCode: refusals ===");
  const base = { kind: "percent", percent: 10, maxUses: 50 };
  {
    const checks = [
      [{}, 400, INVALID, "no code object: 400 \"" + INVALID + "\""],
      [{ code: "SAVE10" }, 400, INVALID, "a code that is text, not an object: the same"],
      [{ code: [base] }, 400, INVALID, "…a list: the same"],
      [{ code: { ...base, id: "abc" } }, 400, INVALID, "an id that isn't a whole number: the same"],
      [{ code: { ...base, id: 0 } }, 400, INVALID, "…an id of 0: the same"],
      [{ code: { ...base, id: -3 } }, 400, INVALID, "…a negative id: the same"],
      [{ code: { ...base, id: 1.5 } }, 400, INVALID, "…an id of 1.5: the same"],
      [{ code: { ...base, id: true } }, 400, INVALID, "…an id of true: the same"],
      [{ code: { ...base, orgId: 12 } }, 400, BAD_SHOP, "a shop that isn't text: 400 \"" + BAD_SHOP + "\""],
      [{ code: { ...base, orgId: "x".repeat(101) } }, 400, BAD_SHOP, "…over 100 characters: the same"],
      [{ code: { ...base, orgId: "no-such-shop" } }, 404, UNKNOWN_SHOP, "a shop that doesn't exist: 404 \"" + UNKNOWN_SHOP + "\""],
      [{ code: { ...base, code: "AB" } }, 400, "A code is 3 to 32 letters, digits, - or _ (no spaces).", "a code of 2 characters: db.js's sentence"],
      [{ code: { ...base, code: "SAVE 10" } }, 400, "A code is 3 to 32 letters, digits, - or _ (no spaces).", "…a code with a space: the same"],
      [{ code: { ...base, code: "X".repeat(33) } }, 400, "A code is 3 to 32 letters, digits, - or _ (no spaces).", "…33 characters: the same"],
      [{ code: { ...base, kind: "half" } }, 400, "Choose percent off or an amount off.", "a kind it doesn't know"],
      [{ code: { ...base, percent: "" } }, 400, "Enter the percent off.", "no percent"],
      [{ code: { ...base, percent: true } }, 400, "Enter the percent off.", "a percent of true"],
      [{ code: { ...base, percent: 12.345 } }, 400, "The percent off can have at most two decimals.", "a percent with three decimals"],
      [{ code: { ...base, percent: 0 } }, 400, "The percent off must be from 0.01 to 100.", "a percent of 0"],
      [{ code: { ...base, percent: 100.01 } }, 400, "The percent off must be from 0.01 to 100.", "a percent over 100"],
      [{ code: { ...base, kind: "amount", percent: undefined } }, 400, "Enter the amount off.", "an amount off with no amount"],
      [{ code: { ...base, kind: "amount", amount: 1.005 } }, 400, "The amount off can't have fractions of a cent.", "an amount in part-cents"],
      [{ code: { ...base, kind: "amount", amount: 0 } }, 400, "The amount off must be from $0.01 to $10,000.", "an amount of $0"],
      [{ code: { ...base, kind: "amount", amount: 10000.01 } }, 400, "The amount off must be from $0.01 to $10,000.", "an amount over $10,000"],
      [{ code: { ...base, email: "not-an-email" } }, 400, "That email address doesn't look right.", "an email address that isn't one"],
      [{ code: { ...base, maxUses: undefined } }, 400, "Enter how many times the code can be used in all: a whole number from 1 to 100,000.", "a code for anyone with no number of uses"],
      [{ code: { ...base, maxUses: 0 } }, 400, "Enter how many times the code can be used in all: a whole number from 1 to 100,000.", "…0 uses"],
      [{ code: { ...base, maxUses: 100001 } }, 400, "Enter how many times the code can be used in all: a whole number from 1 to 100,000.", "…100,001 uses"],
      [{ code: { ...base, maxUses: 2.5 } }, 400, "Enter how many times the code can be used in all: a whole number from 1 to 100,000.", "…2.5 uses"],
      [{ code: { ...base, expiresOn: "2026-02-30" } }, 400, "The expiry date isn't a date.", "an expiry that isn't a real date"],
      [{ code: { ...base, expiresOn: "next week" } }, 400, "The expiry date isn't a date.", "…not a date at all"],
      [{ code: { ...base, expiresOn: "2026-13-01" } }, 400, "The expiry date isn't a date.", "…a 13th month: refused, not a server error (no Date for toISOString to throw on)"],
      [{ code: { ...base, expiresOn: "2026-01-32" } }, 400, "The expiry date isn't a date.", "…a 32nd day: the same"],
      [{ code: { ...base, note: "x".repeat(201) } }, 400, "The note can be at most 200 characters.", "a note over 200 characters"],
    ];
    const n = codeCount();
    for (const [body, status, message, says] of checks) {
      const r = await logged(Object.assign({ action: "saveDiscountCode" }, body), admin);
      ok(says, refused(r, status, message) && keys(r.body) === "message,status" && r.rows.length === 0 && codeCount() === n);
    }
  }

  console.log("\n=== saveDiscountCode: new codes ===");
  let save10, pat5, made;
  {
    let r = await logged({ action: "saveDiscountCode", code: { code: " save10 ", kind: "percent", percent: "10", maxUses: "50", oncePerEmail: true, note: " Spring sale " } }, admin);
    save10 = r.body.code;
    ok("an Admin makes SAVE10: 200 { status, code } in the reader's shape, the code upper-cased and trimmed",
      r.status === 200 && keys(r.body) === "code,status" && keys(save10).startsWith("active,amount,code,createdAt,createdBy") && save10.code === "SAVE10" &&
      CODE_KEYS.split(",").every(k => k in save10));
    ok("…10% off, every shop, anyone, 50 uses once per email, no expiry, on, unused; the note trimmed",
      save10.kind === "percent" && save10.percent === 10 && save10.amount === null && save10.label === "10% off" && save10.orgId === null && save10.orgName === "" &&
      save10.email === "" && save10.maxUses === 50 && save10.oncePerEmail === true && save10.expiresOn === null && save10.active === true &&
      save10.status === "active" && save10.used === 0 && same(save10.uses, []) && save10.usesTotal === 0 && save10.note === "Spring sale");
    ok("…made by the signed-in person", save10.createdBy === "olive@example.com" && /^\d{4}-\d{2}-\d{2}T/.test(save10.createdAt));
    ok("…one audit row discount_code.created, no shop, no order, with the code's settings and never its uses",
      r.rows.length === 1 && r.rows[0].action === "discount_code.created" && r.rows[0].orgId === null && r.rows[0].orderId === null &&
      same(r.rows[0].detail, { id: save10.id, code: "SAVE10", kind: "percent", percent: 10, amount: null, maxDiscount: null, orgId: null, email: "", minOrder: null, freeShipping: false, maxUses: 50, oncePerEmail: true,
        expiresOn: null, active: true, note: "Spring sale" }));

    r = await logged({ action: "saveDiscountCode", code: { code: "PAT5", kind: "amount", amount: 5, orgId: "acme", email: " Pat@Example.com ", maxUses: 40, oncePerEmail: true, expiresOn: "2099-06-30" } }, manager);
    pat5 = r.body.code;
    ok("a Manager makes one person's $5 code for Example Club: the email lower-cased, single use whatever uses were sent, never \"once per email\"",
      r.status === 200 && pat5.label === "$5.00 off" && pat5.amount === 5 && pat5.percent === null && pat5.orgId === "acme" && pat5.orgName === "Example Club" &&
      pat5.email === "pat@example.com" && pat5.maxUses === 1 && pat5.oncePerEmail === false && pat5.expiresOn === "2099-06-30" && pat5.createdBy === "mo@example.com");
    ok("…its audit row is for the shop", r.rows.length === 1 && r.rows[0].action === "discount_code.created" && r.rows[0].orgId === "acme" &&
      r.rows[0].detail.code === "PAT5" && r.rows[0].detail.amount === 5 && r.rows[0].detail.maxUses === 1);

    r = await logged({ action: "saveDiscountCode", code: { kind: "percent", percent: 12.5, maxUses: 3, active: false } }, editor);
    made = r.body.code;
    ok("the Codes editor leaves the code blank: one is made up (8 characters no one misreads), 12.5% off, made switched off",
      r.status === 200 && /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(made.code) && made.label === "12.5% off" && made.active === false && made.status === "off" &&
      r.rows.length === 1 && r.rows[0].detail.active === false && r.rows[0].detail.code === made.code);

    r = await logged({ action: "saveDiscountCode", code: { code: "Save10", kind: "amount", amount: 2, maxUses: 1 } }, admin);
    ok("a code that is taken (in any case): 409 { duplicate: true, \"The code SAVE10 is already taken. Choose another.\" }, nothing made or logged",
      r.status === 409 && same(r.body, { status: "error", message: "The code SAVE10 is already taken. Choose another.", duplicate: true }) && r.rows.length === 0 && codeCount() === 3);
  }

  console.log("\n=== saveDiscountCode: changes ===");
  {
    let r = await logged({ action: "saveDiscountCode", code: { id: 9999, ...base } }, admin);
    ok("a change to a code that doesn't exist: 404 \"" + NOT_FOUND + "\"", refused(r, 404, NOT_FOUND) && r.rows.length === 0);
    r = await logged({ action: "saveDiscountCode", code: { id: String(save10.id), code: "SAVE10", kind: "percent", percent: 10, maxUses: 50, oncePerEmail: true, note: "Spring sale" } }, admin);
    ok("saving it unchanged (its id as text): 200, no audit row", r.status === 200 && r.body.code.id === save10.id && r.rows.length === 0);
    r = await logged({ action: "saveDiscountCode", code: { id: save10.id, code: "SAVE10", kind: "percent", percent: 10, maxUses: 60, oncePerEmail: true, note: "Spring sale", expiresOn: "2099-12-31" } }, admin);
    ok("a change to its uses and expiry: one discount_code.updated row with only what changed, from and to",
      r.status === 200 && r.body.code.maxUses === 60 && r.body.code.expiresOn === "2099-12-31" && r.rows.length === 1 && r.rows[0].action === "discount_code.updated" &&
      r.rows[0].orgId === null && same(r.rows[0].detail, { id: save10.id, code: "SAVE10", from: { maxUses: 50, expiresOn: null }, to: { maxUses: 60, expiresOn: "2099-12-31" } }));
    r = await logged({ action: "saveDiscountCode", code: { id: pat5.id, code: "PAT5", kind: "amount", amount: 6, email: "pat@example.com", expiresOn: "2099-06-30" } }, admin);
    ok("an edit that leaves the shop out keeps the code's own shop (not every shop); the row is the shop's",
      r.status === 200 && r.body.code.orgId === "acme" && r.body.code.amount === 6 && r.rows.length === 1 && r.rows[0].orgId === "acme" &&
      same(r.rows[0].detail.from, { amount: 5 }) && same(r.rows[0].detail.to, { amount: 6 }));
    r = await logged({ action: "saveDiscountCode", code: { id: pat5.id, code: "PAT5", kind: "amount", amount: 6, email: "pat@example.com", expiresOn: "2099-06-30", orgId: "" } }, admin);
    ok("…while an empty shop moves an unused code to every shop, logged as the shop changing; the row keeps the old shop",
      r.status === 200 && r.body.code.orgId === null && r.rows.length === 1 && r.rows[0].orgId === "acme" && same(r.rows[0].detail.from, { orgId: "acme" }) && same(r.rows[0].detail.to, { orgId: null }));
    r = await logged({ action: "saveDiscountCode", code: { id: pat5.id, code: "save10", kind: "amount", amount: 6, email: "pat@example.com" } }, admin);
    ok("renaming a code to one that is taken: 409 duplicate, nothing logged, the code unchanged",
      r.status === 409 && r.body.duplicate === true && r.body.message === "The code SAVE10 is already taken. Choose another." && r.rows.length === 0 && codeRow("PAT5") !== null);
    r = await logged({ action: "saveDiscountCode", code: { id: pat5.id, code: "PAT5", kind: "amount", amount: 6, email: "pat@example.com", orgId: "no-such-shop" } }, admin);
    ok("an edit to a shop that doesn't exist: 404 \"Unknown shop\"", refused(r, 404, UNKNOWN_SHOP) && r.rows.length === 0);
    r = await logged({ action: "saveDiscountCode", code: { id: pat5.id, code: "PAT5", kind: "amount", amount: -1, email: "pat@example.com" } }, admin);
    ok("an edit with a bad value: db.js's sentence (400)", refused(r, 400, "The amount off must be from $0.01 to $10,000.") && r.rows.length === 0);
  }

  // Orders that used SAVE10 (claimed the way checkout claims a use): O-1 by Pat, O-2 by Lee.
  const cap = [{ productId: "cap", name: "Cap", type: "cap", size: "OSFA", qty: 1, unitPrice: 20 }];
  const placed = new Date().toISOString();
  await lib.insertOrder(d1, { orderId: "O-1", orgId: "acme", customerName: "Pat Example", contact: "pat@example.com", placedAt: placed }, cap);
  await lib.insertOrder(d1, { orderId: "O-2", orgId: "acme", customerName: "Lee Example", contact: "lee@example.com", placedAt: placed }, cap);
  await lib.insertOrder(d1, { orderId: "O-3", orgId: "acme", customerName: "Kim Example", contact: "kim@example.com", placedAt: placed }, cap);
  const c1 = await lib.claimDiscountCode(d1, { codeId: save10.id, orderId: "O-1", email: "pat@example.com", amountCents: 200, now: "2026-11-01T10:00:00.000Z" });
  const c2 = await lib.claimDiscountCode(d1, { codeId: save10.id, orderId: "O-2", email: "lee@example.com", amountCents: 200, now: "2026-11-02T10:00:00.000Z" });
  ok("two orders under test used SAVE10", c1.ok === true && c2.ok === true && q("SELECT count(*) n FROM discount_code_uses")[0].n === 2);

  console.log("\n=== saveDiscountCode: a code that has been used ===");
  {
    const keep = { id: save10.id, code: "SAVE10", kind: "percent", percent: 10, maxUses: 60, oncePerEmail: true, note: "Spring sale", expiresOn: "2099-12-31" };
    const locked = [
      [{ percent: 15 }, "its percent"], [{ kind: "amount", amount: 2, percent: undefined }, "its kind"], [{ code: "SAVE11" }, "its code"],
      [{ orgId: "acme" }, "its shop"], [{ email: "pat@example.com" }, "who can use it (an email)"], [{ oncePerEmail: false }, "once per email"],
    ];
    for (const [change, what] of locked) {
      const r = await logged({ action: "saveDiscountCode", code: { ...keep, ...change } }, admin);
      ok("once used, changing " + what + " is refused: 400 \"" + LOCKED + "\"", refused(r, 400, LOCKED) && r.rows.length === 0 && codeRow("SAVE10").percentBps === 1000);
    }
    let r = await logged({ action: "saveDiscountCode", code: { ...keep, maxUses: 1 } }, admin);
    ok("its uses in all below the 2 it has: 400 \"This code has been used 2 times, so it needs at least 2 uses in all.\"",
      refused(r, 400, "This code has been used 2 times, so it needs at least 2 uses in all.") && r.rows.length === 0 && codeRow("SAVE10").maxUses === 60);
    r = await logged({ action: "saveDiscountCode", code: { ...keep, maxUses: 2, expiresOn: "", note: "Spring sale — extended", active: false } }, admin);
    ok("…but its uses (down to 2), expiry, note and on/off still change, logged as what changed",
      r.status === 200 && r.body.code.maxUses === 2 && r.body.code.expiresOn === null && r.body.code.active === false && r.body.code.used === 2 && r.rows.length === 1 &&
      same(r.rows[0].detail.from, { maxUses: 60, expiresOn: "2099-12-31", active: true, note: "Spring sale" }) &&
      same(r.rows[0].detail.to, { maxUses: 2, expiresOn: null, active: false, note: "Spring sale — extended" }));
    await call({ action: "saveDiscountCode", code: { ...keep, active: true } }, admin);
  }

  console.log("\n=== listDiscountCodes ===");
  {
    d1._raw.exec(`INSERT INTO discount_codes (code, kind, amountCents, orgId, email, maxUses, oncePerEmail, expiresOn, active, note, createdAt, createdBy)
      VALUES ('OLDBAND', 'amount', 300, 'band', '', 5, 0, '2020-01-31', 1, 'Last season', '2020-01-01T00:00:00.000Z', 'test');`);
    let r = await call({ action: "listDiscountCodes" }, staff);
    ok("Back office lists every code: { status, codes, total }, newest first", r.status === 200 && keys(r.body) === "codes,status,total" && r.body.total === 4 &&
      same(r.body.codes.map(c => c.code), [made.code, "PAT5", "SAVE10", "OLDBAND"]) && r.body.codes.every(c => keys(c) === CODE_KEYS));
    const byCode = Object.fromEntries(r.body.codes.map(c => [c.code, c]));
    ok("…each with its status: on, switched off, expired (before the business's today), used up", byCode.SAVE10.status === "active" && byCode[made.code].status === "off" &&
      byCode.OLDBAND.status === "expired" && byCode.SAVE10.used === 2 && byCode.OLDBAND.orgName === "Example Band");
    const codes = async (body) => ((await call(Object.assign({ action: "listDiscountCodes" }, body), admin)).body.codes || []).map(c => c.code).sort().join();
    ok("status active / off / expired / all", await codes({ status: "active" }) === "PAT5,SAVE10" && await codes({ status: "off" }) === made.code &&
      await codes({ status: "expired" }) === "OLDBAND" && await codes({ status: "all" }) === [made.code, "OLDBAND", "PAT5", "SAVE10"].sort().join() && await codes({ status: "" }) === await codes({ status: "all" }));
    await call({ action: "saveDiscountCode", code: { id: save10.id, code: "SAVE10", kind: "percent", percent: 10, maxUses: 2, oncePerEmail: true, note: "Spring sale — extended" } }, admin);
    ok("status usedUp: SAVE10 with 2 of 2 used", await codes({ status: "usedUp" }) === "SAVE10" && await codes({ status: "active" }) === "PAT5");
    ok("a shop: its own codes and every-shop codes (Example Band: OLDBAND and the every-shop ones)", await codes({ org: "band" }) === [made.code, "OLDBAND", "PAT5", "SAVE10"].sort().join() &&
      (await call({ action: "saveDiscountCode", code: { id: pat5.id, code: "PAT5", kind: "amount", amount: 6, email: "pat@example.com", orgId: "acme" } }, admin)).status === 200 &&
      await codes({ org: "band" }) === [made.code, "OLDBAND", "SAVE10"].sort().join() && await codes({ org: "acme" }) === [made.code, "PAT5", "SAVE10"].sort().join());
    ok("a search matches the code, the email or the note, in any case", await codes({ q: "save" }) === "SAVE10" && await codes({ q: "PAT@EXAMPLE" }) === "PAT5" &&
      await codes({ q: "last season" }) === "OLDBAND" && await codes({ q: "  " }) === await codes({}) && await codes({ q: "%" }) === "");
    r = await call({ action: "listDiscountCodes", limit: 2, offset: 1 }, admin);
    const all = (await call({ action: "listDiscountCodes" }, admin)).body.codes.map(c => c.code);
    ok("paging: limit and offset, total still every match", r.status === 200 && r.body.total === 4 && same(r.body.codes.map(c => c.code), all.slice(1, 3)));
    r = await call({ action: "listDiscountCodes", limit: "lots", offset: -2 }, admin);
    ok("a limit or offset that isn't a whole number is read as the default", r.status === 200 && r.body.codes.length === 4);
    ok("a status it doesn't know: 400 \"That status isn't one a code has.\"", refused(await call({ action: "listDiscountCodes", status: "everything" }, admin), 400, "That status isn't one a code has."));
  }

  console.log("\n=== getDiscountCode ===");
  {
    for (const [id, what] of [["x", "text"], [0, "0"], [-1, "a negative number"], [1.5, "1.5"], [true, "true"], ["1e2", "\"1e2\""], [null, "nothing"]]) {
      ok("an id of " + what + ": 400 \"" + INVALID + "\"", refused(await call({ action: "getDiscountCode", id }, admin), 400, INVALID));
    }
    ok("a code that doesn't exist: 404 \"" + NOT_FOUND + "\"", refused(await call({ action: "getDiscountCode", id: 9999 }, admin), 404, NOT_FOUND));
    const r = await call({ action: "getDiscountCode", id: String(save10.id) }, staff);
    ok("Back office opens SAVE10: the code and its uses, newest first, with the order's customer and shop",
      r.status === 200 && keys(r.body) === "code,status" && r.body.code.code === "SAVE10" && r.body.code.usesTotal === 2 &&
      same(r.body.code.uses, [
        { orderId: "O-2", email: "lee@example.com", amount: 2, usedAt: "2026-11-02T10:00:00.000Z", releasedAt: null, customerName: "Lee Example", orgId: "acme" },
        { orderId: "O-1", email: "pat@example.com", amount: 2, usedAt: "2026-11-01T10:00:00.000Z", releasedAt: null, customerName: "Pat Example", orgId: "acme" }]));
  }

  console.log("\n=== createDiscountCodes: one code per email address ===");
  {
    const bulk = { kind: "percent", percent: 15 };
    const checks = [
      [{ ...bulk }, 400, NO_EMAILS, "no emails: 400 \"" + NO_EMAILS + "\""],
      [{ ...bulk, emails: 42 }, 400, NO_EMAILS, "emails as a number: the same"],
      [{ ...bulk, emails: [] }, 400, NO_EMAILS, "an empty list: the same"],
      [{ ...bulk, emails: " ,\n; " }, 400, NO_EMAILS, "text with no addresses: the same"],
      [{ ...bulk, emails: Array.from({ length: 501 }, (_, i) => "p" + i + "@example.com") }, 400, "That's more than 500 email addresses — make the codes in smaller batches.", "501 addresses: 400, in smaller batches"],
      [{ ...bulk, emails: ["pat@example.com"], org: 7 }, 400, BAD_SHOP, "a shop that isn't text: 400 \"" + BAD_SHOP + "\""],
      [{ ...bulk, emails: ["pat@example.com"], org: "no-such-shop" }, 404, UNKNOWN_SHOP, "a shop that doesn't exist: 404"],
      [{ ...bulk, emails: ["pat@example.com"], prefix: "MUCH-TOO-LONG" }, 400, "A prefix can be up to 12 letters, digits, - or _.", "a prefix of 13 characters"],
      [{ ...bulk, emails: ["pat@example.com"], prefix: "a b" }, 400, "A prefix can be up to 12 letters, digits, - or _.", "a prefix with a space"],
      [{ emails: ["pat@example.com"] }, 400, "Choose percent off or an amount off.", "no kind"],
      [{ emails: ["pat@example.com"], kind: "amount", amount: 0 }, 400, "The amount off must be from $0.01 to $10,000.", "an amount of $0"],
      [{ ...bulk, emails: ["pat@example.com"], expiresOn: "2026-13-01" }, 400, "The expiry date isn't a date.", "an expiry that isn't a date"],
      [{ ...bulk, emails: ["pat@example.com"], note: "n".repeat(201) }, 400, "The note can be at most 200 characters.", "a note over 200 characters"],
    ];
    const n = codeCount();
    for (const [body, status, message, says] of checks) {
      const r = await logged(Object.assign({ action: "createDiscountCodes" }, body), admin);
      ok(says, refused(r, status, message) && r.rows.length === 0 && codeCount() === n);
    }

    let r = await logged({ action: "createDiscountCodes", emails: "ana@example.com, Ben@Example.com\nnot-an-email; ana@example.com", prefix: "spring-",
      kind: "percent", percent: 15, org: "acme", expiresOn: "2099-06-30", note: "Thank you" }, editor);
    ok("the Codes editor pastes four lines: 200 { status, codes, skipped } — two codes, the repeat and the non-address skipped with why",
      r.status === 200 && keys(r.body) === "codes,skipped,status" && same(r.body.codes.map(c => c.email), ["ana@example.com", "ben@example.com"]) &&
      r.body.codes.every(c => /^SPRING-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(c.code)) && r.body.codes[0].code !== r.body.codes[1].code &&
      same(r.body.skipped, [{ email: "not-an-email", reason: "Not an email address." }, { email: "ana@example.com", reason: "Already in the list." }]));
    const ana = codeRow(r.body.codes[0].code);
    ok("…each a single-use code for its address, Example Club, 15%, the expiry and note, made by the editor",
      ana.email === "ana@example.com" && ana.maxUses === 1 && ana.oncePerEmail === 0 && ana.kind === "percent" && ana.percentBps === 1500 && ana.orgId === "acme" &&
      ana.expiresOn === "2099-06-30" && ana.note === "Thank you" && ana.active === 1 && ana.createdBy === "eddie@example.com");
    ok("…one audit row discount_code.bulk_created for the shop: how many and the settings — never the email addresses or the codes",
      r.rows.length === 1 && r.rows[0].action === "discount_code.bulk_created" && r.rows[0].orgId === "acme" &&
      same(r.rows[0].detail, { count: 2, skipped: 2, kind: "percent", percent: 15, amount: null, minOrder: null, freeShipping: false, orgId: "acme", expiresOn: "2099-06-30", prefix: "spring-" }) &&
      !/@|ana|ben|not-an-email/i.test(r.rows[0].detail && JSON.stringify(r.rows[0].detail)) && !r.body.codes.some(c => JSON.stringify(r.rows[0].detail).includes(c.code)));

    r = await logged({ action: "createDiscountCodes", emails: ["cy@example.com", null], kind: "amount", amount: "4", org: "" }, admin);
    ok("a list with an amount, every shop: the codes have no prefix; the audit row has the amount and no percent, no shop, no expiry",
      r.status === 200 && r.body.codes.length === 1 && /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(r.body.codes[0].code) && same(r.body.skipped, []) &&
      codeRow(r.body.codes[0].code).orgId === null && codeRow(r.body.codes[0].code).amountCents === 400 &&
      same(r.rows[0].detail, { count: 1, skipped: 0, kind: "amount", percent: null, amount: "4", minOrder: null, freeShipping: false, orgId: null, expiresOn: null, prefix: "" }) && r.rows[0].orgId === null);

    const n2 = codeCount();
    r = await logged({ action: "createDiscountCodes", emails: ["nobody", "still nobody"], kind: "percent", percent: 5 }, admin);
    ok("a list where every line is skipped: 200, no codes, and no audit row", r.status === 200 && same(r.body.codes, []) && r.body.skipped.length === 2 && r.rows.length === 0 && codeCount() === n2);

    r = await logged({ action: "createDiscountCodes", emails: Array.from({ length: 500 }, (_, i) => "guest" + i + "@example.com"), kind: "percent", percent: 5, prefix: "G" }, admin);
    ok("exactly 500 addresses: 500 codes, all different, one audit row with count 500", r.status === 200 && r.body.codes.length === 500 &&
      new Set(r.body.codes.map(c => c.code)).size === 500 && codeCount() === n2 + 500 && r.rows.length === 1 && r.rows[0].detail.count === 500);
    d1._raw.exec("DELETE FROM discount_codes WHERE email LIKE 'guest%'");
  }

  console.log("\n=== setDiscountCodeActive ===");
  {
    for (const [id, what] of [["x", "text"], [0, "0"], [2.5, "2.5"]]) {
      ok("an id of " + what + ": 400 \"" + INVALID + "\"", refused(await call({ action: "setDiscountCodeActive", id, active: false }, admin), 400, INVALID));
    }
    for (const [active, what] of [[undefined, "left out"], ["false", "\"false\" as text"], [0, "0"]]) {
      ok("on/off " + what + ": 400 \"Say whether the code is on or off.\"", refused(await call({ action: "setDiscountCodeActive", id: pat5.id, active }, admin), 400, "Say whether the code is on or off."));
    }
    ok("a code that doesn't exist: 404", refused(await call({ action: "setDiscountCodeActive", id: 9999, active: false }, admin), 404, NOT_FOUND));
    let r = await logged({ action: "setDiscountCodeActive", id: pat5.id, active: false }, editor);
    ok("the Codes editor switches PAT5 off: 200 { status, active: false }, one row discount_code.switched_off { id, code } for its shop",
      r.status === 200 && same(r.body, { status: "ok", active: false }) && codeRow("PAT5").active === 0 && r.rows.length === 1 &&
      r.rows[0].action === "discount_code.switched_off" && r.rows[0].orgId === "acme" && same(r.rows[0].detail, { id: pat5.id, code: "PAT5" }));
    r = await logged({ action: "setDiscountCodeActive", id: pat5.id, active: false }, editor);
    ok("switching it off again: 200, nothing logged", r.status === 200 && r.body.active === false && r.rows.length === 0);
    r = await logged({ action: "setDiscountCodeActive", id: String(pat5.id), active: true }, admin);
    ok("on again: discount_code.switched_on", r.status === 200 && same(r.body, { status: "ok", active: true }) && codeRow("PAT5").active === 1 &&
      r.rows.length === 1 && r.rows[0].action === "discount_code.switched_on" && same(r.rows[0].detail, { id: pat5.id, code: "PAT5" }));
    r = await logged({ action: "setDiscountCodeActive", id: save10.id, active: false }, admin);
    ok("an every-shop code's row has no shop", r.status === 200 && r.rows[0].orgId === null && r.rows[0].action === "discount_code.switched_off");
    await call({ action: "setDiscountCodeActive", id: save10.id, active: true }, admin);
    // Deleted by someone else between this request's read of the code and its switch: refused, nothing logged.
    const gone = await call({ action: "saveDiscountCode", code: { code: "GONESOON", kind: "percent", percent: 5, maxUses: 3 } }, admin);
    const realPrepare = d1.prepare;
    d1.prepare = function (sql) {
      if (/^SELECT code, active FROM discount_codes WHERE id = \?/.test(sql)) d1.q("DELETE FROM discount_codes WHERE code = 'GONESOON'");
      return realPrepare.apply(this, arguments);
    };
    try { r = await logged({ action: "setDiscountCodeActive", id: gone.body.code.id, active: false }, admin); } finally { d1.prepare = realPrepare; }
    ok("a code deleted while it is being switched off: 400 \"That discount code wasn't found.\", nothing logged",
      gone.status === 200 && refused(r, 400, "That discount code wasn't found.") && r.rows.length === 0 && !codeRow("GONESOON"));
  }

  console.log("\n=== deleteDiscountCode ===");
  {
    for (const [id, what] of [["x", "text"], [-4, "a negative number"], [undefined, "nothing"]]) {
      ok("an id of " + what + ": 400 \"" + INVALID + "\"", refused(await call({ action: "deleteDiscountCode", id }, admin), 400, INVALID));
    }
    ok("a code that doesn't exist: 404", refused(await call({ action: "deleteDiscountCode", id: 9999 }, admin), 404, NOT_FOUND));
    let r = await logged({ action: "deleteDiscountCode", id: save10.id }, admin);
    ok("a used code: 409 \"" + USED_NO_DELETE + "\", kept, nothing logged", refused(r, 409, USED_NO_DELETE) && codeRow("SAVE10") !== null && r.rows.length === 0);
    // A code whose only use was given back (its order voided) is still an order's record of it.
    const gone = (await call({ action: "saveDiscountCode", code: { code: "GIVENBACK", kind: "percent", percent: 5, maxUses: 5 } }, admin)).body.code;
    d1._raw.exec(`INSERT INTO discount_code_uses (codeId, orderId, email, amountCents, usedAt, releasedAt) VALUES (${gone.id}, 'O-9', 'pat@example.com', 100, '2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z')`);
    r = await logged({ action: "deleteDiscountCode", id: gone.id }, admin);
    ok("a code whose only use was given back: the same 409", refused(r, 409, USED_NO_DELETE) && codeRow("GIVENBACK") !== null && r.rows.length === 0);

    r = await logged({ action: "deleteDiscountCode", id: String(pat5.id) }, manager);
    ok("a Manager deletes the unused PAT5: 200 { status: \"ok\" }, the row gone",
      r.status === 200 && same(r.body, { status: "ok" }) && codeRow("PAT5") === null);
    ok("…one audit row discount_code.deleted for its shop, with what the code was",
      r.rows.length === 1 && r.rows[0].action === "discount_code.deleted" && r.rows[0].orgId === "acme" &&
      same(r.rows[0].detail, { id: pat5.id, code: "PAT5", kind: "amount", percent: null, amount: 6, maxDiscount: null, orgId: "acme", email: "pat@example.com", minOrder: null, freeShipping: false, maxUses: 1,
        oncePerEmail: false, expiresOn: null, active: true, note: "" }));
    ok("deleting it again: 404", refused(await call({ action: "deleteDiscountCode", id: pat5.id }, manager), 404, NOT_FOUND));

    // A checkout claims the code's first use between the handler's look and the DELETE: db.js's guarded DELETE refuses.
    const raced = (await call({ action: "saveDiscountCode", code: { code: "RACED", kind: "percent", percent: 5, maxUses: 5 } }, admin)).body.code;
    const prepare = d1.prepare;
    d1.prepare = function (sql) {
      if (/^DELETE FROM discount_codes WHERE id = \?/.test(String(sql))) d1._raw.exec(`INSERT INTO discount_code_uses (codeId, orderId, email, amountCents, usedAt) VALUES (${raced.id}, 'O-RACE', '', 50, '2026-11-03T00:00:00Z')`);
      return prepare.apply(this, arguments);
    };
    try { r = await logged({ action: "deleteDiscountCode", id: raced.id }, admin); } finally { d1.prepare = prepare; }
    ok("a use claimed just before the delete: 409 \"This code has been used on an order, so it can't be deleted. Switch it off instead.\", kept, nothing logged",
      refused(r, 409, "This code has been used on an order, so it can't be deleted. Switch it off instead.") && codeRow("RACED") !== null && r.rows.length === 0);
  }

  console.log("\n=== A closed month doesn't stop a code's changes ===");
  {
    const month = today.slice(0, 7);
    d1._raw.run("INSERT INTO closed_periods (month, closedAt, closedBy) VALUES (?, '2026-01-05T00:00:00Z', 'test')", [month]);
    const extra = (await call({ action: "saveDiscountCode", code: { code: "CLOSED1", kind: "percent", percent: 5, maxUses: 5 } }, admin));
    const bulk = await call({ action: "createDiscountCodes", emails: ["dee@example.com"], kind: "percent", percent: 5 }, admin);
    const off = await call({ action: "setDiscountCodeActive", id: extra.body.code && extra.body.code.id, active: false }, admin);
    const del = await call({ action: "deleteDiscountCode", id: extra.body.code && extra.body.code.id }, admin);
    ok("with this month (" + month + ") closed, making, bulk-making, switching off and deleting a code all answer 200",
      extra.status === 200 && bulk.status === 200 && off.status === 200 && del.status === 200 && codeRow("CLOSED1") === null);
    const v = await call({ action: "voidOrder", orderId: "O-3", reason: "Test" }, admin);
    ok("…while voiding an order placed this month is refused (409, closed): the guard is on and the codes are outside it",
      v.status === 409 && /is closed \(already filed\)/.test(v.body.message));
    d1._raw.run("DELETE FROM closed_periods");
  }

  console.log("\n=== Voiding or deleting an order gives its code's use back ===");
  {
    const before = (await call({ action: "getDiscountCode", id: save10.id }, admin)).body.code;
    let r = await logged({ action: "voidOrder", orderId: "O-1", reason: "Customer changed their mind" }, admin);
    const after = (await call({ action: "getDiscountCode", id: save10.id }, admin)).body.code;
    ok("voiding O-1 (it used SAVE10): 200, and SAVE10's use is given back — used 2 → 1, the use kept with when it was given back",
      r.status === 200 && before.used === 2 && after.used === 1 && after.usesTotal === 2 && after.status === "active" &&
      /^\d{4}-\d{2}-\d{2}T/.test(after.uses.find(u => u.orderId === "O-1").releasedAt) && after.uses.find(u => u.orderId === "O-2").releasedAt === null);
    const voided = r.rows.find(x => x.action === "order.voided");
    ok("…the void's audit row notes discountCode \"SAVE10\"", !!voided && voided.orderId === "O-1" && voided.detail.discountCode === "SAVE10" && voided.detail.reason === "Customer changed their mind");
    r = await logged({ action: "voidOrder", orderId: "O-3" }, admin);
    const plain = r.rows.find(x => x.action === "order.voided");
    ok("voiding an order that used no code: its audit row has no discountCode", r.status === 200 && !!plain && !("discountCode" in plain.detail));
    r = await logged({ action: "deleteOrder", orderId: "O-2" }, admin);
    const after2 = (await call({ action: "getDiscountCode", id: save10.id }, admin)).body.code;
    ok("deleteOrder (the admin's name for a void) on O-2: its use given back too and noted on the row",
      r.status === 200 && after2.used === 0 && r.rows.some(x => x.action === "order.voided" && x.detail.discountCode === "SAVE10"));
    const again = await lib.claimDiscountCode(d1, { codeId: save10.id, orderId: "O-4", email: "pat@example.com", amountCents: 200 });
    ok("…so Pat, once per email, can use SAVE10 again", again.ok === true);
  }

  console.log("\n=== The Discount codes switch (FEATURE_ACTIONS) ===");
  {
    globalThis.__t332Features = { discounts: false };
    const before = [codeCount(), auditCount(), JSON.stringify(codeRow("SAVE10"))];
    const bodies = { listDiscountCodes: {}, getDiscountCode: { id: save10.id }, saveDiscountCode: { code: { code: "NEWONE", kind: "percent", percent: 5, maxUses: 5 } },
      createDiscountCodes: { emails: ["eve@example.com"], kind: "percent", percent: 5 }, setDiscountCodeActive: { id: save10.id, active: false }, deleteDiscountCode: { id: codeRow("GIVENBACK").id } };
    const got = [];
    for (const a of SIX) got.push(await call(Object.assign({ action: a }, bodies[a]), admin));
    ok("with Discount codes off, each of the six is refused for an Admin: 403 { feature: \"discounts\", \"" + OFF + "\" }",
      got.every(r => r.status === 403 && r.body.status === "error" && r.body.feature === "discounts" && r.body.message === OFF));
    const role = await call({ action: "deleteDiscountCode", id: save10.id }, prod);
    ok("…a role that may not is told about its role first", forbidden(role) && role.body.message === ROLE);
    const out = [];
    for (const a of SIX) out.push(await call(Object.assign({ action: a }, bodies[a]), ""));
    ok("…signed out, the sign-in is still asked for first (401)", out.every(r => refused(r, 401, "Unauthorized")));
    ok("…nothing was made, changed or logged", same(before, [codeCount(), auditCount(), JSON.stringify(codeRow("SAVE10"))]));
    globalThis.__t332Features = { discounts: true, quotes: false, storefront: false };
    ok("another feature off (Quotes, the storefront) doesn't touch the codes page", (await call({ action: "listDiscountCodes" }, admin)).status === 200);
    delete globalThis.__t332Features;
  }

  // ---- A database built from the migrations up to 0114, signed in with testlib/roles.js adminAs() ----
  console.log("\n=== A database that hasn't had migrations/0115 yet ===");
  {
    const glue = new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
      "const requireAdmin = async () => null; const adminActor = () => 'owner@example.test';\n" + roles.adminAs("admin") + "\n" + strip(read("functions/_lib/permissions.js")) + "\n" +
      "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
      "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
      "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
      "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false, sendEstimateEmail = async () => false;\n" +
      strip(read("functions/_lib/db.js")) + "\n" + strip(ordersJs) + "\nreturn onRequestPost;")();
    const db = await createD1();
    db._raw.exec(read("testlib/schema-pre-0006.sql"));
    for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006" && f.slice(0, 4) <= "0114").sort()) db.execFile(read("migrations/" + f));
    db._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Example Club','t','t');`);
    const old = async (body, DB = db) => { const waits = [];
      const res = await glue({ env: { DB }, waitUntil: (p) => waits.push(p && p.then ? p.then(() => {}, () => {}) : null),
        request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
      await Promise.all(waits); return { status: res.status, body: JSON.parse(await res.text()) }; };
    ok("the database under test has no discount_codes or discount_code_uses table",
      db.q("SELECT count(*) n FROM sqlite_master WHERE name IN ('discount_codes', 'discount_code_uses')")[0].n === 0);
    const log = db.q("SELECT count(*) n FROM audit_log")[0].n;
    let r = await old({ action: "listDiscountCodes" });
    ok("listDiscountCodes answers an empty list", r.status === 200 && same(r.body, { status: "ok", codes: [], total: 0 }));
    ok("getDiscountCode, setDiscountCodeActive and deleteDiscountCode answer 404: there is no such code",
      refused(await old({ action: "getDiscountCode", id: 1 }), 404, NOT_FOUND) && refused(await old({ action: "setDiscountCodeActive", id: 1, active: false }), 404, NOT_FOUND) &&
      refused(await old({ action: "deleteDiscountCode", id: 1 }), 404, NOT_FOUND));
    ok("…and so does a change to a code (saveDiscountCode with an id)", refused(await old({ action: "saveDiscountCode", code: { id: 1, ...base } }), 404, NOT_FOUND));
    r = await old({ action: "saveDiscountCode", code: { code: "SAVE10", ...base } });
    ok("making a code is refused with 503 \"" + NOT_READY_DB + "\"", refused(r, 503, NOT_READY_DB));
    r = await old({ action: "createDiscountCodes", emails: ["pat@example.com"], kind: "percent", percent: 10 });
    ok("making codes for a list: the same 503", refused(r, 503, NOT_READY_DB));
    ok("what is wrong with the request itself is still said first (400)", refused(await old({ action: "saveDiscountCode", code: { code: "SAVE10", kind: "half" } }), 400, "Choose percent off or an amount off.") &&
      refused(await old({ action: "createDiscountCodes", emails: [] }), 400, NO_EMAILS));
    ok("none of them wrote an audit row", db.q("SELECT count(*) n FROM audit_log")[0].n === log);
    // A database that is down (every query fails for a reason that has nothing to do with 0115): not "not ready".
    const DOWN = "D1_ERROR: Network connection lost.";
    const downDb = { ...db, prepare() { const fail = async () => { throw new Error(DOWN); }; const st = { first: fail, all: fail, run: fail }; return Object.assign({ bind: () => st }, st); } };
    let downErr = "";
    try { await old({ action: "listDiscountCodes" }, downDb); } catch (e) { downErr = String(e && e.message); }
    ok("listDiscountCodes on a database that is down passes the failure on (a server error), not an empty list or a 503", downErr === DOWN);
  }
})().catch((e) => { console.error(e); process.exit(1); });
