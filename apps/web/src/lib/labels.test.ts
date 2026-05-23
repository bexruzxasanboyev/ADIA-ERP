import { describe, it, expect } from 'vitest';
import {
  ROLE_LABELS,
  ROLE_OPTIONS,
  LOCATION_TYPE_OPTIONS,
  PRODUCT_TYPE_OPTIONS,
  UNIT_OPTIONS,
  MOVEMENT_REASON_LABELS,
  REPLENISHMENT_STATUS_LABELS,
  REPLENISHMENT_STATUS_OPTIONS,
  PRODUCTION_ORDER_STATUS_LABELS,
  PRODUCTION_ORDER_STATUS_OPTIONS,
  PURCHASE_ORDER_STATUS_LABELS,
  PURCHASE_ORDER_STATUS_OPTIONS,
} from './labels';

describe('domain labels', () => {
  it('has an Uzbek label for every role', () => {
    expect(ROLE_LABELS.pm).toBe('Loyiha rahbari');
    expect(ROLE_OPTIONS).toHaveLength(6);
  });

  it('exposes select options for each enum', () => {
    expect(LOCATION_TYPE_OPTIONS).toHaveLength(5);
    expect(PRODUCT_TYPE_OPTIONS).toHaveLength(3);
    expect(UNIT_OPTIONS).toHaveLength(3);
  });

  it('translates movement reasons', () => {
    expect(MOVEMENT_REASON_LABELS.transfer).toBe('Ko‘chirish');
    expect(MOVEMENT_REASON_LABELS.sale).toBe('Savdo');
  });

  it('covers all 10 replenishment statuses with Uzbek labels', () => {
    expect(REPLENISHMENT_STATUS_OPTIONS).toHaveLength(10);
    expect(REPLENISHMENT_STATUS_LABELS.NEW).toBe('Yangi');
    expect(REPLENISHMENT_STATUS_LABELS.CLOSED).toBe('Yopilgan');
    expect(REPLENISHMENT_STATUS_LABELS.CANCELLED).toBe('Bekor qilingan');
  });

  it('covers all 4 production order statuses', () => {
    expect(PRODUCTION_ORDER_STATUS_OPTIONS).toHaveLength(4);
    expect(PRODUCTION_ORDER_STATUS_LABELS.new).toBe('Yangi');
    expect(PRODUCTION_ORDER_STATUS_LABELS.done).toBe('Yakunlangan');
  });

  it('covers all 5 purchase order statuses', () => {
    expect(PURCHASE_ORDER_STATUS_OPTIONS).toHaveLength(5);
    expect(PURCHASE_ORDER_STATUS_LABELS.draft).toBe('Loyiha');
    expect(PURCHASE_ORDER_STATUS_LABELS.received).toBe('Qabul qilingan');
  });
});
