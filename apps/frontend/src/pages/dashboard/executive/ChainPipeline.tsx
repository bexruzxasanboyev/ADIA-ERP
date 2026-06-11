import { ChevronDown, ChevronRight } from 'lucide-react';
import { CHAIN_TONE_BY_TYPE } from '@/lib/chainTokens';
import type { LocationType } from '@/lib/types';
import { ChainCard, type ChainCardSummary } from './ChainCard';

/**
 * Dashboard v2 — Variant C — Chain pipeline.
 *
 * Renders the five supply-chain stages as a directed pipeline:
 *
 *   • `< lg`  — horizontal row of 5 compact cards separated by `→`.
 *   • `lg+`   — vertical column of 5 compact cards separated by `↓`.
 *
 * Each card is interactive and opens the existing `ChainDetailSheet`
 * via `onSelect`. Sparklines (when supplied via the `node.sparkline`
 * field) animate inside the card to show today's 7-day trend.
 */
export interface ChainPipelineNode {
  type: LocationType;
  title: string;
  summary: ChainCardSummary;
  /** Optional 7-day trend rendered inside the compact card. */
  sparkline?: number[];
}

export interface ChainPipelineProps {
  nodes: ChainPipelineNode[];
  selectedType: LocationType | null;
  onSelect(type: LocationType | null): void;
  className?: string;
}

const STAGE_ORDER: readonly LocationType[] = [
  'raw_warehouse',
  'production',
  'supply',
  'central_warehouse',
  'store',
] as const;

export function ChainPipeline({
  nodes,
  selectedType,
  onSelect,
  className,
}: ChainPipelineProps) {
  const byType = new Map(nodes.map((n) => [n.type, n] as const));
  const ordered = STAGE_ORDER.map((t) => byType.get(t)).filter(
    (n): n is ChainPipelineNode => n !== undefined,
  );

  return (
    <section
      data-testid="chain-pipeline"
      aria-labelledby="chain-pipeline-title"
      className={'flex flex-col gap-2 ' + (className ?? '')}
    >
      <header className="flex items-center justify-between gap-2">
        <h2
          id="chain-pipeline-title"
          className="text-sm font-semibold uppercase tracking-wider text-muted-foreground"
        >
          Zanjir oqimi
        </h2>
        <p className="text-xs text-muted-foreground">
          {ordered.length} bo'g'in
        </p>
      </header>

      {/* Mobile / tablet (< lg) — horizontal flow */}
      <div className="flex flex-col gap-2 lg:hidden">
        <ul
          className="-mx-1 flex snap-x snap-mandatory items-stretch gap-2 overflow-x-auto px-1 pb-1"
          data-testid="chain-pipeline-row"
        >
          {ordered.map((node, idx) => (
            <li
              key={node.type}
              className="flex shrink-0 snap-start items-stretch gap-2"
              style={{ minWidth: '13rem' }}
            >
              <ChainCard
                type={node.type}
                tone={CHAIN_TONE_BY_TYPE[node.type]}
                title={node.title}
                summary={node.summary}
                selected={selectedType === node.type}
                onSelect={() =>
                  onSelect(selectedType === node.type ? null : node.type)
                }
                compact
                sparkline={node.sparkline}
              />
              {idx < ordered.length - 1 && (
                <span
                  aria-hidden="true"
                  className="flex shrink-0 items-center text-muted-foreground"
                >
                  <ChevronRight className="size-4" />
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>

      {/* Desktop (lg+) — vertical column */}
      <ol
        className="hidden flex-col items-stretch gap-1 lg:flex"
        data-testid="chain-pipeline-column"
      >
        {ordered.map((node, idx) => (
          <li key={node.type} className="flex flex-col items-stretch">
            <ChainCard
              type={node.type}
              tone={CHAIN_TONE_BY_TYPE[node.type]}
              title={node.title}
              summary={node.summary}
              selected={selectedType === node.type}
              onSelect={() =>
                onSelect(selectedType === node.type ? null : node.type)
              }
              compact
              sparkline={node.sparkline}
            />
            {idx < ordered.length - 1 && (
              <span
                aria-hidden="true"
                className="flex items-center justify-center py-1 text-muted-foreground"
              >
                <ChevronDown className="size-4" />
              </span>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
