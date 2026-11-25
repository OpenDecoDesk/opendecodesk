-- Customer records (2026-11). Until now an order only carried a name and a contact (an email or a phone, free text).
--   customers            one row per customer: who they are, where to reach them, and a tax exemption of their own
--                        (db.js saveCustomer, insertOrder). email is trimmed and lower case, '' when there is none.
--                        addressJson is '' or the same JSON as orders.shippingAddress. Never deleted: archivedAt hides
--                        one, and mergedIntoId says which customer a duplicate was folded into (db.js mergeCustomers).
--   idx_customers_email  one customer per email, leaving out the ones merged away (they keep theirs for the record).
--   orders.customerId    the customer an order belongs to, NULL when it has none (a phone number or nothing as contact).
-- ADDITIVE: a new table, a new nullable column and two indexes. The backfill below only reads the orders' contact.
CREATE TABLE IF NOT EXISTS customers (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  name                 TEXT NOT NULL DEFAULT '',
  company              TEXT NOT NULL DEFAULT '',
  email                TEXT NOT NULL DEFAULT '',
  phone                TEXT NOT NULL DEFAULT '',
  addressJson          TEXT NOT NULL DEFAULT '',
  notes                TEXT NOT NULL DEFAULT '',
  taxExempt            INTEGER NOT NULL DEFAULT 0 CHECK (taxExempt IN (0, 1)),
  taxExemptCertificate TEXT NOT NULL DEFAULT '',
  taxExemptExpires     TEXT,
  createdAt            TEXT NOT NULL,
  updatedAt            TEXT NOT NULL,
  archivedAt           TEXT,
  mergedIntoId         INTEGER REFERENCES customers(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_email ON customers(email) WHERE email <> '' AND mergedIntoId IS NULL;
ALTER TABLE orders ADD COLUMN customerId INTEGER REFERENCES customers(id);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customerId);

-- Backfill: a customer for each email that real (non-test) orders were placed with. An email here is what
-- db.js normalizeCustomerEmail_ accepts: one @ with something before it, a dot with something either side after it,
-- no white space, at most 200 characters. Its name is the one on that email's newest order, and it has been a
-- customer since its oldest. Nothing is inserted on a database with no orders.
INSERT INTO customers (name, email, createdAt, updatedAt)
SELECT substr(trim(customerName), 1, 200), email, firstAt, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM (
  SELECT email, customerName,
         MIN(placedAt) OVER (PARTITION BY email) AS firstAt,
         ROW_NUMBER() OVER (PARTITION BY email ORDER BY placedAt DESC, orderId DESC) AS newest
  FROM (SELECT lower(trim(contact, char(32, 9, 10, 13))) AS email, customerName, placedAt, orderId FROM orders WHERE isTest = 0)
  WHERE email LIKE '_%@_%._%'
    AND length(email) - length(replace(email, '@', '')) = 1
    AND instr(email, ' ') = 0 AND instr(email, char(9)) = 0 AND instr(email, char(10)) = 0 AND instr(email, char(13)) = 0
    AND length(email) <= 200
)
WHERE newest = 1;

-- Every order with one of those emails (a test order too) now belongs to that customer. An order whose contact is a
-- phone number, or empty, finds none and stays NULL.
UPDATE orders
   SET customerId = (SELECT c.id FROM customers c
                      WHERE c.email <> '' AND c.mergedIntoId IS NULL
                        AND c.email = lower(trim(orders.contact, char(32, 9, 10, 13))))
 WHERE contact LIKE '%@%';
