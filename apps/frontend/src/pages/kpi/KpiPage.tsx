import { useMemo, useState } from 'react';
import { Pencil, Wallet, Boxes, Calculator, Coins, TrendingUp } from 'lucide-react';
import { Card } from '@/components/ui/card';
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
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from '@/components/PageState';
import { useApiQuery } from '@/hooks/useApiQuery';
import { formatPlainNumber, todayIso } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { KpiProductRow, KpiProductsResponse } from '@/lib/types';
import {
  ProductMoneyDialog,
  type ProductMoneyTarget,
} from './ProductMoneyDialog';
import { SalaryDialog } from './SalaryDialog';

/** Current month as `YYYY-MM` (local timezone). */
function currentMonth(): string {
  return todayIso().slice(0, 7);
}

/**
 * Money display for the KPI table/strip — whole so'm with space grouping
 * ("1 000 000"), no suffix; `null`/non-finite → em-dash.
 */
function money(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—';
  }
  return formatPlainNumber(value);
}

/** One summary metric in the top strip. */
function SummaryCard({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Wallet;
  label: string;
  value: string;
}) {
  return (
    <Card className="flex items-center gap-3 p-4">
      <span
        className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary"
        aria-hidden="true"
      >
        <Icon className="size-5" />
      </span>
      <div className="min-w-0">
        <p className="truncate text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
        <p className="truncate text-2xl font-semibold tabular-nums tracking-tight">{value}</p>
      </div>
    </Card>
  );
}

/**
 * KPI / tan-narx page — PM (boshliq) only.
 *
 * Shows, for the selected month, every finished product's full per-unit
 * cost (xom-ashyo + komunal + oylik) against its monthly sales and
 * profit, so the boss can set selling prices. The komunal and KPI maqsad
 * are edited inline per row; the salary input opens from the header.
 */
