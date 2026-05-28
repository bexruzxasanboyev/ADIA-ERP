/**
 * Dashboard v3 — Variant B "Calm Canvas" — CanvasFlow contract test.
 *
 * The chain canvas renders one React Flow node per supply-chain stage
 * (raw → production → supply, central → store) and five animated edges
  * connecting them. Clicking a node bubbles up to `onSelectChain` so the
 * existing ChainDetailSheet can open.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CanvasFlow } from './CanvasFlow';
import type { ChainSummaryNode } from '@/lib/types';

const CHAIN_SUMMARY: ChainSummaryNode[] = [
  {
    type: 'raw_warehouse',
    location_count: 1,
    total_products: 12,
    below_min_count: 0,
    status: 'ok',
    pulse: {
      kind: 'raw',
      received_today: 0,
      issued_today: 5,
      pending_purchase_orders: 2,
      total_qty_by_unit: [],
    },
  },
  {
    type: 'production',
    location_count: 4,
    total_products: 6,
    below_min_count: 0,
    status: 'ok',
    pulse: {
      kind: 'production',
      active_orders: 3,
      done_today: 1,
      overdue_orders: 0,
      sex_count: 4,
      input_today: 10,
      output_today: 8,
    },
  },
  {
    type: 'supply',
    location_count: 1,
    total_products: 5,
    below_min_count: 0,
    status: 'ok',
    pulse: {
      kind: 'supply',
      shipped_today: 2,
      received_today: 3,
      open_requests: 1,
      top_destination_count: 1,
    },
  },
  {
    type: 'central_warehouse',
    location_count: 1,
    total_products: 25,
    below_min_count: 1,
    status: 'warn',
    pulse: {
      kind: 'central',
      last_sync_at: '2026-05-25T08:00:00.000Z',
      last_sync_status: 'ok',
      sync_errors_24h: 0,
    },
  },
  {
    type: 'store',
    location_count: 6,
    total_products: 18,
    below_min_count: 2,
    status: 'danger',
    pulse: {
      kind: 'store',
      sales_today_sum: 2_400_000,
      receipts_today: 87,
      avg_receipt_today: 27_586,
      open_replenishments: 0,
      transit_count: 0,
      top_product_name: 'Non',
      qty_today: 0,
    },
  },
];

describe('CanvasFlow', () => {
  it('renders one chain-node per supply-chain stage', () => {
    render(
      <CanvasFlow
        chainSummary={CHAIN_SUMMARY}
        selectedChain={null}
        onSelectChain={() => {}}
      />,
    );

    expect(screen.getByTestId('canvas-flow')).toBeInTheDocument();
    expect(screen.getByTestId('chain-node-raw_warehouse')).toBeInTheDocument();
    expect(screen.getByTestId('chain-node-production')).toBeInTheDocument();
    expect(screen.getByTestId('chain-node-supply')).toBeInTheDocument();
    expect(
      screen.getByTestId('chain-node-central_warehouse'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('chain-node-store')).toBeInTheDocument();
  });

  it('reflects the node status from chain_summary', () => {
    render(
      <CanvasFlow
        chainSummary={CHAIN_SUMMARY}
        selectedChain={null}
        onSelectChain={() => {}}
      />,
    );

    expect(
      screen.getByTestId('chain-node-store').getAttribute('data-status'),
    ).toBe('danger');
    expect(
      screen
        .getByTestId('chain-node-central_warehouse')
        .getAttribute('data-status'),
    ).toBe('warn');
  });

  it('marks the selected chain node', () => {
    render(
      <CanvasFlow
        chainSummary={CHAIN_SUMMARY}
        selectedChain="production"
        onSelectChain={() => {}}
      />,
    );

    expect(
      screen
        .getByTestId('chain-node-production')
        .getAttribute('data-selected'),
    ).toBe('true');
    expect(
      screen
        .getByTestId('chain-node-supply')
        .getAttribute('data-selected'),
    ).toBe('false');
  });

  it('invokes onSelectChain when a node is clicked', () => {
    const onSelect = vi.fn();
    render(
      <CanvasFlow
        chainSummary={CHAIN_SUMMARY}
        selectedChain={null}
        onSelectChain={onSelect}
      />,
    );

    fireEvent.click(screen.getByTestId('chain-node-raw_warehouse'));
    expect(onSelect).toHaveBeenCalledWith('raw_warehouse');
  });

  it('toggles selection off when clicking the active node again', () => {
    const onSelect = vi.fn();
    render(
      <CanvasFlow
        chainSummary={CHAIN_SUMMARY}
        selectedChain="production"
        onSelectChain={onSelect}
      />,
    );

    fireEvent.click(screen.getByTestId('chain-node-production'));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('renders empty-state stats when chain_summary is empty', () => {
    render(
      <CanvasFlow
        chainSummary={[]}
        selectedChain={null}
        onSelectChain={() => {}}
      />,
    );

    expect(screen.getByTestId('chain-node-raw_warehouse')).toBeInTheDocument();
    expect(
      screen
        .getByTestId('chain-node-raw_warehouse')
        .getAttribute('data-status'),
    ).toBe('ok');
  });
});
