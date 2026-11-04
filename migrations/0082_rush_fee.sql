-- Rush fees (2026-11): a customer can ask for an order to be rushed, for a fee the shop sets — a fixed amount, a % of
-- the merchandise, the greater of the two, or "to follow" (worked out afterwards, e.g. expedited shipping). The rule is
-- a global setting (global_settings key 'rushFee', no column) that each shop can follow, turn off or replace:
--   orgs.rushFeeJson         '' = the global rule; else {"offer":false} or {"offer":true, …its own rule}.
--   orders.rushRequested     the order was asked to be rushed.
--   orders.rushFeeCents      the fee on the order (0 while it's still to follow).
--   orders.rushFeePending    the fee is still to follow — the shop sets it on the order.
--   orders.rushFeeTaxable    whether the fee carries sales tax (the global setting when the order was placed).
--   orders.rushFeeTaxCents   the tax on the fee (inside it, or on top with taxMode "exclusive"), by recomputeOrderTax_.
--   orders.paidForWork       cached like `paid`, but leaving the rush fee out: an unpaid rush fee doesn't hold up
--                            production. Backfilled from `paid` (no order has a rush fee yet). ADDITIVE.
ALTER TABLE orgs ADD COLUMN rushFeeJson TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN rushRequested INTEGER NOT NULL DEFAULT 0 CHECK (rushRequested IN (0, 1));
ALTER TABLE orders ADD COLUMN rushFeeCents INTEGER NOT NULL DEFAULT 0 CHECK (rushFeeCents >= 0);
ALTER TABLE orders ADD COLUMN rushFeePending INTEGER NOT NULL DEFAULT 0 CHECK (rushFeePending IN (0, 1));
ALTER TABLE orders ADD COLUMN rushFeeTaxable INTEGER NOT NULL DEFAULT 0 CHECK (rushFeeTaxable IN (0, 1));
ALTER TABLE orders ADD COLUMN rushFeeTaxCents INTEGER NOT NULL DEFAULT 0 CHECK (rushFeeTaxCents >= 0);
ALTER TABLE orders ADD COLUMN paidForWork INTEGER NOT NULL DEFAULT 0 CHECK (paidForWork IN (0, 1));
UPDATE orders SET paidForWork = paid;
