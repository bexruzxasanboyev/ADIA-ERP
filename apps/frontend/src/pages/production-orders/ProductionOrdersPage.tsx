import { useMemo, useState } from 'react';
import { Plus, Loader2 } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from '@/components/PageState';
import { ViewToggle, useViewMode } from '@/components/ViewToggle';
import { MobileCardList } from '@/components/ui/table-mobile';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useCanAct } from '@/hooks/useCanAct';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { apiRequest, ApiError } from '@/lib/api-client';
import { formatDateTime, formatQty } from '@/lib/format';
import {
  PRODUCTION_ORDER_STATUS_LABELS,
  PRODUCTION_ORDER_STATUS_OPTIONS,
  PRODUCTION_ORDER_STATUS_VARIANT,
} from '@/lib/labels';
import type {
  Location,
  Product,
  ProductionOrder,
  ProductionOrderStatus,
} from '@/lib/types';
import { ProductionOrderFormDialog } from './ProductionOrderFormDialog';

/**
 * M5 — production orders list (zayafkalar).
 * `GET /api/production-orders?status=` returns a bare `ProductionOrder[]`.
 *
 * Status transitions (PATCH /:id) are exposed inline:
 *   - new → in_progress (Boshlash)
 *   - in_progress → done (Yakunlash) — atomic BOM-consume; 409
 *     `INSUFFICIENT_STOCK` surfaces as "BOM komponentlari yetarli emas".
 *   - new|in_progress → cancelled (Bekor qilish)
 */
