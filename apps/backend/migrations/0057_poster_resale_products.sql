-- =============================================================================
-- 0057 — Poster resale (товары) products + menu-product -> ADIA product map.
-- =============================================================================
-- ROOT CAUSE (2026-06-08): the store sales dashboards (hourly "Sotuv soni/summasi
-- — bugun" + "Top 5 mahsulot") were EMPTY because the local `sales` table was
-- never populated. `ingestTransaction` resolves each Poster check line's
-- `product_id` (a `menu.getProducts` id, 293 of them) via
-- `products.poster_product_id` ONLY — but that column is filled with PREPACK
-- product ids (a disjoint Poster id-space). The 2026-06-08 owner rework also made
-- `syncMenuProducts` DROP the menu-product rows, so the very ids that arrive on
-- check lines had no resolvable product. Every sale line was silently skipped.
--
-- FIX — make EVERY sellable menu product resolve to an ADIA product:
--   1. The 100 menu products that name-match an existing prepack (semi/finished)
--      are mapped to that prepack via `poster_menu_product_map` (a MANY-to-one
--      table — two menu products, e.g. "БАУНТИ печенье"/"БАУНТИ пирожное", can
--      point at ONE prepack, which a single column could not express).
--   2. The remaining ~193 are pure resale goods (товары — Coca Cola, Pepsi,
--      Borjomi, candles…) that ADIA never produces or stocks. They become
--      `products(type='resale')` rows keyed by the menu product_id, so they show
--      up in sales analytics yet stay OUT of stock / recipe / production paths.
--
-- This migration only DEFINES the schema (enum value + map table). The mapping
-- ROWS and resale PRODUCT rows are created idempotently at runtime by
-- `syncMenuProducts` (seedSync.ts) — a NEW enum value cannot be USED in the same
-- transaction that ADDs it, so the seed (a separate tx) does the inserts.
-- =============================================================================

-- 1. New product type — a resale товар. Additive: every existing query that
--    filters on 'raw' / 'semi' / 'finished' is unaffected; resale rows simply
--    never appear in stock / recipe / production queries (товары are not made or
--    stocked by ADIA). IF NOT EXISTS makes the migration safely re-runnable.
ALTER TYPE product_type ADD VALUE IF NOT EXISTS 'resale';

-- 2. Menu-product -> ADIA product map. A Poster `menu.getProducts` product_id is
--    the key that arrives on every sale check line; it maps to exactly one ADIA
--    product, but ONE product may be the target of MANY menu ids (the БАУНТИ
--    case) — hence a dedicated table rather than a column on `products`.
--
--    poster_menu_product_id is the menu id-space (NOT products.poster_product_id,
--    which is the prepack id-space). product_id ON DELETE CASCADE so a dropped
--    product cleans its aliases.
CREATE TABLE IF NOT EXISTS poster_menu_product_map (
    poster_menu_product_id  BIGINT PRIMARY KEY,
    product_id              BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE poster_menu_product_map IS
    'Poster menu.getProducts product_id -> ADIA products.id. Resolves sale check lines (dash.getTransaction product_id) to an ADIA product. Many menu ids may map to one product.';

CREATE INDEX IF NOT EXISTS ix_poster_menu_product_map_product
    ON poster_menu_product_map(product_id);
