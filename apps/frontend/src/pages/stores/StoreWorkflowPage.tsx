import { useMemo, useState } from 'react';
import {
  History,
  Inbox,
  PackageCheck,
  Plus,
  Send,
  Sparkles,
  Store,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Tabs } from '@/components/ui/tabs';
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
import { formatDateTime, formatQtyUnit } from '@/lib/format';
import {
  MOVEMENT_REASON_LABELS,
  REPLENISHMENT_STATUS_LABELS,
  REPLENISHMENT_STATUS_VARIANT,
} from '@/lib/labels';
import { cn } from '@/lib/utils';
import type {
  Location,
  MovementsResponse,
  Product,
  ReplenishmentRequest,
  StockRow,
} from '@/lib/types';
import { TERMINAL_REPLENISHMENT_STATUSES } from '@/lib/types';
import { StoreRequestCreateDialog } from './StoreRequestCreateDialog';
import { StoreReceiveDialog } from './StoreReceiveDialog';
import { StoreAiProposalsDialog } from './StoreAiProposalsDialog';

/**
 * Do'kon ish joyi — a clean, store-scoped workflow page (owner feedback: the
 * 398-row /replenishment dump is "juda tartibsiz").
 *
 * Three focused parts, all scoped to ONE store:
 *   1. Mahsulotlar — the store's stock with a stock-status segmented filter.
 *   2. So'rovlar — two tabs: "So'rov" (sent by this store) + "Qabul qiluvchi"
 *      (shipped to this store, awaiting receive).
 *   3. Per-request status, mapped through REPLENISHMENT_STATUS_LABELS.
 *
 * RBAC: a `store_manager` is pinned to their active location; `pm` gets a
 * store picker. The backend RBAC-scopes every endpoint, so a scoped manager
 * never sees another store.
 *
 * Backend contracts (reconcile with backend-engineer):
 *   - Stock:        GET /api/stock?location_id=<store>
 *   - Requests:     GET /api/replenishment  (RBAC-scoped, filtered client-side
 *                   to this store's requester/target rows)
 *   - Batch create: POST /api/replenishment/batch
 *   - Receive:      POST /api/replenishment/:id/receive
 */

type StockStatusKey = 'all' | 'below_min' | 'low' | 'out' | 'enough';

const STOCK_STATUS_TABS: { value: StockStatusKey; label: string }[] = [
  { value: 'all', label: 'Hammasi' },
  { value: 'below_min', label: 'Min’dan past' },
  { value: 'low', label: 'Kam' },
  { value: 'out', label: 'Tugagan' },
  { value: 'enough', label: 'Yetarli' },
];

type RequestTabKey = 'sent' | 'incoming' | 'transactions';

/**
 * "Kam" (low) heuristic: at or below 120% of min but still above min — the
 * early-warning band before a row actually crosses min. `min_level === 0`
 * rows have no meaningful low band, so they never count as "low".
 */
function isLowStock(row: StockRow): boolean {
  if (row.min_level <= 0) return false;
  return row.qty > row.min_level && row.qty <= row.min_level * 1.2;
}

function stockStatusOf(row: StockRow): Exclude<StockStatusKey, 'all'> {
  if (row.qty <= 0) return 'out';
  if (row.qty <= row.min_level) return 'below_min';
  if (isLowStock(row)) return 'low';
  return 'enough';
}

function StockStatusPill({ row }: { row: StockRow }) {
  const status = stockStatusOf(row);
  switch (status) {
    case 'out':
      return <Badge variant="danger">Tugagan</Badge>;
    case 'below_min':
      return <Badge variant="danger">Min’dan past</Badge>;
    case 'low':
      return <Badge variant="warning">Kam</Badge>;
    case 'enough':
    default:
      return <Badge variant="success">Yetarli</Badge>;
  }
}

