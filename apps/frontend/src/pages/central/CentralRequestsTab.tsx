import { useMemo, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  History,
  Plus,
  Send,
  Sparkles,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
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
import {
  EmptyState,
  ErrorState,
  LoadingState,
} from '@/components/PageState';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useAuth } from '@/hooks/useAuth';
import { formatDateTime, formatQtyUnit } from '@/lib/format';
import {
  REPLENISHMENT_STATUS_LABELS,
  REPLENISHMENT_STATUS_VARIANT,
} from '@/lib/labels';
import { groupByBatch } from '@/lib/groupByBatch';
import {
  DateRangeFilter,
  type DateRangeValue,
} from '@/components/DateRangeFilter';
import { rangeBounds } from '@/lib/dateRange';
import { cn } from '@/lib/utils';
import type {
  MovementsResponse,
  Product,
  ReplenishmentRequest,
  StockMovement,
} from '@/lib/types';
import { StoreRequestsStatusDonut } from '@/pages/stores/StoreRequestsStatusDonut';
import { StoreRequestsTrendChart } from '@/pages/stores/StoreRequestsTrendChart';
import { StoreRequestCreateDialog } from '@/pages/stores/StoreRequestCreateDialog';
import { CentralInboxPage } from './CentralInboxPage';

/**
 * Markaziy sklad ish joyi — "So'rovlar" tab, rebuilt to mirror the store
 * So'rovlar tab (owner feedback #13 + #14):
 *
 *   - A charts row on top: SO'ROVLAR HOLATI donut + So'rovlar dinamikasi
 *     trend (the store widgets, reused) driven by the central-scoped requests
 *     and the SAME date-range filter (Bugun / Bu hafta / Bu oy / 6 oy).
 *   - Sub-tabs:
 *       • "Kiruvchi" — incoming store requests with Qabul qil / Rad et
 *         (reuses CentralInboxPage's grouped accept/reject inbox).
 *       • "Chiqgan"  — requests the central warehouse ORIGINATED (its own
 *         outbound flow): production requests (requester = own central) and
 *         ship-to-store requests (requester = a store), grouped by batch.
 *   - "So'rov qo'shish" — raises a PRODUCTION request: a batch POST with
 *     `requester_location_id = <own central id>`, which drives the
 *     CHECK_PRODUCTION_INPUT → PRODUCING chain. Reuses StoreRequestCreateDialog.
 *
 * Backend contracts (all existing):
 *   - GET  /api/replenishment                        (RBAC-scoped, central)
 *   - POST /api/replenishment/batch                  (production / ship-to-store)
 *   - incoming inbox + accept/reject — via CentralInboxPage.
 */

type RequestSubTab = 'incoming' | 'outgoing' | 'accepted' | 'transactions';

/**
 * A central-warehouse stock movement, classified relative to the warehouse as
 * a receipt ("Qabul qildi", to ∈ central) or an issue ("Chiqardi", from ∈
 * central) — mirrors the store Tranzaksiyalar table.
 */
type CentralMovement = StockMovement & {
  direction: 'in' | 'out';
  /** The counterparty location (the "Manba"/source or destination). */
  counterpartyName: string | null;
};

