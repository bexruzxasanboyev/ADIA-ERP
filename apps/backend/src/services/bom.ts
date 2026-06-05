/**
 * ADR-0016 §2.2 / R3 — stage-aware BOM reading.
 *
 * The zagatovka -> ukrasheniye flow splits a finished cake's recipe into
 * stages (`recipes.stage`, migration 0029):
 *
 *   * 'base'       — hamir/asos that becomes the zagatovka (the 70%-done cake).
 *   * 'decoration' — krem/bezak + the zagatovka (semi) component itself; this
 *                    is the ukrasheniye pass that produces the FINISHED cake.
 *   * 'assembly'   — optional bake/fill step.
 *
 * The production-input check + the "done" flow for a FINAL (finished) order
 * must read ONLY the `decoration` lines — the `base` (hamir) is produced
 * separately as a zagatovka sub-order and consumed FROM sex_storage as the
 * semi component. If the `base` lines were also read here, the hamir
 * components would be transferred / consumed TWICE (R3 — the bug ADR-0016
 * §7 warns about).
 *
 * BACKWARD COMPATIBILITY (R1 / 0029 default): Poster-synced recipes are flat
 * and entirely `base` (the default). A recipe with NO `decoration` line is a
 * legacy single-pass product — we read EVERY line, exactly like the old flow.
 * Only once a recipe has been curated into base/decoration (EPIC 1.3/1.5)
 * does the two-pass behaviour kick in.
 *
 * `readFinalBom` returns the lines the FINAL order consumes:
 *   - if the recipe has any `decoration` line  -> only the `decoration` lines;
 *   - otherwise (legacy / all-base)            -> all lines.
 *
 * `readBaseBom` returns the `base` lines a zagatovka sub-order consumes.
 */
import type { TxClient } from '../db/index.js';

export type BomLine = {
  readonly component_product_id: number;
  readonly qty_per_unit: number;
};

/** A queryable client — the pool runner or an open transaction. */
type Runner = Pick<TxClient, 'query'>;

/**
 * The BOM lines a FINAL (finished) production order consumes. When the recipe
 * has been split (any `decoration` line exists) we return ONLY the decoration
 * lines — the base/hamir is handled by a separate zagatovka sub-order. A
 * legacy flat recipe (no decoration) returns every line unchanged.
 */
export async function readFinalBom(
  runner: Runner,
  productId: number,
): Promise<BomLine[]> {
  // TZ-3 — divide by the product's recipe_yield so consumption is per ONE
  // finished piece, not per imported batch (mirrors readRecipeTree).
  const { rows: deco } = await runner.query<BomLine>(
    `SELECT r.component_product_id, r.qty_per_unit / pp.recipe_yield AS qty_per_unit
       FROM recipes r JOIN products pp ON pp.id = r.product_id
      WHERE r.product_id = $1 AND r.stage = 'decoration'`,
    [productId],
  );
  if (deco.length > 0) {
    return deco.map(normalize);
  }
  // Legacy / all-base recipe — read every line (old single-pass behaviour).
  const { rows: all } = await runner.query<BomLine>(
    `SELECT r.component_product_id, r.qty_per_unit / pp.recipe_yield AS qty_per_unit
       FROM recipes r JOIN products pp ON pp.id = r.product_id
      WHERE r.product_id = $1`,
    [productId],
  );
  return all.map(normalize);
}

/**
 * The `base` (hamir/asos) BOM lines for a product — what a zagatovka
 * sub-order consumes to MAKE the zagatovka. Returns the explicit `base`
 * rows; for a legacy flat recipe these are simply all of them.
 */
export async function readBaseBom(
  runner: Runner,
  productId: number,
): Promise<BomLine[]> {
  const { rows } = await runner.query<BomLine>(
    `SELECT r.component_product_id, r.qty_per_unit / pp.recipe_yield AS qty_per_unit
       FROM recipes r JOIN products pp ON pp.id = r.product_id
      WHERE r.product_id = $1 AND r.stage = 'base'`,
    [productId],
  );
  return rows.map(normalize);
}

/**
 * The decoration component that is itself a `semi` product (the zagatovka).
 * Used by the dialog engine to find which component is the half-finished cake
 * whose on-hand sex_storage qty decides "tayyordan or 0dan". Returns null when
 * the decoration BOM has no semi component (e.g. a legacy product).
 */
