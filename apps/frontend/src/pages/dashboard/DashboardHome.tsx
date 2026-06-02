import { useAuth } from '@/hooks/useAuth';
import { ExecutiveDashboardPage } from './executive/ExecutiveDashboardPage';
import { DashboardPage } from './DashboardPage';

/**
 * Role-aware landing for `/dashboard`.
 *
 * The PM (and the AI assistant acting on their behalf) get the chain-wide
 * EXECUTIVE dashboard — HeroStrip, chain-health, ecosystem. Every other role
 * is a single-link operator, so the chain-wide view is noise for them; they
 * get the scoped "Boshqaruv paneli" (`DashboardPage`), whose backend
 * endpoints are already RBAC-scoped to their own location. So each person
 * sees THEIR OWN dashboard, not the boshliq's.
 */
const EXECUTIVE_ROLES = ['pm', 'ai_assistant'];

export function DashboardHome() {
  const { user } = useAuth();
  if (user && EXECUTIVE_ROLES.includes(user.role)) {
    return <ExecutiveDashboardPage />;
  }
  return <DashboardPage />;
}
