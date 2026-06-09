import { NavLink, useLocation } from 'react-router-dom';
import { Store, Wallet, TrendingUp, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Fixed three-tab top navigation for the `store_manager` role.
 *
 * Unlike PageTabs (which surfaces the SECONDARY screens of the active nav
 * group), this is a CROSS-AREA top-level switcher: the store manager never
 * sees the /home launcher, so these three tabs ARE their primary navigation.
 *
 *   Do'kon    → /store-workflow   (their store workspace)
 *   Kassa     → /cashier/receipts (receipts; cashier sub-pages live under /cashier/*)
 *   Bashorat  → /forecasts
 *
 * The active tab is derived from a path PREFIX so any sub-page under an area
 * (e.g. /cashier/shifts) keeps its parent tab highlighted. Markup/styling
 * mirrors PageTabs for visual consistency.
 */
interface StoreManagerTab {
  /** Route the tab links to. */
  to: string;
  /** Uzbek label (UI text is Uzbek). */
  label: string;
  icon: LucideIcon;
  /**
   * Path prefixes that mark this tab active. The tab is active when the
   * current pathname equals or starts with any of these.
   */
  match: readonly string[];
  /** Stable test id suffix. */
  testId: string;
}

const STORE_MANAGER_TABS: readonly StoreManagerTab[] = [
  {
    to: '/store-workflow',
    label: 'Do‘kon',
    icon: Store,
    match: ['/store-workflow', '/stores'],
    testId: 'store',
  },
  {
    to: '/cashier/receipts',
    label: 'Kassa',
    icon: Wallet,
    match: ['/cashier'],
    testId: 'cashier',
  },
  {
    to: '/forecasts',
    label: 'Bashorat',
    icon: TrendingUp,
    match: ['/forecasts'],
    testId: 'forecasts',
  },
];

function isTabActive(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export function StoreManagerTabs() {
  const location = useLocation();

  return (
    <div
      role="tablist"
      aria-label="Asosiy bo‘limlar"
      data-testid="store-manager-tabs"
      className="scrollbar-thin flex max-w-full items-center gap-1 overflow-x-auto rounded-xl border border-border/70 bg-surface-1 p-1"
    >
      {STORE_MANAGER_TABS.map((tab) => {
        const isActive = isTabActive(location.pathname, tab.match);
        const Icon = tab.icon;
        return (
          <NavLink
            key={tab.to}
            to={tab.to}
            role="tab"
            aria-selected={isActive}
            data-testid={`store-manager-tab-${tab.testId}`}
            className={cn(
              'inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              isActive
                ? 'bg-primary/15 text-primary ring-1 ring-inset ring-primary/25'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
            )}
          >
            <Icon className="size-4 shrink-0" aria-hidden="true" />
            {tab.label}
          </NavLink>
        );
      })}
    </div>
  );
}
