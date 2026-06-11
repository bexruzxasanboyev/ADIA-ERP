import { useMemo } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/PageState';
import {
  dateRangeToQuery,
  type DateRangeValue,
} from '@/components/DateRangeFilter';
import { useApiQuery } from '@/hooks/useApiQuery';
import { formatQty } from '@/lib/format';
import type { DashboardProductionDetail } from '@/lib/types';

/**
 * Variant C — production output chart widget.
 *
 * Compact 7-day AreaChart of `daily_io.output` (sex chiqimi). Source:
 * `GET /api/dashboard/production` — the same detail endpoint that the
 * Production drawer consumes. Coral chain tone (`--chain-production`).
 */
export function ProductionOutputChart({ range }: { range: DateRangeValue }) {
  const query = dateRangeToQuery(range);
  const { data, isLoading, error, refetch } =
    useApiQuery<DashboardProductionDetail>(
      `/api/dashboard/production?${query}`,
    );

  return (
    <Card
      className="flex flex-col gap-3 p-4"
      role="region"
      aria-labelledby="production-output-title"
      data-testid="production-output-chart"
    >
      <header className="flex items-baseline justify-between gap-3">
        <h2
          id="production-output-title"
          className="text-sm font-semibold text-foreground"
        >
          Bugungi ishlab chiqarish
        </h2>
        <p className="text-xs text-muted-foreground">7 kun</p>
      </header>

      {isLoading && data === null ? (
        <ChartSkeleton />
      ) : error && data === null ? (
        <ErrorState message={error} onRetry={refetch} />
      ) : data === null ? null : (
        <ProductionOutputChartView data={data} />
      )}
    </Card>
  );
}

export function ProductionOutputChartView({
  data,
}: {
  data: DashboardProductionDetail;
}) {
  const chartData = useMemo(
    () =>
      data.daily_io.map((p) => ({
        date: p.date,
        output: p.output,
        label: shortDate(p.date),
      })),
    [data.daily_io],
  );
  const todayOutput =
    chartData.length > 0
      ? (chartData[chartData.length - 1]?.output ?? 0)
      : 0;

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">
        Bugun:{' '}
        <span className="font-semibold tabular-nums text-foreground">
          {formatQty(todayOutput)}
        </span>{' '}
        chiqim
      </p>
      <div
        className="h-40 w-full"
        aria-label="7 kunlik ishlab chiqarish chiqimi"
        role="img"
      >
        {chartData.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            Ma'lumot yo'q.
          </p>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={chartData}
              margin={{ top: 6, right: 8, bottom: 0, left: 0 }}
            >
              <defs>
                <linearGradient
                  id="production-output-area"
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop
                    offset="0%"
                    stopColor="hsl(var(--chain-production))"
                    stopOpacity={0.55}
                  />
                  <stop
                    offset="100%"
                    stopColor="hsl(var(--chain-production))"
                    stopOpacity={0.03}
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
                fontSize={10}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                stroke="hsl(var(--muted-foreground))"
                fontSize={10}
                tickLine={false}
                axisLine={false}
                width={32}
                tickFormatter={(v: number) => formatQty(v)}
              />
              <Tooltip
                contentStyle={tooltipStyle}
                formatter={(v: number) => [formatQty(v), 'Chiqim']}
              />
              <Area
                type="monotone"
                dataKey="output"
                stroke="hsl(var(--chain-production))"
                strokeWidth={2}
                fill="url(#production-output-area)"
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

function ChartSkeleton() {
  return (
    <div className="h-40 w-full animate-pulse rounded-md bg-surface-2/40" />
  );
}

const tooltipStyle = {
  background: 'hsl(var(--popover))',
  border: '1px solid hsl(var(--border))',
  borderRadius: '0.5rem',
  fontSize: '0.75rem',
  color: 'hsl(var(--popover-foreground))',
};

function shortDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (m === null) return iso;
  return `${m[3]}.${m[2]}`;
}
