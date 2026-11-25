/**
 * Users: who can sign in to the back office, and as what.
 * ========================================================================
 * POST /api/admin-users
 *   { action: "me" }                       any signed-in user, even one with a step to finish:
 *                                          → { user: { id, name, email, role, roleName }, pending, require2fa,
 *                                              permissions: {fn: level}, areas, timeZone }   (functions/_lib/permissions.js;
 *                                          timeZone: the business's — resolveTimeZone in functions/_lib/db.js)
 *   Everything else needs Users and roles (settings.users) on the caller's role — read to look, edit to change:
 *   { action: "savePrefs", prefs }         any signed-in user: their own settings (Home's hidden blocks), kept on
 *                                          the account → { prefs }. `me` returns them too.
 *   { action: "list" }                     → { users: [...], require2fa }
 *   { action: "listRoles" }                → { roles: [...], areas, myRank, myLevels }
 *   { action: "saveRole", key?, name, rank, permissions }   a new role (no key) or a change to one
 *   { action: "deleteRole", key }          a custom role nobody holds (full)
 *   { action: "create", name, email, role }→ { user, temporaryPassword }   (shown once)
 *   { action: "update", id, name, email }
 *   { action: "setRole", id, role }        role: a roles.key
 *   { action: "setStatus", id, status }    status: "active" | "disabled"
 *   { action: "resetPassword", id }        → { temporaryPassword }          (shown once)
 *   { action: "reset2fa", id }             a lost phone: they enrol again
 *   { action: "setRequire2fa", on }        the install-wide "Require two-step sign-in" switch (admins only)
 *
 * Rules kept here:
 *   - Rank (roles.rank): you only act on a user whose role ranks BELOW yours, and only give a role that
 *     ranks below yours (an admin may also make someone an admin, and change another admin: nobody
 *     ranks above an admin, and a departed admin must still be removable). You only add, change or delete a
 *     role ranked below yours, and never give it more than you have yourself. Admin is locked.
 *   - Nor, unless you are an admin, do you give a role that can do anything yours can't, or change (email, password,
 *     two-step, role, status) a user who has one: that would hand you what your own role lacks.
 *   - A user is disabled, never deleted, so the audit log and old orders keep their attribution.
 *   - There is always at least one active admin: the statement that changes a role or a status
 *     refuses to remove the last one (functions/_lib/db.js setUserRoleAndStatus).
 *   - You can't change your own role or status, or reset your own password or two-step here
 *     (that is Settings → Change password, and Security (2FA), which ask for proof it is you).
 *   - Changing someone's role or status, or resetting their password or two-step, signs them out
 *     everywhere. A disabled user can't sign in and their sessions are gone at once.
 *   - A temporary password is made here, returned once, never logged; whoever gets it must
 *     replace it at their first sign-in.
 *   - Every change is written to the audit log FIRST; no record, no change.
 */

import { classifyHost }   from "../_lib/hostConfig.js";
import { getCatalogData } from "../_lib/catalogCache.js";
import { jsonResponse }   from "../_lib/http.js";
import {
  requireAdmin, adminActor, adminUser, userHasUsablePassword, setUserPassword, generateTempPassword,
  require2fa, setRequire2fa, recoveryCodesLeft,
} from "../_lib/adminAuth.js";
import { insertAuditLog, listUsers, getUserById, getUserByEmail, insertUser, updateUser, setUserRoleAndStatus, deleteUserSessions,
  listRoles, getRoleRow, insertRole, updateRole, deleteRole, roleInUse, getUserPrefs, saveUserPrefs, resolveTimeZone } from "../_lib/db.js";
import { resolveRole } from "../_lib/adminAuth.js";
import { PERMISSION_AREAS, PERM_FUNCTIONS, DEFAULT_ROLES, normalizePermissions, effectivePermissions, effectiveLevel, permRank } from "../_lib/permissions.js";

const ROLE_NAME_MAX = 40;

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const bad = (message, status = 400) => jsonResponse({status:"error", message}, status);

