-- =============================================================================
-- 0053 — products.image_url (Poster тех.карта photo).
-- =============================================================================
-- A finished/semi product can carry a menu photo, sourced from the matching
-- Poster тех.карта (dish) `photo` / `photo_origin` field. This is a display-only
-- URL (relative to the Poster CDN host); the seed enrichment fills it by
-- name-matching a prepack to a dish (see seedSync.syncDishEnrichment).
--
--   image_url — Poster CDN-relative photo path, or NULL when no dish matched.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS; safe to re-run.
-- =============================================================================

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS image_url TEXT NULL;

COMMENT ON COLUMN products.image_url IS
  'Poster тех.карта photo URL (CDN-relative). Set by seed enrichment by name-match; NULL when no dish matched.';