export function ProductionOrdersPage() {
  const { isReadOnly, isOperator, canActOn } = useCanAct();
  // "Yangi zayafka" — Stage 1 (commit 68c5efd) restricts POST
  // /api/production-orders to production_manager + central_warehouse_manager
  // on a location they own (PM is read-only). We surface the button to
  // every operator role and rely on canActOn(target_location_id) inside
  // the dialog to enforce per-row scoping; the dialog itself can also
  // pre-filter the location <select>. Showing the button for an operator
  // who happens to be unassigned is still safe — the backend will 403
  // and we toast the error in `transition()` (and the dialog).
  const canCreate = isOperator;

  const { notify } = useToast();
  const bp = useBreakpoint();
  const showMobileCards = bp === 'xs';
  const [status, setStatus] = useState<ProductionOrderStatus | ''>('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [view, setView] = useViewMode('production-orders', 'card');
  const [busyId, setBusyId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const path =
    status === ''
      ? '/api/production-orders'
      : `/api/production-orders?status=${status}`;
  const { data, isLoading, error, refetch } =
    useApiQuery<ProductionOrder[]>(path);

  // The table reads `product_name`, `location_name`, and
  // `target_location_name` directly from the embedded row — no
  // client-side join on names. Products are still fetched so the
  // quantity cell can render the unit (the backend embeds product_name
  // but not product_unit for production orders; TODO: add it server-side
  // and drop this fetch). Locations are only needed by the "Yangi
  // zayafka" dialog.
  const products = useApiQuery<Product[]>('/api/products');
  const locations = useApiQuery<Location[]>(canCreate ? '/api/locations' : null);

  const productById = useMemo(() => {
    const m = new Map<number, Product>();
    for (const p of products.data ?? []) m.set(p.id, p);
    return m;
  }, [products.data]);

  async function transition(
    orderId: number,
    nextStatus: 'in_progress' | 'done' | 'cancelled',
  ): Promise<void> {
    setActionError(null);
    setBusyId(orderId);
    try {
      await apiRequest(`/api/production-orders/${orderId}`, {
        method: 'PATCH',
        body: { status: nextStatus },
      });
      notify(
        'success',
        `Zayafka holati: ${PRODUCTION_ORDER_STATUS_LABELS[nextStatus]}.`,
      );
      refetch();
    } catch (err: unknown) {
      if (err instanceof ApiError && err.code === 'INSUFFICIENT_STOCK') {
        setActionError(
          'BOM komponentlari yetarli emas — zayafka yakunlanmadi. Avval xom-ashyoni to‘ldiring.',
        );
      } else {
        setActionError(
          err instanceof ApiError ? err.message : 'Amalni bajarib bo‘lmadi.',
        );
      }
    } finally {
      setBusyId(null);
    }
  }

  const rows = data ?? [];

  return (
    <div className="mx-auto max-w-[120rem] space-y-6">
      <PageHeader
        title="Ishlab chiqarish zayafkalari"
        description="Ishlab chiqarish bo‘limidagi zayafkalar va ularning holati."
        action={
          <div className="flex flex-wrap items-center gap-2">
            {isReadOnly && (
              <Badge variant="secondary" aria-label="Faqat o‘qish rejimi">
                Faqat o‘qish
              </Badge>
            )}
            <ViewToggle value={view} onChange={setView} />
            {canCreate && (
              <Button onClick={() => setDialogOpen(true)}>
                <Plus className="size-4" aria-hidden="true" />
                Yangi zayafka
              </Button>
            )}
          </div>
        }
      />

      <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:gap-4">
        <div className="space-y-1">
          <Label htmlFor="po-status">Holat bo‘yicha</Label>
          <Select
            id="po-status"
            className="w-full sm:w-56"
            value={status}
            onChange={(e) =>
              setStatus(e.target.value as ProductionOrderStatus | '')
            }
          >
            <option value="">Barcha holatlar</option>
            {PRODUCTION_ORDER_STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {actionError && (
        <p
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          {actionError}
        </p>
      )}

      <Card
        className={
          view === 'card' && !showMobileCards
            ? 'border-0 bg-transparent p-0 shadow-none'
            : undefined
        }
      >
        {isLoading && <LoadingState />}
        {!isLoading && error && (
          <ErrorState message={error} onRetry={refetch} />
        )}
        {!isLoading && !error && rows.length === 0 && (
          <EmptyState message="Zayafkalar topilmadi." />
        )}
        {!isLoading && !error && rows.length > 0 && showMobileCards && (
          <MobileCardList
            items={rows.map((row) => {
              const isBusy = busyId === row.id;
              const unit = productById.get(row.product_id)?.unit ?? '';
              return {
                id: row.id,
                title: `#${row.id} · ${row.product_name}`,
                subtitle: `${row.location_name}${row.target_location_name ? ` → ${row.target_location_name}` : ''}`,
                badge: (
                  <Badge variant={PRODUCTION_ORDER_STATUS_VARIANT[row.status]}>
                    {PRODUCTION_ORDER_STATUS_LABELS[row.status]}
                  </Badge>
                ),
                fields: [
                  {
                    label: 'Miqdor',
                    value: `${formatQty(row.qty)} ${unit}`,
                  },
                  {
                    label: 'Muddat',
                    value: row.deadline ?? '—',
                  },
                  {
                    label: 'Yaratilgan',
                    value: formatDateTime(row.created_at),
                  },
                ],
                footer:
                  canActOn(row.location_id) &&
                  (row.status === 'new' || row.status === 'in_progress') ? (
                    <div className="flex flex-wrap gap-2">
                      {row.status === 'new' && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={isBusy}
                          onClick={() => transition(row.id, 'in_progress')}
                        >
                          {isBusy && (
                            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                          )}
                          Boshlash
                        </Button>
                      )}
                      {row.status === 'in_progress' && (
                        <Button
                          size="sm"
                          disabled={isBusy}
                          onClick={() => transition(row.id, 'done')}
                        >
                          {isBusy && (
                            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                          )}
                          Yakunlash
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={isBusy}
                        onClick={() => transition(row.id, 'cancelled')}
                      >
                        Bekor
                      </Button>
                    </div>
                  ) : undefined,
              };
            })}
          />
        )}
        {!isLoading && !error && rows.length > 0 && !showMobileCards && view === 'card' && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 xl:grid-cols-4 2xl:grid-cols-5">
            {rows.map((row) => {
              const isBusy = busyId === row.id;
              const unit = productById.get(row.product_id)?.unit ?? '';
              return (
                <div
                  key={row.id}
                  className="flex flex-col gap-3 rounded-lg border border-border/60 bg-card/40 p-4 shadow-sm"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs text-muted-foreground">#{row.id}</p>
                      <p className="truncate text-sm font-semibold">
                        {row.product_name}
                      </p>
                    </div>
                    <Badge variant={PRODUCTION_ORDER_STATUS_VARIANT[row.status]}>
                      {PRODUCTION_ORDER_STATUS_LABELS[row.status]}
                    </Badge>
                  </div>
                  <dl className="grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <dt className="text-muted-foreground">Miqdor</dt>
                      <dd className="tabular-nums">
                        {formatQty(row.qty)} {unit}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Muddat</dt>
                      <dd>{row.deadline ?? '—'}</dd>
                    </div>
                    <div className="col-span-2">
                      <dt className="text-muted-foreground">Bo‘g‘in</dt>
                      <dd className="truncate">
                        {row.location_name}
                        {row.target_location_name && ` → ${row.target_location_name}`}
                      </dd>
                    </div>
                  </dl>
                  {canActOn(row.location_id) &&
                    (row.status === 'new' || row.status === 'in_progress') && (
                      <div className="flex flex-wrap gap-2">
                        {row.status === 'new' && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={isBusy}
                            onClick={() => transition(row.id, 'in_progress')}
                          >
                            {isBusy && (
                              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                            )}
                            Boshlash
                          </Button>
                        )}
                        {row.status === 'in_progress' && (
                          <Button
                            size="sm"
                            disabled={isBusy}
                            onClick={() => transition(row.id, 'done')}
                          >
                            {isBusy && (
                              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                            )}
                            Yakunlash
                          </Button>
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={isBusy}
                          onClick={() => transition(row.id, 'cancelled')}
                        >
                          Bekor
                        </Button>
                      </div>
                    )}
                </div>
              );
            })}
          </div>
        )}
        {!isLoading && !error && rows.length > 0 && !showMobileCards && view === 'table' && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Mahsulot</TableHead>
                <TableHead className="text-right">Miqdor</TableHead>
                <TableHead>Ishlab chiqarish bo‘g‘ini</TableHead>
                <TableHead>Maqsad</TableHead>
                <TableHead>Muddat</TableHead>
                <TableHead>Holat</TableHead>
                <TableHead className="text-right">Amal</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const isBusy = busyId === row.id;
                const unit = productById.get(row.product_id)?.unit ?? '';
                return (
                  <TableRow key={row.id}>
                    <TableCell className="text-muted-foreground">
                      #{row.id}
                    </TableCell>
                    <TableCell className="font-medium">
                      {row.product_name}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatQty(row.qty)} {unit}
                    </TableCell>
                    <TableCell>{row.location_name}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.target_location_name ?? '—'}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {row.deadline ?? '—'}
                    </TableCell>
                    <TableCell>
                      <Badge variant={PRODUCTION_ORDER_STATUS_VARIANT[row.status]}>
                        {PRODUCTION_ORDER_STATUS_LABELS[row.status]}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="inline-flex gap-2">
                        {canActOn(row.location_id) && row.status === 'new' && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={isBusy}
                            onClick={() => transition(row.id, 'in_progress')}
                          >
                            {isBusy && (
                              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                            )}
                            Boshlash
                          </Button>
                        )}
                        {canActOn(row.location_id) && row.status === 'in_progress' && (
                          <Button
                            size="sm"
                            disabled={isBusy}
                            onClick={() => transition(row.id, 'done')}
                          >
                            {isBusy && (
                              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                            )}
                            Yakunlash
                          </Button>
                        )}
                        {canActOn(row.location_id) &&
                          (row.status === 'new' || row.status === 'in_progress') && (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={isBusy}
                              onClick={() => transition(row.id, 'cancelled')}
                            >
                              Bekor
                            </Button>
                          )}
                        <span className="whitespace-nowrap text-xs text-muted-foreground">
                          {formatDateTime(row.created_at)}
                        </span>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>

      {canCreate && (
        <ProductionOrderFormDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          products={products.data ?? []}
          locations={locations.data ?? []}
          onSaved={refetch}
        />
      )}
    </div>
  );
}
