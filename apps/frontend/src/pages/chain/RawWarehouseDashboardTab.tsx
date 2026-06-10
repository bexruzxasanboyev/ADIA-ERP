import { useMemo, type ComponentType } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  AlertTriangle,
  CheckCircle2,
  Inbox,
  Layers,
  Package,
  TrendingDown,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { ErrorState, LoadingState } from '@/components/PageState';
import { useApiQuery } from '@/hooks/useApiQuery';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { formatPlainNumber, formatQty } from '@/lib/format';
import { chartBucketLabel } from '@/lib/chartTime';
import {
  CHART_ANIMATION_DURATION,
  CHART_ANIMATION_EASING,
  chartSeriesKey,
} from '@/lib/chartAnimation';
import { cn } from '@/lib/utils';
import type { DashboardRawDetail, StockRow } from '@/lib/types';

/**
 * Xom-ashyo ombori ish joyi — "Dashboard" tab.
 *
 * A clean, self-contained raw-warehouse overview, mirroring the central
 * warehouse Dashboard (`CentralDashboardTab`) and the store Dashboard
 * (`StoreStockDashboard`): a five-card KPI strip, a horizontal stock-status
 * BAR chart, a received/issued AREA chart, and a compact below-min list.
 *
 * Data sources (frontend-only; backend unchanged):
 *   - GET /api/dashboard/raw   → DashboardRawDetail (KPIs, daily_movements,
 *     below_min_items, pending_purchase_orders). The detail endpoint expects
 *     a range param; we pass `range=today` so the kirim/chiqim chart shows the
 *     live hourly flow, like the other detail panels default.
 *   - GET /api/stock?location_type=raw_warehouse → StockRow[] for the status
 *     bar counts (same `stockStatusOf` heuristic as central / store).
 */

type StatusKey = 'below_min' | 'low' | 'out' | 'enough';

interface StockStatusCounts {
  total: number;
  out: number;
  below_min: number;
  low: number;
  enough: number;
}

const STATUS_META: Record<
  StatusKey,
  { label: string; colour: string; value: string }
> = {
  below_min: {
    label: 'Min’dan past',
    colour: 'hsl(24 90% 55%)',
    value: 'text-warning',
  },
  low: {
    label: 'Kam',
    colour: 'hsl(45 93% 52%)',
    value: 'text-warning',
  },
  out: {
    label: 'Tugagan',
    colour: 'hsl(0 84% 60%)',
    value: 'text-destructive',
  },
  enough: {
    label: 'Yetarli',
    colour: 'hsl(152 56% 48%)',
    value: 'text-success',
  },
};

/** Bar order (worst → best). */
const STATUS_ORDER: StatusKey[] = ['out', 'below_min', 'low', 'enough'];

/**
 * "Kam" (low) heuristic: at or below 120% of min but still above min — the
 * early-warning band. Mirrors the store / central rule exactly.
 */
function isLowStock(row: StockRow): boolean {
  if (row.min_level <= 0) return false;
  return row.qty > row.min_level && row.qty <= row.min_level * 1.2;
}

function stockStatusOf(row: StockRow): StatusKey {
  if (row.qty <= 0) return 'out';
  if (row.qty <= row.min_level) return 'below_min';
  if (isLowStock(row)) return 'low';
  return 'enough';
}

function formatPct(part: number, total: number): string {
  if (total <= 0) return '0%';
  const pct = (part / total) * 100;
  return `${pct >= 10 ? Math.round(pct) : pct.toFixed(1)}%`;
}

const tooltipStyle = {
  background: 'hsl(var(--popover))',
  border: '1px solid hsl(var(--border))',
  borderRadius: '0.5rem',
  fontSize: '0.75rem',
  color: 'hsl(var(--popover-foreground))',
};

/** A KPI card styled like the central / store dashboard strip. */
function KpiCard({
  label,
  value,
  caption,
  Icon,
  valueClass,
  iconClass,
}: {
  label: string;
  value: string;
  caption: string;
  Icon: ComponentType<{ className?: string }>;
  valueClass?: string;
  iconClass?: string;
}) {
  return (
    <Card className="flex min-h-[140px] flex-col justify-between gap-3 border-border/60 p-5">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
        <Icon aria-hidden="true" className={cn('size-4 shrink-0', iconClass)} />
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span
          className={cn(
            'text-2xl font-semibold leading-none tabular-nums tracking-tight',
            valueClass,
          )}
        >
          {value}
        </span>
        <span className="text-xs text-muted-foreground">{caption}</span>
      </div>
    </Card>
  );
}

