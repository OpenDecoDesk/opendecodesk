-- Finished stock per combination (2026-11): a product with color and graphic choices can be stocked as finished
-- pieces of one combination — garment color + the graphic (and ink) at each spot — not just per size.
--   ready_to_ship.variant       the combination's key ('' = a product with no choices, as before); variantLabel
--                               says it in words ("Navy · Left chest: Crest"). One row per
--                               shop + product + size + combination, so the UNIQUE key is rebuilt (table rebuild).
--   finished_goods_movements    the same two columns on every change.
--   order_items.stockVariant    the combination a line filled from stock was filled from.
-- Every existing row is a plain product's ('' combination), so nothing already recorded changes.
CREATE TABLE ready_to_ship_new (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  orgId        TEXT NOT NULL,
  productId    TEXT NOT NULL,
  size         TEXT NOT NULL DEFAULT '',
  quantity     INTEGER NOT NULL DEFAULT 0,
  updatedAt    TEXT NOT NULL,
  avgCostCents INTEGER NOT NULL DEFAULT 0 CHECK (avgCostCents >= 0),
  variant      TEXT NOT NULL DEFAULT '',
  variantLabel TEXT NOT NULL DEFAULT '',
  UNIQUE (orgId, productId, size, variant)
);
INSERT INTO ready_to_ship_new (id, orgId, productId, size, quantity, updatedAt, avgCostCents)
  SELECT id, orgId, productId, size, quantity, updatedAt, avgCostCents FROM ready_to_ship;
DROP TABLE ready_to_ship;
ALTER TABLE ready_to_ship_new RENAME TO ready_to_ship;
CREATE INDEX IF NOT EXISTS idx_rts_org ON ready_to_ship(orgId, productId);

ALTER TABLE finished_goods_movements ADD COLUMN variant TEXT NOT NULL DEFAULT '';
ALTER TABLE finished_goods_movements ADD COLUMN variantLabel TEXT NOT NULL DEFAULT '';
DROP INDEX IF EXISTS idx_fgm_item;
CREATE INDEX IF NOT EXISTS idx_fgm_item ON finished_goods_movements (orgId, productId, size, variant, occurredAt);

ALTER TABLE order_items ADD COLUMN stockVariant TEXT NOT NULL DEFAULT '';
DROP INDEX IF EXISTS idx_items_from_stock;
CREATE INDEX IF NOT EXISTS idx_items_from_stock ON order_items (orgId, productId, size, stockVariant) WHERE fromStock = 1;
