-- When the daily delivery check last looked up an order's tracking (2026-11). The check makes at most 40 lookups
-- a morning; it used to take the oldest shipments first every day, so with more than that waiting the newest ones
-- were never looked up. It now takes the ones looked up longest ago (never-checked first) and stamps each lookup
-- here, as blank shipments already do (blank_shipments.lastCheckedAt, migrations/0039).
--   orders.trackingCheckedAt  ISO time of the last tracking lookup for the order (pickup or delivery); NULL = never
-- ADDITIVE ONLY: one column, NULL for every order already there. Apply before deploying the code that uses it
-- (`npm run deploy` does both).
ALTER TABLE orders ADD COLUMN trackingCheckedAt TEXT;
