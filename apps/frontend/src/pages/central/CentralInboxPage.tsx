import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  Check,
  Clock,
  Factory,
  Loader2,
  Warehouse,
  X,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from '@/components/PageState';
import { useToast } from '@/components/ui/toast';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useAuth } from '@/hooks/useAuth';
import { apiRequest, ApiError } from '@/lib/api-client';
import { acceptCentral, sendToProduction } from '@/lib/replenishmentActions';
import { formatDateTime, formatQtyUnit } from '@/lib/format';
import { groupByBatch, type BatchGroup } from '@/lib/groupByBatch';
import {
  REPLENISHMENT_STATUS_LABELS,
  REPLENISHMENT_STATUS_VARIANT,
} from '@/lib/labels';
import { cn } from '@/lib/utils';
import { isCentralInboxActionable } from '@/lib/types';
import type {
  Location,
  ReplenishmentStatus,
  StockRow,
} from '@/lib/types';

/**
 * Markaziy sklad — kiruvchi so'rovlar (incoming store requests inbox).
 *
 * The central warehouse manager (or PM, with a central-warehouse picker)
 * reviews replenishment requests targeted at the central warehouse and
 * either accepts (ships / fulfils) or rejects them with a reason.
 *
 * Owner feedback: a store basket confirmed together arrives as ONE order, so
 * the inbox GROUPS incoming lines by `(requester_location_id, batch_id)` and
 * renders each order as a single card with whole-group accept / reject. Legacy
 * rows (`batch_id === null`) render individually with the single-line actions.
 *
 * Scale (Brightpearl "manage by exception" + bulk-action UX):
 *   - A «Diqqat kerak» (exception) section floats the orders that need
 *     attention FIRST: any order the central is SHORT for (a plain accept would
 *     return `shipped:false` → route to production) and/or stale orders (older
 *     than {@link STALE_AFTER_MS}). Flagged with warning badges; the normal
 *     inbox follows below.
 *   - Per-line CHECKBOXES + a select-all + a sticky floating action bar let the
 *     manager accept / send-to-production / reject MANY requests at once. Each
 *     bulk action loops the existing per-request endpoints (reusing the per
 *     -batch accept/reject when a whole batch is selected), fires one summary
 *     toast, and refetches both feeds.
 *
 * Backend contracts:
 *   - List:        GET  /api/replenishment/incoming?location_id=<central>
 *                    → { items: IncomingRequest[] }   (each carries batch_id)
 *   - Central stock (exception signal, read-only):
 *                  GET  /api/stock?location_id=<central> → StockRow[]
 *   - Accept 1:    POST /api/replenishment/:id/accept-central  body { location_id }
 *   - To prod 1:   POST /api/replenishment/:id/to-production   body { location_id }
 *   - Reject 1:    POST /api/replenishment/:id/reject-central  body { reason }
 *   - Accept all:  POST /api/replenishment/batch/:batch_id/accept-central
 *                    body { location_id } → { batch_id, accepted, shipped, failed }
 *   - Reject all:  POST /api/replenishment/batch/:batch_id/reject-central
 *                    body { reason } → { batch_id, cancelled }
 *   - Picker:      GET  /api/locations  (filtered to type === 'central_warehouse')
 *
 * The backend RBAC-scopes the list; a scoped central manager is pinned to
 * their location, so the picker is PM-only.
 */
interface IncomingRequest {
  id: number;
  product_id: number;
  product_name: string;
  /** Birlik — backend `incoming` endpoint emits the product unit as `unit`. */
  unit: string;
  requester_location_id: number;
  requester_location_name: string | null;
  qty_needed: number;
  status: ReplenishmentStatus;
  /** Order/basket grouping key; `null` for legacy / individual rows. */
  batch_id: number | null;
  created_at: string;
}

interface IncomingResponse {
  items: IncomingRequest[];
}

/** `POST /batch/:batch_id/accept-central` response envelope. */
interface BatchAcceptResponse {
  batch_id: number;
  accepted: number;
  shipped: number;
  failed: { request_id: number; message: string }[];
}

/**
 * An order older than this (ms) is flagged "Eskirgan" and surfaced in the
 * «Diqqat kerak» section — 24h. Kept generous so only genuinely-stale orders
 * jump the queue (the central short signal is the primary attention driver).
 */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/** Why an order landed in the exception section (drives its warning badges). */
