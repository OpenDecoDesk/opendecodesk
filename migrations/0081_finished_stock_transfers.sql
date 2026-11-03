-- Make for stock uses the piece's transfers too (2026-11): a finished piece that carries a printed transfer, a reorder
-- QR or a picked transfer graphic takes those applications out of transfer stock when it's made, at their average
-- cost, which is added to the piece's cost — like its blank. Those `consume` rows are moved INTO finished stock, not
-- cost of goods (it's counted when the piece is sold), so they're marked reason = 'finished' (as blanks' are), with
-- the finished_goods_movements row they went into (voiding that make puts them back). ADDITIVE.
ALTER TABLE transfer_movements ADD COLUMN reason TEXT NOT NULL DEFAULT '';
ALTER TABLE transfer_movements ADD COLUMN finishedMovementId INTEGER;
CREATE INDEX IF NOT EXISTS idx_transfer_mv_finished ON transfer_movements (finishedMovementId) WHERE finishedMovementId IS NOT NULL;
