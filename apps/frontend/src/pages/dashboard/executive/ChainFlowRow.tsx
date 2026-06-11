import { CHAIN_TONE_BY_TYPE } from '@/lib/chainTokens';
import type { LocationType } from '@/lib/types';
import { ChainCard, type ChainCardSummary } from './ChainCard';

/**
 * Sprint B — chain summary grid.
 *
 * Layout (owner sketch):
 *   `< lg`  — single column, cards stack vertically.
 *   `≥ lg`  — 3 cards on the top row (raw / production / supply),
 *             2 cards on the bottom row (central / store).
 *
 * Toggling a selected card calls `onSelect(null)`; this is what the
 * detail drawer (Sprint C) will hook into.
 */
export interface ChainFlowNode {
  type: LocationType;
  title: string;
  summary: ChainCardSummary;
}

export interface ChainFlowRowProps {
  nodes: ChainFlowNode[];
  selectedType: LocationType | null;
  onSelect(type: LocationType | null): void;
  className?: string;
}

const TOP_TYPES: LocationType[] = ['raw_warehouse', 'production', 'supply'];
const BOTTOM_TYPES: LocationType[] = ['central_warehouse', 'store'];

function renderCard(
  node: ChainFlowNode,
  selectedType: LocationType | null,
  onSelect: (type: LocationType | null) => void,
) {
  return (
    <ChainCard
      key={node.type}
      type={node.type}
      tone={CHAIN_TONE_BY_TYPE[node.type]}
      title={node.title}
      summary={node.summary}
      selected={selectedType === node.type}
      onSelect={() =>
        onSelect(selectedType === node.type ? null : node.type)
      }
    />
  );
}

export function ChainFlowRow({
  nodes,
  selectedType,
  onSelect,
  className,
}: ChainFlowRowProps) {
  const byType = new Map(nodes.map((n) => [n.type, n] as const));
  const topNodes = TOP_TYPES.map((t) => byType.get(t)).filter(
    (n): n is ChainFlowNode => n !== undefined,
  );
  const bottomNodes = BOTTOM_TYPES.map((t) => byType.get(t)).filter(
    (n): n is ChainFlowNode => n !== undefined,
  );

  return (
    <div
      data-testid="chain-flow-row"
      className={'flex flex-col gap-3 ' + (className ?? '')}
    >
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        {topNodes.map((node) => renderCard(node, selectedType, onSelect))}
      </div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {bottomNodes.map((node) => renderCard(node, selectedType, onSelect))}
      </div>
    </div>
  );
}
