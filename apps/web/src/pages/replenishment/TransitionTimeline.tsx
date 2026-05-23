import { ArrowRight, Circle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { formatDateTime } from '@/lib/format';
import {
  REPLENISHMENT_STATUS_LABELS,
  REPLENISHMENT_STATUS_VARIANT,
} from '@/lib/labels';
import type { ReplenishmentTransition } from '@/lib/types';

interface TransitionTimelineProps {
  transitions: ReplenishmentTransition[];
}

/**
 * Vertical state-machine timeline. Each entry is one row in
 * `replenishment_transitions` and shows kim/qachon/qaysidan-qayerga.
 *
 * `actor_name` is embedded by `GET /api/replenishment/:id` (JOIN users)
 * so the component no longer needs a `users` prop — system/cron rows
 * arrive with `actor_name = null` and render as "Tizim".
 *
 * The visual hierarchy follows the dark-premium aesthetic: an indented
 * timeline rail on the left, status badges for from→to, and a quiet
 * actor/reason caption.
 */
export function TransitionTimeline({ transitions }: TransitionTimelineProps) {
  if (transitions.length === 0) {
    return (
      <p className="px-4 py-6 text-sm text-muted-foreground">
        O‘tishlar tarixi bo‘sh.
      </p>
    );
  }

  return (
    <ol className="relative space-y-4 px-4 py-4" aria-label="O‘tishlar tarixi">
      {transitions.map((t, idx) => {
        const isLast = idx === transitions.length - 1;
        const actorLabel =
          t.actor_name ?? (t.actor_user_id == null ? 'Tizim' : `#${t.actor_user_id}`);
        return (
          <li key={t.id} className="relative flex gap-4 pl-2">
            {/* The vertical rail */}
            {!isLast && (
              <span
                aria-hidden="true"
                className="absolute left-[14px] top-7 h-[calc(100%-0.5rem)] w-px bg-border"
              />
            )}
            <Circle
              className={cn(
                'mt-1 size-4 shrink-0',
                isLast ? 'fill-primary stroke-primary' : 'fill-muted stroke-muted-foreground',
              )}
              aria-hidden="true"
            />
            <div className="flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                {t.from_status === null ? (
                  <Badge variant="outline">Yaratilish</Badge>
                ) : (
                  <Badge variant={REPLENISHMENT_STATUS_VARIANT[t.from_status]}>
                    {REPLENISHMENT_STATUS_LABELS[t.from_status]}
                  </Badge>
                )}
                <ArrowRight className="size-4 text-muted-foreground" aria-hidden="true" />
                <Badge variant={REPLENISHMENT_STATUS_VARIANT[t.to_status]}>
                  {REPLENISHMENT_STATUS_LABELS[t.to_status]}
                </Badge>
              </div>
              <div className="text-xs text-muted-foreground">
                <span>{actorLabel}</span>
                <span aria-hidden="true"> · </span>
                <span>{formatDateTime(t.created_at)}</span>
                {t.reason && (
                  <>
                    <span aria-hidden="true"> · </span>
                    <span>{t.reason}</span>
                  </>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