export function StoreWorkflowPage() {
  const { user, activeLocationId } = useAuth();
  const isPm = user?.role === 'pm';
  // RBAC split (owner feedback): the store-role user does the full workflow;
  // a "manager" (pm) only VIEWS (read-only). Every action affordance —
  // "+ So'rov qo'shish", "Qabul qilish", "AI takliflari" — is store_manager
  // only; pm sees data without write controls.
  const isStoreManager = user?.role === 'store_manager';

  // PM picks a store; a store_manager is pinned to their active location
  // (falling back to their primary location_id).
  const [pickedStoreId, setPickedStoreId] = useState<string>('');
  const scopedStoreId = isPm
    ? pickedStoreId
    : String(activeLocationId ?? user?.location_id ?? '');
  const storeIdNum = scopedStoreId === '' ? null : Number(scopedStoreId);

  // PM needs the store list for the picker; scoped managers don't.
  const stores = useApiQuery<Location[]>(isPm ? '/api/locations' : null);
  const storeOptions = useMemo(
    () => (stores.data ?? []).filter((l) => l.type === 'store'),
    [stores.data],
  );

  const products = useApiQuery<Product[]>('/api/products');
  const stock = useApiQuery<StockRow[]>(
    storeIdNum === null ? null : `/api/stock?location_id=${storeIdNum}`,
  );
  // The backend RBAC-scopes the list; for a `pm` (chain-wide) we additionally
  // filter to the picked store client-side so the page stays store-scoped.
  const replen = useApiQuery<ReplenishmentRequest[]>('/api/replenishment');
  // "Tranzaksiyalar" — every stock movement touching this store, newest
  // first. Filtered to INCOMING receipts (to_location_id === store) below.
  const movements = useApiQuery<MovementsResponse>(
    storeIdNum === null
      ? null
      : `/api/stock/movements?location_id=${storeIdNum}&limit=50`,
  );

  const [statusFilter, setStatusFilter] = useState<StockStatusKey>('all');
  const [requestTab, setRequestTab] = useState<RequestTabKey>('sent');
  const [createOpen, setCreateOpen] = useState(false);
  const [aiProposalsOpen, setAiProposalsOpen] = useState(false);
  const [receiveTarget, setReceiveTarget] =
    useState<ReplenishmentRequest | null>(null);

  const stockRows = stock.data ?? [];
  const filteredStock = useMemo(() => {
    if (statusFilter === 'all') return stockRows;
    return stockRows.filter((r) => stockStatusOf(r) === statusFilter);
  }, [stockRows, statusFilter]);

  // Active products available to request for this store (only sellable /
  // non-archived rows). Stores hold finished goods.
  const requestableProducts = useMemo(
    () => (products.data ?? []).filter((p) => p.is_active),
    [products.data],
  );

  // Split this store's requests into "sent" (requester = store, open) and
  // "incoming" (target = store AND shipped, awaiting receive).
  const { sent, incoming } = useMemo(() => {
    const rows = replen.data ?? [];
    const sentRows: ReplenishmentRequest[] = [];
    const incomingRows: ReplenishmentRequest[] = [];
    if (storeIdNum === null) return { sent: sentRows, incoming: incomingRows };

    for (const row of rows) {
      const isRequester = row.requester_location_id === storeIdNum;
      const isTarget = row.target_location_id === storeIdNum;
      const isTerminal = TERMINAL_REPLENISHMENT_STATUSES.includes(row.status);

      if (isRequester && !isTerminal) {
        sentRows.push(row);
      }
      // "Qabul qiluvchi" — shipped to this store and awaiting receive.
      if (
        (isTarget || isRequester) &&
        row.status === 'SHIP_TO_REQUESTER'
      ) {
        incomingRows.push(row);
      }
    }
    sentRows.sort((a, b) => b.id - a.id);
    incomingRows.sort((a, b) => b.id - a.id);
    return { sent: sentRows, incoming: incomingRows };
  }, [replen.data, storeIdNum]);

  // Tranzaksiyalar — products this store RECEIVED, newest first. The
  // endpoint matches movements where the store is EITHER side; we keep only
  // the incoming receipts (to_location_id === this store).
  const incomingMovements = useMemo(() => {
    if (storeIdNum === null) return [];
    const rows = movements.data?.items ?? [];
    return rows
      .filter((m) => m.to_location_id === storeIdNum)
      .sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
  }, [movements.data, storeIdNum]);

  const requestTabOptions: { value: RequestTabKey; label: string }[] = [
    { value: 'sent', label: `So‘rov (${sent.length})` },
    { value: 'incoming', label: `Qabul qiluvchi (${incoming.length})` },
    { value: 'transactions', label: 'Tranzaksiyalar' },
  ];

  const requestRows = requestTab === 'sent' ? sent : incoming;

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <PageHeader
        title="Do‘kon ish joyi"
        description="Do‘kon qoldig‘i, yuborilgan so‘rovlar va qabul qilinadigan jo‘natmalar — bitta joyda."
      />

      {isPm && (
        <div className="space-y-1">
          <Label htmlFor="store-picker">Do‘kon</Label>
          <Select
            id="store-picker"
            className="w-full sm:w-72"
            value={pickedStoreId}
            onChange={(e) => setPickedStoreId(e.target.value)}
          >
            <option value="">— Do‘konni tanlang —</option>
            {storeOptions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </div>
      )}

      {storeIdNum === null ? (
        <Card>
          <EmptyState
            message={
              isPm
                ? 'Boshlash uchun do‘konni tanlang.'
                : 'Sizga do‘kon biriktirilmagan.'
            }
          />
        </Card>
      ) : (
        <>
          {/* PART 1 — Mahsulotlar. */}
          <Card>
            <header className="flex flex-col gap-3 border-b border-border/60 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-0.5">
                <h2 className="flex items-center gap-2 text-base font-semibold">
                  <Store className="size-4 text-primary" aria-hidden="true" />
                  Mahsulotlar
                </h2>
                <p className="text-xs text-muted-foreground">
                  Do‘kon qoldig‘i va har bir mahsulot holati.
                </p>
              </div>
              <Tabs
                value={statusFilter}
                onValueChange={setStatusFilter}
                options={STOCK_STATUS_TABS}
                ariaLabel="Qoldiq holati bo‘yicha filtr"
              />
            </header>

            {stock.isLoading && <LoadingState />}
            {!stock.isLoading && stock.error && (
              <ErrorState message={stock.error} onRetry={stock.refetch} />
            )}
            {!stock.isLoading && !stock.error && filteredStock.length === 0 && (
              <EmptyState
                message={
                  stockRows.length === 0
                    ? 'Qoldiq ma’lumotlari topilmadi.'
                    : 'Bu holat bo‘yicha mahsulot yo‘q.'
                }
              />
            )}
            {!stock.isLoading &&
              !stock.error &&
              filteredStock.length > 0 && (
                <div className="scrollbar-thin overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Mahsulot</TableHead>
                        <TableHead className="text-right">Qoldiq</TableHead>
                        <TableHead className="text-right">Min / Max</TableHead>
                        <TableHead>Holat</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredStock.map((row) => {
                        const danger =
                          row.qty <= 0 || row.qty <= row.min_level;
                        return (
                          <TableRow
                            key={`${row.location_id}-${row.product_id}`}
                            className={cn(danger && 'bg-destructive/5')}
                          >
                            <TableCell className="font-medium">
                              {row.product_name}
                            </TableCell>
                            <TableCell
                              className={cn(
                                'text-right tabular-nums',
                                danger && 'font-semibold text-destructive',
                              )}
                            >
                              {formatQtyUnit(row.qty, row.product_unit)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-muted-foreground">
                              {formatQtyUnit(row.min_level, row.product_unit)}
                              {' / '}
                              {formatQtyUnit(row.max_level, row.product_unit)}
                            </TableCell>
                            <TableCell>
                              <StockStatusPill row={row} />
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
          </Card>

          {/* PART 2 — So'rovlar (So'rov / Qabul qiluvchi). */}
          <Card>
            <header className="flex flex-col gap-3 border-b border-border/60 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-0.5">
                <h2 className="flex items-center gap-2 text-base font-semibold">
                  <Send className="size-4 text-primary" aria-hidden="true" />
                  So‘rovlar
                </h2>
                <p className="text-xs text-muted-foreground">
                  Yuborilgan so‘rovlar va qabul qilinadigan jo‘natmalar.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Tabs
                  value={requestTab}
                  onValueChange={setRequestTab}
                  options={requestTabOptions}
                  ariaLabel="So‘rovlar ko‘rinishi"
                />
                {/* Action affordances are store_manager-only; pm views
                    read-only (owner RBAC split). */}
                {isStoreManager && requestTab === 'sent' && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setAiProposalsOpen(true)}
                    >
                      <Sparkles className="size-4" aria-hidden="true" />
                      AI takliflari
                    </Button>
                    <Button onClick={() => setCreateOpen(true)} size="sm">
                      <Plus className="size-4" aria-hidden="true" />
                      So‘rov qo‘shish
                    </Button>
                  </>
                )}
              </div>
            </header>

            {requestTab !== 'transactions' && replen.isLoading && (
              <LoadingState />
            )}
            {requestTab !== 'transactions' &&
              !replen.isLoading &&
              replen.error && (
                <ErrorState message={replen.error} onRetry={replen.refetch} />
              )}
            {requestTab !== 'transactions' &&
              !replen.isLoading &&
              !replen.error &&
              requestRows.length === 0 && (
                <EmptyState
                  message={
                    requestTab === 'sent'
                      ? 'Hozircha yuborilgan so‘rov yo‘q.'
                      : 'Qabul qilinadigan jo‘natma yo‘q.'
                  }
                />
              )}
            {requestTab !== 'transactions' &&
              !replen.isLoading &&
              !replen.error &&
              requestRows.length > 0 && (
                <div className="scrollbar-thin overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>#</TableHead>
                        <TableHead>Mahsulot</TableHead>
                        <TableHead className="text-right">Miqdor</TableHead>
                        <TableHead>Holat</TableHead>
                        <TableHead>Yaratilgan</TableHead>
                        {requestTab === 'incoming' && isStoreManager && (
                          <TableHead className="text-right">Amal</TableHead>
                        )}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {requestRows.map((row) => (
                        <TableRow key={row.id}>
                          <TableCell className="text-muted-foreground">
                            #{row.id}
                          </TableCell>
                          <TableCell className="font-medium">
                            {row.product_name}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatQtyUnit(row.qty_needed, row.product_unit)}
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={
                                REPLENISHMENT_STATUS_VARIANT[row.status]
                              }
                            >
                              {REPLENISHMENT_STATUS_LABELS[row.status]}
                            </Badge>
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-muted-foreground">
                            {formatDateTime(row.created_at)}
                          </TableCell>
                          {requestTab === 'incoming' && isStoreManager && (
                            <TableCell className="text-right">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setReceiveTarget(row)}
                              >
                                <PackageCheck
                                  className="size-4"
                                  aria-hidden="true"
                                />
                                Qabul qilish
                              </Button>
                            </TableCell>
                          )}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

            {/* Tranzaksiyalar — sana bo'yicha qabul qilingan mahsulotlar. */}
            {requestTab === 'transactions' && movements.isLoading && (
              <LoadingState />
            )}
            {requestTab === 'transactions' &&
              !movements.isLoading &&
              movements.error && (
                <ErrorState
                  message={movements.error}
                  onRetry={movements.refetch}
                />
              )}
            {requestTab === 'transactions' &&
              !movements.isLoading &&
              !movements.error &&
              incomingMovements.length === 0 && (
                <EmptyState message="Hali qabul qilingan mahsulot yo‘q." />
              )}
            {requestTab === 'transactions' &&
              !movements.isLoading &&
              !movements.error &&
              incomingMovements.length > 0 && (
                <div className="scrollbar-thin overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Sana</TableHead>
                        <TableHead>Mahsulot</TableHead>
                        <TableHead className="text-right">Miqdor</TableHead>
                        <TableHead>Manba</TableHead>
                        <TableHead>Sabab</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {incomingMovements.map((m) => (
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
                          <TableCell>
                            <Badge variant="secondary">
                              {MOVEMENT_REASON_LABELS[m.reason]}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

            {requestTab === 'incoming' && isStoreManager && (
              <p className="flex items-center gap-2 border-t border-border/60 px-5 py-3 text-xs text-muted-foreground">
                <Inbox className="size-3.5" aria-hidden="true" />
                Jo‘natilgan tovar yetib kelganda «Qabul qilish» orqali
                tasdiqlang.
              </p>
            )}
            {requestTab === 'transactions' && (
              <p className="flex items-center gap-2 border-t border-border/60 px-5 py-3 text-xs text-muted-foreground">
                <History className="size-3.5" aria-hidden="true" />
                Do‘konga qabul qilingan mahsulotlar — eng yangisi yuqorida.
              </p>
            )}
          </Card>
        </>
      )}

      <StoreRequestCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        products={requestableProducts}
        storeLocationId={storeIdNum ?? 0}
        onSaved={() => {
          replen.refetch();
          stock.refetch();
        }}
      />

      <StoreReceiveDialog
        open={receiveTarget !== null}
        onOpenChange={(o) => {
          if (!o) setReceiveTarget(null);
        }}
        request={receiveTarget}
        onSaved={() => {
          setReceiveTarget(null);
          replen.refetch();
          stock.refetch();
        }}
      />

      <StoreAiProposalsDialog
        open={aiProposalsOpen}
        onOpenChange={setAiProposalsOpen}
        storeLocationId={storeIdNum ?? 0}
        onApproved={() => {
          replen.refetch();
          stock.refetch();
        }}
      />
    </div>
  );
}
