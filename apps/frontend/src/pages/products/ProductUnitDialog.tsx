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
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { apiRequest, ApiError } from '@/lib/api-client';
import { UNIT_LABELS, UNIT_OPTIONS } from '@/lib/labels';
import type { Product, Unit } from '@/lib/types';

/**
 * Edit a product's UNIT OF MEASURE (kg / l / dona) when it is wrong.
 *
 * Only pm / raw_warehouse_manager mount this (the caller gates on role,
 * mirroring `canCreate`). The select is pre-filled with the product's
 * current `unit`. Saving PATCHes the new unit; a same-value save is a
 * no-op (no request fires). The ERP updates immediately and a Poster
 * write-back is queued server-side (deferred — not surfaced here; we just
 * treat the PATCH success as saved).
 *
 * Endpoint: `PATCH /api/products/:id/unit` body `{ unit: 'kg' | 'l' | 'pcs' }`.
 */
export function ProductUnitDialog({
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
  const [draft, setDraft] = useState<Unit>(product.unit);
  const [saving, setSaving] = useState(false);

  // Re-seed the select each time the dialog opens for a (possibly
  // different) product so a stale draft never bleeds across cards.
  useEffect(() => {
    if (open) {
      setDraft(product.unit);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, product.id]);

  async function save() {
    if (draft === product.unit) {
      // No change — nothing to persist; just close quietly.
      onOpenChange(false);
      return;
    }
    setSaving(true);
    try {
      await apiRequest(`/api/products/${product.id}/unit`, {
        method: 'PATCH',
        body: { unit: draft },
      });
      notify('success', 'Birlik saqlandi.');
      onSaved();
      onOpenChange(false);
    } catch (err) {
      notify('error', err instanceof ApiError ? err.message : 'Saqlab bo‘lmadi.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Birlikni tahrirlash</DialogTitle>
          <DialogDescription className="truncate">{product.name}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="product-unit">O‘lchov birligi</Label>
            <Select
              id="product-unit"
              value={draft}
              onChange={(e) => setDraft(e.target.value as Unit)}
              autoFocus
            >
              {UNIT_OPTIONS.map((u) => (
                <option key={u.value} value={u.value}>
                  {u.label}
                </option>
              ))}
            </Select>
          </div>

          <p className="text-xs text-muted-foreground">
            Joriy birlik:{' '}
            <span className="text-foreground">{UNIT_LABELS[product.unit]}</span>
          </p>
        </div>

        <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={saving}
            onClick={() => onOpenChange(false)}
          >
            Bekor qilish
          </Button>
          <Button type="button" size="sm" disabled={saving} onClick={() => void save()}>
            {saving ? 'Saqlanmoqda…' : 'Saqlash'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
