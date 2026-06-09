import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Loader2,
  ReceiptText,
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from '@/components/PageState';
import {
  DateRangeFilter,
  type DateRangeValue,
} from '@/components/DateRangeFilter';
import { useToast } from '@/components/ui/toast';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useAuth } from '@/hooks/useAuth';
import { apiRequest, ApiError } from '@/lib/api-client';
import { formatDateTime, formatPlainNumber, formatQty, todayIso } from '@/lib/format';
import { rangeBounds } from '@/lib/dateRange';
import { cn } from '@/lib/utils';
import {
  DISCREPANCY_KIND_LABELS,
  DISCREPANCY_KIND_OPTIONS,
  DISCREPANCY_KIND_VARIANT,
  DISCREPANCY_STATUS_LABELS,
  DISCREPANCY_STATUS_OPTIONS,
  DISCREPANCY_STATUS_VARIANT,
} from '@/lib/labels';
import type {
  DiscrepanciesResponse,
  DiscrepancyItem,
  DiscrepancySummary,
  Location,
} from '@/lib/types';

/**
 * TZ Module 9 — «Kassa tafovutlari» (cash/stock discrepancy report).
 *
 * The self-correcting engine flags "xato cheklar": a Poster cheque that sold
 * MORE of a product than was on hand (`wrong_keyed` → "Ortiqcha sotuv"), and
 * stock that went below zero (`negative_stock` → "Manfiy ostatka"). This
 * read-and-triage screen lists them with summary counts, lets a manager
 * acknowledge ("Tasdiqlash") or resolve ("Hal qilindi", with an optional note),
 * and filters by store / kind / status / date range.
 *
 * RBAC: PM sees the whole chain and gets a store picker; a scoped
 * `store_manager` is pinned to their own store (the backend RBAC-scopes the
 * list, so the picker is PM-only — mirrors {@link CentralInboxPage}).
 *
 * Backend contract (built in parallel to this exact shape):
 *   - List:   GET   /api/discrepancies?kind=&status=&location_id=&from=&to=&limit=&offset=
 *               → { items: DiscrepancyItem[], total, summary: DiscrepancySummary }
 *   - Update: PATCH /api/discrepancies/:id  body { status, note? } → updated item
 *   - Picker: GET   /api/locations  (filtered to type === 'store')
 */

const PAGE_SIZE = 25;

const EMPTY_SUMMARY: DiscrepancySummary = {
  open: 0,
  acknowledged: 0,
  resolved: 0,
  wrong_keyed: 0,
  negative_stock: 0,
};

