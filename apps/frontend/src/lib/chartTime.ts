/**
 * Shared x-axis label formatting for date/hour-bucketed dashboard charts.
 *
 * The dashboard time-series endpoints (sales_chart and the per-stage detail
 * panels) are scoped by the DateRangeFilter. For every range EXCEPT "Bugun"
 * the backend returns DAY buckets (`granularity: 'day'`) and the chart shows
 * `DD.MM` labels. When the range is "Bugun" the series would otherwise
 * collapse to a single point, so the backend instead returns HOURLY buckets
 * (`granularity: 'hour'`), each carrying a `hour` (0-23) field, and the chart
 * shows `HH:00` labels (e.g. `08:00`, `14:00`).
 *
 * The label is derived purely from the data: a point with a numeric `hour`
 * renders the hour label; otherwise it falls back to the date label. This
 * keeps the helper backward-compatible — any series that does not (yet) send
 * `hour` continues to render exactly as before.
 */

/** A chart point that may be a day bucket or an hour bucket. */
export interface ChartBucketPoint {
  /** ISO `YYYY-MM-DD`. */
  date: string;
  /** 0-23, present only for hourly (granularity === 'hour') buckets. */
  hour?: number;
}

/** Granularity discriminator carried on a time-series response. */
export type ChartGranularity = 'hour' | 'day';

/** `HH:00`, zero-padded (e.g. 8 → `08:00`, 14 → `14:00`). */
export function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

/** `DD.MM` from an ISO `YYYY-MM-DD`; returns the input unchanged if unparseable. */
export function shortDateLabel(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (match === null) return iso;
  const [, , m, d] = match;
  return `${d}.${m}`;
}

/**
 * X-axis / tooltip label for one bucket.
 *
 * When `granularity` is `'hour'` (and the point carries a numeric `hour`) the
 * label is `HH:00`; otherwise it is the `DD.MM` date label. `granularity` is
 * optional: when omitted the label is derived purely from the data (a numeric
 * `hour` ⇒ hour label), so any series that only adds `hour` per point still
 * renders correctly without threading the discriminator.
 */
export function chartBucketLabel(
  point: ChartBucketPoint,
  granularity?: ChartGranularity,
): string {
  const isHourly =
    granularity === 'hour' ||
    (granularity === undefined && typeof point.hour === 'number');
  if (isHourly && typeof point.hour === 'number') return hourLabel(point.hour);
  return shortDateLabel(point.date);
}
