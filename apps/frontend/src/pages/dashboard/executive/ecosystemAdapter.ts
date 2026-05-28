/**
 * EcosystemCanvas adapter — `chain_flow[]` + `suppliers[]` → React Flow
 * `nodes[]` + `edges[]`.
 *
 * Pure, side-effect-free, fully unit-testable. The canvas component
 * stays a thin shell around this transform.
 *
 * Node ids follow stable, type-prefixed conventions so React Flow can
 * keep node identity across refetches:
 *   supplier-<supplierId | 'unknown'>
 *   loc-<locationId>
 *
 * Edges are derived layer-by-layer:
 *   suppliers → raw_warehouse  (one per supplier)
 *   raw_warehouse → production (one per sex)
 *   production → supply        (per-sex × per-supply many-to-many; we
 *                                map by closest-name match; if none
 *                                matches, fall back to all-to-all)
 *   supply → central_warehouse (per-supply × per-central)
 *   central_warehouse → store  (one per store, fan-out from the first
 *                                central — central is usually 1, but
 *                                we support up to 2)
 *
 * Edge tone:
 *   destructive — either endpoint has `below_min_count >= 4`
 *   warning     — at least one endpoint has any below-min stock
 *   success     — neither endpoint is below min (a clean leg)
 */
import type { Edge, Node } from 'reactflow';
import type {
  ChainStatus,
  DashboardChainNode,
  DashboardSuppliersResponse,
  LocationType,
} from '@/lib/types';
import {
  CENTER_X,
  ECOSYSTEM_LAYOUT,
  NODE_WIDTH,
  PRODUCTION_GROUP_HEIGHT,
  PRODUCTION_GROUP_WIDTH,
  SUPPLIER_WIDTH,
  centredX,
  rowX,
} from './ecosystemLayout';
import type { EcosystemNodeData, EcosystemNodeStat } from './EcosystemNode';
import type { ProductionGroupNodeData } from './ProductionGroupNode';
import type { SupplierNodeData } from './SupplierNode';

/** Stable id of the Ishlab Chiqarish parent group node. */
export const PRODUCTION_GROUP_ID = 'production-group';

type Supplier = DashboardSuppliersResponse['suppliers'][number];

type EcoNode = Node<
  EcosystemNodeData | SupplierNodeData | ProductionGroupNodeData
>;

export interface EcosystemAdapterInput {
  chainFlow: DashboardChainNode[];
  suppliers: Supplier[];
  onSelectChain?: (type: LocationType, locationId: number) => void;
  onSelectSupplier?: (supplierId: number | null) => void;
}

/**
 * Lookups exposed back to the caller so the request tracer can find
 * the canonical React Flow node / edge ids for a given backend
 * `location_id` or `(source, target)` pair. The canvas adapter is the
 * single source of truth for id naming.
 */
export interface EcosystemAdapterLookups {
  productionParentId: string;
  /** Returns the canvas node id for a backend `location_id`, or `undefined`. */
  locationNodeId: (locationId: number) => string | undefined;
  /** Returns the canvas edge id for a (source, target) pair, or `undefined`. */
  edgeId: (
    sourceLocationId: number,
    targetLocationId: number,
  ) => string | undefined;
}

export interface EcosystemAdapterResult {
  nodes: EcoNode[];
  edges: Edge[];
  lookups: EcosystemAdapterLookups;
}