export function DiscrepanciesPage() {
  const { user } = useAuth();
  const { notify } = useToast();
  const isPm = user?.role === 'pm';

  // ---- Filters -------------------------------------------------------------
  const [kind, setKind] = useState<string>('');
  const [status, setStatus] = useState<string>('');
  const [storeId, setStoreId] = useState<string>('');
  // Default to a broad 6-month window so essentially every current
  // discrepancy is visible; the user narrows from there. Date filtering is
  // sent to the backend as `from`/`to` (YYYY-MM-DD).
  const [dateRange, setDateRange] = useState<DateRangeValue>({ range: '6m' });
  // How many pages past the first are appended ("Ko'proq yuklash").
  const [extraPages, setExtraPages] = useState(0);

  // Any filter change resets pagination back to the first page so we never
  // request an offset past a freshly-narrowed result set.
  useEffect(() => {
    setExtraPages(0);
  }, [kind, status, storeId, dateRange]);

  // PM-only store picker. The backend RBAC-scopes the discrepancies list, so a
  // scoped store manager never needs (or sees) the picker.
  const locations = useApiQuery<Location[]>(isPm ? '/api/locations' : null);
  const storeOptions = useMemo(
    () => (locations.data ?? []).filter((l) => l.type === 'store'),
    [locations.data],
  );

  const { from, to } = useMemo(() => {
    const bounds = rangeBounds(dateRange);
    return {
      from: todayIso(new Date(bounds.from)),
      to: todayIso(new Date(bounds.to)),
    };
  }, [dateRange]);

  const limit = PAGE_SIZE * (extraPages + 1);
  const listPath = useMemo(() => {
    const params = new URLSearchParams();
    if (kind !== '') params.set('kind', kind);
    if (status !== '') params.set('status', status);
    if (storeId !== '') params.set('location_id', storeId);
    params.set('from', from);
    params.set('to', to);
    params.set('limit', String(limit));
    params.set('offset', '0');
    return `/api/discrepancies?${params.toString()}`;
  }, [kind, status, storeId, from, to, limit]);

  const discrepancies = useApiQuery<DiscrepanciesResponse>(listPath);

  const items = discrepancies.data?.items ?? [];
  const total = discrepancies.data?.total ?? 0;
  const summary = discrepancies.data?.summary ?? EMPTY_SUMMARY;
  const hasMore = items.length < total;

  // ---- Row actions ---------------------------------------------------------
  // A single busy key locks the row's buttons while a PATCH is in flight
  // (`a<id>` acknowledge, `r<id>` resolve-via-dialog).
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [resolveTarget, setResolveTarget] = useState<DiscrepancyItem | null>(
    null,
  );

  async function handleAcknowledge(item: DiscrepancyItem) {
    setBusyKey(`a${item.id}`);
    try {
      await apiRequest<DiscrepancyItem>(`/api/discrepancies/${item.id}`, {
        method: 'PATCH',
        body: { status: 'acknowledged' },
      });
      notify('success', `#${item.id} tasdiqlandi.`);
      discrepancies.refetch();
    } catch (err: unknown) {
      notify(
        'error',
        err instanceof ApiError ? err.message : 'Saqlab bo‘lmadi.',
      );
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="mx-auto max-w-[120rem] space-y-6">
      <PageHeader
        title="Kassa tafovutlari"
        description="Fors-major ogohlantirishlar — xato cheklar va manfiy ostatkalar. Ko‘rib chiqing, tasdiqlang yoki hal qiling."
        actions={
          isPm && (
            <Badge
              variant="secondary"
              className="h-9 items-center px-3"
              aria-label="Butun zanjir ko‘rinishi"
            >
              Butun zanjir
            </Badge>
          )
        }
      />

      {/* Summary cards — status counts (with the two kinds as a sub-line). */}
      <SummaryCards summary={summary} loading={discrepancies.isLoading} />

      {/* Filters: Do'kon (PM only) · Turi · Holat · Sana oralig'i. */}
      <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:gap-4">
        {isPm && (
          <div className="space-y-1.5">
            <Label htmlFor="discrepancy-store">Do‘kon</Label>
            <Select
              id="discrepancy-store"
              className="w-full sm:w-56"
              value={storeId}
              onChange={(e) => setStoreId(e.target.value)}
            >
              <option value="">Barcha do‘konlar</option>
              {storeOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="discrepancy-kind">Turi</Label>
          <Select
            id="discrepancy-kind"
            className="w-full sm:w-48"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            {DISCREPANCY_KIND_OPTIONS.map((opt) => (
              <option key={opt.value || 'all'} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="discrepancy-status">Holat</Label>
          <Select
            id="discrepancy-status"
            className="w-full sm:w-48"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            {DISCREPANCY_STATUS_OPTIONS.map((opt) => (
              <option key={opt.value || 'all'} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="block">Sana oralig‘i</Label>
          <DateRangeFilter value={dateRange} onChange={setDateRange} />
        </div>
      </div>

      <Card>
        {discrepancies.isLoading && <LoadingState />}
        {!discrepancies.isLoading && discrepancies.error && (
          <ErrorState
            message={discrepancies.error}
            onRetry={discrepancies.refetch}
          />
        )}
        {!discrepancies.isLoading &&
          !discrepancies.error &&
          items.length === 0 && (
            <EmptyState message="Tafovutlar topilmadi." />
          )}
        {!discrepancies.isLoading && !discrepancies.error && items.length > 0 && (
          <>
            <div className="scrollbar-thin overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Sana</TableHead>
                    <TableHead>Do‘kon</TableHead>
                    <TableHead>Mahsulot</TableHead>
                    <TableHead>Turi</TableHead>
                    <TableHead className="text-right">Sotildi</TableHead>
                    <TableHead className="text-right">Bor edi</TableHead>
                    <TableHead className="text-right">Farq</TableHead>
                    <TableHead>Chek</TableHead>
                    <TableHead>Holat</TableHead>
                    <TableHead aria-label="Amal" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((item) => (
                    <DiscrepancyRow
                      key={item.id}
                      item={item}
                      busyKey={busyKey}
                      onAcknowledge={() => handleAcknowledge(item)}
                      onResolve={() => setResolveTarget(item)}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>

            {hasMore && (
              <div className="flex items-center justify-center border-t border-border/60 p-4">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setExtraPages((n) => n + 1)}
                  disabled={discrepancies.isLoading}
                >
                  Ko‘proq yuklash
                  <span className="text-muted-foreground tabular-nums">
                    ({formatPlainNumber(items.length)} / {formatPlainNumber(total)})
                  </span>
                </Button>
              </div>
            )}
          </>
        )}
      </Card>

      <ResolveDialog
        target={resolveTarget}
        onOpenChange={(open) => {
          if (!open) setResolveTarget(null);
        }}
        onResolved={() => {
          setResolveTarget(null);
          discrepancies.refetch();
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// SummaryCards — three status tiles (Ochiq / Tasdiqlangan / Hal qilingan),
// each with a per-kind breakdown sub-line. Mirrors the dashboard KPI tile.
// ---------------------------------------------------------------------------

function SummaryCards({
  summary,
  loading,
}: {
  summary: DiscrepancySummary;
  loading: boolean;
}) {
  const tiles: {
    key: string;
    label: string;
    value: number;
    tone: string;
  }[] = [
    { key: 'open', label: 'Ochiq', value: summary.open, tone: 'text-warning' },
    {
      key: 'acknowledged',
      label: 'Tasdiqlangan',
      value: summary.acknowledged,
      tone: 'text-foreground',
    },
    {
      key: 'resolved',
      label: 'Hal qilingan',
      value: summary.resolved,
      tone: 'text-success',
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      {tiles.map((tile) => (
        <Card key={tile.key} className="p-5">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {tile.label}
          </p>
          <p
            className={cn(
              'mt-1 text-2xl font-semibold tabular-nums leading-none tracking-tight',
              tile.tone,
            )}
            aria-busy={loading}
          >
            {formatPlainNumber(tile.value)}
          </p>
          <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="warning" className="gap-1">
              {DISCREPANCY_KIND_LABELS.wrong_keyed}: {formatPlainNumber(summary.wrong_keyed)}
            </Badge>
            <Badge variant="danger" className="gap-1">
              {DISCREPANCY_KIND_LABELS.negative_stock}: {formatPlainNumber(summary.negative_stock)}
            </Badge>
          </p>
        </Card>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DiscrepancyRow — one discrepancy. Actions:
//   - "Tasdiqlash" (acknowledge)  — shown while status === 'open'
//   - "Hal qilindi" (resolve)     — shown while status !== 'resolved'
// Both pm and store_manager (the only roles routed here) may triage; the
// backend RBAC-scopes store managers to their own location.
// ---------------------------------------------------------------------------

function DiscrepancyRow({
  item,
  busyKey,
  onAcknowledge,
  onResolve,
}: {
  item: DiscrepancyItem;
  busyKey: string | null;
  onAcknowledge: () => void;
  onResolve: () => void;
}) {
  const ackBusy = busyKey === `a${item.id}`;
  const anyBusy = busyKey !== null;
  const canAcknowledge = item.status === 'open';
  const canResolve = item.status !== 'resolved';

  return (
    <TableRow>
      <TableCell className="whitespace-nowrap text-muted-foreground">
        {formatDateTime(item.detected_at)}
      </TableCell>
      <TableCell className="font-medium">{item.location_name}</TableCell>
      <TableCell className="font-medium">{item.product_name}</TableCell>
      <TableCell>
        <Badge variant={DISCREPANCY_KIND_VARIANT[item.kind]} className="gap-1">
          {item.kind === 'negative_stock' ? (
            <AlertTriangle className="size-3" aria-hidden="true" />
          ) : (
            <ReceiptText className="size-3" aria-hidden="true" />
          )}
          {DISCREPANCY_KIND_LABELS[item.kind]}
        </Badge>
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {formatQty(item.sold_qty)}
      </TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">
        {formatQty(item.had_qty)}
      </TableCell>
      <TableCell className="text-right font-medium tabular-nums text-destructive">
        {formatQty(item.shortfall)}
      </TableCell>
      <TableCell className="font-mono text-xs text-muted-foreground">
        {item.poster_transaction_id !== null
          ? `#${item.poster_transaction_id}`
          : '—'}
      </TableCell>
      <TableCell>
        <Badge variant={DISCREPANCY_STATUS_VARIANT[item.status]}>
          {DISCREPANCY_STATUS_LABELS[item.status]}
        </Badge>
      </TableCell>
      <TableCell className="text-right">
        {canAcknowledge || canResolve ? (
          <div className="flex items-center justify-end gap-2">
            {canAcknowledge && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onAcknowledge}
                disabled={anyBusy}
              >
                {ackBusy ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Check className="size-4" aria-hidden="true" />
                )}
                Tasdiqlash
              </Button>
            )}
            {canResolve && (
              <Button
                variant="outline"
                size="sm"
                onClick={onResolve}
                disabled={anyBusy}
              >
                <CheckCircle2 className="size-4" aria-hidden="true" />
                Hal qilindi
              </Button>
            )}
          </div>
        ) : (
          // Resolved rows show who closed them.
          <span className="text-xs text-muted-foreground">
            {item.status === 'resolved' && item.resolved_by_name
              ? item.resolved_by_name
              : '—'}
          </span>
        )}
      </TableCell>
    </TableRow>
  );
}

// ---------------------------------------------------------------------------
// ResolveDialog — confirms "Hal qilindi" and captures an OPTIONAL note before
// PATCH { status: 'resolved', note }.
// ---------------------------------------------------------------------------

function ResolveDialog({
  target,
  onOpenChange,
  onResolved,
}: {
  target: DiscrepancyItem | null;
  onOpenChange: (open: boolean) => void;
  onResolved: () => void;
}) {
  const { notify } = useToast();
  const [note, setNote] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = target !== null;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (target === null) return;
    setError(null);
    setIsSubmitting(true);
    try {
      const trimmed = note.trim();
      await apiRequest<DiscrepancyItem>(`/api/discrepancies/${target.id}`, {
        method: 'PATCH',
        body: {
          status: 'resolved',
          ...(trimmed === '' ? {} : { note: trimmed }),
        },
      });
      notify('success', `#${target.id} hal qilindi.`);
      setNote('');
      onResolved();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : 'Saqlab bo‘lmadi.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setNote('');
          setError(null);
        }
        onOpenChange(o);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Tafovutni hal qilish</DialogTitle>
          <DialogDescription>
            {target
              ? `#${target.id} · ${target.product_name} — ${target.location_name}`
              : ''}
          </DialogDescription>
        </DialogHeader>

        <form id="resolve-form" className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-1.5">
            <Label htmlFor="resolve-note">Izoh (ixtiyoriy)</Label>
            <Textarea
              id="resolve-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Masalan: chek tuzatildi / qoldiq inventarizatsiyada to‘g‘rilandi"
              maxLength={500}
              disabled={isSubmitting}
            />
          </div>
          {error && (
            <p
              className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
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
          <Button type="submit" form="resolve-form" disabled={isSubmitting}>
            {isSubmitting && (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            )}
            Hal qilindi
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
