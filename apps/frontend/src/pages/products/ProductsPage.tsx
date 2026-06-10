import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  Calculator,
  Factory,
  Pencil,
  ScrollText,
  Search,
  X,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  FilterPopover,
  type FilterGroup,
  type FilterOption,
  type FilterValue,
} from '@/components/ui/filter-popover';
import { MobileCardList } from '@/components/ui/table-mobile';
import {
  EmptyState,
  ErrorState,
  PageHeader,
} from '@/components/PageState';
import { useApiQuery } from '@/hooks/useApiQuery';
import { ApiError, apiRequest } from '@/lib/api-client';
import { useAuth } from '@/hooks/useAuth';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { PRODUCT_TYPE_LABELS, UNIT_LABELS, UNIT_OPTIONS } from '@/lib/labels';
import { matchesSearch } from '@/lib/translit';
import {
  PRODUCT_CATEGORY_STYLE,
  effectiveType,
  isResaleCategory,
} from '@/lib/productCategory';
import { formatPlainNumber, formatQty, formatSom } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { Product, Unit } from '@/lib/types';
import { ProductCostDialog } from './ProductCostDialog';
import { ProductsPageSkeleton } from './ProductsPageSkeleton';
import { WorkshopPicker, type WorkshopOption } from './WorkshopPicker';

/**
 * The three filter dimensions all live inside the Filter popover now
 * (owner reversed the earlier "type tabs + category chips" layout). `type`
 * lives in a page-level segmented tab row; `category` / `unit` / `workshop`
 * options come from the server FACETS in the paginated catalogue (or are
 * derived from the loaded rows in the stock-aware section — see below).
 */

/** Filter popover default — nothing pre-selected (each group empty). */
const DEFAULT_FILTER: FilterValue = { category: [], unit: [], workshop: [] };

/**
 * Sentinel option value for the WORKSHOP filter that matches products with NO
 * assigned sex (`workshop == null`). A real workshop id can never collide with
 * it, so the server (`workshop=none`) and the legacy client filter both branch
 * on this string safely.
 */
const WORKSHOP_NONE = 'none';

/** Product TYPE lives in a page-level segmented tab row (not the filter). */
type TypeTab = 'all' | 'finished' | 'semi' | 'raw';
const TYPE_TABS: { value: TypeTab; label: string }[] = [
  { value: 'all', label: 'Hammasi' },
  { value: 'finished', label: PRODUCT_TYPE_LABELS.finished },
  { value: 'semi', label: PRODUCT_TYPE_LABELS.semi },
  { value: 'raw', label: PRODUCT_TYPE_LABELS.raw },
];

/**
 * PERFORMANCE — server page size for the paginated catalogue. Each scroll
 * batch fetches exactly this many products from the backend (true server-side
 * pagination), instead of the old client-side lazy-render window over the
 * whole ~1.7k-product set.
 */
const PAGE_SIZE = 50;

/**
 * Legacy (stock-aware section) lazy-render window. The `/api/products/yarim-tayyor`
 * endpoint returns a small, already-отдел-scoped bare array (NO server
 * pagination), so that mode keeps the original client-side incremental render.
 */
const LEGACY_RENDER_BATCH = 24;

/** sessionStorage key — remembers the active type tab across navigation. */
const TYPE_TAB_KEY = 'products.typeTab';

/** Debounce (ms) before a keystroke in the search box triggers a server fetch. */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * The server FACETS envelope returned by `GET /api/products` when `limit` is
 * passed (opt-in pagination). `categories` carry a display label + count;
 * `units` are raw unit codes; `workshops` are the assignable sexes. These
 * populate the filter popover — the page now holds only ONE partial page, so
 * the options can NOT be derived from the loaded rows.
 */
interface ProductFacets {
  categories: { value: string; label: string; count: number }[];
  units: string[];
  workshops: { id: number; name: string }[];
}

/** The paginated `GET /api/products?...&limit=&offset=` response envelope. */
interface ProductsPageResponse {
  items: Product[];
  total: number;
  facets: ProductFacets;
}

/** Empty facets — the initial value before the first page resolves. */
const EMPTY_FACETS: ProductFacets = { categories: [], units: [], workshops: [] };

/**
 * Small amber warn pill for a PRODUCED product that is missing its
 * Poster recipe (`has_recipe === false`). Light-mode-safe amber with a
 * `dark:` variant per the existing convention; resale/base items never
 * render this.
 */
function RecipelessBadge() {
  return (
    <Badge
      variant="warning"
      className="whitespace-nowrap"
      title="Bu mahsulot ishlab chiqariladi, lekin Posterda retsepti yo‘q"
    >
      <AlertTriangle className="size-3" aria-hidden="true" />
      Retseptsiz
    </Badge>
  );
}

/**
 * FEATURE A — small indigo pill marking a hand-entered (manual) price, so a
 * card with a manual override reads clearly as "not from Poster".
 */
function ManualPriceBadge() {
  return (
    <Badge
      variant="info"
      className="whitespace-nowrap text-[11px]"
      title="Narx qo‘lda kiritilgan (Poster narxidan emas)"
    >
      qo‘lda
    </Badge>
  );
}

