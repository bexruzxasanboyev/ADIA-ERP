import { useMemo, useState } from 'react';
import { Settings2 } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { NumberInput } from '@/components/ui/number-input';
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
import { useToast } from '@/components/ui/toast';
import { apiRequest, ApiError } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { formatQty, todayIso } from '@/lib/format';
import { INVENTORY_LABELS, formatWholePiece } from '@/lib/labels';
import type {
  InventoryCount,
  InventoryEndOfDayItem,
  InventoryEndOfDayResponse,
  Location,
} from '@/lib/types';
import { CoefficientDialog } from './CoefficientDialog';

/**
 * TZ Module 11 — «Inventarizatsiya» (bo'lak ↔ butun konverteri).
 *
 * Cakes are sold by WEIGHT. Each cake product carries two coefficients —
 * `weight_per_whole` (kg of a whole cake) and `pieces_per_whole` (slices per
 * whole) — so the system can decompose on-hand kg into "{whole} butun +
 * {pieces} bo'lak (+ remnant kg)". The store then enters a physical end-of-day
 * count (whole / pieces / remnant kg); the page computes the counted qty and
 * the diff vs the system figure, and POSTs it to reconcile stock.
 *
 * RBAC:
 *   - store_manager → their own store (backend RBAC-scopes; no picker).
 *   - pm / production_manager → a store picker; the PM/production_manager also
 *     gets the per-product «Koeffitsiyent» editor.
 *
 * Backend contract (built in parallel to this exact shape):
 *   GET   /api/inventory/end-of-day?location_id=&date=YYYY-MM-DD
 *   POST  /api/inventory/count { location_id, product_id, count_date,
 *                                counted_whole, counted_pieces, counted_remnant_kg }
 *   PATCH /api/products/:id/whole-piece { weight_per_whole, pieces_per_whole }
 *         (pm / production_manager)
 *   Store picker: GET /api/locations (filtered to type === 'store').
 */
