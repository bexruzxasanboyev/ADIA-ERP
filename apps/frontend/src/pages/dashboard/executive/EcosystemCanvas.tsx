import { useCallback, useMemo, useRef } from 'react';
import ReactFlow, {
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlowProvider,
  type NodeTypes,
} from 'reactflow';
import { Maximize2, Minimize2 } from 'lucide-react';
import type {
  DashboardChainNode,
  DashboardSuppliersResponse,
  LocationType,
  ReplenishmentDetail,
} from '@/lib/types';
import { EcosystemNode } from './EcosystemNode';
import { ProductionGroupNode } from './ProductionGroupNode';
import { SupplierNode } from './SupplierNode';
import {
  buildEcosystemGraph,
  type EcosystemAdapterLookups,
} from './ecosystemAdapter';
import { buildRequestTrace } from './requestTracer';
import { cn } from '@/lib/utils';

/**
 * Dashboard v3 — Detalli ecosystem canvas.
 *
 * Renders the full supply ecosystem as a six-layer React Flow graph:
 *   Yetkazib beruvchilar → Xom-ashyo → Sex → Ta'minot → Markaziy → Do'kon
 *
 * Unlike `CanvasFlow` (Calm) which compresses each chain stage into a
 * single node, this canvas shows *every* location individually — up to
 * ~15 nodes and ~20 edges. The canvas allows zoom-on-scroll and pan so
 * the owner can explore; a MiniMap is anchored bottom-right.
 *
 * When a `selectedRequest` is supplied, the canvas overlays the trace:
 *   • visited nodes glow green
 *   • the current node pulses yellow
 *   • off-path nodes are dimmed
 *   • the incoming edge to the current node animates a moving dot
 */
export interface EcosystemCanvasProps {
  chainFlow: DashboardChainNode[];
  suppliers: DashboardSuppliersResponse['suppliers'];
  /**
   * The currently-selected replenishment request (request row +
   * transitions). `null` means "no request selected" — the canvas
   * renders in its default static state.
   */
  selectedRequest?: ReplenishmentDetail | null;
  onSelectChain?: (type: LocationType, locationId: number) => void;
  onSelectSupplier?: (supplierId: number | null) => void;
  /**
   * Fullscreen state — when `true` the header shows a "minimize" icon
   * and the inner stage stretches to fill its container (typically the
   * page wraps the canvas in a `fixed inset-0` overlay). When
   * `undefined` the toggle button is hidden — keeps storybook /
   * isolated tests clean.
   */
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  className?: string;
}

const NODE_TYPES: NodeTypes = {
  ecosystemNode: EcosystemNode,
  supplierNode: SupplierNode,
  productionGroup: ProductionGroupNode,
};