/**
 * The «Narx» (Себестоимость) value shown on a card. The backend now computes
 * it server-side: for RAW products it is the editable manual/synced cost; for
 * `semi`/`finished` it is the recipe rollup (read-only). `null` → render "—".
 */
function displayCost(p: Product): number | null {
  return p.computed_cost ?? null;
}

/**
 * A PRODUCED product (finished/semi, non-resale category) whose backend
 * `has_recipe` is EXPLICITLY false is missing its Poster recipe → warn.
 * Resale/base items and older API rows (`has_recipe === undefined`) stay
 * neutral so they don't all light up. Pure — lifted to module scope so the
 * memoised card can reference it without a per-render closure dependency.
 */
function needsRecipeWarn(p: Product): boolean {
  const type = effectiveType(p);
  return (
    p.has_recipe === false &&
    (type === 'finished' || type === 'semi') &&
    !isResaleCategory(p.poster_category?.name ?? null)
  );
}

/**
 * Subtle muted hint for a SEMI/FINISHED card — its price is auto-derived from
 * the recipe and not editable here (dark-premium muted, small calculator glyph).
 */
function ComputedPriceHint() {
  return (
    <span
      className="inline-flex items-center gap-1 whitespace-nowrap text-[11px] font-medium text-muted-foreground/70"
      title="Narx retsept asosida avtomatik hisoblangan (tahrirlab bo‘lmaydi)"
    >
      <Calculator className="size-3" aria-hidden="true" />
      hisoblangan
    </span>
  );
}

/**
 * Small rounded product thumbnail shown at the card's top-left. Renders the
 * Poster "Обложка" image when present. When `image_url` is null/empty OR the
 * image fails to load (`onError`), it renders NOTHING (no placeholder box /
 * icon) — owner feedback: the empty Package placeholder is unwanted, the
 * product name should take the freed space instead.
 */
function ProductThumbnail({
  src,
  alt,
  className,
}: {
  src: string | null | undefined;
  alt: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const showImage = src != null && src !== '' && !failed;
  if (!showImage) return null;
  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border/60 bg-surface-3',
        className,
      )}
    >
      <img
        src={src}
        alt={alt}
        loading="lazy"
        onError={() => setFailed(true)}
        className="size-full object-cover"
      />
    </div>
  );
}

/**
 * Subtle "🏭 {workshop.name}" line — the production sex that makes the
 * product. Renders nothing when `workshop` is null (raw / resale items),
 * so a card never shows an empty sex placeholder. When an `edit` node is
 * passed (an editor's change-sex affordance) it sits inline after the name.
 */
function WorkshopLine({
  workshop,
  edit,
}: {
  workshop: Product['workshop'];
  edit?: React.ReactNode;
}) {
  if (workshop == null) return null;
  return (
    <p className="flex items-center gap-1 text-xs text-muted-foreground">
      <Factory className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate">{workshop.name}</span>
      {edit}
    </p>
  );
}

/**
 * «Yarim tayyor mahsulotlar» section row — the catalogue `Product` shape PLUS
 * the зг's on-hand stock. `GET /api/products/yarim-tayyor` returns this
 * (auto-scoped to the production_manager's отдел server-side). `qty` is the
 * current ostatka (qoldiq); 0 is a valid, expected value (not "no data").
 */
interface StockProduct extends Product {
  qty: number;
}

interface ProductCardProps {
  product: Product;
  /**
   * The зг's on-hand stock (qoldiq), rendered as a «Qoldiq» line. Passed only
   * by a stock-aware section (e.g. /yarim-tayyor); `undefined` on the generic
   * /products catalogue, where the card shows no stock line.
   */
  stockQty?: number;
  /**
   * Whether to render the per-card product-TYPE badge. `true` on the generic
   * /products page; the «Yarim tayyor» section passes `false` because every
   * card there is already yarim tayyor (the badge would be redundant).
   */
  showTypeBadge: boolean;
  /** May the current user assign / change the producing sex? (pm/prod-mgr) */
  canEditWorkshop: boolean;
  /** May the current user edit a RAW product's manual cost? (pm/prod-mgr) */
  canEditCost: boolean;
  /** Production workshops for the inline sex picker. */
  workshops: WorkshopOption[];
  /** Open the read-only recipe page for this product. */
  onOpenRecipe: (p: Product) => void;
  /** Open the manual-cost dialog for this RAW product. */
  onEditCost: (p: Product) => void;
  /** Refetch the product list after a successful sex assignment. */
  onWorkshopAssigned: () => void;
}

/**
 * A single desktop catalogue card, wrapped in {@link memo}.
 *
 * Memoising the card keeps the «slow catalogue» fix honest: the page appends
 * server pages on scroll, and without memo every append would re-render ALL
 * already-mounted cards. With stable callback props (the parent wraps its
 * handlers in `useCallback`), `memo`'s shallow prop compare lets a mounted
 * card skip re-render entirely when only the accumulated list grows — only the
 * newly-appended cards render.
 */
