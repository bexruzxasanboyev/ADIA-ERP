/**
 * EmployeeFormDialog (F4.1) — multi-location + primary radio + validation.
 *
 * What we pin:
 *   1. Selecting two bo'g'inlar then submitting POSTs
 *      `{location_ids:[a,b], primary_location_id:a}` to `/api/users`.
 *   2. The first checkbox toggled defaults to primary; switching the
 *      radio reassigns primary without altering the selection set.
 *   3. Validation — password under 8 characters surfaces the Uzbek
 *      error and never fires a fetch.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EmployeeFormDialog } from './EmployeeFormDialog';
import { renderWithProviders, jsonResponse } from '@/test/render-helpers';
import type { Location } from '@/lib/types';

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

  it('submits {location_ids, primary_location_id} for multi-location selection', async () => {
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
      screen.getByLabelText('Elektron pochta'),
      'test@adia.local',
    );
    await user.type(screen.getByLabelText('Parol'), 'pass1234');

    // Pick both locations. First toggled becomes primary by default.
    await user.click(screen.getByLabelText('Filial-1'));
    await user.click(screen.getByLabelText('Filial-2'));

    await user.click(screen.getByRole('button', { name: 'Saqlash' }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
    });
    const call = fetchSpy.mock.calls[0]!;
    const url = typeof call[0] === 'string' ? call[0] : call[0]!.toString();
    expect(url).toContain('/api/users');
    const body = JSON.parse(((call[1] as RequestInit).body as string) ?? '{}');
    expect(body.name).toBe('Test Hodim');
    expect(body.email).toBe('test@adia.local');
    expect(body.password).toBe('pass1234');
    expect(body.role).toBe('store_manager');
    expect(body.location_ids).toEqual([10, 11]);
    expect(body.primary_location_id).toBe(10);
  });

  it('reassigns primary via the radio without changing the selection set', async () => {
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

    await user.type(screen.getByLabelText('Ism-familiya'), 'X');
    await user.type(screen.getByLabelText('Elektron pochta'), 'x@adia.local');
    await user.type(screen.getByLabelText('Parol'), 'pass1234');

    await user.click(screen.getByLabelText('Filial-1'));
    await user.click(screen.getByLabelText('Filial-2'));

    // Switch primary to Filial-2. The radio is the SECOND "Asosiy" — we
    // pick the radio inside Filial-2's row by id.
    const filial2Primary = document.getElementById(
      'employee-primary-11',
    ) as HTMLInputElement;
    await user.click(filial2Primary);

    await user.click(screen.getByRole('button', { name: 'Saqlash' }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
    });
    const body = JSON.parse(
      (fetchSpy.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.location_ids).toEqual([10, 11]);
    expect(body.primary_location_id).toBe(11);
  });

  it('sends the optional username when supplied (F4.12)', async () => {
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
      screen.getByLabelText('Elektron pochta'),
      'anvar@adia.local',
    );
    await user.type(
      screen.getByLabelText(/foydalanuvchi nomi/i),
      'anvar.k',
    );
    await user.type(screen.getByLabelText('Parol'), 'pass1234');
    await user.click(screen.getByLabelText('Filial-1'));

    await user.click(screen.getByRole('button', { name: 'Saqlash' }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
    });
    const body = JSON.parse(
      (fetchSpy.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.username).toBe('anvar.k');
  });

  it('omits username from the body when the field is left blank (F4.12)', async () => {
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
    await user.type(
      screen.getByLabelText('Elektron pochta'),
      'test@adia.local',
    );
    await user.type(screen.getByLabelText('Parol'), 'pass1234');
    await user.click(screen.getByLabelText('Filial-1'));

    await user.click(screen.getByRole('button', { name: 'Saqlash' }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
    });
    const body = JSON.parse(
      (fetchSpy.mock.calls[0]![1] as RequestInit).body as string,
    );
    // No `username` key — the backend derives one from the email
    // local-part. Sending an empty string would 422.
    expect('username' in body).toBe(false);
  });

  it('rejects an invalid username pattern client-side (F4.12)', async () => {
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
    await user.type(
      screen.getByLabelText('Elektron pochta'),
      'test@adia.local',
    );
    // Capital letter + space + 2 chars — fails on both length and charset.
    await user.type(screen.getByLabelText(/foydalanuvchi nomi/i), 'AB');
    await user.type(screen.getByLabelText('Parol'), 'pass1234');
    await user.click(screen.getByLabelText('Filial-1'));

    await user.click(screen.getByRole('button', { name: 'Saqlash' }));

    expect(screen.getByRole('alert').textContent).toMatch(
      /foydalanuvchi nomi/i,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
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
    await user.type(screen.getByLabelText('Elektron pochta'), 'a@b.uz');
    await user.type(screen.getByLabelText('Parol'), 'short');
    await user.click(screen.getByLabelText('Filial-1'));

    await user.click(screen.getByRole('button', { name: 'Saqlash' }));

    expect(screen.getByRole('alert').textContent).toMatch(/8 belgi/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
