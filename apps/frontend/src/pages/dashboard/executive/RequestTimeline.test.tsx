/**
 * RequestTimeline — contract test.
 *
 * Pins:
 *   • renders an empty placeholder when `detail` is null
 *   • renders one timeline step per transition
 *   • marks the most-recent step with `data-latest="true"`
 *   • surfaces the actor name (or "tizim" fallback)
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RequestTimeline } from './RequestTimeline';
import type {
  ReplenishmentDetail,
  ReplenishmentRequest,
  ReplenishmentTransition,
} from '@/lib/types';

function makeRequest(): ReplenishmentRequest {
  return {
    id: 100,
    product_id: 1,
    requester_location_id: 7,
    target_location_id: 4,
    qty_needed: 5,
    status: 'PRODUCING',
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
}

function tx(
  id: number,
  to: ReplenishmentTransition['to_status'],
  actor: string | null = null,
): ReplenishmentTransition {
  return {
    id,
    from_status: null,
    to_status: to,
    reason: null,
    actor_user_id: actor === null ? null : 1,
    actor_name: actor,
    created_at: '2026-05-25T08:00:00.000Z',
  };
}

describe('RequestTimeline', () => {
  it('renders an empty placeholder when detail is null', () => {
    render(<RequestTimeline detail={null} />);
    expect(screen.getByTestId('request-timeline-empty')).toBeInTheDocument();
  });

  it('renders one step per transition', () => {
    const detail: ReplenishmentDetail = {
      request: makeRequest(),
      transitions: [
        tx(1, 'NEW'),
        tx(2, 'CHECK_STORE_SUPPLIER'),
        tx(3, 'PRODUCING'),
      ],
    };
    render(<RequestTimeline detail={detail} />);

    expect(screen.getByTestId('timeline-step-1')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-step-2')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-step-3')).toBeInTheDocument();
  });

  it('marks the most-recent step as data-latest=true', () => {
    const detail: ReplenishmentDetail = {
      request: makeRequest(),
      transitions: [tx(1, 'NEW'), tx(2, 'PRODUCING')],
    };
    render(<RequestTimeline detail={detail} />);

    expect(screen.getByTestId('timeline-step-1')).toHaveAttribute(
      'data-latest',
      'false',
    );
    expect(screen.getByTestId('timeline-step-2')).toHaveAttribute(
      'data-latest',
      'true',
    );
  });

  it('shows the actor name, or "tizim" when null', () => {
    const detail: ReplenishmentDetail = {
      request: makeRequest(),
      transitions: [tx(1, 'NEW', 'Aziz'), tx(2, 'CHECK_STORE_SUPPLIER', null)],
    };
    render(<RequestTimeline detail={detail} />);

    expect(screen.getByText(/Aziz/)).toBeInTheDocument();
    expect(screen.getByText(/tizim/i)).toBeInTheDocument();
  });
});
