import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowDownLeft,
  ArrowUpRight,
  History,
  LayoutGrid,
  Plus,
  Search,
  TableProperties,
  X,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Tabs } from '@/components/ui/tabs';
import {
  FilterPopover,
  type FilterGroup,
  type FilterValue,
} from '@/components/ui/filter-popover';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { MobileCardList } from '@/components/ui/table-mobile';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from '@/components/PageState';
import {
  DateRangeFilter,
  type DateRangeValue,
} from '@/components/DateRangeFilter';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useAuth } from '@/hooks/useAuth';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { rangeBounds } from '@/lib/dateRange';
import { formatDateTime, formatQty, formatQtyUnit } from '@/lib/format';
import {
  REPLENISHMENT_STATUS_LABELS,
  REPLENISHMENT_STATUS_VARIANT,
  UNIT_OPTIONS,
} from '@/lib/labels';
import { matchesSearch } from '@/lib/translit';
import { cn } from '@/lib/utils';
import type {
  MovementsResponse,
  Product,
  ReplenishmentRequest,
  Unit,
} from '@/lib/types';
import {
  REPLENISHMENT_BUCKETS,
  statusInBucket,
  type ReplenishmentBucket,
} from './statusBuckets';
import { StoreRequestCreateDialog } from '../stores/StoreRequestCreateDialog';
import { RequestKanban } from './board/RequestKanban';
import { RequestDetailModal } from './RequestDetailModal';
import { CancelDialog } from './CancelDialog';
import { ApiError, apiRequest } from '@/lib/api-client';
import { useToast } from '@/components/ui/toast';
import type { FlowRequest } from '@/lib/replenishmentFlow';

/**
 * EPIC — replenishment workspace (owner-directed redesign).
 *
 * The flat read-only list became an organised workspace:
 *   - page tabs: "So'rovlar" | "Tranzaksiyalar";
 *   - So'rovlar: search + Sana + Bo'lim filters, a "Mening so'rovlarim"
 *     toggle, a status sub-tab strip (Hammasi · Kutib turgan · Yuborgan ·
 *     Qabul qilgan) with live per-tab counts, and a "So'rov qo'shish" create
 *     flow for RAW materials (store_manager / central_warehouse_manager);
 *   - Tranzaksiyalar: the RBAC-scoped stock-movement history.
 *
 * Filtering stays client-side over the full `GET /api/replenishment` list
 * (Faza-1 volumes are small and the endpoint is a single round-trip).
 */

type PageTab = 'requests' | 'transactions';

/** So'rovlar layout — the Jira Kanban (default) or the legacy table. */
type RequestsView = 'board' | 'table';

const PAGE_TABS: { value: PageTab; label: string }[] = [
  { value: 'requests', label: 'So‘rovlar' },
  { value: 'transactions', label: 'Tranzaksiyalar' },
];

/** Static filter dimensions — o'lchov birligi only (Holat moved to tabs). */
const UNIT_FILTER_GROUP: FilterGroup = {
  key: 'unit',
  label: 'O‘lchov birligi',
  searchable: false,
  options: UNIT_OPTIONS.map((u) => ({ value: u.value, label: u.label })),
};

const EMPTY_FILTER: FilterValue = { unit: [], department: [] };

