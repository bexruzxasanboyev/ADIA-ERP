/**
 * Initial seed/bootstrap from Poster (M7, spec section 4.9 — POST .../poster/sync).
 *
 * Each entity sync is idempotent: a second run UPDATEs the same rows by their
 * `poster_*` natural keys. We never DELETE — Poster is a single read-only
 * source, but operational decisions in ADIA (which storage is the central
 * warehouse, which user manages a store) live on the same `locations` row.
 *
 *   - syncCategories()  — menu.getCategories -> categories (kind='menu')
 *   - syncIngredientCategories() — menu.getCategoriesIngredients -> categories (kind='ingredient')
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
import { recordImportWarning } from '../../services/importWarnings.js';
import { PosterClient } from './client.js';
import {
  STORAGE_TYPE_BY_ID,
  STORE_BACKING_STORAGE,
  DEFAULT_STORAGE_TYPE,
  matchSexStorageToDept,
  type DeptCandidate,
} from './storageClassification.js';
import {
  isProductionWorkshop,
  normalizeMatchName,
} from './workshopClassification.js';
import { hasReadyPrefix } from '../../lib/productCategory.js';
import {
  finishSyncRun,
  notifyPosterSyncFailed,
  redactUrl,
  startSyncRun,
  type SyncEntity,
  type SyncTrigger,
} from './syncLog.js';

/** Which Poster category namespace a `categories` row belongs to (migration 0038). */
type CategoryKind = 'menu' | 'ingredient';

export type SeedRunResult = {
  readonly entity: SyncEntity;
  readonly status: 'ok' | 'partial' | 'failed';
  readonly recordsIn: number;
  readonly recordsApplied: number;
  readonly errorDetail?: string;
};

/**
 * One resolved BOM line ready to write to `recipes`.
 *   - `qtyPerUnit` — DERIVED component qty (in the component's unit) per ONE
 *     unit of the parent product's output (kg/l/pcs); drives cost + production.
 *   - `brutto` / `netto` — RAW Poster figures in the line's `structure_unit`,
 *     carried for Poster-style display (NULL when unknown — e.g. a modification
 *     link that has no per-line composition figures).
 */
type BomComponent = {
  componentProductId: number;
  qtyPerUnit: number;
  brutto?: number | null;
  netto?: number | null;
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

/**
 * Normalise a prepack's `out` (batch yield) to the prepack's OWN product unit
 * (`kg` / `l` / `pcs`) so it can be used as the per-unit divisor consistently
 * with the normalised brutto.
 *
 * Poster reports `out` in the structure BASE unit of the prepack's lines — for
 * weight prepacks that is GRAMS (e.g. ЦЕЛЫЙ out=1000 = 1 kg), for volume it is
 * MILLILITRES, for count it is PIECES. The prepack is stored as `kg` (count
 * prepacks are the rare exception). We pick the dominant line `structure_unit`
 * as `out`'s unit and convert g->kg / ml->l (÷1000); pcs/unknown pass through.
 *
 * THE BUG THIS FIXES (2026-05-30): the old code divided a brutto already
 * normalised to kg by a raw `out` still in grams, making every qty_per_unit
 * ~1000× too small (НАПОЛЕОН ун 0.31 kg/kg landed as 0.0003 -> rounded to 0).
 */
/** Parse a Poster numeric field to a non-negative number, or null. */
function numOrNull(raw: number | string | undefined | null): number | null {
  if (raw === undefined || raw === null) return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function normaliseOut(outStructureUnit: string, raw: number | string): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const su = outStructureUnit.toLowerCase();
  if (su === 'g' || su === 'ml') return n / 1000;
  return n;
}

/**
 * The structure_unit that a prepack's `out` is denominated in — the most
 * common `structure_unit` across its lines (weight `g`, volume `ml`, or count
 * `p`/`pcs`). `out` is a single batch yield in this base unit, so the dominant
 * line unit identifies it. Defaults to `g` (the overwhelming Poster majority).
 */
function dominantStructureUnit(
  rows: readonly { structure_unit?: string }[],
): string {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const su = String(r.structure_unit ?? '').toLowerCase();
    if (su === '') continue;
    counts.set(su, (counts.get(su) ?? 0) + 1);
  }
  let best = 'g';
  let bestN = 0;
  for (const [su, n] of counts) {
    if (n > bestN) {
      best = su;
      bestN = n;
    }
  }
  return best;
}

/** 1 so'm = 100 tiyin — Poster `structure_selfprice`/`cost` are in tiyin. */
const TIYIN_PER_SOM = 100;

/**
 * Derive a RAW ingredient's unit cost (so'm per the component's
 * `ingredient_unit`) from a Poster composition line. Poster gives
 * `structure_selfprice` = the line's Себестоимость in TIYIN for its
 * `structure_brutto` quantity (in `structure_unit`). Verified live
 * 2026-05-30 the value is stable across every prepack that uses the same raw
 * (e.g. ун = 750_058 tiyin/kg everywhere) — so any one line yields the unit
 * cost. We normalise the brutto to the ingredient's own unit, then divide:
 *
 *   unit_cost_som = (selfprice_tiyin / brutto_in_ingredient_unit) / 100
 *
 * Returns null when the line carries no usable selfprice/brutto.
 */
function rawUnitCostFromLine(line: {
  structure_unit: string;
  ingredient_unit: string;
  structure_brutto: number | string;
  structure_selfprice?: number | string;
}): number | null {
  if (line.structure_selfprice === undefined || line.structure_selfprice === null) return null;
  const selfprice =
    typeof line.structure_selfprice === 'number'
      ? line.structure_selfprice
      : Number(line.structure_selfprice);
  if (!Number.isFinite(selfprice) || selfprice < 0) return null;
  const bruttoInUnit = normaliseQty(
    String(line.structure_unit ?? ''),
    String(line.ingredient_unit ?? ''),
    line.structure_brutto,
  );
  if (!(bruttoInUnit > 0)) return null;
  const unitCostSom = selfprice / bruttoInUnit / TIYIN_PER_SOM;
  return Number.isFinite(unitCostSom) && unitCostSom >= 0 ? unitCostSom : null;
}

