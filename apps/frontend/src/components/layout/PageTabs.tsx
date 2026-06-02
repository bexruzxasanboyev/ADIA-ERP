import { NavLink, useLocation } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/useAuth';
import {
  NAV_SECTIONS,
  HOME_TILE_PATHS,
  type NavGroupKey,
} from '@/lib/navigation';

interface PageTabsProps {
  /** Which group to render tabs for. */
  group: NavGroupKey;
}

/**
 * Jira-style sub-tab strip rendered centered inside the global app
 * header for every route in a tabbed nav group (Modullar, Ma'lumotnoma,
 * Kassa). Each tab is a NavLink that drives an `aria-selected` state
 * from React Router so screen readers and keyboard users see the active
 * section.
 *
 * Items are RBAC-filtered against the active user's role, then the 11
 * PRIMARY modules (`HOME_TILE_PATHS`) are excluded — those live on the
 * Home launcher. So PageTabs surfaces only the SECONDARY screens of a
 * group (e.g. To'ldirish so'rovlari, Sotib olish so'rovlari for
 * Modullar; cashier shifts/nakladnoy/safe for Kassa). If nothing
 * remains after filtering (e.g. the Ma'lumotnoma group, whose pages are
 * all home tiles), the strip is not rendered.
 *
 * The strip scrolls horizontally with a thin scrollbar if the tabs
 * overflow the available header width.
 */
export function PageTabs({ group }: PageTabsProps) {
  const { user } = useAuth();
  const location = useLocation();
  const section = NAV_SECTIONS.find((s) => s.key === group);
  if (!section || !user) return null;

  // Exclude the 11 PRIMARY modules (they live on the Home launcher) — EXCEPT
  // for the Kassa group, where "Cheklar" (the /cashier/receipts landing) must
  // also appear as a tab alongside Smenalar / Nakladnoylar / Seyf so the
  // cashier can switch back to the receipts list from any cashier sub-page.
  const items = section.items.filter(
    (item) =>
      item.roles.includes(user.role) &&
      (group === 'cashier' || !HOME_TILE_PATHS.has(item.path)),
  );
  if (items.length === 0) return null;

  return (
    <div
      role="tablist"
      aria-label={section.label}
      data-testid="page-tabs"
      className="scrollbar-thin flex max-w-full items-center gap-1 overflow-x-auto"
    >
      {items.map((item) => {
        const isActive =
          location.pathname === item.path ||
          location.pathname.startsWith(`${item.path}/`);
        const tabKey = item.path.replace(/^\//, '');
        const Icon = item.icon;
        return (
          <NavLink
            key={item.path}
            to={item.path}
            role="tab"
            aria-selected={isActive}
            data-testid={`page-tab-${tabKey}`}
            className={cn(
              'inline-flex shrink-0 items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              isActive
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            <Icon className="size-4 shrink-0" aria-hidden="true" />
            {item.label}
          </NavLink>
        );
      })}
    </div>
  );
}
