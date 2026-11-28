const fs = require("fs");
const { makeAuth, read } = require("./testlib/auth-harness");

// Money, costs and margins (costs.view) is about every screen — Products, Blanks, Orders, Pricing, audit details — but
// it was listed as a function of the Home menu item, and a hidden item or menu turns all its functions off. So hiding
// Home from a role silently took its costs away everywhere, and costs without the Home page couldn't be given at all
// (review round 2). Now costs.view belongs to no item (permissions.js EVERYWHERE_FNS): the Roles screen shows it as
// its own row, and no menu or item switch turns it off.
// Existing roles keep the level they have: a role saved before the move, with Home hidden, still has no costs (it has
// no `costsApart` mark); saving it again writes the level it has then, with the mark.
// The real permissions.js, admin-users.js and orders.js gate (testlib/auth-harness), and the Roles editor's own code
// from admin.js. Invented people only.
let pass = 0, fail = 0;
const ok = (d, c) => { console.log(d + ":", !!c); c ? pass++ : fail++; };
const P = new Function(read("functions/_lib/permissions.js").replace(/export (async function|function|const)/g, "$1") +
  "\nreturn { DEFAULT_ROLES, PERMISSION_AREAS, EVERYWHERE_FNS: typeof EVERYWHERE_FNS === \"undefined\" ? [] : EVERYWHERE_FNS, PERM_FUNCTIONS, ITEM_OF_FN, normalizePermissions, effectiveLevel, effectivePermissions, roleAllows, ACTION_PERM };")();
const forbidden = (r) => r.status === 403 && r.body && r.body.code === "forbidden";

