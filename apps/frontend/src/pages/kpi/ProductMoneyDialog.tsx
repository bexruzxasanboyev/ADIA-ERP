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
import { useToast } from '@/components/ui/toast';
import { apiRequest, ApiError } from '@/lib/api-client';
import { MoneyInput } from './MoneyInput';

/** Target a product money field is bound to. */
export interface ProductMoneyTarget {
  product_id: number;
  name: string;
  /** Current value (so'm), or null when unset. */
  value: number | null;
}

interface ProductMoneyDialogProps {
  /** Open when non-null; closed when null. */
  target: ProductMoneyTarget | null;
  onOpenChange: (open: boolean) => void;
  /** Re-fetch the KPI table after a successful save. */
  onSaved: () => void;
  /** Dialog title, e.g. "KPI maqsad" or "Komunal". */
  title: string;
  /** Dialog body description (Uzbek). `{name}` is substituted with product name. */
  description: string;
  /** Field label above the money input. */
  fieldLabel: string;
  /** PATCH path builder, e.g. (id) => `/api/products/${id}/komunal`. */
  endpoint: (productId: number) => string;
  /** JSON body key the backend expects, e.g. `kpi_target` or `komunal_per_unit`. */
  bodyKey: string;
  /** Success toast message (Uzbek). */
  successMessage: string;
  /** Stable id prefix for the input/label (a11y). */
  inputId: string;
}

/**
 * Reusable inline money editor for a single product field.
 *
 * `PATCH endpoint(product_id) { [bodyKey]: number|null }`.
 * Clearing the field sends `null` (value removed). Used by both the KPI
 * maqsad and the per-product Komunal columns on the KPI page.
 */
export function ProductMoneyDialog({
  target,
  onOpenChange,
  onSaved,
  title,
  description,
  fieldLabel,
  endpoint,
  bodyKey,
  successMessage,
  inputId,
}: ProductMoneyDialogProps) {
  const { notify } = useToast();
  const [value, setValue] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  // Seed the field whenever a new target opens the dialog.
  useEffect(() => {
    if (target) setValue(target.value);
  }, [target]);

  const open = target !== null;

  async function handleSave() {
    if (!target) return;
    setSaving(true);
    try {
      await apiRequest(endpoint(target.product_id), {
        method: 'PATCH',
        body: { [bodyKey]: value },
      });
      notify('success', successMessage);
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

  const body = description.replace('{name}', target?.name ?? '');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{body}</DialogDescription>
        </DialogHeader>

        <div className="space-y-2 py-2">
          <Label htmlFor={inputId}>{fieldLabel}</Label>
          <MoneyInput
            id={inputId}
            value={value}
            onValueChange={setValue}
            placeholder="1 000 000"
            aria-label={fieldLabel}
          />
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
          <Button type="button" onClick={handleSave} disabled={saving}>
            {saving ? 'Saqlanmoqda…' : 'Saqlash'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
