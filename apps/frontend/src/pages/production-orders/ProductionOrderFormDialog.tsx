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
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { apiRequest, ApiError } from '@/lib/api-client';
import type { Location, Product } from '@/lib/types';

interface ProductionOrderFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  products: Product[];
  locations: Location[];
  onSaved: () => void;
}

interface FormState {
  product_id: string;
  qty: string;
  location_id: string;
  target_location_id: string;
  deadline: string;
  note: string;
}

const EMPTY_FORM: FormState = {
  product_id: '',
  qty: '',
  location_id: '',
  target_location_id: '',
  deadline: '',
  note: '',
};

/**
 * Create a production order — `POST /api/production-orders` (M5, §4.6).
 * The backend defaults the new status to `new`.
 *
 * Production locations are valid for `location_id`; `target_location_id`
 * is the warehouse that will receive the finished output. `deadline` is
 * optional and must be an ISO date (YYYY-MM-DD) if provided.
 */
export function ProductionOrderFormDialog({
  open,
  onOpenChange,
  products,
  locations,
  onSaved,
}: ProductionOrderFormDialogProps) {
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

  // Useful subsets — production location for the "where" select, all
  // locations for the optional target.
  const productionLocations = locations.filter((l) => l.type === 'production');
  const eligibleProducts = products.filter(
    (p) => p.type === 'semi' || p.type === 'finished',
  );

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (form.product_id === '' || form.location_id === '') {
      setError('Mahsulot va ishlab chiqarish bo‘g‘inini tanlang.');
      return;
    }
    const qty = Number(form.qty);
    if (!Number.isFinite(qty) || qty <= 0) {
      setError('Miqdor 0 dan katta bo‘lishi kerak.');
      return;
    }

    setIsSubmitting(true);
    try {
      await apiRequest('/api/production-orders', {
        method: 'POST',
        body: {
          product_id: Number(form.product_id),
          qty,
          location_id: Number(form.location_id),
          target_location_id:
            form.target_location_id === ''
              ? null
              : Number(form.target_location_id),
          deadline: form.deadline === '' ? null : form.deadline,
          note: form.note.trim() === '' ? null : form.note.trim(),
        },
      });
      notify('success', 'Zayafka yaratildi.');
      onOpenChange(false);
      onSaved();
    } catch (err: unknown) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Zayafkani yaratib bo‘lmadi.',
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Yangi ishlab chiqarish zayafkasi</DialogTitle>
          <DialogDescription>
            Tayyor yoki yarim tayyor mahsulot uchun zayafka tuzing.
          </DialogDescription>
        </DialogHeader>

        <form id="po-form" className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <Label htmlFor="po-product">Mahsulot</Label>
            <Select
              id="po-product"
              name="product_id"
              required
              value={form.product_id}
              onChange={(e) =>
                setForm({ ...form, product_id: e.target.value })
              }
            >
              <option value="">— Tanlang —</option>
              {eligibleProducts.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="po-qty">Miqdor</Label>
            <Input
              id="po-qty"
              name="qty"
              type="number"
              min={0}
              step="any"
              required
              value={form.qty}
              onChange={(e) => setForm({ ...form, qty: e.target.value })}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="po-loc">Ishlab chiqarish bo‘g‘ini</Label>
              <Select
                id="po-loc"
                name="location_id"
                required
                value={form.location_id}
                onChange={(e) =>
                  setForm({ ...form, location_id: e.target.value })
                }
              >
                <option value="">— Tanlang —</option>
                {productionLocations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="po-target">Maqsad bo‘g‘in (ixtiyoriy)</Label>
              <Select
                id="po-target"
                name="target_location_id"
                value={form.target_location_id}
                onChange={(e) =>
                  setForm({ ...form, target_location_id: e.target.value })
                }
              >
                <option value="">— Tanlanmagan —</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="po-deadline">Muddat (ixtiyoriy)</Label>
            <Input
              id="po-deadline"
              name="deadline"
              type="date"
              value={form.deadline}
              onChange={(e) => setForm({ ...form, deadline: e.target.value })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="po-note">Izoh (ixtiyoriy)</Label>
            <Textarea
              id="po-note"
              name="note"
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
            />
          </div>

          {error && (
            <p
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive-foreground"
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
          <Button type="submit" form="po-form" disabled={isSubmitting}>
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
