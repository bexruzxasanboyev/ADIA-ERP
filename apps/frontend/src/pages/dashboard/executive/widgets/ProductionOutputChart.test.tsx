import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProductionOutputChartView } from './ProductionOutputChart';
import type { DashboardProductionDetail } from '@/lib/types';

const DATA: DashboardProductionDetail = {
  kpis: { active_orders: 1, done_today: 53, overdue: 0, sex_count: 2 },
  active_orders: [],
  top_produced_today: [],
  daily_io: Array.from({ length: 7 }, (_, i) => ({
    date: `2026-05-${String(i + 19).padStart(2, '0')}`,
    input: 40 + i,
    output: 50 + i * 2,
  })),
  sex_load: [],
};

describe('ProductionOutputChartView', () => {
  it('renders the "Bugun" qty label from the last daily_io point', () => {
    render(<ProductionOutputChartView data={DATA} />);
    // last point output = 50 + 6*2 = 62
    expect(screen.getByText(/62/)).toBeInTheDocument();
  });
});
