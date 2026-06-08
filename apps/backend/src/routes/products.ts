/**
 * M2 — Products & Recipes / BOM (spec section 4.3).
 *
 *   GET  /api/products            — list (optional ?type=)
 *   POST /api/products            — create a product
 *   GET  /api/products/:id/recipe — the product's BOM
 *   PUT  /api/products/:id/recipe — full-replace the product's BOM
 *
 * BOM source (spec section 5.5): the Poster import path is currently blocked
 * (POSTER_TOKEN is empty — see docs/adia-poster-api.md section 8), so Phase 1
 * uses the manual `PUT .../recipe` path. The endpoint contract is unchanged
 * when import is later added.
 *
 * AC2.2 — a BOM must not create a cycle. Two layers:
 *   - direct self-reference   : product_id <> component_product_id;
 *   - deep cycle (A->B->A...)  : a recursive reachability walk before write.
 */
import { Router } from 'express';
import { query, withTransaction, type TxClient } from '../db/index.js';
import { AppError } from '../errors/index.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { writeAudit, poolRunner } from '../lib/audit.js';
import { getPrincipal } from '../lib/principal.js';
import {
  asObject,
  optionalId,
  parseIdParam,
  requireEnum,
  requirePositiveNumber,
  requireString,
} from '../lib/validate.js';
import { matchesSearch } from '../lib/translit.js';
import {
  deriveCategory,
  effectiveType,
  type ProductCategory,
  type ProductType,
} from '../lib/productCategory.js';
import { readRecipeTree } from '../services/bom.js';
import { computeAllProductCosts } from '../services/costRollup.js';
import { enqueueProductUnitWriteback } from '../services/posterWriteback.js';

export const productsRouter: Router = Router();

const PRODUCT_TYPES = ['raw', 'semi', 'finished'] as const;
const UNIT_TYPES = ['kg', 'l', 'pcs'] as const;

type ProductRow = {
  id: number;
  name: string;
  type: string;
  unit: string;
  sku: string | null;
  poster_ingredient_id: number | null;
  poster_product_id: number | null;
  category_id: number | null;
  /** Joined from categories — the REAL Poster category name (NULL when none). */
  category_name: string | null;
  /** Poster тех.карта photo URL (CDN-relative), or NULL. */
  image_url: string | null;
  /** Which production location (sex) makes this product, or NULL. */
  workshop_location_id: number | null;
  /** Joined from locations — the workshop (sex) name, or NULL. */
  workshop_name: string | null;
  /** EXISTS flag — true when the product has at least one row in `recipes`. */
  has_recipe: boolean;
  /**
   * FEATURE A — the Poster-synced unit cost (so'm per unit), or NULL. Refreshed
   * on every sync; overridden by `manual_cost_per_unit` when that is set.
   */
  cost_per_unit: string | number | null;
  /**
   * FEATURE A — the MANUAL unit-cost override (so'm per unit), or NULL. When
   * non-null it WINS over `cost_per_unit` everywhere and survives re-sync.
   */
  manual_cost_per_unit: string | number | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
};

/** The real Poster category DTO: `{ id, name }` or `null` when uncategorised. */
type PosterCategoryDto = { id: number; name: string } | null;

/**
 * EPIC 1.3 — a product row enriched with the smart-category fields. `category`
 * is the fine-grained semantic class; `effective_type` upgrades `Г/П`-prefixed
 * names to `finished`. The frontend prefers these over its own client-side
 * derivation.
 */
