/**
 * Shared JSON response helpers for the API handlers.
 */
// ---- Proof that a card checkout is being started by the person who placed the order -------------
// An order number alone used to be enough to open Stripe Checkout for that order — and Stripe's page
// shows the customer's name and email. Placing an order now returns a token for THAT order (HMAC over
// the order id and an expiry), and /api/checkout asks for it (or for the order's own invoice link).
// Signed with the install's signing secret, under its own label.
// An install that started under another name (a copy of this code made before it was OpenDecoDesk) signed its
// passwords, sessions and links with labels starting with that name instead of "odd". LEGACY_LABEL_PREFIX (a plain
// variable, e.g. "myshop") makes the checks accept those too, so moving such an install over doesn't void everyone's
// password or the links already sent. New marks, tokens and cookies always use the odd- labels. Kept identical in
// adminAuth.js, quoteToken.js, http.js and db.js (test177 checks): the tests paste these files together.
function legacyLabels_(env, label) {
  const p = String((env && env.LEGACY_LABEL_PREFIX) || "").trim().toLowerCase();
  return /^[a-z][a-z0-9]{0,19}$/.test(p) && p !== "odd" && label.includes("odd") ? [label, label.replace("odd", p)] : [label];
}

const ORDER_TOKEN_TTL_SECONDS = 24 * 60 * 60;
function orderTokenSecret_(env){
  return (env && (env.SIGNING_SECRET || env.QUOTE_SIGNING_SECRET)) || "";
}
async function orderTokenMac_(secret, data, label = "odd-order-pay-v1:"){
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(label + secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return Array.from(new Uint8Array(sig), b => b.toString(16).padStart(2, "0")).join("");
}
// (Both return a promise. Written as plain functions, like everything else exported from this file.)
export function signOrderToken(env, orderId){
  const secret = orderTokenSecret_(env);
  if(!secret || !orderId) return Promise.resolve(null);
  const exp = Math.floor(Date.now() / 1000) + ORDER_TOKEN_TTL_SECONDS;
  return orderTokenMac_(secret, String(orderId) + "|" + exp).then(mac => exp + "." + mac);
}
export function verifyOrderToken(env, orderId, token){
  const secret = orderTokenSecret_(env);
  const m = /^(\d{9,12})\.([0-9a-f]{64})$/.exec(typeof token === "string" ? token : "");
  if(!secret || !orderId || !m) return Promise.resolve(false);
  if(Number(m[1]) < Math.floor(Date.now() / 1000)) return Promise.resolve(false);
  return Promise.all(legacyLabels_(env, "odd-order-pay-v1:").map(label => orderTokenMac_(secret, String(orderId) + "|" + m[1], label)))
    .then(macs => macs.some(expected => {
      let diff = 0;
      for(let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ m[2].charCodeAt(i);
      return diff === 0;
    }));
}

// ---- A paid order's download link (digital products, migrations/0086) ------------------------------
// /api/download?o=<orderId>&t=<token>: the token is an HMAC of the order id and the order's own random salt
// (orders.downloadSalt) under the install's signing secret, so it can be made again whenever it's needed and
// nothing that opens it is stored; a new salt (Resend link) retires the old link. "" without a secret or salt.
export function downloadToken(env, orderId, salt){
  const secret = orderTokenSecret_(env);
  if(!secret || !orderId || !salt) return Promise.resolve("");
  return orderTokenMac_(secret, String(orderId) + "|" + String(salt), "odd-download-v1:");
}
export function verifyDownloadToken(env, orderId, salt, token){
  if(typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) return Promise.resolve(false);
  return downloadToken(env, orderId, salt).then(expected => {
    if(!expected) return false;
    let diff = 0;
    for(let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
    return diff === 0;
  });
}

export function jsonResponse(obj, status){
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json" }
  });
}

// ---- Outbound requests with a time limit --------------------------------------------------------
// A service that takes the connection and never answers (Stripe, Shippo, the email provider, Turnstile)
// would otherwise hold the request — and the customer or admin waiting on it — until the runtime gives up.
// After `ms` (default fetchWithTimeout.defaultMs, 10 seconds; the tests lower it) the fetch is aborted and the
// promise rejects with a TimeoutError whose message reads "No answer within 10 seconds.", which each caller's
// catch turns into its usual "couldn't reach …" answer. The limit covers the answer arriving, not the reading
// of its body. Without AbortSignal.timeout (an old runtime) the fetch goes without a limit, as before.
export function fetchWithTimeout(url, init, ms){
  const limit = Number(ms) > 0 ? Number(ms) : (Number(fetchWithTimeout.defaultMs) || 10000);
  if(typeof AbortSignal === "undefined" || typeof AbortSignal.timeout !== "function") return fetch(url, init);
  const signal = AbortSignal.timeout(limit);
  return new Promise((resolve, reject) => {
    // Rejected here as well as by fetch itself, so a fetch that ignores its signal can't hang the caller.
    const onAbort = () => reject(Object.assign(new Error("No answer within " + (limit >= 1000 ? Math.round(limit / 1000) + " seconds." : limit + " ms.")), { name: "TimeoutError" }));
    signal.addEventListener("abort", onAbort, { once: true });
    fetch(url, { ...(init || {}), signal }).then(resolve, (e) => (signal.aborted ? onAbort() : reject(e)))
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

// ---- Features (Global settings → Features; db.js FEATURES) --------------------------------------
// The answer every handler gives for something that belongs to a switched-off feature.
export function featureOffResponse(key, label){
  return jsonResponse({ status: "error", feature: key,
    message: `${label || key} is turned off. Turn it on under Settings → Global settings → Features.` }, 403);
}
// For handlers that don't already hold the cached catalog: is this feature switched off? One small
// read. Anything unexpected (no database, nothing saved, a read error) counts as ON — the default.
// (A plain function returning a promise: some test harnesses only strip "export function".)
export function featureIsOff(env, key){
  return (async () => {
    try{
      const row = await env.DB.prepare("SELECT value FROM global_settings WHERE key='features'").first();
      return !!row && JSON.parse(row.value)[key] === false;
    }catch(e){ return false; }
  })();
}
