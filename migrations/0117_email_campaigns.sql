-- Email campaigns (2026-11): marketing emails to customers, from the Discount codes page's Email campaigns tab.
--   marketing_optouts           one row per address (trimmed, lower case) that asked for no marketing email. Held by
--                               the address, not the customer, so an address typed into a campaign by hand is covered
--                               too. source: 'checkout' (the box at checkout or on a Local sale was unticked — a later
--                               ticked box takes it back), 'unsubscribe' (the link in an email), 'reply' (the owner
--                               recorded a reply asking to stop), 'admin' (ticked on the customer). Only a 'checkout'
--                               row is ever taken back by a checkout; the others only by the owner on the customer.
--                               Order emails (receipts, invoices, shipping) never look at it.
--   email_campaigns             one row per campaign: its subject, inbox preview line, theme, design (designJson: the
--                               blocks, or raw HTML), who gets it (audienceJson), its discount (discountJson) and where it
--                               stands (draft → scheduled → sending → sent, or canceled). scheduledAt: when to start.
--   email_campaign_recipients   who a campaign is going to, written when it starts (the audience as it was then), one
--                               row per address. A row is taken for sending by one conditional UPDATE (queued →
--                               sending) before its email goes, so two runners can't both send it, and a crash mid-send
--                               leaves it 'sending' (never sent twice). code: the address's own discount code, if any.
-- ADDITIVE ONLY: three new tables and their indexes. Nothing existing is read or changed.
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
