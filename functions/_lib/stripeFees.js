/**
 * Fills in Stripe's processing fee on card payments that were recorded without one.
 *
 * Why it's needed: the webhook records a card payment the moment Stripe reports it, but Stripe often
 * hasn't created the charge's balance transaction (which carries the fee) yet, so the fee reads as 0.
 * The webhook retries a few seconds later in the background; this is the safety net the daily
 * scheduled run uses for anything still at 0 (a retry that failed, a Stripe hiccup). Safe to repeat:
 * it only touches payments whose fee is still 0, and only for recent ones.
 *
 * Stripe refusing to answer (a revoked or rotated key, a restricted key without read access, a payment
 * this account doesn't have) is told apart from "no fee yet": it comes back in `errors`, so the
 * housekeeping (src/worker.js) reports it in the next roll-up instead of every fee quietly staying at 0.
 */

import { getRecentCardPaymentsMissingFee, setCardFeeByRef } from "./db.js";
import { fetchWithTimeout } from "./http.js";

// Stripe's own words can name part of a key ("Invalid API Key provided: sk_live_****1234"): never kept.
const scrubKeys_ = (s) => String(s || "").replace(/\b(sk|rk|pk)_[A-Za-z0-9_*]+/g, "(key)").slice(0, 160);
// The key itself was refused (401) or isn't allowed to read payments (403): every other call would fail the same way.
const keyRefused_ = (status) => status === 401 || status === 403;

// What Stripe says about one PaymentIntent's fee:
//   { fee }                             the fee in cents
//   { pending: true }                   not available yet (no balance transaction yet, Stripe busy or unreachable,
//                                       no key, not a PaymentIntent): tried again on a later run
//   { refused: true, status, message }  Stripe refused the request (an error answer): someone has to look
export async function readStripeFee(env, paymentIntentId) {
  if (!env || !env.STRIPE_SECRET_KEY || !String(paymentIntentId || "").startsWith("pi_")) return { pending: true };
  let res, pi;
  try {
    res = await fetchWithTimeout("https://api.stripe.com/v1/payment_intents/" + encodeURIComponent(paymentIntentId) +
      "?expand[]=latest_charge.balance_transaction", { headers: { Authorization: "Bearer " + env.STRIPE_SECRET_KEY } });
    pi = await res.json().catch(() => null);
  } catch (e) {
    // A network failure or a timeout says nothing about the key: the next run tries again.
    console.error("Could not read Stripe fee for", paymentIntentId, e);
    return { pending: true };
  }
  const status = Number(res && res.status) || 0;
  // Stripe busy (429) or down (5xx): like a network failure, tried again on a later run.
  if (status === 429 || status >= 500) return { pending: true };
  if ((res && res.ok === false) || (pi && pi.error)) {
    const err = (pi && pi.error) || {};
    const message = status === 401 ? "Stripe refused the secret key (401): check STRIPE_SECRET_KEY"
      : status === 403 ? "The Stripe key isn't allowed to read payments (403): a restricted key needs read access to PaymentIntents, Charges and Balance transactions"
      : `Stripe answered ${status || "with an error"} for ${paymentIntentId}: ${scrubKeys_(err.code || err.message || err.type || "no details")}`;
    return { refused: true, status, message };
  }
  const bt = pi && pi.latest_charge && pi.latest_charge.balance_transaction;
  return bt && typeof bt.fee === "number" ? { fee: bt.fee } : { pending: true };
}

// Fee in cents, or null when Stripe can't give it (not there yet, or refused).
export async function readStripeFeeCents(env, paymentIntentId) {
  const r = await readStripeFee(env, paymentIntentId);
  return typeof r.fee === "number" ? r.fee : null;
}

// { checked, filled, errors[] }: errors are Stripe's refusals, in plain words. A refused key (401/403) stops the
// run at the first one, rather than making the same failing call for every payment.
export async function fillMissingCardFees(env, { days = 14, limit = 20 } = {}) {
  if (!env || !env.DB || !env.STRIPE_SECRET_KEY) return { checked: 0, filled: 0, errors: [] };
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const missing = await getRecentCardPaymentsMissingFee(env.DB, since, limit);
  let filled = 0, checked = 0;
  const errors = [];
  for (const p of missing) {
    checked++;
    const r = await readStripeFee(env, p.externalRef);
    if (r.refused) {
      errors.push(r.message);
      if (keyRefused_(r.status)) break;
      continue;
    }
    if (r.fee > 0) filled += await setCardFeeByRef(env.DB, p.externalRef, r.fee);
  }
  return { checked, filled, errors };
}
