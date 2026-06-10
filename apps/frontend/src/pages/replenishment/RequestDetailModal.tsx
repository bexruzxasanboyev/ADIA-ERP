import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  ExternalLink,
  Factory,
  Info,
  Loader2,
  PackageCheck,
  Sparkles,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/components/ui/toast';
import { LoadingState } from '@/components/PageState';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useCanAct } from '@/hooks/useCanAct';
import { ApiError } from '@/lib/api-client';
import { formatDateTime, formatQty, formatQtyUnit } from '@/lib/format';
import { PIPELINE_STAGE_LABELS } from '@/lib/labels';
import { kanbanColumnOf, pipelineStageOf } from '@/lib/pipeline';
import {
  acceptFulfiller,
  acceptInternal,
  acceptProduction,
  rejectFulfiller,
  rejectInternal,
  rejectProduction,
} from '@/lib/replenishmentActions';
import {
  CLOSURE_REASON_LABELS,
  CLOSURE_REASON_VARIANT,
  isProductionInputWaiting,
  isRawPosterWaiting,
  qtyChipFor,
  REQUEST_ORIGIN_LABELS,
  REQUEST_ORIGIN_VARIANT,
  type FlowRequest,
} from '@/lib/replenishmentFlow';
import { TERMINAL_REPLENISHMENT_STATUSES } from '@/lib/types';
import type {
  LocationType,
  PipelineStage,
  ReplenishmentDetail,
} from '@/lib/types';
import { TransitionTimeline } from './TransitionTimeline';
import { RequestTreeSection } from './RequestTreeSection';

/**
 * THE Jira-card detail modal (phase F-G). Clicking any request card on any
 * So'rovlar surface opens this — a dark-premium, compact-but-generous panel
 * that shows the WHOLE request and hosts the role/state-aware action bar.
 *
 * It is opened with a `seed` (the FlowRequest from the board) so the header,
 * route line, and badges paint INSTANTLY; it then fetches
 * `GET /api/replenishment/:id` for the live row + transition history (the same
 * data the detail PAGE uses), so a freshly-acted request reflects the new state
 * after a refetch without a full navigation. The request-tree section
 * (`/:id/tree`) degrades to nothing on a 404.
 *
 * Reuse, not reinvent: every mutating action delegates to the EXISTING endpoint
 * helpers / rich dialogs. Where a dialog already exists (fulfilment, Manba
 * reja, cancel), this modal merely HOSTS the button and lets the parent open
 * that dialog via the `on*` callbacks — it never recreates the dialog body. The
 * accept/reject-fulfiller pair (pinned-target buffer accept) is wired here
 * directly because it is a single one-shot POST with an optional reason prompt.
 */

export interface RequestDetailModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The board row that was clicked (header paints from it immediately). */
  request: FlowRequest | null;
  /**
   * Refetch the host list after a state-changing action so the card moves to
   * its new column. Called after accept/reject-fulfiller resolves.
   */
  onActed?: () => void;
  /**
   * Central-manager hook: open the existing partial-fulfilment modal for this
   * store order. Absent on surfaces with no central context.
   */
  onFulfill?: (req: FlowRequest) => void;
  /**
   * Production hook: open the existing "Manba reja" modal for this incoming
   * production request. Absent on non-production surfaces.
   */
  onManbaReja?: (req: FlowRequest) => void;
  /**
   * Requester-side hook: open the existing CancelDialog. Absent where cancel is
   * not offered.
   */
  onCancel?: (req: FlowRequest) => void;
  /**
   * Store-requester hook (phase F-L §2): open the existing StoreReceiveDialog for
   * a reserved-shipped row so the do'kon can confirm receipt (brak flow included).
   * Only the store workspace passes it; on every other host (central / production
   * / replenishment pages) it is absent → the «Qabul qilish (yetkazib berildi)»
   * button is not rendered.
   */
  onReceive?: (req: FlowRequest) => void;
}

/** Small Uzbek caption for a location type (route-line sub-label). */
const LOCATION_TYPE_CAPTION: Record<LocationType, string> = {
  raw_warehouse: 'Xom-ashyo ombori',
  production: 'Ishlab chiqarish',
  supply: 'Sex skladi',
  sex_storage: 'Sex skladi',
  central_warehouse: 'Markaziy sklad',
  store: "Do‘kon",
};

/** Per-stage chip variant — mirrors the board column accents. */
const STAGE_VARIANT: Record<
  PipelineStage,
  'warning' | 'info' | 'success' | 'default' | 'secondary'
