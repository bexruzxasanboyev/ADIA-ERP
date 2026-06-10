import { useEffect, useState, type FormEvent } from 'react';
import {
  Eye,
  EyeOff,
  Loader2,
  LogOut,
  MapPin,
  Palette,
  Pencil,
  User as UserIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/PageState';
import { useToast } from '@/components/ui/toast';
import { useAuth } from '@/hooks/useAuth';
import { apiRequest, ApiError } from '@/lib/api-client';
import { LOCATION_TYPE_LABELS, ROLE_LABELS } from '@/lib/labels';
import type { User } from '@/lib/types';
import { TelegramLinkButton } from '@/pages/employees/TelegramLinkButton';
import { ThemeToggle } from '@/components/layout/ThemeToggle';

/**
 * EPIC 3 — self-service "Profil" page, reachable by EVERY authenticated
 * role (not PM-only). It centralises the things a user manages about
 * their OWN account:
 *
 *   - read-only identity (Ism, Login, Rol, biriktirilgan bo'g'inlar);
 *   - Telegram self-link (the flow moved here off the Hodimlar list —
 *     `TelegramLinkButton` is rendered for the current user, so the
 *     backend's owner-only token mint succeeds);
 *   - a "Parolni o'zgartirish" form → `POST /api/auth/change-password`
 *     with `{ current_password, new_password }`.
 *
 * Identity + locations come from the auth context (hydrated from
 * `GET /api/auth/me`); no extra fetch is needed.
 */

/** Minimum length enforced client-side; the backend is the final gate. */
const MIN_PASSWORD_LEN = 8;

/**
 * Same regex the backend enforces (migration 0027 `chk_users_username_format`):
 * lowercase letters, digits, dot, underscore, hyphen; 2-32 chars total.
 */
const USERNAME_PATTERN = /^[a-z0-9._-]{2,32}$/;

export function ProfilePage() {
  const { user, locations, updateUser, logout } = useAuth();
  const { notify } = useToast();

  // ── "Hisob ma'lumotlari" inline edit (own name + username) ──────────
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [usernameDraft, setUsernameDraft] = useState('');
  const [savingIdentity, setSavingIdentity] = useState(false);
  const [identityError, setIdentityError] = useState<string | null>(null);

  // Seed the drafts from the current user whenever an edit session opens
  // (or the user changes underneath us). Keeps the form honest after a
  // prior save / cancel.
  useEffect(() => {
    if (editing && user) {
      setNameDraft(user.name);
      setUsernameDraft(user.username);
      setIdentityError(null);
    }
  }, [editing, user]);

  function cancelIdentityEdit() {
    setEditing(false);
    setIdentityError(null);
  }

  async function handleIdentitySubmit(e: FormEvent) {
    e.preventDefault();
    if (!user) return;
    setIdentityError(null);

    const name = nameDraft.trim();
    const username = usernameDraft.trim();

    if (name === '') {
      setIdentityError('Ism bo‘sh bo‘lmasligi kerak.');
      return;
    }
    if (username === '') {
      setIdentityError('Login kiritilishi shart.');
      return;
    }
    if (!USERNAME_PATTERN.test(username)) {
      setIdentityError(
        'Login 2-32 belgi, faqat kichik harf/raqam/. _ - bo‘lishi mumkin.',
      );
      return;
    }

    // Only send fields that actually changed.
    const patch: { name?: string; username?: string } = {};
    if (name !== user.name) patch.name = name;
    if (username !== user.username) patch.username = username;

    if (Object.keys(patch).length === 0) {
      setEditing(false);
      return;
    }

    setSavingIdentity(true);
    try {
      const updated = await apiRequest<User>(`/api/users/${user.id}`, {
        method: 'PATCH',
        body: patch,
      });
      // Mirror the server's canonical row into the auth context so the
      // Profil card AND the sidebar user block update immediately.
      updateUser({ name: updated.name, username: updated.username });
      notify('success', 'Hisob ma’lumotlari yangilandi.');
      setEditing(false);
    } catch (err: unknown) {
      let message = 'Ma’lumotlarni saqlashda xatolik yuz berdi.';
      if (err instanceof ApiError) {
        message =
          err.status === 409
            ? 'Bu login allaqachon band.'
            : err.message;
      }
      setIdentityError(message);
      notify('error', message);
    } finally {
      setSavingIdentity(false);
    }
  }

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [show, setShow] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (next.length < MIN_PASSWORD_LEN) {
      setError(`Yangi parol kamida ${MIN_PASSWORD_LEN} ta belgidan iborat bo‘lsin.`);
      return;
    }
    if (next !== repeat) {
      setError('Yangi parol va uning takrori mos kelmadi.');
      return;
    }

    setSubmitting(true);
    try {
      await apiRequest('/api/auth/change-password', {
        method: 'POST',
        body: { current_password: current, new_password: next },
      });
      notify('success', 'Parol muvaffaqiyatli o‘zgartirildi.');
      setCurrent('');
      setNext('');
      setRepeat('');
    } catch (err: unknown) {
      const message =
        err instanceof ApiError
          ? err.message
          : 'Parolni o‘zgartirishda xatolik yuz berdi.';
      setError(message);
      notify('error', message);
    } finally {
      setSubmitting(false);
    }
  }

  if (!user) {
    return null;
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title="Profil"
        description="Hisobingiz ma’lumotlari, Telegram ulanishi va parol."
      />

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <UserIcon className="size-4 text-primary" aria-hidden="true" />
            Hisob ma’lumotlari
          </CardTitle>
          {!editing && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setEditing(true)}
            >
              <Pencil className="size-3.5" aria-hidden="true" />
              Tahrirlash
            </Button>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {editing ? (
            <form onSubmit={handleIdentitySubmit} className="space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="profile-name">Ism</Label>
                  <Input
                    id="profile-name"
                    required
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    disabled={savingIdentity}
                    aria-invalid={identityError !== null}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="profile-username">Login</Label>
                  <Input
                    id="profile-username"
                    required
                    value={usernameDraft}
                    onChange={(e) => setUsernameDraft(e.target.value)}
                    disabled={savingIdentity}
                    aria-invalid={identityError !== null}
                    aria-describedby="profile-username-hint"
                    className="font-mono"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                  <p
                    id="profile-username-hint"
                    className="text-xs text-muted-foreground"
                  >
                    2-32 belgi; kichik harf, raqam va . _ - belgilari.
                  </p>
                </div>
              </div>

              {identityError && (
                <p
                  className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                  role="alert"
                >
                  {identityError}
                </p>
              )}

              {/* Button order (DESIGN §9): ghost "Bekor" left, primary rightmost. */}
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={cancelIdentityEdit}
                  disabled={savingIdentity}
                >
                  Bekor qilish
                </Button>
                <Button type="submit" disabled={savingIdentity}>
                  {savingIdentity && (
                    <Loader2
                      className="size-4 animate-spin"
                      aria-hidden="true"
                    />
                  )}
                  Saqlash
                </Button>
              </div>
            </form>
          ) : (
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Ism
                </dt>
                <dd className="mt-1 text-sm font-medium">{user.name}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Login
                </dt>
                <dd className="mt-1 font-mono text-sm">@{user.username}</dd>
              </div>
            </dl>
          )}

          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Rol
              </dt>
              <dd className="mt-1">
                <Badge variant="outline">{ROLE_LABELS[user.role]}</Badge>
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Telegram
              </dt>
              <dd className="mt-1">
                <TelegramLinkButton user={user} directOpen />
              </dd>
            </div>
          </dl>

          <div>
            <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Biriktirilgan bo‘g‘inlar
            </dt>
            <dd className="mt-2 flex flex-wrap gap-2">
              {locations.length === 0 ? (
                <span className="text-sm text-muted-foreground">
                  Butun zanjir (alohida bo‘g‘in biriktirilmagan).
                </span>
              ) : (
                locations.map((loc) => (
                  <Badge
                    key={loc.id}
                    variant="outline"
                    className="gap-1 font-normal"
                  >
                    <MapPin className="size-3" aria-hidden="true" />
                    {loc.name}
                    <span className="text-muted-foreground">
                      · {LOCATION_TYPE_LABELS[loc.type]}
                    </span>
                    {loc.is_primary && (
                      <span className="ml-1 rounded-sm bg-primary/15 px-1 text-[10px] font-medium text-primary">
                        asosiy
                      </span>
                    )}
                  </Badge>
                ))
              )}
            </dd>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Parolni o‘zgartirish</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="current-password">Joriy parol</Label>
              <Input
                id="current-password"
                type={show ? 'text' : 'password'}
                autoComplete="current-password"
                required
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                disabled={submitting}
                aria-invalid={error !== null}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="new-password">Yangi parol</Label>
              <div className="relative">
                <Input
                  id="new-password"
                  type={show ? 'text' : 'password'}
                  autoComplete="new-password"
                  required
                  minLength={MIN_PASSWORD_LEN}
                  value={next}
                  onChange={(e) => setNext(e.target.value)}
                  disabled={submitting}
                  aria-invalid={error !== null}
                  aria-describedby="new-password-hint"
                  className="pr-10"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => setShow((v) => !v)}
                  disabled={submitting}
                  className="absolute right-0 top-0 size-9 text-muted-foreground hover:bg-transparent hover:text-foreground"
                  aria-label={show ? 'Parolni yashirish' : 'Parolni ko‘rsatish'}
                  aria-pressed={show}
                  tabIndex={-1}
                >
                  {show ? (
                    <EyeOff className="size-4" aria-hidden="true" />
                  ) : (
                    <Eye className="size-4" aria-hidden="true" />
                  )}
                </Button>
              </div>
              <p
                id="new-password-hint"
                className="text-xs text-muted-foreground"
              >
                Kamida {MIN_PASSWORD_LEN} ta belgi.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="repeat-password">Yangi parolni takrorlash</Label>
              <Input
                id="repeat-password"
                type={show ? 'text' : 'password'}
                autoComplete="new-password"
                required
                value={repeat}
                onChange={(e) => setRepeat(e.target.value)}
                disabled={submitting}
                aria-invalid={error !== null}
              />
            </div>

            {error && (
              <p
                className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                role="alert"
              >
                {error}
              </p>
            )}

            <Button type="submit" disabled={submitting}>
              {submitting && (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              )}
              Parolni o‘zgartirish
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* IA redesign — the theme toggle moved off the (now removed)
          sidebar into the self-service Profil page. */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Palette className="size-4 text-primary" aria-hidden="true" />
            Ko‘rinish (tema)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Interfeys rejimi: yorug‘, qorong‘i yoki tizim sozlamasi.
          </p>
          <ThemeToggle />
        </CardContent>
      </Card>

      {/* IA redesign — "Chiqish" moved here from the sidebar. A clear,
          intentional destructive sign-out: red outline that fills on hover,
          sensible auto width (not full-width, not oversized). */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sessiya</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">
            Hisobdan chiqish va joriy sessiyani yakunlash.
          </p>
          <Button
            type="button"
            variant="outline"
            className="w-full shrink-0 border-destructive/40 text-destructive hover:border-destructive hover:bg-destructive hover:text-destructive-foreground focus-visible:ring-destructive sm:w-auto"
            onClick={() => {
              void logout();
            }}
          >
            <LogOut className="size-4" aria-hidden="true" />
            Chiqish
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
