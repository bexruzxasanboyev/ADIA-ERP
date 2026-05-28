/**
 * CanvasTabs — pill segment control contract test.
 *
 * Pins the WAI-ARIA tablist semantics, the click handler, and the
 * `data-state` attribute used by other components / E2E to assert
 * which view is active.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CanvasTabs, type CanvasView } from './CanvasTabs';

function renderTabs(initial: CanvasView, onChange = vi.fn()) {
  return { onChange, ...render(<CanvasTabs view={initial} onChange={onChange} />) };
}

describe('CanvasTabs', () => {
  it('renders a tablist with two tabs', () => {
    renderTabs('calm');

    const tablist = screen.getByRole('tablist');
    expect(tablist).toBeInTheDocument();
    expect(tablist).toHaveAttribute('aria-label', "Canvas ko'rinish rejimi");

    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(2);
  });

  it('marks the active tab as aria-selected', () => {
    renderTabs('calm');

    expect(screen.getByTestId('canvas-tab-calm')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByTestId('canvas-tab-calm')).toHaveAttribute(
      'data-state',
      'active',
    );
    expect(screen.getByTestId('canvas-tab-detail')).toHaveAttribute(
      'aria-selected',
      'false',
    );
    expect(screen.getByTestId('canvas-tab-detail')).toHaveAttribute(
      'data-state',
      'inactive',
    );
  });

  it('fires onChange when an inactive tab is clicked', () => {
    const { onChange } = renderTabs('calm');

    fireEvent.click(screen.getByTestId('canvas-tab-detail'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('detail');
  });

  it('does not fire onChange when the active tab is clicked again', () => {
    const { onChange } = renderTabs('calm');

    fireEvent.click(screen.getByTestId('canvas-tab-calm'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('renders Detalli as active when view=detail', () => {
    renderTabs('detail');

    expect(screen.getByTestId('canvas-tab-detail')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByTestId('canvas-tab-calm')).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });
});
