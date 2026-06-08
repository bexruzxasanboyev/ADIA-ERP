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
import { useAuth } from '@/hooks/useAuth';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { PRODUCT_TYPE_LABELS, UNIT_LABELS, UNIT_OPTIONS } from '@/lib/labels';
import { matchesSearch } from '@/lib/translit';
import {
  PRODUCT_CATEGORY_STYLE,
  effectiveType,
  isResaleCategory,
} from '@/lib/productCategory';
import { formatSom } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { Location, Product, Unit } from '@/lib/types';
import { ProductCostDialog } from './ProductCostDialog';
import { ProductsPageSkeleton } from './ProductsPageSkeleton';
import { WorkshopPicker, type WorkshopOption } from './WorkshopPicker';

/**
 * The three filter dimensions all live inside the Filter popover now
 * (owner reversed the earlier "type tabs + category chips" layout). `type`
 * and `unit` are static option sets; `category` is derived per-render from
 * the loaded products — see FILTER_GROUPS in the component below.
 */

/** Filter popover default — nothing pre-selected (each group empty). */
const DEFAULT_FILTER: FilterValue = { category: [], unit: [], workshop: [] };

/**
 * Sentinel option value for the WORKSHOP filter that matches products with NO
 * assigned sex (`workshop == null`). A real workshop id can never collide with
 * it, so the `filtered` memo can branch on this string safely.
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

/** EPIC 1.4c — how many cards to mount per "scroll batch" (lazy render). */
const PAGE_SIZE = 24;

/** sessionStorage key — remembers the active type tab across navigation. */
const TYPE_TAB_KEY = 'products.typeTab';

/**
 * Small amber warn pill for a PRODUCED product that is missing its
 * Poster recipe (`has_recipe === false`). Light-mode-safe amber with a
 * `dark:` variant per the existing convention; resale/base items never
 * render this.
 */
function RecipelessBadge() {
  return (
    <span
      className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300"
      title="Bu mahsulot ishlab chiqariladi, lekin Posterda retsepti yo‘q"
    >
      <AlertTriangle className="size-3" aria-hidden="true" />
      Retseptsiz
    </span>
  );
}

/**
 * FEATURE A — small indigo pill marking a hand-entered (manual) price, so a
 * card with a manual override reads clearly as "not from Poster".
 */
