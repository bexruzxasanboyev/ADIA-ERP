import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
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
import { Textarea } from '@/components/ui/textarea';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { apiRequest, ApiError } from '@/lib/api-client';
import { UNIT_LABELS } from '@/lib/labels';
import type { Product } from '@/lib/types';
import { ProductMultiSelect } from './ProductMultiSelect';

/**
 * `POST /api/replenishment/batch` request body (per the team-lead contract).
 * Each item raises one replenishment_request for `(product, requester store)`;
 * the backend dedupes against invariant 2 (one open request per pair) and
 * reports back how many were created vs already-open.
 *
 * ASSUMPTION (frontend): the requester location is the active store, taken
 * from `requester_location_id` in the body. If the backend instead infers
 * the store from the caller's RBAC scope, the extra field is harmless.
 */
interface BatchRequestItem {
  product_id: number;
  qty_needed: number;
}

interface BatchRequestBody {
  requester_location_id: number;
  items: BatchRequestItem[];
  note?: string;
}

/**
 * `POST /api/replenishment/batch` response (per contract). `created` is the
 * number of new requests opened; `exists` the number skipped because an open
 * request already existed for that pair. Both optional on the wire so the
 * toast degrades to a generic success if the backend omits the counters.
 */
interface BatchRequestResponse {
  results?: { product_id: number; status: 'created' | 'exists' | 'error' }[];
}

interface StoreRequestCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Products selectable for this store (already scoped by the parent). */
  products: Product[];
  /** The store the requests are raised for. */
  storeLocationId: number;
  /** Refetch the request list after a successful batch. */
  onSaved: () => void;
}

/**
 * Do'kon ish joyi — "+ So'rov qo'shish" dialog.
 *
 * Flow: translit-aware multi-select of products → picked products appear in
 * a table with a per-row "Soni" (qty) input → Tasdiqlash posts the batch.
 * Empty / non-positive qty rows are rejected before the request fires.
 */
export function StoreRequestCreateDialog({
  open,
  onOpenChange,
  products,
  storeLocationId,
  onSaved,
}: StoreRequestCreateDialogProps) {
  const { notify } = useToast();
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [qtyById, setQtyById] = useState<Record<number, string>>({});
  const [note, setNote] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setSelectedIds([]);
      setQtyById({});
      setNote('');
      setError(null);
    }
  }, [open]);

  const productById = useMemo(() => {
    const map = new Map<number, Product>();
    for (const p of products) map.set(p.id, p);
    return map;
  }, [products]);

  const picked = useMemo(
    () =>
      selectedIds
        .map((id) => productById.get(id))
        .filter((p): p is Product => p !== undefined),
    [selectedIds, productById],
  );

  function toggle(productId: number) {
    setSelectedIds((prev) =>
      prev.includes(productId)
        ? prev.filter((id) => id !== productId)
        : [...prev, productId],
    );
  }

  function removeRow(productId: number) {
    setSelectedIds((prev) => prev.filter((id) => id !== productId));
    setQtyById((prev) => {
      const next = { ...prev };
      delete next[productId];
      return next;
    });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (picked.length === 0) {
      setError('Kamida bitta mahsulot tanlang.');
      return;
    }

    const items: BatchRequestItem[] = [];
    for (const p of picked) {
      const raw = (qtyById[p.id] ?? '').replace(',', '.');
      const qty = Number(raw);
      if (!Number.isFinite(qty) || qty <= 0) {
        setError(`«${p.name}» uchun soni 0 dan katta bo‘lishi kerak.`);
        return;
      }
      items.push({ product_id: p.id, qty_needed: qty });
    }

    const body: BatchRequestBody = {
      requester_location_id: storeLocationId,
      items,
    };
    const trimmedNote = note.trim();
    if (trimmedNote !== '') body.note = trimmedNote;

    setIsSubmitting(true);
    try {
      const res = await apiRequest<BatchRequestResponse>(
        '/api/replenishment/batch',
        { method: 'POST', body },
      );
      const rows = res.results ?? [];
      const created = rows.filter((r) => r.status === 'created').length || items.length;
      const exists = rows.filter((r) => r.status === 'exists').length;
      notify(
        'success',
        exists > 0
          ? `${created} ta so‘rov yaratildi, ${exists} tasi allaqachon ochiq edi.`
          : `${created} ta so‘rov yaratildi.`,
      );
      onOpenChange(false);
      onSaved();
    } catch (err: unknown) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'So‘rovlarni yuborib bo‘lmadi.',
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>So‘rov qo‘shish</DialogTitle>
          <DialogDescription>
            Kerakli mahsulotlarni tanlang va har biriga sonini kiriting. Har
            mahsulot uchun bitta to‘ldirish so‘rovi yuboriladi.
          </DialogDescription>
        </DialogHeader>

        <form
          id="store-request-form"
          className="space-y-4"
          onSubmit={handleSubmit}
        >
          <div className="space-y-2">
            <Label>Mahsulotlar</Label>
            <ProductMultiSelect
              products={products}
              selectedIds={selectedIds}
              onToggle={toggle}
              disabled={isSubmitting}
            />
          </div>

          {picked.length > 0 && (
            <div className="rounded-md border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Mahsulot</TableHead>
                    <TableHead className="w-40">Soni</TableHead>
                    <TableHead className="w-12" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {picked.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="font-medium">{p.name}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Input
                            type="number"
                            inputMode="decimal"
                            min="0"
                            step="any"
                            value={qtyById[p.id] ?? ''}
                            onChange={(e) =>
                              setQtyById((prev) => ({
                                ...prev,
                                [p.id]: e.target.value,
                              }))
                            }
                            placeholder="0"
                            aria-label={`${p.name} soni`}
                            disabled={isSubmitting}
                            className="h-9"
                          />
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {UNIT_LABELS[p.unit]}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => removeRow(p.id)}
                          disabled={isSubmitting}
                          aria-label={`${p.name} ni o‘chirish`}
                        >
                          <Trash2 className="size-4" aria-hidden="true" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="store-request-note">Izoh (ixtiyoriy)</Label>
            <Textarea
              id="store-request-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              disabled={isSubmitting}
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
          <Button
            type="submit"
            form="store-request-form"
            disabled={isSubmitting || picked.length === 0}
          >
            {isSubmitting && (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            )}
            Tasdiqlash
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
