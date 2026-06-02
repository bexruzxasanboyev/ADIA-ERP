import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Inbox } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from '@/components/PageState';
import { useApiQuery } from '@/hooks/useApiQuery';
import { apiRequest, ApiError } from '@/lib/api-client';
import { PRODUCT_TYPE_LABELS } from '@/lib/labels';
import { effectiveType, isResaleCategory } from '@/lib/productCategory';
import type { Product, RecipeNode, RecipeResponse } from '@/lib/types';
import { PRODUCT_TYPE_BADGE, RecipeBreakdown } from './RecipeTreeView';

/**
 * View a product's recipe (BOM) as a dedicated, READ-ONLY page.
 *
 * Recipes are sourced exclusively from Poster (owner decision) — there is no
 * in-app editor. Loads `GET /api/products/:id/recipe` and renders the nested,
 * recipe-book breakdown. The product's name/type/unit come from the shared
 * `GET /api/products` list (same source ProductsPage uses), found by id.
 *
 * Empty-state is smart: a PRODUCED product (not a resale category) with no
 * recipe shows a WARNING ("Posterda kiritilishi kerak"); a resale/base item
 * shows a NEUTRAL "Sotib olinadigan mahsulot — retseptsiz." with no alarm.
 */
export function RecipePage() {
  const { productId } = useParams<{ productId: string }>();

  // Product name/type/unit/category come from the shared products list — the
  // same source ProductsPage reads — found by id. No detail endpoint invented.
  const productsQuery = useApiQuery<Product[]>('/api/products');
  const numericId = Number(productId);
  const validId = productId !== undefined && Number.isInteger(numericId);
  const allProducts = useMemo(
    () => productsQuery.data ?? [],
    [productsQuery.data],
  );
  const product = useMemo(
    () => allProducts.find((p) => p.id === numericId) ?? null,
    [allProducts, numericId],
  );

  const [tree, setTree] = useState<RecipeNode[]>([]);
  const [totalCost, setTotalCost] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!validId) {
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    setLoadError(null);

    apiRequest<RecipeResponse>(`/api/products/${numericId}/recipe`)
      .then((data) => {
        if (cancelled) return;
        setTree(data.tree ?? []);
        setTotalCost(data.total_cost ?? null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(
          err instanceof ApiError ? err.message : 'Retseptni yuklab bo‘lmadi.',
        );
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [validId, numericId, reloadKey]);

  const productType = product ? effectiveType(product) : null;

  // A PRODUCED product (not a resale category, not raw) is expected to carry a
  // Poster recipe — an empty tree means it is missing and should be flagged.
  // A resale/base item legitimately has none → neutral.
  const isResale = isResaleCategory(product?.poster_category?.name ?? null);
  const isProduced = product != null && !isResale && productType !== 'raw';

  const header = (
    <PageHeader
      title={product ? `Retsept — ${product.name}` : 'Retsept'}
      description="1 birlik mahsulot uchun tarkib (BOM) — Posterdan olinadi, faqat ko‘rish uchun. Yarim tayyor komponentlar ochiladi, har qator tannarxi va umumiy tannarx ko‘rsatiladi."
    />
  );

  const backLink = (
    <Link
      to="/products"
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-testid="recipe-back"
    >
      <ArrowLeft className="size-4" aria-hidden="true" />
      Mahsulotlarga
    </Link>
  );

  // Invalid :productId — bail before any fetch.
  if (!validId) {
    return (
      <div className="mx-auto max-w-[1600px] space-y-4">
        {backLink}
        <Card className="p-6">
          <EmptyState message="Mahsulot topilmadi." />
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1600px] space-y-6">
      {backLink}

      <div className="flex flex-wrap items-start justify-between gap-3">
        {header}
        {productType && (
          <Badge variant={PRODUCT_TYPE_BADGE[productType]} className="shrink-0">
            {PRODUCT_TYPE_LABELS[productType]}
          </Badge>
        )}
      </div>

      {(isLoading || productsQuery.isLoading) && <LoadingState />}

      {!isLoading && loadError && (
        <ErrorState
          message={loadError}
          onRetry={() => setReloadKey((k) => k + 1)}
        />
      )}

      {!isLoading && !loadError && (
        <Card className="space-y-5 p-5 sm:p-6">
          {tree.length === 0 ? (
            isProduced ? (
              <div
                className="flex flex-col items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 py-12 text-center"
                role="alert"
              >
                <AlertTriangle
                  className="size-6 text-amber-600 dark:text-amber-400"
                  aria-hidden="true"
                />
                <p className="text-sm font-medium text-amber-700 dark:text-amber-300">
                  Retsept yo‘q — Posterda kiritilishi kerak.
                </p>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2 py-12 text-center">
                <Inbox
                  className="size-6 text-muted-foreground"
                  aria-hidden="true"
                />
                <p className="text-sm text-muted-foreground">
                  Sotib olinadigan mahsulot — retseptsiz.
                </p>
              </div>
            )
          ) : (
            <RecipeBreakdown
              tree={tree}
              totalCost={totalCost}
              unit={product?.unit ?? null}
              productName={product?.name ?? 'Mahsulot'}
            />
          )}
        </Card>
      )}
    </div>
  );
}
