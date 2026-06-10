-- =============================================================================
-- 0067 — Poster menu `weight_flag` on the sales-resolution map.
-- =============================================================================
-- ROOT-CAUSE FIX (2026-06-10, weighted-sales 1000x bug): for menu products with
-- `weight_flag=1` ("КГ" / weighted items) Poster reports the transaction line
-- `num` in GRAMS — verified live against `adia`:
--   * dash.getTransaction 794490 line: num="3,000.0000000", payed_sum=34_500_000
--     tiyin (345_000 so'm) for ПЕЛЬМЕНИ (menu 358, weight_flag="1", unit kg)
--     => 3_000 g = 3 kg @ 115_000 so'm/kg;
--   * menu.getProducts: all 293 rows carry weight_flag ("0"/"1"; 64 weighted).
-- The old sync stored those grams directly into `sales.qty`, so qty was 1000x
-- too big and the derived per-unit price 1000x too small (per-GRAM). To convert
-- grams -> kg at ingest time the sync must know which menu ids are weighted;
-- this column persists that flag on the menu-id -> product resolution map
-- (refreshed by every `syncMenuProducts` run).
--
-- DEFAULT FALSE: an unmapped / not-yet-resynced menu id behaves exactly like
-- before (no conversion). IDEMPOTENT: ADD COLUMN IF NOT EXISTS — purely
-- additive, no data touched. NOTE: this file (like every migration) MUST NOT
-- open its own transaction — the runner wraps each file in one BEGIN/COMMIT
-- (see src/db/migrate.ts).
-- =============================================================================

ALTER TABLE poster_menu_product_map
  ADD COLUMN IF NOT EXISTS weight_flag BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN poster_menu_product_map.weight_flag IS
  'Poster menu.getProducts weight_flag — TRUE = weighted ("КГ") item whose transaction-line num is reported in GRAMS (sales sync divides by 1000 to store kg).';
