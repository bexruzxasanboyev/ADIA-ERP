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
  UserCog,
  ClipboardList,
  TrendingUp,
  BookOpen,
  Wallet,
  ReceiptText,
  Banknote,
  Target,
  type LucideIcon,
} from 'lucide-react';
import type { Role } from './types';

/**
 * Hybrid navigation model — F4.13.
 *
 * The sidebar is collapsed to four group icons (Boshqaruv paneli,
 * Bashorat, Modullar, Ma'lumotnoma). Inside the Modullar and
 * Ma'lumotnoma groups, sub-screens appear as Jira-style pill tabs at
 * the top of the page. The group icon is itself a link — clicking it
 * jumps to the group's default screen (or the first screen the user
 * has access to inside that group).
 */
export type NavGroupKey =
  | 'dashboard'
  | 'forecasts'
  | 'store'
  | 'central'
  | 'modules'
  | 'cashier'
  | 'kpi'
  | 'reference';

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
  /** Stable key for the group (used for sidebar icons + PageTabs scoping). */
  key: NavGroupKey;
  /** Uzbek section heading (also the group's accessible label). */
  label: string;
  /** Icon shown on the collapsed rail for this group. */
  icon: LucideIcon;
  /**
   * Preferred landing path when the user clicks the group's sidebar
   * icon. If this path is not in `items` (or the user's role can't see
   * it), the first visible item is used as fallback.
   */
  defaultPath: string;
  /**
   * Tabs render inside the page only for groups marked `hasTabs`. The
   * single-screen groups (dashboard, forecasts) do not render PageTabs.
   */
  hasTabs: boolean;
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
    key: 'dashboard',
    label: 'Dashboard',
    icon: LayoutDashboard,
    defaultPath: '/dashboard',
    hasTabs: false,
    items: [
      {
        path: '/dashboard',
        label: 'Dashboard',
        icon: LayoutDashboard,
        roles: ALL_ROLES,
      },
    ],
  },
  {
    key: 'forecasts',
    label: 'Bashorat',
    icon: TrendingUp,
    defaultPath: '/forecasts',
    hasTabs: false,
    items: [
      {
        path: '/forecasts',
        label: 'Bashorat',
        icon: TrendingUp,
        roles: ALL_ROLES,
      },
    ],
  },
  {
    // Do'kon boshlig'ining asosiy ish joyi — qoldiq + so'rovlar + qabul
    // qilish + tranzaksiyalar bitta TOZA sahifada. Bu guruh PageTabs
    // ko'rsatmaydi (hasTabs: false), shuning uchun sahifa tepasida
    // module tab qatori chiqmaydi (egasi: "toza" sahifa).
    key: 'store',
    label: 'Do‘kon',
    icon: Store,
    defaultPath: '/store-workflow',
    hasTabs: false,
    items: [
      {
        path: '/store-workflow',
        label: 'Do‘kon ish joyi',
        icon: ClipboardList,
        roles: ['pm', 'store_manager'],
      },
    ],
  },
  {
    // Markaziy sklad boshlig'ining asosiy ish joyi — qoldiq + kelayotgan
    // jo'natmalar + do'konlardan kiruvchi so'rovlar bitta TOZA sahifada
    // (Dashboard / Mahsulotlar / So'rovlar sub-tablari). Do'kon ish joyi
    // kabi: bu guruh PageTabs ko'rsatmaydi (hasTabs: false), shuning uchun
    // sahifa tepasida module tab qatori chiqmaydi. PM + central_warehouse_manager.
    key: 'central',
    label: 'Markaziy',
    icon: Warehouse,
    defaultPath: '/central-workflow',
    hasTabs: false,
    items: [
      {
        path: '/central-workflow',
        label: 'Markaziy sklad ish joyi',
        icon: Warehouse,
        roles: ['pm', 'central_warehouse_manager'],
      },
    ],
  },
  {
    key: 'modules',
    label: 'Modullar',
    icon: Boxes,
    defaultPath: '/raw-warehouse',
    hasTabs: true,
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
        // URL stays `/supply` for back-compat with existing bookmarks
        // and the backend chain-layer endpoint; on-page copy + nav label
        // now reads "Ishlab chiqarish omborlari" (renamed from "Ta'minot"). Once the
        // backend ENUM rolls forward to `sex_storage` we can flip the
        // URL and the chain-layer fetch in a single follow-up commit.
        path: '/supply',
        label: 'Ishlab chiqarish omborlari',
        icon: Truck,
        roles: ['pm', 'supply_manager'],
      },
      {
        // PM-only chain-layer deep view. The central warehouse manager's
        // module screen is now the unified /central-workflow workspace (see
        // the `central` nav group), so they don't see this redundant entry.
        path: '/central-warehouse',
        label: 'Markaziy sklad',
        icon: Warehouse,
        roles: ['pm'],
      },
      {
        // Owner (2026-06-06): the header request pages collapse to ONE
        // unified hub. `/replenishment` now carries "So'rovlar" +
        // "Tranzaksiyalar" tabs, so the separate So'rovnomalar /
        // Ishlab chiqarish zayafkalari / Sotib olish so'rovlari nav
        // entries are redundant and removed from the header. Their ROUTES
        // stay alive (URL-reachable) so nothing breaks and it's reversible.
        path: '/replenishment',
        label: 'So‘rovlar',
        icon: RefreshCw,
        roles: ALL_ROLES,
      },
    ],
  },
  {
    // EPIC 8 — Kassa / chek & nakladnoy. PM ko'radi butun zanjirni;
    // do'kon boshlig'i o'z do'koni cheklari/smenasini (backend RBAC).
    key: 'cashier',
    label: 'Kassa',
    icon: Wallet,
    defaultPath: '/cashier/receipts',
    hasTabs: true,
    items: [
      {
        path: '/cashier/receipts',
        label: 'Cheklar',
        icon: ReceiptText,
        roles: ['pm', 'store_manager'],
      },
      {
        path: '/cashier/shifts',
        label: 'Smenalar',
        icon: Banknote,
        roles: ['pm', 'store_manager'],
      },
      {
        path: '/cashier/safe',
        label: 'Seyf rasxodlari',
        icon: Wallet,
        roles: ['pm'],
      },
    ],
  },
  {
    // KPI — boshliq (PM) uchun alohida tepa-daraja tab: har tayyor
    // mahsulotning to'liq tan-narxi (xom-ashyo + komunal + oylik) va
    // sotuvga nisbatan foydasi. Sotuv narxlarini boshqarish uchun.
    // Faqat PM ko'radi; backend ham RBAC bilan himoyalaydi.
    key: 'kpi',
    label: 'KPI',
    icon: Target,
    defaultPath: '/kpi',
    hasTabs: false,
    items: [
      {
        path: '/kpi',
        label: 'KPI',
        icon: Target,
        roles: ['pm'],
      },
    ],
  },
  {
    key: 'reference',
    label: 'Ma’lumotnoma',
    icon: BookOpen,
    defaultPath: '/products',
    hasTabs: true,
    items: [
      {
        path: '/products',
        label: 'Mahsulotlar',
        icon: Package,
        roles: MANAGER_ROLES,
      },
      {
        // Bo'g'inlar = chain-wide location admin → PM only. Ordinary
        // single-link roles don't need to see the whole chain.
        path: '/locations',
        label: 'Bo‘g‘inlar',
        icon: MapPin,
        roles: ['pm'],
      },
      {
        // EPIC 3 — "Foydalanuvchilar" va "Hodimlar" bitta sahifaga
        // birlashtirildi (hodim = foydalanuvchi). M:N bo'g'in oqimi +
        // Telegram self-link shu yerda. Eski `/users` → `/employees`
        // redirect (AppRouter).
        path: '/employees',
        label: 'Hodimlar',
        icon: UserCog,
        roles: ['pm'],
      },
      // NOTE — "Profil" is intentionally NOT a reference TAB: it already has a
      // dedicated link on the right of the global header (AppLayout), so
      // listing it here too rendered "Profil" twice (centre tab + right link).
      // The header link is the single entry point to /profile.
    ],
  },
];

