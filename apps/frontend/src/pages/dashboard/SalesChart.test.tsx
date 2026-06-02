/**
 * F4.4 — SalesChart widget tests.
 *
 * Verifies the generalized 30-day sales chart renders the chart container
 * when data is present, falls back to an empty state when the points array
 * is empty, and computes the header total via the active `dataKey` with the
 * supplied total formatter (qty grouping vs. so'm).
 */
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render-helpers';
import { SalesChart } from './SalesChart';
import { formatQty, formatSom, formatCurrencyCompact } from '@/lib/format';
import type { DashboardSalesPoint } from '@/lib/types';

function buildPoints(rows: Array<[qty: number, amount: number]>): DashboardSalesPoint[] {
  const base = new Date(2026, 4, 1);
  return rows.map(([qty, amount], i) => {
    const d = new Date(base);
    d.setDate(d.getDate() + i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate(),
    ).padStart(2, '0')}`;
    return { date: iso, qty, amount };
  });
}

const qtyProps = {
  title: 'Sotuv soni — 30 kun',
  description: 'Oxirgi 30 kun davomida sotilgan miqdor.',
  dataKey: 'qty' as const,
  valueFormatter: formatQty,
  tooltipLabel: 'Soni',
};

describe('SalesChart', () => {
  it('renders the empty branch when no points are provided', () => {
    renderWithProviders(<SalesChart points={[]} {...qtyProps} />);
    expect(screen.getByText('Sotuv ma’lumotlari yo‘q.')).toBeInTheDocument();
    expect(screen.queryByTestId('sales-chart')).not.toBeInTheDocument();
  });

  it('renders the chart container when points are present', () => {
    const points = buildPoints([
      [10, 0],
      [20, 0],
      [30, 0],
      [40, 0],
    ]);
    renderWithProviders(<SalesChart points={points} {...qtyProps} />);
    expect(screen.getByTestId('sales-chart')).toBeInTheDocument();
  });

  it('shows the qty aggregate total in the header', () => {
    const points = buildPoints([
      [5, 0],
      [10, 0],
      [15, 0],
    ]); // qty total = 30
    renderWithProviders(<SalesChart points={points} {...qtyProps} />);
    expect(screen.getByText('Jami')).toBeInTheDocument();
    expect(screen.getByText('30')).toBeInTheDocument();
  });

  it('totals the amount series with the so‘m formatter for the revenue metric', () => {
    const points = buildPoints([
      [5, 1_000_000],
      [10, 2_000_000],
      [15, 3_000_000],
    ]); // amount total = 6_000_000
    renderWithProviders(
      <SalesChart
        points={points}
        title="Sotuv summasi — 30 kun"
        description="Savdo summasi (so‘m)."
        dataKey="amount"
        valueFormatter={formatCurrencyCompact}
        totalFormatter={formatSom}
        tooltipLabel="Summa"
        accent="success"
      />,
    );
    // formatSom uses uz-UZ grouping (narrow no-break spaces), which
    // getByText's default normalizer does not collapse — compare the
    // digits/suffix with whitespace stripped instead.
    const stripWs = (s: string) => s.replace(/\s/g, '');
    const expected = stripWs(formatSom(6_000_000));
    expect(
      screen.getByText((_, el) => stripWs(el?.textContent ?? '') === expected),
    ).toBeInTheDocument();
  });
});
