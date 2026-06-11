import { memo } from 'react';
import { Handle, Position, type NodeProps } from 'reactflow';
import { Factory } from 'lucide-react';
import type { ChainStatus } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * EcosystemCanvas (Detalli) — supplier node.
 *
 * Distinct visual identity from the chain nodes — suppliers are
 * *external* to the company, so they wear a neutral surface tone
 * (`bg-muted`) and the industrial 🏭 icon rather than a chain-tone
 * colour. The card is compact (160×100) so up to 5 fit on the top row.
 *
 * Suppliers sit at the very top of the canvas (no incoming edges); the
 * single `source` handle on the bottom emits the procurement flow into
 * the raw warehouse below.
 */
export interface SupplierNodeData {
  /** May be `null` for the "noma'lum yetkazib beruvchi" bucket. */
  supplierId: number | null;
  name: string;
  status: ChainStatus;
  /** Number of pending purchase orders attributed to this supplier. */
  pendingPos: number;
  /** Expected qty across those pending POs. */
  expectedQty: number;
  /**
   * Optional click handler — `null` supplier id is passed through so
   * callers can filter the drawer or no-op as they wish.
   */
  onSelect?: (supplierId: number | null) => void;
}

const STATUS_DOT: Record<ChainStatus, string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  danger: 'bg-destructive',
};

function formatPlainNumber(value: number): string {
  return new Intl.NumberFormat('uz-Latn-UZ').format(value);
}

function SupplierNodeImpl({ data }: NodeProps<SupplierNodeData>) {
  const { supplierId, name, status, pendingPos, expectedQty, onSelect } = data;

  const handleClick = () => onSelect?.(supplierId);
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect?.(supplierId);
    }
  };

  const interactive = typeof onSelect === 'function';

  return (
    <div
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : -1}
      aria-label={`Yetkazib beruvchi ${name}`}
      data-testid={`supplier-node-${supplierId ?? 'unknown'}`}
      data-status={status}
      onClick={interactive ? handleClick : undefined}
      onKeyDown={interactive ? handleKeyDown : undefined}
      className={cn(
        'flex h-[100px] w-[160px] flex-col gap-1.5 rounded-lg border border-border/60 bg-muted p-2.5 text-foreground shadow-sm outline-none transition-colors',
        interactive &&
          'cursor-pointer hover:bg-surface-3 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
      )}
    >
      <div className="flex items-center justify-between gap-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            aria-hidden="true"
            className={cn(
              'inline-block size-2 shrink-0 rounded-full',
              STATUS_DOT[status],
            )}
          />
          <p className="truncate text-[12px] font-semibold tracking-tight">
            {name}
          </p>
        </div>
        <Factory
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground"
        />
      </div>

      <div className="grid flex-1 grid-cols-2 gap-1">
        <div className="flex flex-col justify-center rounded border border-border/30 bg-background/60 px-1.5 py-1">
          <p className="truncate text-[8px] font-medium uppercase tracking-wider text-muted-foreground">
            Ochiq PO
          </p>
          <p className="truncate text-[13px] font-bold leading-tight tabular-nums">
            {formatPlainNumber(pendingPos)}
          </p>
        </div>
        <div className="flex flex-col justify-center rounded border border-border/30 bg-background/60 px-1.5 py-1">
          <p className="truncate text-[8px] font-medium uppercase tracking-wider text-muted-foreground">
            Kutilmoqda
          </p>
          <p className="truncate text-[13px] font-bold leading-tight tabular-nums">
            {formatPlainNumber(expectedQty)}
          </p>
        </div>
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

export const SupplierNode = memo(SupplierNodeImpl);