type EnrichedProductRow = Omit<ProductRow, 'category_name' | 'workshop_name'> & {
  category: ProductCategory;
  effective_type: ProductType;
  /**
   * The REAL Poster category (menu.getCategories). `{ id, name }` or `null`.
   * Distinct from `category` above (which is the EPIC 1.3 heuristic string
   * guess). The frontend should prefer `poster_category` for grouping.
   */
  poster_category: PosterCategoryDto;
  /**
   * The production workshop (sex) that makes this product, joined from
   * `locations` via `workshop_location_id`. `{ id, name }` or `null`.
   */
  workshop: { id: number; name: string } | null;
  /**
   * The bottom-up COMPUTED recipe cost (Себестоимость, so'm per unit) — the
   * same number as `GET /:id/recipe`'s `total_cost`. For a raw/leaf product it
   * is COALESCE(manual_cost_per_unit, cost_per_unit); for a semi/finished it is
   * the recipe roll-up. `null` when any leg's cost is unknown (never a fake 0).
   * Batched per-list via `computeAllProductCosts` (NOT per-row readRecipeTree).
   */
  computed_cost: number | null;
};

/**
 * Attach the EPIC 1.3 smart-category fields + real Poster category + workshop
 * + the computed recipe cost. `computedCost` is passed in by the list endpoint
 * (which batches all costs in one pass); other callers default to `null`.
 */
function enrich(row: ProductRow, computedCost: number | null = null): EnrichedProductRow {
  const type = row.type as ProductType;
  const { category_name, workshop_name, ...rest } = row;
  return {
    ...rest,
    category: deriveCategory(row.name, type),
    effective_type: effectiveType(row.name, type),
    poster_category:
      row.category_id !== null && category_name !== null
        ? { id: Number(row.category_id), name: category_name }
        : null,
    workshop:
      row.workshop_location_id !== null && workshop_name !== null
        ? { id: Number(row.workshop_location_id), name: workshop_name }
        : null,
    computed_cost: computedCost,
  };
}

type RecipeRow = {
  id: number;
  product_id: number;
  component_product_id: number;
  qty_per_unit: number;
};

// Product columns + the joined real-Poster category name. `c.name` is aliased
// to `category_name` so the row shape matches `ProductRow`; the LEFT JOIN keeps
// uncategorised products (category_id IS NULL) in the result.
const PRODUCT_SELECT = `SELECT p.id, p.name, p.type, p.unit, p.sku,
    p.poster_ingredient_id, p.poster_product_id, p.category_id,
    c.name AS category_name,
    p.image_url, p.workshop_location_id,
    w.name AS workshop_name,
    EXISTS (SELECT 1 FROM recipes r WHERE r.product_id = p.id) AS has_recipe,
    p.cost_per_unit, p.manual_cost_per_unit,
    p.is_active, p.created_at, p.updated_at
  FROM products p
  LEFT JOIN categories c ON c.id = p.category_id
  LEFT JOIN locations w ON w.id = p.workshop_location_id`;

// Columns for INSERT ... RETURNING (no join — category_name resolved separately).
const PRODUCT_RETURNING = `id, name, type, unit, sku, poster_ingredient_id,
  poster_product_id, category_id, is_active, created_at, updated_at`;

// GET /api/products?type=
productsRouter.get(
  '/',
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
    const typeRaw = typeof req.query.type === 'string' ? req.query.type : undefined;
    if (typeRaw !== undefined && !(PRODUCT_TYPES as readonly string[]).includes(typeRaw)) {
      throw AppError.validation(`Query "type" must be one of: ${PRODUCT_TYPES.join(', ')}.`);
    }

    // EPIC 1.2 — translit-aware `?search=` over name + sku. The match is a
    // phonetic Latin↔Cyrillic normalisation (see lib/translit) that plain SQL
    // LIKE cannot express, so we apply it in application code after the `type`
    // filter narrows the candidate set in SQL.
    const searchRaw =
      typeof req.query.search === 'string' ? req.query.search.trim() : undefined;

    const { rows } =
      typeRaw === undefined
        ? await query<ProductRow>(`${PRODUCT_SELECT} ORDER BY p.id`)
        : await query<ProductRow>(
            `${PRODUCT_SELECT} WHERE p.type = $1 ORDER BY p.id`,
            [typeRaw],
          );

    const filtered =
      searchRaw === undefined || searchRaw === ''
        ? rows
        : rows.filter((r) => matchesSearch(`${r.name} ${r.sku ?? ''}`, searchRaw));

    // Bottom-up computed cost for EVERY product, in ONE batched pass (two
    // queries total — NOT readRecipeTree per row). The map covers the whole
    // catalogue because a filtered product's cost can depend on components that
    // were filtered out; we just read the values we need from it.
    const costs = await computeAllProductCosts(poolRunner);

    // List endpoints return a bare array (spec section 4) — no envelope.
    // Each row carries the EPIC 1.3 smart-category fields + computed_cost.
    res.status(200).json(filtered.map((r) => enrich(r, costs.get(r.id) ?? null)));
  }),
);

