/**
 * Seller KPI — SELLER-level "Do'kon KPI" (TZ Module 8). The store-level KPI
 * (`routes/storeKpi.ts`) ranks STORES; this router ranks the SELLERS (cashiers
 * / waiters) inside them:
 *
 *   GET  /api/seller-kpi?month=YYYY-MM&store_id=  — the seller leaderboard.
 *   PUT  /api/seller-kpi/plan                     — upsert one seller's plan (pm).
 *   POST /api/seller-kpi/sync                      — sync Poster waiters -> sellers.
 *
 * ACTUAL revenue is read LIVE from Poster `dash.getWaitersSales` (Variant B —
 * the local `sales` table has no seller dimension and history cannot be
 * re-attributed). The service attributes each waiter's per-spot revenue to the
 * ADIA store behind the spot (same spot->store map as the cash-shift view),
 * divides tiyin->so'm, and computes achievement % + MoM growth + rank.
 *
 * RBAC (mirrors the store KPI):
 *   - `pm` / `ai_assistant`  — chain-wide (every active store; optional
 *                              `?store_id=` narrows it).
 *   - `store_manager`        — own store(s) only; a scoped manager with no
 *                              assigned store gets an empty leaderboard.
 *   - PUT /plan, POST /sync  — `pm` ONLY (planning + sync inputs).
 *   - every other role       — 403 (the `authorize` gate).
 *
 * Poster stays READ-ONLY. A method-level Poster failure (HTTP 4xx / code 30)
 * degrades to an empty leaderboard instead of 500-ing — same as `cash-shifts`.
 * All SQL is parameterized; the month label is validated against `YYYY-MM`.
 */
import { Router } from 'express';
import { query, withTransaction } from '../db/index.js';
import { AppError } from '../errors/index.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { getPrincipal, isSuperAdmin } from '../lib/principal.js';
import { writeAudit, poolRunner } from '../lib/audit.js';
import { parseOptionalIdParam } from '../lib/validate.js';
import { createPosterClientFromConfig, PosterApiError } from '../integrations/poster/client.js';
import {
  computeSellerKpi,
  syncSellersFromPoster,
  type SellerKpiResult,
} from '../services/sellerKpi.js';
import type { AuthPrincipal } from '../auth/jwt.js';

export const sellerKpiRouter: Router = Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Validate `?month=YYYY-MM`; default to the CURRENT month when absent/empty. */
function resolveMonthLabel(raw: unknown): string {
  if (raw === undefined || raw === '') {
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  if (typeof raw !== 'string') {
    throw AppError.validation('Query "month" must be a string "YYYY-MM".');
  }
  const m = /^(\d{4})-(\d{2})$/.exec(raw.trim());
  if (m === null) {
    throw AppError.validation('Query "month" must be in the form "YYYY-MM".');
  }
  const monthNum = Number(m[2]);
  if (monthNum < 1 || monthNum > 12) {
    throw AppError.validation('Query "month" must have a month between 01 and 12.');
  }
  return raw.trim();
}

/**
 * RBAC store scope for a principal. `null` = chain-wide (pm / ai_assistant);
 * an array = the principal's own store ids; an EMPTY array = scoped with no
 * stores (-> empty leaderboard).
 */
function resolveAllowedStoreIds(principal: AuthPrincipal): number[] | null {
  if (isSuperAdmin(principal) || principal.role === 'ai_assistant') {
    return null;
  }
  return principal.locationIds; // may be [] -> empty leaderboard.
}

/**
 * Apply an optional `?store_id=` filter on top of the RBAC scope. PM /
 * ai_assistant may narrow to any store; a scoped principal may only narrow to
 * a store they already own (else 403).
 */
function applyStoreFilter(
  allowed: number[] | null,
  storeIdParam: number | undefined,
): number[] | null {
  if (storeIdParam === undefined) return allowed;
  if (allowed === null) return [storeIdParam]; // chain-wide -> narrow freely.
  if (!allowed.includes(storeIdParam)) {
    throw AppError.forbidden('You may only view seller KPI for your own store.');
  }
  return [storeIdParam];
}

/**
 * A Poster failure that means "this method is unavailable for this account",
 * not "the network is down" — we DEGRADE on these (empty leaderboard) so the
 * page renders cleanly. Identical predicate to `cashShifts.ts`.
 */
function isMethodLevelPosterError(err: unknown): err is PosterApiError {
  if (!(err instanceof PosterApiError)) return false;
  if (err.status !== undefined && err.status >= 400 && err.status < 500) return true;
  if (err.posterCode === 30) return true;
  return false;
}

const EMPTY_RESULT = (month: string): SellerKpiResult => ({
  month,
  items: [],
  summary: { total_target: 0, total_actual: 0, achievement_pct: null },
});

// ---------------------------------------------------------------------------
// GET /api/seller-kpi?month=YYYY-MM&store_id= — the seller leaderboard.
// ---------------------------------------------------------------------------

sellerKpiRouter.get(
  '/',
  authenticate,
  authorize('pm', 'ai_assistant', 'store_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const month = resolveMonthLabel(req.query['month']);
    const storeIdParam = parseOptionalIdParam(
      typeof req.query['store_id'] === 'string' ? req.query['store_id'] : undefined,
      'store_id',
    );

    const baseScope = resolveAllowedStoreIds(principal);
    const allowedStoreIds = applyStoreFilter(baseScope, storeIdParam);

    // Scoped-with-no-stores -> empty (no Poster call).
    if (allowedStoreIds !== null && allowedStoreIds.length === 0) {
      res.status(200).json(EMPTY_RESULT(month));
      return;
    }

    const poster = createPosterClientFromConfig();
    try {
      const result = await computeSellerKpi(poster, { month, allowedStoreIds });
      res.status(200).json(result);
    } catch (err) {
      if (isMethodLevelPosterError(err)) {
        console.warn(
          `[seller-kpi] Poster waiter-sales method unavailable, returning empty: ${err.message}`,
        );
        res.status(200).json(EMPTY_RESULT(month));
        return;
      }
      throw err; // genuine transient/unexpected error — let it surface.
    }
  }),
);

