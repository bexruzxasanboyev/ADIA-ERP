import {
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Coins,
  Receipt,
  Wallet,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { Card } from '@/components/ui/card';
import type {
  DateRangePreset,
  DateRangeValue,
} from '@/components/DateRangeFilter';
import { formatPlainNumber, formatQty } from '@/lib/format';
import {
  COMPARISON_LABEL_BY_RANGE,
  RECEIPTS_TITLE_BY_RANGE,
  REVENUE_TITLE_BY_RANGE,
} from '@/lib/labels';
import type { DashboardEcosystem, DashboardOverview } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * Dashboard v3 — Variant B "Calm Canvas" — Hero strip.
 *
 * Four KPI cards in a single horizontal row. Each surfaces one number a
 * boshliq glances at first AND a "yesterday → today" percentage delta so
 * the direction of the day is obvious without scrolling to charts:
 *
 *   1. Bugungi tushum     — Poster `sales_today_sum` (so'm, FULL number)
 *   2. Sotuvlar soni      — Poster `sales_today_count` (cheklar)
 *   3. Foyda              — this month's profit (so'm, from /api/kpi/products)
 *   4. Kritik pozitsiya   — below-min stock count (danger tone)
 *
 * Layout follows the Stripe / Vercel pattern: huge tabular number, a
 * compact label above and a small delta pill below.
 */
export interface HeroStripProps {
  overview: DashboardOverview;
  ecosystem: DashboardEcosystem | null;
  /**
   * Active date-range filter. Drives the dynamic copy on the revenue
   * and receipts cards ("Bugungi tushum" / "Bu haftalik tushum" / …) and
   * the comparison label on the delta pill ("kechaga" / "o'tgan haftaga"
   * / …). Defaults to `{ range: 'today' }` so callers that don't yet
   * thread the range still render something sensible.
   */
  range?: DateRangeValue;
  /**
   * EPIC 7.1 — KPI click → detail. When supplied, each card with an
   * `href` becomes a clickable button that calls this with the target
   * route. The page wires `react-router`'s `navigate`; keeping the
   * navigation in the parent lets HeroStrip render router-free in tests.
   */
  onNavigate?: (href: string) => void;
  /**
   * The revenue + receipts cards are sourced from `ecosystem`
   * (Poster-backed, slower than `overview`). While that request is still
   * in flight and no data has arrived yet, those two cards render a
   * skeleton instead of a misleading "0" (owner feedback). The requests /
   * critical cards read from `overview`, which has already resolved by the
   * time HeroStrip renders, so they never skeleton.
   */
  ecosystemLoading?: boolean;
  /**
   * This month's profit (so'm) from `GET /api/kpi/products` — drives the
   * "Foyda" hero card. `null` means the figure is unavailable (the endpoint
   * is pm-only, so it 403s for `ai_assistant`, or it's still loading): the
   * card then shows an em-dash instead of a misleading "0".
   */
  monthlyProfit?: number | null;
  /**
   * When true the Foyda card shows a skeleton (the KPI request is still in
   * flight). Independent of `ecosystemLoading` since it has its own query.
   */
  profitLoading?: boolean;
  className?: string;
}

interface RangeCopy {
  /** Card title prefix, e.g. "Bugungi tushum", "Bu haftalik tushum". */
  revenueTitle: string;
  receiptsTitle: string;
  /** Caption under the delta arrow, e.g. "kechaga", "o'tgan haftaga". */
  comparisonLabel: string;
}

// Period copy is derived from the shared maps in `@/lib/labels` so the
// revenue / receipts headline wording stays identical to RevenueBreakdown.
function rangeCopy(preset: DateRangePreset): RangeCopy {
  return {
    revenueTitle: REVENUE_TITLE_BY_RANGE[preset],
    receiptsTitle: RECEIPTS_TITLE_BY_RANGE[preset],
    comparisonLabel: COMPARISON_LABEL_BY_RANGE[preset],
  };
}

type Tone = 'default' | 'warning' | 'danger';

interface HeroKpi {
  testId: string;
  label: string;
  value: string;
  caption?: string;
  tone: Tone;
  Icon: ComponentType<{ className?: string }>;
  /**
   * Drill-down route opened when the card is clicked (EPIC 7.1). When
   * undefined the card stays static (no affordance, no handler).
   */
  href?: string;
  /**
   * "Better when it goes up" (sales, receipts) vs. "better when it goes
   * down" (open requests, critical positions). Drives the colour of the
   * delta arrow.
   */
  direction: 'up-good' | 'down-good';
  /** Percentage delta vs. the prior comparable bucket; null when unknown. */
  deltaPct: number | null;
  /** Absolute prior value, formatted — shown in the delta caption. */
  prevLabel?: string;
  /**
   * When true the card shows a skeleton in place of its value / caption /
   * delta — the underlying datum hasn't arrived yet. Label + icon stay so
   * the card keeps its identity while loading.
   */
  loading?: boolean;
}

const VALUE_TONE: Record<Tone, string> = {
  default: 'text-foreground',
  warning: 'text-warning',
  danger: 'text-destructive',
};

const ICON_TONE: Record<Tone, string> = {
  default: 'text-muted-foreground',
  warning: 'text-warning',
  danger: 'text-destructive',
};

// Side gradient revealed on hover — a soft tone-coloured wash from the left
// edge that fades to transparent, so the card "lights up" without a hard
// background swap. Tone-matched so the danger card glows red, etc.
const HOVER_GRADIENT_TONE: Record<Tone, string> = {
  default: 'from-primary/20 via-primary/[0.06] to-transparent',
  warning: 'from-warning/20 via-warning/[0.06] to-transparent',
  danger: 'from-destructive/20 via-destructive/[0.06] to-transparent',
};

// Hero KPI cards always render the FULL grouped number ("2 400 000"),
// never the compact "2.4M" form — `formatPlainNumber` (uz-UZ, no
// fractional digits, NaN-guarded) is exactly that.
const formatFullNumber = formatPlainNumber;

function computeDeltaPct(today: number, prev: number): number | null {
  if (prev > 0) {
    return ((today - prev) / prev) * 100;
  }
  if (today > 0) return 100;
  return 0;
}

export function HeroStrip({
  overview,
  ecosystem,
  range,
  onNavigate,
  ecosystemLoading,
  monthlyProfit,
  profitLoading,
  className,
}: HeroStripProps) {
  const copy = rangeCopy(range?.range ?? 'today');
  // Revenue + receipts come from `ecosystem`; show a skeleton while it's
  // still loading and no data has landed yet, rather than a stale "0".
  const metricsLoading = Boolean(ecosystemLoading) && ecosystem === null;
  const salesToday = ecosystem?.poster_status.sales_today_sum ?? 0;
  const receiptsToday = ecosystem?.poster_status.sales_today_count ?? 0;
  const belowMin = overview.kpis.below_min_count;
  // Foyda — this month's profit. `null` (endpoint 403 for ai_assistant, or
  // still loading) renders an em-dash, never a misleading "0".
  const profitKnown = monthlyProfit !== null && monthlyProfit !== undefined;
  const profitValue = profitKnown
    ? formatFullNumber(monthlyProfit as number)
    : '—';

  // Prior-day comparison comes from `ecosystem.sales_chart.days`, which
  // tracks total sold qty per day. Sales-sum (revenue) uses qty as a
  // proxy for direction — the API doesn't yet expose `sales_sum` per
  // day, but the qty curve mirrors revenue closely enough for an
  // executive glance.
  const days = ecosystem?.sales_chart.days ?? [];
  const todayQty = days.length > 0 ? (days[days.length - 1]?.qty ?? 0) : 0;
  const yesterdayQty = days.length > 1 ? (days[days.length - 2]?.qty ?? 0) : 0;

  const revenueDelta = computeDeltaPct(todayQty, yesterdayQty);
  const receiptsDelta = computeDeltaPct(todayQty, yesterdayQty);

  const kpis: HeroKpi[] = [
    {
      testId: 'hero-strip-revenue',
      label: copy.revenueTitle,
      value: formatFullNumber(salesToday),
      caption: "so'm",
      tone: 'default',
      Icon: Wallet,
      direction: 'up-good',
      deltaPct: revenueDelta,
      prevLabel: copy.comparisonLabel,
      loading: metricsLoading,
      // Full sales charts + payment breakdown live on the operations view.
      href: '/dashboard/operations',
    },
    {
      testId: 'hero-strip-receipts',
      label: copy.receiptsTitle,
      value: formatFullNumber(receiptsToday),
      caption: 'cheklar',
      tone: 'default',
      Icon: Receipt,
      direction: 'up-good',
      deltaPct: receiptsDelta,
      prevLabel: copy.comparisonLabel,
      loading: metricsLoading,
      href: '/dashboard/operations',
    },
    {
      testId: 'hero-strip-profit',
      label: 'Oylik foyda',
      value: profitValue,
      caption: profitKnown ? "so'm" : "ma'lumot yo'q",
      tone: 'default',
      Icon: Coins,
      direction: 'up-good',
      deltaPct: null,
      loading: Boolean(profitLoading) && !profitKnown,
      // Per-product cost / profit breakdown (KPI page).
      href: '/kpi',
    },
    {
      testId: 'hero-strip-critical',
      label: 'Kritik pozitsiya',
      value: formatQty(belowMin),
      caption: belowMin > 0 ? "min'dan past" : 'hammasi joyida',
      tone: belowMin > 0 ? 'danger' : 'default',
      Icon: AlertTriangle,
      direction: 'down-good',
      deltaPct: null,
      // Below-min positions across the chain — the stock screen lists them.
      href: '/stock',
    },
  ];

  return (
    <div
      data-testid="hero-strip"
      className={cn(
        'grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4',
        className,
      )}
    >
      {kpis.map((kpi) => (
        <HeroKpiCard key={kpi.testId} kpi={kpi} onNavigate={onNavigate} />
      ))}
    </div>
  );
}

function HeroKpiCard({
  kpi,
  onNavigate,
}: {
  kpi: HeroKpi;
  onNavigate?: (href: string) => void;
}) {
  const { Icon } = kpi;
  // The card is interactive only when both a target route and a
  // navigation handler are present. Otherwise it stays a plain region
  // (e.g. in unit tests that render HeroStrip without a router).
  const isClickable = kpi.href !== undefined && onNavigate !== undefined;

  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {kpi.label}
        </p>
        <Icon
          aria-hidden="true"
          className={cn('size-5 shrink-0', ICON_TONE[kpi.tone])}
        />
      </div>

      {kpi.loading ? (
        <div
          className="flex flex-col gap-3"
          data-testid={`${kpi.testId}-skeleton`}
          aria-hidden="true"
        >
          {/* large number bar + delta bar — matches the dashboard skeleton
              shade (`bg-foreground/10` + `animate-pulse`). */}
          <div className="h-8 w-36 animate-pulse rounded bg-foreground/10" />
          <div className="h-3 w-20 animate-pulse rounded bg-foreground/10" />
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span
              className={cn(
                'text-2xl font-semibold tabular-nums tracking-tight',
                VALUE_TONE[kpi.tone],
              )}
              data-testid={`${kpi.testId}-value`}
            >
              {kpi.value}
            </span>
            {kpi.caption !== undefined && (
              <span className="text-sm text-muted-foreground">
                {kpi.caption}
              </span>
            )}
          </div>
          <DeltaPill kpi={kpi} />
        </div>
      )}
    </>
  );

  // Shared visual: matches the Card primitive surface exactly so the
  // clickable button is pixel-identical to the static region. `group` +
  // `isolate` let the hover gradient overlay fade in beneath the content.
  const surfaceClass = cn(
    'group relative isolate overflow-hidden',
    'rounded-xl border border-border/70 bg-card text-card-foreground shadow-card',
    'flex min-h-[124px] flex-col justify-between gap-3 p-5',
    'transition-[border-color,box-shadow] hover:border-border-strong hover:shadow-card-hover',
  );

  // Tone-matched side gradient, hidden until hover. `-z-10` keeps it above
  // the card background but below the number/label content (the card is an
  // isolated stacking context, so the negative z is scoped here).
  const gradientOverlay = (
    <span
      aria-hidden="true"
      className={cn(
        'pointer-events-none absolute inset-0 -z-10 bg-gradient-to-r opacity-0 transition-opacity duration-300 group-hover:opacity-100',
        HOVER_GRADIENT_TONE[kpi.tone],
      )}
    />
  );

  if (isClickable) {
    return (
      <button
        type="button"
        data-testid={kpi.testId}
        data-tone={kpi.tone}
        aria-label={`${kpi.label} — batafsil`}
        onClick={() => onNavigate?.(kpi.href as string)}
        className={cn(
          surfaceClass,
          'w-full text-left cursor-pointer',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        )}
      >
        {gradientOverlay}
        {body}
      </button>
    );
  }

  return (
    <Card
      data-testid={kpi.testId}
      data-tone={kpi.tone}
      role="region"
      aria-label={kpi.label}
      className={cn(
        surfaceClass,
        'focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background',
      )}
    >
      {gradientOverlay}
      {body}
    </Card>
  );
}

