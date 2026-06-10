import { useMemo, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  History,
  Layers,
  ShoppingCart,
  Warehouse,
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
import { formatDateTime, formatPlainNumber, formatQtyUnit } from '@/lib/format';
import {
  PURCHASE_ORDER_STATUS_LABELS,
  PURCHASE_ORDER_STATUS_VARIANT,
  movementCounterpartyLabel,
} from '@/lib/labels';
import {
  DateRangeFilter,
  type DateRangeValue,
} from '@/components/DateRangeFilter';
import { rangeBounds } from '@/lib/dateRange';
import { cn } from '@/lib/utils';
import type {
  MovementsResponse,
  Product,
  PurchaseOrder,
  ReplenishmentRequest,
  StockMovement,
} from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Sparkles } from 'lucide-react';
import { BoardWorkspace } from '@/pages/replenishment/board/BoardWorkspace';
import { RequestDetailModal } from '@/pages/replenishment/RequestDetailModal';
import {
  splitBoards,
  type ProductionAssignment,
} from '@/pages/replenishment/board/boardFilters';
import type { FlowRequest } from '@/lib/replenishmentFlow';
import { ManbaRejaModal } from './ManbaRejaModal';

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
 * buckets the отдел's requests verbatim. (Owner 2026-06-10: request charts
 * live on the Dashboard tab only — this view holds nothing but requests.)
 */

// F-O (owner: "nega 2 ta kanban? murakkab bo'lib ketibdi") — the legacy
// stage-list strip duplicated the board's columns 1:1 and is GONE; only the
// two non-board views survive as a compact secondary row.
type PipelineTab = 'transactions' | 'xom_ashyo';

/** A movement classified relative to the отдел (receipt / issue). */
type DeptMovement = StockMovement & {
  direction: 'in' | 'out';
  counterpartyName: string | null;
};

/**
 * A зг (yarim tayyor / semi-finished) catalogue row. `GET /api/products/yarim-tayyor`
 * returns the отдел's semi-finished products (auto-scoped server-side for a
 * production_manager) as `Product` rows enriched with the current on-hand `qty`.
 */
type SemiProduct = Product & { qty: number };

/**
 * A request belongs in the PRODUCTION отдел's So'rovlar ONLY when production is
 * / was involved in MAKING it (central pulling a shortfall from a sex) — it is
 * in a production-making state, or it already came back from production. A
 * plain central→store stock shipment (SHIP_TO_REQUESTER with no
 * `received_from_production_at`) is CENTRAL's job, never production's, so it is
 * excluded here. Owner 2026-06-08: "ishlab chiqarish do'konga emas, markaziy
 * skladga yuboradi" — the chain is Ishlab chiqarish → Markaziy sklad → Do'kon,
 * so a production отдел never ships to a store.
 */
const PRODUCTION_FLOW_STATUSES = new Set<string>([
  'CHECK_PRODUCTION_INPUT',
  'CREATE_PURCHASE_ORDER',
  'CREATE_PRODUCTION_ORDER',
  'PRODUCING',
  'DONE_TO_WAREHOUSE',
]);
function isProductionFlow(r: ReplenishmentRequest): boolean {
  return (
    r.received_from_production_at != null ||
    PRODUCTION_FLOW_STATUSES.has(r.status)
  );
}

/**
 * (The stage-list strip and its pipelineStatusLabel helper are gone — F-O:
 * the board IS the flow; only Tranzaksiyalar + Xom-ashyo survive below it.)
 */
