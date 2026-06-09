import { describe, it, expect } from 'vitest';
import {
  REPLENISHMENT_BUCKETS,
  statusInBucket,
  type ReplenishmentBucket,
} from './statusBuckets';
import type { ReplenishmentRequest, ReplenishmentStatus } from '@/lib/types';

/**
 * `statusInBucket` now buckets on the canonical 5-stage `pipeline_stage`
 * grammar (cross-department-flow §9.1) instead of the retired 4-bucket scheme.
 * It takes the whole request so it can honour the backend's authoritative
 * `pipeline_stage`, falling back to the status heuristic (`pipelineStageOf`)
 * when that field is absent.
 */

/** A minimal request carrying just the fields the stage resolver reads. */
function makeReq(
  status: ReplenishmentStatus,
  overrides: Partial<ReplenishmentRequest> = {},
): ReplenishmentRequest {
  return {
    id: 1,
    product_id: 1,
    requester_location_id: 1,
    target_location_id: null,
    qty_needed: 1,
    status,
    production_order_id: null,
    purchase_order_id: null,
    shipment_movement_id: null,
    note: null,
    created_by: null,
    created_at: '2026-06-10T00:00:00.000Z',
    updated_at: '2026-06-10T00:00:00.000Z',
    closed_at: null,
    product_name: 'X',
    product_unit: 'kg',
    requester_location_name: 'A',
    target_location_name: null,
    production_location_name: null,
    route_to_production_manual: false,
    received_from_production_at: null,
    ...overrides,
  };
}

const ALL_STATUSES: ReplenishmentStatus[] = [
  'NEW',
  'CHECK_STORE_SUPPLIER',
  'SHIP_TO_REQUESTER',
  'CHECK_PRODUCTION_INPUT',
  'CREATE_PURCHASE_ORDER',
  'CREATE_PRODUCTION_ORDER',
  'PRODUCING',
  'DONE_TO_WAREHOUSE',
  'CLOSED',
  'CANCELLED',
];

const STAGE_BUCKETS: ReplenishmentBucket[] = [
  'kutuvda',
  'soralgan',
  'qabul_qilingan',
  'yuborilgan',
  'yopilgan',
];

describe('statusInBucket (pipeline_stage)', () => {
  it('"all" matches every status, including CANCELLED', () => {
    for (const s of ALL_STATUSES) {
      expect(statusInBucket(makeReq(s), 'all')).toBe(true);
    }
  });

  it('prefers the backend pipeline_stage verbatim when present', () => {
    // A SHIP_TO_REQUESTER row that the backend pins to `qabul_qilingan`.
    const req = makeReq('SHIP_TO_REQUESTER', {
      pipeline_stage: 'qabul_qilingan',
    });
    expect(statusInBucket(req, 'qabul_qilingan')).toBe(true);
    expect(statusInBucket(req, 'yuborilgan')).toBe(false);
  });

  it('falls back to the status heuristic — Kutuvda', () => {
    for (const s of ['NEW', 'CHECK_STORE_SUPPLIER', 'DONE_TO_WAREHOUSE'] as const) {
      expect(statusInBucket(makeReq(s), 'kutuvda')).toBe(true);
    }
  });

  it('falls back to the status heuristic — Tayyorlanmoqda (soralgan)', () => {
    for (const s of [
      'CHECK_PRODUCTION_INPUT',
      'CREATE_PURCHASE_ORDER',
      'CREATE_PRODUCTION_ORDER',
      'PRODUCING',
    ] as const) {
      expect(statusInBucket(makeReq(s), 'soralgan')).toBe(true);
    }
  });

  it('SHIP_TO_REQUESTER → yuborilgan (plain ship) / qabul_qilingan (from production)', () => {
    expect(statusInBucket(makeReq('SHIP_TO_REQUESTER'), 'yuborilgan')).toBe(true);
    const fromProd = makeReq('SHIP_TO_REQUESTER', {
      received_from_production_at: '2026-06-10T01:00:00.000Z',
    });
    expect(statusInBucket(fromProd, 'qabul_qilingan')).toBe(true);
  });

  it('CLOSED and CANCELLED → yopilgan', () => {
    expect(statusInBucket(makeReq('CLOSED'), 'yopilgan')).toBe(true);
    expect(statusInBucket(makeReq('CANCELLED'), 'yopilgan')).toBe(true);
  });

  it('every request resolves to exactly one stage bucket', () => {
    for (const s of ALL_STATUSES) {
      const req = makeReq(s);
      const hits = STAGE_BUCKETS.filter((b) => statusInBucket(req, b));
      expect(hits.length).toBe(1);
    }
  });
});

describe('REPLENISHMENT_BUCKETS', () => {
  it('exposes the six tabs in display order with the §9.1 Uzbek labels', () => {
    expect(REPLENISHMENT_BUCKETS.map((b) => b.value)).toEqual([
      'all',
      'kutuvda',
      'soralgan',
      'qabul_qilingan',
      'yuborilgan',
      'yopilgan',
    ]);
    expect(REPLENISHMENT_BUCKETS.map((b) => b.label)).toEqual([
      'Hammasi',
      'Kutuvda',
      'Tayyorlanmoqda',
      'Tayyor',
      'Jo‘natildi',
      'Yopildi',
    ]);
  });
});
