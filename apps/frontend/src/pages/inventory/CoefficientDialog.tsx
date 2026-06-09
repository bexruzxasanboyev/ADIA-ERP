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
import { NumberInput } from '@/components/ui/number-input';
import { useToast } from '@/components/ui/toast';
import { apiRequest, ApiError } from '@/lib/api-client';
import type { InventoryEndOfDayItem, Product } from '@/lib/types';

interface CoefficientDialogProps {
  /** Open when non-null; closed when null. Carries the current coefficients. */
  target: InventoryEndOfDayItem | null;
  onOpenChange: (open: boolean) => void;
  /** Re-fetch the inventory table after a successful save. */
  onSaved: () => void;
}

/**
 * TZ Module 11 — per-product «Koeffitsiyent» editor (pm / production_manager).
 *
 * Sets the two cake conversion coefficients:
 *   - `weight_per_whole` (kg of one whole cake), and
 *   - `pieces_per_whole` (slices per whole cake).
 *
 * `PATCH /api/products/:id/whole-piece { weight_per_whole, pieces_per_whole }`.
 * Both fields are required (a whole↔piece conversion needs them) and use the
 * formatted `NumberInput` per the project convention — raw `type=number` is
 * banned.
 */
export function CoefficientDialog({
  target,
  onOpenChange,
  onSaved,
}: CoefficientDialogProps) {
  const { notify } = useToast();
  const [weightPerWhole, setWeightPerWhole] = useState<number | null>(null);
  const [piecesPerWhole, setPiecesPerWhole] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  // Seed the fields whenever a new target opens the dialog.
  useEffect(() => {
    if (target) {
      setWeightPerWhole(target.weight_per_whole);
      setPiecesPerWhole(target.pieces_per_whole);
    }
  }, [target]);

  const open = target !== null;

  // Both coefficients must be present and positive to define a conversion.
  const isValid =
    weightPerWhole !== null &&
    weightPerWhole > 0 &&
    piecesPerWhole !== null &&
    piecesPerWhole > 0;

  async function handleSave() {
    if (!target || !isValid) return;
    setSaving(true);
    try {
      await apiRequest<Product>(`/api/products/${target.product_id}/whole-piece`, {
        method: 'PATCH',
        body: {
          weight_per_whole: weightPerWhole,
          pieces_per_whole: piecesPerWhole,
        },
      });
      notify('success', 'Koeffitsiyent saqlandi.');
      onSaved();
      onOpenChange(false);
    } catch (err: unknown) {
      notify(
        'error',
        err instanceof ApiError ? err.message : 'Saqlashda xatolik yuz berdi.',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Koeffitsiyent</DialogTitle>
          <DialogDescription>
            {target
              ? `«${target.name}» uchun bitta butun tortning og‘irligi va undagi bo‘laklar sonini kiriting.`
              : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="coeff-weight">Bitta butunning og‘irligi (kg)</Label>
            <NumberInput
              id="coeff-weight"
              value={weightPerWhole}
              onValueChange={setWeightPerWhole}
              decimals
              placeholder="2.5"
              aria-label="Bitta butunning og‘irligi (kg)"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="coeff-pieces">Bitta butundagi bo‘laklar</Label>
            <NumberInput
              id="coeff-pieces"
              value={piecesPerWhole}
              onValueChange={setPiecesPerWhole}
              placeholder="12"
              aria-label="Bitta butundagi bo‘laklar"
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Bekor qilish
          </Button>
          <Button
            type="button"
            onClick={handleSave}
            disabled={!isValid || saving}
          >
            {saving ? 'Saqlanmoqda…' : 'Saqlash'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
