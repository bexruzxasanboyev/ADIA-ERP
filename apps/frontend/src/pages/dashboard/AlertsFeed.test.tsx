/**
 * F4.4 — AlertsFeed widget tests.
 *
 * Verifies severity styling, type-label translation, the 20-row cap and
 * the empty branch.
 */
import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderWithProviders } from '@/test/render-helpers';
import { AlertsFeed } from './AlertsFeed';
import type { DashboardAlert } from '@/lib/types';

function buildAlert(overrides: Partial<DashboardAlert>): DashboardAlert {
  return {
    id: 1,
    type: 'stock_below_min',
    severity: 'danger',
    message: 'Un Markaziy skladda min’dan tushdi.',
    location_id: 7,
    location_name: 'Markaziy sklad',
    created_at: new Date(Date.now() - 30 * 60_000).toISOString(),
    ...overrides,
  };
}

describe('AlertsFeed', () => {
  it('renders the empty branch when no alerts are provided', () => {
    renderWithProviders(<AlertsFeed alerts={[]} />);
    expect(
      screen.getByText('Hozircha ogohlantirishlar yo‘q.'),
    ).toBeInTheDocument();
  });

  it('renders all severity tones distinctly', () => {
    const alerts: DashboardAlert[] = [
      buildAlert({ id: 1, severity: 'danger' }),
      buildAlert({
        id: 2,
        severity: 'warning',
        type: 'replenishment_created',
        message: 'Yangi to‘ldirish so‘rovi.',
      }),
      buildAlert({
        id: 3,
        severity: 'info',
        type: 'poster_sync_failed',
        message: 'Poster sync xatosi.',
      }),
    ];
    renderWithProviders(<AlertsFeed alerts={alerts} />);
    const list = screen.getByTestId('alerts-feed');
    const rows = within(list).getAllByRole('listitem');
    expect(rows.length).toBe(3);
    expect(rows[0]?.getAttribute('data-severity')).toBe('danger');
    expect(rows[1]?.getAttribute('data-severity')).toBe('warning');
    expect(rows[2]?.getAttribute('data-severity')).toBe('info');
  });

  it('translates known notification types into Uzbek labels', () => {
    const alerts: DashboardAlert[] = [
      buildAlert({ id: 1, type: 'stock_below_min' }),
      buildAlert({
        id: 2,
        type: 'production_order_done',
        severity: 'info',
        message: 'Zayafka yakunlandi.',
      }),
    ];
    renderWithProviders(<AlertsFeed alerts={alerts} />);
    expect(screen.getByText('Min’dan tushdi')).toBeInTheDocument();
    expect(screen.getByText('Zayafka yakunlandi')).toBeInTheDocument();
  });

  it('caps the feed at 20 rows even when more are passed', () => {
    const alerts = Array.from({ length: 25 }, (_unused, i) =>
      buildAlert({ id: i + 1, message: `Ogohlantirish ${i + 1}` }),
    );
    renderWithProviders(<AlertsFeed alerts={alerts} />);
    const list = screen.getByTestId('alerts-feed');
    const rows = within(list).getAllByRole('listitem');
    expect(rows.length).toBe(20);
  });

  it('renders the location name when scoped', () => {
    renderWithProviders(
      <AlertsFeed
        alerts={[
          buildAlert({
            id: 11,
            location_id: 7,
            location_name: 'Markaziy sklad',
          }),
        ]}
      />,
    );
    expect(screen.getByText('Markaziy sklad')).toBeInTheDocument();
  });
});
