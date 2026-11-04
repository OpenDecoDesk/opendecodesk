-- Rush orders: a "payment must be received by" date (2026-11). A rush date can only be kept when the customer has paid
-- in full in time, so the shop sets the date full payment is due (the Rush… window on the order, or worked out from
-- the needed-by date and the rush rule's "days before" when the customer orders). The invoice email and page, and the
-- order-received email, say that without full payment by then the rush date can't be guaranteed.
--   orders.rushPayBy   YYYY-MM-DD, NULL = none set. ADDITIVE.
ALTER TABLE orders ADD COLUMN rushPayBy TEXT;
