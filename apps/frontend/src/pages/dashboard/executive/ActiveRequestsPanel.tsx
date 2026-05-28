import { useMemo } from 'react';
import type {
  ReplenishmentRequest,
  ReplenishmentStatus,
} from '@/lib/types';
import { describeStatus } from './requestTracer';
import { cn } from '@/lib/utils';

/**
 * EcosystemCanvas — right-side panel listing every open replenishment
 * request the principal can see. Clicking a card sets the canvas
 * `selectedRequestId`; the canvas then loads the trace and lights up
 * the path. The selected card carries a left accent strip.
 *
 * The list is RBAC-scoped by the backend — we just render whatever
 * `GET /api/replenishment?status=NEW,...` returned. Closed/cancelled
 * requests are intentionally excluded so the panel stays focused on
 * the live work.
 *
 * Sort order: oldest first (FIFO) — the owner triages the longest-
 * waiting requests first. Terminal statuses are filtered out client-
 * side as a safety net.
 */
export interface ActiveRequestsPanelProps {
  requests: ReplenishmentRequest[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  isLoading?: boolean;
  className?: string;
}

const TERMINAL: ReadonlySet<ReplenishmentStatus> = new Set([
  'CLOSED',
  'CANCELLED',
]);

export function ActiveRequestsPanel({
  requests,
  selectedId,
  onSelect,
  isLoading = false,
  className,
}: ActiveRequestsPanelProps) {
  const sorted = useMemo(
    () =>
      requests
        .filter((r) => !TERMINAL.has(r.status))
        .slice()
        .sort((a, b) => a.created_at.localeCompare(b.created_at)),
    [requests],
  );

  return (
    <aside
      data-testid="active-requests-panel"
      aria-label="Faol so'rovlar ro'yxati"
      className={cn(
        'flex h-full w-[320px] flex-col rounded-xl border border-border/60 bg-card',
        className,
      )}
    >
      <header className="flex items-center justify-between border-b border-border/40 px-4 py-2.5">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Faol so'rovlar
        </h3>
        <span className="text-xs text-muted-foreground tabular-nums">
          {sorted.length}
        </span>
      </header>

      <div className="flex-1 overflow-y-auto px-2 py-2">
        {isLoading && sorted.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            Yuklanmoqda…
          </p>
        ) : sorted.length === 0 ? (
          <p
            className="px-2 py-6 text-center text-xs text-muted-foreground"
            data-testid="active-requests-empty"
          >
            Hozircha ochiq so'rov yo'q.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {sorted.map((req) => {
              const active = req.id === selectedId;
              return (
                <li key={req.id}>
                  <button
                    type="button"
                    data-testid={`active-request-${req.id}`}
                    data-state={active ? 'selected' : 'idle'}
                    onClick={() => onSelect(active ? null : req.id)}
                    className={cn(
                      'group relative w-full overflow-hidden rounded-md border px-3 py-2 text-left outline-none transition-colors',
                      'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                      active
                        ? 'border-primary/60 bg-primary/5 shadow-sm'
                        : 'border-border/40 bg-card hover:bg-surface-3',
                    )}
                  >
                    {/* Left accent strip — visible only on the active row */}
                    <span
                      aria-hidden="true"
                      className={cn(
                        'absolute inset-y-0 left-0 w-1 rounded-l-md transition-colors',
                        active ? 'bg-primary' : 'bg-transparent',
                      )}
                    />
                    <div className="flex items-baseline justify-between gap-2 pl-1">
                      <p className="truncate text-[13px] font-semibold text-foreground">
                        {req.requester_location_name}
                      </p>
                      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                        #{req.id}
                      </span>
                    </div>
                    <p className="truncate pl-1 text-xs text-muted-foreground">
                      {req.product_name} · {formatQty(req.qty_needed)}{' '}
                      {req.product_unit}
                    </p>
                    <p
                      className={cn(
                        'mt-1 truncate pl-1 text-[11px] font-medium uppercase tracking-wider',
                        statusToneClass(req.status),
                      )}
                    >
                      {describeStatus(req.status, req.production_location_name)}
                    </p>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}

function formatQty(n: number): string {
  return new Intl.NumberFormat('uz-Latn-UZ', {
    maximumFractionDigits: 2,
  }).format(n);
}

function statusToneClass(status: ReplenishmentStatus): string {
  switch (status) {
    case 'NEW':
      return 'text-muted-foreground';
    case 'CHECK_STORE_SUPPLIER':
    case 'CHECK_PRODUCTION_INPUT':
    case 'CREATE_PURCHASE_ORDER':
    case 'CREATE_PRODUCTION_ORDER':
      return 'text-warning';
    case 'SHIP_TO_REQUESTER':
    case 'PRODUCING':
    case 'DONE_TO_WAREHOUSE':
      return 'text-chain-production';
    case 'CLOSED':
      return 'text-success';
    case 'CANCELLED':
      return 'text-destructive';
  }
}