// GET /api/products/workshops — the canonical product workshops (sexes).
//
// The SINGLE source the frontend product filter + the assign dropdown use.
// Returns ONLY the 12 canonical Poster workshops: type='production' rows that
// carry a Poster `workshop_id` (poster_workshop_id IS NOT NULL — «Торт отдел»,
// «Наполеон отдел», …). The other production rows are legacy stock-bearing
// sex-storage owners and must NOT appear here. Ordered by name.
//
// AuthZ mirrors GET /api/products (pm + the manager roles) so the filter is
// visible to every product viewer.
productsRouter.get(
  '/workshops',
  authenticate,
  authorize(
    'pm',
    'raw_warehouse_manager',
    'production_manager',
    'supply_manager',
    'central_warehouse_manager',
    'store_manager',
  ),
  asyncHandler(async (_req, res) => {
    const { rows } = await query<{ id: number; name: string }>(
      `SELECT id, name FROM locations
        WHERE type = 'production' AND poster_workshop_id IS NOT NULL
        ORDER BY name`,
    );
    res.status(200).json(rows.map((r) => ({ id: Number(r.id), name: r.name })));
  }),
);

// POST /api/products  — pm, raw_warehouse_manager.
productsRouter.post(
  '/',
  authenticate,
  authorize('pm', 'raw_warehouse_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const body = asObject(req.body);
    const name = requireString(body, 'name');
    const type = requireEnum(body, 'type', PRODUCT_TYPES);
    const unit = requireEnum(body, 'unit', UNIT_TYPES);
    const sku =
      typeof body.sku === 'string' && body.sku.trim() !== '' ? body.sku.trim() : null;
    const posterIngredientId = optionalId(body, 'poster_ingredient_id');
    const posterProductId = optionalId(body, 'poster_product_id');

    if (sku !== null) {
      const dup = await query<{ id: number }>('SELECT id FROM products WHERE sku = $1', [sku]);
      if (dup.rows.length > 0) {
        throw AppError.validation('A product with this SKU already exists.');
      }
    }

    const { rows } = await query<
      Omit<
        ProductRow,
        'category_name' | 'has_recipe' | 'image_url' | 'workshop_location_id' | 'workshop_name'
      >
    >(
      `INSERT INTO products (name, type, unit, sku, poster_ingredient_id, poster_product_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${PRODUCT_RETURNING}`,
      [name, type, unit, sku, posterIngredientId ?? null, posterProductId ?? null],
    );
    const inserted = rows[0];
    if (inserted === undefined) {
      throw AppError.internal('Product insert returned no row.');
    }
    // A manually-created product is never assigned a Poster category here, so
    // category_name is always NULL — the create endpoint does not set category_id.
    // A brand-new product has no recipe rows yet, so has_recipe is always false.
    // A brand-new product has no cost yet (Poster sync sets cost_per_unit; the
    // manual override is opt-in) — both cost columns start NULL.
    const created: ProductRow = {
      ...inserted,
      category_name: null,
      image_url: null,
      workshop_location_id: null,
      workshop_name: null,
      has_recipe: false,
      cost_per_unit: null,
      manual_cost_per_unit: null,
    };
    await writeAudit(poolRunner, {
      actorUserId: principal.userId,
      action: 'product.create',
      entity: 'products',
      entityId: created.id,
      payload: { name, type },
    });
    res.status(201).json({ product: enrich(created) });
  }),
);

