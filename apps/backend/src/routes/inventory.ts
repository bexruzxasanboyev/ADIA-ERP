/**
 * TZ Module 11 — Inventarizatsiya (kun-oxiri inventarizatsiya, bo'lak ↔ butun).
 *
 *   GET  /api/inventory/end-of-day?location_id=&date=YYYY-MM-DD
 *        — for each whole-and-sliced product with stock>0 at the location, the
 *          system qty decomposed into { whole, pieces, remnant_kg } (a count
 *          worksheet). RBAC: pm / ai_assistant chain-wide; a location-scoped
 *          manager only its own location(s).
 *
 *   POST /api/inventory/count
 *        — record a physical count: convert { counted_whole, counted_pieces,
 *          counted_remnant_kg } back to kg, diff against the live system qty,
 *          and when they differ apply ONE atomic 'adjust' stock_movement that
 *          brings stock to the counted figure (invariant 1 & 3). UPSERTs one
 *          row per (location, product, count_date) — a same-day re-count
 *          re-baselines against current stock, never double-adjusting. RBAC:
 *          pm or the location's own manager.
 *
 *   GET  /api/inventory/counts?location_id=&from=&to=
 *        — count history, newest first, RBAC-scoped.
 *
 * The whole↔piece coefficients (`weight_per_whole`, `pieces_per_whole`) live on
 * `products` and are edited via PATCH /api/products/:id/whole-piece. A product
 * with either coefficient NULL is not whole-and-sliced and cannot be counted by
 * this module (the converter needs both).
 */
import { Router } from 'express';
import { query, withTransaction } from '../db/index.js';
import { AppError } from '../errors/index.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { writeAudit } from '../lib/audit.js';
import {
  assertLocationAccess,
  getEffectiveLocationIds,
  getPrincipal,
} from '../lib/principal.js';
import {
  asObject,
  parseOptionalIdParam,
  requireId,
  requireNonNegativeNumber,
} from '../lib/validate.js';
import { kgToWholePieces, wholePiecesToKg } from '../services/pieceConverter.js';
import { applyMovement } from '../services/stockMovement.js';

export const inventoryRouter: Router = Router();

/** Match a strict `YYYY-MM-DD` calendar date (the API contract for dates). */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a `YYYY-MM-DD` query/body date. Returns the canonical string when
 * valid; throws 422 otherwise. `allowUndefined` lets `end-of-day` default to
 * today when the param is omitted.
 */
function parseIsoDate(raw: unknown, label: string): string {
  if (typeof raw !== 'string' || !ISO_DATE_RE.test(raw)) {
    throw AppError.validation(`"${label}" must be a date in YYYY-MM-DD format.`);
  }
  // Reject impossible calendar dates (e.g. 2026-13-40) — Date normalises, so
  // compare the round-trip back to the input.
  const d = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) {
    throw AppError.validation(`"${label}" is not a valid calendar date.`);
  }
  return raw;
}

/** Today's date as `YYYY-MM-DD` (server local — matches DATE column semantics). */
function todayIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

type EndOfDayRow = {
  product_id: string | number;
  name: string;
  weight_per_whole: string;
  pieces_per_whole: string;
  system_qty: string;
};

