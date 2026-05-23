/**
 * Initial seed/bootstrap from Poster (M7, spec section 4.9 — POST .../poster/sync).
 *
 * Each entity sync is idempotent: a second run UPDATEs the same rows by their
 * `poster_*` natural keys. We never DELETE — Poster is a single read-only
 * source, but operational decisions in ADIA (which storage is the central
 * warehouse, which user manages a store) live on the same `locations` row.
 *
 *   - syncSpots()       — Poster spots  -> locations(type='store')
 *   - syncStorages()    — Poster storages -> locations (default central_warehouse,
 *                         classification edited by PM in PATCH /api/locations/:id)
 *   - syncIngredients() — menu.getIngredients -> products(type='raw')
 *   - syncPrepacks()    — menu.getPrepacks    -> products(type='semi') + recipes
 *   - syncMenuProducts() — menu.getProducts + menu.getProduct -> products(type='finished') + recipes
 *
 * BOM import path is FULL (validated 2026-05-23 — see docs/adia-poster-api.md §8).
 *
 * The high-level `runSeedSync()` runs all five sequentially and reports a
 * per-entity result. The HTTP layer exposes optional `?entity=` filtering.
 */
import { query, withTransaction } from '../../db/index.js';
import { writeAudit } from '../../lib/audit.js';
import { PosterClient } from './client.js';
import {
  finishSyncRun,
  notifyPosterSyncFailed,
  redactUrl,
  startSyncRun,
  type SyncEntity,
  type SyncTrigger,
} from './syncLog.js';

export type SeedRunResult = {
  readonly entity: SyncEntity;
  readonly status: 'ok' | 'partial' | 'failed';
  readonly recordsIn: number;
  readonly recordsApplied: number;
  readonly errorDetail?: string;
};

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const UNIT_FROM_POSTER: Record<string, 'kg' | 'l' | 'pcs'> = {
  kg: 'kg',
  g: 'kg', // grams normalise to kg
  l: 'l',
  ml: 'l',
  p: 'pcs',
  pcs: 'pcs',
};

function normaliseUnit(raw: string | undefined): 'kg' | 'l' | 'pcs' {
  if (raw === undefined) return 'pcs';
  return UNIT_FROM_POSTER[raw.toLowerCase()] ?? 'pcs';
}

/**
 * Convert a Poster recipe quantity to a quantity in the component's unit:
 *   - structure_unit "g"  + ingredient_unit "kg" -> divide by 1000
 *   - structure_unit "ml" + ingredient_unit "l"  -> divide by 1000
 *   - same unit                                  -> as-is
 *
 * Anything else falls back to "as-is" — the import then writes a `recipes` row
 * the production-manager can correct in `PUT /api/products/:id/recipe`.
 */
function normaliseQty(
  structureUnit: string,
  ingredientUnit: string,
  raw: number | string,
): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const su = structureUnit.toLowerCase();
  const iu = ingredientUnit.toLowerCase();
  if (su === iu) return n;
  if ((su === 'g' && iu === 'kg') || (su === 'ml' && iu === 'l')) return n / 1000;
  if ((su === 'kg' && iu === 'g') || (su === 'l' && iu === 'ml')) return n * 1000;
  return n;
}

// -----------------------------------------------------------------------------
// Per-entity sync
// -----------------------------------------------------------------------------

/**
 * Insert/update one Poster spot into a `locations(type='store')` row. The PM
 * may later edit `name`, `parent_id`, `manager_user_id` via PATCH.
 */
async function upsertSpot(spotId: number, name: string): Promise<void> {
  await query(
    `INSERT INTO locations (name, type, poster_spot_id)
     VALUES ($1, 'store', $2)
     ON CONFLICT (poster_spot_id) WHERE poster_spot_id IS NOT NULL
     DO UPDATE SET name = EXCLUDED.name`,
    [name, spotId],
  );
}

/**
 * Insert/update one Poster storage. The owner classifies storage_id ->
 * location_type in spec section 8.2 (Shablon A); until then we default to
 * `central_warehouse`. Existing rows keep their type — only the name updates.
 */
async function upsertStorage(storageId: number, name: string): Promise<void> {
  await query(
    `INSERT INTO locations (name, type, poster_storage_id)
     VALUES ($1, 'central_warehouse', $2)
     ON CONFLICT (poster_storage_id) WHERE poster_storage_id IS NOT NULL
     DO UPDATE SET name = EXCLUDED.name`,
    [name, storageId],
  );
}

