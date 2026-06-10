import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus,
  Pencil,
  Boxes,
  Factory,
  PackageOpen,
  Warehouse,
  Store,
  MapPin,
  Waypoints,
  Search,
  X,
  Archive,
  ArchiveRestore,
  Trash2,
  Loader2,
} from 'lucide-react';
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
import { useToast } from '@/components/ui/toast';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useAuth } from '@/hooks/useAuth';
import { apiRequest, ApiError } from '@/lib/api-client';
import { LOCATION_TYPE_LABELS } from '@/lib/labels';
import { matchesSearch } from '@/lib/translit';
import { cn } from '@/lib/utils';
import type { Location, LocationType, User } from '@/lib/types';
import { LocationFormDialog } from './LocationFormDialog';

/**
 * The responsible person for a location, resolved by {@link useEffectiveManager}.
 * `inherited` is `true` when the manager was taken from the parent
 * production-sex (the warehouse has no manager of its own — the owner's rule:
 * a production warehouse's responsible person is its parent sex's boshliq).
 */
interface EffectiveManager {
  user: User;
  inherited: boolean;
}

/** A location is archived when the backend flips `is_active` to `false`. */
function isArchived(location: Location): boolean {
  return location.is_active === false;
}

const LOCATION_TYPE_ICON: Record<LocationType, typeof MapPin> = {
  raw_warehouse: Boxes,
  production: Factory,
  supply: PackageOpen,
  sex_storage: PackageOpen,
  central_warehouse: Warehouse,
  store: Store,
};

/**
 * Canonical chain types in chain order (raw → production → sex_storage →
 * central → store). The legacy `supply` enum collapses into `sex_storage`
 * everywhere — both share the same visual stage (see ChainLayerLayout).
 */
type CanonicalType =
  | 'raw_warehouse'
  | 'production'
  | 'sex_storage'
  | 'central_warehouse'
  | 'store';

const CANONICAL_ORDER: CanonicalType[] = [
  'raw_warehouse',
  'production',
  'sex_storage',
  'central_warehouse',
  'store',
];

/** Map any location type (incl. legacy `supply`) to its canonical bucket. */
function canonicalType(type: LocationType): CanonicalType {
  return type === 'supply' ? 'sex_storage' : (type as CanonicalType);
}

type TypeTab = 'all' | CanonicalType;

/** sessionStorage key — remembers the active type tab across navigation. */
const TYPE_TAB_KEY = 'locations.typeTab';

/** sessionStorage key — remembers the "show archived" toggle across navigation. */
const SHOW_ARCHIVED_KEY = 'locations.showArchived';

/**
 * Per-type colour accent — sourced from the semantic chain tokens
 * (`--chain-*` in index.css) so light/dark themes inherit automatically.
 * `border` drives the card left-border; `iconWrap` tints the card icon chip.
 */
const TYPE_ACCENT: Record<CanonicalType, { border: string; iconWrap: string }> = {
  raw_warehouse: {
    border: 'border-l-chain-raw/60',
    iconWrap: 'bg-chain-raw-tint text-chain-raw',
  },
  production: {
    border: 'border-l-chain-production/60',
    iconWrap: 'bg-chain-production-tint text-chain-production',
  },
  sex_storage: {
    border: 'border-l-chain-supply/60',
    iconWrap: 'bg-chain-supply-tint text-chain-supply',
  },
  central_warehouse: {
    border: 'border-l-chain-central/60',
    iconWrap: 'bg-chain-central-tint text-chain-central',
  },
  store: {
    border: 'border-l-chain-store/60',
    iconWrap: 'bg-chain-store-tint text-chain-store',
  },
};

const TYPE_TABS: { value: TypeTab; label: string }[] = [
  { value: 'all', label: 'Hammasi' },
  ...CANONICAL_ORDER.map((t) => ({
    value: t,
    label: LOCATION_TYPE_LABELS[t],
  })),
];

/**
 * Resolve the responsible person ("Boshliq") for a location:
 *   1. the location's own `manager_user_id`, else
 *   2. the parent location's `manager_user_id` (inheritance — a production
 *      warehouse takes its parent sex's boshliq), else
 *   3. none.
 *
 * `usersById` may be empty while the users list is still loading; in that
 * case we return `null` so the UI falls back to "—" (never a raw `#id`).
 * `locationsById` MUST be built from the FULL (unfiltered) locations list so
 * the parent lookup works even when the parent sits on another tab.
 */
