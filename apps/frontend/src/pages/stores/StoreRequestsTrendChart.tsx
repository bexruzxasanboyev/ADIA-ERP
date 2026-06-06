import { useMemo } from 'react';
import { LineChart as LineChartIcon } from 'lucide-react';
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
import { formatPlainNumber } from '@/lib/format';
import {
  CHART_ANIMATION_DURATION,
  CHART_ANIMATION_EASING,
  chartSeriesKey,
} from '@/lib/chartAnimation';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { cn } from '@/lib/utils';
import type { ReplenishmentRequest } from '@/lib/types';
import { trendAxisLabel, trendByDay } from './storeRequestCharts';

/**
 * So'rovlar tab — requests CREATED over time, bucketed by day, as an area
 * chart mirroring the dashboard's SalesChart look (gradient fill, day-level
 * `DD.MM` x-axis, hover tooltip with the count).
 *
 * The caller passes the requests it has ALREADY scoped to the store and
 * filtered to the active date range, so the series is just `trendByDay(...)`.
 */

interface TrendDatum {
  date: string;
  label: string;
  value: number;
}

function TrendTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: { payload: TrendDatum; value: number }[];
}) {
  if (!active || !payload || payload.length === 0) return null;
  const head = payload[0];
  if (!head) return null;
  return (
    <div
      className="min-w-[9rem] rounded-lg border border-border bg-popover px-3 py-2.5 text-popover-foreground shadow-lg"
      data-testid="store-requests-trend-tooltip"
    >
      <p className="mb-2 text-xs font-semibold tabular-nums text-foreground">
        {head.payload.label}
      </p>
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="text-muted-foreground">So‘rovlar</span>
        <span className="font-medium tabular-nums text-foreground">
          {formatPlainNumber(head.value)}
        </span>
      </div>
    </div>
  );
}

export function StoreRequestsTrendChart({
  requests,
  className,
}: {
  /** Store-scoped, date-range-filtered requests (the "So'rov" set). */
  requests: ReplenishmentRequest[];
  className?: string;
}) {
  const data = useMemo<TrendDatum[]>(
    () =>
      trendByDay(requests).map((p) => ({
        date: p.date,
        label: trendAxisLabel(p.date),
        value: p.count,
      })),
    [requests],
  );
  const total = useMemo(
    () => data.reduce((acc, p) => acc + p.value, 0),
    [data],
  );

  const reducedMotion = usePrefersReducedMotion();
  // Remount the series when the rendered window changes so the draw-in replays.
  const seriesKey = useMemo(() => chartSeriesKey('day', data), [data]);

  const accentColor = 'hsl(var(--primary))';
  const gradientId = 'store-requests-trend-fill';

  const renderTooltip = (props: TooltipProps<number, string>) => (
    <TrendTooltip
      active={props.active}
      payload={
        props.payload as { payload: TrendDatum; value: number }[] | undefined
      }
    />
  );

  return (
    <Card
      className={cn('flex flex-col', className)}
      data-testid="store-requests-trend"
    >
      <header className="flex items-center justify-between gap-3 border-b border-border/60 p-5">
        <div className="space-y-0.5">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <LineChartIcon
              className="size-4"
              style={{ color: accentColor }}
              aria-hidden="true"
            />
            So‘rovlar dinamikasi
          </h2>
          <p className="text-xs text-muted-foreground">
            Kunlik yaratilgan so‘rovlar
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            Jami
          </p>
          <p className="text-lg font-semibold leading-none tabular-nums">
            {formatPlainNumber(total)}
          </p>
        </div>
      </header>

      <div className="p-5">
        {data.length === 0 ? (
          <EmptyState message="Bu davrda so‘rov yo‘q." />
        ) : (
          <div
            className="relative h-56 w-full"
            data-testid="store-requests-trend-chart"
            aria-label="So‘rovlar dinamikasi"
          >
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={data}
                margin={{ top: 8, right: 12, bottom: 0, left: 0 }}
              >
                <defs>
                  <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={accentColor} stopOpacity={0.4} />
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
                  width={32}
                  allowDecimals={false}
                  tickFormatter={(value: number) => formatPlainNumber(value)}
                />
                <Tooltip
                  cursor={{ stroke: accentColor, strokeOpacity: 0.4 }}
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
          </div>
        )}
      </div>
    </Card>
  );
}
