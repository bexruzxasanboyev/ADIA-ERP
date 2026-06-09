-- =============================================================================
-- 0062 — cash_shift_reconciliation (TZ Module 15 "Kassir boti" — solishtiruv).
-- =============================================================================
-- The kassir bot already turns a cashier's end-of-day text ("rasxod 5 000 000,
-- qoldim 3 000 000, kartadan 2 000 000") into a `cash_shift` money nakladnoy
-- (services/cashShiftSubmission.ts). What was MISSING is the RECONCILIATION:
-- after the nakladnoy is created, the system reads the Poster cash shift
-- (finance.getCashShifts) for that store+day — and optionally the safe balance
-- (finance.getAccounts) — and compares Poster's cash/card/expense against what
-- the cashier submitted. This table PERSISTS one reconciliation per submission
-- so PM/admin can audit the kassir vs Poster gap (in-app + GET endpoint).
--
-- Field mapping (submitted ↔ Poster):
--   submitted_cash    = remainder − card          ↔ poster_cash    = amount_sell_cash
--   submitted_card    = card                       ↔ poster_card    = amount_sell_card
--   submitted_expense = expense                    ↔ poster_expense = amount_debit
--   *_diff = submitted_* − poster_*   (positive = cashier reported MORE).
--   poster_safe_balance = the store's cash-box account balance (informational).
--
-- status:
--   'no_poster_data' — Poster returned no shift for that store+day (cannot compare);
--   'matched'        — every diff within tolerance (±1000 so'm);
--   'discrepancy'    — at least one diff exceeds tolerance → PM + manager alerted.
--
-- INVARIANT: reconciliation is NON-FATAL — a Poster/recon failure NEVER breaks
-- the submission (the nakladnoy already exists). So nakladnoy_id is NOT NULL
-- (a recon row always belongs to a created nakladnoy), but the poster_* columns
-- are NULLABLE (filled only when Poster data was available).
--
-- IDEMPOTENT: CREATE TABLE / INDEX IF NOT EXISTS; purely additive. Money is
-- stored in so'm (NUMERIC) — the service converts Poster TIYIN before insert.
-- =============================================================================

CREATE TABLE IF NOT EXISTS cash_shift_reconciliation (
    id                  BIGSERIAL     PRIMARY KEY,
    -- The money nakladnoy this reconciliation belongs to (1:1 in practice).
    nakladnoy_id        BIGINT        NOT NULL REFERENCES nakladnoy(id) ON DELETE CASCADE,
    -- The store the shift was submitted for (RBAC anchor).
    location_id         BIGINT        NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
    -- The business day of the shift (UTC date the submission was reconciled for).
    shift_date          DATE          NOT NULL,
    -- The matched Poster cash_shift_id, when one was found (else NULL).
    poster_cash_shift_id TEXT         NULL,

    -- What the cashier submitted (so'm). cash = naqd qoldiq (remainder − card).
    submitted_cash      NUMERIC(14,2) NOT NULL,
    submitted_card      NUMERIC(14,2) NOT NULL,
    submitted_expense   NUMERIC(14,2) NOT NULL,

    -- What Poster reported (so'm) — NULL when Poster had no data.
    poster_cash         NUMERIC(14,2) NULL,
    poster_card         NUMERIC(14,2) NULL,
    poster_expense      NUMERIC(14,2) NULL,
    -- The store's cash-box (safe) balance from finance.getAccounts (so'm).
    poster_safe_balance NUMERIC(14,2) NULL,

    -- submitted_* − poster_* (so'm). NULL when there is no Poster value.
    cash_diff           NUMERIC(14,2) NULL,
    card_diff           NUMERIC(14,2) NULL,
    expense_diff        NUMERIC(14,2) NULL,

    status              TEXT          NOT NULL
        CHECK (status IN ('matched', 'discrepancy', 'no_poster_data')),
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_cash_shift_recon_location
    ON cash_shift_reconciliation (location_id);
CREATE INDEX IF NOT EXISTS ix_cash_shift_recon_date
    ON cash_shift_reconciliation (shift_date DESC);
CREATE INDEX IF NOT EXISTS ix_cash_shift_recon_status
    ON cash_shift_reconciliation (status);
CREATE INDEX IF NOT EXISTS ix_cash_shift_recon_nakladnoy
    ON cash_shift_reconciliation (nakladnoy_id);

COMMENT ON TABLE cash_shift_reconciliation IS
  'TZ Module 15 — kassir bot submission reconciled against Poster cash shift '
  '(finance.getCashShifts) + safe balance (finance.getAccounts). One row per '
  'cash_shift nakladnoy; non-fatal — never blocks the submission.';
