// RFC 6238 time-based one-time codes (HMAC-SHA1, 30-second steps, 6 digits) with node's crypto — what an
// authenticator app on a phone computes from the setup key the Security (2FA) page shows.
import crypto from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Decode(text) {
  const s = String(text).toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = 0, value = 0;
  const out = [];
  for (const ch of s) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error("Not a base32 setup key");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

export const STEP_SECONDS = 30;
export const currentStep = (now = Date.now()) => Math.floor(now / 1000 / STEP_SECONDS);

// The code for one 30-second step (RFC 4226 HOTP over the step number).
export function totpAt(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0xf;
  const n = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(n % 1_000_000).padStart(6, "0");
}

export const totpNow = (secret) => totpAt(secret, currentStep());

// The server accepts the step before, the current one and the next, and never the same step twice for one
// user (a code can't be replayed). This hands out a step later than `lastStep`, waiting for the clock only
// when even the next step has already been used. Returns { code, step }.
export async function freshTotp(secret, lastStep = -1) {
  for (;;) {
    const now = currentStep();
    const step = Math.max(now, lastStep + 1);
    if (step <= now + 1) return { code: totpAt(secret, step), step };
    await new Promise(r => setTimeout(r, 1000));
  }
}

// RFC 6238 appendix B test vector (SHA-1, T = 59 s → 94287082, last six digits 287082), so a broken helper fails loudly.
if (totpAt("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 1) !== "287082") throw new Error("TOTP helper does not match RFC 6238");
