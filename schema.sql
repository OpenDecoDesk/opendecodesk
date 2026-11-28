-- OpenDecoDesk — Cloudflare D1 schema (FRESH INSTALLS ONLY)
-- Existing databases are changed ONLY through migrations/ (wrangler d1
-- migrations apply). This file must always equal "the result of applying every
-- migration" — test33 checks that. Money columns are INTEGER CENTS (*Cents);
-- unset dates are NULL.
-- A new database is built from this file by `npm run setup`, which also records every file in
-- migrations/ as already applied (they are all part of this schema). By hand:
--   node scripts/setup.mjs --print-fresh-sql > fresh.sql
--   npx wrangler d1 execute DB --remote --file fresh.sql

CREATE TABLE IF NOT EXISTS orgs (
  orgId               TEXT PRIMARY KEY,
  subdomain           TEXT NOT NULL UNIQUE,
  name                TEXT NOT NULL,
  eyebrow             TEXT NOT NULL DEFAULT '',
  accent              TEXT NOT NULL DEFAULT '#2563eb',
  desc                TEXT NOT NULL DEFAULT '',
  ready               INTEGER NOT NULL DEFAULT 0,
  shippingEnabled     INTEGER NOT NULL DEFAULT 0,
  enabledPayments     TEXT NOT NULL DEFAULT '{"card":true,"venmo":true,"zelle":true,"check":true}',
  orderDeadline            TEXT DEFAULT NULL,
  closedMessage            TEXT DEFAULT NULL,
  allowOrdersAfterDeadline INTEGER NOT NULL DEFAULT 1,
  designImageShirt    TEXT NOT NULL DEFAULT '',
  designImageCap      TEXT NOT NULL DEFAULT '',
  designImageDetail   TEXT NOT NULL DEFAULT '',
  createdAt           TEXT NOT NULL,
  updatedAt           TEXT NOT NULL,
  -- Sales tax (migrations/0007): tax-exempt purchaser + certificate on file.
  taxExempt            INTEGER NOT NULL DEFAULT 0 CHECK (taxExempt IN (0, 1)),
  taxExemptCertificate TEXT NOT NULL DEFAULT '',
  taxExemptExpires     TEXT,
  -- Configurable products (migrations/0036): per-org option tier prices + default reorder-QR graphic.
  tierPricesJson       TEXT NOT NULL DEFAULT '{"small":100,"medium":200,"large":400}',
  reorderQrGraphicId   INTEGER REFERENCES graphics(id),
  -- Delivery / pickup options the customer picks from (migrations/0045); '' = derived from shippingEnabled.
  deliveryOptionsJson  TEXT NOT NULL DEFAULT '',
  -- The shop's default reorder-QR TRANSFER (migrations/0047); reorderQrGraphicId above is the old way.
  reorderQrTransferId  INTEGER REFERENCES transfers(id),
  -- Rush fee (migrations/0082): '' = the global rule; {"offer":false} or {"offer":true, …its own rule}.
  rushFeeJson          TEXT NOT NULL DEFAULT '',
  -- Fundraiser (migrations/0110): '' = none; {"mode":"percent","percentBps",…} or {"mode":"perPiece","cents",…},
  -- with "label" and "showOnShop". Inside the listed price; changes affect new orders only.
  fundraiserJson       TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS products (
  productId                 TEXT NOT NULL,
  orgId                     TEXT NOT NULL REFERENCES orgs(orgId),
  type                      TEXT NOT NULL,
  name                      TEXT NOT NULL,
  sub                       TEXT NOT NULL DEFAULT '',
  weightOz                  REAL DEFAULT NULL CHECK (weightOz IS NULL OR weightOz >= 0),
  personalizationPriceCents INTEGER DEFAULT NULL CHECK (personalizationPriceCents IS NULL OR personalizationPriceCents >= 0),
  personalizationOptions    TEXT NOT NULL DEFAULT '[]',
  pricingMode               TEXT NOT NULL DEFAULT 'sized' CHECK (pricingMode IN ('flat', 'sized')),
  flatPriceCents            INTEGER DEFAULT NULL CHECK (flatPriceCents IS NULL OR flatPriceCents >= 0),
  sizePricingCents          TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(sizePricingCents)),
  imagesJson                TEXT NOT NULL DEFAULT '[]',
  featuresJson              TEXT NOT NULL DEFAULT '[]',
  visible                   INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0, 1)),
  sortOrder                 INTEGER NOT NULL DEFAULT 0,
  createdAt                 TEXT NOT NULL,
  updatedAt                 TEXT NOT NULL,
  -- Non-taxable products, e.g. embroidery on customer-supplied items (migrations/0013).
  taxable                   INTEGER NOT NULL DEFAULT 1 CHECK (taxable IN (0, 1)),
  -- The product's MAIN design — nullable (migrations/0024); every design is in product_designs (0032).
  designId                  INTEGER REFERENCES designs(id),
  -- migrations/0032: typed-in personalization 'combined' with the main design or its own hooping,
  -- that hooping's hoop, and the pick list's option → design map.
  personalizationMode       TEXT NOT NULL DEFAULT 'combined' CHECK (personalizationMode IN ('combined', 'separate')),
  personalizationHoopId     INTEGER REFERENCES hoops(id),
  personalizationOptionDesigns TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(personalizationOptionDesigns)),
  -- migrations/0034: 1 = no embroidery design needed (e.g. DTF) — the catalog check won't flag it.
  noDesignNeeded            INTEGER NOT NULL DEFAULT 0 CHECK (noDesignNeeded IN (0, 1)),
  blockedGraphicColorsJson  TEXT NOT NULL DEFAULT '[]',
  -- Configurable products (migrations/0036): per-location option menus + reorder-QR selection.
  configurable              INTEGER NOT NULL DEFAULT 0 CHECK (configurable IN (0, 1)),
  garmentColorsJson         TEXT NOT NULL DEFAULT '[]',
  locationsJson             TEXT NOT NULL DEFAULT '[]',
  reorderQr                 TEXT NOT NULL DEFAULT 'default',
  -- migrations/0054: the customer may upload their own design — '' off, 'embroidery' or 'transfer' —
  -- for this add-on per piece (NULL = free).
  customDesign              TEXT NOT NULL DEFAULT '' CHECK (customDesign IN ('', 'embroidery', 'transfer')),
  customDesignPriceCents    INTEGER CHECK (customDesignPriceCents IS NULL OR customDesignPriceCents >= 0),
  -- migrations/0057: 1 = made with no blank at all (a patch: twill and thread are shop supplies), so
  -- its order lines skip the blank steps and nothing is ordered, received or counted for it.
  noBlankNeeded             INTEGER NOT NULL DEFAULT 0 CHECK (noBlankNeeded IN (0, 1)),
  -- migrations/0059: versions of a product (short / long sleeve…) — products of one shop sharing a
  -- non-empty versionGroup are shown as one card with a toggle; versionLabel names this one.
  versionGroup              TEXT NOT NULL DEFAULT '',
  versionLabel              TEXT NOT NULL DEFAULT '',
  -- migrations/0062: when its prices were last set or confirmed against its blanks' vendor prices.
  pricesReviewedAt          TEXT,
  -- migrations/0064: color price groups — [{key, label, colors, sizePricingCents | flatPriceCents}]; a color in
  -- no group takes the product's own prices (the Standard group).
  colorGroupsJson           TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(colorGroupsJson)),
  -- migrations/0067: pricing awareness — minutes to make one item, extra DTF / transfer cost per item, and an
  -- override of the global shop-supplies cost per item (all optional).
  runMinutes                REAL,
  transferCostCents         INTEGER,
  suppliesCostCents         INTEGER,
  -- migrations/0068: printed transfers (DTF) that are part of the product, in its price — [{locationId, graphicId, ink}].
  fixedTransfersJson        TEXT NOT NULL DEFAULT '[]',
  -- migrations/0069: embroidered graphics shown on mockups only — [{locationId, graphicId}].
  mockupGraphicsJson        TEXT NOT NULL DEFAULT '[]',
  -- migrations/0086: sold as files (digital) and its own delivery settings ('{}' = the global ones).
  digital                   INTEGER NOT NULL DEFAULT 0 CHECK (digital IN (0, 1)),
  digitalDeliveryJson       TEXT NOT NULL DEFAULT '{}',
  -- migrations/0109: quantity breaks — [{minQty, offCents}] sorted by minQty; from minQty pieces of this product in
  -- one order, each piece costs offCents less (the deepest break that applies). '[]' = none.
  qtyBreaksJson             TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(qtyBreaksJson)),
  -- migrations/0118: the product's own decoration; '' = worked out from its design / transfers (productDecoration_).
  decorationType            TEXT NOT NULL DEFAULT '' CHECK (decorationType IN ('', 'embroidery', 'dtf', 'screenprint', 'vinyl', 'dtg', 'sublimation')),
  PRIMARY KEY (orgId, productId)
);

