import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, RefreshCcw } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/PageState';
import { formatQty, formatRelative } from '@/lib/format';
import {
  POSTER_SYNC_STATUS_LABELS,
  POSTER_SYNC_STATUS_VARIANT,
} from '@/lib/labels';
import type { DashboardPosterStatus } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * F4.4 — Poster POS sync status card (phase-4.md §2.4).
 *
 * Renders a compact panel summarising the most recent Poster sync run
 * plus today's sales counters. The whole card links to the import-warnings
 * admin page so the PM can drill into any error encountered during the
 * last 24h.
 */
export function PosterStatusCard({
  status,
  className,
}: {
  status: DashboardPosterStatus | null;
  className?: string;
}) {
  const hasErrors = status !== null && status.sync_errors_24h > 0;

  return (
    <Card className={cn('flex flex-col', className)}>
      <header className="flex items-center justify-between gap-3 border-b border-border/60 p-5">
        <div className="space-y-0.5">
          <h2 className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            <RefreshCcw className="size-4 text-primary" aria-hidden="true" />
            Poster sync
          </h2>
          <p className="text-xs text-muted-foreground">
            POS sinxronizatsiyasi va bugungi savdo.
          </p>
        </div>
        <Link
          to="/admin/import-warnings"
          className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          Xatoliklar
          <ArrowRight className="size-3" aria-hidden="true" />
        </Link>
      </header>

      {status === null ? (
        <EmptyState message="Hozircha sinxronizatsiya ma’lumoti yo‘q." />
      ) : (
        <div className="grid grid-cols-2 gap-4 p-5 text-sm">
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Oxirgi sinxron
            </p>
            <p
              className="font-medium tabular-nums"
              data-testid="poster-last-sync"
            >
              {formatRelative(status.last_sync_at)}
            </p>
            <div className="pt-1">
              {status.last_sync_status === null ? (
                <Badge variant="outline">—</Badge>
              ) : (
                <Badge
                  variant={POSTER_SYNC_STATUS_VARIANT[status.last_sync_status]}
                >
                  {POSTER_SYNC_STATUS_LABELS[status.last_sync_status]}
                </Badge>
              )}
            </div>
          </div>

          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              24h xatoliklar
            </p>
            <p
              className={cn(
                'text-2xl font-semibold tabular-nums tracking-tight',
                hasErrors ? 'text-destructive' : 'text-foreground',
              )}
              data-testid="poster-error-count"
            >
              {formatQty(status.sync_errors_24h)}
            </p>
            {hasErrors && (
              <p className="flex items-center gap-1 text-xs text-destructive">
                <AlertTriangle className="size-3" aria-hidden="true" />
                Xatoliklarni ko‘rib chiqing
              </p>
            )}
          </div>

          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Bugun cheklar
            </p>
            <p className="text-2xl font-semibold tabular-nums tracking-tight">
              {formatQty(status.sales_today_count)}
            </p>
          </div>

          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Bugun savdo
            </p>
            <p className="text-2xl font-semibold tabular-nums tracking-tight">
              {formatQty(status.sales_today_sum)}
            </p>
          </div>
        </div>
      )}
    </Card>
  );
}
