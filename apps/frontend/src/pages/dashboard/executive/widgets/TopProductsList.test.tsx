import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TopProductsListView } from './TopProductsList';
import type { DashboardStoresDetail } from '@/lib/types';

const DATA: DashboardStoresDetail = {
  kpis: {
    store_count: 3,
    sales_today_sum: 0,
    sales_today_count: 0,
    avg_receipt_today: 0,
  },
  store_breakdown: [],
  top_products_today: [
    {
      product_id: 1,
      product_name: 'Bug‘irsoq',
      unit: 'pcs',
      qty: 320,
      revenue: 82_700_000,
    },
    {
      product_id: 2,
      product_name: 'Pahlava',
      unit: 'kg',
      qty: 14,
      revenue: 30_600_000,
    },
  ],
  hourly_heatmap: [],
  daily_sales: [],
};

describe('TopProductsListView', () => {
  it('renders each product with revenue compact', () => {
    render(<TopProductsListView data={DATA} />);
    expect(screen.getByText('Bug‘irsoq')).toBeInTheDocument();
    expect(screen.getByText('Pahlava')).toBeInTheDocument();
    const rows = screen.getByTestId('top-products-rows').children;
    expect(rows.length).toBe(2);
  });
});
