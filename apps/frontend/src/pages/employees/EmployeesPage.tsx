import { useMemo, useState } from 'react';
import { Plus, MapPin } from 'lucide-react';
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
import { EmployeeFormDialog } from './EmployeeFormDialog';
import { EmployeeLocationsDialog } from './EmployeeLocationsDialog';

/**
 * F4.1 — `pm`-only employees admin screen.
 *
 * Lists every account with its assigned bo'g'inlar (M:N). Two flows
 * open from here:
 *   - "Yangi hodim"          → `EmployeeFormDialog` (create + multi-assign)
 *   - row click              → `EmployeeLocationsDialog` (re-assignment)
 *
 * The list endpoint (`GET /api/users`) does NOT echo every assignment
 * to keep the response small; the locations dialog fetches the
 * per-user list on demand from `GET /api/users/:id/locations`. The
 * primary location is shown here as a single badge so the most-common
 * "where do they normally work?" question is answerable at a glance.
 */
export function EmployeesPage() {
  const users = useApiQuery<User[]>('/api/users');
  const locations = useApiQuery<Location[]>('/api/locations');
  const [createOpen, setCreateOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);

  const locationNameById = useMemo(() => {
    const map = new Map<number, string>();
    for (const l of locations.data ?? []) map.set(l.id, l.name);
    return map;
  }, [locations.data]);

  const rows = users.data ?? [];

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title="Hodimlar"
        description="Tizim foydalanuvchilari, rollar va biriktirilgan bo‘g‘inlar."
        action={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" aria-hidden="true" />
            Yangi hodim
          </Button>
        }
      />

      <Card>
        {users.isLoading && <LoadingState />}
        {!users.isLoading && users.error && (
          <ErrorState message={users.error} onRetry={users.refetch} />
        )}
        {!users.isLoading && !users.error && rows.length === 0 && (
          <EmptyState message="Hodimlar topilmadi." />
        )}
        {!users.isLoading && !users.error && rows.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Ism-familiya</TableHead>
                <TableHead>Elektron pochta</TableHead>
                <TableHead>Rol</TableHead>
                <TableHead>Asosiy bo‘g‘in</TableHead>
                <TableHead className="w-40 text-right">Amal</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((u) => (
                <TableRow
                  key={u.id}
                  className="cursor-pointer hover:bg-muted/30"
                  onClick={() => setEditingUser(u)}
                  data-testid={`employee-row-${u.id}`}
                >
                  <TableCell className="font-medium">{u.name}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {u.email}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{ROLE_LABELS[u.role]}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {u.location_id
                      ? (locationNameById.get(u.location_id) ?? `#${u.location_id}`)
                      : '— (butun zanjir)'}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      // Stop the row click from also firing.
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingUser(u);
                      }}
                      aria-label={`${u.name} ning bo‘g‘inlarini boshqarish`}
                    >
                      <MapPin className="size-4" aria-hidden="true" />
                      Bo‘g‘inlar
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <EmployeeFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        locations={locations.data ?? []}
        onSaved={users.refetch}
      />

      <EmployeeLocationsDialog
        user={editingUser}
        allLocations={locations.data ?? []}
        onOpenChange={(open) => {
          if (!open) setEditingUser(null);
        }}
        onChanged={users.refetch}
      />
    </div>
  );
}
