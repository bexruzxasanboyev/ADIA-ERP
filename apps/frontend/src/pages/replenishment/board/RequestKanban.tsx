import { useMemo, type ReactNode } from 'react';
import { ArrowRight, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { formatDate, formatQtyUnit } from '@/lib/format';
import { kanbanColumnOf, pipelineStageOf } from '@/lib/pipeline';
import {
  actionOwnerOf,
  CLOSURE_REASON_LABELS,
  CLOSURE_REASON_VARIANT,
  isRawPosterWaiting,
  KANBAN_COLUMNS,
  qtyChipFor,
  REQUEST_ORIGIN_LABELS,
  REQUEST_ORIGIN_VARIANT,
  waitingOnLabel,
  type FlowRequest,
  type KanbanColumn,
} from '@/lib/replenishmentFlow';

/**
 * Viewer context for the ACTION-OWNERSHIP signal (phase F-M). The board side
 * ('incoming' = men ta'minotchiman, 'outgoing' = men so'rovchiman) plus the
 * viewer's location ids decide whether a card's next action is MINE
 * ("Harakat sizda", full strength) or the OTHER side's ("… kutilmoqda", dimmed).
 * Absent → the signal is off (e.g. the mixed /replenishment Doska).
 */
export interface BoardViewerContext {
  side: 'incoming' | 'outgoing';
  /** The viewer's own location ids (otdel/sklad/do'kon scope). */
  scope: ReadonlySet<number>;
}

/**
 * The Jira-like 6-column Kanban board (phase F-G §2) shared by every
 * workspace's 📥 Kelgan / 📤 Chiqgan boards. A board is exactly six
 * stage-columns of request cards; each request sits in ONE column resolved by
 * {@link kanbanColumnOf} (backend `pipeline_stage` + the client "Tasdiqlandi"
 * split on `fulfiller_accepted_at`). Pure presentation — the parent decides
 * WHICH requests feed it (the 📥/📤 filter) and what a click does (`onOpen`,
 * which opens the shared RequestDetailModal everywhere).
 *
 * Look: a left accent rail per column colour, a tidy header with a count badge,
 * horizontal scroll with a fixed min column width, an empty-column placeholder,
 * and a hover-lift on each (clickable) card.
 */

/** Per-column left-rail / header-dot accent — keyed off the 6-column list. */
const COLUMN_ACCENT: Record<KanbanColumn, string> = KANBAN_COLUMNS.reduce(
  (acc, c) => {
    acc[c.column] = c.accent;
    return acc;
  },
  {} as Record<KanbanColumn, string>,
);

export interface RequestKanbanProps {
  /** The requests to lay out across the six columns (already 📥/📤-filtered). */
  requests: FlowRequest[];
  /**
   * Optional per-card trailing action (e.g. "Manba reja" on an incoming
   * production card). Returning `null` renders no action for that card.
   */
  renderAction?: (req: FlowRequest) => ReactNode;
  /** Per-card click → open the detail modal (the whole card is the target). */
  onOpen?: (req: FlowRequest) => void;
  /** Empty-column copy (defaults to a dash). */
  emptyLabel?: string;
  /**
   * FULL-AREA mode (owner: "kanban full egallab tursin") — the board fills its
   * parent's height, the six columns flex-grow to share the full width
   * (min 16rem each, horizontal scroll only when even that does not fit) and
   * EACH COLUMN scrolls its own card list under a fixed header, Jira-style.
   * Off (default) keeps the compact embedded look: fixed 18rem columns, the
   * page scrolls as a whole.
   */
  fill?: boolean;
  /** F-M action-ownership signal — see {@link BoardViewerContext}. */
  viewer?: BoardViewerContext;
  /**
   * F-N per-host column label overrides (owner: "logikani soddalashtir") — the
   * UNIFIED grammar stays, but a host may re-voice a column for its audience
   * (the store reads Jo'natildi as «Keldi — qabul qiling»). Sparse map; absent
   * keys keep the canonical label.
   */
  columnLabels?: Partial<Record<KanbanColumn, string>>;
}

export function RequestKanban({
  requests,
  renderAction,
  onOpen,
  emptyLabel,
  fill = false,
  viewer,
  columnLabels,
}: RequestKanbanProps) {
  const byColumn = useMemo(() => {
    const map: Record<KanbanColumn, FlowRequest[]> = {
      kutuvda: [],
      tasdiqlandi: [],
      soralgan: [],
      qabul_qilingan: [],
      yuborilgan: [],
      yopilgan: [],
    };
    for (const req of requests) map[kanbanColumnOf(req)].push(req);
    // Newest first within each column.
    for (const column of Object.keys(map) as KanbanColumn[]) {
      map[column].sort((a, b) => b.id - a.id);
    }
    return map;
  }, [requests]);

  return (
    <div
      className={cn(
        'scrollbar-thin -mx-1 flex gap-3 overflow-x-auto px-1 pb-2',
        fill && 'h-full min-h-0',
      )}
    >
      {KANBAN_COLUMNS.map(({ column, label: canonical }) => {
        const items = byColumn[column];
        const label = columnLabels?.[column] ?? canonical;
        return (
          <section
            key={column}
            aria-label={label}
            className={cn(
              'flex flex-col rounded-xl border border-border/60 bg-muted/20',
              fill
                ? // fill: grow to share the full width, own scroll under the header
                  'min-h-0 min-w-64 flex-1'
                : 'w-72 shrink-0',
            )}
          >
            <header className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2.5">
              <span className="flex items-center gap-2 text-sm font-semibold">
                <span
                  aria-hidden="true"
                  className={cn('size-2 rounded-full', COLUMN_ACCENT[column])}
                />
                {label}
              </span>
              <Badge variant="outline" className="tabular-nums">
                {items.length}
              </Badge>
            </header>
            <div
              className={cn(
                'flex flex-col gap-2 p-2',
                fill && 'scrollbar-thin min-h-0 flex-1 overflow-y-auto',
              )}
            >
              {items.length === 0 ? (
                <p className="px-1 py-6 text-center text-xs text-muted-foreground">
                  {emptyLabel ?? '—'}
                </p>
              ) : (
                items.map((req) => (
                  <RequestCard
                    key={req.id}
                    req={req}
                    column={column}
                    action={renderAction?.(req)}
                    onOpen={onOpen ? () => onOpen(req) : undefined}
                    viewer={viewer}
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
// RequestCard — one request: left accent rail · top row (#id + created date) ·
// product (bold, truncate) · qty chip · route line · chips (origin, brak,
// "bolalar: N", "Poster kutilmoqda", closure) · optional action.
// ---------------------------------------------------------------------------

interface RequestCardProps {
  req: FlowRequest;
  column: KanbanColumn;
  action?: ReactNode;
  onOpen?: () => void;
  viewer?: BoardViewerContext;
}

export function RequestCard({
  req,
  column,
  action,
  onOpen,
  viewer,
}: RequestCardProps) {
  const stage = pipelineStageOf(req);
  const qtyChip = qtyChipFor(req, column);
  const origin = req.origin ?? null;
  const closure = column === 'yopilgan' ? req.closure_reason ?? null : null;
  const brak = req.brak_qty != null && req.brak_qty > 0 ? req.brak_qty : null;
  const rawWaiting = isRawPosterWaiting(req, stage);
  const openChildren =
    req.open_children_count != null && req.open_children_count > 0
      ? req.open_children_count
      : null;

  // F-M action-ownership: is the NEXT action on this card the viewer's?
  // (Same data, two boards — this chip is what makes them read differently:
  // owner "do'kon va markaziy ombor doskalari bir xil ma'lumot ko'rsatyapti".)
  const owner = actionOwnerOf(req, column);
  let mine: boolean | null = null; // null = signal off (no viewer context)
  if (viewer !== undefined && owner !== 'none') {
    if (owner === 'requester') {
      mine =
        viewer.side === 'outgoing' &&
        viewer.scope.has(req.requester_location_id);
    } else if (owner === 'target') {
      mine =
        viewer.side === 'incoming' &&
        req.target_location_id != null &&
        viewer.scope.has(req.target_location_id);
    } else {
      // production отдел acts — mine only when I AM that отдел.
      mine =
        viewer.side === 'incoming' &&
        req.production_location_id != null &&
        viewer.scope.has(req.production_location_id);
    }
  }

  const interactive = onOpen !== undefined;

  return (
    <div
      className={cn(
        // shrink-0: inside a fill-mode column the card list is an overflow-y
        // scroll flex column — without it flexbox SQUEEZES every card to fit
        // instead of scrolling (owner: "cardlar siqilib qolyabdi").
        'relative shrink-0 overflow-hidden rounded-lg border border-border/70 bg-card pl-3 pr-3 py-2.5 text-left transition-shadow',
        interactive &&
          'cursor-pointer hover:-translate-y-px hover:border-border-strong hover:shadow-card-hover',
        // F-M: waiting on the OTHER side → the whole card recedes a step.
        mine === false && 'opacity-75',
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
      {/* left accent rail */}
      <span
        aria-hidden="true"
        className={cn(
          'absolute inset-y-0 left-0 w-1',
          COLUMN_ACCENT[column],
        )}
      />

      {/* top row: #id + created date */}
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="tabular-nums">#{req.id}</span>
        <span className="tabular-nums">{formatDate(req.created_at)}</span>
      </div>

      {/* product + qty — on Jo'natildi/Yopildi a partial ship shows the SHIPPED
          amount as the chip, with a muted "/ needed" suffix (phase F-L §3). */}
      <div className="mt-1 flex items-start justify-between gap-2">
        <p className="min-w-0 truncate text-sm font-semibold leading-tight">
          {req.product_name}
        </p>
        <span className="flex shrink-0 items-baseline gap-1">
          <Badge variant="outline" className="tabular-nums">
            {qtyChip.primary}
          </Badge>
          {qtyChip.suffix !== null && (
            <span className="text-[10px] text-muted-foreground tabular-nums">
              {qtyChip.suffix}
            </span>
          )}
        </span>
      </div>

      {/* requester → target */}
      <p className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
        <span className="truncate">{req.requester_location_name}</span>
        <ArrowRight className="size-3 shrink-0" aria-hidden="true" />
        <span className="truncate">{req.target_location_name ?? '—'}</span>
      </p>

      {/* chips row */}
      {(origin || rawWaiting || closure || brak || openChildren || mine !== null) && (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          {/* F-M action-ownership chip — the FIRST chip so the eye catches it:
              mine → "Harakat sizda" (info); other side → who we wait on. */}
          {mine === true && (
            <Badge variant="info" className="text-[10px]">
              Harakat sizda
            </Badge>
          )}
          {mine === false && (
            <Badge variant="secondary" className="text-[10px]">
              {waitingOnLabel(req, owner)}
            </Badge>
          )}
          {origin && (
            <Badge variant={REQUEST_ORIGIN_VARIANT[origin]} className="text-[10px]">
              {REQUEST_ORIGIN_LABELS[origin]}
            </Badge>
          )}
          {rawWaiting && (
            <Badge variant="warning" className="gap-1 text-[10px]">
              <Sparkles className="size-3" aria-hidden="true" />
              Poster kutilmoqda
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
          {closure && (
            <Badge
              variant={CLOSURE_REASON_VARIANT[closure]}
              className="text-[10px]"
            >
              {CLOSURE_REASON_LABELS[closure]}
            </Badge>
          )}
        </div>
      )}

      {action && (
        <div className="mt-2 flex justify-end" onClick={(e) => e.stopPropagation()}>
          {action}
        </div>
      )}
    </div>
  );
}
