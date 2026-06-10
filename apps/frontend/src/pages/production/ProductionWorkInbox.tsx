import { useMemo, useState } from 'react';
import { CheckCircle2, Factory, Sparkles } from 'lucide-react';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api-client';
import {
  acceptProduction,
  rejectProduction,
} from '@/lib/replenishmentActions';
import { patchProductionOrderStatus } from '@/lib/productionOrders';
import { formatQtyUnit } from '@/lib/format';
import { isProductionInputWaiting } from '@/lib/replenishmentFlow';
import type { ReplenishmentRequest } from '@/lib/types';
import type { FlowRequest } from '@/lib/replenishmentFlow';
import { WorkCard, WorkFeed } from '@/pages/replenishment/inbox/WorkFeed';
import { useInboxAlert } from '@/pages/replenishment/inbox/useInboxAlert';
import { useInboxPolling } from '@/pages/replenishment/inbox/useInboxPolling';
import { CancelDialog } from '@/pages/replenishment/CancelDialog';
import { ManbaRejaModal } from './ManbaRejaModal';

/**
 * Ishlab chiqarish bo'limi — «Ishlarim» (phase F-V). The отдел manager's DEFAULT
 * screen: a calm vertical card feed of "what needs me now", built on the shared
 * kit (research §4 / Rule 1, the KDS bump queue). The kanban stays one tab away
 * under So'rovlar («Batafsil»).
 *
 * Two action card types (everyday Uzbek — NO status terms):
 *   1. A new job from central waiting at the отдел gate (isProductionInputWaiting
 *      — CHECK_PRODUCTION_INPUT, not yet accepted):
 *      «Markazdan yangi ish: 6 kg Napoleon» → [Qabul qilish] (accept-production)
 *      + [Rad] (reject-production). INLINE — no modal (research Rule 5/7).
 *   2. A job accepted + in the making pipeline:
 *      «6 kg Napoleon tayyormi?» → [Tayyor — skladga] (PATCH the linked
 *      production order to `done`) + secondary [Manba reja] (the existing source
 *      plan modal). When no production order exists yet, [Manba reja] is the
 *      primary (that is how the order gets created).
 *
 * Self-contained data layer mirroring ProductionRequestsTab's scope so the feed
 * lives independently of the board. Every action delegates to an EXISTING
 * endpoint / modal — zero new flows.
 */

/** A production-flow request — production is/was involved in MAKING it. */
const PRODUCTION_FLOW_STATUSES = new Set<string>([
  'CHECK_PRODUCTION_INPUT',
  'CREATE_PURCHASE_ORDER',
  'CREATE_PRODUCTION_ORDER',
  'PRODUCING',
  'DONE_TO_WAREHOUSE',
]);
function isProductionFlow(r: ReplenishmentRequest): boolean {
  return (
    r.received_from_production_at != null ||
    PRODUCTION_FLOW_STATUSES.has(r.status)
  );
}

/** An accepted job still being made (card type 2): production-assigned, past the
 *  gate (accepted), not yet handed to the warehouse. */
function isMakingNow(r: FlowRequest): boolean {
  if (r.status === 'DONE_TO_WAREHOUSE') return false; // already at warehouse
  if (isProductionInputWaiting(r)) return false; // still at the gate (card 1)
  return (
    r.status === 'CHECK_PRODUCTION_INPUT' ||
    r.status === 'CREATE_PURCHASE_ORDER' ||
    r.status === 'CREATE_PRODUCTION_ORDER' ||
    r.status === 'PRODUCING'
  );
}