CREATE TABLE IF NOT EXISTS global_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- System problems and failed admin sign-ins for the daily roll-up (migrations/0096): one row per failure, so
-- failures at the same moment are each counted; the roll-up deletes only the rows it reported (id <= the highest
-- it read). n: how many failures the row stands for (1; totals carried over from before 0096; 0 = a sample only).
CREATE TABLE IF NOT EXISTS system_issues (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  kind    TEXT    NOT NULL,
  n       INTEGER NOT NULL DEFAULT 1 CHECK (n >= 0),
  sample  TEXT    NOT NULL DEFAULT '',
  at      TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS failed_admin_logins (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  reason  TEXT    NOT NULL DEFAULT 'passphrase' CHECK (reason IN ('passphrase', 'code')),
  ip      TEXT    NOT NULL DEFAULT '',
  n       INTEGER NOT NULL DEFAULT 1 CHECK (n >= 0),
  at      TEXT    NOT NULL
);

-- Admin sessions (migrations/0043): one row per signed-in session, keyed by the SHA-256 of the token.
-- userId: whose it is. pending: a step that user must finish before anything else is answered
-- ('account' | 'password' | '2fa'), else NULL (migrations/0053).
CREATE TABLE IF NOT EXISTS admin_sessions (
  tokenHash TEXT PRIMARY KEY,
  expiresAt TEXT NOT NULL,
  userId    INTEGER,
  pending   TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON admin_sessions(expiresAt);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_user ON admin_sessions(userId);

-- Users and roles (migrations/0053). role: a roles.key (migrations/0089). status: 'active' |
-- 'disabled' (never deleted, so history keeps its attribution). password: the salted, keyed hash
-- record (functions/_lib/adminAuth.js). recoveryCodes: JSON array of hashes. A new install has no
-- rows: the first sign-in with the installer's passphrase creates the first admin.
CREATE TABLE IF NOT EXISTS users (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  email              TEXT    NOT NULL DEFAULT '',
  name               TEXT    NOT NULL DEFAULT '',
  role               TEXT    NOT NULL DEFAULT 'staff',
  status             TEXT    NOT NULL DEFAULT 'active',
  password           TEXT,
  mustChangePassword INTEGER NOT NULL DEFAULT 0,
  totpSecret         TEXT,
  totpLastCounter    INTEGER,
  recoveryCodes      TEXT,
  createdAt          TEXT    NOT NULL,
  updatedAt          TEXT    NOT NULL,
  lastLoginAt        TEXT,
  prefs              TEXT     -- the user's own settings, JSON; NULL = defaults (0091)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email <> '';

-- Roles (migrations/0089): what each role sees and may do (functions/_lib/permissions.js). Seeds included.
CREATE TABLE IF NOT EXISTS roles (
  key         TEXT    PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 40),
  name        TEXT    NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 40),
  rank        INTEGER NOT NULL CHECK (rank BETWEEN 1 AND 100),
  builtIn     INTEGER NOT NULL DEFAULT 0 CHECK (builtIn IN (0, 1)),
  locked      INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
  permissions TEXT,
  createdAt   TEXT    NOT NULL,
  updatedAt   TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_roles_name ON roles(name COLLATE NOCASE);
INSERT OR IGNORE INTO roles (key, name, rank, builtIn, locked, permissions, createdAt, updatedAt) VALUES
  ('admin',      'Admin',       100, 1, 1, NULL, '2026-11-18T00:00:00.000Z', '2026-11-18T00:00:00.000Z'),
  ('manager',    'Manager',      75, 1, 0, NULL, '2026-11-18T00:00:00.000Z', '2026-11-18T00:00:00.000Z'),
  ('staff',      'Back office',  50, 1, 0, NULL, '2026-11-18T00:00:00.000Z', '2026-11-18T00:00:00.000Z'),
  ('production', 'Production',   25, 1, 0, NULL, '2026-11-18T00:00:00.000Z', '2026-11-18T00:00:00.000Z');

-- Accounts money moves through (migrations/0014). Seeds included.
CREATE TABLE IF NOT EXISTS accounts (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(trim(name)) > 0),
  type                TEXT NOT NULL CHECK (type IN ('checking', 'credit_card', 'venmo', 'cash', 'stripe', 'other')),
  openingBalanceCents INTEGER NOT NULL DEFAULT 0,
  openingDate         TEXT NOT NULL DEFAULT '2026-01-01' CHECK (openingDate GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  active              INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  createdAt           TEXT NOT NULL,
  updatedAt           TEXT NOT NULL,
  csvMapping          TEXT NOT NULL DEFAULT ''   -- statement CSV column mapping (0015)
);
INSERT OR IGNORE INTO accounts (id, name, type, createdAt, updatedAt) VALUES
  (1, 'Business checking', 'checking',    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  (2, 'Credit card',       'credit_card', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  (3, 'Venmo',             'venmo',       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  (4, 'Cash on hand',      'cash',        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  (5, 'Stripe balance',    'stripe',      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));


-- Customer records (migrations/0108). An order belongs to one through orders.customerId (NULL when its contact is a
-- phone number or nothing). email is trimmed and lower case, '' when there is none; addressJson is '' or the same JSON
-- as orders.shippingAddress. Never deleted: archivedAt hides one, mergedIntoId says which customer a duplicate was
-- folded into. A customer's tax exemption makes its orders exempt, like a shop's (db.js insertOrder).
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
  -- migrations/0121 (written as its ALTERs leave it): may pick Net 30 at checkout, and their days (NULL = the default)
  , allowNet30 INTEGER NOT NULL DEFAULT 0 CHECK (allowNet30 IN (0, 1)), termsDays INTEGER CHECK (termsDays IS NULL OR termsDays BETWEEN 1 AND 365));
-- One customer per email, leaving out the ones merged away.
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_email ON customers(email) WHERE email <> '' AND mergedIntoId IS NULL;

CREATE TABLE IF NOT EXISTS orders (
  orderId             TEXT PRIMARY KEY,
  orgId               TEXT NOT NULL REFERENCES orgs(orgId),
  customerName        TEXT NOT NULL,
  contact             TEXT NOT NULL,
  paymentMethod       TEXT NOT NULL DEFAULT '',
  -- Cached from the payments ledger by refreshPaidStatus() in db.js — the
  -- ledger (order_payments) is the source of truth.
  paid                INTEGER NOT NULL DEFAULT 0 CHECK (paid IN (0, 1)),
  paidAt              TEXT,
  refundedAt          TEXT,
  disputeStatus       TEXT NOT NULL DEFAULT '',
  subtotalCents       INTEGER NOT NULL DEFAULT 0 CHECK (subtotalCents >= 0),
  shippingCostCents   INTEGER NOT NULL DEFAULT 0 CHECK (shippingCostCents >= 0),
  totalCents          INTEGER NOT NULL DEFAULT 0 CHECK (totalCents >= 0),
  shippingMethod      TEXT NOT NULL DEFAULT '',
  shippingAddress     TEXT CHECK (shippingAddress IS NULL OR json_valid(shippingAddress)),
  shipState           TEXT GENERATED ALWAYS AS (
                        CASE WHEN json_valid(shippingAddress)
                             THEN upper(trim(json_extract(shippingAddress, '$.state'))) END) VIRTUAL,
  shipZip             TEXT GENERATED ALWAYS AS (
                        CASE WHEN json_valid(shippingAddress)
                             THEN substr(trim(json_extract(shippingAddress, '$.zip')), 1, 5) END) VIRTUAL,
  totalWeightOz       REAL NOT NULL DEFAULT 0 CHECK (totalWeightOz >= 0),
  parcelLength        REAL NOT NULL DEFAULT 0,
  parcelWidth         REAL NOT NULL DEFAULT 0,
  parcelHeight        REAL NOT NULL DEFAULT 0,
  shippingPaidCents   INTEGER NOT NULL DEFAULT 0 CHECK (shippingPaidCents >= 0),
  discountCents       INTEGER NOT NULL DEFAULT 0 CHECK (discountCents >= 0),
  discountNote        TEXT NOT NULL DEFAULT '',
  trackingNumber      TEXT NOT NULL DEFAULT '',
  receivedEmailAt     TEXT,
  confirmedEmailAt    TEXT,
  blankOrderedAt      TEXT,
  blankVendor         TEXT NOT NULL DEFAULT '',
  blankVendorOrderId  TEXT NOT NULL DEFAULT '',
  blankEstDelivery    TEXT,
  blankReceivedAt     TEXT,
  blankCondition      TEXT NOT NULL DEFAULT '',
  manufacturedAt      TEXT,
  digitizingCompleteAt TEXT,
  designApprovedAt    TEXT,
  qaPackedAt          TEXT,
  shippedAt           TEXT,
  deliveredAt         TEXT,
  placedAt            TEXT NOT NULL,
  -- Sales tax snapshot (migrations/0007): prices are tax-inclusive.
  taxExempt           INTEGER NOT NULL DEFAULT 0 CHECK (taxExempt IN (0, 1)),
  taxRateBps          INTEGER NOT NULL DEFAULT 0 CHECK (taxRateBps BETWEEN 0 AND 1500),
  discountTaxCents    INTEGER NOT NULL DEFAULT 0 CHECK (discountTaxCents >= 0),
  -- Voided (never deleted) orders and explicit test flag (migrations/0010).
  voidedAt            TEXT,
  voidReason          TEXT NOT NULL DEFAULT '',
  isTest              INTEGER NOT NULL DEFAULT 0 CHECK (isTest IN (0, 1)),
  -- When the order was closed out — delivered and paid in full (migrations/0016). NULL = open.
  completedAt         TEXT,
  insertedAt          TEXT,
  dueDate             TEXT,                       -- migrations/0038: optional; prioritizes the run queues
  -- Whether sales tax is included in the listed prices or added on top — a snapshot of the store
  -- setting when the order was placed (migrations/0052).
  taxMode             TEXT NOT NULL DEFAULT 'inclusive' CHECK (taxMode IN ('inclusive', 'exclusive')),
  -- Rush fee (migrations/0082): asked for, the fee (0 while still to follow), its tax, and `paid` leaving it out.
  rushRequested       INTEGER NOT NULL DEFAULT 0 CHECK (rushRequested IN (0, 1)),
  rushFeeCents        INTEGER NOT NULL DEFAULT 0 CHECK (rushFeeCents >= 0),
  rushFeePending      INTEGER NOT NULL DEFAULT 0 CHECK (rushFeePending IN (0, 1)),
  rushFeeTaxable      INTEGER NOT NULL DEFAULT 0 CHECK (rushFeeTaxable IN (0, 1)),
  rushFeeTaxCents     INTEGER NOT NULL DEFAULT 0 CHECK (rushFeeTaxCents >= 0),
  paidForWork         INTEGER NOT NULL DEFAULT 0 CHECK (paidForWork IN (0, 1)),
  rushPayBy           TEXT,                       -- migrations/0083: full payment due by (YYYY-MM-DD) to keep a rush date
  downloadSalt        TEXT,                       -- migrations/0086: makes the order's download link (http.js downloadToken)
  downloadsEmailedAt  TEXT,                       -- migrations/0086: when the "Your downloads" email went out
  source              TEXT NOT NULL DEFAULT '',   -- migrations/0087: '' = made here; 'etsy' / 'shopify' / 'csv' = imported
  externalOrderId     TEXT,                       -- migrations/0087: the store's own order number
  payOnDelivery       INTEGER NOT NULL DEFAULT 0 CHECK (payOnDelivery IN (0, 1)),  -- migrations/0105: steps go on before it's paid
  customerId          INTEGER REFERENCES customers(id),  -- migrations/0108: the customer it belongs to; NULL = none
  trackingCheckedAt   TEXT                        -- migrations/0111: the delivery check's last tracking lookup (least recent first)
  , reorderOf           TEXT NOT NULL DEFAULT ''   -- migrations/0120: the order a Local sale was copied from ('' = none)
  , shippingDiscountCents INTEGER NOT NULL DEFAULT 0 CHECK (shippingDiscountCents >= 0)  -- migrations/0120: what free-shipping codes took off shipping
  -- Net 30 terms (migrations/0121): cleared for work once a PO is accepted (db.js net30Cleared); the due date is
  -- worked out when read (net30DueDate_), never stored. invoicedAt = the FIRST invoice send.
  , net30               INTEGER NOT NULL DEFAULT 0 CHECK (net30 IN (0, 1))
  , poNumber            TEXT NOT NULL DEFAULT ''
  , poAcceptedAt        TEXT
  , poAcceptedBy        TEXT NOT NULL DEFAULT ''
  , poTypedAt           TEXT                      -- when the customer typed the PO (waits for Accept PO)
  , termsDays           INTEGER CHECK (termsDays IS NULL OR termsDays BETWEEN 1 AND 365)  -- NULL = the default days
  , invoicedAt          TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_net30 ON orders(net30) WHERE net30 = 1;

CREATE TABLE IF NOT EXISTS order_items (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  orderId                 TEXT NOT NULL REFERENCES orders(orderId) ON DELETE CASCADE,
  orgId                   TEXT NOT NULL,
  productId               TEXT NOT NULL DEFAULT '',
  name                    TEXT NOT NULL,
  type                    TEXT NOT NULL,
  size                    TEXT NOT NULL DEFAULT '',
  qty                     INTEGER NOT NULL DEFAULT 1 CHECK (qty > 0),
  unitPriceCents          INTEGER NOT NULL DEFAULT 0 CHECK (unitPriceCents >= 0),
  personalized            INTEGER NOT NULL DEFAULT 0 CHECK (personalized IN (0, 1)),
  persName                TEXT NOT NULL DEFAULT '',
  personalizationFeeCents INTEGER NOT NULL DEFAULT 0 CHECK (personalizationFeeCents >= 0),
  lineTotalCents          INTEGER NOT NULL DEFAULT 0 CHECK (lineTotalCents >= 0),
  cancelDate              TEXT,
  cancelReason            TEXT NOT NULL DEFAULT '',
  lateCancel              INTEGER NOT NULL DEFAULT 0 CHECK (lateCancel IN (0, 1)),
  refundDate              TEXT,
  refundCents             INTEGER CHECK (refundCents IS NULL OR refundCents >= 0),
  blankCondition          TEXT NOT NULL DEFAULT '',
  blankConditionNote      TEXT NOT NULL DEFAULT '',
  -- Sales tax backed out of lineTotalCents (migrations/0007).
  taxRateBps              INTEGER NOT NULL DEFAULT 0 CHECK (taxRateBps BETWEEN 0 AND 1500),
  taxCents                INTEGER NOT NULL DEFAULT 0 CHECK (taxCents >= 0),
  -- Blank cost of this line (migrations/0009): 'consumed' when manufactured,
  -- 'estimate' for lines made before inventory tracking; NULL = unknown.
  cogsCents               INTEGER CHECK (cogsCents IS NULL OR cogsCents >= 0),
  cogsSource              TEXT    CHECK (cogsSource IS NULL OR cogsSource IN ('consumed', 'estimate')),
  -- Snapshot of whether the line's product is taxable (migrations/0013).
  taxable                 INTEGER NOT NULL DEFAULT 1 CHECK (taxable IN (0, 1)),
  -- Per-piece manufacture progress (migrations/0029): pieces of `qty` already run.
  manufacturedQty         INTEGER NOT NULL DEFAULT 0 CHECK (manufacturedQty >= 0),
  -- Configurable line snapshot + transfer-received gate (migrations/0036).
  configJson              TEXT NOT NULL DEFAULT '',
  transferReceivedAt      TEXT,
  -- Per-line-item blank fulfillment (migrations/0039): source of truth; orders.blank* are derived
  -- summaries. Vendor fields set at "blank ordered"; carrier/tracking live in blank_shipments.
  blankOrderedAt          TEXT,
  blankShippedAt          TEXT,
  blankReceivedAt         TEXT,
  blankVendor             TEXT NOT NULL DEFAULT '',
  blankVendorOrderId      TEXT NOT NULL DEFAULT '',
  blankEstDelivery        TEXT,
  -- migrations/0048: when this line's transfers were pressed, for a line that is also embroidered.
  transfersAppliedAt  TEXT,
  -- migrations/0060: filled from the shop's finished stock (no blank / design / making steps).
  fromStock           INTEGER NOT NULL DEFAULT 0 CHECK (fromStock IN (0, 1)),
  -- migrations/0080: the combination (ready_to_ship.variant) a line filled from stock came from.
  stockVariant        TEXT NOT NULL DEFAULT '',
  -- migrations/0110: what this line raises for its shop's fundraiser, worked out when it was priced; 0 = none.
  fundraiserCents     INTEGER NOT NULL DEFAULT 0 CHECK (fundraiserCents >= 0),
  -- migrations/0118: Start / Mark made of a screen print, vinyl, DTG or sublimation line (like transfersAppliedAt).
  decStartedAt        TEXT,
  decMadeAt           TEXT
  -- migrations/0121: the customer's own garment (no blank, no blank cost; production waits for ownReceivedAt).
  , customerOwned       INTEGER NOT NULL DEFAULT 0 CHECK (customerOwned IN (0, 1))
  , ownReceivedAt       TEXT
);

CREATE TABLE IF NOT EXISTS design_verifications (
  token              TEXT PRIMARY KEY,
  orgId              TEXT NOT NULL,
  orderId            TEXT NOT NULL REFERENCES orders(orderId) ON DELETE CASCADE,
  customerEmail      TEXT NOT NULL,
  customerName       TEXT NOT NULL DEFAULT '',
  message            TEXT NOT NULL DEFAULT '',
  imagesJson         TEXT NOT NULL DEFAULT '[]',
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'revision')),
  customerNote       TEXT NOT NULL DEFAULT '',
  customerImagesJson TEXT NOT NULL DEFAULT '[]',
  sentAt             TEXT NOT NULL,
  respondedAt        TEXT,
  uploadCount        INTEGER NOT NULL DEFAULT 0 CHECK (uploadCount >= 0)
);

-- Invoices the customer can open, choose delivery on and pay online (migrations/0053): one per
-- order; the emailed link is /?invoice=<token> on the shop's own address. Sending again keeps the token.
CREATE TABLE IF NOT EXISTS order_invoices (
  token            TEXT PRIMARY KEY,
  orderId          TEXT NOT NULL UNIQUE REFERENCES orders(orderId) ON DELETE CASCADE,
  orgId            TEXT NOT NULL,
  sentTo           TEXT NOT NULL DEFAULT '',
  message          TEXT NOT NULL DEFAULT '',
  allowDelivery    INTEGER NOT NULL DEFAULT 1 CHECK (allowDelivery IN (0, 1)),
  sentAt           TEXT NOT NULL,
  sendCount        INTEGER NOT NULL DEFAULT 1 CHECK (sendCount >= 1),
  viewedAt         TEXT,
  deliveryChosenAt TEXT,
  deliveryChoice   TEXT NOT NULL DEFAULT ''
);

-- Quotes (migrations/0109) — "estimates" in the code, since a "quote" there is a shipping-rate quote. One per quote for
-- a customer in a shop: draft → sent → changes / accepted → converted (orderId = the order it became), or cancelled.
-- number is what people see ("Q-00012"); token is the emailed link's credential once sent, like order_invoices.token;
-- expiresOn is the last day it can be accepted (NULL = no end); taxMode / taxRateBps are the tax it was sent with.
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
  , discountCodes TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(discountCodes)));  -- migrations/0120: the codes typed on the quote
CREATE INDEX IF NOT EXISTS idx_estimates_org_status ON estimates(orgId, status);
CREATE INDEX IF NOT EXISTS idx_estimates_customer ON estimates(customerId);
-- A quote's lines: a catalog product, a custom line or a one-time fee (feeKind). Prices in cents as quoted —
-- unitPriceCents after any quantity break, listUnitCents before it — and never repriced once the quote is sent.
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
  -- migrations/0121 (written as its ALTER leaves it): the line is on the customer's own garment
  , customerOwned INTEGER NOT NULL DEFAULT 0 CHECK (customerOwned IN (0, 1)));
CREATE INDEX IF NOT EXISTS idx_estimate_items_estimate ON estimate_items(estimateId, position);

