import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/PageState';
import {
  dateRangeToQuery,
  type DateRangePreset,
  type DateRangeValue,
} from '@/components/DateRangeFilter';
import { prefetchApiQuery, useApiQuery } from '@/hooks/useApiQuery';
import { useAuth } from '@/hooks/useAuth';
import { todayIso } from '@/lib/format';
import type {
  DashboardEcosystem,
  DashboardOverview,
  KpiProductsResponse,
  PurchaseOrder,
  ReplenishmentRequest,
} from '@/lib/types';
import { useHeaderSlot } from '@/components/layout/HeaderSlot';
import { DashboardHeaderSlot } from './DashboardHeaderSlot';
import { HeroStrip } from './HeroStrip';
import { ChainHealthRow } from './ChainHealthRow';
import { QualityRow } from './QualityRow';
import { ProfitSummary } from './ProfitSummary';
import { CriticalAlerts } from './CriticalAlerts';
import { MyActionsList } from './MyActionsList';
import { ProductionPlanSummary } from './ProductionPlanSummary';
import { DashboardSecondaryRow } from './DashboardSecondaryRow';
import { RevenueBreakdown } from './RevenueBreakdown';
import { TopProducts } from './TopProducts';
import { SalesChartsRow } from '../SalesChartsRow';
import { ExecutiveDashboardSkeleton } from './ExecutiveDashboardSkeleton';

/**
 * Executive dashboard — "Command Center" (owner-approved redesign, 2026-06).
 *
 * The whole ERP at a glance, top → bottom:
 *
 *   1. HeaderSlot         — greeting + date-range filter (layout-owned)
 *   2. HeroStrip          — 4 big KPI cards (tushum / sotuvlar / foyda /
 *                           kritik pozitsiya)
 *   3a. ROW A             — Moliya (revenue donut + profit/margin footer) ‖
 *                           "Eng ko'p sotilgan mahsulotlar" (TopProducts)
 *   3b. ROW B             — full-width sales pair: Sotuv soni ‖ Sotuv summasi
 *   4. ZANJIR SALOMATLIGI — 5 chain-node cards (raw → production → supply →
 *                           central → store), each a link into its workspace
 *   5. SIFAT & INTEGRITET — kassa tafovuti / manfiy ostatka / muddati
 *                           o'tayotgan / brak %
 *   6. Amallar            — CriticalAlerts + MyActionsList + ProductionPlan
 *   7. SecondaryRowGuard (below the fold)
 *
 * Auto-refresh: 30 s while the tab is visible. The page is the only
 * place that knows the polling cadence — every child reads the snapshot.
 */

/**
 * Finance period word per range preset — prefixes the Foyda hero card and
 * the Moliya footer labels ("Bugungi foyda", "Oylik tushum", …). Local to
 * this page: it is threaded down to HeroStrip / ProfitSummary as a prop.
 */
const FINANCE_PERIOD_LABEL: Record<DateRangePreset, string> = {
  today: 'Bugungi',
  week: 'Haftalik',
  month: 'Oylik',
  '6m': '6 oylik',
  custom: 'Davr',
};

/**
 * Serialise the dashboard date-range into the `?from=YYYY-MM-DD&to=YYYY-MM-DD`
 * (inclusive) query the KPI costing endpoint accepts. Unlike the dashboard
 * endpoints (which resolve `?range=` presets server-side), `/api/kpi/products`
 * only takes explicit dates — so presets are resolved here, mirroring the
 * backend's window semantics (week = last 7 days, month = last 30 days,
 * 6m = last 6 calendar months, all including today).
 */
