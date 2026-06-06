/**
 * F4.4 — SalesChart widget tests.
 *
 * Verifies the generalized 30-day sales chart renders the chart container
 * when data is present, falls back to an empty state when the points array
 * is empty, and computes the header total via the active `dataKey` with the
 * supplied total formatter (qty grouping vs. so'm).
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render-helpers';
import { PinnedTooltip, SalesChart, SalesTooltip } from './SalesChart';
import { formatQty, formatSom, formatCurrencyCompact } from '@/lib/format';
import type {
  DashboardSalesBreakdownBucket,
  DashboardSalesPoint,
} from '@/lib/types';

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

/** Build hourly buckets (range=today): same date, ascending `hour`. */
function buildHourlyPoints(
  rows: Array<[hour: number, qty: number, amount: number]>,
): DashboardSalesPoint[] {
  return rows.map(([hour, qty, amount]) => ({
    date: '2026-05-01',
    hour,
    qty,
    amount,
  }));
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

  it('renders the in-card skeleton (not the chart) while loading', () => {
    const points = buildPoints([
      [10, 0],
      [20, 0],
    ]);
    // Even with points available, `loading` forces the skeleton — the chart
    // body must not render so nothing pops in until the parent says ready.
    renderWithProviders(<SalesChart points={points} loading {...qtyProps} />);
    expect(screen.getByTestId('sales-chart-skeleton')).toBeInTheDocument();
    expect(screen.queryByTestId('sales-chart')).not.toBeInTheDocument();
    // Header title is kept so the card footprint is stable across the swap.
    expect(screen.getByText('Sotuv soni — 30 kun')).toBeInTheDocument();
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

  it('renders the chart container for an hourly (range=today) series', () => {
    // range=today returns hour buckets; the chart must still read cleanly —
    // even a single early-day point. The HH:00 axis labels themselves are
    // covered by the chartBucketLabel unit tests (Recharts does not paint
    // axis ticks at 0×0 in jsdom); here we assert the hourly path renders
    // and the header total sums the hour buckets.
    const points = buildHourlyPoints([
      [8, 4, 0],
      [9, 6, 0],
      [10, 10, 0],
    ]); // qty total = 20
    renderWithProviders(
      <SalesChart points={points} granularity="hour" {...qtyProps} />,
    );
    expect(screen.getByTestId('sales-chart')).toBeInTheDocument();
    expect(screen.getByText('20')).toBeInTheDocument();
  });

  it('renders cleanly with a single hourly point early in the day', () => {
    const points = buildHourlyPoints([[8, 4, 0]]);
    renderWithProviders(
      <SalesChart points={points} granularity="hour" {...qtyProps} />,
    );
    expect(screen.getByTestId('sales-chart')).toBeInTheDocument();
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

describe('SalesTooltip', () => {
  const bucket: DashboardSalesBreakdownBucket = {
    hour: 9,
    total_qty: 30,
    total_amount: 900_000,
    items: [
      { name: 'Napoleon torti', qty: 18, amount: 540_000 },
      { name: 'Medovik', qty: 12, amount: 360_000 },
    ],
  };
  const point = { date: '2026-05-01', hour: 9, value: 30, label: '09:00' };

  it('lists each item name + the bucket label and a bold Jami row (qty metric)', () => {
    renderWithProviders(
      <SalesTooltip
        active
        payload={[{ payload: point, value: 30 }]}
        dataKey="qty"
        tooltipLabel="Soni"
        valueFormatter={formatQty}
        lookupBucket={() => bucket}
      />,
    );
    // Header = bucket label.
    expect(screen.getByText('09:00')).toBeInTheDocument();
    // One row per item, by name.
    expect(screen.getByText('Napoleon torti')).toBeInTheDocument();
    expect(screen.getByText('Medovik')).toBeInTheDocument();
    // Per-item qty values.
    expect(screen.getByText('18')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    // Jami row with the bucket total qty.
    expect(screen.getByText('Jami')).toBeInTheDocument();
    expect(screen.getByText('30')).toBeInTheDocument();
  });

  it('shows the amount metric (so‘m) per item when dataKey is amount', () => {
    renderWithProviders(
      <SalesTooltip
        active
        payload={[{ payload: point, value: 900_000 }]}
        dataKey="amount"
        tooltipLabel="Summa"
        valueFormatter={formatSom}
        lookupBucket={() => bucket}
      />,
    );
    const stripWs = (s: string) => s.replace(/\s/g, '');
    const expected = stripWs(formatSom(540_000));
    expect(
      screen.getByText((_, el) => stripWs(el?.textContent ?? '') === expected),
    ).toBeInTheDocument();
    expect(screen.getByText('Jami')).toBeInTheDocument();
  });

  it('falls back to the simple label + single total when no bucket matches', () => {
    renderWithProviders(
      <SalesTooltip
        active
        payload={[{ payload: point, value: 30 }]}
        dataKey="qty"
        tooltipLabel="Soni"
        valueFormatter={formatQty}
        lookupBucket={() => undefined}
      />,
    );
    expect(screen.getByText('09:00')).toBeInTheDocument();
    expect(screen.getByText('Soni')).toBeInTheDocument();
    expect(screen.getByText('30')).toBeInTheDocument();
    // No itemized "Jami" row in the fallback.
    expect(screen.queryByText('Jami')).not.toBeInTheDocument();
  });

  it('renders nothing when inactive', () => {
    const { container } = renderWithProviders(
      <SalesTooltip
        active={false}
        payload={[{ payload: point, value: 30 }]}
        dataKey="qty"
        tooltipLabel="Soni"
        valueFormatter={formatQty}
        lookupBucket={() => bucket}
      />,
    );
    expect(container.querySelector('[data-testid="sales-tooltip"]')).toBeNull();
  });
});

describe('PinnedTooltip (click-to-pin overlay)', () => {
  const bucket: DashboardSalesBreakdownBucket = {
    hour: 9,
    total_qty: 30,
    total_amount: 900_000,
    items: [
      { name: 'Napoleon torti', qty: 18, amount: 540_000 },
      { name: 'Medovik', qty: 12, amount: 360_000 },
    ],
  };
  const pinned = {
    datum: { date: '2026-05-01', hour: 9, value: 30, label: '09:00' },
    x: 120,
  };

  // Recharts does not lay out the chart at 0×0 in jsdom, so a real chart click
  // cannot be simulated reliably. We assert the overlay the click produces
  // renders the same itemized body as the hover tooltip, plus a × dismiss.
  it('renders the pinned overlay with the bucket breakdown and a × close button', () => {
    renderWithProviders(
      <PinnedTooltip
        point={pinned}
        dataKey="qty"
        tooltipLabel="Soni"
        valueFormatter={formatQty}
        lookupBucket={() => bucket}
        onClose={() => {}}
      />,
    );
    // Same itemized body as the hover tooltip.
    expect(screen.getByTestId('sales-tooltip-pinned')).toBeInTheDocument();
    expect(screen.getByText('09:00')).toBeInTheDocument();
    expect(screen.getByText('Napoleon torti')).toBeInTheDocument();
    expect(screen.getByText('Medovik')).toBeInTheDocument();
    expect(screen.getByText('Jami')).toBeInTheDocument();
    // The × is a real, labelled button.
    expect(
      screen.getByRole('button', { name: 'Yopish' }),
    ).toBeInTheDocument();
  });

  it('invokes onClose when the × button is clicked', () => {
    const onClose = vi.fn();
    renderWithProviders(
      <PinnedTooltip
        point={pinned}
        dataKey="qty"
        tooltipLabel="Soni"
        valueFormatter={formatQty}
        lookupBucket={() => bucket}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Yopish' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('anchors the overlay to the clicked point x via a clamped left offset', () => {
    renderWithProviders(
      <PinnedTooltip
        point={pinned}
        dataKey="qty"
        tooltipLabel="Soni"
        valueFormatter={formatQty}
        lookupBucket={() => bucket}
        onClose={() => {}}
      />,
    );
    const overlay = screen.getByTestId('sales-tooltip-pinned');
    expect(overlay.style.left).toContain('120px');
  });
});
