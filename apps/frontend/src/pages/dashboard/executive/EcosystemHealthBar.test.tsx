import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EcosystemHealthBar } from './EcosystemHealthBar';
import type { DashboardChainNode } from '@/lib/types';

const NODES: DashboardChainNode[] = [
  {
    location_id: 1,
    location_name: 'Xom-ashyo',
    location_type: 'raw_warehouse',
    below_min_count: 0,
    open_requests_count: 0,
    total_products: 12,
  },
  {
    location_id: 2,
    location_name: 'Sex 1',
    location_type: 'production',
    below_min_count: 0,
    open_requests_count: 2,
    total_products: 6,
  },
  {
    location_id: 3,
    location_name: 'Ta’minot',
    location_type: 'supply',
    below_min_count: 0,
    open_requests_count: 0,
    total_products: 5,
  },
  {
    location_id: 4,
    location_name: 'Markaziy sklad',
    location_type: 'central_warehouse',
    below_min_count: 0,
    open_requests_count: 0,
    total_products: 25,
  },
  {
    location_id: 5,
    location_name: 'Do‘kon #1',
    location_type: 'store',
    below_min_count: 3,
    open_requests_count: 1,
    total_products: 18,
  },
];

describe('EcosystemHealthBar', () => {
  it('renders all five stages', () => {
    render(<EcosystemHealthBar nodes={NODES} />);
    expect(screen.getByTestId('health-pill-raw_warehouse')).toBeInTheDocument();
    expect(screen.getByTestId('health-pill-production')).toBeInTheDocument();
    expect(screen.getByTestId('health-pill-supply')).toBeInTheDocument();
    expect(
      screen.getByTestId('health-pill-central_warehouse'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('health-pill-store')).toBeInTheDocument();
  });

  it('marks the raw warehouse as ok (no open, no below_min)', () => {
    render(<EcosystemHealthBar nodes={NODES} />);
    const pill = screen.getByTestId('health-pill-raw_warehouse');
    expect(pill.getAttribute('data-status')).toBe('ok');
  });

  it('marks production as warn when there are open requests but no below_min', () => {
    render(<EcosystemHealthBar nodes={NODES} />);
    const pill = screen.getByTestId('health-pill-production');
    expect(pill.getAttribute('data-status')).toBe('warn');
  });

  it('marks store as danger when below_min > 0', () => {
    render(<EcosystemHealthBar nodes={NODES} />);
    const pill = screen.getByTestId('health-pill-store');
    expect(pill.getAttribute('data-status')).toBe('danger');
  });
});
