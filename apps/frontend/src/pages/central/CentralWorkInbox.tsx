import { useMemo, useState } from 'react';
import { ChevronDown, PackageCheck, Send } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api-client';
import { rejectFulfiller } from '@/lib/replenishmentActions';
import { formatQtyUnit } from '@/lib/format';
import { groupByBatch } from '@/lib/groupByBatch';
import { pipelineStageOf } from '@/lib/pipeline';
import type {
  ReplenishmentRequest,
  ReplenishmentStatus,
  StockRow,
  Unit,
} from '@/lib/types';
import type { FlowRequest } from '@/lib/replenishmentFlow';
import {
  StatusTracker,
  WorkCard,
  WorkFeed,
} from '@/pages/replenishment/inbox/WorkFeed';
import { useInboxAlert } from '@/pages/replenishment/inbox/useInboxAlert';
import { useInboxPolling } from '@/pages/replenishment/inbox/useInboxPolling';
import { CENTRAL_TRACKER_STEPS, centralTrackerIndex } from './centralInboxTracker';
import { FulfillmentModal } from './FulfillmentModal';
import { ProductionReceiveDialog } from './ProductionReceiveDialog';
import { CancelDialog } from '@/pages/replenishment/CancelDialog';

/**
 * Markaziy sklad — «Ishlarim» (phase F-V). The central manager's DEFAULT screen:
 * a calm vertical card feed of "what needs me now", built on the shared kit
 * (research §4 / Rule 1). The kanban + transactions stay one tab away under
 * So'rovlar («Batafsil»).
 *
 * Two action card types (everyday Uzbek — NO status terms):
 *   1. A store request waiting to be sent (incoming Kutuvda, not yet accepted):
 *      «Kukcha 8 kg Napoleon so'radi» → [Jo'natish] (the existing FulfillmentModal,
 *      whole batch) + [Rad] (rejectFulfiller via a reason dialog).
 *   2. A production arrival awaiting receipt (DONE_TO_WAREHOUSE):
 *      «Napoleon-otdel 6 kg Napoleon tayyorladi — qabul qiling» → [Qabul qildim]
 *      (the existing ProductionReceiveDialog, brak flow inside).
 *
 * Plus a muted, collapsed «Kutilmoqda (N)» section: rows shipped to a store and
 * awaiting the store's receipt, with a {@link StatusTracker} (research Rule 6).
 *
 * Self-contained data layer mirroring CentralRequestsTab so the feed lives
 * independently of the power view. Every action delegates to an EXISTING dialog
 * / endpoint — zero new flows.
 */

/** One item from GET /api/replenishment/incoming (uses `unit`, no flow fields). */
interface IncomingItem {
  id: number;
  product_id: number;
  product_name: string;
  unit: Unit;
  requester_location_id: number;
  requester_location_name: string;
  qty_needed: number;
  status: ReplenishmentStatus;
  batch_id: number | null;
  created_at: string;
}

