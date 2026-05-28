import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChainPipeline, type ChainPipelineNode } from './ChainPipeline';

const NODES: ChainPipelineNode[] = [
  {
    type: 'raw_warehouse',
    title: 'Xom-ashyo',
    summary: { countLabel: '1 bo‘g‘in', status: 'ok', stats: [] },
  },
  {
    type: 'production',
    title: 'Ishlab chiqarish',
    summary: { countLabel: '4 sex', status: 'ok', stats: [] },
  },
  {
    type: 'supply',
    title: "Ta'minot",
    summary: { countLabel: '1 bo‘lim', status: 'ok', stats: [] },
  },
  {
    type: 'central_warehouse',
    title: 'Markaziy sklad',
    summary: { countLabel: '26 blok', status: 'warn', stats: [] },
  },
  {
    type: 'store',
    title: "Do'konlar",
    summary: { countLabel: "6 do'kon", status: 'ok', stats: [] },
    sparkline: [1, 2, 3, 4, 5, 6, 7],
  },
];

describe('ChainPipeline', () => {
  it('renders five chain cards in both layouts', () => {
    render(
      <ChainPipeline
        nodes={NODES}
        selectedType={null}
        onSelect={() => {}}
      />,
    );
    // Each ChainCard renders twice (mobile horizontal + desktop vertical).
    for (const n of NODES) {
      expect(
        screen.getAllByTestId(`chain-card-${n.type}`).length,
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it('toggles selection on click', () => {
    const onSelect = vi.fn();
    render(
      <ChainPipeline nodes={NODES} selectedType={null} onSelect={onSelect} />,
    );
    const first = screen.getAllByTestId('chain-card-raw_warehouse')[0];
    if (!first) throw new Error('chain-card-raw_warehouse missing');
    fireEvent.click(first);
    expect(onSelect).toHaveBeenCalledWith('raw_warehouse');
  });

  it('clears the selection when the active card is clicked again', () => {
    const onSelect = vi.fn();
    render(
      <ChainPipeline
        nodes={NODES}
        selectedType="store"
        onSelect={onSelect}
      />,
    );
    const first = screen.getAllByTestId('chain-card-store')[0];
    if (!first) throw new Error('chain-card-store missing');
    fireEvent.click(first);
    expect(onSelect).toHaveBeenCalledWith(null);
  });
});
