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
} from 'recharts';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/PageState';
import type { DashboardSalesPoint } from '@/lib/types';
import { cn } from '@/lib/utils';

type SalesMetric = 'qty' | 'amount';

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
  className?: string;
}) {
  const data = useMemo(
    () =>
      points.map((p) => ({
        date: p.date,
        value: p[dataKey],
        label: shortDate(p.date),
      })),
    [points, dataKey],
  );
  const total = useMemo(
    () => points.reduce((acc, p) => acc + p[dataKey], 0),
    [points, dataKey],
  );

  const accentVar = accent === 'success' ? '--success' : '--primary';
  const accentColor = `hsl(var(${accentVar}))`;
  const gradientId = `sales-fill-${dataKey}`;

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
          <EmptyState message="Sotuv ma’lumotlari yo‘q." />
        ) : (
          <div
            className="h-56 w-full"
            data-testid="sales-chart"
            aria-label={title}
          >
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={data}
                margin={{ top: 8, right: 12, bottom: 0, left: 0 }}
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
                  contentStyle={{
                    background: 'hsl(var(--popover))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: '0.5rem',
                    fontSize: '0.75rem',
                    color: 'hsl(var(--popover-foreground))',
                  }}
                  formatter={(value: number) => [
                    valueFormatter(value),
                    tooltipLabel,
                  ]}
                  labelFormatter={(label: string) => label}
                />
                <Area
                  type="monotone"
                  dataKey="value"
                  stroke={accentColor}
                  strokeWidth={2}
                  fill={`url(#${gradientId})`}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </Card>
  );
}

function shortDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (match === null) return iso;
  const [, , m, d] = match;
  return `${d}.${m}`;
}