-- Discount codes (migrations/0115): a code a customer types at checkout, a percent (percentBps) or an amount
-- (amountCents) off the goods, for every shop (orgId NULL) or one. email '' = anyone, up to maxUses times in all
-- (oncePerEmail: once per address); else that one address (lower-case), once. expiresOn = the last day it works.
-- The discount itself is stored on the order like a manual one (discountNote "Code SAVE10"). maxDiscountCents
-- (migrations/0116, an ALTER, so it sits after createdBy just as SQLite writes it): the most a percent code takes off.
-- migrations/0120 (ALTERs too): minOrderCents (the goods must come to at least this; NULL = none), freeShipping (the
-- code also makes shipping free) and goodsOff (0 = takes nothing off the goods: a "free shipping only" code is percent
-- 10000 with goodsOff 0 and freeShipping 1).
CREATE TABLE IF NOT EXISTS discount_codes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('percent','amount')),
  percentBps   INTEGER,
  amountCents  INTEGER,
  orgId        TEXT REFERENCES orgs(orgId),
  email        TEXT NOT NULL DEFAULT '',
  maxUses      INTEGER NOT NULL CHECK (maxUses >= 1),
  oncePerEmail INTEGER NOT NULL DEFAULT 0,
  expiresOn    TEXT,
  active       INTEGER NOT NULL DEFAULT 1,
  note         TEXT NOT NULL DEFAULT '',
  createdAt    TEXT NOT NULL,
  createdBy    TEXT NOT NULL DEFAULT '',
  maxDiscountCents INTEGER CHECK (maxDiscountCents IS NULL OR maxDiscountCents BETWEEN 1 AND 1000000),
  minOrderCents INTEGER CHECK (minOrderCents IS NULL OR minOrderCents BETWEEN 1 AND 10000000),
  freeShipping INTEGER NOT NULL DEFAULT 0 CHECK (freeShipping IN (0, 1)),
  goodsOff     INTEGER NOT NULL DEFAULT 1 CHECK (goodsOff IN (0, 1)),
  CHECK ((kind = 'percent' AND percentBps IS NOT NULL AND percentBps BETWEEN 1 AND 10000 AND amountCents IS NULL)
      OR (kind = 'amount' AND amountCents IS NOT NULL AND amountCents BETWEEN 1 AND 1000000 AND percentBps IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_discount_codes_code ON discount_codes(code);
-- One row per order that used a code, claimed just before the order is inserted (so no FK to orders) by one
-- conditional INSERT that counts the live uses. A voided or deleted order gives the use back: releasedAt is set.
CREATE TABLE IF NOT EXISTS discount_code_uses (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  codeId       INTEGER NOT NULL REFERENCES discount_codes(id),
  orderId      TEXT NOT NULL,
  email        TEXT NOT NULL DEFAULT '',
  amountCents  INTEGER NOT NULL DEFAULT 0,
  usedAt       TEXT NOT NULL,
  releasedAt   TEXT
);
-- migrations/0120: one use per (order, code), so an order may carry several codes when the shop's rule allows.
CREATE UNIQUE INDEX IF NOT EXISTS idx_discount_uses_order_code ON discount_code_uses(orderId, codeId);
CREATE INDEX IF NOT EXISTS idx_discount_uses_order ON discount_code_uses(orderId);
CREATE INDEX IF NOT EXISTS idx_discount_uses_code ON discount_code_uses(codeId) WHERE releasedAt IS NULL;

-- Gift cards (migrations/0120): a PAYMENT, never a discount, and a liability until spent. See the migration.
CREATE TABLE IF NOT EXISTS gift_cards (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT NOT NULL,
  last4          TEXT NOT NULL,
  initialCents   INTEGER NOT NULL CHECK (initialCents BETWEEN 100 AND 100000000),
  balanceCents   INTEGER NOT NULL CHECK (balanceCents >= 0),
  recipientName  TEXT NOT NULL DEFAULT '',
  recipientEmail TEXT NOT NULL DEFAULT '',
  buyerName      TEXT NOT NULL DEFAULT '',
  buyerEmail     TEXT NOT NULL DEFAULT '',
  message        TEXT NOT NULL DEFAULT '',
  sourceOrderId  TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'void')),
  note           TEXT NOT NULL DEFAULT '',
  createdAt      TEXT NOT NULL,
  createdBy      TEXT NOT NULL DEFAULT '',
  voidedAt       TEXT,
  issueRequestId TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gift_cards_code ON gift_cards(code);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gift_cards_source ON gift_cards(sourceOrderId) WHERE sourceOrderId <> '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_gift_cards_request ON gift_cards(issueRequestId) WHERE issueRequestId IS NOT NULL;
CREATE TABLE IF NOT EXISTS gift_card_ledger (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  cardId      INTEGER NOT NULL REFERENCES gift_cards(id),
  kind        TEXT NOT NULL CHECK (kind IN ('issue', 'redeem', 'refund', 'adjust', 'void')),
  deltaCents  INTEGER NOT NULL,
  orderId     TEXT NOT NULL DEFAULT '',
  paymentId   INTEGER,
  note        TEXT NOT NULL DEFAULT '',
  at          TEXT NOT NULL,
  by          TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_gift_card_ledger_card ON gift_card_ledger(cardId, id);

-- Customer-supplied garments checked in (migrations/0121): one row per size counted for a customer-owned line. A
-- re-count voids the line's earlier rows (voidedAt) and writes new ones; db.js checkInGarments.
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

-- Email campaigns (migrations/0117): addresses that asked for no marketing email, the campaigns, and who each
-- one went to. See the migration for the rules.
CREATE TABLE IF NOT EXISTS marketing_optouts (
  email        TEXT PRIMARY KEY,
  optedOutAt   TEXT NOT NULL,
  source       TEXT NOT NULL CHECK (source IN ('checkout','unsubscribe','reply','admin'))
);
CREATE TABLE IF NOT EXISTS email_campaigns (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL DEFAULT '',
  subject      TEXT NOT NULL DEFAULT '',
  preheader    TEXT NOT NULL DEFAULT '',
  theme        TEXT NOT NULL DEFAULT 'plain',
  designJson   TEXT NOT NULL DEFAULT '{}',
  audienceJson TEXT NOT NULL DEFAULT '{}',
  discountJson TEXT NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','sending','sent','canceled')),
  scheduledAt  TEXT,
  startedAt    TEXT,
  sentAt       TEXT,
  createdAt    TEXT NOT NULL,
  createdBy    TEXT NOT NULL DEFAULT '',
  updatedAt    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_campaigns_status ON email_campaigns(status, scheduledAt);
CREATE TABLE IF NOT EXISTS email_campaign_recipients (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  campaignId   INTEGER NOT NULL REFERENCES email_campaigns(id),
  email        TEXT NOT NULL,
  name         TEXT NOT NULL DEFAULT '',
  code         TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','failed','skipped')),
  sentAt       TEXT,
  error        TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_recipients_email ON email_campaign_recipients(campaignId, email);
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_queue ON email_campaign_recipients(status, campaignId);

-- Legacy inventory table (superseded by blanks/blank_sizes — kept for existing data)
CREATE TABLE IF NOT EXISTS inventory (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  productType   TEXT NOT NULL DEFAULT '',
  vendor        TEXT NOT NULL DEFAULT '',
  brand         TEXT NOT NULL DEFAULT '',
  sku           TEXT NOT NULL DEFAULT '',
  color         TEXT NOT NULL DEFAULT '',
  size          TEXT NOT NULL DEFAULT '',
  purchasePrice REAL NOT NULL DEFAULT 0,
  quantity      INTEGER NOT NULL DEFAULT 0,
  notes         TEXT NOT NULL DEFAULT '',
  createdAt     TEXT NOT NULL,
  updatedAt     TEXT NOT NULL
);

-- Blank catalog — one row per style/color (e.g. "Gildan 18500 Hoodie, Sport Grey")
CREATE TABLE IF NOT EXISTS blanks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL DEFAULT '',
  productType  TEXT NOT NULL DEFAULT '',
  vendor       TEXT NOT NULL DEFAULT '',
  brand        TEXT NOT NULL DEFAULT '',
  sku          TEXT NOT NULL DEFAULT '',
  color        TEXT NOT NULL DEFAULT '',
  notes        TEXT NOT NULL DEFAULT '',
  createdAt    TEXT NOT NULL,
  updatedAt    TEXT NOT NULL,
  needleTypeId INTEGER REFERENCES needle_types(id),  -- migrations/0044; NULL = not set
  -- migrations/0060: a blank TYPE bought for testing / shop use (still inventory — it could be sold).
  forTesting   INTEGER NOT NULL DEFAULT 0 CHECK (forTesting IN (0, 1)),
  -- migrations/0062: when its vendor prices were last checked (the 30-day reminder).
  pricesCheckedAt TEXT,
  -- migrations/0063: content from its vendor — description, bullet points, and where it came from.
  description  TEXT NOT NULL DEFAULT '',
  featuresJson TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(featuresJson)),
  sourceJson   TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(sourceJson)),
  -- migrations/0065: the vendor connection its prices and content come from.
  vendorConnectionId INTEGER,
  -- migrations/0104: when it was archived (retired) — off the Blanks screen, product linking and vendor matching.
  archivedAt TEXT
);

-- A blank's colors (migrations/0037): authoritative per-color record — name,
-- ordered images, sort — even for a color with no stock yet. Color is now a
-- dimension of a blank (like size); one blank holds many colors x sizes.
CREATE TABLE IF NOT EXISTS blank_colors (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  blankId    INTEGER NOT NULL REFERENCES blanks(id) ON DELETE CASCADE,
  color      TEXT NOT NULL DEFAULT '',
  imagesJson TEXT NOT NULL DEFAULT '[]',
  sortOrder  INTEGER NOT NULL DEFAULT 0,
  createdAt  TEXT NOT NULL,
  updatedAt  TEXT NOT NULL,
  UNIQUE (blankId, color)
);

-- Per-color, per-size stock and purchase price for each blank (migrations/0037
-- added the color dimension; the UNIQUE key widened from (blankId, size)).
CREATE TABLE IF NOT EXISTS blank_sizes (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  blankId            INTEGER NOT NULL REFERENCES blanks(id) ON DELETE CASCADE,
  color              TEXT NOT NULL DEFAULT '',
  size               TEXT NOT NULL DEFAULT '',
  purchasePriceCents INTEGER NOT NULL DEFAULT 0 CHECK (purchasePriceCents >= 0),
  quantity           INTEGER NOT NULL DEFAULT 0,
  -- migrations/0062: the vendor's price, entered by hand (NULL = not entered) — purchasePriceCents
  -- above is the average cost of the pieces on hand. History in blank_vendor_prices.
  vendorPriceCents   INTEGER CHECK (vendorPriceCents IS NULL OR vendorPriceCents >= 0),
  vendorPriceAt      TEXT,
  -- migrations/0070: the vendor's minimum advertised price (NULL = none) — a product's price for a linked size can't
  -- be below it.
  mapPriceCents      INTEGER CHECK (mapPriceCents IS NULL OR mapPriceCents >= 0),
  -- migrations/0074: keep at least this many free (NULL = no reorder point).
  reorderPoint       INTEGER CHECK (reorderPoint IS NULL OR reorderPoint >= 0),
  -- migrations/0077: one piece's weight in ounces (NULL = not known); products.weightOz overrides it.
  weightOz           REAL CHECK (weightOz IS NULL OR weightOz >= 0),
  UNIQUE (blankId, color, size)
);

-- The vendor list (migrations/0084): every vendor picked on a blank, receipt, transfer sheet, expense, blank order,
-- shipment or supplier / restock order. Records store the vendor's name (renaming one renames them). freeShipOverCents
-- 0 = every order ships free, NULL = not by amount; freeShipMinQty NULL = not by pieces; noFreeShipping overrides both.
CREATE TABLE IF NOT EXISTS vendors (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT    NOT NULL,
  forBlanks         INTEGER NOT NULL DEFAULT 0 CHECK (forBlanks IN (0, 1)),
  freeShipOverCents INTEGER CHECK (freeShipOverCents IS NULL OR freeShipOverCents >= 0),
  freeShipMinQty    INTEGER CHECK (freeShipMinQty IS NULL OR freeShipMinQty >= 1),
  noFreeShipping    INTEGER NOT NULL DEFAULT 0 CHECK (noFreeShipping IN (0, 1)),
  hidden            INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  createdAt         TEXT    NOT NULL,
  updatedAt         TEXT    NOT NULL,
  forDigitizing     INTEGER NOT NULL DEFAULT 0 CHECK (forDigitizing IN (0, 1))  -- digitizes designs (0118)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vendors_name ON vendors (name COLLATE NOCASE);

-- Every vendor price entered (migrations/0062), append-only; priceCents NULL = cleared.
CREATE TABLE IF NOT EXISTS blank_vendor_prices (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  blankId       INTEGER NOT NULL,
  color         TEXT    NOT NULL DEFAULT '',
  size          TEXT    NOT NULL DEFAULT '',
  priceCents    INTEGER CHECK (priceCents IS NULL OR priceCents >= 0),
  previousCents INTEGER,
  enteredAt     TEXT    NOT NULL,
  actor         TEXT    NOT NULL DEFAULT '',
  note          TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_bvp_size ON blank_vendor_prices (blankId, color, size, enteredAt);

-- Links a product's color+size to a specific blank color+size (for inventory
-- tracking). productColor '' = a classic (single-color) product. migrations/0037
-- added productColor/blankColor; the UNIQUE key widened to include productColor.
CREATE TABLE IF NOT EXISTS product_blank_links (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  orgId        TEXT NOT NULL,
  productId    TEXT NOT NULL,
  productColor TEXT NOT NULL DEFAULT '',
  productSize  TEXT NOT NULL DEFAULT '',
  blankId      INTEGER NOT NULL REFERENCES blanks(id) ON DELETE CASCADE,
  blankColor   TEXT NOT NULL DEFAULT '',
  blankSize    TEXT NOT NULL DEFAULT '',
  UNIQUE (orgId, productId, productColor, productSize)
);

-- Thread catalog — one row per thread color, shared across every shop (like blanks). Imported
-- from a vendor's Hatch (.tch) chart export or entered by hand. migrations/0021. Unique key
-- widened to (brand, type, weight, code) by migrations/0023 — a code is only unique within its
-- own type+weight line (e.g. Madeira PolyNeon 40 code 1538 and Madeira Rayon 40 code 1538 are
-- different, real threads).
CREATE TABLE IF NOT EXISTS threads (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  brand       TEXT NOT NULL DEFAULT '',
  type        TEXT NOT NULL DEFAULT '',
  weight      TEXT NOT NULL DEFAULT '',
  code        TEXT NOT NULL DEFAULT '',
  name        TEXT NOT NULL DEFAULT '',
  colorHex    TEXT NOT NULL DEFAULT '' CHECK (colorHex = '' OR (length(colorHex) = 6)),
  sourceFlag  TEXT NOT NULL DEFAULT '',
  notes       TEXT NOT NULL DEFAULT '',
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL,
  UNIQUE (brand, type, weight, code)
);
CREATE INDEX IF NOT EXISTS idx_threads_brand_type_weight ON threads(brand, type, weight);

-- Thread inventory: a shared spool-size catalog (description + length in whole metres) and
-- per-thread stock — each thread can hold several inventory items at different spool sizes.
-- migrations/0028.
CREATE TABLE IF NOT EXISTS spool_sizes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  description TEXT NOT NULL DEFAULT '',
  meters      INTEGER NOT NULL DEFAULT 0 CHECK (meters >= 0),
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS thread_inventory (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  threadId    INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  spoolSizeId INTEGER REFERENCES spool_sizes(id),
  quantity    INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_thread_inventory_thread ON thread_inventory(threadId);
CREATE INDEX IF NOT EXISTS idx_thread_inventory_spool ON thread_inventory(spoolSizeId);

-- Hoop catalog — global, one shared list a design's required hoop and a machine's supported
-- hoops both reference. migrations/0022.
CREATE TABLE IF NOT EXISTS hoops (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL DEFAULT '',
  widthMm     REAL,
  heightMm    REAL,
  isCapFrame  INTEGER NOT NULL DEFAULT 0 CHECK (isCapFrame IN (0, 1)),
  notes       TEXT NOT NULL DEFAULT '',
  sortOrder   INTEGER NOT NULL DEFAULT 0,
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL
);

-- Needle settings (migrations/0044): the recommended needle shown on Run Order. SIZE follows the
-- thread (needle_sizes: thread weight -> needle size); TYPE follows the garment (needle_types, picked
-- per blank as blanks.needleTypeId). Global, edited from admin -> Threads -> Needle settings.
CREATE TABLE IF NOT EXISTS needle_sizes (
  weight      TEXT PRIMARY KEY,
  needleSize  TEXT NOT NULL DEFAULT '',
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL
);
INSERT OR IGNORE INTO needle_sizes (weight, needleSize, createdAt, updatedAt) VALUES
  ('40', '75/11', '2026-10-09T00:00:00.000Z', '2026-10-09T00:00:00.000Z'),
  ('60', '65/9',  '2026-10-09T00:00:00.000Z', '2026-10-09T00:00:00.000Z');
CREATE TABLE IF NOT EXISTS needle_types (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL DEFAULT '',
  sortOrder  INTEGER NOT NULL DEFAULT 0,
  createdAt  TEXT NOT NULL,
  updatedAt  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_needle_types_name ON needle_types(name COLLATE NOCASE);
INSERT OR IGNORE INTO needle_types (name, sortOrder, createdAt, updatedAt) VALUES
  ('Sharp',     1, '2026-10-09T00:00:00.000Z', '2026-10-09T00:00:00.000Z'),
  ('Ballpoint', 2, '2026-10-09T00:00:00.000Z', '2026-10-09T00:00:00.000Z');

-- Product categories (migrations/0051): the managed list a product's `type` and a blank's
-- `productType` are picked from. `key` is the stored value; `plural` is the storefront heading;
-- `packAs` is the package-size limit the category counts against when a box is chosen.
CREATE TABLE IF NOT EXISTS product_categories (
  key        TEXT PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 40),
  name       TEXT NOT NULL,
  plural     TEXT NOT NULL DEFAULT '',
  packAs     TEXT NOT NULL DEFAULT 'other' CHECK (packAs IN ('shirt', 'sweatshirt', 'cap', 'other')),
  sortOrder  INTEGER NOT NULL DEFAULT 0,
  createdAt  TEXT NOT NULL,
  updatedAt  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_categories_name ON product_categories(name COLLATE NOCASE);

-- The three that existed (same keys, so every product, blank and order line keeps its category),
-- plus Patch, T Shirt, Hoodie and Other.
INSERT OR IGNORE INTO product_categories (key, name, plural, packAs, sortOrder, createdAt, updatedAt) VALUES
  ('shirt',      'Shirt',      'Shirts',      'shirt',      1, '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z'),
  ('t-shirt',    'T Shirt',    'T Shirts',    'shirt',      2, '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z'),
  ('sweatshirt', 'Sweatshirt', 'Sweatshirts', 'sweatshirt', 3, '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z'),
  ('hoodie',     'Hoodie',     'Hoodies',     'sweatshirt', 4, '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z'),
  ('cap',        'Cap',        'Caps',        'cap',        5, '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z'),
  ('patch',      'Patch',      'Patches',     'other',      6, '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z'),
  ('other',      'Other',      'Other',       'other',      7, '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z');

-- Global garment-location lookup (Front/Back/Left Chest/Right Chest, admin-editable). migrations/0041.
-- Referenced by id from products.locationsJson[].locationId and blank_colors.imagesJson[].locationId.
CREATE TABLE IF NOT EXISTS locations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL DEFAULT '',
  notes      TEXT NOT NULL DEFAULT '',
  sortOrder  INTEGER NOT NULL DEFAULT 0,
  createdAt  TEXT NOT NULL,
  updatedAt  TEXT NOT NULL
);

-- Per-location graphic × garment-color mockups for configurable products (migrations/0042) — the
-- storefront preview. A transparent graphic composited over the blank color photo; placementJson
-- keeps the overlay params so the editor can reopen a saved mockup.
CREATE TABLE IF NOT EXISTS product_graphic_images (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  orgId         TEXT NOT NULL,
  productId     TEXT NOT NULL,
  locationId    INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  graphicId     INTEGER NOT NULL REFERENCES graphics(id) ON DELETE CASCADE,
  garmentColor  TEXT NOT NULL DEFAULT '',
  imageUrl      TEXT NOT NULL DEFAULT '',
  thumbUrl      TEXT NOT NULL DEFAULT '',
  placementJson TEXT NOT NULL DEFAULT '{}',
  createdAt     TEXT NOT NULL,
  updatedAt     TEXT NOT NULL,
  FOREIGN KEY (orgId, productId) REFERENCES products(orgId, productId) ON DELETE CASCADE,
  UNIQUE (orgId, productId, locationId, graphicId, garmentColor)
);
CREATE INDEX IF NOT EXISTS idx_pgi_product ON product_graphic_images(orgId, productId);

-- Embroidery designs — one per product (products.designId above). stabilizer/hoopId live here,
-- not per version, since they're properties of the design's placement. migrations/0024.
CREATE TABLE IF NOT EXISTS designs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  orgId       TEXT NOT NULL REFERENCES orgs(orgId),
  name        TEXT NOT NULL DEFAULT '',
  notes       TEXT NOT NULL DEFAULT '',
  stabilizer  TEXT NOT NULL DEFAULT '',
  hoopId      INTEGER REFERENCES hoops(id),
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL,
  -- migrations/0033: 1 = a global design every shop can use (orgId stays its home shop).
  isGlobal    INTEGER NOT NULL DEFAULT 0 CHECK (isGlobal IN (0, 1))
);
CREATE INDEX IF NOT EXISTS idx_designs_global ON designs(isGlobal);
CREATE INDEX IF NOT EXISTS idx_designs_org ON designs(orgId);

-- Append-only file history for a design — the "current" version is the newest row
-- (MAX(uploadedAt) per designId). threadColorsJson: an ORDERED array of {needle, threadId},
-- needle position = this design's own color-change sequence (1-based). migrations/0024. Two
-- required files per version (migrations/0026): designFile (the native, editable design-software
-- project file — .emb/.jdx/etc) and machineFile (the actual stitch file the machine runs —
-- .dst/.exp/etc, what "Send design to machine" sends to the machine).
CREATE TABLE IF NOT EXISTS design_versions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  designId         INTEGER NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
  designFileKey    TEXT NOT NULL DEFAULT '',
  designFileName   TEXT NOT NULL DEFAULT '',
  designFileExt    TEXT NOT NULL DEFAULT '',
  machineFileKey   TEXT NOT NULL DEFAULT '',
  machineFileName  TEXT NOT NULL DEFAULT '',
  machineFileExt   TEXT NOT NULL DEFAULT '',
  threadColorsJson TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(threadColorsJson)),
  notes            TEXT NOT NULL DEFAULT '',
  uploadedAt       TEXT NOT NULL,
  createdAt        TEXT NOT NULL,
  -- migrations/0071: stitches in the machine file (NULL = not known yet)
  stitchCount      INTEGER CHECK (stitchCount IS NULL OR stitchCount >= 0)
);
CREATE INDEX IF NOT EXISTS idx_design_versions_design ON design_versions(designId, uploadedAt);

