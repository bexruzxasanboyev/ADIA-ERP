import { useMemo, type ReactNode } from 'react';
import { ArrowRight, Package } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { formatQtyUnit } from '@/lib/format';
import { pipelineStageOf } from '@/lib/pipeline';
import type { PipelineStage } from '@/lib/types';
import {
  CLOSURE_REASON_LABELS,
  CLOSURE_REASON_VARIANT,
  REQUEST_ORIGIN_LABELS,
  REQUEST_ORIGIN_VARIANT,
  type FlowRequest,
} from '@/lib/replenishmentFlow';

/**
 * The canonical 5-column Kanban board (cross-department-flow §9) shared by every
 * workspace's 📥 Kelgan / 📤 Chiqgan boards. A board is exactly five
 * stage-columns of request cards; each request sits in ONE column resolved by
 * {@link pipelineStageOf} (backend `pipeline_stage`, status fallback). Pure
 * presentation — the parent decides WHICH requests feed it (the 📥/📤 filter)
 * and supplies an optional per-card action via `renderAction`.
 */

/** The five canonical columns, in flow order, with the owner's §9.1 labels. */
const COLUMNS: readonly { stage: PipelineStage; label: string }[] = [
  { stage: 'kutuvda', label: 'Kutuvda' },
  { stage: 'soralgan', label: 'Tayyorlanmoqda' },
  { stage: 'qabul_qilingan', label: 'Tayyor' },
  { stage: 'yuborilgan', label: "Jo‘natildi" },
  { stage: 'yopilgan', label: 'Yopildi' },
];

/** Per-stage column accent (header dot + subtle top rail). */
const STAGE_ACCENT: Record<PipelineStage, string> = {
  kutuvda: 'bg-warning',
  soralgan: 'bg-sky-500',
  qabul_qilingan: 'bg-emerald-500',
  yuborilgan: 'bg-primary',
  yopilgan: 'bg-muted-foreground',
};

export interface RequestKanbanProps {
  /** The requests to lay out across the five columns (already 📥/📤-filtered). */
  requests: FlowRequest[];
  /**
   * Optional per-card trailing action (e.g. "Manba reja" on an incoming
   * production card). Returning `null` renders no action for that card.
   */
  renderAction?: (req: FlowRequest) => ReactNode;
  /** Optional per-card click → navigate to detail (whole card is the target). */
  onOpen?: (req: FlowRequest) => void;
  /** Empty-column copy (defaults to a dash). */
  emptyLabel?: string;
}

export function RequestKanban({
  requests,
  renderAction,
  onOpen,
  emptyLabel,
}: RequestKanbanProps) {
  const byStage = useMemo(() => {
    const map: Record<PipelineStage, FlowRequest[]> = {
      kutuvda: [],
      soralgan: [],
      qabul_qilingan: [],
      yuborilgan: [],
      yopilgan: [],
    };
    for (const req of requests) map[pipelineStageOf(req)].push(req);
    // Newest first within each column.
    for (const stage of Object.keys(map) as PipelineStage[]) {
      map[stage].sort((a, b) => b.id - a.id);
    }
    return map;
  }, [requests]);

  return (
    <div className="scrollbar-thin -mx-1 flex gap-3 overflow-x-auto px-1 pb-2">
      {COLUMNS.map(({ stage, label }) => {
        const items = byStage[stage];
        return (
          <section
            key={stage}
            aria-label={label}
            className="flex w-72 shrink-0 flex-col rounded-xl border border-border/60 bg-muted/20"
          >
            <header className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2.5">
              <span className="flex items-center gap-2 text-sm font-semibold">
                <span
                  aria-hidden="true"
                  className={cn('size-2 rounded-full', STAGE_ACCENT[stage])}
                />
                {label}
              </span>
              <Badge variant="outline" className="tabular-nums">
                {items.length}
              </Badge>
            </header>
            <div className="flex flex-col gap-2 p-2">
              {items.length === 0 ? (
                <p className="px-1 py-6 text-center text-xs text-muted-foreground">
                  {emptyLabel ?? '—'}
                </p>
              ) : (
                items.map((req) => (
                  <RequestCard
                    key={req.id}
                    req={req}
                    action={renderAction?.(req)}
                    onOpen={onOpen ? () => onOpen(req) : undefined}
                  />
                ))
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// RequestCard — one request: product · qty · requester→target · origin badge ·
// closure badge (Yopildi) · brak chip · sub-tree progress chip · action.
// ---------------------------------------------------------------------------

interface RequestCardProps {
  req: FlowRequest;
  action?: ReactNode;
  onOpen?: () => void;
}

export function RequestCard({ req, action, onOpen }: RequestCardProps) {
  const stage = pipelineStageOf(req);
  const origin = req.origin ?? null;
  const closure = stage === 'yopilgan' ? req.closure_reason ?? null : null;
  const brak = req.brak_qty != null && req.brak_qty > 0 ? req.brak_qty : null;
  const openChildren =
    req.open_children_count != null && req.open_children_count > 0
      ? req.open_children_count
      : null;

  const interactive = onOpen !== undefined;

  return (
    <article
      className={cn(
        'rounded-lg border border-border/60 bg-card/70 p-3 text-left shadow-sm transition-colors',
        interactive && 'cursor-pointer hover:border-primary/40 hover:bg-card',
      )}
      onClick={onOpen}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onOpen?.();
              }
            }
          : undefined
      }
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={`So‘rov #${req.id} — ${req.product_name}`}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 text-sm font-semibold leading-tight">
          {req.product_name}
        </p>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          #{req.id}
        </span>
      </div>

      <p className="mt-1 flex items-center gap-1 text-xs tabular-nums text-muted-foreground">
        <Package className="size-3 shrink-0" aria-hidden="true" />
        {formatQtyUnit(req.qty_needed, req.product_unit)}
      </p>

      {/* requester → target */}
      <p className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
        <span className="truncate">{req.requester_location_name}</span>
        <ArrowRight className="size-3 shrink-0" aria-hidden="true" />
        <span className="truncate">{req.target_location_name ?? '—'}</span>
      </p>

      {/* badges row: origin · closure · brak · sub-tree progress */}
      {(origin || closure || brak || openChildren) && (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          {origin && (
            <Badge variant={REQUEST_ORIGIN_VARIANT[origin]} className="text-[10px]">
              {REQUEST_ORIGIN_LABELS[origin]}
            </Badge>
          )}
          {closure && (
            <Badge
              variant={CLOSURE_REASON_VARIANT[closure]}
              className="text-[10px]"
            >
              {CLOSURE_REASON_LABELS[closure]}
            </Badge>
          )}
          {brak !== null && (
            <Badge variant="danger" className="text-[10px] tabular-nums">
              brak {formatQtyUnit(brak, req.product_unit)}
            </Badge>
          )}
          {openChildren !== null && (
            <Badge variant="outline" className="text-[10px] tabular-nums">
              bolalar: {openChildren}
            </Badge>
          )}
        </div>
      )}

      {action && <div className="mt-2 flex justify-end">{action}</div>}
    </article>
  );
}