interface ExceptionFlags {
  /** Central holds less than at least one line needs → accept won't ship. */
  short: boolean;
  /** Oldest in the queue — older than {@link STALE_AFTER_MS}. */
  stale: boolean;
}

export function CentralInboxPage({
  embedded = false,
  onActionDone,
}: {
  /**
   * When `true` the inbox is rendered INSIDE the So'rovlar tab
   * (`CentralRequestsTab`), so it drops its own `PageHeader` and page-width
   * wrapper — the tab already supplies the section header + chrome. Standalone
   * (`embedded === false`, the routed page) keeps the full header.
   */
  embedded?: boolean;
  /**
   * Fired after EVERY successful inbox action (accept / to-production / reject,
   * single OR batch, single OR bulk). When embedded in `CentralRequestsTab` the
   * parent passes `allRequests.refetch` here so the handled request also lands
   * in the «Chiqgan» tracker / «Qabul qilingan» history and the charts update —
   * the inbox's own `/incoming` refetch only drops the row from Kiruvchi.
   */
  onActionDone?: () => void;
} = {}) {
  const { user, activeLocationId } = useAuth();
  const { notify } = useToast();
  const isPm = user?.role === 'pm';

  // PM picks a central warehouse; a scoped central manager is pinned to
  // their active location (falling back to their primary location_id).
  const [pickedCentralId, setPickedCentralId] = useState<string>('');
  const scopedCentralId = isPm
    ? pickedCentralId
    : String(activeLocationId ?? user?.location_id ?? '');
  const centralIdNum = scopedCentralId === '' ? null : Number(scopedCentralId);

  const locations = useApiQuery<Location[]>(isPm ? '/api/locations' : null);
  const centralOptions = useMemo(
    () =>
      (locations.data ?? []).filter((l) => l.type === 'central_warehouse'),
    [locations.data],
  );

  const incoming = useApiQuery<IncomingResponse>(
    centralIdNum === null
      ? null
      : `/api/replenishment/incoming?location_id=${centralIdNum}`,
  );

  // Central warehouse own stock — the exception signal. We only need on-hand
  // qty per product to decide whether a plain accept would ship; read-only and
  // RBAC-scoped to this central. PM with no central picked skips the fetch.
  const centralStock = useApiQuery<StockRow[]>(
    centralIdNum === null ? null : `/api/stock?location_id=${centralIdNum}`,
  );
  const stockByProduct = useMemo(() => {
    const map = new Map<number, number>();
    for (const row of centralStock.data ?? []) {
      map.set(row.product_id, row.qty);
    }
    return map;
  }, [centralStock.data]);

  // Show ONLY still-actionable lines (NEW / CHECK_STORE_SUPPLIER). The
  // `/incoming` endpoint keeps returning a request after it has been accepted
  // or routed into production (it is still "targeted at central"), but those
  // belong in the «Chiqgan» tracker / «Qabul qilingan» history — not the
  // actionable inbox. Filtering them out here is what makes the accept / send /
  // reject buttons disappear after a successful action: the handled line drops
  // out of the list, so a second click can never double-accept or double-route.
  const rows = useMemo(
    () =>
      (incoming.data?.items ?? []).filter((r) =>
        isCentralInboxActionable(r.status),
      ),
    [incoming.data],
  );

  // Group the actionable lines into orders by (requester_location_id, batch_id).
  // Batches → one card with whole-group actions; legacy null-batch rows →
  // singleton groups rendered with the single-line accept / reject UI. A batch
  // whose lines are all handled produces no group, so the order card vanishes.
  const groups = useMemo(() => groupByBatch(rows), [rows]);

  // Classify each order: does the central fall SHORT for any line (accept won't
  // ship → production), and/or is it STALE (oldest in the queue)? An order with
  // either flag is surfaced in «Diqqat kerak» first; the rest follow below.
  const exceptionByKey = useMemo(() => {
    const now = Date.now();
    const map = new Map<string, ExceptionFlags>();
    for (const g of groups) {
      const short = g.lines.some(
        (l) => l.qty_needed > (stockByProduct.get(l.product_id) ?? 0),
      );
      const stale = now - new Date(g.created_at).getTime() > STALE_AFTER_MS;
      if (short || stale) map.set(g.key, { short, stale });
    }
    return map;
  }, [groups, stockByProduct]);

  // Stock may still be loading when groups first render; until it resolves we
  // can't trust the "short" signal, so an order is only flagged short once the
  // stock query has data. Stale is independent of stock.
  const stockReady = centralStock.data !== null;
  const exceptionGroups = useMemo(
    () => groups.filter((g) => exceptionByKey.has(g.key)),
    [groups, exceptionByKey],
  );
  const normalGroups = useMemo(
    () => groups.filter((g) => !exceptionByKey.has(g.key)),
    [groups, exceptionByKey],
  );

  // A single busy key locks every action button while one request is in
  // flight: `g<batch_id>` for a group accept, `r<id>` for a single accept,
  // `p<id>` for a single send-to-production. `bulk` locks the whole UI while a
  // bulk action loops.
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const anyBusy = busyKey !== null;
  const [rejectTarget, setRejectTarget] = useState<
    | { kind: 'single'; request: IncomingRequest }
    | { kind: 'group'; group: BatchGroup<IncomingRequest> }
    | { kind: 'bulk'; lines: IncomingRequest[] }
    | null
  >(null);

  // ---- Bulk selection -----------------------------------------------------
  // The set of selected REQUEST ids (line-level — the bulk bar acts on
  // individual lines, reusing the per-batch endpoint when a whole batch is
  // selected). Stale ids (lines that left the inbox after a refetch) are
  // pruned whenever the actionable id set changes.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const allIds = useMemo(() => rows.map((r) => r.id), [rows]);
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(allIds);
      let changed = false;
      const next = new Set<number>();
      for (const id of prev) {
        if (live.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [allIds]);

  const selectedLines = useMemo(
    () => rows.filter((r) => selected.has(r.id)),
    [rows, selected],
  );
  const selectedCount = selectedLines.length;
  const allSelected = allIds.length > 0 && selectedCount === allIds.length;
  const someSelected = selectedCount > 0 && !allSelected;

  function toggleOne(id: number, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }
  function toggleGroup(group: BatchGroup<IncomingRequest>, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const line of group.lines) {
        if (on) next.add(line.id);
        else next.delete(line.id);
      }
      return next;
    });
  }
  function toggleAll(on: boolean) {
    setSelected(on ? new Set(allIds) : new Set());
  }
  function clearSelection() {
    setSelected(new Set());
  }

  async function handleAcceptSingle(row: IncomingRequest) {
    if (centralIdNum === null) return;
    setBusyKey(`r${row.id}`);
    try {
      const res = await acceptCentral(row.id, centralIdNum);
      if (res.shipped) {
        notify('success', `#${row.id} qabul qilinib, do‘konga jo‘natildi.`);
      } else {
        // Central stock is short — accept did NOT cascade to production. Nudge
        // the manager toward "Ishlab chiqarishga yuborish" so they aren't stuck.
        notify(
          'error',
          `${res.reason || 'Markaziy skladda yetarli qoldiq yo‘q.'} «Ishlab chiqarishga yuborish» tugmasidan foydalaning.`,
        );
      }
      incoming.refetch();
      centralStock.refetch();
      onActionDone?.();
    } catch (err: unknown) {
      notify(
        'error',
        err instanceof ApiError ? err.message : 'Qabul qilib bo‘lmadi.',
      );
    } finally {
      setBusyKey(null);
    }
  }

  async function handleSendToProductionSingle(row: IncomingRequest) {
    if (centralIdNum === null) return;
    setBusyKey(`p${row.id}`);
    try {
      const res = await sendToProduction(row.id, centralIdNum);
      if (res.advanced) {
        notify('success', `#${row.id} ishlab chiqarishga yuborildi.`);
      } else {
        // No production topology / BOM — the request couldn't advance.
        notify(
          'error',
          res.reason || 'Ishlab chiqarishga yuborib bo‘lmadi (BOM yo‘q).',
        );
      }
      incoming.refetch();
      onActionDone?.();
    } catch (err: unknown) {
      notify(
        'error',
        err instanceof ApiError
          ? err.message
          : 'Ishlab chiqarishga yuborib bo‘lmadi.',
      );
    } finally {
      setBusyKey(null);
    }
  }

  async function handleAcceptGroup(group: BatchGroup<IncomingRequest>) {
    if (group.batch_id === null) return;
    setBusyKey(`g${group.batch_id}`);
    try {
      const res = await apiRequest<BatchAcceptResponse>(
        `/api/replenishment/batch/${group.batch_id}/accept-central`,
        { method: 'POST', body: { location_id: centralIdNum } },
      );
      const failedCount = res.failed?.length ?? 0;
      const base = `${res.accepted} ta qabul qilindi, ${res.shipped} tasi jo‘natildi`;
      notify(
        failedCount > 0 ? 'error' : 'success',
        failedCount > 0 ? `${base}, ${failedCount} tasida xato.` : `${base}.`,
      );
      incoming.refetch();
      centralStock.refetch();
      onActionDone?.();
    } catch (err: unknown) {
      notify(
        'error',
        err instanceof ApiError ? err.message : 'Qabul qilib bo‘lmadi.',
      );
    } finally {
      setBusyKey(null);
    }
  }

  // ---- Bulk actions -------------------------------------------------------
  // Each loops the existing per-request endpoints over the selected lines,
  // accumulates ok/fail counts, fires ONE summary toast, then refetches both
  // feeds and clears the selection. The whole UI is locked (`busyKey='bulk'`)
  // while a bulk action runs. Calls are sequential so a burst can't overwhelm
  // the API or interleave stock decrements unpredictably.
  async function handleBulkAccept() {
    if (centralIdNum === null || selectedLines.length === 0) return;
    setBusyKey('bulk');
    let shipped = 0;
    let queued = 0; // accepted but central short → not shipped (needs production)
    const failed: number[] = [];
    for (const line of selectedLines) {
      try {
        const res = await acceptCentral(line.id, centralIdNum);
        if (res.shipped) shipped += 1;
        else queued += 1;
      } catch {
        failed.push(line.id);
      }
    }
    const okCount = shipped + queued;
    let msg = `${okCount} ta qabul qilindi`;
    if (queued > 0) msg += `, ${queued} tasida qoldiq yetmadi (ishlab chiqarishga yuboring)`;
    if (failed.length > 0) msg += `, ${failed.length} tasida xato (#${failed.join(', #')})`;
    notify(failed.length > 0 || queued > 0 ? 'error' : 'success', `${msg}.`);
    setBusyKey(null);
    clearSelection();
    incoming.refetch();
    centralStock.refetch();
    onActionDone?.();
  }

  async function handleBulkToProduction() {
    if (centralIdNum === null || selectedLines.length === 0) return;
    setBusyKey('bulk');
    let advanced = 0;
    let stuck = 0; // no BOM / topology → request couldn't advance
    const failed: number[] = [];
    for (const line of selectedLines) {
      try {
        const res = await sendToProduction(line.id, centralIdNum);
        if (res.advanced) advanced += 1;
        else stuck += 1;
      } catch {
        failed.push(line.id);
      }
    }
    let msg = `${advanced} ta ishlab chiqarishga yuborildi`;
    if (stuck > 0) msg += `, ${stuck} tasi yuborilmadi (BOM yo‘q)`;
    if (failed.length > 0) msg += `, ${failed.length} tasida xato (#${failed.join(', #')})`;
    notify(failed.length > 0 || stuck > 0 ? 'error' : 'success', `${msg}.`);
    setBusyKey(null);
    clearSelection();
    incoming.refetch();
    onActionDone?.();
  }

  return (
    <div className={cn(!embedded && 'mx-auto w-full max-w-5xl', 'space-y-6')}>
      {!embedded && (
        <PageHeader
          title="Markaziy sklad — kiruvchi so‘rovlar"
          description="Do‘konlardan kelgan to‘ldirish so‘rovlarini buyurtma bo‘yicha qabul qiling yoki rad eting."
          actions={
            isPm && (
              <Badge
                variant="secondary"
                className="h-10 items-center px-3"
                aria-label="Faqat ko‘rish rejimi"
              >
                Faqat ko‘rish
              </Badge>
            )
          }
        />
      )}

      {isPm && (
        <div className="space-y-1">
          <Label htmlFor="central-picker">Markaziy sklad</Label>
          <Select
            id="central-picker"
            className="w-full sm:w-72"
            value={pickedCentralId}
            onChange={(e) => setPickedCentralId(e.target.value)}
          >
            <option value="">— Markaziy skladni tanlang —</option>
            {centralOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </div>
      )}

      {centralIdNum === null ? (
        <Card>
          <EmptyState
            message={
              isPm
                ? 'Boshlash uchun markaziy skladni tanlang.'
                : 'Sizga markaziy sklad biriktirilmagan.'
            }
          />
        </Card>
      ) : (
        <>
          {/* «Diqqat kerak» — exception-first section. Orders the central is
              short for (accept won't ship → production) and/or stale orders,
              surfaced ABOVE the normal inbox so the manager handles them first.
              Hidden entirely when nothing needs attention. */}
          {!incoming.isLoading &&
            !incoming.error &&
            exceptionGroups.length > 0 && (
              <Card className="border-warning/40">
                <header className="flex items-center gap-2 border-b border-warning/30 bg-warning/5 p-5">
                  <AlertTriangle
                    className="size-4 text-warning"
                    aria-hidden="true"
                  />
                  <div className="space-y-0.5">
                    <h2 className="flex items-center gap-2 text-base font-semibold">
                      Diqqat kerak
                      <Badge variant="warning" className="tabular-nums">
                        {exceptionGroups.length}
                      </Badge>
                    </h2>
                    <p className="text-xs text-muted-foreground">
                      Qoldiq yetmagan (qabul qilinsa jo‘natilmaydi — ishlab
                      chiqarishga yuboring) yoki uzoq kutgan buyurtmalar.
                    </p>
                  </div>
                </header>
                <div className="space-y-4 p-5">
                  {exceptionGroups.map((group) => (
                    <OrderCard
                      key={group.key}
                      group={group}
                      isPm={isPm}
                      busyKey={busyKey}
                      anyBusy={anyBusy}
                      exception={exceptionByKey.get(group.key) ?? null}
                      stockReady={stockReady}
                      selected={selected}
                      onToggleOne={toggleOne}
                      onToggleGroup={toggleGroup}
                      onAcceptGroup={() => handleAcceptGroup(group)}
                      onRejectGroup={() =>
                        setRejectTarget({ kind: 'group', group })
                      }
                      onAcceptSingle={handleAcceptSingle}
                      onSendToProductionSingle={handleSendToProductionSingle}
                      onRejectSingle={(request) =>
                        setRejectTarget({ kind: 'single', request })
                      }
                    />
                  ))}
                </div>
              </Card>
            )}

          <Card>
            <header className="flex flex-col gap-3 border-b border-border/60 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2">
                <Warehouse className="size-4 text-primary" aria-hidden="true" />
                <div className="space-y-0.5">
                  <h2 className="text-base font-semibold">
                    Kiruvchi buyurtmalar
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    Har bir buyurtma — bitta do‘kon birga yuborgan so‘rovlar
                    to‘plami.
                  </p>
                </div>
              </div>

              {/* Select-all — only when there are actionable lines and the
                  manager can act (PM is read-only). */}
              {!isPm && allIds.length > 0 && (
                <CheckboxField
                  id="inbox-select-all"
                  checked={allSelected}
                  indeterminate={someSelected}
                  onChange={(on) => toggleAll(on)}
                  disabled={anyBusy}
                  label="Hammasini tanlash"
                />
              )}
            </header>

            {incoming.isLoading && <LoadingState />}
            {!incoming.isLoading && incoming.error && (
              <ErrorState message={incoming.error} onRetry={incoming.refetch} />
            )}
            {!incoming.isLoading && !incoming.error && groups.length === 0 && (
              <EmptyState message="Hozircha kiruvchi so‘rov yo‘q." />
            )}
            {!incoming.isLoading &&
              !incoming.error &&
              groups.length > 0 &&
              normalGroups.length === 0 && (
                <EmptyState message="Barcha kiruvchi so‘rovlar «Diqqat kerak» bo‘limida." />
              )}
            {!incoming.isLoading &&
              !incoming.error &&
              normalGroups.length > 0 && (
                <div className="space-y-4 p-5">
                  {normalGroups.map((group) => (
                    <OrderCard
                      key={group.key}
                      group={group}
                      isPm={isPm}
                      busyKey={busyKey}
                      anyBusy={anyBusy}
                      exception={null}
                      stockReady={stockReady}
                      selected={selected}
                      onToggleOne={toggleOne}
                      onToggleGroup={toggleGroup}
                      onAcceptGroup={() => handleAcceptGroup(group)}
                      onRejectGroup={() =>
                        setRejectTarget({ kind: 'group', group })
                      }
                      onAcceptSingle={handleAcceptSingle}
                      onSendToProductionSingle={handleSendToProductionSingle}
                      onRejectSingle={(request) =>
                        setRejectTarget({ kind: 'single', request })
                      }
                    />
                  ))}
                </div>
              )}
          </Card>
        </>
      )}

      {/* Floating bulk-action bar — appears once ≥1 line is selected. Sticks to
          the bottom of the viewport above the content, never obscuring the
          rows it acts on. PM never reaches here (no checkboxes). */}
      {!isPm && selectedCount > 0 && (
        <BulkActionBar
          count={selectedCount}
          busy={busyKey === 'bulk'}
          onAccept={handleBulkAccept}
          onToProduction={handleBulkToProduction}
          onReject={() =>
            setRejectTarget({ kind: 'bulk', lines: selectedLines })
          }
          onClear={clearSelection}
        />
      )}

      <RejectDialog
        target={rejectTarget}
        onOpenChange={(open) => {
          if (!open) setRejectTarget(null);
        }}
        onRejected={() => {
          setRejectTarget(null);
          clearSelection();
          incoming.refetch();
          onActionDone?.();
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// CheckboxField — a small accessible checkbox (no shadcn checkbox in the kit).
// Native <input type="checkbox"> styled for the dark theme, with an
// `indeterminate` prop wired through a ref for the select-all tri-state.
// ---------------------------------------------------------------------------

function CheckboxField({
  id,
  checked,
  indeterminate = false,
  disabled = false,
  onChange,
  label,
  /** When true the visible label text is hidden (kept for screen readers). */
  srOnlyLabel = false,
}: {
  id: string;
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  srOnlyLabel?: boolean;
}) {
  return (
    <label
      htmlFor={id}
      className={cn(
        'inline-flex items-center gap-2 text-sm select-none',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
      )}
    >
      <input
        id={id}
        type="checkbox"
        className="size-4 shrink-0 cursor-pointer rounded border-border bg-input text-primary accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed"
        checked={checked}
        ref={(el) => {
          if (el) el.indeterminate = indeterminate;
        }}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className={cn(srOnlyLabel && 'sr-only')}>{label}</span>
    </label>
  );
}

// ---------------------------------------------------------------------------
// BulkActionBar — sticky floating toolbar shown while ≥1 request is selected.
// ---------------------------------------------------------------------------

function BulkActionBar({
  count,
  busy,
  onAccept,
  onToProduction,
  onReject,
  onClear,
}: {
  count: number;
  busy: boolean;
  onAccept: () => void;
  onToProduction: () => void;
  onReject: () => void;
  onClear: () => void;
}) {
  return (
    <div
      className="sticky bottom-4 z-20 mx-auto w-full max-w-3xl"
      role="region"
      aria-label="Tanlangan so‘rovlar uchun amallar"
    >
      <div className="flex flex-col gap-3 rounded-xl border border-border bg-card/95 p-3 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-card/80 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          {busy && (
            <Loader2
              className="size-4 animate-spin text-primary"
              aria-hidden="true"
            />
          )}
          <span className="text-sm font-medium tabular-nums" aria-live="polite">
            {count} tanlangan
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={onClear}
            disabled={busy}
            className="text-muted-foreground"
          >
            Tozalash
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={onAccept} disabled={busy}>
            <Check className="size-4" aria-hidden="true" />
            Hammasini qabul qil
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onToProduction}
            disabled={busy}
          >
            <Factory className="size-4" aria-hidden="true" />
            Ishlab chiqarishga yuborish
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onReject}
            disabled={busy}
          >
            <X className="size-4" aria-hidden="true" />
            Rad et
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// OrderCard — one grouped store order (batch) or a single legacy line.
// ---------------------------------------------------------------------------

function OrderCard({
  group,
  isPm,
  busyKey,
  anyBusy,
  exception,
  stockReady,
  selected,
  onToggleOne,
  onToggleGroup,
  onAcceptGroup,
  onRejectGroup,
  onAcceptSingle,
  onSendToProductionSingle,
  onRejectSingle,
}: {
  group: BatchGroup<IncomingRequest>;
  isPm: boolean;
  busyKey: string | null;
  anyBusy: boolean;
  /** Exception flags when this order needs attention, else `null`. */
  exception: ExceptionFlags | null;
  /** True once the central stock query resolved (gates the short badge). */
  stockReady: boolean;
  selected: Set<number>;
  onToggleOne: (id: number, on: boolean) => void;
  onToggleGroup: (group: BatchGroup<IncomingRequest>, on: boolean) => void;
  onAcceptGroup: () => void;
  onRejectGroup: () => void;
  onAcceptSingle: (row: IncomingRequest) => void;
  onSendToProductionSingle: (row: IncomingRequest) => void;
  onRejectSingle: (row: IncomingRequest) => void;
}) {
  const storeName = group.lines[0]?.requester_location_name ?? 'Noma‘lum';
  const isGroup = group.batch_id !== null;
  const groupBusy = busyKey === `g${group.batch_id}`;

  const groupAllSelected = group.lines.every((l) => selected.has(l.id));
  const groupSomeSelected =
    !groupAllSelected && group.lines.some((l) => selected.has(l.id));

  return (
    <section
      className={cn(
        'rounded-lg border bg-card/40',
        exception ? 'border-warning/40' : 'border-border/60',
      )}
      aria-label={`${storeName} — ${group.lines.length} mahsulot`}
    >
      <header className="flex flex-col gap-3 border-b border-border/60 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          {/* Group select-all checkbox (only when the manager can act). */}
          {!isPm && (
            <span className="pt-0.5">
              <CheckboxField
                id={`grp-${group.key}`}
                checked={groupAllSelected}
                indeterminate={groupSomeSelected}
                disabled={anyBusy}
                onChange={(on) => onToggleGroup(group, on)}
                label={`${storeName} buyurtmasini tanlash`}
                srOnlyLabel
              />
            </span>
          )}
          <div className="min-w-0 space-y-0.5">
            <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold">
              {storeName}
              <Badge variant="outline" className="tabular-nums">
                {group.lines.length} mahsulot
              </Badge>
              {!isGroup && <Badge variant="secondary">Yakka so‘rov</Badge>}
              {/* Exception badges — why this order needs attention. */}
              {exception?.short && stockReady && (
                <Badge variant="warning" className="gap-1">
                  <AlertTriangle className="size-3" aria-hidden="true" />
                  Qoldiq yetmaydi
                </Badge>
              )}
              {exception?.stale && (
                <Badge variant="warning" className="gap-1">
                  <Clock className="size-3" aria-hidden="true" />
                  Uzoq kutgan
                </Badge>
              )}
            </h3>
            <p className="text-xs text-muted-foreground">
              {formatDateTime(group.created_at)}
            </p>
          </div>
        </div>

        {/* Group-level actions (batches only). pm is read-only. */}
        {isGroup && !isPm && (
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={onAcceptGroup} disabled={anyBusy}>
              {groupBusy ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Check className="size-4" aria-hidden="true" />
              )}
              Hammasini qabul qilish
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={onRejectGroup}
              disabled={anyBusy}
            >
              <X className="size-4" aria-hidden="true" />
              Hammasini rad etish
            </Button>
          </div>
        )}
      </header>

      <ul className="divide-y divide-border/40">
        {group.lines.map((line) => {
          const lineBusy = busyKey === `r${line.id}`;
          const lineProductionBusy = busyKey === `p${line.id}`;
          const lineSelected = selected.has(line.id);
          return (
            <li
              key={line.id}
              className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex min-w-0 flex-1 items-start gap-3">
                {/* Per-line checkbox (only when the manager can act). */}
                {!isPm && (
                  <span className="pt-0.5">
                    <CheckboxField
                      id={`line-${line.id}`}
                      checked={lineSelected}
                      disabled={anyBusy}
                      onChange={(on) => onToggleOne(line.id, on)}
                      label={`#${line.id} ${line.product_name} tanlash`}
                      srOnlyLabel
                    />
                  </span>
                )}
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-xs text-muted-foreground">
                    #{line.id}
                  </span>
                  <span className="font-medium">{line.product_name}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {formatQtyUnit(line.qty_needed, line.unit)}
                  </span>
                  <Badge variant={REPLENISHMENT_STATUS_VARIANT[line.status]}>
                    {REPLENISHMENT_STATUS_LABELS[line.status]}
                  </Badge>
                </div>
              </div>

              {/* Per-line actions. "Qabul qilish" / "Rad et" only for ungrouped
                  (legacy) singles — batches use the group-level buttons above.
                  "Ishlab chiqarishga yuborish" is per-request (no batch
                  endpoint), so it shows on EVERY line: the manager can route an
                  individual product to production when central stock is short. */}
              {!isPm && (
                <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                  {!isGroup && (
                    <Button
                      size="sm"
                      onClick={() => onAcceptSingle(line)}
                      disabled={anyBusy}
                    >
                      {lineBusy ? (
                        <Loader2
                          className="size-4 animate-spin"
                          aria-hidden="true"
                        />
                      ) : (
                        <Check className="size-4" aria-hidden="true" />
                      )}
                      Qabul qilish
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onSendToProductionSingle(line)}
                    disabled={anyBusy}
                  >
                    {lineProductionBusy ? (
                      <Loader2
                        className="size-4 animate-spin"
                        aria-hidden="true"
                      />
                    ) : (
                      <Factory className="size-4" aria-hidden="true" />
                    )}
                    Ishlab chiqarishga yuborish
                  </Button>
                  {!isGroup && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onRejectSingle(line)}
                      disabled={anyBusy}
                    >
                      <X className="size-4" aria-hidden="true" />
                      Rad et
                    </Button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Reject (rad etish) dialog — captures a required reason. Works for a single
// legacy line (`/:id/reject-central`), a whole batch
// (`/batch/:batch_id/reject-central`), and a BULK selection (loops the per
// -request endpoint over every selected line).
// ---------------------------------------------------------------------------

function RejectDialog({
  target,
  onOpenChange,
  onRejected,
}: {
  target:
    | { kind: 'single'; request: IncomingRequest }
    | { kind: 'group'; group: BatchGroup<IncomingRequest> }
    | { kind: 'bulk'; lines: IncomingRequest[] }
    | null;
  onOpenChange: (open: boolean) => void;
  onRejected: () => void;
}) {
  const { notify } = useToast();
  const [reason, setReason] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reject endpoints derive the acting central scope server-side from the
  // request row, so no location_id is needed here.
  const open = target !== null;

  const summary =
    target === null
      ? ''
      : target.kind === 'single'
        ? `#${target.request.id} · ${target.request.product_name} — ${target.request.requester_location_name ?? ''}`
        : target.kind === 'group'
          ? `${target.group.lines[0]?.requester_location_name ?? ''} — ${target.group.lines.length} mahsulot`
          : `${target.lines.length} ta tanlangan so‘rov`;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (target === null) return;
    const trimmed = reason.trim();
    if (trimmed === '') {
      setError('Rad etish sababini kiriting.');
      return;
    }
    setError(null);
    setIsSubmitting(true);
    try {
      if (target.kind === 'single') {
        await apiRequest(
          `/api/replenishment/${target.request.id}/reject-central`,
          { method: 'POST', body: { reason: trimmed } },
        );
        notify('success', `#${target.request.id} rad etildi.`);
      } else if (target.kind === 'group') {
        const res = await apiRequest<{ batch_id: number; cancelled: number }>(
          `/api/replenishment/batch/${target.group.batch_id}/reject-central`,
          { method: 'POST', body: { reason: trimmed } },
        );
        notify('success', `${res.cancelled} ta so‘rov rad etildi.`);
      } else {
        // BULK — loop the per-request reject over every selected line,
        // accumulate, then fire one summary toast.
        let ok = 0;
        const failed: number[] = [];
        for (const line of target.lines) {
          try {
            await apiRequest(
              `/api/replenishment/${line.id}/reject-central`,
              { method: 'POST', body: { reason: trimmed } },
            );
            ok += 1;
          } catch {
            failed.push(line.id);
          }
        }
        const msg =
          failed.length > 0
            ? `${ok} ta rad etildi, ${failed.length} tasida xato (#${failed.join(', #')}).`
            : `${ok} ta so‘rov rad etildi.`;
        notify(failed.length > 0 ? 'error' : 'success', msg);
      }
      setReason('');
      onRejected();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : 'Rad etib bo‘lmadi.');
    } finally {
      setIsSubmitting(false);
    }
  }

  const dialogTitle =
    target?.kind === 'bulk'
      ? 'Tanlangan so‘rovlarni rad etish'
      : target?.kind === 'group'
        ? 'Buyurtmani rad etish'
        : 'So‘rovni rad etish';

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setReason('');
          setError(null);
        }
        onOpenChange(o);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{dialogTitle}</DialogTitle>
          <DialogDescription>{summary}</DialogDescription>
        </DialogHeader>

        <form id="reject-form" className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <Label htmlFor="reject-reason">Sabab</Label>
            <Textarea
              id="reject-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Masalan: ombor qoldig‘i yetarli emas"
              maxLength={500}
              disabled={isSubmitting}
              required
            />
          </div>
          {error && (
            <p
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              role="alert"
            >
              {error}
            </p>
          )}
        </form>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            Bekor qilish
          </Button>
          <Button
            type="submit"
            form="reject-form"
            variant="destructive"
            disabled={isSubmitting}
          >
            {isSubmitting && (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            )}
            Rad etish
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