-- Per-line-item customization uploads (images or embroidery files) — separate from
-- design_verifications (that's one admin-mockup/customer-reply exchange per whole order,
-- expiring after 60 days; this is per line item and persists for the order's life).
-- migrations/0024.
CREATE TABLE IF NOT EXISTS order_item_files (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  itemId      INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  fileKey     TEXT NOT NULL DEFAULT '',
  fileName    TEXT NOT NULL DEFAULT '',
  fileExt     TEXT NOT NULL DEFAULT '',
  uploadedBy  TEXT NOT NULL DEFAULT 'admin' CHECK (uploadedBy IN ('admin', 'customer')),
  createdAt   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_item_files_item ON order_item_files(itemId);
CREATE INDEX IF NOT EXISTS idx_order_item_files_key ON order_item_files(fileKey);

-- An image a customer uploaded from the shop page (migrations/0054), before it is on an order. The
-- file is in the private DESIGNS bucket under order-files/pending/; placing the order records it on the
-- line (order_item_files, uploadedBy 'customer'). Unattached uploads are deleted after 48 hours.
CREATE TABLE IF NOT EXISTS customer_design_uploads (
  id          TEXT    PRIMARY KEY,
  orgId       TEXT    NOT NULL,
  productId   TEXT    NOT NULL,
  fileKey     TEXT    NOT NULL UNIQUE,
  fileName    TEXT    NOT NULL DEFAULT '',
  fileExt     TEXT    NOT NULL CHECK (fileExt IN ('png', 'jpg', 'webp')),
  contentType TEXT    NOT NULL,
  bytes       INTEGER NOT NULL,
  width       INTEGER NOT NULL,
  height      INTEGER NOT NULL,
  createdAt   TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_customer_design_uploads_created ON customer_design_uploads(createdAt);

-- Machine catalog + live state (migrations/0025). ipAddress/embDir are for the local send-agent
-- (a separate program) to send a design to the machine -- never read server-side otherwise.
CREATE TABLE IF NOT EXISTS machines (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL DEFAULT '',
  needleCount    INTEGER NOT NULL DEFAULT 1 CHECK (needleCount > 0),
  ipAddress      TEXT NOT NULL DEFAULT '',
  embDir         TEXT NOT NULL DEFAULT '/EMB',
  currentHoopId  INTEGER REFERENCES hoops(id),
  notes          TEXT NOT NULL DEFAULT '',
  macAddress     TEXT NOT NULL DEFAULT '',  -- stable identity; IP is populated by the scanner (migrations/0027)
  verifiedAt     TEXT,                      -- when discovery last confirmed this MAC present (migrations/0027)
  createdAt      TEXT NOT NULL,
  updatedAt      TEXT NOT NULL,
  -- migrations/0071: the machine's stitch counter and cumulative run time (cache of machine_counter_events)
  stitchCount    INTEGER NOT NULL DEFAULT 0,
  runSeconds     INTEGER NOT NULL DEFAULT 0,
  counterUpdatedAt TEXT
);

-- Which hoops a machine supports — the Run Order screen only offers a machine a job whose
-- design's required hoop is in this set. migrations/0025.
CREATE TABLE IF NOT EXISTS machine_hoops (
  machineId  INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  hoopId     INTEGER NOT NULL REFERENCES hoops(id),
  PRIMARY KEY (machineId, hoopId)
);

-- A machine's LIVE state: what thread is physically loaded on each needle right now. Sparse — a
-- needle with nothing loaded just has no row. migrations/0025.
CREATE TABLE IF NOT EXISTS machine_needles (
  machineId  INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  needle     INTEGER NOT NULL CHECK (needle > 0),
  threadId   INTEGER REFERENCES threads(id),
  updatedAt  TEXT NOT NULL,
  PRIMARY KEY (machineId, needle)
);

-- Run tracking (migrations/0030): a managed abort-reason list and a row per physical piece run on a
-- machine. A running row (status='running', finishedAt IS NULL) is the sole source of truth for both
-- "piece in progress" and "machine busy". machineName/designName/abortReasonLabel are snapshots so
-- the run-time report survives a later rename/delete — hence machineId/abortReasonId carry no FK.
CREATE TABLE IF NOT EXISTS run_abort_reasons (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  label     TEXT NOT NULL,
  sortOrder INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS production_runs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  orgId            TEXT NOT NULL,
  orderId          TEXT NOT NULL REFERENCES orders(orderId) ON DELETE CASCADE,
  itemId           INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  machineId        INTEGER,
  machineName      TEXT NOT NULL DEFAULT '',
  designId         INTEGER,
  designVersionId  INTEGER,
  designName       TEXT NOT NULL DEFAULT '',
  startedAt        TEXT NOT NULL,
  finishedAt       TEXT,
  status           TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'aborted')),
  abortReasonId    INTEGER,
  abortReasonLabel TEXT NOT NULL DEFAULT '',
  abortNote        TEXT NOT NULL DEFAULT '',
  createdAt        TEXT NOT NULL,
  -- migrations/0032: per-hooping tracking (piece, step n of stepCount); timed = 0 → untimed.
  pieceNo          INTEGER,
  stepNo           INTEGER,
  stepCount        INTEGER,
  stepLabel        TEXT NOT NULL DEFAULT '',
  hoopId           INTEGER,
  itemDesignId     INTEGER,
  timed            INTEGER NOT NULL DEFAULT 1 CHECK (timed IN (0, 1)),
  -- migrations/0046: what went wrong during the run, noted when it's finished ({"threadBreak":3,…}) + the "other" note.
  issuesJson       TEXT NOT NULL DEFAULT '{}',
  issueNote        TEXT NOT NULL DEFAULT '',
  -- migrations/0071: the hooping's design stitches, and what the run added to its machine's counters.
  stitchCount      INTEGER,
  stitchesCounted  INTEGER,
  secondsCounted   INTEGER,
  estimated        INTEGER NOT NULL DEFAULT 0 CHECK (estimated IN (0, 1))
);
CREATE INDEX IF NOT EXISTS idx_runs_status  ON production_runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_machine ON production_runs(machineId, status);
CREATE INDEX IF NOT EXISTS idx_runs_item    ON production_runs(itemId);
CREATE INDEX IF NOT EXISTS idx_runs_design  ON production_runs(designId);
-- migrations/0031: at most one running job per machine.
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_one_running_per_machine
  ON production_runs(machineId) WHERE status = 'running' AND machineId IS NOT NULL;

-- migrations/0032: one done row per hooping, one running hooping per piece.
CREATE INDEX IF NOT EXISTS idx_runs_piece ON production_runs(itemId, pieceNo, stepNo);
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_one_done_per_step
  ON production_runs(itemId, pieceNo, stepNo) WHERE status = 'done' AND pieceNo IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_one_running_per_piece
  ON production_runs(itemId, pieceNo) WHERE status = 'running' AND pieceNo IS NOT NULL;
-- migrations/0104: the finished runs by when they finished (the pricing analysis' last 12 months).
CREATE INDEX IF NOT EXISTS idx_runs_done_finished ON production_runs(finishedAt) WHERE status = 'done';
-- migrations/0112: runs by when they started (the Run times report's range and its run log's pages).
CREATE INDEX IF NOT EXISTS idx_runs_started ON production_runs(startedAt);

-- migrations/0032: a design's hoops (on its own / with a typed-in name), a product's designs in
-- run order (one MAIN), and the order-specific design for a typed-in-personalization line.
CREATE TABLE IF NOT EXISTS design_hoops (
  designId  INTEGER NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
  hoopId    INTEGER NOT NULL REFERENCES hoops(id),
  purpose   TEXT NOT NULL DEFAULT 'design' CHECK (purpose IN ('design', 'personalization')),
  sortOrder INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (designId, hoopId, purpose)
);
CREATE INDEX IF NOT EXISTS idx_design_hoops_hoop ON design_hoops(hoopId);
CREATE TABLE IF NOT EXISTS product_designs (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  orgId     TEXT NOT NULL,
  productId TEXT NOT NULL,
  designId  INTEGER NOT NULL REFERENCES designs(id),
  placement TEXT NOT NULL DEFAULT '',
  isMain    INTEGER NOT NULL DEFAULT 0 CHECK (isMain IN (0, 1)),
  sortOrder INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_product_designs_product ON product_designs(orgId, productId);
CREATE INDEX IF NOT EXISTS idx_product_designs_design ON product_designs(designId);
CREATE TABLE IF NOT EXISTS order_item_designs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  itemId           INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  designFileKey    TEXT NOT NULL DEFAULT '',
  designFileName   TEXT NOT NULL DEFAULT '',
  designFileExt    TEXT NOT NULL DEFAULT '',
  machineFileKey   TEXT NOT NULL DEFAULT '',
  machineFileName  TEXT NOT NULL DEFAULT '',
  machineFileExt   TEXT NOT NULL DEFAULT '',
  threadColorsJson TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(threadColorsJson)),
  notes            TEXT NOT NULL DEFAULT '',
  uploadedAt       TEXT NOT NULL,
  createdAt        TEXT NOT NULL,
  -- migrations/0055: which location of the line this design is for ('' = the line's one design).
  location         TEXT NOT NULL DEFAULT '',
  -- migrations/0071: stitches in the machine file (NULL = not known yet)
  stitchCount      INTEGER CHECK (stitchCount IS NULL OR stitchCount >= 0)
);
CREATE INDEX IF NOT EXISTS idx_order_item_designs_item ON order_item_designs(itemId, uploadedAt);

-- migrations/0031: orders.insertedAt (when the row was written) drives the 6 AM roll-up's
-- "new since the last email" cursor; set by this trigger on every insert.
CREATE INDEX IF NOT EXISTS idx_orders_inserted ON orders(insertedAt, orderId);
CREATE TRIGGER IF NOT EXISTS orders_set_inserted_at AFTER INSERT ON orders
  WHEN NEW.insertedAt IS NULL
BEGIN
  UPDATE orders SET insertedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE orderId = NEW.orderId;
END;

-- Payment records — one row per actual payment received (supports partial payments)
CREATE TABLE IF NOT EXISTS order_payments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  receiptKey    TEXT NOT NULL DEFAULT '',  -- 0061
  receiptName   TEXT NOT NULL DEFAULT '',  -- 0061
  orderId     TEXT NOT NULL REFERENCES orders(orderId) ON DELETE CASCADE,
  amountCents INTEGER NOT NULL CHECK (amountCents <> 0),
  note        TEXT NOT NULL DEFAULT '',
  receivedAt  TEXT NOT NULL,
  externalRef TEXT NOT NULL DEFAULT '',
  -- How the money moved and what kind of movement it was (migrations/0008).
  -- Refunds and lost disputes are NEGATIVE amounts.
  method      TEXT NOT NULL DEFAULT 'other'
    CHECK (method IN ('card', 'venmo', 'zelle', 'check', 'cash', 'other')),
  reference   TEXT NOT NULL DEFAULT '',
  feeCents    INTEGER NOT NULL DEFAULT 0 CHECK (feeCents >= 0),
  kind        TEXT NOT NULL DEFAULT 'payment'
    CHECK (kind IN ('payment', 'refund', 'dispute')),
  -- Mistaken entries are voided, not deleted (migrations/0010).
  voidedAt    TEXT,
  voidReason  TEXT NOT NULL DEFAULT '',
  accountId   INTEGER REFERENCES accounts(id),  -- which account the money moved through (0014)
  -- (0017, superseded by payment_cashouts in 0018 — no longer written or read.)
  cashoutTransferId INTEGER REFERENCES account_transfers(id),
  -- (0035) how much of a refund / lost dispute was shipping — untaxed, so no sales tax is backed out of it.
  shippingCents INTEGER NOT NULL DEFAULT 0 CHECK (shippingCents >= 0),
  -- (0095) one key per Save in the admin's payment forms, so a double click or retry can't record it twice.
  requestKey  TEXT,
  -- (0098) when "Sync Stripe fees & dates" last compared this Stripe card payment's date with Stripe's; NULL = not yet.
  stripeCheckedAt TEXT,
  -- (0099) 1 = not yet fully cashed out and not matched to a bank line (the deposit picker's candidates); kept by
  -- the payments_/cashouts_/transfers_/matches_deposit_open triggers below.
  depositOpen INTEGER NOT NULL DEFAULT 1 CHECK (depositOpen IN (0, 1)),
  -- (0120) the gift card a gift-card payment (method 'other', accountId NULL) or its refund came from.
  giftCardId  INTEGER
);

-- How much of a Venmo payment each Venmo -> bank transfer covers (migrations/0018). A payment
-- can be cashed out in parts; allocations to a deleted transfer don't count.
CREATE TABLE IF NOT EXISTS payment_cashouts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  paymentId   INTEGER NOT NULL REFERENCES order_payments(id) ON DELETE CASCADE,
  transferId  INTEGER NOT NULL REFERENCES account_transfers(id),
  amountCents INTEGER NOT NULL CHECK (amountCents > 0),
  createdAt   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payment_cashouts_payment  ON payment_cashouts(paymentId);
CREATE INDEX IF NOT EXISTS idx_payment_cashouts_transfer ON payment_cashouts(transferId);

-- The Stripe card page last opened for each order (migrations/0093): reused while it still charges the
-- balance, closed (expired) before a new one is made and when the order is voided — so one order can't
-- be paid twice by card from two open pages.
CREATE TABLE IF NOT EXISTS checkout_sessions (
  orderId     TEXT PRIMARY KEY REFERENCES orders(orderId) ON DELETE CASCADE,
  sessionId   TEXT NOT NULL,
  amountCents INTEGER NOT NULL DEFAULT 0,
  createdAt   TEXT NOT NULL,
  expiresAt   TEXT NOT NULL
);

-- Each Stripe dispute an order has had and its latest status (migrations/0094), so an out-of-order or
-- retried dispute event can't move orders.disputeStatus backwards. No foreign key (see the migration).
CREATE TABLE IF NOT EXISTS order_disputes (
  disputeId TEXT PRIMARY KEY,
  orderId   TEXT NOT NULL,
  status    TEXT NOT NULL DEFAULT '',
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_disputes_order ON order_disputes(orderId);

-- Stripe webhook events already processed (idempotency — see stripe-webhook.js)
CREATE TABLE IF NOT EXISTS stripe_events (
  eventId     TEXT PRIMARY KEY,
  type        TEXT NOT NULL DEFAULT '',
  orderId     TEXT,
  processedAt TEXT NOT NULL
);

-- Org-specific ready-to-ship finished inventory (decorated items on hand, immediately shippable)
CREATE TABLE IF NOT EXISTS ready_to_ship (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  orgId     TEXT NOT NULL,
  productId TEXT NOT NULL,
  size      TEXT NOT NULL DEFAULT '',
  quantity  INTEGER NOT NULL DEFAULT 0,
  updatedAt TEXT NOT NULL,
  avgCostCents INTEGER NOT NULL DEFAULT 0 CHECK (avgCostCents >= 0),   -- migrations/0060: finished stock's running average cost
  variant      TEXT NOT NULL DEFAULT '',   -- migrations/0080: the combination (color + graphics) — '' for a product with no choices
  variantLabel TEXT NOT NULL DEFAULT '',   -- … said in words
  UNIQUE (orgId, productId, size, variant)
);
-- migrations/0060: every change to finished stock (ready_to_ship.quantity is the cache of their sum).
CREATE TABLE IF NOT EXISTS finished_goods_movements (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  orgId           TEXT    NOT NULL,
  productId       TEXT    NOT NULL,
  productName     TEXT    NOT NULL DEFAULT '',
  color           TEXT    NOT NULL DEFAULT '',
  size            TEXT    NOT NULL DEFAULT '',
  qtyDelta        INTEGER NOT NULL CHECK (qtyDelta <> 0),
  unitCostCents   INTEGER NOT NULL DEFAULT 0 CHECK (unitCostCents >= 0),
  kind            TEXT    NOT NULL CHECK (kind IN ('opening', 'make', 'sell', 'return', 'adjust')),
  blankMovementId INTEGER,
  orderId         TEXT,
  itemId          INTEGER,
  note            TEXT    NOT NULL DEFAULT '',
  occurredAt      TEXT    NOT NULL,
  createdAt       TEXT    NOT NULL,
  voidedAt        TEXT,
  voidReason      TEXT    NOT NULL DEFAULT '',
  variant         TEXT    NOT NULL DEFAULT '',   -- migrations/0080: see ready_to_ship.variant
  variantLabel    TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_fgm_item ON finished_goods_movements (orgId, productId, size, variant, occurredAt);
CREATE INDEX IF NOT EXISTS idx_fgm_occurred ON finished_goods_movements (occurredAt);
-- Costs on orders not sold yet look finished stock up by order (migrations/0103).
CREATE INDEX IF NOT EXISTS idx_fgm_order ON finished_goods_movements (orderId);


CREATE INDEX IF NOT EXISTS idx_orders_org            ON orders(orgId, placedAt DESC);
CREATE INDEX IF NOT EXISTS idx_orders_placed         ON orders(placedAt);
CREATE INDEX IF NOT EXISTS idx_orders_ship_state     ON orders(shipState);
CREATE INDEX IF NOT EXISTS idx_items_order           ON order_items(orderId);
CREATE INDEX IF NOT EXISTS idx_items_org             ON order_items(orgId);
CREATE INDEX IF NOT EXISTS idx_payments_order        ON order_payments(orderId);
CREATE INDEX IF NOT EXISTS idx_payments_received     ON order_payments(receivedAt);
CREATE INDEX IF NOT EXISTS idx_payments_cashout      ON order_payments(cashoutTransferId);
CREATE INDEX IF NOT EXISTS idx_payments_deposit_open ON order_payments(depositOpen, kind) WHERE depositOpen = 1;   -- migrations/0099
CREATE INDEX IF NOT EXISTS idx_order_payments_giftcard ON order_payments(giftCardId) WHERE giftCardId IS NOT NULL;   -- migrations/0120
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_external_ref ON order_payments(externalRef) WHERE externalRef <> '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_request_key ON order_payments(requestKey) WHERE requestKey IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_verif_order           ON design_verifications(orderId);
CREATE INDEX IF NOT EXISTS idx_verif_org_order_sent  ON design_verifications(orgId, orderId, sentAt);   -- migrations/0097
CREATE INDEX IF NOT EXISTS idx_products_org          ON products(orgId, visible, sortOrder);
CREATE INDEX IF NOT EXISTS idx_blank_sizes           ON blank_sizes(blankId);
CREATE INDEX IF NOT EXISTS idx_blank_colors          ON blank_colors(blankId);
CREATE INDEX IF NOT EXISTS idx_inventory_type  ON inventory(productType, size);
CREATE INDEX IF NOT EXISTS idx_blanks_type     ON blanks(productType);
CREATE INDEX IF NOT EXISTS idx_prod_blank_link ON product_blank_links(orgId, productId);
CREATE INDEX IF NOT EXISTS idx_prod_blank_link_blank ON product_blank_links(blankId, blankColor, blankSize);   -- migrations/0112: which products use a blank
CREATE INDEX IF NOT EXISTS idx_rts_org         ON ready_to_ship(orgId, productId);
CREATE INDEX IF NOT EXISTS idx_items_from_stock ON order_items (orgId, productId, size, stockVariant) WHERE fromStock = 1;

-- Default global settings
INSERT OR IGNORE INTO global_settings (key, value)
VALUES ('enabledPayments', '{"card":true,"venmo":true,"zelle":true,"check":true}');
-- (No 'salesTax' row: sales tax is unset — rate 0, no home state — until the admin saves it; 0051.)
CREATE INDEX IF NOT EXISTS idx_orders_tax_exempt ON orders(taxExempt);
CREATE INDEX IF NOT EXISTS idx_orders_completed ON orders(completedAt);
CREATE INDEX IF NOT EXISTS idx_payments_kind_received ON order_payments(kind, receivedAt);

-- Postage bought through Shippo: an expense against shipping income (migrations/0008).
CREATE TABLE IF NOT EXISTS shipping_labels (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  receiptKey    TEXT NOT NULL DEFAULT '',  -- 0061
  receiptName   TEXT NOT NULL DEFAULT '',  -- 0061
  orderId             TEXT NOT NULL REFERENCES orders(orderId) ON DELETE CASCADE,
  shippoTransactionId TEXT NOT NULL UNIQUE,
  carrier             TEXT NOT NULL DEFAULT '',
  service             TEXT NOT NULL DEFAULT '',
  amountCents         INTEGER NOT NULL CHECK (amountCents >= 0),
  trackingNumber      TEXT NOT NULL DEFAULT '',
  labelUrl            TEXT NOT NULL DEFAULT '',
  purchasedAt         TEXT NOT NULL,
  voidedAt            TEXT,
  accountId           INTEGER REFERENCES accounts(id)   -- charged to (0014)
);
CREATE INDEX IF NOT EXISTS idx_labels_order     ON shipping_labels(orderId);
CREATE INDEX IF NOT EXISTS idx_labels_purchased ON shipping_labels(purchasedAt);

-- Blank (garment) shipments (migrations/0039): one row per tracking number, linked to the line
-- items it covers; per-scan carrier history in blank_tracking_events. Polled daily via Shippo.
CREATE TABLE IF NOT EXISTS blank_shipments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  carrier        TEXT NOT NULL DEFAULT '',
  trackingNumber TEXT NOT NULL DEFAULT '',
  vendor         TEXT NOT NULL DEFAULT '',
  shippedAt      TEXT,
  status         TEXT NOT NULL DEFAULT '',
  statusDetail   TEXT NOT NULL DEFAULT '',
  statusDate     TEXT,
  deliveredAt    TEXT,
  lastCheckedAt  TEXT,
  createdAt      TEXT NOT NULL,
  updatedAt      TEXT NOT NULL,
  supplierPoNumber TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_blank_shipments_tracking ON blank_shipments(trackingNumber);
CREATE INDEX IF NOT EXISTS idx_blank_shipments_active   ON blank_shipments(deliveredAt, lastCheckedAt);

CREATE TABLE IF NOT EXISTS blank_shipment_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  shipmentId INTEGER NOT NULL REFERENCES blank_shipments(id) ON DELETE CASCADE,
  itemId     INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,  -- FK added in 0040
  UNIQUE (shipmentId, itemId)
);
CREATE INDEX IF NOT EXISTS idx_blank_shipment_items_item ON blank_shipment_items(itemId);

CREATE TABLE IF NOT EXISTS blank_tracking_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  shipmentId   INTEGER NOT NULL REFERENCES blank_shipments(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT '',
  statusDetail TEXT NOT NULL DEFAULT '',
  location     TEXT NOT NULL DEFAULT '',
  occurredAt   TEXT NOT NULL DEFAULT '',
  recordedAt   TEXT NOT NULL,
  UNIQUE (shipmentId, status, occurredAt)
);
CREATE INDEX IF NOT EXISTS idx_blank_tracking_events_shipment ON blank_tracking_events(shipmentId, occurredAt);

-- Every change to blank stock (migrations/0009). blankId is not an FK on
-- purpose: deleting a blank must keep its cost history.
CREATE TABLE IF NOT EXISTS inventory_movements (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  receiptGroup  TEXT,  -- 0061: ties the records one receive wrote together
  blankId       INTEGER NOT NULL,
  blankName     TEXT NOT NULL DEFAULT '',
  size          TEXT NOT NULL DEFAULT '',
  qtyDelta      INTEGER NOT NULL CHECK (qtyDelta <> 0),
  unitCostCents INTEGER NOT NULL DEFAULT 0 CHECK (unitCostCents >= 0),
  kind          TEXT NOT NULL CHECK (kind IN ('purchase', 'consume', 'adjust', 'writeoff')),
  orderId       TEXT,
  itemId        INTEGER,
  vendor        TEXT NOT NULL DEFAULT '',
  vendorRef     TEXT NOT NULL DEFAULT '',
  note          TEXT NOT NULL DEFAULT '',
  occurredAt    TEXT NOT NULL,
  createdAt     TEXT NOT NULL,
  vendorChargedTax INTEGER NOT NULL DEFAULT 0 CHECK (vendorChargedTax IN (0, 1)),  -- migrations/0013
  accountId     INTEGER REFERENCES accounts(id),                                   -- purchases: paid from (0014)
  paidPersonally INTEGER NOT NULL DEFAULT 0 CHECK (paidPersonally IN (0, 1)),      -- 0014
  receiptKey    TEXT NOT NULL DEFAULT '',                                          -- 0019
  receiptName   TEXT NOT NULL DEFAULT '',                                          -- 0019
  voidedAt      TEXT,                                                              -- 0020
  voidReason    TEXT NOT NULL DEFAULT '',                                          -- 0020
  color         TEXT NOT NULL DEFAULT '',                                          -- 0037 (stock dimension)
  reason        TEXT NOT NULL DEFAULT '',                                          -- 0060: writeoff testing|damaged|lost|other; consume ''|finished
  requestKey    TEXT                                                               -- 0107: the Receive form's key for this row, so a retry can't record it twice
);
CREATE INDEX IF NOT EXISTS idx_movements_blank    ON inventory_movements(blankId, size, occurredAt);
CREATE INDEX IF NOT EXISTS idx_movements_blank_color ON inventory_movements(blankId, color, size, occurredAt);
CREATE INDEX IF NOT EXISTS idx_movements_occurred ON inventory_movements(occurredAt);
CREATE INDEX IF NOT EXISTS idx_movements_order    ON inventory_movements(orderId);
-- migrations/0112: purchases still in force by when they were recorded (has restock on order arrived?).
CREATE INDEX IF NOT EXISTS idx_movements_purchase_created ON inventory_movements(createdAt) WHERE kind = 'purchase' AND voidedAt IS NULL;

-- Months already filed: changes that would alter them are refused (migrations/0010).
CREATE TABLE IF NOT EXISTS closed_periods (
  month    TEXT PRIMARY KEY CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  closedAt TEXT NOT NULL,
  closedBy TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_orders_reportable ON orders(isTest, voidedAt, placedAt);
-- Open orders only (migrations/0087): the open-orders screen and the queues, without walking the history.
CREATE INDEX IF NOT EXISTS idx_orders_open ON orders(isTest, voidedAt, placedAt) WHERE completedAt IS NULL AND voidedAt IS NULL;
CREATE INDEX IF NOT EXISTS idx_orders_manufactured ON orders(manufacturedAt);
CREATE INDEX IF NOT EXISTS idx_orders_sale_date ON orders(COALESCE(shippedAt, deliveredAt, completedAt));   -- migrations/0088

-- Owner notices queued for the 6 AM daily roll-up (migrations/0011; 'delivered' added in 0016, 'invoice' in 0058,
-- 'picked_up' in 0113, 'quote' / 'gift_card' / 'po' in 0119).
CREATE TABLE IF NOT EXISTS owner_notices (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  kind      TEXT NOT NULL CHECK (kind IN ('payment', 'refund', 'dispute', 'design', 'delivered', 'invoice', 'picked_up', 'quote', 'gift_card', 'po')),
  orderId   TEXT NOT NULL DEFAULT '',
  orgId     TEXT NOT NULL DEFAULT '',
  summary   TEXT NOT NULL,
  detail    TEXT NOT NULL DEFAULT '',
  imageUrls TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(imageUrls)),
  urgent    INTEGER NOT NULL DEFAULT 0 CHECK (urgent IN (0, 1)),
  createdAt TEXT NOT NULL,
  sentAt    TEXT
);
CREATE INDEX IF NOT EXISTS idx_owner_notices_unsent ON owner_notices(sentAt, id);

-- Designs sent to an outside digitizer (migrations/0118): who, when, what it cost, and the expense recorded for it.
CREATE TABLE IF NOT EXISTS digitizing_jobs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  orderId    TEXT NOT NULL DEFAULT '',
  itemId     INTEGER,                       -- the order line, when it is for one
  designId   INTEGER,                       -- the design, when there is one
  estimateId INTEGER,                       -- the quote whose digitizing fee line it pays for, when there is one
  name       TEXT NOT NULL DEFAULT '',      -- what was sent ("Example Club left chest logo")
  vendor     TEXT NOT NULL DEFAULT '',      -- a vendors.name (names are what records store elsewhere)
  sentAt     TEXT NOT NULL,                 -- YYYY-MM-DD
  returnedAt TEXT,                          -- YYYY-MM-DD
  costCents  INTEGER NOT NULL DEFAULT 0 CHECK (costCents >= 0),
  expenseId  INTEGER,                       -- the expenses row recorded for its cost, when one was
  note       TEXT NOT NULL DEFAULT '',
  createdAt  TEXT NOT NULL,
  createdBy  TEXT NOT NULL DEFAULT '',
  deletedAt  TEXT
);
CREATE INDEX IF NOT EXISTS idx_digitizing_order ON digitizing_jobs(orderId);

-- Business expenses + categories (migrations/0012). Seeds included.
CREATE TABLE IF NOT EXISTS expense_categories (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(trim(name)) > 0),
  deductionType TEXT NOT NULL CHECK (deductionType IN ('depreciation', 'deductible', 'none')),
  scheduleCLine TEXT NOT NULL DEFAULT '',
  deductiblePct INTEGER NOT NULL DEFAULT 100 CHECK (deductiblePct BETWEEN 0 AND 100),
  createdAt     TEXT NOT NULL,
  updatedAt     TEXT NOT NULL,
  useTaxable    INTEGER NOT NULL DEFAULT 0 CHECK (useTaxable IN (0, 1)),  -- owes use tax if untaxed (0013)
  systemKey     TEXT,  -- a category the app relies on, e.g. 'sales_tax_paid' (0090); can't be deleted
  capital       INTEGER NOT NULL DEFAULT 0 CHECK (capital IN (0, 1))  -- purchases that last; kept out of operating profit (0092)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_expense_categories_system ON expense_categories(systemKey) WHERE systemKey IS NOT NULL;

CREATE TABLE IF NOT EXISTS expenses (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  receiptGroup  TEXT,  -- 0061: ties the records one receive wrote together
  expenseDate     TEXT NOT NULL CHECK (expenseDate GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  description     TEXT NOT NULL CHECK (length(trim(description)) > 0),
  categoryId      INTEGER NOT NULL REFERENCES expense_categories(id) ON DELETE RESTRICT,
  amountCents     INTEGER NOT NULL CHECK (amountCents <> 0),   -- negative = a refund of an earlier purchase (0017)
  vendor          TEXT NOT NULL DEFAULT '',
  businessUsePct  INTEGER NOT NULL DEFAULT 100 CHECK (businessUsePct BETWEEN 1 AND 100),
  receiptKey      TEXT NOT NULL DEFAULT '',
  receiptName     TEXT NOT NULL DEFAULT '',
  placedInService TEXT,
  depMethod       TEXT CHECK (depMethod IS NULL OR depMethod IN ('section179', 'bonus', 'macrs5', 'macrs7', 'ask_cpa')),
  createdAt       TEXT NOT NULL,
  updatedAt       TEXT NOT NULL,
  deletedAt       TEXT,
  vendorChargedTax INTEGER NOT NULL DEFAULT 1 CHECK (vendorChargedTax IN (0, 1)),  -- migrations/0013
  accountId       INTEGER REFERENCES accounts(id),                                   -- paid from (0014)
  paidPersonally  INTEGER NOT NULL DEFAULT 0 CHECK (paidPersonally IN (0, 1)),       -- owner's own money (0014)
  refundOfId      INTEGER REFERENCES expenses(id) ON DELETE SET NULL,                -- the purchase this refunds (0017)
  recurringId     INTEGER REFERENCES recurring_expenses(id),                         -- recorded from this rule (0085)
  fundraiserOrgId TEXT REFERENCES orgs(orgId),                                       -- a payout to this shop's fundraiser (0110)
  orderId         TEXT NOT NULL DEFAULT ''                                           -- the order it was recorded for, e.g. outside digitizing (0118)
);
CREATE INDEX IF NOT EXISTS idx_expenses_date     ON expenses(deletedAt, expenseDate);
CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(categoryId);
CREATE UNIQUE INDEX IF NOT EXISTS idx_expenses_recurring ON expenses(recurringId, expenseDate) WHERE recurringId IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_expenses_fundraiser ON expenses(fundraiserOrgId) WHERE fundraiserOrgId IS NOT NULL;  -- 0110
CREATE INDEX IF NOT EXISTS idx_expenses_order ON expenses(orderId) WHERE orderId <> '';  -- 0118

-- Recurring expenses (migrations/0085): recorded automatically on each date they come due (frequency from startDate,
-- the start's day of the month as the anchor; endDate NULL = no end; nextIndex = the occurrence that's next).
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

-- Starting categories (all editable / deletable while unused).
INSERT OR IGNORE INTO expense_categories (name, deductionType, scheduleCLine, deductiblePct, createdAt, updatedAt) VALUES
  ('Equipment & machines',                   'depreciation', '13',  100, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Supplies (thread, stabilizer, needles)', 'deductible',   '22',  100, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Software & subscriptions',               'deductible',   '27a', 100, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Advertising',                            'deductible',   '8',   100, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Meals (50%)',                            'deductible',   '24b', 50,  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Office expense',                         'deductible',   '18',  100, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Repairs & maintenance',                  'deductible',   '21',  100, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Insurance',                              'deductible',   '15',  100, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Legal & professional',                   'deductible',   '17',  100, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Taxes & licenses',                       'deductible',   '23',  100, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Travel',                                 'deductible',   '24a', 100, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Utilities & phone',                      'deductible',   '25',  100, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Contract labor',                         'deductible',   '11',  100, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Rent / lease',                           'deductible',   '20b', 100, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Bank & other fees',                      'deductible',   '27a', 100, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('Personal / non-deductible',              'none',         '',    0,   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
-- Sales tax paid to the state (migrations/0090): Home's "Money in and out" shows it as sales tax going out.
INSERT OR IGNORE INTO expense_categories (name, deductionType, scheduleCLine, deductiblePct, createdAt, updatedAt, systemKey) VALUES
  ('Sales tax paid to the state', 'none', '', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'sales_tax_paid');
-- Fundraiser payouts (migrations/0110): money a shop's sales raised, paid to the group it supports.
INSERT OR IGNORE INTO expense_categories (name, deductionType, scheduleCLine, deductiblePct, createdAt, updatedAt, systemKey) VALUES
  ('Fundraiser payouts', 'deductible', '27a', 100, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'fundraiser_payout');
-- Capital purchases (migrations/0092): Depreciation categories are always capital; small equipment is deducted now but
-- still kept out of Home's operating profit.
UPDATE expense_categories SET capital = 1 WHERE deductionType = 'depreciation';
INSERT OR IGNORE INTO expense_categories (name, deductionType, scheduleCLine, deductiblePct, createdAt, updatedAt, capital) VALUES
  ('Small equipment & tools', 'deductible', '22', 100, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 1);

-- Audit log — admin changes to orders (see migrations/0002 and 0004)
CREATE TABLE IF NOT EXISTS audit_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  createdAt TEXT    NOT NULL,
  orgId     TEXT,
  orderId   TEXT,
  action    TEXT    NOT NULL,
  detail    TEXT,             -- JSON: what changed (before/after where relevant)
  actor     TEXT,             -- the user's email (or "passphrase" for the installer's)
  ip        TEXT,
  actorUserId  INTEGER,       -- users.id of who did it, on security entries (migrations/0053)
  targetUserId INTEGER        -- users.id of the account it was done to
);
CREATE INDEX IF NOT EXISTS idx_audit_log_createdAt ON audit_log(createdAt DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_orgId     ON audit_log(orgId);
CREATE INDEX IF NOT EXISTS idx_audit_log_orderId   ON audit_log(orderId);
CREATE INDEX IF NOT EXISTS idx_audit_log_action    ON audit_log(action, createdAt);   -- migrations/0104

-- Rate-limit counters (see migrations/0005 and functions/_lib/rateLimit.js)
CREATE TABLE IF NOT EXISTS rate_limits (
  key       TEXT PRIMARY KEY,
  count     INTEGER NOT NULL DEFAULT 0,
  expiresAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_expires ON rate_limits(expiresAt);

-- Use-taxable starting categories (migrations/0013).
UPDATE expense_categories SET useTaxable = 1
WHERE name IN ('Equipment & machines', 'Supplies (thread, stabilizer, needles)', 'Office expense', 'Repairs & maintenance');

-- Other income, owner contributions/draws, transfers between accounts (migrations/0014).
CREATE TABLE IF NOT EXISTS other_income (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  receiptKey    TEXT NOT NULL DEFAULT '',  -- 0061
  receiptName   TEXT NOT NULL DEFAULT '',  -- 0061
  incomeDate  TEXT NOT NULL CHECK (incomeDate GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  description TEXT NOT NULL CHECK (length(trim(description)) > 0),
  type        TEXT NOT NULL CHECK (type IN ('service', 'other', 'interest')),
  amountCents INTEGER NOT NULL CHECK (amountCents > 0),
  accountId   INTEGER NOT NULL REFERENCES accounts(id),
  reference   TEXT NOT NULL DEFAULT '',
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL,
  deletedAt   TEXT
);
CREATE INDEX IF NOT EXISTS idx_other_income_date ON other_income(deletedAt, incomeDate);

CREATE TABLE IF NOT EXISTS owner_transactions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  receiptKey    TEXT NOT NULL DEFAULT '',  -- 0061
  receiptName   TEXT NOT NULL DEFAULT '',  -- 0061
  receiptGroup  TEXT,  -- 0061: ties the records one receive wrote together
  txDate      TEXT NOT NULL CHECK (txDate GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  kind        TEXT NOT NULL CHECK (kind IN ('contribution', 'draw')),
  amountCents INTEGER NOT NULL CHECK (amountCents > 0),
  accountId   INTEGER NOT NULL REFERENCES accounts(id),
  note        TEXT NOT NULL DEFAULT '',
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL,
  deletedAt   TEXT
);
CREATE INDEX IF NOT EXISTS idx_owner_tx_date ON owner_transactions(deletedAt, txDate);

CREATE TABLE IF NOT EXISTS account_transfers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  receiptKey    TEXT NOT NULL DEFAULT '',  -- 0061
  receiptName   TEXT NOT NULL DEFAULT '',  -- 0061
  transferDate  TEXT NOT NULL CHECK (transferDate GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  fromAccountId INTEGER NOT NULL REFERENCES accounts(id),
  toAccountId   INTEGER NOT NULL REFERENCES accounts(id),
  amountCents   INTEGER NOT NULL CHECK (amountCents > 0),
  note          TEXT NOT NULL DEFAULT '',
  externalRef   TEXT NOT NULL DEFAULT '',
  createdAt     TEXT NOT NULL,
  updatedAt     TEXT NOT NULL,
  deletedAt     TEXT,
  CHECK (fromAccountId <> toAccountId)
);
CREATE INDEX IF NOT EXISTS idx_transfers_date ON account_transfers(deletedAt, transferDate);
CREATE UNIQUE INDEX IF NOT EXISTS idx_transfers_external_ref ON account_transfers(externalRef) WHERE externalRef <> '';

-- Statement import & monthly reconciliation (migrations/0015).
CREATE TABLE IF NOT EXISTS statement_lines (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  accountId    INTEGER NOT NULL REFERENCES accounts(id),
  lineDate     TEXT NOT NULL CHECK (lineDate GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  description  TEXT NOT NULL DEFAULT '',
  amountCents  INTEGER NOT NULL CHECK (amountCents <> 0),
  fingerprint  TEXT NOT NULL,
  importBatch  TEXT NOT NULL DEFAULT '',
  importedAt   TEXT NOT NULL,
  ignoredAt    TEXT,
  ignoreReason TEXT NOT NULL DEFAULT '',
  UNIQUE (accountId, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_statement_lines_account_date ON statement_lines(accountId, lineDate);

CREATE TABLE IF NOT EXISTS statement_matches (
  lineId    INTEGER NOT NULL REFERENCES statement_lines(id) ON DELETE CASCADE,
  src       TEXT NOT NULL,
  srcId     INTEGER NOT NULL,
  matchedAt TEXT NOT NULL,
  auto      INTEGER NOT NULL DEFAULT 0 CHECK (auto IN (0, 1)),
  PRIMARY KEY (src, srcId)
);
CREATE INDEX IF NOT EXISTS idx_statement_matches_line ON statement_matches(lineId);

-- order_payments.depositOpen (migrations/0099): worked out again whenever a cash-out, a transfer's deletion, a
-- statement match or the payment's amount changes, so the deposit picker reads only the open payments.
CREATE TRIGGER IF NOT EXISTS payments_deposit_open_insert AFTER INSERT ON order_payments
BEGIN
  UPDATE order_payments SET depositOpen = CASE WHEN COALESCE((SELECT SUM(c.amountCents) FROM payment_cashouts c JOIN account_transfers t ON t.id = c.transferId AND t.deletedAt IS NULL
      WHERE c.paymentId = order_payments.id), 0) < order_payments.amountCents
    AND NOT EXISTS (SELECT 1 FROM statement_matches m WHERE m.src = 'payment' AND m.srcId = order_payments.id) THEN 1 ELSE 0 END WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS payments_deposit_open_amount AFTER UPDATE OF amountCents ON order_payments
BEGIN
  UPDATE order_payments SET depositOpen = CASE WHEN COALESCE((SELECT SUM(c.amountCents) FROM payment_cashouts c JOIN account_transfers t ON t.id = c.transferId AND t.deletedAt IS NULL
      WHERE c.paymentId = order_payments.id), 0) < order_payments.amountCents
    AND NOT EXISTS (SELECT 1 FROM statement_matches m WHERE m.src = 'payment' AND m.srcId = order_payments.id) THEN 1 ELSE 0 END WHERE id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS cashouts_deposit_open_insert AFTER INSERT ON payment_cashouts
BEGIN
  UPDATE order_payments SET depositOpen = CASE WHEN COALESCE((SELECT SUM(c.amountCents) FROM payment_cashouts c JOIN account_transfers t ON t.id = c.transferId AND t.deletedAt IS NULL
      WHERE c.paymentId = order_payments.id), 0) < order_payments.amountCents
    AND NOT EXISTS (SELECT 1 FROM statement_matches m WHERE m.src = 'payment' AND m.srcId = order_payments.id) THEN 1 ELSE 0 END WHERE id = NEW.paymentId;
END;
CREATE TRIGGER IF NOT EXISTS cashouts_deposit_open_update AFTER UPDATE ON payment_cashouts
BEGIN
  UPDATE order_payments SET depositOpen = CASE WHEN COALESCE((SELECT SUM(c.amountCents) FROM payment_cashouts c JOIN account_transfers t ON t.id = c.transferId AND t.deletedAt IS NULL
      WHERE c.paymentId = order_payments.id), 0) < order_payments.amountCents
    AND NOT EXISTS (SELECT 1 FROM statement_matches m WHERE m.src = 'payment' AND m.srcId = order_payments.id) THEN 1 ELSE 0 END WHERE id IN (OLD.paymentId, NEW.paymentId);
END;
CREATE TRIGGER IF NOT EXISTS cashouts_deposit_open_delete AFTER DELETE ON payment_cashouts
BEGIN
  UPDATE order_payments SET depositOpen = CASE WHEN COALESCE((SELECT SUM(c.amountCents) FROM payment_cashouts c JOIN account_transfers t ON t.id = c.transferId AND t.deletedAt IS NULL
      WHERE c.paymentId = order_payments.id), 0) < order_payments.amountCents
    AND NOT EXISTS (SELECT 1 FROM statement_matches m WHERE m.src = 'payment' AND m.srcId = order_payments.id) THEN 1 ELSE 0 END WHERE id = OLD.paymentId;
END;
CREATE TRIGGER IF NOT EXISTS transfers_deposit_open AFTER UPDATE OF deletedAt ON account_transfers
BEGIN
  UPDATE order_payments SET depositOpen = CASE WHEN COALESCE((SELECT SUM(c.amountCents) FROM payment_cashouts c JOIN account_transfers t ON t.id = c.transferId AND t.deletedAt IS NULL
      WHERE c.paymentId = order_payments.id), 0) < order_payments.amountCents
    AND NOT EXISTS (SELECT 1 FROM statement_matches m WHERE m.src = 'payment' AND m.srcId = order_payments.id) THEN 1 ELSE 0 END
  WHERE id IN (SELECT paymentId FROM payment_cashouts WHERE transferId = NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS matches_deposit_open_insert AFTER INSERT ON statement_matches WHEN NEW.src = 'payment'
BEGIN
  UPDATE order_payments SET depositOpen = 0 WHERE id = NEW.srcId;
END;
CREATE TRIGGER IF NOT EXISTS matches_deposit_open_update AFTER UPDATE ON statement_matches
BEGIN
  UPDATE order_payments SET depositOpen = CASE WHEN COALESCE((SELECT SUM(c.amountCents) FROM payment_cashouts c JOIN account_transfers t ON t.id = c.transferId AND t.deletedAt IS NULL
      WHERE c.paymentId = order_payments.id), 0) < order_payments.amountCents
    AND NOT EXISTS (SELECT 1 FROM statement_matches m WHERE m.src = 'payment' AND m.srcId = order_payments.id) THEN 1 ELSE 0 END
  WHERE (OLD.src = 'payment' AND id = OLD.srcId) OR (NEW.src = 'payment' AND id = NEW.srcId);
END;
CREATE TRIGGER IF NOT EXISTS matches_deposit_open_delete AFTER DELETE ON statement_matches WHEN OLD.src = 'payment'
BEGIN
  UPDATE order_payments SET depositOpen = CASE WHEN COALESCE((SELECT SUM(c.amountCents) FROM payment_cashouts c JOIN account_transfers t ON t.id = c.transferId AND t.deletedAt IS NULL
      WHERE c.paymentId = order_payments.id), 0) < order_payments.amountCents
    AND NOT EXISTS (SELECT 1 FROM statement_matches m WHERE m.src = 'payment' AND m.srcId = order_payments.id) THEN 1 ELSE 0 END WHERE id = OLD.srcId;
END;

CREATE TABLE IF NOT EXISTS reconciliations (
  accountId                  INTEGER NOT NULL REFERENCES accounts(id),
  month                      TEXT NOT NULL CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  statementEndingBalanceCents INTEGER NOT NULL,
  bookBalanceCents           INTEGER NOT NULL,
  reconciledAt               TEXT NOT NULL,
  reconciledBy               TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (accountId, month)
);

-- Configurable products + transfer-sheet inventory + reorder QR (migrations/0036).
CREATE TABLE IF NOT EXISTS transfers (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT NOT NULL DEFAULT '',
  description        TEXT NOT NULL DEFAULT '',
  orgIdsJson         TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(orgIdsJson)),
  quantity           INTEGER NOT NULL DEFAULT 0,
  purchasePriceCents INTEGER NOT NULL DEFAULT 0 CHECK (purchasePriceCents >= 0),
  visible            INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0, 1)),
  sortOrder          INTEGER NOT NULL DEFAULT 0,
  createdAt          TEXT NOT NULL,
  updatedAt          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transfer_movements (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  receiptGroup  TEXT,  -- 0061: ties the records one receive wrote together
  transferId    INTEGER NOT NULL,
  transferName  TEXT NOT NULL DEFAULT '',
  qtyDelta      INTEGER NOT NULL CHECK (qtyDelta <> 0),
  unitCostCents INTEGER NOT NULL DEFAULT 0 CHECK (unitCostCents >= 0),
  kind          TEXT NOT NULL CHECK (kind IN ('purchase', 'consume', 'adjust', 'writeoff')),
  orderId       TEXT,
  itemId        INTEGER,
  vendor        TEXT NOT NULL DEFAULT '',
  vendorRef     TEXT NOT NULL DEFAULT '',
  note          TEXT NOT NULL DEFAULT '',
  pctOfSheet    REAL,
  occurredAt    TEXT NOT NULL,
  createdAt     TEXT NOT NULL,
  accountId     INTEGER REFERENCES accounts(id),
  paidPersonally INTEGER NOT NULL DEFAULT 0 CHECK (paidPersonally IN (0, 1)),
  receiptKey    TEXT NOT NULL DEFAULT '',
  receiptName   TEXT NOT NULL DEFAULT '',
  voidedAt      TEXT,
  voidReason    TEXT NOT NULL DEFAULT '',
  reason        TEXT NOT NULL DEFAULT '',   -- 0080: 'finished' = used making finished stock (not cost of goods)
  finishedMovementId INTEGER,               -- 0080: the finished_goods_movements make it went into
  requestKey    TEXT                        -- 0107: the Receive form's key for this row, so a retry can't record it twice
);
CREATE INDEX IF NOT EXISTS idx_transfer_mv_finished ON transfer_movements (finishedMovementId) WHERE finishedMovementId IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transfer_movements_item     ON transfer_movements(transferId, occurredAt);
-- migrations/0106: by order line (despite its name, the index above is by transfer) — the transfers a line used.
CREATE INDEX IF NOT EXISTS idx_transfer_movements_itemId   ON transfer_movements(itemId) WHERE itemId IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transfer_movements_occurred ON transfer_movements(occurredAt);
CREATE INDEX IF NOT EXISTS idx_transfer_movements_order    ON transfer_movements(orderId);

-- One account's money movements between two dates, from each source in db.js MONEY_MOVE_SOURCES (an account's
-- register and reconciliation), by account and the day the source is dated on (migrations/0100).
CREATE INDEX IF NOT EXISTS idx_payments_account_day     ON order_payments(accountId, substr(receivedAt, 1, 10));
CREATE INDEX IF NOT EXISTS idx_expenses_account_date    ON expenses(accountId, expenseDate);
CREATE INDEX IF NOT EXISTS idx_movements_account_day    ON inventory_movements(accountId, substr(occurredAt, 1, 10)) WHERE kind = 'purchase';
CREATE INDEX IF NOT EXISTS idx_transfer_movements_account_day ON transfer_movements(accountId, substr(occurredAt, 1, 10)) WHERE kind = 'purchase';
CREATE INDEX IF NOT EXISTS idx_labels_account_day       ON shipping_labels(accountId, substr(purchasedAt, 1, 10));
CREATE INDEX IF NOT EXISTS idx_other_income_account     ON other_income(accountId, incomeDate);
CREATE INDEX IF NOT EXISTS idx_owner_tx_account         ON owner_transactions(accountId, txDate);
CREATE INDEX IF NOT EXISTS idx_transfers_from_account   ON account_transfers(fromAccountId, transferDate);
CREATE INDEX IF NOT EXISTS idx_transfers_to_account     ON account_transfers(toAccountId, transferDate);

CREATE TABLE IF NOT EXISTS graphics (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  orgId                    TEXT NOT NULL REFERENCES orgs(orgId),
  name                     TEXT NOT NULL,
  kind                     TEXT NOT NULL DEFAULT 'transfer' CHECK (kind IN ('embroidery', 'transfer')),
  designId                 INTEGER REFERENCES designs(id),
  transferId               INTEGER REFERENCES transfers(id),
  tier                     TEXT CHECK (tier IS NULL OR tier IN ('small', 'medium', 'large')),
  inkColorsJson            TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(inkColorsJson)),
  imageUrl                 TEXT NOT NULL DEFAULT '',
  thumbUrl                 TEXT NOT NULL DEFAULT '',
  allowedLocationsJson     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(allowedLocationsJson)),
  allowedGarmentColorsJson TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(allowedGarmentColorsJson)),
  visible                  INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0, 1)),
  sortOrder                INTEGER NOT NULL DEFAULT 0,
  createdAt                TEXT NOT NULL,
  updatedAt                TEXT NOT NULL,
  -- migrations/0078: every shop can use it (its design must be global too).
  isGlobal                 INTEGER NOT NULL DEFAULT 0 CHECK (isGlobal IN (0, 1)),
  -- migrations/0118: what prints a transfer graphic; '' = DTF (and an embroidery graphic keeps '').
  decoration               TEXT NOT NULL DEFAULT '' CHECK (decoration IN ('', 'dtf', 'screenprint', 'vinyl', 'dtg', 'sublimation'))
);
CREATE INDEX IF NOT EXISTS idx_graphics_org ON graphics(orgId);

-- Receipt links (migrations/0061): the records one receive wrote share a receiptGroup.
CREATE INDEX IF NOT EXISTS idx_inventory_movements_receiptGroup ON inventory_movements(receiptGroup) WHERE receiptGroup IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transfer_movements_receiptGroup  ON transfer_movements(receiptGroup)  WHERE receiptGroup IS NOT NULL;
-- Received stock is recorded once per Save of its form (migrations/0107).
CREATE UNIQUE INDEX IF NOT EXISTS idx_movements_request_key          ON inventory_movements(requestKey) WHERE requestKey IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_transfer_movements_request_key ON transfer_movements(requestKey)  WHERE requestKey IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_expenses_receiptGroup            ON expenses(receiptGroup)            WHERE receiptGroup IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_owner_transactions_receiptGroup  ON owner_transactions(receiptGroup)  WHERE receiptGroup IS NOT NULL;

-- Vendor connections through PromoStandards (migrations/0065); credentials AES-GCM encrypted.
CREATE TABLE IF NOT EXISTS vendor_connections (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  companyCode    TEXT    NOT NULL,
  name           TEXT    NOT NULL,
  endpointsJson  TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(endpointsJson)),
  credentialsEnc TEXT    NOT NULL DEFAULT '',
  overridesJson  TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(overridesJson)),
  status         TEXT    NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'ok', 'error')),
  lastTestedAt   TEXT,
  lastRefreshAt  TEXT,
  lastError      TEXT    NOT NULL DEFAULT '',
  createdAt      TEXT    NOT NULL,
  updatedAt      TEXT    NOT NULL
);