export async function findZagatovkaComponent(
  runner: Runner,
  productId: number,
): Promise<BomLine | null> {
  const { rows } = await runner.query<BomLine>(
    `SELECT r.component_product_id, r.qty_per_unit / pp.recipe_yield AS qty_per_unit
       FROM recipes r
       JOIN products p ON p.id = r.component_product_id
       JOIN products pp ON pp.id = r.product_id
      WHERE r.product_id = $1 AND r.stage = 'decoration' AND p.type = 'semi'
      ORDER BY r.component_product_id
      LIMIT 1`,
    [productId],
  );
  const row = rows[0];
  return row === undefined ? null : normalize(row);
}

function normalize(line: BomLine): BomLine {
  return {
    component_product_id: Number(line.component_product_id),
    qty_per_unit: Number(line.qty_per_unit),
  };
}

// -----------------------------------------------------------------------------
// Nested recipe tree + cost (recipe-modal read — 2026-05-30).
//
// Owner decision: the recipe modal shows the BOM NESTED like Poster (prepacks
// expandable) WITH Себестоимость per line + a product total. Cost is computed
// BOTTOM-UP from `products.cost_per_unit` (raw leaf unit cost, so'm/unit):
//
//   * a RAW/leaf node's   unit_cost  = products.cost_per_unit (NULL if unknown);
//   * a parent node's     unit_cost  = Σ child.line_cost  (one parent unit);
//   * a line's            line_cost  = qty_per_unit × child.unit_cost;
//   * the product total   total_cost = Σ top-level line_cost.
//
// A NULL anywhere in a sub-tree makes that node's cost NULL (we never fake a 0
// — a missing raw cost must be visible, not silently swallowed).
// -----------------------------------------------------------------------------

/** A node in the nested recipe tree returned by `GET /:id/recipe`. */
export type RecipeNode = {
  readonly component_product_id: number;
  readonly name: string;
  readonly type: 'raw' | 'semi' | 'finished';
  readonly unit: string;
  /** qty of this component per ONE unit of the parent product. */
  readonly qty_per_unit: number;
  /** Поster brutto/netto — carried for display when available (else null). */
  readonly brutto: number | null;
  readonly netto: number | null;
  /** Unit cost of ONE unit of THIS component (so'm/unit); null when unknown. */
  readonly unit_cost: number | null;
  /** qty_per_unit × unit_cost (so'm); null when unit_cost is null. */
  readonly line_cost: number | null;
  /** Себестоимость of one unit of this component = Σ child line_cost (or leaf cost). */
  readonly total_cost: number | null;
  readonly children: RecipeNode[];
};

export type RecipeTree = {
  readonly product_id: number;
  readonly nodes: RecipeNode[];
  /** Σ top-level line_cost — the product's full recipe cost (so'm); null if any leg unknown. */
  readonly total_cost: number | null;
};

const MAX_RECIPE_DEPTH = 12; // defensive — recipes are cycle-protected at write.

function round2OrNull(n: number | null): number | null {
  return n === null ? null : Math.round(n * 100) / 100;
}

/**
 * Build the nested recipe tree for `productId` with bottom-up cost. Each call
 * fetches the direct lines, then recurses per child. `visited` guards against a
 * pathological cycle (should never happen — write-time cycle check + depth cap).
 */
export async function readRecipeTree(
  runner: Runner,
  productId: number,
): Promise<RecipeTree> {
  const raw = await buildChildren(runner, productId, new Set([productId]), 0);
  // Explode the per-LEVEL tree into a PER-1-FINISHED-PIECE view so a nested
  // prepack shows how much of it goes into ONE piece, not its own per-kg
  // basis — every qty/cost is scaled by the cumulative quantity down its path.
  const nodes = explodePerRoot(raw, 1);
  const total = sumLineCosts(nodes);
  return { product_id: productId, nodes, total_cost: round2OrNull(total) };
}

/**
 * TZ-3 — turn a per-level recipe tree into a per-1-root-product ("exploded")
 * view. Each node's qty / brutto / netto / line_cost is multiplied by the
 * cumulative quantity from the root, and `total_cost` becomes the node's own
 * per-piece contribution so a section header agrees with the sum of its rows.
 * `unit_cost` stays per-component-unit (a position-independent reference).
 */