export function ProductionWorkInbox({
  productionId,
  canAct,
  onOpenDetails,
}: {
  /** Scoped отдел id, or `null` for the PM chain-wide view. */
  productionId: number | null;
  /** Only the scoped production manager acts; PM is read-only. */
  canAct: boolean;
  /** Jump to the power view (So'rovlar board tab). */
  onOpenDetails: () => void;
}) {
  const { locations } = useAuth();
  const { notify } = useToast();

  const allRequests = useApiQuery<ReplenishmentRequest[]>('/api/replenishment');

  // Board scope — the отдел id PLUS every location the user is assigned to (so a
  // request pinned to the отдел's sex_storage still counts). PM → null = all.
  const scope = useMemo<ReadonlySet<number> | null>(() => {
    if (productionId === null) return null;
    const ids = new Set<number>([productionId]);
    for (const loc of locations) ids.add(loc.id);
    return ids;
  }, [productionId, locations]);

  // Production-assignment NAME set (phase F-J fallback) — matches a row whose
  // production_location_name is one of my отдел names even before the id column.
  const myProductionNames = useMemo<ReadonlySet<string>>(() => {
    const names = new Set<string>();
    for (const loc of locations) {
      if (loc.type === 'production') names.add(loc.name.toLowerCase());
    }
    return names;
  }, [locations]);

  /** Is this row assigned to my отдел (id OR name fallback)? PM (null scope) → all. */
  function isMine(r: FlowRequest): boolean {
    if (scope === null) return true;
    if (r.production_location_id != null && scope.has(r.production_location_id)) {
      return true;
    }
    if (r.target_location_id != null && scope.has(r.target_location_id)) {
      return true;
    }
    const name = r.production_location_name?.toLowerCase();
    return name != null && myProductionNames.has(name);
  }

  const mineFlow = useMemo<FlowRequest[]>(
    () =>
      (allRequests.data ?? [])
        .filter(isProductionFlow)
        .map((r) => r as FlowRequest)
        .filter(isMine),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allRequests.data, scope, myProductionNames],
  );

  // (1) Gate rows — a new job from central waiting to be accepted.
  const gateRows = useMemo(
    () => mineFlow.filter(isProductionInputWaiting).sort((a, b) => b.id - a.id),
    [mineFlow],
  );

  // (2) Making rows — accepted, in production, awaiting «Tayyor».
  const makingRows = useMemo(
    () => mineFlow.filter(isMakingNow).sort((a, b) => b.id - a.id),
    [mineFlow],
  );

  // Per-row in-flight key (`a<id>` accept · `d<id>` done) so one card's button
  // spins without locking the others.
  const [busyKey, setBusyKey] = useState<string | null>(null);
  // The gate row being rejected (reason dialog) + its flag.
  const [rejectTarget, setRejectTarget] = useState<FlowRequest | null>(null);
  const [rejecting, setRejecting] = useState(false);
  // The row whose «Manba reja» source-plan modal is open.
  const [planTarget, setPlanTarget] = useState<FlowRequest | null>(null);

  const actionableCount = gateRows.length + makingRows.length;
  const { flash } = useInboxAlert(actionableCount, canAct);
  useInboxPolling([allRequests.refetch], canAct);

  async function handleAccept(req: FlowRequest) {
    setBusyKey(`a${req.id}`);
    try {
      await acceptProduction(req.id);
      notify('success', `#${req.id} qabul qilindi.`);
      allRequests.refetch();
    } catch (err: unknown) {
      notify(
        'error',
        err instanceof ApiError ? err.message : 'Qabul qilib bo‘lmadi.',
      );
    } finally {
      setBusyKey(null);
    }
  }

  async function handleDone(req: FlowRequest) {
    if (req.production_order_id == null) return;
    setBusyKey(`d${req.id}`);
    try {
      await patchProductionOrderStatus(req.production_order_id, 'done');
      notify('success', `#${req.id} tayyor — skladga o‘tkazildi.`);
      allRequests.refetch();
    } catch (err: unknown) {
      notify(
        'error',
        err instanceof ApiError ? err.message : 'Tayyorga o‘tkazib bo‘lmadi.',
      );
    } finally {
      setBusyKey(null);
    }
  }

  async function handleRejectConfirm(reason: string | undefined) {
    if (rejectTarget === null) return;
    setRejecting(true);
    try {
      await rejectProduction(rejectTarget.id, reason);
      notify('success', `#${rejectTarget.id} rad etildi.`);
      setRejectTarget(null);
      allRequests.refetch();
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
        emptyHint="Markazdan yangi ish kelsa shu yerda chiqadi."
      >
        {/* (1) Gate rows — accept / reject INLINE, no modal. */}
        {gateRows.map((req) => (
          <WorkCard
            key={req.id}
            headline={
              <>
                Markazdan yangi ish:{' '}
                {formatQtyUnit(req.qty_needed, req.product_unit)}{' '}
                {req.product_name}
              </>
            }
            subline={`so‘rov #${req.id}`}
            busy={busyKey === `a${req.id}`}
            primary={
              canAct
                ? {
                    label: 'Qabul qilish',
                    icon: <CheckCircle2 className="size-4" aria-hidden="true" />,
                    variant: 'success',
                    onClick: () => handleAccept(req),
                  }
                : undefined
            }
            secondaryLabel={canAct ? 'Rad' : undefined}
            onSecondary={canAct ? () => setRejectTarget(req) : undefined}
          />
        ))}

        {/* (2) Making rows — «… tayyormi?» → Tayyor (done) / Manba reja.
            F-W follow-up (owner: "qanday yakunlayman?"): a row stuck at
            CREATE_PURCHASE_ORDER has NO zayafka yet because it is WAITING ON
            RAW MATERIALS — say so in plain words instead of dead-ending. The
            «Tayyor» button appears by itself once the purchase is received
            and the zayafka opens. */}
        {makingRows.map((req) => {
          const hasOrder = req.production_order_id != null;
          const waitingRaw =
            !hasOrder && req.status === 'CREATE_PURCHASE_ORDER';
          return (
            <WorkCard
              key={req.id}
              headline={
                waitingRaw ? (
                  <>
                    {formatQtyUnit(req.qty_needed, req.product_unit)}{' '}
                    {req.product_name} — xom-ashyo kutilmoqda
                  </>
                ) : (
                  <>
                    {formatQtyUnit(req.qty_needed, req.product_unit)}{' '}
                    {req.product_name} tayyormi?
                  </>
                )
              }
              subline={
                waitingRaw
                  ? `so‘rov #${req.id} · xarid homashyo omborida tasdiqlanib qabul qilingach, bu yerda «Tayyor» tugmasi chiqadi`
                  : `so‘rov #${req.id}`
              }
              busy={busyKey === `d${req.id}`}
              primary={
                !canAct
                  ? undefined
                  : hasOrder
                    ? {
                        label: 'Tayyor — skladga',
                        icon: <Factory className="size-4" aria-hidden="true" />,
                        variant: 'success',
                        onClick: () => handleDone(req),
                      }
                    : {
                        label: 'Manba reja',
                        icon: <Sparkles className="size-4" aria-hidden="true" />,
                        variant: 'default',
                        onClick: () => setPlanTarget(req),
                      }
              }
              // When there IS an order, «Manba reja» is the (neutral) secondary.
              secondaryLabel={canAct && hasOrder ? 'Manba reja' : undefined}
              secondaryVariant="muted"
              onSecondary={
                canAct && hasOrder ? () => setPlanTarget(req) : undefined
              }
            />
          );
        })}
      </WorkFeed>

      {/* «Rad» — reason dialog → reject-production. */}
      <CancelDialog
        open={rejectTarget !== null}
        onOpenChange={(next) => {
          if (!rejecting && !next) setRejectTarget(null);
        }}
        onConfirm={handleRejectConfirm}
        isSubmitting={rejecting}
      />

      {/* «Manba reja» — the existing N-component source-plan modal. */}
      <ManbaRejaModal
        open={planTarget !== null}
        onOpenChange={(open) => {
          if (!open) setPlanTarget(null);
        }}
        request={planTarget}
        locationId={productionId ?? planTarget?.target_location_id ?? 0}
        canExecute={canAct}
        onDone={() => {
          allRequests.refetch();
        }}
      />
    </>
  );
}
