import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/PageState';
import {
  dateRangeToQuery,
  type DateRangeValue,
} from '@/components/DateRangeFilter';
import { prefetchApiQuery, useApiQuery } from '@/hooks/useApiQuery';
import { todayIso } from '@/lib/format';
import type {
  DashboardEcosystem,
  DashboardOverview,
  PurchaseOrder,
  ReplenishmentRequest,
} from '@/lib/types';
import { useHeaderSlot } from '@/components/layout/HeaderSlot';
import { DashboardHeaderSlot } from './DashboardHeaderSlot';
import { HeroStrip } from './HeroStrip';
import { CriticalAlerts } from './CriticalAlerts';
import { MyActionsList } from './MyActionsList';
import { ProductionPlanSummary } from './ProductionPlanSummary';
import { DashboardSecondaryRow } from './DashboardSecondaryRow';
import { RevenueBreakdown } from './RevenueBreakdown';
import { TopProducts } from './TopProducts';
import { SalesChartsRow } from '../SalesChartsRow';
import { ExecutiveDashboardSkeleton } from './ExecutiveDashboardSkeleton';

/**
 * Executive dashboard — insight-first redesign (2026-05).
 *
 * The previous version centred a React-Flow node graph of the whole
 * ecosystem; it degraded badly as locations multiplied (crossing edges,
 * overlap, nothing scannable). It is gone. The first view is now built
 * around answers, not topology:
 *
 *   1. HeaderSlot         — greeting + date-range filter (layout-owned)
 *   2. HeroStrip          — 4 clickable KPI cards (revenue / receipts /
 *                           active requests / critical positions)
 *   3. RevenueBreakdown   — revenue split donut + legend (payment methods)
 *   4. SalesChartsRow     — today's sales count + revenue area charts
 *   5. Action row         — CriticalAlerts + MyActionsList (the approval
 *                           queue) + today's production digest
 *   6. SecondaryRowGuard  — forecasts, full plan / open-requests tables
 *                           (below the fold)
 *
 * Auto-refresh: 30 s while the tab is visible. The page is the only
 * place that knows the polling cadence — every child reads the snapshot.
 */