> = {
  kutuvda: 'warning',
  soralgan: 'info',
  qabul_qilingan: 'success',
  yuborilgan: 'default',
  yopilgan: 'secondary',
};

export function RequestDetailModal({
  open,
  onOpenChange,
  request,
  onActed,
  onFulfill,
  onManbaReja,
  onCancel,
  onReceive,
}: RequestDetailModalProps) {
  const id = request?.id ?? null;

  return (
    <Dialog open={open && id !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        {request !== null && id !== null ? (
          <ModalBody
            seed={request}
            requestId={id}
            onActed={onActed}
            onFulfill={onFulfill}
            onManbaReja={onManbaReja}
            onCancel={onCancel}
            onReceive={onReceive}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

interface ModalBodyProps {
  seed: FlowRequest;
  requestId: number;
  onActed?: () => void;
  onFulfill?: (req: FlowRequest) => void;
  onManbaReja?: (req: FlowRequest) => void;
  onCancel?: (req: FlowRequest) => void;
  onReceive?: (req: FlowRequest) => void;
  onClose: () => void;
}

function ModalBody({
  seed,
  requestId,
  onActed,
  onFulfill,
  onManbaReja,
  onCancel,
  onReceive,
  onClose,
}: ModalBodyProps) {
  const { notify } = useToast();
  const { canActOn, isReadOnly } = useCanAct();

  // The detail fetch refines the seed (live status + transitions). Until it
  // lands we render entirely from the seed, so the panel never flashes blank.
  const detail = useApiQuery<ReplenishmentDetail>(
    `/api/replenishment/${requestId}`,
  );
  const live = (detail.data?.request as FlowRequest | undefined) ?? seed;
  const transitions = detail.data?.transitions ?? [];

  const [busy, setBusy] = useState<'accept' | 'reject' | null>(null);

  const stage = useMemo(() => pipelineStageOf(live), [live]);
  // The kanban column drives the header qty chip (shipped vs. needed), mirroring
  // the card exactly (phase F-L §3).
  const column = useMemo(() => kanbanColumnOf(live), [live]);
  const qtyChip = useMemo(() => qtyChipFor(live, column), [live, column]);
  const rawWaiting = isRawPosterWaiting(live, stage);
  const isTerminal = TERMINAL_REPLENISHMENT_STATUSES.includes(live.status);

  // ----- Action matrix (role × state) --------------------------------------
  // A pinned-target operator may accept/reject a NOT-yet-accepted incoming
  // request. The sex_storage-REQUESTER buffer variant uses accept-internal.
  const isTargetOperator = canActOn(live.target_location_id);
  const alreadyAccepted = Boolean(live.fulfiller_accepted_at);
  const isBufferRow = live.target_location_type === 'sex_storage';
  const canAcceptFulfiller =
    isTargetOperator && !isTerminal && !alreadyAccepted && stage === 'kutuvda';

  // F-L §1: the отдел GATE. A production-assigned row holding at
  // CHECK_PRODUCTION_INPUT (not yet accepted) — its making отдел's operator may
  // accept (releases the engine) or reject. Gated by the row's
  // `production_location_id`, NOT its target (which still points at central), so
  // it never overlaps `canAcceptFulfiller` (that one needs stage===kutuvda; a
  // gate row resolves to soralgan). `isProductionInputWaiting` already guards the
  // status + unaccepted state; we add the operator scope + a non-terminal check.
  const canAcceptProduction =
    canActOn(live.production_location_id) &&
    !isTerminal &&
    isProductionInputWaiting(live);

  // Central manager fulfilling a downstream (store) request from central stock.
  const isStoreRequest = live.requester_location_type === 'store';
  const canCentralFulfill =
    onFulfill !== undefined &&
    isTargetOperator &&
    !isTerminal &&
    isStoreRequest &&
    stage === 'kutuvda';

  // Production incoming → Manba reja (source plan, the manual override tool).
  // Two operator shapes reach it (F-L §1 keeps it visible ALONGSIDE the gate's
  // accept/reject): the classic case where the отдел IS the target
  // (target_location_type === 'production'), AND the production-ASSIGNED case
  // where the target still points at central but `production_location_id` is the
  // viewer's отдел (a routed central shortfall). The latter reuses the same
  // operator-of-production_location scope as the accept gate.
  const isProductionOperator =
    (isTargetOperator && live.target_location_type === 'production') ||
    canActOn(live.production_location_id);
  const canManbaReja =
    onManbaReja !== undefined && isProductionOperator && !isTerminal;

  // Requester side may cancel its own OPEN request.
  const canCancel =
    onCancel !== undefined && canActOn(live.requester_location_id) && !isTerminal;

  // F-L §2: the do'kon RECEIVE. A reserved-shipped row (central partial-fulfill
  // path: CLOSED, no closure_reason, fulfiller_accepted_at stamped — the SAME
  // predicate the store's "Qabul qiluvchi" tab uses) whose requester is the
  // viewer's store → the green «Qabul qilish (yetkazib berildi)» opens the
  // EXISTING StoreReceiveDialog (brak flow included). Only mounted where the host
  // passes `onReceive` (the store workspace); absent elsewhere by design.
  const isReservedShipped =
    live.status === 'CLOSED' &&
    live.closure_reason == null &&
    live.fulfiller_accepted_at != null;
  const canStoreReceive =
    onReceive !== undefined &&
    canActOn(live.requester_location_id) &&
    isReservedShipped;

  // Store receive/accept/return flows are rich + live on the detail page —
  // link there instead of recreating them here. Suppressed when the dedicated
  // F-L §2 receive button is already offered (a reserved-shipped CLOSED row), so
  // the modal does not show BOTH "To'liq sahifa" receive and the inline receive.
  const showFullPageReceive =
    !canStoreReceive &&
    canActOn(live.requester_location_id) &&
    (live.status === 'SHIP_TO_REQUESTER' ||
      live.status === 'DONE_TO_WAREHOUSE' ||
      live.status === 'CLOSED');

  async function runAccept() {
    setBusy('accept');
    try {
      const fn = isBufferRow ? acceptInternal : acceptFulfiller;
      const res = await fn(requestId);
      notify(
        'success',
        res.shipped
          ? `#${requestId} qabul qilindi va jo‘natildi.`
          : `#${requestId} qabul qilindi.`,
      );
      detail.refetch();
      onActed?.();
    } catch (err: unknown) {
      notify('error', acceptError(err));
    } finally {
      setBusy(null);
    }
  }

  async function runReject() {
    const reason = window.prompt('Rad etish sababi (ixtiyoriy):') ?? undefined;
    setBusy('reject');
    try {
      const fn = isBufferRow ? rejectInternal : rejectFulfiller;
      await fn(requestId, reason && reason.trim() !== '' ? reason.trim() : undefined);
      notify('success', `#${requestId} rad etildi.`);
      detail.refetch();
      onActed?.();
    } catch (err: unknown) {
      notify('error', acceptError(err));
    } finally {
      setBusy(null);
    }
  }

  // F-L §1 — release the отдел gate. Accept stamps `fulfiller_accepted_at`; the
  // replenishment engine then runs зг-check / transfers / PO on its NEXT cron
  // pass (this POST does no synchronous cascade), hence the toast wording. After
  // the refetch the row moves out of Kutuvda by the normal rules.
  async function runAcceptProduction() {
    setBusy('accept');
    try {
      await acceptProduction(requestId);
      notify('success', `#${requestId} qabul qilindi — зг tekshiruvi boshlandi.`);
      detail.refetch();
      onActed?.();
    } catch (err: unknown) {
      notify('error', acceptError(err));
    } finally {
      setBusy(null);
    }
  }

  async function runRejectProduction() {
    const reason = window.prompt('Rad etish sababi (ixtiyoriy):') ?? undefined;
    setBusy('reject');
    try {
      await rejectProduction(
        requestId,
        reason && reason.trim() !== '' ? reason.trim() : undefined,
      );
      notify('success', `#${requestId} rad etildi.`);
      detail.refetch();
      onActed?.();
    } catch (err: unknown) {
      notify('error', acceptError(err));
    } finally {
      setBusy(null);
    }
  }

  const origin = live.origin ?? null;
  const closure = stage === 'yopilgan' ? live.closure_reason ?? null : null;
  const brak = live.brak_qty != null && live.brak_qty > 0 ? live.brak_qty : null;

  return (
    <>
      {/* ----- Header ----- */}
      <DialogHeader>
        <DialogTitle className="flex flex-wrap items-center gap-x-2 gap-y-1 pr-8">
          <span className="text-sm font-normal text-muted-foreground tabular-nums">
            #{live.id}
          </span>
          <span className="text-base font-semibold">{live.product_name}</span>
          <Badge variant="outline" className="tabular-nums">
            {qtyChip.primary}
          </Badge>
          {qtyChip.suffix !== null && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {qtyChip.suffix}
            </span>
          )}
          <Badge variant={STAGE_VARIANT[stage]}>
            {PIPELINE_STAGE_LABELS[stage]}
          </Badge>
          {origin && (
            <Badge variant={REQUEST_ORIGIN_VARIANT[origin]}>
              {REQUEST_ORIGIN_LABELS[origin]}
            </Badge>
          )}
          {brak !== null && (
            <Badge variant="danger" className="tabular-nums">
              brak {formatQtyUnit(brak, live.product_unit)}
            </Badge>
          )}
          {rawWaiting && (
            <Badge variant="warning" className="gap-1">
              <Sparkles className="size-3" aria-hidden="true" />
              Poster kutilmoqda
            </Badge>
          )}
          {closure && (
            <Badge variant={CLOSURE_REASON_VARIANT[closure]}>
              {CLOSURE_REASON_LABELS[closure]}
            </Badge>
          )}
        </DialogTitle>
        <DialogDescription>
          <RouteLine req={live} />
        </DialogDescription>
      </DialogHeader>

      {/* ----- Scrollable body ----- */}
      <div className="scrollbar-thin -mx-1 max-h-[60vh] space-y-4 overflow-y-auto px-1">
        {/* Poster instruction block — raw-accepted-waiting only. */}
        {rawWaiting && (
          <div className="flex gap-3 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
            <Info
              className="mt-0.5 size-4 shrink-0 text-warning"
              aria-hidden="true"
            />
            <div className="space-y-1">
              <p className="font-medium text-foreground">Poster ko‘rsatmasi</p>
              <p className="text-muted-foreground">
                Poster’da «Поставки» → Основной склад’ga qo‘shing. Sinxron
                kelgach mahsulot avtomatik jo‘natiladi.
              </p>
            </div>
          </div>
        )}

        {/* Meta grid. */}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-border/60 bg-surface-3 p-3 text-sm">
          <Meta label="Yaratilgan">{formatDateTime(live.created_at)}</Meta>
          <Meta label="Yangilangan">{formatDateTime(live.updated_at)}</Meta>
          {live.batch_id != null && (
            <Meta label="Partiya">#{live.batch_id}</Meta>
          )}
          {live.qty_accepted != null && (
            <Meta label="Qabul qilindi">
              {formatQty(live.qty_accepted)} {live.product_unit}
            </Meta>
          )}
          {live.qty_returned != null && live.qty_returned > 0 && (
            <Meta label="Qaytarildi">
              {formatQty(live.qty_returned)} {live.product_unit}
            </Meta>
          )}
          {brak !== null && (
            <Meta label="Yaroqsiz (brak)">
              {formatQty(brak)} {live.product_unit}
            </Meta>
          )}
          {live.production_order_id != null && (
            <Meta label="Zayafka">
              <Link
                to="/production-orders"
                className="text-primary hover:underline"
              >
                #{live.production_order_id}
              </Link>
            </Meta>
          )}
          {live.purchase_order_id != null && (
            <Meta label="Sotib olish">
              <Link
                to="/purchase-orders"
                className="text-primary hover:underline"
              >
                #{live.purchase_order_id}
              </Link>
            </Meta>
          )}
        </dl>

        {/* Free-text blocks. */}
        {live.note && (
          <Note label="Izoh" tone="neutral">
            {live.note}
          </Note>
        )}
        {live.accept_note && (
          <Note label="Qabul izohi" tone="success">
            {live.accept_note}
          </Note>
        )}
        {(live.reject_reason || live.brak_reason) && (
          <Note label="Sabab" tone="danger">
            {live.reject_reason ?? live.brak_reason}
          </Note>
        )}

        {/* Transition history — same data the detail page renders. */}
        <section>
          <h3 className="mb-1 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            O‘tishlar tarixi
          </h3>
          {detail.isLoading && transitions.length === 0 ? (
            <LoadingState />
          ) : (
            <div className="rounded-lg border border-border/60 bg-surface-3">
              <TransitionTimeline transitions={transitions} />
            </div>
          )}
        </section>

        {/* So'rovlar daraxti — 404-degrades to nothing. */}
        <RequestTreeSection requestId={String(requestId)} />
      </div>

      {/* ----- Action bar ----- */}
      <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-4">
        {isReadOnly && (
          <Badge variant="secondary" aria-label="Faqat o‘qish rejimi">
            Faqat o‘qish
          </Badge>
        )}

        {canAcceptFulfiller && (
          <>
            {/* Owner: NO emojis in the modal — meaning rides on COLOUR:
                accept = green, reject = red, ship = blue (primary). */}
            <Button
              variant="success"
              onClick={runAccept}
              disabled={busy !== null}
            >
              {busy === 'accept' ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : null}
              Qabul qilish
            </Button>
            <Button
              variant="destructive"
              onClick={runReject}
              disabled={busy !== null}
            >
              {busy === 'reject' ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : null}
              Rad etish
            </Button>
          </>
        )}

        {/* F-L §1 — отдел gate: accept (green, releases the engine) / reject
            (red). Colour carries meaning, no emojis (owner). */}
        {canAcceptProduction && (
          <>
            <Button
              variant="success"
              onClick={runAcceptProduction}
              disabled={busy !== null}
            >
              {busy === 'accept' ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : null}
              Qabul qilish
            </Button>
            <Button
              variant="destructive"
              onClick={runRejectProduction}
              disabled={busy !== null}
            >
              {busy === 'reject' ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : null}
              Rad etish
            </Button>
          </>
        )}

        {canCentralFulfill && (
          <Button
            onClick={() => {
              onFulfill?.(live);
              onClose();
            }}
          >
            Jo‘natish (qisman)
          </Button>
        )}

        {/* F-L §2 — do'kon receive: closes the modal, opens StoreReceiveDialog
            (brak flow inside). Green = accept/receive. */}
        {canStoreReceive && (
          <Button
            variant="success"
            onClick={() => {
              onReceive?.(live);
              onClose();
            }}
          >
            <PackageCheck className="size-4" aria-hidden="true" />
            Qabul qilish (yetkazib berildi)
          </Button>
        )}

        {canManbaReja && (
          <Button
            variant="outline"
            onClick={() => {
              onManbaReja?.(live);
              onClose();
            }}
          >
            <Sparkles className="size-4" aria-hidden="true" />
            Manba reja
          </Button>
        )}

        {showFullPageReceive && (
          <Button variant="outline" asChild>
            <Link to={`/replenishment/${live.id}`}>
              <Factory className="size-4" aria-hidden="true" />
              To‘liq sahifa
            </Link>
          </Button>
        )}

        {canCancel && (
          <Button
            variant="outline"
            onClick={() => {
              onCancel?.(live);
              onClose();
            }}
          >
            Bekor qilish
          </Button>
        )}

        {/* Footer link — always available, pushed to the right. */}
        <Button variant="ghost" size="sm" asChild className="ml-auto">
          <Link to={`/replenishment/${live.id}`}>
            To‘liq sahifa
            <ExternalLink className="size-3.5" aria-hidden="true" />
          </Link>
        </Button>
      </div>
    </>
  );
}

/** "requester → target" with small type captions under each name. */
function RouteLine({ req }: { req: FlowRequest }) {
  return (
    <span className="flex flex-wrap items-end gap-x-2 gap-y-1 text-sm">
      <span className="flex flex-col">
        <span className="font-medium text-foreground">
          {req.requester_location_name}
        </span>
        {req.requester_location_type && (
          <span className="text-[11px] text-muted-foreground">
            {LOCATION_TYPE_CAPTION[req.requester_location_type]}
          </span>
        )}
      </span>
      <ArrowRight
        className="mb-1 size-4 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      <span className="flex flex-col">
        <span className="font-medium text-foreground">
          {req.target_location_name ?? '—'}
        </span>
        {req.target_location_type && (
          <span className="text-[11px] text-muted-foreground">
            {LOCATION_TYPE_CAPTION[req.target_location_type]}
          </span>
        )}
      </span>
    </span>
  );
}

function Meta({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-0.5">
      <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd className="tabular-nums">{children}</dd>
    </div>
  );
}

function Note({
  label,
  tone,
  children,
}: {
  label: string;
  tone: 'neutral' | 'success' | 'danger';
  children: React.ReactNode;
}) {
  const cls =
    tone === 'success'
      ? 'border-success/30 bg-success/5'
      : tone === 'danger'
        ? 'border-destructive/30 bg-destructive/5'
        : 'border-border/60 bg-surface-3';
  return (
    <div className={`rounded-lg border ${cls} px-3 py-2 text-sm`}>
      <p className="mb-0.5 text-[11px] uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="text-foreground/90">{children}</p>
    </div>
  );
}

/** Friendly Uzbek message for an accept/reject failure. */
function acceptError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) {
      return 'Sizda bu amalni bajarish huquqi yo‘q.';
    }
    if (err.status === 404) {
      return 'Endpoint tayyor emas, biroz keyin urinib ko‘ring.';
    }
    if (err.code === 'INVALID_TRANSITION') {
      return 'Bu holatda amalni bajarib bo‘lmaydi.';
    }
    return err.message;
  }
  return 'Amalni bajarib bo‘lmadi. Qayta urinib ko‘ring.';
}
