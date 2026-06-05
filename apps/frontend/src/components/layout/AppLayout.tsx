import { Link, Outlet, useLocation } from 'react-router-dom';
import { CakeSlice, CircleUser } from 'lucide-react';
import { AssistantButton } from './AssistantButton';
import { LocationSwitcher } from './LocationSwitcher';
import { PageTabs } from './PageTabs';
import { findGroupForPath } from '@/lib/navigation';
import {
  HeaderSlotProvider,
  useHeaderActionsContent,
  useHeaderCenterContent,
} from './HeaderSlot';

/**
 * Authenticated inner-page layout shell (IA redesign).
 *
 * The left sidebar / icon rail and the mobile drawer are gone; the
 * PRIMARY modules live on the Home launcher (`/home`). The header logo
 * links back to it. The centred sub-tabs (PageTabs) are restored but
 * CURATED: they surface only the SECONDARY screens of the active nav
 * group (the home-tile modules are excluded), so secondary pages stay
 * reachable from any page in their group.
 *
 * Header layout:
 *   - left:   ADIA ERP logo → Link to /home
 *   - center: the dashboard's header center slot (greeting + date +
 *             clock + range) when present; otherwise the active group's
 *             secondary-page tabs (PageTabs) for tabbed groups
 *   - right:  LocationSwitcher + Profil link
 *
 * The theme toggle and "Chiqish" (logout) moved to the Profil page.
 */
export function AppLayout() {
  return (
    <HeaderSlotProvider>
      <AppLayoutShell />
    </HeaderSlotProvider>
  );
}

function AppLayoutShell() {
  const centerSlot = useHeaderCenterContent();
  const actionsSlot = useHeaderActionsContent();
  const location = useLocation();

  // Restore the centred sub-tabs — but only for tabbed groups, and the
  // page-supplied center slot (the dashboard greeting/range) always wins
  // when present. PageTabs itself returns null if the group has no
  // secondary (non-home-tile) screens for this role.
  const group = findGroupForPath(location.pathname);
  const showTabs = !centerSlot && group?.hasTabs === true;

  return (
    <div className="flex h-screen w-full flex-col overflow-hidden bg-background">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-3 sm:px-6 lg:px-8">
        <Link
          to="/home"
          className="flex min-w-0 shrink-0 items-center gap-2 rounded-md px-1 py-1 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Bosh sahifa"
          title="Bosh sahifaga qaytish"
        >
          <CakeSlice className="size-5 shrink-0 text-primary" aria-hidden="true" />
          {/* Show WHICH section the user is in (the active nav group), so the
              header reads "where am I" — not just the brand. Falls back to the
              brand name on pages with no group (e.g. the Home launcher). */}
          <span className="hidden truncate text-base font-semibold tracking-tight sm:inline">
            {group?.label ?? 'ADIA ERP'}
          </span>
        </Link>

        {/* Center — the dashboard fills this with greeting + date + clock
            + range; for tabbed groups without a center slot we render the
            curated secondary-page tabs (PageTabs). The page ACTION buttons
            drop into the content row below. Scrolls horizontally on narrow
            screens so a wide center slot doesn't push the right-hand
            controls off-screen. */}
        <div className="flex min-w-0 flex-1 items-center justify-center overflow-x-auto">
          {centerSlot}
          {showTabs && group && <PageTabs group={group.key} />}
        </div>

        {/* Right — LocationSwitcher + Profil. */}
        <div className="flex shrink-0 items-center justify-end gap-1 sm:gap-2">
          <LocationSwitcher />
          <Link
            to="/profile"
            className="inline-flex items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Profil"
            title="Profil"
          >
            <CircleUser className="size-5" aria-hidden="true" />
            <span className="hidden lg:inline">Profil</span>
          </Link>
        </div>
      </header>
      <main className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
        {actionsSlot && <div className="mb-4">{actionsSlot}</div>}
        <Outlet />
      </main>

      <AssistantButton />
    </div>
  );
}
