-- Decoration types (2026-11): the shop says which kinds of work it does (Global settings → Decoration types:
-- embroidery, DTF, screen print, vinyl, DTG, sublimation; the top of functions/_lib/db.js is the list), and the Run
-- order, graphics, products and quotes follow it.
--   graphics.decoration      what prints a transfer-kind graphic: '' = DTF (as before), or screenprint / vinyl / dtg /
--                            sublimation. An embroidery graphic keeps ''. graphics.kind is unchanged.
--   products.decorationType  the product's own decoration; '' = worked out from its design / transfers as before.
--   order_items.decStartedAt / decMadeAt  Start / Mark made of a screen print, vinyl, DTG or sublimation line (and
--                            of the printed part of a line that is also embroidered), like transfersAppliedAt.
--   vendors.forDigitizing    the vendor digitizes designs (offered first when a design is sent out).
--   expenses.orderId         the order an expense was recorded for ('' = none), e.g. an outside digitizing fee.
--   digitizing_jobs          designs sent to an outside digitizer: when, who, what it cost, and the expense recorded.
-- The decorationTypes and decorationPricing settings live in global_settings (no schema change).
-- ADDITIVE ONLY: new columns with defaults that mean "as before", and one new table. Apply before deploying the code
-- that uses it (`npm run deploy` does both).
ALTER TABLE graphics ADD COLUMN decoration TEXT NOT NULL DEFAULT '' CHECK (decoration IN ('', 'dtf', 'screenprint', 'vinyl', 'dtg', 'sublimation'));
ALTER TABLE products ADD COLUMN decorationType TEXT NOT NULL DEFAULT '' CHECK (decorationType IN ('', 'embroidery', 'dtf', 'screenprint', 'vinyl', 'dtg', 'sublimation'));
ALTER TABLE order_items ADD COLUMN decStartedAt TEXT;
ALTER TABLE order_items ADD COLUMN decMadeAt TEXT;
ALTER TABLE vendors ADD COLUMN forDigitizing INTEGER NOT NULL DEFAULT 0 CHECK (forDigitizing IN (0, 1));
ALTER TABLE expenses ADD COLUMN orderId TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_expenses_order ON expenses(orderId) WHERE orderId <> '';

CREATE TABLE IF NOT EXISTS digitizing_jobs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  orderId    TEXT NOT NULL DEFAULT '',
  itemId     INTEGER,                       -- the order line, when it is for one
  designId   INTEGER,                       -- the design, when there is one
  estimateId INTEGER,                       -- the quote whose digitizing fee line it pays for, when there is one
  name       TEXT NOT NULL DEFAULT '',      -- what was sent ("Example Club left chest logo")
  vendor     TEXT NOT NULL DEFAULT '',      -- a vendors.name (names are what records store elsewhere)
  sentAt     TEXT NOT NULL,                 -- YYYY-MM-DD
  returnedAt TEXT,                          -- YYYY-MM-DD
  costCents  INTEGER NOT NULL DEFAULT 0 CHECK (costCents >= 0),
  expenseId  INTEGER,                       -- the expenses row recorded for its cost, when one was
  note       TEXT NOT NULL DEFAULT '',
  createdAt  TEXT NOT NULL,
  createdBy  TEXT NOT NULL DEFAULT '',
  deletedAt  TEXT
);
CREATE INDEX IF NOT EXISTS idx_digitizing_order ON digitizing_jobs(orderId);
