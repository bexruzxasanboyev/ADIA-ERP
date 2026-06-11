-- =============================================================================
-- 0044 — products.manual_cost_per_unit (FEATURE A: editable MANUAL price).
-- =============================================================================
-- Owner requirement (2026-06-05): in the Products tab each product's price must
-- be editable by hand, and the WHOLE program must compute costs from the
-- MANUALLY-entered price, NOT Poster's synced self-price. A re-sync must NOT
-- overwrite a manual price.
--
-- WHY A SECOND COLUMN (not overwrite cost_per_unit):
--   * `cost_per_unit` is the Poster-synced figure — it is refreshed on every
--     sync (integrations/poster/seedSync.ts setRawIngredientCost). Storing the
--     manual override IN that column would make it indistinguishable from the
--     synced value and a sync would clobber it.
--   * a SEPARATE `manual_cost_per_unit` is the override layer: NULL means "no
--     manual price — use Poster's cost_per_unit"; a value means "the manager
--     pinned this price — it wins and survives re-sync".
--   * the effective cost everywhere is COALESCE(manual_cost_per_unit,
--     cost_per_unit) — the manual price takes precedence when set.
--
-- UNIT: identical to cost_per_unit — so'm per products.unit (kg / l / pcs).
-- NULLABLE: NULL is the normal state (no override). A non-null value must be
--   >= 0 (a price of 0 is allowed; clearing the override is done by setting it
--   back to NULL via PATCH /api/products/:id/cost).
--
-- IDEMPOTENT + non-destructive: ADD COLUMN IF NOT EXISTS, no data rewritten.
-- =============================================================================

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS manual_cost_per_unit NUMERIC(14,4)
    CHECK (manual_cost_per_unit IS NULL OR manual_cost_per_unit >= 0);

COMMENT ON COLUMN products.manual_cost_per_unit IS
  'FEATURE A — MANUAL unit-cost override in so''m per products.unit. When set '
  'it WINS over the Poster-synced cost_per_unit (effective cost = '
  'COALESCE(manual_cost_per_unit, cost_per_unit)) and SURVIVES re-sync '
  '(seedSync only updates cost_per_unit when this is NULL). NULL = no override, '
  'use the Poster cost. Edited via PATCH /api/products/:id/cost (pm / '
  'production_manager); set to NULL to clear the override.';
