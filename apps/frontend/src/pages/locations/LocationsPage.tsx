import { useState } from 'react';
import {
  Plus,
  Pencil,
  Boxes,
  Factory,
  Truck,
  Warehouse,
  Store,
  MapPin,
  Waypoints,
} from 'lucide-react';
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
import { useAuth } from '@/hooks/useAuth';
import { LOCATION_TYPE_LABELS } from '@/lib/labels';
import type { Location, LocationType } from '@/lib/types';
import { LocationFormDialog } from './LocationFormDialog';
import { LocationFlowsDialog } from './LocationFlowsDialog';

const LOCATION_TYPE_ICON: Record<LocationType, typeof MapPin> = {
  raw_warehouse: Boxes,
  production: Factory,
  supply: Truck,
  sex_storage: Truck,
  central_warehouse: Warehouse,
  store: Store,
};

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
  const [flowsOpen, setFlowsOpen] = useState(false);
  const [editing, setEditing] = useState<Location | null>(null);
  const [view, setView] = useViewMode('locations', 'card');

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
    <div className="mx-auto max-w-[120rem] space-y-6">
      <PageHeader
        title="Bo‘g‘inlar"
        description="Ta’minot zanjirining barcha bo‘g‘inlari."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <ViewToggle value={view} onChange={setView} />
            {isPm && (
              <Button variant="outline" onClick={() => setFlowsOpen(true)}>
                <Waypoints className="size-4" aria-hidden="true" />
                Oqimlar
              </Button>
            )}
            {isPm && (
              <Button onClick={openCreate}>
                <Plus className="size-4" aria-hidden="true" />
                Yangi bo‘g‘in
              </Button>
            )}
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
        {isLoading && <LoadingState />}
        {!isLoading && error && (
          <ErrorState message={error} onRetry={refetch} />
        )}
        {!isLoading && !error && locations.length === 0 && (
          <EmptyState message="Bo‘g‘inlar topilmadi." />
        )}
        {!isLoading && !error && locations.length > 0 && view === 'card' && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {locations.map((location) => {
              const Icon = LOCATION_TYPE_ICON[location.type] ?? MapPin;
              return (
                <div
                  key={location.id}
                  className="flex flex-col gap-3 rounded-lg border border-border/60 bg-card/40 p-4 shadow-sm transition-colors hover:bg-card/70"
                >
                  <div className="flex items-start gap-3">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                      <Icon className="size-5" aria-hidden="true" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold">
                        {location.name}
                      </p>
                      <Badge variant="outline" className="mt-1">
                        {LOCATION_TYPE_LABELS[location.type]}
                      </Badge>
                    </div>
                    {isPm && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => openEdit(location)}
                        aria-label={`${location.name} ni tahrirlash`}
                      >
                        <Pencil className="size-4" />
                      </Button>
                    )}
                  </div>
                  <dl className="grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <dt className="text-muted-foreground">Yetkazish</dt>
                      <dd>
                        {location.lead_time_days
                          ? `${location.lead_time_days} kun`
                          : '—'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Boshliq</dt>
                      <dd>{location.manager_user_id ? `#${location.manager_user_id}` : '—'}</dd>
                    </div>
                  </dl>
                </div>
              );
            })}
          </div>
        )}
        {!isLoading && !error && locations.length > 0 && view === 'table' && (
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

      {isPm && (
        <LocationFlowsDialog
          open={flowsOpen}
          onOpenChange={setFlowsOpen}
          allLocations={locations}
        />
      )}
    </div>
  );
}
