-- Sales tax paid to the state (Home's "Money in and out"). Sales tax the business collects is money in; paying it
-- to the state is money out. Until now that payment was an expense in "Taxes & licenses", mixed with licenses, so
-- nothing could pick it out. This adds a built-in category for it, found by systemKey (not its name, which the
-- owner may change); Home colors expenses in it as sales tax. Not deductible: the tax was never the business's income.
--   systemKey  a fixed key for a category the app relies on ('sales_tax_paid'); NULL for ordinary ones. Such a
--              category can be renamed but not deleted.
-- ADDITIVE ONLY: apply before deploying the code that uses it (`npm run deploy` does both).
ALTER TABLE expense_categories ADD COLUMN systemKey TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_expense_categories_system ON expense_categories(systemKey) WHERE systemKey IS NOT NULL;
INSERT INTO expense_categories (name, deductionType, scheduleCLine, deductiblePct, createdAt, updatedAt, systemKey)
  SELECT CASE WHEN EXISTS (SELECT 1 FROM expense_categories WHERE name = 'Sales tax paid to the state' COLLATE NOCASE)
              THEN 'Sales tax paid to the state (built in)' ELSE 'Sales tax paid to the state' END,
         'none', '', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'sales_tax_paid'
  WHERE NOT EXISTS (SELECT 1 FROM expense_categories WHERE systemKey = 'sales_tax_paid');
