-- owner_notices.kind gains 'quote', 'gift_card' and 'po' (2026-11).
-- 'quote': a customer's answer to a quote (accepted, changes asked for, declined) used to be queued as 'invoice' and
-- so showed in the morning roll-up as an invoice; it now says "Quote". 'gift_card' and 'po' are for gift cards and
-- purchase orders (later phases), added now so the table is rebuilt once.
-- SQLite can't alter a CHECK, so the table is rebuilt exactly as migrations/0113 did (nothing references it, and it
-- has no triggers). Every row is kept, with its id.
-- Apply before deploying the code that uses it (`npm run deploy` does both).

DROP INDEX IF EXISTS idx_owner_notices_unsent;
ALTER TABLE owner_notices RENAME TO owner_notices_old;

CREATE TABLE owner_notices (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  kind      TEXT NOT NULL CHECK (kind IN ('payment', 'refund', 'dispute', 'design', 'delivered', 'invoice', 'picked_up', 'quote', 'gift_card', 'po')),
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
