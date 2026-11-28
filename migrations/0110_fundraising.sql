-- Fundraising for group shops (2026-11). A team, school or club shop often gives part of every sale back to the
-- group. The amount is INSIDE the listed price: the customer pays the same, and the shop owes it to the group.
--   orgs.fundraiserJson         the shop's fundraiser: '' = none, else
--                               {"mode":"percent","percentBps":1000,"label":"…","showOnShop":true} or
--                               {"mode":"perPiece","cents":200,"label":"…","showOnShop":false} (db.js parseFundraiser_).
--                               Changing it affects new orders only: each line keeps what it raised.
--   order_items.fundraiserCents what this line raises for its shop's fundraiser, worked out when the line was priced
--                               (db.js fundraiserLineCents_); 0 = none. The Fundraising report sums it.
--   expenses.fundraiserOrgId    a payout to a shop's fundraiser is an ordinary expense tied to the shop, so it shows
--                               wherever expenses show and the report can count it as paid out.
--   expense_categories          the built-in "Fundraiser payouts" category, found by systemKey 'fundraiser_payout'
--                               (like 'sales_tax_paid' in 0090): renamed freely, never deleted. Schedule C "Other
--                               expenses" (27a), the line the code files anything without its own line under.
-- ADDITIVE ONLY: three new columns with defaults (or NULL), an index and one category row. Nothing is rewritten.
ALTER TABLE orgs ADD COLUMN fundraiserJson TEXT NOT NULL DEFAULT '';
ALTER TABLE order_items ADD COLUMN fundraiserCents INTEGER NOT NULL DEFAULT 0 CHECK (fundraiserCents >= 0);
ALTER TABLE expenses ADD COLUMN fundraiserOrgId TEXT REFERENCES orgs(orgId);
CREATE INDEX IF NOT EXISTS idx_expenses_fundraiser ON expenses(fundraiserOrgId) WHERE fundraiserOrgId IS NOT NULL;
INSERT INTO expense_categories (name, deductionType, scheduleCLine, deductiblePct, createdAt, updatedAt, systemKey)
  SELECT CASE WHEN EXISTS (SELECT 1 FROM expense_categories WHERE name = 'Fundraiser payouts' COLLATE NOCASE)
              THEN 'Fundraiser payouts (built in)' ELSE 'Fundraiser payouts' END,
         'deductible', '27a', 100, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'fundraiser_payout'
  WHERE NOT EXISTS (SELECT 1 FROM expense_categories WHERE systemKey = 'fundraiser_payout');
