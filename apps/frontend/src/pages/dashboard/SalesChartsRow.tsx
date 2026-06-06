import { useState } from 'react';
import { SalesChart } from './SalesChart';
import { Select } from '@/components/ui/select';
import {
  dateRangeToQuery,
  type DateRangeValue,
} from '@/components/DateRangeFilter';
import { useApiQuery } from '@/hooks/useApiQuery';
import { formatQty, formatCurrencyCompact, formatSom } from '@/lib/format';
import type {
  DashboardChartGranularity,
  DashboardSalesBreakdown,
  DashboardSalesBreakdownBy,
  DashboardSalesPoint,
} from '@/lib/types';

/**
 * Two sales charts side by side: sold volume (qty) on the left and sale
 * revenue (amount, so'm) on the right. Both read the same `sales_chart.days`
 * series. Stacks vertically on small screens.
 *
 * When the dashboard date-range is "Bugun" the backend returns HOURLY buckets
 * (`granularity: 'hour'`) and the x-axis labels become `HH:00`; for every
 * other range the series is day-bucketed and labelled `DD.MM`. The card titles
 * follow suit so they don't claim "30 kun" on an hourly view.
 *
 * The revenue axis/tooltip use the compact so'm formatter so large totals
 * read at a glance (e.g. "10.9mlrd"); the header `Jami` shows the full
 * so'm value via `formatSom`.
 */
export function SalesChartsRow({
  days,
  granularity = 'day',
  range,
  loading = false,
}: {
  days: DashboardSalesPoint[];
  granularity?: DashboardChartGranularity;
  /**
   * Active dashboard date-range filter. Drives the breakdown fetch so the
   * tooltip items follow the selected period (and hourly vs daily matching).
   * Optional so legacy call-sites / tests without a range simply render the
   * charts with the fallback (simple) tooltip.
   */
  range?: DateRangeValue;
  /**
   * When `true`, both charts render their own in-card skeleton instead of the
   * series — used while the parent's ecosystem query is still loading so the
   * charts don't pop in late after the page skeleton disappears. The breakdown
   * select stays visible; only the two chart bodies show their shimmer.
   */
  loading?: boolean;
}) {
  const isHourly = granularity === 'hour';
  const periodLabel = isHourly ? 'bugun' : '30 kun';

  // Dimension the tooltip itemization is sliced by. Lives here so BOTH charts
  // share one select and one fetch.
  const [by, setBy] = useState<DashboardSalesBreakdownBy>('product');

  // Fetch the itemized breakdown for the current range + dimension. Skipped
  // (null path) when no range is supplied — the charts then fall back to the
  // simple tooltip. Errors degrade gracefully: `data` stays null and the
  // tooltip falls back, so a missing/late endpoint never breaks the charts.
  const breakdownQuery = useApiQuery<DashboardSalesBreakdown>(
    range
      ? `/api/dashboard/sales-breakdown?${dateRangeToQuery(range)}&by=${by}&limit=6`
      : null,
  );
  const buckets = breakdownQuery.data?.buckets;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end gap-2">
        <label
          htmlFor="sales-breakdown-by"
          className="text-xs font-medium text-muted-foreground"
        >
          Kesim:
        </label>
        <Select
          id="sales-breakdown-by"
          value={by}
          onChange={(e) => setBy(e.target.value as DashboardSalesBreakdownBy)}
          className="h-8 w-auto min-w-[12rem] text-xs"
          aria-label="Tooltip kesimi"
        >
          <option value="product">Mahsulot bo‘yicha</option>
          <option value="payment">To‘lov usuli bo‘yicha</option>
        </Select>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SalesChart
          points={days}
          granularity={granularity}
          breakdown={buckets}
          loading={loading}
          title={`Sotuv soni — ${periodLabel}`}
          description={
            isHourly
              ? 'Bugun soatlar bo‘yicha sotilgan miqdor.'
              : 'Oxirgi 30 kun davomida sotilgan miqdor.'
          }
          dataKey="qty"
          valueFormatter={formatQty}
          tooltipLabel="Soni"
          accent="primary"
        />
        <SalesChart
          points={days}
          granularity={granularity}
          breakdown={buckets}
          loading={loading}
          title={`Sotuv summasi — ${periodLabel}`}
          description={
            isHourly
              ? 'Bugun soatlar bo‘yicha savdo summasi (so‘m).'
              : 'Oxirgi 30 kun davomidagi savdo summasi (so‘m).'
          }
          dataKey="amount"
          valueFormatter={formatCurrencyCompact}
          totalFormatter={formatSom}
          tooltipLabel="Summa"
          accent="success"
        />
      </div>
    </div>
  );
}
