import { useEffect, useMemo, useState } from 'react';
import {
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Sector,
  type PieProps,
} from 'recharts';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/PageState';
import { formatPlainNumber } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Markaziy sklad — "Kategoriya bo'yicha mahsulot" donut (owner feedback #12).
 *
 * Shows how many distinct FINISHED products the central warehouse holds per
 * Poster category (e.g. "Печёное 26 · Торты 22 · …"). Mirrors the visual
 * language of `StoreRequestsStatusDonut` / RevenueBreakdown — donut on the
 * left, a legend with count + share on the right, the grand total in the
 * centre. Pure presentation: the caller passes the already-computed per-
 * category counts (derived from finished central stock + product categories).
 */

export interface CategorySlice {
  /** Stable key — the category name (or a sentinel for "Kategoriyasiz"). */
  key: string;
  /** Display label (Poster category name, Russian). */
  label: string;
  /** Number of distinct finished products in this category. */
  value: number;
}

// A fixed, high-contrast palette cycled across categories. Literal hsl values
// (not CSS vars) so the colours resolve identically in jsdom + the dark theme,
// matching the project's other donuts.
const PALETTE = [
  'hsl(152 60% 48%)', // emerald
  'hsl(217 91% 60%)', // blue
  'hsl(38 92% 55%)', // amber
  'hsl(280 65% 62%)', // violet
  'hsl(0 72% 58%)', // red
  'hsl(174 62% 47%)', // teal
  'hsl(330 75% 60%)', // pink
  'hsl(24 90% 55%)', // orange
  'hsl(199 89% 56%)', // sky
  'hsl(45 93% 52%)', // yellow
  'hsl(258 70% 66%)', // indigo
  'hsl(122 45% 52%)', // green
];

function colourAt(index: number): string {
  return PALETTE[index % PALETTE.length] as string;
}

function formatPct(part: number, total: number): string {
  if (total <= 0 || !Number.isFinite(part)) return '0%';
  const pct = (part / total) * 100;
  return `${pct >= 10 ? Math.round(pct) : pct.toFixed(1)}%`;
}

const renderActiveSector: PieProps['activeShape'] = (props: unknown) => {
  const p = props as {
    cx: number;
    cy: number;
    innerRadius: number;
    outerRadius: number;
    startAngle: number;
    endAngle: number;
    fill: string;
  };
  return (
    <Sector
      cx={p.cx}
      cy={p.cy}
      innerRadius={p.innerRadius}
      outerRadius={p.outerRadius}
      startAngle={p.startAngle}
      endAngle={p.endAngle}
      fill={p.fill}
      stroke="hsl(0 0% 100% / 0.9)"
      strokeWidth={2.5}
    />
  );
};

interface ColouredSlice extends CategorySlice {
  colour: string;
}

export function CentralCategoryDonut({
  categories,
  className,
}: {
  /** Per-category distinct finished-product counts (descending by value). */
  categories: CategorySlice[];
  className?: string;
}) {
  // Stable, descending order; assign a palette colour per row.
  const legendRows = useMemo<ColouredSlice[]>(
    () =>
      [...categories]
        .sort((a, b) =>
          b.value !== a.value ? b.value - a.value : a.label.localeCompare(b.label),
        )
        .map((c, i) => ({ ...c, colour: colourAt(i) })),
    [categories],
  );

  const total = useMemo(
    () => legendRows.reduce((sum, r) => sum + r.value, 0),
    [legendRows],
  );

  const slices = useMemo(
    () => legendRows.filter((r) => r.value > 0),
    [legendRows],
  );
  const sliceIndexByKey = useMemo(
    () => new Map(slices.map((s, i) => [s.key, i] as const)),
    [slices],
  );

  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  // Entrance sweep plays once, then disarms so hover re-renders don't replay.
  const [hasAnimated, setHasAnimated] = useState(false);
  const hasSlices = slices.length > 0;
  useEffect(() => {
    if (!hasSlices || hasAnimated) return;
    const id = window.setTimeout(() => setHasAnimated(true), 850);
    return () => window.clearTimeout(id);
  }, [hasSlices, hasAnimated]);

  const activeSlice =
    activeIndex !== null ? (slices[activeIndex] ?? null) : null;
  const centreValue = activeSlice ? activeSlice.value : total;
  const centreLabel = activeSlice ? activeSlice.label : 'Jami mahsulot';

  const sliceKey = slices.map((s) => `${s.key}:${s.value}`).join('|');

  return (
    <Card
      data-testid="central-category-donut"
      className={cn('space-y-4 p-5 sm:p-6', className)}
      role="region"
      aria-label="Kategoriya bo‘yicha mahsulotlar taqsimoti"
    >
      <header className="flex items-baseline justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Kategoriya bo‘yicha mahsulotlar
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Tayyor mahsulot turlari soni · kategoriya kesimida
          </p>
        </div>
      </header>

      {total === 0 ? (
        <EmptyState message="Tayyor mahsulot qoldig‘i topilmadi." />
      ) : (
        <div className="flex flex-col gap-8 sm:flex-row sm:items-center sm:gap-8">
          {/* LEFT — donut with the grand total in the centre. */}
          <div
            className="relative mx-auto h-[200px] w-[200px] shrink-0 sm:mx-0 lg:h-[220px] lg:w-[220px]"
            aria-hidden="true"
          >
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  key={hasSlices ? sliceKey : 'empty'}
                  data={slices}
                  dataKey="value"
                  nameKey="label"
                  innerRadius="58%"
                  outerRadius="88%"
                  paddingAngle={2}
                  stroke="hsl(var(--card))"
                  strokeWidth={2}
                  isAnimationActive={!hasAnimated}
                  animationDuration={700}
                  animationEasing="ease-out"
                  activeIndex={activeIndex ?? undefined}
                  activeShape={renderActiveSector}
                >
                  {slices.map((slice, i) => (
                    <Cell
                      key={slice.key}
                      fill={slice.colour}
                      fillOpacity={
                        activeIndex === null || activeIndex === i ? 1 : 0.35
                      }
                    />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-6 text-center">
              <span
                key={activeSlice ? activeSlice.key : '__total__'}
                className="flex h-[2.5rem] animate-in items-center justify-center fade-in text-3xl font-bold leading-none tabular-nums duration-200 sm:text-4xl"
                data-testid="central-category-total"
              >
                {formatPlainNumber(centreValue)}
              </span>
              <span
                key={activeSlice ? `${activeSlice.key}__label` : '__label__'}
                className="mt-1.5 line-clamp-1 max-w-full animate-in text-xs text-muted-foreground duration-200 fade-in"
              >
                {centreLabel}
              </span>
            </div>
          </div>

          {/* RIGHT — scrollable legend, one row per category. */}
          <ul
            className="scrollbar-thin max-h-[260px] w-full flex-1 space-y-2 overflow-y-auto pr-1"
            data-testid="central-category-legend"
          >
            {legendRows.map((row) => {
              const sliceIndex = sliceIndexByKey.get(row.key) ?? null;
              return (
                <li
                  key={row.key}
                  data-testid={`central-category-legend-${row.key}`}
                  className="grid cursor-default grid-cols-[1fr_auto_48px] items-baseline gap-x-4 rounded-md py-0.5 transition-colors hover:bg-surface-2/30"
                  onMouseEnter={() => setActiveIndex(sliceIndex)}
                  onMouseLeave={() => setActiveIndex(null)}
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <span
                      aria-hidden="true"
                      className="size-3 shrink-0 translate-y-px rounded-sm"
                      style={{ background: row.colour }}
                    />
                    <span className="truncate text-sm text-foreground">
                      {row.label}
                    </span>
                  </span>
                  <span className="text-right text-sm font-semibold tabular-nums sm:text-base">
                    {formatPlainNumber(row.value)}
                  </span>
                  <span className="text-right text-xs tabular-nums text-muted-foreground">
                    {formatPct(row.value, total)}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Card>
  );
}
