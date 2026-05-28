import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from '@/components/PageState';
import { ViewToggle, useViewMode } from '@/components/ViewToggle';
import { useApiQuery } from '@/hooks/useApiQuery';
import { ROLE_LABELS } from '@/lib/labels';
import type { Location, User } from '@/lib/types';
import { UserFormDialog } from './UserFormDialog';

/**
 * M1 — user accounts list (`pm` only — enforced by route + backend §6).
 */
export function UsersPage() {
  const users = useApiQuery<User[]>('/api/users');
  const locations = useApiQuery<Location[]>('/api/locations');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [view, setView] = useViewMode('users', 'card');

  const locationName = useMemo(() => {
    const map = new Map<number, string>();
    for (const l of locations.data ?? []) map.set(l.id, l.name);
    return map;
  }, [locations.data]);

  const rows = users.data ?? [];

  return (
    <div className="mx-auto max-w-[120rem] space-y-6">
      <PageHeader
        title="Foydalanuvchilar"
        description="Tizim foydalanuvchilari va ularning rollari."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <ViewToggle value={view} onChange={setView} />
            <Button onClick={() => setDialogOpen(true)}>
              <Plus className="size-4" aria-hidden="true" />
              Yangi foydalanuvchi
            </Button>
          </div>
        }
      />

      <Card
        className={
          view === 'card'
            ? 'border-0 bg-transparent p-0 shadow-none'
            : undefined
        }
      >
        {users.isLoading && <LoadingState />}
        {!users.isLoading && users.error && (
          <ErrorState message={users.error} onRetry={users.refetch} />
        )}
        {!users.isLoading && !users.error && rows.length === 0 && (
          <EmptyState message="Foydalanuvchilar topilmadi." />
        )}
        {!users.isLoading && !users.error && rows.length > 0 && view === 'card' && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {rows.map((u) => {
              const initials = u.name
                .split(' ')
                .map((s) => s[0])
                .filter(Boolean)
                .slice(0, 2)
                .join('')
                .toUpperCase();
              return (
                <div
                  key={u.id}
                  className="flex flex-col gap-3 rounded-lg border border-border/60 bg-card/40 p-4 shadow-sm"
                >
                  <div className="flex items-start gap-3">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-primary">
                      {initials || '?'}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold">{u.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {u.email}
                      </p>
                      {u.username && (
                        <p className="truncate font-mono text-[11px] text-muted-foreground/80">
                          @{u.username}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{ROLE_LABELS[u.role]}</Badge>
                    <span className="truncate text-xs text-muted-foreground">
                      {u.location_id
                        ? (locationName.get(u.location_id) ?? `#${u.location_id}`)
                        : 'Butun zanjir'}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {!users.isLoading && !users.error && rows.length > 0 && view === 'table' && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Ism-familiya</TableHead>
                <TableHead>Elektron pochta</TableHead>
                <TableHead>Foydalanuvchi nomi</TableHead>
                <TableHead>Rol</TableHead>
                <TableHead>Bo‘g‘in</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((u) => (
                <TableRow key={u.id}>
                  <TableCell className="font-medium">{u.name}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {u.email}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {u.username ? `@${u.username}` : '—'}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{ROLE_LABELS[u.role]}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {u.location_id
                      ? (locationName.get(u.location_id) ?? u.location_id)
                      : '— (butun zanjir)'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <UserFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        locations={locations.data ?? []}
        onSaved={users.refetch}
      />
    </div>
  );
}
