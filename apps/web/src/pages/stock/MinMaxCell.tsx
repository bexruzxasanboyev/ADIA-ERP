import { useState } from 'react';
import { Check, Pencil, X, Loader2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { apiRequest, ApiError } from '@/lib/api-client';
import { formatQty } from '@/lib/format';
import type { StockRow } from '@/lib/types';

interface MinMaxCellProps {
  row: StockRow;
  /** True if the current role may edit min/max for this row (§6). */
  canEdit: boolean;
  /** Called after a successful save to refresh the table. */
  onSaved: () => void;
}

/**
 * Inline min/max editor for one stock row — `PATCH /api/stock/minmax`.
 * Read-only display until the pencil is clicked; then two number inputs
 * with confirm / cancel.
 */
export function MinMaxCell({ row, canEdit, onSaved }: MinMaxCellProps) {
  const { notify } = useToast();
  const [editing, setEditing] = useState(false);
  const [min, setMin] = useState(String(row.min_level));
  const [max, setMax] = useState(String(row.max_level));
  const [isSaving, setIsSaving] = useState(false);

  function startEdit() {
    setMin(String(row.min_level));
    setMax(String(row.max_level));
    setEditing(true);
  }

  async function save() {
    const minNum = Number(min);
    const maxNum = Number(max);
    if (
      !Number.isFinite(minNum) ||
      !Number.isFinite(maxNum) ||
      minNum < 0 ||
      maxNum < 0
    ) {
      notify('error', 'Min/max manfiy bo‘lmasligi kerak.');
      return;
    }
    if (minNum > maxNum) {
      notify('error', 'Min qiymat max dan katta bo‘lmasligi kerak.');
      return;
    }

    setIsSaving(true);
    try {
      await apiRequest('/api/stock/minmax', {
        method: 'PATCH',
        body: {
          location_id: row.location_id,
          product_id: row.product_id,
          min_level: minNum,
          max_level: maxNum,
        },
      });
      notify('success', 'Min/max yangilandi.');
      setEditing(false);
      onSaved();
    } catch (err: unknown) {
      notify(
        'error',
        err instanceof ApiError ? err.message : 'Saqlab bo‘lmadi.',
      );
    } finally {
      setIsSaving(false);
    }
  }

  if (!editing) {
    return (
      <div className="flex items-center gap-2">
        <span>
          {formatQty(row.min_level)} / {formatQty(row.max_level)}
        </span>
        {canEdit && (
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={startEdit}
            aria-label="Min/max ni tahrirlash"
          >
            <Pencil className="size-3.5" />
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <Input
        className="h-8 w-20"
        type="number"
        min={0}
        step="any"
        value={min}
        onChange={(e) => setMin(e.target.value)}
        aria-label="Minimal daraja"
      />
      <span className="text-muted-foreground">/</span>
      <Input
        className="h-8 w-20"
        type="number"
        min={0}
        step="any"
        value={max}
        onChange={(e) => setMax(e.target.value)}
        aria-label="Maksimal daraja"
      />
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        onClick={save}
        disabled={isSaving}
        aria-label="Saqlash"
      >
        {isSaving ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Check className="size-3.5 text-success" />
        )}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        onClick={() => setEditing(false)}
        disabled={isSaving}
        aria-label="Bekor qilish"
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
}
