/**
 * EPIC 8.5 — GET /api/cash-shifts (kassa smenasi close-out).
 *
 *   GET /api/cash-shifts?range=today|week|month|custom&from=&to=&store_id=
 *
 * Read-only window onto Poster `finance.getCashshifts`, mapped to the frontend
 * `CashShift` contract (savdo / naqd / karta / rasxod / inkassatsiya / qoldiq +
 * kniжный/факт farq). RBAC mirrors the sales endpoints: PM + ai_assistant see
 * every store; a scoped principal (store_manager, etc.) is locked to its
 * assigned `locationIds`. Poster stays read-only — nothing is written back.
 *
 * Envelope: `{ items: CashShift[] }`.
 */
import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { AppError } from '../errors/index.js';
import { getPrincipal, isSuperAdmin } from '../lib/principal.js';
import { parseOptionalIdParam } from '../lib/validate.js';
import { parseDateRange, toPosterDate } from '../lib/dateRange.js';
import { listCashShifts } from '../services/cashShift.js';
import { createPosterClientFromConfig, PosterApiError } from '../integrations/poster/client.js';
import { query, type SqlParam } from '../db/index.js';

export const cashShiftsRouter: Router = Router();

/** TZ Module 15 — the reconciliation statuses the log carries. */
const RECON_STATUSES = ['matched', 'discrepancy', 'no_poster_data'] as const;
type ReconStatus = (typeof RECON_STATUSES)[number];

/**
 * A Poster failure that means "this method is unavailable for this account",
 * not "the network is down". We DEGRADE on these (return an empty list) so the
 * page renders its clean empty state instead of 500-ing. A genuine transient
 * error (timeout / `fetch failed`) has neither `status` nor `posterCode` set —
 * we let those propagate so they are still visible.
 *
 * Examples that degrade: HTTP 4xx (incl. 405 Method Not Allowed) and the
 * Poster `{code:30, Method Not Allowed}` envelope.
 */
function isMethodLevelPosterError(err: unknown): err is PosterApiError {
  if (!(err instanceof PosterApiError)) return false;
  if (err.status !== undefined && err.status >= 400 && err.status < 500) return true;
  if (err.posterCode === 30) return true;
  return false;
}

cashShiftsRouter.get(
  '/',
  authenticate,
  authorize('pm', 'store_manager', 'central_warehouse_manager', 'ai_assistant'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const range = parseDateRange(req.query);
    const storeIdParam = parseOptionalIdParam(
      typeof req.query.store_id === 'string' ? req.query.store_id : undefined,
      'store_id',
    );

    // RBAC scoping — parity with GET /api/sales/receipts.
    let storeIds: number[] | null;
    if (isSuperAdmin(principal) || principal.role === 'ai_assistant') {
      storeIds = storeIdParam === undefined ? null : [storeIdParam];
    } else {
      if (principal.locationIds.length === 0) {
        res.status(200).json({ items: [] });
        return;
      }
      if (storeIdParam !== undefined) {
        if (!principal.locationIds.includes(storeIdParam)) {
          throw AppError.forbidden('You may only view cash shifts for your own location.');
        }
        storeIds = [storeIdParam];
      } else {
        storeIds = principal.locationIds;
      }
    }

    const poster = createPosterClientFromConfig();
    try {
      const items = await listCashShifts(poster, {
        dateFrom: toPosterDate(range.from),
        // `to` is the exclusive upper bound; step back a ms so the YYYYMMDD day
        // is the last full day in the window.
        dateTo: toPosterDate(new Date(range.to.getTime() - 1)),
        storeIds,
      });
      res.status(200).json({ items });
    } catch (err) {
      // Degrade gracefully when Poster says the method is unavailable for this
      // account — never 500 the page. The frontend renders an empty state.
      if (isMethodLevelPosterError(err)) {
        console.warn(
          `[cash-shifts] Poster cash-shift method unavailable, returning empty: ${err.message}`,
        );
        res.status(200).json({ items: [] });
        return;
      }
      throw err; // genuine transient/unexpected error — let it surface.
    }
  }),
);

// ---------------------------------------------------------------------------
// GET /api/cash-shifts/reconciliations — TZ Module 15 kassir solishtiruv log.
// ---------------------------------------------------------------------------
// Filters: from, to (YYYY-MM-DD, on shift_date), location_id, status.
// RBAC: pm / ai_assistant chain-wide; a scoped manager sees only its own
// locationIds (a scoped principal with no location sees an empty log).
// Envelope: { items: [...] } — newest first, joined with location_name +
// nakladnoy id. Every value is parameterized (security-and-hardening).

/** The reconciliation list-item shape (matches the contract exactly). */
type ReconciliationItem = {
  id: number;
  nakladnoy_id: number;
  location_id: number;
  location_name: string | null;
  shift_date: string; // YYYY-MM-DD
  poster_cash_shift_id: string | null;
  submitted_cash: number;
  submitted_card: number;
  submitted_expense: number;
  poster_cash: number | null;
  poster_card: number | null;
  poster_expense: number | null;
  poster_safe_balance: number | null;
  cash_diff: number | null;
  card_diff: number | null;
  expense_diff: number | null;
  status: ReconStatus;
  created_at: string;
};

