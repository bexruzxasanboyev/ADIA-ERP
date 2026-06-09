import { useEffect, useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { NumberInput } from '@/components/ui/number-input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { apiRequest, ApiError } from '@/lib/api-client';
import { formatQty } from '@/lib/format';
import { UNIT_LABELS } from '@/lib/labels';
import type { PurchaseOrder } from '@/lib/types';

/**
 * `POST /api/purchase-orders/:id/receive` request body (team-lead contract).
 * The body is OPTIONAL on the wire — omitting it means a clean receipt
 * (`brak_qty = 0`). `brak_reason` is REQUIRED when `brak_qty > 0`; the server
 * returns 422 `VALIDATION_ERROR` when brak exceeds the order qty or the reason
 * is missing.
 */
interface ReceiveBody {
  brak_qty: number;
  brak_reason?: string;
}

interface PurchaseOrderReceiveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The `approved` purchase order being received (null while closed). */
  order: PurchaseOrder | null;
  /** Refetch the purchase-order list after a successful receive. */
  onSaved: () => void;
}

/**
 * Mahsulot ombori — "Qabul qilish — brak bilan" dialog for an `approved`
 * purchase order.
 *
 * On receipt the ordered raw material arrives at the warehouse; the sound
 * portion (`qty - brak`) is added to stock and any defective (brak) portion is
 * written off. Inputs: brak (defect) qty — defaults to 0, so a clean receipt is
 * one confirm away — and a defect reason that surfaces only when brak > 0.
 * Validates brak ≥ 0, brak ≤ order qty, and a non-empty reason when brak > 0,
 * before posting to the receive endpoint. Mirrors `StoreReceiveDialog` and
 * `ProductionReceiveDialog`.
 */
export function PurchaseOrderReceiveDialog({
  open,
  onOpenChange,
  order,
  onSaved,
}: PurchaseOrderReceiveDialogProps) {
  const { notify } = useToast();
  const [brakQty, setBrakQty] = useState<number | null>(null);
  const [brakReason, setBrakReason] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset on open — the common case is a clean receipt (no brak).
  useEffect(() => {
    if (open && order) {
      setBrakQty(null);
      setBrakReason('');
      setError(null);
    }
  }, [open, order]);

  if (order === null) return null;

  const unit = UNIT_LABELS[order.product_unit];
  const brakValue = brakQty ?? 0;
  const showBrakReason = brakValue > 0;
  // Brak can never exceed the ordered qty — the modal must not allow e.g.
  // 21M kg on a 3 kg order (owner bug). Clamp on entry so the field can't hold
  // an over-cap value; submit re-checks as a backstop.
  const brakMax = order.qty;
  function handleBrakChange(next: number | null) {
    if (next != null && next > brakMax) {
      setBrakQty(brakMax);
      return;
    }
    setBrakQty(next);
  }
  const brakOverMax = brakValue > brakMax;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (order === null) return;
    setError(null);

    const brak = brakQty ?? 0;
    if (!Number.isFinite(brak) || brak < 0) {
      setError('Brak soni 0 yoki undan katta bo‘lishi kerak.');
      return;
    }
    if (brak > order.qty) {
      setError('Brak soni buyurtma miqdoridan oshmasligi kerak.');
      return;
    }
    const trimmedReason = brakReason.trim();
    if (brak > 0 && trimmedReason === '') {
      setError('Brak bor — izohini kiriting.');
      return;
    }

    // Send a reason only when there is brak — the backend requires it then and
    // ignores it otherwise.
    const body: ReceiveBody = {
      brak_qty: brak,
      ...(brak > 0 ? { brak_reason: trimmedReason } : {}),
    };

    setIsSubmitting(true);
    try {
      await apiRequest(`/api/purchase-orders/${order.id}/receive`, {
        method: 'POST',
        body,
      });
      notify('success', 'So‘rov qabul qilindi, ombor qoldig‘i yangilandi.');
      onOpenChange(false);
      onSaved();
    } catch (err: unknown) {
      setError(
        err instanceof ApiError ? err.message : 'Qabul qilib bo‘lmadi.',
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Qabul qilish — brak bilan</DialogTitle>
          <DialogDescription>
            Yetib kelgan xom-ashyoni qabul qiling. Yaroqsiz (brak) qism bo‘lsa
            sonini va izohini ko‘rsating — brak qismi ombor qoldig‘iga
            qo‘shilmaydi.
          </DialogDescription>
        </DialogHeader>

        <form
          id="purchase-order-receive-form"
          className="space-y-4"
          onSubmit={handleSubmit}
        >
          <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
            <p className="font-medium">
              #{order.id} · {order.product_name}
            </p>
            <p className="text-xs text-muted-foreground">
              Buyurtma miqdori: {formatQty(order.qty)} {unit}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="purchase-order-receive-brak">
              Brak (yaroqsiz) soni
            </Label>
            <div className="flex items-center gap-2">
              <NumberInput
                id="purchase-order-receive-brak"
                decimals
                min={0}
                max={brakMax}
                value={brakQty}
                onValueChange={handleBrakChange}
                placeholder="0"
                disabled={isSubmitting}
              />
              <span className="shrink-0 text-xs text-muted-foreground">
                {unit}
              </span>
            </div>
            {brakOverMax && (
              <p className="text-xs text-destructive">
                Brak buyurtma miqdoridan oshmasligi kerak — eng ko‘pi{' '}
                {formatQty(brakMax)} {unit}.
              </p>
            )}
          </div>

          {showBrakReason && (
            <div className="space-y-2">
              <Label htmlFor="purchase-order-receive-brak-reason">
                Brak izohi
              </Label>
              <Textarea
                id="purchase-order-receive-brak-reason"
                value={brakReason}
                onChange={(e) => setBrakReason(e.target.value)}
                placeholder="Masalan: 2 kg buzilgan holda yetib keldi"
                maxLength={500}
                disabled={isSubmitting}
                required
              />
            </div>
          )}

          {error && (
            <p
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              role="alert"
            >
              {error}
            </p>
          )}
        </form>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            Bekor qilish
          </Button>
          <Button
            type="submit"
            form="purchase-order-receive-form"
            disabled={isSubmitting}
          >
            {isSubmitting && (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            )}
            Qabul qildim
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
