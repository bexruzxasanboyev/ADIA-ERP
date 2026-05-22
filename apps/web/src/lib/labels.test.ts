import { describe, it, expect } from 'vitest';
import {
  ROLE_LABELS,
  ROLE_OPTIONS,
  LOCATION_TYPE_OPTIONS,
  PRODUCT_TYPE_OPTIONS,
  UNIT_OPTIONS,
  MOVEMENT_REASON_LABELS,
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
});
