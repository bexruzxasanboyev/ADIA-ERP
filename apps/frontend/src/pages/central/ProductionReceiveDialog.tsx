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
import { ApiError } from '@/lib/api-client';
import { receiveFromProduction } from '@/lib/replenishmentActions';
import { formatQty } from '@/lib/format';
import { UNIT_LABELS } from '@/lib/labels';
import type { ReplenishmentRequest } from '@/lib/types';

interface ProductionReceiveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The DONE_TO_WAREHOUSE request being received (null while closed). */
  request: ReplenishmentRequest | null;
  /** Refetch the request list after a successful receive. */
  onSaved: () => void;
}

/**
 * Markaziy sklad — "Ishlab chiqarishdan qabul qilish" dialog.
 *
 * The produced goods are ALREADY physically at the central warehouse (the
 * `DONE_TO_WAREHOUSE` step put them there), so — unlike the store receive
 * dialog — there is no "received qty" to confirm: only the defective (brak)
 * portion the manager wants written off. `brak_reason` is required when
 * `brak_qty > 0`. Posts to `POST /api/replenishment/:id/receive-from-production`
 * via {@link receiveFromProduction}; on success the request advances to
 * `SHIP_TO_REQUESTER` and the "Do'konga yuborish" forward action unlocks.
 */
export function ProductionReceiveDialog({
  open,
  onOpenChange,
  request,
  onSaved,
}: ProductionReceiveDialogProps) {
  const { notify } = useToast();
  const [brakQty, setBrakQty] = useState<number | null>(null);
  const [brakReason, setBrakReason] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset on open — the common case is a clean receipt (no brak).
  useEffect(() => {
    if (open && request) {
      setBrakQty(null);
      setBrakReason('');
      setError(null);
    }
  }, [open, request]);

  if (request === null) return null;

  const unit = UNIT_LABELS[request.product_unit];
  const brakValue = brakQty ?? 0;
  const showBrakReason = brakValue > 0;
  // Brak can never exceed the produced (requested) qty — the modal must not
  // allow e.g. 21M kg on a 3 kg item (owner bug). Clamp on entry so the field
  // physically can't hold an over-cap value; submit re-checks as a backstop.
  const brakMax = request.qty_needed;
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
    if (request === null) return;
    setError(null);

    const brak = brakQty ?? 0;
    if (!Number.isFinite(brak) || brak < 0) {
      setError('Brak soni 0 yoki undan katta bo‘lishi kerak.');
      return;
    }
    if (brak > request.qty_needed) {
      setError('Brak soni so‘ralgan miqdordan oshmasligi kerak.');
      return;
    }
    const trimmedReason = brakReason.trim();
    if (brak > 0 && trimmedReason === '') {
      setError('Brak bor — izohini kiriting.');
      return;
    }

    setIsSubmitting(true);
    try {
      await receiveFromProduction(request.id, {
        brak_qty: brak,
        // Only send a reason when there is brak — the backend requires it then
        // and ignores it otherwise.
        ...(brak > 0 ? { brak_reason: trimmedReason } : {}),
      });
      notify('success', 'Ishlab chiqarishdan qabul qilindi.');
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
          <DialogTitle>Ishlab chiqarishdan qabul qilish</DialogTitle>
          <DialogDescription>
            Ishlab chiqarishdan kelgan tovar markaziy skladga tushdi. Yaroqsiz
            (brak) qism bo‘lsa sonini va izohini ko‘rsating.
          </DialogDescription>
        </DialogHeader>

        <form
          id="production-receive-form"
          className="space-y-4"
          onSubmit={handleSubmit}
        >
          <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
            <p className="font-medium">
              #{request.id} · {request.product_name}
            </p>
            <p className="text-xs text-muted-foreground">
              So‘ralgan miqdor: {formatQty(request.qty_needed)} {unit}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="production-receive-brak">Brak (yaroqsiz) soni</Label>
            <div className="flex items-center gap-2">
              <NumberInput
                id="production-receive-brak"
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
                Brak so‘ralgan miqdordan oshmasligi kerak — eng ko‘pi{' '}
                {formatQty(brakMax)} {unit}.
              </p>
            )}
          </div>

          {showBrakReason && (
            <div className="space-y-2">
              <Label htmlFor="production-receive-brak-reason">Brak izohi</Label>
              <Textarea
                id="production-receive-brak-reason"
                value={brakReason}
                onChange={(e) => setBrakReason(e.target.value)}
                placeholder="Masalan: 2 dona ezilgan holda yetib keldi"
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
            form="production-receive-form"
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
