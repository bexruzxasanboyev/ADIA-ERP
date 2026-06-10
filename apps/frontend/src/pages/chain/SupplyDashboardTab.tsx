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
  Inbox,
  Package,
  PackageCheck,
  Send,
  TrendingDown,
  Truck,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import {
  EmptyState,
  ErrorState,
  LoadingState,
} from '@/components/PageState';
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
import type {
  DashboardSupplyDetail,
  ReplenishmentRequest,
  StockRow,
} from '@/lib/types';
import { StoreRequestsStatusDonut } from '@/pages/stores/StoreRequestsStatusDonut';
import { StoreRequestsTrendChart } from '@/pages/stores/StoreRequestsTrendChart';

/**
 * Ishlab chiqarish omborlari (ta'minot / sex_storage) ish joyi — "Dashboard"
 * tab. A clean, self-contained overview mirroring the central warehouse
 * Dashboard (`CentralDashboardTab`) and the store Dashboard
 * (`StoreStockDashboard`): a KPI strip + a stock-status bar chart + a
 * received/shipped area chart + a top-destinations list + the request
 * dynamics (status donut + per-day trend).
 *
 * Data sources (frontend-only; backend unchanged):
 *   - Detail:  GET /api/dashboard/supply  → DashboardSupplyDetail
 *              (kpis, daily_flow, top_destinations_today, open_request_items).
 *   - Stock:   GET /api/stock?location_type=sex_storage  +  ?location_type=supply
 *              (the supply layer spans BOTH enum types — D7 migrated `supply`
 *              → `sex_storage`; the stock filter matches exactly one `l.type`,
 *              so we fetch both and merge for the status-bar counts, matching
 *              the dashboard's SUPPLY_LAYER_TYPES = ['supply','sex_storage']).
 *   - Charts:  GET /api/replenishment  → the requests this layer services,
 *              feeding the status donut + per-day trend (the SAME widgets the
 *              store / central workflow pages use).
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
 * early-warning band. Mirrors the store / central tab rule exactly.
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

/** A KPI card styled like the central / store dashboard. */
function KpiCard({
  label,
  value,
  caption,
  Icon,
  valueClass,
  iconClass,
}: {
  label: string;
  value: number;
  caption: string;
  Icon: ComponentType<{ className?: string }>;
  valueClass?: string;
  iconClass?: string;
}) {
  return (
    <Card className="flex flex-col justify-between gap-3 p-5">
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
          {formatPlainNumber(value)}
        </span>
        <span className="text-xs text-muted-foreground">{caption}</span>
      </div>
    </Card>
  );
}

