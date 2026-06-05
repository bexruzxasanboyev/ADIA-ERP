-- =============================================================================
-- 0045 — Replenishment "receive with brak (defect)" columns.
-- =============================================================================
-- The requester (do'kon / store) confirms physical receipt of a shipment. Some
-- of the delivered goods may be defective (brak) — broken, spoiled, wrong. The
-- defective quantity is NOT added to sellable stock: it is counter-shipped back
-- to the target_location_id and recorded here.
--
--   received_qty (qty_accepted) — the GOOD qty the store keeps (sellable).
--   brak_qty                    — the defective qty refused on receipt.
--   brak_reason                 — free-form reason for the brak.
--
-- The accept workflow (0024) reuses `qty_accepted` / `closure_reason`; this
-- migration only adds the two brak-specific columns. closure_reason stays
-- 'accepted_full' (no brak / no shortfall) or 'accepted_partial' (some brak or
-- shortfall counter-shipped back).
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS; safe to re-run.
-- =============================================================================

ALTER TABLE replenishment_requests
  ADD COLUMN IF NOT EXISTS brak_qty    NUMERIC(14,4) NULL,
  ADD COLUMN IF NOT EXISTS brak_reason TEXT          NULL;

-- A non-negative guard for the brak qty (mirrors the application validation).
ALTER TABLE replenishment_requests
  DROP CONSTRAINT IF EXISTS chk_replenishment_brak_qty_nonneg;
ALTER TABLE replenishment_requests
  ADD CONSTRAINT chk_replenishment_brak_qty_nonneg
  CHECK (brak_qty IS NULL OR brak_qty >= 0);
