import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/PageState';
import {
  dateRangeToQuery,
  type DateRangeValue,
} from '@/components/DateRangeFilter';
import { useApiQuery } from '@/hooks/useApiQuery';
import { formatCurrencyCompact } from '@/lib/format';
import type { DashboardStoresDetail } from '@/lib/types';

/**
 * Variant C — top sold products today (revenue ranking).
 *
 * Data: `GET /api/dashboard/stores`.`top_products_today` — the same
 * payload as the Stores drawer. Reuses `BlockBarList` (chain-store tone)
 * for a horizontal bar list capped at the top 5.
 */
export interface TopProductsListProps {
  range: DateRangeValue;
}

export function TopProductsList({ range }: TopProductsListProps) {
  const query = dateRangeToQuery(range);
  const { data, isLoading, error, refetch } =
    useApiQuery<DashboardStoresDetail>(`/api/dashboard/stores?${query}`);

  return (
    <Card
      className="flex flex-col gap-3 p-4"
      role="region"
      aria-labelledby="top-products-title"
      data-testid="top-products-list"
    >
      <header className="flex items-baseline justify-between gap-3">
        <h2
          id="top-products-title"
          className="text-sm font-semibold text-foreground"
        >
          Eng faol mahsulot — bugun
        </h2>
        <p className="text-xs text-muted-foreground">Top 5</p>
      </header>

      {isLoading && data === null ? (
        <ListSkeleton />
      ) : error && data === null ? (
        <ErrorState message={error} onRetry={refetch} />
      ) : data === null || data.top_products_today.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground">
          Bugun savdo yo'q.
        </p>
      ) : (
        <TopProductsListView data={data} />
      )}
    </Card>
  );
}

export function TopProductsListView({
  data,
}: {
  data: DashboardStoresDetail;
}) {
  const top = data.top_products_today.slice(0, 5);
  // Pre-formatted captions don't help with `BlockBarList` directly —
  // it runs its own `formatQty` on the raw value. We hand-roll an
  // equivalent row here so revenue renders via `formatCurrencyCompact`.
  const max =
    top.length > 0 ? Math.max(...top.map((r) => r.revenue)) : 1;

  return (
    <ul className="flex flex-col gap-1.5" data-testid="top-products-rows">
      {top.map((row) => {
        const pct = Math.min(
          100,
          Math.max(0, max > 0 ? (row.revenue / max) * 100 : 0),
        );
        return (
          <li
            key={row.product_id}
            className="relative flex items-center gap-2 overflow-hidden rounded-md bg-surface-2/50 px-3 py-1.5"
          >
            <span
              aria-hidden="true"
              className="absolute inset-y-0 left-0 rounded-md bg-chain-store/55"
              style={{ width: `${pct}%` }}
            />
            <span className="relative z-10 min-w-0 flex-1 truncate text-xs font-medium text-foreground">
              {row.product_name}
            </span>
            <span className="relative z-10 shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {row.qty.toLocaleString('uz-UZ')} {row.unit}
            </span>
            <span className="relative z-10 shrink-0 text-xs tabular-nums text-foreground">
              {formatCurrencyCompact(row.revenue)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-1.5">
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={i}
          className="h-8 w-full animate-pulse rounded-md bg-surface-2/40"
        />
      ))}
    </div>
  );
}
