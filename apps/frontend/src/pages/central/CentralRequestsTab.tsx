import { useMemo, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Clock,
  Factory,
  History,
  Loader2,
  PackageCheck,
  Store,
  Truck,
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
import { EmptyState, ErrorState, LoadingState } from '@/components/PageState';
import { useToast } from '@/components/ui/toast';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useAuth } from '@/hooks/useAuth';
import { ApiError } from '@/lib/api-client';
import { shipToStore } from '@/lib/replenishmentActions';
import { formatDateTime, formatQty, formatQtyUnit } from '@/lib/format';
import {
  REPLENISHMENT_STATUS_LABELS,
  REPLENISHMENT_STATUS_VARIANT,
  movementCounterpartyLabel,
} from '@/lib/labels';
import { groupByBatch, type BatchGroup } from '@/lib/groupByBatch';
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
  ReplenishmentStatus,
  StockMovement,
  StockRow,
  Unit,
} from '@/lib/types';
import { StoreRequestsStatusDonut } from '@/pages/stores/StoreRequestsStatusDonut';
import { StoreRequestsTrendChart } from '@/pages/stores/StoreRequestsTrendChart';
import { RequestKanban } from '@/pages/replenishment/board/RequestKanban';
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
 * Markaziy sklad ish joyi — "So'rovlar" tab, restructured into a clean
 * 5-status PIPELINE (owner's corrected single-flow logic).
 *
 * The chain is ONE connected flow: every request lives in exactly ONE pipeline
 * tab, shows ONE action, and MOVES to the next tab when acted on (no stale
 * lingering buttons). The five tabs:
 *
 *   - Kutuvda        — store requests awaiting fulfilment + production
 *                      deliveries awaiting confirm-receipt.
 *       • store order      → "Qabul qilish"  (opens the partial-fulfilment modal)
 *       • production deliv. → "Qabul qildim"  (brak modal)
 *   - So'ralgan      — the shortfall is being produced. Status badge only.
 *   - Qabul qilingan — received from production, ready to forward → "Do'konga
 *                      yuborish".
 *   - Yuborilgan     — shipped to a store, awaiting the store's acceptance
 *                      (read-only).
 *   - Tranzaksiyalar — every stock movement touching the central warehouse.
 *
 * Each request is bucketed by {@link pipelineStageOf}, which prefers the
 * backend's `pipeline_stage` field and falls back to a status heuristic until
 * that field is live. EVERY action refetches `allRequests` + central stock so
 * the handled request drops out of its tab into the next one.
 *
 * Backend contracts:
 *   - GET  /api/replenishment                       (RBAC-scoped, central)
 *   - GET  /api/stock?location_id=<central>         (central on-hand → modal)
 *   - GET  /api/stock/movements?location_id=…
 *   - POST /api/replenishment/:id/fulfill           (partial fulfilment)
 *   - POST /api/replenishment/:id/receive-from-production  (brak receipt)
 *   - POST /api/replenishment/:id/ship-to-store     (forward to store)
 */

type PipelineTab =
  | 'kutuvda'
  | 'soralgan'
  | 'qabul_qilingan'
  | 'yuborilgan'
  | 'transactions';

/**
 * Clean status badge text for the central PIPELINE (owner: remove the "Sotib
 * olish so'rovi" framing — there is no standalone purchase request at central).
 * The production-pipeline statuses (`CHECK_PRODUCTION_INPUT` /
 * `CREATE_PURCHASE_ORDER` / `CREATE_PRODUCTION_ORDER` / `PRODUCING`) all mean
 * the SAME thing here — the shortfall is being produced — so they collapse to a
 * single "Ishlab chiqarilmoqda" badge instead of leaking the raw state machine
 * wording. Every other status keeps its standard label. The shared global
 * `REPLENISHMENT_STATUS_LABELS` is left untouched (the raw-warehouse purchase
 * flow still labels `CREATE_PURCHASE_ORDER` legitimately).
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

  const [tab, setTab] = useState<PipelineTab>('kutuvda');
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

  /** After ANY action: drop the row out of its tab into the next + refresh. */
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

  // ----- Pipeline buckets ---------------------------------------------------
  // Kutuvda is NOT date-bound (an in-flight request must not drop off as the
  // range narrows); the downstream stages mirror that so a request never
  // vanishes between stages. The charts above still follow the date filter.

  // KUTUVDA — split into the two kinds the manager acts on differently:
  //   • store orders awaiting fulfilment  → "Qabul qilish" (fulfilment modal)
  //   • production deliveries (DONE_TO_WAREHOUSE) → "Qabul qildim" (brak modal)
  const kutuvda = useMemo(
    () => requestsInStage(allRows, 'kutuvda', centralId),
    [allRows, centralId],
  );
  const productionDeliveries = useMemo(
    () => kutuvda.filter((r) => r.status === 'DONE_TO_WAREHOUSE'),
    [kutuvda],
  );
  // Store orders awaiting fulfilment — grouped by batch so the modal handles
  // the whole order at once. Anything that isn't a production delivery and is
  // requested by someone other than this central (a downstream store).
  const storeOrders = useMemo<ReplenishmentRequest[]>(() => {
    // Targeted store orders already visible via /api/replenishment.
    const fromAll = kutuvda.filter(
      (r) =>
        r.status !== 'DONE_TO_WAREHOUSE' &&
        (centralId === null || r.requester_location_id !== centralId),
    );
    // Plus not-yet-targeted NEW store requests from /incoming (scoped manager).
    const seen = new Set(fromAll.map((r) => r.id));
    const fromIncoming = (incoming.data?.items ?? [])
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
            pipeline_stage: 'kutuvda',
          }) as unknown as ReplenishmentRequest,
      );
    return [...fromAll, ...fromIncoming];
  }, [kutuvda, incoming.data, centralId]);
  const storeOrderGroups = useMemo(
    () => groupByBatch(storeOrders),
    [storeOrders],
  );
  const kutuvdaCount = productionDeliveries.length + storeOrderGroups.length;

  // SO'RALGAN — the shortfall is being produced (raw check / order / making).
  const soralgan = useMemo(
    () => requestsInStage(allRows, 'soralgan', centralId),
    [allRows, centralId],
  );

  // QABUL QILINGAN — received from production, ready to forward to the store.
  const qabulQilingan = useMemo(
    () => requestsInStage(allRows, 'qabul_qilingan', centralId),
    [allRows, centralId],
  );

  // YUBORILGAN — shipped to a store, awaiting the store's acceptance.
  const yuborilgan = useMemo(
    () => requestsInStage(allRows, 'yuborilgan', centralId),
    [allRows, centralId],
  );

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

  const tabOptions: { value: PipelineTab; label: string }[] = [
    { value: 'kutuvda', label: `Kutuvda (${kutuvdaCount})` },
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
            Do‘konlardan kelgan so‘rovlar — bitta oqim: kutuvda → so‘ralgan →
            qabul qilingan → yuborilgan.
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

      {/* KUTUVDA — store orders to fulfil + production deliveries to receive. */}
      {tab === 'kutuvda' && (
        <Card>
          {listLoading && <LoadingState />}
          {!listLoading && listError && (
            <ErrorState message={listError} onRetry={allRequests.refetch} />
          )}
          {!listLoading && !listError && kutuvdaCount === 0 && (
            <EmptyState message="Kutuvda turgan so‘rov yo‘q." />
          )}
          {!listLoading && !listError && kutuvdaCount > 0 && (
            <div className="space-y-4 p-5">
              {/* Production deliveries first — they unblock the rest of the
                  pipeline (received goods can then be forwarded). */}
              {productionDeliveries.map((req) => (
                <ProductionDeliveryRow
                  key={`pd-${req.id}`}
                  req={req}
                  isPm={isPm}
                  onReceive={() => setReceiveTarget(req)}
                />
              ))}
              {/* Store orders — one card per order, one "Qabul qilish" action. */}
              {storeOrderGroups.map((group) => (
                <StoreOrderCard
                  key={group.key}
                  group={group}
                  isPm={isPm}
                  availableByProduct={availableByProduct}
                  onFulfill={() => setFulfillLines(group.lines)}
                />
              ))}
            </div>
          )}
          <PipelineFootnote icon={<Clock className="size-3.5" aria-hidden="true" />}>
            «Qabul qilish» borini do‘konga jo‘natadi, yetishmaganini ishlab
            chiqarishga so‘rov qiladi. Ishlab chiqarishdan kelgan tovarni «Qabul
            qildim» bilan tasdiqlang.
          </PipelineFootnote>
        </Card>
      )}

      {/* SO'RALGAN — shortfall being produced. Status badge only. */}
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
            Markazda qoldiq yetmagani uchun ishlab chiqarishga yuborilgan
            qism — tayyor bo‘lgach «Qabul qilingan»ga o‘tadi.
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
            <EmptyState message="Do‘konga yuborishga tayyor so‘rov yo‘q." />
          )}
          {!listLoading && !listError && qabulQilingan.length > 0 && (
            <PipelineList
              rows={qabulQilingan}
              renderAction={(req) =>
                isPm ? null : (
                  <Button
                    size="sm"
                    onClick={() => handleShipToStore(req)}
                    disabled={shipBusyKey !== null}
                  >
                    {shipBusyKey === `s${req.id}` ? (
                      <Loader2
                        className="size-4 animate-spin"
                        aria-hidden="true"
                      />
                    ) : (
                      <Store className="size-4" aria-hidden="true" />
                    )}
                    Do‘konga yuborish
                  </Button>
                )
              }
            />
          )}
          <PipelineFootnote
            icon={<PackageCheck className="size-3.5" aria-hidden="true" />}
          >
            Ishlab chiqarishdan qabul qilingan — do‘konga yuborilgach
            «Yuborilgan»ga o‘tadi.
          </PipelineFootnote>
        </Card>
      )}

      {/* YUBORILGAN — shipped to a store, awaiting the store's acceptance. */}
      {tab === 'yuborilgan' && (
        <Card>
          {listLoading && <LoadingState />}
          {!listLoading && listError && (
            <ErrorState message={listError} onRetry={allRequests.refetch} />
          )}
          {!listLoading && !listError && yuborilgan.length === 0 && (
            <EmptyState message="Do‘kon qabulini kutayotgan so‘rov yo‘q." />
          )}
          {!listLoading && !listError && yuborilgan.length > 0 && (
            <PipelineList
              rows={yuborilgan}
              renderMeta={() => (
                <Badge variant="secondary" className="gap-1">
                  <Clock className="size-3" aria-hidden="true" />
                  Do‘kon qabuli kutilmoqda
                </Badge>
              )}
            />
          )}
          <PipelineFootnote
            icon={<Truck className="size-3.5" aria-hidden="true" />}
          >
            Do‘konga jo‘natildi — do‘kon qabul qilgach so‘rov yopiladi.
          </PipelineFootnote>
        </Card>
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
          <PipelineFootnote
            icon={<History className="size-3.5" aria-hidden="true" />}
          >
            Markaziy sklad harakatlari (qabul qildi / chiqardi) — eng yangisi
            yuqorida.
          </PipelineFootnote>
        </Card>
      )}

      {/* 📤 CHIQGAN — the canonical 5-column board of requests the central
          RAISED toward production (cross-department-flow §9.2). The detailed
          actionable «Kelgan» flow stays the pipeline tabs above; this board is
          the outbound mirror so a request is visible from both sides. */}
      {!listLoading && !listError && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <ArrowUpRight className="size-4 text-primary" aria-hidden="true" />
              📤 Chiqgan
            </h2>
            <Badge variant="outline" className="tabular-nums">
              {outgoing.length}
            </Badge>
            <p className="w-full text-xs text-muted-foreground sm:w-auto">
              Markaz ishlab chiqarishga yuborgan so‘rovlar — har bosqich bo‘yicha.
            </p>
          </div>
          <RequestKanban
            requests={outgoing}
            emptyLabel="Chiqgan so‘rov yo‘q."
          />
        </section>
      )}

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