export function RawWarehouseDashboardTab() {
  // Detail endpoint drives the KPIs, the kirim/chiqim chart and the below-min
  // list. `range=today` gives the live hourly flow, like the other panels.
  const detail = useApiQuery<DashboardRawDetail>(
    '/api/dashboard/raw?range=today',
  );
  // Live raw stock rows → the status bar counts (same heuristic as central).
  const stock = useApiQuery<StockRow[]>(
    '/api/stock?location_type=raw_warehouse',
  );

  const reducedMotion = usePrefersReducedMotion();

  const counts = useMemo<StockStatusCounts>(() => {
    const c: StockStatusCounts = {
      total: 0,
      out: 0,
      below_min: 0,
      low: 0,
      enough: 0,
    };
    for (const r of stock.data ?? []) {
      c.total += 1;
      c[stockStatusOf(r)] += 1;
    }
    return c;
  }, [stock.data]);

  const barEntries = STATUS_ORDER.map((key) => ({
    key,
    label: STATUS_META[key].label,
    value: counts[key],
    colour: STATUS_META[key].colour,
    display: `${formatPlainNumber(counts[key])} · ${formatPct(counts[key], counts.total)}`,
  }));

  const chartData = useMemo(
    () =>
      (detail.data?.daily_movements ?? []).map((p) => ({
        date: p.date,
        received: p.received,
        issued: p.issued,
        label: chartBucketLabel(p, detail.data?.daily_granularity),
      })),
    [detail.data?.daily_movements, detail.data?.daily_granularity],
  );

  const seriesKey = useMemo(
    () => chartSeriesKey(detail.data?.daily_granularity, chartData),
    [detail.data?.daily_granularity, chartData],
  );

  // Compact "1 234 kg · 56 l" total — never collapse units into one number.
  const totalStockLabel = useMemo(() => {
    const rows = detail.data?.kpis.total_stock_by_unit ?? [];
    if (rows.length === 0) return '0';
    return rows.map((row) => `${formatQty(row.qty)} ${row.unit}`).join(' · ');
  }, [detail.data?.kpis.total_stock_by_unit]);

  // First load: the detail query gates the KPI strip + charts.
  if (detail.isLoading && detail.data === null) {
    return <LoadingState />;
  }
  if (detail.error && detail.data === null) {
    return (
      <Card>
        <ErrorState message={detail.error} onRetry={detail.refetch} />
      </Card>
    );
  }
  if (detail.data === null) return null;

  const { kpis, below_min_items } = detail.data;
  const belowMinTop = below_min_items.slice(0, 10);

  return (
    <div className="space-y-4">
      {/* KPI strip — raw stock health + the purchase queue. Even strip of 5,
          collapsing to 2/3-up on narrower screens (central / store style). */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <KpiCard
          label="Xom-ashyo turlari"
          value={formatPlainNumber(kpis.raw_product_types)}
          caption="mavjud"
          Icon={Package}
          iconClass="text-primary"
        />
        <KpiCard
          label={STATUS_META.below_min.label}
          value={formatPlainNumber(kpis.below_min_count)}
          caption="pozitsiya"
          Icon={TrendingDown}
          valueClass={STATUS_META.below_min.value}
          iconClass={STATUS_META.below_min.value}
        />
        <KpiCard
          label="Qabul kutilmoqda"
          value={formatPlainNumber(kpis.open_purchase_orders)}
          caption="sotib olish"
          Icon={Inbox}
          iconClass="text-primary"
        />
        <KpiCard
          label="Jami qoldiq"
          value={totalStockLabel}
          caption="ostatka"
          Icon={Layers}
          iconClass="text-muted-foreground"
        />
        <KpiCard
          label={STATUS_META.enough.label}
          value={formatPlainNumber(counts.enough)}
          caption="pozitsiya"
          Icon={CheckCircle2}
          valueClass={STATUS_META.enough.value}
          iconClass={STATUS_META.enough.value}
        />
      </div>

      {/* Status BAR chart — one horizontal bar per status, coloured by tone,
          with a "count · %" end label. Live raw stock rows. */}
      <Card className="space-y-4 p-5">
        <header className="flex items-baseline justify-between gap-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Holat bo‘yicha taqsimot
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Xom-ashyo holati bo‘yicha · jonli qoldiq
            </p>
          </div>
          <p className="shrink-0 text-sm text-muted-foreground">
            Jami{' '}
            <span className="font-semibold tabular-nums text-foreground">
              {formatPlainNumber(counts.total)}
            </span>
          </p>
        </header>

        {stock.isLoading && stock.data === null ? (
          <LoadingState />
        ) : stock.error && stock.data === null ? (
          <ErrorState message={stock.error} onRetry={stock.refetch} />
        ) : counts.total === 0 ? (
          <p className="text-sm text-muted-foreground">
            Xom-ashyo qoldig‘i topilmadi.
          </p>
        ) : (
          <div className="h-[240px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={barEntries}
                layout="vertical"
                margin={{ top: 4, right: 72, bottom: 4, left: 8 }}
                barCategoryGap="28%"
              >
                <CartesianGrid
                  horizontal={false}
                  stroke="hsl(var(--border))"
                  strokeDasharray="3 3"
                />
                <XAxis type="number" hide />
                <YAxis
                  type="category"
                  dataKey="label"
                  width={104}
                  tickLine={false}
                  axisLine={false}
                  tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 13 }}
                />
                <Tooltip
                  cursor={{ fill: 'hsl(var(--muted) / 0.3)' }}
                  contentStyle={tooltipStyle}
                  itemStyle={{ color: 'hsl(var(--popover-foreground))' }}
                  labelStyle={{ color: 'hsl(var(--popover-foreground))' }}
                  formatter={(v: number) => [formatPlainNumber(v), 'Soni']}
                />
                <Bar
                  dataKey="value"
                  radius={[0, 6, 6, 0]}
                  isAnimationActive={false}
                  barSize={26}
                >
                  {barEntries.map((entry) => (
                    <Cell key={entry.key} fill={entry.colour} />
                  ))}
                  <LabelList
                    dataKey="display"
                    position="right"
                    fill="hsl(var(--foreground))"
                    fontSize={12}
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      {/* Kirim / Chiqim — received vs issued flow over the range. */}
      <Card className="space-y-4 p-5">
        <header className="flex items-baseline justify-between gap-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Kirim / Chiqim
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Xom-ashyo qabul va chiqim oqimi · bugun
            </p>
          </div>
        </header>

        {chartData.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Harakat ma’lumotlari topilmadi.
          </p>
        ) : (
          <div className="h-[260px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={chartData}
                margin={{ top: 6, right: 8, bottom: 0, left: 0 }}
              >
                <defs>
                  <linearGradient
                    id="raw-dash-received"
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop
                      offset="0%"
                      stopColor="hsl(152 56% 48%)"
                      stopOpacity={0.45}
                    />
                    <stop
                      offset="100%"
                      stopColor="hsl(152 56% 48%)"
                      stopOpacity={0.03}
                    />
                  </linearGradient>
                  <linearGradient
                    id="raw-dash-issued"
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop
                      offset="0%"
                      stopColor="hsl(24 90% 55%)"
                      stopOpacity={0.35}
                    />
                    <stop
                      offset="100%"
                      stopColor="hsl(24 90% 55%)"
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
                />
                <YAxis
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                  width={40}
                  tickFormatter={(v: number) => formatQty(v)}
                />
                <Tooltip
                  contentStyle={tooltipStyle}
                  formatter={(v: number, k: string) => [
                    formatQty(v),
                    k === 'received' ? 'Kirim' : 'Chiqim',
                  ]}
                />
                <Legend
                  iconSize={8}
                  wrapperStyle={{
                    fontSize: '0.7rem',
                    color: 'hsl(var(--muted-foreground))',
                  }}
                  formatter={(v) => (v === 'received' ? 'Kirim' : 'Chiqim')}
                />
                <Area
                  key={`${seriesKey}:received`}
                  type="monotone"
                  dataKey="received"
                  stroke="hsl(152 56% 48%)"
                  strokeWidth={2}
                  fill="url(#raw-dash-received)"
                  isAnimationActive={!reducedMotion}
                  animationDuration={CHART_ANIMATION_DURATION}
                  animationEasing={CHART_ANIMATION_EASING}
                />
                <Area
                  key={`${seriesKey}:issued`}
                  type="monotone"
                  dataKey="issued"
                  stroke="hsl(24 90% 55%)"
                  strokeWidth={2}
                  fill="url(#raw-dash-issued)"
                  isAnimationActive={!reducedMotion}
                  animationDuration={CHART_ANIMATION_DURATION}
                  animationEasing={CHART_ANIMATION_EASING}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      {/* Min'dan past ro'yxati — compact top-10 list, red (central / store
          below-min look). */}
      <Card className="space-y-4 p-5">
        <header className="flex items-baseline justify-between gap-3">
          <div>
            <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <AlertTriangle
                className="size-3.5 text-destructive"
                aria-hidden="true"
              />
              Min’dan past mahsulotlar
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Eng kritik 10 ta xom-ashyo pozitsiyasi.
            </p>
          </div>
          <p className="shrink-0 text-sm text-muted-foreground">
            <span
              className={cn(
                'font-semibold tabular-nums',
                belowMinTop.length > 0
                  ? 'text-destructive'
                  : 'text-foreground',
              )}
            >
              {formatPlainNumber(below_min_items.length)}
            </span>
          </p>
        </header>

        {belowMinTop.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Min’dan past pozitsiyalar yo‘q — hammasi me’yorda.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {belowMinTop.map((item) => (
              <li
                key={`${item.product_id}-${item.location_id}`}
                className="flex items-center justify-between gap-3 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium text-foreground">
                    {item.product_name}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {item.location_name}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-4 tabular-nums">
                  <span className="font-semibold text-destructive">
                    {formatQty(item.qty)} {item.unit}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    min {formatQty(item.min_level)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    max {formatQty(item.max_level)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
