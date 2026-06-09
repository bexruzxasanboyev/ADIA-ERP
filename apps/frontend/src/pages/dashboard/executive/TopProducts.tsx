import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import {
  dateRangeToQuery,
  type DateRangeValue,
} from '@/components/DateRangeFilter';
import { Card } from '@/components/ui/card';
import { useApiQuery } from '@/hooks/useApiQuery';
import { formatPlainNumber } from '@/lib/format';
import { revenueTitleForRange } from '@/lib/labels';
import { cn } from '@/lib/utils';
import type { DashboardTopProductRow, DashboardTopProducts } from '@/lib/types';
import { TopProductsSheet } from './TopProductsSheet';

/**
 * Executive dashboard — "Eng ko'p sotilgan mahsulotlar" panel.
 *
 * Hits `GET /api/dashboard/top-products?range=…&limit=5` and renders the
 * SELECTED period's five best-selling products by revenue, each as a
 * ranked row: a rank badge (#1..#5), the product name, units sold with
 * the unit label, the revenue in so'm, and a thin share bar whose width
 * mirrors the product's fraction of total revenue.
 *
 * Mirrors RevenueBreakdown exactly on data flow: it takes the dashboard's
 * `range` prop, fetches via `useApiQuery` + `dateRangeToQuery`, follows
 * the same period-title copy, and degrades gracefully — on 404 / not-ready
 * it shows an inline "tayyor emas" hint instead of an error state; on a
 * successful-but-empty response it shows a calm "Ma'lumot yo'q" message.
 */
export interface TopProductsProps {
  /**
   * Active date-range filter. Drives BOTH the `?range=…&from=…&to=…`
   * query (so the panel re-fetches per period) and the subtitle copy.
   */
  range: DateRangeValue;
  /** Max rows to request/render. Defaults to 5. */
  limit?: number;
  className?: string;
}

/**
 * Map a raw Poster unit code to its Uzbek display label. Poster emits
 * 'p' for pieces and 'kg' for weight; anything else falls through to the
 * raw code so an unmapped unit still reads sensibly.
 */
export function unitLabel(unit: string): string {
  switch (unit) {
    case 'p':
    case 'pcs':
      return 'dona';
    case 'kg':
      return 'kg';
    default:
      return unit;
  }
}

/**
 * Accent colour per rank. #1 is emphasised with the accent emerald (a
 * "medal" feel); the rest read as a calm muted hierarchy. Literal hsl
 * values keep the bars visible in jsdom and the dark theme alike.
 */
const RANK_BAR_COLOUR = ['hsl(152 60% 48%)', 'hsl(204 90% 56%)'] as const;

export function rankBarColour(index: number): string {
  return index === 0 ? RANK_BAR_COLOUR[0] : RANK_BAR_COLOUR[1];
}

/**
 * Bar width as a percentage RELATIVE TO THE TOP PRODUCT (the max revenue in
 * the list), NOT share-of-total. With share-of-total the #1 product could be
 * a mere ~5% and its bar barely visible; relative-to-#1 makes the leader fill
 * the bar and the rest read as a clear proportional ranking. Guards a zero
 * `maxRevenue` (e.g. an all-zero list) to avoid divide-by-zero → 0 width.
 */
export function relativeBarPct(revenue: number, maxRevenue: number): number {
  if (!Number.isFinite(revenue) || !Number.isFinite(maxRevenue) || maxRevenue <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(1, revenue / maxRevenue)) * 100;
}

/** Format a 0..1 share as a percentage label ("12%" / "3.4%"). */
export function shareLabel(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return '0%';
  const pct = share * 100;
  return `${pct >= 10 ? Math.round(pct) : pct.toFixed(1)}%`;
}

/**
 * One ranked product row, shared by the Top-5 card and the full-list sheet.
 *
 * `rank` is 1-based (the position in the *full* ranking, so the sheet keeps
 * the real rank even when the list is filtered). The medal emphasis is
 * intentionally narrow: rank #1 gets the emerald fill + bold weight, #2 a
 * blue bar, and everything else reads calm/muted so a 200-row list never
 * looks noisy.
 */
