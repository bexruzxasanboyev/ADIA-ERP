import { Link } from 'react-router-dom';
import { AlertOctagon, ArrowRight, CheckCircle2 } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatQty } from '@/lib/format';
import { UNIT_LABELS } from '@/lib/labels';
import type {
  DashboardAlert,
  DashboardBelowMinItem,
} from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * F4.7 — Critical alerts panel (top 3 prioritised).
 *
 * Composes the most urgent items from two sources:
 *   1. `below_min` rows where `qty === 0`            (out of stock)
 *   2. `below_min` rows where `qty < min_level * .5` (deep below min)
 *   3. `alerts_feed` with severity `danger`
 *   4. remaining `below_min` rows
 *   5. `alerts_feed` with severity `warning`
 *
 * Anything below the visible cap is hinted via the footer link.
 */
const TOP_LIMIT = 3;

interface CriticalRow {
  key: string;
  title: string;
  sub: string;
  href: string;
}

function buildRows(
  belowMin: DashboardBelowMinItem[],
  alerts: DashboardAlert[],
): CriticalRow[] {
  const zero = belowMin.filter((b) => b.qty === 0);
  const deep = belowMin.filter(
    (b) => b.qty > 0 && b.qty < (b.min_level ?? 0) * 0.5,
  );
  const remaining = belowMin.filter(
    (b) => !zero.includes(b) && !deep.includes(b),
  );
  const danger = alerts.filter((a) => a.severity === 'danger');
  const warning = alerts.filter((a) => a.severity === 'warning');

  const rows: CriticalRow[] = [];
  for (const b of zero) {
    rows.push(belowMinRow(b, 'Tugadi'));
  }
  for (const b of deep) {
    rows.push(belowMinRow(b, 'Tanqidiy darajada past'));
  }
  for (const a of danger) {
    rows.push({
      key: `alert-${a.id}`,
      title: a.message,
      sub: a.location_name ?? '',
      href: '/replenishment',
    });
  }
  for (const b of remaining) {
    rows.push(belowMinRow(b, 'Min’dan past'));
  }
  for (const a of warning) {
    rows.push({
      key: `alert-${a.id}`,
      title: a.message,
      sub: a.location_name ?? '',
      href: '/replenishment',
    });
  }
  return rows;
}

function belowMinRow(
  item: DashboardBelowMinItem,
  status: string,
): CriticalRow {
  const unit = UNIT_LABELS[item.product_unit];
  return {
    key: `below-${item.location_id}-${item.product_id}`,
    title: item.product_name,
    sub: `${item.location_name} · ${formatQty(item.qty)} ${unit} / min ${formatQty(item.min_level)} · ${status}`,
    href:
      item.open_request_id !== null
        ? `/replenishment/${item.open_request_id}`
        : '/replenishment',
  };
}

export function CriticalAlerts({
  belowMin,
  alerts,
  className,
}: {
  belowMin: DashboardBelowMinItem[];
  alerts: DashboardAlert[];
  className?: string;
}) {
  const rows = buildRows(belowMin, alerts);
  const top = rows.slice(0, TOP_LIMIT);
  const overflow = rows.length - top.length;

  return (
    <Card
      className={cn('flex flex-col', className)}
      data-testid="critical-alerts"
    >
      <header className="flex items-center justify-between gap-3 border-b border-border/60 p-5">
        <div className="space-y-0.5">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <AlertOctagon
              className="size-4 text-destructive"
              aria-hidden="true"
            />
            Kritik signallar
          </h2>
          <p className="text-xs text-muted-foreground">
            Eng yuqori ustuvorlikdagi vaziyatlar.
          </p>
        </div>
        {rows.length > 0 && (
          <Badge variant="danger" className="tabular-nums">
            {formatQty(rows.length)}
          </Badge>
        )}
      </header>

      {rows.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <CheckCircle2
            className="size-8 text-success"
            aria-hidden="true"
          />
          <p className="text-sm text-muted-foreground">
            Hammasi me’yorda.
          </p>
        </div>
      ) : (
        <ol className="flex-1 divide-y divide-border/60">
          {top.map((row) => (
            <li key={row.key} className="px-5 py-3">
              <Link
                to={row.href}
                className="group flex items-start gap-3 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                <span
                  aria-hidden="true"
                  className="mt-1.5 inline-flex size-2.5 shrink-0 rounded-full bg-destructive ring-2 ring-destructive/20"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground group-hover:text-primary">
                    {row.title}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {row.sub}
                  </p>
                </div>
                <ArrowRight
                  className="size-4 shrink-0 text-muted-foreground opacity-0 transition group-hover:opacity-100"
                  aria-hidden="true"
                />
              </Link>
            </li>
          ))}
        </ol>
      )}

      {overflow > 0 && (
        <footer className="border-t border-border/60 px-5 py-3 text-center text-xs">
          <Link
            to="/replenishment"
            className="font-medium text-primary hover:underline"
          >
            Yana {formatQty(overflow)} ta →
          </Link>
        </footer>
      )}
    </Card>
  );
}
