-- =============================================================================
-- 0052 — Replenishment batch grouping.
-- =============================================================================
-- A store confirms a basket of below-min products at once. Each product is
-- still its own `replenishment_request` (invariant 2 — one open request per
-- (product, location) — is unchanged), but the lines created in a single
-- /batch call now share a `batch_id` so the central warehouse can accept or
-- reject the whole basket as ONE grouped order.
--
--   batch_id  — the shared group id for every line created in one /batch call.
--               NULL for legacy / individually-created requests.
--
-- A dedicated sequence allocates batch ids (cleanest: one nextval per /batch
-- call, set on every row in that call). The id space is independent of the
-- replenishment_requests PK.
--
-- IDEMPOTENT: ADD COLUMN / CREATE ... IF NOT EXISTS; safe to re-run.
-- =============================================================================

CREATE SEQUENCE IF NOT EXISTS replenishment_batch_seq;

ALTER TABLE replenishment_requests
  ADD COLUMN IF NOT EXISTS batch_id BIGINT NULL;

CREATE INDEX IF NOT EXISTS idx_replenishment_batch_id
  ON replenishment_requests (batch_id);
