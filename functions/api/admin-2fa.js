/**
 * Your own two-step sign-in (an authenticator app, and recovery codes).
 * ========================================================================
 * POST /api/admin-2fa   (any signed-in user; this is the route a session that is pending "2fa"
 *                        may still use — functions/_lib/adminAuth.js)
 *   Body: { action: "status" | "generate" | "activate" | "disable" | "newRecoveryCodes", ... }
 *
 * Each user has their own secret (users.totpSecret).
 *   status   — { enabled, required, recoveryCodesLeft }. `required`: the install requires
 *              two-step sign-in (Users → Require two-step sign-in).
 *   generate — returns { secret, proof, otpauthUri } for a new random secret (NOT saved); the
 *              client must verify with "activate" before it takes effect. `proof` says this
 *              server made that secret for this user, and is good for 15 minutes (http.js
 *              signTwoStepProof).
 *   activate — { proposedSecret, proof, current, code }: takes only a secret "generate" issued
 *              (its proof, and the full length), asks for the user's password again (`current`,
 *              within the budgets "change password" keeps — adminAuth.js checkCurrentPassword),
 *              verifies the code against the secret, saves it, and — when the user has no
 *              recovery codes — makes ten and returns them ONCE ({ recoveryCodes }). Without the
 *              password, someone at a signed-in computer left alone could enrol their own phone
 *              and lock the user out; without the proof, a "required" two-step could be met with
 *              a secret anyone knows. The one session that isn't asked for the password is the
 *              one pending "2fa": it exists only because the password was just typed, and can do
 *              nothing else. Refused while two-step is already on: otherwise a hijacked session
 *              could swap in its own secret and lock the user out. To change devices, disable
 *              first (which needs a code), then set up.
 *   disable  — { code }: a code from the authenticator (or a recovery code), then removes the
 *              secret and the recovery codes. Refused while two-step is required.
 *   newRecoveryCodes — { code }: replaces the recovery codes and returns the new ones once.
 * A lost phone with no recovery code left is an admin's job: Users → Reset two-step.
 *
 * Every change is written to the audit log FIRST (security.2fa_enabled, security.2fa_disabled,
 * security.recovery_codes_made, with who and from where) and refused if that write fails.
 */

import { classifyHost }         from "../_lib/hostConfig.js";
import { getCatalogData }       from "../_lib/catalogCache.js";
import { jsonResponse, signTwoStepProof, verifyTwoStepProof } from "../_lib/http.js";
import {
  requireAdmin, adminActor, adminUser, require2fa, refreshPending, generateRecoveryCodes, saveRecoveryCodes, recoveryCodesLeft,
  looksLikeRecoveryCode, spendRecoveryCode, checkCurrentPassword,
} from "../_lib/adminAuth.js";
import { insertAuditLog, getUserById, updateUser, claimUserTotpCounter, deleteUserSessions } from "../_lib/db.js";
import { rateLimitCheck, rateLimitHit, rateLimitResponse } from "../_lib/rateLimit.js";

// Wrong codes typed here (turning two-step on or off, new recovery codes) per address per minute. A
// signed-in session is needed to get this far, but the code is what stands between a borrowed session
// and switching two-step off, so it can't be guessed at speed.
const CODE_BUCKET = "admin_2fa_code";
const CODE_LIMIT = 5;
import { verifyTOTP, sealTotp, openTotp, totpIsSealed } from "../_lib/totp.js";

function generateBase32Secret(){
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bytes = new Uint8Array(20); // 160-bit key — standard TOTP length
  crypto.getRandomValues(bytes);
  let bits = 0, value = 0, out = "";
  for(const byte of bytes){
    value = (value << 8) | byte;
    bits += 8;
    while(bits >= 5){ out += ALPHABET[(value >>> (bits - 5)) & 0x1f]; bits -= 5; }
  }
  if(bits > 0) out += ALPHABET[(value << (5 - bits)) & 0x1f];
  return out;
}
// What generateBase32Secret makes: 20 bytes, so 32 characters. "activate" takes nothing shorter or longer.
const NEW_SECRET_SHAPE = /^[A-Z2-7]{32}$/;

