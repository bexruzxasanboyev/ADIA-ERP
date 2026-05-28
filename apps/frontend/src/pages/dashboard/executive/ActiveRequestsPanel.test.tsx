/**
 * ActiveRequestsPanel — contract test.
 *
 * Pins:
 *   • terminal (CLOSED, CANCELLED) requests are filtered out
 *   • FIFO order (oldest first)
 *   • clicking a card calls `onSelect` with its id
 *   • clicking the already-selected card calls `onSelect(null)`
 *   • empty-state copy renders when the list is empty
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ActiveRequestsPanel } from './ActiveRequestsPanel';
import type { ReplenishmentRequest } from '@/lib/types';

function makeRequest(
  overrides: Partial<ReplenishmentRequest> & { id: number },
): ReplenishmentRequest {
  const base: ReplenishmentRequest = {
    id: overrides.id,
    product_id: 1,
    requester_location_id: 7,
    target_location_id: 4,
    qty_needed: 5,
    status: 'NEW',
    production_order_id: null,
    purchase_order_id: null,
    shipment_movement_id: null,
    note: null,
    created_by: null,
    created_at: '2026-05-25T08:00:00.000Z',
    updated_at: '2026-05-25T08:00:00.000Z',
    closed_at: null,
    product_name: 'Tort',
    product_unit: 'pcs',
    requester_location_name: 'Kokcha',
    target_location_name: 'Tort sklad',
    production_location_name: null,
  };
  return { ...base, ...overrides };
}

describe('ActiveRequestsPanel', () => {
  it('renders an empty state when no active requests', () => {
    render(
      <ActiveRequestsPanel
        requests={[]}
        selectedId={null}
        onSelect={() => {}}
      />,
    );

    expect(screen.getByTestId('active-requests-empty')).toBeInTheDocument();
  });

  it('filters out terminal CLOSED and CANCELLED requests', () => {
    render(
      <ActiveRequestsPanel
        requests={[
          makeRequest({ id: 1, status: 'NEW' }),
          makeRequest({ id: 2, status: 'CLOSED' }),
          makeRequest({ id: 3, status: 'CANCELLED' }),
          makeRequest({ id: 4, status: 'PRODUCING' }),
        ]}
        selectedId={null}
        onSelect={() => {}}
      />,
    );

    expect(screen.getByTestId('active-request-1')).toBeInTheDocument();
    expect(screen.getByTestId('active-request-4')).toBeInTheDocument();
    expect(screen.queryByTestId('active-request-2')).not.toBeInTheDocument();
    expect(screen.queryByTestId('active-request-3')).not.toBeInTheDocument();
  });

  it('sorts requests FIFO (oldest first)', () => {
    render(
      <ActiveRequestsPanel
        requests={[
          makeRequest({ id: 1, created_at: '2026-05-25T10:00:00.000Z' }),
          makeRequest({ id: 2, created_at: '2026-05-25T08:00:00.000Z' }),
          makeRequest({ id: 3, created_at: '2026-05-25T09:00:00.000Z' }),
        ]}
        selectedId={null}
        onSelect={() => {}}
      />,
    );

    const ids = screen
      .getAllByRole('button')
      .map((b) => b.getAttribute('data-testid'));
    expect(ids).toEqual([
      'active-request-2',
      'active-request-3',
      'active-request-1',
    ]);
  });

  it('marks the selected row with data-state=selected', () => {
    render(
      <ActiveRequestsPanel
        requests={[makeRequest({ id: 42 })]}
        selectedId={42}
        onSelect={() => {}}
      />,
    );

    expect(screen.getByTestId('active-request-42')).toHaveAttribute(
      'data-state',
      'selected',
    );
  });

  it('calls onSelect with the id when an inactive card is clicked', () => {
    const onSelect = vi.fn();
    render(
      <ActiveRequestsPanel
        requests={[makeRequest({ id: 7 })]}
        selectedId={null}
        onSelect={onSelect}
      />,
    );

    fireEvent.click(screen.getByTestId('active-request-7'));
    expect(onSelect).toHaveBeenCalledWith(7);
  });

  it('calls onSelect(null) when the selected card is clicked again (toggle)', () => {
    const onSelect = vi.fn();
    render(
      <ActiveRequestsPanel
        requests={[makeRequest({ id: 7 })]}
        selectedId={7}
        onSelect={onSelect}
      />,
    );

    fireEvent.click(screen.getByTestId('active-request-7'));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('renders the request status in Uzbek', () => {
    render(
      <ActiveRequestsPanel
        requests={[makeRequest({ id: 1, status: 'PRODUCING' })]}
        selectedId={null}
        onSelect={() => {}}
      />,
    );

    expect(screen.getByText(/sex ishlab chiqarmoqda/i)).toBeInTheDocument();
  });
});
