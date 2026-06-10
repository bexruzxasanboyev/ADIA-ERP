import { Boxes, Factory, Package, Store, Truck, Warehouse } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  isRenderableJourney,
  type Journey,
  type JourneyStation,
} from '@/lib/replenishmentFlow';
import type { LocationType } from '@/lib/types';

/**
 * «Mini-xarita» — the compact chain-map strip on top of a WorkCard (owner-
 * approved Variant A + mini-xarita): each station of the order's product flow
 * as a dot + truncated name, joined by thin connectors, so a frontline user
 * sees WHERE their order sits in the chain without opening a board.
 *
 *   ● done (filled) ── ◉ current (accent + subtle pulse) ── ○ pending (hollow)
 *
 * Fits ONE line at mobile widths: every station is `min-w-0 flex-1` with a
 * truncated name; the type icon renders on the CURRENT station only (the rest
 * stay dot-only) so 4 stations never wrap. Renders nothing when the journey
 * payload is absent or malformed (the backend ships it in parallel —
 * {@link isRenderableJourney} guards the wire).
 */

/** Lucide icon per station type — matches the design system's location icons. */
const STATION_ICONS: Record<LocationType, typeof Store> = {
  store: Store,
  central_warehouse: Warehouse,
  production: Factory,
  sex_storage: Boxes,
  raw_warehouse: Package,
  supply: Truck,
};

function StationDot({ station }: { station: JourneyStation }) {
  const { state } = station;
  return (
    <span
      aria-hidden="true"
      className={cn(
        'size-2 shrink-0 rounded-full',
        state === 'current' &&
          'bg-primary ring-2 ring-primary/30 motion-safe:animate-pulse',
        state === 'done' && 'bg-primary/60',
        state === 'pending' &&
          'border border-muted-foreground/40 bg-transparent',
      )}
    />
  );
}

export function ChainStrip({ journey }: { journey?: Journey | null }) {
  if (!isRenderableJourney(journey)) return null;
  return (
    <ol
      aria-label="Buyurtma yo‘li"
      className="flex w-full min-w-0 items-center gap-1"
    >
      {journey.stations.map((station, i) => {
        const isCurrent = station.state === 'current';
        const Icon = STATION_ICONS[station.type];
        return (
          <li
            // A journey may legitimately repeat a name (e.g. two storages);
            // the position disambiguates the key.
            key={`${station.name}-${i}`}
            aria-current={isCurrent ? 'step' : undefined}
            className="flex min-w-0 flex-1 items-center gap-1"
          >
            <StationDot station={station} />
            {isCurrent && Icon && (
              <Icon
                className="size-3 shrink-0 text-primary"
                aria-hidden="true"
              />
            )}
            <span
              title={station.name}
              className={cn(
                'truncate text-[10px] leading-tight',
                isCurrent
                  ? 'font-medium text-foreground'
                  : station.state === 'done'
                    ? 'text-muted-foreground'
                    : 'text-muted-foreground/60',
              )}
            >
              {station.name}
            </span>
            {i < journey.stations.length - 1 && (
              <span
                aria-hidden="true"
                className={cn(
                  'h-px min-w-1.5 flex-1',
                  station.state === 'done' ? 'bg-primary/40' : 'bg-border',
                )}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
