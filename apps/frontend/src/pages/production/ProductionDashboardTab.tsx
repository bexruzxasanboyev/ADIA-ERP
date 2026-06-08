import { useMemo, type ComponentType } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  AlertTriangle,
  ClipboardList,
  Factory,
  Layers,
  Package,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import {
  EmptyState,
  ErrorState,
  LoadingState,
} from '@/components/PageState';
import { useApiQuery } from '@/hooks/useApiQuery';
import { formatPlainNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import type {
  ChainLayerOverview,
  Product,
  ProductionOrder,
  ReplenishmentRequest,
} from '@/lib/types';
import { StoreRequestsStatusDonut } from '@/pages/stores/StoreRequestsStatusDonut';
import { StoreRequestsTrendChart } from '@/pages/stores/StoreRequestsTrendChart';
import { CentralCategoryDonut, type CategorySlice } from '@/pages/central/CentralCategoryDonut';

/**
 * Ishlab chiqarish bo'limi ish joyi — "Dashboard" tab.
 *
 * A clean, production-отдел-scoped overview that MIRRORS the central warehouse
 * Dashboard (`CentralDashboardTab`): the same KPI strip + status bar chart +
 * category donut + request-dynamics (donut + trend) layout and spacing. Forked
 * rather than redesigned (owner: "make me a dashboard just like central/store").
 *
 * Where the central dashboard reads finished-goods STOCK health, a production
 * отдел cares about its ORDER pipeline + the catalogue it owns, so the KPIs are
 * re-pointed at production-relevant figures:
 *   - Faol zayafkalar       — production orders in_progress.
 *   - Kutilayotgan zayafkalar — production orders new (queued).
 *   - Yarim tayyor turlari   — the отдел's зг count (/api/products/yarim-tayyor).
 *   - Min'dan past           — raw inputs below min at this отдел.
 *   - Tayyor mahsulot turlari — finished products THIS отдел makes (workshop).
 *
 * Charts:
 *   - Holat bo'yicha taqsimot — a horizontal bar chart of the order pipeline
 *     (kutilmoqda / ishlab chiqarilmoqda / tayyor bugun), the same visual shape
 *     as the central status bar.
 *   - Kategoriya bo'yicha mahsulotlar — a donut of the отдел's finished products
 *     per Poster category (reuses CentralCategoryDonut).
 *   - So'rovlar dinamikasi + holati — the отдел's replenishment requests over
 *     time, the SAME generic widgets the store + central pages use.
 *
 * Data sources (all RBAC-scoped server-side for production_manager; PM sees the
 * chain-wide aggregate):
 *   - GET /api/dashboard/chain-layer/production  (below-min + order totals)
 *   - GET /api/products/yarim-tayyor             (зг count)
 *   - GET /api/products                          (finished-by-workshop count + donut)
 *   - GET /api/production-orders?status=in_progress | new | done
 *   - GET /api/replenishment                     (request dynamics)
 */

/** A зг row — the yarim-tayyor endpoint returns Product PLUS an on-hand `qty`. */
type SemiProduct = Product & { qty: number };

/** Order-pipeline bar buckets (worst → best), mirroring the central status bar. */
type OrderStageKey = 'pending' | 'in_progress' | 'done_today';

const ORDER_STAGE_META: Record<
  OrderStageKey,
  { label: string; colour: string }
> = {
  pending: { label: 'Kutilmoqda', colour: 'hsl(45 93% 52%)' }, // amber
  in_progress: { label: 'Ishlab chiqarilmoqda', colour: 'hsl(217 91% 60%)' }, // blue
  done_today: { label: 'Bugun tayyor', colour: 'hsl(152 56% 48%)' }, // emerald
};

const ORDER_STAGE_ORDER: OrderStageKey[] = [
  'pending',
  'in_progress',
  'done_today',
];

function formatPct(part: number, total: number): string {
  if (total <= 0) return '0%';
  const pct = (part / total) * 100;
  return `${pct >= 10 ? Math.round(pct) : pct.toFixed(1)}%`;
}

const barTooltipStyle = {
  background: 'hsl(var(--popover))',
  border: '1px solid hsl(var(--border))',
  borderRadius: '0.5rem',
  fontSize: '0.75rem',
  color: 'hsl(var(--popover-foreground))',
};

/** A KPI card styled exactly like the central dashboard's KpiCard. */
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
    <Card className="flex min-h-[140px] flex-col justify-between gap-3 border-border/60 p-5 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
        <Icon
          aria-hidden="true"
          className={cn('size-6 shrink-0 sm:size-7', iconClass)}
        />
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span
          className={cn(
            'text-4xl font-bold leading-none tabular-nums sm:text-5xl',
            valueClass,
          )}
        >
          {formatPlainNumber(value)}
        </span>
        <span className="text-sm text-muted-foreground">{caption}</span>
      </div>
    </Card>
  );
}

