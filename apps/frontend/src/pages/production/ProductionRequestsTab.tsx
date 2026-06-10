import { useMemo, useState, type ReactNode } from 'react';
import { Layers, ShoppingCart, Sparkles, Warehouse } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useAuth } from '@/hooks/useAuth';
import { formatDateTime, formatPlainNumber, formatQtyUnit } from '@/lib/format';
import {
  PURCHASE_ORDER_STATUS_LABELS,
  PURCHASE_ORDER_STATUS_VARIANT,
} from '@/lib/labels';
import type {
  Product,
  PurchaseOrder,
  ReplenishmentRequest,
} from '@/lib/types';
import { Button } from '@/components/ui/button';
import { BoardWorkspace } from '@/pages/replenishment/board/BoardWorkspace';
import { RequestDetailModal } from '@/pages/replenishment/RequestDetailModal';
import {
  splitBoards,
  type ProductionAssignment,
} from '@/pages/replenishment/board/boardFilters';
import type { FlowRequest, KanbanColumn } from '@/lib/replenishmentFlow';
import { ManbaRejaModal } from './ManbaRejaModal';

/**
 * Ishlab chiqarish bo'limi ish joyi — "So'rovlar" tab.
 *
 * The board IS the flow. A 📥 Kelgan | 📤 Chiqgan `BoardWorkspace`, fed by the
 * отдел's own `GET /api/replenishment` (RBAC-scoped server-side), with a compact
 * «зг ombor qoldig'i» summary strip on top. Clicking any card opens the shared
 * Jira detail modal (`RequestDetailModal`), where a 📥 Kelgan card also exposes
 * the «Manba reja» source-plan action. The отдел's own raw purchase orders ride
 * the SAME board (Chiqgan side) as `PoBoardCard`s.
 *
 * History note:
 *   - F-O/F-P (owner): dropped the legacy 5-stage pipeline strip + the separate
 *     Xom-ashyo tab — the board carries everything (raw POs included).
 *   - F-Q §3 (owner: "alohida tab bo'ladi"): the Tranzaksiyalar movements table
 *     moved OUT to {@link ProductionTransactionsTab}, so this tab now ENDS at
 *     the board (no movements query, no date filter here).
 */

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
  // Only a scoped production manager may run a Manba reja; PM is read-only.
  const canExecute = user?.role === 'production_manager';

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

  // F-P (owner: "homashyo so'rovini ham bitta kanbanga qo'shib yubor") — the
  // отдел's raw purchase orders ride the SAME board as Chiqgan-side cards:
  // draft («Loyiha») → Kutuvda, approved → Tasdiqlandi, received/cancelled →
  // Yopildi. The separate Xom-ashyo tab is gone.
  const poExtraCards = useMemo<Partial<Record<KanbanColumn, ReactNode[]>>>(() => {
    const columnOf = (status: PurchaseOrder['status']): KanbanColumn =>
      status === 'draft'
        ? 'kutuvda'
        : status === 'approved'
          ? 'tasdiqlandi'
          : 'yopilgan';
    const map: Partial<Record<KanbanColumn, ReactNode[]>> = {};
    for (const po of poRows) {
      (map[columnOf(po.status)] ??= []).push(
        <PoBoardCard key={`po-${po.id}`} po={po} />,
      );
    }
    return map;
  }, [poRows]);

  const listLoading = allRequests.isLoading;
  const listError = allRequests.error;

  return (
    <div className="space-y-6">
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
          outgoingExtraCards={poExtraCards}
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
// PoBoardCard (F-P) — a raw purchase order AS A BOARD CARD on the Chiqgan
// side, mirroring RequestCard's anatomy (accent rail · top row · product +
// qty chip · destination line · chips) so the отдел reads one visual
// language. The card waits on the raw warehouse, so it renders slightly
// receded, like every "boshqa tomon kutilmoqda" request card.
// ---------------------------------------------------------------------------

function PoBoardCard({ po }: { po: PurchaseOrder }) {
  return (
    <div className="relative shrink-0 overflow-hidden rounded-lg border border-border/70 bg-card py-2.5 pl-3 pr-3 opacity-75">
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-0 w-1 bg-warning"
      />
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <ShoppingCart className="size-3" aria-hidden="true" />
          Xarid #{po.id}
        </span>
        <span className="tabular-nums">{formatDateTime(po.created_at)}</span>
      </div>
      <div className="mt-1 flex items-start justify-between gap-2">
        <p className="min-w-0 truncate text-sm font-semibold leading-tight">
          {po.product_name}
        </p>
        <Badge variant="outline" className="shrink-0 tabular-nums">
          {formatQtyUnit(po.qty, po.product_unit)}
        </Badge>
      </div>
      <p className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
        <Warehouse className="size-3 shrink-0" aria-hidden="true" />
        <span className="truncate">{po.target_location_name}</span>
        {po.supplier_name && (
          <span className="truncate">· {po.supplier_name}</span>
        )}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-1">
        <Badge
          variant={PURCHASE_ORDER_STATUS_VARIANT[po.status]}
          className="text-[10px]"
        >
          {PURCHASE_ORDER_STATUS_LABELS[po.status]}
        </Badge>
        <Badge variant="secondary" className="text-[10px]">
          Xom-ashyo xaridi
        </Badge>
      </div>
    </div>
  );
}