export function EcosystemCanvas(props: EcosystemCanvasProps) {
  return (
    <ReactFlowProvider>
      <EcosystemCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

function EcosystemCanvasInner({
  chainFlow,
  suppliers,
  selectedRequest = null,
  onSelectChain,
  onSelectSupplier,
  isFullscreen,
  onToggleFullscreen,
  className,
}: EcosystemCanvasProps) {
  // Hold the caller's callbacks in refs so node-data callbacks stay
  // referentially stable across 30s auto-refresh ticks. Without this
  // every refetch built a brand-new `data.onSelect` function, React
  // Flow re-mounted every node, and the canvas flickered.
  const onChainRef = useRef(onSelectChain);
  onChainRef.current = onSelectChain;
  const onSupplierRef = useRef(onSelectSupplier);
  onSupplierRef.current = onSelectSupplier;

  const handleChain = useCallback((type: LocationType, locationId: number) => {
    onChainRef.current?.(type, locationId);
  }, []);
  const handleSupplier = useCallback((id: number | null) => {
    onSupplierRef.current?.(id);
  }, []);

  const graph = useMemo(
    () =>
      buildEcosystemGraph({
        chainFlow,
        suppliers,
        onSelectChain: handleChain,
        onSelectSupplier: handleSupplier,
      }),
    [chainFlow, suppliers, handleChain, handleSupplier],
  );

  // Apply the request trace overlay on top of the static graph. When
  // no request is selected the graph passes through unchanged.
  const { nodes, edges } = useMemo(
    () => applyTraceOverlay(graph, selectedRequest),
    [graph, selectedRequest],
  );

  const nodeCount = nodes.length;
  const edgeCount = edges.length;

  return (
    <section
      data-testid="ecosystem-canvas"
      aria-label="Ekosistema canvas (Detalli)"
      data-fullscreen={isFullscreen ? 'true' : 'false'}
      className={cn(
        'flex flex-col rounded-xl border border-border/60 bg-card',
        isFullscreen ? 'h-full' : null,
        className,
      )}
    >
      <header className="flex items-center justify-between gap-3 border-b border-border/40 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Ekosistema — Detalli
          </h2>
        </div>
        <div className="flex items-center gap-3">
          <p className="text-xs text-muted-foreground">
            {nodeCount} bo'g'in · {edgeCount} ulanish
          </p>
          {onToggleFullscreen ? (
            <button
              type="button"
              onClick={onToggleFullscreen}
              data-testid="ecosystem-fullscreen-toggle"
              aria-label={
                isFullscreen
                  ? "To'liq ekrandan chiqish"
                  : "To'liq ekranga ochish"
              }
              aria-pressed={isFullscreen ?? false}
              title={
                isFullscreen
                  ? "To'liq ekrandan chiqish (Esc)"
                  : "To'liq ekranga ochish"
              }
              className={cn(
                'inline-flex h-7 w-7 items-center justify-center rounded-md border border-border/60 bg-card text-muted-foreground outline-none transition-colors',
                'hover:bg-surface-3 hover:text-foreground',
                'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
              )}
            >
              {isFullscreen ? (
                <Minimize2 aria-hidden="true" className="size-3.5" />
              ) : (
                <Maximize2 aria-hidden="true" className="size-3.5" />
              )}
            </button>
          ) : null}
        </div>
      </header>
      <div
        className={cn(
          'relative w-full flex-1',
        )}
        data-testid="ecosystem-canvas-stage"
        style={isFullscreen ? undefined : { minHeight: 480 }}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          fitView
          fitViewOptions={{ padding: 0.06 }}
          proOptions={{ hideAttribution: true }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
          zoomOnScroll
          zoomOnPinch
          panOnDrag
          zoomOnDoubleClick={false}
          preventScrolling={false}
          minZoom={0.3}
          maxZoom={2.5}
          style={{ width: '100%', height: '100%' }}
        >
          <Background
            variant={BackgroundVariant.Dots}
            color="hsl(var(--border))"
            gap={16}
            size={1}
          />
          <MiniMap
            pannable
            zoomable
            nodeStrokeWidth={1}
            maskColor="hsl(var(--background) / 0.6)"
            style={{
              backgroundColor: 'hsl(var(--card))',
              border: '1px solid hsl(var(--border))',
            }}
          />
        </ReactFlow>
      </div>
    </section>
  );
}

/**
 * Overlay the trace overlay computed from a `ReplenishmentDetail` onto
 * the static graph. Mutates a copy of every node whose state changes
 * so React Flow notices the diff and re-renders only the touched nodes.
 */
function applyTraceOverlay(
  graph: { nodes: ReturnType<typeof buildEcosystemGraph>['nodes']; edges: ReturnType<typeof buildEcosystemGraph>['edges']; lookups: EcosystemAdapterLookups },
  selectedRequest: ReplenishmentDetail | null,
): { nodes: typeof graph.nodes; edges: typeof graph.edges } {
  if (selectedRequest === null) {
    return { nodes: graph.nodes, edges: graph.edges };
  }

  const trace = buildRequestTrace(selectedRequest, {
    productionParentId: graph.lookups.productionParentId,
    locationNodeId: graph.lookups.locationNodeId,
    edgeId: graph.lookups.edgeId,
  });

  const nodes = graph.nodes.map((node) => {
    const traceState = trace.nodes.get(node.id);
    // Supplier nodes don't carry a `traceState` field on their data
    // payload — dim them via style opacity instead.
    if (node.type === 'supplierNode') {
      if (traceState === 'active' || traceState === 'done') {
        return node; // suppliers don't currently appear on a trace path
      }
      return { ...node, style: { ...node.style, opacity: 0.4 } };
    }
    // Production group + ecosystem node both accept `traceState` on
    // their data payload. TypeScript can't narrow a discriminated union
    // through a generic `node.data` spread, so we recast the node
    // shape locally; the underlying invariant (the component
    // accepts the union of valid states) is verified by the unit tests.
    const next: typeof node = {
      ...node,
      data: {
        ...node.data,
        traceState:
          traceState === 'active' || traceState === 'done'
            ? traceState
            : ('dimmed' as const),
      } as typeof node.data,
    };
    return next;
  });

  const edges = graph.edges.map((edge) => {
    const traceState = trace.edges.get(edge.id);
    if (traceState === 'active') {
      return {
        ...edge,
        style: {
          ...edge.style,
          stroke: 'hsl(var(--warning))',
          strokeWidth: 2.5,
        },
        animated: true,
      };
    }
    if (traceState === 'done') {
      return {
        ...edge,
        style: {
          ...edge.style,
          stroke: 'hsl(var(--success))',
          strokeWidth: 2,
        },
        animated: true,
      };
    }
    // Off-path edges fade away.
    return {
      ...edge,
      style: { ...edge.style, opacity: 0.2 },
      animated: false,
    };
  });

  return { nodes, edges };
}
