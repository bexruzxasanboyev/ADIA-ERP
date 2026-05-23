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
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from '@/components/PageState';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useAuth } from '@/hooks/useAuth';
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
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title="Mahsulotlar"
        description="Xom-ashyo, yarim tayyor va tayyor mahsulotlar."
        action={
          canCreate ? (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" aria-hidden="true" />
              Yangi mahsulot
            </Button>
          ) : undefined
        }
      />

      <div className="flex items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="type-filter">Tur bo‘yicha</Label>
          <Select
            id="type-filter"
            className="w-52"
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

      <Card>
        {isLoading && <LoadingState />}
        {!isLoading && error && (
          <ErrorState message={error} onRetry={refetch} />
        )}
        {!isLoading && !error && products.length === 0 && (
          <EmptyState message="Mahsulotlar topilmadi." />
        )}
        {!isLoading && !error && products.length > 0 && (
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