/**
 * Set/refresh a RAW product's `cost_per_unit` (so'm per unit). Keyed by the
 * raw ingredient's `poster_ingredient_id`. A no-op when no raw row matches
 * (the ingredient is not yet seeded). Idempotent — a re-run overwrites with
 * the freshest derived value.
 *
 * FEATURE A — when a MANUAL price is pinned (`manual_cost_per_unit IS NOT
 * NULL`) the sync MUST NOT touch the cost: the manager's price wins and must
 * survive re-sync. The `AND manual_cost_per_unit IS NULL` guard leaves those
 * rows untouched (the effective cost is COALESCE(manual, synced) at read time).
 */
async function setRawIngredientCost(
  posterIngredientId: number,
  costPerUnit: number,
): Promise<void> {
  await query(
    `UPDATE products
        SET cost_per_unit = $2
      WHERE poster_ingredient_id = $1 AND type = 'raw'
        AND manual_cost_per_unit IS NULL`,
    [posterIngredientId, costPerUnit],
  );
}

/**
 * Resolve ONE Poster composition line to an ADIA component product id.
 * structure_type drives the lookup column (the bug this fixes — every line
 * was resolved by `poster_ingredient_id` only, silently dropping prepack
 * children):
 *   - type 1 -> RAW: products.poster_ingredient_id = line.ingredient_id;
 *   - type 2 -> PREPACK (semi): products.poster_product_id = line.ingredient_id.
 * Returns the local id, or null when the component is not yet seeded.
 */
async function resolveComponentId(
  posterId: number,
  structureType: number,
): Promise<number | null> {
  const column = structureType === 2 ? 'poster_product_id' : 'poster_ingredient_id';
  const r = await query<{ id: number }>(
    `SELECT id FROM products WHERE ${column} = $1`,
    [posterId],
  );
  return r.rows[0]?.id ?? null;
}

// -----------------------------------------------------------------------------
// Per-entity sync
// -----------------------------------------------------------------------------

/**
 * Insert/update one Poster spot into a `locations(type='store')` row. The PM
 * may later edit `name`, `parent_id`, `manager_user_id` via PATCH.
 *
 * The ON CONFLICT clause updates ONLY the name — never `poster_storage_id`.
 * A store-backing storage merged onto this row (ADR-0017 §4, `upsertStorage`)
 * must survive a re-run of the spot sync.
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
 * Insert/update one Poster storage (ADR-0017).
 *
 *   - Store-backing storages (3/4/5) are NOT inserted as standalone
 *     locations. Their `poster_storage_id` is merged onto the matching POS
 *     spot row (P2, ADR §4) so sales + stock land on one store location.
 *   - Every other storage is inserted at its ADR §3 classified type, with
 *     `sex_storage` as the safe default for any unknown id.
 *
 * Insert-time classification only: ON CONFLICT DO UPDATE rotates ONLY the
 * `name`, NEVER the `type` — a PM's manual reclassification (PATCH
 * /api/locations/:id) must not be reverted by a later sync.
 */
async function upsertStorage(storageId: number, name: string): Promise<void> {
  const backingSpotId = STORE_BACKING_STORAGE[storageId];
  if (backingSpotId !== undefined) {
    await mergeStorageIntoSpot(storageId, backingSpotId);
    return;
  }
  const type = STORAGE_TYPE_BY_ID[storageId] ?? DEFAULT_STORAGE_TYPE;
  await query(
    `INSERT INTO locations (name, type, poster_storage_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (poster_storage_id) WHERE poster_storage_id IS NOT NULL
     DO UPDATE SET name = EXCLUDED.name`,
    [name, type, storageId],
  );
}

/**
 * P2 merge (ADR-0017 §4): attach a store-backing `storage_id` to its POS
 * spot location so that sales (`poster_spot_id`) and stock
 * (`poster_storage_id`) resolve to the SAME store row.
 *
 * The UPDATE is gated so it:
 *   - only runs when the spot row exists and does not already carry the id
 *     (idempotent re-run = no-op);
 *   - never steals a storage id already owned by another spot row
 *     (preserves uq_locations_poster_storage).
 *
 * If the spot row does not exist yet (storage synced before its spot) the
 * merge is a no-op — the next sync, with the spot present, completes it.
 */
async function mergeStorageIntoSpot(storageId: number, spotId: number): Promise<void> {
  await query(
    `UPDATE locations AS spot
        SET poster_storage_id = $1, updated_at = now()
      WHERE spot.poster_spot_id = $2
        AND spot.type = 'store'
        AND spot.poster_storage_id IS DISTINCT FROM $1
        AND NOT EXISTS (
          SELECT 1 FROM locations other
           WHERE other.poster_storage_id = $1
             AND other.id <> spot.id
        )`,
    [storageId, spotId],
  );
}

// -----------------------------------------------------------------------------
// sex_storage -> production-department attach (conservative, reversible).
// -----------------------------------------------------------------------------

/** One row of the proposed/applied sex_storage -> department attach plan. */
export type AttachPlanRow = {
  readonly storageId: number;
  readonly storageName: string;
  readonly currentParentId: number | null;
  /** The matched department id, or null when no confident match exists. */
  readonly matchedDeptId: number | null;
  readonly matchedDeptName: string | null;
  /** The normalised token that produced the match (audit trail). */
  readonly matchedToken: string | null;
  /** What the run did with this row. */
  readonly action: 'set' | 'already' | 'unmatched' | 'skipped-has-parent';
};

export type AttachResult = {
  readonly applied: number;
  readonly rows: readonly AttachPlanRow[];
};

/**
 * Attach each `sex_storage` location to its matching `production` department by
 * a CONSERVATIVE name heuristic (`matchSexStorageToDept`).
 *
 * Conservative + reversible by design:
 *   - only the `parent_id` column is touched — never `type`, never
 *     `manager_user_id`, never the row itself (no delete/recreate);
 *   - a sex_storage that ALREADY has a parent is left untouched UNLESS
 *     `reparentExisting` is true (default false) — we never silently override a
 *     parent a human set;
 *   - an unmatched sex_storage is left unparented and reported, never guessed;
 *   - idempotent: a re-run that finds the parent already correct is a no-op
 *     (`action: 'already'`).
 *
 * The whole attach runs in ONE transaction with a single audit-log entry so a
 * partial attach is never visible. When `dryRun` is true the plan is built and
 * returned but nothing is written (used by the diagnostic / report path).
 */
