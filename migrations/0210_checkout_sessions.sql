-- The Stripe card page last opened for each order (functions/api/checkout.js). Until now every "Pay by card"
-- made a fresh Stripe Checkout Session and nothing remembered the earlier ones, so a customer with two tabs
-- open (or who went back and paid again) could pay the same order twice, and a page opened before the order
-- was voided could still be paid. Now checkout.js reuses the open page while its amount still matches the
-- balance, otherwise closes it (Stripe's "expire") before making a new one; voiding the order closes it too.
--   sessionId    the Stripe Checkout Session id (cs_…)
--   amountCents  what that page charges
--   expiresAt    when Stripe closes it by itself (checkout.js asks for one hour)
-- ADDITIVE ONLY: apply before deploying the code that uses it (`npm run deploy` does both).
CREATE TABLE IF NOT EXISTS checkout_sessions (
  orderId     TEXT PRIMARY KEY REFERENCES orders(orderId) ON DELETE CASCADE,
  sessionId   TEXT NOT NULL,
  amountCents INTEGER NOT NULL DEFAULT 0,
  createdAt   TEXT NOT NULL,
  expiresAt   TEXT NOT NULL
);
