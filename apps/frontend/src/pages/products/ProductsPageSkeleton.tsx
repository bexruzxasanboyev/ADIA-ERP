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
 *   2. A GRID of product-card-shaped placeholders matching the DENSE v2
 *      ProductCard: a header row (thumbnail + title/SKU | type badge), a
 *      sex line, the big Narx value row, and the quiet ghost-action foot.
 *      The grid columns + gap match the real catalogue grid
 *      (`sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5
 *      min-[1920px]:grid-cols-6`, `gap-3`) so the skeleton → data
 *      transition causes no layout jump.
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
        className="grid grid-cols-1 items-stretch gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 min-[1920px]:grid-cols-6"
        aria-hidden="true"
      >
        {Array.from({ length: count }).map((_, i) => (
          <Card
            key={i}
            className="flex h-full animate-pulse flex-col gap-2 border-border/60 bg-card/40 p-3"
          >
            {/* header: thumbnail + title/SKU | type badge */}
            <div className="flex items-start justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <div className="size-9 shrink-0 rounded-md bg-foreground/10" />
                <div className="min-w-0 space-y-1.5">
                  <div className="h-4 w-28 rounded bg-foreground/10" />
                  <div className="h-3 w-16 rounded bg-foreground/10" />
                </div>
              </div>
              <div className="h-5 w-16 shrink-0 rounded-full bg-foreground/10" />
            </div>

            {/* sex line */}
            <div className="h-3 w-24 rounded bg-foreground/10" />

            {/* Narx value row — big number | muted birlik */}
            <div className="mt-auto flex items-center justify-between gap-2 pt-0.5">
              <div className="h-5 w-24 rounded bg-foreground/10" />
              <div className="h-3 w-8 rounded bg-foreground/10" />
            </div>

            {/* foot — quiet ghost-action row */}
            <div className="h-6 w-28 rounded bg-foreground/10" />
          </Card>
        ))}
      </div>
    </div>
  );
}