-- migrations/0071: machine counters and maintenance.
-- Every change to a machine's counters: a run (done / untimed), an aborted run, or a reading typed from the machine.
-- No FK on machineId, like production_runs: the history outlives a deleted machine.
CREATE TABLE IF NOT EXISTS machine_counter_events (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  machineId         INTEGER NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('run', 'abort', 'reading')),
  runId             INTEGER,
  stitchesDelta     INTEGER NOT NULL DEFAULT 0,
  secondsDelta      INTEGER NOT NULL DEFAULT 0,
  stitchTotalAfter  INTEGER NOT NULL DEFAULT 0,
  secondsTotalAfter INTEGER NOT NULL DEFAULT 0,
  estimated         INTEGER NOT NULL DEFAULT 0 CHECK (estimated IN (0, 1)),
  note              TEXT NOT NULL DEFAULT '',
  actor             TEXT NOT NULL DEFAULT '',
  at                TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_counter_events_machine ON machine_counter_events(machineId, at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_counter_events_one_per_run ON machine_counter_events(runId) WHERE runId IS NOT NULL;

-- Per-machine maintenance tasks: due every N seconds of run time and/or every N stitches (whichever comes first),
-- counted from when it was last done (seeded with the counters when the task is created).
CREATE TABLE IF NOT EXISTS machine_maintenance_tasks (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  machineId        INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  everySeconds     INTEGER CHECK (everySeconds IS NULL OR everySeconds > 0),
  everyStitches    INTEGER CHECK (everyStitches IS NULL OR everyStitches > 0),
  notes            TEXT NOT NULL DEFAULT '',
  active           INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  sortOrder        INTEGER NOT NULL DEFAULT 0,
  lastDoneAt       TEXT,
  lastDoneStitches INTEGER NOT NULL DEFAULT 0,
  lastDoneSeconds  INTEGER NOT NULL DEFAULT 0,
  createdAt        TEXT NOT NULL,
  updatedAt        TEXT NOT NULL,
  CHECK (everySeconds IS NOT NULL OR everyStitches IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_maint_tasks_machine ON machine_maintenance_tasks(machineId, sortOrder);

-- What was done and when, with the counters at that moment. taskId NULL = other work, not a listed task.
CREATE TABLE IF NOT EXISTS machine_maintenance_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  machineId     INTEGER NOT NULL,
  machineName   TEXT NOT NULL DEFAULT '',
  taskId        INTEGER,
  taskName      TEXT NOT NULL DEFAULT '',
  doneAt        TEXT NOT NULL,
  stitchCountAt INTEGER NOT NULL DEFAULT 0,
  runSecondsAt  INTEGER NOT NULL DEFAULT 0,
  note          TEXT NOT NULL DEFAULT '',
  actor         TEXT NOT NULL DEFAULT '',
  createdAt     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_maint_log_machine ON machine_maintenance_log(machineId, doneAt);

-- Orders placed with a supplier through PromoStandards sendPO (migrations/0072).
CREATE TABLE IF NOT EXISTS supplier_orders (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  connectionId        INTEGER NOT NULL,
  vendor              TEXT    NOT NULL DEFAULT '',
  environment         TEXT    NOT NULL DEFAULT 'production' CHECK (environment IN ('production', 'test')),
  poNumber            TEXT    NOT NULL UNIQUE,
  status              TEXT    NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'placed', 'failed', 'unknown')),
  transactionId       TEXT    NOT NULL DEFAULT '',
  error               TEXT    NOT NULL DEFAULT '',
  carrier             TEXT    NOT NULL DEFAULT '',
  service             TEXT    NOT NULL DEFAULT '',
  shipToJson          TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(shipToJson)),
  totalCents          INTEGER NOT NULL DEFAULT 0 CHECK (totalCents >= 0),
  linesJson           TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(linesJson)),
  itemIdsJson         TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(itemIdsJson)),
  createdAt           TEXT    NOT NULL,
  createdBy           TEXT    NOT NULL DEFAULT '',
  placedAt            TEXT,
  lastShipmentCheckAt TEXT,
  cancelledAt         TEXT,
  cancelNote          TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_supplier_orders_created ON supplier_orders(createdAt);

