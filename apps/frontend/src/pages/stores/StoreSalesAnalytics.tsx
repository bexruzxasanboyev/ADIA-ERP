import { useState } from 'react';
import type { ComponentType } from 'react';
import { Receipt, Store, TrendingUp, Wallet } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { ErrorState, LoadingState } from '@/components/PageState';
import { useApiQuery } from '@/hooks/useApiQuery';
import {
  DateRangeFilter,
  dateRangeToQuery,
  type DateRangeValue,
} from '@/components/DateRangeFilter';
import {
  formatCurrencyCompact,
  formatPlainNumber,
} from '@/lib/format';
import { cn } from '@/lib/utils';
import { SalesChartsRow } from '@/pages/dashboard/SalesChartsRow';
import { RevenueBreakdown } from '@/pages/dashboard/executive/RevenueBreakdown';
import { TopProductsCard } from '@/pages/dashboard/executive/TopProducts';
import { revenueTitleForRange } from '@/lib/labels';
import type {
  DashboardStoresDetail,
  DashboardTopProductRow,
} from '@/lib/types';

/**
 * Do'kon Dashboard — sales analytics, scoped to the store layer.
 *
 * Owns its own date-range state and pulls the existing
 * `GET /api/dashboard/stores` payload (KPIs, two trend series, top
 * products, per-store breakdown). Every widget is scoped to the
 * SELECTED store(s) via `?store_ids=` (RBAC-intersected on the backend) —
 * the KPIs, charts and top-products list all follow the do'kon filter.
 * Renders the KPI cards in the HeroStrip style and reuses the dashboard's
 * `SalesChartsRow` (hourly-for-today, qty + revenue) fed from the
 * store-scoped `series` field.
 */
export function StoreSalesAnalytics({
  storeIds,
  showStoreBreakdown = true,
}: {
  storeIds: number[];
  /**
   * Render the per-store "Do'konlar — savdo bo'yicha" comparison block. This
   * is a multi-store (pm) view; a `store_manager` is pinned to a single store
   * so the comparison is meaningless and the parent hides it.
   */
  showStoreBreakdown?: boolean;
}) {
  const [range, setRange] = useState<DateRangeValue>({ range: 'today' });
  const query = dateRangeToQuery(range);
  const storeIdsParam =
    storeIds.length > 0 ? `&store_ids=${storeIds.join(',')}` : '';
  const { data, isLoading, error, refetch } =
    useApiQuery<DashboardStoresDetail>(
      `/api/dashboard/stores?${query}${storeIdsParam}`,
    );

  return (
    <div className="flex flex-col gap-5" data-testid="store-sales-analytics">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold tracking-tight">
            Sotuv tahlili
          </h2>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Tanlangan oraliq bo'yicha do'konlar savdosi.
          </p>
        </div>
        <DateRangeFilter value={range} onChange={setRange} />
      </div>

      {isLoading && data === null ? (
        <LoadingState />
      ) : error !== null && data === null ? (
        <ErrorState message={error} onRetry={refetch} />
      ) : data === null ? (
        <p className="py-10 text-center text-xs text-muted-foreground">
          Ma'lumot yo'q.
        </p>
      ) : (
        <StoreSalesAnalyticsView
          data={data}
          range={range}
          showStoreBreakdown={showStoreBreakdown}
        />
      )}
    </div>
  );
}

