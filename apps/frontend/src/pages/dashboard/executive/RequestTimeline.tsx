import type { ReplenishmentDetail, ReplenishmentStatus } from '@/lib/types';
import { describeStatus } from './requestTracer';
import { formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * EcosystemCanvas — bottom-of-side-panel timeline.
 *
 * Renders the status history of the selected replenishment request as
 * a compact vertical list. Each row carries the status name (Uzbek),
 * the actor (or "tizim" for system-driven transitions), and a relative
 * timestamp. The most-recent row is highlighted.
 *
 * The data is the `transitions[]` array returned by
 * `GET /api/replenishment/:id` — the backend already joins users so we
 * never need an extra fetch.
 */
export interface RequestTimelineProps {
  detail: ReplenishmentDetail | null;
  isLoading?: boolean;
  className?: string;
}

export function RequestTimeline({
  detail,
  isLoading = false,
  className,
}: RequestTimelineProps) {
  if (detail === null) {
    return (
      <div
        className={cn(
          'rounded-xl border border-border/60 bg-card p-4',
          className,
        )}
        data-testid="request-timeline-empty"
      >
        <p className="text-xs text-muted-foreground">
          Canvas yo'lini ko'rish uchun chap tomondan so'rovni tanlang.
        </p>
      </div>
    );
  }

  const sorted = [...detail.transitions].sort((a, b) => a.id - b.id);
  const latestIdx = sorted.length - 1;

  return (
    <section
      data-testid="request-timeline"
      aria-label="So'rov tarixi"
      className={cn(
        'rounded-xl border border-border/60 bg-card',
        className,
      )}
    >
      <header className="flex items-center justify-between border-b border-border/40 px-4 py-2.5">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Tarix
        </h3>
        <span className="text-xs text-muted-foreground tabular-nums">
          #{detail.request.id}
        </span>
      </header>

      <div className="max-h-[280px] overflow-y-auto px-3 py-3">
        {isLoading && sorted.length === 0 ? (
          <p className="px-1 py-3 text-center text-xs text-muted-foreground">
            Yuklanmoqda…
          </p>
        ) : sorted.length === 0 ? (
          <p className="px-1 py-3 text-center text-xs text-muted-foreground">
            Hozircha tarix yo'q.
          </p>
        ) : (
          <ol className="relative flex flex-col gap-3">
            {/* Vertical rail */}
            <span
              aria-hidden="true"
              className="absolute left-[7px] top-1 bottom-1 w-px bg-border/60"
            />
            {sorted.map((t, i) => {
              const isLatest = i === latestIdx;
              return (
                <li
                  key={t.id}
                  data-testid={`timeline-step-${t.id}`}
                  data-latest={isLatest ? 'true' : 'false'}
                  className="relative flex items-start gap-3 pl-5"
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      'absolute left-0 top-1 size-3.5 rounded-full border-2',
                      isLatest
                        ? 'animate-pulse border-warning bg-warning/30'
                        : 'border-success/70 bg-success/20',
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <p
                      className={cn(
                        'text-[13px] font-medium leading-tight',
                        isLatest ? 'text-warning' : 'text-foreground',
                      )}
                    >
                      {describeStatus(
                        t.to_status as ReplenishmentStatus,
                        detail.request.production_location_name,
                      )}
                    </p>
                    <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                      {t.actor_name ?? 'tizim'} · {formatRelative(t.created_at)}
                    </p>
                    {t.reason ? (
                      <p className="mt-0.5 truncate text-[11px] italic text-muted-foreground/80">
                        {t.reason}
                      </p>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </section>
  );
}
