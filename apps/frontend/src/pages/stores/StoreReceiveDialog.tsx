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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { apiRequest, ApiError } from '@/lib/api-client';
import { formatQty } from '@/lib/format';
import { UNIT_LABELS } from '@/lib/labels';
import type { ReplenishmentRequest } from '@/lib/types';

/**
 * `POST /api/replenishment/:id/receive` request body (team-lead contract).
 * The store confirms how much physically arrived; `brak_qty` is the defective
 * portion and `brak_reason` documents why (required when brak > 0).
 */
interface ReceiveBody {
  received_qty: number;
  brak_qty: number;
  brak_reason: string | null;
}

interface StoreReceiveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The incoming request being received (null while closed). */
  request: ReplenishmentRequest | null;
  /** Refetch the request list after a successful receive. */
  onSaved: () => void;
}

/**
 * Do'kon ish joyi — "Qabul qilish" dialog for an incoming (shipped) request.
 *
 * Inputs: received qty, brak (defect) qty, and a defect reason that surfaces
 * only when brak > 0. Validates received ≥ 0, brak ≥ 0, brak ≤ received, and
 * a non-empty reason when brak > 0, before posting to the receive endpoint.
 */
export function StoreReceiveDialog({
  open,
  onOpenChange,
  request,
  onSaved,
}: StoreReceiveDialogProps) {
  const { notify } = useToast();
  const [receivedQty, setReceivedQty] = useState('');
  const [brakQty, setBrakQty] = useState('');
  const [brakReason, setBrakReason] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pre-fill the received qty with the requested amount on open — the common
  // case is the full shipment arrives; the cashier only edits on a shortfall.
  useEffect(() => {
    if (open && request) {
      setReceivedQty(String(request.qty_needed));
      setBrakQty('');
      setBrakReason('');
      setError(null);
    }
  }, [open, request]);

  if (request === null) return null;

  const unit = UNIT_LABELS[request.product_unit];
  const brakValue = Number(brakQty.replace(',', '.'));
  const showBrakReason = Number.isFinite(brakValue) && brakValue > 0;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (request === null) return;
    setError(null);

    const received = Number(receivedQty.replace(',', '.'));
    if (!Number.isFinite(received) || received < 0) {
      setError('Qabul qilingan soni 0 yoki undan katta bo‘lishi kerak.');
      return;
    }
    const brak = brakQty.trim() === '' ? 0 : Number(brakQty.replace(',', '.'));
    if (!Number.isFinite(brak) || brak < 0) {
      setError('Brak soni 0 yoki undan katta bo‘lishi kerak.');
      return;
    }
    if (brak > received) {
      setError('Brak soni qabul qilingan sonidan oshmasligi kerak.');
      return;
    }
    const trimmedReason = brakReason.trim();
    if (brak > 0 && trimmedReason === '') {
      setError('Brak bor — izohini kiriting.');
      return;
    }

    const body: ReceiveBody = {
      received_qty: received,
      brak_qty: brak,
      brak_reason: brak > 0 ? trimmedReason : null,
    };

    setIsSubmitting(true);
    try {
      await apiRequest(`/api/replenishment/${request.id}/receive`, {
        method: 'POST',
        body,
      });
      notify('success', 'Qabul qilindi.');
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
          <DialogTitle>Qabul qilish</DialogTitle>
          <DialogDescription>
            Yetib kelgan tovarni qabul qiling. Yaroqsiz (brak) qism bo‘lsa
            sonini va izohini ko‘rsating.
          </DialogDescription>
        </DialogHeader>

        <form id="store-receive-form" className="space-y-4" onSubmit={handleSubmit}>
          <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
            <p className="font-medium">
              #{request.id} · {request.product_name}
            </p>
            <p className="text-xs text-muted-foreground">
              So‘ralgan miqdor: {formatQty(request.qty_needed)} {unit}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="receive-qty">Qabul qilingan soni</Label>
            <div className="flex items-center gap-2">
              <Input
                id="receive-qty"
                type="number"
                inputMode="decimal"
                min="0"
                step="any"
                value={receivedQty}
                onChange={(e) => setReceivedQty(e.target.value)}
                disabled={isSubmitting}
                required
              />
              <span className="shrink-0 text-xs text-muted-foreground">{unit}</span>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="receive-brak">Brak (yaroqsiz) soni</Label>
            <div className="flex items-center gap-2">
              <Input
                id="receive-brak"
                type="number"
                inputMode="decimal"
                min="0"
                step="any"
                value={brakQty}
                onChange={(e) => setBrakQty(e.target.value)}
                placeholder="0"
                disabled={isSubmitting}
              />
              <span className="shrink-0 text-xs text-muted-foreground">{unit}</span>
            </div>
          </div>

          {showBrakReason && (
            <div className="space-y-2">
              <Label htmlFor="receive-brak-reason">Brak izohi</Label>
              <Textarea
                id="receive-brak-reason"
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
          <Button type="submit" form="store-receive-form" disabled={isSubmitting}>
            {isSubmitting && (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            )}
            Tasdiqlash
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