/**
 * A single tile on the Home launcher grid.
 */
export interface HomeTile {
  path: string;
  label: string;
  icon: LucideIcon;
  /** Roles allowed to see this tile (same RBAC filter the nav uses). */
  roles: readonly Role[];
}

/** A labelled group of Home launcher tiles, rendered as one titled row. */
export interface HomeTileGroup {
  /** Uzbek section heading shown above the group's tiles. */
  title: string;
  tiles: readonly HomeTile[];
}

/**
 * The PRIMARY modules grouped for the Home launcher (owner-directed
 * layout): THREE titled sections in an explicit, authoritative order —
 *
 *   Boshqaruv  — Dashboard, Mahsulotlar, Bo'g'inlar, Hodimlar
 *   Bo'limlar  — Do'konlar, Markaziy ombor, Ishlab chiqarish,
 *                Ishlab chiqarish ombori, Xom-ashyo ombori
 *   Qo'shimcha — Kassa, Bashorat
 *
 * The REST of the navigable pages (To'ldirish so'rovlari, Sotib olish
 * so'rovlari, cashier shifts, …) are NOT here — they are reached via the
 * header sub-tabs (see PageTabs, which excludes these tile paths). Each
 * `roles` set mirrors the matching NAV_SECTIONS item so the launcher and
 * the tabs apply the same RBAC filter.
 */
