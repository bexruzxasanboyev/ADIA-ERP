import { useEffect, useState } from 'react';
import { Factory, Loader2, Send, Store } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { NumberInput } from '@/components/ui/number-input';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api-client';
import { requestCentralProduction } from '@/lib/replenishmentActions';
import {
  batchSuccessMessage,
  submitStoreRequestBatch,
} from '@/pages/stores/storeRequestSubmit';
import { defaultBasketQty } from '@/pages/stores/storeBasket';
import { formatQtyUnit } from '@/lib/format';
import { UNIT_LABELS } from '@/lib/labels';
import type { StockRow } from '@/lib/types';
import type { CentralStoreOption } from './centralStores';

/**
 * Markaziy sklad — Mahsulotlar kartalaridagi to'g'ridan-to'g'ri amallar
 * (owner feedback: act directly per product, no detour through the basket).
 *
 *   - {@link ShipToStoreDialog}      — markaziy qoldiqdan bitta do'konga
 *     bitta mahsulot jo'natish (qty ≤ markaziy qoldiq).
 *   - {@link SendToProductionDialog} — markaziy skladning O'Z qoldig'ini
 *     ishlab chiqarishdan to'ldirish (production so'rovi + routing).
 *
 * Ikkalasi ham kichik, bitta-mahsulotli modal; muvaffaqiyatdan so'ng `onDone`
 * stock query'ni qayta yuklaydi, shunda karta darhol yangilanadi.
 */

interface ShipToStoreDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The product/stock row being shipped (`null` when closed). */
  row: StockRow | null;
  /** Downstream stores the central warehouse may ship to. */
  storeOptions: CentralStoreOption[];
  /** Refetch the stock query after a successful ship. */
  onDone: () => void;
}

/**
 * "Do'konga yuborish" — pick a destination store + qty (default = refill
 * suggestion, capped at central on-hand), then POST a single-line batch with
 * `requester_location_id = <store id>`.
 */
