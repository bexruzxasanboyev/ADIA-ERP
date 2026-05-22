import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { getToken, setToken, clearToken } from '@/lib/auth-storage';
import type { User } from '@/lib/types';
import { AuthContext, type AuthContextValue } from './auth-context';

/**
 * Auth state holder for Faza-1 scaffold.
 *
 * NOTE: this is a skeleton — it persists the JWT and keeps the user in
 * memory, but does not yet re-hydrate the user via `GET /api/auth/me` on
 * reload. Wire that up when the backend auth endpoints land (Sprint 1+).
 *
 * JWT STORAGE DECISION (accepted technical debt — code-reviewer Sprint 0):
 * The JWT lives in localStorage (see `lib/auth-storage.ts`). Spec §4
 * requires `Authorization: Bearer <JWT>` on every endpoint, which rules
 * out an httpOnly cookie (that contract cannot be satisfied by a cookie
 * the JS layer cannot read). ADIA is a single-company internal ERP, so
 * the Bearer-header + token-storage model is kept.
 * Tradeoff: localStorage is readable by injected scripts, so a stored
 * token is exposed to XSS. Mitigation: the token is accessed ONLY through
 * the `auth-storage` module — no other code touches `localStorage`
 * directly — which keeps the XSS surface to a single auditable point.
 * Revisit if the threat model changes (e.g. external/public users).
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setTokenState] = useState<string | null>(() => getToken());
  const [user, setUser] = useState<User | null>(null);

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

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      token,
      isAuthenticated: token !== null,
      login,
      logout,
    }),
    [user, token, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
