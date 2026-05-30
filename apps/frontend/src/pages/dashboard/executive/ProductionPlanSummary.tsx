import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, CalendarClock, Factory } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/PageState';
import {
  PRODUCTION_ORDER_STATUS_LABELS,
  PRODUCTION_ORDER_STATUS_VARIANT,
} from '@/lib/labels';
import { formatQty } from '@/lib/format';
import type {
  DashboardProductionPlanItem,
  ProductionOrderStatus,
} from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * ProductionPlanSummary — above-the-fold digest of today's production plan.
 *
 * The owner wants the most action-driving blocks in the first view. The
 * full plan table still lives below the fold (`DashboardSecondaryRow`);
 * this card answers the at-a-glance question — "is today's plan on
 * track?" — with status counts and the next three deadlines, then links
 * out to the full board.
 */
const STATUS_PILL_ORDER: readonly ProductionOrderStatus[] = [
  'new',
  'in_progress',
  'done',
] as const;

export interface ProductionPlanSummaryProps {
  items: DashboardProductionPlanItem[];
  className?: string;
}

export function ProductionPlanSummary({
  items,
  className,
}: ProductionPlanSummaryProps) {
  const counts = useMemo(() => {
    const acc: Record<ProductionOrderStatus, number> = {
      new: 0,
      in_progress: 0,
      done: 0,
      cancelled: 0,
    };
    for (const item of items) acc[item.status] += 1;
    return acc;
  }, [items]);

  // The next deadlines first; `null` deadlines (undated) sink to the
  // bottom so the owner sees the most time-pressured work up top.
  const upcoming = useMemo(
    () =>
      [...items]
        .filter((item) => item.status !== 'done' && item.status !== 'cancelled')
        .sort((a, b) => {
          if (a.deadline === b.deadline) return 0;
          if (a.deadline === null) return 1;
          if (b.deadline === null) return -1;
          return a.deadline < b.deadline ? -1 : 1;
        })
        .slice(0, 3),
    [items],
  );

  return (
    <Card className={cn('flex h-full flex-col', className)}>
      <header className="flex items-center justify-between gap-3 border-b border-border/60 p-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Factory className="size-4 text-primary" aria-hidden="true" />
          Bugungi ishlab chiqarish
        </h2>
        <Link
          to="/production-orders"
          className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          Reja
          <ArrowRight className="size-3" aria-hidden="true" />
        </Link>
      </header>

      {items.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-4">
          <EmptyState message="Bugungi reja bo'sh." />
        </div>
      ) : (
        <div className="flex flex-1 flex-col gap-3 p-4">
          <div className="flex flex-wrap gap-2" data-testid="prod-summary-counts">
            {STATUS_PILL_ORDER.map((status) => (
              <Badge
                key={status}
                variant={PRODUCTION_ORDER_STATUS_VARIANT[status]}
                className="gap-1.5"
              >
                <span className="tabular-nums">{formatQty(counts[status])}</span>
                {PRODUCTION_ORDER_STATUS_LABELS[status]}
              </Badge>
            ))}
          </div>

          <ul className="space-y-1.5">
            {upcoming.map((item) => (
              <li
                key={item.id}
                className="flex items-center justify-between gap-2 rounded-md border border-border/40 bg-surface-2/30 px-2.5 py-1.5 text-xs"
              >
                <span className="min-w-0 truncate font-medium">
                  {item.product_name}
                </span>
                <span className="flex shrink-0 items-center gap-2 text-muted-foreground">
                  <span className="tabular-nums">{formatQty(item.qty)}</span>
                  <span className="inline-flex items-center gap-1 tabular-nums">
                    <CalendarClock className="size-3" aria-hidden="true" />
                    {item.deadline ?? '—'}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