export function ProductionDashboardTab({
  productionId,
}: {
  /** The scoped production отдел id, or `null` for the PM chain-wide view. */
  productionId: number | null;
}) {
  // Layer aggregate — below-min raw inputs + active-order totals. RBAC-scoped to
  // the отдел for a production_manager; chain-wide for PM.
  const overview = useApiQuery<ChainLayerOverview>(
    '/api/dashboard/chain-layer/production',
  );

  // The отдел's зг catalogue (semi-finished). Auto-scoped server-side for a
  // production_manager; PM sees every type='semi' product.
  const semi = useApiQuery<SemiProduct[]>('/api/products/yarim-tayyor');

  // Full catalogue — used to count the FINISHED products this отдел makes (the
  // backend does not filter /api/products by workshop, so we filter here) and
  // to bucket them by Poster category for the donut.
  const products = useApiQuery<Product[]>('/api/products');

  // Order pipeline queues by status — the same lists ProductionPage drives its
  // KPI tiles from.
  const active = useApiQuery<ProductionOrder[]>(
    '/api/production-orders?status=in_progress',
  );
  const pending = useApiQuery<ProductionOrder[]>(
    '/api/production-orders?status=new',
  );
  const done = useApiQuery<ProductionOrder[]>(
    '/api/production-orders?status=done',
  );

  // All requests touching the отдел — feeds the per-day trend + status donut.
  const allRequests = useApiQuery<ReplenishmentRequest[]>('/api/replenishment');

  // Finished products THIS отдел makes (workshop === productionId). A scoped
  // production_manager filters to their отдел; PM (productionId null) counts
  // every finished product that has a workshop assigned.
  const finishedProducts = useMemo<Product[]>(
    () =>
      (products.data ?? []).filter((p) => {
        if (p.type !== 'finished') return false;
        if (productionId === null) return p.workshop != null;
        return p.workshop?.id === productionId;
      }),
    [products.data, productionId],
  );

  // Per-category distinct finished-product counts — feeds the
  // "Kategoriya bo'yicha mahsulotlar" donut (reused from central).
  const categorySlices = useMemo<CategorySlice[]>(() => {
    const NULL_KEY = '__none__';
    const counts = new Map<string, { label: string; value: number }>();
    for (const p of finishedProducts) {
      const name = p.poster_category?.name ?? null;
      const key = name ?? NULL_KEY;
      const label = name ?? 'Kategoriyasiz';
      const bucket = counts.get(key);
      if (bucket) bucket.value += 1;
      else counts.set(key, { label, value: 1 });
    }
    return [...counts.entries()].map(([key, { label, value }]) => ({
      key,
      label,
      value,
    }));
  }, [finishedProducts]);

  // The отдел's own requests — for a scoped manager that's where the отдел is
  // the requester or the production target; PM sees them all.
  const productionRequests = useMemo<ReplenishmentRequest[]>(() => {
    const rows = allRequests.data ?? [];
    if (productionId === null) return rows;
    return rows.filter(
      (r) =>
        r.target_location_id === productionId ||
        r.requester_location_id === productionId,
    );
  }, [allRequests.data, productionId]);

  const activeCount =
    overview.data?.totals.active_production_orders ?? active.data?.length ?? 0;
  const pendingCount = pending.data?.length ?? 0;
  const belowMinCount = overview.data?.totals.below_min_count ?? 0;

  // Order-pipeline bar entries (count + %). Bugun-tayyor counts orders whose
  // done_at landed today.
  const doneToday = useMemo(() => {
    const today = new Date().toDateString();
    return (done.data ?? []).filter(
      (o) => o.done_at != null && new Date(o.done_at).toDateString() === today,
    ).length;
  }, [done.data]);

  const orderCounts: Record<OrderStageKey, number> = {
    pending: pendingCount,
    in_progress: active.data?.length ?? activeCount,
    done_today: doneToday,
  };
  const orderTotal =
    orderCounts.pending + orderCounts.in_progress + orderCounts.done_today;

  const barEntries = ORDER_STAGE_ORDER.map((key) => ({
    key,
    label: ORDER_STAGE_META[key].label,
    value: orderCounts[key],
    colour: ORDER_STAGE_META[key].colour,
    display: `${formatPlainNumber(orderCounts[key])} · ${formatPct(orderCounts[key], orderTotal)}`,
  }));

  // First load: the layer overview gates the KPI strip + status chart.
  if (overview.isLoading && overview.data === null) {
    return <LoadingState />;
  }
  if (overview.error && overview.data === null) {
    return (
      <Card>
        <ErrorState message={overview.error} onRetry={overview.refetch} />
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* KPI cards — order pipeline + the отдел's catalogue health. Even strip
          of 5, collapsing to 2/3-up on narrower screens (central style). */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <KpiCard
          label="Faol zayafkalar"
          value={activeCount}
          caption="ishlab chiqarilmoqda"
          Icon={Factory}
          iconClass="text-amber-500"
        />
        <KpiCard
          label="Kutilayotgan zayafkalar"
          value={pendingCount}
          caption="navbatda"
          Icon={ClipboardList}
          valueClass={pendingCount > 0 ? 'text-amber-500' : undefined}
          iconClass={pendingCount > 0 ? 'text-amber-500' : 'text-muted-foreground'}
        />
        <KpiCard
          label="Yarim tayyor turlari"
          value={semi.data?.length ?? 0}
          caption="зг"
          Icon={Layers}
          iconClass="text-primary"
        />
        <KpiCard
          label="Min’dan past"
          value={belowMinCount}
          caption="pozitsiya"
          Icon={AlertTriangle}
          valueClass={belowMinCount > 0 ? 'text-destructive' : undefined}
          iconClass={belowMinCount > 0 ? 'text-destructive' : 'text-muted-foreground'}
        />
        <KpiCard
          label="Tayyor mahsulot turlari"
          value={finishedProducts.length}
          caption="ishlab chiqaradi"
          Icon={Package}
          iconClass="text-emerald-500"
        />
      </div>

      {/* Order-pipeline BAR chart (central "Holat bo'yicha taqsimot" shape) —
          one horizontal bar per pipeline stage, coloured by tone, with a
          "count · %" end label. */}
      <Card className="space-y-4 p-5 sm:p-6">
        <header className="flex items-baseline justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Zayafkalar holati
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Ishlab chiqarish zayafkalari bosqichlari bo‘yicha
            </p>
          </div>
          <p className="shrink-0 text-sm text-muted-foreground">
            Jami{' '}
            <span className="font-semibold tabular-nums text-foreground">
              {formatPlainNumber(orderTotal)}
            </span>
          </p>
        </header>

        {orderTotal === 0 ? (
          <p className="text-sm text-muted-foreground">
            Hozircha zayafka yo‘q.
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
                  width={150}
                  tickLine={false}
                  axisLine={false}
                  tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 13 }}
                />
                <Tooltip
                  cursor={{ fill: 'hsl(var(--muted) / 0.3)' }}
                  contentStyle={barTooltipStyle}
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

      {/* Kategoriya bo'yicha mahsulotlar — a donut of the отдел's finished
          products per Poster category (reused from central). */}
      <CentralCategoryDonut categories={categorySlices} />

      {/* Requests dynamics — the отдел's replenishment requests over time + a
          status donut, the SAME generic widgets the store + central pages use. */}
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
      ) : productionRequests.length === 0 ? (
        <Card>
          <EmptyState message="Hozircha so‘rov yo‘q." />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <StoreRequestsStatusDonut requests={productionRequests} />
          <StoreRequestsTrendChart requests={productionRequests} />
        </div>
      )}
    </div>
  );
}
