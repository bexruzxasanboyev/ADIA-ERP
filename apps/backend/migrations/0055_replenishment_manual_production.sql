-- =============================================================================
-- 0055 — Manual central -> production replenishment flow (store requests).
-- =============================================================================
-- Owner-approved 2026-06-08: when a STORE raises a replenishment request bound
-- for the central warehouse and the central is SHORT, the central warehouse
-- manager must explicitly route it to production (a manual
-- "Ishlab chiqarishga yuborish" action), and after production lands the goods
-- at central the request must STOP and WAIT for an explicit
-- "Qabul qildim" (receive) + "Do'konga yuborish" (forward) — it must NOT
-- auto-ship to the store.
--
-- This migration adds the two markers the engine + the UI need:
--
--   route_to_production_manual   — TRUE once the manager explicitly sent the
--                                  request to production via POST
--                                  /:id/to-production. The DONE_TO_WAREHOUSE
--                                  gate refuses to auto-ship such a request:
--                                  the manager must receive + forward it by
--                                  hand. Default FALSE keeps every existing
--                                  request (and the direct-ship / internal
--                                  auto-replenishment paths) unchanged.
--   received_from_production_at  — set by POST /:id/receive-from-production
--                                  (the manual "Qabul qildim" at central). It
--                                  is the gate the final forward
--                                  (ship-to-store) checks: a manual production
--                                  request may only ship AFTER it was received.
--                                  NULL = not yet received.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS; safe to re-run. Purely additive — no
-- data deleted, no enum change (the existing replenishment_status states are
-- reused: PRODUCING / DONE_TO_WAREHOUSE / SHIP_TO_REQUESTER / CLOSED).
-- =============================================================================

ALTER TABLE replenishment_requests
  ADD COLUMN IF NOT EXISTS route_to_production_manual  BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS received_from_production_at  TIMESTAMPTZ NULL;

COMMENT ON COLUMN replenishment_requests.route_to_production_manual IS
  '0055 — TRUE once a store request was explicitly routed to production by the '
  'central warehouse manager (POST /:id/to-production). Such a request STOPS at '
  'DONE_TO_WAREHOUSE and never auto-ships; it requires a manual receive + forward.';
COMMENT ON COLUMN replenishment_requests.received_from_production_at IS
  '0055 — when the central warehouse manager confirmed receipt of the produced '
  'goods (POST /:id/receive-from-production). Gate for the final forward to the '
  'store. NULL = not yet received.';