const ProductCard = memo(function ProductCard({
  product: p,
  stockQty,
  showTypeBadge,
  canEditWorkshop,
  canEditCost,
  workshops,
  onOpenRecipe,
  onEditCost,
  onWorkshopAssigned,
}: ProductCardProps) {
  // The section header already carries the real Poster category, so the card
  // badge shows the product TYPE (raw / semi / finished) — colour-coded.
  const type = effectiveType(p);
  const style = PRODUCT_CATEGORY_STYLE[type];
  // The inline sex-assign affordance is offered for PRODUCED products only
  // (raw/resale items have no sex), and only to users who may edit it.
  const canHaveWorkshop = type === 'finished' || type === 'semi';
  const showAssign = canEditWorkshop && canHaveWorkshop;
  const cost = displayCost(p);
  return (
    <Card
      className={cn(
        'flex h-full flex-col gap-2 border-l-4 border-border/60 p-3',
        style.accent,
      )}
    >
      {/* Row 1 — thumbnail + name (truncate) | type badge at the right. */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <ProductThumbnail src={p.image_url} alt={p.name} className="size-9" />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium" title={p.name}>
              {p.name}
            </p>
            {p.sku && (
              <p className="truncate text-[11px] text-muted-foreground">
                SKU: {p.sku}
              </p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {showTypeBadge && (
            <Badge variant={style.badge} className="whitespace-nowrap">
              {PRODUCT_TYPE_LABELS[type]}
            </Badge>
          )}
          {needsRecipeWarn(p) && <RecipelessBadge />}
        </div>
      </div>

      {/* Row 2 — producing sex (or the assign affordance), one quiet line. */}
      <WorkshopLine
        workshop={p.workshop}
        edit={
          showAssign && p.workshop != null ? (
            <WorkshopPicker
              productId={p.id}
              currentWorkshopId={p.workshop.id}
              workshops={workshops}
              variant="compact"
              onAssigned={onWorkshopAssigned}
            />
          ) : undefined
        }
      />
      {/* No sex yet → offer to assign one (produced products only). */}
      {showAssign && p.workshop == null && (
        <div>
          <WorkshopPicker
            productId={p.id}
            currentWorkshopId={null}
            workshops={workshops}
            variant="button"
            onAssigned={onWorkshopAssigned}
          />
        </div>
      )}

      {/* Value row — Narx big with a muted so‘m suffix; Birlik inline muted. */}
      <div className="mt-auto flex items-baseline justify-between gap-2 pt-0.5">
        <p className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate text-lg font-semibold tabular-nums tracking-tight">
            {cost != null ? formatPlainNumber(Math.round(cost)) : '—'}
          </span>
          {cost != null && (
            <span className="shrink-0 text-xs text-muted-foreground">so‘m</span>
          )}
          {type === 'raw' ? (
            p.manual_cost_per_unit != null && <ManualPriceBadge />
          ) : (
            <ComputedPriceHint />
          )}
        </p>
        <span className="shrink-0 text-xs text-muted-foreground">
          {UNIT_LABELS[p.unit]}
        </span>
      </div>

      {/* «Qoldiq» (ostatka) — the зг's on-hand stock. Shown only in a
          stock-aware section; 0 is a valid value and renders as "0 dona". */}
      {stockQty !== undefined && (
        <p className="text-xs text-muted-foreground">
          Qoldiq:{' '}
          <span className="font-medium tabular-nums text-foreground">
            {formatQty(stockQty)} {UNIT_LABELS[p.unit]}
          </span>
        </p>
      )}

      {/* Foot — quiet left-aligned ghost actions (no boxed full-width button).
          Only xom-ashyo price is editable; semi/finished show a read-only
          computed price (the «hisoblangan» hint above). */}
      {((canEditCost && type === 'raw') || type !== 'raw') && (
        <div className="-mb-1 -ml-2 flex items-center gap-1">
          {canEditCost && type === 'raw' && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => onEditCost(p)}
            >
              <Pencil className="size-3.5" aria-hidden="true" />
              Narx
            </Button>
          )}
          {type !== 'raw' && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => onOpenRecipe(p)}
            >
              <ScrollText className="size-3.5" aria-hidden="true" />
              Retseptni ko‘rish
            </Button>
          )}
        </div>
      )}
    </Card>
  );
});

/**
 * M2 — products list. EPIC 1 redesign:
 *   1.1 a single multi-select filter popover carrying Kategoriya · Birlik ·
 *       Sex next to an always-visible translit-aware search box (TYPE is a
 *       page-level segmented tab row);
 *   1.2 translit-aware search (Latin ↔ Cyrillic), now applied SERVER-side;
 *   1.3 smart category badge (Г/П → finished, name → sub-category);
 *   1.4 category-grouped cards with colour-coding + infinite scroll;
 *   1.5 read-only recipe view on a dedicated page (see RecipePage).
 *
 * PERFORMANCE — the default catalogue (`GET /api/products`) now uses TRUE
 * server-side pagination: each request returns ONE small page (`limit=50`)
 * plus the server-computed FACETS for the filter popover. Type/search/filter
 * changes reset the offset and replace the accumulated rows; the scroll
 * sentinel fetches and appends the next page until `items.length >= total`.
 *
 * `pm` and `raw_warehouse_manager` may add products (§6).
 */
/**
 * Optional props — with none, ProductsPage is the full catalogue at
 * /products. A dedicated SECTION (e.g. «Yarim tayyor mahsulotlar» at
 * /yarim-tayyor) renders the SAME page pinned to one product type.
 */
