-- =============================================================================
-- 0047 — users.monthly_salary (KPI production-costing: labor cost input).
-- =============================================================================
-- Owner requirement (2026-06-06): the KPI / production-costing screen must
-- fold LABOR into each finished product's full cost. Labor is modelled as the
-- sum of every ACTIVE employee's monthly salary, spread evenly over the units
-- produced that month (salary_per_unit = Σ monthly_salary / total_units).
--
-- This column holds ONE employee's gross monthly pay in so'm. NULLABLE — NULL
-- means "salary not set yet" and is excluded from the SUM (SUM ignores NULL),
-- so a half-configured roster simply contributes the salaries that ARE known.
--
-- UNIT: so'm per month (UZS whole sum). numeric(14,2) matches the other money
-- columns (sales.price, products.*_cost). A value must be >= 0.
--
-- IDEMPOTENT + non-destructive: ADD COLUMN IF NOT EXISTS, no data rewritten.
-- =============================================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS monthly_salary NUMERIC(14,2)
    CHECK (monthly_salary IS NULL OR monthly_salary >= 0);

COMMENT ON COLUMN users.monthly_salary IS
  'KPI costing — one employee''s gross monthly pay in so''m (UZS). NULL = not '
  'set (excluded from the labor SUM). Feeds salary_per_unit in '
  'GET /api/kpi/products. Edited via PATCH /api/users/:id/salary (pm only).';
