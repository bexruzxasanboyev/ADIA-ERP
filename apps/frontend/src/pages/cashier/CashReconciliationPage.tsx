import { useMemo, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
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
import { useApiQuery } from '@/hooks/useApiQuery';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/utils';
import { formatSom, formatDateTime } from '@/lib/format';
import {
  CASH_RECONCILIATION_STATUS_LABELS,
  CASH_RECONCILIATION_STATUS_OPTIONS,
  CASH_RECONCILIATION_STATUS_VARIANT,
} from '@/lib/labels';
import type {
  CashReconciliation,
  CashReconciliationsResponse,
  Location,
} from '@/lib/types';

/**
 * TZ Module 15 — «Kassa solishtiruvi» (cashier-bot reconciliation review).
 *
 * The cashier closes the day in the Telegram bot, submitting cash / card /
 * expense figures. The system reconciles those against Poster's cash-shift
 * data; this READ-ONLY web page lets a PM / store manager review the result
 * with the per-field difference highlighted.
 *
 * RBAC: PM sees the whole chain and gets a store picker; a scoped
 * `store_manager` is pinned to their own store (the backend RBAC-scopes the
 * list, so the picker is PM-only — mirrors {@link DiscrepanciesPage}).
 *
 * Backend contract (built in parallel to this exact shape):
 *   GET /api/cash-shifts/reconciliations?from=&to=&location_id=&status=
 *     → { items: CashReconciliation[] }
 *   Store picker: GET /api/locations  (filtered to type === 'store')
 */
export function CashReconciliationPage() {
  const { user } = useAuth();
  const isPm = user?.role === 'pm';

  // ---- Filters -------------------------------------------------------------
  // `from`/`to` are sent to the backend as `YYYY-MM-DD` (native date inputs).
  // Empty by default → the backend returns its default window; the user
  // narrows from there.
  const [from, setFrom] = useState<string>('');
  const [to, setTo] = useState<string>('');
  const [status, setStatus] = useState<string>('');
  const [storeId, setStoreId] = useState<string>('');

  // PM-only store picker. The backend RBAC-scopes the reconciliation list, so
  // a scoped store manager never needs (or sees) the picker.
  const locations = useApiQuery<Location[]>(isPm ? '/api/locations' : null);
  const storeOptions = useMemo(
    () => (locations.data ?? []).filter((l) => l.type === 'store'),
    [locations.data],
  );

  const listPath = useMemo(() => {
    const params = new URLSearchParams();
    if (from !== '') params.set('from', from);
    if (to !== '') params.set('to', to);
    if (storeId !== '') params.set('location_id', storeId);
    if (status !== '') params.set('status', status);
    const qs = params.toString();
    return qs === ''
      ? '/api/cash-shifts/reconciliations'
      : `/api/cash-shifts/reconciliations?${qs}`;
  }, [from, to, storeId, status]);

  const { data, isLoading, error, refetch } =
    useApiQuery<CashReconciliationsResponse>(listPath);

  const items = data?.items ?? [];

  return (
    <div className="mx-auto max-w-[120rem] space-y-6">
      <PageHeader
        title="Kassa solishtiruvi"
        description="Kassir Telegram bot orqali topshirgan kunlik hisobot (naqd / karta / rasxod) Poster ma’lumoti bilan solishtiriladi. Tafovutlar qizil bilan belgilanadi."
        actions={
          isPm && (
            <Badge
              variant="secondary"
              className="h-10 items-center px-3"
              aria-label="Butun zanjir ko‘rinishi"
            >
              Butun zanjir
            </Badge>
          )
        }
      />

      {/* FILTR QATORI (DESIGN.md §9): Do'kon (PM only) · Sana oralig'i
          (from/to) · Holat left; result count at the row's right edge. */}
      <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:flex-wrap sm:items-end">
        {isPm && (
          <div className="space-y-1.5">
            <Label htmlFor="reconciliation-store">Do‘kon</Label>
            <Select
              id="reconciliation-store"
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
          <Label htmlFor="reconciliation-from">Sanadan</Label>
          <Input
            id="reconciliation-from"
            type="date"
            className="w-full sm:w-44"
            value={from}
            max={to === '' ? undefined : to}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="reconciliation-to">Sanagacha</Label>
          <Input
            id="reconciliation-to"
            type="date"
            className="w-full sm:w-44"
            value={to}
            min={from === '' ? undefined : from}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="reconciliation-status">Holat</Label>
          <Select
            id="reconciliation-status"
            className="w-full sm:w-48"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            {CASH_RECONCILIATION_STATUS_OPTIONS.map((opt) => (
              <option key={opt.value || 'all'} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </Select>
        </div>
        {!isLoading && !error && (
          <span className="text-sm text-muted-foreground tabular-nums sm:ml-auto sm:pb-2.5">
            {items.length} ta yozuv
          </span>
        )}
      </div>

      <Card>
        {isLoading && <LoadingState />}
        {!isLoading && error && (
          <ErrorState message={error} onRetry={refetch} />
        )}
        {!isLoading && !error && items.length === 0 && (
          <EmptyState message="Solishtiruv yozuvi yo‘q." />
        )}
        {!isLoading && !error && items.length > 0 && (
          <div className="scrollbar-thin overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Sana</TableHead>
                  <TableHead>Do‘kon</TableHead>
                  <TableHead className="text-right">Naqd</TableHead>
                  <TableHead className="text-right">Karta</TableHead>
                  <TableHead className="text-right">Rasxod</TableHead>
                  <TableHead className="text-right">Seyf balansi</TableHead>
                  <TableHead>Holat</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((row) => (
                  <ReconciliationRow key={row.id} row={row} />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ReconciliationRow — one shift reconciliation. Each money column shows the
// submitted figure, the Poster figure muted below it, and the difference
// (submitted − poster). A non-zero difference is rendered in red; zero / no
// Poster data stays neutral.
// ---------------------------------------------------------------------------

function ReconciliationRow({ row }: { row: CashReconciliation }) {
  return (
    <TableRow>
      <TableCell className="whitespace-nowrap text-muted-foreground">
        {formatDateTime(row.shift_date)}
      </TableCell>
      <TableCell className="font-medium">{row.location_name}</TableCell>
      <ReconCell
        submitted={row.submitted_cash}
        poster={row.poster_cash}
        diff={row.cash_diff}
      />
      <ReconCell
        submitted={row.submitted_card}
        poster={row.poster_card}
        diff={row.card_diff}
      />
      <ReconCell
        submitted={row.submitted_expense}
        poster={row.poster_expense}
        diff={row.expense_diff}
      />
      <TableCell className="text-right tabular-nums text-muted-foreground">
        {row.poster_safe_balance === null
          ? '—'
          : formatSom(row.poster_safe_balance)}
      </TableCell>
      <TableCell>
        <Badge variant={CASH_RECONCILIATION_STATUS_VARIANT[row.status]}>
          {CASH_RECONCILIATION_STATUS_LABELS[row.status]}
        </Badge>
      </TableCell>
    </TableRow>
  );
}

/**
 * One money column: submitted figure (primary) → Poster figure (muted) →
 * difference. The Poster figure and the diff render `—` when there is no
 * Poster data; a non-zero diff is highlighted in red.
 */
function ReconCell({
  submitted,
  poster,
  diff,
}: {
  submitted: number;
  poster: number | null;
  diff: number | null;
}) {
  const hasDiff = diff !== null && diff !== 0;
  return (
    <TableCell className="text-right align-top">
      <div className="flex flex-col items-end gap-0.5 leading-tight">
        <span className="font-medium tabular-nums">{formatSom(submitted)}</span>
        <span className="text-xs tabular-nums text-muted-foreground">
          Poster: {poster === null ? '—' : formatSom(poster)}
        </span>
        <span
          className={cn(
            'text-xs tabular-nums',
            hasDiff ? 'font-medium text-destructive' : 'text-muted-foreground',
          )}
        >
          {diff === null ? '—' : `Farq: ${formatDiff(diff)}`}
        </span>
      </div>
    </TableCell>
  );
}

/** A difference with an explicit + sign for positive over-counts. */
function formatDiff(diff: number): string {
  const formatted = formatSom(Math.abs(diff));
  if (diff > 0) return `+${formatted}`;
  if (diff < 0) return `−${formatted}`;
  return formatted;
}
