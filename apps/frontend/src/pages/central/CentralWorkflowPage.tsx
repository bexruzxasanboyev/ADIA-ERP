import { useMemo, useState } from 'react';
import {
  Check,
  Factory,
  Minus,
  Plus,
  Search,
  ShoppingCart,
  Store,
  Trash2,
  Warehouse,
  X,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { StockMeter, type StockTone } from '@/components/ui/stock-meter';
import { Tabs } from '@/components/ui/tabs';
import {
  FilterPopover,
  type FilterGroup,
  type FilterOption,
  type FilterValue,
} from '@/components/ui/filter-popover';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from '@/components/PageState';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useAuth } from '@/hooks/useAuth';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { formatQtyUnit } from '@/lib/format';
import { UNIT_OPTIONS } from '@/lib/labels';
import { matchesSearch } from '@/lib/translit';
import { cn } from '@/lib/utils';
import type { Location, Product, StockRow } from '@/lib/types';
import { CentralDashboardTab } from './CentralDashboardTab';
import { CentralRequestsTab } from './CentralRequestsTab';
import { CentralWorkInbox } from './CentralWorkInbox';
import { CentralDispatchGrid } from './CentralDispatchGrid';
import { CentralSummaryTiles } from './CentralSummaryTiles';
import {
  SendToProductionDialog,
  ShipToStoreDialog,
} from './CentralCardActions';
import {
  storeOptionsFromTargets,
  type CentralStoreOption,
  type StoreTargetsResponse,
} from './centralStores';
import {
  basketItemFromStockRow,
  type BasketItem,
} from '@/pages/stores/storeBasket';
import {
  StaffViewSwitch,
  type StaffView,
} from '@/pages/replenishment/inbox/StaffViewSwitch';

/**
 * Markaziy sklad ish joyi — a clean, central-warehouse-scoped unified
 * workspace, mirroring the store workflow page (owner feedback: the central
 * manager should land on a self-contained workspace like the store manager,
 * never on the /home module launcher).
 *
 * Three focused sub-tabs surfaced as in-page header tabs:
 *   1. Dashboard    — a clean, finished-only overview (KPI cards + a stock
 *                     status bar chart + a per-day request trend / status
 *                     donut), mirroring the store Dashboard. See
 *                     CentralDashboardTab. (Owner feedback: the old embedded
 *                     CentralWarehousePage was too sprawling — duplicate
 *                     header, outbound/inbound lists, a bottom stock table.)
 *   2. Mahsulotlar  — the central warehouse stock as searchable CARDS with a
 *                     status filter + category/unit filter. The central
 *                     warehouse holds ONLY finished goods, so the card grid is
 *                     restricted to `type === 'finished'` products (owner rule:
 *                     "markaziy sklada faqat tayyor mahsulot bo'ladi").
 *   3. So'rovlar    — incoming store replenishment requests (accept / reject).
 *                     Reuses CentralInboxPage.
 *
 * RBAC: a `central_warehouse_manager` is pinned to their active location; PM
 * gets the same view (the underlying pages handle their own PM affordances).
 * The backend RBAC-scopes every endpoint.
 */

type PageTabKey = 'inbox' | 'dashboard' | 'products' | 'requests';

const PAGE_TABS: { value: PageTabKey; label: string }[] = [
  { value: 'inbox', label: 'Ishlarim' },
  { value: 'dashboard', label: 'Dashboard' },
  { value: 'products', label: 'Mahsulotlar' },
  { value: 'requests', label: 'So‘rovlar' },
];

// Variant A + StaffViewSwitch (owner: "mahsulotlar tabi qani?"): staff get a
// LARGE Ishlarim|Mahsulotlar segmented switch — products are first-class, so
// they are NOT in the «Batafsil» detail tabs anymore (only Dashboard +
// So'rovlar history live behind the feed's small «Batafsil →» link).
const STAFF_DETAIL_TABS = PAGE_TABS.filter(
  (t) => t.value !== 'inbox' && t.value !== 'products',
);

/** A concrete stock-status bucket (the "Hammasi" pseudo-status is gone — an
 * empty status filter now means "all", living inside the Filter popover). */
type StockStatusKey = 'below_min' | 'low' | 'out' | 'enough';

