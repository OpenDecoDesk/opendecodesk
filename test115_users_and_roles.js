const fs = require("fs");
const { makeAuth, totpNow, read } = require("./testlib/auth-harness");

// Users and roles. Roles are rows (migrations/0089): Admin (locked, everything), Manager, Back office
// ("staff") and Production, plus any added on Users → Roles and permissions. Each role says, per function
// of the back office, none / read / edit / full (functions/_lib/permissions.js); the server decides in ONE
// place (requireAdmin's `need`), and what it wasn't told about is admin-only. Rank decides who may change
// whom. A user is disabled, never deleted; there is always an active admin; "require two-step sign-in"
// sends anyone without an authenticator to enrolment first. Real SQL under the real endpoints.
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const names = (text) => [...text.matchAll(/"(\w+)"/g)].map(m => m[1]);
const forbidden = (r) => r.status === 403 && r.body && r.body.code === "forbidden";
const pendingRefusal = (r) => r.status === 403 && r.body && r.body.code === "setup_required";
const SECRET = "JBSWY3DPEHPK3PXP", SECRET2 = "KRSXG5CTMVRXEZLU", SECRET3 = "MFRGGZDFMZTWQ2LK";
const P = new Function(read("functions/_lib/permissions.js").replace(/export (async function|function|const)/g, "$1") +
  "\nreturn { ACTION_PERM, DEFAULT_ROLES, roleAllows, PERM_FUNCTIONS, PERMISSION_AREAS, effectivePermissions };")();

