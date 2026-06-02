import { useMemo, useState } from 'react';
import { Plus, MapPin, Search, X } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
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
import { useApiQuery } from '@/hooks/useApiQuery';
import { ROLE_ACCENT_STYLE, ROLE_LABELS, ROLE_OPTIONS } from '@/lib/labels';
import { cn } from '@/lib/utils';
import type { Location, Role, User } from '@/lib/types';
import { EmployeeFormDialog } from './EmployeeFormDialog';
import { EmployeeLocationsDialog } from './EmployeeLocationsDialog';

/**
 * F4.1 — `pm`-only employees admin screen.
 *
 * Lists every account with its assigned bo'g'inlar (M:N). Two flows
 * open from here:
 *   - "Yangi hodim"          → `EmployeeFormDialog` (create + multi-assign)
 *   - row/card click         → `EmployeeLocationsDialog` (re-assignment)
 *
 * EPIC 3 redesign — mirrors the Mahsulotlar (products) page layout:
 *   - a single content row: the search box (LEFT) + Filter popover (RIGHT);
 *   - role is one of the Filter groups (multi-select), no separate tab row;
 *   - cards are grouped into colour-coded sections by role over the
 *     search+filter-narrowed set (this page is card-only — no view toggle).
 *
 * Telegram linking moved OUT of this list: it is self-service and now
 * lives on the /profile page. Here we only show a READ-ONLY status badge
 * (TG ulangan / TG ulanmagan) per row.
 *
 * The list endpoint (`GET /api/users`) does NOT echo every assignment
 * to keep the response small; the locations dialog fetches the per-user
 * list on demand. The primary location is shown here as a single badge.
 */
/** EPIC 3.2 — Telegram ulanish holati filter qiymatlari. */
const TG_STATUS_VALUES = { linked: 'linked', unlinked: 'unlinked' } as const;

/** Read-only Telegram status pill (no interaction — linking lives on /profile). */
function TgStatusBadge({ linked }: { linked: boolean }) {
  if (linked) {
    return (
      <Badge
        variant="outline"
        className="gap-1 border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
        aria-label="Telegram ulangan"
      >
        TG ulangan
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="gap-1 border-border/60 text-muted-foreground"
      aria-label="Telegram ulanmagan"
    >
      TG ulanmagan
    </Badge>
  );
}

export function EmployeesPage() {
  const users = useApiQuery<User[]>('/api/users');
  const locations = useApiQuery<Location[]>('/api/locations');
  const [createOpen, setCreateOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterValue>({ role: [], tg: [] });

  const locationNameById = useMemo(() => {
    const map = new Map<number, string>();
    for (const l of locations.data ?? []) map.set(l.id, l.name);
    return map;
  }, [locations.data]);

  // EPIC 6.2 — one Filter entry point next to the search box. Role moved
  // out of the page-level tab row INTO the popover as the first (searchable)
  // group, alongside the Telegram ulanish holat group.
  const filterGroups = useMemo<FilterGroup[]>(
    () => [
      { key: 'role', label: 'Rol', searchable: true, options: ROLE_OPTIONS },
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

  // Search + Role + Telegram filters. Role is now a multi-select from the
  // Filter popover (`filter.role`); empty means "all roles".
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const roleFilter = filter['role'] ?? [];
    const tgFilter = filter['tg'] ?? [];
    return allRows.filter((u) => {
      if (q !== '') {
        const haystack = `${u.name} ${u.username}`.toLowerCase();
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

  // Group the search+filter-narrowed rows by role into colour-coded sections.
  // Sections follow the ROLE_OPTIONS order, with ai_assistant pinned last;
  // only roles still present after filtering are shown.
  const cardGroups = useMemo(() => {
    const order: Role[] = [
      ...ROLE_OPTIONS.map((o) => o.value),
      'ai_assistant',
    ];
    const buckets = new Map<Role, User[]>();
    for (const u of rows) {
      const list = buckets.get(u.role);
      if (list) list.push(u);
      else buckets.set(u.role, [u]);
    }
    return order
      .filter((role) => buckets.has(role))
      .map((role) => ({ role, items: buckets.get(role) ?? [] }));
  }, [rows]);

  const isEmpty = cardGroups.length === 0;

  return (
    <div className="mx-auto max-w-[120rem] space-y-6">
      <PageHeader
        title="Hodimlar / Foydalanuvchilar"
        description="Hodim = foydalanuvchi: rollar va biriktirilgan bo‘g‘inlar. Telegram ulanish — Profil sahifasida."
        actions={
          <>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" aria-hidden="true" />
              Yangi hodim
            </Button>
          </>
        }
      />

      {/* One content row: full-width search + Filter at the end. */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Ism yoki foydalanuvchi nomi…"
            aria-label="Hodimlarni qidirish"
            className="pl-9 pr-9"
          />
          {search !== '' && (
            <button
              type="button"
              onClick={() => setSearch('')}
              aria-label="Qidiruvni tozalash"
              className="absolute right-2 top-2 rounded-md p-1 text-muted-foreground hover:bg-accent"
            >
              <X className="size-4" />
            </button>
          )}
        </div>
        <FilterPopover groups={filterGroups} value={filter} onApply={setFilter} />
      </div>

      <Card className="border-0 bg-transparent p-0 shadow-none">
        {users.isLoading && <LoadingState />}
        {!users.isLoading && users.error && (
          <ErrorState message={users.error} onRetry={users.refetch} />
        )}
        {!users.isLoading && !users.error && isEmpty && (
          <EmptyState
            message={
              allRows.length === 0
                ? 'Hodimlar topilmadi.'
                : 'Filtr yoki qidiruv bo‘yicha hodim topilmadi.'
            }
          />
        )}

        {!users.isLoading && !users.error && !isEmpty && (
          <div className="space-y-8">
            {cardGroups.map((group) => {
              const style = ROLE_ACCENT_STYLE[group.role];
              return (
                <section key={group.role} className="space-y-3">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn('size-2 shrink-0 rounded-full', style.dot)}
                      aria-hidden="true"
                    />
                    <h2 className="text-xs uppercase tracking-wide text-muted-foreground">
                      {ROLE_LABELS[group.role]}
                    </h2>
                    <Badge variant="outline" className="tabular-nums">
                      {group.items.length}
                    </Badge>
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                    {group.items.map((u) => {
                      const primary = u.location_id
                        ? (locationNameById.get(u.location_id) ??
                          `#${u.location_id}`)
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
                          className={cn(
                            'flex h-full w-full flex-col gap-3 rounded-lg border border-l-4 border-border/60 bg-card/40 p-4 text-left shadow-sm transition-colors hover:bg-card/70',
                            style.accent,
                          )}
                        >
                          {/* Clickable info region opens the bo'g'inlar dialog;
                              the footer holds the status badge so we don't nest
                              interactive content inside a button (a11y). */}
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
                              <p className="truncate text-sm font-semibold">
                                {u.name}
                              </p>
                              <p className="truncate font-mono text-xs text-muted-foreground">
                                @{u.username}
                              </p>
                            </div>
                          </button>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                              <MapPin className="size-3" aria-hidden="true" />
                              {primary}
                            </span>
                          </div>
                          <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-border/40 pt-3">
                            <TgStatusBadge linked={u.telegram_id != null} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>
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
