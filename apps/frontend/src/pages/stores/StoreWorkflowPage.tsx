import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  History,
  Inbox,
  Minus,
  PackageCheck,
  Pencil,
  Plus,
  Search,
  Send,
  ShoppingCart,
  Sparkles,
  Store,
  Trash2,
  X,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Tabs } from '@/components/ui/tabs';
import {
  FilterPopover,
  type FilterGroup,
  type FilterOption,
  type FilterValue,
} from '@/components/ui/filter-popover';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from '@/components/PageState';
import { useToast } from '@/components/ui/toast';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useAuth } from '@/hooks/useAuth';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { ApiError } from '@/lib/api-client';
import { formatDateTime, formatQtyUnit } from '@/lib/format';
import {
  REPLENISHMENT_STATUS_LABELS,
  REPLENISHMENT_STATUS_VARIANT,
  UNIT_OPTIONS,
} from '@/lib/labels';
import { matchesSearch } from '@/lib/translit';
import { groupByBatch } from '@/lib/groupByBatch';
import { cn } from '@/lib/utils';
import {
  DateRangeFilter,
  type DateRangeValue,
} from '@/components/DateRangeFilter';
import { rangeBounds } from '@/lib/dateRange';
import type {
  Location,
  MovementsResponse,
  Product,
  ReplenishmentRequest,
  StockMovement,
  StockRow,
} from '@/lib/types';
import { TERMINAL_REPLENISHMENT_STATUSES } from '@/lib/types';
import { StoreRequestCreateDialog } from './StoreRequestCreateDialog';
import { StoreReceiveDialog } from './StoreReceiveDialog';
import { StoreAiProposalsDialog } from './StoreAiProposalsDialog';
import { StoreMultiSelect } from './StoreMultiSelect';
import { StoreMinMaxEditDialog } from './StoreMinMaxEditDialog';
import {
  StoreStockDashboard,
  type StockStatusCounts,
} from './StoreStockDashboard';
import { StoreSalesAnalytics } from './StoreSalesAnalytics';
import { StoreWorkspaceSkeleton } from './StoreWorkspaceSkeleton';
import { StoreRequestsStatusDonut } from './StoreRequestsStatusDonut';
import { StoreRequestsTrendChart } from './StoreRequestsTrendChart';
import {
  batchSuccessMessage,
  submitStoreRequestBatch,
  type BatchRequestItem,
} from './storeRequestSubmit';
import { StoreBasketPanel } from './StoreBasketPanel';
import {
  basketItemFromStockRow,
  type BasketItem,
} from './storeBasket';

/**
 * Do'kon ish joyi — a clean, store-scoped workflow page (owner feedback: the
 * 398-row /replenishment dump is "juda tartibsiz").
 *
 * Three focused parts, scoped to one OR several stores:
 *   1. Mahsulotlar — the store's stock as searchable CARDS with a status
 *      filter; a store_manager can edit each product's min/max inline.
 *   2. So'rovlar — tabs: "So'rov" (sent), "Qabul qiluvchi" (incoming),
 *      "Tranzaksiyalar" (every movement touching the store, both directions).
 *
 * RBAC: a `store_manager` is pinned to their active location; `pm` gets a
 * custom, searchable MULTI-select store picker and can view several stores
 * combined (a per-row "Do'kon" column disambiguates). The backend RBAC-scopes
 * every endpoint, so a scoped manager never sees another store.
 *
 * Backend contracts:
 *   - Stock:        GET /api/stock[?location_id=]   (PATCH /api/stock/minmax)
 *   - Movements:    GET /api/stock/movements[?location_id=]&limit=
 *   - Requests:     GET /api/replenishment  (RBAC-scoped, filtered client-side)
 *   - Batch create: POST /api/replenishment/batch
 *   - Receive:      POST /api/replenishment/:id/receive
 */

type StockStatusKey = 'all' | 'below_min' | 'low' | 'out' | 'enough';

const STOCK_STATUS_TABS: { value: StockStatusKey; label: string }[] = [
  { value: 'all', label: 'Hammasi' },
  { value: 'below_min', label: 'Min’dan past' },
  { value: 'low', label: 'Kam' },
  { value: 'out', label: 'Tugagan' },
  { value: 'enough', label: 'Yetarli' },
];

type RequestTabKey = 'sent' | 'incoming' | 'transactions';

/** Top-level page sections, surfaced as header tabs (owner feedback). */
type PageTabKey = 'dashboard' | 'products' | 'requests';