export const HOME_TILE_GROUPS: readonly HomeTileGroup[] = [
  {
    title: 'Boshqaruv',
    tiles: [
      { path: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, roles: ALL_ROLES },
      { path: '/replenishment', label: 'So‘rovlar', icon: RefreshCw, roles: ALL_ROLES },
      { path: '/products', label: 'Mahsulotlar', icon: Package, roles: MANAGER_ROLES },
      { path: '/locations', label: 'Bo‘g‘inlar', icon: MapPin, roles: ['pm'] },
      { path: '/employees', label: 'Hodimlar', icon: UserCog, roles: ['pm'] },
      { path: '/kpi', label: 'KPI', icon: Target, roles: ['pm'] },
    ],
  },
  {
    title: 'Bo‘limlar',
    tiles: [
      {
        path: '/store-workflow',
        label: 'Do‘konlar',
        icon: Store,
        roles: ['pm', 'store_manager'],
      },
      {
        path: '/central-workflow',
        label: 'Markaziy ombor',
        icon: Warehouse,
        roles: ['pm', 'central_warehouse_manager'],
      },
      {
        path: '/production',
        label: 'Ishlab chiqarish',
        icon: Factory,
        roles: ['pm', 'production_manager'],
      },
      {
        path: '/supply',
        label: 'Ishlab chiqarish ombori',
        icon: Truck,
        roles: ['pm', 'supply_manager'],
      },
      {
        path: '/raw-warehouse',
        label: 'Xom-ashyo ombori',
        icon: Boxes,
        roles: ['pm', 'raw_warehouse_manager'],
      },
    ],
  },
  {
    title: 'Qo‘shimcha',
    tiles: [
      {
        path: '/cashier/receipts',
        label: 'Kassa',
        icon: Wallet,
        roles: ['pm', 'store_manager'],
      },
      { path: '/forecasts', label: 'Bashorat', icon: TrendingUp, roles: ALL_ROLES },
    ],
  },
];

/**
 * Flat ordered list of every Home tile — derived from `HOME_TILE_GROUPS`
 * so the grouped layout stays the single source of truth. Used to build
 * `HOME_TILE_PATHS` (PageTabs exclusion).
 */
export const HOME_TILES: readonly HomeTile[] = HOME_TILE_GROUPS.flatMap(
  (group) => group.tiles,
);

/** Path set of the 11 home tiles — used to exclude them from PageTabs. */
export const HOME_TILE_PATHS: ReadonlySet<string> = new Set(
  HOME_TILES.map((tile) => tile.path),
);

/**
 * Filter the navigation sections down to those the role may see.
 * Empty sections are dropped.
 */
export function navSectionsForRole(role: Role): NavSection[] {
  return NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((item) => item.roles.includes(role)),
  })).filter((section) => section.items.length > 0);
}

/**
 * Resolve the group a route path belongs to. Used by the AppLayout to
 * decide which group's tabs to render at the top of the page (and to
 * highlight the matching sidebar icon).
 *
 * Match is by exact path equality on any item, or by `startsWith` for
 * nested routes (e.g. `/replenishment/:id` → `/replenishment` → modules).
 * Returns `null` for paths outside the nav (e.g. `/admin/import-warnings`).
 */
export function findGroupForPath(pathname: string): NavSection | null {
  for (const section of NAV_SECTIONS) {
    for (const item of section.items) {
      if (
        pathname === item.path ||
        pathname.startsWith(`${item.path}/`)
      ) {
        return section;
      }
    }
  }
  return null;
}

/**
 * Resolve the landing path for a group icon click — the group's
 * `defaultPath` if the role can see it, otherwise the first visible
 * item, otherwise `null` (meaning: the group has no items for this
 * role and its sidebar icon should be hidden).
 */
export function resolveGroupLanding(
  section: NavSection,
  role: Role,
): string | null {
  const visible = section.items.filter((item) => item.roles.includes(role));
  const first = visible[0];
  if (!first) return null;
  const def = visible.find((item) => item.path === section.defaultPath);
  return def ? def.path : first.path;
}
