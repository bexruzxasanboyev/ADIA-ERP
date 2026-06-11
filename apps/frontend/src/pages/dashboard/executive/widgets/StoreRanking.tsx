import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/PageState';
import {
  dateRangeToQuery,
  type DateRangeValue,
} from '@/components/DateRangeFilter';
import { useApiQuery } from '@/hooks/useApiQuery';
import { formatCurrencyCompact, formatQty } from '@/lib/format';
import type { DashboardStoresDetail } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * Variant C — store sales ranking.
 *
 * Lists every visible store sorted by today's `sales_sum` (descending).
 * Each row carries a mini progress bar normalised to the top store, so
 * the boshliq can see the spread at a glance. Source: `GET /api/dashboard/stores`.
 */
export interface StoreRankingProps {
  range: DateRangeValue;
}

export function StoreRanking({ range }: StoreRankingProps) {
  const query = dateRangeToQuery(range);
  const { data, isLoading, error, refetch } =
    useApiQuery<DashboardStoresDetail>(`/api/dashboard/stores?${query}`);

  return (
    <Card
      className="flex flex-col gap-3 p-4"
      role="region"
      aria-labelledby="store-ranking-title"
      data-testid="store-ranking"
    >
      <header className="flex items-baseline justify-between gap-3">
        <h2
          id="store-ranking-title"
          className="text-sm font-semibold text-foreground"
        >
          Do'konlar reytingi — bugun
        </h2>
        <p className="text-xs text-muted-foreground tabular-nums">
          {data ? `${data.store_breakdown.length} do'kon` : '—'}
        </p>
      </header>

      {isLoading && data === null ? (
        <ListSkeleton />
      ) : error && data === null ? (
        <ErrorState message={error} onRetry={refetch} />
      ) : data === null || data.store_breakdown.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground">
          Do'kon yo'q.
        </p>
      ) : (
        <StoreRankingView data={data} />
      )}
    </Card>
  );
}

export function StoreRankingView({ data }: { data: DashboardStoresDetail }) {
  const ordered = [...data.store_breakdown].sort(
    (a, b) => b.sales_sum - a.sales_sum,
  );
  const max = ordered.length > 0 ? (ordered[0]?.sales_sum ?? 1) : 1;

  return (
    <ul className="flex flex-col gap-1.5" data-testid="store-ranking-rows">
      {ordered.map((store, idx) => {
        const pct = Math.min(
          100,
          Math.max(0, max > 0 ? (store.sales_sum / max) * 100 : 0),
        );
        return (
          <li
            key={store.location_id}
            className="relative flex items-center gap-2 overflow-hidden rounded-md bg-surface-2/50 px-3 py-1.5"
          >
            <span
              aria-hidden="true"
              className="absolute inset-y-0 left-0 rounded-md bg-chain-store/40"
              style={{ width: `${pct}%` }}
            />
            <span
              className={cn(
                'relative z-10 shrink-0 text-[10px] font-semibold uppercase tracking-wider tabular-nums',
                idx === 0 ? 'text-chain-store' : 'text-muted-foreground',
              )}
            >
              #{idx + 1}
            </span>
            <span className="relative z-10 min-w-0 flex-1 truncate text-xs font-medium text-foreground">
              {store.location_name}
            </span>
            <span className="relative z-10 shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {formatQty(store.sales_count)} chek
            </span>
            <span className="relative z-10 shrink-0 text-xs tabular-nums text-foreground">
              {formatCurrencyCompact(store.sales_sum)}
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
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="h-8 w-full animate-pulse rounded-md bg-surface-2/40"
        />
      ))}
    </div>
  );
}
