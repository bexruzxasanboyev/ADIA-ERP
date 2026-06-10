// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { FlowRequest } from '@/lib/replenishmentFlow';
import type { ReplenishmentStatus, Unit } from '@/lib/types';
import {
  centralBucketOf,
  isProductionWaitingRaw,
  partitionByBucket,
  productionBucketOf,
  rawPurchaseOrderBucketOf,
  rawRequestBucketOf,
  storeBucketOf,
} from './workBuckets';

/** Minimal full-shape FlowRequest for the pure bucket functions. */
function makeReq(overrides: Partial<FlowRequest> = {}): FlowRequest {
  return {
    id: 1,
    product_id: 10,
    requester_location_id: 100,
    target_location_id: 200,
    qty_needed: 5,
    status: 'NEW' as ReplenishmentStatus,
    production_order_id: null,
    purchase_order_id: null,
    shipment_movement_id: null,
    note: null,
    created_by: null,
    created_at: '2026-06-10T08:00:00Z',
    updated_at: '2026-06-10T08:00:00Z',
    closed_at: null,
    product_name: 'Napoleon',
    product_unit: 'kg' as Unit,
    requester_location_name: 'Kukcha',
    target_location_name: 'Markaziy sklad',
    production_location_name: null,
    route_to_production_manual: false,
    received_from_production_at: null,
    ...overrides,
  };
}

describe('productionBucketOf', () => {
  it('puts a not-yet-accepted gate row in YANGI', () => {
    const req = makeReq({
      status: 'CHECK_PRODUCTION_INPUT',
      production_location_id: 7,
      fulfiller_accepted_at: null,
    });
    expect(productionBucketOf(req)).toBe('yangi');
  });

  it('puts an accepted row WITHOUT a zayafka in JARAYONDA', () => {
    const req = makeReq({
      status: 'CHECK_PRODUCTION_INPUT',
      production_location_id: 7,
      fulfiller_accepted_at: '2026-06-10T09:00:00Z',
      production_order_id: null,
    });
    expect(productionBucketOf(req)).toBe('jarayonda');
  });

  it('puts a row WITH an open zayafka in TAYYOR (Tayyor — skladga)', () => {
    const req = makeReq({
      status: 'PRODUCING',
      fulfiller_accepted_at: '2026-06-10T09:00:00Z',
      production_order_id: 55,
    });
    expect(productionBucketOf(req)).toBe('tayyor');
  });

  it('drops DONE_TO_WAREHOUSE / CLOSED rows off the feed', () => {
    expect(productionBucketOf(makeReq({ status: 'DONE_TO_WAREHOUSE' }))).toBe(
      null,
    );
    expect(productionBucketOf(makeReq({ status: 'CLOSED' }))).toBe(null);
  });

  it('flags the raw-material wait (no button) only without a zayafka', () => {
    expect(
      isProductionWaitingRaw(
        makeReq({ status: 'CREATE_PURCHASE_ORDER', production_order_id: null }),
      ),
    ).toBe(true);
    expect(
      isProductionWaitingRaw(
        makeReq({ status: 'CREATE_PURCHASE_ORDER', production_order_id: 9 }),
      ),
    ).toBe(false);
  });
});

describe('centralBucketOf', () => {
  const CENTRAL = 200;

  it('puts a waiting store order in YANGI', () => {
    const req = makeReq({ status: 'NEW', requester_location_id: 100 });
    expect(centralBucketOf(req, CENTRAL)).toBe('yangi');
  });

  it('excludes central’s OWN raised request from YANGI', () => {
    const req = makeReq({ status: 'NEW', requester_location_id: CENTRAL });
    expect(centralBucketOf(req, CENTRAL)).toBe(null);
  });

  it('puts a production arrival (DONE_TO_WAREHOUSE) in TAYYOR', () => {
    const req = makeReq({ status: 'DONE_TO_WAREHOUSE' });
    expect(centralBucketOf(req, CENTRAL)).toBe('tayyor');
  });

  it('puts a shipped-awaiting-store row in JARAYONDA', () => {
    // Plain central-stock ship: SHIP_TO_REQUESTER without the production
    // receipt stamp resolves to the yuborilgan stage.
    const req = makeReq({ status: 'SHIP_TO_REQUESTER' });
    expect(centralBucketOf(req, CENTRAL)).toBe('jarayonda');
  });

  it('drops in-production rows (soralgan) — production owns those cards', () => {
    const req = makeReq({ status: 'PRODUCING' });
    expect(centralBucketOf(req, CENTRAL)).toBe(null);
  });
});

describe('storeBucketOf', () => {
  const scope = new Set([100]);

  it('puts a reserved-shipped arrival in TAYYOR', () => {
    const req = makeReq({
      status: 'CLOSED',
      closure_reason: null,
      fulfiller_accepted_at: '2026-06-10T09:00:00Z',
    });
    expect(storeBucketOf(req, scope)).toBe('tayyor');
  });

  it('puts my open in-flight order in JARAYONDA', () => {
    expect(storeBucketOf(makeReq({ status: 'PRODUCING' }), scope)).toBe(
      'jarayonda',
    );
  });

  it('drops terminal and foreign rows', () => {
    expect(
      storeBucketOf(makeReq({ status: 'CLOSED', closed_at: 'x' }), scope),
    ).toBe(null);
    expect(storeBucketOf(makeReq({ status: 'CANCELLED' }), scope)).toBe(null);
    expect(
      storeBucketOf(makeReq({ requester_location_id: 999 }), scope),
    ).toBe(null);
  });
});

describe('rawRequestBucketOf / rawPurchaseOrderBucketOf', () => {
  it('puts a fresh department request in YANGI', () => {
    const req = makeReq({ status: 'NEW', fulfiller_accepted_at: null });
    expect(rawRequestBucketOf(req)).toBe('yangi');
  });

  it('puts an accepted Poster-waiting hold in JARAYONDA', () => {
    const req = makeReq({
      status: 'NEW',
      target_location_type: 'raw_warehouse',
      fulfiller_accepted_at: '2026-06-10T09:00:00Z',
    });
    expect(rawRequestBucketOf(req)).toBe('jarayonda');
  });

  it('buckets POs: keeper-unsigned draft → YANGI, approved → TAYYOR', () => {
    expect(
      rawPurchaseOrderBucketOf({ status: 'draft', keeper_approved_by: null }),
    ).toBe('yangi');
    expect(
      rawPurchaseOrderBucketOf({ status: 'draft', keeper_approved_by: 3 }),
    ).toBe(null);
    expect(
      rawPurchaseOrderBucketOf({ status: 'approved', keeper_approved_by: 3 }),
    ).toBe('tayyor');
    expect(
      rawPurchaseOrderBucketOf({ status: 'received', keeper_approved_by: 3 }),
    ).toBe(null);
  });
});

describe('partitionByBucket', () => {
  it('splits rows into the three groups, newest first', () => {
    const rows = [
      makeReq({ id: 1, status: 'NEW' }),
      makeReq({ id: 2, status: 'NEW' }),
      makeReq({ id: 3, status: 'DONE_TO_WAREHOUSE' }),
      makeReq({ id: 4, status: 'CLOSED' }),
    ];
    const buckets = partitionByBucket(rows, (r) => centralBucketOf(r, 200));
    expect(buckets.yangi.map((r) => r.id)).toEqual([2, 1]);
    expect(buckets.tayyor.map((r) => r.id)).toEqual([3]);
    expect(buckets.jarayonda).toEqual([]);
  });
});
