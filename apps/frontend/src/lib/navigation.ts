import {
  LayoutDashboard,
  Boxes,
  Factory,
  Truck,
  Warehouse,
  Store,
  RefreshCw,
  MapPin,
  Package,
  Users,
  UserCog,
  ClipboardList,
  ShoppingCart,
  TrendingUp,
  PackageCheck,
  type LucideIcon,
} from 'lucide-react';
import type { Role } from './types';

/**
 * Role-scoped navigation. Each item is visible only to the listed roles —
 * derived from the RBAC matrix in docs/specs/phase-1-mvp.md §6.
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

/** A labelled group of navigation items rendered as one sidebar section. */
export interface NavSection {
  /** Uzbek section heading. */
  label: string;
  items: readonly NavItem[];
}

// TZ §3 — every authenticated role plus the AI assistant identity. The
// AI assistant has Read + recommend access chain-wide (same scope as
// PM for queries), so it should see every navigation entry an operator
// would see; the backend RBAC layer is the final gate on writes.
const ALL_ROLES: readonly Role[] = [
  'pm',
  'raw_warehouse_manager',
  'production_manager',
  'supply_manager',
  'central_warehouse_manager',
  'store_manager',
  'ai_assistant',
];

const MANAGER_ROLES: readonly Role[] = [
  'pm',
  'raw_warehouse_manager',
  'production_manager',
  'supply_manager',
  'central_warehouse_manager',
  'store_manager',
  'ai_assistant',
];

export const NAV_SECTIONS: readonly NavSection[] = [
  {
    label: 'Umumiy',
    items: [
      {
        path: '/dashboard',
        label: 'Boshqaruv paneli',
        icon: LayoutDashboard,
        roles: ALL_ROLES,
      },
      {
        path: '/forecasts',
        label: 'Bashorat',
        icon: TrendingUp,
        roles: ALL_ROLES,
      },
    ],
  },
  {
    label: 'Modullar',
    items: [
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
        roles: ALL_ROLES,
      },
      {
        path: '/delivery',
        label: 'Yetkazib berish',
        icon: PackageCheck,
        roles: [
          'pm',
          'central_warehouse_manager',
          'supply_manager',
          'store_manager',
        ],
      },
      {
        path: '/production-orders',
        label: 'Ishlab chiqarish zayafkalari',
        icon: ClipboardList,
        roles: ['pm', 'production_manager', 'central_warehouse_manager'],
      },
      {
        path: '/purchase-orders',
        label: 'Sotib olish so‘rovlari',
        icon: ShoppingCart,
        roles: ['pm', 'supply_manager', 'raw_warehouse_manager'],
      },
    ],
  },
  {
    label: 'Ma’lumotnoma',
    items: [
      {
        path: '/products',
        label: 'Mahsulotlar',
        icon: Package,
        roles: MANAGER_ROLES,
      },
      {
        path: '/locations',
        label: 'Bo‘g‘inlar',
        icon: MapPin,
        roles: MANAGER_ROLES,
      },
      {
        path: '/users',
        label: 'Foydalanuvchilar',
        icon: Users,
        roles: ['pm'],
      },
      {
        // F4.1 — extended employees admin with M:N location flow.
        path: '/employees',
        label: 'Hodimlar',
        icon: UserCog,
        roles: ['pm'],
      },
    ],
  },
];

/**
 * Filter the navigation sections down to those the role may see.
 * Empty sections are dropped.
 */
export function navSectionsForRole(role: Role): NavSection[] {
  return NAV_SECTIONS.map((section) => ({
    label: section.label,
    items: section.items.filter((item) => item.roles.includes(role)),
  })).filter((section) => section.items.length > 0);
}
