import { useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Loader2, RotateCcw, Send, ShoppingCart, Trash2 } from 'lucide-react';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { NumberInput } from '@/components/ui/number-input';
import { UNIT_LABELS } from '@/lib/labels';
import { formatQty } from '@/lib/format';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { cn } from '@/lib/utils';
import {
  basketTotals,
  hasStockContext,
  refillQty,
  type BasketItem,
} from './storeBasket';

/**
 * Savat — the store_manager's right-side slide-over basket (owner feedback:
 * the old two-tab "Shakllangan so'rov" table was clunky; this is a modern,
 * B2B-ordering-style review + submit panel).
 *
 * Pure presentation over the page-level basket state — every handler
 * (`setQty`, `stepQty`, `removeItem`, `clear`, `confirm`) is owned by
 * `StoreWorkflowPage` so the submit/validation logic stays in one place.
 * The panel closes itself on a successful confirm (the page clears the basket).
 */
interface StoreBasketPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: BasketItem[];
  count: number;
  submitting: boolean;
  /** null when several stores are selected (PM) — submit is disabled. */
  singleStoreId: number | null;
  setQty: (productId: number, qty: number) => void;
  stepQty: (productId: number, delta: number) => void;
  removeItem: (productId: number) => void;
  clear: () => void;
  /** Posts the basket; resolves when the request settles (success or error). */
  confirm: () => Promise<void>;
  /** Empty-state CTA — jump to the Mahsulotlar tab (and close the panel). */
  onGoToProducts: () => void;
}

export function StoreBasketPanel({
  open,
  onOpenChange,
  items,
  count,
  submitting,
  singleStoreId,
  setQty,
  stepQty,
  removeItem,
  clear,
  confirm,
  onGoToProducts,
}: StoreBasketPanelProps) {
  const reducedMotion = usePrefersReducedMotion();
  const totals = basketTotals(items);
  const isEmpty = count === 0;
  const noStoreSelected = singleStoreId === null;
  const allZero = items.every((i) => i.qty <= 0);

  async function handleConfirm() {
    const before = count;
    await confirm();
    // `confirm` clears the basket only on success; close the panel then so the
    // store_manager sees the toast over the page, not a now-empty panel.
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
              Markaziy skladdan to‘ldirish so‘rovi
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
                Mahsulotlar bo‘limidan kerakli tovarlarni qo‘shing — bu yerda
                so‘rovni shakllantirasiz.
              </p>
              <Button variant="outline" onClick={onGoToProducts}>
                Mahsulotlarga o‘tish
              </Button>
            </div>
          ) : (
            <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
              {items.map((item) => (
                <BasketLineCard
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
            <footer className="shrink-0 space-y-2 border-t border-border/60 bg-surface-2 px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
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
                disabled={submitting || allZero || noStoreSelected}
              >
                {submitting ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Send className="size-4" aria-hidden="true" />
                )}
                Tasdiqlash va yuborish ({totals.count})
              </Button>
              {noStoreSelected && (
                <p className="text-xs text-muted-foreground">
                  Yuborish uchun bitta do‘kon tanlang.
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

interface BasketLineCardProps {
  item: BasketItem;
  reducedMotion: boolean;
  disabled: boolean;
  setQty: (productId: number, qty: number) => void;
  stepQty: (productId: number, delta: number) => void;
  removeItem: (productId: number) => void;
}

function BasketLineCard({
  item,
  reducedMotion,
  disabled,
  setQty,
  stepQty,
  removeItem,
}: BasketLineCardProps) {
  // Local fade-out on remove (the page actually drops the line once the
  // transition would have played). Robust + simple — no height collapse.
  const [leaving, setLeaving] = useState(false);
  const belowMin =
    item.min_level > 0 && item.current_qty <= item.min_level;
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
      {/* Row 1 — name + status */}
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 flex-1 truncate text-sm font-semibold leading-tight">
          {item.product_name}
        </p>
        <span className="shrink-0">
          <BasketStatusPill belowMin={belowMin} qty={item.current_qty} />
        </span>
      </div>

      {/* Row 2 — B2B meta line */}
      {showMeta && (
        <p className="text-xs text-muted-foreground tabular-nums">
          Qoldiq{' '}
          <span className={cn(belowMin && 'font-medium text-destructive')}>
            {formatQty(item.current_qty)} {unitLabel}
          </span>{' '}
          · min {formatQty(item.min_level)} · maks {formatQty(item.max_level)}
        </p>
      )}

      {/* Row 3 — stepper + unit + refill + remove */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex h-9 items-center rounded-md border border-input bg-surface-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => stepQty(item.product_id, -1)}
            disabled={disabled || item.qty <= 1}
            aria-label={`${item.product_name} sonini kamaytirish`}
            className="rounded-none rounded-l-md text-muted-foreground hover:text-foreground"
          >
            −
          </Button>
          <NumberInput
            decimals
            value={item.qty}
            disabled={disabled}
            onValueChange={(v) => setQty(item.product_id, v ?? Number.NaN)}
            aria-label={`${item.product_name} soni`}
            className="h-9 w-12 rounded-none border-y-0 bg-transparent px-0 text-center text-sm font-semibold tabular-nums"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => stepQty(item.product_id, 1)}
            disabled={disabled}
            aria-label={`${item.product_name} sonini oshirish`}
            className="rounded-none rounded-r-md text-muted-foreground hover:text-foreground"
          >
            +
          </Button>
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

/** Minimal stock-status pill mirroring the page's StockStatusPill heuristic. */
function BasketStatusPill({ belowMin, qty }: { belowMin: boolean; qty: number }) {
  if (qty <= 0) return <Badge variant="danger">Tugagan</Badge>;
  if (belowMin) return <Badge variant="danger">Min’dan past</Badge>;
  return <Badge variant="success">Yetarli</Badge>;
}