(async () => {
  const A = await makeAuth();
  const admin = await A.firstAdmin();
  const manager = await A.addUser(admin, "manager", "Mo Manager", "mo@myshop.com");
  const staff = await A.addUser(admin, "staff", "Sam Staff", "sam@myshop.com");
  const prod = await A.addUser(admin, "production", "Pat Production", "pat@myshop.com");
  const ordersJs = read("functions/api/orders.js");

  console.log("=== Every back-office action, as each built-in role ===");
  const dispatched = new Set(names(ordersJs.match(/const CATALOG_ADMIN_ACTIONS = new Set\(\[([\s\S]*?)\]\);/)[1]));
  for (const m of ordersJs.matchAll(/body\.action === "(\w+)"/g)) dispatched.add(m[1]);
  for (const m of ordersJs.matchAll(/\[([^\[\]]*)\]\.includes\(body\.action\)/g)) names(m[1]).forEach(a => dispatched.add(a));
  for (const m of ordersJs.matchAll(/const (?:RECON|MONEY|EXPENSE)_ACTIONS = \[([\s\S]*?)\];/g)) names(m[1]).forEach(a => dispatched.add(a));
  const ACTIONS = [...dispatched];
  let wrong = [];
  for (const action of ACTIONS) {
    const spec = P.ACTION_PERM[action];
    const got = [forbidden(await A.orders({ action }, admin)), forbidden(await A.orders({ action }, manager)), forbidden(await A.orders({ action }, staff)), forbidden(await A.orders({ action }, prod))];
    const want = [false, ...["manager", "staff", "production"].map(r => !P.roleAllows(P.DEFAULT_ROLES[r], spec))];
    if (got.join() !== want.join()) wrong.push(action + ": admin/manager/staff/production refused = " + got.join("/") + " (want " + want.join("/") + ")");
  }
  if (wrong.length) console.log("   " + wrong.join("\n   "));
  ok(`all ${ACTIONS.length} actions: each role is refused exactly what its permissions leave out, and an admin nothing`, wrong.length === 0 && ACTIONS.length > 300);
  const may = (role, a) => P.roleAllows(P.DEFAULT_ROLES[role], P.ACTION_PERM[a]);
  ok("only an admin changes Global settings or reads the audit log; a manager reads Global settings, runs the shops and the books",
    ["updateGlobalSettings", "updateFeatures", "updateBusinessProfile", "getAuditLog", "saveShopRate", "placeSupplierOrder"].every(a => !may("manager", a)) &&
    ["getGlobalSettings", "getSetupStatus", "createOrg", "publish", "listMoney", "reconcileMonth", "closePeriod", "getAccountantExport", "createTestTransaction", "recordRefund", "deleteOrder"].every(a => may("manager", a)));
  ok("Back office keeps the day's work but no longer deletes, voids or refunds", ["getOrdersAllShops", "addPayment", "markPaidManual", "getOrderForShipping", "startRun", "receiveBlanks", "createProduct", "saveGraphic", "saveMachine", "saveDesign", "getDashboard"].every(a => may("staff", a)) &&
    ["recordRefund", "voidOrder", "deletePayment", "voidPayment", "deleteOrder", "deleteDesign", "writeOffBlanks", "getRevenueReport", "listExpenses", "createOrg", "getGlobalSettings"].every(a => !may("staff", a)));
  ok("Production makes things and moves them made → shipped, and reads the rest of its screens", ["markManufacturedOnMachine", "startRun", "completeRun", "abortRun", "makeTransferLine", "setTransfersApplied",
    "recordTracking", "getOrderForShipping", "setOrderCompleted", "recordMaintenance", "getOrdersAllShops", "getProductionQueue", "getTransferQueue", "listMachines", "listThreads", "listDesigns", "getDashboard"].every(a => may("production", a)) &&
    ["addPayment", "markPaidManual", "recordRefund", "deleteOrder", "editOrder", "useBlanksFromStock", "createProduct", "saveDesign", "saveMachine", "deleteMachine", "receiveBlanks", "listExpenses", "getGlobalSettings", "analyzePricing", "sendInvoice"].every(a => !may("production", a)));
  let r = await A.orders({ action: "setFulfillmentStage", org: "x", orderId: "o-1", stage: "blankOrdered" }, prod);
  const r2 = await A.orders({ action: "setFulfillmentStage", org: "x", orderId: "o-1", stage: "qaPacked" }, prod);
  const r3 = await A.orders({ action: "bulkSetFulfillmentStage", orderIds: ["o-1"], stage: "blankReceived" }, prod);
  ok("…a step change is checked by its step: Production may set QA packed, not order or receive blanks", forbidden(r) && !forbidden(r2) && forbidden(r3) &&
    !forbidden(await A.orders({ action: "setFulfillmentStage", org: "x", orderId: "o-1", stage: "blankOrdered" }, staff)));
  r = await A.orders({ action: "getDashboard" }, prod);
  ok("Production's Home has the order counts, not the money", !forbidden(r) && (r.status !== 200 || !("money" in r.body)));
  ok("an action nobody has heard of is nobody's — including names every object answers to", !(await A.orders({ action: "constructor" }, staff)).body.orders && (await A.orders({ action: "constructor" }, staff)).status === 403 && (await A.orders({ action: "__proto__" }, admin)).status >= 400 && (await A.orders({ action: "toString" }, manager)).status === 403);
  ok("being refused for your role is not a failed sign-in: nothing was counted against the failure budget", A.hits.length === 0);
  ok("…while a made-up session is", (await A.orders({ action: "getOrdersAllShops" }, "sess_" + "0".repeat(48))).status === 401 && A.hits.length === 1);
  ok("no role gets anywhere from a shop's address: the back office answers on the admin host only", (await A.lib.requireAdmin(A.env, { kind: "locked", orgId: "x" }, "", { url: "https://x.example.com/api/orders", headers: { get: () => null } }, "no", "staff")).status === 403);

  console.log("\n=== Default-deny: nothing is open by omission ===");
  const undecided = ACTIONS.filter(a => !P.ACTION_PERM[a]), ghosts = Object.keys(P.ACTION_PERM).filter(a => !dispatched.has(a));
  if (undecided.length || ghosts.length) console.log("   no permission:", undecided.join(", "), " not real:", ghosts.join(", "));
  ok("every action the orders endpoint answers needs a function at a level, and every action in the map is a real one", undecided.length === 0 && ghosts.length === 0);
  ok("every function the map names is on the Roles screen's list", Object.values(P.ACTION_PERM).filter(Array.isArray).flat().every(([fn]) => P.PERM_FUNCTIONS.includes(fn)));
  const gateCalls = [...ordersJs.matchAll(/requireAdmin\(([^\n]*)\)/g)].map(m => m[1]).filter(a => a.trim());
  ok("every gate call in the orders endpoint passes that action's permission", /const ACTION_PERM_ = typeof ACTION_PERM !== "undefined" \? ACTION_PERM : Object\.create\(null\);/.test(ordersJs) && gateCalls.length > 50 && gateCalls.every(a => /, ACTION_PERM_\[body\.action\]$/.test(a)));
  // Every API file is either open to the public on purpose, or names what it needs.
  const PUBLIC = ["admin-session", "catalog", "checkout", "customer-design", "daily-digest", "download", "image-proxy", "invoice", "shipping", "stripe-webhook", "upload-verify", "verify"];
  const NEEDS = { "orders": /ACTION_PERM_\[body\.action\]/, "admin-users": /\n\s*need, self \? \{ pending/, "admin-2fa": /"staff", \{ pending: \["2fa"\] \}/, "admin-password": /"staff", \{ pending: \["account", "password"\] \}/,
    "agent": /\[\["production\./, "design": /\[\["catalog\./, "receipt": /\[\["finance\.expenses", "edit"\]/, "shippo-label": /\[\["orders\.shipping", "edit"\]\]$/, "upload": /\[\["catalog\.products", "edit"\]/ };
  const files = fs.readdirSync(__dirname + "/functions/api").filter(f => f.endsWith(".js")).map(f => f.replace(/\.js$/, ""));
  const loose = files.filter(f => { const src = read("functions/api/" + f + ".js"), calls = [...src.matchAll(/await requireAdmin\(([\s\S]*?)\);/g)].map(m => m[1]);
    return PUBLIC.includes(f) ? calls.length > 0 : !(NEEDS[f] && calls.length > 0 && calls.every(a => NEEDS[f].test(a))); });
  if (loose.length) console.log("   not accounted for:", loose.join(", "));
  ok("every API file is on the public list or names what it needs at each gate call — a new file is neither until someone decides", loose.length === 0 && files.length === PUBLIC.length + Object.keys(NEEDS).length);
  const gate = async (need) => A.lib.requireAdmin(A.env, { kind: "admin" }, "", { url: "https://admin.example.com/api/x", headers: { get: (h) => ({ origin: "https://admin.example.com", cookie: "__Host-odd_admin=" + staff })[h.toLowerCase()] || null } }, "no", need);
  ok("the gate itself: something it doesn't understand — none, a typo, another case, something every object has, a function name alone — means admin only", (await gate("staff")) === null && (await gate("*")) === null && (await gate([["orders.details", "read"]])) === null &&
    (await Promise.all([undefined, null, "", "STAFF", "staf", "constructor", "toString", 1, {}, ["staff"], "orders.details", [["orders.details", "full"]], [["constructor", "read"]], [], "manager", "admin"].map(gate))).every(r => r !== null && r.status === 403));

  console.log("\n=== Managing users needs Users and roles on your role (only Admin has it at first) ===");
  const USER_ACTIONS = [{ action: "list" }, { action: "listRoles" }, { action: "saveRole", name: "X", rank: 10, permissions: {} }, { action: "deleteRole", key: "production" },
    { action: "create", name: "X", email: "x@myshop.com", role: "admin" }, { action: "update", id: 3, name: "Sam", email: "sam@myshop.com" }, { action: "setRole", id: 3, role: "admin" },
    { action: "setStatus", id: 1, status: "disabled" }, { action: "resetPassword", id: 1 }, { action: "reset2fa", id: 1 }, { action: "setRequire2fa", on: false }];
  let leaks = [];
  for (const body of USER_ACTIONS) for (const [who, c] of [["staff", staff], ["manager", manager], ["production", prod]]) if (!forbidden(await A.users(body, c))) leaks.push(who + ":" + body.action);
  if (leaks.length) console.log("   " + leaks.join(", "));
  ok("manager, back office and production are refused every user and role action, and nothing changed", leaks.length === 0 && A.d1.q("SELECT count(*) n FROM users")[0].n === 4 && A.user("sam@myshop.com").role === "staff" && A.user("olive@myshop.com").status === "active");
  ok("…so a manager cannot make themselves, or anyone, an admin", forbidden(await A.users({ action: "setRole", id: A.user("mo@myshop.com").id, role: "admin" }, manager)) && A.user("mo@myshop.com").role === "manager");
  r = await A.users({ action: "me" }, prod);
  ok("everyone can ask who they are, and gets what their role may do and the list it's about", (await A.users({ action: "me" }, staff)).body.user.role === "staff" && (await A.users({ action: "me" }, manager)).body.user.role === "manager" &&
    r.body.user.role === "production" && r.body.user.roleName === "Production" && r.body.permissions["run.markMade"] === "edit" && r.body.permissions["orders.payments"] === "none" && r.body.permissions["orders.details"] === "read" && Array.isArray(r.body.areas) && r.body.areas.length === P.PERMISSION_AREAS.length);
  r = await A.users({ action: "me" }, admin);
  ok("…an admin has everything at full", P.PERM_FUNCTIONS.every(k => r.body.permissions[k] === "full"));

  console.log("\n=== Roles: rank decides who changes whom ===");
  r = await A.users({ action: "listRoles" }, admin);
  ok("the four built-in roles, highest first, with how many people have each", r.status === 200 && r.body.roles.map(x => x.key).join() === "admin,manager,staff,production" && r.body.roles.map(x => x.userCount).join() === "1,1,1,1" &&
    r.body.roles[0].locked && !r.body.roles[0].canEdit && r.body.roles.slice(1).every(x => x.canEdit) && r.body.myRank === 100);
  ok("Admin can't be changed by anyone — not even an admin", (r = await A.users({ action: "saveRole", key: "admin", name: "Admin", rank: 99, permissions: {} }, admin)).status === 403 && /can't be changed/.test(r.body.message) &&
    A.d1.q("SELECT permissions FROM roles WHERE key = 'admin'")[0].permissions === null);
  const mgrRole = (await A.users({ action: "listRoles" }, admin)).body.roles.find(x => x.key === "manager");
  mgrRole.permissions.fns["settings.users"] = "edit";
  r = await A.users({ action: "saveRole", key: "manager", name: "Manager", rank: 75, permissions: mgrRole.permissions }, admin);
  ok("an admin gives Manager the Users page: it takes effect at once, without signing anyone out", r.status === 200 && (await A.users({ action: "list" }, manager)).status === 200 && A.audit("security.role_changed").length === 1);
  const sam = A.user("sam@myshop.com").id, mo = A.user("mo@myshop.com").id, olive = A.user("olive@myshop.com").id, pat = A.user("pat@myshop.com").id;
  ok("a manager can move Back office and Production people between those roles", (await A.users({ action: "setRole", id: pat, role: "staff" }, manager)).status === 200 && A.user("pat@myshop.com").role === "staff" &&
    (await A.users({ action: "setRole", id: pat, role: "production" }, manager)).status === 200);
  ok("…but can't make anyone a manager or an admin", (await A.users({ action: "setRole", id: pat, role: "manager" }, manager)).status === 403 && (await A.users({ action: "setRole", id: pat, role: "admin" }, manager)).status === 403 &&
    (await A.users({ action: "create", name: "Max", email: "max@myshop.com", role: "manager" }, manager)).status === 403 && A.user("pat@myshop.com").role === "production" && !A.user("max@myshop.com"));
  await A.users({ action: "create", name: "Meg Manager", email: "meg@myshop.com", role: "manager" }, admin);
  const meg = A.user("meg@myshop.com").id;
  ok("…and can't demote, disable or reset another manager or an admin — only someone ranked above them can", ["setRole", "setStatus", "resetPassword", "reset2fa", "update"].every(() => true) &&
    (await A.users({ action: "setRole", id: meg, role: "staff" }, manager)).status === 403 && (await A.users({ action: "setStatus", id: meg, status: "disabled" }, manager)).status === 403 &&
    (await A.users({ action: "resetPassword", id: olive }, manager)).status === 403 && (await A.users({ action: "setRole", id: olive, role: "staff" }, manager)).status === 403 &&
    (await A.users({ action: "update", id: olive, name: "Olive", email: "olive@myshop.com" }, manager)).status === 403 && A.user("meg@myshop.com").role === "manager" && A.user("olive@myshop.com").role === "admin");
  ok("nobody changes their own role, not even to lower it", (r = await A.users({ action: "setRole", id: mo, role: "staff" }, manager)).status === 409 && /your own/.test(r.body.message) && A.user("mo@myshop.com").role === "manager");
  ok("a manager can't change the Manager role itself, nor Admin", (await A.users({ action: "saveRole", key: "manager", name: "Manager", rank: 74, permissions: mgrRole.permissions }, manager)).status === 403 &&
    (await A.users({ action: "saveRole", key: "admin", name: "Admin", rank: 1, permissions: {} }, manager)).status === 403);
  const prodRole = (await A.users({ action: "listRoles" }, manager)).body.roles.find(x => x.key === "production");
  ok("…the roles list says which a manager may change", (await A.users({ action: "listRoles" }, manager)).body.roles.map(x => x.key + ":" + x.canEdit).join() === "admin:false,manager:false,staff:true,production:true");
  const tooMuch = JSON.parse(JSON.stringify(prodRole.permissions)); tooMuch.fns["settings.global"] = "edit";
  ok("…and can't give a role more than their own role has", (r = await A.users({ action: "saveRole", key: "production", name: "Production", rank: 25, permissions: tooMuch }, manager)).status === 403 && /more than your own/.test(r.body.message));
  ok("…nor rank a role at or above their own", (await A.users({ action: "saveRole", name: "Lead", rank: 75, permissions: prodRole.permissions }, manager)).status === 403);

  console.log("\n=== Adding a role ===");
  const lead = JSON.parse(JSON.stringify(prodRole.permissions));
  lead.fns["orders.payments"] = "read"; lead.items.runtransfer = false; lead.menus.production = false;
  r = await A.users({ action: "saveRole", name: "Shift lead", rank: 40, permissions: lead }, manager);
  const leadKey = r.body.role && r.body.role.key;
  ok("a manager adds a role below their own; it is stored clean and audited", r.status === 200 && /^r_[0-9a-f]{12}$/.test(leadKey) && r.body.role.permissions.fns["orders.payments"] === "read" && r.body.role.permissions.items.runtransfer === false &&
    A.audit("security.role_created").length === 1 && (await A.users({ action: "saveRole", name: "shift LEAD", rank: 30, permissions: lead }, manager)).status === 409);
  ok("…and can give it to someone", (await A.users({ action: "setRole", id: pat, role: leadKey }, manager)).status === 200 && A.user("pat@myshop.com").role === leadKey);
  const lc = (await A.signIn("pat@myshop.com", "a password of their own")).cookie;
  r = await A.users({ action: "me" }, lc);
  ok("its users get exactly that: what's switched off is none, whatever its levels said", r.body.user.roleName === "Shift lead" && r.body.permissions["orders.payments"] === "read" && r.body.permissions["transfer.mark"] === "none" && r.body.permissions["production.maintenanceLog"] === "none" && r.body.permissions["run.markMade"] === "edit");
  ok("…and the server holds them to it", !forbidden(await A.orders({ action: "listAccounts" }, lc)) && forbidden(await A.orders({ action: "addPayment" }, lc)) && forbidden(await A.orders({ action: "makeTransferLine" }, lc)) &&
    forbidden(await A.orders({ action: "recordMaintenance" }, lc)) && !forbidden(await A.orders({ action: "startRun" }, lc)));
  ok("a role someone has can't be deleted, nor a built-in one", (await A.users({ action: "deleteRole", key: leadKey }, admin)).status === 409 && (await A.users({ action: "deleteRole", key: "production" }, admin)).status === 409 && A.d1.q("SELECT count(*) n FROM roles")[0].n === 5);
  ok("a role is deleted only with full Users and roles (a manager has edit)", forbidden(await A.users({ action: "deleteRole", key: leadKey }, manager)));
  await A.users({ action: "setRole", id: pat, role: "production" }, manager);
  ok("once nobody has it, an admin can delete it", (await A.users({ action: "deleteRole", key: leadKey }, admin)).status === 200 && A.d1.q("SELECT count(*) n FROM roles")[0].n === 4 && A.audit("security.role_deleted").length === 1);
  ok("a role that no longer exists (or never did) can't be given", (await A.users({ action: "setRole", id: pat, role: leadKey }, admin)).status === 400 && (await A.users({ action: "setRole", id: pat, role: "constructor" }, admin)).status === 400);
  await A.users({ action: "setStatus", id: meg, status: "disabled" }, admin);
  r = await A.users({ action: "list" }, admin);
  ok("an admin sees everyone: name, email, role, status, two-step, last sign-in", r.status === 200 && r.body.users.length === 5 && r.body.users.filter(u => u.id !== meg).every(u => u.name && u.email && u.role && u.status === "active" && u.has2fa === false && !!u.lastLoginAt && u.passwordUsable === true) &&
    !JSON.stringify(r.body).includes("hash") && !JSON.stringify(r.body).includes("salt") && true);
  ok("a new user needs a name, a real email and a role that exists", (await A.users({ action: "create", name: "", email: "a@b.co", role: "staff" }, admin)).status === 400 && (await A.users({ action: "create", name: "A", email: "nope", role: "staff" }, admin)).status === 400 &&
    (await A.users({ action: "create", name: "A", email: "a@b.co", role: "owner" }, admin)).status === 400 && (await A.users({ action: "create", name: "A", email: "a@b.co", role: "constructor" }, admin)).status === 400);
  r = await A.users({ action: "update", id: sam, name: "Samantha Staff", email: "samantha@myshop.com" }, admin);
  ok("a name or an email can be corrected, and a taken email can't be given to someone else", r.status === 200 && A.user("samantha@myshop.com").name === "Samantha Staff" && (await A.users({ action: "update", id: sam, name: "S", email: "mo@myshop.com" }, admin)).status === 409 &&
    (await A.orders({ action: "getOrdersAllShops" }, staff)).status === 200);
  r = await A.users({ action: "setRole", id: sam, role: "manager" }, admin);
  ok("changing a role takes effect at once: the user is signed out and signs in again as what they now are", r.status === 200 && r.body.user.role === "manager" && (await A.orders({ action: "getOrdersAllShops" }, staff)).status === 401 &&
    (await A.signIn("samantha@myshop.com", "a password of their own")).body.user.role === "manager");
  await A.users({ action: "setRole", id: sam, role: "staff" }, admin);
  let samCookie = (await A.signIn("samantha@myshop.com", "a password of their own")).cookie;

  console.log("\n=== Disabling a user ===");
  r = await A.users({ action: "setStatus", id: sam, status: "disabled" }, admin);
  ok("their session stops working that instant", r.status === 200 && r.body.user.status === "disabled" && (await A.orders({ action: "getOrdersAllShops" }, samCookie)).status === 401 && (await A.users({ action: "me" }, samCookie)).status === 401);
  ok("they can't sign in, and are told nothing a stranger wouldn't be", (r = await A.signIn("samantha@myshop.com", "a password of their own")).status === 401 && r.body.message === (await A.signIn("nobody@myshop.com", "x")).body.message);
  ok("the row is kept, so history keeps its name", A.d1.q("SELECT count(*) n FROM users")[0].n === 5 && A.user("samantha@myshop.com").status === "disabled" && !fs.readFileSync(__dirname + "/functions/api/admin-users.js", "utf8").includes("DELETE FROM users"));
  // Even a session row that somehow survived is refused: the gate checks the user, not just the session.
  A.d1._raw.exec(`UPDATE users SET status = 'active' WHERE id = ${sam}`); samCookie = (await A.signIn("samantha@myshop.com", "a password of their own")).cookie; A.d1._raw.exec(`UPDATE users SET status = 'disabled' WHERE id = ${sam}`);
  ok("…and a session that outlived the disabling is refused anyway", A.sessions() >= 1 && (await A.orders({ action: "getOrdersAllShops" }, samCookie)).status === 401);
  r = await A.users({ action: "setStatus", id: sam, status: "active" }, admin);
  ok("enabling them again lets them back in with the password they had", r.status === 200 && (samCookie = (await A.signIn("samantha@myshop.com", "a password of their own")).cookie) && (await A.orders({ action: "getOrdersAllShops" }, samCookie)).status === 200);

  console.log("\n=== There is always an active admin ===");
  ok("an admin can't demote or disable themselves", (r = await A.users({ action: "setRole", id: olive, role: "staff" }, admin)).status === 409 && /your own/.test(r.body.message) && (await A.users({ action: "setStatus", id: olive, status: "disabled" }, admin)).status === 409 && A.user("olive@myshop.com").role === "admin");
  ok("…nor reset their own password or two-step from the user list (those ask for proof elsewhere)", (await A.users({ action: "resetPassword", id: olive }, admin)).status === 409 && (await A.users({ action: "reset2fa", id: olive }, admin)).status === 409);
  await A.users({ action: "setRole", id: mo, role: "admin" }, admin);
  const admin2 = (await A.signIn("mo@myshop.com", "a password of their own")).cookie;
  r = await A.users({ action: "setRole", id: olive, role: "manager" }, admin2);
  ok("with a second admin, the first can be demoted — and is signed out", r.status === 200 && A.user("olive@myshop.com").role === "manager" && (await A.users({ action: "list" }, admin)).status === 401);
  // Now Mo is the only admin. Whatever got past the checks above, the statement itself refuses.
  ok("the last active admin can't be demoted or disabled: the database statement changes nothing", (await A.lib.setUserRoleAndStatus(A.d1, mo, { role: "staff" })) === false && (await A.lib.setUserRoleAndStatus(A.d1, mo, { status: "disabled" })) === false &&
    A.user("mo@myshop.com").role === "admin" && A.user("mo@myshop.com").status === "active");
  await A.users({ action: "setRole", id: olive, role: "admin" }, admin2);
  // Two admins each demote the other in the same instant: both passed their checks, one statement wins.
  const both = [await A.lib.setUserRoleAndStatus(A.d1, mo, { role: "staff" }), await A.lib.setUserRoleAndStatus(A.d1, olive, { role: "staff" })];
  ok("two admins demoting each other at the same moment can't both succeed", both.join() === "true,false" && A.d1.q("SELECT count(*) n FROM users WHERE role = 'admin' AND status = 'active'")[0].n === 1);
  ok("a disabled admin doesn't count as the one that must remain", (A.d1._raw.exec(`UPDATE users SET role = 'admin', status = 'disabled' WHERE id = ${mo}`), await A.lib.setUserRoleAndStatus(A.d1, olive, { status: "disabled" })) === false);
  A.d1._raw.exec(`UPDATE users SET role = 'manager', status = 'active' WHERE id = ${mo}`);
  const boss = (await A.signIn("olive@myshop.com", "correct horse battery")).cookie;

  console.log("\n=== Resetting someone's password or two-step ===");
  r = await A.users({ action: "resetPassword", id: sam }, boss);
  const TEMP = r.body.temporaryPassword;
  ok("a reset gives a temporary password once, signs them out, and makes them choose a new one", r.status === 200 && /^([a-z2-9]{4}-){3}[a-z2-9]{4}$/.test(TEMP) && (await A.orders({ action: "getOrdersAllShops" }, samCookie)).status === 401 &&
    (await A.signIn("samantha@myshop.com", "a password of their own")).status === 401 && (r = await A.signIn("samantha@myshop.com", TEMP)).body.pending === "password");
  await A.password({ action: "change", current: TEMP, next: "samantha's second password" }, r.cookie);
  samCookie = (await A.signIn("samantha@myshop.com", "samantha's second password")).cookie;
  r = await A.twoFactor({ action: "activate", proposedSecret: SECRET, code: totpNow(SECRET) }, samCookie);
  const codes = r.body.recoveryCodes;
  ok("turning on two-step shows ten recovery codes, once", r.status === 200 && Array.isArray(codes) && codes.length === 10 && new Set(codes).size === 10 && codes.every(c => /^[a-z2-9]{5}-[a-z2-9]{5}$/.test(c)) &&
    !A.user("samantha@myshop.com").recoveryCodes.includes(codes[0]) && (await A.twoFactor({ action: "status" }, samCookie)).body.recoveryCodesLeft === 10);
  ok("signing in now needs a code as well", (await A.signIn("samantha@myshop.com", "samantha's second password")).body.status === "totp_required" && (await A.signIn("samantha@myshop.com", "samantha's second password", "000000")).status === 401);
  r = await A.signIn("samantha@myshop.com", "samantha's second password", codes[3].toUpperCase());
  ok("a recovery code stands in for the authenticator — once, and it is noted in the audit log", r.status === 200 && (await A.signIn("samantha@myshop.com", "samantha's second password", codes[3])).status === 401 &&
    (await A.twoFactor({ action: "status" }, r.cookie)).body.recoveryCodesLeft === 9 && A.audit("security.recovery_code_used").length === 1);
  ok("a second authenticator can't be swapped in while one is on", (await A.twoFactor({ action: "activate", proposedSecret: SECRET2, code: totpNow(SECRET2) }, r.cookie)).status === 409);
  const lost = r.cookie;
  r = await A.users({ action: "reset2fa", id: sam }, boss);
  ok("an admin resets a lost phone: two-step and its recovery codes are gone and the user is signed out", r.status === 200 && r.body.user.has2fa === false && A.user("samantha@myshop.com").totpSecret === null && A.user("samantha@myshop.com").recoveryCodes === null &&
    (await A.users({ action: "me" }, lost)).status === 401 && (await A.signIn("samantha@myshop.com", "samantha's second password")).body.pending === null);
  const entries = (a) => A.audit(a);
  ok("each of these is in the audit log with who did it and to whom — and no password", ["security.user_created", "security.user_updated", "security.user_role_changed", "security.user_disabled", "security.user_enabled", "security.user_password_reset", "security.user_2fa_reset"].every(a => entries(a).length >= 1 && entries(a).every(e => e.actorUserId != null && e.actor)) &&
    entries("security.user_password_reset")[0].targetUserId === sam && entries("security.user_password_reset")[0].actorUserId === olive && entries("security.user_password_reset")[0].actor === "olive@myshop.com" &&
    !JSON.stringify(A.d1.q("SELECT * FROM audit_log")).includes(TEMP) && !JSON.stringify(A.d1.q("SELECT * FROM audit_log")).includes(codes[0]));
  const seen = (await A.lib.getAuditLog(A.d1, { action: "security.user_", limit: 50 }));
  ok("the audit view gets both user ids back", seen.length >= 7 && seen.every(e => "actorUserId" in e && "targetUserId" in e) && forbidden(await A.orders({ action: "getAuditLog" }, manager)) === false);

  console.log("\n=== Require two-step sign-in ===");
  samCookie = (await A.signIn("samantha@myshop.com", "samantha's second password")).cookie;
  ok("it is off until an admin turns it on", (await A.users({ action: "me" }, samCookie)).body.require2fa === false && (await A.users({ action: "list" }, boss)).body.require2fa === false);
  await A.twoFactor({ action: "activate", proposedSecret: SECRET3, code: totpNow(SECRET3) }, boss);   // the admin enrols first
  r = await A.users({ action: "setRequire2fa", on: true }, boss);
  ok("turning it on is recorded, and signs nobody out: sessions from before keep working", r.status === 200 && A.audit("security.require_2fa_changed").length === 1 && /"on":true/.test(A.audit("security.require_2fa_changed")[0].detail) &&
    (await A.orders({ action: "getOrdersAllShops" }, samCookie)).status === 200 && (await A.users({ action: "me" }, samCookie)).body.pending === null);
  r = await A.signIn("samantha@myshop.com", "samantha's second password");
  const enrol = r.cookie;
  ok("at the next sign-in a user without an authenticator is sent to set one up", r.status === 200 && r.body.pending === "2fa");
  let open = [];
  for (const action of ["getOrdersAllShops", "listProducts", "getRevenueReport", "saveExpense", "getBoxPresets"]) if (!pendingRefusal(await A.orders({ action }, enrol))) open.push(action);
  if (!pendingRefusal(await A.password({ action: "status" }, enrol))) open.push("admin-password");
  if (!pendingRefusal(await A.users({ action: "list" }, enrol))) open.push("admin-users list");
  ok("until they have, no page's API answers them — 403 with the reason", open.length === 0);
  ok("…only who-am-I and the enrolment itself", (await A.users({ action: "me" }, enrol)).body.pending === "2fa" && (r = await A.twoFactor({ action: "status" }, enrol)).status === 200 && r.body.required === true && r.body.enabled === false && (await A.twoFactor({ action: "generate" }, enrol)).status === 200);
  ok("a wrong code doesn't enrol them", (await A.twoFactor({ action: "activate", proposedSecret: SECRET2, code: "000000" }, enrol)).status === 400 && pendingRefusal(await A.orders({ action: "getOrdersAllShops" }, enrol)));
  r = await A.twoFactor({ action: "activate", proposedSecret: SECRET2, code: totpNow(SECRET2) }, enrol);
  ok("once enrolled — recovery codes in hand — the same session is let through", r.status === 200 && r.body.pending === null && r.body.recoveryCodes.length === 10 && (await A.orders({ action: "getOrdersAllShops" }, enrol)).status === 200);
  ok("someone already enrolled is unaffected: password, code, in", (r = await A.signIn("olive@myshop.com", "correct horse battery", totpNow(SECRET3, 1))).status === 200 && r.body.pending === null);
  ok("while it is required nobody can switch their own two-step off", (r = await A.twoFactor({ action: "disable", code: totpNow(SECRET2) }, enrol)).status === 409 && /required/.test(r.body.message) && !!A.user("samantha@myshop.com").totpSecret);
  ok("the code that just turned two-step on can't be used again", (r = await A.twoFactor({ action: "newRecoveryCodes", code: totpNow(SECRET2) }, enrol)).status === 400 && /already used/.test(r.body.message));
  ok("new recovery codes need a code from the app, and replace the old ones", (await A.twoFactor({ action: "newRecoveryCodes", code: "000000" }, enrol)).status === 400 && (r = await A.twoFactor({ action: "newRecoveryCodes", code: totpNow(SECRET2, 1) }, enrol)).status === 200 && r.body.recoveryCodes.length === 10);
  await A.users({ action: "reset2fa", id: sam }, boss);
  ok("after an admin resets it, that user must enrol again at their next sign-in", (await A.signIn("samantha@myshop.com", "samantha's second password")).body.pending === "2fa");
  const fresh = await A.users({ action: "create", name: "Nia New", email: "nia@myshop.com", role: "staff" }, boss);
  r = await A.signIn("nia@myshop.com", fresh.body.temporaryPassword);
  ok("a brand-new user does the steps in order: a password of their own first, then two-step", r.body.pending === "password" && (r = await A.password({ action: "change", current: fresh.body.temporaryPassword, next: "nia chose this one!" }, r.cookie)).status === 200 &&
    (await A.signIn("nia@myshop.com", "nia chose this one!")).body.pending === "2fa");
  await A.users({ action: "setRequire2fa", on: false }, boss);
  r = await A.signIn("samantha@myshop.com", "samantha's second password");
  ok("switched off again, sign-in asks for nothing extra, and two-step is each user's own choice", r.body.pending === null && A.audit("security.require_2fa_changed").length === 2);
  await A.twoFactor({ action: "activate", proposedSecret: SECRET, code: totpNow(SECRET) }, r.cookie);
  ok("…which they can switch off themselves with a code", (await A.twoFactor({ action: "disable", code: "000000" }, r.cookie)).status === 400 && (await A.twoFactor({ action: "disable", code: totpNow(SECRET, 1) }, r.cookie)).status === 200 && A.user("samantha@myshop.com").totpSecret === null);

  console.log("\n=== The admin page ===");
  // The page hides what a role can't use; the server (above) is what refuses it. These run the
  // page's own functions, cut out of public/admin.js, against stand-ins.
  const adminJs = read("public/admin.js");
  const cut = (start, end) => { const i = adminJs.indexOf(start); const j = adminJs.indexOf(end, i); if (i < 0 || j < 0) throw new Error("admin.js no longer has: " + start); return adminJs.slice(i, j); };
  const NAV = new Function(cut("const ADMIN_NAV_GROUPS = [", "// Flat list of every page hash") + "\nreturn ADMIN_NAV_GROUPS;")();
  const roles = (perms) => new Function("adminPerms", "adminAreas", "ADMIN_NAV_GROUPS", "adminPageOn_",
    cut("const ADMIN_LEVEL_RANK_", "function adminRoleName_") + cut("function adminPageItem_(hash){", "// Where someone lands") +
    "\nreturn { adminCan_, adminPageItem_, adminNavGroups_, adminCanOpen_, adminCanOpenPage_ };")(perms, P.PERMISSION_AREAS, NAV, () => true);
  const of = (role) => roles(role ? P.effectivePermissions(P.DEFAULT_ROLES[role]) : null);
  const pagesFor = (role) => of(role).adminNavGroups_().flatMap(g => g.items.filter(Array.isArray).map(i => i[0]));
  const R = of("staff");
  ok("each page belongs to a menu item: a shop's settings, a new shop and the wizard are Shop setup's; the old #catalog/settings is Global settings'",
    ["setup/x", "wizard/new", "catalog/new-org", "catalog/orgs/league-101/edit"].every(h => R.adminPageItem_("#" + h) === "setup") && R.adminPageItem_("catalog/settings") === "settings" &&
    R.adminPageItem_("catalog/orgs/league-101/products") === "catalog" && R.adminPageItem_("") === "home" && R.adminPageItem_("designs/league-101") === "designs" && R.adminPageItem_("security") === "" && R.adminPageItem_("password") === "");
  ok("Production's menu is Home, Orders, Run Order, Run Transfer Sheets, the Production menu and its own account — nothing else", (() => {
    const P_ = of("production"), top = ["home", "orders", "runorder", "runtransfer", "catalog"].filter(h => P_.adminCanOpen_(h)), menus = P_.adminNavGroups_().map(g => g.label);
    return top.join() === "home,orders,runorder,runtransfer" && menus.join() === "Production,Settings" &&
      pagesFor("production").filter(h => !["security", "password"].includes(h)).every(h => NAV.find(g => g.label === "Production").items.some(i => i[0] === h)) && !P_.adminCanOpen_("users") && !P_.adminCanOpen_("inventory"); })());
  ok("…and in it only making things and moving them on is more than Read", (() => { const P_ = of("production");
    return P_.adminCan_("run.markMade", "edit") && P_.adminCan_("orders.stepsLate", "edit") && P_.adminCan_("orders.shipping", "edit") && P_.adminCan_("transfer.mark", "edit") &&
      !P_.adminCan_("orders.details", "edit") && !P_.adminCan_("orders.stepsEarly", "edit") && !P_.adminCan_("production.machines", "edit") && !P_.adminCan_("orders.payments", "read") && !P_.adminCan_("costs.view"); })());
  ok("the menu a Back office user sees has none of the manager's or admin's pages; a manager's has no Users or Audit Log; an admin's has everything", !pagesFor("staff").some(p => ["users", "audit", "settings", "packages", "money", "reconcile", "books"].includes(p)) && !pagesFor("staff").some(p => ["revenue", "salestax", "cogs", "expenses"].includes(p)) && pagesFor("staff").includes("inventory") && pagesFor("staff").includes("password") &&
    ["packages", "money", "books", "revenue", "salestax", "cogs", "expenses"].every(p => pagesFor("manager").includes(p)) && !pagesFor("manager").includes("users") && !pagesFor("manager").includes("audit") && pagesFor("manager").includes("settings") && ["users", "audit", "settings"].every(p => pagesFor("admin").includes(p)));
  ok("before the server has said what a role may do, the page hides nothing (the server still refuses): nobody is locked out of the menu by an older server", pagesFor(null).includes("users") && of(null).adminCan_("settings.global", "full"));
  ok("a menu or item switched off is gone, and so are its pages", (() => { const off = JSON.parse(JSON.stringify(P.DEFAULT_ROLES.manager)); off.permissions.menus.finance = false; off.permissions.items.revenue = false;
    const M = roles(P.effectivePermissions(off)); return !M.adminNavGroups_().some(g => g.label === "Finance") && !M.adminCanOpen_("money") && !M.adminCanOpen_("revenue") && M.adminCanOpen_("cogs"); })());
  ok("Users is in the Settings menu, with 2FA, Change password, Sign out and Sign out everywhere", /\["users", "Users"\], \["security", "Security \(2FA\)"\], \["password", "Change password"\],\s*\{ action: "adminSignOut\(\)", label: "Sign out" \}, \{ action: "adminSignOutEverywhere\(\)", label: "Sign out everywhere" \}/.test(adminJs));
  const route = cut("async function adminRoute()", "function promptAdminPassphrase");
  ok("the router shows a step that is owed before any page, and a page above the user's role says so instead of loading", route.indexOf("if (adminPending) { renderPendingStep_(app); return; }") > 0 && route.indexOf("if (adminPending)") < route.indexOf("renderOrdersPage(app)") &&
    route.indexOf("if (!adminCanOpenPage_(raw)) { renderRoleOff_(app, raw); return; }") > 0 && route.indexOf("renderRoleOff_") < route.indexOf("renderOrdersPage(app)") && /if \(raw === "users"\) \{ renderUsers\(app\); return; \}/.test(route));
  const start = cut("async function loadAdminOrgList(){", "// Straight after signing in");
  ok("on start-up a step that is owed is drawn BEFORE any data is asked for, and the menu stays hidden", start.indexOf("if(adminPending){ renderPendingStep_(") > 0 && start.indexOf("if(adminPending)") < start.indexOf('action: "listOrgs"') && /if\(!adminOrgs \|\| !adminKey \|\| adminPending\)\{ if\(nav\) nav\.remove\(\); return; \}/.test(adminJs));
  ok("…a server that says a step is owed is believed, rather than treated as signed out", start.indexOf('data.code === "setup_required"') > 0 && start.indexOf('data.code === "setup_required"') < start.indexOf("clearAdminAuth();"));
  ok("only someone who can change Global settings is sent there after signing in, and nobody is left on a page they can't open", /if \(!adminCanOpen_\(location\.hash\)\) adminSetHash\(adminFirstPage_\(\)\);/.test(start) && /if \(adminCan_\("settings\.global", "edit"\)\) await openSettingsIfSetupIncomplete_\(\);/.test(start));
  ok("being refused for your role doesn't sign you out: the page signs out on 401, not on any error", !/if\(!res\.ok \|\| data\.status === "error"\)\{\n      clearAdminAuth\(\);\n      showToast/.test(adminJs) && (adminJs.match(/adminSessionEnded_\(res\);/g) || []).length === 7 &&
    /if\(!adminSessionEnded_\(res\)\) adminSessionEnded_\(data\);/.test(cut("async function postOrdersInGroups_(", "function bulkStoppedNote_")) &&
    /const ended = x\.status === 401 \|\| x\.message === "Unauthorized" \|\| \/\^Session expired\//.test(adminJs));
  ok("sign-in sends the email with the password, remembers the email (never the password), and keeps who signed in and what they owe", /adminSessionPost_\(\{email, key\}\)/.test(adminJs) && /adminSessionPost_\(\{email, key, totpCode\}\)/.test(adminJs) &&
    /adminPending = data\.pending \|\| null;\n      adminMe = data\.user \|\| null;/.test(adminJs) && /rememberAdminEmail_\(\(data\.user && data\.user\.email\) \|\| ""\)/.test(adminJs) && !/localStorage\.setItem\([^)]*key\b[^)]*\)/.test(cut("async function adminLogin(){", "async function fetchOrders")));
  // The three screens a pending session is sent to.
  const stepFor = (pending) => { const seen = []; new Function("adminPending", "renderAdminNav", "renderAccountSetup", "renderChangePassword", "render2FASetup", "adminStepDone_", cut("function renderPendingStep_(app){", "function adminStepDone_") + "\nrenderPendingStep_({});")(
    pending, () => {}, () => seen.push("account"), (a, forced) => seen.push("password:" + forced), (a, forced) => seen.push("2fa:" + forced), () => seen.push("done")); return seen.join(); };
  ok("each step has its screen: finishing the account, replacing a temporary password, enrolling in two-step — each in its no-way-around form", stepFor("account") === "account" && stepFor("password") === "password:true" && stepFor("2fa") === "2fa:true" && stepFor("nonsense") === "done");
  // The forms, run against a stand-in page.
  const runForm = async (fnName, endMarker, fields, reply, extra = {}) => {
    const els = {}; for (const [k, v] of Object.entries(fields)) els[k] = typeof v === "object" ? v : { value: v };
    const calls = [], out = { signedOut: 0, toast: "", done: undefined, remembered: "" };
    const names = ["document", "fetch", "adminSignOut", "showToast", "adminKey", "ADMIN_MIN_PASSWORD_", "rememberAdminEmail_", "adminStepDone_", "adminMe"];
    const fn = new Function(...names, cut("async function " + fnName + "(ev){", endMarker) + "\nreturn " + fnName + ";")({ getElementById: (id) => els[id] || null },
      async (url, init) => { calls.push([url, JSON.parse(init.body)]); return reply; }, () => { out.signedOut++; }, (m) => { out.toast = m; }, "cookie", 12, (e) => { out.remembered = e; }, (p) => { out.done = p; }, extra.me || null);
    await fn({ preventDefault(){} });
    return { calls, out, els };
  };
  const acct = (over, reply, needPassword = "1") => runForm("submitAccountSetup", "// ---- Change password:", Object.assign({ acctForm: { dataset: { needPassword } }, acctError: { textContent: "" }, acctSubmit: { disabled: false },
    acctName: "Olive Owner", acctEmail: "olive@myshop.com", acctNext: "long enough pass", acctAgain: "long enough pass" }, over), reply);
  let f = await acct({ acctAgain: "long enough pasz" }, null);
  ok("finishing the account: the two passwords must match before anything is sent", f.calls.length === 0 && /don't match/.test(f.els.acctError.textContent));
  f = await acct({ acctEmail: "olive" }, null);
  ok("…and the email must look like one", f.calls.length === 0 && /email address/.test(f.els.acctError.textContent));
  f = await acct({}, { ok: true, json: async () => ({ status: "ok", signInAgain: true }) });
  ok("…a password was set: the page signs out, so the next thing is a sign-in with the email (remembered) and the new password", f.calls[0][0] === "/api/admin-password" && f.calls[0][1].action === "account" && f.calls[0][1].next === "long enough pass" && f.out.signedOut === 1 && f.out.remembered === "olive@myshop.com" && /Sign in with your email/.test(f.out.toast));
  f = await acct({}, { ok: true, json: async () => ({ status: "ok", pending: "2fa" }) }, "0");
  ok("…an owner who kept their password is not signed out, sends no password, and goes on to whatever is next", f.out.signedOut === 0 && !("next" in f.calls[0][1]) && f.out.done === "2fa");
  const chg = (over, reply) => runForm("submitChangePassword", "// Security (2FA): your own two-step", Object.assign({ pwError: { textContent: "" }, pwSubmit: { disabled: false }, pwCurrent: "temp-pass-word", pwNext: "long enough pass", pwAgain: "long enough pass" }, over), reply);
  f = await chg({}, { ok: false, json: async () => ({ status: "error", message: "The current password is not right." }) });
  ok("changing a password: a refusal is shown and the user stays signed in", /not right/.test(f.els.pwError.textContent) && f.out.signedOut === 0 && f.els.pwSubmit.disabled === false);
  f = await chg({}, { ok: true, json: async () => ({ status: "ok", signInAgain: true }) });
  ok("…success signs out, for a fresh sign-in with the new password", f.out.signedOut === 1 && /Sign in with the new one/.test(f.out.toast));
  // What a user can't use isn't shown at all: no menu entry, no link, no button.
  ok("Global settings is hidden from Back office and Production; a manager can open it to read", !of("staff").adminCanOpen_("settings") && !of("production").adminCanOpen_("settings") && of("manager").adminCanOpen_("settings") && !of("manager").adminCan_("settings.global", "edit") &&
    !adminJs.includes("globalSettingsReadOnly_"));
  ok("the page asks the server who is signed in, and what they may do, before drawing the menu (a missing or stale copy can't show everything)",
    /await refreshAdminMe_\(\);\s*renderAdminNav\(\);/.test(cut("async function loadAdminOrgList(){", "function renderPickerOrgButtons")) && /action: "me"/.test(cut("async function refreshAdminMe_(){", "async function loadAdminOrgList(){")) &&
    /adminPerms = data\.permissions;/.test(cut("async function refreshAdminMe_(){", "async function loadAdminOrgList(){")) && /adminMe = null;\n  adminPerms = null;/.test(adminJs));
  ok("sign-in only takes someone who can change Global settings there to finish setup; the 'turned off' page only offers it to whoever can open it", /if \(!adminCanOpen_\("settings"\)\) return;/.test(cut("async function openSettingsIfSetupIncomplete_", "function renderPickerOrgButtons")) &&
    /\$\{adminCanOpen_\("settings"\) \? `<button class="admin-btn" onclick="location\.hash='#settings'">Open Global settings<\/button>` : ""\}/.test(adminJs));
  // The markup checks below read past the permission tags (data-need=…), which test194 checks on their own.
  const markup_ = (t) => t.replace(/ data-need(?:-form)?="[^"]*"/g, ""), markup = markup_(adminJs);
  ok("buttons follow the role's functions: a shop's Edit, Create test transaction, Import orders, managing expense categories, New shop setup",
    /\$\{adminCanOpen_\("catalog\/orgs\/" \+ o\.orgId \+ "\/edit"\) \? `<button/.test(markup) && /const manager = adminCan_\("catalog\.shops", "edit"\);/.test(markup) &&
    /\$\{adminCan_\("catalog\.shops", "edit"\) \? `<button class="admin-btn" data-org="\$\{escapeHtml\(selectedOrgId\)\}" onclick="createTestTransaction/.test(markup) && /\$\{adminCan_\("orders\.import", "edit"\) \? `<button[^`]*pickOrderImportFile_/.test(markup) &&
    /\$\{adminCan_\("finance\.expenses", "edit"\) \? `<button type="button" class="admin-btn" id="expCatManage"/.test(markup) && /\$\{adminCan_\("catalog\.shops", "edit"\) \? `<button class="admin-btn wiz-start-btn"/.test(markup));
  const cell = cut("function adminActionCell(org, o){", "// The order row's Resend downloads");
  ok("an order's row draws Delete, Payments, Mark as paid, Edit items and each step only for a role that may use them", /const deleteBtn = !can\("orders\.details", "full"\)/.test(markup_(cell)) && /const paymentsBtn = !can\("orders\.payments", "read"\)/.test(markup_(cell)) &&
    /can\("orders\.payments", "edit"\) \? `<button class="admin-btn" \$\{dataAttrs\} onclick="markOrderPaid/.test(markup_(cell)) && /can\(FULFILLMENT_LATE_\.includes\(s\.stage\) \? "orders\.stepsLate" : "orders\.stepsEarly", "edit"\)/.test(markup_(cell)) &&
    /\$\{adminCan_\("orders\.details", "full"\) \? `<button class="admin-btn admin-btn-danger admin-btn-danger-solid" style="color:#fff;" data-org="\$\{escapeHtml\(org\.orgId\)\}" onclick="bulkCancelLineItems/.test(markup));
  ok("the Users page has the Roles and permissions tab, offers only the roles you may give, and keeps the two-step switch for admins", /tab\("roles", "Roles and permissions"\)/.test(adminJs) && /r\.rank < myRank \|\| \(iAmAdmin && r\.key === "admin"\)/.test(adminJs) &&
    /Require two-step sign-in for everyone/.test(adminJs) && /usersCall_\(\{action: "setRequire2fa", on\}\)/.test(adminJs) && /action: "saveRole"/.test(adminJs) && /action: "deleteRole"/.test(adminJs));
  ok("recovery codes are shown once, at enrolment, and the forced enrolment only moves on when the user says they have them", /render2FACodes_\(data\.recoveryCodes, after\)/.test(adminJs) && /if\(wasForced\)\{ _tfa\.forced = false; adminStepDone_\(data\.pending\); \}/.test(adminJs));

  console.log(`\n${pass} passed, ${fail} failed`);
})().catch(e => { console.log("test115 crashed:", e); console.log("test115 crashed: false"); });
