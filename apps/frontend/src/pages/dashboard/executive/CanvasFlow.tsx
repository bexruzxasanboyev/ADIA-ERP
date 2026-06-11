import { useCallback, useMemo, useRef } from 'react';
import ReactFlow, {
  Background,
  BackgroundVariant,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeTypes,
} from 'reactflow';
import { CHAIN_LABELS, CHAIN_TONE_BY_TYPE } from '@/lib/chainTokens';
import { formatCurrencyCompact, formatQty, formatRelative } from '@/lib/format';
import type {
  ChainPulse,
  ChainSummaryNode,
  LocationType,
} from '@/lib/types';
import { ChainNode, type ChainNodeData, type ChainNodeStat } from './ChainNode';
// `reactflow/dist/style.css` is imported once globally in `src/main.tsx`
// — never inside a component module, to avoid Vite tree-shaking the
// stylesheet under HMR and to keep the import order deterministic.

/**
 * Dashboard v3 — Variant B "Calm Canvas" — supply chain canvas.
 *
 * Renders the five chain stages on a fixed React Flow canvas, with
 * animated edges showing the directional flow:
 *
 *   raw → production → supply        (top row)
 *                       ↓
 *               central → store      (bottom row)
 *
 * Edge tone reflects today's pulse:
 *   • success  — activity flowing through this leg in the last 24h
 *   • warning  — quiet leg (no movement today)
 *   • destructive — leg has at least one stage in danger status
 *
 * The canvas is read-only: nodes are not draggable, nothing connects,
 * scroll / pinch / pan are all disabled. The owner clicks a node to
 * open the existing detail sheet via `onSelectChain`.
 */
export interface CanvasFlowProps {
  chainSummary: ChainSummaryNode[];
  selectedChain: LocationType | null;
  onSelectChain: (type: LocationType | null) => void;
  className?: string;
}

// Node size is 260 × 200 (see ChainNode.tsx). Positions are spaced 360px
// horizontally (260 card + 100 gap for the edge label/arrow) and 280px
// vertically (200 card + 80 gap), so the canvas reads top row L→R and a
// branch dropping down to central → store on the bottom row.
const NODE_POSITIONS: Record<LocationType, { x: number; y: number }> = {
  raw_warehouse: { x: 0, y: 0 },
  production: { x: 360, y: 0 },
  supply: { x: 720, y: 0 },
  // `sex_storage` shares the supply column on this top-level canvas —
  // they are the same logical layer (sex storages).
  sex_storage: { x: 720, y: 0 },
  central_warehouse: { x: 360, y: 280 },
  store: { x: 720, y: 280 },
};

const STAGE_ORDER: readonly LocationType[] = [
  'raw_warehouse',
  'production',
  'supply',
  'central_warehouse',
  'store',
] as const;

const NODE_TYPES: NodeTypes = { chainNode: ChainNode };

type EdgeTone = 'success' | 'warning' | 'destructive';

const EDGE_STROKE: Record<EdgeTone, string> = {
  success: 'hsl(var(--success))',
  warning: 'hsl(var(--warning))',
  destructive: 'hsl(var(--destructive))',
};

interface EdgeSpec {
  id: string;
  source: LocationType;
  target: LocationType;
  sourceHandle: 'right' | 'bottom';
  targetHandle: 'left' | 'top';
}

const EDGES: readonly EdgeSpec[] = [
  {
    id: 'raw-production',
    source: 'raw_warehouse',
    target: 'production',
    sourceHandle: 'right',
    targetHandle: 'left',
  },
  {
    id: 'production-supply',
    source: 'production',
    target: 'supply',
    sourceHandle: 'right',
    targetHandle: 'left',
  },
  {
    id: 'production-central',
    source: 'production',
    target: 'central_warehouse',
    sourceHandle: 'bottom',
    targetHandle: 'top',
  },
  {
    id: 'central-store',
    source: 'central_warehouse',
    target: 'store',
    sourceHandle: 'right',
    targetHandle: 'left',
  },
  {
    id: 'supply-store',
    source: 'supply',
    target: 'store',
    sourceHandle: 'bottom',
    targetHandle: 'top',
  },
] as const;

export function CanvasFlow(props: CanvasFlowProps) {
  return (
    <ReactFlowProvider>
      <CanvasFlowInner {...props} />
    </ReactFlowProvider>
  );
}

