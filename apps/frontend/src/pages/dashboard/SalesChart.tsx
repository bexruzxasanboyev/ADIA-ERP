import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LineChart as LineChartIcon, X } from 'lucide-react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipProps,
} from 'recharts';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/PageState';
import type {
  DashboardChartGranularity,
  DashboardSalesBreakdownBucket,
  DashboardSalesPoint,
} from '@/lib/types';
import { chartBucketLabel } from '@/lib/chartTime';
import {
  CHART_ANIMATION_DURATION,
  CHART_ANIMATION_EASING,
  chartSeriesKey,
} from '@/lib/chartAnimation';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { cn } from '@/lib/utils';

type SalesMetric = 'qty' | 'amount';

/**
 * Stable, colourful dot palette for the itemized tooltip — assigned to each
 * item by its index within a bucket (the backend sorts items by amount desc,
 * so the top contributor keeps the first colour across hovers). Mirrors the
 * non-core method palette in RevenueBreakdown so the two widgets read as one
 * family.
 */
const ITEM_PALETTE: string[] = [
  'hsl(152 60% 48%)', // emerald
  'hsl(204 90% 56%)', // sky
  'hsl(187 80% 52%)', // cyan
  'hsl(258 72% 66%)', // violet
  'hsl(38 92% 55%)', // amber
  'hsl(347 77% 60%)', // rose
  'hsl(243 65% 66%)', // indigo
  'hsl(172 66% 45%)', // teal
  'hsl(292 70% 62%)', // fuchsia
  'hsl(84 62% 50%)', // lime
];

function itemColour(index: number): string {
  return ITEM_PALETTE[index % ITEM_PALETTE.length] ?? ITEM_PALETTE[0]!;
}

/** A datum fed to the AreaChart; carries `hour` so the tooltip can match a bucket. */
interface SalesChartDatum {
  date: string;
  hour?: number;
  value: number;
  label: string;
}

/**
 * The subset of Recharts' `CategoricalChartState` we read in the `onClick`
 * handler. Recharts does not re-export `CategoricalChartState` from its public
 * entrypoint, so we model the fields we touch here to stay `any`-free.
 */
interface ChartClickState {
  activeTooltipIndex?: number;
  activeLabel?: string;
  activeCoordinate?: { x?: number; y?: number };
}

/** A pinned tooltip: the clicked datum + the x pixel to anchor the overlay to. */
export interface PinnedPoint {
  datum: SalesChartDatum;
  /** x pixel within the chart container (from `activeCoordinate.x`). */
  x: number;
}

/**
 * F4.4 — 30-day sales trend (phase-4.md §2.4).
 *
 * Renders an area chart for one day-level sales series. The chart is
 * metric-agnostic: it can plot either the sold-quantity series (`qty`)
 * or the revenue series (`amount`, so'm). Two instances are rendered
 * side by side on the dashboard — one per metric — so the boshliq sees
 * both volume and money on the same row.
 *
 * The header `Jami` total is computed from the active `dataKey` and
 * formatted with the matching formatter (qty grouping vs. compact so'm).
 */
