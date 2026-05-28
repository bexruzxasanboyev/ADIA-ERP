import { memo, type KeyboardEvent } from 'react';
import { Handle, Position, type NodeProps } from 'reactflow';
import { Factory } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * EcosystemCanvas — Ishlab Chiqarish parent group node.
 *
 * One large container card that holds all sex children (Sex Tort, Sex
 * Perojniy, Sex YF, …). The sex nodes are placed *inside* this group's
 * coordinate space by setting their `parentNode` to this node's id —
 * React Flow then renders them within the group's bounding box.
 *
 * Visual:
 *   • Dashed border in the production chain tone
 *   • Subtle tinted background (`bg-chain-production-tint`)
 *   • Title strip across the top with a Factory icon
 *   • Single target handle on the top (xom-ashyo → group)
 *
 * Sex-level outputs (sex → supply) use the sex children's own handles —
 * the group does NOT carry a bottom source handle so edges originate
 * from the right place visually.
 */
export interface ProductionGroupNodeData {
  /** Number of sex children inside the group — used in the title hint. */
  sexCount: number;
  /**
   * Trace overlay state — drives the active/done halo. 'dimmed' renders
   * with reduced opacity (same as off-path EcosystemNodes); 'idle' is
   * the default style.
   */
  traceState?: 'idle' | 'done' | 'active' | 'dimmed';
  /** Optional click → opens the production chain drawer. */
  onSelect?: () => void;
}

function ProductionGroupNodeImpl({ data }: NodeProps<ProductionGroupNodeData>) {
  const { sexCount, traceState = 'idle', onSelect } = data;

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect?.();
    }
  };

  const interactive = typeof onSelect === 'function';

  return (
    <div
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : -1}
      aria-label="Ishlab Chiqarish bo'limi"
      data-testid="production-group"
      data-trace={traceState}
      onClick={interactive ? onSelect : undefined}
      onKeyDown={interactive ? handleKeyDown : undefined}
      className={cn(
        'relative h-full w-full rounded-xl outline-none transition-all',
        traceState === 'active' &&
          'shadow-[0_0_24px_hsl(var(--warning)/0.45)]',
        traceState === 'dimmed' && 'opacity-40',
        interactive &&
          'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
      )}
    >
      <Handle
        type="target"
        position={Position.Top}
        id="top"
        className="!h-2 !w-2 !border-0 !bg-transparent"
        isConnectable={false}
      />

      {/* Floating badge — replaces the old dashed wrapper. Sits above
          the sex children so the group identity stays readable without
          a frame fighting the sex cards. */}
      <div
        className={cn(
          'absolute -top-3 left-3 z-10 inline-flex items-center gap-1.5 rounded-full border border-chain-production/40 bg-card px-2.5 py-1 shadow-sm',
        )}
      >
        <Factory
          aria-hidden="true"
          className="size-3.5 text-chain-production"
        />
        <p className="text-[11px] font-semibold uppercase tracking-wider text-chain-production">
          Ishlab Chiqarish
        </p>
        <span
          aria-hidden="true"
          className="text-[10px] font-medium text-muted-foreground"
        >
          · {sexCount} sex
        </span>
      </div>

      {/* No bottom handle — outputs leave from sex children directly. */}
    </div>
  );
}

export const ProductionGroupNode = memo(ProductionGroupNodeImpl);