interface ProductsPageProps {
  /**
   * Lock the catalogue to ONE product type and hide the type-tab row. The
   * shared sessionStorage tab memory is bypassed so a pinned section never
   * clobbers the user's /products tab choice.
   */
  forcedType?: TypeTab;
  /** Heading overrides (default: the generic catalogue copy). */
  title?: string;
  description?: string;
  /**
   * API path to fetch the product list from. Defaults to the full catalogue
   * `GET /api/products` (server-paginated). The «Yarim tayyor mahsulotlar»
   * section points this at `GET /api/products/yarim-tayyor`, which returns
   * ONLY the logged-in production_manager's отдел зг (same item shape PLUS a
   * `qty` stock field) as a small, already-scoped BARE ARRAY (no server
   * pagination). A non-default endpoint switches the page to the legacy
   * client-side filter + incremental-render path.
   */
  dataEndpoint?: string;
  /**
   * Render the зг's on-hand stock (`qty`) as a «Qoldiq» line on each card AND
   * drop the redundant per-card type badge. Paired with `dataEndpoint`
   * pointing at the stock-aware endpoint. Off (generic catalogue) by default.
   */
  showStock?: boolean;
}

/** The default catalogue endpoint that supports server pagination + facets. */
const CATALOGUE_ENDPOINT = '/api/products';

