-- =============================================================================
-- 0056 — Purchase-order "receive with brak (defect)" columns.
-- =============================================================================
-- Owner requirement (2026-06-08): EVERY receive / "qabul qilish" point in the
-- chain must let the receiver record each product's defective (brak) qty +
-- reason. The store receive (0045) and the central-warehouse
-- receive-from-production (0055) already capture brak; the raw-warehouse
-- purchase-order receive is the remaining gap.
--
-- When a raw_warehouse_manager receives an approved purchase order, the full
-- ordered qty enters the raw warehouse via the existing `purchase` movement.
-- If some of it is defective (brak), that qty is written OFF the raw warehouse
-- via an `adjust` movement (so only the sound qty remains — no double count),
-- and recorded here:
--
--   brak_qty    — the defective qty refused on receipt (0 / NULL = none).
--   brak_reason — free-form reason for the brak (required when brak_qty > 0).
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS; safe to re-run. Purely additive — no
-- data deleted, no enum change (the existing `purchase` / `adjust`
-- movement_reason values are reused).
-- =============================================================================

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS brak_qty    NUMERIC(14,4) NULL,
  ADD COLUMN IF NOT EXISTS brak_reason TEXT          NULL;

-- A non-negative guard for the brak qty (mirrors the application validation).
ALTER TABLE purchase_orders
  DROP CONSTRAINT IF EXISTS chk_po_brak_qty_nonneg;
ALTER TABLE purchase_orders
  ADD CONSTRAINT chk_po_brak_qty_nonneg
  CHECK (brak_qty IS NULL OR brak_qty >= 0);

COMMENT ON COLUMN purchase_orders.brak_qty IS
  '0056 — defective (brak) qty refused on receipt; written off the raw '
  'warehouse via an adjust movement so only the sound qty remains. NULL/0 = none.';
COMMENT ON COLUMN purchase_orders.brak_reason IS
  '0056 — free-form reason for the brak; required when brak_qty > 0.';