export function ReplenishmentPage() {
  const bp = useBreakpoint();
  const showMobileCards = bp === 'xs';
  const { user, activeLocationId } = useAuth();

  const { notify } = useToast();
  const [pageTab, setPageTab] = useState<PageTab>('requests');
  const [view, setView] = useState<RequestsView>('board');
  const [filter, setFilter] = useState<FilterValue>(EMPTY_FILTER);
  const [search, setSearch] = useState('');
  const [dateRange, setDateRange] = useState<DateRangeValue>({ range: 'month' });
  const [bucket, setBucket] = useState<ReplenishmentBucket>('all');
  const [mineOnly, setMineOnly] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  // The card whose detail modal is open (Doska view), and the request queued
  // for the CancelDialog (opened from inside the modal's requester action).
  const [openRequest, setOpenRequest] = useState<FlowRequest | null>(null);
  const [cancelTarget, setCancelTarget] = useState<FlowRequest | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);

  const { data, isLoading, error, refetch } =
    useApiQuery<ReplenishmentRequest[]>('/api/replenishment');
  const allRows = useMemo(() => data ?? [], [data]);

  // Tranzaksiyalar — backend-scoped movement history (no location_id since
  // this page isn't pinned to a single bo'g'in). Fetched only when the tab is
  // active so the So'rovlar tab stays a single round-trip.
  const movements = useApiQuery<MovementsResponse>(
    pageTab === 'transactions' ? '/api/stock/movements?limit=100' : null,
  );
  const movementRows = useMemo(
    () => movements.data?.items ?? [],
    [movements.data],
  );

  // "So'rov qo'shish" gating — only the roles the backend lets create AND that
  // have an assigned location (PM is chain-wide → no own location → hidden).
  const canCreate =
    (user?.role === 'store_manager' ||
      user?.role === 'central_warehouse_manager') &&
    activeLocationId != null;

  // Raw products for the create dialog — fetched lazily, only once the dialog
  // is opened (the request is auto-created for the user's own bo'g'in).
  const rawProducts = useApiQuery<Product[]>(
    createOpen ? '/api/products?type=raw' : null,
  );

  // "Bo'lim" options = distinct requesting bo'g'inlar in the data set, so the
  // picker never lists a location the user can't actually see.
  const filterGroups = useMemo<FilterGroup[]>(() => {
    const seen = new Map<string, string>();
    for (const row of allRows) {
      seen.set(String(row.requester_location_id), row.requester_location_name);
    }
    const departmentOptions = Array.from(seen, ([value, label]) => ({
      value,
      label,
    })).sort((a, b) => a.label.localeCompare(b.label, 'uz'));
    return [
      UNIT_FILTER_GROUP,
      { key: 'department', label: 'Bo‘lim', options: departmentOptions },
    ];
  }, [allRows]);

  // Rows after every dimension EXCEPT the status bucket — the basis for both
  // the active table and the per-tab counts, so counts reflect the live
  // search / Sana / Bo'lim / Mening so'rovlarim selection.
  const baseRows = useMemo(() => {
    const units = filter.unit ?? [];
    const departments = filter.department ?? [];
    const { from, to } = rangeBounds(dateRange);
    return allRows.filter((row) => {
      if (units.length > 0 && !units.includes(row.product_unit as Unit)) {
        return false;
      }
      if (
        departments.length > 0 &&
        !departments.includes(String(row.requester_location_id))
      ) {
        return false;
      }
      if (mineOnly && row.created_by !== user?.id) return false;
      const created = new Date(row.created_at).getTime();
      if (created < from || created > to) return false;
      if (
        !matchesSearch(
          `${row.product_name} ${row.requester_location_name}`,
          search,
        )
      ) {
        return false;
      }
      return true;
    });
  }, [allRows, filter, search, dateRange, mineOnly, user?.id]);

  const bucketCounts = useMemo(() => {
    const counts: Record<ReplenishmentBucket, number> = {
      all: 0,
      kutuvda: 0,
      soralgan: 0,
      qabul_qilingan: 0,
      yuborilgan: 0,
      yopilgan: 0,
    };
    for (const row of baseRows) {
      for (const b of REPLENISHMENT_BUCKETS) {
        if (statusInBucket(row, b.value)) counts[b.value] += 1;
      }
    }
    return counts;
  }, [baseRows]);

  const rows = useMemo(
    () => baseRows.filter((row) => statusInBucket(row, bucket)),
    [baseRows, bucket],
  );

  const bucketOptions = REPLENISHMENT_BUCKETS.map((b) => ({
    value: b.value,
    label: `${b.label} (${bucketCounts[b.value]})`,
  }));

  // Cancel from inside the detail modal (requester action) → CancelDialog.
  async function handleCancelConfirm(reason: string | undefined): Promise<void> {
    if (cancelTarget === null) return;
    setIsCancelling(true);
    try {
      await apiRequest(`/api/replenishment/${cancelTarget.id}/cancel`, {
        method: 'POST',
        body: { reason },
      });
      notify('success', 'So‘rov bekor qilindi.');
      setCancelTarget(null);
      refetch();
    } catch (err: unknown) {
      notify(
        'error',
        err instanceof ApiError ? err.message : 'Bekor qilib bo‘lmadi.',
      );
    } finally {
      setIsCancelling(false);
    }
  }

  return (
    <div className="mx-auto max-w-[120rem] space-y-6">
      <PageHeader
        title="To‘ldirish so‘rovlari"
        description="Avtomatik to‘ldirish tsikli, so‘rovlar holati va tranzaksiyalar."
      />

      <Tabs
        value={pageTab}
        onValueChange={setPageTab}
        options={PAGE_TABS}
        ariaLabel="Bo‘lim"
      />

      {pageTab === 'requests' && (
        <>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <div className="relative flex-1 lg:max-w-md">
              <Search
                className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Qidirish (lotin yoki kirill)…"
                aria-label="So‘rov qidirish"
                className="pl-9 pr-9"
              />
              {search !== '' && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => setSearch('')}
                  aria-label="Qidiruvni tozalash"
                  className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2 text-muted-foreground"
                >
                  <X className="size-4" aria-hidden="true" />
                </Button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <DateRangeFilter value={dateRange} onChange={setDateRange} />
              <FilterPopover
                groups={filterGroups}
                value={filter}
                onApply={setFilter}
              />
              {user?.id != null && (
                <Button
                  type="button"
                  variant={mineOnly ? 'default' : 'outline'}
                  size="sm"
                  aria-pressed={mineOnly}
                  onClick={() => setMineOnly((v) => !v)}
                >
                  Mening so‘rovlarim
                </Button>
              )}
              {canCreate && (
                <Button
                  type="button"
                  size="sm"
                  className="lg:ml-auto"
                  onClick={() => setCreateOpen(true)}
                >
                  <Plus className="size-4" aria-hidden="true" />
                  So‘rov qo‘shish
                </Button>
              )}
              {/* Doska | Jadval view toggle (Doska default). */}
              <div
                className="flex overflow-hidden rounded-lg border border-border/70"
                role="group"
                aria-label="Ko‘rinish"
              >
                <Button
                  type="button"
                  variant={view === 'board' ? 'default' : 'ghost'}
                  size="sm"
                  aria-pressed={view === 'board'}
                  className="rounded-none"
                  onClick={() => setView('board')}
                >
                  <LayoutGrid className="size-4" aria-hidden="true" />
                  Doska
                </Button>
                <Button
                  type="button"
                  variant={view === 'table' ? 'default' : 'ghost'}
                  size="sm"
                  aria-pressed={view === 'table'}
                  className="rounded-none"
                  onClick={() => setView('table')}
                >
                  <TableProperties className="size-4" aria-hidden="true" />
                  Jadval
                </Button>
              </div>
            </div>
          </div>

          {/* The bucket strip is a TABLE-mode affordance; in Doska mode the
              column counts replace it. */}
          {view === 'table' && (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <Tabs
                value={bucket}
                onValueChange={setBucket}
                options={bucketOptions}
                ariaLabel="So‘rov holati"
              />
              <p className="text-sm text-muted-foreground" aria-live="polite">
                {`${rows.length} ta so‘rov`}
              </p>
            </div>
          )}

          {/* DOSKA — the Jira Kanban fed by the SAME filtered (search / date /
              filter / Mening so'rovlarim) rows; a card click opens the modal. */}
          {view === 'board' &&
            (isLoading ? (
              <Card>
                <LoadingState />
              </Card>
            ) : error ? (
              <Card>
                <ErrorState message={error} onRetry={refetch} />
              </Card>
            ) : baseRows.length === 0 ? (
              <Card>
                <EmptyState message="So‘rovlar topilmadi." />
              </Card>
            ) : (
              <RequestKanban
                requests={baseRows as FlowRequest[]}
                emptyLabel="—"
                onOpen={(req) => setOpenRequest(req)}
              />
            ))}

          {view === 'table' && (
          <Card>
            {isLoading && <LoadingState />}
            {!isLoading && error && (
              <ErrorState message={error} onRetry={refetch} />
            )}
            {!isLoading && !error && rows.length === 0 && (
              <EmptyState message="So‘rovlar topilmadi." />
            )}
            {!isLoading && !error && rows.length > 0 && showMobileCards && (
              <MobileCardList
                items={rows.map((row) => ({
                  id: row.id,
                  title: `#${row.id} · ${row.product_name}`,
                  subtitle: row.requester_location_name,
                  badge: (
                    <Badge variant={REPLENISHMENT_STATUS_VARIANT[row.status]}>
                      {REPLENISHMENT_STATUS_LABELS[row.status]}
                    </Badge>
                  ),
                  fields: [
                    {
                      label: 'Miqdor',
                      value: `${formatQty(row.qty_needed)} ${row.product_unit}`,
                    },
                    {
                      label: 'Yaratilgan',
                      value: formatDateTime(row.created_at),
                    },
                  ],
                  footer: (
                    <Button
                      variant="outline"
                      size="sm"
                      asChild
                      className="w-full"
                    >
                      <Link to={`/replenishment/${row.id}`}>Ochish</Link>
                    </Button>
                  ),
                }))}
              />
            )}
            {!isLoading && !error && rows.length > 0 && !showMobileCards && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>#</TableHead>
                    <TableHead>Mahsulot</TableHead>
                    <TableHead className="text-right">Miqdor</TableHead>
                    <TableHead>So‘rovchi bo‘g‘in</TableHead>
                    <TableHead>Holat</TableHead>
                    <TableHead>Yaratilgan</TableHead>
                    <TableHead className="text-right">Amal</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="text-muted-foreground">
                        #{row.id}
                      </TableCell>
                      <TableCell className="font-medium">
                        {row.product_name}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatQty(row.qty_needed)} {row.product_unit}
                      </TableCell>
                      <TableCell>{row.requester_location_name}</TableCell>
                      <TableCell>
                        <Badge variant={REPLENISHMENT_STATUS_VARIANT[row.status]}>
                          {REPLENISHMENT_STATUS_LABELS[row.status]}
                        </Badge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {formatDateTime(row.created_at)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button variant="outline" size="sm" asChild>
                          <Link to={`/replenishment/${row.id}`}>Ochish</Link>
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>
          )}
        </>
      )}

      {pageTab === 'transactions' && (
        <Card>
          {movements.isLoading && <LoadingState />}
          {!movements.isLoading && movements.error && (
            <ErrorState
              message={movements.error}
              onRetry={movements.refetch}
            />
          )}
          {!movements.isLoading &&
            !movements.error &&
            movementRows.length === 0 && (
              <EmptyState message="Hali harakat yo‘q." />
            )}
          {!movements.isLoading &&
            !movements.error &&
            movementRows.length > 0 && (
              <div className="scrollbar-thin overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Sana</TableHead>
                      <TableHead>Mahsulot</TableHead>
                      <TableHead className="text-right">Miqdor</TableHead>
                      <TableHead>Manba</TableHead>
                      <TableHead>Manzil</TableHead>
                      <TableHead className="text-right">Yaroqsiz</TableHead>
                      {activeLocationId != null && <TableHead>Harakat</TableHead>}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {movementRows.map((m) => {
                      const hasBrak = m.brak_qty != null && m.brak_qty > 0;
                      // Direction is relative to the viewer's own location
                      // (owner: show the same "Qabul qildi / Chiqardi" action
                      // as the store transactions). PM has no own location, so
                      // the Harakat column is hidden and the Manba → Manzil
                      // columns convey direction instead.
                      const direction =
                        activeLocationId == null
                          ? null
                          : m.to_location_id === activeLocationId
                            ? 'in'
                            : m.from_location_id === activeLocationId
                              ? 'out'
                              : null;
                      return (
                        <TableRow key={m.id}>
                          <TableCell className="whitespace-nowrap text-muted-foreground">
                            {formatDateTime(m.created_at)}
                          </TableCell>
                          <TableCell className="font-medium">
                            {m.product_name}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatQtyUnit(m.qty, m.product_unit)}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {m.from_location_name ?? '—'}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {m.to_location_name ?? '—'}
                          </TableCell>
                          <TableCell
                            className={cn(
                              'text-right tabular-nums',
                              hasBrak
                                ? 'font-medium text-destructive'
                                : 'text-muted-foreground',
                            )}
                          >
                            {hasBrak
                              ? formatQtyUnit(m.brak_qty as number, m.product_unit)
                              : '—'}
                          </TableCell>
                          {activeLocationId != null && (
                            <TableCell>
                              {direction === 'in' ? (
                                <Badge variant="success" className="gap-1">
                                  <ArrowDownLeft
                                    className="size-3"
                                    aria-hidden="true"
                                  />
                                  Qabul qildi
                                </Badge>
                              ) : direction === 'out' ? (
                                <Badge variant="warning" className="gap-1">
                                  <ArrowUpRight
                                    className="size-3"
                                    aria-hidden="true"
                                  />
                                  Chiqardi
                                </Badge>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </TableCell>
                          )}
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          {!movements.isLoading &&
            !movements.error &&
            movementRows.length > 0 && (
              <p className="flex items-center gap-2 border-t border-border/60 px-5 py-3 text-xs text-muted-foreground">
                <History className="size-3.5" aria-hidden="true" />
                Ombor harakatlari (manba → manzil) — eng yangisi yuqorida.
              </p>
            )}
        </Card>
      )}

      {canCreate && activeLocationId != null && (
        <StoreRequestCreateDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          products={rawProducts.data ?? []}
          storeLocationId={activeLocationId}
          onSaved={refetch}
        />
      )}

      {/* The Jira card — opened on a Doska card click. Its requester action
          opens the CancelDialog below; accept/reject refetch the list. */}
      <RequestDetailModal
        open={openRequest !== null}
        onOpenChange={(next) => {
          if (!next) setOpenRequest(null);
        }}
        request={openRequest}
        onActed={refetch}
        onCancel={(req) => setCancelTarget(req)}
      />

      <CancelDialog
        open={cancelTarget !== null}
        onOpenChange={(next) => {
          if (!isCancelling && !next) setCancelTarget(null);
        }}
        onConfirm={handleCancelConfirm}
        isSubmitting={isCancelling}
      />
    </div>
  );
}
