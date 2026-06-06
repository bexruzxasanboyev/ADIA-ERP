import type { AnimationTiming } from 'recharts/types/util/types';
import type { DashboardChartGranularity } from '@/lib/types';

/**
 * Shared animation tuning for the dashboard's Recharts area charts.
 *
 * The dark-premium dashboard charts use a subtle draw-in: the area sweeps in
 * from the left and the fill fades up. When the date-range filter switches
 * (Bugun ↔ Bu hafta ↔ Bu oy) the chart series is remounted via a changing
 * React `key` (see `chartSeriesKey`) so the draw-in replays instead of morphing
 * between datasets.
 *
 * Keep it tasteful — a clean ~360ms ease-out, no bounce.
 */
export const CHART_ANIMATION_DURATION = 360;
export const CHART_ANIMATION_EASING: AnimationTiming = 'ease-out';

/**
 * Builds a stable React `key` for an animated chart series from the rendered
 * buckets. The key changes whenever the underlying window changes — different
 * granularity (`hour` vs `day`) or a different first/last bucket date — which
 * is exactly when we want the draw-in animation to replay. It stays identical
 * across re-renders that don't change the data, so the animation doesn't
 * flicker on unrelated state updates.
 *
 * @param granularity bucket cadence (e.g. `'day'`, `'hour'`); may be undefined
 *   when the backend omits it — falls back to `'day'`.
 * @param buckets the rendered series; each item carries a `date` discriminator.
 */
export function chartSeriesKey(
  granularity: DashboardChartGranularity | undefined,
  buckets: ReadonlyArray<{ date: string }>,
): string {
  const cadence = granularity ?? 'day';
  const first = buckets[0];
  const last = buckets[buckets.length - 1];
  if (first === undefined || last === undefined) return `${cadence}:empty`;
  return `${cadence}:${first.date}:${last.date}:${buckets.length}`;
}
