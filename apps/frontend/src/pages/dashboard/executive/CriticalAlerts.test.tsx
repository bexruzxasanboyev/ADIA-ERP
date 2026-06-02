import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render-helpers';
import { CriticalAlerts } from './CriticalAlerts';
import type { DashboardAlert, DashboardBelowMinItem } from '@/lib/types';

const BELOW_MIN: DashboardBelowMinItem[] = [
  {
    location_id: 1,
    location_name: 'Markaziy sklad',
    product_id: 10,
    product_name: 'Shakar',
    product_unit: 'kg',
    qty: 0,
    min_level: 10,
    max_level: 50,
    open_request_id: 42,
    open_request_status: 'NEW',
  },
  {
    location_id: 2,
    location_name: 'Do‘kon #2',
    product_id: 11,
    product_name: 'Un',
    product_unit: 'kg',
    qty: 2,
    min_level: 10,
    max_level: 30,
    open_request_id: null,
    open_request_status: null,
  },
];

describe('CriticalAlerts', () => {
  it('renders the empty success state when no rows', () => {
    renderWithProviders(<CriticalAlerts belowMin={[]} alerts={[]} />);
    expect(screen.getByText('Hammasi me’yorda.')).toBeInTheDocument();
  });

  it('shows zero-stock items first, then deep-below-min items', () => {
    renderWithProviders(
      <CriticalAlerts belowMin={BELOW_MIN} alerts={[]} />,
    );
    const titles = screen
      .getAllByRole('link')
      .map((a) => a.textContent ?? '');
    expect(titles[0]).toMatch(/Shakar/);
    expect(titles[1]).toMatch(/Un/);
  });

  it('shows a counter badge with the total count', () => {
    const alerts: DashboardAlert[] = [
      {
        id: 1,
        type: 'poster_sync_failed',
        severity: 'danger',
        message: 'Poster sync failed',
        location_id: null,
        location_name: null,
        created_at: '2026-05-24T10:00:00.000Z',
      },
    ];
    renderWithProviders(
      <CriticalAlerts belowMin={BELOW_MIN} alerts={alerts} />,
    );
    // 2 below-min + 1 danger alert = 3 (legacy: no server count given)
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('badge reflects the server criticalCount, not the client row count', () => {
    // Defect: the KPI ("Kritik pozitsiya") showed `below_min_count` (435)
    // while this panel showed `rows.length` (455 — below_min + alerts).
    // When the server count is supplied it must win in BOTH places so the
    // numbers agree.
    const alerts: DashboardAlert[] = [
      {
        id: 1,
        type: 'poster_sync_failed',
        severity: 'danger',
        message: 'Poster sync failed',
        location_id: null,
        location_name: null,
        created_at: '2026-05-24T10:00:00.000Z',
      },
    ];
    renderWithProviders(
      <CriticalAlerts belowMin={BELOW_MIN} alerts={alerts} criticalCount={2} />,
    );
    // Server says 2 critical positions — badge shows 2, NOT 3.
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.queryByText('3')).not.toBeInTheDocument();
  });

  it('overflow footer counts against the server criticalCount', () => {
    // 2 rows are displayed (TOP_LIMIT=3 not exceeded by display rows),
    // but the server reports 10 critical positions → footer shows the
    // remainder relative to the server count.
    renderWithProviders(
      <CriticalAlerts belowMin={BELOW_MIN} alerts={[]} criticalCount={10} />,
    );
    // 10 total - 2 shown = "Yana 8 ta →"
    expect(screen.getByText(/Yana 8 ta/)).toBeInTheDocument();
  });
});
