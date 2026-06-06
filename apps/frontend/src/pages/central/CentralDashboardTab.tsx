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
  CheckCircle2,
  Inbox,
  Package,
  Send,
  TrendingDown,
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
import type { Product, ReplenishmentRequest, StockRow } from '@/lib/types';
import { StoreRequestsStatusDonut } from '@/pages/stores/StoreRequestsStatusDonut';
import { StoreRequestsTrendChart } from '@/pages/stores/StoreRequestsTrendChart';
import { CentralCategoryDonut, type CategorySlice } from './CentralCategoryDonut';

/**
 * Markaziy sklad ish joyi — "Dashboard" tab (owner feedback).
 *
 * A clean, self-contained overview that mirrors the store Dashboard
 * (`StoreStockDashboard`) instead of embedding the sprawling chain-layer
 * `CentralWarehousePage`. The owner explicitly asked to drop the duplicate
 * header, the outbound "Do'konlarga jo'natish kerak" list, the inbound
 * "Ishlab chiqarish omboridan kelmoqda" list, and the bottom "Markaziy sklad
 * qoldig'i" stock table (the stock already lives in the Mahsulotlar tab), and
 * to keep a tidy KPI + chart layout like the store / main dashboard.
 *
 * Owner rule — "markaziy sklada faqat tayyor mahsulot bo'ladi": every KPI and
 * the status chart count ONLY `type === 'finished'` stock rows (so "Tayyor
 * mahsulot turlari" reads 36, matching the Mahsulotlar tab — not 144).
 *
 * Data sources (frontend-only; backend unchanged):
 *   - Stock:    GET /api/stock?location_type=central_warehouse  (+ /api/products
 *               to gate to finished, like the Mahsulotlar tab).
 *   - Shipments queued to stores:  GET /api/replenishment?status=SHIP_TO_REQUESTER
 *   - Incoming from production:     GET /api/replenishment?status=DONE_TO_WAREHOUSE
 *   - Trend / status charts: GET /api/replenishment (the incoming store
 *     requests over time, bucketed per day — same widgets the store uses).
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
    value: 'text-orange-500',
  },
  low: {
    label: 'Kam',
    colour: 'hsl(45 93% 52%)',
    value: 'text-amber-500',
  },
  out: {
    label: 'Tugagan',
    colour: 'hsl(0 84% 60%)',
    value: 'text-destructive',
  },
  enough: {
    label: 'Yetarli',
    colour: 'hsl(152 56% 48%)',
    value: 'text-emerald-500',
  },
};

/** Bar order (worst → best). */
const STATUS_ORDER: StatusKey[] = ['out', 'below_min', 'low', 'enough'];

/**
 * "Kam" (low) heuristic: at or below 120% of min but still above min — the
 * early-warning band. Mirrors the store / Mahsulotlar tab rule exactly.
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

const barTooltipStyle = {
  background: 'hsl(var(--popover))',
  border: '1px solid hsl(var(--border))',
  borderRadius: '0.5rem',
  fontSize: '0.75rem',
  color: 'hsl(var(--popover-foreground))',
};

/** A KPI card styled like the store dashboard / executive HeroStrip. */
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

