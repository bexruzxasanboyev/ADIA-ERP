import { useMemo, useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Search } from 'lucide-react';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Input } from '@/components/ui/input';
import { useApiQuery } from '@/hooks/useApiQuery';
import {
  dateRangeToQuery,
  type DateRangeValue,
} from '@/components/DateRangeFilter';
import { revenueTitleForRange } from '@/lib/labels';
import { formatPlainNumber } from '@/lib/format';
import type { DashboardTopProducts } from '@/lib/types';
import { TopProductRow } from './TopProducts';

/**
 * "Eng ko'p sotilgan mahsulotlar" — full-ranking detail drawer.
 *
 * Opened from the Top-5 card on the executive dashboard. It fetches the
 * FULL ranking (`limit=200`) for the SAME active date range as the card,
 * lazily — the request is skipped (`useApiQuery(null)`) until the sheet is
 * open, so closed dashboards never pay for it.
 *
 * Visual language reuses `TopProductRow` from the card so the rank medals,
 * share bars and so'm formatting read identically; the sticky header carries
 * the title, the active period (via `revenueTitleForRange`) and the total
 * product count. A client-side name filter narrows the fetched rows while
 * preserving each product's REAL rank (so #7 stays #7 when filtered).
 *
 * Accessibility: built on the Radix-Dialog-backed `Sheet`, so focus trap,
 * ESC and overlay-click close come for free; `DialogTitle`/`Description`
 * announce the panel to screen readers. Mirrors `ChainDetailSheet`.
 */
export interface TopProductsSheetProps {
  open: boolean;
  range: DateRangeValue;
  onClose(): void;
}

/** How many rows the full ranking requests (backend cap raised to 200). */
const FULL_LIMIT = 200;

export function TopProductsSheet({
  open,
  range,
  onClose,
}: TopProductsSheetProps) {
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent
        side="right"
        className="w-full max-w-[540px] bg-card sm:max-w-[640px]"
      >
        {/* Mount the data-bound body only while open so the lazy query fires
            on open and resets (filter + scroll) on every re-open. */}
        {open && <TopProductsSheetBody range={range} />}
      </SheetContent>
    </Sheet>
  );
}

function TopProductsSheetBody({ range }: { range: DateRangeValue }) {
  const title = revenueTitleForRange(range.range);
  const [query, setQuery] = useState('');

  const { data, isLoading, error } = useApiQuery<DashboardTopProducts>(
    `/api/dashboard/top-products?${dateRangeToQuery(range)}&limit=${FULL_LIMIT}`,
  );

  const isMissing = error !== null;
  const showSkeleton = isLoading && data === null && !isMissing;
  const total = data?.products.length ?? 0;

  // Pre-rank the full list once per response so each row carries its real
  // 1-based rank (the medal hierarchy must survive client-side filtering).
  const ranked = useMemo(
    () => (data?.products ?? []).map((row, index) => ({ row, rank: index + 1 })),
    [data],
  );

  // The top product's revenue anchors every bar (relative-to-#1 widths),
  // computed across the FULL list so filtering never rescales the bars.
  const maxRevenue = useMemo(
    () => (data?.products ?? []).reduce((max, p) => Math.max(max, p.revenue), 0),
    [data],
  );

  // Filter by name (case-insensitive) but keep each row's real rank.
  const filtered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase('uz-Latn');
    if (q === '') return ranked;
    return ranked.filter(({ row }) =>
      row.name.toLocaleLowerCase('uz-Latn').includes(q),
    );
  }, [ranked, query]);

  return (
    <div className="flex h-full flex-col">
      {/* Sticky header — title, active period, product count, search. */}
      <header className="shrink-0 border-b border-border/60 p-5 pr-12">
        <DialogPrimitive.Title className="text-base font-semibold leading-tight text-foreground">
          Eng ko&apos;p sotilgan mahsulotlar
        </DialogPrimitive.Title>
        <DialogPrimitive.Description className="mt-1 text-xs text-muted-foreground">
          {showSkeleton || isMissing
            ? title
            : `${formatPlainNumber(total)} ta mahsulot · ${title}`}
        </DialogPrimitive.Description>

        {!isMissing && (
          <div className="relative mt-3">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Mahsulot nomi bo'yicha qidirish…"
              aria-label="Mahsulot nomi bo'yicha qidirish"
              className="pl-9"
            />
          </div>
        )}
      </header>

      {/* Scrollable body — the full list can run to ~200 rows. */}
      <div className="flex-1 overflow-y-auto p-5" data-testid="top-products-sheet-body">
        {showSkeleton ? (
          <ul
            className="animate-pulse space-y-3.5"
            data-testid="top-products-sheet-skeleton"
            aria-hidden="true"
          >
            {Array.from({ length: 12 }).map((_, i) => (
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
        ) : isMissing ? (
          <p
            className="rounded-lg border border-border/60 bg-surface-3 px-3 py-2 text-xs text-muted-foreground"
            role="note"
          >
            {"Sotuv ma'lumotlari tayyor emas."}
          </p>
        ) : total === 0 ? (
          <p
            className="rounded-lg border border-border/60 bg-surface-3 px-3 py-6 text-center text-sm text-muted-foreground"
            role="note"
          >
            Ma&apos;lumot yo&apos;q
          </p>
        ) : filtered.length === 0 ? (
          <p
            className="rounded-lg border border-border/60 bg-surface-3 px-3 py-6 text-center text-sm text-muted-foreground"
            role="note"
          >
            Mos mahsulot topilmadi
          </p>
        ) : (
          <ol
            className="space-y-3.5 animate-in fade-in duration-300"
            data-testid="top-products-sheet-list"
          >
            {filtered.map(({ row, rank }) => (
              <TopProductRow
                key={row.product_id}
                row={row}
                rank={rank}
                maxRevenue={maxRevenue}
              />
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
