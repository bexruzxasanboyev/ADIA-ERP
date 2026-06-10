import { useMemo } from 'react';
import { CheckCircle2, PackageCheck, Plus, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { formatQtyUnit } from '@/lib/format';
import type { ReplenishmentRequest } from '@/lib/types';
import type { FlowRequest } from '@/lib/replenishmentFlow';

/**
 * F-T «Ishlarim» — the SIMPLE-MODE pilot (owner: "tizim oson va sodda bo'lishi
 * kerak — hodimlar qiynalmasin"). The store manager's default screen is a
 * plain ACTION FEED, not a board: only the items whose NEXT MOVE is theirs,
 * one big obvious button each, everyday language («keldi — qabul qiling»),
 * and a calm «hammasi joyida» empty state. The kanban/table/history stay one
 * click away under the existing tabs («Batafsil»).
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

export function StoreWorkInbox({
  requests,
  storeScope,
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

  const hasWork = receivable.length > 0;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      {/* Header — a count the staff can read at a glance. */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">
          Ishlarim{' '}
          <Badge variant={hasWork ? 'warning' : 'success'} className="ml-1 align-middle">
            {receivable.length}
          </Badge>
        </h2>
        <Button variant="ghost" size="sm" onClick={onOpenDetails}>
          Batafsil →
        </Button>
      </div>

      {/* One card per arrived shipment — plain words, ONE big button. */}
      {receivable.map((req) => {
        const flow = req as FlowRequest;
        const qty = flow.shipped_qty ?? req.qty_needed;
        return (
          <Card key={req.id} className="flex items-center justify-between gap-4 p-4">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">
                {formatQtyUnit(qty, req.product_unit)} {req.product_name} keldi
              </p>
              <p className="text-xs text-muted-foreground">
                {req.target_location_name ?? 'Markaziy sklad'} jo‘natdi · so‘rov #{req.id}
              </p>
            </div>
            <Button
              variant="success"
              size="lg"
              className="shrink-0"
              onClick={() => onReceive(req)}
            >
              <PackageCheck className="size-4" aria-hidden="true" />
              Qabul qilish
            </Button>
          </Card>
        );
      })}

      {/* Calm empty state — the staff knows nothing is waiting on them. */}
      {!hasWork && (
        <Card className="flex flex-col items-center gap-2 p-8 text-center">
          <CheckCircle2 className="size-8 text-success" aria-hidden="true" />
          <p className="text-sm font-medium">Sizda kutilayotgan ish yo‘q</p>
          <p className="text-xs text-muted-foreground">
            Yangi jo‘natma kelsa shu yerda chiqadi.
          </p>
        </Card>
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
    </div>
  );
}
