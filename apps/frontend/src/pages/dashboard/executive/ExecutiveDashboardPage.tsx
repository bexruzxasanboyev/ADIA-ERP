import { useEffect, useMemo } from 'react';
import { Card } from '@/components/ui/card';
import { ErrorState, LoadingState } from '@/components/PageState';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useAuth } from '@/hooks/useAuth';
import type {
  DashboardEcosystem,
  DashboardOverview,
  PurchaseOrder,
  ReplenishmentRequest,
} from '@/lib/types';
import { HeaderStrip } from './HeaderStrip';
import { HeroKpiStrip, type HeroKpiCard } from './HeroKpiStrip';
import { EcosystemHealthBar } from './EcosystemHealthBar';
import { CriticalAlerts } from './CriticalAlerts';
import { MyActionsList } from './MyActionsList';
import { DashboardSecondaryRow } from './DashboardSecondaryRow';

/**
 * F4.7 — Executive (boshliq) dashboard.
 *
 * Layout: above-the-fold (~100vh) carries everything critical:
 *   1. HeaderStrip            (~56px)
 *   2. HeroKpiStrip           (~220px) — 4 large KPI cards
 *   3. EcosystemHealthBar     (~112px) — 5-stage pill row
 *   4. Split row              (~340px) — Critical alerts + My actions
 *
 * Below-the-fold: the existing operations widgets in a vertical stack
 * (sales chart, forecasts, production plan, poster status + open
 * requests donut, alerts feed). `RecentMovementsPanel` is intentionally
 * omitted — a boshliq does not need the audit ledger here.
 *
 * Auto-refresh: 30 s while the tab is visible.
 */
export function ExecutiveDashboardPage() {
  const { user } = useAuth();

  const overview = useApiQuery<DashboardOverview>('/api/dashboard/overview');
  const ecosystem = useApiQuery<DashboardEcosystem>(
    '/api/dashboard/ecosystem',
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

  const userName = user?.name ?? 'Foydalanuvchi';
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  const kpiCards = useMemo<HeroKpiCard[] | null>(() => {
    if (overview.data === null) return null;
    return buildKpiCards({
      overview: overview.data,
      ecosystem: ecosystem.data,
    });
  }, [overview.data, ecosystem.data]);

  // Initial-load skeleton — overview is the keystone request.
  if (overview.isLoading && overview.data === null) {
    return (
      <div className="space-y-6">
        <HeaderStrip userName={userName} isoDate={today} />
        <LoadingState />
      </div>
    );
  }

  if (overview.error && overview.data === null) {
    return (
      <div className="space-y-6">
        <HeaderStrip userName={userName} isoDate={today} />
        <ErrorState message={overview.error} onRetry={overview.refetch} />
      </div>
    );
  }

  if (overview.data === null || kpiCards === null) {
    return null;
  }

  return (
    <div className="space-y-6">
      <HeaderStrip userName={userName} isoDate={today} />

      <HeroKpiStrip cards={kpiCards} />

      <EcosystemHealthBar nodes={ecosystem.data?.chain_flow ?? []} />

      <div className="grid gap-6 xl:grid-cols-12">
        <CriticalAlerts
          belowMin={overview.data.below_min}
          alerts={ecosystem.data?.alerts_feed ?? []}
          className="xl:col-span-7"
        />
        <MyActionsList
          purchaseOrders={purchaseOrders.data ?? []}
          replenishments={replenishments.data ?? []}
          className="xl:col-span-5"
        />
      </div>

      <SecondaryRowGuard overview={overview.data} ecosystem={ecosystem.data} />
    </div>
  );
}

function SecondaryRowGuard({
  overview,
  ecosystem,
}: {
  overview: DashboardOverview;
  ecosystem: DashboardEcosystem | null;
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
  return <DashboardSecondaryRow overview={overview} ecosystem={ecosystem} />;
}

// ---------------------------------------------------------------------------
// KPI construction
// ---------------------------------------------------------------------------

function buildKpiCards({
  overview,
  ecosystem,
}: {
  overview: DashboardOverview;
  ecosystem: DashboardEcosystem | null;
}): HeroKpiCard[] {
  const salesToday = ecosystem?.poster_status.sales_today_sum ?? 0;
  const salesSpark = (ecosystem?.sales_chart.days ?? [])
    .slice(-14)
    .map((p) => p.qty);

  const activeProduction = overview.kpis.active_production_orders;
  const totalPlanned = Math.max(activeProduction, overview.production_plan.length);

  const belowMin = overview.kpis.below_min_count;
  const pending = overview.kpis.pending_approvals;

  return [
    {
      id: 'sales',
      label: 'Bugungi savdo',
      value: { kind: 'currency', amount: salesToday },
      tone: 'neutral',
      periodLabel: 'vs. kecha',
      sparkline: salesSpark.length >= 2 ? salesSpark : undefined,
      href: '/stock',
    },
    {
      id: 'production',
      label: 'Faol zayafka',
      value: {
        kind: 'fraction',
        numerator: activeProduction,
        denominator: totalPlanned > 0 ? totalPlanned : activeProduction,
      },
      tone: 'neutral',
      periodLabel: 'bugun',
      href: '/production-orders',
    },
    {
      id: 'critical',
      label: 'Qizil pozitsiya',
      value: { kind: 'count', value: belowMin },
      tone: belowMin > 0 ? 'danger' : 'neutral',
      periodLabel: 'min’dan past',
      href: '/replenishment',
    },
    {
      id: 'pending',
      label: 'Tasdiq kutmoqda',
      value: { kind: 'count', value: pending },
      tone: pending > 0 ? 'warning' : 'neutral',
      periodLabel: 'mendan',
      href: '/purchase-orders',
    },
  ];
}
