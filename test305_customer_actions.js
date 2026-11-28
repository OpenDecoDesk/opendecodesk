const fs = require("fs");
const { ok } = require("./testlib/check");
const { createD1 } = require("./testlib/d1-shim.js");
const roles = require("./testlib/roles");
const { makeAuth, prelude, strip, read, request, answer } = require("./testlib/auth-harness");

// Customer records (migrations/0108): the six customer actions of /api/orders and the customer picked on a
// local sale, through the real handler.
//   - functions/_lib/permissions.js: the Customers area, each action's level, the built-in roles' defaults
//   - who may: every built-in role and two made-up ones behind the REAL sign-in gate (adminAuth.js), signed out
//   - every refusal and its sentence, the answers' shapes, the audit rows (only on a real change)
//   - no period guard, and a database that hasn't had 0108 yet
// (What a merge moves and when an exemption applies are other files' business: here only who may.)
// Real SQL (sql.js) under the real db.js and orders.js. Invented customers only.

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keys = (o) => Object.keys(o || {}).sort().join(",");
const forbidden = (r) => r.status === 403 && r.body && r.body.status === "error" && r.body.code === "forbidden";
const refused = (r, status, message) => r.status === status && r.body && r.body.status === "error" && r.body.message === message;
const NOT_VALID = "That customer isn't valid.", NOT_FOUND = "Customer not found", PICK = "That customer isn't valid. Pick one from the list.",
  MERGED = "That customer was merged into another one. Open that one instead.", ROLE = "Your role can't do this. Ask an admin.",
  NOT_READY = "Customers aren't ready yet: the database is still being updated. Try again in a minute.";
const SIX = ["listCustomers", "getCustomer", "saveCustomer", "setCustomerArchived", "mergeCustomers", "setOrderCustomer"];
const ordersJs = read("functions/api/orders.js");

