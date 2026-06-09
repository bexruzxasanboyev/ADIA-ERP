-- =============================================================================
-- 0064 — seller KPI (TZ Module 8 "Do'kon KPI" — SELLER / cashier level).
-- =============================================================================
-- The store-level KPI (migration 0061 `store_sales_plan`) ranks STORES. This
-- migration adds the per-SELLER (cashier / waiter) layer the owner asked for:
-- each seller's monthly sales total, an optional monthly target/plan, the
-- achievement %, month-over-month growth, and a seller leaderboard.
--
-- DATA SOURCE — Variant B (Poster waiter analytics). The local `sales` table
-- has NO seller dimension (a sale row only carries store_id + product_id), and
-- historical sales cannot be re-attributed to a seller. Poster's
-- `dash.getWaitersSales` returns HISTORICAL per-waiter revenue (filterable by
-- spot + date range) — so the ACTUAL revenue is read live from Poster, while
-- this schema persists only (a) the seller identity (a stable local id per
-- Poster waiter) and (b) the PM-entered monthly plan. Verified live against
-- account `adia` 2026-06-09: getWaitersSales returns `revenue` in TIYIN
-- (÷100 -> so'm), reconciling exactly with dash.getAnalytics.
--
--   sellers           — one row per Poster waiter we have seen. `poster_waiter_id`
--                       is Poster's `user_id` (TEXT — Poster ids are strings).
--                       `is_active` lets a seller be retired without deleting
--                       their history. Upserted lazily on the KPI read (and by
--                       POST /api/seller-kpi/sync) from the live waiter list.
--
--   seller_sales_plan — one plan row per (seller_id, month). `month` is the
--                       'YYYY-MM' calendar-month label (CHAR(7)) — same
--                       convention as store_sales_plan so the join + month
--                       window read identically. `target_sum` is the so'm goal.
--                       Upserted by PUT /api/seller-kpi/plan (pm only).
--
-- UNIT: target_sum is so'm per month (UZS whole sum). numeric(14,2) matches
-- `store_sales_plan.target_sum` and every other money column. CHECK keeps it
-- non-negative. created_by references the PM who set it.
--
-- IDEMPOTENT + non-destructive: CREATE TABLE / INDEX IF NOT EXISTS; safe re-run.
-- =============================================================================

CREATE TABLE IF NOT EXISTS sellers (
    id               BIGSERIAL   PRIMARY KEY,
    poster_waiter_id TEXT        NOT NULL UNIQUE,         -- Poster `user_id` (string)
    name             TEXT        NOT NULL,
    is_active        BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE sellers IS
  'Do''kon KPI (TZ §8) — one row per Poster waiter/cashier (a SELLER). '
  'Identity only; actual revenue is read live from Poster dash.getWaitersSales. '
  'Upserted lazily on GET /api/seller-kpi and by POST /api/seller-kpi/sync.';

COMMENT ON COLUMN sellers.poster_waiter_id IS
  'Poster `user_id` for this waiter (TEXT — Poster ids are strings). UNIQUE.';

CREATE TABLE IF NOT EXISTS seller_sales_plan (
    id          BIGSERIAL     PRIMARY KEY,
    seller_id   BIGINT        NOT NULL REFERENCES sellers(id),
    month       CHAR(7)       NOT NULL,                                       -- 'YYYY-MM'
    target_sum  NUMERIC(14,2) NOT NULL CHECK (target_sum >= 0),               -- so'm (UZS)
    created_by  BIGINT        REFERENCES users(id),
    created_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
    UNIQUE (seller_id, month)
);

-- The leaderboard / KPI GET filters by month across all visible sellers, so a
-- month index keeps that scan cheap once the table accumulates many months.
CREATE INDEX IF NOT EXISTS ix_seller_sales_plan_month
    ON seller_sales_plan (month);

COMMENT ON TABLE seller_sales_plan IS
  'Do''kon KPI (TZ §8) — monthly sales plan per SELLER. One row per '
  '(seller_id, month). Compared against actual revenue from Poster '
  'dash.getWaitersSales. Upserted by PUT /api/seller-kpi/plan (pm only).';

COMMENT ON COLUMN seller_sales_plan.month IS
  '''YYYY-MM'' calendar-month label the plan applies to.';

COMMENT ON COLUMN seller_sales_plan.target_sum IS
  'Monthly sales target for this seller in so''m (UZS). >= 0.';