function financeRangeToQuery(value: DateRangeValue): string {
  if (value.range === 'custom' && value.from && value.to) {
    return `from=${value.from}&to=${value.to}`;
  }
  const to = new Date();
  const from = new Date(to);
  if (value.range === 'week') {
    from.setDate(from.getDate() - 6);
  } else if (value.range === 'month') {
    from.setDate(from.getDate() - 29);
  } else if (value.range === '6m') {
    from.setMonth(from.getMonth() - 6);
  }
  // 'today' (and a degenerate custom without dates): from === to === today.
  return `from=${todayIso(from)}&to=${todayIso(to)}`;
}
export function ExecutiveDashboardPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
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

  // Foyda / margin — `GET /api/kpi/products?from&to` is pm-only, so it 403s
  // for `ai_assistant`. We still fire it for the PM and degrade gracefully
  // (em-dash hero card, hidden margin footer) when it errors — the useApiQuery
  // `error` channel captures the 403 (and a 4xx while the from/to contract is
  // still landing on the backend) without breaking the page. The query key
  // embeds the resolved dates, so flipping the range filter re-fires it.
  const isPm = user?.role === 'pm';
  const kpiQuery = financeRangeToQuery(range);
  const kpi = useApiQuery<KpiProductsResponse>(
    isPm ? `/api/kpi/products?${kpiQuery}` : null,
  );
  // Period word for the finance labels ("Bugungi foyda", "Oylik tushum", …).
  const financeLabel = FINANCE_PERIOD_LABEL[range.range];

  // Aggregate this month's profit / revenue / margin from the per-product
  // rows. `available` is false when the query errored (403 / network) so the
  // Foyda card shows "—" and the margin footer hides — never a wrong "0".
  const finance = useMemo(() => {
    const rows = kpi.data?.products ?? [];
    if (kpi.error !== null || kpi.data === null) {
      return {
        available: false,
        totalProfit: 0,
        totalRevenue: 0,
        margin: null as number | null,
      };
    }
    let totalProfit = 0;
    let totalRevenue = 0;
    for (const r of rows) {
      totalProfit += r.profit ?? 0;
      totalRevenue += r.revenue;
    }
    return {
      available: true,
      totalProfit,
      totalRevenue,
      margin: totalRevenue > 0 ? totalProfit / totalRevenue : null,
    };
  }, [kpi.data, kpi.error]);

  const overviewRefetch = overview.refetch;
  const ecosystemRefetch = ecosystem.refetch;
  const purchaseOrdersRefetch = purchaseOrders.refetch;
  const replenishmentsRefetch = replenishments.refetch;
  const kpiRefetch = kpi.refetch;
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
          // No-op for non-PM roles — the kpi query key is null there.
          kpiRefetch();
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
    kpiRefetch,
  ]);

  // Warm the range-driven endpoints for the three presets the boshliq
  // toggles most (Bugun / Bu hafta / Bu oy) once on mount. With the
  // useApiQuery stale-while-revalidate cache populated ahead of time,
  // switching the date-range filter renders instantly with no loader.
  // Presets map to a bare `{ range }` value, exactly as DateRangeFilter's
  // `selectPreset` builds them. Prefetches are plain GETs that only fill
  // the cache; `prefetchApiQuery` already swallows errors and no-ops on a
  // fresh/in-flight entry, so warming the currently-active range too is
  // harmless. Runs once on mount (and again only if the role resolves to
  // PM later — re-running is a cheap no-op thanks to the freshness check).
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
      // Finance (Foyda / Moliya) — pm-only endpoint, so don't fire 403s
      // for other roles. Key matches the live kpi query above exactly.
      if (isPm) {
        prefetchApiQuery(`/api/kpi/products?${financeRangeToQuery(preset)}`);
      }
    }
  }, [isPm]);

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
    <div className="space-y-6">
      {/* 2. HERO STRIP — 4 big KPI cards. */}
      <HeroStrip
        overview={overview.data}
        ecosystem={ecosystem.data}
        range={range}
        onNavigate={navigate}
        ecosystemLoading={ecosystem.isLoading && ecosystem.data === null}
        monthlyProfit={finance.available ? finance.totalProfit : null}
        profitLoading={isPm && kpi.isLoading && kpi.data === null}
        profitLabel={financeLabel}
      />

      {/* 3a. ROW A — MOLIYA (revenue donut + profit/margin footer) on the left,
          "Eng ko'p sotilgan mahsulotlar" (TopProducts) on the right. The two
          columns stretch to equal height so they sit cleanly side by side. */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div className="flex flex-col gap-4">
          <RevenueBreakdown
            range={range}
            fallbackTotal={ecosystem.data?.poster_status.sales_today_sum ?? 0}
            className="flex-1"
          />
          <ProfitSummary
            available={finance.available}
            totalProfit={finance.totalProfit}
            totalRevenue={finance.totalRevenue}
            margin={finance.margin}
            periodLabel={financeLabel}
          />
        </div>
        {/* Top-sellers for the selected range. `h-full` so it stretches to the
            Moliya column's height and the row stays balanced. */}
        <TopProducts range={range} limit={8} className="h-full" />
      </div>

      {/* 3b. ROW B — the detailed sales pair (Sotuv soni + Sotuv summasi) on
          its own full-width row below Row A. Bigger and clearer with the full
          width. Always render so each chart owns its own skeleton while the
          ecosystem query is still loading — no late pop-in. */}
      <SalesChartsRow
        days={ecosystem.data?.sales_chart.days ?? []}
        granularity={ecosystem.data?.sales_chart.granularity}
        loading={ecosystem.isLoading && ecosystem.data === null}
        range={range}
      />

      {/* 4. ZANJIR SALOMATLIGI — full-width chain-node cards. */}
      <ChainHealthRow chainSummary={ecosystem.data?.chain_summary ?? []} />

      {/* 5. SIFAT & INTEGRITET — quality / integrity tiles. */}
      <QualityRow rangeQuery={rangeQuery} />

      {/* 6. AMALLAR — critical alerts + approval queue + production digest. */}
      <div className="grid gap-4 xl:grid-cols-12">
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

      {/* 7. Secondary tables (below the fold). */}
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
      <Card className="p-5 text-center text-sm text-muted-foreground">
        Hozircha kuzatish uchun ma’lumot yo‘q.
      </Card>
    );
  }
  return <DashboardSecondaryRow overview={overview} range={range} />;
}
