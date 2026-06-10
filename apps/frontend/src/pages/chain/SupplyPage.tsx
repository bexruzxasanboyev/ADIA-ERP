import { useState } from 'react';
import { Tabs } from '@/components/ui/tabs';
import { PageHeader } from '@/components/PageState';
import { useAuth } from '@/hooks/useAuth';
import { SupplyDashboardTab } from './SupplyDashboardTab';
import { SupplyFlowWorkspace } from './SupplyFlowWorkspace';

/**
 * F4.6 / F-I — `/supply` chain-layer screen ("Ishlab chiqarish omborlari").
 *
 * Renamed from "Ta'minot" — the layer is now "Ishlab chiqarish ombori" (Tort
 * skladi, Perojniy skladi, sex skladlari …). The `/supply` URL is kept so
 * external bookmarks keep working; the route label and on-page copy read
 * "Ishlab chiqarish omborlari". RBAC: `pm`, `supply_manager`.
 *
 * The page is a TWO-tab workspace (its OWN tabs — the global modules header
 * strip is suppressed for /supply via `pageOwnsHeaderTabs`, owner: "tepada
 * headerdagi bo'limlar kerak emas"):
 *   1. Dashboard           — a clean KPI + chart overview (SupplyDashboardTab).
 *   2. Qoldiq va so'rovlar — the flow workspace (SupplyFlowWorkspace): TRUE flow
 *                            tiles + a clickable бо'g'inlar grid that drills into
 *                            a per-sklad board + "Min'dan past" panel.
 */
type PageTabKey = 'dashboard' | 'stock';

const PAGE_TABS: { value: PageTabKey; label: string }[] = [
  { value: 'dashboard', label: 'Dashboard' },
  { value: 'stock', label: 'Qoldiq va so‘rovlar' },
];

export function SupplyPage() {
  const { user, activeLocationId } = useAuth();
  const isPm = user?.role === 'pm';
  const pinnedSupplyId = activeLocationId ?? user?.location_id ?? null;
  const supplyLocationId = isPm ? null : pinnedSupplyId;

  const [pageTab, setPageTab] = useState<PageTabKey>('dashboard');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Ishlab chiqarish omborlari"
        description="Ishlab chiqarish omborlari — sex skladlari, jo‘natmaga tayyor mahsulotlar va kelayotgan so‘rovlar."
      />

      <Tabs
        value={pageTab}
        onValueChange={setPageTab}
        options={PAGE_TABS}
        ariaLabel="Bo‘lim"
      />

      {pageTab === 'dashboard' && (
        <SupplyDashboardTab supplyLocationId={supplyLocationId} />
      )}

      {pageTab === 'stock' && <SupplyFlowWorkspace />}
    </div>
  );
}
