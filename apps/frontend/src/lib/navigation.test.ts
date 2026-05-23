import { describe, it, expect } from 'vitest';
import { navSectionsForRole } from './navigation';

describe('navSectionsForRole', () => {
  it('gives pm every module plus the Users reference screen', () => {
    const sections = navSectionsForRole('pm');
    const paths = sections.flatMap((s) => s.items.map((i) => i.path));
    expect(paths).toContain('/users');
    expect(paths).toContain('/locations');
    expect(paths).toContain('/products');
    expect(paths).toContain('/raw-warehouse');
  });

  it('hides Users from non-pm roles', () => {
    const sections = navSectionsForRole('store_manager');
    const paths = sections.flatMap((s) => s.items.map((i) => i.path));
    expect(paths).not.toContain('/users');
  });

  it('scopes module screens to the owning role', () => {
    const paths = navSectionsForRole('store_manager').flatMap((s) =>
      s.items.map((i) => i.path),
    );
    expect(paths).toContain('/stores');
    expect(paths).not.toContain('/raw-warehouse');
    expect(paths).not.toContain('/production');
  });

  it('exposes production-orders to production / central-warehouse / pm', () => {
    expect(
      navSectionsForRole('production_manager').flatMap((s) =>
        s.items.map((i) => i.path),
      ),
    ).toContain('/production-orders');
    expect(
      navSectionsForRole('central_warehouse_manager').flatMap((s) =>
        s.items.map((i) => i.path),
      ),
    ).toContain('/production-orders');
    expect(
      navSectionsForRole('store_manager').flatMap((s) =>
        s.items.map((i) => i.path),
      ),
    ).not.toContain('/production-orders');
  });

  it('exposes purchase-orders to supply / raw-warehouse / pm', () => {
    expect(
      navSectionsForRole('supply_manager').flatMap((s) =>
        s.items.map((i) => i.path),
      ),
    ).toContain('/purchase-orders');
    expect(
      navSectionsForRole('raw_warehouse_manager').flatMap((s) =>
        s.items.map((i) => i.path),
      ),
    ).toContain('/purchase-orders');
    expect(
      navSectionsForRole('store_manager').flatMap((s) =>
        s.items.map((i) => i.path),
      ),
    ).not.toContain('/purchase-orders');
  });

  it('drops empty sections', () => {
    const sections = navSectionsForRole('production_manager');
    for (const section of sections) {
      expect(section.items.length).toBeGreaterThan(0);
    }
  });
});