// GET /api/products/:id/recipe
//
// Returns BOTH:
//   - `recipe` — the flat top-level lines (backward-compatible; the PUT editor
//                and any existing consumer keep working unchanged);
//   - `tree`   — the NESTED recipe (prepacks expandable), each node carrying
//                qty_per_unit, unit_cost, line_cost, total_cost (so'm);
//   - `total_cost` — the product's full recipe Себестоимость (Σ top-level
//                line_cost), or null when any leg's cost is unknown.
// Cost is computed bottom-up from `products.cost_per_unit` (raw leaf cost).
productsRouter.get(
  '/:id/recipe',
  authenticate,
  authorize('pm', 'production_manager'),
  asyncHandler(async (req, res) => {
    const productId = parseIdParam(req.params.id, 'id');
    const exists = await query<{ recipe_yield: string | number }>(
      'SELECT recipe_yield FROM products WHERE id = $1',
      [productId],
    );
    if (exists.rows.length === 0) {
      throw AppError.notFound('Product not found.');
    }
    const { rows } = await query<RecipeRow>(
      `SELECT id, product_id, component_product_id, qty_per_unit
       FROM recipes WHERE product_id = $1 ORDER BY id`,
      [productId],
    );
    const tree = await readRecipeTree(poolRunner, productId);
    res.status(200).json({
      product_id: productId,
      recipe: rows,
      tree: tree.nodes,
      total_cost: tree.total_cost,
      // TZ-3 — how many finished pieces one full recipe yields. The cost/tree
      // above are already per-piece (divided by this). Default 1.
      recipe_yield: Number(exists.rows[0]!.recipe_yield),
    });
  }),
);

// PATCH /api/products/:id/recipe-yield  — TZ-3.
//
// Set how many finished UNITS one full recipe produces. The cost roll-up and
// the requisition math divide qty_per_unit by this, so it is the manager's
// confirmation (or correction) of the AI yield estimate for a batch recipe.
// pm + production_manager only.
productsRouter.patch(
  '/:id/recipe-yield',
  authenticate,
  authorize('pm', 'production_manager'),
  asyncHandler(async (req, res) => {
    const productId = parseIdParam(req.params.id, 'id');
    const body = asObject(req.body);
    const yieldVal = requirePositiveNumber(body, 'recipe_yield');
    const { rows } = await query<{ recipe_yield: string }>(
      `UPDATE products SET recipe_yield = $2 WHERE id = $1 RETURNING recipe_yield`,
      [productId, yieldVal],
    );
    if (rows.length === 0) {
      throw AppError.notFound('Product not found.');
    }
    res
      .status(200)
      .json({ id: productId, recipe_yield: Number(rows[0]!.recipe_yield) });
  }),
);

