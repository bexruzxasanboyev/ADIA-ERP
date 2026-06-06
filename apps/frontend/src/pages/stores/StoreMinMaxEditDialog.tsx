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
import { NumberInput } from '@/components/ui/number-input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/components/ui/toast';
import { apiRequest, ApiError } from '@/lib/api-client';
import { UNIT_LABELS } from '@/lib/labels';
import type { StockRow } from '@/lib/types';

/**
 * Do'kon ish joyi — edit a product's min / max level for ONE store
 * (owner feedback: "boshliqda mahsulotni min/max'ni edit qilish imkoni
 * bo'lishi kerak").
 *
 * Values are edited in the product's OWN unit (kg / l / dona) — the same
 * scalar the backend stores. Saving PATCHes both levels at once.
 *
 * Endpoint: `PATCH /api/stock/minmax`
 *   body `{ location_id, product_id, min_level, max_level }`.
 * RBAC (backend): a store_manager may edit only their own location; pm is
 * view-only here, so the caller mounts this for store_manager only.
 */
export function StoreMinMaxEditDialog({
  row,
  open,
  onOpenChange,
  onSaved,
}: {
  row: StockRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const { notify } = useToast();
  const [minDraft, setMinDraft] = useState<number | null>(null);
  const [maxDraft, setMaxDraft] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open && row) {
      setMinDraft(row.min_level);
      setMaxDraft(row.max_level);
    }
  }, [open, row]);

  if (!row) return null;
  const unit = UNIT_LABELS[row.product_unit];

  async function save() {
    if (!row) return;
    const min = minDraft ?? NaN;
    const max = maxDraft ?? NaN;
    if (!Number.isFinite(min) || min < 0) {
      notify('error', 'Min — manfiy bo‘lmagan son bo‘lishi kerak.');
      return;
    }
    if (!Number.isFinite(max) || max < 0) {
      notify('error', 'Max — manfiy bo‘lmagan son bo‘lishi kerak.');
      return;
    }
    if (max < min) {
      notify('error', 'Max — Min’dan kichik bo‘lmasligi kerak.');
      return;
    }
    setSaving(true);
    try {
      await apiRequest('/api/stock/minmax', {
        method: 'PATCH',
        body: {
          location_id: row.location_id,
          product_id: row.product_id,
          min_level: min,
          max_level: max,
        },
      });
      notify('success', 'Min / Max saqlandi.');
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Min / Max tahrirlash</DialogTitle>
          <DialogDescription>
            {row.product_name} — qiymatlar {unit} birligida.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="minmax-min">Min ({unit})</Label>
            <NumberInput
              id="minmax-min"
              decimals
              value={minDraft}
              onValueChange={setMinDraft}
              className="tabular-nums"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="minmax-max">Max ({unit})</Label>
            <NumberInput
              id="minmax-max"
              decimals
              value={maxDraft}
              onValueChange={setMaxDraft}
              className="tabular-nums"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Bekor qilish
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? 'Saqlanmoqda…' : 'Saqlash'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
