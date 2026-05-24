import { Bell } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/PageState';
import { dashboardAlertTypeLabel } from '@/lib/labels';
import { formatRelative } from '@/lib/format';
import type { AlertSeverity, DashboardAlert } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * F4.4 — Real-time alerts feed (phase-4.md §2.4).
 *
 * Lists the 20 most recent notifications surfaced to the current user
 * (RBAC-scoped on the backend). Each row carries:
 *   - a severity dot (red / yellow / blue);
 *   - the type label (Uzbek);
 *   - the message body;
 *   - the location name (when scoped);
 *   - relative time.
 */
const FEED_LIMIT = 20;

const SEVERITY_VARIANT: Record<AlertSeverity, 'danger' | 'warning' | 'info'> = {
  danger: 'danger',
  warning: 'warning',
  info: 'info',
};

const SEVERITY_DOT: Record<AlertSeverity, string> = {
  danger: 'bg-destructive',
  warning: 'bg-warning',
  info: 'bg-info',
};

export function AlertsFeed({
  alerts,
  className,
}: {
  alerts: DashboardAlert[];
  className?: string;
}) {
  const rows = alerts.slice(0, FEED_LIMIT);

  return (
    <Card className={cn('flex flex-col', className)}>
      <header className="flex items-center justify-between gap-3 border-b border-border/60 p-5">
        <div className="space-y-0.5">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Bell className="size-4 text-primary" aria-hidden="true" />
            Ogohlantirishlar
          </h2>
          <p className="text-xs text-muted-foreground">
            So‘nggi {rows.length} ta tizim ogohlantirishi.
          </p>
        </div>
        {rows.length > 0 && (
          <Badge variant="outline" className="tabular-nums">
            {rows.length}
          </Badge>
        )}
      </header>

      {rows.length === 0 ? (
        <EmptyState message="Hozircha ogohlantirishlar yo‘q." />
      ) : (
        <ol
          className="max-h-[420px] divide-y divide-border/60 overflow-y-auto"
          data-testid="alerts-feed"
        >
          {rows.map((alert) => (
            <li
              key={alert.id}
              className="flex items-start gap-3 px-5 py-3 text-sm"
              data-severity={alert.severity}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'mt-1.5 size-2 shrink-0 rounded-full',
                  SEVERITY_DOT[alert.severity],
                )}
              />
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    variant={SEVERITY_VARIANT[alert.severity]}
                    className="px-1.5 py-0 text-[10px]"
                  >
                    {dashboardAlertTypeLabel(alert.type)}
                  </Badge>
                  {alert.location_name && (
                    <span className="text-xs text-muted-foreground">
                      {alert.location_name}
                    </span>
                  )}
                </div>
                <p className="break-words text-sm text-foreground">
                  {alert.message}
                </p>
              </div>
              <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground tabular-nums">
                {formatRelative(alert.created_at)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
