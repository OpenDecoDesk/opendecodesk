-- The Reconcile deposit / cash-out picker (db.js getDepositPayments) worked out, for every payment ever recorded,
-- how much of it had been cashed out and whether a bank line matched it, and only then kept the few still open.
--   order_payments.depositOpen  1 = not yet fully cashed out (payment_cashouts on transfers that aren't deleted add
--                               up to less than the amount) and no bank statement line matched to it; else 0.
-- Kept by the triggers below whenever a cash-out, a transfer's deletion, a statement match or the amount changes,
-- so the picker reads only the open ones (idx_payments_deposit_open). The picker still checks both conditions
-- itself, so a row marked open that isn't is never shown.
-- ADDITIVE: a new column (worked out here for every existing payment), triggers and an index.
ALTER TABLE order_payments ADD COLUMN depositOpen INTEGER NOT NULL DEFAULT 1 CHECK (depositOpen IN (0, 1));
UPDATE order_payments SET depositOpen = CASE WHEN COALESCE((SELECT SUM(c.amountCents) FROM payment_cashouts c JOIN account_transfers t ON t.id = c.transferId AND t.deletedAt IS NULL
    WHERE c.paymentId = order_payments.id), 0) < order_payments.amountCents
  AND NOT EXISTS (SELECT 1 FROM statement_matches m WHERE m.src = 'payment' AND m.srcId = order_payments.id) THEN 1 ELSE 0 END;
CREATE INDEX IF NOT EXISTS idx_payments_deposit_open ON order_payments(depositOpen, kind) WHERE depositOpen = 1;

CREATE TRIGGER IF NOT EXISTS payments_deposit_open_insert AFTER INSERT ON order_payments
BEGIN
  UPDATE order_payments SET depositOpen = CASE WHEN COALESCE((SELECT SUM(c.amountCents) FROM payment_cashouts c JOIN account_transfers t ON t.id = c.transferId AND t.deletedAt IS NULL
      WHERE c.paymentId = order_payments.id), 0) < order_payments.amountCents
    AND NOT EXISTS (SELECT 1 FROM statement_matches m WHERE m.src = 'payment' AND m.srcId = order_payments.id) THEN 1 ELSE 0 END WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS payments_deposit_open_amount AFTER UPDATE OF amountCents ON order_payments
BEGIN
  UPDATE order_payments SET depositOpen = CASE WHEN COALESCE((SELECT SUM(c.amountCents) FROM payment_cashouts c JOIN account_transfers t ON t.id = c.transferId AND t.deletedAt IS NULL
      WHERE c.paymentId = order_payments.id), 0) < order_payments.amountCents
    AND NOT EXISTS (SELECT 1 FROM statement_matches m WHERE m.src = 'payment' AND m.srcId = order_payments.id) THEN 1 ELSE 0 END WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS cashouts_deposit_open_insert AFTER INSERT ON payment_cashouts
BEGIN
  UPDATE order_payments SET depositOpen = CASE WHEN COALESCE((SELECT SUM(c.amountCents) FROM payment_cashouts c JOIN account_transfers t ON t.id = c.transferId AND t.deletedAt IS NULL
      WHERE c.paymentId = order_payments.id), 0) < order_payments.amountCents
    AND NOT EXISTS (SELECT 1 FROM statement_matches m WHERE m.src = 'payment' AND m.srcId = order_payments.id) THEN 1 ELSE 0 END WHERE id = NEW.paymentId;
END;
CREATE TRIGGER IF NOT EXISTS cashouts_deposit_open_update AFTER UPDATE ON payment_cashouts
BEGIN
  UPDATE order_payments SET depositOpen = CASE WHEN COALESCE((SELECT SUM(c.amountCents) FROM payment_cashouts c JOIN account_transfers t ON t.id = c.transferId AND t.deletedAt IS NULL
      WHERE c.paymentId = order_payments.id), 0) < order_payments.amountCents
    AND NOT EXISTS (SELECT 1 FROM statement_matches m WHERE m.src = 'payment' AND m.srcId = order_payments.id) THEN 1 ELSE 0 END WHERE id IN (OLD.paymentId, NEW.paymentId);
END;
CREATE TRIGGER IF NOT EXISTS cashouts_deposit_open_delete AFTER DELETE ON payment_cashouts
BEGIN
  UPDATE order_payments SET depositOpen = CASE WHEN COALESCE((SELECT SUM(c.amountCents) FROM payment_cashouts c JOIN account_transfers t ON t.id = c.transferId AND t.deletedAt IS NULL
      WHERE c.paymentId = order_payments.id), 0) < order_payments.amountCents
    AND NOT EXISTS (SELECT 1 FROM statement_matches m WHERE m.src = 'payment' AND m.srcId = order_payments.id) THEN 1 ELSE 0 END WHERE id = OLD.paymentId;
END;
CREATE TRIGGER IF NOT EXISTS transfers_deposit_open AFTER UPDATE OF deletedAt ON account_transfers
BEGIN
  UPDATE order_payments SET depositOpen = CASE WHEN COALESCE((SELECT SUM(c.amountCents) FROM payment_cashouts c JOIN account_transfers t ON t.id = c.transferId AND t.deletedAt IS NULL
      WHERE c.paymentId = order_payments.id), 0) < order_payments.amountCents
    AND NOT EXISTS (SELECT 1 FROM statement_matches m WHERE m.src = 'payment' AND m.srcId = order_payments.id) THEN 1 ELSE 0 END
  WHERE id IN (SELECT paymentId FROM payment_cashouts WHERE transferId = NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS matches_deposit_open_insert AFTER INSERT ON statement_matches WHEN NEW.src = 'payment'
BEGIN
  UPDATE order_payments SET depositOpen = 0 WHERE id = NEW.srcId;
END;
CREATE TRIGGER IF NOT EXISTS matches_deposit_open_update AFTER UPDATE ON statement_matches
BEGIN
  UPDATE order_payments SET depositOpen = CASE WHEN COALESCE((SELECT SUM(c.amountCents) FROM payment_cashouts c JOIN account_transfers t ON t.id = c.transferId AND t.deletedAt IS NULL
      WHERE c.paymentId = order_payments.id), 0) < order_payments.amountCents
    AND NOT EXISTS (SELECT 1 FROM statement_matches m WHERE m.src = 'payment' AND m.srcId = order_payments.id) THEN 1 ELSE 0 END
  WHERE (OLD.src = 'payment' AND id = OLD.srcId) OR (NEW.src = 'payment' AND id = NEW.srcId);
END;
CREATE TRIGGER IF NOT EXISTS matches_deposit_open_delete AFTER DELETE ON statement_matches WHEN OLD.src = 'payment'
BEGIN
  UPDATE order_payments SET depositOpen = CASE WHEN COALESCE((SELECT SUM(c.amountCents) FROM payment_cashouts c JOIN account_transfers t ON t.id = c.transferId AND t.deletedAt IS NULL
      WHERE c.paymentId = order_payments.id), 0) < order_payments.amountCents
    AND NOT EXISTS (SELECT 1 FROM statement_matches m WHERE m.src = 'payment' AND m.srcId = order_payments.id) THEN 1 ELSE 0 END WHERE id = OLD.srcId;
END;
