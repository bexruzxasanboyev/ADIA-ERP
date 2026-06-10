import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Inbox,
  Package,
  PackageOpen,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { StockMeter, type StockTone } from '@/components/ui/stock-meter';
import { EmptyState } from '@/components/PageState';
import { formatQty, formatQtyUnit } from '@/lib/format';
import { TERMINAL_REPLENISHMENT_STATUSES } from '@/lib/types';
import type { ReplenishmentRequest, StockRow } from '@/lib/types';
import type { FlowRequest } from '@/lib/replenishmentFlow';
import { splitBoards } from '@/pages/replenishment/board/boardFilters';
import { BoardWorkspace } from '@/pages/replenishment/board/BoardWorkspace';
import { RequestDetailModal } from '@/pages/replenishment/RequestDetailModal';

/**
 * `/supply` drill-in — the flow workspace for a SINGLE sex_storage (Ishlab
 * chiqarish ombori) opened from the бо'g'inlar grid (cross-department-flow §9.2,
 * §12). The PM/admin overview owns the data fetch once; this view is a pure
 * projection of it onto one sklad — no new requests are issued here, so counts
 * always agree with the grid card that opened it.
 *
 * Two stacked blocks, mirroring every other workspace's So'rovlar surface:
 *   1. {@link BoardWorkspace} scoped to `[skladId]` (defaultSide="incoming") —
 *      📥 Kelgan = requests TARGETING this sklad (the krem cross-dept request +
 *      buffer tavsiya cards sit in Kutuvda, accept actions provided by
 *      RequestDetailModal); 📤 Chiqgan = this sklad's OWN refill requests.
 *   2. A "Min'dan past" panel — every product below min at this sklad, each row
 *      with qty/min/max + a StockMeter, plus a "So'rov: #N" chip when an open
 *      request already exists for that (product, sklad) pair (derived from the
 *      already-fetched replenishment rows — no extra fetch).
 */

/** A below-min stock row for this sklad, with its open request id (if any). */
interface ShortfallRow {
  row: StockRow;
  /** An open replenishment request id for this (product, sklad), or null. */
  openRequestId: number | null;
}

export interface SupplySkladDrillProps {
  /** The selected sklad (sex_storage location). */
  sklad: { id: number; name: string };
  /** ALL flow requests (fetched once by the parent overview). */
  requests: FlowRequest[];
  /** Stock rows for this sklad (already filtered to `location_id === sklad.id`). */
  stockRows: StockRow[];
  /** Refetch the parent's lists after a board action so counts stay live. */
  onActed: () => void;
  /** Return to the бо'g'inlar grid. */
  onBack: () => void;
}

/** Open (non-terminal) requests only — terminal rows never count as "kelayotgan". */
function isOpen(req: ReplenishmentRequest): boolean {
  return !TERMINAL_REPLENISHMENT_STATUSES.includes(req.status);
}

