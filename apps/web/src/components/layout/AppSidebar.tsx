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
import { navItemsForRole } from '@/lib/navigation';
import { useAuth } from '@/hooks/useAuth';

/** Uzbek display labels for RBAC roles. */
const ROLE_LABELS: Record<string, string> = {
  pm: 'Loyiha rahbari',
  raw_warehouse_manager: 'Xom-ashyo ombori boshlig‘i',
  production_manager: 'Ishlab chiqarish boshlig‘i',
  supply_manager: 'Ta’minot boshlig‘i',
  central_warehouse_manager: 'Markaziy sklad boshlig‘i',
  store_manager: 'Do‘kon boshlig‘i',
};

export function AppSidebar() {
  const { user, logout } = useAuth();
  const items = user ? navItemsForRole(user.role) : [];

  return (
    <Sidebar>
      <SidebarHeader>
        <CakeSlice className="size-6 text-primary" aria-hidden="true" />
        <span className="text-base font-semibold tracking-tight">CAKE ERP</span>
      </SidebarHeader>

      <SidebarContent>
        <SidebarSectionLabel>Modullar</SidebarSectionLabel>
        {items.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
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
      </SidebarContent>

      <SidebarFooter>
        {user && (
          <div className="mb-2 px-1">
            <p className="truncate text-sm font-medium text-foreground">
              {user.name}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {ROLE_LABELS[user.role] ?? user.role}
            </p>
          </div>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start text-muted-foreground"
          onClick={logout}
        >
          <LogOut className="size-4" aria-hidden="true" />
          Chiqish
        </Button>
      </SidebarFooter>
    </Sidebar>
  );
}