/** Raw pg row — numerics arrive as strings, dates as Date. */
type ReconciliationRow = {
  id: string;
  nakladnoy_id: string;
  location_id: string;
  location_name: string | null;
  shift_date: Date;
  poster_cash_shift_id: string | null;
  submitted_cash: string;
  submitted_card: string;
  submitted_expense: string;
  poster_cash: string | null;
  poster_card: string | null;
  poster_expense: string | null;
  poster_safe_balance: string | null;
  cash_diff: string | null;
  card_diff: string | null;
  expense_diff: string | null;
  status: ReconStatus;
  created_at: Date;
};

const num = (v: string | null): number | null => (v === null ? null : Number(v));

/** A pg DATE (parsed at local midnight) → `YYYY-MM-DD` using its LOCAL parts. */
function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function mapReconciliationRow(r: ReconciliationRow): ReconciliationItem {
  return {
    id: Number(r.id),
    nakladnoy_id: Number(r.nakladnoy_id),
    location_id: Number(r.location_id),
    location_name: r.location_name,
    // shift_date is a DATE — render as YYYY-MM-DD. node-postgres parses a DATE
    // to a JS Date at LOCAL midnight, so `toISOString()` (UTC) would roll the
    // day back one in a positive-offset timezone (e.g. UTC+5). Read the LOCAL
    // Y/M/D components so the wire value matches the stored calendar date.
    shift_date: formatLocalDate(r.shift_date),
    poster_cash_shift_id: r.poster_cash_shift_id,
    submitted_cash: Number(r.submitted_cash),
    submitted_card: Number(r.submitted_card),
    submitted_expense: Number(r.submitted_expense),
    poster_cash: num(r.poster_cash),
    poster_card: num(r.poster_card),
    poster_expense: num(r.poster_expense),
    poster_safe_balance: num(r.poster_safe_balance),
    cash_diff: num(r.cash_diff),
    card_diff: num(r.card_diff),
    expense_diff: num(r.expense_diff),
    status: r.status,
    created_at: r.created_at.toISOString(),
  };
}

/** Strict `YYYY-MM-DD` → that date; 422 otherwise. Compared against a DATE col. */
function parseDateFilter(raw: unknown, label: string): string | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw AppError.validation(`Query "${label}" must be YYYY-MM-DD.`);
  }
  const d = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) {
    throw AppError.validation(`Query "${label}" is not a valid date.`);
  }
  return raw;
}

/** Parse an optional `?status=` filter; 422 on an unknown value. */
function parseReconStatusFilter(raw: unknown): ReconStatus | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (typeof raw !== 'string' || !(RECON_STATUSES as readonly string[]).includes(raw)) {
    throw AppError.validation(`Query "status" must be one of: ${RECON_STATUSES.join(', ')}.`);
  }
  return raw as ReconStatus;
}

const RECON_ITEM_SELECT = `
  r.id,
  r.nakladnoy_id,
  r.location_id,
  l.name AS location_name,
  r.shift_date,
  r.poster_cash_shift_id,
  r.submitted_cash,
  r.submitted_card,
  r.submitted_expense,
  r.poster_cash,
  r.poster_card,
  r.poster_expense,
  r.poster_safe_balance,
  r.cash_diff,
  r.card_diff,
  r.expense_diff,
  r.status,
  r.created_at
  FROM cash_shift_reconciliation r
  LEFT JOIN locations l ON l.id = r.location_id`;

const RECON_MAX_LIMIT = 500;

cashShiftsRouter.get(
  '/reconciliations',
  authenticate,
  authorize('pm', 'store_manager', 'central_warehouse_manager', 'ai_assistant'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const from = parseDateFilter(req.query.from, 'from');
    const to = parseDateFilter(req.query.to, 'to');
    if (from !== undefined && to !== undefined && from > to) {
      throw AppError.validation('Query "from" must not be after "to".');
    }
    const status = parseReconStatusFilter(req.query.status);
    const locationFilter = parseOptionalIdParam(
      typeof req.query.location_id === 'string' ? req.query.location_id : undefined,
      'location_id',
    );

    // RBAC scoping — mirrors GET /api/cash-shifts. PM + ai_assistant: chain-wide
    // (honour an optional location_id); a scoped manager: only its locations.
    const params: SqlParam[] = [];
    const clauses: string[] = [];

    if (isSuperAdmin(principal) || principal.role === 'ai_assistant') {
      if (locationFilter !== undefined) {
        params.push(locationFilter);
        clauses.push(`r.location_id = $${params.length}`);
      }
    } else {
      if (principal.locationIds.length === 0) {
        res.status(200).json({ items: [] });
        return;
      }
      if (locationFilter !== undefined) {
        if (!principal.locationIds.includes(locationFilter)) {
          throw AppError.forbidden('You may only view reconciliations for your own location.');
        }
        params.push(locationFilter);
        clauses.push(`r.location_id = $${params.length}`);
      } else {
        params.push(principal.locationIds);
        clauses.push(`r.location_id = ANY($${params.length}::bigint[])`);
      }
    }

    if (from !== undefined) {
      params.push(from);
      clauses.push(`r.shift_date >= $${params.length}::date`);
    }
    if (to !== undefined) {
      params.push(to);
      clauses.push(`r.shift_date <= $${params.length}::date`);
    }
    if (status !== undefined) {
      params.push(status);
      clauses.push(`r.status = $${params.length}`);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await query<ReconciliationRow>(
      `SELECT ${RECON_ITEM_SELECT}
       ${where}
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT ${RECON_MAX_LIMIT}`,
      params,
    );
    res.status(200).json({ items: rows.map(mapReconciliationRow) });
  }),
);
