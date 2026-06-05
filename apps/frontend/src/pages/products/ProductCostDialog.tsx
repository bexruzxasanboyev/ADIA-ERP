import { useEffect, useState } from 'react';
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
import { useToast } from '@/components/ui/toast';
import { apiRequest, ApiError } from '@/lib/api-client';
import { formatSom } from '@/lib/format';
import type { Product } from '@/lib/types';

/**
 * FEATURE A — edit a product's MANUAL per-unit cost (so'm).
 *
 * Only pm / production_manager mount this (the caller gates on role). The
 * input is pre-filled with the EFFECTIVE cost (`manual_cost_per_unit ??
 * cost_per_unit`). Saving PATCHes a positive number; "Poster narxiga
 * qaytarish" PATCHes `null`, clearing the override so the card falls back
 * to the Poster price.
 *
 * Endpoint: `PATCH /api/products/:id/cost` body `{ cost_per_unit: number>0 | null }`.
 */
export function ProductCostDialog({
  product,
  open,
  onOpenChange,
  onSaved,
}: {
  product: Product;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const { notify } = useToast();
  const hasManual = product.manual_cost_per_unit != null;
  const effective = product.manual_cost_per_unit ?? product.cost_per_unit ?? null;
  const posterCost = product.cost_per_unit ?? null;

  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  // Re-seed the input each time the dialog opens for a (possibly different)
  // product so a stale draft never bleeds across cards.
  useEffect(() => {
    if (open) {
      setDraft(effective != null ? String(effective) : '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, product.id]);

  async function patchCost(value: number | null) {
    setSaving(true);
    try {
      await apiRequest(`/api/products/${product.id}/cost`, {
        method: 'PATCH',
        body: { cost_per_unit: value },
      });
      notify(
        'success',
        value === null ? 'Poster narxiga qaytarildi.' : 'Narx saqlandi.',
      );
      onSaved();
      onOpenChange(false);
    } catch (err) {
      notify('error', err instanceof ApiError ? err.message : 'Saqlab bo‘lmadi.');
    } finally {
      setSaving(false);
    }
  }

  function save() {
    const n = Number(draft);
    if (!Number.isFinite(n) || n <= 0) {
      notify('error', 'Narx 0 dan katta son bo‘lishi kerak.');
      return;
    }
    void patchCost(n);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Narxni tahrirlash</DialogTitle>
          <DialogDescription className="truncate">{product.name}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="product-cost">Narx (1 birlik uchun, so‘m)</Label>
            <Input
              id="product-cost"
              type="number"
              min={0}
              step="any"
              inputMode="decimal"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={posterCost != null ? String(posterCost) : '0'}
              autoFocus
            />
          </div>

          <p className="text-xs text-muted-foreground">
            {posterCost != null ? (
              <>
                Poster narxi:{' '}
                <span className="tabular-nums text-foreground">
                  {formatSom(posterCost)}
                </span>
                {hasManual && ' — hozir qo‘lda kiritilgan narx ishlatilmoqda.'}
              </>
            ) : (
              'Posterda narx yo‘q — qo‘lda kiriting.'
            )}
          </p>
        </div>

        <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={saving || !hasManual}
            onClick={() => void patchCost(null)}
          >
            Poster narxiga qaytarish
          </Button>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              Bekor qilish
            </Button>
            <Button type="button" size="sm" disabled={saving} onClick={save}>
              {saving ? 'Saqlanmoqda…' : 'Saqlash'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