export function CentralDashboardTab({
  centralId,
}: {
  /** The scoped central warehouse id, or `null` for the PM chain-wide view. */
  centralId: number | null;
}) {
  // Stock: a scoped manager fetches their precise central location; PM gets the
  // (RBAC-scoped) central-warehouse-wide list (mirrors CentralProductsTab).
  const stockUrl =
    centralId !== null
      ? `/api/stock?location_id=${centralId}`
      : '/api/stock?location_type=central_warehouse';
  const stock = useApiQuery<StockRow[]>(stockUrl);
  const products = useApiQuery<Product[]>('/api/products');

  // Shipment + incoming KPIs reuse the chain-layer replenishment queues by
  // status — the same lists CentralWarehousePage drove the KPI tiles from.
  const shipTasks = useApiQuery<ReplenishmentRequest[]>(
    '/api/replenishment?status=SHIP_TO_REQUESTER',
  );
  const incoming = useApiQuery<ReplenishmentRequest[]>(
    '/api/replenishment?status=DONE_TO_WAREHOUSE',
  );
  // All requests touching the central warehouse — feeds the per-day trend +
  // status donut (the incoming store-request dynamics over time).
  const allRequests = useApiQuery<ReplenishmentRequest[]>('/api/replenishment');

  const productById = useMemo(() => {
    const m = new Map<number, Product>();
    for (const p of products.data ?? []) m.set(p.id, p);
    return m;
  }, [products.data]);

  // Owner rule: central warehouse holds ONLY finished goods → count finished
  // stock rows only (so "Tayyor mahsulot turlari" reads 36, not 144).
  const finishedRows = useMemo(
    () =>
      (stock.data ?? []).filter(
        (r) => productById.get(r.product_id)?.type === 'finished',
      ),
    [stock.data, productById],
  );

  const counts = useMemo<StockStatusCounts>(() => {
    const c: StockStatusCounts = {
      total: finishedRows.length,
      out: 0,
      below_min: 0,
      low: 0,
      enough: 0,
    };
    for (const r of finishedRows) c[stockStatusOf(r)] += 1;
    return c;
  }, [finishedRows]);

  // Owner feedback #17: only products CURRENTLY IN STOCK (qty > 0). "Tugagan"
  // (qty = 0) products drop out of the category donut and the headline central
  // count, so "Tayyor mahsulot turlari" reflects what the warehouse actually
  // holds right now — not every product type that ever existed.
  const inStockRows = useMemo(
    () => finishedRows.filter((r) => r.qty > 0),
    [finishedRows],
  );

  // Per-category distinct finished-product counts (owner feedback #12, #17) —
  // feeds the "Kategoriya bo'yicha mahsulotlar" donut. Only IN-STOCK (qty > 0)
  // finished rows are bucketed by their product's Poster category; rows whose
  // product has no category fall into a "Kategoriyasiz" bucket.
  const categorySlices = useMemo<CategorySlice[]>(() => {
    const NULL_KEY = '__none__';
    const counts = new Map<string, { label: string; value: number }>();
    for (const r of inStockRows) {
      const name = productById.get(r.product_id)?.poster_category?.name ?? null;
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
  }, [inStockRows, productById]);

  // Requests where the central warehouse is the supplier (target). For a scoped
  // manager that's their location; PM sees all central-targeted requests.
  const centralRequests = useMemo<ReplenishmentRequest[]>(() => {
    const rows = allRequests.data ?? [];
    if (centralId === null) return rows;
    return rows.filter((r) => r.target_location_id === centralId);
  }, [allRequests.data, centralId]);

  const barEntries = STATUS_ORDER.map((key) => ({
    key,
    label: STATUS_META[key].label,
    value: counts[key],
    colour: STATUS_META[key].colour,
    display: `${formatPlainNumber(counts[key])} · ${formatPct(counts[key], counts.total)}`,
  }));

  // First load: the stock query gates the finished-only KPIs + status chart.
  if (stock.isLoading && stock.data === null) {
    return <LoadingState />;
  }
  if (stock.error && stock.data === null) {
    return (
      <Card>
        <ErrorState message={stock.error} onRetry={stock.refetch} />
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* KPI cards — finished-only stock health + the central queues. Even
          strip of 5, collapsing to 2/3-up on narrower screens (store style). */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <KpiCard
          label="Tayyor mahsulot turlari"
          value={inStockRows.length}
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
          label="Jo‘natma topshiriqlari"
          value={shipTasks.data?.length ?? 0}
          caption="so‘rov"
          Icon={Send}
          iconClass="text-emerald-500"
        />
        <KpiCard
          label="Kelayotgan"
          value={incoming.data?.length ?? 0}
          caption="jo‘natma"
          Icon={Inbox}
          iconClass="text-primary"
        />
        <KpiCard
          label={STATUS_META.enough.label}
          value={counts.enough}
          caption="pozitsiya"
          Icon={CheckCircle2}
          valueClass={STATUS_META.enough.value}
          iconClass={STATUS_META.enough.value}
        />
      </div>

      {/* Status BAR chart (owner: do'kondek) — one horizontal bar per status,
          coloured by tone, with a "count · %" end label. Finished stock only. */}
      <Card className="space-y-4 p-5 sm:p-6">
        <header className="flex items-baseline justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Holat bo‘yicha taqsimot
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Tayyor mahsulot holati bo‘yicha · jonli qoldiq
            </p>
          </div>
          <p className="shrink-0 text-sm text-muted-foreground">
            Jami{' '}
            <span className="font-semibold tabular-nums text-foreground">
              {formatPlainNumber(counts.total)}
            </span>
          </p>
        </header>

        {counts.total === 0 ? (
          <p className="text-sm text-muted-foreground">
            Tayyor mahsulot qoldig‘i topilmadi.
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

      {/* Kategoriya bo'yicha mahsulotlar (owner feedback #12) — a donut of the
          distinct finished-product count per Poster category. Sits below the
          status bar chart, above the requests dynamics. */}
      <CentralCategoryDonut categories={categorySlices} />

      {/* Requests dynamics (owner: "trend bar chart kerak do'kondek") — the
          incoming store requests over time + a status donut, the SAME widgets
          the store workflow page uses, reused with the central-scoped set. */}
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
      ) : centralRequests.length === 0 ? (
        <Card>
          <EmptyState message="Hozircha do‘konlardan so‘rov yo‘q." />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <StoreRequestsStatusDonut requests={centralRequests} />
          <StoreRequestsTrendChart requests={centralRequests} />
        </div>
      )}
    </div>
  );
}
