import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Link } from 'react-router-dom';
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
import { useApiQuery } from '@/hooks/useApiQuery';
import { useAuth } from '@/hooks/useAuth';
import { formatDateTime, formatQty } from '@/lib/format';
import {
  REPLENISHMENT_STATUS_LABELS,
  REPLENISHMENT_STATUS_OPTIONS,
  REPLENISHMENT_STATUS_VARIANT,
} from '@/lib/labels';
import type {
  Location,
  Product,
  ReplenishmentRequest,
  ReplenishmentStatus,
} from '@/lib/types';
import { ReplenishmentFormDialog } from './ReplenishmentFormDialog';

/**
 * M4 — replenishment list screen.
 * `GET /api/replenishment?status=` returns a bare `ReplenishmentRequest[]`
 * (RBAC-scoped by the backend). PM and central warehouse manager may
 * raise a manual request via `POST /api/replenishment` (D2-ga ko‘ra).
 */
export function ReplenishmentPage() {
  const { user } = useAuth();
  const canCreate =
    user?.role === 'pm' || user?.role === 'central_warehouse_manager';

  const [status, setStatus] = useState<ReplenishmentStatus | ''>('');
  const [dialogOpen, setDialogOpen] = useState(false);

  const path =
    status === ''
      ? '/api/replenishment'
      : `/api/replenishment?status=${status}`;

  const { data, isLoading, error, refetch } =
    useApiQuery<ReplenishmentRequest[]>(path);

  // Products / locations are loaded ONLY for the "Qo‘lda so‘rov" dialog —
  // the table itself reads `product_name`, `product_unit`,
  // `requester_location_name` from the embedded row (no client-side join).
  const products = useApiQuery<Product[]>(canCreate ? '/api/products' : null);
  const locations = useApiQuery<Location[]>(canCreate ? '/api/locations' : null);

  const rows = data ?? [];

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title="To‘ldirish so‘rovlari"
        description="Avtomatik to‘ldirish tsikli va so‘rovlar holati."
        action={
          canCreate ? (
            <Button onClick={() => setDialogOpen(true)}>
              <Plus className="size-4" aria-hidden="true" />
              Qo‘lda so‘rov
            </Button>
          ) : undefined
        }
      />

      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-1">
          <Label htmlFor="repl-status">Holat bo‘yicha</Label>
          <Select
            id="repl-status"
            className="w-64"
            value={status}
            onChange={(e) =>
              setStatus(e.target.value as ReplenishmentStatus | '')
            }
          >
            <option value="">Barcha holatlar</option>
            {REPLENISHMENT_STATUS_OPTIONS.map((opt) => (
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
        {!isLoading && !error && rows.length > 0 && (
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
              {rows.map((row) => {
                return (
                  <TableRow key={row.id}>
                    <TableCell className="text-muted-foreground">
                      #{row.id}
                    </TableCell>
                    <TableCell className="font-medium">
                      {row.product_name}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatQty(Number(row.qty_needed))} {row.product_unit}
                    </TableCell>
                    <TableCell>{row.requester_location_name}</TableCell>
                    <TableCell>
                      <Badge
                        variant={REPLENISHMENT_STATUS_VARIANT[row.status]}
                      >
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
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>

      {canCreate && (
        <ReplenishmentFormDialog
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
