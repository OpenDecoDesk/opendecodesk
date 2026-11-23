-- Month-end stock snapshots (2026-11): the Inventory & COGS report and the accountant export value blanks, transfer
-- sheets and finished stock by replaying their movement history (weighted-average cost). Replaying every movement
-- since the first one gets slower every year, so the replay state at the end of a CLOSED month is kept here, written
-- the first time a report needs it (db.js stockSnapshotStart_ / stockSnapshotWrite_). A later report starts from the
-- latest snapshot at or before its beginning and replays only the movements after it.
--   month     YYYY-MM: the state after every movement up to the end of that month (…-31T23:59:59.999Z)
--   kind      'blank', 'transfer' or 'finished' (one movement table each)
--   key       the item, as a JSON array: [blankId, color, size], [transferId] or [orgId, productId, size, variant];
--             '#complete' marks a whole snapshot written, '#pending' one being written (name = the writer's token)
--   qty       on hand (signed, as the replay holds it)
--   avgCents  the running average cost in whole cents, exactly as the replay holds it
--   name      the name the movements last gave the item (blankName / transferName / productName)
--   label     finished stock's variant label ('' otherwise)
-- A snapshot must never outlive a change to the movements under it, so the triggers below delete every snapshot
-- from the month of the movement on, in the same statement as the change: an insert, a void or restore, an edited
-- cost or a moved date (an update deletes from the earlier of its old and new months). No code path can forget it,
-- including a movement backdated into an earlier open month. Reopening a month deletes them too (db.js
-- reopenPeriod), and so does changing the sale-date basis (setAccountingSettings).
-- ADDITIVE: a new table, an index and triggers.
CREATE TABLE IF NOT EXISTS inventory_period_snapshots (
  month     TEXT    NOT NULL,
  kind      TEXT    NOT NULL,
  key       TEXT    NOT NULL,
  qty       INTEGER NOT NULL DEFAULT 0,
  avgCents  INTEGER NOT NULL DEFAULT 0,
  name      TEXT,
  label     TEXT,
  PRIMARY KEY (month, kind, key)
);

-- Costs on orders not sold yet (db.js getOrderCostsNotYetSoldAt) look up finished stock by order, as the blank and
-- transfer movements already can.
CREATE INDEX IF NOT EXISTS idx_fgm_order ON finished_goods_movements (orderId);

CREATE TRIGGER IF NOT EXISTS ips_inventory_movements_ins AFTER INSERT ON inventory_movements
BEGIN DELETE FROM inventory_period_snapshots WHERE month >= substr(NEW.occurredAt, 1, 7); END;
CREATE TRIGGER IF NOT EXISTS ips_inventory_movements_upd AFTER UPDATE ON inventory_movements
BEGIN DELETE FROM inventory_period_snapshots WHERE month >= substr(NEW.occurredAt, 1, 7) OR month >= substr(OLD.occurredAt, 1, 7); END;
CREATE TRIGGER IF NOT EXISTS ips_inventory_movements_del AFTER DELETE ON inventory_movements
BEGIN DELETE FROM inventory_period_snapshots WHERE month >= substr(OLD.occurredAt, 1, 7); END;
CREATE TRIGGER IF NOT EXISTS ips_transfer_movements_ins AFTER INSERT ON transfer_movements
BEGIN DELETE FROM inventory_period_snapshots WHERE month >= substr(NEW.occurredAt, 1, 7); END;
CREATE TRIGGER IF NOT EXISTS ips_transfer_movements_upd AFTER UPDATE ON transfer_movements
BEGIN DELETE FROM inventory_period_snapshots WHERE month >= substr(NEW.occurredAt, 1, 7) OR month >= substr(OLD.occurredAt, 1, 7); END;
CREATE TRIGGER IF NOT EXISTS ips_transfer_movements_del AFTER DELETE ON transfer_movements
BEGIN DELETE FROM inventory_period_snapshots WHERE month >= substr(OLD.occurredAt, 1, 7); END;
CREATE TRIGGER IF NOT EXISTS ips_finished_goods_movements_ins AFTER INSERT ON finished_goods_movements
BEGIN DELETE FROM inventory_period_snapshots WHERE month >= substr(NEW.occurredAt, 1, 7); END;
CREATE TRIGGER IF NOT EXISTS ips_finished_goods_movements_upd AFTER UPDATE ON finished_goods_movements
BEGIN DELETE FROM inventory_period_snapshots WHERE month >= substr(NEW.occurredAt, 1, 7) OR month >= substr(OLD.occurredAt, 1, 7); END;
CREATE TRIGGER IF NOT EXISTS ips_finished_goods_movements_del AFTER DELETE ON finished_goods_movements
BEGIN DELETE FROM inventory_period_snapshots WHERE month >= substr(OLD.occurredAt, 1, 7); END;