function resolveEffectiveManager(
  location: Location,
  usersById: Map<number, User>,
  locationsById: Map<number, Location>,
): EffectiveManager | null {
  if (location.manager_user_id != null) {
    const user = usersById.get(location.manager_user_id);
    return user ? { user, inherited: false } : null;
  }
  if (location.parent_id != null) {
    const parent = locationsById.get(location.parent_id);
    if (parent?.manager_user_id != null) {
      const user = usersById.get(parent.manager_user_id);
      return user ? { user, inherited: true } : null;
    }
  }
  return null;
}

/**
 * Renders the resolved "Boshliq" — the manager's name, with a subtle muted
 * "(sex boshlig‘i)" suffix when the manager is inherited from the parent
 * production-sex. Falls back to "—" when there is no effective manager.
 */
function ManagerValue({ manager }: { manager: EffectiveManager | null }) {
  if (!manager) return <>—</>;
  return (
    <span className="flex min-w-0 items-baseline gap-1">
      <span className="truncate" title={manager.user.name}>
        {manager.user.name}
      </span>
      {manager.inherited && (
        <span
          className="shrink-0 text-[0.6875rem] text-muted-foreground"
          title="Bo‘g‘inning o‘z boshlig‘i yo‘q — sex boshlig‘i mas’ul"
        >
          (sex)
        </span>
      )}
    </span>
  );
}

/**
 * M1 — chain locations list. `pm` may create/edit; other roles see a
 * read-only list scoped to their own location by the backend (§6).
 *
 * Redesigned to mirror ProductsPage: a TYPE segmented tab row (left) +
 * translit-aware search box (right) in one content row, then the cards
 * grouped into colour-coded sections by canonical chain type. The "Oqimlar"
 * action now navigates to the dedicated /locations/flows page.
 */