export function ShipToStoreDialog({
  open,
  onOpenChange,
  row,
  storeOptions,
  onDone,
}: ShipToStoreDialogProps) {
  const { notify } = useToast();
  const [storeId, setStoreId] = useState<number | null>(null);
  const [qty, setQty] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset every time the dialog opens for a (possibly different) product. The
  // default qty is the refill-to-max suggestion, capped at central on-hand —
  // we can never ship more than we hold.
  useEffect(() => {
    if (open && row) {
      const suggested = Math.min(defaultBasketQty(row), row.qty);
      setStoreId(null);
      setQty(suggested > 0 ? suggested : 1);
      setError(null);
    }
  }, [open, row]);

  if (!row) return null;

  const onHand = row.qty;
  const noStores = storeOptions.length === 0;
  const overStock = qty != null && qty > onHand;
  const invalid =
    storeId === null || qty == null || qty <= 0 || overStock || noStores;

  async function handleConfirm() {
    if (!row || invalid || storeId === null || qty == null) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await submitStoreRequestBatch({
        requester_location_id: storeId,
        items: [{ product_id: row.product_id, qty_needed: qty }],
        note: 'Markaziy skladdan do‘konga',
      });
      const storeName =
        storeOptions.find((s) => s.id === storeId)?.name ?? 'do‘kon';
      notify('success', `${batchSuccessMessage(res, 1)} (${storeName}).`);
      onOpenChange(false);
      onDone();
    } catch (err: unknown) {
      setError(
        err instanceof ApiError ? err.message : 'Do‘konga jo‘natib bo‘lmadi.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Store className="size-4 text-primary" aria-hidden="true" />
            Do‘konga yuborish
          </DialogTitle>
          <DialogDescription>
            «{row.product_name}» — markaziy qoldiqdan tanlangan do‘konga
            jo‘natish.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <p className="text-xs text-muted-foreground tabular-nums">
            Markaziy qoldiq:{' '}
            <span className="font-medium text-foreground">
              {formatQtyUnit(onHand, row.product_unit)}
            </span>
          </p>

          <div className="space-y-1.5">
            <Label htmlFor="ship-store" className="text-xs">
              Qabul qiluvchi do‘kon
            </Label>
            <Select
              id="ship-store"
              value={storeId === null ? '' : String(storeId)}
              onChange={(e) =>
                setStoreId(e.target.value === '' ? null : Number(e.target.value))
              }
              disabled={submitting || noStores}
            >
              <option value="">— Do‘konni tanlang —</option>
              {storeOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
            {noStores && (
              <p className="text-xs text-muted-foreground">
                Do‘konlar ro‘yxati hozircha bo‘sh.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ship-qty" className="text-xs">
              Soni
            </Label>
            <div className="flex items-center gap-2">
              <NumberInput
                id="ship-qty"
                decimals
                min={0}
                value={qty}
                onValueChange={setQty}
                placeholder="0"
                aria-label={`${row.product_name} soni`}
                disabled={submitting}
                className="h-9"
              />
              <span className="shrink-0 text-xs text-muted-foreground">
                {UNIT_LABELS[row.product_unit]}
              </span>
            </div>
            {overStock && (
              <p className="text-xs text-destructive">
                Markaziy qoldiqdan ko‘p — eng ko‘pi{' '}
                {formatQtyUnit(onHand, row.product_unit)}.
              </p>
            )}
          </div>

          {error && (
            <p
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              role="alert"
            >
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Bekor qilish
          </Button>
          <Button type="button" onClick={handleConfirm} disabled={submitting || invalid}>
            {submitting ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Send className="size-4" aria-hidden="true" />
            )}
            Yuborish
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface SendToProductionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The product/stock row to replenish (`null` when closed). */
  row: StockRow | null;
  /** The scoped central warehouse id (requester of the production request). */
  centralId: number;
  /** Refetch the stock query after a successful route. */
  onDone: () => void;
}

/**
 * "Ishlab chiqarishga yuborish" — replenishes the central's OWN stock from
 * production. Pick a qty (default = refill-to-max suggestion), then create a
 * production request and route it (CHECK_PRODUCTION_INPUT → PRODUCING). A still
 * open request for this product surfaces gracefully.
 */
export function SendToProductionDialog({
  open,
  onOpenChange,
  row,
  centralId,
  onDone,
}: SendToProductionDialogProps) {
  const { notify } = useToast();
  const [qty, setQty] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open && row) {
      setQty(defaultBasketQty(row));
      setError(null);
    }
  }, [open, row]);

  if (!row) return null;

  const invalid = qty == null || qty <= 0;

  async function handleConfirm() {
    if (!row || invalid || qty == null) return;
    setSubmitting(true);
    setError(null);
    try {
      await requestCentralProduction(centralId, row.product_id, qty);
      notify(
        'success',
        `«${row.product_name}» ishlab chiqarishga yuborildi — So‘rovlar › Chiqgan’da kuzating.`,
      );
      onOpenChange(false);
      onDone();
    } catch (err: unknown) {
      if (err instanceof ApiError && err.code === 'OPEN_REQUEST_EXISTS') {
        setError('Bu mahsulot uchun ochiq so‘rov allaqachon bor.');
      } else {
        setError(
          err instanceof ApiError
            ? err.message
            : 'Ishlab chiqarishga yuborib bo‘lmadi.',
        );
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Factory className="size-4 text-primary" aria-hidden="true" />
            Ishlab chiqarishga yuborish
          </DialogTitle>
          <DialogDescription>
            «{row.product_name}» — markaziy skladning o‘z qoldig‘ini ishlab
            chiqarishdan to‘ldirish.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <p className="text-xs text-muted-foreground tabular-nums">
            Markaziy qoldiq:{' '}
            <span className="font-medium text-foreground">
              {formatQtyUnit(row.qty, row.product_unit)}
            </span>
            {row.max_level > 0 && (
              <>
                {' · '}Maks:{' '}
                {formatQtyUnit(row.max_level, row.product_unit)}
              </>
            )}
          </p>

          <div className="space-y-1.5">
            <Label htmlFor="prod-qty" className="text-xs">
              Soni
            </Label>
            <div className="flex items-center gap-2">
              <NumberInput
                id="prod-qty"
                decimals
                min={0}
                value={qty}
                onValueChange={setQty}
                placeholder="0"
                aria-label={`${row.product_name} soni`}
                disabled={submitting}
                className="h-9"
              />
              <span className="shrink-0 text-xs text-muted-foreground">
                {UNIT_LABELS[row.product_unit]}
              </span>
            </div>
          </div>

          {error && (
            <p
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              role="alert"
            >
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Bekor qilish
          </Button>
          <Button type="button" onClick={handleConfirm} disabled={submitting || invalid}>
            {submitting ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Factory className="size-4" aria-hidden="true" />
            )}
            Yuborish
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
