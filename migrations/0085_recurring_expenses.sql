-- Recurring expenses (2026-11). A subscription, phone bill, insurance premium or rent that costs the same every period
-- is set up once, with a frequency and an optional end date, and recorded automatically on each date it comes due (the
-- Worker's daily run, and whenever the Expenses screen loads). Each recorded one is an ordinary expense row tagged with
-- recurringId; editing a rule only changes the occurrences not recorded yet.
--   startDate   the first occurrence; its day of the month is the anchor (the 31st clamps to a shorter month's end).
--   endDate     the last day an occurrence may fall on, NULL = no end.
--   nextIndex   which occurrence is next (0 = startDate) — dates are worked out from startDate, so they never drift.
CREATE TABLE IF NOT EXISTS recurring_expenses (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  description      TEXT    NOT NULL CHECK (length(trim(description)) > 0),
  categoryId       INTEGER NOT NULL REFERENCES expense_categories(id) ON DELETE RESTRICT,
  amountCents      INTEGER NOT NULL CHECK (amountCents > 0),
  vendor           TEXT    NOT NULL DEFAULT '',
  accountId        INTEGER REFERENCES accounts(id),
  paidPersonally   INTEGER NOT NULL DEFAULT 0 CHECK (paidPersonally IN (0, 1)),
  businessUsePct   INTEGER NOT NULL DEFAULT 100 CHECK (businessUsePct BETWEEN 1 AND 100),
  vendorChargedTax INTEGER NOT NULL DEFAULT 1 CHECK (vendorChargedTax IN (0, 1)),
  frequency        TEXT    NOT NULL CHECK (frequency IN ('weekly', 'biweekly', 'monthly', 'quarterly', 'semiannual', 'yearly')),
  startDate        TEXT    NOT NULL CHECK (startDate GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  endDate          TEXT    CHECK (endDate IS NULL OR endDate GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  nextIndex        INTEGER NOT NULL DEFAULT 0 CHECK (nextIndex >= 0),
  createdAt        TEXT    NOT NULL,
  updatedAt        TEXT    NOT NULL,
  deletedAt        TEXT
);

-- The rule an expense was recorded from (NULL = entered by hand). One expense per rule per date: two runs at once can't
-- record a date twice, and a recorded expense that was deleted (soft delete — its row stays) isn't recorded again.
ALTER TABLE expenses ADD COLUMN recurringId INTEGER REFERENCES recurring_expenses(id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_expenses_recurring ON expenses(recurringId, expenseDate) WHERE recurringId IS NOT NULL;