// PATCH /api/products/:id/workshop  — assign / change the producing sex.
//
// Owner requirement: the boss assigns which production workshop (sex) makes a
// product, or clears it. Body `{ workshop_location_id: number | null }`:
//   - a number  → the target location MUST exist AND be a CANONICAL Poster
//                 workshop (type='production' AND poster_workshop_id IS NOT
//                 NULL — one of the 12). A legacy stock-bearing production row
//                 (poster_workshop_id IS NULL) is rejected with 422;
//   - null      → clear the assignment.
// Responds with the updated workshop in the SAME shape the list uses:
// `{ id, name } | null`. pm + production_manager only.
productsRouter.patch(
  '/:id/workshop',
  authenticate,
  authorize('pm', 'production_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const productId = parseIdParam(req.params.id, 'id');
    const body = asObject(req.body);

    // `workshop_location_id` is REQUIRED but may be `null` (clear) or a
    // positive integer id (assign). Anything else is a 422.
    const raw = body.workshop_location_id;
    let workshopId: number | null;
    if (raw === null) {
      workshopId = null;
    } else if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) {
      workshopId = raw;
    } else {
      throw AppError.validation(
        'Field "workshop_location_id" must be a positive integer id, or null to clear it.',
      );
    }

    // The product must exist.
    const target = await query<{ id: number }>('SELECT id FROM products WHERE id = $1', [
      productId,
    ]);
    if (target.rows[0] === undefined) {
      throw AppError.notFound('Product not found.');
    }

    // When assigning (non-null), the location must exist AND be a CANONICAL
    // Poster workshop: type='production' AND poster_workshop_id IS NOT NULL
    // (one of the 12). Reject a store / raw_warehouse / etc. — and ALSO a
    // legacy stock-bearing production row whose poster_workshop_id is NULL —
    // with a clear 422 before touching the row.
    if (workshopId !== null) {
      const loc = await query<{ type: string; poster_workshop_id: number | null }>(
        'SELECT type, poster_workshop_id FROM locations WHERE id = $1',
        [workshopId],
      );
      const locRow = loc.rows[0];
      if (
        locRow === undefined ||
        locRow.type !== 'production' ||
        locRow.poster_workshop_id === null
      ) {
        throw AppError.validation(
          'workshop_location_id must reference a Poster production workshop.',
        );
      }
    }

    // Update + RETURN the joined workshop {id,name}. The LEFT JOIN yields a
    // NULL name when workshop_location_id was cleared.
    const { rows } = await query<{ workshop_location_id: number | null; workshop_name: string | null }>(
      `UPDATE products p
          SET workshop_location_id = $2, updated_at = now()
         FROM (SELECT $1::bigint AS pid) ids
        WHERE p.id = ids.pid
      RETURNING p.workshop_location_id,
                (SELECT name FROM locations WHERE id = p.workshop_location_id) AS workshop_name`,
      [productId, workshopId],
    );
    const updated = rows[0];
    if (updated === undefined) {
      throw AppError.internal('Product disappeared after workshop assign.');
    }

    await writeAudit(poolRunner, {
      actorUserId: principal.userId,
      action: 'product.workshop.assign',
      entity: 'products',
      entityId: productId,
      payload: { workshop_location_id: workshopId },
    });

    const workshop =
      updated.workshop_location_id !== null && updated.workshop_name !== null
        ? { id: Number(updated.workshop_location_id), name: updated.workshop_name }
        : null;
    res.status(200).json({ id: productId, workshop });
  }),
);

// PATCH /api/products/:id/cost  — FEATURE A (editable MANUAL price).
//
// Pin a manual unit cost (so'm per unit) that OVERRIDES Poster's synced
// cost_per_unit everywhere (the cost roll-up reads COALESCE(manual, synced))
// and SURVIVES re-sync (seedSync only updates cost_per_unit when manual IS
// NULL). Body `{ cost_per_unit: number > 0 | null }` — `null` CLEARS the
// override, falling back to the Poster cost. pm + production_manager only.
productsRouter.patch(
  '/:id/cost',
  authenticate,
  authorize('pm', 'production_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const productId = parseIdParam(req.params.id, 'id');
    const body = asObject(req.body);

    // `cost_per_unit` is REQUIRED in the body but may be `null` (clear the
    // override) or a number strictly greater than zero (pin a price). A price
    // of exactly 0 is rejected — clearing is done with `null`, not 0.
    const raw = body.cost_per_unit;
    let manualCost: number | null;
    if (raw === null) {
      manualCost = null;
    } else if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
      manualCost = raw;
    } else {
      throw AppError.validation(
        'Field "cost_per_unit" must be a number greater than zero, or null to clear the override.',
      );
    }

    // Owner rule: ONLY raw (xom-ashyo) products have an editable price. A
    // semi/finished product's price is COMPUTED bottom-up from the recipe (BOM)
    // and is read-only — reject the edit before touching the row.
    const target = await query<{ type: string }>(
      'SELECT type FROM products WHERE id = $1',
      [productId],
    );
    const targetRow = target.rows[0];
    if (targetRow === undefined) {
      throw AppError.notFound('Product not found.');
    }
    if (targetRow.type !== 'raw') {
      throw AppError.conflict(
        'Only raw-material (xom-ashyo) prices can be edited; derived product prices are computed from the recipe.',
      );
    }

    const { rows } = await query<{
      manual_cost_per_unit: string | null;
      cost_per_unit: string | null;
    }>(
      `UPDATE products
          SET manual_cost_per_unit = $2
        WHERE id = $1
      RETURNING manual_cost_per_unit, cost_per_unit`,
      [productId, manualCost],
    );
    if (rows.length === 0) {
      throw AppError.notFound('Product not found.');
    }
    const updated = rows[0]!;

    await writeAudit(poolRunner, {
      actorUserId: principal.userId,
      action: 'product.cost.override',
      entity: 'products',
      entityId: productId,
      payload: { manual_cost_per_unit: manualCost },
    });

    res.status(200).json({
      id: productId,
      manual_cost_per_unit:
        updated.manual_cost_per_unit === null ? null : Number(updated.manual_cost_per_unit),
      cost_per_unit: updated.cost_per_unit === null ? null : Number(updated.cost_per_unit),
    });
  }),
);

