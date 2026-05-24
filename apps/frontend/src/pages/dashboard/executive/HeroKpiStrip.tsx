import { useNavigate } from 'react-router-dom';
import { ArrowDown, ArrowRight, ArrowUp } from 'lucide-react';
import { Line, LineChart, ResponsiveContainer } from 'recharts';
import { Card } from '@/components/ui/card';
import { formatCurrencyCompact, formatQty } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * F4.7 — Hero KPI strip for the executive dashboard.
 *
 * Four oversized cards that read at a glance, even from across the room:
 *   1. Bugungi savdo   (compact currency)
 *   2. Faol zayafka    (fraction `done/total`)
 *   3. Qizil pozitsiya (danger ring when > 0)
 *   4. Tasdiq kutmoqda (warning ring when > 0)
 *
 * Each card is keyboard-navigable and routes to its detail page on
 * Enter / click. A tiny Recharts sparkline trails the value when a
 * series is supplied — the last point is highlighted as a dot.
 */
export type HeroKpiTone = 'neutral' | 'success' | 'warning' | 'danger';

export type HeroKpiValueKind =
  /** Render as a compact currency (`2.4M`). */
  | { kind: 'currency'; amount: number }
  /** Render as a big numerator + a muted `/total`. */
  | { kind: 'fraction'; numerator: number; denominator: number }
  /** Render as a plain count (`12`). */
  | { kind: 'count'; value: number };

export interface HeroKpiCard {
  /** Stable identifier so the strip can render without index keys. */
  id: string;
  /** Short uppercase label rendered above the number. */
  label: string;
  /** Value descriptor — drives the formatter used. */
  value: HeroKpiValueKind;
  /** Visual tone. `danger` and `warning` add a coloured ring. */
  tone: HeroKpiTone;
  /** Period label below the delta (e.g. "vs. kecha"). */
  periodLabel?: string;
  /**
   * Delta vs. the previous period. Positive → arrow up + success colour;
   * negative → arrow down + danger colour; zero → arrow right + muted.
   */
  delta?: { value: number; suffix?: string };
  /** Optional sparkline series — at least 2 points required. */
  sparkline?: number[];
  /** Route the card navigates to on click. */
  href?: string;
}

export function HeroKpiStrip({ cards }: { cards: HeroKpiCard[] }) {
  return (
    <div
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4 xl:gap-6"
      data-testid="hero-kpi-strip"
    >
      {cards.map((card) => (
        <KpiCard key={card.id} card={card} />
      ))}
    </div>
  );
}

function KpiCard({ card }: { card: HeroKpiCard }) {
  const navigate = useNavigate();

  const toneRing =
    card.tone === 'danger'
      ? 'ring-1 ring-destructive/40'
      : card.tone === 'warning'
        ? 'ring-1 ring-warning/40'
        : '';

  const numberTone =
    card.tone === 'danger'
      ? 'text-destructive'
      : card.tone === 'warning'
        ? 'text-warning'
        : card.tone === 'success'
          ? 'text-success'
          : 'text-foreground';

  const interactive = card.href !== undefined;

  function onClick() {
    if (card.href) navigate(card.href);
  }

  function onKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!card.href) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      navigate(card.href);
    }
  }

  return (
    <Card
      className={cn(
        'flex min-h-[200px] flex-col p-5 xl:p-6',
        toneRing,
        interactive &&
          'cursor-pointer transition-colors hover:bg-card/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
      )}
      data-testid={`hero-kpi-card-${card.id}`}
      data-tone={card.tone}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={interactive ? onClick : undefined}
      onKeyDown={interactive ? onKey : undefined}
      aria-label={card.label}
    >
      <p className="text-xs uppercase tracking-wider text-muted-foreground">
        {card.label}
      </p>

      <div className="mt-3 flex items-end gap-2">
        <ValueDisplay value={card.value} tone={numberTone} />
      </div>

      <div className="mt-auto flex items-end justify-between gap-3 pt-4">
        <DeltaBlock card={card} />
        {card.sparkline && card.sparkline.length >= 2 && (
          <Sparkline values={card.sparkline} tone={card.tone} />
        )}
      </div>
    </Card>
  );
}

function ValueDisplay({
  value,
  tone,
}: {
  value: HeroKpiValueKind;
  tone: string;
}) {
  if (value.kind === 'currency') {
    return (
      <span
        className={cn(
          'text-4xl font-semibold tabular-nums leading-none xl:text-5xl',
          tone,
        )}
        data-testid="hero-kpi-value"
      >
        {formatCurrencyCompact(value.amount)}
      </span>
    );
  }
  if (value.kind === 'fraction') {
    return (
      <div className="flex items-baseline gap-1">
        <span
          className={cn(
            'text-4xl font-semibold tabular-nums leading-none xl:text-5xl',
            tone,
          )}
          data-testid="hero-kpi-value"
        >
          {formatQty(value.numerator)}
        </span>
        <span className="text-xl font-medium tabular-nums text-muted-foreground">
          /{formatQty(value.denominator)}
        </span>
      </div>
    );
  }
  return (
    <span
      className={cn(
        'text-4xl font-semibold tabular-nums leading-none xl:text-5xl',
        tone,
      )}
      data-testid="hero-kpi-value"
    >
      {formatQty(value.value)}
    </span>
  );
}

function DeltaBlock({ card }: { card: HeroKpiCard }) {
  if (!card.delta) {
    return card.periodLabel ? (
      <p className="text-xs text-muted-foreground">{card.periodLabel}</p>
    ) : (
      <span />
    );
  }

  const { value, suffix = '' } = card.delta;
  const Icon = value > 0 ? ArrowUp : value < 0 ? ArrowDown : ArrowRight;
  const colour =
    value > 0
      ? 'text-success'
      : value < 0
        ? 'text-destructive'
        : 'text-muted-foreground';

  return (
    <div className="flex flex-col gap-0.5">
      <span
        className={cn(
          'inline-flex items-center gap-1 text-sm font-medium tabular-nums',
          colour,
        )}
      >
        <Icon className="size-3.5" aria-hidden="true" />
        {Math.abs(value)}
        {suffix}
      </span>
      {card.periodLabel && (
        <span className="text-[11px] text-muted-foreground">
          {card.periodLabel}
        </span>
      )}
    </div>
  );
}

function Sparkline({
  values,
  tone,
}: {
  values: number[];
  tone: HeroKpiTone;
}) {
  const data = values.map((v, i) => ({ i, v }));
  const stroke =
    tone === 'danger'
      ? 'hsl(var(--destructive))'
      : tone === 'warning'
        ? 'hsl(var(--warning))'
        : tone === 'success'
          ? 'hsl(var(--success))'
          : 'hsl(var(--primary))';

  return (
    <div
      className="h-7 w-20 shrink-0"
      aria-hidden="true"
      data-testid="hero-kpi-sparkline"
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 4, right: 2, bottom: 0, left: 0 }}>
          <Line
            type="monotone"
            dataKey="v"
            stroke={stroke}
            strokeWidth={1.5}
            dot={(props: { cx?: number; cy?: number; index?: number }) => {
              const isLast = props.index === data.length - 1;
              if (
                !isLast ||
                props.cx === undefined ||
                props.cy === undefined
              ) {
                return <g />;
              }
              return (
                <circle
                  cx={props.cx}
                  cy={props.cy}
                  r={2.5}
                  fill={stroke}
                />
              );
            }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
