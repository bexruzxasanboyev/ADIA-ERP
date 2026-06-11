-- =============================================================================
-- 0037 — Real Poster product categories (menu.getCategories)
-- =============================================================================
-- The owner wants products grouped by their REAL Poster category
-- ("Пирожные" / Perojniy, "Торты" / Tort, "Кейтеринг", "Холодные напитки", …).
-- Poster exposes these via `menu.getCategories`, and every `menu.getProducts`
-- row carries `menu_category_id`. Our sync previously DROPPED that field — this
-- migration adds the lookup table + the foreign key so the seed sync can land
-- the real category on each product.
--
-- This is DISTINCT from the EPIC 1.3 heuristic `category` string (a name-based
-- guess derived at read time in `lib/productCategory`). That stays as-is; this
-- column is the authoritative source-of-truth class straight from Poster.
--
-- DESIGN:
--   * `categories` is a normalised lookup keyed by `poster_category_id`
--     (INTEGER UNIQUE NOT NULL — the natural key from Poster). `name` is the
--     Poster `category_name`. Idempotent re-sync UPDATEs by `poster_category_id`.
--   * `products.category_id` is a NULLABLE FK -> categories(id). NULL means the
--     product had no `menu_category_id` in Poster (e.g. a pure raw ingredient,
--     a prepack, or a menu item with no category assigned).
--   * ON DELETE SET NULL — we never DELETE category rows (Poster is the single
--     read-only source) but the safe behaviour keeps products intact if one is.
--
-- IDEMPOTENT:
--   * `CREATE TABLE IF NOT EXISTS` + `ADD COLUMN IF NOT EXISTS` let the
--     migration run twice without error.
-- =============================================================================

CREATE TABLE IF NOT EXISTS categories (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- Natural key from Poster `menu.getCategories` (category_id).
    poster_category_id INTEGER     NOT NULL UNIQUE,
    name               TEXT        NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE categories IS
    'Real Poster product categories (menu.getCategories). Authoritative source-'
    'of-truth class for each product, distinct from the heuristic lib/productCategory string.';
COMMENT ON COLUMN categories.poster_category_id IS
    'Poster category_id — natural key; the join target for products.menu_category_id.';

ALTER TABLE products
    ADD COLUMN IF NOT EXISTS category_id BIGINT NULL REFERENCES categories(id) ON DELETE SET NULL;
COMMENT ON COLUMN products.category_id IS
    'FK -> categories(id). The real Poster category for this product. NULL when '
    'Poster had no menu_category_id (raw ingredients, prepacks, uncategorised menu items).';

CREATE INDEX IF NOT EXISTS ix_products_category ON products(category_id);
