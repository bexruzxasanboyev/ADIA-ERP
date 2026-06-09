import { useMemo } from 'react';
import { TrendingUp } from 'lucide-react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipProps,
} from 'recharts';
import { EmptyState, ErrorState, LoadingState } from '@/components/PageState';
import { useApiQuery } from '@/hooks/useApiQuery';
import { formatCurrencyCompact, formatPlainNumber } from '@/lib/format';
import {
  CHART_ANIMATION_DURATION,
  CHART_ANIMATION_EASING,
} from '@/lib/chartAnimation';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import type { StoreKpiTrendResponse } from '@/lib/types';

// Owner palette — sales/actual series renders in the brand green used for
// "haqiqiy sotuv" elsewhere on the dashboard. Literal HSL so it renders in
// jsdom and on the dark theme alike.
const SALES_COLOUR = 'hsl(152 60% 48%)';

/** Short Uzbek month labels, indexed 0=yanvar … 11=dekabr. */
const UZ_MONTHS_SHORT = [
  'Yan',
  'Fev',
  'Mar',
  'Apr',
  'May',
  'Iyun',
  'Iyul',
  'Avg',
  'Sen',
  'Okt',
  'Noy',
  'Dek',
] as const;

/** `YYYY-MM` → "Iyun 2026"; falls back to the raw key on a malformed input. */
function monthLabel(ym: string): string {
  const [y, m] = ym.split('-');
  const idx = Number(m) - 1;
  if (!y || Number.isNaN(idx) || idx < 0 || idx > 11) return ym;
  return `${UZ_MONTHS_SHORT[idx]} ${y}`;
}

interface TrendDatum {
  /** `YYYY-MM` — kept for the tooltip. */
  ym: string;
  label: string;
  actual: number;
}

/**
 * Per-store monthly sales trend (TZ Module 8) — `actual_sum` over the last N
 * months, oldest → newest. Rendered inside an expanded KPI row. Reads
 * `GET /api/store-kpi/:locationId/trend?months=6` and degrades gracefully to a
 * loading / error / empty state.
 */
export function StoreKpiTrendChart({
  locationId,
  locationName,
  months = 6,
}: {
  locationId: number;
  locationName: string;
  /** How many trailing months to request (default 6). */
  months?: number;
}) {
  const trend = useApiQuery<StoreKpiTrendResponse>(
    `/api/store-kpi/${locationId}/trend?months=${months}`,
  );
  const reducedMotion = usePrefersReducedMotion();

  const chartData = useMemo<TrendDatum[]>(
    () =>
      (trend.data?.series ?? []).map((p) => ({
        ym: p.month,
        label: monthLabel(p.month),
        actual: p.actual_sum,
      })),
    [trend.data],
  );

  return (
    <div>
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <TrendingUp className="size-4 text-primary" aria-hidden="true" />
        {`${locationName} — sotuv dinamikasi (oylik)`}
      </h3>

      {trend.isLoading && <LoadingState />}
      {!trend.isLoading && trend.error && (
        <ErrorState message={trend.error} onRetry={trend.refetch} />
      )}
      {!trend.isLoading && !trend.error && chartData.length === 0 && (
        <EmptyState message="Ma’lumot yo‘q" />
      )}

      {!trend.isLoading && !trend.error && chartData.length > 0 && (
        <div
          className="h-56 w-full"
          data-testid="store-kpi-trend-chart"
          aria-label={`${locationName} sotuv dinamikasi`}
        >
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={chartData}
              margin={{ top: 8, right: 12, bottom: 0, left: 0 }}
            >
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
                minTickGap={16}
              />
              <YAxis
                stroke="hsl(var(--muted-foreground))"
                fontSize={11}
                tickLine={false}
                axisLine={false}
                width={52}
                allowDecimals={false}
                tickFormatter={(v: number) => formatCurrencyCompact(v)}
              />
              <Tooltip
                cursor={{ stroke: 'hsl(var(--border))' }}
                content={renderTrendTooltip}
              />
              <Line
                type="monotone"
                dataKey="actual"
                name="Haqiqiy sotuv"
                stroke={SALES_COLOUR}
                strokeWidth={2}
                dot={{ r: 3, fill: SALES_COLOUR }}
                activeDot={{ r: 5 }}
                isAnimationActive={!reducedMotion}
                animationDuration={CHART_ANIMATION_DURATION}
                animationEasing={CHART_ANIMATION_EASING}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

function renderTrendTooltip(props: TooltipProps<number, string>) {
  const { active, payload } = props;
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0]?.payload as TrendDatum | undefined;
  if (!point) return null;
  return (
    <div className="min-w-[11rem] rounded-lg border border-border bg-popover px-3 py-2.5 text-popover-foreground shadow-pop">
      <p className="mb-2 text-xs font-semibold text-foreground">
        {point.label}
      </p>
      <div className="flex items-center gap-2 text-xs">
        <span
          aria-hidden="true"
          className="size-2.5 shrink-0 rounded-full"
          style={{ background: SALES_COLOUR }}
        />
        <span className="min-w-0 flex-1 text-muted-foreground">
          Haqiqiy sotuv
        </span>
        <span className="shrink-0 font-medium tabular-nums text-foreground">
          {`${formatPlainNumber(point.actual)} so‘m`}
        </span>
      </div>
    </div>
  );
}
