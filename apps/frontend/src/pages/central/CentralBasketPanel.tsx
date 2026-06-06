import { useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Loader2, RotateCcw, Send, ShoppingCart, Store, Trash2 } from 'lucide-react';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { UNIT_LABELS } from '@/lib/labels';
import { formatQty } from '@/lib/format';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { cn } from '@/lib/utils';
import {
  basketTotals,
  hasStockContext,
  refillQty,
  type BasketItem,
} from '@/pages/stores/storeBasket';
import type { CentralStoreOption } from './centralStores';

/**
 * Markaziy sklad — "Do'konga yuborish" savat (owner feedback #15).
 *
 * Reuses the store basket model (`BasketItem`, `basketTotals`, `refillQty`) and
 * the store panel's B2B line layout, but adds a DESTINATION store picker: the
 * central warehouse ships the chosen finished goods to the selected downstream
 * store. Confirm posts a batch with `requester_location_id = <store id>`.
 *
 * Pure presentation over page-owned basket state; every handler lives in
 * `CentralWorkflowPage` so the submit/validation logic stays in one place.
 */
interface CentralBasketPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: BasketItem[];
  count: number;
  submitting: boolean;
  /** Downstream stores the manager may ship to (from incoming requests). */
  storeOptions: CentralStoreOption[];
  /** Selected destination store id (`null` until one is picked). */
  storeId: number | null;
  onStoreChange: (storeId: number | null) => void;
  setQty: (productId: number, qty: number) => void;
  stepQty: (productId: number, delta: number) => void;
  removeItem: (productId: number) => void;
  clear: () => void;
  /** Posts the basket; resolves when the request settles (success or error). */
  confirm: () => Promise<void>;
  /** Empty-state CTA — jump to the Mahsulotlar tab (and close the panel). */
  onGoToProducts: () => void;
}

