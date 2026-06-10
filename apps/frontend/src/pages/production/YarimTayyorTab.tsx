import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Factory, Loader2, PlusCircle, ScrollText, Search } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NumberInput } from '@/components/ui/number-input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState, ErrorState, LoadingState } from '@/components/PageState';
import { useToast } from '@/components/ui/toast';
import { useApiQuery } from '@/hooks/useApiQuery';
import { ApiError, apiRequest } from '@/lib/api-client';
import { formatQty } from '@/lib/format';
import { UNIT_LABELS } from '@/lib/labels';
import { cn } from '@/lib/utils';
import type { Product, ProductionOrder } from '@/lib/types';

/**
 * "Yarim tayyor" — the отдел's з/г (semi-finished) catalogue WITH on-hand qoldiq
 * and a per-card **"To'ldirish"** self-fill action (phase F-J §2).
 *
 * This is a DEDICATED production-scoped grid (it does NOT reuse the generic
 * ProductsPage card, which the F-J boundary freezes): an отдел manager who is
 * short on a з/г must be able to open a zagatovka for it in one tap WITHOUT
 * routing through the whole Manba reja. Each card keeps the read-only
 * "Retseptni ko'rish" link and adds the primary "To'ldirish" button that opens
 * a small qty dialog → `POST /api/production-orders/zagatovka` for the manager's
 * OWN отдел, targeting its own sex_storage. The created zayafka lands in the
 * Dashboard / So'rovlar zayafka lists; here we just refresh the qoldiq grid.
 *
 * Data: `GET /api/products/yarim-tayyor` — the SAME endpoint the So'rovlar tab
 * uses (auto-scoped server-side to the production_manager's отдел; PM sees every
 * type='semi' product) returning `Product` rows enriched with on-hand `qty`.
 */

/** A з/г row — the yarim-tayyor endpoint returns Product PLUS on-hand `qty`. */
type SemiProduct = Product & { qty: number };

