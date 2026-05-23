import { useState } from 'react';
import { Plus, Pencil } from 'lucide-react';
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
import { useAuth } from '@/hooks/useAuth';
import { LOCATION_TYPE_LABELS } from '@/lib/labels';
import type { Location } from '@/lib/types';
import { LocationFormDialog } from './LocationFormDialog';

/**
 * M1 — chain locations list. `pm` may create/edit; other roles see a
 * read-only list scoped to their own location by the backend (§6).
 */
export function LocationsPage() {
  const { user } = useAuth();
  const isPm = user?.role === 'pm';

  const { data, isLoading, error, refetch } =
    useApiQuery<Location[]>('/api/locations');

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Location | null>(null);

  const locations = data ?? [];

  function openCreate() {
    setEditing(null);
    setDialogOpen(true);
  }

  function openEdit(location: Location) {
    setEditing(location);
    setDialogOpen(true);
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title="Bo‘g‘inlar"
        description="Ta’minot zanjirining barcha bo‘g‘inlari."
        action={
          isPm ? (
            <Button onClick={openCreate}>
              <Plus className="size-4" aria-hidden="true" />
              Yangi bo‘g‘in
            </Button>
          ) : undefined
        }
      />

      <Card>
        {isLoading && <LoadingState />}
        {!isLoading && error && (
          <ErrorState message={error} onRetry={refetch} />
        )}
        {!isLoading && !error && locations.length === 0 && (
          <EmptyState message="Bo‘g‘inlar topilmadi." />
        )}
        {!isLoading && !error && locations.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nomi</TableHead>
                <TableHead>Turi</TableHead>
                <TableHead>Yetkazish (kun)</TableHead>
                {isPm && (
                  <TableHead className="w-16 text-right">Amal</TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {locations.map((location) => (
                <TableRow key={location.id}>
                  <TableCell className="font-medium">
                    {location.name}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">
                      {LOCATION_TYPE_LABELS[location.type]}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {location.lead_time_days ?? '—'}
                  </TableCell>
                  {isPm && (
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => openEdit(location)}
                        aria-label={`${location.name} ni tahrirlash`}
                      >
                        <Pencil className="size-4" />
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {isPm && (
        <LocationFormDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          location={editing}
          allLocations={locations}
          onSaved={refetch}
        />
      )}
    </div>
  );
}