-- Restock orders placed by hand, recorded so the restock isn't suggested again while on its way (migrations/0074).
CREATE TABLE IF NOT EXISTS blank_restock_orders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor     TEXT NOT NULL DEFAULT '',
  reference  TEXT NOT NULL DEFAULT '',
  linesJson  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(linesJson)),
  createdAt  TEXT NOT NULL,
  createdBy  TEXT NOT NULL DEFAULT '',
  voidedAt   TEXT
);
CREATE INDEX IF NOT EXISTS idx_blank_restock_orders_created ON blank_restock_orders(createdAt);

-- Brand approvals: a supplier's logo approval per product + brand, with its file (migrations/0075).
CREATE TABLE IF NOT EXISTS brand_approvals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  orgId       TEXT    NOT NULL,
  productId   TEXT    NOT NULL,
  brand       TEXT    NOT NULL,
  approvedOn  TEXT    NOT NULL,
  maxQty      INTEGER CHECK (maxQty IS NULL OR maxQty > 0),
  note        TEXT    NOT NULL DEFAULT '',
  fileKey     TEXT    NOT NULL,
  fileName    TEXT    NOT NULL DEFAULT '',
  createdBy   TEXT    NOT NULL DEFAULT '',
  createdAt   TEXT    NOT NULL,
  revokedAt   TEXT,
  revokeNote  TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_brand_approvals_product ON brand_approvals(orgId, productId);

