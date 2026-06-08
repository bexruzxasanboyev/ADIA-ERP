/**
 * Batched, memoized per-product computed cost (Себестоимость) — the LIST view
 * companion to `readRecipeTree` in bom.ts.
 *
 * `readRecipeTree` computes the bottom-up cost of ONE product by recursively
 * querying the recipe graph. Calling it once per product to fill a 1100-row
 * `GET /api/products` list would fire thousands of queries. `computeAllProductCosts`
 * gets the EXACT same number with just TWO queries: load every product's
 * (type, recipe_yield, manual/synced cost) and every recipe line, then roll the
 * costs up IN MEMORY with memoization + a cycle guard.
 *
 * Semantics MUST agree with `readRecipeTree(...).total_cost`:
 *   - leaf / no recipe lines: cost = manual_cost_per_unit ALONE — the catalog
 *     price is app-owned and Poster-INDEPENDENT, so a raw with no manual price
 *     is null (we never fake a 0 and never borrow the Poster cost_per_unit);
 *   - has recipe lines:       cost = Σ over lines of
 *                               (qty_per_unit / this_product.recipe_yield) × unitCost(component),
 *     where unitCost(component) recurses (a component with its own recipe rolls
 *     up; a leaf uses its own COALESCE cost). Null anywhere → null.
 *
 * The depth cap (MAX_RECIPE_DEPTH = 12) and the per-path visited-set mirror
 * `bom.ts` so a pathological cycle resolves to [] children (cost from this
 * product's own leaf cost, or null) exactly as the recursive reader would.
 */
import type { TxClient } from '../db/index.js';

/** A queryable client — the pool runner or an open transaction (mirrors bom.ts). */
type Runner = Pick<TxClient, 'query'>;

// Mirror bom.ts exactly — depth cap + 2-decimal rounding.
const MAX_RECIPE_DEPTH = 12;

function round2OrNull(n: number | null): number | null {
  return n === null ? null : Math.round(n * 100) / 100;
}

type ProductCostRow = {
  readonly id: number;
  /** recipe_yield (TZ-3) — how many finished units one full recipe makes. */
  readonly recipe_yield: number;
  /** manual_cost_per_unit — the leaf unit cost (null when no manual price). */
  readonly leaf_cost: number | null;
};

type RecipeLine = {
  readonly component_product_id: number;
  readonly qty_per_unit: number;
};

/**
 * Compute the bottom-up `computed_cost` for EVERY product in two queries.
 * Returns a Map keyed by product id; the value is the rounded cost or null.
 */
export async function computeAllProductCosts(
  runner: Runner,
): Promise<Map<number, number | null>> {
  // Query 1 — every product's leaf cost + yield. The CATALOG PRICE is now
  // app-owned and Poster-INDEPENDENT: the leaf unit cost is the MANUALLY
  // entered raw price ALONE (`manual_cost_per_unit`), NOT a Poster fallback.
  // A raw with no manual price -> null -> its dependent semi/finished -> null.
  // This matches the leaf unit cost bom.ts reads.
  const { rows: productRows } = await runner.query<{
    id: string | number;
    recipe_yield: string | number | null;
    leaf_cost: string | number | null;
  }>(
    `SELECT id,
            recipe_yield,
            manual_cost_per_unit AS leaf_cost
       FROM products`,
  );

  // Query 2 — every recipe line (no yield division here; we divide by the
  // PARENT product's recipe_yield in memory, exactly like bom.ts).
  const { rows: recipeRows } = await runner.query<{
    product_id: string | number;
    component_product_id: string | number;
    qty_per_unit: string | number;
  }>(`SELECT product_id, component_product_id, qty_per_unit FROM recipes`);

  const products = new Map<number, ProductCostRow>();
  for (const r of productRows) {
    products.set(Number(r.id), {
      id: Number(r.id),
      // Default 1 (mirrors bom.ts `Number(... ?? 1) || 1`).
      recipe_yield: Number(r.recipe_yield ?? 1) || 1,
      leaf_cost:
        r.leaf_cost === null || r.leaf_cost === undefined ? null : Number(r.leaf_cost),
    });
  }

  const linesByProduct = new Map<number, RecipeLine[]>();
  for (const r of recipeRows) {
    const productId = Number(r.product_id);
    const list = linesByProduct.get(productId) ?? [];
    list.push({
      component_product_id: Number(r.component_product_id),
      qty_per_unit: Number(r.qty_per_unit),
    });
    linesByProduct.set(productId, list);
  }

  // Memoize each product's UNROUNDED cost so a component shared by many parents
  // is computed once. The cache stores `number | null` (a resolved cost).
  const memo = new Map<number, number | null>();

  /**
   * The unit cost of ONE unit of `productId`.
   *   - no recipe lines  -> its leaf cost (COALESCE(manual, synced); null if none);
   *   - has recipe lines -> Σ (qty_per_unit / recipe_yield) × unitCost(component).
   * `depth` and `visited` mirror bom.ts: at the depth cap or on a revisit the
   * recursion stops returning [] children, so the node falls back to its own
   * leaf cost (or null when it has none).
   */
  function unitCost(
    productId: number,
    visited: Set<number>,
    depth: number,
  ): number | null {
    const cached = memo.get(productId);
    // Only trust the cache for the un-constrained (root-equivalent) computation.
    // Since the cost of a product is path-independent (the visited set only ever
    // contains ancestors, which by acyclic invariant never appear below), the
    // memo is safe across all callers.
    if (cached !== undefined) return cached;

    const product = products.get(productId);
    const leaf = product ? product.leaf_cost : null;
    const lines = linesByProduct.get(productId);

    // No recipe lines, or we hit the depth cap — leaf cost (bom.ts returns []
    // children at depth >= MAX_RECIPE_DEPTH, making the node a leaf).
    if (lines === undefined || lines.length === 0 || depth >= MAX_RECIPE_DEPTH) {
      memo.set(productId, leaf);
      return leaf;
    }

    const yld = product ? product.recipe_yield : 1;
    let sum = 0;
    let known = false;
    for (const line of lines) {
      const componentId = line.component_product_id;
      const qtyPerUnit = line.qty_per_unit / yld;

      // Cycle guard — bom.ts gives a revisited component [] children, i.e. it
      // is treated as a leaf using its own cost.
      const childUnitCost = visited.has(componentId)
        ? (products.get(componentId)?.leaf_cost ?? null)
        : unitCost(componentId, new Set([...visited, componentId]), depth + 1);

      if (childUnitCost === null || !Number.isFinite(qtyPerUnit)) {
        // A null leg makes the whole sum null (never fake a 0) — mirrors
        // sumLineCosts in bom.ts.
        memo.set(productId, null);
        return null;
      }
      sum += qtyPerUnit * childUnitCost;
      known = true;
    }

    const result = known ? sum : leaf;
    memo.set(productId, result);
    return result;
  }

  const out = new Map<number, number | null>();
  for (const id of products.keys()) {
    out.set(id, round2OrNull(unitCost(id, new Set([id]), 0)));
  }
  return out;
}
