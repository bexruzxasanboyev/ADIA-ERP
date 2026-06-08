import { Routes, Route, Navigate } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { ProtectedRoute } from './ProtectedRoute';
import { RoleRoute } from './RoleRoute';
import { LoginPage } from '@/pages/LoginPage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { HomePage } from '@/pages/home/HomePage';
import { useAuth } from '@/hooks/useAuth';
import { LocationsPage } from '@/pages/locations/LocationsPage';
import { LocationFlowsPage } from '@/pages/locations/LocationFlowsPage';
import { LocationDetailPage } from '@/pages/locations/LocationDetailPage';
import { EmployeesPage } from '@/pages/employees/EmployeesPage';
import { ProfilePage } from '@/pages/profile/ProfilePage';
import { ProductsPage } from '@/pages/products/ProductsPage';
import { RecipePage } from '@/pages/products/RecipePage';
import { StockPage } from '@/pages/stock/StockPage';
import { ReplenishmentPage } from '@/pages/replenishment/ReplenishmentPage';
import { ReplenishmentDetailPage } from '@/pages/replenishment/ReplenishmentDetailPage';
import { RequestsPage } from '@/pages/requests/RequestsPage';
import { ProductionOrdersPage } from '@/pages/production-orders/ProductionOrdersPage';
import { PurchaseOrdersPage } from '@/pages/purchase-orders/PurchaseOrdersPage';
import { DashboardPage } from '@/pages/dashboard/DashboardPage';
import { DashboardHome } from '@/pages/dashboard/DashboardHome';
import { ForecastsPage } from '@/pages/forecasts/ForecastsPage';
import { ImportWarningsPage } from '@/pages/admin/ImportWarningsPage';
import { RawWarehousePage } from '@/pages/chain/RawWarehousePage';
import { SupplyPage } from '@/pages/chain/SupplyPage';
import { ProductionWorkflowPage } from '@/pages/production/ProductionWorkflowPage';
import { CentralWarehousePage } from '@/pages/chain/CentralWarehousePage';
import { StoreWorkflowPage } from '@/pages/stores/StoreWorkflowPage';
import { CentralInboxPage } from '@/pages/central/CentralInboxPage';
import { CentralWorkflowPage } from '@/pages/central/CentralWorkflowPage';
import { ReceiptsPage } from '@/pages/cashier/ReceiptsPage';
import { CashShiftsPage } from '@/pages/cashier/CashShiftsPage';
import { SafeExpensesPage } from '@/pages/cashier/SafeExpensesPage';
import { KpiPage } from '@/pages/kpi/KpiPage';

/**
 * Application routes (phase-1-mvp.md §2, §6).
 *
 * Faza-1 Sprint 1 delivers M1 (locations/users), M2 (products/recipes)
 * and M3 (stock). The warehouse / store module screens reuse StockPage —
 * the backend scopes /api/stock by role, so each manager sees only their
 * own location. Dashboard, production, supply and replenishment remain
 * placeholders until their sprints.
 */
/**
 * Home route element — the /home module launcher, EXCEPT for single-section
 * managers, who land DIRECTLY on their own scoped workspace and never see the
 * launcher (owner-directed). Each manages exactly one chain link, so the
 * module grid is just an extra click between them and their only page:
 *   - store_manager             → /store-workflow
 *   - central_warehouse_manager → /central-workflow
 *   - production_manager        → /production (their RBAC-scoped sex)
 * Every other role (PM chain-wide, …) keeps the launcher. The redirect lives
 * here (and the index `/` route below sends everyone to /home first), so both
 * `/` and `/home` honour it.
 */
function HomeRoute() {
  const { user } = useAuth();
  if (user?.role === 'store_manager') {
    return <Navigate to="/store-workflow" replace />;
  }
  // Owner feedback: the central warehouse manager lands directly on their
  // unified workspace (/central-workflow), never on the /home launcher —
  // exactly like the store manager → /store-workflow.
  if (user?.role === 'central_warehouse_manager') {
    return <Navigate to="/central-workflow" replace />;
  }
  // Owner feedback (2026-06-08): a production / workshop manager (Tort,
  // Perojniy, «Наполеон отдел», …) lands directly on their production
  // workspace (/production), which the backend RBAC-scopes to that one sex —
  // never the /home launcher, exactly like the store and central managers.
  if (user?.role === 'production_manager') {
    return <Navigate to="/production" replace />;
  }
  return <HomePage />;
}