export function TopProductRow({
  row,
  rank,
  maxRevenue,
}: {
  row: DashboardTopProductRow;
  rank: number;
  /** Highest revenue in the list — the bar is drawn relative to this. */
  maxRevenue: number;
}) {
  const index = rank - 1;
  const isTop = index === 0;
  return (
    <li
      data-testid={`top-product-${row.product_id}`}
      className="grid grid-cols-[2rem_1fr_auto] items-center gap-x-3"
    >
      {/* Rank badge — #1 emphasised with the accent fill. */}
      <span
        aria-hidden="true"
        className={cn(
          'flex size-7 items-center justify-center rounded-full text-xs font-semibold tabular-nums',
          isTop
            ? 'bg-success/15 text-success ring-1 ring-success/40'
            : 'bg-surface-2/60 text-muted-foreground',
        )}
      >
        {rank}
      </span>

      {/* Name + qty + share bar. */}
      <div className="min-w-0">
        <div className="flex items-baseline justify-between gap-2">
          <span
            className={cn(
              'truncate text-sm',
              isTop ? 'font-semibold text-foreground' : 'text-foreground',
            )}
            title={row.name}
          >
            {row.name}
          </span>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {formatPlainNumber(row.qty)} {unitLabel(row.unit)}
          </span>
        </div>
        {/* bar = revenue relative to the top product (max); the % label on
            the right = share of total revenue. Drawing the bar relative to
            #1 (not share-of-total) keeps the leader's bar full and the rest
            proportional, so the ranking reads clearly even when each product
            is only a few % of total. A short width transition smooths the
            fill-in when the data first appears. */}
        <div
          className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-surface-2/40"
          aria-hidden="true"
        >
          <div
            className="h-full rounded-full transition-[width] duration-500 ease-out"
            style={{
              width: `${relativeBarPct(row.revenue, maxRevenue)}%`,
              background: rankBarColour(index),
            }}
          />
        </div>
      </div>

      {/* Revenue + share percentage. */}
      <div className="ml-1 text-right">
        <p
          className={cn(
            'text-sm tabular-nums',
            isTop ? 'font-semibold text-foreground' : 'text-foreground',
          )}
        >
          {formatPlainNumber(row.revenue)}
          <span className="ml-1 text-xs font-normal text-muted-foreground">
            so&apos;m
          </span>
        </p>
        <p className="text-xs tabular-nums text-muted-foreground">
          {shareLabel(row.share)}
        </p>
      </div>
    </li>
  );
}

/**
 * The list skeleton placeholder — `count` ghost rows that mirror the real
 * row grid (rank dot · name+qty+bar · amount). Shared so the card and the
 * store block fade in identically.
 */
function TopProductsSkeleton({ count }: { count: number }) {
  return (
    <ul
      className="animate-pulse space-y-3.5"
      data-testid="top-products-skeleton"
      aria-hidden="true"
    >
      {Array.from({ length: count }).map((_, i) => (
        <li
          key={i}
          className="grid grid-cols-[2rem_1fr_auto] items-center gap-x-3"
        >
          {/* rank dot */}
          <span className="size-7 rounded-full bg-foreground/10" />
          {/* name + qty row, then the thin progress-bar placeholder */}
          <span className="min-w-0 space-y-2">
            <span className="flex items-center justify-between gap-2">
              <span className="block h-4 w-32 rounded bg-foreground/10" />
              <span className="block h-3 w-12 rounded bg-foreground/10" />
            </span>
            <span className="block h-2 w-full rounded-full bg-foreground/10" />
          </span>
          {/* amount bar */}
          <span className="ml-auto block h-4 w-20 rounded bg-foreground/10" />
        </li>
      ))}
    </ul>
  );
}

/**
 * Presentational "Eng ko'p sotilgan mahsulotlar" card — the shared shell used
 * by BOTH the executive dashboard (`TopProducts`, click → full-list sheet) and
 * the do'kon workspace (`StoreSalesAnalytics`, no detail sheet). It owns the
 * Card wrapper, the uppercase header + period subtitle, the loading skeleton,
 * the not-ready / empty notes and the ranked `TopProductRow` list with its
 * fade-in. It is purely a renderer — each call site keeps its own data source
 * and feeds rows + flags in.
 */
