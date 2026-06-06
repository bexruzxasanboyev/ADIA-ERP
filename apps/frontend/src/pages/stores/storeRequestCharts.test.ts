/**
 * Unit tests for the So'rovlar charts aggregation helpers.
 *
 * Per project memory (jsdom hangs + Recharts renders at 0×0 in jsdom, so axis
 * text never appears) these tests exercise the PURE bucketing/aggregation
 * logic directly — no component render, no SVG assertions.
 */
import { describe, expect, it } from 'vitest';
import {
  bucketOfStatus,
  countByStatusBucket,
  trendAxisLabel,
  trendByDay,
} from './storeRequestCharts';
import type {
  ReplenishmentRequest,
  ReplenishmentStatus,
} from '@/lib/types';

/** Minimal request factory — only the fields the helpers read matter. */
function req(
  status: ReplenishmentStatus,
  created_at: string,
  id = 1,
): ReplenishmentRequest {
  return {
    id,
    product_id: 1,
    requester_location_id: 10,
    target_location_id: null,
    qty_needed: 1,
    status,
    production_order_id: null,
    purchase_order_id: null,
    shipment_movement_id: null,
    note: null,
    created_by: null,
    created_at,
    updated_at: created_at,
    closed_at: null,
  } as ReplenishmentRequest;
}

describe('bucketOfStatus', () => {
  it('maps CLOSED → accepted', () => {
    expect(bucketOfStatus('CLOSED')).toBe('accepted');
  });

  it('maps CANCELLED → rejected', () => {
    expect(bucketOfStatus('CANCELLED')).toBe('rejected');
  });

  it('maps every non-terminal status → inflight', () => {
    const inflight: ReplenishmentStatus[] = [
      'NEW',
      'CHECK_STORE_SUPPLIER',
      'SHIP_TO_REQUESTER',
      'CHECK_PRODUCTION_INPUT',
      'CREATE_PURCHASE_ORDER',
      'CREATE_PRODUCTION_ORDER',
      'PRODUCING',
      'DONE_TO_WAREHOUSE',
    ];
    for (const s of inflight) {
      expect(bucketOfStatus(s)).toBe('inflight');
    }
  });
});

describe('countByStatusBucket', () => {
  it('returns all-zero counts for an empty input', () => {
    expect(countByStatusBucket([])).toEqual({
      total: 0,
      accepted: 0,
      rejected: 0,
      inflight: 0,
    });
  });

  it('tallies each bucket and the grand total', () => {
    const rows = [
      req('CLOSED', '2026-06-01T08:00:00Z', 1),
      req('CLOSED', '2026-06-01T09:00:00Z', 2),
      req('CANCELLED', '2026-06-02T08:00:00Z', 3),
      req('NEW', '2026-06-03T08:00:00Z', 4),
      req('PRODUCING', '2026-06-03T09:00:00Z', 5),
      req('SHIP_TO_REQUESTER', '2026-06-03T10:00:00Z', 6),
    ];
    expect(countByStatusBucket(rows)).toEqual({
      total: 6,
      accepted: 2,
      rejected: 1,
      inflight: 3,
    });
  });

  it('keeps total === accepted + rejected + inflight (partition)', () => {
    const rows = [
      req('CLOSED', '2026-06-01T00:00:00Z', 1),
      req('CANCELLED', '2026-06-01T00:00:00Z', 2),
      req('CHECK_PRODUCTION_INPUT', '2026-06-01T00:00:00Z', 3),
      req('DONE_TO_WAREHOUSE', '2026-06-01T00:00:00Z', 4),
    ];
    const c = countByStatusBucket(rows);
    expect(c.accepted + c.rejected + c.inflight).toBe(c.total);
  });
});

describe('trendByDay', () => {
  it('returns no points for an empty input', () => {
    expect(trendByDay([])).toEqual([]);
  });

  it('buckets requests by local day and counts per day', () => {
    // Two on 2026-06-01, one on 2026-06-03 (local time).
    const rows = [
      req('NEW', '2026-06-01T08:00:00', 1),
      req('CLOSED', '2026-06-01T20:00:00', 2),
      req('CANCELLED', '2026-06-03T12:00:00', 3),
    ];
    expect(trendByDay(rows)).toEqual([
      { date: '2026-06-01', count: 2 },
      { date: '2026-06-03', count: 1 },
    ]);
  });

  it('returns points in ascending date order', () => {
    const rows = [
      req('NEW', '2026-06-05T08:00:00', 1),
      req('NEW', '2026-06-02T08:00:00', 2),
      req('NEW', '2026-06-09T08:00:00', 3),
    ];
    const dates = trendByDay(rows).map((p) => p.date);
    expect(dates).toEqual(['2026-06-02', '2026-06-05', '2026-06-09']);
  });

  it('skips rows with an unparseable created_at', () => {
    const rows = [
      req('NEW', 'not-a-date', 1),
      req('NEW', '2026-06-04T08:00:00', 2),
    ];
    expect(trendByDay(rows)).toEqual([{ date: '2026-06-04', count: 1 }]);
  });
});

describe('trendAxisLabel', () => {
  it('formats YYYY-MM-DD as DD.MM', () => {
    expect(trendAxisLabel('2026-06-09')).toBe('09.06');
    expect(trendAxisLabel('2026-12-31')).toBe('31.12');
  });

  it('returns the input unchanged when not a date key', () => {
    expect(trendAxisLabel('weird')).toBe('weird');
  });
});
