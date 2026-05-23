import { Routes, Route, Navigate } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { ProtectedRoute } from './ProtectedRoute';
import { RoleRoute } from './RoleRoute';
import { LoginPage } from '@/pages/LoginPage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { PlaceholderPage } from '@/pages/PlaceholderPage';
import { LocationsPage } from '@/pages/locations/LocationsPage';
import { UsersPage } from '@/pages/users/UsersPage';
import { ProductsPage } from '@/pages/products/ProductsPage';
import { StockPage } from '@/pages/stock/StockPage';
import { ReplenishmentPage } from '@/pages/replenishment/ReplenishmentPage';
import { ReplenishmentDetailPage } from '@/pages/replenishment/ReplenishmentDetailPage';
import { ProductionOrdersPage } from '@/pages/production-orders/ProductionOrdersPage';
import { PurchaseOrdersPage } from '@/pages/purchase-orders/PurchaseOrdersPage';
import { DashboardPage } from '@/pages/dashboard/DashboardPage';
import { ImportWarningsPage } from '@/pages/admin/ImportWarningsPage';

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

        <Route path="/dashboard" element={<DashboardPage />} />

        {/* M3 — stock screens. Each reuses StockPage; the backend scopes
            /api/stock by the caller's role and location. */}
        <Route
          path="/raw-warehouse"
          element={
            <StockPage
              title="Xom-ashyo ombori"
              description="Xom-ashyo qoldig‘i va harakatlari."
            />
          }
        />
        <Route
          path="/central-warehouse"
          element={
            <StockPage
              title="Markaziy sklad"
              description="Markaziy sklad qoldig‘i va jo‘natmalari."
            />
          }
        />
        <Route
          path="/stores"
          element={
            <StockPage
              title="Do‘konlar"
              description="Do‘konlar qoldig‘i va savdo harakatlari."
            />
          }
        />

        <Route
          path="/production"
          element={
            <RoleRoute allow={['pm', 'production_manager']}>
              <PlaceholderPage
                title="Ishlab chiqarish"
                description="Ishlab chiqarish zayafkalari va jarayoni."
              />
            </RoleRoute>
          }
        />
        <Route
          path="/supply"
          element={
            <RoleRoute allow={['pm', 'supply_manager']}>
              <PlaceholderPage
                title="Ta’minot"
                description="Ta’minot so‘rovlari va yetkazib beruvchilar."
              />
            </RoleRoute>
          }
        />
        <Route path="/replenishment" element={<ReplenishmentPage />} />
        <Route
          path="/replenishment/:id"
          element={<ReplenishmentDetailPage />}
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