export interface TopProductsCardProps {
  /** Pre-ranked rows (already sorted desc, capped at `limit`). */
  products: DashboardTopProductRow[];
  /** Period subtitle copy, e.g. "Bugungi tushum". */
  title: string;
  /** Max rows; also the skeleton row count + the "Top N" label. */
  limit: number;
  /** Show the loading skeleton instead of the list. */
  isLoading: boolean;
  /** Show the "tayyor emas" inline note (endpoint missing / not ready). */
  isMissing?: boolean;
  /**
   * "Batafsil →" affordance. When provided, the whole card becomes a button
   * that invokes `onOpenDetail` (used by the dashboard to open the full-list
   * sheet). Omit it for call sites with no detail view (the store block).
   */
  onOpenDetail?: () => void;
  className?: string;
}

export function TopProductsCard({
  products,
  title,
  limit,
  isLoading,
  isMissing = false,
  onOpenDetail,
  className,
}: TopProductsCardProps) {
  const interactive = onOpenDetail !== undefined;
  // The top product's revenue anchors every bar (relative-to-#1 widths). The
  // list is pre-sorted desc, but Math.max stays correct regardless of order.
  const maxRevenue = products.reduce((max, p) => Math.max(max, p.revenue), 0);

  return (
    <Card
      data-testid="top-products"
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-haspopup={interactive ? 'dialog' : undefined}
      aria-label={
        interactive
          ? `Eng ko'p sotilgan mahsulotlar · ${title} · to'liq ro'yxatni ko'rish`
          : undefined
      }
      onClick={interactive ? onOpenDetail : undefined}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onOpenDetail();
              }
            }
          : undefined
      }
      className={cn(
        'space-y-4 p-5',
        interactive &&
          'group cursor-pointer transition-colors hover:border-border hover:bg-surface-2/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
    >
      <header className="flex items-baseline justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Eng ko&apos;p sotilgan mahsulotlar
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Top {limit} · {title}
          </p>
        </div>
        {interactive && (
          <span
            aria-hidden="true"
            className="flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground transition-colors group-hover:text-foreground"
          >
            Batafsil
            <ChevronRight className="size-4 transition-transform group-hover:translate-x-0.5" />
          </span>
        )}
      </header>

      {isLoading ? (
        <TopProductsSkeleton count={limit} />
      ) : isMissing ? (
        <p
          className="rounded-lg border border-border/60 bg-surface-3 px-3 py-2 text-xs text-muted-foreground"
          role="note"
        >
          {"Sotuv ma'lumotlari tayyor emas."}
        </p>
      ) : products.length === 0 ? (
        <p
          className="rounded-lg border border-border/60 bg-surface-3 px-3 py-6 text-center text-sm text-muted-foreground"
          role="note"
        >
          Ma&apos;lumot yo&apos;q
        </p>
      ) : (
        <ol
          className="space-y-3.5 animate-in fade-in duration-300"
          data-testid="top-products-list"
        >
          {products.map((row, index) => (
            <TopProductRow
              key={row.product_id}
              row={row}
              rank={index + 1}
              maxRevenue={maxRevenue}
            />
          ))}
        </ol>
      )}
    </Card>
  );
}

export function TopProducts({ range, limit = 5, className }: TopProductsProps) {
  const title = revenueTitleForRange(range.range);
  const [sheetOpen, setSheetOpen] = useState(false);
  const { data, isLoading, error } = useApiQuery<DashboardTopProducts>(
    `/api/dashboard/top-products?${dateRangeToQuery(range)}&limit=${limit}`,
  );

  // Graceful degradation mirrors RevenueBreakdown: a missing/not-ready
  // endpoint (any error) shows an inline note, not a hard error state.
  const isMissing = error !== null;
  const showSkeleton = isLoading && data === null && !isMissing;
  const products = data?.products ?? [];

  return (
    <>
      <TopProductsCard
        products={products}
        title={title}
        limit={limit}
        isLoading={showSkeleton}
        isMissing={isMissing}
        onOpenDetail={() => setSheetOpen(true)}
        className={className}
      />

      <TopProductsSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        range={range}
      />
    </>
  );
}
