import { useState } from 'react';
import { ArrowLeftRight } from 'lucide-react';
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
import { cn } from '@/lib/utils';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from '@/components/PageState';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useAuth } from '@/hooks/useAuth';
import { UNIT_LABELS } from '@/lib/labels';
import { formatDateTime, formatQty } from '@/lib/format';
import type { Location, Product, StockRow } from '@/lib/types';
import { MinMaxCell } from './MinMaxCell';
import { MovementDialog } from './MovementDialog';
import { MovementHistory } from './MovementHistory';

type StockTab = 'stock' | 'history';

const TAB_OPTIONS: { value: StockTab; label: string }[] = [
  { value: 'stock', label: 'Qoldiq' },
  { value: 'history', label: 'Harakatlar tarixi' },
];

/**
 * M3 — stock screen. Shows the `(location, product)` qty / min / max
 * table; rows where `qty <= min_level` are highlighted red. Min/max is
 * inline-editable, movements are recorded via a dialog, and the second
 * tab is the movement ledger.
 *
 * Reused by every warehouse / store module screen — the `title` and the
 * effective location scope are passed in.
 */
export function StockPage({
  title = 'Ombor qoldig‘i',
  description,
}: {
  title?: string;
  description?: string;
}) {
  const { user } = useAuth();
  // store_manager may not record movements (§6: stock/movement W = no store).
  const canMove = user?.role !== 'store_manager';
  // Everyone with stock access (except ai) may edit min/max (§6).
  const canEditMinMax = true;

  const [tab, setTab] = useState<StockTab>('stock');
  const [locationFilter, setLocationFilter] = useState<string>('');
  const [movementOpen, setMovementOpen] = useState(false);

  const locations = useApiQuery<Location[]>('/api/locations');
  const products = useApiQuery<Product[]>('/api/products');

  // The backend scopes /api/stock by role; an explicit location filter
  // narrows it further for `pm` who otherwise sees the whole chain.
  const stockPath =
    locationFilter === ''
      ? '/api/stock'
      : `/api/stock?location_id=${locationFilter}`;
  const stock = useApiQuery<StockRow[]>(stockPath);

  const rows = stock.data ?? [];
  const belowMin = rows.filter((r) => r.qty <= r.min_level).length;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title={title}
        description={description ?? 'Bo‘g‘inlar bo‘yicha ostatka va harakatlar.'}
        action={
          canMove ? (
            <Button onClick={() => setMovementOpen(true)}>
              <ArrowLeftRight className="size-4" aria-hidden="true" />
              Harakat qo‘shish
            </Button>
          ) : undefined
        }
      />

      <div className="flex flex-wrap items-end justify-between gap-4">
        <Tabs
          value={tab}
          onValueChange={setTab}
          options={TAB_OPTIONS}
          ariaLabel="Qoldiq ko‘rinishi"
        />
        <div className="space-y-1">
          <Label htmlFor="stock-location">Bo‘g‘in bo‘yicha</Label>
          <Select
            id="stock-location"
            className="w-56"
            value={locationFilter}
            onChange={(e) => setLocationFilter(e.target.value)}
          >
            <option value="">Barcha bo‘g‘inlar</option>
            {(locations.data ?? []).map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {tab === 'stock' && belowMin > 0 && (
        <div
          className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive-foreground"
          role="alert"
        >
          <Badge variant="danger">{belowMin}</Badge>
          <span>pozitsiya minimal darajadan past — to‘ldirish talab etiladi.</span>
        </div>
      )}

      <Card>
        {tab === 'stock' ? (
          <>
            {stock.isLoading && <LoadingState />}
            {!stock.isLoading && stock.error && (
              <ErrorState message={stock.error} onRetry={stock.refetch} />
            )}
            {!stock.isLoading && !stock.error && rows.length === 0 && (
              <EmptyState message="Qoldiq ma’lumotlari topilmadi." />
            )}
            {!stock.isLoading && !stock.error && rows.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Mahsulot</TableHead>
                    <TableHead className="text-right">Qoldiq</TableHead>
                    <TableHead>Min / Max</TableHead>
                    <TableHead>Holat</TableHead>
                    <TableHead>Yangilangan</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => {
                    const isLow = row.qty <= row.min_level;
                    const unit = UNIT_LABELS[row.product_unit];
                    return (
                      <TableRow
                        key={`${row.location_id}-${row.product_id}`}
                        className={cn(
                          isLow && 'bg-destructive/10 hover:bg-destructive/15',
                        )}
                      >
                        <TableCell className="font-medium">
                          {row.product_name}
                        </TableCell>
                        <TableCell
                          className={cn(
                            'text-right tabular-nums',
                            isLow && 'font-semibold text-destructive',
                          )}
                        >
                          {formatQty(row.qty)} {unit}
                        </TableCell>
                        <TableCell>
                          <MinMaxCell
                            row={row}
                            canEdit={canEditMinMax}
                            onSaved={stock.refetch}
                          />
                        </TableCell>
                        <TableCell>
                          {isLow ? (
                            <Badge variant="danger">Min dan past</Badge>
                          ) : (
                            <Badge variant="success">Yetarli</Badge>
                          )}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-muted-foreground">
                          {formatDateTime(row.updated_at)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </>
        ) : (
          <MovementHistory
            locationId={locationFilter === '' ? null : Number(locationFilter)}
          />
        )}
      </Card>

      {canMove && (
        <MovementDialog
          open={movementOpen}
          onOpenChange={setMovementOpen}
          products={products.data ?? []}
          locations={locations.data ?? []}
          scopeLocationId={
            locationFilter ||
            (user?.location_id != null ? String(user.location_id) : '')
          }
          onSaved={stock.refetch}
        />
      )}
    </div>
  );
}