function DeltaPill({ kpi }: { kpi: HeroKpi }) {
  if (kpi.deltaPct === null) {
    return <span className="h-4" aria-hidden="true" />;
  }
  const pct = Math.round(kpi.deltaPct * 10) / 10;
  if (!Number.isFinite(pct) || pct === 0) {
    return (
      <span
        className="inline-flex items-center gap-1 text-xs tabular-nums text-muted-foreground"
        data-testid={`${kpi.testId}-delta`}
      >
        <ArrowRight className="size-3" aria-hidden="true" />
        kecha bilan teng
      </span>
    );
  }
  const positive = pct > 0;
  // "up-good": +% = good (green), -% = bad (red)
  // "down-good": +% = bad (red), -% = good (green)
  const isGood =
    kpi.direction === 'up-good' ? positive : !positive;
  const Icon = positive ? ArrowUp : ArrowDown;
  const colourClass = isGood ? 'text-success' : 'text-destructive';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-xs tabular-nums',
        colourClass,
      )}
      data-testid={`${kpi.testId}-delta`}
    >
      <Icon className="size-3" aria-hidden="true" />
      {positive ? '+' : ''}
      {pct.toFixed(1)}%
      {kpi.prevLabel !== undefined && (
        <span className="text-muted-foreground">{kpi.prevLabel}</span>
      )}
    </span>
  );
}
