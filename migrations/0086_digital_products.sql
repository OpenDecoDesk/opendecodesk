-- Digital products (2026-11): files a customer buys and downloads — digitized embroidery designs in one or more
-- formats, PDFs. Once the order is paid each line's files are "granted": a download page for the order (reached
-- straight after a card payment, and linked from the email) and the files attached to the email, within limits.
--
--   products.digital             1 = sold as files: no blank, no production, no shipping, one price.
--   products.digitalDeliveryJson the product's own delivery settings, '{}' = the global ones (db.js DIGITAL_DEFAULTS):
--                                {days, downloads, attach, email} — days / downloads null = no limit.
--   product_files                the files a digital product delivers. `fileKey` is in the private DESIGNS bucket:
--                                digital/<org>/<product>/<random>.<ext> (uploaded for it) or a Designs library
--                                version's own file (shared, not copied).
--   download_grants              one per order line × file, made once when the order is paid (db.js
--                                grantOrderDownloads). A refund, void or the admin's Revoke sets revokedAt.
--   orders.downloadSalt          the order's download link is /api/download?o=<orderId>&t=<token>, the token an HMAC of
--                                the order id and this random salt under the install's signing secret (http.js) — so
--                                the link can be made again whenever it's needed (the page after a card payment, the
--                                email) and nothing that opens it is stored. Resend link draws a new salt: the old
--                                link stops working.
--   orders.downloadsEmailedAt    when the "Your downloads" email went out (sent once, after the order is paid).
--   download_log                 each download served: when, the requester's network (IPv4 /24, IPv6 /64) and
--                                browser, for a dispute.
--
-- ADDITIVE ONLY: apply before deploying the code that uses it.

ALTER TABLE products ADD COLUMN digital INTEGER NOT NULL DEFAULT 0 CHECK (digital IN (0, 1));
ALTER TABLE products ADD COLUMN digitalDeliveryJson TEXT NOT NULL DEFAULT '{}';
ALTER TABLE orders ADD COLUMN downloadSalt TEXT;
ALTER TABLE orders ADD COLUMN downloadsEmailedAt TEXT;

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
