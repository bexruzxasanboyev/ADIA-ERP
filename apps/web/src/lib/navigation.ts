import {
  LayoutDashboard,
  Boxes,
  Factory,
  Truck,
  Warehouse,
  Store,
  RefreshCw,
  type LucideIcon,
} from 'lucide-react';
import type { Role } from './types';

/**
 * Role-scoped navigation. Each item is visible only to the listed roles —
 * derived from the RBAC matrix in docs/specs/phase-1-mvp.md §6.
 *
 * Faza-1 Sprint 0: routes are placeholders; the real module screens
 * arrive in Sprint 1+.
 */
export interface NavItem {
  /** Route path under the protected layout. */
  path: string;
  /** Uzbek menu label (UI text is Uzbek). */
  label: string;
  icon: LucideIcon;
  /** Roles allowed to see this item. */
  roles: readonly Role[];
}

const ALL_ROLES: readonly Role[] = [
  'pm',
  'raw_warehouse_manager',
  'production_manager',
  'supply_manager',
  'central_warehouse_manager',
  'store_manager',
];

export const NAV_ITEMS: readonly NavItem[] = [
  {
    path: '/dashboard',
    label: 'Boshqaruv paneli',
    icon: LayoutDashboard,
    roles: ALL_ROLES,
  },
  {
    path: '/raw-warehouse',
    label: 'Xom-ashyo ombori',
    icon: Boxes,
    roles: ['pm', 'raw_warehouse_manager'],
  },
  {
    path: '/production',
    label: 'Ishlab chiqarish',
    icon: Factory,
    roles: ['pm', 'production_manager'],
  },
  {
    path: '/supply',
    label: 'Ta’minot',
    icon: Truck,
    roles: ['pm', 'supply_manager'],
  },
  {
    path: '/central-warehouse',
    label: 'Markaziy sklad',
    icon: Warehouse,
    roles: ['pm', 'central_warehouse_manager'],
  },
  {
    path: '/stores',
    label: 'Do‘konlar',
    icon: Store,
    roles: ['pm', 'store_manager'],
  },
  {
    path: '/replenishment',
    label: 'To‘ldirish so‘rovlari',
    icon: RefreshCw,
    roles: [
      'pm',
      'raw_warehouse_manager',
      'production_manager',
      'supply_manager',
      'central_warehouse_manager',
      'store_manager',
    ],
  },
];

/** Filter navigation items down to those allowed for `role`. */
export function navItemsForRole(role: Role): NavItem[] {
  return NAV_ITEMS.filter((item) => item.roles.includes(role));
}