export function CentralBasketPanel({
  open,
  onOpenChange,
  items,
  count,
  submitting,
  storeOptions,
  storeId,
  onStoreChange,
  setQty,
  stepQty,
  removeItem,
  clear,
  confirm,
  onGoToProducts,
}: CentralBasketPanelProps) {
  const reducedMotion = usePrefersReducedMotion();
  const totals = basketTotals(items);
  const isEmpty = count === 0;
  const noStorePicked = storeId === null;
  const noStoresAvailable = storeOptions.length === 0;
  const allZero = items.every((i) => i.qty <= 0);

  async function handleConfirm() {
    const before = count;
    await confirm();
    // `confirm` clears the basket only on success; close then so the manager
    // sees the toast over the page, not a now-empty panel.
    if (before > 0) onOpenChange(false);
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-[clamp(420px,38vw,540px)] bg-surface-2 text-foreground p-0"
      >
        <div className="flex h-full flex-col">
          {/* Header */}
          <header className="shrink-0 border-b border-border/60 px-5 py-4">
            <DialogPrimitive.Title className="flex items-center gap-2 text-base font-semibold">
              <ShoppingCart className="size-5 text-primary" aria-hidden="true" />
              Savat
              <Badge variant="secondary" className="tabular-nums">
                {count}
              </Badge>
            </DialogPrimitive.Title>
            <DialogPrimitive.Description className="mt-0.5 text-xs text-muted-foreground">
              Tanlangan tayyor mahsulotlarni do‘konga jo‘natish
            </DialogPrimitive.Description>
          </header>

          {/* Scroll area */}
          {isEmpty ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center">
              <ShoppingCart
                className="size-10 text-muted-foreground/40"
                aria-hidden="true"
              />
              <p className="text-sm font-medium">Savat bo‘sh</p>
              <p className="max-w-[36ch] text-sm text-muted-foreground">
                Mahsulotlar bo‘limidan jo‘natiladigan tovarlarni qo‘shing — bu
                yerda do‘kon tanlab yuborasiz.
              </p>
              <Button variant="outline" onClick={onGoToProducts}>
                Mahsulotlarga o‘tish
              </Button>
            </div>
          ) : (
            <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
              {items.map((item) => (
                <CentralBasketLineCard
                  key={item.product_id}
                  item={item}
                  reducedMotion={reducedMotion}
                  disabled={submitting}
                  setQty={setQty}
                  stepQty={stepQty}
                  removeItem={removeItem}
                />
              ))}
            </div>
          )}

          {/* Footer — hidden when the basket is empty. */}
          {!isEmpty && (
            <footer className="shrink-0 space-y-3 border-t border-border/60 bg-surface-2 px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
              <div className="space-y-1.5">
                <Label
                  htmlFor="central-basket-store"
                  className="flex items-center gap-1.5 text-xs"
                >
                  <Store className="size-3.5 text-primary" aria-hidden="true" />
                  Qabul qiluvchi do‘kon
                </Label>
                <Select
                  id="central-basket-store"
                  value={storeId === null ? '' : String(storeId)}
                  onChange={(e) =>
                    onStoreChange(
                      e.target.value === '' ? null : Number(e.target.value),
                    )
                  }
                  disabled={submitting || noStoresAvailable}
                >
                  <option value="">— Do‘konni tanlang —</option>
                  {storeOptions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
                {noStoresAvailable && (
                  <p className="text-xs text-muted-foreground">
                    Do‘konlar ro‘yxati hozircha bo‘sh — do‘konlardan so‘rov
                    kelgach ular bu yerda paydo bo‘ladi.
                  </p>
                )}
              </div>

              <p className="text-sm text-muted-foreground tabular-nums">
                Jami: {totals.count} ta mahsulot
                {!totals.mixedUnits && totals.unit !== null && (
                  <>
                    {' · '}
                    {formatQty(totals.totalQty)} {UNIT_LABELS[totals.unit]}
                  </>
                )}
              </p>
              <Button
                className="h-11 w-full text-sm font-semibold"
                onClick={handleConfirm}
                disabled={submitting || allZero || noStorePicked}
              >
                {submitting ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Send className="size-4" aria-hidden="true" />
                )}
                Do‘konga yuborish ({totals.count})
              </Button>
              {noStorePicked && !noStoresAvailable && (
                <p className="text-xs text-muted-foreground">
                  Yuborish uchun qabul qiluvchi do‘konni tanlang.
                </p>
              )}
              <Button
                variant="ghost"
                className="h-9 w-full text-muted-foreground hover:text-foreground"
                onClick={clear}
                disabled={submitting}
              >
                Savatni tozalash
              </Button>
            </footer>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

interface CentralBasketLineCardProps {
  item: BasketItem;
  reducedMotion: boolean;
  disabled: boolean;
  setQty: (productId: number, qty: number) => void;
  stepQty: (productId: number, delta: number) => void;
  removeItem: (productId: number) => void;
}

function CentralBasketLineCard({
  item,
  reducedMotion,
  disabled,
  setQty,
  stepQty,
  removeItem,
}: CentralBasketLineCardProps) {
  const [leaving, setLeaving] = useState(false);
  const belowMin = item.min_level > 0 && item.current_qty <= item.min_level;
  const showMeta = hasStockContext(item);
  const refill = refillQty(item);
  const showRefill = item.qty !== refill;

  function handleRemove() {
    if (reducedMotion) {
      removeItem(item.product_id);
      return;
    }
    setLeaving(true);
    window.setTimeout(() => removeItem(item.product_id), 150);
  }

  const unitLabel = UNIT_LABELS[item.product_unit];

  return (
    <div
      className={cn(
        'space-y-2.5 rounded-lg border border-border/60 bg-surface-3 p-3.5 transition-colors',
        belowMin && 'border-destructive/30',
        !reducedMotion && 'transition-opacity duration-150',
        leaving && 'opacity-0',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 flex-1 truncate text-sm font-semibold leading-tight">
          {item.product_name}
        </p>
      </div>

      {showMeta && (
        <p className="text-xs text-muted-foreground tabular-nums">
          Markaziy qoldiq{' '}
          <span className={cn(belowMin && 'font-medium text-destructive')}>
            {formatQty(item.current_qty)} {unitLabel}
          </span>
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex h-9 items-center rounded-md border border-input bg-surface-2">
          <button
            type="button"
            onClick={() => stepQty(item.product_id, -1)}
            disabled={disabled || item.qty <= 1}
            aria-label={`${item.product_name} sonini kamaytirish`}
            className={cn(
              'grid h-9 w-9 place-items-center rounded-l-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40',
              !reducedMotion && 'active:scale-95',
            )}
          >
            −
          </button>
          <input
            type="text"
            inputMode="decimal"
            value={item.qty}
            disabled={disabled}
            onChange={(e) =>
              setQty(item.product_id, Number(e.target.value.replace(',', '.')))
            }
            aria-label={`${item.product_name} soni`}
            className="h-9 w-12 border-x border-input bg-transparent text-center text-sm font-semibold tabular-nums focus:bg-accent/40 focus:outline-none"
          />
          <button
            type="button"
            onClick={() => stepQty(item.product_id, 1)}
            disabled={disabled}
            aria-label={`${item.product_name} sonini oshirish`}
            className={cn(
              'grid h-9 w-9 place-items-center rounded-r-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40',
              !reducedMotion && 'active:scale-95',
            )}
          >
            +
          </button>
        </div>

        <span className="text-xs text-muted-foreground">{unitLabel}</span>

        {showRefill && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-primary"
            onClick={() => setQty(item.product_id, refill)}
            disabled={disabled}
          >
            <RotateCcw className="size-3.5" aria-hidden="true" />
            To‘ldirish: {formatQty(refill)}
          </Button>
        )}

        <Button
          variant="ghost"
          size="icon"
          className="ml-auto size-8 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          onClick={handleRemove}
          disabled={disabled}
          aria-label={`${item.product_name} ni savatdan olib tashlash`}
        >
          <Trash2 className="size-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
