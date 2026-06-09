-- =============================================================================
-- 0065 — replenishment request TREE (parent/root/depth/origin) + waiters.
-- =============================================================================
-- cross-department-flow-plan §8 — the recursive request tree. Until now a
-- dialog/resolver-emitted sub-request was an ORPHAN: `replenishment_requests`
-- had no parent link, so the Kanban could not render the root→children tree and
-- the engine (F-D) could not auto-advance a waiting root once its child closed.
-- `production_orders` already carries `parent_production_order_id` + `stage_role`
-- (0030, ONE level); this migration brings the SAME idea to requests, at
-- arbitrary depth (cap 12 — the BOM recursion cap, ADR/bom.ts MAX_RECIPE_DEPTH).
--
-- Columns (all NULL-safe / defaulted — every EXISTING open request keeps working
-- unchanged: parent/root NULL, depth 0, origin 'manual'):
--   * parent_request_id — the IMMEDIATE parent request this one was spawned for
--                         (e.g. a Tort root → a cream sub-request to Qaymoq).
--                         ON DELETE SET NULL: deleting a parent never cascades
--                         away the child's history (mirrors 0030's choice).
--   * root_request_id   — the TOP of the tree (self for a root; derived from the
--                         parent's root by the service layer). Lets the engine
--                         find "which root is waiting on this child" in one hop.
--   * depth             — distance from the root (0 = root). Capped at 12 by a
--                         CHECK + the createRequest application guard.
--   * origin            — HOW the request was born (scan|manual|voice|dialog|
--                         shortfall|buffer). Drives the Kanban "recommendation
--                         card vs real request" framing and analytics. The
--                         default 'manual' is the conservative legacy value.
--
-- `request_waiters` (§8, invariant-2 coexistence): invariant 2 forbids a SECOND
-- open request for the same (product, producer-target). So when two different
-- roots both need the same semi from the same producer, the second root does
-- NOT open a duplicate — it ATTACHES itself to the existing open child as a
-- "waiter". A child closing then fans out to EVERY waiter root (F-D), not just
-- the single parent on `parent_request_id`. PK (child, waiter) is idempotent;
-- a row may not wait on itself.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS; the two CHECK constraints are guarded by
-- a catalog lookup on conname (re-add only when absent, mirroring 0030's
-- drop-if-exists/re-add but without churning an existing constraint); partial
-- indexes + the table are IF NOT EXISTS. No data deleted — purely additive.
-- NOTE: this file (like every migration) MUST NOT open its own transaction — the
-- runner wraps each file in one BEGIN/COMMIT (see src/db/migrate.ts).
-- =============================================================================

ALTER TABLE replenishment_requests
  ADD COLUMN IF NOT EXISTS parent_request_id BIGINT NULL
    REFERENCES replenishment_requests(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS root_request_id   BIGINT NULL
    REFERENCES replenishment_requests(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS depth             SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS origin            VARCHAR(16) NOT NULL DEFAULT 'manual';

-- depth bounds (0..12) — guarded so a re-run never duplicates the constraint.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_replenishment_depth'
  ) THEN
    ALTER TABLE replenishment_requests
      ADD CONSTRAINT chk_replenishment_depth
      CHECK (depth >= 0 AND depth <= 12);
  END IF;
END$$;

-- origin domain — mirrors the RequestOrigin TS union (replenishment.ts).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_replenishment_origin'
  ) THEN
    ALTER TABLE replenishment_requests
      ADD CONSTRAINT chk_replenishment_origin
      CHECK (origin IN ('scan', 'manual', 'voice', 'dialog', 'shortfall', 'buffer'));
  END IF;
END$$;

COMMENT ON COLUMN replenishment_requests.parent_request_id IS
  'cross-dept-flow §8 — the immediate parent request this sub-request was raised for (NULL = root).';
COMMENT ON COLUMN replenishment_requests.root_request_id IS
  'cross-dept-flow §8 — the top of the request tree (NULL/self for a root); set from the parent''s root.';
COMMENT ON COLUMN replenishment_requests.depth IS
  'cross-dept-flow §8 — distance from the root (0 = root); capped at 12 (BOM recursion cap).';
COMMENT ON COLUMN replenishment_requests.origin IS
  'cross-dept-flow §8 — how the request was born: scan | manual | voice | dialog | shortfall | buffer.';

-- Tree-walk indexes — only the (few) linked rows are indexed (partial), so the
-- index stays tiny while the engine''s "children of X" / "tree rooted at R"
-- lookups (F-D) stay index-backed.
CREATE INDEX IF NOT EXISTS ix_replenishment_parent
  ON replenishment_requests(parent_request_id)
  WHERE parent_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_replenishment_root
  ON replenishment_requests(root_request_id)
  WHERE root_request_id IS NOT NULL;

-- §8 — invariant-2 coexistence: many waiting roots ↔ one shared open child.
CREATE TABLE IF NOT EXISTS request_waiters (
  child_request_id  BIGINT NOT NULL REFERENCES replenishment_requests(id) ON DELETE CASCADE,
  waiter_request_id BIGINT NOT NULL REFERENCES replenishment_requests(id) ON DELETE CASCADE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (child_request_id, waiter_request_id),
  CHECK (child_request_id <> waiter_request_id)
);

COMMENT ON TABLE request_waiters IS
  'cross-dept-flow §8 — roots WAITING on a shared open child request (invariant-2 '
  'coexistence). A child closing fans out to every waiter root, not just its parent.';

-- The fan-out (F-D) walks waiters BY child; the reverse (which children is this
-- root waiting on) is the PK''s leading column already.
CREATE INDEX IF NOT EXISTS ix_request_waiters_waiter
  ON request_waiters(waiter_request_id);
