import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { getToken, setToken, clearToken } from '@/lib/auth-storage';
import { apiRequest, ApiError } from '@/lib/api-client';
import type { User } from '@/lib/types';
import { AuthContext, type AuthContextValue } from './auth-context';

/**
 * Auth state holder.
 *
 * On mount, if a JWT is already stored, the session is re-hydrated via
 * `GET /api/auth/me` (Sprint 0 left this as debt). While that request is
 * in flight `isHydrating` is true so the router can hold rendering and
 * avoid a flash of the login screen for an already-valid session.
 *
 * JWT STORAGE DECISION (accepted technical debt — code-reviewer Sprint 0):
 * The JWT lives in localStorage (see `lib/auth-storage.ts`). Spec §4
 * requires `Authorization: Bearer <JWT>` on every endpoint, which rules
 * out an httpOnly cookie. ADIA is a single-company internal ERP, so the
 * Bearer-header + token-storage model is kept. The token is accessed ONLY
 * through the `auth-storage` module, keeping the XSS surface to a single
 * auditable point.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setTokenState] = useState<string | null>(() => getToken());
  const [user, setUser] = useState<User | null>(null);
  const [isHydrating, setIsHydrating] = useState<boolean>(
    () => getToken() !== null,
  );

  const login = useCallback((nextToken: string, nextUser: User) => {
    setToken(nextToken);
    setTokenState(nextToken);
    setUser(nextUser);
  }, []);

  const logout = useCallback(() => {
    clearToken();
    setTokenState(null);
    setUser(null);
  }, []);

  // Re-hydrate the user from a stored token on first load / reload.
  useEffect(() => {
    if (token === null) {
      setIsHydrating(false);
      return;
    }
    let cancelled = false;

    apiRequest<User>('/api/auth/me')
      .then((me) => {
        if (!cancelled) setUser(me);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // A 401 means the stored token is dead — drop the session.
        // The api-client already clears the token on 401; mirror it here.
        if (err instanceof ApiError && err.status === 401) {
          setTokenState(null);
          setUser(null);
        }
      })
      .finally(() => {
        if (!cancelled) setIsHydrating(false);
      });

    return () => {
      cancelled = true;
    };
    // Run once for the token present at mount; login()/logout() manage
    // the user state directly afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      token,
      isAuthenticated: token !== null,
      isHydrating,
      login,
      logout,
    }),
    [user, token, isHydrating, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
