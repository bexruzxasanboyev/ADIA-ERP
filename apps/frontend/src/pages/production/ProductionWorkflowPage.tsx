import { useState } from 'react';
import { Tabs } from '@/components/ui/tabs';
import { PageHeader } from '@/components/PageState';
import { useAuth } from '@/hooks/useAuth';
import {
  StaffViewSwitch,
  type StaffView,
} from '@/pages/replenishment/inbox/StaffViewSwitch';
import { ProductionDashboardTab } from './ProductionDashboardTab';
import { ProductionRequestsTab } from './ProductionRequestsTab';
import { ProductionTransactionsTab } from './ProductionTransactionsTab';
import { ProductionWorkInbox } from './ProductionWorkInbox';
import { YarimTayyorTab } from './YarimTayyorTab';

/**
 * Ishlab chiqarish bo'limi ish joyi — a clean, production-отдел-scoped unified
 * workspace, MIRRORING the central warehouse workspace (CentralWorkflowPage).
 *
 * Variant A + mini-xarita (owner-approved): the scoped отдел manager gets ONE
 * primary screen — the «Ishlarim» three-group feed IS the whole page, no tab
 * row. The power views (Dashboard / Yarim tayyor / Tranzaksiyalar) stay intact
 * but live behind the feed's single «Batafsil →» link, which reveals them
 * below the feed. PM keeps the full tabbed workspace (board included).
 *
 * Sub-views (page-state, NOT sub-routes — exactly like central):
 *   1. Dashboard         — production-relevant KPI cards + charts.
 *   2. Yarim tayyor      — the отдел's зг catalogue with on-hand qoldiq.
 *   3. So'rovlar (PM)    — the 📥 Kelgan | 📤 Chiqgan board (PM-only, F-W).
 *   4. Tranzaksiyalar    — the отдел's stock-movement ledger.
 *
 * RBAC: a `production_manager` is pinned to their active отдел (falling back to
 * their primary location_id); PM gets the chain-wide production view. The
 * backend RBAC-scopes every endpoint.
 */

type PageTabKey =
  | 'inbox'
  | 'dashboard'
  | 'semi'
  | 'requests'
  | 'transactions';

const PAGE_TABS: { value: PageTabKey; label: string }[] = [
  { value: 'inbox', label: 'Ishlarim' },
  { value: 'dashboard', label: 'Dashboard' },
  { value: 'semi', label: 'Yarim tayyor' },
  { value: 'requests', label: 'So‘rovlar' },
  { value: 'transactions', label: 'Tranzaksiyalar' },
];

// F-W (owner: "hali ham kanban-ku") — the So'rovlar board tab is PM-only.
const STAFF_TABS = PAGE_TABS.filter((t) => t.value !== 'requests');

// Variant A + StaffViewSwitch (owner: "mahsulotlar tabi qani?"): the отдел's
// own products (Yarim tayyor qoldig'i) are first-class via the LARGE
// Ishlarim|Mahsulotlar segmented switch, so 'semi' leaves the «Batafsil»
// detail tabs (only Dashboard + Tranzaksiyalar history stay behind it).
const STAFF_DETAIL_TABS = STAFF_TABS.filter(
  (t) => t.value !== 'inbox' && t.value !== 'semi',
);

export function ProductionWorkflowPage() {
  const { user, activeLocationId } = useAuth();
  const isPm = user?.role === 'pm';

  // The production отдел this workspace is scoped to. A scoped production manager
  // is pinned to their active location (falling back to their primary
  // location_id). PM sees the chain-wide production view (productionId = null).
  const pinnedProductionId = activeLocationId ?? user?.location_id ?? null;
  const productionId = isPm ? null : pinnedProductionId;
  // Only the scoped production manager acts; PM is read-only chain-wide.
  const isProductionManager = user?.role === 'production_manager';

  // Single-screen staff mode + StaffViewSwitch: the отдел manager lands on the
  // feed; the LARGE Ishlarim|Mahsulotlar switch keeps the отдел's own product
  // list (Yarim tayyor + qoldiq) first-class. «Batafsil» (inside the Ishlarim
  // segment) reveals Dashboard + Tranzaksiyalar; PM keeps the full tab row.
  const isStaff = isProductionManager;
  const [staffView, setStaffView] = useState<StaffView>('inbox');
  const staffOnProducts = isStaff && staffView === 'products';
  // Live actionable count from the feed — drives the switch's badge.
  const [feedCount, setFeedCount] = useState(0);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [pageTab, setPageTab] = useState<PageTabKey>(
    isStaff ? 'transactions' : 'dashboard',
  );
  const showTabbed = (!isStaff || detailsOpen) && !staffOnProducts;
  // The Mahsulotlar surface: staff via the switch, PM/managers via the tab.
  const semiVisible = staffOnProducts || (showTabbed && pageTab === 'semi');

  return (
    <div className="mx-auto w-full max-w-[120rem] space-y-6">
      <PageHeader
        title="Ishlab chiqarish bo‘limi"
        description="Bo‘limning zayafkalari, yarim tayyor mahsulotlari va so‘rovlari — bitta joyda."
      />

      {/* StaffViewSwitch — the LARGE Ishlarim|Mahsulotlar segmented control
          (owner: "mahsulotlar tabi qani?"). Staff only; PM keeps the tab row. */}
      {isStaff && (
        <StaffViewSwitch
          value={staffView}
          onChange={setStaffView}
          inboxCount={feedCount}
        />
      )}

      {/* «Ishlarim» — the staff's primary segment (Variant A); PM reaches it
          via its tab. Kept MOUNTED (hidden) on the Mahsulotlar segment so
          polling + the live badge keep running. */}
      {(isStaff || pageTab === 'inbox') && (
        <div hidden={staffOnProducts}>
          <ProductionWorkInbox
            productionId={productionId}
            canAct={isProductionManager}
            onOpenDetails={() => {
              if (isStaff) setDetailsOpen((v) => !v);
              else setPageTab('requests');
            }}
            onActionableCount={setFeedCount}
          />
        </div>
      )}

      {/* TAB QATORI — PM always; staff only inside the Batafsil disclosure. */}
      {showTabbed && (
        <Tabs
          value={pageTab}
          onValueChange={setPageTab}
          options={isPm ? PAGE_TABS : isStaff ? STAFF_DETAIL_TABS : STAFF_TABS}
          ariaLabel="Bo‘lim"
        />
      )}

      {/* TAB: Dashboard — production KPI cards + charts (central-style). */}
      {showTabbed && pageTab === 'dashboard' && (
        <ProductionDashboardTab productionId={productionId} />
      )}

      {/* Mahsulotlar / Yarim tayyor — the отдел's зг grid WITH on-hand qoldiq +
          a per-card "To'ldirish" self-fill (opens a zagatovka). Staff via the
          segmented switch; PM via the tab (read-only, no fill). */}
      {semiVisible && (
        <YarimTayyorTab productionId={productionId} canFill={!isPm} />
      )}

      {/* TAB: So'rovlar — the PM-only board (F-W). */}
      {showTabbed && pageTab === 'requests' && isPm && (
        <ProductionRequestsTab productionId={productionId} />
      )}

      {/* TAB: Tranzaksiyalar — the отдел's stock-movement ledger (qabul qildi /
          chiqardi) with its own date filter. Extracted from So'rovlar (F-Q §3). */}
      {showTabbed && pageTab === 'transactions' && (
        <ProductionTransactionsTab productionId={productionId} />
      )}
    </div>
  );
}
