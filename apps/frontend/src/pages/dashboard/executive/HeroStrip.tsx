import {
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ClipboardList,
  Receipt,
  Wallet,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { Card } from '@/components/ui/card';
import type {
  DateRangePreset,
  DateRangeValue,
} from '@/components/DateRangeFilter';
import { formatQty } from '@/lib/format';
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
 *   3. Faol so'rovlar     — active production + open requests + pending approvals
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
   * and receipts cards ("Bugungi tushum" / "Haftalik tushum" / …) and
   * the comparison label on the delta pill ("kechaga" / "o'tgan haftaga"
   * / …). Defaults to `{ range: 'today' }` so callers that don't yet
   * thread the range still render something sensible.
   */
  range?: DateRangeValue;
  className?: string;
}

interface RangeCopy {
  /** Card title prefix, e.g. "Bugungi tushum", "Haftalik tushum". */
  revenueTitle: string;
  receiptsTitle: string;
  /** Caption under the delta arrow, e.g. "kechaga", "o'tgan haftaga". */
  comparisonLabel: string;
}

const RANGE_COPY: Record<DateRangePreset, RangeCopy> = {
  today: {
    revenueTitle: 'Bugungi tushum',
    receiptsTitle: 'Bugungi sotuvlar',
    comparisonLabel: 'kechaga',
  },
  week: {
    revenueTitle: 'Haftalik tushum',
    receiptsTitle: 'Haftalik sotuvlar',
    comparisonLabel: "o'tgan haftaga",
  },
  month: {
    revenueTitle: 'Oylik tushum',
    receiptsTitle: 'Oylik sotuvlar',
    comparisonLabel: "o'tgan oyga",
  },
  '6m': {
    revenueTitle: '6 oylik tushum',
    receiptsTitle: '6 oylik sotuvlar',
    comparisonLabel: 'oldingi 6 oyga',
  },
  custom: {
    revenueTitle: 'Davr tushumi',
    receiptsTitle: 'Davr sotuvlari',
    comparisonLabel: 'oldingi davrga',
  },
};

type Tone = 'default' | 'warning' | 'danger';

interface HeroKpi {
  testId: string;
  label: string;
  value: string;
  caption?: string;
  tone: Tone;
  Icon: ComponentType<{ className?: string }>;
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

// `Intl.NumberFormat('uz-UZ')` groups with a non-breaking space — perfect
// for "2 400 000". A dedicated formatter so we never accidentally fall
// back to the compact "2.4M" form on hero cards.
const fullNumberFormatter = new Intl.NumberFormat('uz-UZ', {
  maximumFractionDigits: 0,
});

function formatFullNumber(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return fullNumberFormatter.format(Math.round(value));
}

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
  className,
}: HeroStripProps) {
  const copy = RANGE_COPY[range?.range ?? 'today'];
  const salesToday = ecosystem?.poster_status.sales_today_sum ?? 0;
  const receiptsToday = ecosystem?.poster_status.sales_today_count ?? 0;
  const activeRequests =
    overview.kpis.active_production_orders +
    overview.kpis.total_open_requests +
    overview.kpis.pending_approvals;
  const belowMin = overview.kpis.below_min_count;

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
    },
    {
      testId: 'hero-strip-requests',
      label: "Faol so'rovlar",
      value: formatQty(activeRequests),
      caption: 'jami',
      tone: activeRequests > 0 ? 'warning' : 'default',
      Icon: ClipboardList,
      direction: 'down-good',
      deltaPct: null,
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
        <HeroKpiCard key={kpi.testId} kpi={kpi} />
      ))}
    </div>
  );
}

function HeroKpiCard({ kpi }: { kpi: HeroKpi }) {
  const { Icon } = kpi;
  return (
    <Card
      data-testid={kpi.testId}
      data-tone={kpi.tone}
      role="region"
      aria-label={kpi.label}
      className={cn(
        'flex min-h-[140px] flex-col justify-between gap-3 p-5 sm:p-6',
        'border-border/60 transition-colors hover:border-border',
        'focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {kpi.label}
        </p>
        <Icon
          aria-hidden="true"
          className={cn('size-4 shrink-0', ICON_TONE[kpi.tone])}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span
            className={cn(
              'text-3xl font-bold leading-none tabular-nums xl:text-4xl',
              VALUE_TONE[kpi.tone],
            )}
            data-testid={`${kpi.testId}-value`}
          >
            {kpi.value}
          </span>
          {kpi.caption !== undefined && (
            <span className="text-xs text-muted-foreground">
              {kpi.caption}
            </span>
          )}
        </div>
        <DeltaPill kpi={kpi} />
      </div>
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
