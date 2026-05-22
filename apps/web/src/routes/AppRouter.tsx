import { Routes, Route, Navigate } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { ProtectedRoute } from './ProtectedRoute';
import { LoginPage } from '@/pages/LoginPage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { PlaceholderPage } from '@/pages/PlaceholderPage';

/**
 * Application routes. Module pages are placeholders in Faza-1 Sprint 0 —
 * each is replaced by a real screen in later sprints.
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
        <Route
          path="/dashboard"
          element={
            <PlaceholderPage
              title="Boshqaruv paneli"
              description="Butun zanjir holati, ogohlantirishlar va kunlik reja."
            />
          }
        />
        <Route
          path="/raw-warehouse"
          element={
            <PlaceholderPage
              title="Xom-ashyo ombori"
              description="Xom-ashyo qoldig‘i va harakatlari."
            />
          }
        />
        <Route
          path="/production"
          element={
            <PlaceholderPage
              title="Ishlab chiqarish"
              description="Ishlab chiqarish zayafkalari va jarayoni."
            />
          }
        />
        <Route
          path="/supply"
          element={
            <PlaceholderPage
              title="Ta’minot"
              description="Ta’minot so‘rovlari va yetkazib beruvchilar."
            />
          }
        />
        <Route
          path="/central-warehouse"
          element={
            <PlaceholderPage
              title="Markaziy sklad"
              description="Markaziy sklad qoldig‘i va jo‘natmalar."
            />
          }
        />
        <Route
          path="/stores"
          element={
            <PlaceholderPage
              title="Do‘konlar"
              description="Do‘konlar qoldig‘i va savdo ko‘rsatkichlari."
            />
          }
        />
        <Route
          path="/replenishment"
          element={
            <PlaceholderPage
              title="To‘ldirish so‘rovlari"
              description="Avtomatik to‘ldirish tsikli va so‘rovlar holati."
            />
          }
        />
      </Route>

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
