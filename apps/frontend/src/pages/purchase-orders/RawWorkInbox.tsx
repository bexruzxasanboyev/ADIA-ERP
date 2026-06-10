import { useMemo, useState } from 'react';
import { CheckCircle2, Clock, PackageCheck } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useAuth } from '@/hooks/useAuth';
import { useCanAct } from '@/hooks/useCanAct';
import { useToast } from '@/components/ui/toast';
import { ApiError, apiRequest } from '@/lib/api-client';
import {
  acceptFulfiller,
  rejectFulfiller,
} from '@/lib/replenishmentActions';
import { formatQty, formatQtyUnit } from '@/lib/format';
import { pipelineStageOf } from '@/lib/pipeline';
import { isRawPosterWaiting } from '@/lib/replenishmentFlow';
import type {
  PurchaseOrder,
  ReplenishmentRequest,
} from '@/lib/types';
import type { FlowRequest } from '@/lib/replenishmentFlow';
import { WorkCard, WorkFeed } from '@/pages/replenishment/inbox/WorkFeed';
import { useInboxAlert } from '@/pages/replenishment/inbox/useInboxAlert';
import { useInboxPolling } from '@/pages/replenishment/inbox/useInboxPolling';
import { CancelDialog } from '@/pages/replenishment/CancelDialog';
import { PurchaseOrderReceiveDialog } from './PurchaseOrderReceiveDialog';

/**
 * Homashyo ombori — «Ishlarim» (phase F-V). The raw-warehouse keeper's DEFAULT
 * surface on /purchase-orders: a calm Odoo-style "qabul qilish" queue of "what
 * needs me now", built on the shared kit (research §4 / Rule 1). The unified
 * board + the PO table stay below a «Batafsil» disclosure on the page.
 *
 * Three action card types (everyday Uzbek — NO status terms):
 *   1. A pinned incoming department request (NEW/CHECK_STORE_SUPPLIER at the raw
 *      warehouse): «Napoleon-otdel 20 kg un so'radi» → [Qabul qilish]
 *      (accept-fulfiller) + [Rad] (reject-fulfiller). After accept the row flips
 *      to an INFO card: «Poster'da Поставка qo'shing — sinxron kelgach avtomatik
 *      jo'natiladi» (the existing isRawPosterWaiting hold).
 *   2. A purchase order awaiting the keeper's signature (draft, not yet signed):
 *      «Xarid #15 — skladchi tasdig'i kerak (20.1 kg крем)» → [Tasdiqlash]
 *      (the existing approve endpoint, keeper step).
 *   3. An approved purchase order awaiting receipt: «Xarid #3 yetib keldimi?» →
 *      [Qabul qilish] (the existing brak-receive dialog).
 *
 * RBAC mirrors ApprovalPanel exactly (keeper sign / receive need the scoped raw
 * operator). Every action delegates to an EXISTING endpoint / dialog — zero new
 * flows.
 */

