import { SalesChart } from './SalesChart';
import { formatQty, formatCurrencyCompact, formatSom } from '@/lib/format';
import type { DashboardSalesPoint } from '@/lib/types';

/**
 * Two 30-day sales charts side by side: sold volume (qty) on the left and
 * sale revenue (amount, so'm) on the right. Both read the same
 * `sales_chart.days` series. Stacks vertically on small screens.
 *
 * The revenue axis/tooltip use the compact so'm formatter so large totals
 * read at a glance (e.g. "10.9mlrd"); the header `Jami` shows the full
 * so'm value via `formatSom`.
 */
export function SalesChartsRow({ days }: { days: DashboardSalesPoint[] }) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <SalesChart
        points={days}
        title="Sotuv soni — 30 kun"
        description="Oxirgi 30 kun davomida sotilgan miqdor."
        dataKey="qty"
        valueFormatter={formatQty}
        tooltipLabel="Soni"
        accent="primary"
      />
      <SalesChart
        points={days}
        title="Sotuv summasi — 30 kun"
        description="Oxirgi 30 kun davomidagi savdo summasi (so‘m)."
        dataKey="amount"
        valueFormatter={formatCurrencyCompact}
        totalFormatter={formatSom}
        tooltipLabel="Summa"
        accent="success"
      />
    </div>
  );
}
