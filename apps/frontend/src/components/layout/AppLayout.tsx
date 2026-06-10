import { useEffect } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { CakeSlice, CircleUser } from 'lucide-react';
import { AssistantButton } from './AssistantButton';
import { LocationSwitcher } from './LocationSwitcher';
import { PageTabs } from './PageTabs';
import { StoreManagerTabs } from './StoreManagerTabs';
import {
  findGroupForPath,
  pageOwnsHeaderTabs,
  roleHomePath,
} from '@/lib/navigation';
import { useAuth } from '@/hooks/useAuth';
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
  const navigate = useNavigate();
  const { user, locations, activeLocationId } = useAuth();
  const isStoreManager = user?.role === 'store_manager';

  // Header title comes from the user's ACTUAL location (owner: "bu bo'limdan
  // kelib chiqishi kerak") — a single-location manager sees their real
  // location name (e.g. "Склад Центральный", "Кукча"), sourced from
  // /api/auth/me. Resolution mirrors LocationSwitcher: active → primary →
  // first. PMs / chain-wide users have no single location, so we fall back to
  // the active nav-group label below.
  const activeLocation =
    locations.find((l) => l.id === activeLocationId) ??
    locations.find((l) => l.is_primary) ??
    locations[0] ??
    null;

  // ESC → Bosh sahifa (owner request). A global shortcut, but it must NOT
  // hijack ESC when it is doing its normal job: closing an open dialog /
  // popover / dropdown, or clearing/blurring a focused text field. We bail in
  // those cases and only navigate from a "resting" page. Already on /home → no-op.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // A Radix overlay (Dialog/Popover/Select/DropdownMenu/Tooltip) is open —
      // let it consume ESC to close itself instead of navigating away.
      if (
        document.querySelector(
          '[role="dialog"],[role="menu"],[role="listbox"],[data-radix-popper-content-wrapper],[data-state="open"]',
        )
      ) {
        return;
      }
      // Don't yank focus away from someone mid-typing.
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.tagName === 'SELECT' ||
          t.isContentEditable)
      ) {
        return;
      }
      // Single-section managers' "home" is their OWN workspace (store /
      // central / production / raw) — one source of truth: roleHomePath.
      const home = roleHomePath(user?.role);
      if (location.pathname === home) return;
      navigate(home);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [navigate, location.pathname, user?.role]);

  // Restore the centred sub-tabs — but only for tabbed groups, and the
  // page-supplied center slot (the dashboard greeting/range) always wins
  // when present. PageTabs itself returns null if the group has no
  // secondary (non-home-tile) screens for this role.
  const group = findGroupForPath(location.pathname);
  // For non-store_manager roles the centred sub-tabs follow the active group —
  // UNLESS the current page owns its own in-page workspace tabs (e.g. /supply),
  // in which case the global group strip would stack a second tab layer on top
  // of the page's own and is suppressed (owner: "tepada headerdagi bo'limlar
  // kerak emas").
  const showTabs =
    !isStoreManager &&
    !centerSlot &&
    group?.hasTabs === true &&
    !pageOwnsHeaderTabs(location.pathname);
  // store_manager gets a FIXED three-tab top nav (Do'kon / Kassa / Bashorat)
  // as their PRIMARY navigation — they never see the /home launcher. The
  // page-supplied center slot (e.g. the dashboard greeting) still wins.
  const showStoreManagerTabs = isStoreManager && !centerSlot;

  return (
    <div className="app-ambient flex h-screen w-full flex-col overflow-hidden">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border/70 bg-surface-0/80 px-3 sm:px-6 lg:px-8">
        <Link
          to={roleHomePath(user?.role)}
          className="flex min-w-0 shrink-0 items-center gap-2 rounded-md px-1 py-1 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Bosh sahifa"
          title="Bosh sahifaga qaytish"
        >
          <CakeSlice className="size-6 shrink-0 text-primary" aria-hidden="true" />
          {/* Show WHERE the user is — their REAL location name when they are
              bound to one (manager), otherwise the active nav-group label
              (PM / chain-wide) and finally the brand on group-less pages
              (e.g. the Home launcher). The cake icon is the home button. */}
          <span className="hidden truncate text-lg font-bold tracking-tight sm:inline">
            {activeLocation?.name ?? group?.label ?? 'ADIA ERP'}
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
          {showStoreManagerTabs && <StoreManagerTabs />}
          {showTabs && group && <PageTabs group={group.key} />}
        </div>

        {/* Right — LocationSwitcher + Profil. */}
        <div className="flex shrink-0 items-center justify-end gap-1 sm:gap-2">
          <LocationSwitcher />
          {/* Profil — a real header icon button (circular avatar-style
              control): a CircleUser icon in a bordered, rounded-full button
              with a clear hover state. Navigates to /profile; stays
              accessible via aria-label + title. */}
          <Link
            to="/profile"
            className="inline-flex size-9 items-center justify-center rounded-full border border-border/70 bg-surface-1 text-muted-foreground transition-colors hover:border-primary/40 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Profil"
            title="Profil"
          >
            <CircleUser className="size-5" aria-hidden="true" />
          </Link>
        </div>
      </header>
      {/* Extra bottom padding keeps content clear of the fixed
          bottom-right floating button(s). */}
      {/* overflow-x-clip: full-bleed breakouts (w-screen boards) must never
          hand the main pane a horizontal scrollbar over the ~15px the vertical
          scrollbar steals from 100vw. */}
      <main className="flex-1 overflow-y-auto overflow-x-clip p-4 pb-24 sm:p-6 sm:pb-28 lg:p-8 lg:pb-28">
        {/* Cap content width on ultra-wide monitors so pages keep a
            readable measure instead of sprawling edge-to-edge. */}
        <div className="mx-auto w-full max-w-[1600px]">
          {actionsSlot && <div className="mb-4">{actionsSlot}</div>}
          <Outlet />
        </div>
      </main>

      <AssistantButton />
    </div>
  );
}
