import { useMemo, type ComponentType } from 'react';
import {
  AlertTriangle,
  Factory,
  Inbox,
  PackageCheck,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { useApiQuery } from '@/hooks/useApiQuery';
import { formatPlainNumber } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Markaziy sklad — "boshqaruv minorasi" (control-tower) header (EPIC — owner
 * feedback). A compact, EXCEPTION-FIRST strip of four tiles shown at the very
 * top of the central workspace, above the page tabs. Inspired by Kinaxis / o9
 * supply-chain control towers: the manager sees, in one glance, the four things
 * that need a decision RIGHT NOW — new requests, what's in production, what's
 * below min, and what has arrived and is waiting to be received.
 *
 * Self-contained: every tile fetches exactly what it needs via `useApiQuery`
 * (no shared parent state, no prop drilling). Display-only — no actions; the
 * manager clicks into the relevant tab to act. Backend is unchanged.
 *
 * Data sources (frontend-only):
 *   1. Yangi so'rovlar          — GET /api/replenishment/incoming?location_id=<c>
 *                                  → { items } filtered to NEW / CHECK_STORE_SUPPLIER.
 *   2. Ishlab chiqarishda       — GET /api/replenishment (route_to_production_manual
 *                                  === true AND status in the production pipeline).
 *   3. Stok past                — GET /api/stock?location_id=<c> gated to FINISHED
 *                                  goods via GET /api/products, qty <= min_level (or <=0).
 *   4. Kechikkan / Qabul kutmoqda — GET /api/replenishment at DONE_TO_WAREHOUSE
 *                                  (goods physically at central, awaiting "Qabul qildim").
 *
 * Owner rule — "markaziy sklada faqat tayyor mahsulot bo'ladi": the stock tile
 * counts ONLY `type === 'finished'` rows, mirroring the Dashboard / Mahsulotlar
 * tabs (so the numbers agree across the workspace).
 *
 * PM (chain-wide, `centralId === null`): the stock + incoming queries widen to
 * the central-warehouse-wide variants; the request-pipeline queries are already
 * chain-wide (RBAC-scoped server-side). A scoped manager is the primary case.
 */

// ---------------------------------------------------------------------------
// Local types — by file-ownership the team lead mounts this component, so we
// keep our own minimal shapes here instead of importing from lib/types.ts.
// Mirrors the API contract (docs/specs/phase-1-mvp.md §4 / lib/types.ts).
// ---------------------------------------------------------------------------

/** Replenishment status — the subset of the state machine we branch on. */
type ReplenishmentStatus =
  | 'NEW'
  | 'CHECK_STORE_SUPPLIER'
  | 'SHIP_TO_REQUESTER'
  | 'CHECK_PRODUCTION_INPUT'
  | 'CREATE_PURCHASE_ORDER'
  | 'CREATE_PRODUCTION_ORDER'
  | 'PRODUCING'
  | 'DONE_TO_WAREHOUSE'
  | 'CLOSED'
  | 'CANCELLED';

/** One row of `GET /api/replenishment` (only the fields these tiles read). */
interface ReplenishmentRow {
  id: number;
  status: ReplenishmentStatus;
  target_location_id: number | null;
  /** Manual central→production hand-off flag; absent on legacy rows → false. */
  route_to_production_manual?: boolean;
}

/** One item of `GET /api/replenishment/incoming` → `{ items }`. */
interface IncomingRow {
  id: number;
  status: ReplenishmentStatus;
}

/** `GET /api/replenishment/incoming` envelope. */
interface IncomingResponse {
  items: IncomingRow[];
}

/** One row of `GET /api/stock` (only the fields the stock tile reads). */
interface StockRow {
  product_id: number;
  qty: number;
  min_level: number;
}

/** One row of `GET /api/products` (only the fields the stock tile reads). */
interface ProductRow {
  id: number;
  /** db product_type — central holds only `'finished'`; `string` is robust
   *  against backend types this client's union doesn't list (e.g. `resale`). */
  type: string;
}

// ---------------------------------------------------------------------------
// Tile config
// ---------------------------------------------------------------------------

/**
 * Statuses an incoming store request is still ACTIONABLE in the central inbox
 * (matches `CENTRAL_INBOX_ACTIONABLE_STATUSES` in lib/types.ts). Anything past
 * these has been handled and moved on.
 */
const INBOX_ACTIONABLE: ReadonlySet<ReplenishmentStatus> = new Set([
  'NEW',
  'CHECK_STORE_SUPPLIER',
]);

/**
 * The production pipeline — statuses a manually-routed (`route_to_production_
 * manual`) request passes through after the central manager pressed "Ishlab
 * chiqarishga yuborish". Mirrors the state machine in the cake-erp-domain skill.
 */
const IN_PRODUCTION: ReadonlySet<ReplenishmentStatus> = new Set([
  'CHECK_PRODUCTION_INPUT',
  'CREATE_PRODUCTION_ORDER',
  'CREATE_PURCHASE_ORDER',
  'PRODUCING',
  'DONE_TO_WAREHOUSE',
  'SHIP_TO_REQUESTER',
]);

type Tone = 'neutral' | 'danger';

interface TileModel {
  key: string;
  label: string;
  caption: string;
  value: number;
  Icon: ComponentType<{ className?: string }>;
  tone: Tone;
  /** Whether this tile is still loading its primary query. */
  loading: boolean;
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/** Inline skeleton for the big number while a tile's query is in flight. */
function NumberSkeleton() {
  return (
    <span
      className="inline-block h-9 w-10 animate-pulse rounded-md bg-muted sm:h-10"
      aria-hidden="true"
    />
  );
}

/**
 * A single control-tower tile. Exception tiles (`tone='danger'`) with a
 * non-zero count light up RED — both the number and a small "diqqat" badge —
 * so the manager's eye lands on what needs action. A zero count stays neutral
 * even on a danger tile (nothing to flag → no alarm).
 */
function Tile({ tile }: { tile: TileModel }) {
  const alarm = tile.tone === 'danger' && tile.value > 0;

  return (
    <Card
      className={cn(
        'flex min-w-[150px] flex-1 flex-col justify-between gap-2 p-4 transition-colors sm:p-5',
        alarm ? 'border-destructive/50 bg-destructive/5' : 'border-border/60',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {tile.label}
        </p>
        <tile.Icon
          aria-hidden="true"
          className={cn(
            'size-5 shrink-0',
            alarm ? 'text-destructive' : 'text-muted-foreground',
          )}
        />
      </div>

      <div className="flex items-end justify-between gap-2">
        <span
          className={cn(
            'text-3xl font-bold leading-none tabular-nums sm:text-4xl',
            alarm && 'text-destructive',
          )}
        >
          {tile.loading ? <NumberSkeleton /> : formatPlainNumber(tile.value)}
        </span>
        {alarm && (
          <Badge variant="danger" className="mb-0.5">
            Diqqat
          </Badge>
        )}
      </div>

      <p className="text-xs text-muted-foreground">{tile.caption}</p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Container
// ---------------------------------------------------------------------------

export function CentralSummaryTiles({
  centralId,
}: {
  /** Scoped central warehouse id, or `null` for the PM chain-wide view. */
  centralId: number | null;
}) {
  // Tile 1 — incoming store requests targeting this central warehouse. The
  // scoped endpoint needs a location_id; PM (centralId === null) falls back to
  // the full replenishment list filtered to actionable inbox statuses below.
  const incoming = useApiQuery<IncomingResponse>(
    centralId !== null
      ? `/api/replenishment/incoming?location_id=${centralId}`
      : null,
  );

  // Tiles 2 + 4 (and the PM variant of tile 1) — the full replenishment set.
  // RBAC-scoped server-side, so a scoped manager already sees only their chain.
  const requests = useApiQuery<ReplenishmentRow[]>('/api/replenishment');

  // Tile 3 — central stock, gated to finished goods via the product catalogue.
  const stock = useApiQuery<StockRow[]>(
    centralId !== null
      ? `/api/stock?location_id=${centralId}`
      : '/api/stock?location_type=central_warehouse',
  );
  const products = useApiQuery<ProductRow[]>('/api/products');

  // --- Tile 1: Yangi so'rovlar ------------------------------------------------
  const newRequestCount = useMemo(() => {
    if (centralId !== null) {
      return (incoming.data?.items ?? []).filter((r) =>
        INBOX_ACTIONABLE.has(r.status),
      ).length;
    }
    // PM chain-wide: count actionable requests targeting (or untargeted) across
    // the whole replenishment list.
    return (requests.data ?? []).filter((r) => INBOX_ACTIONABLE.has(r.status))
      .length;
  }, [centralId, incoming.data, requests.data]);

  // --- Tile 2: Ishlab chiqarishda --------------------------------------------
  const inProductionCount = useMemo(
    () =>
      (requests.data ?? []).filter(
        (r) => r.route_to_production_manual === true && IN_PRODUCTION.has(r.status),
      ).length,
    [requests.data],
  );

  // --- Tile 3: Stok past (finished only) -------------------------------------
  const finishedIds = useMemo(() => {
    const s = new Set<number>();
    for (const p of products.data ?? []) {
      if (p.type === 'finished') s.add(p.id);
    }
    return s;
  }, [products.data]);

  const lowStockCount = useMemo(
    () =>
      (stock.data ?? []).filter(
        (r) =>
          finishedIds.has(r.product_id) &&
          (r.qty <= r.min_level || r.qty <= 0),
      ).length,
    [stock.data, finishedIds],
  );

  // --- Tile 4: Kechikkan / Qabul kutmoqda ------------------------------------
  const awaitingReceiveCount = useMemo(
    () =>
      (requests.data ?? []).filter((r) => r.status === 'DONE_TO_WAREHOUSE')
        .length,
    [requests.data],
  );

  // Tile 1 loads from `incoming` (scoped) or `requests` (PM); the rest as noted.
  // Each tile shows its own skeleton until its primary query first resolves.
  const incomingLoading =
    centralId !== null
      ? incoming.isLoading && incoming.data === null
      : requests.isLoading && requests.data === null;
  const requestsLoading = requests.isLoading && requests.data === null;
  const stockLoading =
    (stock.isLoading && stock.data === null) ||
    (products.isLoading && products.data === null);

  const tiles: TileModel[] = [
    {
      key: 'new',
      label: 'Yangi so‘rovlar',
      caption: 'qabul/yuborish kutmoqda',
      value: newRequestCount,
      Icon: Inbox,
      tone: 'neutral',
      loading: incomingLoading,
    },
    {
      key: 'production',
      label: 'Ishlab chiqarishda',
      caption: 'sexga yuborilgan',
      value: inProductionCount,
      Icon: Factory,
      tone: 'neutral',
      loading: requestsLoading,
    },
    {
      key: 'low',
      label: 'Stok past',
      caption: 'min’dan past tayyor mahsulot',
      value: lowStockCount,
      Icon: AlertTriangle,
      tone: 'danger',
      loading: stockLoading,
    },
    {
      key: 'awaiting',
      label: 'Qabul kutmoqda',
      caption: 'yetib keldi · «Qabul qildim»',
      value: awaitingReceiveCount,
      Icon: PackageCheck,
      tone: 'danger',
      loading: requestsLoading,
    },
  ];

  return (
    <section
      aria-label="Markaziy sklad — umumiy holat"
      className="flex flex-wrap gap-3"
    >
      {tiles.map((tile) => (
        <Tile key={tile.key} tile={tile} />
      ))}
    </section>
  );
}