// ---------------------------------------------------------------------------
// PUT /api/seller-kpi/plan — upsert one seller's monthly plan (pm only).
// ---------------------------------------------------------------------------

type PlanRow = {
  id: string;
  seller_id: string;
  month: string;
  target_sum: string;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
};

/** Validate the PUT /plan body into a typed, sanitised input. */
function parsePlanBody(body: unknown): {
  sellerId: number;
  month: string;
  targetSum: number;
} {
  if (typeof body !== 'object' || body === null) {
    throw AppError.validation('Request body must be a JSON object.');
  }
  const b = body as Record<string, unknown>;

  const sellerId = Number(b['seller_id']);
  if (!Number.isInteger(sellerId) || sellerId <= 0) {
    throw AppError.validation('"seller_id" must be a positive integer.');
  }

  const monthRaw = b['month'];
  if (typeof monthRaw !== 'string') {
    throw AppError.validation('"month" must be a string "YYYY-MM".');
  }
  const m = /^(\d{4})-(\d{2})$/.exec(monthRaw.trim());
  if (m === null) {
    throw AppError.validation('"month" must be in the form "YYYY-MM".');
  }
  const monthNum = Number(m[2]);
  if (monthNum < 1 || monthNum > 12) {
    throw AppError.validation('"month" must have a month between 01 and 12.');
  }
  const month = monthRaw.trim();

  const targetSum = Number(b['target_sum']);
  if (!Number.isFinite(targetSum) || targetSum < 0) {
    throw AppError.validation('"target_sum" must be a number >= 0.');
  }

  return { sellerId, month, targetSum };
}

sellerKpiRouter.put(
  '/plan',
  authenticate,
  authorize('pm'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const { sellerId, month, targetSum } = parsePlanBody(req.body);

    // The seller must exist (the FK would reject otherwise, but a clean 404 is
    // friendlier than a constraint-violation 500).
    const seller = await query<{ id: string }>(
      `SELECT id FROM sellers WHERE id = $1`,
      [sellerId],
    );
    if (seller.rows[0] === undefined) {
      throw AppError.notFound('Seller not found.');
    }

    const row = await withTransaction(async (tx) => {
      const upserted = await tx.query<PlanRow>(
        `INSERT INTO seller_sales_plan (seller_id, month, target_sum, created_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (seller_id, month)
         DO UPDATE SET target_sum = EXCLUDED.target_sum, updated_at = now()
         RETURNING id, seller_id, month, target_sum, created_by,
                   created_at, updated_at`,
        [sellerId, month, targetSum, principal.userId],
      );
      const r = upserted.rows[0];
      if (r === undefined) {
        throw AppError.validation('Failed to upsert the seller sales plan.');
      }
      await writeAudit(tx, {
        actorUserId: principal.userId,
        action: 'seller_sales_plan.upsert',
        entity: 'seller_sales_plan',
        entityId: Number(r.id),
        payload: { seller_id: sellerId, month, target_sum: targetSum },
        activeLocationId: principal.activeLocationId,
      });
      return r;
    });

    res.status(200).json({
      id: Number(row.id),
      seller_id: Number(row.seller_id),
      month: row.month.trim(), // CHAR(7) — trim any storage padding.
      target_sum: Number(row.target_sum),
      created_by: row.created_by === null ? null : Number(row.created_by),
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    });
  }),
);

// ---------------------------------------------------------------------------
// POST /api/seller-kpi/sync — sync Poster waiters -> sellers (pm only).
// ---------------------------------------------------------------------------

sellerKpiRouter.post(
  '/sync',
  authenticate,
  authorize('pm'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const month = resolveMonthLabel(req.query['month']);

    const poster = createPosterClientFromConfig();
    try {
      // pm is chain-wide -> every store (allowedStoreIds = null).
      const out = await syncSellersFromPoster(poster, { month, allowedStoreIds: null });
      await writeAudit(poolRunner, {
        actorUserId: principal.userId,
        action: 'sellers.sync',
        entity: 'sellers',
        entityId: null,
        payload: { month, synced: out.synced },
        activeLocationId: principal.activeLocationId,
      });
      res.status(200).json({ month, synced: out.synced });
    } catch (err) {
      if (isMethodLevelPosterError(err)) {
        console.warn(
          `[seller-kpi] Poster waiter-sales method unavailable during sync: ${err.message}`,
        );
        res.status(200).json({ month, synced: 0 });
        return;
      }
      throw err;
    }
  }),
);