-- A shop's published catalog (its orgs + products rows), what shoppers see and orders are priced from (migrations/0076).
CREATE TABLE IF NOT EXISTS catalog_snapshots (
  orgId        TEXT    PRIMARY KEY,
  json         TEXT    NOT NULL CHECK (json_valid(json)),
  publishedAt  TEXT    NOT NULL,
  publishedBy  TEXT    NOT NULL DEFAULT ''
);
-- …and, for a shop published since migrations/0101, its products rows in parts of up to about 1 MB (D1 limits one value).
CREATE TABLE IF NOT EXISTS catalog_snapshot_parts (
  orgId  TEXT    NOT NULL,
  part   INTEGER NOT NULL,
  json   TEXT    NOT NULL CHECK (json_valid(json)),
  PRIMARY KEY (orgId, part)
);

-- Every call to a connected vendor's web services; full payloads in R2 vendor-logs/ (migrations/0078).
CREATE TABLE IF NOT EXISTS vendor_api_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  connectionId  INTEGER NOT NULL,
  at            TEXT    NOT NULL,
  context       TEXT    NOT NULL DEFAULT '',
  action        TEXT    NOT NULL DEFAULT '',
  url           TEXT    NOT NULL DEFAULT '',
  subject       TEXT    NOT NULL DEFAULT '',
  httpStatus    INTEGER,
  ok            INTEGER NOT NULL DEFAULT 1 CHECK (ok IN (0, 1)),
  error         TEXT    NOT NULL DEFAULT '',
  durationMs    INTEGER NOT NULL DEFAULT 0,
  requestBytes  INTEGER NOT NULL DEFAULT 0,
  responseBytes INTEGER NOT NULL DEFAULT 0,
  payloadKey    TEXT    NOT NULL DEFAULT '',
  payload       TEXT    NOT NULL DEFAULT '',
  actor         TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_vendor_api_log_conn ON vendor_api_log(connectionId, id);
