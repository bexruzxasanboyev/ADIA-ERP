import { Card } from '@/components/ui/card';

/**
 * Initial-load placeholder for the Mahsulotlar (products) catalogue.
 *
 * Replaces the centred "Yuklanmoqda…" spinner (`LoadingState`) the owner
 * disliked, following the same skeleton convention as
 * ExecutiveDashboardSkeleton / StoreWorkspaceSkeleton: plain bars shaded
 * `bg-foreground/10` with `animate-pulse`, no shared primitive needed.
 *
 * Mirrors the real ProductsPage layout so nothing jumps when data arrives:
 *   1. A category section header (label bar + count badge).
 *   2. A GRID of product-card-shaped placeholders matching ProductCard:
 *      a header row (thumbnail + title/SKU/sex lines | type badge), the
 *      two-column Birlik / Narx block, and the foot "Retseptni ko'rish"
 *      button area. The grid columns + gap match the real catalogue grid
 *      (`sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5`,
 *      `gap-3`) so the skeleton → data transition causes no layout jump.
 *
 * `count` cards are rendered (default 10, within the requested 8–12). On the
 * mobile breakpoint the same cards simply stack one-per-row via the grid's
 * `grid-cols-1` base, giving the sensible stacked-card skeleton.
 */
export function ProductsPageSkeleton({ count = 10 }: { count?: number }) {
  return (
    <div
      className="space-y-3"
      data-testid="products-page-skeleton"
      role="status"
      aria-busy="true"
    >
      <span className="sr-only">Yuklanmoqda</span>

      {/* Category section header — label bar + count badge (mirrors the real
          <h2> + <Badge> row). */}
      <div className="flex items-center gap-2" aria-hidden="true">
        <div className="h-3 w-32 animate-pulse rounded bg-foreground/10" />
        <div className="h-5 w-8 animate-pulse rounded-full bg-foreground/10" />
      </div>

      {/* Card grid — identical columns/gap to the real catalogue so there is
          no reflow when the products load in. */}
      <div
        className="grid grid-cols-1 items-stretch gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5"
        aria-hidden="true"
      >
        {Array.from({ length: count }).map((_, i) => (
          <Card
            key={i}
            className="flex h-full animate-pulse flex-col gap-3 border-border/60 bg-card/40 p-4"
          >
            {/* header: thumbnail + title/SKU/sex lines | type badge */}
            <div className="flex items-start justify-between gap-2">
              <div className="flex min-w-0 items-start gap-2.5">
                <div className="size-11 shrink-0 rounded-md bg-foreground/10" />
                <div className="min-w-0 space-y-1.5">
                  <div className="h-4 w-28 rounded bg-foreground/10" />
                  <div className="h-3 w-16 rounded bg-foreground/10" />
                  <div className="h-3 w-20 rounded bg-foreground/10" />
                </div>
              </div>
              <div className="h-5 w-16 shrink-0 rounded-full bg-foreground/10" />
            </div>

            {/* Birlik / Narx two-column block */}
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <div className="h-3 w-10 rounded bg-foreground/10" />
                <div className="h-3 w-12 rounded bg-foreground/10" />
              </div>
              <div className="space-y-1.5">
                <div className="h-3 w-10 rounded bg-foreground/10" />
                <div className="h-3 w-16 rounded bg-foreground/10" />
              </div>
            </div>

            {/* foot — "Retseptni ko'rish" button area */}
            <div className="mt-auto h-8 w-full rounded bg-foreground/10" />
          </Card>
        ))}
      </div>
    </div>
  );
}
