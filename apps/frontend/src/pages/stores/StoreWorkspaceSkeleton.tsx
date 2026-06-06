import { Card } from '@/components/ui/card';

/**
 * Initial-load placeholder for the Do'kon ish joyi ("Do'kon ish joyi")
 * workspace — its Dashboard tab, which is what the user lands on first.
 *
 * Replaces the old centred "Yuklanmoqda…" spinner (the owner disliked the
 * blank-then-pop loading flash). Mirrors the real Dashboard layout so the
 * structure is already in place when data arrives and nothing jumps:
 *   1. StoreStockDashboard — the 5 stock-status KPI cards.
 *   2. The "Holat bo'yicha taqsimot" status-distribution Card (title +
 *      ~4 horizontal status bars).
 *   3. StoreSalesAnalytics — the "Sotuv tahlili" header, its 4 sales KPI
 *      cards and the two sales-chart placeholders.
 *
 * Shade + animation match ExecutiveDashboardSkeleton (`bg-foreground/10` +
 * `animate-pulse`) for visual consistency, and each section that renders in a
 * Card in the real layout is wrapped in the same `Card` here so the spacing
 * and borders line up. Generic enough to serve both the single-store
 * (store_manager) and multi-store (pm) views.
 */
export function StoreWorkspaceSkeleton() {
  return (
    <div
      className="space-y-4"
      data-testid="store-workspace-skeleton"
      role="status"
      aria-busy="true"
    >
      <span className="sr-only">Yuklanmoqda</span>

      {/* 1 — Stock-status KPI strip: 5 cards (Umumiy / Min'dan past / Kam /
          Tugagan / Yetarli), matching StoreStockDashboard's KpiCard layout. */}
      <div
        className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5"
        aria-hidden="true"
      >
        {Array.from({ length: 5 }).map((_, i) => (
          <Card
            key={i}
            className="flex min-h-[140px] animate-pulse flex-col justify-between gap-3 border-border/60 p-5 sm:p-6"
          >
            {/* label bar + icon dot */}
            <div className="flex items-start justify-between gap-3">
              <div className="h-3 w-24 rounded bg-foreground/10" />
              <div className="size-6 shrink-0 rounded bg-foreground/10 sm:size-7" />
            </div>
            {/* big number bar */}
            <div className="h-9 w-20 rounded bg-foreground/10 sm:h-11" />
          </Card>
        ))}
      </div>

      {/* 2 — "Holat bo'yicha taqsimot": title bar + ~4 horizontal status bars
          of varying widths (mirrors StoreStockDashboard's bar chart). */}
      <Card className="animate-pulse space-y-4 p-5 sm:p-6" aria-hidden="true">
        <div className="flex items-baseline justify-between gap-3">
          <div className="space-y-2">
            <div className="h-3 w-40 rounded bg-foreground/10" />
            <div className="h-3 w-48 rounded bg-foreground/10" />
          </div>
          <div className="h-4 w-16 rounded bg-foreground/10" />
        </div>
        <div className="space-y-5 py-2">
          {['w-3/4', 'w-1/2', 'w-2/3', 'w-5/6'].map((w, i) => (
            <div key={i} className="grid grid-cols-[6.5rem_1fr] items-center gap-3">
              <div className="h-3 w-20 rounded bg-foreground/10" />
              <div className={`h-6 rounded bg-foreground/10 ${w}`} />
            </div>
          ))}
        </div>
      </Card>

      {/* 3 — "Sotuv tahlili": section header, 4 sales KPI cards and the two
          sales-chart placeholders (mirrors StoreSalesAnalytics). */}
      <div className="space-y-5 pt-1" aria-hidden="true">
        {/* header (title + subtitle | date filter) */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-2">
            <div className="h-4 w-28 rounded bg-foreground/10" />
            <div className="h-3 w-52 rounded bg-foreground/10" />
          </div>
          <div className="h-8 w-32 rounded bg-foreground/10" />
        </div>

        {/* 4 sales KPI cards (Bugungi savdo / Cheklar / O'rtacha chek / Do'konlar) */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card
              key={i}
              className="flex min-h-[120px] animate-pulse flex-col justify-between gap-3 border-border/60 p-5 sm:p-6"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="h-3 w-24 rounded bg-foreground/10" />
                <div className="size-6 shrink-0 rounded bg-foreground/10 sm:size-7" />
              </div>
              <div className="h-8 w-28 rounded bg-foreground/10 sm:h-9" />
            </Card>
          ))}
        </div>

        {/* two sales-chart placeholders (qty + revenue) */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <Card key={i} className="animate-pulse space-y-4 p-5 sm:p-6">
              <div className="space-y-2">
                <div className="h-4 w-40 rounded bg-foreground/10" />
                <div className="h-3 w-56 rounded bg-foreground/10" />
              </div>
              <div className="h-48 w-full rounded-lg bg-foreground/10" />
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
