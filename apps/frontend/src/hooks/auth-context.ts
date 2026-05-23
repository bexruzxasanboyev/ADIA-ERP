import { createContext } from 'react';
import type { User } from '@/lib/types';

export interface AuthContextValue {
  user: User | null;
  /** Current access token (the one sent as `Authorization: Bearer`). */
  token: string | null;
  isAuthenticated: boolean;
  /** True while a stored token is being verified via GET /api/auth/me. */
  isHydrating: boolean;
  /** Persists the access+refresh pair and updates context state. */
  login: (
    tokens: { accessToken: string; refreshToken: string },
    user: User,
  ) => void;
  /**
   * Revokes the refresh token on the backend (best-effort, idempotent)
   * and clears the local session.
   */
  logout: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);