// PATCH /api/products/:id/unit  — edit a product's unit of measure.
//
// Owner requirement (2026-06-06): the boss edits a product's unit (kg / l /
// pcs). The change lands in the ERP DB immediately AND a Poster write-back
// intent is enqueued (the live Poster token is read-only — see
// services/posterWriteback.ts; a future worker flushes the queue via
// menu.updateProduct).
//
// Same write-capable roles that manage products (mirror POST /): pm +
// raw_warehouse_manager. Body `{ unit: 'kg' | 'l' | 'pcs' }`.
//
// Behaviour:
//   - 404 when the product is missing;
//   - no-op (200, unchanged product, NO write-back) when unit is unchanged;
//   - otherwise UPDATE + audit in ONE transaction, then best-effort enqueue
//     the Poster write-back AFTER commit (a Poster failure must never break the
//     local update — invariant 1 of the outbox pattern).
productsRouter.patch(
  '/:id/unit',
  authenticate,
  authorize('pm', 'raw_warehouse_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const productId = parseIdParam(req.params.id, 'id');
    const body = asObject(req.body);
    const unit = requireEnum(body, 'unit', UNIT_TYPES);

    // Load the current product (full enriched shape, so the no-op path and the
    // success path both return the same Product the frontend expects).
    const current = await query<ProductRow>(`${PRODUCT_SELECT} WHERE p.id = $1`, [productId]);
    const existing = current.rows[0];
    if (existing === undefined) {
      throw AppError.notFound('Product not found.');
    }

    // No-op — unit unchanged. Return the product as-is, NO write-back enqueued.
    if (existing.unit === unit) {
      res.status(200).json({ product: enrich(existing) });
      return;
    }

    const previousUnit = existing.unit;

    // UPDATE + audit in ONE transaction (all-or-nothing).
    await withTransaction(async (tx) => {
      await tx.query('UPDATE products SET unit = $2, updated_at = now() WHERE id = $1', [
        productId,
        unit,
      ]);
      await writeAudit(tx, {
        actorUserId: principal.userId,
        action: 'product.unit.update',
        entity: 'products',
        entityId: productId,
        payload: {
          from: previousUnit,
          to: unit,
          actor: principal.userId,
          // Note when there is no Poster mapping (no write-back possible).
          poster_writeback: existing.poster_product_id !== null ? 'enqueued' : 'skipped',
        },
      });
    });

    // Best-effort Poster write-back AFTER commit — a failure here must NOT break
    // the local update, so swallow + log. Skipped automatically when the product
    // has no poster_product_id (nothing to push to the POS).
    try {
      await enqueueProductUnitWriteback({
        productId,
        posterProductId: existing.poster_product_id,
        field: 'unit',
        oldValue: previousUnit,
        newValue: unit,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[products] unit write-back enqueue failed (swallowed):', message);
    }

    // Re-read the full enriched product so the frontend gets a complete Product.
    const updated = await query<ProductRow>(`${PRODUCT_SELECT} WHERE p.id = $1`, [productId]);
    const row = updated.rows[0];
    if (row === undefined) {
      throw AppError.internal('Product disappeared after unit update.');
    }
    res.status(200).json({ product: enrich(row) });
  }),
);

// PATCH /api/products/:id/kpi-target  — KPI production-costing.
//
// Pin (or clear) the boss's MONTHLY SALES TARGET (so'm) for this product. The
// KPI screen compares actual revenue against it. Body
// `{ kpi_target: number >= 0 | null }` — `null` CLEARS the target. Gated the
// same way as the cost edit above: pm + production_manager.
productsRouter.patch(
  '/:id/kpi-target',
  authenticate,
  authorize('pm', 'production_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const productId = parseIdParam(req.params.id, 'id');
    const body = asObject(req.body);

    // `kpi_target` is REQUIRED but may be `null` (clear) or a finite number
    // >= 0 (a target of 0 is allowed; clearing is done with `null`).
    const raw = body.kpi_target;
    let target: number | null;
    if (raw === null) {
      target = null;
    } else if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
      target = raw;
    } else {
      throw AppError.validation(
        'Field "kpi_target" must be a number >= 0, or null to clear the target.',
      );
    }

    const { rows } = await query<{ kpi_target: string | null }>(
      `UPDATE products SET kpi_target = $2, updated_at = now()
        WHERE id = $1
      RETURNING kpi_target`,
      [productId, target],
    );
    if (rows.length === 0) {
      throw AppError.notFound('Product not found.');
    }

    await writeAudit(poolRunner, {
      actorUserId: principal.userId,
      action: 'product.kpi_target.set',
      entity: 'products',
      entityId: productId,
      payload: { kpi_target: target },
    });

    res.status(200).json({
      id: productId,
      kpi_target: rows[0]!.kpi_target === null ? null : Number(rows[0]!.kpi_target),
    });
  }),
);

