-- =============================================================================
-- 0048 — overhead_costs (KPI production-costing: utilities / fixed overhead).
-- =============================================================================
-- Owner requirement (2026-06-06): the KPI / production-costing screen must fold
-- UTILITIES and other fixed overhead (electricity, gas, water, rent, ...) into
-- each finished product's full cost. The boss enters the month's overhead bills
-- here; the KPI endpoint spreads the month's total evenly over the units
-- produced that month (overhead_per_unit = Σ amount / total_units).
--
-- `period_month` is the FIRST DAY of the accounting month (e.g. 2026-06-01).
-- Storing a DATE (not a free month string) lets the KPI query filter a month
-- with a simple equality and keeps the index small.
--
-- `kind` is a small closed set; 'other' is the catch-all. `amount` is so'm
-- (UZS whole sum), numeric(14,2) to match the other money columns; >= 0.
--
-- IDEMPOTENT + non-destructive: CREATE TABLE IF NOT EXISTS.
-- =============================================================================

CREATE TABLE IF NOT EXISTS overhead_costs (
  id           SERIAL        PRIMARY KEY,
  period_month DATE          NOT NULL,                 -- first day of the month
  kind         TEXT          NOT NULL
                             CHECK (kind IN ('electricity', 'gas', 'water', 'rent', 'other')),
  amount       NUMERIC(14,2) NOT NULL CHECK (amount >= 0),  -- so'm (UZS)
  note         TEXT,
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- The KPI query filters by month — keep that scan cheap.
CREATE INDEX IF NOT EXISTS ix_overhead_costs_period
  ON overhead_costs (period_month);

COMMENT ON TABLE overhead_costs IS
  'KPI costing — monthly utilities / fixed overhead (electricity, gas, water, '
  'rent, other) in so''m. period_month is the first day of the month. The KPI '
  'endpoint spreads the month total over units produced (overhead_per_unit).';
