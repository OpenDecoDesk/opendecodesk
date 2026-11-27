-- More than one discount code on an order, a minimum order and free-shipping codes, codes on quotes, reorders, and gift
-- cards (2026-11).
--   discount_code_uses  one use per (order, code) instead of one per order, so an order can carry several codes (the
--                       global "more than one code" rule decides whether it may; the old one-per-order index goes).
--   discount_codes      minOrderCents (the goods must come to at least this), freeShipping (the code also makes
--                       shipping free) and goodsOff (0 = it takes nothing off the goods: a "free shipping only" code
--                       is stored as percent 10000 with goodsOff 0 and freeShipping 1, so the kind CHECK is unchanged).
--   orders              reorderOf (the order a Local sale was copied from) and shippingDiscountCents (what free-shipping
--                       codes took off shipping; orderAmounts subtracts it from shipping).
--   estimates           discountCodes (the codes typed on a quote: JSON list, checked when it's sent, claimed when it
--                       becomes an order).
--   gift_cards          one row per card; a card is a PAYMENT method, never a discount, and a liability until spent.
--                       code is 16 characters from A-Z / 2-9 without look-alikes; sourceOrderId is the order that sold
--                       it online ('' = issued by staff), unique so a replayed payment can't make a second card.
--   gift_card_ledger    every change to a balance: issue, redeem, refund (money put back), adjust, void.
--   order_payments      giftCardId: the card a gift-card payment (or its refund) came from. A gift-card payment is
--                       method 'other' with accountId NULL (order_payments is referenced by payment_cashouts, so its
--                       method CHECK is not rebuilt).
-- Settings (no schema): discountRules { multiple }, giftCards { sellOnline, amounts, minCents, maxCents }.
-- ADDITIVE ONLY: columns, two tables and indexes; no table is rebuilt. Existing codes, orders and payments are unchanged
-- (the one index swap keeps every existing use valid: one use per order is still one use per (order, code)).
DROP INDEX IF EXISTS idx_discount_uses_order;
CREATE UNIQUE INDEX IF NOT EXISTS idx_discount_uses_order_code ON discount_code_uses(orderId, codeId);
CREATE INDEX IF NOT EXISTS idx_discount_uses_order ON discount_code_uses(orderId);

ALTER TABLE discount_codes ADD COLUMN minOrderCents INTEGER CHECK (minOrderCents IS NULL OR minOrderCents BETWEEN 1 AND 10000000);
ALTER TABLE discount_codes ADD COLUMN freeShipping INTEGER NOT NULL DEFAULT 0 CHECK (freeShipping IN (0, 1));
ALTER TABLE discount_codes ADD COLUMN goodsOff INTEGER NOT NULL DEFAULT 1 CHECK (goodsOff IN (0, 1));

ALTER TABLE orders ADD COLUMN reorderOf TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN shippingDiscountCents INTEGER NOT NULL DEFAULT 0 CHECK (shippingDiscountCents >= 0);

ALTER TABLE estimates ADD COLUMN discountCodes TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(discountCodes));

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
  requestKey     TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gift_cards_code ON gift_cards(code);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gift_cards_source ON gift_cards(sourceOrderId) WHERE sourceOrderId <> '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_gift_cards_request ON gift_cards(requestKey) WHERE requestKey IS NOT NULL;

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

ALTER TABLE order_payments ADD COLUMN giftCardId INTEGER;
CREATE INDEX IF NOT EXISTS idx_order_payments_giftcard ON order_payments(giftCardId) WHERE giftCardId IS NOT NULL;
