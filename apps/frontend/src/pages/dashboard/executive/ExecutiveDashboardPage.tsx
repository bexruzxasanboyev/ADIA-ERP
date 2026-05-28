import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { ErrorState, LoadingState } from '@/components/PageState';
import {
  dateRangeToQuery,
  type DateRangeValue,
} from '@/components/DateRangeFilter';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useAuth } from '@/hooks/useAuth';
import type {
  ChainSummaryNode,
  DashboardChainNode,
  DashboardEcosystem,
  DashboardOverview,
  DashboardSuppliersResponse,
  LocationType,
  PurchaseOrder,
  ReplenishmentDetail,
  ReplenishmentRequest,
} from '@/lib/types';
import { useHeaderSlot } from '@/components/layout/HeaderSlot';
import { DashboardHeaderSlot } from './DashboardHeaderSlot';
import { HeroStrip } from './HeroStrip';
import { CanvasFlow } from './CanvasFlow';
import { CanvasTabs, type CanvasView } from './CanvasTabs';
import { EcosystemCanvas } from './EcosystemCanvas';
import { ActiveRequestsPanel } from './ActiveRequestsPanel';
import { RequestTimeline } from './RequestTimeline';
import { CriticalAlerts } from './CriticalAlerts';
import { MyActionsList } from './MyActionsList';
import { DashboardSecondaryRow } from './DashboardSecondaryRow';
import { ChainDetailSheet } from './ChainDetailSheet';
import { RevenueBreakdown } from './RevenueBreakdown';

const CANVAS_VIEW_STORAGE_KEY = 'adia.dashboard.canvas';

function readStoredCanvasView(): CanvasView {
  if (typeof window === 'undefined') return 'calm';
  try {
    const raw = window.localStorage.getItem(CANVAS_VIEW_STORAGE_KEY);
    if (raw === 'detail') return 'detail';
    return 'calm';
  } catch {
    // Browsers can throw on localStorage access (private mode quotas,
    // disabled storage). Falling back to the default view keeps the
    // dashboard usable.
    return 'calm';
  }
}

// Stable empty fallback so a missing suppliers payload doesn't reshape
// the EcosystemCanvas memo on every render.
const EMPTY_SUPPLIERS: DashboardSuppliersResponse['suppliers'] = [];
const EMPTY_CHAIN_FLOW: DashboardChainNode[] = [];

// Stable empty fallback so a missing `ecosystem.data` doesn't churn the
// CanvasFlow memos by allocating a fresh `[]` on every render.
const EMPTY_CHAIN_SUMMARY: ChainSummaryNode[] = [];

/**
 * Dashboard v3 — Variant B "Calm Canvas".
 *
 * Above-the-fold composition:
 *   1. HeaderSlot      — layout-owned greeting + date range (`useHeaderSlot`)
 *   2. HeroStrip       — 4 compact KPI cards (revenue / receipts /
 *                        active requests / critical positions)
 *   3. CanvasFlow      — React Flow chain canvas (5 nodes + 5 animated
 *                        edges, read-only, click to open detail sheet)
 *   4. CriticalAlerts + MyActionsList  — 12-col split for action queues
 *   5. SecondaryRowGuard — legacy charts and tables for drill-down
 *
 * Auto-refresh: 30 s while the tab is visible. The page is the only
 * place that knows about polling cadence — every child reads the
 * supplied snapshot.
 */