export function ProductsPage({
  forcedType,
  title,
  description,
  dataEndpoint = CATALOGUE_ENDPOINT,
  showStock = false,
}: ProductsPageProps = {}) {
  const navigate = useNavigate();
  const { user } = useAuth();
  // FEATURE A — only pm / production_manager may edit the manual cost. The
  // same gate governs assigning / changing a product's producing sex.
  const canEditCost =
    user?.role === 'pm' || user?.role === 'production_manager';
  const canEditWorkshop = canEditCost;

  // PAGINATED MODE — the default catalogue uses true server pagination +
  // server facets. A custom endpoint (the stock-aware /yarim-tayyor section,
  // which returns a small already-scoped bare array) keeps the legacy
  // client-side filter + incremental-render path.
  const paginated = !showStock && dataEndpoint === CATALOGUE_ENDPOINT;

  // The product whose cost dialog is open (null = closed).
  const [costProduct, setCostProduct] = useState<Product | null>(null);

  const bp = useBreakpoint();
  const showMobileCards = bp === 'xs';
  const [filter, setFilter] = useState<FilterValue>(DEFAULT_FILTER);
  const [search, setSearch] = useState('');
  // Persist the active type tab so returning from the recipe page (or any
  // navigation) restores the tab the user was on — not a reset to "Hammasi".
  const [typeTab, setTypeTab] = useState<TypeTab>(() => {
    // A pinned section (e.g. /yarim-tayyor → 'semi') fixes the type and never
    // reads the shared tab memory.
    if (forcedType) {
      return forcedType;
    }
    try {
      const v = sessionStorage.getItem(TYPE_TAB_KEY);
      if (v === 'all' || v === 'finished' || v === 'semi' || v === 'raw') {
        return v;
      }
    } catch {
      // ignore — private mode / unavailable storage
    }
    // EPIC 1.4 — the owner wants the catalogue to open on the sellable
    // "tayyor mahsulot" (finished) set by default, not the full list, so a
    // manager lands on what the shops actually sell. Persisted choice wins.
    return 'finished';
  });
  useEffect(() => {
    // Pinned sections must not write (or restore) the shared tab memory.
    if (forcedType) {
      return;
    }
    try {
      sessionStorage.setItem(TYPE_TAB_KEY, typeTab);
    } catch {
      // best-effort
    }
  }, [typeTab, forcedType]);

  // The recipe (BOM) opens as a dedicated, read-only page (not a modal).
  // Stable identities (useCallback) so the memoised ProductCard's props don't
  // change every render — that's what lets a mounted card skip re-render when
  // only the accumulated list grows on scroll (perf fix).
  const openRecipe = useCallback(
    (p: Product) => navigate(`/products/${p.id}/recipe`),
    [navigate],
  );
  const onEditCost = useCallback((p: Product) => setCostProduct(p), []);

  // ── DEBOUNCED SEARCH ──────────────────────────────────────────────────
  // The query box updates `search` on every keystroke (instant input echo);
  // `debouncedSearch` trails it by SEARCH_DEBOUNCE_MS and is what actually
  // feeds the server query key, so typing doesn't fire a request per keypress.
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  useEffect(() => {
    const id = window.setTimeout(
      () => setDebouncedSearch(search),
      SEARCH_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(id);
  }, [search]);

  // ── PRODUCTION WORKSHOPS (sexes) ──────────────────────────────────────
  // Used by the inline sex-assign picker (and, in legacy mode, the workshop
  // FILTER dimension). `GET /api/products/workshops` is the SINGLE canonical
  // source. In paginated mode the filter's workshop options come from the
  // server FACETS instead, but the picker still needs this list. pm +
  // production_manager are authorised; for any other role the query is skipped.
  const { data: workshopData } = useApiQuery<WorkshopOption[]>(
    canEditWorkshop ? '/api/products/workshops' : null,
  );
  const workshops = useMemo<WorkshopOption[]>(() => {
    const rows = workshopData ?? [];
    return rows
      .map((w) => ({ id: w.id, name: w.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [workshopData]);

  // ── SERVER-PAGINATED CATALOGUE STATE ──────────────────────────────────
  // `useApiQuery` is single-shot (one fetch per path) and replaces on path
  // change, so it can't accumulate offset pages — we drive the fetches by
  // hand, accumulating `serverItems` across pages and tracking the
  // server-reported `total` + `facets`.
  const [serverItems, setServerItems] = useState<Product[]>([]);
  const [serverTotal, setServerTotal] = useState(0);
  const [facets, setFacets] = useState<ProductFacets>(EMPTY_FACETS);
  // Distinguish the very first page (drives the skeleton / error state) from
  // subsequent "load more" pages (drive the small bottom indicator).
  const [isLoadingFirst, setIsLoadingFirst] = useState(paginated);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  // Refs read inside the IntersectionObserver / fetch flow without forcing the
  // observer to be re-created on every append (they hold the live values the
  // closures would otherwise capture stale).
  const loadedCountRef = useRef(0);
  const totalRef = useRef(0);
  const isFetchingRef = useRef(false);
  const offsetRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  // STABLE query string (everything BUT offset) — the reset key. A change to
  // the type tab, the debounced search, or any selected filter rebuilds this
  // and triggers a fresh first-page load (offset reset + items replaced). Built
  // with URLSearchParams so values are correctly encoded. `workshop=none`
  // (the "Sexsiz" sentinel) flows straight through to the backend.
  const queryKey = useMemo(() => {
    const params = new URLSearchParams();
    params.set('type', typeTab);
    const s = debouncedSearch.trim();
    if (s !== '') params.set('search', s);
    const categories = filter.category ?? [];
    if (categories.length > 0) params.set('category', categories.join(','));
    const units = filter.unit ?? [];
    if (units.length > 0) params.set('unit', units.join(','));
    const ws = filter.workshop ?? [];
    if (ws.length > 0) params.set('workshop', ws.join(','));
    params.set('limit', String(PAGE_SIZE));
    return params.toString();
  }, [typeTab, debouncedSearch, filter]);

  // Fetch ONE page and accumulate it. `reset === true` starts a fresh
  // accumulation (first page after mount or any query-key change); otherwise it
  // appends the next page. Guarded by `isFetchingRef` so overlapping scroll
  // events / resets can't issue duplicate requests. Only runs in paginated mode.
  const fetchPage = useCallback(
    async (reset: boolean) => {
      if (!paginated) return;
      // A reset always supersedes an in-flight load — it aborts the previous
      // request below, so it must not be blocked by the guard. Only a "load
      // more" is debounced against a fetch already running. (Without this,
      // React 18 StrictMode's double-invoke aborts the first fetch while the
      // guard turns the second into a no-op → stuck loading.)
      if (!reset && isFetchingRef.current) return;
      isFetchingRef.current = true;

      // Cancel any previous in-flight request before starting a new one.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const offset = reset ? 0 : offsetRef.current;
      if (reset) {
        setIsLoadingFirst(true);
        setServerError(null);
      } else {
        setIsLoadingMore(true);
      }

      try {
        const res = await apiRequest<ProductsPageResponse>(
          `${CATALOGUE_ENDPOINT}?${queryKey}&offset=${offset}`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;

        const pageItems = res.items ?? [];
        offsetRef.current = offset + pageItems.length;
        totalRef.current = res.total;
        setServerTotal(res.total);
        // Facets are recomputed by the server for the current type/filter
        // context; refresh them from every page (cheap, keeps options honest).
        setFacets(res.facets ?? EMPTY_FACETS);

        if (reset) {
          loadedCountRef.current = pageItems.length;
          setServerItems(pageItems);
        } else {
          loadedCountRef.current += pageItems.length;
          setServerItems((prev) => [...prev, ...pageItems]);
        }
      } catch (err: unknown) {
        if (controller.signal.aborted) return;
        const message =
          err instanceof ApiError ? err.message : 'Ma’lumotni yuklab bo‘lmadi.';
        // Only the first page surfaces a blocking error state; a failed
        // "load more" leaves the already-loaded products visible.
        if (reset) setServerError(message);
      } finally {
        if (!controller.signal.aborted) {
          if (reset) setIsLoadingFirst(false);
          else setIsLoadingMore(false);
        }
        isFetchingRef.current = false;
      }
    },
    [paginated, queryKey],
  );

  // Reset + refetch the FIRST page on mount and whenever the query key changes
  // (type tab / debounced search / any filter). The query key is the reset key.
  useEffect(() => {
    if (!paginated) return;
    loadedCountRef.current = 0;
    totalRef.current = 0;
    offsetRef.current = 0;
    setServerItems([]);
    setServerTotal(0);
    void fetchPage(true);
    return () => abortRef.current?.abort();
  }, [paginated, fetchPage]);

  // ── STOCK-AWARE (legacy) MODE ─────────────────────────────────────────
  // The non-paginated endpoint (/api/products/yarim-tayyor) returns a small,
  // already-отдел-scoped bare array OR a `{ products: [...] }` envelope. Fetch
  // it once and filter/render client-side as before. The query is SKIPPED in
  // paginated mode (`null`) so the catalogue makes only its own paged calls.
  const { data: legacyData, isLoading: legacyLoading, error: legacyError, refetch: legacyRefetch } =
    useApiQuery<StockProduct[] | { products: StockProduct[] }>(
      paginated ? null : dataEndpoint,
    );

  // A workshop assignment / cost edit must refresh whichever data path is live.
  const onWorkshopAssigned = useCallback(() => {
    if (paginated) void fetchPage(true);
    else legacyRefetch();
  }, [paginated, fetchPage, legacyRefetch]);
  const refetchAll = useCallback(() => {
    if (paginated) void fetchPage(true);
    else legacyRefetch();
  }, [paginated, fetchPage, legacyRefetch]);

  const legacyProducts = useMemo<StockProduct[]>(() => {
    if (legacyData == null) return [];
    return Array.isArray(legacyData) ? legacyData : legacyData.products;
  }, [legacyData]);

  // Legacy client-side filter (type tab is fixed by `forcedType` in this mode,
  // so the type leg is skipped — the endpoint already type-scoped the rows).
  const legacyFiltered = useMemo(() => {
    if (paginated) return [];
    const selectedCategories = filter.category ?? [];
    const selectedUnits = filter.unit ?? [];
    const selectedWorkshops = filter.workshop ?? [];
    return legacyProducts.filter((p) => {
      if (
        selectedCategories.length > 0 &&
        !(
          p.poster_category != null &&
          selectedCategories.includes(p.poster_category.name)
        )
      ) {
        return false;
      }
      if (selectedUnits.length > 0 && !selectedUnits.includes(p.unit as Unit)) {
        return false;
      }
      if (selectedWorkshops.length > 0) {
        const key = p.workshop != null ? String(p.workshop.id) : WORKSHOP_NONE;
        if (!selectedWorkshops.includes(key)) {
          return false;
        }
      }
      if (!matchesSearch(`${p.name} ${p.sku ?? ''}`, search)) {
        return false;
      }
      return true;
    });
  }, [paginated, legacyProducts, filter, search]);

  // Legacy incremental-render window (only used in stock-aware mode).
  const [legacyVisibleCount, setLegacyVisibleCount] = useState(LEGACY_RENDER_BATCH);
  useEffect(() => {
    if (paginated) return;
    setLegacyVisibleCount(LEGACY_RENDER_BATCH);
  }, [paginated, legacyFiltered.length]);

  // ── UNIFIED VIEW MODEL ────────────────────────────────────────────────
  // Both modes resolve to the SAME downstream shape so the render tree (card
  // grid groups, mobile list, sentinel, states) is written once.
  const items: StockProduct[] = paginated
    ? (serverItems as StockProduct[])
    : legacyFiltered.slice(0, legacyVisibleCount);
  const total = paginated ? serverTotal : legacyFiltered.length;
  const isLoading = paginated ? isLoadingFirst : legacyLoading;
  const error = paginated ? serverError : legacyError;
  // Paginated: more pages remain on the server. Legacy: more rows to reveal.
  const hasMore = paginated
    ? items.length < total
    : legacyFiltered.length > items.length;

  // ── FILTER OPTIONS ────────────────────────────────────────────────────
  // Paginated: options come from the server FACETS (the page is partial, so
  // they CAN'T be derived from the loaded rows). Legacy: derive from the small
  // already-loaded set, as before.
  const categoryOptions = useMemo<FilterOption[]>(() => {
    if (paginated) {
      return facets.categories.map((c) => ({ value: c.value, label: c.label }));
    }
    const counts = new Map<string, number>();
    for (const p of legacyProducts) {
      const name = p.poster_category?.name;
      if (name == null) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0])))
      .map(([name]) => ({ value: name, label: name }));
  }, [paginated, facets.categories, legacyProducts]);

  const unitOptions = useMemo<FilterOption[]>(() => {
    if (paginated) {
      // Map the server's raw unit codes to their Uzbek labels, preserving the
      // canonical UNIT_OPTIONS order (kg · l · pcs) for any present unit.
      const present = new Set(facets.units);
      return UNIT_OPTIONS.filter((u) => present.has(u.value)).map((u) => ({
        value: u.value,
        label: u.label,
      }));
    }
    return UNIT_OPTIONS.map((u) => ({ value: u.value, label: u.label }));
  }, [paginated, facets.units]);

  // Workshop (sex) filter options — a leading "Sexsiz" pseudo-option so the
  // owner can isolate products with no assigned sex, then every workshop.
  // Source: server FACETS in paginated mode; the canonical workshops list in
  // legacy mode. Empty (read-only roles in legacy mode) → group omitted.
  const workshopOptions = useMemo<FilterOption[]>(() => {
    const rows = paginated ? facets.workshops : workshops;
    if (rows.length === 0) return [];
    return [
      { value: WORKSHOP_NONE, label: 'Sexsiz' },
      ...rows.map((w) => ({ value: String(w.id), label: w.name })),
    ];
  }, [paginated, facets.workshops, workshops]);

  const FILTER_GROUPS = useMemo<FilterGroup[]>(() => {
    const groups: FilterGroup[] = [
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
        options: unitOptions,
      },
    ];
    if (workshopOptions.length > 0) {
      groups.push({
        key: 'workshop',
        label: 'Sex',
        searchable: true,
        options: workshopOptions,
      });
    }
    return groups;
  }, [categoryOptions, unitOptions, workshopOptions]);

  // Per-tab counts for the type segmented control. In paginated mode the page
  // holds only a partial set, so a precise whole-catalogue count per tab is not
  // available client-side; the badge shows the server `total` for the ACTIVE
  // tab only (others render no badge). In legacy mode the tabs are hidden
  // (forcedType), so this is irrelevant there.
  const activeTabCount = paginated ? total : items.length;

  // ── CARD GROUPS (by Poster category) ──────────────────────────────────
  // Group the loaded products by their real Poster category. Products without
  // one fall into a trailing "Kategoriyasiz" group. Groups are sorted by
  // descending size (largest first), then by name; the null group is last.
  const cardGroups = useMemo(() => {
    const NULL_KEY = ' '; // sorts/identifies the "Kategoriyasiz" bucket
    const buckets = new Map<string, { name: string; items: StockProduct[] }>();
    for (const p of items) {
      const key = p.poster_category?.name ?? NULL_KEY;
      const name = p.poster_category?.name ?? 'Kategoriyasiz';
      const bucket = buckets.get(key);
      if (bucket) bucket.items.push(p);
      else buckets.set(key, { name, items: [p] });
    }
    return [...buckets.entries()]
      .map(([key, { name, items: groupItems }]) => ({ key, name, items: groupItems }))
      .sort((a, b) => {
        if (a.key === NULL_KEY) return 1;
        if (b.key === NULL_KEY) return -1;
        if (b.items.length !== a.items.length) {
          return b.items.length - a.items.length;
        }
        return a.name.localeCompare(b.name);
      });
  }, [items]);

  // ── INFINITE-SCROLL SENTINEL ──────────────────────────────────────────
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (el === null) return;
    const obs = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry === undefined || !entry.isIntersecting) return;
        if (paginated) {
          // Server pagination: fetch the next offset page when more remain and
          // nothing is in flight (refs hold the live counts so the observer
          // need not be re-created per append).
          if (isFetchingRef.current) return;
          if (loadedCountRef.current >= totalRef.current) return;
          void fetchPage(false);
        } else {
          // Legacy client window: just reveal more already-loaded rows.
          setLegacyVisibleCount((c) => c + LEGACY_RENDER_BATCH);
        }
      },
      { rootMargin: '400px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
    // Re-bind when the mode or the fetcher changes, or when the sentinel
    // toggles in/out via `hasMore` below (mount/unmount of the node).
  }, [paginated, fetchPage, hasMore]);

  return (
    <div className="mx-auto max-w-[120rem] space-y-6">
      <PageHeader
        title={title ?? 'Mahsulotlar'}
        description={
          description ?? 'Xom-ashyo, yarim tayyor va tayyor mahsulotlar.'
        }
      />

      {/* DESIGN §9 — TAB QATORI: compact segmented, left-aligned, own row. */}
      {!forcedType && (
        <div
          role="tablist"
          aria-label="Mahsulot turi"
          className="inline-flex flex-wrap items-center gap-1 self-start rounded-xl border border-border/70 bg-surface-1 p-1"
        >
        {TYPE_TABS.map((t) => {
          const active = typeTab === t.value;
          return (
            <Button
              key={t.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTypeTab(t.value)}
              variant="ghost"
              size="sm"
              className={cn(
                'rounded-lg text-sm',
                active
                  ? 'bg-primary/15 text-primary ring-1 ring-inset ring-primary/25 hover:bg-primary/15 hover:text-primary'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t.label}
              {/* Only the ACTIVE tab carries a count — in server-paginated mode
                  the page holds a partial set, so a per-tab whole-catalogue
                  count is not known client-side. Compact «· N» per DESIGN §8. */}
              {active && (
                <span className="text-xs tabular-nums text-primary/70">
                  · {activeTabCount}
                </span>
              )}
            </Button>
          );
        })}
      </div>
      )}

      {/* DESIGN §9 — FILTR QATORI: search + Filter right via ml-auto; the
          result count sits at the row's right edge (not a separate row). */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {!isLoading && !error && items.length > 0 && (
            <span className="text-sm text-muted-foreground tabular-nums">
              {items.length === total
                ? `${total} ta mahsulot`
                : `Ko‘rsatildi ${items.length} / ${total}`}
            </span>
          )}
          <div className="relative w-full sm:w-72">
            <Search
              className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Qidirish (lotin yoki kirill)…"
              aria-label="Mahsulot qidirish"
              className="pl-9 pr-9"
            />
            {search !== '' && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => setSearch('')}
                aria-label="Qidiruvni tozalash"
                className="absolute right-1.5 top-1.5 h-6 w-6 text-muted-foreground"
              >
                <X className="size-4" />
              </Button>
            )}
          </div>
          <FilterPopover groups={FILTER_GROUPS} value={filter} onApply={setFilter} />
        </div>
      </div>

      <Card
        className={
          !showMobileCards
            ? 'border-0 bg-transparent p-0 shadow-none'
            : undefined
        }
      >
        {isLoading && <ProductsPageSkeleton />}
        {!isLoading && error && (
          <ErrorState message={error} onRetry={refetchAll} />
        )}
        {!isLoading && !error && items.length === 0 && (
          <EmptyState message="Mahsulot topilmadi." />
        )}

        {!isLoading && !error && items.length > 0 && showMobileCards && (
          <MobileCardList
            items={items.map((p) => {
              const type = effectiveType(p);
              return {
                id: p.id,
                title: (
                  <span className="flex items-center gap-2.5">
                    <ProductThumbnail
                      src={p.image_url}
                      alt={p.name}
                      className="size-10"
                    />
                    <span className="truncate" title={p.name}>
                      {p.name}
                    </span>
                  </span>
                ),
                subtitle: (
                  <span className="flex flex-col gap-0.5">
                    {p.sku && <span>SKU: {p.sku}</span>}
                    <WorkshopLine
                      workshop={p.workshop}
                      edit={
                        canEditWorkshop &&
                        !showStock &&
                        (type === 'finished' || type === 'semi') &&
                        p.workshop != null ? (
                          <WorkshopPicker
                            productId={p.id}
                            currentWorkshopId={p.workshop.id}
                            workshops={workshops}
                            variant="compact"
                            onAssigned={onWorkshopAssigned}
                          />
                        ) : undefined
                      }
                    />
                    {canEditWorkshop &&
                      !showStock &&
                      (type === 'finished' || type === 'semi') &&
                      p.workshop == null && (
                        <span className="mt-1 inline-flex">
                          <WorkshopPicker
                            productId={p.id}
                            currentWorkshopId={null}
                            workshops={workshops}
                            variant="button"
                            onAssigned={onWorkshopAssigned}
                          />
                        </span>
                      )}
                  </span>
                ),
                badge: (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {/* «Yarim tayyor» section (showStock): drop the redundant
                        type badge; keep the retseptsiz warn. */}
                    {!showStock && (
                      <Badge variant={PRODUCT_CATEGORY_STYLE[type].badge}>
                        {PRODUCT_TYPE_LABELS[type]}
                      </Badge>
                    )}
                    {needsRecipeWarn(p) && <RecipelessBadge />}
                  </div>
                ),
                fields: [
                  { label: 'Birlik', value: UNIT_LABELS[p.unit] },
                  // «Qoldiq» (ostatka) — stock-aware section only; 0 is valid.
                  ...(showStock
                    ? [
                        {
                          label: 'Qoldiq',
                          value: (
                            <span className="tabular-nums">
                              {formatQty(p.qty)} {UNIT_LABELS[p.unit]}
                            </span>
                          ),
                        },
                      ]
                    : []),
                  {
                    label: 'Narx',
                    value: (
                      <span className="flex items-center gap-1.5">
                        <span className="tabular-nums">
                          {displayCost(p) != null
                            ? formatSom(displayCost(p) as number)
                            : '—'}
                        </span>
                        {type === 'raw'
                          ? p.manual_cost_per_unit != null && <ManualPriceBadge />
                          : <ComputedPriceHint />}
                      </span>
                    ),
                  },
                ],
                footer: (
                  <div className="flex flex-col gap-2">
                    {type !== 'raw' && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full"
                        onClick={() => openRecipe(p)}
                      >
                        <ScrollText className="size-4" aria-hidden="true" />
                        Retsept
                      </Button>
                    )}
                    {/* Only xom-ashyo (raw) price is editable. */}
                    {canEditCost && type === 'raw' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="w-full"
                        onClick={() => setCostProduct(p)}
                      >
                        <Pencil className="size-4" aria-hidden="true" />
                        Narxni tahrirlash
                      </Button>
                    )}
                  </div>
                ),
              };
            })}
          />
        )}

        {!isLoading &&
          !error &&
          items.length > 0 &&
          !showMobileCards && (
            <div className="space-y-8">
              {cardGroups.map((group) => (
                <section key={group.key} className="space-y-3">
                  <div className="flex items-center gap-2">
                    <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      {group.name}
                    </h2>
                    <Badge variant="secondary" className="tabular-nums">
                      {group.items.length}
                    </Badge>
                  </div>
                  <div className="grid grid-cols-1 items-stretch gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 min-[1920px]:grid-cols-6">
                    {group.items.map((p) => (
                      <ProductCard
                        key={p.id}
                        product={p}
                        stockQty={showStock ? p.qty : undefined}
                        // On a specific type tab every card IS that type —
                        // the badge is redundant; show it only on "Hammasi".
                        showTypeBadge={!showStock && typeTab === 'all'}
                        canEditWorkshop={canEditWorkshop && !showStock}
                        canEditCost={canEditCost}
                        workshops={workshops}
                        onOpenRecipe={openRecipe}
                        onEditCost={onEditCost}
                        onWorkshopAssigned={onWorkshopAssigned}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}

        {/* The scroll sentinel. Mounted whenever more rows remain (a server
            page to fetch, or legacy rows to reveal); the observer above grows
            the list as it enters the viewport. */}
        {!isLoading && !error && hasMore && (
          <div
            ref={sentinelRef}
            className="py-4 text-center text-xs text-muted-foreground"
          >
            {isLoadingMore ? 'Yana yuklanmoqda…' : ' '}
          </div>
        )}
      </Card>

      {canEditCost && costProduct && (
        <ProductCostDialog
          product={costProduct}
          open={costProduct !== null}
          onOpenChange={(open) => {
            if (!open) setCostProduct(null);
          }}
          onSaved={() => {
            refetchAll();
          }}
        />
      )}
    </div>
  );
}
