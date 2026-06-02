-- =============================================================================
-- 0039 — products.cost_per_unit (Себестоимость / recipe-line + total cost).
-- =============================================================================
-- Owner decision (2026-05-30): the recipe modal must show COST per line and a
-- product total, displayed nested like Poster. To compute that we need a unit
-- cost for every RAW ingredient; prepack/finished costs are derived bottom-up
-- from the recipe tree (qty_per_unit × component unit cost), so they are NOT
-- stored — only the raw leaf cost is persisted.
--
-- WHY A COLUMN, NOT A SEPARATE `ingredient_costs` TABLE:
--   * cost_per_unit is a single current-value scalar attribute of a product
--     (1:1), not an event series — Poster only exposes the CURRENT self-price
--     (`structure_selfprice`), never a dated cost history;
--   * the recipe read joins products anyway (name/type/unit), so the cost is a
--     free extra column on that row — a side table would add a needless join;
--   * keeps the model symmetric with `products.unit` / `category_id`.
--
-- UNIT: so'm per `products.unit` (kg / l / pcs). Poster's `structure_selfprice`
-- arrives in TIYIN for the line's brutto quantity; the sync converts it to a
-- per-unit so'm value (selfprice ÷ brutto-in-unit ÷ 100) — consistent with the
-- rest of the system (see integrations/poster/posterMoney.ts, tiyinToSom).
--
-- NULLABLE: a raw ingredient that never appears in any prepack BOM has no
-- self-price source, so its cost stays NULL (the recipe read surfaces a NULL
-- line_cost rather than a fake 0).
--
-- IDEMPOTENT + non-destructive: ADD COLUMN IF NOT EXISTS, no data rewritten.
-- =============================================================================

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS cost_per_unit NUMERIC(14,4)
    CHECK (cost_per_unit IS NULL OR cost_per_unit >= 0);

COMMENT ON COLUMN products.cost_per_unit IS
  'Себестоимость — current unit cost in so''m per products.unit. For RAW '
  'ingredients it is synced from Poster prepack line structure_selfprice '
  '(tiyin ÷ brutto-in-unit ÷ 100). NULL when no source. Prepack/finished cost '
  'is computed bottom-up from the recipe tree, not stored here.';
