-- =============================================================================
-- 0054 — Poster workshop (Цех) link.
-- =============================================================================
-- ADIA models a production workshop (Poster "Цех приготовления") as a
-- `locations(type='production')` row. This migration adds the natural-key link
-- to Poster and the per-product "which sex produces this" link:
--
--   locations.poster_workshop_id   — the Poster `workshop_id` this production
--                                     location maps to (UNIQUE, NULL for
--                                     non-workshop / manually-created locations).
--   products.workshop_location_id  — which production location (sex) makes this
--                                     product. Resolved during seed enrichment
--                                     from the matched dish's Poster workshop_id.
--
-- The `location_type` enum already has 'production' (0001_init.sql) — no enum
-- change is needed.
--
-- IDEMPOTENT: ADD COLUMN / CREATE ... IF NOT EXISTS; safe to re-run.
-- =============================================================================

ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS poster_workshop_id INTEGER NULL;

-- One ADIA production location per Poster workshop. Partial UNIQUE so the many
-- rows with NULL poster_workshop_id (stores, warehouses, sex_storages,
-- manually-created depts) do not collide.
CREATE UNIQUE INDEX IF NOT EXISTS uq_locations_poster_workshop
  ON locations (poster_workshop_id)
  WHERE poster_workshop_id IS NOT NULL;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS workshop_location_id BIGINT NULL
    REFERENCES locations (id);

CREATE INDEX IF NOT EXISTS ix_products_workshop_location
  ON products (workshop_location_id);

COMMENT ON COLUMN locations.poster_workshop_id IS
  'Poster workshop_id (Цех) this production location maps to. UNIQUE; NULL for non-workshop locations.';
COMMENT ON COLUMN products.workshop_location_id IS
  'Which production location (sex) makes this product. Set by seed enrichment from the matched dish workshop.';
