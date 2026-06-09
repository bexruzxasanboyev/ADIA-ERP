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
import { NumberInput } from '@/components/ui/number-input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { apiRequest, ApiError } from '@/lib/api-client';
import type { Location, Product } from '@/lib/types';

interface AdminPurchaseOrderFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  products: Product[];
  locations: Location[];
  onSaved: () => void;
}

interface FormState {
  product_id: string;
  qty: number | null;
  target_location_id: string;
  supplier_id: number | null;
  note: string;
}

const EMPTY_FORM: FormState = {
  product_id: '',
  qty: null,
  target_location_id: '',
  supplier_id: null,
  note: '',
};

/**
 * EPIC 6.1 — admin → skladchi purchase order.
 *
 * The PM (admin) places the order and routes it to the warehouse keeper
 * (skladchi) via `POST /api/purchase-orders/admin` (authorize('pm')).
 * Unlike the supply-manager `PurchaseOrderFormDialog` this endpoint
 * pre-fills the manager approval step on the admin's behalf — the
 * skladchi then confirms the keeper step (two-step approval preserved).
 *
 * The target MUST be a raw warehouse (the keeper of a raw warehouse is the
 * skladchi who confirms) — the backend returns 422 otherwise, so we narrow
 * the target <select> to `type === 'raw_warehouse'` up front.
 */
export function AdminPurchaseOrderFormDialog({
  open,
  onOpenChange,
  products,
  locations,
  onSaved,
}: AdminPurchaseOrderFormDialogProps) {
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

  // Raw materials go to a raw warehouse — narrow both lists to mirror the
  // backend's 422 guards (target must be raw_warehouse, product must exist).
  const rawWarehouses = locations.filter((l) => l.type === 'raw_warehouse');
  const rawProducts = products.filter((p) => p.type === 'raw');

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (form.product_id === '' || form.target_location_id === '') {
      setError('Mahsulot va qabul qiluvchi bo‘g‘inni tanlang.');
      return;
    }
    const qty = form.qty ?? NaN;
    if (!Number.isFinite(qty) || qty <= 0) {
      setError('Miqdor 0 dan katta bo‘lishi kerak.');
      return;
    }

    setIsSubmitting(true);
    try {
      await apiRequest('/api/purchase-orders/admin', {
        method: 'POST',
        body: {
          product_id: Number(form.product_id),
          qty,
          target_location_id: Number(form.target_location_id),
          supplier_id: form.supplier_id,
          note: form.note.trim() === '' ? null : form.note.trim(),
        },
      });
      notify('success', 'Admin sotib olish so‘rovi yaratildi.');
      onOpenChange(false);
      onSaved();
    } catch (err: unknown) {
      setError(
        err instanceof ApiError ? err.message : 'So‘rovni yaratib bo‘lmadi.',
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Admin sotib olish so‘rovi</DialogTitle>
          <DialogDescription>
            Siz buyurtma qilasiz → skladchi qabul qiladi. Boshliq bosqichi
            sizning nomingizdan to‘ldiriladi; skladchi tasdig‘i kutiladi.
          </DialogDescription>
        </DialogHeader>

        <form id="admin-purch-form" className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-1.5">
            <Label htmlFor="admin-purch-product">Mahsulot</Label>
            <Select
              id="admin-purch-product"
              name="product_id"
              required
              value={form.product_id}
              onChange={(e) =>
                setForm({ ...form, product_id: e.target.value })
              }
            >
              <option value="">— Tanlang —</option>
              {rawProducts.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="admin-purch-qty">Miqdor</Label>
            <NumberInput
              id="admin-purch-qty"
              name="qty"
              decimals
              min={0}
              required
              value={form.qty}
              onValueChange={(n) => setForm({ ...form, qty: n })}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="admin-purch-target">Qabul qiluvchi (skladchi)</Label>
            <Select
              id="admin-purch-target"
              name="target_location_id"
              required
              value={form.target_location_id}
              onChange={(e) =>
                setForm({ ...form, target_location_id: e.target.value })
              }
            >
              <option value="">— Tanlang —</option>
              {rawWarehouses.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="admin-purch-supplier">
              Yetkazib beruvchi ID (ixtiyoriy)
            </Label>
            <NumberInput
              id="admin-purch-supplier"
              name="supplier_id"
              min={1}
              value={form.supplier_id}
              onValueChange={(n) => setForm({ ...form, supplier_id: n })}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="admin-purch-note">Izoh (ixtiyoriy)</Label>
            <Textarea
              id="admin-purch-note"
              name="note"
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
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
          <Button type="submit" form="admin-purch-form" disabled={isSubmitting}>
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
