-- Payment on delivery (2026-11). An order marked "pay on delivery" goes through its steps — blanks, digitizing,
-- approval, the run, QA and packing, delivery — before it is paid; it is completed once paid in full, as before.
--   orders.payOnDelivery  1 = the customer pays when it's delivered (set on Orders by a role with "Set orders to
--                         pay on delivery", permissions.js orders.payOnDelivery), 0 = the usual paid-first rule.
-- Whether a shop may use it is a setting, not a column: Global settings → Payment methods allows it for every shop
-- (global_settings 'enabledPayments'.onDelivery, off unless ticked) and a shop can turn it off for itself
-- (orgs.enabledPayments.onDelivery). Either one can limit it to the Local sale window (onDeliveryLocalOnly).
-- ADDITIVE: one column, 0 for every order already there.
ALTER TABLE orders ADD COLUMN payOnDelivery INTEGER NOT NULL DEFAULT 0 CHECK (payOnDelivery IN (0, 1));
