/**
 * EPIC 8.4 — nakladnoy (material requisition) API.
 *
 *   POST /api/nakladnoy            { product_id, qty, location_id?, source?, note? }
 *        -> generate + persist a sectioned material nakladnoy from the BOM.
 *   GET  /api/nakladnoy            ?location_id=&limit=
 *        -> list recent nakladnoy headers (RBAC-scoped).
 *   GET  /api/nakladnoy/:id        -> one header + its lines.
 *
 * RBAC: generation is a WRITE — the caller must operate the target location
 * (`requireLocationOperator`), so PM is read-and-recommend (blocked from POST).
 * Reads are scoped: a non-PM principal sees only nakladnoy for its own
 * locations. The nakladnoy itself NEVER mutates stock or touches Poster.
 */
import { Router } from 'express';
import { query } from '../db/index.js';
import { poolRunner } from '../lib/audit.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import {
  getEffectiveLocationIds,
  getPrincipal,
  isSuperAdmin,
  requireLocationOperator,
} from '../lib/principal.js';
import {
  asObject,
  optionalId,
  optionalString,
  parseIdParam,
  requireId,
  requirePositiveNumber,
} from '../lib/validate.js';
import { AppError } from '../errors/index.js';
import {
  createNakladnoy,
  getNakladnoy,
  type NakladnoySource,
} from '../services/nakladnoy.js';

export const nakladnoyRouter: Router = Router();

const ALLOWED_SOURCES: readonly NakladnoySource[] = [
  'sale',
  'manual',
  'voice',
  'production_order',
];

// POST /api/nakladnoy — generate from a product demand.
nakladnoyRouter.post(
  '/',
  authenticate,
  authorize('production_manager', 'central_warehouse_manager', 'store_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const body = asObject(req.body);
    const productId = requireId(body, 'product_id');
    const qty = requirePositiveNumber(body, 'qty');
    const locationId = optionalId(body, 'location_id') ?? principal.activeLocationId;
    if (locationId === null || locationId === undefined) {
      throw AppError.validation('location_id is required (no active location).');
    }
    // WRITE RBAC — the operator must own the target location.
    await requireLocationOperator(principal, locationId);

    const sourceRaw = optionalString(body, 'source');
    const source: NakladnoySource =
      sourceRaw !== undefined && (ALLOWED_SOURCES as readonly string[]).includes(sourceRaw)
        ? (sourceRaw as NakladnoySource)
        : 'manual';
    const note = optionalString(body, 'note') ?? null;

    const result = await createNakladnoy({
      source,
      productId,
      qty,
      locationId,
      note,
      actorUserId: principal.userId,
    });
    res.status(201).json(result);
  }),
);

// GET /api/nakladnoy — recent headers (RBAC-scoped).
nakladnoyRouter.get(
  '/',
  authenticate,
  authorize('pm', 'production_manager', 'central_warehouse_manager', 'store_manager', 'ai_assistant'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const limitRaw = Number(req.query.limit ?? 50);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;
    const scope = getEffectiveLocationIds(principal);

    const params: Array<number | number[]> = [];
    let where = '';
    if (scope !== null) {
      // A scoped principal only sees its own locations' documents. An empty
      // assigned set yields NO rows (rather than leaking everything).
      if (scope.length === 0) {
        res.status(200).json({ nakladnoy: [] });
        return;
      }
      params.push(scope);
      where = `WHERE location_id = ANY($1::bigint[])`;
    }
    params.push(limit);
    const { rows } = await query<{
      id: string;
      source: string;
      source_ref: string | null;
      product_id: string | null;
      qty: string;
      location_id: string | null;
      total_amount: string;
      created_by: string | null;
      created_at: string;
    }>(
      `SELECT id, source::text AS source, source_ref, product_id, qty,
              location_id, total_amount, created_by, created_at
         FROM nakladnoy
         ${where}
        ORDER BY created_at DESC, id DESC
        LIMIT $${params.length}`,
      params,
    );
    res.status(200).json({
      nakladnoy: rows.map((r) => ({
        id: Number(r.id),
        source: r.source,
        source_ref: r.source_ref,
        product_id: r.product_id === null ? null : Number(r.product_id),
        qty: Number(r.qty),
        location_id: r.location_id === null ? null : Number(r.location_id),
        total_amount: Number(r.total_amount),
        created_by: r.created_by === null ? null : Number(r.created_by),
        created_at: r.created_at,
      })),
    });
  }),
);

// GET /api/nakladnoy/:id — header + lines.
nakladnoyRouter.get(
  '/:id',
  authenticate,
  authorize('pm', 'production_manager', 'central_warehouse_manager', 'store_manager', 'ai_assistant'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const id = parseIdParam(req.params.id, 'nakladnoy id');
    const result = await getNakladnoy(id, poolRunner);
    if (result === null) {
      throw AppError.notFound('Nakladnoy not found.');
    }
    // Scope guard — a non-PM principal may only read its own locations'.
    if (!isSuperAdmin(principal) && result.header.location_id !== null) {
      if (!principal.locationIds.includes(result.header.location_id)) {
        throw AppError.forbidden('You may only read nakladnoy for your own location.');
      }
    }
    res.status(200).json(result);
  }),
);
