import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HeroBlock } from './HeroBlock';
import type { DashboardEcosystem, DashboardOverview } from '@/lib/types';

const OVERVIEW: DashboardOverview = {
  below_min: [],
  open_requests: { by_status: {}, total: 0, oldest_created_at: null },
  production_plan: [],
  recent_movements: [],
  kpis: {
    total_open_requests: 0,
    below_min_count: 0,
    active_production_orders: 0,
    pending_approvals: 0,
  },
};

const ECOSYSTEM: DashboardEcosystem = {
  poster_status: {
    last_sync_at: null,
    last_sync_status: null,
    sync_errors_24h: 0,
    sales_today_count: 893,
    sales_today_sum: 93_250_000,
  },
  chain_flow: [],
  chain_summary: [
    {
      type: 'raw_warehouse',
      location_count: 1,
      total_products: 5,
      below_min_count: 0,
      status: 'ok',
      pulse: {
        kind: 'raw',
        received_today: 0,
        issued_today: 0,
      },
    },
    {
      type: 'production',
      location_count: 2,
      total_products: 3,
      below_min_count: 0,
      status: 'ok',
      pulse: { kind: 'production', active_orders: 0, done_today: 0 },
    },
    {
      type: 'supply',
      location_count: 1,
      total_products: 4,
      below_min_count: 0,
      status: 'ok',
      pulse: { kind: 'supply', shipped_today: 0, received_today: 0 },
    },
    {
      type: 'central_warehouse',
      location_count: 1,
      total_products: 25,
      below_min_count: 2,
      status: 'warn',
      pulse: {
        kind: 'central',
        last_sync_at: null,
        last_sync_status: 'partial',
      },
    },
    {
      type: 'store',
      location_count: 6,
      total_products: 18,
      below_min_count: 0,
      status: 'ok',
      pulse: {
        kind: 'store',
        sales_today_sum: 93_250_000,
        receipts_today: 893,
      },
    },
  ],
  alerts_feed: [
    {
      id: 1,
      type: 'poster_sync_failed',
      severity: 'warning',
      message: 'Markaziy sklad — 2 sync xato',
      location_id: null,
      created_at: '2026-05-25T08:00:00.000Z',
    },
  ],
  sales_chart: {
    days: Array.from({ length: 7 }, (_, i) => ({
      date: `2026-05-${String(i + 19).padStart(2, '0')}`,
      qty: 100 + i * 10,
    })),
  },
};

describe('HeroBlock', () => {
  it('renders compact sales value', () => {
    render(<HeroBlock overview={OVERVIEW} ecosystem={ECOSYSTEM} />);
    const value = screen.getByTestId('hero-block-sales-value');
    // 93,250,000 → ~93.3M (compact formatter)
    expect(value.textContent).toMatch(/93/);
    expect(value.textContent).toMatch(/M/);
  });

  it('renders five status dots', () => {
    render(<HeroBlock overview={OVERVIEW} ecosystem={ECOSYSTEM} />);
    expect(screen.getByTestId('hero-block-dot-raw_warehouse')).toBeInTheDocument();
    expect(screen.getByTestId('hero-block-dot-production')).toBeInTheDocument();
    expect(screen.getByTestId('hero-block-dot-supply')).toBeInTheDocument();
    expect(
      screen.getByTestId('hero-block-dot-central_warehouse'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('hero-block-dot-store')).toBeInTheDocument();
  });

  it('surfaces the first warning alert', () => {
    render(<HeroBlock overview={OVERVIEW} ecosystem={ECOSYSTEM} />);
    expect(
      screen.getByTestId('hero-block-first-alert'),
    ).toHaveTextContent(/Markaziy sklad/);
  });

  it('falls back to "no alerts" message when feed is empty', () => {
    const empty: DashboardEcosystem = {
      ...ECOSYSTEM,
      alerts_feed: [],
    };
    render(<HeroBlock overview={OVERVIEW} ecosystem={empty} />);
    expect(screen.queryByTestId('hero-block-first-alert')).toBeNull();
    expect(screen.getByText(/kritik signal yo'q/)).toBeInTheDocument();
  });

  it('handles a null ecosystem gracefully', () => {
    render(<HeroBlock overview={OVERVIEW} ecosystem={null} />);
    expect(screen.getByTestId('hero-block-sales-value')).toBeInTheDocument();
    // No chain_summary entries — health summary text says no data.
    expect(screen.getByText(/Ma'lumot yo'q/)).toBeInTheDocument();
  });
});
