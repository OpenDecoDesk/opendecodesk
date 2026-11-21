-- A shop's published products in parts (2026-11): one catalog_snapshots value held the shop's orgs row and every
-- products row, so a large catalog would pass D1's limit of about 2 MB for one value and Publish would fail. A new
-- Publish keeps the orgs row in catalog_snapshots (json {"org": …, "parts": n}) and the products rows here, in
-- parts of up to about 1 MB each (a JSON list of products rows, in order). A snapshot published before this (json
-- {"org": …, "products": […]}) is read as it is, until the shop is published again. Additive.
CREATE TABLE IF NOT EXISTS catalog_snapshot_parts (
  orgId  TEXT    NOT NULL,
  part   INTEGER NOT NULL,
  json   TEXT    NOT NULL CHECK (json_valid(json)),
  PRIMARY KEY (orgId, part)
);
