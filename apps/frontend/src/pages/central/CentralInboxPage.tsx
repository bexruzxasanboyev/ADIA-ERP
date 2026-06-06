import { useMemo, useState, type FormEvent } from 'react';
import { Check, Loader2, Warehouse, X } from 'lucide-react';
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
import { formatDateTime, formatQtyUnit } from '@/lib/format';
import { groupByBatch, type BatchGroup } from '@/lib/groupByBatch';
import {
  REPLENISHMENT_STATUS_LABELS,
  REPLENISHMENT_STATUS_VARIANT,
} from '@/lib/labels';
import { cn } from '@/lib/utils';
import type { Location, ReplenishmentStatus } from '@/lib/types';

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
 * Backend contracts:
 *   - List:        GET  /api/replenishment/incoming?location_id=<central>
 *                    → { items: IncomingRequest[] }   (each carries batch_id)
 *   - Accept 1:    POST /api/replenishment/:id/accept-central  body { location_id }
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

export function CentralInboxPage({
  embedded = false,
}: {
  /**
   * When `true` the inbox is rendered INSIDE the So'rovlar tab
   * (`CentralRequestsTab`), so it drops its own `PageHeader` and page-width
   * wrapper — the tab already supplies the section header + chrome. Standalone
   * (`embedded === false`, the routed page) keeps the full header.
   */
  embedded?: boolean;
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
  const rows = useMemo(() => incoming.data?.items ?? [], [incoming.data]);

  // Group incoming lines into orders by (requester_location_id, batch_id).
  // Batches → one card with whole-group actions; legacy null-batch rows →
  // singleton groups rendered with the single-line accept / reject UI.
  const groups = useMemo(() => groupByBatch(rows), [rows]);

  // A single busy key locks every action button while one request is in
  // flight: `g<batch_id>` for a group accept, `r<id>` for a single accept.
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [rejectTarget, setRejectTarget] = useState<
    | { kind: 'single'; request: IncomingRequest }
    | { kind: 'group'; group: BatchGroup<IncomingRequest> }
    | null
  >(null);

  async function handleAcceptSingle(row: IncomingRequest) {
    setBusyKey(`r${row.id}`);
    try {
      await apiRequest(`/api/replenishment/${row.id}/accept-central`, {
        method: 'POST',
        body: { location_id: centralIdNum },
      });
      notify('success', `#${row.id} qabul qilindi.`);
      incoming.refetch();
    } catch (err: unknown) {
      notify(
        'error',
        err instanceof ApiError ? err.message : 'Qabul qilib bo‘lmadi.',
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
    } catch (err: unknown) {
      notify(
        'error',
        err instanceof ApiError ? err.message : 'Qabul qilib bo‘lmadi.',
      );
    } finally {
      setBusyKey(null);
    }
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
        <Card>
          <header className="flex items-center gap-2 border-b border-border/60 p-5">
            <Warehouse className="size-4 text-primary" aria-hidden="true" />
            <div className="space-y-0.5">
              <h2 className="text-base font-semibold">Kiruvchi buyurtmalar</h2>
              <p className="text-xs text-muted-foreground">
                Har bir buyurtma — bitta do‘kon birga yuborgan so‘rovlar to‘plami.
              </p>
            </div>
          </header>

          {incoming.isLoading && <LoadingState />}
          {!incoming.isLoading && incoming.error && (
            <ErrorState message={incoming.error} onRetry={incoming.refetch} />
          )}
          {!incoming.isLoading && !incoming.error && groups.length === 0 && (
            <EmptyState message="Hozircha kiruvchi so‘rov yo‘q." />
          )}
          {!incoming.isLoading && !incoming.error && groups.length > 0 && (
            <div className="space-y-4 p-5">
              {groups.map((group) => (
                <OrderCard
                  key={group.key}
                  group={group}
                  isPm={isPm}
                  busyKey={busyKey}
                  onAcceptGroup={() => handleAcceptGroup(group)}
                  onRejectGroup={() =>
                    setRejectTarget({ kind: 'group', group })
                  }
                  onAcceptSingle={handleAcceptSingle}
                  onRejectSingle={(request) =>
                    setRejectTarget({ kind: 'single', request })
                  }
                />
              ))}
            </div>
          )}
        </Card>
      )}

      <RejectDialog
        target={rejectTarget}
        onOpenChange={(open) => {
          if (!open) setRejectTarget(null);
        }}
        onRejected={() => {
          setRejectTarget(null);
          incoming.refetch();
        }}
      />
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
  onAcceptGroup,
  onRejectGroup,
  onAcceptSingle,
  onRejectSingle,
}: {
  group: BatchGroup<IncomingRequest>;
  isPm: boolean;
  busyKey: string | null;
  onAcceptGroup: () => void;
  onRejectGroup: () => void;
  onAcceptSingle: (row: IncomingRequest) => void;
  onRejectSingle: (row: IncomingRequest) => void;
}) {
  const storeName = group.lines[0]?.requester_location_name ?? 'Noma‘lum';
  const isGroup = group.batch_id !== null;
  const groupBusy = busyKey === `g${group.batch_id}`;
  const anyBusy = busyKey !== null;

  return (
    <section
      className="rounded-lg border border-border/60 bg-card/40"
      aria-label={`${storeName} — ${group.lines.length} mahsulot`}
    >
      <header className="flex flex-col gap-3 border-b border-border/60 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-0.5">
          <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold">
            {storeName}
            <Badge variant="outline" className="tabular-nums">
              {group.lines.length} mahsulot
            </Badge>
            {!isGroup && (
              <Badge variant="secondary">Yakka so‘rov</Badge>
            )}
          </h3>
          <p className="text-xs text-muted-foreground">
            {formatDateTime(group.created_at)}
          </p>
        </div>

        {/* Group-level actions (batches only). pm is read-only. */}
        {isGroup && !isPm && (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={onAcceptGroup}
              disabled={anyBusy}
            >
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
          return (
            <li
              key={line.id}
              className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between"
            >
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

              {/* Per-line actions only for ungrouped (legacy) singles. */}
              {!isGroup && !isPm && (
                <div className="flex items-center gap-2 sm:justify-end">
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
                    Qabul qil
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onRejectSingle(line)}
                    disabled={anyBusy}
                  >
                    <X className="size-4" aria-hidden="true" />
                    Rad et
                  </Button>
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
// Reject (rad etish) dialog — captures a required reason. Works for both a
// single legacy line (`/:id/reject-central`) and a whole batch
// (`/batch/:batch_id/reject-central`).
// ---------------------------------------------------------------------------

function RejectDialog({
  target,
  onOpenChange,
  onRejected,
}: {
  target:
    | { kind: 'single'; request: IncomingRequest }
    | { kind: 'group'; group: BatchGroup<IncomingRequest> }
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
        : `${target.group.lines[0]?.requester_location_name ?? ''} — ${target.group.lines.length} mahsulot`;

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
      } else {
        const res = await apiRequest<{ batch_id: number; cancelled: number }>(
          `/api/replenishment/batch/${target.group.batch_id}/reject-central`,
          { method: 'POST', body: { reason: trimmed } },
        );
        notify('success', `${res.cancelled} ta so‘rov rad etildi.`);
      }
      setReason('');
      onRejected();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : 'Rad etib bo‘lmadi.');
    } finally {
      setIsSubmitting(false);
    }
  }

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
          <DialogTitle>
            {target?.kind === 'group'
              ? 'Buyurtmani rad etish'
              : 'So‘rovni rad etish'}
          </DialogTitle>
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
