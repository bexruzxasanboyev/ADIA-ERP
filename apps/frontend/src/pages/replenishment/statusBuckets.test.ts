import { describe, it, expect } from 'vitest';
import {
  REPLENISHMENT_BUCKETS,
  statusInBucket,
  type ReplenishmentBucket,
} from './statusBuckets';
import type { ReplenishmentStatus } from '@/lib/types';

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

describe('statusInBucket', () => {
  it('"all" matches every status, including CANCELLED', () => {
    for (const s of ALL_STATUSES) {
      expect(statusInBucket(s, 'all')).toBe(true);
    }
  });

  it('"pending" = in-flight statuses (NEW … DONE_TO_WAREHOUSE), excludes shipped/closed/cancelled', () => {
    const pending: ReplenishmentStatus[] = [
      'NEW',
      'CHECK_STORE_SUPPLIER',
      'CHECK_PRODUCTION_INPUT',
      'CREATE_PURCHASE_ORDER',
      'CREATE_PRODUCTION_ORDER',
      'PRODUCING',
      'DONE_TO_WAREHOUSE',
    ];
    for (const s of pending) expect(statusInBucket(s, 'pending')).toBe(true);
    for (const s of ['SHIP_TO_REQUESTER', 'CLOSED', 'CANCELLED'] as const) {
      expect(statusInBucket(s, 'pending')).toBe(false);
    }
  });

  it('"sent" = SHIP_TO_REQUESTER only', () => {
    expect(statusInBucket('SHIP_TO_REQUESTER', 'sent')).toBe(true);
    for (const s of ALL_STATUSES.filter((x) => x !== 'SHIP_TO_REQUESTER')) {
      expect(statusInBucket(s, 'sent')).toBe(false);
    }
  });

  it('"closed" = CLOSED only', () => {
    expect(statusInBucket('CLOSED', 'closed')).toBe(true);
    for (const s of ALL_STATUSES.filter((x) => x !== 'CLOSED')) {
      expect(statusInBucket(s, 'closed')).toBe(false);
    }
  });

  it('CANCELLED appears ONLY under "all"', () => {
    const buckets: ReplenishmentBucket[] = ['all', 'pending', 'sent', 'closed'];
    for (const b of buckets) {
      expect(statusInBucket('CANCELLED', b)).toBe(b === 'all');
    }
  });

  it('every status maps to exactly one of pending/sent/closed, except CANCELLED (none)', () => {
    for (const s of ALL_STATUSES) {
      const hits = (['pending', 'sent', 'closed'] as const).filter((b) =>
        statusInBucket(s, b),
      );
      expect(hits.length).toBe(s === 'CANCELLED' ? 0 : 1);
    }
  });
});

describe('REPLENISHMENT_BUCKETS', () => {
  it('exposes the four tabs in display order with Uzbek labels', () => {
    expect(REPLENISHMENT_BUCKETS.map((b) => b.value)).toEqual([
      'all',
      'pending',
      'sent',
      'closed',
    ]);
    expect(REPLENISHMENT_BUCKETS.map((b) => b.label)).toEqual([
      'Hammasi',
      'Kutib turgan',
      'Yuborgan',
      'Qabul qilgan',
    ]);
  });
});
