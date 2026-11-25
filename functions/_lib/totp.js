/**
 * TOTP (RFC 6238) verification using the Web Crypto API.
 * No external dependencies — runs in Cloudflare Workers.
 */

// RFC 4648 Base32 decode. Accepts upper/lowercase, strips whitespace and padding.
function base32Decode(str){
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const s = str.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = 0, value = 0;
  const out = [];
  for(const ch of s){
    const idx = ALPHABET.indexOf(ch);
    if(idx === -1) throw new Error("Invalid Base32 character: " + ch);
    value = (value << 5) | idx;
    bits += 5;
    if(bits >= 8){ out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return new Uint8Array(out);
}

// TOTP: HMAC-SHA1, 30-second window, 6 digits.
// Accepts the current window ±1 step for clock drift.
// Returns {valid, counter} — counter is the matching 30s step value, used
// by callers to record last-used counter and prevent same-code replay.
export async function verifyTOTP(secret, code){
  if(!secret || !code) return {valid: false, counter: null};
  const cleanCode = String(code).replace(/\s/g, "");
  if(!/^\d{6}$/.test(cleanCode)) return {valid: false, counter: null};
  let keyBytes;
  try{ keyBytes = base32Decode(secret); }catch(e){ return {valid: false, counter: null}; }
  const cryptoKey = await crypto.subtle.importKey(
    "raw", keyBytes, {name: "HMAC", hash: "SHA-1"}, false, ["sign"]
  );
  const counter = Math.floor(Date.now() / 30000);
  for(const step of [counter - 1, counter, counter + 1]){
    const buf = new ArrayBuffer(8);
    new DataView(buf).setBigUint64(0, BigInt(step), false);
    const hmac = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, buf));
    const offset = hmac[19] & 0xf;
    const otp = (
      ((hmac[offset]     & 0x7f) << 24) |
      ( hmac[offset + 1]         << 16) |
      ( hmac[offset + 2]         <<  8) |
        hmac[offset + 3]
    ) % 1_000_000;
    if(otp.toString().padStart(6, "0") === cleanCode) return {valid: true, counter: step};
  }
  return {valid: false, counter: null};
}

// ---- The secret at rest -------------------------------------------------------------------------
// users.totpSecret is kept sealed, so a copy of the database alone (an export, a backup, the desktop
// program's database file) can't make codes: AES-GCM under a key derived (HKDF, label "odd-totp-v1") from
// the PROXY_ADMIN_PASSPHRASE secret, stored as "v1:" + base64(iv ‖ ciphertext). Replacing that secret
// (`npm run setup -- --new-passphrase`) makes every seal unreadable, as it voids every password: an admin
// then resets that user's two-step (Users → Reset two-step). A seal that can't be opened is never taken
// as "no two-step": openTotp throws (code "totp_unreadable") and the caller refuses with its message.
// A value without the prefix was stored before sealing: still accepted as it is, and sealed by the
// caller after the next code that matches it (totpIsSealed says which).
const TOTP_SEAL_PREFIX = "v1:";
const TOTP_UNREADABLE = "Your two-step sign-in can't be checked on this site any more (its setup password was replaced). Ask an admin to reset your two-step sign-in (Users → Reset two-step).";
export function totpIsSealed(stored){ return String(stored || "").startsWith(TOTP_SEAL_PREFIX); }
async function totpSealKey_(env){
  const pass = env && env.PROXY_ADMIN_PASSPHRASE;
  if(!pass) throw new Error("No PROXY_ADMIN_PASSPHRASE to seal the two-step secret with.");
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey("raw", enc.encode(pass), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode("odd-totp-v1") },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
export async function sealTotp(env, secret){
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await totpSealKey_(env), new TextEncoder().encode(String(secret))));
  let bin = "";
  for(const b of iv) bin += String.fromCharCode(b);
  for(const b of ct) bin += String.fromCharCode(b);
  return TOTP_SEAL_PREFIX + btoa(bin);
}
// The secret itself ("" when there is none). THROWS (e.code "totp_unreadable", e.message for the user) when
// a seal won't open: wrong key, or not a seal at all.
export async function openTotp(env, stored){
  if(!stored) return "";
  if(!totpIsSealed(stored)) return String(stored);
  try{
    const all = Uint8Array.from(atob(String(stored).slice(TOTP_SEAL_PREFIX.length)), c => c.charCodeAt(0));
    if(all.length < 13) throw new Error("too short to be a seal");
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: all.slice(0, 12) }, await totpSealKey_(env), all.slice(12));
    return new TextDecoder().decode(pt);
  }catch(e){
    throw Object.assign(new Error(TOTP_UNREADABLE), { code: "totp_unreadable" });
  }
}
