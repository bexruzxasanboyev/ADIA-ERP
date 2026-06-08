import { useMemo, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Clock,
  Factory,
  History,
  PackageCheck,
  Store,
  Truck,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs } from '@/components/ui/tabs';
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
import {
  REPLENISHMENT_STATUS_LABELS,
  REPLENISHMENT_STATUS_VARIANT,
  movementCounterpartyLabel,
} from '@/lib/labels';
import { requestsInStage } from '@/lib/pipeline';
import {
  DateRangeFilter,
  type DateRangeValue,
} from '@/components/DateRangeFilter';
import { rangeBounds } from '@/lib/dateRange';
import { cn } from '@/lib/utils';
import type {
  MovementsResponse,
  ReplenishmentRequest,
  StockMovement,
} from '@/lib/types';
import { StoreRequestsStatusDonut } from '@/pages/stores/StoreRequestsStatusDonut';
import { StoreRequestsTrendChart } from '@/pages/stores/StoreRequestsTrendChart';

/**
 * Ishlab chiqarish bo'limi ish joyi — "So'rovlar" tab.
 *
 * This MIRRORS the central warehouse So'rovlar tab's LOOK (owner: "make So'rovlar
 * look like the central warehouse's — I'll give edits later"): the same charts
 * header (status donut + trend) with a date-range filter, the same 5-stage
 * PIPELINE tab row (Kutuvda / So'ralgan / Qabul qilingan / Yuborilgan /
 * Tranzaksiyalar), the same `PipelineList` row style + footnote, and the same
 * Tranzaksiyalar table.
 *
 * It is deliberately LEAN — a READ-ONLY view fed by the production отдел's own
 * `GET /api/replenishment` + `GET /api/stock/movements` (RBAC-scoped server-side
 * to the отдел). Central's write actions (Qabul qilish / ship-to-store / brak
 * receipt) and their dialogs are intentionally NOT carried over: a production
 * отдел acts on its zayafkalar from the Dashboard/board, and the owner will
 * refine the action semantics on a later edit pass. Keeping it visual-only now
 * matches central's structure without inventing production-specific flows.
 *
 * Reuse: the pipeline bucketing (`requestsInStage`, `pipelineStageOf` in
 * lib/pipeline.ts) is location-id-parameterised — NOT central-specific — so it
 * buckets the отдел's requests verbatim. The generic chart widgets
 * (`StoreRequestsStatusDonut`, `StoreRequestsTrendChart`) are the same ones the
 * store + central pages use.
 */

type PipelineTab =
  | 'kutuvda'
  | 'soralgan'
  | 'qabul_qilingan'
  | 'yuborilgan'
  | 'transactions';

/** A movement classified relative to the отдел (receipt / issue). */
type DeptMovement = StockMovement & {
  direction: 'in' | 'out';
  counterpartyName: string | null;
};

/**
 * Clean pipeline status label — collapse the production state-machine statuses
 * to one "Ishlab chiqarilmoqda" badge (mirrors central's pipelineStatusLabel),
 * keeping the standard label for every other status.
 */
function pipelineStatusLabel(req: ReplenishmentRequest): string {
  switch (req.status) {
    case 'CHECK_PRODUCTION_INPUT':
    case 'CREATE_PURCHASE_ORDER':
    case 'CREATE_PRODUCTION_ORDER':
    case 'PRODUCING':
      return 'Ishlab chiqarilmoqda';
    default:
      return REPLENISHMENT_STATUS_LABELS[req.status];
  }
}

