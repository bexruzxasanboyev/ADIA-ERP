import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { CakeSlice, Menu } from 'lucide-react';
import { AppSidebar } from './AppSidebar';
import { AssistantButton } from './AssistantButton';
import { LocationSwitcher } from './LocationSwitcher';
import { Sheet, SheetContent } from '@/components/ui/sheet';

/**
 * Authenticated layout shell: persistent sidebar (lg+) + scrollable
 * content area. On viewports below `lg` (1024) the sidebar collapses
 * into a slide-in `Sheet` drawer; a hamburger button in the header
 * opens it, and any nav-link click auto-closes it.
 *
 * F4.1 — the top header hosts the `LocationSwitcher` for multi-location
 * users. On mobile it also shows the brand mark next to the hamburger
 * so the screen still feels rooted when the sidebar is hidden.
 *
 * F4.8 — full mobile responsive shell. Touch targets are 44px+, the
 * drawer auto-closes on navigate, and the active route also closes any
 * stale drawer state.
 */
export function AppLayout() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();

  // Auto-close the drawer whenever the route changes — covers programmatic
  // navigation, browser back/forward, and any link not wired through the
  // sidebar's onNavigate hook.
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background">
      <AppSidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border bg-background px-3 sm:px-6 lg:px-8">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              aria-label="Menyu"
              aria-expanded={drawerOpen}
              onClick={() => setDrawerOpen(true)}
              className="inline-flex size-10 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:hidden"
            >
              <Menu className="size-5" aria-hidden="true" />
            </button>
            <div className="flex min-w-0 items-center gap-2 lg:hidden">
              <CakeSlice
                className="size-5 shrink-0 text-primary"
                aria-hidden="true"
              />
              <span className="truncate text-sm font-semibold tracking-tight">
                ADIA ERP
              </span>
            </div>
          </div>
          <div className="flex min-w-0 items-center justify-end">
            <LocationSwitcher />
          </div>
        </header>
        <main className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
          <Outlet />
        </main>
      </div>

      {/* Mobile / tablet drawer — `lg+` users never see this Sheet
          because the inline AppSidebar above is visible instead and
          the hamburger button is hidden. */}
      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent side="left" className="w-72 p-0">
          <AppSidebar inDrawer onNavigate={() => setDrawerOpen(false)} />
        </SheetContent>
      </Sheet>

      <AssistantButton />
    </div>
  );
}
