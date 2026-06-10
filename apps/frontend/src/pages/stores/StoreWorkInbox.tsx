import { useMemo, useState } from 'react';
import { ChevronDown, PackageCheck, Plus, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { formatQtyUnit } from '@/lib/format';
import { pipelineStageOf } from '@/lib/pipeline';
import { TERMINAL_REPLENISHMENT_STATUSES } from '@/lib/types';
import type { ReplenishmentRequest } from '@/lib/types';
import type { FlowRequest } from '@/lib/replenishmentFlow';
import {
  StatusTracker,
  WorkCard,
  WorkFeed,
} from '@/pages/replenishment/inbox/WorkFeed';
import { STORE_TRACKER_STEPS, storeTrackerIndex } from './storeInboxTracker';

/**
 * F-T → F-V «Ishlarim» — the SIMPLE-MODE pilot, now built on the SHARED kit
 * (WorkFeed / WorkCard / StatusTracker). The store manager's default screen is
 * a plain ACTION FEED, not a board: only the items whose NEXT MOVE is theirs,
 * one big obvious button each, everyday language («keldi — qabul qiling»), and
 * a calm «hammasi joyida» empty state. The kanban/table/history stay one click
 * away under the existing tabs («Batafsil»).
 *
 * F-V adds the muted, collapsed «Kutilmoqda (N)» section: the store's OWN open
 * requests with a {@link StatusTracker} (Yuborildi → Tayyorlanmoqda → Yo'lda →
 * Keldi) so the requester sees "where is my order" without opening a board
 * (research Rule 6).
 *
 * Deliberately PRESENTATION-ONLY: every action delegates to the SAME dialogs
 * and endpoints the power views use (StoreReceiveDialog, the AI proposals
 * dialog, the create-request flow) — no new flows, no new invariants.
 */

export interface StoreWorkInboxProps {
  /** The store-scoped request rows (already fetched by the workspace). */
  requests: ReplenishmentRequest[];
  /** The viewer's store location ids (receive items are scoped to these). */
  storeScope: ReadonlySet<number>;
  /** Pulse the header on a new arrival (driven by useInboxAlert). */
  flash?: boolean;
  /** Open the existing receive dialog (brak flow included). */
  onReceive: (req: ReplenishmentRequest) => void;
  /** Open the existing AI proposals dialog. NULL hides the card. */
  onOpenAiProposals: (() => void) | null;
  /** Open the existing create-request flow. NULL hides the CTA. */
  onCreateRequest: (() => void) | null;
  /** Jump to the detailed view (the existing So'rovlar tabs). */
  onOpenDetails: () => void;
}

/** A reserved shipment awaiting THIS store's receive (mirrors the
 *  «Qabul qiluvchi» filter exactly — one source of truth would be nicer, but
 *  the predicate is three fields and a comment keeps them in lock-step). */
function isAwaitingReceive(
  req: ReplenishmentRequest,
  scope: ReadonlySet<number>,
): boolean {
  const flow = req as FlowRequest;
  return (
    scope.has(req.requester_location_id) &&
    req.status === 'CLOSED' &&
    flow.closure_reason == null &&
    flow.fulfiller_accepted_at != null
  );
}

/** A request the store RAISED that is still open (in flight) — feeds the muted
 *  «Kutilmoqda» tracker section. Excludes terminal rows and the awaiting-receive
 *  rows (those are the big action cards above). */
function isMyOpenRequest(
  req: ReplenishmentRequest,
  scope: ReadonlySet<number>,
): boolean {
  if (!scope.has(req.requester_location_id)) return false;
  if (TERMINAL_REPLENISHMENT_STATUSES.includes(req.status)) return false;
  return !isAwaitingReceive(req, scope);
}

export function StoreWorkInbox({
  requests,
  storeScope,
  flash = false,
  onReceive,
  onOpenAiProposals,
  onCreateRequest,
  onOpenDetails,
}: StoreWorkInboxProps) {
  const receivable = useMemo(
    () =>
      requests
        .filter((r) => isAwaitingReceive(r, storeScope))
        .sort((a, b) => b.id - a.id),
    [requests, storeScope],
  );

  // The store's own in-flight requests (muted tracker section).
  const pending = useMemo(
    () =>
      requests
        .filter((r) => isMyOpenRequest(r, storeScope))
        .sort((a, b) => b.id - a.id),
    [requests, storeScope],
  );

  const [pendingOpen, setPendingOpen] = useState(false);

  return (
    <WorkFeed
      title="Ishlarim"
      count={receivable.length}
      flash={flash}
      onOpenDetails={onOpenDetails}
      emptyHint="Yangi jo‘natma kelsa shu yerda chiqadi."
      footer={
        <>
          {/* Muted «Kutilmoqda (N)» — my open requests + their trackers. */}
          {pending.length > 0 && (
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => setPendingOpen((v) => !v)}
                aria-expanded={pendingOpen}
                className="flex w-full items-center justify-between rounded-md px-1 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                <span>Kutilmoqda · {pending.length}</span>
                <ChevronDown
                  className={cn(
                    'size-4 transition-transform',
                    pendingOpen && 'rotate-180',
                  )}
                  aria-hidden="true"
                />
              </button>
              {pendingOpen &&
                pending.map((req) => (
                  <Card key={req.id} className="space-y-2 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="min-w-0 truncate text-sm font-medium">
                        {formatQtyUnit(req.qty_needed, req.product_unit)}{' '}
                        {req.product_name}
                      </p>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        #{req.id}
                      </span>
                    </div>
                    <StatusTracker
                      steps={STORE_TRACKER_STEPS}
                      activeIndex={storeTrackerIndex(pipelineStageOf(req))}
                    />
                  </Card>
                ))}
            </div>
          )}

          {/* Two everyday actions — request something / see AI suggestions. */}
          <div className="flex flex-wrap gap-2 pt-2">
            {onCreateRequest && (
              <Button size="lg" onClick={onCreateRequest}>
                <Plus className="size-4" aria-hidden="true" />
                So‘rov yuborish
              </Button>
            )}
            {onOpenAiProposals && (
              <Button size="lg" variant="outline" onClick={onOpenAiProposals}>
                <Sparkles className="size-4" aria-hidden="true" />
                AI takliflari
              </Button>
            )}
          </div>
        </>
      }
    >
      {/* One card per arrived shipment — plain words, ONE big button. */}
      {receivable.map((req) => {
        const flow = req as FlowRequest;
        const qty = flow.shipped_qty ?? req.qty_needed;
        return (
          <WorkCard
            key={req.id}
            headline={`${formatQtyUnit(qty, req.product_unit)} ${req.product_name} keldi`}
            subline={`${req.target_location_name ?? 'Markaziy sklad'} jo‘natdi · so‘rov #${req.id}`}
            primary={{
              label: 'Qabul qilish',
              icon: <PackageCheck className="size-4" aria-hidden="true" />,
              variant: 'success',
              onClick: () => onReceive(req),
            }}
          />
        );
      })}
    </WorkFeed>
  );
}