export function ExecutiveDashboardPage() {
  const navigate = useNavigate();
  const [range, setRange] = useState<DateRangeValue>({ range: 'today' });
  const rangeQuery = dateRangeToQuery(range);

  const overview = useApiQuery<DashboardOverview>(
    `/api/dashboard/overview?${rangeQuery}`,
  );
  const ecosystem = useApiQuery<DashboardEcosystem>(
    `/api/dashboard/ecosystem?${rangeQuery}`,
  );
  const purchaseOrders = useApiQuery<PurchaseOrder[]>(
    '/api/purchase-orders?status=draft',
  );
  // NEW replenishment requests are part of the boshliq's queue too; the
  // backend RBAC-scopes the list to what they can act on.
  const replenishments = useApiQuery<ReplenishmentRequest[]>(
    '/api/replenishment?status=NEW',
  );

  const overviewRefetch = overview.refetch;
  const ecosystemRefetch = ecosystem.refetch;
  const purchaseOrdersRefetch = purchaseOrders.refetch;
  const replenishmentsRefetch = replenishments.refetch;
  useEffect(() => {
    const REFRESH_MS = 30_000;
    let timer: number | null = null;
    const start = () => {
      if (timer !== null) return;
      timer = window.setInterval(() => {
        if (!document.hidden) {
          overviewRefetch();
          ecosystemRefetch();
          purchaseOrdersRefetch();
          replenishmentsRefetch();
        }
      }, REFRESH_MS);
    };
    const stop = () => {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    };
    if (!document.hidden) start();
    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [
    overviewRefetch,
    ecosystemRefetch,
    purchaseOrdersRefetch,
    replenishmentsRefetch,
  ]);

  // Warm the range-driven endpoints for the three presets the boshliq
  // toggles most (Bugun / Bu hafta / Bu oy) once on mount. With the
  // useApiQuery stale-while-revalidate cache populated ahead of time,
  // switching the date-range filter renders instantly with no loader.
  // Presets map to a bare `{ range }` value, exactly as DateRangeFilter's
  // `selectPreset` builds them. Prefetches are plain GETs that only fill
  // the cache; `prefetchApiQuery` already swallows errors and no-ops on a
  // fresh/in-flight entry, so warming the currently-active range too is
  // harmless. Mount-only — the empty dep array is intentional.
  useEffect(() => {
    const PRESETS: DateRangeValue[] = [
      { range: 'today' },
      { range: 'week' },
      { range: 'month' },
    ];
    for (const preset of PRESETS) {
      const q = dateRangeToQuery(preset);
      prefetchApiQuery(`/api/dashboard/revenue-breakdown?${q}`);
      prefetchApiQuery(`/api/dashboard/top-products?${q}&limit=5`);
      // Key matches SalesChartsRow's live query (default `by=product`,
      // `limit=6`) so the warmed entry is actually a cache hit there.
      prefetchApiQuery(`/api/dashboard/sales-breakdown?${q}&by=product&limit=6`);
      prefetchApiQuery(`/api/dashboard/ecosystem?${q}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const today = useMemo(() => todayIso(), []);

  useHeaderSlot(
    <DashboardHeaderSlot
      isoDate={today}
      range={range}
      onRangeChange={setRange}
    />,
  );

  // Initial-load skeleton — overview is the keystone request. A full-layout
  // skeleton (not a centred spinner) so the page doesn't jump when data lands.
  if (overview.isLoading && overview.data === null) {
    return <ExecutiveDashboardSkeleton />;
  }

  if (overview.error && overview.data === null) {
    return <ErrorState message={overview.error} onRetry={overview.refetch} />;
  }

  if (overview.data === null) {
    return null;
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <HeroStrip
        overview={overview.data}
        ecosystem={ecosystem.data}
        range={range}
        onNavigate={navigate}
        ecosystemLoading={ecosystem.isLoading && ecosystem.data === null}
      />

      <div className="grid grid-cols-1 gap-4 sm:gap-6 xl:grid-cols-2">
        <RevenueBreakdown
          range={range}
          fallbackTotal={ecosystem.data?.poster_status.sales_today_sum ?? 0}
        />
        <TopProducts range={range} limit={5} />
      </div>

      {/* Always render the row so each chart owns its own skeleton while the
          ecosystem query is still loading — no late pop-in after the page
          skeleton disappears. When data lands the series fill in smoothly. */}
      <SalesChartsRow
        days={ecosystem.data?.sales_chart.days ?? []}
        granularity={ecosystem.data?.sales_chart.granularity}
        loading={ecosystem.isLoading && ecosystem.data === null}
        range={range}
      />

      <div className="grid gap-4 sm:gap-6 xl:grid-cols-12">
        <CriticalAlerts
          belowMin={overview.data.below_min}
          alerts={ecosystem.data?.alerts_feed ?? []}
          criticalCount={overview.data.kpis.below_min_count}
          className="xl:col-span-5"
        />
        <MyActionsList
          purchaseOrders={purchaseOrders.data ?? []}
          replenishments={replenishments.data ?? []}
          className="xl:col-span-4"
        />
        <ProductionPlanSummary
          items={overview.data.production_plan}
          className="xl:col-span-3"
        />
      </div>

      <SecondaryRowGuard overview={overview.data} range={range} />
    </div>
  );
}

function SecondaryRowGuard({
  overview,
  range,
}: {
  overview: DashboardOverview;
  range: DateRangeValue;
}) {
  const isEmpty =
    overview.kpis.total_open_requests === 0 &&
    overview.kpis.below_min_count === 0 &&
    overview.kpis.active_production_orders === 0 &&
    overview.kpis.pending_approvals === 0 &&
    overview.production_plan.length === 0;

  if (isEmpty) {
    return (
      <Card className="p-6 text-center text-sm text-muted-foreground">
        Hozircha kuzatish uchun ma’lumot yo‘q.
      </Card>
    );
  }
  return <DashboardSecondaryRow overview={overview} range={range} />;
}
