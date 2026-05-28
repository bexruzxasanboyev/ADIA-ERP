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
import type { Location, Role } from '@/lib/types';

interface UserFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Locations available as the `location_id` option. */
  locations: Location[];
  /** Called after a successful create so the list can refresh. */
  onSaved: () => void;
}

interface FormState {
  name: string;
  email: string;
  username: string;
  password: string;
  role: Role;
  location_id: string;
}

const EMPTY_FORM: FormState = {
  name: '',
  email: '',
  username: '',
  password: '',
  role: 'store_manager',
  location_id: '',
};

/**
 * F4.12 — same regex the backend enforces. Lowercase letters, digits,
 * dot, underscore, hyphen; 3-32 chars total.
 */
const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;

/**
 * Create dialog for a user account (M1, `pm` only).
 * Submits to `POST /api/users`. `pm` accounts are not location-bound;
 * all other roles require a `location_id` (db-schema CHECK).
 */
export function UserFormDialog({
  open,
  onOpenChange,
  locations,
  onSaved,
}: UserFormDialogProps) {
  const { notify } = useToast();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setForm(EMPTY_FORM);
      setError(null);
    }
  }, [open]);

  const locationRequired = form.role !== 'pm';

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (locationRequired && form.location_id === '') {
      setError('Bu rol uchun bo‘g‘in tanlanishi shart.');
      return;
    }

    const username = form.username.trim().toLowerCase();
    if (username !== '' && !USERNAME_PATTERN.test(username)) {
      setError(
        'Foydalanuvchi nomi 3-32 belgi, faqat kichik harf/raqam/. _ - bo‘lishi mumkin.',
      );
      return;
    }

    setIsSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        email: form.email.trim(),
        password: form.password,
        role: form.role,
        location_id: locationRequired ? Number(form.location_id) : null,
      };
      if (username !== '') {
        body['username'] = username;
      }
      await apiRequest('/api/users', {
        method: 'POST',
        body,
      });
      notify('success', 'Foydalanuvchi qo‘shildi.');
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Yangi foydalanuvchi</DialogTitle>
          <DialogDescription>
            Foydalanuvchi hisob ma’lumotlarini kiriting.
          </DialogDescription>
        </DialogHeader>

        <form id="user-form" className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <Label htmlFor="user-name">Ism-familiya</Label>
            <Input
              id="user-name"
              name="name"
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="user-email">Elektron pochta</Label>
            <Input
              id="user-email"
              name="email"
              type="email"
              autoComplete="off"
              required
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="user-username">
              Foydalanuvchi nomi (ixtiyoriy)
            </Label>
            <Input
              id="user-username"
              name="username"
              type="text"
              autoComplete="username"
              inputMode="text"
              pattern="[a-z0-9._\-]{3,32}"
              minLength={3}
              maxLength={32}
              placeholder="masalan: pm yoki anvar.k"
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              Bo‘sh qoldirsangiz email’dan avtomatik yaratiladi.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="user-password">Parol</Label>
            <Input
              id="user-password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="user-role">Rol</Label>
            <Select
              id="user-role"
              name="role"
              value={form.role}
              onChange={(e) =>
                setForm({ ...form, role: e.target.value as Role })
              }
            >
              {ROLE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="user-location">
              Bo‘g‘in{locationRequired ? '' : ' (ixtiyoriy)'}
            </Label>
            <Select
              id="user-location"
              name="location_id"
              value={form.location_id}
              disabled={!locationRequired}
              onChange={(e) =>
                setForm({ ...form, location_id: e.target.value })
              }
            >
              <option value="">— Tanlanmagan —</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </div>

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
          <Button type="submit" form="user-form" disabled={isSubmitting}>
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
