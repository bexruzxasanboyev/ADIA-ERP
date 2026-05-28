import { ChevronRight, Factory, Package, Store, Truck, Warehouse } from 'lucide-react';
import type { ComponentType } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/PageState';
import { LOCATION_TYPE_LABELS } from '@/lib/labels';
import { formatQty } from '@/lib/format';
import type { DashboardChainNode, LocationType } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * F4.4 — Ecosystem chain visualisation (phase-4.md §2.4).
 *
 * Renders the full bakery supply chain as a horizontal flow:
 *   Xom-ashyo ombori → Ishlab chiqarish → Sex skladi →
 *   Markaziy sklad → Do'konlar
 *
 * Backend may return more than one node per type (multiple stores, two
 * supply locations); they are grouped under their stage and shown as a
 * compact stack.
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
  sex_storage: Truck,
  central_warehouse: Package,
  store: Store,
};

export function EcosystemFlow({
  nodes,
  className,
}: {
  nodes: DashboardChainNode[];
  className?: string;
}) {
  const grouped = groupByType(nodes);
  const isEmpty = nodes.length === 0;

  return (
    <Card className={cn('p-5', className)}>
      <header className="mb-4 space-y-0.5">
        <h2 className="text-base font-semibold">Ekosistema oqimi</h2>
        <p className="text-xs text-muted-foreground">
          Zanjir bo‘yicha bo‘g‘inlar holati va min’dan past pozitsiyalar.
        </p>
      </header>

      {isEmpty ? (
        <EmptyState message="Bo‘g‘inlar topilmadi." />
      ) : (
        <ol
          className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-5"
          data-testid="ecosystem-flow"
        >
          {STAGE_ORDER.map((type, idx) => {
            const stage = grouped[type] ?? [];
            const Icon = STAGE_ICON[type];
            return (
              <li
                key={type}
                className="relative"
                data-testid={`ecosystem-stage-${type}`}
              >
                <div className="flex h-full flex-col gap-2 rounded-md border border-border/60 bg-card/40 p-3">
                  <div className="flex items-center gap-2 border-b border-border/40 pb-2 text-sm font-semibold">
                    <span
                      aria-hidden="true"
                      className="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary"
                    >
                      <Icon className="size-4" />
                    </span>
                    <span className="truncate">
                      {LOCATION_TYPE_LABELS[type]}
                    </span>
                  </div>

                  {stage.length === 0 ? (
                    <p className="text-xs text-muted-foreground">—</p>
                  ) : (
                    <ul className="space-y-2">
                      {stage.map((node) => (
                        <StageNode key={node.location_id} node={node} />
                      ))}
                    </ul>
                  )}
                </div>

                {idx < STAGE_ORDER.length - 1 && (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute top-1/2 -right-2 hidden -translate-y-1/2 xl:inline-flex"
                  >
                    <ChevronRight className="size-5 text-muted-foreground/60" />
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

function StageNode({ node }: { node: DashboardChainNode }) {
  const danger = node.below_min_count > 0;
  return (
    <li className="rounded-md bg-background/60 p-2 text-xs">
      <p className="truncate font-medium text-foreground">{node.location_name}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="tabular-nums">
          {formatQty(node.total_products)} mahsulot
        </span>
        {node.open_requests_count > 0 && (
          <Badge variant="default" className="px-1.5 py-0 text-[10px]">
            {formatQty(node.open_requests_count)} so‘rov
          </Badge>
        )}
        {danger && (
          <Badge
            variant="danger"
            className="px-1.5 py-0 text-[10px]"
            data-testid="below-min-badge"
          >
            {formatQty(node.below_min_count)} min’dan past
          </Badge>
        )}
      </div>
    </li>
  );
}

/**
 * Group chain rows by their stage column. The backend ENUM is migrating
 * from `supply` to `sex_storage`; both values denote the same logical
 * "Sex skladi" layer, so we coalesce them onto the `supply` bucket. The
 * column itself is rendered under `supply` (its stable testid) but
 * labelled "Sex skladi" via `LOCATION_TYPE_LABELS` — see commit 1.
 */
function groupByType(
  nodes: DashboardChainNode[],
): Partial<Record<LocationType, DashboardChainNode[]>> {
  const out: Partial<Record<LocationType, DashboardChainNode[]>> = {};
  for (const node of nodes) {
    const key: LocationType =
      node.location_type === 'sex_storage' ? 'supply' : node.location_type;
    const bucket = out[key] ?? [];
    bucket.push(node);
    out[key] = bucket;
  }
  return out;
}
