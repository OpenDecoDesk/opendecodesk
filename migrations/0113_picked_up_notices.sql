-- owner_notices.kind gains 'picked_up' (2026-11, review round 2).
-- The daily tracking check marks an order shipped once the carrier scans it, and emails the customer their
-- tracking. That news used to live only in the run's memory: a roll-up email that failed, or a morning with
-- no email set up, lost it, including the times the customer's email could not be sent. Each pickup is now
-- queued as an owner notice (functions/_lib/deliveryCheck.js), urgent when the customer couldn't be emailed,
-- so it rides the next roll-up that goes out and is marked sent with the other notices.
-- SQLite can't alter a CHECK, so the table is rebuilt (same as migrations/0016 and 0058; nothing references
-- it, and it has no triggers). Every row is kept, with its id.
-- Apply before deploying the code that uses it (`npm run deploy` does both).

DROP INDEX IF EXISTS idx_owner_notices_unsent;
ALTER TABLE owner_notices RENAME TO owner_notices_old;

CREATE TABLE owner_notices (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  kind      TEXT NOT NULL CHECK (kind IN ('payment', 'refund', 'dispute', 'design', 'delivered', 'invoice', 'picked_up')),
  orderId   TEXT NOT NULL DEFAULT '',
  orgId     TEXT NOT NULL DEFAULT '',
  summary   TEXT NOT NULL,
  detail    TEXT NOT NULL DEFAULT '',
  imageUrls TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(imageUrls)),
  urgent    INTEGER NOT NULL DEFAULT 0 CHECK (urgent IN (0, 1)),
  createdAt TEXT NOT NULL,
  sentAt    TEXT
);

INSERT INTO owner_notices (id, kind, orderId, orgId, summary, detail, imageUrls, urgent, createdAt, sentAt)
  SELECT id, kind, orderId, orgId, summary, detail, imageUrls, urgent, createdAt, sentAt FROM owner_notices_old;
DROP TABLE owner_notices_old;
CREATE INDEX idx_owner_notices_unsent ON owner_notices(sentAt, id);