export function CentralRequestsTab({
  centralId,
}: {
  /** The scoped central warehouse id, or `null` for the PM chain-wide view. */
  centralId: number | null;
}) {
  const { user } = useAuth();
  const isPm = user?.role === 'pm';
  // Only the scoped central manager raises requests; PM is read-only here.
  const canWrite = user?.role === 'central_warehouse_manager';

  const [subTab, setSubTab] = useState<RequestSubTab>('incoming');
  const [dateRange, setDateRange] = useState<DateRangeValue>({ range: 'month' });
  const [createOpen, setCreateOpen] = useState(false);

  // All requests the central warehouse can see (RBAC-scoped). Feeds the charts,
  // the "Chiqgan" (outgoing) list and the "Qabul qilingan" (accepted) list.
  const allRequests = useApiQuery<ReplenishmentRequest[]>('/api/replenishment');
  const products = useApiQuery<Product[]>('/api/products');

  // Movements — every stock movement touching the central warehouse. A scoped
  // manager fetches their precise location; PM gets the wider window and
  // filters client-side. Mirrors the store Tranzaksiyalar fetch.
  const movementsUrl =
    centralId !== null
      ? `/api/stock/movements?location_id=${centralId}&limit=100`
      : '/api/stock/movements?limit=100';
  const movements = useApiQuery<MovementsResponse>(movementsUrl);

  // Finished, active products the central warehouse may raise a PRODUCTION
  // request for (the central warehouse deals in finished goods only).
  const requestableProducts = useMemo(
    () =>
      (products.data ?? []).filter((p) => p.is_active && p.type === 'finished'),
    [products.data],
  );

  const bounds = useMemo(() => rangeBounds(dateRange), [dateRange]);
  const inRange = (iso: string) => {
    const t = new Date(iso).getTime();
    return t >= bounds.from && t <= bounds.to;
  };

  // Charts dataset — requests touching the central warehouse within the active
  // range. For a scoped manager: requests targeted at OR originated by their
  // central location. PM sees every request in range.
  const chartRequests = useMemo<ReplenishmentRequest[]>(() => {
    const rows = allRequests.data ?? [];
    return rows.filter((r) => {
      if (!inRange(r.created_at)) return false;
      if (centralId === null) return true;
      return (
        r.target_location_id === centralId ||
        r.requester_location_id === centralId
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allRequests.data, centralId, bounds]);

  // "Chiqgan" — requests the central warehouse itself ORIGINATED (it is the
  // requester). That covers production requests (requester = own central) and
  // ship-to-store requests (requester = a store, but raised by this hub). For a
  // scoped manager we cannot tell store-side requests apart from hub-raised
  // ones via this list, so "Chiqgan" shows production requests (requester =
  // own central) — the unambiguous outbound the manager raised. PM sees all.
  const outgoing = useMemo<ReplenishmentRequest[]>(() => {
    const rows = allRequests.data ?? [];
    const filtered = rows.filter((r) => {
      if (!inRange(r.created_at)) return false;
      if (centralId === null) return true;
      return r.requester_location_id === centralId;
    });
    return [...filtered].sort((a, b) => b.id - a.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allRequests.data, centralId, bounds]);

  const outgoingGroups = useMemo(() => groupByBatch(outgoing), [outgoing]);

  // "Qabul qilingan" (owner #18) — downstream store requests the central
  // warehouse ACCEPTED. Accepting a store request advances it to
  // SHIP_TO_REQUESTER (then CLOSED once the store receives), so an accepted row
  // is one targeted at this central (it is the supplier) whose status is past
  // the accept step. For a scoped manager target_location_id === centralId; PM
  // sees every accepted central-targeted request. Grouped by order (batch).
  const ACCEPTED_STATUSES: ReplenishmentRequest['status'][] = [
    'SHIP_TO_REQUESTER',
    'CLOSED',
  ];
  const accepted = useMemo<ReplenishmentRequest[]>(() => {
    const rows = allRequests.data ?? [];
    const filtered = rows.filter((r) => {
      if (!inRange(r.created_at)) return false;
      if (!ACCEPTED_STATUSES.includes(r.status)) return false;
      // The central warehouse is the SUPPLIER (target) of the request, and the
      // requester is someone else (a downstream store) — not a self-raised
      // production request.
      if (centralId === null) {
        return r.requester_location_id !== r.target_location_id;
      }
      return (
        r.target_location_id === centralId &&
        r.requester_location_id !== centralId
      );
    });
    return [...filtered].sort((a, b) => b.id - a.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allRequests.data, centralId, bounds]);

  const acceptedGroups = useMemo(() => groupByBatch(accepted), [accepted]);

  // "Tranzaksiyalar" (owner #19) — every stock movement touching the central
  // warehouse, newest first. Each row is classified relative to the warehouse
  // as a receipt (to ∈ central) or an issue (from ∈ central). Mirrors the
  // store Tranzaksiyalar table.
  const centralMovements = useMemo<CentralMovement[]>(() => {
    const rows = movements.data?.items ?? [];
    const out: CentralMovement[] = [];
    for (const m of rows) {
      if (!inRange(m.created_at)) continue;
      const isIn =
        m.to_location_id !== null &&
        (centralId === null || m.to_location_id === centralId);
      const isOut =
        m.from_location_id !== null &&
        (centralId === null || m.from_location_id === centralId);
      // A scoped manager's feed is already location-scoped; for PM we keep any
      // movement with a known direction. Prefer the inbound classification when
      // both ends match (rare; an internal central-to-central transfer).
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
  }, [movements.data, centralId, bounds]);

  const subTabOptions: { value: RequestSubTab; label: string }[] = [
    { value: 'incoming', label: 'Kiruvchi' },
    { value: 'outgoing', label: `Chiqgan (${outgoing.length})` },
    { value: 'accepted', label: `Qabul qilingan (${accepted.length})` },
    { value: 'transactions', label: 'Tranzaksiyalar' },
  ];

  return (
    <div className="space-y-6">
      {/* Charts row + date filter (owner #13) — mirrors the store So'rovlar
          header. Donut + trend follow the SAME date filter as the lists. */}
      <div className="flex items-center justify-end">
        <DateRangeFilter value={dateRange} onChange={setDateRange} />
      </div>
      {!allRequests.isLoading && !allRequests.error && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <StoreRequestsStatusDonut requests={chartRequests} />
          <StoreRequestsTrendChart requests={chartRequests} />
        </div>
      )}

      {/* Section header + sub-tabs + "So'rov qo'shish" (production). */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-0.5">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Send className="size-4 text-primary" aria-hidden="true" />
            So‘rovlar
          </h2>
          <p className="text-xs text-muted-foreground">
            Do‘konlardan kelgan so‘rovlar va markaziy skladning o‘z so‘rovlari.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Tabs
            value={subTab}
            onValueChange={setSubTab}
            options={subTabOptions}
            ariaLabel="So‘rovlar ko‘rinishi"
          />
          {/* "So'rov qo'shish" = production request. central manager only. */}
          {canWrite && (
            <Button onClick={() => setCreateOpen(true)} size="sm">
              <Plus className="size-4" aria-hidden="true" />
              So‘rov qo‘shish
            </Button>
          )}
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

      {/* KIRUVCHI — reuse the grouped inbox (accept / reject), embedded. */}
      {subTab === 'incoming' && <CentralInboxPage embedded />}

      {/* CHIQGAN — production / outbound requests the central raised. */}
      {subTab === 'outgoing' && (
        <Card>
          {allRequests.isLoading && <LoadingState />}
          {!allRequests.isLoading && allRequests.error && (
            <ErrorState
              message={allRequests.error}
              onRetry={allRequests.refetch}
            />
          )}
          {!allRequests.isLoading &&
            !allRequests.error &&
            outgoingGroups.length === 0 && (
              <EmptyState message="Bu davrda chiqgan so‘rov yo‘q." />
            )}
          {!allRequests.isLoading &&
            !allRequests.error &&
            outgoingGroups.length > 0 && (
              <div className="space-y-4 p-5">
                {outgoingGroups.map((group) => {
                  const isGroup = group.batch_id !== null;
                  return (
                    <section
                      key={group.key}
                      className="rounded-lg border border-border/60 bg-card/40"
                      aria-label={`So‘rov — ${group.lines.length} mahsulot`}
                    >
                      <header className="flex flex-wrap items-center gap-2 border-b border-border/60 p-4">
                        <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                          <ArrowUpRight
                            className="size-4 text-primary"
                            aria-hidden="true"
                          />
                          {formatDateTime(group.created_at)}
                          <Badge variant="outline" className="tabular-nums">
                            {group.lines.length} mahsulot
                          </Badge>
                          {!isGroup && (
                            <Badge variant="secondary">Yakka so‘rov</Badge>
                          )}
                        </h3>
                      </header>
                      <div className="scrollbar-thin overflow-x-auto">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>#</TableHead>
                              <TableHead>Mahsulot</TableHead>
                              <TableHead className="text-right">Miqdor</TableHead>
                              <TableHead>Holat</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {group.lines.map((line) => (
                              <TableRow key={line.id}>
                                <TableCell className="text-muted-foreground">
                                  #{line.id}
                                </TableCell>
                                <TableCell className="font-medium">
                                  {line.product_name}
                                </TableCell>
                                <TableCell className="text-right tabular-nums">
                                  {formatQtyUnit(
                                    line.qty_needed,
                                    line.product_unit,
                                  )}
                                </TableCell>
                                <TableCell>
                                  <Badge
                                    variant={
                                      REPLENISHMENT_STATUS_VARIANT[line.status]
                                    }
                                  >
                                    {REPLENISHMENT_STATUS_LABELS[line.status]}
                                  </Badge>
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    </section>
                  );
                })}
              </div>
            )}
          <p className="flex items-center gap-2 border-t border-border/60 px-5 py-3 text-xs text-muted-foreground">
            <Sparkles className="size-3.5" aria-hidden="true" />
            «So‘rov qo‘shish» markaziy skladning ishlab chiqarish so‘rovini
            yuboradi — tayyor mahsulot ishlab chiqarishni qo‘zg‘atadi.
          </p>
        </Card>
      )}

      {/* QABUL QILINGAN (owner #18) — downstream store requests the central
          accepted (shipped / closed), grouped by order. Read-only history. */}
      {subTab === 'accepted' && (
        <Card>
          {allRequests.isLoading && <LoadingState />}
          {!allRequests.isLoading && allRequests.error && (
            <ErrorState
              message={allRequests.error}
              onRetry={allRequests.refetch}
            />
          )}
          {!allRequests.isLoading &&
            !allRequests.error &&
            acceptedGroups.length === 0 && (
              <EmptyState message="Bu davrda qabul qilingan so‘rov yo‘q." />
            )}
          {!allRequests.isLoading &&
            !allRequests.error &&
            acceptedGroups.length > 0 && (
              <div className="space-y-4 p-5">
                {acceptedGroups.map((group) => {
                  const isGroup = group.batch_id !== null;
                  return (
                    <section
                      key={group.key}
                      className="rounded-lg border border-border/60 bg-card/40"
                      aria-label={`Qabul qilingan so‘rov — ${group.lines.length} mahsulot`}
                    >
                      <header className="flex flex-wrap items-center gap-2 border-b border-border/60 p-4">
                        <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                          <ArrowDownLeft
                            className="size-4 text-emerald-500"
                            aria-hidden="true"
                          />
                          {formatDateTime(group.created_at)}
                          <Badge variant="outline" className="tabular-nums">
                            {group.lines.length} mahsulot
                          </Badge>
                          {!isGroup && (
                            <Badge variant="secondary">Yakka so‘rov</Badge>
                          )}
                        </h3>
                      </header>
                      <div className="scrollbar-thin overflow-x-auto">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>#</TableHead>
                              <TableHead>Mahsulot</TableHead>
                              <TableHead className="text-right">Miqdor</TableHead>
                              <TableHead>Holat</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {group.lines.map((line) => (
                              <TableRow key={line.id}>
                                <TableCell className="text-muted-foreground">
                                  #{line.id}
                                </TableCell>
                                <TableCell className="font-medium">
                                  {line.product_name}
                                </TableCell>
                                <TableCell className="text-right tabular-nums">
                                  {formatQtyUnit(
                                    line.qty_needed,
                                    line.product_unit,
                                  )}
                                </TableCell>
                                <TableCell>
                                  <Badge
                                    variant={
                                      REPLENISHMENT_STATUS_VARIANT[line.status]
                                    }
                                  >
                                    {REPLENISHMENT_STATUS_LABELS[line.status]}
                                  </Badge>
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    </section>
                  );
                })}
              </div>
            )}
          <p className="flex items-center gap-2 border-t border-border/60 px-5 py-3 text-xs text-muted-foreground">
            <ArrowDownLeft className="size-3.5" aria-hidden="true" />
            Markaziy sklad qabul qilib, do‘konlarga jo‘natgan so‘rovlar.
          </p>
        </Card>
      )}

      {/* TRANZAKSIYALAR (owner #19) — every stock movement touching the central
          warehouse (qabul qildi / chiqardi), newest first. */}
      {subTab === 'transactions' && (
        <Card>
          {movements.isLoading && <LoadingState />}
          {!movements.isLoading && movements.error && (
            <ErrorState message={movements.error} onRetry={movements.refetch} />
          )}
          {!movements.isLoading &&
            !movements.error &&
            centralMovements.length === 0 && (
              <EmptyState message="Bu davrda harakat yo‘q." />
            )}
          {!movements.isLoading &&
            !movements.error &&
            centralMovements.length > 0 && (
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
                    {centralMovements.map((m) => {
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
                            {m.counterpartyName ?? '—'}
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
          <p className="flex items-center gap-2 border-t border-border/60 px-5 py-3 text-xs text-muted-foreground">
            <History className="size-3.5" aria-hidden="true" />
            Markaziy sklad harakatlari (qabul qildi / chiqardi) — eng yangisi
            yuqorida.
          </p>
        </Card>
      )}

      {/* PRODUCTION request dialog — requester = own central id. Reuses the
          store create dialog (same batch endpoint + contract). */}
      <StoreRequestCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        products={requestableProducts}
        storeLocationId={centralId ?? 0}
        onSaved={() => {
          allRequests.refetch();
        }}
      />
    </div>
  );
}
