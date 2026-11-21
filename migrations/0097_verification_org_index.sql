-- The Orders page reads the latest design verification of each order it shows (db.js getLatestVerificationsByOrg),
-- by shop and order, newest first. Until now only orderId was indexed.
-- ADDITIVE ONLY.
CREATE INDEX IF NOT EXISTS idx_verif_org_order_sent ON design_verifications(orgId, orderId, sentAt);