/** Status filter options for the "Holat" group inside the Filter popover. */
const STOCK_STATUS_OPTIONS: { value: StockStatusKey; label: string }[] = [
  { value: 'below_min', label: 'Min’dan past' },
  { value: 'low', label: 'Kam' },
  { value: 'out', label: 'Tugagan' },
  { value: 'enough', label: 'Yetarli' },
];

/**
 * "Kam" (low) heuristic: at or below 120% of min but still above min — the
 * early-warning band before a row actually crosses min. `min_level === 0`
 * rows have no meaningful low band, so they never count as "low".
 */
function isLowStock(row: StockRow): boolean {
  if (row.min_level <= 0) return false;
  return row.qty > row.min_level && row.qty <= row.min_level * 1.2;
}

function stockStatusOf(row: StockRow): StockStatusKey {
  if (row.qty <= 0) return 'out';
  if (row.qty <= row.min_level) return 'below_min';
  if (isLowStock(row)) return 'low';
  return 'enough';
}

/** StockMeter fill tone — DESIGN.md §8: 0 → danger, below min → warning. */
function stockToneOf(row: StockRow): StockTone {
  if (row.qty <= 0) return 'danger';
  if (row.qty <= row.min_level) return 'warning';
  return 'success';
}

function StockStatusPill({ row }: { row: StockRow }) {
  const status = stockStatusOf(row);
  switch (status) {
    case 'out':
      return <Badge variant="danger">Tugagan</Badge>;
    case 'below_min':
      return <Badge variant="danger">Min’dan past</Badge>;
    case 'low':
      return <Badge variant="warning">Kam</Badge>;
    case 'enough':
    default:
      return <Badge variant="success">Yetarli</Badge>;
  }
}