const PAGE_TABS: { value: PageTabKey; label: string }[] = [
  { value: 'dashboard', label: 'Dashboard' },
  { value: 'products', label: 'Mahsulotlar' },
  { value: 'requests', label: 'So‘rovlar' },
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

function stockStatusOf(row: StockRow): Exclude<StockStatusKey, 'all'> {
  if (row.qty <= 0) return 'out';
  if (row.qty <= row.min_level) return 'below_min';
  if (isLowStock(row)) return 'low';
  return 'enough';
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

export function StoreWorkflowPage() {
  const { user, activeLocationId } = useAuth();
  const reducedMotion = usePrefersReducedMotion();
  const isPm = user?.role === 'pm';
  // RBAC split (owner feedback): the store-role user does the full workflow;
  // a "manager" (pm) only VIEWS (read-only). Every action affordance —
  // "+ So'rov qo'shish", "Qabul qilish", "AI takliflari", min/max edit — is
  // store_manager only; pm sees data without write controls.
  const isStoreManager = user?.role === 'store_manager';

  // PM picks one or more stores; a store_manager is pinned to their active
  // location (falling back to their primary location_id).
  const [pickedStoreIds, setPickedStoreIds] = useState<number[]>([]);
  const pinnedStoreId = activeLocationId ?? user?.location_id ?? null;
  const selectedStoreIds = useMemo<number[]>(() => {
    if (isPm) return pickedStoreIds;
    return pinnedStoreId === null ? [] : [pinnedStoreId];
  }, [isPm, pickedStoreIds, pinnedStoreId]);
  const selectedStoreSet = useMemo(
    () => new Set(selectedStoreIds),
    [selectedStoreIds],
  );
  const hasSelection = selectedStoreIds.length > 0;
  const multiStore = selectedStoreIds.length > 1;
  const singleStoreId: number | null =
    selectedStoreIds.length === 1 ? selectedStoreIds[0] ?? null : null;

  // PM needs the store list for the picker; scoped managers don't.
  const stores = useApiQuery<Location[]>(isPm ? '/api/locations' : null);
  const storeOptions = useMemo(
    () =>
      (stores.data ?? [])
        .filter((l) => l.type === 'store')
        .map((l) => ({ id: l.id, name: l.name })),
    [stores.data],
  );
  const storeNameById = useMemo(() => {
    const m = new Map<number, string>();
    for (const s of storeOptions) m.set(s.id, s.name);
    return m;
  }, [storeOptions]);

  // Default (owner feedback): once the store list loads, pre-select ALL
  // stores so the PM lands on the whole chain. Runs once; a later manual
  // "clear all" is respected (the guard never re-fills).
  const didInitStores = useRef(false);
  useEffect(() => {
    if (!isPm || didInitStores.current || storeOptions.length === 0) return;
    didInitStores.current = true;
    setPickedStoreIds(storeOptions.map((s) => s.id));
  }, [isPm, storeOptions]);

  const products = useApiQuery<Product[]>('/api/products');

  // Stock: a single store is fetched precisely; several stores fetch the
  // (RBAC-scoped) full list and filter client-side to the selection.
  const stockUrl = useMemo(() => {
    if (!hasSelection) return null;
    if (singleStoreId !== null) return `/api/stock?location_id=${singleStoreId}`;
    return '/api/stock';
  }, [hasSelection, singleStoreId]);
  const stock = useApiQuery<StockRow[]>(stockUrl);

  // The backend RBAC-scopes the list; we filter to the requester/target rows
  // for the selected store(s) below.
  const replen = useApiQuery<ReplenishmentRequest[]>('/api/replenishment');

  // Movements — every stock movement touching the selected store(s). A single
  // store filters server-side; several stores fetch a wider window and filter.
  const movementsUrl = useMemo(() => {
    if (!hasSelection) return null;
    if (singleStoreId !== null)
      return `/api/stock/movements?location_id=${singleStoreId}&limit=100`;
    // Several stores: the backend caps the page at 100; we fetch the cap and
    // filter to the selection client-side.
    return '/api/stock/movements?limit=100';
  }, [hasSelection, singleStoreId]);
  const movements = useApiQuery<MovementsResponse>(movementsUrl);

  // Default to the Dashboard overview tab on open (owner feedback).
  const [pageTab, setPageTab] = useState<PageTabKey>('dashboard');
  const [statusFilter, setStatusFilter] = useState<StockStatusKey>('all');
  const [productSearch, setProductSearch] = useState('');
  // Category + unit filter for the Mahsulotlar cards (owner: mirror /products).
  const [productFilter, setProductFilter] = useState<FilterValue>({
    category: [],
    unit: [],
  });
  const [requestTab, setRequestTab] = useState<RequestTabKey>('sent');
  // So'rovlar date filter (owner feedback) — applied to sent / incoming /
  // transactions by `created_at`. Defaults to the current month.
  const [dateRange, setDateRange] = useState<DateRangeValue>({ range: 'month' });
  const [createOpen, setCreateOpen] = useState(false);
  const [aiProposalsOpen, setAiProposalsOpen] = useState(false);
  const [receiveTarget, setReceiveTarget] =
    useState<ReplenishmentRequest | null>(null);
  const [minMaxTarget, setMinMaxTarget] = useState<StockRow | null>(null);

  const { notify } = useToast();
  // Online-store-style draft basket (owner feedback): the store_manager taps
  // "So'rov yuborish" on product cards to queue lines, then confirms once in
  // So'rovlar → each line becomes a replenishment_request via the SAME batch
  // endpoint the create dialog uses, so they flow to the central warehouse.
  // Lifted to the page so it persists across the Mahsulotlar ↔ So'rovlar tabs.
  // Keyed by product_id.
  const [basket, setBasket] = useState<Record<number, BasketItem>>({});
  const [basketSubmitting, setBasketSubmitting] = useState(false);
  // The Savat slide-over (owner feedback): a modern right-side panel that
  // opens from any tab — replaces the old inline "Shakllangan so'rov" table.
  const [basketOpen, setBasketOpen] = useState(false);

  const basketItems = useMemo(
    () =>
      Object.values(basket).sort((a, b) =>
        a.product_name.localeCompare(b.product_name),
      ),
    [basket],
  );
  const basketCount = basketItems.length;

  /** Toggle a stock row in/out of the basket (default refill-to-max qty). */
  function toggleBasket(row: StockRow) {
    setBasket((prev) => {
      const next = { ...prev };
      if (next[row.product_id]) {
        delete next[row.product_id];
      } else {
        next[row.product_id] = basketItemFromStockRow(row);
      }
      return next;
    });
  }

  /** Set an explicit qty for a basket line (clamped to ≥ 0; 0 = will be skipped). */
  function setBasketQty(productId: number, qty: number) {
    setBasket((prev) => {
      const item = prev[productId];
      if (!item) return prev;
      return {
        ...prev,
        [productId]: { ...item, qty: Number.isFinite(qty) && qty > 0 ? qty : 0 },
      };
    });
  }

  /** Step a basket line's qty by ±1 (never below 1 via the steppers). */
  function stepBasketQty(productId: number, delta: number) {
    setBasket((prev) => {
      const item = prev[productId];
      if (!item) return prev;
      const next = Math.max(1, item.qty + delta);
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

  /**
   * Confirm the draft basket: post every positive-qty line through the shared
   * batch helper (same endpoint as the create dialog), then clear + refetch so
   * the new requests appear under So'rov. Zero/blank rows are skipped.
   */
  async function confirmBasket() {
    const items: BatchRequestItem[] = basketItems
      .filter((i) => i.qty > 0)
      .map((i) => ({ product_id: i.product_id, qty_needed: i.qty }));
    if (items.length === 0 || singleStoreId == null) return;
    const requesterLocationId = singleStoreId;
    setBasketSubmitting(true);
    try {
      const res = await submitStoreRequestBatch({
        requester_location_id: requesterLocationId,
        items,
      });
      notify('success', batchSuccessMessage(res, items.length));
      clearBasket();
      replen.refetch();
      stock.refetch();
    } catch (err: unknown) {
      notify(
        'error',
        err instanceof ApiError ? err.message : 'So‘rovlarni yuborib bo‘lmadi.',
      );
    } finally {
      setBasketSubmitting(false);
    }
  }

  // Stock rows scoped to the selected store(s), name-sorted for the cards.
  const stockRows = useMemo(() => {
    const rows = (stock.data ?? []).filter((r) =>
      selectedStoreSet.has(r.location_id),
    );
    return [...rows].sort((a, b) =>
      a.product_name.localeCompare(b.product_name),
    );
  }, [stock.data, selectedStoreSet]);

  // Map product_id → Product so each stock row can resolve its Poster
  // category / unit (the `stock` rows themselves don't carry the category).
  const productById = useMemo(() => {
    const m = new Map<number, Product>();
    for (const p of products.data ?? []) m.set(p.id, p);
    return m;
  }, [products.data]);

  const filteredStock = useMemo(() => {
    const cats = productFilter.category ?? [];
    const units = productFilter.unit ?? [];
    return stockRows.filter((r) => {
      if (statusFilter !== 'all' && stockStatusOf(r) !== statusFilter) {
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
  }, [stockRows, statusFilter, productSearch, productFilter, productById]);

  // Distinct Poster categories across the scoped stock rows (most-populated
  // first) — feeds the Filter popover's searchable category group.
  const categoryOptions = useMemo<FilterOption[]>(() => {
    const counts = new Map<string, number>();
    for (const r of stockRows) {
      const name = productById.get(r.product_id)?.poster_category?.name;
      if (name == null) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0])))
      .map(([name]) => ({ value: name, label: name }));
  }, [stockRows, productById]);

  const STOCK_FILTER_GROUPS = useMemo<FilterGroup[]>(
    () => [
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

  // Group the filtered cards by Poster category (owner: like /products). A
  // trailing "Kategoriyasiz" bucket holds rows whose product has no category.
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

  // Real-time status counts for the Dashboard tab (no date filter — stock is
  // current-state data). Buckets partition the full scoped row set.
  const statusCounts = useMemo<StockStatusCounts>(() => {
    const c: StockStatusCounts = {
      total: stockRows.length,
      out: 0,
      below_min: 0,
      low: 0,
      enough: 0,
    };
    for (const r of stockRows) c[stockStatusOf(r)] += 1;
    return c;
  }, [stockRows]);

  // Active products available to request for this store. Stores hold and sell
  // FINISHED goods only — raw materials (Un, Shakar, Tuxum) and semi-finished
  // items are never requestable from a store.
  const requestableProducts = useMemo(
    () =>
      (products.data ?? []).filter((p) => p.is_active && p.type === 'finished'),
    [products.data],
  );

  // Absolute date bounds for the So'rovlar / Tranzaksiyalar filter.
  const bounds = useMemo(() => rangeBounds(dateRange), [dateRange]);
  const inRange = (iso: string) => {
    const t = new Date(iso).getTime();
    return t >= bounds.from && t <= bounds.to;
  };

  // Split the selected store(s)' requests into "sent" (requester, open) and
  // "incoming" (target/requester AND shipped, awaiting receive). Both are
  // scoped to the active date range by `created_at`.
  const { sent, incoming } = useMemo(() => {
    const rows = replen.data ?? [];
    const sentRows: ReplenishmentRequest[] = [];
    const incomingRows: ReplenishmentRequest[] = [];
    if (!hasSelection) return { sent: sentRows, incoming: incomingRows };

    for (const row of rows) {
      if (!inRange(row.created_at)) continue;
      const isRequester = selectedStoreSet.has(row.requester_location_id);
      const isTarget =
        row.target_location_id !== null &&
        selectedStoreSet.has(row.target_location_id);
      const isTerminal = TERMINAL_REPLENISHMENT_STATUSES.includes(row.status);

      if (isRequester && !isTerminal) sentRows.push(row);
      if ((isTarget || isRequester) && row.status === 'SHIP_TO_REQUESTER') {
        incomingRows.push(row);
      }
    }
    sentRows.sort((a, b) => b.id - a.id);
    incomingRows.sort((a, b) => b.id - a.id);
    return { sent: sentRows, incoming: incomingRows };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replen.data, selectedStoreSet, hasSelection, bounds]);

  // Tranzaksiyalar — every movement touching the selected store(s), newest
  // first. Each row is classified relative to the store as a receipt ("Qabul
  // qildi", to ∈ selection) or an issue ("Chiqardi", from ∈ selection).
  type StoreMovement = StockMovement & {
    direction: 'in' | 'out';
    /** The selected store this row is attributed to. */
    storeId: number;
    /** The counterparty location (the "Manba"/source or destination). */
    counterpartyName: string | null;
  };
  const storeMovements = useMemo<StoreMovement[]>(() => {
    if (!hasSelection) return [];
    const rows = movements.data?.items ?? [];
    const out: StoreMovement[] = [];
    for (const m of rows) {
      if (!inRange(m.created_at)) continue;
      const isIn = m.to_location_id !== null && selectedStoreSet.has(m.to_location_id);
      const isOut =
        m.from_location_id !== null && selectedStoreSet.has(m.from_location_id);
      if (isIn) {
        out.push({
          ...m,
          direction: 'in',
          storeId: m.to_location_id as number,
          counterpartyName: m.from_location_name,
        });
      } else if (isOut) {
        out.push({
          ...m,
          direction: 'out',
          storeId: m.from_location_id as number,
          counterpartyName: m.to_location_name,
        });
      }
    }
    return out.sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movements.data, selectedStoreSet, hasSelection, bounds]);

  // Charts dataset (owner): every request THIS store originated within the
  // active range, regardless of terminal status — so the donut can count
  // CLOSED ("Qabul qilingan") and CANCELLED ("Qabul qilinmagan") too. The
  // `sent` set above intentionally drops terminal rows (it's the open-work
  // list), so the charts need this broader, status-agnostic set. Same store
  // scope + same `bounds` as the list, so the charts match the filter.
  const chartRequests = useMemo<ReplenishmentRequest[]>(() => {
    const rows = replen.data ?? [];
    if (!hasSelection) return [];
    return rows.filter(
      (row) =>
        selectedStoreSet.has(row.requester_location_id) &&
        inRange(row.created_at),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replen.data, selectedStoreSet, hasSelection, bounds]);

  const requestTabOptions: { value: RequestTabKey; label: string }[] = [
    { value: 'sent', label: `So‘rov (${sent.length})` },
    { value: 'incoming', label: `Qabul qiluvchi (${incoming.length})` },
    { value: 'transactions', label: 'Tranzaksiyalar' },
  ];

  const requestRows = requestTab === 'sent' ? sent : incoming;
  // The SENT list groups lines that share a batch_id into one order entry
  // (owner feedback) so a basket confirmed together reads as a single order
  // instead of N scattered rows. Legacy null-batch rows render individually.
  const sentGroups = useMemo(() => groupByBatch(sent), [sent]);
  const storeName = (id: number) => storeNameById.get(id) ?? `#${id}`;

  return (
    <div className="mx-auto w-full max-w-[120rem] space-y-6">
      <PageHeader
        title="Do‘kon ish joyi"
        description="Do‘kon qoldig‘i, yuborilgan so‘rovlar va qabul qilinadigan jo‘natmalar — bitta joyda."
      />

      {/* Store picker + section tabs on the left; the So'rovlar date filter
          sits on the right of the SAME row (owner feedback) — shown only on
          the So'rovlar tab, where it drives the charts + request list. */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
          {isPm && (
            <StoreMultiSelect
              stores={storeOptions}
              selectedIds={pickedStoreIds}
              onChange={setPickedStoreIds}
            />
          )}
          {hasSelection && (
            <Tabs
              value={pageTab}
              onValueChange={setPageTab}
              options={PAGE_TABS}
              ariaLabel="Bo‘lim"
            />
          )}
        </div>
        <div className="flex items-center gap-3 sm:items-end">
          {hasSelection && pageTab === 'requests' && (
            <DateRangeFilter value={dateRange} onChange={setDateRange} />
          )}
          {/* Persistent Savat trigger (store_manager only) — visible from any
              tab whenever the draft has lines; the count "bumps" on add. */}
          {hasSelection && isStoreManager && basketCount > 0 && (
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
          )}
        </div>
      </div>

      {!hasSelection ? (
        <Card>
          <EmptyState
            message={
              isPm
                ? 'Boshlash uchun bir yoki bir nechta do‘konni tanlang.'
                : 'Sizga do‘kon biriktirilmagan.'
            }
          />
        </Card>
      ) : (
        <>
          {/* TAB: Dashboard — real-time KPI cards + status bars + sales. */}
          {pageTab === 'dashboard' && (
            <>
              {/* First load (no stock data yet, no error): a full-layout
                  skeleton mirroring the Dashboard tab, instead of a centred
                  spinner. A background refetch keeps `stock.data`, so the
                  page never blanks once data has loaded. */}
              {stock.isLoading && stock.data === null ? (
                <StoreWorkspaceSkeleton />
              ) : stock.error && stock.data === null ? (
                <Card>
                  <ErrorState message={stock.error} onRetry={stock.refetch} />
                </Card>
              ) : (
                <>
                  <StoreStockDashboard counts={statusCounts} />
                  {/* Sales analytics (owner): dashboard sales data,
                      store-scoped — KPI, Sotuv soni / summasi charts, top
                      products. The per-store "Do'konlar — savdo bo'yicha"
                      comparison block is a multi-store (pm) view — a
                      single-store store_manager never sees it. */}
                  <StoreSalesAnalytics
                    storeIds={selectedStoreIds}
                    showStoreBreakdown={isPm}
                  />
                </>
              )}
            </>
          )}

          {/* TAB: Mahsulotlar — searchable cards + status filter. */}
          {pageTab === 'products' && (
            <Card>
              <header className="flex flex-col gap-3 border-b border-border/60 p-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="space-y-0.5">
                    <h2 className="flex items-center gap-2 text-base font-semibold">
                      <Store className="size-4 text-primary" aria-hidden="true" />
                      Mahsulotlar
                    </h2>
                    <p className="text-xs text-muted-foreground">
                      Do‘kon qoldig‘i va har bir mahsulot holati.
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
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
                        <button
                          type="button"
                          onClick={() => setProductSearch('')}
                          aria-label="Qidiruvni tozalash"
                          className="absolute right-2 top-2 rounded-md p-1 text-muted-foreground hover:bg-accent"
                        >
                          <X className="size-4" />
                        </button>
                      )}
                    </div>
                    <FilterPopover
                      groups={STOCK_FILTER_GROUPS}
                      value={productFilter}
                      onApply={setProductFilter}
                    />
                  </div>
                </div>
                <Tabs
                  value={statusFilter}
                  onValueChange={setStatusFilter}
                  options={STOCK_STATUS_TABS}
                  ariaLabel="Qoldiq holati bo‘yicha filtr"
                  fullWidth
                />
              </header>

              {stock.isLoading && <LoadingState />}
              {!stock.isLoading && stock.error && (
                <ErrorState message={stock.error} onRetry={stock.refetch} />
              )}
              {!stock.isLoading && !stock.error && filteredStock.length === 0 && (
                <EmptyState
                  message={
                    stockRows.length === 0
                      ? 'Qoldiq ma’lumotlari topilmadi.'
                      : 'Bu shart bo‘yicha mahsulot yo‘q.'
                  }
                />
              )}
              {!stock.isLoading && !stock.error && filteredStock.length > 0 && (
                <div className="space-y-6 p-5">
                  {stockGroups.map((group) => (
                    <section key={group.key} className="space-y-3">
                      <div className="flex items-center gap-2">
                        <h3 className="text-xs uppercase tracking-wide text-muted-foreground">
                          {group.name}
                        </h3>
                        <Badge variant="outline" className="tabular-nums">
                          {group.items.length}
                        </Badge>
                      </div>
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                        {group.items.map((row) => {
                          const danger =
                            row.qty <= 0 || row.qty <= row.min_level;
                          const basketItem = basket[row.product_id];
                          return (
                            <div
                              key={`${row.location_id}-${row.product_id}`}
                              className={cn(
                                'flex flex-col gap-3 rounded-lg border border-border/60 bg-card/40 p-4 shadow-sm transition-colors hover:bg-card/70',
                                danger && 'border-destructive/40 bg-destructive/5',
                                basketItem && 'border-primary/50 bg-primary/5',
                              )}
                            >
                              <div className="flex items-start justify-between gap-2">
                                <p className="min-w-0 text-sm font-semibold leading-tight">
                                  {row.product_name}
                                </p>
                                <StockStatusPill row={row} />
                              </div>

                              {multiStore && (
                                <Badge variant="outline" className="w-fit gap-1">
                                  <Store
                                    className="size-3"
                                    aria-hidden="true"
                                  />
                                  {storeName(row.location_id)}
                                </Badge>
                              )}

                              <div>
                                <p className="text-xs text-muted-foreground">
                                  Qoldiq
                                </p>
                                <p
                                  className={cn(
                                    'text-lg font-semibold tabular-nums',
                                    danger && 'text-destructive',
                                  )}
                                >
                                  {formatQtyUnit(row.qty, row.product_unit)}
                                </p>
                              </div>

                              <div className="flex items-end justify-between gap-2 border-t border-border/40 pt-2">
                                <div>
                                  <p className="text-xs text-muted-foreground">
                                    Min / Max
                                  </p>
                                  <p className="text-xs tabular-nums text-muted-foreground">
                                    {formatQtyUnit(
                                      row.min_level,
                                      row.product_unit,
                                    )}
                                    {' / '}
                                    {formatQtyUnit(
                                      row.max_level,
                                      row.product_unit,
                                    )}
                                  </p>
                                </div>
                                {isStoreManager && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 shrink-0 px-2 text-xs text-muted-foreground hover:text-foreground"
                                    onClick={() => setMinMaxTarget(row)}
                                  >
                                    <Pencil
                                      className="size-3.5"
                                      aria-hidden="true"
                                    />
                                    Tahrir
                                  </Button>
                                )}
                              </div>

                              {/* Basket control (store_manager only). Empty →
                                  "So'rov yuborish"; in basket → qty stepper +
                                  remove. Adding/removing keeps the page-level
                                  draft which the So'rovlar tab confirms. */}
                              {isStoreManager &&
                                (basketItem ? (
                                  <div className="flex items-center justify-between gap-2 rounded-md border border-primary/40 bg-primary/10 px-2 py-1.5">
                                    <span className="flex items-center gap-1 text-xs font-medium text-primary">
                                      <Check
                                        className="size-3.5"
                                        aria-hidden="true"
                                      />
                                      Savatda
                                    </span>
                                    <div className="flex items-center gap-1">
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        className="size-6"
                                        onClick={() =>
                                          stepBasketQty(row.product_id, -1)
                                        }
                                        aria-label={`${row.product_name} sonini kamaytirish`}
                                      >
                                        <Minus
                                          className="size-3.5"
                                          aria-hidden="true"
                                        />
                                      </Button>
                                      <Input
                                        type="number"
                                        inputMode="decimal"
                                        min="0"
                                        step="any"
                                        value={basketItem.qty}
                                        onChange={(e) =>
                                          setBasketQty(
                                            row.product_id,
                                            Number(
                                              e.target.value.replace(',', '.'),
                                            ),
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
                                        onClick={() =>
                                          stepBasketQty(row.product_id, 1)
                                        }
                                        aria-label={`${row.product_name} sonini oshirish`}
                                      >
                                        <Plus
                                          className="size-3.5"
                                          aria-hidden="true"
                                        />
                                      </Button>
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        className="size-6 text-muted-foreground hover:text-destructive"
                                        onClick={() =>
                                          removeBasketItem(row.product_id)
                                        }
                                        aria-label={`${row.product_name} ni savatdan olib tashlash`}
                                      >
                                        <Trash2
                                          className="size-3.5"
                                          aria-hidden="true"
                                        />
                                      </Button>
                                    </div>
                                  </div>
                                ) : (
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="h-8 w-full text-xs"
                                    onClick={() => toggleBasket(row)}
                                  >
                                    <ShoppingCart
                                      className="size-3.5"
                                      aria-hidden="true"
                                    />
                                    So‘rov yuborish
                                  </Button>
                                ))}
                            </div>
                          );
                        })}
                      </div>
                    </section>
                  ))}
                </div>
              )}
            </Card>
          )}

          {/* Sticky basket bar — visible on Mahsulotlar while the draft has
              lines; opens the Savat slide-over to review + confirm. */}
          {pageTab === 'products' && isStoreManager && basketCount > 0 && (
            <div className="sticky bottom-4 z-10 flex items-center justify-between gap-3 rounded-lg border border-primary/40 bg-card/95 px-4 py-3 pr-[5.5rem] shadow-lg backdrop-blur sm:pr-[11rem]">
              <span className="flex items-center gap-2 text-sm font-medium">
                <ShoppingCart className="size-4 text-primary" aria-hidden="true" />
                {basketCount} ta mahsulot tanlandi
              </span>
              <Button size="sm" onClick={() => setBasketOpen(true)}>
                Savatni ko‘rish
              </Button>
            </div>
          )}

          {/* TAB: So'rovlar (So'rov / Qabul qiluvchi / Tranzaksiyalar). */}
          {pageTab === 'requests' && (
            <div className="space-y-6">
              {/* Charts row (owner): donut by status + per-day trend, both
                  derived from `chartRequests` so they follow the SAME date
                  filter as the list below. Side by side on lg+, stacked on
                  small screens. Sits above the sub-tab strip so it reads as
                  the So'rovlar section header. */}
              {!replen.isLoading && !replen.error && (
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                  <StoreRequestsStatusDonut requests={chartRequests} />
                  <StoreRequestsTrendChart requests={chartRequests} />
                </div>
              )}

              <Card>
              <header className="flex flex-col gap-3 border-b border-border/60 p-5 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-0.5">
                  <h2 className="flex items-center gap-2 text-base font-semibold">
                    <Send className="size-4 text-primary" aria-hidden="true" />
                    So‘rovlar
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    Yuborilgan so‘rovlar va qabul qilinadigan jo‘natmalar.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <Tabs
                    value={requestTab}
                    onValueChange={setRequestTab}
                    options={requestTabOptions}
                    ariaLabel="So‘rovlar ko‘rinishi"
                  />
                  {/* Action affordances are store_manager-only; pm views
                      read-only (owner RBAC split). */}
                  {isStoreManager && requestTab === 'sent' && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setAiProposalsOpen(true)}
                      >
                        <Sparkles className="size-4" aria-hidden="true" />
                        AI takliflari
                      </Button>
                      <Button onClick={() => setCreateOpen(true)} size="sm">
                        <Plus className="size-4" aria-hidden="true" />
                        So‘rov qo‘shish
                      </Button>
                    </>
                  )}
                </div>
              </header>

              {requestTab !== 'transactions' && replen.isLoading && (
                <LoadingState />
              )}
              {requestTab !== 'transactions' &&
                !replen.isLoading &&
                replen.error && (
                  <ErrorState message={replen.error} onRetry={replen.refetch} />
                )}
              {requestTab !== 'transactions' &&
                !replen.isLoading &&
                !replen.error &&
                requestRows.length === 0 && (
                  <EmptyState
                    message={
                      requestTab === 'sent'
                        ? 'Hozircha yuborilgan so‘rov yo‘q.'
                        : 'Qabul qilinadigan jo‘natma yo‘q.'
                    }
                  />
                )}
              {/* SENT (So'rov) — grouped by order: one card per batch, the
                  lines listed under an order header (time + N mahsulot). */}
              {requestTab === 'sent' &&
                !replen.isLoading &&
                !replen.error &&
                sentGroups.length > 0 && (
                  <div className="space-y-4 p-5">
                    {sentGroups.map((group) => {
                      const isGroup = group.batch_id !== null;
                      return (
                        <section
                          key={group.key}
                          className="rounded-lg border border-border/60 bg-card/40"
                          aria-label={`Buyurtma — ${group.lines.length} mahsulot`}
                        >
                          <header className="flex flex-wrap items-center gap-2 border-b border-border/60 p-4">
                            <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                              {formatDateTime(group.created_at)}
                              <Badge variant="outline" className="tabular-nums">
                                {group.lines.length} mahsulot
                              </Badge>
                              {!isGroup && (
                                <Badge variant="secondary">Yakka so‘rov</Badge>
                              )}
                            </h3>
                          </header>
                          <ul className="divide-y divide-border/40">
                            {group.lines.map((line) => (
                              <li
                                key={line.id}
                                className="flex flex-wrap items-center gap-x-3 gap-y-1 p-4"
                              >
                                <span className="text-xs text-muted-foreground">
                                  #{line.id}
                                </span>
                                <span className="min-w-0 flex-1 font-medium">
                                  {line.product_name}
                                </span>
                                <span className="tabular-nums text-muted-foreground">
                                  {formatQtyUnit(
                                    line.qty_needed,
                                    line.product_unit,
                                  )}
                                </span>
                                <Badge
                                  variant={
                                    REPLENISHMENT_STATUS_VARIANT[line.status]
                                  }
                                >
                                  {REPLENISHMENT_STATUS_LABELS[line.status]}
                                </Badge>
                              </li>
                            ))}
                          </ul>
                        </section>
                      );
                    })}
                  </div>
                )}

              {/* INCOMING (Qabul qiluvchi) — flat table with the receive action. */}
              {requestTab === 'incoming' &&
                !replen.isLoading &&
                !replen.error &&
                requestRows.length > 0 && (
                  <div className="scrollbar-thin overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>#</TableHead>
                          <TableHead>Mahsulot</TableHead>
                          <TableHead className="text-right">Miqdor</TableHead>
                          <TableHead>Holat</TableHead>
                          <TableHead>Yaratilgan</TableHead>
                          {isStoreManager && (
                            <TableHead className="text-right">Amal</TableHead>
                          )}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {requestRows.map((row) => (
                          <TableRow key={row.id}>
                            <TableCell className="text-muted-foreground">
                              #{row.id}
                            </TableCell>
                            <TableCell className="font-medium">
                              {row.product_name}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatQtyUnit(row.qty_needed, row.product_unit)}
                            </TableCell>
                            <TableCell>
                              <Badge
                                variant={REPLENISHMENT_STATUS_VARIANT[row.status]}
                              >
                                {REPLENISHMENT_STATUS_LABELS[row.status]}
                              </Badge>
                            </TableCell>
                            <TableCell className="whitespace-nowrap text-muted-foreground">
                              {formatDateTime(row.created_at)}
                            </TableCell>
                            {isStoreManager && (
                              <TableCell className="text-right">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => setReceiveTarget(row)}
                                >
                                  <PackageCheck
                                    className="size-4"
                                    aria-hidden="true"
                                  />
                                  Qabul qilish
                                </Button>
                              </TableCell>
                            )}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}

              {/* Tranzaksiyalar — har bir harakat (qabul qildi / chiqardi). */}
              {requestTab === 'transactions' && movements.isLoading && (
                <LoadingState />
              )}
              {requestTab === 'transactions' &&
                !movements.isLoading &&
                movements.error && (
                  <ErrorState
                    message={movements.error}
                    onRetry={movements.refetch}
                  />
                )}
              {requestTab === 'transactions' &&
                !movements.isLoading &&
                !movements.error &&
                storeMovements.length === 0 && (
                  <EmptyState message="Hali harakat yo‘q." />
                )}
              {requestTab === 'transactions' &&
                !movements.isLoading &&
                !movements.error &&
                storeMovements.length > 0 && (
                  <div className="scrollbar-thin overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Sana</TableHead>
                          {multiStore && <TableHead>Do‘kon</TableHead>}
                          <TableHead>Mahsulot</TableHead>
                          <TableHead className="text-right">Miqdor</TableHead>
                          <TableHead className="text-right">Yaroqsiz</TableHead>
                          <TableHead>Manba</TableHead>
                          <TableHead>Harakat</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {storeMovements.map((m) => {
                          const hasBrak = m.brak_qty != null && m.brak_qty > 0;
                          return (
                            <TableRow key={m.id}>
                              <TableCell className="whitespace-nowrap text-muted-foreground">
                                {formatDateTime(m.created_at)}
                              </TableCell>
                              {multiStore && (
                                <TableCell className="text-muted-foreground">
                                  {storeName(m.storeId)}
                                </TableCell>
                              )}
                              <TableCell className="font-medium">
                                {m.product_name}
                              </TableCell>
                              <TableCell className="text-right tabular-nums">
                                {formatQtyUnit(m.qty, m.product_unit)}
                              </TableCell>
                              <TableCell
                                className={cn(
                                  'text-right tabular-nums',
                                  hasBrak
                                    ? 'font-medium text-destructive'
                                    : 'text-muted-foreground',
                                )}
                              >
                                {hasBrak
                                  ? formatQtyUnit(
                                      m.brak_qty as number,
                                      m.product_unit,
                                    )
                                  : '—'}
                              </TableCell>
                              <TableCell className="text-muted-foreground">
                                {m.counterpartyName ?? '—'}
                              </TableCell>
                              <TableCell>
                                {m.direction === 'in' ? (
                                  <Badge variant="success" className="gap-1">
                                    <ArrowDownLeft
                                      className="size-3"
                                      aria-hidden="true"
                                    />
                                    Qabul qildi
                                  </Badge>
                                ) : (
                                  <Badge variant="warning" className="gap-1">
                                    <ArrowUpRight
                                      className="size-3"
                                      aria-hidden="true"
                                    />
                                    Chiqardi
                                  </Badge>
                                )}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                )}

              {requestTab === 'incoming' && isStoreManager && (
                <p className="flex items-center gap-2 border-t border-border/60 px-5 py-3 text-xs text-muted-foreground">
                  <Inbox className="size-3.5" aria-hidden="true" />
                  Jo‘natilgan tovar yetib kelganda «Qabul qilish» orqali
                  tasdiqlang.
                </p>
              )}
              {requestTab === 'transactions' && (
                <p className="flex items-center gap-2 border-t border-border/60 px-5 py-3 text-xs text-muted-foreground">
                  <History className="size-3.5" aria-hidden="true" />
                  Do‘kon harakatlari (qabul qildi / chiqardi) — eng yangisi
                  yuqorida.
                </p>
              )}
              </Card>
            </div>
          )}
        </>
      )}

      {isStoreManager && (
        <StoreBasketPanel
          open={basketOpen}
          onOpenChange={setBasketOpen}
          items={basketItems}
          count={basketCount}
          submitting={basketSubmitting}
          singleStoreId={singleStoreId}
          setQty={setBasketQty}
          stepQty={stepBasketQty}
          removeItem={removeBasketItem}
          clear={clearBasket}
          confirm={confirmBasket}
          onGoToProducts={() => {
            setBasketOpen(false);
            setPageTab('products');
          }}
        />
      )}

      <StoreRequestCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        products={requestableProducts}
        storeLocationId={singleStoreId ?? 0}
        onSaved={() => {
          replen.refetch();
          stock.refetch();
        }}
      />

      <StoreReceiveDialog
        open={receiveTarget !== null}
        onOpenChange={(o) => {
          if (!o) setReceiveTarget(null);
        }}
        request={receiveTarget}
        onSaved={() => {
          setReceiveTarget(null);
          replen.refetch();
          stock.refetch();
        }}
      />

      <StoreAiProposalsDialog
        open={aiProposalsOpen}
        onOpenChange={setAiProposalsOpen}
        storeLocationId={singleStoreId ?? 0}
        onApproved={() => {
          replen.refetch();
          stock.refetch();
        }}
      />

      <StoreMinMaxEditDialog
        row={minMaxTarget}
        open={minMaxTarget !== null}
        onOpenChange={(o) => {
          if (!o) setMinMaxTarget(null);
        }}
        onSaved={() => {
          setMinMaxTarget(null);
          stock.refetch();
        }}
      />
    </div>
  );
}