export async function attachSexStoragesToDepts(
  opts: { dryRun?: boolean; reparentExisting?: boolean } = {},
): Promise<AttachResult> {
  const dryRun = opts.dryRun ?? false;
  const reparentExisting = opts.reparentExisting ?? false;

  // Load the production departments (match candidates) and the sex_storage rows.
  const { rows: depts } = await query<{ id: number; name: string }>(
    `SELECT id, name FROM locations WHERE type = 'production' ORDER BY id`,
  );
  const deptCandidates: DeptCandidate[] = depts.map((d) => ({ id: d.id, name: d.name }));

  const { rows: storages } = await query<{
    id: number;
    name: string;
    parent_id: number | null;
  }>(
    `SELECT id, name, parent_id FROM locations WHERE type = 'sex_storage' ORDER BY id`,
  );

  const validDeptIds = new Set(deptCandidates.map((d) => d.id));

  const plan: AttachPlanRow[] = storages.map((s) => {
    const match = matchSexStorageToDept(s.name, deptCandidates);
    if (match === null) {
      return {
        storageId: s.id,
        storageName: s.name,
        currentParentId: s.parent_id,
        matchedDeptId: null,
        matchedDeptName: null,
        matchedToken: null,
        action: 'unmatched',
      };
    }
    // A self-parent would violate the chain hierarchy — guard it (cannot happen
    // here since depts and sex_storages are distinct types, but be defensive).
    if (match.deptId === s.id || !validDeptIds.has(match.deptId)) {
      return {
        storageId: s.id,
        storageName: s.name,
        currentParentId: s.parent_id,
        matchedDeptId: null,
        matchedDeptName: null,
        matchedToken: null,
        action: 'unmatched',
      };
    }
    if (s.parent_id === match.deptId) {
      return {
        storageId: s.id,
        storageName: s.name,
        currentParentId: s.parent_id,
        matchedDeptId: match.deptId,
        matchedDeptName: match.deptName,
        matchedToken: match.matchedToken,
        action: 'already',
      };
    }
    if (s.parent_id !== null && !reparentExisting) {
      return {
        storageId: s.id,
        storageName: s.name,
        currentParentId: s.parent_id,
        matchedDeptId: match.deptId,
        matchedDeptName: match.deptName,
        matchedToken: match.matchedToken,
        action: 'skipped-has-parent',
      };
    }
    return {
      storageId: s.id,
      storageName: s.name,
      currentParentId: s.parent_id,
      matchedDeptId: match.deptId,
      matchedDeptName: match.deptName,
      matchedToken: match.matchedToken,
      action: 'set',
    };
  });

  const toSet = plan.filter((p) => p.action === 'set');
  if (dryRun || toSet.length === 0) {
    return { applied: 0, rows: plan };
  }

  await withTransaction(async (tx) => {
    for (const row of toSet) {
      // parent_id only — type and manager_user_id are NOT touched.
      await tx.query(
        `UPDATE locations SET parent_id = $2, updated_at = now()
          WHERE id = $1 AND type = 'sex_storage'`,
        [row.storageId, row.matchedDeptId],
      );
    }
    await writeAudit(tx, {
      actorUserId: null,
      action: 'poster.sex_storage.attach',
      entity: 'locations',
      entityId: null,
      payload: {
        attached: toSet.map((r) => ({
          storage_id: r.storageId,
          storage_name: r.storageName,
          previous_parent_id: r.currentParentId,
          new_parent_id: r.matchedDeptId,
          matched_dept_name: r.matchedDeptName,
          matched_token: r.matchedToken,
        })),
      },
    });
  });

  return { applied: toSet.length, rows: plan };
}

/**
 * Insert/update one Poster production workshop (Цех) as a
 * `locations(type='production', poster_workshop_id=…)` row. Returns the local
 * `locations.id`.
 *
 * Idempotency (per the owner spec — match on poster_workshop_id, fall back to
 * name so we never duplicate an already-seeded production department):
 *   1. a row already carrying this `poster_workshop_id` -> UPDATE its name;
 *   2. else a `type='production'` row with the SAME name but no workshop link
 *      (e.g. a `create-production-sexes` department) -> ADOPT it by stamping
 *      `poster_workshop_id` (claim only when that id is free elsewhere);
 *   3. else INSERT a fresh production location.
 *
 * `type` and `manager_user_id` of an adopted row are left untouched.
 */
async function upsertWorkshop(workshopId: number, name: string): Promise<number> {
  const byId = await query<{ id: number }>(
    `UPDATE locations SET name = $2, updated_at = now()
      WHERE poster_workshop_id = $1
      RETURNING id`,
    [workshopId, name],
  );
  if (byId.rows[0] !== undefined) return byId.rows[0].id;

  // Adopt a same-named production dept that has no workshop link yet — but only
  // when this workshop id is not already owned by another row (uq guard).
  const adopt = await query<{ id: number }>(
    `UPDATE locations AS l SET poster_workshop_id = $1, updated_at = now()
      WHERE l.type = 'production'
        AND l.name = $2
        AND l.poster_workshop_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM locations o WHERE o.poster_workshop_id = $1
        )
      RETURNING l.id`,
    [workshopId, name],
  );
  if (adopt.rows[0] !== undefined) return adopt.rows[0].id;

  const ins = await query<{ id: number }>(
    `INSERT INTO locations (name, type, poster_workshop_id, is_active)
     VALUES ($1, 'production', $2, TRUE)
     ON CONFLICT (poster_workshop_id) WHERE poster_workshop_id IS NOT NULL
       DO UPDATE SET name = EXCLUDED.name, updated_at = now()
     RETURNING id`,
    [name, workshopId],
  );
  const id = ins.rows[0]?.id;
  if (id !== undefined) return id;
  // ON CONFLICT fired without RETURNING — resolve via SELECT.
  const sel = await query<{ id: number }>(
    `SELECT id FROM locations WHERE poster_workshop_id = $1`,
    [workshopId],
  );
  if (sel.rows[0] === undefined) {
    throw new Error(`upsertWorkshop: cannot resolve id for workshop_id=${workshopId}`);
  }
  return sel.rows[0].id;
}

