import { useEffect, useMemo, useState } from 'react';
import {
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Sector,
  type PieProps,
} from 'recharts';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/PageState';
import { formatPlainNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { ReplenishmentRequest } from '@/lib/types';
import {
  countByStatusBucket,
  type RequestStatusBucket,
} from './storeRequestCharts';

/**
 * So'rovlar tab — request count by STATUS bucket as a donut + legend, mirroring
 * the dashboard's RevenueBreakdown widget (donut left, legend rows right, grand
 * total in the centre).
 *
 * The three owner-named buckets (see `storeRequestCharts.bucketOfStatus`):
 *   - "Qabul qilingan"   = CLOSED      → emerald (success)
 *   - "Qabul qilinmagan" = CANCELLED   → red (destructive)
 *   - "Jarayonda"        = everything else (in-flight) → amber
 *
 * The caller passes the requests it has ALREADY scoped to the store and
 * filtered to the active date range, so this widget only tallies + draws.
 */

// Literal hsl values (not CSS vars) so colours resolve in jsdom and stay
// distinct on the dark theme — same convention as RevenueBreakdown.
const BUCKET_COLOUR: Record<RequestStatusBucket, string> = {
  accepted: 'hsl(152 60% 48%)', // emerald / success
  rejected: 'hsl(0 72% 58%)', // red / destructive
  inflight: 'hsl(38 92% 55%)', // amber
};

const BUCKET_LABEL: Record<RequestStatusBucket, string> = {
  accepted: 'Qabul qilingan',
  rejected: 'Qabul qilinmagan',
  inflight: 'Jarayonda',
};

// Stable legend / slice order.
const BUCKET_ORDER: RequestStatusBucket[] = ['accepted', 'inflight', 'rejected'];

function formatPct(part: number, total: number): string {
  if (total <= 0 || !Number.isFinite(part)) return '0%';
  const pct = (part / total) * 100;
  return `${pct >= 10 ? Math.round(pct) : pct.toFixed(1)}%`;
}

interface DonutSlice {
  key: RequestStatusBucket;
  label: string;
  value: number;
  colour: string;
}

/**
 * Active-slice renderer — keeps the exact radii (no reflow) and reads as active
 * via a brighter, thicker stroke ring. Mirrors RevenueBreakdown.
 */
const renderActiveSector: PieProps['activeShape'] = (props: unknown) => {
  const p = props as {
    cx: number;
    cy: number;
    innerRadius: number;
    outerRadius: number;
    startAngle: number;
    endAngle: number;
    fill: string;
  };
  return (
    <Sector
      cx={p.cx}
      cy={p.cy}
      innerRadius={p.innerRadius}
      outerRadius={p.outerRadius}
      startAngle={p.startAngle}
      endAngle={p.endAngle}
      fill={p.fill}
      stroke="hsl(0 0% 100% / 0.9)"
      strokeWidth={2.5}
    />
  );
};

export function StoreRequestsStatusDonut({
  requests,
  className,
}: {
  /** Store-scoped, date-range-filtered requests (the "So'rov" set). */
  requests: ReplenishmentRequest[];
  className?: string;
}) {
  const counts = useMemo(() => countByStatusBucket(requests), [requests]);

  // Legend rows in stable order; slices omit zero-count buckets (the donut
  // only draws what exists), like RevenueBreakdown.
  const legendRows = useMemo<DonutSlice[]>(
    () =>
      BUCKET_ORDER.map((key) => ({
        key,
        label: BUCKET_LABEL[key],
        value: counts[key],
        colour: BUCKET_COLOUR[key],
      })),
    [counts],
  );
  const slices = useMemo(
    () => legendRows.filter((r) => r.value > 0),
    [legendRows],
  );
  const sliceIndexByKey = useMemo(
    () => new Map(slices.map((s, i) => [s.key, i] as const)),
    [slices],
  );

  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  // Entrance sweep plays once on the first non-empty render, then disarms so
  // hover re-renders don't replay it. A changing data set (filter change)
  // re-mounts the <Pie> via its key so the sweep replays for the new data.
  const [hasAnimated, setHasAnimated] = useState(false);
  const hasSlices = slices.length > 0;
  useEffect(() => {
    if (!hasSlices || hasAnimated) return;
    const id = window.setTimeout(() => setHasAnimated(true), 850);
    return () => window.clearTimeout(id);
  }, [hasSlices, hasAnimated]);

  const activeSlice =
    activeIndex !== null ? (slices[activeIndex] ?? null) : null;
  const centreValue = activeSlice ? activeSlice.value : counts.total;
  const centreLabel = activeSlice ? activeSlice.label : 'Jami so‘rovlar';

  // Stable key so the entrance sweep replays when the rendered slice set
  // changes (filter change) but not on hover.
  const sliceKey = slices.map((s) => `${s.key}:${s.value}`).join('|');

  return (
    <Card
      data-testid="store-requests-status-donut"
      className={cn('space-y-4 p-5 sm:p-6', className)}
      role="region"
      aria-label="So‘rovlar holati bo‘yicha taqsimot"
    >
      <header className="flex items-baseline justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            So‘rovlar holati
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Holat bo‘yicha taqsimot
          </p>
        </div>
      </header>

      {counts.total === 0 ? (
        <EmptyState message="Bu davrda so‘rov yo‘q." />
      ) : (
        <div className="flex flex-col gap-8 sm:flex-row sm:items-center sm:gap-8">
          {/* LEFT — donut with the grand total in the centre. */}
          <div
            className="relative mx-auto h-[200px] w-[200px] shrink-0 sm:mx-0 lg:h-[220px] lg:w-[220px]"
            aria-hidden="true"
          >
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  key={hasSlices ? sliceKey : 'empty'}
                  data={slices}
                  dataKey="value"
                  nameKey="label"
                  innerRadius="58%"
                  outerRadius="88%"
                  paddingAngle={2}
                  stroke="hsl(var(--card))"
                  strokeWidth={2}
                  isAnimationActive={!hasAnimated}
                  animationDuration={700}
                  animationEasing="ease-out"
                  activeIndex={activeIndex ?? undefined}
                  activeShape={renderActiveSector}
                >
                  {slices.map((slice, i) => (
                    <Cell
                      key={slice.key}
                      fill={slice.colour}
                      fillOpacity={
                        activeIndex === null || activeIndex === i ? 1 : 0.35
                      }
                    />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-6 text-center">
              <span
                key={activeSlice ? activeSlice.key : '__total__'}
                className="flex h-[2.5rem] animate-in items-center justify-center fade-in text-3xl font-bold leading-none tabular-nums duration-200 sm:text-4xl"
                data-testid="store-requests-status-total"
              >
                {formatPlainNumber(centreValue)}
              </span>
              <span
                key={activeSlice ? `${activeSlice.key}__label` : '__label__'}
                className="mt-1.5 line-clamp-1 max-w-full animate-in text-xs text-muted-foreground duration-200 fade-in"
              >
                {centreLabel}
              </span>
            </div>
          </div>

          {/* RIGHT — legend, one row per bucket with count + share. */}
          <ul
            className="w-full flex-1 space-y-3.5"
            data-testid="store-requests-status-legend"
          >
            {legendRows.map((row) => {
              const sliceIndex = sliceIndexByKey.get(row.key) ?? null;
              return (
                <li
                  key={row.key}
                  data-testid={`store-requests-legend-${row.key}`}
                  className="grid cursor-default grid-cols-[1fr_auto_48px] items-baseline gap-x-4 rounded-md py-0.5 transition-colors hover:bg-surface-2/30"
                  onMouseEnter={() => setActiveIndex(sliceIndex)}
                  onMouseLeave={() => setActiveIndex(null)}
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <span
                      aria-hidden="true"
                      className="size-3 shrink-0 translate-y-px rounded-sm"
                      style={{ background: row.colour }}
                    />
                    <span className="truncate text-base text-foreground">
                      {row.label}
                    </span>
                  </span>
                  <span className="text-right text-base font-semibold tabular-nums sm:text-lg">
                    {formatPlainNumber(row.value)}
                  </span>
                  <span className="text-right text-sm tabular-nums text-muted-foreground">
                    {formatPct(row.value, counts.total)}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Card>
  );
}
