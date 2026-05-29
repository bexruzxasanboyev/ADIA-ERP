import { useEffect, useMemo, useState } from 'react';
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
import {
  RECIPE_STAGE_LABELS,
  RECIPE_STAGE_ORDER,
  UNIT_LABELS,
} from '@/lib/labels';
import type { Product, RecipeLine, RecipeStage } from '@/lib/types';

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
 * A BOM line in editable form. All fields are kept as strings for controlled
 * inputs; converted on save. `stage` defaults to `other` so a recipe authored
 * before the backend `recipes.stage` column lands still round-trips cleanly.
 */
interface EditableLine {
  component_product_id: string;
  qty_per_unit: string;
  stage: RecipeStage;
}

const STAGE_VALUES = RECIPE_STAGE_ORDER;

function normalizeStage(stage: RecipeLine['stage']): RecipeStage {
  return stage != null && (STAGE_VALUES as string[]).includes(stage)
    ? stage
    : 'other';
}

/**
 * View / edit a product's recipe (BOM) — M2, EPIC 1.5.
 * Loads `GET /api/products/:id/recipe`; full-replaces via
 * `PUT /api/products/:id/recipe` (phase-1-mvp.md §4.3).
 *
 * EPIC 1.5 — lines are grouped into dough / cream / decoration sections so a
 * baker reads the recipe the way they build the cake. When the backend has
 * not yet tagged stages, every line falls into a single "Boshqa" section and
 * the modal degrades gracefully. Quantities are stated "1 birlik uchun".
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

    apiRequest<{ product_id: number; recipe: RecipeLine[] }>(
      `/api/products/${product.id}/recipe`,
    )
      .then((data) => {
        if (cancelled) return;
        setLines(
          data.recipe.map((l) => ({
            component_product_id: String(l.component_product_id),
            qty_per_unit: String(l.qty_per_unit),
            stage: normalizeStage(l.stage),
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
  const componentOptions = useMemo(
    () => allProducts.filter((p) => p.id !== product?.id),
    [allProducts, product?.id],
  );

  // Group line *indices* by stage so edits map back to the flat `lines`
  // array. Only stages that have at least one line are shown.
  const grouped = useMemo(() => {
    const map = new Map<RecipeStage, number[]>();
    lines.forEach((line, index) => {
      const arr = map.get(line.stage) ?? [];
      arr.push(index);
      map.set(line.stage, arr);
    });
    return STAGE_VALUES.filter((s) => map.has(s)).map((stage) => ({
      stage,
      indices: map.get(stage) ?? [],
    }));
  }, [lines]);

  function addLine(stage: RecipeStage) {
    setLines((prev) => [
      ...prev,
      { component_product_id: '', qty_per_unit: '', stage },
    ]);
  }

  function updateLine(index: number, patch: Partial<EditableLine>) {
    setLines((prev) =>
      prev.map((l, i) => (i === index ? { ...l, ...patch } : l)),
    );
  }

  function removeLine(index: number) {
    setLines((prev) => prev.filter((_, i) => i !== index));
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
        stage: l.stage,
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

  function renderLine(index: number) {
    const line = lines[index];
    if (line === undefined) return null;
    const component = componentOptions.find(
      (p) => String(p.id) === line.component_product_id,
    );
    return (
      <div
        key={index}
        className="grid grid-cols-[1fr_110px_auto] items-end gap-3"
      >
        <div className="space-y-1">
          <Label htmlFor={`recipe-comp-${index}`} className="sr-only">
            Komponent
          </Label>
          <Select
            id={`recipe-comp-${index}`}
            value={line.component_product_id}
            disabled={!canEdit}
            onChange={(e) =>
              updateLine(index, { component_product_id: e.target.value })
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
          <Label htmlFor={`recipe-qty-${index}`} className="sr-only">
            Miqdor{component ? ` (${UNIT_LABELS[component.unit]})` : ''}
          </Label>
          <div className="flex items-center gap-1.5">
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
            {component && (
              <span className="shrink-0 text-xs text-muted-foreground">
                {UNIT_LABELS[component.unit]}
              </span>
            )}
          </div>
        </div>

        {canEdit ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => removeLine(index)}
            aria-label={`${index + 1}-qatorni o‘chirish`}
          >
            <Trash2 className="size-4 text-destructive" />
          </Button>
        ) : (
          <span className="w-10" aria-hidden="true" />
        )}
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Retsept — {product?.name}</DialogTitle>
          <DialogDescription>
            1 birlik mahsulot uchun zarur komponentlar (BOM), bosqichlarga
            ajratilgan: hamir, krem, bezak.
          </DialogDescription>
        </DialogHeader>

        {isLoading && <LoadingState />}
        {!isLoading && loadError && <ErrorState message={loadError} />}

        {!isLoading && !loadError && (
          <div className="max-h-[60vh] space-y-5 overflow-y-auto pr-1">
            {lines.length === 0 && (
              <p className="py-4 text-sm text-muted-foreground">
                Retsept hali bo‘sh.
              </p>
            )}

            {grouped.map(({ stage, indices }) => (
              <section key={stage} className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold">
                    {RECIPE_STAGE_LABELS[stage]}
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      {indices.length} ta
                    </span>
                  </h3>
                </div>
                <div className="grid grid-cols-[1fr_110px_auto] gap-3 text-xs text-muted-foreground">
                  <span>Komponent</span>
                  <span>1 birlik uchun</span>
                  <span className="w-10" aria-hidden="true" />
                </div>
                <div className="space-y-2">
                  {indices.map((index) => renderLine(index))}
                </div>
                {canEdit && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => addLine(stage)}
                  >
                    <Plus className="size-4" aria-hidden="true" />
                    {RECIPE_STAGE_LABELS[stage]} uchun komponent
                  </Button>
                )}
              </section>
            ))}

            {canEdit && (
              <div className="flex flex-wrap gap-2 border-t border-border pt-3">
                <span className="w-full text-xs text-muted-foreground">
                  Yangi bosqich qo‘shish:
                </span>
                {STAGE_VALUES.map((stage) => (
                  <Button
                    key={stage}
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => addLine(stage)}
                  >
                    <Plus className="size-4" aria-hidden="true" />
                    {RECIPE_STAGE_LABELS[stage]}
                  </Button>
                ))}
              </div>
            )}

            {saveError && (
              <p
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
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