export async function onRequestPost(context){
  const { request, env } = context;

  let catalogData;
  try{ catalogData = await getCatalogData(env, { waitUntil: context.waitUntil?.bind(context) }); }
  catch(e){ return jsonResponse({status:"error", message:"Catalog unavailable"}, 503); }
  const host = classifyHost(new URL(request.url).hostname, catalogData.subdomainMap, env);

  let body;
  try{ body = await request.json(); }
  catch(e){ return bad("Bad request"); }
  const action = String((body && body.action) || "");
  const self = action === "me" || action === "savePrefs";   // the caller's own: who they are, their own settings

  // "me" is everyone's; the rest is user management: Users and roles (settings.users) on the caller's
  // role — read to look, edit to change, full to delete a role. The install-wide 2FA switch is an admin's.
  const need = self ? "staff" : action === "setRequire2fa" ? "admin"
    : action === "list" || action === "listRoles" ? [["settings.users", "read"]]
    : action === "deleteRole" ? [["settings.users", "full"]] : [["settings.users", "edit"]];
  // The role saveRole / deleteRole act on: `roleKey`. `key` is the caller's credential on every request (the admin
  // page sends "cookie" when signed in with its session), so it names a role only for an older caller that sent no
  // roleKey — and never as "cookie", which made every "+ Add role" answer "No such role.".
  const roleKeyOf_ = (b) => b.roleKey !== undefined ? b.roleKey : (b.key === "cookie" ? undefined : b.key);
  const authErr = await requireAdmin(env, host, String((body && body.key) || ""), request, "Not available here.",
    need, self ? { pending: ["account", "password", "2fa"] } : undefined);
  if(authErr) return authErr;
  const me = adminUser(request);

  try{
    if(action === "savePrefs"){
      // Only the caller's own row. The installer's passphrase has no account to keep them on.
      if(me && me.pending) return bad("Finish setting up your account first.", 403);
      if(!me || me.id == null) return bad("Settings are kept on a user account — sign in with one to keep them everywhere.", 409);
      const r = await saveUserPrefs(env.DB, me.id, body.prefs);
      if(r.error) return bad(r.error);
      return jsonResponse({status:"ok", prefs: r.prefs});
    }
    if(self){
      const ri = me && me.roleInfo;
      return jsonResponse({status:"ok", user: me && me.id != null ? { id: me.id, name: me.name, email: me.email, role: me.role, roleName: ri ? ri.name : "" } : null,
        pending: (me && me.pending) || null, require2fa: await require2fa(env),
        permissions: ri ? effectivePermissions(ri) : {}, areas: PERMISSION_AREAS,
        prefs: me && me.id != null ? await getUserPrefs(env.DB, me.id) : null, timeZone: await resolveTimeZone(env)});
    }
    if(!me || me.id == null || me.bootstrap) return bad("Sign in through the admin page first.", 403);

    // ---- Rank: who may change whom ----
    const myRole = me.roleInfo, myRank = myRole ? myRole.rank : 0, iAmAdmin = !!(myRole && myRole.key === "admin");
    const roleOf = async (key) => {
      if(typeof key !== "string" || !key || key.length > 40) return null;
      let row = null;
      try{ row = await getRoleRow(env.DB, key); }catch(e){ if(!/no such table: roles/i.test(String(e && e.message))) throw e; }
      return resolveRole(key, row);
    };
    const rankOf = async (key) => { const r = await roleOf(key); return r ? r.rank : 0; };
    // A role you may give: one ranked below yours; an admin may also give admin.
    const mayGive = (r) => !!r && (r.rank < myRank || (iAmAdmin && r.key === "admin"));
    // A user you may change: their role ranks below yours. Admins are the top, with nobody above them, so an
    // admin may also change another admin — otherwise an admin who left could never be disabled.
    const mayTouch = async (u) => (await rankOf(u.role)) < myRank || (iAmAdmin && u.role === "admin");
    const RANK_MSG = "Only someone whose role ranks above theirs can change this user.";
    // Rank alone isn't enough: a role ranked below yours may still allow something yours doesn't. Giving it, or
    // resetting the sign-in of someone who has it, would hand that over, so (as with saveRole) never more than you
    // have yourself. The functions it has beyond yours; none for an admin.
    const myLevels = effectivePermissions(myRole);
    const beyondMe = (r) => iAmAdmin || !r ? [] : PERM_FUNCTIONS.filter(k => permRank(effectiveLevel(r, k)) > permRank(myLevels[k]));
    const BEYOND_MSG = (over) => "That role can do more than your own role can (" + over.slice(0, 3).join(", ") + (over.length > 3 ? ", …" : "") + "). Ask an admin.";

    const view = async (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, status: u.status, has2fa: !!u.totpSecret,
      recoveryCodesLeft: recoveryCodesLeft(u), mustChangePassword: !!u.mustChangePassword, passwordUsable: await userHasUsablePassword(env, u),
      lastLoginAt: u.lastLoginAt || null, createdAt: u.createdAt });
    const audit = async (auditAction, target, detail) => {
      try{
        await insertAuditLog(env.DB, { orgId: null, orderId: null, action: auditAction, detail, actor: adminActor(request),
          ip: request.headers.get("CF-Connecting-IP") || null, actorUserId: me.id, targetUserId: target ? target.id : null });
        return null;
      }catch(e){
        console.error("AUDIT WRITE FAILED:", auditAction, e);
        return bad("Could not record this change — try again.", 503);
      }
    };
    const who = (u) => ({ email: u.email, name: u.name });

    if(action === "list"){
      const users = [];
      for(const u of await listUsers(env.DB)) users.push(await view(u));
      return jsonResponse({status:"ok", users, require2fa: await require2fa(env), me: me.id});
    }

    if(action === "setRequire2fa"){
      const on = body.on === true;
      const auditErr = await audit("security.require_2fa_changed", null, { on });
      if(auditErr) return auditErr;
      await setRequire2fa(env, on);
      return jsonResponse({status:"ok", require2fa: on});
    }

    if(action === "create"){
      const name = typeof body.name === "string" ? body.name.trim() : "", email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      const role = String(body.role || "");
      if(!name || name.length > 80) return bad("Give the person's name (up to 80 characters).");
      if(email.length > 200 || !EMAIL_RE.test(email)) return bad("Give the email address they will sign in with.");
      const newRole = await roleOf(role);
      if(!newRole) return bad("Choose a role.");
      if(!mayGive(newRole)) return bad("You can only give a role that ranks below your own.", 403);
      { const over = beyondMe(newRole); if(over.length) return bad(BEYOND_MSG(over), 403); }
      if(await getUserByEmail(env.DB, email)) return bad("A user with that email already exists. A disabled user can be enabled again.", 409);
      const auditErr = await audit("security.user_created", null, { name, email, role });
      if(auditErr) return auditErr;
      let user;
      try{ user = await insertUser(env.DB, { name, email, role, status: "active" }); }
      catch(e){ if(/UNIQUE/i.test(String(e && e.message))) return bad("A user with that email already exists.", 409); throw e; }
      const temporaryPassword = generateTempPassword();
      await setUserPassword(env, user.id, temporaryPassword, { mustChange: true });
      const res = jsonResponse({status:"ok", user: await view(await getUserById(env.DB, user.id)), temporaryPassword});
      res.headers.set("Cache-Control", "no-store");
      return res;
    }

    // ---- Roles ----
    // withinMine: the role allows nothing beyond the caller's own, so the Users screen offers it and its users' buttons.
    const roleView = (r) => {
      const ri = resolveRole(r.key, r);
      return { key: r.key, name: r.name, rank: r.rank, builtIn: !!r.builtIn, locked: !!r.locked, userCount: r.userCount || 0,
        permissions: ri ? ri.permissions : normalizePermissions(null), canEdit: !r.locked && r.rank < myRank, withinMine: !beyondMe(ri).length };
    };
    if(action === "listRoles"){
      let rows;
      try{ rows = await listRoles(env.DB); }
      catch(e){ if(!/no such table: roles/i.test(String(e && e.message))) throw e; rows = Object.values(DEFAULT_ROLES).map(r => ({ ...r, userCount: 0 })); }
      return jsonResponse({status:"ok", roles: rows.map(r => roleView(r)), areas: PERMISSION_AREAS, myRank, myLevels, myRole: myRole ? myRole.key : ""});
    }
    if(action === "saveRole"){
      const name = typeof body.name === "string" ? body.name.trim().replace(/\s+/g, " ") : "";
      const rank = Number(body.rank);
      if(!name || name.length > ROLE_NAME_MAX) return bad("Give the role a name (up to " + ROLE_NAME_MAX + " characters).");
      if(!Number.isInteger(rank) || rank < 1 || rank > 99) return bad("Rank is a whole number from 1 to 99.");
      if(rank >= myRank) return bad("A role you set up must rank below your own (" + myRank + ").", 403);
      const permissions = normalizePermissions(body.permissions);
      // Never more than you have yourself.
      const over = PERM_FUNCTIONS.filter(k => permRank(effectiveLevel({ key: "x", permissions }, k)) > permRank(myLevels[k]));
      if(over.length) return bad("You can't give a role more than your own role has (" + over.slice(0, 3).join(", ") + (over.length > 3 ? ", …" : "") + ").", 403);
      let before = null;
      const roleKey = roleKeyOf_(body);
      if(roleKey != null){
        if(typeof roleKey !== "string" || !roleKey) return bad("No such role.", 404);
        try{ before = await getRoleRow(env.DB, roleKey); }catch(e){ return bad("Roles need the database update (migrations/0089) first.", 409); }
        if(!before) return bad("No such role.", 404);
        if(before.locked) return bad("The Admin role can't be changed.", 403);
        if(before.rank >= myRank) return bad("You can only change a role that ranks below your own.", 403);
        if(myRole && myRole.key === before.key) return bad("You can't change your own role.", 403);
      }
      const key = before ? before.key : "r_" + Array.from(crypto.getRandomValues(new Uint8Array(6)), b => b.toString(16).padStart(2, "0")).join("");
      const auditErr = await audit(before ? "security.role_changed" : "security.role_created", null,
        { key, name, rank, before: before ? { name: before.name, rank: before.rank, permissions: before.permissions } : null, permissions });
      if(auditErr) return auditErr;
      try{
        if(before){ if(!(await updateRole(env.DB, key, { name, rank, permissions }))) return bad("The Admin role can't be changed.", 403); }
        else await insertRole(env.DB, { key, name, rank, permissions });
      }catch(e){ if(/UNIQUE/i.test(String(e && e.message))) return bad("Another role already has that name.", 409); throw e; }
      const row = await getRoleRow(env.DB, key);
      return jsonResponse({status:"ok", role: roleView({ ...row, userCount: 0 })});
    }
    if(action === "deleteRole"){
      let row = null;
      const roleKey = roleKeyOf_(body);
      try{ row = typeof roleKey === "string" ? await getRoleRow(env.DB, roleKey) : null; }catch(e){ row = null; }
      if(!row) return bad("No such role.", 404);
      if(row.builtIn || row.locked) return bad("A built-in role can't be deleted.", 409);
      if(row.rank >= myRank) return bad("You can only delete a role that ranks below your own.", 403);
      const inUse = "Someone still has this role. Give them another role first (disabled users count).";
      if(await roleInUse(env.DB, row.key)) return bad(inUse, 409);
      const auditErr = await audit("security.role_deleted", null, { key: row.key, name: row.name });
      if(auditErr) return auditErr;
      if(!(await deleteRole(env.DB, row.key))) return bad(inUse, 409);   // given to someone in the meantime
      return jsonResponse({status:"ok"});
    }

    // Everything below acts on one existing user.
    const target = Number.isInteger(body.id) ? await getUserById(env.DB, body.id) : null;
    if(!target) return bad("No such user.", 404);
    const isMe = target.id === me.id;
    // Your own account is changed under Security; anyone else only when your role ranks above theirs.
    if(!isMe && !(await mayTouch(target))) return bad(RANK_MSG, 403);
    // …and never someone whose role can do more than yours: a new email or password would make their account yours.
    if(!isMe){ const over = beyondMe(await roleOf(target.role)); if(over.length) return bad("This user's role can do more than your own role can, so only an admin can change them.", 403); }

    if(action === "update"){
      const name = typeof body.name === "string" ? body.name.trim() : "", email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      if(!name || name.length > 80) return bad("Give the person's name (up to 80 characters).");
      if(email.length > 200 || !EMAIL_RE.test(email)) return bad("Give the email address they will sign in with.");
      const taken = await getUserByEmail(env.DB, email);
      if(taken && taken.id !== target.id) return bad("Another user already has that email.", 409);
      const auditErr = await audit("security.user_updated", target, { before: who(target), after: { email, name } });
      if(auditErr) return auditErr;
      try{ await updateUser(env.DB, target.id, { name, email }); }
      catch(e){ if(/UNIQUE/i.test(String(e && e.message))) return bad("Another user already has that email.", 409); throw e; }
      return jsonResponse({status:"ok", user: await view(await getUserById(env.DB, target.id))});
    }

    if(action === "setRole" || action === "setStatus"){
      const role = action === "setRole" ? String(body.role || "") : null, status = action === "setStatus" ? String(body.status || "") : null;
      const newRole = role !== null ? await roleOf(role) : null;
      if(role !== null && !newRole) return bad("Choose a role.");
      if(status !== null && status !== "active" && status !== "disabled") return bad("Choose active or disabled.");
      if(isMe) return bad("You can't change your own role or disable yourself. Someone ranked above you has to.", 409);
      if(newRole && !mayGive(newRole)) return bad("You can only give a role that ranks below your own.", 403);
      if(newRole){ const over = beyondMe(newRole); if(over.length) return bad(BEYOND_MSG(over), 403); }
      if((role !== null && role === target.role) || (status !== null && status === target.status)) return jsonResponse({status:"ok", user: await view(target)});
      const auditAction = role !== null ? "security.user_role_changed" : status === "disabled" ? "security.user_disabled" : "security.user_enabled";
      const auditErr = await audit(auditAction, target, role !== null ? { ...who(target), from: target.role, to: role } : who(target));
      if(auditErr) return auditErr;
      if(!(await setUserRoleAndStatus(env.DB, target.id, { role, status }))){
        return bad("That would leave no active admin. Make someone else an admin first.", 409);
      }
      // Whatever they could do a moment ago, they sign in again to find out what they can do now.
      await deleteUserSessions(env.DB, target.id);
      return jsonResponse({status:"ok", user: await view(await getUserById(env.DB, target.id))});
    }

    if(action === "resetPassword"){
      if(isMe) return bad("Change your own password under Settings → Change password.", 409);
      const auditErr = await audit("security.user_password_reset", target, who(target));
      if(auditErr) return auditErr;
      const temporaryPassword = generateTempPassword();
      await setUserPassword(env, target.id, temporaryPassword, { mustChange: true });
      await deleteUserSessions(env.DB, target.id);
      const res = jsonResponse({status:"ok", user: await view(await getUserById(env.DB, target.id)), temporaryPassword});
      res.headers.set("Cache-Control", "no-store");
      return res;
    }

    if(action === "reset2fa"){
      if(isMe) return bad("Switch your own two-step sign-in off under Security (2FA); it asks for a code first.", 409);
      const auditErr = await audit("security.user_2fa_reset", target, who(target));
      if(auditErr) return auditErr;
      await updateUser(env.DB, target.id, { totpSecret: null, totpLastCounter: null, recoveryCodes: null });
      await deleteUserSessions(env.DB, target.id);
      return jsonResponse({status:"ok", user: await view(await getUserById(env.DB, target.id))});
    }

    return bad("Unknown action.");
  }catch(e){
    console.error("admin-users " + action + " failed:", e);
    return bad("Could not do that — try again.", 503);
  }
}

export async function onRequestGet(){
  return jsonResponse({status:"error", message:"Use POST."}, 405);
}
