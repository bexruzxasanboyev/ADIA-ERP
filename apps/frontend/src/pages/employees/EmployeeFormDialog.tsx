import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { apiRequest, ApiError } from '@/lib/api-client';
import { ROLE_LABELS, ROLE_OPTIONS } from '@/lib/labels';
import type {
  Location,
  LocationType,
  Role,
  User,
  UserLocation,
} from '@/lib/types';

/**
 * F4.1 — `pm`-only "Yangi hodim" / "Hodimni tahrirlash" form.
 *
 * Owner decision (1:1): an employee is bound to EXACTLY ONE bo'g'in. The
 * form exposes a single location selector (no multi-checkbox, no per-row
 * "Asosiy" radio) — the chosen location is implicitly primary.
 *
 * CREATE mode (no `user` prop): submits a single `POST /api/users` with
 * `{username, password, role, location_ids:[id], primary_location_id:id}`.
 * `username` is the sole login handle and is REQUIRED — email was removed
 * from the identity model (migration 0027).
 *
 * EDIT mode (`user` prop set): submits `PATCH /api/users/:id` for
 * `{name, username, role}` and, when the location changed, runs the same
 * assign-first / delete-after single-location flow `EmployeeLocationsDialog`
 * uses (POST `/locations` is_primary=true, then DELETE the others). Password
 * is NOT edited here (a dedicated reset flow owns that). The current location
 * is loaded on open via `GET /api/users/:id/locations`.
 *
 * Chain-wide roles (`pm`, `ai_assistant`) skip the location section entirely —
 * the backend rejects locations for those roles, mirroring the DB CHECK.
 */
interface EmployeeFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Locations available as the `location_id` option set. */
  locations: Location[];
  /**
   * When set the dialog is in EDIT mode and pre-fills from this user; when
   * `undefined`/`null` it is in CREATE mode ("Yangi hodim").
   */
  user?: User | null;
  /** Called after a successful create/edit so the parent list can refresh. */
  onSaved: () => void;
}

interface FormState {
  name: string;
  username: string;
  password: string;
  role: Role;
  /** The single chosen location id, or `null` when none is picked yet. */
  locationId: number | null;
}

const EMPTY_FORM: FormState = {
  name: '',
  username: '',
  password: '',
  role: 'store_manager',
  locationId: null,
};

/** Roles whose principals are NOT bound to a bo'g'in (chain-wide view). */
const CHAIN_WIDE_ROLES: ReadonlySet<Role> = new Set(['pm', 'ai_assistant']);

/**
 * Roles that may NO LONGER be assigned to a NEW or edited employee.
 *
 * `supply_manager` ("Ishlab chiqarish ombori boshlig'i", a `sex_storage`
 * manager) is removed at the owner's request: a production warehouse
 * (sex_storage) is NOT staffed separately — it is managed by the production
 * DEPARTMENT's manager (`production_manager`) via inheritance. We only drop it
 * as a SELECTABLE option; existing `supply_manager` users still render in the
 * roster under their group, and an employee already on that role keeps it
 * pinned (shown read-only) in edit mode rather than being silently rewritten.
 */
const NON_ASSIGNABLE_ROLES: ReadonlySet<Role> = new Set<Role>(['supply_manager']);

/**
 * Which `location_type`(s) each role may be assigned to. Mirrors the
 * chain layout / navigation pairing (a role manages exactly one layer):
 *   - store_manager              → store
 *   - central_warehouse_manager  → central_warehouse
 *   - raw_warehouse_manager      → raw_warehouse
 *   - production_manager         → production (the sexlar)
 *   - supply_manager             → sex_storage (sex skladlari — labelled
 *                                  "Ishlab chiqarish ombori boshlig'i")
 * Chain-wide roles (`pm`, `ai_assistant`) are absent: they take no
 * location, so the section is disabled for them entirely.
 */
