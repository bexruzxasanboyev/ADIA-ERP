import { useMemo, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  History,
  Loader2,
  PackageCheck,
  Store,
  Truck,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs } from '@/components/ui/tabs';
import { EmptyState, ErrorState, LoadingState } from '@/components/PageState';
import { useToast } from '@/components/ui/toast';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useAuth } from '@/hooks/useAuth';
import { ApiError } from '@/lib/api-client';
import { shipToStore } from '@/lib/replenishmentActions';
import { formatDateTime, formatQtyUnit } from '@/lib/format';
import { movementCounterpartyLabel } from '@/lib/labels';
import { groupByBatch } from '@/lib/groupByBatch';
import { pipelineStageOf } from '@/lib/pipeline';
import {
  DateRangeFilter,
  type DateRangeValue,
} from '@/components/DateRangeFilter';
import { rangeBounds } from '@/lib/dateRange';
import { cn } from '@/lib/utils';
import type {
  MovementsResponse,
  ReplenishmentRequest,
  ReplenishmentStatus,
  StockMovement,
  StockRow,
  Unit,
} from '@/lib/types';
import { StoreRequestsStatusDonut } from '@/pages/stores/StoreRequestsStatusDonut';
import { StoreRequestsTrendChart } from '@/pages/stores/StoreRequestsTrendChart';
import { RequestKanban } from '@/pages/replenishment/board/RequestKanban';
import { RequestDetailModal } from '@/pages/replenishment/RequestDetailModal';
import type { FlowRequest } from '@/lib/replenishmentFlow';
import { ProductionReceiveDialog } from './ProductionReceiveDialog';
import { FulfillmentModal } from './FulfillmentModal';

/** One item from GET /api/replenishment/incoming — a store request the central
 *  must act on. It uses `unit` (not `product_unit`) and lacks the production
 *  linkage fields, so it is mapped to a ReplenishmentRequest before display. */
interface IncomingItem {
  id: number;
  product_id: number;
  product_name: string;
  unit: Unit;
  requester_location_id: number;
  requester_location_name: string;
  qty_needed: number;
  status: ReplenishmentStatus;
  batch_id: number | null;
  created_at: string;
}

/**
 * Markaziy sklad ish joyi — "So'rovlar" tab, rebuilt on the SHARED Jira board
 * (phase F-G). The owner's "messy" five-tab pipeline is replaced by:
 *
 *   - 📥 Kelgan  — the canonical 6-column RequestKanban of every request
 *                 targeting this central (store orders + production deliveries +
 *                 in-flight + closed). A card click opens the shared
 *                 RequestDetailModal; the modal's central section exposes
 *                 "Jo'natish (qisman)" (the partial-fulfilment modal). Two
 *                 stage-specific one-click affordances stay on the card via
 *                 `renderAction`: "Qabul qildim" (receive a production delivery)
 *                 and "Do'konga yuborish" (forward received goods to the store).
 *   - 📤 Chiqgan — the requests the central RAISED toward production (unchanged).
 *
 * The summary tiles (status donut + trend) and the Tranzaksiyalar table are
 * kept. EVERY action refetches the list + central stock so a handled card moves
 * to its new column.
 *
 * Backend contracts:
 *   - GET  /api/replenishment                       (RBAC-scoped, central)
 *   - GET  /api/replenishment/incoming?location_id  (not-yet-targeted NEW)
 *   - GET  /api/stock?location_id=<central>         (central on-hand → modal)
 *   - GET  /api/stock/movements?location_id=…
 *   - POST /api/replenishment/:id/fulfill           (partial fulfilment)
 *   - POST /api/replenishment/:id/receive-from-production  (brak receipt)
 *   - POST /api/replenishment/:id/ship-to-store     (forward to store)
 */

type CentralTab = 'board' | 'transactions';

/** Doska / Tranzaksiyalar view tabs — standard compact segmented strip. */
const VIEW_TABS: { value: CentralTab; label: string }[] = [
  { value: 'board', label: 'Doska' },
  { value: 'transactions', label: 'Tranzaksiyalar' },
];

/**
 * A central-warehouse stock movement, classified relative to the warehouse as
 * a receipt ("Qabul qildi", to ∈ central) or an issue ("Chiqardi", from ∈
 * central) — mirrors the store Tranzaksiyalar table.
 */
type CentralMovement = StockMovement & {
  direction: 'in' | 'out';
  counterpartyName: string | null;
};

