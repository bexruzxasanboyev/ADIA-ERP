import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Plus,
  CheckCircle2,
  Circle,
  AlertTriangle,
  ChevronDown,
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
import {
  FilterPopover,
  type FilterGroup,
  type FilterValue,
} from '@/components/ui/filter-popover';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useCanAct } from '@/hooks/useCanAct';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/utils';
import { formatDateTime, formatQty } from '@/lib/format';
import {
  PURCHASE_ORDER_STATUS_LABELS,
  PURCHASE_ORDER_STATUS_OPTIONS,
  PURCHASE_ORDER_STATUS_VARIANT,
} from '@/lib/labels';
import type {
  Location,
  Product,
  PurchaseOrder,
  PurchaseOrderStatus,
} from '@/lib/types';
import {
  PurchaseOrderFormDialog,
  type PurchaseOrderFormInitialValues,
} from './PurchaseOrderFormDialog';
import { AdminPurchaseOrderFormDialog } from './AdminPurchaseOrderFormDialog';
import { ApprovalPanel } from './ApprovalPanel';
import { PurchaseSignalsSection } from './PurchaseSignalsSection';
import { BoardWorkspace } from '@/pages/replenishment/board/BoardWorkspace';
import { RequestDetailModal } from '@/pages/replenishment/RequestDetailModal';
import { splitBoards } from '@/pages/replenishment/board/boardFilters';
import { RawWorkInbox } from './RawWorkInbox';
import type { FlowRequest } from '@/lib/replenishmentFlow';
import type { ReplenishmentRequest } from '@/lib/types';
import type { PurchaseSignal } from '@/lib/replenishmentFlow';

/**
 * EPIC 6.1 — at-a-glance two-step approval indicator.
 *
 * The full admin→skladchi flow lives in `ApprovalPanel` (inside the
 * expanded row), but the owner asked for the two-step state to be
 * visible on the list itself: who has signed (boshliq) and whether the
 * skladchi has signed. We render two compact pills mirroring the panel's
 * StepCard icons so a manager can scan the queue without expanding.
 */
function ApprovalSteps({ order }: { order: PurchaseOrder }) {
  const managerSigned = order.manager_approved_by !== null;
  const keeperSigned = order.keeper_approved_by !== null;
  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      aria-label="Ikki bosqichli tasdiq holati"
    >
      <StepPill label="Boshliq" signed={managerSigned} />
      <span aria-hidden="true" className="text-muted-foreground/50">
        →
      </span>
      <StepPill label="Skladchi" signed={keeperSigned} />
    </div>
  );
}

function StepPill({ label, signed }: { label: string; signed: boolean }) {
  const Icon = signed ? CheckCircle2 : Circle;
  return (
    <Badge
      variant={signed ? 'success' : 'outline'}
      className={cn('px-2 text-[11px] font-normal', !signed && 'text-muted-foreground')}
    >
      <Icon className="size-3" aria-hidden="true" />
      {label}
      <span className="sr-only">
        {signed ? ' tasdiqladi' : ' hali tasdiqlamagan'}
      </span>
    </Badge>
  );
}

/**
 * M6 — purchase orders list (sotib olish so‘rovlari).
 * `GET /api/purchase-orders?status=` returns a bare `PurchaseOrder[]`.
 *
 * The two-step approval (D5) is exposed via `ApprovalPanel` — each row
 * expands inline so the manager and the warehouse keeper can sign off
 * independently. Receive / reject also live in that panel.
 */
