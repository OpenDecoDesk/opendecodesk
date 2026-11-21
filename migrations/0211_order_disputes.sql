-- Each Stripe dispute an order has had, by Stripe's dispute id (dp_…), and its latest status. Stripe doesn't
-- promise the order of its events and retries a failed one for up to three days, so a late "dispute created"
-- used to put a dispute already won or lost back to "needs response" (and send the urgent notice again).
-- stripe-webhook.js now records the opening event only for a dispute not seen before and the closing one only
-- when it changes the outcome, and moves orders.disputeStatus only then (db.js setOrderDisputeStatus).
-- No foreign key to orders: an event for an order since deleted is acknowledged, not refused (Stripe would
-- retry it for days).
-- ADDITIVE ONLY: apply before deploying the code that uses it (`npm run deploy` does both).
CREATE TABLE IF NOT EXISTS order_disputes (
  disputeId TEXT PRIMARY KEY,
  orderId   TEXT NOT NULL,
  status    TEXT NOT NULL DEFAULT '',
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_disputes_order ON order_disputes(orderId);
