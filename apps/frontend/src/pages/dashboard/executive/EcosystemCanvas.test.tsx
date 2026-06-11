/**
 * EcosystemCanvas — smoke test.
 *
 * The canvas renders a React Flow graph with one node per supplier and
 * one node per chain-flow row. We assert the visible counts and a few
 * representative `data-testid`s so refactors that drop nodes break here
 * first.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EcosystemCanvas } from './EcosystemCanvas';
import type {
  DashboardChainNode,
  DashboardSuppliersResponse,
} from '@/lib/types';

const SUPPLIERS: DashboardSuppliersResponse['suppliers'] = [
  {
    supplier_id: 11,
    supplier_name: 'Don Mahsulot',
    pending_pos: 3,
    total_pos: 10,
    received_qty: 700,
    expected_qty: 300,
    status: 'warn',
  },
];

const CHAIN_FLOW: DashboardChainNode[] = [
  {
    location_id: 1,
    location_name: 'Xom-ashyo ombori',
    location_type: 'raw_warehouse',
    below_min_count: 0,
    open_requests_count: 0,
    total_products: 12,
  },
  {
    location_id: 2,
    location_name: 'Sex Tort',
    location_type: 'production',
    below_min_count: 0,
    open_requests_count: 0,
    total_products: 8,
  },
  {
    location_id: 4,
    location_name: 'Tort sklad',
    location_type: 'supply',
    below_min_count: 0,
    open_requests_count: 0,
    total_products: 5,
  },
  {
    location_id: 6,
    location_name: 'Markaziy sklad',
    location_type: 'central_warehouse',
    below_min_count: 0,
    open_requests_count: 0,
    total_products: 25,
  },
  {
    location_id: 7,
    location_name: 'Кукча',
    location_type: 'store',
    below_min_count: 0,
    open_requests_count: 0,
    total_products: 18,
  },
];

describe('EcosystemCanvas', () => {
  it('renders the canvas shell', () => {
    render(
      <EcosystemCanvas chainFlow={CHAIN_FLOW} suppliers={SUPPLIERS} />,
    );

    expect(screen.getByTestId('ecosystem-canvas')).toBeInTheDocument();
    expect(screen.getByTestId('ecosystem-canvas-stage')).toBeInTheDocument();
  });

  it('renders one supplier node and one node per chain location', () => {
    render(
      <EcosystemCanvas chainFlow={CHAIN_FLOW} suppliers={SUPPLIERS} />,
    );

    // Supplier
    expect(screen.getByTestId('supplier-node-11')).toBeInTheDocument();
    // Chain locations
    expect(
      screen.getByTestId('ecosystem-node-raw_warehouse-1'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('ecosystem-node-production-2'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('ecosystem-node-supply-4')).toBeInTheDocument();
    expect(
      screen.getByTestId('ecosystem-node-central_warehouse-6'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('ecosystem-node-store-7')).toBeInTheDocument();
  });

  it('renders gracefully with empty inputs', () => {
    render(<EcosystemCanvas chainFlow={[]} suppliers={[]} />);

    expect(screen.getByTestId('ecosystem-canvas')).toBeInTheDocument();
  });
});