export function ProductionRequestsTab({
  productionId,
}: {
  /** The scoped production отдел id, or `null` for the PM chain-wide view. */
  productionId: number | null;
}) {
  const { user, locations } = useAuth();
  const isPm = user?.role === 'pm';
  // Only a scoped production manager may run a Manba reja; PM is read-only.
  const canExecute = user?.role === 'production_manager';

  const [tab, setTab] = useState<PipelineTab>('xom_ashyo');
  const [dateRange, setDateRange] = useState<DateRangeValue>({ range: 'month' });
  // The incoming production request whose "Manba reja" modal is open.
  const [planTarget, setPlanTarget] = useState<FlowRequest | null>(null);
  // The card whose Jira detail modal is open.
  const [openRequest, setOpenRequest] = useState<FlowRequest | null>(null);

  // Board scope — the отдел id PLUS every location the user is assigned to (so
  // a request pinned to the отдел's sex_storage by the producer-override still
  // lands on the right board). PM (productionId null) → null = chain-wide.
  const scope = useMemo<ReadonlySet<number> | null>(() => {
    if (productionId === null) return null;
    const ids = new Set<number>([productionId]);
    for (const loc of locations) ids.add(loc.id);
    return ids;
  }, [productionId, locations]);

  // Production-assignment matcher (phase F-J §1): a production-bound row keeps
  // its target on the central warehouse, but the отдел that will MAKE it must
  // see it on "Kelgan". We merge any row whose `production_location_id` ∈ scope
  // (PINNED backend field) — with a null-safe fallback on the embedded отдел
  // NAME so #34811-shaped rows surface even before that column lands. PM
  // (productionId null) needs no matcher: a null scope already shows everything.
  const productionAssignment = useMemo<ProductionAssignment | undefined>(() => {
    if (productionId === null) return undefined;
    const ids = new Set<number>([productionId]);
    const names = new Set<string>();
    for (const loc of locations) {
      ids.add(loc.id);
      if (loc.type === 'production') names.add(loc.name.toLowerCase());
    }
    return { ids, names };
  }, [productionId, locations]);

  const allRequests = useApiQuery<ReplenishmentRequest[]>('/api/replenishment');

  // Movements touching the отдел. Scoped manager fetches their precise location;
  // PM gets the production-wide list.
  const movementsUrl =
    productionId !== null
      ? `/api/stock/movements?location_id=${productionId}&limit=100`
      : '/api/stock/movements?limit=100';
  const movements = useApiQuery<MovementsResponse>(movementsUrl);

  // зг (semi-finished) catalogue + on-hand qty — auto-scoped server-side for a
  // production_manager; PM sees every type='semi' product. Feeds the compact
  // "зг ombor qoldig'i" summary strip the owner asked for ("ishlab chiqarishga
  // so'rov kelganda зг ombori ko'rishi kerak").
  const semi = useApiQuery<SemiProduct[]>('/api/products/yarim-tayyor');

  // "Xom-ashyo so'rovlari" — the purchase orders the отдел triggered toward the
  // raw-material warehouse. The replenishment engine raises these automatically
  // when the sex_storage зг buffer is short (ADR-0015 check-first). RBAC for
  // production_manager is being added on the backend; until then this may 403,
  // which `useApiQuery` surfaces as an error → we show the empty state, never
  // crash (handled below).
  const purchaseOrders = useApiQuery<PurchaseOrder[]>('/api/purchase-orders');

  const bounds = useMemo(() => rangeBounds(dateRange), [dateRange]);
  const inRange = (iso: string) => {
    const t = new Date(iso).getTime();
    return t >= bounds.from && t <= bounds.to;
  };

  const allRows = useMemo(
    () => (allRequests.data ?? []).filter(isProductionFlow),
    [allRequests.data],
  );

  // 📥 Kelgan (target = my scope OR production-assigned to me) + 📤 Chiqgan
  // (requester = my scope) boards. The production-assignment merge dedupes by
  // id, so the Kelgan count + every kanban column count agree with the board.
  const boards = useMemo(
    () => splitBoards(allRows as FlowRequest[], scope, productionAssignment),
    [allRows, scope, productionAssignment],
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

  // зг ombor qoldig'i — distinct semi-finished types + total on-hand grouped by
  // unit (зг can be mixed-unit: kg / l / dona). Most qty are 0 right now, which
  // is expected. NOT date-bound — it reflects the live зг buffer.
  const semiRows = useMemo<SemiProduct[]>(() => semi.data ?? [], [semi.data]);
  const semiSummary = useMemo(() => {
    const totals = new Map<string, number>();
    for (const row of semiRows) {
      totals.set(row.unit, (totals.get(row.unit) ?? 0) + row.qty);
    }
    return { count: semiRows.length, totals };
  }, [semiRows]);

  // "Xom-ashyo so'rovlari" — the отдел's purchase orders, newest first. A 403/
  // error (RBAC not yet granted) is treated as "no data" so the sub-tab shows
  // its empty state instead of crashing the whole So'rovlar view.
  const poRows = useMemo<PurchaseOrder[]>(() => {
    const rows = purchaseOrders.error ? [] : purchaseOrders.data ?? [];
    return [...rows].sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
  }, [purchaseOrders.data, purchaseOrders.error]);

  const tabOptions: { value: PipelineTab; label: string }[] = [
    { value: 'xom_ashyo', label: `Xom-ashyo so‘rovlari · ${poRows.length}` },
    { value: 'transactions', label: 'Tranzaksiyalar' },
  ];

  const listLoading = allRequests.isLoading;
  const listError = allRequests.error;

  return (
    <div className="space-y-6">
      {/* Date filter. (Owner 2026-06-10: charts live on the Dashboard tab
          only; the So'rovlar view holds nothing but requests.) */}
      <div className="flex items-center justify-end">
        <DateRangeFilter value={dateRange} onChange={setDateRange} />
      </div>

      {/* зг ombor qoldig'i — compact summary strip. When a request reaches
          production the manager must see the зг buffer at a glance. */}
      <SemiSummaryCard
        loading={semi.isLoading}
        error={semi.error}
        count={semiSummary.count}
        totals={semiSummary.totals}
      />

      {/* ONE board area + a 📥 Kelgan | 📤 Chiqgan toggle (cross-department-flow
          §9.2; owner: no more stacked duplicate). 📥 Kelgan = markaz + boshqa
          sexlardan (krem!) — its card carries the "Manba reja" action; 📤 Chiqgan
          = homashyo + producer-sexlarga. */}
      {!listLoading && !listError && (
        <BoardWorkspace
          incoming={boards.incoming}
          outgoing={boards.outgoing}
          defaultSide="incoming"
          onOpen={(req) => setOpenRequest(req)}
          incomingEmptyLabel="Kelgan so‘rov yo‘q."
          outgoingEmptyLabel="Chiqgan so‘rov yo‘q."
          actionScope={scope ?? undefined}
          renderIncomingAction={(req) => (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={(e) => {
                e.stopPropagation();
                setPlanTarget(req);
              }}
            >
              <Sparkles className="size-3.5" aria-hidden="true" />
              Manba reja
            </Button>
          )}
        />
      )}

      {/* F-O: the board above IS the request flow — no second stage strip.
          Only the two non-board views remain on a compact secondary row. */}
      <div className="flex items-center justify-between gap-4">
        <Tabs
          value={tab}
          onValueChange={setTab}
          options={tabOptions}
          ariaLabel="Qo‘shimcha ro‘yxatlar"
        />
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

      {/* KUTUVDA — requests awaiting the next step. */}
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

      {/* XOM-ASHYO SO'ROVLARI — purchase orders the отдел triggered toward the
          raw-material warehouse. A 403/error (RBAC not yet granted) collapses to
          the empty state so the rest of the tab keeps working. */}
      {tab === 'xom_ashyo' && (
        <Card>
          {purchaseOrders.isLoading && <LoadingState />}
          {!purchaseOrders.isLoading && poRows.length === 0 && (
            <EmptyState message="Xom-ashyo so‘rovlari yo‘q." />
          )}
          {!purchaseOrders.isLoading && poRows.length > 0 && (
            <PurchaseOrderList rows={poRows} />
          )}
          <PipelineFootnote
            icon={<ShoppingCart className="size-3.5" aria-hidden="true" />}
          >
            Bu — зг yetmaganda xom-ashyo omboriga avtomatik chiqarilgan
            so‘rovlar (sex skladidagi zaxira kamayganda tizim o‘zi yaratadi).
          </PipelineFootnote>
        </Card>
      )}

      {/* The Jira card — opened on any board card click. Production incoming
          gets the "Manba reja" action inside the modal too. */}
      <RequestDetailModal
        open={openRequest !== null}
        onOpenChange={(next) => {
          if (!next) setOpenRequest(null);
        }}
        request={openRequest}
        onActed={() => {
          allRequests.refetch();
          movements.refetch();
        }}
        onManbaReja={(req) => setPlanTarget(req)}
      />

      {/* "Manba reja" — N-component source plan for an incoming production
          request (opened from a 📥 Kelgan card). PM gets read-and-recommend. */}
      <ManbaRejaModal
        open={planTarget !== null}
        onOpenChange={(open) => {
          if (!open) setPlanTarget(null);
        }}
        request={planTarget}
        locationId={productionId ?? planTarget?.target_location_id ?? 0}
        canExecute={canExecute}
        onDone={() => {
          allRequests.refetch();
          movements.refetch();
          semi.refetch();
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// SemiSummaryCard — the compact "зг ombor qoldig'i" strip at the top of the
// So'rovlar tab: distinct зг types + total on-hand (per unit). Production must
// see its semi-finished buffer the moment a request lands.
// ---------------------------------------------------------------------------

function SemiSummaryCard({
  loading,
  error,
  count,
  totals,
}: {
  loading: boolean;
  error: string | null;
  count: number;
  totals: Map<string, number>;
}) {
  // Render the total per unit ("0 kg · 0 l"), dropping empty buckets but always
  // keeping at least one so the strip never reads blank.
  const totalLabel = useMemo(() => {
    const parts = [...totals.entries()]
      .filter(([, qty]) => qty > 0)
      .map(([unit, qty]) => `${formatPlainNumber(qty)} ${unit}`);
    if (parts.length === 0) {
      const firstUnit = [...totals.keys()][0] ?? 'kg';
      return `0 ${firstUnit}`;
    }
    return parts.join(' · ');
  }, [totals]);

  return (
    <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"
        >
          <Warehouse className="size-5" />
        </span>
        <div className="space-y-0.5">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <Layers className="size-3.5 text-muted-foreground" aria-hidden="true" />
            зг ombor qoldig‘i
          </h3>
          <p className="text-xs text-muted-foreground">
            So‘rov kelganda bo‘limning yarim tayyor zaxirasi.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
        {loading ? (
          <span className="text-xs text-muted-foreground">Yuklanmoqda…</span>
        ) : error ? (
          <Badge variant="secondary">Ma’lumot yo‘q</Badge>
        ) : (
          <>
            <Badge variant="outline" className="gap-1 tabular-nums">
              {formatPlainNumber(count)} tur
            </Badge>
            <Badge variant="secondary" className="gap-1 tabular-nums">
              jami {totalLabel}
            </Badge>
          </>
        )}
      </div>
    </Card>
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
// PurchaseOrderList — one row per xom-ashyo purchase order: id · product ·
// qty · → target raw warehouse · status badge · date, with the supplier name
// when known. (The stage-row PipelineList it once mirrored is gone — F-O.)
// ---------------------------------------------------------------------------

function PurchaseOrderList({ rows }: { rows: PurchaseOrder[] }) {
  return (
    <ul className="divide-y divide-border/40">
      {rows.map((po) => (
        <li
          key={po.id}
          className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-xs text-muted-foreground">#{po.id}</span>
            <span className="font-medium">{po.product_name}</span>
            <span className="tabular-nums text-muted-foreground">
              {formatQtyUnit(po.qty, po.product_unit)}
            </span>
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Warehouse className="size-3" aria-hidden="true" />
              {po.target_location_name}
            </span>
            {po.supplier_name && (
              <span className="text-xs text-muted-foreground">
                {po.supplier_name}
              </span>
            )}
            <Badge variant={PURCHASE_ORDER_STATUS_VARIANT[po.status]}>
              {PURCHASE_ORDER_STATUS_LABELS[po.status]}
            </Badge>
          </div>
          <span className="whitespace-nowrap text-xs text-muted-foreground sm:text-right">
            {formatDateTime(po.created_at)}
          </span>
        </li>
      ))}
    </ul>
  );
}
