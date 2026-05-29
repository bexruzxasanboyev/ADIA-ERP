import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, ScrollText, Search, X } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  FilterPopover,
  type FilterGroup,
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
import { MobileCardList } from '@/components/ui/table-mobile';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from '@/components/PageState';
import { ViewToggle, useViewMode } from '@/components/ViewToggle';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useAuth } from '@/hooks/useAuth';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { PRODUCT_TYPE_LABELS, UNIT_LABELS, UNIT_OPTIONS } from '@/lib/labels';
import { matchesSearch } from '@/lib/translit';
import {
  PRODUCT_CATEGORY_LABELS,
  PRODUCT_CATEGORY_STYLE,
  deriveCategory,
  effectiveType,
} from '@/lib/productCategory';
import { cn } from '@/lib/utils';
import type { Product, Unit } from '@/lib/types';
import { ProductFormDialog } from './ProductFormDialog';
import { RecipeDialog } from './RecipeDialog';

/** EPIC 1.1 — the two filter dimensions of the products module. */
const FILTER_GROUPS: FilterGroup[] = [
  {
    key: 'type',
    label: 'Mahsulot turi',
    searchable: false,
    options: [
      { value: 'raw', label: PRODUCT_TYPE_LABELS.raw },
      { value: 'semi', label: PRODUCT_TYPE_LABELS.semi },
      { value: 'finished', label: PRODUCT_TYPE_LABELS.finished },
    ],
  },
  {
    key: 'unit',
    label: 'O‘lchov birligi',
    searchable: false,
    options: UNIT_OPTIONS.map((u) => ({ value: u.value, label: u.label })),
  },
];

/** EPIC 1.4b — default filter pre-selects "Tayyor mahsulot". */
const DEFAULT_FILTER: FilterValue = { type: ['finished'], unit: [] };

/** EPIC 1.4c — how many cards to mount per "scroll batch" (lazy render). */
const PAGE_SIZE = 24;

/**
 * M2 — products list. EPIC 1 redesign:
 *   1.1 custom multi-select filter popover (type + unit);
 *   1.2 translit-aware search (Latin ↔ Cyrillic);
 *   1.3 smart category badge (Г/П → finished, name → sub-category);
 *   1.4 default = finished, category colour-coding, incremental scroll;
 *   1.5 staged BOM modal (see RecipeDialog).
 *
 * `pm` and `raw_warehouse_manager` may add products; `pm` and
 * `production_manager` may edit recipes (§6).
 */
