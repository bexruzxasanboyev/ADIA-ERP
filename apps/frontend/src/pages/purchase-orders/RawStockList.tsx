import { useMemo, useState } from 'react';
import { Search, Warehouse, X } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState, ErrorState, LoadingState } from '@/components/PageState';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useAuth } from '@/hooks/useAuth';
import { formatQtyUnit } from '@/lib/format';
import { matchesSearch } from '@/lib/translit';
import { cn } from '@/lib/utils';
import type { StockRow } from '@/lib/types';

/**
 * Homashyo ombori — «Mahsulotlar» segment (owner: "o'zida bor mahsulotlar
 * qayerdan ko'rinib turadi?"): the keeper's own on-hand RAW stock as a simple,
 * read-only searchable table — product · qty · unit + a min/max status badge.
 * Data: the same RBAC-scoped `GET /api/stock` every warehouse view uses
 * (precise `?location_id=` when the keeper operates exactly one raw ombor).
 */

function statusOf(row: StockRow): { label: string; variant: 'danger' | 'warning' | 'success' } {
  if (row.qty <= 0) return { label: 'Tugagan', variant: 'danger' };
  if (row.qty <= row.min_level) {
    return { label: 'Min’dan past', variant: 'warning' };
  }
  return { label: 'Yetarli', variant: 'success' };
}

export function RawStockList({ rawScope }: { rawScope: ReadonlySet<number> }) {
  const { locations } = useAuth();
  const singleId = rawScope.size === 1 ? [...rawScope][0] : null;
  const stock = useApiQuery<StockRow[]>(
    singleId != null ? `/api/stock?location_id=${singleId}` : '/api/stock',
  );
  const [search, setSearch] = useState('');

  const locationNameById = useMemo(() => {
    const m = new Map<number, string>();
    for (const loc of locations) m.set(loc.id, loc.name);
    return m;
  }, [locations]);

  // Scope to MY raw warehouse(s); below-min rows first, then by name.
  const rows = useMemo(() => {
    return (stock.data ?? [])
      .filter(
        (r) =>
          rawScope.has(r.location_id) &&
          matchesSearch(r.product_name, search),
      )
      .sort((a, b) => {
        const aLow = a.qty <= a.min_level ? 0 : 1;
        const bLow = b.qty <= b.min_level ? 0 : 1;
        if (aLow !== bLow) return aLow - bLow;
        return a.product_name.localeCompare(b.product_name);
      });
  }, [stock.data, rawScope, search]);

  const multiLocation = rawScope.size > 1;

  return (
    <div className="space-y-4">
      {/* FILTR QATORI — search right-aligned + result count (DESIGN.md §9). */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-72">
            <Search
              className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Qidirish (lotin yoki kirill)…"
              aria-label="Mahsulot qidirish"
              className="pl-9 pr-9"
            />
            {search !== '' && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => setSearch('')}
                aria-label="Qidiruvni tozalash"
                className="absolute right-1.5 top-1.5 size-6 rounded-md text-muted-foreground"
              >
                <X className="size-4" />
              </Button>
            )}
          </div>
          <span className="text-sm text-muted-foreground tabular-nums">
            {rows.length} ta
          </span>
        </div>
      </div>

      <Card>
        <header className="flex items-center gap-2 border-b border-border/60 p-5">
          <Warehouse className="size-4 text-primary" aria-hidden="true" />
          <div className="space-y-0.5">
            <h2 className="text-base font-semibold">Ombor qoldig‘i</h2>
            <p className="text-xs text-muted-foreground">
              Homashyo omboridagi mavjud mahsulotlar.
            </p>
          </div>
        </header>

        {stock.isLoading && <LoadingState />}
        {!stock.isLoading && stock.error && (
          <ErrorState message={stock.error} onRetry={stock.refetch} />
        )}
        {!stock.isLoading && !stock.error && rows.length === 0 && (
          <EmptyState
            message={
              search === ''
                ? 'Qoldiq ma’lumotlari topilmadi.'
                : 'Bu shart bo‘yicha mahsulot yo‘q.'
            }
          />
        )}
        {!stock.isLoading && !stock.error && rows.length > 0 && (
          <div className="scrollbar-thin overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Mahsulot</TableHead>
                  {multiLocation && <TableHead>Ombor</TableHead>}
                  <TableHead className="text-right">Qoldiq</TableHead>
                  <TableHead className="text-right">Min</TableHead>
                  <TableHead className="text-right">Max</TableHead>
                  <TableHead>Holat</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const status = statusOf(row);
                  return (
                    <TableRow key={`${row.location_id}-${row.product_id}`}>
                      <TableCell className="font-medium">
                        {row.product_name}
                      </TableCell>
                      {multiLocation && (
                        <TableCell className="text-muted-foreground">
                          {locationNameById.get(row.location_id) ??
                            `#${row.location_id}`}
                        </TableCell>
                      )}
                      <TableCell
                        className={cn(
                          'text-right tabular-nums',
                          row.qty <= 0
                            ? 'font-semibold text-destructive'
                            : row.qty <= row.min_level &&
                                'font-medium text-warning',
                        )}
                      >
                        {formatQtyUnit(row.qty, row.product_unit)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {formatQtyUnit(row.min_level, row.product_unit)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {formatQtyUnit(row.max_level, row.product_unit)}
                      </TableCell>
                      <TableCell>
                        <Badge variant={status.variant}>{status.label}</Badge>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>
    </div>
  );
}