(async () => {
  console.log("=== The permission (functions/_lib/permissions.js) ===");
  const areas = roles.PERMISSION_AREAS, at = areas.findIndex(a => a.key === "customers");
  ok("Customers is a permission area of its own, right after Orders", at > 0 && areas[at - 1].key === "orders");
  ok("…with one page (customers) and one function: customers.records, \"Customer records\"",
    same(areas[at], { key: "customers", label: "Customers", items: [{ hash: "customers", label: "Customers", fns: [["customers.records", "Customer records"]] }] }));
  ok("the function is on the Roles screen's list once", roles.PERM_FUNCTIONS.filter(f => f === "customers.records").length === 1);
  const perm = (a) => roles.ACTION_PERM[a];
  ok("listing and opening customers need customers.records at read", same(perm("listCustomers"), [["customers.records", "read"]]) && same(perm("getCustomer"), [["customers.records", "read"]]));
  ok("saving, archiving and linking an order need it at edit", ["saveCustomer", "setCustomerArchived", "setOrderCustomer"].every(a => same(perm(a), [["customers.records", "edit"]])));
  ok("merging needs it at full", same(perm("mergeCustomers"), [["customers.records", "full"]]));
  ok("a local sale still needs only orders.details at edit (a picked customer is checked inside)", same(perm("createLocalSale"), [["orders.details", "edit"]]));
  const level = (role, fn) => roles.effectivePermissions(roles.DEFAULT_ROLES[role])[fn];
  ok("built-in defaults: Admin and Manager full, Back office edit, Production read",
    ["admin", "manager", "staff", "production"].map(r => level(r, "customers.records")).join() === "full,full,edit,read");
  ok("…which is each role's level for orders.details", ["admin", "manager", "staff", "production"].every(r => level(r, "customers.records") === level(r, "orders.details")));
  const mayRow = (a) => ["production", "staff", "manager", "admin"].map(r => roles.may(r, a) ? "yes" : "no").join();
  ok("so Production reads, Back office also saves, archives and links, and only Manager and Admin merge",
    mayRow("listCustomers") === "yes,yes,yes,yes" && mayRow("getCustomer") === "yes,yes,yes,yes" && mayRow("saveCustomer") === "no,yes,yes,yes" &&
    mayRow("setCustomerArchived") === "no,yes,yes,yes" && mayRow("setOrderCustomer") === "no,yes,yes,yes" && mayRow("mergeCustomers") === "no,no,yes,yes");
  const P = new Function(read("functions/_lib/permissions.js").replace(/export (async function|function|const)/g, "$1") + "\nreturn { normalizePermissions, effectiveLevel, roleAllows, ACTION_PERM };")();
  const stored = P.normalizePermissions({ fns: { "orders.details": "full" } });
  ok("a role stored before the permission existed has none of it", stored.fns["customers.records"] === "none" && SIX.every(a => !P.roleAllows({ key: "r_old", permissions: stored }, P.ACTION_PERM[a])));
  const full = { fns: { "customers.records": "full" } };
  ok("a role with it at full may use all six actions", SIX.every(a => P.roleAllows({ key: "r_x", permissions: P.normalizePermissions(full) }, P.ACTION_PERM[a])));
  ok("…unless the Customers area or its page is switched off for the role: then none",
    P.effectiveLevel({ key: "r_x", permissions: P.normalizePermissions({ ...full, menus: { customers: false } }) }, "customers.records") === "none" &&
    P.effectiveLevel({ key: "r_x", permissions: P.normalizePermissions({ ...full, items: { customers: false } }) }, "customers.records") === "none" &&
    P.effectiveLevel({ key: "r_x", permissions: P.normalizePermissions(full) }, "customers.records") === "full");
  ok("a level it doesn't know (a typo) is none", P.normalizePermissions({ fns: { "customers.records": "write" } }).fns["customers.records"] === "none");

  // ---- The real endpoint behind the real sign-in (adminAuth.js), on schema.sql ----
  const A = await makeAuth();
  const d1 = A.d1;
  const post = new Function("__hits", prelude(false, false) + strip(read("functions/_lib/catalogValidation.js")) + "\n" + strip(read("functions/_lib/quoteToken.js")) + "\n" +
    "const invalidateCatalogVersionCache = () => {}; const selectBox = () => null;\n" +
    strip(read("functions/_lib/setupStatus.js")) + "\n" + strip(read("functions/_lib/vendorCredentials.js")) + "\n" + strip(read("functions/_lib/smtp.js")) + "\n" +
    strip(read("functions/_lib/email.js")) + "\n" + ordersJsStripped() + "\nreturn onRequestPost;")(A.hits);
  function ordersJsStripped() { return strip(ordersJs); }
  // One request; the audit rows it leaves for after the answer (waitUntil) are written before this returns.
  const call = async (body, cookie) => {
    const waits = [];
    const res = await post({ request: request("/api/orders", body, { cookie }), env: A.env, waitUntil: (p) => waits.push(Promise.resolve(p).catch(() => {})) });
    await Promise.all(waits);
    return answer(res);
  };
  const lib = new Function(strip(read("functions/_lib/db.js")) + "\nreturn { insertOrder };")();
  const q = (sql) => d1.q(sql);
  const custRow = (id) => q("SELECT * FROM customers WHERE id = " + Number(id))[0] || null;
  const orderRow = (id) => q("SELECT * FROM orders").find(o => o.orderId === id) || null;
  const auditRows = (action) => q("SELECT * FROM audit_log ORDER BY id").filter(r => r.action === action).map(r => ({ ...r, detail: JSON.parse(r.detail || "null") }));
  const auditCount = () => q("SELECT count(*) n FROM audit_log")[0].n;
  const customerCount = () => q("SELECT count(*) n FROM customers")[0].n;
  const orderCount = () => q("SELECT count(*) n FROM orders")[0].n;
  // What a request left behind: the answer, and the audit rows written by it.
  const logged = async (body, cookie) => { const before = q("SELECT COALESCE(MAX(id), 0) m FROM audit_log")[0].m; const r = await call(body, cookie);
    return { ...r, rows: q("SELECT * FROM audit_log WHERE id > " + before + " ORDER BY id").map(x => ({ ...x, detail: JSON.parse(x.detail || "null") })) }; };

  const admin = await A.firstAdmin("Olive Owner", "olive@example.com");
  const manager = await A.addUser(admin, "manager", "Mo Manager", "mo@example.com");
  const staff = await A.addUser(admin, "staff", "Sam Staff", "sam@example.com");
  const prod = await A.addUser(admin, "production", "Pat Production", "pp@example.com");
  // Three made-up roles, each Back office with one thing different.
  const staffRole = (await A.users({ action: "listRoles" }, admin)).body.roles.find(x => x.key === "staff");
  const roleWith = async (name, change) => {
    const permissions = JSON.parse(JSON.stringify(staffRole.permissions)); change(permissions);
    const r = await A.users({ action: "saveRole", name, rank: 40, permissions }, admin);
    return r.body.role.key;
  };
  const noCustomers = await A.addUser(admin, await roleWith("Counter", (p) => { p.fns["customers.records"] = "none"; }), "Casey Counter", "casey@example.com");
  const noOrders = await A.addUser(admin, await roleWith("Address book", (p) => { p.fns["orders.details"] = "none"; }), "Addy Book", "addy@example.com");
  const pageOff = await A.addUser(admin, await roleWith("Page off", (p) => { p.fns["customers.records"] = "full"; p.items.customers = false; }), "Paige Off", "paige@example.com");
  const me = async (cookie) => (await A.users({ action: "me" }, cookie)).body.permissions;
  ok("the roles under test are what they should be: a role without Customers, one without Orders, one with the Customers page switched off",
    (await me(noCustomers))["customers.records"] === "none" && (await me(noCustomers))["orders.details"] === "edit" &&
    (await me(noOrders))["customers.records"] === "edit" && (await me(noOrders))["orders.details"] === "none" &&
    (await me(pageOff))["customers.records"] === "none" && (await me(staff))["customers.records"] === "edit" && (await me(prod))["customers.records"] === "read");

  d1._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Example Club','t','t');`);
  const line = [{ productId: "cap", name: "Cap", type: "cap", size: "OSFA", qty: 1, unitPrice: 20 }];
  await lib.insertOrder(d1, { orderId: "O-1", orgId: "acme", customerName: "Pat Example", contact: "pat@example.com", placedAt: "2026-03-10T15:00:00.000Z" }, line);
  await lib.insertOrder(d1, { orderId: "O-2", orgId: "acme", customerName: "Walk In", contact: "555-0100", placedAt: "2026-03-11T15:00:00.000Z" }, line);
  await lib.insertOrder(d1, { orderId: "O-3", orgId: "acme", customerName: "Lee Example", contact: "lee@example.com", placedAt: "2026-03-12T15:00:00.000Z" }, line);
  const patId = orderRow("O-1").customerId, leeId = orderRow("O-3").customerId;
  ok("the orders under test: two belong to a customer by their email, the one with a phone number to nobody",
    Number.isInteger(patId) && Number.isInteger(leeId) && patId !== leeId && orderRow("O-2").customerId === null && customerCount() === 2);
  const sale = (extra) => Object.assign({ action: "createLocalSale", org: "acme", customerName: "Counter Sale", contact: "555-0101",
    items: [{ productId: "__custom__", name: "Sample patch", type: "other", customUnitPrice: 10, qty: 1 }] }, extra || {});
  // A throw-away customer straight into the table (id back), for checks that use one up.
  const spare = (name, extra = {}) => { const cols = Object.assign({ name, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }, extra);
    d1._raw.run(`INSERT INTO customers (${Object.keys(cols).join(",")}) VALUES (${Object.keys(cols).map(() => "?").join(",")})`, Object.values(cols));
    return q("SELECT MAX(id) m FROM customers")[0].m; };

  console.log("\n=== Signed out: nothing answers ===");
  {
    const customers = customerCount(), orders = orderCount(), log = auditCount();
    const bodies = { listCustomers: {}, getCustomer: { id: patId }, saveCustomer: { name: "Nobody Example" }, setCustomerArchived: { id: patId, archived: true },
      mergeCustomers: { fromId: leeId, intoId: patId }, setOrderCustomer: { orderId: "O-2", customerId: patId } };
    const got = [];
    for (const a of SIX) got.push(await call(Object.assign({ action: a }, bodies[a]), ""));
    ok("each of the six customer actions answers 401 Unauthorized without a session", got.every(r => refused(r, 401, "Unauthorized")));
    ok("…and gives nothing away: no customers, no customer, no id", got.every(r => keys(r.body) === "message,status"));
    ok("a local sale with a customer picked is refused the same way", refused(await call(sale({ customerId: patId }), ""), 401, "Unauthorized"));
    ok("a session that has ended is told to sign in again", refused(await call({ action: "listCustomers" }, "sess_" + "0".repeat(48)), 401, "Session expired — please log in again."));
    ok("nothing was added, changed or logged", customerCount() === customers && orderCount() === orders && auditCount() === log &&
      custRow(patId).archivedAt === null && orderRow("O-2").customerId === null && custRow(leeId).mergedIntoId === null);
  }

  console.log("\n=== Who may: each built-in role ===");
  {
    // Bodies that are refused AFTER the gate (a 400 or 404) so the same request can be sent as every role and
    // change nothing: 403 is the gate's answer, anything else got past it.
    const probe = { listCustomers: { limit: 1 }, getCustomer: { id: 987654 }, saveCustomer: { id: 987654, name: "Nobody Example" }, setCustomerArchived: { id: 987654, archived: true },
      mergeCustomers: { fromId: 987654, intoId: 987655 }, setOrderCustomer: { orderId: "NO-SUCH", customerId: null } };
    const who = { admin, manager, staff, production: prod };
    const row = async (a) => { const out = []; for (const r of ["production", "staff", "manager", "admin"]) { const x = await call(Object.assign({ action: a }, probe[a]), who[r]);
      out.push(forbidden(x) ? (x.body.message === ROLE ? "no" : "no?") : x.status === 401 ? "out" : "yes"); } return out.join(); };
    const log = auditCount();
    ok("listCustomers: Production, Back office, Manager and Admin", await row("listCustomers") === "yes,yes,yes,yes");
    ok("getCustomer: Production, Back office, Manager and Admin", await row("getCustomer") === "yes,yes,yes,yes");
    ok("saveCustomer: not Production (\"Your role can't do this. Ask an admin.\"); Back office, Manager and Admin", await row("saveCustomer") === "no,yes,yes,yes");
    ok("setCustomerArchived: not Production; Back office, Manager and Admin", await row("setCustomerArchived") === "no,yes,yes,yes");
    ok("setOrderCustomer: not Production; Back office, Manager and Admin", await row("setOrderCustomer") === "no,yes,yes,yes");
    ok("mergeCustomers: not Production or Back office; Manager and Admin", await row("mergeCustomers") === "no,no,yes,yes");
    ok("a refusal for the role writes nothing to the audit log", auditCount() === log);

    // The same with requests that would go through.
    const victim = spare("Refused Example"), other = spare("Kept Example");
    let r = await call({ action: "saveCustomer", id: victim, name: "Renamed Example" }, prod);
    ok("Production can't change a customer: 403, the name stays", forbidden(r) && r.body.message === ROLE && custRow(victim).name === "Refused Example");
    r = await call({ action: "saveCustomer", name: "Added By Production" }, prod);
    ok("…nor add one", forbidden(r) && !q("SELECT name FROM customers").some(c => c.name === "Added By Production"));
    r = await call({ action: "setCustomerArchived", id: victim, archived: true }, prod);
    ok("…nor archive one", forbidden(r) && custRow(victim).archivedAt === null);
    r = await call({ action: "setOrderCustomer", orderId: "O-2", customerId: victim }, prod);
    ok("…nor link an order to one", forbidden(r) && orderRow("O-2").customerId === null);
    r = await call({ action: "mergeCustomers", fromId: victim, intoId: other }, prod);
    const r2 = await call({ action: "mergeCustomers", fromId: victim, intoId: other }, staff);
    ok("Production and Back office can't merge: 403, nobody is merged, no customer.merged row", forbidden(r) && forbidden(r2) && r2.body.message === ROLE &&
      custRow(victim).mergedIntoId === null && auditRows("customer.merged").length === 0);
    r = await call({ action: "listCustomers", q: "Refused" }, prod);
    const g = await call({ action: "getCustomer", id: patId }, prod);
    ok("Production reads the list and a customer, with the orders' money as the Orders page shows it", r.status === 200 && r.body.customers.length === 1 && g.status === 200 &&
      g.body.orders[0].total === 20 && g.body.orders[0].balanceDue === 20 && g.body.orders[0].paidAmount === 0 && g.body.totals.totalSpent === 20 && g.body.totals.balanceDue === 20);
    r = await call({ action: "saveCustomer", id: victim, name: "Renamed Example" }, staff);
    ok("Back office changes a customer", r.status === 200 && custRow(victim).name === "Renamed Example");
    r = await logged({ action: "mergeCustomers", fromId: victim, intoId: other }, manager);
    ok("a Manager merges: { status, moved }, the duplicate is retired, and customer.merged is in the audit log", r.status === 200 && keys(r.body) === "moved,status" && r.body.status === "ok" && r.body.moved === 0 &&
      custRow(victim).mergedIntoId === other && r.rows.length === 1 && r.rows[0].action === "customer.merged" && r.rows[0].detail.fromId === victim && r.rows[0].detail.intoId === other && r.rows[0].actor === "mo@example.com");
    const v2 = spare("Second Refused Example");
    r = await call({ action: "mergeCustomers", fromId: v2, intoId: other }, admin);
    ok("…and so does an Admin", r.status === 200 && custRow(v2).mergedIntoId === other);
  }

  console.log("\n=== Who may: the tax exemption needs Full ===");
  {
    const EXEMPT = "Your role can't change a customer's tax exemption. Ask an admin.";
    const id = spare("Exemption Example");
    const log = auditCount();
    let r = await call({ action: "saveCustomer", id, taxExempt: true }, staff);
    ok("Back office (edit) ticking Exempt is refused with a sentence saying so", forbidden(r) && r.body.message === EXEMPT);
    r = await call({ action: "saveCustomer", id, name: "Changed Too", taxExemptCertificate: "EX-0001" }, staff);
    const r2 = await call({ action: "saveCustomer", id, taxExemptExpires: "2031-01-31" }, staff);
    ok("…and so is a certificate or an expiry date; nothing else in that save is kept either", forbidden(r) && forbidden(r2) && r2.body.message === EXEMPT && custRow(id).name === "Exemption Example" &&
      custRow(id).taxExempt === 0 && custRow(id).taxExemptCertificate === "" && custRow(id).taxExemptExpires === null);
    r = await call({ action: "saveCustomer", name: "New And Exempt", taxExempt: true }, staff);
    ok("…and adding a customer who is exempt: nobody is added", forbidden(r) && !q("SELECT name FROM customers").some(c => c.name === "New And Exempt"));
    ok("none of those refusals reached the audit log", auditCount() === log);
    r = await logged({ action: "saveCustomer", name: "Plain Example", taxExempt: false, taxExemptCertificate: "", taxExemptExpires: "" }, staff);
    ok("Back office adds a customer whose exemption fields are sent empty: that is no exemption change", r.status === 200 && r.body.created === true && r.rows.map(x => x.action).join() === "customer.created");
    r = await logged({ action: "saveCustomer", id, taxExempt: true, taxExemptCertificate: "EX-0001", taxExemptExpires: "2031-01-31" }, manager);
    ok("a Manager (full) sets the exemption: saved, and logged as customer.exemption_changed", r.status === 200 && custRow(id).taxExempt === 1 && custRow(id).taxExemptCertificate === "EX-0001" && custRow(id).taxExemptExpires === "2031-01-31" &&
      r.rows.map(x => x.action).join() === "customer.exemption_changed");
    ok("…a save that changes only the exemption writes no customer.updated", !r.rows.some(x => x.action === "customer.updated"));
    r = await logged({ action: "saveCustomer", id, phone: "555-0102", taxExempt: true, taxExemptCertificate: "EX-0001", taxExemptExpires: "2031-01-31" }, staff);
    ok("Back office saves that customer sending the stored exemption back: allowed, and only the phone is logged", r.status === 200 && custRow(id).phone === "555-0102" && custRow(id).taxExempt === 1 &&
      r.rows.length === 1 && r.rows[0].action === "customer.updated" && keys(r.rows[0].detail.changes) === "phone");
    r = await logged({ action: "saveCustomer", id, notes: "Prefers pickup" }, staff);
    ok("…and leaving the exemption fields out keeps the exemption", r.status === 200 && custRow(id).taxExempt === 1 && custRow(id).taxExemptCertificate === "EX-0001" && custRow(id).taxExemptExpires === "2031-01-31" && keys(r.rows[0].detail.changes) === "notes");
    r = await call({ action: "saveCustomer", id, taxExempt: false }, staff);
    ok("Back office can't take an exemption away either", forbidden(r) && r.body.message === EXEMPT && custRow(id).taxExempt === 1);
    r = await logged({ action: "saveCustomer", id, company: "Example Club", taxExempt: false }, admin);
    ok("an Admin changing a field and the exemption in one save: the exemption has its own row, and customer.updated leaves the exemption fields out",
      r.status === 200 && r.rows.map(x => x.action).join() === "customer.exemption_changed,customer.updated" && keys(r.rows[1].detail.changes) === "company" &&
      same(r.rows[0].detail.changes, { taxExempt: { from: true, to: false } }) && custRow(id).taxExempt === 0);
    r = await call({ action: "saveCustomer", id, taxExemptExpires: "2027-02-31" }, admin);
    const r3 = await call({ action: "saveCustomer", id, taxExemptExpires: "next year" }, admin);
    ok("an expiry that isn't a calendar date is refused: \"The exemption's expiry date isn't a valid date.\"", refused(r, 400, "The exemption's expiry date isn't a valid date.") && refused(r3, 400, "The exemption's expiry date isn't a valid date.") && custRow(id).taxExemptExpires === "2031-01-31");
  }

  console.log("\n=== Who may: a role without the permission ===");
  {
    const customers = customerCount(), log = auditCount();
    const real = { listCustomers: {}, getCustomer: { id: patId }, saveCustomer: { name: "Nobody Example" }, setCustomerArchived: { id: patId, archived: true },
      mergeCustomers: { fromId: leeId, intoId: patId }, setOrderCustomer: { orderId: "O-2", customerId: patId } };
    let got = [];
    for (const a of SIX) got.push(await call(Object.assign({ action: a }, real[a]), noCustomers));
    ok("a made-up role with every Back office permission but Customers is refused all six actions", got.every(r => forbidden(r) && r.body.message === ROLE));
    got = [];
    for (const a of SIX) got.push(await call(Object.assign({ action: a }, real[a]), pageOff));
    ok("…and so is a role with Customers at full whose Customers page is switched off", got.every(r => forbidden(r) && r.body.message === ROLE));
    ok("nothing was added, archived, merged, linked or logged", customerCount() === customers && auditCount() === log && custRow(patId).archivedAt === null && custRow(leeId).mergedIntoId === null && orderRow("O-2").customerId === null);
    const orders = orderCount();
    let r = await call(sale({ customerId: patId }), noCustomers);
    ok("that role can't pick a customer for a local sale: 403 \"Your role can't pick a customer for a sale. Ask an admin.\", and no sale is made",
      forbidden(r) && r.body.message === "Your role can't pick a customer for a sale. Ask an admin." && orderCount() === orders);
    r = await logged(sale(), noCustomers);
    ok("…but records a local sale without one, as before", r.status === 200 && orderCount() === orders + 1 && orderRow(r.body.orderId).customerId === null && !("customerId" in r.rows.find(x => x.action === "order.created_local_sale").detail));
    r = await call(sale({ customerId: "abc" }), noCustomers);
    ok("…and a customer id that isn't one is a 400 for that role too, not a sale", refused(r, 400, PICK) && orderCount() === orders + 1);

    // Customers at edit, no Orders.
    r = await call({ action: "setOrderCustomer", orderId: "O-2", customerId: patId }, noOrders);
    ok("a role with Customers but no Orders can't change whose an order is: 403 \"Your role can't change an order's customer. Ask an admin.\"",
      forbidden(r) && r.body.message === "Your role can't change an order's customer. Ask an admin." && orderRow("O-2").customerId === null);
    r = await call({ action: "setOrderCustomer", orderId: "O-1", customerId: null }, noOrders);
    ok("…nor unlink one, and it isn't told whether the order exists", forbidden(r) && orderRow("O-1").customerId === patId && forbidden(await call({ action: "setOrderCustomer", orderId: "NO-SUCH", customerId: null }, noOrders)));
    r = await call({ action: "saveCustomer", name: "Booked Example", phone: "555-0103" }, noOrders);
    const l = await call({ action: "listCustomers", q: "Booked" }, noOrders);
    ok("…while it still adds and lists customers", r.status === 200 && r.body.created === true && l.status === 200 && l.body.total === 1);
    ok("…and can't record a local sale at all, with or without a customer", forbidden(await call(sale({ customerId: patId }), noOrders)) && forbidden(await call(sale(), noOrders)));
    ok("Production can't record a local sale either, so it never picks a customer for one", forbidden(await call(sale({ customerId: patId }), prod)) && orderCount() === orders + 1);
  }

  console.log("\n=== listCustomers ===");
  {
    let r = await call({ action: "listCustomers" }, staff);
    ok("answers { status, customers, total, defaultDays } (defaultDays: Global settings → Net 30 terms)", r.status === 200 && keys(r.body) === "customers,defaultDays,status,total" && r.body.defaultDays === 30 && r.body.status === "ok" && Array.isArray(r.body.customers) && r.body.total === r.body.customers.length);
    const pat = r.body.customers.find(c => c.id === patId);
    ok("a row is id, name, company, email, phone, taxExempt, taxExemptExpires, archived, Net 30 (allowNet30, termsDays), orderCount and lastOrderAt",
      keys(pat) === "allowNet30,archived,company,email,id,lastOrderAt,name,orderCount,phone,taxExempt,taxExemptExpires,termsDays" &&
      same(pat, { id: patId, name: "Pat Example", company: "", email: "pat@example.com", phone: "", taxExempt: false, taxExemptExpires: "", archived: false, allowNet30: false, termsDays: null, orderCount: 1, lastOrderAt: "2026-03-10T15:00:00.000Z" }));
    ok("customers merged into another are never listed", !r.body.customers.some(c => /Refused/.test(c.name)) && q("SELECT count(*) n FROM customers WHERE mergedIntoId IS NOT NULL")[0].n === 2);
    ok("sorted by name", same(r.body.customers.map(c => c.name), r.body.customers.map(c => c.name).slice().sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0)));
    r = await call({ action: "listCustomers", q: "  PAT@EXAMPLE  " }, staff);
    ok("q searches (trimmed, any case): one match, total 1", r.status === 200 && r.body.total === 1 && r.body.customers.length === 1 && r.body.customers[0].id === patId);
    r = await call({ action: "listCustomers", q: "nobody-by-this-name" }, staff);
    ok("no match is an empty list and total 0, not an error", r.status === 200 && same(r.body, { status: "ok", customers: [], total: 0, defaultDays: 30 }));
    const all = (await call({ action: "listCustomers" }, staff)).body.total;
    const junk = [];
    for (const v of [42, ["Pat"], { a: 1 }, null, true]) junk.push(await call({ action: "listCustomers", q: v }, staff));
    ok("a q that isn't text is no search (everyone), never an error", junk.every(x => x.status === 200 && x.body.total === all));
    const gone = spare("Archived Example", { archivedAt: "2026-02-01T00:00:00.000Z" });
    r = await call({ action: "listCustomers", q: "Archived Example" }, staff);
    ok("archived customers are left out", r.body.total === 0);
    r = await call({ action: "listCustomers", q: "Archived Example", includeArchived: true }, staff);
    ok("…unless includeArchived is true: then listed with archived: true", r.body.total === 1 && r.body.customers[0].id === gone && r.body.customers[0].archived === true);
    const loose = [];
    for (const v of ["true", 1, "yes", {}]) loose.push((await call({ action: "listCustomers", q: "Archived Example", includeArchived: v }, staff)).body.total);
    ok("…and only true: \"true\", 1 or anything else leaves them out", loose.join() === "0,0,0,0");

    // 230 more, to page through.
    d1._raw.run("BEGIN");
    for (let i = 0; i < 230; i++) d1._raw.run("INSERT INTO customers (name, createdAt, updatedAt) VALUES (?, 't', 't')", ["Page Example " + String(i).padStart(3, "0")]);
    d1._raw.run("COMMIT");
    const n = async (extra) => { const x = await call(Object.assign({ action: "listCustomers", q: "Page Example" }, extra), staff); return x.status === 200 ? x.body.customers.length + "/" + x.body.total + "/" + (x.body.customers[0] ? x.body.customers[0].name.slice(-3) : "-") : "error " + x.status; };
    ok("50 a page when no limit is sent, and total says how many match in all", await n({}) === "50/230/000");
    ok("limit and offset page through them (as numbers or as digits in text)", await n({ limit: 3 }) === "3/230/000" && await n({ limit: "3", offset: "2" }) === "3/230/002" && await n({ limit: 100, offset: 200 }) === "30/230/200");
    ok("an offset past the end is an empty page with the same total", await n({ offset: 230 }) === "0/230/-");
    ok("at most 200 a page, whatever is asked for", await n({ limit: 500 }) === "200/230/000" && await n({ limit: 200 }) === "200/230/000" && await n({ limit: 201 }) === "200/230/000");
    const odd = [];
    for (const v of [0, -5, 2.5, "abc", "", null, true, [], {}]) odd.push(await n({ limit: v }));
    ok("a limit that isn't a whole number above zero means 50", odd.every(x => x === "50/230/000"));
    const oddOff = [];
    for (const v of [-1, 1.5, "abc", "", null, true, {}]) oddOff.push(await n({ offset: v, limit: 2 }));
    ok("an offset that isn't a whole number from zero means the first page", oddOff.every(x => x === "2/230/000"));
    ok("a q longer than 200 characters is cut there, not refused", (await call({ action: "listCustomers", q: "Page Example 000" + " ".repeat(190) + "zzz" }, staff)).body.total === 1);
  }

  console.log("\n=== getCustomer ===");
  {
    let r = await call({ action: "getCustomer", id: patId }, staff);
    ok("answers { status, customer, orders, totals, marketing, defaultDays } (marketing: migrations/0117; defaultDays: Global settings → Net 30 terms)", r.status === 200 && keys(r.body) === "customer,defaultDays,marketing,orders,status,totals" && r.body.defaultDays === 30 && r.body.status === "ok" && r.body.marketing.optedOut === false);
    ok("the customer is id, name, company, email, phone, address, notes, the three exemption fields, Net 30 (allowNet30, termsDays), archived, createdAt and updatedAt",
      keys(r.body.customer) === "address,allowNet30,archived,company,createdAt,email,id,name,notes,phone,taxExempt,taxExemptCertificate,taxExemptExpires,termsDays,updatedAt" &&
      r.body.customer.id === patId && r.body.customer.name === "Pat Example" && r.body.customer.email === "pat@example.com" && r.body.customer.address === null &&
      r.body.customer.taxExempt === false && r.body.customer.archived === false);
    ok("each order is orderId, orgId, placedAt, total, paidAmount, balanceDue, voided, isTest and completed",
      same(r.body.orders, [{ orderId: "O-1", orgId: "acme", placedAt: "2026-03-10T15:00:00.000Z", total: 20, paidAmount: 0, balanceDue: 20, voided: false, isTest: false, completed: false }]));
    ok("the totals are orderCount, totalSpent and balanceDue", same(r.body.totals, { orderCount: 1, totalSpent: 20, balanceDue: 20 }));
    ok("the id may come as digits in text", (await call({ action: "getCustomer", id: String(patId) }, staff)).body.customer.id === patId);
    const bad = [];
    for (const v of [undefined, null, "", 0, -1, 1.5, "abc", true, [patId], { id: patId }]) bad.push(await call({ action: "getCustomer", id: v }, staff));
    ok("no id, or one that isn't a whole number above zero: 400 \"That customer isn't valid.\"", bad.every(x => refused(x, 400, NOT_VALID)));
    ok("an id nobody has: 404 \"Customer not found\"", refused(await call({ action: "getCustomer", id: 987654 }, staff), 404, NOT_FOUND));
    const mergedId = q("SELECT id, mergedIntoId FROM customers WHERE mergedIntoId IS NOT NULL")[0];
    r = await call({ action: "getCustomer", id: mergedId.id }, staff);
    ok("the id of a customer merged into another opens the one that was kept", r.status === 200 && r.body.customer.id === mergedId.mergedIntoId && r.body.customer.name === "Kept Example");
    ok("reading writes nothing to the audit log", await (async () => { const n = auditCount(); await call({ action: "getCustomer", id: patId }, staff); await call({ action: "listCustomers" }, staff); return auditCount() === n; })());
  }

  console.log("\n=== saveCustomer ===");
  let savedId;
  {
    const address = { name: "Robin Example", line1: "1 Example Road", city: "Exampleville", state: "EX", zip: "00000", country: "US" };
    let r = await logged({ action: "saveCustomer", name: "  Robin Example ", company: "Example Club", email: " Robin@Example.com ", phone: "555-0104", notes: "Calls ahead", address }, staff);
    savedId = r.body.id;
    ok("adding one answers { status, id, created: true }", r.status === 200 && keys(r.body) === "created,id,status" && r.body.status === "ok" && r.body.created === true && Number.isInteger(savedId) && savedId > 0);
    const row = custRow(savedId);
    ok("…and it is stored trimmed, the email in lower case", row.name === "Robin Example" && row.company === "Example Club" && row.email === "robin@example.com" && row.phone === "555-0104" && row.notes === "Calls ahead" &&
      same(JSON.parse(row.addressJson), address) && row.taxExempt === 0 && row.archivedAt === null && row.mergedIntoId === null);
    ok("…and logged once as customer.created with its id, name, company, email and phone, by who did it, under no shop and no order",
      r.rows.length === 1 && r.rows[0].action === "customer.created" && same(r.rows[0].detail, { customerId: savedId, name: "Robin Example", company: "Example Club", email: "robin@example.com", phone: "555-0104" }) &&
      r.rows[0].actor === "sam@example.com" && r.rows[0].orgId === null && r.rows[0].orderId === null);
    r = await logged({ action: "saveCustomer", id: "", company: "Example Supply Room" }, staff);
    ok("a company alone is enough, and an empty id means a new customer", r.status === 200 && r.body.created === true && custRow(r.body.id).company === "Example Supply Room" && custRow(r.body.id).name === "" &&
      r.rows[0].action === "customer.created" && r.rows[0].detail.company === "Example Supply Room");

    r = await logged({ action: "saveCustomer", id: savedId, name: "Robin Q. Example", company: "Example Club", email: "robin@example.com", phone: "555-0108", notes: "", address: { ...address, line1: "2 Example Road" } }, staff);
    ok("changing one answers { status, id, created: false }", r.status === 200 && same(r.body, { status: "ok", id: savedId, created: false }) && custRow(savedId).name === "Robin Q. Example" && custRow(savedId).phone === "555-0108");
    const d = r.rows[0] && r.rows[0].detail;
    ok("…and is logged once as customer.updated: the customer's id, its name now, and from/to for each field that changed",
      r.rows.length === 1 && r.rows[0].action === "customer.updated" && keys(d) === "changes,customerId,name" && d.customerId === savedId && d.name === "Robin Q. Example" &&
      same(d.changes.name, { from: "Robin Example", to: "Robin Q. Example" }) && same(d.changes.phone, { from: "555-0104", to: "555-0108" }) && same(d.changes.notes, { from: "Calls ahead", to: "" }) &&
      same(d.changes.address, { from: address, to: { ...address, line1: "2 Example Road" } }));
    ok("…with nothing for the fields that stayed (company, email) and never an exemption field", keys(d.changes) === "address,name,notes,phone" && r.rows[0].actor === "sam@example.com" && r.rows[0].orgId === null && r.rows[0].orderId === null);
    const stamp = custRow(savedId).updatedAt;
    r = await logged({ action: "saveCustomer", id: savedId, name: "Robin Q. Example", company: "Example Club", email: "robin@example.com", phone: "555-0108", notes: "", address: { ...address, line1: "2 Example Road" } }, staff);
    ok("saving it again unchanged is fine and writes no audit row", r.status === 200 && r.body.created === false && r.rows.length === 0 && custRow(savedId).updatedAt >= stamp);
    r = await logged({ action: "saveCustomer", id: String(savedId), notes: "Second door" }, staff);
    ok("a field left out keeps what it had: sending only the notes changes only the notes", r.status === 200 && custRow(savedId).name === "Robin Q. Example" && custRow(savedId).company === "Example Club" && custRow(savedId).email === "robin@example.com" &&
      custRow(savedId).phone === "555-0108" && JSON.parse(custRow(savedId).addressJson).line1 === "2 Example Road" && custRow(savedId).notes === "Second door" && keys(r.rows[0].detail.changes) === "notes");
    r = await logged({ action: "saveCustomer", id: savedId, phone: null, address: null }, staff);
    ok("a field sent as null is emptied: the phone and the address go, logged to \"\" and to null", r.status === 200 && custRow(savedId).phone === "" && custRow(savedId).addressJson === "" &&
      same(r.rows[0].detail.changes.phone, { from: "555-0108", to: "" }) && r.rows[0].detail.changes.address.to === null && r.rows[0].detail.changes.address.from.line1 === "2 Example Road");
    r = await logged({ action: "saveCustomer", id: savedId, name: null }, staff);
    ok("the name may be emptied while there is a company", r.status === 200 && custRow(savedId).name === "" && same(r.rows[0].detail.changes.name, { from: "Robin Q. Example", to: "" }) && r.rows[0].detail.name === "");
    await call({ action: "saveCustomer", id: savedId, name: "Robin Example" }, staff);

    const log = auditCount(), count = customerCount();
    const NAME = "Enter a name or a company.";
    const blank = [await call({ action: "saveCustomer" }, staff), await call({ action: "saveCustomer", name: "   ", company: "" }, staff), await call({ action: "saveCustomer", name: null, company: null, email: "new@example.com" }, staff)];
    ok("neither a name nor a company: 400 \"Enter a name or a company.\", nobody is added", blank.every(x => refused(x, 400, NAME)) && customerCount() === count);
    r = await call({ action: "saveCustomer", id: savedId, name: "", company: " " }, staff);
    ok("…and a customer can't be saved down to neither", refused(r, 400, NAME) && custRow(savedId).name === "Robin Example" && custRow(savedId).company === "Example Club");
    const badIds = [];
    for (const v of [0, -3, 1.5, "abc", true, [savedId], { id: savedId }]) badIds.push(await call({ action: "saveCustomer", id: v, name: "Wrong Example" }, staff));
    ok("an id that isn't a whole number above zero: 400 \"That customer isn't valid.\", and no customer is added in its place", badIds.every(x => refused(x, 400, NOT_VALID)) && customerCount() === count);
    ok("an id nobody has: 404 \"Customer not found\", and no customer is added in its place", refused(await call({ action: "saveCustomer", id: 987654, name: "Wrong Example" }, staff), 404, NOT_FOUND) && customerCount() === count);
    const mergedId = q("SELECT id FROM customers WHERE mergedIntoId IS NOT NULL")[0].id, mergedName = custRow(mergedId).name;
    r = await call({ action: "saveCustomer", id: mergedId, name: "Back Again" }, staff);
    ok("a customer that was merged into another: 400 saying to open that one, unchanged", refused(r, 400, MERGED) && custRow(mergedId).name === mergedName);
    const badAddr = [];
    for (const v of ["1 Example Road", 12, true, ["1 Example Road"]]) badAddr.push(await call({ action: "saveCustomer", id: savedId, address: v }, staff));
    ok("an address that isn't a set of fields: 400 \"That address isn't valid.\"", badAddr.every(x => refused(x, 400, "That address isn't valid.")) && custRow(savedId).addressJson === "");
    r = await call({ action: "saveCustomer", id: savedId, email: "not an email" }, staff);
    const r2 = await call({ action: "saveCustomer", name: "Typo Example", email: "robin@example" }, staff);
    ok("an email that isn't one: 400 \"That doesn't look like an email address.\"", refused(r, 400, "That doesn't look like an email address.") && refused(r2, 400, "That doesn't look like an email address.") && custRow(savedId).email === "robin@example.com" && customerCount() === count);
    r = await call({ action: "saveCustomer", name: "Second Robin", email: "ROBIN@example.com" }, staff);
    const r3 = await call({ action: "saveCustomer", id: savedId, email: "pat@example.com" }, staff);
    ok("an email another customer has (in any case): 400 \"Another customer already has that email.\"", refused(r, 400, "Another customer already has that email.") && refused(r3, 400, "Another customer already has that email.") && customerCount() === count && custRow(savedId).email === "robin@example.com");
    ok("none of those refusals wrote an audit row", auditCount() === log);
    r = await call({ action: "saveCustomer", id: savedId, email: "" }, staff);
    ok("the email may be emptied, and two customers may both have none", r.status === 200 && custRow(savedId).email === "" && q("SELECT count(*) n FROM customers WHERE email = ''")[0].n > 1);
    await call({ action: "saveCustomer", id: savedId, email: "robin@example.com" }, staff);
    r = await call({ action: "saveCustomer", name: "N".repeat(250), company: "C".repeat(250), phone: "5".repeat(60), notes: "x".repeat(2100) }, staff);
    const long = custRow(r.body.id);
    ok("long text is cut, not refused: name and company at 200, phone at 50, notes at 2000", r.status === 200 && long.name.length === 200 && long.company.length === 200 && long.phone.length === 50 && long.notes.length === 2000);
    r = await call({ action: "saveCustomer", name: 12345, phone: 5550106 }, staff);
    ok("a number sent for a text field is kept as its digits", r.status === 200 && custRow(r.body.id).name === "12345" && custRow(r.body.id).phone === "5550106");
    const arch = spare("Shelved Example", { archivedAt: "2026-02-01T00:00:00.000Z" });
    r = await call({ action: "saveCustomer", id: arch, phone: "555-0107" }, staff);
    ok("an archived customer can still be changed, and stays archived", r.status === 200 && custRow(arch).phone === "555-0107" && custRow(arch).archivedAt === "2026-02-01T00:00:00.000Z");
  }

  console.log("\n=== setCustomerArchived ===");
  {
    const id = spare("Seasonal Example", { company: "Example Club" });
    const log = auditCount();
    const badIds = [];
    for (const v of [undefined, null, "", 0, -1, 1.5, "abc", true]) badIds.push(await call({ action: "setCustomerArchived", id: v, archived: true }, staff));
    ok("no id, or one that isn't a whole number above zero: 400 \"That customer isn't valid.\"", badIds.every(x => refused(x, 400, NOT_VALID)));
    const SAY = "Say whether to archive the customer or restore them.";
    const notBool = [];
    for (const v of [undefined, null, "true", "false", 1, 0, "", {}]) notBool.push(await call({ action: "setCustomerArchived", id, archived: v }, staff));
    ok("archived must be true or false (not \"true\", 1, or left out): 400 \"Say whether to archive the customer or restore them.\"", notBool.every(x => refused(x, 400, SAY)) && custRow(id).archivedAt === null);
    ok("an id nobody has: 404 \"Customer not found\"", refused(await call({ action: "setCustomerArchived", id: 987654, archived: true }, staff), 404, NOT_FOUND));
    const mergedId = q("SELECT id FROM customers WHERE mergedIntoId IS NOT NULL")[0].id, was = custRow(mergedId).archivedAt;
    ok("a customer that was merged into another: 400 saying to open that one, restoring it included",
      refused(await call({ action: "setCustomerArchived", id: mergedId, archived: false }, staff), 400, MERGED) && refused(await call({ action: "setCustomerArchived", id: mergedId, archived: true }, staff), 400, MERGED) && custRow(mergedId).archivedAt === was);
    ok("none of those refusals wrote an audit row", auditCount() === log);

    let r = await logged({ action: "setCustomerArchived", id, archived: true }, staff);
    const when = custRow(id).archivedAt;
    ok("archiving answers { status: \"ok\" } and the customer is archived", r.status === 200 && same(r.body, { status: "ok" }) && typeof when === "string" && !isNaN(Date.parse(when)));
    ok("…logged once as customer.archived with the customer's id, name and company", r.rows.length === 1 && r.rows[0].action === "customer.archived" && same(r.rows[0].detail, { customerId: id, name: "Seasonal Example", company: "Example Club" }) &&
      r.rows[0].actor === "sam@example.com" && r.rows[0].orgId === null && r.rows[0].orderId === null);
    ok("…off the list, and back on it with includeArchived", (await call({ action: "listCustomers", q: "Seasonal" }, staff)).body.total === 0 && (await call({ action: "listCustomers", q: "Seasonal", includeArchived: true }, staff)).body.customers[0].archived === true &&
      (await call({ action: "getCustomer", id }, staff)).body.customer.archived === true);
    r = await logged({ action: "setCustomerArchived", id, archived: true }, staff);
    ok("archiving an archived customer is fine, keeps the date and writes no audit row", r.status === 200 && same(r.body, { status: "ok" }) && r.rows.length === 0 && custRow(id).archivedAt === when);
    r = await logged({ action: "setCustomerArchived", id: String(id), archived: false }, staff);
    ok("restoring brings the customer back, logged once as customer.restored", r.status === 200 && same(r.body, { status: "ok" }) && custRow(id).archivedAt === null && r.rows.length === 1 && r.rows[0].action === "customer.restored" &&
      same(r.rows[0].detail, { customerId: id, name: "Seasonal Example", company: "Example Club" }) && (await call({ action: "listCustomers", q: "Seasonal" }, staff)).body.total === 1);
    r = await logged({ action: "setCustomerArchived", id, archived: false }, staff);
    ok("restoring a customer that isn't archived writes no audit row", r.status === 200 && r.rows.length === 0 && custRow(id).archivedAt === null);
    ok("archiving touches none of the customer's orders", await (async () => { await call({ action: "setCustomerArchived", id: leeId, archived: true }, staff); const o = orderRow("O-3").customerId === leeId;
      await call({ action: "setCustomerArchived", id: leeId, archived: false }, staff); return o && orderRow("O-3").customerId === leeId; })());
  }

  console.log("\n=== setOrderCustomer ===");
  {
    const log = auditCount();
    const badOrders = [];
    for (const v of [undefined, null, "", 12345, "O 2", "O-2!", "x".repeat(65), ["O-2"]]) badOrders.push(await call({ action: "setOrderCustomer", orderId: v, customerId: patId }, staff));
    ok("no order number, or one that isn't an order number: 400 \"Invalid order ID\"", badOrders.every(x => refused(x, 400, "Invalid order ID")));
    const badIds = [];
    for (const v of ["abc", 0, -1, 1.5, true, false, [patId], { id: patId }]) badIds.push(await call({ action: "setOrderCustomer", orderId: "O-2", customerId: v }, staff));
    ok("a customerId that isn't a whole number above zero: 400 \"That customer isn't valid. Pick one from the list.\"", badIds.every(x => refused(x, 400, PICK)) && orderRow("O-2").customerId === null);
    ok("an order nobody placed: 404 \"Order not found\"", refused(await call({ action: "setOrderCustomer", orderId: "NO-SUCH", customerId: patId }, staff), 404, "Order not found") &&
      refused(await call({ action: "setOrderCustomer", orderId: "NO-SUCH", customerId: null }, staff), 404, "Order not found"));
    ok("a customer nobody has: 404 \"Customer not found\"", refused(await call({ action: "setOrderCustomer", orderId: "O-2", customerId: 987654 }, staff), 404, NOT_FOUND) && orderRow("O-2").customerId === null);
    const mergedId = q("SELECT id FROM customers WHERE mergedIntoId IS NOT NULL")[0].id;
    ok("a customer that was merged into another: 400 saying to open that one", refused(await call({ action: "setOrderCustomer", orderId: "O-2", customerId: mergedId }, staff), 400, MERGED) && orderRow("O-2").customerId === null);
    ok("none of those refusals wrote an audit row", auditCount() === log);

    const before = orderRow("O-2");
    let r = await logged({ action: "setOrderCustomer", orderId: "O-2", customerId: patId }, staff);
    ok("linking an order answers { status: \"ok\" } and the order is that customer's", r.status === 200 && same(r.body, { status: "ok" }) && orderRow("O-2").customerId === patId);
    ok("…logged once as order.customer_linked on the order and its shop, from no customer to this one",
      r.rows.length === 1 && r.rows[0].action === "order.customer_linked" && r.rows[0].orderId === "O-2" && r.rows[0].orgId === "acme" && same(r.rows[0].detail, { customerId: { from: null, to: patId } }) && r.rows[0].actor === "sam@example.com");
    const after = orderRow("O-2");
    ok("…and nothing else about the order changes: its name, contact, tax and total stay as placed",
      same({ ...after, customerId: null }, { ...before, customerId: null }) && after.customerName === "Walk In" && after.contact === "555-0100");
    const g = (await call({ action: "getCustomer", id: patId }, staff)).body;
    ok("the customer now has both orders, newest first", g.orders.map(o => o.orderId).join() === "O-2,O-1" && g.totals.orderCount === 2 && g.totals.totalSpent === 40);
    r = await logged({ action: "setOrderCustomer", orderId: "O-2", customerId: patId }, staff);
    ok("linking it to the customer it already has is fine and writes no audit row", r.status === 200 && r.rows.length === 0 && orderRow("O-2").customerId === patId);
    r = await logged({ action: "setOrderCustomer", orderId: "O-2", customerId: String(leeId), org: "some-other-shop" }, staff);
    ok("moving it to another customer (the id as digits in text, an org sent along) is logged from the one to the other, under the order's own shop",
      r.status === 200 && orderRow("O-2").customerId === leeId && r.rows.length === 1 && same(r.rows[0].detail, { customerId: { from: patId, to: leeId } }) && r.rows[0].orgId === "acme");
    r = await logged({ action: "setOrderCustomer", orderId: "O-2", customerId: null }, staff);
    ok("unlinking (customerId null) leaves the order with no customer, logged as to: null", r.status === 200 && same(r.body, { status: "ok" }) && orderRow("O-2").customerId === null &&
      r.rows.length === 1 && r.rows[0].action === "order.customer_linked" && same(r.rows[0].detail, { customerId: { from: leeId, to: null } }));
    r = await logged({ action: "setOrderCustomer", orderId: "O-2", customerId: null }, staff);
    ok("unlinking an order that has no customer writes no audit row", r.status === 200 && r.rows.length === 0);
    await call({ action: "setOrderCustomer", orderId: "O-2", customerId: patId }, staff);
    r = await logged({ action: "setOrderCustomer", orderId: "O-2" }, staff);
    const relink = await call({ action: "setOrderCustomer", orderId: "O-2", customerId: patId }, staff);
    const r2 = await logged({ action: "setOrderCustomer", orderId: "O-2", customerId: "" }, staff);
    ok("no customerId at all, or an empty one, unlinks too", r.status === 200 && same(r.rows[0].detail, { customerId: { from: patId, to: null } }) && relink.status === 200 && r2.status === 200 && same(r2.rows[0].detail, { customerId: { from: patId, to: null } }) && orderRow("O-2").customerId === null);
    const arch = spare("Archived Buyer Example", { archivedAt: "2026-02-01T00:00:00.000Z" });
    r = await logged({ action: "setOrderCustomer", orderId: "O-2", customerId: arch }, staff);
    ok("an archived customer can still be given an order", r.status === 200 && orderRow("O-2").customerId === arch && same(r.rows[0].detail, { customerId: { from: null, to: arch } }));
    await call({ action: "setOrderCustomer", orderId: "O-2", customerId: null }, staff);
  }

  console.log("\n=== createLocalSale: the customer picked on the form ===");
  {
    const orders = orderCount(), log = auditCount();
    const bad = [];
    for (const v of ["abc", 0, -2, 1.5, true, false, [patId], { id: patId }]) bad.push(await call(sale({ customerId: v }), staff));
    ok("a customerId that isn't a whole number above zero: 400 \"That customer isn't valid. Pick one from the list.\", no sale and no audit row", bad.every(x => refused(x, 400, PICK)) && orderCount() === orders && auditCount() === log);
    let r = await logged(sale({ customerId: patId }), staff);
    let o = orderRow(r.body.orderId);
    ok("a sale with a customer picked belongs to that customer, whatever contact was typed", r.status === 200 && r.body.status === "ok" && o && o.customerId === patId && o.customerName === "Counter Sale" && o.contact === "555-0101");
    const made = r.rows.find(x => x.action === "order.created_local_sale");
    ok("…and its audit row (order.created_local_sale) carries the customerId", !!made && made.detail.customerId === patId && made.orderId === r.body.orderId && made.orgId === "acme" && made.detail.customerName === "Counter Sale" && made.detail.total === 10);
    r = await logged(sale({ customerId: String(leeId), contact: "pat@example.com" }), staff);
    o = orderRow(r.body.orderId);
    ok("the picked customer wins over the email typed (the id as digits in text is taken as the number)", r.status === 200 && o.customerId === leeId && r.rows.find(x => x.action === "order.created_local_sale").detail.customerId === leeId);
    r = await logged(sale(), staff);
    ok("a sale without one has no customerId in its audit row, and no customer when the contact is a phone number", r.status === 200 && orderRow(r.body.orderId).customerId === null && !("customerId" in r.rows.find(x => x.action === "order.created_local_sale").detail));
    const none = [];
    for (const v of [null, ""]) { const x = await logged(sale({ customerId: v, contact: "pat@example.com" }), staff); none.push(x.status === 200 && orderRow(x.body.orderId).customerId === patId && !("customerId" in x.rows.find(y => y.action === "order.created_local_sale").detail)); }
    ok("customerId null or empty is no pick: the sale finds its customer by the email, as before", none.every(Boolean));
    r = await call(sale({ customerId: 987654 }), staff);
    ok("a well-formed id nobody has is ignored: the sale is made, with no customer", r.status === 200 && orderRow(r.body.orderId).customerId === null);
    const mergedId = q("SELECT id FROM customers WHERE mergedIntoId IS NOT NULL")[0].id;
    r = await call(sale({ customerId: mergedId }), staff);
    ok("…and so is the id of a customer merged into another", r.status === 200 && orderRow(r.body.orderId).customerId === null);
    const arch = spare("Archived Sale Example", { archivedAt: "2026-02-01T00:00:00.000Z" });
    r = await call(sale({ customerId: arch }), staff);
    ok("an archived customer can still be picked", r.status === 200 && orderRow(r.body.orderId).customerId === arch);
    r = await call(sale({ customerId: patId }), manager);
    const r2 = await call(sale({ customerId: patId }), admin);
    ok("Manager and Admin pick a customer too", r.status === 200 && orderRow(r.body.orderId).customerId === patId && r2.status === 200 && orderRow(r2.body.orderId).customerId === patId);
  }

  console.log("\n=== No period guard: a closed month doesn't stop customer changes ===");
  {
    const noMonth = [...ordersJs.match(/const NO_MONTH_ACTIONS = new Set\(\[([\s\S]*?)\]\);/)[1].matchAll(/"(\w+)"/g)].map(m => m[1]);
    ok("saveCustomer, setCustomerArchived, mergeCustomers and setOrderCustomer are on the list of actions that change no month's numbers", ["saveCustomer", "setCustomerArchived", "mergeCustomers", "setOrderCustomer"].every(a => noMonth.includes(a)));
    // Every month that could be "now" anywhere, and the month the orders were placed in.
    const now = new Date(), ym = (d) => d.toISOString().slice(0, 7);
    const months = new Set(["2026-03", ym(now), ym(new Date(now.getTime() - 3 * 86400000)), ym(new Date(now.getTime() + 3 * 86400000))]);
    for (const m of months) d1._raw.run("INSERT INTO closed_periods (month, closedAt, closedBy) VALUES (?, '2026-04-05T00:00:00Z', 'test')", [m]);
    const orders = orderCount();
    let r = await call(sale({ customerId: patId }), admin);
    ok("with this month and the orders' month closed, a local sale is refused (409, the month is closed)", r.status === 409 && /is closed/.test(r.body.message) && orderCount() === orders);
    r = await call({ action: "saveCustomer", name: "Closed Month Example" }, staff);
    const cid = r.body.id;
    ok("…but a customer is still added", r.status === 200 && r.body.created === true);
    r = await call({ action: "saveCustomer", id: cid, phone: "555-0108" }, staff);
    ok("…and changed", r.status === 200 && custRow(cid).phone === "555-0108");
    r = await call({ action: "saveCustomer", id: cid, taxExempt: true, taxExemptCertificate: "EX-0002" }, admin);
    ok("…and made tax-exempt", r.status === 200 && custRow(cid).taxExempt === 1);
    r = await call({ action: "setOrderCustomer", orderId: "O-2", customerId: cid }, staff);
    ok("…an order placed in the closed month is linked", r.status === 200 && orderRow("O-2").customerId === cid && orderRow("O-2").placedAt.slice(0, 7) === "2026-03");
    r = await call({ action: "setCustomerArchived", id: cid, archived: true }, staff);
    const r2 = await call({ action: "setCustomerArchived", id: cid, archived: false }, staff);
    ok("…the customer is archived and restored", r.status === 200 && r2.status === 200 && custRow(cid).archivedAt === null);
    r = await call({ action: "mergeCustomers", fromId: cid, intoId: patId }, manager);
    ok("…and merged, its closed-month order moving with it", r.status === 200 && r.body.moved === 1 && orderRow("O-2").customerId === patId && custRow(cid).mergedIntoId === patId);
    r = await call({ action: "setOrderCustomer", orderId: "O-2", customerId: null }, staff);
    ok("…and unlinked again", r.status === 200 && orderRow("O-2").customerId === null);
    d1._raw.run("DELETE FROM closed_periods");
  }

  console.log("\n=== Always on: no feature switch turns Customers off ===");
  {
    const t106 = read("test106_features.js");
    const always = [...t106.match(/const ALWAYS_ON = \[([\s\S]*?)\n  \];/)[1].matchAll(/"(\w+)"/g)].map(m => m[1]);
    ok("test106's always-on list has all six customer actions", always.length > 100 && SIX.every(a => always.includes(a)));
    const featureActions = [...ordersJs.match(/const FEATURE_ACTIONS = \{([\s\S]*?)\n\};/)[1].matchAll(/"(\w+)"/g)].map(m => m[1]);
    ok("none of the six is listed under a feature switch in orders.js", featureActions.length > 20 && SIX.every(a => !featureActions.includes(a)));
  }

  // ---- A harness signed in with testlib/roles.js adminAs(), on a database built from the migrations ----
  const glue = (signIn) => new Function(strip(read("functions/_lib/hostConfig.js")) + "\n" + strip(read("functions/_lib/http.js")) + "\n" + strip(read("functions/_lib/catalogValidation.js")) + "\n" +
    "const requireAdmin = async () => null; const adminActor = () => 'owner@example.test';\n" + signIn + "\n" + strip(read("functions/_lib/permissions.js")) + "\n" +
    "const rateLimited = async () => ({ blocked: false }); const rateLimitResponse = () => null;\n" +
    "const verifyQuote = async () => ({ ok: false }); const canonicalItems = () => ''; const verifyTurnstile = async () => ({ ok: true });\n" +
    "const invalidateCatalogVersionCache = () => {}; const getCatalogData = async () => ({ subdomainMap: {}, orgs: {} });\n" +
    "const sendOrderReceivedEmail = async () => false, sendPaymentConfirmedEmail = async () => false, sendCancellationEmail = async () => false, sendDesignVerificationEmail = async () => false, sendShippingPaymentEmail = async () => false, sendShippedEmail = async () => false, sendInvoiceEmail = async () => false;\n" +
    strip(read("functions/_lib/db.js")) + "\n" + strip(ordersJs) + "\nreturn onRequestPost;")();
  const migrated = async (upTo) => {
    const db = await createD1();
    db._raw.exec(read("testlib/schema-pre-0006.sql"));
    for (const f of fs.readdirSync(__dirname + "/migrations").filter(f => /^\d{4}_/.test(f) && f >= "0006" && f.slice(0, 4) <= upTo).sort()) db.execFile(read("migrations/" + f));
    db._raw.exec(`INSERT INTO orgs (orgId, subdomain, name, createdAt, updatedAt) VALUES ('acme','acme','Example Club','t','t');`);
    return db;
  };
  const caller = (api, db) => async (body) => {
    const waits = [];
    const res = await api({ env: { DB: db }, waitUntil: (p) => waits.push(p && p.then ? p.then(() => {}, () => {}) : null),
      request: { url: "https://admin.example.com/api/orders", json: async () => Object.assign({ key: "x" }, body), headers: { get: () => null } } });
    await Promise.all(waits);
    return { status: res.status, body: JSON.parse(await res.text()) };
  };

  console.log("\n=== The checks inside the actions, for each built-in role (testlib adminAs) ===");
  {
    const db = await migrated("9999");
    const as = caller(glue(roles.adminAs({ roleFrom: "globalThis.__test279Role" })), db);
    const role = (r) => { globalThis.__test279Role = r; };
    const row = (id) => db.q("SELECT * FROM customers WHERE id = " + Number(id))[0];
    role("admin");
    let r = await as({ action: "saveCustomer", name: "Morgan Example", email: "morgan@example.com" });
    const id = r.body.id;
    ok("on a database built from the migrations, an Admin adds a customer", r.status === 200 && r.body.created === true && row(id).email === "morgan@example.com");
    const tryExempt = async (who, cert) => { role(who); const x = await as({ action: "saveCustomer", id, taxExempt: true, taxExemptCertificate: cert }); return forbidden(x) ? "no" : x.status === 200 && row(id).taxExemptCertificate === cert ? "yes" : "? " + x.status; };
    ok("changing the exemption: not Production or Back office; Manager and Admin",
      [await tryExempt("production", "EX-1001"), await tryExempt("staff", "EX-1002"), await tryExempt("manager", "EX-1003"), await tryExempt("admin", "EX-1004")].join() === "no,no,yes,yes");
    const trySale = async (who) => { role(who); const n = db.q("SELECT count(*) n FROM orders")[0].n; const x = await as(sale({ customerId: id }));
      return forbidden(x) && db.q("SELECT count(*) n FROM orders")[0].n === n ? "no" : x.status === 200 && db.q("SELECT customerId FROM orders").some(o => o.customerId === id) ? "yes" : "? " + x.status; };
    ok("picking a customer for a local sale needs Customers at read: Production, Back office, Manager and Admin all have it", [await trySale("production"), await trySale("staff"), await trySale("manager"), await trySale("admin")].join() === "yes,yes,yes,yes");
    role(null);
    r = await as(sale({ customerId: id }));
    const r2 = await as({ action: "saveCustomer", id, taxExempt: false });
    const r3 = await as({ action: "setOrderCustomer", orderId: "NO-SUCH", customerId: null });
    ok("with nobody signed in, the inside checks refuse on their own: no picked customer, no exemption change, no order's customer",
      forbidden(r) && r.body.message === "Your role can't pick a customer for a sale. Ask an admin." && forbidden(r2) && row(id).taxExempt === 1 && forbidden(r3) && r3.body.message === "Your role can't change an order's customer. Ask an admin.");
    // No adminCan at all (a harness that left the sign-in out): the checks fail closed.
    const bare = caller(glue(""), db);
    r = await bare(sale({ customerId: id }));
    const b2 = await bare({ action: "saveCustomer", id, taxExempt: false });
    const b3 = await bare({ action: "setOrderCustomer", orderId: "NO-SUCH", customerId: null });
    const b4 = await bare({ action: "saveCustomer", id, phone: "555-0109" });
    ok("a harness with no permission check at all is refused the same three, never allowed by default", forbidden(r) && forbidden(b2) && forbidden(b3) && row(id).taxExempt === 1);
    ok("…while a plain change, which asks for nothing more than the gate did, still saves", b4.status === 200 && row(id).phone === "555-0109");
    role("admin");
  }

  console.log("\n=== A database that hasn't had migrations/0108 yet ===");
  {
    const db = await migrated("0104");
    ok("the database under test has no customers table and no orders.customerId", db.q("SELECT count(*) n FROM sqlite_master WHERE name = 'customers'")[0].n === 0 && !db.q("PRAGMA table_info(orders)").some(c => c.name === "customerId"));
    await lib.insertOrder(db, { orderId: "OLD-1", orgId: "acme", customerName: "Pat Example", contact: "pat@example.com", placedAt: "2026-03-10T15:00:00.000Z" }, line);
    globalThis.__test279Role = "admin";
    const old = caller(glue(roles.adminAs({ roleFrom: "globalThis.__test279Role" })), db);
    const log = db.q("SELECT count(*) n FROM audit_log")[0].n;
    const notReady = (r) => refused(r, 503, NOT_READY) && keys(r.body) === "message,status";
    ok("saveCustomer (a new one) answers 503 \"Customers aren't ready yet: the database is still being updated. Try again in a minute.\"", notReady(await old({ action: "saveCustomer", name: "Early Example", email: "early@example.com" })));
    ok("saveCustomer (a change) answers the same", notReady(await old({ action: "saveCustomer", id: 1, name: "Early Example" })));
    ok("setCustomerArchived answers the same", notReady(await old({ action: "setCustomerArchived", id: 1, archived: true })));
    ok("mergeCustomers answers the same", notReady(await old({ action: "mergeCustomers", fromId: 1, intoId: 2 })));
    ok("setOrderCustomer answers the same, linking or unlinking", notReady(await old({ action: "setOrderCustomer", orderId: "OLD-1", customerId: 1 })) && notReady(await old({ action: "setOrderCustomer", orderId: "OLD-1", customerId: null })));
    ok("none of them wrote an audit row for a change that didn't happen", db.q("SELECT count(*) n FROM audit_log")[0].n === log);
    const bad = await old({ action: "setCustomerArchived", id: 1, archived: "yes" });
    ok("what is wrong with the request itself is still said first (400), before the database is asked", refused(bad, 400, "Say whether to archive the customer or restore them.") && refused(await old({ action: "getCustomer", id: "abc" }), 400, NOT_VALID));
    const n = db.q("SELECT count(*) n FROM orders")[0].n;
    const r = await old(sale({ customerId: 3 }));
    ok("a local sale with a customer picked still goes through there, as a sale with no customer", r.status === 200 && db.q("SELECT count(*) n FROM orders")[0].n === n + 1);
    delete globalThis.__test279Role;
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