/** Public entry point — turns the raw API rows into a React Flow graph. */
export function buildEcosystemGraph(
  input: EcosystemAdapterInput,
): EcosystemAdapterResult {
  const { chainFlow, suppliers, onSelectChain, onSelectSupplier } = input;

  const byType = groupByType(chainFlow);

  const supplierNodes = buildSupplierNodes(suppliers, onSelectSupplier);
  const rawNodes = buildLayer(
    byType.raw_warehouse,
    'raw_warehouse',
    ECOSYSTEM_LAYOUT.raw.y,
    undefined,
    onSelectChain,
  );

  // Production: one parent group + sex children placed *inside* it.
  const { groupNode: productionGroupNode, sexNodes } = buildProductionLayer(
    byType.production,
    onSelectChain,
  );

  const supplyNodes = buildLayer(
    byType.supply,
    'supply',
    ECOSYSTEM_LAYOUT.supply.y,
    ECOSYSTEM_LAYOUT.supply.gap,
    onSelectChain,
  );
  const topCentral = pickTopCentral(byType.central_warehouse);
  const centralNodes = buildLayer(
    // The owner asked for at most top-2 central nodes; we honour that
    // by trimming after sorting by stock-pressure (below_min desc).
    topCentral,
    'central_warehouse',
    ECOSYSTEM_LAYOUT.central.y,
    220,
    onSelectChain,
  );
  const storeNodes = buildLayer(
    byType.store,
    'store',
    ECOSYSTEM_LAYOUT.stores.y,
    ECOSYSTEM_LAYOUT.stores.gap,
    onSelectChain,
  );

  const nodes: EcoNode[] = [
    ...supplierNodes,
    ...rawNodes,
    // React Flow renders parent groups behind children when the parent
    // is listed first — keep this order.
    ...(productionGroupNode ? [productionGroupNode] : []),
    ...sexNodes,
    ...supplyNodes,
    ...centralNodes,
    ...storeNodes,
  ];

  const edges: Edge[] = [
    ...edgesSuppliersToRaw(suppliers, byType.raw_warehouse),
    // Raw → each production sex, labelled with the sex name so the owner
    // can see at a glance which sex consumes which raw materials.
    ...edgesRawToProductionSex(byType.raw_warehouse, byType.production),
    // Each sex node → its matching supply warehouse (production output).
    ...edgesProductionToSupply(byType.production, byType.supply),
    ...edgesOneToMany('sup-central', byType.supply, topCentral),
    ...edgesOneToMany('central-store', topCentral, byType.store),
  ];

  const lookups: EcosystemAdapterLookups = {
    productionParentId: PRODUCTION_GROUP_ID,
    locationNodeId: (locationId: number) => {
      // Sex nodes still live at `loc-<id>` so the existing test ids
      // stay valid. Raw / supply / central / store also use `loc-<id>`.
      const exists = chainFlow.some(
        (row) =>
          row.location_id === locationId &&
          (row.location_type !== 'store' || isActiveStore(row.location_name)),
      );
      return exists ? `loc-${locationId}` : undefined;
    },
    edgeId: (source, target) => `edge-${source}-${target}`,
  };

  return { nodes, edges, lookups };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface ByType {
  raw_warehouse: DashboardChainNode[];
  production: DashboardChainNode[];
  supply: DashboardChainNode[];
  central_warehouse: DashboardChainNode[];
  store: DashboardChainNode[];
}

/**
 * Operational store allowlist — exact normalised-name match.
 *
 * The bakery runs two live retail stores: **Кукча** and **Рабочий**.
 * Poster POS also exposes side outlets (Кукча центральный, Чигатай,
 * Доставка, Do'kon 1) which the boss does not want on the canvas.
 * Latin transliterations are included in case a future seed switches
 * the alphabet.
 */
const ACTIVE_STORE_NAMES: ReadonlySet<string> = new Set([
  'кукча',
  'рабочий',
  'kukcha',
  'kokcha',
  'rabochiy',
]);

function isActiveStore(name: string): boolean {
  return ACTIVE_STORE_NAMES.has(name.trim().toLowerCase());
}

/**
 * The umbrella production location ("Ishlab chiqarish sexi") is the
 * canonical parent for every product-specific sex (Tort, Perojniy…).
 * The Detalli canvas already renders an "ISHLAB CHIQARISH" group header
 * — surfacing the umbrella as a sibling child duplicates that label and
 * confuses the owner ("which one is the real workshop?"). Filter it out
 * of the production layer by exact name match so per-product sexes
 * (e.g. "Tort sexi") are never accidentally hidden.
 */
const GENERIC_PRODUCTION_PARENT_NAME = 'ishlab chiqarish sexi';

function isGenericProductionParent(name: string): boolean {
  return name.trim().toLowerCase() === GENERIC_PRODUCTION_PARENT_NAME;
}

function groupByType(rows: DashboardChainNode[]): ByType {
  const out: ByType = {
    raw_warehouse: [],
    production: [],
    supply: [],
    central_warehouse: [],
    store: [],
  };
  for (const row of rows) {
    if (row.location_type === 'store' && !isActiveStore(row.location_name)) {
      continue;
    }
    if (
      row.location_type === 'production' &&
      isGenericProductionParent(row.location_name)
    ) {
      continue;
    }
    out[row.location_type].push(row);
  }
  // Sort each bucket by `location_id` so the layout is deterministic
  // across refetches.
  for (const key of Object.keys(out) as (keyof ByType)[]) {
    out[key].sort((a, b) => a.location_id - b.location_id);
  }
  return out;
}

/**
 * Trim central_warehouse rows down to the single most-loaded entry
 * (by below_min_count, then by id for stability). Poster exposes
 * 25-30 sub-warehouses as "central" — surfacing several creates a
 * cross-product mess of supply→central and central→store edges that
 * obscures the actual flow. The domain canonical model is one
 * markaziy sklad in the middle, so we render just that.
 */
function pickTopCentral(rows: DashboardChainNode[]): DashboardChainNode[] {
  return rows
    .slice()
    .sort((a, b) => {
      if (b.below_min_count !== a.below_min_count) {
        return b.below_min_count - a.below_min_count;
      }
      return a.location_id - b.location_id;
    })
    .slice(0, 1);
}

function buildSupplierNodes(
  suppliers: Supplier[],
  onSelect: ((id: number | null) => void) | undefined,
): EcoNode[] {
  const top = suppliers.slice(0, 5);
  return top.map((sup, i) => {
    const id = `supplier-${sup.supplier_id ?? 'unknown'}`;
    const data: SupplierNodeData = {
      supplierId: sup.supplier_id,
      name: sup.supplier_name,
      status: sup.status,
      pendingPos: sup.pending_pos,
      expectedQty: sup.expected_qty,
      onSelect,
    };
    return {
      id,
      type: 'supplierNode',
      position: {
        x: rowX(i, top.length, ECOSYSTEM_LAYOUT.suppliers.gap, SUPPLIER_WIDTH),
        y: ECOSYSTEM_LAYOUT.suppliers.y,
      },
      data,
      draggable: false,
      selectable: false,
    };
  });
}

function buildLayer(
  rows: DashboardChainNode[],
  type: LocationType,
  y: number,
  gap: number | undefined,
  onSelect: ((type: LocationType, locationId: number) => void) | undefined,
): EcoNode[] {
  if (rows.length === 0) return [];
  return rows.map((row, i) => {
    const x =
      gap === undefined
        ? centredX(NODE_WIDTH) + (i - (rows.length - 1) / 2) * 200
        : rowX(i, rows.length, gap, NODE_WIDTH);
    const data: EcosystemNodeData = {
      type,
      locationId: row.location_id,
      title: shortenName(row.location_name),
      status: derivedStatus(row),
      stats: buildStats(row),
      onSelect,
    };
    return {
      id: `loc-${row.location_id}`,
      type: 'ecosystemNode',
      position: { x, y },
      data,
      draggable: false,
      selectable: false,
    };
  });
}

/**
 * Production hierarchical layer:
 *   1) A parent `productionGroup` node holds the bounding box.
 *   2) Each sex is a normal `ecosystemNode` placed *inside* the parent
 *      using React Flow's `parentNode` + `extent: 'parent'` properties.
 *      Sex positions are in *local* coordinates (relative to the group's
 *      top-left), not canvas coordinates.
 *
 * Returns `groupNode = null` when no sex rows exist — we still want the
 * canvas to render gracefully on first-day deployments.
 */
function buildProductionLayer(
  sexRows: DashboardChainNode[],
  onSelect: ((type: LocationType, locationId: number) => void) | undefined,
): { groupNode: EcoNode | null; sexNodes: EcoNode[] } {
  if (sexRows.length === 0) {
    return { groupNode: null, sexNodes: [] };
  }

  const groupX = centredX(PRODUCTION_GROUP_WIDTH);
  const groupY = ECOSYSTEM_LAYOUT.productionGroup.y;

  const groupData: ProductionGroupNodeData = {
    sexCount: sexRows.length,
    // The group itself is not clickable for the trace — sex children
    // carry the per-sex onSelect. The drawer can be opened from any
    // sex child instead.
  };
  const groupNode: EcoNode = {
    id: PRODUCTION_GROUP_ID,
    type: 'productionGroup',
    position: { x: groupX, y: groupY },
    style: {
      width: PRODUCTION_GROUP_WIDTH,
      height: PRODUCTION_GROUP_HEIGHT,
    },
    data: groupData,
    draggable: false,
    selectable: false,
  };

  // Sex children — laid out in a row inside the parent. Local
  // coordinates: x is offset from the parent's left edge, y from the
  // parent's top edge.
  const { gap, yOffset } = ECOSYSTEM_LAYOUT.productionSex;
  const sexNodes = sexRows.map((row, i): EcoNode => {
    const localCenterX =
      PRODUCTION_GROUP_WIDTH / 2 +
      (i - (sexRows.length - 1) / 2) * gap;
    const localX = localCenterX - NODE_WIDTH / 2;
    const data: EcosystemNodeData = {
      type: 'production',
      locationId: row.location_id,
      title: shortenName(row.location_name),
      status: derivedStatus(row),
      stats: buildStats(row),
      onSelect,
    };
    return {
      id: `loc-${row.location_id}`,
      type: 'ecosystemNode',
      position: { x: localX, y: yOffset },
      parentNode: PRODUCTION_GROUP_ID,
      extent: 'parent',
      data,
      draggable: false,
      selectable: false,
    };
  });

  return { groupNode, sexNodes };
}

/**
 * `DashboardChainNode` does not carry a derived status field, so we
 * reproduce the dashboard's standard rule on the client:
 *   0          → ok
 *   1..3       → warn
 *   4+         → danger
 */
function derivedStatus(row: DashboardChainNode): ChainStatus {
  if (row.below_min_count >= 4) return 'danger';
  if (row.below_min_count >= 1) return 'warn';
  return 'ok';
}

function buildStats(row: DashboardChainNode): EcosystemNodeStat[] {
  // Sex (production) bo'g'inlari konversiya nuqtasi — saqlash joyi emas.
  // SKU/MIN/SO'ROV doim 0/0/0 bo'lar edi va hech qanday foydali signal
  // bermasdi. Buning o'rniga ishlab chiqarish operatsion KPI'larini ko'rsa-
  // tamiz: FAOL (active orders) + BUGUN (today's done). 3-ustun bo'sh.
  if (row.location_type === 'production') {
    const active = row.active_production_orders ?? 0;
    const done = row.done_today_count ?? 0;
    return [
      {
        label: 'Faol',
        value: String(active),
        // Active > 0 → ish bor (neutral); ish yo'q bo'lsa muhim emas
        // — neutral. Bu MIN kabi qizilga kirmaydi.
        tone: 'default',
      },
      {
        label: 'Bugun',
        value: String(done),
        // Done today > 0 → bugun ish chiqdi (sariq belgilamaymiz).
        // Done = 0 ham qizil emas — bugun hali tushga ham yetmagan bo'lishi
        // mumkin; faqat neytral matn.
        tone: 'default',
      },
    ];
  }

  return [
    { label: 'SKU', value: String(row.total_products) },
    {
      label: 'Min',
      value: String(row.below_min_count),
      tone:
        row.below_min_count === 0
          ? 'default'
          : row.below_min_count >= 4
            ? 'danger'
            : 'warning',
    },
    {
      label: "So'rov",
      value: String(row.open_requests_count),
      tone: row.open_requests_count > 0 ? 'warning' : 'default',
    },
  ];
}

/**
 * Trim long location names for the compact 180-wide card. The full name
 * still lives in `data` (and the drawer surfaces it), but the visible
 * label has to fit.
 */
function shortenName(name: string): string {
  const cleaned = name.trim();
  if (cleaned.length <= 18) return cleaned;
  return `${cleaned.slice(0, 17)}…`;
}

// ---------------------------------------------------------------------------
// Edge builders
// ---------------------------------------------------------------------------

function edgeStyle(tone: 'success' | 'warning' | 'destructive') {
  const stroke =
    tone === 'destructive'
      ? 'hsl(var(--destructive))'
      : tone === 'warning'
        ? 'hsl(var(--warning))'
        : 'hsl(var(--success))';
  return { stroke, strokeWidth: 1.5 };
}

function legTone(
  a: DashboardChainNode | null,
  b: DashboardChainNode | null,
): 'success' | 'warning' | 'destructive' {
  const aMin = a?.below_min_count ?? 0;
  const bMin = b?.below_min_count ?? 0;
  if (aMin >= 4 || bMin >= 4) return 'destructive';
  if (aMin > 0 || bMin > 0) return 'warning';
  return 'success';
}

function edgesSuppliersToRaw(
  suppliers: Supplier[],
  rawRows: DashboardChainNode[],
): Edge[] {
  const raw = rawRows[0];
  if (!raw) return [];
  // The raw_warehouse layer has at most a couple of nodes in practice;
  // we attach every supplier to the *first* raw warehouse so the visual
  // funnels into the company entry point.
  const top = suppliers.slice(0, 5);
  return top.map((sup) => {
    const tone: 'success' | 'warning' | 'destructive' =
      sup.status === 'danger'
        ? 'destructive'
        : sup.status === 'warn'
          ? 'warning'
          : 'success';
    const supplierNodeId = `supplier-${sup.supplier_id ?? 'unknown'}`;
    return {
      id: `edge-${supplierNodeId}-loc-${raw.location_id}`,
      source: supplierNodeId,
      target: `loc-${raw.location_id}`,
      sourceHandle: 'bottom',
      targetHandle: 'top',
      animated: true,
      type: 'smoothstep',
      style: edgeStyle(tone),
    };
  });
}

/**
 * Raw → each production sex (fan-out, cross-product when there are
 * multiple raw warehouses). Each edge is labelled with the destination
 * sex name so the owner can read which sex is consuming raw stock
 * without having to follow the line to its endpoint. When the
 * production layer is empty we emit nothing — the canvas stays clean
 * on first-day deployments.
 */
function edgesRawToProductionSex(
  rawRows: DashboardChainNode[],
  sexRows: DashboardChainNode[],
): Edge[] {
  if (rawRows.length === 0 || sexRows.length === 0) return [];
  const edges: Edge[] = [];
  for (const raw of rawRows) {
    for (const sex of sexRows) {
      edges.push({
        id: `edge-loc-${raw.location_id}-loc-${sex.location_id}`,
        source: `loc-${raw.location_id}`,
        target: `loc-${sex.location_id}`,
        sourceHandle: 'bottom',
        targetHandle: 'top',
        animated: true,
        type: 'smoothstep',
        label: sexEdgeLabel(sex.location_name),
        labelStyle: {
          fill: 'hsl(var(--muted-foreground))',
          fontSize: 11,
          fontWeight: 500,
        },
        labelBgStyle: {
          fill: 'hsl(var(--card))',
          fillOpacity: 0.9,
        },
        labelBgPadding: [4, 2],
        labelBgBorderRadius: 4,
        style: edgeStyle(legTone(raw, sex)),
      });
    }
  }
  return edges;
}

/**
 * One-to-many fan-out from a single-node upstream layer (or replicated
 * across many → many when both sides have multiple entries). We use
 * cross-product so every upstream node connects to every downstream
 * node; for sex→supply this is intentional ("any sex can ship to any
 * supply"), and for raw→production the raw layer is typically a
 * single node so the cross-product collapses to a clean fan-out.
 */
function edgesOneToMany(
  _prefix: string,
  upstream: DashboardChainNode[],
  downstream: DashboardChainNode[],
): Edge[] {
  const edges: Edge[] = [];
  for (const u of upstream) {
    for (const d of downstream) {
      const tone = legTone(u, d);
      edges.push({
        id: `edge-loc-${u.location_id}-loc-${d.location_id}`,
        source: `loc-${u.location_id}`,
        target: `loc-${d.location_id}`,
        sourceHandle: 'bottom',
        targetHandle: 'top',
        animated: true,
        type: 'smoothstep',
        style: edgeStyle(tone),
      });
    }
  }
  return edges;
}

/**
 * Production → Supply mapping. Try "closest name match" first
 * (Tort sex → Tort sklad, Perojniy sex → Perojniy sklad, etc.). If a
 * sex has no matching supply we **do not** fan out to every supply any
 * more — that produced a tangled "any sex ships to any supply" diagram
 * which confused the boss. Instead:
 *   • If the sex looks like a *generic* production sex (e.g. "Ishlab
 *     chiqarish sexi") — fall through to the **first** supply
 *     deterministically so the canvas stays visually connected.
 *   • Otherwise — emit zero edges. The disconnected node makes the
 *     missing mapping obvious instead of hiding it under a hairball.
 *
 * Each edge gets a short, supply-derived label (e.g. "Tort", "Perojniy",
 * "Yarim Fabrika") so the owner can read which sex feeds which supply
 * without zooming in on the endpoints.
 */
function edgesProductionToSupply(
  productions: DashboardChainNode[],
  supplies: DashboardChainNode[],
): Edge[] {
  if (productions.length === 0 || supplies.length === 0) return [];
  const edges: Edge[] = [];
  for (const sex of productions) {
    const match = closestNameMatch(sex.location_name, supplies);
    let target: DashboardChainNode | null = match;
    if (target === null) {
      // Deterministic fallback for the generic production sex —
      // attach it to the first supply so the graph stays connected
      // for the most common single-sex configuration. Other unmatched
      // sex names are intentionally left disconnected.
      if (isGenericProductionSex(sex.location_name)) {
        target = supplies[0] ?? null;
      }
    }
    if (target === null) continue;
    const tone = legTone(sex, target);
    edges.push({
      id: `edge-loc-${sex.location_id}-loc-${target.location_id}`,
      source: `loc-${sex.location_id}`,
      target: `loc-${target.location_id}`,
      sourceHandle: 'bottom',
      targetHandle: 'top',
      animated: true,
      type: 'smoothstep',
      label: supplyEdgeLabel(target.location_name),
      labelStyle: {
        fill: 'hsl(var(--muted-foreground))',
        fontSize: 11,
        fontWeight: 500,
      },
      labelBgStyle: {
        fill: 'hsl(var(--card))',
        fillOpacity: 0.9,
      },
      labelBgPadding: [4, 2],
      labelBgBorderRadius: 4,
      style: edgeStyle(tone),
    });
  }
  return edges;
}

/**
 * Detect a generic / catch-all production sex name that does not carry
 * a product-specific token (Tort, Perojniy, Yarim Fabrika…). The
 * canonical generic name in Poster is **"Ishlab chiqarish sexi"** — its
 * tokens are `ishlab` / `chiqarish` / `sexi`, none of which appear in
 * any supply name.
 */
function isGenericProductionSex(name: string): boolean {
  const tokens = new Set(tokenise(name));
  // "ishlab" + "chiqarish" together are the strongest signal; "sexi"
  // alone would also flag sex-only rows. We accept either.
  return (
    (tokens.has('ishlab') && tokens.has('chiqarish')) ||
    (tokens.size > 0 && tokens.size <= 3 && tokens.has('sexi'))
  );
}

/**
 * Short, human-friendly label derived from a supply name. The supply
 * names follow the pattern "Ta'minot — Tort" / "Ta'minot — Yarim
 * Fabrika"; we strip the leading "Ta'minot" prefix and any em-dash so
 * the edge label reads as a clean product tag.
 */
function supplyEdgeLabel(supplyName: string): string {
  const cleaned = supplyName
    .replace(/^\s*ta'?minot\s*[—\-:]*\s*/iu, '')
    .trim();
  // Fall back to the original name if stripping the prefix left
  // nothing — defends against unexpected formats.
  return cleaned.length > 0 ? cleaned : supplyName;
}

/**
 * Short label derived from a sex name — strips the "sex" / "sexi"
 * marker (trailing in real Poster data: "Tort sexi" → "Tort"; leading
 * in some legacy / test fixtures: "Sex Tort" → "Tort") so the raw →
 * sex edge label reads as a clean product tag.
 */
function sexEdgeLabel(sexName: string): string {
  const cleaned = sexName
    .replace(/\s*sexi?\s*$/iu, '')
    .replace(/^\s*sexi?\s+/iu, '')
    .trim();
  return cleaned.length > 0 ? cleaned : sexName;
}

/** Pick the candidate whose lowercased name shares a token with `name`. */
function closestNameMatch(
  name: string,
  candidates: DashboardChainNode[],
): DashboardChainNode | null {
  const tokens = tokenise(name);
  if (tokens.length === 0) return null;
  for (const cand of candidates) {
    const candTokens = new Set(tokenise(cand.location_name));
    for (const t of tokens) {
      if (candTokens.has(t)) return cand;
    }
  }
  return null;
}

function tokenise(s: string): string[] {
  return s
    .toLocaleLowerCase('uz-Latn-UZ')
    .split(/[\s\-_/]+/)
    .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((t) => t.length >= 3);
}

// `CENTER_X` is re-exported for tests that want to assert the centre
// axis without importing the layout module directly. Keep at module
// bottom so tree-shakers can drop it when unused.
export { CENTER_X };