// GET /api/inventory/end-of-day?location_id=&date=YYYY-MM-DD
//
// `date` is accepted for audit symmetry with the count endpoint but does not
// change the figures — stock is the live on-hand qty (there is no historical
// stock snapshot in Phase 1). It defaults to today.
inventoryRouter.get(
  '/end-of-day',
  authenticate,
  authorize(
    'pm',
    'ai_assistant',
    'raw_warehouse_manager',
    'production_manager',
    'supply_manager',
    'central_warehouse_manager',
    'store_manager',
  ),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const locationId = parseOptionalIdParam(
      typeof req.query.location_id === 'string' ? req.query.location_id : undefined,
      'location_id',
    );
    if (locationId === undefined) {
      throw AppError.validation('Query "location_id" is required.');
    }
    const date =
      typeof req.query.date === 'string' && req.query.date !== ''
        ? parseIsoDate(req.query.date, 'date')
        : todayIso();

    // RBAC: a scoped manager may only read its own location(s); pm / ai_assistant
    // (getEffectiveLocationIds → null) read any location.
    const scoped = getEffectiveLocationIds(principal);
    if (scoped !== null && !scoped.includes(locationId)) {
      throw AppError.forbidden('You may only view inventory for your own location.');
    }

    // Only whole-and-sliced products (BOTH coefficients set) with stock on hand
    // appear on the worksheet.
    const { rows } = await query<EndOfDayRow>(
      `SELECT s.product_id, p.name,
              p.weight_per_whole, p.pieces_per_whole, s.qty AS system_qty
         FROM stock s
         JOIN products p ON p.id = s.product_id
        WHERE s.location_id = $1
          AND p.weight_per_whole IS NOT NULL
          AND p.pieces_per_whole IS NOT NULL
          AND s.qty > 0
        ORDER BY p.name`,
      [locationId],
    );

    const items = rows.map((r) => {
      const weightPerWhole = Number(r.weight_per_whole);
      const piecesPerWhole = Number(r.pieces_per_whole);
      const systemQty = Number(r.system_qty);
      const { whole, pieces, remnant_kg } = kgToWholePieces(
        systemQty,
        weightPerWhole,
        piecesPerWhole,
      );
      return {
        product_id: Number(r.product_id),
        name: r.name,
        weight_per_whole: weightPerWhole,
        pieces_per_whole: piecesPerWhole,
        system_qty: systemQty,
        whole,
        pieces,
        remnant_kg,
      };
    });

    res.status(200).json({ location_id: locationId, date, items });
  }),
);

/** Shape of an `inventory_counts` row returned to clients (numbers coerced). */
type CountRow = {
  id: string | number;
  location_id: string | number;
  product_id: string | number;
  count_date: string | Date;
  system_qty: string;
  counted_whole: string;
  counted_pieces: string;
  counted_remnant_kg: string;
  counted_qty: string;
  diff_qty: string;
  adjustment_movement_id: string | number | null;
  created_by: string | number | null;
  created_at: string | Date;
};

/**
 * Format a pg `DATE` value as `YYYY-MM-DD`. node-postgres returns a DATE as a
 * JS `Date` at LOCAL midnight, so `toISOString()` (UTC) would shift the day in
 * any non-UTC timezone — use the LOCAL date components instead.
 */
