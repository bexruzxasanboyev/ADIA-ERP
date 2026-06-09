import { useEffect, useState } from 'react';
import {
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Sector,
  type PieProps,
} from 'recharts';
import {
  dateRangeToQuery,
  type DateRangeValue,
} from '@/components/DateRangeFilter';
import { Card } from '@/components/ui/card';
import { useApiQuery } from '@/hooks/useApiQuery';
import { formatCurrencyCompact, formatPlainNumber } from '@/lib/format';
import { revenueTitleForRange } from '@/lib/labels';
import { cn } from '@/lib/utils';
import type { DashboardRevenueBreakdown } from '@/lib/types';

/**
 * F4.14 / EPIC 0.4 — revenue breakdown widget (donut + interactive legend).
 *
 * Hits `GET /api/dashboard/revenue-breakdown?range=…` and renders the
 * SELECTED period's total revenue across the payment methods:
 *
 *   - LEFT  — a Recharts donut (total in the centre), one slice per
 *             payment method with amount > 0.
 *   - RIGHT — a legend list driven entirely by the backend's pre-ordered
 *             `methods` array, so EVERY payment method (the four core
 *             Naqd/Karta/Payme/Click plus any named custom Poster method
 *             like "Доверительный платеж") renders by name, with amount
 *             and share of total. Hovering a legend row highlights the
 *             matching donut slice and dims the rest — the legend is the
 *             source of detail (no chart tooltip).
 *
 * Both the data fetch AND the headline copy follow the dashboard
 * date-range filter, so the numbers change when the period changes. The
 * widget is tolerant of a missing endpoint: on 404 it falls back to
 * showing `fallbackTotal` (Poster `sales_today_sum`) and a subtle inline
 * note instead of an error state.
 */
export interface RevenueBreakdownProps {
  /**
   * Active date-range filter. Drives BOTH the `?range=…&from=…&to=…`
   * query (so the breakdown re-fetches per period) and the headline copy
   * ("Bugungi tushum" / "Bu oylik tushum" / …).
   */
  range: DateRangeValue;
  /**
   * Total revenue surfaced by the existing Poster status block — used as
   * the fallback when the breakdown endpoint is unavailable so the user
   * still sees an answer to "bugun qancha tushdi".
   */
  fallbackTotal?: number;
  className?: string;
}

// Colour resolution mirrors OpenRequestsChart's CSS-var pattern: literal
// hsl values keep colours sensible in jsdom (where computed vars resolve to
// an empty string) and in the dark theme alike.

// Established mapping for the four core method keys + the catch-all.
// Payment-method coded (not chain-coded) so colours mirror the prior chips'
// palette and stay visually distinct (the dark `--info` teal would collide
// with Payme cyan).
const CORE_COLOURS = {
  cash: 'hsl(152 60% 48%)', // emerald
  card: 'hsl(204 90% 56%)', // sky / blue
  payme: 'hsl(187 80% 52%)', // cyan
  click: 'hsl(258 72% 66%)', // violet
  other: 'hsl(215 16% 60%)', // slate
} as const;

/** Whether `key` is one of the established core method keys. */
function isCoreKey(key: string): key is keyof typeof CORE_COLOURS {
  return key in CORE_COLOURS;
}

// Fixed palette for named custom Poster methods (key `pm_<id>`), assigned in
// order so a given method keeps a stable colour across renders. Indexed by
// the position of the custom method within the methods list.
const CUSTOM_PALETTE: string[] = [
  'hsl(38 92% 55%)', // amber
  'hsl(347 77% 60%)', // rose
  'hsl(243 65% 66%)', // indigo
  'hsl(172 66% 45%)', // teal
  'hsl(292 70% 62%)', // fuchsia
  'hsl(84 62% 50%)', // lime
];

// `formatSum` is the shared uz-UZ grouped-integer formatter (NaN-guarded);
// matches how the "Bugungi tushum" KPI card renders the full amount.
const formatSum = formatPlainNumber;

