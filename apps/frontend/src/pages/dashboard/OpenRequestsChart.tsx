import { Cell, Pie, PieChart, ResponsiveContainer } from 'recharts';
import {
  REPLENISHMENT_STATUS_LABELS,
  REPLENISHMENT_STATUS_VARIANT,
} from '@/lib/labels';
import { formatQty } from '@/lib/format';
import type { ReplenishmentStatus } from '@/lib/types';

/**
 * Maps a status badge variant to a CSS HSL token reference. The chart
 * pulls the same hues used in `<Badge>` so the legend and slice colours
 * agree. Recharts cannot read `var(--token)` indirectly (the `fill` value
 * is passed straight to SVG), so we read from the computed style if the
 * `--*` token is defined; otherwise we fall back to literal HSL strings
 * mirroring `index.css`. The fallback keeps colours sensible inside
 * jsdom tests where computed CSS variables resolve to an empty string.
 */
type BadgeVariant = (typeof REPLENISHMENT_STATUS_VARIANT)[ReplenishmentStatus];

const VARIANT_TOKEN: Record<BadgeVariant, { token: string; fallback: string }> = {
  default: { token: '--info', fallback: 'hsl(200 88% 56%)' },
  outline: { token: '--muted-foreground', fallback: 'hsl(220 9% 64%)' },
  success: { token: '--success', fallback: 'hsl(152 56% 48%)' },
  warning: { token: '--warning', fallback: 'hsl(28 90% 58%)' },
  danger: { token: '--destructive', fallback: 'hsl(0 84% 60%)' },
};

interface ChartEntry {
  status: ReplenishmentStatus;
  label: string;
  value: number;
  colour: string;
}

function resolveColour(token: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const root = document.documentElement;
  const raw = getComputedStyle(root).getPropertyValue(token).trim();
  return raw === '' ? fallback : `hsl(${raw})`;
}

function buildEntries(
  entries: [ReplenishmentStatus, number][],
): ChartEntry[] {
  return entries
    .filter(([, value]) => value > 0)
    .map(([status, value]) => {
      const variant = REPLENISHMENT_STATUS_VARIANT[status];
      const { token, fallback } = VARIANT_TOKEN[variant];
      return {
        status,
        label: REPLENISHMENT_STATUS_LABELS[status],
        value,
        colour: resolveColour(token, fallback),
      };
    })
    .sort((a, b) => b.value - a.value);
}

/** Share of total as a compact percentage (mirrors RevenueBreakdown). */
function formatPct(part: number, total: number): string {
  if (total <= 0 || !Number.isFinite(part)) return '0%';
  const pct = (part / total) * 100;
  return `${pct >= 10 ? Math.round(pct) : pct.toFixed(1)}%`;
}

/**
 * Donut chart + textual legend for the open-requests-by-status
 * aggregate. Styled to mirror the dashboard's revenue-breakdown card: the
 * donut sits on the LEFT with the total in its centre, and a compact
 * legend table on the RIGHT lists every status as `label | count | share`.
 * The legend is the accessible source of truth — the SVG is decorative — so
 * screen readers and the contract test read the data without the chart.
 */
export function OpenRequestsChart({
  entries,
  total,
}: {
  entries: [ReplenishmentStatus, number][];
  total: number;
}) {
  const chartEntries = buildEntries(entries);

  return (
    <div className="flex flex-col gap-8 sm:flex-row sm:items-center sm:gap-10">
      {/* LEFT — donut with the total in the centre. */}
      <div
        className="relative mx-auto h-[220px] w-[220px] shrink-0 sm:mx-0 lg:h-[240px] lg:w-[240px]"
        aria-hidden="true"
      >
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={chartEntries}
              dataKey="value"
              nameKey="label"
              innerRadius="58%"
              outerRadius="88%"
              paddingAngle={2}
              stroke="hsl(var(--card))"
              strokeWidth={2}
              isAnimationActive={false}
            >
              {chartEntries.map((entry) => (
                <Cell key={entry.status} fill={entry.colour} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-3xl font-semibold leading-none tabular-nums tracking-tight">
            {formatQty(total)}
          </span>
          <span className="mt-1.5 text-xs text-muted-foreground">jami</span>
        </div>
      </div>

      {/* RIGHT — compact legend table, one row per status. */}
      <ul
        className="w-full flex-1 space-y-3.5"
        data-testid="open-requests-legend"
      >
        {chartEntries.map((entry) => (
          <li
            key={entry.status}
            className="grid grid-cols-[1fr_auto_48px] items-baseline gap-x-4"
          >
            <span className="flex min-w-0 items-center gap-2.5">
              <span
                aria-hidden="true"
                className="size-3 shrink-0 translate-y-px rounded-sm"
                style={{ background: entry.colour }}
              />
              <span className="truncate text-base text-foreground">
                {entry.label}
              </span>
            </span>
            <span className="text-right text-base font-semibold tabular-nums sm:text-lg">
              {formatQty(entry.value)}
            </span>
            <span className="text-right text-sm tabular-nums text-muted-foreground">
              {formatPct(entry.value, total)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
