-- Discount codes: the most a percent code can take off (2026-11). maxDiscountCents NULL = no limit; set only on a
-- percent code (20% off, up to $25). An amount code never has one.
-- ADDITIVE ONLY: one nullable column. Existing codes keep working exactly as before (no limit).
ALTER TABLE discount_codes ADD COLUMN maxDiscountCents INTEGER CHECK (maxDiscountCents IS NULL OR maxDiscountCents BETWEEN 1 AND 1000000);
