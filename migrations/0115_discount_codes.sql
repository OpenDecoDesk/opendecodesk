-- Discount codes (2026-11). A code a customer types at checkout takes a percent or an amount off the order's goods;
-- the discount is stored on the order exactly as a manual one is (orders.discountCents / discountNote "Code SAVE10").
--   discount_codes       one row per code: stored upper-case (letters, digits, '-' and '_', 3–32 characters), percent
--                        (percentBps 1–10000) or an amount (amountCents), every shop (orgId NULL) or one, and who can
--                        use it: email '' = anyone, up to maxUses times in all (oncePerEmail: once per address), or one
--                        address (lower-case), once. expiresOn is the last day it works (the business's day; NULL =
--                        never). active 0 = switched off. Deleted only while it has no uses at all.
--   discount_code_uses   one row per order that used a code. It is claimed just BEFORE the order is inserted (so no FK
--                        to orders), by one conditional INSERT that counts the live uses — two orders racing for the
--                        last use can't both win. A voided or deleted order gives its use back: releasedAt is set, the
--                        row is kept. One row per order (the unique index): the same order trying again (a retry after
--                        a failed insert, whose use was released) takes its released row back with an UPDATE (db.js
--                        claimDiscountCode) rather than adding a second.
-- ADDITIVE ONLY: two new tables and their indexes. Nothing existing is read or changed.
CREATE TABLE IF NOT EXISTS discount_codes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('percent','amount')),
  percentBps   INTEGER,
  amountCents  INTEGER,
  orgId        TEXT REFERENCES orgs(orgId),
  email        TEXT NOT NULL DEFAULT '',
  maxUses      INTEGER NOT NULL CHECK (maxUses >= 1),
  oncePerEmail INTEGER NOT NULL DEFAULT 0,
  expiresOn    TEXT,
  active       INTEGER NOT NULL DEFAULT 1,
  note         TEXT NOT NULL DEFAULT '',
  createdAt    TEXT NOT NULL,
  createdBy    TEXT NOT NULL DEFAULT '',
  CHECK ((kind = 'percent' AND percentBps IS NOT NULL AND percentBps BETWEEN 1 AND 10000 AND amountCents IS NULL)
      OR (kind = 'amount' AND amountCents IS NOT NULL AND amountCents BETWEEN 1 AND 1000000 AND percentBps IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_discount_codes_code ON discount_codes(code);

CREATE TABLE IF NOT EXISTS discount_code_uses (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  codeId       INTEGER NOT NULL REFERENCES discount_codes(id),
  orderId      TEXT NOT NULL,
  email        TEXT NOT NULL DEFAULT '',
  amountCents  INTEGER NOT NULL DEFAULT 0,
  usedAt       TEXT NOT NULL,
  releasedAt   TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_discount_uses_order ON discount_code_uses(orderId);
CREATE INDEX IF NOT EXISTS idx_discount_uses_code ON discount_code_uses(codeId) WHERE releasedAt IS NULL;
