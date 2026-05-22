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

  it('drops empty sections', () => {
    const sections = navSectionsForRole('production_manager');
    for (const section of sections) {
      expect(section.items.length).toBeGreaterThan(0);
    }
  });
});
