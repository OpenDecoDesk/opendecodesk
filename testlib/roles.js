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
