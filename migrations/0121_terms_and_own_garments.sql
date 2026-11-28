-- Net 30 terms with a PO, and customer-supplied garments (2026-11).
--   customers        allowNet30 (the customer may pick Net 30 at checkout) and termsDays (their days; NULL = the
--                    Global settings default, terms.defaultDays).
--   orders           net30 (paid by invoice on terms), poNumber (the customer's purchase order; '' = none yet),
--                    poTypedAt (when the CUSTOMER typed it: it waits for staff to accept it), poAcceptedAt/By (staff
--                    accepted it, or typed it themselves: from then on the order is cleared for work while still
--                    owed — db.js net30Cleared), termsDays (this order's days; NULL = the default) and invoicedAt (the
--                    FIRST time an invoice was sent; a resend never moves it). The due date is never stored: db.js
--                    net30DueDate_ works it out from the terms setting when it is read.
--   order_items      customerOwned (the customer brings the garment: the line never orders or uses a blank and has
--                    no blank cost) and ownReceivedAt (their garments were checked in; production waits for it).
--   estimate_items   customerOwned, carried to the order's line when a quote becomes an order.
--   garment_checkins one row per size counted when a customer's garments come in: expected, received, condition and
--                    a note. A re-count voids the line's earlier rows (voidedAt) and writes new ones.
-- Settings (no schema): features.ownGarments (off unless ticked) and features.ownGarmentsWaiver, enabledPayments.net30
-- (off unless ticked), terms { defaultDays, startsAt: invoice | order | completed }.
-- ADDITIVE ONLY: columns, one table and indexes. invoicedAt is filled from order_invoices only where an invoice was
-- sent exactly once, since order_invoices.sentAt is the LAST send (a resend moves it).
ALTER TABLE customers ADD COLUMN allowNet30 INTEGER NOT NULL DEFAULT 0 CHECK (allowNet30 IN (0, 1));
ALTER TABLE customers ADD COLUMN termsDays INTEGER CHECK (termsDays IS NULL OR termsDays BETWEEN 1 AND 365);

ALTER TABLE orders ADD COLUMN net30 INTEGER NOT NULL DEFAULT 0 CHECK (net30 IN (0, 1));
ALTER TABLE orders ADD COLUMN poNumber TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN poAcceptedAt TEXT;
ALTER TABLE orders ADD COLUMN poAcceptedBy TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN poTypedAt TEXT;
ALTER TABLE orders ADD COLUMN termsDays INTEGER CHECK (termsDays IS NULL OR termsDays BETWEEN 1 AND 365);
ALTER TABLE orders ADD COLUMN invoicedAt TEXT;
UPDATE orders SET invoicedAt = (SELECT i.sentAt FROM order_invoices i WHERE i.orderId = orders.orderId AND i.sendCount = 1)
 WHERE invoicedAt IS NULL;
CREATE INDEX IF NOT EXISTS idx_orders_net30 ON orders(net30) WHERE net30 = 1;

ALTER TABLE order_items ADD COLUMN customerOwned INTEGER NOT NULL DEFAULT 0 CHECK (customerOwned IN (0, 1));
ALTER TABLE order_items ADD COLUMN ownReceivedAt TEXT;

ALTER TABLE estimate_items ADD COLUMN customerOwned INTEGER NOT NULL DEFAULT 0 CHECK (customerOwned IN (0, 1));

CREATE TABLE IF NOT EXISTS garment_checkins (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  orderId      TEXT NOT NULL,
  itemId       INTEGER NOT NULL,
  size         TEXT NOT NULL DEFAULT '',
  expectedQty  INTEGER NOT NULL DEFAULT 0 CHECK (expectedQty >= 0),
  receivedQty  INTEGER NOT NULL DEFAULT 0 CHECK (receivedQty >= 0),
  condition    TEXT NOT NULL DEFAULT 'good' CHECK (condition IN ('good', 'damaged', 'other')),
  note         TEXT NOT NULL DEFAULT '',
  at           TEXT NOT NULL,
  by           TEXT NOT NULL DEFAULT '',
  voidedAt     TEXT
);
CREATE INDEX IF NOT EXISTS idx_garment_checkins_item ON garment_checkins(itemId);
