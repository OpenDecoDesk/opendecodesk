-- "Sync Stripe fees & dates" (Accounting) asked Stripe about every card payment ever recorded, one call each, on every
-- click: past the Worker's subrequest limit it failed partway every time. Now each Stripe card payment's date is
-- compared with Stripe's once, and a click does a limited number of lookups (the next click carries on).
--   stripeCheckedAt  when the date was compared with Stripe's (whether or not it changed); NULL = not yet.
-- ADDITIVE ONLY: every existing payment starts as not yet checked.
ALTER TABLE order_payments ADD COLUMN stripeCheckedAt TEXT;
