-- One key per "Save" in the admin's payment forms (Record payment, Record refund, Mark as paid, a cancelled
-- line's refund), so a double click, a retried request on a bad connection or a second tab can't put the same
-- money in the books twice. Manual entries have no external reference (externalRef is '' and only non-empty
-- ones are unique), so nothing stopped the repeat before. NULL for every existing row and for Stripe's rows.
-- ADDITIVE ONLY: apply before deploying the code that uses it (`npm run deploy` does both).
ALTER TABLE order_payments ADD COLUMN requestKey TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_request_key ON order_payments(requestKey) WHERE requestKey IS NOT NULL;
