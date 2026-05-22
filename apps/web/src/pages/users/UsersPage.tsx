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

  const locationName = useMemo(() => {
    const map = new Map<number, string>();
    for (const l of locations.data ?? []) map.set(l.id, l.name);
    return map;
  }, [locations.data]);

  const rows = users.data ?? [];

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title="Foydalanuvchilar"
        description="Tizim foydalanuvchilari va ularning rollari."
        action={
          <Button onClick={() => setDialogOpen(true)}>
            <Plus className="size-4" aria-hidden="true" />
            Yangi foydalanuvchi
          </Button>
        }
      />

      <Card>
        {users.isLoading && <LoadingState />}
        {!users.isLoading && users.error && (
          <ErrorState message={users.error} onRetry={users.refetch} />
        )}
        {!users.isLoading && !users.error && rows.length === 0 && (
          <EmptyState message="Foydalanuvchilar topilmadi." />
        )}
        {!users.isLoading && !users.error && rows.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Ism-familiya</TableHead>
                <TableHead>Elektron pochta</TableHead>
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