export function PurchaseOrdersPage() {
  const { isReadOnly, isOperator } = useCanAct();
  const { user } = useAuth();
  // "Yangi sotib olish" — Stage 1 (commit da5aebe) restricts POST
  // /api/purchase-orders to supply_manager (writers only; PM is now
  // read-only). The form dialog enforces per-row scoping via the target
  // location <select>; the backend's requireLocationOperator does the
  // final check, and a 403 surfaces as a toast inside the dialog.
  const canCreate = isOperator;
  // EPIC 6.1e — the PM (admin) is otherwise read-only, but may *initiate*
  // a purchase order routed to the skladchi via POST
  // /api/purchase-orders/admin (authorize('pm')). This is the only write
  // the PM performs on this page, so it gets its own dialog + button.
  const isPm = user?.role === 'pm';

  // F-S (owner: "ishlab chiqarish mahsulot so'ragan edi — shular chiqmayapti")
  // — the raw warehouse is a chain link like every other: the requests the
  // sexes route AT it (F-G: pinned raw target, manager accepts, then adds the
  // Поставка in Poster) must live on the SAME unified board here. The PO
  // table below stays the purchase/approval surface; this board is the
  // incoming-request surface.
  const { locations: myLocations } = useAuth();
  const rawScope = useMemo(() => {
    const ids = new Set<number>();
    for (const loc of myLocations) {
      if (loc.type === 'raw_warehouse') ids.add(loc.id);
    }
    return ids;
  }, [myLocations]);
  const replen = useApiQuery<ReplenishmentRequest[]>(
    rawScope.size > 0 ? '/api/replenishment' : null,
  );
  const rawBoards = useMemo(
    () => splitBoards((replen.data ?? []) as FlowRequest[], rawScope),
    [replen.data, rawScope],
  );
  const [openRequest, setOpenRequest] = useState<FlowRequest | null>(null);

  // EPIC 6.2 — status is now one dimension inside the shared
  // FilterPopover (held as a string[] keyed by 'status'). We still send a
  // single `?status=` to the backend when exactly one is picked; multiple
  // selections fall back to client-side filtering so the API contract
  // stays unchanged.
  const [filter, setFilter] = useState<FilterValue>({});
  const [dialogOpen, setDialogOpen] = useState(false);
  const [adminDialogOpen, setAdminDialogOpen] = useState(false);
  // F-V — the raw keeper's DEFAULT is the «Ishlarim» feed; the board + signals +
  // PO table live behind a «Batafsil» disclosure (research Rule 12). A non-raw
  // role (supply_manager / PM) has no inbox, so for them the detail is always on.
  const isRawKeeper = rawScope.size > 0;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const showDetails = !isRawKeeper || detailsOpen;
  const [expandedId, setExpandedId] = useState<number | null>(null);
  // F-F — seed values for the create-PO dialog when it is opened from a
  // "Xarid signallari" card (prefill product / suggested qty / raw location).
  // `undefined` for the plain "Yangi sotib olish" button → blank form.
  const [signalSeed, setSignalSeed] = useState<
    PurchaseOrderFormInitialValues | undefined
  >(undefined);

  // F-F — an open-PO chip on a signal links to `?focus=<id>`. We honour that
  // by expanding + scrolling to the matching row (the page has no standalone
  // PO detail route — rows expand inline via `ApprovalPanel`).
  const [searchParams, setSearchParams] = useSearchParams();
  const rowRefs = useRef(new Map<number, HTMLTableRowElement>());

  const selectedStatuses = useMemo(
    () => (filter['status'] ?? []) as PurchaseOrderStatus[],
    [filter],
  );
  const path =
    selectedStatuses.length === 1
      ? `/api/purchase-orders?status=${selectedStatuses[0]}`
      : '/api/purchase-orders';
  const { data, isLoading, error, refetch } =
    useApiQuery<PurchaseOrder[]>(path);

  const filterGroups = useMemo<FilterGroup[]>(
    () => [
      {
        key: 'status',
        label: 'Holat',
        options: PURCHASE_ORDER_STATUS_OPTIONS,
      },
    ],
    [],
  );

  // The table reads `product_name`, `product_unit`, `target_location_name`,
  // `manager_approved_name`, `keeper_approved_name`, `supplier_name` directly
  // from the embedded row — no client-side join. Products + locations are
  // only needed by the create dialogs (supply-manager + admin/PM), so fetch
  // them lazily for those roles.
  const canOpenDialog = canCreate || isPm;
  const products = useApiQuery<Product[]>(canOpenDialog ? '/api/products' : null);
  const locations = useApiQuery<Location[]>(
    canOpenDialog ? '/api/locations' : null,
  );

  // When the backend already scoped by a single status the extra filter
  // is a no-op; for a multi-status selection we narrow client-side.
  const rows = useMemo(() => {
    const all = data ?? [];
    if (selectedStatuses.length <= 1) return all;
    const set = new Set<PurchaseOrderStatus>(selectedStatuses);
    return all.filter((r) => set.has(r.status));
  }, [data, selectedStatuses]);

  // Open the EXISTING create-PO dialog prefilled from a signal. Only a writer
  // (supply_manager) reaches this — the section passes `null` otherwise.
  const handleCreatePoFromSignal = useCallback((signal: PurchaseSignal) => {
    setSignalSeed({
      product_id: signal.product_id,
      qty: signal.suggested_qty,
      target_location_id: signal.location_id,
      note: `Xarid signali: ${signal.name} — ostatka ${signal.qty} ${signal.unit}, min ${signal.min_level} ${signal.unit}`,
    });
    setDialogOpen(true);
  }, []);

  // Honour `?focus=<po-id>` from an open-PO signal chip: expand that row and
  // scroll it into view once it is present in the list, then strip the param
  // so a later manual collapse isn't fought by the URL.
  const focusId = searchParams.get('focus');
  useEffect(() => {
    if (focusId === null) return;
    const id = Number(focusId);
    if (!Number.isInteger(id) || id <= 0) return;
    if (!rows.some((r) => r.id === id)) return; // not loaded / not in scope yet
    setExpandedId(id);
    rowRefs.current
      .get(id)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const next = new URLSearchParams(searchParams);
    next.delete('focus');
    setSearchParams(next, { replace: true });
  }, [focusId, rows, searchParams, setSearchParams]);

  return (
    <div className="mx-auto max-w-[120rem] space-y-6">
      <PageHeader
        title="Sotib olish so‘rovlari"
        description="Admin buyurtma qiladi → skladchi qabul qiladi; ikki bosqichli tasdiq (boshliq + skladchi)."
        actions={
          <>
            {isReadOnly && !isPm && (
              <Badge variant="secondary" className="h-10 items-center px-3" aria-label="Faqat o‘qish rejimi">
                Faqat o‘qish
              </Badge>
            )}
            {/* DESIGN §9 — primary action rightmost; the roles are mutually
                exclusive, so each row carries exactly ONE primary. */}
            {isPm && (
              <Button onClick={() => setAdminDialogOpen(true)}>
                <Plus className="size-4" aria-hidden="true" />
                Admin sotib olish so‘rovi
              </Button>
            )}
            {canCreate && (
              <Button onClick={() => setDialogOpen(true)}>
                <Plus className="size-4" aria-hidden="true" />
                Yangi sotib olish
              </Button>
            )}
          </>
        }
      />

      {/* F-V — the raw keeper's «Ishlarim» feed is the default surface. */}
      {isRawKeeper && (
        <RawWorkInbox
          rawScope={rawScope}
          onOpenDetails={() => setDetailsOpen(true)}
        />
      )}

      {/* «Batafsil» disclosure — opens the full board + signals + PO table.
          Always-open (no toggle) for non-raw roles, which have no inbox. */}
      {isRawKeeper && (
        <button
          type="button"
          onClick={() => setDetailsOpen((v) => !v)}
          aria-expanded={detailsOpen}
          className="mx-auto flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          Batafsil
          <ChevronDown
            className={cn(
              'size-4 transition-transform',
              detailsOpen && 'rotate-180',
            )}
            aria-hidden="true"
          />
        </button>
      )}

      {showDetails && (
        <>
      {/* DESIGN §9 — FILTR QATORI: [outline Filter] right via ml-auto; the
          result count sits at the row's right edge (not a separate row). */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {!isLoading && !error && rows.length > 0 && (
            <span className="text-sm text-muted-foreground tabular-nums">
              {rows.length} ta so‘rov
            </span>
          )}
          <FilterPopover
            groups={filterGroups}
            value={filter}
            onApply={setFilter}
          />
        </div>
      </div>

      {/* F-F — below-min raw-material signals; self-hides on 404/403. */}
      <PurchaseSignalsSection
        onCreatePo={canCreate ? handleCreatePoFromSignal : null}
      />

      {/* F-S — bo'limlardan kelgan so'rovlar (pinned raw target): the same
          unified board every other link has. Accept/reject lives in the shared
          modal (accept-fulfiller); after accept the row shows the «Poster
          postavka kutilmoqda» state until the sync lands the stock. */}
      {rawScope.size > 0 && !replen.isLoading && !replen.error && (
        <section className="space-y-2">
          <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Bo‘limlardan kelgan so‘rovlar
          </h2>
          <BoardWorkspace
            incoming={rawBoards.incoming}
            outgoing={rawBoards.outgoing}
            onlySide="incoming"
            onOpen={(req) => setOpenRequest(req)}
            incomingEmptyLabel="Bo‘limlardan so‘rov yo‘q."
            actionScope={rawScope}
            heightClassName="h-[clamp(20rem,38dvh,30rem)]"
          />
        </section>
      )}

      <RequestDetailModal
        open={openRequest !== null}
        onOpenChange={(next) => {
          if (!next) setOpenRequest(null);
        }}
        request={openRequest}
        onActed={() => replen.refetch()}
      />

      <Card>
        {isLoading && <LoadingState />}
        {!isLoading && error && (
          <ErrorState message={error} onRetry={refetch} />
        )}
        {!isLoading && !error && rows.length === 0 && (
          <EmptyState message="So‘rovlar topilmadi." />
        )}
        {!isLoading && !error && rows.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Mahsulot</TableHead>
                <TableHead className="text-right">Miqdor</TableHead>
                <TableHead>Qabul qiluvchi</TableHead>
                <TableHead>Holat</TableHead>
                <TableHead>Tasdiq</TableHead>
                <TableHead>Yaratilgan</TableHead>
                <TableHead className="text-right">Amal</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const unit = row.product_unit ?? '';
                const isOpen = expandedId === row.id;
                const brakQty = row.brak_qty ?? 0;
                return (
                  <Fragment key={row.id}>
                    <TableRow
                      ref={(el) => {
                        if (el) rowRefs.current.set(row.id, el);
                        else rowRefs.current.delete(row.id);
                      }}
                      data-focused={expandedId === row.id ? '' : undefined}
                      className="scroll-mt-24 data-[focused]:bg-primary/5"
                    >
                      <TableCell className="text-muted-foreground">
                        #{row.id}
                      </TableCell>
                      <TableCell className="font-medium">
                        <span>{row.product_name}</span>
                        {brakQty > 0 && (
                          <span
                            className="mt-1 flex items-start gap-1 text-xs font-normal text-destructive"
                            title={row.brak_reason ?? undefined}
                          >
                            <AlertTriangle
                              className="mt-0.5 size-3 shrink-0"
                              aria-hidden="true"
                            />
                            <span className="break-words">
                              Brak: {formatQty(brakQty)} {unit}
                              {row.brak_reason ? ` — ${row.brak_reason}` : ''}
                            </span>
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatQty(row.qty)} {unit}
                      </TableCell>
                      <TableCell>{row.target_location_name}</TableCell>
                      <TableCell>
                        <Badge variant={PURCHASE_ORDER_STATUS_VARIANT[row.status]}>
                          {PURCHASE_ORDER_STATUS_LABELS[row.status]}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <ApprovalSteps order={row} />
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {formatDateTime(row.created_at)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            setExpandedId(isOpen ? null : row.id)
                          }
                        >
                          {isOpen ? 'Yashirish' : 'Ko‘rish'}
                        </Button>
                      </TableCell>
                    </TableRow>
                    {isOpen && (
                      <TableRow>
                        <TableCell colSpan={8} className="bg-muted/20">
                          <ApprovalPanel order={row} onChanged={refetch} />
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>
        </>
      )}

      {canCreate && (
        <PurchaseOrderFormDialog
          open={dialogOpen}
          onOpenChange={(next) => {
            setDialogOpen(next);
            // Drop the signal seed on close so the next plain "Yangi sotib
            // olish" opens a blank form.
            if (!next) setSignalSeed(undefined);
          }}
          products={products.data ?? []}
          locations={locations.data ?? []}
          onSaved={refetch}
          initialValues={signalSeed}
        />
      )}

      {isPm && (
        <AdminPurchaseOrderFormDialog
          open={adminDialogOpen}
          onOpenChange={setAdminDialogOpen}
          products={products.data ?? []}
          locations={locations.data ?? []}
          onSaved={refetch}
        />
      )}
    </div>
  );
}
