import { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { CakeSlice, LogOut, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  navSectionsForRole,
  resolveGroupLanding,
  type NavSection,
} from '@/lib/navigation';
import { ROLE_LABELS } from '@/lib/labels';
import { useAuth } from '@/hooks/useAuth';
import { ThemeToggle } from './ThemeToggle';

interface AppSidebarProps {
  /**
   * Called after a nav link is clicked. The mobile drawer wraps the
   * sidebar in a Sheet and uses this hook to auto-close on navigate so
   * the user lands on the target screen without manually dismissing.
   */
  onNavigate?: () => void;
  /** When `true`, render in mobile drawer (labels visible). */
  inDrawer?: boolean;
  /** Desktop expanded/collapsed state — drives label visibility + width. */
  expanded?: boolean;
  /** Desktop toggle handler — flips expanded state. */
  onToggle?: () => void;
}

/**
 * Hybrid navigation rail (F4.13).
 *
 * Desktop: a collapsible rail showing one icon per nav group. The owner
 * can pin it open with the chevron toggle — when collapsed it's a 64px
 * icon strip; when expanded it widens to 224px and labels appear next
 * to the icons. Clicking the group icon navigates to its landing path
 * (`section.defaultPath`, falling back to the first item the user can
 * see). The active group — the one containing the current route — is
 * highlighted.
 *
 * Mobile drawer (`inDrawer=true`): the same icons rendered with
 * accompanying labels for thumb-friendly tap targets — the drawer is
 * always "expanded" so the toggle button is not shown.
 *
 * Sub-screens inside a group are rendered as pill tabs on the page
 * itself via the `<PageTabs />` component — they no longer live in the
 * sidebar.
 */
export function AppSidebar({
  onNavigate,
  inDrawer = false,
  expanded = false,
  onToggle,
}: AppSidebarProps) {
  const { user, logout } = useAuth();
  const location = useLocation();
  const sections = user ? navSectionsForRole(user.role) : [];
  // Hover-to-peek (desktop): when the rail is pinned collapsed,
  // hovering it widens the panel as an overlay *without* shifting the
  // page content. Clicking the pin toggle then locks the wider view in
  // place. The drawer mode bypasses this — it's always full-width.
  const [hovered, setHovered] = useState(false);
  const visualExpanded = inDrawer || expanded || hovered;

  // Labels are visible whenever the rail has room — either the mobile
  // drawer, the pinned-expanded state, or the hover-peek state.
  const showLabels = visualExpanded;

  const groupLinks = user
    ? sections
        .map((section) => {
          const landing = resolveGroupLanding(section, user.role);
          return landing ? { section, landing } : null;
        })
        .filter(
          (entry): entry is { section: NavSection; landing: string } =>
            entry !== null,
        )
    : [];

  // A group is active when the current path is one of its items (or
  // nested under one). Falls back to the first group when the path
  // is outside the nav (e.g. /admin/import-warnings) so the rail
  // never shows zero active items.
  const activeGroupKey =
    groupLinks.find(({ section }) =>
      section.items.some(
        (item) =>
          location.pathname === item.path ||
          location.pathname.startsWith(`${item.path}/`),
      ),
    )?.section.key ?? null;

  const body = (
    <>
      <div
        className={cn(
          'flex h-14 shrink-0 items-center gap-2 border-b border-sidebar-border',
          showLabels ? 'px-4' : 'justify-center px-0',
        )}
      >
        <CakeSlice className="size-6 shrink-0 text-primary" aria-hidden="true" />
        {showLabels && (
          <>
            <span className="flex-1 truncate text-base font-semibold tracking-tight">
              ADIA ERP
            </span>
            {!inDrawer && onToggle && (
              <button
                type="button"
                onClick={onToggle}
                data-testid="sidebar-toggle"
                aria-label={
                  expanded
                    ? "Sidebar'ni yig'ish"
                    : "Sidebar'ni mahkamlash"
                }
                aria-pressed={expanded}
                title={expanded ? "Yig'ish" : 'Mahkamlash'}
                className={cn(
                  'inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                )}
              >
                {expanded ? (
                  <PanelLeftClose className="size-4" aria-hidden="true" />
                ) : (
                  <PanelLeftOpen className="size-4" aria-hidden="true" />
                )}
              </button>
            )}
          </>
        )}
      </div>

      <nav
        aria-label="Asosiy navigatsiya"
        className="flex flex-1 flex-col gap-1 overflow-y-auto overflow-x-hidden p-2"
      >
        {groupLinks.map(({ section, landing }) => {
          const isActive = activeGroupKey === section.key;
          const Icon = section.icon;
          return (
            <NavLink
              key={section.key}
              to={landing}
              end={false}
              onClick={onNavigate}
              data-testid={`sidebar-group-${section.key}`}
              data-active={isActive ? 'true' : undefined}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'group flex min-h-11 items-center rounded-md text-sm font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                showLabels ? 'gap-3 px-3 py-2' : 'justify-center px-2 py-2',
                isActive
                  ? 'bg-sidebar-accent text-foreground'
                  : 'text-muted-foreground hover:bg-sidebar-accent hover:text-foreground',
              )}
              title={!showLabels ? section.label : undefined}
              aria-label={section.label}
            >
              <Icon className="size-5 shrink-0" aria-hidden="true" />
              {showLabels && (
                <span className="truncate">{section.label}</span>
              )}
            </NavLink>
          );
        })}
      </nav>

      <div
        className={cn(
          'flex flex-col gap-2 border-t border-sidebar-border',
          showLabels ? 'p-3' : 'items-center p-2',
        )}
      >
        {user && showLabels && (
          <div className="mb-1 px-1">
            <p className="truncate text-sm font-medium text-foreground">
              {user.name}
              {user.username && (
                <span className="ml-1 font-mono text-[11px] font-normal text-muted-foreground/80">
                  @{user.username}
                </span>
              )}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {ROLE_LABELS[user.role]}
            </p>
          </div>
        )}

        <ThemeToggle compact={!showLabels} />

        <Button
          variant="ghost"
          size="sm"
          className={cn(
            'text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive focus-visible:bg-destructive/15 focus-visible:text-destructive',
            showLabels ? 'w-full justify-start' : 'size-9 justify-center px-0',
          )}
          onClick={() => {
            void logout();
          }}
          title={!showLabels ? 'Chiqish' : undefined}
          aria-label="Chiqish"
        >
          <LogOut className="size-4" aria-hidden="true" />
          {showLabels && <span>Chiqish</span>}
        </Button>
      </div>
    </>
  );

  if (inDrawer) {
    return <div className="flex h-full flex-col">{body}</div>;
  }

  return (
    <aside
      data-testid="app-sidebar"
      data-expanded={expanded ? 'true' : 'false'}
      data-peek={!expanded && hovered ? 'true' : 'false'}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={cn(
        'fixed inset-y-0 left-0 z-30 hidden h-screen flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200 lg:flex',
        visualExpanded ? 'w-56' : 'w-16',
        // Pinned-expanded sidebar pushes content; hover-peek floats
        // over it (heavier shadow signals the overlay layer).
        !expanded && hovered ? 'shadow-2xl' : 'shadow-xl',
      )}
    >
      {body}
    </aside>
  );
}
