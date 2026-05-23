import { createContext } from 'react';
import type { User } from '@/lib/types';

export interface AuthContextValue {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  /** True while a stored token is being verified via GET /api/auth/me. */
  isHydrating: boolean;
  /** Persists the session and updates context state. */
  login: (token: string, user: User) => void;
  logout: () => void;
}

export const AuthContext = createContext<AuthContextValue | null>(null);
