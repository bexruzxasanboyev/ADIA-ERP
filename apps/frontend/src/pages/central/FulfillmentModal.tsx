import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Loader2, PackageCheck, Store } from 'lucide-react';
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
import { useToast } from '@/components/ui/toast';
import { fulfillRequest } from '@/lib/replenishmentActions';
import { formatQty } from '@/lib/format';
import { UNIT_LABELS } from '@/lib/labels';
import type { ReplenishmentRequest } from '@/lib/types';

/**
 * Markaziy sklad — "Qabul qilish" PARTIAL-FULFILMENT modal (owner's corrected
 * single-flow logic).
 *
 * A store order (one or more product lines) awaits the manager in «Kutuvda».
 * For each line the modal shows three numbers:
 *   - So'ralgan      — `qty_needed` the store asked for.
 *   - Markaz mavjud  — what central holds on hand (`availableByProduct`).
 *   - Jo'natiladigan — auto-filled to `min(needed, available)`, an EDITABLE
 *                      NumberInput capped at `available` (can't ship more than
 *                      we hold).
 *
 * "Yuborish" posts `POST /api/replenishment/:id/fulfill { ship_qty, note }`
 * per line. On success the parent refetches: the shipped part leaves «Kutuvda»
 * → «Yuborilgan», and any shortfall → «So'ralgan» (an auto production request).
 * Submit is disabled while in flight so a burst can't double-ship.
 */
interface FulfillmentModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The store order's lines (one batch / one legacy single). */
  lines: ReplenishmentRequest[];
  /** Central on-hand qty keyed by `product_id` (for "Markaz mavjud"). */
  availableByProduct: Map<number, number>;
  /** The acting central warehouse id — required by the fulfil endpoint. */
  centralId: number;
  /** Refetch the request list + central stock after a successful fulfilment. */
  onDone: () => void;
}

/** Per-line editable ship qty, keyed by request id. */
type ShipDraft = Record<number, number | null>;

