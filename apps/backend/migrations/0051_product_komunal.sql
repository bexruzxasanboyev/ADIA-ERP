-- =============================================================================
-- 0051 — products.komunal_per_unit (KPI production-costing: per-product utility).
-- =============================================================================
-- Owner decision (2026-06-06): UTILITIES ("komunal") are no longer a shared
-- monthly pool spread over units produced. Instead the boss enters a per-unit
-- utility cost DIRECTLY on each finished product (exactly like the manual cost
-- and the kpi_target). This is a manual planning input, not a computed value.
--
-- The old overhead_costs pool (migration 0048) is now orphaned; its API is
-- removed but the table is intentionally LEFT in place (no destructive drop).
--
-- UNIT: so'm per finished UNIT (UZS whole sum). numeric(14,2) matches the other
-- money columns. NULLABLE — NULL means "not set" and the KPI row treats it as 0
-- when rolling up full_cost.
--
-- IDEMPOTENT + non-destructive: ADD COLUMN IF NOT EXISTS, no data rewritten.
-- =============================================================================

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS komunal_per_unit NUMERIC(14,2)
    CHECK (komunal_per_unit IS NULL OR komunal_per_unit >= 0);

COMMENT ON COLUMN products.komunal_per_unit IS
  'KPI costing — per-unit utility (komunal) cost the boss enters per finished '
  'product, in so''m (UZS). NULL = not set (treated as 0 in full_cost). Owner '
  'decision 2026-06-06 (replaces the shared overhead pool). Edited via PATCH '
  '/api/products/:id/komunal (pm / production_manager); returned per product by '
  'GET /api/kpi/products.';
