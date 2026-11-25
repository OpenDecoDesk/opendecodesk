-- Quotes and quantity breaks (2026-11). The admin and the customer call a quote a "quote"; in the code it is an
-- ESTIMATE, because "quote" already means a signed shipping-rate quote (functions/_lib/quoteToken.js).
--   products.qtyBreaksJson  a product's quantity breaks, [{minQty, offCents}] sorted by minQty: from minQty pieces of
--                           that product in one order, every piece costs offCents less (the deepest break that
--                           applies; db.js qtyBreakOffCents). '[]' = none. Travels in the published catalog with the rest
--                           of the row.
--   estimates               one row per quote: its customer (a customers row, required) and shop, where it stands
--                           (draft → sent → changes / accepted → converted, or cancelled), the note to the customer,
--                           the expiry date (the last day it can be accepted; NULL = no end), and once sent the emailed
--                           link's token (like order_invoices.token) and the tax it was sent with. orderId is the order
--                           it became. number is what people see: "Q-" and a 5-digit sequence (db.js nextEstimateNumber_).
--   estimate_items          its lines: catalog products (priced like a local sale, with breaks, or a unit price staff
--                           typed), custom lines and one-time fees (setup, digitizing, art, other). Prices are kept in
--                           cents as quoted; nothing reprices a line once the quote is sent.
-- ADDITIVE: a new column with a default and two new tables. Nothing existing is read or changed.
ALTER TABLE products ADD COLUMN qtyBreaksJson TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(qtyBreaksJson));

CREATE TABLE IF NOT EXISTS estimates (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  number         TEXT NOT NULL UNIQUE,
  orgId          TEXT NOT NULL REFERENCES orgs(orgId),
  customerId     INTEGER NOT NULL REFERENCES customers(id),
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','changes','accepted','converted','cancelled')),
  title          TEXT NOT NULL DEFAULT '',
  message        TEXT NOT NULL DEFAULT '',
  internalNote   TEXT NOT NULL DEFAULT '',
  expiresOn      TEXT,
  token          TEXT UNIQUE,
  sentAt         TEXT,
  sentTo         TEXT NOT NULL DEFAULT '',
  sendCount      INTEGER NOT NULL DEFAULT 0,
  viewedAt       TEXT,
  respondedAt    TEXT,
  customerNote   TEXT NOT NULL DEFAULT '',
  acceptedAt     TEXT,
  orderId        TEXT REFERENCES orders(orderId),
  convertedAt    TEXT,
  cancelledAt    TEXT,
  taxMode        TEXT NOT NULL DEFAULT 'inclusive' CHECK (taxMode IN ('inclusive','exclusive')),
  taxRateBps     INTEGER NOT NULL DEFAULT 0,
  createdAt      TEXT NOT NULL,
  updatedAt      TEXT NOT NULL,
  createdBy      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_estimates_org_status ON estimates(orgId, status);
CREATE INDEX IF NOT EXISTS idx_estimates_customer ON estimates(customerId);

CREATE TABLE IF NOT EXISTS estimate_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  estimateId     INTEGER NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
  position       INTEGER NOT NULL DEFAULT 0,
  kind           TEXT NOT NULL CHECK (kind IN ('product','custom','fee')),
  productId      TEXT NOT NULL DEFAULT '',
  name           TEXT NOT NULL,
  type           TEXT NOT NULL DEFAULT '',
  size           TEXT NOT NULL DEFAULT '',
  configJson     TEXT NOT NULL DEFAULT '',
  personalized   INTEGER NOT NULL DEFAULT 0,
  persName       TEXT NOT NULL DEFAULT '',
  feeKind        TEXT NOT NULL DEFAULT '' CHECK (feeKind IN ('','setup','digitizing','art','other')),
  qty            INTEGER NOT NULL DEFAULT 1 CHECK (qty > 0 AND qty <= 5000),
  unitPriceCents INTEGER NOT NULL DEFAULT 0 CHECK (unitPriceCents >= 0),
  listUnitCents  INTEGER NOT NULL DEFAULT 0,
  personalizationFeeCents INTEGER NOT NULL DEFAULT 0,
  customPrice    INTEGER NOT NULL DEFAULT 0 CHECK (customPrice IN (0,1)),
  taxable        INTEGER NOT NULL DEFAULT 1 CHECK (taxable IN (0,1)),
  lineTotalCents INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_estimate_items_estimate ON estimate_items(estimateId, position);