// `issuer` is what the authenticator app shows: the business name (Global settings → Business profile).
function buildOtpauthUri(secret, businessName, email){
  const label  = encodeURIComponent(email || "Admin");
  const issuer = encodeURIComponent(businessName || "OpenDecoDesk");
  return `otpauth://totp/${label}?secret=${encodeURIComponent(secret)}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
}

export async function onRequestPost(context){
  const { request, env } = context;

  let catalogData;
  try{ catalogData = await getCatalogData(env, { waitUntil: context.waitUntil?.bind(context) }); }
  catch(e){ return jsonResponse({status:"error", message:"Catalog unavailable"}, 503); }

  const url  = new URL(request.url);
  const host = classifyHost(url.hostname, catalogData.subdomainMap, env);

  let body;
  try{ body = await request.json(); }
  catch(e){ return jsonResponse({status:"error", message:"Bad request"}, 400); }

  const key    = String(body.key    || "");
  const action = String(body.action || "");

  const authErr = await requireAdmin(env, host, key, request, "Not available here.", "staff", { pending: ["2fa"] });
  if(authErr) return authErr;
  const me = adminUser(request);
  if(!me || me.id == null || me.bootstrap) return jsonResponse({status:"error", message:"Sign in through the admin page first."}, 403);

  const storage = () => jsonResponse({status:"error", message:"Storage unavailable — try again."}, 503);
  let user, required;
  try{ user = await getUserById(env.DB, me.id); required = await require2fa(env); }
  catch(e){ return storage(); }
  if(!user) return jsonResponse({status:"error", message:"Session expired — please log in again."}, 401);

  // Security changes are recorded before they happen; no record, no change.
  const auditFirst = async (auditAction) => {
    try{
      await insertAuditLog(env.DB, { orgId: null, orderId: null, action: auditAction, detail: {},
        actor: adminActor(request), ip: request.headers.get("CF-Connecting-IP") || null, actorUserId: user.id, targetUserId: user.id });
      return null;
    }catch(e){
      console.error("AUDIT WRITE FAILED:", auditAction, e);
      return jsonResponse({status:"error", message:"Could not record this change — try again."}, 503);
    }
  };
  // A wrong code counts against this address's budget; past it, codes aren't even checked.
  const codeBudget = async () => { const rl = await rateLimitCheck(env, CODE_BUCKET, request, CODE_LIMIT); return rl.blocked ? rateLimitResponse(rl.retryAfter) : null; };
  const wrongCode = async (message) => { await rateLimitHit(env, CODE_BUCKET, request); return jsonResponse({status:"error", message}, 400); };
  // A code that proves the user still has their second factor: from the app, or a recovery code
  // (which is spent). Returns a Response when it isn't one. An app code is claimed like a sign-in's,
  // so a code already used (to sign in, say) can't be used again here.
  const proveSecondFactor = async (code) => {
    const limited = await codeBudget(); if(limited) return limited;
    if(looksLikeRecoveryCode(code)){
      if(await spendRecoveryCode(env, user, code)){ user = await getUserById(env.DB, user.id); return null; }
      return wrongCode("That recovery code is not right, or was already used.");
    }
    // The secret is kept sealed (totp.js sealTotp). One that won't open is refused, never taken as "no two-step".
    let secret;
    try{ secret = await openTotp(env, user.totpSecret); }
    catch(e){ if(e && e.code === "totp_unreadable") return jsonResponse({status:"error", code:"totp_unreadable", message: e.message}, 409); throw e; }
    const result = await verifyTOTP(secret, code);
    if(!result.valid) return wrongCode("Invalid code — check your device and try again.");
    if(!(await claimUserTotpCounter(env.DB, user.id, result.counter))){
      return jsonResponse({status:"error", message:"That code was already used — wait for the next one from your authenticator app."}, 400);
    }
    // A secret stored before sealing is sealed now that a code has matched it.
    if(!totpIsSealed(user.totpSecret)) await updateUser(env.DB, user.id, { totpSecret: await sealTotp(env, secret) });
    return null;
  };
  // Turning two-step on or off ends this user's OTHER sessions (this one stays signed in).
  const endOtherSessions = () => deleteUserSessions(env.DB, user.id, me.tokenHash || "");
  const makeRecoveryCodes = async () => {
    const codes = generateRecoveryCodes();
    await saveRecoveryCodes(env, user.id, codes);
    return codes;
  };

  if(action === "status"){
    return jsonResponse({status:"ok", enabled: !!user.totpSecret, required, recoveryCodesLeft: recoveryCodesLeft(user)});
  }

  if(action === "generate"){
    const secret      = generateBase32Secret();
    // …with the proof "activate" will ask for (signed for this user, 15 minutes).
    const proof       = await signTwoStepProof(env, user.id, secret);
    if(!proof) return jsonResponse({status:"error", message:"Two-step sign-in can't be set up yet: this site has no signing secret (SIGNING_SECRET). Run `npm run setup`, then try again."}, 503);
    const otpauthUri  = buildOtpauthUri(secret, catalogData.business && catalogData.business.name, user.email);
    const res = jsonResponse({status:"ok", secret, proof, otpauthUri});
    res.headers.set("Cache-Control", "no-store");
    return res;
  }

  if(action === "activate"){
    const proposedSecret = String(body.proposedSecret || "");
    const code           = String(body.code           || "");
    if(!proposedSecret) return jsonResponse({status:"error", message:"No secret provided."}, 400);
    if(user.totpSecret){
      return jsonResponse({status:"error", message:"Two-factor authentication is already on. To move it to a new device, disable it first with a code from your current app, then set it up again."}, 409);
    }
    // Only a secret this server made for this user in the last 15 minutes, whole: never one the browser chose.
    let issuedHere = false;
    try{ issuedHere = NEW_SECRET_SHAPE.test(proposedSecret) && await verifyTwoStepProof(env, user.id, proposedSecret, body.proof); }
    catch(e){ issuedHere = false; }
    if(!issuedHere){
      return jsonResponse({status:"error", code:"setup_key_expired", message:"That setup key isn't one this site just made for you, or it is more than 15 minutes old. Click \"Set up 2FA\" again for a new key."}, 400);
    }
    // The password again, as changing it asks — except in the step owed at sign-in (pending "2fa"), where it
    // was typed a moment ago and the session can do nothing but this.
    if(me.pending !== "2fa"){
      const current = typeof body.current === "string" ? body.current : "";
      if(!current) return jsonResponse({status:"error", code:"password_required", message:"Enter your current password to turn two-step sign-in on."}, 400);
      const refused = await checkCurrentPassword(env, request, user, current);
      if(refused) return refused;
    }
    const limited = await codeBudget(); if(limited) return limited;
    const result = await verifyTOTP(proposedSecret, code);
    if(!result.valid) return wrongCode("Invalid code — check your device and try again.");
    const auditErr = await auditFirst("security.2fa_enabled");
    if(auditErr) return auditErr;
    let recoveryCodes = null, pending = null;
    try{
      // Stored sealed (totp.js sealTotp): a copy of the database alone can't make codes.
      await updateUser(env.DB, user.id, { totpSecret: await sealTotp(env, proposedSecret), totpLastCounter: null });
      // Record counter so the setup code can't be immediately replayed.
      if(result.counter !== null) await claimUserTotpCounter(env.DB, user.id, result.counter);
      if(!recoveryCodesLeft(user)) recoveryCodes = await makeRecoveryCodes();
      await endOtherSessions();
      pending = await refreshPending(env, request, await getUserById(env.DB, user.id));
    }catch(e){
      console.error("admin-2fa activate storage error:", e);
      return jsonResponse({status:"error", message:"Storage error — try again."}, 503);
    }
    const res = jsonResponse({status:"ok", message:"Two-factor authentication enabled.", recoveryCodes, pending});
    res.headers.set("Cache-Control", "no-store");
    return res;
  }

  if(action === "disable" || action === "newRecoveryCodes"){
    if(!user.totpSecret) return jsonResponse({status:"error", message:"Two-factor authentication is not currently enabled."}, 400);
    if(action === "disable" && required){
      return jsonResponse({status:"error", message:"Two-step sign-in is required here, so it can't be switched off. To move it to a new phone, ask an admin to reset it."}, 409);
    }
    let bad;
    try{ bad = await proveSecondFactor(String(body.code || "")); }
    catch(e){ return storage(); }
    if(bad) return bad;
    const auditErr = await auditFirst(action === "disable" ? "security.2fa_disabled" : "security.recovery_codes_made");
    if(auditErr) return auditErr;
    try{
      if(action === "disable"){
        await updateUser(env.DB, user.id, { totpSecret: null, totpLastCounter: null, recoveryCodes: null });
        await endOtherSessions();
        return jsonResponse({status:"ok", message:"Two-factor authentication disabled."});
      }
      const res = jsonResponse({status:"ok", recoveryCodes: await makeRecoveryCodes()});
      res.headers.set("Cache-Control", "no-store");
      return res;
    }catch(e){
      console.error("admin-2fa " + action + " storage error:", e);
      return jsonResponse({status:"error", message:"Storage error — try again."}, 503);
    }
  }

  return jsonResponse({status:"error", message:"Unknown action."}, 400);
}
