import { describe, expect, it } from 'vitest';
import type { StockRow } from '@/lib/types';
import {
  basketItemFromStockRow,
  basketTotals,
  defaultBasketQty,
  hasStockContext,
  refillQty,
  type BasketItem,
} from './storeBasket';

function stockRow(over: Partial<StockRow> = {}): StockRow {
  return {
    location_id: 1,
    product_id: 10,
    qty: 4,
    min_level: 6,
    max_level: 20,
    minmax_mode: 'manual',
    updated_at: '2026-06-06T00:00:00Z',
    product_name: 'Tort',
    product_unit: 'pcs',
    ...over,
  };
}

function item(over: Partial<BasketItem> = {}): BasketItem {
  return {
    product_id: 1,
    product_name: 'A',
    product_unit: 'pcs',
    qty: 1,
    current_qty: 0,
    min_level: 0,
    max_level: 0,
    ...over,
  };
}

describe('defaultBasketQty', () => {
  it('defaults to refill-to-max (max − current)', () => {
    expect(defaultBasketQty(stockRow({ qty: 4, max_level: 20 }))).toBe(16);
  });
  it('floors at 1 when already at/over max', () => {
    expect(defaultBasketQty(stockRow({ qty: 20, max_level: 20 }))).toBe(1);
    expect(defaultBasketQty(stockRow({ qty: 25, max_level: 20 }))).toBe(1);
  });
});

describe('basketItemFromStockRow', () => {
  it('carries the stock context and a refill-to-max default qty', () => {
    const it0 = basketItemFromStockRow(
      stockRow({ qty: 4, min_level: 6, max_level: 20, product_unit: 'kg' }),
    );
    expect(it0).toMatchObject({
      product_id: 10,
      product_name: 'Tort',
      product_unit: 'kg',
      qty: 16,
      current_qty: 4,
      min_level: 6,
      max_level: 20,
    });
  });
});

describe('refillQty', () => {
  it('is max − current, floored at 1', () => {
    expect(refillQty({ current_qty: 4, max_level: 20 })).toBe(16);
    expect(refillQty({ current_qty: 20, max_level: 20 })).toBe(1);
  });
});

describe('hasStockContext', () => {
  it('is false only when all of current/min/max are zero', () => {
    expect(hasStockContext({ current_qty: 0, min_level: 0, max_level: 0 })).toBe(
      false,
    );
    expect(hasStockContext({ current_qty: 0, min_level: 6, max_level: 0 })).toBe(
      true,
    );
  });
});

describe('basketTotals', () => {
  it('is empty for no items', () => {
    expect(basketTotals([])).toEqual({
      count: 0,
      totalQty: 0,
      unit: null,
      mixedUnits: false,
    });
  });

  it('sums quantities when every line shares a unit', () => {
    const totals = basketTotals([
      item({ product_id: 1, product_unit: 'kg', qty: 3 }),
      item({ product_id: 2, product_unit: 'kg', qty: 5 }),
    ]);
    expect(totals).toEqual({
      count: 2,
      totalQty: 8,
      unit: 'kg',
      mixedUnits: false,
    });
  });

  it('does NOT sum across mixed units — count only', () => {
    const totals = basketTotals([
      item({ product_id: 1, product_unit: 'kg', qty: 3 }),
      item({ product_id: 2, product_unit: 'pcs', qty: 5 }),
    ]);
    expect(totals.mixedUnits).toBe(true);
    expect(totals.unit).toBeNull();
    expect(totals.totalQty).toBe(0);
    expect(totals.count).toBe(2);
  });

  it('ignores non-positive quantities in the sum', () => {
    const totals = basketTotals([
      item({ product_id: 1, product_unit: 'pcs', qty: 4 }),
      item({ product_id: 2, product_unit: 'pcs', qty: 0 }),
    ]);
    expect(totals.totalQty).toBe(4);
    expect(totals.count).toBe(2);
  });
});
