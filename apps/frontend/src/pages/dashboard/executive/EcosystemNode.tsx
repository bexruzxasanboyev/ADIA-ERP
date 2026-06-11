import { memo, type ComponentType, type KeyboardEvent } from 'react';
import { Handle, Position, type NodeProps } from 'reactflow';
import { Box, Factory, Store, Truck, Warehouse } from 'lucide-react';
import { CHAIN_TONE_BY_TYPE } from '@/lib/chainTokens';
import type { ChainStatus, LocationType } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * EcosystemCanvas (Detalli) — compact custom node.
 *
 * Smaller and tighter than `ChainNode` (the Calm canvas node): a single
 * node here represents a *single location* (e.g. "Sex Tort", "Do'kon
 * Kukcha"), not a whole chain stage. Up to 3 KPIs are rendered as a
 * compact 3-column mini grid so the card stays at 180×120.
 *
 * Click bubbles up to `data.onSelect(type, location_id)` so the parent
 * canvas can route the open into the existing detail drawer.
 */
export interface EcosystemNodeStat {
  label: string;
  value: string;
  tone?: 'default' | 'danger' | 'warning';
}

export interface EcosystemNodeData {
  type: LocationType;
  /** Backend `location_id`; surfaced to `onSelect` so the drawer can scope. */
  locationId: number;
  /** Short title shown in the card header. */
  title: string;
  status: ChainStatus;
  /** Max 3 are rendered; extras are dropped. */
  stats: EcosystemNodeStat[];
  /**
   * Request-trace overlay state — set when a replenishment request is
   * selected on the canvas:
   *   'active' — node pulses (current state of the selected request)
   *   'done'   — node has a green halo (already visited)
   *   'dimmed' — another request is selected and this node is off-path
   *   'idle'   — default (no request selected)
   */
  traceState?: 'idle' | 'done' | 'active' | 'dimmed';
  onSelect?: (type: LocationType, locationId: number) => void;
}

const TYPE_ICON: Record<LocationType, ComponentType<{ className?: string }>> = {
  raw_warehouse: Box,
  production: Factory,
  supply: Truck,
  sex_storage: Truck,
  central_warehouse: Warehouse,
  store: Store,
};

const STATUS_DOT: Record<ChainStatus, string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  danger: 'bg-destructive',
};

const STAT_TONE: Record<NonNullable<EcosystemNodeStat['tone']>, string> = {
  default: 'text-foreground',
  danger: 'text-destructive',
  warning: 'text-warning',
};

const TONE_TEXT: Record<string, string> = {
  raw: 'text-chain-raw',
  production: 'text-chain-production',
  supply: 'text-chain-supply',
  central: 'text-chain-central',
  store: 'text-chain-store',
};

const TONE_BORDER: Record<string, string> = {
  raw: 'border-chain-raw/40',
  production: 'border-chain-production/40',
  supply: 'border-chain-supply/40',
  central: 'border-chain-central/40',
  store: 'border-chain-store/40',
};

function EcosystemNodeImpl({ data }: NodeProps<EcosystemNodeData>) {
  const {
    type,
    locationId,
    title,
    status,
    stats,
    traceState = 'idle',
    onSelect,
  } = data;
  const tone = CHAIN_TONE_BY_TYPE[type];
  const Icon = TYPE_ICON[type];

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect?.(type, locationId);
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`${title} bo'limini ochish`}
      data-testid={`ecosystem-node-${type}-${locationId}`}
      data-tone={tone}
      data-status={status}
      data-trace={traceState}
      onClick={() => onSelect?.(type, locationId)}
      onKeyDown={handleKeyDown}
      className={cn(
        'flex h-[120px] w-[180px] cursor-pointer flex-col gap-1.5 rounded-lg border bg-card p-2.5 text-card-foreground shadow-sm outline-none transition-all',
        'hover:bg-surface-3 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        TONE_BORDER[tone],
        traceState === 'active' &&
          'animate-pulse ring-2 ring-warning shadow-[0_0_18px_hsl(var(--warning)/0.5)]',
        traceState === 'done' &&
          'ring-2 ring-success/70 shadow-[0_0_12px_hsl(var(--success)/0.35)]',
        traceState === 'dimmed' && 'opacity-40',
      )}
    >
      <Handle
        type="target"
        position={Position.Top}
        id="top"
        className="!h-2 !w-2 !border-0 !bg-transparent"
        isConnectable={false}
      />

      <div className="flex items-center justify-between gap-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            aria-hidden="true"
            data-testid={`ecosystem-node-status-${type}-${locationId}`}
            className={cn(
              'inline-block size-2 shrink-0 rounded-full',
              STATUS_DOT[status],
            )}
          />
          <p
            className={cn(
              'truncate text-[12px] font-semibold tracking-tight',
              TONE_TEXT[tone],
            )}
          >
            {title}
          </p>
        </div>
        <Icon
          aria-hidden="true"
          className={cn('size-3.5 shrink-0', TONE_TEXT[tone])}
        />
      </div>

      <div
        className={cn(
          'grid flex-1 gap-1',
          // Sex (production) nodelarda 2 ta KPI bo'ladi (Faol / Bugun) —
          // grid-cols-3 ostida 3-ustun bo'sh qolar va kartochka qing'ir
          // ko'rinardi. Ustunlar sonini stats uzunligiga moslab beramiz.
          stats.length === 2 ? 'grid-cols-2' : 'grid-cols-3',
        )}
      >
        {stats.slice(0, 3).map((stat, i) => (
          <div
            key={i}
            className="flex flex-col justify-center rounded border border-border/30 bg-surface-2/40 px-1.5 py-1"
          >
            <p className="truncate text-[8px] font-medium uppercase tracking-wider text-muted-foreground">
              {stat.label}
            </p>
            <p
              className={cn(
                'truncate text-[13px] font-bold leading-tight tabular-nums',
                STAT_TONE[stat.tone ?? 'default'],
              )}
            >
              {stat.value}
            </p>
          </div>
        ))}
      </div>

      <Handle
        type="source"
        position={Position.Bottom}
        id="bottom"
        className="!h-2 !w-2 !border-0 !bg-transparent"
        isConnectable={false}
      />
    </div>
  );
}

export const EcosystemNode = memo(EcosystemNodeImpl);