export function RawWorkInbox({
  rawScope,
  onOpenDetails,
}: {
  /** The raw-warehouse location ids the viewer operates (from useAuth). */
  rawScope: ReadonlySet<number>;
  /** Jump to the power view (the board + PO table below «Batafsil»). */
  onOpenDetails: () => void;
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

  // Raw-targeted requests (target ∈ my raw scope).
  const rawRequests = useMemo<FlowRequest[]>(
    () =>
      (replen.data ?? [])
        .map((r) => r as FlowRequest)
        .filter(
          (r) =>
            r.target_location_id != null && rawScope.has(r.target_location_id),
        ),
    [replen.data, rawScope],
  );

  // (1a) NEW incoming requests awaiting the keeper's accept (not yet accepted).
  const incomingNew = useMemo<FlowRequest[]>(
    () =>
      rawRequests
        .filter(
          (r) =>
            !r.fulfiller_accepted_at &&
            (r.status === 'NEW' || r.status === 'CHECK_STORE_SUPPLIER'),
        )
        .sort((a, b) => b.id - a.id),
    [rawRequests],
  );

  // (1b) Accepted, awaiting the Поставка sync — the «Poster postavka kutilmoqda»
  // info hold (no action; reassures the keeper the request is in-flight).
  const posterWaiting = useMemo<FlowRequest[]>(
    () =>
      rawRequests
        .filter((r) => isRawPosterWaiting(r, pipelineStageOf(r)))
        .sort((a, b) => b.id - a.id),
    [rawRequests],
  );

  // POs scoped to my raw warehouse(s).
  const myOrders = useMemo<PurchaseOrder[]>(
    () =>
      (purchaseOrders.error ? [] : purchaseOrders.data ?? []).filter((o) =>
        rawScope.has(o.target_location_id),
      ),
    [purchaseOrders.data, purchaseOrders.error, rawScope],
  );

  const isKeeperRole = user?.role === 'raw_warehouse_manager';

  // (2) POs awaiting the keeper's signature (draft, keeper not yet signed, scoped).
  const awaitingKeeper = useMemo<PurchaseOrder[]>(
    () =>
      myOrders
        .filter(
          (o) =>
            o.status === 'draft' &&
            o.keeper_approved_by === null &&
            isKeeperRole &&
            canActOn(o.target_location_id),
        )
        .sort((a, b) => b.id - a.id),
    [myOrders, isKeeperRole, canActOn],
  );

  // (3) Approved POs awaiting receipt (scoped keeper).
  const awaitingReceive = useMemo<PurchaseOrder[]>(
    () =>
      myOrders
        .filter(
          (o) =>
            o.status === 'approved' &&
            isKeeperRole &&
            canActOn(o.target_location_id),
        )
        .sort((a, b) => b.id - a.id),
    [myOrders, isKeeperRole, canActOn],
  );

  const actionableCount =
    incomingNew.length + awaitingKeeper.length + awaitingReceive.length;
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

  return (
    <>
      <WorkFeed
        title="Ishlarim"
        count={actionableCount}
        flash={flash}
        onOpenDetails={onOpenDetails}
        emptyHint="Bo‘limlardan so‘rov yoki yangi xarid kelsa shu yerda chiqadi."
        footer={
          // (1b) «Poster postavka kutilmoqda» — accepted requests in-flight.
          posterWaiting.length > 0 ? (
            <div className="space-y-2 pt-1">
              {posterWaiting.map((req) => (
                <Card
                  key={req.id}
                  className="flex items-start gap-2 border-info/30 bg-info/5 p-3"
                >
                  <Clock
                    className="mt-0.5 size-4 shrink-0 text-info"
                    aria-hidden="true"
                  />
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {formatQtyUnit(req.qty_needed, req.product_unit)}{' '}
                      {req.product_name} — Poster’da Поставка qo‘shing
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Sinxron kelgach avtomatik jo‘natiladi · so‘rov #{req.id}
                    </p>
                  </div>
                </Card>
              ))}
            </div>
          ) : null
        }
      >
        {/* (1a) Incoming department requests — accept / reject. */}
        {incomingNew.map((req) => (
          <WorkCard
            key={`req-${req.id}`}
            headline={
              <>
                {req.requester_location_name}{' '}
                {formatQtyUnit(req.qty_needed, req.product_unit)}{' '}
                {req.product_name} so‘radi
              </>
            }
            subline={`so‘rov #${req.id}`}
            busy={busyKey === `a${req.id}`}
            primary={
              isKeeperRole
                ? {
                    label: 'Qabul qilish',
                    icon: <CheckCircle2 className="size-4" aria-hidden="true" />,
                    variant: 'success',
                    onClick: () => handleAccept(req),
                  }
                : undefined
            }
            secondaryLabel={isKeeperRole ? 'Rad' : undefined}
            onSecondary={isKeeperRole ? () => setRejectTarget(req) : undefined}
          />
        ))}

        {/* (2) POs awaiting the keeper's signature. */}
        {awaitingKeeper.map((order) => (
          <WorkCard
            key={`po-sign-${order.id}`}
            headline={
              <>
                Xarid #{order.id} — skladchi tasdig‘i kerak (
                {formatQty(order.qty)} {order.product_unit} {order.product_name})
              </>
            }
            subline={order.supplier_name ?? undefined}
            busy={busyKey === `k${order.id}`}
            primary={{
              label: 'Tasdiqlash',
              icon: <CheckCircle2 className="size-4" aria-hidden="true" />,
              variant: 'success',
              onClick: () => handleApprove(order),
            }}
          />
        ))}

        {/* (3) Approved POs awaiting receipt. */}
        {awaitingReceive.map((order) => (
          <WorkCard
            key={`po-recv-${order.id}`}
            headline={
              <>
                Xarid #{order.id} yetib keldimi? ({formatQty(order.qty)}{' '}
                {order.product_unit} {order.product_name})
              </>
            }
            subline={order.supplier_name ?? undefined}
            primary={{
              label: 'Qabul qilish',
              icon: <PackageCheck className="size-4" aria-hidden="true" />,
              variant: 'success',
              onClick: () => setReceiveOrder(order),
            }}
          />
        ))}
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
