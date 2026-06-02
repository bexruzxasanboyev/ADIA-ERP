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

    // Secondary (non-home-tile) modules screens are present.
    for (const key of [
      'replenishment',
      'sorovnomalar',
      'production-orders',
      'purchase-orders',
    ]) {
      expect(within(list).getByTestId(`page-tab-${key}`)).toBeInTheDocument();
    }

    // The 11 home-tile modules are NOT in the tab strip.
    for (const key of [
      'raw-warehouse',
      'production',
      'supply',
      'central-warehouse',
      'stores',
    ]) {
      expect(within(list).queryByTestId(`page-tab-${key}`)).not.toBeInTheDocument();
    }
  });

  it('marks the tab matching the current route as aria-selected', () => {
    renderTabs({ group: 'modules', role: 'pm', initialPath: '/production-orders' });
    const active = screen.getByTestId('page-tab-production-orders');
    expect(active).toHaveAttribute('aria-selected', 'true');

    const other = screen.getByTestId('page-tab-replenishment');
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
    // store_manager sees only /replenishment + /sorovnomalar among the
    // secondary modules screens; the home-tile modules are excluded for
    // everyone.
    renderTabs({ group: 'modules', role: 'store_manager', initialPath: '/replenishment' });
    const list = screen.getByTestId('page-tabs');
    expect(within(list).getByTestId('page-tab-replenishment')).toBeInTheDocument();
    expect(within(list).getByTestId('page-tab-sorovnomalar')).toBeInTheDocument();
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
