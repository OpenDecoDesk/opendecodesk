-- The Orphaned images scan's scratch tables, and the transfer movements' index by order line (2026-11, review round 2).
--   orphan_scans / orphan_scan_keys   Settings → Orphaned images now runs in steps the screen drives, so one request
--                       never runs more database queries than Cloudflare allows (50 on the Free plan). Between steps
--                       the scan keeps where it is (orphan_scans.state) and what it found (orphan_scan_keys: kind
--                       'ref' = an image key the database points to, 'orphan' = a file the scan called orphaned, which
--                       Remove selected checks against). A scan's rows go when it ends with nothing orphaned, when
--                       its page starts the next scan, and once they're a day old (functions/_lib/orphanImages.js).
--                       Never searched for image addresses themselves.
--   idx_transfer_movements_itemId   the transfers an order line used are looked up by the line (db.js
--                       transfersInHand_, consumeLineTransfersOnce_, planTransferCatchUp, refreshOrderLinesFromCatalog);
--                       the index named idx_transfer_movements_item is on transferId, so those read the whole table.
-- ADDITIVE: two new tables and an index.
CREATE TABLE IF NOT EXISTS orphan_scans (
  scanId    TEXT PRIMARY KEY,
  startedAt TEXT NOT NULL,
  state     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(state))
);
CREATE TABLE IF NOT EXISTS orphan_scan_keys (
  scanId TEXT NOT NULL,
  kind   TEXT NOT NULL CHECK (kind IN ('ref', 'orphan')),
  key    TEXT NOT NULL,
  PRIMARY KEY (scanId, kind, key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_transfer_movements_itemId ON transfer_movements(itemId) WHERE itemId IS NOT NULL;
