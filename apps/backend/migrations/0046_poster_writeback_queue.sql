-- 0046 — Poster write-back queue (best-effort outbox).
--
-- When a store receive is confirmed (POST /api/replenishment/:id/receive) the
-- received qty should be reflected back into Poster (supply / inventory) so the
-- POS stays in sync with the ERP ledger. The live `PosterClient` is read-only
-- today (POSTER_TOKEN is read-scope), so we record the WRITE INTENT here and
-- mark it `pending`. A future worker (or a manual replay) flushes the queue
-- once a write-capable Poster credential is configured.
--
-- Invariant: a Poster write failure must NEVER roll back the local receive —
-- the receive transaction commits first, the queue row is appended best-effort
-- afterwards (try/catch in the route). The queue is therefore an at-least-once
-- outbox, idempotency is enforced per (request_id, product_id) so a double-tap
-- receive cannot enqueue the same intent twice.

CREATE TABLE IF NOT EXISTS poster_writeback_queue (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id  BIGINT      NOT NULL REFERENCES replenishment_requests(id) ON DELETE CASCADE,
  product_id  BIGINT      NOT NULL REFERENCES products(id)               ON DELETE RESTRICT,
  location_id BIGINT      NOT NULL REFERENCES locations(id)              ON DELETE RESTRICT,
  qty         NUMERIC(14,4) NOT NULL CHECK (qty > 0),
  status      TEXT        NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'sent', 'failed')),
  last_error  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at     TIMESTAMPTZ
);

-- One enqueue per (request, product) — the receive flow is single-ship MVP, so
-- a second receive on the same request is a double-tap and must not duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS uq_poster_writeback_request_product
  ON poster_writeback_queue (request_id, product_id);

-- The flush worker scans pending rows; index keeps that scan cheap.
CREATE INDEX IF NOT EXISTS ix_poster_writeback_pending
  ON poster_writeback_queue (status)
  WHERE status = 'pending';
