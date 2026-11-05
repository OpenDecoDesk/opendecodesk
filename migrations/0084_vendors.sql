-- The vendor list (2026-11). Vendor names used to be typed freehand on every blank, receipt, transfer sheet, expense,
-- "blank ordered" step, blank shipment and supplier / restock order, so one supplier could be "S&S" in one place and
-- "S&S Activewear" in another, and free shipping (global_settings 'vendorShipping') was kept per typed name. Now every
-- vendor is a row here, picked from a list everywhere (Manage… beside each picker); the records keep storing the
-- vendor's NAME (renaming a vendor renames it on every record — db.js saveVendor).
--   forBlanks          the vendor sells blanks: offered in the blank pickers and in Blanks to Order.
--   freeShipOverCents  free shipping at this order amount (0 = every order ships free), NULL = not by amount.
--   freeShipMinQty     …or at this many pieces, NULL = not by pieces. Either one reached = free.
--   noFreeShipping     the vendor never ships free (both amounts are then ignored).
--   hidden             not offered in the pickers any more; kept on the records that name it.
CREATE TABLE IF NOT EXISTS vendors (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT    NOT NULL,
  forBlanks         INTEGER NOT NULL DEFAULT 0 CHECK (forBlanks IN (0, 1)),
  freeShipOverCents INTEGER CHECK (freeShipOverCents IS NULL OR freeShipOverCents >= 0),
  freeShipMinQty    INTEGER CHECK (freeShipMinQty IS NULL OR freeShipMinQty >= 1),
  noFreeShipping    INTEGER NOT NULL DEFAULT 0 CHECK (noFreeShipping IN (0, 1)),
  hidden            INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  createdAt         TEXT    NOT NULL,
  updatedAt         TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vendors_name ON vendors (name COLLATE NOCASE);

-- 1. Names as typed, trimmed.
UPDATE blanks               SET vendor = trim(vendor)      WHERE vendor <> trim(vendor);
UPDATE inventory_movements  SET vendor = trim(vendor)      WHERE vendor <> trim(vendor);
UPDATE expenses             SET vendor = trim(vendor)      WHERE vendor <> trim(vendor);
UPDATE transfer_movements   SET vendor = trim(vendor)      WHERE vendor <> trim(vendor);
UPDATE orders               SET blankVendor = trim(blankVendor) WHERE blankVendor <> trim(blankVendor);
UPDATE order_items          SET blankVendor = trim(blankVendor) WHERE blankVendor <> trim(blankVendor);
UPDATE blank_shipments      SET vendor = trim(vendor)      WHERE vendor <> trim(vendor);
UPDATE supplier_orders      SET vendor = trim(vendor)      WHERE vendor <> trim(vendor);
UPDATE blank_restock_orders SET vendor = trim(vendor)      WHERE vendor <> trim(vendor);

-- 2. Every name in use becomes a vendor — the blank side first (those are "for blanks"; the first spelling seen wins),
--    then transfer sheets and expenses. "In stock" (blanks taken off the shelf) isn't a vendor.
INSERT OR IGNORE INTO vendors (name, forBlanks, createdAt, updatedAt) SELECT DISTINCT vendor, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM blanks WHERE vendor <> '' AND vendor <> 'In stock';
INSERT OR IGNORE INTO vendors (name, forBlanks, createdAt, updatedAt) SELECT DISTINCT vendor, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM inventory_movements WHERE vendor <> '' AND vendor <> 'In stock';
INSERT OR IGNORE INTO vendors (name, forBlanks, createdAt, updatedAt) SELECT DISTINCT blankVendor, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM order_items WHERE blankVendor <> '' AND blankVendor <> 'In stock';
INSERT OR IGNORE INTO vendors (name, forBlanks, createdAt, updatedAt) SELECT DISTINCT blankVendor, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM orders WHERE blankVendor <> '' AND blankVendor <> 'In stock';
INSERT OR IGNORE INTO vendors (name, forBlanks, createdAt, updatedAt) SELECT DISTINCT vendor, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM blank_shipments WHERE vendor <> '' AND vendor <> 'In stock';
INSERT OR IGNORE INTO vendors (name, forBlanks, createdAt, updatedAt) SELECT DISTINCT vendor, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM supplier_orders WHERE vendor <> '';
INSERT OR IGNORE INTO vendors (name, forBlanks, createdAt, updatedAt) SELECT DISTINCT vendor, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM blank_restock_orders WHERE vendor <> '';
-- Free shipping was saved for these by name, so they're blank vendors too.
INSERT OR IGNORE INTO vendors (name, forBlanks, createdAt, updatedAt)
  SELECT DISTINCT trim(json_extract(j.value, '$.name')), 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM global_settings g, json_each(g.value) j
  WHERE g.key = 'vendorShipping' AND json_valid(g.value) AND trim(COALESCE(json_extract(j.value, '$.name'), '')) <> '';
INSERT OR IGNORE INTO vendors (name, forBlanks, createdAt, updatedAt) SELECT DISTINCT vendor, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM transfer_movements WHERE vendor <> '';
INSERT OR IGNORE INTO vendors (name, forBlanks, createdAt, updatedAt) SELECT DISTINCT vendor, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM expenses WHERE vendor <> '';

-- 3. Every record spells its vendor the way the list does ("sanmar" → "SanMar").
UPDATE blanks               SET vendor = (SELECT v.name FROM vendors v WHERE v.name = blanks.vendor COLLATE NOCASE)
  WHERE vendor <> '' AND EXISTS (SELECT 1 FROM vendors v WHERE v.name = blanks.vendor COLLATE NOCASE AND v.name <> blanks.vendor);
UPDATE inventory_movements  SET vendor = (SELECT v.name FROM vendors v WHERE v.name = inventory_movements.vendor COLLATE NOCASE)
  WHERE vendor <> '' AND EXISTS (SELECT 1 FROM vendors v WHERE v.name = inventory_movements.vendor COLLATE NOCASE AND v.name <> inventory_movements.vendor);
UPDATE expenses             SET vendor = (SELECT v.name FROM vendors v WHERE v.name = expenses.vendor COLLATE NOCASE)
  WHERE vendor <> '' AND EXISTS (SELECT 1 FROM vendors v WHERE v.name = expenses.vendor COLLATE NOCASE AND v.name <> expenses.vendor);
UPDATE transfer_movements   SET vendor = (SELECT v.name FROM vendors v WHERE v.name = transfer_movements.vendor COLLATE NOCASE)
  WHERE vendor <> '' AND EXISTS (SELECT 1 FROM vendors v WHERE v.name = transfer_movements.vendor COLLATE NOCASE AND v.name <> transfer_movements.vendor);
UPDATE orders               SET blankVendor = (SELECT v.name FROM vendors v WHERE v.name = orders.blankVendor COLLATE NOCASE)
  WHERE blankVendor <> '' AND EXISTS (SELECT 1 FROM vendors v WHERE v.name = orders.blankVendor COLLATE NOCASE AND v.name <> orders.blankVendor);
UPDATE order_items          SET blankVendor = (SELECT v.name FROM vendors v WHERE v.name = order_items.blankVendor COLLATE NOCASE)
  WHERE blankVendor <> '' AND EXISTS (SELECT 1 FROM vendors v WHERE v.name = order_items.blankVendor COLLATE NOCASE AND v.name <> order_items.blankVendor);
UPDATE blank_shipments      SET vendor = (SELECT v.name FROM vendors v WHERE v.name = blank_shipments.vendor COLLATE NOCASE)
  WHERE vendor <> '' AND EXISTS (SELECT 1 FROM vendors v WHERE v.name = blank_shipments.vendor COLLATE NOCASE AND v.name <> blank_shipments.vendor);
UPDATE supplier_orders      SET vendor = (SELECT v.name FROM vendors v WHERE v.name = supplier_orders.vendor COLLATE NOCASE)
  WHERE vendor <> '' AND EXISTS (SELECT 1 FROM vendors v WHERE v.name = supplier_orders.vendor COLLATE NOCASE AND v.name <> supplier_orders.vendor);
UPDATE blank_restock_orders SET vendor = (SELECT v.name FROM vendors v WHERE v.name = blank_restock_orders.vendor COLLATE NOCASE)
  WHERE vendor <> '' AND EXISTS (SELECT 1 FROM vendors v WHERE v.name = blank_restock_orders.vendor COLLATE NOCASE AND v.name <> blank_restock_orders.vendor);

-- 4. Free shipping. A vendor saved in global_settings 'vendorShipping' (keyed by its name in lower-case letters and
--    digits) keeps what was saved — $0.01 was the closest to "always free" the old form allowed, so it becomes 0; an
--    entry with neither amount meant "no free shipping". Otherwise the old built-in defaults: SanMar and S&S $200.
--    The old setting is left in place but no longer read.
UPDATE vendors SET
  freeShipOverCents = (SELECT CASE WHEN CAST(json_extract(j.value, '$.overCents') AS INTEGER) = 1 THEN 0 ELSE CAST(json_extract(j.value, '$.overCents') AS INTEGER) END
    FROM global_settings g, json_each(g.value) j WHERE g.key = 'vendorShipping' AND json_valid(g.value)
      AND j.key = replace(replace(replace(replace(replace(replace(replace(lower(vendors.name), ' ', ''), '&', ''), '.', ''), '-', ''), ',', ''), '''', ''), '/', '')),
  freeShipMinQty = (SELECT CASE WHEN CAST(json_extract(j.value, '$.minQty') AS INTEGER) >= 1 THEN CAST(json_extract(j.value, '$.minQty') AS INTEGER) END
    FROM global_settings g, json_each(g.value) j WHERE g.key = 'vendorShipping' AND json_valid(g.value)
      AND j.key = replace(replace(replace(replace(replace(replace(replace(lower(vendors.name), ' ', ''), '&', ''), '.', ''), '-', ''), ',', ''), '''', ''), '/', ''))
  WHERE EXISTS (SELECT 1 FROM global_settings g, json_each(g.value) j WHERE g.key = 'vendorShipping' AND json_valid(g.value)
      AND j.key = replace(replace(replace(replace(replace(replace(replace(lower(vendors.name), ' ', ''), '&', ''), '.', ''), '-', ''), ',', ''), '''', ''), '/', ''));
UPDATE vendors SET noFreeShipping = 1
  WHERE freeShipOverCents IS NULL AND freeShipMinQty IS NULL
    AND EXISTS (SELECT 1 FROM global_settings g, json_each(g.value) j WHERE g.key = 'vendorShipping' AND json_valid(g.value)
      AND j.key = replace(replace(replace(replace(replace(replace(replace(lower(vendors.name), ' ', ''), '&', ''), '.', ''), '-', ''), ',', ''), '''', ''), '/', ''));
UPDATE vendors SET freeShipOverCents = 20000
  WHERE freeShipOverCents IS NULL AND freeShipMinQty IS NULL AND noFreeShipping = 0
    AND replace(replace(replace(lower(name), ' ', ''), '&', ''), '.', '') IN ('sanmar', 'ss', 'ssactivewear');
