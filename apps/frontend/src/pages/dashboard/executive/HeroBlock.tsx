import { useMemo } from 'react';
import { ArrowDown, ArrowRight, ArrowUp, TriangleAlert } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { MicroSparkline } from '@/components/charts/MicroSparkline';
import { CHAIN_TONE_BY_TYPE } from '@/lib/chainTokens';
import { formatCurrencyCompact, formatQty } from '@/lib/format';
import type {
  ChainSummaryNode,
  DashboardAlert,
  DashboardEcosystem,
  DashboardOverview,
  LocationType,
} from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * Dashboard v2 — Variant C — Hero block.
 *
 * Two columns at the very top of the executive dashboard:
 *
 *   • Left  — "Bugun" headline: today's sales sum (compact currency),
 *             receipt count + delta vs. yesterday, 7-day sparkline.
 *   • Right — "Zanjir sog'ligi": one status dot per chain stage, a
 *             friendly summary line ("4/5 yaxshi"), and the first
 *             actionable alert if any.
 *
 * Click semantics: the right-hand status dots route to `ChainPipeline`
 * via the shared `onSelectChain` callback so the user can drill into
 * the offending stage with a single click.
 */
const CHAIN_ORDER: readonly LocationType[] = [
  'raw_warehouse',
  'production',
  'supply',
  'central_warehouse',
  'store',
] as const;

const CHAIN_ABBR: Record<LocationType, string> = {
  raw_warehouse: 'XO',
  production: 'IC',
  // Sex skladi — renamed from "Ta'minot bo'limi" (TB).
  supply: 'SS',
  sex_storage: 'SS',
  central_warehouse: 'MS',
  store: 'DO',
};

const STATUS_DOT: Record<ChainSummaryNode['status'], string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  danger: 'bg-destructive',
};

const STATUS_RING: Record<ChainSummaryNode['status'], string> = {
  ok: 'ring-success/30',
  warn: 'ring-warning/30',
  danger: 'ring-destructive/40',
};

export interface HeroBlockProps {
  overview: DashboardOverview;
  ecosystem: DashboardEcosystem | null;
  onSelectChain?: (type: LocationType) => void;
}

