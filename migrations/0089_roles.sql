-- Configurable roles (functions/_lib/permissions.js). Until now a role was one of three fixed words
-- ranked in code. Now each role is a row: which menus and items it sees, and for each function of the
-- back office how far it may go (none / read / edit / full).
--   key          what users.role holds ('admin', 'manager', 'staff' = Back office, 'production', or a
--                custom role's key)
--   rank         who may change whom: only a higher rank changes a user or a role of a lower one
--   locked       Admin: always full, never edited
--   permissions  JSON {menus, items, fns}; NULL = the built-in defaults in permissions.js
-- The built-in rows are seeded with NULL permissions, so they follow the defaults in code until
-- someone edits them on Users → Roles and permissions.
-- ADDITIVE ONLY: apply before deploying the code that uses it (`npm run deploy` does both).
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