// ---------------------------------------------------------------------------
// PipelineFootnote — the muted explanatory strip at the bottom of each card.
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
// One clean row per request: id · product · qty · status badge, plus an
// optional per-row meta badge and/or a single trailing action.
// ---------------------------------------------------------------------------

function PipelineList({
  rows,
  renderMeta,
  renderAction,
}: {
  rows: ReplenishmentRequest[];
  /** Optional extra badge shown next to the status (e.g. the sex name). */
  renderMeta?: (req: ReplenishmentRequest) => React.ReactNode;
  /** Optional single trailing action for the row. */
  renderAction?: (req: ReplenishmentRequest) => React.ReactNode;
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
            <span className="text-xs text-muted-foreground">
              → {req.requester_location_name}
            </span>
            <Badge variant={REPLENISHMENT_STATUS_VARIANT[req.status]}>
              {pipelineStatusLabel(req)}
            </Badge>
            {renderMeta?.(req)}
          </div>
          {renderAction && (
            <div className="flex items-center gap-2 sm:justify-end">
              {renderAction(req)}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// ProductionDeliveryRow — one DONE_TO_WAREHOUSE delivery awaiting "Qabul
// qildim" (brak receipt). PM is read-only.
// ---------------------------------------------------------------------------

function ProductionDeliveryRow({
  req,
  isPm,
  onReceive,
}: {
  req: ReplenishmentRequest;
  isPm: boolean;
  onReceive: () => void;
}) {
  return (
    <section
      className="rounded-lg border border-border/60 bg-surface-3"
      aria-label={`Ishlab chiqarishdan keldi — ${req.product_name}`}
    >
      <div className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
          <Badge variant="outline" className="gap-1">
            <Factory className="size-3" aria-hidden="true" />
            Ishlab chiqarishdan
          </Badge>
          <span className="text-xs text-muted-foreground">#{req.id}</span>
          <span className="font-medium">{req.product_name}</span>
          <span className="tabular-nums text-muted-foreground">
            {formatQtyUnit(req.qty_needed, req.product_unit)}
          </span>
          <span className="text-xs text-muted-foreground">
            → {req.requester_location_name}
          </span>
        </div>
        {!isPm && (
          <div className="flex items-center gap-2 sm:justify-end">
            <Button size="sm" onClick={onReceive}>
              <PackageCheck className="size-4" aria-hidden="true" />
              Qabul qildim
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// StoreOrderCard — one store order (batch) awaiting the manager. A single
// "Qabul qilish" opens the partial-fulfilment modal for the whole order. Each
// line shows what the store needs vs. what central holds. PM is read-only.
// ---------------------------------------------------------------------------

function StoreOrderCard({
  group,
  isPm,
  availableByProduct,
  onFulfill,
}: {
  group: BatchGroup<ReplenishmentRequest>;
  isPm: boolean;
  availableByProduct: Map<number, number>;
  onFulfill: () => void;
}) {
  const storeName = group.lines[0]?.requester_location_name ?? 'Noma‘lum';
  const isGroup = group.batch_id !== null;

  return (
    <section
      className="rounded-lg border border-border/60 bg-surface-3"
      aria-label={`${storeName} — ${group.lines.length} mahsulot`}
    >
      <header className="flex flex-col gap-3 border-b border-border/60 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-0.5">
          <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold">
            <Store className="size-4 text-primary" aria-hidden="true" />
            {storeName}
            <Badge variant="outline" className="tabular-nums">
              {group.lines.length} mahsulot
            </Badge>
            {!isGroup && <Badge variant="secondary">Yakka so‘rov</Badge>}
          </h3>
          <p className="text-xs text-muted-foreground">
            {formatDateTime(group.created_at)}
          </p>
        </div>
        {!isPm && (
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={onFulfill}>
              <PackageCheck className="size-4" aria-hidden="true" />
              Qabul qilish
            </Button>
          </div>
        )}
      </header>

      <div className="scrollbar-thin overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Mahsulot</TableHead>
              <TableHead className="text-right">So‘ralgan</TableHead>
              <TableHead className="text-right">Markaz mavjud</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {group.lines.map((line) => {
              const available = availableByProduct.get(line.product_id) ?? 0;
              const short = available < line.qty_needed;
              const unit = line.product_unit;
              return (
                <TableRow key={line.id}>
                  <TableCell className="font-medium">
                    {line.product_name}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatQty(line.qty_needed)} {unit}
                  </TableCell>
                  <TableCell
                    className={cn(
                      'text-right tabular-nums',
                      short
                        ? 'font-medium text-warning'
                        : 'text-muted-foreground',
                    )}
                  >
                    {formatQty(available)} {unit}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
