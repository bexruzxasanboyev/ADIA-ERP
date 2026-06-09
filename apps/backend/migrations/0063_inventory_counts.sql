-- =============================================================================
-- 0063 — Inventarizatsiya konverteri + kun-oxiri inventarizatsiya (TZ Module 11).
-- =============================================================================
-- GROUNDED MODEL (data investigation 2026-06-09): cakes are sold BY WEIGHT
-- (КГ), NOT as separate piece / whole SKUs. Every finished product is
-- `unit='kg'` and a sale is a decimal-kg qty. So a "whole" (butun) cake is
-- defined by its WEIGHT, and a "piece" (bo'lak) is a weight FRACTION of the
-- whole. The whole↔piece converter needs TWO per-product coefficients:
--
--   weight_per_whole — kg of ONE complete whole cake (e.g. Napoleon = 1.0 kg).
--   pieces_per_whole — how many slices a whole is cut into (e.g. 8).
--
-- Both NULL  = the product is NOT whole-and-sliced (sold loose by weight only);
--              the end-of-day converter SKIPS it. Either may be set/cleared
--              independently via PATCH /api/products/:id/whole-piece.
--
-- This is NOT `recipe_yield` (migration 0041): that is a COST/BOM concept (how
-- many finished units one recipe batch makes, used to divide per-unit material
-- cost). These are an INVENTORY-COUNTING concept (how an operator tallies
-- physical stock on the shelf). Deliberately separate columns.
--
-- `inventory_counts` is the kun-oxiri (end-of-day) physical count ledger: one
-- row per (location, product, count_date). The count is converted back to kg
-- (`counted_qty`), compared to the live system qty, and when they differ an
-- ATOMIC 'adjust' stock_movement (link: `adjustment_movement_id`) brings stock
-- to the counted figure (invariant 1 & 3 — atomic, never negative). A re-count
-- on the same day UPSERTs the row (ON CONFLICT) and re-baselines against the
-- now-current system qty, so it never double-adjusts.
--
-- Additive, non-destructive, idempotent: ADD COLUMN / CREATE TABLE IF NOT
-- EXISTS, safe to re-run.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Per-product whole↔piece coefficients (both NULL = not whole-and-sliced).
-- -----------------------------------------------------------------------------
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS weight_per_whole NUMERIC(14,4)
    CHECK (weight_per_whole IS NULL OR weight_per_whole > 0),
  ADD COLUMN IF NOT EXISTS pieces_per_whole NUMERIC(14,2)
    CHECK (pieces_per_whole IS NULL OR pieces_per_whole > 0);

COMMENT ON COLUMN products.weight_per_whole IS
  'TZ-11 — kg of ONE complete whole cake (butun). NULL = not whole-and-sliced. '
  'Inventory whole↔piece converter only; distinct from recipe_yield (cost/BOM).';
COMMENT ON COLUMN products.pieces_per_whole IS
  'TZ-11 — how many slices (bo''lak) one whole is cut into. NULL = not '
  'whole-and-sliced. Inventory converter only; distinct from recipe_yield.';

-- -----------------------------------------------------------------------------
-- 2. End-of-day physical count ledger.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventory_counts (
    id                     BIGSERIAL     PRIMARY KEY,
    location_id            BIGINT        NOT NULL REFERENCES locations(id),
    product_id             BIGINT        NOT NULL REFERENCES products(id),
    count_date             DATE          NOT NULL,
    -- The live system qty (kg) read at count time — the "before" baseline.
    system_qty             NUMERIC(14,4) NOT NULL,
    -- What the operator physically counted, in whole + slices + sub-slice kg.
    counted_whole          NUMERIC(14,2) NOT NULL,
    counted_pieces         NUMERIC(14,2) NOT NULL,
    counted_remnant_kg     NUMERIC(14,4) NOT NULL DEFAULT 0,
    -- The counted tally converted back to kg (wholePiecesToKg) — the new truth.
    counted_qty            NUMERIC(14,4) NOT NULL,
    -- counted_qty − system_qty. Positive = found more; negative = found less.
    diff_qty               NUMERIC(14,4) NOT NULL,
    -- The 'adjust' movement that reconciled stock to counted_qty (NULL when
    -- diff was zero — nothing to adjust).
    adjustment_movement_id BIGINT        REFERENCES stock_movements(id),
    created_by             BIGINT        REFERENCES users(id),
    created_at             TIMESTAMPTZ   NOT NULL DEFAULT now(),
    -- One count per (location, product, day) — a re-count UPSERTs this row.
    UNIQUE (location_id, product_id, count_date)
);

-- History reads are "newest first for a location, optionally a date window".
CREATE INDEX IF NOT EXISTS ix_inventory_counts_loc_date
    ON inventory_counts (location_id, count_date DESC);
CREATE INDEX IF NOT EXISTS ix_inventory_counts_product
    ON inventory_counts (product_id);

COMMENT ON TABLE inventory_counts IS
  'TZ-11 — kun-oxiri (end-of-day) physical inventory count ledger. One row per '
  '(location, product, count_date); a same-day re-count UPSERTs. When '
  'counted_qty <> system_qty an atomic adjust stock_movement '
  '(adjustment_movement_id) reconciles stock to counted_qty.';
