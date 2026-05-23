/**
 * Regression — AuthProvider hydration must unwrap the `/api/auth/me`
 * envelope.
 *
 * The backend (spec §4.1) returns `{ user: {...} }`. After a page reload
 * the AuthProvider re-hydrates the session by calling
 * `apiRequest<User>('/api/auth/me')` and storing the result. If that
 * stored value is the wrapped envelope, every consumer that reads
 * `user.role` / `user.name` ends up with `undefined`, which silently
 * breaks role-gated routes (`RoleRoute` bounces to /dashboard), hides
 * the sidebar nav (`navSectionsForRole(undefined)` is empty), and
 * disables the cancel button on the replenishment detail page.
 *
 * The Prove-It pattern: this test FAILS today and stays in the suite as
 * the regression guard once AuthProvider is fixed to extract `me.user`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { AuthProvider } from './AuthProvider';
import { useAuth } from './useAuth';
import { jsonResponse } from '@/test/render-helpers';

const STORAGE_KEY = 'adia.token';

function Probe() {
  const { user, isHydrating } = useAuth();
  if (isHydrating) return <div>hydrating</div>;
  return (
    <div>
      <span data-testid="role">{user?.role ?? 'NONE'}</span>
      <span data-testid="name">{user?.name ?? 'NONE'}</span>
    </div>
  );
}

describe('AuthProvider — /api/auth/me hydration', () => {
  beforeEach(() => {
    localStorage.setItem(STORAGE_KEY, 'fake-jwt');
  });

  afterEach(() => {
    localStorage.removeItem(STORAGE_KEY);
    vi.restoreAllMocks();
  });

  it('extracts user.role from the wrapped `{ user }` envelope after reload', async () => {
    // Backend contract — phase-1-mvp.md §4.1: `GET /api/auth/me`
    // responds with `{ user: PublicUser }`.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(200, {
        user: {
          id: 1,
          name: 'Loyiha menejeri',
          email: 'pm@adia.local',
          role: 'pm',
          location_id: null,
          telegram_id: null,
        },
      }),
    );

    await act(async () => {
      render(
        <AuthProvider>
          <Probe />
        </AuthProvider>,
      );
    });

    // After hydration finishes, `user.role` must be the actual role,
    // not undefined (which would render the placeholder "NONE").
    await waitFor(() => {
      expect(screen.getByTestId('role').textContent).toBe('pm');
    });
    expect(screen.getByTestId('name').textContent).toBe('Loyiha menejeri');
  });
});
