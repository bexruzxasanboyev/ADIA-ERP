/**
 * F4.4 — EcosystemFlow widget tests.
 *
 * Verifies the five-stage chain renders one column per `LocationType`,
 * the per-node danger badge surfaces when `below_min_count > 0`, and the
 * empty branch fires when `nodes` is empty.
 */
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render-helpers';
import { EcosystemFlow } from './EcosystemFlow';
import type { DashboardChainNode } from '@/lib/types';

const NODES: DashboardChainNode[] = [
  {
    location_id: 1,
    location_name: 'Xom-ashyo ombori',
    location_type: 'raw_warehouse',
    below_min_count: 0,
    open_requests_count: 1,
    total_products: 12,
  },
  {
    location_id: 2,
    location_name: 'Sex 1',
    location_type: 'production',
    below_min_count: 3,
    open_requests_count: 0,
    total_products: 4,
  },
  {
    location_id: 3,
    location_name: 'Ta’minot',
    location_type: 'supply',
    below_min_count: 0,
    open_requests_count: 0,
    total_products: 2,
  },
  {
    location_id: 4,
    location_name: 'Markaziy sklad',
    location_type: 'central_warehouse',
    below_min_count: 0,
    open_requests_count: 2,
    total_products: 20,
  },
  {
    location_id: 5,
    location_name: 'Do‘kon #1',
    location_type: 'store',
    below_min_count: 1,
    open_requests_count: 0,
    total_products: 8,
  },
  {
    location_id: 6,
    location_name: 'Do‘kon #2',
    location_type: 'store',
    below_min_count: 0,
    open_requests_count: 0,
    total_products: 7,
  },
];

describe('EcosystemFlow', () => {
  it('renders the empty branch when no nodes are provided', () => {
    renderWithProviders(<EcosystemFlow nodes={[]} />);
    expect(screen.getByText('Bo‘g‘inlar topilmadi.')).toBeInTheDocument();
  });

  it('renders one column per LocationType in the canonical order', () => {
    renderWithProviders(<EcosystemFlow nodes={NODES} />);
    const flow = screen.getByTestId('ecosystem-flow');
    expect(flow).toBeInTheDocument();
    // Every stage column must appear, even when the stage has zero nodes.
    expect(screen.getByTestId('ecosystem-stage-raw_warehouse')).toBeInTheDocument();
    expect(screen.getByTestId('ecosystem-stage-production')).toBeInTheDocument();
    expect(screen.getByTestId('ecosystem-stage-supply')).toBeInTheDocument();
    expect(screen.getByTestId('ecosystem-stage-central_warehouse')).toBeInTheDocument();
    expect(screen.getByTestId('ecosystem-stage-store')).toBeInTheDocument();
  });

  it('groups multiple nodes under their stage column', () => {
    renderWithProviders(<EcosystemFlow nodes={NODES} />);
    const storeStage = screen.getByTestId('ecosystem-stage-store');
    expect(storeStage.textContent).toMatch(/Do‘kon #1/);
    expect(storeStage.textContent).toMatch(/Do‘kon #2/);
  });

  it('surfaces a danger badge when below_min_count > 0', () => {
    renderWithProviders(<EcosystemFlow nodes={NODES} />);
    const badges = screen.getAllByTestId('below-min-badge');
    // Sex 1 (3) + Do'kon #1 (1) → exactly two badges.
    expect(badges.length).toBe(2);
    expect(badges[0]?.textContent ?? '').toMatch(/min’dan past/);
  });

  it('renders a "—" placeholder for a stage that has no nodes', () => {
    const subset = NODES.filter((n) => n.location_type !== 'supply');
    renderWithProviders(<EcosystemFlow nodes={subset} />);
    const stage = screen.getByTestId('ecosystem-stage-supply');
    expect(stage.textContent).toMatch(/—/);
  });
});
