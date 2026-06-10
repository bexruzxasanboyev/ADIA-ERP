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
import type { SellerKpiItem, SellerKpiPlanRequest } from '@/lib/types';

/** The seller + month a plan edit is bound to. */
export interface SellerKpiPlanTarget {
  seller_id: number;
  /** Seller display name (for the dialog copy). */
  name: string;
  /** `YYYY-MM`. */
  month: string;
  /** Current target (so'm), or null when unset. */
  value: number | null;
}

interface SellerKpiPlanDialogProps {
  /** Open when non-null; closed when null. */
  target: SellerKpiPlanTarget | null;
  onOpenChange: (open: boolean) => void;
  /** Re-fetch the KPI table after a successful save. */
  onSaved: () => void;
}

/**
 * PM-only monthly-plan editor for one seller (TZ Module 8).
 *
 * `PUT /api/seller-kpi/plan { seller_id, month, target_sum }`. The amount is
 * entered with the project-wide formatted {@link NumberInput} ("1 000 000"
 * while typing). The target is required — an empty field disables Save (the
 * endpoint sets a concrete plan; clearing a plan is out of scope here).
 */
export function SellerKpiPlanDialog({
  target,
  onOpenChange,
  onSaved,
}: SellerKpiPlanDialogProps) {
  const { notify } = useToast();
  const [value, setValue] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  // Seed the field whenever a new target opens the dialog.
  useEffect(() => {
    if (target) setValue(target.value);
  }, [target]);

  const open = target !== null;

  async function handleSave() {
    if (!target || value === null) return;
    setSaving(true);
    try {
      const body: SellerKpiPlanRequest = {
        seller_id: target.seller_id,
        month: target.month,
        target_sum: value,
      };
      await apiRequest<SellerKpiItem>('/api/seller-kpi/plan', {
        method: 'PUT',
        body,
      });
      notify('success', 'Plan saqlandi.');
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
          <DialogTitle>Plan belgilash</DialogTitle>
          <DialogDescription>
            {target
              ? `${target.name} uchun ${target.month} oylik sotuv rejasini belgilang.`
              : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label htmlFor="seller-kpi-plan-input">Oylik reja (so‘m)</Label>
          <NumberInput
            id="seller-kpi-plan-input"
            value={value}
            onValueChange={setValue}
            placeholder="50 000 000"
            aria-label="Oylik reja (so‘m)"
          />
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Bekor qilish
          </Button>
          <Button
            type="button"
            onClick={handleSave}
            disabled={saving || value === null}
          >
            {saving ? 'Saqlanmoqda…' : 'Saqlash'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
