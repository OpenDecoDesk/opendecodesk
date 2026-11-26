-- Indexes for reads that walked tables which grow every year (2026-11, review round 2).
--   idx_prod_blank_link_blank       product_blank_links by blank: the shop page's "ready to decorate" counts ask which
--                       products use these blanks (db.js getBlankReservations with blankIds); the other two indexes
--                       lead with the shop, so that read went through every shop's links.
--   idx_runs_started                production_runs by start time: the Run times report reads a date range of runs, and
--                       its run log pages newest first on (startedAt, id) (db.js getRunReportByDesign).
--   idx_movements_purchase_created  purchases still in force by when they were recorded: whether restock on order has
--                       arrived (db.js restockOnOrder_, the Blanks and Blanks to Order screens) reads the last 45 days.
-- ADDITIVE ONLY: three indexes.
CREATE INDEX IF NOT EXISTS idx_prod_blank_link_blank ON product_blank_links(blankId, blankColor, blankSize);
CREATE INDEX IF NOT EXISTS idx_runs_started ON production_runs(startedAt);
CREATE INDEX IF NOT EXISTS idx_movements_purchase_created ON inventory_movements(createdAt) WHERE kind = 'purchase' AND voidedAt IS NULL;
