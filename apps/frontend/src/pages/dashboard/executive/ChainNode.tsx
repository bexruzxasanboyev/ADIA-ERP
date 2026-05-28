import { memo, type ComponentType, type KeyboardEvent } from 'react';
import { Handle, Position, type NodeProps } from 'reactflow';
import { Box, Factory, Store, Truck, Warehouse } from 'lucide-react';
import { CHAIN_TONE_BY_TYPE } from '@/lib/chainTokens';
import type { ChainStatus, LocationType } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * Dashboard v3 — Variant B "Calm Canvas" — React Flow custom node.
 *
 * One supply-chain stage rendered as a fixed 220×140 card on the canvas.
 * The node is **not** draggable or connectable — the canvas is read-only,
 * passive context. Click bubbles up via `data.onSelect(type)` to open the
 * existing `ChainDetailSheet`.
 *
 * Visual: chain-tone-coloured title, status dot, and two large KPI
 * numbers. Source handles on the right and bottom (matching the layout
 * positions) let `reactflow` wire edges with the correct geometry.
 */
export interface ChainNodeStat {
  label: string;
  value: string;
  tone?: 'default' | 'danger' | 'warning';
}

export interface ChainNodeData {
  type: LocationType;
  title: string;
  status: ChainStatus;
  stats: ChainNodeStat[];
  selected?: boolean;
  onSelect?: (type: LocationType) => void;
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

const STAT_TONE: Record<NonNullable<ChainNodeStat['tone']>, string> = {
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
  raw: 'border-chain-raw/60',
  production: 'border-chain-production/60',
  supply: 'border-chain-supply/60',
  central: 'border-chain-central/60',
  store: 'border-chain-store/60',
};

function ChainNodeImpl({ data }: NodeProps<ChainNodeData>) {
  const { type, title, status, stats, selected, onSelect } = data;
  const tone = CHAIN_TONE_BY_TYPE[type];
  const Icon = TYPE_ICON[type];

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect?.(type);
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected ?? false}
      aria-label={`${title} bo'limini ochish`}
      data-testid={`chain-node-${type}`}
      data-tone={tone}
      data-status={status}
      data-selected={selected ? 'true' : 'false'}
      onClick={() => onSelect?.(type)}
      onKeyDown={handleKeyDown}
      className={cn(
        'flex h-[200px] w-[260px] cursor-pointer flex-col gap-2.5 rounded-xl border bg-card p-4 text-card-foreground shadow-sm outline-none transition-colors',
        'hover:bg-surface-3 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        selected
          ? cn('border-2 shadow-md', TONE_BORDER[tone])
          : 'border-border/60 hover:border-border',
      )}
    >
      {/* Target handles — incoming edges land here. Hidden visually. */}
      <Handle
        type="target"
        position={Position.Left}
        id="left"
        className="!h-2 !w-2 !border-0 !bg-transparent"
        isConnectable={false}
      />
      <Handle
        type="target"
        position={Position.Top}
        id="top"
        className="!h-2 !w-2 !border-0 !bg-transparent"
        isConnectable={false}
      />

      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden="true"
            data-testid={`chain-node-status-${type}`}
            className={cn(
              'inline-block size-2.5 shrink-0 rounded-full',
              STATUS_DOT[status],
            )}
          />
          <p
            className={cn(
              'truncate text-[15px] font-semibold tracking-tight',
              TONE_TEXT[tone],
            )}
          >
            {title}
          </p>
        </div>
        <Icon
          aria-hidden="true"
          className={cn('size-5 shrink-0', TONE_TEXT[tone])}
        />
      </div>

      <div className="grid flex-1 grid-cols-2 gap-2">
        {stats.slice(0, 4).map((stat, i) => (
          <div
            key={i}
            className="flex flex-col justify-center rounded-md border border-border/30 bg-surface-2/40 px-2 py-1.5"
          >
            <p className="truncate text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
              {stat.label}
            </p>
            <p
              className={cn(
                'truncate text-base font-bold leading-tight tabular-nums',
                STAT_TONE[stat.tone ?? 'default'],
              )}
            >
              {stat.value}
            </p>
          </div>
        ))}
      </div>

      {/* Source handles — outgoing edges leave from here. */}
      <Handle
        type="source"
        position={Position.Right}
        id="right"
        className="!h-2 !w-2 !border-0 !bg-transparent"
        isConnectable={false}
      />
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

export const ChainNode = memo(ChainNodeImpl);
