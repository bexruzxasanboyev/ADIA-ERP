import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { StoreManagerTabs } from './StoreManagerTabs';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <StoreManagerTabs />
    </MemoryRouter>,
  );
}

describe('StoreManagerTabs', () => {
  it('renders the three fixed top-level tabs', () => {
    renderAt('/store-workflow');
    expect(screen.getByTestId('store-manager-tabs')).toHaveAttribute(
      'role',
      'tablist',
    );
    expect(screen.getByTestId('store-manager-tab-store')).toBeInTheDocument();
    expect(screen.getByTestId('store-manager-tab-cashier')).toBeInTheDocument();
    expect(
      screen.getByTestId('store-manager-tab-forecasts'),
    ).toBeInTheDocument();
  });

  it('marks Do‘kon active on /store-workflow', () => {
    renderAt('/store-workflow');
    expect(screen.getByTestId('store-manager-tab-store')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByTestId('store-manager-tab-cashier')).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });

  it('marks Kassa active on any /cashier sub-page', () => {
    renderAt('/cashier/shifts');
    expect(screen.getByTestId('store-manager-tab-cashier')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByTestId('store-manager-tab-store')).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });

  it('marks Bashorat active on /forecasts', () => {
    renderAt('/forecasts');
    expect(screen.getByTestId('store-manager-tab-forecasts')).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('links each tab to its route', () => {
    renderAt('/store-workflow');
    expect(screen.getByTestId('store-manager-tab-store')).toHaveAttribute(
      'href',
      '/store-workflow',
    );
    expect(screen.getByTestId('store-manager-tab-cashier')).toHaveAttribute(
      'href',
      '/cashier/receipts',
    );
    expect(screen.getByTestId('store-manager-tab-forecasts')).toHaveAttribute(
      'href',
      '/forecasts',
    );
  });
});