/**
 * Insert/update one Poster ingredient as a `products(type='raw')` row. Pure
 * raw materials carry only `poster_ingredient_id` (per ADR-0002 §1).
 */
async function upsertIngredient(
  posterIngredientId: number,
  name: string,
  unit: string,
): Promise<void> {
  await query(
    `INSERT INTO products (name, type, unit, poster_ingredient_id)
     VALUES ($1, 'raw', $2, $3)
     ON CONFLICT (poster_ingredient_id) WHERE poster_ingredient_id IS NOT NULL
     DO UPDATE SET name = EXCLUDED.name, unit = EXCLUDED.unit`,
    [name, normaliseUnit(unit), posterIngredientId],
  );
}

/**
 * Insert/update one Poster prepack (semi-finished — `type='semi'`). Prepacks
 * are stocked AND used as recipe components — both columns are filled
 * (`poster_product_id` for menu/sales sync, `poster_ingredient_id` for stock).
 */
async function upsertPrepack(
  posterProductId: number,
  posterIngredientId: number,
  name: string,
): Promise<number> {
  // C5 — `products` has TWO partial UNIQUE indexes on the Poster keys:
  // `uq_products_poster_product` on (poster_product_id) AND
  // `uq_products_poster_ingredient` on (poster_ingredient_id).
  // A plain `ON CONFLICT (poster_product_id)` does not catch a collision
  // on the ingredient_id key — which is the realistic case where the
  // prepack's component already exists as `type='raw'` with the same
  // `poster_ingredient_id` (e.g. type=1 ingredient list also contained
  // the prepack). Two-phase SELECT-then-INSERT/UPDATE handles both keys
  // without raising 23505 and without overwriting the wrong row.
  const existing = await query<{ id: number; type: string }>(
    `SELECT id, type FROM products
      WHERE poster_product_id = $1
         OR (poster_ingredient_id IS NOT NULL AND poster_ingredient_id = $2)
      ORDER BY (poster_product_id = $1) DESC, id ASC
      LIMIT 1`,
    [posterProductId, posterIngredientId],
  );
  const found = existing.rows[0];
  if (found !== undefined) {
    await query(
      `UPDATE products
          SET name = $1,
              poster_product_id = COALESCE(poster_product_id, $2),
              poster_ingredient_id = COALESCE(poster_ingredient_id, $3),
              type = CASE WHEN type = 'raw' THEN 'semi' ELSE type END
        WHERE id = $4`,
      [name, posterProductId, posterIngredientId, found.id],
    );
    return found.id;
  }
  const { rows } = await query<{ id: number }>(
    `INSERT INTO products (name, type, unit, poster_product_id, poster_ingredient_id)
     VALUES ($1, 'semi', 'kg', $2, $3)
     RETURNING id`,
    [name, posterProductId, posterIngredientId],
  );
  const id = rows[0]?.id;
  if (id === undefined) {
    throw new Error(`upsertPrepack: could not resolve id for poster_product_id=${posterProductId}`);
  }
  return id;
}

/**
 * Insert/update one Poster menu product (finished — `type='finished'`). Both
 * `poster_product_id` (sales) and `poster_ingredient_id` (stock) are filled
 * when the row is stocked (Poster type=2). Type=3 menu items are
 * not-directly-stocked — `poster_ingredient_id` may be NULL.
 */
async function upsertMenuProduct(
  posterProductId: number,
  posterIngredientId: number | null,
  name: string,
): Promise<number> {
  const { rows } = await query<{ id: number }>(
    `INSERT INTO products (name, type, unit, poster_product_id, poster_ingredient_id)
     VALUES ($1, 'finished', 'pcs', $2, $3)
     ON CONFLICT (poster_product_id) WHERE poster_product_id IS NOT NULL
     DO UPDATE SET name = EXCLUDED.name,
                   poster_ingredient_id = COALESCE(products.poster_ingredient_id, EXCLUDED.poster_ingredient_id)
     RETURNING id`,
    [name, posterProductId, posterIngredientId],
  );
  const id = rows[0]?.id;
  if (id !== undefined) return id;
  const { rows: r2 } = await query<{ id: number }>(
    `SELECT id FROM products WHERE poster_product_id = $1`,
    [posterProductId],
  );
  if (r2[0] === undefined) {
    throw new Error(`upsertMenuProduct: cannot resolve id for poster_product_id=${posterProductId}`);
  }
  return r2[0].id;
}

