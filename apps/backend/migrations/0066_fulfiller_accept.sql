-- =============================================================================
-- 0066 — fulfiller ACCEPTANCE stamp (who accepted a request, and when).
-- =============================================================================
-- cross-department-flow-plan §3/§9/§10 — the Jira-style Kanban needs an explicit
-- "Tasdiqlandi" (accepted) signal that is INDEPENDENT of the technical status. A
-- request can be accepted by its fulfiller (central / producer / raw manager)
-- yet still SIT (e.g. a raw_warehouse target waiting for the manager's Poster
-- Поставка to land) — the status alone (CHECK_STORE_SUPPLIER) cannot tell the
-- board "the boss already said yes". These two columns record that first accept.
--
-- Columns (both NULL-safe — every EXISTING request keeps working unchanged; a
-- request that was accepted before this migration simply shows NULL, i.e. "no
-- recorded acceptance", which the Kanban treats as not-yet-accepted):
--   * fulfiller_accepted_at — WHEN the fulfilling отдел first accepted the
--                             request (acceptByCentral / acceptByFulfiller /
--                             acceptInternal, or implicitly via a partial
--                             fulfill). Set once — the FIRST accept wins; a later
--                             accept/re-accept never overwrites it.
--   * fulfiller_accepted_by — the user who performed that first accept. ON DELETE
--                             SET NULL: deleting the user never erases the fact
--                             that the request WAS accepted (mirrors the rest of
--                             this table's FK-to-users choices).
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS — purely additive, no data touched. NOTE:
-- this file (like every migration) MUST NOT open its own transaction — the runner
-- wraps each file in one BEGIN/COMMIT (see src/db/migrate.ts).
-- =============================================================================

ALTER TABLE replenishment_requests
  ADD COLUMN IF NOT EXISTS fulfiller_accepted_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS fulfiller_accepted_by BIGINT NULL
    REFERENCES users(id) ON DELETE SET NULL;

COMMENT ON COLUMN replenishment_requests.fulfiller_accepted_at IS
  'cross-dept-flow §3/§10 — when the fulfilling отдел FIRST accepted this request (first accept wins); NULL = not yet accepted.';
COMMENT ON COLUMN replenishment_requests.fulfiller_accepted_by IS
  'cross-dept-flow §3/§10 — the user who performed that first accept (ON DELETE SET NULL).';
