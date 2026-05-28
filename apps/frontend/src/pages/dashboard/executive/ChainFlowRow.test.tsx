import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ChainFlowRow, type ChainFlowNode } from './ChainFlowRow';
import type { ChainCardSummary } from './ChainCard';

const SUMMARY: ChainCardSummary = {
  countLabel: '1',
  status: 'ok',
  stats: [
    { label: 'A', value: '1' },
    { label: 'B', value: '2' },
    { label: 'C', value: '3' },
    { label: 'D', value: '4' },
  ],
};

const NODES: ChainFlowNode[] = [
  { type: 'raw_warehouse', title: 'Xom-ashyo ombori', summary: SUMMARY },
  { type: 'production', title: 'Ishlab chiqarish', summary: SUMMARY },
  { type: 'supply', title: "Ta'minot bo'limi", summary: SUMMARY },
  { type: 'central_warehouse', title: 'Markaziy sklad', summary: SUMMARY },
  { type: 'store', title: "Do'konlar", summary: SUMMARY },
];

describe('ChainFlowRow', () => {
  it('renders five chain cards', () => {
    render(
      <ChainFlowRow nodes={NODES} selectedType={null} onSelect={() => {}} />,
    );
    expect(screen.getByTestId('chain-card-raw_warehouse')).toBeInTheDocument();
    expect(screen.getByTestId('chain-card-production')).toBeInTheDocument();
    expect(screen.getByTestId('chain-card-supply')).toBeInTheDocument();
    expect(
      screen.getByTestId('chain-card-central_warehouse'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('chain-card-store')).toBeInTheDocument();
  });

  it('lays out three cards on the top row and two on the bottom row', () => {
    const { container } = render(
      <ChainFlowRow nodes={NODES} selectedType={null} onSelect={() => {}} />,
    );
    const rows = container.querySelectorAll(
      '[data-testid="chain-flow-row"] > div',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.querySelectorAll('[role="button"]')).toHaveLength(3);
    expect(rows[1]?.querySelectorAll('[role="button"]')).toHaveLength(2);
  });

  it('calls onSelect with the clicked card type', () => {
    const onSelect = vi.fn();
    render(
      <ChainFlowRow
        nodes={NODES}
        selectedType={null}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByTestId('chain-card-production'));
    expect(onSelect).toHaveBeenCalledWith('production');
  });

  it('toggles selection off when clicking the already-selected card', () => {
    const onSelect = vi.fn();
    render(
      <ChainFlowRow
        nodes={NODES}
        selectedType="production"
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByTestId('chain-card-production'));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('marks the selected card with aria-pressed="true"', () => {
    render(
      <ChainFlowRow
        nodes={NODES}
        selectedType="store"
        onSelect={() => {}}
      />,
    );
    const card = screen.getByTestId('chain-card-store');
    expect(card.getAttribute('aria-pressed')).toBe('true');
    const otherCard = screen.getByTestId('chain-card-raw_warehouse');
    expect(otherCard.getAttribute('aria-pressed')).toBe('false');
  });
});