export function SupplySkladDrill({
  sklad,
  requests,
  stockRows,
  onActed,
  onBack,
}: SupplySkladDrillProps) {
  // The card whose Jira detail modal is open (accept/reject lives there).
  const [openRequest, setOpenRequest] = useState<FlowRequest | null>(null);

  // Board scope = this sklad ONLY. 📥 incoming = target is this sklad; 📤 outgoing
  // = this sklad raised the request. splitBoards is the same helper every
  // workspace uses, so the krem→Qaymoq pinned-target request lands on 📥 Kelgan.
  const scope = useMemo(() => new Set<number>([sklad.id]), [sklad.id]);
  const boards = useMemo(
    () => splitBoards(requests, scope),
    [requests, scope],
  );

  // Open requests targeting this sklad — drives the SO'ROVLAR chip; equals the
  // 📥 Kelgan open cards so the header count matches the board.
  const openIncoming = useMemo(
    () => boards.incoming.filter(isOpen),
    [boards.incoming],
  );

  // Min map for the "So'rov: #N" chip — one open request per (product) at this
  // sklad (Invariant 2: at most one open request per (product, location)).
  const openReqByProduct = useMemo(() => {
    const map = new Map<number, number>();
    for (const r of requests) {
      if (!isOpen(r)) continue;
      if (r.target_location_id !== sklad.id) continue;
      if (!map.has(r.product_id)) map.set(r.product_id, r.id);
    }
    return map;
  }, [requests, sklad.id]);

  // Below-min rows for this sklad, most-starved first.
  const shortfalls = useMemo<ShortfallRow[]>(() => {
    const out: ShortfallRow[] = [];
    for (const row of stockRows) {
      if (row.min_level <= 0) continue;
      if (row.qty > row.min_level) continue;
      out.push({
        row,
        openRequestId: openReqByProduct.get(row.product_id) ?? null,
      });
    }
    out.sort((a, b) => starveRatio(a.row) - starveRatio(b.row));
    return out;
  }, [stockRows, openReqByProduct]);

  const productCount = stockRows.length;

  return (
    <div className="space-y-6">
      {/* Drill header — back + sklad name + count chips. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <Button variant="ghost" size="sm" onClick={onBack} className="shrink-0">
            <ArrowLeft className="size-4" aria-hidden="true" />
            Bo‘g‘inlar
          </Button>
          <div className="flex min-w-0 items-center gap-2">
            <span
              aria-hidden="true"
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-chain-supply/15 text-chain-supply"
            >
              <PackageOpen className="size-4" />
            </span>
            <h2 className="truncate text-lg font-semibold tracking-tight">
              {sklad.name}
            </h2>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="gap-1 tabular-nums">
            <Package className="size-3" aria-hidden="true" />
            {formatQty(productCount)} mahsulot
          </Badge>
          <Badge
            variant={shortfalls.length > 0 ? 'danger' : 'secondary'}
            className="gap-1 tabular-nums"
          >
            <AlertTriangle className="size-3" aria-hidden="true" />
            {formatQty(shortfalls.length)} min’dan past
          </Badge>
          <Badge
            variant={openIncoming.length > 0 ? 'warning' : 'secondary'}
            className="gap-1 tabular-nums"
          >
            <Inbox className="size-3" aria-hidden="true" />
            {formatQty(openIncoming.length)} so‘rov
          </Badge>
        </div>
      </div>

      {/* ONE board area + 📥 Kelgan | 📤 Chiqgan toggle, scoped to this sklad. */}
      <BoardWorkspace
        incoming={boards.incoming}
        outgoing={boards.outgoing}
        defaultSide="incoming"
        onOpen={(req) => setOpenRequest(req)}
        incomingEmptyLabel="Bu skladga kelgan so‘rov yo‘q."
        outgoingEmptyLabel="Bu skladning chiqgan so‘rovi yo‘q."
      />

      {/* Min'dan past panel — below-min products at this sklad. */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle
              className="size-4 text-warning"
              aria-hidden="true"
            />
            Min’dan past
            <Badge variant="secondary" className="tabular-nums">
              {shortfalls.length}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {shortfalls.length === 0 ? (
            <EmptyState message="Bu skladda min’dan past mahsulot yo‘q." />
          ) : (
            <ul className="space-y-3">
              {shortfalls.map(({ row, openRequestId }) => (
                <ShortfallItem
                  key={`${row.location_id}-${row.product_id}`}
                  row={row}
                  openRequestId={openRequestId}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* The shared Jira detail modal — accept/reject the krem / buffer cards. */}
      <RequestDetailModal
        open={openRequest !== null}
        onOpenChange={(next) => {
          if (!next) setOpenRequest(null);
        }}
        request={openRequest}
        onActed={onActed}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// ShortfallItem — one below-min row: name + qty/min/max + meter + So'rov chip.
// Follows DESIGN.md §8 (status colours ONE element, card stays calm): the qty
// reads danger at 0 / warning below min, the meter fill carries the tone.
// ---------------------------------------------------------------------------

function ShortfallItem({
  row,
  openRequestId,
}: {
  row: StockRow;
  openRequestId: number | null;
}) {
  const tone: StockTone = row.qty <= 0 ? 'danger' : 'warning';
  const ratio = row.max_level > 0 ? row.qty / row.max_level : 0;
  const minRatio = row.max_level > 0 ? row.min_level / row.max_level : undefined;
  const qtyClass = row.qty <= 0 ? 'text-destructive' : 'text-warning';

  return (
    <li className="rounded-lg border border-border/60 bg-surface-3 p-3">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 flex-1 truncate text-sm font-medium">
          {row.product_name}
        </p>
        {openRequestId !== null ? (
          <Badge variant="info" className="shrink-0 tabular-nums">
            So‘rov: #{openRequestId}
          </Badge>
        ) : (
          <Badge variant="outline" className="shrink-0 text-muted-foreground">
            So‘rov yo‘q
          </Badge>
        )}
      </div>
      <p className={`mt-1 text-base font-semibold tabular-nums ${qtyClass}`}>
        {formatQtyUnit(row.qty, row.product_unit)}
      </p>
      <StockMeter
        ratio={ratio}
        minRatio={minRatio}
        tone={tone}
        className="mt-2"
      />
      <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground tabular-nums">
        <span>Min {formatQty(row.min_level)}</span>
        <span>Max {formatQty(row.max_level)}</span>
      </div>
    </li>
  );
}

/** Lower = more starved (qty/min). Guards a zero min defensively. */
function starveRatio(row: StockRow): number {
  if (row.min_level <= 0) return 1;
  return row.qty / row.min_level;
}
