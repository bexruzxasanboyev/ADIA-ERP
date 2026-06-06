/**
 * Pure aggregation helpers for the So'rovlar (requests) charts on the store
 * workflow page. Kept framework-free so the bucketing logic can be unit-tested
 * directly without rendering Recharts (which renders at 0×0 in jsdom and never
 * paints axis text).
 *
 * The owner's display buckets map the raw 10-status replenishment state machine
 * into three plain-language groups (plus a grand total):
 *
 *   - "Qabul qilingan"   = CLOSED      (request fulfilled & received)
 *   - "Qabul qilinmagan" = CANCELLED   (request rejected / cancelled)
 *   - "Jarayonda"        = everything else (all in-flight statuses)
 */
import type { ReplenishmentRequest, ReplenishmentStatus } from '@/lib/types';

/** The three owner-named display buckets a request's status maps into. */
export type RequestStatusBucket = 'accepted' | 'rejected' | 'inflight';

/** Per-bucket counts plus the grand total (the donut centre figure). */
export interface RequestStatusCounts {
  total: number;
  accepted: number;
  rejected: number;
  inflight: number;
}

/** Map one raw replenishment status into its owner-named display bucket. */
export function bucketOfStatus(status: ReplenishmentStatus): RequestStatusBucket {
  if (status === 'CLOSED') return 'accepted';
  if (status === 'CANCELLED') return 'rejected';
  return 'inflight';
}

/**
 * Count a set of requests by display bucket. The caller passes the requests it
 * has ALREADY scoped + date-filtered (the same set the "So'rov" sub-tab shows),
 * so this is a pure tally with no filtering of its own.
 */
export function countByStatusBucket(
  requests: readonly ReplenishmentRequest[],
): RequestStatusCounts {
  const counts: RequestStatusCounts = {
    total: requests.length,
    accepted: 0,
    rejected: 0,
    inflight: 0,
  };
  for (const r of requests) {
    counts[bucketOfStatus(r.status)] += 1;
  }
  return counts;
}

/** One point on the per-day requests-created trend (epoch-day bucketed). */
export interface RequestTrendPoint {
  /** `YYYY-MM-DD` (local day) — stable key + sort discriminator. */
  date: string;
  /** Requests created on this day within the active range. */
  count: number;
}

/** Zero-pads a number to two digits (local date formatting). */
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Local `YYYY-MM-DD` key for a Date (NOT UTC — buckets follow local days). */
function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * Bucket requests by their `created_at` local day, returning one ascending
 * point per day that actually has requests. Days with zero requests are
 * omitted (the area chart connects between points) — matching how the
 * dashboard sales series renders only the days the backend returns.
 *
 * The caller passes the already scoped + range-filtered requests, so every
 * input row counts.
 */
export function trendByDay(
  requests: readonly ReplenishmentRequest[],
): RequestTrendPoint[] {
  const byDay = new Map<string, number>();
  for (const r of requests) {
    const t = new Date(r.created_at).getTime();
    if (Number.isNaN(t)) continue;
    const key = localDayKey(new Date(t));
    byDay.set(key, (byDay.get(key) ?? 0) + 1);
  }
  return [...byDay.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** `YYYY-MM-DD` → `DD.MM` for the trend chart x-axis ticks. */
export function trendAxisLabel(isoDay: string): string {
  const parts = isoDay.split('-');
  if (parts.length !== 3) return isoDay;
  const [, month, day] = parts;
  return `${day}.${month}`;
}
