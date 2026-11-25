// The built-in roles (functions/_lib/permissions.js), for tests that ask whose an action is.
//   const { may, lowest } = require("./testlib/roles");
//   may("staff", "addPayment")  → true      lowest("getAuditLog") → "admin"
// Roles, lowest first: production, staff ("Back office"), manager, admin.
const fs = require("fs");
const P = new Function(fs.readFileSync(__dirname + "/../functions/_lib/permissions.js", "utf8").replace(/export (async function|function|const)/g, "$1") +
  "\nreturn { ACTION_PERM, DEFAULT_ROLES, roleAllows, effectivePermissions, PERMISSION_AREAS, PERM_FUNCTIONS };")();
const may = (role, action) => P.roleAllows(P.DEFAULT_ROLES[role] || null, P.ACTION_PERM[action]);
const lowest = (action) => ["production", "staff", "manager"].find(r => may(r, action)) || "admin";
module.exports = Object.assign({}, P, { may, lowest });

// The lowest built-in role whose menu has a page (by its hash, as the admin page reads it: the first part).
const pageLowest = (hash) => {
  const item = String(hash || "").replace(/^#\/?/, "").split("/")[0];
  const it = P.PERMISSION_AREAS.flatMap(m => m.items).find(x => x.hash === item);
  if (!it) return "production";
  const lvl = (role, fn) => P.effectivePermissions(P.DEFAULT_ROLES[role])[fn];
  return ["production", "staff", "manager"].find(r => it.fns.some(([fn]) => lvl(r, fn) !== "none")) || "admin";
};
// Code to eval in the admin page (jsdom) to sign it in as a built-in role: who, and what the role may do —
// what /api/admin-users "me" gives the page. asRole(null) is signed out / not known yet.
const asRole = (role, extra) => role == null ? "adminMe = null; adminPerms = null; adminAreas = null;"
  : `adminMe = ${JSON.stringify(Object.assign({ role }, extra || {}))}; adminPerms = ${JSON.stringify(P.effectivePermissions(P.DEFAULT_ROLES[role]))}; adminAreas = ${JSON.stringify(P.PERMISSION_AREAS)};`;
module.exports.pageLowest = pageLowest;
module.exports.asRole = asRole;

// Code for a harness that glues functions/api/*.js into one scope WITHOUT adminAuth.js: who is signed in
// (adminUser) and the permission check (adminLevel, adminCan), answering as adminAuth.js does after requireAdmin
// for a built-in role (resolveRole's defaults, permissions.js effectiveLevel). The access checks in orders.js
// fail closed when adminCan is missing, so a harness declares these in place of its own adminUser:
//   "const requireAdmin = async () => null; const adminActor = () => 'test';\n" + adminAs() + "\n" + …
// adminAs() is the admin; adminAs("staff") Back office; adminAs({ roleFrom: "globalThis.__role" }) reads the role
// key on every call (null, "" or an unknown key: nobody signed in — adminUser null and every adminCan false).
const adminAs = (role = "admin") => {
  const roles = {}, levels = {};
  for (const k of Object.keys(P.DEFAULT_ROLES)) { roles[k] = P.DEFAULT_ROLES[k]; levels[k] = P.effectivePermissions(P.DEFAULT_ROLES[k]); }
  const key = role && typeof role === "object" && role.roleFrom ? "(" + role.roleFrom + ")" : JSON.stringify(role);
  return `const { adminUser, adminLevel, adminCan } = (() => {
  const ROLES = ${JSON.stringify(roles)}, LEVELS = ${JSON.stringify(levels)};
  const rank = (l) => l === "full" ? 3 : l === "edit" ? 2 : l === "read" ? 1 : 0;
  const adminUser = (request) => { const k = ${key}; const r = typeof k === "string" && Object.prototype.hasOwnProperty.call(ROLES, k) ? ROLES[k] : null;
    return r ? { id: 1, email: k + "@example.test", name: r.name, role: k, roleInfo: r, pending: null, bootstrap: false } : null; };
  const adminLevel = (request, fn) => { const u = adminUser(request); if (!u) return "none";
    return u.roleInfo.locked && u.roleInfo.key === "admin" ? "full" : (LEVELS[u.role][fn] || "none"); };
  const adminCan = (request, fn, level) => rank(adminLevel(request, fn)) >= rank(level || "read");
  return { adminUser, adminLevel, adminCan };
})();`;
};
module.exports.adminAs = adminAs;