const ROLE_LOCATION_TYPES: Partial<Record<Role, ReadonlySet<LocationType>>> = {
  store_manager: new Set(['store']),
  central_warehouse_manager: new Set(['central_warehouse']),
  raw_warehouse_manager: new Set(['raw_warehouse']),
  production_manager: new Set(['production']),
  supply_manager: new Set(['sex_storage']),
};

/**
 * Same regex the backend enforces (migration 0027 `chk_users_username_format`).
 * Lowercase letters, digits, dot, underscore, hyphen; 2-32 chars total (the
 * 2-char floor admits the canonical admin login `pm`).
 */
const USERNAME_PATTERN = /^[a-z0-9._-]{2,32}$/;

export function EmployeeFormDialog({
  open,
  onOpenChange,
  locations,
  user,
  onSaved,
}: EmployeeFormDialogProps) {
  const { notify } = useToast();
  const isEdit = user != null;
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * The user's current single (primary) location, loaded on open in EDIT
   * mode so the picker pre-fills and we know which assignments to remove on
   * save. `null` while loading or for a user with no assignment.
   */
  const [initialLocationId, setInitialLocationId] = useState<number | null>(
    null,
  );
  /** Every previously-assigned location id (edit mode) — the delete set. */
  const [existingLocationIds, setExistingLocationIds] = useState<number[]>([]);

  useEffect(() => {
    if (!open) return;
    // Re-init on every open so a previous error / partial fill never leaks
    // into the next session.
    setError(null);
    if (user == null) {
      setForm(EMPTY_FORM);
      setInitialLocationId(null);
      setExistingLocationIds([]);
      return;
    }
    // EDIT mode: seed from the user. Location is pre-filled from the user's
    // primary id immediately, then refined by the per-user locations fetch
    // (which also gives us the full delete set).
    setForm({
      name: user.name,
      username: user.username,
      password: '',
      role: user.role,
      locationId: user.location_id ?? null,
    });
    setInitialLocationId(user.location_id ?? null);
    setExistingLocationIds(
      user.location_id != null ? [user.location_id] : [],
    );
    if (CHAIN_WIDE_ROLES.has(user.role)) return;
    let cancelled = false;
    void (async () => {
      try {
        const rows = await apiRequest<UserLocation[]>(
          `/api/users/${user.id}/locations`,
        );
        if (cancelled) return;
        const primary = rows.find((r) => r.is_primary) ?? rows[0] ?? null;
        setInitialLocationId(primary ? primary.location_id : null);
        setExistingLocationIds(rows.map((r) => r.location_id));
        setForm((f) => ({
          ...f,
          locationId: primary ? primary.location_id : f.locationId,
        }));
      } catch {
        // Non-fatal: keep the primary-id seed from the list row. The save
        // flow still works off `users.location_id`.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, user]);

  /**
   * Role picker options. We hide `supply_manager` (see NON_ASSIGNABLE_ROLES)
   * for both create and edit. In edit mode, if the employee ALREADY holds a
   * now-non-assignable role we re-add it (disabled) so the form shows the
   * truth and never silently rewrites the role on save.
   */
  const roleOptions = useMemo<
    { value: Role; label: string; disabled: boolean }[]
  >(() => {
    const base = ROLE_OPTIONS.filter(
      (o) => !NON_ASSIGNABLE_ROLES.has(o.value),
    ).map((o) => ({ ...o, disabled: false }));
    if (
      isEdit &&
      NON_ASSIGNABLE_ROLES.has(form.role) &&
      !base.some((o) => o.value === form.role)
    ) {
      return [
        ...base,
        { value: form.role, label: ROLE_LABELS[form.role], disabled: true },
      ];
    }
    return base;
  }, [isEdit, form.role]);

  const locationRequired = !CHAIN_WIDE_ROLES.has(form.role);

  // Only the location types this role may manage. `undefined` (chain-wide
  // roles) means "no restriction" — but those roles take no location at
  // all, so the section is disabled anyway.
  const allowedTypes = ROLE_LOCATION_TYPES[form.role];
  const visibleLocations =
    allowedTypes === undefined
      ? locations
      : locations.filter((loc) => allowedTypes.has(loc.type));

  /**
   * Switch role: re-filter the bo'g'in list and drop the current selection
   * if it is no longer valid for the new role so a mismatched assignment
   * can never be submitted.
   */
  function changeRole(nextRole: Role) {
    setForm((current) => {
      const types = ROLE_LOCATION_TYPES[nextRole];
      if (types === undefined) {
        return { ...current, role: nextRole };
      }
      const stillValid =
        current.locationId !== null &&
        locations.some(
          (loc) => loc.id === current.locationId && types.has(loc.type),
        )
          ? current.locationId
          : null;
      return { ...current, role: nextRole, locationId: stillValid };
    });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const name = form.name.trim();
    const username = form.username.trim().toLowerCase();
    if (name === '') {
      setError('Ism-familiya bo‘sh bo‘lmasligi kerak.');
      return;
    }
    // Username is the sole login handle (email was removed). It is REQUIRED
    // and must match the same regex the backend enforces, or the server
    // returns 422.
    if (username === '') {
      setError('Foydalanuvchi nomi kiritilishi shart.');
      return;
    }
    if (!USERNAME_PATTERN.test(username)) {
      setError(
        'Foydalanuvchi nomi 2-32 belgi, faqat kichik harf/raqam/. _ - bo‘lishi mumkin.',
      );
      return;
    }
    // Password is only set at CREATE time (a dedicated reset flow owns it in
    // edit mode), so the 8-char floor applies to create only.
    if (!isEdit && form.password.length < 8) {
      setError('Parol kamida 8 belgidan iborat bo‘lishi kerak.');
      return;
    }

    if (locationRequired && form.locationId === null) {
      setError('Bu rol uchun bo‘g‘in tanlash shart.');
      return;
    }

    setIsSubmitting(true);
    try {
      if (isEdit && user != null) {
        await submitEdit(user, name, username);
        notify('success', 'Hodim yangilandi.');
      } else {
        await submitCreate(name, username);
        notify('success', 'Hodim qo‘shildi.');
      }
      onOpenChange(false);
      onSaved();
    } catch (err: unknown) {
      setError(
        err instanceof ApiError ? err.message : 'Saqlashda xatolik yuz berdi.',
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  /** CREATE: one POST /api/users carrying credentials + the single bo'g'in. */
  async function submitCreate(name: string, username: string) {
    // No `telegram_id` here by design: TG linking is self-service on the
    // /profile page. Admins never set a TG ID at create time; the field is
    // simply omitted from the payload.
    const body: Record<string, unknown> = {
      name,
      username,
      password: form.password,
      role: form.role,
    };
    if (locationRequired && form.locationId !== null) {
      // One employee → one bo'g'in. Sent on the M:N path (the backend
      // accepts a single-element `location_ids` + matching
      // `primary_location_id`); the lone location is implicitly primary.
      body['location_ids'] = [form.locationId];
      body['primary_location_id'] = form.locationId;
    }
    await apiRequest('/api/users', { method: 'POST', body });
  }

  /**
   * EDIT: PATCH the scalar fields, then re-point the single location with the
   * same assign-first / delete-after flow `EmployeeLocationsDialog` uses so
   * the user is never left with zero locations and the "can't delete primary"
   * rule is never hit.
   */
  async function submitEdit(target: User, name: string, username: string) {
    await apiRequest(`/api/users/${target.id}`, {
      method: 'PATCH',
      body: { name, username, role: form.role },
    });

    if (!locationRequired) return; // chain-wide role owns no location.
    if (form.locationId === null) return; // guarded above for required roles.
    if (form.locationId === initialLocationId) return; // unchanged.

    // 1. Assign the new location as primary (mirrors users.location_id).
    await apiRequest(`/api/users/${target.id}/locations`, {
      method: 'POST',
      body: { location_id: form.locationId, is_primary: true },
    });
    // 2. Drop every OTHER previously-assigned location → collapse to one.
    const toRemove = existingLocationIds.filter((id) => id !== form.locationId);
    for (const locationId of toRemove) {
      await apiRequest(`/api/users/${target.id}/locations/${locationId}`, {
        method: 'DELETE',
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Hodimni tahrirlash' : 'Yangi hodim'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? 'Hodim ma’lumotlarini, rolini va biriktirilgan bo‘g‘inni o‘zgartiring.'
              : 'Hodim ma’lumotlarini va biriktiriladigan bo‘g‘inni kiriting (har hodimga bitta bo‘g‘in).'}
          </DialogDescription>
        </DialogHeader>

        <form
          id="employee-form"
          className="max-h-[60vh] space-y-4 overflow-y-auto pr-1"
          onSubmit={handleSubmit}
          // JS-level validation gives the Uzbek error messages; the
          // browser's default tooltip stays in English which feels off
          // for our Uzbek UI. We keep `required`/`minLength` on inputs
          // for documentation + screen-reader hints but skip the
          // built-in submit gate.
          noValidate
        >
          <div className="space-y-1.5">
            <Label htmlFor="employee-name">Ism-familiya</Label>
            <Input
              id="employee-name"
              name="name"
              autoComplete="name"
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="employee-username">Foydalanuvchi nomi</Label>
            <Input
              id="employee-username"
              name="username"
              type="text"
              autoComplete="username"
              inputMode="text"
              required
              pattern="[a-z0-9._\-]{2,32}"
              minLength={2}
              maxLength={32}
              placeholder="masalan: pm yoki anvar.k"
              value={form.username}
              onChange={(e) =>
                setForm({ ...form, username: e.target.value })
              }
            />
            <p className="text-xs text-muted-foreground">
              Tizimga kirish uchun ishlatiladi. 2-32 belgi, faqat kichik harf,
              raqam, <code>. _ -</code>.
            </p>
          </div>

          {/* Password is create-only — a separate reset flow owns it in edit
              mode, so the field is hidden when editing an existing hodim. */}
          {!isEdit && (
            <div className="space-y-1.5">
              <Label htmlFor="employee-password">Parol</Label>
              <Input
                id="employee-password"
                name="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                Kamida 8 belgi.
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="employee-role">Rol</Label>
            <Select
              id="employee-role"
              name="role"
              value={form.role}
              onChange={(e) => changeRole(e.target.value as Role)}
            >
              {roleOptions.map((opt) => (
                <option key={opt.value} value={opt.value} disabled={opt.disabled}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </div>

          {locationRequired && (
            <div className="space-y-1.5">
              <Label htmlFor="employee-location">Bo‘g‘in</Label>
              {visibleLocations.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Bu rol uchun mos bo‘g‘in topilmadi.
                </p>
              ) : (
                <Select
                  id="employee-location"
                  name="location"
                  value={form.locationId === null ? '' : String(form.locationId)}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      locationId:
                        e.target.value === '' ? null : Number(e.target.value),
                    })
                  }
                >
                  <option value="">— Tanlanmagan —</option>
                  {visibleLocations.map((loc) => (
                    <option key={loc.id} value={loc.id}>
                      {loc.name}
                    </option>
                  ))}
                </Select>
              )}
            </div>
          )}

          {error && (
            <p
              className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              role="alert"
            >
              {error}
            </p>
          )}
        </form>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            Bekor qilish
          </Button>
          <Button
            type="submit"
            form="employee-form"
            disabled={
              isSubmitting ||
              (locationRequired && form.locationId === null)
            }
          >
            {isSubmitting && (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            )}
            Saqlash
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