export function ProductionRequestsTab({
  productionId,
}: {
  /** The scoped production отдел id, or `null` for the PM chain-wide view. */
  productionId: number | null;
}) {
  const { user } = useAuth();
  const isPm = user?.role === 'pm';

  const [tab, setTab] = useState<PipelineTab>('kutuvda');
  const [dateRange, setDateRange] = useState<DateRangeValue>({ range: 'month' });

  const allRequests = useApiQuery<ReplenishmentRequest[]>('/api/replenishment');

  // Movements touching the отдел. Scoped manager fetches their precise location;
  // PM gets the production-wide list.
  const movementsUrl =
    productionId !== null
      ? `/api/stock/movements?location_id=${productionId}&limit=100`
      : '/api/stock/movements?limit=100';
  const movements = useApiQuery<MovementsResponse>(movementsUrl);

  const bounds = useMemo(() => rangeBounds(dateRange), [dateRange]);
  const inRange = (iso: string) => {
    const t = new Date(iso).getTime();
    return t >= bounds.from && t <= bounds.to;
  };

  // Charts dataset — requests touching the отдел within the active range.
  const chartRequests = useMemo<ReplenishmentRequest[]>(() => {
    const rows = allRequests.data ?? [];
    return rows.filter((r) => {
      if (!inRange(r.created_at)) return false;
      if (productionId === null) return true;
      return (
        r.target_location_id === productionId ||
        r.requester_location_id === productionId
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allRequests.data, productionId, bounds]);

  const allRows = useMemo(() => allRequests.data ?? [], [allRequests.data]);

  // ----- Pipeline buckets (reused central bucketing, отдел-scoped) ----------
  const kutuvda = useMemo(
    () => requestsInStage(allRows, 'kutuvda', productionId),
    [allRows, productionId],
  );
  const soralgan = useMemo(
    () => requestsInStage(allRows, 'soralgan', productionId),
    [allRows, productionId],
  );
  const qabulQilingan = useMemo(
    () => requestsInStage(allRows, 'qabul_qilingan', productionId),
    [allRows, productionId],
  );
  const yuborilgan = useMemo(
    () => requestsInStage(allRows, 'yuborilgan', productionId),
    [allRows, productionId],
  );

  // TRANZAKSIYALAR — every movement touching the отдел, newest first (date-bound).
  const deptMovements = useMemo<DeptMovement[]>(() => {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movements.data, productionId, bounds]);

  const tabOptions: { value: PipelineTab; label: string }[] = [
    { value: 'kutuvda', label: `Kutuvda (${kutuvda.length})` },
    { value: 'soralgan', label: `So‘ralgan (${soralgan.length})` },
    { value: 'qabul_qilingan', label: `Qabul qilingan (${qabulQilingan.length})` },
    { value: 'yuborilgan', label: `Yuborilgan (${yuborilgan.length})` },
    { value: 'transactions', label: 'Tranzaksiyalar' },
  ];

  const listLoading = allRequests.isLoading;
  const listError = allRequests.error;

  return (
    <div className="space-y-6">
      {/* Charts row + date filter — donut + trend follow the date filter. */}
      <div className="flex items-center justify-end">
        <DateRangeFilter value={dateRange} onChange={setDateRange} />
      </div>
      {!listLoading && !listError && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <StoreRequestsStatusDonut requests={chartRequests} />
          <StoreRequestsTrendChart requests={chartRequests} />
        </div>
      )}

      {/* Section header + pipeline tabs. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-0.5">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Truck className="size-4 text-primary" aria-hidden="true" />
            So‘rovlar
          </h2>
          <p className="text-xs text-muted-foreground">
            Bo‘limning so‘rovlari — bitta oqim: kutuvda → so‘ralgan → qabul
            qilingan → yuborilgan.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Tabs
            value={tab}
            onValueChange={setTab}
            options={tabOptions}
            ariaLabel="So‘rovlar oqimi"
          />
          {isPm && (
            <Badge
              variant="secondary"
              aria-label="Faqat ko‘rish rejimi"
              className="h-9 items-center px-3"
            >
              Faqat ko‘rish
            </Badge>
          )}
        </div>
      </div>

      {/* KUTUVDA — requests awaiting the next step. */}
      {tab === 'kutuvda' && (
        <Card>
          {listLoading && <LoadingState />}
          {!listLoading && listError && (
            <ErrorState message={listError} onRetry={allRequests.refetch} />
          )}
          {!listLoading && !listError && kutuvda.length === 0 && (
            <EmptyState message="Kutuvda turgan so‘rov yo‘q." />
          )}
          {!listLoading && !listError && kutuvda.length > 0 && (
            <PipelineList rows={kutuvda} />
          )}
          <PipelineFootnote icon={<Clock className="size-3.5" aria-hidden="true" />}>
            Kelgan so‘rovlar — keyingi qadamni kutmoqda.
          </PipelineFootnote>
        </Card>
      )}

      {/* SO'RALGAN — being produced. */}
      {tab === 'soralgan' && (
        <Card>
          {listLoading && <LoadingState />}
          {!listLoading && listError && (
            <ErrorState message={listError} onRetry={allRequests.refetch} />
          )}
          {!listLoading && !listError && soralgan.length === 0 && (
            <EmptyState message="Ishlab chiqarishga so‘ralgan so‘rov yo‘q." />
          )}
          {!listLoading && !listError && soralgan.length > 0 && (
            <PipelineList
              rows={soralgan}
              renderMeta={(req) =>
                req.production_location_name ? (
                  <Badge variant="outline" className="gap-1">
                    <Factory className="size-3" aria-hidden="true" />
                    {req.production_location_name}
                  </Badge>
                ) : null
              }
            />
          )}
          <PipelineFootnote
            icon={<Factory className="size-3.5" aria-hidden="true" />}
          >
            Ishlab chiqarilmoqda — tayyor bo‘lgach «Qabul qilingan»ga o‘tadi.
          </PipelineFootnote>
        </Card>
      )}

      {/* QABUL QILINGAN — received from production, ready to forward. */}
      {tab === 'qabul_qilingan' && (
        <Card>
          {listLoading && <LoadingState />}
          {!listLoading && listError && (
            <ErrorState message={listError} onRetry={allRequests.refetch} />
          )}
          {!listLoading && !listError && qabulQilingan.length === 0 && (
            <EmptyState message="Yuborishga tayyor so‘rov yo‘q." />
          )}
          {!listLoading && !listError && qabulQilingan.length > 0 && (
            <PipelineList
              rows={qabulQilingan}
              renderMeta={() => (
                <Badge variant="success" className="gap-1">
                  <PackageCheck className="size-3" aria-hidden="true" />
                  Qabul qilingan
                </Badge>
              )}
            />
          )}
          <PipelineFootnote
            icon={<PackageCheck className="size-3.5" aria-hidden="true" />}
          >
            Qabul qilingan — yuborilgach «Yuborilgan»ga o‘tadi.
          </PipelineFootnote>
        </Card>
      )}

      {/* YUBORILGAN — shipped onward, awaiting acceptance. */}
      {tab === 'yuborilgan' && (
        <Card>
          {listLoading && <LoadingState />}
          {!listLoading && listError && (
            <ErrorState message={listError} onRetry={allRequests.refetch} />
          )}
          {!listLoading && !listError && yuborilgan.length === 0 && (
            <EmptyState message="Qabulni kutayotgan so‘rov yo‘q." />
          )}
          {!listLoading && !listError && yuborilgan.length > 0 && (
            <PipelineList
              rows={yuborilgan}
              renderMeta={() => (
                <Badge variant="secondary" className="gap-1">
                  <Clock className="size-3" aria-hidden="true" />
                  Qabul kutilmoqda
                </Badge>
              )}
            />
          )}
          <PipelineFootnote
            icon={<Truck className="size-3.5" aria-hidden="true" />}
          >
            Jo‘natildi — qabul qilingach so‘rov yopiladi.
          </PipelineFootnote>
        </Card>
      )}

      {/* TRANZAKSIYALAR — every stock movement touching the отдел. */}
      {tab === 'transactions' && (
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
                              ? formatQtyUnit(
                                  m.brak_qty as number,
                                  m.product_unit,
                                )
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
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PipelineFootnote — the muted explanatory strip at the bottom of each card.
// (Mirrors CentralRequestsTab's footnote.)
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

// ---------------------------------------------------------------------------
// PipelineList — a simple, aligned list of single requests for a stage.
// One clean row per request: id · product · qty · → requester · status badge,
// plus an optional per-row meta badge. (Mirrors CentralRequestsTab's
// PipelineList, action column dropped — this отдел view is read-only.)
// ---------------------------------------------------------------------------

function PipelineList({
  rows,
  renderMeta,
}: {
  rows: ReplenishmentRequest[];
  /** Optional extra badge shown next to the status. */
  renderMeta?: (req: ReplenishmentRequest) => React.ReactNode;
}) {
  return (
    <ul className="divide-y divide-border/40">
      {rows.map((req) => (
        <li
          key={req.id}
          className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-xs text-muted-foreground">#{req.id}</span>
            <span className="font-medium">{req.product_name}</span>
            <span className="tabular-nums text-muted-foreground">
              {formatQtyUnit(req.qty_needed, req.product_unit)}
            </span>
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Store className="size-3" aria-hidden="true" />
              {req.requester_location_name}
            </span>
            <Badge variant={REPLENISHMENT_STATUS_VARIANT[req.status]}>
              {pipelineStatusLabel(req)}
            </Badge>
            {renderMeta?.(req)}
          </div>
        </li>
      ))}
    </ul>
  );
}
