/**
 * SalesChartsRow — granularity-driven copy tests.
 *
 * The row threads the `sales_chart.granularity` discriminator from the
 * ecosystem response into both child charts. For range=today (hourly) the
 * card titles/descriptions switch to "bugun" wording so they don't falsely
 * claim a 30-day window; every other range keeps the 30-day copy. The HH:00
 * vs DD.MM axis labels themselves are covered by `lib/chartTime.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render-helpers';
import { SalesChartsRow } from './SalesChartsRow';
import type { DashboardSalesPoint } from '@/lib/types';

const DAY_POINTS: DashboardSalesPoint[] = [
  { date: '2026-05-01', qty: 10, amount: 1_000_000 },
  { date: '2026-05-02', qty: 20, amount: 2_000_000 },
];

const HOUR_POINTS: DashboardSalesPoint[] = [
  { date: '2026-05-01', hour: 8, qty: 4, amount: 400_000 },
  { date: '2026-05-01', hour: 9, qty: 6, amount: 600_000 },
];

describe('SalesChartsRow', () => {
  it('uses 30-day copy for day granularity (default)', () => {
    renderWithProviders(<SalesChartsRow days={DAY_POINTS} />);
    expect(screen.getByText('Sotuv soni — 30 kun')).toBeInTheDocument();
    expect(screen.getByText('Sotuv summasi — 30 kun')).toBeInTheDocument();
  });

  it('switches to "bugun" copy for hourly granularity (range=today)', () => {
    renderWithProviders(
      <SalesChartsRow days={HOUR_POINTS} granularity="hour" />,
    );
    expect(screen.getByText('Sotuv soni — bugun')).toBeInTheDocument();
    expect(screen.getByText('Sotuv summasi — bugun')).toBeInTheDocument();
    // The 30-day wording must be gone.
    expect(screen.queryByText('Sotuv soni — 30 kun')).not.toBeInTheDocument();
  });

  it('renders two independent chart skeletons while loading', () => {
    renderWithProviders(<SalesChartsRow days={[]} loading />);
    // One skeleton per chart — the two-up grid renders two side by side.
    expect(screen.getAllByTestId('sales-chart-skeleton')).toHaveLength(2);
    // No real chart body while loading.
    expect(screen.queryByTestId('sales-chart')).not.toBeInTheDocument();
  });
});
