import { useState } from 'react';
import { Plus, ScrollText } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
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
import { PRODUCT_TYPE_LABELS, UNIT_LABELS } from '@/lib/labels';
import type { Product, ProductType } from '@/lib/types';
import { ProductFormDialog } from './ProductFormDialog';
import { RecipeDialog } from './RecipeDialog';

type TypeFilter = ProductType | 'all';

const TYPE_FILTER_OPTIONS: { value: TypeFilter; label: string }[] = [
  { value: 'all', label: 'Barchasi' },
  { value: 'raw', label: PRODUCT_TYPE_LABELS.raw },
  { value: 'semi', label: PRODUCT_TYPE_LABELS.semi },
  { value: 'finished', label: PRODUCT_TYPE_LABELS.finished },
];

const TYPE_BADGE: Record<ProductType, 'outline' | 'default' | 'success'> = {
  raw: 'outline',
  semi: 'default',
  finished: 'success',
};

/**
 * M2 — products list with a `?type=` filter and an inline BOM editor.
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
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [recipeProduct, setRecipeProduct] = useState<Product | null>(null);

  // The `?type=` query param drives the backend filter directly (§4.3).
  const path =
    typeFilter === 'all'
      ? '/api/products'
      : `/api/products?type=${typeFilter}`;
  const { data, isLoading, error, refetch } = useApiQuery<Product[]>(path);
  // Unfiltered list for the recipe component picker.
  const allProducts = useApiQuery<Product[]>('/api/products');

  const products = data ?? [];

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

      <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-end">
        <div className="space-y-1">
          <Label htmlFor="type-filter">Tur bo‘yicha</Label>
          <Select
            id="type-filter"
            className="w-full sm:w-52"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as TypeFilter)}
          >
            {TYPE_FILTER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </Select>
        </div>
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
        {!isLoading && !error && products.length === 0 && (
          <EmptyState message="Mahsulotlar topilmadi." />
        )}
        {!isLoading && !error && products.length > 0 && showMobileCards && (
          <MobileCardList
            items={products.map((p) => ({
              id: p.id,
              title: p.name,
              subtitle: p.sku ?? undefined,
              badge: (
                <Badge variant={TYPE_BADGE[p.type]}>
                  {PRODUCT_TYPE_LABELS[p.type]}
                </Badge>
              ),
              fields: [
                { label: 'Birlik', value: UNIT_LABELS[p.unit] },
                { label: 'Turi', value: PRODUCT_TYPE_LABELS[p.type] },
              ],
              footer:
                p.type !== 'raw' ? (
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
            }))}
          />
        )}
        {!isLoading && !error && products.length > 0 && !showMobileCards && view === 'card' && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {products.map((p) => (
              <div
                key={p.id}
                className="flex flex-col gap-3 rounded-lg border border-border/60 bg-card/40 p-4 shadow-sm transition-colors hover:bg-card/70"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{p.name}</p>
                    {p.sku && (
                      <p className="truncate text-xs text-muted-foreground">
                        SKU: {p.sku}
                      </p>
                    )}
                  </div>
                  <Badge variant={TYPE_BADGE[p.type]}>
                    {PRODUCT_TYPE_LABELS[p.type]}
                  </Badge>
                </div>
                <dl className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <dt className="text-muted-foreground">Birlik</dt>
                    <dd>{UNIT_LABELS[p.unit]}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Holat</dt>
                    <dd>{p.is_active ? 'Faol' : 'Nofaol'}</dd>
                  </div>
                </dl>
                {p.type !== 'raw' && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={() => setRecipeProduct(p)}
                  >
                    <ScrollText className="size-4" aria-hidden="true" />
                    {canEditRecipe ? 'Retseptni tahrirlash' : 'Retseptni ko‘rish'}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
        {!isLoading && !error && products.length > 0 && !showMobileCards && view === 'table' && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nomi</TableHead>
                <TableHead>Turi</TableHead>
                <TableHead>Birlik</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead className="text-right">Retsept</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {products.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">{p.name}</TableCell>
                  <TableCell>
                    <Badge variant={TYPE_BADGE[p.type]}>
                      {PRODUCT_TYPE_LABELS[p.type]}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {UNIT_LABELS[p.unit]}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {p.sku ?? '—'}
                  </TableCell>
                  <TableCell className="text-right">
                    {p.type === 'raw' ? (
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
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {canCreate && (
        <ProductFormDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          onSaved={() => {
            refetch();
            allProducts.refetch();
          }}
        />
      )}

      <RecipeDialog
        open={recipeProduct !== null}
        onOpenChange={(open) => {
          if (!open) setRecipeProduct(null);
        }}
        product={recipeProduct}
        allProducts={allProducts.data ?? []}
        canEdit={canEditRecipe}
      />
    </div>
  );
}