export function YarimTayyorTab({
  productionId,
  canFill,
}: {
  /** The scoped отдел id, or `null` for the PM chain-wide view. */
  productionId: number | null;
  /** Whether the user may open a zagatovka (production_manager only; PM no). */
  canFill: boolean;
}) {
  const navigate = useNavigate();
  const semi = useApiQuery<SemiProduct[]>('/api/products/yarim-tayyor');

  const [query, setQuery] = useState('');
  // The з/г whose "To'ldirish" dialog is open (null = closed).
  const [fillTarget, setFillTarget] = useState<SemiProduct | null>(null);

  const rows = useMemo<SemiProduct[]>(() => {
    const data = semi.data ?? [];
    const q = query.trim().toLowerCase();
    const filtered = q
      ? data.filter(
          (p) =>
            p.name.toLowerCase().includes(q) ||
            (p.sku?.toLowerCase().includes(q) ?? false),
        )
      : data;
    return [...filtered].sort((a, b) => a.name.localeCompare(b.name));
  }, [semi.data, query]);

  return (
    <div className="space-y-6">
      {/* Filter row — count at the left, search at the right (DESIGN.md §9). */}
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary" className="tabular-nums">
          {(semi.data ?? []).length} tur
        </Badge>
        <div className="relative ml-auto w-56">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Qidirish…"
            aria-label="Yarim tayyor mahsulot qidirish"
            className="pl-8"
          />
        </div>
      </div>

      {semi.isLoading && <LoadingState />}
      {!semi.isLoading && semi.error && (
        <ErrorState message={semi.error} onRetry={semi.refetch} />
      )}
      {!semi.isLoading && !semi.error && rows.length === 0 && (
        <EmptyState
          message={
            query
              ? 'Qidiruvga mos yarim tayyor mahsulot topilmadi.'
              : 'Bo‘limda yarim tayyor mahsulot yo‘q.'
          }
        />
      )}
      {!semi.isLoading && !semi.error && rows.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {rows.map((p) => (
            <SemiCard
              key={p.id}
              product={p}
              canFill={canFill}
              onOpenRecipe={() => navigate(`/products/${p.id}/recipe`)}
              onFill={() => setFillTarget(p)}
            />
          ))}
        </div>
      )}

      <ZagatovkaDialog
        open={fillTarget !== null}
        onOpenChange={(open) => {
          if (!open) setFillTarget(null);
        }}
        product={fillTarget}
        locationId={productionId}
        onCreated={() => {
          semi.refetch();
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// SemiCard — one з/г: name + qoldiq, with "Retseptni ko'rish" (ghost) and the
// primary "To'ldirish" (zagatovka self-fill) action.
// ---------------------------------------------------------------------------

function SemiCard({
  product: p,
  canFill,
  onOpenRecipe,
  onFill,
}: {
  product: SemiProduct;
  canFill: boolean;
  onOpenRecipe: () => void;
  onFill: () => void;
}) {
  const unit = UNIT_LABELS[p.unit];
  // qty<=0 reads as an empty buffer (warning); >0 is a healthy on-hand chip.
  const empty = p.qty <= 0;
  return (
    <Card className="flex h-full flex-col gap-2 border-l-4 border-border/60 p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="truncate text-sm font-medium" title={p.name}>
          {p.name}
        </p>
        {p.workshop?.name && (
          <Badge variant="outline" className="shrink-0 gap-1 whitespace-nowrap">
            <Factory className="size-3" aria-hidden="true" />
            {p.workshop.name}
          </Badge>
        )}
      </div>
      {p.sku && (
        <p className="truncate text-[11px] text-muted-foreground">SKU: {p.sku}</p>
      )}

      {/* Qoldiq (ostatka) — the з/г buffer at a glance; 0 is valid + expected. */}
      <p className="mt-auto pt-0.5 text-xs text-muted-foreground">
        Qoldiq:{' '}
        <span
          className={cn(
            'font-medium tabular-nums',
            empty ? 'text-warning' : 'text-foreground',
          )}
        >
          {formatQty(p.qty)} {unit}
        </span>
      </p>

      {/* Actions — ghost recipe link (left) → primary "To'ldirish" (right). */}
      <div className="-mb-1 -ml-2 flex items-center justify-between gap-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
          onClick={onOpenRecipe}
        >
          <ScrollText className="size-3.5" aria-hidden="true" />
          Retseptni ko‘rish
        </Button>
        {canFill && (
          <Button
            size="sm"
            className="mr-1 h-7 text-xs"
            onClick={onFill}
          >
            <PlusCircle className="size-3.5" aria-hidden="true" />
            To‘ldirish
          </Button>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// ZagatovkaDialog — the self-fill qty dialog. product name + current qoldiq +
// a kg NumberInput → POST /api/production-orders/zagatovka { location_id,
// product_id, qty }. Success toast names the created zayafka + the sklad it
// will land in; 403/422 surface as friendly Uzbek toasts.
// ---------------------------------------------------------------------------

function ZagatovkaDialog({
  open,
  onOpenChange,
  product,
  locationId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: SemiProduct | null;
  locationId: number | null;
  onCreated: () => void;
}) {
  const { notify } = useToast();
  const [qty, setQty] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Reset the typed qty whenever the dialog (re)opens for a з/г, so a previous
  // entry never leaks into the next product's fill.
  useEffect(() => {
    if (open) setQty(null);
  }, [open, product?.id]);

  const unit = product ? UNIT_LABELS[product.unit] : '';
  const canSubmit =
    !submitting &&
    locationId !== null &&
    product !== null &&
    qty !== null &&
    qty > 0;

  async function handleSubmit() {
    if (!product || locationId === null || qty === null || qty <= 0 || submitting) {
      return;
    }
    setSubmitting(true);
    try {
      const { production_order } = await apiRequest<{
        production_order: ProductionOrder;
      }>('/api/production-orders/zagatovka', {
        method: 'POST',
        body: { location_id: locationId, product_id: product.id, qty },
      });
      const skladName =
        production_order.target_location_name ??
        production_order.location_name ??
        'sex skladi';
      notify(
        'success',
        `Zayafka #${production_order.id} yaratildi — tayyor bo‘lgach ${skladName}ga tushadi.`,
      );
      onCreated();
      onOpenChange(false);
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 403) {
        notify('error', 'Sizda zayafka ochish huquqi yo‘q.');
      } else if (err instanceof ApiError && err.status === 422) {
        // The backend 422s here are domain validations the user can't act on
        // (non-semi product, or the отдел has no sex_storage to output into).
        // Keep the toast Uzbek (CLAUDE.md) instead of leaking the raw message.
        notify(
          'error',
          'Bu mahsulot uchun zayafka ochib bo‘lmaydi — bo‘limning sex skladi sozlanmagan yoki mahsulot yarim tayyor emas.',
        );
      } else {
        notify(
          'error',
          err instanceof ApiError
            ? err.message
            : 'Zayafkani yaratib bo‘lmadi. Qayta urinib ko‘ring.',
        );
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Factory className="size-4 text-primary" aria-hidden="true" />
            To‘ldirish — {product?.name ?? 'yarim tayyor'}
          </DialogTitle>
          <DialogDescription>
            Yangi zayafka ochiladi. Tayyor bo‘lgach bo‘limning sex skladiga
            qo‘shiladi.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {product && (
            <p className="text-xs text-muted-foreground">
              Hozirgi qoldiq:{' '}
              <span className="font-medium tabular-nums text-foreground">
                {formatQty(product.qty)} {unit}
              </span>
            </p>
          )}
          <div className="space-y-1.5">
            <label
              htmlFor="zagatovka-qty"
              className="text-sm font-medium"
            >
              Miqdor ({unit || 'kg'})
            </label>
            <NumberInput
              id="zagatovka-qty"
              decimals
              min={0}
              value={qty}
              onValueChange={setQty}
              placeholder="0"
              aria-label="Tayyorlanadigan miqdor"
              disabled={submitting}
              autoFocus
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Bekor qilish
          </Button>
          <Button type="button" onClick={handleSubmit} disabled={!canSubmit}>
            {submitting ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Factory className="size-4" aria-hidden="true" />
            )}
            Zayafka ochish
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
