import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Inbox,
  PackageCheck,
  PackageOpen,
  Truck,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ErrorState, LoadingState } from '@/components/PageState';
import { useApiQuery } from '@/hooks/useApiQuery';
import { formatQty } from '@/lib/format';
import { cn } from '@/lib/utils';
import { TERMINAL_REPLENISHMENT_STATUSES } from '@/lib/types';
import type {
  ChainLayerLocation,
  ChainLayerOverview,
  Location,
  ReplenishmentRequest,
  StockRow,
} from '@/lib/types';
import type { FlowRequest } from '@/lib/replenishmentFlow';
import { SupplySkladDrill } from './SupplySkladDrill';

/**
 * `/supply` ("Ishlab chiqarish omborlari") — the rebuilt "Qoldiq va so'rovlar"
 * tab, now BUILT ON THE FLOW MODEL (owner: "bu bizning logikamizdek
 * qurilmagan — to'g'irlab yaxshilab ber").
 *
 * Identity unchanged: a PM/admin overview of ALL production warehouses
 * (sex_storage бо'g'inlar). What changed is the wiring — the static counters
 * grid becomes a live flow surface:
 *
 *   - Summary tiles are TRUE flow numbers (cross-department-flow §9, §12):
 *       • Ishlab chiqarish omborlari — count of sex_storage бо'g'inlar.
 *       • Jo'natmaga tayyor          — forward-to-central context
 *                                      (`totals.pending_shipments`).
 *       • Kelayotgan so'rovlar       — OPEN requests whose target is any
 *                                      sex_storage (the krem cross-dept request
 *                                      to Qaymoq skladi included). This is the
 *                                      bug fix: the old tile queried
 *                                      `status=CHECK_STORE_SUPPLIER` and so read
 *                                      0 while real requests existed.
 *       • Min'dan past               — sum of below-min buffer rows.
 *   - Each бо'g'in card is CLICKABLE → drills into {@link SupplySkladDrill}: a
 *     board scoped to that sklad + a "Min'dan past" panel.
 *
 * Data is fetched ONCE here (chain-layer overview + /api/replenishment + the
 * sex_storage stock list + /api/locations) and projected onto the grid and the
 * drill-in, so every count the grid shows equals what the drill-in shows (no
 * per-card fetch storm, no N+1).
 *
 * Endpoint gap (reported, frontend works around it): the chain-layer/supply
 * payload is built over the Poster Цех storages and OMITS the app-owned
 * "Qaymoq skladi" (location 205, migration 0060) — yet that is exactly where
 * the krem cross-dept request is targeted. We recover it from /api/locations:
 * any active sex_storage that an open request targets but the chain-layer grid
 * lacks is folded in, so the krem request always has a card to drill into.
 */

/** A grid бо'g'in — the chain-layer fields plus a client-derived open-req count. */
interface SkladCard {
  id: number;
  name: string;
  total_products: number;
  below_min_count: number;
  /** Open requests TARGETING this sklad (matches the drill-in 📥 Kelgan open). */
  open_requests_count: number;
}

/** Open (non-terminal) requests only. */
function isOpen(req: ReplenishmentRequest): boolean {
  return !TERMINAL_REPLENISHMENT_STATUSES.includes(req.status);
}

