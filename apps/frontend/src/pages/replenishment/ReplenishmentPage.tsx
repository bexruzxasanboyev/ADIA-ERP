import { useState } from 'react';
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
import { MobileCardList } from '@/components/ui/table-mobile';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from '@/components/PageState';
import { ViewToggle, useViewMode } from '@/components/ViewToggle';
import { useApiQuery } from '@/hooks/useApiQuery';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { formatDateTime, formatQty } from '@/lib/format';
import {
  REPLENISHMENT_STATUS_LABELS,
  REPLENISHMENT_STATUS_OPTIONS,
  REPLENISHMENT_STATUS_VARIANT,
} from '@/lib/labels';
import type {
  ReplenishmentRequest,
  ReplenishmentStatus,
} from '@/lib/types';

/**
 * M4 — replenishment list screen.
 * `GET /api/replenishment?status=` returns a bare `ReplenishmentRequest[]`
 * (RBAC-scoped by the backend). F4.10 removed manual creation — the
 * replenishment engine raises requests automatically; managers only
 * advance / cancel them. The boshliq sees the list read-only.
 */
export function ReplenishmentPage() {
  const bp = useBreakpoint();
  const showMobileCards = bp === 'xs';
  const [status, setStatus] = useState<ReplenishmentStatus | ''>('');
  const [view, setView] = useViewMode('replenishment', 'card');

  const path =
    status === ''
      ? '/api/replenishment'
      : `/api/replenishment?status=${status}`;

  const { data, isLoading, error, refetch } =
    useApiQuery<ReplenishmentRequest[]>(path);

  const rows = data ?? [];

  return (
    <div className="mx-auto max-w-[120rem] space-y-6">
      <PageHeader
        title="To‘ldirish so‘rovlari"
        description="Avtomatik to‘ldirish tsikli va so‘rovlar holati."
        action={<ViewToggle value={view} onChange={setView} />}
      />

      <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:gap-4">
        <div className="space-y-1">
          <Label htmlFor="repl-status">Holat bo‘yicha</Label>
          <Select
            id="repl-status"
            className="w-full sm:w-64"
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
          <EmptyState message="So‘rovlar topilmadi." />
        )}
        {!isLoading && !error && rows.length > 0 && (showMobileCards || view === 'card') && (
          <div>
            {showMobileCards ? (
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
                    { label: 'Yaratilgan', value: formatDateTime(row.created_at) },
                  ],
                  footer: (
                    <Button variant="outline" size="sm" asChild className="w-full">
                      <Link to={`/replenishment/${row.id}`}>Ochish</Link>
                    </Button>
                  ),
                }))}
              />
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                {rows.map((row) => (
                  <div
                    key={row.id}
                    className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card/40 p-4 shadow-sm transition-colors hover:bg-card/70"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-xs text-muted-foreground">#{row.id}</p>
                        <p className="truncate text-sm font-semibold">
                          {row.product_name}
                        </p>
                      </div>
                      <Badge variant={REPLENISHMENT_STATUS_VARIANT[row.status]}>
                        {REPLENISHMENT_STATUS_LABELS[row.status]}
                      </Badge>
                    </div>
                    <dl className="space-y-1 text-xs">
                      <div className="flex justify-between">
                        <dt className="text-muted-foreground">Miqdor</dt>
                        <dd className="tabular-nums">
                          {formatQty(row.qty_needed)} {row.product_unit}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">So‘rovchi</dt>
                        <dd className="truncate text-right">
                          {row.requester_location_name}
                        </dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-muted-foreground">Yaratilgan</dt>
                        <dd className="text-right text-muted-foreground">
                          {formatDateTime(row.created_at)}
                        </dd>
                      </div>
                    </dl>
                    <Button
                      variant="outline"
                      size="sm"
                      asChild
                      className="w-full"
                    >
                      <Link to={`/replenishment/${row.id}`}>Ochish</Link>
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {!isLoading && !error && rows.length > 0 && !showMobileCards && view === 'table' && (
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
                      {formatQty(row.qty_needed)} {row.product_unit}
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
    </div>
  );
}