function explodePerRoot(nodes: readonly RecipeNode[], mult: number): RecipeNode[] {
  return nodes.map((n) => {
    const scaledLine = n.line_cost === null ? null : round2OrNull(n.line_cost * mult);
    return {
      ...n,
      qty_per_unit: n.qty_per_unit * mult,
      brutto: n.brutto === null ? null : n.brutto * mult,
      netto: n.netto === null ? null : n.netto * mult,
      line_cost: scaledLine,
      total_cost: scaledLine,
      children: explodePerRoot(n.children, mult * n.qty_per_unit),
    };
  });
}

async function buildChildren(
  runner: Runner,
  productId: number,
  visited: Set<number>,
  depth: number,
): Promise<RecipeNode[]> {
  if (depth >= MAX_RECIPE_DEPTH) return [];
  // TZ-3 — `recipe_yield` is how many finished units one full recipe makes.
  // Poster gives no batch yield for finished goods, so a batch recipe (e.g.
  // ПЕЧЕНЬЕ: 1 kg chocolate "per dona") imports inflated; dividing every line
  // by this product's yield gives the true per-1-piece figure. Default 1 = the
  // recipe is already per-unit (prepacks + the 146 correct finished products).
  const { rows: yieldRows } = await runner.query<{ recipe_yield: string | number }>(
    `SELECT recipe_yield FROM products WHERE id = $1`,
    [productId],
  );
  const yld = Number(yieldRows[0]?.recipe_yield ?? 1) || 1;

  const { rows } = await runner.query<{
    component_product_id: number;
    qty_per_unit: string | number;
    brutto: string | number | null;
    netto: string | number | null;
    name: string;
    type: 'raw' | 'semi' | 'finished';
    unit: string;
    cost_per_unit: string | number | null;
  }>(
    `SELECT r.component_product_id, r.qty_per_unit, r.brutto, r.netto,
            p.name, p.type, p.unit, p.cost_per_unit
       FROM recipes r
       JOIN products p ON p.id = r.component_product_id
      WHERE r.product_id = $1
      ORDER BY r.id`,
    [productId],
  );

  const out: RecipeNode[] = [];
  for (const r of rows) {
    const componentId = Number(r.component_product_id);
    const qtyPerUnit = Number(r.qty_per_unit) / yld;
    const leafCost =
      r.cost_per_unit === null || r.cost_per_unit === undefined
        ? null
        : Number(r.cost_per_unit);

    // Recurse — but never revisit a product already on THIS path (cycle guard).
    const children =
      visited.has(componentId)
        ? []
        : await buildChildren(
            runner,
            componentId,
            new Set([...visited, componentId]),
            depth + 1,
          );

    // unit_cost of this component: a parent (has children) is the sum of its
    // children's line_cost; a leaf uses its own cost_per_unit.
    const unitCost =
      children.length > 0 ? sumLineCosts(children) : leafCost;
    const lineCost =
      unitCost === null || !Number.isFinite(qtyPerUnit) ? null : qtyPerUnit * unitCost;

    out.push({
      component_product_id: componentId,
      name: r.name,
      type: r.type,
      unit: r.unit,
      qty_per_unit: qtyPerUnit,
      // Poster Brutto/Netto (recipes.brutto/netto, migration 0040) — the raw
      // per-batch composition figures in the line's structure_unit. NULL for
      // manually-entered or modification-linked lines.
      // Divided by the same yield so the per-piece view stays internally
      // consistent (a batch recipe's brutto/netto are per-batch in Poster).
      brutto:
        r.brutto === null || r.brutto === undefined ? null : Number(r.brutto) / yld,
      netto:
        r.netto === null || r.netto === undefined ? null : Number(r.netto) / yld,
      unit_cost: round2OrNull(unitCost),
      line_cost: round2OrNull(lineCost),
      total_cost: round2OrNull(unitCost),
      children,
    });
  }
  return out;
}

/**
 * Σ of every node's line_cost. Returns null when ANY node's line_cost is null
 * (an unknown leg makes the whole sum unknown — never fake a 0).
 */
function sumLineCosts(nodes: readonly RecipeNode[]): number | null {
  let sum = 0;
  let known = false;
  for (const n of nodes) {
    if (n.line_cost === null) return null;
    sum += n.line_cost;
    known = true;
  }
  return known ? sum : null;
}