export function CentralWorkInbox({
  centralId,
  canWrite,
  onOpenDetails,
}: {
  /** Scoped central warehouse id, or `null` for the PM chain-wide view. */
  centralId: number | null;
  /** Only the scoped central manager acts; PM is read-only (no cards' buttons). */
  canWrite: boolean;
  /** Jump to the power view (So'rovlar tab). */
  onOpenDetails: () => void;
}) {
  const { notify } = useToast();

  const allRequests = useApiQuery<ReplenishmentRequest[]>('/api/replenishment');
  const incoming = useApiQuery<{ items: IncomingItem[] }>(
    centralId !== null
      ? `/api/replenishment/incoming?location_id=${centralId}`
      : null,
  );
  const stockUrl =
    centralId !== null
      ? `/api/stock?location_id=${centralId}`
      : '/api/stock?location_type=central_warehouse';
  const stock = useApiQuery<StockRow[]>(stockUrl);

  const availableByProduct = useMemo(() => {
    const map = new Map<number, number>();
    for (const row of stock.data ?? []) {
      map.set(row.product_id, (map.get(row.product_id) ?? 0) + row.qty);
    }
    return map;
  }, [stock.data]);

  // The store order (batch) whose fulfilment modal is open.
  const [fulfillLines, setFulfillLines] = useState<ReplenishmentRequest[] | null>(
    null,
  );
  // The DONE_TO_WAREHOUSE arrival whose brak-receive dialog is open.
  const [receiveTarget, setReceiveTarget] =
    useState<ReplenishmentRequest | null>(null);
  // The store order being rejected (reason dialog) + its in-flight flag.
  const [rejectTarget, setRejectTarget] = useState<ReplenishmentRequest | null>(
    null,
  );
  const [rejecting, setRejecting] = useState(false);

  function refreshAll() {
    allRequests.refetch();
    incoming.refetch();
    stock.refetch();
  }

  const allRows = useMemo(() => allRequests.data ?? [], [allRequests.data]);

  // Every request TARGETING this central (across stages) PLUS the not-yet-
  // targeted NEW store requests from /incoming — mirrors CentralRequestsTab's
  // incomingBoard so the manager sees an order before accepting.
  const incomingBoard = useMemo<FlowRequest[]>(() => {
    const fromAll = (allRows as FlowRequest[]).filter((r) =>
      centralId === null
        ? r.target_location_id !== null
        : r.target_location_id === centralId,
    );
    const seen = new Set(fromAll.map((r) => r.id));
    const fromIncoming: FlowRequest[] = (incoming.data?.items ?? [])
      .filter(
        (i) =>
          (i.status === 'NEW' || i.status === 'CHECK_STORE_SUPPLIER') &&
          i.requester_location_id !== centralId &&
          !seen.has(i.id),
      )
      .map(
        (i) =>
          ({
            ...i,
            product_unit: i.unit,
            target_location_id: centralId,
            requester_location_type: 'store',
            target_location_type: 'central_warehouse',
            pipeline_stage: 'kutuvda',
          }) as unknown as FlowRequest,
      );
    return [...fromAll, ...fromIncoming];
  }, [allRows, incoming.data, centralId]);

  // (1) Store orders awaiting send — Kutuvda, not a production delivery, not
  // raised by central itself. Grouped by batch so one order reads as one card.
  const storeOrderGroups = useMemo(() => {
    const storeOrders = incomingBoard.filter(
      (r) =>
        pipelineStageOf(r) === 'kutuvda' &&
        r.status !== 'DONE_TO_WAREHOUSE' &&
        (centralId === null || r.requester_location_id !== centralId),
    );
    return groupByBatch(storeOrders as ReplenishmentRequest[]);
  }, [incomingBoard, centralId]);

  // (2) Production arrivals awaiting receipt — DONE_TO_WAREHOUSE (the goods are
  // physically at central; the manager confirms receipt + any brak).
  const arrivals = useMemo<FlowRequest[]>(
    () =>
      incomingBoard
        .filter((r) => r.status === 'DONE_TO_WAREHOUSE')
        .sort((a, b) => b.id - a.id),
    [incomingBoard],
  );

  // (3) Muted «Kutilmoqda» — rows shipped to a store, awaiting the store's
  // receipt (Yuborilgan), so the manager can see the order is on its way.
  const shippedAwaiting = useMemo<FlowRequest[]>(
    () =>
      incomingBoard
        .filter((r) => pipelineStageOf(r) === 'yuborilgan')
        .sort((a, b) => b.id - a.id),
    [incomingBoard],
  );

  const actionableCount = storeOrderGroups.length + arrivals.length;
  const { flash } = useInboxAlert(actionableCount, canWrite);
  useInboxPolling(
    [allRequests.refetch, incoming.refetch, stock.refetch],
    canWrite,
  );

  const [pendingOpen, setPendingOpen] = useState(false);

  async function handleRejectConfirm(reason: string | undefined) {
    if (rejectTarget === null) return;
    setRejecting(true);
    try {
      await rejectFulfiller(rejectTarget.id, reason);
      notify('success', `#${rejectTarget.id} rad etildi.`);
      setRejectTarget(null);
      refreshAll();
    } catch (err: unknown) {
      notify(
        'error',
        err instanceof ApiError ? err.message : 'Rad etib bo‘lmadi.',
      );
    } finally {
      setRejecting(false);
    }
  }

  return (
    <>
      <WorkFeed
        title="Ishlarim"
        count={actionableCount}
        flash={flash}
        onOpenDetails={onOpenDetails}
        emptyHint="Do‘konlardan so‘rov yoki ishlab chiqarishdan tovar kelsa shu yerda chiqadi."
        footer={
          shippedAwaiting.length > 0 ? (
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => setPendingOpen((v) => !v)}
                aria-expanded={pendingOpen}
                className="flex w-full items-center justify-between rounded-md px-1 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                <span>Kutilmoqda · {shippedAwaiting.length}</span>
                <ChevronDown
                  className={cn(
                    'size-4 transition-transform',
                    pendingOpen && 'rotate-180',
                  )}
                  aria-hidden="true"
                />
              </button>
              {pendingOpen &&
                shippedAwaiting.map((req) => (
                  <Card key={req.id} className="space-y-2 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="min-w-0 truncate text-sm font-medium">
                        {formatQtyUnit(req.qty_needed, req.product_unit)}{' '}
                        {req.product_name}
                        <span className="ml-1 text-muted-foreground">
                          → {req.requester_location_name}
                        </span>
                      </p>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        #{req.id}
                      </span>
                    </div>
                    <StatusTracker
                      steps={CENTRAL_TRACKER_STEPS}
                      activeIndex={centralTrackerIndex(pipelineStageOf(req))}
                    />
                  </Card>
                ))}
            </div>
          ) : null
        }
      >
        {/* (1) Store orders awaiting send. */}
        {storeOrderGroups.map((group) => {
          const head = group.lines[0];
          if (!head) return null;
          const extra = group.lines.length - 1;
          return (
            <WorkCard
              key={group.key}
              headline={
                <>
                  {head.requester_location_name}{' '}
                  {formatQtyUnit(head.qty_needed, head.product_unit)}{' '}
                  {head.product_name} so‘radi
                  {extra > 0 && (
                    <span className="text-muted-foreground"> +{extra} ta</span>
                  )}
                </>
              }
              subline={`so‘rov #${head.id}`}
              primary={
                canWrite
                  ? {
                      label: 'Jo‘natish',
                      icon: <Send className="size-4" aria-hidden="true" />,
                      variant: 'success',
                      onClick: () => setFulfillLines(group.lines),
                    }
                  : undefined
              }
              secondaryLabel={canWrite ? 'Rad' : undefined}
              onSecondary={canWrite ? () => setRejectTarget(head) : undefined}
            />
          );
        })}

        {/* (2) Production arrivals awaiting receipt. */}
        {arrivals.map((req) => (
          <WorkCard
            key={req.id}
            headline={
              <>
                {req.production_location_name ?? 'Ishlab chiqarish'}{' '}
                {formatQtyUnit(req.qty_needed, req.product_unit)}{' '}
                {req.product_name} tayyorladi — qabul qiling
              </>
            }
            subline={`so‘rov #${req.id}`}
            primary={
              canWrite
                ? {
                    label: 'Qabul qildim',
                    icon: <PackageCheck className="size-4" aria-hidden="true" />,
                    variant: 'success',
                    onClick: () => setReceiveTarget(req as ReplenishmentRequest),
                  }
                : undefined
            }
          />
        ))}
      </WorkFeed>

      {/* «Jo'natish» — the existing partial-fulfilment modal (whole batch). */}
      <FulfillmentModal
        open={fulfillLines !== null && canWrite}
        onOpenChange={(open) => {
          if (!open) setFulfillLines(null);
        }}
        lines={fulfillLines ?? []}
        availableByProduct={availableByProduct}
        centralId={centralId ?? 0}
        onDone={() => {
          setFulfillLines(null);
          refreshAll();
        }}
      />

      {/* «Qabul qildim» — the existing brak-receive dialog. */}
      <ProductionReceiveDialog
        open={receiveTarget !== null}
        onOpenChange={(open) => {
          if (!open) setReceiveTarget(null);
        }}
        request={receiveTarget}
        onSaved={() => {
          setReceiveTarget(null);
          refreshAll();
        }}
      />

      {/* «Rad» — reason dialog → rejectFulfiller (the board's reject path). */}
      <CancelDialog
        open={rejectTarget !== null}
        onOpenChange={(next) => {
          if (!rejecting && !next) setRejectTarget(null);
        }}
        onConfirm={handleRejectConfirm}
        isSubmitting={rejecting}
      />
    </>
  );
}