export function CentralRequestsTab({
  centralId,
}: {
  /** The scoped central warehouse id, or `null` for the PM chain-wide view. */
  centralId: number | null;
}) {
  const { user } = useAuth();
  const { notify } = useToast();
  const isPm = user?.role === 'pm';
  // Only the scoped central manager acts; PM is read-only across the pipeline.
  const canWrite = user?.role === 'central_warehouse_manager';

  const [tab, setTab] = useState<CentralTab>('board');
  const [dateRange, setDateRange] = useState<DateRangeValue>({ range: 'month' });
  // A single busy key locks the ship buttons while one is in flight (`s<id>`).
  const [shipBusyKey, setShipBusyKey] = useState<string | null>(null);
  // The DONE_TO_WAREHOUSE request whose brak-receive dialog is open.
  const [receiveTarget, setReceiveTarget] =
    useState<ReplenishmentRequest | null>(null);
  // The store order (batch lines) whose fulfilment modal is open.
  const [fulfillLines, setFulfillLines] = useState<ReplenishmentRequest[] | null>(
    null,
  );
  // The card whose Jira detail modal is open.
  const [openRequest, setOpenRequest] = useState<FlowRequest | null>(null);

  const allRequests = useApiQuery<ReplenishmentRequest[]>('/api/replenishment');

  // Incoming store requests (NEW / CHECK_STORE_SUPPLIER) bound for THIS central
  // are not yet in /api/replenishment for the scoped manager (RBAC: they have no
  // target until accepted). The purpose-built /incoming feed surfaces them. A PM
  // (centralId null) already sees them chain-wide via /api/replenishment.
  const incoming = useApiQuery<{ items: IncomingItem[] }>(
    centralId !== null
      ? `/api/replenishment/incoming?location_id=${centralId}`
      : null,
  );

  // Central on-hand stock — drives "Markaz mavjud" in the fulfilment modal. A
  // scoped manager fetches their precise location; PM gets the central-wide
  // list. Read-only.
  const stockUrl =
    centralId !== null
      ? `/api/stock?location_id=${centralId}`
      : '/api/stock?location_type=central_warehouse';
  const stock = useApiQuery<StockRow[]>(stockUrl);
  const availableByProduct = useMemo(() => {
    const map = new Map<number, number>();
    for (const row of stock.data ?? []) {
      map.set(row.product_id, (map.get(row.product_id) ?? 0) + row.qty);
    }
    return map;
  }, [stock.data]);

  // Movements — every stock movement touching the central warehouse.
  const movementsUrl =
    centralId !== null
      ? `/api/stock/movements?location_id=${centralId}&limit=100`
      : '/api/stock/movements?limit=100';
  const movements = useApiQuery<MovementsResponse>(movementsUrl);

  const bounds = useMemo(() => rangeBounds(dateRange), [dateRange]);
  const inRange = (iso: string) => {
    const t = new Date(iso).getTime();
    return t >= bounds.from && t <= bounds.to;
  };

  /** After ANY action: drop the row out of its column into the next + refresh. */
  function refreshAll() {
    allRequests.refetch();
    incoming.refetch();
    stock.refetch();
    movements.refetch();
  }

  // Charts dataset — requests touching the central within the active range.
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

  const allRows = useMemo(() => allRequests.data ?? [], [allRequests.data]);

  // 📤 CHIQGAN board — the requests the central RAISED toward production
  // (requester = this central). PM (centralId null) sees them chain-wide.
  const outgoing = useMemo<FlowRequest[]>(() => {
    const rows = allRows as FlowRequest[];
    if (centralId === null) return rows.filter((r) => r.route_to_production_manual);
    return rows.filter((r) => r.requester_location_id === centralId);
  }, [allRows, centralId]);

  // 📥 KELGAN board — every request TARGETING this central, across all stages,
  // PLUS the not-yet-targeted NEW store requests from /incoming (so the manager
  // sees an order before accepting). PM (centralId null) → chain-wide incoming.
  const incomingBoard = useMemo<FlowRequest[]>(() => {
    const fromAll = (allRows as FlowRequest[]).filter((r) =>
      centralId === null
        ? r.target_location_id !== null
        : r.target_location_id === centralId,
    );
    const seen = new Set(fromAll.map((r) => r.id));
    const fromIncoming: FlowRequest[] = (incoming.data?.items ?? [])
      .filter(
        (i) =>
          (i.status === 'NEW' || i.status === 'CHECK_STORE_SUPPLIER') &&
          i.requester_location_id !== centralId &&
          !seen.has(i.id),
      )
      .map(
        (i) =>
          ({
            ...i,
            product_unit: i.unit,
            target_location_id: centralId,
            requester_location_type: 'store',
            target_location_type: 'central_warehouse',
            pipeline_stage: 'kutuvda',
          }) as unknown as FlowRequest,
      );
    return [...fromAll, ...fromIncoming];
  }, [allRows, incoming.data, centralId]);

  // Store-order batch lookup — the fulfilment modal handles the WHOLE order at
  // once, so when the modal asks to fulfil a single card we resolve its batch
  // siblings from the kutuvda store orders.
  const storeOrderGroups = useMemo(() => {
    const storeOrders = incomingBoard.filter(
      (r) =>
        pipelineStageOf(r) === 'kutuvda' &&
        r.status !== 'DONE_TO_WAREHOUSE' &&
        (centralId === null || r.requester_location_id !== centralId),
    );
    return groupByBatch(storeOrders as ReplenishmentRequest[]);
  }, [incomingBoard, centralId]);

  /** Resolve the full batch group for a clicked store-order card. */
  function fulfilLinesFor(req: FlowRequest): ReplenishmentRequest[] {
    const group = storeOrderGroups.find((g) =>
      g.lines.some((l) => l.id === req.id),
    );
    return group ? group.lines : [req as ReplenishmentRequest];
  }

  // TRANZAKSIYALAR — every movement touching central, newest first (date-bound).
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

  /** Forward the received goods central → store (CLOSED). */
  async function handleShipToStore(req: ReplenishmentRequest) {
    setShipBusyKey(`s${req.id}`);
    try {
      const res = await shipToStore(req.id);
      if (res.shipped) {
        notify('success', `#${req.id} do‘konga jo‘natildi.`);
      } else {
        notify('error', res.reason || 'Do‘konga jo‘natib bo‘lmadi.');
      }
      refreshAll();
    } catch (err: unknown) {
      notify(
        'error',
        err instanceof ApiError ? err.message : 'Do‘konga jo‘natib bo‘lmadi.',
      );
    } finally {
      setShipBusyKey(null);
    }
  }

  /**
   * Per-card affordance on the 📥 Kelgan board — the two one-click central
   * actions that don't belong in the generic modal action bar:
   *   • DONE_TO_WAREHOUSE          → "Qabul qildim" (brak-receive dialog)
   *   • SHIP_TO_REQUESTER + received → "Do'konga yuborish" (forward to store)
   * The fulfil/partial action lives in the modal's central section.
   */
  function renderIncomingAction(req: FlowRequest) {
    if (isPm) return null;
    if (req.status === 'DONE_TO_WAREHOUSE') {
      return (
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={() => setReceiveTarget(req as ReplenishmentRequest)}
        >
          <PackageCheck className="size-3.5" aria-hidden="true" />
          Qabul qildim
        </Button>
      );
    }
    if (
      req.status === 'SHIP_TO_REQUESTER' &&
      req.received_from_production_at !== null
    ) {
      return (
        <Button
          size="sm"
          className="h-7 text-xs"
          disabled={shipBusyKey !== null}
          onClick={() => handleShipToStore(req as ReplenishmentRequest)}
        >
          {shipBusyKey === `s${req.id}` ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Store className="size-3.5" aria-hidden="true" />
          )}
          Do‘konga yuborish
        </Button>
      );
    }
    return null;
  }

  const listLoading = allRequests.isLoading;
  const listError = allRequests.error;

  return (
    <div className="space-y-6">
      {/* 1. Section heading row — title + description left, PM badge right
          (DESIGN.md §9: headings and tabs never share a row). */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-0.5">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Truck className="size-4 text-primary" aria-hidden="true" />
            So‘rovlar
          </h2>
          <p className="text-xs text-muted-foreground">
            Do‘konlardan kelgan so‘rovlar — bosqich ustunlari bo‘yicha; kartani
            bosib to‘liq ma’lumot va amallarni oching.
          </p>
        </div>
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

      {/* 2. Tab row — compact segmented Doska / Tranzaksiyalar, left-aligned. */}
      <Tabs
        value={tab}
        onValueChange={setTab}
        options={VIEW_TABS}
        ariaLabel="Ko‘rinish"
      />

      {/* 3. Filter row — the date range filter right-aligned via ml-auto;
          donut + trend + Tranzaksiyalar follow it. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="ml-auto">
          <DateRangeFilter value={dateRange} onChange={setDateRange} />
        </div>
      </div>

      {/* 4. Content — charts row, then the active view. */}
      {!listLoading && !listError && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <StoreRequestsStatusDonut requests={chartRequests} />
          <StoreRequestsTrendChart requests={chartRequests} />
        </div>
      )}

      {/* DOSKA — 📥 Kelgan + 📤 Chiqgan boards (cross-department-flow §9.2). */}
      {tab === 'board' && (
        <>
          {listLoading && (
            <Card>
              <LoadingState />
            </Card>
          )}
          {!listLoading && listError && (
            <Card>
              <ErrorState message={listError} onRetry={allRequests.refetch} />
            </Card>
          )}
          {!listLoading && !listError && (
            <div className="space-y-6">
              <section className="space-y-3">
                {/* Section heading — kicker + secondary count (DESIGN.md §9). */}
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    <ArrowDownLeft
                      className="size-4 text-primary"
                      aria-hidden="true"
                    />
                    📥 Kelgan
                  </h3>
                  <Badge variant="secondary" className="tabular-nums">
                    {incomingBoard.length}
                  </Badge>
                  <p className="w-full text-xs text-muted-foreground sm:w-auto">
                    Do‘konlardan kelgan so‘rovlar — qabul qilish, qisman
                    jo‘natish, ishlab chiqarishdan qabul.
                  </p>
                </div>
                <RequestKanban
                  requests={incomingBoard}
                  emptyLabel="Kelgan so‘rov yo‘q."
                  onOpen={(req) => setOpenRequest(req)}
                  renderAction={renderIncomingAction}
                />
              </section>

              <section className="space-y-3">
                {/* Section heading — kicker + secondary count (DESIGN.md §9). */}
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    <ArrowUpRight
                      className="size-4 text-primary"
                      aria-hidden="true"
                    />
                    📤 Chiqgan
                  </h3>
                  <Badge variant="secondary" className="tabular-nums">
                    {outgoing.length}
                  </Badge>
                  <p className="w-full text-xs text-muted-foreground sm:w-auto">
                    Markaz ishlab chiqarishga yuborgan so‘rovlar — har bosqich
                    bo‘yicha.
                  </p>
                </div>
                <RequestKanban
                  requests={outgoing}
                  emptyLabel="Chiqgan so‘rov yo‘q."
                  onOpen={(req) => setOpenRequest(req)}
                />
              </section>
            </div>
          )}
        </>
      )}

      {/* TRANZAKSIYALAR — every stock movement touching the central warehouse. */}
      {tab === 'transactions' && (
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
          {!movements.isLoading &&
            !movements.error &&
            centralMovements.length > 0 && (
              <p className="flex items-center gap-2 border-t border-border/60 px-5 py-3 text-xs text-muted-foreground">
                <History className="size-3.5" aria-hidden="true" />
                Markaziy sklad harakatlari (qabul qildi / chiqardi) — eng yangisi
                yuqorida.
              </p>
            )}
        </Card>
      )}

      {/* The Jira card — opened on any board card click. Its central section
          opens the partial-fulfilment modal for a store order. */}
      <RequestDetailModal
        open={openRequest !== null}
        onOpenChange={(next) => {
          if (!next) setOpenRequest(null);
        }}
        request={openRequest}
        onActed={refreshAll}
        onFulfill={(req) => setFulfillLines(fulfilLinesFor(req))}
      />

      {/* "Qabul qilish" — partial-fulfilment modal for a store order. */}
      <FulfillmentModal
        open={fulfillLines !== null && canWrite}
        onOpenChange={(open) => {
          if (!open) setFulfillLines(null);
        }}
        lines={fulfillLines ?? []}
        availableByProduct={availableByProduct}
        centralId={centralId ?? 0}
        onDone={() => {
          setFulfillLines(null);
          refreshAll();
        }}
      />

      {/* "Qabul qildim" — brak-receive for a DONE_TO_WAREHOUSE delivery. */}
      <ProductionReceiveDialog
        open={receiveTarget !== null}
        onOpenChange={(open) => {
          if (!open) setReceiveTarget(null);
        }}
        request={receiveTarget}
        onSaved={() => {
          setReceiveTarget(null);
          refreshAll();
        }}
      />
    </div>
  );
}
