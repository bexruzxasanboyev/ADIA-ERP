import { useEffect, useMemo, useState } from 'react';
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
import { formatQtyUnit, formatRelative } from '@/lib/format';
import type { ReplenishmentRequest } from '@/lib/types';
import type { FlowRequest } from '@/lib/replenishmentFlow';
import {
  WorkCard,
  WorkFeed,
  WorkSection,
} from '@/pages/replenishment/inbox/WorkFeed';
import {
  isProductionWaitingRaw,
  partitionByBucket,
  productionBucketOf,
  WORK_BUCKET_LABELS,
} from '@/pages/replenishment/inbox/workBuckets';
import { useInboxAlert } from '@/pages/replenishment/inbox/useInboxAlert';
import { useInboxPolling } from '@/pages/replenishment/inbox/useInboxPolling';
import { CancelDialog } from '@/pages/replenishment/CancelDialog';
import { ManbaRejaModal } from './ManbaRejaModal';

/**
 * Ishlab chiqarish bo'limi — «Ishlarim» (Variant A + mini-xarita). The отдел
 * manager's ONLY screen: a single feed of large cards in three fixed groups —
 * YANGI / JARAYONDA / TAYYOR — each card with ONE big primary button, a plain-
 * Uzbek status line and a {@link ChainStrip} mini chain-map (the `journey`
 * field, backend in parallel — hidden until it lands).
 *
 *   YANGI     — a job from central at the отдел gate:
 *               «Markazdan yangi ish: 6 kg Napoleon» → [Qabul qilish] + [Rad].
 *   JARAYONDA — accepted, no zayafka yet: either WAITING on raw materials
 *               (calm wait line, no button — `journey.wait_reason` preferred)
 *               or awaiting the «Manba reja» source-plan step (one button).
 *   TAYYOR    — the zayafka is open: «6 kg Napoleon tayyormi?» →
 *               [Tayyor — skladga] (+ muted [Manba reja]).
 *
 * Bucketing is the PURE {@link productionBucketOf} (unit-tested); every action
 * delegates to an EXISTING endpoint / modal — zero new flows.
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

/**
 * A JARAYONDA card with NO button: the backend's `journey.wait_reason` is
 * authoritative when the journey is present; otherwise fall back to the local
 * raw-material-wait heuristic (CREATE_PURCHASE_ORDER, no zayafka).
 */
function isWaitCard(r: FlowRequest): boolean {
  if (r.journey != null) return r.journey.wait_reason != null;
  return isProductionWaitingRaw(r);
}

export function ProductionWorkInbox({
  productionId,
  canAct,
  onOpenDetails,
  onActionableCount,
}: {
  /** Scoped отдел id, or `null` for the PM chain-wide view. */
  productionId: number | null;
  /** Only the scoped production manager acts; PM is read-only. */
  canAct: boolean;
  /** Open the detail surface («Batafsil →» — tables for staff, board for PM). */
  onOpenDetails: () => void;
  /** Live actionable count — feeds the StaffViewSwitch «Ishlarim» badge. */
  onActionableCount?: (count: number) => void;
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

  // The three-group split (pure, unit-tested): YANGI / JARAYONDA / TAYYOR.
  const buckets = useMemo(
    () => partitionByBucket(mineFlow, productionBucketOf),
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

  // Actionable = cards with a button (wait cards are watch-only).
  const planRows = buckets.jarayonda.filter((r) => !isWaitCard(r));
  const waitRows = buckets.jarayonda.filter(isWaitCard);
  const actionableCount =
    buckets.yangi.length + planRows.length + buckets.tayyor.length;
  const visibleCount = actionableCount + waitRows.length;
  useEffect(() => {
    onActionableCount?.(actionableCount);
  }, [actionableCount, onActionableCount]);
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

  /** "kim · #id · qachon" — the muted second line, everyday words only. */
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
        emptyHint="Markazdan yangi ish kelsa shu yerda chiqadi."
      >
        {/* YANGI — accept / reject INLINE, no modal. */}
        <WorkSection label={WORK_BUCKET_LABELS.yangi} count={buckets.yangi.length}>
          {buckets.yangi.map((req) => (
            <WorkCard
              key={req.id}
              journey={req.journey}
              headline={
                <>
                  Markazdan yangi ish:{' '}
                  {formatQtyUnit(req.qty_needed, req.product_unit)}{' '}
                  {req.product_name}
                </>
              }
              subline={subline(req)}
              busy={busyKey === `a${req.id}`}
              primary={
                canAct
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
              secondaryLabel={canAct ? 'Rad' : undefined}
              onSecondary={canAct ? () => setRejectTarget(req) : undefined}
            />
          ))}
        </WorkSection>

        {/* JARAYONDA — wait cards (no button, plain wait line) + the «Manba
            reja» step. The wait line prefers the backend's journey.wait_reason. */}
        <WorkSection
          label={WORK_BUCKET_LABELS.jarayonda}
          count={buckets.jarayonda.length}
        >
          {buckets.jarayonda.map((req) => {
            const waiting = isWaitCard(req);
            return (
              <WorkCard
                key={req.id}
                journey={req.journey}
                headline={
                  <>
                    {formatQtyUnit(req.qty_needed, req.product_unit)}{' '}
                    {req.product_name}
                    {waiting && ' — xom-ashyo kutilmoqda'}
                  </>
                }
                subline={subline(req)}
                waitReason={
                  waiting
                    ? (req.journey?.wait_reason ??
                      'Xarid homashyo omborida qabul qilingach, bu yerda «Tayyor» tugmasi chiqadi.')
                    : undefined
                }
                primary={
                  canAct && !waiting
                    ? {
                        label: 'Manba reja',
                        icon: (
                          <Sparkles className="size-4" aria-hidden="true" />
                        ),
                        variant: 'default',
                        onClick: () => setPlanTarget(req),
                      }
                    : undefined
                }
              />
            );
          })}
        </WorkSection>

        {/* TAYYOR — the zayafka is open; finish it to the sklad. */}
        <WorkSection label={WORK_BUCKET_LABELS.tayyor} count={buckets.tayyor.length}>
          {buckets.tayyor.map((req) => (
            <WorkCard
              key={req.id}
              journey={req.journey}
              headline={
                <>
                  {formatQtyUnit(req.qty_needed, req.product_unit)}{' '}
                  {req.product_name} tayyormi?
                </>
              }
              subline={subline(req)}
              busy={busyKey === `d${req.id}`}
              primary={
                canAct
                  ? {
                      label: 'Tayyor — skladga',
                      icon: <Factory className="size-4" aria-hidden="true" />,
                      variant: 'success',
                      onClick: () => handleDone(req),
                    }
                  : undefined
              }
              secondaryLabel={canAct ? 'Manba reja' : undefined}
              secondaryVariant="muted"
              onSecondary={canAct ? () => setPlanTarget(req) : undefined}
            />
          ))}
        </WorkSection>
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