export function HeroBlock({
  overview,
  ecosystem,
  onSelectChain,
}: HeroBlockProps) {
  const salesToday = ecosystem?.poster_status.sales_today_sum ?? 0;
  const receiptsToday = ecosystem?.poster_status.sales_today_count ?? 0;

  const { sparkValues, deltaPct } = useMemo(() => {
    const days = ecosystem?.sales_chart.days ?? [];
    const last7 = days.slice(-7).map((d) => d.qty);
    const todayQty = last7.length > 0 ? (last7[last7.length - 1] ?? 0) : 0;
    const yesterdayQty =
      last7.length > 1 ? (last7[last7.length - 2] ?? 0) : 0;
    let delta = 0;
    if (yesterdayQty > 0) {
      delta = ((todayQty - yesterdayQty) / yesterdayQty) * 100;
    } else if (todayQty > 0) {
      delta = 100;
    }
    return {
      sparkValues: last7.length >= 2 ? last7 : null,
      deltaPct: Math.round(delta * 10) / 10,
    };
  }, [ecosystem]);

  const chainSummary = ecosystem?.chain_summary ?? [];
  const summaryByType = new Map<LocationType, ChainSummaryNode>(
    chainSummary.map((n) => [n.type, n]),
  );

  const stages = CHAIN_ORDER.map((type) => summaryByType.get(type) ?? null);
  const healthySteps = stages.filter(
    (s): s is ChainSummaryNode => s !== null && s.status === 'ok',
  ).length;
  const totalSteps = stages.filter((s): s is ChainSummaryNode => s !== null)
    .length;
  const alertSteps = totalSteps - healthySteps;

  const firstAlert = pickFirstAlert(
    ecosystem?.alerts_feed ?? [],
    overview.below_min.length,
  );

  return (
    <div
      className="grid grid-cols-1 gap-4 lg:grid-cols-2"
      data-testid="hero-block"
    >
      <Card
        className="flex flex-col justify-between gap-3 p-5 lg:min-h-[180px]"
        role="region"
        aria-labelledby="hero-block-sales-title"
      >
        <p
          id="hero-block-sales-title"
          className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
        >
          Bugun
        </p>

        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span
            className="text-4xl font-bold leading-none tabular-nums text-foreground sm:text-5xl"
            data-testid="hero-block-sales-value"
          >
            {formatCurrencyCompact(salesToday)}
          </span>
          <span className="text-sm text-muted-foreground">so'm</span>
        </div>

        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="tabular-nums">
              {formatQty(receiptsToday)} chek
            </span>
            <DeltaPill value={deltaPct} />
          </div>
          {sparkValues !== null && (
            <MicroSparkline
              values={sparkValues}
              tone="store"
              height={32}
              width={120}
              ariaLabel="So'nggi 7 kunlik savdo trendi"
            />
          )}
        </div>
      </Card>

      <Card
        className="flex flex-col justify-between gap-3 p-5 lg:min-h-[180px]"
        role="region"
        aria-labelledby="hero-block-health-title"
      >
        <div className="flex items-center justify-between gap-3">
          <p
            id="hero-block-health-title"
            className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
          >
            Zanjir sog'ligi
          </p>
          <p className="text-xs text-muted-foreground tabular-nums">
            {totalSteps > 0
              ? `${healthySteps}/${totalSteps} yaxshi · ${alertSteps} alert`
              : "Ma'lumot yo'q"}
          </p>
        </div>

        <ul
          className="flex flex-wrap items-center gap-3 sm:gap-4"
          data-testid="hero-block-stage-dots"
        >
          {CHAIN_ORDER.map((type) => {
            const node = summaryByType.get(type);
            const status = node?.status ?? 'ok';
            const tone = CHAIN_TONE_BY_TYPE[type];
            const interactive = onSelectChain !== undefined;
            return (
              <li key={type}>
                <button
                  type="button"
                  aria-label={`${CHAIN_ABBR[type]} — ${labelStatus(status)}`}
                  data-testid={`hero-block-dot-${type}`}
                  data-tone={tone}
                  data-status={status}
                  disabled={!interactive}
                  onClick={() => onSelectChain?.(type)}
                  className={cn(
                    'flex flex-col items-center gap-1 rounded-md px-1.5 py-1',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                    interactive && 'cursor-pointer hover:bg-surface-3',
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      'inline-block size-4 rounded-full ring-2',
                      STATUS_DOT[status],
                      STATUS_RING[status],
                    )}
                  />
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {CHAIN_ABBR[type]}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        {firstAlert !== null ? (
          <p
            className="flex items-start gap-2 text-xs text-warning"
            data-testid="hero-block-first-alert"
          >
            <TriangleAlert
              className="size-4 shrink-0"
              aria-hidden="true"
            />
            <span className="line-clamp-2">{firstAlert}</span>
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Hozircha kritik signal yo'q.
          </p>
        )}
      </Card>
    </div>
  );
}

function DeltaPill({ value }: { value: number }) {
  if (!Number.isFinite(value) || value === 0) {
    return (
      <span className="inline-flex items-center gap-1 tabular-nums text-muted-foreground">
        <ArrowRight className="size-3" aria-hidden="true" />
        kecha bilan teng
      </span>
    );
  }
  const positive = value > 0;
  const Icon = positive ? ArrowUp : ArrowDown;
  const cls = positive ? 'text-success' : 'text-destructive';
  return (
    <span
      className={cn('inline-flex items-center gap-1 tabular-nums', cls)}
      data-testid="hero-block-delta"
    >
      <Icon className="size-3" aria-hidden="true" />
      {positive ? '+' : ''}
      {value.toFixed(1)}% kechaga
    </span>
  );
}

function labelStatus(status: ChainSummaryNode['status']): string {
  if (status === 'ok') return 'yaxshi';
  if (status === 'warn') return 'ehtiyot';
  return 'kritik';
}

function pickFirstAlert(
  alerts: DashboardAlert[],
  belowMinCount: number,
): string | null {
  const danger = alerts.find((a) => a.severity === 'danger');
  if (danger) return danger.message;
  const warning = alerts.find((a) => a.severity === 'warning');
  if (warning) return warning.message;
  if (belowMinCount > 0) {
    return `${belowMinCount} mahsulot min'dan past`;
  }
  return null;
}
