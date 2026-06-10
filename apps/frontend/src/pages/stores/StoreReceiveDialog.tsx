import { useEffect, useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import type { FlowRequest } from '@/lib/replenishmentFlow';
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
  const [receivedQty, setReceivedQty] = useState<number | null>(null);
  const [brakQty, setBrakQty] = useState<number | null>(null);
  const [brakReason, setBrakReason] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pre-fill the received qty with what was actually SHIPPED (a partial
  // fulfilment ships less than asked — owner: "4 yuborgan edi, nega 10
  // chiqyapti?"); fall back to the requested amount on legacy rows without a
  // shipment movement. The cashier only edits on a shortfall/brak.
  useEffect(() => {
    if (open && request) {
      const shipped = (request as FlowRequest).shipped_qty;
      setReceivedQty(shipped != null && shipped > 0 ? shipped : request.qty_needed);
      setBrakQty(null);
      setBrakReason('');
      setError(null);
    }
  }, [open, request]);

  if (request === null) return null;

  const unit = UNIT_LABELS[request.product_unit];
  const brakValue = brakQty ?? 0;
  const showBrakReason = brakValue > 0;
  // The fixed budget is what PHYSICALLY shipped: yaroqli (received) + brak must
  // equal it (owner: "4 keldi, 2 brak bo'lsa qabul 2 bo'lishi kerak — do'konga
  // 2 qo'shiladi"). Entering a brak AUTO-REBALANCES the good qty down, and
  // raising the good qty squeezes brak — the pair can never exceed shipped.
  const shippedBudget =
    (request as FlowRequest).shipped_qty ?? request.qty_needed;
  // NO silent clamping (owner: "ko'p yozsam ham error bermayapti") — the
  // formatted NumberInput keeps showing whatever was typed, so a quiet
  // state-clamp HIDES the problem. Instead: a within-budget brak auto-balances
  // the good qty (4 keldi, brak 2 → qabul 2), an OVER-budget entry stays in
  // the field, paints the balance line red and BLOCKS Tasdiqlash.
  function handleBrakChange(next: number | null) {
    setBrakQty(next);
    if (next != null && next >= 0 && next <= shippedBudget) {
      setReceivedQty(shippedBudget - next);
    }
  }
  function handleReceivedChange(next: number | null) {
    setReceivedQty(next);
    if (
      next != null &&
      next >= 0 &&
      next <= shippedBudget &&
      brakValue > shippedBudget - next
    ) {
      setBrakQty(shippedBudget - next);
    }
  }
  const overBudget = (receivedQty ?? 0) + brakValue > shippedBudget;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (request === null) return;
    setError(null);

    const received = receivedQty ?? NaN;
    if (!Number.isFinite(received) || received < 0) {
      setError('Qabul qilingan soni 0 yoki undan katta bo‘lishi kerak.');
      return;
    }
    const brak = brakQty ?? 0;
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
          <div className="rounded-lg border border-border/60 bg-surface-3 p-3 text-sm">
            <p className="font-medium">
              #{request.id} · {request.product_name}
            </p>
            <p className="text-xs text-muted-foreground">
              {(request as FlowRequest).shipped_qty != null
                ? `Yuborilgan: ${formatQty((request as FlowRequest).shipped_qty as number)} ${unit} · So‘ralgan: ${formatQty(request.qty_needed)} ${unit}`
                : `So‘ralgan miqdor: ${formatQty(request.qty_needed)} ${unit}`}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="receive-qty">Qabul qilingan soni</Label>
            <div className="flex items-center gap-2">
              <NumberInput
                id="receive-qty"
                decimals
                min={0}
                value={receivedQty}
                onValueChange={handleReceivedChange}
                disabled={isSubmitting}
                required
              />
              <span className="shrink-0 text-xs text-muted-foreground">{unit}</span>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="receive-brak">Brak (yaroqsiz) soni</Label>
            <div className="flex items-center gap-2">
              <NumberInput
                id="receive-brak"
                decimals
                min={0}
                max={shippedBudget}
                value={brakQty}
                onValueChange={handleBrakChange}
                placeholder="0"
                disabled={isSubmitting}
              />
              <span className="shrink-0 text-xs text-muted-foreground">{unit}</span>
            </div>
            {/* Live balance line — the owner's rule made visible: yaroqli +
                brak = yuborilgan; over-budget turns red and blocks submit. */}
            {overBudget ? (
              <p className="text-xs text-destructive">
                Yaroqli {formatQty(receivedQty ?? 0)} + brak {formatQty(brakValue)}{' '}
                — yuborilgan {formatQty(shippedBudget)} {unit} dan oshib ketdi.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Yaroqli {formatQty(receivedQty ?? 0)} + brak {formatQty(brakValue)} ={' '}
                {formatQty(shippedBudget)} {unit} yuborilgan.
              </p>
            )}
          </div>

          {showBrakReason && (
            <div className="space-y-1.5">
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
              className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              role="alert"
            >
              {error}
            </p>
          )}
        </form>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            Bekor qilish
          </Button>
          <Button
            type="submit"
            form="store-receive-form"
            disabled={isSubmitting || overBudget}
          >
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
