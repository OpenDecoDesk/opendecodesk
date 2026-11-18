-- Bookkeeping (2026-11): an order's revenue and its cost both count on its sale date (Global settings →
-- Bookkeeping, global_settings 'accounting'). By default that's when it ships, is delivered / picked up,
-- or — with nothing to ship — is completed. Reports find the orders sold in a period through this index;
-- functions/_lib/db.js saleDateSql_ must use exactly the same expression for SQLite to use it.
CREATE INDEX IF NOT EXISTS idx_orders_sale_date ON orders(COALESCE(shippedAt, deliveredAt, completedAt));
