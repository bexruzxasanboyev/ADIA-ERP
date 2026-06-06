import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  EmptyState,
  ErrorState,
  LoadingState,
} from '@/components/PageState';
import { useToast } from '@/components/ui/toast';
import { useApiQuery } from '@/hooks/useApiQuery';
import { apiRequest, ApiError } from '@/lib/api-client';
import { ROLE_LABELS } from '@/lib/labels';
import type { User } from '@/lib/types';
import { MoneyInput } from './MoneyInput';

interface SalaryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Re-fetch the KPI table after a salary edit (per-unit oylik share shifts). */
  onChanged: () => void;
}

/**
 * "Xodim oyligi" manager — reuses the existing employees data
 * (`GET /api/users`) and lets the boss set each person's monthly salary
 * (1 000 000-format input). PATCH /api/users/:id/salary. The sum of
 * salaries feeds the KPI per-unit labour share, so a save re-fetches the
 * KPI table.
 */
export function SalaryDialog({
  open,
  onOpenChange,
  onChanged,
}: SalaryDialogProps) {
  const { notify } = useToast();
  const users = useApiQuery<User[]>(open ? '/api/users' : null);

  // Local draft of every salary, keyed by user id — seeded from the fetch.
  const [drafts, setDrafts] = useState<Record<number, number | null>>({});
  const [savingId, setSavingId] = useState<number | null>(null);

  useEffect(() => {
    if (!users.data) return;
    const next: Record<number, number | null> = {};
    for (const u of users.data) next[u.id] = u.monthly_salary ?? null;
    setDrafts(next);
  }, [users.data]);

  async function handleSave(user: User) {
    setSavingId(user.id);
    try {
      await apiRequest(`/api/users/${user.id}/salary`, {
        method: 'PATCH',
        body: { monthly_salary: drafts[user.id] ?? null },
      });
      notify('success', `${user.name} oyligi saqlandi.`);
      onChanged();
    } catch (err: unknown) {
      notify(
        'error',
        err instanceof ApiError ? err.message : 'Saqlashda xatolik yuz berdi.',
      );
    } finally {
      setSavingId(null);
    }
  }

  // Only production-department staff carry the KPI labour cost (owner rule).
  const list = (users.data ?? []).filter((u) => u.is_production);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Xodim oyligi</DialogTitle>
          <DialogDescription>
            Faqat ishlab chiqarish (sex) bo‘limlari xodimlari ko‘rsatiladi —
            oylik shu bo‘limlarga qo‘yiladi. Bu summalar 1 donaga to‘g‘ri
            keladigan oylik ulushni hisoblashda ishlatiladi.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-y-auto">
          {users.isLoading && <LoadingState />}
          {!users.isLoading && users.error && (
            <ErrorState message={users.error} onRetry={users.refetch} />
          )}
          {!users.isLoading && !users.error && list.length === 0 && (
            <EmptyState message="Ishlab chiqarish bo‘limlarida xodim topilmadi." />
          )}
          {!users.isLoading && !users.error && list.length > 0 && (
            <ul className="divide-y divide-border/60">
              {list.map((u) => (
                <li
                  key={u.id}
                  className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:gap-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{u.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {ROLE_LABELS[u.role]}
                    </p>
                  </div>
                  <div className="w-full sm:w-48">
                    <MoneyInput
                      value={drafts[u.id] ?? null}
                      onValueChange={(v) =>
                        setDrafts((d) => ({ ...d, [u.id]: v }))
                      }
                      placeholder="0"
                      aria-label={`${u.name} oylik maoshi`}
                    />
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => handleSave(u)}
                    disabled={savingId === u.id}
                  >
                    {savingId === u.id ? 'Saqlanmoqda…' : 'Saqlash'}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