export function SupplyDashboardTab({
  supplyLocationId,
}: {
  /** The scoped sex-storage location id, or `null` for the PM layer-wide view. */
  supplyLocationId: number | null;
}) {
  // Detail endpoint — KPIs, daily flow, top destinations, open requests. The
  // backend RBAC-scopes this to the principal's supply location(s).
  const detail = useApiQuery<DashboardSupplyDetail>('/api/dashboard/supply');

  // Stock for the status-bar counts. The supply layer spans BOTH enum types
  // (`supply` legacy + `sex_storage`); the stock filter matches exactly one
  // `l.type`, so we fetch each and merge. A scoped manager's RBAC intersection
  // keeps both queries to their own location rows.
  const sexStock = useApiQuery<StockRow[]>(
    '/api/stock?location_type=sex_storage',
  );
  const supplyStock = useApiQuery<StockRow[]>('/api/stock?location_type=supply');

  // All requests — feeds the per-day trend + status donut. Filtered to the
  // requests this supply layer services (mirrors CentralDashboardTab's scope).
  const allRequests = useApiQuery<ReplenishmentRequest[]>('/api/replenishment');

  const reducedMotion = usePrefersReducedMotion();

  // Merge the two stock sets, de-duplicated by (location_id, product_id).
  const stockRows = useMemo<StockRow[]>(() => {
    const byKey = new Map<string, StockRow>();
    for (const r of sexStock.data ?? []) {
      byKey.set(`${r.location_id}-${r.product_id}`, r);
    }
    for (const r of supplyStock.data ?? []) {
      byKey.set(`${r.location_id}-${r.product_id}`, r);
    }
    return [...byKey.values()];
  }, [sexStock.data, supplyStock.data]);

  const counts = useMemo<StockStatusCounts>(() => {
    const c: StockStatusCounts = {
      total: stockRows.length,
      out: 0,
      below_min: 0,
      low: 0,
      enough: 0,
    };
    for (const r of stockRows) c[stockStatusOf(r)] += 1;
    return c;
  }, [stockRows]);

  const barEntries = STATUS_ORDER.map((key) => ({
    key,
    label: STATUS_META[key].label,
    value: counts[key],
    colour: STATUS_META[key].colour,
    display: `${formatPlainNumber(counts[key])} · ${formatPct(counts[key], counts.total)}`,
  }));

  // Received / shipped area-chart series (per day, or per hour for range=today).
  const flow = detail.data?.daily_flow ?? [];
  const granularity = detail.data?.daily_granularity;
  const flowData = useMemo(
    () =>
      flow.map((p) => ({
        date: p.date,
        received: p.received,
        shipped: p.shipped,
        label: chartBucketLabel(p, granularity),
      })),
    [flow, granularity],
  );
  const flowSeriesKey = useMemo(
    () => chartSeriesKey(granularity, flowData),
    [granularity, flowData],
  );

  // Requests this supply layer services. A scoped manager filters to their own
  // location (as requester OR target); PM sees all.
  const supplyRequests = useMemo<ReplenishmentRequest[]>(() => {
    const rows = allRequests.data ?? [];
    if (supplyLocationId === null) return rows;
    return rows.filter(
      (r) =>
        r.target_location_id === supplyLocationId ||
        r.requester_location_id === supplyLocationId,
    );
  }, [allRequests.data, supplyLocationId]);

  const topDestinations = detail.data?.top_destinations_today ?? [];
  const maxDestQty = topDestinations.reduce((m, d) => Math.max(m, d.qty), 0);

  // First load: gate on the detail endpoint (drives the KPI strip + charts).
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

  const kpis = detail.data.kpis;

  return (
    <div className="space-y-4">
      {/* KPI cards — supply flow + stock health. Even strip of 5, collapsing
          to 2/3-up on narrower screens (central / store style). */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <KpiCard
          label="Joriy qoldiq turlari"
          value={kpis.current_stock_count}
          caption="mavjud"
          Icon={Package}
          iconClass="text-primary"
        />
        <KpiCard
          label={STATUS_META.below_min.label}
          value={counts.below_min}
          caption="pozitsiya"
          Icon={TrendingDown}
          valueClass={STATUS_META.below_min.value}
          iconClass={STATUS_META.below_min.value}
        />
        <KpiCard
          label="Bugun jo‘natilgan"
          value={kpis.shipped_today}
          caption="birlik"
          Icon={Send}
          iconClass="text-success"
        />
        <KpiCard
          label="Bugun qabul"
          value={kpis.received_today}
          caption="birlik"
          Icon={PackageCheck}
          iconClass="text-primary"
        />
        <KpiCard
          label="Ochiq so‘rovlar"
          value={kpis.open_requests}
          caption="so‘rov"
          Icon={Inbox}
          iconClass={kpis.open_requests > 0 ? 'text-warning' : undefined}
        />
      </div>

      {/* Status BAR chart — one horizontal bar per status, coloured by tone,
          with a "count · %" end label (do'kon / markaziy style). */}
      <Card className="space-y-4 p-5">
        <header className="flex items-baseline justify-between gap-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Holat bo‘yicha taqsimot
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Ishlab chiqarish omborlari qoldig‘i bo‘yicha · jonli holat
            </p>
          </div>
          <p className="shrink-0 text-sm text-muted-foreground">
            Jami{' '}
            <span className="font-semibold tabular-nums text-foreground">
              {formatPlainNumber(counts.total)}
            </span>
          </p>
        </header>

        {sexStock.isLoading && supplyStock.isLoading && counts.total === 0 ? (
          <LoadingState />
        ) : counts.total === 0 ? (
          <p className="text-sm text-muted-foreground">Qoldiq topilmadi.</p>
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

      {/* Qabul / Jo'natma — received vs shipped area chart over the range. */}
      <Card className="space-y-4 p-5">
        <header className="flex items-baseline justify-between gap-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Qabul / Jo‘natma oqimi
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Ishlab chiqarishdan qabul va markaziy skladga jo‘natma.
            </p>
          </div>
        </header>
        <div className="h-56 w-full">
          {flowData.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Ma’lumot yo‘q.
            </p>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={flowData}
                margin={{ top: 6, right: 8, bottom: 0, left: 0 }}
              >
                <defs>
                  <linearGradient id="supply-received" x1="0" y1="0" x2="0" y2="1">
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
                  <linearGradient id="supply-shipped" x1="0" y1="0" x2="0" y2="1">
                    <stop
                      offset="0%"
                      stopColor="hsl(217 91% 60%)"
                      stopOpacity={0.4}
                    />
                    <stop
                      offset="100%"
                      stopColor="hsl(217 91% 60%)"
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
                  width={36}
                  tickFormatter={(v: number) => formatQty(v)}
                />
                <Tooltip
                  contentStyle={tooltipStyle}
                  formatter={(v: number, k: string) => [
                    formatQty(v),
                    k === 'received' ? 'Qabul' : 'Jo‘natma',
                  ]}
                />
                <Legend
                  iconSize={8}
                  wrapperStyle={{
                    fontSize: '0.7rem',
                    color: 'hsl(var(--muted-foreground))',
                  }}
                  formatter={(v) => (v === 'received' ? 'Qabul' : 'Jo‘natma')}
                />
                <Area
                  key={`${flowSeriesKey}:received`}
                  type="monotone"
                  dataKey="received"
                  stroke="hsl(152 56% 48%)"
                  strokeWidth={2}
                  fill="url(#supply-received)"
                  isAnimationActive={!reducedMotion}
                  animationDuration={CHART_ANIMATION_DURATION}
                  animationEasing={CHART_ANIMATION_EASING}
                />
                <Area
                  key={`${flowSeriesKey}:shipped`}
                  type="monotone"
                  dataKey="shipped"
                  stroke="hsl(217 91% 60%)"
                  strokeWidth={2}
                  fill="url(#supply-shipped)"
                  isAnimationActive={!reducedMotion}
                  animationDuration={CHART_ANIMATION_DURATION}
                  animationEasing={CHART_ANIMATION_EASING}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </Card>

      {/* Bugun eng ko'p jo'natilgan manzillar — a compact bar list. */}
      <Card className="space-y-4 p-5">
        <header className="flex items-center gap-2">
          <Truck className="size-4 text-chain-supply" aria-hidden="true" />
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Bugun eng ko‘p jo‘natilgan manzillar
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Bugungi jo‘natma hajmi bo‘yicha qabul qiluvchi bo‘g‘inlar.
            </p>
          </div>
        </header>
        {topDestinations.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Bugun jo‘natma bo‘lmagan.
          </p>
        ) : (
          <ul className="space-y-2.5">
            {topDestinations.map((d) => (
              <li key={d.location_id} className="space-y-1">
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate font-medium">
                    {d.location_name}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {formatQty(d.qty)}
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted/40">
                  <div
                    className="h-full rounded-full bg-chain-supply"
                    style={{
                      width: `${maxDestQty > 0 ? (d.qty / maxDestQty) * 100 : 0}%`,
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* So'rovlar dinamikasi — status donut + per-day trend, the SAME widgets
          the store / central workflow pages use, scoped to this supply layer. */}
      {allRequests.isLoading && allRequests.data === null ? (
        <Card>
          <LoadingState />
        </Card>
      ) : allRequests.error && allRequests.data === null ? (
        <Card>
          <ErrorState
            message={allRequests.error}
            onRetry={allRequests.refetch}
          />
        </Card>
      ) : supplyRequests.length === 0 ? (
        <Card>
          <EmptyState message="Hozircha so‘rovlar yo‘q." />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <StoreRequestsStatusDonut requests={supplyRequests} />
          <StoreRequestsTrendChart requests={supplyRequests} />
        </div>
      )}
    </div>
  );
}
