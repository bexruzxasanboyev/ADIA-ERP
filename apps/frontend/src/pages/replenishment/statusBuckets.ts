import type { ReplenishmentStatus } from '@/lib/types';

/**
 * The status sub-tab buckets of the replenishment workspace (owner feedback).
 * The 10-status state machine is collapsed into four user-facing groups:
 *
 *   - `all`     — every row (including CANCELLED);
 *   - `pending` — anything still in flight (NEW … DONE_TO_WAREHOUSE);
 *   - `sent`    — SHIP_TO_REQUESTER (on its way to the requester);
 *   - `closed`  — CLOSED (received).
 *
 * CANCELLED is intentionally NOT in `pending`/`sent`/`closed`; it surfaces
 * only under `all`.
 */
export type ReplenishmentBucket = 'all' | 'pending' | 'sent' | 'closed';

/** Statuses that count as "Kutib turgan" (in flight, not yet shipped). */
const PENDING_STATUSES: readonly ReplenishmentStatus[] = [
  'NEW',
  'CHECK_STORE_SUPPLIER',
  'CHECK_PRODUCTION_INPUT',
  'CREATE_PURCHASE_ORDER',
  'CREATE_PRODUCTION_ORDER',
  'PRODUCING',
  'DONE_TO_WAREHOUSE',
];

/**
 * True when `status` belongs to `bucket`. Pure — drives both the active-tab
 * filter and the per-tab counts. `all` matches everything; the other buckets
 * are mutually exclusive and exclude CANCELLED.
 */
export function statusInBucket(
  status: ReplenishmentStatus,
  bucket: ReplenishmentBucket,
): boolean {
  switch (bucket) {
    case 'all':
      return true;
    case 'pending':
      return PENDING_STATUSES.includes(status);
    case 'sent':
      return status === 'SHIP_TO_REQUESTER';
    case 'closed':
      return status === 'CLOSED';
    default:
      return false;
  }
}

/** Tab order + Uzbek labels for the status sub-tab strip. */
export const REPLENISHMENT_BUCKETS: readonly {
  value: ReplenishmentBucket;
  label: string;
}[] = [
  { value: 'all', label: 'Hammasi' },
  { value: 'pending', label: 'Kutib turgan' },
  { value: 'sent', label: 'Yuborgan' },
  { value: 'closed', label: 'Qabul qilgan' },
];
