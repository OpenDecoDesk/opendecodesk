-- An account's register and reconciliation (db.js getAccountRegister, getReconciliationData, listMoneyMoves) read
-- one account's money movements between two dates from each source in MONEY_MOVE_SOURCES. None of those tables
-- had an index on the account, so every view read every movement of every account. These index each source by
-- account and by the day the source is dated on (the same expression MONEY_MOVE_SOURCES uses, so it can be used).
-- ADDITIVE ONLY.
CREATE INDEX IF NOT EXISTS idx_payments_account_day     ON order_payments(accountId, substr(receivedAt, 1, 10));
CREATE INDEX IF NOT EXISTS idx_expenses_account_date    ON expenses(accountId, expenseDate);
CREATE INDEX IF NOT EXISTS idx_movements_account_day    ON inventory_movements(accountId, substr(occurredAt, 1, 10)) WHERE kind = 'purchase';
CREATE INDEX IF NOT EXISTS idx_transfer_movements_account_day ON transfer_movements(accountId, substr(occurredAt, 1, 10)) WHERE kind = 'purchase';
CREATE INDEX IF NOT EXISTS idx_labels_account_day       ON shipping_labels(accountId, substr(purchasedAt, 1, 10));
CREATE INDEX IF NOT EXISTS idx_other_income_account     ON other_income(accountId, incomeDate);
CREATE INDEX IF NOT EXISTS idx_owner_tx_account         ON owner_transactions(accountId, txDate);
CREATE INDEX IF NOT EXISTS idx_transfers_from_account   ON account_transfers(fromAccountId, transferDate);
CREATE INDEX IF NOT EXISTS idx_transfers_to_account     ON account_transfers(toAccountId, transferDate);