/**
 * Insert/update one Poster category into the `categories` lookup, keyed by its
 * natural `poster_category_id`. Returns the local `categories.id`. Idempotent:
 * a re-run UPDATEs the name (Poster may rename a category). RETURNING on the
 * INSERT path is empty when ON CONFLICT fires, so we fall back to a SELECT.
 */
async function upsertCategory(
  posterCategoryId: number,
  name: string,
  kind: CategoryKind = 'menu',
): Promise<number> {
  const { rows } = await query<{ id: number }>(
    `INSERT INTO categories (kind, poster_category_id, name)
     VALUES ($1, $2, $3)
     ON CONFLICT (kind, poster_category_id)
       DO UPDATE SET name = EXCLUDED.name, updated_at = now()
     RETURNING id`,
    [kind, posterCategoryId, name],
  );
  const id = rows[0]?.id;
  if (id !== undefined) return id;
  const { rows: r2 } = await query<{ id: number }>(
    `SELECT id FROM categories WHERE kind = $1 AND poster_category_id = $2`,
    [kind, posterCategoryId],
  );
  if (r2[0] === undefined) {
    throw new Error(
      `upsertCategory: cannot resolve id for kind=${kind} poster_category_id=${posterCategoryId}`,
    );
  }
  return r2[0].id;
}

/**
 * Build the `poster_category_id -> categories.id` lookup map from the rows
 * already in the `categories` table. Used by `syncMenuProducts` to map each
 * product's `menu_category_id` to a local FK without an extra round-trip per
 * product. `syncCategories` MUST have run first (the seed orchestrator
 * guarantees this ordering).
 */
async function loadCategoryMap(kind: CategoryKind = 'menu'): Promise<Map<number, number>> {
  // Scope to one kind — the 'menu' and 'ingredient' namespaces share numeric
  // poster_category_id values (e.g. both have id=4), so an unscoped map would
  // collide and assign the wrong category.
  const { rows } = await query<{ id: number; poster_category_id: number }>(
    `SELECT id, poster_category_id FROM categories WHERE kind = $1`,
    [kind],
  );
  const map = new Map<number, number>();
  for (const r of rows) map.set(Number(r.poster_category_id), Number(r.id));
  return map;
}

/**
 * Insert/update one Poster ingredient as a `products(type='raw')` row. Pure
 * raw materials carry only `poster_ingredient_id` (per ADR-0002 §1).
 */
async function upsertIngredient(
  posterIngredientId: number,
  name: string,
  unit: string,
  categoryId: number | null,
): Promise<void> {
  // category_id is the local FK into an 'ingredient'-kind `categories` row
  // (migration 0038), resolved from the Poster ingredient's `category_id` via
  // the ingredient-category map. On a re-run we always refresh it (EXCLUDED) so
  // a re-categorisation in Poster propagates; a NULL incoming value clears it.
  await query(
    `INSERT INTO products (name, type, unit, poster_ingredient_id, category_id)
     VALUES ($1, 'raw', $2, $3, $4)
     ON CONFLICT (poster_ingredient_id) WHERE poster_ingredient_id IS NOT NULL
     DO UPDATE SET name = EXCLUDED.name, unit = EXCLUDED.unit,
                   category_id = EXCLUDED.category_id`,
    [name, normaliseUnit(unit), posterIngredientId, categoryId],
  );
}

/**
 * Insert/update one Poster prepack. `productType` is decided by the caller from
 * the prepack name (2026-06-08 owner rework):
 *   - `Г/П…` ready-prefixed prepacks  -> `finished` (Tayyor mahsulot);
 *   - everything else                  -> `semi` (Yarim tayyor).
 *
 * Prepacks are stocked AND used as recipe components — both Poster columns are
 * filled (`poster_product_id` for menu/sales sync, `poster_ingredient_id` for
 * stock). On a re-run the type is refreshed to `productType` so a renamed
 * prepack (Г/П added/removed) re-classifies — but a `raw` row (an ingredient
 * that collided on poster_ingredient_id) is NEVER demoted by this path.
 */
async function upsertPrepack(
  posterProductId: number,
  posterIngredientId: number | null,
  name: string,
  productType: 'semi' | 'finished',
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
    // type: a `raw` collision (the prepack's ingredient_id also exists as a raw
    // ingredient) is promoted to the prepack's `productType`; an existing
    // semi/finished prepack is REFRESHED to `productType` so a Г/П rename
    // re-classifies it (semi<->finished) on re-sync.
    await query(
      `UPDATE products
          SET name = $1,
              poster_product_id = COALESCE(poster_product_id, $2),
              poster_ingredient_id = COALESCE(poster_ingredient_id, $3),
              type = $5
        WHERE id = $4`,
      [name, posterProductId, posterIngredientId, found.id, productType],
    );
    return found.id;
  }
  const { rows } = await query<{ id: number }>(
    `INSERT INTO products (name, type, unit, poster_product_id, poster_ingredient_id)
     VALUES ($1, $4, 'kg', $2, $3)
     RETURNING id`,
    [name, posterProductId, posterIngredientId, productType],
  );
  const id = rows[0]?.id;
  if (id === undefined) {
    throw new Error(`upsertPrepack: could not resolve id for poster_product_id=${posterProductId}`);
  }
  return id;
}

/**
 * Replace the BOM for `parentProductId` with `components`. The replace
 * happens in one transaction — partial BOMs are never visible.
 *
 * I9 (Sprint 3 audit): the inner per-row `try/catch` previously swallowed
 * the error message but LEFT the transaction in an aborted state. Once one
 * INSERT raised (e.g. 23505 / CHECK violation), every subsequent INSERT
 * inside the same tx failed with "current transaction is aborted, commands
 * ignored until end of transaction block" — so a single bad row sank the
 * whole recipe AND the per-prepack caller. The fix is a SAVEPOINT per row:
 * each row is its own sub-transaction; a failure rolls back ONLY that row
 * and the parent transaction continues. This is the only Postgres-correct
 * way to swallow a mid-tx error.
 */
