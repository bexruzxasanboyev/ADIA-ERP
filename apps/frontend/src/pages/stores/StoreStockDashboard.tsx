import { type ComponentType } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  AlertTriangle,
  CheckCircle2,
  Package,
  TrendingDown,
  XCircle,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { formatPlainNumber } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Do'kon ish joyi — "Dashboard" tab (owner feedback). A real-time stock
 * overview for the selected store(s): five KPI cards + a status donut.
 *
 * The numbers come straight from the live `stock` rows (no date filter —
 * stock is current-state data), so the parent passes pre-computed counts
 * derived with the same `stockStatusOf` rule the product cards use.
 */
export interface StockStatusCounts {
  /** Total stock rows in scope (Umumiy mahsulot soni). */
  total: number;
  /** qty <= 0 (Tugagan). */
  out: number;
  /** 0 < qty <= min (Min'dan past). */
  below_min: number;
  /** early-warning band just above min (Kam). */
  low: number;
  /** comfortably above min (Yetarli). */
  enough: number;
}

type StatusKey = 'below_min' | 'low' | 'out' | 'enough';

const STATUS_META: Record<
  StatusKey,
  { label: string; colour: string; accent: string; value: string }
> = {
  below_min: {
    label: 'Min’dan past',
    colour: 'hsl(24 90% 55%)',
    accent: 'border-l-orange-500',
    value: 'text-orange-500',
  },
  low: {
    label: 'Kam',
    colour: 'hsl(45 93% 52%)',
    accent: 'border-l-amber-500',
    value: 'text-amber-500',
  },
  out: {
    label: 'Tugagan',
    colour: 'hsl(0 84% 60%)',
    accent: 'border-l-destructive',
    value: 'text-destructive',
  },
  enough: {
    label: 'Yetarli',
    colour: 'hsl(152 56% 48%)',
    accent: 'border-l-emerald-500',
    value: 'text-emerald-500',
  },
};

/** Bar order (worst → best). */
const STATUS_ORDER: StatusKey[] = ['out', 'below_min', 'low', 'enough'];

function formatPct(part: number, total: number): string {
  if (total <= 0) return '0%';
  const pct = (part / total) * 100;
  return `${pct >= 10 ? Math.round(pct) : pct.toFixed(1)}%`;
}

const barTooltipStyle = {
  background: 'hsl(var(--popover))',
  border: '1px solid hsl(var(--border))',
  borderRadius: '0.5rem',
  fontSize: '0.75rem',
  color: 'hsl(var(--popover-foreground))',
};

/** A KPI card styled like the executive dashboard HeroStrip (owner). */
function KpiCard({
  label,
  value,
  caption,
  Icon,
  valueClass,
  iconClass,
}: {
  label: string;
  value: number;
  caption: string;
  Icon: ComponentType<{ className?: string }>;
  valueClass?: string;
  iconClass?: string;
}) {
  return (
    <Card className="flex min-h-[140px] flex-col justify-between gap-3 border-border/60 p-5 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
        <Icon
          aria-hidden="true"
          className={cn('size-6 shrink-0 sm:size-7', iconClass)}
        />
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span
          className={cn(
            'text-4xl font-bold leading-none tabular-nums sm:text-5xl',
            valueClass,
          )}
        >
          {formatPlainNumber(value)}
        </span>
        <span className="text-sm text-muted-foreground">{caption}</span>
      </div>
    </Card>
  );
}

export function StoreStockDashboard({ counts }: { counts: StockStatusCounts }) {
  // One bar per status (worst → best). All four show, even at zero, so the
  // axis stays stable. `display` carries the "count · pct" end label.
  const barEntries = STATUS_ORDER.map((key) => ({
    key,
    label: STATUS_META[key].label,
    value: counts[key],
    colour: STATUS_META[key].colour,
    display: `${formatPlainNumber(counts[key])} · ${formatPct(counts[key], counts.total)}`,
  }));

  return (
    <div className="space-y-4">
      {/* KPI cards — a single even strip of 5 (owner: the 3/2 split looked
          lopsided). Collapses to 2/3-up on narrower screens. */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <KpiCard
          label="Umumiy mahsulot soni"
          value={counts.total}
          caption="mahsulot"
          Icon={Package}
          iconClass="text-primary"
        />
        <KpiCard
          label={STATUS_META.below_min.label}
          value={counts.below_min}
          caption="pozitsiya"
          Icon={TrendingDown}
          valueClass={STATUS_META.below_min.value}
          iconClass={STATUS_META.below_min.value}
        />
        <KpiCard
          label={STATUS_META.low.label}
          value={counts.low}
          caption="pozitsiya"
          Icon={AlertTriangle}
          valueClass={STATUS_META.low.value}
          iconClass={STATUS_META.low.value}
        />
        <KpiCard
          label={STATUS_META.out.label}
          value={counts.out}
          caption="pozitsiya"
          Icon={XCircle}
          valueClass={STATUS_META.out.value}
          iconClass={STATUS_META.out.value}
        />
        <KpiCard
          label={STATUS_META.enough.label}
          value={counts.enough}
          caption="pozitsiya"
          Icon={CheckCircle2}
          valueClass={STATUS_META.enough.value}
          iconClass={STATUS_META.enough.value}
        />
      </div>

      {/* Status BAR chart (owner: bar, not donut). One horizontal bar per
          status, coloured by tone, with a "count · %" end label. */}
      <Card className="space-y-4 p-5 sm:p-6">
        <header className="flex items-baseline justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Holat bo‘yicha taqsimot
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Mahsulot holati bo‘yicha · jonli qoldiq
            </p>
          </div>
          <p className="shrink-0 text-sm text-muted-foreground">
            Jami{' '}
            <span className="font-semibold tabular-nums text-foreground">
              {formatPlainNumber(counts.total)}
            </span>
          </p>
        </header>

        {counts.total === 0 ? (
          <p className="text-sm text-muted-foreground">
            Qoldiq ma’lumotlari topilmadi.
          </p>
        ) : (
          <div className="h-[240px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={barEntries}
                layout="vertical"
                margin={{ top: 4, right: 72, bottom: 4, left: 8 }}
                barCategoryGap="28%"
              >
                <CartesianGrid
                  horizontal={false}
                  stroke="hsl(var(--border))"
                  strokeDasharray="3 3"
                />
                <XAxis type="number" hide />
                <YAxis
                  type="category"
                  dataKey="label"
                  width={104}
                  tickLine={false}
                  axisLine={false}
                  tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 13 }}
                />
                <Tooltip
                  cursor={{ fill: 'hsl(var(--muted) / 0.3)' }}
                  contentStyle={barTooltipStyle}
                  itemStyle={{ color: 'hsl(var(--popover-foreground))' }}
                  labelStyle={{ color: 'hsl(var(--popover-foreground))' }}
                  formatter={(v: number) => [formatPlainNumber(v), 'Soni']}
                />
                <Bar
                  dataKey="value"
                  radius={[0, 6, 6, 0]}
                  isAnimationActive={false}
                  barSize={26}
                >
                  {barEntries.map((entry) => (
                    <Cell key={entry.key} fill={entry.colour} />
                  ))}
                  <LabelList
                    dataKey="display"
                    position="right"
                    fill="hsl(var(--foreground))"
                    fontSize={12}
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>
    </div>
  );
}