(async () => {
  console.log("=== permissions.js ===");
  ok("costs.view is no menu item's function any more, and is one of the functions of no item, with its label",
    !P.PERMISSION_AREAS.some(m => m.items.some(it => it.fns.some(([k]) => k === "costs.view"))) && !P.ITEM_OF_FN["costs.view"] &&
    P.EVERYWHERE_FNS.some(([k, label]) => k === "costs.view" && label === "Money, costs and margins (everywhere)"));
  ok("…still on the list of functions, once", P.PERM_FUNCTIONS.filter(k => k === "costs.view").length === 1);
  const role = (permissions) => ({ key: "r_x", name: "x", rank: 10, locked: false, builtIn: false, permissions });
  const saved = (p) => role(P.normalizePermissions(p));   // as saveRole stores it and resolveRole reads it back
  ok("a role saved now with Home hidden keeps Money, costs and margins", P.effectiveLevel(saved({ items: { home: false }, fns: { "costs.view": "read", "home.counts": "read" }, costsApart: true }), "costs.view") === "read");
  ok("…and with the whole Home menu hidden", P.effectiveLevel(saved({ menus: { home: false }, fns: { "costs.view": "edit" }, costsApart: true }), "costs.view") === "edit");
  ok("…and with everything else hidden too: the cost-only actions are allowed", P.roleAllows(saved({ menus: Object.fromEntries(P.PERMISSION_AREAS.map(m => [m.key, false])), fns: { "costs.view": "read" }, costsApart: true }), P.ACTION_PERM.analyzePricing));
  ok("…hiding Home still hides Home's own counts", P.effectiveLevel(saved({ items: { home: false }, fns: { "costs.view": "read", "home.counts": "read" }, costsApart: true }), "home.counts") === "none");
  const legacyHidden = { items: { home: false }, fns: { "costs.view": "read", "home.counts": "read" } };
  ok("a role saved before the move with Home hidden still has no costs (no role gains cost access)", P.effectiveLevel(saved(legacyHidden), "costs.view") === "none" &&
    P.effectiveLevel(role(legacyHidden), "costs.view") === "none" && P.effectiveLevel(saved({ menus: { home: false }, fns: { "costs.view": "full" } }), "costs.view") === "none");
  ok("…and the Roles screen is sent the level it really has (None), so saving it again keeps None", saved(legacyHidden).permissions.fns["costs.view"] === "none" && saved(legacyHidden).permissions.costsApart === true);
  ok("a role saved before the move with Home shown keeps its level", P.effectiveLevel(saved({ fns: { "costs.view": "read", "home.counts": "read" } }), "costs.view") === "read");
  const builtIn = Object.fromEntries(Object.entries(P.DEFAULT_ROLES).map(([k, r]) => [k, P.effectivePermissions(r)["costs.view"]]));
  ok("the built-in roles keep theirs: Admin and Manager full, Back office and Production none", JSON.stringify(builtIn) === JSON.stringify({ admin: "full", manager: "full", staff: "none", production: "none" }));

  console.log("\n=== Users → Roles and permissions, and the server's gate ===");
  const A = await makeAuth();
  const admin = await A.firstAdmin();
  let r = await A.users({ action: "listRoles" }, admin);
  const homeItem = r.body.areas.flatMap(m => m.items).find(it => it.hash === "home");
  ok("listRoles sends the functions of no item as `everywhere`, and Home's item has only its counts", r.status === 200 && JSON.stringify(r.body.everywhere) === JSON.stringify(P.EVERYWHERE_FNS) &&
    homeItem.fns.map(f => f[0]).join() === "home.counts");
  // A new role as the Roles screen sends it: a copy of what listRoles sent (with the mark), Home switched off.
  const base = r.body.roles.find(x => x.key === "production").permissions;
  const perms = JSON.parse(JSON.stringify(base));
  perms.items.home = false; perms.fns["home.counts"] = "none"; perms.fns["costs.view"] = "read";
  r = await A.users({ action: "saveRole", name: "Costs without Home", rank: 20, permissions: perms }, admin);
  ok("a role with Money, costs and margins and Home hidden is saved", r.status === 200 && r.body.role.permissions.fns["costs.view"] === "read" && r.body.role.permissions.items.home === false);
  const key = r.body.role.key;
  const who = await A.addUser(admin, key, "Casey Costs", "casey@example.test");
  let me = await A.users({ action: "me" }, who);
  ok("its user has Money, costs and margins (what the menu and buttons go by)", me.body.permissions["costs.view"] === "read" && me.body.permissions["home.counts"] === "none");
  ok("…and the server lets it read costs (Price analysis)", !forbidden(await A.orders({ action: "analyzePricing" }, who)));
  // The same role as it would have been stored before the move: Home hidden, costs.view read, no mark.
  A.d1._raw.run("UPDATE roles SET permissions = ? WHERE key = ?", [JSON.stringify({ menus: {}, items: { home: false }, fns: Object.assign({}, base.fns, { "costs.view": "read" }) }), key]);
  me = await A.users({ action: "me" }, who);
  ok("a role stored before the move with Home hidden: still no costs for its user", me.body.permissions["costs.view"] === "none");
  ok("…the server refuses them", forbidden(await A.orders({ action: "analyzePricing" }, who)));
  r = await A.users({ action: "listRoles" }, admin);
  ok("…and the Roles screen shows that role's Money, costs and margins as None", r.body.roles.find(x => x.key === key).permissions.fns["costs.view"] === "none");

  console.log("\n=== The Roles editor ===");
  const adminJs = read("public/admin.js");
  const cut = (start, end) => { const i = adminJs.indexOf(start); const j = adminJs.indexOf(end, i); if (i < 0 || j < 0) throw new Error("admin.js no longer has: " + start); return adminJs.slice(i, j); };
  const panel = { innerHTML: "" };
  const levels = Object.fromEntries(P.PERM_FUNCTIONS.map(k => [k, "full"]));
  const data = { roles: [{ key: "r_1", name: "Packers", userCount: 0 }], areas: P.PERMISSION_AREAS, everywhere: P.EVERYWHERE_FNS, myRank: 100, myLevels: levels };
  const draft = { key: "r_1", name: "Packers", rank: 20, builtIn: false, locked: false, canEdit: true, userCount: 0,
    permissions: P.normalizePermissions({ fns: { "home.counts": "read", "costs.view": "read", "orders.details": "read" } }) };
  const E = new Function("adminPerms", "document", "_rolesData", "_roleDraft", "escapeHtml", "usersTabsHtml_", "ROLE_LEVELS_",
    cut("const ADMIN_LEVEL_RANK_", "function adminRoleName_") + cut("function roleFnOn_(p, fn)", "function roleSetLevel_") + "\nreturn { renderRolesTab_, roleSetItem_, roleSetMenu_ };")(
    { "settings.users": "full" }, { getElementById: (id) => id === "adminPanel" ? panel : null }, data, draft,
    (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";"), () => "", [["none", "None"], ["read", "Read"], ["edit", "Edit"], ["full", "Full"]]);
  E.renderRolesTab_();
  const html = panel.innerHTML;
  ok("Money, costs and margins is its own row, above the menus, set to the role's level", /perm-everywhere/.test(html) && /Money, costs and margins \(everywhere\)/.test(html) &&
    html.indexOf("Money, costs and margins") < html.indexOf("Order counts by step") && /name="perm-costs\.view" value="read" checked/.test(html));
  E.roleSetItem_("home", false);
  ok("switching Home off leaves Money, costs and margins as it was", draft.permissions.items.home === false && draft.permissions.fns["home.counts"] === "none" && draft.permissions.fns["costs.view"] === "read" &&
    /name="perm-costs\.view" value="read" checked/.test(panel.innerHTML));
  E.roleSetMenu_("home", false);
  ok("…and so does switching the Home menu off", draft.permissions.menus.home === false && draft.permissions.fns["costs.view"] === "read");
  ok("…and the role as saved then still has it", P.effectiveLevel(role(P.normalizePermissions(draft.permissions)), "costs.view") === "read");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log("test362 crashed:", false); console.error(e); process.exit(1); });
