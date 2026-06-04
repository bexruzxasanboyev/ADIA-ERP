import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Loader2, ReceiptText } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from '@/components/PageState';
import {
  DateRangeFilter,
  dateRangeToQuery,
  type DateRangeValue,
} from '@/components/DateRangeFilter';
import { ApiError, apiRequest } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { formatQty, formatSom, formatDateTime } from '@/lib/format';
import { UNIT_LABELS } from '@/lib/labels';
import type { ReceiptsStockResponse, ReceiptWithStock } from '@/lib/types';

/** Cheques fetched per scroll page. */
const PAGE_SIZE = 50;

/**
 * EPIC 8.2 / 8.3 — kassa cheklari bo'yicha ostatka.
 *
 * Har chek bo'yicha: Ost (boshlang'ich) − sotildi − qoldi. Agar kassada
 * bazadagidan ko'p urilsa (ost 10 − sotildi 11 = −1) — "fors-major /
 * noto'g'ri urilgan" holat: chek qizil bilan belgilanadi va ogohlantiriladi
 * (8.3). Ostatka real bazada hech qachon manfiy bo'lmaydi (invariant 3) —
 * bu faqat hisobot signali.
 *
 * Backend: `GET /api/sales/receipts/stock` (EPIC 8.2 — chek-darajali
 * ost−sotildi−qoldi) is live; an empty window simply renders the
 * no-receipts empty-state.
 */
