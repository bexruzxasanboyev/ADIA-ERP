import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  getAccessToken,
  getRefreshToken,
  setTokens,
  clearTokens,
} from '@/lib/auth-storage';
import { apiRequest, ApiError } from '@/lib/api-client';
import { env } from '@/lib/env';
import type { User } from '@/lib/types';
import { AuthContext, type AuthContextValue } from './auth-context';

/**
 * Auth state holder.
 *
 * On mount, if an access token is already stored, the session is
 * re-hydrated via `GET /api/auth/me`. While that request is in flight
 * `isHydrating` is true so the router can hold rendering and avoid a
 * flash of the login screen for an already-valid session. If the
 * stored access token is expired, `apiRequest` will transparently
 * refresh it before failing the hydration call.
 *
 * Token storage tradeoff and rationale: see `lib/auth-storage.ts`.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setTokenState] = useState<string | null>(() =>
    getAccessToken(),
  );
  const [user, setUser] = useState<User | null>(null);
  const [isHydrating, setIsHydrating] = useState<boolean>(
    () => getAccessToken() !== null,
  );

  const login = useCallback(
    (
      tokens: { accessToken: string; refreshToken: string },
      nextUser: User,
    ) => {
      setTokens(tokens);
      setTokenState(tokens.accessToken);
      setUser(nextUser);
    },
    [],
  );

  const logout = useCallback(async (): Promise<void> => {
    const refreshToken = getRefreshToken();

    // Best-effort, idempotent revoke. We deliberately use a plain
    // `fetch` (not `apiRequest`) so a 401 here cannot recurse back
    // into the refresh-retry loop. Any failure is swallowed — the
    // local session is cleared regardless.
    if (refreshToken !== null) {
      try {
        await fetch(`${env.apiBaseUrl}/api/auth/logout`, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ refresh_token: refreshToken }),
        });
      } catch {
        /* offline / network — clear local state anyway */
      }
    }

    clearTokens();
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

    apiRequest<{ user: User }>('/api/auth/me')
      .then((me) => {
        if (!cancelled) setUser(me.user);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // A 401 means the stored tokens are dead — drop the session.
        // The api-client already clears tokens on a terminal 401;
        // mirror it here.
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
