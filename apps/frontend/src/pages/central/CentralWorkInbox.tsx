import { useEffect, useMemo, useState } from 'react';
import { PackageCheck, Send } from 'lucide-react';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api-client';
import { rejectFulfiller } from '@/lib/replenishmentActions';
import { formatQtyUnit, formatRelative } from '@/lib/format';
import { groupByBatch } from '@/lib/groupByBatch';
import { pipelineStageOf } from '@/lib/pipeline';
import type {
  ReplenishmentRequest,
  ReplenishmentStatus,
  StockRow,
  Unit,
} from '@/lib/types';
import type { FlowRequest, Journey } from '@/lib/replenishmentFlow';
import {
  StatusTracker,
  WorkCard,
  WorkFeed,
  WorkSection,
} from '@/pages/replenishment/inbox/WorkFeed';
import {
  centralBucketOf,
  partitionByBucket,
  WORK_BUCKET_LABELS,
} from '@/pages/replenishment/inbox/workBuckets';
import { useInboxAlert } from '@/pages/replenishment/inbox/useInboxAlert';
import { useInboxPolling } from '@/pages/replenishment/inbox/useInboxPolling';
import { CENTRAL_TRACKER_STEPS, centralTrackerIndex } from './centralInboxTracker';
import { FulfillmentModal } from './FulfillmentModal';
import { ProductionReceiveDialog } from './ProductionReceiveDialog';
import { CancelDialog } from '@/pages/replenishment/CancelDialog';

/**
 * Markaziy sklad — «Ishlarim» (Variant A + mini-xarita). The central manager's
 * ONLY screen: a single feed of large cards in three fixed groups — YANGI /
 * JARAYONDA / TAYYOR — one big primary button per card, plain-Uzbek status
 * lines, and a {@link ChainStrip} mini chain-map per card (the `journey`
 * field, backend in parallel — hidden until it lands).
 *
 *   YANGI     — a store order awaiting the send decision (batch = one card):
 *               «Kukcha 8 kg Napoleon so'radi» → [Jo'natish] + [Rad].
 *   JARAYONDA — shipped to a store, awaiting the store's receive — watch
 *               cards (chain strip / tracker, no button).
 *   TAYYOR    — a production arrival to confirm-receive:
 *               «Tort sexi 6 kg Napoleon tayyorladi» → [Qabul qildim].
 *
 * Bucketing is the PURE {@link centralBucketOf} (unit-tested); every action
 * delegates to an EXISTING dialog / endpoint — zero new flows.
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
  /** Mini chain-map — same PINNED contract as GET /api/replenishment. */
  journey?: Journey | null;
}

export function CentralWorkInbox({
  centralId,
  canWrite,
  onOpenDetails,
  onActionableCount,
}: {
  /** Scoped central warehouse id, or `null` for the PM chain-wide view. */
  centralId: number | null;
  /** Only the scoped central manager acts; PM is read-only (no cards' buttons). */
  canWrite: boolean;
  /** Open the detail surface («Batafsil →» — tables for staff, board for PM). */
  onOpenDetails: () => void;
  /** Live actionable count — feeds the StaffViewSwitch «Ishlarim» badge. */
  onActionableCount?: (count: number) => void;
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

  // The three-group split (pure, unit-tested): YANGI / JARAYONDA / TAYYOR.
  const buckets = useMemo(
    () => partitionByBucket(incomingBoard, (r) => centralBucketOf(r, centralId)),
    [incomingBoard, centralId],
  );

  // YANGI grouped by batch so one store order reads as ONE card.
  const storeOrderGroups = useMemo(
    () => groupByBatch(buckets.yangi as ReplenishmentRequest[]),
    [buckets.yangi],
  );

  const actionableCount = storeOrderGroups.length + buckets.tayyor.length;
  const visibleCount = actionableCount + buckets.jarayonda.length;
  useEffect(() => {
    onActionableCount?.(actionableCount);
  }, [actionableCount, onActionableCount]);
  const { flash } = useInboxAlert(actionableCount, canWrite);
  useInboxPolling(
    [allRequests.refetch, incoming.refetch, stock.refetch],
    canWrite,
  );

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

  /** "#id · qachon" — the muted second line, everyday words only. */
  const subline = (req: FlowRequest) =>
    `so‘rov #${req.id} · ${formatRelative(req.created_at)}`;

  return (
    <>
      <WorkFeed
        title="Ishlarim"
        count={actionableCount}
        visibleCount={visibleCount}
        flash={flash}
        onOpenDetails={onOpenDetails}
        emptyHint="Do‘konlardan so‘rov yoki ishlab chiqarishdan tovar kelsa shu yerda chiqadi."
      >
        {/* YANGI — store orders awaiting the send decision. */}
        <WorkSection
          label={WORK_BUCKET_LABELS.yangi}
          count={storeOrderGroups.length}
        >
          {storeOrderGroups.map((group) => {
            const head = group.lines[0];
            if (!head) return null;
            const headFlow = head as FlowRequest;
            const extra = group.lines.length - 1;
            return (
              <WorkCard
                key={group.key}
                journey={headFlow.journey}
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
                subline={subline(headFlow)}
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
        </WorkSection>

        {/* JARAYONDA — shipped to a store, awaiting its receive (watch-only). */}
        <WorkSection
          label={WORK_BUCKET_LABELS.jarayonda}
          count={buckets.jarayonda.length}
        >
          {buckets.jarayonda.map((req) => (
            <WorkCard
              key={req.id}
              journey={req.journey}
              headline={
                <>
                  {formatQtyUnit(req.qty_needed, req.product_unit)}{' '}
                  {req.product_name} → {req.requester_location_name} yo‘lda
                </>
              }
              subline={subline(req)}
              waitReason={
                req.journey?.wait_reason ??
                `${req.requester_location_name} qabul qilishi kutilmoqda.`
              }
              // The legacy tracker carries the strip's job until journey lands.
              tracker={
                req.journey ? undefined : (
                  <StatusTracker
                    steps={CENTRAL_TRACKER_STEPS}
                    activeIndex={centralTrackerIndex(pipelineStageOf(req))}
                  />
                )
              }
            />
          ))}
        </WorkSection>

        {/* TAYYOR — production arrivals awaiting receipt. */}
        <WorkSection
          label={WORK_BUCKET_LABELS.tayyor}
          count={buckets.tayyor.length}
        >
          {buckets.tayyor.map((req) => (
            <WorkCard
              key={req.id}
              journey={req.journey}
              headline={
                <>
                  {req.production_location_name ?? 'Ishlab chiqarish'}{' '}
                  {formatQtyUnit(req.qty_needed, req.product_unit)}{' '}
                  {req.product_name} tayyorladi — qabul qiling
                </>
              }
              subline={subline(req)}
              primary={
                canWrite
                  ? {
                      label: 'Qabul qildim',
                      icon: (
                        <PackageCheck className="size-4" aria-hidden="true" />
                      ),
                      variant: 'success',
                      onClick: () =>
                        setReceiveTarget(req as ReplenishmentRequest),
                    }
                  : undefined
              }
            />
          ))}
        </WorkSection>
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