export function ReceiptsPage() {
  // Date-range filter — the backend `/api/sales/receipts/stock` endpoint
  // accepts ?range=today|week|month|6m|custom (default today), so the cashier
  // can browse cheques for any day, not just the current one.
  const [range, setRange] = useState<DateRangeValue>({ range: 'today' });
  const [onlyForceMajeure, setOnlyForceMajeure] = useState(false);

  // Manual infinite-scroll pagination state. `useApiQuery` is single-shot
  // (one fetch per path), so it can't accumulate pages — we drive the
  // fetches by hand, accumulating `items` across pages and tracking the
  // server-reported `total`.
  const [items, setItems] = useState<ReceiptWithStock[]>([]);
  const [total, setTotal] = useState(0);
  // Distinguish the very first page (drives LoadingState / ErrorState) from
  // subsequent "load more" pages (drive the small bottom indicator).
  const [isLoadingFirst, setIsLoadingFirst] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  // Live count of accumulated cheques — read inside the IntersectionObserver
  // callback (which closes over a stale render) without re-creating the
  // observer on every append.
  const loadedCountRef = useRef(0);
  const totalRef = useRef(0);
  // Single-flight guard: blocks duplicate concurrent / re-entrant fetches.
  const isFetchingRef = useRef(false);
  // Next page offset to request.
  const offsetRef = useRef(0);
  // Aborts the in-flight request on unmount or range change.
  const abortRef = useRef<AbortController | null>(null);

  const serializedRange = dateRangeToQuery(range);

  /**
   * Fetch a single page and append it. `reset === true` starts a fresh
   * accumulation (first page after mount or a range change); otherwise it
   * appends the next page. Guarded by `isFetchingRef` so overlapping
   * scroll events / resets can't issue duplicate requests.
   */
  const fetchPage = useCallback(
    async (reset: boolean) => {
      if (isFetchingRef.current) return;
      isFetchingRef.current = true;

      // Cancel any previous in-flight request before starting a new one.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const offset = reset ? 0 : offsetRef.current;
      if (reset) {
        setIsLoadingFirst(true);
        setError(null);
      } else {
        setIsLoadingMore(true);
      }

      try {
        const res = await apiRequest<ReceiptsStockResponse>(
          `/api/sales/receipts/stock?${serializedRange}&limit=${PAGE_SIZE}&offset=${offset}`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;

        const pageItems = res.items ?? [];
        offsetRef.current = offset + pageItems.length;
        totalRef.current = res.total;
        setTotal(res.total);

        if (reset) {
          loadedCountRef.current = pageItems.length;
          setItems(pageItems);
        } else {
          loadedCountRef.current += pageItems.length;
          setItems((prev) => [...prev, ...pageItems]);
        }
      } catch (err: unknown) {
        if (controller.signal.aborted) return;
        const message =
          err instanceof ApiError ? err.message : 'Ma’lumotni yuklab bo‘lmadi.';
        // Only the first page surfaces a blocking error state; a failed
        // "load more" leaves the already-loaded cheques visible.
        if (reset) setError(message);
      } finally {
        if (!controller.signal.aborted) {
          if (reset) setIsLoadingFirst(false);
          else setIsLoadingMore(false);
        }
        isFetchingRef.current = false;
      }
    },
    [serializedRange],
  );

  // Reset + refetch the first page on mount and whenever the date range
  // changes. The serialized range is the simplest reset key.
  useEffect(() => {
    loadedCountRef.current = 0;
    totalRef.current = 0;
    offsetRef.current = 0;
    setItems([]);
    setTotal(0);
    void fetchPage(true);
    return () => abortRef.current?.abort();
  }, [fetchPage]);

  // Auto-load the next page when the sentinel scrolls into view, while
  // there are still unfetched cheques and nothing is in flight.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (sentinel === null) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry === undefined || !entry.isIntersecting) return;
        if (isFetchingRef.current) return;
        if (loadedCountRef.current >= totalRef.current) return;
        void fetchPage(false);
      },
      { rootMargin: '200px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [fetchPage]);

  const refetch = useCallback(() => void fetchPage(true), [fetchPage]);

  // Fors-major count + filter operate on the ACCUMULATED loaded cheques
  // (only the pages fetched so far), not the full server-side range.
  const forceMajeureCount = useMemo(
    () => items.filter((r) => r.has_force_majeure).length,
    [items],
  );

  const rows = useMemo<ReceiptWithStock[]>(
    () => (onlyForceMajeure ? items.filter((r) => r.has_force_majeure) : items),
    [items, onlyForceMajeure],
  );

  const loadedCount = items.length;
  const allLoaded = loadedCount >= total;

  return (
    <div className="mx-auto max-w-[120rem] space-y-6">
      <PageHeader
        title="Kassa cheklari"
        description="Har chek bo‘yicha ostatka: ost − sotildi − qoldi. Manfiy qoldiq — noto‘g‘ri urilgan chek (fors-major)."
        actions={<DateRangeFilter value={range} onChange={setRange} />}
      />

      {/* Fors-major summary + toggle. Reflects loaded cheques only. */}
      {!isLoadingFirst && !error && items.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          {forceMajeureCount > 0 ? (
            <button
              type="button"
              onClick={() => setOnlyForceMajeure((v) => !v)}
              aria-pressed={onlyForceMajeure}
              className={cn(
                'inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                onlyForceMajeure
                  ? 'border-destructive bg-destructive/15 text-destructive'
                  : 'border-destructive/40 text-destructive hover:bg-destructive/10',
              )}
            >
              <AlertTriangle className="size-4" aria-hidden="true" />
              {forceMajeureCount} ta noto‘g‘ri urilgan chek
              {onlyForceMajeure ? ' — barchasini ko‘rsatish' : ''}
            </button>
          ) : (
            <Badge variant="secondary">Barcha cheklar to‘g‘ri urilgan</Badge>
          )}
        </div>
      )}

      {isLoadingFirst && (
        <Card>
          <LoadingState />
        </Card>
      )}

      {!isLoadingFirst && error && (
        <Card>
          <ErrorState message={error} onRetry={refetch} />
        </Card>
      )}

      {!isLoadingFirst && !error && rows.length === 0 && (
        <Card>
          <EmptyState message="Cheklar topilmadi." />
        </Card>
      )}

      {!isLoadingFirst && !error && rows.length > 0 && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {rows.map((r) => (
            <ReceiptCard key={`${r.poster_transaction_id}-${r.store_id}`} receipt={r} />
          ))}
        </div>
      )}

      {/* Infinite-scroll sentinel + bottom indicators. The observer watches
          this div; it stays mounted (under the list) so scrolling near the
          bottom triggers the next page. */}
      {!isLoadingFirst && !error && (
        <div ref={sentinelRef} aria-hidden={!isLoadingMore}>
          {isLoadingMore && (
            <div
              className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground"
              role="status"
            >
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              Yana yuklanmoqda…
            </div>
          )}
          {!isLoadingMore && allLoaded && loadedCount > 0 && (
            <p className="py-4 text-center text-xs text-muted-foreground">
              Barchasi yuklandi — {loadedCount} ta chek
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function ReceiptCard({ receipt }: { receipt: ReceiptWithStock }) {
  return (
    <article
      className={cn(
        'space-y-3 rounded-lg border bg-card/50 p-4',
        receipt.has_force_majeure
          ? 'border-destructive/50 bg-destructive/5'
          : 'border-border/60',
      )}
      aria-label={`Chek #${receipt.poster_transaction_id}`}
    >
      <header className="flex items-start justify-between gap-3 border-b border-border/40 pb-2">
        <div className="flex items-start gap-2">
          <ReceiptText
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p className="text-sm font-semibold">
              Chek #{receipt.poster_transaction_id}
            </p>
            <p className="text-xs text-muted-foreground">
              {receipt.store_name} · {formatDateTime(receipt.sold_at)}
            </p>
          </div>
        </div>
        <div className="text-right">
          <p className="text-sm font-semibold tabular-nums">
            {formatSom(receipt.total_revenue)}
          </p>
          {receipt.has_force_majeure && (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-destructive">
              <AlertTriangle className="size-3" aria-hidden="true" />
              Fors-major
            </span>
          )}
        </div>
      </header>

      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th className="pb-1 font-medium">Mahsulot</th>
            <th className="pb-1 text-right font-medium">Ost</th>
            <th className="pb-1 text-right font-medium">Sotildi</th>
            <th className="pb-1 text-right font-medium">Qoldi</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/30">
          {receipt.lines.map((line) => {
            const over = line.remaining_qty < 0;
            const unit = UNIT_LABELS[line.product_unit];
            return (
              <tr key={line.product_id}>
                <td className="py-1.5 pr-2">
                  <span className="block truncate">{line.product_name}</span>
                </td>
                <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                  {formatQty(line.opening_qty)} {unit}
                </td>
                <td className="py-1.5 text-right tabular-nums">
                  {formatQty(line.sold_qty)} {unit}
                </td>
                <td
                  className={cn(
                    'py-1.5 text-right font-medium tabular-nums',
                    over && 'text-destructive',
                  )}
                >
                  {formatQty(line.remaining_qty)} {unit}
                  {over && (
                    <span className="sr-only"> — noto‘g‘ri urilgan</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </article>
  );
}
