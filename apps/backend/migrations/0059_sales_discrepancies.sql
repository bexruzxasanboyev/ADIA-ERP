-- =============================================================================
-- 0059 — Sales discrepancy log (TZ Module 9 — "Kassa tafovuti / fors-major").
-- =============================================================================
-- Detection of the two fors-major anomalies already exists and stays unchanged:
--   * "noto'g'ri urilgan chek" (wrong-keyed / over-sale) — a Poster sale check
--     rang up MORE units than ADIA had on hand. Detected in
--     integrations/poster/salesSync.ts; one row per (transaction, product).
--   * negative Poster leftover (manfiy qoldiq) — storage.getStorageLeftovers
--     returned a negative qty for a (location, product). Detected in
--     integrations/poster/stockSync.ts; one row per (location, product) per day.
--
-- Until now each anomaly was ONLY surfaced as a consolidated Telegram digest
-- (and clamped in `stock`). This table PERSISTS each detected anomaly so the
-- app can render an in-app, queryable discrepancy log + report (GET/PATCH
-- /api/discrepancies). The Telegram digests and the detection thresholds are
-- NOT changed by this migration — this is purely an additive audit/log surface.
--
-- Lifecycle: a row is born `open`; a manager/PM moves it to `acknowledged`
-- (seen) and finally `resolved` (reconciled) via PATCH, which stamps
-- resolved_by/resolved_at and writes an audit_log row.
--
-- DEDUPE (idempotency): `dedupe_key` is UNIQUE so re-running a sync never
-- double-logs the same fact.
--   * wrong_keyed   — `wrong_keyed:<transaction_id>:<product_id>`   (a check
--                      line is a one-time fact → ON CONFLICT DO NOTHING).
--   * negative_stock — `negative_stock:<location_id>:<product_id>:<YYYY-MM-DD>`
--                      (a daily anomaly → ON CONFLICT keep the WORST shortfall,
--                      refresh detected_at; never touch status/note/resolved_*).
--
-- IDEMPOTENT: CREATE TABLE / INDEX IF NOT EXISTS; safe to re-run.
-- =============================================================================

CREATE TABLE IF NOT EXISTS sales_discrepancies (
    id                    BIGSERIAL    PRIMARY KEY,
    kind                  TEXT         NOT NULL
        CHECK (kind IN ('wrong_keyed', 'negative_stock')),
    location_id           BIGINT       NOT NULL REFERENCES locations(id),
    product_id            BIGINT       NOT NULL REFERENCES products(id),
    -- The Poster check id for a wrong_keyed row; NULL for negative_stock.
    poster_transaction_id TEXT         NULL,
    -- wrong_keyed: how many the POS sold vs how many ADIA had on hand.
    -- negative_stock: had_qty/sold_qty stay NULL (only shortfall is meaningful).
    sold_qty              NUMERIC(14,3) NULL,
    had_qty               NUMERIC(14,3) NULL,
    -- The over-sold (or negative) magnitude. Always non-negative.
    shortfall             NUMERIC(14,3) NOT NULL DEFAULT 0
        CHECK (shortfall >= 0),
    status                TEXT         NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'acknowledged', 'resolved')),
    note                  TEXT         NULL,
    resolved_by           BIGINT       NULL REFERENCES users(id),
    resolved_at           TIMESTAMPTZ  NULL,
    detected_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
    created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
    -- One row per logical fact (see DEDUPE note above).
    dedupe_key            TEXT         NOT NULL UNIQUE
);

COMMENT ON TABLE sales_discrepancies IS
    'TZ M9 — persisted kassa/fors-major anomalies (wrong-keyed sales + negative '
    'Poster leftovers). Detection lives in the Poster syncs; this is the log.';
COMMENT ON COLUMN sales_discrepancies.dedupe_key IS
    'wrong_keyed:<tx>:<product> (DO NOTHING) | negative_stock:<loc>:<product>:<YYYY-MM-DD> (keep worst shortfall).';

-- The discrepancy-log list query filters by location + orders by recency.
CREATE INDEX IF NOT EXISTS ix_sales_discrepancies_location_detected
    ON sales_discrepancies (location_id, detected_at DESC);
-- The summary card filters by status …
CREATE INDEX IF NOT EXISTS ix_sales_discrepancies_status
    ON sales_discrepancies (status);
-- … and the kind tabs filter by kind.
CREATE INDEX IF NOT EXISTS ix_sales_discrepancies_kind
    ON sales_discrepancies (kind);
