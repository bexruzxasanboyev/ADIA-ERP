import { useMemo, useState } from 'react';
import {
  ArrowDownRight,
  ArrowUpDown,
  ArrowUpRight,
  Coins,
  Minus,
  Pencil,
  Target,
  TrendingUp,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from '@/components/PageState';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useAuth } from '@/hooks/useAuth';
import { formatPlainNumber, todayIso } from '@/lib/format';
import { cn } from '@/lib/utils';
import { SELLER_KPI_LABELS } from '@/lib/labels';
import type { Location, SellerKpiItem, SellerKpiResponse } from '@/lib/types';
import {
  SellerKpiPlanDialog,
  type SellerKpiPlanTarget,
} from './SellerKpiPlanDialog';

/** Current month as `YYYY-MM` (local timezone). */
function currentMonth(): string {
  return todayIso().slice(0, 7);
}

/**
 * Money display for the KPI table/cards — whole so'm with space grouping
 * ("1 000 000"), no suffix; `null`/non-finite → em-dash.
 */
function money(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—';
  }
  return formatPlainNumber(value);
}

/** Format a percentage to one decimal, or em-dash when unknown. */
function pct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—';
  }
  return `${value.toFixed(1)}%`;
}

/** Achievement tier → shadcn Badge variant: ≥100 green, 70–99 amber, <70 red. */
function achievementVariant(value: number): BadgeProps['variant'] {
  if (value >= 100) return 'success';
  if (value >= 70) return 'warning';
  return 'danger';
}

/** The two sortable columns. */
type SortKey = 'actual_sum' | 'achievement_pct';

/** One summary metric in the top strip. */
function SummaryCard({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Coins;
  label: string;
  value: string;
}) {
  return (
    <Card className="flex items-center gap-3 p-4">
      <span
        className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary"
        aria-hidden="true"
      >
        <Icon className="size-5" />
      </span>
      <div className="min-w-0">
        <p className="truncate text-xs text-muted-foreground">{label}</p>
        <p className="truncate text-lg font-semibold tabular-nums">{value}</p>
      </div>
    </Card>
  );
}