function StoreSalesAnalyticsView({
  data,
  range,
  showStoreBreakdown,
}: {
  data: DashboardStoresDetail;
  range: DateRangeValue;
  showStoreBreakdown: boolean;
}) {
  return (
    <div className="flex flex-col gap-5">
      {/* 1 — Sales KPI cards (HeroStrip style). Store-scoped. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Bugungi savdo"
          value={formatCurrencyCompact(data.kpis.sales_today_sum)}
          caption="so'm"
          Icon={Wallet}
        />
        <KpiCard
          label="Cheklar"
          value={formatPlainNumber(data.kpis.sales_today_count)}
          caption="ta"
          Icon={Receipt}
        />
        <KpiCard
          label="O'rtacha chek"
          value={formatCurrencyCompact(data.kpis.avg_receipt_today)}
          caption="so'm"
          Icon={TrendingUp}
        />
        <KpiCard
          label="Do'konlar"
          value={formatPlainNumber(data.kpis.store_count)}
          caption="ta"
          Icon={Store}
        />
      </div>

      {/* 2 — Payment-breakdown donut + Top products, side by side. Mirrors
          the executive dashboard's `xl:grid-cols-2` row (donut LEFT,
          top-products RIGHT). RevenueBreakdown owns its own fetch of the
          RBAC-scoped `/api/dashboard/revenue-breakdown` endpoint — for a
          store_manager it returns ONLY that store's payment split — so it
          just takes the same `range` and needs no extra scoping. The Top-5
          reuses the executive dashboard's TopProductsCard (owner:
          "dashboarddek bo'lsin") — same Card shell, header, rank-circle rows
          and relative-to-#1 bars. Store-scoped rows are mapped to the shared
          row shape; share is computed over the listed total. No detail sheet
          here (no full-list source), so the card is non-interactive and omits
          the "Batafsil" link. */}
      <div className="grid grid-cols-1 gap-4 sm:gap-6 xl:grid-cols-2">
        <RevenueBreakdown range={range} />
        {(() => {
          const listed = data.top_products_today;
          const totalRevenue = listed.reduce((s, p) => s + p.revenue, 0);
          const rows: DashboardTopProductRow[] = listed.map((p) => ({
            product_id: p.product_id,
            name: p.product_name,
            qty: p.qty,
            unit: p.unit,
            revenue: p.revenue,
            share: totalRevenue > 0 ? p.revenue / totalRevenue : 0,
          }));
          return (
            <TopProductsCard
              products={rows}
              title={revenueTitleForRange(range.range)}
              limit={5}
              isLoading={false}
            />
          );
        })()}
      </div>

      {/* 3 — Trend charts (qty + revenue). Reuses the dashboard's
          SalesChartsRow so "Bugun" renders an hourly curve, fed from the
          STORE-SCOPED `series` field on the stores payload. Sits BELOW the
          donut + top-products row to mirror the executive dashboard order. */}
      <SalesChartsRow
        days={data.series.days}
        granularity={data.series.granularity}
        range={range}
      />

      {/* 4 — Per-store breakdown (multi-store / pm only; hidden for a
          single-store store_manager). */}
      {showStoreBreakdown && (
      <section className="flex flex-col gap-2">
        <div>
          <h3 className="text-sm font-semibold tracking-tight">
            Do'konlar — savdo bo'yicha
          </h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Har do'konning savdo va ostatka holati.
          </p>
        </div>
        {data.store_breakdown.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            Do'kon yo'q.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-3">
            {data.store_breakdown.map((store) => (
              <Card
                key={store.location_id}
                className="flex flex-col gap-4 p-5"
              >
                {/* Store name + hero revenue. */}
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <Store
                      aria-hidden="true"
                      className="size-4 shrink-0 text-muted-foreground"
                    />
                    <p className="truncate text-sm font-semibold tracking-tight text-foreground">
                      {store.location_name}
                    </p>
                  </div>
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-2xl font-bold leading-none tabular-nums text-chain-store">
                      {formatCurrencyCompact(store.sales_sum)}
                    </span>
                    <span className="text-xs text-muted-foreground">so'm</span>
                  </div>
                </div>

                {/* Labelled metric row: label above, value below. */}
                <div className="grid grid-cols-3 gap-3 border-t border-border/40 pt-3">
                  <StoreMetric
                    label="Cheklar"
                    value={formatPlainNumber(store.sales_count)}
                  />
                  <StoreMetric
                    label="Min'dan past"
                    value={formatPlainNumber(store.below_min_count)}
                    danger={store.below_min_count > 0}
                  />
                  <StoreMetric
                    label="So'rovlar"
                    value={formatPlainNumber(store.open_replenishments)}
                  />
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>
      )}
    </div>
  );
}

function StoreMetric({
  label,
  value,
  danger = false,
}: {
  label: string;
  value: string;
  danger?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span
        className={cn(
          'text-sm font-semibold tabular-nums',
          danger ? 'text-destructive' : 'text-foreground',
        )}
      >
        {value}
      </span>
    </div>
  );
}

function KpiCard({
  label,
  value,
  caption,
  Icon,
}: {
  label: string;
  value: string;
  caption?: string;
  Icon: ComponentType<{ className?: string }>;
}) {
  return (
    <Card
      role="region"
      aria-label={label}
      className={cn(
        'flex min-h-[120px] flex-col justify-between gap-3 p-5 sm:p-6',
        'border-border/60',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
        <Icon
          aria-hidden="true"
          className="size-6 shrink-0 text-muted-foreground sm:size-7"
        />
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-3xl font-bold leading-none tabular-nums text-foreground sm:text-4xl">
          {value}
        </span>
        {caption !== undefined && (
          <span className="text-sm text-muted-foreground">{caption}</span>
        )}
      </div>
    </Card>
  );
}