export function CentralWorkflowPage() {
  const { user, activeLocationId } = useAuth();
  const isPm = user?.role === 'pm';
  // Only the scoped central manager ships to stores; PM is read-only.
  const canShip = user?.role === 'central_warehouse_manager';
  const reducedMotion = usePrefersReducedMotion();

  // The central warehouse this workspace is scoped to. A scoped central
  // manager is pinned to their active location (falling back to their primary
  // location_id). PM sees the chain-wide central stock (all central warehouses
  // the backend RBAC-scopes for them).
  const pinnedCentralId = activeLocationId ?? user?.location_id ?? null;
  const centralId = isPm ? null : pinnedCentralId;

  // Variant A single-screen staff mode + StaffViewSwitch: the scoped manager
  // lands on the «Ishlarim» feed; the LARGE Ishlarim|Mahsulotlar segmented
  // switch keeps the on-hand stock view first-class (owner: "mahsulotlar tabi
  // qani?"). «Batafsil» (inside the Ishlarim segment) reveals the remaining
  // detail tabs (Dashboard / So'rovlar). PM keeps the full tabbed workspace.
  const isStaff = canShip;
  const [staffView, setStaffView] = useState<StaffView>('inbox');
  const staffOnProducts = isStaff && staffView === 'products';
  // Live actionable count from the feed — drives the switch's badge.
  const [feedCount, setFeedCount] = useState(0);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [pageTab, setPageTab] = useState<PageTabKey>(
    isStaff ? 'requests' : 'dashboard',
  );
  const showTabbed = (!isStaff || detailsOpen) && !staffOnProducts;
  // The Mahsulotlar surface: staff via the switch, PM via the tab row.
  const productsVisible =
    staffOnProducts || (showTabbed && pageTab === 'products');

  // Ship-to-store basket (owner feedback #15). The central manager queues
  // finished products on the Mahsulotlar cards, picks a destination store in
  // the Savat panel, then "Do'konga yuborish" posts a batch with
  // `requester_location_id = <store id>`. Keyed by product_id; lifted here so
  // it persists across the Mahsulotlar ↔ So'rovlar tabs.
  const [basket, setBasket] = useState<Record<number, BasketItem>>({});
  const [basketOpen, setBasketOpen] = useState(false);

  // Downstream store options for the ship-to-store picker. The dedicated
  // `/api/replenishment/store-targets` endpoint lists EVERY store the hub may
  // ship to (not just stores that raised a request). central manager only.
  const storeTargets = useApiQuery<StoreTargetsResponse>(
    canShip ? '/api/replenishment/store-targets' : null,
  );
  const storeOptions = useMemo<CentralStoreOption[]>(
    () => storeOptionsFromTargets(storeTargets.data?.stores ?? []),
    [storeTargets.data],
  );

  const basketItems = useMemo(
    () =>
      Object.values(basket).sort((a, b) =>
        a.product_name.localeCompare(b.product_name),
      ),
    [basket],
  );
  const basketCount = basketItems.length;

  function toggleBasket(row: StockRow) {
    setBasket((prev) => {
      const next = { ...prev };
      if (next[row.product_id]) delete next[row.product_id];
      else {
        // Ship-to-store: we can only send what's on hand, so the initial
        // qty is capped at the central stock (never refill-to-max here).
        const item = basketItemFromStockRow(row);
        next[row.product_id] = { ...item, qty: Math.min(item.qty, row.qty) };
      }
      return next;
    });
  }

  function setBasketQty(productId: number, qty: number) {
    setBasket((prev) => {
      const item = prev[productId];
      if (!item) return prev;
      // Cap at on-hand central stock — can't ship more than we have.
      const wanted = Number.isFinite(qty) && qty > 0 ? qty : 0;
      return {
        ...prev,
        [productId]: { ...item, qty: Math.min(wanted, item.current_qty) },
      };
    });
  }

  function stepBasketQty(productId: number, delta: number) {
    setBasket((prev) => {
      const item = prev[productId];
      if (!item) return prev;
      // Clamp between 1 and the on-hand central stock.
      const next = Math.min(Math.max(1, item.qty + delta), item.current_qty);
      return { ...prev, [productId]: { ...item, qty: next } };
    });
  }

  function removeBasketItem(productId: number) {
    setBasket((prev) => {
      const next = { ...prev };
      delete next[productId];
      return next;
    });
  }

  function clearBasket() {
    setBasket({});
  }


  return (
    <div className="mx-auto w-full max-w-[120rem] space-y-6">
      {/* 1. SARLAVHA QATORI — page-level actions live on the title row's right
          slot (DESIGN.md §9): the persistent Savat trigger, visible from any
          tab whenever the draft has lines. central manager only. */}
      <PageHeader
        title="Markaziy sklad ish joyi"
        description="Markaziy sklad qoldig‘i, kelayotgan jo‘natmalar va do‘konlardan kelgan so‘rovlar — bitta joyda."
        actions={
          canShip &&
          basketCount > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="relative shrink-0"
              onClick={() => setBasketOpen(true)}
            >
              <ShoppingCart className="size-4" aria-hidden="true" />
              Savat
              <Badge
                key={basketCount}
                variant="secondary"
                className={cn(
                  'tabular-nums',
                  !reducedMotion && 'animate-badge-bump',
                )}
              >
                {basketCount}
              </Badge>
            </Button>
          )
        }
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

      {/* «Ishlarim» (Variant A) — the staff's primary segment; PM reaches it
          via its tab. Kept MOUNTED (hidden) on the Mahsulotlar segment so
          polling + the live badge keep running. */}
      {(isStaff || pageTab === 'inbox') && (
        <div hidden={staffOnProducts}>
          <CentralWorkInbox
            centralId={centralId}
            canWrite={canShip}
            onOpenDetails={() => {
              if (isStaff) setDetailsOpen((v) => !v);
              else setPageTab('requests');
            }}
            onActionableCount={setFeedCount}
          />
        </div>
      )}

      {/* 2. TAB QATORI — PM always; staff only inside the Batafsil disclosure. */}
      {showTabbed && (
        <Tabs
          value={pageTab}
          onValueChange={setPageTab}
          options={isStaff ? STAFF_DETAIL_TABS : PAGE_TABS}
          ariaLabel="Bo‘lim"
        />
      )}

      {/* KONTENT — the hero KPI strip leads the content on every NON-inbox tab
          AND the staff Mahsulotlar segment (DESIGN.md §9 scaffold order). */}
      {((showTabbed && pageTab !== 'inbox') || staffOnProducts) && (
        <CentralSummaryTiles centralId={centralId} />
      )}

      {/* TAB: Dashboard — clean finished-only KPI cards + charts. */}
      {showTabbed && pageTab === 'dashboard' && (
        <CentralDashboardTab centralId={centralId} />
      )}

      {/* Mahsulotlar — finished-only stock as searchable cards + basket.
          Staff via the segmented switch; PM via the tab row. */}
      {productsVisible && (
        <>
          <CentralProductsTab
            centralId={centralId}
            canShip={canShip}
            storeOptions={storeOptions}
            basket={basket}
            onToggleBasket={toggleBasket}
            onStepQty={stepBasketQty}
            onSetQty={setBasketQty}
            onRemove={removeBasketItem}
          />
          {/* Floating basket pill — same shape/treatment as the AI button,
              stacked just above it (bottom-right). central manager only. */}
          {canShip && basketCount > 0 && (
            <Button
              type="button"
              onClick={() => setBasketOpen(true)}
              aria-label={`Savatni ko‘rish — ${basketCount} ta mahsulot`}
              title="Savatni ko‘rish"
              className={cn(
                // FAB — intentionally mirrors the global AssistantButton glow
                // (stacked just above it), hence the kept primary shadow.
                'group fixed bottom-[5.5rem] right-6 z-40 h-auto rounded-full px-4 py-3',
                'shadow-lg shadow-primary/30 ring-1 ring-primary/40 transition-all',
                'hover:translate-y-[-1px] hover:shadow-xl hover:shadow-primary/40',
              )}
            >
              <ShoppingCart className="size-4" aria-hidden="true" />
              <span className="hidden sm:inline">Savatni ko‘rish</span>
              <span
                key={basketCount}
                className={cn(
                  'inline-flex min-w-5 items-center justify-center rounded-full bg-primary-foreground/20 px-1.5 py-0.5 text-xs font-semibold tabular-nums',
                  !reducedMotion && 'animate-badge-bump',
                )}
              >
                {basketCount}
              </span>
            </Button>
          )}
        </>
      )}

      {/* TAB: So'rovlar — do'kondek: charts + kiruvchi/chiqgan + So'rov qo'shish. */}
      {showTabbed && pageTab === 'requests' && (
        <CentralRequestsTab centralId={centralId} />
      )}

      {/* Ship-to-store dispatch grid — multi-destination (stores + production). */}
      {canShip && centralId !== null && (
        <CentralDispatchGrid
          open={basketOpen}
          onOpenChange={setBasketOpen}
          items={basketItems}
          stores={storeOptions}
          centralId={centralId}
          onDone={clearBasket}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mahsulotlar tab — finished-only central stock as searchable cards.
// ---------------------------------------------------------------------------

interface CentralProductsTabProps {
  centralId: number | null;
  /** Whether the ship / production controls are shown (central manager). */
  canShip: boolean;
  /** Downstream stores the "Do'konga yuborish" dialog can target. */
  storeOptions: CentralStoreOption[];
  /** Current basket, keyed by product_id (page-owned). */
  basket: Record<number, BasketItem>;
  onToggleBasket: (row: StockRow) => void;
  onStepQty: (productId: number, delta: number) => void;
  onSetQty: (productId: number, qty: number) => void;
  onRemove: (productId: number) => void;
}

function CentralProductsTab({
  centralId,
  canShip,
  storeOptions,
  basket,
  onToggleBasket,
  onStepQty,
  onSetQty,
  onRemove,
}: CentralProductsTabProps) {
  // A scoped manager fetches their precise central location; PM gets the
  // (RBAC-scoped) central-warehouse-wide stock list.
  const stockUrl =
    centralId !== null
      ? `/api/stock?location_id=${centralId}`
      : '/api/stock?location_type=central_warehouse';
  const stock = useApiQuery<StockRow[]>(stockUrl);
  const products = useApiQuery<Product[]>('/api/products');
  // PM may need location names to disambiguate several central warehouses.
  const locations = useApiQuery<Location[]>(centralId === null ? '/api/locations' : null);

  const [productSearch, setProductSearch] = useState('');
  // Status, category and unit are all groups inside the single Filter popover
  // (owner feedback: drop the full-width status tab row). An empty `status`
  // array means "all statuses".
  const [productFilter, setProductFilter] = useState<FilterValue>({
    status: [],
    category: [],
    unit: [],
  });

  // Direct per-product card actions (owner feedback): the row whose
  // "Do'konga yuborish" / "Ishlab chiqarishga yuborish" dialog is open, or
  // `null` when both are closed.
  const [shipRow, setShipRow] = useState<StockRow | null>(null);
  const [prodRow, setProdRow] = useState<StockRow | null>(null);

  // Map product_id → Product so each stock row can resolve its type
  // (finished-only gate) and its Poster category / unit.
  const productById = useMemo(() => {
    const m = new Map<number, Product>();
    for (const p of products.data ?? []) m.set(p.id, p);
    return m;
  }, [products.data]);

  const locationNameById = useMemo(() => {
    const m = new Map<number, string>();
    for (const l of locations.data ?? []) m.set(l.id, l.name);
    return m;
  }, [locations.data]);

  // Owner rule: "markaziy sklada faqat tayyor mahsulot bo'ladi" — the central
  // warehouse holds ONLY finished goods, so the cards show only stock rows
  // whose product is `type === 'finished'`. A row whose product isn't loaded
  // yet (or is raw/semi) is excluded.
  const finishedRows = useMemo(() => {
    const rows = (stock.data ?? []).filter(
      (r) => productById.get(r.product_id)?.type === 'finished',
    );
    return [...rows].sort((a, b) =>
      a.product_name.localeCompare(b.product_name),
    );
  }, [stock.data, productById]);

  const filteredStock = useMemo(() => {
    const statuses = productFilter.status ?? [];
    const cats = productFilter.category ?? [];
    const units = productFilter.unit ?? [];
    return finishedRows.filter((r) => {
      // Empty status selection = all statuses.
      if (statuses.length > 0 && !statuses.includes(stockStatusOf(r))) {
        return false;
      }
      if (!matchesSearch(r.product_name, productSearch)) return false;
      const p = productById.get(r.product_id);
      if (
        cats.length > 0 &&
        !(p?.poster_category != null && cats.includes(p.poster_category.name))
      ) {
        return false;
      }
      if (units.length > 0 && !units.includes(r.product_unit)) return false;
      return true;
    });
  }, [finishedRows, productSearch, productFilter, productById]);

  // Distinct Poster categories across the finished rows (most-populated first).
  const categoryOptions = useMemo<FilterOption[]>(() => {
    const counts = new Map<string, number>();
    for (const r of finishedRows) {
      const name = productById.get(r.product_id)?.poster_category?.name;
      if (name == null) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0])))
      .map(([name]) => ({ value: name, label: name }));
  }, [finishedRows, productById]);

  const STOCK_FILTER_GROUPS = useMemo<FilterGroup[]>(
    () => [
      {
        key: 'status',
        label: 'Holat',
        searchable: false,
        options: STOCK_STATUS_OPTIONS.map((s) => ({
          value: s.value,
          label: s.label,
        })),
      },
      {
        key: 'category',
        label: 'Kategoriya',
        searchable: true,
        options: categoryOptions,
      },
      {
        key: 'unit',
        label: 'Birlik',
        searchable: false,
        options: UNIT_OPTIONS.map((u) => ({ value: u.value, label: u.label })),
      },
    ],
    [categoryOptions],
  );

  // Group the filtered cards by Poster category (like /products). A trailing
  // "Kategoriyasiz" bucket holds rows whose product has no category.
  const stockGroups = useMemo(() => {
    const NULL_KEY = ' ';
    const buckets = new Map<string, { name: string; items: StockRow[] }>();
    for (const r of filteredStock) {
      const name = productById.get(r.product_id)?.poster_category?.name ?? null;
      const key = name ?? NULL_KEY;
      const display = name ?? 'Kategoriyasiz';
      const bucket = buckets.get(key);
      if (bucket) bucket.items.push(r);
      else buckets.set(key, { name: display, items: [r] });
    }
    return [...buckets.entries()]
      .map(([key, { name, items }]) => ({ key, name, items }))
      .sort((a, b) => {
        if (a.key === NULL_KEY) return 1;
        if (b.key === NULL_KEY) return -1;
        if (b.items.length !== a.items.length) {
          return b.items.length - a.items.length;
        }
        return a.name.localeCompare(b.name);
      });
  }, [filteredStock, productById]);

  // Several central warehouses (PM) → show a per-card location badge.
  const multiLocation = useMemo(() => {
    const ids = new Set(finishedRows.map((r) => r.location_id));
    return ids.size > 1;
  }, [finishedRows]);

  return (
    <>
      {/* 3. FILTR QATORI — search + Filter right-aligned via ml-auto, result
          count at the row's right edge (DESIGN.md §9). */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-72">
            <Search
              className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              value={productSearch}
              onChange={(e) => setProductSearch(e.target.value)}
              placeholder="Qidirish (lotin yoki kirill)…"
              aria-label="Mahsulot qidirish"
              className="pl-9 pr-9"
            />
            {productSearch !== '' && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => setProductSearch('')}
                aria-label="Qidiruvni tozalash"
                className="absolute right-1.5 top-1.5 size-6 rounded-md text-muted-foreground"
              >
                <X className="size-4" />
              </Button>
            )}
          </div>
          <FilterPopover
            groups={STOCK_FILTER_GROUPS}
            value={productFilter}
            onApply={setProductFilter}
          />
          <span className="text-sm text-muted-foreground tabular-nums">
            {filteredStock.length} ta mahsulot
          </span>
        </div>
      </div>

      <Card>
        <header className="flex items-center gap-2 border-b border-border/60 p-5">
          <Warehouse className="size-4 text-primary" aria-hidden="true" />
          <div className="space-y-0.5">
            <h2 className="text-base font-semibold">Mahsulotlar</h2>
            <p className="text-xs text-muted-foreground">
              Markaziy sklad qoldig‘i — faqat tayyor mahsulot.
            </p>
          </div>
        </header>

      {stock.isLoading && <LoadingState />}
      {!stock.isLoading && stock.error && (
        <ErrorState message={stock.error} onRetry={stock.refetch} />
      )}
      {!stock.isLoading && !stock.error && filteredStock.length === 0 && (
        <EmptyState
          message={
            finishedRows.length === 0
              ? 'Tayyor mahsulot qoldig‘i topilmadi.'
              : 'Bu shart bo‘yicha mahsulot yo‘q.'
          }
        />
      )}
      {!stock.isLoading && !stock.error && filteredStock.length > 0 && (
        <div className="space-y-6 p-5">
          {stockGroups.map((group) => (
            <section key={group.key} className="space-y-3">
              {/* Section heading — kicker + secondary count badge (DESIGN.md §9). */}
              <div className="flex items-center gap-2">
                <h3 className="text-xs uppercase tracking-wide text-muted-foreground">
                  {group.name}
                </h3>
                <Badge variant="secondary" className="tabular-nums">
                  {group.items.length}
                </Badge>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                {group.items.map((row) => {
                  const basketItem = basket[row.product_id];
                  const hasMeter = row.max_level > 0;
                  return (
                    <Card
                      key={`${row.location_id}-${row.product_id}`}
                      className={cn(
                        'flex flex-col gap-2.5 p-4 transition-colors hover:border-border-strong hover:shadow-card-hover',
                        basketItem && 'ring-1 ring-primary/40',
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p
                          className="min-w-0 truncate text-sm font-medium leading-tight"
                          title={row.product_name}
                        >
                          {row.product_name}
                        </p>
                        <StockStatusPill row={row} />
                      </div>

                      {multiLocation && (
                        <p className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Warehouse
                            className="size-3 shrink-0"
                            aria-hidden="true"
                          />
                          <span className="truncate">
                            {locationNameById.get(row.location_id) ??
                              `#${row.location_id}`}
                          </span>
                        </p>
                      )}

                      <p
                        className={cn(
                          'text-xl font-semibold tabular-nums tracking-tight',
                          row.qty <= 0
                            ? 'text-destructive'
                            : row.qty <= row.min_level && 'text-warning',
                        )}
                      >
                        {formatQtyUnit(row.qty, row.product_unit)}
                      </p>

                      {hasMeter && (
                        <StockMeter
                          ratio={row.qty / row.max_level}
                          minRatio={row.min_level / row.max_level}
                          tone={stockToneOf(row)}
                        />
                      )}
                      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                        <span className="tabular-nums">
                          Min {formatQtyUnit(row.min_level, row.product_unit)}
                        </span>
                        <span className="tabular-nums">
                          Max {formatQtyUnit(row.max_level, row.product_unit)}
                        </span>
                      </div>

                      {/* Direct per-product actions (owner feedback): act
                          straight from the card. "Do'konga yuborish" needs
                          on-hand stock; "Ishlab chiqarishga yuborish" always
                          replenishes the central's own stock from production.
                          The basket stays as a SECONDARY batching control.
                          central manager only. */}
                      {canShip && (
                        <div className="mt-auto space-y-1.5 border-t border-border/40 pt-2.5">
                          {/* Fixed button ordering (DESIGN.md §9): one primary
                              per row, ALWAYS rightmost — outline secondary
                              first, primary "Do'konga" last (disabled when
                              there is nothing on hand to ship). */}
                          <div className="flex flex-col gap-1.5 sm:flex-row">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-8 flex-1 text-xs"
                              onClick={() => setProdRow(row)}
                            >
                              <Factory className="size-3.5" aria-hidden="true" />
                              Ishlab chiqarishga
                            </Button>
                            <Button
                              type="button"
                              variant="default"
                              size="sm"
                              className="h-8 flex-1 text-xs"
                              disabled={row.qty <= 0}
                              onClick={() => setShipRow(row)}
                              title={
                                row.qty <= 0
                                  ? 'Markazda qoldiq yo‘q — do‘konga jo‘natib bo‘lmaydi'
                                  : undefined
                              }
                            >
                              <Store className="size-3.5" aria-hidden="true" />
                              Do‘konga
                            </Button>
                          </div>

                          {/* Secondary basket batching control. */}
                          {basketItem ? (
                            <div className="flex items-center justify-between gap-2 rounded-md border border-primary/40 bg-primary/10 px-2 py-1.5">
                              <span className="flex items-center gap-1 text-xs font-medium text-primary">
                                <Check className="size-3.5" aria-hidden="true" />
                                Savatda
                              </span>
                              <div className="flex items-center gap-1">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="size-6"
                                  onClick={() => onStepQty(row.product_id, -1)}
                                  aria-label={`${row.product_name} sonini kamaytirish`}
                                >
                                  <Minus className="size-3.5" aria-hidden="true" />
                                </Button>
                                <Input
                                  type="text"
                                  inputMode="decimal"
                                  value={basketItem.qty}
                                  onChange={(e) =>
                                    onSetQty(
                                      row.product_id,
                                      Number(e.target.value.replace(',', '.')),
                                    )
                                  }
                                  aria-label={`${row.product_name} soni`}
                                  className="h-6 w-14 px-1 text-center text-xs tabular-nums"
                                />
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="size-6"
                                  disabled={
                                    basketItem.qty >= basketItem.current_qty
                                  }
                                  onClick={() => onStepQty(row.product_id, 1)}
                                  aria-label={`${row.product_name} sonini oshirish`}
                                >
                                  <Plus className="size-3.5" aria-hidden="true" />
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="size-6 text-muted-foreground hover:text-destructive"
                                  onClick={() => onRemove(row.product_id)}
                                  aria-label={`${row.product_name} ni savatdan olib tashlash`}
                                >
                                  <Trash2 className="size-3.5" aria-hidden="true" />
                                </Button>
                              </div>
                            </div>
                          ) : (
                            row.qty > 0 && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-7 w-full text-xs text-muted-foreground hover:text-foreground"
                                onClick={() => onToggleBasket(row)}
                              >
                                <ShoppingCart
                                  className="size-3.5"
                                  aria-hidden="true"
                                />
                                Savatga qo‘shish
                              </Button>
                            )
                          )}
                        </div>
                      )}
                    </Card>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}

      {/* Direct card-action dialogs. Both refetch the stock query on success so
          the card reflects the change immediately. central manager only. */}
      {canShip && (
        <>
          <ShipToStoreDialog
            open={shipRow !== null}
            onOpenChange={(open) => {
              if (!open) setShipRow(null);
            }}
            row={shipRow}
            storeOptions={storeOptions}
            onDone={stock.refetch}
          />
          {centralId !== null && (
            <SendToProductionDialog
              open={prodRow !== null}
              onOpenChange={(open) => {
                if (!open) setProdRow(null);
              }}
              row={prodRow}
              centralId={centralId}
              onDone={stock.refetch}
            />
          )}
        </>
      )}
      </Card>
    </>
  );
}