function formatDate(value: string | Date): string {
  if (typeof value === 'string') {
    return value.slice(0, 10);
  }
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, '0');
  const d = String(value.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Coerce a raw `inventory_counts` row (pg strings) into a clean JSON shape. */
function toCountJson(r: CountRow): Record<string, unknown> {
  return {
    id: Number(r.id),
    location_id: Number(r.location_id),
    product_id: Number(r.product_id),
    count_date: formatDate(r.count_date),
    system_qty: Number(r.system_qty),
    counted_whole: Number(r.counted_whole),
    counted_pieces: Number(r.counted_pieces),
    counted_remnant_kg: Number(r.counted_remnant_kg),
    counted_qty: Number(r.counted_qty),
    diff_qty: Number(r.diff_qty),
    adjustment_movement_id:
      r.adjustment_movement_id === null ? null : Number(r.adjustment_movement_id),
    created_by: r.created_by === null ? null : Number(r.created_by),
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
  };
}

// POST /api/inventory/count
//
// Body: { location_id, product_id, count_date, counted_whole, counted_pieces,
//         counted_remnant_kg }. Records the physical count and reconciles stock.
//
// RBAC: pm, or the location's own manager. PM is permitted here per the TZ-11
// contract ("pm or the store's manager") — an end-of-day count is a supervised
// reconciliation. A scoped manager must own the target location.
inventoryRouter.post(
  '/count',
  authenticate,
  authorize(
    'pm',
    'raw_warehouse_manager',
    'production_manager',
    'supply_manager',
    'central_warehouse_manager',
    'store_manager',
  ),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const body = asObject(req.body);
    const locationId = requireId(body, 'location_id');
    const productId = requireId(body, 'product_id');
    const countDate = parseIsoDate(body.count_date, 'count_date');
    const countedWhole = requireNonNegativeNumber(body, 'counted_whole');
    const countedPieces = requireNonNegativeNumber(body, 'counted_pieces');
    const countedRemnantKg = requireNonNegativeNumber(body, 'counted_remnant_kg');

    // RBAC: pm passes (chain-wide); a scoped manager must own the location.
    assertLocationAccess(principal, locationId);

    // The product must exist AND be whole-and-sliced (both coefficients set),
    // otherwise the count cannot be converted to kg.
    const prod = await query<{
      weight_per_whole: string | null;
      pieces_per_whole: string | null;
    }>('SELECT weight_per_whole, pieces_per_whole FROM products WHERE id = $1', [productId]);
    const prodRow = prod.rows[0];
    if (prodRow === undefined) {
      throw AppError.notFound('Product not found.');
    }
    if (prodRow.weight_per_whole === null || prodRow.pieces_per_whole === null) {
      throw AppError.validation(
        'Product is not whole-and-sliced (set weight_per_whole and pieces_per_whole first).',
      );
    }
    const weightPerWhole = Number(prodRow.weight_per_whole);
    const piecesPerWhole = Number(prodRow.pieces_per_whole);

    // Convert the physical tally back to kg (whole + slices + sub-slice kg).
    const countedQty = wholePiecesToKg(
      countedWhole,
      countedPieces,
      weightPerWhole,
      piecesPerWhole,
      countedRemnantKg,
    );

    // Everything below is ONE atomic transaction: read the current system qty
    // under a row lock, apply the reconciling movement (if any), UPSERT the
    // count row, and audit — all-or-nothing (invariant 1).
    const saved = await withTransaction(async (tx) => {
      // Lock the stock row (if any) so a concurrent movement cannot race the
      // diff. A missing row means system qty 0.
      const stock = await tx.query<{ qty: string }>(
        'SELECT qty FROM stock WHERE location_id = $1 AND product_id = $2 FOR UPDATE',
        [locationId, productId],
      );
      const systemQty = stock.rows[0] === undefined ? 0 : Number(stock.rows[0].qty);
      const diff = roundTo4(countedQty - systemQty);

      // Reconcile only when the difference is material (avoids a zero-qty
      // movement, which the movement service rejects, and gives idempotency:
      // a same-day re-count with the same figures sees diff 0 → no movement).
      let adjustmentMovementId: number | null = null;
      if (Math.abs(diff) > 0) {
        const result = await applyMovement(
          {
            productId,
            // diff > 0 → stock was undercounted, RECEIVE the surplus into the
            // location; diff < 0 → stock was overcounted, ISSUE the shortfall
            // out of the location (guarded so it can never go negative).
            fromLocationId: diff < 0 ? locationId : null,
            toLocationId: diff > 0 ? locationId : null,
            qty: Math.abs(diff),
            reason: 'adjust',
            note: `Inventarizatsiya ${countDate}: ${systemQty} → ${countedQty} kg`,
            actorUserId: principal.userId,
          },
          tx,
        );
        adjustmentMovementId = result.movementId;
      }

      // UPSERT the count row. On a same-day re-count we REPLACE the prior row:
      // system_qty becomes the qty observed at THIS count (the post-prior-adjust
      // value), and adjustment_movement_id points at THIS count's movement (or
      // NULL when this re-count needed no adjust). This is why re-counting never
      // double-adjusts — each count re-baselines against live stock.
      const upsert = await tx.query<CountRow>(
        `INSERT INTO inventory_counts
           (location_id, product_id, count_date, system_qty, counted_whole,
            counted_pieces, counted_remnant_kg, counted_qty, diff_qty,
            adjustment_movement_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (location_id, product_id, count_date)
         DO UPDATE SET
            system_qty = EXCLUDED.system_qty,
            counted_whole = EXCLUDED.counted_whole,
            counted_pieces = EXCLUDED.counted_pieces,
            counted_remnant_kg = EXCLUDED.counted_remnant_kg,
            counted_qty = EXCLUDED.counted_qty,
            diff_qty = EXCLUDED.diff_qty,
            adjustment_movement_id = EXCLUDED.adjustment_movement_id,
            created_by = EXCLUDED.created_by,
            created_at = now()
         RETURNING id, location_id, product_id, count_date, system_qty,
                   counted_whole, counted_pieces, counted_remnant_kg,
                   counted_qty, diff_qty, adjustment_movement_id, created_by,
                   created_at`,
        [
          locationId,
          productId,
          countDate,
          systemQty,
          countedWhole,
          countedPieces,
          countedRemnantKg,
          countedQty,
          diff,
          adjustmentMovementId,
          principal.userId,
        ],
      );
      const row = upsert.rows[0];
      if (row === undefined) {
        throw AppError.internal('inventory_counts upsert returned no row.');
      }

      await writeAudit(tx, {
        actorUserId: principal.userId,
        action: 'inventory.count',
        entity: 'inventory_counts',
        entityId: Number(row.id),
        payload: {
          location_id: locationId,
          product_id: productId,
          count_date: countDate,
          system_qty: systemQty,
          counted_qty: countedQty,
          diff_qty: diff,
          adjustment_movement_id: adjustmentMovementId,
        },
        activeLocationId: principal.activeLocationId,
      });

      return row;
    });

    res.status(201).json({ count: toCountJson(saved) });
  }),
);