/** Month-over-month growth cell — ▲ green / ▼ red / — neutral. */
function GrowthCell({ value }: { value: number | null }) {
  if (value === null || !Number.isFinite(value)) {
    return <span className="text-muted-foreground">—</span>;
  }
  if (value > 0) {
    return (
      <span className="inline-flex items-center justify-end gap-1 font-medium text-emerald-600 dark:text-emerald-400">
        <ArrowUpRight className="size-3.5" aria-hidden="true" />
        {pct(value)}
      </span>
    );
  }
  if (value < 0) {
    return (
      <span className="inline-flex items-center justify-end gap-1 font-medium text-destructive">
        <ArrowDownRight className="size-3.5" aria-hidden="true" />
        {pct(value)}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center justify-end gap-1 text-muted-foreground">
      <Minus className="size-3.5" aria-hidden="true" />
      0%
    </span>
  );
}

/**
 * Sotuvchi KPI — seller-level monthly sales plan vs actual (TZ Module 8).
 *
 * For the selected month, shows every seller ranked by actual sales against
 * their monthly plan: plan, actual, achievement % (colour-coded badge) and the
 * month-over-month growth. The PM (boshliq) can set a seller's monthly plan
 * (so'm) inline and filter by store; the store manager sees the same table
 * read-only (the backend RBAC-scopes the rows to their own store's sellers).
 *
 * Mirrors {@link import('./StoreKpiPage').StoreKpiPage} one level deeper — per
 * seller instead of per store; there is no expandable per-seller trend (not in
 * the seller-KPI contract).
 */
export function SellerKpiPage() {
  const { user } = useAuth();
  const isPm = user?.role === 'pm';

  const [month, setMonth] = useState<string>(currentMonth());
  // PM-only store filter; '' means "all stores" (no `store_id` query param).
  const [storeId, setStoreId] = useState<string>('');
  const [sortKey, setSortKey] = useState<SortKey>('actual_sum');
  const [editingPlan, setEditingPlan] = useState<SellerKpiPlanTarget | null>(
    null,
  );

  // Store list for the PM filter. Skipped (null path) for non-PM roles, whose
  // rows are already RBAC-scoped to their own store server-side.
  const stores = useApiQuery<Location[]>(
    isPm ? '/api/locations?type=store' : null,
  );

  // Stable query key per (month, store) so the SWR cache buckets correctly.
  const kpiPath = useMemo(() => {
    const params = new URLSearchParams({ month });
    if (isPm && storeId) params.set('store_id', storeId);
    return `/api/seller-kpi?${params.toString()}`;
  }, [month, storeId, isPm]);

  const kpi = useApiQuery<SellerKpiResponse>(kpiPath);

  const summary = kpi.data?.summary;
  const items = useMemo(() => kpi.data?.items ?? [], [kpi.data]);

  // Client-side sort; the backend already ranks by actual_sum, but the boss
  // can flip to achievement %. `rank` stays the server's actual-sum rank.
  const rows = useMemo(() => {
    const copy = [...items];
    copy.sort((a, b) => {
      if (sortKey === 'achievement_pct') {
        // Sellers with no target sink to the bottom of an achievement sort.
        const av = a.achievement_pct ?? -1;
        const bv = b.achievement_pct ?? -1;
        return bv - av;
      }
      return b.actual_sum - a.actual_sum;
    });
    return copy;
  }, [items, sortKey]);

  function toggleSort(key: SortKey) {
    setSortKey(key);
  }

  return (
    <div className="mx-auto max-w-[120rem] space-y-6">
      <PageHeader
        title={SELLER_KPI_LABELS.title}
        description={SELLER_KPI_LABELS.description}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {isPm && (
              <Select
                value={storeId}
                onChange={(e) => setStoreId(e.target.value)}
                aria-label={SELLER_KPI_LABELS.storeFilterLabel}
                className="w-[12rem]"
              >
                <option value="">{SELLER_KPI_LABELS.allStores}</option>
                {(stores.data ?? []).map((store) => (
                  <option key={store.id} value={String(store.id)}>
                    {store.name}
                  </option>
                ))}
              </Select>
            )}
            <Input
              type="month"
              value={month}
              max={currentMonth()}
              onChange={(e) => setMonth(e.target.value || currentMonth())}
              aria-label={SELLER_KPI_LABELS.monthLabel}
              className="w-[10.5rem]"
            />
          </div>
        }
      />

      {/* Summary strip — in-scope plan / actual / achievement. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <SummaryCard
          icon={Target}
          label={SELLER_KPI_LABELS.totalTarget}
          value={summary ? money(summary.total_target) : '—'}
        />
        <SummaryCard
          icon={Coins}
          label={SELLER_KPI_LABELS.totalActual}
          value={summary ? money(summary.total_actual) : '—'}
        />
        <SummaryCard
          icon={TrendingUp}
          label={SELLER_KPI_LABELS.totalAchievement}
          value={summary ? pct(summary.achievement_pct) : '—'}
        />
      </div>

      <Card className="p-0">
        {kpi.isLoading && <LoadingState />}
        {!kpi.isLoading && kpi.error && (
          <ErrorState message={kpi.error} onRetry={kpi.refetch} />
        )}
        {!kpi.isLoading && !kpi.error && rows.length === 0 && (
          <EmptyState message={SELLER_KPI_LABELS.empty} />
        )}

        {!kpi.isLoading && !kpi.error && rows.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-16 text-right">
                  {SELLER_KPI_LABELS.colRank}
                </TableHead>
                <TableHead>{SELLER_KPI_LABELS.colSeller}</TableHead>
                <TableHead>{SELLER_KPI_LABELS.colStore}</TableHead>
                <TableHead className="text-right">
                  {SELLER_KPI_LABELS.colPlan}
                </TableHead>
                <TableHead className="text-right">
                  <SortHeader
                    label={SELLER_KPI_LABELS.colActual}
                    active={sortKey === 'actual_sum'}
                    onClick={() => toggleSort('actual_sum')}
                  />
                </TableHead>
                <TableHead className="text-right">
                  <SortHeader
                    label={SELLER_KPI_LABELS.colAchievement}
                    active={sortKey === 'achievement_pct'}
                    onClick={() => toggleSort('achievement_pct')}
                  />
                </TableHead>
                <TableHead className="text-right">
                  {SELLER_KPI_LABELS.colGrowth}
                </TableHead>
                {isPm && (
                  <TableHead className="w-px text-right">
                    {SELLER_KPI_LABELS.colAction}
                  </TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.seller_id}>
                  <TableCell className="text-right font-semibold tabular-nums">
                    {formatPlainNumber(row.rank)}
                  </TableCell>
                  <TableCell className="font-medium">{row.name}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {row.store_name}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {money(row.target_sum)}
                  </TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">
                    {money(row.actual_sum)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.achievement_pct === null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <Badge
                        variant={achievementVariant(row.achievement_pct)}
                        className="tabular-nums"
                      >
                        {pct(row.achievement_pct)}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    <GrowthCell value={row.growth_pct_mom} />
                  </TableCell>
                  {isPm && (
                    <TableCell className="text-right">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setEditingPlan(toPlanTarget(row, month))}
                      >
                        <Pencil className="size-3.5" aria-hidden="true" />
                        {SELLER_KPI_LABELS.setPlan}
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {isPm && (
        <SellerKpiPlanDialog
          target={editingPlan}
          onOpenChange={(open) => {
            if (!open) setEditingPlan(null);
          }}
          onSaved={kpi.refetch}
        />
      )}
    </div>
  );
}

/** A sortable column header — label + arrows, highlights when active. */
function SortHeader({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex items-center gap-1 font-medium transition-colors hover:text-foreground',
        active ? 'text-foreground' : 'text-muted-foreground',
      )}
    >
      {label}
      <ArrowUpDown
        className={cn('size-3.5', active ? 'opacity-100' : 'opacity-40')}
        aria-hidden="true"
      />
    </button>
  );
}

/** Build a plan-dialog target from a KPI row + the selected month. */
function toPlanTarget(row: SellerKpiItem, month: string): SellerKpiPlanTarget {
  return {
    seller_id: row.seller_id,
    name: row.name,
    month,
    value: row.target_sum,
  };
}
