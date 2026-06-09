/**
 * cross-department-flow-plan §6.4 / F-B — the "Manba reja" (source plan) API.
 *
 *   GET  /api/production-plan?product_id&qty&location_id
 *        → analyze (read-only): the per-line source plan for producing `qty`
 *          of `product_id` at sex `location_id`. RBAC: that sex's operator/
 *          manager (or PM/Admin read).
 *   POST /api/production-plan/execute
 *        { request_id?, product_id, qty, location_id, decisions:[{ component_product_id,
 *          action, qty_ready? }] }
 *        → execute (ONE transaction): apply the per-line decisions. WRITE action.
 *
 * RBAC mirrors the production dialog route exactly (the closest precedent):
 * reads are gated to `pm` + `production_manager` + `ai_assistant` with the
 * scoped manager filtered to their own sex via `assertLocationAccess`; the
 * execute write is gated to `pm` + `production_manager` at the role layer, then
 * `requireLocationOperator` blocks PM (read-and-recommend) so only the sex
 * operator emits documents. The service enforces every domain invariant.
 */
import { Router } from 'express';
import { AppError } from '../errors/index.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import {
  assertLocationAccess,
  getPrincipal,
  requireLocationOperator,
} from '../lib/principal.js';
import {
  asObject,
  optionalId,
  parseIdParam,
  requireEnum,
  requireId,
  requirePositiveNumber,
} from '../lib/validate.js';
import {
  analyzeProductionPlan,
  executeProductionPlan,
  type PlanDecision,
  type PlanLineAction,
} from '../services/productionPlan.js';
import { poolRunner } from '../lib/audit.js';

export const productionPlanRouter: Router = Router();

const PLAN_ACTIONS: readonly PlanLineAction[] = [
  'use_ready',
  'make',
  'order',
  'transfer',
  'purchase',
];

// GET /api/production-plan?product_id&qty&location_id
productionPlanRouter.get(
  '/',
  authenticate,
  authorize('pm', 'production_manager', 'ai_assistant'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const productId = parseIdParam(
      typeof req.query.product_id === 'string' ? req.query.product_id : undefined,
      'product_id',
    );
    const locationId = parseIdParam(
      typeof req.query.location_id === 'string' ? req.query.location_id : undefined,
      'location_id',
    );
    const qtyRaw = typeof req.query.qty === 'string' ? Number(req.query.qty) : NaN;
    if (!Number.isFinite(qtyRaw) || qtyRaw <= 0) {
      throw AppError.validation('Query "qty" must be a number greater than zero.');
    }

    // RBAC: PM reads any sex; a scoped operator only their own. `ai_assistant`
    // is chain-wide read (mirrors the dialog GET) — assertLocationAccess passes
    // it only if it has the location, so allow it explicitly here.
    if (principal.role !== 'ai_assistant') {
      assertLocationAccess(principal, locationId);
    }

    const plan = await analyzeProductionPlan(poolRunner, {
      productId,
      qty: qtyRaw,
      sexLocationId: locationId,
    });
    res.status(200).json(plan);
  }),
);

// POST /api/production-plan/execute
productionPlanRouter.post(
  '/execute',
  authenticate,
  authorize('pm', 'production_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const body = asObject(req.body);
    const productId = requireId(body, 'product_id');
    const locationId = requireId(body, 'location_id');
    const qty = requirePositiveNumber(body, 'qty');
    const requestId = optionalId(body, 'request_id');

    const decisionsRaw = body.decisions;
    if (!Array.isArray(decisionsRaw) || decisionsRaw.length === 0) {
      throw AppError.validation('Field "decisions" must be a non-empty array.');
    }
    const decisions: PlanDecision[] = decisionsRaw.map((d) => {
      const obj = asObject(d);
      const componentProductId = requireId(obj, 'component_product_id');
      const action = requireEnum(obj, 'action', PLAN_ACTIONS);
      let qtyReady: number | undefined;
      if (obj.qty_ready !== undefined && obj.qty_ready !== null) {
        const n = Number(obj.qty_ready);
        if (!Number.isFinite(n) || n <= 0) {
          throw AppError.validation('Field "qty_ready" must be a positive number when provided.');
        }
        qtyReady = n;
      }
      return {
        component_product_id: componentProductId,
        action,
        ...(qtyReady !== undefined ? { qty_ready: qtyReady } : {}),
      };
    });

    // Write action — PM blocked (read-and-recommend), scoped operator must own
    // the sex location the plan is executed AT.
    await requireLocationOperator(principal, locationId);

    const result = await executeProductionPlan({
      requestId: requestId ?? null,
      productId,
      qty,
      sexLocationId: locationId,
      decisions,
      actorUserId: principal.userId,
    });
    res.status(200).json(result);
  }),
);
