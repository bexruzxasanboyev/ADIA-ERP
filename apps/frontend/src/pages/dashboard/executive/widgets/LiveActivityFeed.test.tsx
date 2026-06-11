import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { LiveActivityFeed } from './LiveActivityFeed';
import type { DashboardRecentMovementItem } from '@/lib/types';

const ITEMS: DashboardRecentMovementItem[] = [
  {
    id: 1,
    created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    product_id: 11,
    product_name: 'Bug‘irsoq',
    product_unit: 'pcs',
    from_location_id: 5,
    from_location_name: 'Sex 1',
    to_location_id: 7,
    to_location_name: "Do'kon 1",
    qty: 12,
    reason: 'transfer',
  },
  {
    id: 2,
    created_at: new Date(Date.now() - 30 * 60_000).toISOString(),
    product_id: 21,
    product_name: 'Pahlava',
    product_unit: 'kg',
    from_location_id: null,
    from_location_name: null,
    to_location_id: 7,
    to_location_name: "Do'kon 2",
    qty: 2,
    reason: 'sale',
  },
];

function renderWithRouter(ui: React.ReactElement) {
  return render(<BrowserRouter>{ui}</BrowserRouter>);
}

describe('LiveActivityFeed', () => {
  it('renders each movement with product, route and qty', () => {
    renderWithRouter(<LiveActivityFeed items={ITEMS} />);
    expect(screen.getByTestId('live-activity-feed')).toBeInTheDocument();
    expect(screen.getByText('Bug‘irsoq')).toBeInTheDocument();
    expect(screen.getByText('Pahlava')).toBeInTheDocument();
    expect(screen.getByText(/Sex 1/)).toBeInTheDocument();
  });

  it('shows the empty-state message when no items', () => {
    renderWithRouter(<LiveActivityFeed items={[]} />);
    expect(screen.getByText("Bugun harakat yo'q.")).toBeInTheDocument();
  });

  it('caps the feed at maxItems', () => {
    const template = ITEMS[0];
    if (!template) throw new Error('ITEMS[0] missing');
    const many: DashboardRecentMovementItem[] = Array.from(
      { length: 12 },
      (_, i) => ({ ...template, id: i + 100 }),
    );
    renderWithRouter(<LiveActivityFeed items={many} maxItems={5} />);
    const list = screen.getByTestId('live-activity-list');
    expect(list.children.length).toBe(5);
  });
});
