import { useState } from 'react';
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
  const [busyId, setBusyId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const path =
    status === ''
      ? '/api/production-orders'
      : `/api/production-orders?status=${status}`;
  const { data, isLoading, error, refetch } =
    useApiQuery<ProductionOrder[]>(path);

  // The table reads `product_name`, `product_unit`, `location_name`, and
  // `target_location_name` directly from the embedded row — no client-side
  // join. Products + locations are only needed by the "Yangi zayafka"
  // dialog, so fetch them lazily for the roles that can create.
  const products = useApiQuery<Product[]>(canCreate ? '/api/products' : null);
  const locations = useApiQuery<Location[]>(canCreate ? '/api/locations' : null);

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
        actions={
          <>
            {isReadOnly && (
              <Badge variant="secondary" className="h-9 items-center px-3" aria-label="Faqat o‘qish rejimi">
                Faqat o‘qish
              </Badge>
            )}
            {canCreate && (
              <Button onClick={() => setDialogOpen(true)}>
                <Plus className="size-4" aria-hidden="true" />
                Yangi zayafka
              </Button>
            )}
          </>
        }
      />

      <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:gap-4">
        <div className="space-y-1.5">
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
          className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          {actionError}
        </p>
      )}

      <Card>
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
              const unit = row.product_unit ?? '';
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
        {!isLoading && !error && rows.length > 0 && !showMobileCards && (
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
                const unit = row.product_unit ?? '';
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
