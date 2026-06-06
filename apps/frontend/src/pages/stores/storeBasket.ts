import type { StockRow, Unit } from '@/lib/types';

/**
 * A draft basket line — one product the store_manager has queued to request.
 * Keyed by `product_id` in the page-level basket state; carries the editable
 * `qty` plus display + stock-context fields so the Savat panel can render the
 * B2B meta line (Qoldiq / min / maks) and a refill suggestion without
 * re-resolving the source stock row.
 *
 * Stock-context fields (`current_qty`, `min_level`, `max_level`) default to 0
 * when a construction site has no stock row to read them from; the meta line
 * gracefully degrades when they are all zero.
 */
export interface BasketItem {
  product_id: number;
  product_name: string;
  product_unit: Unit;
  qty: number;
  current_qty: number;
  min_level: number;
  max_level: number;
}

/**
 * Build a `BasketItem` from a stock row, defaulting `qty` to refill-to-max.
 * The single construction site for basket lines (`toggleBasket`).
 */
export function basketItemFromStockRow(row: StockRow): BasketItem {
  return {
    product_id: row.product_id,
    product_name: row.product_name,
    product_unit: row.product_unit,
    qty: defaultBasketQty(row),
    current_qty: row.qty,
    min_level: row.min_level,
    max_level: row.max_level,
  };
}

/**
 * Default basket quantity for a stock row: refill-to-max (max − current),
 * floored at 1. When max/qty are unknown or already satisfied, default to 1.
 */
export function defaultBasketQty(row: StockRow): number {
  const refill = row.max_level - row.qty;
  return refill > 0 ? refill : 1;
}

/**
 * Suggested refill quantity for a basket line: max − current, floored at 1.
 * Used by the panel's "↻ To'ldirish: {n}" shortcut.
 */
export function refillQty(item: Pick<BasketItem, 'current_qty' | 'max_level'>): number {
  const refill = item.max_level - item.current_qty;
  return refill > 0 ? refill : 1;
}

/** Whether a line's stock context is meaningful (avoids a "Qoldiq 0 · min 0" line). */
export function hasStockContext(
  item: Pick<BasketItem, 'current_qty' | 'min_level' | 'max_level'>,
): boolean {
  return item.current_qty > 0 || item.min_level > 0 || item.max_level > 0;
}

export interface BasketTotals {
  /** Number of distinct product lines. */
  count: number;
  /** Summed quantity across lines — only meaningful when `mixedUnits` is false. */
  totalQty: number;
  /** The shared unit when all lines share one; `null` when mixed or empty. */
  unit: Unit | null;
  /** True when the basket mixes units (e.g. dona + kg) — don't sum across them. */
  mixedUnits: boolean;
}

/**
 * Totals for the footer line. When every line shares a unit we sum the
 * quantities and report that unit; when units are mixed (or the basket is
 * empty) we report only the line count and flag `mixedUnits` so the caller
 * shows "{count} ta mahsulot" without a misleading cross-unit sum.
 */
export function basketTotals(items: readonly BasketItem[]): BasketTotals {
  const count = items.length;
  const first = items[0];
  if (first === undefined) {
    return { count: 0, totalQty: 0, unit: null, mixedUnits: false };
  }
  const firstUnit = first.product_unit;
  const mixedUnits = items.some((i) => i.product_unit !== firstUnit);
  if (mixedUnits) {
    return { count, totalQty: 0, unit: null, mixedUnits: true };
  }
  const totalQty = items.reduce((sum, i) => sum + (i.qty > 0 ? i.qty : 0), 0);
  return { count, totalQty, unit: firstUnit, mixedUnits: false };
}
