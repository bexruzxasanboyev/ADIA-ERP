/**
 * F4.6 — Sales read endpoint.
 *
 *   GET /api/sales?location_id=&from=&to=&limit=&offset=
 *
 * One read-only window onto the Poster-synced `sales` table for the store
 * pages. PM / ai_assistant may query any store; a scoped principal is
 * locked to its assigned `locationIds` (M:N). Date filters accept ISO
 * timestamps (or YYYY-MM-DD); `from` defaults to start of today, `to`
 * defaults to "open-ended".
 *
 * The endpoint is paginated to keep the page bounded — same `{items,total,
 * limit,offset}` envelope as `GET /api/stock/movements` (spec section 4).
 */
import { Router } from 'express';
import { query, type SqlParam } from '../db/index.js';
import { AppError } from '../errors/index.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { getPrincipal, isSuperAdmin } from '../lib/principal.js';
import { parseOptionalIdParam } from '../lib/validate.js';

export const salesRouter: Router = Router();

const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;

type SalesRow = {
  id: string;
  store_id: string;
  store_name: string;
  product_id: string;
  product_name: string;
  product_unit: string;
  qty: string;
  price: string;
  sold_at: Date;
  poster_transaction_id: string;
};

type SalesItem = {
  id: number;
  store_id: number;
  store_name: string;
  product_id: number;
  product_name: string;
  product_unit: string;
  qty: number;
  price: number;
  sold_at: string;
  poster_transaction_id: number;
};

salesRouter.get(
  '/',
  authenticate,
  authorize(
    'pm',
    'store_manager',
    'central_warehouse_manager',
    'supply_manager',
    'ai_assistant',
  ),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const locationIdParam = parseOptionalIdParam(
      typeof req.query.location_id === 'string' ? req.query.location_id : undefined,
      'location_id',
    );
    const fromParam = parseOptionalDate(
      typeof req.query.from === 'string' ? req.query.from : undefined,
      'from',
    );
    const toParam = parseOptionalDate(
      typeof req.query.to === 'string' ? req.query.to : undefined,
      'to',
    );
    if (fromParam !== undefined && toParam !== undefined && fromParam > toParam) {
      throw AppError.validation('"from" must be earlier than or equal to "to".');
    }

    const limit = clampInt(req.query.limit, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    const offset = clampInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);

    // RBAC scoping. PM / ai_assistant — chain. Scoped principal — intersect
    // with `locationIds`. A scoped principal asking for a foreign location
    // gets 403; absence of the param falls back to its own set.
    let storeFilter: number[] | null;
    if (isSuperAdmin(principal) || principal.role === 'ai_assistant') {
      storeFilter = locationIdParam === undefined ? null : [locationIdParam];
    } else {
      if (principal.locationIds.length === 0) {
        res.status(200).json({ items: [], total: 0, limit, offset });
        return;
      }
      if (locationIdParam !== undefined) {
        if (!principal.locationIds.includes(locationIdParam)) {
          throw AppError.forbidden('You may only view sales for your own location.');
        }
        storeFilter = [locationIdParam];
      } else {
        storeFilter = principal.locationIds;
      }
    }

    const conditions: string[] = [];
    const params: SqlParam[] = [];
    if (storeFilter !== null) {
      params.push(storeFilter);
      conditions.push(`s.store_id = ANY($${params.length}::bigint[])`);
    }
    if (fromParam !== undefined) {
      params.push(fromParam);
      conditions.push(`s.sold_at >= $${params.length}`);
    }
    if (toParam !== undefined) {
      params.push(toParam);
      conditions.push(`s.sold_at <= $${params.length}`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRes = await query<{ total: string }>(
      `SELECT count(*) AS total FROM sales s ${where}`,
      params,
    );
    const total = Number(countRes.rows[0]?.total ?? 0);

    const pageParams = [...params, limit, offset];
    const limitIdx = pageParams.length - 1;
    const offsetIdx = pageParams.length;
    const { rows } = await query<SalesRow>(
      `SELECT s.id, s.store_id, l.name AS store_name,
              s.product_id, p.name AS product_name, p.unit AS product_unit,
              s.qty, s.price, s.sold_at, s.poster_transaction_id
         FROM sales s
         JOIN products  p ON p.id = s.product_id
         JOIN locations l ON l.id = s.store_id
         ${where}
         ORDER BY s.sold_at DESC, s.id DESC
         LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      pageParams,
    );

    const items: SalesItem[] = rows.map((r) => ({
      id: Number(r.id),
      store_id: Number(r.store_id),
      store_name: r.store_name,
      product_id: Number(r.product_id),
      product_name: r.product_name,
      product_unit: r.product_unit,
      qty: Number(r.qty),
      price: Number(r.price),
      sold_at: r.sold_at.toISOString(),
      poster_transaction_id: Number(r.poster_transaction_id),
    }));
    res.status(200).json({ items, total, limit, offset });
  }),
);

/**
 * Parse an ISO timestamp or `YYYY-MM-DD` date string. Throws 422 on invalid.
 * Returns the parsed `Date`, or `undefined` when the field is absent/empty.
 */
function parseOptionalDate(raw: string | undefined, label: string): Date | undefined {
  if (raw === undefined || raw === '') {
    return undefined;
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw AppError.validation(`"${label}" must be an ISO timestamp or YYYY-MM-DD.`);
  }
  return d;
}

/** Parse a query value as an integer clamped to [min, max], else fallback. */
function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  if (typeof raw !== 'string' || raw === '') {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    return fallback;
  }
  return Math.min(Math.max(n, min), max);
}
