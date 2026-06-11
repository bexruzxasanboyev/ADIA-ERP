-- =============================================================================
-- 0041 — products.recipe_yield (Mahsulot retsepti TZ — TZ-3 batch→per-unit).
-- =============================================================================
-- Poster's `menu.getProduct` does NOT expose a batch yield for FINISHED goods,
-- so a recipe entered "for the batch" (e.g. ПЕЧЕНЬЕ: 1 kg chocolate + 10 eggs
-- "per 1 dona") is imported as if it were per ONE piece — inflating both the
-- self-cost and the material requisition by the batch size. ~49 / 198 finished
-- products are affected.
--
-- `recipe_yield` = how many finished UNITS one full recipe produces. The cost
-- roll-up and the requisition math divide each line's `qty_per_unit` by the
-- product's `recipe_yield` to get the true per-1-piece figure. A correctly
-- per-unit recipe keeps the default 1 (no-op). Prepacks (semi) are already
-- per-unit (their batch `out` is normalised at import), so they stay 1 too.
--
-- The value is seeded by an AI estimate and confirmed/edited by the production
-- manager (owner decision 2026-06-05). Additive, non-destructive, idempotent.
-- =============================================================================

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS recipe_yield NUMERIC(14,4) NOT NULL DEFAULT 1
    CHECK (recipe_yield > 0);

COMMENT ON COLUMN products.recipe_yield IS
  'TZ-3 — how many finished units one full recipe yields. Cost + requisition '
  'divide qty_per_unit by this to get the per-1-piece figure. Default 1 = the '
  'recipe is already per-unit. Seeded by AI estimate, confirmed by the manager.';
