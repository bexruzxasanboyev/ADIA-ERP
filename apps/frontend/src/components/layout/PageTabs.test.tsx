import { describe, it, expect } from 'vitest';
import { screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { render } from '@testing-library/react';
import { PageTabs } from './PageTabs';
import { ToastProvider } from '@/components/ui/toast';
import { AuthContext, type AuthContextValue } from '@/hooks/auth-context';
import type { Role, User } from '@/lib/types';

function fakeUser(role: Role): User {
  return {
    id: 1,
    name: `Test ${role}`,
    username: role,
    role,
    location_id: null,
  };
}

function fakeAuth(user: User): AuthContextValue {
  return {
    user,
    token: 'test-token',
    isAuthenticated: true,
    isHydrating: false,
    locations: [],
    activeLocationId: null,
    login: () => {},
    logout: async () => {},
    updateUser: () => {},
    setActiveLocation: async () => {},
  };
}

function renderTabs(opts: {
  group: 'dashboard' | 'forecasts' | 'modules' | 'cashier' | 'reference';
  role: Role;
  initialPath: string;
}) {
  const user = fakeUser(opts.role);
  return render(
    <AuthContext.Provider value={fakeAuth(user)}>
      <ToastProvider>
        <MemoryRouter initialEntries={[opts.initialPath]}>
          <PageTabs group={opts.group} />
        </MemoryRouter>
      </ToastProvider>
    </AuthContext.Provider>,
  );
}

describe('PageTabs', () => {
  it('renders only the SECONDARY modules tabs for pm (home-tile modules excluded)', () => {
    renderTabs({ group: 'modules', role: 'pm', initialPath: '/replenishment' });
    const list = screen.getByTestId('page-tabs');
    expect(list).toHaveAttribute('role', 'tablist');

    // Owner 2026-06-06 — the request pages collapsed into one unified hub,
    // so /replenishment ("So‘rovlar") is the only secondary modules tab.
    expect(
      within(list).getByTestId('page-tab-replenishment'),
    ).toBeInTheDocument();

    // The old separate request pages are no longer in the tab strip.
    for (const key of ['sorovnomalar', 'production-orders', 'purchase-orders']) {
      expect(within(list).queryByTestId(`page-tab-${key}`)).not.toBeInTheDocument();
    }

    // The home-tile modules (raw-warehouse / production / supply / stores)
    // are reached from the Home launcher, not the tab strip.
    for (const key of ['raw-warehouse', 'production', 'supply', 'stores']) {
      expect(within(list).queryByTestId(`page-tab-${key}`)).not.toBeInTheDocument();
    }
  });

  it('marks the tab matching the current route as aria-selected', () => {
    // Use the cashier group (multiple tabs) to exercise selected vs unselected.
    renderTabs({ group: 'cashier', role: 'pm', initialPath: '/cashier/shifts' });
    const active = screen.getByTestId('page-tab-cashier/shifts');
    expect(active).toHaveAttribute('aria-selected', 'true');

    const other = screen.getByTestId('page-tab-cashier/receipts');
    expect(other).toHaveAttribute('aria-selected', 'false');
  });

  it('keeps the parent tab active on nested routes (e.g. /replenishment/:id)', () => {
    renderTabs({
      group: 'modules',
      role: 'pm',
      initialPath: '/replenishment/42',
    });
    expect(screen.getByTestId('page-tab-replenishment')).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('filters tabs by RBAC — store_manager only sees their own scope', () => {
    // The unified /replenishment hub is visible to store_manager; the
    // home-tile modules and the removed request pages are not.
    renderTabs({ group: 'modules', role: 'store_manager', initialPath: '/replenishment' });
    const list = screen.getByTestId('page-tabs');
    expect(within(list).getByTestId('page-tab-replenishment')).toBeInTheDocument();
    expect(
      within(list).queryByTestId('page-tab-sorovnomalar'),
    ).not.toBeInTheDocument();
    expect(
      within(list).queryByTestId('page-tab-stores'),
    ).not.toBeInTheDocument();
    expect(
      within(list).queryByTestId('page-tab-purchase-orders'),
    ).not.toBeInTheDocument();
  });

  it('renders ALL cashier tabs incl. Cheklar (/cashier/receipts) — the Kassa group keeps its landing tab', () => {
    renderTabs({ group: 'cashier', role: 'pm', initialPath: '/cashier/shifts' });
    const list = screen.getByTestId('page-tabs');
    expect(within(list).getByTestId('page-tab-cashier/shifts')).toBeInTheDocument();
    expect(within(list).getByTestId('page-tab-cashier/nakladnoy')).toBeInTheDocument();
    expect(within(list).getByTestId('page-tab-cashier/safe')).toBeInTheDocument();
    // Unlike the other groups, the Kassa group is exempt from the home-tile
    // exclusion: "Cheklar" (/cashier/receipts) must remain reachable as a tab
    // from any cashier sub-page.
    expect(
      within(list).getByTestId('page-tab-cashier/receipts'),
    ).toBeInTheDocument();
  });

  it('renders nothing for the reference group (all its pages are home tiles)', () => {
    // Mahsulotlar / Bo‘g‘inlar / Hodimlar are home tiles; only /profile
    // remains, which is NOT in the reference items as a tab target here —
    // /profile IS a reference item but not a home tile, so it stays.
    renderTabs({ group: 'reference', role: 'pm', initialPath: '/products' });
    const list = screen.getByTestId('page-tabs');
    // Home-tile reference pages are excluded.
    expect(within(list).queryByTestId('page-tab-products')).not.toBeInTheDocument();
    expect(within(list).queryByTestId('page-tab-locations')).not.toBeInTheDocument();
    expect(within(list).queryByTestId('page-tab-employees')).not.toBeInTheDocument();
    // /profile is the only non-home-tile reference page → it remains.
    expect(within(list).getByTestId('page-tab-profile')).toBeInTheDocument();
  });

  it('renders nothing when the group key is unknown', () => {
    const user = fakeUser('store_manager');
    render(
      <AuthContext.Provider value={fakeAuth(user)}>
        <ToastProvider>
          <MemoryRouter>
            {/* @ts-expect-error — intentionally bad group key to test guard */}
            <PageTabs group="nonexistent" />
          </MemoryRouter>
        </ToastProvider>
      </AuthContext.Provider>,
    );
    expect(screen.queryByTestId('page-tabs')).not.toBeInTheDocument();
  });
});
