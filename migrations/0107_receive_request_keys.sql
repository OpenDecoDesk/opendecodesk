-- One key per Save of the forms that record received stock (Receive blanks, Record order, Receive transfer sheet),
-- so a retry after a dropped connection — or after a failure part-way through an order of several blanks — can't
-- put the same purchase into stock, the average cost and the paying account twice (2026-11, as migrations/0095 did
-- for the payment forms).
--   inventory_movements.requestKey   the form's key for this row: "<form>:<its key>[:<blank's place in the order>]:<line>"
--   transfer_movements.requestKey    the same for a transfer sheet's rows
-- A movement is written, with its stock, only if no movement carries its key yet (db.js receiveBlanksOnce,
-- receiveTransferSheetOnce). NULL for every existing row, for requests without a key (older pages, scripts) and
-- for every movement that isn't a keyed receive.
-- ADDITIVE ONLY: apply before deploying the code that uses it (`npm run deploy` does both).
ALTER TABLE inventory_movements ADD COLUMN requestKey TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_movements_request_key ON inventory_movements(requestKey) WHERE requestKey IS NOT NULL;
ALTER TABLE transfer_movements ADD COLUMN requestKey TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_transfer_movements_request_key ON transfer_movements(requestKey) WHERE requestKey IS NOT NULL;