export function ExecutiveDashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [range, setRange] = useState<DateRangeValue>({ range: 'today' });
  const [selectedChain, setSelectedChain] = useState<LocationType | null>(null);
  const [canvasView, setCanvasView] = useState<CanvasView>(() =>
    readStoredCanvasView(),
  );
  const [selectedRequestId, setSelectedRequestId] = useState<number | null>(
    null,
  );
  const rangeQuery = dateRangeToQuery(range);

  const overview = useApiQuery<DashboardOverview>(
    `/api/dashboard/overview?${rangeQuery}`,
  );
  const ecosystem = useApiQuery<DashboardEcosystem>(
    `/api/dashboard/ecosystem?${rangeQuery}`,
  );
  const suppliers = useApiQuery<DashboardSuppliersResponse>(
    '/api/dashboard/suppliers',
  );
  const purchaseOrders = useApiQuery<PurchaseOrder[]>(
    '/api/purchase-orders?status=draft',
  );
  // NEW replenishment requests are part of the boshliq's queue too; the
  // backend RBAC-scopes the list to what they can act on.
  const replenishments = useApiQuery<ReplenishmentRequest[]>(
    '/api/replenishment?status=NEW',
  );
  // Detalli canvas needs *every* non-terminal request so the right-side
  // panel can offer the full picture. The backend currently filters by
  // a single status, so we fetch without a filter and trim client-side
  // (Faza-1 volumes are in the tens, not hundreds — fine for now).
  const allRequests = useApiQuery<ReplenishmentRequest[]>('/api/replenishment');

  // Lazily fetch the full detail (request + transitions) of the
  // currently-selected request. `useApiQuery` accepts `null` to mean
  // "skip the fetch", which keeps the network quiet when nothing is
  // selected.
  const selectedRequestDetail = useApiQuery<ReplenishmentDetail>(
    selectedRequestId === null
      ? null
      : `/api/replenishment/${selectedRequestId}`,
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

  useHeaderSlot(
    <DashboardHeaderSlot
      userName={userName}
      isoDate={today}
      range={range}
      onRangeChange={setRange}
    />,
  );

  const handleChainSelect = useCallback((next: LocationType | null) => {
    setSelectedChain(next);
  }, []);

  const handleCanvasViewChange = useCallback((next: CanvasView) => {
    setCanvasView(next);
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(CANVAS_VIEW_STORAGE_KEY, next);
    } catch {
      // best-effort — see readStoredCanvasView
    }
  }, []);

  // Detalli canvas — each node is a SPECIFIC location, so clicking it
  // navigates to the per-location detail page. The Calm canvas keeps
  // the chain-TYPE sheet (`ChainDetailSheet`) since its nodes are
  // type-level aggregates, not individual bo'g'inlar.
  const handleEcosystemChainSelect = useCallback(
    (_type: LocationType, locationId: number) => {
      navigate(`/dashboard/locations/${locationId}`);
    },
    [navigate],
  );

  // Clear the request-trace selection when the user navigates away
  // from the Detalli view — the Calm canvas has no concept of a
  // selected trace, and showing a stale id would confuse the next
  // visit.
  const handleCanvasViewChangeWithReset = useCallback(
    (next: CanvasView) => {
      handleCanvasViewChange(next);
      if (next === 'calm') setSelectedRequestId(null);
    },
    [handleCanvasViewChange],
  );

  // Stabilise the chain_summary reference across 30s refetches: each
  // refetch re-parses JSON and produces a new array even when the payload
  // is byte-identical. Without content equality CanvasFlow's memos
  // invalidate, React Flow remounts every node, and the canvas flickers.
  // Keep the previous snapshot when its JSON serialisation matches.
  const chainSummary = ecosystem.data?.chain_summary ?? EMPTY_CHAIN_SUMMARY;
  const chainSummaryStableRef = useRef<ChainSummaryNode[]>(chainSummary);
  const chainSummaryStable = useMemo(() => {
    const prev = chainSummaryStableRef.current;
    if (
      prev !== chainSummary &&
      JSON.stringify(prev) === JSON.stringify(chainSummary)
    ) {
      return prev;
    }
    chainSummaryStableRef.current = chainSummary;
    return chainSummary;
  }, [chainSummary]);

  // Same content-equality dance for the suppliers list — keeps the
  // EcosystemCanvas memo stable across no-op refetches.
  const suppliersList = suppliers.data?.suppliers ?? EMPTY_SUPPLIERS;
  const suppliersStableRef =
    useRef<DashboardSuppliersResponse['suppliers']>(suppliersList);
  const suppliersStable = useMemo(() => {
    const prev = suppliersStableRef.current;
    if (
      prev !== suppliersList &&
      JSON.stringify(prev) === JSON.stringify(suppliersList)
    ) {
      return prev;
    }
    suppliersStableRef.current = suppliersList;
    return suppliersList;
  }, [suppliersList]);

  // chain_flow (per-location) feeds the Detalli canvas — also stabilised.
  const chainFlow = ecosystem.data?.chain_flow ?? EMPTY_CHAIN_FLOW;
  const chainFlowStableRef = useRef(chainFlow);
  const chainFlowStable = useMemo(() => {
    const prev = chainFlowStableRef.current;
    if (
      prev !== chainFlow &&
      JSON.stringify(prev) === JSON.stringify(chainFlow)
    ) {
      return prev;
    }
    chainFlowStableRef.current = chainFlow;
    return chainFlow;
  }, [chainFlow]);

  // Initial-load skeleton — overview is the keystone request.
  if (overview.isLoading && overview.data === null) {
    return <LoadingState />;
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
      />

      <RevenueBreakdown
        isoDate={today}
        fallbackTotal={ecosystem.data?.poster_status.sales_today_sum ?? 0}
      />

      <div className="flex items-center justify-between gap-3">
        <CanvasTabs
          view={canvasView}
          onChange={handleCanvasViewChangeWithReset}
        />
        <p
          className="hidden text-xs text-muted-foreground lg:block"
          aria-hidden="true"
        >
          {canvasView === 'calm'
            ? "5 bo'g'in — yig'iq ko'rinish"
            : "Yetkazib beruvchi → Do'kon — to'liq ekosistema"}
        </p>
      </div>

      <p
        className="rounded-md border border-border/40 bg-muted/40 px-3 py-2 text-xs text-muted-foreground lg:hidden"
        role="note"
      >
        Bu ekran katta monitor uchun mo'ljallangan. Eng yaxshi tajriba uchun
        kompyuter brauzeridan oching.
      </p>

      {canvasView === 'calm' ? (
        <CanvasFlow
          chainSummary={chainSummaryStable}
          selectedChain={selectedChain}
          onSelectChain={handleChainSelect}
        />
      ) : (
        <div className="flex h-[70vh] min-h-[520px] gap-4">
          <EcosystemCanvas
            chainFlow={chainFlowStable}
            suppliers={suppliersStable}
            selectedRequest={selectedRequestDetail.data}
            onSelectChain={handleEcosystemChainSelect}
            className="flex-1 min-w-0 h-full"
          />
          <div className="hidden h-full w-[320px] shrink-0 flex-col gap-4 lg:flex">
            <ActiveRequestsPanel
              requests={allRequests.data ?? []}
              selectedId={selectedRequestId}
              onSelect={setSelectedRequestId}
              isLoading={allRequests.isLoading}
              className="flex-1 min-h-0"
            />
            <RequestTimeline
              detail={selectedRequestDetail.data}
              isLoading={selectedRequestDetail.isLoading}
            />
          </div>
        </div>
      )}

      <div className="grid gap-4 sm:gap-6 xl:grid-cols-12">
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

      <ChainDetailSheet
        type={selectedChain}
        range={range}
        onClose={() => setSelectedChain(null)}
      />
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
