-- Indexes for screens and reports that should stay fast as the order history grows (2026-11), found by
-- the scale test (perf/README.md):
--
--   idx_orders_open          only the open orders (not completed, not voided): Open orders, the
--                            production queue, the transfer queue and Blanks to order look for those,
--                            and without it SQLite walked idx_orders_reportable, every live order in
--                            the history. It stays as small as the work in progress.
--   idx_orders_manufactured  the orders made in a period, for the COGS report and the accountant export.
CREATE INDEX IF NOT EXISTS idx_orders_open ON orders(isTest, voidedAt, placedAt) WHERE completedAt IS NULL AND voidedAt IS NULL;
CREATE INDEX IF NOT EXISTS idx_orders_manufactured ON orders(manufacturedAt);