// GET /api/inventory/counts?location_id=&from=&to=
//
// Count history, newest first. RBAC: pm / ai_assistant chain-wide; a scoped
// manager only its own location(s). `from` / `to` are inclusive YYYY-MM-DD
// bounds on `count_date`.
inventoryRouter.get(
  '/counts',
  authenticate,
  authorize(
    'pm',
    'ai_assistant',
    'raw_warehouse_manager',
    'production_manager',
    'supply_manager',
    'central_warehouse_manager',
    'store_manager',
  ),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const locationId = parseOptionalIdParam(
      typeof req.query.location_id === 'string' ? req.query.location_id : undefined,
      'location_id',
    );
    const from =
      typeof req.query.from === 'string' && req.query.from !== ''
        ? parseIsoDate(req.query.from, 'from')
        : undefined;
    const to =
      typeof req.query.to === 'string' && req.query.to !== ''
        ? parseIsoDate(req.query.to, 'to')
        : undefined;

    const conditions: string[] = [];
    const params: (string | number | number[])[] = [];

    // RBAC scoping. A scoped manager is constrained to its assigned
    // location(s); an explicit foreign location_id is a 403.
    const scoped = getEffectiveLocationIds(principal);
    if (scoped !== null) {
      if (scoped.length === 0) {
        res.status(200).json({ items: [] });
        return;
      }
      if (locationId !== undefined && !scoped.includes(locationId)) {
        throw AppError.forbidden('You may only view counts for your own location.');
      }
      if (locationId !== undefined) {
        params.push(locationId);
        conditions.push(`ic.location_id = $${params.length}`);
      } else {
        params.push(scoped);
        conditions.push(`ic.location_id = ANY($${params.length}::bigint[])`);
      }
    } else if (locationId !== undefined) {
      params.push(locationId);
      conditions.push(`ic.location_id = $${params.length}`);
    }

    if (from !== undefined) {
      params.push(from);
      conditions.push(`ic.count_date >= $${params.length}`);
    }
    if (to !== undefined) {
      params.push(to);
      conditions.push(`ic.count_date <= $${params.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await query<CountRow & { product_name: string; location_name: string }>(
      `SELECT ic.id, ic.location_id, ic.product_id, ic.count_date, ic.system_qty,
              ic.counted_whole, ic.counted_pieces, ic.counted_remnant_kg,
              ic.counted_qty, ic.diff_qty, ic.adjustment_movement_id,
              ic.created_by, ic.created_at,
              p.name AS product_name, l.name AS location_name
         FROM inventory_counts ic
         JOIN products p ON p.id = ic.product_id
         JOIN locations l ON l.id = ic.location_id
         ${where}
        ORDER BY ic.count_date DESC, ic.id DESC`,
      params,
    );

    const items = rows.map((r) => ({
      ...toCountJson(r),
      product_name: r.product_name,
      location_name: r.location_name,
    }));
    res.status(200).json({ items });
  }),
);

/** Round a kg figure to 4 dp (matches NUMERIC(14,4) — kills float dust on diff). */
function roundTo4(value: number): number {
  return Math.round((value + Number.EPSILON) * 1e4) / 1e4;
}