/**
 * Replace the BOM for `parentProductId` with `components`. The replace
 * happens in one transaction — partial BOMs are never visible.
 */
async function replaceRecipe(
  parentProductId: number,
  components: readonly { componentProductId: number; qtyPerUnit: number }[],
): Promise<number> {
  if (components.length === 0) return 0;
  return withTransaction(async (tx) => {
    await tx.query('DELETE FROM recipes WHERE product_id = $1', [parentProductId]);
    let applied = 0;
    for (const c of components) {
      if (c.componentProductId === parentProductId) continue; // chk_recipe_no_self
      if (c.qtyPerUnit <= 0) continue;
      try {
        await tx.query(
          `INSERT INTO recipes (product_id, component_product_id, qty_per_unit)
           VALUES ($1, $2, $3)
           ON CONFLICT (product_id, component_product_id) DO UPDATE
             SET qty_per_unit = EXCLUDED.qty_per_unit`,
          [parentProductId, c.componentProductId, c.qtyPerUnit],
        );
        applied += 1;
      } catch (err) {
        // A bad component (e.g. self-cycle) must not abort the rest — but the
        // service caller still gets a final count of how many landed.
        console.error('[poster] recipe row skipped:', redactUrl((err as Error).message));
      }
    }
    await writeAudit(tx, {
      actorUserId: null,
      action: 'poster.recipe.import',
      entity: 'recipes',
      entityId: parentProductId,
      payload: { components: applied },
    });
    return applied;
  });
}

// -----------------------------------------------------------------------------
// Public sync entry points — one per entity + a top-level `runSeedSync`.
// -----------------------------------------------------------------------------

export async function syncSpots(
  client: PosterClient,
  trigger: SyncTrigger = 'manual',
): Promise<SeedRunResult> {
  const runId = await startSyncRun('spots', trigger);
  try {
    const rows = await client.getSpots();
    let applied = 0;
    for (const r of rows) {
      const id = Number(r.spot_id);
      if (!Number.isInteger(id) || id <= 0) continue;
      const name = (r.spot_name ?? r.name ?? '').trim() || `Spot ${id}`;
      await upsertSpot(id, name);
      applied += 1;
    }
    await finishSyncRun(runId, 'ok', { recordsIn: rows.length, recordsApplied: applied });
    return { entity: 'spots', status: 'ok', recordsIn: rows.length, recordsApplied: applied };
  } catch (err) {
    const detail = redactUrl((err as Error).message);
    await finishSyncRun(runId, 'failed', { recordsIn: 0, recordsApplied: 0 }, detail);
    await notifyPosterSyncFailed('spots', detail);
    return { entity: 'spots', status: 'failed', recordsIn: 0, recordsApplied: 0, errorDetail: detail };
  }
}

export async function syncStorages(
  client: PosterClient,
  trigger: SyncTrigger = 'manual',
): Promise<SeedRunResult> {
  const runId = await startSyncRun('storages', trigger);
  try {
    const rows = await client.getStorages();
    let applied = 0;
    for (const r of rows) {
      const id = Number(r.storage_id);
      if (!Number.isInteger(id) || id <= 0) continue;
      const name = (r.storage_name ?? '').trim() || `Storage ${id}`;
      await upsertStorage(id, name);
      applied += 1;
    }
    await finishSyncRun(runId, 'ok', { recordsIn: rows.length, recordsApplied: applied });
    return { entity: 'storages', status: 'ok', recordsIn: rows.length, recordsApplied: applied };
  } catch (err) {
    const detail = redactUrl((err as Error).message);
    await finishSyncRun(runId, 'failed', { recordsIn: 0, recordsApplied: 0 }, detail);
    await notifyPosterSyncFailed('storages', detail);
    return { entity: 'storages', status: 'failed', recordsIn: 0, recordsApplied: 0, errorDetail: detail };
  }
}

