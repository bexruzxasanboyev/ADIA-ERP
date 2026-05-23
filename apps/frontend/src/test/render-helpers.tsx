/**
 * Shared test helpers for component / contract tests.
 *
 * `renderWithProviders` wires up the providers a page needs (router,
 * toast, and a pre-authenticated auth context) so list pages can be
 * rendered in isolation without going through the real login flow.
 */
import type { ReactElement, ReactNode } from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/toast';
import { AuthContext, type AuthContextValue } from '@/hooks/auth-context';
import type { Role, User } from '@/lib/types';

/** A test `User`; override `role`/`location_id` per scenario. */
export function fakeUser(overrides: Partial<User> = {}): User {
  return {
    id: 1,
    name: 'Test PM',
    email: 'pm@adia.test',
    role: 'pm',
    location_id: null,
    ...overrides,
  };
}

function fakeAuth(user: User): AuthContextValue {
  return {
    user,
    token: 'test-token',
    isAuthenticated: true,
    isHydrating: false,
    login: () => {},
    logout: async () => {},
  };
}

interface RenderOptions {
  /** Role for the injected auth context (defaults to `pm`). */
  role?: Role;
  /** Location id for the injected user (defaults to `null`). */
  locationId?: number | null;
}

/** Render `ui` inside router + toast + an authenticated auth context. */
export function renderWithProviders(
  ui: ReactElement,
  { role = 'pm', locationId = null }: RenderOptions = {},
) {
  const user = fakeUser({ role, location_id: locationId });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <AuthContext.Provider value={fakeAuth(user)}>
        <ToastProvider>
          <MemoryRouter>{children}</MemoryRouter>
        </ToastProvider>
      </AuthContext.Provider>
    );
  }
  return render(ui, { wrapper: Wrapper });
}

/** Build a JSON `Response` for a mocked `fetch`. */
export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
