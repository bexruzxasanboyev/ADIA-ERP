import { useState } from 'react';
import { ChevronDown, CornerDownRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { formatPlainNumber, formatQtyUnit, formatSom } from '@/lib/format';
import { cn } from '@/lib/utils';
import { PRODUCT_TYPE_LABELS } from '@/lib/labels';
import type { ProductType, RecipeNode, Unit } from '@/lib/types';

/**
 * Read-only recipe (BOM) view — a clean, Poster-like cost table.
 *
 * Every quantity / cost is already exploded to a PER-1-FINISHED-PIECE basis by
 * the backend (bom.ts), so a nested prepack shows how much of it goes into ONE
 * piece. Each level is one card: a header (name + its per-piece subtotal) over a
 * table — Komponent · Miqdor (grams) · Ulush (cost share, with a bar) · Tannarx.
 * The "Ulush" column makes analysis instant: you see at a glance which component
 * drives the cost.
 */

export const PRODUCT_TYPE_BADGE: Record<
  ProductType,
  'default' | 'outline' | 'success'
> = {
  raw: 'outline',
  semi: 'default',
  finished: 'success',
};

/** Komponent · Miqdor · Ulush · Tannarx. */
const ROW_GRID =
  'grid grid-cols-[minmax(0,1fr)_132px_120px_120px] items-center gap-3';

function costCell(value: number | null): string {
  return value === null ? '—' : formatSom(value);
}

/** A node is its own section iff it is a `semi` with at least one child. */
function isSection(node: RecipeNode): boolean {
  return node.type === 'semi' && node.children.length > 0;
}

function collectSections(
  nodes: RecipeNode[],
  depth: number,
  out: { node: RecipeNode; depth: number }[],
): void {
  for (const node of nodes) {
    if (isSection(node)) {
      out.push({ node, depth });
      collectSections(node.children, depth + 1, out);
    }
  }
}

function countDistinctRaw(nodes: RecipeNode[], seen: Set<number>): void {
  for (const node of nodes) {
    if (node.type === 'raw') seen.add(node.component_product_id);
    if (node.children.length > 0) countDistinctRaw(node.children, seen);
  }
}

/**
 * Cost-share cell — a thin bar + percent of the GRAND total. Lets a manager
 * eyeball which ingredient/prepack dominates the cost (the "analiz qulay" goal).
 */
function ShareCell({
  lineCost,
  grandTotal,
}: {
  lineCost: number | null;
  grandTotal: number | null;
}) {
  if (lineCost === null || grandTotal === null || grandTotal <= 0) {
    return <span className="text-right text-muted-foreground">—</span>;
  }
  const pct = Math.min(100, (lineCost / grandTotal) * 100);
  return (
    <div className="flex items-center justify-end gap-2">
      <div className="h-1.5 w-12 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary/70"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-9 text-right tabular-nums text-xs text-muted-foreground">
        {pct >= 9.95 ? pct.toFixed(0) : pct.toFixed(1)}%
      </span>
    </div>
  );
}

function ComponentRow({
  node,
  grandTotal,
}: {
  node: RecipeNode;
  grandTotal: number | null;
}) {
  const hasOwnCard = isSection(node);
  return (
    <div
      className={cn(ROW_GRID, 'border-b border-border/40 py-3.5 last:border-b-0')}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span
          className="min-w-0 flex-1 truncate font-medium text-foreground"
          title={node.name}
        >
          {node.name}
        </span>
        <Badge
          variant={PRODUCT_TYPE_BADGE[node.type]}
          className="shrink-0 px-1.5 py-0 text-[10px] font-normal"
        >
          {PRODUCT_TYPE_LABELS[node.type]}
        </Badge>
        {hasOwnCard && (
          <span className="inline-flex shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground">
            <CornerDownRight className="size-3" aria-hidden="true" />
            alohida tarkib
          </span>
        )}
      </div>
      <span className="text-right tabular-nums text-muted-foreground">
        {formatQtyUnit(node.qty_per_unit, node.unit)}
      </span>
      <ShareCell lineCost={node.line_cost} grandTotal={grandTotal} />
      <span className="text-right font-medium tabular-nums">
        {costCell(node.line_cost)}
      </span>
    </div>
  );
}

function SectionCard({
  node,
  depth,
  grandTotal,
  defaultOpen = false,
}: {
  node: RecipeNode;
  depth: number;
  grandTotal: number | null;
  /** Direct-component cards open by default; semi sections start collapsed. */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Card
      className={cn(
        'overflow-hidden',
        depth > 0 && 'border-l-2 border-l-primary/40',
      )}
    >
      {/* Accordion header — the whole strip toggles the breakdown so long
          recipes collapse to a scannable list of section names + costs. */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={cn(
          'flex w-full flex-wrap items-center justify-between gap-2 bg-surface-3 px-4 py-3 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          open && 'border-b border-border/60',
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <ChevronDown
            className={cn(
              'size-4 shrink-0 text-muted-foreground transition-transform duration-200',
              !open && '-rotate-90',
            )}
            aria-hidden="true"
          />
          <h3
            className="min-w-0 truncate text-sm font-semibold text-foreground"
            title={node.name}
          >
            {node.name}
          </h3>
          <Badge
            variant={PRODUCT_TYPE_BADGE[node.type]}
            className="shrink-0 px-1.5 py-0 text-[10px] font-normal"
          >
            {PRODUCT_TYPE_LABELS[node.type]}
          </Badge>
          <span className="shrink-0 text-xs text-muted-foreground">
            {formatPlainNumber(node.children.length)} komponent
          </span>
        </div>
        <span className="shrink-0 text-sm font-semibold tabular-nums text-foreground">
          {costCell(node.total_cost)}
        </span>
      </button>

      {open && (
        <div className="px-4">
          <div
            className={cn(
              ROW_GRID,
              'border-b border-border/60 py-3 text-xs font-medium text-muted-foreground',
            )}
          >
            <span>Komponent</span>
            <span className="text-right">Miqdor</span>
            <span className="text-right">Ulush</span>
            <span className="text-right">Tannarx</span>
          </div>
          {node.children.map((child) => (
            <ComponentRow
              key={child.component_product_id}
              node={child}
              grandTotal={grandTotal}
            />
          ))}
        </div>
      )}
    </Card>
  );
}

interface AggregatedLine {
  id: number;
  name: string;
  type: ProductType;
  unit: Unit;
  qty: number;
  cost: number | null;
}

/** Sum every LEAF line (raw / recipe-less semi) across the whole tree. */
function collectLeafTotals(
  nodes: RecipeNode[],
  map: Map<number, AggregatedLine>,
): void {
  for (const node of nodes) {
    if (node.children.length > 0) {
      collectLeafTotals(node.children, map);
      continue;
    }
    const prev = map.get(node.component_product_id);
    if (prev) {
      prev.qty += node.qty_per_unit;
      if (node.line_cost !== null) prev.cost = (prev.cost ?? 0) + node.line_cost;
    } else {
      map.set(node.component_product_id, {
        id: node.component_product_id,
        name: node.name,
        type: node.type,
        unit: node.unit,
        qty: node.qty_per_unit,
        cost: node.line_cost,
      });
    }
  }
}

/**
 * "Umumiy mahsulotlar" — the whole recipe tree flattened to ingredient
 * totals: an ingredient used by several sub-recipes (e.g. шакар in every
 * biskvit + krem) shows ONCE with its summed per-piece quantity and cost.
 */
export function AggregatedIngredients({
  tree,
  grandTotal,
}: {
  tree: RecipeNode[];
  grandTotal: number | null;
}) {
  const [open, setOpen] = useState(true);
  const map = new Map<number, AggregatedLine>();
  collectLeafTotals(tree, map);
  const lines = [...map.values()].sort((a, b) => {
    if (a.cost === null && b.cost === null) return a.name.localeCompare(b.name);
    if (a.cost === null) return 1;
    if (b.cost === null) return -1;
    return b.cost - a.cost;
  });
  if (lines.length === 0) return null;
  const subtotal = lines.reduce<number | null>(
    (sum, l) => (l.cost === null ? sum : (sum ?? 0) + l.cost),
    null,
  );

  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={cn(
          'flex w-full flex-wrap items-center justify-between gap-2 bg-surface-3 px-4 py-3 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          open && 'border-b border-border/60',
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <ChevronDown
            className={cn(
              'size-4 shrink-0 text-muted-foreground transition-transform duration-200',
              !open && '-rotate-90',
            )}
            aria-hidden="true"
          />
          <h3 className="text-sm font-semibold text-foreground">
            Umumiy mahsulotlar
          </h3>
          <Badge variant="secondary" className="shrink-0">
            {formatPlainNumber(lines.length)}
          </Badge>
          <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
            butun retsept bo‘ylab jamlangan miqdorlar
          </span>
        </div>
        <span className="shrink-0 text-sm font-semibold tabular-nums text-foreground">
          {costCell(subtotal)}
        </span>
      </button>

      {open && (
        <div className="px-4">
          <div
            className={cn(
              ROW_GRID,
              'border-b border-border/60 py-3 text-xs font-medium text-muted-foreground',
            )}
          >
            <span>Mahsulot</span>
            <span className="text-right">Umumiy miqdor</span>
            <span className="text-right">Ulush</span>
            <span className="text-right">Tannarx</span>
          </div>
          {lines.map((line) => (
            <div
              key={line.id}
              className={cn(
                ROW_GRID,
                'border-b border-border/40 py-3.5 last:border-b-0',
              )}
            >
              <div className="flex min-w-0 items-center gap-1.5">
                <span
                  className="min-w-0 flex-1 truncate font-medium text-foreground"
                  title={line.name}
                >
                  {line.name}
                </span>
                <Badge
                  variant={PRODUCT_TYPE_BADGE[line.type]}
                  className="shrink-0 px-1.5 py-0 text-[10px] font-normal"
                >
                  {PRODUCT_TYPE_LABELS[line.type]}
                </Badge>
              </div>
              <span className="text-right tabular-nums text-muted-foreground">
                {formatQtyUnit(line.qty, line.unit)}
              </span>
              <ShareCell lineCost={line.cost} grandTotal={grandTotal} />
              <span className="text-right font-medium tabular-nums">
                {costCell(line.cost)}
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

interface RecipeBreakdownProps {
  tree: RecipeNode[];
  totalCost: number | null;
  unit: Unit | null;
  productName: string;
  showSummary?: boolean;
  /**
   * The product's GRAND total cost, used as the denominator for every row's
   * cost-share bar. Defaults to `totalCost`; the grouped (per-stage) view
   * passes the real grand total so a stage's rows share the whole-product base.
   */
  grandTotal?: number | null;
}

export function RecipeBreakdown({
  tree,
  totalCost,
  unit,
  productName,
  showSummary = true,
  grandTotal,
}: RecipeBreakdownProps) {
  const shareBase = grandTotal ?? totalCost;
  const sections: { node: RecipeNode; depth: number }[] = [];
  collectSections(tree, 0, sections);

  // Top-level components that are NOT semi-sections — i.e. direct raw / leaf
  // ingredients of the product itself (e.g. the НАПОЛЕОН recipe's direct `ун`).
  // These have no card of their own, so without an explicit pass they would
  // vanish whenever the recipe ALSO has semi sections. We surface them in a
  // single synthetic "direct components" card, rendered before the semi cards.
  const directNodes = tree.filter((node) => !isSection(node));

  if (sections.length === 0 && tree.length > 0) {
    // No semi sections at all — wrap every (leaf) top-level node in one card.
    const synthetic: RecipeNode = {
      component_product_id: -1,
      name: productName,
      type: 'finished',
      unit: unit ?? 'pcs',
      qty_per_unit: 1,
      brutto: null,
      netto: null,
      unit_cost: null,
      line_cost: null,
      total_cost: totalCost,
      children: tree,
    };
    sections.push({ node: synthetic, depth: 0 });
  } else if (directNodes.length > 0) {
    // Mixed recipe: semi sections PLUS direct leaf components. Render the
    // direct components in their own card so they read as components of the
    // finished product alongside the semi sections (without double-counting —
    // each semi section still lists only its own children).
    const directSubtotal = directNodes.reduce<number | null>((sum, n) => {
      if (n.line_cost === null || n.line_cost === undefined) return sum;
      return (sum ?? 0) + n.line_cost;
    }, null);
    const directCard: RecipeNode = {
      component_product_id: -2,
      name: productName,
      type: 'finished',
      unit: unit ?? 'pcs',
      qty_per_unit: 1,
      brutto: null,
      netto: null,
      unit_cost: null,
      line_cost: null,
      total_cost: directSubtotal,
      children: directNodes,
    };
    // Direct components first, then the semi sections.
    sections.unshift({ node: directCard, depth: 0 });
  }

  const rawSeen = new Set<number>();
  countDistinctRaw(tree, rawSeen);
  const rawCount = rawSeen.size;

  const perUnitCaption =
    unit === 'pcs' ? '1 dona uchun' : '1 birlik uchun';

  return (
    <div className="space-y-4">
      {showSummary && (
        <Card className="p-5">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Jami tannarx · {perUnitCaption}
          </p>
          <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight text-primary">
            {costCell(totalCost)}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            {formatPlainNumber(rawCount)} ta xom-ashyo komponenti
          </p>
        </Card>
      )}

      {sections.map(({ node, depth }) => (
        <SectionCard
          key={`${node.component_product_id}-${depth}`}
          node={node}
          depth={depth}
          grandTotal={shareBase}
          // Synthetic direct-component cards (-1 / -2) carry the product's own
          // top-level lines — keep them open; semi sections start collapsed.
          defaultOpen={node.component_product_id < 0}
        />
      ))}
    </div>
  );
}
