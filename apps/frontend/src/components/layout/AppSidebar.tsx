import { NavLink } from 'react-router-dom';
import { CakeSlice, LogOut } from 'lucide-react';
import {
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarSectionLabel,
} from '@/components/ui/sidebar';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { navSectionsForRole } from '@/lib/navigation';
import { ROLE_LABELS } from '@/lib/labels';
import { useAuth } from '@/hooks/useAuth';

interface AppSidebarProps {
  /**
   * Called after a nav link is clicked. The mobile drawer wraps the
   * sidebar in a Sheet and uses this hook to auto-close on navigate so
   * the user lands on the target screen without manually dismissing.
   */
  onNavigate?: () => void;
  /** When `true`, omit the `aside` chrome — caller supplies the shell. */
  inDrawer?: boolean;
}

export function AppSidebar({ onNavigate, inDrawer = false }: AppSidebarProps) {
  const { user, logout } = useAuth();
  const sections = user ? navSectionsForRole(user.role) : [];

  const body = (
    <>
      <SidebarHeader>
        <CakeSlice className="size-6 text-primary" aria-hidden="true" />
        <span className="text-base font-semibold tracking-tight">ADIA ERP</span>
      </SidebarHeader>

      <SidebarContent>
        {sections.map((section) => (
          <div key={section.label}>
            <SidebarSectionLabel>{section.label}</SidebarSectionLabel>
            {section.items.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                onClick={onNavigate}
                className={({ isActive }) =>
                  cn(
                    'flex min-h-11 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    isActive
                      ? 'bg-sidebar-accent text-foreground'
                      : 'text-muted-foreground hover:bg-sidebar-accent hover:text-foreground',
                  )
                }
              >
                <item.icon className="size-4 shrink-0" aria-hidden="true" />
                <span>{item.label}</span>
              </NavLink>
            ))}
          </div>
        ))}
      </SidebarContent>

      <SidebarFooter>
        {user && (
          <div className="mb-2 px-1">
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
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start text-muted-foreground"
          onClick={() => {
            void logout();
          }}
        >
          <LogOut className="size-4" aria-hidden="true" />
          Chiqish
        </Button>
      </SidebarFooter>
    </>
  );

  if (inDrawer) {
    // Inside the Sheet drawer — no `aside` element so the Sheet wrapper
    // owns the layout / border / focus chrome.
    return <div className="flex h-full flex-col">{body}</div>;
  }

  return <Sidebar>{body}</Sidebar>;
}