export function LocationsPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { notify } = useToast();
  const isPm = user?.role === 'pm';

  const { data, isLoading, error, refetch } =
    useApiQuery<Location[]>('/api/locations');

  // Users power the "Boshliq" field — we resolve `manager_user_id` to a name
  // (and inherit the parent sex's manager for production warehouses). Failure
  // to load is non-fatal: the field falls back to "—" rather than a raw id.
  const { data: usersData } = useApiQuery<User[]>('/api/users');

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Location | null>(null);
  const [search, setSearch] = useState('');
  // Persist the active tab so returning from another page restores it.
  const [typeTab, setTypeTab] = useState<TypeTab>(() => {
    try {
      const v = sessionStorage.getItem(TYPE_TAB_KEY);
      if (
        v === 'all' ||
        v === 'raw_warehouse' ||
        v === 'production' ||
        v === 'sex_storage' ||
        v === 'central_warehouse' ||
        v === 'store'
      ) {
        return v;
      }
    } catch {
      // ignore — private mode / unavailable storage
    }
    return 'all';
  });
  useEffect(() => {
    try {
      sessionStorage.setItem(TYPE_TAB_KEY, typeTab);
    } catch {
      // best-effort
    }
  }, [typeTab]);

  // Reveal-archived toggle — OFF by default (archived hidden entirely).
  const [showArchived, setShowArchived] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem(SHOW_ARCHIVED_KEY) === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      sessionStorage.setItem(SHOW_ARCHIVED_KEY, showArchived ? '1' : '0');
    } catch {
      // best-effort
    }
  }, [showArchived]);

  // id of the location whose archive/unarchive PATCH is in flight.
  const [archivingId, setArchivingId] = useState<number | null>(null);

  // id of the location whose hard-delete DELETE is in flight.
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const allLocations = useMemo(() => data ?? [], [data]);

  // id → user. Empty until the users list resolves; consumers fall back to "—".
  const usersById = useMemo(() => {
    const m = new Map<number, User>();
    for (const u of usersData ?? []) m.set(u.id, u);
    return m;
  }, [usersData]);

  // id → location over the FULL list so parent lookups (for inherited
  // managers) succeed regardless of the active tab / search / archive filter.
  const locationsById = useMemo(() => {
    const m = new Map<number, Location>();
    for (const l of allLocations) m.set(l.id, l);
    return m;
  }, [allLocations]);

  const managerFor = useMemo(
    () => (location: Location) =>
      resolveEffectiveManager(location, usersById, locationsById),
    [usersById, locationsById],
  );

  // Visible set: active-only unless the reveal toggle is ON. All counts,
  // grouping and both views derive from this so badges stay active-only.
  const locations = useMemo(
    () =>
      showArchived ? allLocations : allLocations.filter((l) => !isArchived(l)),
    [allLocations, showArchived],
  );

  // Whether any archived location exists at all (gates the reveal toggle).
  const hasArchived = useMemo(
    () => allLocations.some(isArchived),
    [allLocations],
  );

  async function handleToggleArchive(location: Location) {
    const archiving = !isArchived(location);
    if (archiving) {
      const ok = window.confirm(
        `“${location.name}” bo‘g‘ini arxivlanadi. Davom etilsinmi?`,
      );
      if (!ok) return;
    }
    setArchivingId(location.id);
    try {
      await apiRequest(`/api/locations/${location.id}`, {
        method: 'PATCH',
        body: { is_active: !archiving },
      });
      notify(
        'success',
        archiving ? 'Bo‘g‘in arxivlandi.' : 'Bo‘g‘in arxivdan chiqarildi.',
      );
      refetch();
    } catch (err: unknown) {
      notify(
        'error',
        err instanceof ApiError ? err.message : 'Amalni bajarishda xatolik.',
      );
    } finally {
      setArchivingId(null);
    }
  }

  /**
   * Hard-delete a location via DELETE /api/locations/:id (pm only). The backend
   * guards the operation: if the location has dependents (child locations,
   * assigned users, stock, sales, requests) it returns a 4xx (409/422) with a
   * human-readable message — we surface that text and steer the owner toward
   * the archive action instead. A clean location is removed and the list
   * refetched.
   */
  async function handleDelete(location: Location) {
    const ok = window.confirm(
      `“${location.name}” bo‘g‘ini butunlay o‘chiriladi. Bu amalni ortga qaytarib bo‘lmaydi. Davom etilsinmi?`,
    );
    if (!ok) return;
    setDeletingId(location.id);
    try {
      await apiRequest(`/api/locations/${location.id}`, { method: 'DELETE' });
      notify('success', 'Bo‘g‘in o‘chirildi.');
      refetch();
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
        // Guard rejection (e.g. has dependents) — show the backend's message
        // and suggest archiving instead.
        notify(
          'error',
          `${err.message} Buning o‘rniga bo‘g‘inni arxivlashingiz mumkin.`,
        );
      } else {
        notify(
          'error',
          err instanceof ApiError ? err.message : 'Bo‘g‘inni o‘chirishda xatolik.',
        );
      }
    } finally {
      setDeletingId(null);
    }
  }

  // Per-tab counts for the segmented control badges (whole list, pre-search).
  const typeCounts = useMemo(() => {
    const c: Record<TypeTab, number> = {
      all: locations.length,
      raw_warehouse: 0,
      production: 0,
      sex_storage: 0,
      central_warehouse: 0,
      store: 0,
    };
    for (const l of locations) c[canonicalType(l.type)] += 1;
    return c;
  }, [locations]);

  // Tab + translit search filter.
  const filtered = useMemo(() => {
    return locations.filter((l) => {
      if (typeTab !== 'all' && canonicalType(l.type) !== typeTab) return false;
      if (!matchesSearch(l.name, search)) return false;
      return true;
    });
  }, [locations, typeTab, search]);

  // Group the filtered list into sections by canonical type, in chain order.
  const groups = useMemo(() => {
    const buckets = new Map<CanonicalType, Location[]>();
    for (const l of filtered) {
      const key = canonicalType(l.type);
      const bucket = buckets.get(key);
      if (bucket) bucket.push(l);
      else buckets.set(key, [l]);
    }
    return CANONICAL_ORDER.flatMap((type) => {
      const items = buckets.get(type);
      return items && items.length > 0 ? [{ type, items }] : [];
    });
  }, [filtered]);

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
        actions={
          <>
            {isPm && (
              <Button
                variant="outline"
                onClick={() => navigate('/locations/flows')}
              >
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
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <div
          role="tablist"
          aria-label="Bo‘g‘in turi"
          className="inline-flex flex-wrap items-center gap-1 rounded-xl border border-border/70 bg-surface-1 p-1"
        >
          {TYPE_TABS.map((t) => {
            const active = typeTab === t.value;
            return (
              <button
                key={t.value}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTypeTab(t.value)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active
                    ? 'bg-primary/15 text-primary ring-1 ring-inset ring-primary/25'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                )}
              >
                {t.label}
                <span
                  className={cn(
                    'tabular-nums',
                    active ? 'text-primary/70' : 'text-muted-foreground/70',
                  )}
                >
                  · {typeCounts[t.value]}
                </span>
              </button>
            );
          })}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {hasArchived && (
            <Button
              type="button"
              variant={showArchived ? 'default' : 'outline'}
              size="sm"
              aria-pressed={showArchived}
              onClick={() => setShowArchived((v) => !v)}
            >
              <Archive className="size-4" aria-hidden="true" />
              Arxivlanganlar
            </Button>
          )}

          <div className="relative w-full sm:w-72">
            <Search
              className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Qidirish (lotin yoki kirill)…"
              aria-label="Bo‘g‘in qidirish"
              className="pl-9 pr-9"
            />
            {search !== '' && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => setSearch('')}
                aria-label="Qidiruvni tozalash"
                className="absolute right-1 top-1 size-7 text-muted-foreground"
              >
                <X className="size-4" />
              </Button>
            )}
          </div>

          <span className="text-sm tabular-nums text-muted-foreground">
            {filtered.length} ta bo‘g‘in
          </span>
        </div>
      </div>

      <div>
        {isLoading && <LoadingState />}
        {!isLoading && error && <ErrorState message={error} onRetry={refetch} />}
        {!isLoading && !error && filtered.length === 0 && (
          <EmptyState message="Bo‘g‘inlar topilmadi." />
        )}

        {!isLoading && !error && filtered.length > 0 && (
          <div className="space-y-6">
            {groups.map((group) => {
              const accent = TYPE_ACCENT[group.type];
              return (
                <section key={group.type} className="space-y-3">
                  <div className="flex items-center gap-2">
                    <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      {LOCATION_TYPE_LABELS[group.type]}
                    </h2>
                    <Badge variant="secondary" className="tabular-nums">
                      {group.items.length}
                    </Badge>
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                    {group.items.map((location) => {
                      const Icon =
                        LOCATION_TYPE_ICON[location.type] ?? MapPin;
                      const archived = isArchived(location);
                      const busy = archivingId === location.id;
                      const deleting = deletingId === location.id;
                      return (
                        <Card
                          key={location.id}
                          className={cn(
                            'flex flex-col gap-3 border-l-4 p-4',
                            accent.border,
                            archived && 'opacity-60',
                          )}
                        >
                          <div className="flex items-start gap-3">
                            <div
                              className={cn(
                                'flex size-10 shrink-0 items-center justify-center rounded-lg',
                                accent.iconWrap,
                              )}
                            >
                              <Icon className="size-5" aria-hidden="true" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-semibold">
                                {location.name}
                              </p>
                              {archived && (
                                <div className="mt-1">
                                  <Badge
                                    variant="outline"
                                    className="border-muted-foreground/30 text-muted-foreground"
                                  >
                                    Arxivlangan
                                  </Badge>
                                </div>
                              )}
                            </div>
                            {isPm && (
                              <div className="flex shrink-0 items-center gap-0.5">
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  disabled={deleting}
                                  onClick={() => openEdit(location)}
                                  aria-label={`${location.name} ni tahrirlash`}
                                  title="Tahrirlash"
                                >
                                  <Pencil className="size-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  disabled={busy || deleting}
                                  onClick={() => handleToggleArchive(location)}
                                  aria-label={
                                    archived
                                      ? `${location.name} ni arxivdan chiqarish`
                                      : `${location.name} ni arxivlash`
                                  }
                                  title={
                                    archived ? 'Arxivdan chiqarish' : 'Arxivlash'
                                  }
                                >
                                  {busy ? (
                                    <Loader2 className="size-4 animate-spin" />
                                  ) : archived ? (
                                    <ArchiveRestore className="size-4" />
                                  ) : (
                                    <Archive className="size-4" />
                                  )}
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  disabled={busy || deleting}
                                  onClick={() => handleDelete(location)}
                                  aria-label={`${location.name} ni o‘chirish`}
                                  title="O‘chirish"
                                  className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                >
                                  {deleting ? (
                                    <Loader2 className="size-4 animate-spin" />
                                  ) : (
                                    <Trash2 className="size-4" />
                                  )}
                                </Button>
                              </div>
                            )}
                          </div>
                          <dl className="grid grid-cols-2 gap-2 text-xs">
                            <div>
                              <dt className="text-muted-foreground">
                                Yetkazish
                              </dt>
                              <dd>
                                {location.lead_time_days
                                  ? `${location.lead_time_days} kun`
                                  : '—'}
                              </dd>
                            </div>
                            <div>
                              <dt className="text-muted-foreground">Boshliq</dt>
                              <dd className="min-w-0">
                                <ManagerValue manager={managerFor(location)} />
                              </dd>
                            </div>
                          </dl>
                        </Card>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>

      {isPm && (
        <LocationFormDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          location={editing}
          allLocations={allLocations}
          onSaved={refetch}
        />
      )}
    </div>
  );
}