export function InventoryPage() {
  const { user } = useAuth();
  // Both the PM and the production manager get the store picker + the
  // coefficient editor (TZ Module 11 — coefficients are set by pm /
  // production_manager). A scoped store_manager is pinned to their own store.
  const canPickStore =
    user?.role === 'pm' || user?.role === 'production_manager';
  const canEditCoefficients = canPickStore;

  const [storeId, setStoreId] = useState<string>('');
  const [date, setDate] = useState<string>(() => todayIso());

  // PM / production_manager store picker. The backend RBAC-scopes the
  // end-of-day list, so a scoped store manager never needs (or sees) it.
  const locations = useApiQuery<Location[]>(canPickStore ? '/api/locations' : null);
  const storeOptions = useMemo(
    () => (locations.data ?? []).filter((l) => l.type === 'store'),
    [locations.data],
  );

  // A store-picking principal must choose a store before we fetch; a scoped
  // store manager fetches immediately (the backend resolves their store).
  const queryPath = useMemo(() => {
    if (canPickStore && storeId === '') return null;
    const params = new URLSearchParams();
    if (storeId !== '') params.set('location_id', storeId);
    params.set('date', date);
    return `/api/inventory/end-of-day?${params.toString()}`;
  }, [canPickStore, storeId, date]);

  const { data, isLoading, error, refetch } =
    useApiQuery<InventoryEndOfDayResponse>(queryPath);

  const items = data?.items ?? [];
  // The effective location id used in POST bodies — the picked store for a
  // PM/production_manager, or the location the backend resolved for the row.
  const effectiveLocationId =
    storeId !== '' ? Number(storeId) : (data?.location_id ?? null);

  // Coefficient editor target (pm / production_manager only).
  const [coeffTarget, setCoeffTarget] = useState<InventoryEndOfDayItem | null>(
    null,
  );

  return (
    <div className="mx-auto max-w-[120rem] space-y-6">
      <PageHeader
        title={INVENTORY_LABELS.title}
        description={INVENTORY_LABELS.description}
        actions={
          canPickStore && (
            <Badge
              variant="secondary"
              className="h-10 items-center px-3"
              aria-label="Butun zanjir ko‘rinishi"
            >
              Butun zanjir
            </Badge>
          )
        }
      />

      {/* Filters: Do'kon (PM / ishlab chiqarish boshlig'i) · Sana. */}
      <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:gap-4">
        {canPickStore && (
          <div className="space-y-1">
            <Label htmlFor="inventory-store">Do‘kon</Label>
            <Select
              id="inventory-store"
              className="w-full sm:w-64"
              value={storeId}
              onChange={(e) => setStoreId(e.target.value)}
            >
              <option value="">Do‘konni tanlang…</option>
              {storeOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </div>
        )}
        <div className="space-y-1">
          <Label htmlFor="inventory-date">Sana</Label>
          <Input
            id="inventory-date"
            type="date"
            className="w-full sm:w-44"
            value={date}
            max={todayIso()}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
      </div>

      <Card>
        {/* A store-picking principal who has not yet chosen a store. */}
        {canPickStore && storeId === '' && (
          <EmptyState message="Inventarizatsiyani ko‘rish uchun do‘konni tanlang." />
        )}
        {queryPath !== null && isLoading && <LoadingState />}
        {queryPath !== null && !isLoading && error && (
          <ErrorState message={error} onRetry={refetch} />
        )}
        {queryPath !== null && !isLoading && !error && items.length === 0 && (
          <EmptyState message="Mahsulot yo‘q / koeffitsiyent o‘rnatilmagan." />
        )}
        {queryPath !== null && !isLoading && !error && items.length > 0 && (
          <div className="scrollbar-thin overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Mahsulot</TableHead>
                  <TableHead className="text-right">
                    {INVENTORY_LABELS.system}
                  </TableHead>
                  <TableHead>{INVENTORY_LABELS.counted}</TableHead>
                  <TableHead className="text-right">
                    {INVENTORY_LABELS.whole}
                  </TableHead>
                  <TableHead className="text-right">
                    {INVENTORY_LABELS.piece}
                  </TableHead>
                  <TableHead className="text-right">
                    {INVENTORY_LABELS.remnant}
                  </TableHead>
                  <TableHead className="text-right">Solishtirish</TableHead>
                  {canEditCoefficients && (
                    <TableHead className="text-right">
                      <span className="sr-only">Koeffitsiyent</span>
                    </TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <InventoryRow
                    key={item.product_id}
                    item={item}
                    locationId={effectiveLocationId}
                    countDate={date}
                    canEditCoefficients={canEditCoefficients}
                    onEditCoefficients={() => setCoeffTarget(item)}
                    onSubmitted={refetch}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>

      {canEditCoefficients && (
        <CoefficientDialog
          target={coeffTarget}
          onOpenChange={(open) => {
            if (!open) setCoeffTarget(null);
          }}
          onSaved={refetch}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// InventoryRow — one cake product. Shows the SYSTEM decomposition, three
// physical-count NumberInputs, a local "Solishtirish" that computes the
// counted qty + the colored diff, and "Tasdiqlash" which POSTs the count.
// ---------------------------------------------------------------------------

interface InventoryRowProps {
  item: InventoryEndOfDayItem;
  /** Effective store id for the POST body; `null` blocks submission. */
  locationId: number | null;
  countDate: string;
  canEditCoefficients: boolean;
  onEditCoefficients: () => void;
  /** Re-fetch the end-of-day table after a successful count. */
  onSubmitted: () => void;
}

function InventoryRow({
  item,
  locationId,
  countDate,
  canEditCoefficients,
  onEditCoefficients,
  onSubmitted,
}: InventoryRowProps) {
  const { notify } = useToast();

  const hasCoefficients =
    item.weight_per_whole !== null &&
    item.weight_per_whole > 0 &&
    item.pieces_per_whole !== null &&
    item.pieces_per_whole > 0;

  // Physical-count inputs (null = blank). All formatted NumberInputs.
  const [countedWhole, setCountedWhole] = useState<number | null>(null);
  const [countedPieces, setCountedPieces] = useState<number | null>(null);
  const [countedRemnant, setCountedRemnant] = useState<number | null>(null);

  // Locally computed comparison ({ counted_qty, diff }) shown after the user
  // presses "Solishtirish"; the persisted diff after a successful "Tasdiqlash".
  const [compared, setCompared] = useState<{
    countedQty: number;
    diff: number;
  } | null>(null);
  const [savedDiff, setSavedDiff] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  // counted_qty (kg) = whole·weight + (pieces / pieces_per_whole)·weight + remnant.
  function computeCountedQty(): number | null {
    if (!hasCoefficients) return null;
    const weight = item.weight_per_whole as number;
    const perWhole = item.pieces_per_whole as number;
    const whole = countedWhole ?? 0;
    const pieces = countedPieces ?? 0;
    const remnant = countedRemnant ?? 0;
    return whole * weight + (pieces / perWhole) * weight + remnant;
  }

  function handleCompare() {
    const countedQty = computeCountedQty();
    if (countedQty === null) return;
    setSavedDiff(null);
    setCompared({ countedQty, diff: countedQty - item.system_qty });
  }

  async function handleSubmit() {
    if (locationId === null || !hasCoefficients) return;
    setSaving(true);
    try {
      const result = await apiRequest<InventoryCount>('/api/inventory/count', {
        method: 'POST',
        body: {
          location_id: locationId,
          product_id: item.product_id,
          count_date: countDate,
          counted_whole: countedWhole ?? 0,
          counted_pieces: countedPieces ?? 0,
          counted_remnant_kg: countedRemnant ?? 0,
        },
      });
      setSavedDiff(result.diff_qty);
      setCompared(null);
      notify('success', 'Inventarizatsiya saqlandi.');
      onSubmitted();
    } catch (err: unknown) {
      notify(
        'error',
        err instanceof ApiError ? err.message : 'Saqlashda xatolik yuz berdi.',
      );
    } finally {
      setSaving(false);
    }
  }

  const inputId = `inv-${item.product_id}`;

  return (
    <TableRow>
      {/* Mahsulot — name + a coefficient hint when unconfigured. */}
      <TableCell className="align-top">
        <div className="flex flex-col gap-1">
          <span className="font-medium">{item.name}</span>
          {!hasCoefficients && (
            <Badge variant="warning" className="w-fit">
              {INVENTORY_LABELS.coefficientNeeded}
            </Badge>
          )}
        </div>
      </TableCell>

      {/* Tizimda — on-hand kg. */}
      <TableCell className="text-right align-top tabular-nums">
        {formatQty(item.system_qty)} kg
      </TableCell>

      {/* Hisoblangan — system decomposition "{whole} butun + {pieces} bo'lak". */}
      <TableCell className="align-top text-muted-foreground">
        {hasCoefficients
          ? formatWholePiece(item.whole, item.pieces, item.remnant_kg)
          : '—'}
      </TableCell>

      {/* Physical count: Butun / Bo'lak / Qoldiq kg (all formatted). */}
      <TableCell className="align-top">
        <NumberInput
          aria-label={`${item.name} — ${INVENTORY_LABELS.whole}`}
          id={`${inputId}-whole`}
          className="w-24 text-right"
          value={countedWhole}
          onValueChange={setCountedWhole}
          disabled={!hasCoefficients}
          placeholder="0"
        />
      </TableCell>
      <TableCell className="align-top">
        <NumberInput
          aria-label={`${item.name} — ${INVENTORY_LABELS.piece}`}
          id={`${inputId}-pieces`}
          className="w-24 text-right"
          value={countedPieces}
          onValueChange={setCountedPieces}
          disabled={!hasCoefficients}
          placeholder="0"
        />
      </TableCell>
      <TableCell className="align-top">
        <NumberInput
          aria-label={`${item.name} — ${INVENTORY_LABELS.remnant}`}
          id={`${inputId}-remnant`}
          className="w-24 text-right"
          value={countedRemnant}
          onValueChange={setCountedRemnant}
          decimals
          disabled={!hasCoefficients}
          placeholder="0"
        />
      </TableCell>

      {/* Solishtirish — local compute + diff (colored) + Tasdiqlash. */}
      <TableCell className="align-top">
        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleCompare}
              disabled={!hasCoefficients}
            >
              Solishtirish
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={handleSubmit}
              disabled={!hasCoefficients || locationId === null || saving}
            >
              {saving ? 'Saqlanmoqda…' : 'Tasdiqlash'}
            </Button>
          </div>

          {/* Locally computed comparison (pre-submit). */}
          {compared !== null && (
            <div className="flex flex-col items-end gap-0.5 text-xs leading-tight">
              <span className="tabular-nums text-muted-foreground">
                Hisoblangan: {formatQty(compared.countedQty)} kg
              </span>
              <DiffLine diff={compared.diff} />
            </div>
          )}

          {/* Persisted diff after a successful Tasdiqlash. */}
          {savedDiff !== null && (
            <div className="flex flex-col items-end gap-0.5 text-xs leading-tight">
              <span className="text-success">Saqlandi</span>
              <DiffLine diff={savedDiff} />
            </div>
          )}
        </div>
      </TableCell>

      {/* Koeffitsiyent editor (pm / production_manager only). */}
      {canEditCoefficients && (
        <TableCell className="align-top text-right">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onEditCoefficients}
          >
            <Settings2 className="size-4" aria-hidden="true" />
            {INVENTORY_LABELS.coefficientButton}
          </Button>
        </TableCell>
      )}
    </TableRow>
  );
}

/**
 * Signed diff line (kg) — negative (shortage) red, positive (surplus) amber,
 * exact match neutral. Mirrors the colored-diff convention on the kassa
 * reconciliation page.
 */
function DiffLine({ diff }: { diff: number }) {
  const rounded = Math.round(diff * 1000) / 1000;
  const tone =
    rounded < 0
      ? 'text-destructive'
      : rounded > 0
        ? 'text-warning'
        : 'text-muted-foreground';
  const sign = rounded > 0 ? '+' : rounded < 0 ? '−' : '';
  return (
    <span className={cn('font-medium tabular-nums', tone)}>
      Farq: {sign}
      {formatQty(Math.abs(rounded))} kg
    </span>
  );
}