function CanvasFlowInner({
  chainSummary,
  selectedChain,
  onSelectChain,
  className,
}: CanvasFlowProps) {
  const byType = useMemo(() => {
    const map = new Map<LocationType, ChainSummaryNode>();
    for (const row of chainSummary) map.set(row.type, row);
    return map;
  }, [chainSummary]);

  // Hold the caller's `onSelectChain` and current `selectedChain` in refs
  // so the node click handler can stay referentially stable across the
  // dashboard's 30s auto-refresh. Without this, every refetch produced a
  // brand-new `nodes` array — React Flow then re-mounted every node and
  // the canvas visibly flickered.
  const onSelectRef = useRef(onSelectChain);
  onSelectRef.current = onSelectChain;
  const selectedRef = useRef(selectedChain);
  selectedRef.current = selectedChain;

  const handleNodeSelect = useCallback((next: LocationType) => {
    const current = selectedRef.current;
    onSelectRef.current(current === next ? null : next);
  }, []);

  const nodes: Node<ChainNodeData>[] = useMemo(
    () =>
      STAGE_ORDER.map((type) => {
        const summary = byType.get(type) ?? null;
        const tone = CHAIN_TONE_BY_TYPE[type];
        return {
          id: type,
          type: 'chainNode',
          position: NODE_POSITIONS[type],
          // Per-node draggable/selectable flags are intentionally
          // omitted — the canvas-level `nodesDraggable={false}` and
          // `elementsSelectable` props on `<ReactFlow>` cover this and
          // keep the per-node `data` payload purely about content.
          data: {
            type,
            title: CHAIN_LABELS[tone],
            status: summary?.status ?? 'ok',
            stats: buildStats(summary),
            selected: selectedChain === type,
            onSelect: handleNodeSelect,
          },
        };
      }),
    [byType, selectedChain, handleNodeSelect],
  );

  const edges: Edge[] = useMemo(
    () =>
      EDGES.map((edge) => {
        const tone = edgeTone(edge, byType);
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          sourceHandle: edge.sourceHandle,
          targetHandle: edge.targetHandle,
          animated: true,
          type: 'smoothstep',
          style: { stroke: EDGE_STROKE[tone], strokeWidth: 2 },
          data: { tone },
        };
      }),
    [byType],
  );

  return (
    <section
      data-testid="canvas-flow"
      aria-label="Zanjir oqimi canvas"
      className={
        'rounded-xl border border-border/60 bg-card ' + (className ?? '')
      }
    >
      <header className="flex items-center justify-between border-b border-border/40 px-4 py-2.5">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Zanjir oqimi
        </h2>
        <p className="text-xs text-muted-foreground">
          {STAGE_ORDER.length} bo'g'in · {EDGES.length} ulanish
        </p>
      </header>
      <div
        className="relative h-[60vh] w-full"
        data-testid="canvas-flow-stage"
        style={{ minHeight: 480 }}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          proOptions={{ hideAttribution: true }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
          zoomOnScroll={false}
          zoomOnPinch={false}
          panOnDrag={false}
          zoomOnDoubleClick={false}
          preventScrolling={false}
          minZoom={0.3}
          maxZoom={1.5}
          style={{ width: '100%', height: '100%' }}
        >
          <Background
            variant={BackgroundVariant.Dots}
            color="hsl(var(--border))"
            gap={16}
            size={1}
          />
        </ReactFlow>
      </div>
    </section>
  );
}

