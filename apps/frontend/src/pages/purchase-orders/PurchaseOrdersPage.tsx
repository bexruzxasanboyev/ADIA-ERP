import { Fragment, useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
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
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from '@/components/PageState';
import { ViewToggle, useViewMode } from '@/components/ViewToggle';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useAuth } from '@/hooks/useAuth';
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
import { PurchaseOrderFormDialog } from './PurchaseOrderFormDialog';
import { ApprovalPanel } from './ApprovalPanel';

/**
 * M6 — purchase orders list (sotib olish so‘rovlari).
 * `GET /api/purchase-orders?status=` returns a bare `PurchaseOrder[]`.
 *
 * The two-step approval (D5) is exposed via `ApprovalPanel` — each row
 * expands inline so the manager and the warehouse keeper can sign off
 * independently. Receive / reject also live in that panel.
 */
export function PurchaseOrdersPage() {
  const { user } = useAuth();
  const canCreate = user?.role === 'pm' || user?.role === 'supply_manager';

  const [status, setStatus] = useState<PurchaseOrderStatus | ''>('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [view, setView] = useViewMode('purchase-orders', 'card');

  const path =
    status === ''
      ? '/api/purchase-orders'
      : `/api/purchase-orders?status=${status}`;
  const { data, isLoading, error, refetch } =
    useApiQuery<PurchaseOrder[]>(path);

  // The table reads `product_name`, `target_location_name`,
  // `manager_approved_name`, `keeper_approved_name`, `supplier_name`
  // directly from the embedded row — no client-side join on names.
  // Products are still fetched so the quantity cell can render the unit
  // (the backend embeds `product_name` but not `product_unit` for
  // purchase orders; TODO: add it server-side and drop this fetch).
  // Locations are only needed by the "Yangi sotib olish" dialog.
  const products = useApiQuery<Product[]>('/api/products');
  const locations = useApiQuery<Location[]>(canCreate ? '/api/locations' : null);

  const productById = useMemo(() => {
    const m = new Map<number, Product>();
    for (const p of products.data ?? []) m.set(p.id, p);
    return m;
  }, [products.data]);

  const rows = data ?? [];

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title="Sotib olish so‘rovlari"
        description="Ta’minot bo‘limining sotib olish hujjatlari va ikki bosqichli tasdiq."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <ViewToggle value={view} onChange={setView} />
            {canCreate && (
              <Button onClick={() => setDialogOpen(true)}>
                <Plus className="size-4" aria-hidden="true" />
                Yangi sotib olish
              </Button>
            )}
          </div>
        }
      />

      <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:gap-4">
        <div className="space-y-1">
          <Label htmlFor="purch-status">Holat bo‘yicha</Label>
          <Select
            id="purch-status"
            className="w-full sm:w-56"
            value={status}
            onChange={(e) =>
              setStatus(e.target.value as PurchaseOrderStatus | '')
            }
          >
            <option value="">Barcha holatlar</option>
            {PURCHASE_ORDER_STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <Card>
        {isLoading && <LoadingState />}
        {!isLoading && error && (
          <ErrorState message={error} onRetry={refetch} />
        )}
        {!isLoading && !error && rows.length === 0 && (
          <EmptyState message="So‘rovlar topilmadi." />
        )}
        {!isLoading && !error && rows.length > 0 && view === 'card' && (
          <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
            {rows.map((row) => {
              const unit = productById.get(row.product_id)?.unit ?? '';
              const isOpen = expandedId === row.id;
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
                    <Badge variant={PURCHASE_ORDER_STATUS_VARIANT[row.status]}>
                      {PURCHASE_ORDER_STATUS_LABELS[row.status]}
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
                      <dt className="text-muted-foreground">Yaratilgan</dt>
                      <dd className="text-muted-foreground">
                        {formatDateTime(row.created_at)}
                      </dd>
                    </div>
                    <div className="col-span-2">
                      <dt className="text-muted-foreground">Qabul qiluvchi</dt>
                      <dd className="truncate">{row.target_location_name}</dd>
                    </div>
                  </dl>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setExpandedId(isOpen ? null : row.id)
                    }
                  >
                    {isOpen ? 'Yashirish' : 'Ko‘rish'}
                  </Button>
                  {isOpen && (
                    <div className="rounded-md bg-muted/20 p-3">
                      <ApprovalPanel order={row} onChanged={refetch} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {!isLoading && !error && rows.length > 0 && view === 'table' && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Mahsulot</TableHead>
                <TableHead className="text-right">Miqdor</TableHead>
                <TableHead>Qabul qiluvchi</TableHead>
                <TableHead>Holat</TableHead>
                <TableHead>Yaratilgan</TableHead>
                <TableHead className="text-right">Amal</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const unit = productById.get(row.product_id)?.unit ?? '';
                const isOpen = expandedId === row.id;
                return (
                  <Fragment key={row.id}>
                    <TableRow>
                      <TableCell className="text-muted-foreground">
                        #{row.id}
                      </TableCell>
                      <TableCell className="font-medium">
                        {row.product_name}
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
                        <TableCell colSpan={7} className="bg-muted/20">
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

      {canCreate && (
        <PurchaseOrderFormDialog
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
