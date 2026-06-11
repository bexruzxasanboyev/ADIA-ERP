/**
 * EcosystemCanvas (Detalli) — node coordinate constants.
 *
 * The Detalli view stacks the supply chain into six vertical layers,
 * each holding a small fan-out of nodes:
 *
 *   y=0    Yetkazib beruvchilar (top 5 suppliers, horizontal row)
 *   y=180  Xom-ashyo ombori (single node, centred)
 *   y=360  Ishlab chiqarish (per-sex nodes, horizontal row)
 *   y=560  Ta'minot bo'limlari (per-supply nodes, horizontal row)
 *   y=760  Markaziy sklad (centred)
 *   y=940  Do'konlar (per-store nodes, horizontal row)
 *
 * Layout helpers below centre a horizontal row around a target axis
 * (`CENTER_X`) given a list size and per-card gap, so the layout
 * automatically stays balanced whether we have 2 stores or 8.
 *
 * Node dimensions:
 *   EcosystemNode: 180 wide × 120 tall
 *   SupplierNode:  160 wide × 100 tall
 */

/** Logical centre of the canvas — every horizontal row centres on this. */
export const CENTER_X = 600;

/** EcosystemNode visual dimensions. */
export const NODE_WIDTH = 180;
export const NODE_HEIGHT = 120;

/** SupplierNode visual dimensions. */
export const SUPPLIER_WIDTH = 160;
export const SUPPLIER_HEIGHT = 100;

/** Production group dimensions. */
export const PRODUCTION_GROUP_WIDTH = 880;
export const PRODUCTION_GROUP_HEIGHT = 160;

/** Per-layer vertical position.
 *
 * Compressed so the 6-layer graph stays roughly square (~880 × 770) —
 * matches the dashboard's wide-aspect canvas better and lets React
 * Flow's `fitView` zoom up instead of leaving big horizontal margins.
 * Horizontal gaps are also wider so each layer occupies more of the
 * canvas's width.
 */
export const ECOSYSTEM_LAYOUT = {
  suppliers: { y: 0, gap: 220 },
  raw: { y: 150 },
  productionGroup: { y: 290 },
  productionSex: { yOffset: 40, gap: 240 },
  supply: { y: 490, gap: 340 },
  central: { y: 630 },
  stores: { y: 770, gap: 260 },
} as const;

/**
 * Return the X coordinate for the `index`-th card in a horizontal row of
 * `count` cards spaced by `gap`, centred on `CENTER_X`. Each card is
 * placed so its own centre sits on the computed slot. Result is the
 * top-left `x` React Flow expects, i.e. `slotCentre - nodeWidth/2`.
 */
export function rowX(
  index: number,
  count: number,
  gap: number,
  nodeWidth: number,
): number {
  if (count <= 0) return CENTER_X - nodeWidth / 2;
  const span = (count - 1) * gap;
  const startCentre = CENTER_X - span / 2;
  const slotCentre = startCentre + index * gap;
  return slotCentre - nodeWidth / 2;
}

/** Convenience: position for a centred single node at the given `y`. */
export function centredX(nodeWidth: number): number {
  return CENTER_X - nodeWidth / 2;
}