function ManualPriceBadge() {
  return (
    <span
      className="inline-flex items-center whitespace-nowrap rounded-full border border-indigo-500/40 bg-indigo-500/10 px-2 py-0.5 text-[11px] font-medium text-indigo-700 dark:text-indigo-300"
      title="Narx qo‘lda kiritilgan (Poster narxidan emas)"
    >
      qo‘lda
    </span>
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
        'flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-border/60 bg-muted/40',
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

interface ProductCardProps {
  product: Product;
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
 * EPIC 1.5 — a single desktop catalogue card, wrapped in {@link memo}.
 *
 * Memoising the card is the key fix for the «slow catalogue» owner report:
 * the page mounts hundreds of cards and grows a lazy window (`visibleCount`)
 * on scroll. Without memo, every scroll-batch state bump re-rendered ALL
 * already-mounted cards. With stable callback props (the parent wraps its
 * handlers in `useCallback`), `memo`'s shallow prop compare lets a mounted
 * card skip re-render entirely when only the window counter changes — only
 * the newly-revealed cards render.
 */
const ProductCard = memo(function ProductCard({
  product: p,
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
  return (
    <div
      className={cn(
        'flex h-full flex-col gap-3 rounded-lg border border-l-4 border-border/60 bg-card/40 p-4 shadow-sm transition-colors hover:bg-card/70',
        style.accent,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2.5">
          <ProductThumbnail src={p.image_url} alt={p.name} className="size-11" />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold" title={p.name}>
              {p.name}
            </p>
            {p.sku && (
              <p className="truncate text-xs text-muted-foreground">
                SKU: {p.sku}
              </p>
            )}
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
              <div className="mt-1">
                <WorkshopPicker
                  productId={p.id}
                  currentWorkshopId={null}
                  workshops={workshops}
                  variant="button"
                  onAssigned={onWorkshopAssigned}
                />
              </div>
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Badge variant={style.badge} className="whitespace-nowrap">
            {PRODUCT_TYPE_LABELS[type]}
          </Badge>
          {needsRecipeWarn(p) && <RecipelessBadge />}
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <dt className="text-muted-foreground">Birlik</dt>
          <dd>{UNIT_LABELS[p.unit]}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground">Narx</dt>
          <dd className="flex items-center gap-1.5">
            <span className="truncate tabular-nums">
              {displayCost(p) != null
                ? formatSom(displayCost(p) as number)
                : '—'}
            </span>
            {type === 'raw' ? (
              p.manual_cost_per_unit != null && <ManualPriceBadge />
            ) : (
              <ComputedPriceHint />
            )}
          </dd>
        </div>
      </dl>
      {/* Narx (edit, RAW only) + Retsept (view, non-raw) side by side at the
          card foot. Only xom-ashyo price is editable; semi/finished show a
          read-only computed price (the «hisoblangan» hint above). */}
      {((canEditCost && type === 'raw') || type !== 'raw') && (
        <div className="mt-auto flex flex-wrap items-center gap-2">
          {canEditCost && type === 'raw' && (
            <Button
              variant="secondary"
              size="sm"
              className="h-8 flex-1"
              onClick={() => onEditCost(p)}
            >
              <Pencil className="size-3.5" aria-hidden="true" />
              Narx
            </Button>
          )}
          {type !== 'raw' && (
            <Button
              variant="outline"
              size="sm"
              className="h-8 flex-1"
              onClick={() => onOpenRecipe(p)}
            >
              <ScrollText className="size-4" aria-hidden="true" />
              Retseptni ko‘rish
            </Button>
          )}
        </div>
      )}
    </div>
  );
});

/**
 * M2 — products list. EPIC 1 redesign:
 *   1.1 a single multi-select filter popover carrying ALL three dimensions —
 *       Tur (type) · Kategoriya (searchable, derived) · Birlik (unit) — next
 *       to an always-visible translit-aware search box;
 *   1.2 translit-aware search (Latin ↔ Cyrillic);
 *   1.3 smart category badge (Г/П → finished, name → sub-category);
 *   1.4 category-grouped cards with colour-coding + incremental scroll;
 *   1.5 read-only recipe view on a dedicated page (see RecipePage); the
 *       "Retsept" buttons navigate to /products/:productId/recipe. Recipes
 *       are Poster-sourced and not edited in-app (owner decision), so the
 *       button is available to everyone who can view products.
 *
 * `pm` and `raw_warehouse_manager` may add products (§6).
 */
export function ProductsPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  // FEATURE A — only pm / production_manager may edit the manual cost. The
  // same gate governs assigning / changing a product's producing sex.
  const canEditCost =
    user?.role === 'pm' || user?.role === 'production_manager';
  const canEditWorkshop = canEditCost;

  // The product whose cost dialog is open (null = closed).
  const [costProduct, setCostProduct] = useState<Product | null>(null);

  const bp = useBreakpoint();
  const showMobileCards = bp === 'xs';
  const [filter, setFilter] = useState<FilterValue>(DEFAULT_FILTER);
  const [search, setSearch] = useState('');
  // Persist the active type tab so returning from the recipe page (or any
  // navigation) restores the tab the user was on — not a reset to "Hammasi".
  const [typeTab, setTypeTab] = useState<TypeTab>(() => {
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
    try {
      sessionStorage.setItem(TYPE_TAB_KEY, typeTab);
    } catch {
      // best-effort
    }
  }, [typeTab]);

  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // The recipe (BOM) opens as a dedicated, read-only page (not a modal).
  // Stable identities (useCallback) so the memoised ProductCard's props don't
  // change every render — that's what lets a mounted card skip re-render when
  // only the lazy `visibleCount` window grows (EPIC 1.5 perf fix).
  const openRecipe = useCallback(
    (p: Product) => navigate(`/products/${p.id}/recipe`),
    [navigate],
  );

  // The full list is fetched once (the backend `?type=` filter is replaced by
  // richer client-side filtering: multi-type, unit, and translit search).
  const { data, isLoading, error, refetch } =
    useApiQuery<Product[]>('/api/products');
  const onWorkshopAssigned = useCallback(() => refetch(), [refetch]);
  const onEditCost = useCallback((p: Product) => setCostProduct(p), []);

  // Production workshops (sexes) for the workshop FILTER dimension and the
  // inline sex-assign picker. pm + production_manager are authorised for this
  // endpoint; for any other (read-only) role the query is skipped (`null`) and
  // the workshop filter group / assign control simply don't appear.
  const { data: workshopData } = useApiQuery<Location[]>(
    canEditWorkshop ? '/api/locations?type=production' : null,
  );
  const workshops = useMemo<WorkshopOption[]>(() => {
    const rows = workshopData ?? [];
    return rows
      .map((l) => ({ id: l.id, name: l.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [workshopData]);

  // `useApiQuery` returns a stable `data` reference between renders, so memoise
  // on `data` itself (not a freshly-allocated `data ?? []`) to keep the
  // dependency arrays below honest.
  const allProducts = useMemo(() => data ?? [], [data]);

  // Per-tab counts for the type segmented control badges (whole catalogue).
  const typeCounts = useMemo(() => {
    const c: Record<TypeTab, number> = {
      all: allProducts.length,
      finished: 0,
      semi: 0,
      raw: 0,
    };
    for (const p of allProducts) c[effectiveType(p)] += 1;
    return c;
  }, [allProducts]);

  // Distinct Poster categories ACROSS all products, sorted by descending
  // product count (most-populated first), then by name. Value === label ===
  // the raw category name so the `filtered` memo can match on it directly.
  const categoryOptions = useMemo<FilterOption[]>(() => {
    const counts = new Map<string, number>();
    for (const p of allProducts) {
      const name = p.poster_category?.name;
      if (name == null) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) =>
        b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0]),
      )
      .map(([name]) => ({ value: name, label: name }));
  }, [allProducts]);

  // The single Filter popover now carries all three dimensions, in order:
  // Tur (type), Kategoriya (searchable, derived), Birlik (unit). The popover
  // renders them as tabs and turns the category list into a searchable
  // multi-select automatically (>6 options or `searchable`).
  // Workshop (sex) filter options — every production workshop plus a leading
  // "Sexsiz" pseudo-option so the owner can isolate products with no assigned
  // sex. Only shown when the workshops list loaded (editors); for read-only
  // roles the group is omitted entirely.
  const workshopOptions = useMemo<FilterOption[]>(() => {
    if (workshops.length === 0) return [];
    return [
      { value: WORKSHOP_NONE, label: 'Sexsiz' },
      ...workshops.map((w) => ({ value: String(w.id), label: w.name })),
    ];
  }, [workshops]);

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
        options: UNIT_OPTIONS.map((u) => ({ value: u.value, label: u.label })),
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
  }, [categoryOptions, workshopOptions]);

  const filtered = useMemo(() => {
    const selectedCategories = filter.category ?? [];
    const selectedUnits = filter.unit ?? [];
    const selectedWorkshops = filter.workshop ?? [];
    return allProducts.filter((p) => {
      // EPIC 1.3 — Г/П-prefixed products are treated as finished.
      if (typeTab !== 'all' && effectiveType(p) !== typeTab) {
        return false;
      }
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
        // "Sexsiz" matches a null workshop; otherwise match the assigned id.
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
  }, [allProducts, filter, search, typeTab]);

  // EPIC 1.4c — incremental rendering. Reset the window whenever the result
  // set changes so a fresh filter never starts mid-list.
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [filtered.length]);

  const visible = filtered.slice(0, visibleCount);
  const hasMore = visible.length < filtered.length;

  // Group the currently-visible products by their real Poster category.
  // Products without one fall into a trailing "Kategoriyasiz" group.
  // Grouping the *windowed* slice (not the full list) keeps the incremental
  // scroll batching honest — a half-loaded category simply shows fewer cards.
  // Groups are sorted by descending product count (largest first), then by
  // name for a stable order; the null group is always pinned last.
  const cardGroups = useMemo(() => {
    const NULL_KEY = ' '; // sorts/identifies the "Kategoriyasiz" bucket
    const buckets = new Map<string, { name: string; items: Product[] }>();
    for (const p of filtered) {
      const key = p.poster_category?.name ?? NULL_KEY;
      const name = p.poster_category?.name ?? 'Kategoriyasiz';
      const bucket = buckets.get(key);
      if (bucket) bucket.items.push(p);
      else buckets.set(key, { name, items: [p] });
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
  }, [filtered]);

  // Apply the incremental window ACROSS the stable group order: walk groups in
  // order and hand out `visibleCount` cards in total. Each group keeps its
  // full `total` for the header badge; only the number of cards rendered grows
  // as the sentinel scrolls into view — groups never re-order or reshuffle.
  const visibleGroups = useMemo(() => {
    let budget = visibleCount;
    const out: {
      key: string;
      name: string;
      total: number;
      items: Product[];
    }[] = [];
    for (const g of cardGroups) {
      if (budget <= 0) break;
      const items = g.items.slice(0, budget);
      budget -= items.length;
      out.push({ key: g.key, name: g.name, total: g.items.length, items });
    }
    return out;
  }, [cardGroups, visibleCount]);

  // Infinite-scroll sentinel — grows the window as it scrolls into view.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!hasMore) return;
    const el = sentinelRef.current;
    if (el === null) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisibleCount((c) => c + PAGE_SIZE);
        }
      },
      { rootMargin: '400px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [hasMore, visible.length]);

  return (
    <div className="mx-auto max-w-[120rem] space-y-6">
      <PageHeader
        title="Mahsulotlar"
        description="Xom-ashyo, yarim tayyor va tayyor mahsulotlar."
      />

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div
          role="tablist"
          aria-label="Mahsulot turi"
          className="inline-flex flex-wrap items-center gap-1 self-start rounded-lg border border-border bg-card p-1"
        >
        {TYPE_TABS.map((t) => {
          const active = typeTab === t.value;
          return (
            <button
              key={t.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTypeTab(t.value)}
              className={cn(
                'inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                active
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              {t.label}
              <span
                className={cn(
                  'rounded-full px-1.5 text-xs tabular-nums',
                  active ? 'bg-primary-foreground/20' : 'bg-muted',
                )}
              >
                {typeCounts[t.value]}
              </span>
            </button>
          );
        })}
      </div>

        <div className="flex items-center gap-3">
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
            <button
              type="button"
              onClick={() => setSearch('')}
              aria-label="Qidiruvni tozalash"
              className="absolute right-2 top-2 rounded-md p-1 text-muted-foreground hover:bg-accent"
            >
              <X className="size-4" />
            </button>
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
          <ErrorState message={error} onRetry={refetch} />
        )}
        {!isLoading && !error && filtered.length === 0 && (
          <EmptyState message="Mahsulotlar topilmadi." />
        )}

        {!isLoading && !error && filtered.length > 0 && showMobileCards && (
          <MobileCardList
            items={visible.map((p) => {
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
                    <Badge variant={PRODUCT_CATEGORY_STYLE[type].badge}>
                      {PRODUCT_TYPE_LABELS[type]}
                    </Badge>
                    {needsRecipeWarn(p) && <RecipelessBadge />}
                  </div>
                ),
                fields: [
                  { label: 'Birlik', value: UNIT_LABELS[p.unit] },
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
          filtered.length > 0 &&
          !showMobileCards && (
            <div className="space-y-8">
              {visibleGroups.map((group) => (
                <section key={group.key} className="space-y-3">
                  <div className="flex items-center gap-2">
                    <h2 className="text-xs uppercase tracking-wide text-muted-foreground">
                      {group.name}
                    </h2>
                    <Badge variant="outline" className="tabular-nums">
                      {group.total}
                    </Badge>
                  </div>
                  <div className="grid grid-cols-1 items-stretch gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                    {group.items.map((p) => (
                      <ProductCard
                        key={p.id}
                        product={p}
                        canEditWorkshop={canEditWorkshop}
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

        {!isLoading && !error && hasMore && (
          <div
            ref={sentinelRef}
            className="py-4 text-center text-xs text-muted-foreground"
          >
            Yana yuklanmoqda…
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
            refetch();
          }}
        />
      )}
    </div>
  );
}
