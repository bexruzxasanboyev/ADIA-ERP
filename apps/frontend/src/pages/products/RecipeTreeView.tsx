import { CornerDownRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { formatPlainNumber, formatQty, formatQtyUnit, formatSom } from '@/lib/format';
import { cn } from '@/lib/utils';
import { PRODUCT_TYPE_LABELS } from '@/lib/labels';
import type { ProductType, RecipeNode } from '@/lib/types';

/**
 * Read-only recipe (BOM) view — the "recipe book" of section cards.
 *
 * Replaces the former collapsible Poster-style "Состав" tree: instead of
 * one nested, expand/collapse outline, the recipe is flattened into a stack
 * of cards — one per recipe LEVEL (the root semi node and every nested
 * `semi` node that has children). Everything is visible at once, no
 * disclosure, scannable top-down depth-first so the reading flow matches the
 * structure (root → its semi children → their semi children …).
 */

/**
 * Product-type → <Badge> variant, mirroring `PRODUCT_CATEGORY_STYLE`
 * (lib/productCategory.ts): raw = neutral outline, semi = default chip,
 * finished = success. Reused for the small type badge on each row, and by
 * RecipePage for the product header badge.
 */
export const PRODUCT_TYPE_BADGE: Record<
  ProductType,
  'default' | 'outline' | 'success'
> = {
  raw: 'outline',
  semi: 'default',
  finished: 'success',
};

/** Shared column template for a card's child table (header + rows). */
// Columns: Komponent · Miqdor · Brutto · Netto · Tannarx (Poster "Состав"
// layout). Brutto/Netto are the raw Poster grams.
const ROW_GRID =
  'grid grid-cols-[minmax(0,1fr)_88px_72px_72px_116px] items-center gap-3';

/** Render a so'm cost cell, or an em-dash when unknown (never a fake 0). */
function costCell(value: number | null): string {
  return value === null ? '—' : formatSom(value);
}

/** Render a brutto/netto weight cell (raw Poster grams), or "—" when unset. */
function weightCell(value: number | null): string {
  return value === null || value === 0 ? '—' : formatQty(value);
}

/** A node is its own section iff it is a `semi` with at least one child. */
function isSection(node: RecipeNode): boolean {
  return node.type === 'semi' && node.children.length > 0;
}

/**
 * Flatten the tree into the ordered list of section cards. Every `semi`
 * node that owns children becomes a section, surfaced depth-first so a
 * card always precedes the cards of its sub-recipes. `depth` is kept only
 * as a subtle left-accent hint — the layout stays flat (cards stacked, not
 * indented).
 */
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

/** Count the distinct `raw` ingredients across the whole tree (for summary). */
function countDistinctRaw(nodes: RecipeNode[], seen: Set<number>): void {
  for (const node of nodes) {
    if (node.type === 'raw') seen.add(node.component_product_id);
    if (node.children.length > 0) countDistinctRaw(node.children, seen);
  }
}

interface ComponentRowProps {
  node: RecipeNode;
}

/**
 * One direct-child row inside a section card. A `semi` child whose own
 * breakdown lives in a separate card below gets a muted "↓ alohida tarkib"
 * cue so the reader knows where to look — but it is NOT nested or
 * collapsible here.
 */
function ComponentRow({ node }: ComponentRowProps) {
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
      <span className="text-right tabular-nums text-muted-foreground">
        {weightCell(node.brutto)}
      </span>
      <span className="text-right tabular-nums text-muted-foreground">
        {weightCell(node.netto)}
      </span>
      <span className="text-right tabular-nums">{costCell(node.line_cost)}</span>
    </div>
  );
}

interface SectionCardProps {
  node: RecipeNode;
  /** Nesting level — drives only the subtle left accent, not indentation. */
  depth: number;
}

/**
 * One recipe level rendered as a card: a header (node name + type badge +
 * the node's subtotal cost, right-aligned) over a clean table of its direct
 * children. Fully expanded — no collapse.
 */
function SectionCard({ node, depth }: SectionCardProps) {
  return (
    <Card
      className={cn(
        'overflow-hidden',
        depth > 0 && 'border-l-2 border-l-primary/40',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/40 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
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
        </div>
        <span className="shrink-0 text-sm font-semibold tabular-nums text-foreground">
          {costCell(node.total_cost)}
        </span>
      </div>

      <div className="px-4">
        <div
          className={cn(
            ROW_GRID,
            'border-b border-border/60 py-3 text-xs font-medium text-muted-foreground',
          )}
        >
          <span>Komponent</span>
          <span className="text-right">Miqdor</span>
          <span className="text-right">Brutto</span>
          <span className="text-right">Netto</span>
          <span className="text-right">Tannarx</span>
        </div>
        {node.children.map((child) => (
          <ComponentRow key={child.component_product_id} node={child} />
        ))}
      </div>
    </Card>
  );
}

interface RecipeBreakdownProps {
  tree: RecipeNode[];
  totalCost: number | null;
  /** Recipe owner's unit — drives the "1 kg / 1 dona uchun" caption. */
  unit: 'kg' | 'l' | 'pcs' | null;
  productName: string;
  /**
   * EPIC 1.5 — when this breakdown is one stage of a grouped recipe
   * (hamir / krem / bezak), the page hides the grand "Jami tannarx" summary
   * (`showSummary={false}`) and the stage heading is rendered by the page
   * above this block. Defaults preserve the standalone full-recipe view.
   */
  showSummary?: boolean;
}

/**
 * Read-only recipe view as a stack of section cards plus a prominent summary
 * header. Costs are shown exactly as the API gives them (any may be `null`
 * → "—"); the UI neither fakes nor disclaims the numbers.
 *
 * The summary highlights the product's full resolved cost; below it, one card
 * per recipe level renders in depth-first order. A flat / single-level recipe
 * (a finished product whose tree is one node, or even a bare list of leaves)
 * degrades to a single section card.
 */
export function RecipeBreakdown({
  tree,
  totalCost,
  unit,
  productName,
  showSummary = true,
}: RecipeBreakdownProps) {
  const sections: { node: RecipeNode; depth: number }[] = [];
  collectSections(tree, 0, sections);

  // Flat / no-children recipe: no `semi`-with-children node was found, yet the
  // tree still has rows. Render those leaves as a single synthetic card so a
  // finished product with a one-level recipe still reads as a section.
  if (sections.length === 0 && tree.length > 0) {
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
  }

  const rawSeen = new Set<number>();
  countDistinctRaw(tree, rawSeen);
  const rawCount = rawSeen.size;

  const perUnitCaption =
    unit === 'pcs' ? '1 dona uchun' : unit ? `1 ${unit} uchun` : '1 birlik uchun';

  return (
    <div className="space-y-4">
      {/* Summary header — the product's full resolved cost, prominent.
          Hidden when this block is one stage of a grouped recipe (the page
          shows a single grand total + per-stage subtotals instead). */}
      {showSummary && (
        <Card className="border-primary/30 bg-primary/5 p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Jami tannarx · {perUnitCaption}
          </p>
          <p className="mt-1 text-3xl font-bold tabular-nums text-primary">
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
        />
      ))}
    </div>
  );
}
