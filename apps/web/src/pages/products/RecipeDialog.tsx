import { useEffect, useState } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';
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
import { Select } from '@/components/ui/select';
import { ErrorState, LoadingState } from '@/components/PageState';
import { useToast } from '@/components/ui/toast';
import { apiRequest, ApiError } from '@/lib/api-client';
import { UNIT_LABELS } from '@/lib/labels';
import type { Product, RecipeLine } from '@/lib/types';

interface RecipeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The product whose BOM is being edited. */
  product: Product | null;
  /** All products — used as the component picker options. */
  allProducts: Product[];
  /** True if the current role may edit (pm / production_manager). */
  canEdit: boolean;
}

/**
 * A BOM line in editable form. Both fields are kept as strings for
 * controlled inputs — `component_product_id` is a `<select>` value and
 * `qty_per_unit` a number input. Converted to numbers on save.
 */
interface EditableLine {
  component_product_id: string;
  qty_per_unit: string;
}

/**
 * View / edit a product's recipe (BOM) — M2.
 * Loads `GET /api/products/:id/recipe`; full-replaces via
 * `PUT /api/products/:id/recipe` (phase-1-mvp.md §4.3).
 */
export function RecipeDialog({
  open,
  onOpenChange,
  product,
  allProducts,
  canEdit,
}: RecipeDialogProps) {
  const { notify } = useToast();
  const [lines, setLines] = useState<EditableLine[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!open || product === null) return;
    let cancelled = false;
    setIsLoading(true);
    setLoadError(null);
    setSaveError(null);

    apiRequest<RecipeLine[]>(`/api/products/${product.id}/recipe`)
      .then((data) => {
        if (cancelled) return;
        setLines(
          data.map((l) => ({
            component_product_id: String(l.component_product_id),
            qty_per_unit: String(l.qty_per_unit),
          })),
        );
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(
          err instanceof ApiError ? err.message : 'Retseptni yuklab bo‘lmadi.',
        );
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, product]);

  // Components: any product other than the recipe owner itself.
  const componentOptions = allProducts.filter((p) => p.id !== product?.id);

  function addLine() {
    setLines([...lines, { component_product_id: '', qty_per_unit: '' }]);
  }

  function updateLine(index: number, patch: Partial<EditableLine>) {
    setLines(lines.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  function removeLine(index: number) {
    setLines(lines.filter((_, i) => i !== index));
  }

  async function handleSave() {
    if (product === null) return;
    setSaveError(null);

    // Validate before sending — every line needs a component and qty > 0.
    for (const line of lines) {
      if (line.component_product_id === '') {
        setSaveError('Har bir qatorda komponent tanlanishi kerak.');
        return;
      }
      const qty = Number(line.qty_per_unit);
      if (!Number.isFinite(qty) || qty <= 0) {
        setSaveError('Har bir komponent miqdori 0 dan katta bo‘lishi kerak.');
        return;
      }
    }
    const ids = lines.map((l) => l.component_product_id);
    if (new Set(ids).size !== ids.length) {
      setSaveError('Bitta komponent ikki marta kiritilgan.');
      return;
    }

    setIsSaving(true);
    try {
      const payload: RecipeLine[] = lines.map((l) => ({
        component_product_id: Number(l.component_product_id),
        qty_per_unit: Number(l.qty_per_unit),
      }));
      await apiRequest(`/api/products/${product.id}/recipe`, {
        method: 'PUT',
        body: payload,
      });
      notify('success', 'Retsept saqlandi.');
      onOpenChange(false);
    } catch (err: unknown) {
      setSaveError(
        err instanceof ApiError ? err.message : 'Retseptni saqlab bo‘lmadi.',
      );
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Retsept — {product?.name}</DialogTitle>
          <DialogDescription>
            1 birlik mahsulot uchun zarur komponentlar (BOM).
          </DialogDescription>
        </DialogHeader>

        {isLoading && <LoadingState />}
        {!isLoading && loadError && <ErrorState message={loadError} />}

        {!isLoading && !loadError && (
          <div className="space-y-3">
            {lines.length === 0 && (
              <p className="py-4 text-sm text-muted-foreground">
                Retsept hali bo‘sh.
              </p>
            )}

            {lines.map((line, index) => {
              const component = componentOptions.find(
                (p) => String(p.id) === line.component_product_id,
              );
              return (
                <div
                  key={index}
                  className="grid grid-cols-[1fr_120px_auto] items-end gap-3"
                >
                  <div className="space-y-1">
                    {index === 0 && (
                      <Label htmlFor={`recipe-comp-${index}`}>Komponent</Label>
                    )}
                    <Select
                      id={`recipe-comp-${index}`}
                      value={line.component_product_id}
                      disabled={!canEdit}
                      onChange={(e) =>
                        updateLine(index, {
                          component_product_id: e.target.value,
                        })
                      }
                    >
                      <option value="">— Tanlang —</option>
                      {componentOptions.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </Select>
                  </div>

                  <div className="space-y-1">
                    {index === 0 && (
                      <Label htmlFor={`recipe-qty-${index}`}>
                        Miqdor
                        {component
                          ? ` (${UNIT_LABELS[component.unit]})`
                          : ''}
                      </Label>
                    )}
                    <Input
                      id={`recipe-qty-${index}`}
                      type="number"
                      min={0}
                      step="any"
                      value={line.qty_per_unit}
                      disabled={!canEdit}
                      onChange={(e) =>
                        updateLine(index, { qty_per_unit: e.target.value })
                      }
                    />
                  </div>

                  {canEdit && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => removeLine(index)}
                      aria-label={`${index + 1}-qatorni o‘chirish`}
                    >
                      <Trash2 className="size-4 text-destructive" />
                    </Button>
                  )}
                </div>
              );
            })}

            {canEdit && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addLine}
              >
                <Plus className="size-4" aria-hidden="true" />
                Komponent qo‘shish
              </Button>
            )}

            {saveError && (
              <p
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive-foreground"
                role="alert"
              >
                {saveError}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
          >
            {canEdit ? 'Bekor qilish' : 'Yopish'}
          </Button>
          {canEdit && (
            <Button
              type="button"
              onClick={handleSave}
              disabled={isSaving || isLoading || loadError !== null}
            >
              {isSaving && (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              )}
              Saqlash
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
