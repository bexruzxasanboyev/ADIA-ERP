import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, PackageCheck } from 'lucide-react';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useAuth } from '@/hooks/useAuth';
import { useCanAct } from '@/hooks/useCanAct';
import { useToast } from '@/components/ui/toast';
import { ApiError, apiRequest } from '@/lib/api-client';
import {
  acceptFulfiller,
  rejectFulfiller,
} from '@/lib/replenishmentActions';
import { formatQty, formatQtyUnit, formatRelative } from '@/lib/format';
import type {
  PurchaseOrder,
  ReplenishmentRequest,
} from '@/lib/types';
import type { FlowRequest } from '@/lib/replenishmentFlow';
import {
  WorkCard,
  WorkFeed,
  WorkSection,
} from '@/pages/replenishment/inbox/WorkFeed';
import {
  partitionByBucket,
  rawPurchaseOrderBucketOf,
  rawRequestBucketOf,
  WORK_BUCKET_LABELS,
} from '@/pages/replenishment/inbox/workBuckets';
import { useInboxAlert } from '@/pages/replenishment/inbox/useInboxAlert';
import { useInboxPolling } from '@/pages/replenishment/inbox/useInboxPolling';
import { CancelDialog } from '@/pages/replenishment/CancelDialog';
import { PurchaseOrderReceiveDialog } from './PurchaseOrderReceiveDialog';

/**
 * Homashyo ombori — «Ishlarim» (Variant A + mini-xarita). The raw-warehouse
 * keeper's ONLY surface on /purchase-orders: a single feed of large cards in
 * three fixed groups — YANGI / JARAYONDA / TAYYOR — one big primary button per
 * card, plain-Uzbek status lines, and a {@link ChainStrip} mini chain-map on
 * request cards (the `journey` field, backend in parallel).
 *
 *   YANGI     — an incoming department request («Tort sexi 20 kg un so'radi» →
 *               [Qabul qilish] + [Rad]) AND a draft PO awaiting the keeper's
 *               signature («Xarid #15 — tasdiqlang» → [Tasdiqlash]).
 *   JARAYONDA — accepted requests waiting on the Poster Поставка sync — watch
 *               cards (wait line, no button).
 *   TAYYOR    — an approved PO whose goods arrive: «Xarid #3 yetib keldimi?» →
 *               [Qabul qilish] (the existing brak-receive dialog).
 *
 * Bucketing is PURE ({@link rawRequestBucketOf} + {@link rawPurchaseOrderBucketOf},
 * unit-tested); every action delegates to an EXISTING endpoint / dialog.
 */