// PATCH /api/products/:id/komunal  — KPI production-costing.
//
// Owner decision (2026-06-06): utilities ("komunal") are a PER-PRODUCT manual
// per-unit cost, NOT a shared monthly pool. Pin (or clear) the boss's per-unit
// utility cost (so'm per finished unit) for this product. The KPI screen folds
// it into full_cost. Body `{ komunal_per_unit: number >= 0 | null }` — `null`
// CLEARS it. Gated the same way as cost / kpi-target: pm + production_manager.
productsRouter.patch(
  '/:id/komunal',
  authenticate,
  authorize('pm', 'production_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const productId = parseIdParam(req.params.id, 'id');
    const body = asObject(req.body);

    // `komunal_per_unit` is REQUIRED but may be `null` (clear) or a finite
    // number >= 0 (a value of 0 is allowed; clearing is done with `null`).
    const raw = body.komunal_per_unit;
    let komunal: number | null;
    if (raw === null) {
      komunal = null;
    } else if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
      komunal = raw;
    } else {
      throw AppError.validation(
        'Field "komunal_per_unit" must be a number >= 0, or null to clear it.',
      );
    }

    const { rows } = await query<{ komunal_per_unit: string | null }>(
      `UPDATE products SET komunal_per_unit = $2, updated_at = now()
        WHERE id = $1
      RETURNING komunal_per_unit`,
      [productId, komunal],
    );
    if (rows.length === 0) {
      throw AppError.notFound('Product not found.');
    }

    await writeAudit(poolRunner, {
      actorUserId: principal.userId,
      action: 'product.komunal.set',
      entity: 'products',
      entityId: productId,
      payload: { komunal_per_unit: komunal },
    });

    res.status(200).json({
      id: productId,
      komunal_per_unit:
        rows[0]!.komunal_per_unit === null ? null : Number(rows[0]!.komunal_per_unit),
    });
  }),
);

/**
 * Reject a deep BOM cycle (AC2.2). Given the proposed direct components of
 * `productId`, walk the existing recipe graph from each component: if any
 * path reaches `productId`, adding it would close a cycle.
 *
 * Runs against a `TxClient` so the BFS, the DELETE and the INSERTs all live
 * inside ONE transaction — that is the only way to keep two concurrent
 * recipe writes from racing past each other's check and closing a cycle.
 */
