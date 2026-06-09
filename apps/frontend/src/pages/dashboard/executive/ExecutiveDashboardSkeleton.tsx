import { Card } from '@/components/ui/card';

/**
 * Initial-load placeholder for the executive dashboard.
 *
 * Replaces the old centred "Yuklanmoqda…" spinner (the owner disliked the
 * blank-then-pop loading flash). It mirrors the real page's section layout —
 * HeroStrip, the revenue/top-products two-up, the sales charts row, and the
 * action row — with shimmering bars so the layout is stable: when the real
 * data arrives the structure is already in place and nothing jumps.
 *
 * Shade + animation match the RevenueBreakdown / TopProducts in-card
 * skeletons (`bg-foreground/10` + `animate-pulse`) for visual consistency.
 * Each section that renders inside a Card in the real layout is wrapped in
 * the same `Card` here so spacing and borders line up exactly.
 */
export function ExecutiveDashboardSkeleton() {
  return (
    <div
      className="space-y-6"
      data-testid="executive-dashboard-skeleton"
      role="status"
      aria-busy="true"
    >
      <span className="sr-only">Yuklanmoqda</span>

      {/* 1 — HeroStrip: 4 KPI card placeholders. */}
      <div
        className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4"
        aria-hidden="true"
      >
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="animate-pulse space-y-4 p-5">
            {/* label bar */}
            <div className="h-3 w-24 rounded bg-foreground/10" />
            {/* large number bar */}
            <div className="h-8 w-32 rounded bg-foreground/10" />
            {/* tiny delta bar */}
            <div className="h-3 w-16 rounded bg-foreground/10" />
          </Card>
        ))}
      </div>

      {/* 2 — Two-up: revenue donut + legend | ranked top-products list. */}
      <div
        className="grid grid-cols-1 gap-4 xl:grid-cols-2"
        aria-hidden="true"
      >
        {/* LEFT — donut ring + ~5 legend rows (mirrors RevenueBreakdown). */}
        <Card className="space-y-4 p-5">
          <div className="space-y-2">
            <div className="h-3 w-32 rounded bg-foreground/10" />
            <div className="h-3 w-40 rounded bg-foreground/10" />
          </div>
          <div className="flex animate-pulse flex-col gap-8 sm:flex-row sm:items-center sm:gap-8">
            <div className="relative mx-auto h-[240px] w-[240px] shrink-0 sm:mx-0 lg:h-[260px] lg:w-[260px]">
              <div className="absolute inset-0 rounded-full bg-foreground/10" />
              <div className="absolute inset-[26%] rounded-full bg-card" />
            </div>
            <ul className="w-full flex-1 space-y-3.5">
              {Array.from({ length: 5 }).map((_, i) => (
                <li
                  key={i}
                  className="grid grid-cols-[1fr_auto_48px] items-center gap-x-4"
                >
                  <span className="flex items-center gap-2.5">
                    <span className="size-3 shrink-0 rounded-sm bg-foreground/10" />
                    <span className="h-4 w-20 rounded bg-foreground/10" />
                  </span>
                  <span className="ml-auto h-4 w-28 rounded bg-foreground/10" />
                  <span className="ml-auto h-3 w-9 rounded bg-foreground/10" />
                </li>
              ))}
            </ul>
          </div>
        </Card>

        {/* RIGHT — ranked list (mirrors TopProducts). */}
        <Card className="space-y-4 p-5">
          <div className="space-y-2">
            <div className="h-3 w-44 rounded bg-foreground/10" />
            <div className="h-3 w-24 rounded bg-foreground/10" />
          </div>
          <ul className="animate-pulse space-y-3.5">
            {Array.from({ length: 5 }).map((_, i) => (
              <li
                key={i}
                className="grid grid-cols-[2rem_1fr_auto] items-center gap-x-3"
              >
                <span className="size-7 rounded-full bg-foreground/10" />
                <span className="min-w-0 space-y-2">
                  <span className="flex items-center justify-between gap-2">
                    <span className="block h-4 w-32 rounded bg-foreground/10" />
                    <span className="block h-3 w-12 rounded bg-foreground/10" />
                  </span>
                  <span className="block h-2 w-full rounded-full bg-foreground/10" />
                </span>
                <span className="ml-auto block h-4 w-20 rounded bg-foreground/10" />
              </li>
            ))}
          </ul>
        </Card>
      </div>

      {/* 3 — Sales charts row: two wide chart-area placeholders. */}
      <div
        className="grid grid-cols-1 gap-4 lg:grid-cols-2"
        aria-hidden="true"
      >
        {Array.from({ length: 2 }).map((_, i) => (
          <Card key={i} className="animate-pulse space-y-4 p-5">
            <div className="h-3 w-36 rounded bg-foreground/10" />
            <div className="h-48 w-full rounded-lg bg-foreground/10" />
          </Card>
        ))}
      </div>

      {/* 4 — Action row: 3 cards (col-span 5 / 4 / 3) of list-row bars. */}
      <div
        className="grid gap-4 xl:grid-cols-12"
        aria-hidden="true"
      >
        {[
          'xl:col-span-5',
          'xl:col-span-4',
          'xl:col-span-3',
        ].map((span, i) => (
          <Card key={i} className={`animate-pulse space-y-4 p-5 ${span}`}>
            <div className="h-3 w-28 rounded bg-foreground/10" />
            <ul className="space-y-3">
              {Array.from({ length: 4 }).map((_, j) => (
                <li key={j} className="flex items-center gap-3">
                  <span className="size-8 shrink-0 rounded-full bg-foreground/10" />
                  <span className="flex-1 space-y-2">
                    <span className="block h-3.5 w-3/4 rounded bg-foreground/10" />
                    <span className="block h-3 w-1/2 rounded bg-foreground/10" />
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>
    </div>
  );
}
