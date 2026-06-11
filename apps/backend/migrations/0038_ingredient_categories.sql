-- =============================================================================
-- 0038 — Poster INGREDIENT categories (menu.getCategoriesIngredients)
-- =============================================================================
-- Investigation (2026-05-30, live `adia` account) found that Poster groups RAW
-- ingredients into their OWN category namespace:
--   * `menu.getIngredients` rows each carry an integer `category_id`
--     (e.g. 1=Молочные продукты, 4=Картонные упаковки, 15=Тесто). 345/375
--     raw ingredients carry one.
--   * `menu.getCategoriesIngredients` is the lookup: 14 rows of {category_id, name}.
-- This is a DIFFERENT namespace from `menu.getCategories` (finished-goods, 0037):
-- both expose `category_id` and the integer ids COLLIDE (id=4 means "Овощи" in
-- the menu namespace but "Картонные упаковки" in the ingredient namespace). So
-- we cannot reuse the bare `poster_category_id` unique key — we add a `kind`
-- discriminator and re-key uniqueness on (kind, poster_category_id).
--
-- Semi-finished (prepacks, `menu.getPrepacks`) carry NO category in Poster, so
-- they keep `category_id = NULL` — there is no source to sync for them.
--
-- DESIGN:
--   * Add `categories.kind` ('menu' | 'ingredient'). Existing rows (all from
--     menu.getCategories) backfill to 'menu'.
--   * Replace the old single-column UNIQUE(poster_category_id) with a composite
--     UNIQUE(kind, poster_category_id) so the two namespaces coexist.
--   * `products.category_id` stays the single FK; a raw product points at an
--     'ingredient'-kind row, a finished product at a 'menu'-kind row.
--
-- IDEMPOTENT: guarded with IF (NOT) EXISTS / catalog checks.
-- =============================================================================

ALTER TABLE categories
    ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'menu'
        CHECK (kind IN ('menu', 'ingredient'));
COMMENT ON COLUMN categories.kind IS
    'Which Poster namespace this category came from: ''menu'' (menu.getCategories, '
    'finished goods) or ''ingredient'' (menu.getCategoriesIngredients, raw materials). '
    'poster_category_id is unique only WITHIN a kind — the two namespaces collide numerically.';

-- Swap the unique key: drop the legacy single-column one (named by 0037), add
-- the composite. Guarded so a re-run is a no-op.
ALTER TABLE categories DROP CONSTRAINT IF EXISTS categories_poster_category_id_key;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uq_categories_kind_poster_id'
    ) THEN
        ALTER TABLE categories
            ADD CONSTRAINT uq_categories_kind_poster_id UNIQUE (kind, poster_category_id);
    END IF;
END$$;