export function AppRouter() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      {/* Home launcher (IA redesign) — authenticated but sidebar-free:
          its own minimal shell, NOT wrapped in AppLayout. Post-login and
          the index `/` redirect both land here. */}
      <Route
        path="/home"
        element={
          <ProtectedRoute>
            <HomeRoute />
          </ProtectedRoute>
        }
      />

      <Route
        element={
          <ProtectedRoute>
            <AppLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Navigate to="/home" replace />} />

        {/* F4.7 — role-aware dashboard at /dashboard: PM / AI get the
            executive (boshliq, chain-wide) view; every other role gets
            their own RBAC-scoped Boshqaruv paneli. The full operations
            view stays at /dashboard/operations for deep links. */}
        <Route path="/dashboard" element={<DashboardHome />} />
        <Route path="/dashboard/operations" element={<DashboardPage />} />
        {/* Ekosistema canvas → per-location detail (header + KPI + stock +
            recent movements + open requests + manager info). Backend RBAC
            scopes the underlying endpoints; a scoped manager hitting a
            location outside their scope will receive 403 from /api/locations
            and the page surfaces an ErrorState. */}
        <Route
          path="/dashboard/locations/:locationId"
          element={<LocationDetailPage />}
        />

        {/* F3.4 — Forecasts page (all authenticated roles, RBAC-scoped server-side). */}
        <Route path="/forecasts" element={<ForecastsPage />} />

        {/* F4.6 — chain-layer module screens. Each composes the shared
            ChainLayerLayout; the backend scopes the chain-layer
            endpoint by the caller's role and active location. The
            generic StockPage stays available at /stock. */}
        <Route
          path="/raw-warehouse"
          element={
            <RoleRoute allow={['pm', 'raw_warehouse_manager']}>
              <RawWarehousePage />
            </RoleRoute>
          }
        />
        {/* Ishlab chiqarish bo'limi ish joyi — clean, production-отдел-scoped
            unified workspace (Dashboard + Yarim tayyor + So'rovlar), mirroring
            the central warehouse workspace. The production manager lands here
            directly (HomeRoute redirect, no /home launcher). PM can deep-link
            too (chain-wide read). Backend RBAC-scopes every endpoint. */}
        <Route
          path="/production"
          element={
            <RoleRoute allow={['pm', 'production_manager']}>
              <ProductionWorkflowPage />
            </RoleRoute>
          }
        />
        <Route
          path="/supply"
          element={
            <RoleRoute allow={['pm', 'supply_manager']}>
              <SupplyPage />
            </RoleRoute>
          }
        />
        <Route
          path="/central-warehouse"
          element={
            <RoleRoute allow={['pm', 'central_warehouse_manager']}>
              <CentralWarehousePage />
            </RoleRoute>
          }
        />
        {/* The old chain-summary `/stores` page is removed — the store
            experience is now ONLY the clean `/store-workflow`. Old bookmarks
            redirect there. */}
        <Route path="/stores" element={<Navigate to="/store-workflow" replace />} />

        {/* Do'kon ish joyi — clean, store-scoped workflow page (stock +
            sent/incoming requests + receive + AI takliflari). The store
            manager does the full workflow; PM views read-only with a store
            picker. Backend RBAC-scopes every endpoint. */}
        <Route
          path="/store-workflow"
          element={
            <RoleRoute allow={['pm', 'store_manager']}>
              <StoreWorkflowPage />
            </RoleRoute>
          }
        />

        {/* Markaziy sklad ish joyi — clean, central-scoped unified workspace
            (Dashboard + Mahsulotlar (finished-only) + So'rovlar), mirroring
            the store workflow page. The central warehouse manager lands here
            directly (no /home launcher). PM can deep-link too. Backend
            RBAC-scopes every endpoint. */}
        <Route
          path="/central-workflow"
          element={
            <RoleRoute allow={['pm', 'central_warehouse_manager']}>
              <CentralWorkflowPage />
            </RoleRoute>
          }
        />

        {/* EPIC — Markaziy sklad kiruvchi so'rovlar (accept/reject). Central
            warehouse manager (or PM with a central picker) reviews incoming
            store replenishment requests. Kept for PM deep-links; the central
            manager now reaches this via the /central-workflow So'rovlar tab. */}
        <Route
          path="/central-inbox"
          element={
            <RoleRoute allow={['pm', 'central_warehouse_manager']}>
              <CentralInboxPage />
            </RoleRoute>
          }
        />

        {/* Generic stock screen (PM debug / cross-layer view). */}
        <Route
          path="/stock"
          element={
            <StockPage
              title="Ombor qoldig‘i"
              description="Butun zanjir bo‘yicha qoldiq va harakatlar."
            />
          }
        />

        <Route path="/replenishment" element={<ReplenishmentPage />} />
        <Route
          path="/replenishment/:id"
          element={<ReplenishmentDetailPage />}
        />

        {/* F4.14 — unified inbox/outbox/archive ("So'rovnomalar"). */}
        <Route path="/sorovnomalar" element={<RequestsPage />} />

        {/* EPIC 4.3 — "Yetkazib berish" (delivery) module removed; sections
            send directly and receive on arrival. Old bookmarks redirect to
            the unified requests inbox. */}
        <Route
          path="/delivery"
          element={<Navigate to="/sorovnomalar" replace />}
        />

        <Route
          path="/production-orders"
          element={
            <RoleRoute
              allow={[
                'pm',
                'production_manager',
                'central_warehouse_manager',
              ]}
            >
              <ProductionOrdersPage />
            </RoleRoute>
          }
        />
        <Route
          path="/purchase-orders"
          element={
            <RoleRoute
              allow={[
                'pm',
                'supply_manager',
                'raw_warehouse_manager',
              ]}
            >
              <PurchaseOrdersPage />
            </RoleRoute>
          }
        />

        {/* EPIC 8 — Kassa / chek & nakladnoy. PM (chain-wide read) +
            store_manager (own store, RBAC-scoped server-side). The cash
            shift / safe / nakladnoy backend contracts are not wired yet
            (gaps P8/P10/P11); the pages degrade to an informative empty
            state on a 404. */}
        <Route
          path="/cashier/receipts"
          element={
            <RoleRoute allow={['pm', 'store_manager']}>
              <ReceiptsPage />
            </RoleRoute>
          }
        />
        <Route
          path="/cashier/shifts"
          element={
            <RoleRoute allow={['pm', 'store_manager']}>
              <CashShiftsPage />
            </RoleRoute>
          }
        />
        <Route
          path="/cashier/safe"
          element={
            <RoleRoute allow={['pm']}>
              <SafeExpensesPage />
            </RoleRoute>
          }
        />

        {/* KPI — boshliq (PM) uchun per-mahsulot to'liq tan-narx
            (xom-ashyo + komunal + oylik) va foyda/sotuv tahlili. Sotuv
            narxlarini boshqarish uchun. Faqat PM; backend ham himoyalaydi. */}
        <Route
          path="/kpi"
          element={
            <RoleRoute allow={['pm']}>
              <KpiPage />
            </RoleRoute>
          }
        />

        {/* M2 — products & recipes. The recipe (BOM) opens as a dedicated
            page; editing is gated client- and server-side by role. */}
        <Route path="/products" element={<ProductsPage />} />
        {/* «Yarim tayyor mahsulotlar» section — ONLY the logged-in отдел's зг
            (semi-finished) WITH their on-hand stock (qoldiq). Data comes from
            the dedicated, server-scoped `GET /api/products/yarim-tayyor`
            (auto-scoped to the production_manager's отдел; PM sees all). The
            card shows a «Qoldiq» line and drops the redundant type badge.
            `forcedType="semi"` hides the type-tab row; `showStock` enables the
            stock line + badge removal. Same RBAC as /products. */}
        <Route
          path="/yarim-tayyor"
          element={
            <ProductsPage
              forcedType="semi"
              dataEndpoint="/api/products/yarim-tayyor"
              showStock
              title="Yarim tayyor mahsulotlar"
              description="Bo‘limingizning yarim tayyor mahsulotlari (зг) va ularning qoldig‘i."
            />
          }
        />
        <Route
          path="/products/:productId/recipe"
          element={<RecipePage />}
        />

        {/* M1 — locations. The "Oqimlar" (location_flows) editor is a
            dedicated PM-only page; the list itself is RBAC-scoped server-side. */}
        <Route
          path="/locations"
          element={
            <RoleRoute allow={['pm']}>
              <LocationsPage />
            </RoleRoute>
          }
        />
        <Route
          path="/locations/flows"
          element={
            <RoleRoute allow={['pm']}>
              <LocationFlowsPage />
            </RoleRoute>
          }
        />

        {/* EPIC 3 — "Foydalanuvchilar" va "Hodimlar" bitta sahifaga
            birlashtirildi (hodim = foydalanuvchi). Eski `/users`
            bookmarklar yangi birlashtirilgan sahifaga yo'naltiriladi. */}
        <Route path="/users" element={<Navigate to="/employees" replace />} />
        <Route
          path="/employees"
          element={
            <RoleRoute allow={['pm']}>
              <EmployeesPage />
            </RoleRoute>
          }
        />

        {/* EPIC 3 — self-service "Profil" page. Available to EVERY
            authenticated role (no RoleRoute) — Telegram self-link and
            password change live here. Reached from the clickable
            bottom-left user block in the sidebar. */}
        <Route path="/profile" element={<ProfilePage />} />

        {/* Faza-2 F2.3 — PM-only import-warnings admin panel. */}
        <Route
          path="/admin/import-warnings"
          element={
            <RoleRoute allow={['pm']}>
              <ImportWarningsPage />
            </RoleRoute>
          }
        />
      </Route>

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
