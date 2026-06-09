-- =============================================================================
-- 0061 — store_sales_plan (TZ Module 8 "Do'kon KPI" — store-level sales plan).
-- =============================================================================
-- Owner requirement (TZ §8): each store gets a MONTHLY SALES PLAN (in so'm).
-- The Do'kon KPI screen compares planned vs ACTUAL revenue (sum(qty*price) from
-- `sales`), shows the achievement %, the month-over-month growth, and ranks the
-- stores into a leaderboard. The plan is a planning INPUT entered by the PM /
-- admin — it is never computed.
--
-- One plan row per (location_id, month). `month` is the 'YYYY-MM' calendar
-- month label (CHAR(7)) so the unique key reads naturally and joins cleanly to
-- the kpi.ts month window. `target_sum` is the so'm goal for that month.
--
-- UNIT: so'm per month (UZS whole sum). numeric(14,2) matches `products.kpi_target`
-- and every other money column. CHECK keeps it non-negative.
--
-- created_by references the PM who set it (NULL on system writes / user delete).
-- updated_at is bumped by the upsert (ON CONFLICT ... DO UPDATE) in
-- PUT /api/store-kpi/plan.
--
-- IDEMPOTENT + non-destructive: CREATE TABLE / INDEX IF NOT EXISTS; safe re-run.
-- =============================================================================

CREATE TABLE IF NOT EXISTS store_sales_plan (
    id          BIGSERIAL     PRIMARY KEY,
    location_id BIGINT        NOT NULL REFERENCES locations(id),
    month       CHAR(7)       NOT NULL,                                       -- 'YYYY-MM'
    target_sum  NUMERIC(14,2) NOT NULL CHECK (target_sum >= 0),               -- so'm (UZS)
    created_by  BIGINT        REFERENCES users(id),
    created_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
    UNIQUE (location_id, month)
);

-- The leaderboard / KPI GET filters by month across all visible stores, so a
-- month index keeps that scan cheap once the table accumulates many months.
CREATE INDEX IF NOT EXISTS ix_store_sales_plan_month
    ON store_sales_plan (month);

COMMENT ON TABLE store_sales_plan IS
  'Do''kon KPI (TZ §8) — monthly sales plan per store. One row per '
  '(location_id, month). Compared against actual sum(qty*price) from `sales`. '
  'Upserted by PUT /api/store-kpi/plan (pm only); read by GET /api/store-kpi.';

COMMENT ON COLUMN store_sales_plan.month IS
  '''YYYY-MM'' calendar-month label the plan applies to.';

COMMENT ON COLUMN store_sales_plan.target_sum IS
  'Monthly sales target for this store in so''m (UZS). >= 0.';
