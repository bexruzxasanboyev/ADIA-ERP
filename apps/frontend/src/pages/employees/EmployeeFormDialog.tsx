import { useEffect, useState, type FormEvent } from 'react';
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
import { ROLE_OPTIONS } from '@/lib/labels';
import type { Location, LocationType, Role } from '@/lib/types';

/**
 * F4.1 — `pm`-only "Yangi hodim" form.
 *
 * Differs from the legacy `UserFormDialog` in two ways:
 *   1. Multi-select bo'g'inlar (checkbox list) instead of one location.
 *   2. A primary radio next to each selected row — backed by the
 *      `(user_id, location_id) WHERE is_primary` partial unique index.
 *
 * Submits a single `POST /api/users` with `{username, location_ids:[...],
 * primary_location_id}`. `username` is the sole login handle and is
 * REQUIRED — email was removed from the identity model (migration 0027).
 * Chain-wide roles (`pm`, `ai_assistant`) skip the location section
 * entirely — the backend rejects locations for those roles, mirroring the
 * DB CHECK.
 */
interface EmployeeFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Locations available as `location_ids` options. */
  locations: Location[];
  /** Called after a successful create so the parent list can refresh. */
  onSaved: () => void;
}

interface FormState {
  name: string;
  username: string;
  password: string;
  role: Role;
  /**
   * Set of selected location ids. Insertion order is preserved by `Set`,
   * which we rely on for the "first selected → defaults to primary" UX
   * below.
   */
  selectedLocationIds: Set<number>;
  primaryLocationId: number | null;
}

const EMPTY_FORM: FormState = {
  name: '',
  username: '',
  password: '',
  role: 'store_manager',
  selectedLocationIds: new Set(),
  primaryLocationId: null,
};

/** Roles whose principals are NOT bound to a bo'g'in (chain-wide view). */
const CHAIN_WIDE_ROLES: ReadonlySet<Role> = new Set(['pm', 'ai_assistant']);

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
  onSaved,
}: EmployeeFormDialogProps) {
  const { notify } = useToast();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      // Re-init on every open so a previous error / partial fill never
      // leaks into the next session.
      setForm({
        ...EMPTY_FORM,
        selectedLocationIds: new Set(),
      });
      setError(null);
    }
  }, [open]);

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
   * Switch role: re-filter the bo'g'in list and drop any selection that is
   * no longer valid for the new role so a mismatched assignment can never
   * be submitted.
   */
  function changeRole(nextRole: Role) {
    setForm((current) => {
      const types = ROLE_LOCATION_TYPES[nextRole];
      if (types === undefined) {
        return { ...current, role: nextRole };
      }
      const stillValid = new Set(
        [...current.selectedLocationIds].filter((id) =>
          locations.some((loc) => loc.id === id && types.has(loc.type)),
        ),
      );
      const primary =
        current.primaryLocationId !== null &&
        stillValid.has(current.primaryLocationId)
          ? current.primaryLocationId
          : (stillValid.values().next().value ?? null);
      return {
        ...current,
        role: nextRole,
        selectedLocationIds: stillValid,
        primaryLocationId: primary,
      };
    });
  }

  function toggleLocation(locationId: number) {
    setForm((current) => {
      const next = new Set(current.selectedLocationIds);
      let primary = current.primaryLocationId;
      if (next.has(locationId)) {
        next.delete(locationId);
        // If we just removed the row marked as primary, demote: prefer
        // the next remaining selection (insertion order).
        if (primary === locationId) {
          primary = next.size === 0 ? null : (next.values().next().value ?? null);
        }
      } else {
        next.add(locationId);
        if (primary === null) primary = locationId;
      }
      return { ...current, selectedLocationIds: next, primaryLocationId: primary };
    });
  }

  function setPrimary(locationId: number) {
    setForm((current) => {
      if (!current.selectedLocationIds.has(locationId)) return current;
      return { ...current, primaryLocationId: locationId };
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
    if (form.password.length < 8) {
      setError('Parol kamida 8 belgidan iborat bo‘lishi kerak.');
      return;
    }

    const locationIds = [...form.selectedLocationIds];
    if (locationRequired) {
      if (locationIds.length === 0) {
        setError('Bu rol uchun kamida bitta bo‘g‘in tanlash shart.');
        return;
      }
      if (
        form.primaryLocationId === null ||
        !locationIds.includes(form.primaryLocationId)
      ) {
        setError('Asosiy bo‘g‘in tanlanmagan.');
        return;
      }
    }

    // No `telegram_id` here by design: TG linking is self-service on the
    // /profile page. Admins never set a TG ID at create time; the field is
    // simply omitted from the payload.
    const body: Record<string, unknown> = {
      name,
      username,
      password: form.password,
      role: form.role,
    };
    if (locationRequired) {
      body['location_ids'] = locationIds;
      body['primary_location_id'] = form.primaryLocationId;
    }

    setIsSubmitting(true);
    try {
      await apiRequest('/api/users', { method: 'POST', body });
      notify('success', 'Hodim qo‘shildi.');
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Yangi hodim</DialogTitle>
          <DialogDescription>
            Hodim ma’lumotlarini va biriktiriladigan bo‘g‘inlarni kiriting.
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
          <div className="space-y-2">
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

          <div className="space-y-2">
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

          <div className="space-y-2">
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

          <div className="space-y-2">
            <Label htmlFor="employee-role">Rol</Label>
            <Select
              id="employee-role"
              name="role"
              value={form.role}
              onChange={(e) => changeRole(e.target.value as Role)}
            >
              {ROLE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </div>

          <fieldset
            className="space-y-2 rounded-md border border-border p-3"
            disabled={!locationRequired}
            aria-disabled={!locationRequired}
          >
            <legend className="px-1 text-sm font-medium">
              Bo‘g‘inlar
              {locationRequired ? (
                <span className="text-muted-foreground"> (kamida bittasi)</span>
              ) : (
                <span className="text-muted-foreground"> — kerak emas</span>
              )}
            </legend>

            {visibleLocations.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Bu rol uchun mos bo‘g‘in topilmadi.
              </p>
            ) : (
              <ul className="space-y-1">
                {visibleLocations.map((loc) => {
                  const selected = form.selectedLocationIds.has(loc.id);
                  const isPrimary = form.primaryLocationId === loc.id;
                  return (
                    <li
                      key={loc.id}
                      className="flex items-center justify-between gap-3 rounded-sm px-2 py-1 hover:bg-muted/40"
                    >
                      <label
                        className="flex flex-1 items-center gap-2 text-sm"
                        htmlFor={`employee-loc-${loc.id}`}
                      >
                        <input
                          id={`employee-loc-${loc.id}`}
                          type="checkbox"
                          className="size-4 rounded border-border"
                          checked={selected}
                          onChange={() => toggleLocation(loc.id)}
                          disabled={!locationRequired}
                        />
                        <span>{loc.name}</span>
                      </label>
                      <label
                        className="flex items-center gap-1 text-xs text-muted-foreground"
                        htmlFor={`employee-primary-${loc.id}`}
                      >
                        <input
                          id={`employee-primary-${loc.id}`}
                          type="radio"
                          name="primary_location"
                          className="size-3"
                          checked={isPrimary}
                          disabled={!selected || !locationRequired}
                          onChange={() => setPrimary(loc.id)}
                        />
                        Asosiy
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </fieldset>

          {error && (
            <p
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              role="alert"
            >
              {error}
            </p>
          )}
        </form>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            Bekor qilish
          </Button>
          <Button type="submit" form="employee-form" disabled={isSubmitting}>
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