export function FulfillmentModal({
  open,
  onOpenChange,
  lines,
  availableByProduct,
  centralId,
  onDone,
}: FulfillmentModalProps) {
  const { notify } = useToast();
  const [draft, setDraft] = useState<ShipDraft>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const storeName = lines[0]?.requester_location_name ?? 'do‘kon';

  // Auto-fill each line's ship qty to min(needed, available) on open. Capped at
  // available so the suggestion is always shippable.
  useEffect(() => {
    if (!open) return;
    const next: ShipDraft = {};
    for (const line of lines) {
      const avail = availableByProduct.get(line.product_id) ?? 0;
      next[line.id] = Math.min(line.qty_needed, avail);
    }
    setDraft(next);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, lines]);

  // Per-line caps + whether anything is shippable at all.
  const rows = useMemo(
    () =>
      lines.map((line) => {
        const available = availableByProduct.get(line.product_id) ?? 0;
        const ship = draft[line.id] ?? 0;
        const shortfall = Math.max(0, line.qty_needed - ship);
        return { line, available, ship, shortfall };
      }),
    [lines, availableByProduct, draft],
  );

  const totalShip = rows.reduce((sum, r) => sum + r.ship, 0);
  const totalShortfall = rows.reduce((sum, r) => sum + r.shortfall, 0);
  // At least one line must ship a positive qty — fulfilling 0 across the board
  // is a no-op the manager should not be able to submit.
  const canSubmit = !submitting && totalShip > 0;

  /** Clamp a line's ship qty to [0, available] on entry. */
  function setShip(lineId: number, productId: number, next: number | null) {
    const cap = availableByProduct.get(productId) ?? 0;
    setDraft((prev) => ({
      ...prev,
      [lineId]: next != null && next > cap ? cap : next,
    }));
  }

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    let ok = 0;
    const failed: number[] = [];
    // Sequential so the backend's stock decrements never interleave.
    for (const { line, ship } of rows) {
      if (ship <= 0) continue; // nothing to ship for this line — skip.
      try {
        await fulfillRequest(line.id, { location_id: centralId, ship_qty: ship });
        ok += 1;
      } catch {
        failed.push(line.id);
      }
    }
    setSubmitting(false);

    if (ok === 0) {
      setError('Jo‘natib bo‘lmadi. Qaytadan urinib ko‘ring.');
      return;
    }
    // Clear, owner-requested toast: shipped part → store, shortfall → production.
    const parts = [`${ok} ta mahsulot do‘konga jo‘natildi`];
    if (totalShortfall > 0) parts.push('yetishmagani ishlab chiqarishga yuborildi');
    if (failed.length > 0) {
      parts.push(`${failed.length} tasida xato (#${failed.join(', #')})`);
    }
    notify(failed.length > 0 ? 'error' : 'success', `${parts.join(', ')}.`);
    onOpenChange(false);
    onDone();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Store className="size-4 text-primary" aria-hidden="true" />
            Qabul qilish — {storeName}
          </DialogTitle>
          <DialogDescription>
            Borini do‘konga jo‘nating; yetishmagan qism avtomatik ishlab
            chiqarishga so‘rov bo‘lib o‘tadi. «Jo‘natiladigan» soni markazdagi
            mavjud miqdordan oshmaydi.
          </DialogDescription>
        </DialogHeader>

        <div className="scrollbar-thin max-h-[55vh] space-y-3 overflow-y-auto">
          {rows.map(({ line, available, shortfall }) => {
            const unit = UNIT_LABELS[line.product_unit];
            return (
              <div
                key={line.id}
                className="rounded-lg border border-border/60 bg-surface-3 p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="min-w-0 text-sm font-semibold leading-tight">
                    {line.product_name}
                  </p>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    #{line.id}
                  </span>
                </div>

                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <Stat label="So‘ralgan">
                    {formatQty(line.qty_needed)} {unit}
                  </Stat>
                  <Stat
                    label="Markaz mavjud"
                    tone={available <= 0 ? 'danger' : undefined}
                  >
                    {formatQty(available)} {unit}
                  </Stat>
                  <div className="space-y-1">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Jo‘natiladigan
                    </p>
                    <div className="flex items-center gap-1.5">
                      <NumberInput
                        decimals
                        min={0}
                        max={available}
                        value={draft[line.id] ?? null}
                        onValueChange={(next) =>
                          setShip(line.id, line.product_id, next)
                        }
                        placeholder="0"
                        aria-label={`${line.product_name} jo‘natiladigan soni`}
                        disabled={submitting || available <= 0}
                        className="h-8"
                      />
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {unit}
                      </span>
                    </div>
                  </div>
                </div>

                {shortfall > 0 && (
                  <p className="mt-2 text-xs text-warning">
                    Yetishmaydi: {formatQty(shortfall)} {unit} — ishlab
                    chiqarishga so‘rov bo‘ladi.
                  </p>
                )}
              </div>
            );
          })}
        </div>

        {/* Footer summary — what ships now vs. what is routed to production. */}
        <div className="rounded-lg border border-border/60 bg-surface-3 px-3 py-2 text-xs">
          <span className="text-muted-foreground">Jami jo‘natiladigan: </span>
          <span className="font-medium tabular-nums">
            {formatQty(totalShip)}
          </span>
          {totalShortfall > 0 && (
            <>
              <span className="mx-2 text-border">·</span>
              <span className="text-muted-foreground">
                Ishlab chiqarishga:{' '}
              </span>
              <span className="font-medium tabular-nums text-warning">
                {formatQty(totalShortfall)}
              </span>
            </>
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

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Bekor qilish
          </Button>
          <Button type="button" onClick={handleSubmit} disabled={!canSubmit}>
            {submitting ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <PackageCheck className="size-4" aria-hidden="true" />
            )}
            Yuborish
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A small labelled stat cell inside a fulfilment line. */
function Stat({
  label,
  tone,
  children,
}: {
  label: string;
  tone?: 'danger';
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p
        className={
          tone === 'danger'
            ? 'text-sm font-medium tabular-nums text-destructive'
            : 'text-sm font-medium tabular-nums'
        }
      >
        {children}
      </p>
    </div>
  );
}
