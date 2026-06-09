-- =============================================================================
-- 0058 — Poster write-back DIRECTION (two opposite writes per request).
-- =============================================================================
-- Owner-approved 2026-06-08: the owner now authorizes Poster WRITES (supersedes
-- the old read-only decision). A single replenishment request can produce TWO
-- opposite Poster storage writes:
--
--   store_in    — the EXISTING store-receive write-back (0046): when a store
--                 confirms a physical receive, the GOOD qty is reflected back
--                 into the STORE's Poster storage.
--   central_out — NEW: when the store ACCEPTS a shipment that left the central
--                 warehouse, the CENTRAL's Poster storage is decremented (the
--                 goods physically left central). The central is the Poster
--                 singleton `poster_storage_id = 8` (Склад Центральный).
--
-- The 0046 unique index was (request_id, product_id) — that would make the two
-- opposite writes for one (request, product) collide. We widen the idempotency
-- key to (request_id, product_id, direction) so both coexist; each direction is
-- still enqueued at-most-once (a double-tap accept cannot double-decrement).
--
-- SAFETY: every LIVE Poster write is additionally gated at the application layer
-- behind the env flag POSTER_WRITE_ENABLED (default false -> DRY-RUN: log the
-- intended call + payload, do NOT call live Poster). This migration only widens
-- the outbox key; it never calls Poster.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS + index swap guarded by IF (NOT) EXISTS;
-- safe to re-run. Purely additive — no data deleted. Existing rows default to
-- 'store_in' (the only kind that existed before this migration).
-- =============================================================================

ALTER TABLE poster_writeback_queue
  ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'store_in';

ALTER TABLE poster_writeback_queue
  DROP CONSTRAINT IF EXISTS chk_poster_writeback_direction;
ALTER TABLE poster_writeback_queue
  ADD CONSTRAINT chk_poster_writeback_direction
  CHECK (direction IN ('store_in', 'central_out'));

-- Swap the (request_id, product_id) unique index for one that also keys on
-- direction, so the two opposite write-backs for one request can coexist while
-- each direction stays at-most-once.
DROP INDEX IF EXISTS uq_poster_writeback_request_product;
CREATE UNIQUE INDEX IF NOT EXISTS uq_poster_writeback_request_product_dir
  ON poster_writeback_queue (request_id, product_id, direction);

COMMENT ON COLUMN poster_writeback_queue.direction IS
  '0058 — store_in (store-receive credit, 0046) | central_out (central decrement '
  'on store-accept). Part of the idempotency key so both opposite writes for one '
  'request coexist.';
