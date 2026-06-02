-- =============================================================================
-- 0040 — recipes.brutto / recipes.netto (Poster-style Brutto/Netto columns).
-- =============================================================================
-- Owner decision (2026-05-30): the recipe modal must show Poster's Brutto and
-- Netto figures per BOM line — exactly as Poster displays a prepack's
-- composition (structure_brutto / structure_netto). `qty_per_unit` is the
-- DERIVED per-output-unit quantity used for cost + production maths; brutto and
-- netto are the RAW per-batch composition figures carried for display only.
--
-- UNIT: both are stored in the line's `structure_unit` (Poster gives grams /
-- millilitres / pieces). They are NOT normalised — they mirror what Poster
-- shows on the prepack card so the modal reproduces Poster 1:1.
--
-- NULLABLE: a manually-entered recipe line (PUT /api/products/:id/recipe) has
-- no Poster brutto/netto source, so both stay NULL there. The recipe read
-- surfaces NULL (the modal then shows only qty_per_unit for that line).
--
-- IDEMPOTENT + non-destructive: ADD COLUMN IF NOT EXISTS, no data rewritten.
-- =============================================================================

ALTER TABLE recipes
  ADD COLUMN IF NOT EXISTS brutto NUMERIC(14,4)
    CHECK (brutto IS NULL OR brutto >= 0),
  ADD COLUMN IF NOT EXISTS netto NUMERIC(14,4)
    CHECK (netto IS NULL OR netto >= 0);

COMMENT ON COLUMN recipes.brutto IS
  'Poster structure_brutto for this BOM line, in the line''s structure_unit '
  '(grams / ml / pcs) — carried for Poster-style display. NULL for '
  'manually-entered lines. qty_per_unit is the derived per-output-unit qty.';

COMMENT ON COLUMN recipes.netto IS
  'Poster structure_netto for this BOM line, in the line''s structure_unit. '
  'NULL for manually-entered lines.';
