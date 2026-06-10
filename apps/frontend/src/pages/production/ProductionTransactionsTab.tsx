import { useMemo, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, History } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState, ErrorState, LoadingState } from '@/components/PageState';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useAuth } from '@/hooks/useAuth';
import { formatDateTime, formatQtyUnit } from '@/lib/format';
import { movementCounterpartyLabel } from '@/lib/labels';
import {
  DateRangeFilter,
  type DateRangeValue,
} from '@/components/DateRangeFilter';
import { rangeBounds } from '@/lib/dateRange';
import { cn } from '@/lib/utils';
import type { MovementsResponse, StockMovement } from '@/lib/types';

/**
 * Ishlab chiqarish bo'limi ish joyi — "Tranzaksiyalar" tab (phase F-Q §3).
 *
 * Extracted from `ProductionRequestsTab` (owner: "alohida tab bo'ladi"): the
 * movements history is now its OWN top-level tab so the So'rovlar tab ends at
 * the board. A read-only ledger of every stock movement touching the отдел —
 * receipt (Qabul qildi) / issue (Chiqardi) — fed by `GET /api/stock/movements`
 * (RBAC-scoped server-side: a scoped manager fetches their precise location,
 * PM gets the production-wide list). Carries its own DateRangeFilter.
 */

/** A movement classified relative to the отдел (receipt / issue). */
type DeptMovement = StockMovement & {
  direction: 'in' | 'out';
  counterpartyName: string | null;
};

export function ProductionTransactionsTab({
  productionId,
}: {
  /** The scoped production отдел id, or `null` for the PM chain-wide view. */
  productionId: number | null;
}) {
  const { user } = useAuth();
  const isPm = user?.role === 'pm';

  const [dateRange, setDateRange] = useState<DateRangeValue>({ range: 'month' });

  // Movements touching the отдел. Scoped manager fetches their precise location;
  // PM gets the production-wide list.
  const movementsUrl =
    productionId !== null
      ? `/api/stock/movements?location_id=${productionId}&limit=100`
      : '/api/stock/movements?limit=100';
  const movements = useApiQuery<MovementsResponse>(movementsUrl);

  const bounds = useMemo(() => rangeBounds(dateRange), [dateRange]);

  // TRANZAKSIYALAR — every movement touching the отдел, newest first (date-bound).
  const deptMovements = useMemo<DeptMovement[]>(() => {
    const inRange = (iso: string) => {
      const t = new Date(iso).getTime();
      return t >= bounds.from && t <= bounds.to;
    };
    const rows = movements.data?.items ?? [];
    const out: DeptMovement[] = [];
    for (const m of rows) {
      if (!inRange(m.created_at)) continue;
      const isIn =
        m.to_location_id !== null &&
        (productionId === null || m.to_location_id === productionId);
      const isOut =
        m.from_location_id !== null &&
        (productionId === null || m.from_location_id === productionId);
      if (isIn) {
        out.push({ ...m, direction: 'in', counterpartyName: m.from_location_name });
      } else if (isOut) {
        out.push({ ...m, direction: 'out', counterpartyName: m.to_location_name });
      }
    }
    return out.sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
  }, [movements.data, productionId, bounds]);

  return (
    <div className="space-y-6">
      {/* Date filter. */}
      <div className="flex items-center justify-end">
        <DateRangeFilter value={dateRange} onChange={setDateRange} />
      </div>

      <div className="flex items-center justify-between gap-4">
        <h2 className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          <History className="size-3.5" aria-hidden="true" />
          Tranzaksiyalar
        </h2>
        {isPm && (
          <Badge
            variant="secondary"
            aria-label="Faqat ko‘rish rejimi"
            className="h-9 shrink-0 items-center px-3"
          >
            Faqat ko‘rish
          </Badge>
        )}
      </div>

      {/* TRANZAKSIYALAR — every stock movement touching the отдел. */}
      <Card>
        {movements.isLoading && <LoadingState />}
        {!movements.isLoading && movements.error && (
          <ErrorState message={movements.error} onRetry={movements.refetch} />
        )}
        {!movements.isLoading &&
          !movements.error &&
          deptMovements.length === 0 && (
            <EmptyState message="Bu davrda harakat yo‘q." />
          )}
        {!movements.isLoading &&
          !movements.error &&
          deptMovements.length > 0 && (
            <div className="scrollbar-thin overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Sana</TableHead>
                    <TableHead>Mahsulot</TableHead>
                    <TableHead className="text-right">Miqdor</TableHead>
                    <TableHead className="text-right">Yaroqsiz</TableHead>
                    <TableHead>Manba / Manzil</TableHead>
                    <TableHead>Harakat</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {deptMovements.map((m) => {
                    const hasBrak = m.brak_qty != null && m.brak_qty > 0;
                    return (
                      <TableRow key={m.id}>
                        <TableCell className="whitespace-nowrap text-muted-foreground">
                          {formatDateTime(m.created_at)}
                        </TableCell>
                        <TableCell className="font-medium">
                          {m.product_name}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatQtyUnit(m.qty, m.product_unit)}
                        </TableCell>
                        <TableCell
                          className={cn(
                            'text-right tabular-nums',
                            hasBrak
                              ? 'font-medium text-destructive'
                              : 'text-muted-foreground',
                          )}
                        >
                          {hasBrak
                            ? formatQtyUnit(m.brak_qty as number, m.product_unit)
                            : '—'}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          <span className="flex items-center gap-1.5">
                            {m.direction === 'in' ? (
                              <ArrowDownLeft
                                className="size-3 shrink-0 text-muted-foreground/70"
                                aria-hidden="true"
                              />
                            ) : (
                              <ArrowUpRight
                                className="size-3 shrink-0 text-muted-foreground/70"
                                aria-hidden="true"
                              />
                            )}
                            <span className="truncate">
                              {movementCounterpartyLabel(
                                m.counterpartyName,
                                m.reason,
                              )}
                            </span>
                          </span>
                        </TableCell>
                        <TableCell>
                          {m.direction === 'in' ? (
                            <Badge variant="success" className="gap-1">
                              <ArrowDownLeft
                                className="size-3"
                                aria-hidden="true"
                              />
                              Qabul qildi
                            </Badge>
                          ) : (
                            <Badge variant="warning" className="gap-1">
                              <ArrowUpRight
                                className="size-3"
                                aria-hidden="true"
                              />
                              Chiqardi
                            </Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        <PipelineFootnote
          icon={<History className="size-3.5" aria-hidden="true" />}
        >
          Bo‘lim harakatlari (qabul qildi / chiqardi) — eng yangisi yuqorida.
        </PipelineFootnote>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PipelineFootnote — the muted explanatory strip at the bottom of the card.
// (Mirrors CentralRequestsTab's footnote; copied here so the tab is
// self-contained after the extraction.)
// ---------------------------------------------------------------------------

function PipelineFootnote({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <p className="flex items-center gap-2 border-t border-border/60 px-5 py-3 text-xs text-muted-foreground">
      {icon}
      {children}
    </p>
  );
}
