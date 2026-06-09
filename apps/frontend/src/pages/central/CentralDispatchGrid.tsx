import { useEffect, useMemo, useState } from 'react';
import {
  Factory,
  Loader2,
  Send,
  Split,
  Store,
  Warehouse,
} from 'lucide-react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { NumberInput } from '@/components/ui/number-input';
import { useToast } from '@/components/ui/toast';
import { UNIT_LABELS } from '@/lib/labels';
import { formatQty } from '@/lib/format';
import { ApiError } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { requestCentralProduction } from '@/lib/replenishmentActions';
import {
  submitStoreRequestBatch,
  type BatchRequestItem,
} from '@/pages/stores/storeRequestSubmit';
import type { BasketItem } from '@/pages/stores/storeBasket';
import type { CentralStoreOption } from './centralStores';

/**
 * Markaziy sklad — ko'p-manzilli "tarqatish jadvali" (dispatch grid).
 *
 * Replaces the single-destination Savat (`CentralBasketPanel`): instead of
 * choosing ONE store and shipping a basket to it, the manager fills a GRID
 * where every product (row) can be split across MANY stores (columns) plus a
 * production column — the SAP Allocation Table / NetSuite DRP pattern.
 *
 *   rows    = the cart products (`BasketItem[]`)
 *   columns = each downstream store + «Ishlab chiqarish» + «Jami / Mavjud»
 *   cell    = a formatted NumberInput (qty, default 0)
 *
 * STOCK GUARD: the sum of a row's STORE cells must not exceed the central
 * on-hand (`item.current_qty`) — the row goes red when it does. The production
 * column does NOT draw from stock (it ASKS production to make more), so it is
 * excluded from the exceed check.
 *
 * On «Jo'natish» the grid mirrors the existing per-store batch flow, looped:
 *   - per store  → `submitStoreRequestBatch({ requester_location_id, items })`
 *   - per produced cell → `requestCentralProduction(centralId, product, qty)`
 * Every call's outcome is aggregated into ONE summary toast; per-call failures
 * are collected and surfaced (the dialog stays open so nothing is lost).
 *
 * The allocation matrix is this component's OWN internal state, seeded from
 * `items` (every cell defaults to 0) and reset whenever the dialog re-opens.
 */
interface CentralDispatchGridProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The products queued for dispatch (rows). */
  items: BasketItem[];
  /** Downstream stores the central warehouse may ship to (store columns). */
  stores: CentralStoreOption[];
  /** The scoped central warehouse id (requester of any production request). */
  centralId: number;
  /** Called once after a successful dispatch (e.g. clear cart + refetch). */
  onDone: () => void;
}

/** The production "column" is keyed apart from the numeric store ids. */
const PRODUCTION_KEY = 'production' as const;

/**
 * One product row's allocation: store id → qty, plus the production qty.
 * Stored as a string-keyed record so the numeric store ids and the
 * `production` sentinel coexist; values are `number` (0 = blank).
 */
type RowAllocation = Record<string, number>;

/** product_id → its per-destination allocation. */
type AllocationMatrix = Record<number, RowAllocation>;

/** Build an all-zero matrix for the given items (every cell defaults to 0). */
function emptyMatrix(items: BasketItem[]): AllocationMatrix {
  const matrix: AllocationMatrix = {};
  for (const item of items) matrix[item.product_id] = {};
  return matrix;
}