export function SupplyFlowWorkspace() {
  // ----- Single data fetch (projected onto grid + drill-in) -----------------
  const overview = useApiQuery<ChainLayerOverview>(
    '/api/dashboard/chain-layer/supply',
  );
  const allRequests = useApiQuery<ReplenishmentRequest[]>('/api/replenishment');
  const sexStock = useApiQuery<StockRow[]>(
    '/api/stock?location_type=sex_storage',
  );
  // Recovers the app-owned Qaymoq skladi (205) the chain-layer grid omits.
  const allLocations = useApiQuery<Location[]>('/api/locations');

  // The drilled-in sklad, or null for the grid view.
  const [drillId, setDrillId] = useState<number | null>(null);

  const requests = useMemo<FlowRequest[]>(
    () => (allRequests.data ?? []) as FlowRequest[],
    [allRequests.data],
  );

  // Stock rows grouped by location_id (sliced per sklad for the drill-in).
  const stockByLocation = useMemo(() => {
    const map = new Map<number, StockRow[]>();
    for (const r of sexStock.data ?? []) {
      const list = map.get(r.location_id);
      if (list) list.push(r);
      else map.set(r.location_id, [r]);
    }
    return map;
  }, [sexStock.data]);

  // Open requests targeting each sex_storage location → SO'ROVLAR per card.
  const openReqByTarget = useMemo(() => {
    const map = new Map<number, number>();
    for (const r of requests) {
      if (!isOpen(r) || r.target_location_id === null) continue;
      map.set(r.target_location_id, (map.get(r.target_location_id) ?? 0) + 1);
    }
    return map;
  }, [requests]);

  // ----- Бо'g'inlar grid set ------------------------------------------------
  // Base = chain-layer sex_storage locations. Then fold in any active
  // sex_storage from /api/locations that an OPEN request targets but the grid
  // lacks (Qaymoq skladi) so the krem request has a card.
  const cards = useMemo<SkladCard[]>(() => {
    const base = overview.data?.locations ?? [];
    const seen = new Set<number>(base.map((l) => l.id));
    const list: SkladCard[] = base.map((l: ChainLayerLocation) => ({
      id: l.id,
      name: l.name,
      total_products: l.total_products,
      below_min_count: l.below_min_count,
      // Override SO'ROVLAR with the client-derived count so the card agrees with
      // the drill-in board's 📥 Kelgan (open) exactly.
      open_requests_count: openReqByTarget.get(l.id) ?? 0,
    }));

    for (const loc of allLocations.data ?? []) {
      if (loc.type !== 'sex_storage') continue;
      if (loc.is_active === false) continue;
      if (seen.has(loc.id)) continue;
      const openReq = openReqByTarget.get(loc.id) ?? 0;
      const stockRows = stockByLocation.get(loc.id) ?? [];
      // Only surface a non-chain-layer sklad when it has signal (an open request
      // or stock rows) — keeps the grid to the working set, not all 24 storages.
      if (openReq === 0 && stockRows.length === 0) continue;
      seen.add(loc.id);
      list.push({
        id: loc.id,
        name: loc.name,
        total_products: stockRows.length,
        below_min_count: belowMinCount(stockRows),
        open_requests_count: openReq,
      });
    }
    return list;
  }, [overview.data, allLocations.data, openReqByTarget, stockByLocation]);

  // ----- Tiles --------------------------------------------------------------
  const totals = overview.data?.totals;

  // Jo'natmaga tayyor — forward-to-central context. Prefer the backend's
  // computed pending_shipments; fall back to ready (qty>0) sex_storage rows.
  const readyToShip = useMemo(
    () => (sexStock.data ?? []).filter((r) => r.qty > 0).length,
    [sexStock.data],
  );
  const pendingShipments = totals?.pending_shipments ?? readyToShip;

  // Kelayotgan so'rovlar — OPEN requests whose target is ANY sex_storage in the
  // grid (the real source; replaces the broken CHECK_STORE_SUPPLIER query).
  const incomingRequestCount = useMemo(() => {
    const ids = new Set(cards.map((c) => c.id));
    let n = 0;
    for (const r of requests) {
      if (!isOpen(r) || r.target_location_id === null) continue;
      if (ids.has(r.target_location_id)) n += 1;
    }
    return n;
  }, [requests, cards]);

  // Min'dan past — sum of below-min buffer rows across the grid (agrees with the
  // sum of the cards' MIN'DAN PAST).
  const belowMinTotal = useMemo(
    () => cards.reduce((sum, c) => sum + c.below_min_count, 0),
    [cards],
  );

  // ----- Loading / error gates ----------------------------------------------
  if (overview.isLoading && overview.data === null) {
    return <LoadingState />;
  }
  if (overview.error && overview.data === null) {
    return <ErrorState message={overview.error} onRetry={overview.refetch} />;
  }
  if (overview.data === null) return null;

  // ----- Drill-in view ------------------------------------------------------
  const drillCard = drillId !== null ? cards.find((c) => c.id === drillId) : null;
  if (drillCard) {
    return (
      <SupplySkladDrill
        sklad={{ id: drillCard.id, name: drillCard.name }}
        requests={requests}
        stockRows={stockByLocation.get(drillCard.id) ?? []}
        onActed={() => {
          allRequests.refetch();
          sexStock.refetch();
          overview.refetch();
        }}
        onBack={() => setDrillId(null)}
      />
    );
  }

  // ----- Grid (overview) view -----------------------------------------------
  return (
    <div className="space-y-6">
      {/* Summary tiles — TRUE flow numbers. */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryTile
          label="Ishlab chiqarish omborlari"
          value={cards.length}
          icon={Truck}
          tone="accent"
          hint="Sex skladlari"
        />
        <SummaryTile
          label="Jo‘natmaga tayyor"
          value={pendingShipments}
          icon={PackageCheck}
          tone={pendingShipments > 0 ? 'accent' : 'neutral'}
          hint="Markaziy skladga"
        />
        <SummaryTile
          label="Kelayotgan so‘rovlar"
          value={incomingRequestCount}
          icon={Inbox}
          tone={incomingRequestCount > 0 ? 'amber' : 'neutral'}
          hint="Sex skladlariga yo‘naltirilgan"
        />
        <SummaryTile
          label="Min’dan past"
          value={belowMinTotal}
          icon={AlertTriangle}
          tone={belowMinTotal > 0 ? 'destructive' : 'neutral'}
          hint="Bufer yetishmovchiligi"
        />
      </div>

      {/* Бо'g'inlar grid — clickable cards → drill-in. */}
      <section aria-label="Ishlab chiqarish omborlari bo‘g‘inlari" className="space-y-3">
        <header className="flex items-center gap-2">
          <h2 className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            <PackageOpen className="size-3.5" aria-hidden="true" />
            Bo‘g‘inlar
            <Badge variant="secondary" className="tabular-nums">
              {cards.length}
            </Badge>
          </h2>
          {allRequests.isLoading && (
            <span className="text-xs text-muted-foreground">yangilanmoqda…</span>
          )}
        </header>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {cards.map((card) => (
            <SkladGridCard
              key={card.id}
              card={card}
              onOpen={() => setDrillId(card.id)}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SummaryTile — a KPI card (DESIGN.md §1 statistic card). Calm card; the tone
// only colours the value + icon chip.
// ---------------------------------------------------------------------------

function SummaryTile({
  label,
  value,
  icon: Icon,
  tone,
  hint,
}: {
  label: string;
  value: number;
  icon: typeof Truck;
  tone: 'neutral' | 'accent' | 'amber' | 'destructive';
  hint: string;
}) {
  const valueTone =
    tone === 'destructive'
      ? 'text-destructive'
      : tone === 'amber'
        ? 'text-warning'
        : tone === 'accent'
          ? 'text-chain-supply'
          : 'text-foreground';
  const iconWrap =
    tone === 'destructive'
      ? 'bg-destructive/15 text-destructive'
      : tone === 'amber'
        ? 'bg-warning/15 text-warning'
        : tone === 'accent'
          ? 'bg-chain-supply/15 text-chain-supply'
          : 'bg-muted text-muted-foreground';

  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {label}
          </p>
          <p
            className={cn(
              'text-2xl font-semibold tabular-nums tracking-tight leading-none',
              valueTone,
            )}
          >
            {formatQty(value)}
          </p>
          <p className="text-xs text-muted-foreground">{hint}</p>
        </div>
        <span
          aria-hidden="true"
          className={cn(
            'inline-flex size-9 shrink-0 items-center justify-center rounded-md',
            iconWrap,
          )}
        >
          <Icon className="size-4" />
        </span>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// SkladGridCard — one clickable бо'g'in card: name + MAHSULOT / MIN'DAN PAST /
// SO'ROVLAR stats. Hover-lift signals it drills in (DESIGN.md §1).
// ---------------------------------------------------------------------------

function SkladGridCard({
  card,
  onOpen,
}: {
  card: SkladCard;
  onOpen: () => void;
}) {
  const hasDanger = card.below_min_count > 0;
  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      aria-label={`${card.name} — batafsil`}
      className="flex cursor-pointer flex-col gap-3 p-4 ring-1 ring-chain-supply/30 transition-shadow hover:border-border-strong hover:shadow-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="inline-flex size-9 shrink-0 items-center justify-center rounded-md bg-chain-supply/15 text-chain-supply"
        >
          <PackageOpen className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold leading-tight">{card.name}</p>
          <p className="text-xs text-muted-foreground">Sex skladi</p>
        </div>
      </div>
      <dl className="grid grid-cols-3 gap-2 text-xs">
        <Stat label="Mahsulot" value={card.total_products} />
        <Stat
          label="Min’dan past"
          value={card.below_min_count}
          tone={hasDanger ? 'danger' : 'neutral'}
        />
        <Stat
          label="So‘rovlar"
          value={card.open_requests_count}
          tone={card.open_requests_count > 0 ? 'amber' : 'neutral'}
        />
      </dl>
    </Card>
  );
}

function Stat({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: number;
  tone?: 'neutral' | 'danger' | 'amber';
}) {
  const valueClass =
    tone === 'danger'
      ? 'text-destructive font-semibold'
      : tone === 'amber'
        ? 'text-warning font-semibold'
        : 'text-foreground';
  return (
    <div className="rounded-lg border border-border/60 bg-surface-3 p-2">
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className={cn('mt-0.5 text-base tabular-nums leading-none', valueClass)}>
        {formatQty(value)}
      </dd>
    </div>
  );
}

/** Count below-min rows in a stock slice (min>0 AND qty ≤ min). */
function belowMinCount(rows: StockRow[]): number {
  let n = 0;
  for (const r of rows) {
    if (r.min_level > 0 && r.qty <= r.min_level) n += 1;
  }
  return n;
}