export function RawWorkInbox({
  rawScope,
  onOpenDetails,
  onActionableCount,
}: {
  /** The raw-warehouse location ids the viewer operates (from useAuth). */
  rawScope: ReadonlySet<number>;
  /** Open the detail surface («Batafsil →» — signals + the PO table). */
  onOpenDetails: () => void;
  /** Live actionable count — feeds the StaffViewSwitch «Ishlarim» badge. */
  onActionableCount?: (count: number) => void;
}) {
  const { user } = useAuth();
  const { canActOn } = useCanAct();
  const { notify } = useToast();

  const replen = useApiQuery<ReplenishmentRequest[]>(
    rawScope.size > 0 ? '/api/replenishment' : null,
  );
  const purchaseOrders = useApiQuery<PurchaseOrder[]>('/api/purchase-orders');

  // Per-row in-flight key so one card's button spins without locking others.
  const [busyKey, setBusyKey] = useState<string | null>(null);
  // The incoming request being rejected (reason dialog) + its flag.
  const [rejectTarget, setRejectTarget] = useState<FlowRequest | null>(null);
  const [rejecting, setRejecting] = useState(false);
  // The approved PO whose brak-receive dialog is open.
  const [receiveOrder, setReceiveOrder] = useState<PurchaseOrder | null>(null);

  function refreshAll() {
    replen.refetch();
    purchaseOrders.refetch();
  }

  // Raw-targeted requests (target ∈ my raw scope), three-group split (pure).
  const requestBuckets = useMemo(
    () =>
      partitionByBucket(
        (replen.data ?? [])
          .map((r) => r as FlowRequest)
          .filter(
            (r) =>
              r.target_location_id != null &&
              rawScope.has(r.target_location_id),
          ),
        rawRequestBucketOf,
      ),
    [replen.data, rawScope],
  );

  const isKeeperRole = user?.role === 'raw_warehouse_manager';

  // POs scoped to my raw warehouse(s) AND my acting rights, split (pure).
  const orderBuckets = useMemo(
    () =>
      partitionByBucket(
        (purchaseOrders.error ? [] : purchaseOrders.data ?? []).filter(
          (o) =>
            rawScope.has(o.target_location_id) &&
            isKeeperRole &&
            canActOn(o.target_location_id),
        ),
        rawPurchaseOrderBucketOf,
      ),
    [purchaseOrders.data, purchaseOrders.error, rawScope, isKeeperRole, canActOn],
  );

  const yangiCount = requestBuckets.yangi.length + orderBuckets.yangi.length;
  const tayyorCount = orderBuckets.tayyor.length;
  const actionableCount = yangiCount + tayyorCount;
  const visibleCount = actionableCount + requestBuckets.jarayonda.length;
  useEffect(() => {
    onActionableCount?.(actionableCount);
  }, [actionableCount, onActionableCount]);
  const { flash } = useInboxAlert(actionableCount, isKeeperRole);
  useInboxPolling([replen.refetch, purchaseOrders.refetch], rawScope.size > 0);

  async function handleAccept(req: FlowRequest) {
    setBusyKey(`a${req.id}`);
    try {
      await acceptFulfiller(req.id);
      notify('success', `#${req.id} qabul qilindi.`);
      refreshAll();
    } catch (err: unknown) {
      notify(
        'error',
        err instanceof ApiError ? err.message : 'Qabul qilib bo‘lmadi.',
      );
    } finally {
      setBusyKey(null);
    }
  }

  async function handleApprove(order: PurchaseOrder) {
    setBusyKey(`k${order.id}`);
    try {
      await apiRequest(`/api/purchase-orders/${order.id}/approve`, {
        method: 'POST',
        body: { step: 'keeper' },
      });
      notify('success', `Xarid #${order.id} tasdiqlandi.`);
      refreshAll();
    } catch (err: unknown) {
      notify(
        'error',
        err instanceof ApiError ? err.message : 'Tasdiqlab bo‘lmadi.',
      );
    } finally {
      setBusyKey(null);
    }
  }

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
  const reqSubline = (req: FlowRequest) =>
    `so‘rov #${req.id} · ${formatRelative(req.created_at)}`;

  return (
    <>
      <WorkFeed
        title="Ishlarim"
        count={actionableCount}
        visibleCount={visibleCount}
        flash={flash}
        onOpenDetails={onOpenDetails}
        emptyHint="Bo‘limlardan so‘rov yoki yangi xarid kelsa shu yerda chiqadi."
      >
        {/* YANGI — incoming department requests + keeper-signature POs. */}
        <WorkSection label={WORK_BUCKET_LABELS.yangi} count={yangiCount}>
          {requestBuckets.yangi.map((req) => (
            <WorkCard
              key={`req-${req.id}`}
              journey={req.journey}
              headline={
                <>
                  {req.requester_location_name}{' '}
                  {formatQtyUnit(req.qty_needed, req.product_unit)}{' '}
                  {req.product_name} so‘radi
                </>
              }
              subline={reqSubline(req)}
              busy={busyKey === `a${req.id}`}
              primary={
                isKeeperRole
                  ? {
                      label: 'Qabul qilish',
                      icon: (
                        <CheckCircle2 className="size-4" aria-hidden="true" />
                      ),
                      variant: 'success',
                      onClick: () => handleAccept(req),
                    }
                  : undefined
              }
              secondaryLabel={isKeeperRole ? 'Rad' : undefined}
              onSecondary={isKeeperRole ? () => setRejectTarget(req) : undefined}
            />
          ))}
          {orderBuckets.yangi.map((order) => (
            <WorkCard
              key={`po-sign-${order.id}`}
              headline={
                <>
                  Xarid #{order.id} — skladchi tasdig‘i kerak (
                  {formatQty(order.qty)} {order.product_unit}{' '}
                  {order.product_name})
                </>
              }
              subline={[order.supplier_name, formatRelative(order.created_at)]
                .filter(Boolean)
                .join(' · ')}
              busy={busyKey === `k${order.id}`}
              primary={{
                label: 'Tasdiqlash',
                icon: <CheckCircle2 className="size-4" aria-hidden="true" />,
                variant: 'success',
                onClick: () => handleApprove(order),
              }}
            />
          ))}
        </WorkSection>

        {/* JARAYONDA — accepted, waiting on the Poster Поставка sync. */}
        <WorkSection
          label={WORK_BUCKET_LABELS.jarayonda}
          count={requestBuckets.jarayonda.length}
        >
          {requestBuckets.jarayonda.map((req) => (
            <WorkCard
              key={`wait-${req.id}`}
              journey={req.journey}
              headline={
                <>
                  {formatQtyUnit(req.qty_needed, req.product_unit)}{' '}
                  {req.product_name} — Poster’da Поставка qo‘shing
                </>
              }
              subline={reqSubline(req)}
              waitReason={
                req.journey?.wait_reason ??
                'Sinxron kelgach avtomatik jo‘natiladi.'
              }
            />
          ))}
        </WorkSection>

        {/* TAYYOR — approved POs awaiting receipt at the door. */}
        <WorkSection label={WORK_BUCKET_LABELS.tayyor} count={tayyorCount}>
          {orderBuckets.tayyor.map((order) => (
            <WorkCard
              key={`po-recv-${order.id}`}
              headline={
                <>
                  Xarid #{order.id} yetib keldimi? ({formatQty(order.qty)}{' '}
                  {order.product_unit} {order.product_name})
                </>
              }
              subline={[order.supplier_name, formatRelative(order.created_at)]
                .filter(Boolean)
                .join(' · ')}
              primary={{
                label: 'Qabul qilish',
                icon: <PackageCheck className="size-4" aria-hidden="true" />,
                variant: 'success',
                onClick: () => setReceiveOrder(order),
              }}
            />
          ))}
        </WorkSection>
      </WorkFeed>

      {/* «Rad» — reason dialog → reject-fulfiller. */}
      <CancelDialog
        open={rejectTarget !== null}
        onOpenChange={(next) => {
          if (!rejecting && !next) setRejectTarget(null);
        }}
        onConfirm={handleRejectConfirm}
        isSubmitting={rejecting}
      />

      {/* «Qabul qilish» (PO) — the existing brak-receive dialog. */}
      <PurchaseOrderReceiveDialog
        open={receiveOrder !== null}
        onOpenChange={(open) => {
          if (!open) setReceiveOrder(null);
        }}
        order={receiveOrder}
        onSaved={() => {
          setReceiveOrder(null);
          refreshAll();
        }}
      />
    </>
  );
}