/** Read a cell (missing → 0). */
function cellValue(row: RowAllocation | undefined, key: string): number {
  const v = row?.[key];
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/** Sum of a row's STORE cells only (production excluded from the stock guard). */
function rowStoreTotal(
  row: RowAllocation | undefined,
  stores: CentralStoreOption[],
): number {
  let sum = 0;
  for (const s of stores) sum += cellValue(row, String(s.id));
  return sum;
}

/**
 * Split `available` equally across the given store ids, integer-floored, with
 * the rounding remainder handed to the earliest columns so the parts sum back
 * to `available`. Used by the per-row "Teng bo'l" action.
 */
function splitEqually(
  available: number,
  storeIds: number[],
): Record<string, number> {
  const out: Record<string, number> = {};
  const n = storeIds.length;
  if (n === 0 || available <= 0) return out;
  const base = Math.floor(available / n);
  let remainder = available - base * n;
  for (const id of storeIds) {
    out[String(id)] = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
  }
  return out;
}

export function CentralDispatchGrid({
  open,
  onOpenChange,
  items,
  stores,
  centralId,
  onDone,
}: CentralDispatchGridProps) {
  const { notify } = useToast();
  const [matrix, setMatrix] = useState<AllocationMatrix>(() =>
    emptyMatrix(items),
  );
  const [submitting, setSubmitting] = useState(false);

  // Re-seed the matrix whenever the dialog opens (fresh, all-zero) or the cart
  // composition changes while open — so a removed product never lingers and a
  // newly added one gets a row.
  useEffect(() => {
    if (open) setMatrix(emptyMatrix(items));
    // Re-seed only on open / item-set change (both are in the deps).
  }, [open, items]);

  const noStores = stores.length === 0;
  const hasProductionRow = items.length > 0;

  /** Set a single cell's value (clamped to >= 0). */
  function setCell(productId: number, key: string, value: number | null) {
    setMatrix((prev) => {
      const row = { ...(prev[productId] ?? {}) };
      const next = value != null && Number.isFinite(value) && value > 0 ? value : 0;
      if (next === 0) delete row[key];
      else row[key] = next;
      return { ...prev, [productId]: row };
    });
  }

  /**
   * Per-row "Teng bo'l": split the row's available central stock equally across
   * the stores that already carry a value; if none do, split across ALL stores.
   */
  function splitRow(item: BasketItem) {
    setMatrix((prev) => {
      const row = prev[item.product_id] ?? {};
      const valued = stores.filter((s) => cellValue(row, String(s.id)) > 0);
      const targets = (valued.length > 0 ? valued : stores).map((s) => s.id);
      const split = splitEqually(item.current_qty, targets);
      // Preserve the production cell; replace only the store cells.
      const nextRow: RowAllocation = {};
      const prod = cellValue(row, PRODUCTION_KEY);
      if (prod > 0) nextRow[PRODUCTION_KEY] = prod;
      for (const [k, v] of Object.entries(split)) if (v > 0) nextRow[k] = v;
      return { ...prev, [item.product_id]: nextRow };
    });
  }

  /**
   * Global "Fair-share": for EVERY row, pro-rata distribute the available
   * central stock across all stores (equal split). A one-press way to fill the
   * whole grid evenly; the manager then tweaks individual cells.
   */
  function fairShareAll() {
    setMatrix((prev) => {
      const next: AllocationMatrix = {};
      const storeIds = stores.map((s) => s.id);
      for (const item of items) {
        const row = prev[item.product_id] ?? {};
        const split = splitEqually(item.current_qty, storeIds);
        const nextRow: RowAllocation = {};
        const prod = cellValue(row, PRODUCTION_KEY);
        if (prod > 0) nextRow[PRODUCTION_KEY] = prod;
        for (const [k, v] of Object.entries(split)) if (v > 0) nextRow[k] = v;
        next[item.product_id] = nextRow;
      }
      return next;
    });
  }

  // Aggregate counters drive the footer summary + the disabled state.
  const summary = useMemo(() => {
    let storeUnits = 0;
    let prodUnits = 0;
    let anyExceeds = false;
    const perStore = new Map<number, number>();
    for (const item of items) {
      const row = matrix[item.product_id];
      const storeTotal = rowStoreTotal(row, stores);
      if (storeTotal > item.current_qty) anyExceeds = true;
      storeUnits += storeTotal;
      prodUnits += cellValue(row, PRODUCTION_KEY);
      for (const s of stores) {
        const v = cellValue(row, String(s.id));
        if (v > 0) perStore.set(s.id, (perStore.get(s.id) ?? 0) + v);
      }
    }
    return {
      storeUnits,
      prodUnits,
      anyExceeds,
      storeCount: perStore.size,
      hasAnything: storeUnits > 0 || prodUnits > 0,
    };
  }, [items, matrix, stores]);

  const disabled =
    submitting || !summary.hasAnything || summary.anyExceeds;

  async function handleDispatch() {
    if (disabled) return;
    setSubmitting(true);
    const failures: string[] = [];
    let storesSent = 0;
    let productionSent = 0;

    // 1) Per store: gather that store's cells (qty > 0) into one batch.
    for (const store of stores) {
      const batchItems: BatchRequestItem[] = [];
      for (const item of items) {
        const qty = cellValue(matrix[item.product_id], String(store.id));
        if (qty > 0) {
          batchItems.push({ product_id: item.product_id, qty_needed: qty });
        }
      }
      if (batchItems.length === 0) continue;
      try {
        await submitStoreRequestBatch({
          requester_location_id: store.id,
          items: batchItems,
          note: 'Markaziy skladdan do‘konga (tarqatish)',
        });
        storesSent += 1;
      } catch (err: unknown) {
        const reason =
          err instanceof ApiError ? err.message : 'noma’lum xato';
        failures.push(`${store.name}: ${reason}`);
      }
    }

    // 2) Per produced cell: one production request per product (qty > 0).
    for (const item of items) {
      const qty = cellValue(matrix[item.product_id], PRODUCTION_KEY);
      if (qty <= 0) continue;
      try {
        await requestCentralProduction(centralId, item.product_id, qty);
        productionSent += 1;
      } catch (err: unknown) {
        const reason =
          err instanceof ApiError && err.code === 'OPEN_REQUEST_EXISTS'
            ? 'ochiq so‘rov bor'
            : err instanceof ApiError
              ? err.message
              : 'noma’lum xato';
        failures.push(`Ishlab chiqarish — ${item.product_name}: ${reason}`);
      }
    }

    setSubmitting(false);

    const okParts: string[] = [];
    if (storesSent > 0) okParts.push(`${storesSent} do‘konga`);
    if (productionSent > 0) okParts.push('ishlab chiqarishga');

    if (failures.length === 0) {
      notify('success', `${okParts.join(' + ')} yuborildi.`);
      onDone();
      onOpenChange(false);
      return;
    }

    // Partial / full failure — keep the dialog open so nothing is lost.
    if (okParts.length > 0) {
      notify(
        'error',
        `${okParts.join(' + ')} yuborildi, ${failures.length} ta xato: ${failures.join('; ')}`,
      );
    } else {
      notify('error', `Yuborib bo‘lmadi — ${failures.join('; ')}`);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-[min(96vw,1100px)] bg-surface-2 text-foreground p-0"
      >
        <div className="flex h-full flex-col">
          {/* Header */}
          <header className="shrink-0 border-b border-border/60 px-5 py-4">
            <DialogPrimitive.Title className="flex items-center gap-2 text-base font-semibold">
              <Warehouse className="size-5 text-primary" aria-hidden="true" />
              Tarqatish jadvali
              <Badge variant="secondary" className="tabular-nums">
                {items.length}
              </Badge>
            </DialogPrimitive.Title>
            <DialogPrimitive.Description className="mt-0.5 text-xs text-muted-foreground">
              Har mahsulotni bir nechta do‘kon va ishlab chiqarish bo‘yicha
              taqsimlang. «Mavjud» — markaziy qoldiq; do‘kon ustunlari yig‘indisi
              undan oshmasligi kerak.
            </DialogPrimitive.Description>
          </header>

          {/* Body */}
          {items.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center">
              <Warehouse
                className="size-10 text-muted-foreground/40"
                aria-hidden="true"
              />
              <p className="text-sm font-medium">Jadval bo‘sh</p>
              <p className="max-w-[40ch] text-sm text-muted-foreground">
                Mahsulotlar bo‘limidan tarqatiladigan tovarlarni qo‘shing.
              </p>
            </div>
          ) : (
            <>
              {/* Toolbar — global fair-share. */}
              <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/40 px-4 py-2.5">
                <p className="text-xs text-muted-foreground">
                  {noStores
                    ? 'Do‘konlar ro‘yxati bo‘sh — faqat ishlab chiqarishga yuborish mumkin.'
                    : `${stores.length} ta do‘kon ustuni`}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={fairShareAll}
                  disabled={submitting || noStores}
                  title="Har mahsulotning mavjud qoldig‘ini barcha do‘konlarga teng taqsimlash"
                >
                  <Split className="size-3.5" aria-hidden="true" />
                  Teng taqsimlash
                </Button>
              </div>

              {/* Grid — horizontal scroll when many store columns. */}
              <div className="flex-1 overflow-auto px-4 py-4">
                <table className="w-full border-separate border-spacing-0 text-sm">
                  <thead>
                    <tr className="text-left">
                      <th
                        scope="col"
                        className="sticky left-0 z-20 min-w-[180px] border-b border-border/60 bg-surface-2 px-2 py-2 text-xs font-medium text-muted-foreground"
                      >
                        Mahsulot
                      </th>
                      {stores.map((s) => (
                        <th
                          key={s.id}
                          scope="col"
                          className="min-w-[112px] border-b border-border/60 bg-surface-2 px-2 py-2 text-xs font-medium"
                        >
                          <span className="flex items-center gap-1 text-foreground">
                            <Store
                              className="size-3 text-primary"
                              aria-hidden="true"
                            />
                            <span className="truncate" title={s.name}>
                              {s.name}
                            </span>
                          </span>
                        </th>
                      ))}
                      {hasProductionRow && (
                        <th
                          scope="col"
                          className="min-w-[120px] border-b border-border/60 bg-surface-2 px-2 py-2 text-xs font-medium"
                        >
                          <span className="flex items-center gap-1 text-foreground">
                            <Factory
                              className="size-3 text-primary"
                              aria-hidden="true"
                            />
                            Ishlab chiqarish
                          </span>
                        </th>
                      )}
                      <th
                        scope="col"
                        className="sticky right-0 z-20 min-w-[120px] border-b border-l border-border/60 bg-surface-2 px-2 py-2 text-right text-xs font-medium text-muted-foreground"
                      >
                        Jami / Mavjud
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => {
                      const row = matrix[item.product_id];
                      const storeTotal = rowStoreTotal(row, stores);
                      const exceeds = storeTotal > item.current_qty;
                      const unitLabel = UNIT_LABELS[item.product_unit];
                      return (
                        <tr key={item.product_id} className="group">
                          {/* Product name (sticky left). */}
                          <th
                            scope="row"
                            className="sticky left-0 z-10 border-b border-border/40 bg-surface-2 px-2 py-2 text-left align-top font-normal"
                          >
                            <span className="block max-w-[200px] truncate text-sm font-medium text-foreground">
                              {item.product_name}
                            </span>
                            <span className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                              <button
                                type="button"
                                onClick={() => splitRow(item)}
                                disabled={submitting || noStores}
                                className={cn(
                                  'inline-flex items-center gap-1 rounded px-1 py-0.5 text-primary hover:bg-primary/10 disabled:opacity-40',
                                )}
                                title="Mavjud qoldiqni do‘konlar bo‘yicha teng bo‘lish"
                              >
                                <Split className="size-3" aria-hidden="true" />
                                Teng bo‘l
                              </button>
                            </span>
                          </th>

                          {/* Store cells. */}
                          {stores.map((s) => (
                            <td
                              key={s.id}
                              className="border-b border-border/40 px-1.5 py-1.5 align-top"
                            >
                              <NumberInput
                                decimals
                                min={0}
                                value={cellValue(row, String(s.id)) || ''}
                                onValueChange={(v) =>
                                  setCell(item.product_id, String(s.id), v)
                                }
                                placeholder="0"
                                aria-label={`${item.product_name} — ${s.name} uchun soni`}
                                disabled={submitting}
                                className={cn(
                                  'h-9 text-right tabular-nums',
                                  exceeds &&
                                    'border-destructive/60 focus-visible:ring-destructive',
                                )}
                              />
                            </td>
                          ))}

                          {/* Production cell (excluded from the stock guard). */}
                          {hasProductionRow && (
                            <td className="border-b border-border/40 px-1.5 py-1.5 align-top">
                              <NumberInput
                                decimals
                                min={0}
                                value={cellValue(row, PRODUCTION_KEY) || ''}
                                onValueChange={(v) =>
                                  setCell(item.product_id, PRODUCTION_KEY, v)
                                }
                                placeholder="0"
                                aria-label={`${item.product_name} — ishlab chiqarishga soni`}
                                disabled={submitting}
                                className="h-9 text-right tabular-nums"
                              />
                            </td>
                          )}

                          {/* Jami / Mavjud (sticky right) — red when exceeded. */}
                          <td
                            className={cn(
                              'sticky right-0 z-10 border-b border-l border-border/40 bg-surface-2 px-2 py-2 text-right align-top tabular-nums',
                            )}
                          >
                            <span
                              className={cn(
                                'block text-sm font-semibold',
                                exceeds
                                  ? 'text-destructive'
                                  : 'text-foreground',
                              )}
                            >
                              {formatQty(storeTotal)}
                            </span>
                            <span className="block text-[11px] text-muted-foreground">
                              / {formatQty(item.current_qty)} {unitLabel}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Footer */}
              <footer className="shrink-0 space-y-3 border-t border-border/60 bg-surface-2 px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground tabular-nums">
                  {summary.storeCount > 0 && (
                    <span className="flex items-center gap-1">
                      <Store
                        className="size-3.5 text-primary"
                        aria-hidden="true"
                      />
                      {summary.storeCount} do‘kon · {formatQty(summary.storeUnits)}
                    </span>
                  )}
                  {summary.prodUnits > 0 && (
                    <span className="flex items-center gap-1">
                      <Factory
                        className="size-3.5 text-primary"
                        aria-hidden="true"
                      />
                      Ishlab chiqarish · {formatQty(summary.prodUnits)}
                    </span>
                  )}
                  {!summary.hasAnything && <span>Hozircha hech narsa tanlanmadi.</span>}
                </div>

                {summary.anyExceeds && (
                  <p
                    className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
                    role="alert"
                  >
                    Ba’zi mahsulotlarda do‘kon yig‘indisi markaziy qoldiqdan oshib
                    ketdi — yuborishdan oldin tuzating.
                  </p>
                )}

                <Button
                  className="h-11 w-full text-sm font-semibold"
                  onClick={handleDispatch}
                  disabled={disabled}
                >
                  {submitting ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Send className="size-4" aria-hidden="true" />
                  )}
                  Jo‘natish
                </Button>
              </footer>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
