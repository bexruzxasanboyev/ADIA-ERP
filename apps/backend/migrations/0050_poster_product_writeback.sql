-- =============================================================================
-- 0050 — Poster PRODUCT-MASTER write-back (best-effort outbox).
-- =============================================================================
-- Owner requirement (2026-06-06): the boss edits a product's unit of measure
-- (kg / l / pcs) in the ERP. The change must land in the ERP DB immediately AND
-- be pushed back to Poster so the POS product master stays in sync.
--
-- The live `PosterClient` / POSTER_TOKEN is READ-ONLY today, so we cannot call
-- Poster's `menu.updateProduct` now. We record the WRITE INTENT here with
-- status='pending'; a future worker (or manual replay) flushes it once a
-- write-capable Poster credential is configured. This mirrors 0046
-- (poster_writeback_queue) but for a PRODUCT-MASTER change rather than a
-- replenishment receive — 0046 is hard-wired to `request_id NOT NULL`, which
-- does not fit a product-field edit, hence this separate lightweight outbox.
--
-- Invariant: a Poster write failure must NEVER break or roll back the local
-- product update. The route updates the ERP + audit in one transaction, then
-- best-effort enqueues here afterwards (try/catch). The queue is therefore an
-- at-least-once outbox; a worker is responsible for de-duping / collapsing
-- repeated edits to the same product field when it flushes.
--
-- IDEMPOTENT + non-destructive: CREATE TABLE / INDEX IF NOT EXISTS.
-- =============================================================================

CREATE TABLE IF NOT EXISTS poster_product_writeback (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id        BIGINT      NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  -- Snapshot of the Poster product id at enqueue time (nullable: a manually
  -- created ERP product may have no Poster mapping — in that case we DON'T
  -- enqueue at all, but the column stays nullable for safety / future fields).
  poster_product_id BIGINT,
  -- Which product-master field changed. 'unit' today; kept generic so a future
  -- name/sku/category write-back can reuse this same outbox.
  field             TEXT        NOT NULL,
  old_value         TEXT,
  new_value         TEXT,
  status            TEXT        NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'sent', 'failed')),
  last_error        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at           TIMESTAMPTZ
);

-- The flush worker scans pending rows; partial index keeps that scan cheap.
CREATE INDEX IF NOT EXISTS ix_poster_product_writeback_pending
  ON poster_product_writeback (status)
  WHERE status = 'pending';
