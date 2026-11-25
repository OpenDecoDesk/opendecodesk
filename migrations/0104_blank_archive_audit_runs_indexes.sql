-- Archived blanks, the audit log's action index and the finished-runs index (2026-11, review #82, #100, #98).
--   blanks.archivedAt   when a blank was archived (retired), NULL while in use. An archived blank is left off the
--                       Blanks screen (unless Show archived), product linking and vendor matching; its stock,
--                       movements, history and reports are unchanged (db.js getAllBlanks, setBlankArchived).
--   idx_audit_log_action  the Audit log's action filter reads by action name (db.js getAuditLog maps the typed text
--                       to the names it appears in), newest first.
--   idx_runs_done_finished  the pricing analysis' average run time reads the last 12 months of finished runs
--                       (db.js avgRunMinutesByProduct_) without walking the whole history.
-- ADDITIVE: a new column and two indexes.
ALTER TABLE blanks ADD COLUMN archivedAt TEXT;
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action, createdAt);
CREATE INDEX IF NOT EXISTS idx_runs_done_finished ON production_runs(finishedAt) WHERE status = 'done';
