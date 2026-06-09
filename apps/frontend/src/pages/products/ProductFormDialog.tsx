import { useEffect, useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
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
import { useToast } from '@/components/ui/toast';
import { apiRequest, ApiError } from '@/lib/api-client';
import { PRODUCT_TYPE_OPTIONS, UNIT_OPTIONS } from '@/lib/labels';
import type { ProductType, Unit } from '@/lib/types';

interface ProductFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

interface FormState {
  name: string;
  type: ProductType;
  unit: Unit;
  sku: string;
}

const EMPTY_FORM: FormState = {
  name: '',
  type: 'raw',
  unit: 'kg',
  sku: '',
};

/** Create dialog for a product (M2). Submits to `POST /api/products`. */
export function ProductFormDialog({
  open,
  onOpenChange,
  onSaved,
}: ProductFormDialogProps) {
  const { notify } = useToast();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setForm(EMPTY_FORM);
      setError(null);
    }
  }, [open]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      await apiRequest('/api/products', {
        method: 'POST',
        body: {
          name: form.name.trim(),
          type: form.type,
          unit: form.unit,
          sku: form.sku.trim() === '' ? null : form.sku.trim(),
        },
      });
      notify('success', 'Mahsulot qo‘shildi.');
      onOpenChange(false);
      onSaved();
    } catch (err: unknown) {
      setError(
        err instanceof ApiError ? err.message : 'Saqlashda xatolik yuz berdi.',
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Yangi mahsulot</DialogTitle>
          <DialogDescription>Mahsulot ma’lumotlarini kiriting.</DialogDescription>
        </DialogHeader>

        <form id="product-form" className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-1.5">
            <Label htmlFor="product-name">Nomi</Label>
            <Input
              id="product-name"
              name="name"
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="product-type">Turi</Label>
              <Select
                id="product-type"
                name="type"
                value={form.type}
                onChange={(e) =>
                  setForm({ ...form, type: e.target.value as ProductType })
                }
              >
                {PRODUCT_TYPE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="product-unit">O‘lchov birligi</Label>
              <Select
                id="product-unit"
                name="unit"
                value={form.unit}
                onChange={(e) =>
                  setForm({ ...form, unit: e.target.value as Unit })
                }
              >
                {UNIT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="product-sku">SKU (ixtiyoriy)</Label>
            <Input
              id="product-sku"
              name="sku"
              value={form.sku}
              onChange={(e) => setForm({ ...form, sku: e.target.value })}
            />
          </div>

          {error && (
            <p
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              role="alert"
            >
              {error}
            </p>
          )}
        </form>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            Bekor qilish
          </Button>
          <Button type="submit" form="product-form" disabled={isSubmitting}>
            {isSubmitting && (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            )}
            Saqlash
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
