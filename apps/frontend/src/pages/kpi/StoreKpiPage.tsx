import { Fragment, useMemo, useState } from 'react';
import {
  ArrowDownRight,
  ArrowUpDown,
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
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
import type { StoreKpiItem, StoreKpiResponse } from '@/lib/types';
import { StoreKpiPlanDialog, type StoreKpiPlanTarget } from './StoreKpiPlanDialog';
import { StoreKpiTrendChart } from './StoreKpiTrendChart';

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
        <p className="truncate text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
        <p className="truncate text-2xl font-semibold tabular-nums tracking-tight">{value}</p>
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
      <span className="inline-flex items-center justify-end gap-1 font-medium text-success">
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
 * Do'kon KPI — store-level monthly sales plan vs actual (TZ Module 8).
 *
 * For the selected month, shows every store ranked by actual sales against
 * its monthly plan: plan, actual, achievement % (colour-coded badge) and the
 * month-over-month growth. The PM (boshliq) can set a store's monthly plan
 * (so'm) inline; the store manager sees the same table read-only (the backend
 * RBAC-scopes the rows to their own store). Expanding a row reveals that
 * store's monthly sales trend (Recharts).
 */
export function StoreKpiPage() {
  const { user } = useAuth();
  const isPm = user?.role === 'pm';

  const [month, setMonth] = useState<string>(currentMonth());
  const [sortKey, setSortKey] = useState<SortKey>('actual_sum');
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [editingPlan, setEditingPlan] = useState<StoreKpiPlanTarget | null>(
    null,
  );

  const kpi = useApiQuery<StoreKpiResponse>(`/api/store-kpi?month=${month}`);

  const summary = kpi.data?.summary;
  const items = useMemo(() => kpi.data?.items ?? [], [kpi.data]);

  // Client-side sort; the backend already ranks by actual_sum, but the boss
  // can flip to achievement %. `rank` stays the server's actual-sum rank.
  const rows = useMemo(() => {
    const copy = [...items];
    copy.sort((a, b) => {
      if (sortKey === 'achievement_pct') {
        // Stores with no target sink to the bottom of an achievement sort.
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

  function toggleExpand(locationId: number) {
    setExpandedId((prev) => (prev === locationId ? null : locationId));
  }

  return (
    <div className="mx-auto max-w-[120rem] space-y-6">
      <PageHeader
        title="Do‘kon KPI"
        description="Har bir do‘konning oylik sotuv rejasi va haqiqiy sotuviga nisbatan bajarilishi. Reyting, o‘sish dinamikasi va reja boshqaruvi."
        actions={
          <Input
            type="month"
            value={month}
            max={currentMonth()}
            onChange={(e) => setMonth(e.target.value || currentMonth())}
            aria-label="Oyni tanlash"
            className="w-[10.5rem]"
          />
        }
      />

      {/* Summary strip — chain-wide plan / actual / achievement. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <SummaryCard
          icon={Target}
          label="Jami reja (so‘m)"
          value={summary ? money(summary.total_target) : '—'}
        />
        <SummaryCard
          icon={Coins}
          label="Jami haqiqiy (so‘m)"
          value={summary ? money(summary.total_actual) : '—'}
        />
        <SummaryCard
          icon={TrendingUp}
          label="Umumiy bajarilish"
          value={summary ? pct(summary.achievement_pct) : '—'}
        />
      </div>

      <Card className="p-0">
        {kpi.isLoading && <LoadingState />}
        {!kpi.isLoading && kpi.error && (
          <ErrorState message={kpi.error} onRetry={kpi.refetch} />
        )}
        {!kpi.isLoading && !kpi.error && rows.length === 0 && (
          <EmptyState message="Ma’lumot yo‘q" />
        )}

        {!kpi.isLoading && !kpi.error && rows.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10" aria-label="Yoyish" />
                <TableHead className="w-16 text-right">Reyting</TableHead>
                <TableHead>Do‘kon</TableHead>
                <TableHead className="text-right">Plan</TableHead>
                <TableHead className="text-right">
                  <SortHeader
                    label="Haqiqiy"
                    active={sortKey === 'actual_sum'}
                    onClick={() => toggleSort('actual_sum')}
                  />
                </TableHead>
                <TableHead className="text-right">
                  <SortHeader
                    label="Bajarilish %"
                    active={sortKey === 'achievement_pct'}
                    onClick={() => toggleSort('achievement_pct')}
                  />
                </TableHead>
                <TableHead className="text-right">O‘sish</TableHead>
                {isPm && (
                  <TableHead className="w-px text-right">Amal</TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const expanded = expandedId === row.location_id;
                return (
                  <Fragment key={row.location_id}>
                    <TableRow
                      className="cursor-pointer"
                      onClick={() => toggleExpand(row.location_id)}
                    >
                      <TableCell className="text-muted-foreground">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          aria-expanded={expanded}
                          aria-label={
                            expanded
                              ? `${row.location_name} dinamikasini yopish`
                              : `${row.location_name} dinamikasini ko‘rish`
                          }
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleExpand(row.location_id);
                          }}
                        >
                          {expanded ? (
                            <ChevronDown className="size-4" aria-hidden="true" />
                          ) : (
                            <ChevronRight
                              className="size-4"
                              aria-hidden="true"
                            />
                          )}
                        </Button>
                      </TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">
                        {formatPlainNumber(row.rank)}
                      </TableCell>
                      <TableCell className="font-medium">
                        {row.location_name}
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
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditingPlan(toPlanTarget(row, month));
                            }}
                          >
                            <Pencil className="size-3.5" aria-hidden="true" />
                            Plan belgilash
                          </Button>
                        </TableCell>
                      )}
                    </TableRow>

                    {expanded && (
                      <TableRow className="hover:bg-transparent">
                        <TableCell
                          colSpan={isPm ? 8 : 7}
                          className="bg-muted/30 p-4"
                        >
                          <StoreKpiTrendChart
                            locationId={row.location_id}
                            locationName={row.location_name}
                          />
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>

      {isPm && (
        <StoreKpiPlanDialog
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
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        '-mx-2 h-7 gap-1 px-2',
        active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {label}
      <ArrowUpDown
        className={cn('size-3.5', active ? 'opacity-100' : 'opacity-40')}
        aria-hidden="true"
      />
    </Button>
  );
}

/** Build a plan-dialog target from a KPI row + the selected month. */
function toPlanTarget(row: StoreKpiItem, month: string): StoreKpiPlanTarget {
  return {
    location_id: row.location_id,
    location_name: row.location_name,
    month,
    value: row.target_sum,
  };
}