async function replaceRecipe(
  parentProductId: number,
  components: readonly BomComponent[],
): Promise<number> {
  if (components.length === 0) return 0;
  return withTransaction(async (tx) => {
    await tx.query('DELETE FROM recipes WHERE product_id = $1', [parentProductId]);
    let applied = 0;
    for (const c of components) {
      if (c.componentProductId === parentProductId) continue; // chk_recipe_no_self
      if (c.qtyPerUnit <= 0) continue;
      // SAVEPOINT name — sanitised, only alphanumerics + underscore. The
      // identifier is server-side state, not user input, but we still avoid
      // string templating into SQL anywhere unsafe.
      const sp = `sp_recipe_${parentProductId}_${c.componentProductId}`;
      try {
        await tx.query(`SAVEPOINT ${sp}`);
        await tx.query(
          `INSERT INTO recipes (product_id, component_product_id, qty_per_unit, brutto, netto)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (product_id, component_product_id, stage) DO UPDATE
             SET qty_per_unit = EXCLUDED.qty_per_unit,
                 brutto = EXCLUDED.brutto,
                 netto = EXCLUDED.netto`,
          [
            parentProductId,
            c.componentProductId,
            c.qtyPerUnit,
            c.brutto ?? null,
            c.netto ?? null,
          ],
        );
        await tx.query(`RELEASE SAVEPOINT ${sp}`);
        applied += 1;
      } catch (err) {
        // Roll back ONLY this row — the outer tx is still healthy.
        try {
          await tx.query(`ROLLBACK TO SAVEPOINT ${sp}`);
          await tx.query(`RELEASE SAVEPOINT ${sp}`);
        } catch {
          // savepoint already released — ignore
        }
        const e = err as { message?: string; code?: string };
        console.error(
          `[poster] recipe row skipped product=${parentProductId} component=${c.componentProductId} code=${e.code ?? '-'} msg=${redactUrl(e.message ?? '')}`,
        );
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

/**
 * Sync the real Poster product categories (`menu.getCategories`) into the
 * `categories` lookup. MUST run before `syncMenuProducts` so the product sync
 * can map each `menu_category_id` to a local `categories.id`. Logged under the
 * `products` sync entity (the `poster_sync_entity` enum has no `categories`
 * value, and categories are part of the product domain).
 */
export async function syncCategories(
  client: PosterClient,
  trigger: SyncTrigger = 'manual',
): Promise<SeedRunResult> {
  const runId = await startSyncRun('products', trigger);
  try {
    const rows = await client.getCategories();
    let applied = 0;
    for (const r of rows) {
      const id = Number(r.category_id);
      if (!Number.isInteger(id) || id <= 0) continue;
      const name = String(r.category_name ?? '').trim() || `Category ${id}`;
      await upsertCategory(id, name);
      applied += 1;
    }
    await finishSyncRun(runId, 'ok', { recordsIn: rows.length, recordsApplied: applied });
    return { entity: 'products', status: 'ok', recordsIn: rows.length, recordsApplied: applied };
  } catch (err) {
    const detail = redactUrl((err as Error).message);
    await finishSyncRun(runId, 'failed', { recordsIn: 0, recordsApplied: 0 }, detail);
    await notifyPosterSyncFailed('products', detail);
    return { entity: 'products', status: 'failed', recordsIn: 0, recordsApplied: 0, errorDetail: detail };
  }
}

/**
 * Sync the real Poster RAW-ingredient categories (`menu.getCategoriesIngredients`)
 * into the `categories` lookup under `kind='ingredient'` (migration 0038). MUST
 * run before `syncIngredients` so the ingredient sync can map each raw
 * ingredient's `category_id` to a local `categories.id`. Logged under the
 * `ingredients` sync entity.
 *
 * NOTE: Poster groups ONLY raw ingredients this way. Semi-finished prepacks
 * (`menu.getPrepacks`) carry no category — they stay `category_id = NULL`.
 */
export async function syncIngredientCategories(
  client: PosterClient,
  trigger: SyncTrigger = 'manual',
): Promise<SeedRunResult> {
  const runId = await startSyncRun('ingredients', trigger);
  try {
    const rows = await client.getIngredientCategories();
    let applied = 0;
    for (const r of rows) {
      const id = Number(r.category_id);
      if (!Number.isInteger(id) || id <= 0) continue;
      const name = String(r.name ?? '').trim() || `Ingredient category ${id}`;
      await upsertCategory(id, name, 'ingredient');
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

/**
 * Seed Poster production workshops (Цехи) as `locations(type='production')`.
 *
 * Owner rework (2026-06-08): only REAL production workshops become locations;
 * storage/display/decoration/drinks workshops are skipped (see
 * workshopClassification.isProductionWorkshop). Logged under the `storages`
 * sync entity (workshops seed `locations`, same domain; the enum has no
 * dedicated value). MUST run BEFORE the product enrichment so a product can
 * resolve its workshop_id -> location id.
 *
 * The result `errorDetail` carries the include/exclude split for owner review.
 */
export async function syncWorkshops(
  client: PosterClient,
  trigger: SyncTrigger = 'manual',
): Promise<SeedRunResult> {
  const runId = await startSyncRun('storages', trigger);
  try {
    const rows = await client.getWorkshops();
    const included: string[] = [];
    const excluded: string[] = [];
    let applied = 0;
    for (const r of rows) {
      const id = Number(r.workshop_id);
      if (!Number.isInteger(id) || id <= 0) continue;
      // A soft-deleted Poster workshop (delete="1") is skipped entirely.
      if (String(r.delete ?? '0') === '1') continue;
      const name = String(r.workshop_name ?? '').trim() || `Workshop ${id}`;
      if (!isProductionWorkshop(name)) {
        excluded.push(`${id}:${name}`);
        continue;
      }
      await upsertWorkshop(id, name);
      included.push(`${id}:${name}`);
      applied += 1;
    }
    const split =
      `included=${included.length} [${included.join(', ')}] | ` +
      `excluded=${excluded.length} [${excluded.join(', ')}]`;
    await finishSyncRun(runId, 'ok', { recordsIn: rows.length, recordsApplied: applied }, split);
    return {
      entity: 'storages',
      status: 'ok',
      recordsIn: rows.length,
      recordsApplied: applied,
      errorDetail: split,
    };
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
    // Real Poster ingredient-category map (poster_category_id -> categories.id),
    // scoped to kind='ingredient'. Built once from the rows that
    // `syncIngredientCategories` populated first (the seed orchestrator
    // guarantees the ordering). Raw ingredients with no/unknown category map
    // to NULL.
    const categoryMap = await loadCategoryMap('ingredient');
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
      const pcid = r.category_id !== undefined ? Number(r.category_id) : null;
      const categoryId =
        pcid !== null && Number.isInteger(pcid) && pcid > 0
          ? (categoryMap.get(pcid) ?? null)
          : null;
      await upsertIngredient(id, name, unit, categoryId);
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

/** One dish (тех.карта) record used only as an enrichment source. */
type DishEnrichment = {
  /** Local category_id resolved from the dish menu_category_id (or null). */
  categoryId: number | null;
  /** Poster photo URL (CDN-relative), or null. */
  imageUrl: string | null;
  /** Poster workshop_id (Цех) of the dish, or null when 0/absent. */
  workshopId: number | null;
};

/**
 * Enrich prepack products (semi + finished) from Poster dishes (тех.карты), then
 * DROP the legacy menu-product rows.
 *
 * Owner rework (2026-06-08): `menu.getProducts` no longer CREATES products.
 * Товары (Coca Cola, Borjomi…) and dish-as-product rows are NOT products. The
 * dishes are used ONLY as an enrichment source — matched BY NORMALISED NAME to a
 * prepack — to supply three fields: menu `category_id`, `image_url`, and the
 * production `workshop_location_id`. Anything that does not match a prepack
 * (i.e. every товар) is simply ignored. After enrichment we delete the 294
 * legacy menu-product rows the OLD `syncMenuProducts` created (see
 * `dropMenuProducts`).
 *
 * Keeps the historic `syncMenuProducts` export name so the route + orchestrator
 * entry points are unchanged. MUST run AFTER `syncWorkshops` (workshop link) and
 * `syncPrepacks` (the rows being enriched).
 */
export async function syncMenuProducts(
  client: PosterClient,
  trigger: SyncTrigger = 'manual',
): Promise<SeedRunResult> {
  const runId = await startSyncRun('products', trigger);
  let total = 0;
  try {
    const list = await client.getProducts();
    total = list.length;
    const categoryMap = await loadCategoryMap(); // poster_category_id -> categories.id (menu)
    // Workshop link map: Poster workshop_id -> ADIA production locations.id.
    const { rows: wsRows } = await query<{ id: number; poster_workshop_id: number }>(
      `SELECT id, poster_workshop_id FROM locations
        WHERE poster_workshop_id IS NOT NULL`,
    );
    const workshopLocByPoster = new Map<number, number>();
    for (const w of wsRows) workshopLocByPoster.set(Number(w.poster_workshop_id), Number(w.id));

    // Build the dish enrichment map keyed by NORMALISED name. Later rows win on
    // a name collision (rare; the catalogue is near-unique by normalised name).
    const dishByName = new Map<string, DishEnrichment>();
    for (const p of list) {
      const key = normalizeMatchName(String(p.product_name ?? ''));
      if (key === '') continue;
      const pcid = p.menu_category_id !== undefined ? Number(p.menu_category_id) : null;
      const categoryId =
        pcid !== null && Number.isInteger(pcid) && pcid > 0
          ? (categoryMap.get(pcid) ?? null)
          : null;
      const wsRaw = p.workshop !== undefined ? Number(p.workshop) : 0;
      const workshopId = Number.isInteger(wsRaw) && wsRaw > 0 ? wsRaw : null;
      const photo = String(p.photo ?? p.photo_origin ?? '').trim();
      dishByName.set(key, {
        categoryId,
        imageUrl: photo !== '' ? photo : null,
        workshopId,
      });
    }

    // Enrich every prepack (semi + finished) whose normalised name matches a
    // dish. We only OVERWRITE a field when the dish supplies a value (COALESCE
    // semantics handled in SQL) — never clobber an existing value with NULL.
    const { rows: prepacks } = await query<{ id: number; name: string }>(
      `SELECT id, name FROM products WHERE type IN ('semi', 'finished')`,
    );
    let enrichedCategory = 0;
    let enrichedImage = 0;
    let enrichedWorkshop = 0;
    let matched = 0;
    for (const pk of prepacks) {
      const key = normalizeMatchName(pk.name);
      if (key === '') continue;
      const dish = dishByName.get(key);
      if (dish === undefined) continue;
      matched += 1;
      const workshopLocId =
        dish.workshopId !== null ? (workshopLocByPoster.get(dish.workshopId) ?? null) : null;
      await query(
        `UPDATE products
            SET category_id = COALESCE($2, category_id),
                image_url   = COALESCE($3, image_url),
                workshop_location_id = COALESCE($4, workshop_location_id),
                updated_at  = now()
          WHERE id = $1`,
        [pk.id, dish.categoryId, dish.imageUrl, workshopLocId],
      );
      if (dish.categoryId !== null) enrichedCategory += 1;
      if (dish.imageUrl !== null) enrichedImage += 1;
      if (workshopLocId !== null) enrichedWorkshop += 1;
    }

    // Drop the legacy menu-product rows (товары + dish-as-product). The set is
    // every local product whose poster_product_id is a menu product_id — these
    // never overlap prepack product_ids (verified live 2026-06-08).
    const menuPids = list
      .map((p) => Number(p.product_id))
      .filter((id) => Number.isInteger(id) && id > 0);
    const dropped = await dropMenuProducts(menuPids);

    const summary =
      `dishes=${list.length} enrich(matched=${matched}, cat=${enrichedCategory}, ` +
      `img=${enrichedImage}, ws=${enrichedWorkshop}) dropped_menu_products=${dropped}`;
    await finishSyncRun(runId, 'ok', { recordsIn: total, recordsApplied: matched }, summary);
    return {
      entity: 'products',
      status: 'ok',
      recordsIn: total,
      recordsApplied: matched,
      errorDetail: summary,
    };
  } catch (err) {
    const detail = redactUrl((err as Error).message);
    await finishSyncRun(runId, 'partial', { recordsIn: total, recordsApplied: 0 }, detail);
    await notifyPosterSyncFailed('products', detail);
    return {
      entity: 'products',
      status: 'partial',
      recordsIn: total,
      recordsApplied: 0,
      errorDetail: detail,
    };
  }
}

/**
 * Delete the legacy menu-product rows (товары + dish-as-product) the OLD
 * `syncMenuProducts` created, by `poster_product_id`. Wrapped in ONE
 * transaction; all dependent rows that reference these products with
 * `ON DELETE RESTRICT` (stock, movements, sales, replenishment, production /
 * purchase orders, nakladnoy lines, writeback queue, dialog sessions, recipes
 * as a component) are removed first in FK-safe order so the final
 * `DELETE FROM products` cannot raise 23503. Raw/semi/finished prepacks and
 * their stock are NEVER touched — only rows whose poster_product_id is in the
 * menu-product id set (which is disjoint from prepack ids).
 *
 * Idempotent: a re-run finds no matching rows (the old menu-products are gone)
 * and deletes nothing. Returns the number of product rows removed.
 */
async function dropMenuProducts(menuProductIds: readonly number[]): Promise<number> {
  if (menuProductIds.length === 0) return 0;
  return withTransaction(async (tx) => {
    // Resolve the local product ids to delete (menu product_ids only; disjoint
    // from prepack ids so no prepack is ever caught here).
    const { rows: targets } = await tx.query<{ id: number }>(
      `SELECT id FROM products WHERE poster_product_id = ANY($1::bigint[])`,
      [menuProductIds],
    );
    const ids = targets.map((r) => Number(r.id));
    if (ids.length === 0) return 0;

    // FK-safe dependent deletes (children of these tables cascade / set-null).
    const deps: readonly [string, string][] = [
      ['purchase_orders', 'product_id'],
      ['production_orders', 'product_id'],
      ['replenishment_requests', 'product_id'],
      ['stock_movements', 'product_id'],
      ['sales', 'product_id'],
      ['stock', 'product_id'],
      ['nakladnoy_lines', 'product_id'],
      ['nakladnoy_lines', 'component_product_id'],
      ['poster_writeback_queue', 'product_id'],
      ['production_dialog_sessions', 'product_id'],
      ['recipes', 'component_product_id'],
    ];
    for (const [table, col] of deps) {
      // table/col are server-side constants (never user input) — safe to inline.
      await tx.query(`DELETE FROM ${table} WHERE ${col} = ANY($1::bigint[])`, [ids]);
    }

    // Now the products themselves. recipes.product_id, sales_stats_daily,
    // forecasts, poster_product_writeback cascade automatically.
    const del = await tx.query(`DELETE FROM products WHERE id = ANY($1::bigint[])`, [ids]);

    await writeAudit(tx, {
      actorUserId: null,
      action: 'poster.menu_products.drop',
      entity: 'products',
      entityId: null,
      payload: { dropped: del.rowCount ?? ids.length, product_ids: ids.slice(0, 50) },
    });
    return del.rowCount ?? ids.length;
  });
}

/**
 * Sync prepacks (semi-finished products) + their BOMs.
 *
 * I9 (Sprint 3 audit P1): each prepack is handled in its OWN try/catch so
 * one failure (23505 unique-key violation, CHECK constraint, an ingredient
 * that has not been seeded yet, etc.) does not poison the rest of the run.
 * Real Poster fixtures had 1121 prepacks where only ~109 landed before this
 * fix — every failure after the first cascaded as
 * "current transaction is aborted, commands ignored". Root-cause errors are
 * collected in `failedItems` and surfaced in the final log + return payload
 * so the next debugging session has the SQLSTATE code in hand.
 */
export async function syncPrepacks(
  client: PosterClient,
  trigger: SyncTrigger = 'manual',
): Promise<SeedRunResult> {
  const runId = await startSyncRun('products', trigger);
  let applied = 0;
  let total = 0;
  const failedItems: { posterProductId: number; code: string | undefined; message: string }[] = [];
  try {
    const list = await client.getPrepacks();
    total = list.length;

    // PHASE 1 — upsert every prepack ROW first (and sync raw-ingredient unit
    // costs). A prepack BOM can reference ANOTHER prepack (structure_type=2);
    // resolving those `poster_product_id` links in one pass would miss any
    // prepack that appears later in the list. So we land all prepack rows up
    // front, THEN resolve BOMs in phase 2 when every poster_product_id exists.
    const parentIdByPoster = new Map<number, number>(); // poster_product_id -> ADIA id
    for (const p of list) {
      const ppid = Number(p.product_id);
      const pingRaw = Number(p.ingredient_id);
      // A prepack MUST have a menu product_id (its natural key). The
      // `ingredient_id` is OPTIONAL — Poster reports 0 for a stockless
      // prepack. Previously such prepacks (ingredient_id<=0) were skipped,
      // which dropped whole BOM sub-trees; we now import them keyed only by
      // poster_product_id.
      if (!Number.isInteger(ppid) || ppid <= 0) continue;
      const ping = Number.isInteger(pingRaw) && pingRaw > 0 ? pingRaw : null;
      const prepackName = String(p.product_name ?? '').trim() || `Prepack ${ppid}`;
      // Owner rework (2026-06-08): a «Г/П…» ready-prefixed prepack is a finished
      // sale-ready product (Tayyor mahsulot); everything else is semi (Yarim).
      const productType: 'semi' | 'finished' = hasReadyPrefix(prepackName)
        ? 'finished'
        : 'semi';
      try {
        const parentId = await upsertPrepack(ppid, ping, prepackName, productType);
        parentIdByPoster.set(ppid, parentId);
        // For every RAW (type=1) line, persist the derived unit cost on the
        // raw product. Best-effort — a not-yet-seeded raw is a no-op (the raw
        // ingredient sync already ran in runSeedSync ordering).
        for (const ing of p.ingredients ?? []) {
          const compPing = Number(ing.ingredient_id);
          if (!Number.isInteger(compPing) || compPing <= 0) continue;
          const sType = Number(ing.structure_type);
          if (Number.isFinite(sType) && sType === 2) continue; // prepack child — no raw cost
          const unitCost = rawUnitCostFromLine(ing);
          if (unitCost !== null) await setRawIngredientCost(compPing, unitCost);
        }
      } catch (err) {
        const e = err as { message?: string; code?: string };
        const msg = redactUrl(e.message ?? 'unknown');
        failedItems.push({ posterProductId: ppid, code: e.code, message: msg });
        console.error(`[poster:prepack:upsert] id=${ppid} code=${e.code ?? '-'} msg=${msg}`);
      }
    }

    // PHASE 2 — now every prepack row exists; resolve each prepack's BOM.
    for (const p of list) {
      const ppid = Number(p.product_id);
      if (!Number.isInteger(ppid) || ppid <= 0) continue;
      const parentId = parentIdByPoster.get(ppid);
      if (parentId === undefined) continue; // phase-1 upsert failed — already logged
      try {
        // `out` is the batch yield in the prepack's BASE structure unit
        // (grams for weight prepacks, ml for volume, pcs for count). Normalise
        // it to the prepack's OWN product unit (kg/l/pcs) so it is the SAME
        // unit basis as each line's normalised brutto — otherwise qty_per_unit
        // is ~1000× off (the 2026-05-30 bug). The denominator is then
        // "1 unit of the prepack's output".
        const outUnit = dominantStructureUnit(p.ingredients ?? []);
        const yieldInUnit = normaliseOut(outUnit, p.out);
        const yieldQty = yieldInUnit > 0 ? yieldInUnit : 1;
        const components: BomComponent[] = [];
        for (const ing of p.ingredients ?? []) {
          const compPing = Number(ing.ingredient_id);
          if (!Number.isInteger(compPing) || compPing <= 0) continue;
          // structure_type drives the lookup column: 1 -> raw
          // (poster_ingredient_id), 2 -> prepack/semi (poster_product_id).
          const sType = Number(ing.structure_type);
          const structureType = Number.isFinite(sType) ? sType : 1;
          const compId = await resolveComponentId(compPing, structureType);
          if (compId === null) continue; // component not seeded — skip
          // brutto -> component unit (kg), then ÷ yield (in parent unit) =
          // component qty per 1 unit of parent output.
          const qtyConverted = normaliseQty(
            String(ing.structure_unit ?? ''),
            String(ing.ingredient_unit ?? ''),
            ing.structure_brutto,
          );
          const perUnit = qtyConverted / yieldQty;
          if (perUnit > 0 && Number.isFinite(perUnit)) {
            components.push({
              componentProductId: compId,
              qtyPerUnit: perUnit,
              brutto: numOrNull(ing.structure_brutto),
              netto: numOrNull(ing.structure_netto),
            });
          }
        }
        await replaceRecipe(parentId, components);
        applied += 1;
      } catch (err) {
        // Per-prepack isolation: log the real Postgres code + message, push
        // to failedItems, and continue with the next prepack. Without this
        // catch one bad row aborted the loop AND surfaced as a useless
        // "current transaction is aborted" against the NEXT prepack.
        const e = err as { message?: string; code?: string };
        const msg = redactUrl(e.message ?? 'unknown');
        failedItems.push({ posterProductId: ppid, code: e.code, message: msg });
        console.error(
          `[poster:prepack] id=${ppid} code=${e.code ?? '-'} msg=${msg}`,
        );
        // F2.3 — persist the per-item failure to `import_warnings` so PM
        // sees it on the dashboard without scanning the server log. The
        // helper is best-effort: a failure here must not abort the loop.
        try {
          await recordImportWarning({
            source: 'poster.prepack',
            entity: `product:${ppid}`,
            severity: 'warning',
            message: msg,
            payload: { poster_product_id: ppid, code: e.code ?? null },
          });
        } catch (warnErr) {
          console.error(
            '[poster:prepack] failed to record import_warning:',
            (warnErr as Error).message,
          );
        }
      }
    }
    // If any prepack failed, the run is `partial`, not `ok` — operators
    // need to see this in `poster_sync_log` to drive the next fix.
    const status: 'ok' | 'partial' = failedItems.length === 0 ? 'ok' : 'partial';
    const summary =
      failedItems.length === 0
        ? undefined
        : `${failedItems.length} prepack(s) failed (first: id=${failedItems[0]!.posterProductId} ` +
          `code=${failedItems[0]!.code ?? '-'} ${failedItems[0]!.message.slice(0, 200)})`;
    await finishSyncRun(runId, status, { recordsIn: total, recordsApplied: applied }, summary);
    return {
      entity: 'products',
      status,
      recordsIn: total,
      recordsApplied: applied,
      ...(summary !== undefined ? { errorDetail: summary } : {}),
    };
  } catch (err) {
    // Catastrophic outer failure — e.g. `client.getPrepacks()` itself threw.
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
    // Workshops (Цехи) -> locations(type='production'). MUST run before the
    // product enrichment in syncMenuProducts so product->workshop links resolve.
    results.push(await syncWorkshops(client, 'manual'));
  }
  if (selector === 'all' || selector === 'products') {
    // categories first — syncMenuProducts maps menu_category_id -> categories.id.
    results.push(await syncCategories(client, 'manual'));
    // ingredient categories before ingredients — syncIngredients maps each raw
    // ingredient's Poster category_id -> categories.id (kind='ingredient').
    results.push(await syncIngredientCategories(client, 'manual'));
    results.push(await syncIngredients(client, 'manual'));
    results.push(await syncPrepacks(client, 'manual'));
    results.push(await syncMenuProducts(client, 'manual'));
  }
  return results;
}
