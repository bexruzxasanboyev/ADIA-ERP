import { useState } from 'react';
import { Tabs } from '@/components/ui/tabs';
import { PageHeader } from '@/components/PageState';
import { useAuth } from '@/hooks/useAuth';
import { ProductionDashboardTab } from './ProductionDashboardTab';
import { ProductionRequestsTab } from './ProductionRequestsTab';
import { YarimTayyorTab } from './YarimTayyorTab';

/**
 * Ishlab chiqarish bo'limi ish joyi — a clean, production-отдел-scoped unified
 * workspace, MIRRORING the central warehouse workspace (CentralWorkflowPage).
 *
 * Owner: "make me a dashboard just like central/store with useful precise data,
 * and make So'rovlar look like the central warehouse's (I'll give edits later)."
 *
 * Three focused sub-tabs surfaced as in-page tabs (page-state, NOT sub-routes —
 * exactly like central):
 *   1. Dashboard         — production-relevant KPI cards (Faol zayafkalar,
 *                          Kutilayotgan, Yarim tayyor turlari, Min'dan past,
 *                          Tayyor mahsulot turlari) + status bar chart +
 *                          category donut + request dynamics. See
 *                          ProductionDashboardTab. Forked from CentralDashboardTab.
 *   2. Yarim tayyor      — the отдел's зг (semi-finished) catalogue WITH on-hand
 *                          qoldiq AND a per-card "To'ldirish" self-fill (opens a
 *                          zagatovka). A dedicated production-scoped grid
 *                          (YarimTayyorTab) fed by /api/products/yarim-tayyor.
 *   3. So'rovlar         — mirrors central's So'rovlar LOOK (5-stage pipeline +
 *                          date-range + charts), read-only, fed by the отдел's
 *                          own /api/replenishment. See ProductionRequestsTab.
 *
 * RBAC: a `production_manager` is pinned to their active отдел (falling back to
 * their primary location_id); PM gets the chain-wide production view (the
 * underlying endpoints handle their own PM affordances). The backend RBAC-scopes
 * every endpoint.
 */

type PageTabKey = 'dashboard' | 'semi' | 'requests';

const PAGE_TABS: { value: PageTabKey; label: string }[] = [
  { value: 'dashboard', label: 'Dashboard' },
  { value: 'semi', label: 'Yarim tayyor' },
  { value: 'requests', label: 'So‘rovlar' },
];

export function ProductionWorkflowPage() {
  const { user, activeLocationId } = useAuth();
  const isPm = user?.role === 'pm';

  // The production отдел this workspace is scoped to. A scoped production manager
  // is pinned to their active location (falling back to their primary
  // location_id). PM sees the chain-wide production view (productionId = null).
  const pinnedProductionId = activeLocationId ?? user?.location_id ?? null;
  const productionId = isPm ? null : pinnedProductionId;

  const [pageTab, setPageTab] = useState<PageTabKey>('dashboard');

  return (
    <div className="mx-auto w-full max-w-[120rem] space-y-6">
      <PageHeader
        title="Ishlab chiqarish bo‘limi"
        description="Bo‘limning zayafkalari, yarim tayyor mahsulotlari va so‘rovlari — bitta joyda."
      />

      <Tabs
        value={pageTab}
        onValueChange={setPageTab}
        options={PAGE_TABS}
        ariaLabel="Bo‘lim"
      />

      {/* TAB: Dashboard — production KPI cards + charts (central-style). */}
      {pageTab === 'dashboard' && (
        <ProductionDashboardTab productionId={productionId} />
      )}

      {/* TAB: Yarim tayyor — the отдел's зг grid WITH on-hand qoldiq + a per-card
          "To'ldirish" self-fill (opens a zagatovka). Server-scoped to the отдел
          for a production_manager; PM sees all type='semi' (read-only, no fill). */}
      {pageTab === 'semi' && (
        <YarimTayyorTab productionId={productionId} canFill={!isPm} />
      )}

      {/* TAB: So'rovlar — central-style pipeline LOOK, read-only (owner edits later). */}
      {pageTab === 'requests' && (
        <ProductionRequestsTab productionId={productionId} />
      )}
    </div>
  );
}
