import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState, ErrorState, LoadingState } from '@/components/PageState';
import { useToast } from '@/components/ui/toast';
import { apiRequest, ApiError } from '@/lib/api-client';
import { formatQtyUnit } from '@/lib/format';
import type { Unit } from '@/lib/types';

/**
 * One AI replenishment proposal for a below-min product at this store.
 * `GET /api/replenishment/proposals?location_id=<store>` →
 *   { proposals: AiProposal[] }
 */
export interface AiProposal {
  product_id: number;
  product_name: string;
  unit: Unit;
  current_qty: number;
  min_level: number;
  max_level: number;
  suggested_qty: number;
}

interface ProposalsResponse {
  proposals: AiProposal[];
}

/**
 * The last proposals payload fetched per store, kept module-level so RE-opening
 * the dialog for a store already seen this session paints instantly from the
 * cache and revalidates silently — no skeleton flash. (Owner: rapidly toggling
 * the AI takliflari dialog read as "yoqilib-o'chib" because every open showed a
 * fresh spinner.) The dialog stays fully lazy: nothing is fetched until it is
 * actually opened. The cache is invalidated implicitly by a successful approve
 * (the parent refetches its lists; the next open revalidates here too).
 */
const proposalsCache = new Map<number, AiProposal[]>();

/**
 * `POST /api/replenishment/proposals/approve` result row — one per item the
 * boss approved. `created` means a fresh replenishment request was opened;
 * `exists` means an open request already covered this (product, location).
 */
interface ApproveResultRow {
  product_id: number;
  status: 'created' | 'exists';
}

interface ApproveResponse {
  results: ApproveResultRow[];
}

interface StoreAiProposalsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Store (location) the proposals are scoped to. */
  storeLocationId: number;
  /** Refetch the request list after a successful approve. */
  onApproved: () => void;
}

/**
 * Do'kon ish joyi — "AI takliflari" dialog.
 *
 * The boss (store_manager) reviews the AI's below-min replenishment
 * proposals, may tweak each suggested qty, then approves them all at once.
 * Approval opens one replenishment request per item (debounced server-side:
 * an item already covered by an open request comes back as `exists`).
 */
