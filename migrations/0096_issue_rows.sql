-- System problems and failed admin sign-ins for the daily roll-up, one row each instead of one JSON value in
-- global_settings ('systemIssues' / 'failedAdminLogins'). The JSON value was read, changed and written back, so two
-- failures at the same moment counted as one, and the roll-up deleted the whole value after sending, losing anything
-- recorded while it was sending. Now each failure is its own INSERT, and the roll-up deletes only the rows it read
-- (id <= the highest id it reported).
--   n   how many failures the row stands for: 1 for every new row; the totals carried over from the old JSON value
--       below, and 0 on a row kept only for a sample or an address.
-- ADDITIVE: the old values are copied in and removed, nothing else changes.
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

-- Carry over anything not yet reported. System problems: per kind, the count (at its first time), its last time,
-- and each sample it kept.
INSERT INTO system_issues (kind, n, sample, at)
  SELECT k.key, MAX(0, CAST(COALESCE(json_extract(k.value, '$.count'), 0) AS INTEGER)), '', COALESCE(json_extract(k.value, '$.first'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  FROM global_settings g, json_each(g.value, '$.kinds') k WHERE g.key = 'systemIssues' AND json_valid(g.value);
INSERT INTO system_issues (kind, n, sample, at)
  SELECT k.key, 0, '', json_extract(k.value, '$.last')
  FROM global_settings g, json_each(g.value, '$.kinds') k WHERE g.key = 'systemIssues' AND json_valid(g.value) AND json_extract(k.value, '$.last') IS NOT NULL;
INSERT INTO system_issues (kind, n, sample, at)
  SELECT k.key, 0, substr(CAST(s.value AS TEXT), 1, 200), COALESCE(json_extract(k.value, '$.last'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  FROM global_settings g, json_each(g.value, '$.kinds') k, json_each(k.value, '$.samples') s WHERE g.key = 'systemIssues' AND json_valid(g.value);
DELETE FROM global_settings WHERE key = 'systemIssues';

-- Failed sign-ins: the two counts (at the first and last times) and each address kept.
INSERT INTO failed_admin_logins (reason, ip, n, at)
  SELECT 'passphrase', '', MAX(0, CAST(COALESCE(json_extract(value, '$.passphrase'), 0) AS INTEGER)), COALESCE(json_extract(value, '$.first'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  FROM global_settings WHERE key = 'failedAdminLogins' AND json_valid(value);
INSERT INTO failed_admin_logins (reason, ip, n, at)
  SELECT 'code', '', MAX(0, CAST(COALESCE(json_extract(value, '$.code'), 0) AS INTEGER)), COALESCE(json_extract(value, '$.last'), json_extract(value, '$.first'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  FROM global_settings WHERE key = 'failedAdminLogins' AND json_valid(value);
INSERT INTO failed_admin_logins (reason, ip, n, at)
  SELECT 'passphrase', substr(CAST(i.value AS TEXT), 1, 45), 0, COALESCE(json_extract(g.value, '$.last'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  FROM global_settings g, json_each(g.value, '$.ips') i WHERE g.key = 'failedAdminLogins' AND json_valid(g.value);
DELETE FROM global_settings WHERE key = 'failedAdminLogins';