export async function syncIngredients(
  client: PosterClient,
  trigger: SyncTrigger = 'manual',
): Promise<SeedRunResult> {
  const runId = await startSyncRun('ingredients', trigger);
  try {
    const rows = await client.getIngredients();
    let applied = 0;
    for (const r of rows) {
      const id = Number(r.ingredient_id);
      if (!Number.isInteger(id) || id <= 0) continue;
      // C5 — Poster `menu.getIngredients` returns BOTH raw ingredients
      // (`ingredients_type=1`) and semi-finished prepacks
      // (`ingredients_type=2`). Importing type=2 here as raw would later
      // collide with `syncPrepacks` on `(poster_ingredient_id)` (the
      // partial UNIQUE on `products.poster_ingredient_id`) AND mislabel
      // the row as raw. Skip non-type-1 rows — prepacks land via
      // `syncPrepacks` instead. Missing/undefined `ingredients_type`
      // defaults to 1 (the historical behaviour for older Poster fixtures).
      const ingType = r.ingredients_type === undefined ? 1 : Number(r.ingredients_type);
      if (Number.isFinite(ingType) && ingType !== 1) continue;
      const name = String(r.ingredient_name ?? '').trim() || `Ingredient ${id}`;
      const unit = String(r.ingredient_unit ?? 'p');
      await upsertIngredient(id, name, unit);
      applied += 1;
    }
    await finishSyncRun(runId, 'ok', { recordsIn: rows.length, recordsApplied: applied });
    return { entity: 'ingredients', status: 'ok', recordsIn: rows.length, recordsApplied: applied };
  } catch (err) {
    const detail = redactUrl((err as Error).message);
    await finishSyncRun(runId, 'failed', { recordsIn: 0, recordsApplied: 0 }, detail);
    await notifyPosterSyncFailed('ingredients', detail);
    return { entity: 'ingredients', status: 'failed', recordsIn: 0, recordsApplied: 0, errorDetail: detail };
  }
}

/**
 * Sync menu products + their per-product BOMs.
 *
 * Two-phase:
 *   1. upsert every product (type=2 and type=3) so their ids exist;
 *   2. for type=2 products with `ingredient_id`, fetch `menu.getProduct` and
 *      write `recipes` — this is the BOM import path validated 2026-05-23.
 *
 * Type=3 products (e.g. plate/portion variants) carry no top-level BOM and
 * are left without recipes — PM can add them via `PUT /api/products/:id/recipe`.
 */
export async function syncMenuProducts(
  client: PosterClient,
  trigger: SyncTrigger = 'manual',
): Promise<SeedRunResult> {
  const runId = await startSyncRun('products', trigger);
  let applied = 0;
  let total = 0;
  try {
    const list = await client.getProducts();
    total = list.length;
    // Phase 1: upsert each product row.
    const idMap = new Map<number, number>(); // poster_product_id -> ADIA id
    for (const p of list) {
      const ppid = Number(p.product_id);
      if (!Number.isInteger(ppid) || ppid <= 0) continue;
      const pingId = p.ingredient_id !== undefined ? Number(p.ingredient_id) : null;
      const adiaId = await upsertMenuProduct(
        ppid,
        pingId !== null && Number.isInteger(pingId) && pingId > 0 ? pingId : null,
        String(p.product_name ?? '').trim() || `Product ${ppid}`,
      );
      idMap.set(ppid, adiaId);
      applied += 1;
    }
    // Phase 2: BOM import for type=2 products only.
    for (const p of list) {
      if (p.type !== '2') continue;
      const ppid = Number(p.product_id);
      const parentId = idMap.get(ppid);
      if (parentId === undefined) continue;
      const full = await client.getProduct(ppid);
      if (full === null || !Array.isArray(full.ingredients) || full.ingredients.length === 0) {
        continue;
      }
      const components = await resolveBomComponents(full.ingredients);
      await replaceRecipe(parentId, components);
    }
    await finishSyncRun(runId, 'ok', { recordsIn: total, recordsApplied: applied });
    return { entity: 'products', status: 'ok', recordsIn: total, recordsApplied: applied };
  } catch (err) {
    const detail = redactUrl((err as Error).message);
    await finishSyncRun(runId, 'partial', { recordsIn: total, recordsApplied: applied }, detail);
    await notifyPosterSyncFailed('products', detail);
    return {
      entity: 'products',
      status: 'partial',
      recordsIn: total,
      recordsApplied: applied,
      errorDetail: detail,
    };
  }
}

