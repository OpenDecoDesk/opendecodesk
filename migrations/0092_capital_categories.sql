-- Capital purchases, apart from running costs (Home's operating profit). Until now "capital" meant only the
-- Depreciation deduction type, which is a tax choice: a $900 machine expensed under the de minimis rule had to be
-- either Depreciation (wrong for the tax side) or an ordinary expense mixed with thread and rent (wrong for Home).
--   capital  1 = purchases that last (equipment, tools): still an expense in the books and deducted as its
--            deduction type says, but Home keeps them out of operating profit and shows them on their own.
--            A Depreciation category is always capital (the app enforces it on save).
-- Adds "Small equipment & tools": deducted now (Schedule C line 22, editable), capital.
-- ADDITIVE ONLY: apply before deploying the code that uses it (`npm run deploy` does both).
ALTER TABLE expense_categories ADD COLUMN capital INTEGER NOT NULL DEFAULT 0 CHECK (capital IN (0, 1));
UPDATE expense_categories SET capital = 1 WHERE deductionType = 'depreciation';
INSERT OR IGNORE INTO expense_categories (name, deductionType, scheduleCLine, deductiblePct, createdAt, updatedAt, capital)
  VALUES ('Small equipment & tools', 'deductible', '22', 100, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 1);