function buildStats(node: ChainSummaryNode | null): ChainNodeStat[] {
  if (node === null) {
    return [
      { label: "Bo'g'in", value: '—' },
      { label: "Ma'lumot", value: '—' },
      { label: "Pulse", value: '—' },
      { label: "Status", value: '—' },
    ];
  }

  const pulse: ChainPulse = node.pulse;
  const belowMin: ChainNodeStat = {
    label: "Min'dan past",
    value: formatQty(node.below_min_count),
    // Soft tone-mapping: small alert counts stay 'warning', only large
    // ones bump to 'danger'. Otherwise even 1 low-stock SKU painted the
    // node red and confused the owner ("nega danger?").
    tone:
      node.below_min_count === 0
        ? 'default'
        : node.below_min_count >= 4
          ? 'danger'
          : 'warning',
  };
  const skuCount: ChainNodeStat = {
    label: 'SKU',
    value: formatQty(node.total_products),
  };

  switch (pulse.kind) {
    case 'raw': {
      // Owner question: "Sotib olish kerakmi va omborda nima bor?"
      // 4 KPI — SKU, min'dan past, bugun qabul, ochiq PO.
      const pending = pulse.pending_purchase_orders ?? 0;
      return [
        skuCount,
        belowMin,
        {
          label: 'Bugun qabul',
          value: formatQty(pulse.received_today),
        },
        {
          label: 'Ochiq PO',
          value: formatQty(pending),
          tone: pending > 0 ? 'warning' : 'default',
        },
      ];
    }
    case 'production': {
      // Owner question: "Reja bajarilayaptimi?"
      // 4 KPI — faol zayafka, bugun bajarildi, muddati o'tgan, sex soni.
      const overdue = pulse.overdue_orders ?? 0;
      return [
        {
          label: 'Faol zayafka',
          value: formatQty(pulse.active_orders),
        },
        {
          label: 'Bugun bajarildi',
          value: formatQty(pulse.done_today),
        },
        {
          label: "Muddat o'tgan",
          value: formatQty(overdue),
          tone:
            overdue === 0 ? 'default' : overdue >= 3 ? 'danger' : 'warning',
        },
        {
          label: 'Sex',
          value: formatQty(pulse.sex_count ?? 0),
        },
      ];
    }
    case 'supply': {
      // Owner question: "Biror narsa qotmaganmi?"
      // 4 KPI — SKU, ochiq so'rov, bugun jo'natildi, bugun qabul.
      const openReq = pulse.open_requests ?? 0;
      return [
        skuCount,
        {
          label: "Ochiq so'rov",
          value: formatQty(openReq),
          tone:
            openReq === 0 ? 'default' : openReq >= 5 ? 'danger' : 'warning',
        },
        {
          label: "Bugun jo'natildi",
          value: formatQty(pulse.shipped_today),
        },
        {
          label: 'Bugun qabul',
          value: formatQty(pulse.received_today),
        },
      ];
    }
    case 'central': {
      // Owner question: "Markaziy sklad va Poster sog'lommi?"
      // 4 KPI — SKU, min'dan past, oxirgi sinx, 24h xato (soft tone).
      const errors = pulse.sync_errors_24h ?? 0;
      return [
        skuCount,
        belowMin,
        {
          label: 'Oxirgi sinx',
          value:
            pulse.last_sync_at === null
              ? '—'
              : formatRelative(pulse.last_sync_at),
          tone:
            pulse.last_sync_status === 'failed'
              ? 'danger'
              : pulse.last_sync_status === 'partial'
                ? 'warning'
                : 'default',
        },
        {
          label: '24h xato',
          value: formatQty(errors),
          // sync errors are noisy — 1-4 stays warning, 5+ is danger.
          tone:
            errors === 0 ? 'default' : errors >= 5 ? 'danger' : 'warning',
        },
      ];
    }
    case 'store': {
      // Owner question: "Bugun qancha sotildi?"
      // 4 KPI — bugungi savdo, cheklar, o'rt chek, min'dan past.
      return [
        {
          label: 'Bugungi savdo',
          value: formatCurrencyCompact(pulse.sales_today_sum),
        },
        {
          label: 'Cheklar',
          value: formatQty(pulse.receipts_today),
        },
        {
          label: "O'rt chek",
          value: formatCurrencyCompact(pulse.avg_receipt_today ?? 0),
        },
        belowMin,
      ];
    }
  }
}

function edgeTone(
  edge: EdgeSpec,
  byType: Map<LocationType, ChainSummaryNode>,
): EdgeTone {
  const source = byType.get(edge.source) ?? null;
  const target = byType.get(edge.target) ?? null;

  if (source?.status === 'danger' || target?.status === 'danger') {
    return 'destructive';
  }

  const flowing = hasActivity(edge, source, target);
  if (flowing) return 'success';
  return 'warning';
}

function hasActivity(
  edge: EdgeSpec,
  source: ChainSummaryNode | null,
  target: ChainSummaryNode | null,
): boolean {
  switch (edge.id) {
    case 'raw-production':
      return (
        (source?.pulse.kind === 'raw' && source.pulse.issued_today > 0) ||
        (target?.pulse.kind === 'production' &&
          target.pulse.active_orders > 0)
      );
    case 'production-supply':
      return (
        target?.pulse.kind === 'supply' && target.pulse.received_today > 0
      );
    case 'production-central':
      return (
        source?.pulse.kind === 'production' &&
        (source.pulse.output_today ?? 0) > 0
      );
    case 'central-store':
    case 'supply-store':
      return target?.pulse.kind === 'store' && target.pulse.receipts_today > 0;
    default:
      return false;
  }
}
