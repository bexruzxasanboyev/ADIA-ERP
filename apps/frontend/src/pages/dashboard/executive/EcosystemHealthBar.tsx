import type { ComponentType } from 'react';
import {
  ChevronRight,
  Factory,
  Package,
  Store,
  Truck,
  Warehouse,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { LOCATION_TYPE_LABELS } from '@/lib/labels';
import { formatQty } from '@/lib/format';
import type { DashboardChainNode, LocationType } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * F4.7 — Compact ecosystem health bar (~112px).
 *
 * Horizontal pill row mirroring the five chain stages:
 *   Xom-ashyo → Ishlab chiqarish → Ta'minot → Markaziy sklad → Do'konlar
 *
 * Each pill aggregates the nodes belonging to its `location_type`:
 *   - `below_min_count` sums across nodes of that stage;
 *   - `open_requests_count` sums across nodes;
 *   - `total_products` is the sum (header-level glance).
 *
 * Status dot semantics (designer spec):
 *   green  → 0 below_min AND 0 open requests
 *   amber  → 0 below_min AND > 0 open requests
 *   red    → > 0 below_min
 *
 * The full `EcosystemFlow` component remains the drill-down on the
 * operations dashboard; this bar trades fidelity for executive density.
 */
const STAGE_ORDER: LocationType[] = [
  'raw_warehouse',
  'production',
  'supply',
  'central_warehouse',
  'store',
];

const STAGE_ICON: Record<LocationType, ComponentType<{ className?: string }>> = {
  raw_warehouse: Warehouse,
  production: Factory,
  supply: Truck,
  central_warehouse: Package,
  store: Store,
};

interface StageAggregate {
  type: LocationType;
  count: number;
  below_min_count: number;
  open_requests_count: number;
  total_products: number;
}

type StageStatus = 'ok' | 'warn' | 'danger';

const STATUS_DOT: Record<StageStatus, string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  danger: 'bg-destructive',
};

const STATUS_LABEL: Record<StageStatus, string> = {
  ok: 'Me’yorda',
  warn: 'Ochiq so‘rovlar bor',
  danger: 'Min’dan past',
};

function stageStatus(agg: StageAggregate): StageStatus {
  if (agg.below_min_count > 0) return 'danger';
  if (agg.open_requests_count > 0) return 'warn';
  return 'ok';
}

function aggregate(nodes: DashboardChainNode[]): Record<LocationType, StageAggregate> {
  const empty: StageAggregate = {
    type: 'raw_warehouse',
    count: 0,
    below_min_count: 0,
    open_requests_count: 0,
    total_products: 0,
  };
  const out: Record<LocationType, StageAggregate> = {
    raw_warehouse: { ...empty, type: 'raw_warehouse' },
    production: { ...empty, type: 'production' },
    supply: { ...empty, type: 'supply' },
    central_warehouse: { ...empty, type: 'central_warehouse' },
    store: { ...empty, type: 'store' },
  };
  for (const node of nodes) {
    const bucket = out[node.location_type];
    bucket.count += 1;
    bucket.below_min_count += node.below_min_count;
    bucket.open_requests_count += node.open_requests_count;
    bucket.total_products += node.total_products;
  }
  return out;
}

export function EcosystemHealthBar({
  nodes,
  className,
}: {
  nodes: DashboardChainNode[];
  className?: string;
}) {
  const grouped = aggregate(nodes);

  return (
    <Card
      className={cn('p-4 xl:p-5', className)}
      data-testid="ecosystem-health-bar"
    >
      <p className="mb-3 text-xs uppercase tracking-wider text-muted-foreground">
        Ekosistema sog‘lig‘i
      </p>
      <div className="flex items-stretch gap-2">
        {STAGE_ORDER.map((type, idx) => {
          const agg = grouped[type];
          const Icon = STAGE_ICON[type];
          const status = stageStatus(agg);
          return (
            <div key={type} className="flex flex-1 items-stretch gap-2">
              <div
                className="flex flex-1 items-center gap-3 rounded-md border border-border/60 bg-card/40 px-3 py-2.5"
                data-testid={`health-pill-${type}`}
                data-status={status}
              >
                <span
                  aria-hidden="true"
                  className="inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary"
                >
                  <Icon className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {LOCATION_TYPE_LABELS[type]}
                  </p>
                  <p className="truncate text-[11px] text-muted-foreground tabular-nums">
                    {agg.count === 0
                      ? '—'
                      : `${formatQty(agg.count)} bo‘g‘in · ${formatQty(agg.total_products)} mahsulot`}
                  </p>
                </div>
                <span
                  aria-label={STATUS_LABEL[status]}
                  title={STATUS_LABEL[status]}
                  className={cn(
                    'size-2.5 shrink-0 rounded-full',
                    STATUS_DOT[status],
                  )}
                />
              </div>
              {idx < STAGE_ORDER.length - 1 && (
                <ChevronRight
                  className="size-4 shrink-0 self-center text-muted-foreground"
                  aria-hidden="true"
                />
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
