import { useMemo, useState } from 'react';
import { Plus, MapPin, Search } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
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
import {
  FilterPopover,
  type FilterGroup,
  type FilterValue,
} from '@/components/ui/filter-popover';
import { ViewToggle, useViewMode } from '@/components/ViewToggle';
import { useApiQuery } from '@/hooks/useApiQuery';
import { ROLE_LABELS, ROLE_OPTIONS } from '@/lib/labels';
import type { Location, User } from '@/lib/types';
import { EmployeeFormDialog } from './EmployeeFormDialog';
import { EmployeeLocationsDialog } from './EmployeeLocationsDialog';
import { TelegramLinkButton } from './TelegramLinkButton';

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
/** EPIC 3.2 — Telegram ulanish holati filter qiymatlari. */
const TG_STATUS_VALUES = { linked: 'linked', unlinked: 'unlinked' } as const;

export function EmployeesPage() {
  const users = useApiQuery<User[]>('/api/users');
  const locations = useApiQuery<Location[]>('/api/locations');
  const [createOpen, setCreateOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [view, setView] = useViewMode('employees', 'card');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterValue>({});

  const locationNameById = useMemo(() => {
    const map = new Map<number, string>();
    for (const l of locations.data ?? []) map.set(l.id, l.name);
    return map;
  }, [locations.data]);

  // EPIC 6.2 — one Filter entry point (rol + Telegram holat) instead of a
  // row of <select>s, reusing the shared FilterPopover (EPIC 1).
  const filterGroups = useMemo<FilterGroup[]>(
    () => [
      { key: 'role', label: 'Rol', options: ROLE_OPTIONS, searchable: true },
      {
        key: 'tg',
        label: 'Telegram',
        options: [
          { value: TG_STATUS_VALUES.linked, label: 'Ulangan' },
          { value: TG_STATUS_VALUES.unlinked, label: 'Ulanmagan' },
        ],
      },
    ],
    [],
  );

  const allRows = useMemo(() => users.data ?? [], [users.data]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const roleFilter = filter['role'] ?? [];
    const tgFilter = filter['tg'] ?? [];
    return allRows.filter((u) => {
      if (q !== '') {
        const haystack = `${u.name} ${u.email} ${u.username ?? ''}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      if (roleFilter.length > 0 && !roleFilter.includes(u.role)) return false;
      if (tgFilter.length > 0) {
        const linked = u.telegram_id != null;
        const matches = tgFilter.some((v) =>
          v === TG_STATUS_VALUES.linked ? linked : !linked,
        );
        if (!matches) return false;
      }
      return true;
    });
  }, [allRows, search, filter]);

  return (
    <div className="mx-auto max-w-[120rem] space-y-6">
      <PageHeader
        title="Hodimlar / Foydalanuvchilar"
        description="Hodim = foydalanuvchi: rollar, biriktirilgan bo‘g‘inlar va Telegram ulanishi."
        dateTime
        filter={
          <FilterPopover
            groups={filterGroups}
            value={filter}
            onApply={setFilter}
          />
        }
        action={
          <div className="flex flex-wrap items-center gap-2">
            <ViewToggle value={view} onChange={setView} />
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" aria-hidden="true" />
              Yangi hodim
            </Button>
          </div>
        }
      />

      <div className="relative max-w-sm">
        <Search
          className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Ism, email yoki foydalanuvchi nomi…"
          aria-label="Hodimlarni qidirish"
          className="h-9 pl-8"
        />
      </div>

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
          <EmptyState
            message={
              allRows.length === 0
                ? 'Hodimlar topilmadi.'
                : 'Filtr yoki qidiruv bo‘yicha hodim topilmadi.'
            }
          />
        )}
        {!users.isLoading && !users.error && rows.length > 0 && view === 'card' && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {rows.map((u) => {
              const primary = u.location_id
                ? (locationNameById.get(u.location_id) ?? `#${u.location_id}`)
                : 'Butun zanjir';
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
                  data-testid={`employee-card-${u.id}`}
                  className="flex w-full flex-col gap-3 rounded-lg border border-border/60 bg-card/40 p-4 text-left shadow-sm"
                >
                  {/* Clickable info region opens the bo'g'inlar dialog;
                      the footer holds standalone interactive controls so
                      we don't nest buttons inside a button (a11y). */}
                  <button
                    type="button"
                    onClick={() => setEditingUser(u)}
                    className="flex items-start gap-3 rounded-md text-left transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={`${u.name} ni tahrirlash`}
                  >
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
                  </button>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{ROLE_LABELS[u.role]}</Badge>
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <MapPin className="size-3" aria-hidden="true" />
                      {primary}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 border-t border-border/40 pt-3">
                    <TelegramLinkButton user={u} />
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
                <TableHead>Asosiy bo‘g‘in</TableHead>
                <TableHead>Telegram</TableHead>
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
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {u.username ? `@${u.username}` : '—'}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{ROLE_LABELS[u.role]}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {u.location_id
                      ? (locationNameById.get(u.location_id) ?? `#${u.location_id}`)
                      : '— (butun zanjir)'}
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <TelegramLinkButton user={u} />
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