function formatPct(part: number, total: number): string {
  if (total <= 0 || !Number.isFinite(part)) return '0%';
  const pct = (part / total) * 100;
  return `${pct >= 10 ? Math.round(pct) : pct.toFixed(1)}%`;
}

interface LegendRow {
  key: string;
  label: string;
  value: number;
  colour: string;
}

/**
 * Resolve a colour for one method row. Core keys keep their established
 * mapping; custom `pm_*` methods draw from the fixed palette by their index
 * among the custom methods so the colour is stable for a given method.
 */
function methodColour(key: string, customIndex: number): string {
  if (isCoreKey(key)) return CORE_COLOURS[key];
  return (
    CUSTOM_PALETTE[customIndex % CUSTOM_PALETTE.length] ?? CORE_COLOURS.other
  );
}

/**
 * Active-slice renderer: the hovered slice keeps its EXACT radii (no
 * enlargement — growing the outer radius pushed the layout and made the
 * donut "jump"), and instead reads as active purely via a brighter,
 * thicker stroke ring. The siblings recede through `fillOpacity` on their
 * Cells, so no radius changes anywhere == no reflow on hover.
 */
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

export function RevenueBreakdown({
  range,
  fallbackTotal,
  className,
}: RevenueBreakdownProps) {
  const title = revenueTitleForRange(range.range);
  const { data, isLoading, error } = useApiQuery<DashboardRevenueBreakdown>(
    `/api/dashboard/revenue-breakdown?${dateRangeToQuery(range)}`,
  );

  // Which donut slice is emphasised (driven by legend hover). `null` = none.
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  // Entrance animation must play ONCE — the first time real slices render —
  // and never again. The previous approach armed/disarmed on mount, but the
  // data arrives ASYNC: by the time the first slices exist the timer had
  // already fired and animation was off, so the donut just "appeared". We now
  // track whether the FIRST non-empty data render has happened yet and only
  // arm `isAnimationActive` for that render; a later hover/re-render finds it
  // already disarmed, so no re-sweep ("jump").
  const [hasAnimated, setHasAnimated] = useState(false);

  // Graceful degradation: when the endpoint isn't wired yet (or any other
  // error), still render the total from the Poster status feed so the
  // boshliq doesn't lose the headline number.
  const isMissing = error !== null;
  const total = data?.total ?? fallbackTotal ?? 0;

  // The loading note only renders while genuinely loading or when the
  // endpoint is missing. A SUCCESSFUL response — even one with zero revenue
  // and an absent `methods` — must NOT keep the spinner up forever (defect:
  // stuck loading on a zero-revenue day); in that case we fall through to a
  // real all-zero legend built from the core methods.
  const showLoadingNote = isLoading && data === null && !isMissing;

  // Build the legend rows from the backend's pre-ordered `methods` list. The
  // list is the source of truth for order, labels, and which methods exist —
  // every method (core + named custom) renders by name. On a successful but
  // empty response (no `methods`), synthesise the four core rows at zero so
  // the boshliq still sees them.
  const legendRows: LegendRow[] | null = (() => {
    if (showLoadingNote) return null;
    const methods = data?.methods;
    if (methods && methods.length > 0) {
      let customIndex = 0;
      return methods.map((m) => {
        const isCustom = !isCoreKey(m.key);
        const colour = methodColour(m.key, isCustom ? customIndex : 0);
        if (isCustom) customIndex += 1;
        return {
          key: m.key,
          label: m.label,
          value: m.amount,
          colour,
        };
      });
    }
    if (!isLoading && !isMissing) {
      // Zero-state: a real all-zero legend rather than a perpetual spinner.
      return [
        { key: 'cash', label: 'Naqd', value: 0, colour: CORE_COLOURS.cash },
        { key: 'card', label: 'Karta', value: 0, colour: CORE_COLOURS.card },
        { key: 'payme', label: 'Payme', value: 0, colour: CORE_COLOURS.payme },
        { key: 'click', label: 'Click', value: 0, colour: CORE_COLOURS.click },
      ];
    }
    return null;
  })();

  // The donut omits zero-amount methods, so the drawn slices are a SUBSET of
  // the legend rows. Map each legend row to its slice index (or null when the
  // method has no slice) so a legend hover can target the right sector — and
  // a zero-amount row simply no-ops.
  const slices = legendRows?.filter((r) => r.value > 0) ?? [];
  const sliceIndexByKey = new Map<string, number>(
    slices.map((s, i) => [s.key, i]),
  );

  // Once real slices first exist, let the entrance sweep play, then disable
  // animation just AFTER it finishes so hover-driven re-renders don't replay
  // it (the "jump"). The timer is only armed on the first non-empty render —
  // never on mount — so the sweep is guaranteed to coincide with the first
  // time the donut actually has slices to draw. `hasAnimated` only ever
  // flips false→true, so this settles after the first paint and stays put.
  const hasSlices = slices.length > 0;
  useEffect(() => {
    if (!hasSlices || hasAnimated) return;
    // Disarm a beat after the 700ms sweep so the full entrance is visible.
    const id = window.setTimeout(() => setHasAnimated(true), 850);
    return () => window.clearTimeout(id);
  }, [hasSlices, hasAnimated]);

  // The donut centre is reactive: while a legend row is hovered it shows
  // THAT method's amount + label; otherwise it falls back to the grand
  // total + "Jami tushum". The box itself is fixed-height/centred so the
  // swap never resizes or shifts the donut.
  const activeSlice =
    activeIndex !== null ? (slices[activeIndex] ?? null) : null;
  const centreValue = activeSlice ? activeSlice.value : total;
  const centreLabel = activeSlice ? activeSlice.label : 'Jami tushum';

  // The centre value font-size is ADAPTIVE to the formatted string length so
  // long values (billions, e.g. "17.04mlrd" ~9 chars) shrink to clearly fit
  // inside the ~58% inner radius of the 240–260px donut ring, while short
  // values ("25.9M") stay large. Derived from whatever `centreValue` is now,
  // so it applies to the grand total AND a hovered single-method value alike.
  const centreText = formatCurrencyCompact(centreValue);
  const centreSizeClass =
    centreText.length >= 9
      ? 'text-xl sm:text-2xl'
      : centreText.length >= 7
        ? 'text-2xl sm:text-3xl'
        : 'text-3xl sm:text-4xl';

  // While genuinely loading (no data yet, endpoint not known-missing) we
  // render a skeleton that mirrors the donut + legend layout.
  const showSkeleton = showLoadingNote;

  return (
    <Card
      data-testid="revenue-breakdown"
      className={cn('space-y-4 p-5', className)}
      role="region"
      aria-label={`${title} brekdown`}
    >
      <header className="flex items-baseline justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Tushum taqsimoti
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            To&apos;lov usullari bo&apos;yicha · {title}
          </p>
        </div>
      </header>

      {showSkeleton ? (
        <div
          className="flex animate-pulse flex-col gap-8 sm:flex-row sm:items-center sm:gap-8"
          data-testid="revenue-breakdown-skeleton"
          aria-hidden="true"
        >
          {/* LEFT — donut-shaped ring placeholder */}
          <div className="relative mx-auto h-[240px] w-[240px] shrink-0 sm:mx-0 lg:h-[260px] lg:w-[260px]">
            <div className="absolute inset-0 rounded-full bg-foreground/10" />
            <div className="absolute inset-[26%] rounded-full bg-card" />
          </div>
          {/* RIGHT — compact legend table placeholder */}
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
      ) : legendRows !== null ? (
        // DONUT + LEGEND side by side. The widget lives at ~half-width
        // (two-up beside TopProducts), so the donut sits left and the legend
        // fills the remaining column. On a narrow viewport they stack.
        <div className="flex flex-col gap-8 sm:flex-row sm:items-center sm:gap-8">
          {/* LEFT — donut with the total in the centre. A ~240–260px square
              that gets `shrink-0` so the legend never squeezes it. */}
          <div
            className="relative mx-auto h-[240px] w-[240px] shrink-0 sm:mx-0 lg:h-[260px] lg:w-[260px]"
            aria-hidden="true"
          >
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  // Key flips empty→`live` the first time slices exist, which
                  // remounts the <Pie> exactly once so Recharts replays the
                  // entrance sweep on the FIRST data render (a plain
                  // empty→non-empty data update would NOT re-trigger it). The
                  // key never changes again, so hover/re-render don't remount.
                  key={hasSlices ? 'live' : 'empty'}
                  data={slices}
                  dataKey="value"
                  nameKey="label"
                  innerRadius="58%"
                  outerRadius="88%"
                  paddingAngle={2}
                  stroke="hsl(var(--card))"
                  strokeWidth={2}
                  // Armed only until the first sweep completes (see the effect
                  // above), then OFF — so hover/re-render never restart the
                  // animation (the "jump").
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
                      // When a slice is emphasised, the others recede.
                      fillOpacity={
                        activeIndex === null || activeIndex === i ? 1 : 0.35
                      }
                    />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
            {/* Centre stack — reactive to legend hover. The box keeps a
                fixed height and centres its content so swapping the grand
                total for a single method's value (and back) never resizes
                or shifts the donut. A short key-driven fade keeps the swap
                pleasant without any layout jump. */}
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-6 text-center">
              <span
                key={activeSlice ? activeSlice.key : '__total__'}
                className={cn(
                  'flex h-[2.75rem] animate-in items-center justify-center fade-in duration-200 font-semibold leading-none tabular-nums tracking-tight sm:h-[3rem]',
                  centreSizeClass,
                )}
                data-testid="revenue-breakdown-total"
              >
                {centreText}
              </span>
              <span
                key={
                  activeSlice ? `${activeSlice.key}__label` : '__total_label__'
                }
                className="mt-1.5 line-clamp-1 max-w-full animate-in text-xs text-muted-foreground fade-in duration-200"
                data-testid="revenue-breakdown-center-label"
              >
                {centreLabel}
              </span>
            </div>
          </div>

          {/* RIGHT — compact legend table, one row per method, driven by the
              backend's pre-ordered `methods` list. Every method (core +
              custom named) renders by its `label`. Hovering a row highlights
              the matching donut slice; a zero-amount row has no slice and
              simply no-ops. */}
          <ul
            className="w-full flex-1 space-y-3.5"
            data-testid="revenue-breakdown-legend"
          >
            {legendRows.map((row) => {
              const sliceIndex = sliceIndexByKey.get(row.key) ?? null;
              return (
                <li
                  key={row.key}
                  data-testid={`revenue-legend-${row.key}`}
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
                    <span className="truncate text-base text-foreground">
                      {row.label}
                    </span>
                  </span>
                  <span className="text-right text-base font-semibold tabular-nums sm:text-lg">
                    {formatSum(row.value)}
                    <span className="ml-1 text-xs font-normal text-muted-foreground">
                      so&apos;m
                    </span>
                  </span>
                  <span className="text-right text-sm tabular-nums text-muted-foreground">
                    {formatPct(row.value, total)}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <p
          className="rounded-lg border border-border/60 bg-surface-3 px-3 py-2 text-xs text-muted-foreground"
          role="note"
        >
          {"Tushum brekdown ma'lumotlari tayyor emas."}
        </p>
      )}

      {/* On a missing endpoint, still surface the fallback total so the
          headline number doesn't vanish (preserves prior behaviour). */}
      {legendRows === null && isMissing && (
        <p
          className="text-2xl font-semibold tabular-nums tracking-tight"
          data-testid="revenue-breakdown-total"
        >
          {formatSum(total)}
          <span className="ml-2 text-base font-normal text-muted-foreground">
            so&apos;m
          </span>
        </p>
      )}
    </Card>
  );
}
