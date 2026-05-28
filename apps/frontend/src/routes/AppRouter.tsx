import { Routes, Route, Navigate } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { ProtectedRoute } from './ProtectedRoute';
import { RoleRoute } from './RoleRoute';
import { LoginPage } from '@/pages/LoginPage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { LocationsPage } from '@/pages/locations/LocationsPage';
import { LocationDetailPage } from '@/pages/locations/LocationDetailPage';
import { UsersPage } from '@/pages/users/UsersPage';
import { EmployeesPage } from '@/pages/employees/EmployeesPage';
import { ProductsPage } from '@/pages/products/ProductsPage';
import { StockPage } from '@/pages/stock/StockPage';
import { ReplenishmentPage } from '@/pages/replenishment/ReplenishmentPage';
import { ReplenishmentDetailPage } from '@/pages/replenishment/ReplenishmentDetailPage';
import { ProductionOrdersPage } from '@/pages/production-orders/ProductionOrdersPage';
import { PurchaseOrdersPage } from '@/pages/purchase-orders/PurchaseOrdersPage';
import { DashboardPage } from '@/pages/dashboard/DashboardPage';
import { ExecutiveDashboardPage } from '@/pages/dashboard/executive/ExecutiveDashboardPage';
import { ForecastsPage } from '@/pages/forecasts/ForecastsPage';
import { ImportWarningsPage } from '@/pages/admin/ImportWarningsPage';
import { DeliveryPage } from '@/pages/delivery/DeliveryPage';
import { RawWarehousePage } from '@/pages/chain/RawWarehousePage';
import { ProductionPage } from '@/pages/chain/ProductionPage';
import { SupplyPage } from '@/pages/chain/SupplyPage';
import { CentralWarehousePage } from '@/pages/chain/CentralWarehousePage';
import { StoresPage } from '@/pages/chain/StoresPage';

/**
 * Application routes (phase-1-mvp.md §2, §6).
 *
 * Faza-1 Sprint 1 delivers M1 (locations/users), M2 (products/recipes)
 * and M3 (stock). The warehouse / store module screens reuse StockPage —
 * the backend scopes /api/stock by role, so each manager sees only their
 * own location. Dashboard, production, supply and replenishment remain
 * placeholders until their sprints.
 */
export function AppRouter() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route
        element={
          <ProtectedRoute>
            <AppLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Navigate to="/dashboard" replace />} />

        {/* F4.7 — Executive (boshliq) dashboard at /dashboard; the
            full operations view is parked at /dashboard/operations so
            existing deep links stay live. */}
        <Route path="/dashboard" element={<ExecutiveDashboardPage />} />
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
        <Route
          path="/production"
          element={
            <RoleRoute allow={['pm', 'production_manager']}>
              <ProductionPage />
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
        <Route
          path="/stores"
          element={
            <RoleRoute
              allow={['pm', 'store_manager', 'central_warehouse_manager']}
            >
              <StoresPage />
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

        {/* F4.10 — Yetkazib berish (delivery) module. */}
        <Route
          path="/delivery"
          element={
            <RoleRoute
              allow={[
                'pm',
                'central_warehouse_manager',
                'supply_manager',
                'store_manager',
              ]}
            >
              <DeliveryPage />
            </RoleRoute>
          }
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

        {/* M2 — products & recipes. */}
        <Route path="/products" element={<ProductsPage />} />

        {/* M1 — locations & users. */}
        <Route path="/locations" element={<LocationsPage />} />
        <Route
          path="/users"
          element={
            <RoleRoute allow={['pm']}>
              <UsersPage />
            </RoleRoute>
          }
        />

        {/* F4.1 — Hodimlar (M:N locations admin). */}
        <Route
          path="/employees"
          element={
            <RoleRoute allow={['pm']}>
              <EmployeesPage />
            </RoleRoute>
          }
        />

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