export function KpiPage() {
  const [month, setMonth] = useState<string>(currentMonth());
  const [salaryOpen, setSalaryOpen] = useState(false);
  const [editingTarget, setEditingTarget] =
    useState<ProductMoneyTarget | null>(null);
  const [editingKomunal, setEditingKomunal] =
    useState<ProductMoneyTarget | null>(null);

  const kpi = useApiQuery<KpiProductsResponse>(
    `/api/kpi/products?month=${month}`,
  );

  const totals = kpi.data?.totals;
  const products = useMemo(() => kpi.data?.products ?? [], [kpi.data]);

  // Money totals across every product row (the boss wants the monthly totals,
  // not just per-product). Profit sums only the rows where it is known.
  const revenueTotal = useMemo(
    () => products.reduce((sum, p) => sum + p.revenue, 0),
    [products],
  );
  const profitTotal = useMemo(
    () => products.reduce((sum, p) => sum + (p.profit ?? 0), 0),
    [products],
  );

  return (
    <div className="mx-auto max-w-[120rem] space-y-6">
      <PageHeader
        title="KPI — tan-narx va foyda"
        description="Har bir mahsulotning to‘liq tan-narxi (xom-ashyo + komunal + oylik) va sotuvga nisbatan foydasi. Sotuv narxlarini boshqarish uchun."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="month"
              value={month}
              max={currentMonth()}
              onChange={(e) => setMonth(e.target.value || currentMonth())}
              aria-label="Oyni tanlash"
              className="w-[10.5rem]"
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => setSalaryOpen(true)}
            >
              <Wallet className="size-4" aria-hidden="true" />
              Oyliklar
            </Button>
          </div>
        }
      />

      {/* Summary strip — monthly salary totals + per-unit share. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <SummaryCard
          icon={Coins}
          label="Sotuv jami (so‘m)"
          value={products.length > 0 ? money(revenueTotal) : '—'}
        />
        <SummaryCard
          icon={TrendingUp}
          label="Foyda jami (so‘m)"
          value={products.length > 0 ? money(profitTotal) : '—'}
        />
        <SummaryCard
          icon={Wallet}
          label="Oylik (maosh) jami"
          value={money(totals?.salary)}
        />
        <SummaryCard
          icon={Boxes}
          label="Oyda ishlab chiqarilgan (dona)"
          value={totals ? formatPlainNumber(totals.units_produced) : '—'}
        />
        <SummaryCard
          icon={Calculator}
          label="1 donaga oylik ulush"
          value={money(totals?.salary_per_unit)}
        />
      </div>

      <Card className="p-0">
        {kpi.isLoading && <LoadingState />}
        {!kpi.isLoading && kpi.error && (
          <ErrorState message={kpi.error} onRetry={kpi.refetch} />
        )}
        {!kpi.isLoading && !kpi.error && products.length === 0 && (
          <EmptyState message="Bu oy uchun ma’lumot topilmadi." />
        )}

        {!kpi.isLoading && !kpi.error && products.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Mahsulot</TableHead>
                <TableHead className="text-right">Xom-ashyo</TableHead>
                <TableHead className="text-right">Komunal</TableHead>
                <TableHead className="text-right">Oylik</TableHead>
                <TableHead className="text-right">To‘liq tan-narx</TableHead>
                <TableHead className="text-right">Sotuv (dona)</TableHead>
                <TableHead className="text-right">Sotuv (so‘m)</TableHead>
                <TableHead className="text-right">Foyda</TableHead>
                <TableHead className="text-right">KPI maqsad</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {products.map((p) => (
                <TableRow key={p.product_id}>
                  <TableCell className="font-medium">{p.name}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {money(p.material_cost)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    <span className="inline-flex items-center justify-end gap-1.5">
                      {money(p.komunal_per_unit)}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7 text-muted-foreground hover:text-foreground"
                        onClick={() => setEditingKomunal(toTarget(p, p.komunal_per_unit))}
                        aria-label={`${p.name} uchun komunalni tahrirlash`}
                      >
                        <Pencil className="size-3.5" aria-hidden="true" />
                      </Button>
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {money(p.salary_per_unit)}
                  </TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">
                    {money(p.full_cost)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatPlainNumber(p.units_sold)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {money(p.revenue)}
                  </TableCell>
                  <TableCell
                    className={cn(
                      'text-right font-semibold tabular-nums',
                      p.profit != null &&
                        p.profit > 0 &&
                        'text-success',
                      p.profit != null && p.profit < 0 && 'text-destructive',
                    )}
                  >
                    {money(p.profit)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    <span className="inline-flex items-center justify-end gap-1.5">
                      {money(p.kpi_target)}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7 text-muted-foreground hover:text-foreground"
                        onClick={() => setEditingTarget(toTarget(p, p.kpi_target))}
                        aria-label={`${p.name} uchun KPI maqsadni tahrirlash`}
                      >
                        <Pencil className="size-3.5" aria-hidden="true" />
                      </Button>
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <SalaryDialog
        open={salaryOpen}
        onOpenChange={setSalaryOpen}
        onChanged={kpi.refetch}
      />
      <ProductMoneyDialog
        target={editingKomunal}
        onOpenChange={(open) => {
          if (!open) setEditingKomunal(null);
        }}
        onSaved={kpi.refetch}
        title="Komunal"
        description="{name} uchun 1 donaga komunal xarajatni belgilang. Bo‘sh qoldirsangiz olib tashlanadi."
        fieldLabel="Komunal (so‘m)"
        endpoint={(id) => `/api/products/${id}/komunal`}
        bodyKey="komunal_per_unit"
        successMessage="Komunal saqlandi."
        inputId="komunal-input"
      />
      <ProductMoneyDialog
        target={editingTarget}
        onOpenChange={(open) => {
          if (!open) setEditingTarget(null);
        }}
        onSaved={kpi.refetch}
        title="KPI maqsad"
        description="{name} uchun oylik foyda maqsadini belgilang. Bo‘sh qoldirsangiz maqsad olib tashlanadi."
        fieldLabel="Maqsad (so‘m)"
        endpoint={(id) => `/api/products/${id}/kpi-target`}
        bodyKey="kpi_target"
        successMessage="KPI maqsad saqlandi."
        inputId="kpi-target-input"
      />
    </div>
  );
}

/** Build a `ProductMoneyTarget` from a KPI row + the field's current value. */
function toTarget(
  row: KpiProductRow,
  value: number | null,
): ProductMoneyTarget {
  return { product_id: row.product_id, name: row.name, value };
}