export function SalesChart({
  points,
  title,
  description,
  dataKey,
  valueFormatter,
  totalFormatter = valueFormatter,
  tooltipLabel,
  accent = 'primary',
  granularity = 'day',
  breakdown,
  emptyMessage = 'Sotuv ma’lumotlari yo‘q.',
  loading = false,
  className,
}: {
  points: DashboardSalesPoint[];
  /** Card heading, e.g. "Sotuv soni — 30 kun". */
  title: string;
  /** Sub-heading describing the series. */
  description: string;
  /** Which series to plot. */
  dataKey: SalesMetric;
  /** Formats axis ticks and tooltip values for the active metric. */
  valueFormatter: (value: number) => string;
  /** Formats the header `Jami` total; defaults to `valueFormatter`. */
  totalFormatter?: (value: number) => string;
  /** Tooltip series label, e.g. "Soni" / "Summa". */
  tooltipLabel: string;
  /** Accent colour family — drives stroke/gradient/cursor. */
  accent?: 'primary' | 'success';
  /**
   * Series granularity. `'day'` (default) labels the x-axis `DD.MM`;
   * `'hour'` (range=today) labels it `HH:00` using each point's `hour`.
   */
  granularity?: DashboardChartGranularity;
  /**
   * Itemized per-bucket breakdown (product or payment dimension). When a
   * matching bucket is found for the hovered point the tooltip lists each
   * contributing item with a colour dot + value and a bold "Jami" row; when
   * absent (loading, no match, or endpoint missing) the tooltip falls back to
   * the simple label + single total so it never breaks.
   */
  breakdown?: DashboardSalesBreakdownBucket[];
  /** Message shown when there are no points. Defaults to the sales copy. */
  emptyMessage?: string;
  /**
   * When `true`, render an in-card chart skeleton instead of the chart/empty
   * branch — used while the parent's data source is still loading so each
   * chart owns its own loader and nothing pops in late once the page skeleton
   * disappears. The skeleton keeps the exact card footprint (header + chart
   * area) so the layout never jumps when the real series arrives.
   */
  loading?: boolean;
  className?: string;
}) {
  const data = useMemo<SalesChartDatum[]>(
    () =>
      points.map((p) => ({
        date: p.date,
        hour: p.hour,
        value: p[dataKey],
        label: chartBucketLabel(p, granularity),
      })),
    [points, dataKey, granularity],
  );
  const total = useMemo(
    () => points.reduce((acc, p) => acc + p[dataKey], 0),
    [points, dataKey],
  );

  const reducedMotion = usePrefersReducedMotion();
  // Remount the series when the rendered window changes (range/granularity
  // switch) so the draw-in animation replays instead of morphing the path.
  const seriesKey = useMemo(
    () => chartSeriesKey(granularity, data),
    [granularity, data],
  );

  // Index the breakdown buckets so the tooltip can resolve the hovered point in
  // O(1): hourly buckets key on `hour`, daily on `date`.
  const bucketByKey = useMemo(() => {
    const map = new Map<string, DashboardSalesBreakdownBucket>();
    for (const b of breakdown ?? []) {
      if (typeof b.hour === 'number') map.set(`h:${b.hour}`, b);
      else if (b.date) map.set(`d:${b.date}`, b);
    }
    return map;
  }, [breakdown]);

  const lookupBucket = (
    point: SalesChartDatum,
  ): DashboardSalesBreakdownBucket | undefined => {
    if (granularity === 'hour' && typeof point.hour === 'number') {
      return bucketByKey.get(`h:${point.hour}`);
    }
    return bucketByKey.get(`d:${point.date}`);
  };

  const accentVar = accent === 'success' ? '--success' : '--primary';
  const accentColor = `hsl(var(${accentVar}))`;
  const gradientId = `sales-fill-${dataKey}`;

  const renderTooltip = (props: TooltipProps<number, string>) => (
    <SalesTooltip
      active={props.active}
      payload={
        props.payload as
          | { payload: SalesChartDatum; value: number }[]
          | undefined
      }
      dataKey={dataKey}
      tooltipLabel={tooltipLabel}
      valueFormatter={valueFormatter}
      lookupBucket={lookupBucket}
    />
  );

  // Click-to-pin: clicking a point freezes that bucket's tooltip as an overlay
  // anchored to the point's x. Pin state is per-chart (this component instance),
  // so the two dashboard charts pin independently. The hover <Tooltip> keeps
  // working as before; the pinned overlay lives alongside it.
  const containerRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState<PinnedPoint | null>(null);

  const handleChartClick = useCallback(
    (state: ChartClickState) => {
      const idx = state.activeTooltipIndex;
      const x = state.activeCoordinate?.x;
      if (idx == null || x == null) return;
      const datum = data[idx];
      if (!datum) return;
      // Clicking the already-pinned point toggles the pin off; clicking a
      // different point moves the pin to it.
      setPinned((prev) =>
        prev && prev.datum.label === datum.label ? null : { datum, x },
      );
    },
    [data],
  );

  // Dismiss the pin on any click outside the chart container (the × button and
  // the same-point toggle handle the in-chart cases). Pointer-based so it also
  // fires for clicks landing on other dashboard widgets.
  useEffect(() => {
    if (!pinned) return;
    const onPointerDown = (e: PointerEvent) => {
      const node = containerRef.current;
      if (node && e.target instanceof Node && !node.contains(e.target)) {
        setPinned(null);
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () =>
      document.removeEventListener('pointerdown', onPointerDown, true);
  }, [pinned]);

  // Reset the pin when the rendered window changes (range/granularity switch)
  // so a stale anchor never lingers over a different series.
  useEffect(() => {
    setPinned(null);
  }, [seriesKey]);

  // While the parent's data source is still loading we own our own skeleton —
  // same Card/header/chart-area footprint, with shimmer placeholders — so the
  // chart never pops in late after the page skeleton disappears.
  if (loading) {
    return <SalesChartSkeleton title={title} description={description} accentColor={accentColor} className={className} />;
  }

  return (
    <Card className={cn('flex flex-col', className)}>
      <header className="flex items-center justify-between gap-3 border-b border-border/60 p-5">
        <div className="space-y-0.5">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <LineChartIcon
              className="size-4"
              style={{ color: accentColor }}
              aria-hidden="true"
            />
            {title}
          </h2>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <div className="text-right">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            Jami
          </p>
          <p className="text-lg font-semibold tabular-nums leading-none">
            {totalFormatter(total)}
          </p>
        </div>
      </header>

      <div className="p-5">
        {data.length === 0 ? (
          <EmptyState message={emptyMessage} />
        ) : (
          <div
            ref={containerRef}
            className="relative h-56 w-full"
            data-testid="sales-chart"
            aria-label={title}
          >
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={data}
                margin={{ top: 8, right: 12, bottom: 0, left: 0 }}
                onClick={handleChartClick}
              >
                <defs>
                  <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                    <stop
                      offset="0%"
                      stopColor={accentColor}
                      stopOpacity={0.4}
                    />
                    <stop
                      offset="100%"
                      stopColor={accentColor}
                      stopOpacity={0.02}
                    />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  stroke="hsl(var(--border))"
                  strokeDasharray="3 3"
                  vertical={false}
                />
                <XAxis
                  dataKey="label"
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={24}
                />
                <YAxis
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                  width={36}
                  tickFormatter={(value: number) => valueFormatter(value)}
                />
                <Tooltip
                  cursor={{
                    stroke: accentColor,
                    strokeOpacity: 0.4,
                  }}
                  content={renderTooltip}
                />
                <Area
                  key={seriesKey}
                  type="monotone"
                  dataKey="value"
                  stroke={accentColor}
                  strokeWidth={2}
                  fill={`url(#${gradientId})`}
                  isAnimationActive={!reducedMotion}
                  animationDuration={CHART_ANIMATION_DURATION}
                  animationEasing={CHART_ANIMATION_EASING}
                />
              </AreaChart>
            </ResponsiveContainer>

            {pinned && (
              <PinnedTooltip
                point={pinned}
                dataKey={dataKey}
                tooltipLabel={tooltipLabel}
                valueFormatter={valueFormatter}
                lookupBucket={lookupBucket}
                onClose={() => setPinned(null)}
              />
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

/**
 * In-card loading placeholder for a single {@link SalesChart}.
 *
 * Mirrors the real card exactly — same Card wrapper, header (icon + title +
 * subtitle on the left, a "Jami" label + a value placeholder bar on the right),
 * and a chart-area-sized shimmer block matching the real chart's `h-56`
 * footprint — so when the live series arrives nothing jumps. The two dashboard
 * charts each render their own instance, giving the row two independent
 * skeletons side by side. Shade + animation (`bg-foreground/10 animate-pulse`)
 * match the other dashboard skeletons (RevenueBreakdown / TopProducts /
 * ExecutiveDashboardSkeleton) for visual consistency.
 */
function SalesChartSkeleton({
  title,
  description,
  accentColor,
  className,
}: {
  title: string;
  description: string;
  accentColor: string;
  className?: string;
}) {
  return (
    <Card
      className={cn('flex flex-col', className)}
      data-testid="sales-chart-skeleton"
      role="status"
      aria-busy="true"
      aria-label={title}
    >
      <span className="sr-only">Yuklanmoqda</span>
      <header
        className="flex items-center justify-between gap-3 border-b border-border/60 p-5"
        aria-hidden="true"
      >
        <div className="space-y-0.5">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <LineChartIcon
              className="size-4"
              style={{ color: accentColor }}
              aria-hidden="true"
            />
            {title}
          </h2>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <div className="space-y-1.5 text-right">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            Jami
          </p>
          {/* value placeholder bar — stands in for the total while loading */}
          <span className="ml-auto block h-5 w-20 animate-pulse rounded bg-foreground/10" />
        </div>
      </header>

      <div className="p-5" aria-hidden="true">
        {/* chart-area shimmer — same h-56 footprint as the real AreaChart */}
        <div className="h-56 w-full animate-pulse rounded-lg bg-foreground/10" />
      </div>
    </Card>
  );
}

/**
 * The pinned (click-to-freeze) tooltip overlay. It reuses {@link SalesTooltip}'s
 * body verbatim — so a pinned card reads identically to a hover card — and adds
 * a small × close button in the top-right corner.
 *
 * It is absolutely positioned inside the (relative) chart container, anchored to
 * the clicked point's x pixel and clamped so it never overflows the card edges.
 * `pointer-events-none` on the wrapper lets hover/click pass through to the
 * chart underneath; only the card surface (and its × button) re-enable pointer
 * events so the pinned breakdown stays interactive.
 */
export function PinnedTooltip({
  point,
  dataKey,
  tooltipLabel,
  valueFormatter,
  lookupBucket,
  onClose,
}: {
  point: PinnedPoint;
  dataKey: SalesMetric;
  tooltipLabel: string;
  valueFormatter: (value: number) => string;
  lookupBucket: (
    point: SalesChartDatum,
  ) => DashboardSalesBreakdownBucket | undefined;
  onClose: () => void;
}) {
  return (
    <div
      className="pointer-events-none absolute top-1 z-10 -translate-x-1/2"
      // Clamp the anchor so the card stays within the chart horizontally; the
      // translate above centres it on the point, the clamp keeps the edges in.
      style={{ left: `clamp(7rem, ${point.x}px, calc(100% - 7rem))` }}
      data-testid="sales-tooltip-pinned"
    >
      <div className="pointer-events-auto relative">
        <button
          type="button"
          onClick={onClose}
          aria-label="Yopish"
          className="absolute -right-2 -top-2 z-10 grid size-5 place-items-center rounded-full border border-border bg-popover text-muted-foreground shadow-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-3" aria-hidden="true" />
        </button>
        <SalesTooltip
          active
          payload={[{ payload: point.datum, value: point.datum.value }]}
          dataKey={dataKey}
          tooltipLabel={tooltipLabel}
          valueFormatter={valueFormatter}
          lookupBucket={lookupBucket}
        />
      </div>
    </div>
  );
}

/**
 * Yandex-Cloud-style itemized tooltip. For the hovered point it resolves the
 * matching breakdown bucket and lists each contributing item (colour dot +
 * name + right-aligned value), then a divider and a bold "Jami" row. The value
 * shown per item follows the chart's metric — `qty` for the count chart,
 * `amount` (so'm) for the revenue chart.
 *
 * When no bucket matches (breakdown still loading, no row for this point, or
 * the endpoint is missing) it degrades to the prior simple tooltip: the bucket
 * label + a single total value — so it never breaks.
 *
 * Recharts only mounts tooltip `content` for the active point, so this renders
 * lazily and stays cheap.
 */
export function SalesTooltip({
  active,
  payload,
  dataKey,
  tooltipLabel,
  valueFormatter,
  lookupBucket,
}: {
  active?: boolean;
  payload?: { payload: SalesChartDatum; value: number }[];
  dataKey: SalesMetric;
  tooltipLabel: string;
  valueFormatter: (value: number) => string;
  lookupBucket: (
    point: SalesChartDatum,
  ) => DashboardSalesBreakdownBucket | undefined;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const head = payload[0];
  if (!head) return null;
  const point = head.payload;
  const bucket = lookupBucket(point);

  return (
    <div
      className="min-w-[12rem] max-w-[18rem] rounded-lg border border-border bg-popover px-3 py-2.5 text-popover-foreground shadow-lg"
      data-testid="sales-tooltip"
    >
      <p className="mb-2 text-xs font-semibold tabular-nums text-foreground">
        {point.label}
      </p>

      {bucket && bucket.items.length > 0 ? (
        <>
          <ul className="space-y-1.5">
            {bucket.items.map((item, i) => (
              <li
                key={`${item.name}-${i}`}
                className="flex items-center gap-2 text-xs"
              >
                <span
                  aria-hidden="true"
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ background: itemColour(i) }}
                />
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {item.name}
                </span>
                <span className="shrink-0 tabular-nums font-medium text-foreground">
                  {valueFormatter(dataKey === 'qty' ? item.qty : item.amount)}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex items-center justify-between gap-3 border-t border-border/60 pt-2 text-xs">
            <span className="font-semibold text-foreground">Jami</span>
            <span className="tabular-nums font-semibold text-foreground">
              {valueFormatter(
                dataKey === 'qty' ? bucket.total_qty : bucket.total_amount,
              )}
            </span>
          </div>
        </>
      ) : (
        // Fallback — no breakdown row for this point: the simple label + the
        // single series total (matches the prior default tooltip).
        <div className="flex items-center justify-between gap-3 text-xs">
          <span className="text-muted-foreground">{tooltipLabel}</span>
          <span className="tabular-nums font-medium text-foreground">
            {valueFormatter(head.value)}
          </span>
        </div>
      )}
    </div>
  );
}
