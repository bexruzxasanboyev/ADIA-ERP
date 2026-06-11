/**
 * Dashboard v3 — Variant B "Calm Canvas" — ChainNode contract test.
 *
 * Standalone tests for the custom React Flow node — render, status dot,
 * click + keyboard activation, and the 2-stat KPI grid.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ReactFlowProvider } from 'reactflow';
import { ChainNode, type ChainNodeData } from './ChainNode';

function renderNode(data: ChainNodeData) {
  // ChainNode is a React Flow node; React Flow's hooks need a provider
  // even outside the canvas. We render it raw with the minimum NodeProps
  // surface the component consumes.
  return render(
    <ReactFlowProvider>
      <ChainNode
        id="raw_warehouse"
        type="chainNode"
        data={data}
        selected={false}
        dragging={false}
        isConnectable={false}
        zIndex={0}
        xPos={0}
        yPos={0}
      />
    </ReactFlowProvider>,
  );
}

const BASE: ChainNodeData = {
  type: 'raw_warehouse',
  title: 'Xom-ashyo ombori',
  status: 'ok',
  stats: [
    { label: "Min'dan past", value: '0' },
    { label: 'Ochiq PO', value: '2', tone: 'warning' },
  ],
};

describe('ChainNode', () => {
  it('renders the title and the two stat cells', () => {
    renderNode(BASE);
    expect(screen.getByText('Xom-ashyo ombori')).toBeInTheDocument();
    expect(screen.getByText("Min'dan past")).toBeInTheDocument();
    expect(screen.getByText('Ochiq PO')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('exposes status via data-status', () => {
    renderNode({ ...BASE, status: 'danger' });
    expect(
      screen.getByTestId('chain-node-raw_warehouse').getAttribute('data-status'),
    ).toBe('danger');
  });

  it('calls onSelect on click', () => {
    const onSelect = vi.fn();
    renderNode({ ...BASE, onSelect });
    fireEvent.click(screen.getByTestId('chain-node-raw_warehouse'));
    expect(onSelect).toHaveBeenCalledWith('raw_warehouse');
  });

  it('calls onSelect when activated by keyboard', () => {
    const onSelect = vi.fn();
    renderNode({ ...BASE, onSelect });
    const node = screen.getByTestId('chain-node-raw_warehouse');
    fireEvent.keyDown(node, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('raw_warehouse');

    onSelect.mockClear();
    fireEvent.keyDown(node, { key: ' ' });
    expect(onSelect).toHaveBeenCalledWith('raw_warehouse');
  });

  it('exposes selected state via aria-pressed and data-selected', () => {
    renderNode({ ...BASE, selected: true });
    const node = screen.getByTestId('chain-node-raw_warehouse');
    expect(node.getAttribute('aria-pressed')).toBe('true');
    expect(node.getAttribute('data-selected')).toBe('true');
  });
});
