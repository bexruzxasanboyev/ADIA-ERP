/**
 * EmployeeFormDialog (F4.1) — single-location selector + validation.
 *
 * Owner decision (1:1): one employee → one bo'g'in. The form exposes a
 * single location dropdown (no multi-checkbox, no per-row "Asosiy" radio);
 * the chosen location is implicitly primary.
 *
 * Username-only identity (migration 0027): the form has NO email field;
 * `username` is the required login handle.
 *
 * What we pin:
 *   1. Picking one bo'g'in then submitting POSTs
 *      `{username, location_ids:[id], primary_location_id:id}` to
 *      `/api/users` (one element, and never an `email`).
 *   2. Switching the role re-filters the dropdown and drops a now-invalid
 *      selection; the new role's location is sent.
 *   3. Validation — a blank/invalid username, a password under 8
 *      characters, or no location for an operational role surfaces the
 *      Uzbek error and never fires a fetch.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EmployeeFormDialog } from './EmployeeFormDialog';
import { renderWithProviders, jsonResponse } from '@/test/render-helpers';
import type { Location, User } from '@/lib/types';

const LOCATIONS: Location[] = [
  {
    id: 10,
    name: 'Filial-1',
    type: 'store',
    parent_id: null,
    manager_user_id: null,
    poster_storage_id: null,
    lead_time_days: null,
    review_days: null,
    safety_factor: null,
  },
  {
    id: 11,
    name: 'Filial-2',
    type: 'store',
    parent_id: null,
    manager_user_id: null,
    poster_storage_id: null,
    lead_time_days: null,
    review_days: null,
    safety_factor: null,
  },
];

describe('EmployeeFormDialog', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('submits {username, location_ids:[id], primary_location_id} for the chosen single location', async () => {
    const onSaved = vi.fn();
    const onOpenChange = vi.fn();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(201, { user: { id: 99 } }),
    );

    renderWithProviders(
      <EmployeeFormDialog
        open={true}
        onOpenChange={onOpenChange}
        locations={LOCATIONS}
        onSaved={onSaved}
      />,
    );
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Ism-familiya'), 'Test Hodim');
    await user.type(
      screen.getByLabelText('Foydalanuvchi nomi'),
      'test.hodim',
    );
    await user.type(screen.getByLabelText('Parol'), 'pass1234');

    // Pick exactly one location. It is implicitly primary.
    await user.selectOptions(screen.getByLabelText('Bo‘g‘in'), '11');

    await user.click(screen.getByRole('button', { name: 'Saqlash' }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
    });
    const call = fetchSpy.mock.calls[0]!;
    const url = typeof call[0] === 'string' ? call[0] : call[0]!.toString();
    expect(url).toContain('/api/users');
    const body = JSON.parse(((call[1] as RequestInit).body as string) ?? '{}');
    expect(body.name).toBe('Test Hodim');
    expect(body.username).toBe('test.hodim');
    // Email was removed from the identity model — never sent.
    expect('email' in body).toBe(false);
    expect(body.password).toBe('pass1234');
    expect(body.role).toBe('store_manager');
    expect(body.location_ids).toEqual([11]);
    expect(body.primary_location_id).toBe(11);
  });

  it('sends the lowercased username in the body', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(201, { user: { id: 99 } }),
    );

    renderWithProviders(
      <EmployeeFormDialog
        open={true}
        onOpenChange={() => {}}
        locations={LOCATIONS}
        onSaved={() => {}}
      />,
    );
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Ism-familiya'), 'Anvar K');
    await user.type(
      screen.getByLabelText(/foydalanuvchi nomi/i),
      'anvar.k',
    );
    await user.type(screen.getByLabelText('Parol'), 'pass1234');
    await user.selectOptions(screen.getByLabelText('Bo‘g‘in'), '10');

    await user.click(screen.getByRole('button', { name: 'Saqlash' }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
    });
    const body = JSON.parse(
      (fetchSpy.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.username).toBe('anvar.k');
  });

  it('rejects a blank username without firing a request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(201, { user: { id: 99 } }),
    );

    renderWithProviders(
      <EmployeeFormDialog
        open={true}
        onOpenChange={() => {}}
        locations={LOCATIONS}
        onSaved={() => {}}
      />,
    );
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Ism-familiya'), 'Test');
    await user.type(screen.getByLabelText('Parol'), 'pass1234');
    await user.selectOptions(screen.getByLabelText('Bo‘g‘in'), '10');

    await user.click(screen.getByRole('button', { name: 'Saqlash' }));

    // Username is the sole login handle and is required — a blank value
    // surfaces the Uzbek error and never fires a fetch.
    expect(screen.getByRole('alert').textContent).toMatch(
      /foydalanuvchi nomi/i,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects an invalid username pattern client-side', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(201, { user: { id: 99 } }),
    );

    renderWithProviders(
      <EmployeeFormDialog
        open={true}
        onOpenChange={() => {}}
        locations={LOCATIONS}
        onSaved={() => {}}
      />,
    );
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Ism-familiya'), 'Test');
    // A space is outside the `[a-z0-9._-]` charset — fails validation.
    await user.type(screen.getByLabelText(/foydalanuvchi nomi/i), 'bad name');
    await user.type(screen.getByLabelText('Parol'), 'pass1234');
    await user.selectOptions(screen.getByLabelText('Bo‘g‘in'), '10');

    await user.click(screen.getByRole('button', { name: 'Saqlash' }));

    expect(screen.getByRole('alert').textContent).toMatch(
      /foydalanuvchi nomi/i,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('filters the bo‘g‘in list by the selected role and clears a now-invalid selection', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(201, { user: { id: 99 } }),
    );

    // A mixed list: two stores + one central warehouse.
    const mixed: Location[] = [
      ...LOCATIONS,
      {
        id: 20,
        name: 'Markaz',
        type: 'central_warehouse',
        parent_id: null,
        manager_user_id: null,
        poster_storage_id: null,
        lead_time_days: null,
        review_days: null,
        safety_factor: null,
      },
    ];

    renderWithProviders(
      <EmployeeFormDialog
        open={true}
        onOpenChange={() => {}}
        locations={mixed}
        onSaved={() => {}}
      />,
    );
    const user = userEvent.setup();

    // Default role is store_manager → only the two stores are options.
    expect(
      screen.getByRole('option', { name: 'Filial-1' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: 'Filial-2' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('option', { name: 'Markaz' }),
    ).not.toBeInTheDocument();

    // Select a store, then switch role away from store_manager.
    await user.selectOptions(screen.getByLabelText('Bo‘g‘in'), '10');
    await user.selectOptions(
      screen.getByLabelText('Rol'),
      'central_warehouse_manager',
    );

    // Now only the central warehouse is an option; the store selection is gone.
    expect(
      screen.queryByRole('option', { name: 'Filial-1' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: 'Markaz' }),
    ).toBeInTheDocument();

    // Submitting without picking a valid location for the new role fails:
    // the Saqlash button is disabled until a location is chosen.
    await user.type(screen.getByLabelText('Ism-familiya'), 'Test');
    await user.type(screen.getByLabelText('Foydalanuvchi nomi'), 'cw.user');
    await user.type(screen.getByLabelText('Parol'), 'pass1234');
    expect(screen.getByRole('button', { name: 'Saqlash' })).toBeDisabled();
    expect(fetchSpy).not.toHaveBeenCalled();

    // Pick the valid central-warehouse location → submit succeeds with it.
    await user.selectOptions(screen.getByLabelText('Bo‘g‘in'), '20');
    await user.click(screen.getByRole('button', { name: 'Saqlash' }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
    });
    const body = JSON.parse(
      (fetchSpy.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.role).toBe('central_warehouse_manager');
    expect(body.location_ids).toEqual([20]);
    expect(body.primary_location_id).toBe(20);
  });

  it('never sends telegram_id in the create payload', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(201, { user: { id: 99 } }),
    );

    renderWithProviders(
      <EmployeeFormDialog
        open={true}
        onOpenChange={() => {}}
        locations={LOCATIONS}
        onSaved={() => {}}
      />,
    );
    const user = userEvent.setup();

    // The field itself is gone — TG linking is self-service on /profile.
    expect(screen.queryByLabelText(/telegram/i)).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Ism-familiya'), 'Test');
    await user.type(screen.getByLabelText('Foydalanuvchi nomi'), 'tg.user');
    await user.type(screen.getByLabelText('Parol'), 'pass1234');
    await user.selectOptions(screen.getByLabelText('Bo‘g‘in'), '10');
    await user.click(screen.getByRole('button', { name: 'Saqlash' }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
    });
    const body = JSON.parse(
      (fetchSpy.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect('telegram_id' in body).toBe(false);
  });

  it('rejects a password shorter than 8 characters without firing a request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(201, { user: { id: 99 } }),
    );

    renderWithProviders(
      <EmployeeFormDialog
        open={true}
        onOpenChange={() => {}}
        locations={LOCATIONS}
        onSaved={() => {}}
      />,
    );
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Ism-familiya'), 'Test');
    await user.type(screen.getByLabelText('Foydalanuvchi nomi'), 'testuser');
    await user.type(screen.getByLabelText('Parol'), 'short');
    await user.selectOptions(screen.getByLabelText('Bo‘g‘in'), '10');

    await user.click(screen.getByRole('button', { name: 'Saqlash' }));

    expect(screen.getByRole('alert').textContent).toMatch(/8 belgi/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does NOT offer "Ishlab chiqarish ombori boshlig‘i" (supply_manager) as a role option', () => {
    // Change #3 — sex_storage is managed by the production dept manager via
    // inheritance, so supply_manager is no longer separately assignable.
    renderWithProviders(
      <EmployeeFormDialog
        open={true}
        onOpenChange={() => {}}
        locations={LOCATIONS}
        onSaved={() => {}}
      />,
    );

    const roleSelect = screen.getByLabelText('Rol');
    expect(
      within(roleSelect).queryByRole('option', {
        name: /Ishlab chiqarish ombori boshlig/i,
      }),
    ).not.toBeInTheDocument();
    // production_manager stays.
    expect(
      within(roleSelect).getByRole('option', {
        name: /Ishlab chiqarish boshlig/i,
      }),
    ).toBeInTheDocument();
  });

  it('EDIT mode: PATCHes name/username/role and never sends a password field', async () => {
    const editUser: User = {
      id: 42,
      name: 'Anvar Karimov',
      username: 'anvar.k',
      role: 'store_manager',
      location_id: 10,
    };

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        // Per-user locations load on open (current single bo'g'in = 10).
        if (url.endsWith('/api/users/42/locations')) {
          return jsonResponse(200, [
            {
              location_id: 10,
              name: 'Filial-1',
              type: 'store',
              is_primary: true,
              assigned_at: '2026-01-01T00:00:00Z',
            },
          ]);
        }
        return jsonResponse(200, { user: { id: 42 } });
      },
    );

    const onSaved = vi.fn();
    renderWithProviders(
      <EmployeeFormDialog
        open={true}
        onOpenChange={() => {}}
        locations={LOCATIONS}
        user={editUser}
        onSaved={onSaved}
      />,
    );
    const user = userEvent.setup();

    // Title switches to edit copy; password field is gone.
    expect(screen.getByText('Hodimni tahrirlash')).toBeInTheDocument();
    expect(screen.queryByLabelText('Parol')).not.toBeInTheDocument();
    // Fields pre-filled.
    expect(screen.getByLabelText('Ism-familiya')).toHaveValue('Anvar Karimov');

    // Rename, keep the same location → only a PATCH, no /locations writes.
    const nameInput = screen.getByLabelText('Ism-familiya');
    await user.clear(nameInput);
    await user.type(nameInput, 'Anvar Karimov-Yangi');
    await user.click(screen.getByRole('button', { name: 'Saqlash' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());

    const patchCall = fetchSpy.mock.calls.find((c) => {
      const url = typeof c[0] === 'string' ? c[0] : c[0]!.toString();
      const method = (c[1] as RequestInit | undefined)?.method;
      return url.endsWith('/api/users/42') && method === 'PATCH';
    });
    expect(patchCall).toBeDefined();
    const body = JSON.parse(
      (patchCall![1] as RequestInit).body as string,
    );
    expect(body.name).toBe('Anvar Karimov-Yangi');
    expect(body.username).toBe('anvar.k');
    expect(body.role).toBe('store_manager');
    expect('password' in body).toBe(false);
    // Unchanged location → no POST/DELETE on /locations.
    const locationWrites = fetchSpy.mock.calls.filter((c) => {
      const url = typeof c[0] === 'string' ? c[0] : c[0]!.toString();
      const method = (c[1] as RequestInit | undefined)?.method;
      return /\/api\/users\/42\/locations/.test(url) && method !== undefined && method !== 'GET';
    });
    expect(locationWrites).toHaveLength(0);
  });

  it('EDIT mode: re-points the bo‘g‘in with assign-first then delete-old', async () => {
    const editUser: User = {
      id: 42,
      name: 'Anvar',
      username: 'anvar.k',
      role: 'store_manager',
      location_id: 10,
    };

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/api/users/42/locations') && true) {
          return jsonResponse(200, [
            {
              location_id: 10,
              name: 'Filial-1',
              type: 'store',
              is_primary: true,
              assigned_at: '2026-01-01T00:00:00Z',
            },
          ]);
        }
        return jsonResponse(200, {});
      },
    );

    renderWithProviders(
      <EmployeeFormDialog
        open={true}
        onOpenChange={() => {}}
        locations={LOCATIONS}
        user={editUser}
        onSaved={() => {}}
      />,
    );
    const user = userEvent.setup();

    // Wait for the locations load to settle the picker to the current 10.
    await waitFor(() =>
      expect(screen.getByLabelText('Bo‘g‘in')).toHaveValue('10'),
    );
    // Move to Filial-2 (id 11).
    await user.selectOptions(screen.getByLabelText('Bo‘g‘in'), '11');
    await user.click(screen.getByRole('button', { name: 'Saqlash' }));

    await waitFor(() => {
      const post = fetchSpy.mock.calls.find((c) => {
        const url = typeof c[0] === 'string' ? c[0] : c[0]!.toString();
        return (
          url.endsWith('/api/users/42/locations') &&
          (c[1] as RequestInit | undefined)?.method === 'POST'
        );
      });
      expect(post).toBeDefined();
    });

    const post = fetchSpy.mock.calls.find((c) => {
      const url = typeof c[0] === 'string' ? c[0] : c[0]!.toString();
      return (
        url.endsWith('/api/users/42/locations') &&
        (c[1] as RequestInit | undefined)?.method === 'POST'
      );
    })!;
    const postBody = JSON.parse((post[1] as RequestInit).body as string);
    expect(postBody.location_id).toBe(11);
    expect(postBody.is_primary).toBe(true);

    // The old location (10) is deleted afterwards.
    const del = fetchSpy.mock.calls.find((c) => {
      const url = typeof c[0] === 'string' ? c[0] : c[0]!.toString();
      return (
        url.endsWith('/api/users/42/locations/10') &&
        (c[1] as RequestInit | undefined)?.method === 'DELETE'
      );
    });
    expect(del).toBeDefined();
  });
});