/** Sync prepacks (semi-finished products) + their BOMs. */
export async function syncPrepacks(
  client: PosterClient,
  trigger: SyncTrigger = 'manual',
): Promise<SeedRunResult> {
  const runId = await startSyncRun('products', trigger);
  let applied = 0;
  let total = 0;
  try {
    const list = await client.getPrepacks();
    total = list.length;
    for (const p of list) {
      const ppid = Number(p.product_id);
      const ping = Number(p.ingredient_id);
      if (!Number.isInteger(ppid) || ppid <= 0) continue;
      if (!Number.isInteger(ping) || ping <= 0) continue;
      const parentId = await upsertPrepack(
        ppid,
        ping,
        String(p.product_name ?? '').trim() || `Prepack ${ppid}`,
      );
      const out = Number(p.out);
      const yieldQty = Number.isFinite(out) && out > 0 ? out : 1;
      // structure_brutto already in `structure_unit`; convert to component
      // `ingredient_unit`, then normalise by `out` so qty_per_unit is "per 1
      // produced unit" not "per batch".
      const components: { componentProductId: number; qtyPerUnit: number }[] = [];
      for (const ing of p.ingredients ?? []) {
        const compPing = Number(ing.ingredient_id);
        if (!Number.isInteger(compPing) || compPing <= 0) continue;
        const compRow = await query<{ id: number }>(
          `SELECT id FROM products WHERE poster_ingredient_id = $1`,
          [compPing],
        );
        const compId = compRow.rows[0]?.id;
        if (compId === undefined) continue; // ingredient not yet seeded — skip
        const qtyConverted = normaliseQty(
          String(ing.structure_unit ?? ''),
          String(ing.ingredient_unit ?? ''),
          ing.structure_brutto,
        );
        const perUnit = qtyConverted / yieldQty;
        if (perUnit > 0) {
          components.push({ componentProductId: compId, qtyPerUnit: perUnit });
        }
      }
      await replaceRecipe(parentId, components);
      applied += 1;
    }
    await finishSyncRun(runId, 'ok', { recordsIn: total, recordsApplied: applied });
    return { entity: 'products', status: 'ok', recordsIn: total, recordsApplied: applied };
  } catch (err) {
    const detail = redactUrl((err as Error).message);
    await finishSyncRun(runId, 'partial', { recordsIn: total, recordsApplied: applied }, detail);
    await notifyPosterSyncFailed('products', detail);
    return {
      entity: 'products',
      status: 'partial',
      recordsIn: total,
      recordsApplied: applied,
      errorDetail: detail,
    };
  }
}

/**
 * Resolve a Poster `ingredients` array to ADIA component product ids +
 * normalised qty. Components that are not yet seeded are silently skipped —
 * the next seed run picks them up.
 */
async function resolveBomComponents(
  rows: readonly {
    ingredient_id: string;
    structure_unit: string;
    ingredient_unit: string;
    structure_brutto: number | string;
  }[],
): Promise<{ componentProductId: number; qtyPerUnit: number }[]> {
  const out: { componentProductId: number; qtyPerUnit: number }[] = [];
  for (const ing of rows) {
    const ping = Number(ing.ingredient_id);
    if (!Number.isInteger(ping) || ping <= 0) continue;
    const r = await query<{ id: number }>(
      `SELECT id FROM products WHERE poster_ingredient_id = $1`,
      [ping],
    );
    const id = r.rows[0]?.id;
    if (id === undefined) continue;
    const qty = normaliseQty(
      String(ing.structure_unit ?? ''),
      String(ing.ingredient_unit ?? ''),
      ing.structure_brutto,
    );
    if (qty > 0) out.push({ componentProductId: id, qtyPerUnit: qty });
  }
  return out;
}

// -----------------------------------------------------------------------------
// Top-level orchestrator
// -----------------------------------------------------------------------------

export type SeedSelector = 'all' | 'locations' | 'products';

/**
 * Run the seed sync. Ordering matters — products that reference ingredients
 * via BOM cannot be linked before the ingredient rows exist.
 *
 *   locations: spots + storages
 *   products: ingredients -> prepacks -> menu products
 */
export async function runSeedSync(
  client: PosterClient,
  selector: SeedSelector = 'all',
): Promise<SeedRunResult[]> {
  const results: SeedRunResult[] = [];
  if (selector === 'all' || selector === 'locations') {
    results.push(await syncSpots(client, 'manual'));
    results.push(await syncStorages(client, 'manual'));
  }
  if (selector === 'all' || selector === 'products') {
    results.push(await syncIngredients(client, 'manual'));
    results.push(await syncPrepacks(client, 'manual'));
    results.push(await syncMenuProducts(client, 'manual'));
  }
  return results;
}