CREATE INDEX IF NOT EXISTS idx_vendor_api_log_at ON vendor_api_log(at);

-- Digital products: a product's files, each paid order line's download grants, and each download (migrations/0086).
CREATE TABLE IF NOT EXISTS product_files (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  orgId      TEXT    NOT NULL,
  productId  TEXT    NOT NULL,
  fileKey    TEXT    NOT NULL CHECK (length(fileKey) > 0),
  fileName   TEXT    NOT NULL DEFAULT '',
  fileExt    TEXT    NOT NULL DEFAULT '',
  bytes      INTEGER NOT NULL DEFAULT 0 CHECK (bytes >= 0),
  sortOrder  INTEGER NOT NULL DEFAULT 0,
  createdAt  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_product_files_product ON product_files(orgId, productId, sortOrder);

CREATE TABLE IF NOT EXISTS download_grants (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  orderId        TEXT    NOT NULL REFERENCES orders(orderId) ON DELETE CASCADE,
  itemId         INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  fileKey        TEXT    NOT NULL,
  fileName       TEXT    NOT NULL DEFAULT '',
  fileExt        TEXT    NOT NULL DEFAULT '',
  bytes          INTEGER NOT NULL DEFAULT 0,
  expiresAt      TEXT,
  maxDownloads   INTEGER CHECK (maxDownloads IS NULL OR maxDownloads >= 0),
  downloads      INTEGER NOT NULL DEFAULT 0 CHECK (downloads >= 0),
  lastDownloadAt TEXT,
  revokedAt      TEXT,
  createdAt      TEXT    NOT NULL
);
-- One grant per line and file: granting twice (a webhook retry, a second payment) adds nothing.
CREATE UNIQUE INDEX IF NOT EXISTS idx_download_grants_item_file ON download_grants(itemId, fileKey);
CREATE INDEX IF NOT EXISTS idx_download_grants_order ON download_grants(orderId);

CREATE TABLE IF NOT EXISTS download_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  grantId    INTEGER NOT NULL REFERENCES download_grants(id) ON DELETE CASCADE,
  at         TEXT    NOT NULL,
  network    TEXT    NOT NULL DEFAULT '',
  userAgent  TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_download_log_grant ON download_log(grantId, at);

-- Orders imported from another store (migrations/0087): the same store order is only imported once per shop.
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_external ON orders(orgId, source, externalOrderId) WHERE externalOrderId IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customerId);   -- migrations/0108

-- Versioned list cache (migrations/0102): one version per admin reference list, raised by the triggers below on
-- every change to a table behind it. '_ns' is a random number per database (Cache API keys).
CREATE TABLE IF NOT EXISTS list_cache_versions (
  name     TEXT    PRIMARY KEY,
  version  INTEGER NOT NULL DEFAULT 1
);
INSERT OR IGNORE INTO list_cache_versions (name, version) VALUES
  ('blanks', 1), ('threads', 1), ('hoops', 1), ('locations', 1), ('machines', 1), ('orgs', 1), ('_ns', abs(random()) % 1000000000000);
CREATE TRIGGER IF NOT EXISTS lcv_blanks_ins AFTER INSERT ON blanks
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'blanks'; END;
CREATE TRIGGER IF NOT EXISTS lcv_blanks_upd AFTER UPDATE ON blanks
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'blanks'; END;
CREATE TRIGGER IF NOT EXISTS lcv_blanks_del AFTER DELETE ON blanks
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'blanks'; END;
CREATE TRIGGER IF NOT EXISTS lcv_blank_sizes_ins AFTER INSERT ON blank_sizes
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'blanks'; END;
CREATE TRIGGER IF NOT EXISTS lcv_blank_sizes_upd AFTER UPDATE ON blank_sizes
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'blanks'; END;
CREATE TRIGGER IF NOT EXISTS lcv_blank_sizes_del AFTER DELETE ON blank_sizes
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'blanks'; END;
CREATE TRIGGER IF NOT EXISTS lcv_blank_colors_ins AFTER INSERT ON blank_colors
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'blanks'; END;
CREATE TRIGGER IF NOT EXISTS lcv_blank_colors_upd AFTER UPDATE ON blank_colors
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'blanks'; END;
CREATE TRIGGER IF NOT EXISTS lcv_blank_colors_del AFTER DELETE ON blank_colors
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'blanks'; END;
CREATE TRIGGER IF NOT EXISTS lcv_needle_types_ins AFTER INSERT ON needle_types
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'blanks'; END;
CREATE TRIGGER IF NOT EXISTS lcv_needle_types_upd AFTER UPDATE ON needle_types
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'blanks'; END;
CREATE TRIGGER IF NOT EXISTS lcv_needle_types_del AFTER DELETE ON needle_types
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'blanks'; END;
CREATE TRIGGER IF NOT EXISTS lcv_threads_ins AFTER INSERT ON threads
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'threads'; END;
CREATE TRIGGER IF NOT EXISTS lcv_threads_upd AFTER UPDATE ON threads
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'threads'; END;
CREATE TRIGGER IF NOT EXISTS lcv_threads_del AFTER DELETE ON threads
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'threads'; END;
CREATE TRIGGER IF NOT EXISTS lcv_thread_inventory_ins AFTER INSERT ON thread_inventory
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'threads'; END;
CREATE TRIGGER IF NOT EXISTS lcv_thread_inventory_upd AFTER UPDATE ON thread_inventory
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'threads'; END;
CREATE TRIGGER IF NOT EXISTS lcv_thread_inventory_del AFTER DELETE ON thread_inventory
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'threads'; END;
CREATE TRIGGER IF NOT EXISTS lcv_spool_sizes_ins AFTER INSERT ON spool_sizes
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'threads'; END;
CREATE TRIGGER IF NOT EXISTS lcv_spool_sizes_upd AFTER UPDATE ON spool_sizes
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'threads'; END;
CREATE TRIGGER IF NOT EXISTS lcv_spool_sizes_del AFTER DELETE ON spool_sizes
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'threads'; END;
CREATE TRIGGER IF NOT EXISTS lcv_hoops_ins AFTER INSERT ON hoops
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'hoops'; END;
CREATE TRIGGER IF NOT EXISTS lcv_hoops_upd AFTER UPDATE ON hoops
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'hoops'; END;
CREATE TRIGGER IF NOT EXISTS lcv_hoops_del AFTER DELETE ON hoops
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'hoops'; END;
CREATE TRIGGER IF NOT EXISTS lcv_locations_ins AFTER INSERT ON locations
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'locations'; END;
CREATE TRIGGER IF NOT EXISTS lcv_locations_upd AFTER UPDATE ON locations
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'locations'; END;
CREATE TRIGGER IF NOT EXISTS lcv_locations_del AFTER DELETE ON locations
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'locations'; END;
CREATE TRIGGER IF NOT EXISTS lcv_machines_ins AFTER INSERT ON machines
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'machines'; END;
CREATE TRIGGER IF NOT EXISTS lcv_machines_upd AFTER UPDATE ON machines
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'machines'; END;
CREATE TRIGGER IF NOT EXISTS lcv_machines_del AFTER DELETE ON machines
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'machines'; END;
CREATE TRIGGER IF NOT EXISTS lcv_machine_hoops_ins AFTER INSERT ON machine_hoops
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'machines'; END;
CREATE TRIGGER IF NOT EXISTS lcv_machine_hoops_upd AFTER UPDATE ON machine_hoops
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'machines'; END;
CREATE TRIGGER IF NOT EXISTS lcv_machine_hoops_del AFTER DELETE ON machine_hoops
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'machines'; END;
CREATE TRIGGER IF NOT EXISTS lcv_machine_needles_ins AFTER INSERT ON machine_needles
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'machines'; END;
CREATE TRIGGER IF NOT EXISTS lcv_machine_needles_upd AFTER UPDATE ON machine_needles
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'machines'; END;
CREATE TRIGGER IF NOT EXISTS lcv_machine_needles_del AFTER DELETE ON machine_needles
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'machines'; END;
CREATE TRIGGER IF NOT EXISTS lcv_machine_maintenance_tasks_ins AFTER INSERT ON machine_maintenance_tasks
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'machines'; END;
CREATE TRIGGER IF NOT EXISTS lcv_machine_maintenance_tasks_upd AFTER UPDATE ON machine_maintenance_tasks
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'machines'; END;
CREATE TRIGGER IF NOT EXISTS lcv_machine_maintenance_tasks_del AFTER DELETE ON machine_maintenance_tasks
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'machines'; END;
CREATE TRIGGER IF NOT EXISTS lcv_orgs_ins AFTER INSERT ON orgs
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'orgs'; END;
CREATE TRIGGER IF NOT EXISTS lcv_orgs_upd AFTER UPDATE ON orgs
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'orgs'; END;
CREATE TRIGGER IF NOT EXISTS lcv_orgs_del AFTER DELETE ON orgs
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'orgs'; END;

-- Month-end stock snapshots (migrations/0103): the replay state of blanks, transfers and finished stock at the end of
-- a closed month, written the first time a report needs it. The triggers below delete every snapshot from a
-- changed movement's month on, so none can outlive a change under it.
CREATE TABLE IF NOT EXISTS inventory_period_snapshots (
  month     TEXT    NOT NULL,
  kind      TEXT    NOT NULL,
  key       TEXT    NOT NULL,
  qty       INTEGER NOT NULL DEFAULT 0,
  avgCents  INTEGER NOT NULL DEFAULT 0,
  name      TEXT,
  label     TEXT,
  PRIMARY KEY (month, kind, key)
);

CREATE TRIGGER IF NOT EXISTS ips_inventory_movements_ins AFTER INSERT ON inventory_movements
BEGIN DELETE FROM inventory_period_snapshots WHERE month >= substr(NEW.occurredAt, 1, 7); END;
CREATE TRIGGER IF NOT EXISTS ips_inventory_movements_upd AFTER UPDATE ON inventory_movements
BEGIN DELETE FROM inventory_period_snapshots WHERE month >= substr(NEW.occurredAt, 1, 7) OR month >= substr(OLD.occurredAt, 1, 7); END;
CREATE TRIGGER IF NOT EXISTS ips_inventory_movements_del AFTER DELETE ON inventory_movements
BEGIN DELETE FROM inventory_period_snapshots WHERE month >= substr(OLD.occurredAt, 1, 7); END;
CREATE TRIGGER IF NOT EXISTS ips_transfer_movements_ins AFTER INSERT ON transfer_movements
BEGIN DELETE FROM inventory_period_snapshots WHERE month >= substr(NEW.occurredAt, 1, 7); END;
CREATE TRIGGER IF NOT EXISTS ips_transfer_movements_upd AFTER UPDATE ON transfer_movements
BEGIN DELETE FROM inventory_period_snapshots WHERE month >= substr(NEW.occurredAt, 1, 7) OR month >= substr(OLD.occurredAt, 1, 7); END;
CREATE TRIGGER IF NOT EXISTS ips_transfer_movements_del AFTER DELETE ON transfer_movements
BEGIN DELETE FROM inventory_period_snapshots WHERE month >= substr(OLD.occurredAt, 1, 7); END;
CREATE TRIGGER IF NOT EXISTS ips_finished_goods_movements_ins AFTER INSERT ON finished_goods_movements
BEGIN DELETE FROM inventory_period_snapshots WHERE month >= substr(NEW.occurredAt, 1, 7); END;
CREATE TRIGGER IF NOT EXISTS ips_finished_goods_movements_upd AFTER UPDATE ON finished_goods_movements
BEGIN DELETE FROM inventory_period_snapshots WHERE month >= substr(NEW.occurredAt, 1, 7) OR month >= substr(OLD.occurredAt, 1, 7); END;
CREATE TRIGGER IF NOT EXISTS ips_finished_goods_movements_del AFTER DELETE ON finished_goods_movements
BEGIN DELETE FROM inventory_period_snapshots WHERE month >= substr(OLD.occurredAt, 1, 7); END;

-- Settings → Orphaned images (migrations/0106): the scan runs in steps the screen drives, so one request never runs
-- more queries than Cloudflare allows. Between steps it keeps where it is (orphan_scans.state) and what it found
-- (orphan_scan_keys: 'ref' = an image key the database points to, 'orphan' = a file the scan called orphaned). A
-- scan's rows go when it ends with nothing orphaned, when its page starts the next scan, and once they're a day old
-- (functions/_lib/orphanImages.js); never searched for image addresses themselves.
CREATE TABLE IF NOT EXISTS orphan_scans (
  scanId    TEXT PRIMARY KEY,
  startedAt TEXT NOT NULL,
  state     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(state))
);
CREATE TABLE IF NOT EXISTS orphan_scan_keys (
  scanId TEXT NOT NULL,
  kind   TEXT NOT NULL CHECK (kind IN ('ref', 'orphan')),
  key    TEXT NOT NULL,
  PRIMARY KEY (scanId, kind, key)
) WITHOUT ROWID;
