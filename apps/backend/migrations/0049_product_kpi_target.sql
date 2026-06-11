-- =============================================================================
-- 0049 — products.kpi_target (KPI production-costing: monthly sales target).
-- =============================================================================
-- Owner requirement (2026-06-06): on the KPI / production-costing screen the
-- boss pins a MONTHLY SALES TARGET (in so'm) per finished product, so the
-- screen can compare actual revenue against the goal. This is a planning input,
-- not a computed value.
--
-- UNIT: so'm per month (UZS whole sum). numeric(14,2) matches the other money
-- columns. NULLABLE — NULL means "no target set" and the KPI row returns null.
--
-- IDEMPOTENT + non-destructive: ADD COLUMN IF NOT EXISTS, no data rewritten.
-- =============================================================================

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS kpi_target NUMERIC(14,2)
    CHECK (kpi_target IS NULL OR kpi_target >= 0);

COMMENT ON COLUMN products.kpi_target IS
  'KPI costing — the boss''s monthly sales target for this product in so''m '
  '(UZS). NULL = no target set. Edited via PATCH /api/products/:id/kpi-target '
  '(pm / production_manager); returned per product by GET /api/kpi/products.';
