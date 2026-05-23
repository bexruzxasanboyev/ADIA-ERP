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
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
};

type RecipeRow = {
  id: number;
  product_id: number;
  component_product_id: number;
  qty_per_unit: number;
};

const PRODUCT_COLUMNS = `id, name, type, unit, sku, poster_ingredient_id,
  poster_product_id, is_active, created_at, updated_at`;

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
    const { rows } =
      typeRaw === undefined
        ? await query<ProductRow>(`SELECT ${PRODUCT_COLUMNS} FROM products ORDER BY id`)
        : await query<ProductRow>(
            `SELECT ${PRODUCT_COLUMNS} FROM products WHERE type = $1 ORDER BY id`,
            [typeRaw],
          );
    // List endpoints return a bare array (spec section 4) — no envelope.
    res.status(200).json(rows);
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

    const { rows } = await query<ProductRow>(
      `INSERT INTO products (name, type, unit, sku, poster_ingredient_id, poster_product_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${PRODUCT_COLUMNS}`,
      [name, type, unit, sku, posterIngredientId ?? null, posterProductId ?? null],
    );
    const created = rows[0];
    if (created === undefined) {
      throw AppError.internal('Product insert returned no row.');
    }
    await writeAudit(poolRunner, {
      actorUserId: principal.userId,
      action: 'product.create',
      entity: 'products',
      entityId: created.id,
      payload: { name, type },
    });
    res.status(201).json({ product: created });
  }),
);

// GET /api/products/:id/recipe
productsRouter.get(
  '/:id/recipe',
  authenticate,
  authorize('pm', 'production_manager'),
  asyncHandler(async (req, res) => {
    const productId = parseIdParam(req.params.id, 'id');
    const exists = await query<{ id: number }>('SELECT id FROM products WHERE id = $1', [
      productId,
    ]);
    if (exists.rows.length === 0) {
      throw AppError.notFound('Product not found.');
    }
    const { rows } = await query<RecipeRow>(
      `SELECT id, product_id, component_product_id, qty_per_unit
       FROM recipes WHERE product_id = $1 ORDER BY id`,
      [productId],
    );
    res.status(200).json({ product_id: productId, recipe: rows });
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
