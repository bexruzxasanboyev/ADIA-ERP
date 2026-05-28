import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StoreRankingView } from './StoreRanking';
import type { DashboardStoresDetail } from '@/lib/types';

const DATA: DashboardStoresDetail = {
  kpis: {
    store_count: 3,
    sales_today_sum: 800_000,
    sales_today_count: 30,
    avg_receipt_today: 26_667,
  },
  store_breakdown: [
    {
      location_id: 5,
      location_name: 'Kukcha',
      sales_sum: 200_000,
      sales_count: 8,
      below_min_count: 0,
      open_replenishments: 0,
    },
    {
      location_id: 6,
      location_name: 'Rabochiy',
      sales_sum: 500_000,
      sales_count: 18,
      below_min_count: 0,
      open_replenishments: 0,
    },
    {
      location_id: 7,
      location_name: 'Yunusobod',
      sales_sum: 100_000,
      sales_count: 4,
      below_min_count: 0,
      open_replenishments: 0,
    },
  ],
  top_products_today: [],
  hourly_heatmap: [],
  daily_sales: [],
};

describe('StoreRankingView', () => {
  it('sorts rows by sales descending', () => {
    render(<StoreRankingView data={DATA} />);
    const rows = Array.from(
      screen.getByTestId('store-ranking-rows').children,
    );
    expect(rows[0]?.textContent ?? '').toContain('Rabochiy');
    expect(rows[1]?.textContent ?? '').toContain('Kukcha');
    expect(rows[2]?.textContent ?? '').toContain('Yunusobod');
  });
});