export function ProductsPage() {
  const { user } = useAuth();
  const canCreate =
    user?.role === 'pm' || user?.role === 'raw_warehouse_manager';
  const canEditRecipe =
    user?.role === 'pm' || user?.role === 'production_manager';

  const bp = useBreakpoint();
  const showMobileCards = bp === 'xs';
  const [view, setView] = useViewMode('products', 'card');
  const [filter, setFilter] = useState<FilterValue>(DEFAULT_FILTER);
  const [search, setSearch] = useState('');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [createOpen, setCreateOpen] = useState(false);
  const [recipeProduct, setRecipeProduct] = useState<Product | null>(null);

  // The full list is fetched once (the backend `?type=` filter is replaced by
  // richer client-side filtering: multi-type, unit, and translit search).
  const { data, isLoading, error, refetch } =
    useApiQuery<Product[]>('/api/products');

  // `useApiQuery` returns a stable `data` reference between renders, so memoise
  // on `data` itself (not a freshly-allocated `data ?? []`) to keep the
  // dependency arrays below honest.
  const allProducts = useMemo(() => data ?? [], [data]);

  const filtered = useMemo(() => {
    const selectedTypes = filter.type ?? [];
    const selectedUnits = filter.unit ?? [];
    return allProducts.filter((p) => {
      // EPIC 1.3 — Г/П-prefixed products are treated as finished.
      const type = effectiveType(p);
      if (selectedTypes.length > 0 && !selectedTypes.includes(type)) {
        return false;
      }
      if (selectedUnits.length > 0 && !selectedUnits.includes(p.unit as Unit)) {
        return false;
      }
      if (!matchesSearch(`${p.name} ${p.sku ?? ''}`, search)) {
        return false;
      }
      return true;
    });
  }, [allProducts, filter, search]);

  // EPIC 1.4c — incremental rendering. Reset the window whenever the result
  // set changes so a fresh filter never starts mid-list.
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [filtered.length]);

  const visible = filtered.slice(0, visibleCount);
  const hasMore = visible.length < filtered.length;

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
        action={
          <div className="flex flex-wrap items-center gap-2">
            <ViewToggle value={view} onChange={setView} />
            {canCreate && (
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="size-4" aria-hidden="true" />
                Yangi mahsulot
              </Button>
            )}
          </div>
        }
      />

      <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1 sm:max-w-md">
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
        <p
          className="text-sm text-muted-foreground sm:ml-auto"
          aria-live="polite"
        >
          <span>{`${filtered.length} ta mahsulot`}</span>
        </p>
      </div>

      <Card
        className={
          view === 'card' && !showMobileCards
            ? 'border-0 bg-transparent p-0 shadow-none'
            : undefined
        }
      >
        {isLoading && <LoadingState />}
        {!isLoading && error && (
          <ErrorState message={error} onRetry={refetch} />
        )}
        {!isLoading && !error && filtered.length === 0 && (
          <EmptyState message="Mahsulotlar topilmadi." />
        )}

        {!isLoading && !error && filtered.length > 0 && showMobileCards && (
          <MobileCardList
            items={visible.map((p) => {
              const category = deriveCategory(p);
              return {
                id: p.id,
                title: p.name,
                subtitle: p.sku ?? undefined,
                badge: (
                  <Badge variant={PRODUCT_CATEGORY_STYLE[category].badge}>
                    {PRODUCT_CATEGORY_LABELS[category]}
                  </Badge>
                ),
                fields: [
                  { label: 'Birlik', value: UNIT_LABELS[p.unit] },
                  { label: 'Turi', value: PRODUCT_TYPE_LABELS[effectiveType(p)] },
                ],
                footer:
                  effectiveType(p) !== 'raw' ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full"
                      onClick={() => setRecipeProduct(p)}
                    >
                      <ScrollText className="size-4" aria-hidden="true" />
                      {canEditRecipe ? 'Retseptni tahrirlash' : 'Retsept'}
                    </Button>
                  ) : undefined,
              };
            })}
          />
        )}

        {!isLoading &&
          !error &&
          filtered.length > 0 &&
          !showMobileCards &&
          view === 'card' && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {visible.map((p) => {
                const category = deriveCategory(p);
                const style = PRODUCT_CATEGORY_STYLE[category];
                return (
                  <div
                    key={p.id}
                    className={cn(
                      'flex flex-col gap-3 rounded-lg border border-l-4 border-border/60 bg-card/40 p-4 shadow-sm transition-colors hover:bg-card/70',
                      style.accent,
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold">
                          {p.name}
                        </p>
                        {p.sku && (
                          <p className="truncate text-xs text-muted-foreground">
                            SKU: {p.sku}
                          </p>
                        )}
                      </div>
                      <Badge variant={style.badge}>
                        {PRODUCT_CATEGORY_LABELS[category]}
                      </Badge>
                    </div>
                    <dl className="grid grid-cols-2 gap-2 text-xs">
                      <div>
                        <dt className="text-muted-foreground">Birlik</dt>
                        <dd>{UNIT_LABELS[p.unit]}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Turi</dt>
                        <dd>{PRODUCT_TYPE_LABELS[effectiveType(p)]}</dd>
                      </div>
                    </dl>
                    {effectiveType(p) !== 'raw' && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full"
                        onClick={() => setRecipeProduct(p)}
                      >
                        <ScrollText className="size-4" aria-hidden="true" />
                        {canEditRecipe
                          ? 'Retseptni tahrirlash'
                          : 'Retseptni ko‘rish'}
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

        {!isLoading &&
          !error &&
          filtered.length > 0 &&
          !showMobileCards &&
          view === 'table' && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nomi</TableHead>
                  <TableHead>Turkum</TableHead>
                  <TableHead>Turi</TableHead>
                  <TableHead>Birlik</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead className="text-right">Retsept</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((p) => {
                  const category = deriveCategory(p);
                  return (
                    <TableRow key={p.id}>
                      <TableCell className="font-medium">{p.name}</TableCell>
                      <TableCell>
                        <Badge variant={PRODUCT_CATEGORY_STYLE[category].badge}>
                          {PRODUCT_CATEGORY_LABELS[category]}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {PRODUCT_TYPE_LABELS[effectiveType(p)]}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {UNIT_LABELS[p.unit]}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {p.sku ?? '—'}
                      </TableCell>
                      <TableCell className="text-right">
                        {effectiveType(p) === 'raw' ? (
                          <span className="text-xs text-muted-foreground">
                            —
                          </span>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setRecipeProduct(p)}
                          >
                            <ScrollText className="size-4" aria-hidden="true" />
                            {canEditRecipe ? 'Tahrirlash' : 'Ko‘rish'}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
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

      {canCreate && (
        <ProductFormDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          onSaved={() => {
            refetch();
          }}
        />
      )}

      <RecipeDialog
        open={recipeProduct !== null}
        onOpenChange={(open) => {
          if (!open) setRecipeProduct(null);
        }}
        product={recipeProduct}
        allProducts={allProducts}
        canEdit={canEditRecipe}
      />
    </div>
  );
}
