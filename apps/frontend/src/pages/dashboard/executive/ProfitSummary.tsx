import { TrendingUp } from 'lucide-react';
import { formatPlainNumber } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Profit / margin summary footer for the MOLIYA row (left column, under the
 * revenue donut). Surfaces this month's profit and margin computed from
 * `GET /api/kpi/products`:
 *
 *   margin = totalRevenue > 0 ? totalProfit / totalRevenue : null
 *
 * The KPI endpoint is pm-only → it 403s for `ai_assistant`. When the figures
 * are unavailable (`available === false`) the whole footer is hidden so the
 * donut stands alone — no half-empty placeholder.
 */
export interface ProfitSummaryProps {
  /** False when the KPI query errored / 403'd — hides the footer entirely. */
  available: boolean;
  totalProfit: number;
  totalRevenue: number;
  /** `totalProfit / totalRevenue`, or null when revenue is 0. */
  margin: number | null;
  className?: string;
}

function formatPct(margin: number | null): string {
  if (margin === null || !Number.isFinite(margin)) return '—';
  const pct = margin * 100;
  return `${(Math.round(pct * 10) / 10).toLocaleString('uz-UZ')}%`;
}

export function ProfitSummary({
  available,
  totalProfit,
  totalRevenue,
  margin,
  className,
}: ProfitSummaryProps) {
  if (!available) return null;

  const marginTone =
    margin === null
      ? 'text-foreground'
      : margin >= 0.2
        ? 'text-success'
        : margin > 0
          ? 'text-warning'
          : 'text-destructive';

  return (
    <div
      data-testid="profit-summary"
      className={cn(
        'grid grid-cols-3 gap-3 border-t border-border/40 pt-4',
        className,
      )}
    >
      <Metric
        label="Oylik tushum"
        value={formatPlainNumber(totalRevenue)}
        unit="so'm"
      />
      <Metric
        label="Oylik foyda"
        value={formatPlainNumber(totalProfit)}
        unit="so'm"
        valueClass={totalProfit >= 0 ? 'text-foreground' : 'text-destructive'}
      />
      <Metric
        label="Marja"
        value={formatPct(margin)}
        valueClass={marginTone}
        Icon={TrendingUp}
      />
    </div>
  );
}

function Metric({
  label,
  value,
  unit,
  valueClass,
  Icon,
}: {
  label: string;
  value: string;
  unit?: string;
  valueClass?: string;
  Icon?: typeof TrendingUp;
}) {
  return (
    <div className="min-w-0">
      <p className="flex items-center gap-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {Icon && <Icon aria-hidden="true" className="size-3" />}
        {label}
      </p>
      <p
        className={cn(
          'mt-1 truncate text-2xl font-semibold tabular-nums tracking-tight',
          valueClass ?? 'text-foreground',
        )}
      >
        {value}
        {unit && (
          <span className="ml-1 text-xs font-normal text-muted-foreground">
            {unit}
          </span>
        )}
      </p>
    </div>
  );
}