export function StoreAiProposalsDialog({
  open,
  onOpenChange,
  storeLocationId,
  onApproved,
}: StoreAiProposalsDialogProps) {
  const { notify } = useToast();
  const [proposals, setProposals] = useState<AiProposal[]>([]);
  const [qtyByProduct, setQtyByProduct] = useState<
    Record<number, number | null>
  >({});
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  /** Apply a freshly-loaded proposal set to state + seed the editable qtys. */
  const applyRows = useCallback((rows: AiProposal[]) => {
    setProposals(rows);
    const seed: Record<number, number | null> = {};
    for (const p of rows) seed[p.product_id] = p.suggested_qty;
    setQtyByProduct(seed);
  }, []);

  // Load proposals when the dialog opens. A cached set for this store (from an
  // earlier open this session) paints immediately with NO spinner, then we
  // revalidate silently in the background — so re-opening never flashes a
  // skeleton. A first-ever open shows the LoadingState as before.
  useEffect(() => {
    if (!open || storeLocationId <= 0) return;
    let cancelled = false;

    const cached = proposalsCache.get(storeLocationId);
    if (cached) {
      applyRows(cached);
      setLoadError(null);
      setIsLoading(false);
    } else {
      setIsLoading(true);
      setLoadError(null);
    }

    apiRequest<ProposalsResponse>(
      `/api/replenishment/proposals?location_id=${storeLocationId}`,
    )
      .then((res) => {
        if (cancelled) return;
        const rows = res.proposals ?? [];
        proposalsCache.set(storeLocationId, rows);
        applyRows(rows);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // A failed background revalidation over cached rows stays silent — keep
        // showing the cached proposals. Errors only surface on a cold open.
        if (cached) return;
        setLoadError(
          err instanceof ApiError
            ? err.message
            : 'AI takliflarini yuklab bo‘lmadi.',
        );
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, storeLocationId, applyRows]);

  // Items with a positive, finite qty are eligible for approval.
  const approvableItems = useMemo(() => {
    const items: { product_id: number; qty: number }[] = [];
    for (const p of proposals) {
      const qty = qtyByProduct[p.product_id] ?? NaN;
      if (Number.isFinite(qty) && qty > 0) {
        items.push({ product_id: p.product_id, qty });
      }
    }
    return items;
  }, [proposals, qtyByProduct]);

  async function handleApproveAll() {
    if (approvableItems.length === 0) return;
    setIsSubmitting(true);
    try {
      const res = await apiRequest<ApproveResponse>(
        '/api/replenishment/proposals/approve',
        {
          method: 'POST',
          body: { location_id: storeLocationId, items: approvableItems },
        },
      );
      const results = res.results ?? [];
      const created = results.filter((r) => r.status === 'created').length;
      const exists = results.filter((r) => r.status === 'exists').length;
      const parts: string[] = [];
      if (created > 0) parts.push(`${created} ta so‘rov yaratildi`);
      if (exists > 0) parts.push(`${exists} ta allaqachon ochiq`);
      notify(
        'success',
        parts.length > 0 ? parts.join(', ') + '.' : 'Takliflar tasdiqlandi.',
      );
      // Approved items are now covered by open requests — drop the cached set so
      // the next open re-fetches a fresh (smaller) proposal list, not stale rows.
      proposalsCache.delete(storeLocationId);
      onOpenChange(false);
      onApproved();
    } catch (err: unknown) {
      notify(
        'error',
        err instanceof ApiError
          ? err.message
          : 'Takliflarni tasdiqlab bo‘lmadi.',
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" aria-hidden="true" />
            AI takliflari
          </DialogTitle>
          <DialogDescription>
            Min’dan past mahsulotlar uchun AI to‘ldirish takliflari. Sonini
            o‘zgartirib, hammasini bir marta tasdiqlashingiz mumkin.
          </DialogDescription>
        </DialogHeader>

        {isLoading && <LoadingState />}
        {!isLoading && loadError && (
          <ErrorState
            message={loadError}
            onRetry={() => {
              setLoadError(null);
              setIsLoading(true);
              apiRequest<ProposalsResponse>(
                `/api/replenishment/proposals?location_id=${storeLocationId}`,
              )
                .then((res) => {
                  const rows = res.proposals ?? [];
                  proposalsCache.set(storeLocationId, rows);
                  applyRows(rows);
                })
                .catch((err: unknown) =>
                  setLoadError(
                    err instanceof ApiError
                      ? err.message
                      : 'AI takliflarini yuklab bo‘lmadi.',
                  ),
                )
                .finally(() => setIsLoading(false));
            }}
          />
        )}
        {!isLoading && !loadError && proposals.length === 0 && (
          <EmptyState message="Hozircha AI taklifi yo‘q — barcha mahsulot me’yorda." />
        )}
        {!isLoading && !loadError && proposals.length > 0 && (
          <div className="scrollbar-thin max-h-[50vh] overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Mahsulot</TableHead>
                  <TableHead className="text-right">Qoldiq</TableHead>
                  <TableHead className="text-right">Min</TableHead>
                  <TableHead className="text-right">Taklif qilingan soni</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {proposals.map((p) => (
                  <TableRow key={p.product_id}>
                    <TableCell className="font-medium">{p.product_name}</TableCell>
                    <TableCell className="text-right tabular-nums text-destructive">
                      {formatQtyUnit(p.current_qty, p.unit)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {formatQtyUnit(p.min_level, p.unit)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <NumberInput
                          decimals
                          min={0}
                          aria-label={`${p.product_name} uchun taklif qilingan soni`}
                          className="w-24 text-right tabular-nums"
                          value={qtyByProduct[p.product_id] ?? null}
                          onValueChange={(n) =>
                            setQtyByProduct((prev) => ({
                              ...prev,
                              [p.product_id]: n,
                            }))
                          }
                          disabled={isSubmitting}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            Bekor qilish
          </Button>
          <Button
            type="button"
            onClick={handleApproveAll}
            disabled={isSubmitting || approvableItems.length === 0}
          >
            {isSubmitting && (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            )}
            Hammasini tasdiqlash
            {approvableItems.length > 0 ? ` (${approvableItems.length})` : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