async function assertNoBomCycle(
  client: TxClient,
  productId: number,
  componentIds: readonly number[],
): Promise<void> {
  // Components and the product itself are the starting forbidden set.
  for (const componentId of componentIds) {
    if (componentId === productId) {
      throw AppError.validation('A product cannot be a component of itself.');
    }
  }
  // BFS over the existing recipe graph from each proposed component.
  const visited = new Set<number>();
  const queue: number[] = [...componentIds];
  while (queue.length > 0) {
    const current = queue.shift() as number;
    if (current === productId) {
      throw AppError.validation('This BOM would create a cycle in the recipe graph.');
    }
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    const { rows } = await client.query<{ component_product_id: number }>(
      'SELECT component_product_id FROM recipes WHERE product_id = $1',
      [current],
    );
    for (const row of rows) {
      queue.push(Number(row.component_product_id));
    }
  }
}

// PUT /api/products/:id/recipe  — full replace of the BOM.
productsRouter.put(
  '/:id/recipe',
  authenticate,
  authorize('pm', 'production_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const productId = parseIdParam(req.params.id, 'id');
    const body = asObject(req.body);

    const rawItems = body.recipe;
    if (!Array.isArray(rawItems)) {
      throw AppError.validation('Field "recipe" must be an array.');
    }

    // Validate every line and collect (component_product_id, qty_per_unit).
    const items: { componentId: number; qtyPerUnit: number }[] = [];
    const seen = new Set<number>();
    for (const raw of rawItems) {
      const line = asObject(raw);
      const componentId = optionalId(line, 'component_product_id');
      if (componentId === undefined) {
        throw AppError.validation('Each recipe line needs a "component_product_id".');
      }
      const qtyPerUnit = requirePositiveNumber(line, 'qty_per_unit');
      if (componentId === productId) {
        throw AppError.validation('A product cannot be a component of itself.');
      }
      if (seen.has(componentId)) {
        throw AppError.validation(`Duplicate component_product_id ${componentId} in recipe.`);
      }
      seen.add(componentId);
      items.push({ componentId, qtyPerUnit });
    }

    // The product and all components must exist.
    const product = await query<{ id: number }>('SELECT id FROM products WHERE id = $1', [
      productId,
    ]);
    if (product.rows.length === 0) {
      throw AppError.notFound('Product not found.');
    }
    if (items.length > 0) {
      const ids = items.map((it) => it.componentId);
      const found = await query<{ id: number }>(
        'SELECT id FROM products WHERE id = ANY($1::bigint[])',
        [ids],
      );
      if (found.rows.length !== ids.length) {
        throw AppError.validation('One or more component_product_id values do not exist.');
      }
    }

    // Full replace inside one transaction: cycle check + delete old lines +
    // insert new + audit. AC2.2 — running the cycle BFS on the same client
    // as the writes is the only way to keep two concurrent recipe writes
    // from racing past each other's check and closing a cycle.
    const inserted = await withTransaction(async (tx) => {
      await assertNoBomCycle(
        tx,
        productId,
        items.map((it) => it.componentId),
      );
      await tx.query('DELETE FROM recipes WHERE product_id = $1', [productId]);
      const out: RecipeRow[] = [];
      for (const it of items) {
        const { rows } = await tx.query<RecipeRow>(
          `INSERT INTO recipes (product_id, component_product_id, qty_per_unit)
           VALUES ($1, $2, $3)
           RETURNING id, product_id, component_product_id, qty_per_unit`,
          [productId, it.componentId, it.qtyPerUnit],
        );
        const row = rows[0];
        if (row !== undefined) {
          out.push(row);
        }
      }
      await writeAudit(tx, {
        actorUserId: principal.userId,
        action: 'product.recipe.replace',
        entity: 'recipes',
        entityId: productId,
        payload: { component_count: items.length },
      });
      return out;
    });

    res.status(200).json({ product_id: productId, recipe: inserted });
  }),
);
