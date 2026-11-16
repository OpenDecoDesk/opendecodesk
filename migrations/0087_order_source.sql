-- Orders imported from another store (2026-11): Orders → Import orders reads an Etsy "Order Items" CSV, a Shopify orders
-- export or a plain orders sheet, and makes one order per store order (db.js importOrdersCsv).
--   orders.source           '' = made here (storefront, Local sale); 'etsy', 'shopify' or 'csv' = imported from that store.
--   orders.externalOrderId  the store's own order number ("3141592653", "#1001"), shown on the order. With the source and
--                           the shop it's unique, so importing the same file again skips the orders already in.
-- An imported order's files were delivered by the store, so digital.js never grants downloads or emails a link for it.
-- ADDITIVE ONLY: apply before deploying the code that uses it.

ALTER TABLE orders ADD COLUMN source TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN externalOrderId TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_external ON orders(orgId, source, externalOrderId) WHERE externalOrderId IS NOT NULL;
